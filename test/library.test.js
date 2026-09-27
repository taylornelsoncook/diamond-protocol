// Test library: protocols, usage, record boards, editing and deleting tests, and presets for a testing day.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { syncLibrary } from '../src/services/performance.js';
import { seedPresets } from '../src/services/library.js';
import { TESTS, PROTOCOLS, DEFAULT_PRESETS } from '../src/services/test-library.js';
import { writeXlsx } from '../src/services/xlsx.js';

let app, base, owner, coach, desk;
const call = async (method, path, body, cookie = owner) => {
  const res = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const signIn = async (email) => (await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) })).headers.get('set-cookie').split(';')[0];

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  [owner, coach, desk] = [await signIn('owner@test.dev'), await signIn('coach@test.dev'), await signIn('desk@test.dev')];
});
after(() => app.server.close());

test('every built-in test says how to run it, and the API returns it', async () => {
  assert.deepEqual(TESTS.filter((t) => !PROTOCOLS[t.key]?.trim()).map((t) => t.key), [], 'a written protocol for every built-in test');
  const lib = (await call('GET', '/v1/tests')).body.data;
  const forty = lib.find((t) => t.key === 'dash_40yd');
  assert.equal(forty.protocol, PROTOCOLS.dash_40yd);
  assert.equal(forty.protocol_custom, false);
  assert.deepEqual(forty.metrics[0].range, [3.8, 12]);
});

test('a new business starts with the standard presets once; deleting one sticks', async () => {
  const list = (await call('GET', '/v1/test-presets')).body.data;
  assert.deepEqual(list.map((p) => p.name), DEFAULT_PRESETS.map(([n]) => n));
  assert.deepEqual(list[0].tests.map((t) => t.key), DEFAULT_PRESETS[0][1], 'tests in running order');
  const soccer = list.find((p) => p.name === 'Soccer');
  assert.equal((await call('DELETE', `/v1/test-presets/${soccer.id}`)).status, 200);
  seedPresets(app.ctx);
  assert.equal((await call('GET', '/v1/test-presets')).body.data.some((p) => p.name === 'Soccer'), false, 'not added back');
});

test('presets: add, rename, reorder, copy and delete, with clear errors', async () => {
  const bad = async (body, re) => { const r = await call('POST', '/v1/test-presets', body); assert.equal(r.status >= 400, true); assert.match(r.body.error.message, re); };
  await bad({ name: '', tests: ['height'] }, /name is required/);
  await bad({ name: 'Mine', tests: [] }, /at least one test/);
  await bad({ name: 'Mine', tests: ['no_such_test'] }, /not found/);
  await bad({ name: 'combine', tests: ['height'] }, /already a preset called combine/i);
  await bad({ name: 'Mine', tests: Array.from({ length: 41 }, (_, i) => TESTS[i].key) }, /up to 40/);
  const p = (await call('POST', '/v1/test-presets', { name: '  Preseason   battery ', tests: ['broad_jump', 'dash_40yd', 'broad_jump'] })).body;
  assert.equal(p.name, 'Preseason battery');
  assert.deepEqual(p.tests.map((t) => t.key), ['broad_jump', 'dash_40yd'], 'a test listed twice is kept once');
  const moved = (await call('PATCH', `/v1/test-presets/${p.id}`, { tests: ['dash_40yd', 'broad_jump', 'height'] })).body;
  assert.deepEqual(moved.tests.map((t) => t.key), ['dash_40yd', 'broad_jump', 'height']);
  assert.equal((await call('PATCH', `/v1/test-presets/${p.id}`, { name: 'Force plate' })).status, 409);
  const copy = (await call('POST', `/v1/test-presets/${p.id}/copy`)).body;
  const copy2 = (await call('POST', `/v1/test-presets/${p.id}/copy`)).body;
  assert.deepEqual([copy.name, copy2.name], ['Preseason battery (copy)', 'Preseason battery (copy 2)']);
  assert.deepEqual(copy.tests.map((t) => t.key), ['dash_40yd', 'broad_jump', 'height']);
  assert.equal((await call('DELETE', `/v1/test-presets/${copy2.id}`)).status, 200);
  assert.equal((await call('GET', `/v1/test-presets/${copy2.id}`)).status, 404);
  // Names like built-in object keys are just names here.
  const proto = (await call('POST', '/v1/test-presets', { name: '__proto__', tests: ['height'] })).body;
  assert.equal((await call('GET', `/v1/test-presets/${proto.id}`)).body.name, '__proto__');
});

