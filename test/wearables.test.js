import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { localDay, syncAll } from '../src/services/wearables.js';

// Wearable sync (schema 52): a parent or coach links an athlete's WHOOP or Oura account through the provider's sign-in,
// and pulls land in the same tables as file imports. The provider is a stand-in here (ctx.wearableFetch).
let app, base, owner, coach, desk, parent, maya, other, calls;
const PW = 'correct-horse-battery';
const NOW = '2026-09-29T14:00:00Z';
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    return { status: r.status, body: await r.json().catch(() => null), location: r.headers.get('location') };
  };
}
async function parentSignIn(email) {
  const login = await fetch(base + '/portal/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) }).then((r) => r.json());
  const v = await fetch(base + '/portal/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: login.dev_code }) });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + '/portal/api/' + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const pub = async (path) => { const r = await fetch(base + path, { redirect: 'manual' }); return { status: r.status, location: r.headers.get('location') }; };
// The history walk runs on after a connect; tests wait for it so its calls don't land in the next test.
const settled = async () => { for (const p of [...(app.ctx.wearableHistory?.values() ?? [])]) await p; };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// A WHOOP that has one scored cycle (yesterday, Chicago time), its recovery, one night's sleep, a nap and a workout.
// Records come back only when the asked-for window (start/end) covers them, like the real API; `older` adds one scored
// cycle on that day (for the history walk), and nothing before it.
function whoopStub({ tokenStatus = 200, apiStatus = 200, refreshStatus = 200, older = null } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null, auth: init.headers?.authorization ?? null });
    const u = String(url);
    const q = new URL(u).searchParams, start = q.get('start') ? Date.parse(q.get('start')) : -Infinity, end = q.get('end') ? Date.parse(q.get('end')) : Infinity;
    const covers = (iso) => { const t = Date.parse(iso); return t >= start && t <= end; };
    if (u.includes('/developer/v2/cycle') || u.includes('/recovery') || u.includes('/activity/')) {
      if (apiStatus !== 200) return json({ error: 'nope' }, apiStatus);
      const rows = [];
      if (u.includes('/cycle') && covers('2026-09-28T11:30:00.000Z')) rows.push({ id: 501, start: '2026-09-28T11:30:00.000Z', end: '2026-09-29T11:10:00.000Z', timezone_offset: '-05:00', score_state: 'SCORED', score: { strain: 12.345, kilojoule: 8368, average_heart_rate: 71, max_heart_rate: 182 } },
        { id: 502, start: '2026-09-29T11:10:00.000Z', end: null, timezone_offset: '-05:00', score_state: 'PENDING_SCORE', score: null });
      if (u.includes('/cycle') && older && covers(`${older}T11:00:00.000Z`)) rows.push({ id: 400, start: `${older}T11:00:00.000Z`, end: null, timezone_offset: '-05:00', score_state: 'SCORED', score: { strain: 8.1, kilojoule: 7000, average_heart_rate: 68, max_heart_rate: 160 } });
      if (u.includes('/recovery') && covers('2026-09-28T11:30:00.000Z')) rows.push({ cycle_id: 501, sleep_id: 'a1', score_state: 'SCORED', score: { user_calibrating: false, recovery_score: 67, resting_heart_rate: 52, hrv_rmssd_milli: 88.6, spo2_percentage: 97.2, skin_temp_celsius: 33.4 } },
        { cycle_id: 502, sleep_id: 'a2', score_state: 'PENDING_SCORE', score: null });
      if (u.includes('/recovery') && older && covers(`${older}T11:00:00.000Z`)) rows.push({ cycle_id: 400, sleep_id: 'a0', score_state: 'SCORED', score: { user_calibrating: false, recovery_score: 44, resting_heart_rate: 55, hrv_rmssd_milli: 60, spo2_percentage: 96, skin_temp_celsius: 33 } });
      if (u.includes('/activity/sleep') && covers('2026-09-28T03:20:00.000Z')) rows.push(
        { id: 'a1', start: '2026-09-28T03:20:00.000Z', end: '2026-09-28T11:30:00.000Z', timezone_offset: '-05:00', nap: false, score_state: 'SCORED',
          score: { stage_summary: { total_in_bed_time_milli: 29400000, total_awake_time_milli: 2400000, total_light_sleep_time_milli: 13800000, total_slow_wave_sleep_time_milli: 6600000, total_rem_sleep_time_milli: 6000000 },
            sleep_needed: { baseline_milli: 28800000, need_from_sleep_debt_milli: 1800000, need_from_recent_strain_milli: 600000, need_from_recent_nap_milli: 0 },
            respiratory_rate: 15.62, sleep_performance_percentage: 91, sleep_consistency_percentage: 80, sleep_efficiency_percentage: 91.8 } },
        { id: 'n1', start: '2026-09-28T19:00:00.000Z', end: '2026-09-28T19:40:00.000Z', timezone_offset: '-05:00', nap: true, score_state: 'SCORED', score: { stage_summary: { total_in_bed_time_milli: 2400000, total_awake_time_milli: 0, total_light_sleep_time_milli: 2400000, total_slow_wave_sleep_time_milli: 0, total_rem_sleep_time_milli: 0 } } });
      if (u.includes('/activity/workout') && covers('2026-09-28T21:00:00.000Z')) rows.push({ id: 'w1', start: '2026-09-28T21:00:00.000Z', end: '2026-09-28T22:15:00.000Z', timezone_offset: '-05:00', sport_name: 'weightlifting', score_state: 'SCORED', score: { strain: 9.87, kilojoule: 2092, average_heart_rate: 128, max_heart_rate: 171 } });
      return json({ records: rows, next_token: null });
    }
    if (u.includes('/oauth/oauth2/token')) {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'refresh_token') return refreshStatus === 200 ? json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'offline read:recovery' }) : json({ error: 'invalid_grant' }, refreshStatus);
      return tokenStatus === 200 ? json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'offline read:profile read:recovery read:sleep read:cycles read:workout' }) : json({ error: 'bad code' }, tokenStatus);
    }
    if (apiStatus !== 200) return json({ error: 'nope' }, apiStatus);
    if (u.includes('/user/profile/basic')) return json({ user_id: 77001, email: 'maya@example.com', first_name: 'Maya' });
    if (u.includes('/user/access')) return new Response(null, { status: 204 });
    return json({ error: `unexpected ${u}` }, 500);
  };
}

