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
import { exportFamily } from '../src/services/legal.js';

// The workout logger's extras (schema 99, owner's ask: "give them the ability to track and record their information
// to their desire"): an athlete may record how hard each set was and a note on it, and reads one exercise over time
// (GET /app/api/exercises/:id/history). Weight and reps work as before; a set with no extras answers no extra keys.
let app, base, coach, ava, cole, squat, row, program, w1, w2, slot;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = (c) => async (method, path, body) => {
  const token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', c.id).access_token;
  const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const member = (c) => app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`,
  newId('sub'), c.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  cole = (await coach('POST', '/v1/clients', { name: 'Cole Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  member(ava); member(cole);
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  row = (await coach('POST', '/v1/exercises', { name: 'Dumbbell row' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Strength', weeks: 1 })).body;
  w1 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Day one' })).body;
  w2 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 2, title: 'Day two' })).body;
  await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' });
  await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: row.id, sets: 2, reps: '10' });
  await coach('POST', `/v1/workouts/${w2.id}/exercises`, { exercise_id: squat.id, sets: 2, reps: '3' });
  const p = (await coach('GET', `/v1/programs/${program.id}`)).body, of = (wid) => p.workouts.find((w) => w.id === wid).exercises;
  slot = { a: of(w1.id)[0], b: of(w1.id)[1], c: of(w2.id)[0] };
  for (const c of [ava, cole]) assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: c.id })).status, 201);
});
after(() => app.server.close());

test('a set carries its own effort and note when the athlete records them, and nothing extra when they don\'t', async () => {
  const me = athlete(ava);
  const sets = (extra) => [{ workout_exercise_id: slot.a.id, set_no: 1, weight: 135, reps: 5, ...extra }];
  for (const [extra, like] of [[{ rpe: 11 }, /rate the set from 1 to 10/], [{ rpe: 7.3 }, /halves are fine/], [{ rpe: 'hard' }, /rate the set/], [{ note: 'x'.repeat(201) }, /200/]]) {
    const bad = await me('POST', `/app/api/workouts/${w1.id}/complete`, { sets: sets(extra) });
    assert.equal(bad.status, 400, JSON.stringify(extra)); assert.match(bad.body.error.message, like);
  }
  const done = await me('POST', `/app/api/workouts/${w1.id}/complete`, { request_id: 'req-extras-1', rpe: 7, sets: [
    { workout_exercise_id: slot.a.id, set_no: 1, weight: 135, reps: 5, rpe: 6, note: '  Felt fast  ' },
    { workout_exercise_id: slot.a.id, set_no: 2, weight: 145, reps: 5, rpe: 7.5 },
    { workout_exercise_id: slot.a.id, set_no: 3, weight: 155, reps: 4, note: 'Missed the last rep', rpe: '' },
    { workout_exercise_id: slot.b.id, set_no: 1, weight: 40, reps: 10 }] });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const squatSets = done.body.finished.exercises.find((x) => x.id === slot.a.id).sets;
  assert.deepEqual(squatSets, [{ set_no: 1, weight: 135, reps: 5, rpe: 6, note: 'Felt fast' }, { set_no: 2, weight: 145, reps: 5, rpe: 7.5 }, { set_no: 3, weight: 155, reps: 4, note: 'Missed the last rep' }]);
  assert.deepEqual(done.body.finished.exercises.find((x) => x.id === slot.b.id).sets, [{ set_no: 1, weight: 40, reps: 10 }], 'no extras, no extra keys');
  // The athlete's log, the coach's view of it and the family export all carry them.
  const mine = (await me('GET', `/app/api/logs/${done.body.id}`)).body;
  assert.equal(mine.exercises[0].sets[0].note, 'Felt fast'); assert.equal(mine.rpe, 7, 'the workout\'s own effort is separate');
  const flat = JSON.stringify(exportFamily(app.ctx, ava.family.id));
  assert.ok(flat.includes('Missed the last rep') && flat.includes('"effort":7.5'), 'in the family export');
  // The coach reads the same workout set by set from the client page; another client's id doesn't open it.
  const seen = await coach('GET', `/v1/clients/${ava.id}/workouts/${done.body.id}`);
  assert.equal(seen.status, 200); assert.equal(seen.body.exercises[0].sets[2].note, 'Missed the last rep'); assert.equal(seen.body.exercises[0].sets[1].rpe, 7.5);
  assert.equal((await coach('GET', `/v1/clients/${cole.id}/workouts/${done.body.id}`)).status, 404);
  // Reopening and saving again replaces the extras with what was sent.
  const again = await me('PUT', `/app/api/logs/${done.body.id}`, { sets: [{ workout_exercise_id: slot.a.id, set_no: 1, weight: 135, reps: 5, rpe: 8 }] });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual((await me('GET', `/app/api/logs/${done.body.id}`)).body.exercises[0].sets, [{ set_no: 1, weight: 135, reps: 5, rpe: 8 }]);
});

test('workout settings: an athlete turns effort and notes on for their own profile, and they follow the account', async () => {
  const me = athlete(cole), other = athlete(ava);
  assert.deepEqual((await me('GET', '/app/api/home')).body.log_settings, { effort: false, notes: false }, 'off until they choose');
  assert.deepEqual((await me('PATCH', '/app/api/log-settings', { effort: true })).body, { effort: true, notes: false });
  assert.deepEqual((await me('PATCH', '/app/api/log-settings', { notes: true })).body, { effort: true, notes: true }, 'a field left out keeps its setting');
  assert.deepEqual((await me('GET', '/app/api/home')).body.log_settings, { effort: true, notes: true });
  assert.deepEqual((await other('GET', '/app/api/home')).body.log_settings, { effort: false, notes: false }, 'only their own');
  assert.equal((await me('PATCH', '/app/api/log-settings', { effort: 'yes' })).status, 400);
  assert.deepEqual((await me('PATCH', '/app/api/log-settings', { effort: false, notes: false })).body, { effort: false, notes: false });
});

test('one exercise over time: sessions newest first, set by set, with each session\'s top set, estimated max and pounds moved, and the bests', async () => {
  const me = athlete(cole);
  const empty = (await me('GET', `/app/api/exercises/${squat.id}/history`)).body;
  assert.equal(empty.times, 0); assert.deepEqual(empty.sessions, []); assert.equal(empty.best.weight, null);
  assert.equal((await me('GET', '/app/api/exercises/nope/history')).status, 404);
  const first = await me('POST', `/app/api/workouts/${w1.id}/complete`, { finished_at: new Date(Date.now() - 2 * 86400000).toISOString(), sets: [
    { workout_exercise_id: slot.a.id, set_no: 1, weight: 135, reps: 5 }, { workout_exercise_id: slot.a.id, set_no: 2, weight: 155, reps: 5, rpe: 8 }, { workout_exercise_id: slot.b.id, set_no: 1, weight: 40, reps: 10 }] });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await me('POST', `/app/api/workouts/${w2.id}/complete`, { sets: [{ workout_exercise_id: slot.c.id, set_no: 1, weight: 165, reps: 3, note: 'New top set' }, { workout_exercise_id: slot.c.id, set_no: 2, weight: 150, reps: 20 }] });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const hist = (await me('GET', `/app/api/exercises/${squat.id}/history`)).body;
  assert.equal(hist.name, 'Back squat'); assert.equal(hist.times, 2);
  assert.deepEqual(hist.sessions.map((s) => s.workout), ['Day two', 'Day one'], 'newest first');
  assert.deepEqual(hist.sessions[0].sets, [{ set_no: 1, weight: 165, reps: 3, note: 'New top set' }, { set_no: 2, weight: 150, reps: 20 }]);
  assert.equal(hist.sessions[0].top_weight, 165);
  assert.equal(hist.sessions[0].e1rm, Math.round(165 * (1 + 3 / 30)), 'a 20-rep set is left out of the estimate');
  assert.equal(hist.sessions[0].volume_lb, 165 * 3 + 150 * 20);
  assert.equal(hist.sessions[1].e1rm, Math.round(155 * (1 + 5 / 30)));
  assert.deepEqual(hist.sessions[1].sets[1], { set_no: 2, weight: 155, reps: 5, rpe: 8 });
  assert.equal(hist.best.weight.value, 165); assert.equal(hist.best.e1rm.value, 182);
  assert.equal(hist.best.volume_set.value, 3000); assert.equal(hist.best.volume_set.reps, 20);
  // Only their own sets: Ava's squats aren't in Cole's history, and another exercise has its own.
  assert.equal((await me('GET', `/app/api/exercises/${row.id}/history`)).body.sessions.length, 1);
  assert.ok(!JSON.stringify(hist).includes('Felt fast'));
});

test('a version 98 database gains the set columns and the workout settings and keeps its sets, opened twice', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-sets98-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v98.sql', import.meta.url), 'utf8'));
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cl_1', 'Ava Lopez', 'AVALOP2026', 'tok', '2026-09-01T00:00:00Z');
      INSERT INTO workout_logs (id, client_id, completed_at) VALUES ('wl_1', 'cl_1', '2026-09-01T00:00:00Z');
      INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES ('ws_1', 'wl_1', 'wex_1', NULL, 'Back squat', 1, 135, 5, '2026-09-01T00:00:00Z');`);
    old.exec('PRAGMA user_version = 98');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 99, `round ${round}`);
      assert.deepEqual({ ...d.get('SELECT set_no, weight, reps, rpe, note FROM workout_sets') }, { set_no: 1, weight: 135, reps: 5, rpe: null, note: null });
      assert.deepEqual({ ...d.get('SELECT track_set_rpe, track_set_note FROM clients') }, { track_set_rpe: 0, track_set_note: 0 }, 'the workout settings start off');
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
