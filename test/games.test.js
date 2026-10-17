// The game-week helper (schema 82, services/gameweek.js): athletes, parents and coaches keep the athlete's games, races
// and competitions; every day of the training calendar takes a colour from where it sits against them (green = the
// full workout, yellow = one set fewer on every exercise, red = half the sets), worked out on read, so a game whose
// date changes moves the colours and the sets at once; schedules come in from .ics, CSV or pasted lines; the owner
// alone changes the rules; games are in the family export; the version 81 database gains the table.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { openDb } from '../src/db.js';
import { newId } from '../src/util.js';
import { dayInfo, cutSets, parseIcs, parseCsv, readDate, DEFAULT_RULES } from '../src/services/gameweek.js';

let app, base, owner, coach, desk, maya, token, program, parent;
const PW = 'correct-horse-battery';
const NOW = '2026-10-07T15:00:00.000Z', TODAY = '2026-10-07';   // a Wednesday
async function req(method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text, res: r };
}
const cookieOf = (r) => r.res.headers.get('set-cookie').split(';')[0];
async function staff(email) {
  const r = await req('POST', '/auth/login', { email, password: PW });
  const cookie = cookieOf(r);
  return (m, p, b) => req(m, p, b, { cookie });
}
const athlete = (m, p, b) => req(m, p, b, { 'x-client-token': token });
async function parentSignIn(email) {
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await req('POST', '/portal/api/login', { email })).body.dev_code;
  const v = await req('POST', '/portal/api/verify', { email, code });
  const cookie = cookieOf(v);
  return (m, p, b) => req(m, p, b, { cookie });
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  maya = (await coach('POST', '/v1/clients', { name: 'Maya Okafor', birth_date: '2011-04-02', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', maya.id).access_token;
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    newId('sub'), maya.id, plan.id, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', NOW, NOW);
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body', movement: 'squat' })).body;
  const bench = (await coach('POST', '/v1/exercises', { name: 'Bench press', category: 'Upper body', movement: 'push' })).body;
  const hips = (await coach('POST', '/v1/exercises', { name: 'Hip circles', category: 'Mobility', movement: 'mobility' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'In-season strength', weeks: 2 })).body;
  for (const week of [1, 2]) {
    const lower = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week, day: 1, title: 'Lower body' })).body;
    await coach('POST', `/v1/workouts/${lower.id}/exercises`, { exercise_id: squat.id, sets: 4, reps: '4', load_test: 'squat_1rm', load_pct: 85 });
    const upper = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week, day: 2, title: 'Upper body' })).body;
    await coach('POST', `/v1/workouts/${upper.id}/exercises`, { exercise_id: bench.id, sets: 3, reps: '8', target_rpe: 7 });
    const mob = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week, day: 3, title: 'Mobility' })).body;
    await coach('POST', `/v1/workouts/${mob.id}/exercises`, { exercise_id: hips.id, sets: 2, reps: '10' });
  }
  // Monday, Wednesday, Friday from Monday Oct 5: Lower Oct 5 and 12, Upper Oct 7 and 14, Mobility Oct 9 and 16.
  const a = await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: maya.id, start_date: '2026-10-05', training_days: [1, 3, 5] });
  assert.equal(a.status, 201, a.text);
  parent = await parentSignIn('ada@example.com');
});
after(() => app.server.close());

test('where a day sits against the games, and which rule applies', () => {
  const r = DEFAULT_RULES;
  assert.equal(dayInfo('2026-10-10', ['2026-10-10'], r).offset, 0);
  assert.deepEqual([dayInfo('2026-10-09', ['2026-10-10'], r).key, dayInfo('2026-10-08', ['2026-10-10'], r).key, dayInfo('2026-10-07', ['2026-10-10'], r).key], ['-1', '-2', '-3']);
  assert.deepEqual([dayInfo('2026-10-11', ['2026-10-10'], r).allow, dayInfo('2026-10-12', ['2026-10-10'], r).allow, dayInfo('2026-10-13', ['2026-10-10'], r).allow], ['light', 'moderate', 'heavy']);
  assert.deepEqual([dayInfo('2026-10-11', ['2026-10-10'], r).tone, dayInfo('2026-10-12', ['2026-10-10'], r).cut, dayInfo('2026-10-13', ['2026-10-10'], r).cut], ['red', 'minus_one', null], 'the colour and what it does to the sets');
  const clear = dayInfo('2026-10-20', ['2026-10-10'], r);
  assert.deepEqual([clear.offset, clear.allow, clear.tone, clear.cut, clear.advice, clear.after], [null, 'heavy', 'green', null, null, 10]);
  // Between two games (Saturday and Tuesday): the Monday is two days after one and the day before the other: the stricter wins, the other is mentioned.
  const between = dayInfo('2026-10-12', ['2026-10-10', '2026-10-13'], r);
  assert.deepEqual([between.key, between.allow], ['-1', 'light']);
  assert.match(between.advice, /You also played 2 days ago\.$/);
  assert.equal(dayInfo('2026-10-12', ['2026-10-10', '2026-10-13'], { ...r, '-1': { ...r['-1'], allow: 'heavy' } }).key, '2', 'the owner\'s rules decide which is stricter');
});

