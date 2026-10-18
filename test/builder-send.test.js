import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';

// Drag and drop and Send to (the builder redesign, step 2): one call moves an exercise anywhere in the program's days;
// ticked days go to athletes, teams and whole schools as a short program (schema 76: programs.sent_from).
let app, base, owner, coach, desk, program, w1, w2, squat, lunge, sprint;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const detail = async (id = program.id) => (await coach('GET', `/v1/programs/${id}`)).body;
const names = (w) => w.exercises.map((x) => `${x.name}${x.block_name ? ` [${x.block_name}]` : ''}`);

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  const ex = async (name) => (await coach('POST', '/v1/exercises', { name, category: 'Lower body' })).body;
  squat = await ex('Back squat'); lunge = await ex('Walking lunge'); sprint = await ex('Sprint');
  program = (await coach('POST', '/v1/programs', { name: 'Explosive strength', weeks: 2 })).body;
  w1 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Day 1' })).body;
  w2 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 3, title: 'Day 3' })).body;
  for (const e of [squat, lunge, sprint]) await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: e.id, sets: 3, reps: '5' });
});
after(() => app.server.close());

test('drag and drop: ahead of a line, onto a block, to the end of another day, in one call each', async () => {
  let w = (await detail()).workouts.find((x) => x.id === w1.id);
  const [sq, lu, sp] = w.exercises;
  // The sprint lands ahead of the squat.
  let r = await coach('POST', `/v1/workout-exercises/${sp.id}/move`, { before_id: sq.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(names(r.body), ['Sprint', 'Back squat', 'Walking lunge']);
  // Onto a block's heading: the end of that block, in it.
  const withBlock = (await coach('POST', `/v1/workouts/${w1.id}/blocks`, { name: 'Strength', kind: 'superset' })).body;
  r = await coach('POST', `/v1/workout-exercises/${sq.id}/move`, { block_id: withBlock.block_id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await coach('POST', `/v1/workout-exercises/${lu.id}/move`, { block_id: withBlock.block_id });
  assert.deepEqual(names(r.body), ['Sprint', 'Back squat [Strength]', 'Walking lunge [Strength]']);
  assert.deepEqual(r.body.exercises.map((x) => x.group_tag), [null, 'A1', 'A2'], 'the letters follow the block');
  // Ahead of a block's line: it joins that block there.
  r = await coach('POST', `/v1/workout-exercises/${sp.id}/move`, { before_id: lu.id });
  assert.deepEqual(names(r.body), ['Back squat [Strength]', 'Sprint [Strength]', 'Walking lunge [Strength]']);
  // To the end of another day, outside any block; both days are tidy afterwards.
  r = await coach('POST', `/v1/workout-exercises/${sp.id}/move`, { workout_id: w2.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.id, names(r.body)], [w2.id, ['Sprint']]);
  w = (await detail()).workouts.find((x) => x.id === w1.id);
  assert.deepEqual([names(w), w.exercises.map((x) => x.position)], [['Back squat [Strength]', 'Walking lunge [Strength]'], [1, 2]]);
  // Refused: another program's day, a block on another day, a line on another day, front desk.
  const other = (await coach('POST', '/v1/programs', { name: 'Other', weeks: 1 })).body;
  const ow = (await coach('POST', `/v1/programs/${other.id}/workouts`, { week: 1, day: 1, title: 'X' })).body;
  assert.equal((await coach('POST', `/v1/workout-exercises/${lu.id}/move`, { workout_id: ow.id })).status, 400);
  assert.equal((await coach('POST', `/v1/workout-exercises/${sp.id}/move`, { block_id: withBlock.block_id })).status, 400, 'that block is on day 1, the sprint is on day 3');
  assert.equal((await coach('POST', `/v1/workout-exercises/${sp.id}/move`, { before_id: lu.id, workout_id: w2.id })).status, 400);
  assert.equal((await desk('POST', `/v1/workout-exercises/${sp.id}/move`, { workout_id: w1.id })).status, 403);
});

test('send ticked days to an athlete, a team and a whole school: a short program of their own, assigned from a date', async () => {
  const ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  const org = (await owner('POST', '/v1/organizations', { name: 'Westlake High', kind: 'school', contact_email: 'ad@westlake.example' })).body;
  const mk = async (name) => (await owner('POST', '/v1/team-contracts', { org_id: org.id, name, monthly_cents: 100000, start_date: '2026-10-01', past: 'none' })).body;
  const football = await mk('Varsity Football'), soccer = await mk('Soccer');
  for (const [t, nm] of [[football, 'Leo Park'], [football, 'Sam Cole'], [soccer, 'Mia Park']]) assert.equal((await owner('POST', `/v1/team-contracts/${t.id}/roster`, { names: nm })).status, 201);
  const p = await detail();
  const ids = p.workouts.map((w) => w.id);   // week 1: days 1 and 3
  // One athlete.
  let r = await coach('POST', `/v1/programs/${program.id}/days/send`, { workouts: ids, client_ids: [ava.id], start_date: '2026-10-13' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.program.weeks, r.body.program.days, r.body.assigned.map((a) => a.name), r.body.skipped], [1, 2, ['Ava Lopez'], []]);
  assert.match(r.body.program.name, /Explosive strength · sent 2026-10-13/);
  const sent = (await coach('GET', `/v1/programs/${r.body.program.id}`)).body;
  assert.deepEqual([sent.sent_from, sent.workouts.map((w) => `${w.week}:${w.day}:${w.title}`)], [program.id, ['1:1:Day 1', '1:3:Day 3']]);
  assert.deepEqual(sent.workouts.find((w) => w.day === 1).exercises.map((x) => x.name), ['Back squat', 'Walking lunge'], 'the exercises and blocks came along');
  const list = (await coach('GET', '/v1/programs')).body.data.map((x) => x.name);
  assert.ok(!list.includes(sent.name), 'left out of the Programs list'); assert.ok(list.includes('Explosive strength'));
  assert.ok((await coach('GET', '/v1/programs?sent=true')).body.data.some((x) => x.id === sent.id), 'listed with ?sent=true');
  const cal = (await coach('GET', `/v1/clients/${ava.id}/training-calendar`)).body;
  assert.equal(cal.program?.id ?? cal.program_id, sent.id);
  // The same days to Ava again: skipped; to the whole school: every roster athlete of both teams; replace moves someone off another program.
  r = await coach('POST', `/v1/programs/${program.id}/days/send`, { workouts: ids, client_ids: [ava.id], org_ids: [org.id], start_date: '2026-10-13', name: 'Explosive strength · sent 2026-10-13' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.assigned.map((a) => a.name).sort(), ['Leo Park', 'Mia Park', 'Sam Cole']);
  assert.deepEqual(r.body.skipped, [{ id: ava.id, name: 'Ava Lopez', reason: 'already has these days' }]);
  assert.deepEqual(r.body.schools, ['Westlake High']);
  const again = await coach('POST', `/v1/programs/${program.id}/days/send`, { workouts: [ids[0]], contract_ids: [football.id], start_date: '2026-10-20' });
  assert.equal(again.status, 409, 'everyone on the team is on a program already: nobody could take it');
  const moved = await coach('POST', `/v1/programs/${program.id}/days/send`, { workouts: [ids[0]], contract_ids: [football.id], start_date: '2026-10-20', replace: true });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.teams, moved.body.assigned.map((a) => [a.name, a.previous_program?.name]).sort()], [['Westlake High Varsity Football'], [['Leo Park', 'Explosive strength · sent 2026-10-13'], ['Sam Cole', 'Explosive strength · sent 2026-10-13']]]);
  // Refused: nobody chosen, no days, an unknown team, front desk.
  assert.equal((await coach('POST', `/v1/programs/${program.id}/days/send`, { workouts: ids })).status, 400);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/days/send`, { workouts: [], client_ids: [ava.id] })).status, 400);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/days/send`, { workouts: ids, contract_ids: ['tc_nope'] })).status, 404);
  assert.equal((await desk('POST', `/v1/programs/${program.id}/days/send`, { workouts: ids, client_ids: [ava.id] })).status, 403);
});

test('a version 75 database gains sent_from, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v75-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v75.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 75');
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('p1', 'Speed', 1, '2026-01-01T00:00:00Z');`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 87, `round ${round}`);
      assert.deepEqual(d.get('SELECT name, sent_from FROM programs WHERE id = ?', 'p1'), { name: 'Speed', sent_from: null });
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
