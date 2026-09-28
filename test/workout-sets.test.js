import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';
import { parseRx } from '../src/services/programs.js';

// The athlete app's Workout tab: set-by-set logging, effort, one save per Finish (double taps and offline resends),
// reopening, coming up, history, weights from tested maxes, and the weight-room screen logging the same workout.
let app, base, coach, ava, ben, program, w1, w2, w3, w4, w5, squat, plank, key, session;
const MIN = 60000;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const tokenOf = (c) => app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', c.id).access_token;
const athlete = (c) => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-client-token': tokenOf(c), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tv = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-kiosk-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const member = (c, status = 'active') => app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', ?, ?, ?, ?, ?)`,
  newId('sub'), c.id, status, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: 'correct-horse-battery', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  app.ctx.db.run(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_f', 'Facility', 'facility', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', '/v1/clients', { name: 'Ben Ortiz', parent: { name: 'Rosa Ortiz', email: 'rosa@example.com' } })).body;
  member(ava); member(ben);
  program = (await coach('POST', '/v1/programs', { name: 'Strength block', weeks: 2 })).body;
  const sq = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  const pl = (await coach('POST', '/v1/exercises', { name: 'Front plank' })).body;
  const ws = [];
  for (const [week, day] of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2]]) {
    const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week, day, title: `Lift ${week}.${day}` })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: sq.id, prescription: '3 × 5', load_test: 'squat_1rm', load_pct: 75 });
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: pl.id, prescription: '3 × 40 sec' });
    ws.push(w);
  }
  [w1, w2, w3, w4, w5] = ws;
  for (const c of [ava, ben]) await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: c.id });
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Max day', date: '2026-09-01', tests: ['squat_1rm'] })).body;
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: ava.id, test: 'squat_1rm', metric: 'load', value: 200, recorded_at: '2026-09-01T15:00:00.000Z' }] });
  await coach('POST', `/v1/testing-sessions/${day.id}/share`, {});
  const k = (await coach('POST', '/v1/kiosks', { location_id: 'loc_f', name: 'Weight room TV' })).body;
  key = k.screen_link.split('#')[1];
});
after(() => app.server.close());

test('sets and reps come from the prescription', () => {
  assert.deepEqual(parseRx('3 × 10'), { sets: 3, reps: 10 });
  assert.deepEqual(parseRx('4x8-10'), { sets: 4, reps: 8 });
  assert.deepEqual(parseRx('3 × 6–8'), { sets: 3, reps: 6 });
  assert.deepEqual(parseRx('3 × 12 each side'), { sets: 3, reps: 12 });
  assert.deepEqual(parseRx('4 x 5/side'), { sets: 4, reps: 5 });
  assert.deepEqual(parseRx('3 × 40 sec'), { sets: 3, reps: null });
  assert.deepEqual(parseRx('2 × 20 yd'), { sets: 2, reps: null });
  assert.deepEqual(parseRx('3 × max'), { sets: 3, reps: null });
  assert.deepEqual(parseRx('8 × 30 sec hard, 60 sec easy'), { sets: 8, reps: null });
  assert.deepEqual(parseRx('10'), { sets: 1, reps: 10 });
  assert.deepEqual(parseRx('Easy jog'), { sets: 1, reps: null });
  assert.deepEqual(parseRx('20 × 3'), { sets: 10, reps: 3 }, 'never more than 10 rows to start with');
});

test('home: today\'s workout with sets to log and weights from the tested max, and the next three coming up', async () => {
  const home = (await athlete(ava)('GET', '/app/api/home')).body;
  const [sq, pl] = home.workout.exercises;
  squat = sq; plank = pl;
  assert.deepEqual([sq.target_sets, sq.target_reps, sq.load.lb, sq.last, sq.best_weight], [3, 5, 150, null, null]);
  assert.deepEqual([pl.target_sets, pl.target_reps, pl.load], [3, null, null]);
  assert.deepEqual(home.upcoming.map((u) => [u.title, u.exercises]), [['Lift 1.2', ['Back squat', 'Front plank']], ['Lift 1.3', ['Back squat', 'Front plank']], ['Lift 2.1', ['Back squat', 'Front plank']]]);
  assert.deepEqual([home.history, home.reopen_id], [[], null]);
});

test('Finish saves every set, effort and the note together; mistakes are listed plainly and nothing is saved', async () => {
  const me = athlete(ava);
  const bad = async (body, re) => {
    const r = await me('POST', `/app/api/workouts/${w1.id}/complete`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error.message, re);
  };
  await bad({ sets: [{ workout_exercise_id: 'wex_nope', set_no: 1 }] }, /Set 1: that exercise isn't in this workout/);
  await bad({ sets: [{ workout_exercise_id: squat.id, set_no: 13 }] }, /Back squat: sets are numbered 1 to 12/);
  await bad({ sets: [{ workout_exercise_id: squat.id, set_no: 1, weight: 2500 }] }, /Back squat, set 1: enter a weight from 0 to 2000 lb/);
  await bad({ sets: [{ workout_exercise_id: squat.id, set_no: 1, reps: 2.5 }] }, /Back squat, set 1: enter reps as a whole number/);
  await bad({ sets: [{ workout_exercise_id: squat.id, set_no: 1 }, { workout_exercise_id: squat.id, set_no: 1 }] }, /Back squat: set 1 is in the list twice/);
  await bad({ rpe: 11 }, /Rate how hard it was from 1 to 10/);
  await bad({ exercise_ids: [w2.id] }, /not in this workout/);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE client_id = ?', ava.id).n, 0);

  const started = new Date(Date.now() - 42 * MIN).toISOString();
  const r = await me('POST', `/app/api/workouts/${w1.id}/complete`, {
    request_id: 'ava-w1-1', started_at: started, rpe: 7, notes: 'Legs felt heavy',
    sets: [1, 2, 3].map((n) => ({ workout_exercise_id: squat.id, set_no: n, weight: 150, reps: 5 })).concat([{ workout_exercise_id: plank.id, set_no: 1 }, { workout_exercise_id: plank.id, set_no: 2 }])
  });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.finished.exercises_logged, r.body.finished.exercises_total, r.body.finished.sets, r.body.finished.rpe, r.body.finished.minutes, r.body.finished.bests], [2, 2, 5, 7, 42, []]);
  assert.equal(r.body.next.workout.id, w2.id);
  const next = r.body.next.workout.exercises[0];
  assert.deepEqual([next.last.sets.map((s) => [s.weight, s.reps]), next.best_weight], [[[150, 5], [150, 5], [150, 5]], 150], 'last time and best follow the exercise');
  assert.equal(r.body.next.history[0].sets, 5);
  const ev = JSON.parse(app.ctx.db.get(`SELECT data FROM events WHERE type = 'workout.completed' ORDER BY rowid DESC LIMIT 1`).data);
  assert.deepEqual([ev.effort, ev.sets, ev.minutes, ev.notes, ev.bests], [7, 5, 42, 'Legs felt heavy', []], 'the webhook carries effort, sets and time');
});

test('a second tap or an offline resend with the same request id saves nothing twice', async () => {
  const me = athlete(ava);
  const again = await me('POST', `/app/api/workouts/${w1.id}/complete`, { request_id: 'ava-w1-1', sets: [] });
  assert.equal(again.status, 201);
  assert.equal(again.body.repeat, true);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE client_id = ?', ava.id).n, 1);
  // Two presses at once on the next workout: one log.
  const body = { request_id: 'ava-w2-1', rpe: 8, sets: [{ workout_exercise_id: (await me('GET', '/app/api/home')).body.workout.exercises[0].id, set_no: 1, weight: 160, reps: 5 }] };
  const [a, b] = await Promise.all([me('POST', `/app/api/workouts/${w2.id}/complete`, body), me('POST', `/app/api/workouts/${w2.id}/complete`, body)]);
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.equal(a.body.id, b.body.id);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE client_id = ? AND workout_id = ?', ava.id, w2.id).n, 1);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id WHERE l.workout_id = ?', w2.id).n, 1);
  assert.deepEqual((a.body.repeat ? b : a).body.finished.bests, [{ name: 'Back squat', weight: 160, previous: 150 }], 'a new best weight');
  // Without a request id the second one is refused as already logged.
  const dup = await me('POST', `/app/api/workouts/${w2.id}/complete`, {});
  assert.deepEqual([dup.status, dup.body.error.message], [409, 'This workout is already logged.']);
});

test('reopen: the latest workout, for 2 hours, saved again as a whole; older ones can\'t', async () => {
  const me = athlete(ava);
  let home = (await me('GET', '/app/api/home')).body;
  const latest = home.history[0];
  assert.equal(home.reopen_id, latest.id);
  const detail = (await me('GET', `/app/api/logs/${latest.id}`)).body;
  assert.equal(detail.can_reopen, true);
  const sqId = detail.exercises[0].id;
  assert.deepEqual(detail.exercises.map((x) => [x.name, x.done, x.sets.length]), [['Back squat', true, 1], ['Front plank', false, 0]]);
  const saved = await me('PUT', `/app/api/logs/${latest.id}`, { rpe: 6, notes: 'Forgot my last sets', sets: [1, 2].map((n) => ({ workout_exercise_id: sqId, set_no: n, weight: 160, reps: 5 })) });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.finished.sets, saved.body.finished.rpe, saved.body.finished.edited], [2, 6, true]);
  assert.equal((await me('PUT', `/app/api/logs/${latest.id}`, { rpe: 6, notes: 'Forgot my last sets', sets: [1, 2].map((n) => ({ workout_exercise_id: sqId, set_no: n, weight: 160, reps: 5 })) })).body.finished.sets, 2, 'sending it twice changes nothing');
  const older = home.history[1];
  const r = await me('PUT', `/app/api/logs/${older.id}`, {});
  assert.deepEqual([r.status, r.body.error.message], [409, 'Only your most recent workout can be reopened.']);
  app.ctx.db.run('UPDATE workout_logs SET completed_at = ? WHERE id = ?', new Date(Date.now() - 3 * 3600000).toISOString(), latest.id);
  app.ctx.db.run('UPDATE workout_logs SET completed_at = ? WHERE id = ?', new Date(Date.now() - 4 * 3600000).toISOString(), older.id);
  const late = await me('PUT', `/app/api/logs/${latest.id}`, {});
  assert.equal(late.status, 409);
  assert.match(late.body.error.message, /reopened for 2 hours/);
  home = (await me('GET', '/app/api/home')).body;
  assert.equal(home.reopen_id, null);
});

test('one athlete can\'t read, reopen or log another athlete\'s workouts', async () => {
  const avaLog = (await athlete(ava)('GET', '/app/api/home')).body.history[0].id;
  const other = athlete(ben);
  assert.equal((await other('GET', `/app/api/logs/${avaLog}`)).status, 404);
  assert.equal((await other('PUT', `/app/api/logs/${avaLog}`, { rpe: 1 })).status, 404);
  assert.equal(app.ctx.db.get('SELECT rpe FROM workout_logs WHERE id = ?', avaLog).rpe, 6, 'unchanged');
  // A workout from a program Ben isn't on.
  const p2 = (await coach('POST', '/v1/programs', { name: 'Other', weeks: 1 })).body;
  const w = (await coach('POST', `/v1/programs/${p2.id}/workouts`, { week: 1, title: 'Not yours' })).body;
  const r = await other('POST', `/app/api/workouts/${w.id}/complete`, {});
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /Your coach changed your program/);
  // Another athlete's request id doesn't return their workout.
  const own = await other('POST', `/app/api/workouts/${w1.id}/complete`, { request_id: 'ava-w1-1' });
  assert.equal(own.status, 201);
  assert.notEqual(own.body.repeat, true);
  assert.equal(app.ctx.db.get('SELECT client_id FROM workout_logs WHERE id = ?', own.body.id).client_id, ben.id);
  assert.equal((await fetch(`${base}/app/api/logs/${avaLog}`, { headers: { 'x-client-token': 'made-up' } })).status, 401);
});

test('a workout saved offline counts on the day it was done (up to 72 hours back)', async () => {
  const me = athlete(ben);
  const yesterday = new Date(Date.now() - 20 * 3600000).toISOString();
  const r = await me('POST', `/app/api/workouts/${w2.id}/complete`, { request_id: 'ben-w2', finished_at: yesterday, started_at: new Date(Date.parse(yesterday) - 30 * MIN).toISOString() });
  assert.equal(r.body.finished.completed_at, yesterday);
  assert.equal(r.body.finished.minutes, 30);
  const longAgo = await me('POST', `/app/api/workouts/${w3.id}/complete`, { request_id: 'ben-w3', finished_at: '2020-01-01T00:00:00.000Z' });
  assert.ok(Date.parse(longAgo.body.finished.completed_at) > Date.now() - MIN, 'too old: saved as now');
});

test('paused and archived athletes can\'t log', async () => {
  const cole = (await coach('POST', '/v1/clients', { name: 'Cole Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  member(cole, 'paused');
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: cole.id });
  const home = (await athlete(cole)('GET', '/app/api/home')).body;
  assert.equal(home.locked, true);
  assert.equal((await athlete(cole)('POST', `/app/api/workouts/${w1.id}/complete`, {})).status, 409);
  // A program bought online opens the app, but not once the athlete is archived.
  app.ctx.db.run(`INSERT INTO purchases (id, client_id, item_kind, item_id, title, amount_cents, status, created_at) VALUES (?, ?, 'program', ?, 'Strength block', 4900, 'active', ?)`, newId('pur'), cole.id, program.id, app.ctx.now());
  assert.equal((await athlete(cole)('GET', '/app/api/home')).body.locked, false);
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), cole.id);
  const arch = (await athlete(cole)('GET', '/app/api/home')).body;
  assert.deepEqual([arch.locked, arch.message], [true, 'Your profile is on hold. Message your coach to get back in.']);
  assert.equal((await athlete(cole)('POST', `/app/api/workouts/${w1.id}/complete`, {})).status, 409);
  // A resend of a Finish saved before the pause returns that save instead of "couldn't be saved".
  const ben2 = athlete(ben);
  const saved = app.ctx.db.get('SELECT request_id FROM workout_logs WHERE client_id = ? AND request_id IS NOT NULL LIMIT 1', ben.id);
  app.ctx.db.run(`UPDATE subscriptions SET status = 'paused' WHERE client_id = ?`, ben.id);
  const again = await ben2('POST', `/app/api/workouts/${w1.id}/complete`, { request_id: saved.request_id });
  assert.deepEqual([again.status, again.body.repeat], [201, true]);
  assert.equal((await ben2('POST', `/app/api/workouts/${w5.id}/complete`, { request_id: 'ben-new-while-paused' })).status, 409, 'a new one is still refused');
  app.ctx.db.run(`UPDATE subscriptions SET status = 'active' WHERE client_id = ?`, ben.id);
});

test('the weight-room screen and the app log the same workout once', async () => {
  session = newId('cls');
  const s = new Date(Date.now() - 10 * MIN).toISOString(), e = new Date(Date.now() + 50 * MIN).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at, workout_id) VALUES (?, 'Team lift', 'group', 'loc_f', ?, ?, 10, 'scheduled', ?, ?)`, session, s, e, s, w4.id);
  for (const c of [ava, ben]) app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'membership', ?, ?)`, newId('bkg'), session, c.id, app.ctx.now(), app.ctx.now());
  const board = (await tv('GET', '/kiosk-api/screen')).body.sessions[0];
  const [a, b] = board.athletes;

  // Ava logs Lift 2.1 in the app first (w3 first, so w4 is next), then taps her name on the screen: no second log.
  const me = athlete(ava);
  let home = (await me('GET', '/app/api/home')).body;
  assert.equal(home.workout.id, w3.id);
  await me('POST', `/app/api/workouts/${w3.id}/complete`, { request_id: 'ava-w3' });
  home = (await me('GET', '/app/api/home')).body;
  assert.equal(home.workout.id, w4.id);
  const sqW4 = home.workout.exercises[0];
  assert.equal(sqW4.load.lb, 150, 'the app and the screen show the same weight');
  assert.equal((await tv('POST', '/kiosk-api/screen/athlete', { session_id: session, ref: a.ref })).body.weights[0].text, '150 lb');
  await me('POST', `/app/api/workouts/${w4.id}/complete`, { request_id: 'ava-w4', sets: [{ workout_exercise_id: sqW4.id, set_no: 1, weight: 150, reps: 5 }] });
  const linked = await tv('POST', '/kiosk-api/screen/log', { session_id: session, ref: a.ref });
  assert.deepEqual([linked.status, linked.body.already], [201, true]);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE client_id = ? AND workout_id = ?', ava.id, w4.id).n, 1);
  assert.equal(app.ctx.db.get('SELECT session_id FROM workout_logs WHERE client_id = ? AND workout_id = ?', ava.id, w4.id).session_id, session);
  assert.equal(app.ctx.db.get('SELECT status FROM bookings WHERE session_id = ? AND client_id = ?', session, ava.id).status, 'attended', 'checked in');

  // Ben logs on the screen first (it counts toward his program), then finishes in the app with sets: they join that log.
  assert.equal((await tv('POST', '/kiosk-api/screen/log', { session_id: session, ref: b.ref, sets: [{ workout_exercise_id: 'wex_nope', set_no: 1 }] })).status, 400, 'screen sets are checked the same way');
  assert.equal((await tv('POST', '/kiosk-api/screen/log', { session_id: session, ref: b.ref })).status, 201);
  const benHome = (await athlete(ben)('GET', '/app/api/home')).body;
  assert.notEqual(benHome.workout?.id, w4.id, 'the app shows it done');
  const benSq = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.find((w) => w.id === w4.id).exercises[0];
  const merged = await athlete(ben)('POST', `/app/api/workouts/${w4.id}/complete`, { request_id: 'ben-w4', rpe: 5, sets: [{ workout_exercise_id: benSq.id, set_no: 1, weight: 95, reps: 5 }] });
  assert.deepEqual([merged.status, merged.body.merged, merged.body.finished.sets, merged.body.finished.rpe], [201, true, 1, 5]);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE client_id = ? AND workout_id = ?', ben.id, w4.id).n, 1);
  // A resend of that finish returns the same log; a new finish without sets is refused.
  assert.equal((await athlete(ben)('POST', `/app/api/workouts/${w4.id}/complete`, { request_id: 'ben-w4' })).body.repeat, true);
  assert.equal((await athlete(ben)('POST', `/app/api/workouts/${w4.id}/complete`, { request_id: 'ben-w4-again' })).status, 409);
  const feed = (await coach('GET', '/v1/completions')).body.data.find((l) => l.client_id === ben.id && l.workout_id === w4.id);
  assert.deepEqual([feed.source, feed.sets, feed.rpe], ['screen', 1, 5]);
});
