// Testing days, uploads and devices (port batch B9): walk-ups, retests, safer sharing, undo an upload, device links.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { RANGES } from '../src/services/test-library.js';
import { rangeOf, outOfRange, rangeText } from '../src/services/performance.js';

let app, base;
const cookies = {};
const call = async (who, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { cookie: cookies[who], ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : null };
};
const owner = (m, p, b) => call('owner', m, p, b);
const coach = (m, p, b) => call('coach', m, p, b);
const desk = (m, p, b) => call('desk', m, p, b);
const year = String(new Date().getFullYear());
const mailTo = (email) => app.ctx.db.all(`SELECT subject FROM outbox WHERE to_email = ? AND subject LIKE '%results from%' ORDER BY rowid`, email);
let ava, ben, cole, dana, arch;

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  for (const [who, email, password] of [['owner', 'owner@test.dev', 'owner-password-1'], ['coach', 'coach@test.dev', 'coach-password-1'], ['desk', 'desk@test.dev', 'desk-password-1']]) {
    const l = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    cookies[who] = l.headers.get('set-cookie').split(';')[0];
  }
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Lopez', family_id: ava.family.id })).body;          // Ava's brother
  cole = (await owner('POST', '/v1/clients', { name: 'Cole Park', parent: { name: 'Pat Park', email: 'pat@example.com' } })).body;
  dana = (await owner('POST', '/v1/clients', { name: 'Dana Reed', email: 'dana@example.com' })).body;                // no parent
  arch = (await owner('POST', '/v1/clients', { name: 'Archie Gone', parent: { name: 'Gail Gone', email: 'gail@example.com' } })).body;
  assert.equal((await owner('POST', `/v1/clients/${arch.id}/archive`, { confirm: true })).status, 200);
});
after(() => app.server.close());

