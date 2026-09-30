// Parent portal read models and family self-service (batches B12 and B13): session rows and details, the private
// calendar feed, membership panel and change requests, payments and receipts, retrying a declined charge, removing the
// card, parents and devices, and the "to finish" list. Every function takes the signed-in parent's family and never
// reads another family's data; routes in portal-routes.js pass r.guardian.
import { v, notFound, conflict, badRequest, HttpError, newId, token, sha256, localDate, addDaysToDate, withLock } from '../util.js';
import { getSetting, getFamily, cardExpiry, addGuardian, updateGuardian, payerFor } from './families.js';
import * as billing from './billing.js';
import * as commerce from './commerce.js';
import { feeSettings, cardFee } from './fees.js';
import { attendance } from './clients.js';
import { education } from './engage.js';
import { getTest } from './performance.js';
import { sendEmail } from './mail.js';
import { portalInvite } from './notify.js';
import { emit } from './events.js';

const tz = (ctx) => getSetting(ctx, 'timezone');
const biz = (ctx) => getSetting(ctx, 'business_name');
const first = (name) => String(name ?? '').split(' ')[0];
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const when = (ctx, iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz(ctx), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const day = (ctx, iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz(ctx), month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso));
const digits = (p) => String(p ?? '').replace(/\D/g, '');
const ownerEmails = (ctx) => ctx.db.all(`SELECT name, email FROM users WHERE role = 'owner' AND active = 1`);
const mail = (ctx, to, subject, text) => sendEmail(ctx, { to, subject, text }).catch((e) => console.error('email', e.message));

export const MAX_ATHLETES = 12, MAX_PARENTS = 6, PORTAL_RETRY_LIMIT = 8;

// A family's athletes the parent can see: archived athletes are hidden from the family (their coach reopens them).
export const familyAthletes = (ctx, familyId) => ctx.db.all('SELECT * FROM clients WHERE family_id = ? AND archived_at IS NULL ORDER BY name', familyId);
export function athleteOfFamily(ctx, familyId, id) {
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ? AND family_id = ? AND archived_at IS NULL', String(id ?? ''), familyId);
  if (!c) throw notFound('Athlete');
  return c;
}

// ---------- Sessions: rows on Home and Book, details, calendar ----------
const addressOf = (l) => [l.address_line1, [l.city, l.state].filter(Boolean).join(', '), l.postal_code].filter(Boolean).join(', ');
const HOMEISH = ['mobile', 'client_home'];
// Where the session is, and a Directions link for a place with an address (not "your home").
export function placeOf(l) {
  const address = HOMEISH.includes(l.location_kind) ? null : addressOf(l) || null;
  return { location_name: l.location_name, address, directions_url: address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${l.location_name}, ${address}`)}` : null };
}
const BOOKING_SQL = `SELECT b.id, b.status, b.coverage, b.credit_type, b.note, b.created_at, b.client_id, s.id AS session_id, s.name AS session_name, s.kind, s.starts_at, s.ends_at, s.series_id,
    l.name AS location_name, l.kind AS location_kind, l.address_line1, l.city, l.state, l.postal_code, u.name AS coach_name, e.kind AS enrollment_kind, sa.amount_cents AS paid_cents, sa.refunded_cents,
    (SELECT COUNT(*) FROM bookings w WHERE w.session_id = s.id AND w.status = 'waitlisted') AS waiting,
    (SELECT COUNT(*) FROM bookings w WHERE w.session_id = s.id AND w.status = 'waitlisted' AND (w.created_at < b.created_at OR (w.created_at = b.created_at AND w.id < b.id))) AS ahead
  FROM bookings b JOIN class_sessions s ON s.id = b.session_id JOIN locations l ON l.id = s.location_id LEFT JOIN users u ON u.id = s.coach_id
  LEFT JOIN enrollments e ON e.id = b.enrollment_id LEFT JOIN sales sa ON sa.id = b.sale_id`;
