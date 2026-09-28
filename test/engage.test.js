// Accountability, performance targets and rankings, and education: the athlete app, the parent portal,
// the coach side, and who can do what.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDaysToDate, localDate } from '../src/util.js';

let app, base, owner, coach, desk, maria, dana;
let ava, ben, cole, team, broadDay;
const others = [];

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

  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2013-03-10', sex: 'F', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', '/v1/families/' + ava.family.id + '/athletes', { name: 'Ben Lopez', birth_date: '2016-06-01' })).body;
  ben = (await coach('GET', `/v1/clients/${ben.id}`)).body;
  cole = (await coach('POST', '/v1/clients', { name: 'Cole Park', birth_date: '2011-09-22', sex: 'M', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  for (const name of ['Ivy Chen', 'June Ortiz', 'Kate Moss', 'Lena Park']) others.push((await coach('POST', '/v1/clients', { name, birth_date: '2013-05-01', sex: 'F', email: `${name.split(' ')[0].toLowerCase()}@example.com` })).body);

  // A shared testing day with broad jumps for six athletes, so rankings have enough people.
  broadDay = (await coach('POST', '/v1/testing-sessions', { name: 'Fall combine', date: addDaysToDate(localDate(new Date().toISOString(), 'America/Chicago'), -3), tests: ['broad_jump'] })).body;
  const when = `${broadDay.date}T15:00:00.000Z`;
  await coach('POST', '/v1/results', { session_id: broadDay.id, results: [
    { client_id: ava.id, test: 'broad_jump', value: 72, recorded_at: `${addDaysToDate(broadDay.date, -60)}T15:00:00.000Z` },
    { client_id: ava.id, test: 'broad_jump', value: 77, recorded_at: when },
    { client_id: cole.id, test: 'broad_jump', value: 101, recorded_at: when },
    ...others.map((o, i) => ({ client_id: o.id, test: 'broad_jump', value: [70, 77, 80, 66][i], recorded_at: when }))
  ] });
  await coach('POST', `/v1/testing-sessions/${broadDay.id}/share`, { notify: false });

  team = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Hill Country FC' }, name: '14U Girls', monthly_cents: 50000, start_date: addDaysToDate(broadDay.date, 10) })).body;
  await owner('POST', `/v1/team-contracts/${team.id}/roster`, { name: 'Ava Lopez', client_id: ava.id });
  await owner('POST', `/v1/team-contracts/${team.id}/roster`, { names: 'Sofia Ramirez\nZoe Patel' });
  maria = await parent('maria@example.com');
  dana = await parent('dana@example.com');
});
after(() => app.server.close());

test('the athlete link shows all three tabs and takes one daily check-in a day, with flags', async () => {
  const me = athlete(ava);
  const r = await me('GET', 'engage');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['athlete', 'accountability', 'performance', 'education']);
  assert.equal(r.body.athlete.first_name, 'Ava');
  assert.equal(r.body.accountability.calendar.length, 28);
  assert.equal(r.body.accountability.checkin_today, null);

  let c = await me('POST', 'daily-check-in', { sleep_hours: 5, soreness: 5, energy: 3, mood: 4, hydration: 3 });
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.flags, ['Slept 5 hours', 'Soreness 5 of 5']);
  c = await me('POST', 'daily-check-in', { sleep_hours: 9.3, soreness: 2, note: 'Felt good' });        // same day: updates, doesn't duplicate
  assert.equal(c.body.sleep_hours, 9.5, 'sleep rounds to the half hour');
  assert.deepEqual(c.body.flags, []);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM daily_checkins WHERE client_id = ?', ava.id).n, 1);
  assert.equal((await me('POST', 'daily-check-in', { soreness: 9 })).status, 400);
  assert.equal((await me('POST', 'daily-check-in', { sleep_hours: 17 })).body.error.message, 'Enter hours of sleep between 0 and 16.');
  assert.equal((await me('POST', 'daily-check-in', { mood: 2.5 })).status, 400);
  assert.equal((await me('POST', 'daily-check-in', {})).body.error.message, 'Fill in at least one answer.');
  const acc = (await me('GET', 'engage')).body.accountability;
  assert.equal(acc.checkin_today.note, 'Felt good');
  assert.equal(acc.streaks.checkin_days, 1);
  assert.equal(acc.this_week.checkins, 1);
  assert.equal((await req('GET', '/app/api/engage', null, { 'x-client-token': 'not-a-real-token' })).status, 401);
});

