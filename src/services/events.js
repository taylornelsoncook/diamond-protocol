import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { newId, token, hmac, v, notFound, badRequest, conflict } from '../util.js';

export const EVENT_TYPES = [
  'client.created', 'client.updated', 'client.archived', 'client.restored',
  'subscription.created', 'subscription.updated',
  'invoice.paid', 'invoice.payment_failed', 'invoice.refunded', 'invoice.voided', 'invoice.paid_twice',
  'program.assigned', 'workout.completed',
  'sale.completed', 'sale.failed', 'sale.refunded', 'payment.disputed', 'money_check.problems',
  'session.checked_in', 'client.card_updated',
  'booking.created', 'booking.waitlisted', 'booking.canceled', 'session.canceled',
  'enrollment.created', 'family.waiver_signed',
  'team_contract.created', 'team_invoice.created', 'team_invoice.paid', 'team_invoice.overdue', 'team_invoice.voided', 'team_invoice.payment_failed', 'team_invoice.paid_twice',
  'results.recorded', 'performance.pr', 'integration.synced', 'queue.linked', 'testing.shared',
  'family.signed_up', 'family.deletion_requested', 'family.deleted', 'clients.imported',
  'lead.created', 'lead.updated', 'pay_link.created', 'pay_link.paid', 'stock.changed', 'badge.awarded', 'course.completed', 'purchase.completed', 'spots.offered', 'progress_note.approved', 'session.messaged',
  'subscription.change_requested', 'client.merged', 'client.claimed'
];

