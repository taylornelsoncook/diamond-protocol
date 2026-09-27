// Programs tab: exercise categories, program copies, week/day copying, undo, assignment moves, workout links,
// workout activity and client progress, and front desk refusals.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-programs-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app, jobs } = require('../server/index');
const db = require('../server/db');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Tiny client with its own cookie jar.
function client() {
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (p, h) => req('GET', p, undefined, h), post: (p, b = {}, h) => req('POST', p, b, h), put: (p, b = {}) => req('PUT', p, b), del: (p) => req('DELETE', p),
    bare: (m, p) => req(m, p, undefined), // no body at all
    login: async (email, password) => req('POST', '/api/auth/staff/login', { email, password }),
  };
}
async function signedIn(email, pw) { const c = client(); const r = await c.login(email, pw); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }
const owner = () => signedIn('owner@demo.test', 'demo-owner-2026');
const coach = () => signedIn('coach@demo.test', 'demo-coach-2026');
const desk = () => signedIn('desk@demo.test', 'demo-desk-2026');
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } return fn(); };
const exId = (name) => db.get('SELECT id FROM exercises WHERE name=?', name).id;
const progId = (name) => db.get('SELECT id FROM programs WHERE name=? AND archived=0', name).id;

test('exercise library: categories, usage, validation', async () => {
  const c = await coach();
  const r = await c.post('/api/exercises', { name: 'Test long toss', category: 'Arm care', cues: 'Arc it.' });
  assert.equal(r.status, 200);
  assert.equal(r.data.category, 'Arm care');
  const badCat = await c.post('/api/exercises', { name: 'Test odd', category: 'Juggling' });
  assert.equal(badCat.status, 400); assert.match(badCat.data.error, /category/);
  assert.equal((await c.put(`/api/exercises/${r.data.id}`, { category: '' })).data.category, null);
  const cats = (await c.get('/api/exercise-categories')).data;
  assert.ok(cats.includes('Arm care') && cats.includes('Speed'));
  const list = (await c.get('/api/exercises')).data;
  const goblet = list.find((e) => e.name === 'Goblet squat');
  assert.equal(goblet.category, 'Lower body', 'seeded category');
  assert.ok(goblet.uses > 0);
  assert.match(goblet.used_in, /Foundations of Strength/);
  assert.equal(list.find((e) => e.name === 'Test long toss').uses, 0);
  const d = await desk();
  assert.equal((await d.get('/api/exercises')).status, 200);
  assert.equal((await d.put(`/api/exercises/${r.data.id}`, { category: 'Speed' })).status, 403);
  assert.equal((await d.del(`/api/exercises/${r.data.id}`)).status, 403);
});

test('an exercise used only in a deleted program can be deleted', async () => {
  const c = await coach();
  const ex = (await c.post('/api/exercises', { name: 'Test one-off', category: 'Mobility' })).data;
  const pid = (await c.post('/api/programs', { name: 'Test throwaway', weeks: 1 })).data.id;
  const day = (await c.post(`/api/programs/${pid}/days`, { week: 1, title: 'Only day' })).data.id;
  await c.post(`/api/program-days/${day}/items`, { exercise_id: ex.id, sets: '1', reps: '5' });
  assert.equal((await c.del(`/api/exercises/${ex.id}`)).status, 400, 'in use');
  assert.equal((await c.del(`/api/programs/${pid}`)).status, 200);
  assert.equal((await c.get('/api/exercises')).data.find((e) => e.id === ex.id).uses, 0);
  assert.equal((await c.del(`/api/exercises/${ex.id}`)).status, 200);
  assert.ok(!db.get('SELECT 1 FROM exercises WHERE id=?', ex.id));
});

