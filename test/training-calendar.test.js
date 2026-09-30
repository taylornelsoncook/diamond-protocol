// The training calendar (schema 62): a program's weeks and days land on real dates for each athlete. The coach picks the
// start date and the training days when assigning (or later), every workout gets a date and a status (done, today,
// missed, upcoming), the app opens on today's workout and lets the athlete open any other from the calendar, and one
// workout can be moved to another date for one athlete without touching the plan.
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
import { dayOffsets, defaultDays, pickNext } from '../src/services/training-calendar.js';

let app, base, coach, owner, desk, maya, token, program, workouts;
const PW = 'correct-horse-battery';
// A Wednesday, 10 am in Chicago (the business time zone in tests).
const NOW = '2026-10-07T15:00:00.000Z', TODAY = '2026-10-07';
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
const cal = async () => (await coach('GET', `/v1/clients/${maya.id}/training-calendar`)).body;
const byTitle = (c, title) => c.workouts.find((w) => w.title === title);

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
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    newId('sub'), maya.id, plan.id, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', NOW, NOW);
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', maya.id).access_token;
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 2 })).body;
  workouts = {};
  for (const [week, day, title] of [[1, 1, 'Lower A'], [1, 2, 'Upper A'], [1, 3, 'Speed A'], [2, 1, 'Lower B'], [2, 2, 'Upper B'], [2, 3, 'Speed B']]) {
    const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week, day, title })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' });
    workouts[title] = w;
  }
});
after(() => app.server.close());

test('program days land on training weekdays in order from the start date; the usual spread fills in when nobody picked', () => {
  // Monday start, Mon/Wed/Fri: day 1 Monday, day 2 Wednesday, day 3 Friday; the other weekdays follow for a "day 4".
  assert.deepEqual(dayOffsets('2026-10-05', [1, 3, 5]).slice(0, 4), [0, 2, 4, 1]);
  // Wednesday start, the same days: day 1 Wednesday, day 2 Friday, day 3 the Monday after.
  assert.deepEqual(dayOffsets('2026-10-07', [1, 3, 5]).slice(0, 3), [0, 2, 5]);
  assert.deepEqual(dayOffsets('2026-10-04', [0, 1, 2, 3, 4, 5, 6]), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([defaultDays(1), defaultDays(3), defaultDays(4), defaultDays(9)], [[1], [1, 3, 5], [1, 2, 4, 5], [0, 1, 2, 3, 4, 5, 6]]);
  const list = [{ id: 'a', status: 'missed', date: '2026-10-01' }, { id: 'b', status: 'done', date: '2026-10-05' }, { id: 'c', status: 'today', date: '2026-10-07' }, { id: 'd', status: 'upcoming', date: '2026-10-09' }];
  assert.equal(pickNext(list).id, 'c', 'today first');
  assert.equal(pickNext(list.filter((w) => w.id !== 'c')).id, 'a', 'then the earliest missed');
  assert.equal(pickNext(list.filter((w) => w.status === 'upcoming')).id, 'd', 'else the next one coming up');
  assert.equal(pickNext([]), null);
});

test('assigning sets the calendar: a start date and training days, checked against the program', async () => {
  // Three days a week: two training days aren't enough.
  const few = await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id, start_date: '2026-10-05', training_days: [1, 3] });
  assert.equal(few.status, 400);
  assert.match(few.body.error.message, /3 training days a week/);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id, training_days: [1, 9] })).status, 400);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id, start_date: 'next monday' })).status, 400);
  // Started the Monday before "today" (Wednesday), Mon/Wed/Fri.
  const ok = await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id, start_date: '2026-10-05', training_days: '1,3,5' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.start_date, ok.body.training_days], ['2026-10-05', [1, 3, 5]]);
  const c = await cal();
  assert.deepEqual([c.start_date, c.training_days, c.days_needed, c.days_default, c.today, c.end_date], ['2026-10-05', [1, 3, 5], 3, false, TODAY, '2026-10-16']);
  assert.deepEqual(c.workouts.map((w) => [w.title, w.date, w.status]), [
    ['Lower A', '2026-10-05', 'missed'], ['Upper A', '2026-10-07', 'today'], ['Speed A', '2026-10-09', 'upcoming'],
    ['Lower B', '2026-10-12', 'upcoming'], ['Upper B', '2026-10-14', 'upcoming'], ['Speed B', '2026-10-16', 'upcoming']]);
  assert.deepEqual(c.counts, { done: 0, missed: 1, upcoming: 5, total: 6 });
  assert.equal(c.next.title, 'Upper A', 'the app opens on today\'s workout, not the missed one');
  // The program page says the same.
  const onProgram = (await coach('GET', `/v1/programs/${program.id}`)).body.clients.find((x) => x.id === maya.id);
  assert.deepEqual([onProgram.next.title, onProgram.next.date, onProgram.next.status, onProgram.missed, onProgram.done], ['Upper A', TODAY, 'today', 1, 0]);
  // Front desk may look, not change.
  assert.equal((await desk('GET', `/v1/clients/${maya.id}/training-calendar`)).status, 200);
  assert.equal((await desk('PATCH', `/v1/clients/${maya.id}/training-calendar`, { start_date: '2026-10-06' })).status, 403);
  assert.equal((await desk('POST', `/v1/clients/${maya.id}/training-calendar/moves`, { workout_id: workouts['Speed A'].id, date: '2026-10-10' })).status, 403);
});

