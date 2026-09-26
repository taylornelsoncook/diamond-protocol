// Shared server helpers: IDs, email outbox, activity log, webhooks, payments, dates.
'use strict';
const crypto = require('crypto');
const { all, get, run, insert, setting } = require('./db');

const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg, extra) => new HttpError(400, msg, extra);
const notFound = (what = 'That record') => new HttpError(404, `${what} wasn't found.`);

// Wrap an async route so thrown errors reach the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Athlete ID: first 3 letters of first name + first 3 of last name + year, e.g. Ava Lopez → AVALOP2026 ----
function makeAthleteCode(first, last) {
  const clean = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  const f = clean(first), l = clean(last);
  const base = ((f + 'XXX').slice(0, 3) + (l + 'XXX').slice(0, 3));
  const year = new Date().getFullYear();
  let code = base + year, n = 2;
  while (get('SELECT 1 FROM athletes WHERE code=?', code)) code = base.slice(0, 5) + n++ + year;
  return code;
}

// ---- Email: every message lands in the outbox. Set DP_EMAIL_WEBHOOK to relay them to a real sender. ----
function sendEmail(to, subject, body) {
  if (!to) return null;
  const id = insert('outbox', { to_email: to, subject, body, status: process.env.DP_EMAIL_WEBHOOK ? 'queued' : 'logged' });
  if (process.env.DP_EMAIL_WEBHOOK) {
    fetch(process.env.DP_EMAIL_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, subject, body }) })
      .then((r) => run('UPDATE outbox SET status=? WHERE id=?', r.ok ? 'sent' : 'failed', id))
      .catch(() => run("UPDATE outbox SET status='failed' WHERE id=?", id));
  }
  return id;
}

// ---- Activity log ----
function log(req, action, detail, kind = 'change') {
  const actor = req?.staff ? `${req.staff.name} (${req.staff.role})` : req?.parent ? `${req.parent.name} (parent)` : req?.apiKey ? `API key ${req.apiKey.label}` : 'System';
  insert('activity', { actor, action, detail: detail || null, ip: req?.ip || null, kind });
}

// ---- Webhooks: fire-and-forget, every delivery recorded ----
const WEBHOOK_EVENTS = ['client.created', 'booking.created', 'booking.cancelled', 'checkin.created', 'payment.succeeded', 'payment.failed', 'invoice.paid', 'result.created', 'pr.set', 'workout.completed', 'program.assigned'];
function emit(event, payload) {
  const hooks = all('SELECT * FROM webhooks WHERE active=1');
  for (const w of hooks) {
    const events = JSON.parse(w.events || '[]');
    if (!events.includes(event)) continue;
    const body = JSON.stringify({ event, created_at: new Date().toISOString(), data: payload });
    const sig = crypto.createHmac('sha256', w.secret || '').update(body).digest('hex');
    const did = insert('webhook_deliveries', { webhook_id: w.id, event, payload: body, status: null });
    fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dp-signature': sig }, body, signal: AbortSignal.timeout(8000) })
      .then((r) => run('UPDATE webhook_deliveries SET status=? WHERE id=?', r.status, did))
      .catch((e) => run('UPDATE webhook_deliveries SET status=0, error=? WHERE id=?', String(e.message || e), did));
  }
}

// ---- Payments ----
// Test mode simulates a processor. Cards ending 0002 decline, like Stripe's test card 4000 0000 0000 0002.
// To go live, replace charge()/refund() with calls to Stripe (PaymentIntents + Terminal for Tap to Pay).
const payments = {
  mode: () => (process.env.STRIPE_SECRET_KEY ? 'live' : 'test'),
  charge({ amount_cents, method, family }) {
    if (amount_cents <= 0) return { ok: true, charge_id: null };
    if (method === 'cash') return { ok: true, charge_id: 'cash_' + randomToken(6) };
    if (method === 'card') {
      if (!family?.card_last4) return { ok: false, error: 'No card on file.' };
      if (family.card_last4 === '0002') return { ok: false, error: 'Card declined.' };
    }
    return { ok: true, charge_id: 'ch_test_' + randomToken(9) };
  },
  refund({ charge_id, amount_cents }) { return { ok: true, refund_id: 're_test_' + randomToken(9), amount_cents, charge_id }; },
};

// ---- Money & dates ----
const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
const today = () => localDate(new Date());
function localDate(d) { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + n); return localDate(d); }
function addMonths(dateStr, n) { const d = new Date(dateStr + 'T12:00:00'); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return localDate(d); }
function ageOn(birthday, on = today()) {
  if (!birthday) return null;
  const b = new Date(birthday + 'T12:00:00'), d = new Date(on + 'T12:00:00');
  let a = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a--;
  return a;
}
function nextInvoiceNumber(prefix = 'DP') {
  const y = new Date().getFullYear();
  const r = get("SELECT number FROM invoices WHERE number LIKE ? ORDER BY id DESC LIMIT 1", `${prefix}-${y}-%`);
  const n = r ? Number(r.number.split('-').pop()) + 1 : 1;
  return `${prefix}-${y}-${String(n).padStart(4, '0')}`;
}
const businessName = () => setting('business_name', 'Diamond Protocol');
const appUrl = () => (process.env.DP_APP_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/$/, '');

module.exports = { randomToken, sha256, HttpError, bad, notFound, h, makeAthleteCode, sendEmail, log, emit, WEBHOOK_EVENTS, payments, money, today, localDate, addDays, addMonths, ageOn, nextInvoiceNumber, businessName, appUrl };
