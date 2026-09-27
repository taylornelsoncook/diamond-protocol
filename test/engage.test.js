// Accountability, performance and education: athlete link, parent portal, coach side, and who can do what.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `dp-engage-test-${process.pid}.db`);
process.env.DP_DB = DB_FILE;
for (const k of ['DP_EMAIL_WEBHOOK', 'RESEND_API_KEY', 'DP_EMAIL_ONLY_TO', 'STRIPE_SECRET_KEY']) delete process.env[k];

const { get, all, run, setting, setSetting } = require('../server/db');
const seed = require('../server/seed');
const { app } = require('../server/index');

let server, base;
test.before(async () => {
  seed.resetDatabase(); seed.base(); seed.demo();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch { /* gone */ } } });

async function call(method, url, body, cookie) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
const cookieOf = (r) => r.res.headers.get('set-cookie').split(';')[0];
const staff = async (email, password) => cookieOf(await call('POST', '/auth/staff/login', { email, password }));
async function parent(email) {
  const c = await call('POST', '/auth/parent/code', { email });
  return cookieOf(await call('POST', '/auth/parent/verify', { email, code: c.data.test_code }));
}
const A = (first) => get('SELECT * FROM athletes WHERE first_name=?', first);

test('the athlete link shows all three tabs and takes a daily check-in', async () => {
  const ava = A('Ava');
  const r = await call('GET', `/w/${ava.workout_token}/engage`);
  assert.equal(r.status, 200);
  assert.ok(r.data.accountability.goals.length >= 3);
  assert.ok(r.data.performance.targets.find((t) => t.test === 'Standing broad jump'));
  assert.equal(r.data.education.assigned[0].title, 'Recovery basics');

  let c = await call('POST', `/w/${ava.workout_token}/checkin`, { sleep_hours: 5, soreness: 5, energy: 3, mood: 4, hydration: 3 });
  assert.equal(c.status, 200);
  assert.deepEqual(c.data.flags, ['Slept 5 hours', 'Soreness 5 of 5']);
  c = await call('POST', `/w/${ava.workout_token}/checkin`, { sleep_hours: 9, soreness: 2 }); // same day: updates, doesn't duplicate
  assert.equal(get('SELECT COUNT(*) n FROM checkins WHERE athlete_id=? AND date=?', ava.id, c.data.date).n, 1);
  assert.equal((await call('POST', `/w/${ava.workout_token}/checkin`, { soreness: 9 })).status, 400);
  assert.equal((await call('POST', `/w/${ava.workout_token}/checkin`, {})).status, 400);
  assert.equal((await call('GET', '/w/not-a-real-token/engage')).status, 404);
});

test('custom goals are ticked by the athlete; automatic goals count themselves', async () => {
  const ava = A('Ava');
  const goals = (await call('GET', `/w/${ava.workout_token}/engage`)).data.accountability.goals;
  const custom = goals.find((g) => g.kind === 'custom');
  const auto = goals.find((g) => g.kind === 'workouts');
  let r = await call('POST', `/w/${ava.workout_token}/goals/${custom.id}/check`, { done: true });
  assert.equal(r.data.progress, custom.progress + 1);
  assert.equal(r.data.checked_today, true);
  r = await call('POST', `/w/${ava.workout_token}/goals/${custom.id}/check`, { done: true }); // twice in a day counts once
  assert.equal(r.data.progress, custom.progress + 1);
  assert.equal((await call('POST', `/w/${ava.workout_token}/goals/${auto.id}/check`, { done: true })).status, 400);
  // Someone else's goal can't be ticked.
  const chidi = A('Chidi');
  assert.equal((await call('POST', `/w/${chidi.workout_token}/goals/${custom.id}/check`, { done: true })).status, 404);
});

