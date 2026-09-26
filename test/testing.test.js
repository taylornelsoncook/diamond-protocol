// Testing & results API: entry, PRs, uploads (all or nothing), pending links, API ingest, visibility.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-testing-'));
process.env.DP_DB = path.join(dir, 'test.db');
process.env.DP_DATA_DIR = dir;

const { app } = require('../server/index.js');
const seed = require('../server/seed.js');
const db = require('../server/db');
const { sha256 } = require('../server/lib');
const sheet = require('../server/services/testing-sheet');
const core = require('../server/services/testing-core');

let server, base;
function client() {
  const jar = {};
  async function call(method, p, body, headers = {}) {
    const h = { ...headers };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : ct.includes('spreadsheet') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return { get: (p, hd) => call('GET', p, undefined, hd), post: (p, b, hd) => call('POST', p, b ?? {}, hd), put: (p, b) => call('PUT', p, b ?? {}), patch: (p, b) => call('PATCH', p, b ?? {}), del: (p) => call('DELETE', p) };
}
async function staff(email, pw) { const c = client(); const r = await c.post('/api/auth/staff/login', { email, password: pw }); assert.equal(r.status, 200); return c; }
async function parent(email) {
  const c = client();
  const r = await c.post('/api/auth/parent/code', { email });
  await c.post('/api/auth/parent/verify', { email, code: r.data.test_code });
  return c;
}
const athlete = (first) => db.get('SELECT * FROM athletes WHERE first_name=?', first);
const testId = (name) => db.get('SELECT id FROM tests WHERE name=?', name).id;
const count = (sql, ...p) => db.get(sql, ...p).n;

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

test('demo data: days, results and five waiting results', async () => {
  const r = await coach.get('/api/testing');
  assert.equal(r.status, 200);
  assert.equal(r.data.days.length, 3);
  assert.ok(r.data.days.some((d) => d.status === 'shared' && d.note));
  assert.ok(r.data.days.some((d) => d.status === 'open'));
  assert.equal(r.data.pending.count, 5);
  assert.equal(r.data.pending.senders, 2);
});

test('units and formatting', () => {
  assert.equal(core.fmtValue(77, 'in'), '6′ 5″');
  assert.equal(core.fmtValue(5.9, 's'), '5.90 s');
  assert.equal(core.parseEntry("6' 5\"", 'in'), 77);
  assert.equal(Math.round(core.convert(200, 'cm', 'in') * 100) / 100, 78.74);
  assert.equal(core.convert(1, 's', 'in'), null);
  const g = core.growthEstimate({ sex: 'M', age: 13, height_cm: 160, seated_cm: 82, weight_kg: 48 });
  assert.ok(g.maturity_offset > -2 && g.maturity_offset < 1, JSON.stringify(g));
});

let dayId;
test('new testing day with a team brings the whole roster; front desk cannot create one', async () => {
  const team = db.get("SELECT id FROM team_contracts WHERE team_name='Summit Elite 16U'");
  const ava = athlete('Ava');
  const refused = await desk.post('/api/testing/days', { name: 'X', date: '2026-10-01', test_ids: [testId('40-yard dash')] });
  assert.equal(refused.status, 403);
  const r = await coach.post('/api/testing/days', { name: 'Test day', date: '2026-10-01', team_id: team.id, athlete_ids: [ava.id],
    test_ids: [testId('40-yard dash'), testId('Standing broad jump'), testId('Vertical jump')] });
  assert.equal(r.status, 200);
  dayId = r.data.id;
  const d = await desk.get(`/api/testing/days/${dayId}`);
  assert.equal(d.status, 200);
  assert.equal(d.data.athletes.length, count('SELECT COUNT(*) n FROM athletes WHERE team_id=?', team.id) + 1);
  assert.equal(d.data.tests.length, 3);
});

test('stopwatch and typed saves, units, range warning and PR detection', async () => {
  const ava = athlete('Ava');
  const t40 = testId('40-yard dash'), tbj = testId('Standing broad jump');
  const prevBest = db.get('SELECT MIN(value) v FROM results WHERE athlete_id=? AND test_id=?', ava.id, t40).v;
  // Stopwatch (front desk can enter results): hand-timed, and a PR when faster than before.
  const sw = await desk.put(`/api/testing/days/${dayId}/results`, { athlete_id: ava.id, test_id: t40, attempt: 1, value: prevBest - 0.1, source: 'stopwatch' });
  assert.equal(sw.status, 200, JSON.stringify(sw.data));
  assert.equal(sw.data.result.hand_timed, 1);
  assert.equal(sw.data.result.source, 'stopwatch');
  assert.equal(sw.data.pr, true);
  // Slower second attempt is not a PR
  const slow = await coach.put(`/api/testing/days/${dayId}/results`, { athlete_id: ava.id, test_id: t40, attempt: 2, value: prevBest + 0.3 });
  assert.equal(slow.data.pr, false);
  // Typing again into the same box replaces it (no duplicate rows)
  await coach.put(`/api/testing/days/${dayId}/results`, { athlete_id: ava.id, test_id: t40, attempt: 2, value: prevBest + 0.2 });
  assert.equal(count('SELECT COUNT(*) n FROM results WHERE day_id=? AND athlete_id=? AND test_id=?', dayId, ava.id, t40), 2);
  // Typed in cm: stored in inches, unit_entered kept
  const cm = await coach.put(`/api/testing/days/${dayId}/results`, { athlete_id: ava.id, test_id: tbj, attempt: 1, value: '200', unit: 'cm' });
  assert.equal(cm.status, 200);
  assert.equal(cm.data.result.unit_entered, 'cm');
  assert.ok(Math.abs(cm.data.result.value - 78.74) < 0.01);
  assert.equal(cm.data.pr, true); // better than 77
  // Out of range is refused with a clear message
  const bad = await coach.put(`/api/testing/days/${dayId}/results`, { athlete_id: ava.id, test_id: t40, attempt: 1, value: 101 });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /isn't possible for 40-yard dash/);
  // Clearing a box deletes the attempt
  await coach.put(`/api/testing/days/${dayId}/results`, { athlete_id: ava.id, test_id: t40, attempt: 2, value: '' });
  assert.equal(count('SELECT COUNT(*) n FROM results WHERE day_id=? AND athlete_id=? AND test_id=?', dayId, ava.id, t40), 1);
  // PR logged in activity
  assert.ok(db.get("SELECT 1 FROM activity WHERE action='New PR' AND detail LIKE 'Ava Lopez, Standing broad jump%'"));
});

test('walk-ups can be added', async () => {
  const kevin = athlete('Kevin');
  const r = await desk.post(`/api/testing/days/${dayId}/athletes`, { athlete_id: kevin.id });
  assert.equal(r.status, 200);
  assert.ok(db.get('SELECT 1 FROM testing_day_athletes WHERE day_id=? AND athlete_id=?', dayId, kevin.id));
});

test('sheet download has Athlete IDs and a column per test and attempt (CSV and XLSX)', async () => {
  const csv = await coach.get(`/api/testing/sheet?day_id=${dayId}`);
  assert.equal(csv.status, 200);
  const rows = sheet.parseCSV(csv.data);
  assert.deepEqual(rows[0].slice(0, 3), ['Athlete ID', 'Name', '40-yard dash (s) #1']);
  assert.ok(rows.some((r) => r[0] === athlete('Ava').code));
  const x = await coach.get(`/api/testing/sheet?day_id=${dayId}&format=xlsx`);
  assert.equal(x.status, 200);
  const back = sheet.fromXLSX(x.data);
  assert.deepEqual(back[0], rows[0]);
  const preset = await coach.get('/api/testing/sheet?preset=Youth');
  assert.match(sheet.parseCSV(preset.data)[0].join(','), /Seated height \(in\) #1/);
});

function tsv(rows) { return rows.map((r) => r.join('\t')).join('\n'); }

test('upload with mistakes is rejected and nothing is saved', async () => {
  const ava = athlete('Ava'), nate = athlete('Nate'), emma = athlete('Emma');
  const before = count('SELECT COUNT(*) n FROM results');
  const text = tsv([
    ['Athlete ID', 'Name', '40-yard dash (s) #1', 'Vertical jump (in) #1'],
    [ava.code, 'Nate Jensen', '6.1', '15'], // ID belongs to someone else
    [nate.code, 'Nate Jensen', '101', ''], // broad jump typed in the 40 column
    [emma.code, 'Emma Jensen', '', 'fast'], // not a number
    ['NOPE2026', 'Nobody', '6.0', ''], // unknown ID
    ['', 'Walk Up', '6.2', ''], // no ID
  ]);
  const r = await coach.post('/api/testing/upload/check', { text, day_id: dayId });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false);
  const probs = r.data.problems;
  assert.equal(probs.length, 5, JSON.stringify(probs));
  assert.match(probs[0].problem, new RegExp(`${ava.code} is Ava Lopez, but this row says "Nate Jensen"`));
  assert.equal(probs[0].row, 2);
  assert.match(probs[1].problem, /isn't possible for 40-yard dash/);
  assert.equal(probs[1].column, '40-yard dash (s) #1');
  assert.match(probs[2].problem, /"fast" isn't a number/);
  assert.match(probs[3].problem, /No athlete has the ID NOPE2026/);
  assert.match(probs[4].problem, /no Athlete ID/);
  // save refuses too
  const s = await coach.post('/api/testing/upload/save', { text, day_id: dayId });
  assert.equal(s.status, 400);
  assert.equal(count('SELECT COUNT(*) n FROM results'), before);
  // unknown column
  const r2 = await coach.post('/api/testing/upload/check', { text: tsv([['Athlete ID', 'Name', 'Bogus test #1'], [ava.code, 'Ava Lopez', '5']]), day_id: dayId });
  assert.equal(r2.data.ok, false);
  assert.match(r2.data.problems[0].problem, /doesn't match a test/);
});

test('clean upload: review, confirm unusual values, save once, re-upload never double-counts', async () => {
  const ava = athlete('Ava'), nate = athlete('Nate');
  const natesBest = db.get("SELECT MAX(value) v FROM results WHERE athlete_id=? AND test_id=?", nate.id, testId('Vertical jump')).v;
  const csv = sheet.toCSV([
    ['Athlete ID', 'Name', '40-yard dash (s) #1', '40-yard dash (s) #2', 'Vertical jump (in) #1'],
    [ava.code, 'Ava Lopez', '6.05', '6.00', '17'],
    [nate.code, 'Nate', '', '', String(Math.round(natesBest * 1.3))], // far better than best → unusual
  ]);
  const b64 = Buffer.from(csv).toString('base64');
  const c = await coach.post('/api/testing/upload/check', { file_base64: b64, filename: 'fall.csv', day_id: dayId });
  assert.equal(c.data.ok, true, JSON.stringify(c.data.problems));
  assert.equal(c.data.count, 4);
  assert.equal(c.data.athletes.length, 2);
  assert.equal(c.data.unusual.length, 1);
  assert.match(c.data.unusual[0].message, /far better than Nate Jensen's best Vertical jump/);
  // Saving without the tick is refused
  const no = await coach.post('/api/testing/upload/save', { file_base64: b64, filename: 'fall.csv', day_id: dayId });
  assert.equal(no.status, 400);
  const before = count('SELECT COUNT(*) n FROM results WHERE day_id=?', dayId);
  const ok = await coach.post('/api/testing/upload/save', { file_base64: b64, filename: 'fall.csv', day_id: dayId, confirmed: [c.data.unusual[0].key] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.saved, 4);
  const after = count('SELECT COUNT(*) n FROM results WHERE day_id=?', dayId);
  // Ava's 40 #1 already existed (stopwatch) and was replaced; three new rows.
  assert.equal(after, before + 3);
  const again = await coach.post('/api/testing/upload/save', { file_base64: b64, filename: 'fall.csv', day_id: dayId, confirmed: [c.data.unusual[0].key] });
  assert.equal(again.status, 200);
  assert.equal(count('SELECT COUNT(*) n FROM results WHERE day_id=?', dayId), after);
  assert.equal(db.get('SELECT source FROM results WHERE day_id=? AND athlete_id=? AND test_id=? AND attempt=2', dayId, ava.id, testId('40-yard dash')).source, 'upload');
});

test('upload without a testing day uses the date and still never double-counts; xlsx uploads work', async () => {
  const emma = athlete('Emma');
  const rows = [['Athlete ID', 'Name', 'Pull-ups (reps) #1'], [emma.code, 'Emma Jensen', '6']];
  const b64 = sheet.toXLSX(rows).toString('base64');
  const body = { file_base64: b64, filename: 'pullups.xlsx', date: '2026-09-01' };
  const c = await coach.post('/api/testing/upload/check', body);
  assert.equal(c.data.ok, true, JSON.stringify(c.data));
  await coach.post('/api/testing/upload/save', body);
  await coach.post('/api/testing/upload/save', body);
  assert.equal(count('SELECT COUNT(*) n FROM results WHERE athlete_id=? AND test_id=?', emma.id, testId('Pull-ups')), 1);
});

test('device export: known IDs save, unknown senders wait to be linked', async () => {
  const kevin = athlete('Kevin');
  const text = tsv([['Athlete', 'Athlete ID', 'Test', 'Value', 'Date'], ['Kevin Nguyen', kevin.code, 'Vertical jump', '24', '2026-09-20'], ['Coley P', '', 'Vertical jump', '22.5', '2026-09-20']]);
  const c = await coach.post('/api/testing/upload/check', { text, filename: 'ovr-export.csv' });
  assert.equal(c.data.ok, true, JSON.stringify(c.data));
  assert.equal(c.data.source, 'OVR');
  assert.equal(c.data.count, 1);
  assert.equal(c.data.pending.length, 1);
  const pBefore = count('SELECT COUNT(*) n FROM pending_results');
  await coach.post('/api/testing/upload/save', { text, filename: 'ovr-export.csv' });
  await coach.post('/api/testing/upload/save', { text, filename: 'ovr-export.csv' });
  assert.equal(count('SELECT COUNT(*) n FROM pending_results'), pBefore + 1);
  assert.equal(count("SELECT COUNT(*) n FROM results WHERE athlete_id=? AND source='upload' AND value=24", kevin.id), 1);
});

test('waiting results: suggestions, link with Remember, then new results go straight in', async () => {
  const groups = (await coach.get('/api/testing/pending')).data;
  const olivia = athlete('Olivia');
  const g = groups.find((x) => x.sender_key === 'Olivia P');
  assert.ok(g);
  assert.equal(g.results.length, 3);
  assert.equal(g.suggestions[0].id, olivia.id);
  // Untick one result: link two, discard later
  const keep = g.results.slice(0, 2).map((r) => r.id);
  const r = await coach.post('/api/testing/pending/link', { ids: keep, athlete_id: olivia.id, remember: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.linked, 2);
  assert.ok(db.get("SELECT 1 FROM device_links WHERE source='OVR' AND sender_key='Olivia P' AND athlete_id=?", olivia.id));
  assert.equal(count("SELECT COUNT(*) n FROM pending_results WHERE sender_key='Olivia P'"), 1);
  const d = await coach.post('/api/testing/pending/discard', { ids: [g.results[2].id] });
  assert.equal(d.data.discarded, 1);
  // A new OVR export row from the same sender now goes straight to Olivia
  const text = tsv([['Name', 'Test', 'Value', 'Date'], ['Olivia P', 'Vertical jump', '20.5', '2026-09-25']]);
  const c = await coach.post('/api/testing/upload/check', { text, filename: 'OVR history.csv' });
  assert.equal(c.data.count, 1);
  assert.equal(c.data.athletes[0].id, olivia.id);
  // Devices page lists the link; Unlink removes it
  const dev = await coach.get('/api/testing/devices');
  const link = dev.data.links.find((l) => l.sender_key === 'Olivia P');
  assert.ok(link);
  assert.equal(dev.data.hawkin.connected, false);
  assert.equal((await coach.del(`/api/testing/links/${link.id}`)).status, 200);
  // front desk can't see the queue
  assert.equal((await desk.get('/api/testing/pending')).status, 403);
});

test('open API: API key required, known athletes save, linked devices save, others pend, duplicates ignored', async () => {
  const key = 'dp_test_' + Date.now();
  db.insert('api_keys', { label: 'Timing gates', key_hash: sha256(key), last4: key.slice(-4) });
  const auth = { authorization: `Bearer ${key}` };
  const none = await client().post('/api/v1/results', { test: '40-yard dash', value: 5 });
  assert.equal(none.status, 401);
  const ava = athlete('Ava');
  const c = client();
  const r = await c.post('/api/v1/results', [
    { athlete_code: ava.code, source: 'gates', test: '40-yard dash', value: 5.8, ref: 'run-1' },
    { device_id: 'GATE-9', device_name: 'Lane 3', source: 'gates', test: '10-yard sprint', value: 1.9, ref: 'run-2' },
    { athlete_id: ava.id, source: 'gates', test: 'Vertical jump', value: 45, unit: 'cm', ref: 'run-3' },
  ], auth);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.saved, 2);
  assert.equal(r.data.pending, 1);
  const cmRow = db.get("SELECT * FROM results WHERE source_ref='api:gates:run-3'");
  assert.ok(Math.abs(cmRow.value - 17.72) < 0.01);
  assert.equal(cmRow.source, 'api');
  // resend: all duplicates
  const again = await c.post('/api/v1/results', { athlete_code: ava.code, source: 'gates', test: '40-yard dash', value: 5.8, ref: 'run-1' }, auth);
  assert.equal(again.data.duplicates, 1);
  assert.equal(again.data.saved, 0);
  // invalid → nothing saved
  const bad = await c.post('/api/v1/results', [{ athlete_code: ava.code, source: 'gates', test: '40-yard dash', value: 5.7, ref: 'run-4' }, { source: 'gates', test: 'Nope', value: 1 }], auth);
  assert.equal(bad.status, 400);
  assert.ok(!db.get("SELECT 1 FROM results WHERE source_ref='api:gates:run-4'"));
  // link the device with remember, then next result goes straight in
  const p = db.get("SELECT id FROM pending_results WHERE sender_key='GATE-9'");
  await coach.post('/api/testing/pending/link', { ids: [p.id], athlete_id: ava.id, remember: true });
  const next = await c.post('/api/v1/results', { device_id: 'GATE-9', source: 'gates', test: '10-yard sprint', value: 1.85, ref: 'run-5' }, auth);
  assert.equal(next.data.saved, 1);
});

test('test library: hide, add custom, front desk view-only', async () => {
  const lib = await desk.get('/api/tests?all=1');
  assert.ok(lib.data.length >= 78);
  const tid = testId('Beep test');
  assert.equal((await desk.patch(`/api/tests/${tid}`, { hidden: true })).status, 403);
  assert.equal((await coach.patch(`/api/tests/${tid}`, { hidden: true })).data.hidden, 1);
  assert.ok(!(await coach.get('/api/tests')).data.some((t) => t.id === tid));
  const add = await coach.post('/api/tests', { name: 'Med ball slam', category: 'Power', unit: 'reps', lower_better: false, attempts: 1, min_value: 0, max_value: 100 });
  assert.equal(add.status, 200);
  assert.equal(add.data.custom, 1);
  assert.equal((await coach.post('/api/tests', { name: 'Med ball slam', unit: 'reps' })).status, 400);
});

test('progress: staff sees unshared, parents see only shared (or everything when immediate)', async () => {
  const nate = athlete('Nate'), ava = athlete('Ava');
  const openDay = db.get("SELECT id FROM testing_days WHERE name='October youth testing'").id;
  const staffP = await coach.get(`/api/athletes/${nate.id}/progress`);
  assert.equal(staffP.status, 200);
  assert.equal(staffP.data.unshared, true);
  const maria = await parent('maria.lopez@example.com');
  // Maria can't see Nate (another family)
  assert.equal((await maria.get(`/api/parent/athletes/${nate.id}/progress`)).status, 404);
  const kurt = await parent('kurt.jensen@example.com');
  const pp = await kurt.get(`/api/parent/athletes/${nate.id}/progress`);
  assert.equal(pp.status, 200);
  assert.equal(pp.data.unshared, false);
  const openVals = db.all('SELECT value, test_id FROM results WHERE day_id=? AND athlete_id=?', openDay, nate.id);
  assert.ok(openVals.length > 0);
  const parentDates = pp.data.tests.flatMap((t) => t.history.map((h) => h.date));
  const openDate = db.get('SELECT date FROM testing_days WHERE id=?', openDay).date;
  assert.ok(!parentDates.includes(openDate));
  assert.ok(staffP.data.tests.some((t) => t.history.some((h) => h.date === openDate)));
  // shape
  const a = (await maria.get(`/api/parent/athletes/${ava.id}/progress`)).data;
  for (const k of ['athlete', 'note', 'improvements', 'prs', 'tests', 'growth', 'unshared']) assert.ok(k in a, k);
  assert.equal(a.note.day_name, 'Fall combine');
  assert.ok(a.improvements[0].pct > 0);
  assert.ok(a.growth && a.growth.status && typeof a.growth.maturity_offset === 'number');
  // Results with no testing day (API/devices) are visible to parents
  assert.ok(a.tests.find((t) => t.name === '10-yard sprint'));
  // immediate: everything shows
  db.setSetting('results_visibility', 'immediate');
  const imm = await kurt.get(`/api/parent/athletes/${nate.id}/progress`);
  assert.ok(imm.data.tests.flatMap((t) => t.history.map((h) => h.date)).includes(openDate));
  db.setSetting('results_visibility', 'shared');
  // report endpoint by code
  assert.equal((await client().get(`/api/report/${ava.code}`)).status, 401);
  assert.equal((await maria.get(`/api/report/${ava.code}`)).data.view, 'parent');
  assert.equal((await coach.get(`/api/report/${ava.code}`)).data.view, 'coach');
  assert.equal((await maria.get(`/api/report/${nate.code}`)).status, 404);
});

test('share with parents: status shared, families emailed, webhooks fire', async () => {
  db.insert('webhooks', { url: 'http://127.0.0.1:9/hook', events: JSON.stringify(['result.created', 'pr.set']), secret: 's' });
  const openDay = db.get("SELECT id FROM testing_days WHERE name='October youth testing'").id;
  const outBefore = count('SELECT COUNT(*) n FROM outbox');
  assert.equal((await desk.post(`/api/testing/days/${openDay}/share`, { note: 'x' })).status, 403);
  const r = await coach.post(`/api/testing/days/${openDay}/share`, { note: 'Strong day. Keep sprinting.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.emails >= 3);
  const day = db.get('SELECT * FROM testing_days WHERE id=?', openDay);
  assert.equal(day.status, 'shared');
  assert.equal(day.note, 'Strong day. Keep sprinting.');
  assert.ok(count('SELECT COUNT(*) n FROM outbox') >= outBefore + 3);
  const mail = db.get("SELECT * FROM outbox WHERE to_email='kurt.jensen@example.com' ORDER BY id DESC LIMIT 1");
  assert.match(mail.body, /\/parent/);
  assert.match(mail.body, /Strong day/);
  assert.ok(count("SELECT COUNT(*) n FROM webhook_deliveries WHERE event='result.created'") > 0);
  // Parent now sees it and the new note
  const kurt = await parent('kurt.jensen@example.com');
  const p = await kurt.get(`/api/parent/athletes/${athlete('Nate').id}/progress`);
  assert.equal(p.data.note.text, 'Strong day. Keep sprinting.');
});
