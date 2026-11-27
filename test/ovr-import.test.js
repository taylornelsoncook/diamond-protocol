import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { writeXlsx } from '../src/services/xlsx.js';
import { lookAlikes } from '../src/services/ovr.js';

// An OVR Connect export laid out like the owner's real one (November 2026): a sheet per product, a row per rep or
// split, the athlete only by name.
const H = { base: ['Athlete', 'Sport', 'Position', 'Group(s)', 'Date', 'Time', 'Exercise'] };
const jumpHead = [...H.base, 'Set #', 'Rep #', 'GCT (s)', 'Jump Height (in)', 'Jump Type', 'RSI', 'Set Note'];
const sprintHead = [...H.base, 'Sprint #', 'Split #', 'Distance (yd)', 'In-Beam Start', 'Speed (mph)', 'Split Time (s)', 'Total Time (s)', 'Trigger Start', 'Set Note'];
const velHead = [...H.base, 'Set #', 'Rep #', 'Avg Power (W)', 'Avg Velocity (m/s)', 'Duration (s)', 'EA Index', 'Load (lb)', 'Peak Power (W)', 'Peak Velocity (m/s)', 'ROM (in)', 'Target Max', 'Target Min', 'Target Type', 'TPV (s)', 'Set Note'];
function workbook({ extraSprint = [] } = {}) {
  const jump = [jumpHead,
    ['Addie Vali', '', '', 'Kings 32', '2026-11-23', '14:53', 'Countermovement Jump (CMJ)', '1', '1', '', '14.9', 'Vertical', '', ''],
    ['Addie Vali', '', '', 'Kings 32', '2026-11-23', '14:54', 'Countermovement Jump (CMJ)', '1', '2', '', '15.6', 'Vertical', '', ''],
    ['Jordan Nytes', 'Soccer\t', 'Goalkeeper', '', '2026-11-23', '09:10', 'Depth Jump', '1', '1', '0.24', '19.5', 'RSI', '2.03', ''],
    ['Beau Terwillger', '', '', '', '2026-11-20', '10:00', 'Approach Jump', '1', '1', '', '22.1', 'Vertical', '', ''],
    ['Addie Vali', '', '', 'Kings 32', '2026-11-23', '14:55', 'Seated Jump', '1', '1', '', '20.5', 'Vertical', '', '']];
  const sprint = [sprintHead,
    ['Addie Vali', '', '', '', '2026-11-24', '10:30', '10yd Sprint', '1', '1', '10', 'Yes', '11.177', '1.83', '1.83', 'No', ''],
    ['Jordan Nytes', '', '', '', '2026-11-24', '10:40', 'Flying 10yd', '1', '1', '10', 'No', '14.548', '1.406', '1.406', 'No', ''],
    ['Beau Terwillger', '', '', '', '2026-11-24', '10:50', '40yd Sprint', '1', '1', '10', 'Yes', '12.1', '1.80', '1.80', 'No', ''],
    ['Beau Terwillger', '', '', '', '2026-11-24', '10:50', '40yd Sprint', '1', '2', '10', 'Yes', '15.2', '1.20', '3.00', 'No', ''],
    ['Beau Terwillger', '', '', '', '2026-11-24', '10:50', '40yd Sprint', '1', '3', '20', 'Yes', '16.4', '2.40', '5.40', 'No', ''],
    ...extraSprint];
  const vel = [velHead,
    ['Jordan Nytes', 'Soccer', 'Goalkeeper', '', '2026-11-23', '08:51', 'Back Squat', '1', '1', '474', '1.12', '0.69', '3.87', '95', '1399', '2.05', '30.5', '', '', 'off', '0.53', ''],
    ['Jordan Nytes', 'Soccer', 'Goalkeeper', '', '2026-11-23', '08:51', 'Back Squat', '1', '2', '464', '1.10', '0.71', '3.81', '95', '1452', '2.10', '30.7', '', '', 'off', '0.55', '']];
  return writeXlsx([{ name: 'Velocity', rows: vel }, { name: 'Jump', rows: jump }, { name: 'Sprint', rows: sprint }, { name: 'Force', rows: [[...H.base, 'Set #']] }]).toString('base64');
}

let app, base, owner, coach, desk, jordan, beau;
const login = async (email) => (await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) })).headers.get('set-cookie').split(';')[0];
const as = (cookie) => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const db = () => app.ctx.db;

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = as(await login('owner@test.dev')); coach = as(await login('coach@test.dev')); desk = as(await login('desk@test.dev'));
  jordan = (await owner('POST', '/v1/clients', { name: 'Jordan Nytes', email: 'jordan@example.com' })).body;
  beau = (await owner('POST', '/v1/clients', { name: 'Beau Terwilliger', email: 'beau@example.com' })).body;
});
after(() => app.server.close());

