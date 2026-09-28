// One profile per athlete from the family's side: a parent signing up (or adding a child) for a team athlete claims the
// existing profile with the Athlete ID, a matching name and birth year. A stranger can't tell whether an ID exists, and
// guesses are rate-limited. Owners merge two profiles of one athlete: everything moves onto one profile, the old ID
// keeps working, and it's refused when both have a membership or they're in different families.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { recordResults } from '../src/services/performance.js';
import { findByAthleteId } from '../src/services/athlete-ids.js';
import { newId, localDate, addDaysToDate } from '../src/util.js';

const TZ = 'America/Chicago';
let app, base, owner, coach, facility, contract, plan, ty, jalen, marcus;
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
async function signUp(email, name, athletes) {
  const start = await req('POST', '/portal/api/signup', { accept_terms: true, parent: { name, email }, athletes });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const fin = await req('POST', '/portal/api/signup/verify', { signup_id: start.body.signup_id, code: start.body.dev_code });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  return { cookie: fin.cookie, athletes: (await req('GET', '/portal/api/me', null, { cookie: fin.cookie })).body.athletes };
}
const db = () => app.ctx.db;
const today = () => localDate(new Date().toISOString(), TZ);
const clientByName = (name) => db().get('SELECT * FROM clients WHERE name = ?', name);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  coach = await signIn('coach@test.dev', 'coach-password-1');
  await owner('PATCH', '/v1/settings', { timezone: TZ });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 9900, trial_days: 0 })).body;
  contract = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Westlake HS', kind: 'school' }, name: 'Varsity', monthly_cents: 100000 })).body;
  await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { names: 'Ty Ortiz, RB, 2028\nJalen Brooks, QB, 2027\nMarcus Hill, WR, 2027' });
  ty = clientByName('Ty Ortiz'); jalen = clientByName('Jalen Brooks'); marcus = clientByName('Marcus Hill');
  // The coach knows Ty's and Jalen's birthdays; Marcus's isn't on file.
  await owner('PATCH', `/v1/clients/${ty.id}`, { birth_date: '2010-05-04' });
  await owner('PATCH', `/v1/clients/${jalen.id}`, { birth_date: '2009-02-11' });
  // Ty has a result from a shared testing day and a staff note.
  const day = (await owner('POST', '/v1/testing-sessions', { name: 'Preseason', date: addDaysToDate(today(), -5), tests: ['dash_40yd'], athletes: [{ client_id: ty.id }] })).body;
  recordResults(app.ctx, [{ client_id: ty.id, test: 'dash_40yd', value: 5.1, recorded_at: `${addDaysToDate(today(), -5)}T15:00:00.000Z` }], { source: 'manual', sessionId: day.id });
  await owner('POST', `/v1/testing-sessions/${day.id}/share`, { notify: false });
  await owner('POST', `/v1/clients/${ty.id}/notes`, { body: 'Great work ethic' });
});
after(() => app.server.close());

test('sign-up with the Athlete ID, name and birthday: the team profile joins the family, no second profile', async () => {
  const before = db().get('SELECT COUNT(*) AS n FROM clients').n;
  const { cookie, athletes } = await signUp('rosa.ortiz@example.com', 'Rosa Ortiz', [{ name: 'ty ortiz', birth_date: '2010-05-04', athlete_code: ` ${ty.athlete_id.toLowerCase()} ` }]);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM clients').n, before, 'no new profile');
  assert.equal(athletes.length, 1);
  assert.equal(athletes[0].id, ty.id);
  assert.equal(athletes[0].athlete_id, ty.athlete_id);
  const rosa = as(cookie);
  const report = (await rosa('GET', `/portal/api/athletes/${ty.id}/report`)).body;
  assert.equal(report.tests.find((t) => t.test === 'dash_40yd').best, 5.1, 'the team results are on the one profile');
  assert.equal(db().get('SELECT family_id FROM clients WHERE id = ?', ty.id).family_id, db().get(`SELECT family_id FROM guardians WHERE email = 'rosa.ortiz@example.com'`).family_id);
  assert.ok((await owner('GET', `/v1/team-contracts/${contract.id}`)).body.roster.some((l) => l.client_id === ty.id), 'still on the team');
  assert.equal((await owner('GET', '/v1/profile-claims?status=attached')).body.data[0].claimed_client_id, ty.id);
  assert.ok(db().get(`SELECT 1 FROM audit_log WHERE action = 'claim profile by Athlete ID' AND target = ?`, ty.id));
});

