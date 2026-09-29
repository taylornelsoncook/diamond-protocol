import { newId, token, sha256, hashPassword, verifyPassword, v, notFound, badRequest, HttpError, addDays, startOfLocalDay, localDate, zonedToUtc } from '../util.js';
import { getSetting } from './families.js';
import { listEvents } from './events.js';
import { teamSummary } from './teams.js';
import { queueCount } from './queue.js';
import { inventory } from './inventory.js';
import { unreadReplies } from './engage.js';
import { OWNER_EVENTS, LEAD_EVENTS, can } from './security.js';
import { clientCounts } from './clients.js';
import { moneyIn, todayBounds, lateChargeAlerts } from './billing.js';

const SESSION_DAYS = 14;

// ---- Coach accounts and sessions ----
export function createUser(ctx, { email, name, password, role = 'owner' }) {
  const pw = v.str(password, 'password', { max: 200 });
  if (pw.length < 10) throw new HttpError(400, 'invalid_request', 'password must be at least 10 characters.');
  const id = newId('usr');
  ctx.db.run('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, v.email(email), v.str(name, 'name', { max: 120 }), hashPassword(pw), role, ctx.now());
  return { id, email, name, role };
}

const MAX_FAILED = 5, LOCK_MINUTES = 15;
function checkLogin(ctx, body) {
  const email = v.email(body.email);
  const u = ctx.db.get('SELECT * FROM users WHERE email = ?', email);
  if (u?.locked_until && u.locked_until > ctx.now()) throw new HttpError(429, 'account_locked', `Too many wrong passwords. This account is locked for ${Math.ceil((Date.parse(u.locked_until) - Date.now()) / 60000)} more minutes, or until an owner unlocks it.`);
  // Hash even when the user is missing so response time doesn't reveal which emails exist.
  const ok = verifyPassword(String(body.password ?? ''), u?.password_hash ?? 'scrypt$00$00');
  if (u && !ok) {
    const n = u.failed_logins + 1;
    ctx.db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', n >= MAX_FAILED ? 0 : n, n >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null, u.id);
  }
  if (!u || !ok) throw new HttpError(401, 'invalid_login', 'That email and password don\'t match an account.');
  if (!u.active) throw new HttpError(401, 'invalid_login', 'This account has been turned off. Ask the owner.');
  ctx.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', ctx.now(), u.id);
  return u;
}
const userOut = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, must_change_password: !!u.must_change_password });
const cleanIp = (ip) => (ip ? String(ip).replace(/^::ffff:(?=\d+\.)/, '').slice(0, 64) : null);
// Each sign-in is one device: when, from which address and browser or app, and when it was last used.
function startSession(ctx, userId, raw, { kind, days, ip, userAgent }) {
  const now = ctx.now();
  ctx.db.run('INSERT INTO sessions (token_hash, user_id, expires_at, id, kind, created_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(raw), userId, addDays(now, days), newId('ses'), kind, now, now, cleanIp(ip), userAgent ? String(userAgent).slice(0, 300) : null);
  ctx.db.run('DELETE FROM sessions WHERE expires_at < ?', now);
}
// meta: { ip, userAgent } of the device signing in.
export function login(ctx, body, meta = {}) {
  const u = checkLogin(ctx, body);
  const raw = token(32);
  startSession(ctx, u.id, raw, { kind: 'web', days: SESSION_DAYS, ...meta });
  return { token: raw, maxAge: SESSION_DAYS * 86400, user: userOut(u) };
}
// The iPhone coach app signs in with this and sends the token as "Authorization: Bearer dp_app_...".
export function appLogin(ctx, body, meta = {}) {
  const u = checkLogin(ctx, body);
  const raw = `dp_app_${token(32)}`;
  startSession(ctx, u.id, raw, { kind: 'app', days: 90, ...meta });
  return { token: raw, expires_in_days: 90, user: userOut(u) };
}
const SEEN_EVERY_MS = 5 * 60000;
export function userForSession(ctx, raw) {
  if (!raw) return null;
  const u = ctx.db.get(
    `SELECT u.id, u.email, u.name, u.role, u.must_change_password, s.id AS session_id, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    sha256(raw), ctx.now());
  if (!u) return null;
  // When this device was last used, written at most every 5 minutes.
  if (!u.last_seen_at || Date.now() - Date.parse(u.last_seen_at) > SEEN_EVERY_MS) ctx.db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', ctx.now(), sha256(raw));
  const { last_seen_at: _seen, ...user } = u;
  return user;
}
export function logout(ctx, raw) {
  if (raw) ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(raw));
}

// ---- Devices (signed-in sessions) ----
// "Chrome on Mac", "DP Coach app on iPhone": enough to recognize your own devices.
export function deviceLabel(ua, kind) {
  const s = String(ua || '');
  if (!s) return kind === 'app' ? 'DP Coach app' : 'Unknown device';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'Mac'
    : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : null;
  const br = kind === 'app' || /DPCoach|DP%20Coach/i.test(s) ? 'DP Coach app' : /Edg\//.test(s) ? 'Edge' : /Firefox\/|FxiOS/.test(s) ? 'Firefox' : /CriOS|Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : /node|undici|curl|python|okhttp/i.test(s) ? 'Script' : 'Browser';
  return os ? `${br} on ${os}` : br;
}
export function listDevices(ctx, userId, currentId = null) {
  return ctx.db.all('SELECT id, kind, created_at, last_seen_at, ip, user_agent, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_seen_at, created_at) DESC', userId, ctx.now())
    .map((d) => ({ id: d.id, device: deviceLabel(d.user_agent, d.kind), kind: d.kind ?? null, ip: d.ip, signed_in_at: d.created_at, last_seen_at: d.last_seen_at ?? d.created_at, expires_at: d.expires_at, current: !!currentId && d.id === currentId }));
}
// Sign someone out of every device, or every device but the one in use (exceptId).
export function endSessions(ctx, userId, { exceptId = null } = {}) {
  return Number((exceptId ? ctx.db.run('DELETE FROM sessions WHERE user_id = ? AND (id IS NULL OR id != ?)', userId, exceptId) : ctx.db.run('DELETE FROM sessions WHERE user_id = ?', userId)).changes);
}
export function endSession(ctx, userId, sessionId, currentId = null) {
  if (sessionId === currentId) throw new HttpError(409, 'conflict', 'That is the device you are using. Use Sign out instead.');
  const d = ctx.db.get('SELECT id, user_agent, kind FROM sessions WHERE id = ? AND user_id = ?', sessionId, userId);
  if (!d) throw notFound('Device');
  ctx.db.run('DELETE FROM sessions WHERE id = ?', d.id);
  return { id: d.id, device: deviceLabel(d.user_agent, d.kind), signed_out: true };
}

// ---- API keys ----
// The full key is returned once at creation; only its SHA-256 hash is stored. Each key has an access level, checked on
// every request (security.js#keyAllows): read only, read and send test results, or full access. Keys made before access
// levels existed keep full access; new keys are read only unless the owner chooses more.
export const KEY_SCOPES = { read: 'Read only', results: 'Read and send results', full: 'Full access' };
const KEY_COLS = 'id, label, prefix, scope, created_at, last_used_at, revoked_at';
const cleanScope = (x) => { if (typeof x !== 'string' || !Object.hasOwn(KEY_SCOPES, x)) throw badRequest('scope must be read, results or full: what the key can do.'); return x; };
export function createApiKey(ctx, body) {
  const label = v.str(body.label, 'label', { max: 80 });
  const scope = body.scope === undefined ? 'read' : cleanScope(body.scope);
  const secret = `dp_live_${token(24)}`;
  const id = newId('key');
  ctx.db.run('INSERT INTO api_keys (id, label, prefix, key_hash, created_at, scope) VALUES (?, ?, ?, ?, ?, ?)', id, label, secret.slice(0, 12), sha256(secret), ctx.now(), scope);
  return { id, label, prefix: secret.slice(0, 12), scope, secret, created_at: ctx.now() };
}
function keyRow(ctx, id) {
  const k = ctx.db.get(`SELECT ${KEY_COLS} FROM api_keys WHERE id = ?`, id);
  if (!k) throw notFound('API key');
  return k;
}
const since30 = () => new Date(Date.now() - 30 * 86400000).toISOString();
export function listApiKeys(ctx) {
  const use = new Map(ctx.db.all('SELECT key_id, COUNT(*) AS requests, SUM(status >= 400) AS errors FROM api_requests WHERE at >= ? GROUP BY key_id', since30()).map((r) => [r.key_id, r]));
  return ctx.db.all(`SELECT ${KEY_COLS} FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC`)
    .map((k) => ({ ...k, requests_30d: use.get(k.id)?.requests ?? 0, errors_30d: use.get(k.id)?.errors ?? 0 }));
}
// Rename a key or change what it can do, without replacing it. An empty or unknown level is refused, never widened.
export function updateApiKey(ctx, id, body) {
  const k = keyRow(ctx, id);
  if (body.label === undefined && body.scope === undefined) throw badRequest('Send a new label or scope.');
  const label = body.label !== undefined ? v.str(body.label, 'label', { max: 80 }) : k.label;
  let scope = k.scope;
  if (body.scope !== undefined) {
    if (k.revoked_at) throw new HttpError(409, 'conflict', 'That key is revoked. Create a new key instead.');
    scope = cleanScope(body.scope);
  }
  ctx.db.run('UPDATE api_keys SET label = ?, scope = ? WHERE id = ?', label, scope, id);
  return listApiKeys(ctx).find((x) => x.id === id);
}
export function revokeApiKey(ctx, id) {
  keyRow(ctx, id);
  ctx.db.run('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', ctx.now(), id);
  return keyRow(ctx, id);
}
export function keyForSecret(ctx, secret) {
  if (!secret?.startsWith('dp_live_')) return null;
  const k = ctx.db.get('SELECT id, label, scope, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', sha256(secret));
  if (!k) return null;
  // Write last_used_at at most once a minute.
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60000) ctx.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', ctx.now(), k.id);
  return k;
}
// Every request made with a key: method, address (never the query string or body), answer, time taken, from where and
// the error message sent back. Kept 30 days (older rows are cleared at most once an hour).
export function logApiRequest(ctx, e) {
  try {
    ctx.db.run('INSERT INTO api_requests (id, key_id, at, method, path, status, duration_ms, ip, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('req'), e.key_id, ctx.now(), e.method, String(e.path).slice(0, 300), e.status, e.duration_ms ?? null, cleanIp(e.ip), e.status >= 400 && e.error ? String(e.error).slice(0, 300) : null);
    if (!ctx.apiLogPrunedAt || Date.now() - ctx.apiLogPrunedAt > 3600e3) { ctx.apiLogPrunedAt = Date.now(); ctx.db.run('DELETE FROM api_requests WHERE at < ?', since30()); }
  } catch (err) { console.error('api request log', err.message); }
}
export function apiRequests(ctx, keyId, q = {}) {
  const k = keyRow(ctx, keyId);
  const errorsOnly = q.status === 'errors';
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
  const rows = ctx.db.all(`SELECT id, at, method, path, status, duration_ms, ip, error FROM api_requests WHERE key_id = ? AND at >= ? ${errorsOnly ? 'AND status >= 400' : ''} ORDER BY at DESC, rowid DESC LIMIT ?`, keyId, since30(), limit);
  const t = ctx.db.get('SELECT COUNT(*) AS requests, SUM(status >= 400) AS errors FROM api_requests WHERE key_id = ? AND at >= ?', keyId, since30());
  return { key: { id: k.id, label: k.label, prefix: k.prefix, scope: k.scope, revoked_at: k.revoked_at }, requests_30d: t.requests, errors_30d: t.errors ?? 0, data: rows };
}

// ---- Business pulse: the small-print numbers under Today's header ----
// Month figures run from the 1st in the business time zone; "last month" compares the same number of days.
function monthStarts(ctx) {
  const zone = getSetting(ctx, 'timezone'), today = localDate(ctx.now(), zone);
  const first = (ymd) => startOfLocalDay(zonedToUtc(`${ymd.slice(0, 8)}01`, '12:00', zone), zone);
  const thisStart = first(today);
  const [y, m] = today.split('-').map(Number);
  const prevYmd = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`;
  const prevStart = first(prevYmd);
  const sameDayLastMonth = new Date(Math.min(Date.parse(prevStart) + (Date.parse(ctx.now()) - Date.parse(thisStart)), Date.parse(thisStart))).toISOString();
  return { zone, thisStart, prevStart, sameDayLastMonth, dayStart: startOfLocalDay(ctx.now(), zone) };
}
// Money in, net of refunds, counted the same way as Billing's summary and the day's takings (billing.moneyIn): a refund
// counts when the money went back.
function collected(ctx, from, to) {
  const m = moneyIn(ctx, from, to);
  return { total: m.total, sales: m.sales, members: m.members, teams: m.teams, refunded: m.refunded_cents };
}
export function pulse(ctx, { role = 'owner', userId = null } = {}) {
  const db = ctx.db, now = ctx.now(), { thisStart, prevStart, sameDayLastMonth, dayStart } = monthStarts(ctx);
  const dayEnd = addDays(dayStart, 1), weekAgo = addDays(now, -7), weekAhead = addDays(now, 7);
  const counts = clientCounts(ctx);
  // Team roster athletes are clients too, but a new team-only athlete (put on a roster: no family, never a membership) isn't
  // a new client here. A family's athlete who is also on a team still counts, as before.
  const newClients = db.get(`SELECT COUNT(*) AS n FROM clients c WHERE c.archived_at IS NULL AND c.created_at >= ?
    AND NOT (c.family_id IS NULL AND EXISTS (SELECT 1 FROM team_roster r WHERE r.client_id = c.id) AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.client_id = c.id))`, thisStart).n;
  const canceled = db.get(`SELECT COUNT(DISTINCT client_id) AS n FROM subscriptions WHERE status = 'canceled' AND canceled_at >= ?`, thisStart).n;
  const today = db.get(`SELECT COUNT(DISTINCT s.id) AS sessions, COALESCE(SUM(s.capacity), 0) AS capacity,
      (SELECT COUNT(*) FROM bookings b JOIN class_sessions x ON x.id = b.session_id WHERE x.status = 'scheduled' AND x.starts_at >= ? AND x.starts_at < ? AND b.status IN ('booked','attended','no_show')) AS booked
    FROM class_sessions s WHERE s.status = 'scheduled' AND s.starts_at >= ? AND s.starts_at < ?`, dayStart, dayEnd, dayStart, dayEnd);
  const att = db.get(`SELECT SUM(b.status = 'attended') AS came, SUM(b.status = 'no_show') AS missed FROM bookings b JOIN class_sessions s ON s.id = b.session_id
    WHERE s.starts_at >= ? AND s.starts_at < ?`, weekAgo, now);
  const upcoming = db.get(`SELECT COUNT(*) AS n FROM bookings b JOIN class_sessions s ON s.id = b.session_id
    WHERE s.status = 'scheduled' AND b.status = 'booked' AND s.starts_at >= ? AND s.starts_at < ?`, now, weekAhead).n;
  const workouts = db.get('SELECT COUNT(*) AS n, COUNT(DISTINCT client_id) AS athletes FROM workout_logs WHERE completed_at >= ?', weekAgo);
  const newMembers = db.get(`SELECT COUNT(DISTINCT s.client_id) AS n, SUM(s.status = 'trialing') AS trialing FROM subscriptions s JOIN clients c ON c.id = s.client_id
    WHERE c.archived_at IS NULL AND s.status IN ('active','trialing') AND s.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM subscriptions o WHERE o.client_id = s.client_id AND o.id <> s.id AND o.created_at < ?)`, thisStart, thisStart);
  // Most active members: sessions attended plus workouts logged in the last 30 days.
  const monthAgo = addDays(now, -30);
  const mostActive = db.all(`SELECT c.id AS client_id, c.name,
      (SELECT COUNT(*) FROM bookings b JOIN class_sessions x ON x.id = b.session_id WHERE b.client_id = c.id AND b.status = 'attended' AND x.starts_at >= ?) AS sessions,
      (SELECT COUNT(*) FROM workout_logs l WHERE l.client_id = c.id AND l.completed_at >= ?) AS workouts
    FROM clients c WHERE c.archived_at IS NULL AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.client_id = c.id AND s.status IN ('active','trialing','past_due'))
    ORDER BY sessions + workouts DESC, c.name LIMIT 3`, monthAgo, monthAgo).filter((r) => r.sessions + r.workouts > 0);
  // A coach counts only the leads the owner gave them (owner decision: coaches see only those).
  const leads = db.get(`SELECT COUNT(*) AS n, SUM(converted_at IS NOT NULL) AS won, SUM(status IN ('new','contacted','evaluation')) AS open FROM leads WHERE created_at >= ?${role === 'coach' ? ' AND coach_id = ?' : ''}`, thisStart, ...(role === 'coach' ? [userId ?? ''] : []));
  const out = {
    clients: { active: counts.current, trialing: counts.trialing, new_this_month: newClients, canceled_this_month: canceled },
    new_members: { this_month: newMembers.n, trialing: newMembers.trialing ?? 0 },
    most_active: mostActive,
    today: { sessions: today.sessions, booked: today.booked, capacity: today.capacity },
    attendance: { came: att.came ?? 0, missed: att.missed ?? 0 },
    bookings_next_7_days: upcoming,
    workouts: { last_7_days: workouts.n, athletes: workouts.athletes },
    leads: { this_month: leads.n, won: leads.won ?? 0, open: leads.open ?? 0 }
  };
  if (role !== 'owner') return out;
  const mrr = db.get(`SELECT COALESCE(SUM(p.price_cents), 0) AS c, COUNT(*) AS n FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active'`);
  const teams = teamSummary(ctx);
  const risk = db.get(`SELECT COALESCE(SUM(i.amount_cents), 0) AS c, COUNT(*) AS n FROM invoices i WHERE i.status = 'failed'`);
  const tb = todayBounds(ctx), day = moneyIn(ctx, tb.from, tb.to);   // the day's takings: sales paid today minus refunds made today
  const todaySales = { c: day.sales, n: day.sales_count };
  // Average spend: what clients paid this month (their own sales plus membership payments) per client who paid anything.
  const spend = db.get(`SELECT COALESCE(SUM(c), 0) AS cents, COUNT(*) AS clients FROM (
      SELECT client_id, SUM(c) AS c FROM (
        SELECT client_id, amount_cents - refunded_cents AS c FROM sales WHERE client_id IS NOT NULL AND status IN ('succeeded','partially_refunded') AND completed_at >= ?
        UNION ALL SELECT client_id, amount_cents - refunded_cents FROM invoices WHERE status = 'paid' AND paid_at >= ?) GROUP BY client_id HAVING SUM(c) > 0)`, thisStart, thisStart);
  const locations = db.all(`SELECT l.id, l.name, COALESCE(SUM(s.amount_cents - s.refunded_cents), 0) AS cents, COUNT(s.id) AS sales
    FROM locations l LEFT JOIN sales s ON s.location_id = l.id AND s.status IN ('succeeded','partially_refunded') AND s.completed_at >= ?
    WHERE l.active = 1 OR s.id IS NOT NULL GROUP BY l.id ORDER BY cents DESC, l.name`, thisStart);
  return { ...out,
    money: {
      month: collected(ctx, thisStart, now), same_point_last_month: collected(ctx, prevStart, sameDayLastMonth).total,
      today_cents: todaySales.c, today_sales: todaySales.n,
      mrr_cents: mrr.c + teams.monthly_cents, member_mrr_cents: mrr.c, team_mrr_cents: teams.monthly_cents, paying_members: mrr.n,
      failed_cents: risk.c, failed_invoices: risk.n,
      avg_spend_cents: spend.clients ? Math.round(spend.cents / spend.clients) : 0, paying_clients_this_month: spend.clients,
      locations,
      team_open_cents: teams.open_cents, team_overdue_cents: teams.overdue.reduce((t, i) => t + i.amount_cents, 0), team_overdue: teams.overdue.length
    } };
}

// ---- Dashboard ----
export function dashboard(ctx, { role = 'owner', userId = null } = {}) {
  const db = ctx.db;
  // Client counts come from the same place as the client list's filters (clients.js#clientCounts), so "Active clients"
  // here is exactly what the list's Active filter shows: not archived, paid up or on a free trial.
  const counts = clientCounts(ctx);
  const active = { n: counts.active, mrr: db.get(`SELECT COALESCE(SUM(p.price_cents), 0) AS mrr FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active'`).mrr };
  const trialing = counts.trialing;
  const pastDue = { n: counts.past_due, risk: db.get(`SELECT COALESCE(SUM(p.price_cents), 0) AS risk FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'past_due'`).risk };
  const weekAgo = addDays(ctx.now(), -7);
  const workouts = db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE completed_at >= ?', weekAgo).n;

  const failed = db.all(
    `SELECT c.id AS client_id, c.name, i.id AS invoice_id, i.amount_cents, i.attempts, i.next_retry_at, p.name AS plan_name
     FROM subscriptions s JOIN clients c ON c.id = s.client_id JOIN plans p ON p.id = s.plan_id
     JOIN invoices i ON i.subscription_id = s.id AND i.status = 'failed'
     WHERE s.status = 'past_due' ORDER BY i.created_at`).map((r) => ({ kind: 'payment_failed', ...r }));
  const trials = db.all(
    `SELECT c.id AS client_id, c.name, s.trial_ends_at, p.name AS plan_name, p.price_cents AS amount_cents
     FROM subscriptions s JOIN clients c ON c.id = s.client_id JOIN plans p ON p.id = s.plan_id
     WHERE s.status = 'trialing' AND s.trial_ends_at <= ? ORDER BY s.trial_ends_at`, addDays(ctx.now(), 3)).map((r) => ({ kind: 'trial_ending', ...r }));
  const quiet = db.all(
    `SELECT c.id AS client_id, c.name, MAX(l.completed_at) AS last_workout_at
     FROM clients c JOIN subscriptions s ON s.client_id = c.id AND s.status IN ('active','trialing')
     JOIN assignments a ON a.client_id = c.id AND a.active = 1
     LEFT JOIN workout_logs l ON l.client_id = c.id
     WHERE c.archived_at IS NULL
     GROUP BY c.id HAVING last_workout_at IS NULL OR last_workout_at < ? ORDER BY last_workout_at LIMIT 5`, weekAgo)
    .filter((r) => r.last_workout_at).map((r) => ({ kind: 'inactive', ...r }));

  const pendingSales = db.all(
    `SELECT s.id AS sale_id, s.amount_cents, s.method, s.created_at, COALESCE(c.name, 'Walk-in') AS name, s.client_id, l.name AS location_name
     FROM sales s LEFT JOIN clients c ON c.id = s.client_id JOIN locations l ON l.id = s.location_id
     WHERE s.status = 'pending' AND s.created_at < ? ORDER BY s.created_at`, new Date(Date.now() - 10 * 60000).toISOString()).map((r) => ({ kind: 'sale_pending', ...r }));
  const teams = teamSummary(ctx);
  const overdueTeams = teams.overdue.map((r) => ({ kind: 'team_invoice_overdue', ...r }));
  const q = queueCount(ctx);
  const waiting = q.n ? [{ kind: 'results_waiting', count: q.n, groups: q.groups, can_link: can(role, 'GET', '/v1/queue') }] : [];   // front desk can't open the queue
  // A coach hears only about leads the owner gave them.
  const fresh = role === 'coach'
    ? db.get(`SELECT COUNT(*) AS n, MAX(parent_name) AS name FROM leads WHERE status IN ('new','contacted') AND created_at >= ? AND coach_id = ?`, weekAgo, userId ?? '')
    : db.get(`SELECT COUNT(*) AS n, MAX(parent_name) AS name FROM leads WHERE status IN ('new','contacted') AND created_at >= ?`, weekAgo);
  if (fresh.n) waiting.unshift({ kind: 'new_leads', count: fresh.n, name: fresh.name });
  const replies = unreadReplies(ctx);
  if (replies.length) waiting.unshift({ kind: 'replies', count: replies.length, items: replies.slice(0, 4).map((x) => ({ client_id: x.client_id, name: x.name, author: x.author, count: x.count, last_at: x.last_at })) });
  // Progression steps suggested from logged sets: owners and coaches approve them.
  if (role !== 'front_desk') {
    const ps = db.all(`SELECT p.id, p.client_id, c.name, e.name AS exercise_name, p.kind, p.amount FROM progressions p JOIN clients c ON c.id = p.client_id JOIN exercises e ON e.id = p.exercise_id WHERE p.status = 'suggested' AND c.archived_at IS NULL ORDER BY p.created_at`);
    if (ps.length) waiting.unshift({ kind: 'progressions', count: ps.length, items: ps.slice(0, 4).map((x) => ({ id: x.id, client_id: x.client_id, name: x.name, exercise_name: x.exercise_name, text: x.kind === 'weight' ? `+${x.amount} lb` : x.kind === 'reps' ? `+${x.amount} rep${x.amount === 1 ? '' : 's'} a set` : `+${x.amount} set${x.amount === 1 ? '' : 's'}` })) });
  }
  // Form checks waiting for an answer: owners and coaches answer them (front desk can't watch the clips).
  if (role !== 'front_desk') {
    const fcs = db.all(`SELECT f.id, f.client_id, c.name, f.exercise_name, f.sent_at FROM form_checks f JOIN clients c ON c.id = f.client_id WHERE f.status = 'sent' AND c.archived_at IS NULL ORDER BY f.sent_at`);
    if (fcs.length) waiting.unshift({ kind: 'form_checks', count: fcs.length, items: fcs.slice(0, 4).map((x) => ({ id: x.id, client_id: x.client_id, name: x.name, exercise_name: x.exercise_name, sent_at: x.sent_at })) });
  }
  const low = inventory(ctx).low;
  if (low.length) waiting.push({ kind: 'low_stock', count: low.length, items: low.slice(0, 4).map((x) => ({ name: x.name, on_hand: x.on_hand })) });
  if (role !== 'owner') {
    // Money stays with the owner: coaches and front desk see the work, not the revenue.
    return { pulse: pulse(ctx, { role, userId }), today_sales: null, metrics: { active_clients: counts.current, paying_clients: active.n, trialing_clients: trialing, archived_clients: counts.archived, workouts_last_7_days: workouts }, teams: null,
      attention: [...waiting, ...quiet, ...(role === 'front_desk' ? pendingSales.map(({ amount_cents, ...x }) => x) : pendingSales)],
      activity: listEvents(ctx, { limit: 12 }).filter((e) => !OWNER_EVENTS.test(e.type) && !(role === 'coach' && LEAD_EVENTS.test(e.type))) };
  }
  return {
    pulse: pulse(ctx, { role, userId }),
    teams: { monthly_cents: teams.monthly_cents, active_contracts: teams.active_contracts, open_cents: teams.open_cents, overdue_cents: teams.overdue.reduce((t, i) => t + i.amount_cents, 0) },
    today_sales: (() => { const t = todayBounds(ctx), m = moneyIn(ctx, t.from, t.to); return { cents: m.sales, n: m.sales_count }; })(),
    metrics: { mrr_cents: active.mrr, active_clients: counts.current, paying_clients: active.n, trialing_clients: trialing, past_due_clients: pastDue.n, archived_clients: counts.archived, at_risk_cents: pastDue.risk, workouts_last_7_days: workouts },
    attention: [...lateChargeAlerts(ctx).map((x) => ({ kind: 'late_charge', ...x })),
      ...ctx.db.all(`SELECT id AS request_id, family_id, family_name, requested_by, created_at FROM data_requests WHERE status = 'open' AND kind = 'delete'`).map((x) => ({ kind: 'deletion_request', ...x })), ...failed, ...overdueTeams, ...waiting, ...trials, ...quiet, ...pendingSales],
    activity: listEvents(ctx, { limit: 12 })
  };
}

