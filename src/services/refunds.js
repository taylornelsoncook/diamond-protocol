// The refunds report (Billing → Refunds, owner only): every refund that went back to a family, newest first, with the
// athlete's name and how to reach the family (the athlete's own email and phone, or else the primary parent's).
// Three kinds of refund are listed, the same ones Billing and Today count:
//   membership: a refund of a membership payment (invoice_refunds; in the app or in the Stripe dashboard)
//   sale:       a refund or undo of an in-person or online sale (sale_refunds; in the app or in the Stripe dashboard)
//   paid_twice: a card approval that came in after the membership was already paid, refunded automatically
//               (invoice_charges.late_outcome = 'refunded')
// Dates are business-local days (?from=, ?to=); a refund counts on the day the money went back.
import { badRequest, isDate, zonedToUtc, addDaysToDate, localDate } from '../util.js';
import { getSetting } from './families.js';
import { csvCell } from './clients.js';

export const REFUND_KINDS = { membership: 'Membership', sale: 'Sale', paid_twice: 'Paid twice (automatic)' };
const zone = (ctx) => getSetting(ctx, 'timezone');

function filterOf(ctx, query = {}) {
  for (const [k, label] of [['from', 'start'], ['to', 'end']]) if (query[k] && !isDate(String(query[k]))) throw badRequest(`Choose a real ${label} date, like 2026-09-01.`);
  if (query.from && query.to && String(query.from) > String(query.to)) throw badRequest('The start date is after the end date. Swap them.');
  const kind = query.kind ? String(query.kind) : '';
  if (kind && !REFUND_KINDS[kind]) throw badRequest(`kind must be one of ${Object.keys(REFUND_KINDS).join(', ')}.`);
  const z = zone(ctx);
  return {
    from: query.from ? zonedToUtc(String(query.from), '00:00', z) : '0000',
    to: query.to ? zonedToUtc(addDaysToDate(String(query.to), 1), '00:00', z) : '9999',
    kind, q: String(query.q ?? '').trim().toLowerCase().slice(0, 100)
  };
}

// The athlete's contact, else the family's primary parent (the one who pays and gets the receipts).
const CONTACT = (alias) => `
  COALESCE(NULLIF(${alias}.email, ''), (SELECT g.email FROM guardians g WHERE g.family_id = ${alias}.family_id ORDER BY g.is_primary DESC, g.created_at LIMIT 1)) AS email,
  COALESCE(NULLIF(${alias}.phone, ''), (SELECT g.phone FROM guardians g WHERE g.family_id = ${alias}.family_id ORDER BY g.is_primary DESC, g.created_at LIMIT 1)) AS phone,
  CASE WHEN NULLIF(${alias}.email, '') IS NULL AND ${alias}.family_id IS NOT NULL
    THEN (SELECT g.name FROM guardians g WHERE g.family_id = ${alias}.family_id ORDER BY g.is_primary DESC, g.created_at LIMIT 1) END AS parent_name`;

