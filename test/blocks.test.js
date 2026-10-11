import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';

// Named blocks and complexes (schema 74, owner's ask): a workout's exercises sit in named blocks (Warm up, Speed,
// Strength...) instead of lettered groups; a block is saved as a complex and loaded into any workout in one click; the
// Programs list filters by sport, setting, author and level; an athlete with no family gets a sibling.
let app, base, owner, coach, desk, program, w1, sprint, jump, sled, squat;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const workout = async (id = w1.id) => (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.find((w) => w.id === id);
const names = (w) => w.exercises.map((x) => [x.name, x.position, x.block_name, x.group_tag]);

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  const ex = async (name, category) => (await coach('POST', '/v1/exercises', { name, category })).body;
  sprint = await ex('Backwards sprint', 'Speed'); jump = await ex('Broad jump', 'Power'); sled = await ex('Sled sprint', 'Speed'); squat = await ex('Back squat', 'Lower body');
  program = (await coach('POST', '/v1/programs', { name: 'Speed block', weeks: 2, sport: 'Baseball', setting: 'facility', level: 'Intermediate' })).body;
  w1 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Day 1' })).body;
});
after(() => app.server.close());

test('blocks: named, in order, exercises added into them, renamed, moved and removed; letters come from the block', async () => {
  const warm = (await coach('POST', `/v1/workouts/${w1.id}/blocks`, { name: 'Warm up' })).body;
  assert.ok(warm.block_id);
  assert.deepEqual(warm.blocks.map((b) => [b.name, b.kind, b.position, b.count]), [['Warm up', 'block', 1, 0]]);
  const accel = (await coach('POST', `/v1/workouts/${w1.id}/blocks`, { name: 'Acceleration Primer', kind: 'circuit' })).body;
  // Exercises go into a block last in that block; the circuit's exercises run together (one letter, the kind).
  await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: sprint.id, sets: 3, reps: '20 yd', block_id: accel.block_id });
  await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: jump.id, sets: 3, reps: '3', block_id: accel.block_id });
  await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '10', block_id: warm.block_id });
  const r = await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: sled.id, sets: 3, reps: '20 yd', block_id: accel.block_id });
  assert.equal(r.status, 201);
  let w = await workout();
  assert.deepEqual(names(w), [['Back squat', 1, 'Warm up', 'A1'], ['Backwards sprint', 2, 'Acceleration Primer', 'B1'], ['Broad jump', 3, 'Acceleration Primer', 'B2'], ['Sled sprint', 4, 'Acceleration Primer', 'B3']],
    'the warm up sits first because it was made first; its exercise came later but goes to its block');
  assert.deepEqual(w.exercises.map((x) => x.group_kind), ['block', 'circuit', 'circuit', 'circuit']);
  assert.deepEqual(w.blocks.map((b) => [b.name, b.position, b.count]), [['Warm up', 1, 1], ['Acceleration Primer', 2, 3]]);
  // A loose exercise stays where it is; moving it into a block puts it after the block's exercises.
  const loose = (await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: squat.id, sets: 5, reps: '5' })).body.exercises.at(-1);
  assert.equal(loose.block_id, null);
  await coach('PATCH', `/v1/workout-exercises/${loose.id}`, { block_id: warm.block_id });
  w = await workout();
  assert.deepEqual(names(w).map((x) => [x[0], x[2]]), [['Back squat', 'Warm up'], ['Back squat', 'Warm up'], ['Backwards sprint', 'Acceleration Primer'], ['Broad jump', 'Acceleration Primer'], ['Sled sprint', 'Acceleration Primer']]);
  // Rename, change the kind, move the block up; the letters follow the order.
  const moved = (await coach('PATCH', `/v1/workout-blocks/${accel.block_id}`, { name: 'Accel primer', kind: 'superset', position: 1 })).body;
  assert.deepEqual(moved.blocks.map((b) => [b.name, b.kind, b.position]), [['Accel primer', 'superset', 1], ['Warm up', 'block', 2]]);
  assert.deepEqual(names(moved).map((x) => [x[0], x[3]]), [['Backwards sprint', 'A1'], ['Broad jump', 'A2'], ['Sled sprint', 'A3'], ['Back squat', 'B1'], ['Back squat', 'B2']]);
  assert.equal((await coach('PATCH', `/v1/workout-blocks/${accel.block_id}`, { name: '' })).status, 400);
  assert.equal((await coach('PATCH', `/v1/workout-blocks/${accel.block_id}`, { kind: 'tabata' })).status, 400);
  assert.equal((await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: sled.id, sets: 1, reps: '1', block_id: 'wb_nope' })).status, 404);
  // Removing a block takes its exercises; keep_exercises leaves them loose.
  const kept = (await coach('DELETE', `/v1/workout-blocks/${warm.block_id}`, { keep_exercises: true })).body;
  assert.deepEqual([kept.exercises_kept, kept.exercises_removed], [2, 0]);
  w = await workout();
  assert.deepEqual(names(w).map((x) => [x[0], x[2], x[3]]), [['Backwards sprint', 'Accel primer', 'A1'], ['Broad jump', 'Accel primer', 'A2'], ['Sled sprint', 'Accel primer', 'A3'], ['Back squat', null, null], ['Back squat', null, null]]);
  const gone = (await coach('DELETE', `/v1/workout-blocks/${accel.block_id}`)).body;
  assert.equal(gone.exercises_removed, 3);
  w = await workout();
  assert.deepEqual(names(w).map((x) => [x[0], x[1]]), [['Back squat', 1], ['Back squat', 2]]);
  assert.deepEqual(w.blocks, []);
  // Front desk looks only.
  assert.equal((await desk('POST', `/v1/workouts/${w1.id}/blocks`, { name: 'Nope' })).status, 403);
  assert.equal((await desk('GET', `/v1/programs/${program.id}`)).status, 200);
});

