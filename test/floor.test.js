// Floor operations: Today, schedule, classes, rosters (check-in, collect, waitlist, cancel, team), hours,
// point of sale (locations, products, readers, sales, refunds) and role refusals.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-floor-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const { get, all, insert } = require('../server/db');
const booking = require('../server/services/booking');

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
const athlete = (first) => get('SELECT * FROM athletes WHERE first_name=?', first);
const hasMoney = (obj) => /price_cents|_cents"|\$\d/.test(JSON.stringify(obj));

test('Today: owners see money, coaches and front desk never do', async () => {
  const o = await owner();
  const r = await o.get('/api/today');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.metrics.map((m) => m.key), ['mrr', 'clients', 'failed', 'workouts']);
  assert.ok(r.data.sessions.length >= 1, 'the demo puts a session on today');
  assert.ok(r.data.revenue.locations.length >= 2, 'sales across locations this month');
  assert.equal(typeof r.data.in_person_today_cents, 'number');
  for (const who of [await coach(), await desk()]) {
    const c = await who.get('/api/today');
    assert.equal(c.status, 200);
    assert.ok(!c.data.revenue && c.data.in_person_today_cents === undefined);
    assert.ok(!c.data.metrics.some((m) => m.key === 'mrr' || m.key === 'failed'));
    assert.ok(!hasMoney(c.data), 'no money in a coach or front desk Today: ' + JSON.stringify(c.data).match(/.{40}(price_cents|_cents"|\$\d).{40}/)?.[0]);
    assert.ok(!c.data.attention.some((a) => a.kind === 'failed_payment' || a.kind === 'overdue_invoice'));
  }
});

test('Today: pending results and failed charges show; owners can retry', async () => {
  insert('pending_results', { source: 'hawkin', sender_key: 'floor-test-1', sender_label: 'Unknown', test_name: 'CMJ', value: 30, unit: 'cm', source_ref: 'floor-test-ref-1' });
  const kevin = athlete('Kevin');
  const inv = insert('invoices', { number: 'DP-FLOOR-T1', kind: 'charge', family_id: kevin.family_id, athlete_id: kevin.id, description: 'Test charge', amount_cents: 5000, status: 'failed', attempts: 1, next_retry: '2099-01-01' });
  const o = await owner();
  const t = await o.get('/api/today');
  assert.ok(t.data.attention.some((a) => a.kind === 'pending_results' && a.action.href === '/app/testing/queue'));
  const item = t.data.attention.find((a) => a.action?.post === `/today/retry/${inv}`);
  assert.ok(item, 'failed charge listed with retry');
  assert.equal((await (await coach()).post(`/api/today/retry/${inv}`)).status, 403);
  const r = await o.post(`/api/today/retry/${inv}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false, 'card ending 0002 declines again');
  assert.equal(get('SELECT attempts FROM invoices WHERE id=?', inv).attempts, 2);
});

test('Schedule lists two weeks with counts; classes create and archive sessions', async () => {
  const c = await coach();
  const ev = await c.get('/api/events');
  assert.equal(ev.status, 200);
  assert.ok(ev.data.length > 5);
  assert.ok(ev.data.every((e) => 'booked' in e && 'unpaid' in e && 'capacity' in e));
  const d = await desk();
  assert.equal((await d.get('/api/events')).status, 200, 'front desk can view the schedule');
  assert.equal((await d.post('/api/classes', { name: 'Nope' })).status, 403, 'front desk cannot create classes');

  assert.equal((await c.post('/api/classes', { name: '', type: 'class' })).status, 400);
  assert.match((await c.post('/api/classes', { name: 'X', type: 'class', weekdays: [], start_time: '16:00', duration_min: 60, capacity: 10 })).data.error, /day/);
  assert.match((await c.post('/api/classes', { name: 'Camp', type: 'camp', weekdays: [1], start_time: '09:00', duration_min: 60, capacity: 10 })).data.error, /first and last date/);

  const made = await c.post('/api/classes', { name: 'Floor Test Class', type: 'class', weekdays: ['1', '3'], start_time: '19:30', duration_min: 60, capacity: 2, min_age: 10, max_age: 14, price_cents: 2000 });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.ok(made.data.sessions >= 14, 'eight weeks of sessions');
  const first = get("SELECT * FROM events WHERE class_id=? ORDER BY starts_at LIMIT 1", made.data.id);
  // book someone who used a credit, then archive: credit comes back, family emailed
  const isa = athlete('Isabela');
  const before = get('SELECT group_credits FROM athletes WHERE id=?', isa.id).group_credits;
  const b = await c.post(`/api/events/${first.id}/bookings`, { athlete_id: isa.id });
  assert.equal(b.status, 200);
  assert.equal(b.data.booking.coverage, 'credit');
  const outbox = get('SELECT COUNT(*) n FROM outbox').n;
  assert.equal((await d.post(`/api/classes/${made.data.id}/archive`)).status, 403);
  const ar = await c.post(`/api/classes/${made.data.id}/archive`, { reason: 'Testing archive' });
  assert.equal(ar.status, 200);
  assert.equal(ar.data.cancelled, made.data.sessions);
  assert.equal(get('SELECT COUNT(*) n FROM events WHERE class_id=? AND cancelled=0', made.data.id).n, 0);
  assert.equal(get('SELECT group_credits FROM athletes WHERE id=?', isa.id).group_credits, before);
  assert.ok(get('SELECT COUNT(*) n FROM outbox').n > outbox, 'family emailed');
  const cl = await c.get('/api/classes');
  assert.ok(!cl.data.some((x) => x.id === made.data.id));
  assert.ok(cl.data.every((x) => x.price_cents === undefined), 'coach sees no class prices');

  const camp = await (await owner()).post('/api/classes', { name: 'Floor Camp', type: 'camp', weekdays: [1, 2, 3, 4, 5], start_time: '09:00', duration_min: 120, capacity: 20,
    start_date: booking.todayLocal(), end_date: require('../server/lib').addDays(booking.todayLocal(), 6), reg_price_cents: 15000, reg_deadline: booking.todayLocal() });
  assert.equal(camp.status, 200, JSON.stringify(camp.data));
  assert.equal(camp.data.sessions, 5);
});

test('Roster: check in/undo, add, waitlist, collect, remove, cancel', async () => {
  const d = await desk();
  const c = await coach();
  const cls = insert('classes', { name: 'Roster Test', type: 'class', weekdays: '0,1,2,3,4,5,6', start_time: '23:00', duration_min: 30, capacity: 2, price_cents: 3000, start_date: booking.todayLocal(), end_date: booking.todayLocal() });
  booking.generateEvents();
  const e = get('SELECT * FROM events WHERE class_id=?', cls);
  const iso = athlete('Isabela'), mason = athlete('Mason'), ava = athlete('Ava'), kevin = athlete('Kevin');

  const b1 = await d.post(`/api/events/${e.id}/bookings`, { athlete_id: mason.id });
  assert.equal(b1.data.booking.coverage, 'unpaid', 'paused member pays drop-in');
  const b2 = await d.post(`/api/events/${e.id}/bookings`, { athlete_id: kevin.id });
  assert.equal(b2.data.booking.status, 'booked');
  const w = await d.post(`/api/events/${e.id}/bookings`, { athlete_id: ava.id });
  assert.equal(w.data.booking.status, 'waitlist');
  assert.match(w.data.message, /waitlist/);
  assert.equal((await d.post(`/api/events/${e.id}/bookings`, { athlete_id: ava.id })).status, 400, 'no double booking');

  const r = await d.get(`/api/events/${e.id}`);
  assert.equal(r.data.booked.length, 2);
  assert.equal(r.data.waitlist.length, 1);
  const mrow = r.data.booked.find((x) => x.athlete.id === mason.id);
  assert.ok(mrow.athlete.parent_phone, 'parent phone shown');
  const avaCard = r.data.waitlist[0].athlete;
  assert.equal(avaCard.allergies, 'Peanuts', 'medical flags shown');

  assert.equal((await d.post(`/api/bookings/${b1.data.booking.id}/checkin`)).status, 200);
  assert.ok(get('SELECT checked_in_at FROM bookings WHERE id=?', b1.data.booking.id).checked_in_at);
  assert.equal((await d.del(`/api/bookings/${b1.data.booking.id}/checkin`)).status, 200);
  assert.equal(get('SELECT checked_in_at FROM bookings WHERE id=?', b1.data.booking.id).checked_in_at, null);

  // Kevin's card ends 0002: card on file declines and the booking stays unpaid; cash works.
  const dec = await d.post(`/api/bookings/${b2.data.booking.id}/collect`, { method: 'card' });
  assert.equal(dec.status, 400);
  assert.match(dec.data.error, /declined/i);
  assert.equal(get('SELECT coverage FROM bookings WHERE id=?', b2.data.booking.id).coverage, 'unpaid');
  assert.equal(get("SELECT COUNT(*) n FROM invoices WHERE athlete_id=? AND status='failed' AND description LIKE 'Roster Test%'", kevin.id).n, 0, 'declined collect is not retried later');
  const ok = await d.post(`/api/bookings/${b2.data.booking.id}/collect`, { method: 'cash' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(get('SELECT coverage FROM bookings WHERE id=?', b2.data.booking.id).coverage, 'paid');
  assert.ok(get('SELECT * FROM sales WHERE booking_id=?', b2.data.booking.id), 'collect records a sale');
  assert.equal((await d.post(`/api/bookings/${b2.data.booking.id}/collect`, { method: 'cash' })).status, 400, 'cannot collect twice');
  const tap = await d.post(`/api/bookings/${b1.data.booking.id}/collect`, { method: 'tap' });
  assert.equal(tap.status, 200);

  // Removing Kevin refunds his drop-in and moves Ava up from the waitlist.
  assert.equal((await d.del(`/api/bookings/${b2.data.booking.id}`)).status, 200);
  assert.equal(get('SELECT status FROM bookings WHERE id=?', w.data.booking.id).status, 'booked');
  assert.equal(get('SELECT status FROM sales WHERE booking_id=?', b2.data.booking.id).status, 'refunded');

  // Cancel: front desk refused, coach needs a reason, then everyone is notified.
  assert.equal((await d.post(`/api/events/${e.id}/cancel`, { reason: 'Rain' })).status, 403);
  assert.equal((await c.post(`/api/events/${e.id}/cancel`, {})).status, 400);
  const cx = await c.post(`/api/events/${e.id}/cancel`, { reason: 'Lightning' });
  assert.equal(cx.status, 200);
  assert.equal(get('SELECT cancelled, cancel_reason FROM events WHERE id=?', e.id).cancel_reason, 'Lightning');
  assert.equal((await d.post(`/api/events/${e.id}/bookings`, { athlete_id: iso.id })).status, 400);
  assert.ok(all("SELECT * FROM activity WHERE action='Cancelled session'").length);
});

test('Team sessions: roster from the team, one-tap everyone here', async () => {
  const d = await desk();
  const team = get("SELECT id FROM team_contracts WHERE team_name='Riverside Varsity Football'").id;
  const eid = insert('events', { type: 'team', name: 'Floor team test', starts_at: `${booking.todayLocal()}T23:30`, duration_min: 60, capacity: 60, team_id: team });
  const e = get('SELECT * FROM events WHERE id=?', eid);
  const r = await d.get(`/api/events/${e.id}`);
  assert.ok(r.data.team.roster.length >= 6);
  const one = r.data.team.roster.find((x) => !x.booking);
  const tc = await d.post(`/api/events/${e.id}/team-checkin`, { athlete_id: one.athlete.id });
  assert.equal(tc.status, 200);
  assert.equal(tc.data.booking.coverage, 'team');
  const all1 = await d.post(`/api/events/${e.id}/everyone-here`);
  assert.equal(all1.status, 200);
  assert.equal(all1.data.checked_in, r.data.team.roster.length - 1);
  const after = await d.get(`/api/events/${e.id}`);
  assert.ok(after.data.team.roster.every((x) => x.booking?.checked_in_at));
  assert.equal((await d.post(`/api/events/${get("SELECT id FROM events WHERE type='class' LIMIT 1").id}/everyone-here`)).status, 400);
});

test('Hours: add, overlap refused, remove; front desk refused; policies owner-only', async () => {
  const c = await coach();
  const loc = get('SELECT id FROM locations LIMIT 1').id;
  const add = await c.post('/api/availability', { kind: 'evaluation', weekday: 6, start_time: '11:00', end_time: '13:00', slot_min: 60, location_id: loc, price_cents: 7500 });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.equal((await c.post('/api/availability', { kind: 'evaluation', weekday: 6, start_time: '12:00', end_time: '14:00', slot_min: 60, location_id: loc })).status, 400);
  assert.equal((await c.post('/api/availability', { kind: 'private', weekday: 0, start_time: '14:00', end_time: '13:00', slot_min: 60, location_id: loc })).status, 400);
  assert.ok((await c.get('/api/availability')).data.some((v) => v.id === add.data.id));
  assert.ok(booking.openSlots('evaluation', booking.todayLocal(), 8).some((s) => s.availability_id === add.data.id), 'parents see the new times');
  const d = await desk();
  assert.equal((await d.get('/api/availability')).status, 403);
  assert.equal((await d.post('/api/availability', {})).status, 403);
  assert.equal((await c.del(`/api/availability/${add.data.id}`)).status, 200);
  assert.equal((await c.put('/api/settings', { late_cancel_hours: 24 })).status, 403, 'coach cannot change policies');
  const o = await owner();
  const v = (await o.get('/api/settings')).data.waiver_version;
  assert.equal((await o.put('/api/settings', { waiver_text: 'A new waiver.' })).status, 200);
  assert.equal((await o.get('/api/settings')).data.waiver_version, v + 1);
});

test('Point of sale setup: locations, products, readers and roles', async () => {
  const c = await coach();
  const d = await desk();
  assert.equal((await d.post('/api/locations', { name: 'X' })).status, 403);
  assert.equal((await d.post('/api/products', { name: 'X' })).status, 403);
  assert.equal((await d.get('/api/products')).status, 200);
  const l = await c.post('/api/locations', { name: 'Lakeside Park', kind: 'park' });
  assert.equal(l.status, 200);
  assert.equal(l.data.location.cards_ready, false);
  const l2 = await c.put(`/api/locations/${l.data.id}`, { street: '1 Lake Rd', city: 'Provo', state: 'ut', zip: '84604' });
  assert.equal(l2.data.location.address, '1 Lake Rd, Provo, UT 84604');
  assert.equal(l2.data.location.cards_ready, true);
  assert.equal((await c.post('/api/products', { name: 'Pack', kind: 'group_pack', price_cents: 1000 })).status, 400, 'packs need a session count');
  const p = await c.post('/api/products', { name: '20 class pack', kind: 'group_pack', price_cents: 40000, credits: 20 });
  assert.equal(p.status, 200);
  const up = await c.put(`/api/products/${p.data.id}`, { price_cents: 38000 });
  assert.equal(up.data.product.price_cents, 38000);
  await c.put(`/api/products/${p.data.id}`, { archived: true });
  assert.ok(!(await d.get('/api/products')).data.some((x) => x.id === p.data.id));
  assert.equal((await c.post('/api/readers', { code: 'abc-def-ghi', location_id: l.data.id })).status, 400, 'test mode takes the simulated code');
  const rd = await c.post('/api/readers', { code: 'simulated-wpe', label: 'Park reader', location_id: l.data.id });
  assert.equal(rd.status, 200);
  assert.equal((await c.del(`/api/readers/${rd.data.id}`)).status, 200);
});

test('Sales: products, packs add credits, save card, declines, refunds', async () => {
  const d = await desk();
  const facility = get("SELECT id FROM locations WHERE kind='facility'").id;
  const pack = get("SELECT * FROM products WHERE kind='group_pack' AND archived=0 LIMIT 1");
  const shirt = get("SELECT * FROM products WHERE kind='gear' LIMIT 1");
  const iso = athlete('Isabela');
  const credits = iso.group_credits;

  assert.equal((await d.post('/api/sales', { location_id: facility, method: 'cash', items: [] })).status, 400);
  assert.match((await d.post('/api/sales', { location_id: facility, method: 'cash', items: [{ product_id: pack.id }] })).data.error, /Choose who/);
  assert.match((await d.post('/api/sales', { location_id: facility, athlete_id: iso.id, method: 'card', items: [{ product_id: shirt.id }] })).data.error, /no card on file/);
  const noAddr = insert('locations', { name: 'No address spot', kind: 'park' });
  assert.match((await d.post('/api/sales', { location_id: noAddr, method: 'tap', items: [{ product_id: shirt.id }] })).data.error, /address/);
  assert.equal((await d.post('/api/sales', { location_id: noAddr, method: 'cash', items: [{ product_id: shirt.id }] })).status, 200, 'cash works anywhere');

  const s = await d.post('/api/sales', { location_id: facility, athlete_id: iso.id, method: 'tap', save_card: true, card: { brand: 'Visa', last4: '1881' },
    items: [{ product_id: pack.id }, { product_id: shirt.id, qty: 2 }, { name: 'Tape', price_cents: 450 }] });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const total = pack.price_cents + shirt.price_cents * 2 + 450;
  assert.equal(s.data.sale.total_cents, total);
  assert.equal(s.data.saved_card, true);
  assert.equal(get('SELECT card_last4 FROM families WHERE id=?', iso.family_id).card_last4, '1881');
  assert.equal(get('SELECT group_credits FROM athletes WHERE id=?', iso.id).group_credits, credits + pack.credits);
  assert.ok(get("SELECT * FROM invoices WHERE charge_id=? AND status='paid'", get('SELECT charge_id FROM sales WHERE id=?', s.data.sale.id).charge_id), 'charge recorded for Billing');

  const tapDecline = await d.post('/api/sales', { location_id: facility, method: 'tap', card: { last4: '0002' }, items: [{ product_id: shirt.id }] });
  assert.equal(tapDecline.status, 400);
  const kevin = athlete('Kevin');
  const cardDecline = await d.post('/api/sales', { location_id: facility, athlete_id: kevin.id, method: 'card', items: [{ product_id: shirt.id }] });
  assert.equal(cardDecline.status, 400);
  assert.equal(get("SELECT COUNT(*) n FROM invoices WHERE athlete_id=? AND status='failed' AND description LIKE '%(Provo facility)'", kevin.id).n, 0, 'declined sale is voided, not retried');

  const reader = await d.post('/api/sales', { location_id: facility, method: 'reader', items: [{ product_id: shirt.id }] });
  assert.equal(reader.status, 200);

  const list = await d.get('/api/sales');
  assert.ok(list.data.some((x) => x.id === s.data.sale.id));

  // Refunds: owners only, partial then the rest; full refund takes pack credits back.
  assert.equal((await d.post(`/api/sales/${s.data.sale.id}/refund`, {})).status, 403);
  assert.equal((await (await coach()).post(`/api/sales/${s.data.sale.id}/refund`, {})).status, 403);
  const o = await owner();
  assert.equal((await o.post(`/api/sales/${s.data.sale.id}/refund`, { amount_cents: total + 1 })).status, 400);
  const part = await o.post(`/api/sales/${s.data.sale.id}/refund`, { amount_cents: 1000 });
  assert.equal(part.status, 200);
  assert.equal(get('SELECT status FROM sales WHERE id=?', s.data.sale.id).status, 'partial_refund');
  const rest = await o.post(`/api/sales/${s.data.sale.id}/refund`, {});
  assert.equal(rest.status, 200);
  const after = get('SELECT * FROM sales WHERE id=?', s.data.sale.id);
  assert.equal(after.status, 'refunded');
  assert.equal(after.refunded_cents, total);
  assert.equal(get('SELECT group_credits FROM athletes WHERE id=?', iso.id).group_credits, credits);
  assert.equal(get("SELECT COUNT(*) n FROM invoices WHERE number LIKE 'RF-%' AND athlete_id=?", iso.id).n, 2);
  assert.equal((await o.post(`/api/sales/${s.data.sale.id}/refund`, {})).status, 400, 'nothing left');
  assert.ok(all("SELECT * FROM activity WHERE action='Refunded sale'").length === 2);
});

test('Signed-out requests are refused', async () => {
  const anon = client();
  for (const p of ['/api/today', '/api/events', '/api/sales', '/api/locations']) assert.equal((await anon.get(p)).status, 401);
});