// How a booking is paid: membership, credit (from a pack), paid (card), registration (camp), unpaid (pay at the session),
// waitlist (nothing charged yet), team (billed to the school or club) or free.
const howPaid = (b) => (b.status === 'waitlisted' ? 'waitlist' : b.kind === 'team' ? 'team' : b.coverage === 'none' ? 'free' : b.coverage);
function shapeBooking(ctx, b, lateHours) {
  const now = ctx.now();
  const cancellable = ['booked', 'waitlisted'].includes(b.status) && b.starts_at > now && b.kind !== 'team' && b.enrollment_kind !== 'registration';
  const name = ['private', 'evaluation'].includes(b.kind) && !b.series_id ? (b.kind === 'private' ? 'Private session' : 'Evaluation') : b.session_name;
  return {
    id: b.id, status: b.status, client_id: b.client_id, session_id: b.session_id, session_name: name, kind: b.kind, starts_at: b.starts_at, ends_at: b.ends_at,
    ...placeOf(b), coach_name: b.coach_name ?? null, note: b.note ?? null,
    how_paid: howPaid(b), credit_type: b.credit_type ?? null, paid_cents: b.coverage === 'paid' ? b.paid_cents ?? null : null,
    waitlist_place: b.status === 'waitlisted' ? b.ahead + 1 : null, waiting: b.waiting,
    on_now: b.starts_at <= now && b.ends_at > now, checked_in: b.status === 'attended',
    late_from: b.status === 'booked' ? new Date(Date.parse(b.starts_at) - lateHours * 3600000).toISOString() : null,
    can_cancel: cancellable, camp_registration: b.enrollment_kind === 'registration'
  };
}
// Upcoming bookings (and today's that are on now or checked in) for one athlete.
export function athleteBookings(ctx, clientId, { limit = 40 } = {}) {
  const hours = Number(getSetting(ctx, 'late_cancel_hours'));
  return ctx.db.all(`${BOOKING_SQL} WHERE b.client_id = ? AND s.status = 'scheduled' AND s.ends_at > ? AND b.status IN ('booked','waitlisted','attended') ORDER BY s.starts_at LIMIT ?`, clientId, ctx.now(), limit)
    .map((b) => shapeBooking(ctx, b, hours));
}
export function familyBooking(ctx, familyId, bookingId) {
  const b = ctx.db.get(`${BOOKING_SQL} JOIN clients c ON c.id = b.client_id WHERE b.id = ? AND c.family_id = ? AND c.archived_at IS NULL`, String(bookingId ?? ''), familyId);
  if (!b) throw notFound('Booking');
  return shapeBooking(ctx, b, Number(getSetting(ctx, 'late_cancel_hours')));
}