before(async () => {
  resetRateLimits();
  process.env.WHOOP_CLIENT_ID = 'whoop-client-test'; process.env.WHOOP_CLIENT_SECRET = 'whoop-secret-test';
  delete process.env.OURA_CLIENT_ID; delete process.env.OURA_CLIENT_SECRET;
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  maya = (await owner('POST', '/v1/clients', { name: 'Maya Okafor', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  other = (await owner('POST', '/v1/clients', { name: 'Leo Marchetti', parent: { name: 'Gina Marchetti', email: 'gina@example.com' } })).body;
  parent = await parentSignIn('ada@example.com');
});
beforeEach(() => { calls = []; app.ctx.wearableFetch = whoopStub(); });
after(() => { app.server.close(); delete process.env.WHOOP_CLIENT_ID; delete process.env.WHOOP_CLIENT_SECRET; });

test('days follow the provider\'s offset, else the business zone', () => {
  assert.equal(localDay('2026-09-29T03:30:00Z', '-05:00'), '2026-09-28', 'still the 28th in Chicago');
  assert.equal(localDay('2026-09-29T03:30:00Z', '+09:00'), '2026-09-29');
  assert.equal(localDay('2026-09-29T03:30:00Z', null, 'America/Chicago'), '2026-09-28');
  assert.equal(localDay('garbage', '-05:00'), null);
});

test('which providers are set up, and who may connect: parents for their own athlete, owners and coaches, never front desk', async () => {
  const s = (await owner('GET', '/v1/wearables/status')).body;
  assert.deepEqual(s.providers.map((p) => [p.key, p.ready, p.redirect_uri]), [['whoop', true, 'https://app.example.org/wearables/whoop/callback'], ['oura', false, 'https://app.example.org/wearables/oura/callback']]);
  assert.equal((await desk('GET', '/v1/wearables/status')).status, 200, 'front desk can look');
  assert.equal((await desk('POST', `/v1/clients/${maya.id}/wearables/whoop/connect`)).status, 403, 'but not connect');
  const off = await coach('POST', `/v1/clients/${maya.id}/wearables/oura/connect`);
  assert.equal(off.status, 409); assert.match(off.body.error.message, /Oura isn't set up yet/);
  assert.equal((await coach('POST', `/v1/clients/${maya.id}/wearables/fitbit/connect`)).status, 400);
  const mine = (await parent('GET', `athletes/${maya.id}/wearables`)).body;
  assert.deepEqual(mine, { data: [], providers: [{ key: 'whoop', label: 'WHOOP' }] });
  assert.equal((await parent('POST', `athletes/${other.id}/wearables/whoop/connect`)).status, 404, 'not another family\'s athlete');
  const link = await parent('POST', `athletes/${maya.id}/wearables/whoop/connect`);
  assert.equal(link.status, 201, JSON.stringify(link.body));
  const u = new URL(link.body.url);
  assert.equal(u.origin + u.pathname, 'https://api.prod.whoop.com/oauth/oauth2/auth');
  assert.deepEqual([u.searchParams.get('client_id'), u.searchParams.get('redirect_uri'), u.searchParams.get('response_type'), u.searchParams.get('scope')],
    ['whoop-client-test', 'https://app.example.org/wearables/whoop/callback', 'code', 'offline read:profile read:recovery read:sleep read:cycles read:workout']);
  assert.ok(u.searchParams.get('state').length >= 20);
});

test('the provider sends the parent back: the code is exchanged, the account linked and the first month pulled into the athlete\'s data', async () => {
  const link = (await parent('POST', `athletes/${maya.id}/wearables/whoop/connect`)).body;
  const state = new URL(link.url).searchParams.get('state');
  // A made-up state, or one used twice, goes nowhere.
  assert.equal((await pub('/wearables/whoop/callback?code=abc&state=nope')).location, '/parent?tab=progress&wearable=expired&provider=whoop');
  const back = await pub(`/wearables/whoop/callback?code=abc123&state=${state}`);
  assert.equal(back.status, 302);
  assert.equal(back.location, '/parent?tab=progress&wearable=connected&provider=whoop', 'the parent lands on the Progress tab');
  await settled();
  const hist = app.ctx.db.get('SELECT history_done, history_from FROM wearable_connections WHERE client_id = ?', maya.id);
  assert.deepEqual([hist.history_done, hist.history_from.slice(0, 10)], [1, '2026-03-03'], 'the history walk went back two empty chunks (180 days) past the first pull and stopped');
  assert.equal((await pub(`/wearables/whoop/callback?code=abc123&state=${state}`)).location, '/parent?tab=progress&wearable=expired&provider=whoop', 'a state works once');
  const tokenCall = calls.find((c) => c.url.includes('/oauth/oauth2/token'));
  const form = new URLSearchParams(tokenCall.body);
  assert.deepEqual([form.get('grant_type'), form.get('code'), form.get('redirect_uri'), form.get('client_id'), form.get('client_secret')], ['authorization_code', 'abc123', 'https://app.example.org/wearables/whoop/callback', 'whoop-client-test', 'whoop-secret-test']);
  assert.ok(calls.filter((c) => c.auth === 'Bearer at-1').length >= 5, 'profile, cycles, recovery, sleep and workouts were read with the new token');
  const range = new URL(calls.find((c) => c.url.includes('/cycle')).url).searchParams;
  assert.equal(range.get('start'), '2026-08-30T14:00:00.000Z', 'the first pull reaches back 30 days');
  const w = (await parent('GET', `athletes/${maya.id}/wearables`)).body;
  assert.deepEqual(w.data.map((x) => [x.provider, x.status, x.connected_by_kind, x.last_sync_at, x.last_sync_days]), [['whoop', 'active', 'parent', NOW, 1]]);
  assert.deepEqual(w.providers, [{ key: 'whoop', label: 'WHOOP' }], 'the page hides Connect for a provider already linked');
  const rows = app.ctx.db.all('SELECT day, metric, value, source FROM athlete_metrics WHERE client_id = ? ORDER BY metric', maya.id);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.metric, r.value])), {
    avg_hr_bpm: 71, awake_min: 40, calories_kcal: 2000, day_strain: 12.3, deep_min: 110, hrv_ms: 88.6, in_bed_min: 490, light_min: 230, max_hr_bpm: 182, recovery_pct: 67, rem_min: 100, resp_rate: 15.6,
    rhr_bpm: 52, skin_temp_c: 33.4, sleep_consistency_pct: 80, sleep_debt_min: 30, sleep_efficiency_pct: 91.8, sleep_min: 440, sleep_need_min: 520, sleep_performance_pct: 91, spo2_pct: 97.2 });
  assert.ok(rows.every((r) => r.day === '2026-09-28' && r.source === 'whoop_sync'), 'everything lands on the morning they woke up; the pending cycle and the nap are left out');
  const wk = app.ctx.db.get('SELECT * FROM athlete_workouts WHERE client_id = ?', maya.id);
  assert.deepEqual([wk.source, wk.activity, wk.minutes, wk.strain, wk.calories, wk.avg_hr, wk.max_hr, wk.day], ['whoop_sync', 'weightlifting', 75, 9.9, 500, 128, 171, '2026-09-28']);
  const seen = (await coach('GET', `/v1/clients/${maya.id}/outside-data?days=30`)).body;
  assert.ok(seen.has_data && seen.metrics.some((m) => m.key === 'recovery_pct' && m.latest.value === 67), 'the client page reads it like an import');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM wearable_auth_states WHERE state = ?', state).n, 0, 'the used code is gone');
});

