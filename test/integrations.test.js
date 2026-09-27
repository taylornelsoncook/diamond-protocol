// API & integrations: key access levels and request log, athlete results over the API, webhook deliveries
// (headers, samples, resend, retries with backoff, rotation, health), outbox filters and send again, video coverage,
// and owner-only enforcement.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-integrations-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
for (const k of ['DP_EMAIL_WEBHOOK', 'RESEND_API_KEY', 'DP_EMAIL_ONLY_TO', 'DP_EMAIL_FROM']) delete process.env[k];

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app, jobs } = require('../server/index');
const db = require('../server/db');
const hooks = require('../server/services/ops-webhooks');
const { emit } = require('../server/lib');

// A receiving server: records each request; answers with `answer` (status, body).
const got = [];
let answer = { status: 200, body: '{"ok":true}' };
const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { got.push({ path: req.url, headers: req.headers, body }); res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(answer.body); });
});

let server, base, hookBase;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  hookBase = `http://127.0.0.1:${receiver.address().port}`;
});
test.after(() => { server?.close(); receiver.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
test.afterEach(() => { answer = { status: 200, body: '{"ok":true}' }; delete process.env.DP_EMAIL_WEBHOOK; });

function client() {
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  return {
    get: (p, h) => req('GET', p, undefined, h), post: (p, b = {}, h) => req('POST', p, b, h), put: (p, b = {}) => req('PUT', p, b), del: (p) => req('DELETE', p),
    login: (email, password) => req('POST', '/api/auth/staff/login', { email, password }),
  };
}
async function signedIn(email, pw) { const c = client(); assert.equal((await c.login(email, pw)).status, 200); return c; }
const owner = () => signedIn('owner@demo.test', 'demo-owner-2026');
const coach = () => signedIn('coach@demo.test', 'demo-coach-2026');
const desk = () => signedIn('desk@demo.test', 'demo-desk-2026');
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); };
const code = () => db.get("SELECT code FROM athletes WHERE first_name='Chidi'").code;

test('only owners can use API & integrations', async () => {
  const o = await owner();
  const hook = (await o.post('/api/webhooks', { url: `${hookBase}/roles`, events: ['pr.set'] })).data;
  const key = db.get('SELECT id FROM api_keys LIMIT 1').id;
  const mail = db.get('SELECT id FROM outbox LIMIT 1').id;
  for (const c of [await coach(), await desk()]) {
    for (const [m, p] of [['get', '/api/integrations'], ['post', '/api/api-keys'], ['put', `/api/api-keys/${key}`], ['del', `/api/api-keys/${key}`], ['get', `/api/api-keys/${key}/requests`],
      ['post', '/api/webhooks'], ['put', `/api/webhooks/${hook.id}`], ['post', `/api/webhooks/${hook.id}/test`], ['post', `/api/webhooks/${hook.id}/rotate`],
      ['get', `/api/webhooks/${hook.id}/deliveries`], ['post', `/api/webhooks/${hook.id}/resend-failed`], ['get', '/api/outbox'], ['post', `/api/outbox/${mail}/resend`]]) {
      assert.equal((await c[m](p, ...(m === 'get' || m === 'del' ? [] : [{ label: 'x', url: 'https://x.test', events: ['pr.set'] }]))).status, 403, `${m} ${p}`);
    }
  }
  await o.del(`/api/webhooks/${hook.id}`);
});

