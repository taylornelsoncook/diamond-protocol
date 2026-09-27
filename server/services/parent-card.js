// Card checks for the test-mode hosted card page. Only brand, last 4 and expiry are ever kept.
'use strict';

function luhnValid(num) {
  const s = String(num).replace(/\D/g, '');
  if (s.length < 12) return false;
  let sum = 0, dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = +s[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function cardBrand(num) {
  const s = String(num);
  if (/^4/.test(s)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(s)) return 'Mastercard';
  if (/^3[47]/.test(s)) return 'Amex';
  if (/^(6011|65|64[4-9])/.test(s)) return 'Discover';
  return 'Card';
}

// "08/29", "8/2029", "0829" → { label: "08/29", expired }
function parseExpiry(v, now = new Date()) {
  const m = String(v || '').trim().match(/^(\d{1,2})\s*\/?\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]); let yy = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  if (yy < 100) yy += 2000;
  const expired = yy < now.getFullYear() || (yy === now.getFullYear() && mm < now.getMonth() + 1);
  return { label: `${String(mm).padStart(2, '0')}/${String(yy % 100).padStart(2, '0')}`, expired };
}

// ---- family account: payments, past-due charges, what blocks removing the card ----
const { all, get } = require('../db');

// A parent can try a declined membership charge again from the portal, up to this many attempts in all.
const PARENT_RETRY_MAX = 8;
const LIVE_MEMBERSHIP = "('trial','active','past_due','paused')";

// Charges and refunds for one family, newest first. Receipts only for money that actually moved.
function familyPayments(familyId, limit = 100) {
  const rows = all(`SELECT i.id, i.number, i.kind, i.description, i.amount_cents, i.status, i.issued_at, i.paid_at, i.attempts, i.view_token,
      a.first_name AS athlete_first
    FROM invoices i LEFT JOIN athletes a ON a.id=i.athlete_id
    WHERE i.family_id=? AND i.kind IN ('membership','charge') AND i.status IN ('paid','failed','open')
    ORDER BY COALESCE(i.paid_at, i.issued_at, i.created_at) DESC, i.id DESC LIMIT ?`, familyId, limit + 1);
  const more = rows.length > limit;
  return {
    more,
    items: rows.slice(0, limit).map((r) => ({
      id: r.id, number: r.number, description: r.description, athlete: r.athlete_first || null, amount_cents: r.amount_cents,
      status: r.status, refund: r.amount_cents < 0, date: (r.paid_at || r.issued_at || '').slice(0, 10) || null,
      receipt: r.status === 'paid' ? r.view_token : null,
      can_retry: r.status === 'failed' && r.kind === 'membership' && r.attempts < PARENT_RETRY_MAX,
    })),
  };
}

// Money paid (net of refunds) since Jan 1 of this year.
function paidThisYear(familyId, year = new Date().getFullYear()) {
  return get(`SELECT COALESCE(SUM(amount_cents),0) n FROM invoices WHERE family_id=? AND status='paid' AND kind IN ('membership','charge')
    AND COALESCE(paid_at, issued_at) >= ?`, familyId, `${year}-01-01`).n;
}

function pastDue(familyId) {
  return all(`SELECT i.id, i.description, i.amount_cents, i.issued_at, a.first_name AS athlete_first FROM invoices i LEFT JOIN athletes a ON a.id=i.athlete_id
    WHERE i.family_id=? AND i.status='failed' AND i.kind='membership' ORDER BY i.id`, familyId);
}

// Why the card can't be removed right now, or null when it can.
function cardRemovalBlock(familyId) {
  const m = get(`SELECT a.first_name, m.status FROM memberships m JOIN athletes a ON a.id=m.athlete_id
    WHERE a.family_id=? AND m.status IN ${LIVE_MEMBERSHIP} ORDER BY m.id LIMIT 1`, familyId);
  if (m) return `${m.first_name}'s membership is paid with this card. Replace the card instead, or ask to cancel the membership first.`;
  if (pastDue(familyId).length) return 'A past-due payment is waiting on this card. Replace the card instead so it can be paid.';
  return null;
}

// Phone numbers: optional, but when given they need enough digits to call (7 to 15).
function phoneOk(v) {
  if (!v) return true;
  const d = String(v).replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15 && /^[\d\s()+.\-x]+$/i.test(String(v));
}

module.exports = { luhnValid, cardBrand, parseExpiry, familyPayments, paidThisYear, pastDue, cardRemovalBlock, phoneOk, PARENT_RETRY_MAX };
