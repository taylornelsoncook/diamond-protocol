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
import { topReps, hit } from '../src/services/progression.js';

// Progression steps (schema 55): two workouts hitting every set at the top of the range earn a suggestion for that
// athlete alone; the coach approves or dismisses it; approved steps show in the app on top of the plan.
let app, base, coach, desk, owner, ava, token, squat, pushup, workouts = [];
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => { const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
}
const athlete = async (method, path, body) => (await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const home = () => athlete('GET', '/app/api/home');
// Finish a workout with the same reps in every set: squat 5 sets, push-ups 3 sets.
async function finish(w, { squatReps = 5, squatLb = 150, pushReps = 10, pushSets = 3 } = {}) {
  const sq = w.exercises.find((x) => x.exercise_id === squat.id), pu = w.exercises.find((x) => x.exercise_id === pushup.id);
  const sets = [...Array.from({ length: 5 }, (_, i) => ({ workout_exercise_id: sq.id, set_no: i + 1, weight: squatLb, reps: squatReps })), ...Array.from({ length: pushSets }, (_, i) => ({ workout_exercise_id: pu.id, set_no: i + 1, reps: pushReps }))];
  return athlete('POST', `/app/api/workouts/${w.id}/complete`, { request_id: newId('req'), exercise_ids: [sq.id, pu.id], sets });
}

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: 'correct-horse-battery', role: 'front_desk' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev'); owner = await signIn('owner@test.dev');
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, newId('sub'), ava.id, plan.id, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  pushup = (await coach('POST', '/v1/exercises', { name: 'Push-up', category: 'Upper body' })).body;
  const program = (await coach('POST', '/v1/programs', { name: 'Strength block', weeks: 2 })).body;
  for (let d = 1; d <= 14; d++) {
    const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: d > 7 ? 2 : 1, day: d > 7 ? d - 7 : d, title: `Day ${d}` })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 5, reps: '5', load_test: 'squat_1rm', load_pct: 75 });
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: pushup.id, sets: 3, reps: '8-10' });
  }
  workouts = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts;
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Max day', date: '2026-09-01', tests: ['squat_1rm'] })).body;
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: ava.id, test: 'squat_1rm', metric: 'load', value: 200, recorded_at: '2026-09-01T15:00:00.000Z' }] });
  await coach('POST', `/v1/testing-sessions/${day.id}/share`, {});
  token = (await coach('GET', `/v1/clients/${ava.id}`)).body.app_link.split('token=')[1];
});
after(() => app.server.close());

test('the rule itself: the top of a rep range, and a hit means every planned set at or over it', () => {
  assert.deepEqual([topReps('8-10'), topReps('8'), topReps('5/side'), topReps('40 sec'), topReps('max'), topReps('8 to 12')], [10, 8, 5, null, null, 12]);
  const slot = { sets: 3, reps: '8-10' };
  assert.equal(hit([{ reps: 10 }, { reps: 10 }, { reps: 11 }], slot), true);
  assert.equal(hit([{ reps: 10 }, { reps: 9 }, { reps: 10 }], slot), false, 'one set short of the top');
  assert.equal(hit([{ reps: 10 }, { reps: 10 }], slot), false, 'a set missing');
  assert.equal(hit([{ reps: 10 }, { reps: 10 }, { reps: 10 }], { sets: 3, reps: '40 sec' }), false, 'time isn\'t counted');
});

