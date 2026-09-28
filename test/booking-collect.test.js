// Collecting for a booking at the counter: only through an explicit, checked booking_id on the sale (a note is only a
// note). The roster's Collect, Tap to Pay and pay links for a session keep working.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { completePayLink } from '../src/services/paylinks.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDays, newId } from '../src/util.js';

let app, base, owner, coach, desk, facility;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const db = () => app.ctx.db;
const now = () => new Date().toISOString();

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

// ---------------------------------------------------------------- collecting for a booking
function unpaidBooking(clientId, { price = 3000, status = 'booked' } = {}) {
  const sid = newId('ses'), bid = newId('bkg');
  db().run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, created_at) VALUES (?, 'Speed', 'group', ?, ?, ?, 10, ?, ?)`, sid, facility.id, addDays(now(), 1), addDays(now(), 1.05), price, now());
  db().run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, ?, 'unpaid', ?, ?)`, bid, sid, clientId, status, now(), now());
  return bid;
}
const coverage = (bid) => db().get('SELECT coverage FROM bookings WHERE id = ?', bid).coverage;

test('typing booking:<id> in a sale note no longer marks a booking paid, for anyone', async () => {
  const kid = (await owner('POST', '/v1/clients', { name: 'Note Kid', parent: { name: 'Note Parent', email: 'note@example.com' } })).body;
  const other = (await owner('POST', '/v1/clients', { name: 'Other Kid', parent: { name: 'Other Parent', email: 'other@example.com' } })).body;
  const bid = unpaidBooking(kid.id);
  for (const who of [desk, coach, owner]) {
    const s = await who('POST', '/v1/sales', { location_id: facility.id, method: 'cash', client_id: other.id, custom: { description: 'Water', amount_cents: 100 }, note: `booking:${bid}` });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(s.body.booking_id, null);
    assert.equal(coverage(bid), 'unpaid', 'a note is only a note');
  }
});

test('booking_id on a sale is checked: the right client, unpaid, not canceled, and the sale covers the price', async () => {
  const kid = (await owner('POST', '/v1/clients', { name: 'Check Kid', parent: { name: 'Check Parent', email: 'check@example.com' } })).body;
  const other = (await owner('POST', '/v1/clients', { name: 'Wrong Kid', parent: { name: 'Wrong Parent', email: 'wrong@example.com' } })).body;
  const bid = unpaidBooking(kid.id, { price: 3000 });
  const sell = (body, who = desk) => who('POST', '/v1/sales', { location_id: facility.id, method: 'cash', custom: { description: 'Session', amount_cents: 3000 }, booking_id: bid, ...body });
  let r = await sell({ client_id: other.id });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /different client/);
  r = await sell({});
  assert.equal(r.status, 409, 'a walk-in sale cannot pay for a booking');
  r = await sell({ client_id: kid.id, custom: { description: 'Session', amount_cents: 2999 } });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /costs \$30/);
  r = await sell({ client_id: kid.id, booking_id: 'bkg_nope' });
  assert.equal(r.status, 404);
  assert.equal(coverage(bid), 'unpaid');
  r = await sell({ client_id: kid.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.booking_id, bid);
  assert.equal(coverage(bid), 'paid');
  r = await sell({ client_id: kid.id });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /already paid/);
  const canceled = unpaidBooking(kid.id, { status: 'canceled' });
  r = await sell({ client_id: kid.id, booking_id: canceled });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /canceled/);
  const free = unpaidBooking(kid.id, { price: 0 });
  r = await sell({ client_id: kid.id, booking_id: free });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /no price/);
});

test('the roster Collect flow still works and two presses at once charge once', async () => {
  const kid = (await owner('POST', '/v1/clients', { name: 'Collect Kid', parent: { name: 'Collect Parent', email: 'collect@example.com' } })).body;
  await owner('POST', `/v1/clients/${kid.id}/card/test`, {});
  const bid = unpaidBooking(kid.id, { price: 4500 });
  const [a, b] = await Promise.all([desk('POST', `/v1/bookings/${bid}/pay`, { method: 'card_on_file' }), coach('POST', `/v1/bookings/${bid}/pay`, { method: 'card_on_file' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(coverage(bid), 'paid');
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM sales WHERE booking_id = ? AND status = 'succeeded'`, bid).n, 1, 'charged once');
  // Tap to Pay: the sale waits for the card, and a second Collect starts over (the unfinished one is canceled).
  const bid2 = unpaidBooking(kid.id, { price: 4500 });
  const t1 = await desk('POST', `/v1/bookings/${bid2}/pay`, { method: 'tap_to_pay' });
  assert.equal(t1.body.sale.status, 'pending');
  const t2 = await desk('POST', `/v1/bookings/${bid2}/pay`, { method: 'tap_to_pay' });
  assert.equal(t2.status, 200);
  assert.equal(db().get('SELECT status FROM sales WHERE id = ?', t1.body.sale.id).status, 'canceled');
  const pos = await desk('POST', '/v1/sales', { location_id: facility.id, method: 'cash', client_id: kid.id, custom: { description: 'Session', amount_cents: 4500 }, booking_id: bid2 });
  assert.equal(pos.status, 409, 'the counter waits for the payment in progress'); assert.match(pos.body.error.message, /waiting for the card/);
  await owner('POST', `/v1/sales/${t2.body.sale.id}/simulate`, { outcome: 'approved' });
  assert.equal(coverage(bid2), 'paid');
});

test('a pay link for a session still marks it paid', async () => {
  const kid = (await owner('POST', '/v1/clients', { name: 'Link Kid', parent: { name: 'Link Parent', email: 'linkkid@example.com' } })).body;
  const bid = unpaidBooking(kid.id, { price: 2000 });
  const link = (await owner('POST', '/v1/pay-links', { kind: 'booking', booking_id: bid })).body;
  await completePayLink(app.ctx, link.id, 'pi_link_booking');
  assert.equal(coverage(bid), 'paid');
  const sale = db().get('SELECT * FROM sales WHERE booking_id = ?', bid);
  assert.equal(sale.note, `Pay link ${link.id}`);
});
