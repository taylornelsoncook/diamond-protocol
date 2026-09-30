// Roster compliance (Relay plan, step 4): from each athlete's training calendar, this week's planned, done and missed
// workouts, how many planned workouts they missed in a row, who is behind (two in a row), their teams, and the totals
// on the Programs page and Today.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';
import { weekOf, weekStats } from '../src/services/training-calendar.js';

let app, base, coach, owner, desk, ava, ben, cole, program, workouts = {};
const PW = 'correct-horse-battery';
// Thursday, 10 am in Chicago.
const NOW = '2026-10-08T15:00:00.000Z';
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const tokenOf = (c) => app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', c.id).access_token;
const log = (c, title, at) => { const w = workouts[title]; app.ctx.now = () => at; return fetch(`${base}/app/api/workouts/${w.id}/complete`, { method: 'POST', headers: { 'x-client-token': tokenOf(c), 'content-type': 'application/json' }, body: JSON.stringify({ request_id: `${c.id}-${title}` }) }).then(async (r) => { app.ctx.now = () => NOW; assert.equal(r.status, 201, await r.text()); }); };

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); owner = await staff('owner@test.dev'); desk = await staff('desk@test.dev');
  const mk = async (name, email) => (await coach('POST', '/v1/clients', { name, parent: { name: `Parent of ${name}`, email } })).body;
  ava = await mk('Ava Lopez', 'ava.p@example.com'); ben = await mk('Ben Ortiz', 'ben.p@example.com'); cole = await mk('Cole Park', 'cole.p@example.com');
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  for (const c of [ava, ben, cole]) app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, newId('sub'), c.id, plan.id, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', NOW, NOW);
  // Ava is on a school team.
  const org = (await owner('POST', '/v1/organizations', { name: 'Lakeway HS', kind: 'school' })).body;
  const team = (await owner('POST', '/v1/team-contracts', { org_id: org.id, name: 'Varsity Soccer', monthly_cents: 40000, start_date: '2026-09-01' })).body;
  const onRoster = await owner('POST', `/v1/team-contracts/${team.id}/roster`, { client_id: ava.id });
  assert.equal(onRoster.status, 201, JSON.stringify(onRoster.body));
  const ex = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  program = (await coach('POST', `/v1/programs`, { name: 'Fall strength', weeks: 2 })).body;
  for (const [week, day, title] of [[1, 1, 'Lower A'], [1, 2, 'Upper A'], [1, 3, 'Speed A'], [2, 1, 'Lower B'], [2, 2, 'Upper B'], [2, 3, 'Speed B']]) {
    workouts[title] = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week, day, title })).body;
    await coach('POST', `/v1/workouts/${workouts[title].id}/exercises`, { exercise_id: ex.id, sets: 3, reps: '5' });
  }
  // Everyone started Monday Sep 28, Mon/Wed/Fri: week 1 = Sep 28, 30, Oct 2; week 2 = Oct 5, 7 (yesterday), 9 (tomorrow).
  for (const c of [ava, ben, cole]) assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: c.id, start_date: '2026-09-28', training_days: [1, 3, 5] })).status, 201);
  // Ava did everything so far. Ben missed Monday and Wednesday of this week (two in a row). Cole missed only Wednesday.
  for (const t of ['Lower A', 'Upper A', 'Speed A', 'Lower B', 'Upper B']) await log(ava, t, `2026-10-07T20:00:00.000Z`);
  for (const t of ['Lower A', 'Upper A', 'Speed A']) await log(ben, t, `2026-10-02T20:00:00.000Z`);
  for (const t of ['Lower A', 'Upper A', 'Speed A', 'Lower B']) await log(cole, t, `2026-10-05T20:00:00.000Z`);
});
after(() => app.server.close());