test('what each colour does to the sets: yellow one fewer, red half (rounded up), never below one', () => {
  assert.deepEqual([4, 3, 1].map((n) => cutSets(n, null)), [4, 3, 1], 'green: as written');
  assert.deepEqual([4, 3, 1].map((n) => cutSets(n, 'minus_one')), [3, 2, 1]);
  assert.deepEqual([4, 3, 2, 1].map((n) => cutSets(n, 'half')), [2, 2, 1, 1]);
});

test('reading a schedule: .ics with every date form, CSV with a header, pasted lines', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a1@teamsnap', 'DTSTART;VALUE=DATE:20261010', 'SUMMARY:vs Westlake', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a2@teamsnap', 'DTSTART;TZID=America/Denver:20261017T100000', 'SUMMARY:Game @ Hill ', ' Country FC', 'LOCATION:Field 3\\, Park', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a3@teamsnap', 'DTSTART:20261021T010000Z', 'SUMMARY:Practice', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a4@teamsnap', 'DTSTART;VALUE=DATE:20261024', 'SUMMARY:Fall Tournament - pool play', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const ev = parseIcs(ics, 'America/Denver');
  assert.deepEqual(ev.map((e) => [e.date, e.time, e.title, e.import_key]), [
    ['2026-10-10', null, 'vs Westlake', 'a1@teamsnap'], ['2026-10-17', '10:00', 'Game @ Hill Country FC', 'a2@teamsnap'],
    ['2026-10-20', '19:00', 'Practice', 'a3@teamsnap'], ['2026-10-24', null, 'Fall Tournament - pool play', 'a4@teamsnap']], 'a folded line joins; a UTC time becomes the business\'s evening before');
  assert.equal(ev[1].location, 'Field 3, Park');
  const csv = parseCsv('Date,Time,Opponent,Type\n10/10/2026,2:30 PM,Westlake,Game\n"Oct 24, 2026",,Tournament,tournament\n', TODAY);
  assert.deepEqual(csv.map((e) => [e.date, e.time, e.title, e.kind_text]), [['2026-10-10', '14:30', 'vs Westlake', 'Game'], ['2026-10-24', null, 'Tournament', 'tournament']]);
  const lines = parseCsv('Oct 18 10:00 vs Westlake\n2026-10-25, 4pm, @ Hill Country\nNov 1 Tournament\n18 Jan vs Reagan', TODAY);
  assert.deepEqual(lines.map((e) => [e.date, e.time, e.title]), [['2026-10-18', '10:00', 'vs Westlake'], ['2026-10-25', '16:00', '@ Hill Country'], ['2026-11-01', null, 'Tournament'], ['2027-01-18', null, 'vs Reagan']], 'a date with no year is the next one coming');
  assert.equal(readDate('13/45/2026', TODAY), null);
});

