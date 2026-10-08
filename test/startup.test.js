// The start-up questions and the athlete's gear (schema 67, services/startup.js): an athlete answers goal, experience,
// days a week, where they train and the gear they have; the start-up rules put them on a program at once (auto), or a
// coach approves the match (review), or nothing fits and Today says so. Exercises that need gear the athlete lacks at
// home are swapped for the coach's listed alternatives that fit; the athlete can put the plan back.
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

let app, base, owner, coach, desk, speed, strength, template, squat, goblet, bench, pushup, sprint;
const PW = 'correct-horse-battery';
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const asAthlete = (token) => async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const mailTo = (email) => app.ctx.db.all('SELECT subject, body FROM outbox WHERE to_email = ? ORDER BY rowid', email);
// A member with a private link, so the app opens.
async function member(name) {
  const c = (await coach('POST', '/v1/clients', { name, parent: { name: `Parent of ${name}`, email: `${name.split(' ')[0].toLowerCase()}.parent@example.com` } })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), c.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  const token = (await coach('GET', `/v1/clients/${c.id}`)).body.app_link.split('token=')[1];
  return { ...c, app: asAthlete(token) };
}
async function programWith(name, days, items) {
  const p = (await coach('POST', '/v1/programs', { name, weeks: 2 })).body;
  for (let d = 1; d <= days; d++) {
    const w = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: d, title: `Day ${d}` })).body;
    for (const [ex, rx] of items) await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: ex.id, ...rx });
  }
  return p;
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', equipment: ['barbell'] })).body;
  goblet = (await coach('POST', '/v1/exercises', { name: 'Goblet squat', equipment: ['dumbbell'] })).body;
  bench = (await coach('POST', '/v1/exercises', { name: 'Bench press', equipment: ['barbell', 'bench'] })).body;
  pushup = (await coach('POST', '/v1/exercises', { name: 'Push-up', equipment: ['bodyweight'] })).body;
  sprint = (await coach('POST', '/v1/exercises', { name: 'Flying 20' })).body;
  await coach('POST', `/v1/exercises/${squat.id}/alternatives`, { exercise_id: goblet.id, tag: 'no_barbell' });
  await coach('POST', `/v1/exercises/${bench.id}/alternatives`, { exercise_id: pushup.id, tag: 'no_equipment' });
  speed = await programWith('Speed foundations', 3, [[sprint, { sets: 6, reps: '20 yd' }], [squat, { sets: 3, reps: '5' }]]);
  strength = await programWith('Strength block', 4, [[squat, { sets: 5, reps: '5' }], [bench, { sets: 4, reps: '8' }]]);
  template = (await coach('POST', `/v1/programs/${speed.id}/save-template`, { name: 'Speed template' })).body;
});
after(() => app.server.close());

