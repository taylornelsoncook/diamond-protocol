import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';

// Courses in order (owner's ask): a lesson opens only once the one before is finished, and finishing a lesson with a
// quiz means passing it. Athletes and parents alike; a coach can turn the order off per course.
let app, base, owner, ava, parentCookie, course, l1, l2, l3;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
let token;
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
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev');
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', ava.id).access_token;
  course = (await owner('POST', '/v1/courses', { title: 'Sprint basics' })).body;
  assert.equal(course.in_order, true, 'in order by default');
  const mk = async (title, extra = {}) => (await owner('POST', '/v1/lessons', { title, body: `${title} text.`, course_id: course.id, ...extra })).body;
  l1 = await mk('Stance'); l2 = await mk('Drive', { quiz_text: 'Which leg pushes?\n- The front leg\n* The back leg' }); l3 = await mk('Top speed');
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com' }) })).json()).dev_code;
  const ver = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com', code }) });
  parentCookie = ver.headers.get('set-cookie').split(';')[0];
});
after(() => app.server.close());

test('an athlete opens lessons in order: the next unlocks when the one before is finished, and a quiz must be passed to finish', async () => {
  let edu = (await athlete('GET', '/app/api/engage')).body.education;
  let c = edu.courses.find((x) => x.id === course.id);
  assert.equal(c.in_order, true);
  assert.deepEqual(c.lessons.map((l) => [l.title, !!l.locked, l.locked_by ?? null]), [['Stance', false, null], ['Drive', true, 'Stance'], ['Top speed', true, 'Stance']]);
  const blocked = await athlete('GET', `/app/api/lessons/${l2.id}`);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.deepEqual([blocked.body.error.code, blocked.body.error.details.locked_by], ['locked', l1.id]);
  assert.match(blocked.body.error.message, /Finish "Stance" first/);
  assert.equal((await athlete('POST', `/app/api/lessons/${l2.id}/complete`, {})).status, 409, 'nor finished out of turn');
  assert.equal((await athlete('POST', `/app/api/lessons/${l2.id}/quiz`, { answers: [1] })).status, 409, 'nor quizzed out of turn');
  // Finish Stance: Drive opens, Top speed waits for Drive.
  assert.equal((await athlete('POST', `/app/api/lessons/${l1.id}/complete`, {})).status, 200);
  c = (await athlete('GET', '/app/api/engage')).body.education.courses.find((x) => x.id === course.id);
  assert.deepEqual(c.lessons.map((l) => [l.title, !!l.locked, l.locked_by ?? null]), [['Stance', false, null], ['Drive', false, null], ['Top speed', true, 'Drive']]);
  assert.equal((await athlete('GET', `/app/api/lessons/${l2.id}`)).status, 200);
  // Drive has a quiz: marking it done without passing is refused; a wrong answer fails; the right one passes and finishes it.
  assert.equal((await athlete('POST', `/app/api/lessons/${l2.id}/complete`, {})).status, 409);
  const wrong = (await athlete('POST', `/app/api/lessons/${l2.id}/quiz`, { answers: [0] })).body;
  assert.deepEqual([wrong.passed, wrong.lesson.done], [false, false]);
  const right = (await athlete('POST', `/app/api/lessons/${l2.id}/quiz`, { answers: [1] })).body;
  assert.deepEqual([right.passed, right.lesson.done, right.lesson.next?.title], [true, true, 'Top speed']);
  assert.equal((await athlete('GET', `/app/api/lessons/${l3.id}`)).status, 200, 'the last lesson is open now');
  // The coach turns the order off: everything opens at once for a new athlete.
  assert.equal((await owner('PATCH', `/v1/courses/${course.id}`, { in_order: false })).body.in_order, false);
  const ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  const benToken = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', ben.id).access_token;
  const r = await fetch(`${base}/app/api/lessons/${l3.id}`, { headers: { 'x-client-token': benToken } });
  assert.equal(r.status, 200);
  assert.equal((await owner('PATCH', `/v1/courses/${course.id}`, { in_order: true })).body.in_order, true);
});

test('a parent course goes in order too; a version 74 database gains in_order on, opened twice', async () => {
  const pc = (await owner('POST', '/v1/courses', { title: 'Parent basics', audience: 'parents' })).body;
  const p1 = (await owner('POST', '/v1/lessons', { title: 'Sleep', body: 'Sleep text.', course_id: pc.id })).body;
  const p2 = (await owner('POST', '/v1/lessons', { title: 'Food', body: 'Food text.', course_id: pc.id })).body;
  const list = (await parent('GET', '/portal/api/parent-courses')).body.data.find((c) => c.id === pc.id);
  assert.deepEqual(list.lessons.map((l) => [l.title, !!l.locked, l.locked_by ?? null]), [['Sleep', false, null], ['Food', true, 'Sleep']]);
  const blocked = await parent('GET', `/portal/api/parent-lessons/${p2.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.locked_by, p1.id);
  assert.equal((await parent('POST', `/portal/api/parent-lessons/${p1.id}/complete`, {})).status, 200);
  assert.equal((await parent('GET', `/portal/api/parent-lessons/${p2.id}`)).status, 200);

  const tmp = mkdtempSync(join(tmpdir(), 'dp-v74-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v74.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 74');
    old.exec(`INSERT INTO courses (id, title, created_at) VALUES ('crs_old', 'Old course', '2026-01-01T00:00:00Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 75, `round ${round}`);
      assert.deepEqual(d.get('SELECT title, in_order FROM courses WHERE id = ?', 'crs_old'), { title: 'Old course', in_order: 1 }, 'existing courses go in order');
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