test('possible values: one-sided ranges read "at least" or "at most" and only check their own end', async () => {
  assert.deepEqual(rangeOf({ key: 'dash_40yd' }, { key: 'time' }), [3.8, 12]);
  RANGES['plank_min.value'] = [60, null];
  RANGES['cap_max.value'] = [null, 10];
  try {
    assert.equal(outOfRange(50, rangeOf({ key: 'plank_min' }, { key: 'value' })), true);
    assert.equal(outOfRange(5000, rangeOf({ key: 'plank_min' }, { key: 'value' })), false, 'no highest value means no upper check');
    assert.equal(outOfRange(-3, rangeOf({ key: 'cap_max' }, { key: 'value' })), false);
    assert.equal(rangeText([60, null], 's'), 'at least 60 s');
    assert.equal(rangeText([null, 10], 's'), 'at most 10 s');
    const t = (await owner('POST', '/v1/tests', { name: 'Plank min', key: 'plank_min', unit: 's', better: 'higher', category: 'strength' })).body;
    assert.deepEqual(t.metrics[0].range, [60, null], 'the screen gets the range to check against');
    const r = (await owner('POST', '/v1/results', { results: [{ client_id: ava.id, test: 'plank_min', value: 30 }, { client_id: ava.id, test: 'plank_min', value: 900 }] })).body;
    assert.equal(r.created, 1);
    assert.match(r.errors[0].message, /isn't possible for Plank min \(at least 60 s\)/, 'a one-sided range gives a clear reason, not a server error');
  } finally { delete RANGES['plank_min.value']; delete RANGES['cap_max.value']; }
  const bad = (await owner('POST', '/v1/results', { results: [{ client_id: ava.id, test: 'dash_40yd', value: 101 }] })).body;
  assert.equal(bad.created, 0, 'a broad jump typed into the 40 is refused wherever it comes from');
});

test('a first-ever testing day is never a PR, even when the second attempt beats the first', async () => {
  const r = (await owner('POST', '/v1/results', { results: [{ client_id: dana.id, test: 'pro_agility', value: 5.4, recorded_at: '2026-05-01' }, { client_id: dana.id, test: 'pro_agility', value: 5.2, recorded_at: '2026-05-01' }] })).body;
  assert.equal(r.created, 2);
  assert.equal(r.prs.length, 0);
});

let day;
test('new day: real dates only, archived athletes left out, retests copy athletes and tests', async () => {
  assert.equal((await coach('POST', '/v1/testing-sessions', { name: 'Bad', date: '2026-02-30', tests: ['dash_40yd'] })).status, 400);
  const d = (await coach('POST', '/v1/testing-sessions', { name: 'Fall combine', date: '2026-09-10', tests: ['dash_40yd', 'broad_jump'],
    athletes: [{ client_id: ava.id }, { client_id: ben.id }, { client_id: cole.id }, { client_id: dana.id }, { client_id: arch.id }] })).body;
  assert.equal(d.athletes.length, 4);
  assert.equal(d.left_out, 1, 'the archived athlete is left out and counted');
  day = d;
  assert.equal((await desk('POST', '/v1/testing-sessions', { name: 'x', tests: ['dash_40yd'] })).status, 403, 'front desk can\'t plan days');
  const re = (await coach('POST', '/v1/testing-sessions', { retest_of: d.id, date: '2026-12-10' })).body;
  assert.equal(re.name, 'Fall combine retest');
  assert.deepEqual(re.tests.map((t) => t.key), ['dash_40yd', 'broad_jump']);
  assert.equal(re.athletes.length, 4);
  assert.equal((await owner('DELETE', `/v1/testing-sessions/${re.id}`)).status, 200, 'an empty day deletes without a confirmation');
});

test('walk-ups: front desk can add, archived athletes are refused, and a mistaken athlete comes off with a confirmation', async () => {
  const walk = (await owner('POST', '/v1/clients', { name: 'Walker Up', email: 'walker@example.com' })).body;
  const added = await desk('POST', `/v1/testing-sessions/${day.id}/athletes`, { athlete_id: walk.athlete_id });
  assert.equal(added.status, 200);
  assert.ok(added.body.athletes.some((a) => a.client_id === walk.id));
  const refused = await desk('POST', `/v1/testing-sessions/${day.id}/athletes`, { client_id: arch.id });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /archived/);
  assert.equal((await desk('PATCH', `/v1/testing-sessions/${day.id}`, { name: 'x' })).status, 403, 'front desk can\'t edit the day');
  assert.equal((await desk('DELETE', `/v1/testing-sessions/${day.id}/athletes/${walk.id}`)).status, 403);
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: walk.id, test: 'dash_40yd', value: 5.5, attempt: 1 }] });
  const ask = await coach('DELETE', `/v1/testing-sessions/${day.id}/athletes/${walk.id}`);
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error.code, 'confirmation_required');
  assert.equal(ask.body.error.details.results, 1);
  const done = await coach('DELETE', `/v1/testing-sessions/${day.id}/athletes/${walk.id}?confirm=true`);
  assert.deepEqual([done.status, done.body.deleted_results], [200, 1]);
  const after = (await coach('GET', `/v1/testing-sessions/${day.id}`)).body;
  assert.ok(!after.athletes.some((a) => a.client_id === walk.id), 'gone from the day, results too');
});

test('the day shows each athlete\'s previous best from before it, and the list shows progress', async () => {
  await owner('POST', '/v1/results', { results: [{ client_id: ava.id, test: 'dash_40yd', value: 6.0, recorded_at: '2026-08-01' }, { client_id: ava.id, test: 'dash_40yd', value: 5.4, recorded_at: '2026-12-01' }] });
  await coach('POST', '/v1/results', { session_id: day.id, results: [
    { client_id: ava.id, test: 'dash_40yd', value: 5.8, attempt: 1, recorded_at: '2026-09-10' },
    { client_id: ben.id, test: 'dash_40yd', value: 6.4, attempt: 1, recorded_at: '2026-09-10' },
    { client_id: dana.id, test: 'broad_jump', value: 80, attempt: 1, recorded_at: '2026-09-10' }] });
  const d = (await coach('GET', `/v1/testing-sessions/${day.id}`)).body;
  const a = d.athletes.find((x) => x.client_id === ava.id);
  assert.equal(a.previous_best['dash_40yd|time|'], 6.0, 'only results from before the day count (not the later 5.4 or today\'s 5.8)');
  assert.deepEqual(d.athletes.find((x) => x.client_id === cole.id).previous_best, {});
  const listed = (await desk('GET', '/v1/testing-sessions')).body;
  const row = listed.data.find((x) => x.id === day.id);
  assert.deepEqual([row.status, row.progress.done, row.progress.planned], ['open', 3, 8]);
  assert.equal(typeof listed.waiting, 'number', 'front desk sees how many results are waiting');
});

