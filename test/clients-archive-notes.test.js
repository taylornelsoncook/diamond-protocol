// Archiving clients who stopped training, staff notes on a client, and what "active client" means.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser, dashboard } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDaysToDate, localDate, weekdayOf, zonedToUtc } from '../src/util.js';
import { atRisk } from '../src/services/insights.js';
import { candidates } from '../src/services/spots.js';
import { sendReminders } from '../src/services/sms.js';
import { runReviewRequests } from '../src/services/reviews.js';
import { exportFamily } from '../src/services/legal.js';
import { recipients } from '../src/services/campaigns.js';

let app, base, owner, coach, desk, coachId, facility, plan;
const TZ = 'America/Chicago';

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email, password) => as((await req('POST', '/auth/login', { email, password })).cookie);
const day = (n) => addDaysToDate(localDate(new Date().toISOString(), TZ), n);
let n = 0;
const kid = async (name) => (await owner('POST', '/v1/clients', { name, birth_date: '2012-05-05', parent: { name: `Parent ${name}`, email: `parent${++n}@example.com`, phone: '+15125550100' } })).body;

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  coachId = createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'coach-password-1', role: 'coach' }).id;
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

test('archiving: owners and coaches, not front desk; refused with a membership; bookings canceled only once confirmed', async () => {
  const ava = await kid('Ava Archive');
  await owner('POST', `/v1/clients/${ava.id}/card/test`);
  await owner('POST', `/v1/clients/${ava.id}/subscription`, { plan_id: plan.id });
  assert.equal((await desk('POST', `/v1/clients/${ava.id}/archive`)).status, 403);
  const withPlan = await coach('POST', `/v1/clients/${ava.id}/archive`);
  assert.equal(withPlan.status, 409);
  assert.match(withPlan.body.error.message, /membership \(active\)\. Cancel it first/);
  await owner('POST', `/v1/clients/${ava.id}/subscription/cancel`);

  const s = (await owner('POST', '/v1/sessions', { name: 'Speed', kind: 'group', location_id: facility.id, date: day(2), start_time: '17:00', capacity: 5, drop_in_cents: 2000 })).body;
  await owner('POST', `/v1/clients/${ava.id}/credits`, { delta: 1, credit_type: 'group' });
  const b = (await coach('POST', `/v1/sessions/${s.id}/bookings`, { client_id: ava.id })).body;
  assert.equal(b.coverage, 'credit');
  const ask = await coach('POST', `/v1/clients/${ava.id}/archive`);
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error.code, 'confirm_required');
  assert.match(ask.body.error.message, /1 upcoming booking/);
  assert.equal(ask.body.error.details.bookings[0].id, b.id);
  assert.equal((await owner('GET', `/v1/clients/${ava.id}`)).body.archived_at, null, 'nothing changed without the confirmation');

  const done = (await coach('POST', `/v1/clients/${ava.id}/archive`, { confirm: true })).body;
  assert.ok(done.archived_at);
  assert.equal(done.archived_by, 'Carl Coach');
  assert.equal((await owner('GET', `/v1/clients/${ava.id}/bookings`)).body.data.length, 0);
  assert.equal((await owner('GET', `/v1/clients/${ava.id}/credits`)).body.balance, 1, 'the credit came back');
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/archive`)).status, 409, 'already archived');
  // Archived clients can't be booked, enrolled or given a membership until they're brought back.
  assert.equal((await coach('POST', `/v1/sessions/${s.id}/bookings`, { client_id: ava.id })).status, 409);
  assert.equal((await owner('POST', `/v1/clients/${ava.id}/subscription`, { plan_id: plan.id })).status, 409);
  const events = (await coach('GET', '/v1/events?type=client.archived')).body.data;
  assert.equal(events[0].data.client_name, 'Ava Archive');
  // The audit log records who did it.
  assert.ok((await owner('GET', `/v1/audit?target=${ava.id}`)).body.data.some((a) => a.action === 'POST /v1/clients/:id/archive' && a.status === 200 && a.actor_name === 'Carl Coach'));
  assert.equal((await desk('POST', `/v1/clients/${ava.id}/restore`)).status, 403);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/restore`)).body.archived_at, null);
  assert.equal((await coach('POST', `/v1/clients/${ava.id}/restore`)).status, 409);
});

