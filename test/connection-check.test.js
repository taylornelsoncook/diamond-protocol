// The owner's connection check in Staff & security: what the hosting proxy sent, which address the app decided on,
// and one sentence on whether TRUST_PROXY is right.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';

let app, base, owner, coach, desk;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  coach = await signIn('coach@test.dev', 'coach-password-1');
  desk = await signIn('desk@test.dev', 'desk-password-1');
});
after(() => app.server.close());

test('connection check: owner only, shows what arrived and what the app decided, with one sentence on TRUST_PROXY', async () => {
  assert.equal((await coach('GET', '/v1/staff/connection')).status, 403);
  assert.equal((await desk('GET', '/v1/staff/connection')).status, 403);
  const plain = (await owner('GET', '/v1/staff/connection')).body;
  assert.equal(plain.forwarded_for, null);
  assert.equal(plain.trust_proxy, null);
  assert.match(plain.connection_address, /127\.0\.0\.1|::1/);
  assert.equal(plain.decided_address, plain.connection_address);
  assert.match(plain.guidance, /right when nothing sits in front/);
  const headers = { 'x-forwarded-for': '198.51.100.7' };
  const cookie = (await req('POST', '/auth/login', { email: 'owner@test.dev', password: 'owner-password-1' })).cookie;
  const get = async () => (await req('GET', '/v1/staff/connection', null, { cookie, ...headers })).body;
  assert.match((await get()).guidance, /TRUST_PROXY is off.*set TRUST_PROXY to 1 if 198\.51\.100\.7 is your own/);
  try {
    process.env.TRUST_PROXY = 'true';
    const on = await get();
    assert.equal(on.decided_address, '198.51.100.7');
    assert.equal(on.trust_proxy, 'true');
    assert.match(on.guidance, /If 198\.51\.100\.7 is your own internet address.*TRUST_PROXY is set right/);
    headers['x-forwarded-for'] = '198.51.100.7, 10.0.0.4';
    assert.match((await get()).guidance, /private address.*raise TRUST_PROXY by one \(to 2\)/);
    process.env.TRUST_PROXY = '3';
    assert.match((await get()).guidance, /lower TRUST_PROXY to 2/);
    delete headers['x-forwarded-for'];
    assert.match((await get()).guidance, /no X-Forwarded-For header arrived/);
  } finally { delete process.env.TRUST_PROXY; resetRateLimits(); }
});