test('the app opens on today\'s workout, shows the calendar, and the athlete can open a missed one and log it', async () => {
  let home = (await athlete('GET', '/app/api/home')).body;
  assert.deepEqual([home.workout.title, home.workout.date, home.workout.status], ['Upper A', TODAY, 'today']);
  assert.deepEqual([home.calendar.today, home.calendar.days_text, home.calendar.counts.missed], [TODAY, 'Mon, Wed, Fri', 1]);
  assert.equal(home.calendar.workouts.length, 6);
  assert.deepEqual(home.upcoming.map((u) => [u.title, u.date]), [['Lower A', '2026-10-05'], ['Speed A', '2026-10-09'], ['Lower B', '2026-10-12']]);
  assert.equal(home.progress.missed, 1);
  // Open Monday's from the calendar: the same shape as the home screen's workout, with its date.
  const lowerA = await athlete('GET', `/app/api/workouts/${workouts['Lower A'].id}`);
  assert.equal(lowerA.status, 200, JSON.stringify(lowerA.body));
  assert.deepEqual([lowerA.body.title, lowerA.body.date, lowerA.body.status], ['Lower A', '2026-10-05', 'missed']);
  assert.ok(lowerA.body.exercises[0].target_sets, 'exercises come with the app\'s fields');
  assert.equal((await athlete('GET', '/app/api/workouts/wo_nope')).status, 404);
  const fin = await athlete('POST', `/app/api/workouts/${workouts['Lower A'].id}/complete`, { request_id: 'r-lower-a', exercise_ids: [lowerA.body.exercises[0].id] });
  assert.equal(fin.status, 201, JSON.stringify(fin.body));
  assert.equal(fin.body.next.workout.title, 'Upper A', 'today\'s workout is still up');
  const again = await athlete('GET', `/app/api/workouts/${workouts['Lower A'].id}`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.details.log_id, fin.body.id);
  home = (await athlete('GET', '/app/api/home')).body;
  assert.deepEqual(home.calendar.workouts.find((w) => w.title === 'Lower A').status, 'done');
  assert.deepEqual(home.calendar.counts, { done: 1, missed: 0, upcoming: 5, total: 6 });
});

test('a rest day opens on the next workout coming up; a missed workout comes first', async () => {
  app.ctx.now = () => '2026-10-08T15:00:00.000Z';   // Thursday: nothing planned
  try {
    let home = (await athlete('GET', '/app/api/home')).body;
    assert.deepEqual([home.workout.title, home.workout.status], ['Upper A', 'missed'], 'Wednesday\'s wasn\'t logged');
    await athlete('POST', `/app/api/workouts/${workouts['Upper A'].id}/complete`, { request_id: 'r-upper-a' });
    home = (await athlete('GET', '/app/api/home')).body;
    assert.deepEqual([home.workout.title, home.workout.status, home.workout.date], ['Speed A', 'upcoming', '2026-10-09']);
  } finally { app.ctx.now = () => NOW; }
});

