// The weekly coach's note and the team board (schema 71, services/weekly.js): a line per athlete drafted from last
// week's facts, read and sent by a coach (or sent as drafted in auto mode), shown on the Workout tab with a push;
// clean weeks in a row from the training calendar; the team board for athletes who opt in. The clock is pinned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';
import { runWeekly, draftText } from '../src/services/weekly.js';

let app, base, owner, coach, desk, program, ws;
const PW = 'correct-horse-battery';
const NOW = '2026-10-19T15:00:00.000Z';   // Monday 10 am Chicago
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => { const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
}
const asAthlete = (token) => async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
async function member(name, { team = null } = {}) {
  const c = (await coach('POST', '/v1/clients', { name, parent: { name: `Parent ${name}`, email: `${name.split(' ')[0].toLowerCase()}.w@example.com` } })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), c.id, NOW, NOW, NOW, NOW);
  if (team) app.ctx.db.run(`INSERT INTO team_roster (id, contract_id, client_id, name, athlete_id, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`, newId('tr'), team, c.id, name, c.athlete_id, NOW);
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: c.id, start_date: '2026-10-05', training_days: [1, 3, 5] });
  const token = (await coach('GET', `/v1/clients/${c.id}`)).body.app_link.split('token=')[1];
  return { ...c, app: asAthlete(token) };
}
const w = (wk, d) => ws.find((x) => x.week === wk && x.day === d);
function logOn(clientId, workoutId, date, sets = []) {
  const a = app.ctx.db.get('SELECT id FROM assignments WHERE client_id = ? AND active = 1', clientId);
  const id = newId('wl');
  app.ctx.db.run(`INSERT INTO workout_logs (id, client_id, workout_id, assignment_id, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)`, id, clientId, workoutId, a.id, `${date}T22:00:00.000Z`, `${date}T22:50:00.000Z`);
  sets.forEach(([weight, reps], i) => app.ctx.db.run(`INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES (?, ?, ?, ?, 'Back squat', ?, ?, ?, ?)`, newId('ws'), id, w(1, 1).exercises[0].id, w(1, 1).exercises[0].exercise_id, i + 1, weight, reps, `${date}T22:30:00.000Z`));
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  app.ctx.pushPending = []; app.ctx.pushFetch = async () => new Response(null, { status: 201 });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, NOW);
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall block', weeks: 4 })).body;
  for (let wk = 1; wk <= 4; wk++) for (let d = 1; d <= 3; d++) {
    const wo = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: wk, day: d, title: `W${wk} D${d}` })).body;
    await coach('POST', `/v1/workouts/${wo.id}/exercises`, { exercise_id: squat.id, sets: 4, reps: '6' });
  }
  ws = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts;
});
after(() => app.server.close());

test('the draft: plain words from the week\'s facts', () => {
  assert.equal(draftText({ planned: 3, done: 3, missed: 0, sets: 24, checkins: 5, streak: 3, top_lift: { name: 'Back squat', e1rm: 205, change: 10 } }, 'Ava Lopez'),
    'Ava: 3 of 3 workouts done, 3 clean weeks in a row. That\'s how it\'s built. Back squat is up about 10 lb on your estimated max. 5 check-ins, which is what lets me adjust your days.');
  assert.equal(draftText({ planned: 3, done: 1, missed: 2, sets: 8, checkins: 0, streak: 0, top_lift: null }, 'Kai Jensen'), 'Kai: 1 of 3 workouts last week. 2 slipped; let\'s get every one this week. Check in before you train this week so I can see how you\'re feeling.');
  assert.equal(draftText({ planned: 0, done: 0, missed: 0, sets: 0, checkins: 0, streak: 0, top_lift: null }, 'Mia Chen'), 'Mia: a quiet week. This week, one workout and one check-in.');
});

