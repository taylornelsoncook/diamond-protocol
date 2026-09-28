import { newId, notFound, conflict, badRequest, localDate, zonedToUtc, addDaysToDate } from '../util.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';
import { emit } from './events.js';

// A daily look at the money, so problems don't wait for someone to notice. Each morning (after 6 am business time) the
// hourly job checks the day before:
//  - possible double charges: the same athlete charged the same amount twice within 10 minutes, or a membership paid
//    twice for the same month
//  - a refund spike: more refunded than usual (over $250 and over 3 times the daily average of the last 30 days),
//    or 4 or more refunds in a day
//  - payments stuck waiting: an in-person or online payment still "waiting for card" an hour later
//  - with Stripe connected, every card payment matched one by one: a payment Stripe took that the app has no record of,
//    a payment the app shows as paid that Stripe doesn't have, and amounts that don't agree.
// Anything found is emailed to the owners and listed on the Billing screen until someone marks it as looked at.
// If Stripe can't be reached, the check is tried again each hour (up to 6 times) and the owners hear if it never works.
// Findings keep ids, not names, so deleting a family leaves nothing personal behind here.

const DOUBLE_WINDOW_MIN = 10, STUCK_AFTER_MIN = 60, SPIKE_MIN_CENTS = 25000, SPIKE_TIMES = 3, SPIKE_COUNT = 4, MAX_ATTEMPTS = 6, RUN_AFTER_HOUR = 6;
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const MIN = 60000;
const minus = (iso, ms) => new Date(Date.parse(iso) - ms).toISOString();
const isStripeRef = (ref) => /^pi_/.test(ref ?? '') && !/^pi_test/.test(ref);

function dayBounds(ctx, date) {
  const tz = getSetting(ctx, 'timezone');
  return { from: zonedToUtc(date, '00:00', tz), to: zonedToUtc(addDaysToDate(date, 1), '00:00', tz) };
}

// Card payments the app recorded as paid in [from, to). Cash never touches Stripe, so it's left out.
function cardPayments(ctx, from, to) {
  const tz = getSetting(ctx, 'timezone');
  return [
    ...ctx.db.all(`SELECT 'sale' AS kind, id, client_id, amount_cents, status, payment_ref AS ref, completed_at AS at FROM sales
      WHERE method != 'cash' AND status IN ('succeeded','partially_refunded','refunded') AND completed_at >= ? AND completed_at < ?`, from, to),
    ...ctx.db.all(`SELECT 'membership' AS kind, id, client_id, amount_cents, status, payment_ref AS ref, paid_at AS at, subscription_id, period_start FROM invoices
      WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?`, from, to),
    // School invoices only carry a paid date; count the ones paid online on that date.
    ...ctx.db.all(`SELECT 'school' AS kind, id, NULL AS client_id, amount_cents, status, paid_reference AS ref, paid_on AS at FROM team_invoices
      WHERE status = 'paid' AND paid_method = 'online' AND paid_on >= ? AND paid_on <= ?`, localDate(from, tz), localDate(minus(to, 1), tz))
  ];
}

function doubleCharges(ctx, from, to) {
  const found = [];
  // The same athlete, the same amount, twice within 10 minutes (sales and memberships together), unless already refunded.
  const rows = ctx.db.all(`SELECT 'sale' AS kind, id, client_id, amount_cents, completed_at AS at FROM sales
      WHERE client_id IS NOT NULL AND method != 'cash' AND status IN ('succeeded','partially_refunded') AND completed_at >= ? AND completed_at < ?
    UNION ALL SELECT 'membership', id, client_id, amount_cents, paid_at FROM invoices WHERE status = 'paid' AND refunded_cents < amount_cents AND paid_at >= ? AND paid_at < ?
    ORDER BY client_id, amount_cents, at`, minus(from, DOUBLE_WINDOW_MIN * MIN), to, minus(from, DOUBLE_WINDOW_MIN * MIN), to);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.client_id !== b.client_id || a.amount_cents !== b.amount_cents || b.at < from) continue;
    if (Date.parse(b.at) - Date.parse(a.at) > DOUBLE_WINDOW_MIN * MIN) continue;
    found.push({ type: 'double_charge', client_id: b.client_id, amount_cents: b.amount_cents, items: [`${a.kind}:${a.id}`, `${b.kind}:${b.id}`], minutes_apart: Math.round((Date.parse(b.at) - Date.parse(a.at)) / MIN) });
  }
  // A membership month paid twice.
  for (const r of ctx.db.all(`SELECT subscription_id, client_id, period_start, amount_cents, GROUP_CONCAT(id) AS ids, MAX(paid_at) AS last FROM invoices
      WHERE status = 'paid' GROUP BY subscription_id, period_start HAVING COUNT(*) > 1 AND MAX(paid_at) >= ? AND MAX(paid_at) < ?`, from, to)) {
    found.push({ type: 'membership_paid_twice', client_id: r.client_id, amount_cents: r.amount_cents, items: r.ids.split(',').map((id) => `membership:${id}`), period_start: r.period_start });
  }
  return found;
}

