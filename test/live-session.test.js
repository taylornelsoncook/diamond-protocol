import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { openDb } from '../src/db.js';
import { newId } from '../src/util.js';

// The coach's live session view: every athlete in a class in progress, what they're on and what they've logged, and
// swapping an exercise for one athlete on the spot.
let app, base, coach, desk, owner, ava, ben, cal, program, workouts, squat, plank, goblet, session, key, token;
const MIN = 60000;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const tv = async (method, path, body) => (await fetch(base + path, { method, headers: { 'x-kiosk-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const athlete = async (method, path, body) => (await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const member = (c) => app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), c.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: 'correct-horse-battery', role: 'front_desk' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev'); owner = await signIn('owner@test.dev');
  app.ctx.db.run(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_f', 'Facility', 'facility', 1, ?)`, app.ctx.now());
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  cal = (await coach('POST', '/v1/clients', { name: 'Cal Reed', parent: { name: 'Sam Reed', email: 'sam@example.com' } })).body;
  member(ava); member(ben);
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  plank = (await coach('POST', '/v1/exercises', { name: 'Front plank', category: 'Core' })).body;
  goblet = (await coach('POST', '/v1/exercises', { name: 'Goblet squat', category: 'Lower body', instructions: 'Elbows inside the knees.' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Strength block', weeks: 1 })).body;
  for (let d = 1; d <= 3; d++) {
    const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: d, title: ['Lower body', 'Upper body', 'Full body'][d - 1] })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 5, reps: '5', load_test: 'squat_1rm', load_pct: 75 });
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: plank.id, sets: 3, reps: '40 sec' });
  }
  workouts = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts;
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Max day', date: '2026-09-01', tests: ['squat_1rm'] })).body;
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: ava.id, test: 'squat_1rm', metric: 'load', value: 200, recorded_at: '2026-09-01T15:00:00.000Z' }] });
  await coach('POST', `/v1/testing-sessions/${day.id}/share`, {});
  session = newId('cls');
  const s = new Date(Date.now() - 10 * MIN).toISOString(), e = new Date(Date.now() + 50 * MIN).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Team lift', 'group', 'loc_f', ?, ?, 10, 'scheduled', ?)`, session, s, e, s);
  for (const c of [ava, ben]) app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'membership', ?, ?)`, newId('bkg'), session, c.id, app.ctx.now(), app.ctx.now());
  await coach('PUT', `/v1/sessions/${session}/workout`, { workout_id: workouts[1].id });
  key = (await coach('POST', '/v1/kiosks', { location_id: 'loc_f', name: 'Weight room TV' })).body.screen_link.split('#')[1];
  token = (await coach('GET', `/v1/clients/${ava.id}`)).body.app_link.split('token=')[1];
});
after(() => app.server.close());

test('the live view: who is here, what each athlete is on today with their own numbers, and what they have logged', async () => {
  const live = (await coach('GET', `/v1/sessions/${session}/live`)).body;
  assert.deepEqual(live.counts, { athletes: 2, here: 0, logged: 0, started: 0 });
  assert.deepEqual(live.screen_workout, { id: workouts[1].id, title: 'Upper body', program_name: 'Strength block' });
  const [a, b] = live.athletes;
  assert.deepEqual([a.name, a.here, a.workout.title, a.workout.source, a.program_progress], ['Ava Lopez', false, 'Lower body', 'program', { completed: 0, total: 3, name: 'Strength block' }]);
  assert.deepEqual([a.exercises[0].name, a.exercises[0].load.lb, a.exercises[0].target_sets, a.exercises[0].sets_logged, a.exercises[0].done], ['Back squat', 150, 5, 0, false]);
  assert.deepEqual([b.name, b.workout.title, b.workout.source, b.program_progress, b.exercises[0].load.missing], ['Ben Park', 'Upper body', 'screen', null, true], 'no program: the workout on the screen, with no max to work a weight from');
  assert.equal((await desk('GET', `/v1/sessions/${session}/live`)).status, 200, 'front desk may look');
  // Ben logs from the TV; Ava finishes in the app. Both show up.
  const board = (await tv('GET', '/kiosk-api/screen')).sessions[0];
  await tv('POST', '/kiosk-api/screen/log', { session_id: session, ref: board.athletes.find((x) => x.name.startsWith('Ben')).ref, exercise_ids: workouts[1].exercises.map((x) => x.id) });
  const after1 = (await coach('GET', `/v1/sessions/${session}/live`)).body;
  const b2 = after1.athletes.find((x) => x.client_id === ben.id);
  assert.deepEqual([b2.here, b2.logged, b2.on_screen, b2.exercises_done], [true, true, true, 2]);
  assert.deepEqual(after1.counts, { athletes: 2, here: 1, logged: 1, started: 0 });
  // A workout Ben logged earlier today in another session (a different program) doesn't take his row over here.
  const other = (await coach('POST', '/v1/programs', { name: 'Speed block', weeks: 1 })).body;
  const ow = (await coach('POST', `/v1/programs/${other.id}/workouts`, { week: 1, day: 1, title: 'Sprints' })).body;
  const morning = newId('cls');
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Morning speed', 'group', 'loc_f', ?, ?, 10, 'scheduled', ?)`, morning, new Date(Date.now() - 3 * 3600000).toISOString(), new Date(Date.now() - 2 * 3600000).toISOString(), app.ctx.now());
  app.ctx.db.run(`INSERT INTO workout_logs (id, client_id, workout_id, completed_at, session_id) VALUES (?, ?, ?, ?, ?)`, newId('wlog'), ben.id, ow.id, new Date(Date.now() - 2.5 * 3600000).toISOString(), morning);
  const b3 = (await coach('GET', `/v1/sessions/${session}/live`)).body.athletes.find((x) => x.client_id === ben.id);
  assert.deepEqual([b3.workout.title, b3.logged, b3.on_screen], ['Upper body', true, true], 'this session\'s own log wins');
  const a3 = (await coach('GET', `/v1/sessions/${morning}/live`)).body.athletes;
  assert.equal(a3.length, 0, 'nobody is booked on the morning session, so the stray log shows nowhere');
});