test('API keys: read-only keys read but cannot send; access level and label can change; every request is logged', async () => {
  const o = await owner();
  assert.equal((await o.post('/api/api-keys', { label: 'X', scope: 'admin' })).status, 400);
  assert.equal((await o.post('/api/api-keys', { label: '   ' })).status, 400);
  const k = (await o.post('/api/api-keys', { label: 'Analytics sheet', scope: 'read' })).data;
  assert.equal(k.scope, 'read');
  const auth = { authorization: `Bearer ${k.key}` };
  const anon = client();
  assert.equal((await anon.get('/api/v1/athletes?limit=2', auth)).status, 200);
  const send = { athlete_code: code(), source: 'hawkin', test: 'Vertical jump', value: 24.5, unit: 'in', ref: 'int-test-1' };
  const refused = await anon.post('/api/v1/results', send, auth);
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /read-only/);
  assert.ok(!db.get("SELECT 1 FROM results WHERE source_ref='int-test-1'"), 'nothing saved');
  // Upgrade the key in place: same key, now it can send.
  let r = await o.put(`/api/api-keys/${k.id}`, { scope: 'full', label: 'Analytics and devices' });
  assert.equal(r.status, 200);
  assert.equal(r.data.scope, 'full'); assert.equal(r.data.label, 'Analytics and devices');
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Updated API key' AND detail LIKE '%renamed to Analytics and devices%'"));
  assert.equal((await anon.post('/api/v1/results', send, auth)).status, 200);
  assert.equal((await o.put(`/api/api-keys/${k.id}`, {})).status, 400);
  assert.equal((await o.put(`/api/api-keys/${k.id}`, { label: '' })).status, 400);
  assert.equal((await o.put('/api/api-keys/999999', { label: 'x' })).status, 404);
  // Request log with answers and errors
  await waitFor(() => db.get('SELECT COUNT(*) AS n FROM api_requests WHERE key_id=?', k.id).n >= 3);
  const log = (await o.get(`/api/api-keys/${k.id}/requests`)).data;
  assert.equal(log.requests_30d, 3);
  assert.equal(log.errors_30d, 1);
  const bad = log.items.find((x) => x.status === 403);
  assert.equal(bad.method, 'POST'); assert.equal(bad.path, '/api/v1/results'); assert.match(bad.error, /read-only/);
  const listed = (await o.get('/api/integrations')).data.keys.find((x) => x.id === k.id);
  assert.equal(listed.requests_30d, 3); assert.equal(listed.errors_30d, 1); assert.equal(listed.scope, 'full');
  // Revoke: logged once, can't change access level afterwards
  await o.del(`/api/api-keys/${k.id}`); await o.del(`/api/api-keys/${k.id}`);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM activity WHERE action='Revoked API key' AND detail LIKE 'Analytics and devices%'").n, 1);
  assert.equal((await o.put(`/api/api-keys/${k.id}`, { scope: 'read' })).status, 400);
  // Keys made before access levels existed keep full access.
  const legacy = db.get("SELECT scope FROM api_keys WHERE label='Website booking'");
  assert.equal(legacy.scope, 'full');
});

test('prune job drops request log rows older than 30 days', () => {
  const key = db.get('SELECT id FROM api_keys LIMIT 1').id;
  db.insert('api_requests', { key_id: key, method: 'GET', path: '/old', status: 200, created_at: '2020-01-01 00:00:00' });
  jobs.find((j) => j.name === 'prune-api-requests').run();
  assert.ok(!db.get("SELECT 1 FROM api_requests WHERE path='/old'"));
});

test('v1: an athlete\'s results with the best marked, and the test library', async () => {
  const o = await owner();
  const k = (await o.post('/api/api-keys', { label: 'Reader', scope: 'read' })).data;
  const auth = { authorization: `Bearer ${k.key}` };
  const anon = client();
  const a = db.get("SELECT id, code FROM athletes WHERE first_name='Chidi'");
  const t = db.get("SELECT id FROM tests WHERE name='10-yard sprint'");
  db.run('DELETE FROM results WHERE athlete_id=? AND test_id=?', a.id, t.id);
  db.insert('results', { athlete_id: a.id, test_id: t.id, value: 1.82, source: 'manual', recorded_at: '2026-08-01 16:00:00' });
  db.insert('results', { athlete_id: a.id, test_id: t.id, value: 1.74, source: 'manual', recorded_at: '2026-09-01 16:00:00' });
  db.insert('results', { athlete_id: a.id, test_id: t.id, value: 1.79, source: 'api', recorded_at: '2026-09-10 16:00:00' });
  let r = await anon.get(`/api/v1/athletes/${a.code.toLowerCase()}/results?test=10-yard%20sprint`, auth);
  assert.equal(r.status, 200);
  assert.equal(r.data.athlete_code, a.code);
  assert.deepEqual(r.data.data.map((x) => x.value), [1.79, 1.74, 1.82], 'newest first');
  assert.deepEqual(r.data.data.map((x) => x.best), [false, true, false], 'lowest time is best');
  assert.equal(r.data.data[0].unit, 's');
  r = await anon.get(`/api/v1/athletes/${a.code}/results?test=10-yard%20sprint&since=2026-09-05`, auth);
  assert.deepEqual(r.data.data.map((x) => x.value), [1.79]);
  assert.equal((await anon.get(`/api/v1/athletes/${a.code}/results?test=Vert%20jump`, auth)).status, 400);
  assert.equal((await anon.get(`/api/v1/athletes/${a.code}/results?since=yesterday`, auth)).status, 400);
  assert.equal((await anon.get('/api/v1/athletes/NOPE0000/results', auth)).status, 404);
  assert.equal((await anon.get(`/api/v1/athletes/${a.code}/results`)).status, 401);
  r = await anon.get('/api/v1/tests', auth);
  const sprint = r.data.data.find((x) => x.name === '10-yard sprint');
  assert.deepEqual(sprint, { name: '10-yard sprint', category: 'Speed', unit: 's', lower_is_better: true });
});

