// Today batch B3: the check-in list with door alerts, session states, birthdays this week, follow-ups that hide an at-risk
// athlete or a rough check-in for a while (with who did it, Undo and Bring back), and the activity feed with filters and
// pages, where coaches and front desk never see money.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDaysToDate, localDate, newId } from '../src/util.js';
import { emit } from '../src/services/events.js';
import { atRisk } from '../src/services/insights.js';

let app, base, owner, coach, desk, facility, ava, ben, cora, dev;
// Sessions are placed from 2 hours ago to 2 hours ahead, so the business day must have room on both sides: use a time
// zone where it's between 3 am and 9 pm right now (Chicago most of the time), or the test fails late at night.
const hourIn = (tz) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const TZ = ['America/Chicago', 'Europe/London', 'Asia/Tokyo', 'Pacific/Honolulu'].find((tz) => hourIn(tz) >= 3 && hourIn(tz) < 21);
const DAY = 86400000;

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const today = () => localDate(new Date().toISOString(), TZ);
// A session relative to now, in minutes, with bookings.
function session(name, startMin, durMin, bookings) {
  const id = newId('cls'), at = new Date(Date.now() + startMin * 60000).toISOString(), end = new Date(Date.now() + (startMin + durMin) * 60000).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, ?, 'group', ?, ?, ?, 10, 'scheduled', ?)`, id, name, facility.id, at, end, at);
  for (const [clientId, status = 'booked', coverage = 'membership'] of bookings) app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, newId('bkg'), id, clientId, status, coverage, at, at);
  return id;
}

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  coach = await signIn('coach@test.dev', 'coach-password-1');
  desk = await signIn('desk@test.dev', 'desk-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  const bday = (n) => `2012-${addDaysToDate(today(), n).slice(5)}`;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: bday(0), medical_notes: 'Peanut allergy', parent: { name: 'Maria Lopez', email: 'maria@example.com', phone: '5125550101' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', birth_date: bday(3), parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  cora = (await owner('POST', '/v1/clients', { name: 'Cora Diaz', birth_date: bday(9), parent: { name: 'Luz Diaz', email: 'luz@example.com' } })).body;
  dev = (await owner('POST', '/v1/clients', { name: 'Dev Shah', birth_date: bday(1), parent: { name: 'Raj Shah', email: 'raj@example.com' } })).body;
});
after(() => app.server.close());

test('the check-in list puts who is still to arrive first, flags what the door should know, and never shows money', async () => {
  // Signed waivers for everyone but Ben's family.
  for (const c of [ava, cora, dev]) app.ctx.db.run('UPDATE families SET waiver_version = ? WHERE id = ?', Number(app.ctx.db.get(`SELECT value FROM settings WHERE key = 'waiver_version'`)?.value ?? 1), c.family.id);
  const done = session('Early group', -120, 60, [[dev.id, 'booked']]);
  const live = session('Speed', -10, 60, [[ava.id, 'booked', 'unpaid'], [cora.id, 'attended']]);
  const later = session('Power', 60, 60, [[ben.id, 'booked']]);
  app.ctx.db.run('INSERT INTO daily_checkins (id, client_id, date, sleep_hours, created_at, updated_at) VALUES (?, ?, ?, 4, ?, ?)', newId('dc'), ava.id, today(), app.ctx.now(), app.ctx.now());
  const t = (await desk('GET', '/v1/today')).body;
  assert.equal(t.date, today());
  const state = Object.fromEntries(t.sessions.filter((s) => [done, live, later].includes(s.id)).map((s) => [s.name, s.state]));
  assert.deepEqual(state, { 'Early group': 'done', Speed: 'live', Power: 'next' });
  const order = t.arrivals.map((a) => a.name);
  assert.deepEqual(order, ['Ava Lopez', 'Ben Park', 'Dev Shah', 'Cora Diaz'], 'still to arrive, then the no-show from a finished session, then checked in');
  const a = t.arrivals[0];
  assert.equal(a.medical, 'Peanut allergy');
  assert.equal(a.unpaid, true);
  assert.equal(a.birthday, true);
  assert.deepEqual(a.flags, ['Slept 4 hours']);
  assert.equal(t.arrivals.find((x) => x.name === 'Ben Park').no_waiver, true);
  assert.equal(t.arrivals.find((x) => x.name === 'Ava Lopez').no_waiver, false);
  assert.equal(JSON.stringify(t).includes('_cents'), false);
  assert.equal(t.follow_ups, undefined, 'front desk gets no follow-ups');
  // The check-in flag says Ava trains today.
  assert.equal(t.flags.find((f) => f.client_id === ava.id).session.name, 'Speed');
  // Check in, then Undo.
  const bk = a.booking_id;
  assert.equal((await desk('POST', `/v1/bookings/${bk}/attendance`, { status: 'attended' })).body.status, 'attended');
  assert.equal((await desk('GET', '/v1/today')).body.arrivals.find((x) => x.booking_id === bk).status, 'attended');
  assert.equal((await desk('POST', `/v1/bookings/${bk}/attendance`, { status: 'booked' })).body.status, 'booked');
  // Birthdays: this week only, soonest first; today's is marked.
  const b = t.birthdays.map((x) => [x.name, x.today]);
  assert.deepEqual(b.filter(([n]) => ['Ava Lopez', 'Ben Park', 'Cora Diaz', 'Dev Shah'].includes(n)), [['Ava Lopez', true], ['Dev Shah', false], ['Ben Park', false]]);
  assert.equal(t.birthdays.find((x) => x.name === 'Ava Lopez').turning, Number(today().slice(0, 4)) - 2012);
  // Archived athletes have no birthday line.
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), dev.id);
  assert.ok(!(await coach('GET', '/v1/today')).body.birthdays.some((x) => x.name === 'Dev Shah'));
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', dev.id);
});

test('follow-ups hide an athlete to check on from everyone for a while, say who did it, and can be undone', async () => {
  // Eli came twice a week for six weeks, then stopped.
  const eli = (await owner('POST', '/v1/clients', { name: 'Eli Stone', parent: { name: 'Kim Stone', email: 'kim@example.com' } })).body;
  for (let d = 15; d <= 55; d += 3.5) {
    const id = newId('cls'), at = new Date(Date.now() - d * DAY).toISOString();
    app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Old', 'group', ?, ?, ?, 10, 'scheduled', ?)`, id, facility.id, at, at, at);
    app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'attended', 'membership', ?, ?)`, newId('bkg'), id, eli.id, at, at);
  }
  let t = (await coach('GET', '/v1/today')).body;
  const item = t.follow_ups.find((x) => x.client_id === eli.id);
  assert.ok(item, 'Eli is someone to check on');
  assert.equal(item.key, `risk:${eli.id}`);
  assert.equal((await desk('POST', '/v1/today/follow-ups', { key: item.key })).status, 403, 'front desk can\'t follow up');
  // Bad keys and days are refused.
  assert.equal((await coach('POST', '/v1/today/follow-ups', { key: 'flag:1:2026-13-45' })).status, 400);
  assert.equal((await coach('POST', '/v1/today/follow-ups', { key: `flag:${ava.id}:${addDaysToDate(today(), -5)}` })).status, 400);
  assert.equal((await coach('POST', '/v1/today/follow-ups', { key: item.key, days: true })).status, 400);
  assert.equal((await coach('POST', '/v1/today/follow-ups', { key: item.key, days: 61 })).status, 400);
  assert.equal((await coach('POST', '/v1/today/follow-ups', { key: 'risk:cli_nope' })).status, 404);
  const r = (await coach('POST', '/v1/today/follow-ups', { key: item.key, action: 'reached_out', note: 'Texted mom' })).body;
  assert.equal(r.until, addDaysToDate(today(), 6));
  assert.match(r.message, /^Reached out: Eli Stone\. Back on Today/);
  // Hidden for the owner too, and listed as followed up with who did it.
  t = (await owner('GET', '/v1/today')).body;
  assert.ok(!t.follow_ups.some((x) => x.client_id === eli.id));
  const f = t.followed_up.find((x) => x.client_id === eli.id);
  assert.deepEqual([f.label, f.created_by, f.note], ['Reached out', 'Carl Coach', 'Texted mom']);
  // The Monday summary still counts her; Today doesn't.
  assert.ok(atRisk(app.ctx).some((x) => x.client_id === eli.id));
  // A second press replaces the first rather than stacking.
  await coach('POST', '/v1/today/follow-ups', { key: item.key, days: 3 });
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM today_snoozes WHERE key = ?', item.key).n, 1);
  // Bring back.
  const id = (await owner('GET', '/v1/today')).body.followed_up.find((x) => x.client_id === eli.id).id;
  assert.match((await owner('DELETE', `/v1/today/follow-ups/${id}`)).body.message, /Eli Stone is back on Today/);
  assert.ok((await owner('GET', '/v1/today')).body.follow_ups.some((x) => x.client_id === eli.id));
  // A rough check-in marked reviewed stays off through the next day.
  const flagKey = `flag:${ava.id}:${today()}`;
  const rv = (await coach('POST', '/v1/today/follow-ups', { key: flagKey })).body;
  assert.equal(rv.until, addDaysToDate(today(), 1));
  assert.equal(rv.message, 'Marked Ava Lopez\'s check-in as reviewed.');
  assert.ok(!(await coach('GET', '/v1/today')).body.flags.some((x) => x.key === flagKey));
});

test('recent activity: newest first, a page at a time, with filters; coaches and front desk never see money', async () => {
  for (let i = 0; i < 25; i++) emit(app.ctx, 'session.checked_in', { booking_id: `b${i}`, client_name: `Athlete ${i}`, location_name: 'Facility' });
  emit(app.ctx, 'invoice.paid', { client_name: 'Ava Lopez', amount_cents: 15000 });
  emit(app.ctx, 'sale.completed', { client_name: 'Ben Park', amount_cents: 2500, method: 'cash', location_name: 'Facility' });
  const first = (await coach('GET', '/v1/activity?filter=checkins')).body;
  assert.equal(first.data.length, 20);
  assert.ok(first.data.every((e) => e.type === 'session.checked_in'));
  assert.equal(first.data[0].data.client_name, 'Athlete 24');
  const second = (await coach('GET', `/v1/activity?filter=checkins&before=${encodeURIComponent(first.next)}`)).body;
  assert.ok(second.data.length >= 5);
  assert.equal(second.data[0].data.client_name, 'Athlete 4');
  assert.equal(new Set([...first.data, ...second.data].map((e) => e.id)).size, first.data.length + second.data.length, 'no repeats across pages');
  const all = (await coach('GET', '/v1/activity?limit=100')).body;
  assert.ok(!all.data.some((e) => e.type === 'invoice.paid'), 'owner-only events stay with the owner');
  assert.equal(all.data.find((e) => e.type === 'sale.completed').data.amount_cents, undefined, 'no amounts for coaches');
  assert.ok(!all.filters.includes('money'));
  assert.equal((await desk('GET', '/v1/activity?filter=money')).status, 400);
  assert.equal((await coach('GET', '/v1/activity?filter=nope')).status, 400);
  const money = (await owner('GET', '/v1/activity?filter=money')).body;
  assert.deepEqual(money.data.map((e) => e.type).slice(0, 2), ['sale.completed', 'invoice.paid']);
  assert.equal(money.data[0].data.amount_cents, 2500);
});
