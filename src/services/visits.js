// Membership visits (owner's ask: "a number of sessions attached to the membership that, when they check in to a class,
// it pulls from that number so you can keep track of their visits").
// A plan may carry sessions_per_month (NULL = unlimited group classes, as before). A visit is a group-class booking the
// membership covers (booked or attended: a spot held counts, a canceled one doesn't) or a walk-in check-in covered by the
// membership, counted within the membership's paid period: the current one, or the one a future class falls in (the
// period after the current one, worked out the same way as a renewal). Nothing is stored: cancel a booking and the visit
// comes back; the count resets when the next period starts. Once the number is used up the membership doesn't cover the
// next class: it falls to a session credit, the card on file or pay at the session, exactly like a client with no membership.
import { periodFor } from './billing.js';

const LIVE = `status IN ('active','trialing','past_due')`;
export const MAX_SESSIONS_PER_MONTH = 100;

function windowFor(ctx, sub, atIso) {
  let start = sub.current_period_start, end = sub.current_period_end;
  if (atIso < start) return { start, end };                       // a class before the membership started counts in its first period
  for (let i = 0; i < 24 && atIso >= end; i++) { start = end; end = periodFor(ctx, start, 0).end; }
  return { start, end };
}
// { limit, used, left, period_start, period_end, plan_name } for the client's live membership, or null without one.
// limit null = unlimited (left null). at: the moment the visit is for (a class's start, or now for a walk-in).
export function visitsFor(ctx, clientId, atIso = ctx.now()) {
  const sub = ctx.db.get(`SELECT s.id, s.status, s.current_period_start, s.current_period_end, p.name AS plan_name, p.sessions_per_month FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.client_id = ? AND s.${LIVE} LIMIT 1`, clientId);
  if (!sub) return null;
  const w = windowFor(ctx, sub, atIso);
  const booked = ctx.db.get(`SELECT COUNT(*) AS n FROM bookings b JOIN class_sessions x ON x.id = b.session_id
    WHERE b.client_id = ? AND b.coverage = 'membership' AND b.status IN ('booked','attended') AND x.starts_at >= ? AND x.starts_at < ?`, clientId, w.start, w.end).n;
  const walkIns = ctx.db.get(`SELECT COUNT(*) AS n FROM check_ins WHERE client_id = ? AND covered_by = 'membership' AND created_at >= ? AND created_at < ?`, clientId, w.start, w.end).n;
  const used = booked + walkIns, limit = sub.sessions_per_month ?? null;
  return { limit, used, left: limit == null ? null : Math.max(0, limit - used), period_start: w.start, period_end: w.end, plan_name: sub.plan_name, status: sub.status };
}
// Whether the membership covers one more group visit at that moment, with the words for when it doesn't.
export function membershipCovers(ctx, clientId, atIso = ctx.now()) {
  const v = visitsFor(ctx, clientId, atIso);
  if (!v) return { covers: false, member: false, visits: null };
  if (v.left == null || v.left > 0) return { covers: true, member: true, visits: v };
  return { covers: false, member: true, visits: v, reason: `has used all ${v.limit} ${v.plan_name} sessions for this month` };
}
// The visits in the period: for the client page and the API.
export function listVisits(ctx, clientId, atIso = ctx.now()) {
  const v = visitsFor(ctx, clientId, atIso);
  if (!v) return { visits: null, items: [] };
  const items = [
    ...ctx.db.all(`SELECT b.id, b.status, x.name AS session_name, x.starts_at AS at, l.name AS location_name FROM bookings b JOIN class_sessions x ON x.id = b.session_id JOIN locations l ON l.id = x.location_id
      WHERE b.client_id = ? AND b.coverage = 'membership' AND b.status IN ('booked','attended') AND x.starts_at >= ? AND x.starts_at < ?`, clientId, v.period_start, v.period_end).map((r) => ({ kind: 'class', ...r })),
    ...ctx.db.all(`SELECT k.id, k.created_at AS at, l.name AS location_name FROM check_ins k JOIN locations l ON l.id = k.location_id WHERE k.client_id = ? AND k.covered_by = 'membership' AND k.created_at >= ? AND k.created_at < ?`, clientId, v.period_start, v.period_end).map((r) => ({ kind: 'walk_in', status: 'attended', session_name: null, ...r }))
  ].sort((a, b) => a.at.localeCompare(b.at));
  return { visits: v, items };
}
