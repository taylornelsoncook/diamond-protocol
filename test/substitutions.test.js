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

// Exercise substitutions: the swaps a coach lists for an exercise, and an athlete picking one in the app.
let app, base, coach, desk, ava, program, workouts, squat, goblet, split, plank, token;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), ava.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  goblet = (await coach('POST', '/v1/exercises', { name: 'Goblet squat', category: 'Lower body' })).body;
  split = (await coach('POST', '/v1/exercises', { name: 'Split squat', category: 'Lower body' })).body;
  plank = (await coach('POST', '/v1/exercises', { name: 'Front plank', category: 'Core' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Strength block', weeks: 1 })).body;
  for (let d = 1; d <= 2; d++) {
    const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: d, title: `Day ${d}` })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 5, reps: '5', load_test: 'squat_1rm', load_pct: 75 });
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: plank.id, sets: 3, reps: '40 sec' });
  }
  workouts = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts;
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  token = (await coach('GET', `/v1/clients/${ava.id}`)).body.app_link.split('token=')[1];
});
after(() => app.server.close());

test('a coach lists the swaps for an exercise; front desk looks but does not change the list', async () => {
  const a1 = await coach('POST', `/v1/exercises/${squat.id}/alternatives`, { exercise_id: goblet.id, tag: 'no_barbell', note: 'Hold a dumbbell at the chest' });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.deepEqual([a1.body.name, a1.body.tag, a1.body.tag_label, a1.body.note], ['Goblet squat', 'no_barbell', 'No barbell', 'Hold a dumbbell at the chest']);
  assert.equal((await coach('POST', `/v1/exercises/${squat.id}/alternatives`, { exercise_id: split.id, tag: 'knee' })).status, 201);
  const again = (await coach('POST', `/v1/exercises/${squat.id}/alternatives`, { exercise_id: goblet.id, tag: 'at_home' })).body;
  assert.deepEqual([again.id, again.tag], [a1.body.id, 'at_home'], 'listing it again changes the tag, never doubles it');
  const list = (await coach('GET', `/v1/exercises/${squat.id}/alternatives`)).body;
  assert.deepEqual(list.data.map((a) => [a.name, a.tag]), [['Goblet squat', 'at_home'], ['Split squat', 'knee']]);
  assert.equal(Object.keys(list.tags).length, 9);
  assert.equal((await coach('POST', `/v1/exercises/${squat.id}/alternatives`, { exercise_id: squat.id })).status, 400, 'not itself');
  assert.equal((await coach('POST', `/v1/exercises/${squat.id}/alternatives`, { exercise_id: goblet.id, tag: 'whenever' })).status, 400);
  assert.equal((await coach('POST', `/v1/exercises/ex_nope/alternatives`, { exercise_id: goblet.id })).status, 404);
  assert.equal((await desk('GET', `/v1/exercises/${squat.id}/alternatives`)).status, 200);
  assert.equal((await desk('POST', `/v1/exercises/${squat.id}/alternatives`, { exercise_id: goblet.id })).status, 403);
  assert.equal((await desk('DELETE', `/v1/exercise-alternatives/${a1.body.id}`)).status, 403);
});