test('two hits in a row suggest a step: pounds where a weight is lifted, a rep a set otherwise; the coach approves or waits', async () => {
  const first = await finish(workouts[0]);
  assert.deepEqual(first.finished.progressions, [], 'one good workout isn\'t enough');
  const second = await finish(workouts[1], { pushReps: 9 });
  assert.deepEqual(second.finished.progressions.map((p) => [p.exercise_name, p.text, p.status]), [['Back squat', '+10 lb', 'suggested']], 'the squat earned it; push-ups missed the top');
  const third = await finish(workouts[2]);
  assert.deepEqual(third.finished.progressions, [], 'the miss broke the push-ups\' run; the squat already has one open');
  const fourth = await finish(workouts[3]);
  assert.deepEqual(fourth.finished.progressions.map((p) => [p.exercise_name, p.text]), [['Push-up', '+1 rep a set']], 'two hits in a row now');
  const open = (await coach('GET', '/v1/progressions?status=suggested')).body.data;
  assert.deepEqual(open.map((p) => [p.client_name, p.exercise_name, p.kind, p.amount]).sort(), [['Ava Lopez', 'Back squat', 'weight', 10], ['Ava Lopez', 'Push-up', 'reps', 1]]);
  assert.deepEqual(open.find((p) => p.kind === 'weight').basis.sets.slice(0, 2), [{ weight: 150, reps: 5 }, { weight: 150, reps: 5 }]);
  const today = (await coach('GET', '/v1/dashboard')).body.attention.find((a) => a.kind === 'progressions');
  assert.deepEqual([today.count, today.items[0].name, today.items[0].text], [2, 'Ava Lopez', '+10 lb']);
  assert.equal((await desk('GET', '/v1/progressions')).status, 403, 'front desk has no part in programming');
  assert.equal((await desk('GET', '/v1/dashboard')).body.attention.some((a) => a.kind === 'progressions'), false);
  // Approve the squat, hold the push-ups.
  const sq = open.find((p) => p.kind === 'weight'), pu = open.find((p) => p.kind === 'reps');
  const ok = await coach('POST', `/v1/progressions/${sq.id}/approve`);
  assert.deepEqual([ok.status, ok.body.status, ok.body.decided_by], [200, 'approved', 'Riley']);
  assert.equal((await coach('POST', `/v1/progressions/${pu.id}/dismiss`)).body.status, 'dismissed');
  assert.equal((await coach('POST', `/v1/progressions/${sq.id}/approve`)).status, 409, 'decided once');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'progression.approved'`).n, 1);
  // The app: the squat's weight from the max carries the step; push-ups are as written.
  const h = await home();
  const s = h.workout.exercises.find((x) => x.exercise_id === squat.id), p = h.workout.exercises.find((x) => x.exercise_id === pushup.id);
  assert.deepEqual([s.load.lb, s.progression.weight_lb, s.progression.text, s.target_sets], [160, 10, '+10 lb', 5]);
  assert.match(s.load.text, /^160 lb .*\+10 lb from your progression/);
  assert.deepEqual([p.progression, p.target_reps, p.target_sets], [null, 8, 3]);
  // A new suggestion needs two hits after the decision: the next workout alone earns nothing, the one after does.
  const fifth = await finish(workouts[4], { squatLb: 160 });
  assert.deepEqual(fifth.finished.progressions, []);
  const sixth = await finish(workouts[5], { squatLb: 160 });
  assert.deepEqual(sixth.finished.progressions.map((p) => [p.exercise_name, p.text, p.status]).sort(), [['Back squat', '+10 lb', 'suggested'], ['Push-up', '+1 rep a set', 'suggested']]);
  // An approved step raises the bar: with +1 rep approved on 8-10, only 11s count as hits from now on.
  const pu2 = (await coach('GET', `/v1/progressions?status=suggested&client_id=${ava.id}`)).body.data.find((p) => p.kind === 'reps');
  await coach('POST', `/v1/progressions/${pu2.id}/approve`);
  assert.equal((await home()).workout.exercises.find((x) => x.exercise_id === pushup.id).target_reps, 9);
  for (const i of [6, 7]) assert.deepEqual((await finish(workouts[i], { squatLb: 160 })).finished.progressions, [], 'the old top no longer earns a step');
  await finish(workouts[8], { squatLb: 160, pushReps: 11 });
  const tenth = await finish(workouts[9], { squatLb: 160, pushReps: 11 });
  assert.deepEqual(tenth.finished.progressions.map((p) => [p.exercise_name, p.text]), [['Push-up', '+1 rep a set']], 'reaching the new bar twice does');
  // Undo of an approved step is a decision too: the next suggestion still needs two hits after it.
  const pu3 = (await coach('GET', `/v1/progressions?status=suggested&client_id=${ava.id}`)).body.data.find((p) => p.kind === 'reps');
  await coach('POST', `/v1/progressions/${pu3.id}/approve`);
  const repSteps = (await coach('GET', `/v1/progressions?status=approved&client_id=${ava.id}`)).body.data.filter((p) => p.kind === 'reps');
  assert.equal(repSteps.length, 2);
  assert.equal((await coach('DELETE', `/v1/progressions/${pu3.id}`)).body.deleted, true);
  assert.equal((await coach('GET', `/v1/progressions?status=removed&client_id=${ava.id}`)).body.data.length, 1, 'kept as removed');
  assert.equal((await home()).workout.exercises.find((x) => x.exercise_id === pushup.id).target_reps, 9, 'back to one step');
  assert.deepEqual((await finish(workouts[10], { squatLb: 160, pushReps: 11 })).finished.progressions, [], 'one hit after the undo isn\'t enough');
  assert.deepEqual((await finish(workouts[11], { squatLb: 160, pushReps: 11 })).finished.progressions.map((p) => p.exercise_name), ['Push-up']);
});

test('by hand and on its own: a coach adds or takes back a step; auto mode approves at once; the export lists them; front desk can\'t', async () => {
  const add = await coach('POST', `/v1/clients/${ava.id}/progressions`, { exercise_id: pushup.id, kind: 'sets', amount: 1 });
  assert.equal(add.status, 201, JSON.stringify(add.body)); assert.deepEqual([add.body.status, add.body.text, add.body.decided_by], ['approved', '+1 set', 'Riley']);
  let h = await home();
  let p = h.workout.exercises.find((x) => x.exercise_id === pushup.id);
  assert.deepEqual([p.target_sets, p.progression.text], [4, '+1 rep a set, +1 set']);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/progressions`, { exercise_id: pushup.id, kind: 'weight', amount: 0 })).status, 400);
  assert.equal((await desk('POST', `/v1/clients/${ava.id}/progressions`, { exercise_id: pushup.id, kind: 'sets', amount: 1 })).status, 403);
  assert.equal((await coach('DELETE', `/v1/progressions/${add.body.id}`)).body.deleted, true);
  h = await home(); p = h.workout.exercises.find((x) => x.exercise_id === pushup.id);
  assert.equal(p.target_sets, 3, 'taken back out');
  // Auto mode: the open squat suggestion is decided by the coach as usual, but new ones apply at once.
  assert.equal((await coach('PATCH', '/v1/engagement/settings', { progression_mode: 'auto', progression_lower_lb: 15 })).body.progression_mode, 'auto');
  const openSq = (await coach('GET', `/v1/progressions?status=suggested&client_id=${ava.id}`)).body.data.find((x) => x.kind === 'weight');
  await coach('POST', `/v1/progressions/${openSq.id}/dismiss`);
  const applied = (await coach('GET', `/v1/progressions?status=approved&client_id=${ava.id}`)).body.data;
  assert.equal(applied.length, 2, 'the squat step and the push-up step still in force; the removed one and the undone one by hand are not');
  assert.equal((await coach('PATCH', '/v1/engagement/settings', { progression_mode: 'sometimes' })).status, 400);
  const exp = (await signIn('coach@test.dev'))('GET', `/v1/families/${ava.family.id}/export`);
  assert.equal((await exp).status, 403, 'the export is the owner\'s');
  const e = (await owner('GET', `/v1/families/${ava.family.id}/export`)).body;
  assert.ok(e.athletes[0].progression_steps.length >= 2);
  assert.deepEqual(Object.keys(e.athletes[0].progression_steps[0]).sort(), ['amount', 'created_at', 'decided_at', 'decided_by', 'exercise', 'kind', 'status']);
});

test('a version 54 database gains the progressions table, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v54.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 54');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 62, `round ${round}`);
      assert.equal(d.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'progressions'`).n, 1);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