// What each event means, and a made-up example of its data (sent by "Send test event", marked "test": true, and shown in
// the event list). Every example uses sample IDs and names, never a real client's.
const C = { client_id: 'cli_sample', client_name: 'Ava Lopez' };
const S = { session_id: 'cls_sample', session_name: 'Youth Speed & Agility', starts_at: '2026-10-05T22:30:00.000Z' };
const INFO = {
  'client.created': ['A client is added: by staff, a family signing up, an import or the API.', { ...C, athlete_id: 'AVALOP2026', email: 'maria.lopez@example.com', family_id: 'fam_sample' }],
  'client.updated': ['A client\'s details change.', { ...C, email: 'maria.lopez@example.com' }],
  'client.archived': ['A client is archived (their upcoming bookings may be canceled).', { ...C, bookings_canceled: 1, by: 'Head Coach' }],
  'client.restored': ['An archived client is brought back.', { ...C, by: 'Head Coach' }],
  'subscription.created': ['A membership starts (free trial or paid).', { subscription_id: 'sub_sample', ...C, plan_name: 'Performance membership', status: 'trialing', trial_ends_at: '2026-10-12T00:00:00.000Z' }],
  'subscription.updated': ['A membership changes: plan, paused, resumed, past due or canceled.', { subscription_id: 'sub_sample', ...C, plan_name: 'Performance membership', status: 'active', previous_status: 'trialing' }],
  'invoice.paid': ['A membership payment goes through.', { invoice_id: 'inv_sample', ...C, amount_cents: 18900 }],
  'invoice.payment_failed': ['A membership payment is declined (source: automatic, new_card, owner or parent; only automatic tries count toward canceling; final: true when the membership is canceled after the last one).', { invoice_id: 'inv_sample', ...C, amount_cents: 18900, attempts: 1, automatic_attempts: 1, manual: false, source: 'automatic', error: 'Your card was declined.', final: false }],
  'invoice.refunded': ['A membership payment is refunded, in part or in full.', { invoice_id: 'inv_sample', ...C, amount_cents: 5000, total_refunded_cents: 5000, full: false, reason: 'Missed week', method: 'card' }],
  'invoice.voided': ['A membership invoice is voided.', { invoice_id: 'inv_sample', ...C, amount_cents: 18900, written_off: false, reason: 'Billed twice', by: 'Head Coach' }],
  'invoice.paid_twice': ['A membership invoice was paid twice (refunded: whether the extra payment went back automatically).', { invoice_id: 'inv_sample', ...C, amount_cents: 18900, payment_ref: 'pi_sample', reason: 'hand', refunded: true, error: null }],
  'program.assigned': ['A training program is assigned to an athlete.', { assignment_id: 'asg_sample', ...C, program_id: 'prog_sample', program_name: 'Youth Speed Foundations' }],
  'workout.completed': ['An athlete finishes a workout in the workout app or on the weight-room screen.', { workout_log_id: 'wlog_sample', ...C, workout_id: 'wo_sample', workout_title: 'Lower body', program_name: 'Youth Speed Foundations', exercises_logged: 4, exercises_total: 4, sets: 12, effort: 7, minutes: 42, notes: 'Felt strong today.', bests: [] }],
  'sale.completed': ['A sale is paid at the counter, on an iPhone or by pay link.', { sale_id: 'sale_sample', ...C, amount_cents: 4500, method: 'card_on_file', location_name: 'Facility', items: [{ name: 'Drop-in session', quantity: 1, amount_cents: 4500 }] }],
  'sale.failed': ['A card payment at the counter doesn\'t go through.', { sale_id: 'sale_sample', ...C, amount_cents: 4500, method: 'reader', reason: 'Card declined' }],
  'sale.refunded': ['A sale is refunded or undone.', { sale_id: 'sale_sample', ...C, amount_cents: 4500, total_refunded_cents: 4500, full: true, sessions_removed: 0, items_restocked: 1 }],
  'payment.disputed': ['A family disputes a card payment with their bank.', { payment_ref: 'pi_sample', sale_id: 'sale_sample', invoice_id: null, client_id: 'cli_sample', amount_cents: 4500, reason: 'fraudulent' }],
  'money_check.problems': ['The daily money check finds something to look at (double charges, stuck payments, refund spikes).', { check_date: '2026-10-05', problems: 1, types: ['double_charge'] }],
  'session.checked_in': ['An athlete checks in (front desk, door QR code or tablet).', { ...C, location_name: 'Facility', covered_by: 'membership' }],
  'client.card_updated': ['A client saves, replaces or removes a card.', { ...C, card_brand: 'visa', card_last4: '4242' }],
  'booking.created': ['A session is booked (by staff, a parent, the waitlist or an offer).', { booking_id: 'bkg_sample', ...S, ...C, coverage: 'membership', from_waitlist: false }],
  'booking.waitlisted': ['A client joins a session\'s waitlist.', { booking_id: 'bkg_sample', ...S, ...C }],
  'booking.canceled': ['A booking is canceled (late: inside the late-cancel window).', { booking_id: 'bkg_sample', ...S, ...C, late: false }],
  'session.canceled': ['A session is canceled.', { session_id: 'cls_sample', name: 'Youth Speed & Agility', starts_at: S.starts_at, reason: 'Weather' }],
  'enrollment.created': ['A client takes a standing spot in a class or registers for a camp or clinic.', { enrollment_id: 'enr_sample', series_id: 'ser_sample', series_name: 'Summer Speed Camp', ...C }],
  'family.waiver_signed': ['A parent signs the waiver (online or on paper).', { family_id: 'fam_sample', guardian_name: 'Maria Lopez', version: 1 }],
  'team_contract.created': ['A school or club team contract is added.', { contract_id: 'tc_sample', org_id: 'org_sample', org_name: 'Lakeway High School', team_name: 'Varsity Baseball', monthly_cents: 120000 }],
  'team_invoice.created': ['An invoice to a school or club is made.', { invoice_id: 'tinv_sample', number: 'DP-2026-0036', contract_id: 'tc_sample', org_name: 'Lakeway High School', team_name: 'Varsity Baseball', amount_cents: 120000, due_on: '2026-10-31' }],
  'team_invoice.paid': ['A school or club pays an invoice (online or recorded by hand).', { invoice_id: 'tinv_sample', number: 'DP-2026-0036', org_name: 'Lakeway High School', team_name: 'Varsity Baseball', amount_cents: 120000, method: 'check' }],
  'team_invoice.overdue': ['A school or club invoice is past due.', { invoice_id: 'tinv_sample', number: 'DP-2026-0036', org_name: 'Lakeway High School', amount_cents: 120000 }],
  'team_invoice.voided': ['A school or club invoice is voided.', { invoice_id: 'tinv_sample', number: 'DP-2026-0036', org_name: 'Lakeway High School', amount_cents: 120000 }],
  'team_invoice.payment_failed': ['An online payment of a school or club invoice fails.', { invoice_id: 'tinv_sample' }],
  'team_invoice.paid_twice': ['A school or club invoice was paid online after it was already paid or voided.', { invoice_id: 'tinv_sample', number: 'DP-2026-0036', amount_cents: 120000, status: 'paid' }],
  'results.recorded': ['Test results are saved (typed, stopwatch, upload, device or the API).', { count: 6, athletes: 3, source: 'api:vald', session_id: null }],
  'performance.pr': ['A result is an athlete\'s personal best.', { ...C, athlete_id: 'AVALOP2026', athlete_name: 'Ava Lopez', test: 'vertical_jump', test_name: 'Vertical jump', value: 21.5, unit: 'in', side: null }],
  'integration.synced': ['New results arrive from a connected system (Hawkin Dynamics).', { provider: 'hawkin', results: 12 }],
  'queue.linked': ['Waiting results are linked to an athlete by hand.', { count: 3, athlete_id: 'AVALOP2026', athlete_name: 'Ava Lopez', remembered: true }],
  'testing.shared': ['A testing day\'s results are shared with families.', { session_id: 'tsn_sample', name: 'Fall combine', families_notified: 14 }],
  'family.signed_up': ['A family signs up online.', { family_id: 'fam_sample', parent_name: 'Maria Lopez', athletes: [{ client_id: 'cli_sample', name: 'Ava Lopez', athlete_id: 'AVALOP2026' }] }],
  'family.deletion_requested': ['A parent asks for their family\'s data to be deleted.', { request_id: 'dreq_sample', family_id: 'fam_sample', family_name: 'Lopez family', requested_by: 'Maria Lopez' }],
  'family.deleted': ['A family\'s personal information is deleted (payment records stay, without names).', { family_id: 'fam_sample', athletes: 2 }],
  'clients.imported': ['Clients are imported from a spreadsheet.', { athletes: 40, families: 32, filename: 'clients.xlsx' }],
  'lead.created': ['A family asks about training (website form, unfinished sign-up or added by staff).', { lead_id: 'lead_sample', source: 'website', parent_name: 'Sarah Miller', athlete_name: 'Jake Miller' }],
  'lead.updated': ['A lead moves to another stage.', { lead_id: 'lead_sample', status: 'evaluation', family_id: null }],
  'pay_link.created': ['A pay-by-card link is made.', { pay_link_id: 'pl_sample', client_id: 'cli_sample', kind: 'invoice', amount_cents: 18900 }],
  'pay_link.paid': ['A pay link is paid.', { pay_link_id: 'pl_sample', client_id: 'cli_sample', kind: 'invoice', amount_cents: 18900, sale_id: null, invoice_id: 'inv_sample' }],
  'stock.changed': ['Gear stock changes: a delivery arrives, a count or an adjustment.', { product_id: 'prod_sample', product_name: 'DP training shirt', variant_id: 'var_sample', size: 'Youth M', reason: 'received', delta: 12, on_hand: 20 }],
  'badge.awarded': ['An athlete earns a skill badge.', { ...C, badge_id: 'bdg_sample', badge_name: 'First pull-up', awarded_by: 'Head Coach' }],
  'course.completed': ['An athlete finishes a course.', { ...C, course_id: 'crs_sample', course_title: 'Fueling for performance' }],
  'purchase.completed': ['A program or course is bought from the online store.', { purchase_id: 'pur_sample', ...C, kind: 'program', item_id: 'prog_sample', title: 'Youth Speed Foundations', amount_cents: 4900, sale_id: 'sale_sample' }],
  'spots.offered': ['Open spots (or a trial offer) in a class are emailed to families.', { ...S, families: 8, spots_left: 3 }],
  'progress_note.approved': ['A progress note for parents is approved.', { note_id: 'note_sample', client_id: 'cli_sample', testing_session_id: 'tsn_sample' }],
  'session.messaged': ['Staff email the families booked in a session.', { ...S, families: 9, by: 'Head Coach' }],
  'subscription.change_requested': ['A parent asks to switch plans, pause or cancel a membership in the parent portal (nothing changes until the owner does it).', { request_id: 'mrq_sample', ...C, kind: 'pause', plan_name: 'Performance membership', requested_plan_name: null, guardian_name: 'Maria Lopez' }],
  'client.merged': ['The owner merges two profiles of one athlete (the other Athlete ID keeps finding this one).', { ...C, athlete_id: 'AVALOP2026', merged_client_id: 'cli_sample2', merged_athlete_id: 'AVALOP2026-2' }],
  'client.claimed': ['A parent adds a team athlete to their family with the Athlete ID (name and birthday matched).', { ...C, athlete_id: 'AVALOP2026', family_id: 'fam_sample', guardian_name: 'Maria Lopez' }]
};
export const EVENT_INFO = Object.fromEntries(EVENT_TYPES.map((t) => [t, { about: INFO[t]?.[0] ?? '', sample: INFO[t]?.[1] ?? {} }]));
const PING = { message: 'Test event from Diamond Protocol. If you can read this, your endpoint works.' };