test('a coach moves one workout for one athlete; the plan and the other athletes are untouched; a logged one stays put', async () => {
  const move = await coach('POST', `/v1/clients/${maya.id}/training-calendar/moves`, { workout_id: workouts['Speed A'].id, date: '2026-10-10' });
  assert.equal(move.status, 200, JSON.stringify(move.body));
  const speedA = byTitle(move.body, 'Speed A');
  assert.deepEqual([speedA.date, speedA.moved, speedA.status], ['2026-10-10', true, 'upcoming']);
  assert.equal(byTitle(move.body, 'Lower B').date, '2026-10-12', 'the others stay');
  // Another athlete on the same program keeps the plan's dates.
  const ben = (await coach('POST', '/v1/clients', { name: 'Ben Diaz', parent: { name: 'Rosa Diaz', email: 'rosa@example.com' } })).body;
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ben.id, start_date: '2026-10-05', training_days: [1, 3, 5] })).status, 201);
  assert.equal(byTitle((await coach('GET', `/v1/clients/${ben.id}/training-calendar`)).body, 'Speed A').date, '2026-10-09');
  // The athlete sees the move; the app's "moved by your coach" reads it from here.
  assert.equal(byTitle((await athlete('GET', '/app/api/home')).body.calendar, 'Speed A').moved, true);
  // Back on its day.
  const back = await coach('POST', `/v1/clients/${maya.id}/training-calendar/moves`, { workout_id: workouts['Speed A'].id, date: null });
  assert.deepEqual([byTitle(back.body, 'Speed A').date, byTitle(back.body, 'Speed A').moved], ['2026-10-09', false]);
  // A logged workout can't be moved; a workout from another program isn't found; a bad date is refused.
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/training-calendar/moves`, { workout_id: workouts['Lower A'].id, date: '2026-10-20' })).status, 409);
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/training-calendar/moves`, { workout_id: 'wo_nope', date: '2026-10-20' })).status, 404);
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/training-calendar/moves`, { workout_id: workouts['Speed A'].id, date: 'soon' })).status, 400);
});

test('changing the schedule re-dates everything not logged and clears moves; logged workouts keep their dates', async () => {
  await coach('POST', `/v1/clients/${maya.id}/training-calendar/moves`, { workout_id: workouts['Speed A'].id, date: '2026-10-10' });
  // Tuesday/Thursday/Saturday from Tuesday the 6th: day 1 Tue 6, day 2 Thu 8, day 3 Sat 10.
  const r = await coach('PATCH', `/v1/clients/${maya.id}/training-calendar`, { start_date: '2026-10-06', training_days: [2, 4, 6] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.moves_cleared, 1);
  assert.deepEqual(r.body.workouts.map((w) => [w.title, w.date, w.status]), [
    ['Lower A', '2026-10-06', 'done'], ['Upper A', '2026-10-08', 'done'], ['Speed A', '2026-10-10', 'upcoming'],
    ['Lower B', '2026-10-13', 'upcoming'], ['Upper B', '2026-10-15', 'upcoming'], ['Speed B', '2026-10-17', 'upcoming']]);
  assert.equal((await coach('PATCH', `/v1/clients/${maya.id}/training-calendar`, { training_days: [2] })).status, 400, 'too few days');
  assert.equal((await coach('PATCH', `/v1/clients/${maya.id}/training-calendar`, { start_date: '10/06/2026' })).status, 400);
  // Back to the program's usual days (null), keeping the start.
  const usual = await coach('PATCH', `/v1/clients/${maya.id}/training-calendar`, { training_days: null });
  assert.deepEqual([usual.body.days_default, usual.body.training_days, usual.body.start_date], [true, [1, 3, 5], '2026-10-06']);
  // Nobody on a program: the calendar is empty, the schedule can't be set.
  const solo = (await coach('POST', '/v1/clients', { name: 'Zed Solo', parent: { name: 'Pat Solo', email: 'pat@example.com' } })).body;
  assert.deepEqual((await coach('GET', `/v1/clients/${solo.id}/training-calendar`)).body.program, null);
  assert.equal((await coach('PATCH', `/v1/clients/${solo.id}/training-calendar`, { start_date: '2026-10-06' })).status, 409);
});

test('an assignment from before version 62 keeps working: the timestamp becomes the business day it fell on', async () => {
  app.ctx.db.run('UPDATE assignments SET start_date = ?, training_days = NULL WHERE client_id = ? AND active = 1', '2026-10-06T03:30:00.000Z', maya.id);   // 10:30 pm Monday the 5th in Chicago
  const c = await cal();
  assert.equal(c.start_date, '2026-10-05');
  assert.equal(byTitle(c, 'Speed B').date, '2026-10-16');
});

test('a version 61 database gains the training days and the moves table, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v61.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 61');
    old.exec(`INSERT INTO clients (id, name, access_token, created_at) VALUES ('cli_1', 'Old Athlete', 'tok_old', '2026-01-01T00:00:00Z')`);
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prg_1', 'Old program', 4, '2026-01-01T00:00:00Z')`);
    old.exec(`INSERT INTO assignments (id, client_id, program_id, start_date, active, created_at) VALUES ('asg_1', 'cli_1', 'prg_1', '2026-09-01T12:00:00.000Z', 1, '2026-09-01T12:00:00.000Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 64, `round ${round}`);
      assert.ok(d.all('PRAGMA table_info(assignments)').some((c) => c.name === 'training_days'));
      assert.deepEqual(d.all('PRAGMA table_info(assignment_moves)').map((c) => c.name), ['id', 'assignment_id', 'workout_id', 'date', 'moved_by', 'created_at']);
      assert.equal(d.get('SELECT start_date FROM assignments WHERE id = ?', 'asg_1').start_date, '2026-09-01T12:00:00.000Z', 'kept as it was');
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
