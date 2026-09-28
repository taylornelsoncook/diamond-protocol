// One profile per athlete: every team roster athlete is a client. Adding to a roster always ends with a client profile,
// and results, uploads, device links, walk-ups, queue linking and team attendance all land on that profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDaysToDate, localDate } from '../src/util.js';

const TZ = 'America/Chicago';
let app, base, owner, coach, desk, facility, plan, contract;

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
async function parent(email) {
  const { body } = await req('POST', '/portal/api/login', { email });
  return as((await req('POST', '/portal/api/verify', { email, code: body.dev_code })).cookie);
}
const today = () => localDate(new Date().toISOString(), TZ);
const rosterOf = async (id) => (await owner('GET', `/v1/team-contracts/${id}`)).body.roster;

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'desk-password-1', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  coach = await signIn('coach@test.dev', 'coach-password-1');
  desk = await signIn('desk@test.dev', 'desk-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 9900, trial_days: 0 })).body;
  contract = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Westlake HS', kind: 'school' }, name: 'Varsity', monthly_cents: 100000 })).body;
});
after(() => app.server.close());

test('every way onto a roster ends with a client profile, and team-only athletes are clients but not active clients', async () => {
  const before = (await owner('GET', '/v1/client-counts')).body;
  const dashBefore = (await owner('GET', '/v1/dashboard')).body;
  const ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  await owner('POST', `/v1/clients/${ava.id}/card/test`);
  await owner('POST', `/v1/clients/${ava.id}/subscription`, { plan_id: plan.id });

  // Typed: a new client with the position, grad year and school, no family and no membership.
  const typed = await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { name: 'Jalen Brooks', position: 'QB', grad_year: 2027 });
  assert.equal(typed.status, 201);
  const jalenLine = typed.body.data.find((a) => a.name === 'Jalen Brooks');
  assert.ok(jalenLine.client_id);
  const jalen = (await owner('GET', `/v1/clients/${jalenLine.client_id}`)).body;
  assert.deepEqual([jalen.position, jalen.grad_year, jalen.school, jalen.family, jalen.status], ['QB', 2027, 'Westlake HS', null, 'none']);
  assert.equal(jalenLine.athlete_id, jalen.athlete_id, 'the roster shows the profile\'s Athlete ID');
  assert.equal(app.ctx.db.get('SELECT athlete_id FROM team_roster WHERE id = ?', jalenLine.id).athlete_id, jalen.athlete_id, 'the roster line keeps a copy of the same ID');
  assert.ok(jalen.app_link, 'a team athlete gets the workout app too');

  // By exact Athlete ID: links the client, never a new one.
  const byId = (await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { athlete_id: ava.athlete_id.toLowerCase(), position: 'WR' })).body;
  assert.deepEqual([byId.added, byId.linked], [0, 1]);
  assert.equal(byId.data.find((a) => a.client_id === ava.id).name, 'Ava Lopez');
  assert.equal((await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { athlete_id: ava.athlete_id })).status, 409, 'already on it');
  assert.equal((await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { athlete_id: 'NOPNOP2026' })).status, 400);
  assert.equal((await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { client_id: 'cli_nope', name: 'X Y' })).status, 404);

  // A pasted list: new names become clients, an Athlete ID links, a matching name waits for the coach's choice.
  const sam = (await owner('POST', '/v1/clients', { name: 'Sam Whitaker', email: 'sam@example.com' })).body;
  const cole = (await owner('POST', '/v1/clients', { name: 'Cole Park', email: 'cole@example.com' })).body;
  const plan1 = (await owner('POST', `/v1/team-contracts/${contract.id}/roster/check`, { names: `Ty Ortiz, RB, 2028\nCole Park, ${cole.athlete_id}\nSam Whitaker, DB\nJalen Brooks` })).body;
  assert.deepEqual(plan1.counts, { new: 1, link: 1, match: 1, skip: 1, error: 0 });
  assert.equal(plan1.rows[1].client.id, cole.id);
  const bad = await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { names: 'Ty Ortiz\nNo Body, NOBODY2026' });
  assert.equal(bad.status, 409, 'an unknown Athlete ID blocks the list');
  assert.match(bad.body.error.details[0].message, /no athlete has the ID NOBODY2026/);
  const pasted = (await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { names: `Ty Ortiz, RB, 2028\nCole Park, ${cole.athlete_id}\nSam Whitaker, DB\nJalen Brooks` })).body;
  assert.deepEqual([pasted.added, pasted.linked, pasted.skipped], [2, 1, 1], 'Sam without a choice is a new athlete, never merged by name');
  const sams = pasted.data.filter((a) => a.name === 'Sam Whitaker');
  assert.equal(sams.length, 1);
  assert.notEqual(sams[0].client_id, sam.id);

  // Add existing client.
  const mo = (await owner('POST', '/v1/clients', { name: 'Mo Member', email: 'mo@example.com' })).body;
  assert.equal((await owner('POST', `/v1/team-contracts/${contract.id}/roster/existing`, { client_id: mo.id })).status, 201);
  const roster = await rosterOf(contract.id);
  assert.ok(roster.every((a) => a.client_id), 'every roster line has a profile');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM team_roster WHERE client_id IS NULL').n, 0);

  // Counts: team-only athletes show in Team only, never as active clients; new team athletes aren't "new clients".
  const after = (await owner('GET', '/v1/client-counts')).body;
  assert.equal(after.current, before.current + 1, 'only Ava, who has a membership');
  const teamOnly = (await owner('GET', '/v1/clients?status=team')).body.data.map((c) => c.name).sort();
  assert.deepEqual(teamOnly, ['Cole Park', 'Jalen Brooks', 'Mo Member', 'Sam Whitaker', 'Ty Ortiz']);
  assert.equal(after.team, 5);
  const dash = (await owner('GET', '/v1/dashboard')).body;
  assert.equal(dash.metrics.active_clients, dashBefore.metrics.active_clients + 1);
  assert.equal(dash.pulse.clients.new_this_month, dashBefore.pulse.clients.new_this_month + 2, 'Ava and Sam; team-only athletes (on a roster, never a membership) aren\'t new clients');
  assert.ok(!(await owner('GET', '/v1/clients?status=current')).body.data.some((c) => c.id === jalen.id));

  // Roles: Teams stay owner-only.
  assert.equal((await coach('POST', `/v1/team-contracts/${contract.id}/roster`, { name: 'Nope Coach' })).status, 403);
  assert.equal((await desk('POST', `/v1/team-contracts/${contract.id}/roster`, { name: 'Nope Desk' })).status, 403);
});