test('later pulls refresh an expired token, replace changed values and mark a refused token for reconnecting', async () => {
  const conn = app.ctx.db.get('SELECT * FROM wearable_connections WHERE client_id = ?', maya.id);
  app.ctx.db.run(`UPDATE wearable_connections SET expires_at = '2026-09-29T13:00:00Z' WHERE id = ?`, conn.id);
  app.ctx.db.run(`UPDATE athlete_metrics SET value = 60 WHERE client_id = ? AND metric = 'recovery_pct'`, maya.id);
  const r = await coach('POST', `/v1/wearables/${conn.id}/sync`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.provider, r.body.days, r.body.changed, r.body.workouts], ['whoop', 1, 1, 1], 'only the recovery changed back');
  const refresh = new URLSearchParams(calls.find((c) => c.url.includes('/oauth/oauth2/token')).body);
  assert.deepEqual([refresh.get('grant_type'), refresh.get('refresh_token'), refresh.get('scope')], ['refresh_token', 'rt-1', 'offline']);
  assert.ok(calls.some((c) => c.auth === 'Bearer at-2'), 'the data was read with the new token');
  assert.equal(app.ctx.db.get('SELECT refresh_token FROM wearable_connections WHERE id = ?', conn.id).refresh_token, 'rt-2');
  assert.equal(app.ctx.db.get(`SELECT value FROM athlete_metrics WHERE client_id = ? AND metric = 'recovery_pct'`, maya.id).value, 67);
  assert.equal((await desk('POST', `/v1/wearables/${conn.id}/sync`, {})).status, 403);
  // The provider refuses the token: the connection waits for a parent to connect again, and the job carries on.
  app.ctx.wearableFetch = whoopStub({ apiStatus: 401 });
  const bad = await owner('POST', `/v1/wearables/${conn.id}/sync`, {});
  assert.equal(bad.status, 200); assert.equal(bad.body.needs_reconnect, true);
  const mine = (await parent('GET', `athletes/${maya.id}/wearables`)).body;
  assert.deepEqual([mine.data[0].status, mine.providers], ['needs_reconnect', [{ key: 'whoop', label: 'WHOOP' }]], 'the portal offers Connect again');
  app.ctx.wearableFetch = whoopStub();
  assert.deepEqual(await syncAll(app.ctx), { connections: 0, synced: 0, changed: 0, needs_reconnect: 0, failed: 0 }, 'a connection that needs reconnecting is left alone');
  // Connecting again from the client page (a coach with the athlete's phone) makes it active and comes back to the client page.
  const link = (await coach('POST', `/v1/clients/${maya.id}/wearables/whoop/connect`)).body;
  const back = await pub(`/wearables/whoop/callback?code=again&state=${new URL(link.url).searchParams.get('state')}`);
  await settled();
  assert.equal(back.location, `/?back=&wearable=connected&provider=whoop#/clients/${maya.id}`, 'the query comes before the # so the client page reads it');
  const again = app.ctx.db.get('SELECT status, connected_by_kind, last_error FROM wearable_connections WHERE id = ?', conn.id);
  assert.deepEqual([again.status, again.connected_by_kind, again.last_error], ['active', 'staff', null]);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM wearable_connections WHERE client_id = ?', maya.id).n, 1, 'one connection per provider');
  assert.deepEqual(await syncAll(app.ctx), { connections: 1, synced: 1, changed: 0, needs_reconnect: 0, failed: 0 });
});

