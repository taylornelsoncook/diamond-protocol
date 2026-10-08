// The adaptive plan (schema 69, services/adapt.js): one athlete's calendar bends around what they did. A whole week
// missed shifts the start date so it comes round again; three misses in a row make the rest of the week a minimum
// week (half the sets); two clean weeks in a program with phases offer the next phase early, skipping the rest of the
// current one. Suggested to the coach (or made at once in auto mode) and undoable. The clock is pinned.
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
import { runAdapt } from '../src/services/adapt.js';

let app, base, owner, coach, desk, squat, program;
const PW = 'correct-horse-battery';
// Monday 2026-10-19, 15:00 UTC (10 am Chicago).
const NOW = '2026-10-19T15:00:00.000Z';
const at = (date, h = '15:00') => `${date}T${h}:00.000Z`;
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const asAthlete = (token) => async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
async function member(name) {
  const c = (await coach('POST', '/v1/clients', { name, parent: { name: `Parent ${name}`, email: `${name.split(' ')[0].toLowerCase()}@example.com` } })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), c.id, NOW, NOW, NOW, NOW);
  const token = (await coach('GET', `/v1/clients/${c.id}`)).body.app_link.split('token=')[1];
  return { ...c, app: asAthlete(token) };
}
// Log a workout as done on a date (the way the screen or the app would).
function logOn(clientId, workoutId, date) {
  const a = app.ctx.db.get('SELECT id FROM assignments WHERE client_id = ? AND active = 1', clientId);
  app.ctx.db.run(`INSERT INTO workout_logs (id, client_id, workout_id, assignment_id, completed_at) VALUES (?, ?, ?, ?, ?)`, newId('wl'), clientId, workoutId, a.id, at(date, '23:00'));
}
const byDate = (cal) => Object.fromEntries(cal.workouts.map((w) => [`${w.week}.${w.day}`, [w.date, w.status]]));

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, NOW);
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  // Six weeks, three days a week (Mon, Wed, Fri), two phases: Base (weeks 1-5) and Build (week 6).
  program = (await coach('POST', '/v1/programs', { name: 'Fall block', weeks: 6 })).body;
  for (let wk = 1; wk <= 6; wk++) for (let d = 1; d <= 3; d++) {
    const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: wk, day: d, title: `W${wk} D${d}` })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 4, reps: '6' });
  }
  await coach('POST', `/v1/programs/${program.id}/phases`, { kind: 'base', name: 'Base', start_week: 1, end_week: 5 });
  await coach('POST', `/v1/programs/${program.id}/phases`, { kind: 'build', name: 'Build', start_week: 6, end_week: 6 });
});
after(() => app.server.close());

test('a whole week missed: the plan shifts forward so the week comes round again; dismissed waits a week; undo puts it back', async () => {
  const kai = await member('Kai Jensen');
  // Started two Mondays ago; week 1 all missed, week 2 (last week) all missed too. Today is the Monday of week 3.
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: kai.id, start_date: '2026-10-05', training_days: [1, 3, 5] });
  assert.equal((await desk('GET', '/v1/plan-adjustments')).status, 403, 'front desk has no part');
  const r = await coach('POST', `/v1/clients/${kai.id}/plan-adjustments/check`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const shift = r.body.data.find((x) => x.kind === 'shift');
  assert.deepEqual([shift?.status, shift?.detail.weeks, shift?.detail.new_start_date], ['suggested', 2, '2026-10-19']);
  assert.match(shift.text, /Move the plan 2 weeks forward/);
  assert.ok(!r.body.data.some((x) => x.kind === 'minimum'), 'a whole missed week is a shift, not a minimum week (six misses in a row, but the shift fixes them)');
  // Today shows it; checking again adds nothing while it is open.
  const item = (await owner('GET', '/v1/dashboard')).body.attention.find((x) => x.kind === 'plan_adjustments');
  assert.deepEqual([item.count, item.items[0].name, item.items[0].kind], [1, 'Kai Jensen', 'shift']);
  assert.equal((await coach('POST', `/v1/clients/${kai.id}/plan-adjustments/check`)).body.data.length, 0);
  // Approve: the start date moves, every missed workout is upcoming again, the app opens on W1 D1 today.
  const ok = await coach('POST', `/v1/plan-adjustments/${shift.id}/approve`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.status, ok.body.applied.start_date_before, ok.body.applied.start_date_after, ok.body.decided_by], ['approved', '2026-10-05', '2026-10-19', 'Riley']);
  const cal = (await coach('GET', `/v1/clients/${kai.id}/training-calendar`)).body;
  assert.deepEqual([cal.start_date, cal.counts.missed, cal.next.title, cal.next.status], ['2026-10-19', 0, 'W1 D1', 'today']);
  const home = (await kai.app('GET', '/app/api/home')).body;
  assert.equal(home.workout.title, 'W1 D1');
  assert.match(home.adjustments.recent[0].text, /moved 2 weeks forward/);
  assert.ok(app.ctx.db.get(`SELECT id FROM events WHERE type = 'plan.adjustment_applied'`));
  // Undo: back to the old start, the misses return.
  const undo = await coach('DELETE', `/v1/plan-adjustments/${shift.id}`);
  assert.equal(undo.body.status, 'undone');
  assert.deepEqual([(await coach('GET', `/v1/clients/${kai.id}/training-calendar`)).body.start_date, (await coach('GET', `/v1/clients/${kai.id}/training-calendar`)).body.counts.missed], ['2026-10-05', 6]);
  // Suggested again (the undo was a decision, but the picture is the same... after a week). Right away: nothing, it waits.
  assert.equal((await coach('POST', `/v1/clients/${kai.id}/plan-adjustments/check`)).body.data.length, 0, 'a decided shift waits a week');
});

