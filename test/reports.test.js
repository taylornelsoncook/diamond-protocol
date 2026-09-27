import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { maturityOffset } from '../src/services/reports.js';

let app, base, coach, parent, ava, other, summer, fall;
const call = async (method, path, body, cookie) => {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = (await call('POST', '/auth/login', { email: 'coach@test.dev', password: 'correct-horse-battery' })).cookie;
  ava = (await call('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2013-03-10', sex: 'F', parent: { name: 'Maria Lopez', email: 'maria@example.com' } }, coach)).body;
  other = (await call('POST', '/v1/clients', { name: 'Cole Park', birth_date: '2011-09-22', parent: { name: 'Dana Park', email: 'dana@example.com' } }, coach)).body;
  const code = (await call('POST', '/portal/api/login', { email: 'maria@example.com' })).body.dev_code;
  parent = (await call('POST', '/portal/api/verify', { email: 'maria@example.com', code })).cookie;
  summer = (await call('POST', '/v1/testing-sessions', { name: 'Summer baseline', date: '2026-06-01', tests: ['height', 'seated_height', 'weight', 'dash_40yd', 'vertical_standing'] }, coach)).body;
  fall = (await call('POST', '/v1/testing-sessions', { name: 'Fall combine', date: '2026-09-20', tests: ['height', 'seated_height', 'weight', 'dash_40yd', 'vertical_standing'] }, coach)).body;
  const rec = (s, date, vals) => call('POST', '/v1/results', { session_id: s.id, results: Object.entries(vals).map(([test, value]) => ({ client_id: ava.id, test, value, recorded_at: date })) }, coach);
  await rec(summer, '2026-06-01', { height: 61.5, seated_height: 31.8, weight: 98, dash_40yd: 6.12, vertical_standing: 15.5 });
  await rec(fall, '2026-09-20', { height: 62.4, seated_height: 32.3, weight: 101, dash_40yd: 5.94, vertical_standing: 17 });
});
after(() => app.server.close());

test('growth-spurt estimate behaves sensibly', () => {
  const boy = (age) => maturityOffset({ sex: 'M', age, heightCm: 160, seatedCm: 82, weightKg: 48 });
  assert.ok(boy(13) > -1.5 && boy(13) < 0.5, `13-year-old boy offset ${boy(13)}`);
  assert.ok(boy(15) > boy(13), 'older at the same size means further along');
  const girl = maturityOffset({ sex: 'F', age: 13, heightCm: 158, seatedCm: 82, weightKg: 47 });
  assert.ok(girl > boy(13), 'girls reach peak growth earlier');
  assert.equal(maturityOffset({ sex: null, age: 13, heightCm: 158, seatedCm: 82, weightKg: 47 }), null);
});

test('parents see nothing until the coach shares a testing day', async () => {
  const hidden = (await call('GET', `/portal/api/athletes/${ava.id}/report`, null, parent)).body;
  assert.deepEqual([hidden.tests.length, hidden.sessions.length, hidden.visibility], [0, 0, 'shared']);
  const coachView = (await call('GET', `/v1/clients/${ava.id}/report`, null, coach)).body;
  assert.equal(coachView.tests.length, 2, 'coaches always see everything');
  assert.equal((await call('GET', `/v1/clients/${ava.id}/report?parent_view=true`, null, coach)).body.tests.length, 0, 'coach can preview the family view');
});

test('sharing shows the results, emails the family, and the report tells the story', async () => {
  await call('POST', `/v1/testing-sessions/${summer.id}/share`, { notify: false }, coach);
  const s = (await call('POST', `/v1/testing-sessions/${fall.id}/share`, { parent_note: 'Great off-season. Keep sprinting twice a week.' }, coach)).body;
  assert.equal(s.families_notified, 1);
  assert.ok(s.shared_at);
  const mail = (await call('GET', '/v1/outbox', null, coach)).body.data.find((m) => m.to_email === 'maria@example.com' && m.subject.includes('results from Fall combine'));
  assert.ok(mail.body.includes('Keep sprinting twice a week') && mail.body.includes('/parent'));
  const r = (await call('GET', `/portal/api/athletes/${ava.id}/report`, null, parent)).body;
  assert.equal(r.athlete.athlete_id, ava.athlete_id);
  const forty = r.tests.find((t) => t.test === 'dash_40yd');
  assert.deepEqual([forty.first.value, forty.latest.value, forty.best, forty.improved], [6.12, 5.94, 5.94, true]);
  assert.equal(forty.improvement_pct, 2.9, '6.12 → 5.94 is 2.9% faster');
  assert.equal(r.highlights[0].test, 'vertical_standing', 'biggest improvement first (15.5 → 17 in, +9.7%)');
  assert.deepEqual(r.new_prs.sort(), ['40-yard dash', 'Vertical jump']);
  assert.equal(r.latest_session.parent_note, 'Great off-season. Keep sprinting twice a week.');
  assert.ok(r.growth.growth_per_year > 2 && r.growth.growth_per_year < 4, `about 2.8 in/yr, got ${r.growth.growth_per_year}`);
  const est = r.growth.estimate;
  assert.equal(est.measured_on, '2026-09-20');
  assert.ok(['before', 'during', 'after'].includes(est.phase));
  assert.ok(est.peak_age > 10 && est.peak_age < 15, `peak growth age ${est.peak_age}`);
  assert.ok(!r.tests.some((t) => t.category === 'body'), 'height and weight appear under growth, not as test scores');
});

test('missing details are named instead of guessed; other families stay private', async () => {
  await call('PATCH', `/v1/clients/${ava.id}`, { sex: null }, coach);
  const r = (await call('GET', `/portal/api/athletes/${ava.id}/report`, null, parent)).body;
  assert.equal(r.growth.estimate, null);
  assert.deepEqual(r.growth.missing, ['sex']);
  await call('PATCH', `/portal/api/athletes/${ava.id}`, { sex: 'F' }, parent);
  assert.ok((await call('GET', `/portal/api/athletes/${ava.id}/report`, null, parent)).body.growth.estimate, 'parents can fill it in');
  assert.equal((await call('GET', `/portal/api/athletes/${other.id}/report`, null, parent)).status, 404);
  await call('DELETE', `/v1/testing-sessions/${fall.id}/share`, null, coach);
  assert.equal((await call('GET', `/portal/api/athletes/${ava.id}/report`, null, parent)).body.sessions.length, 1, 'unsharing hides it again');
  await call('PATCH', '/v1/settings', { share_results: 'all' }, coach);
  assert.equal((await call('GET', `/portal/api/athletes/${ava.id}/report`, null, parent)).body.visibility, 'all');
  assert.equal((await call('GET', `/portal/api/athletes/${ava.id}/report`, null, parent)).body.tests.find((t) => t.test === 'dash_40yd').latest.value, 5.94);
});
