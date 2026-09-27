// Athlete workout app: logging sets, last time and bests, effort rating, reopening, past workout detail.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-workout-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const db = require('../server/db');
const workout = require('../server/services/ops-workout');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b) };
}
async function coach() {
  const c = client();
  const r = await c.post('/api/auth/staff/login', { email: 'coach@demo.test', password: 'demo-coach-2026' });
  assert.equal(r.status, 200);
  return c;
}

// A small program where the same exercise comes back, assigned to an athlete with no workouts yet.
async function setup(firstName) {
  const c = await coach();
  const pid = (await c.post('/api/programs', { name: `Sets block ${firstName}`, weeks: 2 })).data.id;
  const goblet = db.get("SELECT id FROM exercises WHERE name='Goblet squat'").id;
  const plank = db.get("SELECT id FROM exercises WHERE name='Front plank'").id;
  const days = [];
  for (const title of ['Day A', 'Day B', 'Day C']) {
    const d = (await c.post(`/api/programs/${pid}/days`, { week: 1, title })).data.id;
    await c.post(`/api/program-days/${d}/items`, { exercise_id: goblet, sets: '3', reps: '8' });
    await c.post(`/api/program-days/${d}/items`, { exercise_id: plank, sets: '2', reps: '30 sec' });
    days.push(d);
  }
  const a = db.get('SELECT * FROM athletes WHERE first_name=?', firstName);
  assert.equal((await c.post(`/api/programs/${pid}/assign`, { athlete_id: a.id })).status, 200);
  return { a: db.get('SELECT * FROM athletes WHERE id=?', a.id), days, w: client() };
}

test('targets: sets and reps are read from what the coach typed', () => {
  assert.equal(workout.targetSets('3'), 3);
  assert.equal(workout.targetSets(''), 1);
  assert.equal(workout.targetSets('3-4'), 3);
  assert.equal(workout.targetSets('25'), 10);
  assert.equal(workout.targetReps('8'), 8);
  assert.equal(workout.targetReps('10 each side'), 10);
  assert.equal(workout.targetReps('20 sec'), null);
  assert.equal(workout.targetReps('20 yd'), null);
});