test('a swap for one athlete: the app, the screen, the live view and the log follow it; the plan does not change', async () => {
  const slot = workouts[0].exercises[0];
  const sw = await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: goblet.id, reason: 'Knee', session_id: session });
  assert.equal(sw.status, 201, JSON.stringify(sw.body));
  assert.deepEqual([sw.body.exercise_name, sw.body.instead_of, sw.body.reason, sw.body.scope, sw.body.workouts, sw.body.by], ['Goblet squat', 'Back squat', 'Knee', 'workout', 1, 'Riley']);
  const home = await athlete('GET', '/app/api/home');
  const x = home.workout.exercises[0];
  assert.deepEqual([x.id, x.exercise_id, x.name, x.instructions, x.load, x.target_sets, x.swapped], [slot.id, goblet.id, 'Goblet squat', 'Elbows inside the knees.', null, 5, { id: sw.body.id, from: 'Back squat', reason: 'Knee', by: 'Riley', by_kind: 'coach' }]);
  assert.equal(home.workout.exercises[1].swapped, undefined);
  assert.equal((await coach('GET', `/v1/programs/${program.id}`)).body.workouts[0].exercises[0].name, 'Back squat', 'the plan itself is untouched');
  const live = (await coach('GET', `/v1/sessions/${session}/live`)).body.athletes.find((a) => a.client_id === ava.id);
  assert.deepEqual([live.exercises[0].name, live.exercises[0].swapped.from, live.exercises[0].load], ['Goblet squat', 'Back squat', null]);
  // The weight-room screen says so too (Ava's own numbers there come from the same place as the phone's).
  await coach('PUT', `/v1/sessions/${session}/workout`, { workout_id: workouts[0].id });
  const board = (await tv('GET', '/kiosk-api/screen')).sessions[0];
  const me = await tv('POST', '/kiosk-api/screen/athlete', { session_id: session, ref: board.athletes.find((n) => n.name.startsWith('Ava')).ref });
  assert.deepEqual(me.weights.map((w) => [w.name, w.text]), [['Goblet squat', 'instead of Back squat (Knee)']]);
  await coach('PUT', `/v1/sessions/${session}/workout`, { workout_id: workouts[1].id });
  // Finishing in the app logs the sets under the goblet squat, so history and progressions follow the exercise she did.
  const sets = [1, 2, 3, 4, 5].map((n) => ({ workout_exercise_id: slot.id, set_no: n, weight: 40, reps: 5 }));
  const fin = await athlete('POST', `/app/api/workouts/${workouts[0].id}/complete`, { request_id: newId('req'), exercise_ids: [slot.id], sets });
  assert.equal(fin.finished.exercises_logged, 1);
  assert.deepEqual(app.ctx.db.all('SELECT DISTINCT exercise_id, exercise_name FROM workout_sets WHERE workout_log_id = ?', fin.id), [{ exercise_id: goblet.id, exercise_name: 'Goblet squat' }]);
  const after1 = (await coach('GET', `/v1/sessions/${session}/live`)).body.athletes.find((a) => a.client_id === ava.id);
  assert.deepEqual([after1.logged, after1.on_screen, after1.sets_logged, after1.exercises_done, after1.workout.title], [true, false, 5, 1, 'Lower body'], 'today\'s log stays on the day\'s workout');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'exercise.swapped'`).n, 1);
  // Her history reads as what she did, with what it replaced.
  const detail = await athlete('GET', `/app/api/logs/${fin.id}`);
  assert.deepEqual([detail.exercises[0].name, detail.exercises[0].exercise_id, detail.exercises[0].swapped_from, detail.exercises[0].sets.length, detail.exercises[1].swapped_from], ['Goblet squat', goblet.id, 'Back squat', 5, undefined]);
});

test('a deleted workout keeps the swapped exercise in the log it left behind', async () => {
  // A throwaway program: swap, log, delete the workout, and the kept log still says goblet squat.
  const p = (await coach('POST', '/v1/programs', { name: 'One-off', weeks: 1 })).body;
  const w = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 1, title: 'Test day' })).body;
  const slot = (await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' })).body.exercises[0];
  await coach('POST', `/v1/clients/${ben.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: goblet.id, reason: 'Knee' });
  const logId = newId('wlog');
  app.ctx.db.run(`INSERT INTO workout_logs (id, client_id, workout_id, completed_at) VALUES (?, ?, ?, ?)`, logId, ben.id, w.id, app.ctx.now());
  app.ctx.db.run(`INSERT INTO exercise_logs (workout_log_id, workout_exercise_id) VALUES (?, ?)`, logId, slot.id);
  const gone = await coach('DELETE', `/v1/workouts/${w.id}`, { confirm: true });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  const kept = JSON.parse(app.ctx.db.get('SELECT exercises_snapshot FROM workout_logs WHERE id = ?', logId).exercises_snapshot);
  assert.deepEqual([kept[0].name, kept[0].exercise_id, kept[0].swapped_from, kept[0].done], ['Goblet squat', goblet.id, 'Back squat', true]);
});

