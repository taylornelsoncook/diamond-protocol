import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { signPayload } from '../src/services/events.js';

let app, base, cookie, hookServer, hookUrl;
const received = [];

async function call(method, path, body, { auth = 'session', headers = {} } = {}) {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  if (auth === 'session' && cookie) h.cookie = cookie;
  if (auth && auth.startsWith?.('dp_live_')) h.authorization = `Bearer ${auth}`;
  const res = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  return { status: res.status, body: json, res };
}
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  hookServer = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { received.push({ headers: req.headers, body: data }); res.end('ok'); });
  });
  await new Promise((r) => hookServer.listen(0, r));
  hookUrl = `http://localhost:${hookServer.address().port}/hook`;
});
after(() => { app.server.close(); hookServer.close(); });

test('rejects bad logins and protects the API', async () => {
  assert.equal((await call('POST', '/auth/login', { email: 'coach@test.dev', password: 'wrong' }, { auth: null })).status, 401);
  assert.equal((await call('GET', '/v1/clients', null, { auth: null })).status, 401);
  const ok = await call('POST', '/auth/login', { email: 'coach@test.dev', password: 'correct-horse-battery' }, { auth: null });
  assert.equal(ok.status, 200);
  cookie = ok.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/auth/me')).body.user.email, 'coach@test.dev');
});

