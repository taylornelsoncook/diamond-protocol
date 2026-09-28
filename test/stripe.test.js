import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { createStripeProvider, encode } from '../src/payments/stripe-provider.js';

// A tiny stand-in for api.stripe.com that records requests and keeps state.
const SK = 'sk_test_fake', WHSEC = 'whsec_fake';
const requests = [];
const intents = new Map();
let seq = 0;
const nid = (p) => `${p}_${++seq}`;
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = Object.fromEntries(new URLSearchParams(req.method === 'GET' ? url.search : raw));
    requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${SK}`) return send(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
    const p = url.pathname;
    if (p === '/v1/customers') return send(200, { id: nid('cus') });
    if (p === '/v1/terminal/locations') return send(200, { id: nid('tml') });
    if (p === '/v1/terminal/connection_tokens') return send(200, { secret: 'pst_test_secret' });
    if (p === '/v1/terminal/readers') return body.registration_code === 'good-code-here' ? send(200, { id: nid('tmr'), device_type: 'stripe_s710', label: body.label }) : send(400, { error: { message: 'Invalid registration code.' } });
    if (/^\/v1\/terminal\/readers\/.+\/process_payment_intent$/.test(p)) return send(200, { id: 'tmr', action: { status: 'in_progress' } });
    if (p === '/v1/refunds') return send(200, { id: nid('re') });
    if (p === '/v1/checkout/sessions' && req.method === 'POST') return send(200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (p === '/v1/checkout/sessions/cs_1') return send(200, { id: 'cs_1', metadata: { client_id: globalThis.setupClient }, setup_intent: { payment_method: { id: 'pm_web', card: { brand: 'mastercard', last4: '4444', exp_month: 4, exp_year: 2029 } } } });
    if (p === '/v1/payment_intents' && req.method === 'POST') {
      if (body.off_session === 'true') {
        if (body.payment_method === 'pm_declines') return send(402, { error: { type: 'card_error', message: 'Your card was declined.', payment_intent: { id: nid('pi'), status: 'requires_payment_method' } } });
        return send(200, { id: nid('pi'), status: body.payment_method === 'pm_processing' ? 'processing' : 'succeeded' });
      }
      const pi = { id: nid('pi'), client_secret: 'pi_secret_x', status: 'requires_payment_method', body };
      intents.set(pi.id, pi);
      return send(200, pi);
    }
    const m = p.match(/^\/v1\/payment_intents\/([^/]+)(\/(capture|cancel))?$/);
    if (m) {
      const pi = intents.get(m[1]);
      if (m[3] === 'cancel') pi.status = 'canceled';
      if (m[3] === 'capture') pi.status = 'succeeded';
      return send(200, { id: pi.id, status: pi.status, latest_charge: pi.charge ?? null, last_payment_error: null });
    }
    send(404, { error: { message: `No fake for ${req.method} ${p}` } });
  });
});

let app, base, cookie;
const call = async (method, path, body) => {
  const headers = { cookie };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const signed = (payload) => {
  const t = Math.floor(Date.now() / 1000), raw = JSON.stringify(payload);
  return { raw, sig: `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex')}` };
};
const webhook = (payload, sig) => fetch(base + '/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig ?? signed(payload).sig }, body: signed(payload).raw });

before(async () => {
  await new Promise((r) => fake.listen(0, r));
  const payments = createStripeProvider({ secretKey: SK, webhookSecret: WHSEC, baseUrl: `http://localhost:${fake.address().port}` });
  app = createApp({ testMode: true, jobs: false, payments });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'coach@test.dev', password: 'correct-horse-battery' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => { app.server.close(); fake.close(); });

test('encodes nested parameters the way Stripe expects', () => {
  assert.equal(decodeURIComponent(encode({ a: 1, b: { c: 'x' }, d: ['p', 'q'], e: undefined })), 'a=1&b[c]=x&d[0]=p&d[1]=q');
});

let loc, client, product;
test('tap to pay creates a card-present payment that saves the card', async () => {
  loc = (await call('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  assert.match(loc.stripe_location_id, /^tml_/);
  const locReq = requests.find((r) => r.path === '/v1/terminal/locations');
  assert.equal(locReq.body['address[line1]'], '1 Main');
  assert.equal(locReq.body.display_name, 'Facility');

  client = (await call('POST', '/v1/clients', { name: 'Maya Okafor', email: 'maya@example.com' })).body;
  product = (await call('POST', '/v1/products', { name: '10-pack', kind: 'pack', price_cents: 70000, sessions: 10 })).body;
  const sale = (await call('POST', '/v1/sales', { location_id: loc.id, method: 'tap_to_pay', client_id: client.id, items: [{ product_id: product.id }], save_card: true })).body;
  assert.equal(sale.tap_to_pay.client_secret, 'pi_secret_x');
  const piReq = requests.filter((r) => r.path === '/v1/payment_intents').pop();
  assert.equal(piReq.body['payment_method_types[0]'], 'card_present');
  assert.equal(piReq.body.setup_future_usage, 'off_session');
  assert.match(piReq.body.customer, /^cus_/);
  assert.equal(piReq.body.amount, '70000');
  assert.equal(piReq.headers['idempotency-key'], `sale-${sale.id}`);

  // The card is tapped on the iPhone; Stripe then sends a webhook.
  const pi = intents.get(sale.payment_ref);
  pi.status = 'succeeded';
  pi.charge = { payment_method_details: { card_present: { brand: 'visa', last4: '1111', generated_card: 'pm_generated' } } };
  assert.equal((await webhook({ type: 'payment_intent.succeeded', data: { object: { id: pi.id } } }, 't=1,v1=bad')).status, 400);
  assert.equal((await webhook({ type: 'payment_intent.succeeded', data: { object: { id: pi.id } } })).status, 200);
  const done = (await call('GET', `/v1/sales/${sale.id}`)).body;
  assert.equal(done.status, 'succeeded');
  assert.equal(done.card_last4, '1111');
  const c = (await call('GET', `/v1/clients/${client.id}`)).body;
  assert.deepEqual(c.card, { on_file: true, brand: 'visa', last4: '1111', owner: 'client' });
  assert.equal(c.session_credits, 10);
});

test('card on file charges off-session and reports declines', async () => {
  const ok = (await call('POST', '/v1/sales', { location_id: loc.id, method: 'card_on_file', client_id: client.id, custom: { description: 'Session', amount_cents: 8000 } })).body;
  assert.equal(ok.status, 'succeeded');
  const req = requests.filter((r) => r.path === '/v1/payment_intents').pop();
  assert.equal(req.body.payment_method, 'pm_generated');
  assert.equal(req.body.off_session, 'true');
  app.ctx.db.run(`UPDATE clients SET card_payment_method = 'pm_declines' WHERE id = ?`, client.id);
  const bad = (await call('POST', '/v1/sales', { location_id: loc.id, method: 'card_on_file', client_id: client.id, custom: { description: 'Session', amount_cents: 8000 } })).body;
  assert.equal(bad.status, 'failed');
  assert.equal(bad.failure_reason, 'Your card was declined.');
});

test('refunds and front-desk readers go through Stripe', async () => {
  const s = (await call('GET', '/v1/sales?status=succeeded')).body.data.find((x) => x.method === 'tap_to_pay');
  assert.equal((await call('POST', `/v1/sales/${s.id}/refund`, { amount_cents: 5000 })).body.status, 'partially_refunded');
  const r = requests.filter((x) => x.path === '/v1/refunds').pop();
  assert.equal(r.body.amount, '5000');
  assert.equal((await call('POST', '/v1/readers', { registration_code: 'bad', label: 'Desk', location_id: loc.id })).status, 400);
  const reader = (await call('POST', '/v1/readers', { registration_code: 'good-code-here', label: 'Desk', location_id: loc.id })).body;
  const sale = (await call('POST', '/v1/sales', { location_id: loc.id, method: 'reader', reader_id: reader.id, custom: { description: 'Drop-in', amount_cents: 3000 } })).body;
  assert.equal(sale.status, 'pending');
  assert.ok(requests.some((x) => x.path.endsWith('/process_payment_intent') && x.body.payment_intent === sale.payment_ref));
  assert.equal((await call('POST', '/v1/simulate-not-real')).status, 404);
  assert.equal((await call('POST', `/v1/sales/${sale.id}/simulate`, {})).status, 409, 'no simulated taps with real Stripe');
});

test('clients add cards on Stripe\'s hosted page', async () => {
  const link = (await call('POST', `/v1/clients/${client.id}/card/setup-link`)).body;
  assert.equal(link.url, 'https://checkout.stripe.com/c/pay/cs_1');
  globalThis.setupClient = client.id;
  await webhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'setup' } } });
  assert.deepEqual((await call('GET', `/v1/clients/${client.id}/card`)).body, { on_file: true, brand: 'mastercard', last4: '4444', exp: '2029-04', owner: 'client' });
});

