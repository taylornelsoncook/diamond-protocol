// Sprint analysis (schema 65): clips of a rep go to the private clips bucket under sprint/ (a stand-in store here,
// ctx.s3Fetch), a coach marks the positions and taps points, and the server works out angles, grades and timing.
// Athletes upload from the app and see the analysis once it's sent; front desk has no part; the owner sets references.
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
import { measure, repGrade } from '../src/services/sprint.js';

let app, base, owner, coach, desk, maya, token, store, calls;
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
const s3Stub = () => async (url, init = {}) => {
  const u = new URL(url); calls.push({ method: init.method, path: u.pathname });
  const obj = store.get(u.pathname);
  if (init.method === 'HEAD') return obj ? new Response(null, { status: 200, headers: { 'content-length': String(obj.bytes), 'content-type': obj.type, etag: `"e-${obj.bytes}"` } }) : new Response(null, { status: 404 });
  if (init.method === 'DELETE') { store.delete(u.pathname); return new Response(null, { status: 204 }); }
  return new Response(null, { status: 405 });
};
// Upload a clip through either side: start, "arrive" in the store, done.
async function upload(call, path, body) {
  const s = await call('POST', path, { content_type: 'video/quicktime', bytes: 5_000_000, duration_s: 4, ...body });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.match(new URL(s.body.upload.url).pathname, /\/dp-athlete-videos-test\/sprint\//);
  store.set(new URL(s.body.upload.url).pathname, { bytes: 5_000_000, type: 'video/quicktime' });
  const done = await call('POST', path.replace(/\/clients\/[^/]+\/sprint-clips$/, '/sprint-clips').replace(/sprint-clips$/, `sprint-clips/${s.body.id}/done`));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body;
}

before(async () => {
  resetRateLimits();
  store = new Map();
  Object.assign(process.env, ENV);
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => '2026-10-01T15:00:00Z';
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley Brooks', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  maya = (await coach('POST', '/v1/clients', { name: 'Maya Okafor', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', maya.id).access_token;
});
beforeEach(() => { calls = []; app.ctx.s3Fetch = s3Stub(); });
after(() => { app.server.close(); for (const k of Object.keys(ENV)) delete process.env[k]; });

test('the angle maths and the rep grade', () => {
  const p = { hip: [500, 300], knee_swing: [600, 300], knee_stance: [500, 400], ankle_swing: [600, 400], ankle_stance: [500, 500], shoulder: [520, 200] };
  assert.equal(measure('thigh_separation', p), 90);
  assert.equal(measure('swing_knee', p), 90);
  assert.equal(measure('stance_knee', p), 180);
  assert.equal(measure('shin_angle', p), 0);
  assert.equal(measure('recovery_thigh', p), 90, 'a horizontal thigh ahead of the hip is 90 forward');
  assert.equal(measure('trunk_lean', p), 11, 'the shoulder ahead of the hip leans forward');
  assert.equal(measure('trunk_lean', p, -1), -11, 'running the other way, the same picture leans back');
  assert.equal(measure('thigh_separation', { hip: [0, 0] }), null, 'missing points give nothing');
  assert.deepEqual([repGrade(['A', 'A']), repGrade(['A', 'A', 'A', 'B']), repGrade(['B', 'B']), repGrade(['C', 'C']), repGrade([])], ['A', 'A−', 'B', 'C', null]);
});

