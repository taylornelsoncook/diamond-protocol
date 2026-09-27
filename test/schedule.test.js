// Schedule tab: prices kept from coaches, editing classes and single sessions, one-off sessions, emailing a
// session's families, moving someone up from the waitlist, hours on several days, time off, and role refusals.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-schedule-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const { get, all, insert, run } = require('../server/db');
const { addDays } = require('../server/lib');
const booking = require('../server/services/booking');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), put: (p, b = {}) => req('PUT', p, b), del: (p) => req('DELETE', p),
    login: (email, password) => req('POST', '/api/auth/staff/login', { email, password }) };
}
async function as(email, pw) { const c = client(); const r = await c.login(email, pw); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }
const owner = () => as('owner@demo.test', 'demo-owner-2026');
const coach = () => as('coach@demo.test', 'demo-coach-2026');
const desk = () => as('desk@demo.test', 'demo-desk-2026');
const athlete = (first) => get('SELECT * FROM athletes WHERE first_name=?', first);
const outbox = () => get('SELECT COUNT(*) n FROM outbox').n;
const T = () => booking.todayLocal();
const weekday = (d) => new Date(d + 'T12:00:00').getDay();
const nextDay = (wd, from = addDays(T(), 1)) => { let d = from; while (weekday(d) !== wd) d = addDays(d, 1); return d; };
const loc = () => get('SELECT id FROM locations WHERE archived=0 ORDER BY id LIMIT 1').id;

test('Schedule list and session detail keep prices from coaches; owners still see them', async () => {
  const c = await coach(), o = await owner(), d = await desk();
  const list = (await c.get('/api/events')).data;
  assert.ok(list.length && list.every((e) => e.price_cents === undefined), 'no prices in the coach schedule list');
  assert.ok((await d.get('/api/events')).data.every((e) => e.price_cents === undefined), 'no prices in the front desk list either');
  assert.ok((await o.get('/api/events')).data.some((e) => e.price_cents > 0), 'owners see drop-in prices');
  const withClass = list.find((e) => e.class_id && e.type === 'class');
  const detail = (await c.get(`/api/events/${withClass.id}`)).data;
  assert.ok(detail.class && detail.class.price_cents === undefined && detail.class.reg_price_cents === undefined, 'no class prices in the coach roster');
  assert.ok((await o.get(`/api/events/${withClass.id}`)).data.class.price_cents >= 0);
});

test('Roster cards flag a missing waiver; the demo has a staff note, a one-off session and time off', async () => {
  const o = await owner();
  const isa = athlete('Isabela');
  const e = get("SELECT e.id FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.status='booked' LIMIT 1", isa.id);
  const r = (await o.get(`/api/events/${e.id}`)).data;
  const row = [...r.booked, ...r.waitlist].find((x) => x.athlete.id === isa.id);
  assert.equal(row.athlete.waiver_missing, true, 'the Silva family has not signed');
  const ava = r.booked.find((x) => x.athlete.first_name === 'Ava');
  if (ava) assert.equal(ava.athlete.waiver_missing, false);
  assert.ok(get('SELECT 1 FROM events WHERE staff_note IS NOT NULL'), 'a session carries a staff note');
  assert.ok(get("SELECT 1 FROM events WHERE class_id IS NULL AND name LIKE 'Makeup:%'"), 'a one-off session');
  assert.ok((await o.get('/api/time-off')).data.length >= 1, 'upcoming time off');
});

