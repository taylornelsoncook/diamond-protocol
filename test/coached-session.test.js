// The coach's cue (schema 68, services/cues.js): a coach records a few words per exercise, the app gets them as an audio
// file when the exercise opens (and the words to read aloud without a recording), and a short "why this matters" clip
// goes to the private clips bucket the same two-step way as a form check. The bucket is a stand-in here (ctx.s3Fetch).
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

let app, base, coach, desk, squat, token, store, calls;
const PW = 'correct-horse-battery';
const ENV = { FORMCHECK_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', FORMCHECK_S3_BUCKET: 'dp-athlete-videos-test', FORMCHECK_S3_KEY_ID: 'key-test', FORMCHECK_S3_SECRET: 'secret-test' };
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const f = async (method, path, body) => { const r = await call(method, path, body); return { status: r.status, body: await r.json().catch(() => null) }; };
  f.raw = call;
  return f;
}
const athleteRaw = (method, path) => fetch(base + path, { method, headers: { 'x-client-token': token } });
const athlete = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
// The bucket: HEAD answers from `store` (path → { bytes, type }), DELETE forgets.
const s3Stub = () => async (url, init = {}) => {
  const u = new URL(url); calls.push({ method: init.method, path: u.pathname });
  const obj = store.get(u.pathname);
  if (init.method === 'HEAD') return obj ? new Response(null, { status: 200, headers: { 'content-length': String(obj.bytes), 'content-type': obj.type, etag: `"e-${obj.bytes}"` } }) : new Response(null, { status: 404 });
  if (init.method === 'DELETE') { store.delete(u.pathname); return new Response(null, { status: 204 }); }
  return new Response(null, { status: 405 });
};
const objectPath = (signedUrl) => new URL(signedUrl).pathname;
// A made-up recording: 3,000 bytes that aren't audio, which is fine here (the server trusts the type the browser gave).
const AUDIO = Buffer.alloc(3000, 7).toString('base64');

before(async () => {
  store = new Map(); calls = [];
  Object.assign(process.env, ENV);
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  const ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), ava.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  token = (await coach('GET', `/v1/clients/${ava.id}`)).body.app_link.split('token=')[1];
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', instructions: 'Brace before you descend.' })).body;
  const p = (await coach('POST', '/v1/programs', { name: 'Strength', weeks: 1 })).body;
  const w = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
  await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' });
  await coach('POST', `/v1/programs/${p.id}/assign`, { client_id: ava.id });
});
beforeEach(() => { calls = []; app.ctx.s3Fetch = s3Stub(); });
after(() => { app.server.close(); for (const k of Object.keys(ENV)) delete process.env[k]; });

