import { newId, v, notFound, badRequest, conflict, HttpError, addDays, addMonths, withLock, isDate, localDate, zonedToUtc, startOfLocalDay, addDaysToDate } from '../util.js';
import { emit } from './events.js';
import { payerFor, getSetting } from './families.js';
import { membershipReceipt, paymentFailed, trialReminders, cardReminder, invoiceRefundReceipt } from './notify.js';
import { csvCell } from './clients.js';
import { sendEmail } from './mail.js';

export const MAX_ATTEMPTS = 4;        // after the 4th failed automatic charge the subscription is canceled
export const RETRY_EVERY_DAYS = 3;
const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: Math.abs(c) % 100 ? 2 : 0 })}`;
const zone = (ctx) => getSetting(ctx, 'timezone');
const bizToday = (ctx) => localDate(ctx.now(), zone(ctx));
// How a payment recorded by hand arrived. Everything else (NULL) was charged or paid online by card, and refunds go back to it.
export const HAND_METHODS = { cash: 'Cash', check: 'Check', other: 'Other' };

// ---- Plans ----
const publicPlan = (p) => p && ({ ...p, active: !!p.active });

export function listPlans(ctx, { includeInactive = false } = {}) {
  const rows = includeInactive
    ? ctx.db.all('SELECT * FROM plans ORDER BY price_cents')
    : ctx.db.all('SELECT * FROM plans WHERE active = 1 ORDER BY price_cents');
  const counts = Object.fromEntries(ctx.db.all(
    `SELECT plan_id, COUNT(*) AS n FROM subscriptions WHERE status IN ('active','trialing','past_due') GROUP BY plan_id`
  ).map((r) => [r.plan_id, r.n]));
  return rows.map((p) => ({ ...publicPlan(p), subscribers: counts[p.id] || 0 }));
}
export function getPlan(ctx, id) {
  const p = ctx.db.get('SELECT * FROM plans WHERE id = ?', id);
  if (!p) throw notFound('Plan');
  return publicPlan(p);
}
// Two plans on offer with the same name would be confused on client pages, at the counter and in the portal.
const planName = (val) => v.str(val, 'name', { max: 80 }).replace(/\s+/g, ' ');
const liveNamed = (ctx, name, exceptId = '') => ctx.db.get('SELECT id, name FROM plans WHERE active = 1 AND lower(name) = lower(?) AND id != ?', name, exceptId);
export function createPlan(ctx, body) {
  const name = planName(body.name);
  if (liveNamed(ctx, name)) throw conflict(`A plan called ${name} is already offered. Choose another name.`);
  const plan = {
    id: newId('plan'),
    name,
    price_cents: v.int(body.price_cents, 'price_cents', { min: 0, max: 10000000 }),
    trial_days: v.int(body.trial_days ?? 7, 'trial_days', { min: 0, max: 90 }),
    created_at: ctx.now()
  };
  ctx.db.run('INSERT INTO plans (id, name, price_cents, interval, trial_days, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    plan.id, plan.name, plan.price_cents, 'month', plan.trial_days, plan.created_at);
  return getPlan(ctx, plan.id);
}
// Price changes apply to future invoices only.
export function updatePlan(ctx, id, body) {
  const p = getPlan(ctx, id);
  const name = body.name !== undefined ? planName(body.name) : p.name;
  const liveAfter = body.active !== undefined ? !!body.active : p.active;
  if (liveAfter && liveNamed(ctx, name, id)) {
    throw conflict(name !== p.name ? `A plan called ${name} is already offered. Choose another name.` : `Another plan on offer is already called ${p.name}. Rename one of them first.`);
  }
  ctx.db.run('UPDATE plans SET name = ?, price_cents = ?, trial_days = ?, active = ? WHERE id = ?',
    name,
    body.price_cents !== undefined ? v.int(body.price_cents, 'price_cents', { min: 0, max: 10000000 }) : p.price_cents,
    body.trial_days !== undefined ? v.int(body.trial_days, 'trial_days', { min: 0, max: 90 }) : p.trial_days,
    body.active !== undefined ? !!body.active : p.active,
    id);
  return getPlan(ctx, id);
}

// ---- Subscriptions ----
export function getSubscription(ctx, id) {
  const s = ctx.db.get(
    `SELECT s.*, p.name AS plan_name, p.price_cents, c.name AS client_name, pp.name AS pending_plan_name, pp.price_cents AS pending_price_cents
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = s.client_id LEFT JOIN plans pp ON pp.id = s.pending_plan_id WHERE s.id = ?`, id);
  if (!s) throw notFound('Subscription');
  return s;
}
export function listSubscriptions(ctx, { status } = {}) {
  const base = `SELECT s.*, p.name AS plan_name, p.price_cents, c.name AS client_name
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = s.client_id`;
  return status
    ? ctx.db.all(`${base} WHERE s.status = ? ORDER BY s.created_at DESC`, status)
    : ctx.db.all(`${base} ORDER BY s.created_at DESC`);
}
export const currentSubscription = (ctx, clientId) => ctx.db.get(
  `SELECT id FROM subscriptions WHERE client_id = ? AND status != 'canceled' ORDER BY created_at DESC LIMIT 1`, clientId);

function setStatus(ctx, subId, status, extra = {}) {
  const before = ctx.db.get('SELECT status FROM subscriptions WHERE id = ?', subId).status;
  ctx.db.run('UPDATE subscriptions SET status = ?, canceled_at = COALESCE(?, canceled_at), updated_at = ? WHERE id = ?',
    status, extra.canceled_at ?? null, ctx.now(), subId);
  if (before !== status) {
    const s = getSubscription(ctx, subId);
    emit(ctx, 'subscription.updated', { subscription_id: s.id, client_id: s.client_id, client_name: s.client_name, plan_name: s.plan_name, status, previous_status: before });
  }
}

// Start a subscription. With a trial, nothing is charged until the trial ends.
export async function subscribe(ctx, clientId, planId, asOf = ctx.now()) {
  const plan = getPlan(ctx, planId);
  if (!plan.active) throw badRequest('That plan is no longer offered.');
  if (currentSubscription(ctx, clientId)) throw conflict('This client already has a subscription. Change its plan instead.');
  if (ctx.db.get('SELECT archived_at FROM clients WHERE id = ?', clientId)?.archived_at) throw conflict('This client is archived. Restore them on their client page first.');
  const trial = plan.trial_days > 0;
  const sub = {
    id: newId('sub'),
    status: trial ? 'trialing' : 'active',
    trial_ends_at: trial ? addDays(asOf, plan.trial_days) : null,
    start: asOf,
    end: trial ? addDays(asOf, plan.trial_days) : addMonths(asOf, 1)
  };
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO subscriptions (id, client_id, plan_id, status, trial_ends_at, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sub.id, clientId, planId, sub.status, sub.trial_ends_at, sub.start, sub.end, ctx.now(), ctx.now());
    const s = getSubscription(ctx, sub.id);
    emit(ctx, 'subscription.created', { subscription_id: s.id, client_id: clientId, client_name: s.client_name, plan_name: s.plan_name, status: s.status, trial_ends_at: s.trial_ends_at });
  });
  if (!trial) await invoiceAndCharge(ctx, sub.id, sub.start, sub.end, asOf);
  return getSubscription(ctx, sub.id);
}

// Changing a membership's plan (owner). when:
//   now:        the new plan starts today; nothing is charged now and the next renewal charges the new price.
//   renewal:    stays on the current plan until the membership renews, then moves (pending_plan_id; Cancel change undoes it).
//   difference: the new plan starts today and the price difference for the rest of this paid month is charged now to the
//               card on file, as its own invoice (a membership that is paid up only). A cheaper plan charges nothing.
// Any change made now clears a change waiting for the renewal. Returns the subscription and, for difference, the charge.
export const PLAN_CHANGE_WHEN = ['now', 'renewal', 'difference'];
const MIN_CHARGE_CENTS = 50;          // Stripe's smallest card charge
export async function changePlan(ctx, subId, planId, { when = 'now' } = {}) {
  if (!PLAN_CHANGE_WHEN.includes(when)) throw badRequest('when must be now, renewal or difference.');
  const s = getSubscription(ctx, subId);
  if (s.status === 'canceled') throw conflict('This subscription is canceled. Start a new one instead.');
  const plan = getPlan(ctx, planId);
  if (!plan.active) throw badRequest('That plan is no longer offered.');
  if (planId === s.plan_id && when !== 'renewal') throw conflict(`${s.client_name.split(' ')[0]} is already on ${plan.name}.`);
  if (when === 'renewal') {
    if (planId === s.plan_id) return cancelPendingPlan(ctx, subId);
    ctx.db.run('UPDATE subscriptions SET pending_plan_id = ?, pending_set_at = ?, updated_at = ? WHERE id = ?', planId, ctx.now(), ctx.now(), subId);
    const after = getSubscription(ctx, subId);
    emit(ctx, 'subscription.updated', { subscription_id: subId, client_id: s.client_id, client_name: s.client_name, plan_name: s.plan_name, status: s.status, pending_plan_name: plan.name, changes_on: s.current_period_end });
    return { subscription: after, when, charged: null };
  }
  let diff = 0;
  if (when === 'difference') {
    if (s.status !== 'active') throw conflict(s.status === 'trialing' ? 'Nothing has been charged yet during the free trial. Choose Start now: the trial ends on the new plan\'s price.'
      : s.status === 'past_due' ? 'This month\'s payment was declined. Collect it first, or choose Start now.' : 'A paused membership has no paid month to top up. Choose Start now or at renewal.');
    const total = Date.parse(s.current_period_end) - Date.parse(s.current_period_start), left = Date.parse(s.current_period_end) - Date.parse(ctx.now());
    diff = total > 0 && left > 0 ? Math.round(((plan.price_cents - s.price_cents) * left) / total) : 0;
  }
  ctx.db.run('UPDATE subscriptions SET plan_id = ?, pending_plan_id = NULL, pending_set_at = NULL, updated_at = ? WHERE id = ?', planId, ctx.now(), subId);
  const after = getSubscription(ctx, subId);
  emit(ctx, 'subscription.updated', { subscription_id: subId, client_id: s.client_id, client_name: s.client_name, plan_name: after.plan_name, status: after.status, previous_plan_name: s.plan_name });
  let charged = null;
  if (diff >= MIN_CHARGE_CENTS) {
    const id = newId('inv');
    ctx.db.run(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, created_at, note)
      VALUES (?, ?, ?, ?, 'open', ?, ?, 0, ?, ?)`, id, subId, s.client_id, diff, ctx.now(), s.current_period_end, ctx.now(), `Plan change: ${s.plan_name} to ${plan.name}, the rest of this month`);
    const inv = await attemptCharge(ctx, id, ctx.now());
    charged = { invoice_id: id, amount_cents: diff, status: inv.status, error: inv.status === 'paid' ? null : inv.last_error ?? null };
  }
  return { subscription: getSubscription(ctx, subId), when, charged, difference_cents: when === 'difference' ? diff : null };
}
export function cancelPendingPlan(ctx, subId) {
  const s = getSubscription(ctx, subId);
  if (!s.pending_plan_id) return { subscription: s, when: 'renewal', charged: null };
  ctx.db.run('UPDATE subscriptions SET pending_plan_id = NULL, pending_set_at = NULL, updated_at = ? WHERE id = ?', ctx.now(), subId);
  emit(ctx, 'subscription.updated', { subscription_id: subId, client_id: s.client_id, client_name: s.client_name, plan_name: s.plan_name, status: s.status, pending_plan_name: null });
  return { subscription: getSubscription(ctx, subId), when: 'renewal', charged: null };
}
// At a renewal (or a paused membership resuming), a plan change waiting for it takes effect before the new month is charged.
function applyPendingPlan(ctx, subId) {
  const s = ctx.db.get('SELECT s.pending_plan_id, s.plan_id, s.client_id, s.status, p.name AS plan_name, c.name AS client_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = s.client_id WHERE s.id = ?', subId);
  if (!s?.pending_plan_id) return;
  const next = ctx.db.get('SELECT name FROM plans WHERE id = ?', s.pending_plan_id);
  ctx.db.run('UPDATE subscriptions SET plan_id = COALESCE(?, plan_id), pending_plan_id = NULL, pending_set_at = NULL, updated_at = ? WHERE id = ?', next ? s.pending_plan_id : null, ctx.now(), subId);
  if (next) emit(ctx, 'subscription.updated', { subscription_id: subId, client_id: s.client_id, client_name: s.client_name, plan_name: next.name, status: s.status, previous_plan_name: s.plan_name });
}

