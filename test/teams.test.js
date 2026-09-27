import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser, dashboard } from '../src/services/access.js';
import { periodStart, runTeamBilling } from '../src/services/teams.js';
import { localDate, addDaysToDate, weekdayOf } from '../src/util.js';

const TZ = 'America/Chicago';
let app, base, cookie;
const req = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const coach = (m, p, b) => req(m, p, b, { cookie });
const today = () => localDate(new Date().toISOString(), TZ);
const monthsAgo = (n) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
let facility;

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://dp.example' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const l = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'coach@test.dev', password: 'correct-horse-battery' }) });
  cookie = l.headers.get('set-cookie').split(';')[0];
  await coach('PATCH', '/v1/settings', { timezone: TZ, business_address: '100 Main St, Austin TX', payment_instructions: 'Checks payable to Diamond Protocol LLC.' });
  facility = (await coach('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

test('monthly periods stay on the start day without drifting', () => {
  assert.deepEqual([0, 1, 2, 3].map((k) => periodStart('2026-01-31', k)), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(periodStart('2026-11-15', 2), '2027-01-15');
});

let contract;
test('a new contract invoices its first month right away and emails the school', async () => {
  const r = await coach('POST', '/v1/team-contracts', { organization: { name: 'Westlake High School', kind: 'school', contact_name: 'Pat Coach', contact_email: 'ad@westlake.example', billing_address: '4100 Westbank Dr' }, name: 'Varsity Football', monthly_cents: 180000, po_number: 'PO-7781' });
  assert.equal(r.status, 201);
  contract = r.body;
  assert.equal(contract.invoices.length, 1);
  const inv = contract.invoices[0];
  assert.match(inv.number, /^DP-\d{4}-0001$/);
  assert.equal(inv.amount_cents, 180000);
  assert.equal(inv.due_on, addDaysToDate(today(), 30), 'Net 30 by default');
  assert.equal(inv.period_start, today());
  assert.ok(inv.link.startsWith('https://dp.example/invoice/'));
  const mail = (await coach('GET', '/v1/outbox')).body.data.find((m) => m.to_email === 'ad@westlake.example');
  assert.match(mail.subject, /\$1,800 due/);
  assert.ok(mail.body.includes(inv.link) && mail.body.includes('PO-7781') && mail.body.includes('Checks payable'));
  assert.equal(contract.next_invoice_on, periodStart(today(), 1));
  assert.equal((await runTeamBilling(app.ctx)).invoiced, 0, 'running again never double-bills');
});

test('a contract that started months ago catches up, one invoice per month', async () => {
  const c = (await coach('POST', '/v1/team-contracts', { organization: { name: 'Hill Country FC', kind: 'club' }, name: '14U Girls', monthly_cents: 90000, start_date: monthsAgo(2), terms_days: 15 })).body;
  assert.equal(c.invoices.length, 3);
  assert.deepEqual(c.invoices.map((i) => i.period_start).reverse(), [monthsAgo(2), monthsAgo(1), today()]);
  assert.ok(c.invoices.every((i) => i.issued_on === today() && i.due_on === addDaysToDate(today(), 15)), 'late-entered months are billed today on normal terms');
  assert.ok(c.invoices.every((i) => !i.sent_at), 'no billing email yet, so nothing sent');
  const send = await coach('POST', `/v1/team-invoices/${c.invoices[0].id}/send`);
  assert.match(send.body.error.message, /billing email/);
  await coach('PATCH', `/v1/organizations/${c.org_id}`, { contact_email: 'treasurer@hcfc.example' });
  assert.ok((await coach('POST', `/v1/team-invoices/${c.invoices[0].id}/send`)).body.sent_at);
  // Jump 20 days ahead: everything unpaid is now past due.
  const later = { ...app.ctx, now: () => new Date(Date.now() + 20 * 86400000).toISOString() };
  const dash = dashboard(later);
  assert.equal(dash.teams.monthly_cents, 270000);
  assert.ok(dash.teams.overdue_cents >= 90000);
  assert.ok(dash.attention.some((a) => a.kind === 'team_invoice_overdue' && a.name === 'Hill Country FC'));
  const r1 = await runTeamBilling(later);
  assert.ok(r1.reminded >= 1);
  assert.ok((await coach('GET', '/v1/outbox')).body.data.some((m) => m.to_email === 'treasurer@hcfc.example' && m.subject.startsWith('Reminder')));
  assert.equal((await runTeamBilling(later)).reminded, 0, 'reminders go out weekly, not hourly');
});

test('record a check, void mistakes, and let schools pay from the link', async () => {
  const [inv] = contract.invoices;
  const paid = (await coach('POST', `/v1/team-invoices/${inv.id}/payments`, { method: 'check', reference: '#10442' })).body;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paid_reference, '#10442');
  assert.equal((await coach('POST', `/v1/team-invoices/${inv.id}/void`)).status, 409);
  assert.equal((await coach('POST', `/v1/team-invoices/${inv.id}/payments`, {})).status, 409);
  const extra = (await coach('POST', `/v1/team-contracts/${contract.id}/invoices`, { description: 'Saturday combine prep', amount_cents: 45000 })).body;
  assert.equal(extra.period_start, null);
  assert.match(extra.number, /-0005$/);
  const token = extra.link.split('/invoice/')[1];
  const pub = (await req('GET', `/invoice-api/${token}`)).body;
  assert.equal(pub.bill_to.name, 'Westlake High School');
  assert.equal(pub.from.address, '100 Main St, Austin TX');
  assert.equal(pub.can_simulate, true);
  assert.equal(pub.can_pay_online, false, 'real online payment needs Stripe');
  assert.equal((await req('POST', `/invoice-api/${token}/simulate`)).body.status, 'paid');
  assert.equal((await req('GET', '/invoice-api/not-a-real-token')).status, 404);
  const other = (await coach('POST', `/v1/team-contracts/${contract.id}/invoices`, { description: 'Wrong amount', amount_cents: 100, send: false })).body;
  assert.equal((await coach('POST', `/v1/team-invoices/${other.id}/void`)).body.status, 'void');
  assert.equal((await coach('GET', '/v1/team-invoices?status=void')).body.data.length, 1);
});

test('rosters, team sessions and attendance', async () => {
  const roster = (await coach('POST', `/v1/team-contracts/${contract.id}/roster`, { names: 'Jalen Brooks, QB, 2027\nMarcus Hill, WR\n\nTy Ortiz\tRB\t2028' })).body.data;
  assert.deepEqual(roster.map((r) => r.name), ['Jalen Brooks', 'Marcus Hill', 'Ty Ortiz']);
  assert.equal(roster.find((r) => r.name === 'Ty Ortiz').grad_year, 2028);
  const tomorrow = addDaysToDate(today(), 1);
  const series = (await coach('POST', `/v1/team-contracts/${contract.id}/sessions`, { location_id: facility.id, weekdays: [weekdayOf(tomorrow)], start_time: '15:30', duration_min: 90, start_date: tomorrow })).body;
  assert.equal(series.kind, 'team');
  assert.equal(series.name, 'Westlake High School Varsity Football');
  const sessions = (await coach('GET', '/v1/schedule?kind=team')).body.data;
  const s = (await coach('GET', `/v1/sessions/${sessions[0].id}`)).body;
  assert.equal(s.team.athletes.length, 3);
  const after = (await coach('POST', `/v1/sessions/${s.id}/team-attendance`, { roster_id: roster[0].id, present: true })).body;
  assert.equal(after.athletes.find((a) => a.id === roster[0].id).present, true);
  assert.equal((await coach('POST', `/v1/sessions/${s.id}/team-attendance`, { roster_id: 'tr_nope' })).status, 404);
  await coach('DELETE', `/v1/team-contracts/${contract.id}/roster/${roster[2].id}`);
  assert.equal((await coach('GET', `/v1/team-contracts/${contract.id}`)).body.roster.length, 2);
});

test('fee changes apply next month; ending a contract stops invoices and cancels team sessions', async () => {
  const up = (await coach('PATCH', `/v1/team-contracts/${contract.id}`, { monthly_cents: 200000 })).body;
  assert.equal(up.invoices.find((i) => i.period_start).amount_cents, 180000, 'already-issued invoices keep their amount');
  const ended = (await coach('PATCH', `/v1/team-contracts/${contract.id}`, { status: 'ended' })).body;
  assert.equal(ended.status, 'ended');
  assert.equal(ended.next_invoice_on, null);
  assert.equal(ended.sessions_upcoming, 0);
  assert.equal((await coach('GET', '/v1/schedule?kind=team')).body.data.length, 0);
  const events = (await coach('GET', '/v1/events?limit=50')).body.data.map((e) => e.type);
  for (const t of ['team_contract.created', 'team_invoice.created', 'team_invoice.paid', 'team_invoice.overdue', 'team_invoice.voided']) assert.ok(events.includes(t), t);
});
