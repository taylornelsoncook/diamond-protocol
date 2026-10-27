import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { exportFamily } from '../src/services/legal.js';
import { zonedToUtc } from '../src/util.js';
import { getSetting } from '../src/services/families.js';

// Profile tags (owner's ask: "tag profiles with certain things based off when they sign up: anyone who signs up from now
// until February 28th gets a highlighted legacy star by their name"; schema 90, services/profiletags.js).
let app, base, owner, coach, desk, legacy;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* a file */ }
    return { status: r.status, body: json, text };
  };
}
const tz = () => getSetting(app.ctx, 'timezone');
// A client made at a business-local day and time.
async function madeAt(name, day, time = '12:00', extra = {}) {
  const c = (await owner('POST', '/v1/clients', { name, parent: { name: `${name} Parent`, email: `${name.toLowerCase().replace(/\W/g, '.')}@example.com` }, send_welcome: false, ...extra })).body;
  app.ctx.db.run('UPDATE clients SET created_at = ? WHERE id = ?', zonedToUtc(day, time, tz()), c.id);
  return c;
}
const tagsOf = async (id) => (await owner('GET', `/v1/clients/${id}`)).body.tags.map((t) => `${t.name}:${t.how}`);

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dee', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  [owner, coach, desk] = await Promise.all(['owner@test.dev', 'coach@test.dev', 'desk@test.dev'].map(signIn));
});
after(() => app.server.close());

