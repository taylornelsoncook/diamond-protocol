// Trial offers under pressure: two athletes tapping one trial link at once, the last spot going while a trial booking
// is in flight, the drop-in lowered below the trial price after the offer went out, and names with $ in the message.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { addTestCard } from '../src/services/commerce.js';
import { resetRateLimits } from '../src/services/security.js';
import { newId } from '../src/util.js';
import { bookOffer } from '../src/services/spots.js';

// Called in-process so both requests pass their checks before either booking finishes, as they do when the card
// charge waits on Stripe.
const both = (calls) => Promise.allSettled(calls.map(([tok, id]) => bookOffer(app.ctx, tok, { athlete_id: id })));
const outcome = (r) => (r.status === 'fulfilled' ? (r.value.booked ? 'booked' : 'waitlisted') : r.reason.status);

let app, base, owner, facility, ava, ben, cole;
const HOUR = 3600000;
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const db = () => app.ctx.db;
const born = (age) => `${new Date().getFullYear() - age}-01-15`;
let slot = 0;   // each session two hours after the last: families can't book an athlete into overlapping sessions
function session(name, { capacity = 6, dropIn = 2500 } = {}) {
  const id = newId('cls'), at = inHours(24 * 3 + 2 * slot++);
  db().run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, status, created_at) VALUES (?, ?, 'group', ?, ?, ?, ?, ?, 'scheduled', ?)`,
    id, name, facility.id, at, new Date(Date.parse(at) + HOUR).toISOString(), capacity, dropIn, app.ctx.now());
  return id;
}
const past = () => { const id = session('Past'); db().run('UPDATE class_sessions SET starts_at = ?, ends_at = ? WHERE id = ?', inHours(-240), inHours(-239), id); return id; };
const offerFor = (sessionId, c) => db().get('SELECT * FROM spot_offers WHERE session_id = ? AND family_id = (SELECT family_id FROM clients WHERE id = ?)', sessionId, c.id);
const fresh = () => db().run(`UPDATE spot_offers SET sent_at = '2020-01-01T00:00:00.000Z'`);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const cookie = (await req('POST', '/auth/login', { email: 'owner@test.dev', password: 'correct-horse-battery' })).cookie;
  owner = (method, path, body) => req(method, path, body, { cookie });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  // Ava and Ben are siblings (one family, one trial link naming both); Cole is another family.
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: born(10), parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Ben$& Lopez', birth_date: born(12) })).body;
  cole = (await owner('POST', '/v1/clients', { name: 'Cole Reed', birth_date: born(12), parent: { name: 'Pat Reed', email: 'pat@example.com' } })).body;
  const done = past();
  for (const c of [ava, ben, cole]) {
    db().run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'attended', 'unpaid', ?, ?)`, newId('bkg'), done, c.id, app.ctx.now(), app.ctx.now());
    db().run('UPDATE families SET waiver_version = 1 WHERE id = (SELECT family_id FROM clients WHERE id = ?)', c.id);
  }
  await addTestCard(app.ctx, ava.id);
  await addTestCard(app.ctx, cole.id);
});
after(() => app.server.close());

test('two athletes tapping the same trial link at once: only one gets the special price', async () => {
  fresh();
  const s = session('Sibling speed');
  await owner('POST', `/v1/sessions/${s}/trial-offer`, { price_cents: 0 });
  const o = offerFor(s, ava);
  assert.deepEqual(o.client_ids.split(',').sort(), [ava.id, ben.id].sort());
  const r = await both([[o.token, ava.id], [o.token, ben.id]]);
  assert.deepEqual(r.map(outcome), ['booked', 409]);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status = 'booked'`, s).n, 1);
});

test('a paid trial link tapped twice at once charges once', async () => {
  fresh();
  const s = session('Paid sibling speed');
  await owner('POST', `/v1/sessions/${s}/trial-offer`, { price_cents: 700 });
  const o = offerFor(s, ava), sales = db().get('SELECT COUNT(*) AS n FROM sales').n;
  const r = await both([[o.token, ava.id], [o.token, ben.id]]);
  assert.deepEqual(r.map(outcome), ['booked', 409]);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM sales').n, sales + 1);
});

test('when the last spot goes while a trial booking is in flight, the family is not waitlisted at the full price', async () => {
  fresh();
  const s = session('One spot speed', { capacity: 1 });
  await owner('POST', `/v1/sessions/${s}/trial-offer`, { price_cents: 500 });
  const oa = offerFor(s, ava), oc = offerFor(s, cole);
  const r = await both([[oc.token, cole.id], [oa.token, ava.id]]);
  assert.deepEqual(r.map(outcome), ['booked', 409]);
  assert.match(r[1].reason.message, /just taken/);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status = 'waitlisted'`, s).n, 0);
  assert.equal(offerFor(s, ava).booked_at, null, 'the link is still usable if a spot opens');
});

test('a trial price never charges more than the drop-in when the drop-in is lowered later', async () => {
  fresh();
  const s = session('Repriced speed', { dropIn: 2500 });
  await owner('POST', `/v1/sessions/${s}/trial-offer`, { price_cents: 2000, max_families: 1 });
  const o = db().get('SELECT o.*, c.id AS cid FROM spot_offers o JOIN clients c ON c.family_id = o.family_id WHERE o.session_id = ? LIMIT 1', s);
  db().run('UPDATE class_sessions SET drop_in_cents = 1500 WHERE id = ?', s);
  const page = (await req('GET', `/portal/api/public/spot/${o.token}`)).body;
  assert.equal(page.trial.price_cents, 1500);
  const b = await req('POST', `/portal/api/public/spot/${o.token}/book`, { athlete_id: o.client_ids.split(',')[0] });
  assert.equal(b.status, 200);
  assert.equal(db().get('SELECT amount_cents FROM sales WHERE id = (SELECT sale_id FROM bookings WHERE id = ?)', offerFor(s, { id: o.client_ids.split(',')[0] }).booking_id).amount_cents, 1500);
});

test('$ in names and messages is sent as typed', async () => {
  fresh();
  const s = session('Dollar speed');
  await owner('POST', `/v1/sessions/${s}/trial-offer`, { price_cents: 1000, message: 'Try {athlete} for {price}. Costs $$ elsewhere.' });
  const mail = db().get(`SELECT body FROM outbox WHERE to_email = 'maria@example.com' AND subject LIKE 'Try Dollar speed%'`);
  assert.ok(mail.body.includes('Try Ava or Ben$& for $10. Costs $$ elsewhere.'), mail.body);
});
