// Education, coach side (assigning to several athletes, opened tracking, reminders, changing assignments) and the
// athlete and parent Accountability, Performance and Education tabs (missed days, goal history, same as yesterday,
// day details, target gaps, finished courses).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { gapText } from '../src/services/engage.js';
import { addDaysToDate, localDate } from '../src/util.js';

let app, base, owner, coach, desk, maria;
let ava, ben, cole, dee, team, endedTeam, course, l1, l2, solo, draft, parentCourse;
const TZ = 'America/Chicago';
const todayLocal = () => localDate(app.ctx.now(), TZ);

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const athlete = (c) => (method, path, body) => req(method, `/app/api/${path}`, body, { 'x-client-token': c.app_link.split('token=')[1] });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
async function parent(email) {
  const { body } = await req('POST', '/portal/api/login', { email });
  return as((await req('POST', '/portal/api/verify', { email, code: body.dev_code })).cookie);
}
const mailTo = (email, like = '%') => app.ctx.db.all('SELECT subject, body FROM outbox WHERE to_email = ? AND subject LIKE ? ORDER BY rowid', email, like);
// Run fn with the clock at a given instant.
async function at(iso, fn) {
  const real = app.ctx.now;
  app.ctx.now = () => iso;
  try { return await fn(); } finally { app.ctx.now = real; }
}

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  coach = await signIn('coach@test.dev', 'coach-password-1');
  desk = await signIn('desk@test.dev', 'desk-password-1');

  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2013-03-10', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Ben Lopez', birth_date: '2016-06-01' })).body;
  ben = (await coach('GET', `/v1/clients/${ben.id}`)).body;
  cole = (await coach('POST', '/v1/clients', { name: 'Cole Park', birth_date: '2011-09-22', parent: { name: 'Pat Park', email: 'pat@example.com' } })).body;
  dee = (await coach('POST', '/v1/clients', { name: 'Dee Ross', email: 'dee@example.com' })).body;
  team = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Hill Country FC' }, name: '14U Girls', monthly_cents: 50000, start_date: todayLocal() })).body;
  await owner('POST', `/v1/team-contracts/${team.id}/roster`, { name: 'Ava Lopez', client_id: ava.id });
  await owner('POST', `/v1/team-contracts/${team.id}/roster`, { name: 'Cole Park', client_id: cole.id });
  endedTeam = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Old School' }, name: 'JV', monthly_cents: 10000, start_date: todayLocal() })).body;
  app.ctx.db.run(`UPDATE team_contracts SET status = 'ended' WHERE id = ?`, endedTeam.id);

  course = (await coach('POST', '/v1/courses', { title: 'Recovery basics' })).body;
  l1 = (await coach('POST', '/v1/lessons', { title: 'Sleep', course_id: course.id, body: 'Sleep more.' })).body;
  l2 = (await coach('POST', '/v1/lessons', { title: 'Water', course_id: course.id, body: 'Drink water.' })).body;
  solo = (await coach('POST', '/v1/lessons', { title: 'Mindset', body: 'Next play.' })).body;
  draft = (await coach('POST', '/v1/lessons', { title: 'Draft one', published: false })).body;
  parentCourse = (await coach('POST', '/v1/courses', { title: 'For parents', audience: 'parents' })).body;
  maria = await parent('maria@example.com');
});
after(() => app.server.close());

