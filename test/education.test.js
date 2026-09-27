// Coach Education screen: validation, assigning (one, several, a team), reminders, open/finished tracking, and who can do what.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `dp-education-test-${process.pid}.db`);
process.env.DP_DB = DB_FILE;
for (const k of ['DP_EMAIL_WEBHOOK', 'RESEND_API_KEY', 'DP_EMAIL_ONLY_TO', 'STRIPE_SECRET_KEY']) delete process.env[k];

const { get, all, run } = require('../server/db');
const seed = require('../server/seed');
const { app } = require('../server/index');
const { addDays } = require('../server/lib');
const { todayLocal } = require('../server/services/booking');

let server, base, coach, desk, owner;
test.before(async () => {
  seed.resetDatabase(); seed.base(); seed.demo();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  coach = await staff('coach@demo.test', 'demo-coach-2026');
  desk = await staff('desk@demo.test', 'demo-desk-2026');
  owner = await staff('owner@demo.test', 'demo-owner-2026');
});
test.after(() => { server?.close(); for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch { /* gone */ } } });

async function call(method, url, body, cookie) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
async function staff(email, password) {
  const r = await call('POST', '/auth/staff/login', { email, password });
  return r.res.headers.get('set-cookie').split(';')[0];
}
const A = (first) => get('SELECT * FROM athletes WHERE first_name=?', first);
const lastActivity = () => get('SELECT * FROM activity ORDER BY id DESC LIMIT 1');
const outboxSince = (id) => all('SELECT * FROM outbox WHERE id>? ORDER BY id', id);
const outboxTop = () => get('SELECT MAX(id) m FROM outbox').m || 0;

test('lesson and course input is checked on the server', async () => {
  assert.equal((await call('POST', '/lessons', { title: 'x'.repeat(121) }, coach)).status, 400);
  assert.equal((await call('POST', '/lessons', { title: 'Ok', minutes: 'abc' }, coach)).status, 400);
  assert.equal((await call('POST', '/lessons', { title: 'Ok', minutes: 500 }, coach)).status, 400);
  assert.equal((await call('POST', '/lessons', { title: 'Ok', minutes: 2.5 }, coach)).status, 400);
  assert.equal((await call('POST', '/lessons', { title: 'Ok', course_id: 99999 }, coach)).status, 400);
  assert.equal((await call('POST', '/lessons', { title: 'Ok', course_id: 'nope' }, coach)).status, 400);
  assert.equal((await call('POST', '/courses', { title: 'y'.repeat(121) }, coach)).status, 400);
  const ok = await call('POST', '/lessons', { title: 'Grip pressure', minutes: '3' }, coach);
  assert.equal(ok.status, 201);
  assert.equal(get('SELECT minutes FROM lessons WHERE id=?', ok.data.id).minutes, 3);
});

test('only published lessons and courses can be assigned, to athletes and teams that exist, once each', async () => {
  const ava = A('Ava');
  const draft = await call('POST', '/lessons', { title: 'Draft lesson', published: false }, coach);
  let r = await call('POST', '/assignments', { lesson_id: draft.data.id, athlete_id: ava.id }, coach);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Publish/);
  const course = await call('POST', '/courses', { title: 'Empty course' }, coach);
  await call('POST', '/lessons', { title: 'Hidden part', course_id: course.data.id, published: false }, coach);
  assert.equal((await call('POST', '/assignments', { course_id: course.data.id, athlete_id: ava.id }, coach)).status, 400);
  const draftCourse = await call('POST', '/courses', { title: 'Draft course', published: false }, coach);
  await call('POST', '/lessons', { title: 'Visible part', course_id: draftCourse.data.id }, coach);
  assert.equal((await call('POST', '/assignments', { course_id: draftCourse.data.id, athlete_id: ava.id }, coach)).status, 400);

  const live = await call('POST', '/lessons', { title: 'Bat path basics' }, coach);
  assert.equal((await call('POST', '/assignments', { lesson_id: live.data.id, athlete_id: 999999 }, coach)).status, 404);
  assert.equal((await call('POST', '/assignments', { lesson_id: live.data.id, team_id: 999999 }, coach)).status, 404);
  assert.equal((await call('POST', '/assignments', { lesson_id: live.data.id, athlete_id: ava.id, due_date: '2026-02-30' }, coach)).status, 400);
  assert.equal((await call('POST', '/assignments', { lesson_id: live.data.id, athlete_id: ava.id }, coach)).status, 201);
  r = await call('POST', '/assignments', { lesson_id: live.data.id, athlete_id: ava.id }, coach);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /already has/);
  assert.equal(get('SELECT COUNT(*) n FROM assignments WHERE lesson_id=? AND athlete_id=?', live.data.id, ava.id).n, 1);
});