// ---------- Private calendar feed ----------
// One private address per parent for Apple, Google or Outlook calendars: the family's booked sessions from two weeks ago
// to three months ahead. Only a hash of the secret is stored (the address is shown once, when made); resetting makes a
// new address and the old one stops working at once. The feed has first names, session names, times and places: no
// Athlete IDs, birthdays, medical notes, emails or phone numbers.
const hashCal = (s) => sha256(`calendar:${s}`);
export const calendarStatus = (g) => ({ on: !!g.calendar_token_hash, created_at: g.calendar_created_at ?? null });
export function resetCalendar(ctx, guardian, baseUrl) {
  const secret = token(24);
  ctx.db.run('UPDATE guardians SET calendar_token_hash = ?, calendar_created_at = ? WHERE id = ?', hashCal(secret), ctx.now(), guardian.id);
  const url = `${baseUrl ?? ctx.publicUrl ?? ''}/cal/${secret}.ics`;
  return { on: true, created_at: ctx.now(), url, webcal: url.replace(/^https?:/, 'webcal:') };
}
export function stopCalendar(ctx, guardian) {
  ctx.db.run('UPDATE guardians SET calendar_token_hash = NULL, calendar_created_at = NULL WHERE id = ?', guardian.id);
  return { on: false, created_at: null };
}
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Lines longer than 75 bytes are folded (a line break and a space), as calendar apps expect.
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
export function calendarFeed(ctx, secret, host = 'diamondprotocol') {
  const gone = new HttpError(404, 'not_found', 'This calendar link was reset or turned off. Get the new one in the parent portal.');
  if (typeof secret !== 'string' || !/^[\w-]{20,64}$/.test(secret)) throw gone;
  const g = ctx.db.get('SELECT id, family_id FROM guardians WHERE calendar_token_hash = ?', hashCal(secret));
  if (!g) throw gone;
  const from = new Date(Date.parse(ctx.now()) - 14 * 86400000).toISOString(), to = new Date(Date.parse(ctx.now()) + 92 * 86400000).toISOString();
  const rows = ctx.db.all(`${BOOKING_SQL} JOIN clients c ON c.id = b.client_id WHERE c.family_id = ? AND c.archived_at IS NULL AND s.status = 'scheduled' AND s.starts_at >= ? AND s.starts_at < ?
    AND b.status IN ('booked','waitlisted','attended') ORDER BY s.starts_at`, g.family_id, from, to);
  const names = new Map(ctx.db.all('SELECT id, name FROM clients WHERE family_id = ?', g.family_id).map((c) => [c.id, first(c.name)]));
  const hours = Number(getSetting(ctx, 'late_cancel_hours'));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${icsText(biz(ctx))}//Parent portal//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`${biz(ctx)} sessions`)}`, 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const r of rows) {
    const b = shapeBooking(ctx, r, hours), place = [b.location_name, b.address].filter(Boolean).join(', ');
    lines.push('BEGIN:VEVENT', `UID:${b.id}@${host}`, `DTSTAMP:${icsTime(ctx.now())}`, `DTSTART:${icsTime(b.starts_at)}`, `DTEND:${icsTime(b.ends_at)}`,
      `SUMMARY:${icsText(`${names.get(r.client_id) ?? 'Athlete'}: ${b.session_name}${b.status === 'waitlisted' ? ' (waitlist)' : ''}`)}`,
      `LOCATION:${icsText(place)}`,
      `DESCRIPTION:${icsText([b.coach_name ? `Coach: ${b.coach_name}` : null, b.status === 'waitlisted' ? `On the waitlist (number ${b.waitlist_place} in line). We'll email you if a spot opens.` : null, 'Cancel or see details in the parent portal.'].filter(Boolean).join('\n'))}`,
      `STATUS:${b.status === 'waitlisted' ? 'TENTATIVE' : 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- Membership panel and change requests ----------
const REQUEST_KINDS = ['switch', 'pause', 'cancel'];
const requestCols = `r.id, r.kind, r.status, r.note, r.created_at, r.resolved_at, r.resolved_by, r.resolution_note, r.guardian_name, r.plan_id, p.name AS plan_name`;
const openRequest = (ctx, clientId) => ctx.db.get(`SELECT ${requestCols} FROM membership_requests r LEFT JOIN plans p ON p.id = r.plan_id WHERE r.client_id = ? AND r.status = 'open'`, clientId) ?? null;
export function membershipPanel(ctx, clientId) {
  const s = ctx.db.get(`SELECT s.*, p.name AS plan_name, p.price_cents, pp.name AS pending_plan_name, pp.price_cents AS pending_price_cents FROM subscriptions s JOIN plans p ON p.id = s.plan_id LEFT JOIN plans pp ON pp.id = s.pending_plan_id WHERE s.client_id = ? AND s.status != 'canceled' ORDER BY s.created_at DESC LIMIT 1`, clientId);
  const lastDone = ctx.db.get(`SELECT ${requestCols} FROM membership_requests r LEFT JOIN plans p ON p.id = r.plan_id WHERE r.client_id = ? AND r.status IN ('done','declined') AND r.resolved_at > ? ORDER BY r.resolved_at DESC LIMIT 1`,
    clientId, new Date(Date.parse(ctx.now()) - 30 * 86400000).toISOString()) ?? null;
  const pastDue = s ? ctx.db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM invoices WHERE subscription_id = ? AND status = 'failed'`, s.id).n : 0;
  return {
    membership: s ? { status: s.status, plan_id: s.plan_id, plan_name: s.plan_name, price_cents: s.price_cents, fee_cents: cardFee(ctx, s.price_cents, 'memberships').cents, fee_label: feeSettings(ctx).label, trial_ends_at: s.status === 'trialing' ? s.trial_ends_at : null,
      next_charge_at: ['active', 'trialing', 'past_due'].includes(s.status) ? s.current_period_end : null, renews: s.current_period_end, past_due_cents: pastDue,
      pending_plan_name: s.pending_plan_name ?? null, pending_price_cents: s.pending_price_cents ?? null,   // the owner set a change for the renewal
      can_ask: s.status === 'paused' ? ['switch', 'cancel'] : REQUEST_KINDS } : null,
    request: openRequest(ctx, clientId), last_answer: lastDone
  };
}
// Ask the owner to switch plans, pause or cancel. Nothing about billing changes here: the owner is emailed, sees it on the
// athlete's client page and makes the change by hand. One open request per athlete (the database holds to that too).
export function requestMembershipChange(ctx, guardian, clientId, body = {}) {
  const c = athleteOfFamily(ctx, guardian.family_id, clientId);
  const kind = typeof body.kind === 'string' && REQUEST_KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) throw badRequest('Choose what you\'d like: switch plans, pause or cancel.');
  if (body.note != null && typeof body.note !== 'string') throw badRequest('The note has to be text.');
  const note = body.note ? v.str(body.note, 'note', { max: 500, optional: true }) : null;
  const panel = membershipPanel(ctx, c.id), m = panel.membership;
  if (!m) throw conflict(`${first(c.name)} has no membership to change. Start one on the Programs tab.`);
  if (!m.can_ask.includes(kind)) throw conflict(`${first(c.name)}'s membership is already paused. You can ask to switch plans or cancel.`);
  let planId = null;
  if (kind === 'switch') {
    planId = v.str(body.plan_id, 'plan_id', { max: 64 });
    const p = ctx.db.get('SELECT id, name, active FROM plans WHERE id = ?', planId);
    if (!p || !p.active) throw badRequest('Choose one of the plans on this page.');
    if (p.id === m.plan_id) throw badRequest(`${first(c.name)} is already on ${p.name}.`);
  }
  if (panel.request) throw conflict(`You already asked about ${first(c.name)}'s membership on ${day(ctx, panel.request.created_at)}. We'll be in touch; withdraw that request to ask something else.`);
  const id = newId('mrq'), sub = ctx.db.get(`SELECT id FROM subscriptions WHERE client_id = ? AND status != 'canceled' ORDER BY created_at DESC LIMIT 1`, c.id);
  try {
    ctx.db.run(`INSERT INTO membership_requests (id, client_id, subscription_id, guardian_id, guardian_name, kind, plan_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      id, c.id, sub.id, guardian.id, guardian.name, kind, planId, note, ctx.now());
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw conflict(`You already asked about ${first(c.name)}'s membership. We'll be in touch.`);
    throw e;
  }
  const r = openRequest(ctx, c.id);
  const what = kind === 'switch' ? `switch ${first(c.name)} from ${m.plan_name} to ${r.plan_name}` : kind === 'pause' ? `pause ${first(c.name)}'s ${m.plan_name}` : `cancel ${first(c.name)}'s ${m.plan_name}`;
  emit(ctx, 'subscription.change_requested', { request_id: id, client_id: c.id, client_name: c.name, kind, plan_name: m.plan_name, requested_plan_name: r.plan_name ?? null, guardian_name: guardian.name });
  for (const o of ownerEmails(ctx)) {
    mail(ctx, o.email, `${guardian.name} asks to ${kind === 'switch' ? 'switch plans' : kind} for ${c.name}`,
      `Hi ${first(o.name)},\n\n${guardian.name} asked to ${what}.${note ? `\n\nTheir note:\n${note}` : ''}\n\nNothing has changed yet. Open ${c.name}'s client page to make the change or reply, then mark the request done: ${ctx.publicUrl ?? ''}/#/clients/${c.id}\n\n${biz(ctx)}`);
  }
  return membershipPanel(ctx, c.id);
}
export function withdrawMembershipRequest(ctx, guardian, clientId) {
  const c = athleteOfFamily(ctx, guardian.family_id, clientId);
  const r = ctx.db.run(`UPDATE membership_requests SET status = 'withdrawn', resolved_at = ?, resolved_by = ? WHERE client_id = ? AND status = 'open'`, ctx.now(), `${guardian.name} (parent)`, c.id);
  if (!r.changes) throw conflict('There\'s no open request to withdraw.');
  return membershipPanel(ctx, c.id);
}
// Owner side.
export function listMembershipRequests(ctx, { status = 'open', clientId } = {}) {
  const where = [], p = [];
  if (status !== 'all') { where.push('r.status = ?'); p.push(v.oneOf(status, 'status', ['open', 'done', 'declined', 'withdrawn'])); }
  if (clientId) { where.push('r.client_id = ?'); p.push(clientId); }
  return ctx.db.all(`SELECT ${requestCols}, r.client_id, c.name AS client_name, c.athlete_id, sp.name AS current_plan_name, s.status AS membership_status
    FROM membership_requests r JOIN clients c ON c.id = r.client_id LEFT JOIN plans p ON p.id = r.plan_id LEFT JOIN subscriptions s ON s.id = r.subscription_id LEFT JOIN plans sp ON sp.id = s.plan_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC LIMIT 200`, ...p);
}
// Done (the owner made the change, or will) or declined, with an optional reply the parent sees and is emailed.
export function resolveMembershipRequest(ctx, id, body = {}, actor) {
  const r = ctx.db.get('SELECT r.*, c.name AS client_name, c.family_id FROM membership_requests r JOIN clients c ON c.id = r.client_id WHERE r.id = ?', id);
  if (!r) throw notFound('Request');
  const status = v.oneOf(body.status, 'status', ['done', 'declined']);
  const note = body.note ? v.str(body.note, 'note', { max: 500, optional: true }) : null;
  const upd = ctx.db.run(`UPDATE membership_requests SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ? WHERE id = ? AND status = 'open'`, status, ctx.now(), actor?.name ?? 'Staff', note, id);
  if (!upd.changes) throw conflict('This request was already answered or withdrawn.');
  const g = r.guardian_id ? ctx.db.get('SELECT name, email FROM guardians WHERE id = ?', r.guardian_id) : null;
  if (g) mail(ctx, g.email, `About ${first(r.client_name)}'s membership`, `Hi ${first(g.name)},\n\n${status === 'done' ? `We've taken care of your request about ${first(r.client_name)}'s membership.` : `We looked at your request about ${first(r.client_name)}'s membership and can't make that change right now.`}${note ? `\n\n${note}` : ''}\n\nYou can see the membership on the Programs tab of the parent portal: ${ctx.publicUrl ?? ''}/parent\n\n${biz(ctx)}`);
  return listMembershipRequests(ctx, { status: 'all', clientId: r.client_id }).find((x) => x.id === id);
}

