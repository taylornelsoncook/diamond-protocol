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
  const kids = ctx.db.all(`SELECT id, athlete_id, name, email, phone, birth_date, sex, sport, position, school, grad_year, medical_notes, emergency_name, emergency_phone, created_at, archived_at FROM clients WHERE family_id = ?`, familyId);
  const per = (sql, id) => ctx.db.all(sql, id);
  return {
    exported_at: ctx.now(), business: getSetting(ctx, 'business_name'),
    family: { ...f, card: f.card_last4 ? `${f.card_brand} ending ${f.card_last4}` : null, card_brand: undefined, card_last4: undefined },
    parents: ctx.db.all('SELECT name, email, phone, relationship, sms_opt_in_at AS texts_turned_on_at, sms_opt_out_at AS texts_stopped_at, created_at FROM guardians WHERE family_id = ?', familyId),
    parent_lessons_read: ctx.db.all('SELECT g.name AS parent, l.title AS lesson, p.completed_at FROM guardian_lesson_progress p JOIN guardians g ON g.id = p.guardian_id JOIN lessons l ON l.id = p.lesson_id WHERE g.family_id = ? ORDER BY p.completed_at', familyId),
    texts: ctx.db.all('SELECT direction, phone, body, status, created_at FROM texts WHERE family_id = ? ORDER BY created_at', familyId),
    pay_links: ctx.db.all(`SELECT description, amount_cents, status, sent_to, sent_at, paid_at, created_at FROM pay_links WHERE client_id IN (SELECT id FROM clients WHERE family_id = ?) ORDER BY created_at`, familyId),
    announcement_emails: ctx.db.all('SELECT c.subject, r.email, r.sent_at, r.clicked_at, r.unsubscribed_at FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE r.family_id = ? ORDER BY r.sent_at', familyId),
    review_requests: ctx.db.all('SELECT reason, detail, sent_to, sent_at, clicked_at, opted_out_at FROM review_requests WHERE family_id = ? ORDER BY sent_at', familyId),
    inquiries: ctx.db.all(`SELECT parent_name, email, phone, athlete_name, athlete_age, sport, message, source, status, created_at FROM leads WHERE family_id = ? OR email IN (SELECT email FROM guardians WHERE family_id = ?)`, familyId, familyId),
    agreements: familyConsents(ctx, familyId),
    athletes: kids.map((k) => ({
      ...k,
      bookings: per(`SELECT s.name AS session, s.starts_at, b.status, b.coverage FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? ORDER BY s.starts_at`, k.id),
      memberships: per(`SELECT p.name AS plan, s.status, s.created_at, s.current_period_end FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.client_id = ?`, k.id),
      invoices: per(`SELECT amount_cents, status, period_start, period_end, created_at FROM invoices WHERE client_id = ? ORDER BY created_at`, k.id),
      purchases: per(`SELECT (SELECT GROUP_CONCAT(i.name, ', ') FROM sale_items i WHERE i.sale_id = s.id) AS items, s.amount_cents, s.method, s.status, s.created_at FROM sales s WHERE s.client_id = ? ORDER BY s.created_at`, k.id),
      test_results: per(`SELECT t.name AS test, r.metric, r.side, r.attempt, r.value, m.unit, r.timing, r.recorded_at FROM perf_results r JOIN perf_tests t ON t.id = r.test_id JOIN perf_metrics m ON m.test_id = r.test_id AND m.key = r.metric WHERE r.client_id = ? AND r.voided = 0 ORDER BY r.recorded_at`, k.id),
      workouts: per(`SELECT w.title AS workout, l.completed_at, l.notes FROM workout_logs l JOIN workouts w ON w.id = l.workout_id WHERE l.client_id = ? ORDER BY l.completed_at`, k.id),
      daily_check_ins: per(`SELECT date, sleep_hours, hydration, soreness, energy, mood, note FROM daily_checkins WHERE client_id = ? ORDER BY date`, k.id),
      lessons_completed: per(`SELECT l.title AS lesson, p.completed_at FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id WHERE p.client_id = ? ORDER BY p.completed_at`, k.id),
      quizzes: per(`SELECT l.title AS lesson, q.score, q.total, q.passed, q.created_at FROM quiz_attempts q JOIN lessons l ON l.id = q.lesson_id WHERE q.client_id = ? ORDER BY q.created_at`, k.id),
      certificates: per(`SELECT c.title AS course, x.issued_at FROM course_certificates x JOIN courses c ON c.id = x.course_id WHERE x.client_id = ? ORDER BY x.issued_at`, k.id),
      progress_notes: per(`SELECT s.name AS testing_day, s.date, n.body AS note, n.approved_at FROM progress_notes n JOIN perf_sessions s ON s.id = n.perf_session_id WHERE n.client_id = ? AND n.approved_at IS NOT NULL ORDER BY s.date`, k.id),
      bought_online: per(`SELECT item_kind AS kind, title, amount_cents, status, created_at, refunded_at FROM purchases WHERE client_id = ? ORDER BY created_at`, k.id),
      skill_badges: per(`SELECT b.name AS badge, a.note, a.awarded_by, a.awarded_at FROM badge_awards a JOIN skill_badges b ON b.id = a.badge_id WHERE a.client_id = ? ORDER BY a.awarded_at`, k.id),
      staff_notes: per(`SELECT author_name AS written_by, body AS note, pinned, coach_only, created_at, updated_at FROM client_notes WHERE client_id = ? ORDER BY created_at`, k.id),
      messages: per(`SELECT CASE from_kind WHEN 'coach' THEN staff_name ELSE author_name END AS written_by, from_kind AS sender, body, created_at FROM coach_messages WHERE client_id = ? ORDER BY created_at`, k.id)
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
      ctx.db.run(`DELETE FROM athlete_id_aliases WHERE client_id = ?`, id);
      // Team rosters: the athlete comes off, and the line keeps no name or ID (team attendance counts stay).
      ctx.db.run(`UPDATE team_roster SET name = 'Deleted athlete', athlete_id = NULL, position = NULL, grad_year = NULL, active = 0 WHERE client_id = ?`, id);
      ctx.db.run(`DELETE FROM workout_logs WHERE client_id = ?`, id);
      for (const t of ['daily_checkins', 'goal_checks', 'message_reads', 'lesson_progress', 'test_targets', 'goals', 'coach_messages', 'lesson_assignments', 'badge_awards', 'quiz_attempts', 'course_certificates', 'progress_notes', 'client_notes', 'report_links']) ctx.db.run(`DELETE FROM ${t} WHERE client_id = ?`, id);
      ctx.db.run(`DELETE FROM bookings WHERE client_id = ? AND status IN ('booked','waitlisted')`, id);
      ctx.db.run(`DELETE FROM enrollments WHERE client_id = ?`, id);
      ctx.db.run(`UPDATE sales SET receipt_email = NULL, receipt_token = NULL WHERE client_id = ?`, id);   // sales stay; where receipts went and their links go
      ctx.db.run(`UPDATE clients SET name = 'Deleted athlete', archived_by = NULL, athlete_id = NULL, email = NULL, phone = NULL, notes = NULL, birth_date = NULL, sex = NULL, sport = NULL, position = NULL, school = NULL, grad_year = NULL,
        medical_notes = NULL, emergency_name = NULL, emergency_phone = NULL, card_payment_method = NULL, card_brand = NULL, card_last4 = NULL, stripe_customer_id = NULL, access_token = ? WHERE id = ?`, newId('gone'), id);
    }
    ctx.db.run('DELETE FROM texts WHERE family_id = ?', familyId);
    // Pay links: unpaid ones go; paid ones stay as payment records, without names or contact details.
    ctx.db.run(`DELETE FROM pay_links WHERE status != 'paid' AND client_id IN (SELECT id FROM clients WHERE family_id = ?)`, familyId);
    ctx.db.run(`UPDATE pay_links SET description = 'Deleted family', sent_to = NULL WHERE client_id IN (SELECT id FROM clients WHERE family_id = ?)`, familyId);
    ctx.db.run('DELETE FROM review_requests WHERE family_id = ?', familyId);
    ctx.db.run('DELETE FROM spot_offers WHERE family_id = ?', familyId);
    ctx.db.run('UPDATE campaign_recipients SET email = \'deleted\', name = NULL, family_id = NULL WHERE family_id = ?', familyId);
    ctx.db.run(`DELETE FROM leads WHERE family_id = ? OR email IN (SELECT email FROM guardians WHERE family_id = ?)`, familyId, familyId);
    ctx.db.run('DELETE FROM guardian_lesson_progress WHERE guardian_id IN (SELECT id FROM guardians WHERE family_id = ?)', familyId);
    ctx.db.run('DELETE FROM guardian_message_reads WHERE guardian_id IN (SELECT id FROM guardians WHERE family_id = ?)', familyId);
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
