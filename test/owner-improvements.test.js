// The owner's improvements (schema 46): how each client trains, the refunds report, changing a membership's plan (now,
// at renewal, or now with the difference charged), the lockout after a declined payment, Education tabs by audience with
// the public coach's education page, and the upgrade from a version 45 database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { runBilling } from '../src/services/billing.js';
import { kioskCheckIn } from '../src/services/checkin.js';
import { resetRateLimits } from '../src/services/security.js';
import { newId, addDays } from '../src/util.js';

let app, base, owner, coach, desk, facility, plan, big, trialPlan;
const PW = 'correct-horse-battery';
async function call(cookie, method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: r.status, body: json, text };
}
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (method, path, body) => call(cookie, method, path, body);
}
async function parent(email) {
  const { body } = await call(null, 'POST', '/portal/api/login', { email });
  const v = await fetch(base + '/portal/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: body.dev_code }) });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  return (method, path, body2) => call(cookie, method, path, body2);
}
const athleteApp = (clientId) => (method, path, body) => call(null, method, path, body, { 'x-client-token': db().get('SELECT access_token FROM clients WHERE id = ?', clientId).access_token });
const db = () => app.ctx.db;
let seq = 0;
async function member({ planId = plan.id, declining = false, name } = {}) {
  const n = ++seq;
  const c = (await owner('POST', '/v1/clients', { name: name ?? `Athlete ${n} Test`, parent: { name: `Parent ${n}`, email: `imp${n}@example.com`, phone: `512-555-01${String(n).padStart(2, '0')}` } })).body;
  const familyId = db().get('SELECT family_id FROM clients WHERE id = ?', c.id).family_id;
  await owner('POST', `/v1/clients/${c.id}/card/test`, {});
  if (declining) db().run(`UPDATE families SET card_status = 'declining' WHERE id = ?`, familyId);
  if (planId) await owner('POST', `/v1/clients/${c.id}/subscription`, { plan_id: planId });
  return { ...c, family_id: familyId, email: `imp${n}@example.com` };
}
const subOf = (clientId) => db().get('SELECT * FROM subscriptions WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', clientId);
const invoices = (clientId) => db().all('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at, rowid', clientId);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  plan = (await owner('POST', '/v1/plans', { name: 'Group', price_cents: 10000, trial_days: 0 })).body;
  big = (await owner('POST', '/v1/plans', { name: 'Elite', price_cents: 16000, trial_days: 0 })).body;
  trialPlan = (await owner('POST', '/v1/plans', { name: 'Starter', price_cents: 8000, trial_days: 14 })).body;
});
after(() => app.server.close());

// ---------------------------------------------------------------- how each client trains
test('staff pick how a client trains; it shows on the client, filters the list and goes in the export', async () => {
  const a = (await desk('POST', '/v1/clients', { name: 'Hana Hybrid', training_type: 'hybrid', parent: { name: 'Hal Hybrid', email: 'hal.h@example.com' } })).body;
  assert.equal(a.training_type, 'hybrid');
  const b = await member({ planId: null, name: 'Remy Remote' });
  assert.equal(b.training_type, null, 'empty until someone picks');
  assert.equal((await coach('PATCH', `/v1/clients/${b.id}`, { training_type: 'remote' })).body.training_type, 'remote');
  assert.equal((await owner('PATCH', `/v1/clients/${b.id}`, { training_type: 'somewhere' })).status, 400, 'only the three kinds');
  assert.deepEqual((await owner('GET', '/v1/clients?training=remote')).body.data.map((c) => c.name), ['Remy Remote']);
  assert.ok((await owner('GET', '/v1/clients?training=unset')).body.data.every((c) => !c.training_type));
  assert.equal((await owner('GET', '/v1/clients?training=nope')).status, 400);
  const csv = (await owner('GET', '/v1/client-export?training=hybrid')).text;
  assert.match(csv, /Trains/);
  assert.match(csv, /Hana Hybrid[^\r\n]*Hybrid athlete/);
  assert.equal((await owner('PATCH', `/v1/clients/${b.id}`, { training_type: null })).body.training_type, null, 'null clears it');
});

