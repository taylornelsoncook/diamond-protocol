// Staff & security (batch B14): summary, the manage panel (devices, sign out, email and role), handing over a departing
// coach's work, "forgot password" links, your own devices, and the activity log's filters and CSV export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDaysToDate, localDate, weekdayOf, zonedToUtc } from '../src/util.js';
import { openSlots } from '../src/services/schedule.js';

let app, base, owner, ownerId, coachId, otherId, deskId, facility;
const TZ = 'America/Chicago';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const login = (email, password, ua = MAC) => req('POST', '/auth/login', { email, password }, { 'user-agent': ua });
const signIn = async (email, password, ua) => as((await login(email, password, ua)).cookie);
const db = () => app.ctx.db;
const day = (n) => addDaysToDate(localDate(new Date().toISOString(), TZ), n);
const outbox = (to) => db().all('SELECT * FROM outbox WHERE to_email = ? ORDER BY created_at, rowid', to);
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const resetLink = (to) => outbox(to).filter((m) => /Reset your/.test(m.subject)).at(-1)?.body.match(/#reset=([\w-]+)/)?.[1];

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  ownerId = createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' }).id;
  coachId = createUser(app.ctx, { email: 'carl@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' }).id;
  otherId = createUser(app.ctx, { email: 'riley@test.dev', name: 'Riley Brooks', password: 'riley-password-1', role: 'coach' }).id;
  deskId = createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' }).id;
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

test('the security summary counts who can sign in, locked accounts, failed sign-ins and refused requests', async () => {
  for (let i = 0; i < 5; i++) await login('desk@test.dev', 'wrong-password');
  const desk = await signIn('carl@test.dev', 'coach-password-1');
  await desk('GET', '/v1/staff');                                  // refused: a coach
  const s = (await owner('GET', '/v1/staff/summary')).body;
  assert.equal(s.can_sign_in, 4);
  assert.equal(s.locked, 1);
  assert.ok(s.failed_sign_ins_24h >= 5);
  assert.ok(s.refused_7d >= 1);
  assert.equal(s.backups.overdue, false, 'a database in memory has no backups to be late');
  await owner('PATCH', `/v1/staff/${deskId}`, { unlock: true });
  assert.equal((await owner('GET', '/v1/staff/summary')).body.locked, 0);
  const added = (await owner('POST', '/v1/staff', { name: 'Nia New', email: 'nia@test.dev', role: 'coach' })).body;
  assert.equal((await owner('GET', '/v1/staff/summary')).body.not_signed_in_yet, 1);
  // An email that belongs to a turned-off account says so.
  await owner('PATCH', `/v1/staff/${added.id}`, { active: false });
  const again = await owner('POST', '/v1/staff', { name: 'Nia N', email: 'NIA@test.dev', role: 'coach' });
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /Nia New's turned-off account uses nia@test\.dev\. Turn their account back on instead/);
  assert.equal(again.body.error.details.user_id, added.id);
});

test('the manage panel shows devices; owners sign someone out of one device or everywhere', async () => {
  const phone = await login('riley@test.dev', 'riley-password-1', IPHONE);
  await login('riley@test.dev', 'riley-password-1', MAC);
  let d = (await owner('GET', `/v1/staff/${otherId}`)).body;
  assert.deepEqual(d.devices.map((x) => x.device).sort(), ['Chrome on Mac', 'Safari on iPhone']);
  assert.ok(d.devices.every((x) => x.ip && x.signed_in_at && !x.current));
  assert.ok(d.recent.some((a) => a.action === 'sign-in'), 'their sign-ins are in their recent activity');
  const iphone = d.devices.find((x) => x.device === 'Safari on iPhone');
  assert.equal((await owner('POST', `/v1/staff/${otherId}/devices/${iphone.id}/sign-out`)).status, 200);
  assert.equal((await as(phone.cookie)('GET', '/v1/clients')).status, 401, 'that device is signed out');
  assert.equal((await owner('POST', `/v1/staff/${otherId}/devices/${iphone.id}/sign-out`)).status, 404);
  assert.equal((await owner('POST', `/v1/staff/${otherId}/sign-out`)).body.signed_out, 1);
  assert.equal((await owner('GET', `/v1/staff/${otherId}`)).body.devices.length, 0);
  // Your own "sign out everywhere" keeps the device you're on; no device id ever reveals a session token.
  await login('owner@test.dev', 'owner-password-1', IPHONE);
  assert.equal((await owner('POST', `/v1/staff/${ownerId}/sign-out`)).body.signed_out, 1);
  assert.equal((await owner('GET', '/auth/me')).status, 200);
  d = (await owner('GET', `/v1/staff/${ownerId}`)).body;
  assert.deepEqual(d.devices.map((x) => x.current), [true]);
  assert.equal((await owner('POST', `/v1/staff/${ownerId}/devices/${d.devices[0].id}/sign-out`)).status, 409, 'use Sign out for this device');
});

test('staff see and sign out their own devices; changing your password signs out the others and emails you', async () => {
  const mac = await signIn('carl@test.dev', 'coach-password-1', MAC);
  const phone = await signIn('carl@test.dev', 'coach-password-1', IPHONE);
  const acct = (await mac('GET', '/auth/account')).body;
  assert.equal(acct.user.email, 'carl@test.dev');
  assert.ok(acct.devices.length >= 2 && acct.devices.filter((x) => x.current).length === 1);
  assert.ok(acct.sign_ins.length >= 2 && acct.sign_ins.every((x) => x.action === 'sign-in'));
  const phoneId = acct.devices.find((x) => x.device === 'Safari on iPhone' && !x.current).id;
  assert.equal((await mac('POST', `/auth/devices/${phoneId}/sign-out`)).status, 200);
  assert.equal((await phone('GET', '/auth/me')).status, 401);
  // Someone else's device id is not found.
  const ownerDevice = (await owner('GET', `/v1/staff/${ownerId}`)).body.devices[0].id;
  assert.equal((await mac('POST', `/auth/devices/${ownerDevice}/sign-out`)).status, 404);
  const other = await signIn('carl@test.dev', 'coach-password-1', IPHONE);
  assert.equal((await mac('POST', '/auth/password', { current_password: 'wrong', new_password: 'carl-new-password' })).status, 400);
  const changed = (await mac('POST', '/auth/password', { current_password: 'coach-password-1', new_password: 'carl-new-password' })).body;
  assert.ok(changed.signed_out >= 1);
  assert.equal((await other('GET', '/auth/me')).status, 401, 'other devices are signed out');
  assert.equal((await mac('GET', '/auth/me')).status, 200, 'this one stays');
  await wait();
  assert.match(outbox('carl@test.dev').at(-1).subject, /password was changed/);
});

test('owners edit name and email and change roles; nobody changes their own role or turns themselves off', async () => {
  const r = (await owner('PATCH', `/v1/staff/${otherId}`, { name: 'Riley B. Brooks', email: 'riley.brooks@test.dev' })).body;
  assert.deepEqual([r.name, r.email], ['Riley B. Brooks', 'riley.brooks@test.dev']);
  assert.equal((await owner('PATCH', `/v1/staff/${otherId}`, { email: 'carl@test.dev' })).status, 409);
  assert.equal((await owner('PATCH', `/v1/staff/${ownerId}`, { role: 'coach' })).status, 409);
  assert.equal((await owner('PATCH', `/v1/staff/${ownerId}`, { active: false })).status, 409);
  assert.equal((await login('riley.brooks@test.dev', 'riley-password-1')).status, 200, 'they sign in with the new email');
});

let series;
test('handing over a departing coach\'s classes, sessions and hours, with clashes refused unless left behind', async () => {
  const start = day(1);
  series = (await owner('POST', '/v1/class-series', { name: 'Speed', kind: 'group', location_id: facility.id, weekdays: [weekdayOf(start)], start_time: '17:00', duration_min: 60, capacity: 10, start_date: start, end_date: day(15), coach_id: coachId })).body;
  await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: weekdayOf(day(3)), start_time: '09:00', end_time: '11:00', coach_id: coachId });
  const ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  const first = (await owner('GET', `/v1/schedule?to=${zonedToUtc(day(16), '00:00', TZ)}`)).body.data.filter((x) => x.series_id === series.id)[0];
  await owner('POST', `/v1/sessions/${first.id}/bookings`, { client_id: ava.id });
  // Riley already leads something at the time of Carl's first class.
  const clash = (await owner('POST', '/v1/class-series', { name: 'Power', kind: 'group', location_id: facility.id, weekdays: [weekdayOf(start)], start_time: '17:30', duration_min: 60, capacity: 10, start_date: start, end_date: start, coach_id: otherId })).body;

  let staff = (await owner('GET', '/v1/staff')).body.data;
  const carl = staff.find((u) => u.id === coachId);
  assert.ok(carl.work.sessions >= 2 && carl.work.classes === 1 && carl.work.hours === 1 && carl.work.booked_clients === 1);
  assert.equal(carl.still_leading, false, 'an active coach leading is normal');
  const preview = (await owner('GET', `/v1/staff/${coachId}/hand-over?to=${otherId}`)).body;
  assert.equal(preview.conflicts.length, 1);
  assert.equal(preview.conflicts[0].clash_name, 'Power');
  assert.ok(preview.upcoming.length >= 2 && preview.upcoming[0].booked === 1);

  assert.equal((await owner('POST', `/v1/staff/${coachId}/hand-over`, { to: deskId })).status, 400, 'front desk never leads');
  assert.equal((await owner('POST', `/v1/staff/${coachId}/hand-over`, { to: coachId })).status, 400);
  assert.equal((await owner('POST', `/v1/staff/${coachId}/hand-over`, {})).status, 400);
  const refused = await owner('POST', `/v1/staff/${coachId}/hand-over`, { to: otherId });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.details.conflicts.length, 1);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM class_sessions WHERE coach_id = ? AND starts_at >= ?', otherId, new Date().toISOString()).n, 1, 'nothing moved');

  // Turn Carl off first: the account is flagged while it still leads, and his hours aren't offered.
  await owner('PATCH', `/v1/staff/${coachId}`, { active: false });
  staff = (await owner('GET', '/v1/staff')).body.data;
  assert.equal(staff.find((u) => u.id === coachId).still_leading, true);
  assert.equal((await owner('GET', '/v1/staff/summary')).body.still_leading[0].name, 'Carl Coach');
  assert.ok(!openSlots(app.ctx).some((s) => s.coach_id === coachId));

  const out = (await owner('POST', `/v1/staff/${coachId}/hand-over`, { to: otherId, leave_conflicts: true })).body;
  assert.equal(out.left_with_them, 1);
  assert.equal(out.classes, 1);
  assert.equal(out.hours, 1);
  assert.equal(out.sessions, carl.work.sessions - 1);
  assert.equal(db().get('SELECT coach_id FROM class_series WHERE id = ?', series.id).coach_id, otherId, 'new sessions of the class follow');
  assert.equal(db().get('SELECT coach_id FROM class_sessions WHERE id = ?', first.id).coach_id, coachId, 'the clashing session stays with Carl');
  assert.ok(db().get(`SELECT 1 FROM audit_log WHERE action LIKE 'Handed over Carl Coach''s work to Riley B. Brooks:%' AND actor_name = 'Olivia Owner'`));
  // Past sessions keep who led them; the leftover goes to nobody (hours with nobody would be removed).
  const rest = (await owner('POST', `/v1/staff/${coachId}/hand-over`, { to: null })).body;
  assert.deepEqual([rest.sessions, rest.to, rest.still], [1, null, { sessions: 0, classes: 0, hours: 0, booked_clients: 0 }]);
  assert.equal(db().get('SELECT coach_id FROM class_sessions WHERE id = ?', first.id).coach_id, null);
  assert.equal((await owner('GET', '/v1/staff')).body.data.find((u) => u.id === coachId).still_leading, false);
  assert.equal(clash.coach_id, otherId);
});

