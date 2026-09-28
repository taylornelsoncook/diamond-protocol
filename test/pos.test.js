import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { addDays } from '../src/util.js';
import * as commerce from '../src/services/commerce.js';

// Point of sale: discounts, receipts, undo, the day's takings, recent-sales filters, readers per location, roles.
let app, base, facility, park, shirt, pack, single, maya, kid, fam, reader;
const tokens = {};
const users = {};
const call = async (method, path, body, who = 'owner') => {
  const headers = { authorization: `Bearer ${tokens[who]}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const login = async (email, password) => (await (await fetch(base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token;
const outbox = () => app.ctx.db.all('SELECT to_email, subject, body FROM outbox ORDER BY created_at DESC, rowid DESC');
const settle = () => new Promise((r) => setTimeout(r, 30));
const realNow = () => new Date().toISOString();
const cash = (body, who = 'owner') => call('POST', '/v1/sales', { location_id: facility.id, method: 'cash', ...body }, who);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.test' });
  users.owner = createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  users.desk = createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
  users.coach = createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  users.coach2 = createUser(app.ctx, { email: 'coach2@test.dev', name: 'Cora Coach', password: 'coach-password-2', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  tokens.owner = await login('owner@test.dev', 'owner-password-1');
  tokens.desk = await login('desk@test.dev', 'desk-password-1');
  tokens.coach = await login('coach@test.dev', 'coach-password-1');
  tokens.coach2 = await login('coach2@test.dev', 'coach-password-2');
  facility = (await call('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  park = (await call('POST', '/v1/locations', { name: 'Park', kind: 'park', address_line1: '2 Park Rd', city: 'Austin', state: 'TX', postal_code: '78746' })).body;
  shirt = (await call('POST', '/v1/products', { name: 'DP T-shirt', kind: 'gear', price_cents: 2500, track_stock: true })).body;
  await call('POST', `/v1/products/${shirt.id}/stock`, { reason: 'received', quantity: 10 });
  pack = (await call('POST', '/v1/products', { name: '5-session pack', kind: 'pack', price_cents: 37500, sessions: 5 })).body;
  single = (await call('POST', '/v1/products', { name: 'Single session', kind: 'session', price_cents: 8000 })).body;
  maya = (await call('POST', '/v1/clients', { name: 'Maya Okafor', email: 'maya@example.com' })).body;
  fam = (await call('POST', '/v1/families', { name: 'Lopez family', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  await call('POST', `/v1/families/${fam.id}/guardians`, { name: 'Luis Lopez', email: 'luis@example.com' });
  await call('POST', `/v1/families/${fam.id}/athletes`, { name: 'Ava Lopez' });
  kid = app.ctx.db.get('SELECT * FROM clients WHERE family_id = ?', fam.id);
  reader = (await call('POST', '/v1/readers', { registration_code: 'simulated-wpe', label: 'Front desk', location_id: facility.id })).body;
});
after(() => app.server.close());

test('discounts: percent or amount off the whole sale, with a reason, and never the whole sale', async () => {
  const pct = await cash({ items: [{ product_id: shirt.id, quantity: 2 }], discount: { type: 'percent', value: 10, reason: 'Sibling discount' } });
  assert.equal(pct.status, 201, JSON.stringify(pct.body));
  assert.equal(pct.body.amount_cents, 4500);
  assert.equal(pct.body.discount_cents, 500);
  assert.equal(pct.body.subtotal_cents, 5000);
  assert.equal(pct.body.discount_reason, 'Sibling discount');
  const amt = await cash({ items: [{ product_id: single.id }], client_id: maya.id, discount: { type: 'amount', value: 250, reason: 'Loyalty' } });
  assert.equal(amt.body.amount_cents, 7750);

  const noReason = await cash({ items: [{ product_id: shirt.id }], discount: { type: 'amount', value: 100 } });
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.error.message, /Say why/);
  const whole = await cash({ items: [{ product_id: shirt.id }], discount: { type: 'percent', value: 100, reason: 'Free' } });
  assert.equal(whole.status, 400);
  assert.match(whole.body.error.message, /has to leave something to pay/);
  const more = await cash({ items: [{ product_id: shirt.id }], discount: { type: 'amount', value: 2600, reason: 'Oops' } });
  assert.equal(more.status, 400);
  for (const bad of [{ type: 'amount', value: -100, reason: 'x' }, { type: 'amount', value: 1.5, reason: 'x' }, { type: 'percent', value: 0, reason: 'x' }, { type: 'free', value: 1, reason: 'x' }, 'lots']) {
    assert.equal((await cash({ items: [{ product_id: shirt.id }], discount: bad })).status, 400, JSON.stringify(bad));
  }
  // The discount is logged in the activity log against the sale.
  assert.ok(app.ctx.db.get(`SELECT id FROM audit_log WHERE action = 'discount' AND target = ?`, pct.body.id));
});

test('coaches and front desk give discounts only up to the owner\'s limit; the limit is the owner\'s to change', async () => {
  const over = await cash({ items: [{ product_id: shirt.id }], discount: { type: 'percent', value: 25, reason: 'Friend' } }, 'desk');
  assert.equal(over.status, 403);
  assert.match(over.body.error.message, /up to 20% off/);
  const overAmt = await cash({ items: [{ product_id: shirt.id }], discount: { type: 'amount', value: 501, reason: 'Friend' } }, 'coach');
  assert.equal(overAmt.status, 403);
  assert.equal((await cash({ items: [{ product_id: shirt.id }], discount: { type: 'amount', value: 500, reason: 'Scuffed' } }, 'coach')).status, 201);
  assert.equal((await cash({ items: [{ product_id: shirt.id }], discount: { type: 'percent', value: 20, reason: 'Scuffed' } }, 'desk')).status, 201);
  assert.equal((await call('PATCH', '/v1/settings', { staff_discount_max_pct: 50 }, 'desk')).status, 403);
  assert.equal((await call('PATCH', '/v1/settings', { staff_discount_max_pct: 50 }, 'coach')).status, 403);
  assert.equal((await call('PATCH', '/v1/settings', { staff_discount_max_pct: 101 })).status, 400);
  assert.equal((await call('PATCH', '/v1/settings', { staff_discount_max_pct: 0 })).status, 200);
  const none = await cash({ items: [{ product_id: shirt.id }], discount: { type: 'percent', value: 5, reason: 'Friend' } }, 'desk');
  assert.equal(none.status, 403);
  assert.match(none.body.error.message, /Only the owner can give discounts/);
  // The owner can still give any discount that leaves something to pay.
  assert.equal((await cash({ items: [{ product_id: shirt.id }], discount: { type: 'percent', value: 99, reason: 'Staff shirt' } })).status, 201);
  await call('PATCH', '/v1/settings', { staff_discount_max_pct: 20 });
});

test('a card sale is charged the discounted amount, and a refund can\'t go past what was paid', async () => {
  await call('POST', `/v1/clients/${maya.id}/card/test`, {});
  const s = await call('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: maya.id, items: [{ product_id: pack.id }], discount: { type: 'amount', value: 7500, reason: 'Pack promo' } });
  assert.equal(s.body.status, 'succeeded');
  assert.equal(s.body.amount_cents, 30000);
  assert.equal((await call('POST', `/v1/sales/${s.body.id}/refund`, { amount_cents: 30001 })).status, 400);
  const r = await call('POST', `/v1/sales/${s.body.id}/refund`, { amount_cents: 1000, reason: 'Missed a session' });
  assert.equal(r.body.status, 'partially_refunded');
  assert.equal(r.body.refunds[0].reason, 'Missed a session');
  assert.equal(r.body.refunds[0].by_name, 'Olivia Owner');
});

test('receipts: emailed at the counter to the family\'s billing parent or a typed address, re-sent by hand, never when unticked', async () => {
  const before = outbox().length;
  const s = await cash({ client_id: kid.id, items: [{ product_id: shirt.id }], discount: { type: 'amount', value: 250, reason: 'Sibling' }, email_receipt: true });
  await settle();
  const mail = outbox()[0];
  assert.equal(mail.to_email, 'maria@example.com', 'the primary parent, not the other parent');
  assert.match(mail.subject, /Receipt from .*\$22\.50/);
  assert.match(mail.body, /Discount \(Sibling\)  -\$2\.50/);
  assert.match(mail.body, /Subtotal  \$25/);
  assert.match(mail.body, /https:\/\/app\.test\/receipt\/[\w-]+/);
  const sale = (await call('GET', `/v1/sales/${s.body.id}`)).body;
  assert.equal(sale.receipt_email, 'maria@example.com');
  assert.ok(sale.receipt_sent_at);

  // Unticked: nothing goes out.
  const n = outbox().length;
  await cash({ client_id: kid.id, items: [{ product_id: shirt.id }], email_receipt: false });
  await settle();
  assert.equal(outbox().length, n);
  // A walk-in's receipt goes to the address typed, even when automatic receipts are off.
  await call('PATCH', '/v1/settings', { emails_off: 'receipts' });
  await cash({ items: [{ product_id: shirt.id }], email_receipt: true, receipt_email: 'Walkin@Example.com' });
  await settle();
  assert.equal(outbox()[0].to_email, 'walkin@example.com');
  // Automatic receipts off and nothing ticked (an API sale): none.
  const m = outbox().length;
  await cash({ client_id: kid.id, items: [{ product_id: shirt.id }] });
  await settle();
  assert.equal(outbox().length, m);
  await call('PATCH', '/v1/settings', { emails_off: '' });
  assert.equal((await cash({ items: [{ product_id: shirt.id }], email_receipt: true })).status, 400, 'a walk-in needs an address typed');
  assert.equal((await cash({ items: [{ product_id: shirt.id }], email_receipt: true, receipt_email: 'not-an-email' })).status, 400);

  // Re-send by hand (front desk can), to the default or another address.
  const again = await call('POST', `/v1/sales/${s.body.id}/receipt`, {}, 'desk');
  assert.equal(again.status, 200);
  assert.equal(again.body.receipt_to, 'maria@example.com');
  assert.equal((await call('POST', `/v1/sales/${s.body.id}/receipt`, { email: 'luis@example.com' }, 'desk')).body.receipt_to, 'luis@example.com');
  assert.ok(outbox().length > before);
});

test('the printable receipt page shows the sale without contact details, and only for paid sales', async () => {
  const s = await cash({ client_id: kid.id, items: [{ product_id: shirt.id }], discount: { type: 'percent', value: 10, reason: 'Team' }, email_receipt: false });
  const url = (await call('GET', `/v1/sales/${s.body.id}`)).body.receipt_url;
  assert.match(url, /^https:\/\/app\.test\/receipt\/[\w-]{20,}$/);
  const token = url.split('/receipt/')[1];
  const r = await (await fetch(`${base}/receipt-api/${token}`)).json();
  assert.equal(r.amount_cents, 2250);
  assert.equal(r.discount_cents, 250);
  assert.equal(r.client_name, 'Ava Lopez');
  assert.equal(JSON.stringify(r).includes('maria@example.com'), false);
  assert.equal((await fetch(`${base}/receipt-api/nope-not-a-token`)).status, 404);
  const page = await fetch(`${base}/receipt/${token}`);
  assert.match(await page.text(), /receipt\.js/);
  // The token never shows in lists or the API reference.
  assert.equal(JSON.stringify((await call('GET', '/v1/sales?days=1')).body).includes(token), false);
  assert.equal(JSON.stringify(await (await fetch(`${base}/v1/openapi.json`)).json()).includes('/receipt-api/'), false);
});

test('undo: the person who took the sale, for 10 minutes, puts the money, sessions and stock back', async () => {
  const stock = () => app.ctx.db.get('SELECT COALESCE(SUM(delta), 0) AS n FROM stock_moves WHERE product_id = ?', shirt.id).n;
  const credits = () => app.ctx.db.get('SELECT COALESCE(SUM(delta), 0) AS n FROM session_credits WHERE client_id = ?', maya.id).n;
  const c0 = credits(), s0 = stock();
  const s = await cash({ client_id: maya.id, items: [{ product_id: pack.id }, { product_id: shirt.id }] }, 'desk');
  assert.equal(s.body.can_undo, true);
  assert.ok(s.body.undo_seconds_left > 590 && s.body.undo_seconds_left <= 600);
  assert.equal(credits(), c0 + 5);
  assert.equal(stock(), s0 - 1);
  // Someone else can't undo it (not even the owner, who refunds instead); a coach can't even see it.
  const other = await call('POST', `/v1/sales/${s.body.id}/undo`, {});
  assert.equal(other.status, 409);
  assert.match(other.body.error.message, /Refund it instead/);
  assert.equal((await call('POST', `/v1/sales/${s.body.id}/undo`, {}, 'coach')).status, 404);
  assert.equal((await call('GET', '/v1/sales?days=1')).body.data.find((x) => x.id === s.body.id).can_undo, false, 'the owner didn\'t take it');
  assert.equal((await call('GET', '/v1/sales?days=1', null, 'desk')).body.data.find((x) => x.id === s.body.id).can_undo, true);

  const u = await call('POST', `/v1/sales/${s.body.id}/undo`, {}, 'desk');
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.status, 'refunded');
  assert.equal(u.body.refunds[0].kind, 'undo');
  assert.equal(credits(), c0);
  assert.equal(stock(), s0);
  const twice = await call('POST', `/v1/sales/${s.body.id}/undo`, {}, 'desk');
  assert.equal(twice.status, 409);
  assert.match(twice.body.error.message, /already been refunded/);

  // After 10 minutes it's a refund for the owner.
  const late = await cash({ items: [{ product_id: shirt.id }] }, 'coach');
  app.ctx.now = () => addDays(realNow(), 11 / 1440);
  try {
    const r = await call('POST', `/v1/sales/${late.body.id}/undo`, {}, 'coach');
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /10 minutes.*Ask the owner for a refund/);
    assert.equal((await call('GET', `/v1/sales/${late.body.id}`, null, 'coach')).body.can_undo, false);
  } finally { app.ctx.now = realNow; }
  // A partly refunded sale can't be undone.
  const part = await cash({ items: [{ product_id: shirt.id, quantity: 2 }] });
  await call('POST', `/v1/sales/${part.body.id}/refund`, { amount_cents: 100 });
  assert.equal((await call('POST', `/v1/sales/${part.body.id}/undo`, {})).status, 409);
});

test('undo and refund of the same sale at the same moment pay back once', async () => {
  const s = await call('POST', '/v1/sales', { location_id: facility.id, method: 'card_on_file', client_id: maya.id, items: [{ product_id: single.id }] });
  const [a, b] = await Promise.all([call('POST', `/v1/sales/${s.body.id}/undo`, {}), call('POST', `/v1/sales/${s.body.id}/refund`, {})]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const row = app.ctx.db.get('SELECT refunded_cents, amount_cents FROM sales WHERE id = ?', s.body.id);
  assert.equal(row.refunded_cents, row.amount_cents);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM sale_refunds WHERE sale_id = ?', s.body.id).n, 1);
});

test('undo of a sale that paid for a session at the counter makes the session unpaid again', async () => {
  const sid = 'ses_undo';
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, created_at) VALUES (?, 'Speed', 'group', ?, ?, ?, 10, ?)`, sid, facility.id, realNow(), addDays(realNow(), 1 / 24), realNow());
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES ('bkg_undo', ?, ?, 'booked', 'unpaid', ?, ?)`, sid, maya.id, realNow(), realNow());
  const s = await cash({ client_id: maya.id, items: [{ product_id: shirt.id }], note: 'booking:bkg_undo' });
  assert.equal(app.ctx.db.get(`SELECT coverage FROM bookings WHERE id = 'bkg_undo'`).coverage, 'paid');
  await call('POST', `/v1/sales/${s.body.id}/undo`, {});
  const b = app.ctx.db.get(`SELECT coverage, sale_id FROM bookings WHERE id = 'bkg_undo'`);
  assert.equal(b.coverage, 'unpaid');
  assert.equal(b.sale_id, null);
});

test('a second press of Charge (same request_id) returns the first sale instead of charging twice', async () => {
  const body = { location_id: facility.id, method: 'card_on_file', client_id: maya.id, items: [{ product_id: single.id }], request_id: 'req-double-1' };
  const [a, b] = await Promise.all([call('POST', '/v1/sales', body, 'desk'), call('POST', '/v1/sales', body, 'desk')]);
  assert.equal(a.body.id, b.body.id);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM sales WHERE request_id = 'req-double-1'`).n, 1);
  const c = await call('POST', '/v1/sales', body, 'desk');
  assert.equal(c.body.id, a.body.id);
  assert.equal(c.body.repeated, true);
  // Another person using the same id gets their own sale (ids belong to who sent them).
  const d = await call('POST', '/v1/sales', body, 'coach');
  assert.notEqual(d.body.id, a.body.id);
});