test('assigning to several athletes: all checked first, those who already have it are skipped and named', async () => {
  const t = todayLocal();
  // The team has the course; Ben has it on his own already.
  assert.equal((await coach('POST', '/v1/lesson-assignments', { course_id: course.id, contract_id: team.id, due_date: addDaysToDate(t, 7) })).status, 201);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { course_id: course.id, client_id: ben.id })).status, 201);
  const again = await coach('POST', '/v1/lesson-assignments', { course_id: course.id, client_id: ben.id });
  assert.equal(again.status, 409, 'the same athlete is not given it twice');
  assert.match(again.body.error.message, /already has "Recovery basics"/);

  const r = await coach('POST', '/v1/lesson-assignments', { course_id: course.id, client_ids: [ava.id, ben.id, dee.id, dee.id], due_date: addDaysToDate(t, 3), note: 'Start tonight' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.assigned.map((x) => x.name), ['Dee Ross']);
  assert.deepEqual(r.body.skipped.map((x) => [x.name, x.reason]).sort(), [['Ava Lopez', 'has it through Hill Country FC 14U Girls'], ['Ben Lopez', 'already has it']]);
  assert.ok(mailTo('dee@example.com', 'New course%').length === 1, 'the athlete is emailed');
  assert.match(mailTo('dee@example.com', 'New course%')[0].body, /\/app\?token=.*#education/, 'the link opens the Education tab');
  assert.equal((await coach('POST', '/v1/lesson-assignments', { course_id: course.id, client_ids: [ava.id, ben.id] })).status, 409, 'everyone already has it');

  // Nothing is saved while any athlete can't be given it.
  const before = app.ctx.db.get('SELECT COUNT(*) AS n FROM lesson_assignments').n;
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), cole.id);
  const bad = await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_ids: [dee.id, cole.id] });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error.message, /Cole Park is archived/);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_ids: [dee.id, 'cli_nope'] })).status, 400);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_ids: [] })).status, 400);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_ids: Array.from({ length: 201 }, (_, i) => `c${i}`) })).status, 400);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_id: cole.id })).status, 409, 'archived athletes can\'t be given reading');
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', cole.id);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM lesson_assignments').n, before);

  // What can be assigned, and when it can be due.
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: draft.id, client_id: dee.id })).status, 409, 'drafts can\'t be assigned');
  const empty = (await coach('POST', '/v1/courses', { title: 'Empty course' })).body;
  assert.match((await coach('POST', '/v1/lesson-assignments', { course_id: empty.id, client_id: dee.id })).body.error.message, /no published lessons/);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { course_id: parentCourse.id, client_id: dee.id })).status, 409);
  assert.match((await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, contract_id: endedTeam.id })).body.error.message, /contract has ended/);
  // Reading given before the contract ended is never overdue and nobody on it is reminded.
  await owner('POST', `/v1/team-contracts/${endedTeam.id}/roster`, { name: 'Dee Ross', client_id: dee.id });
  app.ctx.db.run(`INSERT INTO lesson_assignments (id, lesson_id, contract_id, due_date, created_at) VALUES ('lasg_ended', ?, ?, ?, ?)`, solo.id, endedTeam.id, addDaysToDate(t, -5), app.ctx.now());
  const endedRow = (await coach('GET', '/v1/education')).body.assignments.find((y) => y.id === 'lasg_ended');
  assert.deepEqual([endedRow.status, endedRow.team_ended], ['open', true]);
  assert.match((await coach('POST', '/v1/lesson-assignments/lasg_ended/remind')).body.error.message, /contract has ended/);
  app.ctx.db.run(`DELETE FROM lesson_assignments WHERE id = 'lasg_ended'`);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_id: dee.id, due_date: '2026-13-01' })).status, 400);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_id: dee.id, due_date: addDaysToDate(t, -1) })).body.error.message, 'Pick a due date from today on.');
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_id: dee.id, due_date: addDaysToDate(t, 400) })).status, 400);

  // Front desk can look but not assign; the athlete picker lists who can be given reading, with teams.
  assert.equal((await desk('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_ids: [dee.id] })).status, 403);
  const pick = await desk('GET', '/v1/education/athletes');
  assert.equal(pick.status, 200);
  assert.deepEqual(pick.body.athletes.find((a) => a.id === ava.id).team_ids, [team.id]);
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), dee.id);
  assert.ok(!(await coach('GET', '/v1/education/athletes')).body.athletes.some((a) => a.id === dee.id), 'archived athletes aren\'t offered');
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', dee.id);
});

