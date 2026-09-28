// API & integrations (batch B14): key access levels on every route, the request log, webhooks (test events, delivery
// detail, resend, retries, failing, secret rotation, private addresses refused), outbox tools, texts, video coverage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { blockedAddress, deliverPending, listEvents, signPayload } from '../src/services/events.js';
import { createFamilyWithGuardian } from '../src/services/families.js';

let app, base, hook, hookUrl, resend, resendUrl, owner, coach, desk;
const got = [];          // what the webhook receiver was sent
let answer = 200;        // what it answers
let delay = 0;           // and how long it takes
const mails = [];
const req = async (method, path, body, { cookie, key, headers = {} } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const as = (cookie) => (method, path, body, o = {}) => req(method, path, body, { cookie, ...o });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const db = () => app.ctx.db;

before(async () => {
  resetRateLimits();
  hook = http.createServer((q, s) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { got.push({ headers: q.headers, body: b }); setTimeout(() => { s.writeHead(answer, { 'content-type': 'text/plain' }); s.end(answer < 300 ? 'thanks' : 'nope, broken'); }, delay); }); });
  await new Promise((r) => hook.listen(0, r));
  hookUrl = `http://localhost:${hook.address().port}/hooks/dp`;
  resend = http.createServer((q, s) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { mails.push(JSON.parse(b)); s.writeHead(200, { 'content-type': 'application/json' }); s.end('{"id":"re_1"}'); }); });
  await new Promise((r) => resend.listen(0, r));
  resendUrl = `http://127.0.0.1:${resend.address().port}/emails`;
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
after(() => { app.server.close(); hook.close(); resend.close(); });

test('API keys have access levels, enforced on every route; renaming or changing a level keeps the key', async () => {
  const read = (await owner('POST', '/v1/api-keys', { label: 'Website' })).body;
  assert.equal(read.scope, 'read', 'new keys are read only unless the owner chooses more');
  const results = (await owner('POST', '/v1/api-keys', { label: 'Timing gates', scope: 'results' })).body;
  const full = (await owner('POST', '/v1/api-keys', { label: 'CRM', scope: 'full' })).body;
  assert.equal((await owner('POST', '/v1/api-keys', { label: 'Bad', scope: 'admin' })).status, 400);

  assert.equal((await req('GET', '/v1/clients', null, { key: read.secret })).status, 200);
  const refused = await req('POST', '/v1/clients', { name: 'Ava Lopez', email: 'ava@example.com' }, { key: read.secret });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'key_scope']);
  assert.match(refused.body.error.message, /read only/);
  for (const [m, p] of [['POST', '/v1/results'], ['PATCH', '/v1/clients/x'], ['DELETE', '/v1/targets/x'], ['POST', '/v1/imports'], ['PUT', '/v1/courses/x/order']]) {
    assert.equal((await req(m, p, {}, { key: read.secret })).status, 403, `${m} ${p} is refused for a read-only key`);
  }
  // Read and send results: results and device files, nothing else.
  assert.notEqual((await req('POST', '/v1/results', { results: [] }, { key: results.secret })).status, 403);
  assert.notEqual((await req('POST', '/v1/imports', { provider: 'generic', csv: 'x', dry_run: true }, { key: results.secret })).status, 403);
  const r2 = await req('POST', '/v1/clients', { name: 'Ava Lopez', email: 'ava@example.com' }, { key: results.secret });
  assert.deepEqual([r2.status, r2.body.error.code], [403, 'key_scope']);
  assert.equal((await req('POST', '/v1/clients', { name: 'Ava Lopez', email: 'ava@example.com' }, { key: full.secret })).status, 201);
  // No key manages keys, webhooks, staff or the outbox, whatever its level; parent and athlete routes don't take keys.
  for (const p of ['/v1/api-keys', '/v1/webhooks', '/v1/staff', '/v1/outbox', '/v1/audit', '/v1/api-status', '/auth/account', '/portal/api/me']) assert.equal((await req('GET', p, null, { key: full.secret })).status, 401, p);
  assert.equal((await req('GET', '/app/api/home', null, { key: full.secret })).status, 401);

  // Change the level in place: the same secret now reads only. An empty level is refused, never widened.
  const changed = (await owner('PATCH', `/v1/api-keys/${full.id}`, { scope: 'read', label: 'CRM (read)' })).body;
  assert.deepEqual([changed.scope, changed.label], ['read', 'CRM (read)']);
  assert.equal((await req('POST', '/v1/clients', { name: 'Ben Park', email: 'ben@example.com' }, { key: full.secret })).status, 403);
  assert.equal((await owner('PATCH', `/v1/api-keys/${read.id}`, { scope: '' })).status, 400);
  assert.equal((await owner('PATCH', `/v1/api-keys/${read.id}`, { scope: null })).status, 400);
  assert.equal((await owner('GET', '/v1/api-keys')).body.data.find((k) => k.id === read.id).scope, 'read');
  await owner('POST', `/v1/api-keys/${results.id}/revoke`);
  assert.equal((await owner('PATCH', `/v1/api-keys/${results.id}`, { scope: 'full' })).status, 409, 'a revoked key can\'t be widened');
  assert.equal((await req('GET', '/v1/clients', null, { key: results.secret })).status, 401);
});

