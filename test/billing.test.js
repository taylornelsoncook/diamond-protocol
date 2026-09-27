// Billing tab: summary, invoice filters and details, refunds, card reminders, retry-all, write-offs, memberships list,
// plan validation and the CSV export. API tests against a fresh demo database. Run with `node --test test/`.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-billing-'));
process.env.DP_DB = path.join(dir, 'billing-test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const seed = require('../server/seed');
const { get, all, run, insert } = require('../server/db');
const { today, addDays } = require('../server/lib');

let server, base;
const jars = {};

async function call(who, method, url, body) {
  const headers = {};
  if (who && jars[who]) headers.cookie = jars[who];
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const as = (who) => ({ get: (u) => call(who, 'GET', u), post: (u, b = {}) => call(who, 'POST', u, b), put: (u, b = {}) => call(who, 'PUT', u, b) });
const owner = as('owner'), coach = as('coach');

async function login(who, email, password) {
  const res = await fetch(base + '/api/auth/staff/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, `${who} signs in`);
  jars[who] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const athleteId = (first, last) => get('SELECT id FROM athletes WHERE first_name=? AND last_name=?', first, last).id;
const failedOf = (first, last) => get("SELECT * FROM invoices WHERE athlete_id=? AND status='failed'", athleteId(first, last));
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

test('every new billing endpoint is owner only', async () => {
  const inv = failedOf('Kevin', 'Nguyen');
  const paid = get("SELECT id FROM invoices WHERE status='paid' AND amount_cents>0 LIMIT 1");
  const urls = [
    ['GET', '/billing/summary'], ['GET', `/invoices/${inv.id}`], ['GET', '/invoices/export.csv'], ['GET', '/invoices?paged=1'], ['GET', '/memberships'],
    ['POST', `/invoices/${paid.id}/refund`], ['POST', `/invoices/${inv.id}/remind`], ['POST', '/billing/remind-declined'], ['POST', '/billing/retry-declined'],
    ['POST', `/invoices/${inv.id}/void`], ['POST', `/invoices/${inv.id}/email`],
  ];
  const before = outboxCount();
  for (const who of ['coach', 'desk']) {
    for (const [method, url] of urls) {
      const r = await call(who, method, url, method === 'GET' ? undefined : {});
      assert.equal(r.status, 403, `${who} ${method} ${url}`);
    }
  }
  assert.equal((await call(null, 'GET', '/billing/summary')).status, 401);
  assert.equal(get('SELECT status FROM invoices WHERE id=?', inv.id).status, 'failed', 'nothing changed');
  assert.equal(get('SELECT COUNT(*) n FROM invoices WHERE refund_of=?', paid.id).n, 0);
  assert.equal(outboxCount(), before, 'no emails went out');
});

test('summary: recurring revenue, this month, failed, open invoices, renewals and view counts', async () => {
  const r = await owner.get('/billing/summary');
  assert.equal(r.status, 200);
  const s = r.data;
  const mem = get("SELECT COALESCE(SUM(COALESCE(m.price_cents,p.price_cents)),0) c FROM memberships m JOIN plans p ON p.id=m.plan_id WHERE m.status IN ('active','past_due')").c;
  const teams = get("SELECT COALESCE(SUM(monthly_cents),0) c FROM team_contracts WHERE status='active'").c;
  assert.equal(s.mrr.total_cents, mem + teams);
  assert.equal(s.failed.count, 2);
  assert.equal(s.failed.cents, all("SELECT amount_cents FROM invoices WHERE status='failed'").reduce((n, i) => n + i.amount_cents, 0));
  assert.equal(s.month.refunded_cents, 5000, 'the demo partial refund counts this month');
  assert.equal(s.month.collected_cents, s.month.taken_cents - 5000);
  assert.equal(s.unpaid.overdue_count, 1);
  assert.equal(s.counts.refund, 1);
  assert.equal(s.counts.unpaid, s.counts.failed + s.unpaid.count);
  assert.ok(s.upcoming.count >= 1 && s.upcoming.cents > 0);
  assert.equal(s.members.past_due, 2);
});

test('invoice list: refunds, paid, date range, paged totals and bad filters', async () => {
  const refunds = await owner.get('/invoices?status=refund');
  assert.equal(refunds.status, 200);
  assert.equal(refunds.data.length, 1);
  assert.ok(refunds.data[0].amount_cents < 0 && refunds.data[0].refund_of_number, 'a refund names the invoice it refunds');
  const orig = get('SELECT * FROM invoices WHERE id=?', refunds.data[0].refund_of);
  const paid = await owner.get('/invoices?status=paid&limit=1000');
  assert.ok(paid.data.every((i) => i.status === 'paid' && i.amount_cents >= 0), 'refunds are not in Paid');
  assert.equal(paid.data.find((i) => i.id === orig.id).refunded_cents, 5000);
  const refunded = await owner.get('/invoices?status=refunded');
  assert.deepEqual(refunded.data.map((i) => i.id), [orig.id]);

  const T = today();
  const range = await owner.get(`/invoices?from=${addDays(T, -2)}&to=${T}`);
  assert.ok(range.data.length && range.data.every((i) => i.issued_at >= addDays(T, -2) && i.issued_at <= T));

  const pg = await owner.get('/invoices?paged=1&limit=5');
  assert.equal(pg.data.invoices.length, 5);
  assert.equal(pg.data.total, get('SELECT COUNT(*) n FROM invoices').n);
  assert.equal(pg.data.total_cents, get('SELECT SUM(amount_cents) c FROM invoices').c);
  const failed = await owner.get('/invoices?status=failed');
  assert.ok(failed.data.every((i) => i.status === 'failed' && 'card_last4' in i && 'retries_done' in i));

  assert.equal((await owner.get('/invoices?status=bogus')).status, 400);
  assert.equal((await owner.get('/invoices?kind=bogus')).status, 400);
  assert.equal((await owner.get('/invoices?from=yesterday')).status, 400);
  const school = await owner.get('/invoices?q=Summit');
  assert.ok(school.data.length && school.data.every((i) => i.school === 'Summit Elite Baseball Club'));
});

test('invoice details say what can be done in each state', async () => {
  const kevin = failedOf('Kevin', 'Nguyen');
  let d = (await owner.get(`/invoices/${kevin.id}`)).data;
  assert.equal(d.card_last4, '0002');
  assert.deepEqual(d.can, { retry: true, record_payment: true, refund: false, void: true, email: true, remind: true });
  assert.equal(d.membership.status, 'past_due');
  assert.ok(!('charge_id' in d));

  const paid = get("SELECT id, amount_cents FROM invoices WHERE kind='membership' AND status='paid' AND refund_of IS NULL AND amount_cents>0 AND NOT EXISTS (SELECT 1 FROM invoices r WHERE r.refund_of=invoices.id) LIMIT 1");
  d = (await owner.get(`/invoices/${paid.id}`)).data;
  assert.equal(d.can.refund, true);
  assert.equal(d.refundable_cents, paid.amount_cents);
  assert.equal(d.can.void, false);

  const rf = get("SELECT id FROM invoices WHERE amount_cents<0 LIMIT 1");
  d = (await owner.get(`/invoices/${rf.id}`)).data;
  assert.equal(d.can.refund, false);
  assert.equal(d.can.email, false);
  assert.equal(d.refundable_cents, 0);
  assert.equal((await owner.get('/invoices/999999')).status, 404);
});

test('refund a membership invoice in parts; limits and wrong states are refused; the family gets a receipt', async () => {
  const inv = get(`SELECT i.* FROM invoices i JOIN athletes a ON a.id=i.athlete_id WHERE a.first_name='Jaylen' AND i.kind='membership' AND i.status='paid' ORDER BY i.id DESC LIMIT 1`);
  const to = require('../server/services/billing').billingEmail(inv.family_id);
  let r = await owner.post(`/invoices/${inv.id}/refund`, { amount: '50', reason: 'Hurt his wrist, missed two weeks' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refunded_cents, 5000);
  assert.equal(r.data.left_cents, inv.amount_cents - 5000);
  assert.equal(r.data.emailed, to);
  const rf = get('SELECT * FROM invoices WHERE refund_of=?', inv.id);
  assert.equal(rf.amount_cents, -5000);
  assert.match(rf.number, /^RF-/);
  assert.ok(get("SELECT 1 FROM outbox WHERE to_email=? AND subject LIKE 'Refund of $50%' AND body LIKE '%Hurt his wrist%'", to));
  assert.ok(get("SELECT 1 FROM activity WHERE action='Refunded invoice' AND detail LIKE '%Jaylen Brooks%$50%'"));

  r = await owner.post(`/invoices/${inv.id}/refund`, { amount_cents: inv.amount_cents });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /up to \$279/);
  assert.equal((await owner.post(`/invoices/${inv.id}/refund`, { amount: '-5' })).status, 400);
  assert.equal((await owner.post(`/invoices/${inv.id}/refund`, { amount: 'abc' })).status, 400);

  const before = outboxCount();
  r = await owner.post(`/invoices/${inv.id}/refund`, { email: false }); // blank amount = the rest
  assert.equal(r.status, 200);
  assert.equal(r.data.refunded_cents, inv.amount_cents - 5000);
  assert.equal(outboxCount(), before, 'no receipt when the owner unticks it');
  r = await owner.post(`/invoices/${inv.id}/refund`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /refunded in full/);
  assert.equal((await owner.post(`/invoices/${rf.id}/refund`, {})).status, 400, 'a refund cannot be refunded');
  const failed = failedOf('Kevin', 'Nguyen');
  r = await owner.post(`/invoices/${failed.id}/refund`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Void it instead/);

  const coachFeed = await coach.get('/activity?limit=500');
  assert.ok(!coachFeed.data.some((a) => /Refunded invoice/.test(a.action)), 'coaches never see refunds');
});

test('refunding a counter sale from Billing keeps Point of sale in step', async () => {
  const sale = get("SELECT * FROM sales WHERE status='paid' AND method<>'cash' AND charge_id IS NOT NULL AND athlete_id IS NOT NULL ORDER BY id LIMIT 1");
  const inv = get("SELECT * FROM invoices WHERE charge_id=? AND amount_cents>0", sale.charge_id);
  let r = await owner.post(`/invoices/${inv.id}/refund`, { amount_cents: 1000 });
  assert.equal(r.status, 200);
  let s = get('SELECT * FROM sales WHERE id=?', sale.id);
  assert.equal(s.refunded_cents, 1000);
  assert.equal(s.status, 'partial_refund');
  assert.equal(get('SELECT COUNT(*) n FROM invoices WHERE refund_of=?', inv.id).n, 1, 'one refund row, linked');
  // Point of sale sees what is left, and so does Billing after a refund there.
  r = await owner.post(`/sales/${sale.id}/refund`, { amount_cents: 500 });
  assert.equal(r.status, 200);
  const d = (await owner.get(`/invoices/${inv.id}`)).data;
  assert.equal(d.refunded_cents, 1500);
  assert.equal(d.refundable_cents, inv.amount_cents - 1500);
  assert.ok(d.sale && d.sale.id === sale.id);
  r = await owner.post(`/invoices/${inv.id}/refund`, {});
  assert.equal(r.status, 200);
  s = get('SELECT * FROM sales WHERE id=?', sale.id);
  assert.equal(s.status, 'refunded');
  assert.equal(s.refunded_cents, s.total_cents);
});

test('card reminders: one email per family, not twice a day, and bulk skips families already reminded', async () => {
  const kevin = failedOf('Kevin', 'Nguyen');
  run('UPDATE invoices SET last_reminder=NULL WHERE status=\'failed\'');
  const to = require('../server/services/billing').billingEmail(kevin.family_id);
  let r = await owner.post(`/invoices/${kevin.id}/remind`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.to, to);
  const mail = get('SELECT * FROM outbox WHERE to_email=? ORDER BY id DESC LIMIT 1', to);
  assert.match(mail.subject, /Please update your card/);
  assert.match(mail.body, /Visa ending 0002|ending 0002/);
  assert.match(mail.body, /\/parent/);
  assert.equal(get('SELECT last_reminder FROM invoices WHERE id=?', kevin.id).last_reminder, today());
  r = await owner.post(`/invoices/${kevin.id}/remind`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /already went out today/);

  const before = outboxCount();
  r = await owner.post('/billing/remind-declined');
  assert.equal(r.status, 200);
  assert.equal(r.data.sent, 1, 'Olivia\'s family');
  assert.equal(r.data.skipped, 1, 'Kevin\'s family was reminded today');
  assert.equal(outboxCount(), before + 1);
  const paid = get("SELECT id FROM invoices WHERE status='paid' LIMIT 1");
  assert.equal((await owner.post(`/invoices/${paid.id}/remind`)).status, 400);
  const coachFeed = await coach.get('/activity?limit=500');
  assert.ok(!coachFeed.data.some((a) => /reminder/i.test(a.action)), 'reminders stay out of the coach feed');
});

test('retry all declined: good cards go through and memberships come back; no card is refused with a clear message', async () => {
  const oliviaInv = failedOf('Olivia', 'Park');
  const kevinInv = failedOf('Kevin', 'Nguyen');
  let r = await owner.post('/billing/retry-declined');
  assert.equal(r.status, 200);
  assert.equal(r.data.tried, 2);
  assert.equal(r.data.paid, 1);
  assert.equal(r.data.paid_cents, oliviaInv.amount_cents);
  assert.equal(get('SELECT status FROM invoices WHERE id=?', oliviaInv.id).status, 'paid');
  assert.equal(get('SELECT status FROM memberships WHERE id=?', oliviaInv.membership_id).status, 'active');
  assert.equal(get('SELECT attempts FROM invoices WHERE id=?', kevinInv.id).attempts, kevinInv.attempts + 1);

  // A family with no card: single retry and retry-all both say what to do instead.
  const fam = get('SELECT * FROM families WHERE id=?', kevinInv.family_id);
  run('UPDATE families SET card_last4=NULL, card_brand=NULL WHERE id=?', fam.id);
  r = await owner.post(`/invoices/${kevinInv.id}/retry`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no card on file/);
  r = await owner.post('/billing/retry-declined');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /card reminders/);
  run('UPDATE families SET card_last4=?, card_brand=? WHERE id=?', fam.card_last4, fam.card_brand, fam.id);
});

test('writing off a declined charge ends the retries and makes the membership active again', async () => {
  const kevinInv = failedOf('Kevin', 'Nguyen');
  const r = await owner.post(`/invoices/${kevinInv.id}/void`);
  assert.equal(r.status, 200);
  assert.equal(r.data.membership_reactivated, true);
  const after = get('SELECT status, next_retry FROM invoices WHERE id=?', kevinInv.id);
  assert.equal(after.status, 'void');
  assert.equal(after.next_retry, null);
  assert.equal(get('SELECT status FROM memberships WHERE id=?', kevinInv.membership_id).status, 'active');
  assert.ok(get("SELECT 1 FROM activity WHERE action LIKE 'Voided invoice: wrote off%'"));
  const paid = get("SELECT id FROM invoices WHERE status='paid' AND amount_cents>0 LIMIT 1");
  const bad = await owner.post(`/invoices/${paid.id}/void`);
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Refund it instead/);
  assert.equal((await owner.post(`/invoices/${kevinInv.id}/email`)).status, 400, 'a void invoice is not emailed');
});

test('memberships list: views with counts, search, plan filter, renewals', async () => {
  let r = await owner.get('/memberships');
  assert.equal(r.status, 200);
  const live = get("SELECT COUNT(*) n FROM memberships WHERE status IN ('trial','active','past_due','paused')").n;
  assert.equal(r.data.memberships.length, live);
  assert.equal(r.data.counts.live, live);
  assert.equal(r.data.counts.paused, 1);
  assert.equal(r.data.counts.trial, 1);
  assert.ok(r.data.memberships.every((m) => m.plan_name && m.price_cents > 0 && m.first_name));
  r = await owner.get('/memberships?view=paused');
  assert.deepEqual(r.data.memberships.map((m) => m.first_name), ['Mason']);
  r = await owner.get('/memberships?view=renewing');
  assert.ok(r.data.memberships.every((m) => ['active', 'trial'].includes(m.status) && m.next_charge <= addDays(today(), 7)));
  assert.equal(r.data.upcoming.count, r.data.memberships.length);
  r = await owner.get('/memberships?q=jensen');
  assert.deepEqual(r.data.memberships.map((m) => m.first_name).sort(), ['Emma', 'Nate']);
  const plan = get("SELECT id FROM plans WHERE name='8 sessions a month'");
  r = await owner.get(`/memberships?plan_id=${plan.id}`);
  assert.ok(r.data.memberships.length && r.data.memberships.every((m) => m.plan_id === plan.id));
  assert.equal((await owner.get('/memberships?view=everyone')).status, 400);
  // Cancelled lately shows a membership cancelled today.
  const m = get("SELECT id FROM memberships WHERE status='paused'");
  assert.equal((await owner.post(`/memberships/${m.id}/cancel`)).status, 200);
  r = await owner.get('/memberships?view=cancelled');
  assert.ok(r.data.memberships.some((x) => x.id === m.id && x.cancelled_at === today()));
});

test('plans: names stay unique among live plans and numbers stay in range', async () => {
  const [a, b] = all('SELECT * FROM plans WHERE active=1 ORDER BY id LIMIT 2');
  let r = await owner.put(`/plans/${b.id}`, { name: a.name.toUpperCase() });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /already exists/);
  // Retire b, create a new plan with b's name, then bringing b back is refused.
  assert.equal((await owner.put(`/plans/${b.id}`, { active: false })).status, 200);
  assert.equal((await owner.post('/plans', { name: b.name, price: '99' })).status, 201);
  r = await owner.put(`/plans/${b.id}`, { active: true });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Rename one of them/);
  assert.equal(get('SELECT active FROM plans WHERE id=?', b.id).active, 0);
  // Renaming it while bringing it back works.
  assert.equal((await owner.put(`/plans/${b.id}`, { active: true, name: `${b.name} (2025)` })).status, 200);

  for (const body of [{ name: 'Long trial', price: '50', trial_days: 91 }, { name: 'x'.repeat(61), price: '50' }, { name: 'Lots', price: '50', group_per_month: 101 },
    { name: 'Too dear', price: '20000' }, { name: 'Neg', price: '50', private_per_month: -1 }]) {
    const res = await owner.post('/plans', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await owner.put(`/plans/${a.id}`, { trial_days: 120 })).status, 400);
  assert.equal((await owner.post('/plans', { name: '  Spaced   out  ', price: '45', trial_days: '', group_per_month: '', private_per_month: '' })).status, 201);
  const p = get("SELECT * FROM plans WHERE name='Spaced out'");
  assert.equal(p.group_per_month, null, 'blank group sessions means unlimited');
  assert.equal(p.private_per_month, 0);
  assert.equal(p.trial_days, 0);
});

