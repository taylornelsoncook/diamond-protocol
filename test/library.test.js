// Test library and progress report: protocols, usage, record boards, editing and deleting tests, presets,
// report periods, family preview, share links and emailing the report.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-library-'));
process.env.DP_DB = path.join(dir, 'test.db');
process.env.DP_DATA_DIR = dir;

const { app } = require('../server/index.js');
const seed = require('../server/seed.js');
const db = require('../server/db');

let server, base;
function client() {
  const jar = {};
  async function call(method, p, body) {
    const h = {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), patch: (p, b) => call('PATCH', p, b ?? {}), del: (p) => call('DELETE', p) };
}
async function staff(email, pw) { const c = client(); assert.equal((await c.post('/api/auth/staff/login', { email, password: pw })).status, 200); return c; }
async function parent(email) {
  const c = client();
  const r = await c.post('/api/auth/parent/code', { email });
  await c.post('/api/auth/parent/verify', { email, code: r.data.test_code });
  return c;
}
const testId = (name) => db.get('SELECT id FROM tests WHERE name=?', name).id;
const athlete = (first) => db.get('SELECT * FROM athletes WHERE first_name=?', first);
const lastLog = () => db.get('SELECT * FROM activity ORDER BY id DESC LIMIT 1');

let owner, coach, desk;
test.before(async () => {
  seed.resetDatabase(); seed.base(); seed.demo();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await staff('owner@demo.test', 'demo-owner-2026');
  coach = await staff('coach@demo.test', 'demo-coach-2026');
  desk = await staff('desk@demo.test', 'demo-desk-2026');
});
test.after(() => { server?.close(); });

test('library lists protocols, usage and presets; front desk can read it', async () => {
  const r = await desk.get('/api/tests?all=1');
  assert.equal(r.status, 200);
  const forty = r.data.find((t) => t.name === '40-yard dash');
  assert.match(forty.description, /Three-point stance/);
  assert.ok(forty.results > 0 && forty.athletes > 0 && /^\d{4}-\d{2}-\d{2}$/.test(forty.last_used));
  assert.deepEqual(forty.presets, ['Combine']);
  const unused = r.data.find((t) => t.name === 'T-test');
  assert.equal(unused.results, 0);
  assert.equal(unused.last_used, null);
  // Every built-in test has a protocol
  assert.ok(r.data.filter((t) => !t.custom).every((t) => t.description), 'built-in protocols');
  // the plain list stays lean for menus
  assert.ok(!('results' in (await desk.get('/api/tests')).data[0]));
});

test('test detail: record board is each athlete\'s best, filterable by sex and age', async () => {
  const id = testId('40-yard dash');
  const d = (await desk.get(`/api/tests/${id}`)).data;
  assert.ok(d.usage.results > 0 && d.usage.days >= 1);
  assert.ok(d.board.length > 0 && d.board.length <= 10);
  const ids = d.board.map((b) => b.athlete_id);
  assert.equal(new Set(ids).size, ids.length, 'one row per athlete');
  for (let i = 1; i < d.board.length; i++) assert.ok(d.board[i].value >= d.board[i - 1].value, 'fastest first');
  const best = db.get('SELECT MIN(value) AS v FROM results WHERE test_id=?', id).v;
  assert.equal(d.board[0].value, best);
  const girls = (await coach.get(`/api/tests/${id}?sex=F`)).data.board;
  assert.ok(girls.length > 0 && girls.every((b) => athlete(b.first_name).sex === 'F'));
  const adults = (await coach.get(`/api/tests/${id}?age=adult`)).data.board;
  assert.equal(adults.length, 0);
  // archived athletes are left out
  db.run('UPDATE athletes SET archived=1 WHERE id=?', d.board[0].athlete_id);
  assert.ok(!(await coach.get(`/api/tests/${id}`)).data.board.some((b) => b.athlete_id === d.board[0].athlete_id));
  db.run('UPDATE athletes SET archived=0 WHERE id=?', d.board[0].athlete_id);
  assert.equal((await coach.get('/api/tests/99999')).status, 404);
});