function rows(ctx, f) {
  const out = [];
  if (!f.kind || f.kind === 'membership') out.push(...ctx.db.all(`
    SELECT r.id, 'membership' AS kind, r.created_at AS refunded_at, r.amount_cents, r.reason, r.source, COALESCE((SELECT u.name FROM users u WHERE u.id = r.created_by), r.created_by) AS created_by,
      c.id AS client_id, c.name AS athlete_name, c.athlete_id, ${CONTACT('c')},
      'Membership: ' || COALESCE(p.name, 'plan') AS what, i.id AS invoice_id, NULL AS sale_id
    FROM invoice_refunds r JOIN invoices i ON i.id = r.invoice_id
    LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN subscriptions s ON s.id = i.subscription_id LEFT JOIN plans p ON p.id = s.plan_id
    WHERE r.created_at >= ? AND r.created_at < ?`, f.from, f.to));
  if (!f.kind || f.kind === 'sale') out.push(...ctx.db.all(`
    SELECT r.id, 'sale' AS kind, r.created_at AS refunded_at, r.amount_cents, r.reason, CASE WHEN r.created_by IS NULL AND r.reason = 'Refunded in the Stripe dashboard' THEN 'stripe' ELSE 'app' END AS source,
      CASE WHEN r.kind = 'undo' THEN COALESCE((SELECT u.name FROM users u WHERE u.id = r.created_by), r.created_by, '') || ' (undo)' ELSE COALESCE((SELECT u.name FROM users u WHERE u.id = r.created_by), r.created_by) END AS created_by,
      c.id AS client_id, c.name AS athlete_name, c.athlete_id, ${CONTACT('c')},
      COALESCE((SELECT GROUP_CONCAT(CASE WHEN it.quantity > 1 THEN it.quantity || ' × ' || it.name ELSE it.name END, ', ') FROM sale_items it WHERE it.sale_id = s.id), 'Sale') AS what,
      NULL AS invoice_id, s.id AS sale_id
    FROM sale_refunds r JOIN sales s ON s.id = r.sale_id LEFT JOIN clients c ON c.id = s.client_id
    WHERE r.created_at >= ? AND r.created_at < ?`, f.from, f.to));
  if (!f.kind || f.kind === 'paid_twice') out.push(...ctx.db.all(`
    SELECT ch.id, 'paid_twice' AS kind, ch.late_at AS refunded_at, ch.amount_cents, 'Charged ' || COALESCE(ch.late_reason, 'after it was paid') AS reason, 'app' AS source, 'Automatic' AS created_by,
      c.id AS client_id, c.name AS athlete_name, c.athlete_id, ${CONTACT('c')},
      'Membership: ' || COALESCE(p.name, 'plan') AS what, i.id AS invoice_id, NULL AS sale_id
    FROM invoice_charges ch JOIN invoices i ON i.id = ch.invoice_id
    LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN subscriptions s ON s.id = i.subscription_id LEFT JOIN plans p ON p.id = s.plan_id
    WHERE ch.late_outcome = 'refunded' AND ch.late_at >= ? AND ch.late_at < ?`, f.from, f.to));
  const q = f.q;
  const hit = (r) => !q || [r.athlete_name, r.athlete_id, r.email, r.phone, r.parent_name, r.what, r.reason].some((x) => String(x ?? '').toLowerCase().includes(q))
    || (/\d{4,}/.test(q.replace(/\D/g, '')) && String(r.phone ?? '').replace(/\D/g, '').includes(q.replace(/\D/g, '')));
  return out.filter(hit).sort((a, b) => String(b.refunded_at).localeCompare(String(a.refunded_at)) || String(b.id).localeCompare(String(a.id)))
    .map((r) => ({ ...r, athlete_name: r.athlete_name ?? null, by: r.source === 'stripe' ? 'Stripe dashboard' : r.created_by ?? null }));
}

// GET /v1/billing/refunds: the refunds in the filter (?from=, ?to=, ?kind=, ?q= athlete, Athlete ID, email, phone, item
// or reason; ?limit= up to 1000) with the count and total for the whole filter.
export function refundReport(ctx, query = {}) {
  const f = filterOf(ctx, query);
  const all = rows(ctx, f);
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 1000);
  const byKind = Object.fromEntries(Object.keys(REFUND_KINDS).map((k) => [k, all.filter((r) => r.kind === k).reduce((t, r) => t + r.amount_cents, 0)]));
  return { data: all.slice(0, limit), count: all.length, total_cents: all.reduce((t, r) => t + r.amount_cents, 0), by_kind_cents: byKind, limit, kinds: REFUND_KINDS };
}

// The same filter as a spreadsheet (amounts in dollars as plain numbers; text a spreadsheet would run as a formula is made safe).
const phoneText = (p) => (/^\+1\d{10}$/.test(p ?? '') ? `(${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}` : p);
export function exportRefunds(ctx, query = {}) {
  const f = filterOf(ctx, query);
  const all = rows(ctx, f);
  const z = zone(ctx);
  const head = ['Refunded on', 'Athlete', 'Athlete ID', 'Email', 'Phone', 'Parent', 'Kind', 'For', 'Amount', 'Reason', 'Refunded by'];
  const lines = all.map((r) => [localDate(r.refunded_at, z), r.athlete_name ?? 'No client', r.athlete_id ?? '', r.email ?? '', phoneText(r.phone) ?? '', r.parent_name ?? '',
    REFUND_KINDS[r.kind], r.what, (r.amount_cents / 100).toFixed(2), r.reason ?? '', r.by ?? '']);
  const body = [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n');
  return { filename: `refunds-${localDate(ctx.now(), z)}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(`﻿${body}\r\n`), count: all.length };
}
