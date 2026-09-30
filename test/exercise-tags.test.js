// Exercise tags (schema 64, Relay plan step 9): a movement pattern, muscles and equipment on each exercise, filters in
// the library, tags in the import list, and a version 63 database gaining the columns.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';

let app, base, coach, owner;
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
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); owner = await staff('owner@test.dev');
});
after(() => app.server.close());

test('tags are saved, answered as lists, checked against the lists and used as filters', async () => {
  const squat = await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body', movement: 'Squat', muscles: ['quads', 'glutes', 'Core'], equipment: 'barbell' });
  assert.equal(squat.status, 201, JSON.stringify(squat.body));
  assert.deepEqual([squat.body.movement, squat.body.muscles, squat.body.equipment], ['squat', ['quads', 'glutes', 'core'], ['barbell']], 'lower-cased, in the list\'s order');
  const row = (await coach('POST', '/v1/exercises', { name: 'Dumbbell row', movement: 'pull', muscles: 'back, arms', equipment: ['dumbbell', 'bench'] })).body;
  const jump = (await coach('POST', '/v1/exercises', { name: 'Box jump', movement: 'jump', equipment: ['box', 'bodyweight'] })).body;
  assert.deepEqual(row.equipment, ['dumbbell', 'bench']);
  assert.equal((await coach('POST', '/v1/exercises', { name: 'Bad one', movement: 'twist' })).status, 400);
  assert.equal((await coach('POST', '/v1/exercises', { name: 'Bad two', muscles: ['quads', 'toes'] })).status, 400);
  assert.equal((await coach('POST', '/v1/exercises', { name: 'Bad three', equipment: 'rocks' })).status, 400);
  // Update one tag; the others stay. Clearing with an empty value.
  const upd = await coach('PATCH', `/v1/exercises/${squat.body.id}`, { equipment: ['barbell', 'trap bar'] });
  assert.deepEqual([upd.body.movement, upd.body.muscles, upd.body.equipment], ['squat', ['quads', 'glutes', 'core'], ['barbell', 'trap bar']]);
  assert.deepEqual((await coach('PATCH', `/v1/exercises/${jump.id}`, { movement: '' })).body.movement, null);
  // The list carries the tag lists and filters by them.
  const all = (await coach('GET', '/v1/exercises')).body;
  assert.ok(all.tags.movements.includes('hinge') && all.tags.muscles.includes('hamstrings') && all.tags.equipment.includes('kettlebell'));
  assert.deepEqual((await coach('GET', '/v1/exercises?movement=pull')).body.data.map((x) => x.name), ['Dumbbell row']);
  assert.deepEqual((await coach('GET', '/v1/exercises?muscle=core')).body.data.map((x) => x.name), ['Back squat']);
  assert.deepEqual((await coach('GET', '/v1/exercises?equipment=bodyweight')).body.data.map((x) => x.name), ['Box jump']);
  assert.deepEqual((await coach('GET', '/v1/exercises?equipment=barbell&movement=squat')).body.data.map((x) => x.name), ['Back squat']);
  assert.deepEqual((await coach('GET', '/v1/exercises?equipment=sled')).body.data, []);
});

test('the import list takes tag columns; values off the lists are left off and noted', async () => {
  const csv = 'Name,Category,Movement,Muscles,Equipment,Video URL\nRomanian deadlift,Lower body,hinge,"hamstrings; glutes",barbell,https://cdn.example.com/rdl.mp4\nBear crawl,Core,crawl,core,bodyweight,\nKettlebell swing,Power,hinge,"glutes, hamstrings, wings",kettlebell,\n';
  const p = await owner('POST', '/v1/exercises/import/preview', { csv });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.problem_count, 0);
  assert.ok(p.body.notes.some((n) => /2 tags aren't on our lists/.test(n)), JSON.stringify(p.body.notes));
  const r = await owner('POST', '/v1/exercises/import', { csv, existing: 'skip' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rdl = (await coach('GET', '/v1/exercises?q=Romanian')).body.data[0];
  assert.deepEqual([rdl.movement, rdl.muscles, rdl.equipment], ['hinge', ['hamstrings', 'glutes'], ['barbell']]);
  const crawl = (await coach('GET', '/v1/exercises?q=Bear')).body.data[0];
  assert.deepEqual([crawl.movement, crawl.muscles, crawl.equipment], [null, ['core'], ['bodyweight']], 'an unknown movement is left off');
  const swing = (await coach('GET', '/v1/exercises?q=swing')).body.data[0];
  assert.deepEqual(swing.muscles, ['hamstrings', 'glutes'], 'the known ones stay, in the list\'s order');
});

test('a version 63 database gains the tag columns, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v63.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 63');
    old.exec(`INSERT INTO exercises (id, name, created_at) VALUES ('ex_1', 'Old squat', '2026-01-01T00:00:00Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 64, `round ${round}`);
      const cols = d.all('PRAGMA table_info(exercises)').map((c) => c.name);
      assert.ok(['movement', 'muscles', 'equipment'].every((c) => cols.includes(c)));
      assert.equal(d.get('SELECT movement FROM exercises WHERE id = ?', 'ex_1').movement, null);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
