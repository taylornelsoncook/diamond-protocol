// Staff & security: editing staff, devices and signing out, handing a leaving coach's sessions to someone else,
// the security summary, activity-log filters and CSV, changing your password (current password, other devices),
// emailed reset links, and owner-only enforcement.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-staff-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
for (const k of ['DP_EMAIL_WEBHOOK', 'RESEND_API_KEY', 'DP_EMAIL_ONLY_TO']) delete process.env[k];

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const db = require('../server/db');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client(ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15') {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { 'user-agent': ua, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  return {
    get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), put: (p, b = {}) => req('PUT', p, b),
    login: (email, password) => req('POST', '/api/auth/staff/login', { email, password }),
  };
}
async function signedIn(email, pw, ua) { const c = client(ua); const r = await c.login(email, pw); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }
const owner = () => signedIn('owner@demo.test', 'demo-owner-2026');
const lastMail = (to) => db.get('SELECT * FROM outbox WHERE to_email=? ORDER BY id DESC LIMIT 1', to);
const tempFrom = (to) => lastMail(to).body.match(/One-time password: (\S+)/)[1];
async function newStaff(o, name, email, role = 'coach') {
  const r = await o.post('/api/staff', { name, email, role });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const pw = 'chosen-password-' + r.data.id;
  const c = await signedIn(email, tempFrom(email));
  assert.equal((await c.post('/api/auth/staff/password', { password: pw })).status, 200);
  return { id: r.data.id, pw, c };
}

test('edit a staff member: name and email, with validation and a log entry', async () => {
  const o = await owner();
  const { id } = await newStaff(o, 'Edie Edit', 'edie@demo.test');
  assert.equal((await o.put(`/api/staff/${id}`, { name: '  ' })).status, 400);
  assert.equal((await o.put(`/api/staff/${id}`, { email: 'not-an-email' })).status, 400);
  const dup = await o.put(`/api/staff/${id}`, { email: 'COACH@demo.test' });
  assert.equal(dup.status, 400); assert.match(dup.data.error, /already uses/);
  const r = await o.put(`/api/staff/${id}`, { name: 'Edie  Edwards', email: 'Edie.Edwards@demo.test' });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Edie Edwards');
  assert.equal(r.data.email, 'edie.edwards@demo.test');
  assert.equal(r.data.role, 'coach', 'role untouched when not sent');
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Edited staff member' AND detail LIKE '%edie.edwards@demo.test%'"));
  // signs in with the new email
  assert.equal((await client().login('edie.edwards@demo.test', 'chosen-password-' + id)).status, 200);
  // role is still validated when sent
  assert.equal((await o.put(`/api/staff/${id}`, { role: 'boss' })).status, 400);
});

test('adding someone whose email belongs to a turned-off account says so', async () => {
  const o = await owner();
  const { id } = await newStaff(o, 'Gone Gary', 'gary@demo.test');
  await o.post(`/api/staff/${id}/turn-off`);
  const r = await o.post('/api/staff', { name: 'Gary Again', email: 'gary@demo.test', role: 'coach' });
  assert.equal(r.status, 400); assert.match(r.data.error, /turned off/);
});

