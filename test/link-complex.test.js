import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';

// Linking exercises already on a day (owner's ask: "link exercises together to make a complex", and delete exercises
// in the builder): POST /v1/workouts/:id/blocks { exercise_ids } groups them into a new block in their order, and
// POST /v1/workouts/:id/complex does that and saves the block to the library as a complex, all or nothing.
let app, base, coach, desk, program, w, squat, jump, sled, row;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const day = async () => (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.find((x) => x.id === w.id);
const shape = (d) => d.exercises.map((x) => [x.name, x.block_name ?? null, x.group_tag]);

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  jump = (await coach('POST', '/v1/exercises', { name: 'Broad jump' })).body;
  sled = (await coach('POST', '/v1/exercises', { name: 'Sled sprint' })).body;
  row = (await coach('POST', '/v1/exercises', { name: 'Bent-over row' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Speed', weeks: 1 })).body;
  w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Day 1' })).body;
  for (const [x, rx] of [[squat, '3 × 5'], [jump, '3 × 3'], [sled, '4 × 20 yd'], [row, '3 × 8']]) await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: x.id, prescription: rx });
});
after(() => app.server.close());

test('ticked exercises become a block in their order, sitting where the first of them was', async () => {
  const d0 = await day();
  const [sq, jp, sl, rw] = d0.exercises;
  // Link the jump and the sled (listed backwards: the day's order wins) into a Power block.
  const r = await coach('POST', `/v1/workouts/${w.id}/blocks`, { name: 'Power', kind: 'superset', exercise_ids: [sl.id, jp.id] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.block_id);
  assert.deepEqual(shape(await day()), [['Back squat', null, null], ['Broad jump', 'Power', 'A1'], ['Sled sprint', 'Power', 'A2'], ['Bent-over row', null, null]]);
  // Linking across the day moves the later one up to the first: the row joins the squat ahead of the Power block.
  const r2 = await coach('POST', `/v1/workouts/${w.id}/blocks`, { name: 'Strength', exercise_ids: [sq.id, rw.id] });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.deepEqual(shape(await day()), [['Back squat', 'Strength', 'A1'], ['Bent-over row', 'Strength', 'A2'], ['Broad jump', 'Power', 'B1'], ['Sled sprint', 'Power', 'B2']]);
  // Problems: an exercise from another day, a repeat, a bad list, a complex and a link at once.
  const w2 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 2, title: 'Day 2' })).body;
  const other = (await coach('POST', `/v1/workouts/${w2.id}/exercises`, { exercise_id: squat.id, prescription: '3 × 5' })).body.exercises[0];
  const bad = async (body, re) => { const x = await coach('POST', `/v1/workouts/${w.id}/blocks`, { name: 'X', ...body }); assert.equal(x.status, 400, JSON.stringify(x.body)); assert.match(x.body.error.message, re); };
  await bad({ exercise_ids: [sq.id, other.id] }, /must be on this day/);
  await bad({ exercise_ids: [sq.id, sq.id] }, /in the list twice/);
  await bad({ exercise_ids: 'nope' }, /list of the exercises/);
  assert.equal((await day()).blocks.length, 2, 'nothing was added by the refused calls');
});

test('ticked exercises become a complex in the library and a block on the day, all or nothing; front desk can\'t', async () => {
  const w3 = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 3, title: 'Day 3' })).body;
  for (const [x, rx] of [[jump, '3 × 3'], [sled, '4 × 20 yd'], [row, '3 × 8']]) await coach('POST', `/v1/workouts/${w3.id}/exercises`, { exercise_id: x.id, prescription: rx });
  const d = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.find((x) => x.id === w3.id);
  const [jp, sl, rw] = d.exercises;
  const one = await coach('POST', `/v1/workouts/${w3.id}/complex`, { exercise_ids: [jp.id], name: 'Lonely' });
  assert.equal(one.status, 400); assert.match(one.body.error.message, /at least two/);
  const made = await coach('POST', `/v1/workouts/${w3.id}/complex`, { exercise_ids: [sl.id, jp.id], name: 'Acceleration Primer', kind: 'circuit' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.name, made.body.kind, made.body.exercises.map((x) => [x.name, x.prescription])], ['Acceleration Primer', 'circuit', [['Broad jump', '3 × 3'], ['Sled sprint', '4 × 20 yd']]]);
  const after1 = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.find((x) => x.id === w3.id);
  assert.deepEqual(shape(after1), [['Broad jump', 'Acceleration Primer', 'A1'], ['Sled sprint', 'Acceleration Primer', 'A2'], ['Bent-over row', null, null]]);
  const blk = after1.blocks.find((b) => b.id === made.body.block_id);
  assert.equal(blk.complex_id, made.body.id, 'the block points at the complex');
  assert.equal((await coach('GET', '/v1/complexes')).body.data.some((c) => c.name === 'Acceleration Primer' && c.used_in === 1), true);
  // A taken name leaves the day as it was (no block made).
  const dup = await coach('POST', `/v1/workouts/${w3.id}/complex`, { exercise_ids: [rw.id, jp.id], name: 'acceleration primer' });
  assert.equal(dup.status, 409);
  const after2 = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.find((x) => x.id === w3.id);
  assert.deepEqual(shape(after2), shape(after1)); assert.equal(after2.blocks.length, after1.blocks.length);
  // Front desk looks, never links.
  assert.equal((await desk('POST', `/v1/workouts/${w3.id}/complex`, { exercise_ids: [rw.id, jp.id], name: 'Desk' })).status, 403);
  assert.equal((await desk('POST', `/v1/workouts/${w3.id}/blocks`, { name: 'Desk', exercise_ids: [rw.id, jp.id] })).status, 403);
});
