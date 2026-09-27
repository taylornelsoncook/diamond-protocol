// Coaches on classes, single sessions (subs) and private/evaluation hours; open times that follow the coach across
// places; days off; and the Book now page, all through the API with each role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDaysToDate, localDate, zonedToUtc, weekdayOf } from '../src/util.js';
import { bookSlot, openSlots } from '../src/services/schedule.js';
import { publicSchedule } from '../src/services/booknow.js';

let app, base, owner, coach, desk, ownerId, coachId, deskId, otherCoachId, facility, park, ava, cole, mia;
const TZ = 'America/Chicago';

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const day = (n) => addDaysToDate(localDate(new Date().toISOString(), TZ), n);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  ownerId = createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' }).id;
  coachId = createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' }).id;
  otherCoachId = createUser(app.ctx, { email: 'riley@test.dev', name: 'Riley Brooks', password: 'riley-password-1', role: 'coach' }).id;
  deskId = createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' }).id;
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  coach = await signIn('coach@test.dev', 'coach-password-1');
  desk = await signIn('desk@test.dev', 'desk-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  park = (await owner('POST', '/v1/locations', { name: 'Zilker Park', kind: 'park' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2013-03-10', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  cole = (await owner('POST', '/v1/clients', { name: 'Cole Park', birth_date: '2011-09-22', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  mia = (await owner('POST', '/v1/clients', { name: 'Mia Nguyen', birth_date: '2010-01-15', parent: { name: 'Tran Nguyen', email: 'tran@example.com' } })).body;
});
after(() => app.server.close());

test('the coach picker lists active owners and coaches, never front desk or turned-off accounts', async () => {
  const names = (await desk('GET', '/v1/coaches')).body.data.map((c) => c.name);
  assert.deepEqual(names, ['Carl Coach', 'Olivia Owner', 'Riley Brooks']);
  const bad = await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: 1, start_time: '10:00', end_time: '11:00', coach_id: deskId });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /front desk/);
  assert.equal((await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: 1, start_time: '10:00', end_time: '11:00', coach_id: 'usr_nope' })).status, 404);
});

test('a class\'s coach leads every session; a sub on one session sticks when the class changes hands', async () => {
  const start = day(1);
  const s = (await coach('POST', '/v1/class-series', { name: 'Speed', kind: 'group', location_id: facility.id, weekdays: [weekdayOf(start), weekdayOf(day(2))], start_time: '17:00', duration_min: 60, capacity: 10, start_date: start, coach_id: coachId })).body;
  assert.equal(s.coach_name, 'Carl Coach');
  const sessions = (await owner('GET', `/v1/schedule?to=${zonedToUtc(day(15), '00:00', TZ)}`)).body.data.filter((x) => x.series_id === s.id);
  assert.ok(sessions.length >= 2);
  assert.ok(sessions.every((x) => x.coach_id === coachId && x.coach_name === 'Carl Coach'));
  // Riley subs the first one. Front desk can't change who leads.
  assert.equal((await desk('PATCH', `/v1/sessions/${sessions[0].id}`, { coach_id: otherCoachId })).status, 403);
  const sub = (await coach('PATCH', `/v1/sessions/${sessions[0].id}`, { coach_id: otherCoachId })).body;
  assert.equal(sub.coach_name, 'Riley Brooks');
  assert.equal((await owner('PATCH', `/v1/sessions/${sessions[0].id}`, {})).status, 400);
  // The class goes to the owner: every session follows except the one Riley subs.
  await owner('PATCH', `/v1/class-series/${s.id}`, { coach_id: ownerId });
  const after = (await owner('GET', `/v1/schedule?to=${zonedToUtc(day(15), '00:00', TZ)}`)).body.data.filter((x) => x.series_id === s.id);
  assert.equal(after.find((x) => x.id === sessions[0].id).coach_id, otherCoachId);
  assert.ok(after.filter((x) => x.id !== sessions[0].id).every((x) => x.coach_id === ownerId));
  // Sessions made later (the schedule rolling forward) get the class's coach.
  assert.equal((await owner('GET', `/v1/class-series/${s.id}`)).body.coach_id, ownerId);
  // "My sessions": Riley's filter shows only the one sub; front desk sees coach names on the schedule.
  const riley = await signIn('riley@test.dev', 'riley-password-1');
  const mine = (await riley('GET', '/v1/schedule?coach_id=me')).body.data;
  assert.deepEqual(mine.map((x) => x.id), [sessions[0].id]);
  const deskView = (await desk('GET', '/v1/schedule')).body.data.find((x) => x.id === sessions[0].id);
  assert.equal(deskView.coach_name, 'Riley Brooks');
  const agenda = (await coach('GET', `/v1/agenda?date=${start}`)).body.sessions.find((x) => x.id === sessions[0].id);
  assert.equal(agenda.coach_name, 'Riley Brooks');
  // Clearing the coach leaves nobody set.
  assert.equal((await owner('PATCH', `/v1/sessions/${sessions[0].id}`, { coach_id: null })).body.coach_id, null);
});

