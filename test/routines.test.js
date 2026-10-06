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

// Warm-up and cool-down blocks: written once, attached to workouts, shown everywhere the workout is.
let app, base, coach, desk, ava, program, workouts, squat, jog, stretch, token, key;
const MIN = 60000;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = async (path) => (await fetch(base + path, { headers: { 'x-client-token': token } })).json();
const tv = async (method, path, body) => (await fetch(base + path, { method, headers: { 'x-kiosk-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_f', 'Facility', 'facility', 1, ?)`, app.ctx.now());
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), ava.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  jog = (await coach('POST', '/v1/exercises', { name: 'Easy jog', category: 'Conditioning', video_url: 'https://www.youtube.com/watch?v=abc123' })).body;
  stretch = (await coach('POST', '/v1/exercises', { name: 'Hamstring stretch', category: 'Mobility' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Strength block', weeks: 1 })).body;
  for (let d = 1; d <= 2; d++) {
    const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: d, title: `Day ${d}` })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 5, reps: '5' });
  }
  workouts = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts;
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  token = (await coach('GET', `/v1/clients/${ava.id}`)).body.app_link.split('token=')[1];
  const sid = newId('cls'), s = new Date(Date.now() - 10 * MIN).toISOString(), e = new Date(Date.now() + 50 * MIN).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Team lift', 'group', 'loc_f', ?, ?, 10, 'scheduled', ?)`, sid, s, e, s);
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'membership', ?, ?)`, newId('bkg'), sid, ava.id, app.ctx.now(), app.ctx.now());
  await coach('PUT', `/v1/sessions/${sid}/workout`, { workout_id: workouts[0].id });
  key = (await coach('POST', '/v1/kiosks', { location_id: 'loc_f', name: 'Weight room TV' })).body.screen_link.split('#')[1];
});
after(() => app.server.close());

test('a coach writes a block once; every problem is caught before anything is saved; front desk looks only', async () => {
  const bad = await coach('POST', '/v1/routines', { name: 'Dynamic 10', kind: 'warmup', exercises: [{ exercise_id: jog.id, prescription: '3 min' }, { exercise_id: 'ex_nope', prescription: '10' }] });
  assert.equal(bad.status, 404);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM routines').n, 0, 'nothing saved');
  assert.equal((await coach('POST', '/v1/routines', { name: 'Empty', kind: 'warmup', exercises: [] })).status, 400);
  assert.equal((await coach('POST', '/v1/routines', { name: 'Odd', kind: 'middle', exercises: [{ exercise_id: jog.id, prescription: '3 min' }] })).status, 400);
  const warm = await coach('POST', '/v1/routines', { name: 'Dynamic 10', kind: 'warmup', note: 'Move, don\'t rush.', exercises: [{ exercise_id: jog.id, prescription: '3 min', note: 'Easy pace' }, { exercise_id: stretch.id, prescription: '30 sec each side' }] });
  assert.equal(warm.status, 201, JSON.stringify(warm.body));
  assert.deepEqual([warm.body.kind_label, warm.body.exercises.map((x) => [x.name, x.prescription]), warm.body.used_in], ['Warm-up', [['Easy jog', '3 min'], ['Hamstring stretch', '30 sec each side']], 0]);
  assert.equal(warm.body.exercises[0].video_url, 'https://www.youtube.com/watch?v=abc123', 'the demo comes along');
  const cool = (await coach('POST', '/v1/routines', { name: 'Stretch out', kind: 'cooldown', exercises: [{ exercise_id: stretch.id, prescription: '2 × 30 sec' }] })).body;
  assert.deepEqual((await coach('GET', '/v1/routines?kind=cooldown')).body.data.map((r) => r.name), ['Stretch out']);
  assert.equal((await coach('GET', '/v1/routines')).body.data.length, 2);
  const upd = (await coach('PATCH', `/v1/routines/${warm.body.id}`, { name: 'Dynamic 12', exercises: [{ exercise_id: jog.id, prescription: '4 min' }] })).body;
  assert.deepEqual([upd.name, upd.exercises.length, upd.exercises[0].prescription], ['Dynamic 12', 1, '4 min']);
  assert.equal((await coach('PATCH', `/v1/routines/${warm.body.id}`, { kind: 'cooldown' })).status, 400, 'a block keeps its kind');
  assert.equal((await desk('GET', '/v1/routines')).status, 200);
  assert.equal((await desk('POST', '/v1/routines', { name: 'X', kind: 'warmup', exercises: [{ exercise_id: jog.id, prescription: '1' }] })).status, 403);
  assert.equal((await desk('PATCH', `/v1/routines/${cool.id}`, { name: 'Y' })).status, 403);
});

test('attached to a workout, the block follows it: the builder, the app, the screen, a copy; deleting it needs a yes', async () => {
  const [warm, cool] = (await coach('GET', '/v1/routines')).body.data.sort((a, b) => a.kind.localeCompare(b.kind)).reverse();
  assert.deepEqual([warm.kind, cool.kind], ['warmup', 'cooldown']);
  const w = workouts[0];
  assert.equal((await coach('PATCH', `/v1/workouts/${w.id}`, { warmup_id: cool.id })).status, 400, 'a cool-down can\'t be the warm-up');
  assert.equal((await coach('PATCH', `/v1/workouts/${w.id}`, { warmup_id: 'rtn_nope' })).status, 404);
  const set = (await coach('PATCH', `/v1/workouts/${w.id}`, { warmup_id: warm.id, cooldown_id: cool.id })).body;
  assert.deepEqual([set.title, set.warmup.name, set.cooldown.name, set.warmup.exercises.length], ['Day 1', 'Dynamic 12', 'Stretch out', 1], 'the title stays when only the blocks change');
  const prog = (await coach('GET', `/v1/programs/${program.id}`)).body;
  assert.deepEqual([prog.workouts[0].warmup?.name, prog.workouts[1].warmup], ['Dynamic 12', null]);
  // The athlete's app and the weight-room screen.
  const home = await athlete('/app/api/home');
  assert.deepEqual([home.workout.warmup.name, home.workout.warmup.exercises[0].name, home.workout.cooldown.exercises[0].prescription], ['Dynamic 12', 'Easy jog', '2 × 30 sec']);
  const board = (await tv('GET', '/kiosk-api/screen')).sessions[0];
  assert.deepEqual([board.workout.warmup.name, board.workout.cooldown.exercises.map((x) => x.name)], ['Dynamic 12', ['Hamstring stretch']]);
  const live = (await coach('GET', `/v1/sessions/${board.id}/live`)).body.athletes[0];
  assert.deepEqual([live.workout.warmup, live.workout.cooldown], ['Dynamic 12', 'Stretch out'], 'the Live panel names them too');
  // A copy of the workout, and a copy of the program, carry the blocks.
  const copy = (await coach('POST', `/v1/workouts/${w.id}/copy`, { week: 1, day: 3 })).body;
  assert.deepEqual([copy.warmup.id, copy.cooldown.id], [warm.id, cool.id]);
  const dup = (await coach('POST', `/v1/programs/${program.id}/duplicate`, { name: 'Strength block 2' })).body;
  assert.equal(dup.workouts[0].warmup.id, warm.id);
  assert.equal((await coach('GET', `/v1/routines/${warm.id}`)).body.used_in, 4, 'day 1, its copy, and both in the duplicated program');
  // Clearing one end; deleting a used block needs confirm, then the workouts go on without it.
  assert.equal((await coach('PATCH', `/v1/workouts/${w.id}`, { cooldown_id: null })).body.cooldown, null);
  const no = await coach('DELETE', `/v1/routines/${warm.id}`, {});
  assert.deepEqual([no.status, no.body.error.code, no.body.error.details.used_in], [409, 'in_use', 4]);
  const yes = (await coach('DELETE', `/v1/routines/${warm.id}`, { confirm: true })).body;
  assert.deepEqual([yes.deleted, yes.workouts_cleared], [true, 4]);
  assert.equal((await coach('GET', `/v1/programs/${program.id}`)).body.workouts[0].warmup, null);
  assert.equal((await athlete('/app/api/home')).workout.warmup, null);
  assert.equal((await desk('DELETE', `/v1/routines/${cool.id}`, { confirm: true })).status, 403);
});

test('a version 57 database gains the block tables and the workout columns, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v57.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 57');
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_a', 'Old', 1, '2026-01-01T00:00:00Z')`);
    old.exec(`INSERT INTO workouts (id, program_id, week, day, title) VALUES ('wo_a', 'prog_a', 1, 1, 'Day 1')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 69, `round ${round}`);
      assert.equal(d.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('routines', 'routine_exercises')`).n, 2);
      const cols = d.all('PRAGMA table_info(workouts)').map((c) => c.name);
      assert.ok(cols.includes('warmup_id') && cols.includes('cooldown_id'));
      assert.equal(d.get('SELECT warmup_id FROM workouts WHERE id = ?', 'wo_a').warmup_id, null);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
