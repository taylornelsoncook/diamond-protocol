import { newId, token, sha256, hashPassword, verifyPassword, v, notFound, HttpError, addDays, startOfLocalDay, localDate, zonedToUtc } from '../util.js';
import { getSetting } from './families.js';
import { listEvents } from './events.js';
import { teamSummary } from './teams.js';
import { queueCount } from './queue.js';
import { inventory } from './inventory.js';
import { unreadReplies } from './engage.js';
import { OWNER_EVENTS, can } from './security.js';
import { clientCounts } from './clients.js';

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
export function login(ctx, body) {
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
  const raw = token(32);
  ctx.db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(raw), u.id, addDays(ctx.now(), SESSION_DAYS));
  ctx.db.run('DELETE FROM sessions WHERE expires_at < ?', ctx.now());
  return { token: raw, maxAge: SESSION_DAYS * 86400, user: { id: u.id, email: u.email, name: u.name, role: u.role, must_change_password: !!u.must_change_password } };
}
// The iPhone coach app signs in with this and sends the token as "Authorization: Bearer dp_app_...".
export function appLogin(ctx, body) {
  const out = login(ctx, body);
  ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(out.token));
  const raw = `dp_app_${token(32)}`;
  ctx.db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(raw), out.user.id, addDays(ctx.now(), 90));
  return { token: raw, expires_in_days: 90, user: out.user };
}
export function userForSession(ctx, raw) {
  if (!raw) return null;
  return ctx.db.get(
    `SELECT u.id, u.email, u.name, u.role, u.must_change_password FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    sha256(raw), ctx.now()) ?? null;
}
export function logout(ctx, raw) {
  if (raw) ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(raw));
}

// ---- API keys ----
// The full key is returned once at creation; only its SHA-256 hash is stored.
export function createApiKey(ctx, body) {
  const label = v.str(body.label, 'label', { max: 80 });
  const secret = `dp_live_${token(24)}`;
  const id = newId('key');
  ctx.db.run('INSERT INTO api_keys (id, label, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, label, secret.slice(0, 12), sha256(secret), ctx.now());
  return { id, label, prefix: secret.slice(0, 12), secret, created_at: ctx.now() };
}
export function listApiKeys(ctx) {
  return ctx.db.all('SELECT id, label, prefix, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC');
}
export function revokeApiKey(ctx, id) {
  const k = ctx.db.get('SELECT id FROM api_keys WHERE id = ?', id);
  if (!k) throw notFound('API key');
  ctx.db.run('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', ctx.now(), id);
  return ctx.db.get('SELECT id, label, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE id = ?', id);
}
export function keyForSecret(ctx, secret) {
  if (!secret?.startsWith('dp_live_')) return null;
  const k = ctx.db.get('SELECT id, label, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', sha256(secret));
  if (!k) return null;
  // Write last_used_at at most once a minute.
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60000) ctx.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', ctx.now(), k.id);
  return k;
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
function collected(db, from, to) {
  const sales = db.get(`SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS c FROM sales WHERE status IN ('succeeded','partially_refunded') AND completed_at >= ? AND completed_at < ?`, from, to).c;
  const members = db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?`, from, to).c;
  const teams = db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM team_invoices WHERE status = 'paid' AND paid_on >= ? AND paid_on < ?`, from.slice(0, 10), to.slice(0, 10)).c;
  return { total: sales + members + teams, sales, members, teams };
}
export function pulse(ctx, { role = 'owner' } = {}) {
  const db = ctx.db, now = ctx.now(), { thisStart, prevStart, sameDayLastMonth, dayStart } = monthStarts(ctx);
  const dayEnd = addDays(dayStart, 1), weekAgo = addDays(now, -7), weekAhead = addDays(now, 7);
  const counts = clientCounts(ctx);
  const newClients = db.get(`SELECT COUNT(*) AS n FROM clients WHERE archived_at IS NULL AND created_at >= ?`, thisStart).n;
  const canceled = db.get(`SELECT COUNT(DISTINCT client_id) AS n FROM subscriptions WHERE status = 'canceled' AND canceled_at >= ?`, thisStart).n;
  const today = db.get(`SELECT COUNT(DISTINCT s.id) AS sessions, COALESCE(SUM(s.capacity), 0) AS capacity,
      (SELECT COUNT(*) FROM bookings b JOIN class_sessions x ON x.id = b.session_id WHERE x.status = 'scheduled' AND x.starts_at >= ? AND x.starts_at < ? AND b.status IN ('booked','attended','no_show')) AS booked
    FROM class_sessions s WHERE s.status = 'scheduled' AND s.starts_at >= ? AND s.starts_at < ?`, dayStart, dayEnd, dayStart, dayEnd);
  const att = db.get(`SELECT SUM(b.status = 'attended') AS came, SUM(b.status = 'no_show') AS missed FROM bookings b JOIN class_sessions s ON s.id = b.session_id
    WHERE s.starts_at >= ? AND s.starts_at < ?`, weekAgo, now);
  const upcoming = db.get(`SELECT COUNT(*) AS n FROM bookings b JOIN class_sessions s ON s.id = b.session_id
    WHERE s.status = 'scheduled' AND b.status = 'booked' AND s.starts_at >= ? AND s.starts_at < ?`, now, weekAhead).n;
  const workouts = db.get('SELECT COUNT(*) AS n, COUNT(DISTINCT client_id) AS athletes FROM workout_logs WHERE completed_at >= ?', weekAgo);
  const leads = db.get(`SELECT COUNT(*) AS n, SUM(converted_at IS NOT NULL) AS won, SUM(status IN ('new','contacted','evaluation')) AS open FROM leads WHERE created_at >= ?`, thisStart);
  const out = {
    clients: { active: counts.current, trialing: counts.trialing, new_this_month: newClients, canceled_this_month: canceled },
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
  const todaySales = db.get(`SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS c, COUNT(*) AS n FROM sales WHERE status IN ('succeeded','partially_refunded') AND completed_at >= ?`, dayStart);
  return { ...out,
    money: {
      month: collected(db, thisStart, now), same_point_last_month: collected(db, prevStart, sameDayLastMonth).total,
      today_cents: todaySales.c, today_sales: todaySales.n,
      mrr_cents: mrr.c + teams.monthly_cents, member_mrr_cents: mrr.c, team_mrr_cents: teams.monthly_cents, paying_members: mrr.n,
      failed_cents: risk.c, failed_invoices: risk.n,
      team_open_cents: teams.open_cents, team_overdue_cents: teams.overdue.reduce((t, i) => t + i.amount_cents, 0), team_overdue: teams.overdue.length
    } };
}

// ---- Dashboard ----
export function dashboard(ctx, { role = 'owner' } = {}) {
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
  const fresh = db.get(`SELECT COUNT(*) AS n, MAX(parent_name) AS name FROM leads WHERE status IN ('new','contacted') AND created_at >= ?`, weekAgo);
  if (fresh.n) waiting.unshift({ kind: 'new_leads', count: fresh.n, name: fresh.name });
  const replies = unreadReplies(ctx);
  if (replies.length) waiting.unshift({ kind: 'replies', count: replies.length, items: replies.slice(0, 4).map((x) => ({ client_id: x.client_id, name: x.name, author: x.author, count: x.count, last_at: x.last_at })) });
  const low = inventory(ctx).low;
  if (low.length) waiting.push({ kind: 'low_stock', count: low.length, items: low.slice(0, 4).map((x) => ({ name: x.name, on_hand: x.on_hand })) });
  if (role !== 'owner') {
    // Money stays with the owner: coaches and front desk see the work, not the revenue.
    return { pulse: pulse(ctx, { role }), today_sales: null, metrics: { active_clients: counts.current, paying_clients: active.n, trialing_clients: trialing, archived_clients: counts.archived, workouts_last_7_days: workouts }, teams: null,
      attention: [...waiting, ...quiet, ...(role === 'front_desk' ? pendingSales.map(({ amount_cents, ...x }) => x) : pendingSales)],
      activity: listEvents(ctx, { limit: 12 }).filter((e) => !OWNER_EVENTS.test(e.type)) };
  }
  return {
    pulse: pulse(ctx, { role }),
    teams: { monthly_cents: teams.monthly_cents, active_contracts: teams.active_contracts, open_cents: teams.open_cents, overdue_cents: teams.overdue.reduce((t, i) => t + i.amount_cents, 0) },
    today_sales: db.get(`SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS cents, COUNT(*) AS n FROM sales WHERE status IN ('succeeded','partially_refunded') AND completed_at >= ?`, startOfLocalDay(ctx.now(), getSetting(ctx, 'timezone'))),
    metrics: { mrr_cents: active.mrr, active_clients: counts.current, paying_clients: active.n, trialing_clients: trialing, past_due_clients: pastDue.n, archived_clients: counts.archived, at_risk_cents: pastDue.risk, workouts_last_7_days: workouts },
    attention: [...ctx.db.all(`SELECT id AS request_id, family_id, family_name, requested_by, created_at FROM data_requests WHERE status = 'open' AND kind = 'delete'`).map((x) => ({ kind: 'deletion_request', ...x })), ...failed, ...overdueTeams, ...waiting, ...trials, ...quiet, ...pendingSales],
    activity: listEvents(ctx, { limit: 12 })
  };
}