export function pause(ctx, subId) {
  const s = getSubscription(ctx, subId);
  if (!['active', 'trialing'].includes(s.status)) throw conflict(`A ${s.status.replace('_', ' ')} subscription cannot be paused.`);
  setStatus(ctx, subId, 'paused');
  return getSubscription(ctx, subId);
}

// Resuming starts a fresh monthly period today and charges for it.
export async function resume(ctx, subId, asOf = ctx.now()) {
  const s = getSubscription(ctx, subId);
  if (s.status !== 'paused') throw conflict('Only a paused subscription can be resumed.');
  const end = addMonths(asOf, 1);
  ctx.db.run('UPDATE subscriptions SET current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?', asOf, end, ctx.now(), subId);
  applyPendingPlan(ctx, subId);
  setStatus(ctx, subId, 'active');
  await invoiceAndCharge(ctx, subId, asOf, end, asOf);
  return getSubscription(ctx, subId);
}

export function cancel(ctx, subId) {
  const s = getSubscription(ctx, subId);
  if (s.status === 'canceled') return s;
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE invoices SET status = 'void', next_retry_at = NULL WHERE subscription_id = ? AND status IN ('open','failed')`, subId);
    setStatus(ctx, subId, 'canceled', { canceled_at: ctx.now() });
  });
  return getSubscription(ctx, subId);
}

// ---- Invoices and charging ----
export function listInvoices(ctx, { clientId, status, limit = 100 } = {}) {
  const where = [], params = [];
  if (clientId) { where.push('i.client_id = ?'); params.push(clientId); }
  if (status) { where.push('i.status = ?'); params.push(status); }
  return ctx.db.all(
    `SELECT i.*, c.name AS client_name, p.name AS plan_name FROM invoices i
     JOIN clients c ON c.id = i.client_id JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.created_at DESC, i.rowid DESC LIMIT ?`, ...params, limit);
}
export function getInvoice(ctx, id) {
  const i = ctx.db.get(`SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`, id);
  if (!i) throw notFound('Invoice');
  return i;
}

async function invoiceAndCharge(ctx, subId, periodStart, periodEnd, asOf) {
  const s = getSubscription(ctx, subId);
  const id = newId('inv');
  ctx.db.run(
    `INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, 0, ?)`, id, subId, s.client_id, s.price_cents, periodStart, periodEnd, ctx.now());
  return attemptCharge(ctx, id, asOf);
}

// One charge or payment per invoice at a time: a retry waiting on Stripe and a pay link paid meanwhile can't both land.
// A retry the owner or a parent asks for (manual) never cancels the membership when it declines, leaves the next automatic
// retry where it was, and doesn't count toward the limit: only automatic charges (the first charge, the scheduled retries and
// the charge when a family saves a new card, counted in auto_attempts) count down to canceling after MAX_ATTEMPTS. attempts counts every try (Stripe's idempotency key).
// Every try is written to invoice_charges before Stripe is asked, with its id in the charge's metadata, so a late answer
// from the bank always finds its invoice (reconcile below).
export function attemptCharge(ctx, invoiceId, asOf = ctx.now(), opts = {}) { return withLock(`invoice:${invoiceId}`, () => chargeInvoice(ctx, invoiceId, asOf, opts)); }
// source: 'automatic' (the first charge and the scheduled retries), 'new_card' (a family saved a new card: counts like an
// automatic try, as the owner decided), 'owner' (Retry or Retry all) or 'parent' (the portal's Try again). The owner's and
// a parent's are manual tries. manual: true alone means the owner's.
const SOURCES = ['automatic', 'new_card', 'owner', 'parent'];
async function chargeInvoice(ctx, invoiceId, asOf, { manual: manualOpt = false, source: sourceOpt = null, onlyIfFailed = false } = {}) {
  const source = SOURCES.includes(sourceOpt) ? sourceOpt : manualOpt ? 'owner' : 'automatic';
  const manual = source === 'owner' || source === 'parent';
  const inv = getInvoice(ctx, invoiceId);
  if (inv.status === 'paid') return inv;
  // A retry picked from a list: the invoice may have been voided or paid by hand since it was listed. Nothing to do.
  if (onlyIfFailed && inv.status !== 'failed') return inv;
  if (inv.status === 'void') throw conflict('This invoice was voided and cannot be charged.');
  const client = payerFor(ctx, inv.client_id);          // a family's card pays for its athletes
  // A try the webhook settled after its call errored (or a charge left waiting) has used its idempotency key at Stripe, so
  // the next try goes past it (the same key with a new try's metadata would be refused by Stripe).
  const settled = ctx.db.get(`SELECT MAX(attempt) AS n FROM invoice_charges WHERE invoice_id = ? AND status IN ('succeeded','declined')`, inv.id)?.n ?? 0;
  const attempts = Math.max(inv.attempts, settled) + 1;
  const autoAttempts = manual ? inv.auto_attempts : inv.auto_attempts + 1;
  let attemptId = null, result;
  if (inv.amount_cents === 0) result = { ok: true, ref: null };
  else {
    // A try whose call to Stripe errored before an answer came back is tried again with the same idempotency key, so it
    // reuses that row (Stripe needs the same metadata with the same key, and returns the first charge if it went through).
    const errored = ctx.db.get(`SELECT id FROM invoice_charges WHERE invoice_id = ? AND attempt = ? AND status IN ('error','pending') ORDER BY created_at DESC LIMIT 1`, inv.id, attempts);
    attemptId = errored?.id ?? newId('ich');
    if (errored) ctx.db.run(`UPDATE invoice_charges SET status = 'pending', manual = ?, source = ?, error = NULL, settled_at = NULL WHERE id = ?`, manual ? 1 : 0, source, attemptId);
    else ctx.db.run(`INSERT INTO invoice_charges (id, invoice_id, attempt, manual, source, amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`, attemptId, inv.id, attempts, manual ? 1 : 0, source, inv.amount_cents, ctx.now());
    try {
      result = await ctx.payments.chargeSaved({ client, amountCents: inv.amount_cents, description: 'Diamond Protocol membership', idempotencyKey: `${inv.id}:${attempts}`, metadata: { invoice_id: inv.id, charge_attempt_id: attemptId } });
    } catch (e) {
      ctx.db.run(`UPDATE invoice_charges SET status = 'error', error = ?, settled_at = ? WHERE id = ?`, String(e.message ?? e).slice(0, 300), ctx.now(), attemptId);
      throw e;
    }
  }

  ctx.db.tx(() => {
    const s = getSubscription(ctx, inv.subscription_id);
    // A payment Stripe is still processing counts as paid but stays 'pending' (waiting on the bank) until its webhook: only
    // a charge the bank confirmed is final, so a failure event arriving after it (out of order) is stale (reconcile).
    if (attemptId) ctx.db.run(`UPDATE invoice_charges SET status = ?, ref = COALESCE(?, ref), error = ?, settled_at = ? WHERE id = ?`, result.ok ? (result.processing ? 'pending' : 'succeeded') : 'declined', result.ref ?? null, result.ok ? null : result.error ?? null, result.processing ? null : ctx.now(), attemptId);
    if (result.ok) {
      recordPaid(ctx, inv, s, { attempts, autoAttempts, ref: result.ref });
    } else {
      const giveUp = !manual && autoAttempts >= MAX_ATTEMPTS;
      const nextRetry = giveUp ? null : manual && inv.next_retry_at ? inv.next_retry_at : addDays(asOf, RETRY_EVERY_DAYS);
      ctx.db.run(`UPDATE invoices SET status = 'failed', attempts = ?, auto_attempts = ?, last_error = ?, next_retry_at = ?, payment_ref = COALESCE(?, payment_ref) WHERE id = ?`,
        attempts, autoAttempts, result.error, nextRetry, result.ref ?? null, inv.id);
      emit(ctx, 'invoice.payment_failed', { invoice_id: inv.id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: inv.amount_cents, attempts, automatic_attempts: autoAttempts, manual, source, error: result.error, final: giveUp });
      if (giveUp) {
        ctx.db.run(`UPDATE invoices SET status = 'void' WHERE id = ?`, inv.id);
        setStatus(ctx, s.id, 'canceled', { canceled_at: ctx.now() });
      } else if (s.status !== 'canceled') {
        setStatus(ctx, s.id, 'past_due');
      }
    }
  });
  if (result.ok) await membershipReceipt(ctx, inv.id);
  else await paymentFailed(ctx, inv.id);
  return getInvoice(ctx, inv.id);
}

function recordPaid(ctx, inv, s, { attempts = inv.attempts, autoAttempts = inv.auto_attempts, ref, method = null, reference = null }) {
  // A payment recorded by hand keeps the last card charge's reference (every charge's is also in invoice_charges).
  ctx.db.run(`UPDATE invoices SET status = 'paid', attempts = ?, auto_attempts = ?, paid_at = ?, payment_ref = ${method ? 'payment_ref' : '?'}, paid_method = ?, paid_reference = ?, last_error = NULL, next_retry_at = NULL, voided_at = NULL, void_reason = NULL WHERE id = ?`,
    ...[attempts, autoAttempts, ctx.now(), ...(method ? [] : [ref]), method, reference, inv.id]);
  emit(ctx, 'invoice.paid', { invoice_id: inv.id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: inv.amount_cents });
  // Past due stays past due while another of its charges is still declined (so that one keeps being retried and reminded).
  if (s.status === 'trialing' || (s.status === 'past_due' && !ctx.db.get(`SELECT 1 FROM invoices WHERE subscription_id = ? AND status = 'failed' AND id != ?`, s.id, inv.id))) setStatus(ctx, s.id, 'active');
}
// A parent paid a failed or open invoice some other way (a pay link). Returns false if it was already paid or voided.
export function markInvoicePaid(ctx, invoiceId, ref, opts = {}) { return withLock(`invoice:${invoiceId}`, () => recordInvoicePayment(ctx, invoiceId, ref, opts)); }
async function recordInvoicePayment(ctx, invoiceId, ref, { how } = {}) {
  const inv = getInvoice(ctx, invoiceId);
  if (!['failed', 'open'].includes(inv.status)) return false;
  ctx.db.tx(() => recordPaid(ctx, inv, getSubscription(ctx, inv.subscription_id), { ref }));
  await membershipReceipt(ctx, inv.id, { how });
  return true;
}
// A family just saved a new card: charge any membership payment that failed, now, instead of waiting for the next retry.
export async function retryWithNewCard(ctx, { familyId, clientId }) {
  const rows = ctx.db.all(`SELECT i.id FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id JOIN clients c ON c.id = i.client_id
    WHERE i.status = 'failed' AND i.next_retry_at IS NOT NULL AND s.status = 'past_due' AND ${familyId ? 'c.family_id = ?' : 'c.id = ?'}`, familyId ?? clientId);
  const out = [];
  for (const r of rows) out.push(await attemptCharge(ctx, r.id, ctx.now(), { source: 'new_card', onlyIfFailed: true }));
  return out;
}

// Stripe webhook: a membership charge settled differently from what the charge call said. A card the bank asked the
// client to approve can succeed later, and a payment still processing can fail later. The charge is found among the
// invoice's tries (invoice_charges) by Stripe's id, or by the try's id in its metadata when the call errored before an id
// came back; an invoice from before version 43 matches its payment_ref as before.
// - Approved while the invoice is still owed: this charge pays it.
// - Approved after the invoice was paid another way (a pay link, cash or check, another charge) or voided: the money goes
//   back automatically, exactly once (under the invoice lock, the try's late_outcome is checked first, and Stripe's
//   idempotency key is fixed per charge), and the owner is emailed, sees it on Today and in the activity feed.
// - Failed after it was counted as paid: the invoice is owed again, as before.
export function reconcileInvoicePayment(ctx, invoiceId, outcome) { return withLock(`invoice:${invoiceId}`, () => reconcile(ctx, invoiceId, outcome)); }
async function reconcile(ctx, invoiceId, { ref, succeeded, error, attemptId }) {
  const inv = ctx.db.get(`SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`, invoiceId);
  if (!inv || !ref) return 'ignored';
  let a = ctx.db.get('SELECT * FROM invoice_charges WHERE invoice_id = ? AND ref = ?', inv.id, ref)
    ?? (attemptId ? ctx.db.get('SELECT * FROM invoice_charges WHERE id = ? AND invoice_id = ?', String(attemptId), inv.id) : null);
  if (a && a.ref && a.ref !== ref) return 'ignored';                   // the try's id with somebody else's payment
  if (!a && inv.payment_ref === ref) {
    // A charge from before every try was written down: add it now so it's matched (and refunded) only once.
    const id = newId('ich');
    ctx.db.run(`INSERT INTO invoice_charges (id, invoice_id, attempt, manual, source, amount_cents, ref, status, created_at, settled_at) VALUES (?, ?, ?, 0, 'automatic', ?, ?, ?, ?, ?)`,
      id, inv.id, inv.attempts, inv.amount_cents, ref, inv.status === 'paid' && !inv.paid_method ? 'pending' : 'declined', inv.created_at, ctx.now());   // pending: it may still have been processing
    a = ctx.db.get('SELECT * FROM invoice_charges WHERE id = ?', id);
  }
  if (!a) return 'ignored';
  if (!a.ref) ctx.db.run('UPDATE invoice_charges SET ref = ? WHERE id = ?', ref, a.id);

  if (succeeded) {
    if (a.late_outcome === 'refunded') return 'refunded';              // already sent back: a repeated event changes nothing
    if (a.status !== 'succeeded') ctx.db.run(`UPDATE invoice_charges SET status = 'succeeded', error = NULL, settled_at = ? WHERE id = ?`, ctx.now(), a.id);
    if (['failed', 'open'].includes(inv.status)) {
      ctx.db.tx(() => recordPaid(ctx, inv, getSubscription(ctx, inv.subscription_id), { ref }));
      await membershipReceipt(ctx, inv.id);
      return 'paid';
    }
    if (inv.status === 'paid' && !inv.paid_method && inv.payment_ref === ref) return 'unchanged';   // the payment itself
    return refundLateCharge(ctx, inv, { ...a, ref });
  }
  // Stripe doesn't promise the order of events, and a PaymentIntent that succeeded never fails afterwards: a failure event
  // for a charge the bank confirmed is an older one arriving late, and changes nothing (the invoice stays paid).
  if (a.status === 'succeeded') return 'unchanged';
  if (a.status === 'pending' || a.status === 'error') ctx.db.run(`UPDATE invoice_charges SET status = 'declined', error = ?, settled_at = ? WHERE id = ?`, error || 'The payment failed after it was taken.', ctx.now(), a.id);
  if (inv.status === 'paid' && !inv.paid_method && inv.payment_ref === ref && !inv.refunded_cents) {
    const giveUp = inv.auto_attempts >= MAX_ATTEMPTS;
    ctx.db.tx(() => {
      ctx.db.run(`UPDATE invoices SET status = 'failed', paid_at = NULL, last_error = ?, next_retry_at = ? WHERE id = ?`,
        error || 'The payment failed after it was taken.', giveUp ? null : addDays(ctx.now(), RETRY_EVERY_DAYS), inv.id);
      emit(ctx, 'invoice.payment_failed', { invoice_id: inv.id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: inv.amount_cents, attempts: inv.attempts, automatic_attempts: inv.auto_attempts, error, final: giveUp });
      const s = getSubscription(ctx, inv.subscription_id);
      if (giveUp) { ctx.db.run(`UPDATE invoices SET status = 'void' WHERE id = ?`, inv.id); setStatus(ctx, s.id, 'canceled', { canceled_at: ctx.now() }); }
      else if (s.status !== 'canceled') setStatus(ctx, s.id, 'past_due');
    });
    await paymentFailed(ctx, inv.id);
    return 'failed';
  }
  return 'unchanged';
}
const LATE_REASON = {
  hand: (inv) => `it had already been paid by ${(HAND_METHODS[inv.paid_method] ?? 'hand').toLowerCase()}`,
  other: () => 'it had already been paid another way (a pay link or another charge)',
  void: () => 'the invoice had been voided'
};
// Called under the invoice lock. A try refunded before (or refused by Stripe before) is asked again with the same key,
// so Stripe never sends the money back twice.
async function refundLateCharge(ctx, inv, a) {
  const why = inv.status === 'void' ? 'void' : inv.paid_method ? 'hand' : 'other';
  const reason = LATE_REASON[why](inv);
  const r = await ctx.payments.refund({ paymentRef: a.ref, amountCents: a.amount_cents, idempotencyKey: `invoice-paid-twice-${inv.id}-${a.ref}` });
  // The owner hears once per outcome: a repeated event that finds the refund still refused changes nothing they need to know.
  if (!r.ok && a.late_outcome === 'refund_failed') {
    ctx.db.run('UPDATE invoice_charges SET refund_error = ? WHERE id = ?', String(r.error ?? 'Refund failed').slice(0, 300), a.id);
    return 'paid_twice';
  }
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE invoice_charges SET late_outcome = ?, late_reason = ?, late_at = COALESCE(late_at, ?), refund_ref = ?, refund_error = ? WHERE id = ?`,
      r.ok ? 'refunded' : 'refund_failed', reason, ctx.now(), r.ok ? r.ref ?? null : null, r.ok ? null : String(r.error ?? 'Refund failed').slice(0, 300), a.id);
    emit(ctx, 'invoice.paid_twice', { invoice_id: inv.id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: a.amount_cents, payment_ref: a.ref, reason: why, refunded: !!r.ok, error: r.ok ? null : r.error });
  });
  const what = `A ${money(a.amount_cents)} membership charge for ${inv.client_name} was approved by the bank after ${reason}.`;
  for (const o of ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`)) {
    sendEmail(ctx, { to: o.email, subject: r.ok ? `Refunded a late card charge: ${money(a.amount_cents)} for ${inv.client_name}` : `Refund needed: ${money(a.amount_cents)} charged twice for ${inv.client_name}`,
      text: `${what}\n\n${r.ok ? `The ${money(a.amount_cents)} was refunded to the card automatically. Nothing else to do; it's on Today until you mark it handled.` : `The automatic refund didn't work (${r.error}). Refund payment ${a.ref} in the Stripe dashboard, then mark it handled on Today.`}\n\nInvoice: ${inv.id}` }).catch(() => {});
  }
  return r.ok ? 'refunded' : 'paid_twice';
}
// The owner saw a late charge alert on Today and dealt with it.
export function markLateChargeHandled(ctx, invoiceId, chargeId, actor) {
  const a = ctx.db.get('SELECT * FROM invoice_charges WHERE id = ? AND invoice_id = ?', chargeId, invoiceId);
  if (!a || !a.late_outcome) throw notFound('Late charge');
  ctx.db.run('UPDATE invoice_charges SET handled_at = COALESCE(handled_at, ?), handled_by = COALESCE(handled_by, ?) WHERE id = ?', ctx.now(), actor?.name ?? 'Owner', a.id);
  return { id: a.id, handled: true };
}
// Late charges refunded (or needing a refund) that the owner hasn't marked handled, for Today.
export function lateChargeAlerts(ctx) {
  return ctx.db.all(`SELECT a.id AS charge_id, a.invoice_id, a.amount_cents, a.ref, a.late_outcome, a.late_reason, a.late_at, a.refund_error, i.client_id, c.name
    FROM invoice_charges a JOIN invoices i ON i.id = a.invoice_id JOIN clients c ON c.id = i.client_id
    WHERE a.late_outcome IS NOT NULL AND a.handled_at IS NULL ORDER BY a.late_at`);
}

// Manual retry from the dashboard or API. A family with no card is refused before anything is tried (a try with no card
// would only use up a retry). membership_reactivated says whether this brought a past-due membership back.
// by: 'owner' (dashboard or API) or 'parent' (the portal): both are manual tries.
export async function retryInvoice(ctx, invoiceId, { by = 'owner' } = {}) {
  const inv = getInvoice(ctx, invoiceId);
  if (inv.status !== 'failed') throw conflict(inv.status === 'paid' ? 'This invoice is already paid.' : 'Only a failed invoice can be retried.');
  const payer = payerFor(ctx, inv.client_id);
  if (!payer.card_payment_method) throw conflict(`There's no card on file for ${payer.table === 'families' ? 'this family' : inv.client_name.split(' ')[0]}. Send a card reminder or a pay link, or record a cash or check payment.`);
  const before = getSubscription(ctx, inv.subscription_id).status;
  const out = await attemptCharge(ctx, invoiceId, ctx.now(), { source: by === 'parent' ? 'parent' : 'owner' });
  return { ...out, membership_reactivated: before === 'past_due' && getSubscription(ctx, inv.subscription_id).status === 'active' };
}