test('scope program covers the rest of the program but never a workout already logged; Undo puts the plan back; the export lists swaps', async () => {
  const slot2 = workouts[1].exercises[0];
  // Asked from day 3's slot: the answer (and the Undo it gives the coach) is day 3's row, not the earliest one.
  const fromDay3 = (await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: workouts[2].exercises[0].id, exercise_id: goblet.id, reason: 'Knee', scope: 'program' })).body;
  assert.equal(fromDay3.workouts, 2);
  assert.equal(app.ctx.db.get('SELECT workout_exercise_id FROM exercise_swaps WHERE id = ?', fromDay3.id).workout_exercise_id, workouts[2].exercises[0].id);
  assert.equal((await coach('DELETE', `/v1/swaps/${fromDay3.id}`)).body.removed, 1, 'Undo from the Live panel puts only day 3 back');
  const sw = (await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot2.id, exercise_id: goblet.id, reason: 'Knee', scope: 'program' })).body;
  assert.equal(sw.workouts, 2, 'day 2 and day 3; day 1 is already logged');
  const list = (await coach('GET', `/v1/clients/${ava.id}/swaps`)).body.data;
  assert.deepEqual(list.map((s) => [s.workout_title, s.exercise_name, s.instead_of]).sort(), [['Full body', 'Goblet squat', 'Back squat'], ['Lower body', 'Goblet squat', 'Back squat'], ['Upper body', 'Goblet squat', 'Back squat']]);
  assert.equal((await athlete('GET', '/app/api/home')).workout.exercises[0].name, 'Goblet squat', 'day 2 in the app');
  // Swapping the same slot again replaces the swap; undoing with ?all=true clears the same swap across the program.
  const again = (await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot2.id, exercise_id: plank.id, reason: 'Try this' })).body;
  assert.equal((await coach('GET', `/v1/clients/${ava.id}/swaps`)).body.data.length, 3);
  assert.equal((await athlete('GET', '/app/api/home')).workout.exercises[0].name, 'Front plank');
  assert.deepEqual((await coach('DELETE', `/v1/swaps/${again.id}`)).body, { id: again.id, deleted: true, removed: 1 });
  assert.equal((await athlete('GET', '/app/api/home')).workout.exercises[0].name, 'Back squat', 'the plan is back');
  const day3 = (await coach('GET', `/v1/clients/${ava.id}/swaps`)).body.data.find((s) => s.workout_title === 'Full body');
  assert.equal((await coach('DELETE', `/v1/swaps/${day3.id}?all=true`)).body.removed, 2, 'day 3 and the day 1 swap (the same exercise for the same one)');
  assert.equal((await coach('GET', `/v1/clients/${ava.id}/swaps`)).body.data.length, 0);
  assert.equal((await coach('DELETE', `/v1/swaps/${day3.id}`)).status, 404);
  // Back in place for the export check.
  await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot2.id, exercise_id: goblet.id, reason: 'Knee' });
  const e = (await owner('GET', `/v1/families/${ava.family.id}/export`)).body;
  assert.deepEqual(Object.keys(e.athletes[0].exercise_swaps[0]).sort(), ['by_kind', 'created_at', 'created_by', 'day', 'exercise_name', 'instead_of', 'program_name', 'reason', 'week', 'workout_title']);
});

