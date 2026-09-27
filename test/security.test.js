import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';

let app, base;
const call = async (method, path, body, cookie) => {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const signIn = async (email, password) => (await call('POST', '/auth/login', { email, password }));
let owner, coachC, deskC, coachId, deskId, deskPw;

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  app.ctx.backupDir = mkdtempSync(join(tmpdir(), 'dp-backups-'));
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = (await signIn('owner@test.dev', 'owner-password-1')).cookie;
});
after(() => app.server.close());

test('owners add staff with a one-time password they must change', async () => {
  const c = (await call('POST', '/v1/staff', { name: 'Carl Coach', email: 'carl@test.dev', role: 'coach' }, owner)).body;
  assert.equal(c.role, 'coach');
  assert.equal(c.must_change_password, true);
  assert.equal(c.temporary_password.length, 12);
  coachId = c.id;
  const mail = (await call('GET', '/v1/outbox', null, owner)).body.data[0];
  assert.ok(mail.to_email === 'carl@test.dev' && mail.body.includes(c.temporary_password));
  const d = (await call('POST', '/v1/staff', { name: 'Dana Desk', email: 'dana@test.dev', role: 'front_desk' }, owner)).body;
  deskId = d.id; deskPw = d.temporary_password;
  assert.equal((await call('POST', '/v1/staff', { name: 'X', email: 'carl@test.dev', role: 'coach' }, owner)).status, 409);

  const first = await signIn('carl@test.dev', c.temporary_password);
  assert.equal(first.body.user.must_change_password, true);
  coachC = first.cookie;
  const blocked = await call('GET', '/v1/clients', null, coachC);
  assert.deepEqual([blocked.status, blocked.body.error.code], [403, 'password_change_required']);
  assert.equal((await call('POST', '/auth/password', { current_password: 'wrong', new_password: 'carl-new-password' }, coachC)).status, 400);
  assert.equal((await call('POST', '/auth/password', { current_password: c.temporary_password, new_password: 'short' }, coachC)).status, 400);
  assert.equal((await call('POST', '/auth/password', { current_password: c.temporary_password, new_password: 'carl-new-password' }, coachC)).status, 200);
  assert.equal((await call('GET', '/v1/clients', null, coachC)).status, 200);
  deskC = (await signIn('dana@test.dev', deskPw)).cookie;
  await call('POST', '/auth/password', { current_password: deskPw, new_password: 'dana-new-password' }, deskC);
});

