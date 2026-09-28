// Billing (batch B6): the money summary, failed-payment follow-up, invoice views and CSV, refunds, voids, memberships,
// plans, and collecting for a booking only through an explicit, checked booking_id.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { handleStripeEvent, takings } from '../src/services/commerce.js';
import { reconcileInvoicePayment, runBilling, attemptCharge, moneyIn, retryDeclined, markInvoicePaid } from '../src/services/billing.js';
import { checkDay } from '../src/services/moneychecks.js';
import { getSetting } from '../src/services/families.js';
import { deleteFamilyData } from '../src/services/legal.js';
import { completePayLink } from '../src/services/paylinks.js';
import { resetRateLimits } from '../src/services/security.js';
import { addDays, zonedToUtc, startOfLocalDay, localDate } from '../src/util.js';

let app, base, owner, coach, desk, facility, plan, cheap;
const refunds = [];
let refundDelay = 0;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* CSV */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };
}
const db = () => app.ctx.db;
const now = () => new Date().toISOString();
let seq = 0;
// A family with a parent, an athlete, optionally a saved card, on a plan.
async function member({ card = true, declining = false, planId = plan.id, name } = {}) {
  const n = ++seq;
  const made = (await owner('POST', '/v1/clients', { name: name ?? `Athlete ${n} Test`, parent: { name: `Parent ${n}`, email: `parent${n}@example.com` } })).body;
  const c = { ...made, family_id: db().get('SELECT family_id FROM clients WHERE id = ?', made.id).family_id };
  if (card) await owner('POST', `/v1/clients/${c.id}/card/test`, {});
  if (declining) db().run(`UPDATE families SET card_status = 'declining' WHERE id = ?`, c.family_id);
  await owner('POST', `/v1/clients/${c.id}/subscription`, { plan_id: planId });
  const inv = db().get('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.id);
  return { ...c, inv };
}
const invoice = (id) => db().get('SELECT * FROM invoices WHERE id = ?', id);
const subOf = (clientId) => db().get('SELECT * FROM subscriptions WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', clientId);
const mailTo = (email) => db().all('SELECT subject, body FROM outbox WHERE to_email = ? ORDER BY rowid', email);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  const refund = app.ctx.payments.refund;
  app.ctx.payments.refund = async (args) => { refunds.push(args); if (refundDelay) await new Promise((r) => setTimeout(r, refundDelay)); return refund(args); };
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000, trial_days: 0 })).body;
  cheap = (await owner('POST', '/v1/plans', { name: 'Starter', price_cents: 9900, trial_days: 14 })).body;
});
after(() => app.server.close());