test('editing a day: real dates, and removing a test with results needs a confirmation', async () => {
  assert.equal((await coach('PATCH', `/v1/testing-sessions/${day.id}`, { date: '2026-13-01' })).status, 400);
  assert.equal((await coach('PATCH', `/v1/testing-sessions/${day.id}`, { tests: [] })).status, 400);
  const add = (await coach('PATCH', `/v1/testing-sessions/${day.id}`, { tests: ['dash_40yd', 'broad_jump', 'vertical_standing'] })).body;
  assert.equal(add.tests.length, 3, 'a test can be added mid-day');
  const ask = await coach('PATCH', `/v1/testing-sessions/${day.id}`, { tests: ['dash_40yd', 'vertical_standing'] });
  assert.equal(ask.status, 409);
  assert.deepEqual(ask.body.error.details, { results: 1, tests: ['Broad jump'], athletes: [] });
  const renamed = (await coach('PATCH', `/v1/testing-sessions/${day.id}`, { name: 'Fall combine 2026', date: '2026-09-11' })).body;
  assert.deepEqual([renamed.name, renamed.date, renamed.tests.length], ['Fall combine 2026', '2026-09-11', 3], 'nothing removed without the confirmation');
});

test('sharing: the preview counts families (siblings once), names who has no parent email, and later results email only new families', async () => {
  const pv = (await coach('GET', `/v1/testing-sessions/${day.id}/share-preview`)).body;
  assert.deepEqual([pv.athletes, pv.with_results, pv.families], [4, 3, 1], 'Ava and Ben are one family; Dana has no parent');
  assert.deepEqual(pv.without_results, ['Cole Park']);
  assert.deepEqual(pv.no_email, ['Dana Reed']);
  assert.equal((await desk('POST', `/v1/testing-sessions/${day.id}/share`, {})).status, 403, 'front desk can\'t share');
  const shared = (await coach('POST', `/v1/testing-sessions/${day.id}/share`, { parent_note: 'Great day' })).body;
  assert.equal(shared.families_notified, 1);
  assert.equal(mailTo('maria@example.com').length, 2, 'one email per athlete');
  assert.equal(mailTo('pat@example.com').length, 0);
  assert.equal((await coach('POST', `/v1/testing-sessions/${day.id}/share`, { only_new: true })).status, 409, 'nothing new yet');
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: cole.id, test: 'dash_40yd', value: 5.1, attempt: 1 }] });
  const d = (await coach('GET', `/v1/testing-sessions/${day.id}`)).body;
  assert.equal(d.new_since_share, 1);
  const pv2 = (await coach('GET', `/v1/testing-sessions/${day.id}/share-preview`)).body;
  assert.deepEqual([pv2.new_since_share, pv2.new_families], [['Cole Park'], 1]);
  const again = (await coach('POST', `/v1/testing-sessions/${day.id}/share`, { only_new: true })).body;
  assert.deepEqual([again.again, again.families_notified, again.new_since_share], [true, 1, 0]);
  assert.equal(mailTo('pat@example.com').length, 1);
  assert.equal(mailTo('maria@example.com').length, 2, 'families already emailed aren\'t emailed again');
  // Parents see the shared day.
  assert.ok((await owner('GET', `/v1/testing-sessions/${day.id}`)).body.shared_at);
});

