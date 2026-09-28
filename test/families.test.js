import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { localDate, addDaysToDate, weekdayOf } from '../src/util.js';

const TZ = 'America/Chicago';
let app, base, coachCookie;
const req = async (method, path, body, headers = {}) => {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), res };
};
const coach = (m, p, b) => req(m, p, b, { cookie: coachCookie });
let parentCookie;
const parent = (m, p, b) => req(m, p, b, { cookie: parentCookie });
const localHour = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

let facility, ava, ben, family, groupPack, privatePack, plan, speed;

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const login = await req('POST', '/auth/login', { email: 'coach@test.dev', password: 'correct-horse-battery' });
  coachCookie = login.res.headers.get('set-cookie').split(';')[0];
  await coach('PATCH', '/v1/settings', { timezone: TZ, late_cancel_hours: 12 });
  facility = (await coach('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  groupPack = (await coach('POST', '/v1/products', { name: '10 group classes', kind: 'pack', sessions: 10, price_cents: 20000, credit_type: 'group' })).body;
  privatePack = (await coach('POST', '/v1/products', { name: '5 privates', kind: 'pack', sessions: 5, price_cents: 40000, credit_type: 'private' })).body;
  plan = (await coach('POST', '/v1/plans', { name: 'Group membership', price_cents: 15000, trial_days: 0 })).body;
});
after(() => app.server.close());

test('coach adds an athlete with a parent: family created, athlete needs no email', async () => {
  const r = await coach('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2012-03-10', sport: 'Soccer', parent: { name: 'Maria Lopez', email: 'maria@example.com', phone: '555-0100' } });
  assert.equal(r.status, 201);
  ava = r.body;
  assert.equal(ava.email, null);
  assert.equal(ava.family.name, 'Lopez family');
  assert.equal(ava.family.guardians[0].email, 'maria@example.com');
  family = ava.family;
  ben = (await coach('POST', `/v1/families/${family.id}/athletes`, { name: 'Ben Lopez', birth_date: '2016-06-01' })).body;
  assert.equal(ben.family.siblings[0].name, 'Ava Lopez');
  assert.equal((await coach('POST', '/v1/clients', { name: 'Adult without email' })).status, 400, 'adults paying for themselves still need an email');
  assert.equal((await coach('POST', '/v1/clients', { name: 'Dup parent', parent: { name: 'X', email: 'maria@example.com' } })).status, 409);
});

test('recurring classes are generated at the right local time', async () => {
  const today = localDate(new Date().toISOString(), TZ);
  speed = (await coach('POST', '/v1/class-series', { name: 'Speed & Agility', kind: 'group', location_id: facility.id, weekdays: [0, 1, 2, 3, 4, 5, 6], start_time: '17:30', duration_min: 60, capacity: 2, age_min: 11, age_max: 15, drop_in_cents: 2500, start_date: addDaysToDate(today, 1) })).body;
  assert.ok(speed.upcoming_sessions >= 50, `generated ${speed.upcoming_sessions}`);
  const sched = (await coach('GET', `/v1/schedule?to=${encodeURIComponent(new Date(Date.now() + 5 * 86400000).toISOString())}`)).body.data;
  assert.ok(sched.length >= 3);
  for (const s of sched) assert.equal(localHour(s.starts_at), '17:30', 'every session starts 5:30 pm local, across daylight saving');
});

test('parents sign in with an emailed code', async () => {
  const unknown = await req('POST', '/portal/api/login', { email: 'nobody@example.com' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.dev_code, undefined, 'no hint whether an account exists');
  const r = await req('POST', '/portal/api/login', { email: 'MARIA@example.com' });
  assert.match(r.body.dev_code, /^\d{6}$/);
  const outbox = (await coach('GET', '/v1/outbox')).body.data;
  assert.ok(outbox[0].subject.includes(r.body.dev_code));
  assert.equal((await req('POST', '/portal/api/verify', { email: 'maria@example.com', code: '000000' === r.body.dev_code ? '111111' : '000000' })).status, 401);
  const ok = await req('POST', '/portal/api/verify', { email: 'maria@example.com', code: r.body.dev_code });
  assert.equal(ok.status, 200);
  parentCookie = ok.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('POST', '/portal/api/verify', { email: 'maria@example.com', code: r.body.dev_code })).status, 401, 'codes work once');
  const me = (await parent('GET', '/portal/api/me')).body;
  assert.deepEqual(me.athletes.map((a) => a.first_name).sort(), ['Ava', 'Ben']);
  assert.equal((await req('GET', '/portal/api/me')).status, 401);
});

