// The video library (schema 48): the upload tool (tools/upload-videos.mjs) turns folders of videos into uploads and a
// CSV; the owner brings the CSV in at Settings → Exercise library → Import a list. Names come from the file names, the
// same name twice is uploaded once, a second run carries on, and the import is checked first and all or nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { main as upload, exerciseName, scan } from '../tools/upload-videos.mjs';

let app, base, owner, coach, dir, s3, s3url;
const puts = [];
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

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: PW, role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev');
  // A pretend bucket: records every upload.
  s3 = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { puts.push({ method: req.method, url: req.url, headers: req.headers, size: Buffer.concat(chunks).length }); res.writeHead(200); res.end(); });
  });
  await new Promise((r) => s3.listen(0, r));
  s3url = `http://localhost:${s3.address().port}`;
  // The videos: a folder on the computer and one on a drive, with the same exercise in both.
  dir = mkdtempSync(join(tmpdir(), 'dp-videos-test-'));
  const computer = join(dir, 'computer'), drive = join(dir, 'drive');
  mkdirSync(join(computer, 'Lower body'), { recursive: true }); mkdirSync(join(drive, 'Extra'), { recursive: true });
  writeFileSync(join(computer, 'Lower body', 'Back_squat.mp4'), 'video one');
  writeFileSync(join(computer, 'Lower body', 'Walking lunge (1).MOV'), 'video two');
  writeFileSync(join(computer, 'Push-up.m4v'), 'video three');
  writeFileSync(join(computer, 'Band pull apart.avi'), 'video four');
  writeFileSync(join(computer, '._Push-up.m4v'), 'mac junk');
  writeFileSync(join(computer, 'notes.txt'), 'not a video');
  writeFileSync(join(drive, 'Extra', 'back squat.mp4'), 'the same exercise again');
  writeFileSync(join(drive, 'Copenhagen plank copy.mp4'), 'video five');
  // A stand-in ffmpeg: copies the video, writes a still for -frames:v.
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'ffmpeg'), `#!/bin/sh
if [ "$1" = "-version" ]; then exit 0; fi
for a in "$@"; do out="$a"; done
prev=""; src=""; for a in "$@"; do if [ "$prev" = "-i" ]; then src="$a"; fi; prev="$a"; done
case "$*" in *-frames:v*) printf 'JPEG' > "$out" ;; *) cp "$src" "$out" ;; esac
`);
  chmodSync(join(bin, 'ffmpeg'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
});
after(() => { app.server.close(); s3.close(); rmSync(dir, { recursive: true, force: true }); });

const ENV = () => ({ VIDEO_S3_ENDPOINT: s3url, VIDEO_S3_BUCKET: 'dp-videos', VIDEO_S3_KEY_ID: 'key', VIDEO_S3_SECRET: 'secret', VIDEO_PUBLIC_URL: 'https://videos.example.com' });

