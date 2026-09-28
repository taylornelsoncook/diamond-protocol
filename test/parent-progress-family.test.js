// Parent portal, Progress, Programs and Family (batch B13): the next testing day and targets on Progress (results only
// from shared testing days), what a test measures, membership change requests (the owner decides; billing never changes
// on its own), pack value, payments and receipts, retrying a declined payment, removing the card, parents and athletes.
// Every endpoint is also tried by another family.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addTestCard, createSale } from '../src/services/commerce.js';
import { recordResults } from '../src/services/performance.js';
import { localDate, addDaysToDate } from '../src/util.js';

const TZ = 'America/Chicago';
let app, base, owner, coach, facility, plan, plan2, ava, ben, cole, maria, dana, family;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
async function parent(email) {
  const { body } = await req('POST', '/portal/api/login', { email });
  return as((await req('POST', '/portal/api/verify', { email, code: body.dev_code })).cookie);
}
const db = () => app.ctx.db;
const today = () => localDate(new Date().toISOString(), TZ);
const born = (age) => `${new Date().getFullYear() - age}-01-15`;
const outbox = () => db().all('SELECT * FROM outbox ORDER BY created_at DESC, rowid DESC');

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  coach = await signIn('coach@test.dev', 'coach-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  plan = (await owner('POST', '/v1/plans', { name: 'Group membership', price_cents: 14900, trial_days: 0 })).body;
  plan2 = (await owner('POST', '/v1/plans', { name: 'Unlimited', price_cents: 19900, trial_days: 0 })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: born(12), parent: { name: 'Maria Lopez', email: 'maria@example.com', phone: '5125550101' } })).body;
  family = ava.family;
  ben = (await owner('POST', `/v1/families/${family.id}/athletes`, { name: 'Ben Lopez', birth_date: born(10) })).body;
  cole = (await owner('POST', '/v1/clients', { name: 'Cole Park', birth_date: born(12), parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  for (const c of [ava, cole]) { db().run('UPDATE families SET waiver_version = 1, waiver_signed_at = ?, waiver_signed_by = ? WHERE id = ?', app.ctx.now(), 'Maria Lopez <maria@example.com>', c.family.id); await addTestCard(app.ctx, c.id); }
  await owner('POST', `/v1/clients/${ava.id}/subscription`, { plan_id: plan.id });
  maria = await parent('maria@example.com');
  dana = await parent('dana@example.com');
});
after(() => app.server.close());

test('Progress: next testing day, targets, test details, and only shared testing days', async () => {
  const shared = (await owner('POST', '/v1/testing-sessions', { name: 'Summer baseline', date: addDaysToDate(today(), -30), tests: ['dash_40yd'], athletes: [{ client_id: ava.id }] })).body;
  const hidden = (await owner('POST', '/v1/testing-sessions', { name: 'Fall combine', date: addDaysToDate(today(), -2), tests: ['dash_40yd'], athletes: [{ client_id: ava.id }] })).body;
  await owner('POST', '/v1/testing-sessions', { name: 'Winter retest', date: addDaysToDate(today(), 10), tests: ['dash_40yd'], athletes: [{ client_id: ava.id }] });
  recordResults(app.ctx, [{ client_id: ava.id, test: 'dash_40yd', value: 6.1, recorded_at: `${addDaysToDate(today(), -30)}T15:00:00.000Z` }], { source: 'manual', sessionId: shared.id });
  recordResults(app.ctx, [{ client_id: ava.id, test: 'dash_40yd', value: 5.9, recorded_at: `${addDaysToDate(today(), -2)}T15:00:00.000Z` }], { source: 'manual', sessionId: hidden.id });
  await owner('POST', `/v1/testing-sessions/${shared.id}/share`, { notify: false });
  await owner('POST', `/v1/clients/${ava.id}/targets`, { test: 'dash_40yd', target: '5.8' });
  const r = (await maria('GET', `/portal/api/athletes/${ava.id}/report`)).body;
  assert.deepEqual(r.next_testing_day, { name: 'Winter retest', date: addDaysToDate(today(), 10), today: false });
  const dash = r.tests.find((t) => t.test === 'dash_40yd');
  assert.equal(dash.tests_count, 1, 'the unshared testing day stays hidden');
  assert.equal(dash.best, 6.1);
  assert.ok(r.targets.some((t) => t.test === 'dash_40yd'));
  assert.equal((await dana('GET', `/portal/api/athletes/${ava.id}/report`)).status, 404);
  const info = (await maria('GET', '/portal/api/tests/dash_40yd')).body;
  assert.equal(info.key, 'dash_40yd');
  assert.ok(info.protocol, 'how it is tested');
  assert.equal((await maria('GET', '/portal/api/tests/not_a_test')).status, 404);
  // Home shows the next testing day too; Ben isn't on it.
  const me = (await maria('GET', '/portal/api/me')).body;
  assert.equal(me.athletes.find((a) => a.id === ava.id).next_testing_day.name, 'Winter retest');
  assert.equal(me.athletes.find((a) => a.id === ben.id).next_testing_day, null);
});

test('membership requests: the owner is emailed and decides; nothing about billing changes on its own', async () => {
  const sub = () => db().get(`SELECT status, plan_id FROM subscriptions WHERE client_id = ? AND status != 'canceled'`, ava.id);
  const before = sub();
  assert.equal((await maria('POST', `/portal/api/athletes/${ava.id}/membership-request`, { kind: 'constructor' })).status, 400);
  assert.equal((await maria('POST', `/portal/api/athletes/${ava.id}/membership-request`, { kind: 'pause', note: { x: 1 } })).status, 400);
  assert.equal((await maria('POST', `/portal/api/athletes/${ava.id}/membership-request`, { kind: 'switch', plan_id: plan.id })).status, 400, 'already on that plan');
  assert.equal((await maria('POST', `/portal/api/athletes/${ben.id}/membership-request`, { kind: 'pause' })).status, 409, 'Ben has no membership');
  assert.equal((await dana('POST', `/portal/api/athletes/${ava.id}/membership-request`, { kind: 'cancel' })).status, 404, 'another family can\'t ask');
  const made = await maria('POST', `/portal/api/athletes/${ava.id}/membership-request`, { kind: 'switch', plan_id: plan2.id, note: 'Wants more classes' });
  assert.equal(made.status, 201);
  assert.equal(made.body.request.kind, 'switch');
  assert.equal(made.body.request.plan_name, 'Unlimited');
  assert.deepEqual(sub(), before, 'the plan is unchanged');
  assert.ok(outbox().some((m) => m.to_email === 'owner@test.dev' && /switch/.test(m.subject) && m.body.includes('Wants more classes')));
  assert.equal((await maria('POST', `/portal/api/athletes/${ava.id}/membership-request`, { kind: 'cancel' })).status, 409, 'one open request per athlete');
  const [x, y] = await Promise.all([maria('POST', `/portal/api/athletes/${ava.id}/membership-request/withdraw`), maria('POST', `/portal/api/athletes/${ava.id}/membership-request/withdraw`)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const again = await maria('POST', `/portal/api/athletes/${ava.id}/membership-request`, { kind: 'pause' });
  assert.equal(again.status, 201);
  // Owner side: listed, shown per athlete, coaches can't see or answer.
  const list = (await owner('GET', '/v1/membership-requests')).body.data;
  assert.equal(list.length, 1);
  assert.equal(list[0].client_name, 'Ava Lopez');
  assert.equal(list[0].current_plan_name, 'Group membership');
  assert.equal((await owner('GET', `/v1/membership-requests?client_id=${ava.id}&status=all`)).body.data.length, 2);
  assert.equal((await coach('GET', '/v1/membership-requests')).status, 403);
  assert.equal((await coach('POST', `/v1/membership-requests/${list[0].id}/resolve`, { status: 'done' })).status, 403);
  // The owner pauses it by hand, then marks the request done: the parent is emailed and sees the answer.
  await owner('POST', `/v1/clients/${ava.id}/subscription/pause`);
  assert.equal((await owner('POST', `/v1/membership-requests/${list[0].id}/resolve`, { status: 'done', note: 'Paused until January.' })).body.status, 'done');
  assert.equal((await owner('POST', `/v1/membership-requests/${list[0].id}/resolve`, { status: 'declined' })).status, 409, 'answered once');
  assert.ok(outbox().some((m) => m.to_email === 'maria@example.com' && m.body.includes('Paused until January.')));
  const a = (await maria('GET', '/portal/api/me')).body.athletes.find((z) => z.id === ava.id);
  assert.equal(a.membership.status, 'paused');
  assert.equal(a.membership_answer.resolution_note, 'Paused until January.');
  assert.deepEqual(a.membership.can_ask, ['switch', 'cancel']);
  assert.match((await maria('POST', `/portal/api/athletes/${ava.id}/membership-request`, { kind: 'pause' })).body.error.message, /already paused/);
  await owner('POST', `/v1/clients/${ava.id}/subscription/resume`);
});

test('packs show their price a session and what they save', async () => {
  await owner('POST', '/v1/products', { name: 'Single private', kind: 'session', price_cents: 8000, credit_type: 'private' });
  await owner('POST', '/v1/products', { name: '5 privates', kind: 'pack', sessions: 5, price_cents: 37500, credit_type: 'private' });
  const store = (await maria('GET', '/portal/api/store')).body;
  const pack = store.products.find((p) => p.name === '5 privates');
  assert.equal(pack.per_session_cents, 7500);
  assert.equal(pack.saves_cents, 2500);
});

test('payments: sales with receipt links and membership payments, the total this year, and only the family\'s own', async () => {
  const sale = await createSale(app.ctx, { location_id: facility.id, method: 'card_on_file', client_id: ben.id, custom: { description: 'Drop-in', amount_cents: 2500 } });
  assert.equal(sale.status, 'succeeded');
  await createSale(app.ctx, { location_id: facility.id, method: 'card_on_file', client_id: cole.id, custom: { description: 'Cole drop-in', amount_cents: 1900 } });
  const p = (await maria('GET', '/portal/api/payments')).body;
  const s = p.data.find((x) => x.id === sale.id);
  assert.equal(s.description, 'Drop-in');
  assert.match(s.receipt_url, /^\/receipt\/[\w-]+$/);
  assert.equal((await req('GET', `/receipt-api/${s.receipt_url.split('/').pop()}`)).status, 200, 'the POS receipt page opens');
  const m = p.data.find((x) => x.kind === 'membership');
  assert.equal(m.amount_cents, 14900);
  assert.ok(!p.data.some((x) => x.description === 'Cole drop-in'));
  assert.ok(p.paid_this_year_cents >= 14900 + 2500);
  const receipt = (await maria('GET', `/portal/api/payments/membership/${m.id}`)).body;
  assert.equal(receipt.athlete_name, 'Ava Lopez');
  assert.equal(receipt.amount_cents, 14900);
  assert.equal((await dana('GET', `/portal/api/payments/membership/${m.id}`)).status, 404);
});

test('a declined membership payment: try again from the portal (up to 8 tries), and a new card retries it', async () => {
  await owner('POST', `/v1/clients/${cole.id}/subscription`, { plan_id: plan.id });
  db().run(`UPDATE families SET card_status = 'declining' WHERE id = ?`, cole.family.id);
  const inv = db().get(`SELECT id FROM invoices WHERE client_id = ? ORDER BY created_at DESC LIMIT 1`, cole.id);
  db().run(`UPDATE invoices SET status = 'failed', attempts = 1, last_error = 'Card declined' WHERE id = ?`, inv.id);
  db().run(`UPDATE subscriptions SET status = 'past_due' WHERE client_id = ?`, cole.id);
  let p = (await dana('GET', '/portal/api/payments')).body;
  assert.equal(p.declined.length, 1);
  assert.equal(p.declined[0].can_retry, true);
  assert.ok((await dana('GET', '/portal/api/me')).body.to_finish.some((x) => x.key === 'declined'));
  assert.equal((await maria('POST', `/portal/api/payments/${inv.id}/retry`)).status, 404, 'another family can\'t retry it');
  const again = (await dana('POST', `/portal/api/payments/${inv.id}/retry`)).body;
  assert.match(again.message, /declined again.*Nothing was charged/);
  assert.equal(db().get('SELECT status FROM subscriptions WHERE client_id = ?', cole.id).status, 'past_due', 'a retry never cancels the membership');
  db().run('UPDATE invoices SET attempts = 8 WHERE id = ?', inv.id);
  p = (await dana('GET', '/portal/api/payments')).body;
  assert.equal(p.declined[0].can_retry, false);
  assert.equal((await dana('POST', `/portal/api/payments/${inv.id}/retry`)).status, 409);
  // Removing the card is refused while the membership needs it.
  assert.match((await dana('DELETE', '/portal/api/card')).body.error.message, /membership is paid with this card/);
  db().run(`UPDATE families SET card_status = 'ok' WHERE id = ?`, cole.family.id);
  db().run('UPDATE invoices SET attempts = 2 WHERE id = ?', inv.id);
  assert.equal((await dana('POST', `/portal/api/payments/${inv.id}/retry`)).body.status, 'paid');
});

test('removing the card: asked on screen, refused with a membership, and the other parents are told', async () => {
  const bFam = (await owner('POST', '/v1/clients', { name: 'Eli Grant', birth_date: born(11), parent: { name: 'Sam Grant', email: 'sam@example.com' } })).body;
  await owner('POST', `/v1/families/${bFam.family.id}/guardians`, { name: 'Alex Grant', email: 'alex@example.com' });
  await addTestCard(app.ctx, bFam.id);
  const sam = await parent('sam@example.com');
  const gone = await sam('DELETE', '/portal/api/card');
  assert.equal(gone.status, 200);
  assert.equal(gone.body.on_file, false);
  assert.ok(outbox().some((m) => m.to_email === 'alex@example.com' && /card was removed/.test(m.subject)));
  assert.ok(!outbox().some((m) => m.to_email === 'sam@example.com' && /card was removed/.test(m.subject)), 'not the parent who did it');
  assert.equal((await sam('DELETE', '/portal/api/card')).status, 409);
  const out = await sam('POST', '/portal/api/card/test');
  assert.equal(out.body.last4, '4242');
  assert.ok(outbox().some((m) => m.to_email === 'alex@example.com' && /new card/.test(m.subject)));
});

test('parents: fix your own name and phone, add another parent (they get sign-in details, the others are told), at most 6', async () => {
  assert.equal((await maria('PATCH', '/portal/api/me', { email: 'x@example.com' })).status, 400);
  assert.equal((await maria('PATCH', '/portal/api/me', { phone: '555-0101' })).status, 400, 'needs the area code');
  const me = (await maria('PATCH', '/portal/api/me', { name: 'Maria L. Lopez', phone: '(512) 555-0102' })).body;
  assert.ok(me.family.guardians.some((g) => g.name === 'Maria L. Lopez' && g.phone === '(512) 555-0102'));
  assert.equal((await maria('POST', '/portal/api/guardians', { name: 'Dup', email: 'dana@example.com' })).status, 409, 'an email already on another account');
  const added = await maria('POST', '/portal/api/guardians', { name: 'Luis Lopez', email: 'luis@example.com', phone: '512-555-0103' });
  assert.equal(added.status, 201);
  assert.ok(outbox().some((m) => m.to_email === 'luis@example.com' && /Sign in to/.test(m.subject)));
  assert.equal((await (await parent('luis@example.com'))('GET', '/portal/api/me')).status, 200, 'the new parent can sign in');
  for (let i = 0; i < 4; i++) await maria('POST', '/portal/api/guardians', { name: `Extra ${i}`, email: `extra${i}@example.com` });
  assert.match((await maria('POST', '/portal/api/guardians', { name: 'Seventh', email: 'seventh@example.com' })).body.error.message, /up to 6 parents/);
});

test('athletes: no two with the same name in a family (renaming too), emergency phones need the area code', async () => {
  assert.match((await maria('POST', '/portal/api/athletes', { name: 'ava  lopez', birth_date: born(9) })).body.error.message, /already have an athlete named Ava Lopez/);
  assert.equal((await maria('PATCH', `/portal/api/athletes/${ben.id}`, { name: 'Ava Lopez' })).status, 409);
  assert.equal((await maria('PATCH', `/portal/api/athletes/${ben.id}`, { emergency_name: 'Grandma', emergency_phone: '555-0199' })).status, 400);
  assert.equal((await maria('PATCH', `/portal/api/athletes/${ben.id}`, { emergency_name: 'Grandma', emergency_phone: '(512) 555-0199' })).status, 200);
  assert.equal((await maria('PATCH', `/portal/api/athletes/${ben.id}`, { name: 'Ben Lopez' })).status, 200, 'keeping your own name is fine');
});

test('a copy of the signed waiver by email', async () => {
  const r = await maria('POST', '/portal/api/waiver/email');
  assert.equal(r.status, 200);
  const m = outbox().find((x) => x.to_email === 'maria@example.com' && /signed .*waiver/i.test(x.subject));
  assert.ok(m.body.includes('Ava Lopez') && m.body.includes('Ben Lopez'));
});
