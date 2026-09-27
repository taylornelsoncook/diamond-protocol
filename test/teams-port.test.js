// Teams: statements, one payment for several invoices, roster checks and linking, sessions that follow the contract,
// restarting billing, payment date checks, the public invoice page and overdue reminders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import * as teams from '../src/services/teams.js';
import * as schedule from '../src/services/schedule.js';
import { localDate, addDaysToDate, weekdayOf, zonedToUtc, newId } from '../src/util.js';

const TZ = 'America/Chicago';
let app, base, owner, coach, desk, facility;
const req = async (method, path, body, cookie) => {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const as = (cookie) => (m, p, b) => req(m, p, b, cookie);
const signIn = async (email) => (await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) })).headers.get('set-cookie').split(';')[0];
const today = () => localDate(new Date().toISOString(), TZ);
const monthsAgo = (n) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
const later = (days) => ({ ...app.ctx, now: () => new Date(Date.now() + days * 86400000).toISOString() });
const sched = (ctx) => ({ updateSeries: (id, b) => schedule.updateSeries(ctx, id, b), cancelSession: (id, o) => schedule.cancelSession(ctx, id, o), generateSessions: (id) => schedule.generateSessions(ctx, id) });
const outbox = async () => (await owner('GET', '/v1/outbox')).body.data;
let n = 0;
const newContract = async (extra = {}) => (await owner('POST', '/v1/team-contracts', { organization: { name: `School ${++n}`, contact_email: `ad${n}@school.example`, contact_name: 'Pat Director' }, name: 'Varsity', monthly_cents: 100000, ...extra })).body;

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://dp.example' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = as(await signIn('owner@test.dev')); coach = as(await signIn('coach@test.dev')); desk = as(await signIn('desk@test.dev'));
  await owner('PATCH', '/v1/settings', { timezone: TZ, business_address: '100 Main St, Austin TX', payment_instructions: 'Checks payable to Diamond Protocol LLC.' });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

