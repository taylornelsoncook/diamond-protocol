import { newId, token, v, notFound, conflict, badRequest, HttpError } from '../util.js';
import { emit } from './events.js';
import * as billing from './billing.js';
import * as programs from './programs.js';
import { createFamilyWithGuardian, athleteFields, payerFor, getFamily } from './families.js';
import { newAthleteId, validateAthleteId } from './athlete-ids.js';
import { welcomeFamily, welcomeClient } from './notify.js';
import { clientBookings, endEnrollment, cancelBooking } from './schedule.js';

const LIST_SQL = `
  SELECT c.id, c.athlete_id, c.name, c.email, c.phone, c.created_at, c.archived_at, c.archived_by, c.family_id, f.name AS family_name, c.birth_date, c.sport,
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
  has_card: !!r.has_card,
  archived_at: r.archived_at ?? null, archived_by: r.archived_by ?? null
});

// "Active client" means one thing everywhere (the Today metric, the client list's Active filter, the owner summary):
// not archived, with a membership that is paid up or on a free trial.
export const ACTIVE_STATUSES = ['active', 'trialing'];
export const isActiveClient = (c) => !c.archived_at && ACTIVE_STATUSES.includes(c.status);
const matches = (c, q) => { const s = q.toLowerCase(); return c.name.toLowerCase().includes(s) || (c.email ?? '').includes(s) || (c.athlete_id ?? '').toLowerCase().includes(s) || (c.family?.name ?? '').toLowerCase().includes(s); };

// Archived clients are left out unless asked for: archived=true lists only them, archived=all everyone.
// status=current is the active clients above; any other status is the membership status (none = no membership).
export function listClients(ctx, { q, status, archived } = {}) {
  let rows = ctx.db.all(`${LIST_SQL} ORDER BY c.name COLLATE NOCASE`).map(shape);
  if (q) rows = rows.filter((c) => matches(c, q));
  if (archived === 'true') rows = rows.filter((c) => c.archived_at);
  else if (archived !== 'all') rows = rows.filter((c) => !c.archived_at);
  if (status === 'current') rows = rows.filter(isActiveClient);
  else if (status) rows = rows.filter((c) => c.status === status);
  return rows;
}
// How many archived clients a search would have found, so the list can say where to look.
export const archivedMatches = (ctx, q) => ctx.db.all(`${LIST_SQL} WHERE c.archived_at IS NOT NULL`).map(shape).filter((c) => !q || matches(c, q)).length;
export function clientCounts(ctx) {
  const out = { current: 0, active: 0, trialing: 0, past_due: 0, paused: 0, canceled: 0, none: 0, archived: 0, total: 0 };
  for (const c of ctx.db.all(LIST_SQL).map(shape)) {
    if (c.archived_at) { out.archived++; continue; }
    out.total++;
    out[c.status] = (out[c.status] ?? 0) + 1;
    if (isActiveClient(c)) out.current++;
  }
  return out;
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

// ---------- Archive: clients who stopped training ----------
// Hidden from lists, search, pickers and automatic messages; everything about them stays. A client with a membership
// can't be archived (cancel it first). Upcoming bookings and standing spots are canceled, but only once confirmed.
export async function archiveClient(ctx, id, body = {}, actor) {
  const c = getClient(ctx, id);
  const first = c.name.split(' ')[0];
  if (c.archived_at) throw conflict(`${first} is already archived.`);
  const sub = ctx.db.get(`SELECT status FROM subscriptions WHERE client_id = ? AND status != 'canceled' ORDER BY created_at DESC LIMIT 1`, id);
  if (sub) throw conflict(`${first} has a membership (${sub.status.replace('_', ' ')}). Cancel it first, then archive.`);
  const upcoming = clientBookings(ctx, id, { upcoming: true, limit: 500 });
  // Every open enrollment is ended; only ones with days still to come are worth asking about (a camp from last summer isn't).
  const enrolled = ctx.db.all(`SELECT e.series_id, e.kind, e.sale_id, s.name,
      EXISTS (SELECT 1 FROM class_sessions x WHERE x.series_id = s.id AND x.status = 'scheduled' AND x.starts_at > ?) AS upcoming
    FROM enrollments e JOIN class_series s ON s.id = e.series_id WHERE e.client_id = ? AND e.status = 'active'`, ctx.now(), id);
  const standing = enrolled.filter((x) => x.upcoming && x.kind !== 'registration'), camps = enrolled.filter((x) => x.upcoming && x.kind === 'registration');
  if ((upcoming.length || standing.length || camps.length) && body.confirm !== true) {
    const names = (xs) => xs.map((x) => x.name).join(', ');
    const parts = [upcoming.length ? `${upcoming.length} upcoming ${upcoming.length === 1 ? 'booking' : 'bookings'}` : null, standing.length ? `a standing spot in ${names(standing)}` : null, camps.length ? `a registration for ${names(camps)}` : null].filter(Boolean);
    const paidCamps = camps.filter((x) => x.sale_id);
    const e = new HttpError(409, 'confirm_required', `${first} has ${parts.join(' and ')}. Archiving cancels ${upcoming.length + standing.length + camps.length === 1 ? 'it' : 'them'} (credits go back, paid single sessions are refunded).${paidCamps.length ? ` The ${names(paidCamps)} registration fee isn't refunded automatically: the owner can refund it from the sale.` : ''}`);
    e.details = { bookings: upcoming.map((b) => ({ id: b.id, session_name: b.session_name, starts_at: b.starts_at, status: b.status })), standing: standing.map((x) => x.name), registrations: camps.map((x) => x.name) };
    throw e;
  }
  // Cancel, mark archived, then sweep once more: a booking a parent finished while refunds were going through is caught
  // here, and one that finishes after archived_at is set undoes itself (schedule.js#bookNow).
  const cancelAll = async () => {
    for (const e of ctx.db.all(`SELECT series_id FROM enrollments WHERE client_id = ? AND status = 'active'`, id)) await endEnrollment(ctx, e.series_id, id);
    for (const b of clientBookings(ctx, id, { upcoming: true, limit: 500 })) await cancelBooking(ctx, b.id, { isCoach: true, waive: true });
  };
  await cancelAll();
  ctx.db.run('UPDATE clients SET archived_at = ?, archived_by = ? WHERE id = ?', ctx.now(), actor?.name ?? 'API', id);
  await cancelAll();
  emit(ctx, 'client.archived', { client_id: id, client_name: c.name, bookings_canceled: upcoming.length, by: actor?.name ?? null });
  return getClient(ctx, id, { withSecrets: true });
}
export function restoreClient(ctx, id, actor) {
  const c = getClient(ctx, id);
  if (!c.archived_at) throw conflict(`${c.name.split(' ')[0]} isn't archived.`);
  ctx.db.run('UPDATE clients SET archived_at = NULL, archived_by = NULL WHERE id = ?', id);
  emit(ctx, 'client.restored', { client_id: id, client_name: c.name, by: actor?.name ?? null });
  return getClient(ctx, id, { withSecrets: true });
}

