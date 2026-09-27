// Billing: plans, every invoice, failed payments, refunds, memberships, the money summary, and the public invoice page's API.
'use strict';
const { get, all, run, insert, update, tx, setting } = require('../db');
const { h, bad, notFound, HttpError, log, payments, randomToken, money, businessName, sendEmail, today, addDays, appUrl } = require('../lib');
const { requireStaff } = require('../auth');
const billing = require('../services/billing');
const schools = require('../services/money-schools');
const clock = require('../services/money-clock');
const { localDateOf } = require('../services/floor-util');
const pos = require('./12-pos');

const owner = requireStaff('owner');
const PAY_LABEL = { tap: 'Tap to Pay', reader: 'front-desk reader', card: 'card', cash: 'cash', check: 'check', ach: 'bank transfer', other: 'other' };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_LIMITS = { name: 60, price: 1000000, trial: 90, sessions: 100 };

const isOwner = (req) => req.staff?.role === 'owner';
const toCents = (v) => { const n = Math.round(Number(String(v ?? '').replace(/[$,\s]/g, '')) * 100); return Number.isFinite(n) ? n : NaN; };
function centsFrom(b, key = 'price') {
  if (b[`${key}_cents`] != null && b[`${key}_cents`] !== '') return Math.round(Number(b[`${key}_cents`]));
  return toCents(b[key]);
}
const optInt = (v) => (v === '' || v == null ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : (() => { throw bad('Use a whole number, 0 or more.'); })());
function planName(v) {
  const name = String(v || '').trim().replace(/\s+/g, ' ');
  if (!name) throw bad('Name the plan.');
  if (name.length > PLAN_LIMITS.name) throw bad(`Keep the plan name under ${PLAN_LIMITS.name} characters.`);
  return name;
}
function planPrice(b) {
  const price = centsFrom(b);
  if (!(price > 0)) throw bad('Enter a monthly price.');
  if (price > PLAN_LIMITS.price) throw bad(`Enter a monthly price under ${money(PLAN_LIMITS.price)}.`);
  return price;
}
function trialDays(v) {
  const n = optInt(v) ?? 0;
  if (n > PLAN_LIMITS.trial) throw bad(`Keep free trials to ${PLAN_LIMITS.trial} days or fewer.`);
  return n;
}
function sessionsPerMonth(v, { blankIsNull }) {
  const n = optInt(v);
  if (n != null && n > PLAN_LIMITS.sessions) throw bad(`Use ${PLAN_LIMITS.sessions} sessions a month or fewer. Leave group sessions blank for unlimited.`);
  return n == null && !blankIsNull ? 0 : n;
}
const dupPlan = (name, exceptId = 0) => get('SELECT 1 FROM plans WHERE name=? COLLATE NOCASE AND active=1 AND id<>?', name, exceptId);
const fullName = (r) => (r?.first_name ? `${r.first_name} ${r.last_name}` : '');
const cardText = (f) => (f?.card_last4 ? `${f.card_brand || 'Card'} ending ${f.card_last4}` : null);

// ---- invoice list filters, shared by the list, the paged list and the CSV export ----
const STATUSES = ['failed', 'open', 'paid', 'void', 'overdue', 'unpaid', 'refund', 'refunded'];
const KINDS = ['membership', 'school', 'charge'];
function invoiceFilter(query) {
  const where = ['1=1'], p = [];
  const { status, kind, q, from, to } = query;
  if (status && !STATUSES.includes(String(status))) throw bad('Choose one of the invoice filters.');
  if (kind && !KINDS.includes(String(kind))) throw bad('Choose one of the invoice kinds.');
  if (status === 'overdue') { where.push("i.status='open' AND i.due_date < ?"); p.push(today()); }
  else if (status === 'unpaid') where.push("i.status IN ('open','failed')");
  else if (status === 'refund') where.push('i.amount_cents < 0');
  else if (status === 'refunded') where.push('EXISTS (SELECT 1 FROM invoices r WHERE r.refund_of=i.id)');
  else if (status === 'paid') where.push("i.status='paid' AND i.amount_cents >= 0"); // refunds have their own view
  else if (status) { where.push('i.status=?'); p.push(String(status)); }
  if (kind) { where.push('COALESCE(ro.kind, i.kind)=?'); p.push(String(kind)); } // a refund counts as the kind it refunds
  for (const [v, op] of [[from, '>='], [to, '<=']]) {
    if (!v) continue;
    if (!ISO_DATE.test(String(v))) throw bad('Choose a date for the date range.');
    where.push(`i.issued_at ${op} ?`); p.push(String(v));
  }
  if (query.athlete_id) { where.push('i.athlete_id=?'); p.push(Number(query.athlete_id)); }
  if (query.family_id) { where.push('i.family_id=?'); p.push(Number(query.family_id)); }
  if (q) {
    const like = `%${String(q).trim()}%`;
    where.push("(i.number LIKE ? OR i.description LIKE ? OR a.first_name || ' ' || a.last_name LIKE ? OR f.name LIKE ? OR s.name LIKE ? OR t.team_name LIKE ?)");
    p.push(like, like, like, like, like, like);
  }
  return { where: where.join(' AND '), p };
}
// A refund row carries no contract of its own, so the school comes from the invoice it refunds.
const INVOICE_FROM = `FROM invoices i LEFT JOIN athletes a ON a.id=i.athlete_id LEFT JOIN families f ON f.id=i.family_id
  LEFT JOIN memberships m ON m.id=i.membership_id LEFT JOIN plans pl ON pl.id=m.plan_id
  LEFT JOIN invoices ro ON ro.id=i.refund_of
  LEFT JOIN team_contracts t ON t.id=COALESCE(i.contract_id, ro.contract_id) LEFT JOIN schools s ON s.id=t.school_id`;
