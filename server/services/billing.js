// Money rules shared by every screen: charging a family, memberships, renewals, retries, packs.
'use strict';
const { db, get, all, run, insert, update, tx } = require('../db');
const { payments, nextInvoiceNumber, sendEmail, emit, today, addDays, addMonths, money, businessName, randomToken, bad } = require('../lib');

const RETRY_DAYS = 3, MAX_ATTEMPTS = 4;

// Sale schema added after launch: the discount on a counter sale and when its receipt was last emailed.
// Upgrades existing databases in place on start (seeds and routes both load this module).
const saleCols = all('PRAGMA table_info(sales)').map((c) => c.name);
if (!saleCols.includes('discount_cents')) db.exec('ALTER TABLE sales ADD COLUMN discount_cents INTEGER DEFAULT 0');
if (!saleCols.includes('receipt_sent_at')) db.exec('ALTER TABLE sales ADD COLUMN receipt_sent_at TEXT');

// Refunds point back at the invoice they refund, so Billing knows how much of a charge is left to refund.
// Older refund rows (RF-…) are matched to their original once, by family, athlete and description.
const invCols = all('PRAGMA table_info(invoices)').map((c) => c.name);
if (!invCols.includes('refund_of')) {
  db.exec('ALTER TABLE invoices ADD COLUMN refund_of INTEGER REFERENCES invoices(id)');
  db.exec(`UPDATE invoices SET refund_of=(SELECT o.id FROM invoices o WHERE o.amount_cents>0 AND o.id<invoices.id
      AND o.description=substr(invoices.description, 9) AND COALESCE(o.family_id,0)=COALESCE(invoices.family_id,0)
      AND COALESCE(o.athlete_id,0)=COALESCE(invoices.athlete_id,0) ORDER BY o.id DESC LIMIT 1)
    WHERE number LIKE 'RF-%' AND amount_cents<0 AND description LIKE 'Refund: %'`);
}
db.exec('CREATE INDEX IF NOT EXISTS invoices_refund_of ON invoices(refund_of) WHERE refund_of IS NOT NULL');

function familyOf(athleteId) {
  const a = get('SELECT family_id FROM athletes WHERE id=?', athleteId);
  return a?.family_id ? get('SELECT * FROM families WHERE id=?', a.family_id) : null;
}
function billingEmail(familyId) {
  return get('SELECT email FROM parents WHERE family_id=? ORDER BY is_self DESC, id LIMIT 1', familyId)?.email || null;
}

// Charge a family (card on file, cash, tap, reader). Always records an invoice row so it appears in Billing.
// Returns { ok, invoice_id, charge_id, error }.
function charge({ family_id, athlete_id = null, amount_cents, description, method = 'card', kind = 'charge', membership_id = null, period = null }) {
  if (!(amount_cents >= 0)) throw bad('Enter an amount.');
  const family = family_id ? get('SELECT * FROM families WHERE id=?', family_id) : null;
  const r = payments.charge({ amount_cents, method, family });
  const invoice_id = insert('invoices', {
    number: nextInvoiceNumber('DP'), kind, family_id, athlete_id, membership_id, description, amount_cents, period, issued_at: today(), // the business day, not UTC's
    status: r.ok ? 'paid' : 'failed', paid_at: r.ok ? new Date().toISOString() : null, pay_method: method, charge_id: r.charge_id || null,
    attempts: 1, next_retry: r.ok ? null : addDays(today(), RETRY_DAYS), view_token: randomToken(16),
  });
  emit(r.ok ? 'payment.succeeded' : 'payment.failed', { invoice_id, family_id, athlete_id, amount_cents, description, method });
  return { ok: r.ok, invoice_id, charge_id: r.charge_id, error: r.error };
}

function refundInvoice(invoiceId, amount_cents) {
  const inv = get('SELECT * FROM invoices WHERE id=?', invoiceId);
  if (!inv || inv.status !== 'paid') return { ok: false };
  const r = payments.refund({ charge_id: inv.charge_id, amount_cents: amount_cents ?? inv.amount_cents });
  const id = insert('invoices', { number: nextInvoiceNumber('RF'), kind: 'charge', family_id: inv.family_id, athlete_id: inv.athlete_id, description: `Refund: ${inv.description}`, issued_at: today(),
    amount_cents: -(amount_cents ?? inv.amount_cents), status: 'paid', paid_at: new Date().toISOString(), pay_method: inv.pay_method, charge_id: r.refund_id, view_token: randomToken(16),
    refund_of: inv.amount_cents > 0 ? inv.id : null });
  return { ok: true, refund_invoice_id: id };
}

// How much of a paid invoice has been refunded so far (positive cents).
function refundedCents(invoiceId) {
  return -get('SELECT COALESCE(SUM(amount_cents),0) c FROM invoices WHERE refund_of=?', invoiceId).c;
}

// Pack and session products add credits to an athlete.
function applyProduct(athleteId, product, qty = 1) {
  if (!athleteId) return;
  if (product.kind === 'group_pack' || product.kind === 'session') run('UPDATE athletes SET group_credits=group_credits+? WHERE id=?', (product.credits || 1) * qty, athleteId);
  if (product.kind === 'private_pack') run('UPDATE athletes SET private_credits=private_credits+? WHERE id=?', (product.credits || 1) * qty, athleteId);
}

// ---- memberships ----
function activeMembership(athleteId) {
  return get(`SELECT m.*, p.name AS plan_name, p.group_per_month, p.private_per_month FROM memberships m JOIN plans p ON p.id=m.plan_id
    WHERE m.athlete_id=? AND m.status IN ('trial','active','past_due','paused') ORDER BY m.id DESC LIMIT 1`, athleteId);
}