test('CSV export follows the filter and is safe to open in a spreadsheet', async () => {
  const fam = get("SELECT family_id AS id, id AS athlete FROM athletes WHERE first_name='Ava' AND last_name='Lopez'");
  insert('invoices', { number: 'DP-CSV-0001', kind: 'charge', family_id: fam.id, athlete_id: fam.athlete, description: '=HYPERLINK("x"), "quoted"', amount_cents: 1234, status: 'open', view_token: 'csv-test-token' });
  const res = await fetch(base + '/api/invoices/export.csv?status=open&kind=charge', { headers: { cookie: jars.owner } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="invoices-\d{4}-\d{2}-\d{2}\.csv"/);
  const text = (await res.text()).replace(/^﻿/, '');
  const lines = text.trim().split('\r\n');
  assert.equal(lines[0].split(',')[0], 'Invoice');
  assert.equal(lines.length, 2, 'only the matching invoice');
  assert.ok(lines[1].startsWith('DP-CSV-0001,'));
  assert.ok(lines[1].includes(`"'=HYPERLINK(""x""), ""quoted"""`), 'formulas are neutralised and quotes escaped');
  assert.ok(lines[1].includes(',12.34,open,'));
  assert.equal((await owner.get('/invoices/export.csv?status=nope')).status, 400);
});

test('activity seen by coaches still carries no dollar amounts after billing actions', async () => {
  const r = await coach.get('/activity?limit=500');
  const leaks = r.data.filter((a) => /\$\d/.test(`${a.action} ${a.detail || ''}`));
  assert.deepEqual(leaks, []);
});