test('a refresh the provider refuses (access revoked in the WHOOP app) waits for a reconnect instead of failing the job forever', async () => {
  const conn = app.ctx.db.get('SELECT id FROM wearable_connections WHERE client_id = ?', maya.id);
  app.ctx.db.run(`UPDATE wearable_connections SET expires_at = '2026-09-29T13:00:00Z' WHERE id = ?`, conn.id);
  app.ctx.wearableFetch = whoopStub({ refreshStatus: 400 });
  assert.deepEqual(await syncAll(app.ctx), { connections: 1, synced: 0, changed: 0, needs_reconnect: 1, failed: 0 });
  const row = app.ctx.db.get('SELECT status, last_error FROM wearable_connections WHERE id = ?', conn.id);
  assert.equal(row.status, 'needs_reconnect'); assert.match(row.last_error, /refresh refused.*invalid_grant/);
  // Connected again so the next tests have an active connection.
  const link = (await parent('POST', `athletes/${maya.id}/wearables/whoop/connect`)).body;
  app.ctx.wearableFetch = whoopStub();
  await pub(`/wearables/whoop/callback?code=back&state=${new URL(link.url).searchParams.get('state')}`);
  await settled();
  assert.equal(app.ctx.db.get('SELECT status FROM wearable_connections WHERE id = ?', conn.id).status, 'active');
});

