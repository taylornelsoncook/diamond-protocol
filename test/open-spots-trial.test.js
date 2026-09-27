// Every class with an open spot on Today (all kinds families book singly, 7 days, every coach), trial offers at a special
// price from Today (owner only; the price applies to that link alone), and the owner's Coaches panel. No money for coaches.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { addTestCard } from '../src/services/commerce.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDaysToDate, localDate, newId } from '../src/util.js';

let app, base, owner, coach, desk, ownerId, carlId, rileyId, facility, park;
let ava, mia, cole, zoe, groupSoon, clinic, campDay, campWhole, priv, evalS, team, farOut, fullS, tooSoon, rileyClass;
const HOUR = 3600000;
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email) => as((await req('POST', '/auth/login', { email, password: 'correct-horse-battery' })).cookie);
const born = (age) => `${new Date().getFullYear() - age}-01-15`;
const db = () => app.ctx.db;
function session(name, startsAt, { kind = 'group', capacity = 6, coachId = null, dropIn = 2500, seriesId = null, location = facility, ageMin = 8, ageMax = 14 } = {}) {
  const id = newId('cls');
  db().run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, age_min, age_max, coach_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
    id, seriesId, name, kind, location.id, startsAt, new Date(Date.parse(startsAt) + HOUR).toISOString(), capacity, dropIn, ageMin, ageMax, coachId, app.ctx.now());
  return id;
}
const bookRow = (sessionId, clientId, status = 'booked', coverage = 'membership') =>
  db().run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, newId('bkg'), sessionId, clientId, status, coverage, app.ctx.now(), app.ctx.now());
const attended = (clientId, daysAgo, coachId = null) => bookRow(session('Past class', new Date(Date.now() - daysAgo * 86400000).toISOString(), { coachId }), clientId, 'attended', 'unpaid');
const offerFor = (sessionId, c) => db().get('SELECT * FROM spot_offers WHERE session_id = ? AND family_id = (SELECT family_id FROM clients WHERE id = ?)', sessionId, c.id);
const noCents = (x) => !JSON.stringify(x).includes('_cents');

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  ownerId = createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'correct-horse-battery' }).id;
  carlId = createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'correct-horse-battery', role: 'coach' }).id;
  rileyId = createUser(app.ctx, { email: 'riley@test.dev', name: 'Riley Brooks', password: 'correct-horse-battery', role: 'coach' }).id;
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  park = (await owner('POST', '/v1/locations', { name: 'Zilker Park', kind: 'park' })).body;
  const kid = async (name, age, parent, email) => (await owner('POST', '/v1/clients', { name, birth_date: born(age), parent: { name: parent, email } })).body;
  ava = await kid('Ava Lopez', 10, 'Maria Lopez', 'maria@example.com');
  mia = await kid('Mia Chen', 11, 'Lee Chen', 'lee@example.com');
  cole = await kid('Cole Reed', 12, 'Pat Reed', 'pat@example.com');
  zoe = await kid('Zoe Hart', 9, 'Sam Hart', 'sam@example.com');
  for (const c of [ava, mia, cole, zoe]) { attended(c.id, 10); db().run('UPDATE families SET waiver_version = 1 WHERE id = (SELECT family_id FROM clients WHERE id = ?)', c.id); }
  await addTestCard(app.ctx, ava.id);
  await addTestCard(app.ctx, cole.id);
  // Zoe is a member: a membership that covers group classes still covers a trial offer.
  db().run(`INSERT INTO plans (id, name, price_cents, created_at) VALUES ('pln_t', 'Unlimited', 12000, ?)`, app.ctx.now());
  db().run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_t', ?, 'pln_t', 'active', ?, ?, ?, ?)`, zoe.id, app.ctx.now(), inHours(700), app.ctx.now(), app.ctx.now());
  // The week: every kind, several coaches and days, plus what shouldn't show.
  const campSeries = (id, reg, drop) => db().run(`INSERT INTO class_series (id, name, kind, location_id, weekdays, start_time, duration_min, capacity, registration_cents, drop_in_cents, start_date, end_date, active, created_at) VALUES (?, 'Fall camp', 'camp', ?, '[1]', '09:00', 60, 10, ?, ?, '2026-01-01', '2027-01-01', 1, ?)`, id, facility.id, reg, drop, app.ctx.now());
  campSeries('ser_day', 25000, 4000); campSeries('ser_whole', 25000, null);
  farOut = session('Next week speed', inHours(24 * 7 + 6), { coachId: carlId });
  rileyClass = session('Park sprints', inHours(24 * 5), { coachId: rileyId, location: park });
  clinic = session('QB clinic', inHours(24 * 3), { kind: 'clinic', coachId: ownerId, dropIn: 6500, location: park });
  campDay = session('Fall camp', inHours(24 * 2), { kind: 'camp', seriesId: 'ser_day', dropIn: 4000 });
  campWhole = session('Fall camp', inHours(24 * 2 + 1), { kind: 'camp', seriesId: 'ser_whole', dropIn: null });
  priv = session('Private', inHours(30), { kind: 'private', capacity: 1, coachId: carlId, dropIn: 8000 });
  evalS = session('Evaluation', inHours(31), { kind: 'evaluation', capacity: 1, coachId: carlId, dropIn: 7500 });
  team = session('Westlake team', inHours(32), { kind: 'team', capacity: 40, coachId: carlId, dropIn: null });
  groupSoon = session('Youth speed', inHours(20), { coachId: carlId, capacity: 3 });
  fullS = session('Full class', inHours(26), { coachId: carlId, capacity: 1 });
  bookRow(fullS, mia.id);
  bookRow(priv, mia.id, 'booked', 'unpaid');
  tooSoon = session('Starting soon', inHours(1), { coachId: rileyId });
});
after(() => app.server.close());