const INVOICE_COLS = `i.id, i.number, i.kind, i.description, i.amount_cents, i.status, i.issued_at, i.due_date, i.paid_at, i.pay_method, i.check_number,
  i.attempts, i.next_retry, i.last_reminder, i.period, i.view_token, i.athlete_id, i.family_id, i.contract_id, i.membership_id, i.refund_of, i.created_at,
  a.first_name, a.last_name, f.name AS family, f.card_brand, f.card_last4, f.card_exp, pl.name AS plan_name, t.team_name, s.name AS school, ro.number AS refund_of_number,
  (SELECT -COALESCE(SUM(r.amount_cents),0) FROM invoices r WHERE r.refund_of=i.id) AS refunded_cents`;
function listRow(r) {
  return { ...r, retries_done: r.status === 'failed' && (r.attempts >= billing.MAX_ATTEMPTS || !r.next_retry), overdue: r.status === 'open' && !!r.due_date && r.due_date < today() };
}

// Text that a spreadsheet would run as a formula gets a leading apostrophe. Plain numbers (refunds are negative) stay numbers.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  const formula = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s);
  return formula || /[",\n\r]/.test(s) ? `"${(formula ? "'" : '') + s.replace(/"/g, '""')}"` : s;
}
const dollars = (c) => (Number(c || 0) / 100).toFixed(2);

function planRows(req) {
  const rows = all(`SELECT p.*,
      (SELECT COUNT(*) FROM memberships m WHERE m.plan_id=p.id AND m.status IN ('trial','active','past_due','paused')) AS subscribers,
      (SELECT COALESCE(SUM(COALESCE(m.price_cents, p.price_cents)),0) FROM memberships m WHERE m.plan_id=p.id AND m.status='active') AS monthly_revenue_cents
    FROM plans p ORDER BY p.active DESC, p.price_cents`);
  if (isOwner(req)) return rows;
  return rows.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, trial_days: p.trial_days, group_per_month: p.group_per_month, private_per_month: p.private_per_month, active: p.active }));
}

function invoiceRow(id) {
  const inv = get('SELECT * FROM invoices WHERE id=?', id);
  if (!inv) throw notFound('That invoice');
  return inv;
}

function publicInvoice(token) {
  const inv = get('SELECT * FROM invoices WHERE view_token=?', String(token || ''));
  if (!inv || !token) throw notFound('That invoice');
  return inv;
}

function routes(api) {
  // ---- plans ----
  api.get('/plans', requireStaff(), (req, res) => res.json(planRows(req)));

  api.post('/plans', owner, h(async (req, res) => {
    const b = req.body || {};
    const name = planName(b.name);
    const price = planPrice(b);
    if (dupPlan(name)) throw bad('A plan with that name already exists.');
    const id = insert('plans', { name, price_cents: price, trial_days: trialDays(b.trial_days), group_per_month: sessionsPerMonth(b.group_per_month, { blankIsNull: true }), private_per_month: sessionsPerMonth(b.private_per_month, { blankIsNull: false }) });
    log(req, 'Created plan', name); // no prices: coaches can read the activity feed
    res.status(201).json({ id });
  }));

  // Price changes apply from each member's next charge: every live membership on the plan takes the new price.
  api.put('/plans/:id', owner, h(async (req, res) => {
    const p = get('SELECT * FROM plans WHERE id=?', Number(req.params.id));
    if (!p) throw notFound('That plan');
    const b = req.body || {};
    const patch = {};
    if ('name' in b) patch.name = planName(b.name);
    if ('price' in b || 'price_cents' in b) patch.price_cents = planPrice(b);
    if ('trial_days' in b) patch.trial_days = trialDays(b.trial_days);
    if ('group_per_month' in b) patch.group_per_month = sessionsPerMonth(b.group_per_month, { blankIsNull: true });
    if ('private_per_month' in b) patch.private_per_month = sessionsPerMonth(b.private_per_month, { blankIsNull: false });
    if ('active' in b) patch.active = b.active ? 1 : 0;
    // Two live plans can't share a name: renaming onto one, or bringing back a retired plan whose name is taken.
    const liveAfter = 'active' in patch ? patch.active : p.active;
    if (liveAfter && dupPlan(patch.name ?? p.name, p.id)) throw bad(patch.name && patch.name !== p.name ? 'A plan with that name already exists.' : `Another plan is already called ${p.name}. Rename one of them first.`);
    let moved = 0;
    tx(() => {
      update('plans', p.id, patch);
      if (patch.price_cents != null && patch.price_cents !== p.price_cents) {
        moved = Number(run("UPDATE memberships SET price_cents=? WHERE plan_id=? AND status IN ('trial','active','past_due','paused')", patch.price_cents, p.id).changes);
      }
    });
    const what = [];
    if (patch.price_cents != null && patch.price_cents !== p.price_cents) what.push(`new price for ${moved} member${moved === 1 ? '' : 's'} from their next charge`);
    if ('active' in patch) what.push(patch.active ? 'brought back' : 'retired');
    if (patch.name && patch.name !== p.name) what.push(`renamed to ${patch.name}`);
    log(req, 'Changed plan', `${p.name}: ${what.join(', ') || 'details'}`);
    res.json({ ok: true, members_repriced: moved });
  }));

  // ---- summary (owner): the numbers at the top of Billing ----
  api.get('/billing/summary', owner, (req, res) => {
    const T = today(), month = T.slice(0, 7) + '-01';
    const mem = get("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(m.price_cents,p.price_cents)),0) c FROM memberships m JOIN plans p ON p.id=m.plan_id WHERE m.status IN ('active','past_due')");
    const teams = get("SELECT COUNT(*) n, COALESCE(SUM(monthly_cents),0) c FROM team_contracts WHERE status='active'");
    const byStatus = Object.fromEntries(all("SELECT status, COUNT(*) n FROM memberships WHERE status<>'cancelled' GROUP BY status").map((r) => [r.status, r.n]));
    const paid = all("SELECT amount_cents, paid_at FROM invoices WHERE status='paid' AND paid_at IS NOT NULL AND paid_at >= ?", addDays(month, -1))
      .filter((i) => (localDateOf(i.paid_at) || '') >= month);
    const taken = paid.filter((i) => i.amount_cents > 0).reduce((n, i) => n + i.amount_cents, 0);
    const refunded = -paid.filter((i) => i.amount_cents < 0).reduce((n, i) => n + i.amount_cents, 0);
    const failed = get(`SELECT COUNT(*) n, COALESCE(SUM(i.amount_cents),0) c, COALESCE(SUM(CASE WHEN f.card_last4 IS NULL THEN 1 ELSE 0 END),0) no_card
      FROM invoices i LEFT JOIN families f ON f.id=i.family_id WHERE i.status='failed'`);
    const open = get("SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM invoices WHERE status='open'");
    const overdue = get("SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM invoices WHERE status='open' AND due_date < ?", T);
    const upcoming = get("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(m.price_cents,p.price_cents)),0) c FROM memberships m JOIN plans p ON p.id=m.plan_id WHERE m.status IN ('active','trial') AND m.next_charge BETWEEN ? AND ?", T, addDays(T, 7));
    const trialsEnding = get("SELECT COUNT(*) n FROM memberships WHERE status='trial' AND next_charge BETWEEN ? AND ?", T, addDays(T, 7)).n;
    const counts = get(`SELECT COUNT(*) all_, SUM(status='failed') failed, SUM(status IN ('open','failed')) unpaid, SUM(status='open' AND due_date < ?) overdue,
      SUM(status='paid' AND amount_cents>=0) paid, SUM(amount_cents<0) refund, SUM(status='void') void FROM invoices`, T);
    res.json({
      mrr: { total_cents: mem.c + teams.c, memberships_cents: mem.c, teams_cents: teams.c, members: mem.n, teams: teams.n },
      members: { trial: byStatus.trial || 0, active: byStatus.active || 0, past_due: byStatus.past_due || 0, paused: byStatus.paused || 0 },
      month: { start: month, collected_cents: taken - refunded, taken_cents: taken, refunded_cents: refunded, payments: paid.filter((i) => i.amount_cents > 0).length },
      failed: { count: failed.n, cents: failed.c, no_card: failed.no_card },
      unpaid: { count: open.n, cents: open.c, overdue_count: overdue.n, overdue_cents: overdue.c },
      upcoming: { days: 7, count: upcoming.n, cents: upcoming.c, trials_ending: trialsEnding },
      counts: { all: counts.all_ || 0, failed: counts.failed || 0, unpaid: counts.unpaid || 0, overdue: counts.overdue || 0, paid: counts.paid || 0, refund: counts.refund || 0, void: counts.void || 0 },
    });
  });

  // ---- invoices (owner) ----
  // Plain array by default (older callers); ?paged=1 adds the total count and amount for the filter.
  api.get('/invoices', owner, h(async (req, res) => {
    const { where, p } = invoiceFilter(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const rows = all(`SELECT ${INVOICE_COLS} ${INVOICE_FROM} WHERE ${where} ORDER BY i.issued_at DESC, i.id DESC LIMIT ?`, ...p, limit).map(listRow);
    if (!req.query.paged) return res.json(rows);
    const t = get(`SELECT COUNT(*) n, COALESCE(SUM(i.amount_cents),0) c ${INVOICE_FROM} WHERE ${where}`, ...p);
    res.json({ invoices: rows, total: t.n, total_cents: t.c, limit });
  }));

  // Everything matching the current filter as a spreadsheet, for the bookkeeper.
  api.get('/invoices/export.csv', owner, h(async (req, res) => {
    const { where, p } = invoiceFilter(req.query);
    const rows = all(`SELECT ${INVOICE_COLS} ${INVOICE_FROM} WHERE ${where} ORDER BY i.issued_at DESC, i.id DESC LIMIT 20000`, ...p);
    const head = ['Invoice', 'Issued', 'Client', 'Family or school', 'Kind', 'For', 'Amount', 'Status', 'Due', 'Paid on', 'Paid by', 'Check number', 'Refunded', 'Refund of'];
    const lines = [head.join(',')].concat(rows.map((r) => [
      r.number, r.issued_at, fullName(r), r.school || r.family || '', r.amount_cents < 0 ? 'refund' : r.kind, r.plan_name || r.description || r.team_name || '',
      dollars(r.amount_cents), r.status === 'open' && r.due_date && r.due_date < today() ? 'overdue' : r.status, r.due_date || '', r.paid_at ? localDateOf(r.paid_at) : '',
      r.status === 'paid' ? PAY_LABEL[r.pay_method] || r.pay_method || '' : '', r.check_number || '', r.refunded_cents ? dollars(r.refunded_cents) : '', r.refund_of_number || '',
    ].map(csvCell).join(',')));
    log(req, 'Exported invoices', `${rows.length} row${rows.length === 1 ? '' : 's'}`, 'view');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="invoices-${today()}.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  }));

  // One invoice with everything the owner needs to act on it.
  api.get('/invoices/:id', owner, h(async (req, res) => {
    const r = get(`SELECT ${INVOICE_COLS}, i.charge_id ${INVOICE_FROM} WHERE i.id=?`, Number(req.params.id));
    if (!r) throw notFound('That invoice');
    const inv = listRow(r);
    const refunds = all('SELECT id, number, amount_cents, paid_at, pay_method FROM invoices WHERE refund_of=? ORDER BY id', inv.id);
    const sale = inv.charge_id ? get('SELECT id, status, total_cents, refunded_cents FROM sales WHERE charge_id=?', inv.charge_id) : null;
    const membership = inv.membership_id ? get('SELECT m.id, m.status, m.next_charge, p.name AS plan_name FROM memberships m JOIN plans p ON p.id=m.plan_id WHERE m.id=?', inv.membership_id) : null;
    const email = inv.contract_id ? schools.billTo(schools.contractWithSchool(inv.contract_id)) : inv.family_id ? billing.billingEmail(inv.family_id) : null;
    const refundable = inv.status === 'paid' && inv.amount_cents > 0 ? Math.max(0, inv.amount_cents - (inv.refunded_cents || 0)) : 0;
    delete inv.charge_id;
    res.json({
      ...inv, refunds, refundable_cents: refundable, email, membership,
      sale: sale ? { id: sale.id, status: sale.status } : null,
      pay_label: PAY_LABEL[inv.pay_method] || inv.pay_method || null,
      can: {
        retry: inv.status === 'failed' && ['membership', 'charge'].includes(inv.kind),
        record_payment: ['open', 'failed'].includes(inv.status) && inv.amount_cents > 0,
        refund: refundable > 0,
        void: ['open', 'failed'].includes(inv.status),
        email: inv.status !== 'void' && inv.amount_cents > 0 && !!email,
        remind: inv.status === 'failed' && !!email,
      },
    });
  }));

  api.post('/invoices/:id/retry', owner, h(async (req, res) => {
    const inv = invoiceRow(Number(req.params.id));
    if (inv.status !== 'failed') throw bad('Only declined charges can be retried.');
    const fam = inv.family_id ? get('SELECT card_last4 FROM families WHERE id=?', inv.family_id) : null;
    if (!fam?.card_last4) throw bad('There is no card on file for this family. Send them a card reminder, or record a cash or check payment.');
    const memStatus = () => (inv.membership_id ? get('SELECT status FROM memberships WHERE id=?', inv.membership_id)?.status : null);
    const wasPastDue = memStatus() === 'past_due';
    const r = billing.retryFailed({ invoiceId: inv.id });
    const after = invoiceRow(inv.id);
    const who = inv.athlete_id ? get("SELECT first_name || ' ' || last_name AS n FROM athletes WHERE id=?", inv.athlete_id)?.n : inv.number;
    log(req, r.paid ? 'Retried payment: paid' : 'Retried payment: declined again', `${who}, ${money(inv.amount_cents)} (${inv.number})`);
    if (!r.paid) throw bad(after.attempts >= billing.MAX_ATTEMPTS
      ? 'The card was declined again. There are no more automatic retries, so ask the family to update their card.'
      : `The card was declined again. It retries on its own every ${billing.RETRY_DAYS} days, or ask the family to update their card.`);
    res.json({ ok: true, invoice: after, message: `Charged ${money(inv.amount_cents)}.${wasPastDue && memStatus() === 'active' ? ' The membership is active again.' : ''}` });
  }));

  // Retry every declined charge that has a card on file, now.
  api.post('/billing/retry-declined', owner, h(async (req, res) => {
    const list = all(`SELECT i.id FROM invoices i JOIN families f ON f.id=i.family_id
      WHERE i.status='failed' AND i.kind IN ('membership','charge') AND f.card_last4 IS NOT NULL ORDER BY i.id`);
    const noCard = get("SELECT COUNT(*) n FROM invoices i LEFT JOIN families f ON f.id=i.family_id WHERE i.status='failed' AND f.card_last4 IS NULL").n;
    if (!list.length) throw bad(noCard ? 'None of the declined charges has a card on file. Send card reminders instead.' : 'There are no declined charges to retry.');
    let paid = 0, cents = 0;
    for (const { id } of list) {
      const r = billing.retryFailed({ invoiceId: id });
      if (r.paid) { paid++; cents += get('SELECT amount_cents FROM invoices WHERE id=?', id).amount_cents; }
    }
    log(req, 'Retried payments', `${list.length} declined charge${list.length === 1 ? '' : 's'}: ${paid} paid (${money(cents)}), ${list.length - paid} declined again`);
    res.json({ ok: true, tried: list.length, paid, paid_cents: cents, declined: list.length - paid, no_card: noCard });
  }));

  // Ask a family to update their card: one email per family listing every declined charge. Not twice on the same day.
  function remindFamily(familyId, invoices) {
    const to = billing.billingEmail(familyId);
    if (!to) return null;
    const fam = get('SELECT * FROM families WHERE id=?', familyId);
    const parent = get('SELECT name FROM parents WHERE family_id=? ORDER BY is_self DESC, id LIMIT 1', familyId);
    const total = invoices.reduce((n, i) => n + i.amount_cents, 0);
    const lines = invoices.map((i) => `- ${i.description || i.number}${i.first_name ? ` (${i.first_name})` : ''}: ${money(i.amount_cents)}`);
    const card = cardText(fam);
    const subject = invoices.length === 1 ? `Please update your card: ${money(total)} didn't go through` : `Please update your card: ${invoices.length} payments didn't go through`;
    const body = `Hi ${String(parent?.name || 'there').split(' ')[0]},\n\n${card ? `We couldn't charge your ${card}` : "We don't have a card on file for you"}, so ${invoices.length === 1 ? 'this payment is' : 'these payments are'} still due:\n\n${lines.join('\n')}\n\nTotal: ${money(total)}\n\n` +
      `To add or update your card, sign in to the parent portal and open the Family tab:\n${appUrl()}/parent\n\nWe'll try the charge again once your card is updated. Questions? Just reply to this email.\n\n${businessName()}`;
    sendEmail(to, subject, body);
    for (const i of invoices) update('invoices', i.id, { last_reminder: today() });
    return to;
  }
  const FAILED_SELECT = `SELECT i.*, a.first_name FROM invoices i LEFT JOIN athletes a ON a.id=i.athlete_id WHERE i.status='failed' AND i.family_id IS NOT NULL`;

  api.post('/invoices/:id/remind', owner, h(async (req, res) => {
    const inv = invoiceRow(Number(req.params.id));
    if (inv.status !== 'failed') throw bad('Only declined charges need a card reminder.');
    if (!inv.family_id) throw bad('This charge has no family to email.');
    const list = all(`${FAILED_SELECT} AND i.family_id=? ORDER BY i.id`, inv.family_id);
    if (list.some((i) => i.last_reminder === today())) throw bad('A reminder already went out today. Give the family a day to update their card.');
    const to = remindFamily(inv.family_id, list);
    if (!to) throw bad('This family has no email address. Add a parent email on the client profile.');
    const fam = get('SELECT name FROM families WHERE id=?', inv.family_id);
    log(req, 'Emailed payment reminder', `${fam?.name || inv.number} (${to})`);
    res.json({ ok: true, to, invoices: list.length });
  }));

  api.post('/billing/remind-declined', owner, h(async (req, res) => {
    const byFam = new Map();
    for (const i of all(`${FAILED_SELECT} ORDER BY i.family_id, i.id`)) (byFam.get(i.family_id) || byFam.set(i.family_id, []).get(i.family_id)).push(i);
    if (!byFam.size) throw bad('There are no declined charges.');
    let sent = 0, skipped = 0, noEmail = 0;
    for (const [fid, list] of byFam) {
      if (list.some((i) => i.last_reminder === today())) { skipped++; continue; } // one email per family per day
      if (remindFamily(fid, list)) sent++; else noEmail++;
    }
    if (sent) log(req, 'Emailed payment reminders', `${sent} famil${sent === 1 ? 'y' : 'ies'}`);
    res.json({ ok: true, sent, skipped, no_email: noEmail });
  }));

  api.post('/invoices/:id/record-payment', owner, h(async (req, res) => {
    const inv = invoiceRow(Number(req.params.id));
    if (inv.amount_cents <= 0) throw bad('That is a refund, not something to collect.');
    const b = req.body || {};
    const paid = schools.markPaid(inv.id, { method: b.method || 'check', check_number: b.check_number, paid_on: b.paid_on || null });
    log(req, 'Recorded invoice payment', `${inv.number}, ${money(inv.amount_cents)} by ${paid.pay_method}${paid.check_number ? ` #${paid.check_number}` : ''}`);
    res.json({ ok: true, invoice: paid });
  }));

  api.post('/invoices/:id/email', owner, h(async (req, res) => {
    const inv = invoiceRow(Number(req.params.id));
    if (inv.status === 'void') throw bad('That invoice was voided.');
    if (inv.amount_cents <= 0) throw bad('Refunds are emailed to the family when you make them.');
    const to = schools.emailInvoice(inv.id);
    log(req, 'Emailed invoice', `${inv.number} to ${to}`);
    res.json({ ok: true, to });
  }));

  // Void an open invoice or write off a declined charge. A membership held past due only by this charge becomes active again.
  api.post('/invoices/:id/void', owner, h(async (req, res) => {
    let reactivated = false;
    const inv = tx(() => {
      const v = schools.voidInvoice(Number(req.params.id));
      if (v.membership_id && v.status === 'failed' && !get("SELECT 1 FROM invoices WHERE membership_id=? AND status='failed'", v.membership_id)) {
        reactivated = Number(run("UPDATE memberships SET status='active' WHERE id=? AND status='past_due'", v.membership_id).changes) > 0;
      }
      return v;
    });
    log(req, inv.status === 'failed' ? 'Voided invoice: wrote off declined charge' : 'Voided invoice', `${inv.number}, ${money(inv.amount_cents)}${reactivated ? ', membership active again' : ''}`);
    res.json({ ok: true, membership_reactivated: reactivated });
  }));

  // Refund all or part of a paid invoice. Counter sales stay in step with Point of sale (credits come back on a full refund).
  api.post('/invoices/:id/refund', owner, h(async (req, res) => {
    const inv = invoiceRow(Number(req.params.id));
    if (inv.amount_cents <= 0) throw bad('That is already a refund.');
    if (inv.status !== 'paid') throw bad(inv.status === 'void' ? 'That invoice was voided, so nothing was paid.' : 'Only paid invoices can be refunded. Void it instead.');
    const left = inv.amount_cents - billing.refundedCents(inv.id);
    if (left <= 0) throw bad('This invoice has already been refunded in full.');
    const b = req.body || {};
    const blank = (b.amount_cents == null || b.amount_cents === '') && (b.amount == null || String(b.amount).trim() === '');
    const amount = blank ? left : b.amount_cents != null && b.amount_cents !== '' ? Number(b.amount_cents) : toCents(b.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw bad('Enter an amount to refund.');
    if (amount > left) throw bad(`You can refund up to ${money(left)}.`);
    const reason = String(b.reason || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const sale = inv.charge_id ? get("SELECT * FROM sales WHERE charge_id=? AND status IN ('paid','partial_refund')", inv.charge_id) : null;
    tx(() => {
      if (sale) {
        if (amount > sale.total_cents - (sale.refunded_cents || 0)) throw bad(`You can refund up to ${money(sale.total_cents - (sale.refunded_cents || 0))}.`);
        pos.refundSale(sale, amount);
      } else if (!billing.refundInvoice(inv.id, amount).ok) throw bad('That invoice could not be refunded.');
    });
    const who = inv.athlete_id ? fullName(get('SELECT first_name, last_name FROM athletes WHERE id=?', inv.athlete_id)) : inv.contract_id ? schools.contractWithSchool(inv.contract_id)?.school_name : 'Walk-in';
    let emailed = null;
    if (b.email !== false && b.email !== 'false') {
      emailed = inv.contract_id ? schools.billTo(schools.contractWithSchool(inv.contract_id)) : inv.family_id ? billing.billingEmail(inv.family_id) : null;
      if (emailed) {
        const how = ['card', 'tap', 'reader', 'ach'].includes(inv.pay_method) ? `It goes back to the ${inv.pay_method === 'ach' ? 'bank account' : 'card'} you paid with and usually shows within 5 to 10 business days.` : '';
        sendEmail(emailed, `Refund of ${money(amount)} from ${businessName()}`, `We refunded ${money(amount)} for ${inv.description || `invoice ${inv.number}`} (invoice ${inv.number}).${reason ? `\n\nReason: ${reason}` : ''}${how ? `\n\n${how}` : ''}\n\n${businessName()}`);
      }
    }
    log(req, 'Refunded invoice', `${who || inv.number} · ${money(amount)} of ${money(inv.amount_cents)} · ${inv.number}${reason ? ` · ${reason}` : ''}`);
    const back = inv.pay_method === 'cash' ? ' Hand back the cash.' : inv.pay_method === 'check' ? ' Send the money back by check; this records it.' : inv.pay_method === 'ach' ? ' It goes back to their bank account.' : ' It goes back to the card.';
    res.json({ ok: true, refunded_cents: amount, left_cents: left - amount, emailed, message: `Refunded ${money(amount)}.${back}${emailed ? ` Receipt emailed to ${emailed}.` : ''}` });
  }));

  // ---- memberships (owner): everyone on a plan, what they pay and when they next pay ----
  const MEM_VIEWS = {
    live: "m.status IN ('trial','active','past_due','paused')",
    renewing: "m.status IN ('active','trial') AND m.next_charge BETWEEN :t AND :t7",
    trial: "m.status='trial'",
    past_due: "m.status='past_due'",
    paused: "m.status='paused'",
    cancelled: "m.status='cancelled' AND m.cancelled_at >= :t90",
  };
  api.get('/memberships', owner, h(async (req, res) => {
    const view = String(req.query.view || 'live');
    if (!MEM_VIEWS[view]) throw bad('Choose one of the membership views.');
    const T = today();
    const bind = (sql) => sql.replace(/:t90/g, `'${addDays(T, -90)}'`).replace(/:t7/g, `'${addDays(T, 7)}'`).replace(/:t\b/g, `'${T}'`);
    const where = [bind(MEM_VIEWS[view])], p = [];
    if (req.query.plan_id) { where.push('m.plan_id=?'); p.push(Number(req.query.plan_id)); }
    if (req.query.q) { const like = `%${String(req.query.q).trim()}%`; where.push("(a.first_name || ' ' || a.last_name LIKE ? OR f.name LIKE ? OR a.code LIKE ?)"); p.push(like, like, like); }
    const rows = all(`SELECT m.id, m.status, m.started_at, m.next_charge, m.cancelled_at, m.plan_id, COALESCE(m.price_cents,p.price_cents) AS price_cents,
        p.name AS plan_name, p.active AS plan_active, a.id AS athlete_id, a.first_name, a.last_name, a.family_id, f.name AS family, f.card_brand, f.card_last4, f.card_exp,
        (SELECT COALESCE(SUM(i.amount_cents),0) FROM invoices i WHERE i.membership_id=m.id AND i.status='failed') AS failed_cents
      FROM memberships m JOIN plans p ON p.id=m.plan_id JOIN athletes a ON a.id=m.athlete_id LEFT JOIN families f ON f.id=a.family_id
      WHERE ${where.join(' AND ')} ORDER BY ${view === 'cancelled' ? 'm.cancelled_at DESC' : "CASE m.status WHEN 'past_due' THEN 0 WHEN 'trial' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, m.next_charge"}, a.last_name, a.first_name LIMIT 500`, ...p);
    const counts = {};
    for (const [k, sql] of Object.entries(MEM_VIEWS)) counts[k] = get(`SELECT COUNT(*) n FROM memberships m WHERE ${bind(sql)}`).n;
    const up = get(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(m.price_cents,p.price_cents)),0) c FROM memberships m JOIN plans p ON p.id=m.plan_id WHERE ${bind(MEM_VIEWS.renewing)}`);
    res.json({ memberships: rows, counts, upcoming: { days: 7, count: up.n, cents: up.c } });
  }));

  // ---- billing clock (test mode only) ----
  api.post('/billing/run', owner, h(async (req, res) => {
    if (payments.mode() !== 'test') throw bad('The billing clock only runs in test mode.');
    const asOf = String(req.body?.as_of || today());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw bad('Choose a date.');
    if (asOf < today()) throw bad('Choose today or a later date.');
    const r = clock.runBillingAsOf(asOf);
    log(req, 'Ran billing (test mode)', `as of ${asOf}: ${r.charged} charged, ${r.declined} declined, ${r.recovered} recovered, ${r.school_invoices} school invoices, ${r.reminders} reminders`);
    res.json(r);
  }));

  // ---- public invoice (link in each invoice email) ----
  api.get('/public/invoices/:token', h(async (req, res) => {
    const inv = publicInvoice(req.params.token);
    let billTo;
    if (inv.contract_id) {
      const c = schools.contractWithSchool(inv.contract_id);
      billTo = { name: c.school_name, attn: c.billing_name || c.contact_name, email: schools.billTo(c), address: c.school_address, team: c.team_name, po_number: c.po_number };
    } else if (inv.family_id) {
      const f = get('SELECT name FROM families WHERE id=?', inv.family_id);
      const p = get('SELECT name, email FROM parents WHERE family_id=? ORDER BY is_self DESC, id LIMIT 1', inv.family_id);
      billTo = { name: p?.name || f?.name, attn: null, email: p?.email, address: null };
    } else billTo = { name: 'Customer' };
    res.set('Cache-Control', 'no-store');
    res.json({
      number: inv.number, kind: inv.kind, description: inv.description, amount_cents: inv.amount_cents, status: inv.status,
      issued_at: inv.issued_at, due_date: inv.due_date, paid_at: inv.paid_at, pay_method: inv.pay_method, check_number: inv.check_number,
      overdue: inv.status === 'open' && inv.due_date && inv.due_date < today(),
      po_number: billTo.po_number || null, bill_to: billTo,
      from: { name: businessName(), address: setting('business_address', '') },
      pay_instructions: setting('pay_instructions', ''),
      can_pay_online: ['open', 'failed'].includes(inv.status) && inv.amount_cents > 0,
      payments_mode: payments.mode(),
    });
  }));

  api.post('/public/invoices/:token/pay', h(async (req, res) => {
    const inv = publicInvoice(req.params.token);
    const method = req.body?.method === 'ach' ? 'ach' : req.body?.method === 'card' ? 'card' : null;
    if (!method) throw bad('Choose card or bank transfer.');
    if (!['open', 'failed'].includes(inv.status)) throw bad(inv.status === 'paid' ? 'This invoice is already paid.' : 'This invoice was voided.');
    if (payments.mode() !== 'test') throw new HttpError(503, 'Online payment isn\'t available yet. Pay by check using the instructions on this invoice.');
    const charge_id = `${method === 'ach' ? 'ach' : 'ch'}_test_${randomToken(9)}`;
    const paid = schools.markPaid(inv.id, { method, charge_id });
    log(null, 'Invoice paid online', `${inv.number}, ${money(inv.amount_cents)} by ${method === 'ach' ? 'bank transfer' : 'card'}`);
    const c = inv.contract_id ? schools.contractWithSchool(inv.contract_id) : null;
    if (c && schools.billTo(c)) sendEmail(schools.billTo(c), `Payment received: invoice ${inv.number}`, `Thank you. We received ${money(inv.amount_cents)} for invoice ${inv.number} by ${method === 'ach' ? 'bank transfer' : 'card'}.\n\n${businessName()}`);
    res.json({ ok: true, status: paid.status, paid_at: paid.paid_at, pay_method: paid.pay_method });
  }));
}

module.exports = { routes };