test('blocks cookie-authenticated writes from other sites', async () => {
  const r = await call('POST', '/v1/plans', { name: 'X', price_cents: 1 }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

let plan, program, workout, client;

test('builds a program with workouts and exercises', async () => {
  plan = (await call('POST', '/v1/plans', { name: 'Coaching', price_cents: 14900, trial_days: 7 })).body;
  assert.equal(plan.price_cents, 14900);
  program = (await call('POST', '/v1/programs', { name: 'Strength', weeks: 4 })).body;
  const ex = (await call('POST', '/v1/exercises', { name: 'Goblet squat', video_url: 'https://www.youtube.com/watch?v=abc123' })).body;
  workout = (await call('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Lower body' })).body;
  workout = (await call('POST', `/v1/workouts/${workout.id}/exercises`, { exercise_id: ex.id, prescription: '3 × 10' })).body;
  assert.equal(workout.exercises.length, 1);
  assert.equal((await call('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Dup' })).status, 409);
  assert.equal((await call('POST', `/v1/programs/${program.id}/workouts`, { week: 9, day: 1, title: 'Too far' })).status, 400);
});

test('webhooks receive signed events', async () => {
  const ep = (await call('POST', '/v1/webhooks', { url: hookUrl, events: ['client.created', 'invoice.payment_failed', 'workout.completed'] })).body;
  assert.match(ep.secret, /^whsec_/);
  client = (await call('POST', '/v1/clients', { name: 'Maya Okafor', email: 'maya@example.com', plan_id: plan.id, program_id: program.id })).body;
  await call('POST', `/v1/clients/${client.id}/card/test`);         // members pay with a saved card
  await new Promise((r) => setTimeout(r, 300));
  const got = received.find((x) => JSON.parse(x.body).type === 'client.created');
  assert.ok(got, 'client.created was delivered');
  const [, t, sig] = got.headers['dp-signature'].match(/t=(\d+),v1=(\w+)/);
  assert.equal(signPayload(ep.secret, got.body, Number(t)), `t=${t},v1=${sig}`);
});

test('new clients start on a trial with their program and app link', async () => {
  assert.equal(client.status, 'trialing');
  assert.equal(client.program.name, 'Strength');
  assert.match(client.app_link, /^\/app\?token=/);
  assert.equal((await call('POST', '/v1/clients', { name: 'Dup', email: 'MAYA@example.com' })).status, 409);
  assert.equal((await call('POST', '/v1/clients', { name: 'No email' })).body.error.message, 'email is required.');
});

test('billing: trial converts, failed card goes past due, retry recovers', async () => {
  let run = (await call('POST', '/v1/billing/run', { as_of: days(8) })).body;
  assert.equal(run.renewed, 1); assert.equal(run.paid, 1);
  assert.equal((await call('GET', `/v1/clients/${client.id}`)).body.status, 'active');

  await call('PATCH', `/v1/clients/${client.id}`, { card_status: 'declining' });
  run = (await call('POST', '/v1/billing/run', { as_of: days(40) })).body;
  assert.equal(run.failed, 1);
  assert.equal((await call('GET', `/v1/clients/${client.id}`)).body.status, 'past_due');
  const dash = (await call('GET', '/v1/dashboard')).body;
  assert.equal(dash.metrics.past_due_clients, 1);
  const failed = dash.attention.find((a) => a.kind === 'payment_failed');
  assert.equal((await call('POST', `/v1/invoices/${failed.invoice_id}/retry`)).body.status, 'failed');

  await call('PATCH', `/v1/clients/${client.id}`, { card_status: 'ok' });
  assert.equal((await call('POST', `/v1/invoices/${failed.invoice_id}/retry`)).body.status, 'paid');
  assert.equal((await call('GET', `/v1/clients/${client.id}`)).body.status, 'active');
  assert.equal((await call('GET', '/v1/dashboard')).body.metrics.mrr_cents, 14900);
});

test('billing: five failed charges cancel the subscription', async () => {
  const c = (await call('POST', '/v1/clients', { name: 'Sam', email: 'sam@example.com', plan_id: plan.id })).body;
  await call('POST', `/v1/clients/${c.id}/card/test`);
  await call('PATCH', `/v1/clients/${c.id}`, { card_status: 'declining' });
  for (const d of [8, 11, 14, 17]) await call('POST', '/v1/billing/run', { as_of: days(d) });
  assert.equal((await call('GET', `/v1/clients/${c.id}`)).body.status, 'past_due', 'four declines: locked out, not canceled yet');
  await call('POST', '/v1/billing/run', { as_of: days(20) });
  assert.equal((await call('GET', `/v1/clients/${c.id}`)).body.status, 'canceled');
});

test('pause locks the client app; resume charges and unlocks', async () => {
  const token = client.app_link.split('token=')[1];
  const home = async () => (await call('GET', '/app/api/home', null, { auth: null, headers: { 'x-client-token': token } })).body;
  assert.equal((await home()).workout.title, 'Lower body');
  await call('POST', `/v1/clients/${client.id}/subscription/pause`);
  assert.equal((await home()).locked, true);
  const resumed = (await call('POST', `/v1/clients/${client.id}/subscription/resume`)).body;
  assert.equal(resumed.status, 'active');
  assert.equal((await home()).locked, false);
});

test('clients log workouts from their app link', async () => {
  const token = client.app_link.split('token=')[1];
  const hdr = { 'x-client-token': token };
  assert.equal((await call('GET', '/app/api/home', null, { auth: null, headers: { 'x-client-token': 'nope' } })).status, 401);
  const r = await call('POST', `/app/api/workouts/${workout.id}/complete`, { exercise_ids: [workout.exercises[0].id] }, { auth: null, headers: hdr });
  assert.equal(r.status, 201);
  assert.equal(r.body.next.progress.completed, 1);
  assert.equal((await call('POST', `/app/api/workouts/${workout.id}/complete`, {}, { auth: null, headers: hdr })).status, 409);
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(received.some((x) => JSON.parse(x.body).type === 'workout.completed'));
});

test('API keys work for data but not for managing keys, and revoke instantly', async () => {
  const key = (await call('POST', '/v1/api-keys', { label: 'Website' })).body;
  assert.match(key.secret, /^dp_live_/);
  assert.equal((await call('GET', '/v1/clients', null, { auth: key.secret })).body.data.length, 2);
  assert.equal((await call('GET', '/v1/api-keys', null, { auth: key.secret })).status, 401);
  assert.equal((await call('GET', '/v1/api-keys')).body.data[0].secret, undefined);
  await call('POST', `/v1/api-keys/${key.id}/revoke`);
  assert.equal((await call('GET', '/v1/clients', null, { auth: key.secret })).status, 401);
});

test('publishes an OpenAPI spec and rejects bad input cleanly', async () => {
  const spec = (await call('GET', '/v1/openapi.json', null, { auth: null })).body;
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/v1/clients'].post);
  const r = await fetch(base + '/v1/plans', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(r.status, 400);
  assert.equal((await call('POST', '/v1/webhooks', { url: 'ftp://x', events: ['*'] })).status, 400);
  assert.equal((await fetch(base + '/../src/db.js')).status, 404);
});
