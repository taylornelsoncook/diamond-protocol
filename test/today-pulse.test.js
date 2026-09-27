// Today's business pulse: the owner sees money and client numbers; coaches and front desk see the work, never money.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';

let app, base, owner, coach, desk, facility;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const hasMoney = (o) => JSON.stringify(o).match(/_cents"/);

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
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

test('the owner pulse counts today\'s in-person money in today and in the month', async () => {
  const before = (await owner('GET', '/v1/dashboard')).body.pulse;
  assert.equal(before.money.today_cents, 0);
  const sale = (await owner('POST', '/v1/sales', { location_id: facility.id, method: 'cash', custom: { description: 'Gloves', amount_cents: 4200 } })).body;
  assert.equal(sale.status, 'succeeded');
  const p = (await owner('GET', '/v1/dashboard')).body.pulse;
  assert.equal(p.money.today_cents, 4200);
  assert.equal(p.money.today_sales, 1);
  assert.equal(p.money.month.total, before.money.month.total + 4200);
  assert.equal(p.money.month.sales, before.money.month.sales + 4200);
  for (const k of ['clients', 'today', 'attendance', 'workouts', 'leads']) assert.ok(p[k], k);
  assert.equal(typeof p.bookings_next_7_days, 'number');
});

test('coaches and front desk get the pulse without any money', async () => {
  for (const who of [coach, desk]) {
    const d = (await who('GET', '/v1/dashboard')).body;
    assert.ok(d.pulse.clients && d.pulse.today && d.pulse.leads);
    assert.equal(d.pulse.money, undefined);
    assert.equal(hasMoney(d.pulse), null);
  }
});