test('rules: a coach writes them against the program\'s days, templates are refused, front desk looks only, Try it says where answers lead', async () => {
  const bad = await coach('POST', '/v1/program-rules', { program_id: strength.id, goals: ['strength'], days_min: 2 });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /4 training days a week/);
  assert.equal((await coach('POST', '/v1/program-rules', { program_id: template.id })).status, 409, 'a template is never assigned');
  assert.equal((await coach('POST', '/v1/program-rules', { program_id: speed.id, goals: ['sprinting'] })).status, 400, 'goals come from the list');
  const r1 = await coach('POST', '/v1/program-rules', { program_id: speed.id, name: 'New to speed', goals: ['speed', 'general'], experience: ['new', 'some'], days_max: 4 });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.deepEqual([r1.body.program_name, r1.body.goal_labels, r1.body.days_min, r1.body.days_max, r1.body.active, r1.body.placed], ['Speed foundations', ['Get faster', 'Stay in shape'], 3, 4, true, 0], 'days_min defaults to the program\'s days a week');
  const r2 = await coach('POST', '/v1/program-rules', { program_id: strength.id, name: 'Strength, 4 days', goals: ['strength', 'power'], equipment: ['barbell'], priority: 5 });
  assert.equal(r2.status, 201);
  assert.equal((await coach('POST', '/v1/program-rules', { program_id: strength.id, name: 'Anyone with 4 days', priority: -1 })).status, 201);
  const list = await desk('GET', '/v1/program-rules');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((r) => r.name), ['Strength, 4 days', 'New to speed', 'Anyone with 4 days'], 'priority first');
  assert.deepEqual([list.body.mode, list.body.questions.goals.length, list.body.questions.gear.some((g) => g.key === 'dumbbell')], ['auto', 6, true]);
  assert.equal((await desk('POST', '/v1/program-rules', { program_id: speed.id })).status, 403, 'front desk can\'t write rules');
  // Try it: the answers decide, the program's days must fit, gear needed at home is checked.
  const t = (b) => coach('POST', '/v1/program-rules/try', b).then((r) => r.body);
  assert.equal((await t({ goal: 'speed', experience: 'new', days_per_week: 3 })).program?.name, 'Speed foundations');
  assert.equal((await t({ goal: 'strength', experience: 'experienced', days_per_week: 4, trains_at: 'facility' })).program?.name, 'Strength block');
  assert.equal((await t({ goal: 'strength', experience: 'experienced', days_per_week: 4, trains_at: 'home', equipment: ['dumbbell'] })).program?.name, 'Strength block', 'no barbell at home: the barbell rule is out, the any-goal one still fits');
  assert.equal((await t({ goal: 'strength', experience: 'experienced', days_per_week: 2 })).rule, null, 'two days fit no program');
  assert.deepEqual((await t({ goal: 'return', experience: 'new', days_per_week: 3 })).reason, 'no_match');
  assert.equal((await t({ goal: 'speed' })).reason, 'unanswered');
  // Changing a rule, deleting one.
  const off = await coach('PATCH', `/v1/program-rules/${r1.body.id}`, { active: false });
  assert.equal(off.body.active, false);
  assert.equal((await t({ goal: 'speed', experience: 'new', days_per_week: 3 })).rule, null);
  assert.equal((await coach('PATCH', `/v1/program-rules/${r1.body.id}`, { active: true })).body.active, true);
});