// The billing clock. Runs hourly in the server; in test mode it can also be run for a future date.
// 1. Trials and paid periods that have ended are renewed: a new invoice is created and charged.
// 2. Failed invoices whose retry date has arrived are charged again.
export async function runBilling(ctx, asOf = ctx.now()) {
  const summary = { as_of: asOf, renewed: 0, paid: 0, failed: 0, retried: 0, canceled: 0 };
  summary.trial_reminders = await trialReminders(ctx, asOf);
  const count = (inv) => { if (inv.status === 'paid') summary.paid++; else summary.failed++; };

  for (let guard = 0; guard < 24; guard++) {
    const due = ctx.db.all(`SELECT id, current_period_end FROM subscriptions WHERE status IN ('trialing','active') AND current_period_end <= ?`, asOf);
    if (!due.length) break;
    for (const s of due) {
      const start = s.current_period_end, end = addMonths(start, 1);
      ctx.db.run('UPDATE subscriptions SET current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?', start, end, ctx.now(), s.id);
      applyPendingPlan(ctx, s.id);
      summary.renewed++;
      count(await invoiceAndCharge(ctx, s.id, start, end, asOf));
    }
  }

  const retries = ctx.db.all(
    `SELECT i.id FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
     WHERE i.status = 'failed' AND i.next_retry_at IS NOT NULL AND i.next_retry_at <= ? AND s.status = 'past_due'
       AND NOT EXISTS (SELECT 1 FROM pay_links p WHERE p.invoice_id = i.id AND p.status = 'open' AND p.checkout_started_at > ?)`, asOf, new Date(Date.parse(asOf) - 3600000).toISOString());   // a parent is paying by link right now
  for (const r of retries) {
    summary.retried++;
    const tries = getInvoice(ctx, r.id).attempts;
    const inv = await attemptCharge(ctx, r.id, asOf, { onlyIfFailed: true });
    if (inv.attempts === tries) { summary.retried--; continue; }      // voided or paid another way since it was listed
    count(inv);
    if (inv.status === 'void') summary.canceled++;
  }
  return summary;
}

