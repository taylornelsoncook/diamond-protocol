// Clients tab: list views, flags and search, CSV export, duplicate checks on new clients, attendance, booking and
// cancelling from the profile, parent and waiver edits, the app link by email, and the role rules around them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDaysToDate, localDate } from '../src/util.js';

let app, base, owner, coach, desk, facility, plan;
const TZ = 'America/Chicago';

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* a file */ }
  return { status: res.status, body: json, text, type: res.headers.get('content-type'), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const day = (n) => addDaysToDate(localDate(new Date().toISOString(), TZ), n);
let n = 0;
const kid = async (name, extra = {}) => {
  const r = await owner('POST', '/v1/clients', { name, birth_date: '2012-05-05', parent: { name: `Parent ${name}`, email: `p${++n}@example.com`, phone: `512-555-${String(1000 + n).slice(-4)}` }, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const noCents = (x, where) => assert.ok(!/_cents"/.test(JSON.stringify(x)), `${where} leaks an amount: ${JSON.stringify(x).slice(0, 300)}`);
const outbox = () => app.ctx.db.all('SELECT to_email, subject, body FROM outbox ORDER BY created_at DESC, rowid DESC');

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
});
after(() => app.server.close());

test('client list: team and no-waiver views with counts, flags, pinned notes by role, grad year, last seen, phone search and sorting', async () => {
  const med = await kid('Mia Medical', { medical_notes: 'Asthma inhaler in bag', grad_year: 2030 });
  const teamOnly = await kid('Tom Team');
  const member = await kid('Mo Member');
  await owner('POST', `/v1/clients/${member.id}/card/test`);
  await owner('POST', `/v1/clients/${member.id}/subscription`, { plan_id: plan.id });
  const school = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Lincoln HS', contact_email: 'ad@lincoln.example' }, name: 'Varsity', monthly_cents: 100000 })).body;
  assert.equal((await owner('POST', `/v1/team-contracts/${school.id}/roster/existing`, { client_id: teamOnly.id })).status, 201);
  assert.equal((await owner('POST', `/v1/team-contracts/${school.id}/roster/existing`, { client_id: member.id })).status, 201);
  // Mia's family signs the waiver; the others haven't.
  app.ctx.db.run('UPDATE families SET waiver_version = 1, waiver_signed_at = ? WHERE id = ?', new Date().toISOString(), med.family.id);
  await coach('POST', `/v1/clients/${med.id}/notes`, { body: 'Coach-only pinned', pinned: true, coach_only: true });
  await desk('POST', `/v1/clients/${med.id}/notes`, { body: 'Mom picks up at 6', pinned: true });
  await desk('POST', `/v1/clients/${med.id}/check-ins`, { location_id: facility.id, credit_type: 'group' }).then((r) => assert.equal(r.status, 409, 'no sessions left'));
  await owner('POST', `/v1/clients/${med.id}/credits`, { delta: 1, credit_type: 'group' });
  assert.equal((await desk('POST', `/v1/clients/${med.id}/check-ins`, { location_id: facility.id, credit_type: 'group' })).status, 201);

  const counts = (await owner('GET', '/v1/client-counts')).body;
  assert.equal(counts.team, 1, 'on a team roster with no membership');
  assert.equal(counts.no_waiver, 2);
  const byId = (list) => Object.fromEntries(list.map((c) => [c.id, c]));
  const all = byId((await coach('GET', '/v1/clients')).body.data);
  assert.deepEqual(all[med.id].flags, { medical: true, no_waiver: false, no_card: true });
  assert.deepEqual(all[member.id].flags, { medical: false, no_waiver: true, no_card: false });
  assert.equal(all[med.id].grad_year, 2030);
  assert.equal(all[med.id].pinned_notes, 2);
  assert.ok(all[med.id].last_seen_at, 'the walk-in check-in counts as seen');
  assert.equal(all[teamOnly.id].last_seen_at, null);
  assert.deepEqual(all[teamOnly.id].teams.map((t) => t.name), ['Lincoln HS Varsity']);
  assert.equal(all[med.id].parents[0].email, med.family.guardians[0].email);
  noCents((await coach('GET', '/v1/clients')).body, 'coach client list');
  assert.equal(byId((await desk('GET', '/v1/clients')).body.data)[med.id].pinned_notes, 1, 'front desk never counts coach-only notes');
  assert.equal((await desk('GET', `/v1/clients/${med.id}`)).body.pinned_notes, 1);

  assert.deepEqual((await owner('GET', '/v1/clients?status=team')).body.data.map((c) => c.id), [teamOnly.id]);
  assert.ok(!(await owner('GET', '/v1/clients?status=no_waiver')).body.data.some((c) => c.id === med.id));
  // Phone numbers match however they're typed, and parents' numbers find their athletes.
  const phone = med.family.guardians[0].phone;                       // 512-555-xxxx
  const digits = phone.replace(/\D/g, '');
  for (const q of [digits, `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`, phone]) {
    assert.deepEqual((await desk('GET', `/v1/clients?q=${encodeURIComponent(q)}`)).body.data.map((c) => c.id), [med.id], q);
  }
  assert.deepEqual((await desk('GET', `/v1/clients?q=${encodeURIComponent('parent mia')}`)).body.data.map((c) => c.id), [med.id], 'parent name');
  // Sorting: newest first; longest since last seen first (never seen at the top).
  const newest = (await owner('GET', '/v1/clients?sort=newest')).body.data.map((c) => c.id);
  assert.equal(newest[0], member.id);
  const seen = (await owner('GET', '/v1/clients?sort=last_seen')).body.data.map((c) => c.id);
  assert.ok(seen.indexOf(teamOnly.id) < seen.indexOf(med.id));
  assert.equal((await owner('GET', '/v1/clients?sort=price')).status, 400);
});

test('CSV export: owner only, the current view, no amounts, and cells a spreadsheet would run are made safe', async () => {
  const evil = await kid('=HYPERLINK("http://x.example","Click")', { school: '+cmd|calc', parent: { name: '@Parent Evil', email: 'evil@example.com', phone: '+15125550199' } });
  await owner('POST', `/v1/clients/${evil.id}/card/test`);
  await owner('POST', `/v1/clients/${evil.id}/subscription`, { plan_id: plan.id });
  assert.equal((await coach('GET', '/v1/client-export')).status, 403);
  assert.equal((await desk('GET', '/v1/client-export')).status, 403);
  const r = await owner('GET', '/v1/client-export?q=evil');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/csv/);
  const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 2, 'the header and the one client the search finds');
  assert.match(lines[0], /^Athlete ID,Name,Family,Parent,Parent email,Parent phone/);
  assert.ok(lines[1].includes(`"'=HYPERLINK(""http://x.example"",""Click"")"`), lines[1]);
  assert.ok(lines[1].includes("'+cmd|calc"));
  assert.ok(lines[1].includes("'@Parent Evil"));
  assert.ok(lines[1].includes('(512) 555-0199'), 'phone numbers read as phone numbers');
  assert.ok(lines[1].includes(',Active,Monthly,'));
  assert.ok(!/99|\$/.test(lines[1].replace(/0199|2012-05-05/g, '')), 'no membership price');
  // Archived clients only when asked for; the export is written to the audit log.
  const gone = await kid('Gina Gone');
  await owner('POST', `/v1/clients/${gone.id}/archive`);
  assert.ok(!(await owner('GET', '/v1/client-export')).text.includes('Gina Gone'));
  assert.ok((await owner('GET', '/v1/client-export?archived=true')).text.includes('Gina Gone'));
  assert.ok((await owner('GET', '/v1/audit')).body.data.some((a) => /exported \d+ clients? as CSV/.test(a.action)));
});

test('new clients: email and parent-login duplicates link to the record; same name and birthday or phone asks first; front desk can\'t assign programs', async () => {
  const ava = await kid('Ava Double', { birth_date: '2013-03-10' });
  const prog = (await owner('POST', '/v1/programs', { name: 'Speed 101', weeks: 4 })).body;
  // The parent's email already signs in for a family: add the athlete there instead.
  const again = await desk('POST', '/v1/clients', { name: 'Ben Double', parent: { name: 'Someone', email: ava.family.guardians[0].email.toUpperCase() }, check_duplicates: true });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'parent_exists');
  assert.equal(again.body.error.details.family.id, ava.family.id);
  assert.equal(again.body.error.details.duplicates[0].id, ava.id);
  noCents(again.body, 'duplicate answer');
  // An adult's email that belongs to a client.
  const adult = (await owner('POST', '/v1/clients', { name: 'Adam Adult', email: 'adam@example.com' })).body;
  const dupEmail = await desk('POST', '/v1/clients', { name: 'Adam Two', email: 'ADAM@example.com' });
  assert.equal(dupEmail.body.error.code, 'duplicate_email');
  assert.equal(dupEmail.body.error.details.duplicates[0].id, adult.id);
  // Same name, same birthday (or no birthday on one side): asked first, archived clients too.
  const body = { name: 'ava  double', birth_date: '2013-03-10', parent: { name: 'Other Parent', email: 'other@example.com' }, check_duplicates: true };
  const ask = await desk('POST', '/v1/clients', body);
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error.code, 'possible_duplicate');
  assert.deepEqual(ask.body.error.details.duplicates.map((d) => [d.id, d.reason]), [[ava.id, 'name']]);
  assert.match(ask.body.error.message, /same name and birthday/);
  assert.equal((await desk('POST', '/v1/clients', { ...body, birth_date: '2014-01-01' })).status, 201, 'a different birthday is a different athlete');
  const gone = await kid('Gus Archived', { birth_date: '2011-01-01' });
  await owner('POST', `/v1/clients/${gone.id}/archive`);
  const old = await owner('POST', '/v1/clients', { name: 'Gus Archived', parent: { name: 'New Parent', email: 'gus2@example.com' }, check_duplicates: true });
  assert.equal(old.body.error.details.duplicates[0].archived, true, 'an old client comes back instead of getting a second Athlete ID');
  // A phone number already on file (the parent's).
  const phoneAsk = await owner('POST', '/v1/clients', { name: 'Zack Phone', parent: { name: 'Pat Phone', email: 'pat@example.com', phone: `+1 ${ava.family.guardians[0].phone}` }, check_duplicates: true });
  assert.equal(phoneAsk.body.error.code, 'possible_duplicate');
  assert.equal(phoneAsk.body.error.details.duplicates[0].reason, 'phone');
  // "Create a new account anyway": the same request without the check.
  const anyway = await owner('POST', '/v1/clients', { name: 'Zack Phone', parent: { name: 'Pat Phone', email: 'pat@example.com', phone: ava.family.guardians[0].phone } });
  assert.equal(anyway.status, 201);
  // A sibling is only asked about a same-name twin.
  assert.equal((await owner('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Bea Double', check_duplicates: true })).status, 201);
  assert.equal((await owner('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Ava Double', check_duplicates: true })).body.error.code, 'possible_duplicate');
  // Front desk can add clients and siblings, but assigning a program is for coaches.
  const fd = await desk('POST', '/v1/clients', { name: 'Pia Program', parent: { name: 'P P', email: 'pp@example.com' }, program_id: prog.id });
  assert.equal(fd.status, 403);
  assert.match(fd.body.error.message, /coaches and owners assign programs/);
  assert.equal((await desk('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Cy Double', program_id: prog.id })).status, 403);
  assert.equal((await coach('POST', `/v1/families/${ava.family.id}/athletes`, { name: 'Cy Double', program_id: prog.id })).status, 201);
  // The parent portal and public sign-up never get another family's details.
  assert.equal((await req('POST', '/v1/clients', body)).status, 401);
});

