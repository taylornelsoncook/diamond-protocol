// Clients & money: API tests against a fresh demo database. Run with `node --test test/`.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-money-'));
process.env.DP_DB = path.join(dir, 'money-test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const seed = require('../server/seed');
const { get, all, run } = require('../server/db');
const { today, addDays, addMonths } = require('../server/lib');

let server, base;
const jars = {};

async function call(who, method, url, body) {
  const headers = {};
  if (who && jars[who]) headers.cookie = jars[who];
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const as = (who) => ({
  get: (u) => call(who, 'GET', u), post: (u, b = {}) => call(who, 'POST', u, b), put: (u, b = {}) => call(who, 'PUT', u, b),
});
const owner = as('owner'), coach = as('coach'), desk = as('desk'), anon = as(null);

async function login(who, email, password) {
  const res = await fetch(base + '/api/auth/staff/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, `${who} signs in`);
  jars[who] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

// Any key that would reveal money to coaches or front desk.
const MONEY_KEYS = ['price_cents', 'amount_cents', 'monthly_revenue_cents', 'payments', 'monthly_cents', 'paid_cents'];
function assertNoMoney(obj, where) {
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!MONEY_KEYS.includes(k), `${where}: ${p}.${k} must not reach this role`); walk(x, `${p}.${k}`); }
  };
  walk(obj, '');
}
const athleteId = (first, last) => get('SELECT id FROM athletes WHERE first_name=? AND last_name=?', first, last).id;

before(async () => {
  seed.resetDatabase();
  seed.base();
  seed.demo();
  const { app } = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await login('owner', 'owner@demo.test', 'demo-owner-2026');
  await login('coach', 'coach@demo.test', 'demo-coach-2026');
  await login('desk', 'desk@demo.test', 'demo-desk-2026');
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('demo seed: membership history with two declines, school invoices paid by check and overdue', () => {
  assert.equal(get("SELECT COUNT(*) n FROM invoices WHERE kind='membership' AND status='failed'").n, 2);
  assert.ok(get("SELECT COUNT(*) n FROM invoices WHERE kind='membership' AND status='paid'").n >= 10);
  assert.ok(get("SELECT 1 FROM invoices WHERE kind='school' AND status='paid' AND pay_method='check' AND check_number IS NOT NULL"));
  assert.ok(get("SELECT 1 FROM invoices WHERE kind='school' AND status='open' AND due_date < ?", today()));
  for (const c of all('SELECT id FROM team_contracts')) assert.ok(get("SELECT 1 FROM invoices WHERE contract_id=?", c.id), 'both contracts invoiced');
});

test('clients list: search and status filter', async () => {
  const r = await owner.get('/clients?status=past_due');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.clients.map((c) => c.first_name).sort(), ['Kevin', 'Olivia']);
  const byCode = await owner.get('/clients?q=AVALOP');
  assert.equal(byCode.data.clients[0].first_name, 'Ava');
  const byParentEmail = await owner.get('/clients?q=kurt.jensen');
  assert.deepEqual(byParentEmail.data.clients.map((c) => c.first_name).sort(), ['Emma', 'Nate']);
  const byFamily = await owner.get('/clients?q=Okafor family');
  assert.equal(byFamily.data.clients.length, 1);
});

test('coaches and front desk never receive money fields', async () => {
  const id = athleteId('Kevin', 'Nguyen');
  for (const [who, api] of [['coach', coach], ['desk', desk]]) {
    const list = await api.get('/clients');
    assert.equal(list.status, 200);
    assertNoMoney(list.data, `${who} /clients`);
    const prof = await api.get(`/athletes/${id}`);
    assert.equal(prof.status, 200);
    assertNoMoney(prof.data, `${who} /athletes/:id`);
    assert.equal(prof.data.membership.plan_name, 'Unlimited group training', 'plan name is visible');
    assert.equal(prof.data.membership.status, 'past_due', 'status is visible');
    const plans = await api.get('/plans');
    assertNoMoney(plans.data, `${who} /plans`);
    assert.ok(plans.data.length >= 3 && plans.data[0].name);
  }
  const ownerProf = await owner.get(`/athletes/${id}`);
  assert.equal(ownerProf.data.membership.price_cents, 18900);
  assert.ok(Array.isArray(ownerProf.data.payments));
});

test('owner-only money actions are refused for coach and front desk', async () => {
  const m = get("SELECT id FROM memberships WHERE status='active' LIMIT 1");
  const inv = get("SELECT id FROM invoices WHERE status='failed' LIMIT 1");
  const refusals = [
    ['GET', '/invoices'], ['GET', '/teams'], ['GET', '/teams/1'], ['GET', '/schools'], ['POST', '/plans'], ['PUT', '/plans/1'],
    ['POST', `/memberships/${m.id}/pause`], ['POST', `/memberships/${m.id}/cancel`], ['POST', `/invoices/${inv.id}/retry`],
    ['POST', `/invoices/${inv.id}/record-payment`], ['POST', `/athletes/${athleteId('Ava', 'Lopez')}/membership`], ['POST', '/teams'], ['POST', '/billing/run'],
    ['POST', `/athletes/${athleteId('Ava', 'Lopez')}/credits`],
  ];
  for (const who of ['coach', 'desk']) {
    for (const [method, url] of refusals) {
      const r = await call(who, method, url, method === 'GET' ? undefined : {});
      assert.equal(r.status, 403, `${who} ${method} ${url}`);
    }
  }
  assert.equal((await anon.get('/clients')).status, 401);
  assert.equal(get("SELECT status FROM memberships WHERE id=?", m.id).status, 'active');
});

test('front desk cannot see or change coach notes; can edit the rest of the profile', async () => {
  const id = athleteId('Ava', 'Lopez');
  assert.equal((await coach.put(`/athletes/${id}`, { coach_notes: 'Works hard on landings.' })).status, 200);
  const d = await desk.get(`/athletes/${id}`);
  assert.equal('coach_notes' in d.data.athlete, false);
  assert.equal((await desk.put(`/athletes/${id}`, { coach_notes: 'x' })).status, 403);
  assert.equal((await desk.put(`/athletes/${id}`, { injuries: 'Sore wrist', emergency_phone: '801-555-9999' })).status, 200);
  const a = get('SELECT injuries, coach_notes, emergency_phone FROM athletes WHERE id=?', id);
  assert.deepEqual({ ...a }, { injuries: 'Sore wrist', coach_notes: 'Works hard on landings.', emergency_phone: '801-555-9999' });
});

test('new client with a parent: athlete, family, parent login, trial membership, program, welcome email, webhook', async () => {
  const hook = run("INSERT INTO webhooks (url, events, secret) VALUES ('http://127.0.0.1:9/hook', '[\"client.created\"]', 's')").lastInsertRowid;
  const plan = get("SELECT * FROM plans WHERE trial_days > 0 LIMIT 1");
  const program = get('SELECT id FROM programs LIMIT 1');
  const r = await coach.post('/clients', { with_parent: true, name: 'Lily Chen', birthday: '2013-05-02', sport: 'Soccer', school: 'Dixon Middle',
    parent_name: 'Mei Chen', parent_email: 'Mei.Chen@Example.com', parent_phone: '801-555-0111', plan_id: plan.id, program_id: program.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.code, /^LILCHE\d{4}$/);
  assert.equal(r.data.membership.trial, true);
  const a = get('SELECT * FROM athletes WHERE id=?', r.data.id);
  assert.ok(a.workout_token && a.family_id && a.program_id === program.id);
  const p = get('SELECT * FROM parents WHERE family_id=?', a.family_id);
  assert.equal(p.email, 'mei.chen@example.com');
  assert.equal(p.is_self, 0);
  assert.equal(get('SELECT status FROM memberships WHERE athlete_id=?', a.id).status, 'trial');
  const mail = get("SELECT * FROM outbox WHERE to_email='mei.chen@example.com' ORDER BY id DESC LIMIT 1");
  assert.ok(mail && mail.body.includes('/parent'), 'welcome email has the portal link');
  assert.ok(get("SELECT 1 FROM webhook_deliveries WHERE webhook_id=? AND event='client.created'", hook));
  assert.ok(get("SELECT 1 FROM activity WHERE action='Added client' AND detail LIKE '%Lily Chen%'"));
  // Same parent email again is refused.
  const dup = await owner.post('/clients', { name: 'Max Chen', parent_name: 'Mei Chen', parent_email: 'mei.chen@example.com' });
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /Add sibling/);
  // The parent can now ask for a sign-in code.
  const code = await anon.post('/auth/parent/code', { email: 'mei.chen@example.com' });
  assert.ok(code.data.test_code);
});

test('new adult client pays for themselves', async () => {
  const r = await desk.post('/clients', { with_parent: false, name: 'Sam Rivera', email: 'sam.rivera@example.com', phone: '801-555-0199' });
  assert.equal(r.status, 201);
  const a = get('SELECT * FROM athletes WHERE id=?', r.data.id);
  assert.equal(a.email, 'sam.rivera@example.com');
  const p = get('SELECT * FROM parents WHERE family_id=?', a.family_id);
  assert.equal(p.is_self, 1);
  assert.equal(p.name, 'Sam Rivera');
  const missing = await desk.post('/clients', { with_parent: false, name: 'No Email' });
  assert.equal(missing.status, 400);
});

test('add sibling and parent to a family', async () => {
  const ava = get("SELECT * FROM athletes WHERE first_name='Ava' AND last_name='Lopez'");
  const s = await desk.post(`/families/${ava.family_id}/athletes`, { name: 'Ben Lopez', birthday: '2015-02-01', sport: 'Baseball' });
  assert.equal(s.status, 201);
  assert.equal(get('SELECT family_id FROM athletes WHERE id=?', s.data.id).family_id, ava.family_id);
  const prof = await owner.get(`/athletes/${ava.id}`);
  assert.ok(prof.data.family.siblings.some((x) => x.first_name === 'Ben'));
  const p = await coach.post(`/families/${ava.family_id}/parents`, { name: 'Luis Lopez', email: 'luis.lopez@example.com' });
  assert.equal(p.status, 201);
  assert.ok(get("SELECT 1 FROM outbox WHERE to_email='luis.lopez@example.com'"));
});

test('membership: pause, resume, change plan, cancel (owner)', async () => {
  const id = athleteId('Emma', 'Jensen');
  const m = get("SELECT * FROM memberships WHERE athlete_id=? AND status='active'", id);
  assert.equal((await owner.post(`/memberships/${m.id}/pause`)).status, 200);
  assert.equal(get('SELECT status FROM memberships WHERE id=?', m.id).status, 'paused');
  assert.equal((await owner.post(`/memberships/${m.id}/resume`)).status, 200);
  assert.equal(get('SELECT status FROM memberships WHERE id=?', m.id).status, 'active');
  const elite = get("SELECT * FROM plans WHERE name LIKE 'Elite%'");
  const ch = await owner.post(`/memberships/${m.id}/change`, { plan_id: elite.id });
  assert.equal(ch.status, 200);
  const after = get('SELECT * FROM memberships WHERE id=?', m.id);
  assert.equal(after.plan_id, elite.id);
  assert.equal(after.price_cents, elite.price_cents);
  assert.equal((await owner.post(`/memberships/${m.id}/cancel`)).status, 200);
  assert.equal(get('SELECT status FROM memberships WHERE id=?', m.id).status, 'cancelled');
  // Start a new one, skipping the trial: charged today.
  const before = get("SELECT COUNT(*) n FROM invoices WHERE athlete_id=? AND kind='membership'", id).n;
  const st = await owner.post(`/athletes/${id}/membership`, { plan_id: elite.id, skip_trial: true });
  assert.equal(st.status, 201);
  assert.equal(st.data.ok, true);
  assert.equal(get("SELECT COUNT(*) n FROM invoices WHERE athlete_id=? AND kind='membership'", id).n, before + 1);
});

test('plan price change applies to every live member from their next charge', async () => {
  const plan = get("SELECT * FROM plans WHERE name='Unlimited group training'");
  const live = get("SELECT COUNT(*) n FROM memberships WHERE plan_id=? AND status IN ('trial','active','past_due','paused')", plan.id).n;
  const r = await owner.put(`/plans/${plan.id}`, { price: '199' });
  assert.equal(r.status, 200);
  assert.equal(r.data.members_repriced, live);
  assert.equal(get('SELECT price_cents FROM plans WHERE id=?', plan.id).price_cents, 19900);
  assert.equal(get("SELECT COUNT(*) n FROM memberships WHERE plan_id=? AND status IN ('trial','active','past_due','paused') AND price_cents<>19900", plan.id).n, 0);
  const created = await owner.post('/plans', { name: 'Summer pass', price: '99', trial_days: 0, group_per_month: 6 });
  assert.equal(created.status, 201);
  const retire = await owner.put(`/plans/${created.data.id}`, { active: false });
  assert.equal(retire.status, 200);
  assert.equal((await coach.get('/plans')).data.some((p) => p.name === 'Summer pass'), false);
});

test('retry a declined charge: works with a good card, stays failed with a declining card', async () => {
  const olivia = athleteId('Olivia', 'Park');
  const good = get("SELECT id FROM invoices WHERE athlete_id=? AND status='failed'", olivia);
  const r = await owner.post(`/invoices/${good.id}/retry`);
  assert.equal(r.status, 200);
  assert.equal(get('SELECT status FROM invoices WHERE id=?', good.id).status, 'paid');
  assert.equal(get("SELECT status FROM memberships WHERE athlete_id=? AND status<>'cancelled'", olivia).status, 'active');
  const kevin = athleteId('Kevin', 'Nguyen');
  const bad = get("SELECT id, attempts FROM invoices WHERE athlete_id=? AND status='failed'", kevin);
  const r2 = await owner.post(`/invoices/${bad.id}/retry`);
  assert.equal(r2.status, 400);
  const after = get('SELECT status, attempts FROM invoices WHERE id=?', bad.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.attempts, bad.attempts + 1);
  const list = await owner.get('/invoices?status=failed');
  assert.ok(list.data.every((i) => i.status === 'failed'));
});

test('new team contract started in the past invoices every month so far, emails them, and the job does not duplicate', async () => {
  const start = addMonths(today(), -2);
  const r = await owner.post('/teams', { school_id: 'new', school_name: 'Timpview High School', billing_name: 'Pat Alvarez', billing_email: 'ad@timpview.example.org',
    address: '3570 N 650 E, Provo, UT 84604', team_name: 'Girls Basketball', monthly_fee: '1,200', start_date: start, terms_days: 30, po_number: 'PO-77' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.invoices, 3);
  const invs = all("SELECT * FROM invoices WHERE contract_id=? ORDER BY period", r.data.id);
  assert.equal(invs.length, 3);
  assert.equal(invs[0].amount_cents, 120000);
  assert.equal(invs[0].due_date, addDays(invs[0].issued_at, 30));
  assert.ok(invs.every((i) => i.kind === 'school' && i.status === 'open' && i.view_token));
  assert.equal(get("SELECT COUNT(*) n FROM outbox WHERE to_email='ad@timpview.example.org'").n, 3);
  const schools = require('../server/services/money-schools');
  assert.deepEqual(schools.invoiceContract(r.data.id), []);
  schools.runSchoolInvoicing();
  assert.equal(all("SELECT id FROM invoices WHERE contract_id=?", r.data.id).length, 3, 'no duplicates');
  // Next month the job invoices the new period once.
  assert.equal(schools.invoiceContract(r.data.id, addMonths(start, 3)).length, 1);
  assert.equal(schools.invoiceContract(r.data.id, addMonths(start, 3)).length, 0);

  const future = await owner.post('/teams', { school_id: invs[0] && get('SELECT school_id FROM team_contracts WHERE id=?', r.data.id).school_id, team_name: 'Boys Soccer', monthly_fee: '500', start_date: addDays(today(), 5) });
  assert.equal(future.status, 201);
  assert.equal(future.data.invoices, 0);

  const d = await owner.get(`/teams/${r.data.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.data.invoices.length, 4);
  assert.ok(d.data.invoices.some((i) => i.emailed_at));
});

test('record payment by check, email again, void, and bill something extra', async () => {
  const c = get("SELECT * FROM team_contracts WHERE team_name='Summit Elite 16U'");
  const open = all("SELECT * FROM invoices WHERE contract_id=? AND status='open' ORDER BY id", c.id);
  assert.ok(open.length >= 2);
  const noCheck = await owner.post(`/invoices/${open[0].id}/record-payment`, { method: 'check' });
  assert.equal(noCheck.status, 400);
  const paid = await owner.post(`/invoices/${open[0].id}/record-payment`, { method: 'check', check_number: '5512', paid_on: today() });
  assert.equal(paid.status, 200);
  const row = get('SELECT * FROM invoices WHERE id=?', open[0].id);
  assert.equal(row.status, 'paid');
  assert.equal(row.check_number, '5512');
  const before = get('SELECT COUNT(*) n FROM outbox').n;
  assert.equal((await owner.post(`/invoices/${open[1].id}/email`)).status, 200);
  assert.equal(get('SELECT COUNT(*) n FROM outbox').n, before + 1);
  assert.equal((await owner.post(`/invoices/${open[1].id}/void`)).status, 200);
  assert.equal(get('SELECT status FROM invoices WHERE id=?', open[1].id).status, 'void');
  assert.equal((await owner.post(`/invoices/${open[0].id}/void`)).status, 400, 'paid invoices cannot be voided');
  const extra = await owner.post(`/teams/${c.id}/invoices`, { description: 'Testing day, Oct 3', amount: '350' });
  assert.equal(extra.status, 201);
  const x = get('SELECT * FROM invoices WHERE id=?', extra.data.id);
  assert.equal(x.amount_cents, 35000);
  assert.equal(x.period, null);
  assert.equal(x.due_date, addDays(x.issued_at, c.terms_days));
});

test('contract terms: fee change applies to the next invoice only', async () => {
  const c = get("SELECT * FROM team_contracts WHERE team_name='Riverside Varsity Football'");
  const existing = get("SELECT amount_cents FROM invoices WHERE contract_id=? AND period=?", c.id, addMonths(c.start_date, 3)).amount_cents;
  assert.equal((await owner.put(`/teams/${c.id}`, { monthly_fee: '2600', po_number: 'PO-99', terms_days: 15 })).status, 200);
  assert.equal(get("SELECT amount_cents FROM invoices WHERE contract_id=? AND period=?", c.id, addMonths(c.start_date, 3)).amount_cents, existing);
  const schools = require('../server/services/money-schools');
  const [id] = schools.invoiceContract(c.id, addMonths(c.start_date, 4));
  assert.equal(get('SELECT amount_cents FROM invoices WHERE id=?', id).amount_cents, 260000);
});

test('roster paste creates athletes with Athlete IDs; team sessions go on the schedule', async () => {
  const c = get("SELECT * FROM team_contracts WHERE team_name='Summit Elite 16U'");
  const r = await owner.post(`/teams/${c.id}/roster`, { text: 'Jalen Brooks, QB, 2027\nMarcus Hill, WR, 2028\n\nMarcus Hill\n' });
  assert.equal(r.status, 201);
  assert.equal(r.data.added, 2);
  assert.equal(r.data.skipped, 1);
  const a = get("SELECT * FROM athletes WHERE first_name='Marcus' AND last_name='Hill'");
  assert.equal(a.team_id, c.id);
  assert.equal(a.position, 'WR');
  assert.match(a.code, /^MARHIL\d{4}$/);
  assert.equal((await owner.post(`/teams/${c.id}/roster`, { text: 'Madonna' })).status, 400);
  const s = await owner.post(`/teams/${c.id}/sessions`, { weekdays: ['1', '3'], start_time: '16:00', duration_min: 75, start_date: today() });
  assert.equal(s.status, 201);
  const cls = get('SELECT * FROM classes WHERE id=?', s.data.id);
  assert.equal(cls.type, 'team');
  assert.equal(cls.team_id, c.id);
  assert.ok(get('SELECT COUNT(*) n FROM events WHERE class_id=?', cls.id).n >= 8);
  const d = await owner.get(`/teams/${c.id}`);
  assert.ok(d.data.sessions.some((x) => x.id === cls.id));
  const riverside = await owner.get('/teams/1');
  assert.ok(riverside.data.roster.some((p) => p.attendance_rate != null), 'seeded check-ins give attendance rates');
});

test('overdue reminders go out weekly, not more often', async () => {
  const schools = require('../server/services/money-schools');
  const inv = get("SELECT * FROM invoices WHERE kind='school' AND status='open' ORDER BY id LIMIT 1");
  run('UPDATE invoices SET due_date=?, last_reminder=? WHERE id=?', addDays(today(), -20), addDays(today(), -8), inv.id);
  const sent = schools.sendOverdueReminders();
  assert.ok(sent >= 1);
  assert.equal(get('SELECT last_reminder FROM invoices WHERE id=?', inv.id).last_reminder, today());
  assert.equal(schools.sendOverdueReminders(), 0);
});

test('public invoice: readable without signing in, pay online marks it paid once', async () => {
  const inv = get("SELECT * FROM invoices WHERE kind='school' AND status='open' ORDER BY id DESC LIMIT 1");
  const r = await anon.get(`/public/invoices/${inv.view_token}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.number, inv.number);
  assert.ok(r.data.bill_to.name);
  assert.ok(r.data.from.name);
  assert.equal(r.data.can_pay_online, true);
  assert.equal('id' in r.data || 'contract_id' in r.data, false, 'no internal ids');
  assert.equal((await anon.get('/public/invoices/not-a-real-token')).status, 404);
  assert.equal((await anon.post(`/public/invoices/${inv.view_token}/pay`, { method: 'bitcoin' })).status, 400);
  const pay = await anon.post(`/public/invoices/${inv.view_token}/pay`, { method: 'ach' });
  assert.equal(pay.status, 200);
  const row = get('SELECT * FROM invoices WHERE id=?', inv.id);
  assert.equal(row.status, 'paid');
  assert.equal(row.pay_method, 'ach');
  assert.equal((await anon.post(`/public/invoices/${inv.view_token}/pay`, { method: 'card' })).status, 400);
  assert.ok(get("SELECT 1 FROM activity WHERE action='Invoice paid online' AND detail LIKE ?", `${inv.number}%`));
});

test('program assignment and workout link (coach yes, front desk no)', async () => {
  const id = athleteId('Isabela', 'Silva');
  const prog = get("SELECT id FROM programs WHERE name='High School Off-Season'");
  assert.equal((await desk.put(`/athletes/${id}/program`, { program_id: prog.id })).status, 403);
  assert.equal((await coach.put(`/athletes/${id}/program`, { program_id: prog.id })).status, 200);
  assert.equal(get('SELECT program_id FROM athletes WHERE id=?', id).program_id, prog.id);
  const old = get('SELECT workout_token FROM athletes WHERE id=?', id).workout_token;
  const r = await coach.post(`/athletes/${id}/workout-link`);
  assert.equal(r.status, 200);
  assert.notEqual(get('SELECT workout_token FROM athletes WHERE id=?', id).workout_token, old);
});

test('walk-in check-in to one of today\'s sessions', async () => {
  const booking = require('../server/services/booking');
  const t = booking.todayLocal();
  const eid = Number(run("INSERT INTO events (type, name, starts_at, duration_min, capacity, price_cents) VALUES ('class','Walk-in test', ?, 60, 10, 3000)", `${t}T23:00`).lastInsertRowid);
  const id = athleteId('Isabela', 'Silva'); // no membership, 3 group credits in the demo
  const r = await desk.post(`/athletes/${id}/walk-in`, { event_id: eid });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const b = get('SELECT * FROM bookings WHERE event_id=? AND athlete_id=?', eid, id);
  assert.ok(b.checked_in_at);
  assert.equal(b.coverage, 'credit');
  assert.equal((await desk.post(`/athletes/${id}/walk-in`, { event_id: eid })).status, 400, 'already checked in');
});

test('archive needs the membership cancelled first', async () => {
  const withPlan = athleteId('Nate', 'Jensen');
  assert.equal((await coach.post(`/athletes/${withPlan}/archive`)).status, 400);
  const team = athleteId('Tyler', 'Jacobs');
  assert.equal((await coach.post(`/athletes/${team}/archive`)).status, 200);
  assert.equal((await owner.get('/clients?q=Tyler')).data.clients.length, 0);
  assert.equal((await desk.post(`/athletes/${team}/archive`, { restore: true })).status, 403);
  assert.equal((await owner.post(`/athletes/${team}/archive`, { restore: true })).status, 200);
});

test('billing clock (test mode) converts trials and renews as of a later date', async () => {
  const trial = get("SELECT * FROM memberships WHERE status='trial' ORDER BY id LIMIT 1");
  const r = await owner.post('/billing/run', { as_of: addDays(today(), 40) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.charged >= 1);
  assert.notEqual(get('SELECT status FROM memberships WHERE id=?', trial.id).status, 'trial');
  assert.equal((await owner.post('/billing/run', { as_of: addDays(today(), -3) })).status, 400);
});

test('activity feed seen by coaches carries no dollar amounts from money actions', async () => {
  const r = await coach.get('/activity?limit=500');
  assert.equal(r.status, 200);
  const leaks = r.data.filter((a) => /\$\d/.test(`${a.action} ${a.detail || ''}`));
  assert.deepEqual(leaks, []);
});