test('coaches see who opened, started and finished; archived athletes are left out', async () => {
  const find = async () => (await coach('GET', '/v1/education')).body.assignments.find((x) => x.contract_id === team.id && x.course_id === course.id);
  let x = await find();
  assert.deepEqual(x.people.map((p) => [p.name, p.status]), [['Ava Lopez', 'not_started'], ['Cole Park', 'not_started']]);
  assert.equal(x.assigned_by, 'Carl Coach');
  await athlete(ava)('GET', `lessons/${l1.id}`);
  x = await find();
  assert.equal(x.people.find((p) => p.id === ava.id).status, 'opened');
  await athlete(ava)('POST', `lessons/${l1.id}/complete`, { done: true });
  x = await find();
  assert.deepEqual((({ status, done, of }) => ({ status, done, of }))(x.people.find((p) => p.id === ava.id)), { status: 'started', done: 1, of: 2 });
  await athlete(ava)('POST', `lessons/${l2.id}/complete`, { done: true });
  x = await find();
  const a = x.people.find((p) => p.id === ava.id);
  assert.equal(a.status, 'finished');
  assert.ok(a.completed_at);
  assert.equal(x.finished, 1);

  // The lesson's own details.
  const p = (await desk('GET', `/v1/lessons/${l1.id}/progress`)).body;
  assert.deepEqual(p.finished.map((f) => f.name), ['Ava Lopez']);
  await athlete(cole)('GET', `lessons/${l1.id}`);
  const p2 = (await coach('GET', `/v1/lessons/${l1.id}/progress`)).body;
  assert.deepEqual(p2.opened.map((f) => f.name), ['Cole Park']);
  assert.ok(p2.assignments.some((y) => y.contract_id === team.id && y.type === 'course'), 'assigned with its course');

  // An archived athlete on a single assignment: says so and never counts as overdue.
  const one = (await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_id: cole.id })).body;
  app.ctx.db.run('UPDATE lesson_assignments SET due_date = ? WHERE id = ?', addDaysToDate(todayLocal(), -2), one.id);
  let edu = (await coach('GET', '/v1/education')).body;
  assert.equal(edu.assignments.find((y) => y.id === one.id).status, 'overdue');
  assert.equal(edu.assignments[0].status, 'overdue', 'overdue first');
  const overdueBefore = edu.stats.overdue;
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), cole.id);
  edu = (await coach('GET', '/v1/education')).body;
  assert.equal(edu.assignments.find((y) => y.id === one.id).status, 'archived');
  assert.equal(edu.stats.overdue, overdueBefore - 1);
  assert.ok(!edu.assignments.find((y) => y.contract_id === team.id && y.course_id === course.id).people.some((q) => q.id === cole.id), 'archived athletes drop off the team list');
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', cole.id);
  await coach('DELETE', `/v1/lesson-assignments/${one.id}`);
});

test('change an assignment: due date or note, nobody emailed; past dates only if already saved', async () => {
  const t = todayLocal();
  const x = (await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_id: ben.id, due_date: addDaysToDate(t, 2) })).body;
  const mails = app.ctx.db.get('SELECT COUNT(*) AS n FROM outbox').n;
  let r = await coach('PATCH', `/v1/lesson-assignments/${x.id}`, { due_date: addDaysToDate(t, 5), note: 'Take your time' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.due_date, r.body.note], [addDaysToDate(t, 5), 'Take your time']);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM outbox').n, mails);
  app.ctx.db.run('UPDATE lesson_assignments SET due_date = ? WHERE id = ?', addDaysToDate(t, -3), x.id);
  assert.equal((await coach('PATCH', `/v1/lesson-assignments/${x.id}`, { due_date: addDaysToDate(t, -3), note: 'Still waiting' })).status, 200, 'the saved date can stay');
  assert.equal((await coach('PATCH', `/v1/lesson-assignments/${x.id}`, { due_date: addDaysToDate(t, -1) })).status, 400);
  assert.equal((await coach('PATCH', `/v1/lesson-assignments/${x.id}`, { due_date: '' })).body.due_date, null);
  assert.equal((await coach('PATCH', `/v1/lesson-assignments/${x.id}`, {})).status, 400);
  assert.equal((await coach('PATCH', '/v1/lesson-assignments/lasg_nope', { note: 'x' })).status, 404);
  assert.equal((await desk('PATCH', `/v1/lesson-assignments/${x.id}`, { note: 'x' })).status, 403);
  await coach('DELETE', `/v1/lesson-assignments/${x.id}`);
});

