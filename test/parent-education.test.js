// Courses for parents, shown by their athletes' ages, with each parent's own reading.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';

let app, base, coach, maria, dana, ava, growth, fuel;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
async function parent(email) {
  const { body } = await req('POST', '/portal/api/login', { email });
  return as((await req('POST', '/portal/api/verify', { email, code: body.dev_code })).cookie);
}
const born = (age) => `${new Date().getFullYear() - age}-01-15`;

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = as((await req('POST', '/auth/login', { email: 'coach@test.dev', password: 'coach-password-1' })).cookie);
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: born(12), parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  await coach('POST', '/v1/clients', { name: 'Ben Park', birth_date: born(17), parent: { name: 'Dana Park', email: 'dana@example.com' } });
  maria = await parent('maria@example.com'); dana = await parent('dana@example.com');
});
after(() => app.server.close());

test('starter courses arrive as drafts, once', async () => {
  const r = (await coach('POST', '/v1/courses/starter-parent')).body;
  assert.equal(r.added.length, 3);
  assert.equal((await coach('POST', '/v1/courses/starter-parent')).body.added.length, 0);
  const edu = (await coach('GET', '/v1/education')).body;
  growth = edu.courses.find((c) => c.title === 'Growth spurts and training');
  fuel = edu.courses.find((c) => c.title === 'Fueling a young athlete');
  assert.deepEqual([growth.audience, growth.age_min, growth.age_max, growth.published], ['parents', 10, 15, false]);
  assert.equal((await maria('GET', '/portal/api/parent-courses')).body.data.length, 0, 'drafts stay hidden');
});

test('published parent courses show by age, never to athletes', async () => {
  for (const c of [growth, fuel]) await coach('PATCH', `/v1/courses/${c.id}`, { published: true });
  assert.deepEqual((await maria('GET', '/portal/api/parent-courses')).body.data.map((c) => c.title), ['Growth spurts and training', 'Fueling a young athlete']);
  assert.deepEqual((await dana('GET', '/portal/api/parent-courses')).body.data.map((c) => c.title), ['Fueling a young athlete'], 'Ben is 17');
  const kid = (await req('GET', '/app/api/engage', null, { 'x-client-token': ava.app_link.split('token=')[1] })).body.education;
  assert.equal(JSON.stringify(kid).includes('Growth spurts'), false);
  assert.equal((await req('GET', `/app/api/lessons/${growth.lessons[0].id}`, null, { 'x-client-token': ava.app_link.split('token=')[1] })).status, 404);
  const assign = await coach('POST', '/v1/lesson-assignments', { course_id: growth.id, client_id: ava.id });
  assert.equal(assign.status, 409);
  assert.match(assign.body.error.message, /for parents/);
});

test('each parent keeps their own place', async () => {
  const l = growth.lessons[0];
  const read = (await maria('GET', `/portal/api/parent-lessons/${l.id}`)).body;
  assert.deepEqual([read.title, read.position, read.next.title], ['What a growth spurt does', { n: 1, of: 3 }, 'Knee and heel pain']);
  assert.equal((await maria('POST', `/portal/api/parent-lessons/${l.id}/complete`, {})).body.done, true);
  assert.equal((await maria('GET', '/portal/api/parent-courses')).body.data[0].done, 1);
  assert.equal((await dana('GET', `/portal/api/parent-lessons/${l.id}`)).status, 404, 'not for Dana\'s age group');
  assert.equal((await coach('GET', '/v1/education')).body.courses.find((c) => c.id === growth.id).parents_reading, 1);
});