test('every class with an open spot in the next 7 days shows, soonest first, for every coach', async () => {
  const r = (await owner('GET', '/v1/open-spots')).body;
  const ids = r.data.map((x) => x.id);
  assert.deepEqual(ids, [tooSoon, groupSoon, campDay, clinic, rileyClass], 'group, clinic and camp days; not privates, evaluations, team sessions, whole-camp-only days, full classes or next week');
  assert.deepEqual(r.data.map((x) => x.starts_at), [...r.data.map((x) => x.starts_at)].sort());
  const row = r.data.find((x) => x.id === rileyClass);
  assert.deepEqual([row.coach_name, row.location_name, row.booked, row.capacity, row.spots_left, row.families_who_fit], ['Riley Brooks', 'Zilker Park', 0, 6, 6, 4]);
  assert.equal(r.data.find((x) => x.id === clinic).coach_name, 'Olivia Owner');
  assert.equal(row.drop_in_cents, 2500, 'the owner sees prices');
  assert.equal(r.days, 7);
  // Longer look ahead, and the offer rules: under 2 hours can't take offers, and says why.
  assert.ok((await owner('GET', '/v1/open-spots?days=14')).body.data.some((x) => x.id === farOut));
  assert.equal((await owner('GET', '/v1/open-spots?days=40')).status, 400);
  const soon = r.data.find((x) => x.id === tooSoon);
  assert.deepEqual([soon.can_offer, soon.can_trial], [false, false]);
  assert.match(soon.offer_note, /under 2 hours/);
  assert.equal(row.can_offer, true, 'five days out: a coach can still send offers by hand');
});

test('coaches see every coach\'s classes with no money, and can narrow to their own; front desk sees none', async () => {
  const all = (await coach('GET', '/v1/open-spots')).body;
  assert.equal(all.data.length, 5);
  assert.ok(noCents(all), 'no prices or trial prices reach a coach');
  const mine = (await coach('GET', '/v1/open-spots?coach_id=me')).body.data;
  assert.deepEqual(mine.map((x) => x.id), [groupSoon]);
  assert.deepEqual((await owner('GET', `/v1/open-spots?coach_id=${rileyId}`)).body.data.map((x) => x.id), [tooSoon, rileyClass]);
  assert.equal((await desk('GET', '/v1/open-spots')).status, 403);
});

test('standard offers work by hand for a camp day and a class days away; the automatic job is unchanged', async () => {
  const r = (await coach('POST', `/v1/sessions/${campDay}/offer-spots`)).body;
  assert.ok(r.sent >= 1);
  assert.ok(offerFor(campDay, ava));
  assert.equal(offerFor(campDay, ava).price_cents, null, 'a standard offer has no special price');
  assert.equal((await coach('POST', `/v1/sessions/${campWhole}/offer-spots`)).status, 409, 'camps sold only as a whole take no offers');
  assert.equal((await coach('POST', `/v1/sessions/${tooSoon}/offer-spots`)).status, 409);
});

test('trial offers are owner only, on the server', async () => {
  for (const who of [coach, desk]) {
    assert.equal((await who('GET', `/v1/sessions/${rileyClass}/trial-offer`)).status, 403);
    assert.equal((await who('POST', `/v1/sessions/${rileyClass}/trial-offer`, { price_cents: 1000 })).status, 403);
  }
  assert.equal(offerFor(rileyClass, ava), undefined, 'nothing was sent');
  const p = (await owner('GET', `/v1/sessions/${rileyClass}/trial-offer`)).body;
  assert.deepEqual([p.default_price_cents, p.max_price_cents, p.families, p.max_families], [2500, 2500, 4, 30]);
  assert.match(p.message, /\{athlete\}/);
  assert.equal(p.expires_at, db().get('SELECT starts_at FROM class_sessions WHERE id = ?', rileyClass).starts_at);
});