// ---------------------------------------------------------------- summary
test('the summary matches Today and the day\'s takings, and refunds count on the day they were made', async () => {
  const before = (await owner('GET', '/v1/billing/summary')).body;
  const pulse0 = (await owner('GET', '/v1/dashboard')).body.pulse.money;
  assert.equal(before.month.collected_cents, pulse0.month.total);
  assert.equal(before.mrr.total_cents, pulse0.mrr_cents);
  assert.equal(before.failed.cents, pulse0.failed_cents);

  const m = await member();
  assert.equal(m.inv.status, 'paid');
  await owner('POST', '/v1/sales', { location_id: facility.id, method: 'cash', custom: { description: 'Gloves', amount_cents: 4200 } });
  const r = await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { amount_cents: 5000, reason: 'Missed a week' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // A sale paid on an earlier day and refunded today counts today, like the takings.
  const old = (await owner('POST', '/v1/sales', { location_id: facility.id, method: 'cash', custom: { description: 'Old bat', amount_cents: 3000 } })).body;
  db().run('UPDATE sales SET completed_at = ?, created_at = ? WHERE id = ?', addDays(now(), -40), addDays(now(), -40), old.id);
  await owner('POST', `/v1/sales/${old.id}/refund`, { amount_cents: 1000, reason: 'Cracked' });

  const s = (await owner('GET', '/v1/billing/summary')).body;
  const pulse = (await owner('GET', '/v1/dashboard')).body.pulse.money;
  assert.equal(s.month.collected_cents, pulse.month.total, 'Billing and Today show the same collected number');
  assert.equal(s.month.collected_cents, before.month.collected_cents + 15000 + 4200 - 5000 - 1000);
  assert.equal(s.month.refunded_cents, before.month.refunded_cents + 6000);
  const t = takings(app.ctx);
  assert.equal(s.today.counter_cents, t.net_cents, 'today\'s counter money is the day\'s takings');
  assert.equal(pulse.today_cents, t.net_cents);
  assert.equal(s.mrr.total_cents, pulse.mrr_cents);
  assert.equal(s.mrr.members_cents, before.mrr.members_cents + 15000);
});

// ---------------------------------------------------------------- refunds
test('refund part then the rest of a membership payment, with a reason, never more than was paid, logged and emailed', async () => {
  const m = await member();
  refunds.length = 0;
  let r = await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { amount_cents: 4000 });
  assert.equal(r.status, 400); assert.match(r.body.error.message, /why you're refunding/);
  r = await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { amount_cents: 15001, reason: 'Oops' });
  assert.equal(r.status, 400); assert.match(r.body.error.message, /up to \$150/);
  r = await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { amount_cents: 4000, reason: 'Hurt his ankle' });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'partially_refunded');
  assert.equal(r.body.refundable_cents, 11000);
  assert.deepEqual(r.body.emailed_to, [`parent${seq}@example.com`]);
  assert.match(mailTo(`parent${seq}@example.com`).at(-1).body, /We refunded \$40 of the \$150 payment[\s\S]*Reason: Hurt his ankle[\s\S]*goes back to the card/);
  r = await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { amount_cents: 12000, reason: 'Rest' });
  assert.equal(r.status, 400); assert.match(r.body.error.message, /up to \$110 \(\$40 was already refunded\)/);
  r = await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { reason: 'Moved away', email: false });
  assert.equal(r.body.state, 'refunded');
  assert.equal(r.body.refunded_cents, 15000);
  assert.deepEqual(r.body.refunds.map((x) => [x.amount_cents, x.reason, x.by_name]), [[4000, 'Hurt his ankle', 'Olivia Owner'], [11000, 'Moved away', 'Olivia Owner']]);
  assert.deepEqual(refunds.map((x) => [x.paymentRef, x.amountCents, x.idempotencyKey]), [[m.inv.payment_ref, 4000, `invoice-refund-${m.inv.id}-4000`], [m.inv.payment_ref, 11000, `invoice-refund-${m.inv.id}-15000`]]);
  r = await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { reason: 'Again' });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /already been refunded in full/);
  assert.equal(subOf(m.id).status, 'active', 'the membership carries on');
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM events WHERE type = 'invoice.refunded' AND data LIKE ?`, `%${m.inv.id}%`).n, 2);
});

test('two refunds of the same invoice at once pay back once, and Stripe\'s echo of it logs nothing more', async () => {
  const m = await member();
  refunds.length = 0;
  refundDelay = 60;
  try {
    const echo = (async () => { await new Promise((r) => setTimeout(r, 20)); await handleStripeEvent(app.ctx, { type: 'charge.refunded', data: { object: { payment_intent: m.inv.payment_ref, amount_refunded: 15000 } } }); })();
    const [a, b] = await Promise.all([owner('POST', `/v1/invoices/${m.inv.id}/refund`, { reason: 'Double tap' }), owner('POST', `/v1/invoices/${m.inv.id}/refund`, { reason: 'Double tap' }), echo]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  } finally { refundDelay = 0; }
  assert.equal(refunds.length, 1, 'the card is refunded once');
  assert.equal(invoice(m.inv.id).refunded_cents, 15000);
  assert.deepEqual(db().all('SELECT amount_cents, source FROM invoice_refunds WHERE invoice_id = ?', m.inv.id).map((r) => ({ ...r })), [{ amount_cents: 15000, source: 'app' }]);
  await handleStripeEvent(app.ctx, { type: 'charge.refunded', data: { object: { payment_intent: m.inv.payment_ref, amount_refunded: 15000 } } });
  assert.equal(db().get('SELECT COUNT(*) AS n FROM invoice_refunds WHERE invoice_id = ?', m.inv.id).n, 1);
});

test('a refund made in the Stripe dashboard shows on the invoice once, and in the month\'s refunds', async () => {
  const m = await member();
  const before = (await owner('GET', '/v1/billing/summary')).body.month.refunded_cents;
  await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { amount_cents: 2000, reason: 'Late start' });
  await handleStripeEvent(app.ctx, { type: 'charge.refunded', data: { object: { payment_intent: m.inv.payment_ref, amount_refunded: 2000 } } });
  assert.equal(invoice(m.inv.id).refunded_cents, 2000, 'the echo of the app refund adds nothing');
  await handleStripeEvent(app.ctx, { type: 'charge.refunded', data: { object: { payment_intent: m.inv.payment_ref, amount_refunded: 5000 } } });
  await handleStripeEvent(app.ctx, { type: 'charge.refunded', data: { object: { payment_intent: m.inv.payment_ref, amount_refunded: 5000 } } });
  await handleStripeEvent(app.ctx, { type: 'charge.refunded', data: { object: { payment_intent: m.inv.payment_ref, amount_refunded: 4000 } } });   // an older event, late
  const d = (await owner('GET', `/v1/invoices/${m.inv.id}`)).body;
  assert.equal(d.refunded_cents, 5000);
  assert.deepEqual(d.refunds.map((r) => [r.amount_cents, r.source]), [[2000, 'app'], [3000, 'stripe']]);
  assert.equal((await owner('GET', '/v1/billing/summary')).body.month.refunded_cents, before + 5000);
});

test('a payment recorded by hand is refunded without touching the card', async () => {
  const m = await member({ declining: true });
  assert.equal(m.inv.status, 'failed');
  let r = await owner('POST', `/v1/invoices/${m.inv.id}/payments`, { method: 'check', reference: '1042' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'paid');
  assert.equal(r.body.paid_by, 'Check');
  assert.equal(r.body.membership_reactivated, true);
  assert.equal(subOf(m.id).status, 'active');
  assert.match(mailTo(`parent${seq}@example.com`).at(-1).body, /Paid by check \(check 1042\)/);
  refunds.length = 0;
  r = await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { amount_cents: 5000, reason: 'Paid too much' });
  assert.equal(r.status, 200);
  assert.equal(refunds.length, 0, 'nothing goes to the card for a check');
  assert.match(mailTo(`parent${seq}@example.com`).at(-1).body, /hand it back the way you paid/);
  r = await owner('POST', `/v1/invoices/${m.inv.id}/payments`, { method: 'cash' });
  assert.equal(r.status, 409, 'already paid');
});

test('a card charge the bank approves after the family paid by check goes back automatically', async () => {
  const m = await member({ declining: true });
  const ref = invoice(m.inv.id).payment_ref ?? 'pi_late';
  db().run('UPDATE invoices SET payment_ref = ? WHERE id = ?', ref, m.inv.id);
  await owner('POST', `/v1/invoices/${m.inv.id}/payments`, { method: 'cash' });
  refunds.length = 0;
  const out = await reconcileInvoicePayment(app.ctx, m.inv.id, { ref, succeeded: true });
  assert.equal(out, 'refunded');
  assert.deepEqual(refunds.map((r) => [r.paymentRef, r.amountCents]), [[ref, 15000]]);
  assert.equal(await reconcileInvoicePayment(app.ctx, m.inv.id, { ref, succeeded: true }), 'refunded', 'a repeated event changes nothing');
  assert.equal(refunds.length, 1, 'refunded exactly once');
  assert.equal(invoice(m.inv.id).status, 'paid');
});

// ---------------------------------------------------------------- void
test('voiding a declined charge writes it off, closes its pay link and brings the membership back', async () => {
  const m = await member({ declining: true });
  assert.equal(subOf(m.id).status, 'past_due');
  const link = db().get(`SELECT * FROM pay_links WHERE invoice_id = ? AND status = 'open'`, m.inv.id);
  assert.ok(link, 'the failed-payment email made a pay link');
  const r = await owner('POST', `/v1/invoices/${m.inv.id}/void`, { reason: 'Coach comped the month' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'void');
  assert.equal(r.body.void_reason, 'Coach comped the month');
  assert.equal(r.body.membership_reactivated, true);
  assert.equal(subOf(m.id).status, 'active');
  assert.equal(db().get('SELECT status FROM pay_links WHERE id = ?', link.id).status, 'canceled');
  assert.equal(invoice(m.inv.id).next_retry_at, null);
  assert.equal((await owner('POST', `/v1/invoices/${m.inv.id}/void`, {})).status, 409);
  assert.equal((await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { reason: 'x' })).status, 409);
  // A parent paying the old link now gets their money back.
  refunds.length = 0;
  await completePayLink(app.ctx, link.id, 'pi_after_void');
  assert.equal(refunds.length, 1);
  assert.equal(invoice(m.inv.id).status, 'void');
});

test('a void and a payment of the same invoice at the same moment: exactly one happens', async () => {
  const m = await member({ declining: true });
  const [a, b] = await Promise.all([owner('POST', `/v1/invoices/${m.inv.id}/void`, {}), owner('POST', `/v1/invoices/${m.inv.id}/payments`, { method: 'cash' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const inv = invoice(m.inv.id);
  assert.ok(['void', 'paid'].includes(inv.status));
  assert.equal((await owner('POST', `/v1/invoices/${m.inv.id}/void`, {})).status, 409);
  const paidInv = await member();
  assert.equal((await owner('POST', `/v1/invoices/${paidInv.inv.id}/void`, {})).body.error.message, 'This invoice is paid. Refund it instead.');
});

test('the bank approving a charge after it was voided refunds it (owner decision: a voided invoice isn\'t collected)', async () => {
  const m = await member({ declining: true });
  db().run(`UPDATE invoices SET payment_ref = 'pi_approved_late' WHERE id = ?`, m.inv.id);
  await owner('POST', `/v1/invoices/${m.inv.id}/void`, {});
  refunds.length = 0;
  assert.equal(await reconcileInvoicePayment(app.ctx, m.inv.id, { ref: 'pi_approved_late', succeeded: true }), 'refunded');
  assert.deepEqual(refunds.map((r) => r.paymentRef), ['pi_approved_late']);
  const inv = invoice(m.inv.id);
  assert.equal(inv.status, 'void', 'still void');
  assert.ok(inv.voided_at);
});

// ---------------------------------------------------------------- retries and reminders
test('retry refuses a family with no card, and a declined manual retry never cancels the membership', async () => {
  const noCard = await member({ card: false });
  let r = await owner('POST', `/v1/invoices/${noCard.inv.id}/retry`);
  assert.equal(r.status, 409); assert.match(r.body.error.message, /no card on file for this family/);
  assert.equal(invoice(noCard.inv.id).attempts, 1, 'nothing was tried');
  const m = await member({ declining: true });
  db().run('UPDATE invoices SET attempts = 3 WHERE id = ?', m.inv.id);
  const next = invoice(m.inv.id).next_retry_at;
  r = await owner('POST', `/v1/invoices/${m.inv.id}/retry`);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'failed');
  assert.equal(r.body.membership_reactivated, false);
  assert.equal(subOf(m.id).status, 'past_due', 'still past due, not canceled');
  assert.equal(invoice(m.inv.id).next_retry_at, next, 'the automatic retry stays when it was');
  db().run(`UPDATE families SET card_status = 'ok' WHERE id = ?`, m.family_id);
  r = await owner('POST', `/v1/invoices/${m.inv.id}/retry`);
  assert.equal(r.body.status, 'paid');
  assert.equal(r.body.membership_reactivated, true);
});

test('manual retries don\'t count toward canceling: only the automatic tries do', async () => {
  const m = await member({ declining: true });
  assert.equal(invoice(m.inv.id).attempts, 1);
  for (let i = 0; i < 3; i++) await attemptCharge(app.ctx, m.inv.id, now(), { manual: true });
  assert.deepEqual([invoice(m.inv.id).attempts, invoice(m.inv.id).auto_attempts], [4, 1]);
  // The second automatic try (of 5) comes due: still past due, not canceled.
  await runBilling(app.ctx, invoice(m.inv.id).next_retry_at);
  assert.equal(invoice(m.inv.id).status, 'failed');
  assert.equal(subOf(m.id).status, 'past_due');
  assert.equal((await owner('GET', `/v1/invoices/${m.inv.id}`)).body.retries_left, 3, 'three automatic tries left');
  // The third, fourth and fifth automatic tries: canceled after the fifth.
  for (let i = 0; i < 2; i++) {
    await runBilling(app.ctx, invoice(m.inv.id).next_retry_at);
    assert.equal(subOf(m.id).status, 'past_due');
  }
  await runBilling(app.ctx, invoice(m.inv.id).next_retry_at);
  assert.equal(invoice(m.inv.id).status, 'void');
  assert.equal(subOf(m.id).status, 'canceled');
});

test('retry all charges every declined payment with a card and reports what happened', async () => {
  // Clear earlier failures so the numbers are this test's.
  db().run(`UPDATE invoices SET status = 'void', next_retry_at = NULL WHERE status = 'failed'`);
  db().run(`UPDATE subscriptions SET status = 'active' WHERE status = 'past_due'`);
  assert.equal((await owner('POST', '/v1/billing/retry-declined')).status, 409);
  const fixed = await member({ declining: true });
  const still = await member({ declining: true });
  await member({ card: false });
  db().run(`UPDATE families SET card_status = 'ok' WHERE id = ?`, fixed.family_id);
  const r = await owner('POST', '/v1/billing/retry-declined');
  assert.equal(r.status, 200);
  assert.deepEqual({ tried: r.body.tried, paid: r.body.paid, paid_cents: r.body.paid_cents, declined: r.body.declined, no_card: r.body.no_card, back: r.body.memberships_reactivated }, { tried: 2, paid: 1, paid_cents: 15000, declined: 1, no_card: 1, back: 1 });
  assert.equal(subOf(still.id).status, 'past_due');
});

test('card reminders: one email per family listing every declined charge, never twice a day', async () => {
  db().run(`UPDATE invoices SET status = 'void', next_retry_at = NULL WHERE status = 'failed'`);
  db().run(`UPDATE subscriptions SET status = 'active' WHERE status = 'past_due'`);
  const m = await member({ declining: true });
  const email = `parent${seq}@example.com`;
  // A sibling in the same family declines too.
  const sib = (await owner('POST', `/v1/families/${m.family_id}/athletes`, { name: 'Sib Test' })).body;
  const sibId = sib.id ?? sib.athletes?.at(-1)?.id ?? db().get(`SELECT id FROM clients WHERE name = 'Sib Test'`).id;
  await owner('POST', `/v1/clients/${sibId}/subscription`, { plan_id: plan.id });
  const sibInv = db().get('SELECT id, status FROM invoices WHERE client_id = ?', sibId);
  assert.equal(sibInv.status, 'failed');
  const before = mailTo(email).length;
  let r = await owner('POST', `/v1/invoices/${m.inv.id}/remind`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.invoices_in_reminder, 2);
  const mail = mailTo(email).slice(before).find((x) => /Please update your card/.test(x.subject));
  assert.match(mail.subject, /2 payments didn't go through/);
  assert.match(mail.body, /Monthly for Athlete[\s\S]*https:\/\/app\.example\.org\/pay\/[\w-]+[\s\S]*Monthly for Sib[\s\S]*Total: \$300/);
  r = await owner('POST', `/v1/invoices/${sibInv.id}/remind`);
  assert.equal(r.status, 409, 'the family was reminded today, about either charge'); assert.match(r.body.error.message, /already went out today/);
  const bulk = await owner('POST', '/v1/billing/remind-declined');
  assert.equal(bulk.body.sent, 0);
  assert.equal(bulk.body.skipped_today, 1);
  assert.equal((await owner('GET', `/v1/invoices/${m.inv.id}`)).body.can.remind, false);
  // Another family, reminded in bulk once; a second bulk run the same day sends nothing.
  const other = await member({ declining: true });
  const b1 = await owner('POST', '/v1/billing/remind-declined');
  assert.equal(b1.body.sent, 1);
  const b2 = await owner('POST', '/v1/billing/remind-declined');
  assert.equal(b2.body.sent, 0);
  assert.equal(mailTo(`parent${seq}@example.com`).filter((x) => /Please update your card/.test(x.subject)).length, 1);
  // Tomorrow they can be reminded again.
  db().run('UPDATE invoices SET reminded_at = ? WHERE client_id = ?', addDays(now(), -2), other.id);
  assert.equal((await owner('POST', `/v1/invoices/${other.inv.id}/remind`)).status, 200);
});

test('needs attention lists each decline with its card and tries, and overdue school invoices', async () => {
  const m = await member({ declining: true });
  const start = new Date(Date.now() - 75 * 86400000).toISOString().slice(0, 10);
  const contract = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Westlake HS', contact_email: 'ad@westlake.example' }, name: 'Varsity', monthly_cents: 100000, start_date: start })).body;
  assert.ok(contract.id, JSON.stringify(contract));
  // Invoices for months that already started are issued today; make the oldest one 12 days late.
  const oldest = db().get('SELECT id FROM team_invoices WHERE contract_id = ? ORDER BY period_start LIMIT 1', contract.id).id;
  db().run('UPDATE team_invoices SET issued_on = ?, due_on = ? WHERE id = ?', new Date(Date.now() - 42 * 86400000).toISOString().slice(0, 10), new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10), oldest);
  const a = (await owner('GET', '/v1/billing/attention')).body;
  const row = a.failed.find((i) => i.id === m.inv.id);
  assert.equal(row.card_last4, '4242');
  assert.equal(row.attempts, 1);
  assert.ok(row.next_retry_at);
  assert.equal(row.retries_left, 4, 'the first charge declined: 4 automatic retries left');
  const late = a.overdue.find((i) => i.org_name === 'Westlake HS');
  assert.ok(late, 'the oldest school invoice is past due');
  assert.ok(late.days_past_due >= 11 && late.days_past_due <= 13, String(late.days_past_due));
  assert.equal(a.max_attempts, 5);
});

// ---------------------------------------------------------------- invoice views and CSV
test('invoice views: counts, kind, dates, search, totals and Show more', async () => {
  const m = await member({ name: 'Zelda Searchable' });
  let r = (await owner('GET', '/v1/billing/invoices?q=zelda')).body;
  assert.deepEqual(r.data.map((i) => i.id), [m.inv.id]);
  assert.equal(r.total, 1);
  assert.equal(r.total_cents, 15000);
  assert.equal(r.counts.paid, 1);
  assert.equal(r.counts.failed, 0);
  r = (await owner('GET', '/v1/billing/invoices?q=westlake&kind=school')).body;
  assert.ok(r.total >= 2 && r.data.every((i) => i.kind === 'school' && i.org_name === 'Westlake HS'));
  r = (await owner('GET', '/v1/billing/invoices?view=overdue')).body;
  assert.ok(r.data.length && r.data.every((i) => i.state === 'overdue'));
  const all = (await owner('GET', '/v1/billing/invoices?limit=3')).body;
  assert.equal(all.data.length, 3);
  assert.ok(all.total > 3);
  assert.equal(all.counts.all, all.total);
  const refundsView = (await owner('GET', '/v1/billing/invoices?view=refunds&kind=membership')).body;
  assert.ok(refundsView.data.length && refundsView.data.every((i) => i.refunded_cents > 0));
  const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  assert.equal((await owner('GET', `/v1/billing/invoices?from=${future}`)).body.total, 0);
  assert.equal((await owner('GET', '/v1/billing/invoices?view=nope')).status, 400);
  assert.equal((await owner('GET', '/v1/billing/invoices?from=2026-13-01')).status, 400);
  assert.equal((await owner('GET', '/v1/billing/invoices?from=2026-09-10&to=2026-09-01')).status, 400);
});

test('the CSV export is exactly the filter, numbers stay numbers and formulas are made safe', async () => {
  const evil = await member({ name: '=HYPERLINK("http://evil.example","Click")' });
  await owner('POST', `/v1/invoices/${evil.inv.id}/refund`, { amount_cents: 2550, reason: '+cmd|calc' });
  const r = await owner('GET', `/v1/billing/invoices/export?q=${encodeURIComponent('hyperlink')}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="invoices-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Invoice,Date,Kind,Client or school,For,Period,Amount,Refunded,Status,Due,Paid on,Paid by,Reference,Refund reason');
  assert.equal(lines.length, 3, 'the invoice and its refund');
  assert.ok(lines[1].includes(`"'=HYPERLINK(""http://evil.example"",""Click"")"`), lines[1]);
  assert.ok(lines[1].includes(',150.00,25.50,Part refunded,'), lines[1]);
  assert.ok(lines[2].includes(',-25.50,'), 'a refund amount stays a plain (negative) number');
  assert.ok(lines[2].endsWith(",'+cmd|calc"), lines[2]);
  const audit = db().get(`SELECT action FROM audit_log WHERE action LIKE 'exported % as CSV' ORDER BY rowid DESC LIMIT 1`);
  assert.equal(audit.action, 'exported 1 invoice as CSV');
});