test('check-in streaks count days in a row, and today not done yet does not break them', async () => {
  const real = app.ctx.now, day = (n) => `${addDaysToDate(localDate(real(), 'America/Chicago'), n)}T18:00:00.000Z`;
  try {
    for (const n of [-3, -2, -1]) { app.ctx.now = () => day(n); await athlete(cole)('POST', 'daily-check-in', { mood: 4 }); }
    app.ctx.now = () => day(-5); await athlete(cole)('POST', 'daily-check-in', { mood: 4 });
  } finally { app.ctx.now = real; }
  let acc = (await athlete(cole)('GET', 'engage')).body.accountability;
  assert.equal(acc.streaks.checkin_days, 3);
  assert.equal(acc.calendar.filter((d) => d.checked_in).length, 4);
  await athlete(cole)('POST', 'daily-check-in', { mood: 4, sleep_hours: 8 });
  acc = (await athlete(cole)('GET', 'engage')).body.accountability;
  assert.equal(acc.streaks.checkin_days, 4);
  assert.equal(acc.streaks.active_weeks, 0, 'no training yet');
});

test('goals: automatic goals count themselves, custom goals are ticked once a day, team goals reach the roster', async () => {
  const g1 = await coach('POST', `/v1/clients/${ava.id}/goals`, { kind: 'checkins', target: 5 });
  assert.equal(g1.status, 201);
  assert.equal(g1.body.title, '5 daily check-ins a week');
  const custom = (await coach('POST', `/v1/clients/${ava.id}/goals`, { kind: 'custom', target: 4, title: '10 minutes of mobility' })).body;
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/goals`, { kind: 'sessions', target: 40 })).status, 400);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/goals`, { kind: 'naps', target: 3 })).status, 400);
  const teamGoal = await coach('POST', `/v1/teams/${team.id}/goals`, { kind: 'workouts', target: 2, title: 'Two workouts' });
  assert.equal(teamGoal.status, 201);

  const me = athlete(ava);
  let goals = (await me('GET', 'engage')).body.accountability.goals;
  assert.equal(goals.find((g) => g.id === g1.body.id).progress, 1, 'today\'s check-in counts');
  assert.ok(goals.find((g) => g.id === teamGoal.body.id && g.team));
  let r = await me('POST', `goals/${custom.id}/check`, { done: true });
  assert.deepEqual([r.body.progress, r.body.checked_today], [1, true]);
  r = await me('POST', `goals/${custom.id}/check`, { done: true });
  assert.equal(r.body.progress, 1, 'twice in a day counts once');
  r = await me('POST', `goals/${custom.id}/check`, { done: false });
  assert.equal(r.body.progress, 0);
  assert.equal((await me('POST', `goals/${g1.body.id}/check`, { done: true })).status, 400);
  assert.equal((await athlete(cole)('POST', `goals/${custom.id}/check`, { done: true })).status, 404, 'someone else\'s goal');
  assert.ok(!(await athlete(cole)('GET', 'engage')).body.accountability.goals.some((g) => g.id === teamGoal.body.id), 'not on the team');

  await coach('PATCH', `/v1/goals/${g1.body.id}`, { active: false });
  goals = (await me('GET', 'engage')).body.accountability.goals;
  assert.ok(!goals.some((g) => g.id === g1.body.id), 'ended goals disappear');
});