// =====================================================================================================================
// Billing screen (batch B6): the money summary, what needs attention, every invoice, refunds, voids and memberships.
// Owner only (security.js: /v1/billing, /v1/invoices, /v1/subscriptions and /v1/plans changes).
// =====================================================================================================================

// ---------- Money in ----------
// What came in between two moments, net of refunds, the same way everywhere (Today's "Collected this month", Billing's
// summary and the Monday owner summary): counter and online sales paid in the window minus sale refunds made in it (a
// refund counts on the day the money went back, like the day's takings), membership payments minus membership refunds
// made in the window, and school invoices paid (paid_on is a date).
export function moneyIn(ctx, from, to) {
  const db = ctx.db;
  const sales = db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c, COUNT(*) AS n FROM sales WHERE status IN ('succeeded','partially_refunded','refunded') AND completed_at >= ? AND completed_at < ?`, from, to);
  const saleRefunds = db.get('SELECT COALESCE(SUM(amount_cents), 0) AS c, COUNT(*) AS n FROM sale_refunds WHERE created_at >= ? AND created_at < ?', from, to);
  const members = db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c, COUNT(*) AS n FROM invoices WHERE status = 'paid' AND amount_cents > 0 AND paid_at >= ? AND paid_at < ?`, from, to);
  const memberRefunds = db.get('SELECT COALESCE(SUM(amount_cents), 0) AS c, COUNT(*) AS n FROM invoice_refunds WHERE created_at >= ? AND created_at < ?', from, to);
  // A school invoice's paid_on is a business-local date: it counts when that day's midnight falls in the window, so one
  // paid today is in "this month" and "today", and back-to-back windows never count a day twice.
  const teams = db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c, COUNT(*) AS n FROM team_invoices WHERE status = 'paid' AND paid_on >= ? AND paid_on < ?`, firstDayFrom(ctx, from), firstDayFrom(ctx, to));
  const out = { sales: sales.c - saleRefunds.c, members: members.c - memberRefunds.c, teams: teams.c };
  return { total: out.sales + out.members + out.teams, ...out,
    taken_cents: sales.c + members.c + teams.c, refunded_cents: saleRefunds.c + memberRefunds.c, sale_refunds_cents: saleRefunds.c, member_refunds_cents: memberRefunds.c,
    payments: sales.n + members.n + teams.n, refunds: saleRefunds.n + memberRefunds.n, sales_count: sales.n };
}
// The first business-local date whose midnight is at or after the moment.
function firstDayFrom(ctx, iso) {
  const z = zone(ctx), day = localDate(iso, z);
  return startOfLocalDay(iso, z) === new Date(iso).toISOString() ? day : addDaysToDate(day, 1);
}
// Today, midnight to midnight in the business time zone, exactly as the day's takings count it (a day can be 23 or 25 hours).
export function todayBounds(ctx) {
  const z = zone(ctx), day = bizToday(ctx);
  return { from: startOfLocalDay(zonedToUtc(day, '12:00', z), z), to: startOfLocalDay(zonedToUtc(addDaysToDate(day, 1), '12:00', z), z) };
}
// The start of this month (the 1st, midnight in the business time zone) and today.
function bounds(ctx) {
  const z = zone(ctx), today = bizToday(ctx);
  return { today, monthStart: startOfLocalDay(zonedToUtc(`${today.slice(0, 8)}01`, '12:00', z), z), day: todayBounds(ctx) };
}
const cardSql = (c = 'c', f = 'f') => `CASE WHEN ${c}.family_id IS NOT NULL THEN ${f}.card_last4 ELSE ${c}.card_last4 END`;
const brandSql = (c = 'c', f = 'f') => `CASE WHEN ${c}.family_id IS NOT NULL THEN ${f}.card_brand ELSE ${c}.card_brand END`;

// ---------- Invoices: memberships and school invoices together ----------
export const INVOICE_VIEWS = { all: 'All', failed: 'Failed', unpaid: 'Unpaid', overdue: 'Overdue', paid: 'Paid', refunds: 'Refunds', void: 'Void' };
export const INVOICE_KINDS = { membership: 'Membership', school: 'School invoice' };
const VIEW_SQL = {
  all: '1 = 1', failed: `state = 'failed'`, unpaid: `state IN ('failed','open','overdue')`, overdue: `state = 'overdue'`,
  paid: `state IN ('paid','partially_refunded','refunded')`, refunds: 'refunded_cents > 0', void: `state = 'void'`
};
// One row per invoice. A school invoice's date is the day it was issued; a membership's is when it was made, in the
// business time zone. state: failed, open, overdue (a school invoice past its due date), paid, partially_refunded, refunded, void.
function invoiceRows(ctx, { from, to } = {}) {
  const z = zone(ctx);
  const mDate = [], sDate = [];
  if (from) { mDate.push('i.created_at >= ?'); sDate.push('t.issued_on >= ?'); }
  if (to) { mDate.push('i.created_at < ?'); sDate.push('t.issued_on <= ?'); }
  const mArgs = [...(from ? [startOfLocalDay(zonedToUtc(from, '12:00', z), z)] : []), ...(to ? [startOfLocalDay(zonedToUtc(addDaysToDate(to, 1), '12:00', z), z)] : [])];
  const sArgs = [...(from ? [from] : []), ...(to ? [to] : [])];
  const sql = `WITH rows AS (
    SELECT 'membership' AS kind, i.id, NULL AS number, i.client_id, c.name AS client_name, c.family_id, c.archived_at AS client_archived_at,
      NULL AS contract_id, NULL AS org_name, COALESCE(i.note, p.name) AS description, i.amount_cents, i.refunded_cents, i.status, i.created_at AS issued_at, NULL AS due_on,
      i.paid_at, i.paid_method, i.paid_reference, i.attempts, i.auto_attempts, i.next_retry_at, i.last_error, i.reminded_at, i.voided_at, i.void_reason, i.period_start, i.period_end,
      s.id AS subscription_id, s.status AS subscription_status, ${cardSql()} AS card_last4, ${brandSql()} AS card_brand,
      CASE WHEN i.status IN ('failed','open','void') THEN i.status WHEN i.amount_cents > 0 AND i.refunded_cents >= i.amount_cents THEN 'refunded'
        WHEN i.refunded_cents > 0 THEN 'partially_refunded' ELSE 'paid' END AS state, i.created_at AS sort_at
    FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN families f ON f.id = c.family_id JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
    ${mDate.length ? `WHERE ${mDate.join(' AND ')}` : ''}
    UNION ALL
    SELECT 'school', t.id, t.number, NULL, NULL, NULL, NULL, t.contract_id, o.name, tc.name, t.amount_cents, 0, t.status, t.issued_on, t.due_on,
      t.paid_on, t.paid_method, t.paid_reference, 0, 0, NULL, NULL, t.reminded_at, NULL, NULL, t.period_start, t.period_end,
      NULL, NULL, NULL, NULL,
      CASE WHEN t.status = 'open' AND t.due_on < ? THEN 'overdue' ELSE t.status END, t.issued_on || 'T23:59:59.999Z'
    FROM team_invoices t JOIN team_contracts tc ON tc.id = t.contract_id JOIN organizations o ON o.id = t.org_id
    ${sDate.length ? `WHERE ${sDate.join(' AND ')}` : ''})`;
  return { sql, params: [...mArgs, bizToday(ctx), ...sArgs] };
}
function invoiceFilter(query = {}) {
  const view = query.view || query.status || 'all';
  if (!VIEW_SQL[view]) throw badRequest(`Choose one of the invoice views: ${Object.keys(VIEW_SQL).join(', ')}.`);
  const kind = query.kind || '';
  if (kind && !INVOICE_KINDS[kind]) throw badRequest('Choose memberships or school invoices, or leave the kind blank for both.');
  for (const [k, label] of [['from', 'start'], ['to', 'end']]) if (query[k] && !isDate(String(query[k]))) throw badRequest(`Choose a real ${label} date, like 2026-09-01.`);
  if (query.from && query.to && String(query.from) > String(query.to)) throw badRequest('The start date is after the end date. Swap them.');
  const where = [VIEW_SQL[view]], params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (query.client_id) { where.push('client_id = ?'); params.push(String(query.client_id)); }
  const q = String(query.q ?? '').trim().toLowerCase().slice(0, 100);
  if (q) {
    where.push(`(instr(lower(COALESCE(client_name, '')), ?) > 0 OR instr(lower(COALESCE(description, '')), ?) > 0 OR instr(lower(COALESCE(org_name, '')), ?) > 0
      OR instr(lower(COALESCE(number, '')), ?) > 0 OR instr(lower(id), ?) > 0)`);
    params.push(q, q, q, q, q);
  }
  return { view, kind, from: query.from ? String(query.from) : null, to: query.to ? String(query.to) : null, where: where.join(' AND '), params, q };
}
const withFlags = (r) => ({ ...r, overdue: r.state === 'overdue', retries_left: r.state === 'failed' ? Math.max(0, MAX_ATTEMPTS - r.auto_attempts) : null, has_card: r.kind === 'membership' ? !!r.card_last4 : null });

// GET /v1/billing/invoices: ?view= (all, failed, unpaid, overdue, paid, refunds, void), ?kind= (membership, school),
// ?from=/?to= (dates), ?q= (name, plan, school, team or invoice number), ?limit= (Show more). Returns the page, the count and
// totals for the whole filter, and the count in each view (for the view buttons) with the same kind, dates and search.
export function listBillingInvoices(ctx, query = {}) {
  const f = invoiceFilter(query);
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
  const { sql, params } = invoiceRows(ctx, f);
  const data = ctx.db.all(`${sql} SELECT * FROM rows WHERE ${f.where} ORDER BY sort_at DESC, id DESC LIMIT ?`, ...params, ...f.params, limit).map(withFlags);
  const t = ctx.db.get(`${sql} SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c, COALESCE(SUM(refunded_cents), 0) AS r FROM rows WHERE ${f.where}`, ...params, ...f.params);
  // Counts per view with everything but the view applied.
  const base = invoiceFilter({ ...query, view: 'all', status: undefined });
  const counts = {};
  for (const [view, cond] of Object.entries(VIEW_SQL)) counts[view] = ctx.db.get(`${sql} SELECT COUNT(*) AS n FROM rows WHERE ${cond} AND ${base.where}`, ...params, ...base.params).n;
  return { data, total: t.n, total_cents: t.c, refunded_cents: t.r, limit, view: f.view, counts };
}

// The same filter as a spreadsheet for the bookkeeper: amounts as plain numbers (dollars), text a spreadsheet would run as a
// formula made safe (clients.csvCell). Each refund is its own row (negative, dated when the money went back).
export function exportBillingInvoices(ctx, query = {}) {
  const f = invoiceFilter(query);
  const { sql, params } = invoiceRows(ctx, f);
  const rows = ctx.db.all(`${sql} SELECT * FROM rows WHERE ${f.where} ORDER BY sort_at DESC, id DESC LIMIT 20000`, ...params, ...f.params);
  const z = zone(ctx);
  const day = (iso) => (!iso ? '' : /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : localDate(iso, z));
  const dollars = (c) => (c / 100).toFixed(2);
  const STATE = { failed: 'Failed', open: 'Open', overdue: 'Overdue', paid: 'Paid', partially_refunded: 'Part refunded', refunded: 'Refunded', void: 'Void' };
  const SCHOOL_PAID = { check: 'Check', ach: 'Bank transfer', card: 'Card', cash: 'Cash', other: 'Other', online: 'Online' };
  const paidBy = (r) => (!['paid', 'partially_refunded', 'refunded'].includes(r.state) ? '' : r.kind === 'school' ? (SCHOOL_PAID[r.paid_method] ?? r.paid_method ?? '') : HAND_METHODS[r.paid_method] ?? 'Card');
  const head = ['Invoice', 'Date', 'Kind', 'Client or school', 'For', 'Period', 'Amount', 'Refunded', 'Status', 'Due', 'Paid on', 'Paid by', 'Reference', 'Refund reason'];
  const lines = [];
  const refundsOf = (id) => ctx.db.all('SELECT amount_cents, reason, created_at FROM invoice_refunds WHERE invoice_id = ? ORDER BY created_at, rowid', id);
  for (const r of rows) {
    const who = r.kind === 'school' ? r.org_name : r.client_name;
    const period = r.period_start ? `${day(r.period_start)} to ${day(r.period_end)}` : '';
    lines.push([r.number ?? r.id, day(r.issued_at), INVOICE_KINDS[r.kind], who, r.description, period, dollars(r.amount_cents), r.refunded_cents ? dollars(r.refunded_cents) : '',
      STATE[r.state] ?? r.state, r.due_on ?? '', day(r.paid_at), paidBy(r), r.paid_reference ?? '', '']);
    if (r.kind === 'membership' && r.refunded_cents) {
      for (const x of refundsOf(r.id)) lines.push([`${r.id} refund`, day(x.created_at), 'Refund', who, r.description, period, dollars(-x.amount_cents), '', 'Refund', '', day(x.created_at), HAND_METHODS[r.paid_method] ?? 'Card', '', x.reason ?? '']);
    }
  }
  const body = [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n');
  return { filename: `invoices-${bizToday(ctx)}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(`﻿${body}\r\n`), count: rows.length };
}