// ---------------------------------------------------------------- memberships and plans
test('memberships list: views with counts, plan filter, search and the 7-day forecast', async () => {
  const t = await member({ planId: cheap.id, name: 'Trina Trial' });
  let r = (await owner('GET', '/v1/billing/memberships?view=trialing')).body;
  assert.ok(r.data.some((m) => m.client_id === t.id && m.status === 'trialing' && m.next_charge_at));
  assert.ok(r.counts.live >= r.counts.trialing);
  r = (await owner('GET', `/v1/billing/memberships?plan_id=${cheap.id}&q=trina`)).body;
  assert.deepEqual(r.data.map((m) => m.client_id), [t.id]);
  assert.equal(r.data[0].card_last4, '4242');
  // Trial ends within a week: it's in the renewals forecast.
  db().run('UPDATE subscriptions SET current_period_end = ?, trial_ends_at = ? WHERE client_id = ?', addDays(now(), 3), addDays(now(), 3), t.id);
  r = (await owner('GET', '/v1/billing/memberships?view=renewing')).body;
  assert.ok(r.data.some((m) => m.client_id === t.id));
  assert.ok(r.upcoming.count >= 1 && r.upcoming.cents >= 9900);
  await owner('POST', `/v1/clients/${t.id}/subscription/cancel`);
  r = (await owner('GET', '/v1/billing/memberships?view=canceled')).body;
  assert.ok(r.data.some((m) => m.client_id === t.id));
  assert.equal((await owner('GET', '/v1/billing/memberships?view=bogus')).status, 400);
});