// ---------- Payments, receipts and a declined charge ----------
const PAID_SALE = ['succeeded', 'partially_refunded', 'refunded'];
export function familyPayments(ctx, familyId, { all = false } = {}) {
  const zone = tz(ctx), year = localDate(ctx.now(), zone).slice(0, 4);
  const feeLabel = feeSettings(ctx).label;
  const sales = ctx.db.all(`SELECT s.id, s.status, s.amount_cents, s.fee_cents, s.refunded_cents, s.method, s.card_last4, s.completed_at, s.created_at, s.receipt_token, c.name AS athlete_name,
      (SELECT GROUP_CONCAT(CASE WHEN quantity > 1 THEN quantity || ' × ' || name ELSE name END, ', ') FROM sale_items i WHERE i.sale_id = s.id) AS description
    FROM sales s JOIN clients c ON c.id = s.client_id WHERE c.family_id = ? AND s.status IN ('succeeded','partially_refunded','refunded')`, familyId)
    .map((s) => ({ kind: 'sale', id: s.id, date: s.completed_at ?? s.created_at, description: s.description || 'Payment', athlete_name: first(s.athlete_name), amount_cents: s.amount_cents, fee_cents: s.fee_cents ?? 0, fee_label: s.fee_cents ? feeLabel : null, refunded_cents: s.refunded_cents,
      method: commerce.METHOD_LABEL[s.method] ?? s.method, card_last4: s.card_last4, receipt_url: s.receipt_token ? `/receipt/${s.receipt_token}` : null }));
  const invoices = ctx.db.all(`SELECT i.id, i.amount_cents, i.fee_cents, i.refunded_cents, i.paid_at, i.paid_method, i.period_start, i.period_end, i.note, p.name AS plan_name, c.name AS athlete_name
    FROM invoices i JOIN clients c ON c.id = i.client_id JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
    WHERE c.family_id = ? AND i.status = 'paid' AND i.amount_cents > 0`, familyId)
    .map((i) => ({ kind: 'membership', id: i.id, date: i.paid_at, description: i.note ?? `${i.plan_name} membership`, athlete_name: first(i.athlete_name), amount_cents: i.amount_cents, fee_cents: i.fee_cents ?? 0, fee_label: i.fee_cents ? feeLabel : null, refunded_cents: i.refunded_cents,
      method: i.paid_method ? billing.HAND_METHODS[i.paid_method] ?? 'Other' : 'Card on file', card_last4: null, receipt_url: null }));
  const rows = [...sales, ...invoices].filter((x) => x.date).sort((a, b) => b.date.localeCompare(a.date));
  const paidThisYear = rows.filter((x) => localDate(x.date, zone).slice(0, 4) === year).reduce((n, x) => n + x.amount_cents - (x.refunded_cents ?? 0), 0);
  const payer = ctx.db.get('SELECT card_payment_method FROM families WHERE id = ?', familyId);
  const declined = ctx.db.all(`SELECT i.id, i.amount_cents, i.attempts, i.last_error, i.next_retry_at, i.created_at, p.name AS plan_name, c.name AS athlete_name
    FROM invoices i JOIN clients c ON c.id = i.client_id JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
    WHERE c.family_id = ? AND i.status = 'failed' ORDER BY i.created_at`, familyId)
    .map((i) => ({ id: i.id, athlete_name: first(i.athlete_name), plan_name: i.plan_name, amount_cents: i.amount_cents, tries: i.attempts, error: i.last_error,
      can_retry: i.attempts < PORTAL_RETRY_LIMIT && !!payer?.card_payment_method }));
  return { data: all ? rows : rows.slice(0, 8), total: rows.length, year: Number(year), paid_this_year_cents: paidThisYear, declined };
}
// A membership payment's receipt, for the parent to print (sales have their own /receipt/:token page).
export function membershipReceipt(ctx, familyId, invoiceId) {
  const i = ctx.db.get(`SELECT i.*, p.name AS plan_name, c.name AS athlete_name, c.family_id FROM invoices i JOIN clients c ON c.id = i.client_id JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
    WHERE i.id = ? AND c.family_id = ? AND i.status = 'paid'`, String(invoiceId ?? ''), familyId);
  if (!i) throw notFound('Receipt');
  return { id: i.id, business_name: biz(ctx), business_address: getSetting(ctx, 'business_address') || null, timezone: tz(ctx), athlete_name: i.athlete_name, description: `${i.plan_name} membership`,
    period_start: i.period_start, period_end: i.period_end, paid_at: i.paid_at, amount_cents: i.amount_cents, fee_cents: i.fee_cents ?? 0, fee_label: i.fee_cents ? feeSettings(ctx).label : null, refunded_cents: i.refunded_cents,
    method: i.paid_method ? billing.HAND_METHODS[i.paid_method] ?? 'Other' : 'Card on file' };
}
// Try a declined membership payment again on the card on file, while the payment has had fewer than 8 tries in all
// (automatic and manual; the owner can still retry after that). It never cancels the membership (a manual retry), and
// shares the invoice's lock.
// One press at a time per payment, so two quick taps can't both get past the 8-try check.
export function retryDeclined(ctx, familyId, invoiceId) { return withLock(`portal-retry:${invoiceId}`, () => retryNow(ctx, familyId, invoiceId)); }
async function retryNow(ctx, familyId, invoiceId) {
  const i = ctx.db.get(`SELECT i.id, i.client_id, i.status, i.attempts FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ? AND c.family_id = ?`, String(invoiceId ?? ''), familyId);
  if (!i) throw notFound('Payment');
  if (i.status !== 'failed') throw conflict(i.status === 'paid' ? 'This payment already went through.' : 'This payment can\'t be tried again. Message us if you have a question.');
  if (i.attempts >= PORTAL_RETRY_LIMIT) throw conflict('This payment has been tried many times. Message us and we\'ll sort it out together.');
  if (!payerFor(ctx, i.client_id).card_payment_method) throw conflict('There\'s no card on file. Add a card on the Family tab and the payment is tried again right away.');
  // A manual try like the owner's Retry: written to invoice_charges as the parent's, it never cancels the membership and
  // doesn't count toward the automatic tries (invoices.auto_attempts).
  const out = await billing.retryInvoice(ctx, i.id, { by: 'parent' });
  return { status: out.status, message: out.status === 'paid' ? 'Paid. Thanks!' : `The card was declined again: ${String(out.last_error ?? 'no reason given').replace(/\.$/, '')}. Nothing was charged. Replace the card and it's tried again right away.` };
}