test('birthdays: impossible, future and pre-1900 dates are refused everywhere; optional new-client fields are saved', async () => {
  for (const [bd, msg] of [['2013-02-30', /isn't a real date/], ['2999-01-01', /in the future/], ['1899-12-31', /too long ago/], ['03/10/2013', /isn't a real date/]]) {
    const r = await owner('POST', '/v1/clients', { name: 'Bad Birthday', birth_date: bd, parent: { name: 'B B', email: `bb${++n}@example.com` } });
    assert.equal(r.status, 400, bd);
    assert.match(r.body.error.message, msg);
  }
  const c = await kid('Opal Options', { position: 'SS', grad_year: 2031, phone: '512-555-0777', medical_notes: 'Peanut allergy', emergency_name: 'Grandma', emergency_phone: '512-555-0888' });
  const got = (await desk('GET', `/v1/clients/${c.id}`)).body;
  assert.deepEqual([got.position, got.grad_year, got.phone, got.medical_notes, got.emergency_name, got.emergency_phone], ['SS', 2031, '512-555-0777', 'Peanut allergy', 'Grandma', '512-555-0888']);
  assert.equal((await owner('PATCH', `/v1/clients/${c.id}`, { birth_date: '2030-01-01' })).status, 400);
});

test('attendance: visits, no-shows and late cancels in 30 days; a session still running is not a no-show', async () => {
  const c = await kid('Ada Attend');
  const at = (hoursFromNow, hours = 1) => [new Date(Date.now() + hoursFromNow * 3600000).toISOString(), new Date(Date.now() + (hoursFromNow + hours) * 3600000).toISOString()];
  const session = (name, [s, e]) => {
    const id = `cls_att_${name}`;
    app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, ?, 'group', ?, ?, ?, 10, 'scheduled', ?)`, id, name, facility.id, s, e, s);
    return id;
  };
  const booking = (sid, status) => app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, ?, 'none', ?, ?)`, `bkg_${sid}`, sid, c.id, status, new Date().toISOString(), new Date().toISOString());
  booking(session('came', at(-48)), 'attended');
  booking(session('marked', at(-72)), 'no_show');
  booking(session('forgot', at(-24)), 'booked');                  // over, nobody checked them in
  booking(session('running', at(-0.5)), 'booked');                // started 30 minutes ago, still going
  booking(session('late', at(3)), 'late_canceled');               // later today, canceled late
  booking(session('long_ago', at(-24 * 60)), 'attended');         // 60 days ago
  booking(session('future', at(48)), 'booked');
  await owner('POST', `/v1/clients/${c.id}/credits`, { delta: 1, credit_type: 'group' });
  await desk('POST', `/v1/clients/${c.id}/check-ins`, { location_id: facility.id });
  const a = (await desk('GET', `/v1/clients/${c.id}/attendance`)).body;
  assert.deepEqual({ ...a.summary, last_visit_at: undefined }, { visits_30: 2, no_shows_30: 2, late_cancels_30: 1, visits_90: 3, last_visit_at: undefined });
  assert.ok(a.summary.last_visit_at > new Date(Date.now() - 60000).toISOString(), 'the walk-in just now');
  const outcomes = Object.fromEntries(a.recent.map((r) => [r.session_name ?? r.outcome, r.outcome]));
  assert.equal(outcomes.running, 'in_progress');
  assert.equal(outcomes.forgot, 'no_show');
  assert.equal(outcomes.late, 'late_cancel');
  assert.equal(outcomes.walk_in, 'walk_in');
  assert.equal(outcomes.future, undefined);
  noCents(a, 'attendance');
});