test('plan names on offer are unique: create, rename and bring back', async () => {
  let r = await owner('POST', '/v1/plans', { name: '  monthly ', price_cents: 100, trial_days: 0 });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /A plan called monthly is already offered/);
  const b = (await owner('POST', '/v1/plans', { name: 'Elite', price_cents: 30000, trial_days: 0 })).body;
  r = await owner('PATCH', `/v1/plans/${b.id}`, { name: 'Starter' });
  assert.equal(r.status, 409);
  await owner('PATCH', `/v1/plans/${b.id}`, { active: false });
  const again = (await owner('POST', '/v1/plans', { name: 'Elite', price_cents: 31000, trial_days: 0 })).body;
  assert.ok(again.id, 'a retired plan\'s name can be used again');
  r = await owner('PATCH', `/v1/plans/${b.id}`, { active: true });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /Another plan on offer is already called Elite/);
  assert.equal((await owner('POST', '/v1/plans', { name: 'Long trial', price_cents: 100, trial_days: 91 })).status, 400);
});

// ---------------------------------------------------------------- roles
test('coaches and front desk can\'t reach any of Billing', async () => {
  const inv = db().get(`SELECT id FROM invoices LIMIT 1`).id;
  const paths = [['GET', '/v1/billing/summary'], ['GET', '/v1/billing/attention'], ['GET', '/v1/billing/invoices'], ['GET', '/v1/billing/invoices/export'], ['GET', '/v1/billing/memberships'],
    ['POST', '/v1/billing/retry-declined'], ['POST', '/v1/billing/remind-declined'], ['GET', `/v1/invoices/${inv}`], ['POST', `/v1/invoices/${inv}/refund`],
    ['POST', `/v1/invoices/${inv}/void`], ['POST', `/v1/invoices/${inv}/remind`], ['POST', `/v1/invoices/${inv}/payments`], ['POST', '/v1/plans'], ['GET', '/v1/invoices']];
  for (const who of [coach, desk]) for (const [m, p] of paths) assert.equal((await who(m, p, m === 'POST' ? {} : undefined)).status, 403, `${m} ${p}`);
  assert.equal((await coach('GET', '/v1/plans')).status, 200, 'plan names are still readable on client pages');
  // Today stays free of money for them.
  const d = (await coach('GET', '/v1/dashboard')).body;
  assert.equal(d.pulse.money, undefined);
  assert.ok(!(d.activity ?? []).some((e) => /^invoice\./.test(e.type)), 'refunds and voids stay out of their activity');
});