test('messages: coach sends, athlete sees them unread, opening marks them read; team messages reach the roster', async () => {
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const ava = A('Ava');
  const before = get('SELECT COUNT(*) n FROM outbox').n;
  assert.equal((await call('POST', `/athletes/${ava.id}/messages`, { body: 'Nice work today.' }, coach)).status, 201);
  assert.ok(get('SELECT COUNT(*) n FROM outbox').n > before, 'parents are emailed');
  let acc = (await call('GET', `/w/${ava.workout_token}/engage`)).data.accountability;
  assert.equal(acc.messages[0].body, 'Nice work today.');
  assert.ok(acc.unread >= 1);
  await call('POST', `/w/${ava.workout_token}/messages/read`, {});
  acc = (await call('GET', `/w/${ava.workout_token}/engage`)).data.accountability;
  assert.equal(acc.unread, 0);

  const team = get('SELECT * FROM team_contracts ORDER BY id LIMIT 1');
  const player = get('SELECT * FROM athletes WHERE team_id=? LIMIT 1', team.id);
  await call('POST', `/teams/${team.id}/messages`, { body: 'Bring water Thursday.' }, coach);
  acc = (await call('GET', `/w/${player.workout_token}/engage`)).data.accountability;
  assert.ok(acc.messages.find((m) => m.body === 'Bring water Thursday.' && m.team));
  assert.equal((await call('POST', `/athletes/${ava.id}/messages`, { body: '  ' }, coach)).status, 400);
});

test('front desk can view but not manage; coaches manage', async () => {
  const desk = await staff('desk@demo.test', 'demo-desk-2026');
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const ava = A('Ava');
  assert.equal((await call('GET', `/athletes/${ava.id}/engage`, null, desk)).status, 200);
  assert.equal((await call('GET', '/education', null, desk)).status, 200);
  assert.equal((await call('POST', `/athletes/${ava.id}/goals`, { kind: 'workouts', target: 2 }, desk)).status, 403);
  assert.equal((await call('POST', `/athletes/${ava.id}/messages`, { body: 'hi' }, desk)).status, 403);
  assert.equal((await call('POST', '/lessons', { title: 'x' }, desk)).status, 403);
  assert.equal((await call('PUT', '/engage/settings', { rankings_enabled: false }, desk)).status, 403);
  const g = await call('POST', `/athletes/${ava.id}/goals`, { kind: 'sessions', target: 2 }, coach);
  assert.equal(g.status, 201);
  assert.equal((await call('POST', `/athletes/${ava.id}/goals`, { kind: 'sessions', target: 40 }, coach)).status, 400);
  await call('PUT', `/goals/${g.data.id}`, { active: false }, coach);
  const goals = (await call('GET', `/w/${ava.workout_token}/engage`)).data.accountability.goals;
  assert.ok(!goals.find((x) => x.id === g.data.id), 'ended goals disappear');
  assert.equal((await call('GET', `/athletes/${ava.id}/engage`)).status, 401);
});

test('targets accept feet and inches, and rankings follow the setting without naming anyone', async () => {
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const ava = A('Ava');
  const broad = get("SELECT id FROM tests WHERE name='Standing broad jump'");
  assert.equal((await call('POST', `/athletes/${ava.id}/targets`, { test_id: broad.id, target: `7'0"` }, coach)).status, 201);
  let perf = (await call('GET', `/w/${ava.workout_token}/engage`)).data.performance;
  const t = perf.targets.find((x) => x.test_id === broad.id);
  assert.equal(t.target, 84);
  assert.equal(t.target_text, '7′ 0″');
  assert.ok(t.pct > 0 && t.pct < 100);
  assert.equal((await call('POST', `/athletes/${ava.id}/targets`, { test_id: broad.id, target: 'far' }, coach)).status, 400);

  assert.ok(Array.isArray(perf.rankings) && perf.rankings.length > 0);
  const text = JSON.stringify(perf.rankings);
  for (const other of all("SELECT first_name FROM athletes WHERE first_name<>'Ava'")) assert.ok(!text.includes(other.first_name), 'no other names in rankings');
  await call('PUT', '/engage/settings', { rankings_enabled: false }, coach);
  perf = (await call('GET', `/w/${ava.workout_token}/engage`)).data.performance;
  assert.equal(perf.rankings, null);
  await call('PUT', '/engage/settings', { rankings_enabled: true }, coach);
});

