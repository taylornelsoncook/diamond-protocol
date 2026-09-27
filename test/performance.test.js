import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { convert } from '../src/services/units.js';

// Stand-in for Hawkin's cloud API.
let hawkinTests = [];
const hawkin = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/api/token') return req.headers.authorization === 'Bearer good-refresh' ? send(200, { access_token: 'acc', expires_at: 0 }) : send(401, { message: 'bad token' });
  if (req.url.startsWith('/api/v1?')) return req.headers.authorization === 'Bearer acc' ? send(200, { data: hawkinTests, lastSyncTime: 1790000000 }) : send(401, {});
  send(404, {});
});

let app, base, cookie, apiKey, maya, jordan, contract;
const req = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const coach = (m, p, b) => req(m, p, b, { cookie });
const device = (m, p, b) => req(m, p, b, { authorization: `Bearer ${apiKey}` });

before(async () => {
  await new Promise((r) => hawkin.listen(0, r));
  app = createApp({ testMode: true, jobs: false, hawkinBaseUrl: `http://localhost:${hawkin.address().port}` });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const l = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'coach@test.dev', password: 'correct-horse-battery' }) });
  cookie = l.headers.get('set-cookie').split(';')[0];
  apiKey = (await coach('POST', '/v1/api-keys', { label: 'Timing gates' })).body.secret;
  maya = (await coach('POST', '/v1/clients', { name: 'Maya Chen', email: 'maya@example.com' })).body;
  jordan = (await coach('POST', '/v1/clients', { name: 'Jordan Ellis', email: 'jordan@example.com' })).body;
  contract = (await coach('POST', '/v1/team-contracts', { organization: { name: 'Westlake HS' }, name: 'Varsity', monthly_cents: 100000 })).body;
  await coach('POST', `/v1/team-contracts/${contract.id}/roster`, { names: 'Jalen Brooks, QB\nMarcus Hill, WR' });
});
after(() => { app.server.close(); hawkin.close(); });