test('schools pay team invoices online by card or bank account', async () => {
  const c = (await call('POST', '/v1/team-contracts', { organization: { name: 'Westlake High', contact_email: 'ad@westlake.example' }, name: 'Varsity Football', monthly_cents: 180000 })).body;
  const inv = c.invoices[0];
  const pub = (await fetch(`${base}/invoice-api/${inv.link.split('/invoice/')[1]}`).then((r) => r.json()));
  assert.equal(pub.can_pay_online, true);
  const pay = await fetch(`${base}/invoice-api/${inv.link.split('/invoice/')[1]}/checkout`, { method: 'POST' }).then((r) => r.json());
  assert.equal(pay.url, 'https://checkout.stripe.com/c/pay/cs_1');
  const req = requests.filter((x) => x.path === '/v1/checkout/sessions').pop();
  assert.equal(req.body.mode, 'payment');
  assert.equal(req.body['payment_method_types[1]'], 'us_bank_account');
  assert.equal(req.body['line_items[0][price_data][unit_amount]'], '180000');
  assert.equal(req.body['metadata[team_invoice_id]'], inv.id);
  // Bank payments complete later: first "completed but unpaid", then async success.
  await webhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'unpaid', metadata: { team_invoice_id: inv.id } } } });
  assert.equal((await call('GET', `/v1/team-invoices/${inv.id}`)).body.status, 'open');
  await webhook({ type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_ach', metadata: { team_invoice_id: inv.id } } } });
  const paid = (await call('GET', `/v1/team-invoices/${inv.id}`)).body;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paid_reference, 'pi_ach');
});

