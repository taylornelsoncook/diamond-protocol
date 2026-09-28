// The owner's decisions (schema 43): the owner's retries don't count toward canceling, late card approvals are refunded
// once and the owner told, coach clashes are warnings, waitlisted families hear about moves, deleted programs keep
// athletes' history, coach-only notes stay out of family exports, coaches see only leads given to them, and only the owner
// gives discounts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { handleStripeEvent } from '../src/services/commerce.js';
import { runBilling, attemptCharge, MAX_ATTEMPTS } from '../src/services/billing.js';
import { completePayLink } from '../src/services/paylinks.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDays, addDaysToDate, localDate, zonedToUtc, newId } from '../src/util.js';

let app, base, owner, coach, coach2, desk, coachId, coach2Id, facility, park, plan;
const TZ = 'America/Chicago';
const refunds = [];
let refundFails = false;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return as(cookie);
}
const as = (cookie, header = 'cookie') => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { [header]: cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
};
const db = () => app.ctx.db;
const day = (n) => addDaysToDate(localDate(new Date().toISOString(), TZ), n);
const invoice = (id) => db().get('SELECT * FROM invoices WHERE id = ?', id);
const subOf = (clientId) => db().get('SELECT * FROM subscriptions WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', clientId);
const outboxTo = (email) => db().all('SELECT subject, body FROM outbox WHERE to_email = ? ORDER BY rowid', email);
let seq = 0;
async function member({ card = true, declining = false } = {}) {
  const n = ++seq;
  const made = (await owner('POST', '/v1/clients', { name: `Athlete${n} Decide`, birth_date: '2012-04-04', parent: { name: `Parent ${n}`, email: `dparent${n}@example.com` } })).body;
  const c = { ...made, family_id: db().get('SELECT family_id FROM clients WHERE id = ?', made.id).family_id, email: `dparent${n}@example.com` };
  if (card) await owner('POST', `/v1/clients/${c.id}/card/test`, {});
  if (declining) db().run(`UPDATE families SET card_status = 'declining' WHERE id = ?`, c.family_id);
  await owner('POST', `/v1/clients/${c.id}/subscription`, { plan_id: plan.id });
  return { ...c, inv: db().get('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.id) };
}

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  const refund = app.ctx.payments.refund;
  app.ctx.payments.refund = async (args) => { refunds.push(args); if (refundFails) return { ok: false, error: 'Stripe is down.' }; return refund(args); };
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'correct-horse-battery' });
  coachId = createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'correct-horse-battery', role: 'coach' }).id;
  coach2Id = createUser(app.ctx, { email: 'coach2@test.dev', name: 'Riley Other', password: 'correct-horse-battery', role: 'coach' }).id;
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); coach2 = await signIn('coach2@test.dev'); desk = await signIn('desk@test.dev');
  await owner('PATCH', '/v1/settings', { timezone: TZ });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  park = (await owner('POST', '/v1/locations', { name: 'Park', kind: 'park' })).body;
  plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000, trial_days: 0 })).body;
});
after(() => app.server.close());