test('assigning to several athletes at once skips anyone who already has it', async () => {
  const ava = A('Ava'), chidi = A('Chidi'), kevin = A('Kevin');
  const l = await call('POST', '/lessons', { title: 'Two-strike approach' }, coach);
  const before = outboxTop();
  let r = await call('POST', '/assignments', { lesson_id: l.data.id, athlete_ids: [ava.id, chidi.id], due_date: addDays(todayLocal(), 5), note: 'Read before Thursday.' }, coach);
  assert.equal(r.status, 201);
  assert.equal(r.data.ids.length, 2);
  assert.deepEqual(r.data.skipped, []);
  assert.ok(outboxSince(before).some((m) => /Two-strike approach/.test(m.subject)), 'families are emailed');
  assert.match(lastActivity().detail, /Two-strike approach to /);
  r = await call('POST', '/assignments', { lesson_id: l.data.id, athlete_ids: [ava.id, kevin.id] }, coach);
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.assigned, [`${kevin.first_name} ${kevin.last_name}`]);
  assert.deepEqual(r.data.skipped, [`${ava.first_name} ${ava.last_name}`]);
  assert.equal((await call('POST', '/assignments', { lesson_id: l.data.id, athlete_ids: [ava.id] }, coach)).status, 400);
  assert.equal((await call('POST', '/assignments', { lesson_id: l.data.id, athlete_ids: [] }, coach)).status, 400);
  assert.equal((await call('POST', '/assignments', { lesson_id: l.data.id, athlete_ids: [ava.id, 999999] }, coach)).status, 404);
  assert.equal((await call('POST', '/assignments', { lesson_id: l.data.id, athlete_ids: [kevin.id] }, desk)).status, 403);
});

test('the report tracks who opened, started and finished, and the lesson shows who read it', async () => {
  const ava = A('Ava'), chidi = A('Chidi');
  const c = await call('POST', '/courses', { title: 'Hitting IQ' }, coach);
  const l1 = await call('POST', '/lessons', { title: 'Count leverage', course_id: c.data.id }, coach);
  const l2 = await call('POST', '/lessons', { title: 'Sitting on a pitch', course_id: c.data.id }, coach);
  await call('POST', '/assignments', { course_id: c.data.id, athlete_ids: [ava.id, chidi.id], due_date: addDays(todayLocal(), 3) }, coach);

  const status = async () => {
    const rep = (await call('GET', '/education', null, coach)).data;
    return rep.assignments.filter((x) => x.course_id === c.data.id).map((x) => x.people[0]);
  };
  let people = await status();
  assert.ok(people.every((p) => p.status === 'not_started' && p.of === 2 && p.done === 0));

  await call('GET', `/w/${ava.workout_token}/lessons/${l1.data.id}`); // opening counts as started
  people = await status();
  assert.equal(people.find((p) => p.id === ava.id).status, 'started');
  let prog = (await call('GET', `/lessons/${l1.data.id}/progress`, null, desk)).data;
  assert.deepEqual(prog.opened.map((x) => x.athlete_id), [ava.id]);
  assert.deepEqual(prog.finished, []);
  assert.ok(prog.assignments.length >= 2, 'course assignments show on the lesson');

  await call('POST', `/w/${ava.workout_token}/lessons/${l1.data.id}/complete`, { done: true });
  await call('POST', `/w/${ava.workout_token}/lessons/${l2.data.id}/complete`, { done: true });
  people = await status();
  const avaRow = people.find((p) => p.id === ava.id);
  assert.equal(avaRow.status, 'finished');
  assert.ok(avaRow.completed_at);
  prog = (await call('GET', `/lessons/${l1.data.id}/progress`, null, coach)).data;
  assert.deepEqual(prog.finished.map((x) => x.athlete_id), [ava.id]);
  assert.deepEqual(prog.opened, [], 'finished readers are not also listed as opened');

  const rep = (await call('GET', '/education', null, desk)).data;
  assert.equal(rep.assignments.find((x) => x.course_id === c.data.id && x.athlete_id === ava.id).status, 'finished');
  assert.equal(rep.courses.find((x) => x.id === c.data.id).finishers, 1);
  assert.ok(rep.stats.finished_week >= 2);
  assert.ok(rep.recent.some((x) => x.lesson_id === l2.data.id && x.athlete_id === ava.id));
  assert.equal((await call('GET', `/lessons/${l1.data.id}/progress`)).status, 401);
  assert.equal((await call('GET', '/lessons/999999/progress', null, coach)).status, 404);
});