test('education: lessons, courses, assignments and completion, with unpublished lessons hidden', async () => {
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const ava = A('Ava');
  const c = await call('POST', '/courses', { title: 'Speed school', description: 'Run faster.' }, coach);
  const l1 = await call('POST', '/lessons', { title: 'Arm action', body: 'Cheek to pocket.', course_id: c.data.id }, coach);
  const l2 = await call('POST', '/lessons', { title: 'Shin angles', body: 'Push the ground back.', course_id: c.data.id }, coach);
  const hidden = await call('POST', '/lessons', { title: 'Draft', published: false }, coach);
  assert.equal((await call('POST', '/lessons', { title: 'Bad video', video_url: 'javascript:alert(1)' }, coach)).status, 400);
  assert.equal((await call('POST', '/assignments', { course_id: c.data.id, athlete_id: ava.id, due_date: '2026-12-01' }, coach)).status, 201);
  assert.equal((await call('POST', '/assignments', { lesson_id: l1.data.id, course_id: c.data.id, athlete_id: ava.id }, coach)).status, 400);

  let edu = (await call('GET', `/w/${ava.workout_token}/engage`)).data.education;
  const course = edu.courses.find((x) => x.id === c.data.id);
  assert.deepEqual([course.done, course.total], [0, 2]);
  assert.ok(!JSON.stringify(edu).includes('"Draft"'));
  assert.equal((await call('GET', `/w/${ava.workout_token}/lessons/${hidden.data.id}`)).status, 404);

  const first = await call('GET', `/w/${ava.workout_token}/lessons/${l1.data.id}`);
  assert.equal(first.data.next.id, l2.data.id);
  assert.deepEqual(first.data.position, { n: 1, of: 2 });
  await call('POST', `/w/${ava.workout_token}/lessons/${l1.data.id}/complete`, { done: true });
  await call('POST', `/w/${ava.workout_token}/lessons/${l2.data.id}/complete`, { done: true });
  edu = (await call('GET', `/w/${ava.workout_token}/engage`)).data.education;
  assert.equal(edu.assigned.find((x) => x.course_id === c.data.id).done, true);
  const report = (await call('GET', '/education', null, coach)).data;
  const row = report.assignments.find((x) => x.course_id === c.data.id);
  assert.deepEqual([row.finished, row.total], [1, 1]);
});

test('parents see only their own athletes, and can check in and complete lessons for them', async () => {
  const maria = await parent('maria.lopez@example.com');
  const ava = A('Ava'), chidi = A('Chidi');
  const r = await call('GET', `/parent/athletes/${ava.id}/engage`, null, maria);
  assert.equal(r.status, 200);
  assert.equal(r.data.athlete.first_name, 'Ava');
  assert.equal((await call('GET', `/parent/athletes/${chidi.id}/engage`, null, maria)).status, 404);
  assert.equal((await call('POST', `/parent/athletes/${chidi.id}/checkin`, { mood: 3 }, maria)).status, 404);
  assert.equal((await call('POST', `/parent/athletes/${ava.id}/checkin`, { mood: 4, energy: 4 }, maria)).status, 200);
  const lesson = get('SELECT id FROM lessons WHERE published=1 LIMIT 1');
  assert.equal((await call('POST', `/parent/athletes/${ava.id}/lessons/${lesson.id}/complete`, { done: true }, maria)).status, 200);
  assert.equal((await call('GET', `/parent/athletes/${ava.id}/engage`)).status, 401);
});