test('archived clients leave lists, search, pickers, counts and automatic messages, and an Archived filter finds them', async () => {
  const gone = await kid('Zed Gone'), stays = await kid('Zoe Stays');
  // Both trained a lot and then stopped: the at-risk list and the open-spot offers would pick either.
  await owner('POST', `/v1/clients/${stays.id}/card/test`);
  await owner('POST', `/v1/clients/${stays.id}/subscription`, { plan_id: plan.id });
  const d = day(1);
  const tomorrow = (await owner('POST', '/v1/sessions', { name: 'Tomorrow group', kind: 'group', location_id: facility.id, date: d, start_time: '18:00', capacity: 10 })).body;
  for (const c of [gone, stays]) {
    for (let i = 3; i <= 8; i++) {
      const at = new Date(Date.now() - i * 5 * 86400000).toISOString();
      const id = `cls_past_${c.id}_${i}`;
      app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Old', 'group', ?, ?, ?, 10, 'scheduled', ?)`, id, facility.id, at, at, at);
      app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'attended', 'none', ?, ?)`, `bkg_${id}`, id, c.id, at, at);
    }
  }
  const before = dashboard(app.ctx).metrics;
  await owner('POST', `/v1/clients/${gone.id}/archive`);
  assert.equal(dashboard(app.ctx).metrics.archived_clients, before.archived_clients + 1);

  const list = (await coach('GET', '/v1/clients')).body;
  assert.ok(!list.data.some((c) => c.id === gone.id));
  assert.ok(list.data.some((c) => c.id === stays.id));
  const search = (await desk('GET', '/v1/clients?q=zed')).body;
  assert.equal(search.data.length, 0);
  assert.equal(search.archived_matches, 1, 'the list can say an archived client matches');
  assert.deepEqual((await desk('GET', '/v1/clients?archived=true')).body.data.map((c) => c.id), [gone.id]);
  assert.ok((await owner('GET', '/v1/clients?archived=all')).body.data.some((c) => c.id === gone.id));
  assert.ok(atRisk(app.ctx).some((r) => r.client_id === stays.id));
  assert.ok(!atRisk(app.ctx).some((r) => r.client_id === gone.id), 'no "check on" nudges');
  assert.ok(!candidates(app.ctx, { ...tomorrow, starts_at: tomorrow.starts_at }).some((f) => f.athletes.some((a) => a.id === gone.id)), 'no open-spot offers');
  // A booking that slipped through before archiving gets no reminder text.
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES ('bkg_slip', ?, ?, 'booked', 'none', ?, ?)`, tomorrow.id, gone.id, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
  app.ctx.sms = {};
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES ('bkg_stay', ?, ?, 'booked', 'none', ?, ?)`, tomorrow.id, stays.id, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
  app.ctx.db.run(`UPDATE guardians SET sms_opt_in_at = ? WHERE family_id IN (?, ?)`, new Date().toISOString(), gone.family.id, stays.family.id);
  await sendReminders(app.ctx, zonedToUtc(d, '09:00', TZ));
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM texts WHERE family_id = ?`, stays.family.id).n, 1, 'the family still training gets its reminder');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM texts WHERE family_id = ?`, gone.family.id).n, 0);
  app.ctx.db.run(`DELETE FROM bookings WHERE id = 'bkg_slip'`);
  // Google review asks skip them too (their 10th session this week would otherwise trigger one).
  await owner('PATCH', '/v1/settings', { review_url: 'https://g.page/r/example/review', review_requests: 'on' });
  for (let i = 0; i < 10; i++) {
    const at = zonedToUtc(day(-1), `08:${String(i * 5).padStart(2, '0')}`, TZ), id = `cls_rev_${i}`;
    app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Recent', 'group', ?, ?, ?, 10, 'scheduled', ?)`, id, facility.id, at, at, at);
    for (const c of [gone, stays]) app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'attended', 'none', ?, ?)`, `bkg_${id}_${c.id}`, id, c.id, at, at);
  }
  await runReviewRequests(app.ctx, { asOf: zonedToUtc(day(0), '12:00', TZ) });
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM review_requests WHERE client_id = ?', stays.id).n, 1, 'the athlete still training is asked');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM review_requests WHERE client_id = ?', gone.id).n, 0);
  // Announcement emails to everyone leave them out.
  const reached = recipients(app.ctx, { group: 'everyone' }).map((r) => r.email);
  assert.ok(reached.includes(stays.family.guardians[0].email));
  assert.ok(!reached.includes(gone.family.guardians[0].email), 'archived family not in the audience');
});

test('"active client" means the same on Today and in the client list: not archived, paid up or on a free trial', async () => {
  const counts = (await owner('GET', '/v1/client-counts')).body;
  const current = (await owner('GET', '/v1/clients?status=current')).body.data;
  assert.equal(counts.current, current.length);
  assert.ok(current.every((c) => ['active', 'trialing'].includes(c.status) && !c.archived_at));
  for (const who of [owner, coach, desk]) {
    const m = (await who('GET', '/v1/dashboard')).body.metrics;
    assert.equal(m.active_clients, current.length);
    assert.equal(m.paying_clients + m.trialing_clients, current.length);
  }
  // A trial counts; a paused or past-due membership doesn't.
  const trial = (await owner('POST', '/v1/plans', { name: 'Trial plan', price_cents: 5000, trial_days: 7 })).body;
  const t = await kid('Tia Trial');
  await owner('POST', `/v1/clients/${t.id}/subscription`, { plan_id: trial.id });
  assert.equal((await owner('GET', '/v1/dashboard')).body.metrics.active_clients, current.length + 1);
  await owner('POST', `/v1/clients/${t.id}/subscription/pause`);
  assert.equal((await owner('GET', '/v1/dashboard')).body.metrics.active_clients, current.length);
  assert.equal((await owner('GET', '/v1/clients?status=current')).body.data.length, current.length);
});

test('staff notes: anyone adds, authors edit their own, owners delete any and pin any, front desk never sees coach-only notes', async () => {
  const c = await kid('Nora Notes');
  const riley = await signIn('coach@test.dev', 'coach-password-1');
  const coachNote = (await coach('POST', `/v1/clients/${c.id}/notes`, { body: 'Tight hamstring. Easy on sprints this week.', coach_only: true })).body;
  assert.equal(coachNote.author_name, 'Carl Coach');
  assert.equal(coachNote.coach_only, true);
  const deskNote = (await desk('POST', `/v1/clients/${c.id}/notes`, { body: 'Mom asked for a receipt by email.' })).body;
  assert.equal((await desk('POST', `/v1/clients/${c.id}/notes`, { body: 'x', coach_only: true })).status, 403);
  assert.equal((await desk('POST', `/v1/clients/${c.id}/notes`, { body: '' })).status, 400);
  assert.equal((await desk('POST', `/v1/clients/${c.id}/notes`, { body: 'x', pinned: 'yes' })).status, 400);
  const ownerNote = (await owner('POST', `/v1/clients/${c.id}/notes`, { body: 'Pays by check at the start of the month.', pinned: true })).body;

  const deskList = (await desk('GET', `/v1/clients/${c.id}/notes`)).body.data;
  assert.deepEqual(deskList.map((x) => x.id), [ownerNote.id, deskNote.id], 'pinned first, then newest; no coach-only notes');
  assert.deepEqual((await coach('GET', `/v1/clients/${c.id}/notes`)).body.data.map((x) => x.id), [ownerNote.id, deskNote.id, coachNote.id]);
  // Front desk can't read, change or delete a coach-only note, even by id.
  assert.equal((await desk('PATCH', `/v1/client-notes/${coachNote.id}`, { body: 'hacked' })).status, 404);
  assert.equal((await desk('DELETE', `/v1/client-notes/${coachNote.id}`)).status, 404);
  // Authors edit their own; others can't, except the owner pinning.
  assert.equal((await riley('PATCH', `/v1/client-notes/${deskNote.id}`, { body: 'changed' })).status, 403);
  assert.equal((await coach('PATCH', `/v1/client-notes/${deskNote.id}`, { pinned: true })).status, 403);
  const edited = (await desk('PATCH', `/v1/client-notes/${deskNote.id}`, { body: 'Mom asked for a receipt by email. Sent.' })).body;
  assert.ok(edited.updated_at);
  assert.equal((await desk('PATCH', `/v1/client-notes/${deskNote.id}`, { coach_only: true })).status, 403);
  assert.equal((await owner('PATCH', `/v1/client-notes/${coachNote.id}`, { body: 'owner rewrite' })).status, 403);
  assert.equal((await owner('PATCH', `/v1/client-notes/${coachNote.id}`, { pinned: true })).body.pinned, true);
  assert.equal((await coach('PATCH', `/v1/client-notes/${coachNote.id}`, { coach_only: false })).body.coach_only, false);
  assert.ok((await desk('GET', `/v1/clients/${c.id}/notes`)).body.data.some((x) => x.id === coachNote.id), 'no longer coach-only');
  // Deleting: others' notes only for the owner.
  assert.equal((await desk('DELETE', `/v1/client-notes/${ownerNote.id}`)).status, 403);
  assert.equal((await coach('DELETE', `/v1/client-notes/${deskNote.id}`)).status, 403);
  assert.equal((await owner('DELETE', `/v1/client-notes/${deskNote.id}`)).status, 200);
  assert.equal((await coach('DELETE', `/v1/client-notes/${coachNote.id}`)).status, 200);
  assert.equal((await owner('GET', `/v1/clients/nope/notes`)).status, 404);

  // A family's data download includes the notes; deleting the family removes them.
  const exported = exportFamily(app.ctx, c.family.id);
  assert.deepEqual(exported.athletes[0].staff_notes.map((x) => x.note), ['Pays by check at the start of the month.']);
  await owner('DELETE', `/v1/families/${c.family.id}`, { confirm: c.family.name });
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM client_notes WHERE client_id = ?', c.id).n, 0);
});

test('archiving: camp registrations are named and the fee isn\'t claimed as refunded; past camps don\'t need a yes', async () => {
  const cam = await kid('Cam Camper');
  await owner('POST', `/v1/clients/${cam.id}/card/test`);
  const camp = (await owner('POST', '/v1/class-series', { name: 'Fall Camp', kind: 'camp', location_id: facility.id, weekdays: [weekdayOf(day(5))], start_time: '09:00', duration_min: 120, capacity: 10, start_date: day(5), end_date: day(12), registration_cents: 20000 })).body;
  assert.equal((await owner('POST', `/v1/class-series/${camp.id}/register`, { client_id: cam.id, pay: 'card_on_file' })).status, 200);
  const ask = await coach('POST', `/v1/clients/${cam.id}/archive`);
  assert.equal(ask.body.error.code, 'confirm_required');
  assert.match(ask.body.error.message, /a registration for Fall Camp/);
  assert.match(ask.body.error.message, /Fall Camp registration fee isn't refunded automatically/);
  assert.deepEqual(ask.body.error.details.registrations, ['Fall Camp']);
  assert.ok(!/_cents/.test(JSON.stringify(ask.body)));
  const done = await coach('POST', `/v1/clients/${cam.id}/archive`, { confirm: true });
  assert.equal(done.status, 200);
  assert.ok(!/_cents/.test(JSON.stringify(done.body)), 'coaches get no amounts back');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM enrollments WHERE client_id = ? AND status = 'active'`, cam.id).n, 0);

  // A registration for a camp that is over is ended quietly: nothing to confirm.
  const old = await kid('Olly Oldcamp');
  const past = (await owner('POST', '/v1/class-series', { name: 'Summer Camp', kind: 'camp', location_id: facility.id, weekdays: [weekdayOf(day(6))], start_time: '09:00', duration_min: 60, capacity: 10, start_date: day(6), end_date: day(6), registration_cents: 0 })).body;
  await owner('POST', `/v1/class-series/${past.id}/register`, { client_id: old.id });
  app.ctx.db.run(`UPDATE class_sessions SET starts_at = '2026-01-01T15:00:00.000Z', ends_at = '2026-01-01T16:00:00.000Z' WHERE series_id = ?`, past.id);
  const quiet = await coach('POST', `/v1/clients/${old.id}/archive`);
  assert.equal(quiet.status, 200);
  assert.ok(quiet.body.archived_at);
});

