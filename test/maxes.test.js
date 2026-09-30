// Athlete maxes (owner decision): athletes, parents and coaches enter a max for the lifts a program loads from; with
// nothing on file the weight comes from an estimate out of logged sets; every max lands on the profile with its date and
// source, the family sees a typed one at once, and the finish screen offers to save a new estimate in one tap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';
import { estimatedMax, liftExercises } from '../src/services/maxes.js';

let app, base, coach, owner, desk, maya, token, squat, bench, program, workout, slotSquat, slotBench, parentCookie;
const PW = 'correct-horse-battery';
const NOW = '2026-10-07T15:00:00.000Z';
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const parent = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { cookie: parentCookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const squatLift = (d) => d.lifts.find((l) => l.test === 'squat_1rm');
const homeSquat = async () => (await athlete('GET', '/app/api/home')).body.workout.exercises.find((x) => x.id === slotSquat);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); owner = await staff('owner@test.dev'); desk = await staff('desk@test.dev');
  maya = (await coach('POST', '/v1/clients', { name: 'Maya Okafor', birth_date: '2011-04-02', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    newId('sub'), maya.id, plan.id, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', NOW, NOW);
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', maya.id).access_token;
  squat = (await coach('POST', '/v1/exercises', { name: 'Back Squat (barbell)' })).body;    // brackets and case don't matter
  bench = (await coach('POST', '/v1/exercises', { name: 'Bench press' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 1 })).body;
  workout = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
  await coach('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5', load_test: 'squat_1rm', load_pct: 75 });
  const w = (await coach('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: bench.id, sets: 3, reps: '8', load_test: 'bench_1rm', load_pct: 70 })).body;   // answers the whole workout
  slotSquat = w.exercises.find((x) => x.exercise_id === squat.id).id; slotBench = w.exercises.find((x) => x.exercise_id === bench.id).id;
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id, start_date: '2026-10-05', training_days: [1, 3, 5] })).status, 201);
  // The parent signs in to the portal.
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com' }) })).json()).dev_code;
  const v = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com', code }) });
  parentCookie = v.headers.get('set-cookie').split(';')[0];
});
after(() => app.server.close());

test('with nothing on file the weight is missing; logged sets give an estimate the program uses, and say so', async () => {
  assert.deepEqual(liftExercises(app.ctx, 'squat_1rm'), [squat.id], 'the library name counts as the lift');
  assert.deepEqual(liftExercises(app.ctx, 'power_clean_1rm'), []);
  let sq = await homeSquat();
  assert.equal(sq.load.missing, true);
  assert.match(sq.load.text, /Enter your max on the Performance tab, or log a few sets/);
  let d = (await athlete('GET', '/app/api/maxes')).body;
  assert.equal(d.lifts.length, 3);
  assert.deepEqual([squatLift(d).using, squatLift(d).value, squatLift(d).estimate], [null, null, null]);
  // A week ago: 185 × 5 and 195 × 3 → Epley 215.8 and 214.5 → 215 lb.
  app.ctx.now = () => '2026-09-30T15:00:00.000Z';
  const fin = await athlete('POST', `/app/api/workouts/${workout.id}/complete`, { request_id: 'r-1', sets: [{ workout_exercise_id: slotSquat, set_no: 1, weight: 185, reps: 5 }, { workout_exercise_id: slotSquat, set_no: 2, weight: 195, reps: 3 }, { workout_exercise_id: slotBench, set_no: 1, weight: 95, reps: 8 }] });
  assert.equal(fin.status, 201, JSON.stringify(fin.body));
  assert.deepEqual(fin.body.finished.new_maxes.map((m) => [m.test, m.value, m.on_file]), [['squat_1rm', 215, null], ['bench_1rm', 120, null]], 'the done screen offers to save them');
  app.ctx.now = () => NOW;
  const est = estimatedMax(app.ctx, maya.id, 'squat_1rm');
  assert.deepEqual([est.value, est.exact, est.from.weight, est.from.reps], [215, 216, 185, 5]);
  // The program's weight comes from the estimate (the log was the only workout, so the next one is... the same program has one workout: read the slot through the calendar).
  const open = (await athlete('GET', `/app/api/workouts/${workout.id}`));
  assert.equal(open.status, 409, 'logged already; the weights are checked through the coach\'s live view instead');
  d = (await athlete('GET', '/app/api/maxes')).body;
  const s = squatLift(d);
  assert.deepEqual([s.using, s.value, s.recorded, s.suggest], ['estimate', 215, null, 215]);
  assert.equal(s.trend.length, 1);
  assert.equal(s.trend[0].value, 216);
  assert.deepEqual(d.exercises.map((x) => [x.name, x.best]), [['Back Squat (barbell)', 216], ['Bench press', 120]]);
});

