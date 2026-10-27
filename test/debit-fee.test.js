import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { cardFee, cardFunding, lookupFundings } from '../src/services/fees.js';

// The card fee is charged on credit cards only (owner's ask: "add the check for debit or credit"; Colorado C.R.S. § 5-2-212
// and the card networks allow a surcharge on credit cards only). Stripe says what a card is (card.funding): a debit or
// prepaid card on file is never charged the fee, and a card known only once it's tapped or typed on the pay page has the
// fee given back at once. Schema 88: card_funding on clients and families, sale_refunds.fee.
let app, base, owner, facility, single, maya, noah, plan;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const pub = async (method, path, body) => { const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const refunds = [];

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('billing_cycle', 'anniversary')");
  const refund = app.ctx.payments.refund;
  app.ctx.payments.refund = async (args) => { refunds.push(args); return refund(args); };
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '100 Main St', city: 'Parker', state: 'CO', postal_code: '80134' })).body;
  single = (await owner('POST', '/v1/products', { name: 'Single session', kind: 'session', price_cents: 8000 })).body;
  maya = (await owner('POST', '/v1/clients', { name: 'Maya Okafor', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  noah = (await owner('POST', '/v1/clients', { name: 'Noah Reyes', parent: { name: 'Sol Reyes', email: 'sol@example.com' } })).body;
  plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000, trial_days: 0 })).body;
  await owner('PATCH', '/v1/settings', { card_fee_pct: 2, card_fee_flat: 0, card_fee_on: ['memberships', 'counter', 'pay_links', 'store'] });
});
after(() => app.server.close());

test('the fee helper: credit or unknown pays it, debit and prepaid never do', () => {
  assert.equal(cardFee(app.ctx, 10000, 'counter').cents, 200);
  assert.equal(cardFee(app.ctx, 10000, 'counter', { funding: 'credit' }).cents, 200);
  assert.equal(cardFee(app.ctx, 10000, 'counter', { funding: 'unknown' }).cents, 200, 'a card Stripe can\'t classify is treated as credit');
  assert.deepEqual(cardFee(app.ctx, 10000, 'counter', { funding: 'debit' }), { cents: 0, label: 'Card processing fee', debit: true });
  assert.equal(cardFee(app.ctx, 10000, 'counter', { funding: 'prepaid' }).cents, 0);
});

