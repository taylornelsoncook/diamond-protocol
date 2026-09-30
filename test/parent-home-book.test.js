// Parent portal, Home and Book (batch B12): sign-in lock and devices, session rows and details, the private calendar
// feed, card expiry, no double bookings for families, privates with a coach and a note, cancelling in place (credit or
// refund exactly once, the time opens again, the coach is told), and camps. Every new endpoint is checked against another
// family.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addTestCard } from '../src/services/commerce.js';
import { newId, localDate, addDaysToDate, weekdayOf } from '../src/util.js';
import { LOCK_WRONG_CODES, resetSignInLocks } from '../src/services/families.js';

const TZ = 'America/Chicago';
const HOUR = 3600000;
let app, base, owner, riley, facility, ava, ben, cole, maria, dana;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, res, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
async function parentCookie(email, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1') {
  const { body } = await req('POST', '/portal/api/login', { email });
  return (await req('POST', '/portal/api/verify', { email, code: body.dev_code }, { 'user-agent': ua })).cookie;
}
const db = () => app.ctx.db;
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();
const born = (age) => `${new Date().getFullYear() - age}-01-15`;
function session(name, startH, { kind = 'group', capacity = 6, dropIn = 2500, coachId = null, durH = 1 } = {}) {
  const id = newId('cls');
  db().run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, coach_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
    id, name, kind, facility.id, inHours(startH), inHours(startH + durH), capacity, dropIn, coachId, app.ctx.now());
  return id;
}
const outbox = () => db().all('SELECT * FROM outbox ORDER BY created_at DESC, rowid DESC');

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  const rileyUser = createUser(app.ctx, { email: 'riley@test.dev', name: 'Riley Brooks', password: 'coach-password-1', role: 'coach' });
  riley = rileyUser;
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ, late_cancel_hours: 12 });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: born(12), medical_notes: 'Peanut allergy', parent: { name: 'Maria Lopez', email: 'maria@example.com', phone: '5125550101' } })).body;
  ben = (await owner('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Ben Lopez', birth_date: born(10) })).body;
  cole = (await owner('POST', '/v1/clients', { name: 'Cole Park', birth_date: born(12), parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  for (const c of [ava, cole]) { db().run('UPDATE families SET waiver_version = 1 WHERE id = ?', c.family.id); await addTestCard(app.ctx, c.id); }
  maria = as(await parentCookie('maria@example.com'));
  dana = as(await parentCookie('dana@example.com'));
});
after(() => app.server.close());

test('15 wrong codes in an hour lock sign-in for that email, and an unknown email answers exactly the same', async () => {
  resetRateLimits();
  const real = [], fake = [];
  for (let i = 0; i < LOCK_WRONG_CODES; i++) {
    real.push((await req('POST', '/portal/api/verify', { email: 'dana@example.com', code: '000001' })).status);
    fake.push((await req('POST', '/portal/api/verify', { email: 'nobody-here@example.com', code: '000001' })).status);
    if (i % 5 === 4) resetRateLimits();              // the per-network limit (20 in 15 minutes) isn't what's being tested
  }
  assert.ok(real.every((s) => s === 401) && fake.every((s) => s === 401), `${real} / ${fake}`);
  // Now even the right code is refused for Dana's email, and the unknown email gets the same answer.
  const { body } = await req('POST', '/portal/api/login', { email: 'dana@example.com' });
  const locked = await req('POST', '/portal/api/verify', { email: 'dana@example.com', code: body.dev_code ?? '123456' });
  const lockedFake = await req('POST', '/portal/api/verify', { email: 'nobody-here@example.com', code: '123456' });
  assert.equal(locked.status, 429);
  assert.equal(lockedFake.status, 429);
  assert.equal(locked.body.error.message.replace(/\d+ minutes?/, 'N'), lockedFake.body.error.message.replace(/\d+ minutes?/, 'N'));
  assert.match(locked.body.error.message, /Too many wrong tries/);
  resetRateLimits(); resetSignInLocks();
  assert.equal((await dana('GET', '/portal/api/me')).status, 200, 'already signed-in devices are not affected');
});

test('signed-in devices: listed with the browser, and "sign out everywhere else" keeps this one', async () => {
  resetRateLimits();
  const laptop = as(await parentCookie('maria@example.com', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'));
  const list = (await laptop('GET', '/portal/api/devices')).body.data;
  assert.ok(list.length >= 2);
  assert.equal(list.filter((d) => d.current).length, 1);
  assert.ok(list.some((d) => d.device === 'Chrome on Mac' && d.current));
  assert.ok(list.some((d) => d.device === 'Safari on iPhone' && !d.current));
  assert.ok(list.every((d) => !('token_hash' in d) && d.id.length === 16));
  const out = (await laptop('POST', '/portal/api/devices/sign-out-others')).body;
  assert.ok(out.signed_out >= 1);
  assert.equal((await maria('GET', '/portal/api/me')).status, 401, 'the phone is signed out');
  assert.equal((await laptop('GET', '/portal/api/me')).status, 200);
  assert.equal((await dana('GET', '/portal/api/me')).status, 200, 'other families are untouched');
  maria = laptop;
});

test('session rows on Home: coach, address with directions, how it is paid, the late-cancel time and waitlist place', async () => {
  const s = session('Speed & Agility', 48, { coachId: riley.id, capacity: 1 });
  db().run('UPDATE clients SET id = id WHERE id = ?', ava.id);
  assert.equal((await owner('POST', `/v1/sessions/${s}/bookings`, { client_id: cole.id })).status, 201);
  const b = await maria('POST', '/portal/api/bookings', { session_id: s, athlete_id: ava.id, pay: 'card_on_file' });
  assert.equal(b.body.status, 'waitlisted');
  await maria('POST', '/portal/api/bookings', { session_id: session('Power', 72), athlete_id: ava.id, pay: 'card_on_file' });   // no coach: Riley's private hours 3 days out must stay clear whatever the time of day
  const me = (await maria('GET', '/portal/api/me')).body;
  const rows = me.athletes.find((a) => a.id === ava.id).upcoming;
  const wait = rows.find((r) => r.session_id === s), paid = rows.find((r) => r.session_name === 'Power');
  assert.equal(wait.waitlist_place, 1);
  assert.equal(wait.how_paid, 'waitlist');
  assert.equal(wait.coach_name, 'Riley Brooks');
  assert.equal(wait.address, '1 Main, Austin, TX, 78701');
  assert.match(wait.directions_url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.equal(paid.how_paid, 'paid');
  assert.equal(paid.paid_cents, 2500);
  assert.equal(paid.can_cancel, true);
  assert.equal(Date.parse(paid.starts_at) - Date.parse(paid.late_from), 12 * HOUR);
  // Details of one booking: the family's own only.
  assert.equal((await maria('GET', `/portal/api/bookings/${paid.id}`)).body.session_name, 'Power');
  assert.equal((await dana('GET', `/portal/api/bookings/${paid.id}`)).status, 404);
  assert.equal((await dana('POST', `/portal/api/bookings/${paid.id}/cancel`)).status, 404);
});

test('the calendar feed: private, shows first names and places only, and a reset or turning it off kills the old link', async () => {
  assert.equal((await maria('GET', '/portal/api/calendar')).body.on, false);
  const made = (await maria('POST', '/portal/api/calendar')).body;
  assert.match(made.url, /\/cal\/[\w-]{32}\.ics$/);
  assert.match(made.webcal, /^webcal:/);
  const path = new URL(made.url).pathname;
  const feed = await req('GET', path);
  assert.equal(feed.status, 200);
  assert.match(feed.res.headers.get('content-type'), /^text\/calendar/);
  assert.match(feed.text, /BEGIN:VCALENDAR/);
  assert.match(feed.text, /SUMMARY:Ava: Power/);
  assert.match(feed.text, /SUMMARY:Ava: Speed & Agility \(waitlist\)/);
  assert.match(feed.text, /LOCATION:Facility\\, 1 Main\\, Austin\\, TX\\, 78701/);
  for (const secret of ['Lopez', 'AVALOP', 'maria@example.com', 'Peanut', '5125550101']) assert.ok(!feed.text.includes(secret), `the feed has no ${secret}`);
  assert.ok(feed.text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'long lines are folded');
  // Another family's sessions never show.
  await dana('POST', '/portal/api/bookings', { session_id: session('Cole only', 96), athlete_id: cole.id, pay: 'card_on_file' });
  assert.ok(!(await req('GET', path)).text.includes('Cole'));
  assert.ok(!(await maria('GET', '/portal/api/calendar')).body.url, 'the address is shown once, never again');
  const reset = (await maria('POST', '/portal/api/calendar')).body;
  assert.equal((await req('GET', path)).status, 404, 'the old link stops working');
  assert.equal((await req('GET', new URL(reset.url).pathname)).status, 200);
  await maria('DELETE', '/portal/api/calendar');
  assert.equal((await req('GET', new URL(reset.url).pathname)).status, 404);
  assert.equal((await req('GET', '/cal/short.ics')).status, 404);
});

test('an expired or expiring card shows on the to-finish list', async () => {
  const month = new Date().toISOString().slice(0, 7);
  db().run('UPDATE families SET card_exp = ? WHERE id = ?', month, ava.family.id);
  let me = (await maria('GET', '/portal/api/me')).body;
  assert.equal(me.family.card.expiring, true);
  assert.ok(me.to_finish.some((x) => x.key === 'card_expiring'));
  db().run(`UPDATE families SET card_exp = '2020-01' WHERE id = ?`, ava.family.id);
  me = (await maria('GET', '/portal/api/me')).body;
  assert.equal(me.family.card.expired, true);
  assert.ok(me.to_finish.some((x) => x.key === 'card_expired'));
  assert.ok(me.to_finish.some((x) => x.key === 'emergency' && x.athlete_id === ben.id), 'Ben has no emergency contact');
  db().run('UPDATE families SET card_exp = NULL WHERE id = ?', ava.family.id);
});

test('families can\'t book an athlete into two sessions at once (a waitlist spot counts); staff can, with a warning', async () => {
  const a = session('Early class', 120, { dropIn: 2000 }), b = session('Overlapping class', 120.5, { dropIn: 2000 });
  assert.equal((await maria('POST', '/portal/api/bookings', { session_id: a, athlete_id: ben.id, pay: 'card_on_file' })).status, 200);
  const sales = db().get('SELECT COUNT(*) AS n FROM sales').n;
  const clash = await maria('POST', '/portal/api/bookings', { session_id: b, athlete_id: ben.id, pay: 'card_on_file' });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error.message, /Ben is already booked for Early class .*overlaps/);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM sales').n, sales, 'nothing charged');
  const row = (await maria('GET', '/portal/api/schedule')).body.data.find((s) => s.id === b);
  assert.match(row.athletes.find((x) => x.id === ben.id).clash, /overlaps/);
  const staff = await owner('POST', `/v1/sessions/${b}/bookings`, { client_id: ben.id });
  assert.equal(staff.status, 201);
  assert.equal(staff.body.clash.name, 'Early class');
  // A waitlist spot blocks too.
  const full = session('Full class', 140, { capacity: 0 }), other = session('Same time', 140.25);
  assert.equal((await maria('POST', '/portal/api/bookings', { session_id: full, athlete_id: ava.id })).body.status, 'waitlisted');
  assert.match((await maria('POST', '/portal/api/bookings', { session_id: other, athlete_id: ava.id, pay: 'card_on_file' })).body.error.message, /on the waitlist for Full class/);
});

test('privates: each time has its coach, a note goes to the coach, and cancelling reopens the time and returns the credit exactly once', async () => {
  const today = localDate(new Date().toISOString(), TZ), day = addDaysToDate(today, 3);
  // The earlier tests put classes at this clock time 2 to 4 days out, and a session at the place blocks private hours,
  // so the hours go on the other half of the day from now.
  const hourNow = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const [startT, endT] = hourNow < 12 ? ['15:00', '17:00'] : ['03:00', '05:00'];
  await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: weekdayOf(day), start_time: startT, end_time: endT, slot_minutes: 60, coach_id: riley.id, price_cents: 8000 });
  await owner('POST', `/v1/clients/${ben.id}/credits`, { delta: 1, credit_type: 'private', note: 'Pack' });
  const slots = (await maria('GET', '/portal/api/slots?kind=private')).body;
  assert.ok(slots.coaches.some((c) => c.name === 'Riley Brooks'));
  const pick = slots.data.find((x) => localDate(x.starts_at, TZ) === day);
  assert.equal(pick.coach_name, 'Riley Brooks');
  assert.ok((await maria('GET', `/portal/api/slots?kind=private&coach_id=${riley.id}&days=60`)).body.data.every((x) => x.coach_id === riley.id));
  const booked = await maria('POST', '/portal/api/slots/book', { kind: 'private', starts_at: pick.starts_at, availability_id: pick.availability_id, athlete_id: ben.id, note: 'Working on his first step' });
  assert.equal(booked.status, 200);
  assert.equal(booked.body.coverage, 'credit');
  assert.equal(booked.body.note, 'Working on his first step');
  const toCoach = outbox().find((m) => m.to_addr === 'riley@test.dev' || m.to === 'riley@test.dev' || JSON.stringify(m).includes('riley@test.dev'));
  assert.ok(toCoach && toCoach.body.includes('Working on his first step'), 'the coach is emailed the note');
  assert.ok(!(await maria('GET', '/portal/api/slots?kind=private')).body.data.some((x) => x.starts_at === pick.starts_at), 'the time is taken');
  const row = (await maria('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ben.id).upcoming.find((u) => u.id === booked.body.id);
  assert.equal(row.session_name, 'Private session', 'no athlete name in the session name');
  assert.equal(row.note, 'Working on his first step');
  const credits = () => db().get(`SELECT COALESCE(SUM(delta), 0) AS n FROM session_credits WHERE client_id = ? AND credit_type = 'private'`, ben.id).n;
  assert.equal(credits(), 0);
  const [one, two] = await Promise.all([maria('POST', `/portal/api/bookings/${booked.body.id}/cancel`), maria('POST', `/portal/api/bookings/${booked.body.id}/cancel`)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(credits(), 1, 'the credit comes back once');
  assert.ok((await maria('GET', '/portal/api/slots?kind=private')).body.data.some((x) => x.starts_at === pick.starts_at), 'the time is open again');
  assert.ok(outbox().some((m) => m.subject.startsWith('Canceled: Private') && JSON.stringify(m).includes('riley@test.dev')), 'the coach is told');
  // A paid private (no credits left) is refunded once when cancelled.
  const paid = await maria('POST', '/portal/api/slots/book', { kind: 'private', starts_at: pick.starts_at, availability_id: pick.availability_id, athlete_id: ben.id });
  assert.equal(paid.body.coverage, 'credit', 'the returned credit books the time again');
  const again = (await maria('GET', '/portal/api/slots?kind=private')).body.data.find((x) => x.starts_at !== pick.starts_at && x.coach_id === riley.id);
  const cash = await maria('POST', '/portal/api/slots/book', { kind: 'private', starts_at: again.starts_at, availability_id: again.availability_id, athlete_id: ava.id, pay: 'card_on_file' });
  assert.equal(cash.body.coverage, 'paid');
  await Promise.all([maria('POST', `/portal/api/bookings/${cash.body.id}/cancel`), maria('POST', `/portal/api/bookings/${cash.body.id}/cancel`)]);
  const sale = db().get('SELECT status, refunded_cents, amount_cents FROM sales WHERE id = ?', cash.body.sale_id);
  assert.equal(sale.status, 'refunded');
  assert.equal(sale.refunded_cents, sale.amount_cents);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM sale_refunds WHERE sale_id = ?', cash.body.sale_id).n, 1, 'refunded exactly once');
  assert.equal((await dana('POST', '/portal/api/slots/book', { kind: 'private', starts_at: again.starts_at, availability_id: again.availability_id, athlete_id: ava.id })).status, 404, 'another family can\'t book for Ava');
});

test('camps: a full camp is refused before any charge, and a camp registration is cancelled by the coach', async () => {
  const today = localDate(new Date().toISOString(), TZ);
  const camp = (await owner('POST', '/v1/class-series', { name: 'Speed Camp', kind: 'camp', location_id: facility.id, weekdays: [0, 1, 2, 3, 4, 5, 6], start_time: '06:00', duration_min: 60, capacity: 1, registration_cents: 20000, start_date: addDaysToDate(today, 20), end_date: addDaysToDate(today, 22) })).body;
  let progs = (await maria('GET', '/portal/api/programs')).body.data;
  let c = progs.find((p) => p.id === camp.id);
  assert.equal(c.spots_left, 1);
  assert.equal(c.registration_open, true);
  assert.ok(c.closes_at);
  assert.equal((await dana('POST', `/portal/api/programs/${camp.id}/enroll`, { athlete_id: cole.id })).status, 200);
  const sales = db().get('SELECT COUNT(*) AS n FROM sales').n;
  const full = await maria('POST', `/portal/api/programs/${camp.id}/enroll`, { athlete_id: ava.id });
  assert.equal(full.status, 409);
  assert.match(full.body.error.message, /full/);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM sales').n, sales, 'nothing charged');
  progs = (await dana('GET', '/portal/api/programs')).body.data;
  c = progs.find((p) => p.id === camp.id);
  assert.deepEqual(c.registered, [cole.id]);
  assert.deepEqual((await maria('GET', '/portal/api/programs')).body.data.find((p) => p.id === camp.id).registered, [], 'another family\'s registrations are not shown');
  const reg = (await dana('GET', '/portal/api/me')).body.athletes[0].upcoming.find((u) => u.camp_registration);
  assert.equal(reg.can_cancel, false);
  assert.match((await dana('POST', `/portal/api/bookings/${reg.id}/cancel`)).body.error.message, /message your coach/);
});

test('archived athletes are hidden from the family', async () => {
  const kid = (await owner('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Cam Lopez', birth_date: born(8) })).body;
  assert.ok((await maria('GET', '/portal/api/me')).body.athletes.some((a) => a.id === kid.id));
  await owner('POST', `/v1/clients/${kid.id}/archive`, { confirm: true });
  assert.ok(!(await maria('GET', '/portal/api/me')).body.athletes.some((a) => a.id === kid.id));
  assert.equal((await maria('GET', `/portal/api/athletes/${kid.id}/report`)).status, 404);
  assert.equal((await maria('PATCH', `/portal/api/athletes/${kid.id}`, { sport: 'Golf' })).status, 404);
});
