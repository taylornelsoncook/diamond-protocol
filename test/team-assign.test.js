// Assign a program to a whole team at once (Relay plan step 5): every active roster athlete gets their own assignment
// and calendar with one start date and training days; those already on it or on another program are skipped and
// named (replace: true moves them); archived athletes are left out; all or nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';

let app, base, coach, owner, desk, team, program, other, ava, ben, cole, dan;
const PW = 'correct-horse-battery';
const NOW = '2026-10-07T15:00:00.000Z';
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); owner = await staff('owner@test.dev'); desk = await staff('desk@test.dev');
  const org = (await owner('POST', '/v1/organizations', { name: 'Lakeway HS', kind: 'school' })).body;
  team = (await owner('POST', '/v1/team-contracts', { org_id: org.id, name: 'Varsity Soccer', monthly_cents: 40000, start_date: '2026-09-01' })).body;
  // Four on the roster: created through the roster (team-only athletes), one later archived.
  const add = async (name) => (await owner('POST', `/v1/team-contracts/${team.id}/roster`, { name, grad_year: 2028 })).body.data.find((r) => r.name === name);   // the route answers the whole roster
  ava = await add('Ava Lopez'); ben = await add('Ben Ortiz'); cole = await add('Cole Park'); dan = await add('Dan Reyes');
  const ex = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 1 })).body;
  other = (await coach('POST', '/v1/programs', { name: 'Speed block', weeks: 1 })).body;
  for (const [prog, day, title] of [[program, 1, 'Lower'], [program, 2, 'Upper'], [program, 3, 'Speed'], [other, 1, 'Accel']]) {
    const w = (await coach('POST', `/v1/programs/${prog.id}/workouts`, { week: 1, day, title })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: ex.id, sets: 3, reps: '5' });
  }
  // Ben is already on Fall strength; Cole is on the speed block; Dan is archived.
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ben.client_id })).status, 201);
  assert.equal((await coach('POST', `/v1/programs/${other.id}/assign`, { client_id: cole.client_id })).status, 201);
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', NOW, dan.client_id);
});
after(() => app.server.close());

test('the whole team goes on the program with one calendar; the rest are skipped and named', async () => {
  const few = await coach('POST', `/v1/programs/${program.id}/assign-team`, { contract_id: team.id, start_date: '2026-10-05', training_days: [1, 3] });
  assert.equal(few.status, 400, 'a three-day program needs three training days, for a team too');
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign-team`, { contract_id: 'tc_nope' })).status, 404);
  assert.equal((await coach('POST', `/v1/programs/prg_nope/assign-team`, { contract_id: team.id })).status, 404);
  const r = await coach('POST', `/v1/programs/${program.id}/assign-team`, { contract_id: team.id, start_date: '2026-10-05', training_days: [1, 3, 5] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.team.name, r.body.start_date, r.body.training_days], ['Lakeway HS Varsity Soccer', '2026-10-05', [1, 3, 5]]);
  assert.deepEqual(r.body.assigned.map((a) => a.name), ['Ava Lopez']);
  assert.deepEqual(r.body.skipped.map((s) => [s.name, s.reason]), [['Ben Ortiz', 'already on it'], ['Cole Park', 'on Speed block']]);
  const cal = (await coach('GET', `/v1/clients/${ava.client_id}/training-calendar`)).body;
  assert.deepEqual([cal.program.name, cal.start_date, cal.training_days, cal.workouts.map((w) => w.date)], ['Fall strength', '2026-10-05', [1, 3, 5], ['2026-10-05', '2026-10-07', '2026-10-09']]);
  // Cole stays on the speed block until replace says otherwise.
  assert.equal((await coach('GET', `/v1/clients/${cole.client_id}/training-calendar`)).body.program.name, 'Speed block');
  const moved = await coach('POST', `/v1/programs/${program.id}/assign-team`, { contract_id: team.id, start_date: '2026-10-05', training_days: [1, 3, 5], replace: true });
  assert.equal(moved.status, 201);
  assert.deepEqual(moved.body.assigned.map((a) => [a.name, a.previous_program?.name]), [['Cole Park', 'Speed block']]);
  assert.deepEqual(moved.body.skipped.map((s) => s.reason), ['already on it', 'already on it']);
  // Archived Dan never came along; the program lists three clients.
  const p = (await coach('GET', `/v1/programs/${program.id}`)).body;
  assert.deepEqual(p.clients.map((c) => c.name).sort(), ['Ava Lopez', 'Ben Ortiz', 'Cole Park']);
  // Front desk can't; an empty roster is refused.
  assert.equal((await desk('POST', `/v1/programs/${program.id}/assign-team`, { contract_id: team.id })).status, 403);
  const empty = (await owner('POST', '/v1/team-contracts', { org_id: (await owner('GET', '/v1/organizations')).body.data[0].id, name: 'JV', monthly_cents: 1000, start_date: '2026-09-01' })).body;
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign-team`, { contract_id: empty.id })).status, 409);
});
