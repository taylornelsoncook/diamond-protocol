import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { baseAthleteId } from '../src/services/athlete-ids.js';
import { readXlsx, writeXlsx } from '../src/services/xlsx.js';

let app, base, cookie;
const year = String(new Date().getFullYear());
const req = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
let ava, ava2, cole, contract, jalen;

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const l = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'coach@test.dev', password: 'correct-horse-battery' }) });
  cookie = l.headers.get('set-cookie').split(';')[0];
});
after(() => app.server.close());

test('ID format: first 3 + last 3 letters + year, cleaned and padded', () => {
  assert.equal(baseAthleteId('Ava Lopez', 2026), 'AVALOP2026');
  assert.equal(baseAthleteId('José Núñez', 2026), 'JOSNUN2026');
  assert.equal(baseAthleteId('Maria De La Cruz', 2026), 'MARDEL2026');
  assert.equal(baseAthleteId("D'Andre O'Neal Jr.", 2026), 'DANONE2026');
  assert.equal(baseAthleteId('Bo Li', 2026), 'BOXLIX2026');
  assert.equal(baseAthleteId('Madonna', 2026), 'MADXXX2026');
});

test('every new client and roster athlete gets a unique, permanent ID', async () => {
  ava = (await req('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  assert.equal(ava.athlete_id, `AVALOP${year}`);
  ava2 = (await req('POST', '/v1/clients', { name: 'Ava Lopez', email: 'other.ava@example.com' })).body;
  assert.equal(ava2.athlete_id, `AVALOP${year}-2`, 'a second Ava Lopez this year');
  cole = (await req('POST', '/v1/clients', { name: 'Cole Park', email: 'cole@example.com' })).body;
  contract = (await req('POST', '/v1/team-contracts', { organization: { name: 'Westlake HS' }, name: 'Varsity', monthly_cents: 100000 })).body;
  const roster = (await req('POST', `/v1/team-contracts/${contract.id}/roster`, { names: 'Jalen Brooks\nCole Park' })).body.data;
  jalen = roster.find((r) => r.name === 'Jalen Brooks');
  assert.equal(jalen.athlete_id, `JALBRO${year}`);
  assert.equal(roster.find((r) => r.name === 'Cole Park').athlete_id, `COLPAR${year}-2`, 'IDs are unique across clients and team rosters');
  const renamed = (await req('PATCH', `/v1/clients/${ava.id}`, { name: 'Ava Lopez-Garcia' })).body;
  assert.equal(renamed.athlete_id, `AVALOP${year}`, 'name changes keep the ID');
  assert.equal((await req('GET', `/v1/clients?q=avalop${year}`)).body.data.length, 2, 'search by ID');
  assert.equal((await req('PATCH', `/v1/clients/${cole.id}`, { athlete_id: 'bad' })).status, 400);
  assert.equal((await req('PATCH', `/v1/clients/${cole.id}`, { athlete_id: `JALBRO${year}` })).status, 409);
  await req('PATCH', `/v1/clients/${ava.id}`, { name: 'Ava Lopez' });
});

test('the ID connects results from anywhere: API, devices, and the name field', async () => {
  const r = (await req('POST', '/v1/results', { results: [
    { athlete_id: `avalop${year}`, test: 'dash_40yd', value: 6.1, recorded_at: '2026-08-01' },
    { athlete: { external_id: `COLPAR${year}` }, test: 'broad_jump', value: 96, recorded_at: '2026-08-01' },
    { athlete: { name: `JALBRO${year}` }, test: 'vertical_standing', value: 25, recorded_at: '2026-08-01' },
    { athlete_id: 'NOPNOP2020', test: 'dash_40yd', value: 5 }
  ] })).body;
  assert.equal(r.created, 3);
  assert.equal(r.unmatched.length, 1);
  const res = (await req('GET', `/v1/results?test=dash_40yd`)).body.data;
  assert.equal(res[0].athlete_id, `AVALOP${year}`);
  assert.equal((await req('GET', `/v1/roster/${jalen.id}/performance`)).body.data[0].best, 25);
});

let session;
test('templates come pre-filled with athlete IDs, in Excel or CSV', async () => {
  session = (await req('POST', '/v1/testing-sessions', { name: 'Fall combine', date: '2026-10-01', tests: ['dash_40yd', 'pro_agility', 'broad_jump'], athletes: [{ client_id: ava.id }, { client_id: cole.id }, { roster_id: jalen.id }] })).body;
  const x = await req('GET', `/v1/uploads/template?session_id=${session.id}`);
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-disposition'), /fall-combine-template\.xlsx/);
  const rows = readXlsx(x.body);
  assert.deepEqual(rows[0], ['Athlete ID', 'Name', 'Date', '40-yard dash #1 (s)', '40-yard dash #2 (s)', '5-10-5 pro agility – Left #1 (s)', '5-10-5 pro agility – Left #2 (s)', '5-10-5 pro agility – Right #1 (s)', '5-10-5 pro agility – Right #2 (s)', 'Broad jump #1 (in)', 'Broad jump #2 (in)', 'Notes']);
  assert.deepEqual(rows.slice(1, 4).map((r) => [r[0], r[1], r[2]]), [[`AVALOP${year}`, 'Ava Lopez', '2026-10-01'], [`COLPAR${year}`, 'Cole Park', '2026-10-01'], [`JALBRO${year}`, 'Jalen Brooks', '2026-10-01']]);
  const csv = await req('GET', `/v1/uploads/template?tests=dash_40yd,vertical_standing&client_ids=${cole.id}&format=csv`);
  assert.match(csv.body.toString('utf8'), /^\uFEFFAthlete ID,Name,Date,40-yard dash #1 \(s\),40-yard dash #2 \(s\),Vertical jump #1 \(in\),Vertical jump #2 \(in\),Notes\r\nCOLPAR/);
  assert.equal((await req('GET', '/v1/uploads/template')).status, 400);
});

const count = async () => (await req('GET', '/v1/results?limit=5000')).body.data.length;
const upload = async (rows, extra = {}) => (await req('POST', '/v1/uploads/preview', { xlsx_base64: Buffer.from(writeXlsx([{ name: 'Results', rows }])).toString('base64'), filename: 'sheet.xlsx', ...extra })).body;
let header;

test('a correct sheet passes every check and saves all at once, after unusual values are confirmed', async () => {
  header = readXlsx((await req('GET', `/v1/uploads/template?session_id=${session.id}`)).body)[0];
  const col = (name) => header.indexOf(name);
  const row = (id, name, vals) => { const r = header.map(() => ''); r[0] = id; r[1] = name; for (const [k, v] of Object.entries(vals)) r[col(k)] = v; return r; };
  const rows = [header,
    row(`AVALOP${year}`, 'Ava Lopez', { '40-yard dash #1 (s)': 5.95, '40-yard dash #2 (s)': 5.9, '5-10-5 pro agility – Left #1 (s)': 5.1, 'Broad jump #1 (in)': `6'5"`, Notes: 'windy' }),
    row(`colpar${year}`, 'cole park', { '40-yard dash #1 (s)': 4.9, '40-yard dash #2 (s)': 3.9, 'Broad jump #1 (in)': 101 }),
    row(`JALBRO${year}`, '', { '40-yard dash #1 (s)': 4.62 }),
    row('', '', {})];
  const before = await count();
  const p = await upload(rows, { session_id: session.id });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.deepEqual(p.summary, { results: 8, athletes: 3, to_confirm: 1 });
  assert.match(p.warnings[0].message, /Cole Park's attempts don't agree: 4\.9 s then 3\.9 s/);
  assert.equal(p.athletes.find((a) => a.name === 'Ava Lopez').results.find((r) => r.test === 'broad_jump').value, 77, '6\'5" read as 77 inches');
  const noConfirm = await req('POST', '/v1/uploads/commit', { preview_id: p.preview_id });
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.body.error.code, 'confirmation_required');
  assert.equal(await count(), before, 'nothing saved until the unusual value is confirmed');
  const done = (await req('POST', '/v1/uploads/commit', { preview_id: p.preview_id, confirm: p.warnings.map((w) => w.key) })).body;
  assert.equal(done.saved, 8);
  assert.deepEqual(done.athletes.map((a) => [a.name, a.results]), [['Ava Lopez', 4], ['Cole Park', 3], ['Jalen Brooks', 1]]);
  assert.equal(await count(), before + 8);
  const saved = (await req('GET', `/v1/results?client_id=${ava.id}&session_id=${session.id}`)).body.data;
  assert.ok(saved.every((r) => r.recorded_at.startsWith('2026-10-01')));
  assert.equal(saved.find((r) => r.test === 'dash_40yd').notes, 'windy');
  assert.equal((await req('POST', '/v1/uploads/commit', { preview_id: p.preview_id })).status, 404, 'a checked upload saves once');
  const again = await upload(rows, { session_id: session.id });
  const re = (await req('POST', '/v1/uploads/commit', { preview_id: again.preview_id, confirm: again.warnings.map((w) => w.key) })).body;
  assert.deepEqual([re.saved, re.already_saved], [0, 8], 'the same sheet twice never double-counts');
});

test('one wrong cell anywhere blocks the whole upload, with every problem listed', async () => {
  const col = (name) => header.indexOf(name);
  const row = (id, name, vals, date = '') => { const r = [...header.map(() => ''), '']; r[0] = id; r[1] = name; r[2] = date; for (const [k, v] of Object.entries(vals)) r[k === 'Sit and reach (in)' ? header.length : col(k)] = v; return r; };
  const rows = [[...header, 'Sit and reach (in)'],
    row(`AVALOP${year}`, 'Ava Lopez', { '40-yard dash #1 (s)': 5.8 }, '2026-09-02'),                       // fine
    row('', 'Tyler Grant', { '40-yard dash #1 (s)': 5.1 }),                                                // no ID
    row('ZZZZZZ2026', 'Someone', { '40-yard dash #1 (s)': 5.1 }),                                          // unknown ID
    row(`AVALOP${year}`, 'Cole Park', { 'Broad jump #1 (in)': 90 }, '2026-09-03'),                         // ID and name disagree
    row(`COLPAR${year}`, 'Cole Park', { '40-yard dash #1 (s)': 101 }, '2026-09-03'),                        // broad jump typed in the 40 column
    row(`JALBRO${year}`, 'Jalen Brooks', { '40-yard dash #2 (s)': 'fast' }, '2026-09-03'),                  // not a number
    row(`AVALOP${year}`, 'Ava Lopez', { '40-yard dash #1 (s)': 5.7 }, '2026-09-02'),                       // same cell twice
    row(`JALBRO${year}`, 'Jalen Brooks', { 'Broad jump #1 (in)': 99 }, '2031-01-01'),                      // future date
    row(`COLPAR${year}`, 'Cole Park', { 'Sit and reach (in)': 14 }, '2026-09-03')];                        // unknown column
  const before = await count();
  const p = await upload(rows);
  assert.equal(p.ok, false);
  assert.deepEqual(p.athletes, [], 'nothing is shown as ready to save');
  const msgs = p.errors.map((e) => `${e.row ?? '-'}|${e.column ?? '-'}|${e.message}`);
  const has = (re) => assert.ok(msgs.some((m) => re.test(m)), `${re} in\n${msgs.join('\n')}`);
  has(/^1\|Sit and reach \(in\)\|"Sit and reach \(in\)" isn't a test column/);
  assert.equal(p.error_count, 1, 'a bad column stops the check before rows are read');
  const rows2 = rows.map((r) => r.slice(0, header.length)).filter((r, i) => i !== rows.length - 1);
  const p2 = await upload(rows2);
  assert.equal(p2.ok, false);
  const m2 = p2.errors.map((e) => `${e.row}|${e.column}|${e.message}`);
  const has2 = (re) => assert.ok(m2.some((m) => re.test(m)), `${re} in\n${m2.join('\n')}`);
  has2(/^3\|Athlete ID\|This row has results but no Athlete ID/);
  has2(/^4\|Athlete ID\|No athlete has the ID ZZZZZZ2026/);
  has2(new RegExp(`^5\\|Name\\|AVALOP${year} is Ava Lopez, but this row says "Cole Park"`));
  has2(/^6\|40-yard dash #1 \(s\)\|101 s isn't possible for 40-yard dash \(3\.8–12 s\)\. Is it in the wrong column\?/);
  has2(/^7\|40-yard dash #2 \(s\)\|"fast" isn't a number/);
  has2(/^8\|40-yard dash #1 \(s\)\|Entered twice for Ava Lopez on 2026-09-02 \(also row 2\)/);
  has2(/^9\|Date\|2031-01-01 is in the future/);
  assert.equal(p2.error_count, 7);
  const c = await req('POST', '/v1/uploads/commit', { preview_id: p2.preview_id });
  assert.equal(c.status, 409);
  assert.equal(c.body.error.code, 'upload_rejected');
  assert.equal(c.body.error.details.length, 7);
  assert.equal(await count(), before, 'the good row was not saved either');
});

test('sheets without an Athlete ID column are refused; device exports can carry the ID as the name', async () => {
  const noIds = (await req('POST', '/v1/uploads/preview', { csv: 'Athlete,Date,40 Yard\nCole Park,2026-09-05,4.9' })).body;
  assert.equal(noIds.ok, false);
  assert.match(noIds.errors[0].message, /No athlete has the ID|isn't an Athlete ID/);
  const noCol = (await req('POST', '/v1/uploads/preview', { csv: 'Date,40 Yard\n2026-09-05,4.9' })).body;
  assert.match(noCol.errors[0].message, /needs an "Athlete ID" column/);
  const ovr = (await req('POST', '/v1/uploads/preview', { csv: `Date,Athlete,Jump Height (in),GCT (ms),RSI\n2026-09-03,COLPAR${year},15.2,176,2.2\n2026-09-03,AVALOP${year},12.1,205,1.6`, test: 'hop_10_5' })).body;
  assert.equal(ovr.ok, true, JSON.stringify(ovr.errors));
  assert.equal(ovr.summary.results, 6);
  const metric = (await req('POST', '/v1/uploads/preview', { csv: `Athlete ID,Date,Vertical (cm)\nCOLPAR${year},2026-09-05,71.12` })).body;
  assert.equal(metric.athletes[0].results[0].value.toFixed(1), '28.0', 'cm converted to inches, then range-checked');
});

test('the sheet is checked again at save time', async () => {
  const p = (await req('POST', '/v1/uploads/preview', { csv: `Athlete ID,Name,Date,Broad jump #1 (in)\nCOLPAR${year},Cole Park,2026-09-06,102` })).body;
  assert.equal(p.ok, true);
  await req('PATCH', `/v1/clients/${cole.id}`, { athlete_id: `COLPAR${year}-9` });
  const c = await req('POST', '/v1/uploads/commit', { preview_id: p.preview_id });
  assert.equal(c.status, 409);
  assert.match(c.body.error.details[0].message, /No athlete has the ID COLPAR/);
  await req('PATCH', `/v1/clients/${cole.id}`, { athlete_id: `COLPAR${year}` });
});