test('deleting a day: results need a confirmation, and a shared day only the owner can delete', async () => {
  const c = await coach('DELETE', `/v1/testing-sessions/${day.id}?confirm=true`);
  assert.equal(c.status, 403);
  assert.match(c.body.error.message, /Only the owner/);
  assert.equal((await desk('DELETE', `/v1/testing-sessions/${day.id}`)).status, 403);
  const ask = await owner('DELETE', `/v1/testing-sessions/${day.id}`);
  assert.equal(ask.status, 409);
  const n = ask.body.error.details.results;
  assert.ok(n >= 4);
  const done = (await owner('DELETE', `/v1/testing-sessions/${day.id}?confirm=true`)).body;
  assert.equal(done.deleted_results, n);
  assert.equal((await owner('GET', `/v1/testing-sessions/${day.id}`)).status, 404);
  assert.equal((await owner('GET', `/v1/results?session_id=${day.id}`)).body.data.length, 0);
});

// ---------- Uploads ----------
const csv = (rows) => rows.map((r) => r.join(',')).join('\n');
const upload = async (rows, opts = {}, who = coach) => (await who('POST', '/v1/uploads/preview', { csv: csv(rows), filename: 'sheet.csv', ...opts })).body;
const commit = async (p, who = coach) => (await who('POST', '/v1/uploads/commit', { preview_id: p.preview_id, confirm: p.warnings.map((w) => w.key) })).body;

test('uploads: a re-upload leaves saved values alone, replaces changed ones, and undo puts everything back', async () => {
  const d = (await coach('POST', '/v1/testing-sessions', { name: 'Speed day', date: '2026-09-20', tests: ['dash_40yd'], athletes: [{ client_id: ava.id }, { client_id: cole.id }] })).body;
  // A stopwatch time on the day, and one typed time.
  await coach('POST', '/v1/results', { session_id: d.id, results: [{ client_id: ava.id, test: 'dash_40yd', value: 5.7, attempt: 1, timing: 'hand', source: 'stopwatch' },
    { client_id: cole.id, test: 'dash_40yd', value: 5.2, attempt: 1, source: 'manual' }] });
  const header = ['Athlete ID', 'Name', '40-yard dash #1 (s)', '40-yard dash #2 (s)', 'Broad jump (in)'];
  const p = await upload([header, [ava.athlete_id, 'Ava Lopez', 5.7, 5.65, ''], [cole.athlete_id, 'Cole Park', 5.3, '', 96]], { session_id: d.id, date: '2020-01-01', source: 'Freelap' });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.deepEqual([p.summary.new, p.summary.replaced, p.summary.unchanged], [2, 1, 1]);
  assert.equal(p.session.date, '2026-09-20', 'a testing day sets the date');
  assert.equal(p.read.id_column, 'Athlete ID');
  assert.deepEqual(p.read.columns.map((c) => c.test), ['dash_40yd', 'dash_40yd', 'broad_jump']);
  const avaRows = p.athletes.find((a) => a.name === 'Ava Lopez').results;
  assert.equal(avaRows.find((r) => r.attempt === 1).status, 'unchanged');
  const coleDash = p.athletes.find((a) => a.name === 'Cole Park').results.find((r) => r.test === 'dash_40yd');
  assert.deepEqual([coleDash.status, coleDash.was], ['replace', [5.2]]);
  const done = await commit(p);
  assert.deepEqual([done.saved, done.created, done.replaced, done.already_saved, done.prs], [3, 2, 1, 1, p.summary.prs]);
  const day1 = (await coach('GET', `/v1/testing-sessions/${d.id}`)).body;
  const avaR = day1.athletes.find((a) => a.client_id === ava.id).results;
  assert.deepEqual(avaR.find((r) => r.attempt === 1 && r.metric === 'time' && r.value === 5.7) && [avaR.find((r) => r.value === 5.7).source, avaR.find((r) => r.value === 5.7).timing], ['stopwatch', 'hand'], 'the stopwatch time keeps its label');
  assert.deepEqual(day1.athletes.find((a) => a.client_id === cole.id).results.filter((r) => r.test_id === day1.tests[0].id).map((r) => r.value), [5.3], 'the typed 5.2 is replaced, not doubled');
  assert.ok(day1.tests.some((t) => t.key === 'broad_jump'), 'a test in the sheet joins the day');
  // Coach types a new value after the upload: undo must leave it alone.
  const ava2 = avaR.find((r) => r.value === 5.65);
  await coach('DELETE', `/v1/results/${ava2.id}`);
  await coach('POST', '/v1/results', { session_id: d.id, results: [{ client_id: ava.id, test: 'dash_40yd', value: 5.65, attempt: 2, source: 'manual' }] });
  const recent = (await coach('GET', '/v1/uploads')).body.data;
  assert.equal(recent[0].id, done.batch_id);
  assert.deepEqual([recent[0].saved, recent[0].replaced, recent[0].source, recent[0].session_name, recent[0].by_name], [3, 1, 'Freelap', 'Speed day', 'Carl Coach']);
  assert.equal((await desk('POST', `/v1/uploads/${done.batch_id}/undo`)).status, 403, 'front desk can\'t undo uploads');
  const undo = (await coach('POST', `/v1/uploads/${done.batch_id}/undo`)).body;
  assert.deepEqual([undo.removed, undo.restored, undo.kept], [1, 1, 1]);
  const day2 = (await coach('GET', `/v1/testing-sessions/${d.id}`)).body;
  assert.deepEqual(day2.athletes.find((a) => a.client_id === cole.id).results.map((r) => [r.value, r.source]), [[5.2, 'manual']], 'Cole\'s typed time is back; the broad jump is gone');
  assert.deepEqual(day2.athletes.find((a) => a.client_id === ava.id).results.map((r) => [r.value, r.source]).sort(), [[5.65, 'manual'], [5.7, 'stopwatch']], 'what changed since is left alone');
  assert.deepEqual(day2.tests.map((t) => t.key), ['dash_40yd'], 'the test the upload added comes off with nothing left');
  const twice = await coach('POST', `/v1/uploads/${done.batch_id}/undo`);
  assert.equal(twice.status, 409);
  assert.match(twice.body.error.message, /already undone/);
  assert.ok((await coach('GET', '/v1/uploads')).body.data[0].undone_at);
});