test('parent-facing performance hides results from unshared testing days', async () => {
  const maria = await parent('maria.lopez@example.com');
  const ava = A('Ava');
  const day = get("SELECT * FROM testing_days WHERE status='open' ORDER BY id LIMIT 1");
  const test40 = get("SELECT id FROM tests WHERE name='Vertical jump'");
  run('INSERT INTO results (athlete_id, test_id, day_id, attempt, value) VALUES (?,?,?,?,?)', ava.id, test40.id, day.id, 9, 40);
  setSetting('results_visibility', 'shared');
  const parentView = (await call('GET', `/parent/athletes/${ava.id}/engage`, null, maria)).data.performance;
  const vj = parentView.tests.find((t) => t.name === 'Vertical jump');
  assert.ok(!vj || vj.best !== 40, 'unshared result stays hidden from the parent');
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const staffView = (await call('GET', `/athletes/${ava.id}/engage`, null, coach)).data;
  assert.equal(staffView.tests.find((t) => t.name === 'Vertical jump').best, 40);
  void setting;
});

test('Today flags athletes whose latest check-in needs attention', async () => {
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const flags = (await call('GET', '/checkins/flags', null, coach)).data;
  assert.ok(flags.find((f) => f.name === 'Chidi Okafor' && f.flags.includes('Slept 5.5 hours')));
});

// ---- tab upgrades: missed days, goal history, replies, separate parent reads, day details, target gaps ----
const eng = require('../server/services/engage');
const { todayLocal } = require('../server/services/booking');
const { addDays } = require('../server/lib');

test('custom goals can be ticked for an earlier day this week, never a future day or last week', async () => {
  const ava = A('Ava');
  const T = todayLocal(), ws = eng.weekStart(T);
  const custom = (await call('GET', `/w/${ava.workout_token}/engage`)).data.accountability.goals.find((g) => g.kind === 'custom');
  assert.ok(Array.isArray(custom.checked_days));
  if (ws < T) {
    const r = await call('POST', `/w/${ava.workout_token}/goals/${custom.id}/check`, { done: true, date: ws });
    assert.equal(r.status, 200);
    assert.ok(r.data.checked_days.includes(ws));
    const off = await call('POST', `/w/${ava.workout_token}/goals/${custom.id}/check`, { done: false, date: ws });
    assert.ok(!off.data.checked_days.includes(ws));
  }
  assert.equal((await call('POST', `/w/${ava.workout_token}/goals/${custom.id}/check`, { done: true, date: addDays(T, 1) })).status, 400);
  assert.equal((await call('POST', `/w/${ava.workout_token}/goals/${custom.id}/check`, { done: true, date: addDays(ws, -1) })).status, 400);
  assert.equal((await call('POST', `/w/${ava.workout_token}/goals/${custom.id}/check`, { done: true, date: '2026-02-31' })).status, 400);
  const maria = await parent('maria.lopez@example.com');
  assert.equal((await call('POST', `/parent/athletes/${ava.id}/goals/${custom.id}/check`, { done: true, date: addDays(T, 2) }, maria)).status, 400);
});

test('goals report last week and how many weeks in a row they were met', async () => {
  const ava = A('Ava');
  const goals = (await call('GET', `/w/${ava.workout_token}/engage`)).data.accountability.goals;
  const mobility = goals.find((g) => g.kind === 'custom');
  // Seeded: met 4 of 4 in each of the three weeks before this one.
  assert.deepEqual(mobility.last_week, { progress: 4, target: 4, met: true });
  assert.ok(mobility.streak >= 3);
  // A goal set this week has no history yet.
  const fresh = goals.find((g) => g.kind === 'workouts');
  assert.equal(fresh.last_week, null);
});

test('a parent reading messages does not clear them for the athlete', async () => {
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const maria = await parent('maria.lopez@example.com');
  const ava = A('Ava');
  await call('POST', `/w/${ava.workout_token}/messages/read`, {});
  await call('POST', `/parent/athletes/${ava.id}/messages/read`, {}, maria);
  await call('POST', `/athletes/${ava.id}/messages`, { body: 'Film from Saturday is up.' }, coach);
  let p = (await call('GET', `/parent/athletes/${ava.id}/engage`, null, maria)).data.accountability;
  assert.equal(p.unread, 1);
  await call('POST', `/parent/athletes/${ava.id}/messages/read`, {}, maria);
  p = (await call('GET', `/parent/athletes/${ava.id}/engage`, null, maria)).data.accountability;
  assert.equal(p.unread, 0, 'read for the parent');
  const mine = (await call('GET', `/w/${ava.workout_token}/engage`)).data.accountability;
  assert.equal(mine.unread, 1, 'still new for the athlete');
  const staffView = (await call('GET', `/athletes/${ava.id}/engage`, null, coach)).data;
  assert.equal(staffView.unread, 1, 'the coach sees whether the athlete read it');
  await call('POST', `/w/${ava.workout_token}/messages/read`, {});
  assert.equal((await call('GET', `/w/${ava.workout_token}/engage`)).data.accountability.unread, 0);
});

