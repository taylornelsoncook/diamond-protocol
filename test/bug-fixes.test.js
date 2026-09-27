// Fixes carried over from the earlier version of the platform: coaches never see money, one business day
// everywhere, privates free their time when canceled and only block what they overlap, parents read messages
// for themselves, front desk isn't sent to a page it can't open, team attendance counts from the day an athlete
// joined, and the client address behind the hosting proxy can't be faked.
process.env.TZ = 'Asia/Tokyo';            // the server's clock runs in a different zone from the business (America/Chicago)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser, dashboard } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { newId, addDaysToDate, localDate, zonedToUtc, weekdayOf, startOfLocalDay } from '../src/util.js';
import { bookSlot } from '../src/services/schedule.js';

let app, base, owner, coach, desk, maria, facility, park, ava, cole, coachId;
const TZ = 'America/Chicago';

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const moneyKeys = (o, out = new Set(), path = '') => {
  if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { if (/_cents$/.test(k) && x != null) out.add(`${path}.${k}`); moneyKeys(x, out, Array.isArray(o) ? `${path}[]` : `${path}.${k}`); }
  return out;
};

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  coachId = createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' }).id;
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  coach = await signIn('coach@test.dev', 'coach-password-1');
  desk = await signIn('desk@test.dev', 'desk-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  park = (await owner('POST', '/v1/locations', { name: 'Zilker Park', kind: 'park' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2013-03-10', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  cole = (await owner('POST', '/v1/clients', { name: 'Cole Park', birth_date: '2011-09-22', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  const { body } = await req('POST', '/portal/api/login', { email: 'maria@example.com' });
  maria = as((await req('POST', '/portal/api/verify', { email: 'maria@example.com', code: body.dev_code })).cookie);
});
after(() => app.server.close());

test('coaches never see money: sales, schedule and session prices, availability, activity, client billing', async () => {
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 9900 })).body;
  await owner('POST', `/v1/clients/${ava.id}/card/test`);
  await owner('POST', `/v1/clients/${ava.id}/subscription`, { plan_id: plan.id });
  const tomorrow = addDaysToDate(localDate(new Date().toISOString(), TZ), 1);
  await owner('POST', '/v1/class-series', { name: 'Speed', kind: 'group', location_id: facility.id, weekdays: [weekdayOf(tomorrow)], start_time: '17:00', duration_min: 60, capacity: 10, drop_in_cents: 2500, registration_cents: 20000, start_date: tomorrow });
  const one = (await owner('POST', '/v1/sessions', { name: 'Clinic', kind: 'clinic', location_id: facility.id, date: tomorrow, start_time: '09:00', drop_in_cents: 3000 })).body;
  await owner('POST', '/v1/availability', { kind: 'private', location_id: park.id, weekday: weekdayOf(tomorrow), start_time: '12:00', end_time: '14:00', slot_minutes: 60, price_cents: 8000 });
  const ownerSale = (await owner('POST', '/v1/sales', { location_id: facility.id, method: 'cash', client_id: ava.id, custom: { description: 'Owner sale', amount_cents: 12300 } })).body;
  const coachSale = (await coach('POST', '/v1/sales', { location_id: facility.id, method: 'cash', custom: { description: 'Coach sale', amount_cents: 4500 } })).body;
  assert.equal(coachSale.amount_cents, 4500, 'the coach taking a payment still sees what they charged');

  // Coaches see only the sales they took themselves.
  const sales = (await coach('GET', '/v1/sales')).body.data;
  assert.deepEqual(sales.map((s) => s.id), [coachSale.id]);
  assert.equal((await coach('GET', `/v1/sales/${ownerSale.id}`)).status, 404);
  assert.equal((await coach('GET', `/v1/sales/${coachSale.id}`)).body.amount_cents, 4500);
  assert.equal((await owner('GET', '/v1/sales')).body.data.length, 2, 'owners see every sale');
  assert.equal((await desk('GET', '/v1/sales')).body.data.length, 2, 'front desk closes out the drawer');

  const leaks = {};
  for (const p of ['/v1/schedule', '/v1/class-series', `/v1/sessions/${one.id}`, `/v1/agenda?date=${tomorrow}`, '/v1/availability', '/v1/slots', '/v1/events', '/v1/dashboard',
    '/v1/clients', `/v1/clients/${ava.id}`, `/v1/clients/${ava.id}/invoices`, `/v1/families/${ava.family.id}`]) {
    const r = await coach('GET', p);
    assert.equal(r.status, 200, p);
    const keys = [...moneyKeys(r.body)];
    if (keys.length) leaks[p] = keys;
  }
  assert.deepEqual(leaks, {});
  assert.ok((await coach('GET', `/v1/sessions/${one.id}`)).body.roster, 'the rest of the response is untouched');
  // Front desk collects at the counter, so it keeps sales, the session it is collecting for and open slots; not memberships or class lists.
  const deskLeaks = {};
  for (const p of ['/v1/schedule', '/v1/class-series', '/v1/availability', '/v1/events', '/v1/dashboard', '/v1/clients', `/v1/clients/${ava.id}`, `/v1/clients/${ava.id}/invoices`, `/v1/families/${ava.family.id}`, '/v1/programs']) {
    const keys = [...moneyKeys((await desk('GET', p)).body)];
    if (keys.length) deskLeaks[p] = keys;
  }
  assert.deepEqual(deskLeaks, {});
  assert.equal((await desk('GET', `/v1/sessions/${one.id}`)).body.drop_in_cents, 3000);
  assert.ok((await coach('GET', '/v1/events')).body.data.every((e) => !/^(invoice|subscription|team_invoice|sale\.refunded)/.test(e.type)), 'membership and refund events stay with the owner');
  assert.ok((await desk('GET', '/v1/events')).body.data.every((e) => !/^(invoice|subscription|team_invoice|sale\.refunded)/.test(e.type)));
  // What the counter needs to sell is still there.
  assert.equal((await coach('GET', '/v1/plans')).body.data[0].price_cents, 9900);
  // Owners still see everything.
  assert.equal((await owner('GET', `/v1/sessions/${one.id}`)).body.drop_in_cents, 3000);
  assert.ok((await owner('GET', '/v1/events')).body.data.some((e) => e.data.amount_cents));
});