test('every request made with a key is logged for 30 days: no bodies, no query strings, errors counted', async () => {
  const k = (await owner('POST', '/v1/api-keys', { label: 'Logger', scope: 'read' })).body;
  await req('GET', '/v1/clients?q=secret-search', null, { key: k.secret });
  await req('POST', '/v1/clients', { name: 'Private Name', email: 'private@example.com' }, { key: k.secret });
  await req('GET', '/v1/clients/nope', null, { key: k.secret });
  await new Promise((r) => setTimeout(r, 50));
  const log = (await owner('GET', `/v1/api-keys/${k.id}/requests`)).body;
  assert.equal(log.requests_30d, 3);
  assert.equal(log.errors_30d, 2);
  assert.deepEqual(log.data.map((x) => [x.method, x.path, x.status]), [['GET', '/v1/clients/nope', 404], ['POST', '/v1/clients', 403], ['GET', '/v1/clients', 200]]);
  assert.match(log.data[1].error, /read only/);
  assert.ok(!JSON.stringify(log).includes('secret-search') && !JSON.stringify(log).includes('Private Name'), 'no query string or body');
  const listed = (await owner('GET', '/v1/api-keys')).body.data.find((x) => x.id === k.id);
  assert.deepEqual([listed.requests_30d, listed.errors_30d], [3, 2]);
  assert.equal((await owner('GET', `/v1/api-keys/${k.id}/requests?status=errors`)).body.data.length, 2);
  // Older than 30 days: cleared.
  db().run(`UPDATE api_requests SET at = '2020-01-01T00:00:00.000Z' WHERE key_id = ?`, k.id);
  app.ctx.apiLogPrunedAt = 0;
  await req('GET', '/v1/tests', null, { key: k.secret });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(db().get('SELECT COUNT(*) AS n FROM api_requests WHERE key_id = ?', k.id).n, 1);
  // The key's secret is never in the audit log or the request log.
  assert.ok(!db().all('SELECT * FROM audit_log').some((a) => JSON.stringify(a).includes(k.secret)));
});

test('an athlete\'s results by Athlete ID, with the best marked and since from local midnight', async () => {
  const k = (await owner('POST', '/v1/api-keys', { label: 'Reader' })).body;
  const c = (await owner('POST', '/v1/clients', { name: 'Cora Diaz', email: 'cora@example.com' })).body;
  await owner('POST', '/v1/results', { results: [
    { athlete: { athlete_id: c.athlete_id }, test: 'dash_40yd', value: 5.4, recorded_at: '2026-08-01T15:00:00.000Z' },
    { athlete: { athlete_id: c.athlete_id }, test: 'dash_40yd', value: 5.1, recorded_at: '2026-09-10T15:00:00.000Z' },
    { athlete: { athlete_id: c.athlete_id }, test: 'dash_40yd', value: 5.3, recorded_at: '2026-09-20T15:00:00.000Z' }] });
  const r = (await req('GET', `/v1/athletes/${c.athlete_id.toLowerCase()}/results`, null, { key: k.secret })).body;
  assert.equal(r.athlete.athlete_id, c.athlete_id);
  assert.deepEqual(r.data.map((x) => [x.value, x.best]), [[5.3, false], [5.1, true], [5.4, false]], 'lower is better for a sprint');
  assert.equal((await req('GET', `/v1/athletes/${c.athlete_id}/results?since=2026-09-15`, null, { key: k.secret })).body.data.length, 1);
  assert.equal((await req('GET', `/v1/athletes/${c.athlete_id}/results?since=Sept`, null, { key: k.secret })).status, 400);
  assert.equal((await req('GET', `/v1/athletes/${c.athlete_id}/results?test=nope`, null, { key: k.secret })).status, 400);
  assert.equal((await req('GET', '/v1/athletes/NOBODY2026/results', null, { key: k.secret })).status, 404);
});