test('adding a test validates attempts, unit, stopwatch and protocol', async () => {
  assert.equal((await desk.post('/api/tests', { name: 'Desk test', unit: 'reps' })).status, 403);
  assert.equal((await coach.post('/api/tests', { name: 'Bad attempts', unit: 'reps', attempts: 12 })).status, 400);
  assert.equal((await coach.post('/api/tests', { name: 'Timed reps', unit: 'reps', timed: true })).status, 400);
  assert.equal((await coach.post('/api/tests', { name: 'Long', unit: 'reps', description: 'x'.repeat(1001) })).status, 400);
  assert.equal((await coach.post('/api/tests', { name: '40-YARD DASH', unit: 's' })).status, 400);
  const r = await coach.post('/api/tests', { name: 'Sled sprint 20 yd', category: 'Speed', unit: 's', lower_better: '1', attempts: '2', timed: true, min_value: '2', max_value: '12', description: 'Sled at 25% body weight.' });
  assert.equal(r.status, 200);
  assert.equal(r.data.custom, 1);
  assert.equal(r.data.timed, 1);
  assert.equal(r.data.description, 'Sled at 25% body weight.');
  assert.equal(lastLog().action, 'Added test');
});

test('editing: built-in tests keep name, unit and scoring; range and protocol can change', async () => {
  const id = testId('Vertical jump');
  assert.equal((await desk.patch(`/api/tests/${id}`, { max_value: 50 })).status, 403);
  assert.equal((await coach.patch(`/api/tests/${id}`, { name: 'Vert' })).status, 400);
  assert.equal((await coach.patch(`/api/tests/${id}`, { unit: 'cm' })).status, 400);
  assert.equal((await coach.patch(`/api/tests/${id}`, { lower_better: 1 })).status, 400);
  assert.equal((await coach.patch(`/api/tests/${id}`, { min_value: 60, max_value: 10 })).status, 400);
  const ok = await coach.patch(`/api/tests/${id}`, { name: 'Vertical jump', max_value: 52, attempts: 4, description: 'Vertec, best of four.' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.max_value, 52);
  assert.equal(ok.data.attempts, 4);
  assert.equal(ok.data.description, 'Vertec, best of four.');
  assert.equal(lastLog().action, 'Edited test');
  assert.match(lastLog().detail, /range/);
  // Clearing the protocol text back to the built-in one stores null again
  const builtIn = require('../server/services/testing-library').PROTOCOLS['Vertical jump'];
  const back = await coach.patch(`/api/tests/${id}`, { description: builtIn });
  assert.equal(back.data.description, builtIn);
  assert.equal(db.get('SELECT description FROM tests WHERE id=?', id).description, null);
  // hide/show still works and is logged as before
  assert.equal((await coach.patch(`/api/tests/${id}`, { hidden: true })).data.hidden, 1);
  assert.equal(lastLog().action, 'Hid test');
  await coach.patch(`/api/tests/${id}`, { hidden: false });
});

test('editing a custom test: rename follows into presets; unit and scoring lock once it has results', async () => {
  const t = (await coach.post('/api/tests', { name: 'Box jump height', category: 'Power', unit: 'in', attempts: 2 })).data;
  const p = await coach.post('/api/testing/presets', { name: 'Jumps', test_ids: [t.id, testId('Vertical jump')] });
  assert.equal(p.status, 200);
  const r = await coach.patch(`/api/tests/${t.id}`, { name: 'Box jump', unit: 'cm' });
  assert.equal(r.status, 200);
  assert.equal(r.data.unit, 'cm');
  assert.deepEqual(JSON.parse(db.get("SELECT value FROM settings WHERE key='presets'").value).Jumps, ['Box jump', 'Vertical jump']);
  const ava = athlete('Ava');
  db.insert('results', { athlete_id: ava.id, test_id: t.id, value: 50, source: 'manual' });
  assert.equal((await coach.patch(`/api/tests/${t.id}`, { unit: 'in' })).status, 400);
  assert.equal((await coach.patch(`/api/tests/${t.id}`, { lower_better: 1 })).status, 400);
  assert.equal((await coach.patch(`/api/tests/${t.id}`, { category: 'Plyometrics', attempts: 3 })).status, 200);
  // a timed test that changes unit away from seconds drops the stopwatch
  const s = (await coach.post('/api/tests', { name: 'Wall sit', unit: 's', timed: true })).data;
  const s2 = await coach.patch(`/api/tests/${s.id}`, { unit: 'min' });
  assert.equal(s2.data.timed, 0);
});

test('deleting: only unused custom tests, and they leave presets', async () => {
  assert.equal((await coach.del(`/api/tests/${testId('T-test')}`)).status, 400);
  const used = testId('Box jump');
  assert.equal((await coach.del(`/api/tests/${used}`)).status, 400);
  const t = (await coach.post('/api/tests', { name: 'Throwaway', unit: 'reps' })).data;
  await coach.post('/api/testing/presets', { name: 'Temp', test_ids: [t.id, testId('Pull-ups')] });
  assert.equal((await coach.get(`/api/tests/${t.id}`)).data.deletable, true);
  assert.equal((await desk.del(`/api/tests/${t.id}`)).status, 403);
  assert.equal((await coach.del(`/api/tests/${t.id}`)).status, 200);
  assert.ok(!db.get('SELECT 1 FROM tests WHERE id=?', t.id));
  const temp = (await coach.get('/api/testing/presets')).data.find((p) => p.name === 'Temp');
  assert.deepEqual(temp.tests.map((x) => x.name), ['Pull-ups']);
  assert.equal(lastLog().action, 'Deleted test');
  // a test on a testing day can't be deleted
  const onDay = (await coach.post('/api/tests', { name: 'Day only', unit: 'reps' })).data;
  const day = db.get('SELECT id FROM testing_days LIMIT 1').id;
  db.run('INSERT INTO testing_day_tests (day_id, test_id, ord) VALUES (?,?,99)', day, onDay.id);
  assert.equal((await coach.del(`/api/tests/${onDay.id}`)).status, 400);
});

test('presets: create, rename in place, reorder, validate and delete (owners and coaches only)', async () => {
  assert.equal((await desk.get('/api/testing/presets')).status, 200);
  assert.equal((await desk.post('/api/testing/presets', { name: 'Desk', test_ids: [1] })).status, 403);
  assert.equal((await coach.post('/api/testing/presets', { name: '', test_ids: [1] })).status, 400);
  assert.equal((await coach.post('/api/testing/presets', { name: 'Empty', test_ids: [] })).status, 400);
  assert.equal((await coach.post('/api/testing/presets', { name: 'Ghost', test_ids: [999999] })).status, 400);
  assert.equal((await coach.post('/api/testing/presets', { name: 'combine', test_ids: [1] })).status, 400, 'names are unique ignoring case');
  const ids = [testId('60-yard dash'), testId('Exit velocity'), testId('Pop time')];
  assert.equal((await coach.post('/api/testing/presets', { name: 'Spring baseball', test_ids: ids })).status, 200);
  assert.equal(lastLog().action, 'Added preset');
  const names = () => Object.keys(JSON.parse(db.get("SELECT value FROM settings WHERE key='presets'").value));
  const pos = names().indexOf('Baseball');
  const put = await owner.put('/api/testing/presets/Baseball', { name: 'High school baseball', test_ids: [...ids].reverse() });
  assert.equal(put.status, 200);
  assert.equal(names().indexOf('High school baseball'), pos, 'rename keeps its place');
  const hs = (await coach.get('/api/testing/presets')).data.find((p) => p.name === 'High school baseball');
  assert.deepEqual(hs.tests.map((t) => t.name), ['Pop time', 'Exit velocity', '60-yard dash']);
  // New testing day options carry the change
  const o = (await coach.get('/api/testing/options')).data;
  assert.ok(o.presets['High school baseball'] && !o.presets.Baseball);
  assert.equal((await coach.put('/api/testing/presets/Nope', { name: 'X', test_ids: ids })).status, 404);
  assert.equal((await desk.del('/api/testing/presets/Temp')).status, 403);
  assert.equal((await coach.del('/api/testing/presets/Temp')).status, 200);
  assert.equal((await coach.del('/api/testing/presets/Temp')).status, 404);
});

test('sheet download with no presets left explains instead of failing', async () => {
  const saved = db.get("SELECT value FROM settings WHERE key='presets'").value;
  db.setSetting('presets', {});
  const team = db.get('SELECT id FROM team_contracts LIMIT 1');
  const r = await coach.get(`/api/testing/sheet?team_id=${team.id}&format=csv`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no presets/i);
  db.setSetting('presets', JSON.parse(saved));
});

test('report: coach view marks unshared tests; family preview and periods', async () => {
  const nate = athlete('Nate');
  const c = (await coach.get(`/api/report/${nate.code}`)).data;
  assert.equal(c.view, 'coach');
  assert.equal(c.can_share, true);
  assert.ok(c.unshared);
  assert.ok(c.tests.some((t) => t.unshared), 'unshared tests are flagged');
  assert.ok(c.all_days.length >= 3);
  const fam = (await coach.get(`/api/report/${nate.code}?view=family`)).data;
  assert.equal(fam.view, 'family');
  assert.equal(fam.preview, true);
  assert.equal(fam.unshared, false);
  assert.ok(!fam.tests.some((t) => t.unshared));
  assert.ok(fam.all_days.every((d) => d.status === 'shared'));
  const kurt = await parent('kurt.jensen@example.com');
  const theirs = (await kurt.get(`/api/report/${nate.code}`)).data;
  assert.deepEqual(fam.tests.map((t) => [t.name, t.latest]), theirs.tests.map((t) => [t.name, t.latest]));
  // desk sees the coach view but can't share
  assert.equal((await desk.get(`/api/report/${nate.code}`)).data.can_share, false);
  // period
  const fall = db.get("SELECT date FROM testing_days WHERE name='Fall combine'").date;
  const since = (await coach.get(`/api/report/${nate.code}?from=${fall}`)).data;
  assert.ok(since.tests.every((t) => t.history.every((h) => h.date >= fall)));
  assert.ok(since.days.every((d) => d.date >= fall));
  assert.ok(since.all_days.length > since.days.length);
  assert.equal(since.period.from, fall);
  assert.equal((await coach.get(`/api/report/${nate.code}?from=2026-13-40`)).status, 400);
  assert.equal((await coach.get(`/api/report/${nate.code}?from=2026-09-01&to=2026-01-01`)).status, 400);
});

test('share links: owners, coaches and the family make them; anyone with one sees the family view', async () => {
  const ava = athlete('Ava'), nate = athlete('Nate');
  // the demo has one working link for Ava; start clean
  const demo = db.get('SELECT * FROM report_links WHERE athlete_id=?', ava.id);
  assert.equal(demo.label, 'BYU recruiting');
  assert.equal((await client().get(`/api/report/${ava.code}?link=${demo.token}`)).data.view, 'link');
  db.run("UPDATE report_links SET revoked_at=datetime('now') WHERE athlete_id=?", ava.id);
  assert.equal((await client().post(`/api/report/${ava.code}/links`, { days: 30 })).status, 401);
  assert.equal((await desk.post(`/api/report/${ava.code}/links`, { days: 30 })).status, 403);
  assert.equal((await desk.get(`/api/report/${ava.code}/links`)).status, 403);
  assert.equal((await coach.post(`/api/report/${ava.code}/links`, { days: 3 })).status, 400);
  const l = await coach.post(`/api/report/${ava.code}/links`, { days: 30, label: 'BYU recruiting' });
  assert.equal(l.status, 200);
  assert.match(l.data.url, new RegExp(`/report/${ava.code}\\?link=`));
  assert.equal(lastLog().action, 'Shared progress report link');
  // Anyone with the link
  const anon = client();
  const v = await anon.get(`/api/report/${ava.code}?link=${l.data.token}`);
  assert.equal(v.status, 200);
  assert.equal(v.data.view, 'link');
  assert.equal(v.data.athlete.birthday, undefined, 'no date of birth on a shared link');
  assert.equal(v.data.unshared, false);
  assert.ok(!v.data.can_share);
  assert.equal(db.get('SELECT views FROM report_links WHERE id=?', l.data.id).views, 1);
  // The token only opens its own athlete
  assert.equal((await anon.get(`/api/report/${nate.code}?link=${l.data.token}`)).status, 410);
  assert.equal((await anon.get(`/api/report/${ava.code}?link=nope`)).status, 410);
  assert.equal((await anon.get(`/api/report/${ava.code}`)).status, 401);
  // Parents: their own athlete only
  const maria = await parent('maria.lopez@example.com');
  assert.equal((await maria.get(`/api/report/${ava.code}`)).data.can_share, true);
  const mine = await maria.post(`/api/report/${ava.code}/links`, { days: 7 });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.created_by, 'Maria Lopez (parent)');
  assert.equal((await maria.post(`/api/report/${nate.code}/links`, { days: 7 })).status, 404);
  assert.equal((await maria.get(`/api/report/${ava.code}/links`)).data.length, 2);
  // A parent of another family can still open a link they were sent
  const kurt = await parent('kurt.jensen@example.com');
  assert.equal((await kurt.get(`/api/report/${ava.code}?link=${l.data.token}`)).data.view, 'link');
  // Turn off
  assert.equal((await maria.del(`/api/report/${ava.code}/links/${l.data.id}`)).status, 200);
  assert.equal(lastLog().action, 'Turned off progress report link');
  assert.equal((await anon.get(`/api/report/${ava.code}?link=${l.data.token}`)).status, 410);
  assert.equal((await coach.get(`/api/report/${ava.code}/links`)).data.length, 1);
  assert.equal((await coach.del(`/api/report/${ava.code}/links/999999`)).status, 404);
  // Expired links stop working
  db.run("UPDATE report_links SET expires_at=datetime('now','-1 minute') WHERE id=?", mine.data.id);
  assert.equal((await anon.get(`/api/report/${ava.code}?link=${mine.data.token}`)).status, 410);
  assert.equal((await coach.get(`/api/report/${ava.code}/links`)).data.length, 0);
  // At most 10 working links per athlete
  for (let i = 0; i < 10; i++) assert.equal((await coach.post(`/api/report/${ava.code}/links`, { days: 7 })).status, 200);
  assert.equal((await coach.post(`/api/report/${ava.code}/links`, { days: 7 })).status, 400);
  // Archived athletes' links stop working
  const any = db.get('SELECT token FROM report_links WHERE athlete_id=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1', ava.id).token;
  db.run('UPDATE athletes SET archived=1 WHERE id=?', ava.id);
  assert.equal((await anon.get(`/api/report/${ava.code}?link=${any}`)).status, 410);
  db.run('UPDATE athletes SET archived=0 WHERE id=?', ava.id);
});

