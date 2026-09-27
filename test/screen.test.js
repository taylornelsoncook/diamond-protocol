import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

// The weight-room screen: the session's workout on a TV, and athletes logging it from a shared tablet.
let app, base, coach, desk, facility, ava, ben, program, workout, squat, plank, speed, key;
const MIN = 60000;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const tv = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-kiosk-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const member = async (c) => {
  const plan = app.ctx.db.get('SELECT id FROM plans LIMIT 1');
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, newId('sub'), c.id, plan.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
};

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_f', 'Facility', 'facility', 1, ?)`, app.ctx.now());
  facility = { id: 'loc_f' };
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', '/v1/clients', { name: 'Ben Van Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  await member(ava); await member(ben);
  program = (await coach('POST', '/v1/programs', { name: 'Strength block', weeks: 4 })).body;
  workout = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Lower body' })).body;
  const ex = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  const ex2 = (await coach('POST', '/v1/exercises', { name: 'Front plank' })).body;
  let w = (await coach('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: ex.id, prescription: '5 × 5', load_test: 'squat_1rm', load_pct: 75 })).body;
  w = (await coach('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: ex2.id, prescription: '3 × 40 sec' })).body;
  [squat, plank] = w.exercises;
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Max day', date: '2026-09-01', tests: ['squat_1rm'] })).body;
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: ava.id, test: 'squat_1rm', metric: 'load', value: 200, recorded_at: '2026-09-01T15:00:00.000Z' }] });
  await coach('POST', `/v1/testing-sessions/${day.id}/share`, {});
  speed = newId('cls');
  const s = new Date(Date.now() - 10 * MIN).toISOString(), e = new Date(Date.now() + 50 * MIN).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Team lift', 'group', 'loc_f', ?, ?, 10, 'scheduled', ?)`, speed, s, e, s);
  for (const c of [ava, ben]) app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'membership', ?, ?)`, newId('bkg'), speed, c.id, app.ctx.now(), app.ctx.now());
  const k = (await coach('POST', '/v1/kiosks', { location_id: facility.id, name: 'Weight room TV' })).body;
  assert.match(k.screen_link, /^https:\/\/app\.example\.org\/tv#/);
  key = k.screen_link.split('#')[1];
});
after(() => app.server.close());

test('coaches put a workout on the screen for a session', async () => {
  let board = (await tv('GET', '/kiosk-api/screen')).body;
  assert.equal(board.sessions[0].workout, null);
  assert.equal((await desk('PUT', `/v1/sessions/${speed}/workout`, { workout_id: workout.id })).status, 403, 'front desk can\'t');
  const set = (await coach('PUT', `/v1/sessions/${speed}/workout`, { workout_id: workout.id })).body;
  assert.equal(set.workout.title, 'Lower body');
  assert.equal((await coach('GET', `/v1/sessions/${speed}`)).body.workout.program_name, 'Strength block');
  board = (await tv('GET', '/kiosk-api/screen')).body;
  const s = board.sessions[0];
  assert.deepEqual(s.workout.exercises.map((x) => [x.name, x.prescription, x.load]), [['Back squat', '5 × 5', '75% of back squat max'], ['Front plank', '3 × 40 sec', null]]);
  assert.deepEqual(s.athletes.map((a) => a.name), ['Ava L.', 'Ben P.'], 'first name and last initial only');
  assert.equal(JSON.stringify(board).includes('Lopez'), false);
});

test('an athlete taps their name, sees their weights, and logs the workout', async () => {
  const s = (await tv('GET', '/kiosk-api/screen')).body.sessions[0];
  const [a, b] = s.athletes;
  const me = (await tv('POST', '/kiosk-api/screen/athlete', { session_id: s.id, ref: a.ref })).body;
  assert.deepEqual(me.weights, [{ exercise_id: squat.id, name: 'Back squat', text: '150 lb' }]);
  assert.equal((await tv('POST', '/kiosk-api/screen/athlete', { session_id: s.id, ref: b.ref })).body.weights[0].text, 'Test your back squat max first');

  const log = await tv('POST', '/kiosk-api/screen/log', { session_id: s.id, ref: a.ref, exercise_ids: [squat.id, plank.id] });
  assert.deepEqual([log.status, log.body.name, log.body.exercises_logged], [201, 'Ava', 2]);
  assert.equal(app.ctx.db.get(`SELECT status FROM bookings WHERE session_id = ? AND client_id = ?`, speed, ava.id).status, 'attended', 'logging checks them in');
  const token = (await coach('GET', `/v1/clients/${ava.id}`)).body.app_link.split('token=')[1];
  const home = await (await fetch(`${base}/app/api/home`, { headers: { 'x-client-token': token } })).json();
  assert.equal(home.progress.completed, 1, 'it counts toward Ava\'s program');
  assert.equal((await tv('POST', '/kiosk-api/screen/log', { session_id: s.id, ref: a.ref })).status, 409, 'only once per session');

  // Ben isn't on the program: his log still counts as a workout done.
  assert.equal((await tv('POST', '/kiosk-api/screen/log', { session_id: s.id, ref: b.ref })).status, 201);
  assert.equal(app.ctx.db.get('SELECT assignment_id FROM workout_logs WHERE client_id = ?', ben.id).assignment_id, null);
  assert.equal((await coach('GET', `/v1/clients/${ben.id}`)).body.workouts_completed, 1);
  assert.deepEqual((await tv('GET', '/kiosk-api/screen')).body.sessions[0].athletes.map((x) => x.logged), [true, true]);
});

test('a revoked or wrong key shows nothing', async () => {
  const r = await fetch(base + '/kiosk-api/screen', { headers: { 'x-kiosk-key': 'nope' } });
  assert.equal(r.status, 401);
  assert.equal((await tv('POST', '/kiosk-api/screen/log', { session_id: speed, ref: 'b_madeup' })).status, 400);
});
