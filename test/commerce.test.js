import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';

let app, base, appToken;
const call = async (method, path, body, token = appToken) => {
  const headers = { authorization: `Bearer ${token}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

let facility, park, single, pack, shirt, maya, walkin;

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => app.server.close());

test('the iPhone app signs in with a bearer token', async () => {
  const bad = await fetch(base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'coach@test.dev', password: 'nope' }) });
  assert.equal(bad.status, 401);
  const res = await fetch(base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'coach@test.dev', password: 'correct-horse-battery' }) });
  appToken = (await res.json()).token;
  assert.match(appToken, /^dp_app_/);
  assert.equal((await call('GET', '/auth/me')).body.user.email, 'coach@test.dev');
  assert.equal((await call('GET', '/v1/clients', null, 'dp_app_bogus')).status, 401);
});

test('locations need an address before taking card payments', async () => {
  facility = (await call('POST', '/v1/locations', { name: 'Diamond Protocol Facility', kind: 'facility', address_line1: '100 Main St', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  assert.equal(facility.card_ready, true);
  park = (await call('POST', '/v1/locations', { name: 'Zilker Park', kind: 'park' })).body;
  assert.equal(park.card_ready, false);
  single = (await call('POST', '/v1/products', { name: 'Single session', kind: 'session', price_cents: 8000 })).body;
  pack = (await call('POST', '/v1/products', { name: '10-session pack', kind: 'pack', price_cents: 70000, sessions: 10 })).body;
  shirt = (await call('POST', '/v1/products', { name: 'DP T-shirt', kind: 'gear', price_cents: 3000 })).body;
  assert.equal(pack.sessions, 10);
  assert.equal((await call('POST', '/v1/products', { name: 'Bad pack', kind: 'pack', price_cents: 100, sessions: 1 })).status, 400);
  maya = (await call('POST', '/v1/clients', { name: 'Maya Okafor', email: 'maya@example.com' })).body;

  const r = await call('POST', '/v1/sales', { location_id: park.id, method: 'tap_to_pay', client_id: maya.id, items: [{ product_id: single.id }] });
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /street address/);
  park = (await call('PATCH', `/v1/locations/${park.id}`, { address_line1: '2100 Barton Springs Rd', city: 'Austin', state: 'TX', postal_code: '78746' })).body;
  assert.equal(park.card_ready, true);
});

test('tap to pay in the park: pack sale adds sessions and saves the card', async () => {
  const s = (await call('POST', '/v1/sales', { location_id: park.id, method: 'tap_to_pay', client_id: maya.id, items: [{ product_id: pack.id }], save_card: true })).body;
  assert.equal(s.status, 'pending');
  assert.equal(s.amount_cents, 70000);
  assert.ok(s.tap_to_pay.client_secret, 'app gets the client secret');
  assert.ok(s.tap_to_pay.location_ref, 'app gets the location to connect Tap to Pay');
  const pending = await call('POST', `/v1/sales/${s.id}/sync`);
  assert.equal(pending.body.status, 'pending');
  const done = (await call('POST', `/v1/sales/${s.id}/simulate`, { outcome: 'approved' })).body;
  assert.equal(done.status, 'succeeded');
  assert.ok(done.card_last4);
  assert.equal(done.tap_to_pay, undefined, 'secret is not returned after completion');
  const c = (await call('GET', `/v1/clients/${maya.id}`)).body;
  assert.equal(c.session_credits, 10);
  assert.equal(c.card.on_file, true);
});

test('declined taps are recorded as failed', async () => {
  const s = (await call('POST', '/v1/sales', { location_id: park.id, method: 'tap_to_pay', client_id: maya.id, items: [{ product_id: single.id }] })).body;
  const r = (await call('POST', `/v1/sales/${s.id}/simulate`, { outcome: 'declined' })).body;
  assert.equal(r.status, 'failed');
  assert.match(r.failure_reason, /declined/);
  assert.equal((await call('GET', `/v1/clients/${maya.id}`)).body.session_credits, 10);
});

test('check-ins use credits unless the client is a member', async () => {
  const r = (await call('POST', `/v1/clients/${maya.id}/check-ins`, { location_id: facility.id, credit_type: 'private' })).body;
  assert.equal(r.covered_by, 'credit');
  assert.equal(r.credits_left, 9);
  walkin = (await call('POST', '/v1/clients', { name: 'Leo Marchetti', email: 'leo@example.com' })).body;
  const none = await call('POST', `/v1/clients/${walkin.id}/check-ins`, { location_id: facility.id, credit_type: 'private' });
  assert.equal(none.status, 409);
  assert.match(none.body.error.message, /no private sessions left/);
  assert.equal((await call('POST', `/v1/clients/${maya.id}/check-ins`, { location_id: facility.id })).status, 409, 'private pack credits do not cover group sessions');
  const plan = (await call('POST', '/v1/plans', { name: 'Coaching', price_cents: 14900, trial_days: 7 })).body;
  await call('POST', `/v1/clients/${walkin.id}/subscription`, { plan_id: plan.id });
  assert.equal((await call('POST', `/v1/clients/${walkin.id}/check-ins`, { location_id: facility.id })).body.covered_by, 'membership');
});

test('card on file, cash, walk-ins and custom amounts', async () => {
  const cof = (await call('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: maya.id, items: [{ product_id: shirt.id, quantity: 2 }] })).body;
  assert.equal(cof.status, 'succeeded');
  assert.equal(cof.amount_cents, 6000);
  const noCard = await call('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: walkin.id, items: [{ product_id: shirt.id }] });
  assert.equal(noCard.status, 409);
  const cash = (await call('POST', '/v1/sales', { location_id: park.id, method: 'cash', custom: { description: 'Partner session', amount_cents: 4000 } })).body;
  assert.equal(cash.status, 'succeeded');
  assert.equal(cash.client_id, null);
  const needsClient = await call('POST', '/v1/sales', { location_id: park.id, method: 'cash', items: [{ product_id: pack.id }] });
  assert.equal(needsClient.status, 400);
  assert.equal((await call('POST', '/v1/sales', { location_id: park.id, method: 'cash' })).status, 400);
});

test('front-desk reader: register, charge, cancel', async () => {
  assert.equal((await call('POST', '/v1/readers', { registration_code: 'nope', label: 'Front desk', location_id: facility.id })).status, 400);
  const reader = (await call('POST', '/v1/readers', { registration_code: 'simulated-wpe', label: 'Front desk', location_id: facility.id })).body;
  const s1 = (await call('POST', '/v1/sales', { location_id: facility.id, method: 'reader', reader_id: reader.id, client_id: walkin.id, items: [{ product_id: single.id }] })).body;
  assert.equal(s1.status, 'pending');
  const busy = await call('POST', '/v1/sales', { location_id: facility.id, method: 'reader', reader_id: reader.id, items: [{ product_id: shirt.id }] });
  assert.equal(busy.status, 409);
  assert.equal((await call('POST', `/v1/sales/${s1.id}/cancel`)).body.status, 'canceled');
  const s2 = (await call('POST', '/v1/sales', { location_id: facility.id, method: 'reader', reader_id: reader.id, items: [{ product_id: shirt.id }] })).body;
  assert.equal((await call('POST', `/v1/sales/${s2.id}/simulate`, {})).body.status, 'succeeded');
});

test('refunds: partial, then full removes unused pack sessions', async () => {
  const s = (await call('POST', '/v1/sales', { location_id: park.id, method: 'tap_to_pay', client_id: walkin.id, items: [{ product_id: pack.id }] })).body;
  await call('POST', `/v1/sales/${s.id}/simulate`, {});
  assert.equal((await call('GET', `/v1/clients/${walkin.id}/credits`)).body.balance, 10);
  const part = (await call('POST', `/v1/sales/${s.id}/refund`, { amount_cents: 10000 })).body;
  assert.equal(part.status, 'partially_refunded');
  assert.equal((await call('GET', `/v1/clients/${walkin.id}/credits`)).body.balance, 10);
  assert.equal((await call('POST', `/v1/sales/${s.id}/refund`, { amount_cents: 999999 })).status, 400);
  const full = (await call('POST', `/v1/sales/${s.id}/refund`)).body;
  assert.equal(full.status, 'refunded');
  assert.equal(full.refunded_cents, 70000);
  assert.equal((await call('GET', `/v1/clients/${walkin.id}/credits`)).body.balance, 0);
  assert.equal((await call('POST', `/v1/sales/${s.id}/refund`)).status, 409);
});

test('revenue by location and dashboard totals', async () => {
  const rep = (await call('GET', '/v1/reports/revenue')).body;
  const byName = Object.fromEntries(rep.locations.map((l) => [l.name, l.cents]));
  assert.equal(byName['Zilker Park'], 70000 + 4000);
  assert.equal(byName['Diamond Protocol Facility'], 6000 + 3000);
  const dash = (await call('GET', '/v1/dashboard')).body;
  assert.equal(dash.today_sales.cents, 70000 + 4000 + 6000 + 3000);
  const types = (await call('GET', '/v1/events?limit=200')).body.data.map((e) => e.type);
  for (const t of ['sale.completed', 'sale.failed', 'sale.refunded', 'session.checked_in', 'client.card_updated']) assert.ok(types.includes(t), t);
});

test('connection token for the Stripe Terminal SDK', async () => {
  const t = (await call('POST', '/v1/terminal/connection-token', { location_id: park.id })).body;
  assert.ok(t.secret);
  assert.equal(t.location_ref, park.stripe_location_id);
});