test('three misses in a row: a minimum week halves the sets through Sunday; the app says so; next week the plan is back', async () => {
  const mia = await member('Mia Chen');
  // Started 2026-10-05; week 1 done; week 2: Monday done, Wednesday and Friday missed; week 3: Monday and Wednesday missed.
  // Today is Thursday 2026-10-22: four misses in a row, Friday still to come, and last week wasn't a whole missed week.
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: mia.id, start_date: '2026-10-05', training_days: [1, 3, 5] });
  const ws = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts;
  const w = (wk, d) => ws.find((x) => x.week === wk && x.day === d);
  for (const [wk, d, date] of [[1, 1, '2026-10-05'], [1, 2, '2026-10-07'], [1, 3, '2026-10-09'], [2, 1, '2026-10-12']]) logOn(mia.id, w(wk, d).id, date);
  app.ctx.now = () => '2026-10-22T15:00:00.000Z';
  try {
    const r = (await coach('POST', `/v1/clients/${mia.id}/plan-adjustments/check`)).body.data;
    assert.deepEqual(r.map((x) => x.kind), ['minimum'], JSON.stringify(r));
    const min = r[0];
    assert.deepEqual([min.detail.streak, min.detail.from, min.detail.until], [4, '2026-10-22', '2026-10-25']);
    assert.equal((await coach('POST', `/v1/plan-adjustments/${min.id}/approve`)).status, 200);
    const home = (await mia.app('GET', '/app/api/home')).body;
    assert.deepEqual([home.adjustments.minimum?.until, home.workout.title, home.workout.exercises[0].target_sets, home.workout.exercises[0].planned_sets, home.workout.exercises[0].minimum_week], ['2026-10-25', 'W2 D2', 2, 4, true], 'the app opens on the earliest missed workout, at half the sets');
    assert.equal((await coach('POST', `/v1/clients/${mia.id}/plan-adjustments/check`)).body.data.length, 0, 'a minimum week in force: nothing more');
    // Next Monday: the full plan again.
    app.ctx.now = () => '2026-10-26T15:00:00.000Z';
    const later = (await mia.app('GET', '/app/api/home')).body;
    assert.deepEqual([later.adjustments.minimum, later.workout.exercises[0].target_sets, later.workout.exercises[0].minimum_week], [null, 4, undefined]);
  } finally { app.ctx.now = () => NOW; }
  // The setting: owner only, 2 to 6.
  assert.equal((await coach('PATCH', '/v1/settings', { adapt_minimum_streak: 2 })).status, 403);
  assert.equal((await owner('PATCH', '/v1/settings', { adapt_minimum_streak: 9 })).status, 400);
  assert.equal((await owner('GET', '/v1/plan-adjustments')).body.settings.minimum_streak, 3);
});

