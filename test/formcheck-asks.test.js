// Form checks asked in the plan (schema 61): a coach turns "Ask for a form check" on for an exercise in a workout, the
// athlete app shows the ask (and whether the clip went up), a copy of the workout carries it, and the coach's list says
// which clips answer an ask.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { newId } from '../src/util.js';

let app, base, coach, owner, maya, token, program, workout, squat, bench, store, calls;
const PW = 'correct-horse-battery';
const ENV = { FORMCHECK_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', FORMCHECK_S3_BUCKET: 'dp-athlete-videos-test', FORMCHECK_S3_KEY_ID: 'key-test', FORMCHECK_S3_SECRET: 'secret-test' };
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// The bucket stands in: HEAD answers from `store`.
const s3Stub = () => async (url, init = {}) => {
  const u = new URL(url); calls.push({ method: init.method, path: u.pathname });
  const obj = store.get(u.pathname);
  if (init.method === 'HEAD') return obj ? new Response(null, { status: 200, headers: { 'content-length': String(obj.bytes), 'content-type': obj.type, etag: `"e-${obj.bytes}"` } }) : new Response(null, { status: 404 });
  if (init.method === 'DELETE') { store.delete(u.pathname); return new Response(null, { status: 204 }); }
  return new Response(null, { status: 405 });
};
const slotsOf = async (wid) => (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.find((w) => w.id === wid).exercises;

before(async () => {
  resetRateLimits();
  store = new Map();
  Object.assign(process.env, ENV);
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); owner = await staff('owner@test.dev');
  maya = (await coach('POST', '/v1/clients', { name: 'Maya Okafor', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  // A member, so the app opens.
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    newId('sub'), maya.id, plan.id, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', app.ctx.now(), app.ctx.now());
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', maya.id).access_token;
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  bench = (await coach('POST', '/v1/exercises', { name: 'Bench press' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 2 })).body;
  workout = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
});
beforeEach(() => { calls = []; app.ctx.s3Fetch = s3Stub(); });
after(() => { app.server.close(); for (const k of Object.keys(ENV)) delete process.env[k]; });

test('a coach asks for a form check on the main lift: saved with the slot, shown in the program, off by default elsewhere', async () => {
  const added = await coach('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5', form_check: true, form_check_note: 'Side view, your heaviest set' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const plain = await coach('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: bench.id, sets: 3, reps: '8' });
  assert.equal(plain.status, 201);
  const slots = await slotsOf(workout.id);
  const sq = slots.find((x) => x.exercise_id === squat.id), be = slots.find((x) => x.exercise_id === bench.id);
  assert.equal(sq.form_check, 1);
  assert.equal(sq.form_check_note, 'Side view, your heaviest set');
  assert.equal(be.form_check, 0);
  assert.equal(be.form_check_note, null);
  // Bad values are refused; a note without the ask is dropped; turning it off clears the note.
  assert.equal((await coach('PATCH', `/v1/workout-exercises/${be.id}`, { form_check: 'yes please' })).status, 400);
  assert.equal((await coach('PATCH', `/v1/workout-exercises/${be.id}`, { form_check_note: 'x'.repeat(201), form_check: true })).status, 400);
  await coach('PATCH', `/v1/workout-exercises/${be.id}`, { form_check_note: 'only a note' });
  assert.equal((await slotsOf(workout.id)).find((x) => x.id === be.id).form_check_note, null, 'a note without the ask is dropped');
  await coach('PATCH', `/v1/workout-exercises/${sq.id}`, { form_check: false });
  const off = (await slotsOf(workout.id)).find((x) => x.id === sq.id);
  assert.deepEqual([off.form_check, off.form_check_note], [0, null]);
  await coach('PATCH', `/v1/workout-exercises/${sq.id}`, { form_check: true, form_check_note: 'Side view, your heaviest set' });
  // Changing the sets keeps the ask.
  await coach('PATCH', `/v1/workout-exercises/${sq.id}`, { sets: 4 });
  assert.equal((await slotsOf(workout.id)).find((x) => x.id === sq.id).form_check, 1);
});

test('a copied week and a restored exercise carry the ask', async () => {
  const copy = await coach('POST', `/v1/programs/${program.id}/weeks/1/copy`, { to: 2 });
  assert.equal(copy.status, 200, JSON.stringify(copy.body));
  const p = (await coach('GET', `/v1/programs/${program.id}`)).body;
  const w2 = p.workouts.find((w) => w.week === 2 && w.day === 1);
  const sq2 = w2.exercises.find((x) => x.exercise_id === squat.id);
  assert.deepEqual([sq2.form_check, sq2.form_check_note], [1, 'Side view, your heaviest set']);
  const gone = await coach('DELETE', `/v1/workout-exercises/${sq2.id}`);
  assert.equal(gone.status, 200);
  const { workout_id, ...back } = gone.body.restore;
  assert.equal(back.form_check, 1);
  const restored = await coach('POST', `/v1/workouts/${workout_id}/exercises`, back);
  assert.equal(restored.status, 201, JSON.stringify(restored.body));
  assert.equal((await slotsOf(w2.id)).find((x) => x.exercise_id === squat.id).form_check, 1);
  await coach('DELETE', `/v1/workouts/${w2.id}`);
});

test('the app shows the ask and whether the clip went up; the coach\'s list marks the clip as asked for', async () => {
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id })).status, 201);
  let home = (await athlete('GET', '/app/api/home')).body;
  assert.ok(home.workout, JSON.stringify(home).slice(0, 300));
  const sq = home.workout.exercises.find((x) => x.exercise_id === squat.id), be = home.workout.exercises.find((x) => x.exercise_id === bench.id);
  assert.deepEqual([sq.form_check, sq.form_check_sent, sq.form_check_note], [true, false, 'Side view, your heaviest set']);
  assert.equal(be.form_check, false);
  assert.equal(be.form_check_sent, undefined);
  // The clip goes up for that slot.
  const start = await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 12_000_000, duration_s: 30, workout_exercise_id: sq.id });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  store.set(new URL(start.body.upload.url).pathname, { bytes: 12_000_000, type: 'video/mp4' });
  const done = await athlete('POST', `/app/api/form-checks/${start.body.id}/done`);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  home = (await athlete('GET', '/app/api/home')).body;
  assert.equal(home.workout.exercises.find((x) => x.id === sq.id).form_check_sent, true);
  const mine = (await athlete('GET', '/app/api/form-checks')).body.data;
  assert.equal(mine[0].asked, true);
  const list = (await coach('GET', `/v1/form-checks?client_id=${maya.id}`)).body.data;
  assert.equal(list[0].asked, true);
  // A clip on an exercise nobody asked about isn't marked.
  const free = await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 9_000_000, duration_s: 20, workout_exercise_id: be.id });
  store.set(new URL(free.body.upload.url).pathname, { bytes: 9_000_000, type: 'video/mp4' });
  assert.equal((await athlete('POST', `/app/api/form-checks/${free.body.id}/done`)).status, 200);
  assert.equal((await athlete('GET', '/app/api/form-checks')).body.data.find((f) => f.exercise_id === bench.id).asked, false);
  // The log's details and a deleted workout's snapshot keep the ask too.
  const fin = await athlete('POST', `/app/api/workouts/${home.workout.id}/complete`, { request_id: 'r1', exercise_ids: [sq.id], sets: [{ workout_exercise_id: sq.id, set_no: 1, weight: 185, reps: 5 }] });
  assert.equal(fin.status, 201, JSON.stringify(fin.body));
  const detail = (await athlete('GET', `/app/api/logs/${fin.body.id}`)).body;
  assert.equal(detail.exercises.find((x) => x.exercise_id === squat.id).form_check, 1);
  assert.equal(detail.exercises.find((x) => x.exercise_id === squat.id).form_check_note, 'Side view, your heaviest set');
});

test('a version 60 database gains the ask, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v60.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 60');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 65, `round ${round}`);
      const cols = d.all('PRAGMA table_info(workout_exercises)');
      assert.ok(cols.some((c) => c.name === 'form_check' && c.notnull === 1 && c.dflt_value === '0'));
      assert.ok(cols.some((c) => c.name === 'form_check_note'));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
