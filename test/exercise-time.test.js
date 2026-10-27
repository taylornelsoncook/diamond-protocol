import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';
import { parseTime, timeText, rxText, MAX_SETS } from '../src/services/rx.js';
import { workbook } from '../src/services/programexport.js';
import { readXlsx, listSheets } from '../src/services/xlsx.js';

// A time per set (schema 93, owner's ask: "give an option for time so how long the exercise goes") and up to 99 sets
// (was 12): time_seconds on an exercise in a workout and in a complex, typed as seconds or minutes, shown in the short
// text, the app's table, the export and the builder; copies, Undo and the snapshot carry it.
let app, base, coach, ava, plank, bike, squat, program, w1;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = (c) => async (method, path, body) => {
  const token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', c.id).access_token;
  const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const slots = (p, wid) => p.workouts.find((w) => w.id === wid).exercises;
const detail = (id) => coach('GET', `/v1/programs/${id}`).then((r) => r.body);

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`,
    newId('sub'), ava.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  plank = (await coach('POST', '/v1/exercises', { name: 'Plank' })).body;
  bike = (await coach('POST', '/v1/exercises', { name: 'Assault bike' })).body;
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Conditioning', weeks: 2 })).body;
  w1 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Engine' })).body;
});
after(() => app.server.close());

test('a time is read from seconds or minutes and written back as the coach reads it', () => {
  assert.equal(MAX_SETS, 99);
  for (const [text, secs] of [['40', 40], ['40 sec', 40], ['40s', 40], ['2 min', 120], ['2min', 120], ['1:30', 90], ['1 min 30 sec', 90], ['0:45', 45], ['1 hr', 3600], [120, 120]]) assert.equal(parseTime(text), secs, String(text));
  assert.equal(parseTime(''), null); assert.equal(parseTime(null), null);
  for (const bad of ['abc', '40 reps', '1:5', '2.5', 'a minute']) assert.equal(parseTime(bad), undefined, bad);
  assert.deepEqual([40, 60, 90, 120, 3600, 5400].map(timeText), ['40 sec', '1 min', '1:30', '2 min', '1 hr', '90 min']);
  assert.equal(timeText(null), null);
  assert.equal(rxText({ sets: 3, time_seconds: 40 }), '3 × 40 sec', 'a time runs in place of reps');
  assert.equal(rxText({ sets: 3, reps: '8', time_seconds: 40 }), '3 × 8 · 40 sec', 'with reps it follows them');
  assert.equal(rxText({ sets: 4, distance: '20 yd', time_seconds: 30, load_text: 'sled' }), '4 × 20 yd · 30 sec @ sled');
  assert.equal(rxText({ time_seconds: 600 }), '10 min', 'a time on its own');
  assert.equal(rxText({ sets: 3 }), '3 sets', 'nothing changes without a time');
});

test('an exercise takes a time per set, typed as seconds or minutes; the short text and the app carry it; a bad time is 400', async () => {
  // The answer is the whole workout; the exercise added is its last.
  const add = async (body) => { const r = await coach('POST', `/v1/workouts/${w1.id}/exercises`, body); return { status: r.status, body: r.status === 201 ? r.body.exercises.at(-1) : r.body }; };
  const hold = await add({ exercise_id: plank.id, sets: 3, time_seconds: '40 sec' });
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
  assert.deepEqual([hold.body.time_seconds, hold.body.reps, hold.body.prescription], [40, null, '3 × 40 sec']);
  const ride = await add({ exercise_id: bike.id, sets: 6, reps: 'max', time_seconds: 20, rest_seconds: 40 });
  assert.deepEqual([ride.status, ride.body.time_seconds, ride.body.prescription, ride.body.details], [201, 20, '6 × max · 20 sec', 'Rest 40 sec']);
  const alone = await add({ exercise_id: bike.id, time_seconds: '10 min' });
  assert.deepEqual([alone.status, alone.body.sets, alone.body.time_seconds, alone.body.prescription], [201, null, 600, '10 min'], 'a time alone is enough: one set to tick');
  for (const [time, why] of [['abc', 'not a time'], ['2 hr', 'over an hour'], [0, 'zero'], ['40 reps', 'reps are not a time']]) {
    const r = await add({ exercise_id: plank.id, sets: 3, time_seconds: time });
    assert.equal(r.status, 400, why); assert.match(r.body.error.message, /like 40 sec, 2 min or 1:30, up to an hour/);
  }
  assert.equal((await add({ exercise_id: plank.id, sets: 3, reps: '8', time_seconds: null })).status, 201, 'null is no time');
  // Changing: a new time, then cleared; the text follows.
  const ch = (await coach('PATCH', `/v1/workout-exercises/${hold.body.id}`, { time_seconds: '1:30' })).body;
  assert.deepEqual([ch.time_seconds, ch.prescription], [90, '3 × 1:30']);
  const cl = (await coach('PATCH', `/v1/workout-exercises/${hold.body.id}`, { time_seconds: '' })).body;
  assert.deepEqual([cl.time_seconds, cl.prescription], [null, '3 sets']);
  await coach('PATCH', `/v1/workout-exercises/${hold.body.id}`, { time_seconds: 40 });
  // The app: the table's Time comes from time_seconds; a time with no reps is ticked set by set (no reps to count).
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  const home = (await athlete(ava)('GET', '/app/api/home')).body;
  const [h1, h2, h3] = home.workout.exercises;
  assert.deepEqual([h1.name, h1.time_seconds, h1.target_sets, h1.target_reps, h1.prescription], ['Plank', 40, 3, null, '3 × 40 sec']);
  assert.deepEqual([h2.time_seconds, h2.target_sets, h2.target_reps], [20, 6, null]);
  assert.deepEqual([h3.time_seconds, h3.target_sets], [600, 1]);
});

test('Undo, copies and the export carry the time; a complex keeps it and loads it into a workout', async () => {
  const list = slots(await detail(program.id), w1.id);
  const hold = list.find((x) => x.name === 'Plank' && x.time_seconds === 40);
  const gone = (await coach('DELETE', `/v1/workout-exercises/${hold.id}`)).body;
  assert.equal(gone.restore.time_seconds, 40, 'Undo carries the time');
  const { workout_id, ...back } = gone.restore;
  const again = await coach('POST', `/v1/workouts/${workout_id}/exercises`, back);
  const backRow = again.body.exercises.find((x) => x.position === back.position);   // Undo puts it back at its place, with a new id
  assert.deepEqual([again.status, backRow.time_seconds, backRow.prescription], [201, 40, '3 × 40 sec']);
  const copy = (await coach('POST', `/v1/workouts/${w1.id}/copy`, { week: 2, day: 1 })).body;
  const copied = slots(await detail(program.id), copy.id);
  assert.deepEqual(copied.map((x) => x.time_seconds).filter((t) => t != null).sort((a, b) => a - b), [20, 40, 600], 'the copy has every time');
  // The Excel export has a Time column.
  const wb = workbook(app.ctx, program.id).body;
  const sheet = listSheets(wb).find((s) => /W1 D1/.test(s));
  const rows = readXlsx(wb, sheet);
  const head = rows.find((r) => r.includes('Time'));
  assert.ok(head, 'a Time column');
  const col = head.indexOf('Time');
  assert.ok(rows.some((r) => r[col] === '40 sec') && rows.some((r) => r[col] === '10 min'), JSON.stringify(rows.slice(0, 6)));
  // A complex with a timed move, loaded into a workout.
  const cpx = await coach('POST', '/v1/complexes', { name: 'Core finisher', kind: 'circuit', exercises: [{ exercise_id: plank.id, sets: 3, time_seconds: '45 sec' }, { exercise_id: squat.id, sets: 3, reps: '10' }] });
  assert.equal(cpx.status, 201, JSON.stringify(cpx.body));
  assert.deepEqual([cpx.body.exercises[0].time_seconds, cpx.body.exercises[0].prescription], [45, '3 × 45 sec']);
  const w2 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 2, day: 2, title: 'Core' })).body;
  const loaded = await coach('POST', `/v1/workouts/${w2.id}/blocks`, { complex_id: cpx.body.id });
  assert.equal(loaded.status, 201, JSON.stringify(loaded.body));
  const inW2 = slots(await detail(program.id), w2.id);
  assert.deepEqual(inW2.map((x) => [x.name, x.time_seconds, x.prescription]), [['Plank', 45, '3 × 45 sec'], ['Back squat', null, '3 × 10']]);
});

test('up to 99 sets: the builder takes them, the app logs set 60, and 100 is refused', async () => {
  const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 2, title: 'Volume' })).body;
  const many = await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 60, reps: '1' });
  assert.deepEqual([many.status, many.body.exercises[0].sets, many.body.exercises[0].prescription], [201, 60, '60 × 1']);
  const too = await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 100, reps: '1' });
  assert.equal(too.status, 400); assert.match(too.body.error.message, /between 1 and 99/);
  const wk = (await athlete(ava)('GET', `/app/api/workouts/${w.id}`)).body;
  const x = wk.exercises[0];
  assert.equal(x.target_sets, 60);
  const done = await athlete(ava)('POST', `/app/api/workouts/${w.id}/complete`, { request_id: 'r60', sets: [{ workout_exercise_id: x.id, set_no: 60, weight: 135, reps: 1 }, { workout_exercise_id: x.id, set_no: 13, weight: 135, reps: 1 }] });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.deepEqual(app.ctx.db.all('SELECT set_no FROM workout_sets WHERE workout_log_id = ? ORDER BY set_no', done.body.id).map((r) => r.set_no), [13, 60]);
  const w2 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 3, title: 'More' })).body;
  const y = (await coach('POST', `/v1/workouts/${w2.id}/exercises`, { exercise_id: squat.id, sets: 5, reps: '5' })).body.exercises[0];
  const bad = await athlete(ava)('POST', `/app/api/workouts/${w2.id}/complete`, { request_id: 'r100', sets: [{ workout_exercise_id: y.id, set_no: 100 }] });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /sets are numbered 1 to 99/);
});

test('a version 92 database gains the time columns and logs past set 12, keeping its sets and the index, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v92-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v92.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 92');
    old.exec(`INSERT INTO clients (id, name, created_at, access_token) VALUES ('cli_1', 'Ava', '2026-09-01T00:00:00Z', 'tok1');
      INSERT INTO workout_logs (id, client_id, workout_id, assignment_id, completed_at, request_id) VALUES ('wl_1', 'cli_1', NULL, NULL, '2026-09-02T00:00:00Z', 'r1');
      INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES
        ('ws_1', 'wl_1', 'wex_1', NULL, 'Back squat', 1, 135, 5, '2026-09-02T00:00:00Z'), ('ws_2', 'wl_1', 'wex_1', NULL, 'Back squat', 12, 135, 5, '2026-09-02T00:00:00Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 95, `round ${round}`);
      assert.ok(d.all('PRAGMA table_info(workout_exercises)').some((c) => c.name === 'time_seconds'));
      assert.ok(d.all('PRAGMA table_info(complex_exercises)').some((c) => c.name === 'time_seconds'));
      assert.deepEqual(d.all('SELECT set_no, weight FROM workout_sets ORDER BY set_no').map((r) => [r.set_no, r.weight]), round === 1 ? [[1, 135], [12, 135]] : [[1, 135], [12, 135], [50, 135]], 'the sets survive the rebuild');
      assert.ok(d.all(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workout_sets'`).some((r) => r.name === 'workout_sets_exercise'), 'the index is back');
      if (round === 1) d.run(`INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES ('ws_50', 'wl_1', 'wex_1', NULL, 'Back squat', 50, 135, 5, '2026-09-02T00:00:00Z')`);
      assert.equal(d.get('SELECT COUNT(*) AS n FROM workout_sets WHERE set_no = 50').n, 1, 'set 50 is allowed now');
      const fresh = openDb(':memory:');
      assert.deepEqual(d.all('PRAGMA table_info(workout_sets)').map((c) => c.name).sort(), fresh.all('PRAGMA table_info(workout_sets)').map((c) => c.name).sort());
      fresh.close(); d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