test('the price is checked: whole cents from $0 to the drop-in', async () => {
  for (const price_cents of [2501, -1, 10.5, 'ten', null]) {
    const r = await owner('POST', `/v1/sessions/${rileyClass}/trial-offer`, { price_cents });
    assert.equal(r.status, 400, String(price_cents));
    assert.match(r.body.error.message, /\$0 \(free\) to \$25/);
  }
  assert.equal((await owner('POST', `/v1/sessions/${rileyClass}/trial-offer`, { price_cents: 1000, max_families: 0 })).status, 400);
  assert.equal((await owner('POST', `/v1/sessions/${rileyClass}/trial-offer`, { price_cents: 1000, message: 'x'.repeat(1001) })).status, 400);
  assert.equal((await owner('POST', `/v1/sessions/${tooSoon}/trial-offer`, { price_cents: 1000 })).status, 409);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM spot_offers WHERE session_id = ?', rileyClass).n, 0);
});

test('a $10 trial offer goes out by email, is logged, and books at $10 once; other bookings keep their price', async () => {
  const r = (await owner('POST', `/v1/sessions/${rileyClass}/trial-offer`, { price_cents: 1000, max_families: 3, message: 'Bring {athlete} to try sprints for {price}.' })).body;
  assert.deepEqual([r.sent, r.price_cents], [3, 1000]);
  const o = offerFor(rileyClass, ava);
  assert.equal(o.price_cents, 1000);
  const mail = db().get(`SELECT * FROM outbox WHERE to_email = 'maria@example.com' AND subject LIKE 'Try Park sprints for $10%'`);
  assert.ok(mail.body.includes('Bring Ava to try sprints for $10.'));
  assert.ok(mail.body.includes(`/spot/${o.token}`));
  assert.ok(db().get(`SELECT 1 FROM audit_log WHERE action = 'trial offer at $10.00 sent to 3 families' AND target = ? AND actor_name = 'Olivia Owner'`, rileyClass));
  const ev = db().get(`SELECT data FROM events WHERE type = 'spots.offered' ORDER BY rowid DESC LIMIT 1`);
  assert.deepEqual([JSON.parse(ev.data).trial, JSON.parse(ev.data).price_cents], [true, 1000]);
  // Stats on the row: the owner sees the price, a coach sees the count only.
  const row = (await owner('GET', '/v1/open-spots')).body.data.find((x) => x.id === rileyClass);
  assert.deepEqual([row.offers.trial_sent, row.offers.trial_price_cents], [3, 1000]);
  const coachRow = (await coach('GET', '/v1/open-spots')).body.data.find((x) => x.id === rileyClass);
  assert.deepEqual([coachRow.offers.trial_sent, coachRow.offers.trial_price_cents], [3, undefined]);
  const coachEvents = (await coach('GET', '/v1/events?type=spots.offered')).body;
  assert.ok(noCents(coachEvents), 'the activity feed hides the trial price from coaches');

  // The family's page shows the special price; booking charges $10, not the $25 drop-in.
  const page = (await req('GET', `/portal/api/public/spot/${o.token}`)).body;
  assert.deepEqual(page.trial, { price_cents: 1000, used: false });
  const b = (await req('POST', `/portal/api/public/spot/${o.token}/book`, { athlete_id: ava.id })).body;
  assert.deepEqual([b.booked, b.coverage], [true, 'paid']);
  assert.match(b.message, /\$10 was charged/);
  const booking = db().get('SELECT * FROM bookings WHERE session_id = ? AND client_id = ?', rileyClass, ava.id);
  assert.equal(db().get('SELECT amount_cents FROM sales WHERE id = ?', booking.sale_id).amount_cents, 1000);
  assert.equal(offerFor(rileyClass, ava).booked_at != null, true);
  assert.equal((await req('POST', `/portal/api/public/spot/${o.token}/book`, { athlete_id: ava.id })).status, 409, 'used once');
  // A standard offer elsewhere still charges the drop-in.
  const std = (await req('POST', `/portal/api/public/spot/${offerFor(campDay, ava).token}/book`, { athlete_id: ava.id, pay: 'card_on_file' })).body;
  assert.match(std.message, /\$40 was charged/);
  assert.equal(db().get('SELECT amount_cents FROM sales WHERE id = (SELECT sale_id FROM bookings WHERE session_id = ? AND client_id = ?)', campDay, ava.id).amount_cents, 4000);
  // Booking the same athlete into another class the usual way is at the usual price.
  const normal = await owner('POST', `/v1/sessions/${clinic}/bookings`, { client_id: ava.id, pay: 'card_on_file' });
  assert.equal(normal.status, 201);
  assert.equal(db().get('SELECT amount_cents FROM sales WHERE id = ?', normal.body.sale_id).amount_cents, 6500);
});

