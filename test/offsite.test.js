import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import * as offsite from '../src/services/offsite.js';
import { restore } from '../src/restore-backup.js';

// Off-site backups: encrypted upload, read-back restore check, failure reporting, retries and the restore script.
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_S3_') || k === 'BACKUP_PASSPHRASE') delete process.env[k];

// A tiny S3 stand-in: stores PUT bodies, serves them on GET, and can be told to misbehave.
const store = new Map();
const s3 = { mode: 'ok', requests: [] };
const fake = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    s3.requests.push(`${req.method} ${req.url}`);
    const signed = /^AWS4-HMAC-SHA256 Credential=KEYID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(req.headers.authorization ?? '');
    if (!signed || req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) { res.writeHead(400); return res.end('<Error><Code>BadSignature</Code></Error>'); }
    if (s3.mode === 'denied') { res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>'); }
    if (req.method === 'PUT') { store.set(req.url, body); res.writeHead(200); return res.end(); }
    if (req.method === 'GET' && store.has(req.url)) {
      const b = Buffer.from(store.get(req.url));
      if (s3.mode === 'tamper') b[b.length - 20] ^= 1;
      res.writeHead(200); return res.end(b);
    }
    res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>');
  });
});

let app, base, owner, tmp;
const call = async (method, path, cookie) => {
  const res = await fetch(base + path, { method, headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'dp-offsite-'));
  app = createApp({ testMode: true, jobs: false });
  app.ctx.backupDir = tmp;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  await Promise.all([new Promise((r) => app.server.listen(0, r)), new Promise((r) => fake.listen(0, r))]);
  base = `http://localhost:${app.server.address().port}`;
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.dev', password: 'owner-password-1' }) });
  owner = res.headers.get('set-cookie').split(';')[0];
});
after(() => { app.server.close(); fake.close(); rmSync(tmp, { recursive: true, force: true }); });

function configure() {
  Object.assign(process.env, {
    BACKUP_S3_ENDPOINT: `http://127.0.0.1:${fake.address().port}/`, BACKUP_S3_BUCKET: 'dp-backups',
    BACKUP_S3_KEY_ID: 'KEYID', BACKUP_S3_SECRET: 'SECRET', BACKUP_S3_PREFIX: 'staging/', BACKUP_PASSPHRASE: 'correct horse battery staple'
  });
}
const objectFor = (name) => store.get(`/dp-backups/staging/${name}.enc`);

test('not set up: nothing is sent and the owner is told', async () => {
  assert.equal(offsite.config(), null);
  const b = await call('POST', '/v1/backups', owner);
  assert.equal(b.status, 201);
  assert.equal(b.body.offsite, null);
  assert.equal((await call('GET', '/v1/backups', owner)).body.offsite.configured, false);
  assert.equal(s3.requests.length, 0);
});

test('back up now: an encrypted copy is sent, read back and matches', async () => {
  configure();
  rmSync(join(tmp, (await call('GET', '/v1/backups', owner)).body.data[0].name)); // make room for a fresh one this second
  const b = await call('POST', '/v1/backups', owner);
  assert.equal(b.status, 201);
  assert.deepEqual(b.body.offsite, { ok: true, key: `staging/${b.body.name}.enc` });
  assert.deepEqual(s3.requests.slice(-2), [`PUT /dp-backups/staging/${b.body.name}.enc`, `GET /dp-backups/staging/${b.body.name}.enc`]);

  const stored = objectFor(b.body.name);
  assert.ok(!stored.includes(Buffer.from('SQLite format 3')), 'stored copy is encrypted');
  assert.ok(!stored.includes(Buffer.from('owner@test.dev')), 'no readable personal data in storage');
  assert.ok(offsite.decrypt(stored, process.env.BACKUP_PASSPHRASE).equals(readFileSync(join(tmp, b.body.name))));
  assert.throws(() => offsite.decrypt(stored, 'wrong passphrase'), /wrong passphrase/);

  const st = (await call('GET', '/v1/backups', owner)).body.offsite;
  assert.equal(st.configured, true);
  assert.equal(st.last_ok_name, b.body.name);
  assert.equal(st.last_error, null);
  const before = s3.requests.length;
  assert.equal(await offsite.sendNewest(app.ctx), null, 'already there: the hourly check does not send it again');
  assert.equal(s3.requests.length, before);
});