test('Edit a class: new time moves upcoming sessions and emails families; dropped days are cancelled; roles', async () => {
  const c = await coach(), d = await desk(), o = await owner();
  const made = await o.post('/api/classes', { name: 'Edit Me', type: 'class', weekdays: [1, 3], start_time: '19:30', duration_min: 60, capacity: 2, price_cents: 2500, coach_id: '' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(get('SELECT coach_id FROM classes WHERE id=?', made.data.id).coach_id, null, 'a blank coach means no coach, not you');
  const mon = get("SELECT * FROM events WHERE class_id=? AND starts_at LIKE ? ORDER BY starts_at LIMIT 1", made.data.id, `${nextDay(1)}%`);
  const wedCount = all('SELECT starts_at FROM events WHERE class_id=? AND cancelled=0', made.data.id).filter((e) => weekday(e.starts_at.slice(0, 10)) === 3).length;
  assert.ok(wedCount > 0);
  const isa = athlete('Isabela'), mason = athlete('Mason');
  assert.equal((await o.post(`/api/events/${mon.id}/bookings`, { athlete_id: isa.id })).status, 200);
  assert.equal((await o.post(`/api/events/${mon.id}/bookings`, { athlete_id: mason.id })).status, 200);

  const body = { name: 'Edit Me Later', weekdays: [1], start_time: '18:00', duration_min: 45, capacity: 3, location_id: loc() };
  assert.equal((await d.put(`/api/classes/${made.data.id}`, body)).status, 403, 'front desk cannot change classes');
  assert.match((await c.put(`/api/classes/${made.data.id}`, { ...body, capacity: 1 })).data.error, /2 athletes are booked/, 'spots never drop below bookings');
  assert.equal((await c.put(`/api/classes/${made.data.id}`, { ...body, weekdays: [] })).status, 400);

  const before = outbox();
  const r = await c.put(`/api/classes/${made.data.id}`, body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.moved >= 1 && r.data.cancelled === wedCount, JSON.stringify(r.data));
  const cls = get('SELECT * FROM classes WHERE id=?', made.data.id);
  assert.equal(cls.price_cents, 2500, 'a coach edit without prices keeps the price');
  assert.equal(cls.name, 'Edit Me Later');
  const moved = get('SELECT * FROM events WHERE id=?', mon.id);
  assert.equal(moved.starts_at, `${mon.starts_at.slice(0, 10)}T18:00`);
  assert.equal(moved.duration_min, 45);
  assert.equal(moved.capacity, 3);
  assert.equal(moved.name, 'Edit Me Later');
  assert.ok(get("SELECT 1 FROM outbox WHERE subject='New time: Edit Me Later' AND id>?", 0), 'booked families hear about the new time');
  assert.ok(outbox() > before);
  const live = all('SELECT starts_at FROM events WHERE class_id=? AND cancelled=0 AND starts_at>?', made.data.id, booking.nowLocal());
  assert.ok(live.length && live.every((e) => weekday(e.starts_at.slice(0, 10)) === 1 && e.starts_at.endsWith('T18:00')), 'only Mondays at the new time remain');
  assert.ok(all("SELECT 1 FROM activity WHERE action='Edited class'").length);

  // Adding a day back fills the schedule again.
  const again = await o.put(`/api/classes/${made.data.id}`, { ...body, weekdays: [1, 5] });
  assert.equal(again.status, 200);
  assert.ok(again.data.added >= 1, 'Friday sessions are added');
  assert.equal((await o.put('/api/classes/999999', body)).status, 404);
});

test('One-off sessions: owners and coaches add them, front desk cannot, past dates refused', async () => {
  const c = await coach(), d = await desk();
  const day = addDays(T(), 3);
  const body = { name: 'Makeup session', type: 'class', date: day, start_time: '10:00', duration_min: 60, capacity: 8, price_cents: 2000, location_id: loc() };
  assert.equal((await d.post('/api/events', body)).status, 403);
  assert.match((await c.post('/api/events', { ...body, date: addDays(T(), -1) })).data.error, /today or a later date/);
  assert.equal((await c.post('/api/events', { ...body, name: '' })).status, 400);
  assert.equal((await c.post('/api/events', { ...body, type: 'team' })).status, 400);
  const r = await c.post('/api/events', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = get('SELECT * FROM events WHERE id=?', r.data.id);
  assert.equal(e.class_id, null);
  assert.equal(e.coach_id, get("SELECT id FROM staff WHERE email='coach@demo.test'").id, 'defaults to the coach who added it');
  assert.ok((await c.get(`/api/events?from=${day}&to=${day}`)).data.some((x) => x.id === r.data.id));
  const b = await d.post(`/api/events/${r.data.id}/bookings`, { athlete_id: athlete('Kevin').id });
  assert.equal(b.status, 200, 'front desk can book it');
});

test('Edit one session: sub coach, new time emails families, spots and the waitlist, staff note; roles', async () => {
  const o = await owner(), c = await coach(), d = await desk();
  const eid = insert('events', { type: 'class', name: 'Session Edit', starts_at: `${addDays(T(), 2)}T17:00`, duration_min: 60, capacity: 1, price_cents: 1500, location_id: loc() });
  const kevin = athlete('Kevin'), ava = athlete('Ava');
  await o.post(`/api/events/${eid}/bookings`, { athlete_id: kevin.id });
  const w = await o.post(`/api/events/${eid}/bookings`, { athlete_id: ava.id });
  assert.equal(w.data.booking.status, 'waitlist');

  assert.equal((await d.put(`/api/events/${eid}`, { staff_note: 'x' })).status, 403);
  const sub = get("SELECT id FROM staff WHERE role='owner' LIMIT 1").id;
  let r = await c.put(`/api/events/${eid}`, { coach_id: sub, staff_note: 'Jordan subs today.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.notified, 0, 'a coach change alone emails nobody');
  assert.equal(get('SELECT staff_note FROM events WHERE id=?', eid).staff_note, 'Jordan subs today.');
  assert.ok((await d.get(`/api/events?from=${addDays(T(), 2)}&to=${addDays(T(), 2)}`)).data.find((e) => e.id === eid).staff_note, 'staff see the note on the schedule');

  const before = outbox();
  r = await c.put(`/api/events/${eid}`, { start_time: '18:30' });
  assert.equal(r.data.notified, 1);
  assert.equal(outbox(), before + 1);
  assert.equal(get('SELECT starts_at FROM events WHERE id=?', eid).starts_at, `${addDays(T(), 2)}T18:30`);
  r = await c.put(`/api/events/${eid}`, { start_time: '19:00', notify: false });
  assert.equal(r.data.notified, 0, 'staff can choose not to email');

  assert.match((await c.put(`/api/events/${eid}`, { capacity: 0 })).data.error, /between 1 and 500/);
  assert.match((await c.put(`/api/events/${eid}`, { date: addDays(T(), -3) })).data.error, /today or a later date/);
  r = await c.put(`/api/events/${eid}`, { capacity: 2 });
  assert.equal(r.data.promoted, 1, 'more spots move the waitlist up');
  assert.equal(get('SELECT status FROM bookings WHERE id=?', w.data.booking.id).status, 'booked');
  assert.match((await c.put(`/api/events/${eid}`, { capacity: 1 })).data.error, /2 athletes are booked/);
  assert.equal((await c.put(`/api/events/${eid}`, {})).status, 400, 'nothing to change');

  // A class session can't be moved onto another session of the same class.
  const two = all("SELECT * FROM events WHERE class_id IS NOT NULL AND cancelled=0 AND starts_at>? ORDER BY class_id, starts_at", booking.nowLocal());
  const pair = two.find((x, i) => two[i + 1] && two[i + 1].class_id === x.class_id);
  const other = two[two.indexOf(pair) + 1];
  assert.match((await c.put(`/api/events/${pair.id}`, { date: other.starts_at.slice(0, 10), start_time: other.starts_at.slice(11, 16) })).data.error, /already has a session/);
  run('UPDATE events SET cancelled=1 WHERE id=?', eid);
  assert.match((await c.put(`/api/events/${eid}`, { staff_note: 'x' })).data.error, /cancelled/);
});

test('Email a session\'s families: booked (and waitlist if asked), signed, logged; any staff can send', async () => {
  const d = await desk();
  const eid = insert('events', { type: 'class', name: 'Message Test', starts_at: `${addDays(T(), 1)}T16:00`, duration_min: 60, capacity: 1, location_id: loc() });
  assert.match((await d.post(`/api/events/${eid}/message`, { message: 'Hi' })).data.error, /Nobody to email/);
  await d.post(`/api/events/${eid}/bookings`, { athlete_id: athlete('Emma').id });
  await d.post(`/api/events/${eid}/bookings`, { athlete_id: athlete('Kevin').id });
  assert.equal((await d.post(`/api/events/${eid}/message`, { message: '  ' })).status, 400);
  assert.equal((await d.post(`/api/events/${eid}/message`, { message: 'x'.repeat(1001) })).status, 400);
  let before = outbox();
  let r = await d.post(`/api/events/${eid}/message`, { message: 'Starting 10 minutes late.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sent, 1);
  assert.equal(outbox(), before + 1);
  const mail = get('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  assert.match(mail.body, /Starting 10 minutes late\.[\s\S]*Riley Tran/);
  before = outbox();
  r = await d.post(`/api/events/${eid}/message`, { message: 'Waitlist too.', waitlist: true });
  assert.equal(r.data.sent, 2);
  assert.ok(all("SELECT 1 FROM activity WHERE action='Emailed families'").length);
  assert.equal((await client().post(`/api/events/${eid}/message`, { message: 'x' })).status, 401);
});

test('Move up from the waitlist: books over the spots and emails the family', async () => {
  const d = await desk();
  const eid = insert('events', { type: 'class', name: 'Promote Test', starts_at: `${addDays(T(), 1)}T15:00`, duration_min: 60, capacity: 1, price_cents: 2000, location_id: loc() });
  const b1 = await d.post(`/api/events/${eid}/bookings`, { athlete_id: athlete('Kevin').id });
  const w = await d.post(`/api/events/${eid}/bookings`, { athlete_id: athlete('Mason').id });
  assert.equal(w.data.booking.status, 'waitlist');
  assert.equal((await d.post(`/api/bookings/${b1.data.booking.id}/promote`)).status, 400, 'only waitlisted athletes move up');
  const before = outbox();
  const r = await d.post(`/api/bookings/${w.data.booking.id}/promote`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const b = get('SELECT * FROM bookings WHERE id=?', w.data.booking.id);
  assert.equal(b.status, 'booked');
  assert.equal(b.coverage, 'unpaid', 'a paused member owes the drop-in');
  assert.equal(outbox(), before + 1);
  assert.equal(get("SELECT COUNT(*) n FROM bookings WHERE event_id=? AND status='booked'", eid).n, 2, 'over the spots on purpose');
  assert.ok(get("SELECT 1 FROM activity WHERE action='Moved up from waitlist' AND detail LIKE '%over spots%'"));
});

test('Hours on several days at once; overlaps refuse the whole set; coach must exist; open-times preview', async () => {
  const c = await coach(), d = await desk();
  const base = { kind: 'evaluation', start_time: '07:00', end_time: '09:00', slot_min: 30, location_id: loc(), price_cents: 6000 };
  const r = await c.post('/api/availability', { ...base, weekdays: [1, 2, 3, 4, 5] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ids.length, 5);
  const n = get('SELECT COUNT(*) n FROM availability').n;
  const clash = await c.post('/api/availability', { ...base, start_time: '08:00', end_time: '10:00', weekdays: [0, 3] });
  assert.equal(clash.status, 400);
  assert.match(clash.data.error, /overlaps Wed/);
  assert.equal(get('SELECT COUNT(*) n FROM availability').n, n, 'nothing is added when one day clashes');
  assert.match((await c.post('/api/availability', { ...base, weekday: 6, coach_id: 99999 })).data.error, /Choose a coach/);
  assert.equal((await c.post('/api/availability', { ...base, weekday: 6 })).status, 200, 'a single weekday still works');
  assert.match((await c.post('/api/availability', { ...base, weekdays: [] })).data.error, /Pick a day/);
  const open = await c.get('/api/availability/open');
  assert.equal(open.status, 200);
  assert.ok(open.data.evaluation.count > 0 && open.data.evaluation.next);
  assert.equal((await d.get('/api/availability/open')).status, 403);
  for (const id of [...r.data.ids]) await c.del(`/api/availability/${id}`);
});

test('Time off blocks private and evaluation times for that coach, or everyone when the facility is closed', async () => {
  const c = await coach(), d = await desk(), o = await owner();
  const coachId = get("SELECT id FROM staff WHERE email='coach@demo.test'").id;
  const hours = get('SELECT * FROM availability WHERE kind=? AND coach_id=? ORDER BY weekday LIMIT 1', 'private', coachId);
  const day = nextDay(hours.weekday, addDays(T(), 1));
  const has = () => booking.openSlots('private', day, 1).some((s) => s.coach_id === coachId);
  assert.ok(has(), 'open before time off');

  assert.equal((await d.post('/api/time-off', { coach_id: coachId, start_date: day })).status, 403, 'front desk cannot add time off');
  assert.equal((await d.get('/api/time-off')).status, 200, 'front desk can see it');
  assert.match((await c.post('/api/time-off', { start_date: day, end_date: addDays(day, -1) })).data.error, /before the first day/);
  assert.match((await c.post('/api/time-off', { start_date: addDays(T(), -5), end_date: addDays(T(), -4) })).data.error, /already passed/);
  assert.match((await c.post('/api/time-off', { start_date: 'soon' })).data.error, /first and last day/);
  assert.match((await c.post('/api/time-off', { coach_id: 99999, start_date: day })).data.error, /Choose a coach/);

  const r = await c.post('/api/time-off', { coach_id: coachId, start_date: day, note: 'Clinic' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(typeof r.data.already_booked, 'number');
  assert.ok(!has(), 'no private times that day');
  assert.ok(booking.openSlots('private', addDays(day, 7), 1).some((s) => s.coach_id === coachId), 'the next week is untouched');
  assert.equal((await c.del(`/api/time-off/${r.data.id}`)).status, 200);
  assert.ok(has(), 'bookable again');

  const closed = await o.post('/api/time-off', { coach_id: '', start_date: day, end_date: day, note: 'Holiday' });
  assert.equal(closed.status, 200);
  assert.equal(get('SELECT coach_id FROM time_off WHERE id=?', closed.data.id).coach_id, null);
  assert.equal(booking.openSlots('private', day, 1).length, 0, 'facility closed: nothing open');
  assert.ok((await d.get('/api/time-off')).data.some((t) => t.id === closed.data.id && t.coach === null));
  assert.equal((await d.del(`/api/time-off/${closed.data.id}`)).status, 403);
  await o.del(`/api/time-off/${closed.data.id}`);
  assert.equal((await o.del(`/api/time-off/${closed.data.id}`)).status, 404);
  assert.ok(all("SELECT 1 FROM activity WHERE action='Added time off'").length >= 2);
});

test('A private with one coach no longer blocks another coach\'s open time', async () => {
  const o = await owner();
  const coachId = get("SELECT id FROM staff WHERE email='coach@demo.test'").id;
  const ownerId = get("SELECT id FROM staff WHERE email='owner@demo.test'").id;
  const day = nextDay(0, addDays(T(), 1)); // a Sunday: no demo hours
  const add = (coach_id) => o.post('/api/availability', { kind: 'private', weekday: 0, start_time: '10:00', end_time: '11:00', slot_min: 60, location_id: loc(), coach_id });
  const a = await add(coachId), b = await add(ownerId);
  assert.equal(a.status, 200); assert.equal(b.status, 200, JSON.stringify(b.data));
  insert('events', { type: 'private', name: 'Private: someone', starts_at: `${day}T10:00`, duration_min: 60, capacity: 1, coach_id: coachId, location_id: loc() });
  const slots = booking.openSlots('private', day, 1).filter((s) => s.starts_at === `${day}T10:00`);
  assert.deepEqual(slots.map((s) => s.coach_id), [ownerId], 'only the busy coach is blocked');
  await o.del(`/api/availability/${a.data.id}`); await o.del(`/api/availability/${b.data.id}`);
});

test('Cancelling a team session also emails the school contact', async () => {
  const c = await coach();
  const team = get("SELECT id FROM team_contracts WHERE team_name='Riverside Varsity Football'").id;
  const eid = insert('events', { type: 'team', name: 'Team cancel test', starts_at: `${addDays(T(), 4)}T15:30`, duration_min: 60, capacity: 60, team_id: team, location_id: loc() });
  const r = await c.post(`/api/events/${eid}/cancel`, { reason: 'Field closed' });
  assert.equal(r.status, 200);
  assert.equal(r.data.team_notified, true);
  assert.ok(get("SELECT 1 FROM outbox WHERE to_email='athletics@riverside.example.org' AND body LIKE '%Field closed%'"));
});

test('Class validation: the last day to register must fall inside the camp', async () => {
  const o = await owner();
  const start = addDays(T(), 10), end = addDays(T(), 12);
  const r = await o.post('/api/classes', { name: 'Late Reg Camp', type: 'camp', weekdays: [0, 1, 2, 3, 4, 5, 6], start_time: '09:00', duration_min: 60, capacity: 10, start_date: start, end_date: end, reg_deadline: addDays(end, 2), reg_price_cents: 10000 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /after the camp ends/);
});
