import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { newId } from '../src/util.js';

// The front-desk sign-in page (owner's ask: "list every class or session within a 2 hour window; when they click the
// private, class or session they log in with their ID and it checks them in"; services/checkin.js kioskCheckInById).
let app, base, owner, facility, park, key, ava, ben, cal, dee;
const MIN = 60000;
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const kiosk = async (method, path, body, k = key) => {
  const r = await fetch(base + path, { method, headers: { 'x-kiosk-key': k, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
function session(name, loc, startsInMin, { kind = 'group', lengthMin = 60, capacity = 10, seriesId = null } = {}) {
  const id = newId('cls'), s = new Date(Date.now() + startsInMin * MIN).toISOString(), e = new Date(Date.now() + (startsInMin + lengthMin) * MIN).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2500, 'scheduled', ?)`, id, seriesId, name, kind, loc.id, s, e, capacity, s);
  return id;
}
const book = (sessionId, client, status = 'booked', coverage = 'membership') => {
  const id = newId('bkg');
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, sessionId, client.id, status, coverage, app.ctx.now(), app.ctx.now());
  return id;
};
const statusOf = (sessionId, client) => app.ctx.db.get('SELECT status, coverage FROM bookings WHERE session_id = ? AND client_id = ?', sessionId, client.id);
const checkIn = (sessionId, athleteId, k) => kiosk('POST', '/kiosk-api/check-in', { session_id: sessionId, athlete_id: athleteId }, k);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'riley@test.dev', name: 'Riley Brooks', password: 'correct-horse-battery', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  park = (await owner('POST', '/v1/locations', { name: 'Zilker Park', kind: 'park' })).body;
  const mk = async (name, email) => (await owner('POST', '/v1/clients', { name, parent: { name: `${name} Parent`, email }, send_welcome: false })).body;
  [ava, ben, cal, dee] = [await mk('Ava Lopez', 'maria@example.com'), await mk('Ben Park', 'dana@example.com'), await mk('Cal Reyes', 'rosa@example.com'), await mk('Dee Sun', 'li@example.com')];
  key = (await owner('POST', '/v1/kiosks', { location_id: facility.id })).body.link.split('#')[1];
});
after(() => app.server.close());

test('the board lists everything running now or starting in the next 2 hours, privates by the athlete\'s first name and initial', async () => {
  const now = session('Morning speed', facility, -20);
  const soon = session('Strength', facility, 100);
  session('Evening speed', facility, 150);              // not yet: more than 2 hours out
  session('Park run', park, 10);                        // another place
  session('Done', facility, -90);                       // already over (60 minutes long)
  const priv = session('Private: Ava Lopez', facility, 45, { kind: 'private', capacity: 1 });
  book(priv, ava);
  app.ctx.db.run(`UPDATE class_sessions SET coach_id = (SELECT id FROM users WHERE email = 'riley@test.dev') WHERE id = ?`, soon);
  const board = (await kiosk('GET', '/kiosk-api/board')).body;
  assert.equal(board.window_minutes, 120);
  assert.deepEqual(board.sessions.map((s) => s.name), ['Morning speed', 'Private · Ava L.', 'Strength']);
  assert.ok(!JSON.stringify(board.sessions.map(({ athletes, ...s }) => s)).includes('Lopez'), 'a private never shows the full name');
  const strength = board.sessions.find((s) => s.id === soon);
  assert.deepEqual([strength.kind_label, strength.coach_name, strength.started], ['Class', 'Riley Brooks', false]);
  assert.equal(board.sessions.find((s) => s.id === now).started, true);
});

test('a booked athlete types their Athlete ID and is checked in; their own private works, someone else\'s doesn\'t', async () => {
  const s = session('Agility', facility, 30);
  book(s, ava);
  const typed = ava.athlete_id.toLowerCase();
  const r = await checkIn(s, ` ${typed} `);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.already, r.body.walk_in, r.body.pay_at_desk], ['Ava', false, false, false]);
  assert.equal(statusOf(s, ava).status, 'attended');
  assert.equal((await checkIn(s, ava.athlete_id)).body.already, true);
  assert.equal(r.body.waiver_needed, true, 'the family hasn\'t signed the waiver yet');
  // A private: only the athlete booked on it.
  const priv = session('Private: Ava Lopez', facility, 20, { kind: 'private', capacity: 1 });
  book(priv, ava);
  const other = await checkIn(priv, ben.athlete_id);
  assert.deepEqual([other.status, other.body.error.code], [409, 'see_front_desk']);
  assert.match(other.body.error.message, /booked for someone else/);
  assert.equal((await checkIn(priv, ava.athlete_id)).status, 200);
  // Marked a no-show too soon: checking in puts them back.
  const ns = session('Mobility', facility, -10);
  book(ns, cal, 'no_show');
  assert.equal((await checkIn(ns, cal.athlete_id)).status, 200);
  assert.equal(statusOf(ns, cal).status, 'attended');
});

test('not booked: a class with a spot books them at the desk\'s terms (a pack session, else pay at the desk), never charging the card', async () => {
  const s = session('Open gym', facility, 15);
  app.ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, created_at) VALUES (?, ?, 'group', 2, 'purchase', ?)`, newId('cr'), ben.id, app.ctx.now());
  const withPack = await checkIn(s, ben.athlete_id);
  assert.equal(withPack.status, 200, JSON.stringify(withPack.body));
  assert.deepEqual([withPack.body.walk_in, withPack.body.coverage, withPack.body.pay_at_desk], [true, 'credit', false]);
  assert.deepEqual(statusOf(s, ben), { status: 'attended', coverage: 'credit' });
  const sales = app.ctx.db.get('SELECT COUNT(*) AS n FROM sales').n;
  const nothing = await checkIn(s, dee.athlete_id);
  assert.deepEqual([nothing.body.walk_in, nothing.body.coverage, nothing.body.pay_at_desk], [true, 'unpaid', true]);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM sales').n, sales, 'no card charged from the tablet');
  // Full: see the front desk. The waitlist: see the front desk.
  const full = session('Small group', facility, 15, { capacity: 1 });
  book(full, ava);
  const r = await checkIn(full, cal.athlete_id);
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /Cal, this session is full/);
  book(full, dee, 'waitlisted', 'none');
  assert.match((await checkIn(full, dee.athlete_id)).body.error.message, /waitlist/);
});

