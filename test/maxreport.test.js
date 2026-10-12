import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

// The max report (the builder redesign, step 4): athletes × lifts with totals and averages, estimates marked, CSV.
let app, base, owner, coach, desk, ava, ben;
const PW = 'correct-horse-battery';
const NOW = '2026-10-14T15:00:00Z';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body, raw = false) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: raw ? await r.text() : await r.json().catch(() => null), type: r.headers.get('content-type') };
  };
}
before(async () => {
  app = createApp({ testMode: true, jobs: false });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, NOW);
  const mk = async (name, email) => { const c = (await coach('POST', '/v1/clients', { name, parent: { name: `${name.split(' ')[1]} Parent`, email } })).body;
    app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), c.id, NOW, NOW, NOW, NOW); return c; };
  ava = await mk('Ava Lopez', 'maria@example.com'); ben = await mk('Ben Cole', 'cole@example.com');
  // Ava: typed squat and bench maxes; Ben: a squat max only, and logged bench sets that give an estimate.
  for (const [test, value] of [['squat_1rm', 275], ['bench_1rm', 155]]) assert.equal((await coach('POST', `/v1/clients/${ava.id}/maxes`, { test, value })).status, 201);
  assert.equal((await coach('POST', `/v1/clients/${ben.id}/maxes`, { test: 'squat_1rm', value: 315 })).status, 201);
  const bench = (await coach('POST', '/v1/exercises', { name: 'Bench press', category: 'Upper body' })).body;
  const p = (await coach('POST', '/v1/programs', { name: 'Push', weeks: 1 })).body;
  const w = (await coach('POST', `/v1/programs/${p.id}/workouts`, { week: 1, day: 1, title: 'Push' })).body;
  const slot = (await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: bench.id, sets: 3, reps: '5' })).body.exercises[0];
  await coach('POST', `/v1/programs/${p.id}/assign`, { client_id: ben.id, start_date: '2026-10-12', training_days: [1, 3] });
  const token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', ben.id).access_token;
  const log = await fetch(base + `/app/api/workouts/${w.id}/complete`, { method: 'POST', headers: { 'x-client-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ request_id: 'r1', sets: [{ workout_exercise_id: slot.id, set_no: 1, reps: 5, weight: 185 }] }) });
  assert.equal(log.status, 201, await log.text());
});
after(() => app.server.close());

test('athletes down, lifts across, estimates marked, totals and averages; a team or program filter; CSV; roles', async () => {
  const r = await coach('GET', '/v1/testing/max-report');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.lifts.map((l) => l.key), ['squat_1rm', 'bench_1rm', 'power_clean_1rm']);
  const row = (name) => r.body.athletes.find((a) => a.name === name);
  assert.deepEqual([row('Ava Lopez').maxes.squat_1rm.value, row('Ava Lopez').maxes.bench_1rm.value, row('Ava Lopez').maxes.power_clean_1rm, row('Ava Lopez').total, row('Ava Lopez').estimated], [275, 155, null, 430, false]);
  const benBench = row('Ben Cole').maxes.bench_1rm;
  assert.deepEqual([benBench.value, benBench.estimated, benBench.from.reps, row('Ben Cole').total, row('Ben Cole').estimated], [215, true, 5, 530, true], '185 × 5 estimates 215 (Epley, to 5 lb)');
  assert.deepEqual(r.body.averages, { squat_1rm: 295, bench_1rm: 185, power_clean_1rm: null });
  assert.equal(r.body.average_total, 480);
  // Without estimates, Ben's bench is empty.
  const noEst = (await coach('GET', '/v1/testing/max-report?estimates=false')).body;
  assert.equal(noEst.athletes.find((a) => a.name === 'Ben Cole').maxes.bench_1rm, null);
  // A program filter narrows to its athletes.
  const prog = app.ctx.db.get(`SELECT program_id FROM assignments WHERE client_id = ? AND active = 1`, ben.id).program_id;
  assert.deepEqual((await coach('GET', `/v1/testing/max-report?program_id=${prog}`)).body.athletes.map((a) => a.name), ['Ben Cole']);
  // CSV.
  const csv = await owner('GET', '/v1/testing/max-report.csv', null, true);
  assert.match(csv.type, /text\/csv/);
  const lines = csv.body.trim().split('\r\n');
  assert.equal(lines[0], '"Athlete","Athlete ID","Back squat (lb)","Bench press (lb)","Power clean (lb)","Total"');
  assert.match(lines[2], /"Ben Cole".*"315","215 \(est\.\)","","530"/);
  assert.match(lines.at(-1), /^"Average","","295","185","","480"$/);
  assert.equal((await desk('GET', '/v1/testing/max-report')).status, 403, 'front desk has no part');
  // The printable page is served; its script reads the same report.
  const page = await fetch(`${base}/maxes.html?program_id=${prog}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /maxes-print\.js/);
});