// ---------------------------------------------------------------- 1. the owner's retries don't count
test('declined retries the owner starts (one or all) never count toward canceling; only automatic tries do', async () => {
  const m = await member({ declining: true });
  assert.deepEqual([invoice(m.inv.id).attempts, invoice(m.inv.id).auto_attempts], [1, 1], 'the first charge is automatic');
  for (let i = 0; i < 4; i++) assert.equal((await owner('POST', `/v1/invoices/${m.inv.id}/retry`)).status, 200);
  assert.equal((await owner('POST', '/v1/billing/retry-declined')).status, 200, 'Retry all');
  let inv = invoice(m.inv.id);
  assert.equal(inv.attempts, 6);
  assert.equal(inv.auto_attempts, 1, 'five declined retries the owner started: none counted');
  assert.equal(subOf(m.id).status, 'past_due');
  const row = (await owner('GET', `/v1/billing/invoices?view=failed&q=${encodeURIComponent('Athlete' + seq)}`)).body.data.find((r) => r.id === m.inv.id);
  assert.equal(row.retries_left, MAX_ATTEMPTS - 1);
  const detail = (await owner('GET', `/v1/invoices/${m.inv.id}`)).body;
  assert.equal(detail.charges.length, 6, 'every try is listed');
  assert.equal(detail.charges.filter((c) => c.manual).length, 5);
  // Automatic retries: the membership is canceled only after the 4th automatic try.
  let at = inv.next_retry_at;
  for (let auto = 2; auto <= MAX_ATTEMPTS; auto++) {
    await runBilling(app.ctx, addDays(at, 0.01));
    inv = invoice(m.inv.id);
    assert.equal(inv.auto_attempts, auto);
    assert.equal(subOf(m.id).status, auto < MAX_ATTEMPTS ? 'past_due' : 'canceled', `after automatic try ${auto}`);
    at = inv.next_retry_at;
  }
  assert.equal(invoice(m.inv.id).status, 'void');
});

// ---------------------------------------------------------------- 2. late approvals
const webhook = (type, obj) => handleStripeEvent(app.ctx, { type, data: { object: obj } });

test('a late approval after a pay link paid the invoice (and replaced its payment reference) is refunded once, and the owner told', async () => {
  const m = await member();
  db().run(`UPDATE families SET card_status = 'ok' WHERE id = ?`, m.family_id);
  // The bank asks the cardholder to approve the renewal: declined for now, with Stripe's id.
  const real = app.ctx.payments.chargeSaved;
  let sentMeta = null;
  app.ctx.payments.chargeSaved = async (args) => { sentMeta = args.metadata; return { ok: false, ref: 'pi_needs_approval', error: 'The bank asked the cardholder to approve this payment.' }; };
  db().run(`UPDATE invoices SET status = 'failed', next_retry_at = ? WHERE id = ?`, addDays(new Date().toISOString(), 3), m.inv.id);
  await attemptCharge(app.ctx, m.inv.id, app.ctx.now(), { onlyIfFailed: true });
  app.ctx.payments.chargeSaved = real;
  assert.equal(sentMeta.invoice_id, m.inv.id);
  assert.match(sentMeta.charge_attempt_id, /^ich_/);
  assert.equal(invoice(m.inv.id).payment_ref, 'pi_needs_approval');
  // The parent pays by pay link: the invoice's payment reference is now the link's payment.
  const link = (await owner('POST', '/v1/pay-links', { kind: 'invoice', invoice_id: m.inv.id })).body;
  await completePayLink(app.ctx, link.id, 'pi_paylink');
  assert.equal(invoice(m.inv.id).payment_ref, 'pi_paylink');
  // Now the bank approves the old charge. Twice (Stripe retries), and at the same moment.
  refunds.length = 0;
  const ev = { id: 'pi_needs_approval', metadata: { invoice_id: m.inv.id, charge_attempt_id: sentMeta.charge_attempt_id } };
  await Promise.all([webhook('payment_intent.succeeded', ev), webhook('payment_intent.succeeded', ev)]);
  await webhook('payment_intent.succeeded', ev);
  assert.deepEqual(refunds.map((r) => [r.paymentRef, r.amountCents]), [['pi_needs_approval', 15000]], 'refunded exactly once');
  assert.equal(invoice(m.inv.id).status, 'paid');
  assert.equal(invoice(m.inv.id).payment_ref, 'pi_paylink', 'the pay link payment stays the payment');
  assert.equal(invoice(m.inv.id).refunded_cents, 0, 'the invoice\'s own payment isn\'t refunded');
  const a = db().get('SELECT * FROM invoice_charges WHERE id = ?', sentMeta.charge_attempt_id);
  assert.equal(a.late_outcome, 'refunded');
  assert.match(a.late_reason, /another way/);
  // The owner: an email, a Today item, an activity event.
  assert.equal(outboxTo('owner@test.dev').filter((x) => x.subject.startsWith('Refunded a late card charge')).length, 1);
  const item = (await owner('GET', '/v1/dashboard')).body.attention.find((x) => x.kind === 'late_charge' && x.invoice_id === m.inv.id);
  assert.ok(item);
  assert.equal((await owner('GET', '/v1/events?type=invoice.paid_twice')).body.data.filter((e) => e.data.invoice_id === m.inv.id).length, 1);
  assert.ok(!(await coach('GET', '/v1/dashboard')).body.attention.some((x) => x.kind === 'late_charge'), 'coaches never see it');
  assert.equal((await coach('POST', `/v1/invoices/${m.inv.id}/charges/${a.id}/handled`)).status, 403);
  assert.equal((await owner('POST', `/v1/invoices/${m.inv.id}/charges/${a.id}/handled`)).status, 200);
  assert.ok(!(await owner('GET', '/v1/dashboard')).body.attention.some((x) => x.kind === 'late_charge' && x.invoice_id === m.inv.id));
});

