import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

// The athlete's timeline (the builder redesign, step 5): everything they did, newest first, read from the tables that
// already hold it; the client page, the app's Profile tab and the parent portal read the same lines.
let app, base, owner, coach, desk, ava, token, parentCookie, day;
const PW = 'correct-horse-battery';
const NOW = '2026-10-14T15:00:00Z';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const parent = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { cookie: parentCookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
before(async () => {
  app = createApp({ testMode: true, jobs: false });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', ava.id).access_token;
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, NOW);
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), ava.id, NOW, NOW, NOW, NOW);
  // A typed max (Oct 1), a testing day not yet shared (Oct 5), a logged workout (Oct 12), a check-in (Oct 13), a badge, a purchase.
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/maxes`, { test: 'squat_1rm', value: 275, date: '2026-10-01' })).status, 201);
  day = (await coach('POST', '/v1/testing-sessions', { name: 'Fall combine', date: '2026-10-05', tests: ['dash_40yd'], athletes: [{ client_id: ava.id }] })).body;
  const res = await coach('POST', '/v1/results', { session_id: day.id, results: [{ athlete: { client_id: ava.id }, test: 'dash_40yd', metric: 'time', value: 4.95, attempt: 1, recorded_at: '2026-10-05T16:00:00Z' }, { athlete: { client_id: ava.id }, test: 'dash_40yd', metric: 'time', value: 4.82, attempt: 2, recorded_at: '2026-10-05T16:10:00Z' }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  const p = (await coach('POST', '/v1/programs', { name: 'Strength', weeks: 1 })).body;
  const w = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 1, title: 'Day 1 · Strength' })).body;
  const slot = (await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' })).body.exercises[0];
  await coach('POST', `/v1/programs/${p.id}/assign`, { client_id: ava.id, start_date: '2026-10-12', training_days: [1, 3] });
  app.ctx.now = () => '2026-10-12T17:00:00Z';
  const log = await athlete('POST', `/app/api/workouts/${w.id}/complete`, { request_id: 'r1', rpe: 7, started_at: '2026-10-12T16:10:00Z', sets: [1, 2, 3].map((n) => ({ workout_exercise_id: slot.id, set_no: n, reps: 5, weight: 185 })) });
  assert.equal(log.status, 201, JSON.stringify(log.body));
  app.ctx.now = () => '2026-10-13T12:00:00Z';
  assert.equal((await athlete('POST', '/app/api/daily-check-in', { sleep_hours: 8, energy: 4, soreness: 2, mood: 4, hydration: 3 })).status, 200);
  app.ctx.now = () => NOW;
  const badge = (await owner('POST', '/v1/skill-badges', { name: 'Clean hinge', category: 'Strength' })).body;
  assert.equal((await owner('POST', `/v1/skill-badges/${badge.id}/awards`, { client_ids: [ava.id], note: 'Nailed it' })).status, 200);
  app.ctx.db.run('INSERT INTO purchases (id, client_id, item_kind, item_id, title, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('pur'), ava.id, 'program', p.id, 'Strength', 4900, '2026-10-03T10:00:00Z');
  // The parent signs in to the portal.
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com' }) })).json()).dev_code;
  const ver = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com', code }) });
  parentCookie = ver.headers.get('set-cookie').split(';')[0];
});
after(() => app.server.close());

test('the client page: every kind newest first, the best attempt of a testing day, money for the owner only, filters and paging', async () => {
  const r = await coach('GET', `/v1/clients/${ava.id}/athlete-timeline`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.map((i) => i.kind), ['badge', 'checkin', 'workout', 'result', 'purchase', 'max']);
  assert.deepEqual(r.body.data.map((i) => i.text), ['Badge earned: Clean hinge', 'Checked in', 'Logged Day 1 · Strength', '40-yard dash: 4.82 s', 'Bought Strength', 'New max: back squat 275 lb']);
  const workout = r.body.data.find((i) => i.kind === 'workout');
  assert.equal(workout.detail, 'Strength · week 1, day 1 · 3 sets · 50 min · effort 7/10');
  assert.equal(r.body.data.find((i) => i.kind === 'result').detail, 'Testing day: Fall combine · best of 2');
  assert.equal(r.body.data.find((i) => i.kind === 'checkin').detail, '8 h sleep · energy 4/5 · soreness 2/5 · mood 4/5');
  assert.equal(r.body.data.find((i) => i.kind === 'purchase').detail, 'Program', 'a coach never sees the amount');
  assert.equal((await owner('GET', `/v1/clients/${ava.id}/athlete-timeline?kind=purchase`)).body.data[0].detail, 'Program · $49', 'the owner does');
  assert.equal((await desk('GET', `/v1/clients/${ava.id}/athlete-timeline`)).status, 200, 'front desk may look');
  assert.ok(r.body.kinds.some((k) => k.key === 'sprint' && k.label === 'Sprint reps'));
  // One kind; a bad kind is 400.
  assert.deepEqual((await coach('GET', `/v1/clients/${ava.id}/athlete-timeline?kind=max`)).body.data.map((i) => i.text), ['New max: back squat 275 lb']);
  assert.equal((await coach('GET', `/v1/clients/${ava.id}/athlete-timeline?kind=money`)).status, 400);
  // Paging: two at a time, then from the cursor.
  const first = (await coach('GET', `/v1/clients/${ava.id}/athlete-timeline?limit=2`)).body;
  assert.deepEqual(first.data.map((i) => i.kind), ['badge', 'checkin']);
  assert.equal(first.next, first.data[1].at);
  const second = (await coach('GET', `/v1/clients/${ava.id}/athlete-timeline?limit=2&before=${encodeURIComponent(first.next)}`)).body;
  assert.deepEqual(second.data.map((i) => i.kind), ['workout', 'result']);
  const last = (await coach('GET', `/v1/clients/${ava.id}/athlete-timeline?limit=10&before=${encodeURIComponent(second.next)}`)).body;
  assert.deepEqual(last.data.map((i) => i.kind), ['purchase', 'max']);
  assert.equal(last.next, null);
});

test('the app and the portal read the same lines, with testing-day results only once the day is shared', async () => {
  const mine = await athlete('GET', '/app/api/timeline');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.data.map((i) => i.kind), ['badge', 'checkin', 'workout', 'purchase', 'max'], 'the unshared combine is not there yet; the typed max is');
  assert.equal(mine.body.data.find((i) => i.kind === 'purchase').detail, 'Program');
  const theirs = await parent('GET', `/portal/api/athletes/${ava.id}/timeline`);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  assert.deepEqual(theirs.body.data.map((i) => i.text), mine.body.data.map((i) => i.text));
  const shared = await coach('POST', `/v1/testing-sessions/${day.id}/share`, {});
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.ok((await athlete('GET', '/app/api/timeline?kind=result')).body.data.some((i) => i.text === '40-yard dash: 4.82 s'), 'shared: the result shows');
  assert.ok((await parent('GET', `/portal/api/athletes/${ava.id}/timeline?kind=result`)).body.data.some((i) => i.text === '40-yard dash: 4.82 s'));
  // Another family's athlete is 404 to this parent.
  const other = (await coach('POST', '/v1/clients', { name: 'Ben Cole', parent: { name: 'Cole Parent', email: 'cole@example.com' } })).body;
  assert.equal((await parent('GET', `/portal/api/athletes/${other.id}/timeline`)).status, 404);
});