test('reminders: only who hasn\'t finished, never twice in 12 hours, archived and opted-out left out', async () => {
  const t = todayLocal();
  const x = (await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, contract_id: team.id, due_date: addDaysToDate(t, 1) })).body;
  await athlete(cole)('POST', `lessons/${solo.id}/complete`, { done: true });
  app.ctx.db.run(`INSERT INTO email_optouts (email, source, created_at) VALUES ('PAT@example.com', 'test', ?)`, app.ctx.now());
  let r = await coach('POST', `/v1/lesson-assignments/${x.id}/remind`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.reminded.map((p) => p.name), ['Ava Lopez'], 'Cole finished it');
  assert.equal(mailTo('maria@example.com', 'Reminder:%').length, 1);
  assert.match(mailTo('maria@example.com', 'Reminder:%')[0].body, /"Mindset"/);
  assert.equal(mailTo('pat@example.com', 'Reminder:%').length, 0);
  r = await coach('POST', `/v1/lesson-assignments/${x.id}/remind`);
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /less than 12 hours ago/);
  assert.equal((await desk('POST', `/v1/lesson-assignments/${x.id}/remind`)).status, 403);
  assert.equal((await coach('POST', '/v1/lesson-assignments/lasg_nope/remind')).status, 404);

  // An athlete reminded in the last 12 hours isn't reminded again for another assignment.
  const y = (await coach('POST', '/v1/lesson-assignments', { lesson_id: l1.id, client_id: ben.id })).body;
  await coach('POST', `/v1/lesson-assignments/${y.id}/remind`);
  const z = (await coach('POST', '/v1/lesson-assignments', { lesson_id: l2.id, client_id: ben.id })).body;
  r = await coach('POST', `/v1/lesson-assignments/${z.id}/remind`);
  assert.deepEqual(r.body.skipped.map((s) => [s.name, s.reason]), [['Ben Lopez', 'reminded in the last 12 hours']]);

  // An athlete with nobody to email is named.
  const loner = (await coach('POST', '/v1/clients', { name: 'No Mail', email: 'nomail@example.com' })).body;
  app.ctx.db.run('UPDATE clients SET email = NULL WHERE id = ?', loner.id);   // like a team-only athlete: no email, no family
  const w = (await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_id: loner.id })).body;
  assert.deepEqual((await coach('POST', `/v1/lesson-assignments/${w.id}/remind`)).body.skipped.map((s) => s.reason), ['no email on file']);

  // Remind overdue: 13 hours later, one email per athlete listing every overdue assignment of theirs.
  for (const id of [x.id, y.id, z.id]) app.ctx.db.run('UPDATE lesson_assignments SET due_date = ? WHERE id = ?', addDaysToDate(t, -1), id);
  const later = new Date(Date.parse(app.ctx.now()) + 13 * 3600000).toISOString();
  await at(later, async () => {
    const before = mailTo('maria@example.com', 'Reminder:%').length;
    const out = await coach('POST', '/v1/lesson-assignments/remind-overdue');
    assert.equal(out.status, 200);
    const names = out.body.reminded.map((p) => p.name).sort();
    assert.deepEqual(names, ['Ava Lopez', 'Ben Lopez']);
    const sent = mailTo('maria@example.com', 'Reminder:%').slice(before);
    assert.equal(sent.length, 2, 'one email per athlete to their parent');
    assert.ok(sent.some((m) => m.subject === 'Reminder: Ben has 2 lessons to finish' && /"Sleep"/.test(m.body) && /"Water"/.test(m.body)));
    // Pressing it again right away sends nothing.
    const again = await coach('POST', '/v1/lesson-assignments/remind-overdue');
    assert.equal(again.body.assignments, 0);
    assert.equal(mailTo('maria@example.com', 'Reminder:%').length, before + 2);
  });
  for (const id of [x.id, y.id, z.id, w.id]) await coach('DELETE', `/v1/lesson-assignments/${id}`);
});

