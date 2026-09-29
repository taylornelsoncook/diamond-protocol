import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { createJobRunner } from '../src/services/jobs.js';

// Background jobs: run history, error capture, owner alerts, the lease between server copies, and the owner's panel.
let app, base, hawkin, ownerCookie, runner;
const hawkinStatus = { code: 401 };
const call = async (method, path, body, cookie) => {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

before(async () => {
  hawkin = http.createServer((_req, res) => { res.writeHead(hawkinStatus.code, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => hawkin.listen(0, r));
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.com', hawkinBaseUrl: `http://localhost:${hawkin.address().port}` });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'owner2@test.dev', name: 'Oscar Owner', password: 'owner-password-2' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  ownerCookie = (await call('POST', '/auth/login', { email: 'owner@test.dev', password: 'owner-password-1' })).cookie;
  runner = createJobRunner(app.ctx);   // a second runner on the same database, for jobs defined only in these tests
});
after(() => { app.server.close(); hawkin.close(); });

const db = () => app.ctx.db;
const alerts = (job) => db().all('SELECT * FROM outbox WHERE subject LIKE ? ORDER BY created_at, rowid', `%${job}%`);
const runsOf = (job) => db().all('SELECT * FROM job_runs WHERE job = ? ORDER BY started_at, rowid', job);

test('the server registers every background job, once', () => {
  assert.deepEqual(app.ctx.jobs.jobs.map((j) => j.name).sort(), ['billing', 'extend-schedule', 'form-check-cleanup', 'hawkin-sync', 'lead-follow-ups', 'money-checks', 'open-spots', 'review-requests', 'team-billing', 'text-reminders', 'wearable-sync', 'webhooks', 'weekly-digest'].sort());
  assert.throws(() => app.ctx.jobs.define('billing', 1000, () => {}), /Two jobs/);
});

test('runs are recorded: ok with a result, skipped, and failed with the error (async rejections included)', async () => {
  runner.define('t-ok', 60e3, () => ({ made: 3 }));
  runner.define('t-skip', 60e3, async () => ({ skipped: true }));
  runner.define('t-reject', 60e3, async () => { throw new Error('later boom'); });
  assert.equal((await runner.runJob(runner.byName('t-ok'))).status, 'ok');
  assert.equal(runsOf('t-ok')[0].result, '{"made":3}');
  assert.ok(runsOf('t-ok')[0].duration_ms >= 0);
  assert.equal((await runner.runJob(runner.byName('t-skip'))).status, 'skipped');
  const r = await runner.runJob(runner.byName('t-reject'));
  assert.equal(r.status, 'failed');
  assert.match(runsOf('t-reject')[0].error, /later boom/);
});

test('a failure emails each owner once, reminds daily, and says when it recovers', async () => {
  let fail = true;
  runner.define('t-alert', 60e3, () => { if (fail) throw new Error('Card processor unreachable'); return 1; });
  const j = runner.byName('t-alert');
  await runner.runJob(j);
  let sent = alerts('t-alert');
  assert.deepEqual(sent.map((m) => m.to_email).sort(), ['owner2@test.dev', 'owner@test.dev']);
  assert.match(sent[0].subject, /failed: t-alert/);
  assert.match(sent[0].body, /Card processor unreachable/);
  assert.match(sent[0].body, /https:\/\/app\.example\.com\//);
  assert.ok(db().get(`SELECT 1 FROM audit_log WHERE action = 'job failed' AND target = 't-alert'`));

  await runner.runJob(j, { force: true });
  assert.equal(alerts('t-alert').length, 2, 'no second email for the same outage');
  assert.equal(db().get(`SELECT fail_streak FROM job_state WHERE job = 't-alert'`).fail_streak, 2);

  db().run(`UPDATE job_state SET alerted_at = ? WHERE job = 't-alert'`, new Date(Date.now() - 25 * 3600e3).toISOString());
  await runner.runJob(j, { force: true });
  sent = alerts('t-alert');
  assert.equal(sent.length, 4, 'daily reminder while it keeps failing');
  assert.match(sent.at(-1).body, /3 runs in a row/);

  fail = false;
  await runner.runJob(j, { force: true });
  sent = alerts('t-alert');
  assert.match(sent.at(-1).subject, /^Fixed: "t-alert"/);
  const st = db().get(`SELECT * FROM job_state WHERE job = 't-alert'`);
  assert.deepEqual([st.fail_streak, st.alerted_at], [0, null]);
  await runner.runJob(j, { force: true });
  assert.equal(alerts('t-alert').length, sent.length, 'no recovery email when nothing was alerted');
});

test('a job leased by another server copy is skipped until the lease runs out', async () => {
  let n = 0;
  runner.define('t-lease', 15 * 60e3, () => ++n);
  const j = runner.byName('t-lease');
  db().run(`INSERT INTO job_state (job, lease_until, holder) VALUES ('t-lease', ?, 'other-copy')`, new Date(Date.now() + 60e3).toISOString());
  assert.equal(await runner.runJob(j), null);
  assert.equal(n, 0);
  db().run(`UPDATE job_state SET lease_until = ? WHERE job = 't-lease'`, new Date(Date.now() - 1000).toISOString());
  assert.equal((await runner.runJob(j)).status, 'ok');
  assert.equal(db().get(`SELECT holder FROM job_state WHERE job = 't-lease'`).holder, runner.INSTANCE);
  assert.equal(await runner.runJob(j), null, 'the winner holds it for the interval');
  // Two copies sharing the database: a claim is all or nothing.
  const other = createJobRunner(app.ctx);
  other.define('t-lease', 15 * 60e3, () => ++n);
  const at = Date.now() + 20 * 60e3;
  assert.equal(runner.claim(j, at), true);
  assert.equal(other.claim(other.byName('t-lease'), at), false);
  assert.equal(n, 1);
});

test('overlapping runs in one server are skipped', async () => {
  let release;
  runner.define('t-slow', 60e3, () => new Promise((r) => { release = r; }));
  const j = runner.byName('t-slow');
  const first = runner.runJob(j);
  assert.equal(await runner.runJob(j, { force: true }), null);
  release('done');
  assert.equal((await first).status, 'ok');
});

test('quiet jobs record only failures; old runs are pruned', async () => {
  let fail = false;
  runner.define('t-quiet', 15e3, () => { if (fail) throw new Error('endpoint down'); return 0; }, { quiet: true });
  const j = runner.byName('t-quiet');
  await runner.runJob(j, { force: true });
  assert.equal(runsOf('t-quiet').length, 0);
  assert.ok(db().get(`SELECT last_ok_at FROM job_state WHERE job = 't-quiet'`).last_ok_at);
  fail = true;
  await runner.runJob(j, { force: true });
  assert.equal(runsOf('t-quiet')[0].status, 'failed');
  db().run(`INSERT INTO job_runs (id, job, status, started_at) VALUES ('jrun_old', 't-quiet', 'ok', ?)`, new Date(Date.now() - 40 * 86400e3).toISOString());
  runner.prune();
  assert.equal(db().get(`SELECT 1 FROM job_runs WHERE id = 'jrun_old'`), undefined);
});

test('hawkin-sync counts as failed when Hawkin rejects the token, and skipped when not connected', async () => {
  const hawkinJob = app.ctx.jobs.byName('hawkin-sync');
  assert.equal((await app.ctx.jobs.runJob(hawkinJob, { force: true })).status, 'skipped');
  db().run(`INSERT OR REPLACE INTO integrations (provider, status, config, created_at) VALUES ('hawkin', 'connected', ?, ?)`, JSON.stringify({ refresh_token: 'bad', region: 'americas' }), new Date().toISOString());
  const r = await app.ctx.jobs.runJob(hawkinJob, { force: true });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /Hawkin didn't accept that token/);
  assert.equal(db().get(`SELECT status FROM integrations WHERE provider = 'hawkin'`).status, 'error');
  db().run(`DELETE FROM integrations WHERE provider = 'hawkin'`);
});

test('owners see job health and can run a job now; other roles cannot', async () => {
  const list = await call('GET', '/v1/jobs', null, ownerCookie);
  assert.equal(list.status, 200);
  const h = list.body.data.find((j) => j.name === 'hawkin-sync');
  assert.equal(h.health, 'failing');
  assert.match(h.last_error, /Hawkin didn't accept/);
  assert.equal(list.body.data.find((j) => j.name === 'billing').every_seconds, 3600);
  const run = await call('POST', '/v1/jobs/extend-schedule/run', null, ownerCookie);
  assert.equal(run.status, 200);
  assert.deepEqual([run.body.status, run.body.trigger], ['ok', 'manual']);
  assert.equal((await call('POST', '/v1/jobs/nope/run', null, ownerCookie)).status, 404);
  const staff = (await call('POST', '/v1/staff', { name: 'Carl Coach', email: 'carl@test.dev', role: 'coach' }, ownerCookie)).body;
  let coach = (await call('POST', '/auth/login', { email: 'carl@test.dev', password: staff.temporary_password })).cookie;
  await call('POST', '/auth/password', { current_password: staff.temporary_password, new_password: 'carl-new-password' }, coach);
  coach = (await call('POST', '/auth/login', { email: 'carl@test.dev', password: 'carl-new-password' })).cookie;
  assert.equal((await call('GET', '/v1/jobs', null, coach)).status, 403);
  assert.equal((await call('POST', '/v1/jobs/billing/run', null, coach)).status, 403);
});
