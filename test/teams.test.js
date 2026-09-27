// Teams: school and club contracts, roster tools, multi-invoice payments, statements and reminders.
// Run with `node --test test/`.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-teams-'));
process.env.DP_DB = path.join(dir, 'teams-test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const seed = require('../server/seed');
const { get, all, run, insert } = require('../server/db');
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
const as = (who) => ({ get: (u) => call(who, 'GET', u), post: (u, b = {}) => call(who, 'POST', u, b), put: (u, b = {}) => call(who, 'PUT', u, b) });
const owner = as('owner'), coach = as('coach'), desk = as('desk'), anon = as(null);

async function login(who, email, password) {
  const res = await fetch(base + '/api/auth/staff/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, `${who} signs in`);
  jars[who] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const riverside = () => get("SELECT * FROM team_contracts WHERE team_name='Riverside Varsity Football'");
const summit = () => get("SELECT * FROM team_contracts WHERE team_name='Summit Elite 16U'");
const outboxCount = () => get('SELECT COUNT(*) n FROM outbox').n;

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

test('every Teams endpoint is owner only: coaches and front desk get 403, signed-out gets 401', async () => {
  const c = riverside();
  const inv = get("SELECT id FROM invoices WHERE contract_id=? AND status='open' LIMIT 1", c.id);
  const a = get('SELECT id FROM athletes WHERE team_id IS NULL AND archived=0 LIMIT 1');
  const calls = [
    ['GET', '/teams'], ['GET', `/teams/${c.id}`], ['GET', '/schools'], ['POST', '/teams'], ['PUT', `/teams/${c.id}`],
    ['POST', '/teams/remind-overdue'], ['POST', `/teams/${c.id}/statement`], ['POST', `/teams/${c.id}/record-payment`, { invoice_ids: [inv.id], method: 'cash' }],
    ['POST', `/teams/${c.id}/roster`, { text: 'Leak Test', preview: true }], ['POST', `/teams/${c.id}/roster/add`, { athlete_id: a.id }],
    ['GET', `/teams/${c.id}/athlete-search?q=li`], ['POST', `/teams/${c.id}/sessions`], ['POST', `/teams/${c.id}/invoices`], ['POST', `/teams/${c.id}/end`],
  ];
  for (const [m, u, b] of calls) {
    assert.equal((await call('coach', m, u, b)).status, 403, `coach ${m} ${u}`);
    assert.equal((await call('desk', m, u, b)).status, 403, `desk ${m} ${u}`);
    assert.equal((await call(null, m, u, b)).status, 401, `anon ${m} ${u}`);
  }
  assert.equal(get('SELECT status FROM invoices WHERE id=?', inv.id).status, 'open', 'nothing changed');
  assert.equal(get('SELECT team_id FROM athletes WHERE id=?', a.id).team_id, null);
});

test('new contract: errors name the field, phone and type are kept, and a duplicate active team is refused', async () => {
  let r = await owner.post('/teams', { school_id: 'new', team_name: 'JV Baseball', monthly_fee: '800' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'school_name');
  r = await owner.post('/teams', { school_id: 'new', school_name: 'Provo High', team_name: '', monthly_fee: '800' });
  assert.equal(r.data.field, 'team_name');
  r = await owner.post('/teams', { school_id: 'new', school_name: 'Provo High', team_name: 'JV Baseball', monthly_fee: '' });
  assert.equal(r.data.field, 'monthly_fee');
  r = await owner.post('/teams', { school_id: 'new', school_name: 'Provo High', team_name: 'JV Baseball', monthly_fee: '800', billing_phone: 'call me' });
  assert.equal(r.data.field, 'billing_phone');
  r = await owner.post('/teams', { school_id: 'new', school_name: 'Provo High', team_name: 'JV Baseball', monthly_fee: '800', end_date: addDays(today(), -400) });
  assert.equal(r.data.field, 'end_date');

  r = await owner.post('/teams', { school_id: 'new', school_name: 'Provo Storm', kind: 'club', billing_name: 'Kim Park', billing_email: 'kim@storm.example.org',
    billing_phone: '(801) 555-0144', team_name: '14U Baseball', monthly_fee: '600', start_date: addDays(today(), 3), notes: 'Coach Park runs practice' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const c = get('SELECT t.*, s.kind, s.contact_phone FROM team_contracts t JOIN schools s ON s.id=t.school_id WHERE t.id=?', r.data.id);
  assert.equal(c.kind, 'club');
  assert.equal(c.billing_phone, '(801) 555-0144');
  assert.equal(c.contact_phone, '(801) 555-0144');
  assert.equal(c.notes, 'Coach Park runs practice');
  const dup = await owner.post('/teams', { school_id: c.school_id, team_name: '14u baseball', monthly_fee: '600' });
  assert.equal(dup.status, 400);
  assert.equal(dup.data.field, 'team_name');
  assert.match(dup.data.error, /already has an active/);
});

test('new contract that started months ago: invoice all, only the current month, or none of the past months', async () => {
  const start = addMonths(today(), -2);
  const make = (past, name) => owner.post('/teams', { school_id: 'new', school_name: `Past ${name}`, billing_email: `${name}@x.example.org`, team_name: name, monthly_fee: '500', start_date: start, past });
  const all3 = await make('all', 'alpha');
  assert.equal(all3.data.invoices, 3);
  const cur = await make('current', 'bravo');
  assert.equal(cur.data.invoices, 1);
  assert.equal(get('SELECT period FROM invoices WHERE contract_id=?', cur.data.id).period, addMonths(start, 2));
  const none = await make('none', 'charlie');
  assert.equal(none.data.invoices, 0);
  const schools = require('../server/services/money-schools');
  assert.equal(schools.invoiceContract(none.data.id).length, 0, 'the job does not back-bill them later');
  assert.equal(schools.invoiceContract(none.data.id, addMonths(start, 3)).length, 1, 'next month bills as usual');
  const d = await owner.get(`/teams/${cur.data.id}`);
  assert.equal(d.data.contract.next_invoice, addMonths(start, 3));
});

test('roster paste: grad years and jersey numbers, a preview that saves nothing, and linking an existing client', async () => {
  const c = summit();
  // An existing client (no team) with the same name as a pasted line.
  const existing = insert('athletes', { code: 'TESMAT2026', first_name: 'Tess', last_name: 'Matchley', school: 'Orem High', workout_token: 'tok-tess-match' });
  const text = '#12 Rowan Pike, SS, 2028\n2. Tess Matchley, C, 2029\nCy Young, P, Class of 2030';
  const before = get('SELECT COUNT(*) n FROM athletes').n;
  const p = await owner.post(`/teams/${c.id}/roster`, { text, preview: true });
  assert.equal(p.status, 200);
  assert.equal(get('SELECT COUNT(*) n FROM athletes').n, before, 'preview saves nothing');
  assert.deepEqual(p.data.rows.map((r) => r.status), ['new', 'match', 'new']);
  assert.equal(p.data.rows[0].first, 'Rowan');
  assert.equal(p.data.rows[0].grad_year, 2028);
  assert.equal(p.data.rows[2].grad_year, 2030);
  assert.equal(p.data.rows[1].matches[0].id, existing);

  const bad = await owner.post(`/teams/${c.id}/roster`, { text: 'Ok Name, P, 2029\nCher\nBad Year, P, 1850', preview: true });
  assert.deepEqual(bad.data.rows.map((r) => r.status), ['new', 'error', 'error']);
  assert.equal(bad.data.counts.error, 2);
  assert.equal((await owner.post(`/teams/${c.id}/roster`, { text: 'Bad Year, P, 1850' })).status, 400, 'saving a bad line is refused');

  // Linking to someone who is not a match for that line is refused.
  const other = get('SELECT id FROM athletes WHERE team_id IS NULL AND id<>? LIMIT 1', existing).id;
  assert.equal((await owner.post(`/teams/${c.id}/roster`, { text, links: { 1: other } })).status, 400);

  const r = await owner.post(`/teams/${c.id}/roster`, { text, links: { 1: existing } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.added, 2);
  assert.equal(r.data.linked, 1);
  const tess = get('SELECT * FROM athletes WHERE id=?', existing);
  assert.equal(tess.team_id, c.id);
  assert.equal(tess.grad_year, 2029);
  assert.equal(tess.position, 'C');
  assert.equal(tess.school, 'Orem High', 'their own school is kept');
  const rowan = get("SELECT * FROM athletes WHERE first_name='Rowan' AND last_name='Pike'");
  assert.equal(rowan.grad_year, 2028);
  assert.equal(rowan.team_id, c.id);
  const d = await owner.get(`/teams/${c.id}`);
  assert.equal(d.data.roster.find((a) => a.id === rowan.id).grad_year, 2028);
  // Pasting again skips everyone.
  const again = await owner.post(`/teams/${c.id}/roster`, { text });
  assert.equal(again.data.skipped, 3);
  assert.equal(again.data.added, 0);
});

test('add an existing client, move from another team, and undo a removal', async () => {
  const c = summit(), rv = riverside();
  const free = get('SELECT * FROM athletes WHERE team_id IS NULL AND archived=0 AND family_id IS NOT NULL LIMIT 1');
  const s = await owner.get(`/teams/${c.id}/athlete-search?q=${encodeURIComponent(free.first_name)}`);
  assert.equal(s.status, 200);
  assert.ok(s.data.some((a) => a.id === free.id));
  assert.ok(s.data.every((a) => a.team_name !== c.team_name), 'the current roster is left out');
  assert.equal((await owner.post(`/teams/${c.id}/roster/add`, { athlete_id: free.id })).status, 200);
  assert.equal(get('SELECT team_id FROM athletes WHERE id=?', free.id).team_id, c.id);
  assert.equal((await owner.post(`/teams/${c.id}/roster/add`, { athlete_id: free.id })).status, 400, 'already on the roster');

  const player = get('SELECT * FROM athletes WHERE team_id=? LIMIT 1', rv.id);
  const mv = await owner.post(`/teams/${c.id}/roster/add`, { athlete_id: player.id });
  assert.equal(mv.data.moved_from, rv.team_name);
  // Undo = remove, then add back.
  assert.equal((await owner.post(`/teams/${c.id}/roster/${player.id}/remove`)).status, 200);
  assert.equal((await owner.post(`/teams/${rv.id}/roster/add`, { athlete_id: player.id })).status, 200);
  assert.equal(get('SELECT team_id FROM athletes WHERE id=?', player.id).team_id, rv.id);
  assert.equal((await owner.post(`/teams/${c.id}/roster/add`, { athlete_id: 999999 })).status, 404);
});

test('one payment for several invoices: all marked paid together, or none when one is wrong', async () => {
  const c = riverside();
  const schools = require('../server/services/money-schools');
  schools.invoiceContract(c.id, addMonths(today(), 2));
  const open = all("SELECT * FROM invoices WHERE contract_id=? AND status='open' ORDER BY id", c.id);
  assert.ok(open.length >= 2, 'several open invoices');
  const other = get("SELECT id FROM invoices WHERE contract_id<>? AND kind='school' LIMIT 1", c.id);
  assert.equal((await owner.post(`/teams/${c.id}/record-payment`, { invoice_ids: [open[0].id, other.id], method: 'cash' })).status, 400);
  assert.equal((await owner.post(`/teams/${c.id}/record-payment`, { invoice_ids: [open[0].id, open[1].id], method: 'check' })).status, 400, 'check number required');
  assert.equal((await owner.post(`/teams/${c.id}/record-payment`, { invoice_ids: [], method: 'cash' })).status, 400);
  assert.equal(get('SELECT status FROM invoices WHERE id=?', open[0].id).status, 'open', 'nothing paid on a refused request');
  const r = await owner.post(`/teams/${c.id}/record-payment`, { invoice_ids: open.map((i) => i.id), method: 'check', check_number: '7781', paid_on: today() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.count, open.length);
  assert.equal(r.data.total_cents, open.reduce((s, i) => s + i.amount_cents, 0));
  for (const i of open) {
    const row = get('SELECT * FROM invoices WHERE id=?', i.id);
    assert.equal(row.status, 'paid');
    assert.equal(row.check_number, '7781');
  }
  assert.equal((await owner.post(`/teams/${c.id}/record-payment`, { invoice_ids: [open[0].id], method: 'cash' })).status, 400, 'already paid');
  assert.ok(get("SELECT 1 FROM activity WHERE action='Recorded invoice payment' AND detail LIKE ?", `%#7781%`));
});

test('record payment refuses a garbled or future date instead of crashing', async () => {
  const c = summit();
  const schools = require('../server/services/money-schools');
  const id = schools.createSchoolInvoice(c, { description: 'Date check', amount_cents: 1000, email: false });
  assert.equal((await owner.post(`/invoices/${id}/record-payment`, { method: 'cash', paid_on: 'soon' })).status, 400);
  assert.equal((await owner.post(`/invoices/${id}/record-payment`, { method: 'cash', paid_on: addDays(today(), 10) })).status, 400);
  assert.equal(get('SELECT status FROM invoices WHERE id=?', id).status, 'open');
  assert.equal((await owner.post(`/invoices/${id}/record-payment`, { method: 'cash', paid_on: addDays(today(), -2) })).status, 200);
});

test('statement: one email listing every open invoice with its link and the total', async () => {
  const c = summit();
  const open = all("SELECT * FROM invoices WHERE contract_id=? AND status='open'", c.id);
  assert.ok(open.length >= 1);
  const n = outboxCount();
  const r = await owner.post(`/teams/${c.id}/statement`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.count, open.length);
  assert.equal(outboxCount(), n + 1);
  const mail = get('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  assert.equal(mail.to_email, c.billing_email);
  for (const i of open) { assert.ok(mail.body.includes(`/invoice/${i.view_token}`)); assert.ok(mail.body.includes(i.number)); }
  assert.match(mail.subject, /Statement/);
  // Nothing open: refused.
  const fresh = await owner.post('/teams', { school_id: 'new', school_name: 'Quiet Club', team_name: 'Quiet', monthly_fee: '100', start_date: addDays(today(), 10) });
  assert.equal((await owner.post(`/teams/${fresh.data.id}/statement`)).status, 400);
});

test('Email overdue reminders now: sends one per overdue invoice and resets the weekly timer', async () => {
  const c = summit();
  const schools = require('../server/services/money-schools');
  const id = schools.createSchoolInvoice(c, { description: 'Overdue test', amount_cents: 5000, issued: addDays(today(), -40), email: false });
  run('UPDATE invoices SET due_date=?, last_reminder=? WHERE id=?', addDays(today(), -10), addDays(today(), -2), id);
  const n = outboxCount();
  const r = await owner.post('/teams/remind-overdue');
  assert.equal(r.status, 200);
  assert.ok(r.data.sent >= 1);
  assert.ok(outboxCount() >= n + 1);
  assert.equal(get('SELECT last_reminder FROM invoices WHERE id=?', id).last_reminder, today());
  assert.equal(schools.sendOverdueReminders(), 0, 'the weekly job waits another week');
  // Nothing overdue: refused.
  run("UPDATE invoices SET status='void' WHERE kind='school' AND status='open' AND due_date < ?", today());
  assert.equal((await owner.post('/teams/remind-overdue')).status, 400);
});

test('contract edits: rename, phone, notes; team sessions follow the end date; ending then saving does not restart', async () => {
  const c = summit();
  const s = await owner.post(`/teams/${c.id}/sessions`, { weekdays: ['0', '1', '2', '3', '4', '5', '6'], start_time: '17:00', duration_min: 60, start_date: today() });
  assert.equal(s.status, 201);
  const future = () => get("SELECT COUNT(*) n FROM events WHERE class_id=? AND cancelled=0", s.data.id).n;
  const full = future();
  assert.ok(full >= 20);

  let r = await owner.put(`/teams/${c.id}`, { team_name: 'Summit Elite 17U', billing_phone: '801-555-0199', notes: 'Pays by check in the first week', kind: 'club' });
  assert.equal(r.status, 200);
  assert.equal(get('SELECT name FROM classes WHERE id=?', s.data.id).name, 'Summit Elite 17U team session');
  assert.equal(get('SELECT billing_phone FROM team_contracts WHERE id=?', c.id).billing_phone, '801-555-0199');
  assert.equal((await owner.put(`/teams/${c.id}`, { billing_phone: 'nope' })).data.field, 'billing_phone');
  assert.equal((await owner.put(`/teams/${c.id}`, { team_name: ' ' })).data.field, 'team_name');

  // Shorter contract: later sessions come off. Longer again: they come back.
  r = await owner.put(`/teams/${c.id}`, { end_date: addDays(today(), 7) });
  assert.equal(r.status, 200);
  assert.ok(future() <= 8, `sessions stop at the end date (${future()})`);
  assert.equal(get('SELECT end_date FROM classes WHERE id=?', s.data.id).end_date, addDays(today(), 7));
  r = await owner.put(`/teams/${c.id}`, { end_date: '' });
  assert.equal(future(), full, 'sessions come back when the end date is cleared');

  // End it, then press Save with the form unchanged: it stays ended.
  assert.equal((await owner.post(`/teams/${c.id}/end`)).status, 200);
  const ended = get('SELECT * FROM team_contracts WHERE id=?', c.id);
  assert.equal(ended.status, 'ended');
  r = await owner.put(`/teams/${c.id}`, { end_date: ended.end_date, po_number: 'PO-1' });
  assert.equal(r.data.restarted, false);
  assert.equal(get('SELECT status FROM team_contracts WHERE id=?', c.id).status, 'ended');
  assert.equal((await owner.post(`/teams/${c.id}/sessions`, { weekdays: ['1'], start_time: '16:00' })).status, 400, 'no sessions on an ended contract');
});

test('restarting an ended contract picks up on the next billing day without back-billing', async () => {
  const start = addMonths(today(), -5);
  const r = await owner.post('/teams', { school_id: 'new', school_name: 'Restart High', billing_email: 'ad@restart.example.org', team_name: 'Softball', monthly_fee: '400', start_date: addDays(start, 1), end_date: addMonths(today(), -3) });
  assert.equal(r.status, 201);
  const id = r.data.id;
  const schools = require('../server/services/money-schools');
  schools.runSchoolInvoicing();
  assert.equal(get('SELECT status FROM team_contracts WHERE id=?', id).status, 'ended');
  const before = all('SELECT id FROM invoices WHERE contract_id=?', id).length;
  const up = await owner.put(`/teams/${id}`, { end_date: '' });
  assert.equal(up.status, 200);
  assert.equal(up.data.restarted, true);
  assert.ok(up.data.bill_from >= today());
  assert.equal(get('SELECT status FROM team_contracts WHERE id=?', id).status, 'active');
  assert.equal(schools.invoiceContract(id).length, up.data.bill_from === today() ? 1 : 0, 'the ended months are not invoiced');
  assert.ok(all('SELECT id FROM invoices WHERE contract_id=?', id).length <= before + 1);
  assert.equal(schools.invoiceContract(id, up.data.bill_from).length, up.data.bill_from === today() ? 0 : 1);
});

test('team sessions: coach and time are checked; the contract page shows coaches, grad years and attendance', async () => {
  const c = riverside();
  assert.equal((await owner.post(`/teams/${c.id}/sessions`, { weekdays: ['2'], start_time: '25:00' })).data.field, 'start_time');
  assert.equal((await owner.post(`/teams/${c.id}/sessions`, { weekdays: ['2'], start_time: '16:00', coach_id: 99999 })).data.field, 'coach_id');
  const desk = get("SELECT id FROM staff WHERE role='frontdesk'").id;
  assert.equal((await owner.post(`/teams/${c.id}/sessions`, { weekdays: ['2'], start_time: '16:00', coach_id: desk })).status, 400, 'front desk cannot coach a session');
  const coachId = get("SELECT id FROM staff WHERE role='coach'").id;
  const s = await owner.post(`/teams/${c.id}/sessions`, { weekdays: ['6'], start_time: '09:00', coach_id: coachId });
  assert.equal(s.status, 201);
  const d = await owner.get(`/teams/${c.id}`);
  assert.ok(d.data.coaches.some((x) => x.id === coachId));
  assert.ok(d.data.sessions.find((x) => x.id === s.data.id).coach);
  assert.ok(d.data.team_rate > 0 && d.data.team_rate <= 1);
  assert.ok(d.data.recent_sessions.length >= 1);
  assert.ok(d.data.roster.some((a) => a.last_seen));
  assert.ok(d.data.roster.every((a) => 'grad_year' in a && 'reachable' in a));
  const list = await owner.get('/teams');
  assert.ok(list.data.contracts.find((x) => x.id === c.id).attendance_rate > 0);
  assert.equal(typeof list.data.metrics.collected_30_cents, 'number');
});