test('booking and cancelling from the profile: credits come back, card payments are refunded, the waitlist moves up', async () => {
  const c = await kid('Bo Booker');
  const w = await kid('Wes Waiting');
  const s = (await owner('POST', '/v1/sessions', { name: 'Speed', kind: 'group', location_id: facility.id, date: day(3), start_time: '17:00', capacity: 1, drop_in_cents: 2500 })).body;
  // Front desk books with a group session the family bought.
  await owner('POST', `/v1/clients/${c.id}/credits`, { delta: 1, credit_type: 'group' });
  const b = await desk('POST', `/v1/sessions/${s.id}/bookings`, { client_id: c.id });
  assert.equal(b.status, 201);
  assert.equal(b.body.coverage, 'credit');
  noCents(b.body, 'front desk booking');
  const wl = (await coach('POST', `/v1/sessions/${s.id}/bookings`, { client_id: w.id })).body;
  assert.equal(wl.status, 'waitlisted', 'full: the waitlist');
  const cancel = (await desk('POST', `/v1/bookings/${b.body.id}/cancel`, {})).body;
  assert.equal(cancel.status, 'canceled');
  assert.equal((await owner('GET', `/v1/clients/${c.id}/credits`)).body.balance, 1, 'the credit came back');
  assert.equal((await owner('GET', `/v1/clients/${w.id}/bookings`)).body.data[0].status, 'booked', 'the waitlist moved up');
  // Charged to the card on file, then canceled: refunded.
  const s2 = (await owner('POST', '/v1/sessions', { name: 'Agility', kind: 'group', location_id: facility.id, date: day(4), start_time: '17:00', capacity: 5, drop_in_cents: 2500 })).body;
  await owner('POST', `/v1/clients/${c.id}/card/test`);
  await owner('POST', `/v1/clients/${c.id}/credits`, { delta: -1, credit_type: 'group' });
  const paid = (await coach('POST', `/v1/sessions/${s2.id}/bookings`, { client_id: c.id, pay: 'card_on_file' })).body;
  assert.equal(paid.coverage, 'paid');
  await coach('POST', `/v1/bookings/${paid.id}/cancel`, {});
  assert.equal(app.ctx.db.get('SELECT status FROM sales WHERE id = ?', paid.sale_id).status, 'refunded');
  // Inside the late-cancel window the session is used, unless staff waive it.
  const soon = new Date(Date.now() + 2 * 3600000).toISOString();
  app.ctx.db.run('UPDATE class_sessions SET starts_at = ?, ends_at = ? WHERE id = ?', soon, soon, s2.id);
  await owner('POST', `/v1/clients/${c.id}/credits`, { delta: 2, credit_type: 'group' });
  const again = (await desk('POST', `/v1/sessions/${s2.id}/bookings`, { client_id: c.id })).body;
  const late = (await desk('POST', `/v1/bookings/${again.id}/cancel`, {})).body;
  assert.equal(late.late, true);
  assert.equal((await owner('GET', `/v1/clients/${c.id}/credits`)).body.balance, 1, 'a late cancel keeps the session used');
  const again2 = (await desk('POST', `/v1/sessions/${s2.id}/bookings`, { client_id: c.id })).body;
  const waived = (await desk('POST', `/v1/bookings/${again2.id}/cancel`, { waive: true })).body;
  assert.equal(waived.late, false);
  assert.equal((await owner('GET', `/v1/clients/${c.id}/credits`)).body.balance, 1, 'waived: the session came back');
});

