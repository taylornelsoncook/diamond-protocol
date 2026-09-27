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
import { newId, addDaysToDate, localDate, zonedToUtc, weekdayOf } from '../src/util.js';

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
  assert.ok((await coach('GET', '/v1/events')).body.data.every((e) => !/^(invoice|subscription|team_invoice|sale\.refunded)/.test(e.type)), 'membership and refund events stay with the owner');
  assert.ok((await desk('GET', '/v1/events')).body.data.every((e) => !/^(invoice|subscription|team_invoice|sale\.refunded)/.test(e.type)));
  // What the counter needs to sell is still there.
  assert.equal((await coach('GET', '/v1/plans')).body.data[0].price_cents, 9900);
  // Owners still see everything.
  assert.equal((await owner('GET', `/v1/sessions/${one.id}`)).body.drop_in_cents, 3000);
  assert.ok((await owner('GET', '/v1/events')).body.data.some((e) => e.data.amount_cents));
});