test('the billing clock still renews and retries', async () => {
  const r = await runBilling(app.ctx, addDays(now(), 40));
  assert.ok(r.renewed > 0);
});

test('a retry picked from a list skips an invoice voided or paid by hand since, instead of stopping the run', async () => {
  const m = await member({ declining: true });
  await owner('POST', `/v1/invoices/${m.inv.id}/void`, {});
  const out = await attemptCharge(app.ctx, m.inv.id, now(), { onlyIfFailed: true });
  assert.equal(out.status, 'void');
  assert.equal(out.attempts, 1, 'nothing was charged');
  const r = await runBilling(app.ctx, addDays(now(), 4));
  assert.ok(r.retried >= 0);
});

test('deleting a family keeps membership amounts and refunds but drops the reasons typed about them', async () => {
  const m = await member();
  await owner('POST', `/v1/invoices/${m.inv.id}/refund`, { amount_cents: 1000, reason: 'Their grandma Rosa was ill' });
  const fam = db().get('SELECT name FROM families WHERE id = ?', m.family_id).name;
  await deleteFamilyData(app.ctx, m.family_id, { confirm: fam });
  const inv = invoice(m.inv.id);
  assert.deepEqual([inv.amount_cents, inv.refunded_cents], [15000, 1000]);
  assert.deepEqual(db().all('SELECT amount_cents, reason FROM invoice_refunds WHERE invoice_id = ?', m.inv.id).map((r) => ({ ...r })), [{ amount_cents: 1000, reason: null }]);
});