test('messages: coach writes, athlete sees them unread, opening marks them read; team messages reach the roster', async () => {
  const before = app.ctx.db.get('SELECT COUNT(*) AS n FROM outbox').n;
  const m = await coach('POST', `/v1/clients/${ava.id}/messages`, { body: 'Nice work today.' });
  assert.equal(m.status, 201);
  assert.equal(m.body.coach, 'Carl Coach');
  assert.ok(app.ctx.db.get(`SELECT 1 FROM outbox WHERE to_email = 'maria@example.com' AND body LIKE '%Nice work today.%'`), 'parents are emailed');
  assert.ok(app.ctx.db.get('SELECT COUNT(*) AS n FROM outbox').n > before);
  const me = athlete(ava);
  let acc = (await me('GET', 'engage')).body.accountability;
  assert.equal(acc.messages[0].body, 'Nice work today.');
  assert.equal(acc.unread, 1);
  assert.deepEqual((await me('POST', 'messages/read')).body, { read: 1 });
  acc = (await me('GET', 'engage')).body.accountability;
  assert.equal(acc.unread, 0);
  assert.equal(acc.messages[0].read, true);

  // Every roster athlete has a profile (one profile per athlete), so the team message reaches all three.
  assert.equal((await coach('POST', `/v1/teams/${team.id}/messages`, { body: 'Bring water Thursday.' })).body.recipients, 3);
  acc = (await me('GET', 'engage')).body.accountability;
  assert.ok(acc.messages.find((x) => x.body === 'Bring water Thursday.' && x.team && !x.read));
  assert.ok(!(await athlete(cole)('GET', 'engage')).body.accountability.messages.some((x) => x.team));
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/messages`, { body: '   ' })).status, 400);
  // A parent keeps their own read state: both messages are still new to Maria, and reading them is hers alone.
  assert.equal((await maria('POST', `/portal/api/athletes/${ava.id}/messages/read`)).body.read, 2);
});

test('athletes and parents write back; the coach who wrote last is emailed and sees it on Today', async () => {
  const mail = () => app.ctx.db.all(`SELECT to_email, subject, body FROM outbox WHERE subject LIKE '%replied' ORDER BY rowid`);
  const r = await athlete(ava)('POST', 'messages', { body: 'Thanks! Can I come Friday instead?' });
  assert.equal(r.status, 201);
  const p = await maria('POST', `/portal/api/athletes/${ava.id}/messages`, { body: 'She has a game Thursday.' });
  assert.equal(p.status, 201);
  assert.deepEqual(mail().map((m) => [m.to_email, m.subject]), [['coach@test.dev', 'Ava Lopez replied'], ['coach@test.dev', 'Maria Lopez (Ava\'s parent) replied']]);
  assert.match(mail()[1].body, /\/#\/clients\//);

  // Both sides see the whole conversation; replies never count as unread for the family.
  await athlete(ava)('POST', 'messages/read');          // Ava opens the team message from earlier (Maria reading it didn't count for her)
  const acc = (await athlete(ava)('GET', 'engage')).body.accountability;
  assert.deepEqual(acc.messages.slice(0, 2).map((m) => [m.from, m.author]), [['parent', 'Maria Lopez'], ['athlete', 'Ava Lopez']]);
  assert.equal(acc.unread, 0);
  assert.equal((await maria('POST', `/portal/api/athletes/${cole.id}/messages`, { body: 'hi' })).status, 404, 'only your own athletes');

  // Today lists it for coaches and front desk until a coach opens the page.
  const today = (await desk('GET', '/v1/dashboard')).body.attention.find((a) => a.kind === 'replies');
  assert.deepEqual([today.count, today.items[0].name, today.items[0].count, today.items[0].author], [1, 'Ava Lopez', 2, 'Maria Lopez']);
  assert.equal((await desk('POST', `/v1/clients/${ava.id}/messages/seen`)).status, 403);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/messages/seen`)).body.seen, 2);
  assert.equal((await coach('GET', '/v1/dashboard')).body.attention.some((a) => a.kind === 'replies'), false);
  assert.equal((await athlete(ava)('GET', 'engage')).body.accountability.messages[0].seen_by_coach, true);
  assert.equal((await athlete(ava)('POST', 'messages', { body: ' ' })).status, 400);
});