test('an athlete answers in the app and starts the matching program at once, on their days; the owner is told; answering again keeps the program', async () => {
  const ava = await member('Ava Lopez');
  const home0 = (await ava.app('GET', '/app/api/home')).body;
  assert.deepEqual([home0.program, home0.startup.needed, home0.startup.profile], [null, true, null]);
  assert.match(home0.message, /Answer a few questions/);
  const q = (await ava.app('GET', '/app/api/startup')).body;
  assert.deepEqual([q.profile, q.questions.experience.map((x) => x.key)], [null, ['new', 'some', 'experienced']]);
  const bad = await ava.app('PUT', '/app/api/startup', { goal: 'speed', experience: 'new', days_per_week: 3, training_days: [1, 3] });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /2 training days but said 3/);
  const a = await ava.app('PUT', '/app/api/startup', { goal: 'speed', sport: 'Soccer', experience: 'new', days_per_week: 3, training_days: [1, 3, 5], trains_at: 'facility', note: 'Tryouts in March' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([a.body.placed.outcome, a.body.placed.program.name, a.body.placed.assignment.training_days, a.body.profile.outcome, a.body.profile.answered_by, a.body.profile.sport], ['assigned', 'Speed foundations', [1, 3, 5], 'assigned', 'athlete', 'Soccer']);
  const home = (await ava.app('GET', '/app/api/home')).body;
  assert.deepEqual([home.program.name, home.startup.needed, home.startup.profile.goal_label, home.workout?.title], ['Speed foundations', false, 'Get faster', 'Day 1']);
  assert.equal((await coach('GET', `/v1/clients/${ava.id}`)).body.sport, 'Soccer', 'the sport lands on the profile');
  const cal = (await coach('GET', `/v1/clients/${ava.id}/training-calendar`)).body;
  assert.deepEqual(cal.training_days, [1, 3, 5]);
  const mail = mailTo('owner@test.dev');
  assert.equal(mail.length, 1); assert.match(mail[0].subject, /Ava started Speed foundations on their own/); assert.match(mail[0].body, /Get faster · New to training · 3 days a week/);
  assert.equal(mailTo('coach@test.dev').length, 0, 'coaches see it on Today, not by email');
  assert.ok(app.ctx.db.get(`SELECT id FROM events WHERE type = 'program.auto_assigned'`), 'the event');
  assert.equal((await coach('GET', `/v1/program-rules`)).body.data.find((r) => r.name === 'New to speed').placed, 1);
  // Today: started on their own, until Got it.
  const dash = (await coach('GET', '/v1/dashboard')).body;
  const item = dash.attention.find((x) => x.kind === 'startups');
  assert.deepEqual([item.count, item.items[0].name, item.items[0].outcome, item.items[0].program_name], [1, 'Ava Lopez', 'assigned', 'Speed foundations']);
  assert.ok(!(await desk('GET', '/v1/dashboard')).body.attention.some((x) => x.kind === 'startups'), 'front desk has no part');
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/training-profile/seen`)).status, 200);
  assert.ok(!(await coach('GET', '/v1/dashboard')).body.attention.some((x) => x.kind === 'startups'));
  // Answering again (more gear) never moves them off their program.
  const again = await ava.app('PUT', '/app/api/startup', { trains_at: 'both', equipment: ['dumbbell', 'band'] });
  assert.deepEqual([again.body.placed.outcome, again.body.profile.equipment, again.body.profile.goal], ['coach', ['dumbbell', 'band'], 'speed'], 'fields left out keep their answer');
  assert.equal((await ava.app('GET', '/app/api/home')).body.program.name, 'Speed foundations');
  // The coach's view of it.
  const tp = (await desk('GET', `/v1/clients/${ava.id}/training-profile`)).body;
  assert.deepEqual([tp.profile.equipment_labels, tp.profile.trains_at_label, tp.match.rule?.name], [['Dumbbells', 'Bands'], 'Both', 'New to speed']);
  // In the family export.
  const fam = (await coach('GET', `/v1/clients/${ava.id}`)).body.family;
  const exp = (await owner('GET', `/v1/families/${fam.id}/export`)).body;
  assert.deepEqual([exp.athletes[0].training_profile.goal, exp.athletes[0].training_profile.equipment], ['speed', ['dumbbell', 'band']]);
});

test('no rule fits: the athlete hears their coach is choosing, Today says who needs a program, and a coach\'s assignment clears it', async () => {
  const kai = await member('Kai Jensen');
  const a = await kai.app('PUT', '/app/api/startup', { goal: 'return', experience: 'experienced', days_per_week: 2, trains_at: 'home', equipment: [] });
  assert.deepEqual([a.body.placed.outcome, a.body.placed.reason, a.body.profile.equipment], ['no_match', 'no_match', []], 'an empty gear list is bodyweight only, kept apart from no answer');
  const home = (await kai.app('GET', '/app/api/home')).body;
  assert.deepEqual([home.program, home.startup.needed], [null, false]); assert.match(home.message, /picking the right program/);
  assert.match(mailTo('owner@test.dev').at(-1).subject, /Kai needs a program/);
  const item = (await coach('GET', '/v1/dashboard')).body.attention.find((x) => x.kind === 'startups');
  assert.deepEqual([item.items[0].name, item.items[0].outcome, item.items[0].program_name], ['Kai Jensen', 'no_match', null]);
  assert.equal((await coach('POST', `/v1/clients/${kai.id}/training-profile/approve`)).status, 409, 'nothing to approve');
  assert.equal((await coach('POST', `/v1/programs/${speed.id}/assign`, { client_id: kai.id })).status, 201);
  assert.ok(!(await coach('GET', '/v1/dashboard')).body.attention.some((x) => x.kind === 'startups' && x.items.some((i) => i.name === 'Kai Jensen')), 'on a program now: off the list');
});

test('review mode: the match waits for a coach, who approves it from Today; off: nothing is placed; a coach answers for an athlete and places them', async () => {
  assert.equal((await coach('PATCH', '/v1/settings', { auto_program: 'review' })).status, 403, 'the setting is the owner\'s');
  assert.equal((await owner('PATCH', '/v1/settings', { auto_program: 'review' })).status, 200);
  const mia = await member('Mia Chen');
  const a = await mia.app('PUT', '/app/api/startup', { goal: 'general', experience: 'some', days_per_week: 4, trains_at: 'facility' });
  assert.deepEqual([a.body.placed.outcome, a.body.placed.program.name], ['suggested', 'Speed foundations']);
  assert.equal((await mia.app('GET', '/app/api/home')).body.program, null);
  const item = (await owner('GET', '/v1/dashboard')).body.attention.find((x) => x.kind === 'startups');
  assert.deepEqual([item.items[0].outcome, item.items[0].program_name], ['suggested', 'Speed foundations']);
  const ok = await coach('POST', `/v1/clients/${mia.id}/training-profile/approve`);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.outcome, ok.body.assignment.training_days], ['assigned', [1, 2, 4, 5]], 'four days, the usual spread');
  assert.equal((await mia.app('GET', '/app/api/home')).body.program.name, 'Speed foundations');
  assert.equal((await coach('POST', `/v1/clients/${mia.id}/training-profile/approve`)).status, 409, 'already on it');
  // Off: the answers are kept, nobody is placed.
  await owner('PATCH', '/v1/settings', { auto_program: 'off' });
  const leo = await member('Leo Park');
  assert.equal((await leo.app('PUT', '/app/api/startup', { goal: 'speed', experience: 'new', days_per_week: 3 })).body.placed.outcome, 'coach');
  assert.equal((await leo.app('GET', '/app/api/home')).body.program, null);
  await owner('PATCH', '/v1/settings', { auto_program: 'auto' });
  // A coach fills the answers in on the client page: nothing moves unless place: true.
  assert.equal((await desk('PUT', `/v1/clients/${leo.id}/training-profile`, { goal: 'strength' })).status, 403);
  const c1 = await coach('PUT', `/v1/clients/${leo.id}/training-profile`, { goal: 'strength', experience: 'experienced', days_per_week: 4 });
  assert.deepEqual([c1.status, c1.body.placed, c1.body.profile.answered_by], [200, null, 'coach']);
  const c2 = await coach('PUT', `/v1/clients/${leo.id}/training-profile`, { place: true });
  assert.deepEqual([c2.body.placed.outcome, c2.body.placed.program.name], ['assigned', 'Strength block']);
  assert.equal((await coach('GET', `/v1/clients/${leo.id}`)).body.program.name, 'Strength block');
});

test('the gear: exercises needing what the athlete lacks at home are swapped for alternatives that fit; the athlete can put the plan back, a coach\'s swap stays', async () => {
  const zoe = await member('Zoe Adams');
  const a = await zoe.app('PUT', '/app/api/startup', { goal: 'strength', experience: 'experienced', days_per_week: 4, trains_at: 'home', equipment: ['dumbbell'] });
  assert.equal(a.body.placed.program.name, 'Strength block', JSON.stringify(a.body.placed));
  const home = (await zoe.app('GET', '/app/api/home')).body;
  const sq = home.workout.exercises.find((x) => x.swapped?.from === 'Back squat'), bp = home.workout.exercises.find((x) => x.swapped?.from === 'Bench press');
  assert.deepEqual([sq.name, sq.swapped.by_kind, sq.swapped.reason, sq.load, bp.name, bp.swapped.reason], ['Goblet squat', 'equipment', 'No barbell at home', null, 'Push-up', 'No barbell or bench at home']);
  assert.deepEqual(home.startup.gear, { trains_at: 'home', equipment: ['dumbbell'], labels: ['Dumbbells'] });
  const swaps = (await coach('GET', `/v1/clients/${zoe.id}/swaps`)).body.data;
  assert.deepEqual(swaps.map((s) => [s.exercise_name, s.by_kind]).sort(), [['Goblet squat', 'equipment'], ['Push-up', 'equipment']], 'the coach sees them like any swap');
  // Put the squat back: the slot is remembered, so the next read doesn't swap it again.
  const undo = await zoe.app('DELETE', `/app/api/swaps/${sq.swapped.id}`); assert.equal(undo.status, 200, JSON.stringify(undo.body));
  const home2 = (await zoe.app('GET', '/app/api/home')).body;
  assert.deepEqual(home2.workout.exercises.map((x) => x.name), ['Back squat', 'Push-up']);
  // A coach's swap on a slot is never touched.
  const day2 = (await coach('GET', `/v1/programs/${strength.id}`)).body.workouts.find((w) => w.day === 2);
  const slot = day2.exercises.find((x) => x.name === 'Back squat');
  assert.equal((await coach('POST', `/v1/clients/${zoe.id}/swaps`, { workout_exercise_id: slot.id, exercise_id: sprint.id, reason: 'Knee' })).status, 201);
  const open2 = (await zoe.app('GET', `/app/api/workouts/${day2.id}`)).body;
  assert.deepEqual(open2.exercises.map((x) => [x.name, x.swapped?.by_kind]), [['Flying 20', 'coach'], ['Push-up', 'equipment']]);
  // Training both places: the swaps apply only when the app says they're at home today.
  await zoe.app('PUT', '/app/api/startup', { trains_at: 'both' });
  const day3 = (await coach('GET', `/v1/programs/${strength.id}`)).body.workouts.find((w) => w.day === 3);
  assert.deepEqual((await zoe.app('GET', `/app/api/workouts/${day3.id}`)).body.exercises.map((x) => x.name), ['Back squat', 'Bench press']);
  assert.deepEqual((await zoe.app('GET', `/app/api/workouts/${day3.id}?at=home`)).body.exercises.map((x) => x.name), ['Goblet squat', 'Push-up']);
  // Everything in the gear list: nothing swapped.
  const ray = await member('Ray Diaz');
  await ray.app('PUT', '/app/api/startup', { goal: 'strength', experience: 'experienced', days_per_week: 4, trains_at: 'home', equipment: ['barbell', 'bench', 'dumbbell'] });
  assert.ok((await ray.app('GET', '/app/api/home')).body.workout.exercises.every((x) => !x.swapped));
  // Deleting the family removes the answers and the memory.
  const fam = (await coach('GET', `/v1/clients/${zoe.id}`)).body.family;
  assert.equal((await owner('DELETE', `/v1/families/${fam.id}`, { confirm: fam.name })).status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM training_profiles WHERE client_id = ?', zoe.id).n, 0);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM swap_optouts WHERE client_id = ?', zoe.id).n, 0);
});

test('a version 66 database gains the start-up tables and the equipment swap kind', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-startup-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v66.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 66');
    old.exec(`INSERT INTO clients (id, name, access_token, created_at) VALUES ('cli_1', 'Ava Lopez', 'tok1', '2026-01-01T00:00:00.000Z')`);
    old.exec(`INSERT INTO exercises (id, name, created_at) VALUES ('ex_1', 'Back squat', '2026-01-01T00:00:00.000Z'), ('ex_2', 'Goblet squat', '2026-01-01T00:00:00.000Z')`);
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_1', 'Strength', 1, '2026-01-01T00:00:00.000Z')`);
    old.exec(`INSERT INTO workouts (id, program_id, week, day, title) VALUES ('wo_1', 'prog_1', 1, 1, 'Day 1')`);
    old.exec(`INSERT INTO workout_exercises (id, workout_id, exercise_id, prescription, position) VALUES ('we_1', 'wo_1', 'ex_1', '3 × 5', 1)`);
    old.exec(`INSERT INTO exercise_swaps (id, client_id, workout_exercise_id, exercise_id, reason, created_by, created_at, by_kind) VALUES ('swap_1', 'cli_1', 'we_1', 'ex_2', 'Knee', 'Riley', '2026-02-01T00:00:00.000Z', 'athlete')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 68, `round ${round}`);
      if (round === 1) assert.deepEqual(d.get('SELECT by_kind, reason FROM exercise_swaps WHERE id = ?', 'swap_1'), { by_kind: 'athlete', reason: 'Knee' }, 'the swap survives the rebuild');
      d.run(`INSERT INTO exercise_swaps (id, client_id, workout_exercise_id, exercise_id, reason, created_at, by_kind) VALUES (?, 'cli_1', 'we_1', 'ex_2', 'No barbell at home', ?, 'equipment') ON CONFLICT (client_id, workout_exercise_id) DO UPDATE SET by_kind = excluded.by_kind`, `swap_${round}`, '2026-03-01T00:00:00.000Z');
      assert.equal(d.get('SELECT by_kind FROM exercise_swaps WHERE workout_exercise_id = ?', 'we_1').by_kind, 'equipment');
      for (const t of ['training_profiles', 'program_rules', 'swap_optouts']) assert.ok(d.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t), t);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
