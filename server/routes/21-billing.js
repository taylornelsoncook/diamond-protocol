// Billing: plans, every invoice, retries, recording payments, and the public invoice page's API.
'use strict';
const { get, all, run, insert, update, tx, setting } = require('../db');
const { h, bad, notFound, HttpError, log, payments, randomToken, money, businessName, sendEmail, today } = require('../lib');
const { requireStaff } = require('../auth');
const billing = require('../services/billing');
const schools = require('../services/money-schools');
const clock = require('../services/money-clock');

const isOwner = (req) => req.staff?.role === 'owner';
const toCents = (v) => { const n = Math.round(Number(String(v ?? '').replace(/[$,\s]/g, '')) * 100); return Number.isFinite(n) ? n : NaN; };
function centsFrom(b, key = 'price') {
  if (b[`${key}_cents`] != null && b[`${key}_cents`] !== '') return Math.round(Number(b[`${key}_cents`]));
  return toCents(b[key]);
}
const optInt = (v) => (v === '' || v == null ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : (() => { throw bad('Use a whole number, 0 or more.'); })());

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

  api.post('/plans', requireStaff('owner'), h(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw bad('Name the plan.');
    const price = centsFrom(b);
    if (!(price > 0)) throw bad('Enter a monthly price.');
    if (get('SELECT 1 FROM plans WHERE name=? AND active=1', name)) throw bad('A plan with that name already exists.');
    const id = insert('plans', { name, price_cents: price, trial_days: optInt(b.trial_days) ?? 0, group_per_month: optInt(b.group_per_month), private_per_month: optInt(b.private_per_month) ?? 0 });
    log(req, 'Created plan', name); // no prices: coaches can read the activity feed
    res.status(201).json({ id });
  }));

  // Price changes apply from each member's next charge: every live membership on the plan takes the new price.
  api.put('/plans/:id', requireStaff('owner'), h(async (req, res) => {
    const p = get('SELECT * FROM plans WHERE id=?', Number(req.params.id));
    if (!p) throw notFound('That plan');
    const b = req.body || {};
    const patch = {};
    if ('name' in b) { patch.name = String(b.name || '').trim(); if (!patch.name) throw bad('Name the plan.'); }
    if ('price' in b || 'price_cents' in b) { patch.price_cents = centsFrom(b); if (!(patch.price_cents > 0)) throw bad('Enter a monthly price.'); }
    if ('trial_days' in b) patch.trial_days = optInt(b.trial_days) ?? 0;
    if ('group_per_month' in b) patch.group_per_month = optInt(b.group_per_month);
    if ('private_per_month' in b) patch.private_per_month = optInt(b.private_per_month) ?? 0;
    if ('active' in b) patch.active = b.active ? 1 : 0;
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

  // ---- invoices (owner) ----
  api.get('/invoices', requireStaff('owner'), (req, res) => {
    const where = ['1=1'], p = [];
    const { status, kind, q } = req.query;
    if (status === 'overdue') { where.push("i.status='open' AND i.due_date < ?"); p.push(today()); }
    else if (status) { where.push('i.status=?'); p.push(String(status)); }
    if (kind) { where.push('i.kind=?'); p.push(String(kind)); }
    if (q) { const like = `%${q}%`; where.push("(i.number LIKE ? OR i.description LIKE ? OR a.first_name || ' ' || a.last_name LIKE ? OR f.name LIKE ? OR s.name LIKE ?)"); p.push(like, like, like, like, like); }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(all(`SELECT i.id, i.number, i.kind, i.description, i.amount_cents, i.status, i.issued_at, i.due_date, i.paid_at, i.pay_method, i.check_number,
        i.attempts, i.next_retry, i.period, i.view_token, i.athlete_id, i.family_id, i.contract_id, i.created_at,
        a.first_name, a.last_name, f.name AS family, pl.name AS plan_name, t.team_name, s.name AS school
      FROM invoices i LEFT JOIN athletes a ON a.id=i.athlete_id LEFT JOIN families f ON f.id=i.family_id
      LEFT JOIN memberships m ON m.id=i.membership_id LEFT JOIN plans pl ON pl.id=m.plan_id
      LEFT JOIN team_contracts t ON t.id=i.contract_id LEFT JOIN schools s ON s.id=t.school_id
      WHERE ${where.join(' AND ')} ORDER BY i.issued_at DESC, i.id DESC LIMIT ?`, ...p, limit));
  });

  api.post('/invoices/:id/retry', requireStaff('owner'), h(async (req, res) => {
    const inv = invoiceRow(Number(req.params.id));
    if (inv.status !== 'failed') throw bad('Only declined charges can be retried.');
    const r = billing.retryFailed({ invoiceId: inv.id });
    const after = invoiceRow(inv.id);
    const who = inv.athlete_id ? get("SELECT first_name || ' ' || last_name AS n FROM athletes WHERE id=?", inv.athlete_id)?.n : inv.number;
    log(req, r.paid ? 'Retried payment: paid' : 'Retried payment: declined again', `${who}, ${money(inv.amount_cents)} (${inv.number})`);
    if (!r.paid) throw bad('The card was declined again. It retries on its own every 3 days, or ask the family to update their card.');
    res.json({ ok: true, invoice: after });
  }));

  api.post('/invoices/:id/record-payment', requireStaff('owner'), h(async (req, res) => {
    const inv = invoiceRow(Number(req.params.id));
    const b = req.body || {};
    const paid = schools.markPaid(inv.id, { method: b.method || 'check', check_number: b.check_number, paid_on: b.paid_on || null });
    log(req, 'Recorded invoice payment', `${inv.number}, ${money(inv.amount_cents)} by ${paid.pay_method}${paid.check_number ? ` #${paid.check_number}` : ''}`);
    res.json({ ok: true, invoice: paid });
  }));

  api.post('/invoices/:id/email', requireStaff('owner'), h(async (req, res) => {
    const inv = invoiceRow(Number(req.params.id));
    if (inv.status === 'void') throw bad('That invoice was voided.');
    const to = schools.emailInvoice(inv.id);
    log(req, 'Emailed invoice', `${inv.number} to ${to}`);
    res.json({ ok: true, to });
  }));

  api.post('/invoices/:id/void', requireStaff('owner'), h(async (req, res) => {
    const inv = schools.voidInvoice(Number(req.params.id));
    log(req, 'Voided invoice', `${inv.number}, ${money(inv.amount_cents)}`);
    res.json({ ok: true });
  }));

  // ---- billing clock (test mode only) ----
  api.post('/billing/run', requireStaff('owner'), h(async (req, res) => {
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