test('a coach uploads a top-speed rep, marks it, and gets angles, grades, timing and distance per step', async () => {
  const clip = await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'top_speed', title: 'Fly 20', capture_fps: 240 });
  assert.deepEqual([clip.status, clip.kind_label, clip.uploaded_by_kind, clip.analysis.marked, clip.analysis.total], ['waiting', 'Top speed', 'staff', 0, 11]);
  assert.equal((await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { video_w: 1920, video_h: 1080, direction: 1 })).status, 200);
  const mark = (step, position, t, points = {}) => coach('PUT', `/v1/sprint-clips/${clip.id}/marks`, { step, position, t, points });
  // Step 1 MVP: thighs at a right angle (A), front knee at 90 against 110 (B): the position takes its weaker measure.
  let r = await mark(1, 'mvp', 0.16, { hip: [500, 300], knee_swing: [600, 300], knee_stance: [500, 400], ankle_swing: [600, 400] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mvp = r.body.analysis.positions.find((p) => p.step === 1 && p.position === 'mvp');
  assert.deepEqual(mvp.measures.map((m) => [m.label, m.value, m.grade]), [['Thigh separation', 90, 'A'], ['Front knee', 90, 'B']]);
  assert.equal(mvp.grade, 'B');
  assert.match(mvp.measures[1].cue, /more folded/);
  // The timing frames, with the stance foot for distance per step.
  await mark(1, 'toe_off', 0.100, { foot: [300, 600] });
  await mark(1, 'touchdown', 0.225, { knee_stance: [520, 400], ankle_stance: [520, 500] });
  await mark(2, 'toe_off', 0.325, { foot: [520, 600] });
  await mark(2, 'touchdown', 0.450);
  r = await mark(3, 'toe_off', 0.550, { foot: [740, 600] });
  let t = r.body.analysis.timing;
  assert.deepEqual(t.steps.map((s) => [s.flight_s, s.contact_s, s.step_time_s, s.step_rate_hz]), [[0.125, 0.1, 0.225, 4.44], [0.125, 0.1, 0.225, 4.44]]);
  assert.deepEqual([t.contact_s, t.step_length_m], [0.1, null], 'no distance until there is a scale');
  // Two cones 10 m apart give the scale: 220 px a step = 2.2 m.
  r = await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { calibration: { a: [100, 600], b: [1100, 600], meters: 10 } });
  assert.deepEqual(r.body.analysis.timing.steps.map((s) => [s.step_length_m, s.step_length_from]), [[2.2, 'cones'], [2.2, 'cones']]);
  // Without cones, speed from the timing gates times the step time.
  r = await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { calibration: null, speed_mps: 9.5 });
  assert.deepEqual(r.body.analysis.timing.steps.map((s) => [s.step_length_m, s.step_length_from]), [[2.14, 'speed'], [2.14, 'speed']]);
  // A file that plays 8 times slower than it was filmed (240 filmed, 30 in the file): the same frames are 8 times shorter.
  r = await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { file_fps: 30 });
  assert.equal(r.body.analysis.timing.steps[0].contact_s, 0.013);
  await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { file_fps: 240 });
  // Touchdown's shin is vertical (A); the swing knee wasn't tapped, so only the shin counts. Rep grade from the positions.
  const td = r.body.analysis.positions.find((p) => p.step === 1 && p.position === 'touchdown');
  assert.deepEqual(td.measures.map((m) => [m.value, m.grade]), [[0, 'A'], [null, null]]);
  assert.equal((await coach('GET', `/v1/sprint-clips/${clip.id}`)).body.analysis.grade, 'B+');
  // Refused: a position the kind doesn't have, step 3 other than toe-off, a point outside the video, an unknown point.
  assert.equal((await mark(1, 'plant', 0.2)).status, 400);
  assert.equal((await mark(3, 'mvp', 0.6)).status, 400);
  assert.equal((await mark(1, 'mvp', 0.16, { hip: [5000, 10] })).status, 400);
  assert.equal((await mark(1, 'mvp', 0.16, { elbow: [5, 10] })).status, 400);
  // Clearing a mark; changing the kind with marks on it needs confirm and clears them.
  assert.equal((await coach('DELETE', `/v1/sprint-clips/${clip.id}/marks`, { step: 2, position: 'touchdown' })).body.analysis.marked, 5);
  const k = await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { kind: 'acceleration' });
  assert.deepEqual([k.status, k.body.error.code], [409, 'confirm_needed']);
  assert.equal((await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { kind: 'acceleration', confirm: true })).body.analysis.marked, 0);
  // The list and the athlete's summary carry it; removing it removes the object from the bucket.
  const listed = (await coach('GET', `/v1/clients/${maya.id}/sprint`)).body;
  assert.ok(listed.data.some((c) => c.id === clip.id));
  assert.equal((await coach('DELETE', `/v1/sprint-clips/${clip.id}`)).status, 200);
  assert.ok(calls.some((c) => c.method === 'DELETE' && /\/sprint\//.test(c.path)));
  assert.equal((await coach('GET', `/v1/sprint-clips/${clip.id}`)).status, 404);
});