// ---- Webhooks that settle things after the fact ----
const invoiceOf = (id) => app.ctx.db.get('SELECT * FROM invoices WHERE id = ?', id);
const subOf = (id) => app.ctx.db.get('SELECT * FROM subscriptions WHERE id = ?', id);
let sub, inv;
test('a renewal that fails after it was taken reopens the invoice; a late success closes it', async () => {
  // Stripe answered "processing": counted as paid, waiting on the bank.
  app.ctx.db.run(`UPDATE clients SET card_payment_method = 'pm_processing' WHERE id = ?`, client.id);
  const plan = (await call('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000, trial_days: 0 })).body;
  sub = (await call('POST', `/v1/clients/${client.id}/subscription`, { plan_id: plan.id })).body;
  inv = app.ctx.db.get('SELECT * FROM invoices WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 1', sub.id);
  assert.equal(inv.status, 'paid');
  assert.match(inv.payment_ref, /^pi_/);
  const pi = { id: inv.payment_ref, object: 'payment_intent', metadata: { invoice_id: inv.id }, last_payment_error: { message: 'Insufficient funds.' } };

  assert.equal((await webhook({ type: 'payment_intent.payment_failed', data: { object: pi } })).status, 200);
  let now = invoiceOf(inv.id);
  assert.equal(now.status, 'failed');
  assert.equal(now.last_error, 'Insufficient funds.');
  assert.ok(now.next_retry_at, 'the retry job picks it up');
  assert.equal(subOf(sub.id).status, 'past_due');
  await webhook({ type: 'payment_intent.payment_failed', data: { object: pi } });
  assert.equal(invoiceOf(inv.id).status, 'failed', 'a repeated event changes nothing');

  await webhook({ type: 'payment_intent.succeeded', data: { object: pi } });
  now = invoiceOf(inv.id);
  assert.equal(now.status, 'paid');
  assert.equal(now.next_retry_at, null);
  assert.equal(subOf(sub.id).status, 'active');
  // Stripe doesn't promise the order of events: the failure delivered again after the success is stale (a PaymentIntent
  // that succeeded never fails), so the invoice stays paid and isn't charged again.
  await webhook({ type: 'payment_intent.payment_failed', data: { object: pi } });
  assert.equal(invoiceOf(inv.id).status, 'paid', 'a stale failure after the success changes nothing');
  assert.equal(app.ctx.db.get('SELECT status FROM invoice_charges WHERE ref = ?', inv.payment_ref).status, 'succeeded');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'invoice.payment_failed' AND data LIKE ?`, `%${inv.id}%`).n, 1);
});

test('every charge try is matched: an older try approved late pays the invoice, and a second late approval is refunded once and the owner told', async () => {
  app.ctx.db.run(`UPDATE clients SET card_payment_method = 'pm_declines' WHERE id = ?`, client.id);
  const retried = (await call('POST', `/v1/invoices/${inv.id}/retry`)).status;
  assert.equal(retried, 409, 'a paid invoice is not retried');
  app.ctx.db.run(`UPDATE invoices SET status = 'failed' WHERE id = ?`, inv.id);
  await call('POST', `/v1/invoices/${inv.id}/retry`);
  const declined = invoiceOf(inv.id);
  assert.equal(declined.status, 'failed');
  assert.notEqual(declined.payment_ref, inv.payment_ref, 'the declined attempt is the latest');
  const tries = app.ctx.db.all('SELECT ref, manual, status FROM invoice_charges WHERE invoice_id = ? ORDER BY created_at, rowid', inv.id);
  assert.ok(tries.some((t) => t.ref === declined.payment_ref && t.manual === 1 && t.status === 'declined'), 'the owner\'s retry is written down as manual');
  // The try's id went to Stripe with the charge.
  const sent = requests.filter((r) => r.path === '/v1/payment_intents' && r.body['metadata[invoice_id]'] === inv.id).at(-1);
  assert.match(sent.body['metadata[charge_attempt_id]'], /^ich_/);
  const refundsBefore = requests.filter((r) => r.path === '/v1/refunds').length;
  await webhook({ type: 'payment_intent.succeeded', data: { object: { id: inv.payment_ref, metadata: { invoice_id: inv.id } } } });
  assert.equal(invoiceOf(inv.id).status, 'paid', 'an older try the bank approves pays the invoice');
  assert.equal(invoiceOf(inv.id).payment_ref, inv.payment_ref);
  // Now the declined try is approved too: charged twice, so it goes back, once.
  await webhook({ type: 'payment_intent.succeeded', data: { object: { id: declined.payment_ref, metadata: { invoice_id: inv.id } } } });
  await webhook({ type: 'payment_intent.succeeded', data: { object: { id: declined.payment_ref, metadata: { invoice_id: inv.id } } } });
  const refunds = requests.filter((r) => r.path === '/v1/refunds').slice(refundsBefore);
  assert.deepEqual(refunds.map((r) => r.body.payment_intent), [declined.payment_ref], 'refunded exactly once');
  assert.equal(invoiceOf(inv.id).status, 'paid');
  const dash = (await call('GET', '/v1/dashboard')).body;
  const alert = dash.attention.find((a) => a.kind === 'late_charge' && a.invoice_id === inv.id);
  assert.ok(alert, 'the owner sees it on Today');
  assert.equal(alert.late_outcome, 'refunded');
  assert.ok(app.ctx.db.get(`SELECT 1 FROM outbox WHERE subject LIKE 'Refunded a late card charge%'`), 'and gets an email');
  assert.equal((await call('POST', `/v1/invoices/${inv.id}/charges/${alert.charge_id}/handled`)).status, 200);
  assert.ok(!(await call('GET', '/v1/dashboard')).body.attention.some((a) => a.kind === 'late_charge' && a.invoice_id === inv.id), 'handled: off Today');
  app.ctx.db.run(`UPDATE clients SET card_payment_method = 'pm_web' WHERE id = ?`, client.id);
});

test('refunds made in the Stripe dashboard show on the sale, in its refund log and in the day\'s takings', async () => {
  const s = app.ctx.db.get(`SELECT * FROM sales WHERE method = 'tap_to_pay' AND status = 'partially_refunded'`);
  assert.equal(s.refunded_cents, 5000);
  const logged = () => app.ctx.db.all('SELECT amount_cents, reason FROM sale_refunds WHERE sale_id = ? ORDER BY created_at, rowid', s.id);
  const refundedToday = async () => (await call('GET', '/v1/sales/takings')).body.refunded_cents;
  assert.equal(logged().length, 1, 'the refund made in the app');
  const before = await refundedToday();
  // Stripe echoes the refund made in the app: nothing new to log.
  await webhook({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: s.payment_ref, amount_refunded: 5000 } } });
  assert.equal(logged().length, 1);
  await webhook({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: s.payment_ref, amount_refunded: 7000 } } });
  assert.equal((await call('GET', `/v1/sales/${s.id}`)).body.refunded_cents, 7000);
  assert.deepEqual(logged()[1], { amount_cents: 2000, reason: 'Refunded in the Stripe dashboard' });
  assert.equal(await refundedToday(), before + 2000, 'the dashboard refund counts in today\'s takings');
  await webhook({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: s.payment_ref, amount_refunded: 7000 } } });
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'sale.refunded' AND data LIKE '%stripe_dashboard%'`).n, 1);
  assert.equal(logged().length, 2, 'a repeated webhook logs nothing');
  await webhook({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: s.payment_ref, amount_refunded: 70000 } } });
  const after = (await call('GET', `/v1/sales/${s.id}`)).body;
  assert.equal(after.status, 'refunded');
  assert.equal(logged().reduce((n, r) => n + r.amount_cents, 0), after.refunded_cents, 'the refund log adds up to the sale\'s refunded total');
});

test('reissued cards and disputes', async () => {
  await webhook({ type: 'payment_method.automatically_updated', data: { object: { id: 'pm_web', card: { brand: 'mastercard', last4: '9999', exp_month: 7, exp_year: 2031 } } } });
  assert.equal((await call('GET', `/v1/clients/${client.id}/card`)).body.last4, '9999');
  assert.equal((await call('GET', `/v1/clients/${client.id}/card`)).body.exp, '2031-07', 'the new expiry is kept for the "expires soon" reminder');
  await webhook({ type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: invoiceOf(inv.id).payment_ref, amount: 15000, reason: 'fraudulent' } } });
  const ev = app.ctx.db.get(`SELECT data FROM events WHERE type = 'payment.disputed'`);
  assert.equal(JSON.parse(ev.data).invoice_id, inv.id);
});
