import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { addDaysToDate, weekdayOf, localDate } from '../src/util.js';

// The Schedule page's month calendar (owner's ask: click a day and go there, at least a year ahead): per day the
// sessions and bookings, and past the 8-week horizon the classes projected from their series.
let app, base, owner, desk, facility, today;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_f', 'Facility', 'facility', 1, ?)`, app.ctx.now());
  facility = { id: 'loc_f' };
  today = localDate(app.ctx.now(), app.ctx.db.get(`SELECT value FROM settings WHERE key = 'timezone'`)?.value ?? 'America/Chicago');
});
after(() => app.server.close());

test('the month view counts sessions and bookings per day, and projects the weekly classes past the 8-week horizon a year ahead', async () => {
  const tomorrow = addDaysToDate(today, 1);
  const r = await owner('POST', '/v1/class-series', { name: 'Speed', kind: 'group', location_id: facility.id, weekdays: [weekdayOf(tomorrow)], start_time: '17:00', duration_min: 60, capacity: 10, drop_in_cents: 2500, start_date: tomorrow });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  const first = (await owner('GET', `/v1/schedule?from=${tomorrow}T00:00:00Z&to=${addDaysToDate(tomorrow, 1)}T23:59:59Z`)).body.data[0];
  assert.ok(first, 'the first session exists');
  assert.equal((await owner('POST', `/v1/sessions/${first.id}/bookings`, { client_id: ava.id, coverage: 'none' })).status, 201);
  // This month (or next, when tomorrow rolls over): tomorrow has one session with one booking.
  const m = tomorrow.slice(0, 7);
  const mv = (await owner('GET', `/v1/schedule/month?month=${m}`)).body;
  assert.equal(mv.month, m);
  assert.equal(mv.horizon, addDaysToDate(today, 56));
  const day = mv.days.find((d) => d.date === tomorrow);
  assert.deepEqual(day, { date: tomorrow, sessions: 1, booked: 1, canceled: 0, projected: 0 });
  // A year ahead: no sessions yet, but every matching weekday is a planned class.
  const far = addDaysToDate(today, 365), fm = far.slice(0, 7);
  const farView = (await owner('GET', `/v1/schedule/month?month=${fm}`)).body;
  const planned = farView.days.filter((d) => d.projected);
  assert.ok(planned.length >= 4 && planned.length <= 5, `${planned.length} planned days in ${fm}`);
  assert.ok(planned.every((d) => d.sessions === 0 && weekdayOf(d.date) === weekdayOf(tomorrow)));
  // The filters narrow it; a bad month is 400; front desk may look.
  assert.equal((await owner('GET', `/v1/schedule/month?month=${fm}&kind=camp`)).body.days.length, 0);
  assert.equal((await owner('GET', `/v1/schedule/month?month=${fm}&location_id=${facility.id}`)).body.days.filter((d) => d.projected).length, planned.length);
  assert.equal((await owner('GET', '/v1/schedule/month?month=2027-13')).status, 400);
  assert.equal((await desk('GET', `/v1/schedule/month?month=${m}`)).status, 200);
  // The week view a year out carries the planned classes (no ids: nothing to open) when asked to project.
  const wk = (await owner('GET', `/v1/schedule?from=${far}T00:00:00Z&to=${addDaysToDate(far, 7)}T00:00:00Z&project=true`)).body;
  assert.equal(wk.data.length, 0);
  assert.equal(wk.projected.length, 1);
  assert.deepEqual([wk.projected[0].name, wk.projected[0].projected, wk.projected[0].id], ['Speed', true, undefined]);
  assert.equal((await owner('GET', `/v1/schedule?from=${far}T00:00:00Z&to=${addDaysToDate(far, 7)}T00:00:00Z`)).body.projected, undefined, 'only when asked');
  // A series that has ended isn't projected.
  await owner('POST', '/v1/class-series', { name: 'Fall camp', kind: 'camp', location_id: facility.id, weekdays: [weekdayOf(tomorrow)], start_time: '09:00', duration_min: 120, capacity: 10, registration_cents: 20000, start_date: tomorrow, end_date: addDaysToDate(tomorrow, 14) });
  assert.equal((await owner('GET', `/v1/schedule/month?month=${fm}&kind=camp`)).body.days.length, 0);
});