test('a debit card on file: no fee at the counter, on the membership quote and charge, or in the portal store', async () => {
  // Maya's family saves a debit card; Noah's a credit card (Stripe's answer comes with the saved card).
  const debit = await owner('POST', `/v1/clients/${maya.id}/card/test`, { funding: 'debit' });
  assert.equal(debit.status, 200, JSON.stringify(debit.body));
  assert.equal(debit.body.funding, 'debit');
  await owner('POST', `/v1/clients/${noah.id}/card/test`, { funding: 'credit' });
  assert.deepEqual([cardFunding(app.ctx, maya.id), cardFunding(app.ctx, noah.id)], ['debit', 'credit']);
  const page = (await owner('GET', `/v1/clients/${maya.id}`)).body;
  assert.equal(page.card.funding, 'debit', 'the client page knows');
  // The counter.
  const m = await owner('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: maya.id, items: [{ product_id: single.id }], request_id: 'debit-1' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.deepEqual([m.body.amount_cents, m.body.fee_cents], [8000, 0], 'no fee on the debit card');
  const n = await owner('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: noah.id, items: [{ product_id: single.id }], request_id: 'credit-1' });
  assert.deepEqual([n.body.amount_cents, n.body.fee_cents], [8160, 160], '2% on the credit card');
  // The membership quote shown before Start, and the charge itself.
  const qm = (await owner('GET', `/v1/plans/${plan.id}/quote?client_id=${maya.id}`)).body;
  const qn = (await owner('GET', `/v1/plans/${plan.id}/quote?client_id=${noah.id}`)).body;
  const q0 = (await owner('GET', `/v1/plans/${plan.id}/quote`)).body;
  assert.deepEqual([qm.fee_cents, qm.monthly_fee_cents, qn.fee_cents, q0.fee_cents], [0, 0, 300, 300], 'the quote reads the client\'s card; with no client it shows the fee');
  const sub = await owner('POST', `/v1/clients/${maya.id}/subscription`, { plan_id: plan.id });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.deepEqual([sub.body.first_charge.amount_cents, sub.body.first_charge.fee_cents, sub.body.first_charge.status], [15000, 0, 'paid']);
  const subN = await owner('POST', `/v1/clients/${noah.id}/subscription`, { plan_id: plan.id });
  assert.deepEqual([subN.body.first_charge.amount_cents, subN.body.first_charge.fee_cents], [15300, 300]);
  // The portal store for Maya's family shows no fee; the parent buys a session at the plain price.
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com' }) })).json()).dev_code;
  const ver = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com', code }) });
  const cookie = ver.headers.get('set-cookie').split(';')[0];
  const parent = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { cookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const store = (await parent('GET', '/portal/api/store')).body;
  assert.deepEqual([store.products[0].fee_cents, store.products[0].total_cents, store.plans[0].fee_cents], [0, 8000, 0]);
  await parent('POST', '/portal/api/waiver', { signed_name: 'Ada Okafor', agree: true });
  const bought = await parent('POST', '/portal/api/purchase', { product_id: single.id, athlete_id: maya.id });
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const last = app.ctx.db.get('SELECT amount_cents, fee_cents FROM sales WHERE client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', maya.id);
  assert.deepEqual([last.amount_cents, last.fee_cents], [8000, 0]);
});

test('a card tapped at the counter: the fee is charged, then given back as soon as the card turns out to be debit; Undo still works', async () => {
  const s = (await owner('POST', '/v1/sales', { location_id: facility.id, method: 'tap_to_pay', client_id: noah.id, items: [{ product_id: single.id }], email_receipt: true })).body;
  assert.deepEqual([s.status, s.amount_cents, s.fee_cents], ['pending', 8160, 160], 'the card isn\'t known before the tap, so the fee is shown and charged');
  refunds.length = 0;
  await owner('POST', `/v1/sales/${s.id}/simulate`, { outcome: 'approved', funding: 'debit' });
  const done = (await owner('GET', `/v1/sales/${s.id}`)).body;
  assert.deepEqual([done.status, done.refunded_cents, done.fee_refunded_cents, done.can_undo], ['partially_refunded', 160, 160, true], 'the fee went back; the sale stands and can still be undone');
  assert.deepEqual(refunds.map((r) => [r.amountCents, r.idempotencyKey]), [[160, `fee-refund-${s.id}`]], 'one refund of exactly the fee');
  assert.match(done.refunds[0].reason, /given back: debit card/);
  const ev = app.ctx.db.get(`SELECT data AS payload FROM events WHERE type = 'sale.refunded' ORDER BY rowid DESC LIMIT 1`);
  assert.deepEqual([JSON.parse(ev.payload).fee, JSON.parse(ev.payload).funding], [true, 'debit']);
  // The receipt says so.
  const mail = app.ctx.db.get(`SELECT body FROM outbox WHERE to_email = 'sol@example.com' AND subject LIKE 'Receipt from%' ORDER BY rowid DESC LIMIT 1`);
  assert.match(mail.body, /Card processing fee given back \(debit card\): \$1\.60/);
  const receipt = await pub('GET', `/receipt-api/${done.receipt_url.split('/').pop()}`);
  assert.deepEqual([receipt.body.fee_cents, receipt.body.fee_refunded_cents, receipt.body.refunded_cents], [160, 160, 160]);
  // Undo refunds the rest (never the fee twice).
  refunds.length = 0;
  const undo = await owner('POST', `/v1/sales/${s.id}/undo`);
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.deepEqual([undo.body.status, undo.body.refunded_cents], ['refunded', 8160]);
  assert.deepEqual(refunds.map((r) => r.amountCents), [8000]);
  // A credit card tapped: the fee stays, as before.
  const s2 = (await owner('POST', '/v1/sales', { location_id: facility.id, method: 'tap_to_pay', client_id: noah.id, items: [{ product_id: single.id }] })).body;
  await owner('POST', `/v1/sales/${s2.id}/simulate`, { outcome: 'approved', funding: 'credit' });
  const done2 = (await owner('GET', `/v1/sales/${s2.id}`)).body;
  assert.deepEqual([done2.status, done2.refunded_cents, done2.fee_refunded_cents, done2.can_undo], ['succeeded', 0, 0, true]);
});

test('a pay link paid with a debit card gets the fee back; a credit card keeps it', async () => {
  const link = (await owner('POST', '/v1/pay-links', { kind: 'custom', client_id: noah.id, description: 'Camp deposit', amount_cents: 10000 })).body;
  assert.equal(link.fee_cents, 200, 'the link is made before the card is known, so it carries the fee');
  const tok = link.url.split('/pay/')[1];
  refunds.length = 0;
  const paid = await pub('POST', `/pay-api/${tok}/simulate`, { funding: 'prepaid' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const sale = app.ctx.db.get(`SELECT s.* FROM sales s JOIN pay_links l ON l.sale_id = s.id WHERE l.token = ?`, tok);
  assert.deepEqual([sale.amount_cents, sale.fee_cents, sale.refunded_cents, sale.status], [10200, 200, 200, 'partially_refunded']);
  assert.deepEqual(refunds.map((r) => r.amountCents), [200]);
  const link2 = (await owner('POST', '/v1/pay-links', { kind: 'custom', client_id: noah.id, description: 'Camp balance', amount_cents: 10000 })).body;
  refunds.length = 0;
  await pub('POST', `/pay-api/${link2.url.split('/pay/')[1]}/simulate`, {});
  const sale2 = app.ctx.db.get(`SELECT s.* FROM sales s JOIN pay_links l ON l.sale_id = s.id WHERE l.token = ?`, link2.url.split('/pay/')[1]);
  assert.deepEqual([sale2.amount_cents, sale2.refunded_cents, sale2.status, refunds.length], [10200, 0, 'succeeded', 0]);
});

test('cards saved before the app asked are looked up by the hourly job and before the next charge', async () => {
  // A card on file with no funding on record (saved before version 88), and a provider that can be asked.
  const kai = (await owner('POST', '/v1/clients', { name: 'Kai Brennan', parent: { name: 'Jo Brennan', email: 'jo@example.com' } })).body;
  app.ctx.db.run(`UPDATE families SET card_payment_method = 'pm_old_debit', card_brand = 'visa', card_last4 = '0001', card_funding = NULL WHERE id = ?`, kai.family.id);
  assert.equal(cardFunding(app.ctx, kai.id), null);
  const asked = [];
  app.ctx.payments.getPaymentMethod = async (id) => { asked.push(id); return { brand: 'visa', last4: '0001', funding: id === 'pm_old_debit' ? 'debit' : 'credit' }; };
  try {
    // Before the job runs, the charge itself asks.
    const sub = await owner('POST', `/v1/clients/${kai.id}/subscription`, { plan_id: plan.id });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    assert.deepEqual([sub.body.first_charge.fee_cents, cardFunding(app.ctx, kai.id), asked], [0, 'debit', ['pm_old_debit']]);
    // The job covers the rest, once each.
    app.ctx.db.run(`UPDATE clients SET card_payment_method = 'pm_old_credit', card_funding = NULL WHERE id = ?`, noah.id);   // a client card with no answer on file
    const r = await lookupFundings(app.ctx);
    assert.equal(r.looked_up, 1);
    assert.equal(app.ctx.db.get('SELECT card_funding FROM clients WHERE id = ?', noah.id).card_funding, 'credit');
    assert.deepEqual(await lookupFundings(app.ctx), { looked_up: 0 }, 'nothing left to ask');
  } finally { delete app.ctx.payments.getPaymentMethod; }
});

test('the version 87 upgrade adds the funding columns, the fee flag and the carry-over table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-v87-')), file = join(dir, 'dp.db');
  const raw = new DatabaseSync(file);
  raw.exec(readFileSync('test/fixtures/schema-v87.sql', 'utf8'));
  raw.exec("INSERT INTO families (id, name, card_payment_method, card_brand, card_last4, created_at) VALUES ('fam_old', 'Old family', 'pm_x', 'visa', '4242', '2026-01-01T00:00:00.000Z')");
  raw.exec('PRAGMA user_version = 87');
  raw.close();
  const db = openDb(file);
  assert.equal(db.get('PRAGMA user_version').user_version, 93);
  assert.deepEqual(db.get("SELECT card_payment_method, card_funding FROM families WHERE id = 'fam_old'"), { card_payment_method: 'pm_x', card_funding: null }, 'an old card has no answer yet; the job asks');
  assert.ok(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'visit_carryovers'"));
  assert.ok(db.all('PRAGMA table_info(sale_refunds)').some((c) => c.name === 'fee'));
  assert.ok(db.all('PRAGMA table_info(clients)').some((c) => c.name === 'card_funding'));
  db.close();
});