test('webhooks: name, no duplicate URLs, delivery headers, sample test events, edit and rotate', async () => {
  const o = await owner();
  const url = `${hookBase}/main`;
  assert.equal((await o.post('/api/webhooks', { url: '', events: ['pr.set'] })).status, 400);
  const w = (await o.post('/api/webhooks', { url, label: '  Zapier   new clients ', events: ['client.created', 'pr.set'] })).data;
  assert.equal(w.label, 'Zapier new clients');
  assert.equal((await o.post('/api/webhooks', { url, events: ['pr.set'] })).status, 400, 'same URL twice');
  // Sample of a subscribed event, marked as a test, with delivery headers
  got.length = 0;
  let r = await o.post(`/api/webhooks/${w.id}/test`, { event: 'client.created' });
  assert.equal(r.data.ok, true);
  const req = got[0];
  const body = JSON.parse(req.body);
  assert.equal(body.event, 'client.created');
  assert.equal(body.data.test, true);
  assert.equal(body.data.athlete_code, 'AVALOP2026');
  assert.equal(req.headers['x-dp-event'], 'client.created');
  assert.equal(req.headers['x-dp-delivery'], String(r.data.delivery.id));
  assert.equal(req.headers['x-dp-signature'], crypto.createHmac('sha256', w.secret).update(req.body).digest('hex'));
  assert.match(req.headers['user-agent'], /DiamondProtocol-Webhooks/);
  assert.equal((await o.post(`/api/webhooks/${w.id}/test`, { event: 'nope.event' })).status, 400);
  // Detail keeps what was sent and what they answered
  const d = (await o.get(`/api/webhooks/${w.id}/deliveries/${r.data.delivery.id}`)).data;
  assert.equal(d.response, '{"ok":true}');
  assert.equal(d.status, 200); assert.equal(d.attempts, 1); assert.ok(d.duration_ms >= 0);
  assert.equal(JSON.parse(d.payload).event, 'client.created');
  // Edit: events, name, URL; nothing to change is refused
  r = await o.put(`/api/webhooks/${w.id}`, { events: ['pr.set'], label: 'PR alerts', url: `${hookBase}/prs` });
  assert.deepEqual(r.data.events, ['pr.set']); assert.equal(r.data.label, 'PR alerts'); assert.equal(r.data.url, `${hookBase}/prs`);
  assert.equal((await o.put(`/api/webhooks/${w.id}`, {})).status, 400);
  assert.equal((await o.put(`/api/webhooks/${w.id}`, { events: [] })).status, 400);
  // Rotate: a new secret signs from now on, and it isn't listed again
  const rot = (await o.post(`/api/webhooks/${w.id}/rotate`)).data;
  assert.match(rot.secret, /^whsec_/); assert.notEqual(rot.secret, w.secret);
  got.length = 0;
  await o.post(`/api/webhooks/${w.id}/test`);
  assert.equal(got[0].headers['x-dp-signature'], crypto.createHmac('sha256', rot.secret).update(got[0].body).digest('hex'));
  assert.ok(!JSON.stringify((await o.get('/api/integrations')).data).includes(rot.secret));
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Rotated webhook signing secret' AND detail='PR alerts'"));
  await o.del(`/api/webhooks/${w.id}`);
});