test('who may swap, and what a swap refuses', async () => {
  const slot = workouts[2].exercises[0];
  assert.equal((await desk('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: goblet.id })).status, 403, 'front desk runs the roster, not the programming');
  assert.equal((await desk('DELETE', `/v1/swaps/x`)).status, 403);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: squat.id })).status, 400, 'the same exercise');
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: 'wex_nope', exercise_id: goblet.id })).status, 404);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: 'ex_nope' })).status, 404);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: goblet.id, scope: 'forever' })).status, 400);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: goblet.id, reason: 'x'.repeat(201) })).status, 400);
  await coach('POST', `/v1/clients/${cal.id}/archive`, {});
  assert.equal((await coach('POST', `/v1/clients/${cal.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: goblet.id })).status, 409, 'archived');
  assert.equal((await coach('GET', '/v1/sessions/cls_nope/live')).status, 404);
  const spare = (await coach('POST', '/v1/exercises', { name: 'Box squat' })).body;
  await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: spare.id });
  assert.equal((await coach('DELETE', `/v1/exercises/${spare.id}`)).status, 409, 'swapped in for an athlete: not deleted under her');
});

test('a version 55 database gains the swaps table, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v55.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 55');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 69, `round ${round}`);
      assert.equal(d.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'exercise_swaps'`).n, 1);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