test('a change of direction: contact, braking and push from the plant to the push-off', async () => {
  const clip = await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'cod', capture_fps: 120, file_fps: 120 });
  assert.equal(clip.analysis.total, 4, 'one cut, four moments, no next toe-off');
  const mark = (position, t, points) => coach('PUT', `/v1/sprint-clips/${clip.id}/marks`, { step: 1, position, t, points });
  await mark('plant', 1.0, { knee_stance: [400, 400], ankle_stance: [460, 500], shoulder: [380, 200], hip: [400, 300] });
  await mark('deepest', 1.15);
  const r = await mark('push_off', 1.3);
  assert.deepEqual(r.body.analysis.timing.steps[0], { step: 1, contact_s: 0.3, braking_s: 0.15, propulsion_s: 0.15 });
  const plant = r.body.analysis.positions.find((p) => p.position === 'plant');
  assert.deepEqual(plant.measures.map((m) => [m.measure, m.value]), [['shin_lean', 31], ['trunk_lean_any', 11]]);
});

test('an athlete sends a rep and marks it; the coach marks and sends it with a message, then the marks are the coach\'s', async () => {
  const ready = (await athlete('GET', '/app/api/sprint')).body;
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.kinds.map((k) => k.key), ['top_speed', 'acceleration', 'cod']);
  const clip = await upload(athlete, '/app/api/sprint-clips', { kind: 'acceleration', note: 'First 10 m from a 3-point start', rep_time_s: 1.07 });
  assert.equal(clip.uploaded_by_kind, 'athlete');
  // Coaches see it waiting; front desk doesn't.
  const waiting = (await coach('GET', '/v1/sprint-clips?status=waiting')).body;
  assert.ok(waiting.data.some((c) => c.id === clip.id) && waiting.waiting >= 1);
  assert.equal((await desk('GET', '/v1/sprint-clips')).status, 403);
  assert.equal((await desk('GET', `/v1/sprint-clips/${clip.id}/video`)).status, 403);
  // Athletes mark their own reps too (owner decision) and see what's marked; the coach can mark the same clip.
  const own = await athlete('PUT', `/app/api/sprint-clips/${clip.id}/marks`, { step: 1, position: 'toe_off', t: 0.1, points: { hip: [500, 300] } });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual([own.body.can_edit, own.body.analysis.marked], [true, 1]);
  assert.equal(app.ctx.db.get(`SELECT updated_by FROM sprint_marks WHERE clip_id = ? AND position = 'toe_off'`, clip.id).updated_by, 'Maya Okafor');
  assert.equal((await athlete('PATCH', `/app/api/sprint-clips/${clip.id}`, { direction: -1 })).body.direction, -1);
  await athlete('PATCH', `/app/api/sprint-clips/${clip.id}`, { direction: 1 });
  assert.equal((await athlete('DELETE', `/app/api/sprint-clips/${clip.id}/marks`, { step: 1, position: 'toe_off' })).body.analysis.marked, 0);
  await coach('PUT', `/v1/sprint-clips/${clip.id}/marks`, { step: 1, position: 'mvp', t: 0.2, points: { hip: [500, 300], knee_swing: [600, 300], knee_stance: [500, 400] } });
  assert.equal((await athlete('GET', '/app/api/sprint')).body.data.find((c) => c.id === clip.id).grade, 'A');
  // Sending needs a marked position; then the athlete sees it and gets a coach message.
  const r = await coach('POST', `/v1/sprint-clips/${clip.id}/review`, { note: 'Great shin angles. Drive the knee through sooner.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'reviewed');
  const msg = app.ctx.db.get('SELECT body FROM coach_messages WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', maya.id).body;
  assert.match(msg, /^Sprint analysis, acceleration \(grade A\): Great shin angles/);
  const seen = await athlete('POST', `/app/api/sprint-clips/${clip.id}/seen`);
  assert.equal(seen.body.analysis.grade, 'A');
  assert.ok(seen.body.seen_at);
  assert.equal(seen.body.can_edit, false);
  assert.equal((await athlete('PUT', `/app/api/sprint-clips/${clip.id}/marks`, { step: 1, position: 'mvp', t: 0.3, points: {} })).status, 409, 'once sent, the marks are the coach\'s');
  // The play address is signed for the clip's own object; another athlete's clip isn't reachable from this app.
  const play = await athlete('GET', `/app/api/sprint-clips/${clip.id}/video`);
  assert.match(new URL(play.body.url).pathname, new RegExp(`/sprint/${maya.id}/${clip.id}\\.mov$`));
  const other = (await coach('POST', '/v1/clients', { name: 'Leo Marchetti', parent: { name: 'Gia Marchetti', email: 'gia@example.com' } })).body;
  const theirs = await upload(coach, `/v1/clients/${other.id}/sprint-clips`, { kind: 'top_speed' });
  assert.equal((await athlete('GET', `/app/api/sprint-clips/${theirs.id}`)).status, 404);
  assert.equal((await athlete('DELETE', `/app/api/sprint-clips/${theirs.id}`)).status, 404);
  // The family export has the grade and the note, never an address.
  const exp = (await owner('GET', `/v1/families/${maya.family.id}/export`)).body;
  const sa = JSON.stringify(exp).match(/"sprint_analyses":\[.*?\]\}/)?.[0] ?? '';
  assert.match(sa, /Drive the knee through sooner/);
  assert.doesNotMatch(JSON.stringify(exp), /r2\.cloudflarestorage|sprint\/cli/);
});