test('a wrong birth year, an unknown ID and a profile in another family all get the same answer; the owner checks real ones', async () => {
  const wrongYear = await signUp('pat.brooks@example.com', 'Pat Brooks', [{ name: 'Jalen Brooks', birth_date: '2011-02-11', athlete_code: jalen.athlete_id }]);
  const unknown = await signUp('kim.nobody@example.com', 'Kim Nobody', [{ name: 'Nia Nobody', birth_date: '2011-02-11', athlete_code: 'NIANOB2025' }]);
  const yearOnly = await signUp('guess@example.com', 'Gus Guess', [{ name: 'Jalen Brooks', birth_date: '2009-06-01', athlete_code: jalen.athlete_id }]);
  assert.notEqual(yearOnly.athletes[0].id, jalen.id, 'the right birth year alone doesn\'t attach a profile (IDs and years are guessable)');
  const taken = await signUp('someone@example.com', 'Some One', [{ name: 'Ty Ortiz', birth_date: '2010-05-04', athlete_code: ty.athlete_id }]);
  const answer = async (cookie) => (await req('GET', '/portal/api/me', null, { cookie })).body.athletes[0];
  for (const x of [wrongYear, unknown, taken]) {
    const a = await answer(x.cookie);
    assert.notEqual(a.id, jalen.id); assert.notEqual(a.id, ty.id);
  }
  assert.notEqual(wrongYear.athletes[0].athlete_id, jalen.athlete_id);
  assert.equal(db().get('SELECT family_id FROM clients WHERE id = ?', jalen.id).family_id, null, 'Jalen stays team-only');
  const claims = (await owner('GET', '/v1/profile-claims')).body.data;
  assert.equal(claims.length, 3, 'only IDs that belong to a profile reach the owner');
  assert.equal(claims.find((c) => c.guardian_name === 'Gus Guess').reason, 'birthday');
  const j = claims.find((c) => c.claimed_client_id === jalen.id && c.guardian_name === 'Pat Brooks');
  assert.equal(j.reason, 'birth_year');
  assert.equal(j.new_name, 'Jalen Brooks');
  assert.equal(claims.find((c) => c.claimed_client_id === ty.id).reason, 'in_family');
  assert.equal((await coach('GET', '/v1/profile-claims')).status, 403);
  // The sign-up answer itself reads the same whether or not the ID exists.
  const s1 = await req('POST', '/portal/api/signup', { accept_terms: true, parent: { name: 'A B', email: 'ab1@example.com' }, athletes: [{ name: 'Jalen Brooks', birth_date: '2011-02-11', athlete_code: jalen.athlete_id }] });
  const f1 = await req('POST', '/portal/api/signup/verify', { signup_id: s1.body.signup_id, code: s1.body.dev_code });
  const s2 = await req('POST', '/portal/api/signup', { accept_terms: true, parent: { name: 'C D', email: 'cd1@example.com' }, athletes: [{ name: 'Jalen Brooks', birth_date: '2011-02-11', athlete_code: 'ZZZZZZ2020' }] });
  const f2 = await req('POST', '/portal/api/signup/verify', { signup_id: s2.body.signup_id, code: s2.body.dev_code });
  assert.equal(f1.body.athletes[0].claim, 'pending');
  assert.deepEqual([f1.body.athletes[0].claim, f1.body.athletes[0].message], [f2.body.athletes[0].claim, f2.body.athletes[0].message], 'the same answer whether or not the ID exists');
  assert.equal(s1.body.message, s2.body.message);
  assert.equal((await req('POST', '/portal/api/signup', { accept_terms: true, parent: { name: 'E F', email: 'ef@example.com' }, athletes: [{ name: 'X Y', birth_date: '2011-02-11', athlete_code: 'not-an-id' }] })).status, 400, 'a badly shaped ID is refused (that says nothing about which exist)');
});

