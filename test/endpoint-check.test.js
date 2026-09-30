// The storage address (BACKUP_S3_ENDPOINT, or FORMCHECK_S3_ENDPOINT for clips) has to be the S3 API address itself.
// A wrong one used to fail every off-site send with a bare "Invalid URL" and broke clip uploads the same way; now it's
// named in plain words on the Backups screen and the clips panel, and Send a form check stays hidden until it's right.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { endpointProblem, status, send } from '../src/services/offsite.js';
import { config as clipsConfig } from '../src/services/formchecks.js';

const KEYS = ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_KEY_ID', 'BACKUP_S3_SECRET', 'BACKUP_PASSPHRASE', 'FORMCHECK_S3_BUCKET', 'FORMCHECK_S3_ENDPOINT'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const setEnv = (o) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, o); };

test('the address check says what is wrong in plain words', () => {
  assert.equal(endpointProblem('https://0123abcd.r2.cloudflarestorage.com'), null);
  assert.equal(endpointProblem('https://0123abcd.r2.cloudflarestorage.com/'), null, 'one trailing slash is fine');
  assert.equal(endpointProblem(''), null, 'not set is a different message');
  assert.match(endpointProblem('0123abcd.r2.cloudflarestorage.com'), /must start with https:\/\//);
  assert.match(endpointProblem('https://0123abcd.r2.cloudflarestorage.com/dp-backups'), /bucket name goes in BACKUP_S3_BUCKET/);
  assert.match(endpointProblem('https://pub-abc.r2.dev'), /public r2\.dev address/);
  assert.match(endpointProblem('https://acct.r2.cloudflarestorage.com dp-backups'), /isn't a valid web address/);
  assert.match(endpointProblem('https://acct.r2.cloudflarestorage.com?x=1'), /extra parts/);
  assert.match(endpointProblem('acct.r2.cloudflarestorage.com', 'FORMCHECK_S3_ENDPOINT'), /^FORMCHECK_S3_ENDPOINT/);
});

test('the off-site status names the bad address and a send records it instead of "Invalid URL"', async () => {
  const app = createApp({ testMode: true, jobs: false });
  try {
    setEnv({ BACKUP_S3_ENDPOINT: 'acct.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'dp-backups', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's', BACKUP_PASSPHRASE: 'a long passphrase here' });
    const st = status(app.ctx);
    assert.equal(st.configured, true);
    assert.match(st.problem, /BACKUP_S3_ENDPOINT isn't a web address/);
    const r = await send(app.ctx, 'diamond-20260929-030000.db');
    assert.equal(r.ok, false);
    assert.match(r.error, /must start with https:\/\//);
    assert.equal(status(app.ctx).last_error, r.error, 'the Backups screen shows the same words');
    setEnv({ BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'dp-backups', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's', BACKUP_PASSPHRASE: 'a long passphrase here' });
    assert.equal(status(app.ctx).problem, null);
  } finally { app.server.close(); }
});

test('the clips bucket is not ready with a bad address, and names the variable it came from', () => {
  setEnv({ BACKUP_S3_ENDPOINT: 'acct.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'dp-backups', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's', FORMCHECK_S3_BUCKET: 'dp-athlete-videos' });
  let c = clipsConfig();
  assert.equal(c.ready, false);
  assert.ok(c.problems.some((p) => /^BACKUP_S3_ENDPOINT isn't a web address/.test(p)), JSON.stringify(c.problems));
  setEnv({ BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'dp-backups', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's', FORMCHECK_S3_BUCKET: 'dp-athlete-videos', FORMCHECK_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/dp-athlete-videos' });
  c = clipsConfig();
  assert.equal(c.ready, false);
  assert.ok(c.problems.some((p) => /^FORMCHECK_S3_ENDPOINT has a path on the end/.test(p)), JSON.stringify(c.problems));
  setEnv({ BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'dp-backups', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's', FORMCHECK_S3_BUCKET: 'dp-athlete-videos' });
  assert.equal(clipsConfig().ready, true);
});