test('a free trial books with nothing to pay; a member is covered; no card means add one first', async () => {
  db().run(`UPDATE spot_offers SET sent_at = '2020-01-01T00:00:00.000Z'`);      // yesterday's offers don't count toward today's 2
  const s = session('Saturday speed', inHours(24 * 4), { coachId: carlId });
  const r = (await owner('POST', `/v1/sessions/${s}/trial-offer`, { price_cents: 0 })).body;
  assert.ok(r.sent >= 3);
  assert.match(db().get(`SELECT subject FROM outbox WHERE to_email = 'pat@example.com' ORDER BY rowid DESC LIMIT 1`).subject, /^Try Saturday speed free/);
  const sales = db().get('SELECT COUNT(*) AS n FROM sales').n;
  const c = (await req('POST', `/portal/api/public/spot/${offerFor(s, cole).token}/book`, { athlete_id: cole.id })).body;
  assert.deepEqual([c.booked, c.coverage], [true, 'none']);
  assert.match(c.message, /free/);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM sales').n, sales, 'nothing charged');
  const z = (await req('POST', `/portal/api/public/spot/${offerFor(s, zoe).token}/book`, { athlete_id: zoe.id })).body;
  assert.deepEqual([z.booked, z.coverage], [true, 'membership']);
  // Mia's family has no card: a paid trial asks them to add one.
  const paid = session('Sunday speed', inHours(24 * 4 + 3), { coachId: carlId });
  await owner('POST', `/v1/sessions/${paid}/trial-offer`, { price_cents: 500 });
  const m = await req('POST', `/portal/api/public/spot/${offerFor(paid, mia).token}/book`, { athlete_id: mia.id });
  assert.equal(m.status, 402);
  assert.match(m.body.error.message, /Add a card/);
});

test('families who had a standard offer get the trial price on the same link', async () => {
  const s = session('Evening speed', inHours(24 * 5 + 2), { coachId: carlId, ageMin: 11, ageMax: 12 });
  db().run(`UPDATE spot_offers SET sent_at = '2020-01-01T00:00:00.000Z'`);      // yesterday's offers don't count toward today's 2
  await coach('POST', `/v1/sessions/${s}/offer-spots`);
  const before = offerFor(s, mia);
  assert.equal(before.price_cents, null);
  const p = (await owner('GET', `/v1/sessions/${s}/trial-offer`)).body;
  assert.ok(p.offered_before >= 1);
  await owner('POST', `/v1/sessions/${s}/trial-offer`, { price_cents: 1500 });
  const afterOffer = offerFor(s, mia);
  assert.deepEqual([afterOffer.token, afterOffer.price_cents], [before.token, 1500]);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM spot_offers WHERE session_id = ? AND family_id = ?', s, before.family_id).n, 1);
});

test('the owner\'s Coaches panel: each coach\'s day, week, attendance and time off; owner only', async () => {
  const done = session('Past speed', new Date(Date.now() - 2 * 86400000).toISOString(), { coachId: carlId });
  bookRow(done, ava.id, 'attended', 'membership'); bookRow(done, mia.id, 'no_show', 'membership');
  const offDay = addDaysToDate(localDate(new Date().toISOString(), 'America/Chicago'), 10);
  await owner('POST', '/v1/time-off', { user_id: carlId, start_date: offDay, note: 'Wedding' });
  const r = (await owner('GET', '/v1/coach-summary')).body;
  assert.deepEqual(r.coaches.map((c) => c.name), ['Carl Coach', 'Olivia Owner', 'Riley Brooks']);
  const carl = r.coaches.find((c) => c.id === carlId);
  assert.ok(carl.week.sessions >= 5);
  assert.equal(carl.week.privates_booked, 1);
  assert.deepEqual(carl.attendance_7_days, { came: 1, missed: 1 });
  assert.deepEqual(carl.time_off.map((t) => [t.start_date, t.note]), [[offDay, 'Wedding']]);
  assert.ok(carl.next_session);
  assert.ok(carl.week.fill_pct >= 0 && carl.week.fill_pct <= 100);
  const riley = r.coaches.find((c) => c.id === rileyId);
  assert.ok(riley.week.sessions >= 2);
  assert.equal(riley.next_session.id, tooSoon);
  assert.ok(r.no_coach.sessions >= 2, 'the camp days have no coach');
  assert.ok(noCents(r));
  assert.equal((await coach('GET', '/v1/coach-summary')).status, 403);
  assert.equal((await desk('GET', '/v1/coach-summary')).status, 403);
});