test('library tools: duplicate as a draft at the end, reorder refuses duplicates, deleting a family clears opens and reminders', async () => {
  const copy = await coach('POST', `/v1/lessons/${l1.id}/duplicate`);
  assert.equal(copy.status, 201);
  assert.deepEqual([copy.body.title, copy.body.published, copy.body.course_id], ['Sleep (copy)', false, course.id]);
  const c = (await coach('GET', '/v1/education')).body.courses.find((x) => x.id === course.id);
  assert.equal(c.lessons.at(-1).id, copy.body.id);
  assert.equal((await coach('PUT', `/v1/courses/${course.id}/order`, { lesson_ids: [l1.id, l1.id, l2.id] })).status, 400);
  assert.equal((await coach('PUT', `/v1/courses/${course.id}/order`, { lesson_ids: [copy.body.id, l2.id, l1.id] })).status, 200);
  await coach('DELETE', `/v1/lessons/${copy.body.id}`);
  assert.equal((await desk('POST', `/v1/lessons/${l1.id}/duplicate`)).status, 403);
  await coach('PUT', `/v1/courses/${course.id}/order`, { lesson_ids: [l1.id, l2.id] });

  // Throwaway family: opens and reminders go with the family.
  const kid = (await coach('POST', '/v1/clients', { name: 'Gone Kid', parent: { name: 'Gone Parent', email: 'gone@example.com' } })).body;
  const x = (await coach('POST', '/v1/lesson-assignments', { lesson_id: solo.id, client_id: kid.id })).body;
  await athlete(kid)('GET', `lessons/${solo.id}`);
  await coach('POST', `/v1/lesson-assignments/${x.id}/remind`);
  await athlete(kid)('POST', 'messages', { body: 'Read it' });
  assert.equal(app.ctx.db.get(`SELECT actor_name FROM audit_log WHERE actor_type = 'athlete' AND actor_id = ?`, kid.id).actor_name, 'Gone Kid');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM lesson_views WHERE client_id = ?', kid.id).n, 1);
  const exp = await owner('GET', `/v1/families/${kid.family.id}/export`);
  assert.equal(exp.body.athletes[0].lessons_opened.length, 1, 'the family export includes lessons opened');
  assert.equal((await owner('DELETE', `/v1/families/${kid.family.id}`, { confirm: kid.family.name })).status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM lesson_views WHERE client_id = ?', kid.id).n, 0);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM lesson_reminders WHERE client_id = ?', kid.id).n, 0);
  // The audit log keeps the action, but not the deleted athlete's name.
  const rows = app.ctx.db.all(`SELECT actor_name FROM audit_log WHERE actor_type = 'athlete' AND actor_id = ?`, kid.id);
  assert.ok(rows.length && rows.every((r) => r.actor_name === null), 'no name left in the audit log');
});

