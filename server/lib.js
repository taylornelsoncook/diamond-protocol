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

// ---- Email: saved to the outbox, then sent by the configured provider (see server/email.js). ----
function sendEmail(to, subject, body) { return require('./email').sendEmail(to, subject, body); }

// ---- Activity log ----
function log(req, action, detail, kind = 'change') {
  const actor = req?.staff ? `${req.staff.name} (${req.staff.role})` : req?.parent ? `${req.parent.name} (parent)` : req?.apiKey ? `API key ${req.apiKey.label}` : 'System';
  insert('activity', { actor, action, detail: detail || null, ip: req?.ip || null, kind });
}

// ---- Webhooks: fire-and-forget, every delivery recorded ----
const WEBHOOK_EVENTS = ['client.created', 'booking.created', 'booking.cancelled', 'checkin.created', 'payment.succeeded', 'payment.failed', 'invoice.paid', 'result.created', 'pr.set', 'workout.completed', 'program.assigned', 'lead.created', 'lead.stage_changed'];
function emit(event, payload) {
  const hooks = all('SELECT * FROM webhooks WHERE active=1');
  for (const w of hooks) {
    const events = JSON.parse(w.events || '[]');
    if (!events.includes(event)) continue;
    // Signed, recorded and retried by services/ops-webhooks (delivery id and event in headers too).
    require('./services/ops-webhooks').deliver(w, event, payload);
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
// Today's date in the business time zone (Settings), the same day Today, Schedule and the parent portal use.
// The server itself usually runs in UTC, where a Provo evening is already tomorrow.
function today() {
  let tz = setting('timezone', 'America/Denver');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = 'America/Denver'; }
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
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
// For invoice descriptions, receipts and emails: "Sun, Sep 27 at 5:30 PM" from a local wall-clock "YYYY-MM-DDTHH:MM",
// and "August 2026" from "2026-08".
function whenLocal(startsAt) {
  const d = new Date(String(startsAt).slice(0, 16) + ':00Z');
  if (Number.isNaN(d.getTime())) return String(startsAt);
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`;
}
function monthLabel(ym) {
  const d = new Date(String(ym).slice(0, 7) + '-15T12:00:00Z');
  return Number.isNaN(d.getTime()) ? String(ym) : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
const businessName = () => setting('business_name', 'Diamond Protocol');
// Render sets RENDER_EXTERNAL_URL automatically, so email links work without extra setup.
const appUrl = () => (process.env.DP_APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/$/, '');

module.exports = { randomToken, sha256, HttpError, bad, notFound, h, makeAthleteCode, sendEmail, log, emit, WEBHOOK_EVENTS, payments, money, today, localDate, addDays, addMonths, ageOn, nextInvoiceNumber, businessName, appUrl, whenLocal, monthLabel };
