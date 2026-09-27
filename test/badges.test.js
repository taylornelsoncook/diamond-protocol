// Skill badges: coaches award them, athletes and parents see them, front desk only looks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { today } from '../src/services/engage.js';
import { addDaysToDate, newId } from '../src/util.js';

let app, base, coach, desk, ava, cal, sprint;

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const athleteApp = (c) => req('GET', '/app/api/engage', null, { 'x-client-token': c.app_link.split('token=')[1] });
const mailTo = (email) => app.ctx.db.all('SELECT subject, body FROM outbox WHERE to_email = ? AND subject LIKE \'%badge%\'', email);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev', 'coach-password-1');
  desk = await signIn('desk@test.dev', 'desk-password-1');
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  cal = (await coach('POST', '/v1/clients', { name: 'Cal Reyes', parent: { name: 'Kim Reyes', email: 'kim@example.com' } })).body;
});
after(() => app.server.close());

test('coaches make badges and award them to a group; each family is emailed once', async () => {
  sprint = (await coach('POST', '/v1/skill-badges', { name: 'Sprint start', category: 'Speed', description: 'Low, powerful first three steps.' })).body;
  assert.equal((await coach('POST', '/v1/skill-badges', { name: 'sprint START' })).status, 409, 'names are unique');
  assert.equal((await coach('POST', '/v1/skill-badges', { name: 'Hinge', category: 'Vibes' })).status, 400);

  const r = (await coach('POST', `/v1/skill-badges/${sprint.id}/awards`, { client_ids: [ava.id, cal.id], note: 'Great first step.' })).body;
  assert.deepEqual([r.awarded, r.already_had, r.badge.awarded], [2, 0, 2]);
  const again = (await coach('POST', `/v1/skill-badges/${sprint.id}/awards`, { client_id: ava.id })).body;
  assert.deepEqual([again.awarded, again.already_had], [0, 1]);
  const [m] = mailTo('maria@example.com');
  assert.equal(m.subject, 'Ava earned a skill badge: Sprint start');
  assert.match(m.body, /from Carl\.[\s\S]*Low, powerful[\s\S]*Carl: "Great first step\."/);
  assert.equal(mailTo('maria@example.com').length, 1, 'no second email for a badge already earned');
});

test('athletes and parents see earned badges; coaches can take one back', async () => {
  const mine = (await athleteApp(ava)).body.performance.skill_badges;
  assert.deepEqual(mine.map((b) => [b.name, b.category, b.note, b.awarded_by]), [['Sprint start', 'Speed', 'Great first step.', 'Carl Coach']]);
  const en = (await coach('GET', `/v1/clients/${ava.id}/engagement`)).body;
  assert.equal(en.skill_badges.length, 1);
  assert.equal((await coach('DELETE', `/v1/badge-awards/${en.skill_badges[0].id}`)).status, 200);
  assert.equal((await athleteApp(ava)).body.performance.skill_badges.length, 0);
  const calStill = app.ctx.db.get('SELECT COUNT(*) AS n FROM badge_awards WHERE client_id = ?', cal.id).n;
  assert.equal(calStill, 1, 'taking back one badge leaves the others');
});

test('a removed badge stays earned but leaves the list; front desk only looks', async () => {
  assert.equal((await coach('PATCH', `/v1/skill-badges/${sprint.id}`, { archived: true })).body.archived, true);
  assert.equal((await coach('GET', '/v1/skill-badges')).body.data.length, 0);
  assert.equal((await coach('GET', '/v1/skill-badges?all=1')).body.data.length, 1);
  assert.equal((await athleteApp(cal)).body.performance.skill_badges.length, 1, 'Cal keeps it');
  assert.equal((await coach('POST', `/v1/skill-badges/${sprint.id}/awards`, { client_id: ava.id })).status, 409);

  assert.equal((await desk('GET', '/v1/skill-badges')).status, 200);
  assert.equal((await desk('POST', '/v1/skill-badges', { name: 'Desk badge' })).status, 403);
  assert.equal((await desk('POST', `/v1/skill-badges/${sprint.id}/awards`, { client_id: ava.id })).status, 403);
});

test('milestones appear on their own, like a 7-day check-in streak', async () => {
  assert.deepEqual((await athleteApp(ava)).body.performance.milestones, []);
  const t = today(app.ctx);
  for (let i = 0; i < 7; i++) app.ctx.db.run('INSERT INTO daily_checkins (id, client_id, date, sleep_hours, created_at, updated_at) VALUES (?, ?, ?, 8, ?, ?)', newId('chk'), ava.id, addDaysToDate(t, -i), app.ctx.now(), app.ctx.now());
  const [m] = (await athleteApp(ava)).body.performance.milestones;
  assert.deepEqual([m.name, m.detail], ['7-day check-in streak', 'Checked in 7 days in a row.']);
});