// ---------- Card ----------
// Other parents in the family hear about card and parent changes, so nobody is surprised.
export function tellOtherParents(ctx, familyId, exceptGuardianId, subject, text) {
  for (const g of ctx.db.all('SELECT id, name, email FROM guardians WHERE family_id = ? AND id != ?', familyId, exceptGuardianId ?? '')) mail(ctx, g.email, subject, `Hi ${first(g.name)},\n\n${text}\n\nQuestions? Just reply to this email.\n\n${biz(ctx)}`);
}
// Remove the family card: asked first on the screen, and refused while a membership (or a declined payment) needs it.
export function removeFamilyCard(ctx, guardian) {
  const f = ctx.db.get('SELECT * FROM families WHERE id = ?', guardian.family_id);
  if (!f.card_payment_method) throw conflict('There\'s no card on file.');
  const uses = ctx.db.get(`SELECT c.name, s.status FROM subscriptions s JOIN clients c ON c.id = s.client_id WHERE c.family_id = ? AND s.status IN ('active','trialing','past_due','paused') ORDER BY c.name LIMIT 1`, f.id);
  if (uses) throw conflict(`${first(uses.name)}'s membership is paid with this card. Replace the card instead, or ask us to cancel the membership first.`);
  const payer = commerce.payerById(ctx, 'families', f.id);
  commerce.clearCard(ctx, payer);
  tellOtherParents(ctx, f.id, guardian.id, 'The family card was removed', `${guardian.name} removed the card ending ${f.card_last4 ?? ''} from your family account. Add a card again on the Family tab of the parent portal before booking anything that's paid.`);
  return getFamily(ctx, f.id).card;
}

