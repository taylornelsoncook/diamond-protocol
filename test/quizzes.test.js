// Lesson quizzes and course certificates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';

let app, base, coach, ava, course, l1, l2;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const athlete = (method, path, body) => req(method, `/app/api/${path}`, body, { 'x-client-token': ava.app_link.split('token=')[1] });
const QUIZ = `What should your knees do when you land?
- Cave inward
* Track over your toes
- Lock straight

How much sleep does a teen athlete need?
- 5 to 6 hours
- 7 hours
* 8 to 10 hours`;

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = as((await req('POST', '/auth/login', { email: 'coach@test.dev', password: 'coach-password-1' })).cookie);
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  course = (await coach('POST', '/v1/courses', { title: 'Landing basics' })).body;
  l1 = (await coach('POST', '/v1/lessons', { title: 'Soft landings', body: 'Land quietly.', course_id: course.id })).body;
  l2 = (await coach('POST', '/v1/lessons', { title: 'Sleep', body: 'Sleep more.', course_id: course.id })).body;
});
after(() => app.server.close());

test('coaches write a quiz as plain text, and mistakes are named by question', async () => {
  const bad = await coach('PATCH', `/v1/lessons/${l1.id}`, { quiz_text: 'Knees?\n- In\n- Out\n\nSleep?\n* 8\n* 9' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /Question 1 needs a right answer.*Question 2 has more than one right answer/);
  const ok = (await coach('PATCH', `/v1/lessons/${l1.id}`, { quiz_text: QUIZ })).body;
  assert.equal(ok.quiz.length, 2);
  assert.equal(ok.quiz_text, QUIZ, 'the text comes back the way it was written');
});

test('the lesson finishes only when the quiz is passed, and answers are never sent', async () => {
  const l = (await athlete('GET', `lessons/${l1.id}`)).body;
  assert.deepEqual(l.quiz.questions[0], { q: 'What should your knees do when you land?', choices: ['Cave inward', 'Track over your toes', 'Lock straight'] });
  assert.equal(JSON.stringify(l).includes('answer'), false);
  assert.equal((await athlete('POST', `lessons/${l1.id}/complete`, {})).status, 409);
  const miss = (await athlete('POST', `lessons/${l1.id}/quiz`, { answers: [1, 0] })).body;
  assert.deepEqual([miss.score, miss.passed, miss.results.map((r) => r.correct), miss.lesson.done], [1, false, [true, false], false]);
  assert.equal((await athlete('POST', `lessons/${l1.id}/quiz`, { answers: [1] })).status, 400);
  const pass = (await athlete('POST', `lessons/${l1.id}/quiz`, { answers: [1, 2] })).body;
  assert.deepEqual([pass.passed, pass.lesson.done, pass.lesson.quiz.passed], [true, true, true]);
});

test('finishing the course issues one certificate with a shareable page', async () => {
  assert.equal((await athlete('GET', 'engage')).body.education.certificates.length, 0);
  await athlete('POST', `lessons/${l2.id}/complete`, {});
  const [cert] = (await athlete('GET', 'engage')).body.education.certificates;
  assert.equal(cert.title, 'Landing basics');
  const tok = cert.url.split('#')[1];
  const page = (await req('GET', `/portal/api/public/certificates/${tok}`)).body;
  assert.deepEqual([page.name, page.course, page.lessons], ['Ava Lopez', 'Landing basics', 2]);
  assert.equal((await req('GET', '/portal/api/public/certificates/nope-nope-nope')).status, 404);
  const mail = app.ctx.db.all(`SELECT subject, body FROM outbox WHERE to_email = 'maria@example.com' AND subject LIKE '%finished%'`);
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, new RegExp(`https://app\\.example\\.org/certificate#${tok}`));
  // Undoing and redoing a lesson doesn't send a second certificate.
  await athlete('POST', `lessons/${l2.id}/complete`, { done: false });
  await athlete('POST', `lessons/${l2.id}/complete`, {});
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM course_certificates').n, 1);
  assert.equal((await coach('GET', '/v1/education')).body.courses[0].certificates, 1);
});