// ---------------------------------------------------------------- review fixes
test('a school invoice paid today counts in this month and today, and back-to-back weeks count each day once', async () => {
  const contract = (await owner('POST', '/v1/team-contracts', { organization: { name: 'Eastside HS', contact_email: 'ad@eastside.example' }, name: 'JV', monthly_cents: 70000, start_date: new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10) })).body;
  const [a, b] = db().all('SELECT id, amount_cents FROM team_invoices WHERE contract_id = ? ORDER BY period_start LIMIT 2', contract.id);
  // Far in the future so nothing else was paid on those days.
  db().run(`UPDATE team_invoices SET status = 'paid', paid_on = '2031-03-10', paid_method = 'check' WHERE id = ?`, a.id);
  db().run(`UPDATE team_invoices SET status = 'paid', paid_on = '2031-03-03', paid_method = 'check' WHERE id = ?`, b.id);
  const tz = getSetting(app.ctx, 'timezone');
  const at = (d, t) => zonedToUtc(d, t, tz), midnight = (d) => startOfLocalDay(at(d, '12:00'), tz);
  const ctx = { ...app.ctx, now: () => at('2031-03-10', '10:00') };
  assert.equal(moneyIn(ctx, midnight('2031-03-01'), ctx.now()).teams, a.amount_cents + b.amount_cents, 'paid this morning: in this month already');
  assert.equal(moneyIn(ctx, midnight('2031-03-10'), midnight('2031-03-11')).teams, a.amount_cents, 'and in today');
  const week = moneyIn(ctx, addDays(ctx.now(), -7), ctx.now()).teams, prior = moneyIn(ctx, addDays(ctx.now(), -14), addDays(ctx.now(), -7)).teams;
  assert.equal(week + prior, a.amount_cents + b.amount_cents, 'each day in exactly one of two back-to-back weeks');
  db().run(`UPDATE team_invoices SET status = 'open', paid_on = NULL, paid_method = NULL WHERE id IN (?, ?)`, a.id, b.id);
});