test('a charge that errored mid-call (no reference kept) and was then voided: if Stripe took the money, it goes back and the owner is told', async () => {
  const m = await member({ declining: true });
  db().run(`UPDATE families SET card_status = 'ok' WHERE id = ?`, m.family_id);
  const real = app.ctx.payments.chargeSaved;
  const metas = [];
  app.ctx.payments.chargeSaved = async (args) => { metas.push({ key: args.idempotencyKey, ...args.metadata }); throw new Error('Network timeout talking to Stripe'); };
  await assert.rejects(() => attemptCharge(app.ctx, m.inv.id, app.ctx.now(), { onlyIfFailed: true }), /timeout/);
  // Trying again reuses the same try (same idempotency key and metadata, as Stripe requires).
  await assert.rejects(() => attemptCharge(app.ctx, m.inv.id, app.ctx.now(), { onlyIfFailed: true }), /timeout/);
  app.ctx.payments.chargeSaved = real;
  assert.equal(metas.length, 2);
  assert.deepEqual(metas[0], metas[1]);
  const tryRow = db().get('SELECT * FROM invoice_charges WHERE id = ?', metas[0].charge_attempt_id);
  assert.deepEqual([tryRow.status, tryRow.ref], ['error', null]);
  assert.equal(invoice(m.inv.id).payment_ref, null, 'the invoice never got a reference');
  assert.equal((await owner('POST', `/v1/invoices/${m.inv.id}/void`, { reason: 'Written off' })).status, 200);
  refunds.length = 0;
  const out = await webhook('payment_intent.succeeded', { id: 'pi_took_it', metadata: { invoice_id: m.inv.id, charge_attempt_id: metas[0].charge_attempt_id } });
  assert.deepEqual(out, { received: true });
  assert.deepEqual(refunds.map((r) => r.paymentRef), ['pi_took_it']);
  assert.equal(invoice(m.inv.id).status, 'void', 'a voided invoice stays void');
  const row = db().get('SELECT * FROM invoice_charges WHERE id = ?', tryRow.id);
  assert.deepEqual([row.ref, row.status, row.late_outcome], ['pi_took_it', 'succeeded', 'refunded']);
  assert.match(row.late_reason, /voided/);
  assert.ok((await owner('GET', '/v1/dashboard')).body.attention.some((x) => x.kind === 'late_charge' && x.invoice_id === m.inv.id));
});