test('Monday: last week\'s notes are drafted from the facts; a coach reads, changes and sends; the athlete sees it with the clean-week streak', async () => {
  const ava = await member('Ava Lopez');
  for (const [wk, d, date, sets] of [[1, 1, '2026-10-05', [[185, 6]]], [1, 2, '2026-10-07', []], [1, 3, '2026-10-09', []], [2, 1, '2026-10-12', [[195, 6]]], [2, 2, '2026-10-14', []], [2, 3, '2026-10-16', [[205, 5]]]]) logOn(ava.id, w(wk, d).id, date, sets);
  const kai = await member('Kai Jensen');
  logOn(kai.id, w(1, 1).id, '2026-10-05'); logOn(kai.id, w(2, 1).id, '2026-10-12');
  assert.equal((await desk('GET', '/v1/weekly-notes')).status, 403, 'front desk has no part');
  // The job: Monday 10 am, last week = Oct 12.
  const job = runWeekly(app.ctx);
  assert.deepEqual([job.week_start, job.written, job.sent], ['2026-10-12', 2, 0], JSON.stringify(job));
  assert.deepEqual(runWeekly(app.ctx), { skipped: 'done' }, 'once a week');
  const list = (await coach('GET', '/v1/weekly-notes')).body;
  assert.deepEqual([list.mode, list.weeks[0].week_start, list.weeks[0].drafts, list.data.length], ['review', '2026-10-12', 2, 2]);
  const avaNote = list.data.find((n) => n.client_name === 'Ava Lopez'), kaiNote = list.data.find((n) => n.client_name === 'Kai Jensen');
  assert.deepEqual([avaNote.facts.planned, avaNote.facts.done, avaNote.facts.sets, avaNote.facts.minutes, avaNote.facts.streak, avaNote.facts.top_lift.name, avaNote.facts.top_lift.e1rm, avaNote.facts.top_lift.change], [3, 3, 2, 150, 2, 'Back squat', 239, 17]);
  assert.match(avaNote.body, /^Ava: 3 of 3 workouts done, 2 clean weeks in a row/);
  assert.match(kaiNote.body, /^Kai: 1 of 3 workouts last week. 2 slipped/);
  // Today says so.
  const item = (await coach('GET', '/v1/dashboard')).body.attention.find((x) => x.kind === 'weekly_notes');
  assert.deepEqual([item.count, item.week], [2, '2026-10-12']);
  // Before it's sent: nothing in the app, but the streak strip is there.
  const home0 = (await ava.app('GET', '/app/api/home')).body;
  assert.equal(home0.weekly_note, null);
  assert.deepEqual([home0.week.week_start, home0.week.planned, home0.week.done, home0.week.streak], ['2026-10-19', 3, 0, 2]);
  assert.equal((await ava.app('GET', '/app/api/engage')).body.accountability.streaks.plan_weeks, 2);
  // The coach changes the words and sends.
  const edited = await coach('PATCH', `/v1/weekly-notes/${avaNote.id}`, { body: 'Ava: three for three and the squat is moving. This week we add a set on Friday.' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.drafted, avaNote.body, 'the draft is kept beside the words');
  const sent = await coach('POST', `/v1/weekly-notes/${avaNote.id}/send`);
  assert.deepEqual([sent.status, sent.body.status, sent.body.sent_by], [200, 'sent', 'Riley']);
  assert.equal((await coach('PATCH', `/v1/weekly-notes/${avaNote.id}`, { body: 'x' })).status, 409, 'sent notes never change');
  const home = (await ava.app('GET', '/app/api/home')).body;
  assert.deepEqual([home.weekly_note.body, home.weekly_note.by, home.weekly_note.week_label], ['Ava: three for three and the squat is moving. This week we add a set on Friday.', 'Riley', 'Oct 12 to Oct 18']);
  assert.ok(app.ctx.db.get(`SELECT id FROM push_notices WHERE client_id = ? AND kind = 'weekly_note'`, ava.id) === undefined, 'no phone subscribed: no notice row');
  assert.ok(app.ctx.db.get(`SELECT id FROM events WHERE type = 'weekly_note.sent'`));
  // Skip the other; Send all with nothing left; the export.
  assert.equal((await coach('POST', `/v1/weekly-notes/${kaiNote.id}/skip`)).body.status, 'skipped');
  assert.deepEqual((await coach('POST', '/v1/weekly-notes/send-all', { week: '2026-10-12' })).body, { sent: 0, skipped: [] });
  assert.ok(!(await coach('GET', '/v1/dashboard')).body.attention.some((x) => x.kind === 'weekly_notes'));
  const fam = (await coach('GET', `/v1/clients/${ava.id}`)).body.family;
  const exp = (await owner('GET', `/v1/families/${fam.id}/export`)).body.athletes[0];
  assert.deepEqual([exp.weekly_notes.length, exp.weekly_notes[0].status, exp.team_board_opt_in], [1, 'sent', false]);
  // Auto mode: the next Monday's drafts go out on their own.
  await owner('PATCH', '/v1/settings', { weekly_notes: 'auto' });
  app.ctx.now = () => '2026-10-26T15:00:00.000Z';
  try {
    const job2 = runWeekly(app.ctx);
    assert.deepEqual([job2.week_start, job2.written, job2.sent], ['2026-10-19', 2, 2], JSON.stringify(job2));
    assert.equal((await ava.app('GET', '/app/api/home')).body.weekly_note.by, null, 'sent on its own: no coach named');
  } finally { app.ctx.now = () => NOW; await owner('PATCH', '/v1/settings', { weekly_notes: 'review' }); }
  assert.equal((await coach('POST', '/v1/weekly-notes/generate', { week: '2026-10-19' })).status, 400, 'this week isn\'t over');
});

test('the team board: the owner\'s rankings on and the athlete\'s own opt-in; first names only; three or more on it', async () => {
  app.ctx.db.run(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_w', 'Westlake High', 'school', ?)`, NOW);
  app.ctx.db.run(`INSERT INTO team_contracts (id, org_id, name, monthly_cents, start_date, status, next_period_start, created_at) VALUES ('tc_w', 'org_w', 'Varsity', 50000, '2026-09-01', 'active', '2026-11-01', ?)`, NOW);
  const zoe = await member('Zoe Adams', { team: 'tc_w' }), nia = await member('Nia Brooks', { team: 'tc_w' }), leo = await member('Leo Park', { team: 'tc_w' });
  logOn(zoe.id, w(3, 1).id, '2026-10-19'); logOn(nia.id, w(3, 1).id, '2026-10-19'); logOn(nia.id, w(3, 2).id, '2026-10-19');
  const off = (await zoe.app('GET', '/app/api/leaderboard')).body;
  assert.deepEqual([off.enabled, off.opted_in, off.groups], [false, false, []], 'rankings off: nothing');
  await owner('PATCH', '/v1/engagement/settings', { rankings: 'on' });
  const notIn = (await zoe.app('GET', '/app/api/leaderboard')).body;
  assert.deepEqual([notIn.enabled, notIn.opted_in, notIn.teams, notIn.groups], [true, false, 2, []], 'not opted in: no rows');
  assert.equal((await zoe.app('POST', '/app/api/leaderboard/opt-in', { on: true })).body.opted_in, true);
  assert.deepEqual((await zoe.app('GET', '/app/api/leaderboard')).body.groups, [], 'alone on the board: nothing shows yet');
  await nia.app('POST', '/app/api/leaderboard/opt-in', { on: true }); await leo.app('POST', '/app/api/leaderboard/opt-in', { on: true });
  const b = (await zoe.app('GET', '/app/api/leaderboard')).body;
  assert.deepEqual(b.groups.map((g) => g.label), ['Westlake High Varsity', 'Everyone on Fall block']);
  assert.deepEqual(b.groups[0].rows.map((r) => [r.rank, r.name, r.me, r.done, r.planned]), [[1, 'Nia B.', false, 2, 3], [2, 'Zoe A.', true, 1, 3], [3, 'Leo P.', false, 0, 3]]);
  assert.ok(b.groups[1].rows.length >= 3 && !b.groups[1].rows.some((r) => r.name === 'Ava L.' || r.name === 'Kai J.'), 'the program group lists only athletes who opted in');
  assert.equal((await leo.app('POST', '/app/api/leaderboard/opt-in', { on: false })).body.opted_in, false);
  assert.deepEqual((await zoe.app('GET', '/app/api/leaderboard')).body.groups, [], 'two left on the board: both groups hide until a third joins');
  // The family export and deletion.
  const fam = (await coach('GET', `/v1/clients/${zoe.id}`)).body.family;
  assert.equal((await owner('GET', `/v1/families/${fam.id}/export`)).body.athletes[0].team_board_opt_in, true);
  assert.equal((await owner('DELETE', `/v1/families/${fam.id}`, { confirm: fam.name })).status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM leaderboard_optins WHERE client_id = ?', zoe.id).n, 0);
});

test('a version 70 database gains the weekly note tables', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-weekly-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v70.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 70');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 71, `round ${round}`);
      for (const t of ['weekly_notes', 'leaderboard_optins']) assert.ok(d.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t), t);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
