import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';

// The help sentences (owner's ask): the dashboard shows them to the owner only, and the owner can turn them off in
// Settings (setting help_text). /auth/me says whether this sign-in gets them.
let app, base, owner, coach;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev');
});
after(() => app.server.close());

test('the owner sees the help sentences until they turn them off; a coach never does', async () => {
  assert.equal((await owner('GET', '/auth/me')).body.help_text, 'on');
  assert.equal((await coach('GET', '/auth/me')).body.help_text, 'off');
  assert.equal((await owner('GET', '/v1/settings')).body.help_text, 'on');
  assert.equal((await owner('PATCH', '/v1/settings', { help_text: 'off' })).status, 200);
  assert.equal((await owner('GET', '/auth/me')).body.help_text, 'off');
  assert.equal((await owner('PATCH', '/v1/settings', { help_text: 'sometimes' })).status, 400);
  assert.equal((await owner('PATCH', '/v1/settings', { help_text: 'on' })).status, 200);
  assert.equal((await owner('GET', '/auth/me')).body.help_text, 'on');
  assert.equal((await coach('GET', '/auth/me')).body.help_text, 'off', 'the setting is the owner\'s alone');
  assert.equal((await coach('PATCH', '/v1/settings', { help_text: 'on' })).status, 403, 'only the owner changes settings');
});
