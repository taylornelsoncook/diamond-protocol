// Schedule batch B2: editing a class so every upcoming session follows (moved sessions email booked families once, dropped
// days canceled with credits back, spots never below bookings), one-off sessions with a staff note, editing one session,
// emailing a session's families, moving someone up over the spots, team cancel emails, "also booked then" warnings and
// hours on several days, all through the API with each role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDaysToDate, localDate, zonedToUtc, weekdayOf } from '../src/util.js';
import { extendSchedule } from '../src/services/schedule.js';

let app, base, owner, coach, desk, coachId, subId, facility, park, ava, cole, mia, noah;
const TZ = 'America/Chicago';

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const day = (n) => addDaysToDate(localDate(new Date().toISOString(), TZ), n);
const hm = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const mail = (to, like = '%') => app.ctx.db.all('SELECT subject, body FROM outbox WHERE to_email = ? AND subject LIKE ? ORDER BY rowid', to, like);
const credits = (clientId) => app.ctx.db.get('SELECT COALESCE(SUM(delta), 0) AS n FROM session_credits WHERE client_id = ?', clientId).n;
const giveCredits = (clientId, n) => app.ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, note, created_at) VALUES (?, ?, 'group', ?, 'purchase', 'test', ?)`, `cr_${Math.random().toString(36).slice(2)}`, clientId, n, new Date().toISOString());
const sessionsOf = async (seriesId) => (await owner('GET', `/v1/schedule?to=${zonedToUtc(day(70), '00:00', TZ)}`)).body.data.filter((x) => x.series_id === seriesId);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  coachId = createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' }).id;
  subId = createUser(app.ctx, { email: 'riley@test.dev', name: 'Riley Brooks', password: 'riley-password-1', role: 'coach' }).id;
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
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
  noah = (await owner('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Noah Lopez', birth_date: '2015-05-02' })).body;
  assert.equal(noah.family.id, ava.family.id);
});
after(() => app.server.close());

test('editing a class moves every upcoming session, emails each booked family once and cancels dropped days with credits back once', async () => {
  const keepDay = day(2), dropDay = day(3);
  const s = (await coach('POST', '/v1/class-series', { name: 'Speed', kind: 'group', location_id: facility.id, weekdays: [weekdayOf(keepDay), weekdayOf(dropDay)], start_time: '17:00', duration_min: 60, capacity: 4, start_date: day(1), coach_id: coachId })).body;
  let list = await sessionsOf(s.id);
  const kept = list.filter((x) => localDate(x.starts_at, TZ) !== dropDay && weekdayOf(localDate(x.starts_at, TZ)) === weekdayOf(keepDay));
  const dropped = list.filter((x) => weekdayOf(localDate(x.starts_at, TZ)) === weekdayOf(dropDay));
  assert.ok(kept.length >= 7 && dropped.length >= 7);
  // Ava and her brother Noah are booked on two kept sessions and one dropped one (credits); Cole on a dropped one.
  giveCredits(ava.id, 5); giveCredits(noah.id, 5); giveCredits(cole.id, 5);
  for (const x of [kept[0], kept[1], dropped[0]]) { await owner('POST', `/v1/sessions/${x.id}/bookings`, { client_id: ava.id }); await owner('POST', `/v1/sessions/${x.id}/bookings`, { client_id: noah.id }); }
  await owner('POST', `/v1/sessions/${dropped[0].id}/bookings`, { client_id: cole.id });
  assert.deepEqual([credits(ava.id), credits(noah.id), credits(cole.id)], [2, 2, 4]);
  // One session has a sub, another was moved to 16:00 on its own: both keep that.
  await owner('PATCH', `/v1/sessions/${kept[2].id}`, { coach_id: subId });
  await owner('PATCH', `/v1/sessions/${kept[3].id}`, { start_time: '16:00', notify: false });

  // Spots below what a session has booked are refused, and nothing changes.
  const tight = await coach('PATCH', `/v1/class-series/${s.id}`, { capacity: 1 });
  assert.equal(tight.status, 400);
  assert.match(tight.body.error.message, /2 athletes are booked on .*Set spots to 2 or more/);
  assert.equal((await owner('GET', `/v1/class-series/${s.id}`)).body.capacity, 4);
  // Coaches can't change a price they can't see; front desk can't edit classes at all.
  assert.equal((await coach('PATCH', `/v1/class-series/${s.id}`, { drop_in_cents: 100 })).status, 403);
  assert.equal((await desk('PATCH', `/v1/class-series/${s.id}`, { start_time: '18:00' })).status, 403);

  const edit = { start_time: '18:00', weekdays: [weekdayOf(keepDay)], capacity: 6, location_id: park.id };
  const [r1, r2] = await Promise.all([coach('PATCH', `/v1/class-series/${s.id}`, edit), coach('PATCH', `/v1/class-series/${s.id}`, edit)]);   // a double tap
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal(r1.body.changes.moved, kept.length, 'every kept session moved: a new time, or (the one moved on its own) a new place');
  assert.equal(r1.body.changes.canceled, dropped.length);
  assert.equal(r2.body.changes.canceled, 0, 'the second press finds nothing left to cancel');
  assert.equal(r2.body.changes.moved, 0);
  list = await sessionsOf(s.id);
  assert.ok(list.every((x) => weekdayOf(localDate(x.starts_at, TZ)) === weekdayOf(keepDay)), 'dropped days are off the schedule');
  const own = list.find((x) => x.id === kept[3].id);
  assert.equal(hm(own.starts_at), '16:00', 'a session moved on its own keeps its time');
  assert.equal(own.location_id, park.id, 'but still follows the new place');
  assert.ok(list.filter((x) => x.id !== kept[3].id).every((x) => hm(x.starts_at) === '18:00'), 'every other session is at 18:00 local, before and after daylight saving ends');
  assert.equal(list.find((x) => x.id === kept[2].id).coach_id, subId, 'the sub keeps the session');
  assert.ok(list.every((x) => x.capacity === 6));
  // Credits back once for the dropped day (a double tap doesn't return them twice); the kept bookings stay used.
  assert.deepEqual([credits(ava.id), credits(noah.id), credits(cole.id)], [3, 3, 5]);
  // The Lopez family gets one "New time" email for both children and both sessions, and one cancel email.
  const moved = mail('maria@example.com', 'New time%');
  assert.equal(moved.length, 1);
  assert.match(moved[0].body, /These sessions have moved/);
  assert.match(moved[0].body, /Ava and Noah are still booked/);
  const canceled = mail('maria@example.com', 'Canceled: Speed%');
  assert.equal(canceled.length, 1);
  assert.match(canceled[0].body, /Ava's session credit has been returned/);
  assert.match(canceled[0].body, /Noah's session credit has been returned/);
  assert.equal(mail('dana@example.com', 'Canceled: Speed%').length, 1);
  assert.equal(mail('dana@example.com', 'New time%').length, 0, 'Cole was only on a dropped day');
  // The schedule job never recreates a moved session's day or a dropped day.
  const count = list.length;
  await extendSchedule(app.ctx);
  assert.equal((await sessionsOf(s.id)).length, count);
});

test('changing a class time never moves a session into the past and adds no second session that day', async () => {
  const s = (await owner('POST', '/v1/class-series', { name: 'Early bird', kind: 'group', location_id: facility.id, weekdays: [weekdayOf(day(1))], start_time: '06:00', duration_min: 45, capacity: 8, start_date: day(1) })).body;
  const first = (await sessionsOf(s.id))[0];
  // Pretend the first session already happened: an edit to a later time doesn't touch it, nor add another that day.
  app.ctx.db.run('UPDATE class_sessions SET starts_at = ?, ends_at = ? WHERE id = ?', new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() - 900000).toISOString(), first.id);
  app.ctx.db.run('UPDATE class_sessions SET slot_date = ? WHERE id = ?', localDate(new Date().toISOString(), TZ), first.id);
  await owner('PATCH', `/v1/class-series/${s.id}`, { start_time: '23:30', duration_min: 60 });
  const today = localDate(new Date().toISOString(), TZ);
  const all = app.ctx.db.all('SELECT * FROM class_sessions WHERE series_id = ?', s.id);
  assert.equal(all.filter((x) => (x.slot_date ?? localDate(x.starts_at, TZ)) === today).length, 1, 'still one session for today');
  assert.ok(all.filter((x) => x.id !== first.id).every((x) => hm(x.starts_at) === '23:30' && Date.parse(x.ends_at) - Date.parse(x.starts_at) === 3600000));
  // Two sessions of a class can't end up at the same time.
  const [a, b] = (await sessionsOf(s.id));
  const clash = await owner('PATCH', `/v1/sessions/${b.id}`, { date: localDate(a.starts_at, TZ), start_time: hm(a.starts_at) });
  assert.equal(clash.status, 409);
});

test('one-off sessions carry a staff note; editing one session keeps only real changes, moves the waitlist up and emails booked families', async () => {
  assert.equal((await desk('POST', '/v1/sessions', { name: 'Makeup', kind: 'group', location_id: facility.id, date: day(4), start_time: '10:00' })).status, 403);
  const s = (await coach('POST', '/v1/sessions', { name: 'Makeup speed', kind: 'group', location_id: facility.id, date: day(4), start_time: '10:00', capacity: 1, staff_note: 'For the rained-out Tuesday group', coach_id: coachId })).body;
  assert.equal(s.staff_note, 'For the rained-out Tuesday group');
  giveCredits(mia.id, 2);
  const booked = (await desk('POST', `/v1/sessions/${s.id}/bookings`, { client_id: ava.id })).body;
  assert.equal(booked.status, 'booked');
  const wait = (await desk('POST', `/v1/sessions/${s.id}/bookings`, { client_id: mia.id })).body;
  assert.equal(wait.status, 'waitlisted');
  // Nothing to change; spots below who is booked; front desk can't edit.
  assert.equal((await coach('PATCH', `/v1/sessions/${s.id}`, { name: 'Makeup speed', capacity: 1 })).body.error.message, 'Nothing to change.');
  assert.equal((await desk('PATCH', `/v1/sessions/${s.id}`, { capacity: 3 })).status, 403);
  assert.equal((await coach('PATCH', `/v1/sessions/${s.id}`, { date: day(-1) })).status, 400);
  // More spots: Mia moves up (her credit covers it) and her family hears once.
  const more = (await coach('PATCH', `/v1/sessions/${s.id}`, { capacity: 3 })).body;
  assert.equal(more.promoted, 1);
  assert.deepEqual(more.changed, ['spots']);
  assert.equal(more.roster.find((r) => r.client_id === mia.id).status, 'booked');
  assert.equal(more.roster.find((r) => r.client_id === mia.id).coverage, 'credit');
  assert.equal(mail('tran@example.com', 'A spot opened%').length, 1);
  assert.equal((await coach('PATCH', `/v1/sessions/${s.id}`, { capacity: 1 })).status, 400);
  // A new time and place: both families are emailed once; notify=false moves it quietly.
  const m1 = mail('maria@example.com', 'New time: Makeup%').length;
  const moved = (await coach('PATCH', `/v1/sessions/${s.id}`, { start_time: '11:30', location_id: park.id, duration_min: 90, staff_note: '' })).body;
  assert.deepEqual(moved.changed.sort(), ['length', 'note', 'place', 'time'].sort());
  assert.equal(moved.families_emailed, 2);
  assert.equal(hm(moved.starts_at), '11:30');
  assert.equal(moved.staff_note, null);
  assert.equal(mail('maria@example.com', 'New time: Makeup%').length, m1 + 1);
  assert.match(mail('maria@example.com', 'New time: Makeup%').at(-1).body, /has moved to .* at Zilker Park/);
  const quiet = (await coach('PATCH', `/v1/sessions/${s.id}`, { start_time: '12:00', notify: false })).body;
  assert.equal(quiet.families_emailed, 0);
  assert.equal(mail('maria@example.com', 'New time: Makeup%').length, m1 + 1);
});

test('a class session moved to another day still stands for its class day', async () => {
  const s = (await owner('POST', '/v1/class-series', { name: 'Agility', kind: 'group', location_id: facility.id, weekdays: [weekdayOf(day(5))], start_time: '17:00', duration_min: 60, capacity: 8, start_date: day(1) })).body;
  const [x] = await sessionsOf(s.id);
  const was = localDate(x.starts_at, TZ);
  await owner('PATCH', `/v1/sessions/${x.id}`, { date: addDaysToDate(was, 1), notify: false });
  await extendSchedule(app.ctx);
  const all = await sessionsOf(s.id);
  assert.ok(!all.some((y) => localDate(y.starts_at, TZ) === was), 'the job did not add the original day back');
  // Editing the class later doesn't cancel it for not being on a class day.
  const r = (await owner('PATCH', `/v1/class-series/${s.id}`, { name: 'Agility lab' })).body;
  assert.equal(r.changes.canceled, 0);
  assert.equal((await owner('GET', `/v1/sessions/${x.id}`)).body.status, 'scheduled');
  assert.equal((await owner('GET', `/v1/sessions/${x.id}`)).body.name, 'Agility lab');
});

test('emailing a session\'s families: one email each, and a double tap is refused', async () => {
  const s = (await owner('POST', '/v1/sessions', { name: 'Hitting', kind: 'group', location_id: facility.id, date: day(6), start_time: '15:00', capacity: 5 })).body;
  assert.equal((await desk('POST', `/v1/sessions/${s.id}/message`, { message: 'Bring your bats' })).status, 409, 'nobody booked yet');
  await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: ava.id });
  await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: noah.id });
  await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: cole.id });
  const r = await desk('POST', `/v1/sessions/${s.id}/message`, { message: 'Bring your bats' });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, 2, 'the Lopez family gets one email for two children');
  const m = mail('maria@example.com', 'Hitting,%');
  assert.equal(m.length, 1);
  assert.match(m[0].body, /Bring your bats\n\nDana Desk,/);
  const again = await coach('POST', `/v1/sessions/${s.id}/message`, { message: 'bring your bats' });
  assert.equal(again.status, 409);
  assert.equal(mail('maria@example.com', 'Hitting,%').length, 1);
  assert.equal((await coach('POST', `/v1/sessions/${s.id}/message`, { message: '' })).status, 400);
});

test('moving someone up over the spots, by staff only, and "also booked then" when booking over another session', async () => {
  const s = (await owner('POST', '/v1/sessions', { name: 'Tiny group', kind: 'group', location_id: facility.id, date: day(7), start_time: '09:00', capacity: 1 })).body;
  await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: cole.id });
  const w = (await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: mia.id })).body;
  assert.equal(w.status, 'waitlisted');
  const [p1, p2] = await Promise.all([desk('POST', `/v1/bookings/${w.id}/promote`), desk('POST', `/v1/bookings/${w.id}/promote`)]);
  assert.deepEqual([p1.status, p2.status].sort(), [200, 409], 'a double tap moves her up once');
  const ok = p1.status === 200 ? p1.body : p2.body;
  assert.equal(ok.over_spots, true);
  assert.match(ok.message, /1 over its spots/);
  const sess = (await owner('GET', `/v1/sessions/${s.id}`)).body;
  assert.equal(sess.booked_count, 2);
  // Staff can book Mia at an overlapping time elsewhere, and hear about it.
  const other = (await owner('POST', '/v1/sessions', { name: 'Overlap', kind: 'group', location_id: park.id, date: day(7), start_time: '09:30', capacity: 5 })).body;
  const b = (await desk('POST', `/v1/sessions/${other.id}/bookings`, { client_id: mia.id })).body;
  assert.equal(b.status, 'booked');
  assert.equal(b.clash.name, 'Tiny group');
  const c = (await desk('POST', `/v1/sessions/${other.id}/bookings`, { client_id: ava.id })).body;
  assert.equal(c.clash, null);
});

test('canceling a team session emails the school contact once; hours can go on several days at once', async () => {
  const contract = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Westlake HS', contact_name: 'Pat Reed', contact_email: 'ad@westlake.test' }, name: 'Varsity', monthly_cents: 100000 })).body;
  await owner('POST', `/v1/team-contracts/${contract.id}/sessions`, { location_id: facility.id, weekdays: [weekdayOf(day(2))], start_time: '07:00', duration_min: 60, start_date: day(1) });
  const teamSession = (await owner('GET', `/v1/schedule?kind=team`)).body.data[0];
  const [a, b] = await Promise.all([coach('POST', `/v1/sessions/${teamSession.id}/cancel`, { reason: 'Field closed.' }), coach('POST', `/v1/sessions/${teamSession.id}/cancel`, { reason: 'Field closed.' })]);
  assert.ok([a.body.team_contact_emailed, b.body.team_contact_emailed].filter(Boolean).length === 1);
  const m = mail('ad@westlake.test', 'Canceled:%');
  assert.equal(m.length, 1);
  assert.match(m[0].body, /Hi Pat,\n\n.*Westlake HS Varsity .* is canceled\. Field closed\./);
  // Hours on Monday to Friday at once.
  const h = (await coach('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekdays: [1, 2, 3, 4, 5], start_time: '15:00', end_time: '17:00', slot_minutes: 60, coach_id: coachId })).body;
  assert.equal(h.added.length, 5);
  assert.deepEqual(h.added.map((x) => x.weekday), [1, 2, 3, 4, 5]);
  assert.equal((await coach('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekdays: [9], start_time: '15:00', end_time: '17:00' })).status, 400);
  assert.equal((await desk('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: 1, start_time: '15:00', end_time: '17:00' })).status, 403);
});

test('rosters flag missing waivers and birthdays; coaches never get prices from the schedule or a roster', async () => {
  const s = (await owner('POST', '/v1/sessions', { name: 'Paid clinic', kind: 'clinic', location_id: facility.id, date: day(8), start_time: '12:00', capacity: 5, drop_in_cents: 3000 })).body;
  await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: cole.id });
  app.ctx.db.run('UPDATE clients SET birth_date = ? WHERE id = ?', `2012-${day(8).slice(5)}`, cole.id);
  const r = (await owner('GET', `/v1/sessions/${s.id}`)).body;
  const row = r.roster.find((x) => x.client_id === cole.id);
  assert.equal(row.no_waiver, true);
  assert.equal(row.birthday, true);
  assert.equal(r.drop_in_cents, 3000);
  const c = (await coach('GET', `/v1/sessions/${s.id}`)).body;
  assert.equal(c.drop_in_cents, undefined);
  assert.equal((await coach('GET', '/v1/schedule')).body.data.find((x) => x.id === s.id).drop_in_cents, undefined);
  assert.equal((await desk('GET', '/v1/schedule')).body.data.find((x) => x.id === s.id).drop_in_cents, undefined);
});