test('the athlete adds a game: each day takes its colour, the sets follow in the app, and a changed date resets everything', async () => {
  let home = (await athlete('GET', '/app/api/home')).body;
  assert.equal(home.games.games_on_file, 0);
  assert.deepEqual([home.workout.title, home.workout.game_day, home.workout.exercises[0].target_sets], ['Upper body', null, 3], 'no games: nothing changes');
  const add = await athlete('POST', '/app/api/games', { date: '2026-10-10', time: '14:00', title: 'vs Westlake' });
  assert.equal(add.status, 201, add.text); assert.equal(add.body.source, 'athlete'); assert.equal(add.body.created_by, 'Maya Okafor'); assert.equal(add.body.kind_word, 'game');
  assert.equal((await athlete('POST', '/app/api/games', { date: '2026-10-10', title: 'VS WESTLAKE' })).status, 409, 'the same game twice');
  assert.equal((await athlete('POST', '/app/api/games', { date: '2026-10-10', time: '25:00' })).status, 400);
  const plan = (await athlete('GET', '/app/api/games')).body;
  assert.equal(plan.next_game.title, 'vs Westlake');
  assert.deepEqual([plan.now.offset, plan.now.label, plan.now.tone, plan.now.cut], [-3, 'Three days out', 'green', null], 'Wednesday is three days out from Saturday: the full workout');
  const byDate = Object.fromEntries(plan.days.map((d) => [d.date, d]));
  assert.deepEqual(byDate['2026-10-07'].workouts.map((w) => [w.title, w.sets, w.sets_today]), [['Upper body', 3, 3]]);
  assert.deepEqual([byDate['2026-10-09'].tone, byDate['2026-10-09'].cut_text, byDate['2026-10-09'].workouts[0].sets_today], ['red', 'half the sets on every exercise', 1], 'the day before: half of 2 sets is 1');
  assert.deepEqual([byDate['2026-10-10'].offset, byDate['2026-10-10'].tone, byDate['2026-10-10'].games[0].title], [0, 'red', 'vs Westlake']);
  assert.deepEqual([byDate['2026-10-12'].label, byDate['2026-10-12'].tone, byDate['2026-10-12'].workouts[0].sets_today], ['Two days after', 'yellow', 3], 'two days after: 4 sets of squats become 3');
  assert.deepEqual([byDate['2026-10-14'].tone, byDate['2026-10-14'].offset], ['green', null], 'four days after: clear');
  home = (await athlete('GET', '/app/api/home')).body;
  assert.deepEqual([home.games.days_to_next, home.games.game_dates, home.games.now.tone], [3, ['2026-10-10'], 'green']);
  assert.equal(home.games.by_date['2026-10-10'].game.title, 'vs Westlake');
  assert.deepEqual([home.games.by_date['2026-10-09'].tone, home.games.by_date['2026-10-12'].tone, home.games.by_date['2026-10-14']], ['red', 'yellow', undefined], 'only coloured days are listed');
  assert.deepEqual([home.workout.game_day.tone, home.workout.game_day.game.title, home.workout.exercises[0].target_sets, home.workout.exercises[0].game_cut], ['green', 'vs Westlake', 3, undefined], 'today is green: the workout as written');
  // The workouts on coloured days, opened from the calendar: the same exercises, fewer sets.
  const lower = home.calendar.workouts.find((w) => w.date === '2026-10-12'), mob = home.calendar.workouts.find((w) => w.date === '2026-10-09');
  let w = (await athlete('GET', `/app/api/workouts/${lower.id}`)).body;
  assert.deepEqual([w.game_day.tone, w.game_day.cut, w.game_day.label, w.exercises[0].target_sets, w.exercises[0].planned_sets, w.exercises[0].game_cut, w.exercises[0].reps], ['yellow', 'minus_one', 'Two days after', 3, 4, 'minus_one', '4'], 'one set fewer, the reps and weight the same');
  w = (await athlete('GET', `/app/api/workouts/${mob.id}`)).body;
  assert.deepEqual([w.game_day.tone, w.exercises[0].target_sets, w.exercises[0].planned_sets, w.exercises[0].game_cut], ['red', 1, 2, 'half']);
  // The game moves a week: every colour and set count follows at once, nothing else to do.
  assert.equal((await athlete('PATCH', `/app/api/games/${add.body.id}`, {})).status, 400, 'nothing to change');
  assert.equal((await athlete('PATCH', `/app/api/games/${add.body.id}`, { time: '9pm' })).status, 400);
  const moved = await athlete('PATCH', `/app/api/games/${add.body.id}`, { date: '2026-10-17' });
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual([moved.body.date, moved.body.title, moved.body.time, moved.body.was.date], ['2026-10-17', 'vs Westlake', '14:00', '2026-10-10'], 'the rest stays');
  w = (await athlete('GET', `/app/api/workouts/${lower.id}`)).body;
  assert.deepEqual([w.game_day, w.exercises[0].target_sets, w.exercises[0].planned_sets], [null, 4, undefined], 'Oct 12 is clear now: all 4 sets');
  home = (await athlete('GET', '/app/api/home')).body;
  assert.deepEqual([home.games.now.tone, home.games.by_date['2026-10-16'].tone, home.games.by_date['2026-10-14'].tone, home.games.by_date['2026-10-09']], ['green', 'red', 'green', undefined], 'the colours moved with the game');
  const back = await athlete('PATCH', `/app/api/games/${add.body.id}`, { date: '2026-10-10' });
  assert.equal(back.status, 200, back.text);
  assert.equal((await athlete('GET', `/app/api/workouts/${lower.id}`)).body.exercises[0].target_sets, 3, 'and back again');
});

