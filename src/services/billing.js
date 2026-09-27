import { newId, v, notFound, badRequest, conflict, addDays, addMonths } from '../util.js';
import { emit } from './events.js';
import { payerFor } from './families.js';
import { membershipReceipt, paymentFailed, trialReminders } from './notify.js';

const MAX_ATTEMPTS = 4;        // after the 4th failed charge the subscription is canceled
const RETRY_EVERY_DAYS = 3;

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
export function createPlan(ctx, body) {
  const plan = {
    id: newId('plan'),
    name: v.str(body.name, 'name', { max: 80 }),
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
  ctx.db.run('UPDATE plans SET name = ?, price_cents = ?, trial_days = ?, active = ? WHERE id = ?',
    body.name !== undefined ? v.str(body.name, 'name', { max: 80 }) : p.name,
    body.price_cents !== undefined ? v.int(body.price_cents, 'price_cents', { min: 0, max: 10000000 }) : p.price_cents,
    body.trial_days !== undefined ? v.int(body.trial_days, 'trial_days', { min: 0, max: 90 }) : p.trial_days,
    body.active !== undefined ? !!body.active : p.active,
    id);
  return getPlan(ctx, id);
}

// ---- Subscriptions ----
export function getSubscription(ctx, id) {
  const s = ctx.db.get(
    `SELECT s.*, p.name AS plan_name, p.price_cents, c.name AS client_name
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = s.client_id WHERE s.id = ?`, id);
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

export function changePlan(ctx, subId, planId) {
  const s = getSubscription(ctx, subId);
  if (s.status === 'canceled') throw conflict('This subscription is canceled. Start a new one instead.');
  const plan = getPlan(ctx, planId);
  if (!plan.active) throw badRequest('That plan is no longer offered.');
  ctx.db.run('UPDATE subscriptions SET plan_id = ?, updated_at = ? WHERE id = ?', planId, ctx.now(), subId);
  const after = getSubscription(ctx, subId);
  emit(ctx, 'subscription.updated', { subscription_id: subId, client_id: s.client_id, client_name: s.client_name, plan_name: after.plan_name, status: after.status, previous_plan_name: s.plan_name });
  return after;
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

export async function attemptCharge(ctx, invoiceId, asOf = ctx.now()) {
  const inv = getInvoice(ctx, invoiceId);
  if (inv.status === 'paid') return inv;
  if (inv.status === 'void') throw conflict('This invoice was voided and cannot be charged.');
  const client = payerFor(ctx, inv.client_id);          // a family's card pays for its athletes
  const attempts = inv.attempts + 1;
  const result = inv.amount_cents === 0
    ? { ok: true, ref: null }
    : await ctx.payments.chargeSaved({ client, amountCents: inv.amount_cents, description: 'Diamond Protocol membership', idempotencyKey: `${inv.id}:${attempts}`, metadata: { invoice_id: inv.id } });

  ctx.db.tx(() => {
    const s = getSubscription(ctx, inv.subscription_id);
    if (result.ok) {
      ctx.db.run(`UPDATE invoices SET status = 'paid', attempts = ?, paid_at = ?, payment_ref = ?, last_error = NULL, next_retry_at = NULL WHERE id = ?`,
        attempts, ctx.now(), result.ref, inv.id);
      emit(ctx, 'invoice.paid', { invoice_id: inv.id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: inv.amount_cents });
      if (['past_due', 'trialing'].includes(s.status)) setStatus(ctx, s.id, 'active');
    } else {
      const giveUp = attempts >= MAX_ATTEMPTS;
      ctx.db.run(`UPDATE invoices SET status = 'failed', attempts = ?, last_error = ?, next_retry_at = ?, payment_ref = COALESCE(?, payment_ref) WHERE id = ?`,
        attempts, result.error, giveUp ? null : addDays(asOf, RETRY_EVERY_DAYS), result.ref ?? null, inv.id);
      emit(ctx, 'invoice.payment_failed', { invoice_id: inv.id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: inv.amount_cents, attempts, error: result.error, final: giveUp });
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

// Stripe webhook: a membership charge settled differently from what the charge call said. A card the bank
// asked the client to approve can succeed later, and a payment still processing can fail later. Only the
// invoice's latest PaymentIntent counts, and nothing changes when the invoice already agrees.
export async function reconcileInvoicePayment(ctx, invoiceId, { ref, succeeded, error }) {
  const inv = ctx.db.get(`SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`, invoiceId);
  if (!inv || !ref || inv.payment_ref !== ref) return 'ignored';
  if (succeeded && inv.status === 'failed') {
    ctx.db.tx(() => {
      ctx.db.run(`UPDATE invoices SET status = 'paid', paid_at = ?, last_error = NULL, next_retry_at = NULL WHERE id = ?`, ctx.now(), inv.id);
      emit(ctx, 'invoice.paid', { invoice_id: inv.id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: inv.amount_cents });
      const s = getSubscription(ctx, inv.subscription_id);
      if (s.status === 'past_due') setStatus(ctx, s.id, 'active');
    });
    await membershipReceipt(ctx, inv.id);
    return 'paid';
  }
  if (!succeeded && inv.status === 'paid') {
    const giveUp = inv.attempts >= MAX_ATTEMPTS;
    ctx.db.tx(() => {
      ctx.db.run(`UPDATE invoices SET status = 'failed', paid_at = NULL, last_error = ?, next_retry_at = ? WHERE id = ?`,
        error || 'The payment failed after it was taken.', giveUp ? null : addDays(ctx.now(), RETRY_EVERY_DAYS), inv.id);
      emit(ctx, 'invoice.payment_failed', { invoice_id: inv.id, client_id: inv.client_id, client_name: inv.client_name, amount_cents: inv.amount_cents, attempts: inv.attempts, error, final: giveUp });
      const s = getSubscription(ctx, inv.subscription_id);
      if (giveUp) { ctx.db.run(`UPDATE invoices SET status = 'void' WHERE id = ?`, inv.id); setStatus(ctx, s.id, 'canceled', { canceled_at: ctx.now() }); }
      else if (s.status !== 'canceled') setStatus(ctx, s.id, 'past_due');
    });
    await paymentFailed(ctx, inv.id);
    return 'failed';
  }
  return 'unchanged';
}

// Manual retry from the dashboard or API.
export async function retryInvoice(ctx, invoiceId) {
  const inv = getInvoice(ctx, invoiceId);
  if (inv.status !== 'failed') throw conflict(inv.status === 'paid' ? 'This invoice is already paid.' : 'Only a failed invoice can be retried.');
  return attemptCharge(ctx, invoiceId);
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
      summary.renewed++;
      count(await invoiceAndCharge(ctx, s.id, start, end, asOf));
    }
  }

  const retries = ctx.db.all(
    `SELECT i.id FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
     WHERE i.status = 'failed' AND i.next_retry_at IS NOT NULL AND i.next_retry_at <= ? AND s.status = 'past_due'`, asOf);
  for (const r of retries) {
    summary.retried++;
    const inv = await attemptCharge(ctx, r.id, asOf);
    count(inv);
    if (inv.status === 'void') summary.canceled++;
  }
  return summary;
}