test('a tag goes on every profile made in its dates (both days counted, business time), however it was made', async () => {
  const r = await owner('POST', '/v1/profile-tags', { name: 'Legacy', starts_on: '2026-10-18', ends_on: '2027-02-28' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  legacy = r.body;
  assert.deepEqual([legacy.icon, legacy.symbol, legacy.color, legacy.hex], ['star', '★', 'gold', '#D4A72C'], 'a gold star unless told otherwise');
  const before = await madeAt('Ava Before', '2026-10-17', '23:59');
  const first = await madeAt('Ben First', '2026-10-18', '00:00');
  const last = await madeAt('Cal Last', '2027-02-28', '23:59');
  const after = await madeAt('Dia After', '2027-03-01', '00:00');
  assert.deepEqual(await tagsOf(before.id), []);
  assert.deepEqual(await tagsOf(first.id), ['Legacy:dates']);
  assert.deepEqual(await tagsOf(last.id), ['Legacy:dates']);
  assert.deepEqual(await tagsOf(after.id), []);
  // The client list carries the tags and filters by one.
  const list = (await owner('GET', `/v1/clients?tag=${legacy.id}`)).body.data.map((c) => c.name).sort();
  assert.deepEqual(list, ['Ben First', 'Cal Last']);
  assert.equal((await owner('GET', '/v1/profile-tags')).body.data[0].clients, 2);
  // Moving the dates changes who has it at once.
  await owner('PATCH', `/v1/profile-tags/${legacy.id}`, { ends_on: '2027-03-01' });
  assert.deepEqual(await tagsOf(after.id), ['Legacy:dates']);
  await owner('PATCH', `/v1/profile-tags/${legacy.id}`, { ends_on: '2027-02-28' });
  // A profile made today (the default start is today) with no end date.
  const open = (await owner('POST', '/v1/profile-tags', { name: 'Founders', icon: 'crown', color: 'green' })).body;
  assert.deepEqual([open.ends_on, open.symbol], [null, '♛']);
  const now = (await owner('POST', '/v1/clients', { name: 'Eve Now', email: 'eve@example.com', send_welcome: false })).body;
  assert.ok(now.tags.some((t) => t.name === 'Founders'), 'made today, inside an open-ended tag');
  await owner('DELETE', `/v1/profile-tags/${open.id}`);
  assert.ok(!(await tagsOf(now.id)).some((t) => t.startsWith('Founders')), 'a deleted tag leaves every profile');
});

test('team-only athletes count only when the tag says so; the owner adds or removes a tag on one profile', async () => {
  const org = (await owner('POST', '/v1/organizations', { name: 'Westlake High', kind: 'school', contact_email: 'ad@westlake.example' })).body;
  const team = (await owner('POST', '/v1/team-contracts', { org_id: org.id, name: 'Football', monthly_cents: 100000, start_date: '2026-10-01', past: 'none' })).body;
  assert.equal((await owner('POST', `/v1/team-contracts/${team.id}/roster`, { names: 'Finn Roster' })).status, 201);
  const finn = app.ctx.db.get(`SELECT id FROM clients WHERE name = 'Finn Roster'`);
  app.ctx.db.run('UPDATE clients SET created_at = ? WHERE id = ?', zonedToUtc('2026-11-02', '10:00', tz()), finn.id);
  assert.deepEqual(await tagsOf(finn.id), [], 'a coach adding a roster isn\'t a sign-up');
  await owner('PATCH', `/v1/profile-tags/${legacy.id}`, { team_only: true });
  assert.deepEqual(await tagsOf(finn.id), ['Legacy:dates']);
  await owner('PATCH', `/v1/profile-tags/${legacy.id}`, { team_only: false });
  // By hand: on for someone outside the dates, off for someone inside them.
  const ava = app.ctx.db.get(`SELECT id FROM clients WHERE name = 'Ava Before'`), ben = app.ctx.db.get(`SELECT id FROM clients WHERE name = 'Ben First'`);
  assert.equal((await owner('POST', `/v1/clients/${ava.id}/tags`, { tag_id: legacy.id, on: true })).status, 200);
  assert.deepEqual(await tagsOf(ava.id), ['Legacy:hand']);
  await owner('POST', `/v1/clients/${ben.id}/tags`, { tag_id: legacy.id, on: false });
  assert.deepEqual(await tagsOf(ben.id), []);
  // Hand changes outlast new dates; putting one back the way the dates say leaves no hand change behind.
  await owner('PATCH', `/v1/profile-tags/${legacy.id}`, { starts_on: '2026-01-01' });
  assert.deepEqual([await tagsOf(ava.id), await tagsOf(ben.id)], [['Legacy:hand'], []]);
  await owner('POST', `/v1/clients/${ava.id}/tags`, { tag_id: legacy.id, on: true });
  assert.deepEqual(await tagsOf(ava.id), ['Legacy:dates']);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM client_tags WHERE client_id = ?', ava.id).n, 0);
  await owner('PATCH', `/v1/profile-tags/${legacy.id}`, { starts_on: '2026-10-18' });
  await owner('POST', `/v1/clients/${ben.id}/tags`, { tag_id: legacy.id, on: true });
  assert.equal((await owner('POST', `/v1/clients/${ben.id}/tags`, { tag_id: legacy.id })).status, 400, 'on must be said');
  assert.equal((await owner('POST', `/v1/clients/${ben.id}/tags`, { tag_id: 'tag_nope', on: true })).status, 404);
});

test('checks: names unique, real dates in order, known symbols and colours', async () => {
  assert.equal((await owner('POST', '/v1/profile-tags', { name: 'legacy' })).status, 409);
  assert.equal((await owner('POST', '/v1/profile-tags', { name: 'X', starts_on: '2027-03-01', ends_on: '2027-02-28' })).status, 400);
  assert.equal((await owner('POST', '/v1/profile-tags', { name: 'X', starts_on: 'soon' })).status, 400);
  assert.equal((await owner('POST', '/v1/profile-tags', { name: 'X', icon: 'rocket' })).status, 400);
  assert.equal((await owner('POST', '/v1/profile-tags', { name: 'X', color: 'pink' })).status, 400);
  assert.equal((await owner('POST', '/v1/profile-tags', { name: '  ' })).status, 400);
});

test('staff see the tags; only the owner makes them or changes one profile; the export and CSV carry them', async () => {
  const ben = app.ctx.db.get(`SELECT id, family_id FROM clients WHERE name = 'Ben First'`);
  for (const who of [coach, desk]) {
    assert.equal((await who('GET', '/v1/profile-tags')).status, 200);
    assert.ok((await who('GET', `/v1/clients/${ben.id}`)).body.tags.some((t) => t.name === 'Legacy'));
    assert.equal((await who('POST', '/v1/profile-tags', { name: 'Mine' })).status, 403);
    assert.equal((await who('PATCH', `/v1/profile-tags/${legacy.id}`, { name: 'Mine' })).status, 403);
    assert.equal((await who('DELETE', `/v1/profile-tags/${legacy.id}`)).status, 403);
    assert.equal((await who('POST', `/v1/clients/${ben.id}/tags`, { tag_id: legacy.id, on: false })).status, 403);
  }
  const exported = exportFamily(app.ctx, ben.family_id);
  assert.deepEqual(exported.athletes[0].profile_tags, [{ tag: 'Legacy', how: 'joined in its dates' }]);
  const csv = await owner('GET', `/v1/client-export?tag=${legacy.id}`);
  assert.match(csv.text, /Tags/);
  assert.match(csv.text, /Ben First.*Legacy/);
});

test('the version 89 upgrade adds the tag tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-v89-')), file = join(dir, 'dp.db');
  const raw = new DatabaseSync(file);
  raw.exec(readFileSync('test/fixtures/schema-v89.sql', 'utf8'));
  raw.exec('PRAGMA user_version = 89');
  raw.close();
  const db = openDb(file);
  assert.equal(db.get('PRAGMA user_version').user_version, 94);
  for (const t of ['profile_tags', 'client_tags']) assert.ok(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t), t);
  db.close();
});