test('private network addresses are refused as webhook URLs, when saved and when sent', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1']) {
    assert.equal(blockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) assert.equal(blockedAddress(ip), false, ip);
  const prod = createApp({ testMode: false, jobs: false, publicUrl: 'https://app.example.org' });
  try {
    const { createEndpoint } = await import('../src/services/events.js');
    for (const url of ['https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest/meta-data', 'https://printer.local/x', 'https://intranet/x', 'https://[::ffff:10.0.0.1]/x', 'http://example.com/x']) {
      assert.throws(() => createEndpoint(prod.ctx, { url, events: ['*'] }), /private network|https:\/\//, url);
    }
    assert.throws(() => createEndpoint(prod.ctx, { url: 'https://user:pass@hooks.example.com/x', events: ['*'] }), /user name and password/);
    assert.equal(createEndpoint(prod.ctx, { url: 'https://hooks.example.com/dp', events: ['*'] }).url, 'https://hooks.example.com/dp');
    assert.equal(createApp({ testMode: true, jobs: false, publicUrl: 'https://staging.example.org' }).ctx.allowPrivateWebhooks, false, 'a staging copy (test mode with an address) refuses too');
  } finally { prod.ctx.db.close(); }
  // A name that resolves to a private address at send time is refused too (localhost resolves to 127.0.0.1).
  const ep = (await owner('POST', '/v1/webhooks', { url: hookUrl.replace('/hooks/dp', '/rebind'), events: ['*'] })).body;
  app.ctx.allowPrivateWebhooks = false;
  try {
    const before = got.length;
    const t = (await owner('POST', `/v1/webhooks/${ep.id}/test`, {})).body;
    assert.equal(t.status, 'failed');
    assert.match(t.last_error, /private address/);
    assert.equal(got.length, before, 'nothing reached the private address');
  } finally { app.ctx.allowPrivateWebhooks = true; }
  await owner('DELETE', `/v1/webhooks/${ep.id}`);
});

let ep;
test('webhooks are named, edited, deduplicated and send test events with a sample of any event', async () => {
  ep = (await owner('POST', '/v1/webhooks', { url: hookUrl, events: ['client.created', 'sale.completed'], label: 'Zapier' })).body;
  assert.match(ep.secret, /^whsec_/);
  assert.equal(ep.label, 'Zapier');
  for (const dup of [hookUrl + '/', hookUrl.replace('localhost', 'LOCALHOST')]) {
    const r = await owner('POST', '/v1/webhooks', { url: dup, events: ['*'] });
    assert.deepEqual([r.status, /already sends to that URL \(Zapier\)/.test(r.body.error.message)], [409, true], dup);
  }
  const list = (await owner('GET', '/v1/webhooks')).body.data;
  assert.equal(list[0].secret, undefined, 'the list shows only a hint of the secret');
  assert.match(list[0].secret_hint, /^whsec_.+…/);
  assert.equal((await owner('GET', `/v1/webhooks/${ep.id}/secret`)).body.secret, ep.secret);
  assert.ok(db().get(`SELECT 1 FROM audit_log WHERE action = 'GET /v1/webhooks/:id/secret' AND target = ?`, ep.id), 'showing the secret is logged');

  const edited = (await owner('PATCH', `/v1/webhooks/${ep.id}`, { label: 'Zapier CRM', events: ['client.created', 'sale.completed', 'booking.created'] })).body;
  assert.deepEqual([edited.label, edited.events.length], ['Zapier CRM', 3]);
  const types = (await owner('GET', '/v1/event-types')).body;
  assert.ok(types.data.includes('booking.created'));
  assert.ok(types.data.every((t) => types.info[t].about), 'every event says what it means');

  got.length = 0;
  const ping = (await owner('POST', `/v1/webhooks/${ep.id}/test`, {})).body;
  assert.equal(ping.status, 'succeeded');
  assert.equal(ping.response_code, 200);
  assert.ok(ping.duration_ms >= 0);
  const sent = got.at(-1);
  assert.equal(sent.headers['dp-event'], 'test.ping');
  assert.equal(sent.headers['dp-delivery'], ping.id);
  assert.equal(sent.headers['dp-test'], 'true');
  const [, t, sig] = sent.headers['dp-signature'].match(/^t=(\d+),v1=(\w+)$/);
  assert.equal(signPayload(ep.secret, sent.body, Number(t)), `t=${t},v1=${sig}`);
  const sample = (await owner('POST', `/v1/webhooks/${ep.id}/test`, { event: 'sale.completed' })).body;
  const body = JSON.parse(got.at(-1).body);
  assert.deepEqual([body.type, body.test, body.data.test, body.data.client_name], ['sale.completed', true, true, 'Ava Lopez']);
  assert.equal(sample.payload.type, 'sale.completed');
  assert.equal((await owner('POST', `/v1/webhooks/${ep.id}/test`, { event: 'nope' })).status, 400);
  assert.ok(!listEvents(app.ctx, { limit: 50 }).some((e) => e.type === 'test.ping' || e.data?.test), 'test events never reach the activity feed');
  const detail = (await owner('GET', `/v1/webhook-deliveries/${ping.id}`)).body;
  assert.deepEqual([detail.test, detail.response_body, detail.payload.type], [true, 'thanks', 'test.ping']);
});