test('uploads without a testing day: the same sheet twice saves once, a corrected value replaces the earlier upload', async () => {
  const header = ['Athlete ID', 'Name', 'Date', 'Vertical jump (in)'];
  const first = await commit(await upload([header, [dana.athlete_id, 'Dana Reed', '2026-06-01', 20]]));
  assert.equal(first.created, 1);
  const same = await commit(await upload([header, [dana.athlete_id, 'Dana Reed', '2026-06-01', 20]]));
  assert.deepEqual([same.saved, same.already_saved], [0, 1]);
  const fixed = await upload([header, [dana.athlete_id, 'Dana Reed', '2026-06-01', 21]]);
  assert.deepEqual(fixed.athletes[0].results[0].was, [20]);
  const saved = await commit(fixed);
  assert.equal(saved.replaced, 1);
  const rows = (await coach('GET', `/v1/results?client_id=${dana.id}&test=vertical_standing`)).body.data;
  assert.deepEqual(rows.map((r) => r.value), [21]);
  await coach('POST', `/v1/uploads/${saved.batch_id}/undo`);
  assert.deepEqual((await coach('GET', `/v1/results?client_id=${dana.id}&test=vertical_standing`)).body.data.map((r) => r.value), [20], 'undo puts the earlier upload\'s value back');
});