test('today\'s takings start at midnight in the business\'s time zone, not the server\'s', () => {
  const ctx = { ...app.ctx, now: () => '2026-10-06T16:00:00.000Z' };      // 11am in Chicago, 1am the next day in Tokyo
  const loc = facility.id;
  const add = (at, cents) => app.ctx.db.run(`INSERT INTO sales (id, location_id, method, status, amount_cents, created_at, completed_at) VALUES (?, ?, 'cash', 'succeeded', ?, ?, ?)`, newId('sale'), loc, cents, at, at);
  const before = dashboard(ctx).today_sales;
  add('2026-10-06T10:00:00.000Z', 700);        // 5am Chicago on the 6th: today
  add('2026-10-06T04:00:00.000Z', 1100);       // 11pm Chicago on the 5th: yesterday
  const after = dashboard(ctx).today_sales;
  assert.equal(after.cents - before.cents, 700);
  assert.equal(after.n - before.n, 1);
  app.ctx.db.run(`DELETE FROM sales WHERE created_at LIKE '2026-10-06%'`);
});

test('canceling a private frees its time, and only overlapping sessions at the same place block private hours', async () => {
  const day = addDaysToDate(localDate(new Date().toISOString(), TZ), 3);
  const av = (await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: weekdayOf(day), start_time: '06:00', end_time: '09:00', slot_minutes: 60 })).body;
  const slots = async () => (await owner('GET', '/v1/slots?days=5')).body.data.filter((s) => s.availability_id === av.id && localDate(s.starts_at, TZ) === day).map((s) => s.starts_at);
  const six = zonedToUtc(day, '06:00', TZ), seven = zonedToUtc(day, '07:00', TZ), eight = zonedToUtc(day, '08:00', TZ);
  assert.deepEqual(await slots(), [six, seven, eight]);

  // A team session somewhere else at the same time doesn't take the facility's private hours.
  await owner('POST', '/v1/sessions', { name: 'Away session', kind: 'team', location_id: park.id, date: day, start_time: '06:00', duration_min: 60 });
  assert.deepEqual(await slots(), [six, seven, eight]);
  // A class at the facility blocks only the hour it overlaps.
  await owner('POST', '/v1/sessions', { name: 'Early group', kind: 'group', location_id: facility.id, date: day, start_time: '07:15', duration_min: 30 });
  assert.deepEqual(await slots(), [six, eight]);

  // Book a private at 6, then cancel it: the hour opens again, and the empty session is off the schedule.
  const b = (await owner('POST', '/v1/slots/book', { kind: 'private', starts_at: six, availability_id: av.id, client_id: cole.id })).body;
  assert.deepEqual(await slots(), [eight]);
  await owner('POST', `/v1/bookings/${b.id}/cancel`, { waive: true });
  assert.deepEqual(await slots(), [six, eight]);
  assert.equal(app.ctx.db.get('SELECT status FROM class_sessions WHERE id = ?', b.session_id).status, 'canceled');
  // A private left empty some other way doesn't block the hour either.
  const again = (await owner('POST', '/v1/slots/book', { kind: 'private', starts_at: six, availability_id: av.id, client_id: cole.id })).body;
  app.ctx.db.run(`UPDATE bookings SET status = 'canceled' WHERE id = ?`, again.id);
  assert.deepEqual(await slots(), [six, eight]);
});

