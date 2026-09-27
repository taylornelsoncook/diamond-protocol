// Point of sale: discounts, receipts, undo, the day's takings, sale filters, reader locations and role limits.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-pos-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const { get, all, run, insert } = require('../server/db');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), put: (p, b = {}) => req('PUT', p, b), del: (p) => req('DELETE', p),
    login: (email, password) => req('POST', '/api/auth/staff/login', { email, password }) };
}
async function as(email, pw) { const c = client(); const r = await c.login(email, pw); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }
const owner = () => as('owner@demo.test', 'demo-owner-2026');
const coach = () => as('coach@demo.test', 'demo-coach-2026');
const desk = () => as('desk@demo.test', 'demo-desk-2026');
const athlete = (first, last) => get('SELECT * FROM athletes WHERE first_name=? AND last_name=?', first, last);
const facility = () => get("SELECT id FROM locations WHERE kind='facility'").id;
const product = (kind) => get('SELECT * FROM products WHERE kind=? AND archived=0 ORDER BY id LIMIT 1', kind);

test('schema upgrade: sales carry a discount and a receipt time', () => {
  const cols = all('PRAGMA table_info(sales)').map((c) => c.name);
  assert.ok(cols.includes('discount_cents'));
  assert.ok(cols.includes('receipt_sent_at'));
});

test('discounts: percent or amount, validated on the server, logged', async () => {
  const d = await desk();
  const gear = product('gear'), pack = product('group_pack');
  const ava = athlete('Ava', 'Lopez');
  const base = { location_id: facility(), athlete_id: ava.id, method: 'cash', items: [{ product_id: pack.id }, { product_id: gear.id, qty: 2 }] };
  const sub = pack.price_cents + gear.price_cents * 2;
  const before = get('SELECT COUNT(*) n FROM sales').n;
  for (const bad of [{ type: 'pct', value: 0 }, { type: 'pct', value: 100 }, { type: 'pct', value: 12.5 }, { type: 'amount', value: 0 }, { type: 'amount', value: sub }, { type: 'free', value: 5 }]) {
    const r = await d.post('/api/sales', { ...base, discount: bad });
    assert.equal(r.status, 400, `discount ${JSON.stringify(bad)} is refused`);
  }
  assert.equal(get('SELECT COUNT(*) n FROM sales').n, before, 'refused discounts leave no sale');

  const r = await d.post('/api/sales', { ...base, discount: { type: 'pct', value: 10, reason: 'Sibling' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const off = Math.round(sub * 0.1);
  assert.equal(r.data.sale.total_cents, sub - off);
  assert.equal(r.data.sale.discount_cents, off);
  const line = r.data.sale.items.find((i) => i.kind === 'discount');
  assert.equal(line.price_cents, -off);
  assert.match(line.name, /10% \(Sibling\)/);
  const inv = get("SELECT * FROM invoices WHERE charge_id=(SELECT charge_id FROM sales WHERE id=?)", r.data.sale.id);
  assert.equal(inv.amount_cents, sub - off, 'Billing records what was actually paid');
  assert.match(inv.description, /discount/);
  assert.ok(get("SELECT 1 FROM activity WHERE action='Gave discount' AND detail LIKE '%Sibling%'"));

  const amt = await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: gear.id }], discount: { type: 'amount', value: 300 } });
  assert.equal(amt.status, 200);
  assert.equal(amt.data.sale.total_cents, gear.price_cents - 300);
});

test('receipts: emailed at the counter or later, to the family by default', async () => {
  const d = await desk();
  const gear = product('gear');
  const ava = athlete('Ava', 'Lopez');
  const count = get('SELECT COUNT(*) n FROM sales').n;
  const walk = await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: gear.id }], email_receipt: true });
  assert.equal(walk.status, 400, 'a walk-in receipt needs an address');
  assert.equal(get('SELECT COUNT(*) n FROM sales').n, count, 'nothing is charged when the receipt address is missing');
  const bad = await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: gear.id }], email_receipt: true, receipt_email: 'not-an-email' });
  assert.equal(bad.status, 400);

  const r = await d.post('/api/sales', { location_id: facility(), athlete_id: ava.id, method: 'cash', items: [{ product_id: gear.id }], email_receipt: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.receipt_to, 'maria.lopez@example.com');
  assert.match(r.data.message, /Receipt sent to maria\.lopez@example\.com/);
  const mail = get("SELECT * FROM outbox WHERE to_email='maria.lopez@example.com' ORDER BY id DESC LIMIT 1");
  assert.match(mail.subject, /receipt/i);
  assert.match(mail.body, new RegExp(gear.name));
  assert.match(mail.body, /\/invoice\//, 'links to the printable receipt');
  assert.ok(get('SELECT receipt_sent_at FROM sales WHERE id=?', r.data.sale.id).receipt_sent_at);

  const again = await d.post(`/api/sales/${r.data.sale.id}/receipt`, { email: 'grandma@example.com' });
  assert.equal(again.status, 200);
  assert.ok(get("SELECT 1 FROM outbox WHERE to_email='grandma@example.com'"));
  assert.equal((await d.post(`/api/sales/${r.data.sale.id}/receipt`, { email: 'nope' })).status, 400);
  const walkIn = await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: gear.id }] });
  assert.equal((await d.post(`/api/sales/${walkIn.data.sale.id}/receipt`, {})).status, 400, 'a walk-in without an address');
  // Coaches can only reach their own sales.
  assert.equal((await (await coach()).post(`/api/sales/${r.data.sale.id}/receipt`, { email: 'x@example.com' })).status, 404);
});

