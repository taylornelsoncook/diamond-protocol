import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';

// Programs → Dictate a workout: what a coach types or speaks goes to Claude as text and comes back as the same draft
// as Build from a PDF, checked and saved the same way. Owners and coaches only.
let app, base, coach, desk, squat, seen;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const ex = (name, extra = {}) => ({ name, library_match: '', sets: 3, reps: '8', tempo: '', rest_seconds: 0, rpe: 0, load_text: '', group: '', group_kind: '', load_lift: '', load_pct: 0, note: '', ...extra });
const DRAFT = { is_program: true, program: { name: '', description: '', level: '' }, unclear: ['"Then the thing with the band" wasn\'t clear.'], workouts: [
  { week: 1, day: 1, title: 'Lower body', exercises: [ex('back squat', { sets: 4, reps: '5', load_lift: 'squat_1rm', load_pct: 75, rest_seconds: 120, group: 'A', group_kind: 'superset' }), ex('RDL', { group: 'A', group_kind: 'superset' }), ex('plank', { sets: 3, reps: '40 sec' })] }] };

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  await coach('POST', '/v1/exercises', { name: 'Romanian deadlift' });
});
beforeEach(() => { app.ctx.readWorkoutFile = async (req) => { seen = req; return structuredClone(DRAFT); }; });
after(() => app.server.close());

test('what the coach said goes to Claude as text, with dictation in mind, and comes back as the usual draft', async () => {
  const said = 'Lower body. Back squat four by five at seventy five percent, two minutes rest, superset with RDL three by eight. Then plank three by forty seconds.';
  const r = await coach('POST', '/v1/programs/dictate/draft', { text: said });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(seen.block, { type: 'text', text: said }, 'sent as text, not a file');
  assert.match(seen.system, /typed or dictated description/);
  assert.match(seen.system, /"three by eight"/);
  assert.match(seen.system, /A single workout with no day is week 1, day 1/);
  assert.ok(seen.system.includes('Back squat\nRomanian deadlift'), 'the library is listed');
  const d = r.body;
  assert.deepEqual([d.source, d.filename, d.program.name, d.weeks, d.counts.workouts], ['text', 'your notes', 'Dictated workout', 1, 1]);
  const [sq, rdl, plank] = d.workouts[0].exercises;
  assert.deepEqual([sq.how, sq.exercise_id, sq.prescription, sq.load_test, sq.load_pct, sq.rest_seconds, sq.group_label, sq.group_kind], ['exact', squat.id, '4 × 5', 'squat_1rm', 75, 120, 'A', 'superset']);
  assert.deepEqual([rdl.how, rdl.exercise_name, rdl.group_label], ['exact', 'Romanian deadlift', 'A'], 'RDL is the library\'s Romanian deadlift');
  assert.deepEqual([plank.how, plank.prescription], [null, '3 × 40 sec'], 'not in the library: offered as new');
  assert.deepEqual(d.notes, ['"Then the thing with the band" wasn\'t clear.']);
  // The draft saves through the same route as a PDF's.
  const saved = await coach('POST', '/v1/programs/import', { program: { name: 'Monday lower' }, workouts: [{ week: 1, day: 1, title: 'Lower body', exercises: [
    { exercise_id: sq.exercise_id, sets: sq.sets, reps: sq.reps, rest_seconds: sq.rest_seconds, group_label: 'A', group_kind: 'superset', load_test: sq.load_test, load_pct: sq.load_pct },
    { exercise_id: rdl.exercise_id, sets: 3, reps: '8', group_label: 'A', group_kind: 'superset' }, { new_exercise: { name: 'Plank', category: null }, sets: 3, reps: '40 sec' }] }] });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const p = (await coach('GET', `/v1/programs/${saved.body.program_id}`)).body;
  assert.deepEqual(p.workouts[0].exercises.map((x) => [x.name, x.prescription, x.group_tag]), [['Back squat', '4 × 5', 'A1'], ['Romanian deadlift', '3 × 8', 'A2'], ['Plank', '3 × 40 sec', null]]);
});

test('too little, too much, not a workout, and front desk', async () => {
  const empty = await coach('POST', '/v1/programs/dictate/draft', { text: '   ' });
  assert.equal(empty.status, 400); assert.match(empty.body.error.message, /text is required/);
  const short = await coach('POST', '/v1/programs/dictate/draft', { text: 'squat' });
  assert.equal(short.status, 400); assert.match(short.body.error.message, /Say or type the workout first/);
  const long = await coach('POST', '/v1/programs/dictate/draft', { text: 'a'.repeat(20001) });
  assert.equal(long.status, 400); assert.match(long.body.error.message, /20000 characters or fewer/);
  assert.equal((await coach('POST', '/v1/programs/dictate/draft', { text: ['back squat 3 by 5'] })).status, 400);
  app.ctx.readWorkoutFile = async (req) => { seen = req; return { is_program: false, program: { name: '', description: '', level: '' }, workouts: [], unclear: [] }; };
  const nope = await coach('POST', '/v1/programs/dictate/draft', { text: 'Remind me to order more cones for Thursday' });
  assert.equal(nope.status, 400); assert.match(nope.body.error.message, /didn't find a workout in that/);
  assert.equal((await desk('POST', '/v1/programs/dictate/draft', { text: 'back squat three by five' })).status, 403, 'front desk can\'t build programs');
  // A PDF draft still says it came from a file, with the file's instructions.
  const pdf = await coach('POST', '/v1/programs/import/draft', { file: { name: 'p.pdf', data_base64: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64') } });
  assert.equal(pdf.status, 400, 'the stub says it isn\'t a program');
  assert.match(seen.system, /a PDF or a photo/);
  assert.equal(seen.block.type, 'document');
});
