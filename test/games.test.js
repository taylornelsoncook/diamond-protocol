// The game-week helper (schema 82, services/gameweek.js): athletes, parents and coaches keep the athlete's games;
// every day knows where it sits against them and carries the advice; workouts heavier than their day allows get a
// suggestion to move (one tap, only to the date suggested); schedules come in from .ics, CSV or pasted lines; the
// owner alone changes the rules; games are in the family export; the version 81 database gains the table.
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
import { dayInfo, loadOf, parseIcs, parseCsv, readDate, DEFAULT_RULES } from '../src/services/gameweek.js';

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
  const clear = dayInfo('2026-10-20', ['2026-10-10'], r);
  assert.deepEqual([clear.offset, clear.allow, clear.advice, clear.after], [null, 'heavy', null, 10]);
  // Between two games (Saturday and Tuesday): the Monday is two days after one and the day before the other: the stricter wins, the other is mentioned.
  const between = dayInfo('2026-10-12', ['2026-10-10', '2026-10-13'], r);
  assert.deepEqual([between.key, between.allow], ['-1', 'light']);
  assert.match(between.advice, /You also played 2 days ago\.$/);
  assert.equal(dayInfo('2026-10-12', ['2026-10-10', '2026-10-13'], { ...r, '-1': { ...r['-1'], allow: 'heavy' } }).key, '2', 'the owner\'s rules decide which is stricter');
});

