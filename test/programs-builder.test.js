import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

// The program builder: weeks, copying, swapping and undoing, duplicating, the exercise library, assigning, client
// progress and the Programs page. Front desk can look but not change anything.
let app, base, owner, coach, desk, ava, ben, cole;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const member = (c, status = 'active') => app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', ?, ?, ?, ?, ?)`,
  newId('sub'), c.id, status, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', '/v1/clients', { name: 'Ben Ortiz', parent: { name: 'Rosa Ortiz', email: 'rosa@example.com' } })).body;
  cole = (await coach('POST', '/v1/clients', { name: 'Cole Nguyen', parent: { name: 'Lan Nguyen', email: 'lan@example.com' } })).body;
  member(ava); member(ben); member(cole, 'paused');
});
after(() => app.server.close());

test('the exercise library: categories, one name each, usage, filters, and deleting only unused exercises', async () => {
  const squat = await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body', video_url: 'https://www.youtube.com/watch?v=abc' });
  assert.equal(squat.status, 201);
  assert.equal((await coach('POST', '/v1/exercises', { name: 'back SQUAT' })).status, 409, 'the same name twice is refused');
  const bad = await coach('POST', '/v1/exercises', { name: 'Arm circles', category: 'Arms' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /Choose a category: Speed, Power/);
  const circles = (await coach('POST', '/v1/exercises', { name: 'Arm circles', category: 'Arm care', instructions: 'Small circles, then big.' })).body;
  const lib = (await desk('GET', '/v1/exercises')).body;
  assert.ok(lib.categories.includes('Arm care'), 'front desk can look');
  assert.deepEqual(lib.data.map((e) => [e.name, e.uses]), [['Arm circles', 0], ['Back squat', 0]]);
  assert.deepEqual((await coach('GET', '/v1/exercises?filter=no_video')).body.data.map((e) => e.name), ['Arm circles']);
  assert.deepEqual((await coach('GET', '/v1/exercises?category=Lower%20body')).body.data.map((e) => e.name), ['Back squat']);
  assert.deepEqual((await coach('GET', '/v1/exercises?q=circles')).body.data.map((e) => e.name), ['Arm circles']);
  assert.equal((await desk('POST', '/v1/exercises', { name: 'Desk drill' })).status, 403, 'front desk can\'t add to the library');
  assert.equal((await desk('DELETE', `/v1/exercises/${circles.id}`)).status, 403);

  const p = (await coach('POST', '/v1/programs', { name: 'Arm care', weeks: 2 })).body;
  const w = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1 })).body;
  assert.deepEqual([w.day, w.title], [1, 'Day 1'], 'day and title default');
  await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: circles.id, prescription: '2 × 20' });
  const used = (await coach('GET', '/v1/exercises?filter=unused')).body.data.map((e) => e.name);
  assert.deepEqual(used, ['Back squat']);
  const refused = await coach('DELETE', `/v1/exercises/${circles.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /Arm circles is in Arm care\. Remove it from that program first\./);
  assert.equal((await coach('DELETE', `/v1/programs/${p.id}`)).status, 200);
  assert.equal((await coach('DELETE', `/v1/exercises/${circles.id}`)).status, 200, 'once its only program is gone it can go');
});

test('weeks: add days up to 7, copy a week to a run of weeks, replace only when asked, delete the last week', async () => {
  const ex = (await coach('POST', '/v1/exercises', { name: 'Goblet squat' })).body;
  const p = (await coach('POST', '/v1/programs', { name: 'Base block', weeks: 2 })).body;
  for (let d = 1; d <= 7; d++) await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, title: `Day ${d}` });
  const eighth = await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1 });
  assert.equal(eighth.status, 409);
  assert.match(eighth.body.error.message, /Week 1 already has 7 days/);
  assert.equal((await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 2, day: 8 })).status, 400, 'no day 8');
  // Back to two days in week 1.
  let detail = (await coach('GET', `/v1/programs/${p.id}`)).body;
  for (const w of detail.workouts.filter((x) => x.day > 2)) await coach('DELETE', `/v1/workouts/${w.id}`);
  detail = (await coach('GET', `/v1/programs/${p.id}`)).body;
  await coach('POST', `/v1/workouts/${detail.workouts[0].id}/exercises`, { exercise_id: ex.id, prescription: '3 × 10' });

  const copied = await coach('POST', `/v1/programs/${p.id}/weeks/1/copy`, { to: 2, through: 4 });
  assert.equal(copied.status, 200);
  assert.equal(copied.body.weeks, 4, 'the program grows to the last week copied to');
  assert.deepEqual([2, 3, 4].map((wk) => copied.body.workouts.filter((w) => w.week === wk).length), [2, 2, 2]);
  assert.equal(copied.body.workouts.find((w) => w.week === 3 && w.day === 1).exercises[0].prescription, '3 × 10', 'exercises come along');
  const again = await coach('POST', `/v1/programs/${p.id}/weeks/1/copy`, { to: 3 });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'replace_needed');
  assert.match(again.body.error.message, /Week 3 already has workouts\. Replace them to copy\./);
  assert.equal((await coach('POST', `/v1/programs/${p.id}/weeks/1/copy`, { to: 3, replace: true })).status, 200);
  assert.equal((await coach('POST', `/v1/programs/${p.id}/weeks/2/copy`, { to: 2 })).status, 400, 'not onto itself');

  const shorter = await coach('PATCH', `/v1/programs/${p.id}`, { weeks: 3 });
  assert.equal(shorter.status, 409);
  assert.match(shorter.body.error.message, /Week 4 still has workouts\. Delete week 4 first, or keep 4 weeks\./);
  const del = await coach('DELETE', `/v1/programs/${p.id}/weeks/4`);
  assert.equal(del.body.weeks, 3, 'deleting the last week shortens the program');
  // An empty last week (Add week by mistake) can be deleted too.
  await coach('PATCH', `/v1/programs/${p.id}`, { weeks: 4 });
  assert.equal((await coach('DELETE', `/v1/programs/${p.id}/weeks/4`)).body.weeks, 3);
  assert.equal((await coach('DELETE', `/v1/programs/${p.id}/weeks/2`, {})).body.weeks, 3, 'a middle week is cleared, not removed');
  assert.equal((await desk('POST', `/v1/programs/${p.id}/weeks/1/copy`, { to: 2 })).status, 403, 'front desk can\'t');
});

test('copy a workout, swap an exercise, remove one and undo it back into place, rename a workout', async () => {
  const [a, b, c] = await Promise.all(['Push-up', 'Plank', 'Row'].map(async (name) => (await coach('POST', '/v1/exercises', { name })).body));
  const p = (await coach('POST', '/v1/programs', { name: 'Upper', weeks: 2 })).body;
  const w = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 1, title: 'Push' })).body;
  for (const [x, rx] of [[a, '4 × 8'], [b, '3 × 40 sec'], [c, '3 × 10']]) await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: x.id, prescription: rx });
  const copy = await coach('POST', `/v1/workouts/${w.id}/copy`, { week: 2 });
  assert.equal(copy.status, 201);
  assert.deepEqual([copy.body.week, copy.body.day, copy.body.title, copy.body.exercises.map((x) => x.name)], [2, 1, 'Push', ['Push-up', 'Plank', 'Row']]);
  const clash = await coach('POST', `/v1/workouts/${w.id}/copy`, { week: 2, day: 1 });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error.message, /Week 2, day 1 already has a workout\. Pick another day\./);

  let exercises = (await coach('GET', `/v1/programs/${p.id}`)).body.workouts[0].exercises;
  const swapped = (await coach('PATCH', `/v1/workout-exercises/${exercises[0].id}`, { exercise_id: c.id })).body;
  assert.deepEqual([swapped.name, swapped.prescription], ['Row', '4 × 8'], 'the slot keeps its sets and reps');
  await coach('PATCH', `/v1/workout-exercises/${exercises[0].id}`, { exercise_id: a.id });

  const removed = (await coach('DELETE', `/v1/workout-exercises/${exercises[1].id}`)).body;
  assert.deepEqual(removed.restore, { workout_id: w.id, exercise_id: b.id, prescription: '3 × 40 sec', load_test: null, load_pct: null, position: 2,
    sets: 3, reps: '40 sec', tempo: null, rest_seconds: null, target_rpe: null, load_text: null, group_label: null, group_kind: null, note: null, form_check: 0, form_check_note: null });
  exercises = (await coach('GET', `/v1/programs/${p.id}`)).body.workouts[0].exercises;
  assert.deepEqual(exercises.map((x) => [x.name, x.position]), [['Push-up', 1], ['Row', 2]]);
  const { workout_id, ...back } = removed.restore;
  const undone = (await coach('POST', `/v1/workouts/${workout_id}/exercises`, back)).body;
  assert.deepEqual(undone.exercises.map((x) => [x.name, x.position]), [['Push-up', 1], ['Plank', 2], ['Row', 3]], 'Undo puts it back where it was');

  assert.equal((await coach('PATCH', `/v1/workouts/${w.id}`, { title: 'Push day' })).body.title, 'Push day');
  assert.equal((await coach('PATCH', `/v1/workouts/${w.id}`, { title: '' })).status, 400);
  assert.equal((await desk('PATCH', `/v1/workout-exercises/${exercises[0].id}`, { prescription: '1 × 1' })).status, 403);
});

test('new program as a copy, and Duplicate program', async () => {
  const src = (await coach('GET', '/v1/programs')).body.data.find((x) => x.name === 'Base block');
  const copy = await coach('POST', '/v1/programs', { name: 'Base block, short', weeks: 2, copy_from: src.id });
  assert.equal(copy.status, 201);
  assert.deepEqual([copy.body.weeks, copy.body.workouts.length], [2, 2], 'only the weeks kept (week 2 was cleared)');
  const dup = await coach('POST', `/v1/programs/${src.id}/duplicate`, {});
  assert.equal(dup.status, 201);
  assert.deepEqual([dup.body.name, dup.body.weeks, dup.body.workouts.length, dup.body.for_sale], ['Base block (copy)', 3, 4, 0]);
  assert.equal((await desk('POST', `/v1/programs/${src.id}/duplicate`, {})).status, 403);
});

test('assigning: current program shown, moving says so, the same twice and archived clients refused, removing', async () => {
  const [p1, p2] = (await coach('GET', '/v1/programs')).body.data.filter((x) => ['Upper', 'Base block'].includes(x.name));
  const first = await coach('POST', `/v1/programs/${p1.id}/assign`, { client_id: ava.id });
  assert.deepEqual([first.status, first.body.previous_program], [201, null]);
  const twice = await coach('POST', `/v1/programs/${p1.id}/assign`, { client_id: ava.id });
  assert.equal(twice.status, 409);
  assert.match(twice.body.error.message, /Ava is already on /);
  const moved = (await coach('POST', `/v1/programs/${p2.id}/assign`, { client_id: ava.id })).body;
  assert.deepEqual(moved.previous_program, { id: p1.id, name: p1.name });
  assert.equal((await desk('POST', `/v1/programs/${p1.id}/assign`, { client_id: ben.id })).status, 403, 'front desk doesn\'t assign');

  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), cole.id);
  const arch = await coach('POST', `/v1/programs/${p1.id}/assign`, { client_id: cole.id });
  assert.equal(arch.status, 409);
  assert.match(arch.body.error.message, /Cole is archived\. Bring them back/);
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', cole.id);

  assert.equal((await desk('DELETE', `/v1/programs/${p2.id}/clients/${ava.id}`)).status, 403);
  assert.equal((await coach('DELETE', `/v1/programs/${p1.id}/clients/${ava.id}`)).status, 404, 'not on that one any more');
  assert.equal((await coach('DELETE', `/v1/programs/${p2.id}/clients/${ava.id}`)).body.removed, true);
  assert.equal((await coach('GET', `/v1/clients/${ava.id}`)).body.program, null);
});

test('clients on a program and the Programs page: progress, needs a check-in, finished, recent workouts; archived left out', async () => {
  const ex = (await coach('POST', '/v1/exercises', { name: 'Sprint' })).body;
  const p = (await coach('POST', '/v1/programs', { name: 'Speed', weeks: 1, level: 'Beginner' })).body;
  const w1 = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, title: 'Accel' })).body;
  const w2 = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, title: 'Top speed' })).body;
  for (const w of [w1, w2]) await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: ex.id, prescription: '6 × 20 yd' });
  for (const c of [ava, ben, cole]) await coach('POST', `/v1/programs/${p.id}/assign`, { client_id: c.id });
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
  app.ctx.db.run('UPDATE assignments SET start_date = ? WHERE program_id = ?', tenDaysAgo, p.id);
  const token = (c) => app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', c.id).access_token;
  const finish = (c, w, body) => fetch(`${base}/app/api/workouts/${w.id}/complete`, { method: 'POST', headers: { 'x-client-token': token(c), 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  // Ava finishes both workouts; Ben none (10 days: needs a check-in); Cole is paused (can't open the app, so not flagged).
  const wex1 = (await coach('GET', `/v1/programs/${p.id}`)).body.workouts[0].exercises[0].id;
  await finish(ava, w1, { sets: [{ workout_exercise_id: wex1, set_no: 1 }], rpe: 7, notes: 'Quick feet today' });
  await finish(ava, w2, { exercise_ids: [(await coach('GET', `/v1/programs/${p.id}`)).body.workouts[1].exercises[0].id] });

  const detail = (await coach('GET', `/v1/programs/${p.id}`)).body;
  assert.deepEqual(detail.clients.map((c) => [c.name, c.done, c.total, c.complete, c.quiet, c.app_open]),
    [['Ava Lopez', 2, 2, true, false, true], ['Ben Ortiz', 0, 2, false, true, true], ['Cole Nguyen', 0, 2, false, false, false]]);
  assert.deepEqual(detail.clients[1].next, { id: w1.id, week: 1, day: 1, title: 'Accel', date: detail.clients[1].next.date, status: 'missed' });   // dated by the training calendar (version 62)
  assert.equal(detail.clients[1].days_idle, 10);
  assert.deepEqual(detail.workouts.map((w) => w.logs), [1, 1]);
  assert.equal(detail.logged_7d, 2);

  const act = (await desk('GET', `/v1/programs/activity?program_id=${p.id}`)).body;
  assert.deepEqual([act.logged_7d, act.on_programs, act.quiet.map((c) => c.name), act.complete.map((c) => c.name)], [2, 3, ['Ben Ortiz'], ['Ava Lopez']]);
  assert.deepEqual(act.recent.map((r) => [r.workout_title, r.rpe, r.sets, r.notes]), [['Top speed', null, 0, null], ['Accel', 7, 1, 'Quick feet today']]);
  const list = (await coach('GET', '/v1/programs')).body.data.find((x) => x.id === p.id);
  assert.deepEqual([list.client_count, list.days_per_week, list.logged_7d], [3, 2, 2]);

  // Archived: off the program's client list, counts and feed.
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), ava.id);
  const after = (await coach('GET', `/v1/programs/activity?program_id=${p.id}`)).body;
  assert.deepEqual([after.logged_7d, after.on_programs, after.recent.length, after.complete.length], [0, 2, 0, 0]);
  assert.equal((await coach('GET', '/v1/programs')).body.data.find((x) => x.id === p.id).client_count, 2);
  assert.equal((await coach('GET', `/v1/clients/${ava.id}/workouts`)).body.data.length, 2, 'their own page still lists them');
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', ava.id);
});

test('deleting a week athletes logged needs confirm, and says those logs stay in their history', async () => {
  const p = (await coach('GET', '/v1/programs')).body.data.find((x) => x.name === 'Speed');
  const r = await coach('DELETE', `/v1/programs/${p.id}/weeks/1`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'confirm_needed');
  assert.match(r.body.error.message, /Week 1 has 2 logged workouts\. Those logs stay in the athletes' history but leave this program's numbers\./);
  const copy = await coach('POST', `/v1/programs/${p.id}/weeks/1/copy`, { to: 1, through: 1 });
  assert.equal(copy.status, 400);
  // One workout on its own: the same question.
  const logged = (await coach('GET', `/v1/programs/${p.id}`)).body.workouts.find((w) => w.logs > 0);
  const one = await coach('DELETE', `/v1/workouts/${logged.id}`, {});
  assert.deepEqual([one.status, one.body.error.code, one.body.error.details?.logs ?? logged.logs], [409, 'confirm_needed', logged.logs]);
  assert.ok(app.ctx.db.get('SELECT id FROM workouts WHERE id = ?', logged.id), 'nothing deleted');
});

test('a program with only archived clients on it can be deleted; current clients block it', async () => {
  const p = (await coach('POST', '/v1/programs', { name: 'Old block', weeks: 1 })).body;
  await coach('POST', `/v1/programs/${p.id}/assign`, { client_id: ben.id });
  assert.equal((await coach('DELETE', `/v1/programs/${p.id}`)).status, 409);
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), ben.id);
  assert.equal((await coach('DELETE', `/v1/programs/${p.id}`)).status, 200);
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', ben.id);
  assert.equal((await desk('DELETE', `/v1/programs/${p.id}`)).status, 403);
});