// ---------------------------------------------------------------- refunds report
test('the refunds report lists every refund with the athlete, email and phone, and is the owner\'s', async () => {
  const m = await member({ name: 'Rita Refund' });
  const inv = invoices(m.id)[0];
  assert.equal(inv.status, 'paid');
  assert.equal((await owner('POST', `/v1/invoices/${inv.id}/refund`, { amount_cents: 2500, reason: 'Missed a week' })).status, 200);
  const sale = (await owner('POST', '/v1/sales', { location_id: facility.id, method: 'cash', client_id: m.id, custom: { description: 'Team shirt', amount_cents: 3000 } })).body;
  const sr = await owner('POST', `/v1/sales/${sale.id}/refund`, { amount_cents: 3000, reason: 'Wrong size' });
  assert.equal(sr.status, 200, JSON.stringify(sr.body));
  const r = (await owner('GET', '/v1/billing/refunds?q=rita')).body;
  assert.equal(r.count, 2);
  assert.equal(r.total_cents, 5500);
  const [first, second] = r.data;
  assert.deepEqual([first.kind, second.kind].sort(), ['membership', 'sale']);
  for (const x of r.data) {
    assert.equal(x.athlete_name, 'Rita Refund');
    assert.equal(x.email, m.email, 'the parent\'s email when the athlete has none');
    assert.equal(x.phone, db().get('SELECT phone FROM guardians WHERE family_id = ?', m.family_id).phone);
    assert.ok(x.parent_name);
  }
  const mem = r.data.find((x) => x.kind === 'membership');
  assert.deepEqual([mem.amount_cents, mem.reason, mem.what, mem.by], [2500, 'Missed a week', 'Membership: Group', 'Olivia Owner']);
  assert.equal(r.data.find((x) => x.kind === 'sale').what, 'Team shirt');
  assert.equal((await owner('GET', '/v1/billing/refunds?q=rita&kind=sale')).body.count, 1);
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  assert.equal((await owner('GET', `/v1/billing/refunds?q=rita&from=${tomorrow}`)).body.count, 0, 'dates are the day the money went back');
  assert.equal((await owner('GET', '/v1/billing/refunds?from=2026-09-10&to=2026-09-01')).status, 400);
  const csv = await owner('GET', '/v1/billing/refunds/export?q=rita');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Refunded on,Athlete,Athlete ID,Email,Phone/);
  assert.match(csv.text, /Rita Refund/);
  assert.equal((await coach('GET', '/v1/billing/refunds')).status, 403);
  assert.equal((await desk('GET', '/v1/billing/refunds/export')).status, 403);
});