// ---------- One membership invoice, with the actions that fit its state ----------
export function invoiceDetail(ctx, id) {
  getInvoice(ctx, id);
  const { sql, params } = invoiceRows(ctx);
  const r = withFlags(ctx.db.get(`${sql} SELECT * FROM rows WHERE kind = 'membership' AND id = ?`, ...params, id));
  const payer = payerFor(ctx, r.client_id);
  const refunds = ctx.db.all(`SELECT x.id, x.amount_cents, x.reason, x.source, x.created_at, u.name AS by_name FROM invoice_refunds x LEFT JOIN users u ON u.id = x.created_by WHERE x.invoice_id = ? ORDER BY x.created_at, x.rowid`, id);
  // Every card charge tried (manual = a retry the owner or a parent started, which doesn't count toward canceling; source
  // says which), with any late
  // approval that was refunded automatically.
  const charges = ctx.db.all(`SELECT id, attempt, manual, source, amount_cents, ref, status, error, created_at, settled_at, late_outcome, late_reason, late_at, refund_error, handled_at
    FROM invoice_charges WHERE invoice_id = ? ORDER BY created_at, rowid`, id).map((c) => ({ ...c, manual: !!c.manual }));
  const links = ctx.db.all(`SELECT id, status, amount_cents, sent_to, sent_at, paid_at, expires_at, created_at FROM pay_links WHERE invoice_id = ? ORDER BY created_at DESC`, id)
    .map((l) => ({ ...l, status: l.status === 'open' && l.expires_at <= ctx.now() ? 'expired' : l.status }));
  const owed = ['failed', 'open'].includes(r.status);
  const refundable = r.status === 'paid' ? Math.max(0, r.amount_cents - r.refunded_cents) : 0;
  const remindedToday = remindedTodayFor(ctx, r.client_id);
  const emails = recipientsFor(ctx, r.client_id);
  return {
    ...r, refunds, charges, pay_links: links, refundable_cents: refundable,
    card: payer.card_last4 ? { brand: payer.card_brand, last4: payer.card_last4, declining: payer.card_status === 'declining' } : null,
    email: emails[0] ?? null, paid_by: r.status === 'paid' ? (HAND_METHODS[r.paid_method] ?? 'Card') : null,
    reminded_today: remindedToday,
    can: {
      retry: r.status === 'failed' && !!payer.card_payment_method && r.subscription_status !== 'canceled',
      record_payment: owed, remind: r.status === 'failed' && emails.length > 0 && !remindedToday && !r.client_archived_at, pay_link: owed,
      refund: refundable > 0, void: owed
    }
  };
}

