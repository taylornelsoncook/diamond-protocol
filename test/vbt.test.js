// Bar speed from velocity-based training devices (owner's ask: "create a connection using API keys so someone can upload
// their information straight to their profile, like from Output VBT devices"): sets pushed to the open API with a
// results-scope key or imported from a device's export land on the athlete's profile by Athlete ID or a linked device,
// wait otherwise (never by name), and are read back as a load-velocity profile with an estimated max.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { fitProfile, mvtKind, guessMapping, cleanSet } from '../src/services/vbt.js';

let app, base, owner, coach, desk, maya, token, parentCookie, resultsKey, readKey;
const PW = 'correct-horse-battery';
const NOW = '2026-10-07T15:00:00.000Z';
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const withKey = (key) => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const athlete = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const parent = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { cookie: parentCookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const squatSets = (day, bump = 0) => [[135, 1.02], [185, 0.84], [225, 0.66], [255, 0.52]].map(([load, vel], i) => ({ athlete: { athlete_id: maya.athlete_id }, exercise: 'Back Squat', performed_at: `${day}T17:0${i}:00Z`, set_no: i + 1, reps: 3, load, mean_velocity: vel + bump, peak_velocity: vel + 0.4, external_id: `sq-${day}-${i}` }));

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  maya = (await coach('POST', '/v1/clients', { name: 'Maya Okafor', birth_date: '2011-04-02', parent: { name: 'Ada Okafor', email: 'ada@example.com' } })).body;
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', maya.id).access_token;
  await coach('POST', '/v1/exercises', { name: 'Back squat (barbell)' });
  resultsKey = withKey((await owner('POST', '/v1/api-keys', { label: 'Output Hub', scope: 'results' })).body.secret);
  readKey = withKey((await owner('POST', '/v1/api-keys', { label: 'Dashboard' })).body.secret);
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com' }) })).json()).dev_code;
  const v = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com', code }) });
  parentCookie = v.headers.get('set-cookie').split(';')[0];
});
after(() => app.server.close());

