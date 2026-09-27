import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { completePayLink } from '../src/services/paylinks.js';
import { handleStripeEvent } from '../src/services/commerce.js';
import { runBilling } from '../src/services/billing.js';
import { newId } from '../src/util.js';

// Pay links: a parent pays one thing by card without signing in; failed membership payments recover on their own.
let app, base, owner, coach, frontDesk, facility, ava, ben, plan;
const refunds = [];

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const pub = async (method, path) => { const r = await fetch(base + path, { method }); return { status: r.status, body: await r.json() }; };
const avaFamily = () => app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', ava.id).family_id;
const tokenOf = (url) => url.split('/pay/')[1];
const mailTo = (email) => app.ctx.db.all('SELECT subject, body FROM outbox WHERE to_email = ? ORDER BY rowid', email);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  const refund = app.ctx.payments.refund;
  app.ctx.payments.refund = async (args) => { refunds.push(args); return refund(args); };
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); frontDesk = await signIn('desk@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com', phone: '512-555-0100' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  plan = (await owner('POST', '/v1/plans', { name: 'Membership', price_cents: 15000, trial_days: 0 })).body;
});
after(() => app.server.close());

test('a failed membership payment emails a pay link, and paying it brings the membership back', async () => {
  await owner('POST', `/v1/clients/${ava.id}/subscription`, { plan_id: plan.id });          // no card on file: the first charge fails
  const inv = app.ctx.db.get(`SELECT * FROM invoices WHERE client_id = ?`, ava.id);
  assert.equal(inv.status, 'failed');
  const mail = mailTo('maria@example.com').find((m) => /didn't go through/.test(m.subject));
  const url = mail.body.match(/https:\/\/app\.example\.org\/pay\/[\w-]+/)[0];
  assert.match(mail.body, /Pay it now by card, no sign-in needed/);

  const page = await pub('GET', `/pay-api/${tokenOf(url)}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.amount_cents, 15000);
  assert.equal(page.body.status, 'open');
  assert.match(page.body.description, /^Membership for Ava, /);
  assert.equal(page.body.can_simulate, true);
  assert.equal(page.body.can_pay_online, false, 'no Stripe in test mode');
  assert.equal((await fetch(`${base}/pay/${tokenOf(url)}`)).status, 200, 'the page itself loads');

  const paid = await pub('POST', `/pay-api/${tokenOf(url)}/simulate`);
  assert.equal(paid.body.status, 'paid');
  assert.equal(app.ctx.db.get('SELECT status FROM invoices WHERE id = ?', inv.id).status, 'paid');
  assert.equal(app.ctx.db.get('SELECT status FROM subscriptions WHERE client_id = ?', ava.id).status, 'active');
  assert.match(mailTo('maria@example.com').at(-1).body, /Paid by card online/);
  assert.equal((await pub('POST', `/pay-api/${tokenOf(url)}/simulate`)).status, 409, 'a paid link can\'t be paid again');
  assert.equal((await pub('GET', '/pay-api/not-a-real-token')).status, 404);
});

test('saving a new card charges a failed payment right away, and a late link payment is refunded', async () => {
  await owner('POST', `/v1/clients/${ben.id}/subscription`, { plan_id: plan.id });
  const inv = app.ctx.db.get(`SELECT * FROM invoices WHERE client_id = ?`, ben.id);
  assert.equal(inv.status, 'failed');
  const link = (await owner('POST', '/v1/pay-links', { kind: 'invoice', invoice_id: inv.id })).body;
  assert.equal(link.status, 'open');
  assert.equal((await owner('POST', '/v1/pay-links', { kind: 'invoice', invoice_id: inv.id })).body.id, link.id, 'one open link per payment');

  await owner('POST', `/v1/clients/${ben.id}/card/test`);                                   // Dana adds a card
  assert.equal(app.ctx.db.get('SELECT status FROM invoices WHERE id = ?', inv.id).status, 'paid', 'charged without waiting for the next retry');
  assert.equal((await owner('GET', `/v1/pay-links/${link.id}`)).body.status, 'settled');
  assert.equal((await pub('GET', `/pay-api/${tokenOf(link.url)}`)).body.status, 'settled');

  await completePayLink(app.ctx, link.id, 'pi_late');                                        // Dana had the Stripe page open and paid anyway
  assert.equal(refunds.at(-1).paymentRef, 'pi_late');
  assert.equal(refunds.at(-1).amountCents, 15000);
  assert.match(mailTo('owner@test.dev').at(-1).subject, /^Refunded a double payment: \$150$/);
  await completePayLink(app.ctx, link.id, 'pi_late');
  assert.equal(refunds.filter((r) => r.paymentRef === 'pi_late').length, 1, 'refunded once');
});

test('unpaid sessions, packs and set amounts are paid by link and recorded as online sales', async () => {
  const at = new Date(Date.now() + 2 * 86400000).toISOString(), sid = newId('cls'), bid = newId('bkg');
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, status, created_at) VALUES (?, 'Speed', 'group', ?, ?, ?, 10, 2500, 'scheduled', ?)`, sid, facility.id, at, at, at);
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'unpaid', ?, ?)`, bid, sid, ava.id, at, at);
  const owedRes = await owner('GET', `/v1/clients/${ava.id}/owed`);
  assert.equal(owedRes.status, 200, JSON.stringify(owedRes.body));
  const owed = owedRes.body;
  const item = owed.data.find((o) => o.booking_id === bid);
  assert.equal(item.amount_cents, 2500);
  const link = (await owner('POST', '/v1/pay-links', { kind: 'booking', booking_id: bid, send: true })).body;
  assert.equal(link.emailed, 1);
  assert.equal(link.texted, 0, 'Maria hasn\'t turned texts on');
  assert.match(mailTo('maria@example.com').at(-1).body, /pay \$25 for Speed for Ava, /);
  await pub('POST', `/pay-api/${tokenOf(link.url)}/simulate`);
  const b = app.ctx.db.get('SELECT coverage, sale_id FROM bookings WHERE id = ?', bid);
  assert.equal(b.coverage, 'paid');
  const sale = (await owner('GET', `/v1/sales/${b.sale_id}`)).body;
  assert.equal(sale.method, 'online');
  assert.equal(sale.status, 'succeeded');
  assert.equal(sale.location_name, 'Online');
  assert.ok(!sale.items[0].name.includes('Ava'), 'sale lines carry no names');

  const pack = (await owner('POST', '/v1/products', { name: '5 privates', kind: 'pack', price_cents: 40000, sessions: 5, credit_type: 'private' })).body;
  const packLink = (await owner('POST', '/v1/pay-links', { kind: 'product', client_id: ava.id, product_id: pack.id })).body;
  assert.equal(packLink.amount_cents, 40000);
  app.ctx.db.run(`UPDATE guardians SET sms_opt_in_at = ? WHERE email = 'maria@example.com'`, app.ctx.now());
  assert.equal((await owner('POST', `/v1/pay-links/${packLink.id}/send`)).body.texted, 1);
  assert.match(app.ctx.db.get(`SELECT body FROM texts WHERE kind = 'pay_link' ORDER BY rowid DESC`).body, /^Diamond Protocol: Pay \$400 for 5 privates for Ava: https:\/\/app\.example\.org\/pay\//);
  await pub('POST', `/pay-api/${tokenOf(packLink.url)}/simulate`);
  assert.equal((await owner('GET', `/v1/clients/${ava.id}`)).body.credits.private, 5);

  const bad = await owner('POST', '/v1/pay-links', { kind: 'custom', client_id: ava.id, description: 'Camp deposit', amount_cents: 50 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.message, 'Enter an amount between $1 and $10,000.');
  const dep = (await owner('POST', '/v1/pay-links', { kind: 'custom', client_id: ava.id, description: 'Camp deposit', amount_cents: 10000 })).body;
  await owner('POST', `/v1/pay-links/${dep.id}/cancel`);
  assert.equal((await pub('GET', `/pay-api/${tokenOf(dep.url)}`)).body.status, 'canceled');
  assert.equal((await pub('POST', `/pay-api/${tokenOf(dep.url)}/simulate`)).status, 409);
});

test('Stripe checkout completing marks the link paid; retries wait while a parent is paying', async () => {
  const cara = (await owner('POST', '/v1/clients', { name: 'Cara Diaz', parent: { name: 'Lu Diaz', email: 'lu@example.com' } })).body;
  await owner('POST', `/v1/clients/${cara.id}/subscription`, { plan_id: plan.id });
  const inv = app.ctx.db.get(`SELECT * FROM invoices WHERE client_id = ?`, cara.id);
  const link = (await owner('POST', '/v1/pay-links', { kind: 'invoice', invoice_id: inv.id })).body;
  app.ctx.db.run('UPDATE pay_links SET checkout_ref = ?, checkout_started_at = ? WHERE id = ?', 'cs_test_1', app.ctx.now(), link.id);
  app.ctx.db.run('UPDATE invoices SET next_retry_at = ? WHERE id = ?', new Date(Date.now() - 60000).toISOString(), inv.id);
  assert.equal((await runBilling(app.ctx)).retried, 0, 'no retry while the parent is on the payment page');
  await handleStripeEvent(app.ctx, { type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_link_1', metadata: { pay_link_id: link.id } } } });
  assert.equal((await owner('GET', `/v1/pay-links/${link.id}`)).body.status, 'paid');
  assert.equal(app.ctx.db.get('SELECT payment_ref FROM invoices WHERE id = ?', inv.id).payment_ref, 'pi_link_1');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'pay_link.paid'`).n, 4);
});

