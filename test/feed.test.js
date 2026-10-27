import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

// The team feed (the builder redesign, step 6): coaches post to everyone, a team or a program, pinned for a period;
// athletes and parents bump and comment; coaches hide comments; pinned posts reach the weight-room screen.
let app, base, owner, coach, desk, ava, ben, token, parentCookie, teamId, programId, kioskKey;
const PW = 'correct-horse-battery';
const MIN = 60000;
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const athlete = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-client-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const parent = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { cookie: parentCookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tv = async (path) => (await fetch(base + path, { headers: { 'x-kiosk-key': kioskKey } })).json();
before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_f', 'Facility', 'facility', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', ava.id).access_token;
  // Ava is on a team; Ben is on a program.
  const org = (await owner('POST', '/v1/organizations', { name: 'Hill Country FC' })).body;
  const team = await owner('POST', '/v1/team-contracts', { org_id: org.id, name: '14U Girls', monthly_cents: 50000, start_date: '2026-09-01' });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  teamId = team.body.id;
  assert.equal((await owner('POST', `/v1/team-contracts/${teamId}/roster`, { client_id: ava.id })).status, 201);
  programId = (await coach('POST', '/v1/programs', { name: 'Speed', weeks: 1 })).body.id;
  await coach('POST', `/v1/programs/${programId}/assign`, { client_id: ben.id });
  // A team session running now at the facility, and the weight-room screen's key.
  const series = newId('ser'), session = newId('cls');
  const s = new Date(Date.now() - 10 * MIN).toISOString(), e = new Date(Date.now() + 50 * MIN).toISOString();
  app.ctx.db.run(`INSERT INTO class_series (id, name, kind, location_id, weekdays, start_time, duration_min, capacity, contract_id, start_date, created_at) VALUES (?, 'Team lift', 'team', 'loc_f', '[1]', '16:00', 60, 20, ?, '2026-09-01', ?)`, series, teamId, s);
  app.ctx.db.run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, ?, 'Team lift', 'team', 'loc_f', ?, ?, 20, 'scheduled', ?)`, session, series, s, e, s);
  kioskKey = (await owner('POST', '/v1/kiosks', { location_id: 'loc_f', name: 'Weight room' })).body.screen_link.split('#')[1];
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com' }) })).json()).dev_code;
  const ver = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com', code }) });
  parentCookie = ver.headers.get('set-cookie').split(';')[0];
});
after(() => app.server.close());

test('coaches post to everyone, a team or a program; each athlete and family sees their own feed, pinned first; front desk reads only', async () => {
  const all = await coach('POST', '/v1/feed', { audience: 'everyone', title: 'Welcome back', body: 'Fall block starts Monday.' });
  assert.equal(all.status, 201, JSON.stringify(all.body));
  assert.deepEqual([all.body.audience_label, all.body.author_name, all.body.pinned, all.body.bumps, all.body.comments], ['Everyone', 'Riley', false, 0, []]);
  const team = (await coach('POST', '/v1/feed', { audience: 'team', contract_id: teamId, body: 'Girls: bring cleats Saturday.', pin_days: 7 })).body;
  assert.deepEqual([team.audience_label, team.pinned], ['Hill Country FC 14U Girls', true]);
  const prog = (await coach('POST', '/v1/feed', { audience: 'program', program_id: programId, title: 'Speed', body: 'Week 1 is up.' })).body;
  assert.equal(prog.audience_label, 'Speed');
  assert.equal((await coach('POST', '/v1/feed', { audience: 'team', body: 'x' })).status, 400, 'a team post needs a team');
  assert.equal((await coach('POST', '/v1/feed', { audience: 'everyone', body: 'x', pin_days: 400 })).status, 400);
  assert.equal((await coach('POST', '/v1/feed', { audience: 'everyone', body: 'x', link_url: 'http://x.example' })).status, 400, 'links are https');
  // Staff see everything, pinned first; the audience filter narrows it.
  const staff = (await coach('GET', '/v1/feed')).body;
  assert.deepEqual(staff.data.map((p) => p.id), [team.id, prog.id, all.body.id]);
  assert.deepEqual((await desk('GET', '/v1/feed?audience=program')).body.data.map((p) => p.id), [prog.id], 'front desk may read');
  assert.equal((await desk('POST', '/v1/feed', { audience: 'everyone', body: 'x' })).status, 403, 'front desk never posts');
  // Ava (on the team) sees the team post and the everyone post, not the program's; Ben the other way round.
  const mine = (await athlete('GET', '/app/api/feed')).body;
  assert.deepEqual(mine.data.map((p) => p.id), [team.id, all.body.id]);
  assert.equal(mine.data[0].author_id, undefined, 'no staff ids leave the building');
  const benToken = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', ben.id).access_token;
  const bens = await (await fetch(`${base}/app/api/feed`, { headers: { 'x-client-token': benToken } })).json();
  assert.deepEqual(bens.data.map((p) => p.id), [prog.id, all.body.id]);
  // Maria's family (Ava) sees Ava's feed.
  assert.deepEqual((await parent('GET', '/portal/api/feed')).body.data.map((p) => p.id), [team.id, all.body.id]);
  // The event, and a push notice for everyone the post reached.
  assert.ok(app.ctx.db.get(`SELECT 1 FROM events WHERE type = 'feed.posted'`));
  // Paging.
  const page = (await coach('GET', '/v1/feed?limit=2')).body;
  assert.equal(page.data.length, 2); assert.ok(page.next);
});

test('bumps and comments: athletes and parents react and comment on what they can see, take back their own; coaches hide, unhide and close comments', async () => {
  const post = (await coach('POST', '/v1/feed', { audience: 'team', contract_id: teamId, body: 'Great session today.' })).body;
  const prog = (await coach('POST', '/v1/feed', { audience: 'program', program_id: programId, body: 'Program only.' })).body;
  assert.deepEqual((await athlete('POST', `/app/api/feed/${post.id}/react`, {})).body, { bumped: true, bumps: 1 });
  assert.deepEqual((await parent('POST', `/portal/api/feed/${post.id}/react`, {})).body, { bumped: true, bumps: 2 });
  assert.deepEqual((await athlete('POST', `/app/api/feed/${post.id}/react`, {})).body, { bumped: false, bumps: 1 }, 'a second tap takes it back');
  assert.equal((await athlete('POST', `/app/api/feed/${prog.id}/react`, {})).status, 404, 'not her post to see');
  assert.equal((await parent('POST', `/portal/api/feed/${prog.id}/comments`, { body: 'x' })).status, 404);
  const c1 = await athlete('POST', `/app/api/feed/${post.id}/comments`, { body: 'Thanks coach!' });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.deepEqual([c1.body.by_kind, c1.body.author_name, c1.body.mine], ['athlete', 'Ava', true]);
  const c2 = (await parent('POST', `/portal/api/feed/${post.id}/comments`, { body: 'See you Saturday.' })).body;
  assert.deepEqual([c2.by_kind, c2.author_name], ['parent', 'Maria Lopez']);
  const c3 = (await coach('POST', `/v1/feed/${post.id}/comments`, { body: 'Bring water.' })).body;
  assert.equal(c3.by_kind, 'staff');
  let seen = (await athlete('GET', '/app/api/feed')).body.data.find((p) => p.id === post.id);
  assert.deepEqual(seen.comments.map((c) => [c.author_name, c.mine]), [['Ava', true], ['Maria Lopez', false], ['Riley', false]]);
  assert.deepEqual([seen.bumps, seen.bumped, seen.comment_count], [1, false, 3]);
  // Maria takes hers back; Ava can't take Riley's.
  assert.equal((await parent('DELETE', `/portal/api/feed/comments/${c2.id}`)).status, 200);
  assert.equal((await athlete('DELETE', `/app/api/feed/comments/${c3.id}`)).status, 404);
  // The coach hides Ava's: the family no longer sees it, staff see it marked, unhide brings it back.
  assert.deepEqual((await coach('DELETE', `/v1/feed/comments/${c1.body.id}`)).body, { hidden: true });
  seen = (await athlete('GET', '/app/api/feed')).body.data.find((p) => p.id === post.id);
  assert.deepEqual(seen.comments.map((c) => c.author_name), ['Riley']);
  const staffView = (await coach('GET', '/v1/feed')).body.data.find((p) => p.id === post.id);
  assert.deepEqual(staffView.comments.map((c) => [c.author_name, c.hidden, c.hidden_by]), [['Ava', true, 'Riley'], ['Riley', false, null]]);
  assert.equal(staffView.comment_count, 1);
  assert.deepEqual((await coach('POST', `/v1/feed/comments/${c1.body.id}/unhide`, {})).body, { hidden: false });
  // Closing comments: athletes get 409, a coach still can. Editing a post; unpinning; deleting.
  assert.equal((await coach('PATCH', `/v1/feed/${post.id}`, { comments_open: false })).body.comments_open, false);
  assert.equal((await athlete('POST', `/app/api/feed/${post.id}/comments`, { body: 'x' })).status, 409);
  assert.equal((await coach('POST', `/v1/feed/${post.id}/comments`, { body: 'Closing this one.' })).status, 201);
  const edited = (await coach('PATCH', `/v1/feed/${post.id}`, { title: 'Saturday', pin_days: 3 })).body;
  assert.deepEqual([edited.title, edited.pinned], ['Saturday', true]);
  assert.equal((await coach('PATCH', `/v1/feed/${post.id}`, { pin_days: 0 })).body.pinned, false);
  assert.equal((await desk('PATCH', `/v1/feed/${post.id}`, { title: 'x' })).status, 403);
  assert.equal((await coach('DELETE', `/v1/feed/${post.id}`)).status, 200);
  assert.equal((await athlete('GET', '/app/api/feed')).body.data.some((p) => p.id === post.id), false);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM feed_comments WHERE post_id = ?', post.id).n, 0, 'comments go with the post');
});

test('the weight-room screen shows pinned posts to everyone and to the team on now; the family export carries their comments and bumps', async () => {
  app.ctx.db.run('DELETE FROM feed_posts');
  const pinnedAll = (await coach('POST', '/v1/feed', { audience: 'everyone', title: 'Facility closed Friday', body: 'Back Monday.', pin_days: 5 })).body;
  const pinnedTeam = (await coach('POST', '/v1/feed', { audience: 'team', contract_id: teamId, body: 'Girls: film day Thursday.', pin_days: 5 })).body;
  await coach('POST', '/v1/feed', { audience: 'everyone', body: 'Not pinned.' });
  await coach('POST', '/v1/feed', { audience: 'everyone', body: 'Pinned but not for the screen.', pin_days: 2, on_screen: false });
  await coach('POST', '/v1/feed', { audience: 'program', program_id: programId, body: 'A program post never shows on the screen.', pin_days: 2 });
  const board = await tv('/kiosk-api/screen');
  assert.deepEqual(board.posts.map((p) => p.id), [pinnedTeam.id, pinnedAll.id]);
  assert.deepEqual(board.posts.map((p) => p.audience_label), ['Hill Country FC 14U Girls', 'Everyone']);
  // The family export.
  await athlete('POST', `/app/api/feed/${pinnedAll.id}/react`, {});
  await parent('POST', `/portal/api/feed/${pinnedAll.id}/comments`, { body: 'Noted, thanks.' });
  const exp = (await owner('GET', `/v1/families/${ava.family.id}/export`)).body;
  assert.deepEqual(exp.team_feed_comments.map((c) => [c.author_name, c.body, c.post_title]), [['Maria Lopez', 'Noted, thanks.', 'Facility closed Friday']]);
  assert.equal(exp.team_feed_bumps.length, 1);
});

test('a version 77 database gains the feed tables, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v77-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v77.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 77');
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('p1', 'Speed', 1, '2026-01-01T00:00:00Z');`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 93, `round ${round}`);
      assert.deepEqual(d.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'feed_%' ORDER BY name`).map((t) => t.name), ['feed_comments', 'feed_posts', 'feed_reactions']);
      assert.equal(d.get('SELECT name FROM programs WHERE id = ?', 'p1').name, 'Speed');
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
