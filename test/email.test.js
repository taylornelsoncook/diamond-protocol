// Email delivery: Resend, restricted staging delivery, retries, test email, and when parents see codes on screen.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `dp-email-test-${process.pid}.db`);
process.env.DP_DB = DB_FILE;
for (const k of ['DP_EMAIL_WEBHOOK', 'RESEND_API_KEY', 'DP_EMAIL_ONLY_TO', 'DP_EMAIL_FROM', 'STRIPE_SECRET_KEY']) delete process.env[k];

const { get, run } = require('../server/db');
const seed = require('../server/seed');
const email = require('../server/email');
const { app } = require('../server/index');

// A fake Resend: records requests; fails while `failing` is true.
const received = [];
let failing = false;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ auth: req.headers.authorization, key: req.headers['idempotency-key'], body: JSON.parse(body) });
    if (failing) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"message":"Resend is down"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'em_' + received.length }));
  });
});

let server, base;
test.before(async () => {
  seed.resetDatabase(); seed.base(); seed.demo();
  await new Promise((r) => fake.listen(0, r));
  process.env.RESEND_API_URL = `http://127.0.0.1:${fake.address().port}/emails`;
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server?.close(); fake.close();
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch { /* gone */ } }
});
test.afterEach(() => { for (const k of ['RESEND_API_KEY', 'DP_EMAIL_ONLY_TO', 'DP_EMAIL_FROM']) delete process.env[k]; failing = false; });

async function call(method, url, body, cookie) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
async function owner() {
  const r = await call('POST', '/auth/staff/login', { email: 'owner@demo.test', password: 'demo-owner-2026' });
  return r.res.headers.get('set-cookie').split(';')[0];
}
const until = async (fn) => { for (let i = 0; i < 50; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); };

test('with no provider, emails stay in the outbox and parents see the code on screen', async () => {
  const r = await call('POST', '/auth/parent/code', { email: 'maria.lopez@example.com' });
  assert.match(r.data.test_code, /^\d{6}$/);
  assert.equal(get("SELECT status FROM outbox WHERE to_email='maria.lopez@example.com' ORDER BY id DESC LIMIT 1").status, 'logged');
  assert.equal(email.mode(), 'test');
});

test('with Resend, the code is emailed (branded HTML), not shown', async () => {
  process.env.RESEND_API_KEY = 're_test_123';
  process.env.DP_EMAIL_FROM = 'Diamond Protocol <hello@diamondprotocol.test>';
  const n = received.length;
  const r = await call('POST', '/auth/parent/code', { email: 'kurt.jensen@example.com' });
  assert.equal(r.data.test_code, undefined);
  const msg = await until(() => received[n]);
  assert.equal(msg.auth, 'Bearer re_test_123');
  assert.deepEqual(msg.body.to, ['kurt.jensen@example.com']);
  assert.equal(msg.body.from, 'Diamond Protocol <hello@diamondprotocol.test>');
  assert.match(msg.body.subject, /sign-in code: \d{6}/);
  assert.match(msg.body.html, /logo-320\.png/);
  assert.match(msg.body.text, /works once, for 10 minutes/);
  const row = await until(() => { const x = get("SELECT * FROM outbox WHERE to_email='kurt.jensen@example.com' ORDER BY id DESC LIMIT 1"); return x.status === 'sent' && x; });
  assert.equal(row.provider_id, `em_${n + 1}`);
  assert.equal(msg.key, `dp-outbox-${row.id}`);
});

test('restricted delivery holds other addresses and shows those parents the code', async () => {
  process.env.RESEND_API_KEY = 're_test_123';
  process.env.DP_EMAIL_ONLY_TO = 'owner@demo.test, @mygym.test';
  const n = received.length;
  const r = await call('POST', '/auth/parent/code', { email: 'linh.nguyen@example.com' });
  assert.match(r.data.test_code, /^\d{6}$/);
  assert.equal(get("SELECT status FROM outbox WHERE to_email='linh.nguyen@example.com' ORDER BY id DESC LIMIT 1").status, 'held');
  email.sendEmail('coach@mygym.test', 'Hello', 'Allowed by domain');
  await until(() => received.length > n);
  assert.deepEqual(received[n].body.to, ['coach@mygym.test']);
  assert.equal(email.mode(), 'restricted');
});

test('a failed send is marked failed, then retried until it goes through (max 3 tries)', async () => {
  process.env.RESEND_API_KEY = 're_test_123';
  failing = true;
  const id = email.sendEmail('paulo.silva@example.com', 'Retry me', 'Body');
  const row = await until(() => { const x = get('SELECT * FROM outbox WHERE id=?', id); return x.status === 'failed' && x; });
  assert.match(row.error, /Resend is down/);
  await email.retryFailed();
  assert.equal(get('SELECT attempts FROM outbox WHERE id=?', id).attempts, 2);
  failing = false;
  await email.retryFailed();
  const done = get('SELECT * FROM outbox WHERE id=?', id);
  assert.equal(done.status, 'sent');
  assert.equal(done.error, null);
  run("UPDATE outbox SET status='failed', attempts=3 WHERE id=?", id);
  const before = received.length;
  await email.retryFailed();
  assert.equal(received.length, before, 'gives up after 3 tries');
});

test('owners can send a test email and see the result; coaches cannot', async () => {
  const cookie = await owner();
  let r = await call('POST', '/outbox/test', { to: 'owner@demo.test' }, cookie);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /No email provider/);
  process.env.RESEND_API_KEY = 're_test_123';
  r = await call('POST', '/outbox/test', { to: 'owner@demo.test' }, cookie);
  assert.equal(r.status, 200);
  failing = true;
  r = await call('POST', '/outbox/test', { to: 'owner@demo.test' }, cookie);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Resend is down/);
  const list = await call('GET', '/outbox?limit=5', null, cookie);
  assert.equal(list.data.mode, 'live');
  assert.equal(list.data.items[0].status, 'failed');
  const coach = (await call('POST', '/auth/staff/login', { email: 'coach@demo.test', password: 'demo-coach-2026' })).res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('POST', '/outbox/test', { to: 'x@y.test' }, coach)).status, 403);
});

test('a key pasted with curly quotes or invisible characters still works; a broken key explains itself', async () => {
  const cookie = await owner();
  process.env.RESEND_API_KEY = '“re_test_123​” ';
  process.env.DP_EMAIL_FROM = ' Diamond Protocol <hello@diamondprotocol.test> ';
  const n = received.length;
  let r = await call('POST', '/outbox/test', { to: 'owner@demo.test' }, cookie);
  assert.equal(r.status, 200);
  assert.equal(received[n].auth, 'Bearer re_test_123');
  assert.equal(received[n].body.from, 'Diamond Protocol <hello@diamondprotocol.test>');
  process.env.RESEND_API_KEY = 're_test_12é3';
  r = await call('POST', '/outbox/test', { to: 'owner@demo.test' }, cookie);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /character that isn't part of the key/);
  process.env.RESEND_API_KEY = 'abc123';
  r = await call('POST', '/outbox/test', { to: 'owner@demo.test' }, cookie);
  assert.match(r.data.error, /start with re_/);
});