test('the athlete picks a swap in the app for this workout only; the log follows it; a coach\'s swap is left alone', async () => {
  let home = (await athlete('GET', '/app/api/home')).body;
  const x = home.workout.exercises[0];
  assert.deepEqual(x.alternatives.map((a) => [a.name, a.tag_label]), [['Goblet squat', 'At home'], ['Split squat', 'Knee']]);
  assert.deepEqual(home.workout.exercises[1].alternatives, [], 'the plank has none listed');
  const goblets = x.alternatives.find((a) => a.name === 'Goblet squat');
  const pick = await athlete('POST', '/app/api/swaps', { workout_exercise_id: x.id, alternative_id: goblets.id });
  assert.equal(pick.status, 201, JSON.stringify(pick.body));
  assert.deepEqual([pick.body.exercise_name, pick.body.instead_of, pick.body.reason], ['Goblet squat', 'Back squat', 'At home']);
  home = (await athlete('GET', '/app/api/home')).body;
  const y = home.workout.exercises[0];
  assert.deepEqual([y.name, y.exercise_id, y.load, y.swapped.from, y.swapped.by, y.swapped.by_kind, y.swapped.reason], ['Goblet squat', goblet.id, null, 'Back squat', 'Ava', 'athlete', 'At home']);
  assert.equal(home.workout.exercises[1].swapped, undefined);
  assert.equal((await athlete('GET', '/app/api/home')).body.workout.exercises[0].alternatives.length, 2, 'the list stays (for a change of mind)');
  // Not for a workout outside their program, not something the coach didn't list, not a made-up slot.
  assert.equal((await athlete('POST', '/app/api/swaps', { workout_exercise_id: x.id, alternative_id: 'alt_nope' })).status, 400);
  assert.equal((await athlete('POST', '/app/api/swaps', { workout_exercise_id: 'wex_nope', alternative_id: goblets.id })).status, 404);
  const other = (await coach('POST', '/v1/programs', { name: 'Other', weeks: 1 })).body;
  const ow = (await coach('POST', `/v1/programs/${other.id}/workouts`, { week: 1, day: 1, title: 'Elsewhere' })).body;
  const oslot = (await coach('POST', `/v1/workouts/${ow.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' })).body.exercises[0];
  assert.equal((await athlete('POST', '/app/api/swaps', { workout_exercise_id: oslot.id, alternative_id: goblets.id })).status, 409, 'not their program');
  // Change of mind: back to the plan, then pick the other one.
  assert.equal((await athlete('DELETE', `/app/api/swaps/${y.swapped.id}`)).body.deleted, true);
  assert.equal((await athlete('GET', '/app/api/home')).body.workout.exercises[0].name, 'Back squat');
  const splits = x.alternatives.find((a) => a.name === 'Split squat');
  const pick2 = (await athlete('POST', '/app/api/swaps', { workout_exercise_id: x.id, alternative_id: splits.id })).body;
  // The coach's live view and the log see the pick like any swap.
  assert.equal(app.ctx.db.get('SELECT by_kind FROM exercise_swaps WHERE id = ?', pick2.id).by_kind, 'athlete');
  const sets = [1, 2, 3, 4, 5].map((n) => ({ workout_exercise_id: x.id, set_no: n, weight: 30, reps: 5 }));
  const fin = (await athlete('POST', `/app/api/workouts/${workouts[0].id}/complete`, { request_id: newId('req'), exercise_ids: [x.id], sets })).body;
  assert.deepEqual(app.ctx.db.all('SELECT DISTINCT exercise_name FROM workout_sets WHERE workout_log_id = ?', fin.id), [{ exercise_name: 'Split squat' }]);
  assert.equal((await athlete('DELETE', `/app/api/swaps/${pick2.id}`)).status, 409, 'logged: too late to change');
  // Day 2: the coach swaps first; the athlete can't override it or undo it.
  const day2 = workouts[1].exercises[0];
  const cs = (await coach('POST', `/v1/clients/${ava.id}/swaps`, { workout_exercise_id: day2.id, exercise_id: plank.id, reason: 'Knee' })).body;
  assert.equal((await athlete('POST', '/app/api/swaps', { workout_exercise_id: day2.id, alternative_id: goblets.id })).status, 409);
  assert.equal((await athlete('DELETE', `/app/api/swaps/${cs.id}`)).status, 409);
  const h2 = (await athlete('GET', '/app/api/home')).body.workout.exercises[0];
  assert.deepEqual([h2.name, h2.swapped.by_kind, h2.swapped.by], ['Front plank', 'coach', 'Riley']);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'exercise.swapped' AND json_extract(data, '$.by_kind') = 'athlete'`).n, 2);
});

test('a version 56 database gains the alternatives table and the by_kind column, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v56.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 56');
    old.exec(`INSERT INTO exercises (id, name, created_at) VALUES ('ex_a', 'Back squat', '2026-01-01T00:00:00Z'), ('ex_b', 'Goblet squat', '2026-01-01T00:00:00Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 59, `round ${round}`);
      assert.equal(d.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'exercise_alternatives'`).n, 1);
      assert.ok(d.all('PRAGMA table_info(exercise_swaps)').some((c) => c.name === 'by_kind'));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
