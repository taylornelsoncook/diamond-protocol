// Outside data (schema 47): an athlete's numbers from a wearable or another app, brought in by staff (Settings → Data
// import) or a parent (the portal) from a CSV, an Excel file, a Google Sheets link or a text-based PDF. WHOOP exports are
// recognized; other tables are mapped by hand. All or nothing, problems by row and column, undo, and who may do what.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { writeXlsx } from '../src/services/xlsx.js';
import { pdfTable } from '../src/services/pdftext.js';
import { sheetCsvUrl, dayOf } from '../src/services/dataimport.js';

let app, base, owner, coach, desk, ava, ben, maria;
const PW = 'correct-horse-battery';
async function call(cookie, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
}
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (m, p, b) => call(cookie, m, p, b);
}
async function parent(email) {
  const { body } = await call(null, 'POST', '/portal/api/login', { email });
  const v = await fetch(base + '/portal/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: body.dev_code }) });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  return (m, p, b) => call(cookie, m, p, b);
}
const db = () => app.ctx.db;
const values = (clientId, metric) => db().all('SELECT day, value FROM athlete_metrics WHERE client_id = ? AND metric = ? ORDER BY day', clientId, metric);

// A few days of each WHOOP export, newest first like the real ones.
const CYCLES = `Cycle start time,Cycle end time,Cycle timezone,Recovery score %,Resting heart rate (bpm),Heart rate variability (ms),Skin temp (celsius),Blood oxygen %,Day Strain,Energy burned (cal),Max HR (bpm),Average HR (bpm),Sleep onset,Wake onset,Sleep performance %,Respiratory rate (rpm),Asleep duration (min),In bed duration (min),Light sleep duration (min),Deep (SWS) duration (min),REM duration (min),Awake duration (min),Sleep need (min),Sleep debt (min),Sleep efficiency %,Sleep consistency %
2026-09-26 21:37:59,,UTC-06:00,62,51,67,32.67,96.30,,,,,2026-09-26 21:37:59,2026-09-27 06:30:37,76,17.0,413,532,237,72,104,119,544,59,77,86
2026-09-25 22:02:56,2026-09-26 21:37:59,UTC-06:00,72,50,70,32.73,92.25,14.0,2462,159,70,2026-09-25 22:02:56,2026-09-26 05:42:01,88,17.2,419,459,191,99,129,40,511,30,91,87
2026-09-24 22:30:00,2026-09-25 22:02:56,UTC-06:00,48,55,58,32.80,95.10,16.2,2710,171,74,2026-09-24 22:30:00,2026-09-25 06:10:00,70,0.0,390,470,200,80,110,80,520,70,83,80
`;
const SLEEPS = `Cycle start time,Cycle end time,Cycle timezone,Sleep onset,Wake onset,Sleep performance %,Respiratory rate (rpm),Asleep duration (min),In bed duration (min),Light sleep duration (min),Deep (SWS) duration (min),REM duration (min),Awake duration (min),Sleep need (min),Sleep debt (min),Sleep efficiency %,Sleep consistency %,Nap
2026-09-26 21:37:59,,UTC-06:00,2026-09-26 21:37:59,2026-09-27 06:30:37,76,17.0,425,532,237,72,104,119,544,59,77,86,false
2026-09-25 22:02:56,2026-09-26 21:37:59,UTC-06:00,2026-09-26 14:00:00,2026-09-26 14:40:00,40,16.0,35,40,20,5,10,5,0,0,88,0,true
`;
const WORKOUTS = `Cycle start time,Cycle end time,Cycle timezone,Workout start time,Workout end time,Duration (min),Activity name,Activity Strain,Energy burned (cal),Max HR (bpm),Average HR (bpm),HR Zone 1 %,HR Zone 2 %,HR Zone 3 %,HR Zone 4 %,HR Zone 5 %,GPS enabled
2026-09-26 21:37:59,,UTC-06:00,2026-09-27 10:32:00,2026-09-27 10:46:59,14,Soccer,1.4,21.0,100,80,0,0,0,0,0,false
2026-09-25 22:02:56,2026-09-26 21:37:59,UTC-06:00,2026-09-26 17:41:00,2026-09-26 18:14:59,33,Activity,6.5,219.0,159,116,79,12,1,0,0,false
`;
const csv = (name, text) => ({ file: { name, csv: text } });

// A small text PDF: one line of text per row, each cell placed with Tm. compress: Flate the content stream.
function makePdf(rows, { compress = false, title = 'Weekly readiness' } = {}) {
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);
  const ops = [`BT /F1 14 Tf 1 0 0 1 50 800 Tm (${esc(title)}) Tj ET`, 'BT /F1 10 Tf',
    ...rows.flatMap((cells, i) => cells.map((c, j) => `1 0 0 1 ${50 + j * 130} ${760 - i * 16} Tm (${esc(c)}) Tj`)), 'ET',
    'BT /F1 8 Tf 1 0 0 1 280 30 Tm (Page 1) Tj ET'].join('\n');
  const content = compress ? deflateSync(Buffer.from(ops, 'latin1')) : Buffer.from(ops, 'latin1');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  objs.forEach((o, i) => parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')));
  parts.push(Buffer.from(`5 0 obj\n<< /Length ${content.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  maria = await parent('maria@example.com');
});
after(() => app.server.close());

test('readers: dates, Google Sheets links and text PDFs (plain and compressed)', () => {
  assert.equal(dayOf('2026-09-27 06:30:37'), '2026-09-27');
  assert.equal(dayOf('9/7/2026'), '2026-09-07');
  assert.equal(dayOf('27.09.2026'), '2026-09-27');
  assert.equal(dayOf('46292'), '2026-09-27', 'an Excel day number');
  assert.equal(dayOf('2026-02-30'), undefined);
  assert.equal(dayOf('soon'), undefined);
  assert.equal(sheetCsvUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=42'), 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv&gid=42');
  for (const bad of ['http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/', 'https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'not a link']) {
    assert.throws(() => sheetCsvUrl(bad), /Google Sheets link/, bad);
  }
  const rows = [['Date', 'Recovery %', 'HRV (ms)'], ['2026-09-01', '71', '64'], ['2026-09-02', '55', '58'], ['2026-09-03', '80', '70']];
  for (const compress of [false, true]) {
    const t = pdfTable(makePdf(rows, { compress }));
    assert.deepEqual(t.headers, ['Date', 'Recovery %', 'HRV (ms)'], `compress ${compress}`);
    assert.deepEqual(t.rows.map((r) => [r.Date, r['Recovery %'], r['HRV (ms)']]), rows.slice(1));
    assert.equal(t.ignored_lines, 2, 'the title and the page number');
  }
  assert.throws(() => pdfTable(Buffer.from('hello')), /isn't a PDF/);
  assert.throws(() => pdfTable(makePdf([])), /no table/);
});

test('WHOOP cycles, sleeps and workouts are recognized, checked and saved; a re-import replaces days, undo puts them back', async () => {
  const p = (await coach('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('physiological_cycles.csv', CYCLES) })).body;
  assert.equal(p.format, 'whoop_cycles');
  assert.deepEqual([p.days, p.from, p.to, p.problem_count, p.ready], [3, '2026-09-25', '2026-09-27', 0, true]);
  assert.ok(p.notes.some((n) => /device didn't measure it/.test(n)), 'a 0.0 respiratory rate is "not measured", not an error');
  assert.equal(db().get('SELECT COUNT(*) AS n FROM athlete_metrics').n, 0, 'a preview saves nothing');
  const saved = await coach('POST', '/v1/data-imports', { client_id: ava.id, ...csv('physiological_cycles.csv', CYCLES) });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(values(ava.id, 'recovery_pct'), [{ day: '2026-09-25', value: 48 }, { day: '2026-09-26', value: 72 }, { day: '2026-09-27', value: 62 }], 'the day is the morning they woke up');
  assert.equal(values(ava.id, 'resp_rate').length, 2);
  // Sleeps: the nap is left out; the night's sleep replaces the cycle file's value for that day.
  const s = (await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('sleeps.csv', SLEEPS) })).body;
  assert.equal(s.format, 'whoop_sleeps');
  assert.ok(s.notes.some((n) => /nap was left out/.test(n)));
  assert.equal(s.replaced, 1, 'the asleep minutes changed from 413 to 425');
  const sleepImport = (await owner('POST', '/v1/data-imports', { client_id: ava.id, ...csv('sleeps.csv', SLEEPS) })).body;
  assert.equal(values(ava.id, 'sleep_min').find((x) => x.day === '2026-09-27').value, 425);
  // Workouts.
  const w = (await owner('POST', '/v1/data-imports', { client_id: ava.id, ...csv('workouts.csv', WORKOUTS) })).body;
  assert.deepEqual([w.format, w.workouts, w.new_workouts], ['whoop_workouts', 2, 2]);
  const again = (await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('workouts.csv', WORKOUTS) })).body;
  assert.equal(again.new_workouts, 0, 'the same workouts again are updates, not new ones');
  // What staff see.
  const d = (await desk('GET', `/v1/clients/${ava.id}/outside-data`)).body;
  assert.equal(d.has_data, true);
  const rec = d.metrics.find((m) => m.key === 'recovery_pct');
  assert.deepEqual([rec.latest, rec.avg_7, rec.headline, rec.series.length], [{ day: '2026-09-27', value: 62 }, 60.7, true, 3]);
  assert.equal(d.workouts[0].activity, 'Soccer');
  assert.equal(d.workouts[0].started_at, '2026-09-27T16:32:00.000Z', 'local time in UTC-06:00');
  // Undo the sleeps import: its values go and the cycle file's value it replaced comes back.
  const u = (await owner('POST', `/v1/data-imports/${sleepImport.id}/undo`)).body;
  assert.ok(u.removed_values > 0);
  assert.equal(values(ava.id, 'sleep_min').find((x) => x.day === '2026-09-27').value, 413);
  assert.equal((await owner('POST', `/v1/data-imports/${sleepImport.id}/undo`)).status, 409);
  const list = (await owner('GET', `/v1/data-imports?client_id=${ava.id}`)).body.data;
  assert.equal(list.length, 3);
  assert.ok(list.find((x) => x.id === sleepImport.id).undone_at);
});

test('another table is mapped by hand; every problem is listed by row and column and nothing saves until it\'s clean', async () => {
  const bad = 'Date,Jump height (in),Soreness\n2026-09-01,21.5,3\n2026-09-02,twenty,4\nnot a day,22,2\n';
  const p = (await owner('POST', '/v1/data-imports/preview', { client_id: ben.id, ...csv('jumps.csv', bad) })).body;
  assert.deepEqual([p.format, p.needs_mapping, p.ready], ['custom', true, false]);
  assert.equal(p.suggestion.date_column, 'Date');
  assert.deepEqual(p.suggestion.metrics.map((m) => [m.column, m.label, m.unit]), [['Soreness', 'Soreness', '']], 'Jump height has a word in it, so it isn\'t suggested');
  const mapping = { date_column: 'Date', metrics: [{ column: 'Jump height (in)', label: 'Jump height', unit: 'in' }, { column: 'Soreness', label: 'Soreness', unit: '' }] };
  const checked = (await owner('POST', '/v1/data-imports/preview', { client_id: ben.id, ...csv('jumps.csv', bad), mapping })).body;
  assert.deepEqual(checked.problems.map((x) => [x.row, x.column]), [[3, 'Jump height (in)'], [4, 'Date']]);
  const refused = await owner('POST', '/v1/data-imports', { client_id: ben.id, ...csv('jumps.csv', bad), mapping });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.details.problem_count, 2);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM athlete_metrics WHERE client_id = ?', ben.id).n, 0, 'nothing saved');
  const good = 'Date,Jump height (in),Soreness\n2026-09-01,21.5,3\n2026-09-02,22.0,4\n';
  const saved = (await owner('POST', '/v1/data-imports', { client_id: ben.id, ...csv('jumps.csv', good), mapping })).body;
  assert.equal(saved.days, 2);
  const m = (await owner('GET', `/v1/clients/${ben.id}/outside-data`)).body.metrics.find((x) => x.key === 'custom:jump_height');
  assert.deepEqual([m.label, m.unit, m.latest.value, m.custom], ['Jump height', 'in', 22, true]);
  assert.equal((await owner('POST', '/v1/data-imports/preview', { client_id: ben.id, ...csv('jumps.csv', good), mapping: { date_column: 'Date', metrics: [{ column: 'Soreness', label: 'X' }, { column: 'Jump height (in)', label: 'x' }] } })).status, 400, 'two columns with the same name');
});

test('Excel files, PDFs and Google Sheets links come in the same way', async () => {
  const xlsx = writeXlsx([{ name: 'Data', rows: [['Date', 'Readiness'], ['2026-09-10', 7], ['2026-09-11', 8]] }]).toString('base64');
  const mapping = { date_column: 'Date', metrics: [{ column: 'Readiness', label: 'Readiness', unit: '/10' }] };
  const x = await owner('POST', '/v1/data-imports', { client_id: ben.id, file: { name: 'r.xlsx', xlsx_base64: xlsx }, mapping });
  assert.equal(x.status, 201, JSON.stringify(x.body));
  assert.equal(x.body.file_kind, 'xlsx');
  const pdf = makePdf([['Date', 'Recovery %', 'HRV (ms)'], ['2026-09-12', '71', '64'], ['2026-09-13', '55', '58']], { compress: true }).toString('base64');
  const p = (await owner('POST', '/v1/data-imports/preview', { client_id: ben.id, file: { name: 'report.pdf', pdf_base64: pdf } })).body;
  assert.deepEqual([p.file_kind, p.needs_mapping, p.suggestion.date_column], ['pdf', true, 'Date']);
  assert.ok(p.notes.some((n) => /outside the table/.test(n)));
  const scan = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n').toString('base64');
  const s = await owner('POST', '/v1/data-imports/preview', { client_id: ben.id, file: { name: 'scan.pdf', pdf_base64: scan } });
  assert.equal(s.status, 400);
  assert.match(s.body.error.message, /no text we can read/);
  // Google Sheets: fetched from Google's export address (stubbed here).
  const asked = [];
  app.ctx.fetchSheet = async (url) => { asked.push(url); return new Response('Date,Steps\n2026-09-14,9000\n', { headers: { 'content-type': 'text/csv' } }); };
  const g = await owner('POST', '/v1/data-imports', { client_id: ben.id, sheet_url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit', mapping: { date_column: 'Date', metrics: [{ column: 'Steps', label: 'Steps' }] } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.deepEqual([g.body.file_kind, asked[0]], ['sheet', 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv']);
  app.ctx.fetchSheet = async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } });
  const priv = await owner('POST', '/v1/data-imports/preview', { client_id: ben.id, sheet_url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit' });
  assert.equal(priv.status, 400);
  assert.match(priv.body.error.message, /Anyone with the link/);
  delete app.ctx.fetchSheet;
});

test('who may: owners and coaches import, front desk looks; parents import and undo their own athlete\'s files', async () => {
  assert.equal((await desk('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('c.csv', CYCLES) })).status, 403);
  assert.equal((await desk('GET', `/v1/clients/${ava.id}/outside-data`)).status, 200);
  // A parent brings in a file for their own athlete, sees it, and can undo it.
  const p = await maria('POST', `/portal/api/athletes/${ava.id}/data-imports`, csv('workouts.csv', WORKOUTS));
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const seen = (await maria('GET', `/portal/api/athletes/${ava.id}/outside-data`)).body;
  assert.equal(seen.has_data, true);
  const mine = seen.recent.find((x) => x.id === p.body.id);
  assert.equal(mine.created_by_kind, 'parent');
  const staffImport = seen.recent.find((x) => x.created_by_kind === 'staff' && !x.undone_at);
  assert.equal((await maria('POST', `/portal/api/data-imports/${staffImport.id}/undo`)).status, 409, 'a coach\'s import is the coach\'s to undo');
  assert.equal((await maria('POST', `/portal/api/data-imports/${p.body.id}/undo`)).status, 200);
  // Never another family's athlete.
  assert.equal((await maria('POST', `/portal/api/athletes/${ben.id}/data-imports/preview`, csv('c.csv', CYCLES))).status, 404);
  const benImport = db().get('SELECT id FROM data_imports WHERE client_id = ? LIMIT 1', ben.id).id;
  assert.equal((await maria('POST', `/portal/api/data-imports/${benImport}/undo`)).status, 404);
  assert.equal((await maria('GET', `/portal/api/athletes/${ben.id}/outside-data`)).status, 404);
  // The athlete sees theirs in the app.
  const tok = db().get('SELECT access_token FROM clients WHERE id = ?', ava.id).access_token;
  const app1 = await fetch(`${base}/app/api/outside-data`, { headers: { 'x-client-token': tok } });
  assert.equal((await app1.json()).has_data, true);
});

test('an archived athlete takes no imports; the family export has the data and deleting the family removes it', async () => {
  const c = (await owner('POST', '/v1/clients', { name: 'Cal Gone', parent: { name: 'Gwen Gone', email: 'gwen@example.com' } })).body;
  await owner('POST', '/v1/data-imports', { client_id: c.id, ...csv('c.csv', CYCLES) });
  const fam = db().get('SELECT family_id FROM clients WHERE id = ?', c.id).family_id;
  const exp = (await owner('GET', `/v1/families/${fam}/export`)).text;
  assert.match(exp, /outside_data/);
  assert.match(exp, /recovery_pct/);
  await owner('POST', `/v1/clients/${c.id}/archive`, { confirm: true });
  assert.equal((await owner('POST', '/v1/data-imports/preview', { client_id: c.id, ...csv('c.csv', CYCLES) })).status, 409);
  await owner('POST', `/v1/clients/${c.id}/restore`);
  const del = await owner('DELETE', `/v1/families/${fam}`, { confirm: 'Gone family' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  for (const t of ['athlete_metrics', 'athlete_workouts', 'data_imports']) assert.equal(db().get(`SELECT COUNT(*) AS n FROM ${t} WHERE client_id = ?`, c.id).n, 0, t);
});

test('undo puts back what an import replaced, and a parent\'s undo never takes out the coach\'s data', async () => {
  const grip = (rows) => ({ ...csv('grip.csv', `Date,Grip (kg)\n${rows.map(([d, x]) => `${d},${x}`).join('\n')}\n`), mapping: { date_column: 'Date', metrics: [{ column: 'Grip (kg)', label: 'Grip', unit: 'kg' }] } });
  const now = () => Object.fromEntries(values(ava.id, 'custom:grip').map((r) => [r.day, r.value]));
  const A = await coach('POST', '/v1/data-imports', { client_id: ava.id, ...grip([['2025-01-01', 40], ['2025-01-02', 41], ['2025-01-03', 42]]) });
  assert.equal(A.status, 201, A.text);
  const B = await maria('POST', `/portal/api/athletes/${ava.id}/data-imports`, grip([['2025-01-02', 41], ['2025-01-03', 50], ['2025-01-04', 44]]));
  assert.equal(B.status, 201, B.text);
  const C = await owner('POST', '/v1/data-imports', { client_id: ava.id, ...grip([['2025-01-03', 60]]) });
  assert.deepEqual(now(), { '2025-01-01': 40, '2025-01-02': 41, '2025-01-03': 60, '2025-01-04': 44 });
  assert.equal((await maria('POST', `/portal/api/data-imports/${A.body.id}/undo`)).status, 409, 'not the coach\'s import');
  assert.equal((await maria('POST', `/portal/api/data-imports/${B.body.id}/undo`)).status, 200);
  assert.deepEqual(now(), { '2025-01-01': 40, '2025-01-02': 41, '2025-01-03': 60 }, 'the coach\'s days stay; only the parent\'s new day goes');
  assert.equal((await owner('POST', `/v1/data-imports/${C.body.id}/undo`)).status, 200);
  assert.deepEqual(now(), { '2025-01-01': 40, '2025-01-02': 41, '2025-01-03': 42 }, 'back to the coach\'s value, skipping the undone import');
  assert.equal((await coach('POST', `/v1/data-imports/${A.body.id}/undo`)).status, 200);
  assert.deepEqual(now(), {});
  assert.equal(db().get('SELECT COUNT(*) AS n FROM data_import_replaced').n, 0);
});

test('odd input gets a clear answer: decimal commas, bad formats and mappings, heavy or unusual PDFs', async () => {
  const p = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('eu.csv', 'Date,Weight (kg),Steps\n2025-02-01,"65,3","12,345"\n2025-02-02,"1,2,3",9000\n'), mapping: { date_column: 'Date', metrics: [{ column: 'Weight (kg)' }, { column: 'Steps' }] } });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.body.problem_count, 1, 'only "1,2,3" is refused');
  assert.equal(p.body.problems[0].row, 3);
  for (const format of ['__proto__', 'constructor', 'toString']) {
    const r = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, format, ...csv('cycles.csv', CYCLES) });
    assert.equal(r.status, 200, `${format}: ${r.text}`);
    assert.equal(r.body.format, 'whoop_cycles');
  }
  const m = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('x.csv', 'Date,A\n2025-01-01,1\n'), mapping: { date_column: 'Date', metrics: [null] } });
  assert.equal(m.status, 400, m.text);
  // A stream length given as a reference (/Length 12 0 R) is found by its endstream.
  const rows = [['Date', 'Recovery %'], ['2026-09-01', '71'], ['2026-09-02', '55']];
  const pdf = makePdf(rows).toString('latin1').replace(/\/Length \d+/, '/Length 12 0 R');
  assert.deepEqual(pdfTable(Buffer.from(pdf, 'latin1')).rows.map((r) => r.Date), ['2026-09-01', '2026-09-02']);
  // Small files that would unpack to far too much, or ask for millions of font entries, are refused quickly.
  const bomb = deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 });
  const bombPdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), bomb, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
  let t = Date.now();
  assert.throws(() => pdfTable(bombPdf), /too large or complex/);
  const cmap = `beginbfrange\n${'<0000><FFFF><0000>\n'.repeat(2000)}endbfrange`;
  const cmapPdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Page /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>\nendobj\n3 0 obj\n<< /Type /Font /ToUnicode 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n5 0 obj\n<< /Length 30 >>\nstream\nBT /F1 10 Tf (hi) Tj ET\nendstream\nendobj\n%%EOF\n`, 'latin1');
  assert.throws(() => pdfTable(cmapPdf), /too large or complex/);
  const objstm = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /ObjStm /N 300000000 /First 4 /Length 8 >>\nstream\n1 0 2 0\nendstream\nendobj\n%%EOF\n', 'latin1');
  assert.throws(() => pdfTable(objstm), /no text/);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test('a version 46 database gains the outside-data tables, opened twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v46.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 46');
    old.exec(`INSERT INTO clients (id, name, access_token, created_at) VALUES ('cli_1', 'Ava', 'tok', '2026-09-01T00:00:00Z')`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 69, `round ${round}`);
      for (const t of ['data_imports', 'athlete_metrics', 'athlete_workouts']) assert.ok(d.all(`PRAGMA table_info(${t})`).length, t);
      assert.equal(d.get(`SELECT name FROM clients WHERE id = 'cli_1'`).name, 'Ava');
      d.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