test('an older try the bank approves while the invoice is still owed pays it; a refund Stripe refuses is flagged and retried once more with the same key', async () => {
  const m = await member({ declining: true });
  const real = app.ctx.payments.chargeSaved;
  let n = 0;
  app.ctx.payments.chargeSaved = async () => ({ ok: false, ref: `pi_try_${m.id}_${++n}`, error: 'Declined' });
  await owner('POST', `/v1/invoices/${m.inv.id}/retry`);
  await owner('POST', `/v1/invoices/${m.inv.id}/retry`);
  app.ctx.payments.chargeSaved = real;
  assert.equal(invoice(m.inv.id).payment_ref, `pi_try_${m.id}_2`);
  // The first of the two approves late: the invoice is paid by it.
  await webhook('payment_intent.succeeded', { id: `pi_try_${m.id}_1`, metadata: { invoice_id: m.inv.id } });
  assert.equal(invoice(m.inv.id).status, 'paid');
  assert.equal(subOf(m.id).status, 'active');
  // Then the second approves too, while Stripe refuses refunds: flagged for the owner, and a repeated event tries again.
  refunds.length = 0; refundFails = true;
  await webhook('payment_intent.succeeded', { id: `pi_try_${m.id}_2`, metadata: { invoice_id: m.inv.id } });
  refundFails = false;
  let a = db().get('SELECT * FROM invoice_charges WHERE ref = ?', `pi_try_${m.id}_2`);
  assert.equal(a.late_outcome, 'refund_failed');
  assert.ok(outboxTo('owner@test.dev').some((x) => x.subject.startsWith('Refund needed')));
  await webhook('payment_intent.succeeded', { id: `pi_try_${m.id}_2`, metadata: { invoice_id: m.inv.id } });
  await webhook('payment_intent.succeeded', { id: `pi_try_${m.id}_2`, metadata: { invoice_id: m.inv.id } });
  a = db().get('SELECT * FROM invoice_charges WHERE ref = ?', `pi_try_${m.id}_2`);
  assert.equal(a.late_outcome, 'refunded');
  assert.equal(refunds.length, 2, 'the refused refund and one retry, then nothing more');
  assert.equal(refunds[0].idempotencyKey, refunds[1].idempotencyKey);
  // A payment that isn't one of this invoice's tries is ignored.
  refunds.length = 0;
  await webhook('payment_intent.succeeded', { id: 'pi_somebody_else', metadata: { invoice_id: m.inv.id } });
  assert.equal(refunds.length, 0);
});