test('adding a child in the portal claims a profile the same way; guesses are rate-limited', async () => {
  resetRateLimits();
  const { cookie } = await signUp('lee.hill@example.com', 'Lee Hill', [{ name: 'Mia Hill', birth_date: '2014-03-01' }]);
  const lee = as(cookie);
  // Marcus has no birthday on file, so a match can't be checked: a new profile, and the owner is asked.
  const r = await lee('POST', '/portal/api/athletes', { name: 'Marcus Hill', birth_date: '2009-07-07', athlete_code: marcus.athlete_id });
  assert.equal(r.status, 201);
  assert.equal(r.body.claim, 'pending');
  assert.notEqual(r.body.id, marcus.id);
  const miss = await lee('POST', '/portal/api/athletes', { name: 'Noah Hill', birth_date: '2012-07-07', athlete_code: 'NOAHIL2019' });
  assert.equal(miss.body.claim, 'pending');
  assert.equal(miss.body.message.replace(/Noah/g, 'X'), r.body.message.replace(/Marcus/g, 'X'), 'the same words whether or not the ID exists');
  for (let i = 0; i < 3; i++) await lee('POST', '/portal/api/athletes', { name: `Guess ${i} Hill`, birth_date: '2012-07-07', athlete_code: `GUEHIL20${10 + i}` });
  assert.equal((await lee('POST', '/portal/api/athletes', { name: 'Sixth Hill', birth_date: '2012-07-07', athlete_code: 'SIXHIL2020' })).status, 429, 'five tries an hour per parent');
  assert.equal((await lee('POST', '/portal/api/athletes', { name: 'No Code Hill', birth_date: '2012-07-07' })).status, 201, 'adding without an ID still works');
  resetRateLimits();
});