// ---------- Refund all or part of a paid membership payment ----------
// Exactly once: one action per invoice at a time (the invoice lock, shared with charges, retries, pay links, voids and
// Stripe's webhooks), the provider's idempotency key is the invoice's new refunded total, and it never refunds more than
// was paid. A card payment goes back to the card; one recorded by hand (cash, check) is only logged, to hand back yourself.
// The membership itself carries on: cancel it separately if they're leaving.
export function refundInvoice(ctx, id, body = {}, { actor } = {}) { return withLock(`invoice:${id}`, () => refundInvoiceNow(ctx, id, body, actor)); }
async function refundInvoiceNow(ctx, id, body, actor) {
  const inv = getInvoice(ctx, id);
  if (inv.status !== 'paid') throw conflict(inv.status === 'void' ? 'This invoice was voided, so nothing was paid to refund.' : 'Only a paid invoice can be refunded. Void it instead if it shouldn\'t be collected.');
  const remaining = inv.amount_cents - inv.refunded_cents;
  if (remaining <= 0) throw conflict(inv.amount_cents ? 'This invoice has already been refunded in full.' : 'Nothing was charged for this invoice.');
  let amount = remaining;
  if (body.amount_cents !== undefined && body.amount_cents !== null && body.amount_cents !== '') {
    amount = Number(body.amount_cents);
    if (!Number.isInteger(amount) || amount < 1) throw badRequest('Enter the amount to refund in whole cents, more than $0.');
    if (amount > remaining) throw badRequest(`You can refund up to ${money(remaining)}${inv.refunded_cents ? ` (${money(inv.refunded_cents)} was already refunded)` : ''}.`);
  }
  const reason = String(body.reason ?? '').trim().replace(/\s+/g, ' ');
  if (!reason) throw badRequest('Say why you\'re refunding, like "Moved away mid-month". It goes on the receipt.');
  if (reason.length > 120) throw badRequest('Keep the reason under 120 characters.');
  const byCard = !inv.paid_method;
  if (byCard) {
    if (!inv.payment_ref) throw conflict('There\'s no card payment on file for this invoice to refund.');
    const r = await ctx.payments.refund({ paymentRef: inv.payment_ref, amountCents: amount, idempotencyKey: `invoice-refund-${id}-${inv.refunded_cents + amount}` });
    if (!r.ok) throw new HttpError(502, 'refund_failed', `The refund didn't go through: ${r.error}`);
  }
  const total = inv.refunded_cents + amount;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE invoices SET refunded_cents = ? WHERE id = ?', total, id);
    ctx.db.run(`INSERT INTO invoice_refunds (id, invoice_id, amount_cents, reason, source, created_by, created_at) VALUES (?, ?, ?, ?, 'app', ?, ?)`, newId('iref'), id, amount, reason, actor ?? null, ctx.now());
    emit(ctx, 'invoice.refunded', { invoice_id: id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: amount, total_refunded_cents: total, full: total >= inv.amount_cents, reason, method: byCard ? 'card' : inv.paid_method });
  });
  const emailed = body.email === false ? [] : await invoiceRefundReceipt(ctx, id, { amountCents: amount, reason, byCard });
  return { ...invoiceDetail(ctx, id), refunded_now_cents: amount, emailed_to: emailed };
}
// Stripe webhook charge.refunded for a membership payment: a refund made in the Stripe dashboard. Brings the invoice up to
// Stripe's refunded total and logs the difference (dated now). Takes the invoice lock, so the echo of a refund made in the
// app waits for it to be saved and then finds nothing to add. Returns false when the payment isn't a membership's.
export function syncInvoiceRefundFromStripe(ctx, charge) {
  const found = charge.payment_intent ? ctx.db.get('SELECT id FROM invoices WHERE payment_ref = ? AND paid_method IS NULL', charge.payment_intent) : null;
  if (!found) return false;
  return withLock(`invoice:${found.id}`, () => {
    const inv = getInvoice(ctx, found.id);
    if (inv.status !== 'paid' || inv.payment_ref !== charge.payment_intent || inv.paid_method) return true;
    const total = Math.min(inv.amount_cents, charge.amount_refunded ?? 0);
    if (total <= inv.refunded_cents) return true;
    ctx.db.tx(() => {
      ctx.db.run('UPDATE invoices SET refunded_cents = ? WHERE id = ?', total, inv.id);
      ctx.db.run(`INSERT INTO invoice_refunds (id, invoice_id, amount_cents, reason, source, created_by, created_at) VALUES (?, ?, ?, 'Refunded in the Stripe dashboard', 'stripe', NULL, ?)`, newId('iref'), inv.id, total - inv.refunded_cents, ctx.now());
      emit(ctx, 'invoice.refunded', { invoice_id: inv.id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: total - inv.refunded_cents, total_refunded_cents: total, full: total >= inv.amount_cents, method: 'card', source: 'stripe_dashboard' });
    });
    return true;
  });
}

