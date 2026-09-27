import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';

// Monthly memberships started at the counter: owners create them, front desk can start one on a saved card.
let app, base;
const tokens = {};
const call = async (method, path, body, who = 'owner') => {
  const headers = { authorization: `Bearer ${tokens[who]}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const login = async (email, password) => (await (await fetch(base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token;

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  tokens.owner = await login('owner@test.dev', 'owner-password-1');
  tokens.desk = await login('desk@test.dev', 'desk-password-1');
  tokens.coach = await login('coach@test.dev', 'coach-password-1');
});
after(() => app.server.close());

test('only owners create memberships; everyone at the counter sees them', async () => {
  assert.equal((await call('POST', '/v1/plans', { name: 'Desk plan', price_cents: 5000 }, 'desk')).status, 403);
  assert.equal((await call('POST', '/v1/plans', { name: 'Coach plan', price_cents: 5000 }, 'coach')).status, 403);
  const p = await call('POST', '/v1/plans', { name: 'Unlimited group training', price_cents: 18900, trial_days: 7 });
  assert.equal(p.status, 201);
  const seen = await call('GET', '/v1/plans', null, 'desk');
  assert.ok(seen.body.data.find((x) => x.name === 'Unlimited group training'));
});

test('front desk starts a membership on a saved card, but cannot pause or cancel it', async () => {
  const plan = (await call('POST', '/v1/plans', { name: 'Eight a month', price_cents: 13900, trial_days: 0 })).body;
  const client = (await call('POST', '/v1/clients', { name: 'Nora Card', email: 'nora@example.com' }, 'desk')).body;
  // No card yet: the first charge can't go through.
  const noCard = await call('POST', `/v1/clients/${client.id}/subscription`, { plan_id: plan.id }, 'desk');
  assert.ok(noCard.status === 201 || noCard.status >= 400);
  if (noCard.status === 201) assert.notEqual(noCard.body.status, 'active', 'no card means the first charge fails');
  const other = (await call('POST', '/v1/clients', { name: 'Tess Family', email: 'tess@example.com' }, 'desk')).body;
  assert.equal((await call('POST', `/v1/clients/${other.id}/card/test`, {}, 'desk')).status, 200);
  const sub = await call('POST', `/v1/clients/${other.id}/subscription`, { plan_id: plan.id }, 'desk');
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.status, 'active');
  assert.equal((await call('POST', `/v1/clients/${other.id}/subscription/cancel`, {}, 'desk')).status, 403);
  assert.equal((await call('POST', `/v1/clients/${other.id}/subscription`, { plan_id: plan.id }, 'desk')).status, 409, 'one membership at a time');
});

test('a plan with a free trial starts without charging', async () => {
  const plan = (await call('GET', '/v1/plans')).body.data.find((x) => x.name === 'Unlimited group training');
  const client = (await call('POST', '/v1/clients', { name: 'Ava Lopez', email: 'ava@example.com' }, 'coach')).body;
  await call('POST', `/v1/clients/${client.id}/card/test`, {}, 'coach');
  const sub = await call('POST', `/v1/clients/${client.id}/subscription`, { plan_id: plan.id }, 'coach');
  assert.equal(sub.status, 201);
  assert.equal(sub.body.status, 'trialing');
  assert.ok(sub.body.trial_ends_at);
});