test('look-alike names: same, spelled a letter off, a short first name; never different people', () => {
  const everyone = [{ id: 'a', name: 'Beau Terwilliger', athlete_id: 'BEATER2026' }, { id: 'b', name: 'Benjamin Cross', athlete_id: 'BENCRO2026' }, { id: 'c', name: 'Wells Cross', athlete_id: 'WELCRO2026' }, { id: 'd', name: 'George O’Reilly', athlete_id: 'GEOORE2026' }];
  assert.deepEqual(lookAlikes(null, 'Beau Terwillger', everyone).map((x) => [x.client_id, x.why]), [['a', 'Spelled almost the same']]);
  assert.deepEqual(lookAlikes(null, 'Ben Cross', everyone).map((x) => x.client_id), ['b'], 'Ben is short for Benjamin; Wells Cross is someone else');
  assert.deepEqual(lookAlikes(null, "george oreilly", everyone).map((x) => x.why), ['Same name'], 'case, spacing and the apostrophe ignored');
  assert.deepEqual(lookAlikes(null, 'Addie Vali', everyone), []);
});

test('the preview lists every person and saves nothing', async () => {
  const before = db().get('SELECT COUNT(*) AS n FROM clients').n;
  const p = (await owner('POST', '/v1/imports/ovr/preview', { xlsx_base64: workbook(), filename: 'OVR Export.xlsx' })).body;
  assert.equal(p.preview, true);
  assert.deepEqual(p.counts, { people: 3, linked: 0, made: 1, chosen: 0, waiting: 2, to_check: 2 });
  const who = Object.fromEntries(p.people.map((x) => [x.name, x]));
  assert.equal(who['Addie Vali'].status, 'new'); assert.match(who['Addie Vali'].client.athlete_id, /^ADDVAL\d{4}$/, 'the Athlete ID it would get');
  assert.deepEqual(who['Addie Vali'].groups, ['Kings 32']);
  assert.equal(who['Jordan Nytes'].status, 'check'); assert.equal(who['Jordan Nytes'].look_alikes[0].client_id, jordan.id);
  assert.equal(who['Beau Terwillger'].look_alikes[0].why, 'Spelled almost the same');
  assert.equal(p.sets_found, 1, 'two rep rows make one bar-speed set');
  assert.deepEqual(p.left_out, [{ what: 'Jump: Seated Jump', rows: 1 }]);
  assert.equal(p.ready, false);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM clients').n, before, 'the preview made no profile');
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM perf_results WHERE source = 'csv:ovr'`).n, 0);
});

test('importing needs a choice for look-alikes and a yes to leave out impossible values; front desk can\'t', async () => {
  assert.equal((await desk('POST', '/v1/imports/ovr/preview', { xlsx_base64: workbook() })).status, 403);
  const bad = workbook({ extraSprint: [['Addie Vali', '', '', '', '2026-11-24', '10:35', '10yd Sprint', '2', '1', '10', 'Yes', '50', '0.31', '0.31', 'No', '']] });
  const r1 = await owner('POST', '/v1/imports/ovr', { xlsx_base64: bad });
  assert.equal(r1.status, 409); assert.equal(r1.body.error.code, 'impossible_values');
  assert.equal(r1.body.error.details.values[0].sheet, 'Sprint'); assert.equal(r1.body.error.details.values[0].row, 7);
  const r2 = await owner('POST', '/v1/imports/ovr', { xlsx_base64: workbook() });
  assert.equal(r2.status, 409); assert.equal(r2.body.error.code, 'people_to_check');
  assert.deepEqual(r2.body.error.details.people.map((x) => x.name).sort(), ['Beau Terwillger', 'Jordan Nytes']);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM clients WHERE created_by_import IS NOT NULL`).n, 0, 'nothing saved');
  assert.equal(await owner('POST', '/v1/imports/ovr', { xlsx_base64: 'bm90IGEgemlw' }).then((r) => r.status), 400);
});

