import { randomBytes } from 'node:crypto';
import { newId, v, notFound, conflict, badRequest, HttpError, hashPassword, verifyPassword } from '../util.js';
import { sendEmail } from './mail.js';
import { getSetting } from './families.js';

// ---------- Roles ----------
export const ROLES = {
  owner: 'Owner: everything, including money, staff, contracts and API keys.',
  coach: 'Coach: clients, schedule, testing, programs and point of sale. No billing, school contracts, refunds, API keys or staff.',
  front_desk: 'Front desk: check-ins, sales, bookings, rosters, adding clients and families, and entering test results. Can view (not change) goals, messages and lessons.'
};
const OWNER_ONLY = [
  /^\/v1\/(plans|subscriptions|invoices|billing|reports|organizations|team-contracts|team-invoices|team-billing|campaigns|api-keys|webhooks|webhook-deliveries|outbox|texts|digest|pay-links|shop|money-checks|staff|audit|backups)(\/|$)/, /^\/v1\/clients\/:id\/owed$/,
  /^\/v1\/sales\/:id\/refund$/, /^\/v1\/data-requests(\/|$)/, /^\/v1\/families\/:id\/export$/, /^\/v1\/integrations\/(hawkin|:provider)(\/|$)/
];
// Front desk: an explicit list of what it may do. Everything else is refused.
const FRONT_DESK = [
  ['GET', /^\/v1\/(dashboard|events|clients|check-ins|families|locations|products|readers|sales|schedule|agenda|class-series|sessions|bookings|availability|slots|settings|plans|programs|exercises|tests|testing-sessions|results|roster|event-types)(\/|$)/],
  // Accountability and education: front desk can look, not change anything.
  ['GET', /^\/v1\/(teams|daily-check-ins|engagement|education|lessons|courses|skill-badges)(\/|$)/],
  ['POST', /^\/v1\/clients$/], ['PATCH', /^\/v1\/clients\/:id$/], ['POST', /^\/v1\/clients\/:id\/(check-ins|card\/setup-link|card\/test)$/],
  ['POST', /^\/v1\/clients\/:id\/subscription$/],   // start a membership at the counter (not change, pause or cancel)
  ['POST', /^\/v1\/families(\/:id\/(guardians|athletes))?$/],
  ['POST', /^\/v1\/sales(\/:id\/(sync|cancel|simulate))?$/], ['POST', /^\/v1\/terminal\//],
  ['POST', /^\/v1\/sessions\/:id\/(bookings|team-attendance)$/], ['POST', /^\/v1\/bookings\/:id\/(cancel|attendance|pay)$/],
  ['POST', /^\/v1\/class-series\/:id\/(enroll|register)$/], ['POST', /^\/v1\/slots\/book$/],
  ['POST', /^\/v1\/results$/], ['GET', /^\/v1\/clients\/:id\/report$/],
  ['GET', /^\/v1\/kiosks$/], ['POST', /^\/v1\/kiosks$/],   // set up the check-in tablet at the desk
  ['GET', /^\/v1\/inventory$/], ['POST', /^\/v1\/products\/:id\/stock$/],   // receive deliveries and count the shelf
  ['GET', /^\/v1\/review-requests$/], ['GET', /^\/v1\/leads(\/|$)/], ['POST', /^\/v1\/leads$/], ['PATCH', /^\/v1\/leads\/:id$/]   // inquiries at the counter and on the phone
];
const COACH_DENY = [['DELETE', /^\/v1\/families\/:id$/], ['DELETE', /^\/v1\/leads\/:id$/], ['PATCH', /^\/v1\/settings$/], ['PUT', /^\/v1\/integrations\//], ['DELETE', /^\/v1\/integrations\//]];

export function can(role, method, path) {
  if (!path.startsWith('/v1/')) return true;
  if (role === 'owner') return true;
  if (method === 'GET' && /^\/v1\/plans$/.test(path)) return true;     // everyone needs plan names on client pages
  if (OWNER_ONLY.some((re) => re.test(path))) return false;
  if (role === 'coach') return !COACH_DENY.some(([m, re]) => m === method && re.test(path));
  if (role === 'front_desk') return FRONT_DESK.some(([m, re]) => m === method && re.test(path));
  return false;
}
// Coaches never see money. They take payments at the counter, so what the counter sells from (products, stock, plans)
// and the sales they rang up themselves keep their prices; every other _cents field is removed from what they read.
const COACH_SEES_PRICES = /^\/v1\/(products|inventory|plans|sales)(\/|$)/;
const withoutCents = (x) => (Array.isArray(x) ? x.map(withoutCents)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !k.endsWith('_cents')).map(([k, val]) => [k, withoutCents(val)])) : x);
export function hideMoney(role, method, path, out) {
  if (role !== 'coach' || method !== 'GET' || COACH_SEES_PRICES.test(path)) return out;
  return withoutCents(out);
}
// Activity that is only about money (memberships, refunds, school contracts) stays with the owner.
export const OWNER_EVENTS = /^(invoice|subscription|team_invoice|team_contract|sale\.refunded)/;
export const roleName = (r) => ({ owner: 'Owner', coach: 'Coach', front_desk: 'Front desk' }[r] ?? r);

// ---------- Staff ----------
const tempPassword = () => randomBytes(9).toString('base64url');             // 12 characters
export function listStaff(ctx) {
  return ctx.db.all('SELECT id, email, name, role, active, must_change_password, locked_until, last_login_at, created_at FROM users ORDER BY active DESC, role, name')
    .map((u) => ({ ...u, active: !!u.active, must_change_password: !!u.must_change_password, locked: !!(u.locked_until && u.locked_until > ctx.now()) }));
}
const activeOwners = (ctx) => ctx.db.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1`).n;

// New staff get a one-time password (shown once and emailed); they must choose their own on first sign-in.
export async function addStaff(ctx, body, baseUrl) {
  const email = v.email(body.email), name = v.str(body.name, 'name', { max: 120 }), role = v.oneOf(body.role ?? 'coach', 'role', Object.keys(ROLES));
  if (ctx.db.get('SELECT id FROM users WHERE email = ?', email)) throw conflict(`${email} already has a staff account.`);
  const pw = tempPassword(), id = newId('usr');
  ctx.db.run('INSERT INTO users (id, email, name, password_hash, role, active, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)', id, email, name, hashPassword(pw), role, ctx.now());
  await sendEmail(ctx, { to: email, subject: `Your ${getSetting(ctx, 'business_name')} staff account`, text: `Hi ${name.split(' ')[0]},\n\nYou've been added as ${roleName(role)}.\n\nSign in at ${baseUrl ?? ctx.publicUrl ?? ''}/ with:\nEmail: ${email}\nOne-time password: ${pw}\n\nYou'll choose your own password when you sign in.` });
  return { ...listStaff(ctx).find((u) => u.id === id), temporary_password: pw };
}
export function updateStaff(ctx, id, body, actor) {
  const u = ctx.db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('Staff member');
  const role = body.role !== undefined ? v.oneOf(body.role, 'role', Object.keys(ROLES)) : u.role;
  const active = body.active !== undefined ? !!body.active : !!u.active;
  if (u.role === 'owner' && u.active && (role !== 'owner' || !active) && activeOwners(ctx) <= 1) throw conflict('There has to be at least one active owner.');
  if (actor?.id === id && !active) throw conflict('You can\'t deactivate your own account.');
  ctx.db.run('UPDATE users SET name = ?, role = ?, active = ?, locked_until = CASE WHEN ? THEN NULL ELSE locked_until END, failed_logins = CASE WHEN ? THEN 0 ELSE failed_logins END WHERE id = ?',
    body.name !== undefined ? v.str(body.name, 'name', { max: 120 }) : u.name, role, active ? 1 : 0, body.unlock ? 1 : 0, body.unlock ? 1 : 0, id);
  if (!active || role !== u.role) ctx.db.run('DELETE FROM sessions WHERE user_id = ?', id);       // takes effect immediately
  return listStaff(ctx).find((x) => x.id === id);
}
export async function resetStaffPassword(ctx, id, baseUrl) {
  const u = ctx.db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('Staff member');
  const pw = tempPassword();
  ctx.db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', hashPassword(pw), id);
  ctx.db.run('DELETE FROM sessions WHERE user_id = ?', id);
  await sendEmail(ctx, { to: u.email, subject: 'Your password was reset', text: `Your one-time password is ${pw}. Sign in at ${baseUrl ?? ctx.publicUrl ?? ''}/ and choose a new one.` });
  return { id, temporary_password: pw };
}
export function changePassword(ctx, user, body) {
  const u = ctx.db.get('SELECT * FROM users WHERE id = ?', user.id);
  if (!verifyPassword(String(body.current_password ?? ''), u.password_hash)) throw new HttpError(400, 'invalid_request', 'Your current password is wrong.');
  const pw = v.str(body.new_password, 'new_password', { max: 200 });
  if (pw.length < 10) throw badRequest('Use at least 10 characters.');
  if (pw === body.current_password) throw badRequest('Choose a different password.');
  ctx.db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(pw), u.id);
  return { ok: true };
}

// ---------- Audit log ----------
export function audit(ctx, e) {
  try {
    ctx.db.run('INSERT INTO audit_log (id, at, actor_type, actor_id, actor_name, role, action, target, status, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('aud'), new Date().toISOString(), e.actor_type, e.actor_id ?? null, e.actor_name ?? null, e.role ?? null, e.action, e.target ?? null, e.status ?? null, e.ip ?? null);
  } catch (err) { console.error('audit', err.message); }
}
export function listAudit(ctx, q = {}) {
  const where = [], p = [];
  if (q.actor_id) { where.push('actor_id = ?'); p.push(q.actor_id); }
  if (q.target) { where.push('target = ?'); p.push(q.target); }
  if (q.failures === 'true') where.push('status >= 400');
  return ctx.db.all(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT ?`, ...p, Math.min(Number(q.limit) || 200, 1000));
}

// ---------- Rate limits (per server, in memory) ----------
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 50000) for (const [k, x] of buckets) if (x.reset < now) buckets.delete(k);
  if (b.n > max) throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${Math.ceil((b.reset - now) / 60000)} minute${Math.ceil((b.reset - now) / 60000) === 1 ? '' : 's'}.`);
}
export const resetRateLimits = () => buckets.clear();
