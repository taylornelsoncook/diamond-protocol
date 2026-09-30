// Training volume (Relay plan step 3): weeks of sets, reps, tonnage, workouts and minutes from the logged sets, the
// most-logged exercises with weekly sets, and the current program's phases with what was done in each.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

let app, base, coach, owner, desk, maya, token, program, workouts = {}, slots = {}, parentCookie;
const PW = 'correct-horse-battery';
const NOW = '2026-10-08T15:00:00.000Z';   // Thursday
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
const log = async (title, at, sets, startedMinutesBefore = 45) => {
  app.ctx.now = () => at;
  const r = await athlete('POST', `/app/api/workouts/${workouts[title].id}/complete`, { request_id: `r-${title}-${at}`, started_at: new Date(Date.parse(at) - startedMinutesBefore * 60000).toISOString(), finished_at: at, sets });
  app.ctx.now = () => NOW;
  assert.equal(r.status, 201, JSON.stringify(r.body));
};

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); owner = await staff('owner@test.dev'); desk = await staff('desk@test.dev');
  maya = (await coach('POST', '/v1/clients', { name: 'Maya Okafor', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, newId('sub'), maya.id, plan.id, '2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z', NOW, NOW);
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', maya.id).access_token;
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body, row = (await coach('POST', '/v1/exercises', { name: 'Dumbbell row' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 4 })).body;
  for (const [week, title] of [[1, 'W1'], [2, 'W2'], [3, 'W3'], [4, 'W4']]) {
    workouts[title] = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week, day: 1, title })).body;
    const w = (await coach('POST', `/v1/workouts/${workouts[title].id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' })).body;
    const w2 = (await coach('POST', `/v1/workouts/${workouts[title].id}/exercises`, { exercise_id: row.id, sets: 3, reps: '10' })).body;
    slots[title] = { squat: w2.exercises.find((x) => x.exercise_id === squat.id).id, row: w2.exercises.find((x) => x.exercise_id === row.id).id };
  }
  assert.equal((await coach('POST', `/v1/programs/${program.id}/phases`, { kind: 'base', start_week: 1, end_week: 2, note: 'Build the base' })).status, 201);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/phases`, { kind: 'peak', start_week: 3, end_week: 4 })).status, 201);
  // Started Monday Sep 21, Mondays only: W1 Sep 21, W2 Sep 28, W3 Oct 5, W4 Oct 12.
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id, start_date: '2026-09-21', training_days: [1] })).status, 201);
  // W1 and W2 done on their days; W3 done Tuesday Oct 6 (this week); W4 is ahead.
  await log('W1', '2026-09-21T22:00:00.000Z', [{ workout_exercise_id: slots.W1.squat, set_no: 1, weight: 135, reps: 5 }, { workout_exercise_id: slots.W1.squat, set_no: 2, weight: 135, reps: 5 }, { workout_exercise_id: slots.W1.row, set_no: 1, weight: 30, reps: 10 }]);
  await log('W2', '2026-09-28T22:00:00.000Z', [{ workout_exercise_id: slots.W2.squat, set_no: 1, weight: 145, reps: 5 }, { workout_exercise_id: slots.W2.row, set_no: 1, weight: 30, reps: 10 }, { workout_exercise_id: slots.W2.row, set_no: 2, weight: 30, reps: 10 }], 50);
  await log('W3', '2026-10-06T22:00:00.000Z', [{ workout_exercise_id: slots.W3.squat, set_no: 1, weight: 155, reps: 5 }, { workout_exercise_id: slots.W3.squat, set_no: 2, weight: 155, reps: 5 }, { workout_exercise_id: slots.W3.squat, set_no: 3, weight: 155, reps: 3 }], 40);
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com' }) })).json()).dev_code;
  const v = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com', code }) });
  parentCookie = v.headers.get('set-cookie').split(';')[0];
});
after(() => app.server.close());

test('weeks, this week against last, totals and the most-logged exercises come from the sets', async () => {
  const d = (await athlete('GET', '/app/api/progress')).body;
  assert.equal(d.weeks.length, 12);
  assert.equal(d.weeks.at(-1).week_start, '2026-10-05');
  assert.equal(d.weeks.at(-1).current, true);
  // This week: W3 = 3 sets, 13 reps, 155×5 + 155×5 + 155×3 = 2,015 lb, 40 minutes. Last week: W2 = 3 sets, 25 reps, 725 + 300 + 300 = 1,325 lb, 50 minutes.
  assert.deepEqual([d.this_week.workouts, d.this_week.sets, d.this_week.reps, d.this_week.tonnage, d.this_week.minutes], [1, 3, 13, 2015, 40]);
  assert.deepEqual([d.last_week.workouts, d.last_week.sets, d.last_week.reps, d.last_week.tonnage, d.last_week.minutes], [1, 3, 25, 1325, 50]);
  assert.deepEqual([d.totals.workouts, d.totals.sets, d.totals.tonnage, d.totals.minutes], [3, 9, 2015 + 1325 + 1350 + 300, 135]);
  assert.equal(d.weeks.filter((w) => w.workouts).length, 3, 'empty weeks stay in the list with zeros');
  assert.deepEqual(d.exercises.map((x) => [x.name, x.sets, x.top]), [['Back squat', 6, 155], ['Dumbbell row', 3, 30]]);
  assert.equal(d.exercises[0].weekly_sets.length, 12);
  assert.deepEqual(d.exercises[0].weekly_sets.slice(-3).map((x) => x.value), [2, 1, 3]);
});

test('the program\'s phases are put on the calendar with what was done in each', async () => {
  const d = (await coach('GET', `/v1/clients/${maya.id}/progress`)).body;
  assert.deepEqual(d.phases.map((f) => [f.name, f.kind, f.start_date, f.end_date, f.state, f.planned, f.done, f.missed, f.sets, f.tonnage]), [
    ['Base', 'base', '2026-09-21', '2026-09-28', 'past', 2, 2, 0, 6, 2975],
    ['Peak', 'peak', '2026-10-05', '2026-10-12', 'current', 2, 1, 0, 3, 2015]]);
  assert.equal(d.phases[0].note, 'Build the base');
  // The family sees the same; front desk may look; a stranger's family can't.
  const p = await fetch(`${base}/portal/api/athletes/${maya.id}/progress`, { headers: { cookie: parentCookie } });
  assert.equal(p.status, 200);
  assert.equal((await p.json()).phases.length, 2);
  assert.equal((await desk('GET', `/v1/clients/${maya.id}/progress`)).status, 200);
  const other = (await coach('POST', '/v1/clients', { name: 'Zed Solo', parent: { name: 'Pat Solo', email: 'pat@example.com' } })).body;
  assert.equal((await fetch(`${base}/portal/api/athletes/${other.id}/progress`, { headers: { cookie: parentCookie } })).status, 404);
  // No program: no phases, and the weeks still count.
  const solo = (await coach('GET', `/v1/clients/${other.id}/progress`)).body;
  assert.deepEqual([solo.phases, solo.totals.workouts, solo.weeks.length], [[], 0, 12]);
});