test('new program from a copy, and duplicate program', async () => {
  const c = await coach();
  const src = progId('Throwers Arm Care');
  const srcDays = db.get('SELECT COUNT(*) AS n FROM program_days WHERE program_id=?', src).n;
  assert.equal(srcDays, 8, 'seeded 4 weeks × 2 days');
  let r = await c.post('/api/programs', { name: 'Test arm short', weeks: 2, copy_from: src, level: '' });
  assert.equal(r.status, 200);
  let p = (await c.get(`/api/programs/${r.data.id}`)).data;
  assert.equal(p.weeks, 2);
  assert.equal(p.days.length, 4, 'only the weeks kept');
  assert.equal(p.days[0].items.length, db.get('SELECT COUNT(*) AS n FROM program_items i JOIN program_days d ON d.id=i.day_id WHERE d.program_id=? AND d.week=1 AND d.day=1', src).n);
  assert.equal(p.description, db.get('SELECT description FROM programs WHERE id=?', src).description, 'description carried over');
  assert.equal((await c.post('/api/programs', { name: 'Test bad copy', copy_from: 999999 })).status, 404);
  r = await c.post(`/api/programs/${src}/duplicate`, {});
  assert.equal(r.status, 200);
  p = (await c.get(`/api/programs/${r.data.id}`)).data;
  assert.equal(p.name, 'Throwers Arm Care (copy)');
  assert.equal(p.days.length, 8);
  assert.equal(p.athletes.length, 0);
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Copied program' AND detail='Throwers Arm Care → Throwers Arm Care (copy)'"));
  // editing the copy leaves the original alone
  await c.del(`/api/program-days/${p.days[0].id}`);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM program_days WHERE program_id=?', src).n, 8);
  assert.equal((await (await desk()).post(`/api/programs/${src}/duplicate`, {})).status, 403);
});