test('a coach\'s hours are blocked by anything that coach leads at any place, and by sessions with no coach at the same place', async () => {
  const d = day(4), wd = weekdayOf(d);
  const av = (await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: wd, start_time: '06:00', end_time: '10:00', slot_minutes: 60, coach_id: coachId })).body;
  const open = () => openSlots(app.ctx, { kind: 'private', days: 6 }).filter((x) => x.availability_id === av.id && localDate(x.starts_at, TZ) === d).map((x) => x.starts_at);
  const at = (t) => zonedToUtc(d, t, TZ);
  assert.deepEqual(open(), [at('06:00'), at('07:00'), at('08:00'), at('09:00')]);
  assert.equal(openSlots(app.ctx, { kind: 'private', days: 6 }).find((x) => x.availability_id === av.id).coach_name, 'Carl Coach');
  // Carl leads a team session across town at 6: his facility hour at 6 is gone.
  await owner('POST', '/v1/sessions', { name: 'Away team', kind: 'team', location_id: park.id, date: d, start_time: '06:00', duration_min: 60, coach_id: coachId });
  // Riley leads a class at the facility at 7: that's Riley's, not Carl's, so Carl's 7 o'clock stays open.
  await owner('POST', '/v1/sessions', { name: 'Riley group', kind: 'group', location_id: facility.id, date: d, start_time: '07:00', duration_min: 60, coach_id: otherCoachId });
  // A clinic at the facility with no coach at 8 blocks everyone's hours there.
  await owner('POST', '/v1/sessions', { name: 'Open clinic', kind: 'clinic', location_id: facility.id, date: d, start_time: '08:00', duration_min: 60 });
  // A session with no coach somewhere else doesn't touch the facility.
  await owner('POST', '/v1/sessions', { name: 'Park free play', kind: 'group', location_id: park.id, date: d, start_time: '09:00', duration_min: 60 });
  assert.deepEqual(open(), [at('07:00'), at('09:00')]);

  // Hours with no coach keep the place rule: anything at the facility blocks them, whoever leads it.
  const shared = (await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: wd, start_time: '06:00', end_time: '10:00', slot_minutes: 60 })).body;
  const sharedOpen = openSlots(app.ctx, { kind: 'private', days: 6 }).filter((x) => x.availability_id === shared.id && localDate(x.starts_at, TZ) === d).map((x) => x.starts_at);
  assert.deepEqual(sharedOpen, [at('06:00'), at('09:00')]);

  // A private booked from Carl's hours is Carl's, so it also blocks his hours at another place at the same time.
  // (The park's free play at 9 has no coach, so it blocks hours at the park: use a third place.)
  const gym = (await owner('POST', '/v1/locations', { name: 'Westlake gym', kind: 'other' })).body;
  const parkHours = (await owner('POST', '/v1/availability', { kind: 'private', location_id: gym.id, weekday: wd, start_time: '09:00', end_time: '10:00', slot_minutes: 60, coach_id: coachId })).body;
  assert.ok(openSlots(app.ctx, { kind: 'private', days: 6 }).some((x) => x.availability_id === parkHours.id && x.starts_at === at('09:00')));
  const b = (await desk('POST', '/v1/slots/book', { kind: 'private', starts_at: at('09:00'), availability_id: av.id, client_id: ava.id })).body;
  assert.equal(b.status, 'booked');
  assert.equal(app.ctx.db.get('SELECT coach_id FROM class_sessions WHERE id = ?', b.session_id).coach_id, coachId);
  assert.ok(!openSlots(app.ctx, { kind: 'private', days: 6 }).some((x) => x.availability_id === parkHours.id && x.starts_at === at('09:00')));
  // Handing the park hours to Riley frees them (Riley is free at 9).
  assert.equal((await coach('PATCH', `/v1/availability/${parkHours.id}`, { coach_id: otherCoachId })).body.coach_name, 'Riley Brooks');
  assert.ok(openSlots(app.ctx, { kind: 'private', days: 6 }).some((x) => x.availability_id === parkHours.id && x.starts_at === at('09:00')));
  assert.equal((await desk('PATCH', `/v1/availability/${parkHours.id}`, { coach_id: coachId })).status, 403);
});