test('webhooks: failures are recorded with the answer, flagged, resent by hand and retried with backoff', async () => {
  const o = await owner();
  const w = (await o.post('/api/webhooks', { url: `${hookBase}/flaky`, events: ['booking.created'] })).data;
  const hook = db.get('SELECT * FROM webhooks WHERE id=?', w.id);
  answer = { status: 503, body: 'Down for maintenance' };
  for (let i = 0; i < 3; i++) emit('booking.created', { booking_id: 100 + i });
  await waitFor(() => db.get('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id=? AND status=503', w.id).n === 3);
  let listed = (await o.get('/api/integrations')).data.webhooks.find((x) => x.id === w.id);
  assert.equal(listed.health.failing, true);
  assert.equal(listed.health.failed_7d, 3);
  const failed = (await o.get(`/api/webhooks/${w.id}/deliveries?status=failed`)).data;
  assert.equal(failed.total, 3);
  assert.equal((await o.get(`/api/webhooks/${w.id}/deliveries?status=ok`)).data.total, 0);
  const one = failed.items[0];
  assert.equal(db.get('SELECT response FROM webhook_deliveries WHERE id=?', one.id).response, 'Down for maintenance');
  // Resend one by hand once the receiver is back: same delivery, same body, one more try
  answer = { status: 200, body: 'ok' };
  const before = db.get('SELECT payload FROM webhook_deliveries WHERE id=?', one.id).payload;
  got.length = 0;
  let r = await o.post(`/api/webhooks/${w.id}/deliveries/${one.id}/resend`);
  assert.equal(r.data.ok, true); assert.equal(r.data.delivery.attempts, 2); assert.equal(r.data.delivery.status, 200);
  assert.equal(got[0].body, before);
  assert.equal(got[0].headers['x-dp-delivery'], String(one.id));
  // Automatic retries: not before 5 minutes have passed, then yes; paused hooks wait
  assert.equal(await hooks.retryDue(), 0, 'too soon');
  db.run('UPDATE webhooks SET active=0 WHERE id=?', w.id);
  assert.equal(await hooks.retryDue(Date.now() + 6 * 60e3), 0, 'paused');
  db.run('UPDATE webhooks SET active=1 WHERE id=?', w.id);
  answer = { status: 500, body: 'still down' };
  assert.equal(await hooks.retryDue(Date.now() + 6 * 60e3), 2);
  const tries = db.all('SELECT attempts FROM webhook_deliveries WHERE webhook_id=? AND status=500', w.id).map((x) => x.attempts);
  assert.deepEqual(tries, [2, 2]);
  assert.equal(await hooks.retryDue(Date.now() + 10 * 60e3), 0, 'second retry waits 30 minutes');
  assert.equal(await hooks.retryDue(Date.now() + 40 * 60e3), 2);
  db.run('UPDATE webhook_deliveries SET attempts=? WHERE webhook_id=?', hooks.MAX_ATTEMPTS, w.id);
  assert.equal(await hooks.retryDue(Date.now() + 864e5 / 2), 0, 'gives up after four tries');
  // Resend all failed
  answer = { status: 204, body: '' };
  r = await o.post(`/api/webhooks/${w.id}/resend-failed`);
  assert.deepEqual(r.data, { tried: 2, ok: 2, failed: 0 });
  assert.equal((await o.post(`/api/webhooks/${w.id}/resend-failed`)).status, 400, 'nothing left');
  listed = (await o.get('/api/integrations')).data.webhooks.find((x) => x.id === w.id);
  assert.equal(listed.health.failing, false);
  // A delivery of another webhook is not reachable through this one
  const other = (await o.post('/api/webhooks', { url: `${hookBase}/other`, events: ['pr.set'] })).data;
  assert.equal((await o.get(`/api/webhooks/${other.id}/deliveries/${one.id}`)).status, 404);
  assert.equal((await o.post(`/api/webhooks/${other.id}/deliveries/${one.id}/resend`)).status, 404);
  await o.del(`/api/webhooks/${w.id}`); await o.del(`/api/webhooks/${other.id}`);
});

test('webhooks: an unreachable URL gets a plain reason', async () => {
  const o = await owner();
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const w = (await o.post('/api/webhooks', { url: `http://127.0.0.1:${port}/gone`, events: ['pr.set'] })).data;
  const r = await o.post(`/api/webhooks/${w.id}/test`);
  assert.equal(r.data.status, 0);
  assert.match(r.data.delivery.error, /Connection refused/);
  await o.del(`/api/webhooks/${w.id}`);
});