test('usage and presets per test; details with a record board by sex and age at the time', async () => {
  const mk = async (name, birth, sex) => (await call('POST', '/v1/clients', { name, birth_date: birth, sex, email: `${name.split(' ')[0].toLowerCase()}@example.com` })).body;
  const ava = await mk('Ava Lopez', '2012-05-01', 'F'), mia = await mk('Mia Chen', '2008-01-10', 'F'), cole = await mk('Cole Park', '2011-03-03', 'M'), gone = await mk('Gus Old', '2010-01-01', 'M');
  const res = (client, value, date, extra = {}) => ({ client_id: client.id, test: 'dash_40yd', value, recorded_at: date, ...extra });
  const r = (await call('POST', '/v1/results', { results: [
    res(ava, 6.2, '2025-06-01'), res(ava, 5.9, '2026-06-01'), res(mia, 5.6, '2022-06-01'), res(mia, 5.4, '2026-06-01', { timing: 'hand' }), res(cole, 5.5, '2026-06-02'), res(gone, 4.9, '2026-06-02')
  ] })).body;
  assert.equal(r.created, 6);
  // A team player who also trains privately counts once.
  const contract = (await call('POST', '/v1/team-contracts', { organization: { name: 'Westlake HS' }, name: 'Varsity', monthly_cents: 100000 })).body;
  const player = (await call('POST', `/v1/team-contracts/${contract.id}/roster`, { names: 'Cole Park' })).body.data[0];
  app.ctx.db.run('UPDATE team_roster SET client_id = ? WHERE id = ?', cole.id, player.id);
  await call('POST', '/v1/results', { results: [{ roster_id: player.id, test: 'dash_40yd', value: 5.3, recorded_at: '2026-07-01' }] });
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', new Date().toISOString(), gone.id);

  await call('PATCH', '/v1/tests/hexagon', { active: false });
  const lib = (await call('GET', '/v1/tests?usage=true')).body.data;
  const forty = lib.find((t) => t.key === 'dash_40yd');
  assert.deepEqual(forty.usage, { results: 7, athletes: 4, days: 0, last_used: '2026-07-01' }, 'a team player who also trains privately is one athlete');
  assert.ok(forty.presets.some((p) => p.name === 'Combine'));
  assert.equal(lib.find((t) => t.key === 'fms').usage.results, 0);
  assert.equal(lib.find((t) => t.key === 'hexagon').active, false, 'hidden tests are listed too');

  const d = (await call('GET', '/v1/tests/dash_40yd/details')).body;
  assert.equal(d.protocol, PROTOCOLS.dash_40yd);
  assert.deepEqual(d.records.board.map((x) => [x.name, x.value]), [['Cole Park', 5.3], ['Mia Chen', 5.4], ['Ava Lopez', 5.9]], 'each athlete once, fastest first, archived left out');
  assert.equal(d.records.board[1].hand_timed, true);
  assert.equal(d.deletable, false);
  const girls = (await call('GET', '/v1/tests/dash_40yd/details?sex=F')).body.records.board;
  assert.deepEqual(girls.map((x) => x.name), ['Mia Chen', 'Ava Lopez']);
  // Mia was 14 in 2022 and 18 in 2026: her 13-14 record is the 2022 result, not her best today.
  const young = (await call('GET', '/v1/tests/dash_40yd/details?age=13-14')).body.records.board;
  assert.deepEqual(young.map((x) => [x.name, x.value, x.date]), [['Mia Chen', 5.6, '2022-06-01'], ['Ava Lopez', 5.9, '2026-06-01']]);
  assert.equal((await call('GET', '/v1/tests/dash_40yd/details?age=old')).status, 400);
  assert.equal((await call('GET', '/v1/tests/height/details')).body.records.board.length, 0, 'measurements have no record board');
  assert.equal((await call('GET', '/v1/tests/dash_40yd/details', null, desk)).status, 200, 'front desk can look');
});