test('only the owner sees pay links; links expire; deleting a family keeps paid ones without names', async () => {
  assert.equal((await coach('GET', '/v1/pay-links')).status, 403);
  assert.equal((await coach('GET', `/v1/clients/${ava.id}/owed`)).status, 403);
  assert.equal((await frontDesk('POST', '/v1/pay-links', { kind: 'custom', client_id: ava.id, description: 'x', amount_cents: 1000 })).status, 403);
  const old = (await owner('POST', '/v1/pay-links', { kind: 'custom', client_id: ava.id, description: 'Old balance', amount_cents: 1000 })).body;
  app.ctx.db.run(`UPDATE pay_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, old.id);
  assert.equal((await pub('GET', `/pay-api/${tokenOf(old.url)}`)).body.status, 'expired');
  assert.equal((await pub('POST', `/pay-api/${tokenOf(old.url)}/simulate`)).status, 409);

  const expRes = await owner('GET', `/v1/families/${avaFamily()}/export`);
  assert.equal(expRes.status, 200, JSON.stringify(expRes.body));
  const exp = expRes.body;
  assert.ok(exp.pay_links.length >= 4);
  const fam = app.ctx.db.get('SELECT name FROM families WHERE id = ?', avaFamily());
  assert.equal((await owner('DELETE', `/v1/families/${avaFamily()}`, { confirm: fam.name })).status, 200);
  const left = app.ctx.db.all('SELECT status, description, sent_to FROM pay_links WHERE client_id = ?', ava.id);
  assert.ok(left.length && left.every((l) => l.status === 'paid' && l.description === 'Deleted family' && l.sent_to === null));
});