test('copy a week to a run of weeks, delete a week, and weeks can’t drop below the last workout', async () => {
  const c = await coach();
  const pid = (await c.post('/api/programs', { name: 'Test weeks', weeks: 2 })).data.id;
  const d1 = (await c.post(`/api/programs/${pid}/days`, { week: 1, title: 'A' })).data.id;
  await c.post(`/api/programs/${pid}/days`, { week: 1, title: 'B' });
  await c.post(`/api/program-days/${d1}/items`, { exercise_id: exId('Push-up'), sets: '3', reps: '8' });
  await c.post(`/api/programs/${pid}/days`, { week: 3, title: 'Existing' });
  let r = await c.post(`/api/programs/${pid}/weeks/1/copy`, { to: 2, through: 4 });
  assert.equal(r.status, 400);
  assert.equal(r.data.needs_replace, true);
  assert.deepEqual(r.data.weeks, [3]);
  assert.equal((await c.post(`/api/programs/${pid}/weeks/1/copy`, { to: 3, through: 2 })).status, 400, 'through before to');
  r = await c.post(`/api/programs/${pid}/weeks/1/copy`, { to: 2, through: 4, replace: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.weeks, 4);
  for (const w of [2, 3, 4]) assert.deepEqual(r.data.days.filter((d) => d.week === w).map((d) => d.title), ['A', 'B'], `week ${w}`);
  assert.equal(r.data.days.find((d) => d.week === 4 && d.day === 1).items[0].name, 'Push-up');
  // weeks can't drop below the last week with workouts
  r = await c.put(`/api/programs/${pid}`, { weeks: 2 });
  assert.equal(r.status, 400); assert.match(r.data.error, /Week 4 still has workouts/);
  // delete the last week: it comes off the length
  r = await c.del(`/api/programs/${pid}/weeks/4`);
  assert.equal(r.status, 200);
  assert.equal(r.data.weeks, 3);
  assert.equal(r.data.days.filter((d) => d.week === 4).length, 0);
  // a middle week empties but the length stays
  r = await c.del(`/api/programs/${pid}/weeks/2`);
  assert.equal(r.data.weeks, 3);
  assert.equal(r.data.days.filter((d) => d.week === 2).length, 0);
  assert.equal((await (await desk()).del(`/api/programs/${pid}/weeks/3`)).status, 403);
});

test('copy one workout to another week and day', async () => {
  const c = await coach();
  const pid = (await c.post('/api/programs', { name: 'Test copy day', weeks: 1 })).data.id;
  const d1 = (await c.post(`/api/programs/${pid}/days`, { week: 1, title: 'Legs' })).data.id;
  await c.post(`/api/program-days/${d1}/items`, { exercise_id: exId('Goblet squat'), sets: '3', reps: '10', cue: 'Slow' });
  await c.post(`/api/program-days/${d1}/items`, { exercise_id: exId('Front plank'), sets: '3', reps: '30 sec' });
  let r = await c.post(`/api/program-days/${d1}/copy`, {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.week, r.data.day], [1, 2], 'next free day of the same week');
  r = await c.post(`/api/program-days/${d1}/copy`, { week: 2, day: 3, title: 'Legs again' });
  assert.deepEqual([r.data.week, r.data.day], [2, 3]);
  const p = (await c.get(`/api/programs/${pid}`)).data;
  assert.equal(p.weeks, 2, 'program grows to the new week');
  const copy = p.days.find((d) => d.id === r.data.id);
  assert.equal(copy.title, 'Legs again');
  assert.deepEqual(copy.items.map((i) => [i.name, i.sets, i.reps, i.cue]), [['Goblet squat', '3', '10', 'Slow'], ['Front plank', '3', '30 sec', '']]);
  assert.equal((await c.post(`/api/program-days/${d1}/copy`, { week: 2, day: 3 })).status, 400, 'day taken');
  for (let d = 4; d <= 7; d++) await c.post(`/api/programs/${pid}/days`, { week: 2, day: d });
  await c.post(`/api/programs/${pid}/days`, { week: 2, day: 1 }); await c.post(`/api/programs/${pid}/days`, { week: 2, day: 2 });
  r = await c.post(`/api/program-days/${d1}/copy`, { week: 2 });
  assert.equal(r.status, 400); assert.match(r.data.error, /already has 7 days/);
  assert.equal((await c.post(`/api/programs/${pid}/days`, { week: 2 })).status, 400, 'add day also stops at 7');
  assert.equal((await (await desk()).post(`/api/program-days/${d1}/copy`, {})).status, 403);
});

test('remove an exercise, undo puts it back in place; swap an exercise', async () => {
  const c = await coach();
  const pid = (await c.post('/api/programs', { name: 'Test undo', weeks: 1 })).data.id;
  const day = (await c.post(`/api/programs/${pid}/days`, { week: 1, title: 'Day' })).data.id;
  const ids = [];
  for (const n of ['Goblet squat', 'Push-up', 'Front plank']) ids.push((await c.post(`/api/program-days/${day}/items`, { exercise_id: exId(n), sets: '3', reps: '10' })).data.id);
  const del = await c.del(`/api/program-items/${ids[1]}`);
  assert.equal(del.status, 200);
  assert.deepEqual({ ...del.data.removed }, { day_id: day, exercise_id: exId('Push-up'), sets: '3', reps: '10', cue: '', position: 1 });
  const back = await c.post(`/api/program-days/${day}/items`, del.data.removed);
  assert.equal(back.status, 200);
  let p = (await c.get(`/api/programs/${pid}`)).data;
  assert.deepEqual(p.days[0].items.map((i) => i.name), ['Goblet squat', 'Push-up', 'Front plank'], 'back in its place');
  // swap keeps sets, reps and place
  const mid = p.days[0].items[1].id;
  assert.equal((await c.put(`/api/program-items/${mid}`, { exercise_id: exId('Split squat') })).status, 200);
  p = (await c.get(`/api/programs/${pid}`)).data;
  assert.deepEqual(p.days[0].items.map((i) => i.name), ['Goblet squat', 'Split squat', 'Front plank']);
  assert.equal(p.days[0].items[1].sets, '3');
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Updated exercise in workout' AND detail LIKE '%Push-up → Split squat%'"));
  assert.equal((await c.put(`/api/program-items/${mid}`, { exercise_id: 999999 })).status, 400);
  assert.equal((await c.post(`/api/program-days/${day}/items`, { exercise_id: exId('Push-up'), sets: '1', position: -1 })).status, 400);
});

test('assign: shows current programs, refuses a repeat, notes a move; front desk can send the link', async () => {
  const c = await coach();
  const hs = progId('High School Off-Season'), arm = progId('Throwers Arm Care');
  const kevin = db.get("SELECT * FROM athletes WHERE first_name='Kevin'");
  assert.equal(kevin.program_id, hs);
  const cand = (await c.get(`/api/programs/${arm}/candidates?q=Kevin`)).data;
  assert.equal(cand[0].program, 'High School Off-Season');
  assert.equal((await (await desk()).get(`/api/programs/${arm}/candidates?q=Kevin`)).status, 403);
  let r = await c.post(`/api/programs/${hs}/assign`, { athlete_id: kevin.id });
  assert.equal(r.status, 400); assert.match(r.data.error, /already on High School Off-Season/);
  r = await c.post(`/api/programs/${arm}/assign`, { athlete_id: kevin.id });
  assert.equal(r.status, 200);
  assert.equal(r.data.moved_from, 'High School Off-Season');
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Assigned program' AND detail='Kevin Nguyen → Throwers Arm Care (was on High School Off-Season)'"));
  // front desk resends the link (it changes nothing)
  const d = await desk();
  const before = db.get('SELECT COUNT(*) AS n FROM outbox').n;
  r = await d.post(`/api/programs/${arm}/send-link`, { athlete_id: kevin.id });
  assert.equal(r.status, 200);
  assert.ok(r.data.sent_to.length >= 1);
  const mail = db.get('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  assert.ok(db.get('SELECT COUNT(*) AS n FROM outbox').n > before);
  assert.match(mail.body, new RegExp(`/w/${kevin.workout_token}`));
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Sent workout link' AND detail LIKE 'Kevin Nguyen: Throwers Arm Care%'"));
  assert.equal((await d.post(`/api/programs/${hs}/send-link`, { athlete_id: kevin.id })).status, 400, 'not on that program');
  // no email anywhere
  const lone = db.insert('athletes', { code: 'TSTLON2026', first_name: 'Lone', last_name: 'Test', program_id: arm, program_started: '2026-09-01' });
  r = await c.post(`/api/programs/${arm}/send-link`, { athlete_id: lone });
  assert.equal(r.status, 400); assert.match(r.data.error, /no email on file/);
  assert.ok(db.get('SELECT workout_token FROM athletes WHERE id=?', lone).workout_token, 'a link is made either way');
  assert.equal((await client().post(`/api/programs/${arm}/send-link`, { athlete_id: kevin.id })).status, 401);
});

test('workout activity: recent logs with notes, clients needing a check-in, client progress', async () => {
  const d = await desk();
  const r = await d.get('/api/programs/activity');
  assert.equal(r.status, 200);
  assert.ok(r.data.recent.length > 0);
  const row = r.data.recent[0];
  for (const k of ['first_name', 'program', 'week', 'day', 'title', 'done', 'total', 'finished_at']) assert.ok(k in row, k);
  assert.equal(typeof row.done, 'number');
  assert.ok(r.data.recent.some((x) => x.note), 'notes come through');
  assert.ok(r.data.logged_7d > 0);
  assert.ok(r.data.quiet.length >= 1, 'seeded athlete with no workouts in 12 days');
  const q = r.data.quiet[0];
  assert.ok(q.days_idle >= 7 && q.quiet && q.next);
  assert.ok(!/price|cents|amount/i.test(JSON.stringify(r.data)), 'no money in the feed');
  // a finished program shows up as complete
  const c = await coach();
  const pid = (await c.post('/api/programs', { name: 'Test tiny', weeks: 1 })).data.id;
  const day = (await c.post(`/api/programs/${pid}/days`, { week: 1, title: 'Only' })).data.id;
  await c.post(`/api/program-days/${day}/items`, { exercise_id: exId('Push-up'), sets: '1', reps: '5' });
  const a = db.get("SELECT * FROM athletes WHERE first_name='Mason'");
  await c.post(`/api/programs/${pid}/assign`, { athlete_id: a.id });
  let detail = (await c.get(`/api/programs/${pid}`)).data;
  assert.deepEqual([detail.athletes[0].finished_days, detail.athletes[0].total_days, detail.athletes[0].complete], [0, 1, false]);
  assert.equal(detail.athletes[0].next.title, 'Only');
  const token = db.get('SELECT workout_token FROM athletes WHERE id=?', a.id).workout_token;
  const w = client();
  const s = (await w.get(`/api/w/${token}`)).data;
  await w.post(`/api/w/${token}/log`, { day_id: s.current.day_id, item_id: s.current.items[0].id, done: true });
  await w.post(`/api/w/${token}/finish`, { day_id: s.current.day_id, note: 'Done and dusted' });
  detail = (await c.get(`/api/programs/${pid}`)).data;
  assert.equal(detail.athletes[0].complete, true);
  assert.equal(detail.athletes[0].quiet, false);
  assert.equal(detail.logged_7d, 1);
  const act = (await c.get(`/api/programs/activity?program_id=${pid}`)).data;
  assert.equal(act.recent.length, 1);
  assert.equal(act.recent[0].note, 'Done and dusted');
  assert.ok(act.complete.some((x) => x.id === a.id));
  const list = (await c.get('/api/programs')).data.find((p) => p.id === pid);
  assert.equal(list.days_per_week, 1);
  assert.equal(list.logged_7d, 1);
});

test('front desk can view but not change the new program tools', async () => {
  const d = await desk();
  const pid = progId('Foundations of Strength');
  assert.equal((await d.get(`/api/programs/${pid}`)).status, 200);
  const day = db.get('SELECT id FROM program_days WHERE program_id=? LIMIT 1', pid).id;
  const item = db.get('SELECT id FROM program_items WHERE day_id=? LIMIT 1', day).id;
  for (const [m, p, b] of [['post', '/api/programs', { name: 'X', copy_from: pid }], ['post', `/api/programs/${pid}/weeks/1/copy`, { to: 9 }], ['del', `/api/programs/${pid}/weeks/1`],
    ['post', `/api/program-days/${day}/copy`, {}], ['put', `/api/program-items/${item}`, { sets: '9' }], ['post', `/api/program-days/${day}/items`, { exercise_id: exId('Push-up'), sets: '1' }],
    ['put', `/api/programs/${pid}`, { weeks: 9 }], ['post', `/api/programs/${pid}/unassign`, { athlete_id: 1 }]]) {
    assert.equal((await d[m](p, b)).status, 403, `${m} ${p}`);
  }
});

test('review fixes: requests without a body get a plain 400, an empty last week can be deleted', async () => {
  const c = await coach();
  const pid = (await c.post('/api/programs', { name: 'Test no body', weeks: 1 })).data.id;
  const day = (await c.post(`/api/programs/${pid}/days`, { week: 1, title: 'A' })).data.id;
  const item = (await c.post(`/api/program-days/${day}/items`, { exercise_id: exId('Push-up'), sets: '3', reps: '8' })).data.id;
  // no JSON body at all (req.body is undefined): a sentence, not a server error
  for (const [m, p] of [['POST', `/api/programs/${pid}/assign`], ['POST', `/api/programs/${pid}/unassign`], ['POST', `/api/programs/${pid}/days`],
    ['POST', `/api/program-days/${day}/items`], ['PUT', `/api/program-days/${day}`], ['POST', `/api/programs/${pid}/send-link`]]) {
    const r = await c.bare(m, p);
    assert.equal(r.status, 400, `${m} ${p}: ${JSON.stringify(r.data)}`);
    assert.ok(!/went wrong/.test(r.data.error), r.data.error);
  }
  // no body on move: moves down (the default), no crash; PUT with no body keeps the item as it is
  assert.equal((await c.bare('POST', `/api/program-items/${item}/move`)).status, 200);
  assert.equal((await c.bare('PUT', `/api/program-items/${item}`)).status, 200);
  assert.equal(db.get('SELECT sets FROM program_items WHERE id=?', item).sets, '3');
  // Add week by mistake, then delete the empty week: the program is one week again
  assert.equal((await c.put(`/api/programs/${pid}`, { weeks: 2 })).data.weeks, 2);
  const r = await c.del(`/api/programs/${pid}/weeks/2`);
  assert.equal(r.status, 200);
  assert.equal(r.data.weeks, 1);
  assert.equal(r.data.days.length, 1, 'week 1 untouched');
});

test('review fixes: a resent link says so, and archived clients do not count as logged this week', async () => {
  const c = await coach();
  const pid = (await c.post('/api/programs', { name: 'Test resend', weeks: 1 })).data.id;
  const day = (await c.post(`/api/programs/${pid}/days`, { week: 1, title: 'Only' })).data.id;
  await c.post(`/api/program-days/${day}/items`, { exercise_id: exId('Push-up'), sets: '1', reps: '5' });
  const a = db.insert('athletes', { code: 'TSTRES2026', first_name: 'Resa', last_name: 'Test', email: 'resa.test@example.com' });
  assert.equal((await c.post(`/api/programs/${pid}/assign`, { athlete_id: a })).status, 200);
  assert.match(db.get("SELECT subject FROM outbox WHERE to_email='resa.test@example.com' ORDER BY id DESC LIMIT 1").subject, /new program: Test resend/);
  assert.equal((await c.post(`/api/programs/${pid}/send-link`, { athlete_id: a })).status, 200);
  const mail = db.get("SELECT * FROM outbox WHERE to_email='resa.test@example.com' ORDER BY id DESC LIMIT 1");
  assert.match(mail.subject, /workout app link: Test resend/);
  assert.match(mail.body, /Resa is on Test resend/);
  // log a finished workout, then archive the client: the program's count drops with them
  db.run("INSERT INTO workout_logs (athlete_id, day_id, done, finished_at) VALUES (?, ?, '[]', datetime('now','-1 day'))", a, day);
  const count = async () => [(await c.get('/api/programs')).data.find((p) => p.id === pid).logged_7d, (await c.get(`/api/programs/${pid}`)).data.logged_7d];
  assert.deepEqual(await count(), [1, 1]);
  db.run('UPDATE athletes SET archived=1 WHERE id=?', a);
  assert.deepEqual(await count(), [0, 0]);
});
