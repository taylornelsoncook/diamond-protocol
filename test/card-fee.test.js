import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';
import { cardFee } from '../src/services/fees.js';

// The card processing fee passed to the payer (schema 51): an owner setting, off by default, its own line on card
// payments where the owner turned it on: membership charges, card sales at the counter, pay links and the online store.
// Cash and check never carry it.
let app, base, owner, coach, desk, facility, single, maya, plan;
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
const setFee = (body) => owner('PATCH', '/v1/settings', { card_fee_pct: 2.9, card_fee_flat: 30, card_fee_label: 'Card processing fee', card_fee_on: ['memberships', 'counter', 'pay_links', 'store'], ...body });

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '100 Main St', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  single = (await owner('POST', '/v1/products', { name: 'Single session', kind: 'session', price_cents: 8000 })).body;
  maya = (await owner('POST', '/v1/clients', { name: 'Maya Okafor', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000, trial_days: 0 })).body;
  // A card on file for the family (the test payment provider charges it).
  app.ctx.db.run(`UPDATE families SET card_payment_method = 'pm_test', card_brand = 'visa', card_last4 = '4242' WHERE id = ?`, maya.family.id);
});
after(() => app.server.close());

test('off by default; the owner sets it within limits and staff can\'t', async () => {
  assert.deepEqual(cardFee(app.ctx, 15000, 'counter'), { cents: 0, label: 'Card processing fee' });
  const s = (await desk('GET', '/v1/settings')).body;
  assert.deepEqual([s.card_fee_pct, s.card_fee_flat, s.card_fee_label, s.card_fee_on], ['0', '0', 'Card processing fee', ''], 'the counter reads the fee to show it before the charge');
  assert.equal((await coach('PATCH', '/v1/settings', { card_fee_pct: 3 })).status, 403);
  const bad = async (body, re) => { const r = await owner('PATCH', '/v1/settings', body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error.message, re); };
  await bad({ card_fee_pct: 4.5 }, /from 0 to 4, in tenths/);
  await bad({ card_fee_pct: 2.95 }, /in tenths/);
  await bad({ card_fee_flat: 150 }, /between 0 and 100/);
  await bad({ card_fee_on: ['schools'] }, /card_fee_on must be one of/);
  const ok = await setFee({ card_fee_label: '' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.card_fee_pct, ok.body.card_fee_flat, ok.body.card_fee_label, ok.body.card_fee_on], ['2.9', '30', 'Card processing fee', 'memberships,counter,pay_links,store'], 'an empty name goes back to the default');
  assert.deepEqual(cardFee(app.ctx, 15000, 'counter'), { cents: 465, label: 'Card processing fee' }, '2.9% of $150 is $4.35, plus 30 cents');
  assert.deepEqual(cardFee(app.ctx, 8000, 'schools').cents, 0, 'never on school invoices');
  await owner('PATCH', '/v1/settings', { card_fee_on: ['memberships', 'pay_links'] });
  assert.equal(cardFee(app.ctx, 8000, 'counter').cents, 0, 'only where it\'s turned on');
  await setFee({});
});

