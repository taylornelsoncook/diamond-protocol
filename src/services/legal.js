import { newId, v, notFound, conflict, badRequest, HttpError } from '../util.js';
import { getSetting, getFamily } from './families.js';
import { emit } from './events.js';
import { sendEmail } from './mail.js';

// ---------- Terms and privacy ----------
export const published = (ctx, kind) => !getSetting(ctx, `${kind}_text`).trim().startsWith('[');
export function legalDocs(ctx) {
  const doc = (kind) => ({ text: getSetting(ctx, `${kind}_text`), version: Number(getSetting(ctx, `${kind}_version`)), updated: getSetting(ctx, `${kind}_updated`) || null, published: published(ctx, kind) });
  return { business_name: getSetting(ctx, 'business_name'), business_address: getSetting(ctx, 'business_address'), terms: doc('terms'), privacy: doc('privacy') };
}
// What this parent still needs to accept (only published documents count).
export function consentStatus(ctx, guardianId) {
  const needs = [];
  for (const kind of ['terms', 'privacy']) {
    if (!published(ctx, kind)) continue;
    const version = Number(getSetting(ctx, `${kind}_version`));
    if (!ctx.db.get('SELECT 1 FROM consents WHERE guardian_id = ? AND kind = ? AND version = ?', guardianId, kind, version)) needs.push(kind);
  }
  return { needs, ok: needs.length === 0 };
}
export function recordConsent(ctx, guardian, { ip } = {}) {
  const out = [];
  for (const kind of ['terms', 'privacy']) {
    const version = Number(getSetting(ctx, `${kind}_version`));
    if (ctx.db.get('SELECT 1 FROM consents WHERE guardian_id = ? AND kind = ? AND version = ?', guardian.id, kind, version)) continue;
    ctx.db.run('INSERT INTO consents (id, guardian_id, family_id, kind, version, accepted_by, ip, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId('cst'), guardian.id, guardian.family_id, kind, version, `${guardian.name} <${guardian.email}>`, ip ?? null, ctx.now());
    out.push({ kind, version });
  }
  return { accepted: out, ...consentStatus(ctx, guardian.id) };
}
export function requireAgreements(ctx, guardian) {
  const s = consentStatus(ctx, guardian.id);
  if (!s.ok) throw new HttpError(409, 'agreements_required', `Please accept the updated ${s.needs.map((k) => (k === 'terms' ? 'terms of service' : 'privacy policy')).join(' and ')} on the Family tab first.`);
}
export function familyConsents(ctx, familyId) {
  return ctx.db.all('SELECT kind, version, accepted_by, accepted_at FROM consents WHERE family_id = ? ORDER BY accepted_at DESC', familyId);
}

// ---------- A family's data, as a download ----------
export function exportFamily(ctx, familyId) {
  const f = ctx.db.get('SELECT id, name, created_at, card_brand, card_last4, waiver_version, waiver_signed_by, waiver_signed_at FROM families WHERE id = ?', familyId);
  if (!f) throw notFound('Family');
  const kids = ctx.db.all(`SELECT id, athlete_id, name, email, phone, birth_date, sex, sport, position, school, grad_year, medical_notes, emergency_name, emergency_phone, created_at FROM clients WHERE family_id = ?`, familyId);
  const per = (sql, id) => ctx.db.all(sql, id);
  return {
    exported_at: ctx.now(), business: getSetting(ctx, 'business_name'),
    family: { ...f, card: f.card_last4 ? `${f.card_brand} ending ${f.card_last4}` : null, card_brand: undefined, card_last4: undefined },
    parents: ctx.db.all('SELECT name, email, phone, relationship, created_at FROM guardians WHERE family_id = ?', familyId),
    agreements: familyConsents(ctx, familyId),
    athletes: kids.map((k) => ({
      ...k,
      bookings: per(`SELECT s.name AS session, s.starts_at, b.status, b.coverage FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? ORDER BY s.starts_at`, k.id),
      memberships: per(`SELECT p.name AS plan, s.status, s.created_at, s.current_period_end FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.client_id = ?`, k.id),
      invoices: per(`SELECT amount_cents, status, period_start, period_end, created_at FROM invoices WHERE client_id = ? ORDER BY created_at`, k.id),
      purchases: per(`SELECT (SELECT GROUP_CONCAT(i.name, ', ') FROM sale_items i WHERE i.sale_id = s.id) AS items, s.amount_cents, s.method, s.status, s.created_at FROM sales s WHERE s.client_id = ? ORDER BY s.created_at`, k.id),
      test_results: per(`SELECT t.name AS test, r.metric, r.side, r.attempt, r.value, m.unit, r.timing, r.recorded_at FROM perf_results r JOIN perf_tests t ON t.id = r.test_id JOIN perf_metrics m ON m.test_id = r.test_id AND m.key = r.metric WHERE r.client_id = ? AND r.voided = 0 ORDER BY r.recorded_at`, k.id),
      workouts: per(`SELECT w.title AS workout, l.completed_at, l.notes FROM workout_logs l JOIN workouts w ON w.id = l.workout_id WHERE l.client_id = ? ORDER BY l.completed_at`, k.id)
    }))
  };
}

// ---------- Deletion requests ----------
export async function requestDeletion(ctx, guardian, body = {}) {
  const fam = getFamily(ctx, guardian.family_id);
  if (ctx.db.get(`SELECT 1 FROM data_requests WHERE family_id = ? AND kind = 'delete' AND status = 'open'`, fam.id)) throw conflict('Your deletion request is already with us. We\'ll email you when it\'s done.');
  const id = newId('dr');
  ctx.db.run(`INSERT INTO data_requests (id, family_id, family_name, requested_by, kind, status, note, created_at) VALUES (?, ?, ?, ?, 'delete', 'open', ?, ?)`,
    id, fam.id, fam.name, `${guardian.name} <${guardian.email}>`, v.str(body.note, 'note', { max: 1000, optional: true }), ctx.now());
  emit(ctx, 'family.deletion_requested', { request_id: id, family_id: fam.id, family_name: fam.name, requested_by: guardian.name });
  for (const o of ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`)) {
    sendEmail(ctx, { to: o.email, subject: `Deletion request: ${fam.name}`, text: `${guardian.name} (${guardian.email}) asked for the ${fam.name}'s data to be deleted.\n\nReview it under Staff & security → Data requests.` }).catch(() => {});
  }
  await sendEmail(ctx, { to: guardian.email, subject: 'We received your deletion request', text: `We received your request to delete the ${fam.name}'s account and data. We'll email you when it's done.\n\n${getSetting(ctx, 'business_name')}` });
  return listDataRequests(ctx).find((r) => r.id === id);
}
export function listDataRequests(ctx, { status } = {}) {
  return ctx.db.all(`SELECT * FROM data_requests ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 200`, ...(status ? [status] : []));
}

// Deletes a family's personal information. Money records stay for accounting, with no names attached.
export async function deleteFamilyData(ctx, familyId, { confirm, requestId, actor } = {}) {
  const fam = getFamily(ctx, familyId);
  if (String(confirm ?? '').trim().toLowerCase() !== fam.name.toLowerCase()) throw badRequest(`Type the family name exactly (${fam.name}) to confirm.`);
  const parents = fam.guardians.map((g) => g.email);
  const kids = ctx.db.all('SELECT id FROM clients WHERE family_id = ?', familyId).map((k) => k.id);
  ctx.db.tx(() => {
    for (const id of kids) {
      ctx.db.run(`UPDATE subscriptions SET status = 'canceled', canceled_at = COALESCE(canceled_at, ?) WHERE client_id = ? AND status != 'canceled'`, ctx.now(), id);
      ctx.db.run(`DELETE FROM perf_results WHERE client_id = ?`, id);
      ctx.db.run(`DELETE FROM athlete_links WHERE client_id = ?`, id);
      ctx.db.run(`DELETE FROM workout_logs WHERE client_id = ?`, id);
      ctx.db.run(`DELETE FROM bookings WHERE client_id = ? AND status IN ('booked','waitlisted')`, id);
      ctx.db.run(`DELETE FROM enrollments WHERE client_id = ?`, id);
      ctx.db.run(`UPDATE clients SET name = 'Deleted athlete', athlete_id = NULL, email = NULL, phone = NULL, notes = NULL, birth_date = NULL, sex = NULL, sport = NULL, position = NULL, school = NULL, grad_year = NULL,
        medical_notes = NULL, emergency_name = NULL, emergency_phone = NULL, card_payment_method = NULL, card_brand = NULL, card_last4 = NULL, stripe_customer_id = NULL, access_token = ? WHERE id = ?`, newId('gone'), id);
    }
    ctx.db.run('DELETE FROM guardians WHERE family_id = ?', familyId);
    ctx.db.run(`UPDATE families SET name = 'Deleted family', card_payment_method = NULL, card_brand = NULL, card_last4 = NULL, stripe_customer_id = NULL, waiver_signed_by = NULL WHERE id = ?`, familyId);
    const note = `Deleted by ${actor?.name ?? 'an owner'} on ${ctx.now().slice(0, 10)}`;
    if (requestId) ctx.db.run(`UPDATE data_requests SET status = 'done', resolution = ?, resolved_at = ?, family_name = ? WHERE id = ?`, note, ctx.now(), fam.name, requestId);
    else ctx.db.run(`INSERT INTO data_requests (id, family_id, family_name, requested_by, kind, status, resolution, created_at, resolved_at) VALUES (?, ?, ?, ?, 'delete', 'done', ?, ?, ?)`,
      newId('dr'), familyId, fam.name, actor?.name ?? 'owner', note, ctx.now(), ctx.now());
    ctx.db.run(`UPDATE data_requests SET family_name = ? WHERE family_id = ?`, fam.name, familyId);
  });
  for (const email of parents) sendEmail(ctx, { to: email, subject: 'Your account has been deleted', text: `As requested, the ${fam.name}'s account and personal information have been deleted. Payment records we're required to keep no longer include your names.\n\n${getSetting(ctx, 'business_name')}` }).catch(() => {});
  emit(ctx, 'family.deleted', { family_id: familyId, athletes: kids.length });
  return { deleted: true, athletes: kids.length, parents: parents.length };
}
export function declineRequest(ctx, id, body = {}) {
  const r = ctx.db.get('SELECT * FROM data_requests WHERE id = ?', id);
  if (!r) throw notFound('Request');
  if (r.status !== 'open') throw conflict('This request is already closed.');
  ctx.db.run(`UPDATE data_requests SET status = 'declined', resolution = ?, resolved_at = ? WHERE id = ?`, v.str(body.reason, 'reason', { max: 1000 }), ctx.now(), id);
  return listDataRequests(ctx).find((x) => x.id === id);
}