// ---------------------------------------------------------------- 3. coach double-booking
test('a coach clash (another session at that time anywhere, or a day off) is a warning: 409 with warnings until confirm', async () => {
  const d = day(5);
  const first = (await owner('POST', '/v1/sessions', { name: 'Park speed', kind: 'group', location_id: park.id, date: d, start_time: '17:00', duration_min: 60, coach_id: coachId })).body;
  // Another place, overlapping time, same coach.
  let r = await owner('POST', '/v1/sessions', { name: 'Facility strength', kind: 'group', location_id: facility.id, date: d, start_time: '17:30', duration_min: 60, coach_id: coachId });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'coach_conflict');
  assert.equal(r.body.error.details.warnings[0].session_id, first.id);
  assert.match(r.body.error.details.warnings[0].message, /Already leads Park speed/);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM class_sessions WHERE name = 'Facility strength'`).n, 0, 'nothing saved');
  r = await owner('POST', '/v1/sessions', { name: 'Facility strength', kind: 'group', location_id: facility.id, date: d, start_time: '17:30', duration_min: 60, coach_id: coachId, confirm: true });
  assert.equal(r.status, 201, 'saved anyway');
  // Back to back is fine.
  const next = (await owner('POST', '/v1/sessions', { name: 'Late group', kind: 'group', location_id: facility.id, date: d, start_time: '19:00', duration_min: 60, coach_id: coach2Id })).body;
  assert.ok(next.id);
  // A sub for one session, and moving a session into the coach's other session.
  r = await owner('PATCH', `/v1/sessions/${next.id}`, { coach_id: coachId, start_time: '18:15' });
  assert.equal(r.status, 409);
  assert.equal(db().get('SELECT coach_id FROM class_sessions WHERE id = ?', next.id).coach_id, coach2Id, 'nothing changed');
  assert.equal((await coach('PATCH', `/v1/sessions/${next.id}`, { coach_id: coachId, start_time: '18:15', confirm: true })).status, 200, 'coaches can save anyway too');
  assert.equal((await desk('PATCH', `/v1/sessions/${next.id}`, { coach_id: coach2Id, confirm: true })).status, 403, 'front desk can\'t edit sessions');
  // Days off: the coach's own and the facility's.
  await owner('POST', '/v1/time-off', { user_id: coach2Id, start_date: day(6), end_date: day(6), note: 'Wedding' });
  r = await owner('POST', '/v1/sessions', { name: 'Saturday clinic', kind: 'clinic', location_id: facility.id, date: day(6), start_time: '09:00', coach_id: coach2Id });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.details.warnings[0].kind, 'time_off');
  assert.match(r.body.error.details.warnings[0].message, /Is off .*Wedding/);
  // A class's coach, and a coach's hours.
  const cls = (await owner('POST', '/v1/class-series', { name: 'Evening agility', kind: 'group', location_id: park.id, weekdays: [new Date(`${d}T12:00:00Z`).getUTCDay()], start_time: '17:00', duration_min: 45, capacity: 8, start_date: d, end_date: d, coach_id: coach2Id })).body;
  r = await owner('PATCH', `/v1/class-series/${cls.id}`, { coach_id: coachId });
  assert.equal(r.status, 409);
  assert.equal(db().get('SELECT coach_id FROM class_series WHERE id = ?', cls.id).coach_id, coach2Id);
  assert.equal((await owner('PATCH', `/v1/class-series/${cls.id}`, { coach_id: coachId, confirm: true })).status, 200);
  r = await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: new Date(`${d}T12:00:00Z`).getUTCDay(), start_time: '16:00', end_time: '18:00', coach_id: coachId });
  assert.equal(r.status, 409);
  assert.equal((await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: new Date(`${d}T12:00:00Z`).getUTCDay(), start_time: '16:00', end_time: '18:00', coach_id: coachId, confirm: true })).status, 201);
});

// ---------------------------------------------------------------- 4. waitlisted families hear about moves
test('moving a session emails waitlisted families once ("still on the waitlist"), leaving out opted-out waitlist-only addresses and archived athletes', async () => {
  const s = (await owner('POST', '/v1/sessions', { name: 'Tiny group', kind: 'group', location_id: facility.id, date: day(8), start_time: '10:00', capacity: 1, drop_in_cents: 0 })).body;
  const kid = async (name, email) => (await owner('POST', '/v1/clients', { name, birth_date: '2012-01-01', parent: { name: `P ${name}`, email } })).body;
  const booked = await kid('Bea Booked', 'bea.parent@example.com');
  const waiting = await kid('Will Waiting', 'will.parent@example.com');
  const optedOut = await kid('Otto Optout', 'otto.parent@example.com');
  const gone = await kid('Arch Ived', 'arch.parent@example.com');
  for (const c of [booked, waiting, optedOut, gone]) assert.ok([200, 201].includes((await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: c.id })).status));
  // Will's sibling is booked too: one email for the family.
  const sib = (await owner('POST', `/v1/families/${waiting.family.id}/athletes`, { name: 'Wren Waiting', birth_date: '2013-01-01' })).body;
  const other = (await owner('POST', '/v1/sessions', { name: 'Tiny group', kind: 'group', location_id: facility.id, date: day(9), start_time: '10:00', capacity: 5, drop_in_cents: 0 })).body;
  await owner('POST', `/v1/sessions/${other.id}/bookings`, { client_id: sib.id });
  db().run(`INSERT INTO email_optouts (email, created_at, source) VALUES ('otto.parent@example.com', ?, 'test')`, app.ctx.now());
  db().run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), gone.id);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status = 'waitlisted'`, s.id).n, 3);
  const before = (e) => outboxTo(e).length;
  const counts = { bea: before('bea.parent@example.com'), will: before('will.parent@example.com'), otto: before('otto.parent@example.com'), arch: before('arch.parent@example.com') };
  const r = await owner('PATCH', `/v1/sessions/${s.id}`, { start_time: '11:00' });
  assert.equal(r.status, 200);
  assert.equal(r.body.families_emailed, 2);
  const bea = outboxTo('bea.parent@example.com').slice(counts.bea), will = outboxTo('will.parent@example.com').slice(counts.will);
  assert.equal(bea.length, 1);
  assert.match(bea[0].body, /Bea is still booked/);
  assert.equal(will.length, 1, 'once per family');
  assert.match(will[0].body, /Will is still on the waitlist at the new time/);
  assert.equal(outboxTo('otto.parent@example.com').length, counts.otto, 'opted out, only on the waitlist: not emailed');
  assert.equal(outboxTo('arch.parent@example.com').length, counts.arch, 'archived: not emailed');
  // Moving both sessions of Will's family at once (a class edit does the same): still one email, both lines.
  const cls = (await owner('POST', '/v1/class-series', { name: 'Weekly tiny', kind: 'group', location_id: facility.id, weekdays: [new Date(`${day(10)}T12:00:00Z`).getUTCDay()], start_time: '08:00', duration_min: 60, capacity: 1, start_date: day(10), end_date: day(17) })).body;
  const sessions = db().all('SELECT id FROM class_sessions WHERE series_id = ? ORDER BY starts_at', cls.id);
  assert.equal(sessions.length, 2);
  for (const x of sessions) { await owner('POST', `/v1/sessions/${x.id}/bookings`, { client_id: booked.id }); await owner('POST', `/v1/sessions/${x.id}/bookings`, { client_id: waiting.id }); }
  const w0 = outboxTo('will.parent@example.com').length;
  const edit = await owner('PATCH', `/v1/class-series/${cls.id}`, { start_time: '09:00' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const mails = outboxTo('will.parent@example.com').slice(w0);
  assert.equal(mails.length, 1);
  assert.match(mails[0].body, /These sessions have moved/);
  assert.match(mails[0].body, /still on the waitlist for them/);
});

