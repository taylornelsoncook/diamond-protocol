import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { workoutView } from '../src/services/screen.js';

// The week grid (the builder redesign, step 1): the ticked days at once (copy, move, repeat, delete) and the day's
// instructions (schema 75).
let app, base, coach, desk, program, squat;
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
const layout = (p) => p.workouts.map((w) => `${w.week}:${w.day}:${w.title}`).sort();
const day = async (week, d, title) => (await coach('POST', `/v1/programs/${program.id}/workouts`, { week, day: d, title })).body;

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Explosive strength', weeks: 2 })).body;
  const d1 = await day(1, 1, 'Strength'); await day(1, 3, 'Speed'); await day(2, 1, 'Strength 2');
  await coach('POST', `/v1/workouts/${d1.id}/exercises`, { exercise_id: squat.id, sets: 5, reps: '5', rest_seconds: 120 });
});
after(() => app.server.close());

test('copy ticked days to a week: each keeps its weekday, days from two weeks land in consecutive weeks, the program grows', async () => {
  const p = await detail();
  const ids = p.workouts.filter((w) => w.week === 1 || w.week === 2).map((w) => w.id);   // week 1 (days 1 and 3) and week 2 (day 1)
  const r = await coach('POST', `/v1/programs/${program.id}/days/copy`, { workouts: ids, to_week: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.days.map((d) => `${d.week}:${d.day}`).sort(), ['3:1', '3:3', '4:1']);
  assert.equal(r.body.weeks, 4, 'the program grew to week 4');
  const copied = r.body.workouts.find((w) => w.week === 3 && w.day === 1);
  assert.deepEqual(copied.exercises.map((x) => [x.name, x.prescription, x.rest_seconds]), [['Back squat', '5 × 5', 120]], 'the exercises came along');
  // A taken day needs replace: true; a logged one needs confirm too.
  const again = await coach('POST', `/v1/programs/${program.id}/days/copy`, { workouts: [ids[0]], to_week: 3 });
  assert.equal(again.status, 409); assert.equal(again.body.error.code, 'replace_needed');
  assert.equal((await coach('POST', `/v1/programs/${program.id}/days/copy`, { workouts: [ids[0]], to_week: 3, replace: true })).status, 200);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/days/copy`, { workouts: [], to_week: 3 })).status, 400);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/days/copy`, { workouts: ['wo_nope'], to_week: 3 })).status, 404);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/days/paste`, { workouts: ids, to_week: 3 })).status, 400);
  assert.equal((await desk('POST', `/v1/programs/${program.id}/days/copy`, { workouts: ids, to_week: 5 })).status, 403);
});

test('copy to another program or a template; move days; repeat days; delete days', async () => {
  const p = await detail();
  const d1 = p.workouts.find((w) => w.week === 1 && w.day === 1);
  const other = (await coach('POST', '/v1/programs', { name: 'Football speed', weeks: 1 })).body;
  const r = await coach('POST', `/v1/programs/${program.id}/days/copy`, { workouts: [d1.id], to_week: 2, to_program_id: other.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = await detail(other.id);
  assert.deepEqual([o.weeks, layout(o)], [2, ['2:1:Strength']], 'landed in the other program, which grew');
  const tmpl = (await coach('POST', '/v1/programs', { name: 'Speed template', weeks: 1, kind: 'template' })).body;
  assert.equal((await coach('POST', `/v1/programs/${program.id}/days/copy`, { workouts: [d1.id], to_week: 1, to_program_id: tmpl.id })).status, 200);
  assert.deepEqual(layout(await detail(tmpl.id)), ['1:1:Strength']);
  // Move week 3's days to week 5 (empty): they keep their weekdays.
  const w3 = (await detail()).workouts.filter((w) => w.week === 3).map((w) => w.id);
  const mv = await coach('POST', `/v1/programs/${program.id}/days/move`, { workouts: w3, to_week: 5 });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  const after1 = await detail();
  assert.equal(after1.workouts.filter((w) => w.week === 3).length, 0);
  assert.deepEqual(after1.workouts.filter((w) => w.week === 5).map((w) => w.day).sort(), [1, 3]);
  assert.equal(after1.weeks, 5);
  // Repeat week 1's two days twice: weeks 6 and 7 (after the last ticked week... the ticked days are in week 1, so 2 and 3)
  const w1 = after1.workouts.filter((w) => w.week === 1).map((w) => w.id);
  const rep = await coach('POST', `/v1/programs/${program.id}/days/repeat`, { workouts: w1, times: 2 });
  assert.equal(rep.status, 409, 'week 2 has a day: replace needed');
  const rep2 = await coach('POST', `/v1/programs/${program.id}/days/repeat`, { workouts: w1, times: 2, replace: true });
  assert.equal(rep2.status, 200, JSON.stringify(rep2.body));
  assert.deepEqual(rep2.body.days.map((d) => `${d.week}:${d.day}`).sort(), ['2:1', '2:3', '3:1', '3:3']);
  assert.equal(rep2.body.replaced, 1);
  // Delete days.
  const gone = await coach('POST', `/v1/programs/${program.id}/days/delete`, { workouts: w1 });
  assert.equal(gone.status, 200); assert.equal(gone.body.deleted, 2);
  assert.equal((await detail()).workouts.filter((w) => w.week === 1).length, 0);
});

test('the day\'s instructions: written, shown in the app and on the screen, carried by copies', async () => {
  const w = await day(1, 2, 'Lift');
  const r = await coach('PATCH', `/v1/workouts/${w.id}`, { instructions: 'Dynamic warm-up first, then the speed work before the lifts.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.instructions, 'Dynamic warm-up first, then the speed work before the lifts.');
  assert.equal((await coach('PATCH', `/v1/workouts/${w.id}`, { instructions: 'x'.repeat(2001) })).status, 400);
  const made = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 4, title: 'Run', instructions: 'Easy pace.' })).body;
  assert.equal(made.instructions, 'Easy pace.');
  const copy = (await coach('POST', `/v1/workouts/${w.id}/copy`, { week: 1, day: 5 })).body;
  assert.equal(copy.instructions, r.body.instructions, 'a copy keeps the instructions');
  await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' });
  assert.equal(workoutView(app.ctx, w.id).instructions, r.body.instructions, 'the weight-room screen reads it');
  assert.equal((await coach('PATCH', `/v1/workouts/${w.id}`, { instructions: null })).body.instructions, null);
});

test('a version 74 database gains the instructions column, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v74-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v74.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 74');
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('p1', 'Speed', 1, '2026-01-01T00:00:00Z');
      INSERT INTO workouts (id, program_id, week, day, title) VALUES ('w1', 'p1', 1, 1, 'Speed');`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 85, `round ${round}`);
      assert.deepEqual(d.get('SELECT title, instructions FROM workouts WHERE id = ?', 'w1'), { title: 'Speed', instructions: null });
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