test('the athlete enters a max: saved on the profile, used for the weights, seen by the family and the coach', async () => {
  const bad = await athlete('POST', '/app/api/maxes', { test: 'deadlift_1rm', value: 300 });
  assert.equal(bad.status, 400);
  assert.equal((await athlete('POST', '/app/api/maxes', { test: 'squat_1rm', value: -5 })).status, 400);
  assert.equal((await athlete('POST', '/app/api/maxes', { test: 'squat_1rm', value: 230, date: '2026-10-08' })).status, 400, 'no future dates');
  assert.equal((await athlete('POST', '/app/api/maxes', { test: 'squat_1rm', value: 5000 })).status, 400, 'not a possible value');
  const ok = await athlete('POST', '/app/api/maxes', { test: 'squat_1rm', value: 230, date: '2026-10-06', note: 'Heavy single at practice' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.saved.value, ok.body.saved.date, ok.body.saved.first], [230, '2026-10-06', true]);
  const s = squatLift(ok.body);
  assert.deepEqual([s.using, s.value, s.recorded.value, s.recorded.source, s.recorded.own, s.suggest], ['recorded', 230, 230, 'athlete', true, null]);
  assert.equal(s.estimate.value, 215, 'the estimate still shows beside it');
  // The plan's weight: 75% of 230 = 172.5 → 175 lb, no longer estimated. (A second assignment start gives a fresh, unlogged copy to read.)
  assert.equal((await coach('DELETE', `/v1/programs/${program.id}/clients/${maya.id}`)).status, 200);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id, start_date: '2026-10-07', training_days: [3] })).status, 201);
  const sq = await homeSquat();
  assert.deepEqual([sq.load.lb, sq.load.max_lb, sq.load.estimated], [175, 230, false]);
  assert.match(sq.load.text, /175 lb \(75% of your 230 lb back squat max\)/);
  // The family sees it at once, unlike an unshared testing day's result.
  const perf = (await parent('GET', `/portal/api/athletes/${maya.id}/maxes`)).body;
  assert.equal(squatLift(perf).recorded.value, 230);
  const engage = (await athlete('GET', '/app/api/engage')).body;
  assert.ok(engage.performance.tests.some((t) => t.test === 'squat_1rm' && t.best === 230), 'the Performance tab lists it like a test result');
  // The coach sees the source; front desk may look, not enter.
  const mine = (await coach('GET', `/v1/clients/${maya.id}/maxes`)).body;
  assert.deepEqual([squatLift(mine).recorded.source, squatLift(mine).recorded.source_text], ['athlete', 'entered in the app']);
  assert.equal((await desk('GET', `/v1/clients/${maya.id}/maxes`)).status, 200);
  assert.equal((await desk('POST', `/v1/clients/${maya.id}/maxes`, { test: 'squat_1rm', value: 240 })).status, 403);
});

test('a parent and a coach enter maxes too; kilograms are converted; a typed max can be taken back, a testing day\'s can\'t', async () => {
  const p = await parent('POST', `/portal/api/athletes/${maya.id}/maxes`, { test: 'bench_1rm', value: 60, unit: 'kg' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const bl = p.body.lifts.find((l) => l.test === 'bench_1rm');
  assert.deepEqual([Math.round(bl.recorded.value * 10) / 10, bl.recorded.source, bl.recorded.own], [132.3, 'parent', true]);
  const c = await coach('POST', `/v1/clients/${maya.id}/maxes`, { test: 'power_clean_1rm', value: 155 });
  assert.equal(c.status, 201);
  const cl = c.body.lifts.find((l) => l.test === 'power_clean_1rm');
  assert.deepEqual([cl.recorded.value, cl.recorded.source_text, cl.recorded.own], [155, 'entered by a coach', false]);
  // Someone else's family can't reach Maya.
  const other = (await coach('POST', '/v1/clients', { name: 'Zed Solo', parent: { name: 'Pat Solo', email: 'pat@example.com' } })).body;
  assert.equal((await parent('POST', `/portal/api/athletes/${other.id}/maxes`, { test: 'bench_1rm', value: 100 })).status, 404);
  // The athlete takes back their own; a testing day's result is not theirs to remove.
  const d = (await athlete('GET', '/app/api/maxes')).body;
  const own = squatLift(d).recorded.id;
  assert.equal((await athlete('DELETE', `/app/api/maxes/${own}`)).status, 200);
  assert.equal(squatLift((await athlete('GET', '/app/api/maxes')).body).using, 'estimate', 'back to the estimate');
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Fall testing', date: '2026-10-01', test_keys: ['squat_1rm'] })).body;
  const res = (await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: maya.id, test: 'squat_1rm', value: 240, recorded_at: '2026-10-01T16:00:00Z' }] })).body;
  assert.equal(res.created, 1, JSON.stringify(res));
  const hidden = squatLift((await athlete('GET', '/app/api/maxes')).body);
  assert.equal(hidden.recorded, null, 'an unshared testing day stays hidden from the family');
  assert.equal(squatLift((await coach('GET', `/v1/clients/${maya.id}/maxes`)).body).recorded.value, 240, 'the coach sees it');
  assert.equal((await athlete('DELETE', `/app/api/maxes/${res.results[0].id}`)).status, 400);
  assert.equal((await coach('DELETE', `/v1/clients/${maya.id}/maxes/${res.results[0].id}`)).status, 400, 'testing-day results are removed from Testing');
  assert.equal((await coach('DELETE', `/v1/clients/${maya.id}/maxes/${cl.recorded.id}`)).status, 200, 'a coach removes a typed one');
});

test('a big jump in the estimate suggests saving the new max', async () => {
  await athlete('POST', '/app/api/maxes', { test: 'squat_1rm', value: 200 });
  app.ctx.now = () => '2026-10-07T17:00:00.000Z';
  const d0 = squatLift((await athlete('GET', '/app/api/maxes')).body);
  assert.deepEqual([d0.value, d0.suggest], [200, 215], '215 is more than 5 percent over 200');
  await athlete('POST', '/app/api/maxes', { test: 'squat_1rm', value: 210 });
  const d1 = squatLift((await athlete('GET', '/app/api/maxes')).body);
  assert.deepEqual([d1.value, d1.suggest], [210, null], 'within 5 percent: nothing to suggest');
  assert.equal(d1.history.length, 2);
  app.ctx.now = () => NOW;
});
