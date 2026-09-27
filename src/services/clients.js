import { newId, token, v, notFound, conflict } from '../util.js';
import { emit } from './events.js';
import * as billing from './billing.js';
import * as programs from './programs.js';
import { createFamilyWithGuardian, athleteFields, payerFor, getFamily } from './families.js';
import { newAthleteId, validateAthleteId } from './athlete-ids.js';
import { welcomeFamily, welcomeClient } from './notify.js';

const LIST_SQL = `
  SELECT c.id, c.athlete_id, c.name, c.email, c.phone, c.created_at, c.family_id, f.name AS family_name, c.birth_date, c.sport,
    s.id AS subscription_id, s.status AS subscription_status, s.current_period_end, s.trial_ends_at,
    p.id AS plan_id, p.name AS plan_name, p.price_cents,
    a.program_id, pr.name AS program_name,
    (SELECT MAX(completed_at) FROM workout_logs l WHERE l.client_id = c.id) AS last_workout_at,
    (SELECT COALESCE(SUM(delta), 0) FROM session_credits k WHERE k.client_id = c.id AND k.credit_type = 'private') AS private_credits,
    (SELECT COALESCE(SUM(delta), 0) FROM session_credits k WHERE k.client_id = c.id AND k.credit_type = 'group') AS group_credits,
    COALESCE(f.card_payment_method, c.card_payment_method) IS NOT NULL AS has_card
  FROM clients c
  LEFT JOIN subscriptions s ON s.id = (SELECT id FROM subscriptions WHERE client_id = c.id ORDER BY (status = 'canceled'), created_at DESC LIMIT 1)
  LEFT JOIN plans p ON p.id = s.plan_id
  LEFT JOIN assignments a ON a.client_id = c.id AND a.active = 1
  LEFT JOIN programs pr ON pr.id = a.program_id
  LEFT JOIN families f ON f.id = c.family_id`;

const shape = (r) => ({
  id: r.id, athlete_id: r.athlete_id, name: r.name, email: r.email ?? null, phone: r.phone ?? null, created_at: r.created_at,
  family: r.family_id ? { id: r.family_id, name: r.family_name } : null,
  birth_date: r.birth_date ?? null, sport: r.sport ?? null,
  status: r.subscription_status ?? 'none',
  subscription: r.subscription_id ? {
    id: r.subscription_id, status: r.subscription_status, plan_id: r.plan_id, plan_name: r.plan_name,
    price_cents: r.price_cents, current_period_end: r.current_period_end, trial_ends_at: r.trial_ends_at
  } : null,
  program: r.program_id ? { id: r.program_id, name: r.program_name } : null,
  last_workout_at: r.last_workout_at ?? null,
  credits: { private: r.private_credits ?? 0, group: r.group_credits ?? 0 },
  session_credits: (r.private_credits ?? 0) + (r.group_credits ?? 0),
  has_card: !!r.has_card
});

export function listClients(ctx, { q, status } = {}) {
  let rows = ctx.db.all(`${LIST_SQL} ORDER BY c.name COLLATE NOCASE`).map(shape);
  if (q) { const s = q.toLowerCase(); rows = rows.filter((c) => c.name.toLowerCase().includes(s) || (c.email ?? '').includes(s) || (c.athlete_id ?? '').toLowerCase().includes(s) || (c.family?.name ?? '').toLowerCase().includes(s)); }
  if (status) rows = rows.filter((c) => c.status === status);
  return rows;
}

export function getClient(ctx, id, { withSecrets = false } = {}) {
  const r = ctx.db.get(`${LIST_SQL} WHERE c.id = ?`, id);
  if (!r) throw notFound('Client');
  const c = shape(r);
  const extra = ctx.db.get('SELECT * FROM clients WHERE id = ?', id);
  const payer = payerFor(ctx, id);
  c.notes = extra.notes ?? null;
  c.card_status = payer.card_status;
  c.card = payer.card_payment_method ? { on_file: true, brand: payer.card_brand, last4: payer.card_last4, owner: payer.table === 'families' ? 'family' : 'client' } : { on_file: false, owner: payer.table === 'families' ? 'family' : 'client' };
  Object.assign(c, athleteFields({}, extra));
  if (c.family) {
    const fam = getFamily(ctx, c.family.id);
    c.family = { id: fam.id, name: fam.name, guardians: fam.guardians, waiver: fam.waiver,
      siblings: ctx.db.all('SELECT id, name FROM clients WHERE family_id = ? AND id != ? ORDER BY name', fam.id, id) };
  }
  c.workouts_completed = ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE client_id = ?', id).n;
  if (withSecrets) c.app_link = `/app?token=${extra.access_token}`;
  return c;
}