test('outbox: filter by status, search the text, send again (and to another address)', async () => {
  const o = await owner();
  const id = db.insert('outbox', { to_email: 'kurt.jensen@example.com', subject: 'Your receipt', body: 'Thanks for the pack of 10 sessions. Reference ZX-4411.', status: 'failed', error: 'Resend answered 500' });
  let r = await o.get('/api/outbox?status=failed');
  assert.ok(r.data.items.every((m) => m.status === 'failed'));
  assert.ok(r.data.items.some((m) => m.id === id));
  assert.ok(r.data.counts.failed >= 1);
  r = await o.get('/api/outbox?q=ZX-4411');
  assert.deepEqual(r.data.items.map((m) => m.id), [id], 'searches the body');
  // No provider: explains, sends nothing
  r = await o.post(`/api/outbox/${id}/resend`);
  assert.equal(r.status, 400); assert.match(r.data.error, /No email provider/);
  // With a relay: a new message goes out, the original stays
  const relay = [];
  const rs = http.createServer((q, s) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { relay.push(JSON.parse(b)); s.writeHead(200); s.end('{}'); }); });
  await new Promise((res) => rs.listen(0, '127.0.0.1', res));
  process.env.DP_EMAIL_WEBHOOK = `http://127.0.0.1:${rs.address().port}/send`;
  try {
    r = await o.post(`/api/outbox/${id}/resend`, { to: 'kurt.new@example.com' });
    assert.equal(r.status, 200);
    assert.equal(relay[0].to, 'kurt.new@example.com'); assert.equal(relay[0].subject, 'Your receipt');
    assert.equal(db.get("SELECT status FROM outbox WHERE to_email='kurt.new@example.com' ORDER BY id DESC").status, 'sent');
    assert.equal(db.get('SELECT status FROM outbox WHERE id=?', id).status, 'failed', 'original kept');
    assert.ok(db.get("SELECT 1 FROM activity WHERE action='Sent an email again' AND detail LIKE 'Your receipt → kurt.new@example.com%'"));
    assert.equal((await o.post(`/api/outbox/${id}/resend`, { to: 'not-an-email' })).status, 400);
    assert.equal((await o.post('/api/outbox/999999/resend')).status, 404);
  } finally { rs.close(); }
});

test('exercise video coverage counts playable links and lists what needs one, most used first', async () => {
  const o = await owner();
  let v = (await o.get('/api/integrations')).data.video;
  assert.equal(v.total, db.get('SELECT COUNT(*) AS n FROM exercises').n);
  const sled = v.attention.find((a) => a.name === 'Sled push');
  assert.equal(sled.problem, 'unplayable', 'a link that cannot play is flagged');
  for (let i = 1; i < v.attention.length; i++) assert.ok(v.attention[i - 1].uses >= v.attention[i].uses);
  const before = v.with_video;
  const c = await coach();
  assert.equal((await c.put(`/api/exercises/${sled.id}`, { video_url: 'https://youtu.be/abcdefghijk' })).status, 200);
  v = (await o.get('/api/integrations')).data.video;
  assert.equal(v.with_video, before + 1);
  assert.equal(v.by_kind.youtube, before + 1 - v.by_kind.vimeo - v.by_kind.file);
  assert.ok(!v.attention.some((a) => a.id === sled.id));
});

// ---- review fixes ----
test('review fixes: an empty access level never widens a key', async () => {
  const o = await owner();
  const k = (await o.post('/api/api-keys', { label: 'Read sheet', scope: 'read' })).data;
  for (const scope of ['', null]) {
    const r = await o.put(`/api/api-keys/${k.id}`, { scope });
    assert.equal(r.status, 400, JSON.stringify(scope));
  }
  assert.equal(db.get('SELECT scope FROM api_keys WHERE id=?', k.id).scope, 'read');
  await o.del(`/api/api-keys/${k.id}`);
});

test('review fixes: the same webhook URL with a trailing slash or other host case is a duplicate', async () => {
  const o = await owner();
  const w = (await o.post('/api/webhooks', { url: 'https://Hooks.Example.test/dp', events: ['pr.set'] })).data;
  for (const url of ['https://hooks.example.test/dp/', 'https://HOOKS.example.test/dp']) {
    assert.equal((await o.post('/api/webhooks', { url, events: ['pr.set'] })).status, 400, url);
  }
  const other = (await o.post('/api/webhooks', { url: 'https://hooks.example.test/dp2', events: ['pr.set'] })).data;
  assert.equal((await o.put(`/api/webhooks/${other.id}`, { url: 'https://hooks.example.test/dp/' })).status, 400);
  assert.equal((await o.put(`/api/webhooks/${w.id}`, { url: 'https://hooks.example.test/dp/' })).status, 200, 'its own URL is fine');
  await o.del(`/api/webhooks/${w.id}`); await o.del(`/api/webhooks/${other.id}`);
});