test('sign-ins are recorded with device and IP; owner sees devices and signs someone out everywhere', async () => {
  const o = await owner();
  const { id, pw } = await newStaff(o, 'Dev Ice', 'devi@demo.test');
  const phone = await signedIn('devi@demo.test', pw, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  const laptop = await signedIn('devi@demo.test', pw, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36');
  const d = (await o.get(`/api/staff/${id}`)).data;
  assert.ok(d.last_signed_in, 'last sign-in recorded');
  assert.ok(d.last_signin_ip);
  const devices = d.sessions.map((s) => s.device);
  assert.ok(devices.includes('Safari on iPhone'), devices.join());
  assert.ok(devices.includes('Chrome on Windows'), devices.join());
  assert.ok(d.devices >= 2);
  assert.ok(d.recent.some((a) => a.action === 'Signed in'));
  const out = await o.post(`/api/staff/${id}/sign-out`);
  assert.equal(out.status, 200);
  assert.ok(out.data.signed_out >= 2);
  assert.equal(out.data.devices, 0);
  assert.equal((await phone.get('/api/auth/staff/me')).status, 401);
  assert.equal((await laptop.get('/api/auth/staff/me')).status, 401);
  // their password still works
  assert.equal((await client().login('devi@demo.test', pw)).status, 200);
  // owner signing themselves out keeps the current device
  const other = await owner();
  const self = db.get("SELECT id FROM staff WHERE email='owner@demo.test'").id;
  const r = await o.post(`/api/staff/${self}/sign-out`);
  assert.equal(r.status, 200);
  assert.equal((await o.get('/api/auth/staff/me')).status, 200, 'this device stays signed in');
  assert.equal((await other.get('/api/auth/staff/me')).status, 401);
});

test('your account: list devices, sign out one, sign out all others', async () => {
  const o = await owner();
  const { pw } = await newStaff(o, 'Acc Count', 'acc@demo.test', 'frontdesk');
  const a = await signedIn('acc@demo.test', pw);
  const b = await signedIn('acc@demo.test', pw, 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36');
  const c = await signedIn('acc@demo.test', pw);
  let me = (await a.get('/api/account')).data;
  assert.equal(me.email, 'acc@demo.test');
  const cur = me.sessions.find((s) => s.current);
  assert.ok(cur, 'this device is marked');
  assert.equal(me.sessions.filter((s) => s.current).length, 1);
  assert.ok(me.signins.some((x) => x.action === 'Signed in'));
  assert.equal((await a.post(`/api/account/sessions/${cur.id}/sign-out`)).status, 400, "can't end this device here");
  const android = me.sessions.find((s) => s.device === 'Chrome on Android');
  assert.equal((await a.post(`/api/account/sessions/${android.id}/sign-out`)).status, 200);
  assert.equal((await b.get('/api/auth/staff/me')).status, 401);
  // someone else's session id is not found
  const ownerSess = db.get("SELECT a.rowid AS id FROM auth_sessions a JOIN staff s ON s.id=a.user_id WHERE s.email='owner@demo.test' LIMIT 1").id;
  assert.equal((await a.post(`/api/account/sessions/${ownerSess}/sign-out`)).status, 404);
  const all = await a.post('/api/account/sign-out-others');
  assert.equal(all.status, 200);
  assert.ok(all.data.signed_out >= 1);
  assert.equal((await c.get('/api/auth/staff/me')).status, 401);
  assert.equal((await a.get('/api/auth/staff/me')).status, 200);
  me = (await a.get('/api/account')).data;
  assert.equal(me.sessions.length, 1);
  assert.equal((await client().get('/api/account')).status, 401);
});

test('changing your password needs the current one, signs out other devices and emails you', async () => {
  const o = await owner();
  const { pw } = await newStaff(o, 'Pat Word', 'pat@demo.test');
  const a = await signedIn('pat@demo.test', pw);
  const b = await signedIn('pat@demo.test', pw);
  let r = await a.post('/api/auth/staff/password', { password: 'brand-new-password-1' });
  assert.equal(r.status, 400); assert.match(r.data.error, /current password/);
  r = await a.post('/api/auth/staff/password', { current_password: 'wrong-one-entirely', password: 'brand-new-password-1' });
  assert.equal(r.status, 400);
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Password change failed' AND kind='refused'"));
  r = await a.post('/api/auth/staff/password', { current_password: pw, password: pw });
  assert.equal(r.status, 400); assert.match(r.data.error, /current password/);
  r = await a.post('/api/auth/staff/password', { current_password: pw, password: 'brand-new-password-1' });
  assert.equal(r.status, 200);
  assert.equal((await a.get('/api/auth/staff/me')).status, 200, 'this device stays in');
  assert.equal((await b.get('/api/auth/staff/me')).status, 401, 'other devices signed out');
  assert.match(lastMail('pat@demo.test').subject, /password was changed/);
  assert.equal((await client().login('pat@demo.test', 'brand-new-password-1')).status, 200);
});

test('choosing a first password must differ from the one-time password', async () => {
  const o = await owner();
  await o.post('/api/staff', { name: 'Fay First', email: 'fay@demo.test', role: 'coach' });
  const temp = tempFrom('fay@demo.test');
  const f = await signedIn('fay@demo.test', temp);
  const r = await f.post('/api/auth/staff/password', { password: temp });
  assert.equal(r.status, 400); assert.match(r.data.error, /one-time/);
  assert.equal((await f.post('/api/auth/staff/password', { password: 'fays-own-password' })).status, 200);
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Chose a password' AND actor LIKE 'Fay First%'"));
});

test('resending an invite to someone who never signed in', async () => {
  const o = await owner();
  const r = await o.post('/api/staff', { name: 'Ivy Invite', email: 'ivy@demo.test', role: 'frontdesk' });
  const first = tempFrom('ivy@demo.test');
  assert.equal((await o.post(`/api/staff/${r.data.id}/reset-password`)).status, 200);
  const second = tempFrom('ivy@demo.test');
  assert.notEqual(first, second);
  assert.equal((await client().login('ivy@demo.test', first)).status, 401, 'old one-time password stops working');
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Resent invite' AND detail LIKE 'Ivy Invite%'"));
});

test('turning off a coach hands their upcoming sessions, classes and private hours to someone else', async () => {
  const o = await owner();
  const { id } = await newStaff(o, 'Hank Hand', 'hank@demo.test');
  const ownerId = db.get("SELECT id FROM staff WHERE email='owner@demo.test'").id;
  const deskId = db.get("SELECT id FROM staff WHERE email='desk@demo.test'").id;
  const future = '2099-01-01T10:00';
  const past = '2001-01-01T10:00';
  const cls = db.insert('classes', { name: 'Hank speed', type: 'class', weekdays: '1', start_time: '16:00', duration_min: 60, coach_id: id });
  const e1 = db.insert('events', { type: 'class', name: 'Hank speed', starts_at: future, duration_min: 60, coach_id: id });
  const e2 = db.insert('events', { type: 'private', name: 'Private', starts_at: future.replace('10:00', '12:00'), duration_min: 60, coach_id: id });
  const old = db.insert('events', { type: 'class', name: 'Old', starts_at: past, duration_min: 60, coach_id: id });
  const av = db.insert('availability', { kind: 'private', weekday: 2, start_time: '15:00', end_time: '18:00', slot_min: 60, coach_id: id });
  const list = (await o.get('/api/staff')).data.find((s) => s.id === id);
  assert.deepEqual(list.work, { sessions: 2, classes: 1, hours: 1 });
  // only an active owner or coach can take over
  assert.equal((await o.post(`/api/staff/${id}/turn-off`, { hand_to: deskId })).status, 400);
  assert.equal((await o.post(`/api/staff/${id}/turn-off`, { hand_to: id })).status, 400);
  assert.equal(db.get('SELECT active FROM staff WHERE id=?', id).active, 1, 'nothing changed on a refused hand-off');
  const r = await o.post(`/api/staff/${id}/turn-off`, { hand_to: ownerId });
  assert.equal(r.status, 200);
  assert.equal(r.data.active, false);
  for (const e of [e1, e2]) assert.equal(db.get('SELECT coach_id FROM events WHERE id=?', e).coach_id, ownerId);
  assert.equal(db.get('SELECT coach_id FROM events WHERE id=?', old).coach_id, id, 'past sessions keep their coach');
  assert.equal(db.get('SELECT coach_id FROM classes WHERE id=?', cls).coach_id, ownerId);
  assert.equal(db.get('SELECT coach_id FROM availability WHERE id=?', av).coach_id, ownerId);
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Handed over sessions' AND detail LIKE 'Hank Hand%2 upcoming sessions%'"));
});

test('moving a coach to front desk can unassign their sessions', async () => {
  const o = await owner();
  const { id } = await newStaff(o, 'Una Assign', 'una@demo.test');
  const e = db.insert('events', { type: 'class', name: 'Una class', starts_at: '2099-02-01T10:00', duration_min: 60, coach_id: id });
  const r = await o.put(`/api/staff/${id}`, { role: 'frontdesk', hand_to: '' });
  assert.equal(r.status, 200);
  assert.equal(r.data.role, 'frontdesk');
  assert.equal(db.get('SELECT coach_id FROM events WHERE id=?', e).coach_id, null);
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Unassigned sessions' AND detail LIKE 'Una Assign%'"));
  // hand-over on its own, e.g. for someone turned off earlier
  const e3 = db.insert('events', { type: 'class', name: 'Una later', starts_at: '2099-02-02T10:00', duration_min: 60, coach_id: id });
  const coachId = db.get("SELECT id FROM staff WHERE email='coach@demo.test'").id;
  assert.equal((await o.post(`/api/staff/${id}/hand-over`, {})).status, 400, 'needs a choice');
  assert.equal((await o.post(`/api/staff/${id}/hand-over`, { hand_to: coachId })).status, 200);
  assert.equal(db.get('SELECT coach_id FROM events WHERE id=?', e3).coach_id, coachId);
  // without hand_to, sessions are left alone
  const { id: id2 } = await newStaff(o, 'Lee Leave', 'lee@demo.test');
  const e2 = db.insert('events', { type: 'class', name: 'Lee class', starts_at: '2099-02-01T11:00', duration_min: 60, coach_id: id2 });
  await o.put(`/api/staff/${id2}`, { role: 'frontdesk' });
  assert.equal(db.get('SELECT coach_id FROM events WHERE id=?', e2).coach_id, id2);
});

test('security summary counts locked, waiting and failed sign-ins, and flags a stale backup', async () => {
  const o = await owner();
  await o.post('/api/staff', { name: 'Wendy Wait', email: 'wendy@demo.test', role: 'coach' });
  for (let i = 0; i < 5; i++) await client().login('desk@demo.test', 'nope-nope-nope');
  const s = (await o.get('/api/staff/summary')).data;
  assert.ok(s.active >= 3);
  assert.ok(s.locked >= 1, 'front desk is locked');
  assert.ok(s.waiting >= 1, 'Wendy has not chosen a password');
  assert.ok(s.failed_24h >= 5);
  assert.equal(typeof s.refused_7d, 'number');
  assert.equal(s.backup_stale, true, 'no backups yet');
  await o.post('/api/backups');
  const after = (await o.get('/api/staff/summary')).data;
  assert.equal(after.backup_stale, false);
  assert.ok(after.last_backup_at);
  const bk = (await o.get('/api/backups')).data;
  assert.ok(bk.total_size > 0);
  await o.post(`/api/staff/${db.get("SELECT id FROM staff WHERE email='desk@demo.test'").id}/unlock`);
});

test('activity log filters by who, by person and by date, and exports CSV', async () => {
  const o = await owner();
  const coachRow = db.get("SELECT * FROM staff WHERE email='coach@demo.test'");
  await client().login('coach@demo.test', 'wrong-password-here');
  await signedIn('coach@demo.test', 'demo-coach-2026');
  db.insert('activity', { actor: 'Test Parent (parent)', action: 'Booked', detail: '=HYPERLINK("x")', kind: 'change' });
  db.insert('activity', { actor: 'API key Scanner', action: 'Sent result', kind: 'change', created_at: '2020-01-01 10:00:00' });
  let r = (await o.get('/api/staff/activity?who=parent&per=200')).data;
  assert.ok(r.items.length && r.items.every((a) => a.actor.endsWith('(parent)')));
  r = (await o.get('/api/staff/activity?who=api&per=200')).data;
  assert.ok(r.items.every((a) => a.actor.startsWith('API key')));
  r = (await o.get(`/api/staff/activity?staff_id=${coachRow.id}&per=200`)).data;
  assert.ok(r.items.some((a) => a.action === 'Signed in'));
  assert.ok(r.items.some((a) => a.action === 'Sign-in failed' && a.detail === 'coach@demo.test'), 'failed sign-ins with their email count as theirs');
  assert.ok(r.items.every((a) => a.actor.startsWith('Chris Maddox') || a.detail === 'coach@demo.test'));
  const newest = (await o.get('/api/staff/activity?per=200')).data.items.map((a) => a.created_at);
  assert.deepEqual(newest, [...newest].sort().reverse(), 'newest first by time, even for back-dated entries');
  r = (await o.get('/api/staff/activity?until=2020-01-02T00:00:00Z&per=200')).data;
  assert.equal(r.total, 1); assert.equal(r.items[0].action, 'Sent result');
  assert.match(r.items[0].created_at, /^2020-01-01T10:00:00Z$/, 'times come back as ISO UTC');
  r = (await o.get('/api/staff/activity?since=2020-01-02T00:00:00Z&who=api&per=200')).data;
  assert.equal(r.total, 0);
  const csv = await o.get('/api/staff/activity.csv?who=parent');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="activity-/);
  assert.match(csv.data, /^"When \(UTC\)","Who","What"/);
  assert.ok(csv.data.includes(`"'=HYPERLINK(""x"")"`), 'formula cells are defused');
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Exported activity log'"));
});

test('forgot password: emailed single-use link, same answer for unknown emails, rate limited', async () => {
  const o = await owner();
  const { id, pw } = await newStaff(o, 'Rita Reset', 'rita@demo.test');
  const old = await signedIn('rita@demo.test', pw);
  const anon = client();
  assert.equal((await anon.post('/api/staff-reset', { email: 'nope' })).status, 400);
  const before = db.get('SELECT COUNT(*) AS n FROM outbox').n;
  const unknown = await anon.post('/api/staff-reset', { email: 'nobody@demo.test' });
  assert.equal(unknown.status, 200);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM outbox').n, before, 'no email for unknown addresses');
  // lock the account first: a reset link should clear the lock
  for (let i = 0; i < 5; i++) await client().login('rita@demo.test', 'wrong-wrong-wrong');
  const r = await anon.post('/api/staff-reset', { email: 'RITA@demo.test' });
  assert.deepEqual(r.data, unknown.data, 'same answer either way');
  const mail = lastMail('rita@demo.test');
  const token = mail.body.match(/\?reset=([\w-]+)/)[1];
  assert.equal((await anon.get('/api/staff-reset/not-a-real-token')).status, 400);
  const check = await anon.get(`/api/staff-reset/${token}`);
  assert.equal(check.status, 200); assert.equal(check.data.name, 'Rita');
  assert.equal((await anon.post(`/api/staff-reset/${token}`, { password: 'short' })).status, 400);
  assert.equal((await anon.post(`/api/staff-reset/${token}`, { password: pw })).status, 400, 'must be a new password');
  const done = await anon.post(`/api/staff-reset/${token}`, { password: 'ritas-fresh-password' });
  assert.equal(done.status, 200);
  assert.equal((await old.get('/api/auth/staff/me')).status, 401, 'signed out everywhere');
  assert.equal((await anon.post(`/api/staff-reset/${token}`, { password: 'another-password-x' })).status, 400, 'single use');
  assert.equal((await client().login('rita@demo.test', 'ritas-fresh-password')).status, 200, 'lock cleared, new password works');
  assert.match(lastMail('rita@demo.test').subject, /password was changed/);
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='Reset own password' AND actor LIKE 'Rita Reset%'"));
  // at most three links an hour
  for (let i = 0; i < 4; i++) await anon.post('/api/staff-reset', { email: 'rita@demo.test' });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM staff_resets WHERE staff_id=? AND created_at>datetime('now','-1 hour')", id).n, 3);
  // turned-off accounts get nothing
  const { id: offId } = await newStaff(o, 'Otto Off', 'otto@demo.test');
  await o.post(`/api/staff/${offId}/turn-off`);
  const n = db.get("SELECT COUNT(*) AS n FROM outbox WHERE to_email='otto@demo.test'").n;
  await anon.post('/api/staff-reset', { email: 'otto@demo.test' });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM outbox WHERE to_email='otto@demo.test'").n, n);
});

test('first-run setup is refused once staff exist', async () => {
  const r = await client().post('/api/setup', { name: 'X', email: 'x@demo.test', password: 'long-enough-pw' });
  assert.equal(r.status, 409);
});

test('only owners reach staff tools; coaches and front desk are refused and logged', async () => {
  const coach = await signedIn('coach@demo.test', 'demo-coach-2026');
  const desk = await signedIn('desk@demo.test', 'demo-desk-2026');
  const id = db.get("SELECT id FROM staff WHERE email='desk@demo.test'").id;
  for (const c of [coach, desk]) {
    for (const [m, p] of [['get', '/api/staff/summary'], ['get', `/api/staff/${id}`], ['put', `/api/staff/${id}`], ['post', `/api/staff/${id}/sign-out`], ['post', `/api/staff/${id}/hand-over`], ['get', '/api/staff/activity.csv']]) {
      assert.equal((await c[m](p, {})).status, 403, `${m} ${p}`);
    }
    assert.equal((await c.get('/api/account')).status, 200, 'everyone has their own account page');
  }
  assert.ok(db.get("SELECT 1 FROM activity WHERE kind='refused' AND detail LIKE 'GET /api/staff/summary%'"));
});

test('Review fixes: an open reset link stops working after an owner reset, an email change or a password change', async () => {
  const o = await owner();
  const { id, pw, c } = await newStaff(o, 'Link Lister', 'link@demo.test');
  const anon = client();
  const linkFor = async (email) => { await anon.post('/api/staff-reset', { email }); return lastMail(email).body.match(/\?reset=([\w-]+)/)[1]; };
  // owner resets the password (say it was compromised): the emailed link can't override it
  let token = await linkFor('link@demo.test');
  assert.equal((await anon.get(`/api/staff-reset/${token}`)).status, 200);
  assert.equal((await o.post(`/api/staff/${id}/reset-password`)).status, 200);
  assert.equal((await anon.get(`/api/staff-reset/${token}`)).status, 400);
  assert.equal((await anon.post(`/api/staff-reset/${token}`, { password: 'sneaky-new-password' })).status, 400);
  // an email change cancels a link sent to the old address
  const temp = tempFrom('link@demo.test');
  const c2 = await signedIn('link@demo.test', temp);
  assert.equal((await c2.post('/api/auth/staff/password', { password: pw + '-2' })).status, 200);
  token = await linkFor('link@demo.test');
  assert.equal((await o.put(`/api/staff/${id}`, { email: 'link.new@demo.test' })).status, 200);
  assert.equal((await anon.get(`/api/staff-reset/${token}`)).status, 400);
  // changing your own password cancels a link asked for earlier
  token = await linkFor('link.new@demo.test');
  assert.equal((await c2.post('/api/auth/staff/password', { current_password: pw + '-2', password: pw + '-3' })).status, 200);
  assert.equal((await anon.get(`/api/staff-reset/${token}`)).status, 400);
  // turning the account off (and back on) doesn't revive one either (after the hourly limit of three links resets)
  db.run("UPDATE staff_resets SET created_at=datetime('now','-2 hours') WHERE staff_id=?", id);
  token = await linkFor('link.new@demo.test');
  await o.post(`/api/staff/${id}/turn-off`);
  await o.post(`/api/staff/${id}/turn-on`);
  assert.equal((await anon.get(`/api/staff-reset/${token}`)).status, 400);
  void c;
});

test('Review fixes: summary counts only invited people who never signed in as "not signed in yet"', async () => {
  const o = await owner();
  const { id } = await newStaff(o, 'Reset Rae', 'rae@demo.test');
  const before = (await o.get('/api/staff/summary')).data.waiting;
  await o.post(`/api/staff/${id}/reset-password`); // must choose a new password, but has signed in before
  assert.equal((await o.get('/api/staff/summary')).data.waiting, before);
  await o.post('/api/staff', { name: 'New Nell', email: 'nell@demo.test', role: 'frontdesk' });
  assert.equal((await o.get('/api/staff/summary')).data.waiting, before + 1);
});

test('Review fixes: the staff member filter skips a parent with the same name; CSV defuses tab-led cells', async () => {
  const o = await owner();
  const coachRow = db.get("SELECT * FROM staff WHERE email='coach@demo.test'");
  db.insert('activity', { actor: `${coachRow.name} (parent)`, action: 'Booked a session', kind: 'change' });
  const r = (await o.get(`/api/staff/activity?staff_id=${coachRow.id}&per=200`)).data;
  assert.ok(r.items.length);
  assert.ok(!r.items.some((a) => a.actor === `${coachRow.name} (parent)`));
  db.insert('activity', { actor: 'System', action: 'Tab test', detail: '\t=cmd|x', kind: 'change' });
  const csv = await o.get('/api/staff/activity.csv?q=Tab%20test');
  assert.ok(csv.data.includes(`"'\t=cmd|x"`), csv.data);
});

test("Review fixes: a turned-off coach's private hours aren't offered to parents", async () => {
  const o = await owner();
  const { id } = await newStaff(o, 'Hours Hal', 'hal@demo.test');
  const booking = require('../server/services/booking');
  const av = db.insert('availability', { kind: 'evaluation', weekday: 0, start_time: '05:00', end_time: '06:00', slot_min: 60, coach_id: id });
  const from = booking.nowLocal().slice(0, 10);
  const mine = () => booking.openSlots('evaluation', from, 14).filter((s) => s.availability_id === av).length;
  assert.ok(mine() > 0, 'offered while the coach is active');
  await o.post(`/api/staff/${id}/turn-off`); // left with Hal (no hand_to)
  assert.equal(mine(), 0, 'not offered once turned off');
  const list = (await o.get('/api/staff')).data.find((s) => s.id === id);
  assert.equal(list.work.hours, 1, 'still flagged to hand over');
  await o.post(`/api/staff/${id}/turn-on`);
  assert.ok(mine() > 0);
});