test('athletes and parents reply to a coach message; the coach is emailed and it is logged', async () => {
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const maria = await parent('maria.lopez@example.com');
  const ava = A('Ava'), chidi = A('Chidi');
  const coachRow = get("SELECT * FROM staff WHERE email='coach@demo.test'");
  const sent = await call('POST', `/athletes/${ava.id}/messages`, { body: 'How did the new cleats feel?' }, coach);
  const mid = sent.data.id;
  const before = get('SELECT COUNT(*) n FROM outbox WHERE to_email=?', coachRow.email)?.n;
  const r = await call('POST', `/w/${ava.workout_token}/messages/${mid}/reply`, { body: '  Much better, no blisters.  ' });
  assert.equal(r.status, 201);
  assert.equal(r.data.emailed, true);
  const msg = r.data.messages.find((m) => m.id === mid);
  assert.deepEqual(msg.replies.map((x) => [x.body, x.from]), [['Much better, no blisters.', 'athlete']]);
  assert.equal(get('SELECT COUNT(*) n FROM outbox WHERE to_email=?', coachRow.email).n, before + 1);
  assert.ok(get("SELECT * FROM activity WHERE actor='Ava Lopez (athlete)' AND action LIKE 'Replied to%' ORDER BY id DESC LIMIT 1"));

  const pr = await call('POST', `/parent/athletes/${ava.id}/messages/${mid}/reply`, { body: 'She wants a second pair.' }, maria);
  assert.equal(pr.status, 201);
  const thread = pr.data.messages.find((m) => m.id === mid).replies;
  assert.equal(thread[1].from, 'parent');
  assert.equal(thread[1].parent, get("SELECT name FROM parents WHERE email='maria.lopez@example.com'").name);
  assert.ok(get("SELECT * FROM activity WHERE actor LIKE '%(parent)' AND action LIKE '%replied%' ORDER BY id DESC LIMIT 1"));
  // The coach sees the replies on the client profile data.
  const staffView = (await call('GET', `/athletes/${ava.id}/engage`, null, coach)).data;
  assert.equal(staffView.messages.find((m) => m.id === mid).replies.length, 2);

  assert.equal((await call('POST', `/w/${ava.workout_token}/messages/${mid}/reply`, { body: '   ' })).status, 400);
  assert.equal((await call('POST', `/w/${ava.workout_token}/messages/${mid}/reply`, { body: 'x'.repeat(1001) })).status, 400);
  assert.equal((await call('POST', `/w/${chidi.workout_token}/messages/${mid}/reply`, { body: 'Not mine' })).status, 404);
  const chidiParent = get('SELECT p.email FROM parents p JOIN athletes a ON a.family_id=p.family_id WHERE a.id=?', chidi.id);
  if (chidiParent) {
    const other = await parent(chidiParent.email);
    assert.equal((await call('POST', `/parent/athletes/${ava.id}/messages/${mid}/reply`, { body: 'hi' }, other)).status, 404);
  }
  assert.equal((await call('POST', `/parent/athletes/${ava.id}/messages/${mid}/reply`, { body: 'hi' })).status, 401);
  // No more than 20 replies a day.
  const n = get("SELECT COUNT(*) n FROM message_replies WHERE athlete_id=? AND created_at >= datetime('now','-1 day')", ava.id).n;
  for (let i = n; i < 20; i++) assert.equal((await call('POST', `/w/${ava.workout_token}/messages/${mid}/reply`, { body: `ok ${i}` })).status, 201);
  const over = await call('POST', `/w/${ava.workout_token}/messages/${mid}/reply`, { body: 'one more' });
  assert.equal(over.status, 400);
  run('DELETE FROM message_replies WHERE athlete_id=?', ava.id);
});