test('older integrations still send a group letter: it becomes a block named after it', async () => {
  const w2 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 2, title: 'Day 2' })).body;
  await coach('POST', `/v1/workouts/${w2.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5', group_label: 'A' });
  await coach('POST', `/v1/workouts/${w2.id}/exercises`, { exercise_id: jump.id, sets: 3, reps: '3', group_label: 'A', group_kind: 'circuit' });
  const w = await workout(w2.id);
  assert.deepEqual(w.blocks.map((b) => [b.name, b.kind, b.count]), [['Superset A', 'circuit', 2]], 'the kind follows the last word; the name keeps the letter it was given');
  assert.deepEqual(names(w).map((x) => [x[0], x[3]]), [['Back squat', 'A1'], ['Broad jump', 'A2']]);
});

test('complexes: save a block as one, load it into another workout, edit it in the library, delete it', async () => {
  const b = (await coach('POST', `/v1/workouts/${w1.id}/blocks`, { name: 'Acceleration Primer', kind: 'circuit' })).body;
  assert.equal((await coach('POST', `/v1/workout-blocks/${b.block_id}/save-complex`, {})).status, 400, 'an empty block has nothing to save');
  for (const [e, reps] of [[sprint, '20 yd'], [jump, '3'], [sled, '20 yd']]) await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: e.id, sets: 3, reps, rest_seconds: 60, block_id: b.block_id });
  const saved = await coach('POST', `/v1/workout-blocks/${b.block_id}/save-complex`, {});
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const cx = saved.body;
  assert.deepEqual([cx.name, cx.kind, cx.used_in, cx.exercises.map((x) => [x.name, x.prescription, x.distance, x.rest_seconds])],
    ['Acceleration Primer', 'circuit', 1, [['Backwards sprint', '3 × 20 yd', '20 yd', 60], ['Broad jump', '3 × 3', null, 60], ['Sled sprint', '3 × 20 yd', '20 yd', 60]]]);
  assert.equal((await coach('POST', `/v1/workout-blocks/${b.block_id}/save-complex`, {})).status, 409, 'names are unique');
  // Load it into a workout in another program: a block with every exercise, in one call.
  const other = (await coach('POST', '/v1/programs', { name: 'Football speed', weeks: 1, sport: 'Football', setting: 'remote' })).body;
  const ow = (await coach('POST', `/v1/programs/${other.id}/workouts`, { week: 1, day: 1, title: 'Speed day' })).body;
  await coach('POST', `/v1/workouts/${ow.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' });
  const loaded = (await coach('POST', `/v1/workouts/${ow.id}/blocks`, { complex_id: cx.id })).body;
  assert.deepEqual(loaded.blocks.map((x) => [x.name, x.kind, x.count, x.complex_id]), [['Acceleration Primer', 'circuit', 3, cx.id]]);
  assert.deepEqual(loaded.exercises.map((x) => [x.name, x.position, x.block_name, x.group_tag, x.rest_seconds]),
    [['Back squat', 1, null, null, null], ['Backwards sprint', 2, 'Acceleration Primer', 'A1', 60], ['Broad jump', 3, 'Acceleration Primer', 'A2', 60], ['Sled sprint', 4, 'Acceleration Primer', 'A3', 60]]);
  assert.equal((await coach('GET', `/v1/complexes/${cx.id}`)).body.used_in, 2);
  // The library edits the complex; the workouts built from it keep what they have.
  const edited = await coach('PATCH', `/v1/complexes/${cx.id}`, { name: 'Accel Primer', note: 'Before every speed day', exercises: [{ exercise_id: sprint.id, sets: 4, reps: '20 yd' }, { exercise_id: sled.id, sets: 2, reps: '10 yd', load_text: '45 lb' }] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.exercises.map((x) => [x.name, x.prescription]), [['Backwards sprint', '4 × 20 yd'], ['Sled sprint', '2 × 10 yd @ 45 lb']]);
  assert.equal((await coach('GET', `/v1/programs/${other.id}`)).body.workouts[0].exercises.length, 4, 'the workout built from it keeps its three exercises plus the squat');
  assert.equal((await coach('PATCH', `/v1/complexes/${cx.id}`, { exercises: [] })).status, 400);
  assert.equal((await coach('PATCH', `/v1/complexes/${cx.id}`, { exercises: [{ exercise_id: 'ex_nope', sets: 1, reps: '1' }] })).status, 404);
  const dup = await coach('POST', '/v1/complexes', { name: 'accel primer', exercises: [{ exercise_id: jump.id, sets: 3, reps: '3' }] });
  assert.equal(dup.status, 409);
  // The list, written from scratch too; front desk reads it, never writes.
  const made = await coach('POST', '/v1/complexes', { name: 'Pogo series', kind: 'block', exercises: [{ exercise_id: jump.id, sets: 3, reps: '10', rest_seconds: 30 }] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual((await desk('GET', '/v1/complexes')).body.data.map((c) => c.name), ['Accel Primer', 'Pogo series']);
  assert.equal((await desk('GET', `/v1/complexes/${made.body.id}`)).status, 200);
  assert.equal((await desk('POST', '/v1/complexes', { name: 'X', exercises: [{ exercise_id: jump.id, sets: 1, reps: '1' }] })).status, 403);
  // An exercise in a complex can't leave the library; deleting the complex frees it and leaves the workouts alone.
  const hurdle = (await coach('POST', '/v1/exercises', { name: 'Hurdle hop', category: 'Power' })).body;
  await coach('PATCH', `/v1/complexes/${made.body.id}`, { exercises: [{ exercise_id: hurdle.id, sets: 3, reps: '5' }] });
  const refused = await coach('DELETE', `/v1/exercises/${hurdle.id}`);
  assert.equal(refused.status, 409); assert.match(refused.body.error.message, /complex Pogo series/);
  await coach('DELETE', `/v1/complexes/${made.body.id}`);
  assert.equal((await coach('DELETE', `/v1/exercises/${hurdle.id}`)).status, 200);
  const del = (await coach('DELETE', `/v1/complexes/${cx.id}`)).body;
  assert.deepEqual([del.deleted, del.was_used_in], [true, 2]);
  const after = (await coach('GET', `/v1/programs/${other.id}`)).body.workouts[0];
  assert.deepEqual(after.blocks.map((x) => [x.name, x.count, x.complex_id]), [['Acceleration Primer', 3, null]]);
});

test('copies carry the blocks: a copied workout, a template and a program copy', async () => {
  const src = await workout();
  const copy = (await coach('POST', `/v1/workouts/${w1.id}/copy`, { week: 2, day: 1 })).body;
  const cw = await workout(copy.id);
  assert.deepEqual(cw.blocks.map((b) => [b.name, b.kind, b.count]), src.blocks.map((b) => [b.name, b.kind, b.count]));
  assert.deepEqual(names(cw).map((x) => [x[0], x[2], x[3]]), names(src).map((x) => [x[0], x[2], x[3]]));
  assert.notEqual(cw.blocks[0].id, src.blocks[0].id, 'its own block rows');
  const dup = (await coach('POST', '/v1/programs', { name: 'Speed block 2', copy_from: program.id })).body;
  const dw = (await coach('GET', `/v1/programs/${dup.id}`)).body.workouts.find((w) => w.week === 1 && w.day === 1);
  assert.deepEqual(dw.blocks.map((b) => b.name), src.blocks.map((b) => b.name));
  assert.deepEqual([dup.sport, dup.setting], ['Baseball', 'facility'], 'a copy keeps the sport and setting');
});

test('the Programs list: one line each, filtered by sport, setting, author and level; the author is who made it', async () => {
  const all = (await coach('GET', '/v1/programs')).body.data;
  const speed = all.find((p) => p.id === program.id);
  assert.deepEqual([speed.sport, speed.setting, speed.level, speed.author_name], ['Baseball', 'facility', 'Intermediate', 'Riley']);
  assert.deepEqual((await coach('GET', '/v1/programs?sport=baseball')).body.data.map((p) => p.name).sort(), ['Speed block', 'Speed block 2']);
  assert.deepEqual((await coach('GET', '/v1/programs?setting=remote')).body.data.map((p) => p.name), ['Football speed']);
  assert.deepEqual((await coach('GET', '/v1/programs?level=unset')).body.data.map((p) => p.name), ['Football speed']);
  const riley = app.ctx.db.get(`SELECT id FROM users WHERE email = 'coach@test.dev'`).id;
  assert.equal((await owner('GET', `/v1/programs?author=${riley}`)).body.data.length, 3);
  const mine = (await owner('POST', '/v1/programs', { name: 'Owner plan', weeks: 1, setting: 'both' })).body;
  assert.equal(mine.author_name, 'Taylor');
  assert.deepEqual((await owner('GET', '/v1/programs?setting=both')).body.data.map((p) => p.name), ['Owner plan']);
  assert.equal((await owner('GET', '/v1/programs?setting=gym')).status, 400);
  const changed = (await owner('PATCH', `/v1/programs/${mine.id}`, { sport: 'Softball', setting: null })).body;
  assert.deepEqual([changed.sport, changed.setting, changed.author_name], ['Softball', null, 'Taylor']);
});

test('an athlete with no family gets a sibling: a family of the two with no parent yet', async () => {
  const leo = (await coach('POST', '/v1/clients', { name: 'Leo Park', email: 'leo@example.com' })).body;
  const r = await coach('POST', `/v1/clients/${leo.id}/family`, { sibling: { name: 'Mia Park', birth_date: '2012-04-02' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sibling.name, 'Mia Park');
  const fam = app.ctx.db.get('SELECT f.name, (SELECT COUNT(*) FROM clients c WHERE c.family_id = f.id) AS kids, (SELECT COUNT(*) FROM guardians g WHERE g.family_id = f.id) AS parents FROM families f JOIN clients c ON c.family_id = f.id WHERE c.id = ?', leo.id);
  assert.deepEqual(fam, { name: 'Park family', kids: 2, parents: 0 });
  assert.equal((await coach('POST', `/v1/clients/${leo.id}/family`, { sibling: { name: 'Sam Park' } })).status, 409, 'already in a family');
  // A refused sibling leaves nothing behind.
  const sol = (await coach('POST', '/v1/clients', { name: 'Sol Reyes', email: 'sol@example.com' })).body;
  const bad = await coach('POST', `/v1/clients/${sol.id}/family`, { sibling: { name: 'Mia Park', birth_date: '2012-04-02', email: 'leo@example.com' } });
  assert.equal(bad.status, 409);
  assert.equal(app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', sol.id).family_id, null);
  // A parent can be added to the family afterwards.
  const famId = app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', leo.id).family_id;
  assert.equal((await coach('POST', `/v1/families/${famId}/guardians`, { name: 'Dana Park', email: 'dana@example.com' })).status, 201);
});

test('a version 73 database is upgraded: lettered groups become named blocks, loose exercises stay where they were, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v73-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v73.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 73');
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('p1', 'Speed', 1, '2026-01-01T00:00:00Z');
      INSERT INTO workouts (id, program_id, week, day, title) VALUES ('w1', 'p1', 1, 1, 'Speed');
      INSERT INTO exercises (id, name, created_at) VALUES ('e1', 'Sprint', '2026-01-01T00:00:00Z'), ('e2', 'Squat', '2026-01-01T00:00:00Z'), ('e3', 'Plank', '2026-01-01T00:00:00Z');
      INSERT INTO workout_exercises (id, workout_id, exercise_id, position, prescription, sets, reps, group_label, group_kind) VALUES
        ('x1', 'w1', 'e1', 1, '6 × 20 yd', 6, '20 yd', NULL, NULL),
        ('x2', 'w1', 'e2', 2, '3 × 5', 3, '5', 'A', 'superset'),
        ('x3', 'w1', 'e3', 3, '2 × 40 sec', 2, '40 sec', NULL, NULL),
        ('x4', 'w1', 'e3', 4, '3 × 8', 3, '8', 'A', 'superset'),
        ('x5', 'w1', 'e1', 5, '4 × 10 yd', 4, '10 yd', 'B', 'circuit');`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 76, `round ${round}`);
      assert.deepEqual(d.all('SELECT name, kind, position FROM workout_blocks ORDER BY position'), [{ name: 'Superset A', kind: 'superset', position: 1 }, { name: 'Circuit B', kind: 'circuit', position: 2 }]);
      const rows = d.all('SELECT we.id, we.position, b.name AS block FROM workout_exercises we LEFT JOIN workout_blocks b ON b.id = we.block_id ORDER BY we.position');
      assert.deepEqual(rows, [{ id: 'x1', position: 1, block: null }, { id: 'x2', position: 2, block: 'Superset A' }, { id: 'x4', position: 3, block: 'Superset A' }, { id: 'x3', position: 4, block: null }, { id: 'x5', position: 5, block: 'Circuit B' }],
        'the superset is pulled together where it started; the plank stays after it');
      assert.ok(d.get(`SELECT 1 AS ok FROM sqlite_master WHERE name = 'complexes'`), 'the complexes table is there');
      assert.deepEqual(d.all(`PRAGMA table_info(programs)`).map((c) => c.name).filter((c) => ['sport', 'setting', 'author_id', 'author_name'].includes(c)).sort(), ['author_id', 'author_name', 'setting', 'sport']);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
