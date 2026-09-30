// The family account's Workout tab: a signed-in parent opens the athlete app for one of their own athletes
// (/app?athlete=<id>, requests carry x-athlete-id with the portal cookie). Only their own, never archived, writes only
// from this site; the app page may be framed by our own pages and nothing else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

let app, base, owner, maria, ava, ben, stranger;
const req = async (method, path, body, headers = {}) => {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})), res };
};
const cookieOf = (r) => r.res.headers.get('set-cookie').split(';')[0];
const signIn = async (email) => {
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await req('POST', '/portal/api/login', { email })).body.dev_code;
  return cookieOf(await req('POST', '/portal/api/verify', { email, code }));
};

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const login = await req('POST', '/auth/login', { email: 'owner@test.dev', password: 'correct-horse-battery' });
  owner = (m, p, b) => req(m, p, b, { cookie: cookieOf(login), origin: base });
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2012-03-10', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Ben Lopez', birth_date: '2016-06-01' })).body;
  stranger = (await owner('POST', '/v1/clients', { name: 'Zed Other', birth_date: '2011-01-01', parent: { name: 'Pat Other', email: 'pat@example.com' } })).body;
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  for (const c of [ava, ben]) app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, newId('sub'), c.id, plan.id, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', app.ctx.now(), app.ctx.now());
  maria = await signIn('maria@example.com');
});
after(() => app.server.close());

test('a parent opens the app for their own athlete, by header or by query, and never for anyone else', async () => {
  const mine = await req('GET', '/app/api/home', null, { cookie: maria, 'x-athlete-id': ava.id });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.client.id, ava.id);
  const byQuery = await req('GET', `/app/api/home?athlete=${ben.id}`, null, { cookie: maria });
  assert.equal(byQuery.body.client.id, ben.id, 'the second child too');
  const other = await req('GET', '/app/api/home', null, { cookie: maria, 'x-athlete-id': stranger.id });
  assert.equal(other.status, 401);
  assert.equal(other.body.error.code, 'not_your_athlete');
  assert.equal((await req('GET', '/app/api/home', null, { cookie: maria, 'x-athlete-id': 'cli_nope' })).status, 401);
  assert.equal((await req('GET', '/app/api/home', null, { cookie: maria })).status, 401, 'a parent alone has no workouts of their own');
  assert.equal((await req('GET', '/app/api/home', null, { 'x-athlete-id': ava.id })).status, 401, 'the header alone is nothing without the cookie');
  // Writes from another site are refused; from this site they go through, as the athlete.
  assert.equal((await req('POST', '/app/api/messages', { body: 'hi' }, { cookie: maria, 'x-athlete-id': ava.id, origin: 'https://evil.example' })).status, 403);
  const own = await req('POST', '/app/api/messages', { body: 'hi from the family account' }, { cookie: maria, 'x-athlete-id': ava.id, origin: base });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.client_id ?? ava.id, ava.id);
});

test('an archived athlete is closed to the family account too', async () => {
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), ben.id);   // straight in the database: archiving refuses a member
  assert.equal((await req('GET', '/app/api/home', null, { cookie: maria, 'x-athlete-id': ben.id })).status, 401);
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', ben.id);
  assert.equal((await req('GET', '/app/api/home', null, { cookie: maria, 'x-athlete-id': ben.id })).status, 200);
});

test('the app page may sit inside our own pages; every other page stays unframeable', async () => {
  const appPage = await fetch(`${base}/app`);
  assert.match(appPage.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  const portal = await fetch(`${base}/portal`);
  assert.match(portal.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const book = await fetch(`${base}/book`);
  assert.match(book.headers.get('content-security-policy'), /frame-ancestors \*/);
});