test('waiver must be signed before booking', async () => {
  const s = (await parent('GET', '/portal/api/schedule')).body.data[0];
  assert.match((await parent('POST', '/portal/api/bookings', { session_id: s.id, athlete_id: ava.id })).body.error.message, /waiver/);
  assert.equal((await parent('POST', '/portal/api/waiver', { signed_name: 'Someone Else', agree: true })).status, 400);
  const w = (await parent('POST', '/portal/api/waiver', { signed_name: 'maria lopez', agree: true })).body;
  assert.equal(w.signed, true);
  await coach('PATCH', '/v1/settings', { waiver_text: 'Updated waiver v2' });
  assert.equal((await parent('GET', '/portal/api/me')).body.family.waiver.signed, false, 'a changed waiver needs a new signature');
  await parent('POST', '/portal/api/waiver', { signed_name: 'Maria Lopez', agree: true });
});

let sessions;
test('booking pays with membership, group credits, or the family card', async () => {
  sessions = (await parent('GET', '/portal/api/schedule')).body.data;
  const s0 = sessions[0];
  assert.equal(s0.athletes.find((a) => a.id === ben.id).eligible, false, 'Ben is too young for 11–15');
  assert.match((await parent('POST', '/portal/api/bookings', { session_id: s0.id, athlete_id: ben.id })).body.error.message, /Ben is \d+/);
  const noPay = await parent('POST', '/portal/api/bookings', { session_id: s0.id, athlete_id: ava.id });
  assert.equal(noPay.status, 402);
  assert.equal((await parent('POST', '/portal/api/card/test')).body.owner, 'family');
  const paid = (await parent('POST', '/portal/api/bookings', { session_id: s0.id, athlete_id: ava.id, pay: 'card_on_file' })).body;
  assert.equal(paid.coverage, 'paid');
  const pack = (await parent('POST', '/portal/api/purchase', { product_id: groupPack.id, athlete_id: ava.id })).body;
  assert.equal(pack.athlete.credits.group, 10);
  const withCredit = (await parent('POST', '/portal/api/bookings', { session_id: sessions[1].id, athlete_id: ava.id })).body;
  assert.equal(withCredit.coverage, 'credit');
  assert.equal((await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).credits.group, 9);
  assert.equal((await parent('POST', '/portal/api/bookings', { session_id: sessions[1].id, athlete_id: ava.id })).status, 409, 'no double booking');
});