// Record an event and queue a delivery for every active endpoint subscribed to it.
export function emit(ctx, type, data) {
  const ev = { id: newId('evt'), type, data, created_at: ctx.now() };
  ctx.db.run('INSERT INTO events (id, type, data, created_at) VALUES (?, ?, ?, ?)', ev.id, type, JSON.stringify(data), ev.created_at);
  for (const ep of ctx.db.all('SELECT id, events FROM webhook_endpoints WHERE active = 1')) {
    const wanted = JSON.parse(ep.events);
    if (wanted.includes('*') || wanted.includes(type)) {
      ctx.db.run(
        `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        newId('whd'), ep.id, ev.id, type, ev.created_at, ev.created_at
      );
    }
  }
  ctx.onEvent?.();
  return ev;
}

export function listEvents(ctx, { limit = 20, type } = {}) {
  const rows = type
    ? ctx.db.all('SELECT * FROM events WHERE type = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', type, limit)
    : ctx.db.all('SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?', limit);
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

// ---- Addresses a webhook may send to ----
// A webhook URL is typed by the owner, but the server makes the request, so it must never reach the server's own
// network: loopback, private and link-local ranges (cloud metadata lives at 169.254.169.254), carrier-grade NAT,
// multicast and reserved ranges are refused, both for an IP written in the URL and for every address a host name
// resolves to at the moment of sending (so a name can't be pointed at a private address later). Redirects are never
// followed. Local development and the tests (test mode with no PUBLIC_URL) may send to private addresses.
const V4_BLOCKED = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const v4 = (ip) => { const p = ip.split('.').map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null; };
function expandV6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) { const n = v4(tail[1]); if (n == null) return null; s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [head, rest] = s.split('::');
  if (s.split('::').length > 2) return null;
  const a = head ? head.split(':') : [], b = rest !== undefined ? (rest ? rest.split(':') : []) : [];
  const fill = rest !== undefined ? 8 - a.length - b.length : 0;
  const parts = [...a, ...Array(Math.max(fill, 0)).fill('0'), ...b];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return parts.map((x) => parseInt(x, 16));
}
export function blockedAddress(ip) {
  const s = String(ip ?? '').trim();
  if (net.isIPv4(s)) {
    const n = v4(s);
    return V4_BLOCKED.some(([base, bits]) => { const mask = (~0 << (32 - bits)) >>> 0; return ((n & mask) >>> 0) === ((v4(base) & mask) >>> 0); }) || n === 0xffffffff;
  }
  const w = expandV6(s);
  if (!w) return true;                                              // not an address we understand: refuse
  if (w.every((x) => x === 0)) return true;                         // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true;   // ::1
  const embedded = (hi, lo) => blockedAddress(`${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`);
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return embedded(w[6], w[7]);   // ::ffff:a.b.c.d
  if (w.slice(0, 6).every((x) => x === 0)) return embedded(w[6], w[7]);                        // ::a.b.c.d (old compatible form)
  if (w.slice(0, 4).every((x) => x === 0) && w[4] === 0xffff && w[5] === 0) return embedded(w[6], w[7]);   // ::ffff:0:a.b.c.d (translated)
  if (w[0] === 0x64 && w[1] === 0xff9b) return embedded(w[6], w[7]);                          // NAT64
  if ((w[0] & 0xfe00) === 0xfc00) return true;                      // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true;                      // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return true;                      // fec0::/10 old site-local
  if ((w[0] & 0xff00) === 0xff00) return true;                      // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;              // documentation
  if (w[0] === 0x2002) return embedded(w[1], w[2]);                 // 6to4 carries an IPv4 address
  return false;
}
const allowPrivate = (ctx) => !!ctx.allowPrivateWebhooks;
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)$/i;
function cleanUrl(ctx, raw) {
  const url = v.url(raw, 'url', { allowHttp: ctx.testMode });
  const u = new URL(url);
  if (u.username || u.password) throw badRequest('Leave the user name and password out of the URL. Your receiver can check the DP-Signature header instead.');
  if (!allowPrivate(ctx)) {
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');          // "localhost." is localhost
    if (net.isIP(host) ? blockedAddress(host) : LOCAL_NAMES.test(host) || !host.includes('.')) throw badRequest('That URL points inside a private network. Webhooks can only go to a public internet address.');
  }
  return url;
}
// The same address counts as a duplicate whatever the host's case, a default port or a trailing slash.
const urlKey = (s) => { try { const u = new URL(s); return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`; } catch { return String(s); } };
function refuseDuplicate(ctx, url, exceptId = '') {
  const key = urlKey(url);
  const other = ctx.db.all('SELECT id, url, label FROM webhook_endpoints WHERE id != ?', exceptId).find((w) => urlKey(w.url) === key);
  if (other) throw conflict(`A webhook already sends to that URL${other.label ? ` (${other.label})` : ''}. Edit that one instead.`);
}

// ---- Webhook endpoints ----
const hint = (secret) => (secret ? `${secret.slice(0, 10)}…${secret.slice(-4)}` : null);
function health(ctx, id) {
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const w = ctx.db.get(`SELECT SUM(status = 'succeeded') AS ok, SUM(status = 'failed') AS failed, SUM(status IN ('pending','sending')) AS waiting FROM webhook_deliveries WHERE endpoint_id = ? AND created_at >= ?`, id, week);
  const last = ctx.db.get('SELECT status, response_code, last_error, created_at, last_attempt_at FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', id);
  return { delivered_7d: w.ok ?? 0, failed_7d: w.failed ?? 0, waiting: w.waiting ?? 0, last: last ?? null };
}
function publicEndpoint(ctx, r) {
  const graceOn = r.previous_secret && r.previous_secret_until > ctx.now();
  return { id: r.id, label: r.label ?? null, url: r.url, secret_hint: hint(r.secret), events: JSON.parse(r.events), active: !!r.active, created_at: r.created_at,
    secret_rotated_at: r.secret_rotated_at ?? null, previous_secret_until: graceOn ? r.previous_secret_until : null,
    failures_in_a_row: r.failures, failing: r.failures >= 3, ...health(ctx, r.id) };
}

function cleanEvents(events) {
  if (!Array.isArray(events) || events.length === 0) throw badRequest('Choose at least one event to send, or "*" for all.');
  for (const e of events) if (e !== '*' && !EVENT_TYPES.includes(e)) throw badRequest(`Unknown event type: ${String(e).slice(0, 60)}.`);
  return events.includes('*') ? ['*'] : [...new Set(events)];
}
const cleanLabel = (x) => (x === undefined ? undefined : v.str(x, 'label', { max: 80, optional: true }));

export function createEndpoint(ctx, body) {
  const url = cleanUrl(ctx, body.url);
  const events = cleanEvents(body.events ?? ['*']);
  refuseDuplicate(ctx, url);
  const row = { id: newId('whe'), url, secret: `whsec_${token(24)}`, events: JSON.stringify(events), created_at: ctx.now() };
  ctx.db.run('INSERT INTO webhook_endpoints (id, url, secret, events, active, created_at, label) VALUES (?, ?, ?, ?, 1, ?, ?)', row.id, row.url, row.secret, row.events, row.created_at, cleanLabel(body.label) ?? null);
  return { ...getEndpoint(ctx, row.id), secret: row.secret };     // the full secret: here, after a rotation, and on "Show signing secret"
}
export function listEndpoints(ctx) {
  return ctx.db.all('SELECT * FROM webhook_endpoints ORDER BY created_at').map((r) => publicEndpoint(ctx, r));
}
function endpointRow(ctx, id) {
  const r = ctx.db.get('SELECT * FROM webhook_endpoints WHERE id = ?', id);
  if (!r) throw notFound('Webhook endpoint');
  return r;
}
export const getEndpoint = (ctx, id) => publicEndpoint(ctx, endpointRow(ctx, id));
export function endpointSecret(ctx, id) {
  const r = endpointRow(ctx, id);
  const graceOn = r.previous_secret && r.previous_secret_until > ctx.now();
  return { id: r.id, secret: r.secret, previous_secret_until: graceOn ? r.previous_secret_until : null };
}
export function updateEndpoint(ctx, id, body) {
  const ep = endpointRow(ctx, id);
  const url = body.url !== undefined ? cleanUrl(ctx, body.url) : ep.url;
  if (url !== ep.url) refuseDuplicate(ctx, url, id);
  const events = body.events !== undefined ? cleanEvents(body.events) : JSON.parse(ep.events);
  const active = body.active !== undefined ? !!body.active : !!ep.active;
  const label = body.label !== undefined ? cleanLabel(body.label) : ep.label;
  // A new address or turning it back on starts the failure count again.
  const failures = url !== ep.url || (active && !ep.active) ? 0 : ep.failures;
  ctx.db.run('UPDATE webhook_endpoints SET url = ?, events = ?, active = ?, label = ?, failures = ? WHERE id = ?', url, JSON.stringify(events), active, label, failures, id);
  return getEndpoint(ctx, id);
}
export function deleteEndpoint(ctx, id) {
  endpointRow(ctx, id);
  ctx.db.run('DELETE FROM webhook_endpoints WHERE id = ?', id);
  return { id, deleted: true };
}
// A new signing secret, shown once. The old one keeps signing too (a second v1= in DP-Signature) for keep_old_hours
// (0 to 72, default 24) so the receiver can switch over without dropping events; 0 stops it at once.
export function rotateSecret(ctx, id, body = {}) {
  const ep = endpointRow(ctx, id);
  const hours = body.keep_old_hours === undefined ? 24 : v.int(body.keep_old_hours, 'keep_old_hours', { min: 0, max: 72 });
  const secret = `whsec_${token(24)}`, now = ctx.now();
  const until = hours ? new Date(Date.parse(now) + hours * 3600e3).toISOString() : null;
  ctx.db.run('UPDATE webhook_endpoints SET secret = ?, previous_secret = ?, previous_secret_until = ?, secret_rotated_at = ? WHERE id = ?', secret, hours ? ep.secret : null, until, now, id);
  return { ...getEndpoint(ctx, id), secret };
}

// ---- Deliveries ----
const MAX_ATTEMPTS = 6;                               // the first try and five retries
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
const STUCK_MS = 2 * 60000;                           // 'sending' this long means the server stopped mid-send
const TIMEOUT_MS = 10000;
const DELIVERY_COLS = `d.id, d.endpoint_id, w.label AS endpoint_label, w.url AS endpoint_url, d.event_id, COALESCE(d.event_type, e.type) AS event_type, d.test, d.status, d.attempts,
  d.response_code, d.last_error, d.next_attempt_at, d.last_attempt_at, d.duration_ms, d.created_at`;
const deliveryRow = (r) => (r ? { ...r, test: !!r.test } : r);

export function listDeliveries(ctx, endpointId, q = {}) {
  if (endpointId) endpointRow(ctx, endpointId);
  const where = [], p = [];
  if (endpointId) { where.push('d.endpoint_id = ?'); p.push(endpointId); }
  if (q.status === 'failed') where.push(`d.status = 'failed'`);
  else if (q.status === 'delivered') where.push(`d.status = 'succeeded'`);
  else if (q.status === 'waiting') where.push(`d.status IN ('pending','sending')`);
  else if (q.status) throw badRequest('status must be failed, delivered or waiting.');
  if (q.event) { where.push('COALESCE(d.event_type, e.type) = ?'); p.push(String(q.event)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 200), offset = Math.max(Number(q.offset) || 0, 0);
  const from = `FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id LEFT JOIN events e ON e.id = d.event_id ${w}`;
  return {
    data: ctx.db.all(`SELECT ${DELIVERY_COLS} ${from} ORDER BY d.created_at DESC, d.rowid DESC LIMIT ? OFFSET ?`, ...p, limit, offset).map(deliveryRow),
    total: ctx.db.get(`SELECT COUNT(*) AS n ${from}`, ...p).n, limit, offset
  };
}
function bodyOf(ctx, d) {
  if (d.payload) return d.payload;
  const e = ctx.db.get('SELECT id, type, data, created_at FROM events WHERE id = ?', d.event_id);
  return e ? JSON.stringify({ id: e.id, type: e.type, created_at: e.created_at, data: JSON.parse(e.data) }) : JSON.stringify({ id: d.event_id, type: d.event_type, data: null });
}
// One delivery in full: what was sent, what came back, and why it failed in plain words.
export function getDelivery(ctx, id) {
  const d = ctx.db.get(`SELECT ${DELIVERY_COLS}, d.payload, d.response_body FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id LEFT JOIN events e ON e.id = d.event_id WHERE d.id = ?`, id);
  if (!d) throw notFound('Delivery');
  const { payload, ...rest } = d;
  let sent; try { sent = JSON.parse(bodyOf(ctx, d)); } catch { sent = null; }
  return { ...deliveryRow(rest), payload: sent, max_attempts: d.test ? 1 : MAX_ATTEMPTS, retries_left: d.status === 'pending' ? Math.max(MAX_ATTEMPTS - d.attempts, 0) : 0 };
}

// Signature format (verify on the receiving side):
//   DP-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" using the endpoint secret>
// For a while after a new secret is made, a second v1= signs with the old secret; accept the request if any v1 matches.
export function signPayload(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;
}
function signatureFor(ctx, ep, body) {
  const t = Math.floor(Date.now() / 1000);
  const header = signPayload(ep.secret, body, t);
  return ep.previous_secret && ep.previous_secret_until > ctx.now() ? `${header},v1=${hmac(ep.previous_secret, `${t}.${body}`)}` : header;
}

// Turn a network failure into something an owner can act on.
function reason(e) {
  const code = e?.code || e?.cause?.code || '';
  if (code === 'EPRIVATE') return `Not sent: ${e.message}. Webhooks only go to public internet addresses.`;
  if (e?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ECONNABORTED') return `The receiver didn't answer within ${TIMEOUT_MS / 1000} seconds.`;
  if (code === 'ECONNREFUSED') return 'Connection refused: nothing is listening at that address.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'That address doesn\'t exist (the name lookup failed).';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'The connection was cut off before an answer came back.';
  if (/CERT|SSL|TLS/i.test(code)) return `The site's HTTPS certificate was refused (${code}).`;
  return `Could not connect: ${String(code || e?.message || e).slice(0, 200)}`;
}
function guardedLookup(host, opts, cb) {
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    const bad = list.find((a) => blockedAddress(a.address));
    if (bad) return cb(Object.assign(new Error(`${host} points to a private address (${bad.address})`), { code: 'EPRIVATE' }));
    if (opts?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}
// POST the body and report the answer: { code, body (the first 500 characters), ms, error }. Redirects aren't followed.
function send(ctx, urlText, headers, body) {
  const started = Date.now();
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlText); } catch { return resolve({ code: null, body: null, ms: 0, error: 'The webhook URL is not valid.' }); }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate(ctx) && net.isIP(host) && blockedAddress(host)) return resolve({ code: null, body: null, ms: 0, error: reason({ code: 'EPRIVATE', message: `${host} is a private address` }) });
    const lib = u.protocol === 'https:' ? https : http;
    let done = false, timer = null;
    const finish = (x) => { if (!done) { done = true; clearTimeout(timer); resolve({ ms: Date.now() - started, ...x }); } };
    const req = lib.request(u, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, ...(allowPrivate(ctx) ? {} : { lookup: guardedLookup }) }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 2000) text += c; else res.destroy(); });
      const end = () => {
        const code = res.statusCode;
        finish({ code, body: text.slice(0, 500) || null, error: code >= 200 && code < 300 ? null : code >= 300 && code < 400 ? `The receiver answered ${code} (a redirect). Use the final address: redirects aren't followed.` : `The receiver answered ${code}.` });
      };
      res.on('end', end); res.on('close', end);
    });
    timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), TIMEOUT_MS);
    req.on('error', (e) => finish({ code: null, body: null, error: reason(e) }));
    req.end(body);
  });
}
// Claim a delivery (so no other copy or button sends it at the same time), send it with the endpoint's current URL and
// secret, and record the answer. mode 'auto' follows the retry schedule; 'manual' is a Resend press.
async function attempt(ctx, id, { mode = 'auto', from = ['pending'] } = {}) {
  const now = ctx.now(), stale = new Date(Date.now() - STUCK_MS).toISOString();
  const before = ctx.db.get('SELECT status FROM webhook_deliveries WHERE id = ?', id)?.status;
  const claimed = ctx.db.run(`UPDATE webhook_deliveries SET status = 'sending', last_attempt_at = ? WHERE id = ? AND (status IN (${from.map(() => '?').join(', ')}) OR (status = 'sending' AND last_attempt_at < ?))
    ${mode === 'auto' ? 'AND endpoint_id IN (SELECT id FROM webhook_endpoints WHERE active = 1)' : ''}`, now, id, ...from, stale).changes;
  if (!claimed) return null;
  const d = ctx.db.get('SELECT * FROM webhook_deliveries WHERE id = ?', id);
  const ep = ctx.db.get('SELECT * FROM webhook_endpoints WHERE id = ?', d.endpoint_id);
  const body = bodyOf(ctx, d), type = d.event_type ?? JSON.parse(body).type;
  const out = await send(ctx, ep.url, { 'content-type': 'application/json', 'user-agent': 'DiamondProtocol-Webhooks/1', 'dp-signature': signatureFor(ctx, ep, body), 'dp-event': type, 'dp-delivery': d.id, ...(d.test ? { 'dp-test': 'true' } : {}) }, body);
  const attempts = d.attempts + 1;
  let status, next = null;
  if (!out.error) status = 'succeeded';
  else if (d.test) status = 'failed';                                  // test events are tried once
  else if (mode === 'manual' && before !== 'pending') status = 'failed';
  else if (attempts >= MAX_ATTEMPTS) status = 'failed';
  else { status = 'pending'; next = new Date(Date.now() + BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] * 60000).toISOString(); }
  ctx.db.run(`UPDATE webhook_deliveries SET status = ?, attempts = ?, response_code = ?, last_error = ?, next_attempt_at = ?, duration_ms = ?, response_body = ? WHERE id = ?`,
    status, attempts, out.code, out.error, next, out.ms, out.body, id);
  ctx.db.run(`UPDATE webhook_endpoints SET failures = ${out.error ? 'failures + 1' : '0'} WHERE id = ?`, ep.id);
  return getDelivery(ctx, id);
}