test('log sets: validation, done after the last set, clearing, editing', async () => {
  const { a, w } = await setup('Isabela');
  const T = `/api/w/${a.workout_token}`;
  let s = (await w.get(T)).data;
  const [squat, plank] = s.current.items;
  assert.equal(squat.target_sets, 3); assert.equal(squat.target_reps, 8);
  assert.equal(plank.target_sets, 2); assert.equal(plank.target_reps, null);
  assert.equal(squat.last, null);
  assert.equal(s.upcoming.length, 2);
  assert.deepEqual(s.upcoming[0].exercises, ['Goblet squat', 'Front plank']);
  const day = s.current.day_id;

  assert.equal((await w.post('/api/w/not-a-real-token/set', { day_id: day, item_id: squat.id, set_no: 1 })).status, 404);
  for (const bad of [{ set_no: 0 }, { set_no: 13 }, { set_no: 1.5 }, { set_no: 1, weight: -5 }, { set_no: 1, weight: 'heavy' }, { set_no: 1, weight: 2001 }, { set_no: 1, reps: 2.5 }, { set_no: 1, reps: 501 }]) {
    const r = await w.post(`${T}/set`, { day_id: day, item_id: squat.id, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.data.error, /\w/);
  }
  assert.equal((await w.post(`${T}/set`, { day_id: day, item_id: 999999, set_no: 1 })).status, 400);
  assert.equal((await w.post(`${T}/set`, { day_id: 999999, item_id: squat.id, set_no: 1 })).status, 409);
  assert.equal(db.get('SELECT COUNT(*) n FROM workout_logs WHERE athlete_id=?', a.id).n, 0, 'nothing saved by bad requests');

  let r = await w.post(`${T}/set`, { day_id: day, item_id: squat.id, set_no: 1, weight: '35', reps: 8 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.sets, [{ item_id: squat.id, set_no: 1, weight: 35, reps: 8 }]);
  assert.deepEqual(r.data.done, [], 'not done after one of three sets');
  // Same set again updates it rather than adding one.
  r = await w.post(`${T}/set`, { day_id: day, item_id: squat.id, set_no: 1, weight: 37.5, reps: 8 });
  assert.equal(r.data.sets.length, 1); assert.equal(r.data.sets[0].weight, 37.5);
  await w.post(`${T}/set`, { day_id: day, item_id: squat.id, set_no: 2, weight: 40, reps: 8 });
  r = await w.post(`${T}/set`, { day_id: day, item_id: squat.id, set_no: 3, weight: 40, reps: 6 });
  assert.deepEqual(r.data.done, [squat.id], 'done after the last set');
  // Clearing a set un-marks the exercise; logging it again marks it done again.
  r = await w.post(`${T}/set`, { day_id: day, item_id: squat.id, set_no: 3, done: false });
  assert.deepEqual(r.data.done, []); assert.equal(r.data.sets.length, 2);
  r = await w.post(`${T}/set`, { day_id: day, item_id: squat.id, set_no: 3, weight: 40, reps: 7 });
  assert.deepEqual(r.data.done, [squat.id]);
  // Timed exercise: no weight, no reps, still counts.
  await w.post(`${T}/set`, { day_id: day, item_id: plank.id, set_no: 1 });
  r = await w.post(`${T}/set`, { day_id: day, item_id: plank.id, set_no: 2, weight: '', reps: null });
  assert.deepEqual(r.data.done.sort(), [squat.id, plank.id].sort());
  // An extra set beyond the plan is fine; the whole-exercise Log still works alongside sets.
  r = await w.post(`${T}/set`, { day_id: day, item_id: squat.id, set_no: 4, weight: 25, reps: 12 });
  assert.equal(r.data.sets.filter((x) => x.item_id === squat.id).length, 4);
  r = await w.post(`${T}/log`, { day_id: day, item_id: plank.id, done: false });
  assert.deepEqual(r.data.done, [squat.id]);
  assert.equal(r.data.sets.filter((x) => x.item_id === plank.id).length, 2, 'un-logging the exercise keeps its sets');
  s = (await w.get(T)).data;
  assert.equal(s.current.log.sets.length, 6);
  assert.ok(s.current.log.started_at);
});

test('finish: effort rating, sets in the activity log and webhook, then last time and new bests', async () => {
  const { a, w, days } = await setup('Olivia');
  const T = `/api/w/${a.workout_token}`;
  let s = (await w.get(T)).data;
  let [squat] = s.current.items;
  for (const n of [1, 2, 3]) await w.post(`${T}/set`, { day_id: s.current.day_id, item_id: squat.id, set_no: n, weight: 30 + n * 5, reps: 8 });
  assert.equal((await w.post(`${T}/finish`, { day_id: s.current.day_id, rpe: 11 })).status, 400);
  assert.equal((await w.post(`${T}/finish`, { day_id: s.current.day_id, rpe: 6.5 })).status, 400);
  assert.equal(db.get('SELECT COUNT(*) n FROM workout_logs WHERE athlete_id=? AND day_id=? AND finished_at IS NOT NULL', a.id, days[0]).n, 0, 'bad ratings finish nothing');
  const hook = db.insert('webhooks', { url: 'http://127.0.0.1:9/hook', events: JSON.stringify(['workout.completed']), secret: 'x', active: 1 });
  let r = await w.post(`${T}/finish`, { day_id: s.current.day_id, rpe: 7, note: 'Solid' });
  assert.equal(r.status, 200);
  const payload = JSON.parse(db.get('SELECT payload FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC', hook).payload).data;
  db.run('UPDATE webhooks SET active=0 WHERE id=?', hook);
  assert.equal(payload.rpe, 7);
  assert.deepEqual(payload.sets, [{ exercise: 'Goblet squat', sets: [35, 40, 45].map((wt, k) => ({ set_no: k + 1, weight: wt, reps: 8 })) }]);
  assert.equal(r.data.finished.rpe, 7);
  assert.equal(r.data.finished.sets, 3);
  assert.deepEqual(r.data.finished.bests, [], 'no best on the first time');
  const log = db.get('SELECT * FROM workout_logs WHERE id=?', r.data.finished.log_id);
  assert.equal(log.rpe, 7); assert.equal(log.note, 'Solid');
  const act = db.get("SELECT * FROM activity WHERE action LIKE 'Workout logged: Olivia Park, Day A' ORDER BY id DESC");
  assert.match(act.detail, /effort 7\/10/); assert.match(act.detail, /3 sets/);
  assert.equal(r.data.state.history[0].rpe, 7);
  assert.equal(r.data.state.history[0].sets, 3);

  // Next workout: the same exercise shows last time and the best so far.
  s = r.data.state;
  [squat] = s.current.items;
  assert.equal(s.current.title, 'Day B');
  assert.equal(squat.best_weight, 45);
  assert.deepEqual(squat.last.sets.map((x) => x.weight), [35, 40, 45]);
  for (const [n, wt] of [[1, 50], [2, 45], [3, 45]]) await w.post(`${T}/set`, { day_id: s.current.day_id, item_id: squat.id, set_no: n, weight: wt, reps: 5 });
  r = await w.post(`${T}/finish`, { day_id: s.current.day_id });
  assert.deepEqual(r.data.finished.bests, [{ name: 'Goblet squat', weight: 50, previous: 45 }]);
  assert.equal(r.data.finished.rpe, null, 'effort is optional');
  assert.match(db.get("SELECT detail FROM activity WHERE action LIKE 'Workout logged: Olivia Park, Day B'").detail, /new best: Goblet squat 50 lb/);
});

test('past workout detail: every exercise with its sets, only for this athlete', async () => {
  const { a, w } = await setup('Mason');
  const T = `/api/w/${a.workout_token}`;
  const s = (await w.get(T)).data;
  const [squat, plank] = s.current.items;
  await w.post(`${T}/set`, { day_id: s.current.day_id, item_id: squat.id, set_no: 1, weight: 55, reps: 8 });
  await w.post(`${T}/log`, { day_id: s.current.day_id, item_id: plank.id, done: true });
  const fin = (await w.post(`${T}/finish`, { day_id: s.current.day_id, note: 'Short on time', rpe: 5 })).data;
  const d = (await w.get(`${T}/history/${fin.finished.log_id}`)).data;
  assert.equal(d.title, 'Day A'); assert.equal(d.rpe, 5); assert.equal(d.note, 'Short on time');
  assert.deepEqual(d.items.map((i) => [i.name, i.done]), [['Goblet squat', false], ['Front plank', true]]);
  assert.deepEqual(d.items.find((i) => i.id === squat.id).logged, [{ set_no: 1, weight: 55, reps: 8 }]);
  assert.deepEqual(d.items.find((i) => i.id === plank.id).logged, []);
  // Another athlete's link can't read it; nonsense ids are not found.
  const other = db.get("SELECT workout_token FROM athletes WHERE first_name='Chidi'").workout_token;
  assert.equal((await w.get(`/api/w/${other}/history/${fin.finished.log_id}`)).status, 404);
  assert.equal((await w.get(`${T}/history/abc`)).status, 404);
});

test('reopen: undo Finish on the latest workout, within the window, before the next one starts', async () => {
  const { a, w } = await setup('Jaylen');
  const T = `/api/w/${a.workout_token}`;
  let s = (await w.get(T)).data;
  const dayA = s.current.day_id;
  await w.post(`${T}/log`, { day_id: dayA, item_id: s.current.items[0].id, done: true });
  let fin = (await w.post(`${T}/finish`, { day_id: dayA, rpe: 8 })).data;
  const firstLog = fin.finished.log_id;
  // Reopen straight away: Day A is current again, with what was logged.
  let r = await w.post(`${T}/reopen`, { log_id: firstLog });
  assert.equal(r.status, 200);
  assert.equal(r.data.state.current.day_id, dayA);
  assert.deepEqual(r.data.state.current.log.done, [s.current.items[0].id]);
  assert.equal(db.get('SELECT finished_at FROM workout_logs WHERE id=?', firstLog).finished_at, null);
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Workout reopened: Jaylen Brooks, Day A'"));
  // Finish it again, then start Day B: Day A can no longer be reopened.
  fin = (await w.post(`${T}/finish`, { day_id: dayA })).data;
  s = fin.state;
  await w.post(`${T}/log`, { day_id: s.current.day_id, item_id: s.current.items[0].id, done: true });
  r = await w.post(`${T}/reopen`, { log_id: firstLog });
  assert.equal(r.status, 400); assert.match(r.data.error, /already started your next workout/);
  // Finish Day B; Day A is no longer the latest.
  fin = (await w.post(`${T}/finish`, { day_id: s.current.day_id })).data;
  r = await w.post(`${T}/reopen`, { log_id: firstLog });
  assert.equal(r.status, 400); assert.match(r.data.error, /most recent/);
  // Too long ago.
  db.run("UPDATE workout_logs SET finished_at=datetime('now','-4 hours') WHERE id=?", firstLog);
  db.run("UPDATE workout_logs SET finished_at=datetime('now','-3 hours') WHERE id=?", fin.finished.log_id);
  r = await w.post(`${T}/reopen`, { log_id: fin.finished.log_id });
  assert.equal(r.status, 400); assert.match(r.data.error, /2 hours/);
  // Someone else's workout, or nonsense: not found.
  const other = db.get("SELECT workout_token FROM athletes WHERE first_name='Chidi'").workout_token;
  assert.equal((await w.post(`/api/w/${other}/reopen`, { log_id: firstLog })).status, 404);
  assert.equal((await w.post(`${T}/reopen`, {})).status, 404);
});

test('no program yet: the app still shows finished workouts', async () => {
  const a = db.get("SELECT * FROM athletes WHERE first_name='Chidi'");
  const s = workout.state({ ...a, program_id: null });
  assert.equal(s.program, null);
  assert.ok(Array.isArray(s.history) && s.history.length > 0);
});

test('demo data: finished workouts carry sets, effort and a duration', () => {
  assert.ok(db.get('SELECT COUNT(*) n FROM workout_sets').n > 50);
  const a = db.get("SELECT * FROM athletes WHERE first_name='Emma'");
  const s = workout.state(a);
  assert.ok(s.history.every((h) => h.rpe >= 1 && h.minutes >= 30));
  assert.ok(s.current.items.some((i) => i.last), 'a repeated exercise shows last time');
});