let kid2, kid3;
test('full classes waitlist, and on-time cancels promote the next athlete', async () => {
  kid2 = (await coach('POST', '/v1/clients', { name: 'Cole Park', birth_date: '2011-01-01', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  kid3 = (await coach('POST', '/v1/clients', { name: 'Eli Stone', birth_date: '2011-05-05', parent: { name: 'Fay Stone', email: 'fay@example.com' } })).body;
  const s1 = sessions[1];
  const b2 = (await coach('POST', `/v1/sessions/${s1.id}/bookings`, { client_id: kid2.id })).body;
  assert.equal(b2.status, 'booked');
  assert.equal(b2.coverage, 'unpaid', 'coaches can book now and collect later');
  const b3 = (await coach('POST', `/v1/sessions/${s1.id}/bookings`, { client_id: kid3.id })).body;
  assert.equal(b3.status, 'waitlisted');
  const avaBooking = (await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).upcoming.find((u) => u.session_id === s1.id);
  const c = (await parent('POST', `/portal/api/bookings/${avaBooking.id}/cancel`)).body;
  assert.equal(c.status, 'canceled');
  assert.equal(c.late, false);
  assert.equal((await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).credits.group, 10, 'credit returned');
  const roster = (await coach('GET', `/v1/sessions/${s1.id}`)).body.roster;
  assert.equal(roster.find((r) => r.client_id === kid3.id).status, 'booked', 'waitlist promoted');
  assert.ok((await coach('GET', '/v1/outbox')).body.data.some((m) => m.to_email === 'fay@example.com' && m.subject.startsWith('A spot opened')));
});

test('late cancels keep the session used unless the coach waives it', async () => {
  const soon = new Date(Date.now() + 3 * 3600000);
  const date = localDate(soon.toISOString(), TZ);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(soon);
  const s = (await coach('POST', '/v1/sessions', { name: 'Pop-up clinic', kind: 'group', location_id: facility.id, date, start_time: time, capacity: 10 })).body;
  const b = (await parent('POST', '/portal/api/bookings', { session_id: s.id, athlete_id: ava.id })).body;
  assert.equal(b.coverage, 'credit');
  const late = (await parent('POST', `/portal/api/bookings/${b.id}/cancel`)).body;
  assert.equal(late.status, 'late_canceled');
  assert.equal((await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).credits.group, 9);
  const b2 = (await coach('POST', `/v1/sessions/${s.id}/bookings`, { client_id: ava.id })).body;
  const waived = (await coach('POST', `/v1/bookings/${b2.id}/cancel`, { waive: true })).body;
  assert.equal(waived.status, 'canceled');
  assert.equal((await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).credits.group, 9);
});

test('standing spots are for members and fill every future class', async () => {
  assert.equal((await parent('POST', `/portal/api/programs/${speed.id}/enroll`, { athlete_id: ava.id })).status, 409);
  const m = (await parent('POST', '/portal/api/membership', { plan_id: plan.id, athlete_id: ava.id })).body;
  assert.equal(m.membership.status, 'active', 'family card charged for the first month');
  await parent('POST', `/portal/api/programs/${speed.id}/enroll`, { athlete_id: ava.id });
  const me = (await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id);
  assert.ok(me.upcoming.length >= 15);
  assert.ok(me.enrollments.some((e) => e.series_id === speed.id));
  await parent('DELETE', `/portal/api/programs/${speed.id}/enroll/${ava.id}`);
  assert.ok((await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).upcoming.length < 5);
});

test('camps: one registration books every day and charges the family card', async () => {
  const today = localDate(new Date().toISOString(), TZ);
  const camp = (await coach('POST', '/v1/class-series', { name: 'Fall Speed Camp', kind: 'camp', location_id: facility.id, weekdays: [1, 2, 3, 4, 5], start_time: '09:00', duration_min: 180, capacity: 2, registration_cents: 25000, start_date: addDaysToDate(today, 7), end_date: addDaysToDate(today, 13) })).body;
  assert.equal(camp.upcoming_sessions, 5);
  const progs = (await parent('GET', '/portal/api/programs')).body.data;
  assert.ok(progs.some((p) => p.id === camp.id));
  const r = (await parent('POST', `/portal/api/programs/${camp.id}/enroll`, { athlete_id: ava.id })).body;
  assert.equal(r.enrolled.length, 1);
  const camps = (await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).upcoming.filter((u) => u.session_name === 'Fall Speed Camp');
  assert.equal(camps.length, 5);
  assert.equal((await parent('POST', `/portal/api/programs/${camp.id}/enroll`, { athlete_id: ava.id })).status, 409);
  const day = (await parent('GET', '/portal/api/schedule')).body.data.find((s) => s.series_id === camp.id);
  assert.equal(day.registration_only, true);
  assert.match((await parent('POST', '/portal/api/bookings', { session_id: day.id, athlete_id: ava.id })).body.error.message, /(whole|already)/);
  await coach('POST', `/v1/class-series/${camp.id}/register`, { client_id: kid2.id });
  assert.match((await coach('POST', `/v1/class-series/${camp.id}/register`, { client_id: kid3.id })).body.error.message, /full/);
});

test('private and evaluation slots come from your hours, minus anything booked', async () => {
  const today = localDate(new Date().toISOString(), TZ);
  const tomorrow = addDaysToDate(today, 1);
  await coach('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: weekdayOf(tomorrow), start_time: '15:00', end_time: '17:00', slot_minutes: 60 });
  await coach('POST', '/v1/availability', { kind: 'evaluation', location_id: facility.id, weekday: weekdayOf(tomorrow), start_time: '14:00', end_time: '15:00', slot_minutes: 60, price_cents: 7500 });
  let slots = (await parent('GET', '/portal/api/slots?kind=private')).body.data.filter((s) => localDate(s.starts_at, TZ) === tomorrow);
  assert.deepEqual(slots.map((s) => localHour(s.starts_at)), ['15:00', '16:00']);
  assert.equal((await parent('POST', '/portal/api/slots/book', { kind: 'private', starts_at: slots[0].starts_at, availability_id: slots[0].availability_id, athlete_id: ava.id })).status, 402, 'group credits can\'t pay for a private');
  await parent('POST', '/portal/api/purchase', { product_id: privatePack.id, athlete_id: ava.id });
  const b = (await parent('POST', '/portal/api/slots/book', { kind: 'private', starts_at: slots[0].starts_at, availability_id: slots[0].availability_id, athlete_id: ava.id })).body;
  assert.equal(b.coverage, 'credit');
  assert.equal(b.credit_type, 'private');
  slots = (await parent('GET', '/portal/api/slots?kind=private')).body.data.filter((s) => localDate(s.starts_at, TZ) === tomorrow);
  assert.deepEqual(slots.map((s) => localHour(s.starts_at)), ['16:00'], 'booked slot disappears');
  assert.equal((await parent('POST', '/portal/api/slots/book', { kind: 'private', starts_at: b.starts_at, availability_id: slots[0].availability_id, athlete_id: ava.id })).status, 409);
  const ev = (await parent('GET', '/portal/api/slots?kind=evaluation')).body.data.find((s) => localDate(s.starts_at, TZ) === tomorrow);
  const evb = (await parent('POST', '/portal/api/slots/book', { kind: 'evaluation', starts_at: ev.starts_at, availability_id: ev.availability_id, athlete_id: ava.id, pay: 'card_on_file' })).body;
  assert.equal(evb.coverage, 'paid');
});

test('roster check-in, collecting at the session, and canceling a class', async () => {
  const s1 = sessions[1];
  const roster = (await coach('GET', `/v1/sessions/${s1.id}`)).body.roster;
  const unpaid = roster.find((r) => r.coverage === 'unpaid');
  const paid = (await coach('POST', `/v1/bookings/${unpaid.id}/pay`, { method: 'cash' })).body;
  assert.equal(paid.booking.coverage, 'paid');
  assert.equal((await coach('POST', `/v1/bookings/${unpaid.id}/attendance`, { status: 'attended' })).body.status, 'attended');
  const s2 = sessions[2];
  const b = (await parent('POST', '/portal/api/bookings', { session_id: s2.id, athlete_id: ava.id })).body;
  const before = (await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).credits.group;
  await coach('POST', `/v1/sessions/${s2.id}/cancel`, { reason: 'Field is flooded.' });
  assert.equal((await coach('GET', `/v1/sessions/${s2.id}`)).body.status, 'canceled');
  const after = (await parent('GET', '/portal/api/me')).body.athletes.find((a) => a.id === ava.id).credits.group;
  assert.equal(after, before + (b.coverage === 'credit' ? 1 : 0));
  assert.ok((await coach('GET', '/v1/outbox')).body.data.some((m) => m.subject.startsWith('Canceled: Speed & Agility') && m.body.includes('flooded')));
});

test('parents only see their own family', async () => {
  assert.equal((await parent('PATCH', `/portal/api/athletes/${kid2.id}`, { sport: 'Hacked' })).status, 404);
  assert.equal((await parent('POST', '/portal/api/bookings', { session_id: sessions[3].id, athlete_id: kid2.id })).status, 404);
  const upd = (await parent('PATCH', `/portal/api/athletes/${ava.id}`, { emergency_name: 'Grandma Lopez', emergency_phone: '512-555-0199', medical_notes: 'Mild asthma, inhaler in bag' })).body;
  assert.equal(upd.emergency_name, 'Grandma Lopez');
  const other = (await req('GET', '/portal/api/me', null, { cookie: parentCookie, origin: 'https://evil.example' })).status;
  assert.equal(other, 200, 'reads are fine');
  assert.equal((await req('POST', '/portal/api/waiver', { signed_name: 'Maria Lopez', agree: true }, { cookie: parentCookie, origin: 'https://evil.example' })).status, 403);
});

test('agenda shows today\'s sessions with rosters', async () => {
  const a = (await coach('GET', '/v1/agenda')).body;
  assert.equal(a.timezone, TZ);
  assert.ok(Array.isArray(a.sessions));
});

test('Tap to Pay at the session marks the booking paid once the tap completes', async () => {
  const s = sessions[4];
  const b = (await coach('POST', `/v1/sessions/${s.id}/bookings`, { client_id: kid3.id })).body;
  assert.equal(b.coverage, 'unpaid');
  const out = (await coach('POST', `/v1/bookings/${b.id}/pay`, { method: 'tap_to_pay' })).body;
  assert.equal(out.sale.status, 'pending');
  assert.equal(out.booking.coverage, 'unpaid', 'not paid until the tap');
  await coach('POST', `/v1/sales/${out.sale.id}/simulate`, { outcome: 'approved' });
  const roster = (await coach('GET', `/v1/sessions/${s.id}`)).body.roster;
  assert.equal(roster.find((r) => r.id === b.id).coverage, 'paid');
});