test('the calendar says what happened each day, and check-in streaks keep a best', async () => {
  const ava = A('Ava');
  const acc = (await call('GET', `/w/${ava.workout_token}/engage`)).data.accountability;
  const trained = acc.calendar.filter((d) => d.trained);
  assert.ok(trained.length);
  for (const d of trained) assert.ok(d.workouts.length + d.sessions.length > 0, `${d.date} names what was done`);
  const checked = acc.calendar.find((d) => d.checked_in);
  assert.ok(checked.checkin && 'sleep_hours' in checked.checkin && Array.isArray(checked.checkin.flags));
  assert.ok(acc.streaks.checkin_best >= acc.streaks.checkin_days);
  assert.equal(eng.bestCheckinStreak(ava.id), acc.streaks.checkin_best);
});

test('targets say how far there is to go; due dates are checked; removing one checks it exists', async () => {
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const desk = await staff('desk@demo.test', 'demo-desk-2026');
  const ava = A('Ava');
  const sprint = get("SELECT id FROM tests WHERE name='20-yard sprint'");
  assert.equal((await call('POST', `/athletes/${ava.id}/targets`, { test_id: sprint.id, target: '3.35', due_date: 'next spring' }, coach)).status, 400);
  assert.equal((await call('POST', `/athletes/${ava.id}/targets`, { test_id: sprint.id, target: '3.35', due_date: '2026-13-01' }, coach)).status, 400);
  // The same check guards assignment due dates: a month 13 used to crash with a server error.
  const lesson = get('SELECT id FROM lessons WHERE published=1 AND id NOT IN (SELECT lesson_id FROM assignments WHERE athlete_id=? AND lesson_id IS NOT NULL) LIMIT 1', ava.id);
  const bad = await call('POST', '/assignments', { lesson_id: lesson.id, athlete_id: ava.id, due_date: '2026-13-01' }, coach);
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error || bad.data.message, 'Pick a due date.');
  assert.equal((await call('POST', `/athletes/${ava.id}/targets`, { test_id: sprint.id, target: '3.35', due_date: '' }, coach)).status, 201);
  const t = (await call('GET', `/w/${ava.workout_token}/engage`)).data.performance.targets.find((x) => x.test_id === sprint.id);
  if (!t.reached && t.best != null) assert.match(t.to_go_text, /^\d+(\.\d+)? s to go$/);
  assert.equal(t.overdue, false);
  assert.equal(eng.gapText(78, 80, 'in', false), '2 in to go');
  assert.equal(eng.gapText(3.48, 3.35, 's', true), '0.13 s to go');
  assert.equal(eng.gapText(60, 80, 'in', false), '1 ft 8 in to go');
  assert.equal(eng.gapText(82, 80, 'in', false), null);
  assert.equal((await call('DELETE', `/targets/${t.id}`, null, desk)).status, 403);
  assert.equal((await call('DELETE', `/targets/${t.id}`, null, coach)).status, 200);
  assert.equal((await call('DELETE', `/targets/${t.id}`, null, coach)).status, 404);
  assert.ok(get("SELECT * FROM activity WHERE action='Removed a test target' ORDER BY id DESC LIMIT 1").detail.includes('20-yard sprint'));
});

