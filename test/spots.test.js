// Filling light classes: who fits, offers by email and text, first to book gets the spot, and the automatic mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { addTestCard, adjustCredits } from '../src/services/commerce.js';
import { runSlotFilling } from '../src/services/spots.js';
import { resetRateLimits } from '../src/services/security.js';
import { newId } from '../src/util.js';

let app, base, owner, coach, desk, facility, ava, ben, cole, mia, speed;
const HOUR = 3600000;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (method, path, body) => req(method, path, body, { cookie });
}
const born = (age) => `${new Date().getFullYear() - age}-01-15`;
function session(name, startsAt, { capacity = 4, kind = 'group', ageMin = 8, ageMax = 12 } = {}) {
  const id = newId('cls'), end = new Date(Date.parse(startsAt) + HOUR).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, age_min, age_max, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 2500, ?, ?, 'scheduled', ?)`,
    id, name, kind, facility.id, startsAt, end, capacity, ageMin, ageMax, app.ctx.now());
  return id;
}
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();
const attended = (clientId, daysAgo) => {
  const sid = session('Past class', new Date(Date.now() - daysAgo * 86400000).toISOString());
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'attended', 'unpaid', ?, ?)`, newId('bkg'), sid, clientId, app.ctx.now(), app.ctx.now());
};
const signWaiver = (c) => app.ctx.db.run('UPDATE families SET waiver_version = 1 WHERE id = (SELECT family_id FROM clients WHERE id = ?)', c.id);
const offerFor = (sessionId, c) => app.ctx.db.get('SELECT * FROM spot_offers WHERE session_id = ? AND family_id = (SELECT family_id FROM clients WHERE id = ?)', sessionId, c.id);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  const kid = async (name, age, parent, email) => (await owner('POST', '/v1/clients', { name, birth_date: born(age), parent: { name: parent, email } })).body;
  ava = await kid('Ava Lopez', 10, 'Maria Lopez', 'maria@example.com');
  ben = await kid('Ben Park', 17, 'Dana Park', 'dana@example.com');       // too old for ages 8-12
  cole = await kid('Cole Reed', 11, 'Pat Reed', 'pat@example.com');       // fits the age but has never come
  mia = await kid('Mia Chen', 9, 'Lee Chen', 'lee@example.com');
  for (const c of [ava, ben, mia]) attended(c.id, 10);
  for (const c of [ava, mia]) signWaiver(c);
  adjustCredits(app.ctx, mia.id, { credit_type: 'group', delta: 2, note: 'Pack' });
  speed = session('Youth speed', inHours(20), { capacity: 2 });
});
after(() => app.server.close());

test('light classes show with the families who fit; front desk sees nothing', async () => {
  const r = (await coach('GET', '/v1/open-spots')).body;
  const s = r.data.find((x) => x.id === speed);
  assert.equal(r.mode, 'suggest');
  assert.deepEqual([s.spots_left, s.families_who_fit, s.offers.sent], [2, 2, 0], 'Ava and Mia fit; Ben is too old and Cole has never come');
  assert.equal(r.data.some((x) => x.name === 'Past class'), false);
  assert.equal((await desk('GET', '/v1/open-spots')).status, 403);
  assert.equal((await desk('POST', `/v1/sessions/${speed}/offer-spots`)).status, 403);
});

test('offers go out once per family, by email with a link that needs no sign-in', async () => {
  const r = (await coach('POST', `/v1/sessions/${speed}/offer-spots`)).body;
  assert.deepEqual([r.sent, r.families_left, r.offers.sent], [2, 0, 2]);
  assert.equal((await coach('POST', `/v1/sessions/${speed}/offer-spots`)).body.sent, 0, 'nobody gets the same offer twice');
  const mail = app.ctx.db.get(`SELECT * FROM outbox WHERE to_email = 'maria@example.com' AND subject LIKE 'Open spot: Youth speed%'`);
  const tok = offerFor(speed, ava).token;
  assert.ok(mail.body.includes(`/spot/${tok}`));
  assert.match(mail.body, /Ava/);
  assert.equal(offerFor(speed, ben), undefined);
  const page = (await req('GET', `/portal/api/public/spot/${tok}`)).body;
  assert.deepEqual([page.status, page.session.name, page.session.spots_left, page.athletes.map((a) => a.first_name), page.waiver_signed], ['open', 'Youth speed', 2, ['Ava'], true]);
  assert.equal(JSON.stringify(page).includes('Mia'), false, 'only this family\'s athletes');
  assert.ok(offerFor(speed, ava).opened_at);
  assert.equal((await fetch(`${base}/spot/${tok}`)).status, 200);
});