test('paying one of two declined charges keeps the membership past due, so the other is still retried and reminded', async () => {
  const m = await member({ declining: true });
  // A second declined charge on the same membership (a payment that failed after it was taken).
  const second = 'inv_second_' + m.id;
  db().run(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, next_retry_at, created_at) VALUES (?, ?, ?, 15000, 'failed', ?, ?, 1, ?, ?)`,
    second, m.inv.subscription_id, m.id, addDays(now(), -30), now(), addDays(now(), 3), now());
  const r = await owner('POST', `/v1/invoices/${m.inv.id}/payments`, { method: 'cash' });
  assert.equal(r.status, 200);
  assert.equal(r.body.membership_reactivated, false);
  assert.equal(subOf(m.id).status, 'past_due');
  assert.ok((await owner('GET', '/v1/billing/attention')).body.failed.some((i) => i.id === second), 'the other charge still needs attention');
  assert.equal((await owner('POST', `/v1/invoices/${second}/payments`, { method: 'check', reference: '1001' })).body.membership_reactivated, true);
  assert.equal(subOf(m.id).status, 'active');
});

test('retry all doesn\'t count a charge paid another way while it waited as charged by the retry', async () => {
  db().run(`UPDATE invoices SET status = 'void', next_retry_at = NULL WHERE status = 'failed'`);
  db().run(`UPDATE subscriptions SET status = 'active' WHERE status = 'past_due'`);
  const m = await member({ declining: true });
  db().run(`UPDATE families SET card_status = 'ok' WHERE id = ?`, m.family_id);
  // A pay link payment holds the invoice while the retry reaches it.
  const paying = markInvoicePaid(app.ctx, m.inv.id, 'pi_paid_by_link');
  const [out] = await Promise.all([retryDeclined(app.ctx), paying]);
  assert.equal(invoice(m.inv.id).status, 'paid');
  assert.equal(invoice(m.inv.id).attempts, 1, 'the card wasn\'t charged');
  assert.equal(invoice(m.inv.id).payment_ref, 'pi_paid_by_link');
  assert.deepEqual({ tried: out.tried, paid: out.paid, paid_cents: out.paid_cents }, { tried: 0, paid: 0, paid_cents: 0 });
});

test('a membership paid by check after a declined card isn\'t a card payment in the money checks', async () => {
  const m = await member({ declining: true });
  db().run(`UPDATE invoices SET payment_ref = 'pi_declined_card' WHERE id = ?`, m.inv.id);
  await owner('POST', `/v1/invoices/${m.inv.id}/payments`, { method: 'check', reference: '2002' });
  const payments = { ...app.ctx.payments, listPayments: async () => [{ ref: 'pi_declined_card', status: 'requires_payment_method', amount_cents: 15000, created_at: now() }] };
  const row = await checkDay({ ...app.ctx, payments }, localDate(now(), getSetting(app.ctx, 'timezone')));
  const findings = typeof row.findings === 'string' ? JSON.parse(row.findings) : row.findings;
  assert.ok(!findings.some((f) => f.ref === 'pi_declined_card'), JSON.stringify(findings));
  assert.ok(!findings.some((f) => (f.items ?? []).includes(`membership:${m.inv.id}`)), JSON.stringify(findings));
});