test('a second game close by: the stricter day wins, and the weight-room screen and the Live panel cut the same sets', async () => {
  const add = await parent('POST', `/portal/api/athletes/${maya.id}/games`, { date: '2026-10-13', title: 'vs Reagan', kind: 'scrimmage' });
  assert.equal(add.status, 201, add.text); assert.equal(add.body.source, 'parent');
  const plan = (await parent('GET', `/portal/api/athletes/${maya.id}/games`)).body;
  const byDate = Object.fromEntries(plan.days.map((d) => [d.date, d]));
  assert.deepEqual([byDate['2026-10-12'].key, byDate['2026-10-12'].tone, byDate['2026-10-12'].workouts[0].sets_today], ['-1', 'red', 2], 'two days after one game and the day before the next: red, half the sets');
  assert.match(byDate['2026-10-12'].advice, /You also played 2 days ago\.$/);
  assert.equal(byDate['2026-10-13'].offset, 0);
  assert.equal((await parent('PATCH', `/portal/api/athletes/${maya.id}/games/${add.body.id}`, { date: '2026-10-10', title: 'vs Westlake' })).status, 409, 'onto a game already on file');
  // The coach's Live panel for a session today reads the same colour (today is green, so the full sets), as does the client page's plan.
  const cplan = (await coach('GET', `/v1/clients/${maya.id}/game-plan`)).body;
  assert.deepEqual(cplan.days.find((d) => d.date === '2026-10-12').workouts.map((w) => [w.title, w.sets, w.sets_today]), [['Lower body', 4, 2]]);
  assert.deepEqual(Object.keys(cplan.colors), ['green', 'yellow', 'red']);
});

test('coaches bring the team\'s calendar in: practices start unticked, duplicates are skipped, the same file twice adds nothing', async () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:g1', 'DTSTART;VALUE=DATE:20261010', 'SUMMARY:vs Westlake', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:g2', 'DTSTART;VALUE=DATE:20261017', 'SUMMARY:vs Hill Country', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:p1', 'DTSTART;TZID=America/Denver:20261015T173000', 'SUMMARY:Practice', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:old', 'DTSTART;VALUE=DATE:20260901', 'SUMMARY:vs Last month', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:t1', 'DTSTART;VALUE=DATE:20261024', 'SUMMARY:Fall Tournament', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const pv = await coach('POST', `/v1/clients/${maya.id}/games/preview`, { text: ics });
  assert.equal(pv.status, 200, pv.text);
  assert.equal(pv.body.format, 'ics');
  assert.deepEqual(pv.body.items.map((i) => [i.date, i.kind, i.practice, i.checked, i.skip]), [
    ['2026-09-01', 'game', false, false, 'Already happened'], ['2026-10-10', 'game', false, false, 'Already on file'], ['2026-10-15', 'game', true, false, null], ['2026-10-17', 'game', false, true, null], ['2026-10-24', 'tournament', false, true, null]]);
  assert.deepEqual(pv.body.counts, { found: 5, games: 2, practices: 1, skipped: 2 });
  const items = pv.body.items.filter((i) => i.checked).map((i) => ({ date: i.date, time: i.time, title: i.title, kind: i.kind, import_key: i.import_key }));
  const imp = await coach('POST', `/v1/clients/${maya.id}/games/import`, { items: [...items, { date: '2026-10-10', title: 'vs Westlake' }] });
  assert.equal(imp.status, 201, imp.text);
  assert.deepEqual([imp.body.added, imp.body.skipped], [2, 1]);
  const again = await coach('POST', `/v1/clients/${maya.id}/games/import`, { items });
  assert.deepEqual([again.body.added, again.body.skipped], [0, 2], 'the same calendar again changes nothing');
  const list = (await coach('GET', `/v1/clients/${maya.id}/games`)).body.data;
  assert.deepEqual(list.map((g) => [g.date, g.title, g.kind, g.source]), [['2026-10-10', 'vs Westlake', 'game', 'athlete'], ['2026-10-13', 'vs Reagan', 'scrimmage', 'parent'], ['2026-10-17', 'vs Hill Country', 'game', 'coach'], ['2026-10-24', 'Fall Tournament', 'tournament', 'coach']]);
  const bad = await coach('POST', `/v1/clients/${maya.id}/games/import`, { items: [{ date: 'soon' }, { date: '2026-11-02', kind: 'final' }] });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details.problems.length, 2);
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/games/preview`, { text: 'nothing here' })).status, 400);
  // Races, meets and competitions are kinds of their own (the owner's words: "games, races, and competitions").
  const pv2 = (await coach('POST', `/v1/clients/${maya.id}/games/preview`, { text: 'Nov 14 8:00 Cross country regional\nNov 21 State track meet\nDec 5 Winter Classic competition\nDec 12 vs Lake Travis' })).body;
  assert.deepEqual(pv2.items.map((i) => i.kind), ['race', 'meet', 'competition', 'game']);
  const race = await coach('POST', `/v1/clients/${maya.id}/games`, { date: '2026-11-14', time: '08:00', title: 'Cross country regional', kind: 'race' });
  assert.equal(race.status, 201, race.text); assert.deepEqual([race.body.kind_label, race.body.kind_word], ['Race', 'race']);
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/games`, { date: '2026-11-15', kind: 'marathon' })).status, 400);
  assert.equal((await coach('DELETE', `/v1/clients/${maya.id}/games/${race.body.id}`)).status, 200);
  // Front desk looks, never adds; a parent only reaches their own athlete.
  assert.equal((await desk('GET', `/v1/clients/${maya.id}/games`)).status, 200);
  assert.equal((await desk('POST', `/v1/clients/${maya.id}/games`, { date: '2026-11-07' })).status, 403);
  const other = (await coach('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Jo Park', email: 'jo@example.com' } })).body;
  assert.equal((await parent('GET', `/portal/api/athletes/${other.id}/games`)).status, 404);
  const rm = await parent('DELETE', `/portal/api/athletes/${maya.id}/games/${list[3].id}`);
  assert.equal(rm.status, 200); assert.equal(rm.body.deleted, true);
});

