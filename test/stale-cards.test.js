// Cards saved by the built-in test provider (cus_test_…, pm_test_…) mean nothing to Stripe once a key is set: the counter and
// membership charges fail with a plain reason instead of a 500, the client page says so, and a card link makes a new customer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { addTestCard } from '../src/services/commerce.js';
import { retryInvoice } from '../src/services/billing.js';

let app, base, facility, ava, testProvider;
const calls = [];
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let token;
// Stands in for the Stripe provider: a test id is refused like Stripe refuses it, anything else goes through.
const stripeLike = {
  name: 'stripe', live: false,
  async ensureCustomer(client) { calls.push(['customer', client.stripe_customer_id]); return client.stripe_customer_id || 'cus_real_1'; },
  async chargeSaved({ client }) {
    calls.push(['charge', client.stripe_customer_id, client.card_payment_method]);
    if (/_test_/.test(client.stripe_customer_id ?? '') || /_test_/.test(client.card_payment_method ?? '')) { const e = new Error(`No such customer: '${client.stripe_customer_id}'`); e.status = 400; e.stripe = { type: 'invalid_request_error' }; throw e; }
    if (client.card_payment_method === 'pm_real_down') { const e = new Error('Stripe is down for maintenance.'); e.status = 503; throw e; }
    return { ok: true, ref: 'pi_real_1' };
  },
  async cardSetupSession({ customerId }) { return { id: 'cs_1', url: `https://checkout.stripe.test/${customerId}` }; },
  async refund() { return { ok: true, ref: 're_1' }; }
};

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.test' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  token = (await (await fetch(base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.dev', password: 'owner-password-1' }) })).json()).token;
  facility = (await call('POST', '/v1/locations', { name: 'Facility', kind: 'facility' })).body;
  ava = (await call('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  await addTestCard(app.ctx, ava.id);                   // the sample data's kind of card, made with no Stripe key
  testProvider = app.ctx.payments;
  app.ctx.payments = stripeLike;                        // then a Stripe key is set
});
after(() => app.server.close());

const familyId = () => app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', ava.id).family_id;
const family = () => app.ctx.db.get('SELECT * FROM families WHERE id = ?', familyId());

test('the card shows as saved before Stripe was connected', async () => {
  assert.match(family().card_payment_method, /^pm_test_/);
  const card = (await call('GET', `/v1/clients/${ava.id}/card`)).body;
  assert.equal(card.on_file, true);
  assert.equal(card.stale, true);
  app.ctx.payments = testProvider;
  assert.equal((await call('GET', `/v1/clients/${ava.id}/card`)).body.stale, false, 'with the test provider the card is fine');
  app.ctx.payments = stripeLike;
});

test('the counter refuses to charge it with a plain reason and records no sale', async () => {
  const r = await call('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: ava.id, custom: { description: 'Test charge', amount_cents: 100 } });
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /saved before Stripe was connected/);
  assert.match(r.body.error.message, /Maria Lopez/);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM sales').n, 0);
  assert.ok(!calls.some(([k]) => k === 'charge'), 'Stripe is never asked');
});

test('a membership charge on it declines with the same reason instead of erroring', async () => {
  const plan = (await call('POST', '/v1/plans', { name: 'Eight a month', price_cents: 13900, trial_days: 0 })).body;
  const r = await call('POST', `/v1/clients/${ava.id}/subscription`, { plan_id: plan.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inv = app.ctx.db.get('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', ava.id);
  assert.equal(inv.status, 'failed');
  assert.match(inv.last_error, /saved before Stripe was connected/);
  assert.equal(app.ctx.db.get('SELECT status FROM invoice_charges WHERE invoice_id = ?', inv.id).status, 'declined');
  assert.ok(!calls.some(([k]) => k === 'charge'), 'Stripe is never asked');
  const again = await retryInvoice(app.ctx, inv.id, { by: 'owner' });
  assert.equal(again.status, 'failed', 'a retry is a decline, not an error');
  assert.match(again.last_error, /saved before Stripe was connected/);
});

test('a card link makes a new Stripe customer in place of the test one', async () => {
  const before = family().stripe_customer_id;
  assert.match(before, /^cus_test_/);
  const r = await call('POST', `/v1/clients/${ava.id}/card/setup-link`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, 'https://checkout.stripe.test/cus_real_1');
  assert.equal(family().stripe_customer_id, 'cus_real_1');
  assert.deepEqual(calls.filter(([k]) => k === 'customer'), [['customer', null]], 'asked for a new customer, not the test one');
  // Stripe's webhook then saves the real card (stood in for here) and everything works again.
  app.ctx.db.run('UPDATE families SET card_payment_method = ?, card_brand = ?, card_last4 = ? WHERE id = ?', 'pm_real_1', 'visa', '4242', familyId());
  assert.equal((await call('GET', `/v1/clients/${ava.id}/card`)).body.stale, false);
  const sale = await call('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: ava.id, custom: { description: 'Test charge', amount_cents: 100 } });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  assert.equal(sale.body.status, 'succeeded');
  assert.equal(sale.body.payment_ref, 'pi_real_1');
});

test('any other error from Stripe at the counter names the service and leaves the sale failed, not a 500', async () => {
  app.ctx.db.run('UPDATE families SET card_payment_method = ? WHERE id = ?', 'pm_real_down', familyId());
  const r = await call('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: ava.id, custom: { description: 'Test charge', amount_cents: 100 } });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'payment_provider_error');
  assert.match(r.body.error.message, /Stripe is down for maintenance/);
  const sale = app.ctx.db.get(`SELECT * FROM sales ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  assert.equal(sale.status, 'failed');
  assert.match(sale.failure_reason, /Stripe is down for maintenance/);
});