// ---------- Parents and devices ----------
const phoneCheck = (p, label) => { if (p && digits(p).length < 10) throw badRequest(`${label} needs the area code: 10 digits, like (512) 555-0100.`); };
// A parent fixes their own name or phone (their email is how they sign in: the coach changes it).
export function updateMe(ctx, guardian, body = {}) {
  if (body.email !== undefined) throw badRequest('To change the email you sign in with, ask your coach.');
  const patch = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.phone !== undefined) { phoneCheck(body.phone, 'Your phone number'); patch.phone = body.phone; }
  const out = updateGuardian(ctx, guardian.family_id, guardian.id, patch);
  return { family: out, texts_turned_off: out.texts_turned_off };
}
// Add another parent: they're emailed how to sign in, and the other parents are told.
export async function addParent(ctx, guardian, body = {}) {
  const count = ctx.db.get('SELECT COUNT(*) AS n FROM guardians WHERE family_id = ?', guardian.family_id).n;
  if (count >= MAX_PARENTS) throw conflict(`A family can have up to ${MAX_PARENTS} parents. Remove one with your coach first.`);
  phoneCheck(body.phone, 'Their phone number');
  const before = new Set(ctx.db.all('SELECT id FROM guardians WHERE family_id = ?', guardian.family_id).map((g) => g.id));
  const fam = addGuardian(ctx, guardian.family_id, { name: body.name, email: body.email, phone: body.phone || undefined, relationship: body.relationship || undefined });
  const added = fam.guardians.find((g) => !before.has(g.id));
  await portalInvite(ctx, added.id);
  tellOtherParents(ctx, guardian.family_id, added.id, `${added.name} was added to your family account`, `${guardian.name} added ${added.name} (${added.email}) as a parent. They can sign in to the parent portal, book sessions and see progress.`);
  return fam;
}
function deviceName(ua) {
  const s = String(ua ?? '');
  if (!s) return 'Unknown device';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /node|undici/i.test(s) ? 'App' : 'Browser';
  return `${browser} on ${os}`;
}
// who: the signed-in person ({ guardian, client }; a guardian row alone still works). Their sessions are the parent's
// and, for an athlete signed in with their own email, the athlete's.
const whoIds = (who) => (who.guardian || who.client ? [who.guardian?.id ?? '', who.client?.id ?? ''] : [who.id, '']);
export function listDevices(ctx, who, rawToken) {
  const cur = rawToken ? sha256(rawToken) : '';
  return ctx.db.all('SELECT token_hash, created_at, user_agent, last_seen_at FROM portal_sessions WHERE (guardian_id = ? OR client_id = ?) AND expires_at > ? ORDER BY COALESCE(last_seen_at, created_at) DESC', ...whoIds(who), ctx.now())
    .map((s) => ({ id: s.token_hash.slice(0, 16), current: s.token_hash === cur, device: deviceName(s.user_agent), signed_in_at: s.created_at, last_seen_at: s.last_seen_at }));
}
export function signOutOthers(ctx, who, rawToken) {
  const r = ctx.db.run('DELETE FROM portal_sessions WHERE (guardian_id = ? OR client_id = ?) AND token_hash != ?', ...whoIds(who), rawToken ? sha256(rawToken) : '');
  return { signed_out: r.changes, devices: listDevices(ctx, who, rawToken) };
}
// The portal's first call: who this cookie belongs to, so the page knows whether to show the family portal, the
// athlete's app, or both.
export function session(ctx, who) {
  const person = who.guardian ?? who.client;
  return { kind: who.kind, name: person.name, first_name: person.name.split(' ')[0], email: person.email, has_password: who.has_password,
    parent: who.guardian ? { id: who.guardian.id, family_id: who.guardian.family_id } : null,
    athlete: who.client ? { id: who.client.id, name: who.client.name, athlete_id: who.client.athlete_id, app_link: '/app' } : null };
}