test('the week and the streak are counted from the calendar', () => {
  assert.deepEqual(weekOf('2026-10-08'), { start: '2026-10-05', end: '2026-10-11' });
  assert.deepEqual(weekOf('2026-10-05'), { start: '2026-10-05', end: '2026-10-11' }, 'a Monday starts its own week');
  assert.deepEqual(weekOf('2026-10-11'), { start: '2026-10-05', end: '2026-10-11' }, 'a Sunday ends it');
  const ws = weekStats([{ date: '2026-09-30', status: 'done' }, { date: '2026-10-02', status: 'missed' }, { date: '2026-10-05', status: 'missed' }, { date: '2026-10-07', status: 'missed' }, { date: '2026-10-09', status: 'upcoming' }], '2026-10-08');
  assert.deepEqual([ws.planned, ws.done, ws.missed, ws.upcoming, ws.missed_streak], [3, 0, 2, 1, 3], 'three missed in a row across the week boundary');
  assert.equal(weekStats([{ date: '2026-10-07', status: 'missed' }, { date: '2026-10-08', status: 'today' }], '2026-10-08').missed_streak, 1, 'today\'s isn\'t missed yet');
});

test('the Programs page lists the roster this week, behind first, with teams and the totals', async () => {
  const act = (await coach('GET', '/v1/programs/activity')).body;
  assert.deepEqual([act.week.start, act.week.end, act.week.planned, act.week.done, act.week.missed, act.week.behind, act.week.on_pace, act.on_programs], ['2026-10-05', '2026-10-11', 9, 3, 3, 1, 1, 3]);
  assert.deepEqual(act.athletes.map((a) => [a.name, a.week.done, a.week.missed, a.missed_streak, a.behind]), [['Ben Ortiz', 0, 2, 2, true], ['Cole Park', 1, 1, 1, false], ['Ava Lopez', 2, 0, 0, false]]);
  assert.deepEqual(act.athletes.find((a) => a.name === 'Ava Lopez').teams.map((t) => t.name), ['Lakeway HS Varsity Soccer']);
  assert.deepEqual(act.behind.map((b) => [b.name, b.missed_streak]), [['Ben Ortiz', 2]]);
  // The program page's client rows carry the same.
  const p = (await coach('GET', `/v1/programs/${program.id}`)).body;
  const ben2 = p.clients.find((c) => c.name === 'Ben Ortiz');
  assert.deepEqual([ben2.week.planned, ben2.week.done, ben2.missed_streak, ben2.behind], [3, 0, 2, true]);
  // Front desk may look (no money in it).
  assert.equal((await desk('GET', '/v1/programs/activity')).status, 200);
});

test('Today says who is behind and the week\'s totals, for every role', async () => {
  for (const who of [owner, coach, desk]) {
    const t = (await who('GET', '/v1/today')).body.training;
    assert.deepEqual([t.on_programs, t.planned, t.done, t.missed, t.behind, t.on_pace], [3, 9, 3, 3, 1, 1]);
    assert.deepEqual(t.behind_athletes.map((a) => [a.name, a.missed_streak, a.program_name]), [['Ben Ortiz', 2, 'Fall strength']]);
  }
  // Ben logs yesterday's workout late: the streak breaks and he's off the list.
  await log(ben, 'Upper B', NOW);
  const t = (await coach('GET', '/v1/today')).body.training;
  assert.deepEqual([t.behind, t.behind_athletes.length, t.done], [0, 0, 4]);
  const ben2 = (await coach('GET', '/v1/programs/activity')).body.athletes.find((a) => a.name === 'Ben Ortiz');
  assert.deepEqual([ben2.week.done, ben2.week.missed, ben2.missed_streak, ben2.behind], [1, 1, 0, false], 'Monday stays missed but the run is broken');
});

test('an archived athlete drops out of the roster view', async () => {
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', NOW, cole.id);
  const act = (await coach('GET', '/v1/programs/activity')).body;
  assert.deepEqual(act.athletes.map((a) => a.name), ['Ben Ortiz', 'Ava Lopez']);
  assert.equal((await coach('GET', '/v1/today')).body.training.on_programs, 2);
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', cole.id);
});
