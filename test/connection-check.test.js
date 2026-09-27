// The owner's connection check in Staff & security: what the hosting proxy sent, which address the app decided on,
// and one sentence on whether TRUST_PROXY is right.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits, connectionCheck, addressKind } from '../src/services/security.js';

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
    assert.match((await get()).guidance, /private address inside the hosting network, not yours: raise TRUST_PROXY to 2 and the app would pick 198\.51\.100\.7/);
    process.env.TRUST_PROXY = '3';
    assert.match((await get()).guidance, /lower TRUST_PROXY to 2/);
    delete headers['x-forwarded-for'];
    assert.match((await get()).guidance, /no X-Forwarded-For header arrived/);
  } finally { delete process.env.TRUST_PROXY; resetRateLimits(); }
});

// Render fronts every service with Cloudflare: the owner's staging check showed their address, then a Cloudflare edge.
test('a Cloudflare edge address means raise TRUST_PROXY, with what each value would pick', async () => {
  const seen = { forwardedFor: '67.176.12.109, 172.71.151.12', socketAddress: '::ffff:10.199.43.147', clientIp: '172.71.151.12', trustProxy: 'true', hops: 1 };
  assert.equal(addressKind('172.71.151.12'), 'cloudflare');
  const c = connectionCheck(seen);
  assert.equal(c.decided_kind, 'cloudflare');
  assert.match(c.guidance, /172\.71\.151\.12, a Cloudflare proxy address, not yours: raise TRUST_PROXY to 2 and the app would pick 67\.176\.12\.109/);
  assert.doesNotMatch(c.guidance, /lower/);
  assert.deepEqual(c.previews, [{ trust_proxy: 1, address: '172.71.151.12', kind: 'cloudflare' }, { trust_proxy: 2, address: '67.176.12.109', kind: 'public' }]);
  // At 2 it's the owner's own address: the usual "compare with what is my IP".
  const right = connectionCheck({ ...seen, clientIp: '67.176.12.109', trustProxy: '2', hops: 2 });
  assert.match(right.guidance, /If 67\.176\.12\.109 is your own internet address.*TRUST_PROXY is set right/);
  // Other ranges and address forms.
  for (const [ip, kind] of [['104.26.1.1', 'cloudflare'], ['104.28.1.1', 'public'], ['162.159.0.1', 'cloudflare'], ['2606:4700::1', 'cloudflare'], ['::ffff:172.68.1.2', 'cloudflare'], ['::ffff:10.1.2.3', 'private'], ['192.168.1.4', 'private'], ['172.20.0.1', 'private'], ['fd00::1', 'private'], ['8.8.8.8', 'public'], ['172.80.0.1', 'public']]) assert.equal(addressKind(ip), kind, ip);
  // A proxy address with nothing to its left: the proxy isn't passing the visitor's address on.
  assert.match(connectionCheck({ forwardedFor: '172.71.151.12', socketAddress: '10.0.0.1', clientIp: '172.71.151.12', trustProxy: 'true', hops: 1 }).guidance, /isn't passing your address along/);
  // Through the API as well, and previews reach the owner.
  try {
    process.env.TRUST_PROXY = 'true';
    const cookie = (await req('POST', '/auth/login', { email: 'owner@test.dev', password: 'owner-password-1' })).cookie;
    const out = (await req('GET', '/v1/staff/connection', null, { cookie, 'x-forwarded-for': '67.176.12.109, 172.71.151.12' })).body;
    assert.equal(out.decided_address, '172.71.151.12');
    assert.match(out.guidance, /raise TRUST_PROXY to 2/);
    assert.equal(out.previews[1].address, '67.176.12.109');
  } finally { delete process.env.TRUST_PROXY; resetRateLimits(); }
});