test('a parent reading coach messages doesn\'t mark them read for the athlete', async () => {
  await coach('POST', `/v1/clients/${ava.id}/messages`, { body: 'Great sprint work.' });
  const token = ava.app_link.split('token=')[1];
  const athlete = async () => (await req('GET', '/app/api/engage', null, { 'x-client-token': token })).body.accountability;
  const parentView = async () => (await maria('GET', `/portal/api/athletes/${ava.id}/engage`)).body.accountability;
  assert.equal((await athlete()).unread, 1);
  assert.equal((await parentView()).unread, 1);
  assert.equal((await maria('POST', `/portal/api/athletes/${ava.id}/messages/read`)).body.read, 1);
  assert.equal((await parentView()).unread, 0, 'the parent has read it');
  assert.equal((await maria('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).engagement.unread, 0);
  assert.equal((await athlete()).unread, 1, 'the athlete still has it waiting');
  await req('POST', '/app/api/messages/read', null, { 'x-client-token': token });
  assert.equal((await athlete()).unread, 0);
});

test('front desk isn\'t offered a link to the results queue it can\'t open', async () => {
  app.ctx.db.run(`INSERT INTO results_queue (id, provider, source, identity, athlete_ref, item, status, received_at) VALUES (?, 'generic', 'csv:test', 'Mystery Kid', '{"name":"Mystery Kid"}', '{}', 'pending', ?)`, newId('q'), new Date().toISOString());
  const waiting = async (who) => (await who('GET', '/v1/dashboard')).body.attention.find((a) => a.kind === 'results_waiting');
  assert.equal((await waiting(desk)).can_link, false);
  assert.equal((await desk('GET', '/v1/queue')).status, 403);
  assert.equal((await waiting(coach)).can_link, true);
  assert.equal((await waiting(owner)).can_link, true);
});

test('team attendance counts only sessions since the athlete joined the roster', async () => {
  const contract = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Westlake HS' }, name: 'Varsity', monthly_cents: 100000 })).body;
  const series = (await owner('POST', `/v1/team-contracts/${contract.id}/sessions`, { location_id: park.id, weekdays: [1], start_time: '16:00', duration_min: 60, start_date: addDaysToDate(localDate(new Date().toISOString(), TZ), 1) })).body;
  await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { names: 'Early Bird\nLate Comer' });
  const roster = (await owner('GET', `/v1/team-contracts/${contract.id}`)).body.roster;
  const early = roster.find((r) => r.name === 'Early Bird'), late = roster.find((r) => r.name === 'Late Comer');
  const today = localDate(new Date().toISOString(), TZ);
  const past = [-20, -13, -6].map((n) => { const id = newId('cls'), at = zonedToUtc(addDaysToDate(today, n), '16:00', TZ);
    app.ctx.db.run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, ?, 'Varsity', 'team', ?, ?, ?, 20, 'scheduled', ?)`, id, series.id, park.id, at, new Date(Date.parse(at) + 3600000).toISOString(), at);
    return id; });
  app.ctx.db.run('UPDATE team_roster SET created_at = ? WHERE id = ?', zonedToUtc(addDaysToDate(today, -30), '09:00', TZ), early.id);
  app.ctx.db.run('UPDATE team_roster SET created_at = ? WHERE id = ?', zonedToUtc(addDaysToDate(today, -8), '09:00', TZ), late.id);
  for (const s of past) await owner('POST', `/v1/sessions/${s}/team-attendance`, { roster_id: early.id, present: true });
  await owner('POST', `/v1/sessions/${past[2]}/team-attendance`, { roster_id: late.id, present: true });
  const c = (await owner('GET', `/v1/team-contracts/${contract.id}`)).body;
  assert.equal(c.sessions_held, 3);
  const row = (id) => c.roster.find((r) => r.id === id);
  assert.deepEqual([row(early.id).sessions_attended, row(early.id).sessions_held], [3, 3]);
  assert.deepEqual([row(late.id).sessions_attended, row(late.id).sessions_held], [1, 1], 'sessions before they joined don\'t count against them');
});

test('behind one hosting proxy the client address is the one the proxy saw, and enquiries have an overall cap', async () => {
  resetRateLimits();
  process.env.TRUST_PROXY = 'true';
  try {
    const ask = (xff, n) => req('POST', '/portal/api/public/inquiry', { parent_name: `Pat ${n}`, email: `pat${n}@example.com`, athlete_name: 'Sam' }, { 'x-forwarded-for': xff });
    // The first entry is whatever the sender wrote; the proxy appends the real address last.
    for (let i = 0; i < 10; i++) assert.equal((await ask(`10.0.0.${i}, 203.0.113.7`, i)).status, 200, `enquiry ${i}`);
    assert.equal((await ask('10.0.1.1, 203.0.113.7', 10)).status, 429, 'a made-up first address doesn\'t dodge the limit');
    // Many real addresses: the overall cap still stops a flood.
    let last;
    for (let i = 0; i < 60; i++) last = await ask(`198.51.100.${i}`, 100 + i);
    assert.equal(last.status, 429);
    // More than one proxy in front can be configured.
    resetRateLimits();
    process.env.TRUST_PROXY = '2';
    for (let i = 0; i < 10; i++) await ask(`1.1.1.${i}, 203.0.113.9, 10.9.9.9`, 200 + i);
    assert.equal((await ask('1.1.2.1, 203.0.113.9, 10.9.9.9', 300)).status, 429);
  } finally { delete process.env.TRUST_PROXY; resetRateLimits(); }
});

test('saving as a coach or front desk doesn\'t hand back amounts either, but collecting for a booking still shows what was taken', async () => {
  const plan = (await owner('POST', '/v1/plans', { name: 'Saver', price_cents: 5900 })).body;
  await owner('POST', `/v1/clients/${cole.id}/card/test`);
  await owner('POST', `/v1/clients/${cole.id}/subscription`, { plan_id: plan.id });
  for (const who of [coach, desk]) {
    const r = await who('PATCH', `/v1/clients/${cole.id}`, { notes: 'Left knee is fine now' });
    assert.equal(r.status, 200);
    assert.deepEqual([...moneyKeys(r.body)], []);
  }
  assert.equal((await owner('PATCH', `/v1/clients/${cole.id}`, { notes: 'x' })).body.subscription.price_cents, 5900);
  // The roster "collect" button and the iPhone app read the amount on the sale.
  const day = addDaysToDate(localDate(new Date().toISOString(), TZ), 2);
  const s = (await owner('POST', '/v1/sessions', { name: 'Drop-in speed', kind: 'clinic', location_id: facility.id, date: day, start_time: '10:00', drop_in_cents: 2000 })).body;
  const b = (await coach('POST', `/v1/sessions/${s.id}/bookings`, { client_id: ava.id })).body;
  assert.equal(b.coverage, 'unpaid');
  const paid = (await coach('POST', `/v1/bookings/${b.id}/pay`, { method: 'cash' })).body;
  assert.equal(paid.sale.amount_cents, 2000);
});

test('two families booking the same open private hour at once: only one gets it', async () => {
  const day = addDaysToDate(localDate(new Date().toISOString(), TZ), 5);
  const av = (await owner('POST', '/v1/availability', { kind: 'private', location_id: park.id, weekday: weekdayOf(day), start_time: '19:00', end_time: '20:00', slot_minutes: 60 })).body;
  const at = zonedToUtc(day, '19:00', TZ);
  // The second request arrives while the first is still charging the card (before its booking is saved).
  const results = await Promise.allSettled([ava, cole].map((c) => bookSlot(app.ctx, { kind: 'private', startsAt: at, availabilityId: av.id, clientId: c.id, isCoach: true })));
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM class_sessions WHERE starts_at = ? AND location_id = ? AND status = 'scheduled'`, at, park.id).n, 1);
});

test('the business day starts at the right moment across daylight saving, even where midnight is skipped', () => {
  assert.equal(startOfLocalDay('2026-03-08T12:00:00Z', 'America/Denver'), '2026-03-08T07:00:00.000Z');
  assert.equal(startOfLocalDay('2026-11-02T06:30:00Z', 'America/Denver'), '2026-11-01T06:00:00.000Z');   // 11:30pm on Nov 1 in Denver
  assert.equal(startOfLocalDay('2026-10-06T16:00:00Z', 'Asia/Tokyo'), '2026-10-06T15:00:00.000Z');
  assert.equal(startOfLocalDay('2026-09-06T12:00:00Z', 'America/Santiago'), '2026-09-06T04:00:00.000Z');  // clocks go from 00:00 to 01:00
});

test('removing a parent who has read coach messages clears their read state', async () => {
  const fam = (await owner('GET', `/v1/families/${ava.family.id}`)).body;
  await owner('POST', `/v1/families/${fam.id}/guardians`, { name: 'Luis Lopez', email: 'luis@example.com' });
  const { body } = await req('POST', '/portal/api/login', { email: 'luis@example.com' });
  const luis = as((await req('POST', '/portal/api/verify', { email: 'luis@example.com', code: body.dev_code })).cookie);
  await luis('POST', `/portal/api/athletes/${ava.id}/messages/read`);
  const g = app.ctx.db.get('SELECT id FROM guardians WHERE email = ?', 'luis@example.com');
  assert.ok(app.ctx.db.get('SELECT COUNT(*) AS n FROM guardian_message_reads WHERE guardian_id = ?', g.id).n > 0);
  assert.equal((await owner('DELETE', `/v1/families/${fam.id}/guardians/${g.id}`)).status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM guardian_message_reads WHERE guardian_id = ?', g.id).n, 0);
});
