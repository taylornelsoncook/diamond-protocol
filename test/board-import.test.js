// Programs → Build from a picture: a photo of the whiteboard is read by Claude with the owner's drawing rules (a solid
// line starts a new block, a dashed line a new complex inside it), lines are matched to the exercise library and to
// the complex library, and the checked draft is saved as one workout whose blocks follow the board. All or nothing;
// front desk can't; the request to Anthropic carries the photo, the rules and both libraries.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';

let app, base, owner, coach, desk, goodMorning, ohPress, ropeChop, flex;
const PW = 'correct-horse-battery';
async function call(cookie, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
}
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (m, p, b) => call(cookie, m, p, b);
}
const db = () => app.ctx.db;
// A 1×1 PNG stands in for the photo.
const PNG = { name: 'board.jpg', data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
const line = (name, extra = {}) => ({ name, library_match: '', complex_match: '', sets: 0, reps: '', distance: '', tempo: '', rest_seconds: 0, rpe: 0, load_text: '', load_lift: '', load_pct: 0, note: '', ...extra });
// What Claude hands back for the owner's whiteboard: four parts between solid lines, the first with three dashed parts.
const DRAFT = {
  is_workout: true, title: 'Lower body and shoulders',
  sections: [
    { name: 'Warm up', groups: [
      { name: '', kind: '', complex_match: '', lines: [line('On Ground Warm up'), line('Dynamic Flex', { complex_match: 'Dynamic flex' })] },
      { name: '', kind: '', complex_match: '', lines: [line('Drills'), line('Primers')] },
      { name: '', kind: '', complex_match: '', lines: [line('Treadmill Assisted')] }] },
    { name: 'Mobility', groups: [{ name: '', kind: '', complex_match: '', lines: [line('Rope Chop', { reps: '6', library_match: 'Rope chop' }), line('Fwd Scoop Toss', { reps: '3' }), line('PVC T-Spine', { reps: '5' })] }] },
    { name: 'Strength', groups: [{ name: '', kind: '', complex_match: '', lines: [line('Barbell Good Morning', { reps: '10' }), line('Bosu Ball Hamstring Curl', { reps: '15' }), line('DB Seated OH Press', { sets: 4, reps: '10, 8, 6, 4' }), line('Plate High Pull', { reps: '15' })] }] },
    { name: 'Finisher', groups: [{ name: '', kind: '', complex_match: '', lines: [line('Barbell Curls', { reps: '100' })] }] }
  ],
  unclear: ['The third line of the first part could be "Drills" or "Drill".']
};
let seen = null;

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  goodMorning = (await owner('POST', '/v1/exercises', { name: 'Barbell good morning', category: 'Lower body' })).body;
  ohPress = (await owner('POST', '/v1/exercises', { name: 'Dumbbell seated overhead press', category: 'Upper body' })).body;
  ropeChop = (await owner('POST', '/v1/exercises', { name: 'Rope chop' })).body;
  const hip = (await owner('POST', '/v1/exercises', { name: 'Hip circles', category: 'Mobility' })).body;
  const leg = (await owner('POST', '/v1/exercises', { name: 'Leg swings', category: 'Mobility' })).body;
  flex = (await owner('POST', '/v1/complexes', { name: 'Dynamic flex', kind: 'block', exercises: [{ exercise_id: hip.id, sets: 1, reps: '10/side' }, { exercise_id: leg.id, sets: 1, reps: '10/side' }] })).body;
});
beforeEach(() => { app.ctx.readWorkoutFile = async (req) => { seen = req; return structuredClone(DRAFT); }; });
after(() => app.server.close());