test('review fixes: "since" is a local date in the business time zone', async () => {
  const o = await owner();
  const k = (await o.post('/api/api-keys', { label: 'Since reader', scope: 'read' })).data;
  const auth = { authorization: `Bearer ${k.key}` };
  const a = db.get("SELECT id, code FROM athletes WHERE first_name='Chidi'");
  const t = db.get("SELECT id FROM tests WHERE name='Vertical jump'");
  db.run('DELETE FROM results WHERE athlete_id=? AND test_id=?', a.id, t.id);
  // Denver is UTC-6 in September: 03:00 UTC on Sep 1 is 9 pm on Aug 31 there; 07:00 UTC is 1 am on Sep 1.
  db.insert('results', { athlete_id: a.id, test_id: t.id, value: 90, source: 'manual', recorded_at: '2026-09-01 03:00:00' });
  db.insert('results', { athlete_id: a.id, test_id: t.id, value: 92, source: 'manual', recorded_at: '2026-09-01 07:00:00' });
  const r = await client().get(`/api/v1/athletes/${a.code}/results?test=Vertical%20jump&since=2026-09-01`, auth);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.data.map((x) => x.value), [92]);
  await o.del(`/api/api-keys/${k.id}`);
});

test('review fixes: a delivery stuck as sending can be resent and is retried; overlapping retry runs send once', async () => {
  const o = await owner();
  const w = (await o.post('/api/webhooks', { url: `${hookBase}/stuck`, events: ['booking.created'] })).data;
  const payload = JSON.stringify({ event: 'booking.created', created_at: new Date().toISOString(), data: { booking_id: 1 } });
  const stuck = db.insert('webhook_deliveries', { webhook_id: w.id, event: 'booking.created', payload, status: null, attempts: 1 });
  db.run("UPDATE webhook_deliveries SET last_attempt_at=datetime('now') WHERE id=?", stuck);
  assert.equal((await o.post(`/api/webhooks/${w.id}/deliveries/${stuck}/resend`)).status, 400, 'really still sending');
  db.run("UPDATE webhook_deliveries SET last_attempt_at=datetime('now','-10 minutes') WHERE id=?", stuck);
  got.length = 0;
  const r = await o.post(`/api/webhooks/${w.id}/deliveries/${stuck}/resend`);
  assert.equal(r.status, 200); assert.equal(r.data.ok, true); assert.equal(got.length, 1);
  // The retry job picks up a stuck delivery too.
  const stuck2 = db.insert('webhook_deliveries', { webhook_id: w.id, event: 'booking.created', payload, status: null, attempts: 1 });
  db.run("UPDATE webhook_deliveries SET last_attempt_at=datetime('now','-10 minutes') WHERE id=?", stuck2);
  got.length = 0;
  assert.equal(await hooks.retryDue(), 1);
  assert.equal(db.get('SELECT status, attempts FROM webhook_deliveries WHERE id=?', stuck2).status, 200);
  // Two failed deliveries, two overlapping runs of the job: each delivery is sent once.
  const ids = [0, 1].map(() => db.insert('webhook_deliveries', { webhook_id: w.id, event: 'booking.created', payload, status: 500, attempts: 1 }));
  for (const id of ids) db.run("UPDATE webhook_deliveries SET last_attempt_at=datetime('now','-10 minutes') WHERE id=?", id);
  got.length = 0;
  await Promise.all([hooks.retryDue(), hooks.retryDue()]);
  assert.equal(got.length, 2);
  assert.deepEqual(ids.map((id) => db.get('SELECT attempts FROM webhook_deliveries WHERE id=?', id).attempts), [2, 2]);
  await o.del(`/api/webhooks/${w.id}`);
});

test('review fixes: a failed send-again is logged as a failure; messages without a status count as not sent', async () => {
  const o = await owner();
  const before = (await o.get('/api/outbox')).data.counts.logged;
  const id = db.insert('outbox', { to_email: 'linh.nguyen@example.com', subject: 'Review fix check', body: 'x', status: null });
  assert.equal((await o.get('/api/outbox')).data.counts.logged, before + 1);
  assert.equal((await o.post(`/api/outbox/${id}/resend`)).status, 400);
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Email could not be sent again' AND detail LIKE 'Review fix check%'"));
  assert.ok(!db.get("SELECT 1 FROM activity WHERE action='Sent an email again' AND detail LIKE 'Review fix check%'"));
});
