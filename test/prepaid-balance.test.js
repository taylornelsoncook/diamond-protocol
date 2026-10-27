// The prepaid balance (schema 95, owner's ask: "a lump sum payment to an athlete's account that they can work off of:
// a parent pays $1000, then they get charged per session and it comes out of that total, or a package comes off it").
// A deposit is a sale (deposit_cents) credited to the family's balance; a sale with method balance spends it; bookings
// come out of it after the membership and pack sessions; refunds go back on it; the owner adjusts it by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { addTestCard } from '../src/services/commerce.js';
import { localDate, addDaysToDate } from '../src/util.js';

const TZ = 'America/Chicago';
let app, base, owner, coach, desk, maria, facility, ava, ben, solo, pack, shirt;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const balance = async (c) => (await owner('GET', `/v1/clients/${c.id}/prepaid`)).body.balance;
const sale = (body, who = owner) => who('POST', '/v1/sales', { location_id: facility.id, ...body });
const day = (n) => addDaysToDate(localDate(new Date().toISOString(), TZ), n);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.test' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dee Desk', password: 'desk-password-1', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1'); coach = await signIn('coach@test.dev', 'coach-password-1'); desk = await signIn('desk@test.dev', 'desk-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ, card_fee_on: 'counter,store', card_fee_pct: 3, card_fee_flat: 30 });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2013-03-10', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Ben Lopez', birth_date: '2015-06-01' })).body;
  solo = (await owner('POST', '/v1/clients', { name: 'Sam Solo', birth_date: '2004-01-01', email: 'sam@example.com', emailOptional: true })).body;
  pack = (await owner('POST', '/v1/products', { name: '5 private sessions', kind: 'pack', price_cents: 30000, sessions: 5, credit_type: 'private' })).body;
  shirt = (await owner('POST', '/v1/products', { name: 'Shirt', kind: 'gear', price_cents: 2500 })).body;
  app.ctx.db.run('UPDATE families SET waiver_version = 1 WHERE id = ?', ava.family.id);
  const { body } = await req('POST', '/portal/api/login', { email: 'maria@example.com' });
  maria = as((await req('POST', '/portal/api/verify', { email: 'maria@example.com', code: body.dev_code })).cookie);
});
after(() => app.server.close());

