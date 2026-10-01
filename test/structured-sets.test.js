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
import { splitRx, rxText, restText, rxDetails, parseRx } from '../src/services/rx.js';
import { workoutView } from '../src/services/screen.js';

// Structured set details (schema 49): sets, reps, tempo, rest, target RPE and a typed load as separate fields, with
// supersets, circuits and blocks drawn as such. prescription stays the short text every screen shows.
let app, base, coach, desk, ava, squat, rdl, plank, row, program, w1;
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
const slots = (p, wid) => p.workouts.find((w) => w.id === wid).exercises;
const detail = (id) => coach('GET', `/v1/programs/${id}`).then((r) => r.body);

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`,
    newId('sub'), ava.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  rdl = (await coach('POST', '/v1/exercises', { name: 'Romanian deadlift' })).body;
  plank = (await coach('POST', '/v1/exercises', { name: 'Plank' })).body;
  row = (await coach('POST', '/v1/exercises', { name: 'Bent-over row' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 2 })).body;
  w1 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
});
after(() => app.server.close());

test('text is split into fields and fields make the text', () => {
  assert.deepEqual(splitRx('3 × 8 @ 135 lb, RPE 8'), { sets: 3, reps: '8', load_text: '135 lb', target_rpe: 8 });
  assert.deepEqual(splitRx('4x5/side'), { sets: 4, reps: '5/side', load_text: null, target_rpe: null });
  assert.deepEqual(splitRx('3 sets of 40 sec'), { sets: 3, reps: '40 sec', load_text: null, target_rpe: null });
  assert.deepEqual(splitRx('5 sets'), { sets: 5, reps: null, load_text: null, target_rpe: null });
  assert.deepEqual(splitRx('Easy jog 10 min'), { sets: null, reps: 'Easy jog 10 min', load_text: null, target_rpe: null });
  assert.deepEqual(splitRx('20 × 20 yd'), { sets: null, reps: '20 × 20 yd', load_text: null, target_rpe: null }, 'more sets than an athlete can log stays text');
  assert.deepEqual(splitRx('3 × 5 @ RPE 7.5'), { sets: 3, reps: '5', load_text: null, target_rpe: 7.5 });
  assert.deepEqual(splitRx(''), { sets: null, reps: null, load_text: null, target_rpe: null });
  assert.equal(rxText({ sets: 3, reps: '8', load_text: '135 lb' }), '3 × 8 @ 135 lb');
  assert.equal(rxText({ sets: 3, reps: null }), '3 sets');
  assert.equal(rxText({ sets: null, reps: 'Easy jog 10 min' }), 'Easy jog 10 min');
  assert.equal(rxText({ sets: null, reps: null, load_text: 'BW' }), '@ BW');
  assert.equal(rxText({}), '');
  assert.deepEqual([restText(0), restText(45), restText(90), restText(120), restText(null)], ['none', '45 sec', '1:30', '2 min', null]);
  assert.equal(rxDetails({ tempo: '3-1-1', rest_seconds: 90, target_rpe: 8 }), 'Tempo 3-1-1 · Rest 1:30 · RPE 8');
  assert.equal(rxDetails({ rest_seconds: 0 }), 'No rest');
  assert.equal(rxDetails({}), null);
  assert.deepEqual(parseRx({ sets: 4, reps: '6-8' }), { sets: 4, reps: 6 });
  assert.deepEqual(parseRx({ sets: 3, reps: '40 sec' }), { sets: 3, reps: null });
  assert.deepEqual(parseRx({ sets: null, reps: '20 × 3' }), { sets: 12, reps: 3 });
});

test('an exercise is added with its fields; the text is built from them; older callers still send a prescription', async () => {
  const a = await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: squat.id, sets: 4, reps: '5', tempo: '3-1-1', rest_seconds: 120, target_rpe: 8, load_text: '185 lb', note: 'Pause at the bottom' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const [sq] = a.body.exercises;
  assert.deepEqual([sq.prescription, sq.sets, sq.reps, sq.tempo, sq.rest_seconds, sq.target_rpe, sq.load_text, sq.note, sq.details, sq.group_tag],
    ['4 × 5 @ 185 lb', 4, '5', '3-1-1', 120, 8, '185 lb', 'Pause at the bottom', 'Tempo 3-1-1 · Rest 2 min · RPE 8', null]);
  const b = await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: rdl.id, prescription: '3 x 8-10 @ 95 lb' });
  const r = b.body.exercises[1];
  assert.deepEqual([r.prescription, r.sets, r.reps, r.load_text, r.details], ['3 × 8-10 @ 95 lb', 3, '8-10', '95 lb', null], 'text is split; the sign is tidied');
  const c = await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: plank.id, prescription: 'Hold as long as you can' });
  assert.deepEqual([c.body.exercises[2].prescription, c.body.exercises[2].sets, c.body.exercises[2].reps], ['Hold as long as you can', null, 'Hold as long as you can'], 'free text stays whole');
  // Every problem says what to fix.
  const bad = async (body, re, why) => { const res = await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: plank.id, ...body }); assert.equal(res.status, 400, why ?? JSON.stringify(body)); assert.match(res.body.error.message, re); };
  await bad({}, /Add the sets and reps/);
  await bad({ sets: 13, reps: '5' }, /between 1 and 12/);
  await bad({ sets: 3, reps: '5', target_rpe: 7.3 }, /in halves/);
  await bad({ sets: 3, reps: '5', rest_seconds: 2000 }, /between 0 and 1800/);
  await bad({ sets: 3, reps: '5', group_label: 'AA' }, /one letter/);
  await bad({ sets: 3, reps: '5', group_kind: 'superset' }, /Give the group a letter/);
  await bad({ sets: 3, reps: '5', group_label: 'A', group_kind: 'pyramid' }, /group_kind must be one of/);
  await bad({ sets: 3, reps: 'x'.repeat(81) }, /80 characters or fewer/);
  await bad({ prescription: 42 }, /must be text/);
  await bad({ load_text: 'BW' }, /Add the sets and reps/, 'a load on its own is not a prescription');
  await bad({ sets: 3, reps: '5', target_rpe: true }, /in halves/);
  await bad({ sets: 3, reps: '5', group_label: ['a'] }, /one letter/);
  // Text over 40 characters that doesn't split stays whole and can be saved again.
  const long = await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: plank.id, prescription: 'Warm-up: 5 min bike, then hip mobility flow, 2 rounds easy' });
  assert.equal(long.status, 201);
  const lx = long.body.exercises.at(-1);
  assert.equal((await coach('PATCH', `/v1/workout-exercises/${lx.id}`, { note: 'Easy' })).status, 200);
  // Text sent again is the whole story: a load it no longer has goes too.
  const re = (await coach('PATCH', `/v1/workout-exercises/${lx.id}`, { prescription: '3 × 8 @ 135 lb' })).body;
  assert.deepEqual([re.prescription, re.load_text], ['3 × 8 @ 135 lb', '135 lb']);
  assert.deepEqual((await coach('PATCH', `/v1/workout-exercises/${lx.id}`, { prescription: '3 × 8' })).body.load_text, null);
  await coach('DELETE', `/v1/workout-exercises/${lx.id}`);
  assert.equal((await desk('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: plank.id, sets: 3, reps: '5' })).status, 403, 'front desk can\'t build');
});

test('supersets: exercises sharing a letter sit together, are tagged A1, A2 and share one kind', async () => {
  // The squat becomes A1; the row joins group A and lands right under it, ahead of the RDL and the plank.
  const sq = (await detail(program.id)).workouts[0].exercises[0];
  const up = await coach('PATCH', `/v1/workout-exercises/${sq.id}`, { group_label: 'a' });
  assert.deepEqual([up.status, up.body.group_label, up.body.group_kind, up.body.group_tag], [200, 'A', 'superset', 'A1'], 'the letter is upper-cased; superset is the default kind');
  await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: row.id, sets: 4, reps: '8', group_label: 'A', group_kind: 'superset' });
  let list = slots(await detail(program.id), w1.id);
  assert.deepEqual(list.map((x) => [x.name, x.position, x.group_tag]), [['Back squat', 1, 'A1'], ['Bent-over row', 2, 'A2'], ['Romanian deadlift', 3, null], ['Plank', 4, null]]);
  // Changing the kind on one changes it for the whole group. The plank joins as A3 and moves up under the row.
  await coach('PATCH', `/v1/workout-exercises/${list[1].id}`, { group_label: 'A', group_kind: 'circuit' });
  await coach('PATCH', `/v1/workout-exercises/${list[3].id}`, { group_label: 'A' });
  list = slots(await detail(program.id), w1.id);
  assert.deepEqual(list.map((x) => [x.name, x.position, x.group_tag, x.group_kind]), [['Back squat', 1, 'A1', 'circuit'], ['Bent-over row', 2, 'A2', 'circuit'], ['Plank', 3, 'A3', 'circuit'], ['Romanian deadlift', 4, null, null]]);
  // Leaving the group clears the kind too; the order stays.
  await coach('PATCH', `/v1/workout-exercises/${list[2].id}`, { group_label: null });
  list = slots(await detail(program.id), w1.id);
  assert.deepEqual(list.map((x) => [x.name, x.group_label, x.group_kind, x.group_tag]), [['Back squat', 'A', 'circuit', 'A1'], ['Bent-over row', 'A', 'circuit', 'A2'], ['Plank', null, null, null], ['Romanian deadlift', null, null, null]]);
  // A blank clears a field; a field left out stays; the text follows.
  const rd = list[3];
  const ch = (await coach('PATCH', `/v1/workout-exercises/${rd.id}`, { load_text: '', tempo: '2-0-2', rest_seconds: 0 })).body;
  assert.deepEqual([ch.prescription, ch.sets, ch.reps, ch.load_text, ch.tempo, ch.rest_seconds, ch.details], ['3 × 8-10', 3, '8-10', null, '2-0-2', 0, 'Tempo 2-0-2 · No rest']);
  // A swap keeps every field.
  const sw = (await coach('PATCH', `/v1/workout-exercises/${rd.id}`, { exercise_id: plank.id })).body;
  assert.deepEqual([sw.name, sw.prescription, sw.tempo], ['Plank', '3 × 8-10', '2-0-2']);
  await coach('PATCH', `/v1/workout-exercises/${rd.id}`, { exercise_id: rdl.id });
});

test('remove and undo, and copying a workout, keep every field', async () => {
  let list = slots(await detail(program.id), w1.id);
  const sq = list[0];
  const gone = (await coach('DELETE', `/v1/workout-exercises/${sq.id}`)).body;
  assert.deepEqual(gone.restore, { workout_id: w1.id, exercise_id: squat.id, prescription: '4 × 5 @ 185 lb', load_test: null, load_pct: null, position: 1,
    sets: 4, reps: '5', tempo: '3-1-1', rest_seconds: 120, target_rpe: 8, load_text: '185 lb', group_label: 'A', group_kind: 'circuit', note: 'Pause at the bottom', form_check: 0, form_check_note: null });
  const { workout_id, ...back } = gone.restore;
  await coach('POST', `/v1/workouts/${workout_id}/exercises`, back);
  list = slots(await detail(program.id), w1.id);
  assert.deepEqual(list.map((x) => [x.name, x.position, x.group_tag, x.tempo]), [['Back squat', 1, 'A1', '3-1-1'], ['Bent-over row', 2, 'A2', null], ['Plank', 3, null, null], ['Romanian deadlift', 4, null, '2-0-2']]);
  // A place given outside the group is pulled back to the group's edge, so a group is never split.
  const stray = (await coach('POST', `/v1/workouts/${w1.id}/exercises`, { exercise_id: plank.id, sets: 2, reps: '10', group_label: 'A', position: 4 })).body.exercises;
  assert.deepEqual(stray.map((x) => x.group_tag), ['A1', 'A2', 'A3', null, null]);
  await coach('DELETE', `/v1/workout-exercises/${stray[2].id}`);
  const copy = (await coach('POST', `/v1/workouts/${w1.id}/copy`, { week: 2, day: 1 })).body;
  const copied = slots(await detail(program.id), copy.id);
  assert.deepEqual(copied.map((x) => [x.name, x.prescription, x.group_tag, x.rest_seconds, x.note]), list.map((x) => [x.name, x.prescription, x.group_tag, x.rest_seconds, x.note]));
});

test('the athlete app logs the sets from the fields and shows the details, and the weight-room screen has them too', async () => {
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  const home = (await athlete(ava)('GET', '/app/api/home')).body;
  const [sq, rw, pl, rd] = home.workout.exercises;
  assert.deepEqual([sq.target_sets, sq.target_reps, sq.details, sq.note, sq.group_tag, sq.group_kind], [4, 5, 'Tempo 3-1-1 · Rest 2 min · RPE 8', 'Pause at the bottom', 'A1', 'circuit']);
  assert.deepEqual([rw.target_sets, rw.target_reps, rw.group_tag], [4, 8, 'A2']);
  assert.deepEqual([pl.target_sets, pl.target_reps, pl.prescription], [1, null, 'Hold as long as you can'], 'free text: one set to tick');
  assert.deepEqual([rd.target_sets, rd.target_reps], [3, 8], 'a range counts the low end');
  const done = await athlete(ava)('POST', `/app/api/workouts/${home.workout.id}/complete`, { request_id: 'r1', sets: [{ workout_exercise_id: sq.id, set_no: 1, weight: 185, reps: 5 }] });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const log = (await athlete(ava)('GET', `/app/api/logs/${done.body.id}`)).body;
  assert.deepEqual([log.exercises[0].details, log.exercises[0].group_tag, log.exercises[0].target_sets, log.exercises[0].tempo], ['Tempo 3-1-1 · Rest 2 min · RPE 8', 'A1', 4, '3-1-1']);
  const view = workoutView(app.ctx, w1.id);
  assert.deepEqual(view.exercises.map((x) => [x.name, x.prescription, x.details, x.group_tag, x.group_kind]),
    [['Back squat', '4 × 5 @ 185 lb', 'Tempo 3-1-1 · Rest 2 min · RPE 8', 'A1', 'circuit'], ['Bent-over row', '4 × 8', null, 'A2', 'circuit'], ['Plank', 'Hold as long as you can', null, null, null], ['Romanian deadlift', '3 × 8-10', 'Tempo 2-0-2 · No rest', null, null]]);
  // Deleting the workout keeps the fields on the log.
  await coach('DELETE', `/v1/workouts/${w1.id}`, { confirm: true });
  const kept = (await athlete(ava)('GET', `/app/api/logs/${done.body.id}`)).body;
  assert.equal(kept.program_deleted, true);
  assert.deepEqual([kept.exercises[0].name, kept.exercises[0].prescription, kept.exercises[0].details, kept.exercises[0].group_tag, kept.exercises[0].target_sets], ['Back squat', '4 × 5 @ 185 lb', 'Tempo 3-1-1 · Rest 2 min · RPE 8', 'A1', 4]);
});

test('Build from a PDF: the draft carries the fields and saving keeps them', async () => {
  const ex = (name, extra = {}) => ({ name, library_match: '', sets: 3, reps: '8', tempo: '', rest_seconds: 0, rpe: 0, load_text: '', group: '', group_kind: '', load_lift: '', load_pct: 0, note: '', ...extra });
  app.ctx.readWorkoutFile = async () => ({ is_program: true, program: { name: 'From the file', description: '', level: '' }, unclear: [], workouts: [
    { week: 1, day: 1, title: 'Day 1', exercises: [
      ex('Back squat', { sets: 5, reps: '3', tempo: '2-1-X', rest_seconds: 180, rpe: 8.5, load_text: '', group: 'a', group_kind: 'superset' }),
      ex('Bent-over row', { sets: 5, reps: '6', group: 'A', group_kind: '' }),
      ex('Plank', { sets: 0, reps: '', prescription: '3 × 45 sec', rest_seconds: 5000, rpe: 11, group: 'ZZ' }),
      ex('Sled push', { sets: 20, reps: '20 yd', load_text: 'moderate' })] }] });
  const read = await coach('POST', '/v1/programs/import/draft', { file: { name: 'p.pdf', data_base64: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64') } });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const lines = read.body.workouts[0].exercises;
  assert.deepEqual(lines.map((x) => [x.name, x.prescription, x.sets, x.reps, x.tempo, x.rest_seconds, x.target_rpe, x.group_label, x.group_kind]), [
    ['Back squat', '5 × 3', 5, '3', '2-1-X', 180, 8.5, 'A', 'superset'],
    ['Bent-over row', '5 × 6', 5, '6', null, null, null, 'A', 'superset'],
    ['Plank', '3 × 45 sec', 3, '45 sec', null, null, null, null, null],
    ['Sled push', '20 × 20 yd @ moderate', null, '20 × 20 yd', null, null, null, null, null]], 'an older draft\'s prescription is split; out-of-range values are dropped for the coach to fill in');
  assert.deepEqual(read.body.notes.filter((n) => /Plank|Sled/.test(n)).length, 4, read.body.notes.join('\n'));
  assert.ok(read.body.notes.some((n) => /Sled push: 20 sets is more than the 12/.test(n)));
  assert.ok(read.body.notes.some((n) => /Plank: a rest of 5000 seconds/.test(n)) && read.body.notes.some((n) => /Plank: an RPE of 11/.test(n)) && read.body.notes.some((n) => /Plank: the group "ZZ"/.test(n)));
  const split = await coach('POST', '/v1/programs/import', { program: { name: 'Split group' }, workouts: [{ week: 1, day: 1, title: 'Day 1', exercises: [
    { exercise_id: squat.id, sets: 3, reps: '5', group_label: 'A', group_kind: 'superset' }, { exercise_id: plank.id, sets: 3, reps: '30 sec' }, { exercise_id: row.id, sets: 3, reps: '8', group_label: 'A', group_kind: 'circuit' }] }] });
  assert.equal(split.status, 400);
  assert.deepEqual(split.body.error.details.problems, ['Week 1, day 1: the exercises in group A (1, 3) need to be next to each other.']);
  const bad = await coach('POST', '/v1/programs/import', { program: { name: 'From the file' }, workouts: [{ week: 1, day: 1, title: 'Day 1', exercises: [
    { exercise_id: squat.id, sets: 13, reps: '3' }, { exercise_id: rdl.id, sets: 3, reps: '8', group_kind: 'circuit' }, { exercise_id: plank.id }] }] });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.details.problems, ['Week 1, day 1, exercise 1: sets must be a whole number between 1 and 12.', 'Week 1, day 1, exercise 2: give the group a letter too (A, B, C...), so the exercises in it go together.', 'Week 1, day 1, exercise 3: add the sets and reps, like 3 × 8.']);
  const ok = await coach('POST', '/v1/programs/import', { program: { name: 'From the file' }, workouts: [{ week: 1, day: 1, title: 'Day 1', exercises: [
    { exercise_id: squat.id, sets: 5, reps: '3', tempo: '2-1-X', rest_seconds: 180, target_rpe: 8.5, group_label: 'A', group_kind: 'superset' },
    { exercise_id: row.id, sets: 5, reps: '6', group_label: 'A', group_kind: 'circuit', note: 'Elbows in' },
    { exercise_id: plank.id, prescription: '3 × 45 sec' }] }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const saved = slots(await detail(ok.body.program_id), (await detail(ok.body.program_id)).workouts[0].id);
  assert.deepEqual(saved.map((x) => [x.name, x.prescription, x.details, x.group_tag, x.note]), [
    ['Back squat', '5 × 3', 'Tempo 2-1-X · Rest 3 min · RPE 8.5', 'A1', null], ['Bent-over row', '5 × 6', null, 'A2', 'Elbows in'], ['Plank', '3 × 45 sec', null, null, null]]);
});

test('a version 48 database gains the fields and its prescriptions are split, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v48.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 48');
    old.exec(`INSERT INTO exercises (id, name, created_at) VALUES ('ex_1', 'Back squat', '2026-09-01T00:00:00Z');
      INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_1', 'Old', 1, '2026-09-01T00:00:00Z');
      INSERT INTO workouts (id, program_id, week, day, title) VALUES ('wo_1', 'prog_1', 1, 1, 'Day 1');
      INSERT INTO workout_exercises (id, workout_id, exercise_id, position, prescription, load_test, load_pct) VALUES
        ('wex_1', 'wo_1', 'ex_1', 1, '3 × 8 @ 135 lb', NULL, NULL), ('wex_2', 'wo_1', 'ex_1', 2, '4x5/side', 'squat_1rm', 75),
        ('wex_3', 'wo_1', 'ex_1', 3, 'Easy jog 10 min', NULL, NULL), ('wex_4', 'wo_1', 'ex_1', 4, '20 × 20 yd', NULL, NULL), ('wex_5', 'wo_1', 'ex_1', 5, '3 × 5 RPE 8', NULL, NULL)`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 65, `round ${round}`);
      const rows = d.all('SELECT id, prescription, sets, reps, load_text, target_rpe, load_test, load_pct, group_label FROM workout_exercises ORDER BY position').map((r) => ({ ...r }));
      assert.deepEqual(rows, [
        { id: 'wex_1', prescription: '3 × 8 @ 135 lb', sets: 3, reps: '8', load_text: '135 lb', target_rpe: null, load_test: null, load_pct: null, group_label: null },
        { id: 'wex_2', prescription: '4x5/side', sets: 4, reps: '5/side', load_text: null, target_rpe: null, load_test: 'squat_1rm', load_pct: 75, group_label: null },
        { id: 'wex_3', prescription: 'Easy jog 10 min', sets: null, reps: 'Easy jog 10 min', load_text: null, target_rpe: null, load_test: null, load_pct: null, group_label: null },
        { id: 'wex_4', prescription: '20 × 20 yd', sets: null, reps: '20 × 20 yd', load_text: null, target_rpe: null, load_test: null, load_pct: null, group_label: null },
        { id: 'wex_5', prescription: '3 × 5 RPE 8', sets: 3, reps: '5', load_text: null, target_rpe: 8, load_test: null, load_pct: null, group_label: null }], `round ${round}: the text stays, the fields are the best we can tell`);
      const fresh = openDb(':memory:');
      assert.deepEqual(d.all('PRAGMA table_info(workout_exercises)').map((c) => c.name).sort(), fresh.all('PRAGMA table_info(workout_exercises)').map((c) => c.name).sort());
      fresh.close(); d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