// Send due deliveries. Called by the webhooks job and right after events fire. One pass at a time per server; each
// delivery is claimed before it's sent, so two server copies (or a Resend press) never send the same one twice.
export async function deliverPending(ctx, { limit = 20 } = {}) {
  if (ctx.webhooksRunning) return 0;
  ctx.webhooksRunning = true;
  let sent = 0;
  try {
    // An old signing secret whose grace period is over is forgotten.
    ctx.db.run('UPDATE webhook_endpoints SET previous_secret = NULL, previous_secret_until = NULL WHERE previous_secret IS NOT NULL AND previous_secret_until <= ?', ctx.now());
    const due = ctx.db.all(
      `SELECT d.id FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id
       WHERE w.active = 1 AND ((d.status = 'pending' AND d.next_attempt_at <= ?) OR (d.status = 'sending' AND d.last_attempt_at < ?))
       ORDER BY d.created_at LIMIT ?`, new Date().toISOString(), new Date(Date.now() - STUCK_MS).toISOString(), limit);
    for (const d of due) if (await attempt(ctx, d.id)) sent++;
  } finally {
    ctx.webhooksRunning = false;
  }
  return sent;
}

// Resend one delivery now (after fixing the receiver): the same body and DP-Delivery id, signed with the current secret.
export async function resendDelivery(ctx, id) {
  const d = ctx.db.get('SELECT status FROM webhook_deliveries WHERE id = ?', id);
  if (!d) throw notFound('Delivery');
  const out = await attempt(ctx, id, { mode: 'manual', from: ['pending', 'failed', 'succeeded'] });
  if (!out) throw conflict('That delivery is being sent right now. Try again in a few seconds.');
  return out;
}
// Resend everything that failed in the last 7 days (up to 50), oldest first.
export async function resendFailed(ctx, endpointId) {
  endpointRow(ctx, endpointId);
  const list = ctx.db.all(`SELECT id FROM webhook_deliveries WHERE endpoint_id = ? AND status = 'failed' AND test = 0 AND created_at >= ? ORDER BY created_at LIMIT 50`,
    endpointId, new Date(Date.now() - 7 * 86400000).toISOString());
  if (!list.length) throw badRequest('Nothing to resend: no failed deliveries in the last 7 days.');
  let ok = 0, tried = 0;
  for (const d of list) { const r = await attempt(ctx, d.id, { mode: 'manual', from: ['failed'] }); if (r) { tried++; if (r.status === 'succeeded') ok++; } }
  return { tried, delivered: ok, failed: tried - ok };
}
// A test event: test.ping, or a sample of any event type (marked "test": true) so a receiving system can be built
// against it. Sent now, tried once, and never shown in Today's activity.
export async function sendTest(ctx, endpointId, body = {}) {
  endpointRow(ctx, endpointId);
  const type = body.event === undefined || body.event === '' ? 'test.ping' : String(body.event);
  if (type !== 'test.ping' && !EVENT_TYPES.includes(type)) throw badRequest('Choose an event to send as a test.');
  const id = newId('whd'), now = ctx.now();
  const payload = JSON.stringify({ id: `evt_test_${token(6)}`, type, created_at: now, test: true, data: type === 'test.ping' ? PING : { ...EVENT_INFO[type].sample, test: true } });
  ctx.db.run(`INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, payload, test, status, attempts, next_attempt_at, created_at) VALUES (?, ?, NULL, ?, ?, 1, 'pending', 0, NULL, ?)`,
    id, endpointId, type, payload, now);
  return attempt(ctx, id, { mode: 'manual' });
}