test('results, uploads, device links, walk-ups, queue linking and team attendance land on the profile', async () => {
  const roster = await rosterOf(contract.id);
  const ty = roster.find((a) => a.name === 'Ty Ortiz'), jalen = roster.find((a) => a.name === 'Jalen Brooks');
  // A team testing day brings in the roster as profiles.
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Preseason', date: addDaysToDate(today(), -1), contract_id: contract.id, tests: ['dash_40yd', 'vertical_standing'] })).body;
  assert.ok(day.athletes.every((a) => a.client_id && !a.roster_id));
  assert.ok(day.athletes.some((a) => a.client_id === ty.client_id));
  // An older integration's roster_id, the client_id and the Athlete ID all land on the same profile.
  const r = (await coach('POST', '/v1/results', { session_id: day.id, results: [
    { roster_id: ty.id, test: 'dash_40yd', value: 4.9, attempt: 1 },
    { client_id: ty.client_id, test: 'dash_40yd', value: 4.8, attempt: 2 },
    { athlete_id: ty.athlete_id, test: 'vertical_standing', value: 25 }] })).body;
  assert.equal(r.created, 3);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM perf_results WHERE roster_id IS NOT NULL').n, 0, 'nothing is saved on a roster line');
  // Upload by the team athlete's Athlete ID.
  const csv = `Athlete ID,Name,Broad jump (in)\n${ty.athlete_id},Ty Ortiz,98\n${jalen.athlete_id},Jalen Brooks,101`;
  const pre = (await coach('POST', '/v1/uploads/preview', { csv, date: addDaysToDate(today(), -1) })).body;
  assert.equal(pre.ok, true, JSON.stringify(pre.errors));
  assert.deepEqual(pre.athletes.map((a) => a.client_id).sort(), [jalen.client_id, ty.client_id].sort());
  const saved = (await coach('POST', '/v1/uploads/commit', { preview_id: pre.preview_id, confirm: pre.warnings.map((w) => w.key) })).body;
  assert.equal(saved.saved, 2);
  assert.ok(saved.athletes.every((a) => a.client_id && !('roster_id' in a)));
  // A walk-up by Athlete ID and a device linked by roster line.
  const mo = roster.find((a) => a.name === 'Mo Member');
  assert.ok((await coach('POST', `/v1/testing-sessions/${day.id}/athletes`, { athlete_id: mo.athlete_id })).body.athletes.some((a) => a.client_id === mo.client_id));
  const link = (await coach('POST', '/v1/athlete-links', { provider: 'swift', external_id: 'SW-9', roster_id: jalen.id })).body;
  assert.equal(link.client_id, jalen.client_id);
  assert.equal(app.ctx.db.get(`SELECT client_id, roster_id FROM athlete_links WHERE external_id = 'SW-9'`).roster_id, null);
  const key = (await owner('POST', '/v1/api-keys', { label: 'Gates' })).body.secret;
  const pushed = (await req('POST', '/v1/results', { provider: 'swift', results: [{ athlete: { external_id: 'SW-9' }, test: 'dash_40yd', value: 4.7, external_id: 'sw-1' }, { athlete: { name: 'Jalen B' }, test: 'dash_40yd', value: 4.75, external_id: 'sw-2' }] }, { authorization: `Bearer ${key}` })).body;
  assert.deepEqual([pushed.created, pushed.queued], [1, 1], 'a hand-linked device lands, a name alone waits');
  const g = (await coach('GET', '/v1/queue')).body.data.find((x) => x.label === 'Jalen B');
  const linked = (await coach('POST', '/v1/queue/link', { provider: g.provider, identity: g.identity, roster_id: jalen.id })).body;
  assert.deepEqual([linked.saved, linked.athlete.client_id], [1, jalen.client_id]);
  // Everything is on the client profile.
  const prof = (await coach('GET', `/v1/clients/${jalen.client_id}/performance`)).body.data;
  assert.equal(prof.find((p) => p.test === 'dash_40yd').best, 4.7);
  assert.equal(prof.find((p) => p.test === 'broad_jump').best, 101);
  assert.equal((await coach('GET', `/v1/results?roster_id=${jalen.id}`)).body.data.length, (await coach('GET', `/v1/results?client_id=${jalen.client_id}`)).body.data.length);

  // Team attendance: checked in by roster line, kept on the profile; the team page and the profile both show it.
  const tomorrow = addDaysToDate(today(), 1);
  assert.equal((await owner('POST', `/v1/team-contracts/${contract.id}/sessions`, { location_id: facility.id, weekdays: [new Date(`${tomorrow}T12:00:00Z`).getUTCDay()], start_time: '06:00', duration_min: 60, start_date: tomorrow })).status, 201);
  const seriesId = app.ctx.db.get('SELECT id FROM class_series WHERE contract_id = ?', contract.id).id;
  const sid = 'cls_team_yesterday';
  app.ctx.db.run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, ?, 'Varsity lift', 'team', ?, ?, ?, 30, 'scheduled', ?)`,
    sid, seriesId, facility.id, new Date(Date.now() - 26 * 3600000).toISOString(), new Date(Date.now() - 25 * 3600000).toISOString(), new Date(Date.now() - 30 * 3600000).toISOString());
  app.ctx.db.run('UPDATE team_roster SET created_at = ? WHERE contract_id = ?', new Date(Date.now() - 40 * 3600000).toISOString(), contract.id);   // on the team before that session
  const t = (await coach('POST', `/v1/sessions/${sid}/team-attendance`, { roster_id: jalen.id, present: true })).body;
  assert.equal(t.athletes.find((a) => a.id === jalen.id).present, true);
  assert.equal((await coach('POST', `/v1/sessions/${sid}/team-attendance`, { client_id: ty.client_id, present: true })).status, 200);
  assert.deepEqual(app.ctx.db.all('SELECT client_id FROM team_attendance WHERE session_id = ? ORDER BY client_id', sid).map((x) => x.client_id), [jalen.client_id, ty.client_id].sort());
  const att = (await coach('GET', `/v1/clients/${jalen.client_id}/attendance`)).body;
  assert.equal(att.summary.visits_30, 1);
  const team = (await owner('GET', `/v1/team-contracts/${contract.id}`)).body;
  assert.equal(team.roster.find((a) => a.id === jalen.id).sessions_attended, 1);
  assert.equal(team.recent_sessions[0].here, 2);
  const profile = (await coach('GET', `/v1/clients/${jalen.client_id}`)).body;
  assert.deepEqual(profile.teams.map((x) => x.name), ['Westlake HS Varsity']);
  assert.ok(profile.last_seen_at);

  // Taking someone off the roster keeps their profile, results and attendance.
  await owner('DELETE', `/v1/team-contracts/${contract.id}/roster/${jalen.id}`);
  assert.equal((await coach('GET', `/v1/clients/${jalen.client_id}/performance`)).body.data.find((p) => p.test === 'dash_40yd').best, 4.7);
  assert.equal((await coach('GET', `/v1/clients/${jalen.client_id}/attendance`)).body.summary.visits_30, 1);
  await owner('POST', `/v1/team-contracts/${contract.id}/roster/${jalen.id}/restore`);
  assert.equal((await owner('GET', `/v1/team-contracts/${contract.id}`)).body.roster.find((a) => a.id === jalen.id).sessions_attended, 1);
});

test('rankings, record boards, reports, share links, the athlete app and the parent portal read the profile', async () => {
  const roster = await rosterOf(contract.id);
  const ty = roster.find((a) => a.name === 'Ty Ortiz');
  const board = (await coach('GET', '/v1/tests/dash_40yd/details')).body.records.board;
  assert.ok(board.some((b) => b.client_id === ty.client_id && b.athlete_id === ty.athlete_id));
  assert.ok(board.every((b) => b.client_id && !('roster_id' in b)));
  const report = (await coach('GET', `/v1/clients/${ty.client_id}/report`)).body;
  assert.ok(report.tests.some((x) => x.test === 'dash_40yd'), 'the staff report has the team results');
  assert.equal(report.athlete.athlete_id, ty.athlete_id);
  // The team athlete's own app works from their profile's link.
  const tyProfile = (await coach('GET', `/v1/clients/${ty.client_id}`)).body;
  const app1 = await req('GET', '/app/api/engage', null, { 'x-client-token': tyProfile.app_link.split('token=')[1] });
  assert.equal(app1.status, 200);
  assert.equal(app1.body.athlete.athlete_id, ty.athlete_id);
  // Parents: put Ty in a family (owner or coach; not front desk), and share the testing day.
  assert.equal((await desk('POST', `/v1/clients/${ty.client_id}/family`, { parent: { name: 'Rosa Ortiz', email: 'rosa@example.com' } })).status, 403);
  const joined = await coach('POST', `/v1/clients/${ty.client_id}/family`, { parent: { name: 'Rosa Ortiz', email: 'rosa@example.com' }, send_welcome: false });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.family.name, 'Ortiz family');
  assert.equal((await coach('POST', `/v1/clients/${ty.client_id}/family`, { family_id: joined.body.family.id })).status, 409, 'someone in a family is never moved');
  assert.equal((await owner('GET', '/v1/clients?status=team')).body.data.some((c) => c.id === ty.client_id), true, 'still team only: no membership');
  const rosa = await parent('rosa@example.com');
  const day = app.ctx.db.get(`SELECT id FROM perf_sessions WHERE name = 'Preseason'`).id;
  const hidden = (await rosa('GET', `/portal/api/athletes/${ty.client_id}/report`)).body;
  assert.ok(!JSON.stringify(hidden).includes('4.8'), 'nothing from an unshared day');
  await coach('POST', `/v1/testing-sessions/${day}/share`, { notify: false });
  const shown = (await rosa('GET', `/portal/api/athletes/${ty.client_id}/engage`)).body.performance.tests;
  assert.equal(shown.find((x) => x.test === 'dash_40yd').best, 4.8);
  const share = (await rosa('POST', `/portal/api/athletes/${ty.client_id}/report-links`, { days: 7 })).body;
  const secret = share.url.split('#share=')[1];
  const pub = await req('GET', '/portal/api/public/report', null, { 'x-report-link': secret });
  assert.equal(pub.status, 200);
  assert.ok(pub.body.tests.some((x) => x.test === 'dash_40yd'), 'the share link shows the team testing day');
});

test('archived athletes stay on the roster\'s history but leave its current lists; renames and ID changes follow the profile', async () => {
  const roster = await rosterOf(contract.id);
  const cole = roster.find((a) => a.name === 'Cole Park');
  assert.equal((await owner('POST', `/v1/clients/${cole.client_id}/archive`, { confirm: true })).status, 200);
  assert.ok(!(await rosterOf(contract.id)).some((a) => a.client_id === cole.client_id), 'off the current roster');
  assert.equal(app.ctx.db.get('SELECT active FROM team_roster WHERE id = ?', cole.id).active, 1, 'the line stays for when they come back');
  assert.ok(!(await coach('GET', '/v1/athletes')).body.data.some((a) => a.client_id === cole.client_id));
  const plan2 = (await owner('POST', `/v1/team-contracts/${contract.id}/roster/check`, { names: 'Cole Park' })).body;
  assert.equal(plan2.rows[0].status, 'skip');
  assert.match(plan2.rows[0].reason, /archived/);
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Midseason', contract_id: contract.id, tests: ['dash_40yd'] })).body;
  assert.ok(!day.athletes.some((a) => a.client_id === cole.client_id), 'archived athletes are left out of a team testing day');
  await owner('POST', `/v1/clients/${cole.client_id}/restore`);
  assert.ok((await rosterOf(contract.id)).some((a) => a.client_id === cole.client_id), 'back on the roster');

  // The profile is the source of truth: a rename and an ID change show on the roster, and the roster line's copy follows.
  const ty = roster.find((a) => a.name === 'Ty Ortiz');
  await owner('PATCH', `/v1/clients/${ty.client_id}`, { name: 'Tyler Ortiz', athlete_id: 'TYLORT2026' });
  const line = (await rosterOf(contract.id)).find((a) => a.id === ty.id);
  assert.deepEqual([line.name, line.athlete_id], ['Tyler Ortiz', 'TYLORT2026']);
  assert.deepEqual(app.ctx.db.get('SELECT name, athlete_id FROM team_roster WHERE id = ?', ty.id), { name: 'Tyler Ortiz', athlete_id: 'TYLORT2026' });
  // A roster athlete's ID is unique across profiles: another client can't take it.
  const other = (await owner('POST', '/v1/clients', { name: 'Tia Other', email: 'tia@example.com' })).body;
  assert.equal((await owner('PATCH', `/v1/clients/${other.id}`, { athlete_id: 'TYLORT2026' })).status, 409);
});