test('names come from the file names; hidden files and other files are left out; a name twice is kept once', () => {
  assert.equal(exerciseName('Back_squat.mp4'), 'Back squat');
  assert.equal(exerciseName('Walking lunge (1).MOV'), 'Walking lunge');
  assert.equal(exerciseName('Copenhagen plank copy.mp4'), 'Copenhagen plank');
  assert.equal(exerciseName('Push-up.m4v'), 'Push-up');
  const s = scan([join(dir, 'computer'), join(dir, 'drive')]);
  assert.deepEqual(s.found.map((f) => [f.name, f.category]), [['Band pull apart', ''], ['Back squat', 'Lower body'], ['Walking lunge', 'Lower body'], ['Push-up', ''], ['Copenhagen plank', '']]);
  assert.equal(s.duplicates.length, 1);
  assert.match(s.duplicates[0], /back squat\.mp4/);
  assert.throws(() => scan([join(dir, 'nope')]), /There's no folder/);
});

test('the upload: a quick-loading copy and a still for each, signed, cached for a year; a second run carries on', async () => {
  const lines = [];
  const cwd = mkdtempSync(join(tmpdir(), 'dp-videos-run-'));
  const r = await upload([join(dir, 'computer'), join(dir, 'drive'), '--skip-check', '--jobs', '2'], { env: ENV(), log: (l) => lines.push(l), cwd });
  assert.deepEqual([r.found, r.uploaded, r.failed, r.duplicates], [5, 5, 0, 1]);
  const videos = puts.filter((p) => p.url.endsWith('.mp4')), stills = puts.filter((p) => p.url.endsWith('.jpg'));
  assert.equal(videos.length, 5, 'every video converted to .mp4');
  assert.equal(stills.length, 5);
  for (const p of puts) {
    assert.equal(p.method, 'PUT');
    assert.match(p.url, /^\/dp-videos\/exercises\/[a-z0-9-]+-[0-9a-f]{10}\.(mp4|jpg)$/);
    assert.match(p.headers.authorization, /^AWS4-HMAC-SHA256 Credential=key\//);
    assert.equal(p.headers['cache-control'], 'public, max-age=31536000, immutable');
  }
  assert.equal(videos[0].headers['content-type'], 'video/mp4');
  const csv = readFileSync(join(cwd, 'video-library.csv'), 'utf8').trim().split('\n');
  assert.equal(csv[0], 'Name,Category,Video URL,Poster URL');
  assert.equal(csv.length, 6);
  assert.ok(csv.some((l) => /^Back squat,Lower body,https:\/\/videos\.example\.com\/exercises\/back-squat-[0-9a-f]{10}\.mp4,https:\/\/videos\.example\.com\/exercises\/back-squat-[0-9a-f]{10}\.jpg$/.test(l)), csv.join('\n'));
  assert.match(readFileSync(join(cwd, 'video-upload-report.txt'), 'utf8'), /Same name as another video \(skipped, 1\)/);
  assert.ok(lines.some((l) => /Settings → Exercise library → Import a list/.test(l)));
  // Again: nothing new to send, the same list.
  const before = puts.length;
  const again = await upload([join(dir, 'computer'), join(dir, 'drive'), '--skip-check'], { env: ENV(), log: () => {}, cwd });
  assert.equal(puts.length, before, 'nothing uploaded twice');
  assert.equal(again.uploaded, 0);
  assert.equal(readFileSync(join(cwd, 'video-library.csv'), 'utf8').trim().split('\n').length, 6);
  // A dry run needs no settings and uploads nothing; missing settings are named.
  const dry = await upload([join(dir, 'computer'), '--dry-run'], { env: {}, log: () => {}, cwd });
  assert.equal(dry.uploaded, 0);
  await assert.rejects(upload([join(dir, 'computer'), '--skip-check'], { env: {}, log: () => {}, cwd: mkdtempSync(join(tmpdir(), 'dp-x-')) }), /Missing settings: VIDEO_S3_ENDPOINT/);
  // The list comes into the app.
  const p = await owner('POST', '/v1/exercises/import/preview', { csv: readFileSync(join(cwd, 'video-library.csv'), 'utf8') });
  assert.equal(p.status, 200, p.text);
  assert.deepEqual([p.body.new, p.body.new_with_video, p.body.problem_count, p.body.ready], [5, 5, 0, true]);
  const s = await owner('POST', '/v1/exercises/import', { csv: readFileSync(join(cwd, 'video-library.csv'), 'utf8') });
  assert.equal(s.status, 201, s.text);
  const sq = (await owner('GET', '/v1/exercises?q=back squat')).body.data[0];
  assert.equal(sq.category, 'Lower body');
  assert.match(sq.video_url, /^https:\/\/videos\.example\.com\/exercises\/back-squat-/);
  assert.match(sq.poster_url, /\.jpg$/);
  rmSync(cwd, { recursive: true, force: true });
});

test('the import: owner only, checked first, every problem by row and column; names already there are the owner\'s call', async () => {
  const csv = (rows) => `Exercise,Category,Video URL,Poster URL,Cues\n${rows.join('\n')}\n`;
  assert.equal((await coach('POST', '/v1/exercises/import/preview', { csv: csv(['Deadbug,Core,,,']) })).status, 403);
  const before = app.ctx.db.get('SELECT COUNT(*) AS n FROM exercises').n;
  const bad = await owner('POST', '/v1/exercises/import', { csv: csv([
    'Deadbug,Core,https://videos.example.com/x/deadbug.mp4,https://videos.example.com/x/deadbug.jpg,Low back down',
    'deadbug,Core,,,',
    ',Core,,,',
    'Bird dog,Core,http://videos.example.com/bird.mp4,,',
    'Hollow hold,Core,https://videos.example.com/hollow.pdf,,',
    'Side plank,Core,https://videos.example.com/side.mp4,https://videos.example.com/side.gif,'
  ]) });
  assert.equal(bad.status, 400);
  const probs = bad.body.error.details.problems;
  assert.deepEqual(probs.map((x) => [x.row, x.column]), [[3, 'Exercise'], [4, 'Exercise'], [5, 'Video URL'], [6, 'Video URL'], [7, 'Poster URL']]);
  assert.match(probs[0].message, /also on row 2/);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM exercises').n, before, 'nothing saved');

  // Names already in the library: left alone, given a video where they have none, or given the new video.
  const good = csv(['Deadbug,Core,https://videos.example.com/x/deadbug.mp4,https://videos.example.com/x/deadbug.jpg,"Low back down, slow"', 'Back squat,Lower body,https://videos.example.com/x/new-squat.mp4,,', 'Bear crawl,Crawling,,,']);
  const p = (await owner('POST', '/v1/exercises/import/preview', { csv: good })).body;
  assert.deepEqual([p.new, p.skipped, p.updated], [2, 1, 0]);
  assert.ok(p.notes.some((n) => /1 category isn't one of/.test(n)), 'Crawling isn\'t a category: it comes in with none');
  assert.equal((await owner('POST', '/v1/exercises/import', { csv: good })).status, 201);
  assert.equal((await owner('GET', '/v1/exercises?q=Bear crawl')).body.data[0].category, null);
  assert.equal((await owner('GET', '/v1/exercises?q=Deadbug')).body.data[0].instructions, 'Low back down, slow');
  const again = (await owner('POST', '/v1/exercises/import/preview', { csv: good, existing: 'add_video' })).body;
  assert.deepEqual([again.new, again.updated, again.ready], [0, 0, false], 'they all have a video already');
  const replace = await owner('POST', '/v1/exercises/import', { csv: good, existing: 'replace_video' });
  assert.equal(replace.status, 201, replace.text);
  assert.equal(replace.body.updated, 1, 'only the back squat has a different video');
  const sq = (await owner('GET', '/v1/exercises?q=back squat')).body.data[0];
  assert.deepEqual([sq.video_url, sq.poster_url], ['https://videos.example.com/x/new-squat.mp4', null]);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM exercises WHERE name = ? COLLATE NOCASE', 'back squat').n, 1, 'never a second Back squat');
});

test('a new video link drops the old still unless a new one comes with it', async () => {
  const e = (await owner('POST', '/v1/exercises', { name: 'Pogo hops', video_url: 'https://videos.example.com/pogo.mp4', poster_url: 'https://videos.example.com/pogo.jpg' })).body;
  assert.equal(e.poster_url, 'https://videos.example.com/pogo.jpg');
  assert.equal((await owner('PATCH', `/v1/exercises/${e.id}`, { instructions: 'Quick off the floor' })).body.poster_url, 'https://videos.example.com/pogo.jpg');
  assert.equal((await owner('PATCH', `/v1/exercises/${e.id}`, { video_url: 'https://youtu.be/abc123' })).body.poster_url, null);
  assert.ok(existsSync(join(process.cwd(), 'tools', 'upload-videos.mjs')));
});

test('a version 47 database gains the still-picture column, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v47.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 47');
    old.exec(`INSERT INTO exercises (id, name, video_url, created_at) VALUES ('ex_1', 'Back squat', 'https://youtu.be/x', '2026-09-01T00:00:00Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 48, `round ${round}`);
      assert.ok(d.all('PRAGMA table_info(exercises)').some((c) => c.name === 'poster_url'));
      assert.deepEqual({ ...d.get(`SELECT name, video_url, poster_url FROM exercises WHERE id = 'ex_1'`) }, { name: 'Back squat', video_url: 'https://youtu.be/x', poster_url: null });
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