function startMembership(athleteId, planId, { skipTrial = false } = {}) {
  const plan = get('SELECT * FROM plans WHERE id=? AND active=1', planId);
  if (!plan) throw bad('Choose a plan.');
  if (activeMembership(athleteId)) throw bad('This athlete already has a membership. Change or cancel it first.');
  const fam = familyOf(athleteId);
  const T = today();
  const trial = !skipTrial && plan.trial_days > 0;
  const id = insert('memberships', { athlete_id: athleteId, plan_id: planId, status: trial ? 'trial' : 'active', started_at: T, price_cents: plan.price_cents, next_charge: trial ? addDays(T, plan.trial_days) : addMonths(T, 1) });
  if (!trial) {
    const r = charge({ family_id: fam?.id, athlete_id: athleteId, amount_cents: plan.price_cents, description: `${plan.name}: first month`, kind: 'membership', membership_id: id, period: T.slice(0, 7) });
    if (!r.ok) update('memberships', id, { status: 'past_due' });
    else if (plan.private_per_month) run('UPDATE athletes SET private_credits=private_credits+? WHERE id=?', plan.private_per_month, athleteId);
    return { id, ok: r.ok, error: r.error };
  }
  return { id, ok: true, trial: true };
}

function setMembershipStatus(id, status) {
  const m = get('SELECT * FROM memberships WHERE id=?', id);
  if (!m) throw bad('No such membership.');
  const patch = { status };
  if (status === 'cancelled') patch.cancelled_at = today();
  if (status === 'active' && m.status === 'paused') patch.next_charge = m.next_charge < today() ? today() : m.next_charge;
  update('memberships', id, patch);
  if (status === 'active' && patch.next_charge === today()) renewDue();
}

function changePlan(id, planId) {
  const plan = get('SELECT * FROM plans WHERE id=?', planId);
  if (!plan) throw bad('Choose a plan.');
  update('memberships', id, { plan_id: planId, price_cents: plan.price_cents }); // applies from the next charge
}

// Group sessions a membership still covers this calendar month (null = unlimited).
function memberSessionsLeft(athleteId, when = today()) {
  const m = activeMembership(athleteId);
  if (!m || !['active', 'trial'].includes(m.status)) return 0;
  if (m.group_per_month == null) return Infinity;
  const used = get(`SELECT COUNT(*) n FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.coverage='member'
    AND b.status IN ('booked','late_cancel') AND substr(e.starts_at,1,7)=?`, athleteId, when.slice(0, 7)).n;
  return Math.max(0, m.group_per_month - used);
}

function renewOne(m) {
  const fam = familyOf(m.athlete_id);
  const plan = get('SELECT * FROM plans WHERE id=?', m.plan_id);
  const r = charge({ family_id: fam?.id, athlete_id: m.athlete_id, amount_cents: m.price_cents ?? plan.price_cents, description: `${plan.name}: ${require('../lib').monthLabel(m.next_charge)}`, kind: 'membership', membership_id: m.id, period: m.next_charge.slice(0, 7) });
  if (r.ok) {
    update('memberships', m.id, { status: 'active', next_charge: addMonths(m.next_charge, 1) });
    if (plan.private_per_month) run('UPDATE athletes SET private_credits=private_credits+? WHERE id=?', plan.private_per_month, m.athlete_id);
  } else {
    update('memberships', m.id, { status: 'past_due', next_charge: addMonths(m.next_charge, 1) });
    const a = get('SELECT first_name FROM athletes WHERE id=?', m.athlete_id);
    sendEmail(billingEmail(fam?.id), `Payment declined for ${a.first_name}'s membership`, `We couldn't charge your card for ${plan.name} (${money(m.price_cents)}). We'll try again in ${RETRY_DAYS} days. To update your card, sign in to the parent portal and open the Family tab.`);
  }
  return r;
}

// Job: charge memberships whose next charge date has arrived (trials convert here too).
function renewDue() {
  const due = all("SELECT * FROM memberships WHERE status IN ('active','trial') AND next_charge<=?", today());
  for (const m of due) tx(() => renewOne(m));
  return due.length;
}

// Job: retry declined charges every 3 days, up to 4 attempts.
function retryFailed({ invoiceId = null } = {}) {
  const list = invoiceId ? all("SELECT * FROM invoices WHERE id=? AND status='failed'", invoiceId)
    : all("SELECT * FROM invoices WHERE status='failed' AND kind IN ('membership','charge') AND next_retry<=? AND attempts<?", today(), MAX_ATTEMPTS);
  let paid = 0;
  for (const inv of list) {
    const family = get('SELECT * FROM families WHERE id=?', inv.family_id);
    const r = payments.charge({ amount_cents: inv.amount_cents, method: 'card', family });
    if (r.ok) {
      update('invoices', inv.id, { status: 'paid', paid_at: new Date().toISOString(), charge_id: r.charge_id, attempts: inv.attempts + 1, next_retry: null });
      if (inv.membership_id) run("UPDATE memberships SET status='active' WHERE id=? AND status='past_due'", inv.membership_id);
      emit('payment.succeeded', { invoice_id: inv.id, amount_cents: inv.amount_cents, retry: true });
      paid++;
    } else {
      update('invoices', inv.id, { attempts: inv.attempts + 1, next_retry: addDays(today(), RETRY_DAYS) });
    }
  }
  return { tried: list.length, paid };
}

module.exports = { RETRY_DAYS, MAX_ATTEMPTS, charge, refundInvoice, refundedCents, applyProduct, activeMembership, startMembership, setMembershipStatus, changePlan, memberSessionsLeft, renewDue, retryFailed, familyOf, billingEmail, businessName };