test('a coach records a cue: the app gets the audio file and the words; front desk looks but can\'t record; the recording can be removed', async () => {
  const none = (await coach('GET', `/v1/exercises/${squat.id}/cue`)).body;
  assert.deepEqual([none.audio, none.clip, none.words, none.max_audio_seconds, none.clips_ready], [false, false, 'Brace before you descend.', 60, true], 'with nothing recorded the exercise\'s own cue is what the phone reads');
  assert.equal((await athleteRaw('GET', `/app/api/exercises/${squat.id}/cue/audio`)).status, 404);
  assert.equal((await desk('PUT', `/v1/exercises/${squat.id}/cue/audio`, { audio_base64: AUDIO, content_type: 'audio/webm' })).status, 403);
  assert.equal((await coach('PUT', `/v1/exercises/${squat.id}/cue/audio`, { audio_base64: AUDIO, content_type: 'text/plain' })).status, 400, 'an audio type only');
  assert.equal((await coach('PUT', `/v1/exercises/${squat.id}/cue/audio`, { audio_base64: '', content_type: 'audio/webm' })).status, 400);
  const big = await coach('PUT', `/v1/exercises/${squat.id}/cue/audio`, { audio_base64: Buffer.alloc(2 * 1024 * 1024 + 10, 1).toString('base64'), content_type: 'audio/webm' });
  assert.equal(big.status, 400); assert.match(big.body.error.message, /limit is 2 MB/);
  const saved = await coach('PUT', `/v1/exercises/${squat.id}/cue/audio`, { audio_base64: `data:audio/webm;base64,${AUDIO}`, content_type: 'audio/webm;codecs=opus', duration_s: 7, transcript: 'Brace hard, sit between your heels.' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.audio, saved.body.audio_seconds, saved.body.audio_type, saved.body.audio_by, saved.body.transcript, saved.body.words], [true, 7, 'audio/webm', 'Riley', 'Brace hard, sit between your heels.', 'Brace hard, sit between your heels.']);
  // The athlete's app: the flags on the exercise, and the bytes as an inline audio file.
  const home = (await athlete('GET', '/app/api/home')).body;
  assert.deepEqual(home.workout.exercises[0].cue, { audio: true, audio_seconds: 7, transcript: 'Brace hard, sit between your heels.', clip: false, clip_seconds: null });
  const file = await athleteRaw('GET', `/app/api/exercises/${squat.id}/cue/audio`);
  assert.equal(file.status, 200);
  assert.deepEqual([file.headers.get('content-type'), file.headers.get('content-disposition'), file.headers.get('cache-control'), file.headers.get('content-length')], ['audio/webm', 'inline', 'private, max-age=3600', '3000']);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(Buffer.alloc(3000, 7)), 'the same bytes back');
  const staffFile = await desk.raw('GET', `/v1/exercises/${squat.id}/cue/audio`);
  assert.equal(staffFile.status, 200, 'front desk can listen');
  assert.ok((await desk('GET', '/v1/exercises')).body.data.find((e) => e.id === squat.id).cue.audio, 'the library says which have a cue');
  // The words alone, then the recording removed: the words stay.
  assert.equal((await coach('PATCH', `/v1/exercises/${squat.id}/cue`, { transcript: 'Brace. Sit between the heels.' })).body.transcript, 'Brace. Sit between the heels.');
  const gone = (await coach('DELETE', `/v1/exercises/${squat.id}/cue/audio`)).body;
  assert.deepEqual([gone.audio, gone.transcript], [false, 'Brace. Sit between the heels.']);
  assert.equal((await athleteRaw('GET', `/app/api/exercises/${squat.id}/cue/audio`)).status, 404);
  assert.equal((await coach('PUT', `/v1/exercises/${squat.id}/cue/audio`, { audio_base64: AUDIO, content_type: 'audio/mp4', duration_s: 5 })).status, 200);
});