test('undo a device file import: results come out and results sent to waiting are dropped, unless linked since', async () => {
  const file = ['Athlete,Date,40 Yard', `${ava.athlete_id},2026-07-01,5.55`, 'Tyler G,2026-07-01,5.9', 'Sam K,2026-07-01,6.1'].join('\n');
  const imp = (await coach('POST', '/v1/imports', { provider: 'freelap', csv: file, filename: 'freelap.csv' })).body;
  assert.equal(imp.imported, 1);
  assert.equal(imp.queued, 2);
  const q = (await coach('GET', '/v1/queue')).body.data;
  const tyler = q.find((g) => g.label === 'Tyler G');
  await coach('POST', '/v1/queue/link', { athlete_id: cole.athlete_id, provider: tyler.provider, identity: tyler.identity });
  const undo = (await coach('POST', `/v1/uploads/${imp.id}/undo`)).body;
  assert.deepEqual([undo.removed, undo.pending_removed, undo.kept], [1, 1, 1]);
  assert.ok(!(await coach('GET', '/v1/queue')).body.data.some((g) => g.label === 'Sam K'));
  assert.ok((await coach('GET', `/v1/results?client_id=${cole.id}&test=dash_40yd`)).body.data.some((r) => r.value === 5.9), 'the linked result stays, with its real source');
  assert.equal((await coach('GET', `/v1/results?client_id=${cole.id}&test=dash_40yd`)).body.data.find((r) => r.value === 5.9).source, 'csv:freelap');
});

// ---------- Waiting results and devices ----------
test('waiting results can\'t be linked to an archived athlete; a long discard works', async () => {
  const r = (await owner('POST', '/v1/results', { provider: 'swift', results: Array.from({ length: 1000 }, (_, i) => ({ athlete: { external_id: `dev-${i % 3}`, name: `Runner ${i % 3}` }, test: 'dash_40yd', value: 5 + (i % 10) / 10, external_id: `run-${i}` })) })).body;
  assert.equal(r.queued, 1000);
  const g = (await coach('GET', '/v1/queue')).body.data.find((x) => x.provider === 'swift' && x.device_id === 'dev-0');
  const refused = await coach('POST', '/v1/queue/link', { client_id: arch.id, provider: g.provider, identity: g.identity });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /archived/);
  const ids = app.ctx.db.all(`SELECT id FROM results_queue WHERE provider = 'swift' AND status = 'pending' AND identity != 'id:dev-0'`).map((x) => x.id);
  const d = await coach('POST', '/v1/queue/discard', { ids: [...ids, ...ids, ...ids, ...ids] });
  assert.deepEqual([d.status, d.body.discarded], [200, ids.length]);
});

test('link a device ahead: waiting results are linked, the device name is kept, and moving it says who had it', async () => {
  const link = (await coach('POST', '/v1/athlete-links', { provider: 'swift', external_id: 'dev-0', athlete_id: ava.athlete_id })).body;
  assert.equal(link.external_name, 'Runner 0', 'the name the device uses, not the bare ID');
  assert.ok(link.linked > 300, 'everything waiting from that device is linked');
  assert.equal(link.moved_from, null);
  const later = (await owner('POST', '/v1/results', { provider: 'Swift', results: [{ athlete: { external_id: 'dev-0' }, test: 'dash_40yd', value: 5.3, external_id: 'run-new' }] })).body;
  assert.equal(later.created, 1, 'new results from the device go straight to the athlete');
  const moved = (await coach('POST', '/v1/athlete-links', { provider: 'swift', external_id: 'dev-0', athlete_id: cole.athlete_id })).body;
  assert.deepEqual(moved.moved_from, { name: 'Ava Lopez', athlete_id: ava.athlete_id });
  assert.equal(moved.external_name, 'Runner 0');
  assert.equal((await coach('POST', '/v1/athlete-links', { provider: 'swift', external_id: 'dev-9', client_id: arch.id })).status, 400, 'archived athletes are refused');
  const byName = (await coach('POST', '/v1/athlete-links', { provider: 'brower', external_id: 'Tyler Grant', kind: 'name', athlete_id: dana.athlete_id })).body;
  assert.equal(byName.external_id, 'name:tyler grant');
  const un = (await coach('DELETE', `/v1/athlete-links/swift/${encodeURIComponent('dev-0')}`)).body;
  assert.deepEqual([un.link.external_name, un.link.client_id], ['Runner 0', cole.id], 'unlinking returns the link so the screen can undo it');
  const redo = await coach('POST', '/v1/athlete-links', { ...un.link });
  assert.equal(redo.status, 201);
  assert.equal(redo.body.external_name, 'Runner 0');
});

