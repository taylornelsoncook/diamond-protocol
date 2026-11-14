// Push notifications for the athlete app (schema 70, services/push.js): VAPID keys made once and kept in settings, a
// phone subscribes from the app, a coach's message or a ready program nudges every subscribed phone with an empty
// push signed for its push service, and the service worker asks what to show. The push service is a stand-in here
// (ctx.pushFetch).
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';
import { publicKeyObject, runReminders } from '../src/services/push.js';

let app, base, coach, ava, token, pushes, answer;
const PW = 'correct-horse-battery';
const NOW = '2026-10-19T14:00:00.000Z';   // 9 am Chicago, a Monday
const SUB = (n) => ({ endpoint: `https://push.example.org/send/${n}`, keys: { p256dh: 'BPubKeyExample', auth: 'authSecret' } });
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => { const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
}
const athlete = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'x-client-token': token, 'user-agent': 'TestPhone/1.0', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const anyone = async (method, path, body) => { const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const flush = async () => { await Promise.all(app.ctx.pushPending.splice(0)); };

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  app.ctx.pushPending = [];
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, NOW);
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), ava.id, NOW, NOW, NOW, NOW);
  token = (await coach('GET', `/v1/clients/${ava.id}`)).body.app_link.split('token=')[1];
});
beforeEach(() => { pushes = []; answer = () => new Response(null, { status: 201 }); app.ctx.pushFetch = async (url, init) => { pushes.push({ url, headers: init.headers, method: init.method }); return answer(url); }; });
after(() => app.server.close());

