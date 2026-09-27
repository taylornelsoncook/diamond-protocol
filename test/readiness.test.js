import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

// A rough daily check-in makes today's workout lighter in the athlete app.
let app, base, coach, ava, token;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = async (method, path, body) => (await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const home = () => athlete('GET', '/app/api/home');
const checkIn = (body) => athlete('POST', '/app/api/daily-check-in', body);

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev');
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  const plan = (await coach('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, newId('sub'), ava.id, plan.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  const program = (await coach('POST', '/v1/programs', { name: 'Strength block', weeks: 4 })).body;
  const workout = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Lower body' })).body;
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  await coach('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: squat.id, prescription: '5 × 5', load_test: 'squat_1rm', load_pct: 75 });
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Max day', date: '2026-09-01', tests: ['squat_1rm'] })).body;
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: ava.id, test: 'squat_1rm', metric: 'load', value: 200, recorded_at: '2026-09-01T15:00:00.000Z' }] });
  await coach('POST', `/v1/testing-sessions/${day.id}/share`, {});
  token = (await coach('GET', `/v1/clients/${ava.id}`)).body.app_link.split('token=')[1];
});
after(() => app.server.close());

test('no check-in yet: train as written, with a nudge to check in', async () => {
  const h = await home();
  assert.equal(h.readiness.level, null);
  assert.match(h.readiness.advice, /check-in/);
  assert.equal(h.workout.exercises[0].load.lb, 150);
});

test('the check-in sets the day: as written, 10% lighter, or an easy day', async () => {
  await checkIn({ sleep_hours: 8.5, soreness: 2, energy: 4 });
  let h = await home();
  assert.deepEqual([h.readiness.level, h.workout.exercises[0].load.lb, h.workout.exercises[0].load.planned_pct], ['green', 150, undefined]);

  await checkIn({ sleep_hours: 8, soreness: 4, energy: 4 });
  h = await home();
  assert.equal(h.readiness.level, 'yellow');
  assert.deepEqual(h.readiness.reasons, ['Soreness 4 of 5']);
  const load = h.workout.exercises[0].load;
  assert.deepEqual([load.pct, load.planned_pct, load.lb], [65, 75, 130]);
  assert.equal(load.text, '130 lb (lighter today: 65% instead of 75% of your 200 lb back squat max)');

  await checkIn({ sleep_hours: 4.5, energy: 4 });
  h = await home();
  assert.equal(h.readiness.level, 'red', 'under 5 hours of sleep alone is an easy day');
  assert.match(h.readiness.advice, /one set less/);
  assert.equal(h.workout.exercises[0].load.lb, 110);

  const flags = (await coach('GET', '/v1/daily-check-ins/flags')).body.data;
  assert.equal(flags[0].readiness, 'red', 'coaches see what the app suggested');
});

test('coaches can turn it off', async () => {
  assert.equal((await coach('PATCH', '/v1/engagement/settings', { readiness_adjust: 'off' })).body.readiness_adjust, 'off');
  const h = await home();
  assert.equal(h.readiness, null);
  assert.equal(h.workout.exercises[0].load.lb, 150);
  assert.deepEqual((await coach('GET', '/v1/engagement/settings')).body, { rankings: 'off', readiness_adjust: 'off' });
  assert.equal((await coach('GET', '/v1/daily-check-ins/flags')).body.data[0].readiness, null, 'no suggestion shown to coaches either');
});