function refundSpike(ctx, from, to) {
  const day = ctx.db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(data, '$.amount_cents')), 0) AS cents FROM events WHERE type IN ('sale.refunded','invoice.refunded') AND created_at >= ? AND created_at < ?`, from, to);
  const month = ctx.db.get(`SELECT COALESCE(SUM(json_extract(data, '$.amount_cents')), 0) AS cents FROM events WHERE type IN ('sale.refunded','invoice.refunded') AND created_at >= ? AND created_at < ?`, minus(from, 30 * 86400000), from);
  const average = Math.round(month.cents / 30);
  const big = day.cents > SPIKE_MIN_CENTS && day.cents > SPIKE_TIMES * average;
  return big || day.n >= SPIKE_COUNT ? [{ type: 'refund_spike', amount_cents: day.cents, count: day.n, daily_average_cents: average }] : [];
}

function stuckPayments(ctx, asOf) {
  return ctx.db.all(`SELECT id, client_id, amount_cents, method, created_at FROM sales WHERE status = 'pending' AND created_at < ? AND created_at >= ? ORDER BY created_at`,
    minus(asOf, STUCK_AFTER_MIN * MIN), minus(asOf, 7 * 86400000))
    .map((s) => ({ type: 'stuck_payment', client_id: s.client_id, amount_cents: s.amount_cents, items: [`sale:${s.id}`], method: s.method, started_at: s.created_at }));
}

// Every card payment on both sides, matched by Stripe's payment id.
async function stripeMatch(ctx, from, to, local) {
  // Look back a few days on Stripe's side: an in-person payment is started before it's paid, and school bank payments take days.
  const theirs = await ctx.payments.listPayments({ from: minus(from, 3 * 86400000), to });
  const byRef = new Map(theirs.map((p) => [p.ref, p]));
  const known = new Map();
  for (const r of ctx.db.all(`SELECT payment_ref AS ref, amount_cents FROM sales WHERE payment_ref IS NOT NULL
      UNION ALL SELECT payment_ref, amount_cents FROM invoices WHERE payment_ref IS NOT NULL
      UNION ALL SELECT payment_ref, amount_cents FROM pay_links WHERE payment_ref IS NOT NULL
      UNION ALL SELECT paid_reference, amount_cents FROM team_invoices WHERE paid_reference IS NOT NULL`)) known.set(r.ref, r.amount_cents);
  const found = [];
  let stripeCents = 0;
  for (const p of theirs) {
    if (p.status !== 'succeeded' || p.created_at < from || p.created_at >= to) continue;
    stripeCents += p.amount_cents;
    if (!known.has(p.ref)) found.push({ type: 'stripe_only', amount_cents: p.amount_cents, ref: p.ref, description: p.description ?? null });
    else if (known.get(p.ref) !== p.amount_cents) found.push({ type: 'amount_mismatch', amount_cents: known.get(p.ref), stripe_cents: p.amount_cents, ref: p.ref });
  }
  for (const l of local) {
    if (!isStripeRef(l.ref)) continue;
    const p = byRef.get(l.ref);
    if (!p || !['succeeded', 'processing'].includes(p.status)) found.push({ type: 'app_only', client_id: l.client_id, amount_cents: l.amount_cents, ref: l.ref, items: [`${l.kind}:${l.id}`], stripe_status: p?.status ?? null });
  }
  return { found, stripeCents };
}

// Check one business day. Saves (or replaces) that day's row and emails the owners when something needs a look.
export async function checkDay(ctx, date, { asOf = ctx.now(), by = 'Automatic' } = {}) {
  const { from, to } = dayBounds(ctx, date);
  const local = cardPayments(ctx, from, to);
  const findings = [...doubleCharges(ctx, from, to), ...refundSpike(ctx, from, to), ...stuckPayments(ctx, asOf)];
  const totals = { card_payments: local.length, recorded_cents: local.reduce((s, l) => s + l.amount_cents, 0), stripe_cents: null };
  let status = 'ok', error = null, stripeChecked = 0;
  if (ctx.payments.listPayments) {
    try {
      const m = await stripeMatch(ctx, from, to, local);
      findings.push(...m.found); totals.stripe_cents = m.stripeCents; stripeChecked = 1;
    } catch (e) { status = 'error'; error = `Couldn't reach Stripe: ${e.message}`; }
  }
  if (status !== 'error' && findings.length) status = 'problems';
  const prev = ctx.db.get('SELECT * FROM money_checks WHERE check_date = ?', date);
  const attempts = (prev?.status === 'error' ? prev.attempts : 0) + 1;
  const id = prev?.id ?? newId('mck');
  ctx.db.run(`INSERT INTO money_checks (id, check_date, status, findings, totals, stripe_checked, error, attempts, ran_at, ran_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(check_date) DO UPDATE SET status = excluded.status, findings = excluded.findings, totals = excluded.totals, stripe_checked = excluded.stripe_checked,
      error = excluded.error, attempts = excluded.attempts, ran_at = excluded.ran_at, ran_by = excluded.ran_by,
      reviewed_at = CASE WHEN money_checks.findings = excluded.findings THEN money_checks.reviewed_at END, reviewed_by = CASE WHEN money_checks.findings = excluded.findings THEN money_checks.reviewed_by END`,
    id, date, status, JSON.stringify(findings), JSON.stringify(totals), stripeChecked, error, attempts, ctx.now(), by);
  const row = getCheck(ctx, id);
  const alreadyTold = prev?.alerted_at && prev.findings === JSON.stringify(findings) && prev.status === status;
  if (!alreadyTold && (status === 'problems' || (status === 'error' && attempts >= MAX_ATTEMPTS))) {
    await alertOwners(ctx, row);
    ctx.db.run('UPDATE money_checks SET alerted_at = ? WHERE id = ?', ctx.now(), id);
  }
  if (status === 'problems') emit(ctx, 'money_check.problems', { check_date: date, problems: findings.length, types: [...new Set(findings.map((f) => f.type))] });
  return getCheck(ctx, id);
}