test('failed deliveries show why, retry with backoff, mark the webhook failing after 3, and can be resent', async () => {
  answer = 500;
  got.length = 0;
  await owner('POST', '/v1/clients', { name: 'Dev Shah', email: 'dev@example.com' });
  await new Promise((r) => setTimeout(r, 200));
  await deliverPending(app.ctx);
  let d = (await owner('GET', `/v1/webhooks/${ep.id}/deliveries?event=client.created`)).body.data[0];
  assert.equal(d.status, 'pending', 'retried later');
  assert.ok(d.next_attempt_at > new Date().toISOString());
  const detail = (await owner('GET', `/v1/webhook-deliveries/${d.id}`)).body;
  assert.equal(detail.response_code, 500);
  assert.equal(detail.response_body, 'nope, broken');
  assert.match(detail.last_error, /answered 500/);
  assert.equal(detail.payload.data.client_name, 'Dev Shah');
  // Two more failures in a row: failing.
  for (let i = 0; i < 2; i++) { db().run(`UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`, d.id); await deliverPending(app.ctx); }
  let w = (await owner('GET', '/v1/webhooks')).body.data.find((x) => x.id === ep.id);
  assert.equal(w.failing, true);
  assert.equal((await owner('GET', '/v1/api-status')).body.webhooks.failing, 1);
  // After the last retry it's failed; the webhook's list and the all-deliveries view filter it.
  db().run(`UPDATE webhook_deliveries SET attempts = 5, next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`, d.id);
  await deliverPending(app.ctx);
  d = (await owner('GET', `/v1/webhook-deliveries/${d.id}`)).body;
  assert.deepEqual([d.status, d.attempts, d.retries_left], ['failed', 6, 0]);
  assert.ok((await owner('GET', '/v1/webhook-deliveries?status=failed')).body.data.some((x) => x.id === d.id));
  assert.ok(!(await owner('GET', '/v1/webhook-deliveries?status=delivered')).body.data.some((x) => x.id === d.id));
  // Fixed the receiver: resend one, then everything failed in the last 7 days.
  answer = 200;
  const again = (await owner('POST', `/v1/webhook-deliveries/${d.id}/resend`)).body;
  assert.equal(again.status, 'succeeded');
  assert.equal(got.at(-1).headers['dp-delivery'], d.id, 'a resend keeps the delivery id so receivers can skip repeats');
  w = (await owner('GET', '/v1/webhooks')).body.data.find((x) => x.id === ep.id);
  assert.equal(w.failing, false, 'a success clears failing');
  db().run(`UPDATE webhook_deliveries SET status = 'failed' WHERE endpoint_id = ? AND test = 0`, ep.id);
  const bulk = (await owner('POST', `/v1/webhooks/${ep.id}/resend-failed`)).body;
  assert.ok(bulk.tried >= 1 && bulk.delivered === bulk.tried);
  assert.equal((await owner('POST', `/v1/webhooks/${ep.id}/resend-failed`)).status, 400, 'nothing left to resend');
});