test('coaches run the gym but never see money, staff or keys', async () => {
  const ok = async (m, p, b) => assert.notEqual((await call(m, p, b, coachC)).status, 403, `${m} ${p} should be allowed`);
  const no = async (m, p, b) => { const r = await call(m, p, b, coachC); assert.equal(r.status, 403, `${m} ${p} should be refused`); assert.match(r.body.error.message, /Your role \(Coach\) can't do this/); };
  const client = (await call('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } }, coachC)).body;
  assert.ok(client.athlete_id);
  await ok('GET', `/v1/clients/${client.id}`); await ok('GET', '/v1/plans'); await ok('GET', '/v1/tests'); await ok('GET', '/v1/schedule'); await ok('POST', '/v1/results', { client_id: client.id, test: 'dash_40yd', value: 5.9 });
  await no('GET', '/v1/invoices'); await no('POST', '/v1/plans', { name: 'X', price_cents: 100 }); await no('GET', '/v1/reports/revenue'); await no('GET', '/v1/team-contracts');
  await no('POST', '/v1/api-keys', { label: 'x' }); await no('GET', '/v1/staff'); await no('GET', '/v1/audit'); await no('POST', '/v1/backups'); await no('PATCH', '/v1/settings', { late_cancel_hours: 1 });
  await no('POST', '/v1/sales/sale_x/refund', {}); await no('PUT', '/v1/integrations/hawkin', { refresh_token: 'x' });
  const dash = (await call('GET', '/v1/dashboard', null, coachC)).body;
  assert.equal(dash.metrics.mrr_cents, undefined);
  assert.equal(dash.today_sales, null);
  assert.ok((await call('GET', '/v1/dashboard', null, owner)).body.metrics.mrr_cents !== undefined);
});

test('front desk: check-ins, sales, bookings and results only', async () => {
  const ok = async (m, p, b) => assert.notEqual((await call(m, p, b, deskC)).status, 403, `${m} ${p} should be allowed`);
  const no = async (m, p, b) => assert.equal((await call(m, p, b, deskC)).status, 403, `${m} ${p} should be refused`);
  const kid = (await call('POST', '/v1/clients', { name: 'Ben Lopez', email: 'ben@example.com' }, deskC)).body;
  await ok('GET', '/v1/clients'); await ok('GET', '/v1/agenda'); await ok('POST', `/v1/clients/${kid.id}/check-ins`, { location_id: 'loc_x' }); await ok('POST', '/v1/results', { client_id: kid.id, test: 'vertical_standing', value: 18 });
  await no('POST', '/v1/class-series', { name: 'X' }); await no('POST', '/v1/locations', { name: 'X' }); await no('POST', '/v1/products', { name: 'X' }); await no('POST', `/v1/clients/${kid.id}/credits`, { delta: 5 });
  await no('POST', '/v1/imports', { csv: 'a' }); await no('POST', '/v1/queue/link', {}); await no('POST', '/v1/programs', { name: 'X' }); await no('GET', '/v1/invoices');
});

test('five wrong passwords lock the account until it times out or an owner unlocks it', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await signIn('carl@test.dev', 'nope-nope-nope')).status, 401);
  const locked = await signIn('carl@test.dev', 'carl-new-password');
  assert.deepEqual([locked.status, locked.body.error.code], [429, 'account_locked']);
  assert.equal((await call('GET', '/v1/staff', null, owner)).body.data.find((u) => u.id === coachId).locked, true);
  await call('PATCH', `/v1/staff/${coachId}`, { unlock: true }, owner);
  const back = await signIn('carl@test.dev', 'carl-new-password');
  assert.equal(back.status, 200);
  coachC = back.cookie;
});

test('turning an account off ends its sessions at once; there is always an owner', async () => {
  assert.equal((await call('GET', '/v1/clients', null, deskC)).status, 200);
  await call('PATCH', `/v1/staff/${deskId}`, { active: false }, owner);
  assert.equal((await call('GET', '/v1/clients', null, deskC)).status, 401);
  assert.match((await signIn('dana@test.dev', 'dana-new-password')).body.error.message, /turned off/);
  const me = (await call('GET', '/auth/me', null, owner)).body.user;
  assert.equal((await call('PATCH', `/v1/staff/${me.id}`, { role: 'coach' }, owner)).status, 409, 'can\'t remove the only owner');
  assert.equal((await call('PATCH', `/v1/staff/${me.id}`, { active: false }, owner)).status, 409);
  await call('PATCH', `/v1/staff/${coachId}`, { role: 'front_desk' }, owner);
  assert.equal((await call('GET', '/v1/clients', null, coachC)).status, 401, 'a role change signs them out');
  const reset = (await call('POST', `/v1/staff/${coachId}/reset-password`, null, owner)).body;
  assert.equal((await signIn('carl@test.dev', reset.temporary_password)).body.user.must_change_password, true);
});

test('the audit log records every change and sign-in, never the data itself', async () => {
  const log = (await call('GET', '/v1/audit?limit=500', null, owner)).body.data;
  const created = log.find((e) => e.action === 'POST /v1/clients' && e.actor_name === 'Carl Coach');
  assert.deepEqual([created.role, created.status, created.actor_type], ['coach', 201, 'staff']);
  assert.ok(log.some((e) => e.action === 'sign-in' && e.status === 401 && e.actor_name === 'carl@test.dev'), 'failed sign-ins');
  assert.ok(log.some((e) => e.action === 'sign-in' && e.status === 429), 'locked-out attempts');
  assert.ok(log.some((e) => e.action === 'PATCH /v1/staff/:id' && e.target === deskId));
  assert.ok(log.some((e) => e.status === 403 && e.actor_name === 'Carl Coach'), 'refused attempts are logged too');
  assert.ok(!JSON.stringify(log).includes('maria@example.com'), 'request bodies are not stored');
  assert.ok((await call('GET', '/v1/audit?failures=true', null, owner)).body.data.every((e) => e.status >= 400));
});

test('backups: a consistent copy of the database, downloadable by the owner', async () => {
  const b = (await call('POST', '/v1/backups', null, owner)).body;
  assert.match(b.name, /^diamond-\d{8}-\d{6}\.db$/);
  assert.ok(b.bytes > 10000);
  const list = (await call('GET', '/v1/backups', null, owner)).body;
  assert.equal(list.data[0].name, b.name);
  const file = await call('GET', `/v1/backups/${b.name}`, null, owner);
  assert.equal(file.status, 200);
  assert.equal(file.body.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await call('GET', '/v1/backups/..%2Fsecrets', null, owner)).status, 400);
  const copy = createApp({ dbFile: join(list.dir, b.name), jobs: false });
  assert.ok(copy.ctx.db.get(`SELECT COUNT(*) AS n FROM clients WHERE name = 'Ava Lopez'`).n === 1, 'the backup opens and holds the data');
  copy.ctx.db.close();
});

test('too many sign-in attempts from one address are slowed down', async () => {
  resetRateLimits();
  let last;
  for (let i = 0; i < 21; i++) last = await signIn(`nobody${i}@test.dev`, 'whatever-123');
  assert.equal(last.status, 429);
  assert.match(last.body.error.message, /Too many requests/);
  resetRateLimits();
});
