// Templates (schema 63, Relay plan step 6): save a program as a template (a copy with its weeks, workouts and phases)
// and start a new program from it; save a workout as a template and start a day from it. Templates are never assigned
// or sold, stay out of the programs list, and a version 62 database gains the kind column.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';

let app, base, coach, owner, desk, maya, program, lower, squat, bench;
const PW = 'correct-horse-battery';
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
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); owner = await staff('owner@test.dev'); desk = await staff('desk@test.dev');
  maya = (await coach('POST', '/v1/clients', { name: 'Maya Okafor', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body; bench = (await coach('POST', '/v1/exercises', { name: 'Bench press' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength', weeks: 2, level: 'Beginner' })).body;
  lower = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
  await coach('POST', `/v1/workouts/${lower.id}/exercises`, { exercise_id: squat.id, sets: 4, reps: '6', tempo: '3-1-1', rest_seconds: 120, group_label: 'A', group_kind: 'superset', form_check: true, form_check_note: 'Side view' });
  await coach('POST', `/v1/workouts/${lower.id}/exercises`, { exercise_id: bench.id, sets: 4, reps: '8', group_label: 'A' });
  const warm = (await coach('POST', '/v1/routines', { name: 'Hips', kind: 'warmup', exercises: [{ exercise_id: squat.id, prescription: '2 × 10 bodyweight' }] })).body;
  assert.equal((await coach('PATCH', `/v1/workouts/${lower.id}`, { warmup_id: warm.id })).status, 200);
  await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 2, day: 1, title: 'Lower B' });
  assert.equal((await coach('POST', `/v1/programs/${program.id}/phases`, { kind: 'base', start_week: 1, end_week: 2 })).status, 201);
});
after(() => app.server.close());

test('a program becomes a template and a new program starts from it; templates stay out of the list and are never assigned or sold', async () => {
  const t = await coach('POST', `/v1/programs/${program.id}/save-template`, { name: 'Fall strength template' });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.deepEqual([t.body.kind, t.body.name, t.body.weeks, t.body.level, t.body.workouts.length], ['template', 'Fall strength template', 2, 'Beginner', 2]);
  const tl = t.body.workouts.find((w) => w.title === 'Lower');
  assert.deepEqual([tl.exercises.length, tl.exercises[0].tempo, tl.exercises[0].group_tag, tl.exercises[0].form_check, tl.warmup?.name], [2, '3-1-1', 'A1', 1, 'Hips'], 'every field, group and block comes along');
  assert.equal((await coach('GET', `/v1/programs/${t.body.id}/plan`)).body.phases.length, 1, 'phases too');
  // Lists: programs by default, templates on request.
  assert.deepEqual((await coach('GET', '/v1/programs')).body.data.map((p) => p.name), ['Fall strength']);
  assert.deepEqual((await desk('GET', '/v1/programs?kind=template')).body.data.map((p) => p.name), ['Fall strength template']);
  assert.equal((await coach('GET', '/v1/programs?kind=workouts')).status, 400);
  // Never assigned, never sold, never on a team.
  const asg = await coach('POST', `/v1/programs/${t.body.id}/assign`, { client_id: maya.id });
  assert.equal(asg.status, 409); assert.match(asg.body.error.message, /is a template/);
  assert.equal((await owner('PUT', `/v1/shop/programs/${t.body.id}`, { for_sale: true, price_cents: 4900 })).status, 409);
  // A new program from the template: workouts and phases copied, kind program.
  const np = await coach('POST', '/v1/programs', { name: 'Winter strength', copy_from: t.body.id });
  assert.equal(np.status, 201);
  assert.deepEqual([np.body.kind, np.body.weeks, np.body.workouts.length, np.body.workouts.find((w) => w.title === 'Lower').exercises[1].group_tag], ['program', 2, 2, 'A2']);
  assert.equal((await coach('POST', `/v1/programs/${np.body.id}/assign`, { client_id: maya.id })).status, 201, 'the program made from it is assignable');
  // Changing the template later doesn't touch the program, and the other way round.
  await coach('PATCH', `/v1/programs/${t.body.id}`, { name: 'Fall template v2' });
  assert.equal((await coach('GET', `/v1/programs/${np.body.id}`)).body.name, 'Winter strength');
  // Deleting a template is an ordinary delete; the new program stays.
  assert.equal((await coach('DELETE', `/v1/programs/${t.body.id}`)).status, 200);
  assert.equal((await coach('GET', `/v1/programs/${np.body.id}`)).status, 200);
});

test('a workout becomes a template and a day starts from it', async () => {
  assert.deepEqual((await coach('GET', '/v1/workout-templates')).body.data, []);
  const t = await coach('POST', `/v1/workouts/${lower.id}/save-template`, { name: 'Heavy lower day' });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.deepEqual([t.body.name, t.body.exercises, t.body.exercise_names, t.body.warmup], ['Heavy lower day', 2, ['Back squat', 'Bench press'], 'Hips']);
  const t2 = (await coach('POST', `/v1/workouts/${lower.id}/save-template`, {})).body;
  assert.equal(t2.name, 'Lower', 'the title is the default name');
  const list = (await desk('GET', '/v1/workout-templates')).body.data;
  assert.deepEqual(list.map((x) => x.name), ['Heavy lower day', 'Lower']);
  // The holder never shows as a program and can't be deleted.
  assert.deepEqual((await coach('GET', '/v1/programs')).body.data.map((p) => p.name).sort(), ['Fall strength', 'Winter strength']);
  const holder = app.ctx.db.get(`SELECT id FROM programs WHERE kind = 'workouts'`);
  assert.equal((await coach('DELETE', `/v1/programs/${holder.id}`)).status, 409);
  // A day from the template, in the program.
  const day = await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 2, day: 2, template_id: t.body.id });
  assert.equal(day.status, 201, JSON.stringify(day.body));
  assert.deepEqual([day.body.title, day.body.week, day.body.day, day.body.exercises.length, day.body.exercises[0].rest_seconds, day.body.exercises[0].group_tag, day.body.warmup?.name], ['Heavy lower day', 2, 2, 2, 120, 'A1', 'Hips']);
  const named = await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 2, title: 'Lower C', template_id: t.body.id });
  assert.deepEqual([named.body.title, named.body.day], ['Lower C', 3], 'a title of its own, the next free day');
  assert.equal((await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, template_id: 'wo_nope' })).status, 404);
  assert.equal((await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, template_id: lower.id })).status, 404, 'an ordinary workout isn\'t a template');
  // Front desk looks only.
  assert.equal((await desk('POST', `/v1/workouts/${lower.id}/save-template`, {})).status, 403);
  assert.equal((await desk('DELETE', `/v1/workout-templates/${t2.id}`)).status, 403);
  assert.equal((await coach('DELETE', `/v1/workout-templates/${t2.id}`)).status, 200);
  assert.equal((await coach('DELETE', `/v1/workout-templates/${lower.id}`)).status, 404);
  assert.deepEqual((await coach('GET', '/v1/workout-templates')).body.data.map((x) => x.name), ['Heavy lower day']);
});

test('a version 62 database gains the kind column with every program a program, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v62.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 62');
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prg_1', 'Old program', 4, '2026-01-01T00:00:00Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 64, `round ${round}`);
      assert.equal(d.get('SELECT kind FROM programs WHERE id = ?', 'prg_1').kind, 'program');
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