// ---------- Void (write off) an unpaid membership payment ----------
// Nothing more is charged or retried, open pay links for it stop working, and a membership that was past due only because
// of it is active again. Shares the invoice lock with charges and payments, so a void never lands on top of a payment.
export function voidInvoice(ctx, id, body = {}, { actor } = {}) {
  return withLock(`invoice:${id}`, () => {
    const inv = getInvoice(ctx, id);
    if (inv.status === 'paid') throw conflict('This invoice is paid. Refund it instead.');
    if (inv.status === 'void') throw conflict('This invoice was already voided.');
    const reason = body.reason === undefined || body.reason === null ? null : String(body.reason).trim().replace(/\s+/g, ' ').slice(0, 120) || null;
    let reactivated = false;
    ctx.db.tx(() => {
      ctx.db.run(`UPDATE invoices SET status = 'void', next_retry_at = NULL, voided_at = ?, void_reason = ? WHERE id = ? AND status IN ('open','failed')`, ctx.now(), reason, id);
      ctx.db.run(`UPDATE pay_links SET status = 'canceled' WHERE invoice_id = ? AND status = 'open'`, id);
      const s = getSubscription(ctx, inv.subscription_id);
      if (s.status === 'past_due' && !ctx.db.get(`SELECT 1 FROM invoices WHERE subscription_id = ? AND status = 'failed'`, s.id)) { setStatus(ctx, s.id, 'active'); reactivated = true; }
      emit(ctx, 'invoice.voided', { invoice_id: id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: inv.amount_cents, written_off: inv.status === 'failed', reason, by: actor ?? null, membership_reactivated: reactivated });
    });
    return { ...invoiceDetail(ctx, id), membership_reactivated: reactivated };
  });
}

// ---------- Record a payment that came in another way (cash, check) ----------
export function recordInvoicePaymentByHand(ctx, id, body = {}) {
  const method = v.oneOf(body.method ?? 'check', 'method', Object.keys(HAND_METHODS));
  const reference = body.reference === undefined || body.reference === null || body.reference === '' ? null : v.str(String(body.reference), 'reference', { max: 40 });
  return withLock(`invoice:${id}`, async () => {
    const inv = getInvoice(ctx, id);
    if (inv.status === 'paid') throw conflict('This invoice is already paid.');
    if (inv.status === 'void') throw conflict('This invoice was voided. There\'s nothing to collect.');
    const s = getSubscription(ctx, inv.subscription_id);
    const before = s.status;
    ctx.db.tx(() => recordPaid(ctx, inv, s, { ref: null, method, reference }));
    await membershipReceipt(ctx, id, { how: `${HAND_METHODS[method].toLowerCase()}${reference ? ` (${method === 'check' ? 'check ' : ''}${reference})` : ''}` });
    return { ...invoiceDetail(ctx, id), membership_reactivated: before === 'past_due' && getSubscription(ctx, s.id).status === 'active' };
  });
}

// ---------- Failed payments: retry them all, remind families ----------
const failedRows = (ctx) => ctx.db.all(`SELECT i.id, i.client_id, i.amount_cents, c.family_id, ${cardSql()} AS card_last4,
    CASE WHEN c.family_id IS NOT NULL THEN f.card_payment_method ELSE c.card_payment_method END AS card_pm
  FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id JOIN clients c ON c.id = i.client_id LEFT JOIN families f ON f.id = c.family_id
  WHERE i.status = 'failed' AND s.status = 'past_due' AND c.archived_at IS NULL ORDER BY i.created_at`);
export async function retryDeclined(ctx) {
  const rows = failedRows(ctx);
  const ready = rows.filter((r) => r.card_pm), noCard = rows.length - ready.length;
  if (!ready.length) throw conflict(noCard ? 'None of the declined charges has a card on file. Send card reminders or pay links instead.' : 'There are no declined charges to retry.');
  const out = { tried: 0, paid: 0, paid_cents: 0, declined: 0, no_card: noCard, memberships_reactivated: 0 };
  for (const r of ready) {
    const inv = getInvoice(ctx, r.id);
    if (inv.status !== 'failed') continue;                  // paid by link or card update while we worked down the list
    const before = getSubscription(ctx, inv.subscription_id).status;
    const after = await attemptCharge(ctx, r.id, ctx.now(), { source: 'owner', onlyIfFailed: true });
    if (after.attempts === inv.attempts) continue;         // voided or paid another way while it waited its turn: not charged here
    out.tried++;
    if (after.status === 'paid') {
      out.paid++; out.paid_cents += after.amount_cents;
      if (before === 'past_due' && getSubscription(ctx, inv.subscription_id).status === 'active') out.memberships_reactivated++;
    } else out.declined++;
  }
  return out;
}
// Who a card reminder goes to: every parent in the family, or the adult client.
function recipientsFor(ctx, clientId) {
  const c = ctx.db.get('SELECT family_id, email FROM clients WHERE id = ?', clientId);
  if (c?.family_id) return ctx.db.all('SELECT email FROM guardians WHERE family_id = ? AND email IS NOT NULL ORDER BY is_primary DESC, created_at', c.family_id).map((g) => g.email);
  return c?.email ? [c.email] : [];
}
// A family is reminded at most once a business day, whichever of their declined charges it was about.
function payerKey(ctx, clientId) {
  const c = ctx.db.get('SELECT family_id FROM clients WHERE id = ?', clientId);
  return c?.family_id ? { col: 'c.family_id', id: c.family_id } : { col: 'c.id', id: clientId };
}
function familyFailed(ctx, clientId) {
  const k = payerKey(ctx, clientId);
  return ctx.db.all(`SELECT i.id FROM invoices i JOIN clients c ON c.id = i.client_id JOIN subscriptions s ON s.id = i.subscription_id
    WHERE i.status = 'failed' AND s.status = 'past_due' AND c.archived_at IS NULL AND ${k.col} = ? ORDER BY i.created_at`, k.id);
}
function remindedTodayFor(ctx, clientId) {
  const k = payerKey(ctx, clientId), today = bizToday(ctx), z = zone(ctx);
  return ctx.db.all(`SELECT i.reminded_at FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.reminded_at IS NOT NULL AND ${k.col} = ?`, k.id).some((r) => localDate(r.reminded_at, z) === today);
}
// One family at a time, so two presses (or Remind and Remind all together) can't both email them.
function remindPayer(ctx, clientId) {
  const k = payerKey(ctx, clientId);
  return withLock(`card-reminder:${k.id}`, async () => {
    const list = familyFailed(ctx, clientId);
    if (!list.length) return { sent: false, reason: 'none' };
    if (remindedTodayFor(ctx, clientId)) return { sent: false, reason: 'today' };
    const to = recipientsFor(ctx, clientId);
    if (!to.length) return { sent: false, reason: 'no_email' };
    const now = ctx.now();
    for (const i of list) ctx.db.run('UPDATE invoices SET reminded_at = ? WHERE id = ?', now, i.id);
    await cardReminder(ctx, clientId, list.map((i) => i.id), to);
    return { sent: true, to, invoices: list.length };
  });
}
export async function remindInvoice(ctx, id) {
  const inv = getInvoice(ctx, id);
  if (inv.status !== 'failed') throw conflict('Only a declined charge needs a card reminder.');
  if (ctx.db.get('SELECT archived_at FROM clients WHERE id = ?', inv.client_id)?.archived_at) throw conflict('This client is archived, so they aren\'t emailed. Restore them on their client page first.');
  const r = await remindPayer(ctx, inv.client_id);
  if (r.reason === 'today') throw conflict('A card reminder already went out today. Give the family a day to update their card.');
  if (r.reason === 'no_email') throw conflict('There\'s no email address for this family. Add a parent email on the client page, or send a pay link by text.');
  if (!r.sent) throw conflict('This charge isn\'t waiting on the family any more.');
  return { ...invoiceDetail(ctx, id), reminder_to: r.to, invoices_in_reminder: r.invoices };
}
export async function remindDeclined(ctx) {
  const seen = new Set(), out = { families: 0, sent: 0, skipped_today: 0, no_email: 0 };
  for (const r of failedRows(ctx)) {
    const key = r.family_id ?? r.client_id;
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await remindPayer(ctx, r.client_id);
    if (res.sent) out.sent++; else if (res.reason === 'today') out.skipped_today++; else if (res.reason === 'no_email') out.no_email++;
  }
  if (!seen.size) throw conflict('There are no declined charges.');
  out.families = seen.size;
  return out;
}