// ---- review fixes ----
test('a workout finished in the evening counts on the local day, not the next UTC day', async () => {
  const chidi = A('Chidi');
  const T = todayLocal();
  const tz = setting('timezone', 'America/Denver');
  const localOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  // An hour that is still today in the business zone but already tomorrow in UTC (evening in Provo).
  let when = null;
  for (let h = 0; h < 48 && !when; h++) { const d = new Date(Date.parse(`${T}T00:00:00Z`) + h * 3600e3); if (localOf(d) === T && d.toISOString().slice(0, 10) > T) when = d; }
  assert.ok(when, 'the business zone is behind UTC');
  const day = get('SELECT pd.id, pd.title FROM program_days pd LIMIT 1');
  const utc = when.toISOString().slice(0, 19).replace('T', ' ');
  const before = (await call('GET', `/w/${chidi.workout_token}/engage`)).data.accountability;
  const id = require('../server/db').insert('workout_logs', { athlete_id: chidi.id, day_id: day.id, finished_at: utc });
  const acc = (await call('GET', `/w/${chidi.workout_token}/engage`)).data.accountability;
  const today = acc.calendar.find((d) => d.date === T);
  assert.equal(today.trained, true);
  assert.equal(today.workouts.length, before.calendar.find((d) => d.date === T).workouts.length + 1);
  assert.equal(acc.this_week.workouts, before.this_week.workouts + 1);
  run('DELETE FROM workout_logs WHERE id=?', id);
});

test('replies are logged under the athlete or parent who wrote them', async () => {
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const maria = await parent('maria.lopez@example.com');
  const ava = A('Ava');
  const mid = (await call('POST', `/athletes/${ava.id}/messages`, { body: 'Bring your glove Thursday.' }, coach)).data.id;
  assert.equal((await call('POST', `/w/${ava.workout_token}/messages/${mid}/reply`, { body: 'Will do.' })).status, 201);
  const a1 = get('SELECT * FROM activity ORDER BY id DESC LIMIT 1');
  assert.equal(a1.actor, 'Ava Lopez (athlete)');
  assert.equal(a1.action, 'Replied to Chris');
  assert.equal(a1.detail, 'Will do.');
  assert.equal((await call('POST', `/parent/athletes/${ava.id}/messages/${mid}/reply`, { body: 'She will.' }, maria)).status, 201);
  const a2 = get('SELECT * FROM activity ORDER BY id DESC LIMIT 1');
  assert.match(a2.actor, /\(parent\)$/);
  assert.equal(a2.action, 'Replied to Chris about Ava Lopez');
  // A reply must be text.
  assert.equal((await call('POST', `/w/${ava.workout_token}/messages/${mid}/reply`, { body: { nope: 1 } })).status, 400);
  run('DELETE FROM message_replies WHERE athlete_id=?', ava.id);
});

test('targets never say "12 in" when the gap rounds up to a whole foot', () => {
  assert.equal(eng.gapText(56.04, 80, 'in', false), '2 ft to go');
  assert.equal(eng.gapText(60, 80, 'in', false), '1 ft 8 in to go');
  assert.equal(eng.gapText(67.5, 80, 'in', false), '1 ft 0.5 in to go');
});

test('on upgrade, messages already read stay read for the family\'s parents', async () => {
  const coach = await staff('coach@demo.test', 'demo-coach-2026');
  const maria = await parent('maria.lopez@example.com');
  const ava = A('Ava');
  await call('POST', `/athletes/${ava.id}/messages`, { body: 'Old message, read before parents had their own reads.' }, coach);
  await call('POST', `/w/${ava.workout_token}/messages/read`, {});
  run('DELETE FROM parent_message_reads');
  assert.ok((await call('GET', `/parent/athletes/${ava.id}/engage`, null, maria)).data.accountability.unread > 0);
  eng.backfillParentReads();
  assert.equal((await call('GET', `/parent/athletes/${ava.id}/engage`, null, maria)).data.accountability.unread, 0);
  eng.backfillParentReads(); // safe to run twice
});

test('athlete-link posts with no body get an answer, not a server error', async () => {
  const ava = A('Ava');
  const mid = get('SELECT id FROM coach_messages WHERE athlete_id=? ORDER BY id DESC LIMIT 1', ava.id).id;
  const post = (url) => fetch(`${base}/api${url}`, { method: 'POST' }).then((r) => r.status);
  assert.equal(await post(`/w/${ava.workout_token}/messages/${mid}/reply`), 400);
  assert.equal(await post(`/w/${ava.workout_token}/checkin`), 400);
  assert.equal(await post(`/w/nope/messages/${mid}/reply`), 404);
});