test('refused: no bucket, a bad file, a sprint kind we don\'t have, a review with nothing marked', async () => {
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/sprint-clips`, { kind: 'hurdles', content_type: 'video/mp4', bytes: 10 })).status, 400);
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/sprint-clips`, { kind: 'cod', content_type: 'image/png', bytes: 10 })).status, 400);
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/sprint-clips`, { kind: 'cod', content_type: 'video/mp4', bytes: 200 * 1024 * 1024 })).status, 400);
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/sprint-clips`, { kind: 'cod', content_type: 'video/mp4', bytes: 10, capture_fps: 100 })).status, 400);
  const bare = await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'top_speed' });
  assert.equal((await coach('POST', `/v1/sprint-clips/${bare.id}/review`, {})).status, 400);
  // A clip that never arrived: done drops the row.
  const s = await coach('POST', `/v1/clients/${maya.id}/sprint-clips`, { kind: 'top_speed', content_type: 'video/mp4', bytes: 10 });
  assert.equal((await coach('POST', `/v1/sprint-clips/${s.body.id}/done`)).status, 400);
  assert.equal(app.ctx.db.get('SELECT 1 FROM sprint_clips WHERE id = ?', s.body.id), undefined);
  const saved = process.env.FORMCHECK_S3_BUCKET; delete process.env.FORMCHECK_S3_BUCKET;
  try { assert.equal((await athlete('POST', '/app/api/sprint-clips', { kind: 'top_speed', content_type: 'video/mp4', bytes: 10 })).status, 503); }
  finally { process.env.FORMCHECK_S3_BUCKET = saved; }
});