// ---------- The numbers at the top of Billing ----------
// Monthly recurring and failed payments are the same numbers as Today's; collected this month is moneyIn, the same as
// Today's "Collected this month"; today's counter money is the day's takings (sales minus refunds made today).
export function billingSummary(ctx) {
  const db = ctx.db, { monthStart, day: todayRange, today } = bounds(ctx), now = ctx.now(), week = addDays(now, 7);
  const members = db.get(`SELECT COALESCE(SUM(p.price_cents), 0) AS c, COUNT(*) AS n FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active'`);
  const teams = db.get(`SELECT COALESCE(SUM(monthly_cents), 0) AS c, COUNT(*) AS n FROM team_contracts WHERE status = 'active'`);
  const byStatus = Object.fromEntries(db.all(`SELECT status, COUNT(*) AS n FROM subscriptions WHERE status != 'canceled' GROUP BY status`).map((r) => [r.status, r.n]));
  const failed = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(i.amount_cents), 0) AS c, COALESCE(SUM(CASE WHEN (${cardSql()}) IS NULL THEN 1 ELSE 0 END), 0) AS no_card
    FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN families f ON f.id = c.family_id WHERE i.status = 'failed'`);
  const school = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c, COALESCE(SUM(due_on < ?), 0) AS overdue_n, COALESCE(SUM(CASE WHEN due_on < ? THEN amount_cents ELSE 0 END), 0) AS overdue_c FROM team_invoices WHERE status = 'open'`, today, today);
  const upcoming = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(p.price_cents), 0) AS c, COALESCE(SUM(s.status = 'trialing'), 0) AS trials FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.status IN ('active','trialing') AND s.current_period_end <= ?`, week);
  const month = moneyIn(ctx, monthStart, now), day = moneyIn(ctx, todayRange.from, todayRange.to);
  const { counts } = listBillingInvoices(ctx, { limit: 1 });
  return {
    as_of: now,
    mrr: { total_cents: members.c + teams.c, members_cents: members.c, teams_cents: teams.c, paying_members: members.n, team_contracts: teams.n },
    members: { active: byStatus.active ?? 0, trialing: byStatus.trialing ?? 0, past_due: byStatus.past_due ?? 0, paused: byStatus.paused ?? 0 },
    month: { from: monthStart, collected_cents: month.total, taken_cents: month.taken_cents, refunded_cents: month.refunded_cents, payments: month.payments, refunds: month.refunds, sales_cents: month.sales, members_cents: month.members, teams_cents: month.teams },
    today: { counter_cents: day.sales, refunded_cents: day.sale_refunds_cents },
    failed: { count: failed.n, cents: failed.c, no_card: failed.no_card },
    school: { open_count: school.n, open_cents: school.c, overdue_count: school.overdue_n, overdue_cents: school.overdue_c },
    upcoming: { days: 7, renewals: upcoming.n, cents: upcoming.c, trials_ending: upcoming.trials },
    counts
  };
}

// ---------- Needs attention: every declined charge, and school invoices past due ----------
export function needsAttention(ctx) {
  const { data: failed } = listBillingInvoices(ctx, { view: 'failed', kind: 'membership', limit: 500 });
  const { data: overdue } = listBillingInvoices(ctx, { view: 'overdue', kind: 'school', limit: 500 });
  const z = zone(ctx), today = bizToday(ctx);
  const days = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
  return {
    failed: failed.map((i) => ({ ...i, reminded_today: !!i.reminded_at && localDate(i.reminded_at, z) === today })),
    overdue: overdue.map((i) => ({ ...i, days_past_due: days(i.due_on, today) })),
    failed_cents: failed.reduce((t, i) => t + i.amount_cents, 0), overdue_cents: overdue.reduce((t, i) => t + i.amount_cents, 0),
    retry_every_days: RETRY_EVERY_DAYS, max_attempts: MAX_ATTEMPTS
  };
}

// ---------- Memberships: everyone on a plan and when they pay next ----------
export const MEMBERSHIP_VIEWS = { live: 'All members', renewing: 'Renewing this week', trialing: 'Free trial', past_due: 'Past due', paused: 'Paused', canceled: 'Canceled lately' };
function membershipViewSql(view, now) {
  return {
    live: [`s.status IN ('active','trialing','past_due','paused')`, []],
    renewing: [`s.status IN ('active','trialing') AND s.current_period_end <= ?`, [addDays(now, 7)]],
    trialing: [`s.status = 'trialing'`, []], past_due: [`s.status = 'past_due'`, []], paused: [`s.status = 'paused'`, []],
    canceled: [`s.status = 'canceled' AND s.canceled_at >= ?`, [addDays(now, -90)]]
  }[view];
}
export function listMemberships(ctx, query = {}) {
  const view = query.view || 'live';
  if (!MEMBERSHIP_VIEWS[view]) throw badRequest(`Choose one of the membership views: ${Object.keys(MEMBERSHIP_VIEWS).join(', ')}.`);
  const now = ctx.now();
  const extra = [], p = [];
  if (query.plan_id) { extra.push('s.plan_id = ?'); p.push(String(query.plan_id)); }
  const q = String(query.q ?? '').trim().toLowerCase().slice(0, 100);
  if (q) { extra.push(`(instr(lower(c.name), ?) > 0 OR instr(lower(COALESCE(c.athlete_id, '')), ?) > 0 OR instr(lower(COALESCE(f.name, '')), ?) > 0)`); p.push(q, q, q); }
  const from = 'FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = s.client_id LEFT JOIN families f ON f.id = c.family_id';
  const more = extra.length ? ` AND ${extra.join(' AND ')}` : '';
  const [cond, cp] = membershipViewSql(view, now);
  const order = view === 'canceled' ? 's.canceled_at DESC' : `CASE s.status WHEN 'past_due' THEN 0 WHEN 'trialing' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, s.current_period_end`;
  const data = ctx.db.all(`SELECT s.id, s.client_id, c.name AS client_name, c.athlete_id, c.archived_at AS client_archived_at, f.name AS family_name, s.plan_id, p.name AS plan_name, p.active AS plan_active,
      p.price_cents, s.status, s.trial_ends_at, s.current_period_end, s.canceled_at, s.created_at, s.pending_plan_id,
      (SELECT pp.name FROM plans pp WHERE pp.id = s.pending_plan_id) AS pending_plan_name,
      CASE WHEN s.status IN ('active','trialing') THEN s.current_period_end END AS next_charge_at, ${cardSql()} AS card_last4, ${brandSql()} AS card_brand,
      (SELECT COALESCE(SUM(i.amount_cents), 0) FROM invoices i WHERE i.subscription_id = s.id AND i.status = 'failed') AS failed_cents
    ${from} WHERE ${cond}${more} ORDER BY ${order}, c.name LIMIT 500`, ...cp, ...p).map((r) => ({ ...r, plan_active: !!r.plan_active }));
  const counts = {};
  for (const key of Object.keys(MEMBERSHIP_VIEWS)) {
    const [c2, p2] = membershipViewSql(key, now);
    counts[key] = ctx.db.get(`SELECT COUNT(*) AS n ${from} WHERE ${c2}${more}`, ...p2, ...p).n;
  }
  const [rc, rp] = membershipViewSql('renewing', now);
  const up = ctx.db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE((SELECT pp.price_cents FROM plans pp WHERE pp.id = s.pending_plan_id), p.price_cents)), 0) AS c ${from} WHERE ${rc}`, ...rp);   // a change waiting for the renewal charges the new price
  return { data, view, counts, upcoming: { days: 7, count: up.n, cents: up.c } };
}