test('the whole history comes in after connecting: chunks of 90 days walk back until half a year brings nothing, and the job finishes an unfinished walk', async () => {
  const conn = app.ctx.db.get('SELECT id FROM wearable_connections WHERE client_id = ?', maya.id);
  // A year and a half of data: the older cycle sits in February 2025.
  app.ctx.wearableFetch = whoopStub({ older: '2025-02-10' });
  app.ctx.db.run('UPDATE wearable_connections SET history_from = NULL, history_empty = 0, history_found = 0, history_done = 0 WHERE id = ?', conn.id);
  app.ctx.db.run(`DELETE FROM athlete_metrics WHERE client_id = ? AND day < '2026-09-01'`, maya.id);
  calls = [];
  const { pullHistory, startHistory } = await import('../src/services/wearables.js');
  // The job's share: four chunks (a year) per run, then it stops for this run with the walk unfinished.
  const first = await pullHistory(app.ctx, conn.id);
  assert.deepEqual([first.chunks, first.done], [4, false]);
  const windows = calls.filter((c) => c.url.includes('/developer/v2/cycle')).map((c) => { const q = new URL(c.url).searchParams; return [q.get('start').slice(0, 10), q.get('end').slice(0, 10)]; });
  assert.deepEqual(windows, [['2026-06-01', '2026-08-30'], ['2026-03-03', '2026-06-01'], ['2025-12-03', '2026-03-03'], ['2025-09-04', '2025-12-03']], 'each chunk ends where the one before began');
  let row = app.ctx.db.get('SELECT history_from, history_empty, history_done FROM wearable_connections WHERE id = ?', conn.id);
  assert.deepEqual([row.history_from.slice(0, 10), row.history_empty, row.history_done], ['2025-09-04', 4, 0], 'four empty chunks so far; the walk only stops on empties once it has found something (or at the floor)');
  // Connecting again starts the background walk, which runs to the end: it finds February 2025, then two empty chunks, and stops.
  await startHistory(app.ctx, conn.id);
  row = app.ctx.db.get('SELECT history_from, history_done FROM wearable_connections WHERE id = ?', conn.id);
  assert.equal(row.history_done, 1);
  assert.equal(app.ctx.db.get(`SELECT value FROM athlete_metrics WHERE client_id = ? AND metric = 'recovery_pct' AND day = '2025-02-10'`, maya.id)?.value, 44, 'the old day is on file');
  assert.ok(row.history_from.slice(0, 10) < '2024-09-01' && row.history_from.slice(0, 10) > '2024-05-01', `stopped about half a year before the oldest data (${row.history_from})`);
  assert.deepEqual(await syncAll(app.ctx), { connections: 1, synced: 1, changed: 0, needs_reconnect: 0, failed: 0 }, 'a finished history is left alone by the job');
  const mine = (await parent('GET', `athletes/${maya.id}/wearables`)).body.data[0];
  assert.deepEqual([mine.history_done, typeof mine.history_from], [true, 'string']);
});