// Create the account, start the subscription (trial first if the plan has one) and assign a program.
export async function createClient(ctx, body) {
  const name = v.str(body.name, 'name', { max: 120 });
  const hasParent = !!(body.family_id || body.parent);
  // Athletes with a parent account don't need their own email; adults paying for themselves do.
  const email = hasParent ? (body.email ? v.email(body.email) : null) : v.email(body.email);
  const phone = v.str(body.phone, 'phone', { max: 40, optional: true });
  const notes = v.str(body.notes, 'notes', { max: 2000, optional: true });
  const profile = athleteFields(body);
  if (body.plan_id) billing.getPlan(ctx, body.plan_id);
  if (body.program_id) programs.getProgram(ctx, body.program_id);
  if (body.family_id) getFamily(ctx, body.family_id);
  if (email && ctx.db.get('SELECT id FROM clients WHERE email = ?', email)) throw conflict('A client with this email already exists.');

  const id = newId('cli');
  let newFamily = null;
  ctx.db.tx(() => {
    const familyId = body.family_id ?? (body.parent ? (newFamily = createFamilyWithGuardian(ctx, body.parent, body.family_name)) : null);
    ctx.db.run(`INSERT INTO clients (id, athlete_id, name, email, phone, notes, access_token, family_id, birth_date, sex, sport, position, school, grad_year, medical_notes, emergency_name, emergency_phone, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, newAthleteId(ctx, name), name, email, phone, notes, token(24), familyId, profile.birth_date, profile.sex, profile.sport, profile.position, profile.school, profile.grad_year, profile.medical_notes, profile.emergency_name, profile.emergency_phone, ctx.now());
    emit(ctx, 'client.created', { client_id: id, athlete_id: ctx.db.get('SELECT athlete_id FROM clients WHERE id = ?', id).athlete_id, client_name: name, email, family_id: familyId });
    if (body.program_id) programs.assign(ctx, body.program_id, id);
  });
  if (body.plan_id) await billing.subscribe(ctx, id, body.plan_id);
  // Welcome email: to the parents of a new family, or to an adult paying for themselves. Siblings don't trigger another.
  if (body.send_welcome !== false) {
    if (newFamily) await welcomeFamily(ctx, newFamily);
    else if (!body.family_id) await welcomeClient(ctx, id);
  }
  return getClient(ctx, id, { withSecrets: true });
}

export function updateClient(ctx, id, body) {
  const c = getClient(ctx, id);
  const name = body.name !== undefined ? v.str(body.name, 'name', { max: 120 }) : c.name;
  const email = body.email !== undefined ? (body.email === null || body.email === '' ? (c.family ? null : v.email(body.email)) : v.email(body.email)) : c.email;
  const phone = body.phone !== undefined ? v.str(body.phone, 'phone', { max: 40, optional: true }) : c.phone;
  const notes = body.notes !== undefined ? v.str(body.notes, 'notes', { max: 2000, optional: true }) : c.notes;
  const profile = athleteFields(body, c);
  if (body.card_status !== undefined) {
    if (!ctx.testMode) throw conflict('card_status can only be changed in test mode.');
    const payer = payerFor(ctx, id);
    ctx.db.run(`UPDATE ${payer.table} SET card_status = ? WHERE id = ?`, v.oneOf(body.card_status, 'card_status', ['ok', 'declining']), payer.id);
  }
  if (email && email !== c.email && ctx.db.get('SELECT id FROM clients WHERE email = ? AND id != ?', email, id)) throw conflict('A client with this email already exists.');
  if (body.athlete_id !== undefined && String(body.athlete_id).toUpperCase() !== c.athlete_id) ctx.db.run('UPDATE clients SET athlete_id = ? WHERE id = ?', validateAthleteId(ctx, body.athlete_id, { exceptClient: id }), id);
  ctx.db.run(`UPDATE clients SET name = ?, email = ?, phone = ?, notes = ?, birth_date = ?, sex = ?, sport = ?, position = ?, school = ?, grad_year = ?, medical_notes = ?, emergency_name = ?, emergency_phone = ? WHERE id = ?`,
    name, email, phone, notes, profile.birth_date, profile.sex, profile.sport, profile.position, profile.school, profile.grad_year, profile.medical_notes, profile.emergency_name, profile.emergency_phone, id);
  emit(ctx, 'client.updated', { client_id: id, client_name: name, email });
  return getClient(ctx, id, { withSecrets: true });
}

// Issue a new private app link; the old one stops working.
export function resetAppLink(ctx, id) {
  getClient(ctx, id);
  ctx.db.run('UPDATE clients SET access_token = ? WHERE id = ?', token(24), id);
  return getClient(ctx, id, { withSecrets: true });
}

export const clientByToken = (ctx, t) => (t ? ctx.db.get('SELECT * FROM clients WHERE access_token = ?', String(t)) : undefined);