test('the "why this matters" clip: two-step upload to the private bucket, checked, played from a short-lived link, replaced and removed', async () => {
  assert.equal((await desk('POST', `/v1/exercises/${squat.id}/cue/clip`, { content_type: 'video/mp4', bytes: 1000 })).status, 403);
  assert.equal((await coach('POST', `/v1/exercises/${squat.id}/cue/clip`, { content_type: 'video/mp4', bytes: 1000, duration_s: 45 })).status, 400, 'twenty seconds at most');
  assert.equal((await coach('POST', `/v1/exercises/${squat.id}/cue/clip`, { content_type: 'image/png', bytes: 1000 })).status, 400);
  const s1 = await coach('POST', `/v1/exercises/${squat.id}/cue/clip`, { content_type: 'video/mp4', bytes: 4_000_000, duration_s: 12 });
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  assert.deepEqual([s1.body.upload.method, s1.body.max_seconds, s1.body.max_bytes], ['PUT', 20, 60 * 1024 * 1024]);
  assert.match(objectPath(s1.body.upload.url), /^\/dp-athlete-videos-test\/cues\/ex_[^/]+\/[a-z0-9]+\.mp4$/);
  assert.equal((await coach('GET', `/v1/exercises/${squat.id}/cue`)).body.clip_pending, true);
  // Not there yet: 400, the pending upload dropped. Then it arrives.
  assert.equal((await coach('POST', `/v1/exercises/${squat.id}/cue/clip/done`)).status, 400);
  assert.equal((await coach('GET', `/v1/exercises/${squat.id}/cue`)).body.clip_pending, false);
  const s2 = (await coach('POST', `/v1/exercises/${squat.id}/cue/clip`, { content_type: 'video/mp4', bytes: 4_000_000, duration_s: 12 })).body;
  store.set(objectPath(s2.upload.url), { bytes: 3_990_000, type: 'video/mp4' });
  const done = await coach('POST', `/v1/exercises/${squat.id}/cue/clip/done`);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.clip, done.body.clip_seconds, done.body.clip_by, done.body.clip_pending], [true, 12, 'Riley', false]);
  assert.equal((await athlete('GET', '/app/api/home')).body.workout.exercises[0].cue.clip, true);
  const play = await athlete('GET', `/app/api/exercises/${squat.id}/cue/video`);
  assert.equal(play.status, 200); assert.equal(objectPath(play.body.url), objectPath(s2.upload.url)); assert.equal(play.body.content_type, 'video/mp4');
  // Replacing: the new clip is checked first, then the old object goes.
  const s3 = (await coach('POST', `/v1/exercises/${squat.id}/cue/clip`, { content_type: 'video/webm', bytes: 2_000_000, duration_s: 8 })).body;
  store.set(objectPath(s3.upload.url), { bytes: 1_900_000, type: 'video/webm' });
  calls = [];
  assert.equal((await coach('POST', `/v1/exercises/${squat.id}/cue/clip/done`)).body.clip_seconds, 8);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === objectPath(s2.upload.url)), 'the old clip is removed');
  assert.ok(!store.has(objectPath(s2.upload.url)) && store.has(objectPath(s3.upload.url)));
  // The store down: 503 and the upload stays pending for the retry.
  const s4 = (await coach('POST', `/v1/exercises/${squat.id}/cue/clip`, { content_type: 'video/mp4', bytes: 1000, duration_s: 3 })).body;
  app.ctx.s3Fetch = async () => new Response(null, { status: 503 });
  assert.equal((await coach('POST', `/v1/exercises/${squat.id}/cue/clip/done`)).status, 503);
  assert.equal((await coach('GET', `/v1/exercises/${squat.id}/cue`)).body.clip_pending, true);
  app.ctx.s3Fetch = s3Stub(); store.set(objectPath(s4.upload.url), { bytes: 900, type: 'video/mp4' });
  assert.equal((await coach('POST', `/v1/exercises/${squat.id}/cue/clip/done`)).body.clip_seconds, 3);
  // Removed: the object too; the recording stays.
  const removed = (await coach('DELETE', `/v1/exercises/${squat.id}/cue/clip`)).body;
  assert.deepEqual([removed.clip, removed.audio], [false, true]);
  assert.equal(store.size, 0, 'nothing left in the bucket');
  assert.equal((await athlete('GET', `/app/api/exercises/${squat.id}/cue/video`)).status, 404);
});

test('a version 67 database gains the cue table', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-cues-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v67.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 67');
    old.exec(`INSERT INTO exercises (id, name, created_at) VALUES ('ex_1', 'Back squat', '2026-01-01T00:00:00.000Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 71, `round ${round}`);
      d.run(`INSERT OR REPLACE INTO exercise_cues (exercise_id, audio, audio_type, audio_bytes, updated_at) VALUES ('ex_1', ?, 'audio/webm', 3, '2026-02-01T00:00:00.000Z')`, Buffer.from([1, 2, 3]));
      assert.equal(d.get('SELECT audio_bytes FROM exercise_cues WHERE exercise_id = ?', 'ex_1').audio_bytes, 3);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