test('the day\'s takings: midnight to midnight in the business time zone, by method, refunds on the day they happen', async () => {
  // A quiet day far away, in the business time zone (America/Chicago by default).
  const day = '2030-03-10';        // daylight saving starts in the US that morning
  // Sign-ins would expire in 2030, so the sales are rung up through the service with the clock moved.
  const at = (iso) => { app.ctx.now = () => iso; };
  const ring = (body) => commerce.createSale(app.ctx, { location_id: facility.id, method: 'cash', ...body }, users.desk.id, { counter: true, role: 'front_desk', userId: users.desk.id });
  const refund = (id, cents) => commerce.refundSale(app.ctx, id, { amount_cents: cents }, { actor: users.owner.id });
  let t, atPark, next, todayDate;
  try {
    at('2030-03-10T05:30:00.000Z');       // 11:30 pm on the 9th in Chicago: the day before
    await ring({ items: [{ product_id: shirt.id }] });
    at('2030-03-10T06:30:00.000Z');       // 12:30 am on the 10th
    const early = await ring({ items: [{ product_id: shirt.id, quantity: 2 }], discount: { type: 'amount', value: 500, reason: 'Team' } });
    at('2030-03-10T18:00:00.000Z');
    const card = await ring({ location_id: park.id, method: 'card_on_file', client_id: maya.id, items: [{ product_id: single.id }] });
    await refund(early.id, 1000);
    at('2030-03-11T04:59:00.000Z');       // 11:59 pm on the 10th (daylight time now)
    await ring({ items: [{ product_id: shirt.id }] });
    at('2030-03-11T05:01:00.000Z');       // just after midnight: the 11th
    await ring({ items: [{ product_id: shirt.id }] });
    await refund(card.id, 3000);          // yesterday's sale, refunded today
    todayDate = commerce.takings(app.ctx, {}).date;
  } finally { app.ctx.now = realNow; }
  t = (await call('GET', `/v1/sales/takings?date=${day}`, null, 'desk')).body;
  assert.equal(t.sales, 3);
  assert.equal(t.taken_cents, 4500 + 8000 + 2500);
  assert.equal(t.discount_cents, 500);
  assert.equal(t.refunded_cents, 1000);
  assert.equal(t.net_cents, 14000);
  assert.equal(t.cash_cents, 4500 + 2500 - 1000);
  assert.equal(t.card_cents, 8000);
  assert.equal(t.by_method.find((m) => m.method === 'cash').sales, 2);
  atPark = (await call('GET', `/v1/sales/takings?date=${day}&location_id=${park.id}`)).body;
  assert.equal(atPark.net_cents, 8000);
  assert.equal(atPark.cash_cents, 0);
  next = (await call('GET', '/v1/sales/takings?date=2030-03-11')).body;
  assert.equal(next.taken_cents, 2500);
  assert.equal(next.refunded_cents, 3000, 'a refund counts on the day the money went back');
  assert.equal(next.card_cents, -3000);
  assert.equal(todayDate, '2030-03-11', 'the default is today in the business time zone');
  // Another time zone moves the day's edges.
  await call('PATCH', '/v1/settings', { timezone: 'America/Los_Angeles' });
  const la = (await call('GET', `/v1/sales/takings?date=${day}`)).body;
  assert.equal(la.sales, 3, 'in Los Angeles the two sales just before midnight in Chicago were still on the 9th, and both around the next midnight are on the 10th');
  assert.equal(la.taken_cents, 8000 + 2500 + 2500);
  assert.equal(la.refunded_cents, 4000);
  await call('PATCH', '/v1/settings', { timezone: 'America/Chicago' });
  for (const bad of ['2026-13-45', '2026-02-30', 'yesterday']) assert.equal((await call('GET', `/v1/sales/takings?date=${bad}`)).status, 400, bad);
  assert.equal((await call('GET', '/v1/sales/takings?location_id=loc_nope')).status, 400);
  // Coaches take payments but never see the takings.
  assert.equal((await call('GET', '/v1/sales/takings', null, 'coach')).status, 403);
});