test('the photo goes to Claude with the drawing rules, both libraries and the board schema; a PDF is refused', async () => {
  const r = await coach('POST', '/v1/programs/board/draft', { file: PNG });
  assert.equal(r.status, 200, r.text);
  assert.equal(seen.block.type, 'image');
  assert.equal(seen.block.source.media_type, 'image/jpeg');
  assert.match(seen.system, /solid horizontal line.*new section/i);
  assert.match(seen.system, /dashed or dotted horizontal line/i);
  assert.match(seen.system, /x10, 8, 6, 4/);
  assert.match(seen.system, /Barbell good morning/, 'the exercise library is listed');
  assert.match(seen.system, /complex library \(one per line\):\nDynamic flex/, 'the complex library is listed');
  assert.deepEqual(seen.schema.required, ['is_workout', 'title', 'sections', 'unclear']);
  assert.match(seen.prompt, /whiteboard/);
  const pdf = await coach('POST', '/v1/programs/board/draft', { file: { name: 'program.pdf', data_base64: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64') } });
  assert.equal(pdf.status, 400); assert.match(pdf.body.error.message, /photo of the whiteboard.*Build from a PDF/);
  assert.equal((await desk('POST', '/v1/programs/board/draft', { file: PNG })).status, 403, 'front desk can\'t');
});

test('the draft follows the lines: sections for solid lines, blocks for dashed ones, lines matched to exercises and complexes', async () => {
  const d = (await owner('POST', '/v1/programs/board/draft', { file: PNG })).body;
  assert.equal(d.source, 'photo'); assert.equal(d.title, 'Lower body and shoulders');
  assert.deepEqual(d.sections.map((s) => [s.name, s.blocks.length]), [['Warm up', 3], ['Mobility', 1], ['Strength', 1], ['Finisher', 1]]);
  assert.deepEqual(d.sections[0].blocks.map((b) => [b.name, b.section, b.part, b.kind]), [['Warm up 1', 1, 1, 'block'], ['Warm up 2', 1, 2, 'block'], ['Warm up 3', 1, 3, 'block']], 'a section with several parts numbers them');
  assert.equal(d.sections[1].blocks[0].name, 'Mobility', 'a section with one part keeps its name');
  const warm = d.sections[0].blocks[0].exercises;
  assert.equal(warm[0].name, 'On Ground Warm up'); assert.equal(warm[0].how, null); assert.equal(warm[0].complex, null); assert.equal(warm[0].sets, 1, 'a line with nothing written is one set');
  assert.equal(warm[0].prescription, '1 set');
  assert.deepEqual(warm[1].complex, { complex_id: flex.id, complex_name: 'Dynamic flex', how: 'exact' }, 'a line naming a complex is matched to it');
  const strength = d.sections[2].blocks[0].exercises;
  assert.equal(strength[0].how, 'exact'); assert.equal(strength[0].exercise_id, goodMorning.id, 'the same name matches on its own');
  assert.equal(strength[2].how, 'exact'); assert.equal(strength[2].exercise_id, ohPress.id, 'abbreviations are read: DB seated OH press');
  assert.equal(strength[2].sets, 4); assert.equal(strength[2].reps, '10, 8, 6, 4'); assert.equal(strength[2].prescription, '4 × 10, 8, 6, 4');
  assert.equal(strength[1].how, null, 'Bosu ball hamstring curl is new');
  const mob = d.sections[1].blocks[0].exercises;
  assert.equal(mob[0].exercise_id, ropeChop.id); assert.equal(mob[0].reps, '6');
  assert.deepEqual(d.counts, { sections: 4, blocks: 6, exercises: 13, exact: 3, suggested: 0, new: 9, complexes: 1 });
  assert.deepEqual(d.notes, ['The third line of the first part could be "Drills" or "Drill".']);
});

test('a whole part that is a library complex is offered as one', async () => {
  app.ctx.readWorkoutFile = async () => ({ is_workout: true, title: 'Speed', sections: [{ name: 'Warm up', groups: [{ name: '', kind: '', complex_match: 'Dynamic flex', lines: [line('Hip circles', { reps: '10/side' }), line('Leg swings', { reps: '10/side' })] }] }, { name: 'Speed', groups: [{ name: '', kind: 'circuit', complex_match: '', lines: [line('Rope chop', { reps: '6' })] }] }], unclear: [] });
  const d = (await owner('POST', '/v1/programs/board/draft', { file: PNG })).body;
  assert.deepEqual(d.sections[0].blocks[0].complex, { complex_id: flex.id, complex_name: 'Dynamic flex', how: 'exact' });
  assert.equal(d.sections[1].blocks[0].kind, 'circuit');
  assert.equal(d.counts.complexes, 1);
});

test('not a workout, or nothing readable, is said plainly', async () => {
  app.ctx.readWorkoutFile = async () => ({ is_workout: false, title: '', sections: [], unclear: [] });
  let r = await owner('POST', '/v1/programs/board/draft', { file: PNG });
  assert.equal(r.status, 400); assert.match(r.body.error.message, /didn't find a workout in that picture/);
  app.ctx.readWorkoutFile = async () => ({ is_workout: true, title: 'x', sections: [{ name: 'A', groups: [{ name: '', kind: '', complex_match: '', lines: [] }] }], unclear: [] });
  r = await owner('POST', '/v1/programs/board/draft', { file: PNG });
  assert.equal(r.status, 400); assert.match(r.body.error.message, /couldn't read any exercise lines/);
});

test('saving writes one workout whose blocks follow the board, loads complexes in place and saves a block to the library', async () => {
  const d = (await owner('POST', '/v1/programs/board/draft', { file: PNG })).body;
  const toLine = (x) => (x.complex?.how === 'exact' ? { complex_id: x.complex.complex_id } : x.how === 'exact' ? { exercise_id: x.exercise_id, sets: x.sets, reps: x.reps, load_test: null } : { new_exercise: { name: x.name, category: null }, sets: x.sets, reps: x.reps, load_test: null });
  const blocks = d.sections.flatMap((s) => s.blocks).map((b) => ({ name: b.name, kind: b.kind, complex_id: null, save_as_complex: null, exercises: b.exercises.map(toLine) }));
  blocks[3].save_as_complex = 'Mobility opener';   // the mobility part is one we write every time
  blocks[5].kind = 'circuit';
  const r = await coach('POST', '/v1/programs/board-import', { program: { name: 'Tuesday board', level: 'All levels', description: '' }, title: 'Lower body and shoulders', week: 1, day: 2, blocks });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.blocks, 6); assert.equal(r.body.exercises, 14, 'the complex brings its two exercises in place of its line'); assert.equal(r.body.new_exercises, 9);
  assert.deepEqual(r.body.complexes_saved, ['Mobility opener']);
  const p = (await coach('GET', `/v1/programs/${r.body.program_id}`)).body;
  assert.equal(p.name, 'Tuesday board'); assert.equal(p.weeks, 1); assert.equal(p.author_name, 'Carl Coach');
  const w = p.workouts[0];
  assert.equal(w.week, 1); assert.equal(w.day, 2); assert.equal(w.title, 'Lower body and shoulders');
  assert.deepEqual(w.blocks.map((b) => [b.name, b.kind, b.count, b.position]), [['Warm up 1', 'block', 3, 1], ['Warm up 2', 'block', 2, 2], ['Warm up 3', 'block', 1, 3], ['Mobility', 'block', 3, 4], ['Strength', 'block', 4, 5], ['Finisher', 'circuit', 1, 6]]);
  assert.deepEqual(w.exercises.slice(0, 3).map((x) => [x.name, x.prescription, x.group_tag]), [['On Ground Warm up', '1 set', 'A1'], ['Hip circles', '1 × 10/side', 'A2'], ['Leg swings', '1 × 10/side', 'A3']], 'the complex\'s exercises sit where its line was');
  assert.deepEqual(w.exercises.map((x) => x.position), w.exercises.map((_, i) => i + 1));
  assert.equal(w.exercises.find((x) => x.name === 'Dumbbell seated overhead press').prescription, '4 × 10, 8, 6, 4');
  assert.equal(w.exercises.at(-1).group_kind, 'circuit');
  const cx = (await owner('GET', '/v1/complexes')).body.data.find((c) => c.name === 'Mobility opener');
  assert.ok(cx, 'the block is in the complex library');
  assert.deepEqual(cx.exercises.map((x) => [x.name, x.prescription]), [['Rope chop', '6'], ['Fwd Scoop Toss', '3'], ['PVC T-Spine', '5']]);
  assert.equal(cx.used_in, 1); assert.equal(cx.kind, 'block');
  assert.equal(w.blocks[3].complex_id, cx.id, 'the block points at it');
  assert.equal(db().get('SELECT COUNT(*) AS n FROM exercises WHERE lower(name) = ?', 'bosu ball hamstring curl').n, 1);
});

test('a whole block loaded as a library complex, and adding the workout to a program on a free day', async () => {
  const prog = (await owner('POST', '/v1/programs', { name: 'In-season', weeks: 2 })).body;
  const r = await owner('POST', '/v1/programs/board-import', { program_id: prog.id, title: 'Board day', week: 3, day: 1, blocks: [
    { name: 'Warm up', kind: 'block', complex_id: flex.id, exercises: [] },
    { name: 'Strength', kind: 'superset', exercises: [{ exercise_id: goodMorning.id, sets: 3, reps: '10' }, { exercise_id: ohPress.id, sets: 3, reps: '8', load_text: '35 lb' }] }] });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.added_to_existing, true); assert.equal(r.body.exercises, 4);
  const p = (await owner('GET', `/v1/programs/${prog.id}`)).body;
  assert.equal(p.weeks, 3, 'the program grows to the week');
  const w = p.workouts.find((x) => x.week === 3);
  assert.deepEqual(w.blocks.map((b) => [b.name, b.kind, b.count, b.complex_id]), [['Warm up', 'block', 2, flex.id], ['Strength', 'superset', 2, null]]);
  assert.deepEqual(w.exercises.map((x) => [x.name, x.group_tag]), [['Hip circles', 'A1'], ['Leg swings', 'A2'], ['Barbell good morning', 'B1'], ['Dumbbell seated overhead press', 'B2']]);
  const again = await owner('POST', '/v1/programs/board-import', { program_id: prog.id, title: 'Board day', week: 3, day: 1, blocks: [{ name: 'Strength', kind: 'block', exercises: [{ exercise_id: goodMorning.id, sets: 3, reps: '10' }] }] });
  assert.equal(again.status, 400); assert.match(again.body.error.details.problems[0], /Week 3, day 1 already has a workout in In-season/);
});

test('saving is all or nothing with every problem listed, and front desk can\'t', async () => {
  const before = db().get('SELECT COUNT(*) AS n FROM workouts').n, exBefore = db().get('SELECT COUNT(*) AS n FROM exercises').n;
  const r = await owner('POST', '/v1/programs/board-import', { program: { name: 'Bad board' }, title: 'x', week: 1, day: 9, blocks: [
    { name: 'A', kind: 'sideways', exercises: [{ exercise_id: 'ex_gone', sets: 3, reps: '8' }, { new_exercise: { name: 'Rope chop' }, sets: 3, reps: '8' }, { sets: 3, reps: '8' }, { exercise_id: goodMorning.id, sets: 40, reps: '8' }, { complex_id: 'cpx_gone' }] },
    { name: 'B', kind: 'block', exercises: [], complex_id: 'cpx_gone' },
    { name: 'C', kind: 'block', save_as_complex: 'Dynamic flex', exercises: [{ exercise_id: goodMorning.id, sets: 3, reps: '8' }] },
    { name: 'D', kind: 'block', save_as_complex: 'Twice', exercises: [{ new_exercise: { name: 'Tyre flip' }, sets: 3, reps: '8' }] },
    { name: 'E', kind: 'block', save_as_complex: 'twice', exercises: [{ new_exercise: { name: 'Tyre flip' }, sets: 3, reps: '8' }] },
    { name: 'F', kind: 'block', exercises: [] }] });
  assert.equal(r.status, 400);
  const ps = r.body.error.details.problems;
  assert.match(ps[0], /day must be 1 to 7/);
  assert.match(ps.find((p) => /Block 1:/.test(p)), /block, superset or circuit/);
  assert.match(ps.find((p) => /Block 1, line 1/.test(p)), /isn't in the library any more/);
  assert.match(ps.find((p) => /Block 1, line 2/.test(p)), /Rope chop is already in the library/);
  assert.match(ps.find((p) => /Block 1, line 3/.test(p)), /choose an exercise from the library/);
  assert.match(ps.find((p) => /Block 1, line 4/.test(p)), /sets/i);
  assert.match(ps.find((p) => /Block 1, line 5/.test(p)), /complex isn't in the library any more/);
  assert.match(ps.find((p) => /Block 2:/.test(p)), /complex isn't in the library any more/);
  assert.match(ps.find((p) => /Block 3:/.test(p)), /a complex called Dynamic flex is already in the library/);
  assert.match(ps.find((p) => /Block 5:/.test(p)), /two blocks would be saved as the complex twice/);
  assert.match(ps.find((p) => /Block 6/.test(p)), /has no exercises/);
  assert.equal(r.body.error.details.problem_count, ps.length);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM workouts').n, before, 'nothing saved');
  assert.equal(db().get('SELECT COUNT(*) AS n FROM exercises').n, exBefore, 'no new exercise either');
  assert.equal(db().get('SELECT COUNT(*) AS n FROM complexes WHERE name = ?', 'Twice').n, 0);
  assert.equal((await desk('POST', '/v1/programs/board-import', { program: { name: 'x' }, blocks: [] })).status, 403);
});