test('unit conversions', () => {
  assert.equal(convert(1, 'm', 'in').toFixed(2), '39.37');
  assert.equal(convert(71.12, 'cm', 'in').toFixed(2), '28.00');
  assert.equal(convert(100, 'kg', 'lb').toFixed(1), '220.5');
  assert.equal(convert(250, 'ms', 's'), 0.25);
  assert.equal(convert(36, 'km/h', 'm/s'), 10);
  assert.throws(() => convert(1, 'lb', 's'), /Can't convert/);
});

test('every researched test is preloaded with the right units', async () => {
  const { data, categories } = (await coach('GET', '/v1/tests')).body;
  assert.ok(data.length >= 70, `${data.length} tests`);
  assert.equal(categories.length, 9);
  const t = (k) => data.find((x) => x.key === k);
  const head = (k) => t(k).metrics[0];
  assert.deepEqual([head('dash_40yd').unit, head('dash_40yd').better], ['s', 'lower']);
  assert.deepEqual(t('dash_40yd').metrics.map((m) => m.key), ['time', 'split_10', 'split_20']);
  for (const k of ['dash_30yd', 'dash_60yd', 'sprint_10m', 'sprint_30m', 'three_quarter_court', 'three_cone', 'shuttle_60yd', 'lane_agility', 'nba_shuttle', 'reaction_box', 'wingate', 'pull_ups', 'grip', 'bench_225', 'yoyo_ir1', 'ift_30_15', 'vo2max', 'y_balance', 'fms', 'pitch_velocity', 'exit_velocity', 'seated_height', 'wingspan']) assert.ok(t(k), k);
  assert.deepEqual([head('vertical_standing').unit, head('broad_jump').unit, head('grip').unit, head('pitch_velocity').unit, head('ift_30_15').unit, head('yoyo_ir1').unit], ['in', 'in', 'lb', 'mph', 'km/h', 'm']);
  assert.equal(t('pro_agility').sides, 'lr');
  assert.equal(t('pro_agility').timed, true);
  const fp = data.filter((x) => x.category === 'force_plate').map((x) => x.key);
  for (const k of ['cmj', 'cmj_arms', 'sl_cmj', 'squat_jump', 'drop_jump', 'cmrj', 'imtp', 'iso_squat']) assert.ok(fp.includes(k), k);
  assert.deepEqual(t('cmj').metrics.slice(0, 3).map((m) => [m.key, m.unit]), [['jump_height', 'in'], ['rsi_mod', 'ratio'], ['peak_power', 'W']]);
  assert.deepEqual([head('imtp').key, head('imtp').unit, head('drop_jump').key], ['peak_force', 'N', 'rsi']);
  assert.ok(t('cmj').metrics[0].units.includes('cm'), 'jump height accepts cm or m');
});

test('custom tests and hiding tests', async () => {
  const c = (await coach('POST', '/v1/tests', { name: 'Sled push 20 yd', category: 'speed', unit: 's', better: 'lower' })).body;
  assert.equal(c.key, 'sled_push_20_yd');
  assert.equal((await coach('POST', '/v1/tests', { name: 'Sled push 20 yd', unit: 's' })).status, 409);
  await coach('PATCH', '/v1/tests/lane_agility', { active: false });
  assert.ok(!(await coach('GET', '/v1/tests')).body.data.some((x) => x.key === 'lane_agility'));
  assert.ok((await coach('GET', '/v1/tests?include_inactive=true')).body.data.some((x) => x.key === 'lane_agility'));
});

test('manual and stopwatch entry: conversions, sides, personal records', async () => {
  const r1 = (await coach('POST', '/v1/results', { results: [
    { client_id: maya.id, test: 'dash_40yd', value: 5.12, timing: 'hand', recorded_at: '2026-08-01' },
    { client_id: maya.id, test: 'vertical_standing', value: 60.96, unit: 'cm', recorded_at: '2026-08-01' },
    { client_id: maya.id, test: 'pro_agility', side: 'left', value: 4.61, recorded_at: '2026-08-01' },
    { client_id: maya.id, test: 'three_cone', side: 'L', value: 7.4 },
    { client_id: maya.id, test: 'no_such_test', value: 1 },
    { client_id: maya.id, test: 'dash_40yd', value: 5, unit: 'lb' },
    { athlete: { name: 'Nobody Here' }, test: 'dash_40yd', value: 5 }
  ] })).body;
  assert.equal(r1.created, 3);
  assert.equal(r1.errors.length, 3);
  assert.match(r1.errors.find((e) => e.index === 3).message, /isn't tested by side/);
  assert.match(r1.errors.find((e) => e.index === 5).message, /Can't convert/);
  assert.deepEqual(r1.unmatched.map((u) => u.index), [6]);
  assert.equal(r1.results.find((x) => x.test === 'vertical_standing').value.toFixed(1), '24.0');
  const r2 = (await coach('POST', '/v1/results', { results: [
    { client_id: maya.id, test: 'dash_40yd', value: 4.98, timing: 'electronic', recorded_at: '2026-09-15' },
    { client_id: maya.id, test: 'vertical_standing', value: 23.5, recorded_at: '2026-09-15' }
  ] })).body;
  assert.equal(r2.prs.length, 1, 'faster 40 is a PR; lower vertical is not');
  assert.equal(r2.prs[0].test, 'dash_40yd');
  const prof = (await coach('GET', `/v1/clients/${maya.id}/performance`)).body.data;
  const forty = prof.find((p) => p.test === 'dash_40yd' && p.metric === 'time');
  assert.equal(forty.best, 4.98);
  assert.equal(forty.first.value, 5.12);
  assert.equal(forty.first.hand_timed, true);
  assert.equal(forty.improved, true);
  assert.equal(forty.change.toFixed(2), '-0.14');
  assert.equal(prof.find((p) => p.test === 'pro_agility').side, 'L');
  const events = (await coach('GET', '/v1/events?limit=20')).body.data.map((e) => e.type);
  assert.ok(events.includes('performance.pr') && events.includes('results.recorded'));
});

test('testing days bring in a team roster and collect everyone\'s results', async () => {
  const s = (await coach('POST', '/v1/testing-sessions', { name: 'Westlake preseason', date: '2026-09-20', contract_id: contract.id, tests: ['dash_40yd', 'pro_agility', 'cmj'] })).body;
  assert.deepEqual(s.athletes.map((a) => a.name), ['Jalen Brooks', 'Marcus Hill']);
  const jalen = s.athletes[0];
  const r = (await coach('POST', '/v1/results', { session_id: s.id, results: [{ roster_id: jalen.roster_id, test: 'dash_40yd', value: 4.62, attempt: 1 }, { roster_id: jalen.roster_id, test: 'dash_40yd', value: 4.58, attempt: 2 }, { client_id: maya.id, test: 'cmj', value: 18.2 }] })).body;
  assert.equal(r.created, 3);
  const day = (await coach('GET', `/v1/testing-sessions/${s.id}`)).body;
  assert.equal(day.athletes.length, 3, 'walk-ups tested on the day are added');
  assert.equal(day.athletes.find((a) => a.name === 'Jalen Brooks').results.length, 2);
  assert.equal((await coach('GET', `/v1/roster/${jalen.roster_id}/performance`)).body.data[0].best, 4.58);
  assert.equal((await coach('GET', '/v1/testing-sessions')).body.data[0].results_count, 3);
});



test('devices push through the open API: IDs land directly, anything else waits in the queue', async () => {
  const push = { provider: 'swift', results: [
    { athlete: { external_id: 'SW-77', name: 'Jordan Ellis' }, test: 'dash_40yd', value: 4.71, external_id: 'swift-run-1', device: 'Swift SmartSpeed', timing: 'electronic' },
    { athlete: { external_id: 'SW-77' }, test: 'dash_40yd', metric: 'split_10', value: 1.61, external_id: 'swift-run-1-s10' },
    { athlete: { name: maya.athlete_id }, test: 'dash_40yd', value: 4.99, external_id: 'swift-run-2' }] };
  const r = (await device('POST', '/v1/results', push)).body;
  assert.equal(r.created, 1, 'the Athlete ID typed as the name lands directly');
  assert.equal(r.queued, 2, 'a name alone is never trusted');
  assert.equal((await device('POST', '/v1/results', push)).body.queued, 2, 'retries don\'t add queue copies');
  const q = (await coach('GET', '/v1/queue')).body;
  assert.equal(q.n, 3, 'plus "Nobody Here" from the manual entry test');
  const nobody = q.data.find((x) => x.label === 'Nobody Here');
  assert.equal((await coach('POST', '/v1/queue/discard', { provider: nobody.provider, identity: nobody.identity })).body.discarded, 1);
  const g = q.data.find((x) => x.provider === 'swift');
  assert.deepEqual([g.label, g.device_id, g.count, g.identity], ['Jordan Ellis', 'SW-77', 2, 'id:SW-77']);
  assert.equal(g.suggestions[0].name, 'Jordan Ellis', 'similar names are suggested, never applied');
  assert.equal((await coach('POST', '/v1/queue/link', { provider: 'swift', identity: g.identity, athlete_id: 'NOPE' })).status, 400);
  assert.equal((await coach('POST', '/v1/queue/link', { provider: 'swift', identity: g.identity, athlete_id: jordan.athlete_id, expect_count: 5 })).status, 409, 'links exactly what the coach saw');
  const linked = (await coach('POST', '/v1/queue/link', { provider: 'swift', identity: g.identity, athlete_id: jordan.athlete_id.toLowerCase(), remember: true, expect_count: 2 })).body;
  assert.deepEqual([linked.linked, linked.saved, linked.athlete.name, linked.remembered.external_id], [2, 2, 'Jordan Ellis', 'SW-77']);
  assert.equal((await coach('GET', '/v1/queue')).body.n, 0);
  const next = (await device('POST', '/v1/results', { provider: 'swift', results: [{ athlete: { external_id: 'SW-77' }, test: 'dash_40yd', value: 4.69, external_id: 'swift-run-3' }] })).body;
  assert.equal(next.created, 1, 'after the coach links a device ID once, its results go straight in');
  const res = (await coach('GET', `/v1/results?client_id=${jordan.id}`)).body.data;
  assert.equal(res.filter((x) => x.test === 'dash_40yd').length, 3);
  assert.ok(res.some((x) => x.device === 'Swift SmartSpeed'));
  const links = (await coach('GET', `/v1/athlete-links?client_id=${jordan.id}`)).body.data;
  assert.equal(links[0].external_id, 'SW-77');
});

test('link single results by hand, or discard them; linking is all or nothing', async () => {
  await device('POST', '/v1/results', { provider: 'gates', results: [
    { athlete: { name: 'Mystery Kid' }, test: 'dash_40yd', value: 5.5, external_id: 'g1' },
    { athlete: { name: 'Mystery Kid' }, test: 'dash_40yd', value: 5.4, external_id: 'g2' },
    { athlete: { name: 'Mystery Kid' }, test: 'broad_jump', value: 80, external_id: 'g3' }] });
  const g = (await coach('GET', '/v1/queue')).body.data.find((x) => x.provider === 'gates');
  assert.equal(g.identity, 'name:mystery kid');
  const [a, b, c] = g.items.map((i) => i.id);
  const one = (await coach('POST', '/v1/queue/link', { ids: [a, b], client_id: maya.id })).body;
  assert.equal(one.saved, 2);
  assert.equal(one.remembered, null, 'picking results one by one doesn\'t remember the name');
  assert.equal((await coach('POST', '/v1/queue/link', { ids: [a, c], client_id: maya.id })).status, 409, 'an already-linked result blocks the whole action');
  assert.equal((await coach('GET', '/v1/queue')).body.data.find((x) => x.provider === 'gates').count, 1, 'nothing moved');
  assert.equal((await coach('POST', '/v1/queue/discard', { ids: [c] })).body.discarded, 1);
  assert.equal((await coach('GET', '/v1/queue')).body.n, 0);
  const more = (await device('POST', '/v1/results', { provider: 'gates', results: [{ athlete: { name: 'Mystery Kid' }, test: 'dash_40yd', value: 5.3, external_id: 'g4' }] })).body;
  assert.equal(more.queued, 1, 'still waits: the name was never linked');
});

test('file imports: Athlete IDs land, names wait in the queue, and a remembered link works next time', async () => {
  const sheet = (d) => `Athlete,Date,40 Yard,10 Split,Vertical (in),Broad Jump (in),5-10-5 Left,5-10-5 Right,Notes
${maya.athlete_id},${d},4.95,1.66,24.5,98,4.52,4.60,good day
${jordan.athlete_id},${d},4.69,1.58,31,110,4.31,4.35,
Casey New,${d},5.40,1.80,20,85,5.01,5.10,walk-on`;
  const dry = (await coach('POST', '/v1/imports', { provider: 'generic', csv: sheet('09/01/2026'), dry_run: true })).body;
  assert.deepEqual(dry.mapping.columns['40 Yard'], { test: 'dash_40yd', metric: 'time', unit: 's' });
  assert.deepEqual([dry.mapping.columns['5-10-5 Left'].side, dry.mapping.columns['5-10-5 Right'].side], ['L', 'R']);
  assert.equal(dry.mapping.roles.notes, 'Notes');
  assert.deepEqual(dry.unmatched_athletes.map((a) => a.name), ['Casey New']);
  const imp = (await coach('POST', '/v1/imports', { provider: 'generic', csv: sheet('09/01/2026'), filename: 'combine.csv' })).body;
  assert.deepEqual([imp.imported, imp.queued, imp.pending_results], [12, 6, 6]);
  assert.equal((await coach('POST', '/v1/imports', { provider: 'generic', csv: sheet('09/01/2026') })).body.duplicates, 12);
  const casey = (await coach('POST', '/v1/clients', { name: 'Casey Newton', email: 'casey@example.com' })).body;
  const g = (await coach('GET', '/v1/queue')).body.data.find((x) => x.label === 'Casey New');
  const linked = (await coach('POST', '/v1/queue/link', { provider: g.provider, identity: g.identity, athlete_id: casey.athlete_id, remember: true })).body;
  assert.equal(linked.saved, 6);
  assert.equal((await coach('GET', `/v1/imports/${imp.id}`)).body.pending_results, 0);
  assert.equal((await coach('POST', '/v1/imports', { provider: 'generic', csv: sheet('09/15/2026') })).body.imported, 18, 'Casey New now goes straight to Casey Newton');
});

test('force plate and OVR exports carry the Athlete ID as the name', async () => {
  const vald = `Name,Date,Test Type,Jump Height (m),RSI-modified,Peak Propulsive Power (W),Peak Force [N],Trial
${maya.athlete_id},2026-09-02,Countermovement Jump,0.4572,0.52,2950,,1
${maya.athlete_id},2026-09-02,Countermovement Jump,0.4699,0.55,3010,,2
${maya.athlete_id},2026-09-02,Isometric Test,,,,2210,1
${jordan.athlete_id},2026-09-02,Drop Jump,0.38,,,,1`;
  const dry = (await coach('POST', '/v1/imports', { provider: 'vald', csv: vald, dry_run: true })).body;
  assert.deepEqual(dry.mapping.tests, { 'Countermovement Jump': 'cmj', 'Isometric Test': 'imtp', 'Drop Jump': 'drop_jump' });
  assert.equal((await coach('POST', '/v1/imports', { provider: 'vald', csv: vald })).body.imported, 8);
  const cmj = (await coach('GET', `/v1/results?client_id=${maya.id}&test=cmj`)).body.data.filter((r) => r.metric === 'jump_height' && r.source === 'csv:vald');
  assert.deepEqual(cmj.map((r) => r.value.toFixed(1)).sort(), ['18.0', '18.5'], 'meters converted to inches');
  const ovr = `Date,Athlete,Jump Height (in),GCT (ms),RSI\n2026-09-03 16:05,${maya.athlete_id},14.2,182,2.05\n2026-09-03 16:06,${maya.athlete_id},14.8,176,2.21`;
  const d2 = (await coach('POST', '/v1/imports', { provider: 'ovr', csv: ovr, test: 'hop_10_5', dry_run: true })).body;
  assert.deepEqual(Object.fromEntries(Object.entries(d2.mapping.columns).map(([k, c]) => [k, c?.metric])), { 'Jump Height (in)': 'height', 'GCT (ms)': 'contact_time', RSI: 'rsi' });
  assert.equal((await coach('POST', '/v1/imports', { provider: 'ovr', csv: ovr, test: 'hop_10_5' })).body.imported, 6);
  assert.equal((await coach('POST', '/v1/imports', { provider: 'ovr', csv: `Date,Athlete,Jump Height (in),GCT (ms),RSI\n2026-09-10 16:05,${maya.athlete_id},15.1,170,2.3`, dry_run: true })).body.saved_mapping, true);
});

test('Hawkin Dynamics: Athlete IDs sync in; other athletes wait until linked once', async () => {
  assert.equal((await coach('PUT', '/v1/integrations/hawkin', { refresh_token: 'wrong' })).status, 409);
  hawkinTests = [
    { id: 'hd1', timestamp: 1788000000, active: true, testType: { id: 't1', name: 'Countermovement Jump' }, athlete: { id: 'ath-9', name: maya.athlete_id }, 'Jump Height(m)': 0.4826, mRSI: 0.58, 'Peak Propulsive Power(W)': 3100 },
    { id: 'hd2', timestamp: 1788000100, active: true, testType: { id: 't2', name: 'Isometric Test' }, athlete: { id: 'ath-3', name: 'Jordan Ellis' }, 'Peak Vertical Force(N)': 1800 },
    { id: 'hd3', timestamp: 1788000200, active: false, testType: { id: 't1', name: 'Countermovement Jump' }, athlete: { id: 'ath-9', name: maya.athlete_id }, 'Jump Height(m)': 0.1 },
    { id: 'hd4', timestamp: 1788000300, active: true, testType: { id: 't9', name: 'Free Run' }, athlete: { id: 'ath-9', name: maya.athlete_id }, 'Peak Force(N)': 900 }
  ];
  const c = (await coach('PUT', '/v1/integrations/hawkin', { refresh_token: 'good-refresh', region: 'americas', backfill_days: 30 })).body;
  assert.equal(c.token_hint, '…resh');
  assert.deepEqual([c.sync.results, c.sync.waiting_for_match, c.sync.skipped_test_types], [3, 1, ['Free Run']]);
  const cmj = (await coach('GET', `/v1/results?client_id=${maya.id}&source=hawkin`)).body.data;
  assert.equal(cmj.find((r) => r.metric === 'jump_height').value.toFixed(1), '19.0');
  const g = (await coach('GET', '/v1/queue')).body.data.find((x) => x.provider === 'hawkin');
  assert.deepEqual([g.label, g.device_id, g.source_name], ['Jordan Ellis', 'ath-3', 'Hawkin Dynamics']);
  await coach('POST', '/v1/queue/link', { provider: 'hawkin', identity: g.identity, athlete_id: jordan.athlete_id, remember: true });
  hawkinTests.push({ id: 'hd5', timestamp: 1788000400, active: true, testType: { id: 't2', name: 'Isometric Test' }, athlete: { id: 'ath-3', name: 'Jordan Ellis' }, 'Peak Vertical Force(N)': 1850 });
  const again = (await coach('POST', '/v1/integrations/hawkin/sync')).body;
  assert.deepEqual([again.results, again.waiting_for_match], [1, 0], 'linked device athlete syncs straight in');
  assert.ok(!JSON.stringify((await coach('GET', '/v1/integrations')).body).includes('good-refresh'), 'the token is never sent back');
  assert.equal((await coach('DELETE', '/v1/integrations/hawkin')).body.connected, false);
});