test('editing built-in tests: allowed fields survive the library refresh; units and scoring stay', async () => {
  const e = (await call('PATCH', '/v1/tests/broad_jump', { attempts: 3, category: 'sport', protocol: 'Our way: two jumps, best counts.', metrics: [{ key: 'distance', min_value: 20, max_value: 140 }] }, coach)).body;
  assert.deepEqual(e.changes.sort(), ['attempts', 'category', 'protocol', 'range']);
  assert.equal(e.protocol_custom, true);
  syncLibrary(app.ctx);                          // runs at every start-up
  const t = (await call('GET', '/v1/tests/broad_jump')).body;
  assert.deepEqual([t.attempts, t.category, t.protocol, t.metrics[0].range, t.metrics[0].range_custom], [3, 'sport', 'Our way: two jumps, best counts.', [20, 140], true]);
  assert.equal((await call('PATCH', '/v1/tests/broad_jump', { attempts: 3 })).body.changes.length, 0, 'saving without changes changes nothing');
  const back = (await call('PATCH', '/v1/tests/broad_jump', { protocol: '', metrics: [{ key: 'distance', min_value: '', max_value: '' }] })).body;
  assert.deepEqual([back.protocol, back.protocol_custom, back.metrics[0].range], [PROTOCOLS.broad_jump, false, [30, 150]], 'empty goes back to the built-in text and range');
  assert.match((await call('PATCH', '/v1/tests/broad_jump', { metrics: [{ key: 'distance', unit: 'cm' }] })).body.error.message, /keep their numbers, units and scoring/);
  assert.match((await call('PATCH', '/v1/tests/broad_jump', { metrics: [{ key: 'distance', min_value: 50 , max_value: '' }] })).body.error.message, /both the lowest and the highest/);
  assert.match((await call('PATCH', '/v1/tests/broad_jump', { metrics: [{ key: 'distance', min_value: 90, max_value: 50 }] })).body.error.message, /below the highest/);
  assert.match((await call('PATCH', '/v1/tests/broad_jump', { timed: true })).body.error.message, /seconds/);
  assert.equal((await call('PATCH', '/v1/tests/broad_jump', { name: '40-yard dash' })).status, 409);
  assert.equal((await call('PATCH', '/v1/tests/broad_jump', { attempts: 4 }, desk)).status, 403, 'front desk can\'t edit');
});