test('two clean weeks in a program with phases: the next phase starts next week, the rest of this one is skipped, never missed; undo restores it; auto mode applies at once', async () => {
  // Started 2026-10-05 with weeks 1 and 2 done in full (6 workouts); today is Monday of week 3; Base runs through week 5, so two whole weeks of it are left after this one.
  const ws = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts;
  const w = (wk, d) => ws.find((x) => x.week === wk && x.day === d);
  const nia = await member('Nia Brooks');
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: nia.id, start_date: '2026-10-05', training_days: [1, 3, 5] });
  for (const [wk, d, date] of [[1, 1, '2026-10-05'], [1, 2, '2026-10-07'], [1, 3, '2026-10-09'], [2, 1, '2026-10-12'], [2, 2, '2026-10-14'], [2, 3, '2026-10-16']]) logOn(nia.id, w(wk, d).id, date);
  const r = (await coach('POST', `/v1/clients/${nia.id}/plan-adjustments/check`)).body.data;
  const adv = r.find((x) => x.kind === 'advance');
  assert.ok(adv, JSON.stringify(r));
  assert.deepEqual([adv.detail.phase, adv.detail.next_phase, adv.detail.from_week, adv.detail.through_week, adv.detail.weeks_skipped, adv.detail.workouts_skipped], ['Base', 'Build', 4, 5, 2, 6]);
  assert.match(adv.text, /Start Build next week: skip the last 2 weeks of Base \(6 workouts\)/);
  const ok = await coach('POST', `/v1/plan-adjustments/${adv.id}/approve`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.applied.start_date_after, ok.body.applied.skipped.length, ok.body.applied.pinned.length], ['2026-09-21', 6, 3], 'this week\'s three workouts keep their dates');
  const cal = (await coach('GET', `/v1/clients/${nia.id}/training-calendar`)).body;
  const d = byDate(cal);
  assert.deepEqual([d['3.1'], d['3.3'], d['4.1'][1], d['5.3'][1], d['6.1'], cal.counts.skipped, cal.counts.missed, cal.counts.total], [['2026-10-19', 'today'], ['2026-10-23', 'upcoming'], 'skipped', 'skipped', ['2026-10-26', 'upcoming'], 6, 0, 12], 'Build starts next Monday; the skipped weeks count neither missed nor planned');
  assert.equal((await nia.app('GET', '/app/api/home')).body.workout.title, 'W3 D1');
  assert.ok(!(await coach('POST', `/v1/clients/${nia.id}/plan-adjustments/check`)).body.data.length, 'decided for this phase');
  // Undo: skips gone, the pins gone, the start date back.
  await coach('DELETE', `/v1/plan-adjustments/${adv.id}`);
  const back = byDate((await coach('GET', `/v1/clients/${nia.id}/training-calendar`)).body);
  assert.deepEqual([back['3.1'], back['4.1'], back['6.1'][0]], [['2026-10-19', 'today'], ['2026-10-26', 'upcoming'], '2026-11-09']);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM assignment_skips').n, 0);
  // Auto mode: the hourly job applies at once; off: nothing.
  await owner('PATCH', '/v1/settings', { adapt_mode: 'auto' });
  const leo = await member('Leo Park');
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: leo.id, start_date: '2026-10-05', training_days: [1, 3, 5] });
  for (const [wk, dd, date] of [[1, 1, '2026-10-05'], [1, 2, '2026-10-07'], [1, 3, '2026-10-09'], [2, 1, '2026-10-12'], [2, 2, '2026-10-14'], [2, 3, '2026-10-16']]) logOn(leo.id, w(wk, dd).id, date);
  const job = runAdapt(app.ctx);
  assert.ok(job.applied >= 1, JSON.stringify(job));
  const leoCal = (await coach('GET', `/v1/clients/${leo.id}/training-calendar`)).body;
  assert.equal(leoCal.counts.skipped, 6);
  assert.equal((await coach('GET', `/v1/plan-adjustments?client_id=${leo.id}`)).body.data[0].decided_by, 'automatic');
  await owner('PATCH', '/v1/settings', { adapt_mode: 'off' });
  assert.deepEqual(runAdapt(app.ctx), { skipped: 'off' });
  await owner('PATCH', '/v1/settings', { adapt_mode: 'suggest' });
  // Export and deletion.
  const fam = (await coach('GET', `/v1/clients/${leo.id}`)).body.family;
  assert.equal((await owner('GET', `/v1/families/${fam.id}/export`)).body.athletes[0].plan_adjustments[0].kind, 'advance');
  assert.equal((await owner('DELETE', `/v1/families/${fam.id}`, { confirm: fam.name })).status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM plan_adjustments WHERE client_id = ?', leo.id).n, 0);
});

test('a version 68 database gains the adaptive plan tables', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-adapt-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v68.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 68');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 71, `round ${round}`);
      for (const t of ['plan_adjustments', 'assignment_skips']) assert.ok(d.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t), t);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