test('recent sales: today since local midnight, 7 or 30 days, search by client or item, location filter', async () => {
  const s = await call('POST', '/v1/sales', { location_id: park.id, method: 'cash', client_id: maya.id, items: [{ product_id: single.id }] });
  const today = (await call('GET', '/v1/sales?days=1')).body.data;
  assert.ok(today.find((x) => x.id === s.body.id));
  assert.ok((await call('GET', '/v1/sales?days=1&q=okafor')).body.data.every((x) => x.client_name === 'Maya Okafor'));
  const byItem = (await call('GET', '/v1/sales?days=30&q=T-SHIRT')).body.data;
  assert.ok(byItem.length && byItem.every((x) => /T-shirt/.test(x.description)));
  assert.equal((await call('GET', '/v1/sales?days=30&q=%25')).body.data.length, 0, 'a % is searched as a character, not a wildcard');
  assert.ok((await call('GET', `/v1/sales?days=7&location_id=${park.id}`)).body.data.every((x) => x.location_id === park.id));
  assert.equal((await call('GET', '/v1/sales?days=0')).status, 400);
  assert.equal((await call('GET', '/v1/sales?days=abc')).status, 400);
});

test('coaches see and work only their own sales; front desk runs the counter but can\'t refund', async () => {
  const mine = await cash({ items: [{ product_id: shirt.id }] }, 'coach');
  const theirs = await cash({ items: [{ product_id: shirt.id }] }, 'coach2');
  const list = (await call('GET', '/v1/sales?days=30', null, 'coach')).body.data;
  assert.ok(list.length && list.every((x) => x.created_by === users.coach.id));
  assert.equal(list.find((x) => x.id === mine.body.id).amount_cents, 2500, 'the counter keeps amounts');
  for (const [m, p] of [['GET', ''], ['POST', '/receipt'], ['POST', '/sync'], ['POST', '/cancel'], ['POST', '/simulate']]) {
    assert.equal((await call(m, `/v1/sales/${theirs.body.id}${p}`, m === 'POST' ? {} : null, 'coach')).status, 404, `${m} ${p}`);
  }
  assert.equal((await call('POST', `/v1/sales/${mine.body.id}/refund`, {}, 'coach')).status, 403);
  assert.equal((await call('POST', `/v1/sales/${mine.body.id}/refund`, {}, 'desk')).status, 403);
  assert.equal((await call('GET', '/v1/sales?days=30', null, 'desk')).body.data.length > 1, true);
});