test('a delivery is sent once even when a resend and the job run at the same time; a stuck send is picked up', async () => {
  got.length = 0;
  await owner('POST', '/v1/clients', { name: 'Eli Stone', email: 'eli@example.com' });
  await new Promise((r) => setTimeout(r, 200));
  const d = (await owner('GET', `/v1/webhooks/${ep.id}/deliveries?event=client.created`)).body.data[0];
  assert.equal(d.status, 'succeeded');
  got.length = 0;
  delay = 300;                                         // a slow receiver: the second press arrives mid-send
  const [a, b] = await Promise.all([owner('POST', `/v1/webhook-deliveries/${d.id}/resend`), owner('POST', `/v1/webhook-deliveries/${d.id}/resend`)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(got.length, 1, 'sent once');
  delay = 0;
  // The server stopped mid-send: 'sending' for more than 2 minutes is sent again by the job.
  db().run(`UPDATE webhook_deliveries SET status = 'sending', last_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`, d.id);
  await deliverPending(app.ctx);
  assert.equal(db().get('SELECT status FROM webhook_deliveries WHERE id = ?', d.id).status, 'succeeded');
  assert.equal(got.length, 2);
  // Paused webhooks wait.
  await owner('PATCH', `/v1/webhooks/${ep.id}`, { active: false });
  db().run(`UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`, d.id);
  await deliverPending(app.ctx);
  assert.equal(db().get('SELECT status FROM webhook_deliveries WHERE id = ?', d.id).status, 'pending');
  await owner('PATCH', `/v1/webhooks/${ep.id}`, { active: true });
});

test('a new signing secret is shown once; the old one also signs for a while, or stops at once', async () => {
  const old = ep.secret;
  const r = (await owner('POST', `/v1/webhooks/${ep.id}/rotate-secret`, {})).body;
  assert.notEqual(r.secret, old);
  assert.ok(r.previous_secret_until > new Date().toISOString());
  got.length = 0;
  await owner('POST', `/v1/webhooks/${ep.id}/test`, {});
  const sent = got.at(-1);
  const [, t, v1, v2] = sent.headers['dp-signature'].match(/^t=(\d+),v1=(\w+),v1=(\w+)$/);
  assert.equal(signPayload(r.secret, sent.body, Number(t)), `t=${t},v1=${v1}`);
  assert.equal(signPayload(old, sent.body, Number(t)), `t=${t},v1=${v2}`);
  const now = (await owner('POST', `/v1/webhooks/${ep.id}/rotate-secret`, { keep_old_hours: 0 })).body;
  assert.equal(now.previous_secret_until, null);
  await owner('POST', `/v1/webhooks/${ep.id}/test`, {});
  assert.match(got.at(-1).headers['dp-signature'], /^t=\d+,v1=\w+$/);
  assert.equal((await owner('POST', `/v1/webhooks/${ep.id}/rotate-secret`, { keep_old_hours: 500 })).status, 400);
  ep.secret = (await owner('GET', `/v1/webhooks/${ep.id}/secret`)).body.secret;
  assert.ok(!db().all('SELECT * FROM audit_log').some((a) => JSON.stringify(a).includes('whsec_')), 'no secret in the audit log');
});

test('the outbox filters, searches and sends again; emails with a way in never go to another address', async () => {
  createFamilyWithGuardian(app.ctx, { name: 'Maria Lopez', email: 'maria@example.com' }, 'Lopez');
  await req('POST', '/portal/api/login', { email: 'maria@example.com' });                 // a sign-in code (not sent: no email service)
  let box = (await owner('GET', '/v1/outbox?q=sign-in%20code')).body;
  assert.ok(box.data.length >= 1 && box.data.every((m) => /sign-in code/i.test(m.subject + m.body)));
  assert.equal(box.data[0].sensitive, true);
  assert.ok(box.counts.not_sent >= 1);
  assert.equal((await owner('GET', '/v1/outbox?status=nope')).status, 400);
  assert.equal((await owner('POST', `/v1/outbox/${box.data[0].id}/resend`, {})).status, 400, 'nothing can be sent without an email service');

  app.ctx.mail = { resendKey: 're_test_1', from: 'DP <hello@example.org>', resendUrl };
  try {
    const code = box.data[0];
    const refused = await owner('POST', `/v1/outbox/${code.id}/resend`, { to: 'someone@else.com' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /only goes to the address it was written for/);
    assert.equal((await owner('POST', `/v1/outbox/${code.id}/resend`, {})).status, 200, 'the same address is fine');
    assert.equal(mails.at(-1).to[0], 'maria@example.com');
    // An ordinary email can go to a corrected address.
    const { sendEmail } = await import('../src/services/mail.js');
    const plain = await sendEmail(app.ctx, { to: 'typo@exmaple.com', subject: 'Schedule change', text: 'Speed class moves to 5:30 this week.' });
    const ok = (await owner('POST', `/v1/outbox/${plain.id}/resend`, { to: 'fixed@example.com' })).body;
    assert.equal(ok.to, 'fixed@example.com');
    assert.equal(mails.at(-1).subject, 'Schedule change');
    assert.equal((await owner('POST', `/v1/outbox/${plain.id}/resend`, { to: 'not-an-email' })).status, 400);
    // A new staff member's one-time password is hidden from the outbox once the email really went out.
    const s = (await owner('POST', '/v1/staff', { name: 'Riley Brooks', email: 'riley@test.dev', role: 'coach' })).body;
    const invite = db().get(`SELECT * FROM outbox WHERE to_email = 'riley@test.dev' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(invite.status, 'sent');
    assert.ok(!invite.body.includes(s.temporary_password) && invite.body.includes('[hidden once sent]'));
    assert.ok(mails.at(-1).text.includes(s.temporary_password), 'the email itself has it');
    assert.equal((await owner('POST', `/v1/outbox/${invite.id}/resend`, {})).status, 409, 'a hidden email can\'t be resent');
    box = (await owner('GET', '/v1/outbox?status=sent')).body;
    assert.ok(box.data.every((m) => m.status === 'sent'));
  } finally { app.ctx.mail = {}; }
});

test('texts filter by status and search; video coverage lists what needs a demo video; the status strip adds it up', async () => {
  const { sendText } = await import('../src/services/sms.js');
  await sendText(app.ctx, { to: '+15125550101', kind: 'test', body: 'Reminder: Speed class tomorrow at 5' });
  assert.equal((await owner('GET', '/v1/texts?q=speed')).body.data.length, 1);
  assert.equal((await owner('GET', '/v1/texts?q=5550101')).body.data.length, 1);
  assert.equal((await owner('GET', '/v1/texts?status=sent')).body.data.length, 0);
  assert.equal((await owner('GET', '/v1/texts?status=bad')).status, 400);

  const ex = async (name, video_url) => (await owner('POST', '/v1/exercises', { name, video_url })).body;
  await ex('Goblet squat', 'https://www.youtube.com/watch?v=abc123');
  await ex('Broad jump', 'https://vimeo.com/123456');
  await ex('Sled push', 'https://cdn.example.com/sled.mp4');
  const drive = await ex('Box jump', 'https://drive.google.com/file/d/abc/view');
  const none = await ex('Nordic curl');
  const prog = (await owner('POST', '/v1/programs', { name: 'Strength', weeks: 4 })).body;
  const wo = (await owner('POST', `/v1/programs/${prog.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
  await owner('POST', `/v1/workouts/${wo.id}/exercises`, { exercise_id: none.id, prescription: '3 × 5' });
  const cov = (await owner('GET', '/v1/video-coverage')).body;
  assert.deepEqual([cov.total, cov.with_video, cov.by_kind], [5, 3, { youtube: 1, vimeo: 1, file: 1 }]);
  assert.deepEqual(cov.attention.map((a) => [a.name, a.problem, a.uses]), [['Nordic curl', 'missing', 1], ['Box jump', 'unplayable', 0]], 'used in programs first');
  assert.equal(cov.attention[1].id, drive.id);
  const status = (await owner('GET', '/v1/api-status')).body;
  assert.deepEqual([status.video.in_use_missing, status.video.unplayable], [1, 1]);
  assert.equal(status.email.mode, 'test');
  assert.ok(status.keys.active >= 1);
});

test('coaches and front desk can\'t reach any of it', async () => {
  const paths = [['GET', '/v1/api-status'], ['GET', '/v1/api-keys'], ['PATCH', '/v1/api-keys/x'], ['GET', '/v1/api-keys/x/requests'], ['GET', '/v1/webhooks'], ['GET', `/v1/webhooks/${ep.id}/secret`],
    ['POST', `/v1/webhooks/${ep.id}/rotate-secret`], ['POST', `/v1/webhooks/${ep.id}/test`], ['POST', `/v1/webhooks/${ep.id}/resend-failed`], ['GET', '/v1/webhook-deliveries'], ['GET', '/v1/webhook-deliveries/x'],
    ['POST', '/v1/webhook-deliveries/x/resend'], ['GET', '/v1/outbox'], ['POST', '/v1/outbox/x/resend'], ['GET', '/v1/texts'], ['GET', '/v1/video-coverage']];
  for (const who of [coach, desk]) for (const [m, p] of paths) assert.equal((await who(m, p, m === 'GET' ? null : {})).status, 403, `${m} ${p}`);
});