test('how heavy a workout is, read from its exercises and its title', () => {
  const load = (title, exercises, m) => loadOf({ title, exercises }, m);
  assert.deepEqual(load('Lower body', [{ name: 'Back squat', category: 'Lower body', sets: 4, reps: '4', load_pct: 85 }]), { load: 'heavy', legs: true, why: 'Back squat at 85% of max' });
  assert.equal(load('Upper body', [{ name: 'Bench press', category: 'Upper body', sets: 3, reps: '8', target_rpe: 7 }]).load, 'moderate');
  assert.equal(load('Upper body', [{ name: 'Bench press', category: 'Upper body', sets: 3, reps: '3', load_pct: 90 }]).load, 'moderate', 'an upper-body lift never counts as heavy legs, and tops out at moderate');
  assert.deepEqual(load('Mobility', [{ name: 'Hip circles', category: 'Mobility', sets: 2, reps: '10' }]), { load: 'light', legs: false, why: 'a recovery day by its name' });
  assert.equal(load('Day 3', [{ name: 'Hip circles', category: 'Mobility', sets: 2, reps: '10' }]).load, 'light');
  assert.equal(load('Day 1', [{ name: 'Trap bar deadlift', category: null, sets: 4, reps: '5' }], () => 'hinge').load, 'moderate', 'a leg lift at low reps is a working session');
  assert.equal(load('Max day', [{ name: 'Hip circles', category: 'Mobility', sets: 1, reps: '10' }]).load, 'heavy', 'the title says so');
  assert.equal(load('Circuit', Array.from({ length: 6 }, (_, i) => ({ name: `Move ${i}`, category: 'Core', sets: 3, reps: '12' }))).load, 'moderate', 'a lot of sets');
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

test('the athlete adds a game, reads the plan, and takes the suggestion to move a heavy session off the day after', async () => {
  let home = (await athlete('GET', '/app/api/home')).body;
  assert.equal(home.games.games_on_file, 0);
  const add = await athlete('POST', '/app/api/games', { date: '2026-10-10', time: '14:00', title: 'vs Westlake' });
  assert.equal(add.status, 201, add.text); assert.equal(add.body.source, 'athlete'); assert.equal(add.body.created_by, 'Maya Okafor');
  assert.equal((await athlete('POST', '/app/api/games', { date: '2026-10-10', title: 'VS WESTLAKE' })).status, 409, 'the same game twice');
  assert.equal((await athlete('POST', '/app/api/games', { date: '2026-10-10', time: '25:00' })).status, 400);
  const plan = (await athlete('GET', '/app/api/games')).body;
  assert.equal(plan.next_game.title, 'vs Westlake');
  assert.deepEqual([plan.now.offset, plan.now.label, plan.now.allow], [-3, 'Three days out', 'heavy'], 'Wednesday is three days out from Saturday');
  const byDate = Object.fromEntries(plan.days.map((d) => [d.date, d]));
  assert.deepEqual(byDate['2026-10-07'].workouts.map((w) => [w.title, w.load, w.fits]), [['Upper body', 'moderate', true]]);
  assert.deepEqual([byDate['2026-10-09'].allow, byDate['2026-10-09'].workouts[0].load, byDate['2026-10-09'].conflict], ['light', 'light', false], 'mobility the day before fits');
  assert.deepEqual([byDate['2026-10-12'].label, byDate['2026-10-12'].allow, byDate['2026-10-12'].conflict], ['Two days after', 'moderate', true], 'heavy legs two days after the game don\'t');
  assert.equal(plan.suggestions.length, 1);
  const s = plan.suggestions[0];
  assert.deepEqual([s.title, s.date, s.load, s.legs, s.kind, s.to_date], ['Lower body', '2026-10-12', 'heavy', true, 'move', '2026-10-13']);
  assert.match(s.text, /heavy legs \(Back squat at 85% of max\) and it lands 2 days after your game\. Move it to 2026-10-13/);
  home = (await athlete('GET', '/app/api/home')).body;
  assert.deepEqual([home.games.days_to_next, home.games.game_dates, home.games.suggestions.length], [3, ['2026-10-10'], 1]);
  assert.equal(home.games.by_date['2026-10-10'].game.title, 'vs Westlake');
  // Only the suggested move is open to the athlete.
  assert.equal((await athlete('POST', '/app/api/games/moves', { workout_id: s.workout_id, date: '2026-10-20' })).status, 400, 'not a date the plan suggested');
  const moved = await athlete('POST', '/app/api/games/moves', { workout_id: s.workout_id, date: s.to_date });
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual(moved.body.moved, { workout_id: s.workout_id, title: 'Lower body', from: '2026-10-12', to: '2026-10-13' });
  assert.equal(moved.body.plan.suggestions.length, 0, 'nothing left to move');
  assert.equal(app.ctx.db.get('SELECT moved_by FROM assignment_moves WHERE workout_id = ?', s.workout_id).moved_by, 'Maya Okafor');
  const cal = (await coach('GET', `/v1/clients/${maya.id}/training-calendar`)).body;
  assert.equal(cal.workouts.find((w) => w.id === s.workout_id).date, '2026-10-13');
  assert.equal((await athlete('POST', '/app/api/games/moves', { workout_id: s.workout_id, date: s.to_date })).status, 400, 'gone once taken');
});

test('a second game close by: the stricter day wins, and a workout with no free day nearby is kept but lightened', async () => {
  const add = await parent('POST', `/portal/api/athletes/${maya.id}/games`, { date: '2026-10-13', title: 'vs Reagan', kind: 'scrimmage' });
  assert.equal(add.status, 201, add.text); assert.equal(add.body.source, 'parent');
  const plan = (await parent('GET', `/portal/api/athletes/${maya.id}/games`)).body;
  const byDate = Object.fromEntries(plan.days.map((d) => [d.date, d]));
  assert.deepEqual([byDate['2026-10-12'].key, byDate['2026-10-12'].allow], ['-1', 'light']);
  assert.equal(byDate['2026-10-13'].offset, 0, 'the moved Lower body now sits on a game day');
  const s = plan.suggestions.find((x) => x.title === 'Lower body');
  assert.ok(s, 'the heavy session is flagged again');
  assert.deepEqual([s.kind, s.to_date], ['lighten', null], 'every day within three is a game day, the day before or after one, or already has a workout');
  assert.match(s.text, /lands on game day, with no free day nearby to move it to\. Do it, but keep it light/);
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
  assert.equal(r.rules.find((d) => d.key === '-1').allow, 'light');
  assert.equal((await coach('PATCH', '/v1/game-rules', { rules: { '-1': { allow: 'moderate' } } })).status, 403, 'owner only');
  assert.equal((await owner('PATCH', '/v1/game-rules', { rules: { '-9': { allow: 'moderate' } } })).status, 400);
  assert.equal((await owner('PATCH', '/v1/game-rules', { rules: { '2': { allow: 'brutal' } } })).status, 400);
  const saved = await owner('PATCH', '/v1/game-rules', { rules: { '2': { allow: 'heavy', advice: 'Two days after: lift as normal.' } } });
  assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.customized, true);
  const two = saved.body.rules.find((d) => d.key === '2');
  assert.deepEqual([two.allow, two.advice, two.label], ['heavy', 'Two days after: lift as normal.', 'Two days after']);
  const plan = (await coach('GET', `/v1/clients/${maya.id}/game-plan`)).body;
  const d = plan.days.find((x) => x.date === '2026-10-19');
  assert.deepEqual([d.key, d.allow, d.advice], ['2', 'heavy', 'Two days after: lift as normal.'], 'two days after the Hill Country game now allows anything');
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
      assert.equal(d.get('PRAGMA user_version').user_version, 82, `round ${round}`);
      assert.ok(d.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'`));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
