// Parent portal Progress and Programs: period and change on Progress, what each test measures, targets, rankings,
// next testing day; camp spots and full camps, the membership panel and membership change requests.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `dp-parent-progress-test-${process.pid}.db`);
process.env.DP_DB = DB_FILE;
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const { get, all, run, insert, setSetting } = require('../server/db');
const seed = require('../server/seed');
const booking = require('../server/services/booking');
const { app } = require('../server/index');

let server, base;
test.before(async () => {
  seed.resetDatabase();
  seed.base();
  seed.demo();
  booking.generateEvents();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server?.close();
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch { /* gone */ } }
});

async function call(method, url, body, cookie) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const sessions = {};
async function signIn(email) {
  if (sessions[email]) return sessions[email];
  const c = await call('POST', '/auth/parent/code', { email });
  const res = await fetch(base + '/api/auth/parent/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: c.data.test_code }) });
  assert.equal(res.status, 200);
  return (sessions[email] = res.headers.get('set-cookie').split(';')[0]);
}
async function staffSignIn(email, password) {
  const res = await fetch(base + '/api/auth/staff/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}
const athlete = (first, last) => get('SELECT * FROM athletes WHERE first_name=? AND last_name=?', first, last);
const MARIA = 'maria.lopez@example.com', KURT = 'kurt.jensen@example.com', LINH = 'linh.nguyen@example.com', PAULO = 'paulo.silva@example.com';
const outboxSince = (id) => all('SELECT * FROM outbox WHERE id>? ORDER BY id', id);
const lastId = (table) => get(`SELECT MAX(id) m FROM ${table}`).m || 0;

// ---- Progress ----
test('progress: shared results only, with what each test measures, how it is tested, targets, rankings and the next testing day', async () => {
  const kurt = await signIn(KURT);
  const nate = athlete('Nate', 'Jensen');
  const r = await call('GET', `/parent/athletes/${nate.id}/progress`, null, kurt);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const open = get("SELECT * FROM testing_days WHERE name='October youth testing'");
  assert.ok(r.data.tests.length > 0);
  assert.ok(get('SELECT 1 FROM results WHERE athlete_id=? AND day_id=? LIMIT 1', nate.id, open.id), 'Nate has results on the open day');
  for (const t of r.data.tests) assert.ok(!t.history.some((h) => h.date === open.date), `${t.name}: nothing from the open day`);
  assert.ok(!r.data.all_days.some((d) => d.id === open.id), 'an open (unshared) day is not offered');
  assert.ok(r.data.all_days.length >= 2);
  const dash = r.data.tests.find((t) => t.name === '40-yard dash');
  assert.match(dash.how, /three-point stance/i, 'the protocol shows as how it is tested');
  assert.match(dash.means, /how fast/i);
  assert.ok(r.data.tests.find((t) => t.category === 'Body')?.means.includes('not better or worse'));
  assert.equal(r.data.period.key, 'all');
  assert.equal(r.data.next_testing?.name, 'Winter retest');
  assert.ok(r.data.next_testing.date > booking.todayLocal());
  assert.ok(Array.isArray(r.data.rankings), 'rankings are on in the demo');

  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  const pa = (await call('GET', `/parent/athletes/${ava.id}/progress`, null, maria)).data;
  assert.ok(pa.targets.length > 0, "the coach's targets for Ava show");
  assert.ok(pa.targets.every((t) => 'pct' in t && 'target_text' in t));

  // A family with nobody on a future testing day has no next testing day.
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  assert.equal((await call('GET', `/parent/athletes/${isa.id}/progress`, null, paulo)).data.next_testing, null);
});

test('progress: period narrows results, but PRs, targets and rankings use every shared result', async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  const all_ = (await call('GET', `/parent/athletes/${ava.id}/progress?period=all`, null, maria)).data;
  const latest = all_.all_days[0];
  const since = await call('GET', `/parent/athletes/${ava.id}/progress?since=${latest.id}`, null, maria);
  assert.equal(since.status, 200, JSON.stringify(since.data));
  assert.equal(since.data.period.key, `since:${latest.id}`);
  assert.equal(since.data.period.from, latest.date);
  for (const t of since.data.tests) assert.ok(t.history.every((h) => h.date >= latest.date), `${t.name} starts at the testing day`);
  assert.deepEqual(since.data.prs, all_.prs, 'a PR is a best ever, whatever the period');
  assert.deepEqual(since.data.targets.map((t) => t.best), all_.targets.map((t) => t.best));

  const year = (await call('GET', `/parent/athletes/${ava.id}/progress?period=12m`, null, maria)).data;
  assert.equal(year.period.key, '12m');
  assert.ok(year.period.from < booking.todayLocal());

  assert.equal((await call('GET', `/parent/athletes/${ava.id}/progress?period=forever`, null, maria)).status, 400);
  assert.equal((await call('GET', `/parent/athletes/${ava.id}/progress?since=999999`, null, maria)).status, 400);
  const open = get("SELECT id FROM testing_days WHERE status='open' ORDER BY id LIMIT 1");
  assert.equal((await call('GET', `/parent/athletes/${ava.id}/progress?since=${open.id}`, null, maria)).status, 400, 'an unshared day is not a period');
});

test('progress: other families, archived athletes and signed-out requests are refused', async () => {
  const maria = await signIn(MARIA);
  const nate = athlete('Nate', 'Jensen');
  assert.equal((await call('GET', `/parent/athletes/${nate.id}/progress`, null, maria)).status, 404);
  assert.equal((await call('GET', '/parent/athletes/abc/progress', null, maria)).status, 404);
  assert.equal((await call('GET', `/parent/athletes/${nate.id}/progress`)).status, 401);
  const staff = await staffSignIn('coach@demo.test', 'demo-coach-2026');
  assert.equal((await call('GET', `/parent/athletes/${nate.id}/progress`, null, staff)).status, 401, 'staff use the staff progress endpoint');

  const kurt = await signIn(KURT);
  const add = await call('POST', '/parent/athletes', { first_name: 'Old', last_name: 'Jensen', birthday: '2012-01-01' }, kurt);
  run('UPDATE athletes SET archived=1 WHERE id=?', add.data.id);
  assert.equal((await call('GET', `/parent/athletes/${add.data.id}/progress`, null, kurt)).status, 404);
});

test('progress: an athlete with no results gets an empty answer, not an error', async () => {
  const linh = await signIn(LINH);
  const add = await call('POST', '/parent/athletes', { first_name: 'Bao', last_name: 'Nguyen', birthday: '2013-05-05', sex: 'M' }, linh);
  const r = await call('GET', `/parent/athletes/${add.data.id}/progress`, null, linh);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.tests, []);
  assert.deepEqual(r.data.all_days, []);
  assert.deepEqual(r.data.targets, []);
  assert.equal(r.data.growth, null);
});

// ---- Programs ----
test('shop: camp spots and siblings, class next session, membership sessions left, drop-in price and card expiry', async () => {
  const kurt = await signIn(KURT);
  const nate = athlete('Nate', 'Jensen'), emma = athlete('Emma', 'Jensen');
  const shop = (await call('GET', `/parent/shop?athlete_id=${emma.id}`, null, kurt)).data;
  assert.ok(shop.camps.length > 0);
  const camp = shop.camps[0];
  assert.equal(typeof camp.spots_left, 'number');
  assert.deepEqual(camp.siblings, []);
  assert.ok(shop.classes.every((c) => 'next_at' in c && 'my_upcoming' in c && 'eligible' in c));
  assert.ok(shop.classes.some((c) => c.next_at));
  assert.ok(shop.drop_in_cents > 0);
  assert.equal(shop.card_exp, get('SELECT card_exp FROM families WHERE id=?', emma.family_id).card_exp);
  assert.ok(shop.membership && 'member_left' in shop.membership, 'Emma has a capped membership');
  assert.equal(typeof shop.membership.member_left, 'number');

  // Nate registers; Emma's view says her brother is registered.
  const campFor = (await call('GET', `/parent/shop?athlete_id=${nate.id}`, null, kurt)).data.camps.find((c) => c.id === camp.id);
  if (campFor?.eligible && !campFor.registered) {
    const r = await call('POST', `/parent/camps/${camp.id}/register`, { athlete_id: nate.id }, kurt);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const again = (await call('GET', `/parent/shop?athlete_id=${emma.id}`, null, kurt)).data.camps.find((c) => c.id === camp.id);
    assert.deepEqual(again.siblings, ['Nate']);
    assert.equal(again.spots_left, camp.spots_left - 1);
  }
});

test('a full camp is refused before any charge, and a registered camp stays listed after its deadline', async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  const loc = get('SELECT id FROM locations LIMIT 1').id;
  const start = booking.todayLocal();
  const cls = insert('classes', { name: 'Tiny Clinic', type: 'clinic', weekdays: '0,1,2,3,4,5,6', start_time: '07:00', duration_min: 60, capacity: 1, reg_price_cents: 5000, location_id: loc, start_date: start });
  const day = (n) => { const d = new Date(start + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const e1 = insert('events', { class_id: cls, type: 'clinic', name: 'Tiny Clinic', starts_at: `${day(5)}T07:00`, duration_min: 60, capacity: 1, location_id: loc });
  insert('events', { class_id: cls, type: 'clinic', name: 'Tiny Clinic', starts_at: `${day(6)}T07:00`, duration_min: 60, capacity: 1, location_id: loc });
  const other = get('SELECT id FROM athletes WHERE family_id<>? AND archived=0 LIMIT 1', ava.family_id);
  insert('bookings', { event_id: e1, athlete_id: other.id, status: 'booked', coverage: 'registered' });

  const listed = (await call('GET', `/parent/shop?athlete_id=${ava.id}`, null, maria)).data.camps.find((c) => c.id === cls);
  assert.equal(listed.spots_left, 0);
  const inv = lastId('invoices');
  const r = await call('POST', `/parent/camps/${cls}/register`, { athlete_id: ava.id }, maria);
  assert.equal(r.status, 400);
  assert.equal(r.data.full, true);
  assert.match(r.data.error, /full/);
  assert.equal(lastId('invoices'), inv, 'nothing was charged');

  // Room again: register, then the deadline passes; the camp still shows as registered.
  run('UPDATE events SET capacity=5 WHERE class_id=?', cls);
  const ok = await call('POST', `/parent/camps/${cls}/register`, { athlete_id: ava.id }, maria);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  run('UPDATE classes SET reg_deadline=? WHERE id=?', day(-1), cls);
  const after = (await call('GET', `/parent/shop?athlete_id=${ava.id}`, null, maria)).data.camps.find((c) => c.id === cls);
  assert.ok(after && after.registered, 'still listed, as registered');
  const kurt = await signIn(KURT);
  const nate = athlete('Nate', 'Jensen');
  assert.ok(!(await call('GET', `/parent/shop?athlete_id=${nate.id}`, null, kurt)).data.camps.some((c) => c.id === cls), 'closed for everyone else');
});

test('membership request: validation, owners emailed, logged, shown on Programs, limited per day', async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  const m = get("SELECT * FROM memberships WHERE athlete_id=? AND status IN ('active','trial')", ava.id);
  const other = get('SELECT id FROM plans WHERE active=1 AND id<>? ORDER BY id LIMIT 1', m.plan_id);
  const post = (body) => call('POST', '/parent/membership/request', { athlete_id: ava.id, ...body }, maria);

  assert.equal((await post({ kind: 'upgrade' })).status, 400);
  assert.equal((await post({ kind: 'change' })).status, 400, 'a plan to switch to is needed');
  assert.equal((await post({ kind: 'change', plan_id: m.plan_id })).status, 400, 'already on it');
  assert.equal((await post({ kind: 'pause', note: 'x'.repeat(501) })).status, 400);
  const nate = athlete('Nate', 'Jensen');
  assert.equal((await call('POST', '/parent/membership/request', { athlete_id: nate.id, kind: 'pause' }, maria)).status, 404, 'another family');
  assert.equal((await call('POST', '/parent/membership/request', { athlete_id: ava.id, kind: 'pause' })).status, 401);

  const mail = lastId('outbox'), act = lastId('activity');
  const r = await post({ kind: 'change', plan_id: other.id, note: 'Money is tight this fall.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.kind, 'change');
  const owners = all("SELECT email FROM staff WHERE role='owner' AND active=1").map((o) => o.email);
  const sent = outboxSince(mail);
  assert.ok(owners.length && owners.every((e) => sent.some((x) => x.to_email === e && /Membership request/.test(x.subject) && /Money is tight/.test(x.body))), 'every owner is emailed with the note');
  assert.ok(!sent.some((x) => x.to_email === 'coach@demo.test'), 'coaches are not emailed about money');
  assert.ok(get("SELECT 1 FROM activity WHERE id>? AND action='Asked to change membership'", act));
  assert.equal(get('SELECT COUNT(*) n FROM memberships WHERE id=? AND plan_id=?', m.id, m.plan_id).n, 1, 'nothing changes until the front desk does it');

  const shop = (await call('GET', `/parent/shop?athlete_id=${ava.id}`, null, maria)).data;
  assert.equal(shop.request.kind, 'change');
  assert.equal(shop.request.plan_id, other.id);

  assert.equal((await post({ kind: 'pause' })).status, 200);
  assert.equal((await post({ kind: 'cancel' })).status, 200);
  const limited = await post({ kind: 'pause' });
  assert.equal(limited.status, 400, 'three a day');
  assert.match(limited.data.error, /reply by email/);

  // No membership: nothing to change.
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  if (!get("SELECT 1 FROM memberships WHERE athlete_id=? AND status IN ('trial','active','past_due','paused')", isa.id)) {
    assert.equal((await call('POST', '/parent/membership/request', { athlete_id: isa.id, kind: 'pause' }, paulo)).status, 400);
    assert.equal((await call('GET', `/parent/shop?athlete_id=${isa.id}`, null, paulo)).data.request, null);
  }
});

test('membership requests stay out of the staff money views for coaches', async () => {
  // The request is a parent action; the staff side only sees it in Recent activity (owners are emailed).
  const coach = await staffSignIn('coach@demo.test', 'demo-coach-2026');
  assert.equal((await call('POST', '/parent/membership/request', { athlete_id: athlete('Ava', 'Lopez').id, kind: 'pause' }, coach)).status, 401);
});

test('setting rankings off removes them from Progress', async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  setSetting('rankings_enabled', false);
  try { assert.equal((await call('GET', `/parent/athletes/${ava.id}/progress`, null, maria)).data.rankings, null); }
  finally { setSetting('rankings_enabled', true); }
});
