import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

// Weights prescribed as a percent of the athlete's latest tested max.
let app, base, coach, ava, program, workout, squat, home;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev');
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  const plan = (await coach('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, newId('sub'), ava.id, plan.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  program = (await coach('POST', '/v1/programs', { name: 'Strength block', weeks: 4 })).body;
  workout = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Lower body' })).body;
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  const token = (await coach('GET', `/v1/clients/${ava.id}`)).body.app_link.split('token=')[1];
  home = async () => (await (await fetch(`${base}/app/api/home`, { headers: { 'x-client-token': token } })).json()).workout.exercises[0].load;
});
after(() => app.server.close());

test('a weight can be a percent of a tested max', async () => {
  const bad = await coach('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: squat.id, prescription: '5 × 5', load_test: 'squat_1rm', load_pct: 150 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /30 to 110/);
  const w = (await coach('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: squat.id, prescription: '5 × 5', load_test: 'squat_1rm', load_pct: 75 })).body;
  assert.deepEqual([w.exercises[0].load_test, w.exercises[0].load_pct], ['squat_1rm', 75]);
  const load = await home();
  assert.equal(load.missing, true);
  assert.match(load.text, /75% of your back squat max\. Enter your max on the Performance tab, or log a few sets/);
});

test('the weight follows the latest max the family can see, rounded to 5 lb', async () => {
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Fall max day', date: '2026-09-01', tests: ['squat_1rm'] })).body;
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: ava.id, test: 'squat_1rm', metric: 'load', value: 205, recorded_at: '2026-09-01T15:00:00.000Z' }] });
  assert.equal((await home()).missing, true, 'not shared yet');
  await coach('POST', `/v1/testing-sessions/${day.id}/share`, {});
  let load = await home();
  assert.deepEqual([load.lb, load.max_lb, load.text], [155, 205, '155 lb (75% of your 205 lb back squat max)']);   // 153.75 → 155

  const again = (await coach('POST', '/v1/testing-sessions', { name: 'Winter max day', date: '2026-12-01', tests: ['squat_1rm'] })).body;
  await coach('POST', '/v1/results', { session_id: again.id, results: [{ client_id: ava.id, test: 'squat_1rm', metric: 'load', value: 230, recorded_at: '2026-12-01T15:00:00.000Z' }] });
  await coach('POST', `/v1/testing-sessions/${again.id}/share`, {});
  load = await home();
  assert.equal(load.lb, 175, '230 × 75% = 172.5 → 175');

  const ex = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts[0].exercises[0];
  assert.equal((await coach('PATCH', `/v1/workout-exercises/${ex.id}`, { load_test: 'squat_1rm', load_pct: 80 })).body.load_pct, 80);
  assert.equal((await home()).lb, 185);
  assert.equal((await coach('PATCH', `/v1/workout-exercises/${ex.id}`, { load_test: null })).body.load_test, null);
  assert.equal(await home(), null);
});