test('booking from the offer uses the usual cover, and first to book gets the last spot', async () => {
  const miaTok = offerFor(speed, mia).token, avaTok = offerFor(speed, ava).token;
  const wrong = await req('POST', `/portal/api/public/spot/${miaTok}/book`, { athlete_id: ava.id });
  assert.equal(wrong.status, 404, 'another family\'s athlete');
  const m = (await req('POST', `/portal/api/public/spot/${miaTok}/book`, { athlete_id: mia.id })).body;
  assert.deepEqual([m.booked, m.coverage, m.status], [true, 'credit', 'booked']);
  assert.equal(offerFor(speed, mia).booked_at != null, true);
  // Ava has nothing to cover it: asked to pay, then pays with the family card.
  const needPay = await req('POST', `/portal/api/public/spot/${avaTok}/book`, { athlete_id: ava.id });
  assert.equal(needPay.status, 402);
  await addTestCard(app.ctx, ava.id);
  const a = (await req('POST', `/portal/api/public/spot/${avaTok}/book`, { athlete_id: ava.id, pay: 'card_on_file' })).body;
  assert.deepEqual([a.booked, a.coverage], [true, 'paid']);
  assert.match(a.message, /\$25 was charged/);
  // Now full: the class drops off the list.
  assert.equal((await coach('GET', '/v1/open-spots')).body.data.some((x) => x.id === speed), false);
});

test('a full session says so, and an unsigned waiver sends them to the portal first', async () => {
  const full = session('Full class', inHours(26), { capacity: 1 });
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'membership', ?, ?)`, newId('bkg'), full, ben.id, app.ctx.now(), app.ctx.now());
  assert.equal((await coach('POST', `/v1/sessions/${full}/offer-spots`)).status, 409);
  const open = session('Waiver class', inHours(30), { capacity: 3 });
  app.ctx.db.run('UPDATE families SET waiver_version = NULL WHERE id = (SELECT family_id FROM clients WHERE id = ?)', mia.id);
  await coach('POST', `/v1/sessions/${open}/offer-spots`);
  const r = await req('POST', `/portal/api/public/spot/${offerFor(open, mia).token}/book`, { athlete_id: mia.id });
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /waiver/);
  signWaiver(mia);
  // Fill it up, then the offer page says it's taken.
  for (let i = 0; i < 3; i++) app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'membership', ?, ?)`, newId('bkg'), open, [ben, cole, ava][i].id, app.ctx.now(), app.ctx.now());
  const late = await req('POST', `/portal/api/public/spot/${offerFor(open, mia).token}/book`, { athlete_id: mia.id });
  assert.equal(late.status, 409);
  assert.match(late.body.error.message, /just taken/);
  assert.equal((await req('GET', `/portal/api/public/spot/${offerFor(open, mia).token}`)).body.status, 'full');
});

test('automatic mode sends in the daytime only; owners pick the mode', async () => {
  assert.equal((await coach('PATCH', '/v1/settings', { open_spot_offers: 'auto' })).status, 403);
  assert.equal((await owner('PATCH', '/v1/settings', { open_spot_offers: 'auto' })).status, 200);
  // 20:00 UTC is mid-afternoon in Chicago; 08:00 UTC is the middle of the night.
  const day = new Date(Date.now() + 86400000); day.setUTCHours(20, 0, 0, 0);
  const night = new Date(day); night.setUTCHours(8);
  // At most 2 offers a family a day: Ava and Mia already had theirs, so nothing goes out until a day has passed.
  const capped = session('Capped class', inHours(40), { capacity: 3 });
  assert.equal((await coach('POST', `/v1/sessions/${capped}/offer-spots`)).body.sent, 0);
  app.ctx.db.run(`UPDATE spot_offers SET sent_at = '2020-01-01T00:00:00.000Z'`);
  const later = session('Tomorrow speed', new Date(day.getTime() + 20 * HOUR).toISOString(), { capacity: 5 });
  assert.equal(await runSlotFilling(app.ctx, { asOf: night.toISOString() }), 0);
  assert.ok(await runSlotFilling(app.ctx, { asOf: day.toISOString() }) >= 1);
  assert.ok(offerFor(later, ava));
  assert.equal(offerFor(later, ava).sent_by, 'Automatic');
  assert.equal(await runSlotFilling(app.ctx, { asOf: new Date(day.getTime() + HOUR).toISOString() }), 0, 'not again within 12 hours');
  await owner('PATCH', '/v1/settings', { open_spot_offers: 'off' });
  assert.deepEqual((await coach('GET', '/v1/open-spots')).body.data, []);
});