test('the owner merges the new profile into the team profile: everything moves, the old ID keeps working, logged', async () => {
  const claim = (await owner('GET', '/v1/profile-claims')).body.data.find((c) => c.claimed_client_id === jalen.id && c.guardian_name === 'Pat Brooks');
  const newJalen = claim.new_client_id;
  // Give the new profile things to move: a booking, a check-in, credits, a note, a membership.
  const ses = newId('cls');
  db().run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Speed', 'group', ?, ?, ?, 8, 'scheduled', ?)`, ses, facility.id, new Date(Date.now() + 86400000).toISOString(), new Date(Date.now() + 90000000).toISOString(), app.ctx.now());
  await owner('POST', `/v1/sessions/${ses}/bookings`, { client_id: newJalen });
  // Jalen's team profile had booked the same session and canceled: the new profile's live booking is the one kept.
  db().run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'canceled', 'none', ?, ?)`, newId('bkg'), ses, jalen.id, app.ctx.now(), app.ctx.now());
  await owner('POST', `/v1/clients/${newJalen}/credits`, { delta: 3, credit_type: 'group', note: 'Pack' });
  await owner('POST', `/v1/clients/${newJalen}/notes`, { body: 'Signed up online' });
  await owner('POST', `/v1/clients/${newJalen}/subscription`, { plan_id: plan.id });
  const oldId = db().get('SELECT athlete_id FROM clients WHERE id = ?', newJalen).athlete_id;
  assert.equal((await coach('POST', `/v1/clients/${jalen.id}/merge`, { from: newJalen, confirm: true })).status, 403, 'owners only');
  const preview = (await owner('GET', `/v1/clients/${jalen.id}/merge-preview?from=${newJalen}`)).body;
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.from.bookings, 1);
  assert.equal((await owner('POST', `/v1/clients/${jalen.id}/merge`, { from: newJalen })).status, 400, 'needs confirm');
  const out = await owner('POST', `/v1/clients/${jalen.id}/merge`, { from: newJalen, confirm: true });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(db().get('SELECT COUNT(*) AS n FROM clients WHERE id = ?', newJalen).n, 0, 'one profile left');
  const j = db().get('SELECT * FROM clients WHERE id = ?', jalen.id);
  assert.ok(j.family_id, 'Jalen joins the parent\'s family');
  assert.equal(j.athlete_id, jalen.athlete_id, 'the team profile keeps its Athlete ID');
  assert.equal(findByAthleteId(app.ctx, oldId).client_id, jalen.id, 'the other ID finds Jalen');
  assert.deepEqual({ ...db().get('SELECT COUNT(*) AS n, MAX(status) AS s FROM bookings WHERE client_id = ?', jalen.id) }, { n: 1, s: 'booked' }, 'the live booking survives');
  assert.equal(db().get(`SELECT COALESCE(SUM(delta), 0) AS n FROM session_credits WHERE client_id = ? AND credit_type = 'group'`, jalen.id).n, 3);
  assert.ok(db().get(`SELECT 1 FROM client_notes WHERE client_id = ? AND body = 'Signed up online'`, jalen.id));
  assert.ok(db().get(`SELECT 1 FROM subscriptions WHERE client_id = ? AND status != 'canceled'`, jalen.id), 'the membership moves with its invoices');
  assert.equal(db().get('SELECT COUNT(*) AS n FROM invoices WHERE client_id = ?', newJalen).n, 0);
  assert.ok((await owner('GET', `/v1/team-contracts/${contract.id}`)).body.roster.some((l) => l.client_id === jalen.id));
  assert.equal(db().get('SELECT status FROM profile_claims WHERE id = ?', claim.id).status, 'merged');
  assert.ok(db().get(`SELECT 1 FROM audit_log WHERE action LIKE 'merge profile %' AND target = ?`, jalen.id));
  // The parent sees one Jalen, with the team profile.
  const pat = await parent('pat.brooks@example.com');
  const kids = (await pat('GET', '/portal/api/me')).body.athletes;
  assert.deepEqual(kids.map((k) => k.id), [jalen.id]);
  // A result sent with the old ID lands on Jalen.
  const res = await owner('POST', '/v1/results', { results: [{ athlete: { athlete_id: oldId }, test: 'dash_40yd', value: 5.4 }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(db().get(`SELECT 1 FROM perf_results WHERE client_id = ? AND value = 5.4`, jalen.id));
});

test('merging is refused when both have a membership, when families differ, and for the same profile', async () => {
  const a = (await owner('POST', '/v1/clients', { name: 'Twin One', birth_date: '2012-01-01', parent: { name: 'P One', email: 'p1@example.com' } })).body;
  const b = (await owner('POST', '/v1/clients', { name: 'Twin Two', birth_date: '2012-01-01', parent: { name: 'P Two', email: 'p2@example.com' } })).body;
  const r = await owner('POST', `/v1/clients/${a.id}/merge`, { from: b.id, confirm: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /different families/);
  const c = (await owner('POST', `/v1/families/${a.family.id}/athletes`, { name: 'Twin Three', birth_date: '2012-01-01' })).body;
  db().run('UPDATE families SET card_payment_method = ?, card_last4 = ? WHERE id = ?', 'pm_x', '4242', a.family.id);
  await owner('POST', `/v1/clients/${a.id}/subscription`, { plan_id: plan.id });
  await owner('POST', `/v1/clients/${c.id}/subscription`, { plan_id: plan.id });
  assert.match((await owner('POST', `/v1/clients/${a.id}/merge`, { from: c.id, confirm: true })).body.error.message, /Both profiles have a membership/);
  assert.equal((await owner('POST', `/v1/clients/${a.id}/merge`, { from: a.id, confirm: true })).status, 400);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM clients WHERE id IN (?, ?, ?)', a.id, b.id, c.id).n, 3, 'nothing changed');
});