test('front desk can view accountability and education but not change anything; coaches manage', async () => {
  assert.equal((await desk('GET', `/v1/clients/${ava.id}/engagement`)).status, 200);
  assert.equal((await desk('GET', '/v1/education')).status, 200);
  assert.equal((await desk('GET', '/v1/daily-check-ins/flags')).status, 200);
  assert.equal((await desk('GET', '/v1/teams')).status, 200);
  for (const [m, p, b] of [['POST', `/v1/clients/${ava.id}/goals`, { kind: 'workouts', target: 2 }], ['POST', `/v1/clients/${ava.id}/messages`, { body: 'hi' }],
    ['POST', `/v1/clients/${ava.id}/targets`, { test: 'broad_jump', target: 80 }], ['POST', '/v1/lessons', { title: 'x' }], ['POST', '/v1/courses', { title: 'x' }],
    ['POST', '/v1/lesson-assignments', {}], ['PATCH', '/v1/engagement/settings', { rankings: 'off' }], ['POST', `/v1/teams/${team.id}/messages`, { body: 'hi' }], ['PATCH', '/v1/goals/x', { active: false }]]) {
    const r = await desk(m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal((await req('GET', `/v1/clients/${ava.id}/engagement`)).status, 401);
  const o = (await coach('GET', `/v1/clients/${ava.id}/engagement`)).body;
  assert.ok(o.averages && Array.isArray(o.checkins) && Array.isArray(o.flagged) && o.education);
});

test('targets accept feet and inches, and rankings follow the setting without naming anyone', async () => {
  let t = await coach('POST', `/v1/clients/${ava.id}/targets`, { test: 'broad_jump', target: '7\'0"', due_date: '2026-12-01' });
  assert.equal(t.status, 201);
  assert.deepEqual([t.body.target, t.body.target_text, t.body.best_text], [84, '7′ 0″', '6′ 5″']);
  assert.equal(t.body.pct, 42, '5 of 12 inches from the first jump');
  t = await coach('POST', `/v1/clients/${ava.id}/targets`, { test: 'broad_jump', target: '6\'5"' });       // replaces the old one
  assert.deepEqual([t.body.target, t.body.reached, t.body.pct], [77, true, 100]);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM test_targets WHERE client_id = ?', ava.id).n, 1);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/targets`, { test: 'broad_jump', target: 'far' })).status, 400);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/targets`, { test: 'dash_40yd', target: '1:05' })).body.target, 65);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/targets`, { test: 'no_such_test', target: 3 })).status, 404);

  let perf = (await athlete(ava)('GET', 'engage')).body.performance;
  assert.equal(perf.rankings, null, 'rankings are off until a coach turns them on');
  assert.ok(perf.targets.find((x) => x.test === 'broad_jump' && x.reached));
  assert.equal((await coach('PATCH', '/v1/engagement/settings', { rankings: 'on' })).body.rankings, 'on');
  perf = (await athlete(ava)('GET', 'engage')).body.performance;
  const broad = perf.rankings.find((x) => x.test === 'broad_jump');
  const girls = broad.ranks.find((x) => x.group === 'Girls 12–13');
  assert.deepEqual([girls.rank, girls.of, girls.percentile], [2, 5, 63], 'Ava ties June at 77: ties count half');
  assert.deepEqual(broad.ranks.find((x) => x.group === 'Everyone at Diamond Protocol').of, 6);
  assert.ok(!broad.ranks.some((x) => x.group.includes('14U')), 'teams with fewer than 4 tested athletes are not ranked');
  const text = JSON.stringify(perf.rankings);
  for (const other of [...others, cole]) assert.ok(!text.includes(other.name.split(' ')[0]), 'no other names in rankings');
  await coach('PATCH', '/v1/engagement/settings', { rankings: 'off' });
  assert.equal((await athlete(ava)('GET', 'engage')).body.performance.rankings, null);
  assert.equal((await coach('GET', '/v1/settings')).body.rankings, 'off');
});

test('education: lessons, courses, assignments and completion, with unpublished lessons hidden', async () => {
  const c = (await coach('POST', '/v1/courses', { title: 'Speed school', description: 'Run faster.' })).body;
  const l1 = (await coach('POST', '/v1/lessons', { title: 'Arm action', body: 'Cheek to pocket.\n\nRelax the hands.', course_id: c.id, minutes: 3 })).body;
  const l2 = (await coach('POST', '/v1/lessons', { title: 'Shin angles', body: 'Push the ground back.', course_id: c.id })).body;
  const hidden = (await coach('POST', '/v1/lessons', { title: 'Draft', published: false })).body;
  assert.equal((await coach('POST', '/v1/lessons', { title: 'Bad video', video_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await coach('POST', '/v1/lessons', { title: 'Plain video', video_url: 'http://example.com/v.mp4' })).status, 400);
  assert.equal((await coach('POST', '/v1/lessons', { summary: 'no title' })).status, 400);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { course_id: c.id, client_id: ava.id, due_date: addDaysToDate(localDate(new Date().toISOString(), 'America/Chicago'), 30), note: 'Start here' })).status, 201);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: l1.id, course_id: c.id, client_id: ava.id })).status, 400);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { lesson_id: hidden.id, client_id: ava.id })).status, 409);
  assert.ok(app.ctx.db.get(`SELECT 1 FROM outbox WHERE to_email = 'maria@example.com' AND subject LIKE '%Speed school%'`), 'parents hear about it');

  const me = athlete(ava);
  let edu = (await me('GET', 'engage')).body.education;
  const course = edu.courses.find((x) => x.id === c.id);
  assert.deepEqual([course.done, course.total], [0, 2]);
  assert.ok(!JSON.stringify(edu).includes('"Draft"'));
  assert.equal((await me('GET', `lessons/${hidden.id}`)).status, 404);

  const first = (await me('GET', `lessons/${l1.id}`)).body;
  assert.equal(first.next.id, l2.id);
  assert.deepEqual(first.position, { n: 1, of: 2 });
  assert.equal(first.body, 'Cheek to pocket.\n\nRelax the hands.');
  await coach('PUT', `/v1/courses/${c.id}/order`, { lesson_ids: [l2.id, l1.id] });
  assert.equal((await me('GET', `lessons/${l2.id}`)).body.next.id, l1.id, 'reordered in one step');
  assert.equal((await me('POST', `lessons/${l1.id}/complete`, { done: true })).body.done, true);
  await me('POST', `lessons/${l2.id}/complete`, {});
  edu = (await me('GET', 'engage')).body.education;
  assert.equal(edu.assigned.find((x) => x.course_id === c.id).done, true);
  const report = (await coach('GET', '/v1/education')).body;
  const row = report.assignments.find((x) => x.course_id === c.id);
  assert.deepEqual([row.finished, row.total, row.assigned_to], [1, 1, 'Ava Lopez']);
  assert.equal(report.courses.find((x) => x.id === c.id).lessons.find((l) => l.id === l1.id).completions, 1);

  // Team reading reaches every roster athlete (each has a profile and the app).
  const t = await coach('POST', '/v1/lesson-assignments', { lesson_id: l1.id, contract_id: team.id });
  assert.equal(t.body.recipients, 3);
  assert.ok((await me('GET', 'engage')).body.education.assigned.find((x) => x.id === t.body.id && x.team && x.done));
  await coach('PATCH', `/v1/lessons/${l1.id}`, { published: false });
  assert.equal((await me('GET', `lessons/${l1.id}`)).status, 404, 'unpublishing hides it again');
  await coach('DELETE', `/v1/courses/${c.id}`);
  assert.ok((await coach('GET', `/v1/lessons/${l2.id}`)).body.course_id === null, 'deleting a course keeps its lessons');
});