test('a provider that keeps answering 429 is given up on after a few tries, not retried forever', async () => {
  const conn = app.ctx.db.get('SELECT id FROM wearable_connections WHERE client_id = ?', maya.id);
  const plain = whoopStub();
  let n = 0;
  app.ctx.wearableFetch = async (url, init) => (String(url).includes('/developer/') ? (n++, new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '0' } })) : plain(url, init));
  const r = await owner('POST', `/v1/wearables/${conn.id}/sync`, {});
  assert.equal(r.status, 502, JSON.stringify(r.body)); assert.match(r.body.error.message, /rate limited/);
  assert.ok(n >= 4 && n <= 16, `each feed makes one call and at most three retries (${n} calls in all; the first feed to give up ends the pull, so the others may stop early)`);
  assert.equal(app.ctx.db.get('SELECT status FROM wearable_connections WHERE id = ?', conn.id).status, 'active', 'still active: it was the provider\'s day, not the sign-in');
});

test('declined, then disconnected: the token is revoked, the data stays', async () => {
  const link = (await parent('POST', `athletes/${maya.id}/wearables/whoop/connect`)).body;
  const state = new URL(link.url).searchParams.get('state');
  assert.equal((await pub(`/wearables/whoop/callback?error=access_denied&state=${state}`)).location, '/parent?tab=progress&wearable=denied&provider=whoop');
  const conn = app.ctx.db.get('SELECT id FROM wearable_connections WHERE client_id = ?', maya.id);
  const gina = await parentSignIn('gina@example.com');
  assert.equal((await gina('DELETE', `wearables/${conn.id}`)).status, 404, 'another family can\'t touch it');
  const gone = await parent('DELETE', `wearables/${conn.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/user/access')), 'WHOOP was told to revoke');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM wearable_connections').n, 0);
  assert.ok(app.ctx.db.get('SELECT COUNT(*) AS n FROM athlete_metrics WHERE client_id = ?', maya.id).n > 10, 'what was pulled stays');
  const exp = (await owner('GET', `/v1/families/${maya.family.id}/export`)).body;
  assert.ok(Array.isArray(exp.athletes[0].wearables_linked), 'the family export lists linked wearables');
});

test('deleting a family revokes and forgets its wearable connections, so the job never pulls for it again', async () => {
  const kid = (await owner('POST', '/v1/clients', { name: 'Tomas Reyes', parent: { name: 'Ines Reyes', email: 'ines@example.com' } })).body;
  const ines = await parentSignIn('ines@example.com');
  const link = (await ines('POST', `athletes/${kid.id}/wearables/whoop/connect`)).body;
  await pub(`/wearables/whoop/callback?code=t1&state=${new URL(link.url).searchParams.get('state')}`);
  await settled();
  await ines('POST', `athletes/${kid.id}/wearables/whoop/connect`);   // a sign-in started and never finished
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM wearable_connections WHERE client_id = ?', kid.id).n, 1);
  calls = [];
  const del = await owner('DELETE', `/v1/families/${kid.family.id}`, { confirm: 'Reyes family' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/user/access')), 'WHOOP was told to revoke');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM wearable_connections WHERE client_id = ?', kid.id).n, 0);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM wearable_auth_states WHERE client_id = ?', kid.id).n, 0);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM athlete_metrics WHERE client_id = ?', kid.id).n, 0, 'the pulled data went with the family');
  await syncAll(app.ctx);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM athlete_metrics WHERE client_id = ?', kid.id).n, 0, 'nothing comes back');
});

test('a version 51 database gains the wearable tables, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v51.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 51');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 66, `round ${round}`);
      assert.deepEqual(d.all('PRAGMA table_info(wearable_connections)').map((c) => c.name).slice(0, 4), ['id', 'client_id', 'provider', 'provider_user_id']);
      assert.ok(d.all('PRAGMA table_info(wearable_auth_states)').length);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