test('readers only take payments at their own location', async () => {
  const r = await call('POST', '/v1/sales', { location_id: park.id, method: 'reader', reader_id: reader.id, items: [{ product_id: shirt.id }] }, 'desk');
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /Front desk is at Facility, not Park/);
  const ok = await call('POST', '/v1/sales', { location_id: facility.id, method: 'reader', reader_id: reader.id, items: [{ product_id: shirt.id }] }, 'desk');
  assert.equal(ok.body.status, 'pending');
  await call('POST', `/v1/sales/${ok.body.id}/cancel`, {}, 'desk');
});

test('archived clients can\'t be checked in or sold to at the counter', async () => {
  const c = (await call('POST', '/v1/clients', { name: 'Old Timer', email: 'old@example.com' })).body;
  await call('POST', `/v1/clients/${c.id}/credits`, { delta: 2, credit_type: 'group' });
  assert.equal((await call('POST', `/v1/clients/${c.id}/archive`, {})).status, 200);
  const chk = await call('POST', `/v1/clients/${c.id}/check-ins`, { location_id: facility.id }, 'desk');
  assert.equal(chk.status, 409);
  assert.match(chk.body.error.message, /archived/);
  const sale = await cash({ client_id: c.id, items: [{ product_id: shirt.id }] }, 'desk');
  assert.equal(sale.status, 409);
  assert.match(sale.body.error.message, /archived/);
});