test('a deposit at the counter goes on the family balance; siblings share it; it shows everywhere', async () => {
  assert.equal(await balance(ava), 0);
  const dep = await sale({ method: 'cash', client_id: ava.id, deposit_cents: 100000 });
  assert.equal(dep.status, 201, JSON.stringify(dep.body));
  assert.equal(dep.body.status, 'succeeded'); assert.equal(dep.body.deposit_cents, 100000);
  assert.equal(dep.body.items[0].name, 'Prepaid balance (added to the account)');
  assert.equal(await balance(ava), 100000);
  assert.equal(await balance(ben), 100000, 'a sibling shares the family balance');
  const p = (await owner('GET', `/v1/clients/${ava.id}/prepaid`)).body;
  assert.equal(p.shared, true); assert.deepEqual([p.entries[0].kind, p.entries[0].delta, p.entries[0].sale_id], ['deposit', 100000, dep.body.id]);
  assert.equal((await owner('GET', `/v1/clients/${ava.id}`)).body.prepaid.balance, 100000);
  assert.equal((await owner('GET', '/v1/clients')).body.data.find((c) => c.id === ben.id).prepaid_balance, 100000);
  // Front desk runs the counter, so the balance is visible to it (not a _cents field).
  assert.equal((await desk('GET', `/v1/clients/${ava.id}`)).body.prepaid_balance, 100000);
  assert.equal((await desk('GET', `/v1/clients/${ava.id}/prepaid`)).body.balance, 100000);
  // The parent sees it in the portal.
  const me = (await maria('GET', '/portal/api/me')).body;
  assert.equal(me.athletes.find((a) => a.id === ava.id).prepaid_cents, 100000);
  assert.equal((await maria('GET', '/portal/api/store')).body.prepaid_cents, 100000);
  // The deposit is money taken today; nothing else is.
  const t = (await owner('GET', '/v1/sales/takings')).body;
  assert.equal(t.taken_cents, 100000); assert.equal(t.deposits_cents, 100000); assert.equal(t.prepaid_used_cents, 0);
  // Rules: a deposit is a sale of its own, needs a client, is never discounted and never paid from the balance.
  assert.equal((await sale({ method: 'cash', deposit_cents: 5000 })).status, 400);
  assert.match((await sale({ method: 'cash', client_id: ava.id, deposit_cents: 5000, items: [{ product_id: shirt.id }] })).body.error.message, /sale of its own/);
  assert.match((await sale({ method: 'cash', client_id: ava.id, deposit_cents: 5000, discount: { type: 'percent', value: 10, reason: 'x' } })).body.error.message, /can't be discounted/);
  assert.match((await sale({ method: 'balance', client_id: ava.id, deposit_cents: 5000 })).body.error.message, /can't be added from the balance/);
  assert.equal((await sale({ method: 'cash', client_id: ava.id, deposit_cents: 2000000 })).status, 400, 'over $10,000 at a time');
});

test('a sale paid from the balance takes from it, with no card fee; too little is 402; it is never money in', async () => {
  const s = await sale({ method: 'balance', client_id: ben.id, items: [{ product_id: pack.id }] }, desk);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual([s.body.status, s.body.method, s.body.method_label, s.body.amount_cents, s.body.fee_cents], ['succeeded', 'balance', 'Prepaid balance', 30000, 0]);
  assert.equal(await balance(ava), 70000);
  assert.equal((await owner('GET', `/v1/clients/${ben.id}`)).body.credits.private, 5, 'the pack was added as usual');
  const no = await sale({ method: 'balance', client_id: ava.id, custom: { description: 'Camp', amount_cents: 80000 } });
  assert.equal(no.status, 402); assert.equal(no.body.error.code, 'insufficient_balance'); assert.match(no.body.error.message, /\$700 and this sale is \$800/);
  assert.equal(await balance(ava), 70000, 'nothing taken');
  assert.equal((await sale({ method: 'balance', custom: { description: 'Walk-in', amount_cents: 100 } })).status, 400, 'needs a client');
  const t = (await owner('GET', '/v1/sales/takings')).body;
  assert.equal(t.taken_cents, 100000, 'the pack sale is not money taken'); assert.equal(t.prepaid_used_cents, 30000);
  assert.ok(t.by_method.some((m) => m.method === 'balance' && m.sales === 1));
});

test('money in counts the deposit once: billing.moneyIn leaves balance sales and their refunds out', async () => {
  const { moneyIn } = await import('../src/services/billing.js');
  const from = new Date(Date.now() - 3600000).toISOString(), to = new Date(Date.now() + 3600000).toISOString();
  assert.equal(moneyIn(app.ctx, from, to).sales, 100000);
});

test('a booking comes out of the balance after the membership and pack sessions; cancelling puts it back', async () => {
  const klass = (await owner('POST', '/v1/sessions', { name: 'Speed', kind: 'group', location_id: facility.id, date: day(3), start_time: '10:00', duration_min: 60, capacity: 10, drop_in_cents: 2500 })).body;
  // Ben has pack sessions (private), the class is a group class: no group credit, no membership, so the balance pays.
  const b = await owner('POST', `/v1/sessions/${klass.id}/bookings`, { client_id: ben.id });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.coverage, 'paid'); assert.ok(b.body.sale_id);
  assert.equal(await balance(ava), 67500);
  const s = (await owner('GET', `/v1/sales/${b.body.sale_id}`)).body;
  assert.equal(s.method, 'balance'); assert.equal(s.fee_cents, 0);
  // Cancelled: the sale is refunded, so the money goes back on the balance.
  assert.equal((await owner('POST', `/v1/bookings/${b.body.id}/cancel`)).status, 200);
  assert.equal(await balance(ava), 70000);
  assert.equal((await owner('GET', `/v1/sales/${b.body.sale_id}`)).body.status, 'refunded');
  // A parent booking from the portal: the balance pays, not the card.
  await addTestCard(app.ctx, ava.id);
  const pb = await maria('POST', '/portal/api/bookings', { session_id: klass.id, athlete_id: ava.id, pay: 'card_on_file' });
  assert.ok([200, 201].includes(pb.status), JSON.stringify(pb.body));
  assert.equal((await owner('GET', `/v1/sales/${pb.body.sale_id}`)).body.method, 'balance');
  assert.equal(await balance(ava), 67500);
  // A portal pack purchase comes off the balance when it covers it; otherwise the card (with its fee).
  const buy = await maria('POST', '/portal/api/purchase', { product_id: pack.id, athlete_id: ava.id });
  assert.equal(buy.status, 200, JSON.stringify(buy.body)); assert.equal(buy.body.sale.method, 'balance'); assert.equal(buy.body.sale.fee_cents, 0);
  assert.equal(await balance(ava), 37500);
  const buy2 = await maria('POST', '/portal/api/purchase', { product_id: pack.id, athlete_id: ava.id });
  assert.equal(buy2.status, 200, JSON.stringify(buy2.body)); assert.equal(buy2.body.sale.method, 'balance');
  assert.equal(await balance(ava), 7500);
  const buy3 = await maria('POST', '/portal/api/purchase', { product_id: pack.id, athlete_id: ava.id });
  assert.equal(buy3.status, 200, JSON.stringify(buy3.body)); assert.equal(buy3.body.sale.method, 'card_on_file'); assert.ok(buy3.body.sale.fee_cents > 0);
  assert.equal(await balance(ava), 7500, 'the card paid: the balance is untouched');
});

test('refunds: a balance sale goes back on; a deposit comes off, but only what is still there; undo too', async () => {
  const s = await sale({ method: 'balance', client_id: ava.id, items: [{ product_id: shirt.id }] });
  assert.equal(s.status, 201); assert.equal(await balance(ava), 5000);
  const r = await owner('POST', `/v1/sales/${s.body.id}/refund`, { amount_cents: 1000, reason: 'Wrong size' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(await balance(ava), 6000);
  // Undo a balance sale (the person who took it, within 10 minutes): all of it back.
  const u = await sale({ method: 'balance', client_id: ava.id, items: [{ product_id: shirt.id }] });
  assert.equal((await owner('POST', `/v1/sales/${u.body.id}/undo`)).status, 200);
  assert.equal(await balance(ava), 6000);
  // A deposit by card (the fee rides on top): refunding it takes it off the balance; more than is left is refused.
  const dep = await sale({ method: 'card_on_file', client_id: ava.id, deposit_cents: 10000 });
  assert.equal(dep.status, 201, JSON.stringify(dep.body)); assert.equal(dep.body.amount_cents, 10330); assert.equal(await balance(ava), 16000);
  await sale({ method: 'balance', client_id: ava.id, custom: { description: 'Session', amount_cents: 15000 } });
  assert.equal(await balance(ava), 1000);
  const tooMuch = await owner('POST', `/v1/sales/${dep.body.id}/refund`, { amount_cents: 10000 });
  assert.equal(tooMuch.status, 409); assert.match(tooMuch.body.error.message, /Only \$10 of this deposit is still on the account/);
  assert.equal(await balance(ava), 1000);
  const part = await owner('POST', `/v1/sales/${dep.body.id}/refund`, { amount_cents: 800, reason: 'Moving away' });
  assert.equal(part.status, 200, JSON.stringify(part.body)); assert.equal(await balance(ava), 200);
  const entries = (await owner('GET', `/v1/clients/${ava.id}/prepaid`)).body.entries;
  assert.deepEqual([entries[0].kind, entries[0].delta, entries[0].note], ['refund', -800, 'Deposit refunded: Moving away']);
});

test('the owner adjusts by hand with a note; coaches and front desk cannot; an athlete with no family has their own', async () => {
  const a = await owner('POST', `/v1/clients/${ava.id}/prepaid/adjust`, { amount_cents: 2500, note: 'Paid by check at the field' });
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.balance, 2700);
  assert.equal((await owner('POST', `/v1/clients/${ava.id}/prepaid/adjust`, { amount_cents: 500 })).status, 400, 'a note is needed');
  assert.equal((await owner('POST', `/v1/clients/${ava.id}/prepaid/adjust`, { amount_cents: -9000, note: 'oops' })).status, 402, 'never below zero');
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/prepaid/adjust`, { amount_cents: 100, note: 'x' })).status, 403);
  assert.equal((await desk('POST', `/v1/clients/${ava.id}/prepaid/adjust`, { amount_cents: 100, note: 'x' })).status, 403);
  assert.equal((await owner('POST', '/v1/clients/cl_nope/prepaid/adjust', { amount_cents: 100, note: 'x' })).status, 404);
  const own = await owner('POST', `/v1/clients/${solo.id}/prepaid/adjust`, { amount_cents: 5000, note: 'Cash at the park' });
  assert.equal(own.status, 200, JSON.stringify(own.body)); assert.equal(own.body.shared, false); assert.equal(own.body.balance, 5000);
  assert.equal(await balance(ava), 2700, 'another account');
  // The family export lists the ledger lines.
  const exp = (await owner('GET', `/v1/families/${ava.family.id}/export`)).body;
  assert.ok(exp.athletes.find((k) => k.id === ava.id || k.name === 'Ava Lopez').prepaid_funds.some((e) => e.kind === 'adjust' && e.delta_cents === 2500));
});

test('a version 94 database gains the ledger and the balance method, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v94-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v94.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 94');
    old.exec(`INSERT INTO locations (id, name, kind, country, active, created_at) VALUES ('loc1', 'Gym', 'facility', 'US', 1, '2026-01-01T00:00:00.000Z')`);
    old.exec(`INSERT INTO sales (id, location_id, method, status, amount_cents, created_at, completed_at, receipt_token) VALUES ('sale1', 'loc1', 'cash', 'succeeded', 1000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'tok1')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 95, `round ${round}`);
      assert.ok(d.all('PRAGMA table_info(sales)').some((c) => c.name === 'deposit_cents'));
      assert.equal(d.get('SELECT amount_cents, deposit_cents FROM sales WHERE id = ?', 'sale1').deposit_cents, 0, 'the sale survived the rebuild');
      d.run(`INSERT INTO sales (id, location_id, method, status, amount_cents, created_at, receipt_token) VALUES (?, 'loc1', 'balance', 'succeeded', 500, '2026-01-02T00:00:00.000Z', ?)`, `s${round}`, `t${round}`);
      assert.ok(d.all(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sales'`).some((i) => i.name === 'sales_receipt'), 'the indexes came back');
      assert.ok(d.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_funds'`).length);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