test('family: staff fix a parent\'s details (athlete email in step, texts off for a new number), re-send sign-in, record a paper waiver, remove a second parent', async () => {
  const c = await kid('Fay Family');
  const fam = c.family, g = fam.guardians[0];
  // An adult sibling who signs in with the same email as the parent account (they share one address).
  app.ctx.db.run('UPDATE clients SET email = ? WHERE id = ?', g.email, c.id);
  app.ctx.db.run('UPDATE guardians SET sms_opt_in_at = ?, phone = ? WHERE id = ?', new Date().toISOString(), '+15125550123', g.id);
  const fixed = await desk('PATCH', `/v1/families/${fam.id}/guardians/${g.id}`, { name: 'Faye Parent', email: 'Faye.New@Example.com', phone: '(512) 555-0124' });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.guardians[0].email, 'faye.new@example.com');
  assert.equal(fixed.body.guardians[0].texts, 'off', 'a new number has to turn texts on again');
  assert.equal(fixed.body.texts_turned_off, true);
  assert.equal((await owner('GET', `/v1/clients/${c.id}`)).body.email, 'faye.new@example.com', 'the athlete email kept in step');
  const other = await kid('Oli Other');
  assert.equal((await desk('PATCH', `/v1/families/${fam.id}/guardians/${g.id}`, { email: other.family.guardians[0].email })).status, 409);
  assert.equal((await desk('PATCH', `/v1/families/${other.family.id}/guardians/${g.id}`, { name: 'Wrong family' })).status, 404);
  assert.equal((await desk('PATCH', `/v1/families/${fam.id}/guardians/${g.id}`, {})).status, 400);
  // Re-send the sign-in email.
  const sent = await desk('POST', `/v1/families/${fam.id}/guardians/${g.id}/welcome`);
  assert.deepEqual(sent.body, { sent_to: 'faye.new@example.com' });
  assert.match(outbox()[0].body, /\/portal and enter this email address \(faye\.new@example\.com\)/);
  // Paper waiver at the desk.
  const w = await desk('POST', `/v1/families/${fam.id}/waiver`, { signed_by: 'Faye Parent' });
  assert.equal(w.body.waiver.signed, true);
  assert.match(w.body.waiver.signed_by, /^Faye Parent \(on paper, recorded by Dana Desk\)$/);
  assert.equal((await desk('POST', `/v1/families/${fam.id}/waiver`, { signed_by: 'Faye Parent' })).status, 409, 'already signed');
  // A second parent signs in, then is removed (owner or coach): their sign-in ends at once.
  const second = (await desk('POST', `/v1/families/${fam.id}/guardians`, { name: 'Sam Second', email: 'sam.second@example.com' })).body.guardians.find((x) => x.email === 'sam.second@example.com');
  const code = (await req('POST', '/portal/api/login', { email: 'sam.second@example.com' })).body.dev_code;
  const parent = as((await req('POST', '/portal/api/verify', { email: 'sam.second@example.com', code })).cookie);
  assert.equal((await parent('GET', '/portal/api/me')).status, 200);
  assert.equal((await desk('DELETE', `/v1/families/${fam.id}/guardians/${second.id}`)).status, 403, 'front desk doesn\'t remove parents');
  assert.equal((await coach('DELETE', `/v1/families/${fam.id}/guardians/${second.id}`)).status, 200);
  assert.equal((await parent('GET', '/portal/api/me')).status, 401);
});