test('a team session marks roster athletes present and sends anyone else to the desk', async () => {
  const org = (await owner('POST', '/v1/organizations', { name: 'Westlake High', kind: 'school', contact_email: 'ad@westlake.example' })).body;
  const team = (await owner('POST', '/v1/team-contracts', { org_id: org.id, name: 'Football', monthly_cents: 100000, start_date: '2026-10-01', past: 'none' })).body;
  await owner('POST', `/v1/team-contracts/${team.id}/roster`, { names: 'Finn Roster' });
  const finn = app.ctx.db.get(`SELECT id, athlete_id FROM clients WHERE name = 'Finn Roster'`);
  const series = newId('ser');
  app.ctx.db.run(`INSERT INTO class_series (id, name, kind, location_id, weekdays, start_time, duration_min, capacity, start_date, contract_id, active, created_at) VALUES (?, 'Football lift', 'team', ?, '[1]', '06:00', 60, 40, '2026-10-01', ?, 1, ?)`, series, facility.id, team.id, app.ctx.now());
  const s = session('Football lift', facility, 5, { kind: 'team', capacity: 40, seriesId: series });
  const r = await checkIn(s, finn.athlete_id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(app.ctx.db.get('SELECT 1 FROM team_attendance WHERE session_id = ? AND client_id = ?', s, finn.id));
  assert.equal((await checkIn(s, finn.athlete_id)).body.already, true);
  assert.match((await checkIn(s, ava.athlete_id)).body.error.message, /not on this team's roster/);
});

test('an unknown ID asks to check it; misses are limited per tablet; other places, archived athletes and closed sessions are refused', async () => {
  resetRateLimits();
  const s = session('Late class', facility, 10);
  const miss = await checkIn(s, 'NOPNOP2026');
  assert.deepEqual([miss.status, miss.body.error.code], [404, 'not_found']);
  let last;
  for (let i = 0; i < 30; i++) last = await checkIn(s, `XX${i}`);
  assert.equal(last.status, 429, 'thirty wrong IDs in 15 minutes');
  resetRateLimits();
  const parkKey = (await owner('POST', '/v1/kiosks', { location_id: park.id })).body.link.split('#')[1];
  assert.equal((await checkIn(s, ava.athlete_id, parkKey)).status, 409, 'a tablet only checks in its own place');
  const later = session('Tonight', facility, 180);
  assert.equal((await checkIn(later, ava.athlete_id)).status, 409, 'not in the 2-hour window yet');
  app.ctx.db.run('UPDATE clients SET archived_at = ? WHERE id = ?', app.ctx.now(), dee.id);
  assert.match((await checkIn(s, dee.athlete_id)).body.error.message, /isn't active/);
  assert.equal((await kiosk('POST', '/kiosk-api/check-in', { session_id: s, athlete_id: ava.athlete_id }, 'wrong-key')).status, 401);
});

test('open gym: the tablet signs an athlete in by Athlete ID once a day, tracked only, and staff see who came', async () => {
  resetRateLimits();
  const og = (athleteId, k) => kiosk('POST', '/kiosk-api/open-gym', { athlete_id: athleteId }, k);
  const credits = app.ctx.db.get(`SELECT COALESCE(SUM(delta), 0) AS n FROM session_credits WHERE client_id = ?`, ben.id).n;
  const r = await og(ben.athlete_id.toLowerCase());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.already, r.body.open_gym, r.body.visits_this_month], ['Ben', false, true, 1]);
  assert.equal((await og(ben.athlete_id)).body.already, true, 'once a day');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM open_gym_visits WHERE client_id = ?', ben.id).n, 1);
  assert.equal(app.ctx.db.get(`SELECT COALESCE(SUM(delta), 0) AS n FROM session_credits WHERE client_id = ?`, ben.id).n, credits, 'no pack session used');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM check_ins WHERE client_id = ?', ben.id).n, 0, 'not a membership visit');
  // Another place on the same day is its own visit.
  const parkKey = (await owner('POST', '/v1/kiosks', { location_id: park.id })).body.link.split('#')[1];
  assert.equal((await og(ben.athlete_id, parkKey)).body.already, false);
  assert.equal((await og(cal.athlete_id)).status, 200);
  // The same rules as a session sign-in.
  assert.equal((await og('NOPNOP2026')).status, 404);
  assert.match((await og(dee.athlete_id)).body.error.message, /isn't active/, 'archived in the test above');
  assert.equal((await kiosk('POST', '/kiosk-api/open-gym', { athlete_id: ben.athlete_id }, 'wrong-key')).status, 401);
  // Staff: the report, the CSV, the timeline, last seen; a visit taken back.
  const rep = (await owner('GET', '/v1/open-gym')).body;
  assert.deepEqual([rep.total, rep.athletes, rep.today], [3, 2, 3]);
  assert.deepEqual(rep.by_athlete.map((a) => [a.name, a.visits]), [['Ben Park', 2], ['Cal Reyes', 1]]);
  assert.equal(rep.by_day.length, 30);
  assert.equal((await owner('GET', `/v1/open-gym?location_id=${park.id}`)).body.total, 1);
  assert.equal((await owner('GET', '/v1/open-gym?from=2026-10-20&to=2026-10-01')).status, 400);
  const csv = await fetch(`${base}/v1/open-gym/export.csv`, { headers: { cookie: (await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.dev', password: 'correct-horse-battery' }) })).headers.get('set-cookie').split(';')[0] } });
  assert.match(await csv.text(), /Ben Park/);
  const tl = (await owner('GET', `/v1/clients/${cal.id}/athlete-timeline`)).body;
  assert.ok(tl.data.some((x) => x.text === 'Open gym'));
  assert.ok((await owner('GET', `/v1/clients/${cal.id}`)).body.last_seen_at, 'open gym counts as last seen');
  const desk = await (async () => { createUser(app.ctx, { email: 'desk@test.dev', name: 'Dee Desk', password: 'correct-horse-battery', role: 'front_desk' }); return signIn('desk@test.dev'); })();
  assert.equal((await desk('GET', '/v1/open-gym')).status, 200, 'front desk can look');
  assert.equal((await desk('DELETE', `/v1/open-gym/${rep.visits[0].id}`)).status, 403);
  assert.equal((await owner('DELETE', `/v1/open-gym/${rep.visits[0].id}`)).status, 200);
  assert.equal((await owner('GET', '/v1/open-gym')).body.total, 2);
});

test('the version 90 upgrade adds the open gym table', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { openDb } = await import('../src/db.js');
  const file = join(mkdtempSync(join(tmpdir(), 'dp-v90-')), 'dp.db');
  const raw = new DatabaseSync(file);
  raw.exec(readFileSync('test/fixtures/schema-v90.sql', 'utf8'));
  raw.exec('PRAGMA user_version = 90');
  raw.close();
  const db = openDb(file);
  assert.equal(db.get('PRAGMA user_version').user_version, 94);
  assert.ok(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'open_gym_visits'`));
  db.close();
});
