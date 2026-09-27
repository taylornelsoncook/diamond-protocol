// Double taps and payments landing together never charge twice, and the public inquiry form can't be used to text strangers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addTestCard, refundSale } from '../src/services/commerce.js';
import { completePayLink } from '../src/services/paylinks.js';
import { newId } from '../src/util.js';

let app, base, owner, coach, maria, dana, ava, ben, speed, facility;
const refunds = [];
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email) => as((await req('POST', '/auth/login', { email, password: 'correct-horse-battery' })).cookie);
const parent = async (email) => { const { body } = await req('POST', '/portal/api/login', { email }); return as((await req('POST', '/portal/api/verify', { email, code: body.dev_code })).cookie); };
const salesFor = (c) => app.ctx.db.all(`SELECT * FROM sales WHERE client_id = ? AND status = 'succeeded'`, c.id);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  // Stripe takes a moment to answer; the test provider answers at once, which would hide the races.
  const charge = app.ctx.payments.chargeSaved, refund = app.ctx.payments.refund;
  app.ctx.payments.chargeSaved = async (a) => { await new Promise((r) => setTimeout(r, 150)); return charge(a); };
  app.ctx.payments.refund = async (a) => { refunds.push(a); await new Promise((r) => setTimeout(r, 50)); return refund(a); };
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  for (const c of [ava, ben]) { await addTestCard(app.ctx, c.id); app.ctx.db.run('UPDATE families SET waiver_version = 1 WHERE id = (SELECT family_id FROM clients WHERE id = ?)', c.id); }
  speed = (await coach('POST', '/v1/programs', { name: 'Summer speed', weeks: 6 })).body;
  const ex = (await coach('POST', '/v1/exercises', { name: 'Wall drill' })).body;
  const w = (await coach('POST', `/v1/programs/${speed.id}/workouts`, { week: 1, day: 1, title: 'A' })).body;
  await coach('POST', `/v1/workouts/${w.id ?? w.workouts?.at(-1)?.id}/exercises`, { exercise_id: ex.id, prescription: '3 x 20' });
  await owner('PUT', `/v1/shop/programs/${speed.id}`, { for_sale: true, price_cents: 4900 });
  maria = await parent('maria@example.com'); dana = await parent('dana@example.com');
});
after(() => app.server.close());

test('three quick taps on Buy charge the card once', async () => {
  const b = { kind: 'program', item_id: speed.id, athlete_id: ava.id };
  const rs = await Promise.all([1, 2, 3].map(() => maria('POST', '/portal/api/shop/buy', b)));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
  assert.equal(salesFor(ava).length, 1);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM purchases WHERE client_id = ?`, ava.id).n, 1);
});

test('the last spot goes to one family, charged once, even when taps land together', async () => {
  const id = newId('cls'), start = new Date(Date.now() + 20 * 3600000).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, status, created_at) VALUES (?, 'Youth speed', 'group', ?, ?, ?, 1, 2500, 'scheduled', ?)`,
    id, facility.id, start, new Date(Date.parse(start) + 3600000).toISOString(), app.ctx.now());
  const before = [salesFor(ava).length, salesFor(ben).length];
  const tap = (who, c) => who('POST', '/portal/api/bookings', { session_id: id, athlete_id: c.id, pay: 'card_on_file' });
  const rs = await Promise.all([tap(maria, ava), tap(maria, ava), tap(dana, ben)]);
  assert.equal(rs.filter((r) => r.status >= 500).length, 0, rs.map((r) => r.body?.error?.message).join(' | '));
  const booked = app.ctx.db.all(`SELECT client_id FROM bookings WHERE session_id = ? AND status = 'booked'`, id);
  assert.equal(booked.length, 1, 'never overbooked');
  const charged = salesFor(ava).length - before[0] + salesFor(ben).length - before[1];
  assert.equal(charged, 1, 'only the family who got the spot paid');
});

test('a pay link paid twice refunds the second payment, even when both land at once', async () => {
  const one = (await owner('POST', '/v1/pay-links', { kind: 'custom', client_id: ava.id, description: 'Camp deposit', amount_cents: 5000 })).body;
  await completePayLink(app.ctx, one.id, 'pi_first');
  await completePayLink(app.ctx, one.id, 'pi_second');
  assert.equal(app.ctx.db.get('SELECT payment_ref FROM pay_links WHERE id = ?', one.id).payment_ref, 'pi_first');
  assert.deepEqual(refunds.filter((r) => r.paymentRef === 'pi_second').map((r) => [r.amountCents, r.idempotencyKey]), [[5000, `pay-link-refund-${one.id}-pi_second`]]);
  const two = (await owner('POST', '/v1/pay-links', { kind: 'custom', client_id: ben.id, description: 'Clinic', amount_cents: 3000 })).body;
  await Promise.all([completePayLink(app.ctx, two.id, 'pi_a'), completePayLink(app.ctx, two.id, 'pi_b')]);
  assert.equal(refunds.filter((r) => ['pi_a', 'pi_b'].includes(r.paymentRef)).length, 1, 'one kept, one refunded');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM sales WHERE note = ?`, `Pay link ${two.id}`).n, 1);
  const mail = app.ctx.db.get(`SELECT body FROM outbox WHERE to_email = 'owner@test.dev' AND subject LIKE 'Refunded a double payment%' AND body LIKE 'Clinic%'`);
  assert.match(mail.body, /a second time/);
});

test('two refund presses at once refund once', async () => {
  const [sale] = salesFor(ava);
  const rs = await Promise.allSettled([refundSale(app.ctx, sale.id, {}), refundSale(app.ctx, sale.id, {})]);
  assert.deepEqual(rs.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(app.ctx.db.get('SELECT refunded_cents FROM sales WHERE id = ?', sale.id).refunded_cents, sale.amount_cents);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'sale.refunded' AND json_extract(data, '$.sale_id') = ?`, sale.id).n, 1);
});

test('the inquiry form only texts US numbers that haven\'t said STOP, and a repeat inquiry can\'t change the number', async () => {
  const ask = (body) => req('POST', '/portal/api/public/inquiry', { parent_name: 'Pat', ...body });
  const textsTo = (phone) => app.ctx.db.all(`SELECT * FROM texts WHERE direction = 'out' AND phone = ?`, phone).length;
  await ask({ email: 'abroad@example.com', phone: '+44 7700 900123', texts_ok: true });
  assert.equal(textsTo('+447700900123'), 0);
  app.ctx.db.run(`INSERT INTO texts (id, direction, phone, kind, body, status, created_at) VALUES (?, 'in', '+15125550111', 'reply', 'Stop', 'received', ?)`, newId('txt'), app.ctx.now());
  await ask({ email: 'stopped@example.com', phone: '(512) 555-0111', texts_ok: true });
  assert.equal(textsTo('+15125550111'), 0);
  await ask({ email: 'real@example.com', phone: '(512) 555-0122', texts_ok: true });
  assert.equal(textsTo('+15125550122'), 1);
  await ask({ email: 'real@example.com', phone: '(512) 555-0199', texts_ok: true, message: 'please call me' });
  const lead = app.ctx.db.get(`SELECT phone, message FROM leads WHERE email = 'real@example.com'`);
  assert.equal(lead.phone, '+15125550122');
  assert.match(lead.message, /please call me \(Gave phone \+15125550199 on a later inquiry\.\)/);
});