test('the workout-app link by email: to the athlete and parents, never to an archived client, and front desk can send it', async () => {
  const c = await kid('Lee Link');
  const r = await desk('POST', `/v1/clients/${c.id}/app-link/email`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sent_to, [c.family.guardians[0].email]);
  const token = app.ctx.db.get('SELECT access_token FROM clients WHERE id = ?', c.id).access_token;
  assert.ok(outbox()[0].body.includes(`/app?token=${token}`));
  assert.match(outbox()[0].subject, /Lee's workout app link/);
  const adult = (await owner('POST', '/v1/clients', { name: 'Ann Adult', email: 'ann.adult@example.com' })).body;
  assert.deepEqual((await coach('POST', `/v1/clients/${adult.id}/app-link/email`)).body.sent_to, ['ann.adult@example.com']);
  assert.match(outbox()[0].subject, /^Your workout app link/);
  await owner('POST', `/v1/clients/${c.id}/archive`);
  const refused = await desk('POST', `/v1/clients/${c.id}/app-link/email`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /archived/);
});

test('roles: a walk-in check-in gives coaches no price; profile reads keep amounts from coaches and front desk', async () => {
  const c = await kid('Rae Roles');
  await owner('POST', `/v1/clients/${c.id}/card/test`);
  await owner('POST', `/v1/clients/${c.id}/subscription`, { plan_id: plan.id });
  const chk = await coach('POST', `/v1/clients/${c.id}/check-ins`, { location_id: facility.id });
  assert.equal(chk.status, 201);
  noCents(chk.body, 'coach walk-in');
  for (const who of [coach, desk]) {
    noCents((await who('GET', `/v1/clients/${c.id}`)).body, 'profile');
    noCents((await who('PATCH', `/v1/clients/${c.id}`, { sport: 'Tennis' })).body, 'saved profile');
  }
  assert.equal((await owner('GET', `/v1/clients/${c.id}`)).body.subscription.price_cents, 9900, 'the owner sees the price');
});

// ---------- Review fixes ----------
test('review: an impossible birthday is refused at the first step of sign-up and in an import, never halfway through', async () => {
  await owner('PATCH', '/v1/settings', { public_signup: 'on' });
  const r = await req('POST', '/portal/api/signup', { accept_terms: true, parent: { name: 'Feb Parent', email: 'feb.parent@example.com' }, athletes: [{ name: 'Ok Kid', birth_date: '2013-02-28' }, { name: 'Feb Kid', birth_date: '2013-02-30' }] });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(app.ctx.db.get('SELECT id FROM guardians WHERE email = ?', 'feb.parent@example.com'), undefined);
  const csv = 'Athlete first name,Athlete last name,Birthday (YYYY-MM-DD),Parent name,Parent email\nApril,Kid,2013-04-31,Ap Parent,ap.parent@example.com\n';
  const p = (await owner('POST', '/v1/client-import/preview', { csv })).body;
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => /"2013-04-31" isn't a birthday/.test(e.message)), JSON.stringify(p.errors));
});

test('review: team roster attendance counts as a visit and as last seen', async () => {
  const c = await kid('Tia Teamvisit');
  const school = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Roosevelt HS', contact_email: 'ad@roosevelt.example' }, name: 'JV', monthly_cents: 50000 })).body;
  assert.equal((await owner('POST', `/v1/team-contracts/${school.id}/roster/existing`, { client_id: c.id })).status, 201);
  const s = new Date(Date.now() - 26 * 3600000).toISOString(), e = new Date(Date.now() - 25 * 3600000).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES ('cls_team_visit', 'JV lift', 'team', ?, ?, ?, 30, 'scheduled', ?)`, facility.id, s, e, s);
  assert.equal((await coach('GET', `/v1/clients/${c.id}/attendance`)).body.summary.visits_30, 0);
  app.ctx.db.run('INSERT INTO team_attendance (session_id, client_id, created_at) VALUES (?, ?, ?)', 'cls_team_visit', c.id, e);
  const a = (await coach('GET', `/v1/clients/${c.id}/attendance`)).body;
  assert.equal(a.summary.visits_30, 1);
  assert.equal(a.summary.last_visit_at, s);
  assert.equal(a.recent[0].session_name, 'JV lift');
  assert.equal(a.recent[0].outcome, 'attended');
  const listed = (await coach('GET', '/v1/clients')).body.data.find((x) => x.id === c.id);
  assert.equal(listed.last_seen_at, s);
});

test('review: front desk never counts coach-only pinned notes on a family page either', async () => {
  const c = await kid('Pip Pinned');
  await coach('POST', `/v1/clients/${c.id}/notes`, { body: 'Coach only', pinned: true, coach_only: true });
  const fam = (await desk('GET', `/v1/families/${c.family.id}`)).body;
  assert.equal(fam.athletes.find((x) => x.id === c.id).pinned_notes, 0);
  assert.equal((await coach('GET', `/v1/families/${c.family.id}`)).body.athletes.find((x) => x.id === c.id).pinned_notes, 1);
});

test('review: a new sign-in email signs out whoever signed in with the old one', async () => {
  const c = await kid('Tay Typo');
  const g = c.family.guardians[0];
  const code = (await req('POST', '/portal/api/login', { email: g.email })).body.dev_code;
  const parent = as((await req('POST', '/portal/api/verify', { email: g.email, code })).cookie);
  assert.equal((await parent('GET', '/portal/api/me')).status, 200);
  assert.equal((await desk('PATCH', `/v1/families/${c.family.id}/guardians/${g.id}`, { name: 'Tay Parent' })).status, 200);
  assert.equal((await parent('GET', '/portal/api/me')).status, 200, 'a name fix keeps them signed in');
  assert.equal((await desk('PATCH', `/v1/families/${c.family.id}/guardians/${g.id}`, { email: 'tay.fixed@example.com' })).status, 200);
  assert.equal((await parent('GET', '/portal/api/me')).status, 401);
});

test('review: the same name with different capitals or extra spaces is still a possible duplicate', async () => {
  const first = await kid('Zoë Ángel', { birth_date: '2011-07-07' });
  const r = await owner('POST', '/v1/clients', { name: '  ZOË   ÁNGEL ', birth_date: '2011-07-07', check_duplicates: true, parent: { name: 'Other Parent', email: `zz${++n}@example.com` } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'possible_duplicate');
  assert.deepEqual(r.body.error.details.duplicates.map((d) => d.id), [first.id]);
});
