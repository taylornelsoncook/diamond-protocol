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

// The month calendar and publish / unpublish (the builder redesign, step 3; schema 77: assignments.published_from).
let app, base, coach, desk, program, ava, ben;
const PW = 'correct-horse-battery';
const NOW = '2026-10-14T15:00:00Z';   // a Wednesday
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = (c) => async (method, path, body) => {
  const token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', c.id).access_token;
  const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
before(async () => {
  app = createApp({ testMode: true, jobs: false });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, NOW);
  const mk = async (name, email) => { const c = (await coach('POST', '/v1/clients', { name, parent: { name: `${name.split(' ')[1]} Parent`, email } })).body;
    app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), c.id, NOW, NOW, NOW, NOW); return c; };
  ava = await mk('Ava Lopez', 'maria@example.com'); ben = await mk('Ben Cole', 'cole@example.com');
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 2 })).body;
  for (const [wk, d, t] of [[1, 1, 'Lower'], [1, 2, 'Upper'], [2, 1, 'Lower 2']]) { const w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: wk, day: d, title: t })).body; await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' }); }
  // Both start Monday Oct 12, training Mon/Wed: day 1 Oct 12 (missed by the 14th unless logged), day 2 Oct 14 (today), week 2 day 1 Oct 19.
  for (const c of [ava, ben]) assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: c.id, start_date: '2026-10-12', training_days: [1, 3] })).status, 201);
});
after(() => app.server.close());

test('the month calendar: a card per workout per day with who has it, done, missed and effort', async () => {
  const w1 = (await coach('GET', `/v1/programs/${program.id}`)).body.workouts.find((w) => w.week === 1 && w.day === 1);
  // Ava logs day 1 with effort 7.
  const log = await athlete(ava)('POST', `/app/api/workouts/${w1.id}/complete`, { request_id: 'r1', rpe: 7, sets: [] });
  assert.equal(log.status, 201, JSON.stringify(log.body));
  const r = await coach('GET', `/v1/calendar?month=2026-10&program_id=${program.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.month, r.body.today, r.body.people], ['2026-10', '2026-10-14', 2]);
  const d12 = r.body.days.find((d) => d.date === '2026-10-12');
  assert.deepEqual(d12.workouts.map((w) => [w.title, w.week, w.day, w.athletes.length, w.done, w.missed, w.effort_avg]), [['Lower', 1, 1, 2, 1, 1, 7]]);
  assert.deepEqual(d12.workouts[0].athletes.map((a) => [a.name, a.status]).sort(), [['Ava Lopez', 'done'], ['Ben Cole', 'missed']]);
  const d14 = r.body.days.find((d) => d.date === '2026-10-14');
  assert.deepEqual([d14.workouts[0].title, d14.workouts[0].upcoming], ['Upper', 2], 'today counts as upcoming');
  assert.deepEqual(r.body.days.map((d) => d.date), ['2026-10-12', '2026-10-14', '2026-10-19']);
  // One athlete, a month with nothing, front desk may look.
  assert.equal((await coach('GET', `/v1/calendar?month=2026-10&client_id=${ben.id}`)).body.days[0].workouts[0].athletes.length, 1);
  assert.deepEqual((await coach('GET', `/v1/calendar?month=2026-12&program_id=${program.id}`)).body.days, []);
  assert.equal((await desk('GET', `/v1/calendar?month=2026-10`)).status, 200);
  assert.equal((await coach('GET', `/v1/calendar?month=bogus`)).body.month, '2026-10', 'a bad month means this month');
});

test('publish, release from a date and unpublish: the athlete sees nothing before the date, nothing counts as missed', async () => {
  // Ben's program is unpublished: his app says so, his day 1 is no longer missed, the calendar says unpublished.
  let r = await coach('POST', `/v1/programs/${program.id}/publish`, { published_from: 'unpublished', client_ids: [ben.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.state, r.body.athletes.map((a) => a.name)], ['unpublished', ['Ben Cole']]);
  let home = (await athlete(ben)('GET', '/app/api/home')).body;
  assert.equal(home.workout, null); assert.match(home.message, /opens when your coach releases it/);
  assert.deepEqual([home.calendar.published, home.calendar.counts.missed, home.calendar.counts.unpublished], [false, 0, 3]);
  let cal = (await coach('GET', `/v1/calendar?month=2026-10&program_id=${program.id}`)).body;
  assert.deepEqual(cal.assignments.map((a) => [a.name, a.state]).sort(), [['Ava Lopez', 'published'], ['Ben Cole', 'unpublished']]);
  assert.equal(cal.days.find((d) => d.date === '2026-10-12').workouts[0].unpublished, 1);
  // Released from a date ahead: still hidden today, with the date; from a date passed: open, and day 1 is missed again.
  r = await coach('POST', `/v1/programs/${program.id}/publish`, { published_from: '2026-10-20', client_ids: [ben.id] });
  assert.deepEqual([r.body.state, r.body.published_from], ['scheduled', '2026-10-20']);
  home = (await athlete(ben)('GET', '/app/api/home')).body;
  assert.match(home.message, /opens on 2026-10-20/);
  assert.equal((await coach('GET', `/v1/clients/${ben.id}/training-calendar`)).body.published_from, '2026-10-20');
  r = await coach('POST', `/v1/programs/${program.id}/publish`, { published_from: null });
  assert.deepEqual([r.body.state, r.body.athletes.length], ['published', 2]);
  home = (await athlete(ben)('GET', '/app/api/home')).body;
  assert.equal(home.workout.title, 'Upper'); assert.equal(home.calendar.counts.missed, 1);
  // Refused: a bad date, nobody matching, front desk.
  assert.equal((await coach('POST', `/v1/programs/${program.id}/publish`, { published_from: 'soon' })).status, 400);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/publish`, { published_from: null, client_ids: ['cli_nope'] })).status, 409);
  assert.equal((await desk('POST', `/v1/programs/${program.id}/publish`, { published_from: null })).status, 403);
});

test('a version 76 database gains published_from, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v76-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v76.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 76');
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('p1', 'Speed', 1, '2026-01-01T00:00:00Z');
      INSERT INTO clients (id, name, access_token, created_at) VALUES ('c1', 'Ava', 'tok', '2026-01-01T00:00:00Z');
      INSERT INTO assignments (id, client_id, program_id, start_date, active, created_at) VALUES ('a1', 'c1', 'p1', '2026-01-05', 1, '2026-01-01T00:00:00Z');`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 92, `round ${round}`);
      assert.deepEqual(d.get('SELECT start_date, published_from FROM assignments WHERE id = ?', 'a1'), { start_date: '2026-01-05', published_from: null });
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