test('a booking that was paying while the client was archived is refunded instead of left on an archived client', async () => {
  const { archiveClient } = await import('../src/services/clients.js');
  const { book } = await import('../src/services/schedule.js');
  const rae = await kid('Rae Race');
  await owner('POST', `/v1/clients/${rae.id}/card/test`);
  const s1 = (await owner('POST', '/v1/sessions', { name: 'Early', kind: 'group', location_id: facility.id, date: day(2), start_time: '06:00', capacity: 5, drop_in_cents: 2000 })).body;
  const s2 = (await owner('POST', '/v1/sessions', { name: 'Later', kind: 'group', location_id: facility.id, date: day(2), start_time: '07:00', capacity: 5, drop_in_cents: 2000 })).body;
  await book(app.ctx, { sessionId: s1.id, clientId: rae.id, pay: 'card_on_file', isCoach: true });
  const parent = book(app.ctx, { sessionId: s2.id, clientId: rae.id, pay: 'card_on_file' });   // a parent paying in the portal
  const [b, a] = await Promise.allSettled([parent, archiveClient(app.ctx, rae.id, { confirm: true }, { name: 'Carl Coach' })]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM bookings WHERE client_id = ? AND status IN ('booked','waitlisted')`, rae.id).n, 0, 'no live booking on an archived client');
  const sales = app.ctx.db.all(`SELECT amount_cents, refunded_cents FROM sales WHERE client_id = ? AND status IN ('succeeded','partially_refunded','refunded')`, rae.id);
  assert.ok(sales.every((x) => x.refunded_cents === x.amount_cents), `every charge refunded: ${JSON.stringify(sales)}`);
  if (b.status === 'rejected') assert.match(b.reason.message, /archived/);

  // Nothing to cancel, so archiving is instant: the booking already past its checks undoes itself when it sees the archive.
  const ty = await kid('Ty Tardy');
  await owner('POST', `/v1/clients/${ty.id}/card/test`);
  const late = book(app.ctx, { sessionId: s2.id, clientId: ty.id, pay: 'card_on_file' });
  let waits = 0;
  while (!app.ctx.db.get('SELECT 1 FROM sales WHERE client_id = ?', ty.id) && waits++ < 50) await Promise.resolve();
  await archiveClient(app.ctx, ty.id, { confirm: true }, null);
  await assert.rejects(late, /archived/);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM bookings WHERE client_id = ?`, ty.id).n, 0);
  const sale = app.ctx.db.get('SELECT amount_cents, refunded_cents FROM sales WHERE client_id = ?', ty.id);
  assert.equal(sale.refunded_cents, sale.amount_cents, 'the charge went back');
});

test('front desk can read the client counts', async () => {
  const r = await desk('GET', '/v1/client-counts');
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.current, 'number');
});