test('deleting a family keeps its sales but drops where receipts went and the receipt links', async () => {
  const f = (await call('POST', '/v1/families', { name: 'Gone family', parent: { name: 'Gina Gone', email: 'gina@example.com' } })).body;
  await call('POST', `/v1/families/${f.id}/athletes`, { name: 'Gus Gone' });
  const k = app.ctx.db.get('SELECT id FROM clients WHERE family_id = ?', f.id);
  const s = await cash({ client_id: k.id, items: [{ product_id: shirt.id }], email_receipt: true });
  await settle();
  assert.equal((await call('DELETE', `/v1/families/${f.id}`, { confirm: 'Gone family' })).status, 200);
  const row = app.ctx.db.get('SELECT amount_cents, receipt_email, receipt_token FROM sales WHERE id = ?', s.body.id);
  assert.equal(row.amount_cents, 2500);
  assert.equal(row.receipt_email, null);
  assert.equal(row.receipt_token, null);
});

test('a receipt can be re-sent by hand at most 5 times an hour, so the counter can\'t be used to flood an inbox', async () => {
  const s = await cash({ items: [{ product_id: shirt.id }], email_receipt: false });
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', `/v1/sales/${s.body.id}/receipt`, { email: 'someone@example.com' }, 'desk')).status, 200);
  assert.equal((await call('POST', `/v1/sales/${s.body.id}/receipt`, { email: 'someone@example.com' }, 'desk')).status, 429);
});