test('a results-scope key pushes sets to the profile by Athlete ID; a read-only key is refused; resends change nothing', async () => {
  assert.deepEqual([(await readKey('POST', '/v1/vbt/sets', { provider: 'output', sets: squatSets('2026-10-06') })).status, (await readKey('GET', '/v1/vbt/systems')).status], [403, 200]);
  const r = await resultsKey('POST', '/v1/vbt/sets', { provider: 'output', sets: squatSets('2026-10-06') });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.saved, r.body.waiting, r.body.duplicates, r.body.errors], [4, 0, 0, []]);
  assert.deepEqual(r.body.athletes, [{ client_id: maya.id, sets: 4 }]);
  const again = await resultsKey('POST', '/v1/vbt/sets', { provider: 'output', sets: squatSets('2026-10-06') });
  assert.deepEqual([again.body.saved, again.body.duplicates], [0, 4], 'the same external ids again are duplicates');
  const sets = (await coach('GET', `/v1/vbt/sets?client_id=${maya.id}`)).body.data;
  assert.equal(sets.length, 4);
  assert.equal(sets[0].exercise_id, app.ctx.db.get(`SELECT id FROM exercises WHERE name = 'Back squat (barbell)'`).id, 'the library exercise is matched by name (brackets and case aside)');
  assert.equal(sets[0].source, 'api:Output Hub');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'bar_speed.recorded'`).n, 1, 'one event per athlete per request');
});

test('units, aliases and rep details: kg becomes lb, GymAware names and epoch times are read, reps fold into the set, bad values are refused by row', async () => {
  const r = await resultsKey('POST', '/v1/vbt/sets', { provider: 'gymaware', sets: [
    { athleteName: 'Maya', athlete_id: maya.athlete_id, activityName: 'Bench press', recorded: 1759770000, meanVelocity: 0.55, peakVelocity: 0.9, meanPower: 410, peakPower: 700, load: 60, load_unit: 'kg', reference: 'ga-1' },
    { athlete: { athlete_id: maya.athlete_id }, exercise: 'Bench press', performed_at: '2026-10-06T18:00:00Z', set_no: 2, load: 95, reps_detail: [{ velocity: 0.62 }, { velocity: 0.58 }, { velocity: 0.5 }] },
    { athlete: { athlete_id: maya.athlete_id }, exercise: 'Bench press', performed_at: '2026-10-06T18:05:00Z', set_no: 3, load: 95, reps: 3, mean_velocity: 9.5 },
    { athlete: { athlete_id: maya.athlete_id }, exercise: 'Bench press', performed_at: '2026-10-06T18:06:00Z', set_no: 4, load: 95, reps: 3 },
    { exercise: 'Bench press', performed_at: '2026-10-06T18:07:00Z', load: 95, reps: 3, mean_velocity: 0.5 }
  ] });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.saved, r.body.errors.map((e) => e.index)], [2, [2, 3, 4]]);
  assert.match(r.body.errors[0].message, /mean_velocity must be between 0 and 6/);
  assert.match(r.body.errors[1].message, /needs a velocity/);
  assert.match(r.body.errors[2].message, /whose set it is/);
  const sets = (await coach('GET', `/v1/vbt/sets?client_id=${maya.id}&exercise=Bench press`)).body.data;
  const ga = sets.find((s) => s.external_id === 'ga-1'), folded = sets.find((s) => s.set_no === 2);
  assert.equal(ga.load_lb, 132.3, '60 kg in pounds');
  assert.equal(ga.performed_at, '2025-10-06T17:00:00.000Z', 'epoch seconds');
  assert.deepEqual([ga.mean_velocity, ga.peak_velocity, ga.mean_power, ga.peak_power], [0.55, 0.9, 410, 700]);
  assert.deepEqual([folded.reps, folded.mean_velocity, folded.best_velocity, folded.last_velocity, folded.velocity_loss_pct], [3, 0.567, 0.62, 0.5, 19.4]);
  assert.equal(folded.reps_detail.length, 3);
});

test('a set from a device name or ID nobody linked waits; linking the device sends it to the athlete and remembers it', async () => {
  const r = await resultsKey('POST', '/v1/vbt/sets', { provider: 'output', sets: [{ athlete: { external_id: 'HUB-204', name: 'Maya O' }, exercise: 'Trap bar deadlift', performed_at: '2026-10-06T17:30:00Z', set_no: 1, reps: 5, load: 100, load_unit: 'kg', mean_velocity: 0.7 }] });
  assert.deepEqual([r.body.saved, r.body.waiting], [0, 1]);
  assert.deepEqual(r.body.waiting_for, [{ identity: 'id:HUB-204', external_id: 'HUB-204', name: 'Maya O', sets: 1 }]);
  const waiting = (await owner('GET', '/v1/vbt/waiting')).body.data;
  assert.equal(waiting.length, 1);
  assert.deepEqual([waiting[0].identity, waiting[0].sets, waiting[0].exercises], ['id:HUB-204', 1, ['Trap bar deadlift']]);
  assert.equal((await coach('GET', `/v1/vbt/sets?client_id=${maya.id}&exercise=Trap bar deadlift`)).body.data.length, 0, 'not on the profile yet');
  // Linking the device under Testing → Devices & imports covers bar speed too.
  const link = (await coach('POST', '/v1/athlete-links', { provider: 'output', external_id: 'HUB-204', athlete_id: maya.athlete_id })).body;
  assert.equal(link.bar_speed_linked, 1);
  assert.equal((await owner('GET', '/v1/vbt/waiting')).body.data.length, 0);
  assert.equal((await coach('GET', `/v1/vbt/sets?client_id=${maya.id}&exercise=Trap bar deadlift`)).body.data.length, 1);
  // The next set from that device lands straight away.
  const next = await resultsKey('POST', '/v1/vbt/sets', { provider: 'output', sets: [{ athlete: { external_id: 'HUB-204' }, exercise: 'Trap bar deadlift', performed_at: '2026-10-06T17:35:00Z', set_no: 2, reps: 5, load: 100, load_unit: 'kg', mean_velocity: 0.66 }] });
  assert.deepEqual([next.body.saved, next.body.waiting], [1, 0]);
  // A name nobody linked waits too, and the waiting list links it by hand (and remembers).
  // Only systems with an open API are listed (owner decision); any other device's CSV goes in as 'other'.
  assert.deepEqual((await coach('GET', '/v1/vbt/systems')).body.data.map((x) => x.key), ['output', 'gymaware', 'flex', 'enode', 'perch', 'other']);
  assert.equal((await resultsKey('POST', '/v1/vbt/sets', { provider: 'vitruve', sets: [] })).status, 400, 'a system without an open API is not a provider');
  await resultsKey('POST', '/v1/vbt/sets', { provider: 'perch', sets: [{ athlete: { name: 'Maya Okafor' }, exercise: 'Front squat', performed_at: '2026-10-06T17:40:00Z', load: 135, reps: 3, mean_velocity: 0.8 }] });
  const w = (await owner('GET', '/v1/vbt/waiting')).body.data[0];
  assert.equal(w.identity, 'name:maya okafor', 'a name is never matched on its own');
  assert.equal((await desk('POST', '/v1/vbt/waiting/link', { provider: 'perch', identity: w.identity, athlete_id: maya.athlete_id })).status, 403, 'front desk looks only');
  assert.equal((await coach('POST', '/v1/vbt/waiting/link', { provider: 'perch', identity: w.identity, athlete_id: maya.athlete_id })).status, 403, 'coaches read the data, never link, import or send (owner decision)');
  assert.equal((await coach('GET', '/v1/vbt/waiting')).status, 403);
  assert.equal((await coach('POST', '/v1/vbt/sets', { provider: 'output', sets: [] })).status, 403);
  const linked = (await owner('POST', '/v1/vbt/waiting/link', { provider: 'perch', identity: w.identity, athlete_id: maya.athlete_id })).body;
  assert.deepEqual([linked.linked, linked.remembered], [1, true]);
  assert.ok(app.ctx.db.get(`SELECT 1 FROM athlete_links WHERE provider = 'perch' AND external_id = 'name:maya okafor' AND client_id = ?`, maya.id));
});

test('the profile: a load-velocity line, the estimated max at the threshold, the trend at the usual load, recent sessions; athlete and parent read it too', async () => {
  await resultsKey('POST', '/v1/vbt/sets', { provider: 'output', sets: squatSets('2026-09-29', -0.04) });
  const prof = (await coach('GET', `/v1/clients/${maya.id}/vbt`)).body;
  assert.equal(prof.has_data, true);
  assert.deepEqual(prof.totals, { sets: 13, days: 3, exercises: 4, last_day: '2026-10-06' });
  const squat = prof.exercises.find((e) => e.name === 'Back Squat');
  assert.deepEqual(squat.mvt, { kind: 'squat', value: 0.3 });
  assert.equal(squat.profile.loads, 4);
  assert.ok(squat.profile.r2 > 0.99, 'the made-up sets lie on a line');
  assert.equal(squat.profile.e1rm, 310, 'where the line meets 0.30 m/s, to 5 lb');
  assert.deepEqual(squat.profile.zones.map((z) => z.velocity), [1, 0.75, 0.5]);
  assert.deepEqual(squat.fastest, { velocity: 1.02, load_lb: 135, day: '2026-10-06' });
  assert.equal(squat.track_load, 255, 'the load lifted most (ties: the heaviest)');
  assert.deepEqual(squat.trend, [{ date: '2026-09-29', value: 0.48 }, { date: '2026-10-06', value: 0.52 }], 'speed at the usual load, day by day');
  const bench = prof.exercises.find((e) => e.name === 'Bench press');
  assert.equal(bench.profile, null, 'two loads are not enough for a max');
  assert.equal(prof.exercises.find((e) => e.name === 'Trap bar deadlift').mvt.kind, 'deadlift');
  assert.equal(prof.recent[0].day, '2026-10-06');
  const recentSquat = prof.recent[0].exercises.find((e) => e.name === 'Back Squat');
  assert.deepEqual(recentSquat.sets.map((s) => s.load_lb), [135, 185, 225, 255]);
  // The owner's thresholds move the estimate; out-of-range values are refused.
  assert.equal((await owner('PATCH', '/v1/settings', { vbt_mvt_squat: '0.9' })).status, 400);
  assert.equal((await owner('PATCH', '/v1/settings', { vbt_mvt_squat: '0.35' })).status, 200);
  assert.equal((await coach('GET', `/v1/clients/${maya.id}/vbt`)).body.exercises.find((e) => e.name === 'Back Squat').profile.e1rm, 300);
  assert.equal((await coach('GET', '/v1/vbt/systems')).body.thresholds.squat, 0.35);
  await owner('PATCH', '/v1/settings', { vbt_mvt_squat: '0.30' });
  // The athlete in the app, the parent in the portal, front desk on the client page.
  assert.equal((await athlete('GET', '/app/api/vbt')).body.exercises.find((e) => e.name === 'Back Squat').profile.e1rm, 310);
  assert.equal((await parent('GET', `/portal/api/athletes/${maya.id}/vbt`)).status, 404, 'parents see no bar speed (owner decision); the athlete sees their own');
  assert.equal((await coach('GET', `/v1/clients/${maya.id}/vbt`)).body.totals.sets, 13, 'coaches read everyone\'s');
  assert.equal((await desk('GET', `/v1/clients/${maya.id}/vbt`)).status, 200);
  assert.equal((await desk('GET', '/v1/vbt/waiting')).status, 403);
  assert.equal((await desk('POST', '/v1/vbt/sets', { provider: 'output', sets: squatSets('2026-10-07') })).status, 403);
  // The timeline carries one line per exercise and day.
  const tl = (await coach('GET', `/v1/clients/${maya.id}/athlete-timeline?kind=bar_speed`)).body;
  assert.ok(tl.kinds.some((k) => k.key === 'bar_speed'));
  const line = tl.data.find((x) => x.text.startsWith('Bar speed: Back Squat'));
  assert.equal(line.text, 'Bar speed: Back Squat, best 1.02 m/s at 135 lb');
  assert.match(line.detail, /4 sets · top load 255 lb · Output Sports/);
  assert.equal(tl.data[0].text, 'Bar speed: Bench press, best 0.62 m/s at 95 lb', 'newest first');
  assert.equal((await athlete('GET', '/app/api/timeline?kind=bar_speed')).body.data.length, tl.data.length);
});

test('a device export: columns matched by name, one row per rep folded into sets, kg read from the header, problems by row, unmatched names wait, undo removes it', async () => {
  const csv = 'Athlete,Date,Exercise,Set,Rep,Load (kg),Mean Velocity (m/s),Peak Velocity (m/s),Mean Power (W)\n' + [
    'Maya Okafor,10/05/2026 17:02,Back Squat,1,1,100,0.72,1.1,800', 'Maya Okafor,10/05/2026 17:02,Back Squat,1,2,100,0.70,1.05,790', 'Maya Okafor,10/05/2026 17:02,Back Squat,1,3,100,0.61,1.0,700',
    'Jordan Lee,10/05/2026 17:10,Back Squat,1,1,80,0.9,1.3,600'].join('\n');
  const prev = (await owner('POST', '/v1/vbt/import/preview', { provider: 'output', file: { name: 'hub.csv', csv } })).body;
  assert.deepEqual([prev.mapping.athlete, prev.mapping.date, prev.mapping.exercise, prev.mapping.rep, prev.mapping.load, prev.mapping.load_unit, prev.mapping.mean_velocity], ['Athlete', 'Date', 'Exercise', 'Rep', 'Load (kg)', 'kg', 'Mean Velocity (m/s)']);
  assert.deepEqual([prev.rows, prev.sets_found, prev.per_rep, prev.problems], [4, 2, true, []]);
  const p0 = prev.preview[0];
  assert.deepEqual([p0.load_lb, p0.reps, p0.mean_velocity, p0.best_velocity, p0.last_velocity, p0.velocity_loss_pct, p0.mean_power, p0.reps_detail], [220.5, 3, 0.677, 0.72, 0.61, 15.3, 800, 3]);
  assert.equal(p0.performed_at, '2026-10-05T17:02:00.000Z', 'a US date and time, taken as written');
  assert.deepEqual(prev.unmatched_athletes.map((u) => u.name), ['Maya Okafor', 'Jordan Lee'], 'Maya is linked by name under vitruve, not output: a name is never matched on its own');
  // A bad value stops the save and names the row and column.
  const bad = await owner('POST', '/v1/vbt/import', { provider: 'output', file: { name: 'hub.csv', csv: csv + '\nMaya Okafor,10/05/2026 17:20,Back Squat,2,1,100,7.5,1.0,800' } });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'problems']);
  assert.deepEqual(bad.body.error.details.problems[0], { row: 6, column: 'Mean Velocity (m/s)', message: 'mean_velocity must be between 0 and 6.' });
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM vbt_sets WHERE source = 'csv:output'`).n, 0, 'nothing saved');
  // Saved: Jordan waits, Maya's set is on file only once the name is linked under output (it isn't, so both wait).
  const saved = (await owner('POST', '/v1/vbt/import', { provider: 'output', file: { name: 'hub.csv', csv } })).body;
  assert.deepEqual([saved.saved, saved.waiting, saved.duplicates], [0, 2, 0]);
  assert.equal((await owner('GET', '/v1/vbt/imports')).body.data[0].id, saved.id);
  assert.equal((await owner('GET', '/v1/vbt/waiting')).body.data.length, 2);
  // Importing it again changes nothing.
  const twice = (await owner('POST', '/v1/vbt/import', { provider: 'output', file: { name: 'hub.csv', csv } })).body;
  assert.deepEqual([twice.saved, twice.waiting, twice.duplicates], [0, 0, 2]);
  const undone = (await owner('POST', `/v1/vbt/imports/${saved.id}/undo`)).body;
  assert.equal(undone.removed, 2);
  assert.equal((await owner('GET', '/v1/vbt/waiting')).body.data.length, 0);
  await owner('POST', `/v1/vbt/imports/${twice.id}/undo`);
  // A file with no athlete column needs the athlete chosen; an Excel-less, set-per-row file with lb loads.
  const perSet = 'Date,Exercise,Set,Reps,Weight (lb),Avg Velocity,Peak Velocity\n2026-10-04,Back Squat,1,5,205,0.75,1.1\n2026-10-04,Back Squat,2,5,205,0.71,1.05';
  const noOne = await owner('POST', '/v1/vbt/import/preview', { provider: 'flex', file: { name: 'flex.csv', csv: perSet } });
  assert.match(noOne.body.problems[0].message, /names no athlete/);
  const mine = (await owner('POST', '/v1/vbt/import', { provider: 'flex', file: { name: 'flex.csv', csv: perSet }, client_id: maya.id })).body;
  assert.deepEqual([mine.saved, mine.waiting], [2, 0]);
  const flex = (await coach('GET', `/v1/vbt/sets?client_id=${maya.id}&provider=flex`)).body.data;
  assert.deepEqual(flex.map((s) => [s.load_lb, s.reps, s.mean_velocity, s.day]).sort(), [[205, 5, 0.71, '2026-10-04'], [205, 5, 0.75, '2026-10-04']]);
  assert.equal((await desk('POST', '/v1/vbt/import/preview', { provider: 'flex', file: { name: 'flex.csv', csv: perSet } })).status, 403);
});