test('custom goals: tick a missed day this week, never a future day or last week; last week and weeks in a row', async () => {
  // Wednesday noon in Chicago. Weeks run Monday to Sunday.
  const wed = '2026-10-07', mon = '2026-10-05';
  let g;
  await at('2026-09-21T17:00:00.000Z', async () => {   // set two weeks before
    g = (await coach('POST', `/v1/clients/${dee.id}/goals`, { kind: 'custom', target: 2, title: 'Stretch' })).body;
  });
  const me = athlete(dee);
  // Two weeks ago and last week both met.
  for (const d of ['2026-09-22', '2026-09-24', '2026-09-28', '2026-09-30']) app.ctx.db.run('INSERT INTO goal_checks (goal_id, client_id, date) VALUES (?, ?, ?)', g.id, dee.id, d);
  await at(`${wed}T17:00:00.000Z`, async () => {
    let r = await me('POST', `goals/${g.id}/check`, { done: true, date: mon });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.progress, r.body.checked_today], [1, false]);
    assert.deepEqual(r.body.days.map((d) => [d.date, d.checked, d.future]).slice(0, 4), [[mon, true, false], ['2026-10-06', false, false], [wed, false, false], ['2026-10-08', false, true]]);
    assert.equal((await me('POST', `goals/${g.id}/check`, { done: true, date: '2026-10-08' })).status, 400, 'not a future day');
    assert.equal((await me('POST', `goals/${g.id}/check`, { done: true, date: '2026-10-04' })).status, 400, 'not last week');
    assert.equal((await me('POST', `goals/${g.id}/check`, { done: true, date: 'soon' })).status, 400);
    r = await me('POST', `goals/${g.id}/check`, { done: true });
    assert.deepEqual([r.body.progress, r.body.done, r.body.checked_today], [2, true, true]);
    assert.deepEqual(r.body.last_week, { week_start: '2026-09-28', progress: 2, done: true });
    assert.equal(r.body.weeks_in_row, 3, 'this week, last week and the week before');
    r = await me('POST', `goals/${g.id}/check`, { done: false, date: mon });
    assert.equal(r.body.weeks_in_row, 2, 'this week no longer met');
  });
  // A goal set on Wednesday can't be ticked for the Monday before it existed.
  await at(`${wed}T17:00:00.000Z`, async () => {
    const fresh = (await coach('POST', `/v1/clients/${dee.id}/goals`, { kind: 'custom', target: 3, title: 'Foam roll' })).body;
    const r = await me('POST', `goals/${fresh.id}/check`, { done: true, date: mon });
    assert.equal(r.status, 400, 'not before the goal was set');
    assert.match(r.body.error.message, /was set on Oct 7/);
    const v = (await me('GET', 'engage')).body.accountability.goals.find((x) => x.id === fresh.id);
    assert.deepEqual(v.days.slice(0, 3).map((d) => d.before_start), [true, true, false]);
    assert.equal((await me('POST', `goals/${fresh.id}/check`, { done: true, date: wed })).status, 200);
  });
  // A parent can tick a missed day too.
  await at(`${wed}T17:00:00.000Z`, async () => {
    const r = await maria('POST', `/portal/api/athletes/${ava.id}/goals/nope/check`, { done: true, date: mon });
    assert.equal(r.status, 404);
  });
});

test('accountability: best run, yesterday\'s answers, the last 7 days, and what happened each day in the business time zone', async () => {
  const me = athlete(ben);
  const dayAt = (d) => `${d}T17:00:00.000Z`;
  const t = '2026-10-07';
  for (const d of ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-05', '2026-10-06']) await at(dayAt(d), () => me('POST', 'daily-check-in', { sleep_hours: 8, mood: 4, soreness: d === '2026-10-06' ? 5 : 2 }));
  // A workout finished at 9:30 pm Chicago on Oct 6 (02:30 UTC on Oct 7) belongs to Oct 6.
  const db = app.ctx.db;
  db.run(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_b11', 'Strength', 4, '2026-09-01T00:00:00Z')`);
  db.run(`INSERT INTO workouts (id, program_id, week, day, title) VALUES ('wo_b11', 'prog_b11', 1, 1, 'Lower body')`);
  db.run(`INSERT INTO workout_logs (id, client_id, workout_id, completed_at, rpe) VALUES ('log_b11', ?, 'wo_b11', '2026-10-07T02:30:00.000Z', 7)`, ben.id);
  await at(dayAt(t), async () => {
    const acc = (await me('GET', 'engage')).body.accountability;
    assert.equal(acc.streaks.checkin_days, 2);
    assert.equal(acc.streaks.best_checkin_days, 4);
    assert.equal(acc.checkin_yesterday.date, '2026-10-06');
    assert.deepEqual(acc.recent_checkins.map((c) => c.date), ['2026-10-06', '2026-10-05'], 'only the last 7 days');
    const oct6 = acc.calendar.find((d) => d.date === '2026-10-06');
    assert.deepEqual(oct6.workouts, [{ title: 'Lower body', time: '9:30 PM', effort: 7 }]);
    assert.ok(oct6.trained);
    assert.deepEqual(oct6.checkin.flags, ['Soreness 5 of 5']);
    assert.deepEqual(acc.calendar.find((d) => d.date === t).workouts, []);
  });
  // Deleting the program keeps the log (version 43): the day still shows the workout, under the title it had.
  assert.equal((await owner('DELETE', '/v1/programs/prog_b11')).status, 200);
  assert.equal(db.get(`SELECT workout_id FROM workout_logs WHERE id = 'log_b11'`).workout_id, null);
  await at(dayAt(t), async () => {
    const acc = (await me('GET', 'engage')).body.accountability;
    const oct6 = acc.calendar.find((d) => d.date === '2026-10-06');
    assert.deepEqual(oct6.workouts, [{ title: 'Lower body', time: '9:30 PM', effort: 7 }], 'a log of a deleted workout keeps its day details');
    assert.ok(oct6.trained);
  });
});

test('targets say how far there is to go and when they are past their date', async () => {
  assert.equal(gapText(0.13000000001, 's', 2), '0.13 s to go');
  assert.equal(gapText(3, 'in', 1), '3 in to go');
  assert.equal(gapText(23.8, 'in', 1), '2 ft to go', 'a whole foot, not "1 ft 12 in"');
  assert.equal(gapText(25, 'in', 1), '2 ft 1 in to go');
  assert.equal(gapText(0, 's'), null);
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Combine', date: addDaysToDate(todayLocal(), -1), tests: ['broad_jump'] })).body;
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: dee.id, test: 'broad_jump', value: 70, recorded_at: `${day.date}T15:00:00.000Z` }] });
  await coach('POST', `/v1/testing-sessions/${day.id}/share`, { notify: false });
  await coach('POST', `/v1/clients/${dee.id}/targets`, { test: 'broad_jump', target: '6\'', due_date: addDaysToDate(todayLocal(), 10) });
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: dee.id, test: 'dash_40yd', value: 5.94, recorded_at: `${day.date}T15:00:00.000Z` }] });
  await coach('POST', `/v1/clients/${dee.id}/targets`, { test: 'dash_40yd', target: 5.75 });
  const dash = (await athlete(dee)('GET', 'engage')).body.performance.targets.find((x) => x.test === 'dash_40yd');
  assert.equal(dash?.gap, 0.19, 'the gap is rounded, not 0.19000000000000039');
  let tg = (await athlete(dee)('GET', 'engage')).body.performance.targets.find((x) => x.test === 'broad_jump');
  assert.deepEqual([tg.gap, tg.gap_text, tg.overdue], [2, '2 in to go', false]);
  const later = `${addDaysToDate(todayLocal(), 12)}T17:00:00.000Z`;
  await at(later, async () => { tg = (await athlete(dee)('GET', 'engage')).body.performance.targets.find((x) => x.test === 'broad_jump'); });
  assert.equal(tg.overdue, true);
});