test('reminders email only the athletes who have not finished, at most every 12 hours', async () => {
  const ava = A('Ava'), chidi = A('Chidi');
  const l = await call('POST', '/lessons', { title: 'Pitch recognition' }, coach);
  const r = await call('POST', '/assignments', { lesson_id: l.data.id, athlete_ids: [ava.id, chidi.id] }, coach);
  const [avaAssignment, chidiAssignment] = r.data.ids;
  await call('POST', `/w/${ava.workout_token}/lessons/${l.data.id}/complete`, { done: true });

  assert.equal((await call('POST', `/assignments/${chidiAssignment}/remind`, null, desk)).status, 403);
  let before = outboxTop();
  let rem = await call('POST', `/assignments/${chidiAssignment}/remind`, {}, coach);
  assert.equal(rem.status, 200);
  assert.equal(rem.data.sent, 1);
  const mail = outboxSince(before);
  assert.ok(mail.length >= 1 && mail.every((m) => /^Reminder for Chidi: Pitch recognition$/.test(m.subject)));
  assert.match(lastActivity().action, /reminder/);
  rem = await call('POST', `/assignments/${chidiAssignment}/remind`, {}, coach);
  assert.equal(rem.status, 400);
  assert.match(rem.data.error, /12 hours/);
  rem = await call('POST', `/assignments/${avaAssignment}/remind`, {}, coach);
  assert.equal(rem.status, 400, 'nobody left to remind');
  assert.equal((await call('POST', '/assignments/999999/remind', {}, coach)).status, 404);

  // Overdue sweep: one overdue assignment, reminded once.
  const late = await call('POST', '/lessons', { title: 'Late reading' }, coach);
  const x = await call('POST', '/assignments', { lesson_id: late.data.id, athlete_id: chidi.id }, coach);
  run('UPDATE assignments SET due_date=? WHERE id=?', addDays(todayLocal(), -2), x.data.id);
  assert.equal((await call('POST', '/assignments/remind-overdue', {}, desk)).status, 403);
  before = outboxTop();
  let sweep = await call('POST', '/assignments/remind-overdue', {}, owner);
  assert.equal(sweep.status, 200);
  assert.ok(sweep.data.assignments >= 1 && sweep.data.athletes >= 1);
  assert.ok(outboxSince(before).some((m) => m.subject === 'Reminder for Chidi: Late reading' && /It was due/.test(m.body)));
  sweep = await call('POST', '/assignments/remind-overdue', {}, owner);
  assert.equal(sweep.data.assignments, 0, 'already reminded in the last 12 hours');
  const rep = (await call('GET', '/education', null, coach)).data;
  const row = rep.assignments.find((y) => y.id === x.data.id);
  assert.equal(row.status, 'overdue');
  assert.ok(row.reminded_at);
});

test('assignments can be changed and removed, with the change logged', async () => {
  const kevin = A('Kevin');
  const l = await call('POST', '/lessons', { title: 'Base running reads' }, coach);
  const x = await call('POST', '/assignments', { lesson_id: l.data.id, athlete_id: kevin.id }, coach);
  const due = addDays(todayLocal(), 10);
  assert.equal((await call('PUT', `/assignments/${x.data.id}`, { due_date: due, note: '  Two minutes.  ' }, coach)).status, 200);
  let row = get('SELECT * FROM assignments WHERE id=?', x.data.id);
  assert.deepEqual([row.due_date, row.note], [due, 'Two minutes.']);
  assert.match(lastActivity().detail, /Base running reads for Kevin/);
  assert.equal((await call('PUT', `/assignments/${x.data.id}`, { due_date: null }, coach)).status, 200);
  assert.equal(get('SELECT due_date FROM assignments WHERE id=?', x.data.id).due_date, null);
  assert.equal((await call('PUT', `/assignments/${x.data.id}`, { due_date: 'soon' }, coach)).status, 400);
  assert.equal((await call('PUT', `/assignments/${x.data.id}`, { note: 'x' }, desk)).status, 403);
  assert.equal((await call('PUT', '/assignments/999999', { note: 'x' }, coach)).status, 404);
  assert.equal((await call('DELETE', `/assignments/${x.data.id}`, null, desk)).status, 403);
  assert.equal((await call('DELETE', `/assignments/${x.data.id}`, null, coach)).status, 200);
  assert.match(lastActivity().detail, /Base running reads for Kevin/);
  assert.equal((await call('DELETE', `/assignments/${x.data.id}`, null, coach)).status, 404);
  row = get('SELECT * FROM assignments WHERE id=?', x.data.id);
  assert.equal(row, undefined);
});