test('keys are made once; a phone subscribes; a coach\'s message nudges it with a signed, empty push; the worker gets the notice once', async () => {
  const st = (await athlete('GET', '/app/api/push')).body;
  assert.equal(st.subscriptions.length, 0);
  assert.equal(Buffer.from(st.public_key, 'base64url').length, 65, 'an uncompressed P-256 point');
  assert.equal((await athlete('GET', '/app/api/push')).body.public_key, st.public_key, 'the same key every time (kept in settings)');
  assert.equal(app.ctx.db.get(`SELECT value FROM settings WHERE key = 'vapid_public'`).value, st.public_key);
  assert.equal((await athlete('POST', '/app/api/push/subscribe', { subscription: { endpoint: 'http://not-https.example.org/x', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);
  const sub = await athlete('POST', '/app/api/push/subscribe', { subscription: SUB(1) });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.deepEqual([sub.body.subscribed, sub.body.subscriptions.length, sub.body.subscriptions[0].endpoint_host, sub.body.subscriptions[0].device, sub.body.reminder_hour], [true, 1, 'push.example.org', 'TestPhone/1.0', 7]);
  assert.equal((await athlete('POST', '/app/api/push/subscribe', { subscription: SUB(1) })).body.subscriptions.length, 1, 'the same phone again is one row');
  // The coach writes: one push to the phone, empty, with a VAPID header for push.example.org that verifies with the public key.
  const msg = await coach('POST', `/v1/clients/${ava.id}/messages`, { body: 'Great week. Keep the bar close on the clean.' });
  assert.equal(msg.status, 201, JSON.stringify(msg.body));
  await flush();
  assert.equal(pushes.length, 1);
  assert.deepEqual([pushes[0].url, pushes[0].method, pushes[0].headers.TTL, pushes[0].headers['Content-Length']], [SUB(1).endpoint, 'POST', '86400', '0']);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(pushes[0].headers.Authorization);
  assert.ok(m, pushes[0].headers.Authorization);
  assert.equal(m[2], st.public_key);
  const [head, claims, sig] = m[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const c = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.deepEqual([c.aud, c.sub.startsWith('mailto:'), c.exp > Date.now() / 1000], ['https://push.example.org', true, true]);
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKeyObject(st.public_key), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'the signature checks out');
  // The worker asks what to show: the notice, once.
  const p1 = await anyone('POST', '/push/pending', { endpoint: SUB(1).endpoint });
  assert.equal(p1.status, 200);
  assert.deepEqual([p1.body.data.length, p1.body.data[0].title, p1.body.data[0].body, p1.body.data[0].url, p1.body.data[0].kind], [1, 'A note from Riley at Diamond Protocol', 'Great week. Keep the bar close on the clean.', '/app', 'message']);
  assert.deepEqual((await anyone('POST', '/push/pending', { endpoint: SUB(1).endpoint })).body.data, [], 'shown once');
  assert.equal((await anyone('POST', '/push/pending', { endpoint: 'https://push.example.org/send/nobody' })).status, 404);
  // A test tap from the app.
  assert.equal((await athlete('POST', '/app/api/push/test')).status, 200);
  await flush();
  assert.equal(pushes.length, 2);
  assert.equal((await anyone('POST', '/push/pending', { endpoint: SUB(1).endpoint })).body.data[0].kind, 'test');
});

test('a push service that says gone ends the subscription; turning off removes it; the morning reminder goes once on a day with a workout', async () => {
  await athlete('POST', '/app/api/push/subscribe', { subscription: SUB(2) });
  assert.equal((await athlete('GET', '/app/api/push')).body.subscriptions.length, 2);
  answer = (url) => new Response(null, { status: url.endsWith('/2') ? 410 : 201 });
  await coach('POST', `/v1/clients/${ava.id}/messages`, { body: 'Hello again.' });
  await flush();
  assert.deepEqual((await athlete('GET', '/app/api/push')).body.subscriptions.map((s) => s.endpoint_host), ['push.example.org'], 'the gone one is removed');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE ?', '%/send/2').n, 0);
  assert.equal((await anyone('POST', '/push/pending', { endpoint: SUB(1).endpoint })).body.data.length, 1, 'the message notice, drained');
  // The reminder: a program with a workout today (Monday).
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  const p = (await coach('POST', '/v1/programs', { name: 'Strength', weeks: 1 })).body;
  const w = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
  await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' });
  await coach('POST', `/v1/programs/${p.id}/assign`, { client_id: ava.id, start_date: '2026-10-19', training_days: [1, 3, 5] });
  answer = () => new Response(null, { status: 201 });
  app.ctx.now = () => '2026-10-19T11:30:00.000Z';   // 6:30 am Chicago: too early
  try {
    assert.deepEqual(runReminders(app.ctx), { skipped: 'early' });
    app.ctx.now = () => '2026-10-19T12:30:00.000Z';   // 7:30 am
    assert.deepEqual(runReminders(app.ctx), { athletes: 1, sent: 1 });
    await flush();
    const n = (await anyone('POST', '/push/pending', { endpoint: SUB(1).endpoint })).body.data;
    assert.deepEqual([n.length, n[0].title, n[0].body, n[0].kind], [1, 'Today: Lower', '1 exercise in Strength. Tap to open your workout.', 'workout:2026-10-19']);
    assert.deepEqual(runReminders(app.ctx), { athletes: 1, sent: 0 }, 'once a day');
    app.ctx.now = () => '2026-10-20T13:00:00.000Z';   // Tuesday: nothing planned
    assert.deepEqual(runReminders(app.ctx), { athletes: 1, sent: 0 });
  } finally { app.ctx.now = () => NOW; }
  // Off.
  const off = await athlete('POST', '/app/api/push/unsubscribe', { endpoint: SUB(1).endpoint });
  assert.deepEqual([off.body.removed, off.body.subscriptions.length], [1, 0]);
  assert.equal((await athlete('POST', '/app/api/push/test')).status, 400, 'nothing subscribed');
  const before = pushes.length;
  await coach('POST', `/v1/clients/${ava.id}/messages`, { body: 'Nobody listening.' });
  await flush();
  assert.equal(pushes.length, before, 'no phones: no push');
});

test('the notifications list: every notice lands in it (phone or not), the badge counts the ones not tapped, and only a tap on each one clears it', async () => {
  // Nobody listening: the coach's last message still landed in the list, marked shown (nothing to show it on).
  let inbox = (await athlete('GET', '/app/api/notices')).body;
  const nobody = inbox.data.find((n) => n.body === 'Nobody listening.');
  assert.ok(nobody, 'written with no phone');
  assert.ok(app.ctx.db.get('SELECT shown_at FROM push_notices WHERE id = ?', nobody.id).shown_at, 'marked shown so a phone subscribed later is not handed it');
  assert.equal(inbox.unseen, inbox.data.length, 'nothing tapped yet');
  assert.ok(inbox.data.length >= 4, 'the messages, the reminder and the test tap');
  assert.equal(inbox.data[0].id, nobody.id, 'newest first');
  // The app's home carries the count for the badge.
  const home = (await athlete('GET', '/app/api/home')).body;
  assert.equal(home.notices_unseen, inbox.unseen);
  // A tap clears one; the others stay.
  const tap = await athlete('POST', `/app/api/notices/${nobody.id}/seen`, {});
  assert.equal(tap.status, 200, JSON.stringify(tap.body));
  assert.deepEqual([tap.body.url, tap.body.unseen], ['/app', inbox.unseen - 1]);
  inbox = (await athlete('GET', '/app/api/notices')).body;
  assert.equal(inbox.unseen, inbox.data.length - 1);
  assert.ok(inbox.data.find((n) => n.id === nobody.id).seen_at);
  assert.equal((await athlete('POST', `/app/api/notices/${nobody.id}/seen`, {})).body.unseen, inbox.unseen, 'tapping again changes nothing');
  assert.equal((await athlete('POST', '/app/api/notices/pn_nope/seen', {})).status, 404);
  // Another athlete's notice can't be tapped from this account.
  const theo = (await coach('POST', '/v1/clients', { name: 'Theo Jensen', parent: { name: 'Kurt Jensen', email: 'kurt@example.com' } })).body; assert.ok(theo.id, JSON.stringify(theo));
  const tm = await coach('POST', `/v1/clients/${theo.id}/messages`, { body: 'For Theo.' }); assert.equal(tm.status, 201, JSON.stringify(tm.body));
  const his = app.ctx.db.get('SELECT id FROM push_notices WHERE client_id = ?', theo.id);
  assert.equal((await athlete('POST', `/app/api/notices/${his.id}/seen`, {})).status, 404);
  assert.equal((await athlete('GET', '/app/api/notices')).body.data.some((n) => n.id === his.id), false);
});

test('the athlete\'s own reminder hour: the usual time, their own hour, or off', async () => {
  await athlete('POST', '/app/api/push/subscribe', { subscription: SUB(3) });
  let st = (await athlete('GET', '/app/api/push')).body;
  assert.deepEqual([st.reminder_hour, st.reminder_own, st.reminder_default], [7, null, 7]);
  for (const bad of [{ hour: 3 }, { hour: 21 }, { hour: 'nine' }]) assert.equal((await athlete('PATCH', '/app/api/push/reminder', bad)).status, 400, JSON.stringify(bad));
  st = (await athlete('PATCH', '/app/api/push/reminder', { hour: 9 })).body;
  assert.deepEqual([st.reminder_hour, st.reminder_own], [9, 9]);
  // Monday again, nothing logged: at 7:30 the business's hour has come but not Ava's; at 9:30 it goes.
  app.ctx.db.run(`DELETE FROM push_notices WHERE kind = 'workout:2026-10-19'`);
  try {
    app.ctx.now = () => '2026-10-19T12:30:00.000Z';   // 7:30 am
    assert.deepEqual(runReminders(app.ctx), { athletes: 1, sent: 0 });
    app.ctx.now = () => '2026-10-19T14:30:00.000Z';   // 9:30 am
    assert.deepEqual(runReminders(app.ctx), { athletes: 1, sent: 1 });
    await flush();
    // Off: never.
    st = (await athlete('PATCH', '/app/api/push/reminder', { hour: 0 })).body;
    assert.deepEqual([st.reminder_hour, st.reminder_own], [0, 0]);
    app.ctx.db.run(`DELETE FROM push_notices WHERE kind = 'workout:2026-10-19'`);
    app.ctx.now = () => '2026-10-19T20:00:00.000Z';   // 3 pm
    assert.deepEqual(runReminders(app.ctx), { athletes: 1, sent: 0 });
    // Back to the usual: 5 am is too early for everyone, 7:30 goes.
    st = (await athlete('PATCH', '/app/api/push/reminder', { hour: null })).body;
    assert.deepEqual([st.reminder_hour, st.reminder_own], [7, null]);
    app.ctx.now = () => '2026-10-19T10:30:00.000Z';   // 5:30 am
    assert.deepEqual(runReminders(app.ctx), { skipped: 'early' });
    app.ctx.now = () => '2026-10-19T12:30:00.000Z';
    assert.deepEqual(runReminders(app.ctx), { athletes: 1, sent: 1 });
    await flush();
  } finally { app.ctx.now = () => NOW; await athlete('POST', '/app/api/push/unsubscribe', { endpoint: SUB(3).endpoint }); }
});

test('the manifest and the service worker are served; a version 69 database gains the push tables', async () => {
  const man = await fetch(base + '/app.webmanifest');
  assert.equal(man.headers.get('content-type'), 'application/manifest+json');
  const j = await man.json();
  assert.deepEqual([j.start_url, j.display, j.icons[0].sizes], ['/app', 'standalone', '1254x1254']);
  const sw = await fetch(base + '/sw.js');
  assert.equal(sw.status, 200); assert.match(await sw.text(), /addEventListener\('push'/);
  const html = await (await fetch(base + '/app')).text();
  assert.match(html, /rel="manifest" href="\/app.webmanifest"/);
  const tmp = mkdtempSync(join(tmpdir(), 'dp-push-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v69.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 69');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 99, `round ${round}`);
      for (const t of ['push_subscriptions', 'push_notices']) assert.ok(d.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t), t);
      assert.ok(d.all('PRAGMA table_info(push_notices)').some((c) => c.name === 'seen_at'), 'seen_at');
      assert.ok(d.all('PRAGMA table_info(clients)').some((c) => c.name === 'reminder_hour'), 'reminder_hour');
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('a version 95 database gains the notifications list and the reminder hour, keeping its notices', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-push95-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v95.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 95');
    old.exec(`INSERT INTO clients (id, name, access_token, created_at) VALUES ('cl_1', 'Ava Lopez', 'tok_1', '2026-10-01T00:00:00.000Z')`);
    old.exec(`INSERT INTO push_notices (id, client_id, kind, title, body, url, created_at, shown_at) VALUES ('pn_1', 'cl_1', 'message', 'Coach Riley', 'Hi', '/app', '2026-10-18T00:00:00.000Z', '2026-10-18T00:01:00.000Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 99, `round ${round}`);
      assert.deepEqual(d.get('SELECT title, seen_at FROM push_notices WHERE id = ?', 'pn_1'), { title: 'Coach Riley', seen_at: null });
      assert.equal(d.get('SELECT reminder_hour FROM clients WHERE id = ?', 'cl_1').reminder_hour, null);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
