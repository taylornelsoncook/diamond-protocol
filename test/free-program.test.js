import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';

// A program given free (schema 94, owner's ask: "add a workout for free to a person's account"): a purchases row with
// nothing charged and granted_by, so the athlete app opens for that program without a membership. Given with the
// assignment (free: true) or from the client page; taken back closes the app again; never a sale.
let app, base, owner, coach, desk, ava, program, w;
const PW = 'correct-horse-battery';
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
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley Brooks', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Off-season', weeks: 1 })).body;
  w = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Day 1' })).body;
  await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, prescription: '3 × 5' });
});
after(() => app.server.close());

test('without a membership the app is closed; given free with the assignment it opens; taken back it closes again', async () => {
  // Assigned the usual way: no membership, so the app is locked.
  assert.equal((await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id })).status, 201);
  let home = (await athlete(ava)('GET', '/app/api/home')).body;
  assert.equal(home.locked, true, 'no membership: locked');
  assert.deepEqual((await coach('GET', `/v1/clients/${ava.id}`)).body.free_programs, []);
  // The client page's Give it free.
  const given = await coach('POST', `/v1/clients/${ava.id}/free-programs`, { program_id: program.id });
  assert.equal(given.status, 201, JSON.stringify(given.body));
  assert.deepEqual([given.body.free, given.body.granted_by, given.body.program_name, given.body.status], [true, 'Riley Brooks', 'Off-season', 'active']);
  home = (await athlete(ava)('GET', '/app/api/home')).body;
  assert.equal(home.locked, false, 'given free: open'); assert.equal(home.workout?.title, 'Day 1');
  const c = (await coach('GET', `/v1/clients/${ava.id}`)).body;
  assert.deepEqual(c.free_programs.map((f) => [f.program_id, f.granted_by]), [[program.id, 'Riley Brooks']]);
  // Twice is 409; the store never charges for it and it isn't a sale.
  const again = await coach('POST', `/v1/clients/${ava.id}/free-programs`, { program_id: program.id });
  assert.equal(again.status, 409); assert.match(again.body.error.message, /already has Off-season free/);
  const admin = (await owner('GET', '/v1/shop')).body;
  assert.equal(admin.programs.find((p) => p.id === program.id).sold, 0, 'a free program is not a sale');
  assert.equal(admin.last_30_days.sold, 0);
  assert.ok(admin.recent.some((r) => r.client_id === ava.id && r.granted_by === 'Riley Brooks' && r.amount_cents === 0));
  // The family export says who gave it.
  const exp = (await owner('GET', `/v1/families/${ava.family.id}/export`)).body;
  const bought = exp.athletes[0].bought_online;
  assert.deepEqual([bought[0].title, bought[0].amount_cents, bought[0].given_free_by], ['Off-season', 0, 'Riley Brooks']);
  // Taken back: the app closes again, the program stays assigned.
  const back = await coach('DELETE', `/v1/free-programs/${given.body.id}`);
  assert.equal(back.status, 200); assert.equal(back.body.status, 'canceled');
  home = (await athlete(ava)('GET', '/app/api/home')).body;
  assert.equal(home.locked, true, 'taken back: locked again');
  assert.equal((await coach('GET', `/v1/clients/${ava.id}`)).body.program?.id, program.id, 'still assigned');
  assert.deepEqual((await coach('GET', `/v1/clients/${ava.id}`)).body.free_programs, []);
  // Given again with a fresh assignment (free: true) after moving them off it.
  const other = (await coach('POST', '/v1/programs', { name: 'Other', weeks: 1 })).body;
  await coach('POST', `/v1/programs/${other.id}/assign`, { client_id: ava.id });
  const withFree = await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id, free: true });
  assert.equal(withFree.status, 201, JSON.stringify(withFree.body));
  assert.equal(withFree.body.free?.granted_by, 'Riley Brooks');
  assert.equal((await athlete(ava)('GET', '/app/api/home')).body.locked, false);
});

test('rules: on the program first, never a template, never archived; front desk can\'t give or take back', async () => {
  const ben = (await coach('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Kim Park', email: 'kim@example.com' } })).body;
  const notOn = await coach('POST', `/v1/clients/${ben.id}/free-programs`, { program_id: program.id });
  assert.equal(notOn.status, 409); assert.match(notOn.body.error.message, /isn't on Off-season. Assign it first/);
  const tpl = (await coach('POST', `/v1/programs/${program.id}/save-template`, { name: 'Tpl' })).body;
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/free-programs`, { program_id: tpl.id })).status, 409);
  assert.equal((await coach('POST', `/v1/clients/${ben.id}/free-programs`, { program_id: 'prog_nope' })).status, 404);
  assert.equal((await desk('POST', `/v1/clients/${ava.id}/free-programs`, { program_id: program.id })).status, 403);
  const id = (await coach('GET', `/v1/clients/${ava.id}`)).body.free_programs[0].id;
  assert.equal((await desk('DELETE', `/v1/free-programs/${id}`)).status, 403);
  assert.equal((await coach('DELETE', '/v1/free-programs/buy_nope')).status, 404);
});

test('a version 93 database gains the column, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v93-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v93.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 93');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 95, `round ${round}`);
      assert.ok(d.all('PRAGMA table_info(purchases)').some((c) => c.name === 'granted_by'));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