test('setup: duplicate product and location names are refused, and a product needs a type', async () => {
  const dup = await call('POST', '/v1/products', { name: 'dp t-shirt', kind: 'gear', price_cents: 100 });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error.message, /already a product called/);
  const noType = await call('POST', '/v1/products', { name: 'Water bottle', price_cents: 1500 });
  assert.equal(noType.status, 400);
  assert.match(noType.body.error.message, /Choose the type of product/);
  const old = (await call('POST', '/v1/products', { name: 'Old hat', kind: 'gear', price_cents: 1000 })).body;
  await call('PATCH', `/v1/products/${old.id}`, { active: false });
  assert.match((await call('POST', '/v1/products', { name: 'Old Hat', kind: 'gear', price_cents: 1000 })).body.error.message, /Sell again/);
  assert.equal((await call('PATCH', `/v1/products/${single.id}`, { name: '5-Session Pack' })).status, 409);
  assert.equal((await call('PATCH', `/v1/products/${single.id}`, { name: 'Single session' })).status, 200, 'keeping its own name is fine');
  assert.equal((await call('POST', '/v1/locations', { name: 'PARK', kind: 'park' })).status, 409);
  assert.equal((await call('PATCH', `/v1/locations/${park.id}`, { name: 'Facility' })).status, 409);
});
