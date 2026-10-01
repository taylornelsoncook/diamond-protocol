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

// The mesocycle planner (schema 50): the whole plan in one view, phases as bands across weeks, and a progression that
// builds a run of weeks from one week with sets, percents or RPE stepping each week.
let app, base, coach, desk, squat, rdl, plank, p, w1;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const plan = () => coach('GET', `/v1/programs/${p.id}/plan`).then((r) => r.body);
const weekSlots = async (n) => (await coach('GET', `/v1/programs/${p.id}`)).body.workouts.filter((w) => w.week === n).flatMap((w) => w.exercises);

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  rdl = (await coach('POST', '/v1/exercises', { name: 'Romanian deadlift' })).body;
  plank = (await coach('POST', '/v1/exercises', { name: 'Plank' })).body;
  p = (await coach('POST', '/v1/programs', { name: 'Winter block', weeks: 6 })).body;
  w1 = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
  await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5', load_test: 'squat_1rm', load_pct: 70, target_rpe: 7, group_label: 'A' });
  await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: rdl.id, sets: 3, reps: '8', target_rpe: 7.5, group_label: 'A' });
  await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: plank.id, prescription: 'Hold as long as you can' });
  const w2 = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 3, title: 'Upper' })).body;
  await coach('POST', `/v1/workouts/${w2.id}/exercises`, { exercise_id: plank.id, sets: 4, reps: '30 sec' });
});
after(() => app.server.close());

test('the plan: weeks down, days across, each week\'s sets and average intensity; front desk can look', async () => {
  const d = await plan();
  assert.deepEqual([d.program.weeks, d.days, d.max_sets, d.phases], [6, 3, 11, []]);
  const wk1 = d.weeks[0];
  assert.deepEqual(wk1.workouts.map((w) => [w.day, w.title, w.exercises, w.sets, w.groups, w.avg_pct, w.avg_rpe]), [[1, 'Lower', 3, 7, 1, 70, 7.3], [3, 'Upper', 1, 4, 0, null, null]], 'an exercise with no set count is one set');
  assert.deepEqual([wk1.sets, wk1.exercises, wk1.avg_pct, wk1.avg_rpe], [11, 4, 70, 7.3]);
  assert.deepEqual(d.weeks[1], { week: 2, phase_id: null, workouts: [], sets: 0, exercises: 0, avg_pct: null, avg_rpe: null });
  assert.equal((await desk('GET', `/v1/programs/${p.id}/plan`)).status, 200, 'front desk can look');
  assert.equal((await desk('POST', `/v1/programs/${p.id}/phases`, { kind: 'base', start_week: 1, end_week: 2 })).status, 403, 'but not plan');
});

