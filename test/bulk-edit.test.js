// Bulk edit (Relay plan step 7): change one exercise everywhere it appears in a run of weeks, in place. Steps move the
// numbers, reps and tempo replace the text, other exercises and other weeks are untouched, limits hold, and workouts
// athletes already logged need confirm.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

let app, base, coach, desk, program, squat, bench, maya;
const PW = 'correct-horse-battery';
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const squats = async () => (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.sort((a, b) => a.week - b.week).map((w) => ({ week: w.week, ...w.exercises.find((x) => x.exercise_id === squat.id) }));

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  const owner = await staff('owner@test.dev');
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body; bench = (await coach('POST', '/v1/exercises', { name: 'Bench press' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 4 })).body;
  for (const week of [1, 2, 3, 4]) {
    const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week, day: 1, title: `Lower ${week}` })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5', tempo: '2-0-1', rest_seconds: 120, target_rpe: 7, load_test: 'squat_1rm', load_pct: 70 });
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: bench.id, sets: 3, reps: '8', target_rpe: 7 });
  }
  maya = (await coach('POST', '/v1/clients', { name: 'Maya Okafor', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, newId('sub'), maya.id, plan.id, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', app.ctx.now(), app.ctx.now());
});
after(() => app.server.close());

test('one exercise changes across a run of weeks; other weeks and exercises stay; limits hold', async () => {
  const none = await coach('POST', `/v1/programs/${program.id}/bulk-edit`, { exercise_id: squat.id, from_week: 2, to_week: 4 });
  assert.equal(none.status, 400); assert.match(none.body.error.message, /at least one change/);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/bulk-edit`, { exercise_id: 'ex_nope', pct_step: 5 })).status, 400, 'not in the program');
  assert.equal((await coach('POST', `/v1/programs/${program.id}/bulk-edit`, { exercise_id: squat.id, from_week: 3, to_week: 2, pct_step: 5 })).status, 400);
  const r = await coach('POST', `/v1/programs/${program.id}/bulk-edit`, { exercise_id: squat.id, from_week: 2, to_week: 4, sets_step: 1, pct_step: 5, rpe_step: 0.5, rest_step: 30, reps: '3', tempo: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.slots, r.body.changed, r.body.changes.map((c) => c.week)], [3, 3, [2, 3, 4]]);
  const sq = await squats();
  assert.deepEqual(sq.map((x) => [x.week, x.sets, x.load_pct, x.target_rpe, x.rest_seconds, x.reps, x.tempo]), [
    [1, 3, 70, 7, 120, '5', '2-0-1'], [2, 4, 75, 7.5, 150, '3', null], [3, 4, 75, 7.5, 150, '3', null], [4, 4, 75, 7.5, 150, '3', null]]);
  assert.match(sq[1].prescription, /^4 × 3/, 'the short text is rebuilt');
  const benchRows = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.map((w) => w.exercises.find((x) => x.exercise_id === bench.id));
  assert.ok(benchRows.every((x) => x.sets === 3 && x.reps === '8'), 'the other exercise is untouched');
  // Limits: a big step stops at the edge.
  await coach('POST', `/v1/programs/${program.id}/bulk-edit`, { exercise_id: squat.id, from_week: 4, to_week: 4, pct_step: 30, sets_step: 6, rpe_step: 3 });
  const w4 = (await squats())[3];
  assert.deepEqual([w4.load_pct, w4.sets, w4.target_rpe], [105, 10, 10]);
  await coach('POST', `/v1/programs/${program.id}/bulk-edit`, { exercise_id: squat.id, from_week: 4, to_week: 4, pct_step: 30 });
  assert.equal((await squats())[3].load_pct, 110);
  // Front desk can't.
  assert.equal((await desk('POST', `/v1/programs/${program.id}/bulk-edit`, { exercise_id: squat.id, pct_step: 5 })).status, 403);
});

test('a week an athlete already logged needs confirm', async () => {
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id, start_date: '2026-09-01' })).status, 201);
  const token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', maya.id).access_token;
  const w1 = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.find((w) => w.week === 1);
  const fin = await fetch(`${base}/app/api/workouts/${w1.id}/complete`, { method: 'POST', headers: { 'x-client-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ request_id: 'r1' }) });
  assert.equal(fin.status, 201, await fin.text());
  const blocked = await coach('POST', `/v1/programs/${program.id}/bulk-edit`, { exercise_id: squat.id, from_week: 1, to_week: 2, pct_step: -5 });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'confirm_needed');
  assert.equal((await squats())[0].load_pct, 70, 'nothing changed');
  const ok = await coach('POST', `/v1/programs/${program.id}/bulk-edit`, { exercise_id: squat.id, from_week: 1, to_week: 2, pct_step: -5, confirm: true });
  assert.equal(ok.status, 200);
  assert.deepEqual((await squats()).slice(0, 2).map((x) => x.load_pct), [65, 70]);
});