test('education for the athlete: next lesson to continue, opened flag, and a finished course says so', async () => {
  const kid = (await coach('POST', '/v1/clients', { name: 'Eli Moss', email: 'eli@example.com' })).body;
  await coach('POST', '/v1/lesson-assignments', { course_id: course.id, client_id: kid.id });
  const me = athlete(kid);
  let x = (await me('GET', 'engage')).body.education.assigned[0];
  assert.deepEqual([x.opened, x.next_lesson.title], [false, 'Sleep']);
  await me('GET', `lessons/${l1.id}`);
  await me('POST', `lessons/${l1.id}/complete`, { done: true });
  x = (await me('GET', 'engage')).body.education.assigned[0];
  assert.deepEqual([x.opened, x.next_lesson.title, x.progress], [true, 'Water', '1 of 2']);
  const last = await me('POST', `lessons/${l2.id}/complete`, { done: true });
  assert.deepEqual([last.body.course_complete, last.body.next], [true, null]);
  const first = (await me('GET', `lessons/${l1.id}`)).body;
  assert.equal(first.course_complete, true);
});

test('what an athlete does on their app link is logged under their name', async () => {
  await athlete(ava)('POST', 'messages', { body: 'Got it, coach' });
  const row = app.ctx.db.get(`SELECT actor_type, actor_name FROM audit_log WHERE action = 'POST /app/api/messages' ORDER BY at DESC LIMIT 1`);
  assert.deepEqual({ ...row }, { actor_type: 'athlete', actor_name: 'Ava Lopez' });
  // The activity log can be filtered to what athletes did on their app links.
  const log = await owner('GET', '/v1/audit?who=athlete');
  assert.equal(log.status, 200);
  const list = log.body.data ?? log.body;
  assert.ok(list.length && list.every((a) => a.actor_type === 'athlete'), 'only athletes');
  assert.ok(list.some((a) => a.actor_name === 'Ava Lopez'));
});
