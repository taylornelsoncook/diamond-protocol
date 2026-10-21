import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

// Groups (version 87): a named group of athletes under Teams (Kings 2031) that the owner renames, puts athletes in;
// each athlete sees how many times they attended, their best sprint times and a board where they message the coach
// and everyone in the group reads it.
let app, base, owner, coach, desk, ava, ben, cole, token, benToken, parentCookie, coachUserId;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const asAthlete = (tok) => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-client-token': tok, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const parent = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { cookie: parentCookie, origin: base, 'x-athlete-id': ava.id, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const mailTo = (email) => app.ctx.db.all(`SELECT subject, body FROM outbox WHERE to_email = ? AND subject NOT LIKE 'Welcome%' ORDER BY rowid`, email);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  coachUserId = createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley Reyes', password: PW, role: 'coach' }).id;
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_f', 'Facility', 'facility', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  cole = (await coach('POST', '/v1/clients', { name: 'Cole Nguyen', email: 'cole@example.com' })).body;
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', ava.id).access_token;
  benToken = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', ben.id).access_token;
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com' }) })).json()).dev_code;
  const ver = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com', code }) });
  parentCookie = ver.headers.get('set-cookie').split(';')[0];
});
after(() => app.server.close());

let group;
test('owners and coaches make and rename a group; names are unique; front desk looks and never writes', async () => {
  const made = await owner('POST', '/v1/groups', { name: 'Kings 2031', note: 'Club team, class of 2031', coach_id: coachUserId });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  group = made.body;
  assert.deepEqual([group.name, group.coach_name, group.members, group.messages, group.unanswered], ['Kings 2031', 'Riley Reyes', 0, 0, 0]);
  assert.equal((await coach('POST', '/v1/groups', { name: 'kings 2031' })).status, 409, 'the same name ignoring case');
  assert.equal((await coach('POST', '/v1/groups', { name: 'x'.repeat(61) })).status, 400);
  assert.equal((await coach('POST', '/v1/groups', { name: 'Queens', coach_id: 'nobody' })).status, 400, 'the coach must be a staff account');
  const renamed = await coach('PATCH', `/v1/groups/${group.id}`, { name: 'Kings 2031 Elite' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.name, 'Kings 2031 Elite');
  assert.equal((await coach('PATCH', `/v1/groups/${group.id}`, { name: 'Kings 2031' })).body.name, 'Kings 2031');
  assert.equal((await desk('GET', '/v1/groups')).status, 200, 'front desk may look');
  assert.equal((await desk('POST', '/v1/groups', { name: 'Desk group' })).status, 403);
  assert.equal((await desk('PATCH', `/v1/groups/${group.id}`, { name: 'Nope' })).status, 403);
  assert.equal((await desk('POST', `/v1/groups/${group.id}/messages`, { body: 'hi' })).status, 403);
});

test('athletes go in by id or Athlete ID; duplicates and archived athletes are skipped and named; an unknown id refuses the lot', async () => {
  const bad = await coach('POST', `/v1/groups/${group.id}/members`, { client_ids: [ava.id, 'cli_nobody'] });
  assert.equal(bad.status, 400);
  assert.equal((await coach('GET', `/v1/groups/${group.id}`)).body.members.length, 0, 'nothing saved when one id is wrong');
  const added = await coach('POST', `/v1/groups/${group.id}/members`, { client_ids: [ava.id, ben.athlete_id, ava.id] });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(added.body.added.map((a) => a.name), ['Ava Lopez', 'Ben Park']);
  assert.deepEqual(added.body.skipped, []);
  const again = await coach('POST', `/v1/groups/${group.id}/members`, { client_ids: [ava.id, cole.id] });
  assert.deepEqual([again.body.added.map((a) => a.name), again.body.skipped.map((s) => s.reason)], [['Cole Nguyen'], ['already in the group']]);
  assert.equal((await coach('DELETE', `/v1/groups/${group.id}/members/${cole.id}`)).status, 200);
  assert.equal((await coach('DELETE', `/v1/groups/${group.id}/members/${cole.id}`)).status, 404);
  assert.equal((await owner('GET', '/v1/groups')).body.data[0].members, 2);
});

test('the coach sees each athlete\'s attendance and best sprint times; the athlete sees their own once a day is shared', async () => {
  // Ava: a class attended, a team session and a door check-in = 3 times; two 40s (the better one counts) and a 10-yard sprint.
  const session = (await owner('POST', '/v1/sessions', { name: 'Speed class', kind: 'group', location_id: 'loc_f', date: '2026-10-10', start_time: '10:00', capacity: 10 })).body;
  const booking = (await owner('POST', `/v1/sessions/${session.id}/bookings`, { client_id: ava.id })).body;
  assert.equal((await owner('POST', `/v1/bookings/${booking.id}/attendance`, { status: 'attended' })).status, 200);
  const teamSession = newId('cls');
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Team lift', 'team', 'loc_f', '2026-10-11T16:00:00.000Z', '2026-10-11T17:00:00.000Z', 20, 'scheduled', ?)`, teamSession, app.ctx.now());
  app.ctx.db.run('INSERT INTO team_attendance (session_id, client_id, created_at) VALUES (?, ?, ?)', teamSession, ava.id, app.ctx.now());
  app.ctx.db.run(`INSERT INTO check_ins (id, client_id, location_id, covered_by, created_at) VALUES (?, ?, 'loc_f', 'credit', ?)`, newId('ci'), ava.id, app.ctx.now());
  const results = await coach('POST', '/v1/results', { results: [
    { athlete: { client_id: ava.id }, test: 'dash_40yd', metric: 'time', value: 5.2, unit: 's', recorded_at: '2026-09-01T10:00:00.000Z' },
    { athlete: { client_id: ava.id }, test: 'dash_40yd', metric: 'time', value: 5.05, unit: 's', recorded_at: '2026-10-01T10:00:00.000Z' },
    { athlete: { client_id: ava.id }, test: 'dash_40yd', metric: 'split_10', value: 1.7, unit: 's', recorded_at: '2026-10-01T10:00:00.000Z' },
    { athlete: { client_id: ava.id }, test: 'dash_10yd', metric: 'time', value: 1.78, unit: 's', recorded_at: '2026-10-01T10:00:00.000Z' },
    { athlete: { client_id: ben.id }, test: 'pro_agility', metric: 'time', value: 4.6, unit: 's', recorded_at: '2026-10-01T10:00:00.000Z' }   // agility isn't a sprint
  ] });
  assert.equal(results.status, 201, JSON.stringify(results.body));
  const g = (await coach('GET', `/v1/groups/${group.id}`)).body;
  const a = g.members.find((m) => m.client_id === ava.id), b = g.members.find((m) => m.client_id === ben.id);
  assert.equal(a.attended, 3);
  assert.deepEqual(a.bests.map((x) => [x.test, x.value]), [['dash_40yd', 5.05], ['dash_10yd', 1.78]], 'the best time per sprint test, the primary metric only');
  assert.deepEqual([b.attended, b.bests], [0, []]);
  assert.deepEqual(g.tests.map((t) => t.test), ['dash_40yd', 'dash_10yd'], 'the columns are the tests with a best among the members');
  // Front desk reads the same page.
  assert.equal((await desk('GET', `/v1/groups/${group.id}`)).status, 200);
  // The athlete: the group with their own numbers. Results from the API with no testing day aren't shared yet.
  const athlete = asAthlete(token);
  let mine = (await athlete('GET', '/app/api/groups')).body;
  assert.equal(mine.data.length, 1);
  assert.deepEqual([mine.data[0].name, mine.data[0].coach_name, mine.data[0].members, mine.data[0].teammates], ['Kings 2031', 'Riley Reyes', 2, ['Ben P.']]);
  assert.deepEqual([mine.you.attended, mine.you.bests], [3, []]);
  await owner('PATCH', '/v1/settings', { share_results: 'all' });
  mine = (await athlete('GET', '/app/api/groups')).body;
  assert.deepEqual(mine.you.bests.map((x) => [x.test, x.value, x.unit]), [['dash_40yd', 5.05, 's'], ['dash_10yd', 1.78, 's']]);
  // Someone not in any group sees none.
  assert.deepEqual((await asAthlete(benToken)('GET', '/app/api/groups')).body.data.map((x) => x.id), [group.id]);
});

test('the board: athletes and parents write, everyone in the group reads, the coach is emailed and answers; hide and take back', async () => {
  const athlete = asAthlete(token);
  const first = await athlete('POST', `/app/api/groups/${group.id}/messages`, { body: 'Coach, is Saturday still 9 am?' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual([first.body.author_kind, first.body.author_name, first.body.mine], ['athlete', 'Ava', true]);
  assert.equal((await athlete('POST', `/app/api/groups/${group.id}/messages`, { body: '' })).status, 400);
  // The coach is emailed once (the second message within the hour doesn't email again).
  await asAthlete(benToken)('POST', `/app/api/groups/${group.id}/messages`, { body: 'Same question.' });
  const mails = mailTo('coach@test.dev');
  assert.equal(mails.length, 1, JSON.stringify(mails));
  assert.match(mails[0].subject, /Kings 2031: a message from Ava/);
  assert.match(mails[0].body, /Everyone in the group can read it/);
  assert.match(mails[0].body, new RegExp(`/#/teams/groups/${group.id}`));
  // The list shows it waiting for an answer; the coach answers and it's cleared; the answer taps the phones.
  assert.equal((await owner('GET', '/v1/groups')).body.data[0].unanswered, 2);
  const reply = await coach('POST', `/v1/groups/${group.id}/messages`, { body: 'Yes, 9 am sharp. Bring spikes.' });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.deepEqual([reply.body.author_kind, reply.body.author_name], ['staff', 'Riley Reyes']);
  assert.equal((await owner('GET', '/v1/groups')).body.data[0].unanswered, 0);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'group.message'`).n, 3);
  // A parent writes for their athlete through the family's frame, under their own name.
  const fromParent = await parent('POST', `/app/api/groups/${group.id}/messages`, { body: 'Maria here: Ava will be 10 minutes late.' });
  assert.equal(fromParent.status, 201, JSON.stringify(fromParent.body));
  assert.deepEqual([fromParent.body.author_kind, fromParent.body.author_name], ['parent', "Maria Lopez (Ava's parent)"]);
  // Everyone in the group reads the whole board, newest first; someone outside it gets nothing.
  const board = (await athlete('GET', '/app/api/groups')).body.data[0].board;
  assert.deepEqual(board.data.map((m) => m.author_name), ["Maria Lopez (Ava's parent)", 'Riley Reyes', 'Ben', 'Ava']);
  assert.deepEqual(board.data.map((m) => m.mine), [true, false, false, true]);
  assert.equal((await asAthlete(app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', cole.id).access_token)('GET', `/app/api/groups/${group.id}/messages`)).status, 404);
  assert.equal((await asAthlete(app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', cole.id).access_token)('POST', `/app/api/groups/${group.id}/messages`, { body: 'Let me in' })).status, 404);
  // The coach hides Ben's message: staff still see it marked, athletes don't.
  const benMsg = board.data.find((m) => m.author_name === 'Ben');
  const hidden = await coach('DELETE', `/v1/group-messages/${benMsg.id}`);
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.deepEqual([hidden.body.hidden, hidden.body.hidden_by], [true, 'Riley Reyes']);
  assert.equal((await athlete('GET', `/app/api/groups/${group.id}/messages`)).body.data.some((m) => m.id === benMsg.id), false);
  const staffBoard = (await coach('GET', `/v1/groups/${group.id}/messages`)).body;
  assert.equal(staffBoard.data.find((m) => m.id === benMsg.id).hidden, true);
  assert.equal((await coach('POST', `/v1/group-messages/${benMsg.id}/unhide`)).body.hidden, false);
  // Ava takes back her own message, never the coach's; paging works.
  assert.equal((await athlete('DELETE', `/app/api/group-messages/${reply.body.id}`)).status, 404);
  assert.equal((await athlete('DELETE', `/app/api/group-messages/${first.body.id}`)).status, 200);
  const page = (await athlete('GET', `/app/api/groups/${group.id}/messages?limit=2`)).body;
  assert.equal(page.data.length, 2);
  assert.ok(page.next);
  assert.equal((await athlete('GET', `/app/api/groups/${group.id}/messages?limit=2&before=${encodeURIComponent(page.next)}`)).body.data.length, 1);
  // The family export carries the groups and what the family wrote.
  const familyId = app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', ava.id).family_id;
  const exported = await owner('GET', `/v1/families/${familyId}/export`);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const k = exported.body.athletes.find((x) => x.name === 'Ava Lopez');
  assert.deepEqual(k.groups.map((x) => x.name), ['Kings 2031']);
  assert.deepEqual(k.group_messages.map((m) => m.author_kind), ['parent']);
});

test('deleting a group with athletes or messages asks first; the athletes\' profiles are untouched', async () => {
  const del = await owner('DELETE', `/v1/groups/${group.id}`, {});
  assert.equal(del.status, 409);
  assert.equal(del.body.error.code, 'confirm_needed');
  assert.equal((await owner('DELETE', `/v1/groups/${group.id}`, { confirm: true })).status, 200);
  assert.equal((await owner('GET', '/v1/groups')).body.data.length, 0);
  assert.equal((await owner('GET', `/v1/clients/${ava.id}`)).status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM group_messages').n, 0);
});

test('the version 86 upgrade adds the group tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-v86-')), file = join(dir, 'dp.db');
  const raw = new DatabaseSync(file);
  raw.exec(readFileSync('test/fixtures/schema-v86.sql', 'utf8'));
  raw.exec('PRAGMA user_version = 86');
  raw.close();
  const db = openDb(file);
  assert.equal(db.get('PRAGMA user_version').user_version, 92);
  assert.deepEqual(db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('groups', 'group_members', 'group_messages') ORDER BY name`).map((r) => r.name), ['group_members', 'group_messages', 'groups']);
  db.close();
});