let batchId, addie;
test('new people get a profile to finish; chosen names are linked; results, splits and bar speed land', async () => {
  const people = { 'name:jordan nytes': jordan.id, 'name:beau terwillger': beau.id };
  const r = await owner('POST', '/v1/imports/ovr', { xlsx_base64: workbook(), filename: 'OVR Export.xlsx', people });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  batchId = r.body.batch_id;
  assert.deepEqual(r.body.counts, { people: 3, linked: 0, made: 1, chosen: 2, waiting: 0, to_check: 0 });
  addie = r.body.people.find((x) => x.made).client;
  const c = (await owner('GET', `/v1/clients/${addie.client_id}`)).body;
  assert.equal(c.name, 'Addie Vali'); assert.equal(c.family, null); assert.equal(c.email, null);
  assert.equal(c.from_import.needs_finishing, true); assert.equal(c.from_import.source, 'OVR');
  assert.equal(c.flags.to_finish, true);
  assert.ok((await owner('GET', '/v1/clients?status=to_finish')).body.data.some((x) => x.id === addie.client_id));
  assert.equal((await owner('GET', '/v1/client-counts')).body.to_finish, 1);
  const res = (key) => db().all(`SELECT t.key, r.metric, r.value, r.attempt, r.client_id FROM perf_results r JOIN perf_tests t ON t.id = r.test_id WHERE r.source = 'csv:ovr' AND t.key = ? ORDER BY r.metric, r.attempt`, key);
  assert.deepEqual(res('cmj').map((x) => [x.value, x.attempt, x.client_id]), [[14.9, 1, addie.client_id], [15.6, 2, addie.client_id]], 'each rep is an attempt');
  assert.deepEqual(res('drop_jump').map((x) => [x.metric, x.value]), [['contact_time', 240], ['jump_height', 19.5], ['rsi', 2.03]], 'GCT seconds become milliseconds');
  assert.deepEqual(res('dash_40yd').map((x) => [x.metric, x.value]), [['split_10', 1.8], ['split_20', 3], ['time', 5.4]], 'splits folded into one 40');
  assert.equal(res('dash_40yd')[0].client_id, beau.id);
  assert.equal(res('flying_10yd')[0].value, 1.406);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM vbt_sets WHERE client_id = ?', jordan.id).n, 1, 'the owner brings bar speed in');
  // The names are remembered: the next export lands with no questions.
  const again = (await owner('POST', '/v1/imports/ovr', { xlsx_base64: workbook() })).body;
  assert.deepEqual([again.counts.linked, again.counts.made, again.saved], [3, 0, 0]);
  assert.ok(again.already_saved > 0);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM clients WHERE created_by_import IS NOT NULL').n, 1, 'no second profile');
  // Nothing is ever sent to a profile made this way.
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM outbox WHERE body LIKE '%Addie%' OR subject LIKE '%Addie%'`).n, 0);
});

test('a coach imports results but not bar speed', async () => {
  const p = (await coach('POST', '/v1/imports/ovr/preview', { xlsx_base64: workbook() })).body;
  assert.equal(p.bar_speed_sets, 0); assert.match(p.bar_speed_left_out, /owner/);
});

test('undo takes out the results, the bar speed and an untouched new profile; a profile filled in since stays', async () => {
  const u = (await owner('POST', `/v1/uploads/${batchId}/undo`)).body;
  assert.equal(u.profiles_removed, 1); assert.equal(u.bar_speed_removed, 1);
  assert.equal(db().get('SELECT id FROM clients WHERE id = ?', addie.client_id), undefined);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM perf_results WHERE source = 'csv:ovr'`).n, 0);
  assert.ok(db().get('SELECT id FROM clients WHERE id = ?', jordan.id), 'a chosen profile is never removed');
  // Again, and this time the coach starts finishing the profile before the undo.
  const r = (await owner('POST', '/v1/imports/ovr', { xlsx_base64: workbook() })).body;
  const made = r.people.find((x) => x.made).client;
  assert.equal(r.counts.linked, 2, 'Jordan and Beau still linked');
  await owner('PATCH', `/v1/clients/${made.client_id}`, { phone: '303-555-0100' });
  const u2 = (await owner('POST', `/v1/uploads/${r.batch_id}/undo`)).body;
  assert.deepEqual([u2.profiles_removed, u2.profiles_kept], [0, 1]);
  assert.match(u2.summary, /kept because it was filled in since/);
});

test('a version 99 database gains the import columns, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-ovr99-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v99.sql', import.meta.url), 'utf8'));
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cl_1', 'Ava Lopez', 'AVALOP2026', 'tok', '2026-09-01T00:00:00Z');`);
    old.exec('PRAGMA user_version = 99');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 100, `round ${round}`);
      assert.deepEqual({ ...d.get('SELECT name, created_by_import FROM clients') }, { name: 'Ava Lopez', created_by_import: null });
      assert.ok(d.all('PRAGMA table_info(import_batches)').some((c) => c.name === 'vbt_import_id'));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