test('failures are recorded and shown, and the hourly check retries', async () => {
  configure();
  const name = 'diamond-20990101-000000.db';
  copyFileSync(join(tmp, (await call('GET', '/v1/backups', owner)).body.data[0].name), join(tmp, name));
  s3.mode = 'tamper';
  let r = await offsite.sendNewest(app.ctx);
  assert.equal(r.ok, false, 'a copy that does not read back cleanly is not counted');
  let st = (await call('GET', '/v1/backups', owner)).body.offsite;
  assert.match(st.last_error, /could not decrypt/i);
  assert.notEqual(st.last_ok_name, name);

  s3.mode = 'denied';
  assert.match((await offsite.sendNewest(app.ctx)).error, /403 AccessDenied/);

  s3.mode = 'ok';
  r = await offsite.sendNewest(app.ctx);
  assert.equal(r.ok, true);
  st = (await call('GET', '/v1/backups', owner)).body.offsite;
  assert.equal(st.last_ok_name, name);
  assert.equal(st.last_error, null);
});

test('a broken database file is never sent', async () => {
  configure();
  const bad = join(tmp, 'diamond-20990102-000000.db');
  writeFileSync(bad, 'not a database');
  const before = s3.requests.length;
  const r = await offsite.sendNewest(app.ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /does not open as a database/);
  assert.equal(s3.requests.length, before);
  rmSync(bad);
});

test('restore script: from storage and from a downloaded file, checked before writing', async () => {
  configure();
  const name = offsite.status(app.ctx).last_ok_name;
  const out1 = join(tmp, 'restored-1.db');
  await restore([name, out1]);
  assert.ok(readFileSync(out1).equals(readFileSync(join(tmp, name))));
  const copy = createApp({ dbFile: out1, jobs: false });
  assert.equal(copy.ctx.db.get(`SELECT COUNT(*) AS n FROM users WHERE email = 'owner@test.dev'`).n, 1, 'the restored database opens in the app');
  copy.ctx.db.close();

  const downloaded = join(tmp, 'download.db.enc');
  writeFileSync(downloaded, objectFor(name));
  const out2 = join(tmp, 'restored-2.db');
  await restore([downloaded, out2]);
  assert.ok(readFileSync(out2).equals(readFileSync(join(tmp, name))));

  await assert.rejects(restore([downloaded, out2]), /already exists/);
  await assert.rejects(restore(['diamond-20000101-000000.db', join(tmp, 'nope.db')]), /404 NoSuchKey/);
  assert.ok(!existsSync(join(tmp, 'nope.db')));
});

test('the offsite-backup job: skipped when not set up, failed when storage refuses, ok once it works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-offsite-job-'));
  const withFile = createApp({ dbFile: join(dir, 'dp.db'), jobs: false });
  withFile.ctx.backupDir = join(dir, 'backups');
  const job = withFile.ctx.jobs.byName('offsite-backup');
  assert.ok(job, 'registered next to daily-backup');
  await withFile.ctx.jobs.runJob(withFile.ctx.jobs.byName('daily-backup'), { force: true });
  try {
    for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_S3_') || k === 'BACKUP_PASSPHRASE') delete process.env[k];
    assert.equal((await withFile.ctx.jobs.runJob(job, { force: true })).status, 'skipped');
    configure();
    s3.mode = 'denied';
    const failed = await withFile.ctx.jobs.runJob(job, { force: true });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Off-site backup failed: Storage answered 403 AccessDenied/);
    assert.equal(withFile.ctx.db.get(`SELECT fail_streak FROM job_state WHERE job = 'offsite-backup'`).fail_streak, 1, 'counts toward the owner alert');
    s3.mode = 'ok';
    assert.equal((await withFile.ctx.jobs.runJob(job, { force: true })).status, 'ok');
    assert.equal((await withFile.ctx.jobs.runJob(job, { force: true })).status, 'skipped', 'already sent');
  } finally { s3.mode = 'ok'; withFile.ctx.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('request signing matches the AWS Signature V4 reference', () => {
  // Reference value from the aws4 package for this exact request.
  const h = offsite.sign({ method: 'GET', url: 'https://acct.r2.cloudflarestorage.com/my-bucket/diamond-protocol/dp-2026-09-27-120000.db.enc', region: 'us-west-004', keyId: 'AKID', secret: 'SECRET', now: new Date('2026-09-27T12:00:00Z') });
  assert.equal(h['x-amz-date'], '20260927T120000Z');
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKID/20260927/us-west-004/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=ae664f1dbcd67b17ed55bdfb245add57c8af7ad13eb97325a888465ec98f80d2');
});
