// Progress report: share links (revocable, expiring, unguessable, family view only), periods, change since the last
// test, "not shared yet" markers, and emailing the report to the family.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { deleteFamilyData } from '../src/services/legal.js';

let app, base, owner, coach, desk, maria, dana, ava, cole, summer, fall;
const call = async (method, path, body, cookie, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const signIn = async (email) => (await call('POST', '/auth/login', { email, password: 'correct-horse-battery' })).cookie;
const parentIn = async (email) => { const code = (await call('POST', '/portal/api/login', { email })).body.dev_code; return (await call('POST', '/portal/api/verify', { email, code })).cookie; };
const secretOf = (url) => new URL(url).hash.replace('#share=', '');
const open = (secret, qs = '') => call('GET', `/portal/api/public/report${qs}`, null, null, secret == null ? {} : { 'x-report-link': secret });

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.test' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  [owner, coach, desk] = [await signIn('owner@test.dev'), await signIn('coach@test.dev'), await signIn('desk@test.dev')];
  ava = (await call('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2013-03-10', sex: 'F', parent: { name: 'Maria Lopez', email: 'maria@example.com' } }, owner)).body;
  cole = (await call('POST', '/v1/clients', { name: 'Cole Park', birth_date: '2011-09-22', parent: { name: 'Dan Park', email: 'dan@example.com' } }, owner)).body;
  maria = await parentIn('maria@example.com');
  dana = await parentIn('dan@example.com');
  summer = (await call('POST', '/v1/testing-sessions', { name: 'Summer baseline', date: '2026-06-01', tests: ['dash_40yd', 'vertical_standing'] }, owner)).body;
  fall = (await call('POST', '/v1/testing-sessions', { name: 'Fall combine', date: '2026-09-20', tests: ['dash_40yd', 'vertical_standing'] }, owner)).body;
  const winter = (await call('POST', '/v1/testing-sessions', { name: 'Winter check', date: '2026-03-01', tests: ['dash_40yd'] }, owner)).body;
  const rec = (s, date, vals) => call('POST', '/v1/results', { session_id: s.id, results: Object.entries(vals).map(([t, value]) => ({ client_id: ava.id, test: t, value, recorded_at: date })) }, owner);
  await rec(winter, '2026-03-01', { dash_40yd: 6.3 });
  await rec(summer, '2026-06-01', { dash_40yd: 6.12, vertical_standing: 15.5 });
  await rec(fall, '2026-09-20', { dash_40yd: 5.94, vertical_standing: 17 });
  await call('POST', `/v1/testing-sessions/${winter.id}/share`, { notify: false }, owner);
  await call('POST', `/v1/testing-sessions/${summer.id}/share`, { notify: false }, owner);
});
after(() => app.server.close());

test('the coach view marks what the family can\'t see yet; period and change since the last test', async () => {
  const r = (await call('GET', `/v1/clients/${ava.id}/report`, null, coach)).body;
  const forty = r.tests.find((t) => t.test === 'dash_40yd');
  assert.equal(forty.unshared_days, 1, 'the unshared fall result is marked');
  assert.equal(r.unshared_tests, 2);
  assert.equal(r.can_share, true);
  assert.deepEqual([forty.first.value, forty.previous.value, forty.latest.value], [6.3, 6.12, 5.94]);
  assert.equal(+forty.change_last.toFixed(2), -0.18);
  assert.equal(forty.improved_last, true);
  assert.equal(forty.improvement_pct_last, 2.9);
  assert.deepEqual(r.all_sessions.map((s) => [s.name, s.shared]), [['Fall combine', false], ['Summer baseline', true], ['Winter check', true]]);
  const since = (await call('GET', `/v1/clients/${ava.id}/report?from=2026-06-01`, null, coach)).body;
  assert.equal(since.tests.find((t) => t.test === 'dash_40yd').first.value, 6.12, 'since a testing day');
  assert.deepEqual(since.sessions.map((s) => s.name), ['Fall combine', 'Summer baseline']);
  assert.equal(since.all_sessions.length, 3, 'every testing day stays in the period picker');
  assert.equal((await call('GET', `/v1/clients/${ava.id}/report?from=2026-13-01`, null, coach)).status, 400);
  assert.equal((await call('GET', `/v1/clients/${ava.id}/report?from=2026-09-01&to=2026-06-01`, null, coach)).status, 400);
  const fam = (await call('GET', `/v1/clients/${ava.id}/report?parent_view=true`, null, coach)).body;
  assert.equal(fam.tests.find((t) => t.test === 'dash_40yd').latest.value, 6.12, 'family preview: shared days only');
  assert.equal(fam.tests[0].unshared_days, undefined);
  const desk1 = (await call('GET', `/v1/clients/${ava.id}/report`, null, desk)).body;
  assert.equal(desk1.can_share, false, 'front desk can read the report but not share it');
  const parent = (await call('GET', `/portal/api/athletes/${ava.id}/report?from=2026-05-01`, null, maria)).body;
  assert.deepEqual(parent.tests.find((t) => t.test === 'dash_40yd').history.map((x) => x.value), [6.12]);
});