test('your own range is what uploads check', async () => {
  const c = (await call('POST', '/v1/clients', { name: 'Zoe Range', email: 'zoe@example.com' })).body;
  await call('PATCH', '/v1/tests/grip', { metrics: [{ key: 'force', min_value: 10, max_value: 60 }] });
  const rows = [['Athlete ID', 'Name', 'Grip strength – Left #1 (lb)'], [c.athlete_id, 'Zoe Range', 80]];
  const p = (await call('POST', '/v1/uploads/preview', { xlsx_base64: Buffer.from(writeXlsx([{ name: 'Results', rows }])).toString('base64'), filename: 'grip.xlsx' })).body;
  assert.equal(p.ok, false);
  assert.match(p.errors.map((x) => x.message).join(' '), /isn't possible for Grip strength \(10–60 lb\)/);
});

test('your own tests: edit everything until there are results; delete only unused ones', async () => {
  assert.match((await call('POST', '/v1/tests', { name: 'Grip strength', unit: 'lb', better: 'higher' })).body.error.message, /already a test called/);
  assert.match((await call('POST', '/v1/tests', { name: 'Wall ball', unit: 'reps', better: 'higher', timed: true })).body.error.message, /seconds/);
  const t = (await call('POST', '/v1/tests', { name: 'Wall ball', unit: 'reps', better: 'higher', protocol: '  Throw to the 10-foot line.  ', min_value: 0, max_value: 200 }, coach)).body;
  assert.deepEqual([t.builtin, t.protocol, t.metrics[0].range, t.attempts], [false, 'Throw to the 10-foot line.', [0, 200], 2]);
  const e = (await call('PATCH', `/v1/tests/${t.key}`, { sides: 'lr', metrics: [{ key: 'value', unit: 's', better: 'lower', name: 'Time' }], timed: true })).body;
  assert.deepEqual([e.sides, e.metrics[0].unit, e.metrics[0].better, e.timed], ['lr', 's', 'lower', true]);
  // In a preset: deleting removes it there too.
  const p = (await call('POST', '/v1/test-presets', { name: 'Wall work', tests: [t.key, 'height'] })).body;
  assert.deepEqual((await call('GET', `/v1/tests/${t.key}/details`)).body.presets.map((x) => x.name), ['Wall work']);
  assert.equal((await call('GET', `/v1/tests/${t.key}/details`)).body.deletable, true);
  assert.equal((await call('DELETE', `/v1/tests/${t.key}`, null, desk)).status, 403);
  assert.equal((await call('DELETE', `/v1/tests/${t.key}`)).status, 200);
  assert.deepEqual((await call('GET', `/v1/test-presets/${p.id}`)).body.tests.map((x) => x.key), ['height']);
  assert.match((await call('DELETE', '/v1/tests/height')).body.error.message, /Built-in tests can't be deleted/);

  const used = (await call('POST', '/v1/tests', { name: 'Sled push', unit: 's', better: 'lower' })).body;
  const c = (await call('POST', '/v1/clients', { name: 'Sam Sled', email: 'sam@example.com' })).body;
  await call('POST', '/v1/results', { results: [{ client_id: c.id, test: used.key, value: 8.2 }] });
  assert.match((await call('PATCH', `/v1/tests/${used.key}`, { metrics: [{ key: 'value', unit: 'min' }] })).body.error.message, /already has results/);
  assert.match((await call('PATCH', `/v1/tests/${used.key}`, { sides: 'lr' })).body.error.message, /already has results/);
  assert.equal((await call('PATCH', `/v1/tests/${used.key}`, { name: 'Sled push 20 yd' })).body.name, 'Sled push 20 yd', 'the name can still change');
  const r = await call('DELETE', `/v1/tests/${used.key}`);
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /because it has results\. Hide it instead/);
  // Planned on a testing day but no results yet: still in use.
  const planned = (await call('POST', '/v1/tests', { name: 'Tire flip', unit: 'reps', better: 'higher' })).body;
  await call('POST', '/v1/testing-sessions', { name: 'Strongman', tests: [planned.key] });
  assert.match((await call('DELETE', `/v1/tests/${planned.key}`)).body.error.message, /a testing day uses it/);
});

test('front desk sees presets but can\'t change them', async () => {
  assert.equal((await call('GET', '/v1/test-presets', null, desk)).status, 200);
  assert.equal((await call('GET', '/v1/tests?usage=true', null, desk)).status, 200);
  assert.equal((await call('POST', '/v1/test-presets', { name: 'Desk', tests: ['height'] }, desk)).status, 403);
  const any = (await call('GET', '/v1/test-presets')).body.data[0];
  assert.equal((await call('PATCH', `/v1/test-presets/${any.id}`, { name: 'Desk' }, desk)).status, 403);
  assert.equal((await call('DELETE', `/v1/test-presets/${any.id}`, null, desk)).status, 403);
  assert.equal((await call('POST', `/v1/test-presets/${any.id}/copy`, null, desk)).status, 403);
  assert.equal((await call('POST', '/v1/test-presets', { name: 'Coach set', tests: ['height'] }, coach)).status, 201, 'coaches can');
});