test('email the report to the family (owners and coaches)', async () => {
  const nate = athlete('Nate');
  assert.equal((await desk.post(`/api/report/${nate.code}/email`, {})).status, 403);
  const before = db.get('SELECT COUNT(*) n FROM outbox').n;
  const r = await coach.post(`/api/report/${nate.code}/email`, { note: 'Great work on the jumps.' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.to, ['kurt.jensen@example.com']);
  assert.equal(r.data.unshared, true);
  assert.equal(db.get('SELECT COUNT(*) n FROM outbox').n, before + 1);
  const mail = db.get('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  assert.equal(mail.subject, "Nate's progress report");
  assert.match(mail.body, /Great work on the jumps\./);
  assert.match(mail.body, new RegExp(`/report/${nate.code}\\n`));
  assert.match(mail.body, /Sign in with this email address/);
  assert.equal(lastLog().action, 'Emailed progress report');
  // with a link that opens without signing in
  const withLink = await owner.post(`/api/report/${nate.code}/email`, { include_link: true });
  assert.equal(withLink.status, 200);
  const mail2 = db.get('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  const token = mail2.body.match(/link=([\w-]+)/)[1];
  assert.equal(db.get('SELECT label FROM report_links WHERE token=?', token).label, 'Emailed to family');
  // no parent email / no results the family can see
  const walkIn = athlete('Tyler');
  assert.equal((await coach.post(`/api/report/${walkIn.code}/email`, {})).status, 400);
  const daniel = athlete('Daniel');
  const noRes = await coach.post(`/api/report/${daniel.code}/email`, {});
  assert.equal(noRes.status, 400);
  assert.match(noRes.data.error, /no results/);
  assert.equal((await coach.post(`/api/report/${nate.code}/email`, { note: 'x'.repeat(2001) })).status, 400);
});
