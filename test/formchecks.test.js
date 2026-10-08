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
import { presign, config, cleanup } from '../src/services/formchecks.js';

// Form checks (schema 53): an athlete films a set, the phone uploads it straight to the owner's private bucket with a
// one-time signed address, the coach answers. The bucket is a stand-in here (ctx.s3Fetch): objects "arrive" when the
// test puts them in `store`.
let app, base, owner, coach, desk, parent, maya, leo, token, slot, calls, store;
const PW = 'correct-horse-battery';
const NOW = '2026-09-29T14:00:00Z';
const ENV = { FORMCHECK_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', FORMCHECK_S3_BUCKET: 'dp-athlete-videos-test', FORMCHECK_S3_KEY_ID: 'key-test', FORMCHECK_S3_SECRET: 'secret-test' };
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const withKey = (key) => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function parentSignIn(email) {
  const login = await fetch(base + '/portal/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) }).then((r) => r.json());
  const v = await fetch(base + '/portal/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: login.dev_code }) });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + '/portal/api/' + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// The bucket: HEAD answers from `store` (path → { bytes, type }), DELETE forgets.
const s3Stub = () => async (url, init = {}) => {
  const u = new URL(url); calls.push({ method: init.method, path: u.pathname, auth: init.headers?.authorization ?? null });
  const obj = store.get(u.pathname);
  if (init.method === 'HEAD') return obj ? new Response(null, { status: 200, headers: { 'content-length': String(obj.bytes), 'content-type': obj.type, etag: `"e-${obj.bytes}"` } }) : new Response(null, { status: 404 });
  if (init.method === 'DELETE') { store.delete(u.pathname); return new Response(null, { status: 204 }); }
  return new Response(null, { status: 405 });
};
const objectPath = (signedUrl) => new URL(signedUrl).pathname;

before(async () => {
  resetRateLimits();
  store = new Map();
  Object.assign(process.env, ENV);
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  maya = (await owner('POST', '/v1/clients', { name: 'Maya Okafor', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  leo = (await owner('POST', '/v1/clients', { name: 'Leo Marchetti', parent: { name: 'Gina Marchetti', email: 'gina@example.com' } })).body;
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', maya.id).access_token;
  parent = await parentSignIn('ada@example.com');
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  const p = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 2 })).body;
  const w = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
  const added = (await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' })).body;
  slot = added.exercises?.[0] ?? added;
});
beforeEach(() => { calls = []; app.ctx.s3Fetch = s3Stub(); });   // the bucket (store) lives across tests, like a real one
after(() => { app.server.close(); for (const k of Object.keys(ENV)) delete process.env[k]; });

test('the signed address: AWS Signature Version 4 in the query, the content type signed for uploads, a known signature', () => {
  const s = presign({ method: 'PUT', url: 'https://acct.r2.cloudflarestorage.com/dp-athlete-videos-test/form-checks/cli_1/fc_1.mp4', region: 'auto', keyId: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', expires: 900, now: new Date('2026-09-29T14:00:00Z'), contentType: 'video/mp4' });
  const u = new URL(s.url);
  assert.equal(u.origin + u.pathname, 'https://acct.r2.cloudflarestorage.com/dp-athlete-videos-test/form-checks/cli_1/fc_1.mp4');
  assert.deepEqual([u.searchParams.get('X-Amz-Algorithm'), u.searchParams.get('X-Amz-Credential'), u.searchParams.get('X-Amz-Date'), u.searchParams.get('X-Amz-Expires'), u.searchParams.get('X-Amz-SignedHeaders')],
    ['AWS4-HMAC-SHA256', 'AKIDEXAMPLE/20260929/auto/s3/aws4_request', '20260929T140000Z', '900', 'content-type;host']);
  assert.match(u.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  assert.deepEqual(s.headers, { 'content-type': 'video/mp4' });
  // The same inputs always sign the same, and any change to them changes the signature.
  const again = presign({ method: 'PUT', url: 'https://acct.r2.cloudflarestorage.com/dp-athlete-videos-test/form-checks/cli_1/fc_1.mp4', region: 'auto', keyId: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', expires: 900, now: new Date('2026-09-29T14:00:00Z'), contentType: 'video/mp4' });
  assert.equal(again.url, s.url);
  const other = presign({ method: 'PUT', url: 'https://acct.r2.cloudflarestorage.com/dp-athlete-videos-test/form-checks/cli_1/fc_1.mp4', region: 'auto', keyId: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', expires: 900, now: new Date('2026-09-29T14:00:00Z'), contentType: 'video/quicktime' });
  assert.notEqual(new URL(other.url).searchParams.get('X-Amz-Signature'), u.searchParams.get('X-Amz-Signature'));
  const get = presign({ method: 'GET', url: 'https://acct.r2.cloudflarestorage.com/b/k.mp4', region: 'auto', keyId: 'k', secret: 's', expires: 600 });
  assert.equal(new URL(get.url).searchParams.get('X-Amz-SignedHeaders'), 'host'); assert.deepEqual(get.headers, {});
});

test('set-up: the clips bucket is its own, never the backups bucket; the page may talk to the storage address', async () => {
  assert.deepEqual(config({ ...ENV, BACKUP_S3_BUCKET: 'dp-athlete-videos-test' }).problems, ['FORMCHECK_S3_BUCKET is the backups bucket. Clips need their own private bucket.']);
  assert.equal(config({ BACKUP_S3_ENDPOINT: ENV.FORMCHECK_S3_ENDPOINT, BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's', FORMCHECK_S3_BUCKET: 'dp-athlete-videos' }).ready, true, 'the backups\' token and address can serve the clips bucket');
  assert.match(config({}).problems.join(' '), /FORMCHECK_S3_BUCKET is not set/);
  const s = (await owner('GET', '/v1/form-checks/status')).body;
  assert.deepEqual([s.ready, s.bucket, s.storage_origin, s.keep_days, s.max_mb, s.max_seconds, s.cors_origins, s.waiting], [true, 'dp-athlete-videos-test', 'https://acct.r2.cloudflarestorage.com', 90, 150, 60, ['https://app.example.org'], 0]);
  assert.equal((await desk('GET', '/v1/form-checks/status')).status, 403, 'front desk has nothing to do with clips');
  const page = await fetch(base + '/app');
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:\/\/acct\.r2\.cloudflarestorage\.com/);
  assert.equal((await owner('PATCH', '/v1/settings', { form_check_keep_days: 20 })).status, 400, 'kept 30 to 365 days');
  assert.equal((await owner('PATCH', '/v1/settings', { form_check_keep_days: 45 })).status, 200);
  assert.equal((await owner('GET', '/v1/form-checks/status')).body.keep_days, 45);
});

test('an athlete sends a clip: a one-time upload address, then the server checks what arrived and tells the coach', async () => {
  const before = (await athlete('GET', '/app/api/form-checks')).body;
  assert.deepEqual([before.data, before.ready, before.max_bytes, before.max_seconds], [[], true, 150 * 1024 * 1024, 60]);
  assert.equal((await athlete('POST', '/app/api/form-checks', { content_type: 'image/png', bytes: 1000 })).status, 400, 'videos only');
  const big = await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 200 * 1024 * 1024 });
  assert.equal(big.status, 400); assert.match(big.body.error.message, /200 MB. Keep clips under 150 MB/);
  assert.match((await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 1000, duration_s: 95 })).body.error.message, /60 seconds/);
  const start = await athlete('POST', '/app/api/form-checks', { content_type: 'video/quicktime', bytes: 24_000_000, duration_s: 38.5, note: 'Third set, felt my knees cave', workout_exercise_id: slot.id });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const { id, upload, exercise_name } = start.body;
  assert.equal(exercise_name, 'Back squat');
  assert.equal(upload.method, 'PUT'); assert.deepEqual(upload.headers, { 'content-type': 'video/quicktime' }); assert.equal(upload.expires_in, 900);
  assert.equal(objectPath(upload.url), `/dp-athlete-videos-test/form-checks/${maya.id}/${id}.mov`);
  // Nobody sees it while it's uploading.
  assert.deepEqual((await athlete('GET', '/app/api/form-checks')).body.data, []);
  assert.equal((await coach('GET', '/v1/form-checks')).body.data.length, 0);
  // The phone gave up: done says the clip didn't arrive, and the row goes.
  const missing = await athlete('POST', `/app/api/form-checks/${id}/done`);
  assert.equal(missing.status, 400); assert.match(missing.body.error.message, /didn't arrive/);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM form_checks').n, 0);
  // Again, and this time the clip lands in the bucket before done. A store that can't be reached keeps the row and says try again.
  const s2 = (await athlete('POST', '/app/api/form-checks', { content_type: 'video/quicktime', bytes: 24_000_000, duration_s: 38.5, note: 'Third set, felt my knees cave', workout_exercise_id: slot.id })).body;
  store.set(objectPath(s2.upload.url), { bytes: 23_990_000, type: 'video/quicktime' });
  const plain = app.ctx.s3Fetch;
  app.ctx.s3Fetch = async () => new Response(null, { status: 503 });
  const down = await athlete('POST', `/app/api/form-checks/${s2.id}/done`);
  assert.equal(down.status, 503); assert.match(down.body.error.message, /Try again in a minute/);
  assert.equal(app.ctx.db.get('SELECT status FROM form_checks WHERE id = ?', s2.id).status, 'uploading', 'the row stays for the retry');
  app.ctx.s3Fetch = plain;
  const done = await athlete('POST', `/app/api/form-checks/${s2.id}/done`);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.status, done.body.bytes, done.body.exercise_name, done.body.workout_title, done.body.note, done.body.sent_at, done.body.days_left], ['sent', 23_990_000, 'Back squat', 'Lower', 'Third set, felt my knees cave', NOW, 45]);
  assert.equal(app.ctx.db.get('SELECT etag FROM form_checks WHERE id = ?', s2.id).etag, 'e-23990000', 'what was checked is pinned');
  assert.ok(calls.some((c) => c.method === 'HEAD' && c.path === objectPath(s2.upload.url) && /^AWS4-HMAC-SHA256 Credential=key-test\//.test(c.auth)), 'the server checked the object with a signed HEAD');
  assert.equal((await athlete('POST', `/app/api/form-checks/${s2.id}/done`)).body.status, 'sent', 'done twice is fine');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'form_check.sent'`).n, 1);
  // A clip that arrived as something else, or too big, is thrown out.
  const s3 = (await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 5_000_000 })).body;
  store.set(objectPath(s3.upload.url), { bytes: 5_000_000, type: 'application/zip' });
  assert.match((await athlete('POST', `/app/api/form-checks/${s3.id}/done`)).body.error.message, /isn't the video you chose/);
  assert.equal(store.has(objectPath(s3.upload.url)), false, 'and removed from the bucket');
  const s4 = (await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 5_000_000 })).body;
  store.set(objectPath(s4.upload.url), { bytes: 160 * 1024 * 1024, type: 'video/mp4' });
  assert.match((await athlete('POST', `/app/api/form-checks/${s4.id}/done`)).body.error.message, /160 MB; the limit is 150 MB/);
});

test('who sees it: the coach and owner (Today says one is waiting), the parent in the portal, never front desk or another family', async () => {
  const fc = app.ctx.db.get(`SELECT id FROM form_checks WHERE status = 'sent'`);
  const list = (await coach('GET', '/v1/form-checks?status=waiting')).body.data;
  assert.equal(list.length, 1); assert.deepEqual([list[0].id, list[0].client_name, list[0].exercise_name], [fc.id, 'Maya Okafor', 'Back squat']);
  const today = (await coach('GET', '/v1/dashboard')).body.attention.find((a) => a.kind === 'form_checks');
  assert.deepEqual([today.count, today.items[0].name, today.items[0].exercise_name], [1, 'Maya Okafor', 'Back squat']);
  assert.equal((await desk('GET', '/v1/dashboard')).body.attention.some((a) => a.kind === 'form_checks'), false);
  assert.equal((await desk('GET', '/v1/form-checks')).status, 403);
  const play = (await owner('GET', `/v1/form-checks/${fc.id}/video`)).body;
  assert.equal(objectPath(play.url), `/dp-athlete-videos-test/form-checks/${maya.id}/${fc.id}.mov`);
  assert.deepEqual([new URL(play.url).searchParams.get('X-Amz-Expires'), play.content_type], ['600', 'video/quicktime']);
  assert.equal((await owner('GET', `/v1/form-checks/${fc.id}/video?which=reply`)).status, 404, 'no reply clip yet');
  const mine = (await parent('GET', `athletes/${maya.id}/form-checks`)).body.data;
  assert.equal(mine[0].id, fc.id);
  assert.equal((await parent('GET', `form-checks/${fc.id}/video`)).status, 200);
  const gina = await parentSignIn('gina@example.com');
  assert.equal((await gina('GET', `form-checks/${fc.id}/video`)).status, 404, 'another family can\'t watch it');
  assert.equal((await gina('DELETE', `form-checks/${fc.id}`)).status, 404);
  assert.equal((await gina('GET', `athletes/${maya.id}/form-checks`)).status, 404);
  const own = (await athlete('GET', `/app/api/form-checks/${fc.id}/video`)).body;
  assert.equal(objectPath(own.url), objectPath(play.url));
  // API keys, whatever their level, never reach the clips: these routes are for signed-in staff only.
  const read = withKey((await owner('POST', '/v1/api-keys', { label: 'Website' })).body.secret), full = withKey((await owner('POST', '/v1/api-keys', { label: 'CRM', scope: 'full' })).body.secret);
  for (const k of [read, full]) {
    assert.equal((await k('GET', '/v1/form-checks')).status, 401);
    assert.equal((await k('GET', `/v1/form-checks/${fc.id}/video`)).status, 401);
    assert.equal((await k('POST', `/v1/form-checks/${fc.id}/reply`, { text: 'no' })).status, 401);
    assert.equal((await k('DELETE', `/v1/form-checks/${fc.id}`)).status, 401);
  }
  assert.equal((await fetch(base + `/v1/form-checks/${fc.id}/video`)).status, 401, 'nobody signed in');
  assert.ok(app.ctx.db.get(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'GET /v1/form-checks/:id/video' AND target = ?`, fc.id).n >= 1, 'every play link handed out is in the activity log');
});

test('a clip swapped after it was checked (the upload address works 15 minutes) is refused and removed', async () => {
  const s = (await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 3_000_000, exercise_name: 'Hang clean' })).body;
  store.set(objectPath(s.upload.url), { bytes: 3_000_000, type: 'video/mp4' });
  await athlete('POST', `/app/api/form-checks/${s.id}/done`);
  store.set(objectPath(s.upload.url), { bytes: 2_500_000, type: 'video/mp4' });   // a different object under the same address
  const r = await owner('GET', `/v1/form-checks/${s.id}/video`);
  assert.equal(r.status, 409); assert.match(r.body.error.message, /isn't the one that was checked/);
  assert.equal(store.has(objectPath(s.upload.url)), false, 'removed from the bucket');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM form_checks WHERE id = ?', s.id).n, 0);
});

test('the coach answers: a note becomes a coach message, a clip of their own can come with it, the athlete marks it read', async () => {
  const fc = app.ctx.db.get(`SELECT id FROM form_checks WHERE status = 'sent'`);
  assert.equal((await coach('POST', `/v1/form-checks/${fc.id}/reply`, { text: '' })).status, 400);
  const r = await coach('POST', `/v1/form-checks/${fc.id}/reply`, { text: 'Knees are caving on the way up. Push them out over your toes and try a lighter set.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.coach_name, r.body.answered_at, r.body.has_reply_video, r.body.seen_by_athlete_at], ['answered', 'Riley', NOW, false, null]);
  const msg = app.ctx.db.get('SELECT body, staff_name FROM coach_messages WHERE client_id = ? ORDER BY created_at DESC', maya.id);
  assert.deepEqual([msg.staff_name, msg.body], ['Riley', 'Form check, Back squat: Knees are caving on the way up. Push them out over your toes and try a lighter set.']);
  assert.equal((await coach('GET', '/v1/dashboard')).body.attention.some((a) => a.kind === 'form_checks'), false, 'nothing waiting');
  // A reply clip: start, upload, done.
  const rv = await coach('POST', `/v1/form-checks/${fc.id}/reply-video`, { content_type: 'video/mp4', bytes: 8_000_000 });
  assert.equal(rv.status, 201); assert.match(objectPath(rv.body.upload.url), new RegExp(`^/dp-athlete-videos-test/form-checks/${maya.id}/${fc.id}-reply-[\\w-]+\\.mp4$`));
  assert.equal((await owner('GET', `/v1/form-checks/${fc.id}/video?which=reply`)).status, 404, 'not until it\'s checked');
  store.set(objectPath(rv.body.upload.url), { bytes: 8_000_000, type: 'video/mp4' });
  const rd = await coach('POST', `/v1/form-checks/${fc.id}/reply-video/done`);
  assert.equal(rd.status, 200); assert.equal(rd.body.has_reply_video, true);
  assert.equal((await athlete('GET', `/app/api/form-checks/${fc.id}/video?which=reply`)).body.content_type, 'video/mp4');
  // Replacing the coach's clip: the first stays watchable until the new one is checked, then the first object goes.
  const firstKey = objectPath(rv.body.upload.url);
  const rv2 = (await coach('POST', `/v1/form-checks/${fc.id}/reply-video`, { content_type: 'video/quicktime', bytes: 6_000_000 })).body;
  assert.equal(objectPath((await owner('GET', `/v1/form-checks/${fc.id}/video?which=reply`)).body.url), firstKey, 'still the first clip while the new one uploads');
  assert.match((await coach('POST', `/v1/form-checks/${fc.id}/reply-video/done`)).body.error.message, /didn't arrive/);
  assert.equal(objectPath((await owner('GET', `/v1/form-checks/${fc.id}/video?which=reply`)).body.url), firstKey, 'a failed replacement loses nothing');
  const rv3 = (await coach('POST', `/v1/form-checks/${fc.id}/reply-video`, { content_type: 'video/quicktime', bytes: 6_000_000 })).body;
  store.set(objectPath(rv3.upload.url), { bytes: 6_000_000, type: 'video/quicktime' });
  assert.equal((await coach('POST', `/v1/form-checks/${fc.id}/reply-video/done`)).body.has_reply_video, true);
  assert.equal(objectPath((await owner('GET', `/v1/form-checks/${fc.id}/video?which=reply`)).body.url), objectPath(rv3.upload.url));
  assert.equal(store.has(firstKey), false, 'the first clip was removed from the bucket');
  assert.ok(!rv2.upload.url.includes(firstKey));
  const seen = await athlete('POST', `/app/api/form-checks/${fc.id}/seen`);
  assert.equal(seen.body.seen_by_athlete_at, NOW);
  assert.equal((await athlete('GET', '/app/api/form-checks')).body.data[0].reply.startsWith('Knees are caving'), true);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'form_check.answered'`).n, 1);
  const exp = (await owner('GET', `/v1/families/${maya.family.id}/export`)).body;
  assert.deepEqual(exp.athletes[0].form_checks.map((x) => [x.exercise_name, x.status, x.coach_name]), [['Back squat', 'answered', 'Riley']]);
});

test('ten a day per athlete, then a rest; a parent removes a clip and both objects go; the daily job removes clips past their keep date and uploads that never finished', async () => {
  // Five sent so far today (four in the sending test, one swapped); five more, the last left uploading, make ten.
  for (let i = 0; i < 5; i++) { const s = (await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 1000 })).body; assert.ok(s.upload, JSON.stringify(s)); if (i < 4) { store.set(objectPath(s.upload.url), { bytes: 1000, type: 'video/mp4' }); await athlete('POST', `/app/api/form-checks/${s.id}/done`); } }
  const eleventh = await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 1000 });
  assert.equal(eleventh.status, 429, JSON.stringify(eleventh.body));
  const answered = app.ctx.db.get(`SELECT id, object_key, reply_object_key FROM form_checks WHERE status = 'answered'`);
  store.set(`/dp-athlete-videos-test/${answered.object_key}`, { bytes: 1, type: 'video/quicktime' }); store.set(`/dp-athlete-videos-test/${answered.reply_object_key}`, { bytes: 1, type: 'video/mp4' });
  const gone = await parent('DELETE', `form-checks/${answered.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.path).sort(), [`/dp-athlete-videos-test/${answered.object_key}`, `/dp-athlete-videos-test/${answered.reply_object_key}`].sort());
  assert.equal(store.has(`/dp-athlete-videos-test/${answered.object_key}`), false);
  // The job: one clip past its date, one upload that never finished from yesterday; the rest stay.
  const sent = app.ctx.db.all(`SELECT id FROM form_checks WHERE status = 'sent' ORDER BY sent_at, rowid`);
  app.ctx.db.run(`UPDATE form_checks SET expires_at = '2026-09-28T00:00:00Z' WHERE id = ?`, sent[0].id);
  app.ctx.db.run(`UPDATE form_checks SET created_at = '2026-09-27T00:00:00Z' WHERE status = 'uploading'`);
  const stale = app.ctx.db.get(`SELECT COUNT(*) AS n FROM form_checks WHERE status = 'uploading'`).n;
  assert.equal(stale, 1);
  calls = [];
  assert.deepEqual(await cleanup(app.ctx), { removed: 2, kept: 0, orphans: 0 });
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM form_checks WHERE id = ?', sent[0].id).n, 0);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM form_checks WHERE status = 'uploading'`).n, 0);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM form_checks`).n, sent.length - 1);
  // A store that won't delete keeps the row for tomorrow.
  app.ctx.db.run(`UPDATE form_checks SET expires_at = '2026-09-28T00:00:00Z' WHERE id = ?`, sent[1].id);
  app.ctx.s3Fetch = async () => new Response(null, { status: 500 });
  assert.deepEqual(await cleanup(app.ctx), { removed: 0, kept: 1, orphans: 0 });
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM form_checks WHERE id = ?', sent[1].id).n, 1);
  // A parent removes a clip while the store refuses: the removal still finishes and the object is parked for the job.
  const parked = app.ctx.db.get('SELECT object_key FROM form_checks WHERE id = ?', sent[2].id).object_key;
  assert.equal((await parent('DELETE', `form-checks/${sent[2].id}`)).status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM form_checks WHERE id = ?', sent[2].id).n, 0);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM form_check_orphans WHERE object_key = ?', parked).n, 1);
  app.ctx.s3Fetch = s3Stub();
  const again = await cleanup(app.ctx);
  assert.equal(again.orphans, 1);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM form_check_orphans').n, 0);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === `/dp-athlete-videos-test/${parked}`));
});

test('deleting the family removes every clip from the bucket; an archived athlete\'s clips drop off Today', async () => {
  const kid = (await owner('POST', '/v1/clients', { name: 'Tomas Reyes', parent: { name: 'Ines Reyes', email: 'ines@example.com' } })).body;
  const tok = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', kid.id).access_token;
  const send = async (b) => { const r = await fetch(base + '/app/api/form-checks', { method: 'POST', headers: { 'x-client-token': tok, 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r.json(); };
  const s = await send({ content_type: 'video/mp4', bytes: 1000, exercise_name: 'Hang clean' });
  store.set(objectPath(s.upload.url), { bytes: 1000, type: 'video/mp4' });
  await fetch(base + `/app/api/form-checks/${s.id}/done`, { method: 'POST', headers: { 'x-client-token': tok } });
  const waiting = () => owner('GET', '/v1/dashboard').then((r) => r.body.attention.find((a) => a.kind === 'form_checks')?.count ?? 0);
  const n = await waiting();
  assert.equal((await owner('GET', `/v1/form-checks?status=waiting&client_id=${kid.id}`)).body.data.length, 1);
  await owner('POST', `/v1/clients/${kid.id}/archive`, {});
  assert.equal(await waiting(), n - 1, 'archived: off Today');
  const blocked = await fetch(base + '/app/api/form-checks', { method: 'POST', headers: { 'x-client-token': tok, 'content-type': 'application/json' }, body: JSON.stringify({ content_type: 'video/mp4', bytes: 1000 }) });
  assert.equal(blocked.status, 409, 'an archived athlete can\'t send');
  calls = [];
  const del = await owner('DELETE', `/v1/families/${kid.family.id}`, { confirm: 'Reyes family' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === objectPath(s.upload.url)), 'the clip was removed from the bucket');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM form_checks WHERE client_id = ?', kid.id).n, 0);
});

test('not set up: the app says so and nothing is offered; a version 52 database gains the form_checks table, opened twice', async () => {
  const saved = process.env.FORMCHECK_S3_BUCKET; delete process.env.FORMCHECK_S3_BUCKET;
  try {
    assert.equal((await athlete('GET', '/app/api/form-checks')).body.ready, false);
    const r = await athlete('POST', '/app/api/form-checks', { content_type: 'video/mp4', bytes: 1000 });
    assert.equal(r.status, 503); assert.match(r.body.error.message, /aren't set up yet/);
    assert.equal((await fetch(base + '/app')).headers.get('content-security-policy').includes('cloudflarestorage'), false);
  } finally { process.env.FORMCHECK_S3_BUCKET = saved; }
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v52.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 52');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 69, `round ${round}`);
      assert.equal(d.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'form_checks'`).n, 1);
      assert.equal(d.get(`SELECT COUNT(*) AS n FROM pragma_table_info('form_checks') WHERE name IN ('object_key', 'reply_object_key', 'expires_at', 'seen_by_athlete_at', 'etag', 'reply_pending_key')`).n, 6);
      assert.equal(d.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'form_check_orphans'`).n, 1);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