test('share links: made once, family view only, no date of birth or IDs, opens counted once per visit', async () => {
  const l = (await call('POST', `/v1/clients/${ava.id}/report-links`, { days: 30, label: 'Grandma' }, coach)).body;
  assert.match(l.url, /^https:\/\/app\.example\.test\/report\.html#share=[\w-]{32}$/);
  const secret = secretOf(l.url);
  const row = app.ctx.db.get('SELECT * FROM report_links WHERE id = ?', l.id);
  assert.notEqual(row.token_hash, secret);
  assert.equal(JSON.stringify(row).includes(secret), false, 'the database never holds a working link');
  assert.equal(row.created_by_name, 'Riley Coach');
  const days = (Date.parse(l.expires_at) - Date.now()) / 864e5;
  assert.ok(days > 29.9 && days <= 30);
  const listed = (await call('GET', `/v1/clients/${ava.id}/report-links`, null, owner)).body.data;
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(secret), false, 'lists never show the link again');
  assert.equal(listed[0].url, undefined);

  const r = await open(secret, '?open=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.view, 'link');
  assert.equal(r.body.athlete.name, 'Ava Lopez');
  assert.equal(typeof r.body.athlete.age, 'number');
  for (const k of ['birth_date', 'athlete_id', 'id']) assert.equal(k in r.body.athlete, false, `no ${k}`);
  assert.equal(JSON.stringify(r.body).includes('2013-03-10'), false);
  assert.equal(JSON.stringify(r.body).includes(ava.id), false, 'no internal IDs');
  assert.equal(r.body.tests.find((t) => t.test === 'dash_40yd').latest.value, 6.12, 'only shared testing days');
  assert.equal(r.body.sessions.some((s) => s.name === 'Fall combine'), false);
  assert.equal(r.body.all_sessions.some((s) => s.name === 'Fall combine'), false);
  await open(secret, '?from=2026-06-01');                   // the same visitor changing the period
  assert.equal(app.ctx.db.get('SELECT views FROM report_links WHERE id = ?', l.id).views, 1);
  await open(secret, '?open=1');
  assert.equal((await call('GET', `/v1/clients/${ava.id}/report-links`, null, owner)).body.data[0].views, 2);

  // Sharing the fall day shows it through the link at once.
  await call('POST', `/v1/testing-sessions/${fall.id}/share`, { notify: false }, owner);
  assert.equal((await open(secret)).body.tests.find((t) => t.test === 'dash_40yd').latest.value, 5.94);
  await call('DELETE', `/v1/testing-sessions/${fall.id}/share`, null, owner);
  assert.equal((await open(secret)).body.tests.find((t) => t.test === 'dash_40yd').latest.value, 6.12, 'and hides it again when unshared');
  // A business that shows families every result at once shows them through links too, like the portal.
  app.ctx.db.run(`INSERT INTO settings (key, value) VALUES ('share_results', 'all') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  assert.equal((await open(secret)).body.tests.find((t) => t.test === 'dash_40yd').latest.value, 5.94);
  app.ctx.db.run(`DELETE FROM settings WHERE key = 'share_results'`);
});

test('wrong, garbled, expired and turned-off links all get the same answer', async () => {
  const l = (await call('POST', `/v1/clients/${ava.id}/report-links`, { days: 7 }, owner)).body;
  const secret = secretOf(l.url);
  const gone = [await open('x'.repeat(32)), await open(null), await open('bad secret!'), await open('a'.repeat(200))];
  for (const g of gone) assert.deepEqual([g.status, g.body.error.code], [410, 'link_expired']);
  const msg = gone[0].body.error.message;
  assert.match(msg, /expired or been turned off/);
  assert.equal((await call('GET', `/portal/api/public/report?link=${secret}`)).status, 410, 'the secret works only in the header');
  // Expired
  app.ctx.db.run('UPDATE report_links SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), l.id);
  assert.deepEqual([(await open(secret)).status, (await open(secret)).body.error.message], [410, msg]);
  assert.equal((await call('GET', `/v1/clients/${ava.id}/report-links`, null, owner)).body.data.some((x) => x.id === l.id), false, 'expired links drop off the list');
  // Turned off
  const l2 = (await call('POST', `/v1/clients/${ava.id}/report-links`, { days: 90 }, owner)).body;
  assert.equal((await open(secretOf(l2.url))).status, 200);
  assert.equal((await call('DELETE', `/v1/clients/${ava.id}/report-links/${l2.id}`, null, coach)).status, 200);
  assert.deepEqual([(await open(secretOf(l2.url))).status, (await open(secretOf(l2.url))).body.error.message], [410, msg]);
  assert.equal((await call('DELETE', `/v1/clients/${cole.id}/report-links/${l2.id}`, null, owner)).status, 404, 'a link is turned off through its own athlete only');
});

test('link rules: allowed lengths, ten at a time, archived athletes, and who may share', async () => {
  assert.match((await call('POST', `/v1/clients/${cole.id}/report-links`, { days: 3 }, owner)).body.error.message, /7, 30, 90 or 365/);
  assert.match((await call('POST', `/v1/clients/${cole.id}/report-links`, { label: 'x'.repeat(61) }, owner)).body.error.message, /60 characters/);
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', `/v1/clients/${cole.id}/report-links`, { days: 365 }, owner)).status, 201);
  assert.match((await call('POST', `/v1/clients/${cole.id}/report-links`, {}, owner)).body.error.message, /already has 10 working links/);
  for (const [m, p] of [['GET', 'report-links'], ['POST', 'report-links'], ['POST', 'report/email']]) assert.equal((await call(m, `/v1/clients/${ava.id}/${p}`, m === 'POST' ? {} : null, desk)).status, 403, `front desk: ${m} ${p}`);
  const one = (await call('GET', `/v1/clients/${cole.id}/report-links`, null, owner)).body.data[0];
  assert.equal((await call('DELETE', `/v1/clients/${cole.id}/report-links/${one.id}`, null, desk)).status, 403);
  // Archiving turns the athlete's links off and stops new ones.
  const l = (await call('POST', `/v1/clients/${ava.id}/report-links`, { days: 30 }, owner)).body;
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', new Date().toISOString(), ava.id);
  assert.equal((await open(secretOf(l.url))).status, 410);
  assert.match((await call('POST', `/v1/clients/${ava.id}/report-links`, {}, owner)).body.error.message, /archived/);
  app.ctx.db.run('UPDATE clients SET archived_at = NULL WHERE id = ?', ava.id);
  assert.equal((await open(secretOf(l.url))).status, 200, 'restoring the profile brings a still-valid link back');
});

test('parents share their own athletes only, and can turn off any link to their athlete', async () => {
  const mine = await call('POST', `/portal/api/athletes/${ava.id}/report-links`, { days: 7, label: 'Recruiter' }, maria);
  assert.equal(mine.status, 201);
  assert.equal(app.ctx.db.get('SELECT created_by_kind, created_by_name FROM report_links WHERE id = ?', mine.body.id).created_by_kind, 'parent');
  assert.equal((await open(secretOf(mine.body.url))).status, 200);
  const list = (await call('GET', `/portal/api/athletes/${ava.id}/report-links`, null, maria)).body.data;
  assert.ok(list.some((x) => x.label === 'Recruiter' && x.created_by_name === 'Maria Lopez (parent)'));
  const coachMade = list.find((x) => x.created_by_name === 'Olivia Owner');
  assert.equal((await call('DELETE', `/portal/api/athletes/${ava.id}/report-links/${coachMade.id}`, null, maria)).status, 200);
  // Another family's athlete: not found, whatever the route.
  assert.equal((await call('GET', `/portal/api/athletes/${ava.id}/report-links`, null, dana)).status, 404);
  assert.equal((await call('POST', `/portal/api/athletes/${ava.id}/report-links`, { days: 7 }, dana)).status, 404);
  assert.equal((await call('DELETE', `/portal/api/athletes/${ava.id}/report-links/${mine.body.id}`, null, dana)).status, 404);
  assert.equal((await call('DELETE', `/portal/api/athletes/${cole.id}/report-links/${mine.body.id}`, null, dana)).status, 404, 'a link id from another family does nothing');
  assert.equal((await open(secretOf(mine.body.url))).status, 200);
  assert.equal((await call('GET', `/portal/api/athletes/${ava.id}/report-links`)).status, 401);
});

test('email the report to the family, with or without a 90-day link', async () => {
  assert.match((await call('POST', `/v1/clients/${cole.id}/report/email`, {}, coach)).body.error.message, /no results the family can see yet/);
  const noParent = (await call('POST', '/v1/clients', { name: 'Solo Kid', email: 'solo@example.com' }, owner)).body;
  assert.match((await call('POST', `/v1/clients/${noParent.id}/report/email`, {}, coach)).body.error.message, /no parent email/);
  const plain = (await call('POST', `/v1/clients/${ava.id}/report/email`, { note: 'Great summer.' }, coach)).body;
  assert.deepEqual(plain, { emailed: 1, link: null });
  const outbox = () => app.ctx.db.all(`SELECT * FROM outbox WHERE to_email = 'maria@example.com' AND subject = 'Ava''s progress report' ORDER BY rowid`);
  let mail = outbox().at(-1);
  assert.match(mail.body, /Great summer\./);
  assert.match(mail.body, /Biggest improvements:\n {2}40-yard dash: 6\.30 s to 6\.12 s \(\+2\.9%\)/);
  assert.match(mail.body, /https:\/\/app\.example\.test\/parent/);
  assert.equal(mail.body.includes('5.94'), false, 'nothing from the unshared day');
  const withLink = (await call('POST', `/v1/clients/${ava.id}/report/email`, { include_link: true }, coach)).body;
  assert.equal(withLink.emailed, 1);
  assert.ok(withLink.link.id && !('url' in withLink.link), 'the link address goes only to the family');
  mail = outbox().at(-1);
  const url = mail.body.match(/https:\/\/app\.example\.test\/report\.html#share=[\w-]+/)[0];
  assert.equal((await open(secretOf(url))).status, 200);
  assert.equal(app.ctx.db.get('SELECT label FROM report_links WHERE id = ?', withLink.link.id).label, 'Emailed to family');
  const days = (Date.parse(app.ctx.db.get('SELECT expires_at FROM report_links WHERE id = ?', withLink.link.id).expires_at) - Date.now()) / 864e5;
  assert.ok(days > 89.9 && days <= 90);
});

test('deleting a family removes its report links', async () => {
  const l = (await call('POST', `/v1/clients/${cole.id}/report-links`, { days: 30 }, owner));
  assert.equal(l.status, 400, 'Cole still has 10 links');
  const before = app.ctx.db.get('SELECT COUNT(*) AS n FROM report_links WHERE client_id = ?', cole.id).n;
  assert.ok(before > 0);
  const fam = app.ctx.db.get('SELECT f.id, f.name FROM families f JOIN clients c ON c.family_id = f.id WHERE c.id = ?', cole.id);
  await deleteFamilyData(app.ctx, fam.id, { confirm: fam.name });
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM report_links WHERE client_id = ?', cole.id).n, 0);
});