test('hours handed to a coach who already has hours at the same time and place are offered once', async () => {
  const sam = createUser(app.ctx, { email: 'sam@test.dev', name: 'Sam Stone', password: 'sam-password-12', role: 'coach' });
  const wd = weekdayOf(day(4));
  for (const coach_id of [otherId, sam.id]) await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekday: wd, start_time: '13:00', end_time: '15:00', coach_id });
  const out = (await owner('POST', `/v1/staff/${sam.id}/hand-over`, { to: otherId })).body;
  assert.equal(out.hours, 1);
  const slots = openSlots(app.ctx).filter((s) => s.coach_id === otherId && weekdayOf(localDate(s.starts_at, TZ)) === wd);
  assert.ok(slots.length >= 2, 'the hours are still offered');
  assert.equal(new Set(slots.map((s) => s.starts_at)).size, slots.length, 'each time once');
});

test('forgot password: the same answer for anyone, a link that works once for 30 minutes, 3 an hour', async () => {
  resetRateLimits();
  const known = await req('POST', '/auth/forgot', { email: 'desk@test.dev' });
  const unknown = await req('POST', '/auth/forgot', { email: 'nobody@test.dev' });
  const off = await req('POST', '/auth/forgot', { email: 'carl@test.dev' });           // turned off above
  assert.deepEqual([known.status, unknown.status, off.status], [200, 200, 200]);
  assert.equal(known.body.minutes, 30);
  assert.deepEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort());
  assert.equal((await req('POST', '/auth/forgot', { email: 'not an email' })).status, 400);
  await wait();
  assert.equal(outbox('nobody@test.dev').length, 0);
  assert.equal(outbox('carl@test.dev').filter((m) => /Reset your/.test(m.subject)).length, 0, 'a turned-off account gets no link');
  const token = resetLink('desk@test.dev');
  assert.ok(token);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?', token).n, 0, 'only a hash is stored');

  const deskOld = await signIn('desk@test.dev', 'desk-password-1');
  assert.equal((await req('POST', '/auth/reset/check', { token })).body.email, 'desk@test.dev');
  assert.equal((await req('POST', '/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await req('POST', '/auth/reset', { token, password: 'desk-password-1' })).status, 400, 'not the current password');
  const done = await req('POST', '/auth/reset', { token, password: 'desk-brand-new-1' });
  assert.equal(done.status, 200);
  assert.equal((await deskOld('GET', '/auth/me')).status, 401, 'every device is signed out');
  assert.equal((await login('desk@test.dev', 'desk-brand-new-1')).status, 200);
  assert.equal((await req('POST', '/auth/reset', { token, password: 'desk-brand-new-2' })).status, 400, 'works once');
  assert.equal((await req('POST', '/auth/reset/check', { token })).body.error.code, 'reset_expired');
  await wait();
  assert.match(outbox('desk@test.dev').at(-1).subject, /password was changed/);

  // Asking again replaces the earlier link; at most 3 links an hour.
  resetRateLimits();
  await req('POST', '/auth/forgot', { email: 'desk@test.dev' }); await wait();
  const a = resetLink('desk@test.dev');
  await req('POST', '/auth/forgot', { email: 'desk@test.dev' }); await wait();
  const b = resetLink('desk@test.dev');
  assert.notEqual(a, b);
  assert.equal((await req('POST', '/auth/reset/check', { token: a })).status, 400, 'the older link stops working');
  await req('POST', '/auth/forgot', { email: 'desk@test.dev' }); await wait();
  const count = outbox('desk@test.dev').filter((m) => /Reset your/.test(m.subject)).length;
  const r4 = await req('POST', '/auth/forgot', { email: 'desk@test.dev' }); await wait();
  assert.equal(r4.status, 200, 'the same answer');
  assert.equal(outbox('desk@test.dev').filter((m) => /Reset your/.test(m.subject)).length, count, 'no fourth email this hour');
  // An owner's reset cancels the open link; so does an expired one.
  const c = resetLink('desk@test.dev');
  assert.equal((await req('POST', '/auth/reset/check', { token: c })).status, 200);
  await owner('POST', `/v1/staff/${deskId}/reset-password`);
  assert.equal((await req('POST', '/auth/reset', { token: c, password: 'desk-hijack-pass-1' })).status, 400, 'the owner\'s reset wins');
  db().run('DELETE FROM password_resets');
  resetRateLimits();
  await req('POST', '/auth/forgot', { email: 'owner@test.dev' }); await wait();
  const e = resetLink('owner@test.dev');
  db().run(`UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z'`);
  assert.equal((await req('POST', '/auth/reset', { token: e, password: 'owner-password-2' })).status, 400);
  // The secret never reaches the audit log.
  assert.ok(!db().all('SELECT * FROM audit_log').some((x) => [token, a, b, c, e].some((t) => JSON.stringify(x).includes(t))));
  assert.ok(db().get(`SELECT 1 FROM audit_log WHERE action = 'POST /auth/forgot' AND actor_name = 'desk@test.dev'`), 'who asked is logged');
  // Per-address limit.
  resetRateLimits();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await req('POST', '/auth/forgot', { email: `x${i}@test.dev` })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
  resetRateLimits();
});

test('the activity log filters by who, staff member, kind, dates and words, and exports a formula-safe CSV', async () => {
  resetRateLimits();
  await login('riley.brooks@test.dev', 'nope-wrong-pass');
  await req('POST', '/auth/login', { email: 'my-secret-password-1', password: 'x' });      // a password typed in the email box
  assert.ok(!db().all('SELECT actor_name FROM audit_log').some((x) => x.actor_name?.includes('my-secret-password-1')), 'only something that looks like an email is logged');
  const tricky = (await owner('POST', '/v1/staff', { name: '=HYPERLINK("http://evil.example","x")', email: 'tricky@test.dev', role: 'coach' })).body;
  await owner('PATCH', `/v1/staff/${tricky.id}`, { active: false });

  const riley = (await owner('GET', `/v1/audit?staff_id=${otherId}`)).body;
  assert.ok(riley.data.some((a) => a.action === 'sign-in' && a.status === 401 && a.actor_name === 'riley.brooks@test.dev'), 'failed sign-ins typed with their email');
  assert.ok(riley.data.every((a) => (a.actor_type === 'staff' && a.actor_id === otherId) || a.actor_type === 'public'));
  const signIns = (await owner('GET', '/v1/audit?kind=sign_ins&limit=5')).body;
  assert.ok(signIns.total > 5 && signIns.data.length === 5);
  assert.ok((await owner('GET', '/v1/audit?who=public')).body.data.every((a) => a.actor_type === 'public'));
  assert.ok((await owner('GET', '/v1/audit?kind=refused')).body.data.every((a) => a.status === 403));
  const words = (await owner('GET', '/v1/audit?q=add%20a%20staff')).body;
  assert.ok(words.data.length >= 1 && words.data.every((a) => a.action === 'POST /v1/staff'), 'matches the plain-English description');
  const today = localDate(new Date().toISOString(), TZ);
  assert.equal((await owner('GET', `/v1/audit?since=${today}&until=${today}`)).body.total, (await owner('GET', '/v1/audit')).body.total);
  assert.equal((await owner('GET', `/v1/audit?until=${addDaysToDate(today, -1)}`)).body.total, 0);
  assert.equal((await owner('GET', '/v1/audit?since=yesterday')).status, 400);
  assert.equal((await owner('GET', '/v1/audit?who=robots')).status, 400);

  const csv = await owner('GET', `/v1/audit/export?staff_id=${ownerId}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="activity-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = csv.body.trim().split('\r\n');
  assert.match(lines[0], /^"When \(UTC\)","When \(America\/Chicago\)","Who"/);
  assert.ok(lines.slice(1).every((l) => l.includes('"Olivia Owner"') || l.includes('"owner@test.dev"')));
  const all = (await owner('GET', '/v1/audit/export?q=tricky')).body;
  assert.ok(!/(^|,)"[=+\-@]/m.test(all), 'no cell starts with a formula character');
  assert.ok(db().get(`SELECT 1 FROM audit_log WHERE action = 'GET /v1/audit/export'`), 'exports are logged');
  const { csvCell } = await import('../src/services/security.js');
  assert.deepEqual(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '  =1+1', 'plain "quoted"'].map(csvCell), ['"\'=1+1"', '"\'+1"', '"\'-1"', '"\'@SUM(A1)"', '"\'\tx"', '"\'  =1+1"', '"plain ""quoted"""']);
  // No one-time password or other secret is ever in the log.
  assert.ok(!db().all('SELECT * FROM audit_log').some((a) => JSON.stringify(a).includes(tricky.temporary_password)));
});

test('coaches and front desk can\'t reach Staff & security', async () => {
  resetRateLimits();
  const riley = await signIn('riley.brooks@test.dev', 'riley-password-1');
  createUser(app.ctx, { email: 'desk2@test.dev', name: 'Dee Desk', password: 'desk2-password-1', role: 'front_desk' });
  const desk = await signIn('desk2@test.dev', 'desk2-password-1');
  for (const who of [riley, desk]) {
    for (const [m, p] of [['GET', '/v1/staff/summary'], ['GET', `/v1/staff/${ownerId}`], ['POST', `/v1/staff/${ownerId}/sign-out`], ['POST', `/v1/staff/${ownerId}/devices/x/sign-out`],
      ['GET', `/v1/staff/${coachId}/hand-over`], ['POST', `/v1/staff/${coachId}/hand-over`], ['GET', '/v1/audit'], ['GET', '/v1/audit/export'], ['PATCH', `/v1/staff/${ownerId}`]]) {
      assert.equal((await who(m, p, m === 'GET' ? null : { to: null })).status, 403, `${m} ${p}`);
    }
    assert.equal((await who('GET', '/auth/account')).status, 200, 'everyone has their own account page');
  }
});