// ---------------------------------------------------------------- 5. deleting a program keeps history
test('deleting a workout or a program keeps the athlete\'s logged workouts and sets, out of the program\'s numbers', async () => {
  const m = await member();
  const ex = (await owner('POST', '/v1/exercises', { name: 'Trap bar deadlift' })).body;
  const p = (await owner('POST', '/v1/programs', { name: 'Off-season strength', weeks: 2 })).body;
  const w1 = (await owner('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 1, title: 'Lower A' })).body;
  const w2 = (await owner('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 2, title: 'Lower B' })).body;
  for (const w of [w1, w2]) await owner('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: ex.id, prescription: '3 × 5' });
  await owner('POST', `/v1/programs/${p.id}/assign`, { client_id: m.id });
  const athlete = as(db().get('SELECT access_token FROM clients WHERE id = ?', m.id).access_token, 'x-client-token');
  for (const w of [w1, w2]) {
    const home = (await athlete('GET', '/app/api/home')).body;
    assert.equal(home.workout.id, w.id);
    const wex = home.workout.exercises[0].id;
    const done = await athlete('POST', `/app/api/workouts/${w.id}/complete`, { request_id: `r-${w.id}`, rpe: 7, sets: [1, 2, 3].map((n) => ({ workout_exercise_id: wex, set_no: n, weight: 185, reps: 5 })) });
    assert.ok([200, 201].includes(done.status), JSON.stringify(done.body));
  }
  // Delete one workout (confirm: its log stays).
  const ask = await owner('DELETE', `/v1/workouts/${w1.id}`, {});
  assert.equal(ask.status, 409);
  assert.match(ask.body.error.message, /stays in the athletes' history/);
  assert.equal((await owner('DELETE', `/v1/workouts/${w1.id}`, { confirm: true })).status, 200);
  let list = (await owner('GET', `/v1/clients/${m.id}/workouts`)).body.data;
  assert.equal(list.length, 2, 'both logs are still on the client page');
  const kept = list.find((l) => l.workout_title === 'Lower A');
  assert.deepEqual([kept.program_name, kept.week, kept.day, kept.sets, kept.exercises_logged, kept.exercises_total, kept.program_deleted], ['Off-season strength', 1, 1, 3, 1, 1, true]);
  assert.equal((await owner('GET', `/v1/programs/${p.id}`)).body.workouts.reduce((t, w) => t + w.logs, 0), 1, 'out of the program\'s numbers');
  // Take the athlete off and delete the program.
  await owner('DELETE', `/v1/programs/${p.id}/clients/${m.id}`);
  const del = await owner('DELETE', `/v1/programs/${p.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.logs_kept, 1);
  list = (await owner('GET', `/v1/clients/${m.id}/workouts`)).body.data;
  assert.deepEqual(list.map((l) => l.workout_title).sort(), ['Lower A', 'Lower B']);
  assert.ok(list.every((l) => l.program_name === 'Off-season strength' && l.program_deleted && l.sets === 3));
  assert.equal(db().get('SELECT COUNT(*) AS n FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id WHERE l.client_id = ?', m.id).n, 6, 'every set kept');
  // The athlete app's history and one workout's details.
  const home = (await athlete('GET', '/app/api/home')).body;
  assert.equal(home.history.length, 2);
  assert.ok(home.history.every((l) => l.program_deleted));
  const detail = (await athlete('GET', `/app/api/logs/${home.history[0].id}`)).body;
  assert.equal(detail.exercises[0].name, 'Trap bar deadlift');
  assert.equal(detail.exercises[0].done, true);
  assert.equal(detail.exercises[0].sets.length, 3);
  assert.equal(detail.can_reopen, false);
  assert.equal((await athlete('PUT', `/app/api/logs/${home.history[0].id}`, { rpe: 5 })).status, 409, 'a removed workout can\'t be reopened');
  // The family's data export.
  const exp = JSON.parse((await owner('GET', `/v1/families/${m.family_id}/export`)).text);
  assert.deepEqual(exp.athletes[0].workouts.map((w) => [w.program, w.workout]).sort(), [['Off-season strength', 'Lower A'], ['Off-season strength', 'Lower B']]);
  assert.equal(exp.athletes[0].workout_sets.length, 6);
});

// ---------------------------------------------------------------- 7. coach-only notes stay out of family exports
test('coach-only staff notes are left out of the parent\'s data download and the family export', async () => {
  const c = (await owner('POST', '/v1/clients', { name: 'Nora Notes', birth_date: '2012-02-02', parent: { name: 'Nina Notes', email: 'nina.notes@example.com' } })).body;
  await coach('POST', `/v1/clients/${c.id}/notes`, { body: 'Parent seems stressed about playing time.', coach_only: true });
  await owner('POST', `/v1/clients/${c.id}/notes`, { body: 'Prefers texts to calls.' });
  const login = await fetch(base + '/portal/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nina.notes@example.com' }) }).then((r) => r.json());
  const res = await fetch(base + '/portal/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nina.notes@example.com', code: login.dev_code }) });
  const parent = as(res.headers.get('set-cookie').split(';')[0]);
  const mine = await parent('GET', '/portal/api/export');
  assert.equal(mine.status, 200);
  const staffSide = (await owner('GET', `/v1/families/${c.family.id}/export`)).text;
  for (const text of [mine.text, staffSide]) {
    assert.ok(!text.includes('playing time'), 'no coach-only note');
    assert.ok(text.includes('Prefers texts to calls.'), 'other staff notes are still there');
    assert.ok(!text.includes('coach_only'));
  }
});

// ---------------------------------------------------------------- 9. leads
test('coaches see and work only the leads the owner gave them; owner and front desk see all; only the owner assigns', async () => {
  const mine = (await desk('POST', '/v1/leads', { parent_name: 'Gia Given', email: 'gia@example.com', follow_up: false })).body;
  const notMine = (await owner('POST', '/v1/leads', { parent_name: 'Hal Hidden', email: 'hal@example.com', follow_up: false })).body;
  assert.equal((await coach('POST', '/v1/leads', { parent_name: 'Coach Added', email: 'ca@example.com' })).status, 403, 'coaches don\'t add leads');
  assert.equal((await coach('GET', '/v1/leads')).body.data.length, 0, 'nothing given yet');
  assert.equal((await desk('PATCH', `/v1/leads/${mine.id}`, { coach_id: coachId })).status, 403, 'front desk can\'t assign');
  const given = await owner('PATCH', `/v1/leads/${mine.id}`, { coach_id: coachId });
  assert.equal(given.status, 200);
  assert.equal(given.body.coach_name, 'Carl Coach');
  assert.ok(outboxTo('coach@test.dev').some((x) => x.subject === 'A lead for you: Gia Given'), 'the coach is emailed');
  const list = (await coach('GET', '/v1/leads')).body;
  assert.deepEqual(list.data.map((l) => l.id), [mine.id]);
  assert.equal(list.only_assigned, true);
  assert.equal(Object.values(list.counts).reduce((a, b) => a + b, 0), 1, 'counts are only theirs');
  assert.equal((await coach('GET', `/v1/leads/${notMine.id}`)).status, 404);
  assert.equal((await coach('PATCH', `/v1/leads/${notMine.id}`, { status: 'contacted' })).status, 404);
  assert.equal((await coach2('GET', `/v1/leads/${mine.id}`)).status, 404, 'another coach can\'t see it');
  const worked = await coach('PATCH', `/v1/leads/${mine.id}`, { contacted: true, notes: 'Called, booking an eval.' });
  assert.equal(worked.status, 200);
  assert.equal(worked.body.status, 'contacted');
  assert.equal((await coach('PATCH', `/v1/leads/${mine.id}`, { coach_id: coach2Id })).status, 403, 'coaches can\'t reassign');
  assert.equal((await coach('PATCH', `/v1/leads/${mine.id}`, { coach_id: null })).status, 403);
  assert.ok((await desk('GET', '/v1/leads')).body.data.length >= 2, 'front desk sees every lead');
  assert.equal((await owner('PATCH', `/v1/leads/${mine.id}`, { coach_id: newId('usr') })).status, 404);
  // Today and the activity feed don't show a coach other leads.
  const dash = (await coach('GET', '/v1/dashboard')).body;
  const fresh = dash.attention.find((a) => a.kind === 'new_leads');
  assert.equal(fresh?.count ?? 0, 1);
  assert.ok(!(await coach('GET', '/v1/activity?limit=100')).body.data.some((e) => e.type.startsWith('lead.')));
  assert.ok(!(await coach('GET', '/v1/events?limit=200')).body.data.some((e) => e.type.startsWith('lead.')));
  // Taken back: the coach no longer sees it.
  await owner('PATCH', `/v1/leads/${mine.id}`, { coach_id: null });
  assert.equal((await coach('GET', `/v1/leads/${mine.id}`)).status, 404);
});

// ---------------------------------------------------------------- 10. discounts
test('coaches and front desk can\'t give discounts; the owner can', async () => {
  const sale = (who, discount) => who('POST', '/v1/sales', { location_id: facility.id, method: 'cash', custom: { description: 'Gloves', amount_cents: 4000 }, discount });
  for (const who of [coach, desk]) {
    const r = await sale(who, { type: 'amount', value: 500, reason: 'Friend' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.message, 'Only the owner can give discounts. Ask the owner.');
  }
  assert.equal((await sale(owner, { type: 'percent', value: 10, reason: 'Sibling' })).status, 201);
  assert.equal((await owner('GET', '/v1/settings')).body.staff_discount_max_pct, '0');
});