test('course order, moving lessons, publishing and duplicating', async () => {
  const a = await call('POST', '/courses', { title: 'Catching' }, coach);
  const b = await call('POST', '/courses', { title: 'Throwing' }, coach);
  const a1 = await call('POST', '/lessons', { title: 'Receiving', course_id: a.data.id }, coach);
  const a2 = await call('POST', '/lessons', { title: 'Blocking', course_id: a.data.id }, coach);
  const b1 = await call('POST', '/lessons', { title: 'Footwork', course_id: b.data.id }, coach);
  const loose = await call('POST', '/lessons', { title: 'Arm care' }, coach);

  // Moving a lesson into a course without an order puts it last, not first.
  await call('PUT', `/lessons/${loose.data.id}`, { course_id: a.data.id }, coach);
  const order = all('SELECT id FROM lessons WHERE course_id=? ORDER BY ord, id', a.data.id).map((r) => r.id);
  assert.deepEqual(order, [a1.data.id, a2.data.id, loose.data.id]);
  // Editing other fields keeps its place.
  await call('PUT', `/lessons/${a1.data.id}`, { title: 'Receiving the ball', course_id: a.data.id }, coach);
  assert.equal(all('SELECT id FROM lessons WHERE course_id=? ORDER BY ord, id', a.data.id)[0].id, a1.data.id);

  assert.equal((await call('PUT', `/courses/${a.data.id}/order`, { lesson_ids: [a2.data.id, b1.data.id] }, coach)).status, 400, 'lessons from another course');
  assert.equal((await call('PUT', `/courses/${a.data.id}/order`, { lesson_ids: [a2.data.id, a2.data.id] }, coach)).status, 400, 'duplicates');
  assert.equal((await call('PUT', `/courses/${a.data.id}/order`, { lesson_ids: [loose.data.id, a2.data.id, a1.data.id] }, coach)).status, 200);
  assert.deepEqual(all('SELECT id FROM lessons WHERE course_id=? ORDER BY ord, id', a.data.id).map((r) => r.id), [loose.data.id, a2.data.id, a1.data.id]);

  await call('PUT', `/lessons/${b1.data.id}`, { published: false }, coach);
  assert.equal(lastActivity().action, 'Unpublished a lesson');
  await call('PUT', `/lessons/${b1.data.id}`, { published: true }, coach);
  assert.equal(lastActivity().action, 'Published a lesson');

  const dup = await call('POST', `/lessons/${a2.data.id}/duplicate`, {}, coach);
  assert.equal(dup.status, 201);
  const copy = get('SELECT * FROM lessons WHERE id=?', dup.data.id);
  assert.deepEqual([copy.title, copy.published, copy.course_id], ['Blocking (copy)', 0, a.data.id]);
  assert.equal(all('SELECT id FROM lessons WHERE course_id=? ORDER BY ord, id', a.data.id).at(-1).id, copy.id, 'the copy goes last');
  assert.equal((await call('POST', `/lessons/${a2.data.id}/duplicate`, {}, desk)).status, 403);
  assert.equal((await call('POST', '/lessons/999999/duplicate', {}, coach)).status, 404);
});

test('the education report never carries money, and front desk sees it read-only', async () => {
  const r = await call('GET', '/education', null, coach);
  assert.equal(r.status, 200);
  assert.ok(!/cents|price|amount|invoice/i.test(JSON.stringify(r.data)));
  for (const k of ['open', 'overdue', 'finished', 'finished_week', 'published', 'drafts']) assert.equal(typeof r.data.stats[k], 'number');
  assert.equal((await call('GET', '/education', null, desk)).status, 200);
  assert.equal((await call('POST', '/courses', { title: 'Nope' }, desk)).status, 403);
  assert.equal((await call('PUT', `/lessons/${r.data.lessons[0].id}`, { published: false }, desk)).status, 403);
});