test('phases are bands that don\'t overlap, stay within the program and shrink with it', async () => {
  const base_ = await coach('POST', `/v1/programs/${p.id}/phases`, { kind: 'base', start_week: 1, end_week: 3, note: 'Learn the lifts' });
  assert.equal(base_.status, 201, JSON.stringify(base_.body));
  assert.deepEqual([base_.body.name, base_.body.kind, base_.body.start_week, base_.body.end_week], ['Base', 'base', 1, 3], 'the name defaults to the kind');
  const bad = async (body, re) => { const r = await coach('POST', `/v1/programs/${p.id}/phases`, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error.message, re); };
  await bad({ kind: 'build', start_week: 3, end_week: 5 }, /overlap Base \(weeks 1 to 3\)/);
  await bad({ kind: 'build', start_week: 5, end_week: 4 }, /can't be before its first/);
  await bad({ kind: 'build', start_week: 4, end_week: 7 }, /program is 6 weeks long/);
  await bad({ kind: 'taper', start_week: 4, end_week: 5 }, /kind must be one of/);
  await bad({ start_week: 4 }, /Choose what kind of phase/);
  const build = (await coach('POST', `/v1/programs/${p.id}/phases`, { kind: 'build', name: 'Strength block', start_week: 4, end_week: 5 })).body;
  const deload = (await coach('POST', `/v1/programs/${p.id}/phases`, { kind: 'deload', start_week: 6 })).body;
  assert.equal(deload.end_week, 6, 'one week when no end is given');
  let d = await plan();
  assert.deepEqual(d.weeks.map((w) => w.phase_id), [base_.body.id, base_.body.id, base_.body.id, build.id, build.id, deload.id]);
  // Changing one to overlap another is refused; moving it is fine.
  const clash = await coach('PATCH', `/v1/phases/${build.id}`, { start_week: 3 });
  assert.equal(clash.status, 400); assert.match(clash.body.error.message, /overlap Base/);
  assert.equal((await coach('PATCH', `/v1/phases/${base_.body.id}`, { end_week: 2, name: 'Foundations' })).body.name, 'Foundations');
  assert.equal((await coach('PATCH', `/v1/phases/${build.id}`, { start_week: 3 })).status, 200);
  // The program shrinks: the deload week goes, the build is cut back.
  await coach('PATCH', `/v1/programs/${p.id}`, { weeks: 4 });
  d = await plan();
  assert.deepEqual(d.phases.map((f) => [f.name, f.start_week, f.end_week]), [['Foundations', 1, 2], ['Strength block', 3, 4]]);
  await coach('PATCH', `/v1/programs/${p.id}`, { weeks: 6 });
  assert.equal((await coach('DELETE', `/v1/phases/${build.id}`)).body.deleted, true);
  assert.equal((await coach('DELETE', `/v1/phases/${build.id}`)).status, 404);
  // A copy of the program takes its phases, within the weeks kept.
  const copy = (await coach('POST', '/v1/programs', { name: 'Winter block, short', copy_from: p.id, weeks: 1 })).body;
  assert.deepEqual((await coach('GET', `/v1/programs/${copy.id}/plan`)).body.phases.map((f) => [f.name, f.start_week, f.end_week]), [['Foundations', 1, 1]]);
});

test('progression builds a run of weeks from one, stepping sets, percent and RPE within the limits', async () => {
  const r = await coach('POST', `/v1/programs/${p.id}/progress`, { from: 1, to: 2, through: 4, sets_step: 1, pct_step: 5, rpe_step: 0.5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.progressed, { from: 1, to: 2, through: 4, sets_step: 1, pct_step: 5, rpe_step: 0.5 });
  const wk3 = await weekSlots(3);
  assert.deepEqual(wk3.map((x) => [x.name, x.sets, x.load_pct, x.target_rpe, x.prescription, x.group_tag]),
    [['Back squat', 5, 80, 8, '5 × 5', 'A1'], ['Romanian deadlift', 5, null, 8.5, '5 × 8', 'A2'], ['Plank', null, null, null, 'Hold as long as you can', null], ['Plank', 6, null, null, '6 × 30 sec', null]],
    'two steps by week 3; fields an exercise lacks are left alone; groups come along');
  const wk4 = await weekSlots(4);
  assert.deepEqual(wk4.slice(0, 2).map((x) => [x.sets, x.load_pct, x.target_rpe]), [[6, 85, 8.5], [6, null, 9]]);
  // Steps stay within the limits: a big drop for a deload bottoms out at the minimums.
  const deload = await coach('POST', `/v1/programs/${p.id}/progress`, { from: 4, to: 5, sets_step: -3, pct_step: -20, rpe_step: -2 });
  assert.equal(deload.status, 200, JSON.stringify(deload.body));
  assert.deepEqual((await weekSlots(5)).slice(0, 2).map((x) => [x.sets, x.load_pct, x.target_rpe]), [[3, 65, 6.5], [3, null, 7]]);
  const top = await coach('POST', `/v1/programs/${p.id}/progress`, { from: 4, to: 6, sets_step: 3, pct_step: 20, rpe_step: 2 });
  assert.equal(top.status, 200);
  assert.deepEqual((await weekSlots(6)).slice(0, 2).map((x) => [x.sets, x.load_pct, x.target_rpe]), [[12, 110, 10], [12, null, 10]], 'never past 12 sets, 110% or RPE 10');
  // Weeks with workouts are replaced only on purpose, like copying a week; no change at all is refused.
  const taken = await coach('POST', `/v1/programs/${p.id}/progress`, { from: 1, to: 2, through: 3, pct_step: 5 });
  assert.equal(taken.status, 409); assert.equal(taken.body.error.code, 'replace_needed');
  assert.equal((await coach('POST', `/v1/programs/${p.id}/progress`, { from: 1, to: 2, through: 3, pct_step: 5, replace: true })).status, 200);
  const none = await coach('POST', `/v1/programs/${p.id}/progress`, { from: 1, to: 2, replace: true });
  assert.equal(none.status, 400); assert.match(none.body.error.message, /at least one change/);
  const odd = await coach('POST', `/v1/programs/${p.id}/progress`, { from: 1, to: 2, rpe_step: 0.3, replace: true });
  assert.equal(odd.status, 400); assert.match(odd.body.error.message, /rpe_step must be a number in halves from -2 to 2/);
  const back = await coach('POST', `/v1/programs/${p.id}/progress`, { from: 4, to: 2, pct_step: 5, replace: true });
  assert.equal(back.status, 400); assert.match(back.body.error.message, /Build forward from week 4/);
  assert.deepEqual((await coach('POST', `/v1/programs/${p.id}/progress`, { from: 1, to: 2, through: '', pct_step: 5, replace: true })).body.progressed, { from: 1, to: 2, through: 2, sets_step: 0, pct_step: 5, rpe_step: 0 }, 'an empty through means one week');
  const empty = await coach('POST', `/v1/programs/${p.id}/progress`, { from: 7, to: 8, pct_step: 5 });
  assert.equal(empty.status, 400); assert.match(empty.body.error.message, /Week 7 has no workouts to build from/);
  assert.equal((await desk('POST', `/v1/programs/${p.id}/progress`, { from: 1, to: 2, pct_step: 5, replace: true })).status, 403);
  const d = await plan();
  assert.deepEqual(d.weeks.map((w) => w.sets), [11, 11, 11, 20, 11, 37], 'the volume bar follows the steps: weeks 2 and 3 were rebuilt from week 1 with only a percent step, week 6 is two steps up from week 4');
});

test('a version 49 database gains the phases table, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v49.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 49');
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_1', 'Old', 4, '2026-09-01T00:00:00Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 65, `round ${round}`);
      assert.deepEqual(d.all('PRAGMA table_info(program_phases)').map((c) => c.name), ['id', 'program_id', 'name', 'kind', 'start_week', 'end_week', 'note', 'created_at']);
      d.run(`INSERT OR IGNORE INTO program_phases (id, program_id, name, kind, start_week, end_week, created_at) VALUES ('ph_1', 'prog_1', 'Base', 'base', 1, 2, '2026-09-01T00:00:00Z')`);
      assert.equal(d.get('SELECT COUNT(*) AS n FROM program_phases').n, 1);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