// ---------- Staff notes ----------
// Everyone on staff can add notes and change or delete their own; owners can delete any note and pin or unpin any.
// Coach-only notes are never shown to front desk, and front desk can't write them.
const staffActor = (actor) => actor ?? { id: null, name: 'API', role: 'owner' };
const shapeNote = (n) => ({ ...n, pinned: !!n.pinned, coach_only: !!n.coach_only });
export function listNotes(ctx, clientId, actor) {
  getClient(ctx, clientId);
  const hideCoachOnly = staffActor(actor).role === 'front_desk';
  return ctx.db.all(`SELECT * FROM client_notes WHERE client_id = ? ${hideCoachOnly ? 'AND coach_only = 0' : ''} ORDER BY pinned DESC, created_at DESC`, clientId).map(shapeNote);
}
function noteFor(ctx, id, actor) {
  const n = ctx.db.get('SELECT * FROM client_notes WHERE id = ?', id);
  if (!n || (n.coach_only && staffActor(actor).role === 'front_desk')) throw notFound('Note');
  return n;
}
const flag = (x, field) => { if (typeof x !== 'boolean') throw badRequest(`${field} must be true or false.`); return x; };
export function addNote(ctx, clientId, body, actor) {
  const a = staffActor(actor);
  getClient(ctx, clientId);
  const coachOnly = body.coach_only === undefined ? false : flag(body.coach_only, 'coach_only');
  if (coachOnly && a.role === 'front_desk') throw new HttpError(403, 'forbidden', 'Front desk can\'t write coach-only notes.');
  const id = newId('note');
  ctx.db.run('INSERT INTO client_notes (id, client_id, author_id, author_name, body, pinned, coach_only, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, clientId, a.id, a.name, v.str(body.body, 'body', { max: 4000 }), body.pinned === undefined ? false : flag(body.pinned, 'pinned'), coachOnly, ctx.now());
  return shapeNote(ctx.db.get('SELECT * FROM client_notes WHERE id = ?', id));
}
export function updateNote(ctx, id, body, actor) {
  const a = staffActor(actor), n = noteFor(ctx, id, actor);
  const mine = a.id != null ? n.author_id === a.id : a.role === 'owner' && n.author_id == null;
  const changes = Object.keys(body).filter((k) => ['body', 'pinned', 'coach_only'].includes(k));
  if (!changes.length) throw badRequest('Send body, pinned or coach_only.');
  if (!mine && !(a.role === 'owner' && changes.every((k) => k === 'pinned'))) throw new HttpError(403, 'forbidden', 'You can only change your own notes.');
  const coachOnly = body.coach_only === undefined ? !!n.coach_only : flag(body.coach_only, 'coach_only');
  if (coachOnly && a.role === 'front_desk') throw new HttpError(403, 'forbidden', 'Front desk can\'t write coach-only notes.');
  ctx.db.run('UPDATE client_notes SET body = ?, pinned = ?, coach_only = ?, updated_at = ? WHERE id = ?',
    body.body === undefined ? n.body : v.str(body.body, 'body', { max: 4000 }), body.pinned === undefined ? n.pinned : flag(body.pinned, 'pinned'), coachOnly, ctx.now(), id);
  return shapeNote(ctx.db.get('SELECT * FROM client_notes WHERE id = ?', id));
}
export function deleteNote(ctx, id, actor) {
  const a = staffActor(actor), n = noteFor(ctx, id, actor);
  if (a.role !== 'owner' && n.author_id !== a.id) throw new HttpError(403, 'forbidden', 'You can only delete your own notes. Ask the owner.');
  ctx.db.run('DELETE FROM client_notes WHERE id = ?', id);
  return { id, deleted: true };
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