test('a new contract points at the field to fix, refuses a duplicate active team, and asks about months already started', async () => {
  const bad = async (body) => (await owner('POST', '/v1/team-contracts', { organization: { name: 'Lake Travis HS' }, name: 'Varsity', monthly_cents: 90000, ...body })).body.error;
  assert.equal((await bad({ name: ' ' })).details.field, 'name');
  assert.equal((await bad({ monthly_cents: 0 })).details.field, 'monthly_cents');
  assert.equal((await bad({ start_date: '2026-02-30' })).details.field, 'start_date', 'Feb 30 is not a date');
  assert.equal((await bad({ end_date: '2020-01-01', start_date: '2026-01-01' })).details.field, 'end_date');
  assert.equal((await bad({ organization: { name: 'Lake Travis HS', contact_email: 'nope' } })).details.field, 'contact_email');
  assert.equal((await bad({ past: 'some' })).details.field, 'past');
  assert.equal((await owner('GET', '/v1/organizations')).body.data.filter((o) => o.name === 'Lake Travis HS').length, 0, 'a refused contract leaves no school behind');

  const first = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Lake Travis HS' }, name: 'Varsity', monthly_cents: 90000 })).body;
  const dup = await owner('POST', '/v1/team-contracts', { organization: { name: 'lake travis hs' }, name: 'VARSITY', monthly_cents: 90000 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.details.field, 'name');
  assert.equal((await owner('POST', '/v1/team-contracts', { org_id: first.org_id, name: 'Varsity', monthly_cents: 1 })).status, 409);
  assert.equal((await owner('POST', '/v1/team-contracts', { org_id: first.org_id, name: 'JV', monthly_cents: 50000 })).status, 201, 'another team at the same school is fine');

  const all = await newContract({ start_date: monthsAgo(2) });
  assert.equal(all.invoices.length, 3, 'past=all (default) invoices every month that has started');
  const current = await newContract({ start_date: monthsAgo(2), past: 'current' });
  assert.deepEqual(current.invoices.map((i) => i.period_start), [monthsAgo(0)], 'only the month running now');
  const none = await newContract({ start_date: monthsAgo(2), past: 'none' });
  assert.equal(none.invoices.length, 0, 'months billed another way are skipped');
  assert.ok(none.next_invoice_on > today());
  assert.equal((await teams.runTeamBilling(app.ctx)).invoiced, 0, 'the billing job doesn\'t go back and bill them');
});

test('a pasted list is checked first: problem lines are listed and nothing is saved', async () => {
  const c = await newContract();
  const plan = (await owner('POST', `/v1/team-contracts/${c.id}/roster/check`, { names: 'Name\tPosition\tGrad year\n12\tJalen Brooks\tQB\t2027\nMarcus Hill #22, WR, Class of 2028\n3. Ty Ortiz, RB, \'29\nDeon Parkes 7\nMadonna\nEli Grant, OL, 1990\nJalen Brooks' })).body;
  assert.deepEqual(plan.rows.map((r) => r.status), ['new', 'new', 'new', 'new', 'error', 'error', 'skip']);
  const [jalen, marcus, ty, deon, madonna, eli] = plan.rows;
  assert.deepEqual([jalen.name, jalen.position, jalen.grad_year], ['Jalen Brooks', 'QB', 2027], 'jersey column and header row are dropped');
  assert.deepEqual([marcus.name, marcus.position, marcus.grad_year], ['Marcus Hill', 'WR', 2028]);
  assert.deepEqual([ty.name, ty.grad_year], ['Ty Ortiz', 2029]);
  assert.equal(deon.name, 'Deon Parkes');
  assert.match(madonna.error, /Line 6 needs a first and last name/);
  assert.match(eli.error, /1990 doesn't look like a grad year/);
  const saved = await owner('POST', `/v1/team-contracts/${c.id}/roster`, { names: 'Jalen Brooks, QB\nMadonna' });
  assert.equal(saved.status, 409);
  assert.equal(saved.body.error.code, 'roster_rejected');
  assert.deepEqual(saved.body.error.details.map((d) => d.line), [2]);
  assert.equal((await owner('GET', `/v1/team-contracts/${c.id}`)).body.roster.length, 0, 'all or nothing');
});

test('names that match a client you already have can be linked instead of added again', async () => {
  const c = await newContract();
  const ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', email: 'ava@example.com' })).body;
  await owner('POST', `/v1/team-contracts/${c.id}/roster`, { names: 'Zoe Patel' });
  const plan = (await owner('POST', `/v1/team-contracts/${c.id}/roster/check`, { names: 'ava lopez, Winger, 2031\nZoe Patel\nSofia Ramirez' })).body;
  assert.deepEqual(plan.counts, { new: 1, match: 1, skip: 1, error: 0 });
  assert.equal(plan.rows[0].matches[0].id, ava.id);
  assert.equal((await owner('POST', `/v1/team-contracts/${c.id}/roster`, { names: 'ava lopez\nSofia Ramirez', links: { 1: 'cli_not_a_match' } })).status, 409, 'a link must be one of the matches');
  assert.equal((await owner('POST', `/v1/team-contracts/${c.id}/roster`, { names: 'ava lopez\nSofia Ramirez', links: { 2: ava.id } })).status, 409, 'a line that doesn\'t match can\'t be linked');
  const r = (await owner('POST', `/v1/team-contracts/${c.id}/roster`, { names: 'ava lopez, Winger, 2031\nZoe Patel\nSofia Ramirez', links: { 1: ava.id } })).body;
  assert.deepEqual([r.added, r.linked, r.skipped], [1, 1, 1]);
  const row = r.data.find((x) => x.client_id === ava.id);
  assert.deepEqual([row.name, row.position, row.grad_year], ['Ava Lopez', 'Winger', 2031]);
  assert.equal(r.data.length, 3);
  const again = (await owner('POST', `/v1/team-contracts/${c.id}/roster/check`, { names: 'Ava Lopez' })).body;
  assert.equal(again.rows[0].status, 'skip', 'already on this roster');
});

test('add an existing client: moving from another team asks first; removing has undo that keeps attendance', async () => {
  const school = await newContract(), club = await newContract({ name: '14U' });
  const cole = (await owner('POST', '/v1/clients', { name: 'Cole Park', email: 'cole@example.com' })).body;
  const found = (await owner('GET', `/v1/team-contracts/${school.id}/client-search?q=cole`)).body.data;
  assert.equal(found[0].id, cole.id);
  assert.equal(found[0].teams, null);
  assert.equal((await owner('GET', `/v1/team-contracts/${school.id}/client-search?q=${cole.athlete_id.toLowerCase()}`)).body.data[0].id, cole.id, 'by Athlete ID too');
  assert.equal((await owner('POST', `/v1/team-contracts/${school.id}/roster/existing`, { client_id: cole.id })).status, 201);
  assert.equal((await owner('POST', `/v1/team-contracts/${school.id}/roster/existing`, { client_id: cole.id })).status, 409, 'already on it');
  assert.match((await owner('GET', `/v1/team-contracts/${club.id}/client-search?q=cole`)).body.data[0].teams, /Varsity/);
  const ask = await owner('POST', `/v1/team-contracts/${club.id}/roster/existing`, { client_id: cole.id });
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error.code, 'confirm_required');
  assert.equal((await owner('GET', `/v1/team-contracts/${club.id}`)).body.roster.length, 0, 'nothing changes until they choose');
  const kept = (await owner('POST', `/v1/team-contracts/${club.id}/roster/existing`, { client_id: cole.id, keep: true })).body;
  assert.equal(kept.also_on.length, 1);
  assert.equal((await owner('GET', `/v1/team-contracts/${school.id}`)).body.roster.length, 1, 'keep leaves them on both');
  const third = await newContract({ name: 'Summer' });
  const moved = (await owner('POST', `/v1/team-contracts/${third.id}/roster/existing`, { client_id: cole.id, move: true })).body;
  assert.equal(moved.moved_from.length, 2);
  assert.equal((await owner('GET', `/v1/team-contracts/${school.id}`)).body.roster.length, 0, 'move takes them off the other rosters');
  await owner('POST', `/v1/clients/${cole.id}/archive`, {});
  assert.equal((await owner('POST', `/v1/team-contracts/${school.id}/roster/existing`, { client_id: cole.id })).status, 409, 'archived clients can\'t be added');

  // Remove and undo: the same line comes back with its join date and attendance.
  const tomorrow = addDaysToDate(today(), 1);
  const series = (await owner('POST', `/v1/team-contracts/${school.id}/sessions`, { location_id: facility.id, weekdays: [weekdayOf(tomorrow)], start_time: '16:00', duration_min: 60, start_date: tomorrow })).body;
  const [jalen] = (await owner('POST', `/v1/team-contracts/${school.id}/roster`, { names: 'Jalen Brooks' })).body.data;
  app.ctx.db.run('UPDATE team_roster SET created_at = ? WHERE id = ?', zonedToUtc(addDaysToDate(today(), -20), '09:00', TZ), jalen.id);
  const past = [-14, -7].map((d) => { const id = newId('cls'), at = zonedToUtc(addDaysToDate(today(), d), '16:00', TZ);
    app.ctx.db.run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, ?, 'Varsity', 'team', ?, ?, ?, 20, 'scheduled', ?)`, id, series.id, facility.id, at, new Date(Date.parse(at) + 3600000).toISOString(), at);
    return { id, at }; });
  await owner('POST', `/v1/sessions/${past[1].id}/team-attendance`, { roster_id: jalen.id, present: true });
  const before = (await owner('GET', `/v1/team-contracts/${school.id}`)).body;
  const row = before.roster[0];
  assert.deepEqual([row.sessions_attended, row.sessions_held, row.attendance_rate, row.last_seen], [1, 2, 0.5, past[1].at]);
  assert.deepEqual(before.recent_sessions.map((s) => [s.here, s.roster]), [[1, 1], [0, 1]], 'newest first');
  assert.equal(before.team_rate, 0.5);
  assert.equal((await owner('DELETE', `/v1/team-contracts/${school.id}/roster/${jalen.id}`)).body.data.length, 0);
  assert.equal((await owner('DELETE', `/v1/team-contracts/${school.id}/roster/${jalen.id}`)).status, 404, 'already removed');
  const back = (await owner('POST', `/v1/team-contracts/${school.id}/roster/${jalen.id}/restore`)).body.data[0];
  assert.deepEqual([back.sessions_attended, back.sessions_held], [1, 2]);
  assert.equal((await owner('POST', `/v1/team-contracts/${club.id}/roster/${jalen.id}/restore`)).status, 404, 'only on its own contract');
});

test('one payment for several invoices is all or nothing, with one receipt', async () => {
  const c = await newContract({ start_date: monthsAgo(3) });
  const [a, b, x, d] = c.invoices;
  const other = await newContract();
  const pay = (body) => owner('POST', `/v1/team-contracts/${c.id}/payments`, { method: 'check', reference: '#5521', ...body });
  assert.equal((await pay({ invoice_ids: [] })).body.error.details.field, 'invoice_ids');
  assert.equal((await pay({ invoice_ids: [a.id, other.invoices[0].id] })).status, 409, 'another contract\'s invoice');
  assert.equal((await pay({ invoice_ids: [a.id], paid_on: addDaysToDate(today(), 2) })).body.error.details.field, 'paid_on', 'not in the future');
  assert.equal((await pay({ invoice_ids: [a.id], paid_on: '2026-02-30' })).body.error.details.field, 'paid_on', 'a real date');
  assert.equal((await pay({ invoice_ids: [a.id], paid_on: 'last tuesday' })).status, 400);
  assert.equal((await pay({ invoice_ids: [a.id], method: 'online' })).body.error.details.field, 'method', 'online payments come from Stripe');
  assert.equal((await pay({ invoice_ids: [a.id, b.id], total_cents: 150000 })).status, 409, 'the total shown must still be right');
  await owner('POST', `/v1/team-invoices/${d.id}/payments`, { method: 'cash' });
  const mixed = await pay({ invoice_ids: [a.id, b.id, d.id] });
  assert.equal(mixed.status, 409);
  assert.match(mixed.body.error.message, /already paid/);
  assert.equal((await owner('GET', `/v1/team-invoices/${a.id}`)).body.status, 'open', 'nothing was marked paid');
  const mailsBefore = (await outbox()).length;
  const ok = (await pay({ invoice_ids: [a.id, b.id, x.id, a.id], total_cents: 300000, paid_on: addDaysToDate(today(), -1) })).body;
  assert.deepEqual([ok.count, ok.total_cents], [3, 300000]);
  for (const id of [a.id, b.id, x.id]) {
    const i = (await owner('GET', `/v1/team-invoices/${id}`)).body;
    assert.deepEqual([i.status, i.paid_method, i.paid_reference, i.paid_on], ['paid', 'check', '#5521', addDaysToDate(today(), -1)]);
  }
  const mails = (await outbox()).slice(0, (await outbox()).length - mailsBefore);
  assert.equal(mails.filter((m) => m.subject.startsWith('Payment received')).length, 1, 'one receipt for the whole check');
  assert.match(mails[0].body, /\$3,000 by check \(#5521\)/);
  assert.equal((await pay({ invoice_ids: [a.id] })).status, 409, 'can\'t be paid twice');
  const again = await owner('POST', `/v1/team-invoices/${a.id}/payments`, { method: 'check' });
  assert.equal(again.status, 409);
});

test('recording one payment refuses garbled, impossible and future dates', async () => {
  const c = await newContract();
  const [i] = c.invoices;
  for (const paid_on of ['2026-02-30', '2026-13-01', 'soon', addDaysToDate(today(), 1)]) assert.equal((await owner('POST', `/v1/team-invoices/${i.id}/payments`, { paid_on })).status, 400, paid_on);
  assert.equal((await owner('POST', `/v1/team-invoices/${i.id}/payments`, { method: 'bitcoin' })).status, 400);
  assert.equal((await owner('POST', `/v1/team-invoices/${i.id}/payments`, { paid_on: today() })).body.status, 'paid');
});

test('statements list every open invoice with its link and the total', async () => {
  const c = await newContract({ start_date: monthsAgo(1), po_number: 'PO-88' });
  const r = (await owner('POST', `/v1/team-contracts/${c.id}/statement`)).body;
  assert.deepEqual([r.count, r.total_cents, r.to], [2, 200000, c.org.contact_email]);
  const mail = (await outbox()).find((m) => m.subject.startsWith('Statement'));
  assert.match(mail.subject, /\$2,000 open for Varsity/);
  for (const i of c.invoices) assert.ok(mail.body.includes(i.link) && mail.body.includes(i.number));
  assert.ok(mail.body.includes('PO-88') && mail.body.includes('Checks payable') && mail.body.includes('100 Main St'));
  await owner('POST', `/v1/team-contracts/${c.id}/payments`, { invoice_ids: c.invoices.map((i) => i.id) });
  assert.equal((await owner('POST', `/v1/team-contracts/${c.id}/statement`)).status, 409, 'nothing open');
  const noEmail = (await owner('POST', '/v1/team-contracts', { organization: { name: 'No Email FC' }, name: 'U12', monthly_cents: 1000 })).body;
  assert.match((await owner('POST', `/v1/team-contracts/${noEmail.id}/statement`)).body.error.message, /billing email/);
});

test('overdue reminders can go out now; the public invoice says how late it is and how to pay', async () => {
  const c = await newContract({ terms_days: 0, notes: 'AD signs off; do not share' });
  const noEmail = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Quiet Club' }, name: 'U10', monthly_cents: 1000, terms_days: 0 })).body;
  const inFive = later(5);
  const r = await teams.remindOverdueNow(inFive, 'https://dp.example');
  assert.ok(r.sent >= 1);
  assert.ok(r.schools_without_email.includes('Quiet Club'));
  const reminder = (await outbox()).find((m) => m.subject.startsWith('Reminder') && m.to_email === c.org.contact_email);
  assert.match(reminder.body, /5 days past due/);
  assert.equal((await teams.runTeamBilling(inFive)).reminded, 0, 'the weekly reminder then waits a week');
  const token = c.invoices[0].link.split('/invoice/')[1];
  const pub = teams.publicInvoice(inFive, token);
  assert.deepEqual([pub.status, pub.days_past_due, pub.team_name], ['overdue', 5, 'Varsity']);
  assert.ok(!JSON.stringify(pub).includes('AD signs off'), 'staff notes never reach the school');
  const now = (await req('GET', `/invoice-api/${token}`)).body;
  assert.equal(now.days_past_due, 0);
  // Nothing overdue: nothing to send.
  for (const x of [...(await owner('GET', '/v1/team-invoices?status=unpaid')).body.data]) await owner('POST', `/v1/team-invoices/${x.id}/void`);
  await assert.rejects(teams.remindOverdueNow(inFive), /Nothing is overdue/);
  void noEmail;
});

test('team sessions follow the contract end date both ways, and ending says how many came off', async () => {
  const c = await newContract();
  const tomorrow = addDaysToDate(today(), 1);
  const s = (await owner('POST', `/v1/team-contracts/${c.id}/sessions`, { location_id: facility.id, weekdays: [0, 1, 2, 3, 4, 5, 6], start_time: '15:30', duration_min: 60, start_date: tomorrow })).body;
  const removedSchedule = (await owner('POST', `/v1/team-contracts/${c.id}/sessions`, { location_id: facility.id, weekdays: [weekdayOf(tomorrow)], start_time: '18:00', duration_min: 60, start_date: tomorrow })).body;
  const gone = (await owner('DELETE', `/v1/team-contracts/${c.id}/sessions/${removedSchedule.id}`)).body;
  assert.ok(gone.sessions_removed >= 1);
  const upcoming = () => app.ctx.db.get(`SELECT COUNT(*) AS n FROM class_sessions WHERE series_id = ? AND status = 'scheduled' AND starts_at > ?`, s.id, new Date().toISOString()).n;
  const removedCount = () => app.ctx.db.get(`SELECT COUNT(*) AS n FROM class_sessions WHERE series_id = ? AND status = 'scheduled'`, removedSchedule.id).n;
  const full = upcoming();
  assert.ok(full > 20);
  const shorter = (await owner('PATCH', `/v1/team-contracts/${c.id}`, { end_date: addDaysToDate(today(), 10) })).body;
  assert.equal(upcoming(), 10);
  assert.equal(shorter.sessions_removed, full - 10);
  assert.equal(shorter.series.find((x) => x.id === s.id).end_date, addDaysToDate(today(), 10));
  const longer = (await owner('PATCH', `/v1/team-contracts/${c.id}`, { end_date: addDaysToDate(today(), 20) })).body;
  assert.equal(upcoming(), 20);
  assert.equal(longer.sessions_added, 10);
  assert.equal(removedCount(), 0, 'a removed schedule doesn\'t come back');
  const open = (await owner('PATCH', `/v1/team-contracts/${c.id}`, { end_date: null })).body;
  assert.equal(upcoming(), full);
  assert.equal(open.sessions_added, full - 20);
  assert.equal((await owner('POST', `/v1/team-contracts/${c.id}/sessions`, { location_id: facility.id, weekdays: [1], start_time: '15:30', duration_min: 60, start_date: addDaysToDate(today(), 400) })).status, 201);
  // Renaming the team renames its sessions.
  await owner('PATCH', `/v1/team-contracts/${c.id}`, { name: 'Varsity Football' });
  assert.ok((await owner('GET', `/v1/sessions/${app.ctx.db.get(`SELECT id FROM class_sessions WHERE series_id = ? AND starts_at > ? ORDER BY starts_at LIMIT 1`, s.id, new Date().toISOString()).id}`)).body.name.endsWith('Varsity Football'));
  const ended = (await owner('PATCH', `/v1/team-contracts/${c.id}`, { status: 'ended' })).body;
  assert.ok(ended.sessions_removed >= full, 'ending says how many future sessions came off');
  assert.equal(upcoming(), 0);
  assert.equal(ended.end_date, today());
  assert.equal((await owner('POST', `/v1/team-contracts/${c.id}/sessions`, { location_id: facility.id, weekdays: [1], start_time: '15:30', duration_min: 60 })).status, 400, 'no new sessions on an ended contract');
});

test('restarting an ended contract bills from the next billing day, never the months it was ended', async () => {
  const c = await newContract({ start_date: monthsAgo(2) });
  assert.equal(c.invoices.length, 3);
  const ended = (await owner('PATCH', `/v1/team-contracts/${c.id}`, { status: 'ended' })).body;
  assert.equal(ended.status, 'ended');
  // Saving the ended contract unchanged (the form sends every field) doesn't restart it.
  const same = (await owner('PATCH', `/v1/team-contracts/${c.id}`, { name: 'Varsity', monthly_cents: 100000, end_date: ended.end_date, terms_days: 30, po_number: null, notes: 'Paused for the holidays' })).body;
  assert.deepEqual([same.status, same.restarted, same.notes], ['ended', false, 'Paused for the holidays']);
  assert.equal((await owner('PATCH', `/v1/team-contracts/${c.id}`, { end_date: addDaysToDate(today(), -1) })).body.status, 'ended', 'an end date still in the past doesn\'t restart it');
  // Three months later the school signs up again.
  const ctx = later(92);
  const day = localDate(ctx.now(), TZ);
  const r = await teams.updateContract(ctx, c.id, { end_date: null }, sched(ctx), 'https://dp.example');
  assert.equal(r.restarted, true);
  assert.equal(r.status, 'active');
  assert.ok(r.restart_billing_on >= day);
  const periods = r.invoices.filter((i) => i.period_start).map((i) => i.period_start);
  assert.ok(periods.every((p) => p <= today() || p >= day), `no invoices for the months it was ended: ${periods.join(', ')}`);
  assert.ok(periods.length <= 4);
  assert.equal(r.next_invoice_on, r.restart_billing_on === day ? teams.periodStart(c.start_date, 2 + 4) : r.restart_billing_on);
  assert.equal((await teams.runTeamBilling(ctx, { contractId: c.id })).invoiced, 0);
  // status=active (Reactivate) on a contract that ended in the past runs open-ended again.
  const c2 = await newContract({ start_date: monthsAgo(1) });
  await owner('PATCH', `/v1/team-contracts/${c2.id}`, { status: 'ended' });
  assert.equal((await owner('PATCH', `/v1/team-contracts/${c2.id}`, { status: 'active', end_date: addDaysToDate(today(), -3) })).body.error.details.field, 'end_date');
  const back = (await owner('PATCH', `/v1/team-contracts/${c2.id}`, { status: 'active' })).body;
  assert.deepEqual([back.status, back.end_date, back.invoices.length], ['active', null, 2], 'restarting the same day bills nothing extra');
});

test('an online payment that lands after a check was recorded is flagged, not lost', async () => {
  const c = await newContract();
  const [i] = c.invoices;
  await owner('POST', `/v1/team-invoices/${i.id}/payments`, { method: 'check', reference: '1001' });
  assert.equal(await teams.handleInvoiceCheckout(app.ctx, 'checkout.session.completed', { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_twice', metadata: { team_invoice_id: i.id } }), true);
  const ev = (await owner('GET', '/v1/events?type=team_invoice.paid_twice')).body.data[0];
  assert.equal(ev.data.online_reference, 'pi_twice');
  const inv = (await owner('GET', `/v1/team-invoices/${i.id}`)).body;
  assert.deepEqual([inv.paid_method, inv.paid_reference], ['check', '1001'], 'the check stays as recorded');
});

test('the Teams list has attendance, overdue days and a summary; coaches and front desk can\'t reach any of it', async () => {
  const sum = (await owner('GET', '/v1/team-billing/summary')).body;
  assert.ok(sum.collected_30_cents > 0 && sum.active_contracts > 0);
  const list = (await owner('GET', '/v1/team-contracts')).body.data;
  assert.ok(list.every((c) => 'attendance_rate' in c && 'overdue_count' in c));
  const c = list.find((x) => x.status === 'active');
  const paths = [['GET', '/v1/team-billing/summary'], ['POST', '/v1/team-billing/remind-overdue'], ['POST', `/v1/team-contracts/${c.id}/statement`], ['POST', `/v1/team-contracts/${c.id}/payments`],
    ['POST', `/v1/team-contracts/${c.id}/roster/check`], ['POST', `/v1/team-contracts/${c.id}/roster/existing`], ['GET', `/v1/team-contracts/${c.id}/client-search?q=ava`],
    ['POST', `/v1/team-contracts/${c.id}/roster/tr_x/restore`], ['DELETE', `/v1/team-contracts/${c.id}/sessions/ser_x`], ['GET', `/v1/team-contracts/${c.id}`], ['PATCH', `/v1/team-contracts/${c.id}`]];
  for (const who of [coach, desk]) for (const [m, p] of paths) assert.equal((await who(m, p, m === 'GET' ? undefined : {})).status, 403, `${m} ${p}`);
});