test('parents see only their own athletes, and can check in and finish lessons for them', async () => {
  const r = await maria('GET', `/portal/api/athletes/${ben.id}/engage`);
  assert.equal(r.status, 200);
  assert.equal(r.body.athlete.first_name, 'Ben');
  assert.equal((await maria('GET', `/portal/api/athletes/${cole.id}/engage`)).status, 404);
  assert.equal((await maria('POST', `/portal/api/athletes/${cole.id}/daily-check-in`, { mood: 3 })).status, 404);
  assert.equal((await maria('POST', `/portal/api/athletes/${ben.id}/daily-check-in`, { mood: 4, energy: 4 })).status, 200);
  const lesson = app.ctx.db.get('SELECT id FROM lessons WHERE published = 1 LIMIT 1');
  assert.equal((await maria('POST', `/portal/api/athletes/${ben.id}/lessons/${lesson.id}/complete`, { done: true })).body.done, true);
  assert.equal((await dana('GET', `/portal/api/athletes/${ava.id}/lessons/${lesson.id}`)).status, 404);
  assert.equal((await req('GET', `/portal/api/athletes/${ava.id}/engage`)).status, 401);
  const me = (await maria('GET', '/portal/api/me')).body;
  assert.equal(me.athletes.find((a) => a.id === ben.id).engagement.checked_in_today, true);
});

test('parents and athletes never see results from unshared testing days; coaches do', async () => {
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Private retest', tests: ['vertical_standing'] })).body;
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: ava.id, test: 'vertical_standing', value: 40 }] });
  for (const view of [(await maria('GET', `/portal/api/athletes/${ava.id}/engage`)).body, (await athlete(ava)('GET', 'engage')).body]) {
    assert.ok(!view.performance.tests.some((t) => t.test === 'vertical_standing'), 'unshared result stays hidden');
  }
  const staff = (await coach('GET', `/v1/clients/${ava.id}/engagement`)).body;
  assert.equal(staff.tests.find((t) => t.test === 'vertical_standing').best, 40);
});

test('Today lists athletes whose latest check-in needs a look', async () => {
  await dana('POST', `/portal/api/athletes/${cole.id}/daily-check-in`, { sleep_hours: 5.5, soreness: 4, mood: 4, note: 'Tight hamstring' });
  const flags = (await coach('GET', '/v1/daily-check-ins/flags')).body.data;
  const c = flags.find((f) => f.client_id === cole.id);
  assert.deepEqual(c.flags, ['Slept 5.5 hours', 'Soreness 4 of 5']);
  assert.equal(c.note, 'Tight hamstring');
  assert.ok(!flags.some((f) => f.client_id === ava.id), 'Ava\'s check-in today is fine');
  const o = (await coach('GET', `/v1/clients/${cole.id}/engagement`)).body;
  assert.equal(o.flagged[0].flags[0], 'Slept 5.5 hours');
});

test('deleting a family removes check-ins, goals and lesson progress', async () => {
  await owner('DELETE', `/v1/families/${ava.family.id}`, { confirm: 'Lopez family' });
  for (const t of ['daily_checkins', 'lesson_progress', 'goals', 'coach_messages', 'test_targets']) assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE client_id IN (?, ?)`, ava.id, ben.id).n, 0, t);
});