test('the family export carries bar speed and deleting the family removes it; removing one set', async () => {
  const exp = (await owner('GET', `/v1/families/${maya.family.id}/export`)).body;
  const kid = exp.athletes.find((a) => a.id === maya.id);
  assert.equal(kid.bar_speed.length, 15, JSON.stringify(Object.keys(kid)).slice(0, 300));
  assert.deepEqual(Object.keys(kid.bar_speed[0]).sort(), ['best_velocity', 'exercise', 'last_velocity', 'load_lb', 'mean_power', 'mean_velocity', 'peak_power', 'peak_velocity', 'performed_at', 'reps', 'rom_cm', 'set_no', 'system', 'velocity_loss_pct']);
  const one = (await coach('GET', `/v1/vbt/sets?client_id=${maya.id}&provider=flex`)).body.data[0];
  assert.equal((await coach('DELETE', `/v1/vbt/sets/${one.id}`)).status, 403, 'a coach never changes the data');
  assert.equal((await owner('DELETE', `/v1/vbt/sets/${one.id}`)).status, 200);
  assert.equal((await coach('GET', `/v1/vbt/sets?client_id=${maya.id}&provider=flex`)).body.data.length, 1);
  // Another family's deletion takes its sets with it.
  const other = (await coach('POST', '/v1/clients', { name: 'Zed Park', birth_date: '2012-01-01', parent: { name: 'Pat Park', email: 'pat@example.com' } })).body;
  await resultsKey('POST', '/v1/vbt/sets', { provider: 'enode', sets: [{ athlete: { athlete_id: other.athlete_id }, exercise: 'Back squat', performed_at: '2026-10-06T17:00:00Z', load: 100, reps: 3, mean_velocity: 0.8 }] });
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM vbt_sets WHERE client_id = ?', other.id).n, 1);
  assert.equal((await owner('DELETE', `/v1/families/${other.family.id}`, { confirm: other.family.name })).status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM vbt_sets WHERE client_id = ?', other.id).n, 0);
});

test('the math: the line and the threshold kinds; a version 80 database gains the tables', () => {
  const fit = fitProfile([{ load_lb: 135, velocity: 1.0 }, { load_lb: 185, velocity: 0.8 }, { load_lb: 225, velocity: 0.64 }, { load_lb: 255, velocity: 0.52 }], 0.3);
  assert.ok(fit && fit.slope < 0 && fit.r2 > 0.99);
  assert.equal(fit.e1rm, 310);
  assert.equal(fitProfile([{ load_lb: 135, velocity: 1.0 }, { load_lb: 185, velocity: 0.8 }], 0.3), null, 'two loads: no line');
  assert.equal(fitProfile([{ load_lb: 200, velocity: 0.7 }, { load_lb: 205, velocity: 0.69 }, { load_lb: 210, velocity: 0.68 }], 0.3), null, 'loads too close together');
  assert.equal(fitProfile([{ load_lb: 135, velocity: 0.6 }, { load_lb: 185, velocity: 0.8 }, { load_lb: 225, velocity: 0.9 }], 0.3), null, 'faster with more load is not a profile');
  assert.deepEqual(['Back squat', 'Bench press', 'Trap bar deadlift', 'Power clean', 'Biceps curl', 'Bulgarian split squat', 'Hip thrust'].map(mvtKind), ['squat', 'bench', 'deadlift', 'ballistic', 'other', 'squat', 'deadlift']);
  const m = guessMapping(['Name', 'Date', 'Exercise', 'Set', 'Reps', 'Weight (kg)', 'Mean Velocity (m/s)', 'Peak Velocity (m/s)', 'ROM (m)', 'Fatigue']);
  assert.deepEqual([m.athlete, m.date, m.set, m.reps, m.load, m.load_unit, m.mean_velocity, m.peak_velocity, m.rom, m.rom_unit, m.velocity_loss_pct], ['Name', 'Date', 'Set', 'Reps', 'Weight (kg)', 'kg', 'Mean Velocity (m/s)', 'Peak Velocity (m/s)', 'ROM (m)', 'm', 'Fatigue']);
  const s = cleanSet(app.ctx, { exercise: 'Back squat', performed_at: '2026-10-05', load: 100, load_unit: 'kg', reps: 3, mean_velocity: 0.7, velocity_loss_pct: 0.18, best_velocity: 0.75, rom: 0.42, rom_unit: 'm' }, { now: NOW });
  assert.deepEqual([s.load_lb, s.performed_at, s.velocity_loss_pct, s.rom_cm], [220.5, '2026-10-05T12:00:00.000Z', 18, 42]);
  assert.throws(() => cleanSet(app.ctx, { exercise: 'Back squat', load: 100, reps: 3 }, { now: NOW }), /needs a velocity/);
  assert.throws(() => cleanSet(app.ctx, { exercise: 'Back squat', load: 100, reps: 3, mean_velocity: 0.7, load_unit: 'stone' }, { now: NOW }), /lb or kg/);

  const tmp = mkdtempSync(join(tmpdir(), 'dp-v80-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v80.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 80');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 87, `round ${round}`);
      assert.deepEqual(d.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vbt_%' ORDER BY name`).map((t) => t.name), ['vbt_imports', 'vbt_sets']);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