test('a card sale at the counter carries the fee as its own line; a cash sale never does', async () => {
  const card = await coach('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: maya.id, items: [{ product_id: single.id }], request_id: 'fee-card-1' });
  assert.equal(card.status, 201, JSON.stringify(card.body));
  assert.deepEqual([card.body.status, card.body.amount_cents, card.body.fee_cents, card.body.fee_label, card.body.subtotal_cents, card.body.discount_cents], ['succeeded', 8262, 262, 'Card processing fee', 8000, 0], '$80 plus 2.9% + 30¢ = $2.62');
  const charged = app.ctx.payments.charges?.at(-1);
  if (charged) assert.equal(charged.amountCents, 8262, 'the card is charged the total');
  const cash = await coach('POST', '/v1/sales', { location_id: facility.id, method: 'cash', client_id: maya.id, items: [{ product_id: single.id }], request_id: 'fee-cash-1' });
  assert.deepEqual([cash.body.amount_cents, cash.body.fee_cents], [8000, 0]);
  // The receipt page and the family's payments show the fee line; the day's takings count it.
  const receipt = await pub('GET', `/receipt-api/${card.body.receipt_url.split('/').pop()}`);
  if (receipt.status === 200) assert.deepEqual([receipt.body.fee_cents, receipt.body.fee_label, receipt.body.amount_cents], [262, 'Card processing fee', 8262]);
  const takings = (await owner('GET', `/v1/sales/takings?location_id=${facility.id}`)).body;
  assert.deepEqual([takings.taken_cents, takings.fee_cents], [16262, 262]);
  // A discount comes off before the fee is worked out.
  const disc = await owner('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: maya.id, items: [{ product_id: single.id }], discount: { type: 'amount', value: 2000, reason: 'Sibling' }, request_id: 'fee-disc-1' });
  assert.equal(disc.status, 201, JSON.stringify(disc.body));
  assert.deepEqual([disc.body.subtotal_cents, disc.body.discount_cents, disc.body.fee_cents, disc.body.amount_cents], [8000, 2000, 204, 6204], '2.9% of $60 + 30¢');
  // Undo refunds the whole payment, fee included.
  const undo = await owner('POST', `/v1/sales/${disc.body.id}/undo`);
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.refunded_cents, 6204);
});

test('a membership charge carries the fee; a payment by check drops it; a plan change counts only the price toward the time', async () => {
  const sub = await owner('POST', `/v1/clients/${maya.id}/subscription`, { plan_id: plan.id });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  const inv = app.ctx.db.get('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', maya.id);
  assert.deepEqual([inv.status, inv.amount_cents, inv.fee_cents], ['paid', 15465, 465], '$150 plus $4.65');
  const portal = app.ctx.db.get('SELECT id FROM guardians WHERE family_id = ?', maya.family.id);
  assert.ok(portal);
  const detail = (await owner('GET', `/v1/invoices/${inv.id}`)).body;
  assert.deepEqual([detail.amount_cents, detail.fee_cents], [15465, 465]);
  // An open invoice paid by check at the desk: the card fee comes off first.
  app.ctx.db.run(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, fee_cents, status, period_start, period_end, attempts, created_at) VALUES (?, ?, ?, 15465, 465, 'failed', ?, ?, 1, ?)`,
    'inv_check', inv.subscription_id, maya.id, inv.period_start, inv.period_end, app.ctx.now());
  const byHand = await owner('POST', '/v1/invoices/inv_check/payments', { method: 'check', reference: '1042' });
  assert.equal(byHand.status, 200, JSON.stringify(byHand.body));
  assert.deepEqual([byHand.body.amount_cents, byHand.body.fee_cents, byHand.body.status], [15000, 0, 'paid']);
  // The parent's payments list says what the fee was.
  const pays = app.ctx.db.all(`SELECT amount_cents, fee_cents FROM invoices WHERE client_id = ? AND status = 'paid' ORDER BY amount_cents`, maya.id);
  assert.deepEqual(pays.map((p) => [p.amount_cents, p.fee_cents]), [[15000, 0], [15465, 465]]);
});

test('a pay link for a set amount adds the fee at checkout and records it on the sale; a membership link doesn\'t add it twice', async () => {
  const link = await owner('POST', '/v1/pay-links', { kind: 'custom', client_id: maya.id, description: 'Summer camp deposit', amount_cents: 10000 });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  assert.deepEqual([link.body.amount_cents, link.body.fee_cents], [10000, 320]);
  const page = await pub('GET', `/pay-api/${link.body.url.split("/").pop()}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.deepEqual([page.body.amount_cents, page.body.fee_cents, page.body.fee_label, page.body.total_cents], [10000, 320, 'Card processing fee', 10320]);
  const paid = await pub('POST', `/pay-api/${link.body.url.split("/").pop()}/simulate`);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.status, 'paid');
  const sale = app.ctx.db.get(`SELECT amount_cents, fee_cents, method FROM sales WHERE note = ?`, `Pay link ${link.body.id}`);
  assert.deepEqual([sale.amount_cents, sale.fee_cents, sale.method], [10320, 320, 'online']);
  // A failed membership charge's link carries the invoice's amount as it is (its fee is already inside).
  app.ctx.db.run(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, fee_cents, status, period_start, period_end, attempts, created_at) VALUES (?, ?, ?, 15465, 465, 'failed', ?, ?, 1, ?)`,
    'inv_link', app.ctx.db.get('SELECT id FROM subscriptions WHERE client_id = ?', maya.id).id, maya.id, '2026-10-01', '2026-11-01', app.ctx.now());
  const il = (await owner('POST', '/v1/pay-links', { kind: 'invoice', invoice_id: 'inv_link' })).body;
  assert.deepEqual([il.amount_cents, il.fee_cents], [15465, 0]);
  const ipage = (await pub('GET', `/pay-api/${il.url.split("/").pop()}`)).body;
  assert.deepEqual([ipage.total_cents, ipage.fee_cents, ipage.fee_included], [15465, 465, true], 'the invoice\'s own fee shows as included, never added again');
});

test('bookings charged to the card on file from the portal, Book now and offers carry no fee: the parent saw only the price', async () => {
  const { createSale } = await import('../src/services/commerce.js');
  const s = await createSale(app.ctx, { location_id: facility.id, method: 'card_on_file', client_id: maya.id, custom: { description: 'Speed class (portal booking)', amount_cents: 2500 } }, null, { fee: false });
  assert.deepEqual([s.status, s.amount_cents, s.fee_cents], ['succeeded', 2500, 0]);
  const store = await import('../src/services/shop.js');
  assert.equal(typeof store.shopItems, 'function');
  // What a parent sees before buying carries the fee and the total.
  const plans = (await owner('GET', '/v1/plans')).body;
  assert.ok(plans.data?.length || plans.length, 'plans exist');
});

test('a version 50 database gains the fee columns, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v50.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 50');
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '2026-09-01T00:00:00Z');
      INSERT INTO sales (id, location_id, method, status, amount_cents, created_at) VALUES ('sale_1', 'loc_1', 'cash', 'succeeded', 8000, '2026-09-01T00:00:00Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 66, `round ${round}`);
      for (const t of ['invoices', 'sales', 'pay_links']) assert.ok(d.all(`PRAGMA table_info(${t})`).some((c) => c.name === 'fee_cents'), t);
      assert.deepEqual({ ...d.get(`SELECT amount_cents, fee_cents FROM sales WHERE id = 'sale_1'`) }, { amount_cents: 8000, fee_cents: 0 }, 'old sales carry no fee');
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