// ---------- Athletes (portal rules) ----------
const sameName = (a, b) => String(a ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
// The same name twice in one family, too many athletes, or an emergency phone without the area code are refused.
export function checkAthlete(ctx, familyId, body = {}, { exceptId = null } = {}) {
  if (!exceptId && ctx.db.get('SELECT COUNT(*) AS n FROM clients WHERE family_id = ? AND archived_at IS NULL', familyId).n >= MAX_ATHLETES) throw conflict(`A family can have up to ${MAX_ATHLETES} athletes. Ask your coach if you need more.`);
  if (body.name !== undefined) {
    const twin = ctx.db.all('SELECT id, name FROM clients WHERE family_id = ? AND id != ?', familyId, exceptId ?? '').find((c) => sameName(c.name, body.name));
    if (twin) throw conflict(`You already have an athlete named ${twin.name}. Use a middle initial or nickname to tell them apart.`);
  }
  if (body.emergency_phone) phoneCheck(body.emergency_phone, 'The emergency phone');
}

// ---------- Home extras ----------
// The next testing day this athlete is on (listed on it, or on a team that's testing), today included.
export function nextTestingDay(ctx, clientId) {
  const today = localDate(ctx.now(), tz(ctx));
  const teams = new Set(ctx.db.all('SELECT contract_id FROM team_roster WHERE client_id = ? AND active = 1', clientId).map((r) => r.contract_id));
  for (const s of ctx.db.all('SELECT id, name, date, athletes, contract_id FROM perf_sessions WHERE date >= ? ORDER BY date LIMIT 60', today)) {
    let list = [];
    try { list = JSON.parse(s.athletes); } catch { /* bad JSON: skip the list */ }
    if ((Array.isArray(list) && list.some((a) => a?.client_id === clientId)) || (s.contract_id && teams.has(s.contract_id))) return { name: s.name, date: s.date, today: s.date === today };
  }
  return null;
}
// What the parent sees about one test: what it measures and how it's run (no other athletes' data).
export function testInfo(ctx, key) {
  const t = getTest(ctx, String(key ?? ''));
  return { key: t.key, name: t.name, category: t.category, description: t.description ?? null, protocol: t.protocol || null, metrics: t.metrics.map((m) => ({ key: m.key, name: m.name, unit: m.unit, better: m.better })) };
}
// Per athlete for Home: membership panel, attended in the last 30 days, lessons overdue.
export function athleteExtras(ctx, clientId) {
  const edu = education(ctx, clientId);
  return { ...membershipPanel(ctx, clientId), attended_30: attendance(ctx, clientId).summary.visits_30, overdue_lessons: edu.assigned.filter((x) => x.overdue).length, next_testing_day: nextTestingDay(ctx, clientId) };
}
// One list of what's left to do, each with the tab that fixes it.
export function toFinish(ctx, familyId, { agreementsOk = true } = {}) {
  const f = getFamily(ctx, familyId), out = [];
  if (!agreementsOk) out.push({ key: 'terms', text: 'Accept the updated terms and privacy policy' });
  if (!f.waiver.signed) out.push({ key: 'waiver', text: 'Sign the waiver' });
  if (!f.card.on_file) out.push({ key: 'card', text: 'Add a card for sessions, packs and camps' });
  else if (f.card.expired) out.push({ key: 'card_expired', text: `Your card ending ${f.card.last4} has expired. Replace it` });
  else if (f.card.expiring) out.push({ key: 'card_expiring', text: `Your card ending ${f.card.last4} expires soon. Replace it` });
  const declined = ctx.db.get(`SELECT COALESCE(SUM(i.amount_cents), 0) AS n, COUNT(*) AS k FROM invoices i JOIN clients c ON c.id = i.client_id WHERE c.family_id = ? AND i.status = 'failed'`, familyId);
  if (declined.k) out.push({ key: 'declined', text: `A membership payment of ${money(declined.n)} didn't go through` });
  for (const c of familyAthletes(ctx, familyId)) {
    if (!c.emergency_name || !c.emergency_phone) out.push({ key: 'emergency', athlete_id: c.id, text: `Add an emergency contact for ${first(c.name)}` });
    if (!c.birth_date) out.push({ key: 'birthday', athlete_id: c.id, text: `Add ${first(c.name)}'s birthday` });
  }
  return out;
}
// Email the parent a copy of the waiver their family signed.
export async function emailWaiverCopy(ctx, guardian) {
  const f = ctx.db.get('SELECT waiver_signed_by, waiver_signed_at, waiver_version FROM families WHERE id = ?', guardian.family_id);
  if (!f.waiver_signed_at || Number(f.waiver_version) !== Number(getSetting(ctx, 'waiver_version'))) throw conflict('Sign the waiver first.');
  const kids = familyAthletes(ctx, guardian.family_id).map((c) => c.name);
  await sendEmail(ctx, { to: guardian.email, subject: `Your signed ${biz(ctx)} waiver`,
    text: `Hi ${first(guardian.name)},\n\nHere is the waiver your family signed.\n\nSigned by ${String(f.waiver_signed_by ?? '').split(' <')[0]} on ${day(ctx, f.waiver_signed_at)}${kids.length ? `, covering ${kids.join(', ')}` : ''}.\n\n----\n${getSetting(ctx, 'waiver_text')}\n----\n\n${biz(ctx)}` });
  return { sent_to: guardian.email };
}
export const withFamilyLock = (familyId, fn) => withLock(`family:${familyId}`, fn);
export { when as sessionWhen };
