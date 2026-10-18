// Membership visits (owner's ask): a plan carries the group classes it covers each month; every class booked or attended
// on the membership and every walk-in check-in uses one; once used up the membership stops covering until the month
// renews; cancel a booking and the visit comes back. Blank = unlimited, as before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { addTestCard } from '../src/services/commerce.js';
import { openDb } from '../src/db.js';
import { localDate, addDaysToDate } from '../src/util.js';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TZ = 'America/Chicago';
let app, base, owner, coach, facility, eight, unlimited, ava, ben;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const day = (n) => addDaysToDate(localDate(new Date().toISOString(), TZ), n);
// A group class n days out (within the current membership period when n is small; the test pins the period to cover them).
const klass = async (n, time = '10:00', extra = {}) => (await owner('POST', '/v1/sessions', { name: `Speed ${n} ${time}`, kind: 'group', location_id: facility.id, date: day(n), start_time: time, capacity: 10, ...extra })).body;
const book = (s, c, who = owner, body = {}) => who('POST', `/v1/sessions/${s.id}/bookings`, { client_id: c.id, ...body });
const visits = async (c) => (await owner('GET', `/v1/clients/${c.id}/visits`)).body;

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.test' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1'); coach = await signIn('coach@test.dev', 'coach-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ, billing_cycle: 'anniversary' });   // a month from today, so every class in the next 25 days is in the first period
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility' })).body;
  eight = (await owner('POST', '/v1/plans', { name: 'Two a month', price_cents: 9900, trial_days: 0, sessions_per_month: 2 })).body;
  unlimited = (await owner('POST', '/v1/plans', { name: 'Unlimited', price_cents: 14900, trial_days: 0, sessions_per_month: '' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  for (const c of [ava, ben]) { await addTestCard(app.ctx, c.id); app.ctx.db.run('UPDATE families SET waiver_version = 1 WHERE id = (SELECT family_id FROM clients WHERE id = ?)', c.id); }
});
after(() => app.server.close());

test('a plan carries its sessions a month; blank or 0 means unlimited; the limits hold', async () => {
  assert.equal(eight.sessions_per_month, 2);
  assert.equal(unlimited.sessions_per_month, null);
  assert.equal((await owner('POST', '/v1/plans', { name: 'Too many', price_cents: 100, sessions_per_month: 101 })).status, 400);
  assert.equal((await owner('PATCH', `/v1/plans/${unlimited.id}`, { sessions_per_month: 0 })).body.sessions_per_month, null);
  assert.equal((await owner('PATCH', `/v1/plans/${unlimited.id}`, { sessions_per_month: 12 })).body.sessions_per_month, 12);
  assert.equal((await owner('PATCH', `/v1/plans/${unlimited.id}`, { sessions_per_month: null })).body.sessions_per_month, null);
  assert.equal((await owner('GET', `/v1/plans/${eight.id}/quote`)).body.sessions_per_month, 2);
  assert.equal((await visits(ava)).visits, null, 'no membership yet');
});

test('the membership covers its two classes, then the third needs a pack, a card or pay at the session', async () => {
  const sub = await owner('POST', `/v1/clients/${ava.id}/subscription`, { plan_id: eight.id });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  const [s1, s2, s3] = [await klass(2), await klass(3), await klass(4)];
  assert.equal((await book(s1, ava)).body.coverage, 'membership');
  let v = await visits(ava);
  assert.deepEqual([v.visits.limit, v.visits.used, v.visits.left], [2, 1, 1]);
  assert.equal((await book(s2, ava)).body.coverage, 'membership');
  v = await visits(ava);
  assert.deepEqual([v.visits.used, v.visits.left, v.items.length], [2, 0, 2]);
  // The third: the owner books it, so it falls to pay at the session, with the reason.
  const third = await book(s3, ava);
  assert.equal(third.status, 201, JSON.stringify(third.body));
  assert.equal(third.body.coverage, 'unpaid');
  // A parent can't book a fourth without a pack or a card: the message says why.
  await owner('DELETE', `/v1/clients/${ava.id}/card`);
  const s4 = await klass(5);
  const parent = async (email) => { const { body } = await req('POST', '/portal/api/login', { email }); return as((await req('POST', '/portal/api/verify', { email, code: body.dev_code })).cookie); };
  const maria = await parent('maria@example.com');
  const r = await maria('POST', '/portal/api/bookings', { session_id: s4.id, athlete_id: ava.id });
  assert.equal(r.status, 402);
  assert.match(r.body.error.message, /used all 2 Two a month sessions for this month \(2 of 2 used; the count starts again on \d{4}-\d{2}-\d{2}\)/);
  assert.doesNotMatch(r.body.error.message, /with a membership/);
  // The client page says so too.
  const c = (await owner('GET', `/v1/clients/${ava.id}`)).body;
  assert.deepEqual([c.visits.limit, c.visits.used, c.visits.left], [2, 2, 0]);
  assert.equal(c.subscription.sessions_per_month, 2);
  // Cancel one and a visit comes back; the unpaid third stays unpaid (nothing re-decides a booking already made).
  const b1 = (await owner('GET', `/v1/sessions/${s1.id}`)).body.roster.find((b) => b.client_id === ava.id);
  assert.equal((await owner('POST', `/v1/bookings/${b1.id}/cancel`, {})).status, 200);
  v = await visits(ava);
  assert.deepEqual([v.visits.used, v.visits.left], [1, 1]);
  assert.equal((await book(s4, ava)).body.coverage, 'membership');
  // Attended still counts as used; a no-show gives the visit back.
  const b2 = (await owner('GET', `/v1/sessions/${s2.id}`)).body.roster.find((b) => b.client_id === ava.id);
  await owner('POST', `/v1/bookings/${b2.id}/attendance`, { status: 'attended' });
  assert.equal((await visits(ava)).visits.used, 2);
  await owner('POST', `/v1/bookings/${b2.id}/attendance`, { status: 'no_show' });
  assert.equal((await visits(ava)).visits.used, 1);
});

test('a walk-in check-in uses a visit, and is refused with the reason once they are used up', async () => {
  await owner('POST', `/v1/clients/${ben.id}/subscription`, { plan_id: eight.id });
  const one = await owner('POST', `/v1/clients/${ben.id}/check-ins`, { location_id: facility.id, credit_type: 'group' });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.equal(one.body.covered_by, 'membership');
  assert.deepEqual([one.body.visits.used, one.body.visits.left], [1, 1]);
  assert.equal((await owner('POST', `/v1/clients/${ben.id}/check-ins`, { location_id: facility.id, credit_type: 'group' })).body.visits.left, 0);
  const third = await owner('POST', `/v1/clients/${ben.id}/check-ins`, { location_id: facility.id, credit_type: 'group' });
  assert.equal(third.status, 409);
  assert.match(third.body.error.message, /Ben has used all 2 Two a month sessions for this month \(2 of 2\)\. Sell a session or pack/);
  // With a pack, the check-in uses a credit instead.
  await owner('POST', `/v1/clients/${ben.id}/credits`, { credit_type: 'group', delta: 1, reason: 'Gift' });
  const fourth = await owner('POST', `/v1/clients/${ben.id}/check-ins`, { location_id: facility.id, credit_type: 'group' });
  assert.equal(fourth.status, 201, JSON.stringify(fourth.body));
  assert.equal(fourth.body.covered_by, 'credit');
  const list = await visits(ben);
  assert.equal(list.items.filter((i) => i.kind === 'walk_in').length, 2);
  // The portal's membership panel carries the count.
  const parent = async (email) => { const { body } = await req('POST', '/portal/api/login', { email }); return as((await req('POST', '/portal/api/verify', { email, code: body.dev_code })).cookie); };
  const dana = await parent('dana@example.com');
  const home = (await dana('GET', '/portal/api/me')).body;
  const athlete = home.athletes.find((a) => a.id === ben.id);
  assert.deepEqual([athlete.membership.visits.limit, athlete.membership.visits.used, athlete.membership.visits.left], [2, 2, 0]);
});

test('a class in the next month counts against that month, and an unlimited plan never runs out', async () => {
  const far = await klass(40);                                  // past this membership month
  assert.equal((await book(far, ava)).body.coverage, 'membership', 'next month has its own count');
  assert.equal((await visits(ava)).visits.used, 1, 'this month unchanged');
  const cole = (await owner('POST', '/v1/clients', { name: 'Cole Jensen', email: 'cole@example.com' })).body;
  await addTestCard(app.ctx, cole.id);
  await owner('POST', `/v1/clients/${cole.id}/subscription`, { plan_id: unlimited.id });
  for (const n of [2, 3, 4, 5]) assert.equal((await book(await klass(n, '12:00'), cole)).body.coverage, 'membership');
  const v = await visits(cole);
  assert.deepEqual([v.visits.limit, v.visits.left, v.visits.used], [null, null, 4]);
});

test('the version 85 upgrade adds the column and leaves existing plans unlimited', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-v85-')), file = join(dir, 'dp.db');
  const raw = new DatabaseSync(file);
  raw.exec(readFileSync('test/fixtures/schema-v85.sql', 'utf8'));
  raw.exec("INSERT INTO plans (id, name, price_cents, interval, trial_days, active, created_at) VALUES ('plan_old', 'Old plan', 1000, 'month', 0, 1, '2026-01-01T00:00:00.000Z')");
  raw.exec('PRAGMA user_version = 85');
  raw.close();
  const db = openDb(file);
  assert.equal(db.get('PRAGMA user_version').user_version, 89);
  assert.equal(db.get("SELECT sessions_per_month FROM plans WHERE id = 'plan_old'").sessions_per_month, null);
  db.close();
});

test('what\'s left of a month is lost unless the owner carries it over; carried sessions add to next month\'s count', async () => {
  // Ben used both of this month's sessions. The owner agrees to carry one into next month; coaches can't.
  const denied = await coach('POST', `/v1/clients/${ben.id}/visits/carry-over`, { sessions: 1 });
  assert.equal(denied.status, 403);
  const bad = await owner('POST', `/v1/clients/${ben.id}/visits/carry-over`, { sessions: 0 });
  assert.equal(bad.status, 400);
  const carried = await owner('POST', `/v1/clients/${ben.id}/visits/carry-over`, { sessions: 1, note: 'Away for the holidays' });
  assert.equal(carried.status, 200, JSON.stringify(carried.body));
  const now = await visits(ben);
  assert.deepEqual([now.visits.limit, now.visits.carried, now.visits.left], [2, 0, 0], 'this month is unchanged');
  assert.equal(carried.body.period_start, now.visits.period_end, 'it lands on the next paid period');
  assert.deepEqual([carried.body.visits.limit, carried.body.visits.base_limit, carried.body.visits.carried, carried.body.visits.left], [3, 2, 1, 3]);
  assert.deepEqual(now.carryovers.map((k) => [k.sessions, k.note, k.by_name]), [[1, 'Away for the holidays', 'Olivia Owner']]);
  // A class in that month: the carried session makes three.
  const next = [await klass(40, '09:00'), await klass(41, '09:00'), await klass(42, '09:00')];
  for (const s of next) assert.equal((await book(s, ben)).body.coverage, 'membership', 'the carried session covers a third class');
  const page = (await owner('GET', `/v1/clients/${ben.id}`)).body;
  assert.equal(page.visit_carryovers.length, 1);
  const ev = app.ctx.db.get(`SELECT data FROM events WHERE type = 'visits.carried_over' ORDER BY rowid DESC LIMIT 1`);
  assert.equal(JSON.parse(ev.data).sessions, 1);
  // Taken back: the third class is over the count again (it stays booked; the count just shows it).
  const gone = await owner('DELETE', `/v1/visit-carryovers/${carried.body.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal((await owner('GET', `/v1/clients/${ben.id}`)).body.visit_carryovers.length, 0);
  // An unlimited plan has nothing to carry; carrying into the month running now is allowed too.
  const cole = app.ctx.db.get(`SELECT c.id FROM clients c JOIN subscriptions s ON s.client_id = c.id JOIN plans p ON p.id = s.plan_id WHERE p.sessions_per_month IS NULL AND s.status = 'active' LIMIT 1`);
  assert.equal((await owner('POST', `/v1/clients/${cole.id}/visits/carry-over`, { sessions: 1 })).status, 409);
  const cur = await owner('POST', `/v1/clients/${ben.id}/visits/carry-over`, { sessions: 2, period: 'current' });
  assert.deepEqual([cur.status, cur.body.visits.limit, cur.body.visits.left], [200, 4, 2]);
});
