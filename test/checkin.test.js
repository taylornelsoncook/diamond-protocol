import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { qrMatrix, qrSvg } from '../public/js/qr.js';
import { newId } from '../src/util.js';

// Self check-in: the front-desk tablet and the QR code on the door.
let app, base, owner, frontDesk, facility, park, ava, ben, lia, speed, later, parent, kioskKey;
const MIN = 60000;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const kiosk = async (method, path, body, key = kioskKey) => {
  const r = await fetch(base + path, { method, headers: { 'x-kiosk-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
function session(name, loc, startsInMin, lengthMin = 60) {
  const id = newId('cls'), s = new Date(Date.now() + startsInMin * MIN).toISOString(), e = new Date(Date.now() + (startsInMin + lengthMin) * MIN).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, status, created_at) VALUES (?, ?, 'group', ?, ?, ?, 10, 2500, 'scheduled', ?)`, id, name, loc.id, s, e, s);
  return id;
}
const book = (sessionId, client, coverage = 'membership') => {
  const id = newId('bkg');
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', ?, ?, ?)`, id, sessionId, client.id, coverage, app.ctx.now(), app.ctx.now());
  return id;
};

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); frontDesk = await signIn('desk@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  park = (await owner('POST', '/v1/locations', { name: 'Zilker Park', kind: 'park' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  lia = (await owner('POST', `/v1/families/${app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', ava.id).family_id}/athletes`, { name: 'Lia Lopez' })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Van Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  speed = session('Speed', facility, 20);       // opens now: starts in 20 minutes
  later = session('Strength', facility, 90);    // not open yet
  book(speed, ava); book(speed, ben, 'unpaid'); book(later, lia);
  const { body } = await (await fetch(base + '/portal/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com' }) })).json().then((b) => ({ body: b }));
  const v = await fetch(base + '/portal/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com', code: body.dev_code }) });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  parent = async (method, path, b) => { const r = await fetch(base + path, { method, headers: { cookie, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
});
after(() => app.server.close());

test('the QR code maker encodes links of any length a poster needs', () => {
  for (const [text, size] of [['A', 21], ['https://app.diamondprotocol.org/here/Xk3v9Qp2Lm', 33], ['x'.repeat(200), 57]]) assert.equal(qrMatrix(text).length, size);
  const m = qrMatrix('https://app.example.org/here/abc');
  assert.deepEqual(m[0].slice(0, 7), [true, true, true, true, true, true, true], 'finder pattern in the corner');
  assert.equal(m[6].slice(8, m.length - 8).map((d, i) => d === (i % 2 === 0)).every(Boolean), true, 'timing pattern');
  assert.match(qrSvg('hi'), /^<svg [^>]*viewBox="0 0 29 29"/);
  assert.throws(() => qrMatrix('x'.repeat(300)), /too long/);
});

test('a front-desk tablet shows sessions open for check-in and athletes tap their name', async () => {
  const k = await frontDesk('POST', '/v1/kiosks', { location_id: facility.id });
  assert.equal(k.status, 201);
  assert.match(k.body.link, /^https:\/\/app\.example\.org\/kiosk#[\w-]{20,}$/);
  kioskKey = k.body.link.split('#')[1];
  assert.equal((await fetch(`${base}/kiosk`)).status, 200);
  const board = (await kiosk('GET', '/kiosk-api/board')).body;
  assert.equal(board.location_name, 'Facility');
  assert.deepEqual(board.sessions.map((s) => s.name), ['Speed'], 'Strength opens later');
  assert.deepEqual(board.sessions[0].athletes.map((a) => a.name), ['Ava L.', 'Ben P.'], 'first name and last initial only');
  assert.ok(!JSON.stringify(board).includes('Lopez'));
  const r = await kiosk('POST', '/kiosk-api/check-in', { booking_id: board.sessions[0].athletes[0].booking_id });
  assert.deepEqual(r.body, { name: 'Ava', session: 'Speed', already: false, pay_at_desk: false });
  const roster = (await owner('GET', `/v1/sessions/${speed}`)).body.roster;
  assert.equal(roster.find((x) => x.name === 'Ava Lopez').status, 'attended');
  assert.equal((await kiosk('POST', '/kiosk-api/check-in', { booking_id: board.sessions[0].athletes[0].booking_id })).body.already, true);
  assert.equal((await kiosk('POST', '/kiosk-api/check-in', { booking_id: board.sessions[0].athletes[1].booking_id })).body.pay_at_desk, true, 'Ben\'s drop-in isn\'t paid');
  const laterBooking = app.ctx.db.get('SELECT id FROM bookings WHERE session_id = ?', later).id;
  assert.equal((await kiosk('POST', '/kiosk-api/check-in', { booking_id: laterBooking })).status, 409, 'not open yet');
  assert.equal((await kiosk('GET', '/kiosk-api/board', null, 'wrong-key')).status, 401);
  const list = (await owner('GET', '/v1/kiosks')).body.data;
  assert.ok(list[0].last_seen_at);
  assert.equal((await frontDesk('DELETE', `/v1/kiosks/${list[0].id}`)).status, 403, 'front desk sets up tablets but can\'t remove them');
  await owner('DELETE', `/v1/kiosks/${list[0].id}`);
  assert.equal((await kiosk('GET', '/kiosk-api/board')).status, 401, 'a removed tablet stops working');
});

test('a tablet at another location can\'t check in this location\'s sessions', async () => {
  const k = (await owner('POST', '/v1/kiosks', { location_id: park.id })).body;
  const key = k.link.split('#')[1];
  assert.equal((await kiosk('GET', '/kiosk-api/board', null, key)).body.sessions.length, 0);
  const benBooking = app.ctx.db.get('SELECT id FROM bookings WHERE session_id = ? AND client_id = ?', speed, ben.id).id;
  app.ctx.db.run(`UPDATE bookings SET status = 'booked' WHERE id = ?`, benBooking);
  assert.equal((await kiosk('POST', '/kiosk-api/check-in', { booking_id: benBooking }, key)).status, 409);
});

test('parents check in their own athletes from the door QR code', async () => {
  const code = (await frontDesk('GET', `/v1/locations/${facility.id}/check-in-code`)).body;
  assert.match(code.url, /^https:\/\/app\.example\.org\/here\/\w{10}$/);
  assert.equal((await owner('GET', `/v1/locations/${facility.id}/check-in-code`)).body.code, code.code, 'the same code until reset');
  assert.equal((await fetch(`${base}/here/${code.code}`)).status, 200);
  assert.equal((await fetch(`${base}/poster.html?code=${code.code}`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/here-api/${code.code}`)).json(), { business_name: 'Diamond Protocol', location_name: 'Facility' });

  app.ctx.db.run(`UPDATE bookings SET status = 'booked' WHERE session_id = ?`, speed);
  const mine = (await parent('GET', `/portal/api/check-in?code=${code.code}`)).body;
  assert.deepEqual(mine.data.map((b) => [b.athlete, b.session, b.checked_in]), [['Ava', 'Speed', false]], 'only Maria\'s athletes, only open sessions');
  const done = (await parent('POST', '/portal/api/check-in', { code: code.code })).body;
  assert.deepEqual(done.checked_in.map((c) => c.athlete), ['Ava']);
  assert.equal(app.ctx.db.get('SELECT status FROM bookings WHERE session_id = ? AND client_id = ?', speed, ava.id).status, 'attended');
  const benBooking = app.ctx.db.get('SELECT id FROM bookings WHERE session_id = ? AND client_id = ?', speed, ben.id).id;
  assert.equal((await parent('POST', '/portal/api/check-in', { code: code.code, booking_id: benBooking })).status, 409, 'can\'t check in someone else\'s child');
  assert.equal((await parent('POST', '/portal/api/check-in', { code: code.code })).status, 409, 'nobody left to check in');

  const fresh = (await owner('POST', `/v1/locations/${facility.id}/check-in-code/reset`)).body;
  assert.notEqual(fresh.code, code.code);
  assert.equal((await parent('GET', `/portal/api/check-in?code=${code.code}`)).status, 404, 'old posters stop working');
  assert.equal((await fetch(`${base}/portal/api/check-in?code=${fresh.code}`)).status, 401, 'parents sign in first');
});