test('the owner sets the references; coaches read them; every clip is re-graded', async () => {
  const refs = (await coach('GET', '/v1/sprint/references')).body;
  const ts = refs.kinds.find((k) => k.key === 'top_speed');
  assert.deepEqual(ts.positions.map((p) => p.key), ['toe_off', 'mvp', 'strike', 'touchdown', 'full_support']);
  assert.deepEqual(ts.positions[1].measures.map((m) => [m.measure, m.target]), [['thigh_separation', 90], ['swing_knee', 115]]);
  assert.equal(refs.customized, false);
  assert.equal((await coach('PATCH', '/v1/sprint/references', { references: { top_speed: { mvp: [{ measure: 'thigh_separation', target: 80, a: 10, b: 20 }] } } })).status, 403);
  assert.equal((await desk('GET', '/v1/sprint/references')).status, 403);
  for (const bad of [{ top_speed: { plant: [] } }, { hurdles: {} }, { top_speed: { mvp: [{ measure: 'elbow', target: 1, a: 1, b: 2 }] } }, { top_speed: { mvp: [{ measure: 'thigh_separation', target: 90, a: 20, b: 10 }] } },
    { top_speed: { mvp: [{ measure: 'thigh_separation', target: 90, a: 5, b: 10 }, { measure: 'thigh_separation', target: 80, a: 5, b: 10 }] } }]) {
    assert.equal((await owner('PATCH', '/v1/sprint/references', { references: bad })).status, 400, JSON.stringify(bad));
  }
  const clip = await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'top_speed' });
  await coach('PUT', `/v1/sprint-clips/${clip.id}/marks`, { step: 1, position: 'mvp', t: 0.2, points: { hip: [500, 300], knee_swing: [600, 300], knee_stance: [500, 400] } });
  assert.equal((await coach('GET', `/v1/sprint-clips/${clip.id}`)).body.analysis.grade, 'A');
  const saved = await owner('PATCH', '/v1/sprint/references', { references: { top_speed: { mvp: [{ measure: 'thigh_separation', target: 130, a: 10, b: 20 }] } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.customized, true);
  assert.equal((await coach('GET', `/v1/sprint-clips/${clip.id}`)).body.analysis.grade, 'C', 'a separation of 90 is 40 off a 130 target');
  assert.equal((await owner('PATCH', '/v1/sprint/references', { reset: true })).body.customized, false);
  assert.equal((await coach('GET', `/v1/sprint-clips/${clip.id}`)).body.analysis.grade, 'A');
});