test('one value per attempt on a testing day: a double tap is ignored, a different value is refused', async () => {
  const d = (await coach('POST', '/v1/testing-sessions', { name: 'Slots', date: '2026-09-21', tests: ['dash_40yd'], athletes: [{ client_id: dana.id }] })).body;
  const one = { session_id: d.id, results: [{ client_id: dana.id, test: 'dash_40yd', value: 5.5, attempt: 1, source: 'manual' }] };
  assert.equal((await desk('POST', '/v1/results', one)).body.created, 1);
  const again = (await desk('POST', '/v1/results', one)).body;
  assert.deepEqual([again.created, again.duplicates], [0, 1]);
  const other = (await desk('POST', '/v1/results', { ...one, results: [{ ...one.results[0], value: 5.4 }] })).body;
  assert.match(other.errors[0].message, /Attempt 1 already has 5\.5/);
  assert.equal((await desk('DELETE', '/v1/results/x')).status, 403, 'front desk can\'t delete results');
});

test('the athlete list for linking has clients and roster players with IDs, never money, and not for front desk', async () => {
  const list = (await coach('GET', '/v1/athletes')).body.data;
  assert.ok(list.some((a) => a.client_id === ava.id && a.athlete_id === ava.athlete_id));
  assert.ok(!list.some((a) => a.client_id === arch.id), 'archived clients are left out');
  assert.ok(list.every((a) => !Object.keys(a).some((k) => k.endsWith('_cents'))));
  assert.equal((await desk('GET', '/v1/athletes')).status, 403);
  assert.equal((await desk('GET', '/v1/queue')).status, 403);
  assert.equal((await desk('POST', '/v1/athlete-links', { provider: 'swift', external_id: 'x', client_id: ava.id })).status, 403);
});

// Merge of B9 with B10: the coach's own range from the Test library is the one every way in checks against.
test('a coach-set range from the Test library applies to typed results, uploads and device imports alike', async () => {
  const t = (await owner('POST', '/v1/tests', { name: 'Wall ball', key: 'wall_ball', unit: 'reps', better: 'higher', category: 'strength', min_value: 5, max_value: 50 })).body;
  assert.deepEqual([t.metrics[0].range, t.metrics[0].range_custom], [[5, 50], true]);
  const typed = (await coach('POST', '/v1/results', { results: [{ client_id: cole.id, test: 'wall_ball', value: 80 }] })).body;
  assert.equal(typed.created, 0);
  assert.match(typed.errors[0].message, /isn't possible for Wall ball \(5–50\)/);
  const p = await upload([['Athlete ID', 'Name', 'Wall ball (reps)'], [cole.athlete_id, 'Cole Park', 80]]);
  assert.equal(p.ok, false);
  assert.match(JSON.stringify(p.errors), /isn't possible for Wall ball \(5–50\)/);
  const imp = (await coach('POST', '/v1/imports', { provider: 'generic', remember: false, csv: `Athlete,Date,Wall ball\n${cole.athlete_id},09/01/2026,80\n${cole.athlete_id},09/02/2026,30`,
    mapping: { roles: { athlete_name: 'Athlete', date: 'Date' }, columns: { 'Wall ball': { test: 'wall_ball', metric: 'value', unit: 'reps' } } } })).body;
  assert.equal(imp.imported, 1, 'the possible value is saved');
  assert.match(JSON.stringify(imp.errors), /isn't possible for Wall ball \(5–50\)/, 'the impossible one is listed as a problem');
  // Clearing the coach's range leaves no range (a custom test has no built-in one), so 80 is fine again.
  await owner('PATCH', '/v1/tests/wall_ball', { metrics: [{ key: 'value', min_value: '', max_value: '' }] });
  assert.equal((await coach('POST', '/v1/results', { results: [{ client_id: cole.id, test: 'wall_ball', value: 80 }] })).body.created, 1);
});