// Hourly job: once a day after 6 am, check yesterday. A day that couldn't reach Stripe is tried again next hour.
export async function runMoneyChecks(ctx, { asOf = ctx.now() } = {}) {
  const tz = getSetting(ctx, 'timezone');
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(asOf)));
  if (hour < RUN_AFTER_HOUR) return null;
  const date = addDaysToDate(localDate(asOf, tz), -1);
  const prev = ctx.db.get('SELECT status, attempts FROM money_checks WHERE check_date = ?', date);
  if (prev && (prev.status !== 'error' || prev.attempts >= MAX_ATTEMPTS)) return null;
  return checkDay(ctx, date, { asOf });
}

// ---- Words for people ----
function describe(ctx, f) {
  const who = (id) => (id ? ctx.db.get('SELECT name FROM clients WHERE id = ?', id)?.name ?? 'A family that has since been deleted' : 'A walk-in');
  switch (f.type) {
    case 'double_charge': return { title: `Possible double charge: ${who(f.client_id)}`, detail: `Charged ${money(f.amount_cents)} twice, ${f.minutes_apart} ${f.minutes_apart === 1 ? 'minute' : 'minutes'} apart. If it was a mistake, refund one from Point of sale → Recent sales.` };
    case 'membership_paid_twice': return { title: `Membership paid twice: ${who(f.client_id)}`, detail: `The month starting ${f.period_start.slice(0, 10)} was paid twice (${money(f.amount_cents)} each). Refund one in Stripe.` };
    case 'refund_spike': return { title: `More refunds than usual: ${money(f.amount_cents)}`, detail: `${f.count} ${f.count === 1 ? 'refund' : 'refunds'} in the day. The usual is about ${money(f.daily_average_cents)} a day. Check the refunds in the Staff audit log.` };
    case 'stuck_payment': return { title: `Payment stuck waiting: ${who(f.client_id)}`, detail: `A ${money(f.amount_cents)} ${f.method === 'online' ? 'online' : 'card-reader'} payment was started and never finished. Open it in Point of sale and check it or cancel it.` };
    case 'stripe_only': return { title: `Stripe took ${money(f.amount_cents)} the app has no record of`, detail: `Stripe payment ${f.ref}${f.description ? ` (${f.description})` : ''}. If you charged it in Stripe directly, nothing to do. Otherwise match it to a family.` };
    case 'app_only': return { title: `Marked paid but not in Stripe: ${who(f.client_id)}`, detail: `The app shows ${money(f.amount_cents)} paid (Stripe payment ${f.ref}), but Stripe ${f.stripe_status ? `says it ${f.stripe_status.replace(/_/g, ' ')}` : 'has no such payment'}. Check it in Stripe before counting the money.` };
    case 'amount_mismatch': return { title: `Amounts don't agree: ${money(f.amount_cents)} vs ${money(f.stripe_cents)}`, detail: `The app recorded ${money(f.amount_cents)} for Stripe payment ${f.ref}; Stripe took ${money(f.stripe_cents)}.` };
    default: return { title: f.type, detail: '' };
  }
}