test('undo: the person who took a sale can undo it for 10 minutes, taking credits back', async () => {
  const d = await desk();
  const o = await owner();
  const pack = product('group_pack');
  const iso = athlete('Isabela', 'Silva');
  const credits = get('SELECT group_credits FROM athletes WHERE id=?', iso.id).group_credits;
  const r = await d.post('/api/sales', { location_id: facility(), athlete_id: iso.id, method: 'tap', items: [{ product_id: pack.id }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.sale.can_undo, true);
  assert.equal(get('SELECT group_credits FROM athletes WHERE id=?', iso.id).group_credits, credits + pack.credits);
  const other = await o.post(`/api/sales/${r.data.sale.id}/undo`);
  assert.equal(other.status, 400, 'only the person who took it');
  assert.match(other.data.error, /Refund it instead/);
  assert.equal((await (await coach()).post(`/api/sales/${r.data.sale.id}/undo`)).status, 404, 'coaches cannot reach other people\'s sales');
  const u = await d.post(`/api/sales/${r.data.sale.id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.data));
  const after = get('SELECT * FROM sales WHERE id=?', r.data.sale.id);
  assert.equal(after.status, 'refunded');
  assert.equal(after.refunded_cents, after.total_cents);
  assert.equal(get('SELECT group_credits FROM athletes WHERE id=?', iso.id).group_credits, credits);
  assert.ok(get("SELECT 1 FROM invoices WHERE number LIKE 'RF-%' AND athlete_id=?", iso.id), 'the card is refunded');
  assert.ok(get("SELECT 1 FROM activity WHERE action='Undid sale'"));
  assert.equal((await d.post(`/api/sales/${r.data.sale.id}/undo`)).status, 400, 'no double undo');

  const old = await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: product('gear').id }] });
  run("UPDATE sales SET created_at=datetime('now','-11 minutes') WHERE id=?", old.data.sale.id);
  const late = await d.post(`/api/sales/${old.data.sale.id}/undo`);
  assert.equal(late.status, 400);
  assert.match(late.data.error, /10 minutes/);
  const listed = (await d.get('/api/sales?days=1')).data.find((s) => s.id === old.data.sale.id);
  assert.equal(listed.can_undo, false);
});

test('refund reasons land in the activity log', async () => {
  const d = await desk();
  const o = await owner();
  const s = await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: product('gear').id }] });
  const r = await o.post(`/api/sales/${s.data.sale.id}/refund`, { reason: 'Wrong size' });
  assert.equal(r.status, 200);
  assert.ok(get("SELECT 1 FROM activity WHERE action='Refunded sale' AND detail LIKE '%Wrong size%'"));
});

test('today\'s takings: owners and front desk see them by payment method, coaches never do', async () => {
  const d = await desk();
  const o = await owner();
  const c = await coach();
  assert.equal((await c.get('/api/sales/summary')).status, 403);
  const before = (await d.get(`/api/sales/summary?location_id=${facility()}`)).data;
  const gear = product('gear');
  await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: gear.id, qty: 2 }] });
  await d.post('/api/sales', { location_id: facility(), method: 'tap', items: [{ product_id: gear.id }] });
  const after = (await o.get(`/api/sales/summary?location_id=${facility()}`)).data;
  assert.equal(after.count, before.count + 2);
  const cash = (x) => x.by_method.find((m) => m.method === 'cash');
  assert.equal(cash(after).net_cents, cash(before).net_cents + gear.price_cents * 2);
  assert.equal(after.cash_cents, cash(after).net_cents);
  assert.equal(after.net_cents, after.taken_cents - after.refunded_cents);
  const all = (await o.get('/api/sales/summary')).data;
  assert.ok(all.count >= after.count, 'all locations include this one');
  assert.equal((await o.get('/api/sales/summary?location_id=99999')).status, 404);
  const past = (await o.get('/api/sales/summary?date=2001-01-01')).data;
  assert.equal(past.count, 0);
});

test('sales list: coaches see only their own; filters by method, location and search', async () => {
  const c = await coach();
  const d = await desk();
  const coachId = get("SELECT id FROM staff WHERE email='coach@demo.test'").id;
  const mine = (await c.get('/api/sales?days=366')).data;
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((s) => s.staff_id === coachId), 'coaches only see sales they took');
  const deskSale = get("SELECT s.id FROM sales s JOIN staff st ON st.id=s.staff_id WHERE st.role='frontdesk' LIMIT 1").id;
  assert.equal((await c.get(`/api/sales/${deskSale}`)).status, 404);
  assert.equal((await d.get(`/api/sales/${deskSale}`)).status, 200);

  assert.equal((await d.get('/api/sales?method=bitcoin')).status, 400);
  const cash = (await d.get('/api/sales?days=30&method=cash')).data;
  assert.ok(cash.length && cash.every((s) => s.method === 'cash'));
  const park = get("SELECT id FROM locations WHERE kind='park'").id;
  const atPark = (await d.get(`/api/sales?days=30&location_id=${park}`)).data;
  assert.ok(atPark.length && atPark.every((s) => s.location_id === park));
  const olivia = (await d.get('/api/sales?days=30&q=Olivia')).data;
  assert.ok(olivia.length && olivia.every((s) => s.who.startsWith('Olivia')));
  const byItem = (await d.get('/api/sales?days=30&q=parachute')).data;
  assert.ok(byItem.length && byItem.every((s) => s.items.some((i) => /parachute/i.test(i.name))));
  const seeded = (await d.get('/api/sales?days=30&q=Nate')).data[0];
  assert.ok(seeded.discount_cents > 0 && seeded.receipt_sent_at, 'the demo shows a discounted sale with a receipt');
});

test('front-desk readers take payments only at their own location', async () => {
  const d = await desk();
  const park = get("SELECT id FROM locations WHERE kind='park'").id;
  const gear = product('gear');
  const r = await d.post('/api/sales', { location_id: park, method: 'reader', items: [{ product_id: gear.id }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /No front-desk reader is registered at/);
  assert.equal((await d.post('/api/sales', { location_id: facility(), method: 'reader', items: [{ product_id: gear.id }] })).status, 200);
  const plan = get('SELECT id FROM plans WHERE active=1 LIMIT 1').id;
  const fid = insert('families', { name: 'Reader family' });
  const aid = insert('athletes', { code: 'READER2026', family_id: fid, first_name: 'Rhea', last_name: 'Reader' });
  const m = await d.post('/api/sales/membership', { location_id: park, athlete_id: aid, plan_id: plan, method: 'reader' });
  assert.equal(m.status, 400);
  assert.match(m.data.error, /No front-desk reader is registered at/);
});

test('who you are with: membership and receipt email come back for the counter', async () => {
  const d = await desk();
  const ava = athlete('Ava', 'Lopez');
  const r = await d.get(`/api/pos/client/${ava.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.email, 'maria.lopez@example.com');
  assert.ok(r.data.membership?.plan_name, 'Ava is a member in the demo');
});

test('setup: duplicate names are refused and archived locations and products come back', async () => {
  const c = await coach();
  const d = await desk();
  const locs = get("SELECT * FROM locations WHERE kind='park'");
  const fac = get("SELECT * FROM locations WHERE kind='facility'");
  assert.equal((await c.put(`/api/locations/${locs.id}`, { name: fac.name.toUpperCase() })).status, 400);
  const tmpLoc = await c.post('/api/locations', { name: 'Old field', kind: 'park' });
  await c.put(`/api/locations/${tmpLoc.data.id}`, { archived: true });
  const clash = await c.post('/api/locations', { name: 'Old field', kind: 'park' });
  assert.equal(clash.status, 200, 'an archived name can be reused');
  assert.equal((await c.put(`/api/locations/${tmpLoc.data.id}`, { archived: false })).status, 400, 'restoring into a name clash is refused');
  await c.put(`/api/locations/${clash.data.id}`, { name: 'New field' });
  const back = await c.put(`/api/locations/${tmpLoc.data.id}`, { archived: false });
  assert.equal(back.status, 200);
  assert.equal(back.data.location.archived, 0);

  const gear = product('gear');
  assert.equal((await c.post('/api/products', { name: gear.name.toLowerCase(), kind: 'gear', price_cents: 100 })).status, 400);
  assert.equal((await c.post('/api/products', { name: 'Kindless', price_cents: 100 })).status, 400, 'a product needs a kind');
  await c.put(`/api/products/${gear.id}`, { archived: true });
  const listed = (await c.get('/api/products?all=1')).data.find((p) => p.id === gear.id);
  assert.equal(listed.archived, 1);
  assert.equal((await d.put(`/api/products/${gear.id}`, { archived: false })).status, 403, 'front desk cannot change products');
  const twin = await c.post('/api/products', { name: gear.name, kind: 'gear', price_cents: 100 });
  assert.equal(twin.status, 200, 'the name is free while the old one is stopped');
  assert.equal((await c.put(`/api/products/${gear.id}`, { archived: false })).status, 400, 'selling it again into a name clash is refused');
  const again = await c.put(`/api/products/${gear.id}`, { archived: false, name: `${gear.name} (classic)` });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.product.archived, 0);
  assert.equal(again.data.product.name, `${gear.name} (classic)`);
  assert.equal((await c.put(`/api/products/${twin.data.id}`, { name: `${gear.name} (classic)` })).status, 400, 'renaming into a clash is refused');
});

// ---- review fixes ----
const { localDateOf } = require('../server/services/floor-util');
const booking = require('../server/services/booking');

// The UTC 'YYYY-MM-DD HH:MM:SS' for a local wall-clock time in the business time zone.
function utcForLocal(date, hhmm) {
  const tz = require('../server/db').setting('timezone', 'America/Denver');
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  for (let off = -14 * 60; off <= 14 * 60; off += 15) {
    const t = new Date(guess - off * 60000);
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === `${date} ${hhmm}`) return t.toISOString().slice(0, 19).replace('T', ' ');
  }
  throw new Error('no match');
}

test('review fixes: Today in recent sales means since local midnight, like the takings', async () => {
  const d = await desk();
  const today = booking.todayLocal();
  const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
  // 23:59 last night is always inside the last 24 hours, but it isn't today.
  const late = await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: product('gear').id }] });
  run('UPDATE sales SET created_at=? WHERE id=?', utcForLocal(yesterday, '23:59'), late.data.sale.id);
  assert.equal(localDateOf(get('SELECT created_at FROM sales WHERE id=?', late.data.sale.id).created_at), yesterday);
  const todays = (await d.get('/api/sales?days=1')).data;
  assert.ok(!todays.some((s) => s.id === late.data.sale.id), 'last night is not in Today');
  assert.ok(todays.every((s) => localDateOf(s.created_at) === today));
  const summary = (await d.get('/api/sales/summary')).data;
  assert.equal(todays.filter((s) => s.status !== 'failed').length, summary.count, 'the list and the takings count the same sales');
  assert.ok((await d.get('/api/sales?days=2')).data.some((s) => s.id === late.data.sale.id), '2 days includes yesterday');
});