// ---------------------------------------------------------------- changing plans
test('changing a plan now switches today and charges nothing until the renewal', async () => {
  const m = await member();
  const before = invoices(m.id).length;
  const r = await owner('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: big.id, when: 'now' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.plan_id, big.id);
  assert.equal(r.body.change.charged, null);
  assert.equal(invoices(m.id).length, before, 'nothing charged now');
  assert.equal((await owner('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: big.id })).status, 409, 'already on it');
  assert.equal((await coach('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: plan.id })).status, 403, 'plan changes are the owner\'s');
});

test('changing a plan at renewal waits for the membership to renew, and can be canceled', async () => {
  const m = await member();
  const r = await owner('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: big.id, when: 'renewal' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.plan_id, r.body.pending_plan_id, r.body.pending_plan_name], [plan.id, big.id, 'Elite']);
  assert.equal((await owner('GET', `/v1/clients/${m.id}`)).body.subscription.pending_plan_name, 'Elite', 'the client page shows the waiting change');
  const fam = await parent(m.email);
  assert.equal((await fam('GET', '/portal/api/me')).body.athletes[0].membership.pending_plan_name, 'Elite', 'so does the parent portal');
  // Canceled, then set again, then the renewal happens.
  assert.equal((await owner('DELETE', `/v1/clients/${m.id}/subscription/pending-plan`)).body.pending_plan_id, null);
  await owner('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: big.id, when: 'renewal' });
  const end = subOf(m.id).current_period_end;
  await runBilling(app.ctx, addDays(end, 0.01));
  const s = subOf(m.id);
  assert.deepEqual([s.plan_id, s.pending_plan_id], [big.id, null]);
  assert.equal(invoices(m.id).at(-1).amount_cents, 16000, 'the renewal charged the new price');
});

test('changing a plan with the difference charges the rest of this paid month now, as its own invoice', async () => {
  const m = await member();
  const s0 = subOf(m.id);
  // Half the month is left.
  const start = addDays(new Date().toISOString(), -15), end = addDays(new Date().toISOString(), 15);
  db().run('UPDATE subscriptions SET current_period_start = ?, current_period_end = ? WHERE id = ?', start, end, s0.id);
  db().run('UPDATE invoices SET period_start = ?, period_end = ? WHERE subscription_id = ?', start, end, s0.id);   // the month's $100 payment
  const r = await owner('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: big.id, when: 'difference' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.body.change.charged;
  assert.ok(Math.abs(c.amount_cents - 3000) <= 5, `about half of the $60 difference, got ${c.amount_cents}`);
  assert.equal(c.status, 'paid');
  const inv = invoices(m.id).at(-1);
  assert.equal(inv.note, 'Plan change: Group to Elite, the rest of this month');
  assert.equal(inv.period_end, end);
  const listed = (await owner('GET', `/v1/billing/invoices?q=${encodeURIComponent('plan change')}`)).body.data;
  assert.ok(listed.some((x) => x.id === inv.id), 'the invoice says what it was for');
  // Moving down charges nothing; moving back up again charges nothing more, since those days are already paid at Elite.
  const down = await owner('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: plan.id, when: 'now' });
  assert.equal(down.body.change.charged, null);
  const up = await owner('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: big.id, when: 'difference' });
  assert.deepEqual([up.body.plan_id, up.body.change.charged], [big.id, null], 'never charged twice for the same days');
  assert.ok(Math.abs(up.body.change.difference_cents) <= 5);
  const down2 = await owner('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: plan.id, when: 'difference' });
  assert.deepEqual([down2.body.change.charged, down2.body.change.difference_cents < 0], [null, true], 'a cheaper plan charges nothing');
  // A trial has nothing paid to top up.
  const t = await member({ planId: trialPlan.id });
  assert.equal((await owner('POST', `/v1/clients/${t.id}/subscription/plan`, { plan_id: big.id, when: 'difference' })).status, 409);
  assert.equal((await owner('POST', `/v1/clients/${t.id}/subscription/plan`, { plan_id: big.id, when: 'later' })).status, 400);
});

test('a declined difference is a one-off: the membership stays active and the family isn\'t locked; no card, no charge', async () => {
  const m = await member();
  db().run(`UPDATE families SET card_status = 'declining' WHERE id = ?`, m.family_id);
  await owner('PATCH', '/v1/settings', { payment_lock_tries: 1 });
  const r = await owner('POST', `/v1/clients/${m.id}/subscription/plan`, { plan_id: big.id, when: 'difference' });
  assert.equal(r.body.change.charged.status, 'failed');
  const inv = invoices(m.id).at(-1);
  assert.deepEqual([inv.status, inv.next_retry_at], ['failed', null], 'not retried on its own');
  assert.equal(subOf(m.id).status, 'active', 'the membership stays paid up');
  assert.equal((await (await parent(m.email))('GET', '/portal/api/me')).body.payment_lock, null, 'never locks the family');
  await runBilling(app.ctx, addDays(new Date().toISOString(), 3.5));
  assert.equal(subOf(m.id).status, 'active');
  await owner('PATCH', '/v1/settings', { payment_lock_tries: 4 });
  // No saved card: refused before anything changes.
  const n = ++seq;
  const c = (await owner('POST', '/v1/clients', { name: `Nocard ${n}`, parent: { name: 'P', email: `nocard${n}@example.com` } })).body;
  await owner('POST', `/v1/clients/${c.id}/subscription`, { plan_id: plan.id });
  db().run(`UPDATE subscriptions SET status = 'active' WHERE client_id = ?`, c.id);
  const nc = await owner('POST', `/v1/clients/${c.id}/subscription/plan`, { plan_id: big.id, when: 'difference' });
  assert.equal(nc.status, 409);
  assert.match(nc.body.error.message, /card/);
  assert.equal(subOf(c.id).plan_id, plan.id);
});

// ---------------------------------------------------------------- lockout
// The scheduled retries come every 3 days: the nth retry is due just after 3n days.
const retry = (n) => runBilling(app.ctx, addDays(new Date().toISOString(), 3 * n + 0.5));
const autoTries = (invId) => db().get('SELECT auto_attempts FROM invoices WHERE id = ?', invId).auto_attempts;
async function lockedMember() {
  const m = await member({ declining: true });
  const inv = invoices(m.id)[0];
  assert.equal(inv.status, 'failed');
  assert.equal(subOf(m.id).status, 'past_due');
  for (const n of [1, 2, 3]) await retry(n);           // the first charge and 3 retries declined
  assert.equal(autoTries(inv.id), 4);
  return { ...m, inv };
}

test('owner decision: every client is locked out once the first charge and 3 retries decline, and canceled a retry later', async () => {
  assert.equal((await owner('GET', '/v1/settings')).body.payment_lock_tries, '4', 'the default');
  const m = await member({ declining: true });
  const inv = invoices(m.id)[0];
  await owner('PATCH', `/v1/clients/${m.id}`, { training_type: 'remote' });
  const fam = await parent(m.email);
  const mails = () => db().all('SELECT body FROM outbox WHERE to_email = ? AND subject LIKE ? ORDER BY rowid', m.email, 'Payment didn%');
  assert.match(mails().at(-1).body, /declined 3 more times, booking, the athlete app and self check-in pause/);
  for (const n of [1, 2]) {
    await retry(n);
    assert.equal((await fam('GET', '/portal/api/me')).body.payment_lock, null, `${n + 1} declines: not locked yet`);
    assert.equal((await fam('GET', '/portal/api/schedule')).status, 200);
  }
  assert.match(mails().at(-1).body, /declined again, booking/);
  await retry(3);
  assert.equal(autoTries(inv.id), 4);
  const me = (await fam('GET', '/portal/api/me')).body;
  assert.equal(me.payment_lock.amount_cents, 10000);
  assert.match(me.payment_lock.message, /didn't go through/);
  for (const path of ['/portal/api/schedule', '/portal/api/programs', '/portal/api/store', `/portal/api/athletes/${m.id}/engage`]) {
    const r = await fam('GET', path);
    assert.equal(r.status, 402, path);
    assert.equal(r.body.error.code, 'payment_locked');
  }
  assert.equal((await fam('GET', '/portal/api/payments')).status, 200, 'payments still work');
  assert.notEqual((await fam('PATCH', `/portal/api/athletes/${m.id}`, { medical_notes: 'Asthma inhaler in bag' })).status, 402, 'medical notes never wait on a payment');
  assert.notEqual((await fam('PATCH', '/portal/api/texts', { texts: false })).status, 402, 'nor turning texts off');
  assert.notEqual((await fam('POST', '/portal/api/card/setup-link')).status, 402, 'so does the card');
  assert.equal((await fam('GET', `/portal/api/payments/membership/${invoices(m.id)[0].id}`)).status !== 402, true, 'and receipts');
  // The athlete app is closed too.
  const home = (await athleteApp(m.id)('GET', '/app/api/home')).body;
  assert.equal(home.locked, true);
  assert.match(home.message, /parent/);
  assert.equal((await athleteApp(m.id)('GET', '/app/api/engage')).status, 402, 'the rest of the app waits too');
  // Staff see it on the client page; coaches without the amount.
  assert.equal((await owner('GET', `/v1/clients/${m.id}`)).body.payment_locked.amount_cents, 10000);
  const seen = (await coach('GET', `/v1/clients/${m.id}`)).body.payment_locked;
  assert.ok(seen && seen.amount_cents === undefined, 'coaches see the lock, not the amount');
  assert.match(mails().at(-1).body, /Until it's paid, booking, the athlete app and self check-in are paused/);
  // Paid: everything opens again.
  db().run(`UPDATE families SET card_status = 'ok' WHERE id = ?`, m.family_id);
  const tryAgain = await fam('POST', `/portal/api/payments/${invoices(m.id)[0].id}/retry`);
  assert.equal(tryAgain.status, 200, JSON.stringify(tryAgain.body));
  assert.equal((await fam('GET', '/portal/api/me')).body.payment_lock, null);
  assert.equal((await fam('GET', '/portal/api/schedule')).status, 200);
  assert.equal((await athleteApp(m.id)('GET', '/app/api/home')).body.locked, false);
  assert.equal((await athleteApp(m.id)('GET', '/app/api/engage')).status, 200);
});

test('a locked athlete checks in at the desk, not the tablet; the owner can turn the lockout off', async () => {
  const m = await lockedMember();
  const key = (await desk('POST', '/v1/kiosks', { location_id: facility.id })).body.link.split('#')[1];
  const sid = newId('cls'), s = new Date(Date.now() + 10 * 60000).toISOString(), e = new Date(Date.now() + 70 * 60000).toISOString();
  db().run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, status, created_at) VALUES (?, 'Speed', 'group', ?, ?, ?, 10, 2500, 'scheduled', ?)`, sid, facility.id, s, e, s);
  const bid = newId('bkg');
  db().run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'membership', ?, ?)`, bid, sid, m.id, s, s);
  assert.throws(() => kioskCheckIn(app.ctx, key, { booking_id: bid }), (x) => x.status === 402 && /front desk/.test(x.message));
  assert.equal((await owner('PATCH', '/v1/settings', { payment_lock_tries: 0 })).status, 200);
  assert.equal(kioskCheckIn(app.ctx, key, { booking_id: bid }).already, false, 'no lockout: the tablet checks them in');
  assert.equal((await (await parent(m.email))('GET', '/portal/api/schedule')).status, 200);
  assert.equal((await owner('PATCH', '/v1/settings', { payment_lock_tries: 5 })).status, 400);
  await owner('PATCH', '/v1/settings', { payment_lock_tries: 4 });
});

test('the 4th retry declining cancels the membership, which ends the lockout', async () => {
  const m = await lockedMember();
  assert.equal(subOf(m.id).status, 'past_due');
  await retry(4);
  assert.equal(autoTries(m.inv.id), 5);
  assert.equal(subOf(m.id).status, 'canceled');
  assert.equal((await (await parent(m.email))('GET', '/portal/api/me')).body.payment_lock, null);
});

// ---------------------------------------------------------------- Education tabs
test('Education tabs decide who reads a lesson; coach\'s education is public and never assigned', async () => {
  const athlete = await member({ name: 'Eli Reader' });
  const post = async (body) => (await owner('POST', '/v1/lessons', body)).body;
  const ath = await post({ title: 'Sleep basics' });
  const blog = await post({ title: 'Camp recap', category: 'blog' });
  const study = await post({ title: 'Sprint study', category: 'research' });
  const cz = await post({ title: 'Cueing the hinge', category: 'coach', body: 'Push the hips back.\n\nKeep the shins still.' });
  const par = await post({ title: 'Talking after a loss', category: 'parent' });
  assert.deepEqual([ath.category, blog.category, cz.category], ['athlete', 'blog', 'coach']);
  assert.equal((await owner('POST', '/v1/lessons', { title: 'x', category: 'gossip' })).status, 400);
  // Athletes: athlete education, blogs and research only.
  const seen = (await athleteApp(athlete.id)('GET', '/app/api/engage')).body.education.lessons.map((l) => l.title);
  for (const t of ['Sleep basics', 'Camp recap', 'Sprint study']) assert.ok(seen.includes(t), t);
  for (const t of ['Cueing the hinge', 'Talking after a loss']) assert.ok(!seen.includes(t), t);
  assert.equal((await athleteApp(athlete.id)('GET', `/app/api/lessons/${cz.id}`)).status, 404);
  // Parents: their own reading, blogs and research.
  const fam = await parent(athlete.email);
  const articles = (await fam('GET', '/portal/api/parent-articles')).body.data.map((l) => l.title);
  assert.deepEqual(articles.sort(), ['Camp recap', 'Sprint study', 'Talking after a loss']);
  const read = await fam('POST', `/portal/api/parent-lessons/${par.id}/complete`, {});
  assert.equal(read.body.done, true);
  assert.equal((await fam('GET', `/portal/api/parent-lessons/${cz.id}`)).status, 404);
  // The public page: coach's education only.
  const pub = await call(null, 'GET', '/portal/api/public/learn');
  assert.deepEqual(pub.body.data.map((l) => l.title), ['Cueing the hinge']);
  assert.match((await call(null, 'GET', `/portal/api/public/learn/${cz.id}`)).body.body, /hips back/);
  assert.equal((await call(null, 'GET', `/portal/api/public/learn/${blog.id}`)).status, 404);
  assert.equal((await fetch(`${base}/learn`)).status, 200);
  await owner('PATCH', `/v1/lessons/${cz.id}`, { published: false });
  assert.equal((await call(null, 'GET', '/portal/api/public/learn')).body.data.length, 0, 'drafts stay private');
  // Coach's and parent education can't be assigned.
  await owner('PATCH', `/v1/lessons/${cz.id}`, { published: true });
  assert.equal((await owner('POST', '/v1/lesson-assignments', { lesson_id: cz.id, client_id: athlete.id })).status, 409);
  assert.equal((await owner('POST', '/v1/lesson-assignments', { lesson_id: par.id, client_id: athlete.id })).status, 409);
  assert.equal((await owner('POST', '/v1/lesson-assignments', { lesson_id: blog.id, client_id: athlete.id })).status, 201);
  assert.equal((await owner('PATCH', `/v1/lessons/${blog.id}`, { category: 'coach' })).status, 409, 'assigned reading can\'t move where athletes can\'t open it');
  assert.equal((await owner('PATCH', `/v1/lessons/${blog.id}`, { category: 'research' })).status, 200);
  // A lesson in a course follows the course.
  const pc = (await owner('POST', '/v1/courses', { title: 'Parents 101', audience: 'parents' })).body;
  assert.equal((await owner('POST', '/v1/lessons', { title: 'In a course', course_id: pc.id })).body.category, 'parent');
  assert.equal((await owner('POST', '/v1/lessons', { title: 'Wrong tab', course_id: pc.id, category: 'blog' })).status, 400);
  await owner('PATCH', `/v1/courses/${pc.id}`, { audience: 'athletes' });
  assert.equal(db().get(`SELECT category FROM lessons WHERE title = 'In a course'`).category, 'athlete', 'a course\'s lessons follow its audience');
  const edu = (await owner('GET', '/v1/education')).body;
  assert.ok(edu.categories.coach);
  assert.ok(edu.stats.by_category.research >= 2);
  assert.equal((await desk('POST', '/v1/lessons', { title: 'desk', category: 'blog' })).status, 403, 'front desk only looks');
});

// ---------------------------------------------------------------- upgrade
test('a version 45 database gains the version 46 columns, parent-course lessons become parent education, opened twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v45.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 45');
    const at = '2026-09-01T17:00:00.000Z';
    old.exec(`INSERT INTO courses (id, title, published, audience, created_at) VALUES ('crs_p', 'For parents', 1, 'parents', '${at}'), ('crs_a', 'For athletes', 1, 'athletes', '${at}')`);
    old.exec(`INSERT INTO lessons (id, title, published, position, course_id, created_at, updated_at) VALUES
      ('les_p', 'Growth spurts', 1, 0, 'crs_p', '${at}', '${at}'), ('les_a', 'Sleep', 1, 0, 'crs_a', '${at}', '${at}'), ('les_l', 'Hydration', 1, 0, NULL, '${at}', '${at}')`);
    old.exec(`INSERT INTO plans (id, name, price_cents, created_at) VALUES ('pln_1', 'Group', 10000, '${at}')`);
    old.exec(`INSERT INTO clients (id, name, access_token, created_at) VALUES ('cli_1', 'Ava', 'tok', '${at}')`);
    old.exec(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_1', 'cli_1', 'pln_1', 'active', '${at}', '2026-10-01T17:00:00.000Z', '${at}', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      const cols = (t) => d.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(d.get('PRAGMA user_version').user_version, 69, `round ${round}`);
      assert.equal(d.get('PRAGMA integrity_check').integrity_check, 'ok');
      for (const [t, c] of [['clients', 'training_type'], ['subscriptions', 'pending_plan_id'], ['subscriptions', 'pending_set_at'], ['invoices', 'note'], ['lessons', 'category']]) assert.ok(cols(t).includes(c), `${t}.${c}`);
      assert.deepEqual(d.all('SELECT id, category FROM lessons ORDER BY id').map((l) => [l.id, l.category]), [['les_a', 'athlete'], ['les_l', 'athlete'], ['les_p', 'parent']]);
      assert.equal(d.get(`SELECT plan_id FROM subscriptions WHERE id = 'sub_1'`).plan_id, 'pln_1');
      d.close();
    }
    // Same columns as a new database.
    const fresh = openDb(join(dir, 'fresh.db')), up = openDb(file);
    for (const t of ['clients', 'subscriptions', 'invoices', 'lessons']) {
      assert.deepEqual(up.all(`PRAGMA table_info(${t})`).map((c) => c.name).sort(), fresh.all(`PRAGMA table_info(${t})`).map((c) => c.name).sort(), t);
    }
    fresh.close(); up.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