test('the breakdown per step: projection and switching, as in the owner\'s screenshots, with scores', async () => {
  const clip = await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'top_speed', capture_fps: 240 });
  await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { video_w: 1920, video_h: 1080, calibration: { a: [100, 500], b: [1100, 500], meters: 10 } });   // 1 px = 1 cm
  const mark = (step, position, t, points) => coach('PUT', `/v1/sprint-clips/${clip.id}/marks`, { step, position, t, points });
  // Toe-off: the front thigh 68° forward, the pushing thigh 28° back, the foot 57 cm behind the hip.
  await mark(1, 'toe_off', 0.10, { hip: [500, 300], knee_swing: [599, 340], knee_stance: [473, 351], foot: [443, 500] });
  // Touchdown 0.125 s later: the pushing thigh has come through to 20° forward (48° in 0.125 s = 384°/s); the foot lands 47 cm ahead.
  await mark(1, 'touchdown', 0.225, { hip: [600, 300], knee_swing: [618, 350], foot: [647, 500] });
  await mark(1, 'strike', 0.2, { hip: [580, 298], knee_swing: [598, 348] });   // the pushing thigh, now at the back, 20° forward: 48° in 0.1 s = 480°/s
  await mark(1, 'full_support', 0.27, { hip: [640, 300], foot: [640, 389] });   // hip 89 cm up
  const r = await mark(2, 'toe_off', 0.325, { hip: [686, 300] });               // the hip travelled 1.86 m
  const b = r.body.analysis.breakdown;
  const val = (ch, k) => b.chapters.find((c) => c.key === ch).metrics.find((m) => m.key === k);
  assert.deepEqual(['hip_displacement_m', 'hip_flexion_deg', 'hip_extension_deg', 'hip_height_m'].map((k) => [val('projection', k).values[0].value, val('projection', k).values[0].word]),
    [[1.86, 'Below average'], [68, 'Within the optimal range'], [28, 'Within the optimal range'], [0.89, 'Above average']]);
  assert.deepEqual(['thigh_velocity_dps', 'touchdown_dist_m', 'takeoff_dist_m'].map((k) => [val('switching', k).values[0].value, val('switching', k).values[0].tone]),
    [[480, 'good'], [0.47, 'bad'], [0.57, 'good']]);
  assert.equal(val('projection', 'hip_displacement_m').summary, 'Below average on the step');
  assert.deepEqual(val('projection', 'hip_displacement_m').values[0].at, { step: 2, position: 'toe_off' }, 'drawn once the next toe-off is passed');
  const [proj, sw, re] = b.chapters;
  assert.deepEqual([proj.label, proj.score, proj.word, sw.label, sw.word], ['1. Projection', 75, 'Very good', '2. Switching', 'Very good']);
  // 3. Reactivity: contact from touchdown to the next toe-off (0.1 s, short), and no hip drop to full support (minimal).
  assert.deepEqual([re.label, val('reactivity', 'gct_s').values[0].value, val('reactivity', 'gct_s').summary, val('reactivity', 'compression_m').values[0].word], ['3. Reactivity', 0.1, 'Short on the step', 'Minimal']);
  // The four thigh phases, split at the ALTIS positions: with MVP's front thigh, the landing thigh and the second toe-off's thighs tapped, every phase reads.
  await mark(1, 'mvp', 0.16, { hip: [550, 290], knee_swing: [640, 320], knee_stance: [520, 340] });
  await mark(1, 'touchdown', 0.225, { hip: [600, 300], knee_swing: [618, 350], knee_stance: [640, 345], foot: [647, 500] });   // the landing thigh 42° forward
  await mark(1, 'full_support', 0.27, { hip: [640, 304], foot: [640, 389], knee_stance: [630, 354] });   // the landing thigh 11° forward; the hip dropped 4 cm
  const ph = (await mark(2, 'toe_off', 0.325, { hip: [686, 300], knee_swing: [780, 340], knee_stance: [660, 350] })).body.analysis.breakdown;
  const phase = (k) => ph.chapters[1].metrics.find((m) => m.key === k).values[0]?.value;
  assert.deepEqual(['early_flexion_dps', 'late_flexion_dps', 'early_extension_dps', 'late_extension_dps'].map(phase).map((x) => typeof x), ['number', 'number', 'number', 'number']);
  assert.equal(phase('early_flexion_dps'), 480);
  assert.equal(phase('thigh_velocity_dps'), Math.round((480 + phase('late_flexion_dps') + phase('early_extension_dps') + phase('late_extension_dps')) / 4), 'thigh speed is the average of the four');
  assert.ok(ph.chapters[1].metrics.find((m) => m.key === 'late_flexion_dps').detail);
  assert.equal(ph.chapters[2].metrics.find((m) => m.key === 'compression_m').values[0].value, 0.04);
  await mark(1, 'full_support', 0.27, { hip: [640, 300], foot: [640, 389] });
  await mark(2, 'toe_off', 0.325, { hip: [686, 300] });
  // Without the cones the distances wait; the angles and thigh speed don't need them.
  const bare = (await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { calibration: null })).body.analysis.breakdown;
  assert.equal(bare.needs_scale, true);
  assert.deepEqual([bare.chapters[0].metrics[0].values.length, bare.chapters[0].metrics[1].values.length, bare.chapters[1].metrics[0].values.length], [0, 1, 1]);
  // The owner's own bands change the verdict.
  assert.equal((await owner('PATCH', '/v1/sprint/references', { step_references: { top_speed: { hip_flexion_deg: [70, 80] } } })).status, 200);
  assert.equal((await coach('GET', `/v1/sprint-clips/${clip.id}`)).body.analysis.breakdown.chapters[0].metrics[1].values[0].word, 'Under the optimal range');
  assert.equal((await owner('PATCH', '/v1/sprint/references', { step_references: { top_speed: { hip_flexion_deg: [80, 70] } } })).status, 400);
  assert.equal((await owner('PATCH', '/v1/sprint/references', { step_references: { cod: { hip_flexion_deg: [1, 2] } } })).status, 400);
  await owner('PATCH', '/v1/sprint/references', { reset: true });
  // Up to four steps: step 5's toe-off closes step 4; going back to two drops what's past it.
  assert.equal((await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { steps: 4 })).body.analysis.total, 21);
  assert.equal((await mark(5, 'toe_off', 0.9, {})).status, 200);
  assert.equal((await mark(6, 'toe_off', 1.0, {})).status, 400);
  await mark(3, 'mvp', 0.5, {});
  const two = (await coach('PATCH', `/v1/sprint-clips/${clip.id}`, { steps: 2 })).body.analysis;
  assert.deepEqual([two.total, two.positions.filter((p) => p.marked).map((p) => `${p.step}:${p.position}`)], [11, ['1:toe_off', '1:mvp', '1:strike', '1:touchdown', '1:full_support', '2:toe_off']]);
  const cut = await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'cod' });
  assert.equal((await coach('PATCH', `/v1/sprint-clips/${cut.id}`, { steps: 3 })).status, 400);
  assert.equal(cut.analysis.breakdown, null);
});

