// Programs → Build from a PDF: Claude reads a program file into a draft, the coach checks every line and saves it as a
// new program or as weeks added to one. Exercise names are matched only when they're the same (or marked to check);
// saving is all or nothing; front desk can't; and the request to Anthropic has the file, the library and the schema.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { normName } from '../src/services/workoutimport.js';

let app, base, owner, coach, desk, squat, rdl;
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
const PDF = { name: 'Summer strength.pdf', data_base64: Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n').toString('base64') };
const ex = (name, extra = {}) => ({ name, library_match: '', prescription: '3 × 8', load_lift: '', load_pct: 0, note: '', ...extra });
// What Claude hands back for the sample file.
const DRAFT = {
  is_program: true,
  program: { name: 'Summer strength', description: 'Four weeks, two days a week.', level: 'Intermediate' },
  workouts: [
    { week: 1, day: 1, title: 'Lower body', exercises: [ex('Back Squats', { load_lift: 'squat_1rm', load_pct: 75, prescription: '4 × 5' }), ex('RDL'), ex('DB split squat', { prescription: '3 × 8/side', note: 'Superset with the next' }), ex('Rear-foot elevated split squat', { library_match: 'Goblet squat' })] },
    { week: 1, day: 2, title: 'Upper body', exercises: [ex('Bench press', { load_lift: 'bench_1rm', load_pct: 200 }), ex('Pallof press', { library_match: 'Not in the library' })] },
    { week: 1, day: 2, title: 'Twice', exercises: [ex('Plank')] },
    { week: 60, day: 1, title: 'Too far', exercises: [ex('Plank')] },
    { week: 2, day: 1, title: 'Lower body', exercises: [ex('Back squat', { load_lift: 'squat_1rm', load_pct: 80, prescription: '4 × 4' })] }
  ],
  unclear: ['Page 2 has a conditioning block without sets or reps.']
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
  squat = (await owner('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  rdl = (await owner('POST', '/v1/exercises', { name: 'Romanian deadlift' })).body;
  await owner('POST', '/v1/exercises', { name: 'Goblet squat' });
  await owner('POST', '/v1/exercises', { name: 'Bench press' });
});
beforeEach(() => { app.ctx.readWorkoutFile = async (req) => { seen = req; return structuredClone(DRAFT); }; });
after(() => app.server.close());

test('names match on abbreviations and plurals only', () => {
  assert.equal(normName('RDL'), normName('Romanian deadlift'));
  assert.equal(normName('Back Squats'), normName('back squat'));
  assert.equal(normName('DB bench press'), 'dumbbell bench press');
  assert.equal(normName('Push ups'), normName('Push-up'));
  assert.notEqual(normName('Front squat'), normName('Back squat'));
});

test('a file becomes a draft to check: matches, suggestions, new exercises and notes; nothing is saved', async () => {
  const before = db().get('SELECT COUNT(*) AS n FROM programs').n;
  const r = await coach('POST', '/v1/programs/import/draft', { file: PDF });
  assert.equal(r.status, 200, r.text);
  const d = r.body;
  assert.equal(seen.block.type, 'document');
  assert.equal(seen.block.source.media_type, 'application/pdf');
  assert.match(seen.system, /Romanian deadlift/, 'Claude sees the library');
  assert.deepEqual([d.program.name, d.program.level, d.weeks], ['Summer strength', 'Intermediate', 2]);
  assert.deepEqual(d.workouts.map((w) => `${w.week}-${w.day}`), ['1-1', '1-2', '2-1'], 'a repeated day and week 60 are left out');
  assert.ok(d.notes.some((n) => /conditioning block/.test(n)));
  assert.ok(d.notes.some((n) => /came up twice/.test(n)));
  assert.ok(d.notes.some((n) => /Too far/.test(n)));
  const [sq, rd, split, rfe] = d.workouts[0].exercises;
  assert.deepEqual([sq.exercise_id, sq.how, sq.load_test, sq.load_pct], [squat.id, 'exact', 'squat_1rm', 75]);
  assert.deepEqual([rd.exercise_id, rd.how], [rdl.id, 'exact'], 'RDL is the Romanian deadlift');
  assert.deepEqual([split.exercise_id, split.how, split.note], [null, null, 'Superset with the next'], 'not in the library: offered as new');
  assert.deepEqual([rfe.exercise_name, rfe.how], ['Goblet squat', 'suggested'], 'Claude\'s match is only a suggestion to check');
  const [bench, pallof] = d.workouts[1].exercises;
  assert.equal(bench.load_test, null, 'a percent over 110 is dropped');
  assert.equal(pallof.exercise_id, null, 'a library name that doesn\'t exist is ignored');
  assert.deepEqual(d.counts, { workouts: 3, exercises: 7, exact: 4, suggested: 1, new: 2 });
  assert.equal(db().get('SELECT COUNT(*) AS n FROM programs').n, before);
});

test('files that aren\'t a program, or aren\'t a PDF or photo, get a plain answer', async () => {
  assert.equal((await coach('POST', '/v1/programs/import/draft', { file: { name: 'plan.docx', data_base64: 'AAAA' } })).status, 400);
  assert.match((await coach('POST', '/v1/programs/import/draft', { file: { name: 'plan.pdf', data_base64: Buffer.from('hello').toString('base64') } })).body.error.message, /isn't a PDF/);
  assert.equal((await coach('POST', '/v1/programs/import/draft', {})).status, 400);
  app.ctx.readWorkoutFile = async () => ({ is_program: false, program: { name: '', description: '', level: '' }, workouts: [], unclear: [] });
  assert.match((await coach('POST', '/v1/programs/import/draft', { file: PDF })).body.error.message, /didn't find a training program/);
  app.ctx.readWorkoutFile = async (req) => { seen = req; return structuredClone(DRAFT); };
  const photo = await coach('POST', '/v1/programs/import/draft', { file: { name: 'whiteboard.JPG', data_base64: Buffer.from('fake jpeg').toString('base64') } });
  assert.equal(photo.status, 200, photo.text);
  assert.deepEqual([seen.block.type, seen.block.source.media_type], ['image', 'image/jpeg']);
});

test('saving is all or nothing: every problem listed, then one program with its new exercises added once', async () => {
  const programs = db().get('SELECT COUNT(*) AS n FROM programs').n, exercises = db().get('SELECT COUNT(*) AS n FROM exercises').n;
  const bad = await coach('POST', '/v1/programs/import', { program: { name: 'Summer strength' }, workouts: [
    { week: 1, day: 1, title: 'Lower', exercises: [{ exercise_id: squat.id, prescription: '' }, { exercise_id: null, prescription: '3 × 8' }, { new_exercise: { name: 'back SQUAT' }, prescription: '3 × 8' }, { exercise_id: squat.id, prescription: '3 × 5', load_test: 'squat_1rm', load_pct: 5 }] },
    { week: 1, day: 1, title: 'Again', exercises: [{ exercise_id: rdl.id, prescription: '3 × 8' }] },
    { week: 1, day: 3, title: 'Empty', exercises: [] }] });
  assert.equal(bad.status, 400, bad.text);
  const p = bad.body.error.details.problems;
  assert.equal(bad.body.error.details.problem_count, 6, p.join('\n'));
  assert.ok(p.some((x) => /exercise 1: add the sets and reps/.test(x)));
  assert.ok(p.some((x) => /exercise 2: choose an exercise/.test(x)));
  assert.ok(p.some((x) => /Back squat is already in the library/.test(x)));
  assert.ok(p.some((x) => /exercise 4: .*30 to 110/.test(x)));
  assert.ok(p.some((x) => /in the draft twice/.test(x)));
  assert.ok(p.some((x) => /day 3 has no exercises/.test(x)));
  assert.equal(db().get('SELECT COUNT(*) AS n FROM programs').n, programs, 'nothing saved');
  assert.equal(db().get('SELECT COUNT(*) AS n FROM exercises').n, exercises);

  const ok = await coach('POST', '/v1/programs/import', { program: { name: 'Summer strength', level: 'Intermediate', description: 'From the PDF' }, workouts: [
    { week: 1, day: 1, title: 'Lower body', exercises: [{ exercise_id: squat.id, prescription: '4 × 5', load_test: 'squat_1rm', load_pct: 75 }, { new_exercise: { name: 'DB split squat', category: 'Lower body' }, prescription: '3 × 8/side' }] },
    { week: 3, day: 2, title: 'Lower body', exercises: [{ new_exercise: { name: 'db split squat' }, prescription: '3 × 10/side' }, { exercise_id: rdl.id, prescription: '3 × 8' }] }] });
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual([ok.body.workouts, ok.body.exercises, ok.body.new_exercises, ok.body.added_to_existing], [2, 4, 1, false]);
  const prog = (await coach('GET', `/v1/programs/${ok.body.program_id}`)).body;
  assert.deepEqual([prog.name, prog.level, prog.weeks], ['Summer strength', 'Intermediate', 3], 'weeks reach the last week in the file');
  const first = prog.workouts.find((w) => w.week === 1).exercises;
  assert.deepEqual(first.map((x) => [x.name, x.prescription, x.load_test, x.load_pct]), [['Back squat', '4 × 5', 'squat_1rm', 75], ['DB split squat', '3 × 8/side', null, null]]);
  assert.equal(prog.workouts.find((w) => w.week === 3).exercises[0].exercise_id, first[1].exercise_id, 'the new exercise is added once and used twice');
  assert.equal(db().get('SELECT category FROM exercises WHERE name = ?', 'DB split squat').category, 'Lower body');

  // Adding to it: a day it already has is refused; new weeks stretch the program.
  const clash = await owner('POST', '/v1/programs/import', { program_id: ok.body.program_id, workouts: [{ week: 1, day: 1, title: 'x', exercises: [{ exercise_id: squat.id, prescription: '3 × 5' }] }] });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error.details.problems[0], /already has a workout in Summer strength/);
  const more = await owner('POST', '/v1/programs/import', { program_id: ok.body.program_id, workouts: [{ week: 5, day: 1, title: 'Test week', exercises: [{ exercise_id: squat.id, prescription: '1 × 3' }] }] });
  assert.equal(more.status, 201, more.text);
  assert.equal(more.body.added_to_existing, true);
  assert.equal((await owner('GET', `/v1/programs/${ok.body.program_id}`)).body.weeks, 5);
});

test('front desk can\'t read or save; without the key the page says what to do', async () => {
  assert.equal((await desk('POST', '/v1/programs/import/draft', { file: PDF })).status, 403);
  assert.equal((await desk('POST', '/v1/programs/import', { program: { name: 'x' }, workouts: [] })).status, 403);
  assert.equal((await coach('GET', '/v1/programs/import/status')).body.ready, true);
  delete app.ctx.readWorkoutFile;
  const had = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal((await coach('GET', '/v1/programs/import/status')).body.ready, false);
    const r = await coach('POST', '/v1/programs/import/draft', { file: PDF });
    assert.equal(r.status, 503);
    assert.match(r.body.error.message, /ANTHROPIC_API_KEY/);
  } finally { if (had) process.env.ANTHROPIC_API_KEY = had; }
});

test('the request to Anthropic: the file, the model, structured output and the fallback; errors in plain words', async () => {
  delete app.ctx.readWorkoutFile;
  const got = [];
  // A streamed answer, split in odd places like the network does; before: text from a model that declined partway.
  const sse = (text, stop = 'end_turn', { before = '' } = {}) => [
    { type: 'message_start', message: { id: 'msg_1' } },
    ...(before ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: before } },
      { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } } }] : []),
    { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: '' } },
    { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
    ...text.match(/.{1,40}/gs).map((t) => ({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: t } })),
    { type: 'message_delta', delta: { stop_reason: stop } }, { type: 'message_stop' }
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  let reply = { status: 200, stream: sse(JSON.stringify(DRAFT)) };
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: JSON.parse(b) });
      if (reply.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); const s = reply.stream; const cut = Math.floor(s.length / 3); res.write(s.slice(0, cut)); setTimeout(() => { res.write(s.slice(cut, cut * 2 + 7)); res.end(s.slice(cut * 2 + 7)); }, 5); return; }
      res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'sk-test'; process.env.ANTHROPIC_BASE_URL = `http://localhost:${fake.address().port}`;
  try {
    const r = await coach('POST', '/v1/programs/import/draft', { file: PDF });
    assert.equal(r.status, 200, r.text);
    const [q] = got;
    assert.equal(q.url, '/v1/messages');
    assert.equal(q.headers['x-api-key'], 'sk-test');
    assert.equal(q.headers['anthropic-version'], '2023-06-01');
    assert.equal(q.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(q.body.model, 'claude-opus-5');
    assert.equal(q.body.fallbacks, 'default');
    assert.equal(q.body.output_config.format.type, 'json_schema');
    assert.deepEqual(q.body.thinking, { type: 'adaptive' });
    assert.equal(q.body.stream, true);
    assert.equal(r.body.workouts.length, 3, 'the streamed answer is read in full');
    // A model that declined partway: its text is dropped and the fallback's answer is used.
    reply = { status: 200, stream: sse(JSON.stringify(DRAFT), 'end_turn', { before: '{"is_program": tr' }) };
    const fb = await coach('POST', '/v1/programs/import/draft', { file: PDF });
    assert.equal(fb.status, 200, fb.text);
    assert.equal(fb.body.program.name, 'Summer strength');
    assert.equal(q.body.messages[0].content[0].type, 'document');
    assert.equal(q.body.messages[0].content[0].source.data, PDF.data_base64);
    for (const [status, body, re] of [
      [401, { error: { message: 'invalid x-api-key' } }, /key in Render isn't working/],
      [529, { error: { message: 'Overloaded' } }, /busy/],
      [200, 'max_tokens', /too long to read in one go/],
      [200, 'refusal', /couldn't read that file as a training program/]]) {
      reply = status === 200 ? { stream: sse('{"is_program": true', body) } : { status, body };
      const e = await coach('POST', '/v1/programs/import/draft', { file: PDF });
      assert.ok(e.status >= 400, `${status}: ${e.text}`);
      assert.match(e.body.error.message, re);
    }
  } finally {
    fake.close();
    if (saved.key) process.env.ANTHROPIC_API_KEY = saved.key; else delete process.env.ANTHROPIC_API_KEY;
    if (saved.url) process.env.ANTHROPIC_BASE_URL = saved.url; else delete process.env.ANTHROPIC_BASE_URL;
  }
});

test('odd input and odd answers get plain words, never a crash', async () => {
  // Saving: a missing workout, non-text fields.
  const r = await coach('POST', '/v1/programs/import', { program: { name: 'P' }, workouts: [null, { week: 1, day: 1, title: { x: 1 }, exercises: [{ exercise_id: squat.id, prescription: 5 }] }] });
  assert.equal(r.status, 400, r.text);
  assert.deepEqual(r.body.error.details.problems, ['One of the workouts is empty. Remove it.', 'Week 1, day 1: the title must be text.', 'Week 1, day 1, exercise 1: the sets and reps must be text, like 3 × 8.']);
  // An answer with nothing that fits in weeks and days.
  app.ctx.readWorkoutFile = async () => ({ is_program: true, program: { name: 'x', description: '', level: '' }, workouts: ['x', 5, null, { week: 0, day: 1, title: 'Zero', exercises: [] }], unclear: 'not a list' });
  assert.match((await coach('POST', '/v1/programs/import/draft', { file: PDF })).body.error.message, /couldn't place any workouts/);
  // A photo over Anthropic's limit; a PDF with too many pages.
  const big = { name: 'board.png', data_base64: Buffer.alloc(3.8 * 1024 * 1024).toString('base64') };
  assert.match((await coach('POST', '/v1/programs/import/draft', { file: big })).body.error.message, /photo is 3\.8 MB\. The limit is 3\.7 MB/);
  const pages = Buffer.from(`%PDF-1.4\n${'1 0 obj << /Type /Page >> endobj\n'.repeat(101)}%%EOF`).toString('base64');
  assert.match((await coach('POST', '/v1/programs/import/draft', { file: { name: 'long.pdf', data_base64: pages } })).body.error.message, /101 pages/);
});

test('a library too big to list isn\'t sent to Claude; names are still matched here', async () => {
  const d = db();
  d.tx(() => { for (let i = 0; i < 1501; i++) d.run('INSERT INTO exercises (id, name, created_at) VALUES (?, ?, ?)', `ex_bulk_${i}`, `Drill number ${i}`, '2026-09-01T00:00:00Z'); });
  const r = await coach('POST', '/v1/programs/import/draft', { file: PDF });
  assert.equal(r.status, 200, r.text);
  assert.match(seen.system, /too big to list/);
  assert.doesNotMatch(seen.system, /Drill number 7/);
  assert.equal(r.body.workouts[0].exercises[0].exercise_id, squat.id, 'Back Squats still matches Back squat');
  d.run("DELETE FROM exercises WHERE id LIKE 'ex_bulk_%'");
});