function getCheck(ctx, id) {
  const r = ctx.db.get('SELECT * FROM money_checks WHERE id = ?', id);
  if (!r) throw notFound('Money check');
  const findings = JSON.parse(r.findings).map((f) => ({ ...f, ...describe(ctx, f) }));
  return { id: r.id, date: r.check_date, status: r.status, problems: findings.length, findings, totals: JSON.parse(r.totals), stripe_checked: !!r.stripe_checked, error: r.error,
    attempts: r.attempts, ran_at: r.ran_at, ran_by: r.ran_by, alerted_at: r.alerted_at, reviewed_at: r.reviewed_at, reviewed_by: r.reviewed_by };
}

export function listChecks(ctx, { limit = 14 } = {}) {
  const data = ctx.db.all('SELECT id FROM money_checks ORDER BY check_date DESC LIMIT ?', Math.min(Number(limit) || 14, 90)).map((r) => getCheck(ctx, r.id));
  return { data, stripe_connected: !!ctx.payments.listPayments, needs_look: data.filter((c) => c.status !== 'ok' && !c.reviewed_at).length };
}

export async function runCheck(ctx, body = {}, user) {
  const tz = getSetting(ctx, 'timezone');
  const today = localDate(ctx.now(), tz);
  const date = body.date ?? addDaysToDate(today, -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must look like 2026-10-15.');
  if (date > today) throw badRequest('That day hasn\'t happened yet. Pick today or earlier.');
  if (date < addDaysToDate(today, -90)) throw badRequest('Pick a day in the last 90 days.');
  return checkDay(ctx, date, { by: user?.name ?? 'Owner' });
}

export function markReviewed(ctx, id, body, user) {
  const c = getCheck(ctx, id);
  if (c.status === 'ok') throw conflict('Nothing to look at on this day.');
  const done = body.reviewed !== false;
  ctx.db.run('UPDATE money_checks SET reviewed_at = ?, reviewed_by = ? WHERE id = ?', done ? ctx.now() : null, done ? user?.name ?? 'Owner' : null, id);
  return getCheck(ctx, id);
}

async function alertOwners(ctx, c) {
  const nice = new Date(`${c.date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  const subject = c.status === 'error' ? `The money check for ${nice} couldn't reach Stripe` : `Money check for ${nice}: ${c.problems} ${c.problems === 1 ? 'thing' : 'things'} to look at`;
  const text = c.status === 'error'
    ? `The daily money check tried ${c.attempts} times and couldn't reach Stripe (${c.error}). Check that the Stripe key on Render is still right, then press "Check again" on the Billing screen.\n\n${ctx.publicUrl ?? ''}/#/billing`
    : [`The daily money check found ${c.problems} ${c.problems === 1 ? 'thing' : 'things'} to look at for ${nice}.`, '',
      ...c.findings.flatMap((f, i) => [`${i + 1}. ${f.title}`, `   ${f.detail}`]), '',
      c.stripe_checked ? `Card payments recorded: ${money(c.totals.recorded_cents)}. Stripe: ${money(c.totals.stripe_cents)}.` : 'Stripe matching starts once Stripe is connected.', '',
      `Mark them as looked at on the Billing screen: ${ctx.publicUrl ?? ''}/#/billing`].join('\n');
  for (const o of ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`)) await sendEmail(ctx, { to: o.email, subject, text }).catch(() => {});
}