test('the distance a clip covers: chosen at upload, changed later, filtered on; never on a cut', async () => {
  const a = await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'acceleration', segment: '0-10' });
  assert.deepEqual([a.segment, a.segment_label], ['0-10', '0–10 yd']);
  const b = await upload(athlete, '/app/api/sprint-clips', { kind: 'top_speed', segment: '20-30' });
  assert.equal(b.segment, '20-30');
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/sprint-clips`, { kind: 'top_speed', segment: '0-15', content_type: 'video/mp4', bytes: 10 })).status, 400);
  assert.equal((await coach('PATCH', `/v1/sprint-clips/${a.id}`, { segment: '40+' })).body.segment_label, '40+ yd');
  assert.equal((await athlete('PATCH', `/app/api/sprint-clips/${b.id}`, { segment: null })).body.segment, null);
  await coach('PATCH', `/v1/sprint-clips/${b.id}`, { segment: '10-20' });
  assert.deepEqual((await coach('GET', `/v1/sprint-clips?segment=10-20&client_id=${maya.id}`)).body.data.map((c) => c.id), [b.id]);
  // Left unsaid, a clip takes its kind's main test: top speed 30-40, acceleration 0-10 (owner decision).
  assert.equal((await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'top_speed' })).segment, '30-40');
  assert.equal((await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'acceleration' })).segment, '0-10');
  assert.equal((await coach('GET', '/v1/sprint-clips?segment=nope')).status, 400);
  const cut = await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'cod', segment: '0-10' });
  assert.equal(cut.segment, null, 'a change of direction has no distance');
  assert.deepEqual((await coach('GET', '/v1/sprint/references')).body.segments.map((x) => x.key), ['0-10', '10-20', '20-30', '30-40', '40+']);
});

test('a version 65 database gains the distance column, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v65.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 65');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 71, `round ${round}`);
      assert.ok(d.all('PRAGMA table_info(sprint_clips)').some((c) => c.name === 'segment'));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('suggested marks: saved as suggestions, graded at once, never over a person\'s mark; Looks right makes them a person\'s', async () => {
  const clip = await upload(coach, `/v1/clients/${maya.id}/sprint-clips`, { kind: 'top_speed' });
  await coach('PUT', `/v1/sprint-clips/${clip.id}/marks`, { step: 1, position: 'touchdown', t: 0.3, points: { knee_stance: [520, 400], ankle_stance: [520, 500] } });   // a person's mark
  const r = await coach('PUT', `/v1/sprint-clips/${clip.id}/auto`, { steps: 3, direction: -1, video_w: 1920, video_h: 1080, note: 'Found 3 steps.', marks: [
    { step: 1, position: 'mvp', t: 0.16, points: { hip: [500, 300], knee_swing: [600, 300], knee_stance: [500, 400], ankle_swing: [600, 400] } },
    { step: 1, position: 'touchdown', t: 0.25, points: { knee_stance: [500, 400], ankle_stance: [560, 500] } } ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.suggested_added, r.body.kept_manual, r.body.auto_note, r.body.steps, r.body.direction], [1, 1, 'Found 3 steps.', 2, 1], 'a person had marked already: their steps, direction and touchdown stay');
  const pos = (b, p) => b.analysis.positions.find((x) => x.step === 1 && x.position === p);
  assert.deepEqual([pos(r.body, 'mvp').suggested, pos(r.body, 'mvp').grade, pos(r.body, 'touchdown').suggested, pos(r.body, 'touchdown').t], [true, 'B', false, 0.3]);
  assert.equal(r.body.analysis.suggested, 1);
  // Running it again replaces only the earlier suggestions.
  const again = (await coach('PUT', `/v1/sprint-clips/${clip.id}/auto`, { marks: [{ step: 1, position: 'strike', t: 0.2, points: {} }] })).body;
  assert.deepEqual([pos(again, 'mvp').marked, pos(again, 'strike').suggested], [false, true]);
  // Looks right: one position, then all.
  const one = (await coach('POST', `/v1/sprint-clips/${clip.id}/confirm`, { step: 1, position: 'strike' })).body;
  assert.equal(pos(one, 'strike').suggested, false);
  assert.equal(app.ctx.db.get(`SELECT updated_by FROM sprint_marks WHERE clip_id = ? AND position = 'strike'`, clip.id).updated_by, 'Riley Brooks');
  // On a clip nobody has marked, the steps and direction found are taken; an athlete's own rep works the same way.
  const fresh = await upload(athlete, '/app/api/sprint-clips', { kind: 'acceleration' });
  const mine = await athlete('PUT', `/app/api/sprint-clips/${fresh.id}/auto`, { steps: 4, direction: -1, marks: [{ step: 1, position: 'toe_off', t: 0.1, points: { hip: [10, 10] } }] });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual([mine.body.steps, mine.body.direction, mine.body.analysis.suggested], [4, -1, 1]);
  assert.equal((await athlete('POST', `/app/api/sprint-clips/${fresh.id}/confirm`, {})).body.analysis.suggested, 0);
  assert.equal((await coach('PUT', `/v1/sprint-clips/${clip.id}/auto`, { marks: 'nope' })).status, 400);
  assert.equal((await coach('PUT', `/v1/sprint-clips/${clip.id}/auto`, { marks: [{ step: 1, position: 'plant', t: 0.2 }] })).status, 400, 'a bad suggestion saves nothing');
  assert.equal(pos((await coach('GET', `/v1/sprint-clips/${clip.id}`)).body, 'strike').marked, true, 'the earlier marks are still there after the refused one');
  assert.equal((await desk('PUT', `/v1/sprint-clips/${clip.id}/auto`, { marks: [] })).status, 403);
});

test('a version 64 database gains the sprint tables, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v64.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 64');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 71, `round ${round}`);
      const cols = d.all('PRAGMA table_info(sprint_clips)').map((c) => c.name);
      assert.ok(['kind', 'capture_fps', 'file_fps', 'calibration', 'etag'].every((c) => cols.includes(c)));
      assert.ok(d.all('PRAGMA table_info(sprint_marks)').length >= 6);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
