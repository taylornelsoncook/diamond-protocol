import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';

let app, base;
before(async () => {
  process.env.TRUST_PROXY = 'true';
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.com' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'owner-password-1' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => { app.server.close(); delete process.env.TRUST_PROXY; });

const https = { 'x-forwarded-proto': 'https' };

test('health check for the hosting platform', async () => {
  const r = await fetch(`${base}/healthz`, { headers: { 'x-forwarded-proto': 'http' } });
  assert.equal(r.status, 200, 'health checks are never redirected');
  assert.equal((await r.json()).ok, true);
});

test('behind the host\'s HTTPS proxy: redirects, secure cookies, strict HTTPS', async () => {
  const plain = await fetch(`${base}/parent?x=1`, { headers: { 'x-forwarded-proto': 'http' }, redirect: 'manual' });
  assert.equal(plain.status, 301);
  assert.equal(plain.headers.get('location'), 'https://app.example.com/parent?x=1');
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { ...https, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.dev', password: 'owner-password-1' }) });
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  assert.match(login.headers.get('strict-transport-security'), /max-age=31536000/);
  // Parent portal writes check the browser's Origin against our own https address.
  const c = await fetch(`${base}/v1/clients`, { method: 'POST', headers: { ...https, cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } }) });
  assert.equal(c.status, 201);
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { ...https, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com' }) })).json()).dev_code;
  const v = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { ...https, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com', code }) });
  const fam = v.headers.get('set-cookie').split(';')[0];
  const sign = (origin) => fetch(`${base}/portal/api/waiver`, { method: 'POST', headers: { ...https, cookie: fam, origin, host: new URL(base).host, 'content-type': 'application/json' }, body: JSON.stringify({ signed_name: 'Maria Lopez', agree: true }) });
  assert.equal((await sign(`https://${new URL(base).host}`)).status, 200, 'same-site https origin is accepted');
  assert.equal((await sign('https://evil.example')).status, 403);
});

function run(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings', 'src/index.js'], { env: { PATH: process.env.PATH, ...env }, cwd: new URL('..', import.meta.url).pathname });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('running at')) p.kill('SIGTERM'); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
    setTimeout(() => p.kill('SIGKILL'), 8000);
  });
}

test('production refuses unsafe settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-prod-'));
  const r = await run({ DP_TEST_MODE: 'false', DB_FILE: join(dir, 'a.db'), PORT: '0', ADMIN_PASSWORD: 'change-me-now' });
  assert.equal(r.code, 1);
  assert.match(r.out, /PUBLIC_URL must be your https:\/\/ address/);
  assert.match(r.out, /ADMIN_PASSWORD is still the sample password/);
});

test('first start on a new server creates the owner, who must pick a new password', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-prod-'));
  const r = await run({ DP_TEST_MODE: 'false', DB_FILE: join(dir, 'b.db'), PORT: '0', PUBLIC_URL: 'https://app.example.com', ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'a-long-first-password', BACKUP_DIR: join(dir, 'backups') });
  assert.match(r.out, /Created the owner account boss@example\.com/);
  assert.match(r.out, /No RESEND_API_KEY/);
  assert.match(r.out, /Backup saved/, 'first backup made at start');
  assert.match(r.out, /SIGTERM received, shutting down/);
  const copy = createApp({ dbFile: join(dir, 'b.db'), jobs: false });
  assert.equal(copy.ctx.db.get(`SELECT must_change_password FROM users WHERE email = 'boss@example.com'`).must_change_password, 1);
  copy.ctx.db.close();
});