test('two families booking the same coach at the same time, even at different places: only one gets it', async () => {
  const d = day(5), wd = weekdayOf(d), at = zonedToUtc(d, '19:00', TZ);
  const here = (await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: wd, start_time: '19:00', end_time: '20:00', coach_id: otherCoachId })).body;
  const there = (await owner('POST', '/v1/availability', { kind: 'private', location_id: park.id, weekday: wd, start_time: '19:00', end_time: '20:00', coach_id: otherCoachId })).body;
  // The second request arrives while the first is still charging the card (before its booking is saved).
  const results = await Promise.allSettled([[cole, here], [mia, there]].map(([c, a]) => bookSlot(app.ctx, { kind: 'private', startsAt: at, availabilityId: a.id, clientId: c.id, isCoach: true })));
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM class_sessions WHERE starts_at = ? AND coach_id = ? AND status = 'scheduled'`, at, otherCoachId).n, 1);
  // The same hour twice at one place still only goes once (the guarantee from before coaches existed).
  const again = await Promise.allSettled([cole, mia].map((c) => bookSlot(app.ctx, { kind: 'private', startsAt: at, availabilityId: here.id, clientId: c.id, isCoach: true })));
  assert.ok(again.every((r) => r.status === 'rejected'));
});

test('days off hide a coach\'s private and evaluation times (or everyone\'s, for the facility); coaches manage only their own', async () => {
  const d = day(8), wd = weekdayOf(d);
  const carl = (await owner('POST', '/v1/availability', { kind: 'evaluation', location_id: facility.id, weekday: wd, start_time: '12:00', end_time: '13:00', coach_id: coachId, price_cents: 5000 })).body;
  const riley = (await owner('POST', '/v1/availability', { kind: 'evaluation', location_id: park.id, weekday: wd, start_time: '12:00', end_time: '13:00', coach_id: otherCoachId, price_cents: 5000 })).body;
  const nobody = (await owner('POST', '/v1/availability', { kind: 'evaluation', location_id: park.id, weekday: wd, start_time: '14:00', end_time: '15:00', price_cents: 5000 })).body;
  const offered = () => new Set(openSlots(app.ctx, { kind: 'evaluation', days: 10 }).filter((x) => localDate(x.starts_at, TZ) === d).map((x) => x.availability_id));
  assert.deepEqual([...offered()].sort(), [carl.id, riley.id, nobody.id].sort());
  // Carl leads a clinic that day; adding his day off says it needs covering.
  const clinic = (await owner('POST', '/v1/sessions', { name: 'Hitting clinic', kind: 'clinic', location_id: park.id, date: d, start_time: '16:00', coach_id: coachId })).body;
  const off = await coach('POST', '/v1/time-off', { start_date: d, note: 'Wedding' });
  assert.equal(off.status, 201);
  assert.equal(off.body.user_id, coachId);
  assert.equal(off.body.coach_name, 'Carl Coach');
  assert.deepEqual(off.body.sessions_to_cover.map((x) => x.id), [clinic.id]);
  assert.deepEqual([...offered()].sort(), [riley.id, nobody.id].sort(), 'only Carl\'s times go');
  assert.equal(publicSchedule(app.ctx).evaluations.filter((x) => localDate(x.starts_at, TZ) === d).length, 2, 'the Book now page follows');
  // Coaches can't add days off for someone else or the whole facility, or remove someone else's; front desk can only look.
  assert.equal((await coach('POST', '/v1/time-off', { start_date: d, user_id: otherCoachId })).status, 403);
  assert.equal((await coach('POST', '/v1/time-off', { start_date: d, user_id: null })).status, 403);
  assert.equal((await desk('POST', '/v1/time-off', { start_date: d })).status, 403);
  assert.equal((await desk('GET', '/v1/time-off')).body.data.length, 1);
  assert.equal((await coach('POST', '/v1/time-off', { start_date: d, end_date: day(7) })).status, 400);
  assert.equal((await coach('POST', '/v1/time-off', { start_date: 'next week' })).status, 400);
  // The facility closes: every time that day goes, coach or not.
  const closed = (await owner('POST', '/v1/time-off', { start_date: d, end_date: d, user_id: null, note: 'Holiday' })).body;
  assert.equal(closed.user_id, null);
  assert.equal(offered().size, 0);
  const riley2 = await signIn('riley@test.dev', 'riley-password-1');
  assert.equal((await riley2('DELETE', `/v1/time-off/${closed.id}`)).status, 403);
  assert.equal((await owner('DELETE', `/v1/time-off/${closed.id}`)).status, 200);
  assert.equal((await coach('DELETE', `/v1/time-off/${off.body.id}`)).status, 200);
  assert.equal(offered().size, 3);
  // A turned-off coach's hours aren't offered at all.
  await owner('PATCH', `/v1/staff/${otherCoachId}`, { active: false });
  assert.ok(!offered().has(riley.id));
  assert.equal((await owner('GET', '/v1/availability')).body.data.find((a) => a.id === riley.id).coach_active, false);
  assert.equal((await owner('POST', '/v1/sessions', { name: 'x', kind: 'group', location_id: park.id, date: d, start_time: '18:00', coach_id: otherCoachId })).status, 409);
  await owner('PATCH', `/v1/staff/${otherCoachId}`, { active: true });
});

test('coach assignment responses keep amounts away from coaches and front desk', async () => {
  const moneyKeys = (o, out = []) => { if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { if (/_cents$/.test(k) && x != null) out.push(k); moneyKeys(x, out); } return out; };
  const d = day(10);
  const s = (await owner('POST', '/v1/sessions', { name: 'Paid clinic', kind: 'clinic', location_id: facility.id, date: d, start_time: '10:00', drop_in_cents: 4000 })).body;
  const av = (await owner('POST', '/v1/availability', { kind: 'evaluation', location_id: facility.id, weekday: weekdayOf(d), start_time: '13:00', end_time: '14:00', price_cents: 6000 })).body;
  const series = (await owner('POST', '/v1/class-series', { name: 'Paid class', kind: 'group', location_id: facility.id, weekdays: [weekdayOf(d)], start_time: '19:00', duration_min: 60, capacity: 8, drop_in_cents: 2500, start_date: d })).body;
  for (const [who, name] of [[coach, 'coach']]) {
    assert.deepEqual(moneyKeys((await who('PATCH', `/v1/sessions/${s.id}`, { coach_id: coachId })).body), [], name);
    assert.deepEqual(moneyKeys((await who('PATCH', `/v1/availability/${av.id}`, { coach_id: coachId })).body), [], name);
    assert.deepEqual(moneyKeys((await who('PATCH', `/v1/class-series/${series.id}`, { coach_id: coachId })).body), [], name);
    assert.deepEqual(moneyKeys((await who('GET', '/v1/slots?kind=evaluation&days=12')).body), [], name);
  }
  assert.deepEqual(moneyKeys((await desk('GET', '/v1/availability')).body), []);
  assert.deepEqual(moneyKeys((await desk('GET', '/v1/coaches')).body), []);
  assert.equal((await owner('PATCH', `/v1/availability/${av.id}`, { coach_id: null })).body.price_cents, 6000);
});

test('Book now shows a time once when two coaches are free then; a coach moved to front desk stops being offered', async () => {
  const d = day(12), wd = weekdayOf(d);
  const a1 = (await owner('POST', '/v1/availability', { kind: 'evaluation', location_id: park.id, weekday: wd, start_time: '07:00', end_time: '08:00', coach_id: coachId })).body;
  const a2 = (await owner('POST', '/v1/availability', { kind: 'evaluation', location_id: park.id, weekday: wd, start_time: '07:00', end_time: '08:00', coach_id: otherCoachId })).body;
  const at = zonedToUtc(d, '07:00', TZ);
  assert.equal(openSlots(app.ctx, { kind: 'evaluation', days: 13 }).filter((x) => x.starts_at === at).length, 2, 'the portal offers both coaches');
  const evs = publicSchedule(app.ctx).evaluations;
  assert.ok(evs.some((x) => x.starts_at === at) || evs.length === 12, 'the time is on the Book now page (unless earlier times filled it)');
  assert.equal(new Set(evs.map((x) => `${x.starts_at} ${x.location_name}`)).size, evs.length, 'each time shows once');
  await owner('PATCH', `/v1/staff/${otherCoachId}`, { role: 'front_desk' });
  try {
    assert.ok(!openSlots(app.ctx, { kind: 'evaluation', days: 13 }).some((x) => x.availability_id === a2.id));
    assert.equal((await owner('GET', '/v1/availability')).body.data.find((a) => a.id === a2.id).coach_active, false);
  } finally { await owner('PATCH', `/v1/staff/${otherCoachId}`, { role: 'coach' }); }
  for (const a of [a1, a2]) await owner('DELETE', `/v1/availability/${a.id}`);
});
