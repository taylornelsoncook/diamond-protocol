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
  const s = (await coach('GET', '/v1/engagement/settings')).body;
  assert.deepEqual([s.rankings, s.readiness_adjust, s.readiness_wearable, s.progression_mode], ['off', 'off', 'on', 'suggest']);
  assert.equal((await coach('GET', '/v1/daily-check-ins/flags')).body.data[0].readiness, null, 'no suggestion shown to coaches either');
});

test('the wearable counts too: a rough night the band saw makes a lighter day before the check-in, and the owner sets the numbers', async () => {
  await coach('PATCH', '/v1/engagement/settings', { readiness_adjust: 'on' });
  const { today } = await import('../src/services/engage.js');
  const day = today(app.ctx), minus = (n) => new Date(Date.parse(`${day}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  app.ctx.db.run('DELETE FROM daily_checkins WHERE client_id = ?', ava.id);
  const put = (metric, value, d = day) => app.ctx.db.run(`INSERT INTO athlete_metrics (client_id, day, metric, value, source, updated_at) VALUES (?, ?, ?, ?, 'whoop_sync', ?) ON CONFLICT (client_id, metric, day) DO UPDATE SET value = excluded.value`, ava.id, d, metric, value, new Date().toISOString());
  put('recovery_pct', 41); put('sleep_min', 330);
  let h = await home();
  assert.deepEqual([h.readiness.level, h.readiness.drop, h.readiness.sets_off, h.readiness.checkin_missing, h.readiness.from], ['red', 20, 1, true, 'your WHOOP'], 'two reasons from the band: an easy day, with a nudge to check in');
  assert.deepEqual(h.readiness.reasons, ['Recovery 41% (WHOOP)', 'Slept 5h 30m (WHOOP)']);
  assert.deepEqual([h.workout.exercises[0].load.lb, h.workout.exercises[0].target_sets, h.workout.exercises[0].planned_sets], [110, 4, 5], '55% of 200, and one set off');
  // The owner's rules: recovery under 40 counts, sleep under 320, an easy day takes 30 points and two sets off.
  const r = await coach('PATCH', '/v1/engagement/settings', { readiness_recovery_yellow: 40, readiness_red_drop: 30, readiness_red_sets: 2, readiness_sleep_yellow_min: 320 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  h = await home();
  assert.equal(h.readiness.level, 'green', 'neither number is a reason under the new rules');
  put('recovery_pct', 30);
  h = await home();
  assert.deepEqual([h.readiness.level, h.readiness.drop, h.readiness.sets_off, h.workout.exercises[0].target_sets, h.workout.exercises[0].load.lb], ['red', 30, 2, 3, 90], 'under the easy-day recovery score on its own');
  // HRV against their own 30-day average (at least 7 days of it).
  put('recovery_pct', 70);
  for (let i = 1; i <= 8; i++) put('hrv_ms', 80, minus(i));
  put('hrv_ms', 56);
  h = await home();
  assert.deepEqual([h.readiness.level, h.readiness.reasons], ['yellow', ['HRV 56 ms, 30% under your usual (WHOOP)']]);
  assert.equal((await coach('PATCH', '/v1/engagement/settings', { readiness_recovery_red: 60 })).status, 400, 'the easy-day score has to sit below the lighter-day one');
  assert.equal((await coach('PATCH', '/v1/engagement/settings', { readiness_hrv_drop_pct: 3 })).status, 400);
  // The wearable switched off: nothing to go on until the check-in.
  await coach('PATCH', '/v1/engagement/settings', { readiness_wearable: 'off' });
  h = await home(); assert.equal(h.readiness.level, null);
  await coach('PATCH', '/v1/engagement/settings', { readiness_wearable: 'on' });
  // Check-in and band together.
  await checkIn({ sleep_hours: 8, soreness: 4, energy: 4, mood: 4, hydration: 4 });
  h = await home();
  assert.deepEqual([h.readiness.level, h.readiness.from, h.readiness.checkin_missing, h.readiness.reasons.length], ['red', 'your check-in and your WHOOP', false, 2]);
  const flags = (await coach('GET', '/v1/daily-check-ins/flags')).body.data.find((x) => x.client_id === ava.id);
  assert.equal(flags?.readiness ?? 'yellow', 'yellow', 'the check-in on its own is one reason');
});