test('the owner changes the rules; coaches read them; the plan follows; the export carries the games', async () => {
  const r = (await coach('GET', '/v1/game-rules')).body;
  assert.equal(r.rules.length, 7); assert.equal(r.customized, false);
  assert.deepEqual(r.rules.map((d) => d.offset), [-3, -2, -1, 0, 1, 2, 3], 'in the order of the week');
  assert.deepEqual(r.rules.map((d) => d.tone), ['green', 'yellow', 'red', 'red', 'red', 'yellow', 'green']);
  assert.deepEqual(r.loads.map((l) => [l.key, l.tone]), [['light', 'red'], ['moderate', 'yellow'], ['heavy', 'green']]);
  assert.equal(r.rules.find((d) => d.key === '-1').allow, 'light');
  assert.equal((await coach('PATCH', '/v1/game-rules', { rules: { '-1': { allow: 'moderate' } } })).status, 403, 'owner only');
  assert.equal((await owner('PATCH', '/v1/game-rules', { rules: { '-9': { allow: 'moderate' } } })).status, 400);
  assert.equal((await owner('PATCH', '/v1/game-rules', { rules: { '2': { allow: 'brutal' } } })).status, 400);
  const saved = await owner('PATCH', '/v1/game-rules', { rules: { '2': { allow: 'heavy', advice: 'Two days after: lift as normal.' } } });
  assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.customized, true);
  const two = saved.body.rules.find((d) => d.key === '2');
  assert.deepEqual([two.allow, two.tone, two.advice, two.label], ['heavy', 'green', 'Two days after: lift as normal.', 'Two days after']);
  const plan = (await coach('GET', `/v1/clients/${maya.id}/game-plan`)).body;
  const d = plan.days.find((x) => x.date === '2026-10-19');
  assert.deepEqual([d.key, d.allow, d.tone, d.advice], ['2', 'heavy', 'green', 'Two days after: lift as normal.'], 'two days after the Hill Country game is green now');
  assert.equal((await athlete('GET', '/app/api/home')).body.games.by_date['2026-10-19'].tone, 'green', 'the app reads the owner\'s rules');
  const reset = await owner('PATCH', '/v1/game-rules', { reset: true });
  assert.equal(reset.body.customized, false); assert.equal(reset.body.rules.find((x) => x.key === '2').allow, 'moderate');
  const ex = (await owner('GET', `/v1/families/${maya.family.id}/export`)).body;
  const k = ex.athletes.find((a) => a.name === 'Maya Okafor');
  assert.deepEqual(k.games.map((g) => [g.date, g.title, g.source]), [['2026-10-10', 'vs Westlake', 'athlete'], ['2026-10-13', 'vs Reagan', 'parent'], ['2026-10-17', 'vs Hill Country', 'coach']]);
});

test('a version 81 database gains the games table', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v81-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v81.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 81');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 86, `round ${round}`);
      assert.ok(d.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'`));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