test('review fixes: takings refuse a bad date or location instead of failing or widening', async () => {
  const o = await owner();
  assert.equal((await o.get('/api/sales/summary?date=2026-13-45')).status, 400);
  assert.equal((await o.get('/api/sales/summary?date=2026-02-30')).status, 400);
  assert.equal((await o.get('/api/sales/summary?date=2026-02-28')).status, 200);
  assert.equal((await o.get('/api/sales/summary?location_id=abc')).status, 404, 'not silently all locations');
});

test('review fixes: Undo shows only while the server would still allow it', async () => {
  const d = await desk();
  const s = await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: product('gear').id }] });
  run("UPDATE sales SET created_at=datetime('now','-625 seconds') WHERE id=?", s.data.sale.id); // 10.4 minutes
  assert.equal((await d.get(`/api/sales/${s.data.sale.id}`)).data.can_undo, false);
  assert.equal((await d.post(`/api/sales/${s.data.sale.id}/undo`)).status, 400);
});

test('review fixes: a receipt shows the discount as money off', async () => {
  const d = await desk();
  const gear = product('gear');
  const r = await d.post('/api/sales', { location_id: facility(), method: 'cash', items: [{ product_id: gear.id }], discount: { type: 'amount', value: 250, reason: 'Team' },
    email_receipt: true, receipt_email: 'counter@example.com' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mail = get("SELECT body FROM outbox WHERE to_email='counter@example.com' ORDER BY id DESC LIMIT 1").body;
  assert.match(mail, /Discount \(Team\) {2}-\$2\.50/);
  assert.doesNotMatch(mail, /\$-/);
});
