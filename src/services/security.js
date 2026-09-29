import { randomBytes } from 'node:crypto';
import { newId, v, notFound, conflict, badRequest, HttpError, hashPassword, verifyPassword, zonedToUtc, addDaysToDate, localDate } from '../util.js';
import { sendEmail } from './mail.js';
import { getSetting } from './families.js';

// ---------- Roles ----------
export const ROLES = {
  owner: 'Owner: everything, including money, staff, contracts and API keys.',
  coach: 'Coach: clients, schedule, testing, programs and point of sale, and the leads the owner gives them (with their own tasks). No discounts, billing, school contracts, refunds (they can undo their own sale for 10 minutes), the day\'s takings, trial-price offers, API keys or staff.',
  front_desk: 'Front desk: check-ins, sales (no discounts), bookings, rosters, leads (notes, calls, one-to-one emails and texts, tasks, converting; no lead reports, import, export or group messages), adding clients and families, and entering test results. Can view (not change) programs, goals, messages and lessons, and email an athlete their workout app link.'
};
const OWNER_ONLY = [
  /^\/v1\/(plans|subscriptions|invoices|billing|reports|organizations|team-contracts|team-invoices|team-billing|campaigns|api-keys|api-status|webhooks|webhook-deliveries|outbox|texts|video-coverage|digest|pay-links|shop|money-checks|staff|audit|backups|jobs)(\/|$)/, /^\/v1\/clients\/:id\/owed$/, /^\/v1\/clients\/:id\/subscription\/(plan|pending-plan)$/, /^\/v1\/client-export$/,
  /^\/v1\/sales\/:id\/refund$/, /^\/v1\/data-requests(\/|$)/, /^\/v1\/clients\/:id\/(merge|merge-preview)$/, /^\/v1\/(membership-requests|profile-claims)(\/|$)/, /^\/v1\/sessions\/:id\/trial-offer$/, /^\/v1\/coach-summary$/, /^\/v1\/families\/:id\/export$/, /^\/v1\/integrations\/(hawkin|:provider)(\/|$)/,
  /^\/v1\/leads\/(report|export|import)(\/|$)/,   // CRM (version 45): lead reports, export and import are the owner's
  /^\/v1\/exercises\/import(\/|$)/   // the video library (version 48): bringing in a list of exercises
];
// The owner changes these; others may read them (message templates for one-to-one emails and texts).
const OWNER_WRITES = [/^\/v1\/message-templates(\/|$)/];
// Front desk: an explicit list of what it may do. Everything else is refused.
const FRONT_DESK = [
  ['GET', /^\/v1\/(dashboard|events|wearables|clients|client-counts|check-ins|families|locations|products|readers|sales|schedule|agenda|class-series|sessions|bookings|availability|slots|settings|plans|programs|exercises|tests|test-presets|testing-sessions|results|roster|event-types|coaches|time-off|today|activity)(\/|$)/],
  // Accountability and education: front desk can look, not change anything.
  ['GET', /^\/v1\/(teams|daily-check-ins|engagement|education|lessons|courses|skill-badges)(\/|$)/],
  ['POST', /^\/v1\/clients$/], ['PATCH', /^\/v1\/clients\/:id$/],
  ['POST', /^\/v1\/clients\/:id\/notes$/], ['PATCH', /^\/v1\/client-notes\/:id$/], ['DELETE', /^\/v1\/client-notes\/:id$/],   // staff notes (never coach-only ones)
  ['POST', /^\/v1\/clients\/:id\/(check-ins|card\/setup-link|card\/test)$/],
  ['POST', /^\/v1\/clients\/:id\/subscription$/],   // start a membership at the counter (not change, pause or cancel)
  ['POST', /^\/v1\/families(\/:id\/(guardians|athletes))?$/],
  ['PATCH', /^\/v1\/families\/:id\/guardians\/:gid$/], ['POST', /^\/v1\/families\/:id\/(waiver|guardians\/:gid\/welcome)$/],   // fix a parent's details, re-send sign-in, paper waiver
  ['POST', /^\/v1\/clients\/:id\/app-link\/email$/],
  ['POST', /^\/v1\/sales(\/:id\/(sync|cancel|simulate|undo|receipt))?$/], ['POST', /^\/v1\/terminal\//],   // the day's takings (GET /v1/sales/takings) too
  ['POST', /^\/v1\/sessions\/:id\/(bookings|team-attendance|message)$/], ['POST', /^\/v1\/bookings\/:id\/(cancel|attendance|pay|promote)$/],   // run a roster: add, check in, collect, move up, email families (not change the session)
  ['POST', /^\/v1\/class-series\/:id\/(enroll|register)$/], ['POST', /^\/v1\/slots\/book$/],
  ['POST', /^\/v1\/results$/], ['GET', /^\/v1\/clients\/:id\/report$/],
  ['POST', /^\/v1\/testing-sessions\/:id\/athletes$/],   // walk-ups on a testing day (not removing athletes, editing or deleting days)
  ['GET', /^\/v1\/kiosks$/], ['POST', /^\/v1\/kiosks$/],   // set up the check-in tablet at the desk
  ['GET', /^\/v1\/inventory$/], ['POST', /^\/v1\/products\/:id\/stock$/],   // receive deliveries and count the shelf
  ['GET', /^\/v1\/review-requests$/], ['GET', /^\/v1\/leads(\/|$)/], ['POST', /^\/v1\/leads$/], ['PATCH', /^\/v1\/leads\/:id$/],   // inquiries at the counter and on the phone
  // CRM (version 45): work every lead (notes, calls, one-to-one emails and texts, converting), their own tasks, and a
  // family's contact history on the client profile. Reports, import, export and group messages stay with the owner.
  ['POST', /^\/v1\/leads\/:id\/(activity|email|text|convert)$/], ['GET', /^\/v1\/(tasks|message-templates)(\/|$)/],
  ['POST', /^\/v1\/tasks$/], ['PATCH', /^\/v1\/tasks\/:id$/], ['DELETE', /^\/v1\/tasks\/:id$/],
  ['POST', /^\/v1\/clients\/:id\/(activity|email|text|lead)$/]
];
// Front desk may look at clients, but sharing a progress report outside the business is for owners and coaches.
const FRONT_DESK_DENY = [/^\/v1\/clients\/:id\/(report-links|report\/email)(\/|$)/];
// Coaches take payments but never see the business's takings.
// Owner decision: coaches work only the leads the owner gives them (leads.js filters them), so they don't add or delete leads.
// CRM: a coach can't search every lead and family for duplicates, and doesn't email, text or re-open families one-to-one
// (they message athletes and families through coach messages and sessions); they log notes and calls and add their own tasks.
const COACH_DENY = [['GET', /^\/v1\/leads\/duplicates$/], ['POST', /^\/v1\/clients\/:id\/(email|text|lead)$/],
  ['GET', /^\/v1\/sales\/takings$/], ['DELETE', /^\/v1\/families\/:id$/], ['DELETE', /^\/v1\/leads\/:id$/], ['POST', /^\/v1\/leads$/], ['PATCH', /^\/v1\/settings$/], ['PUT', /^\/v1\/integrations\//], ['DELETE', /^\/v1\/integrations\//]];

export function can(role, method, path) {
  if (!path.startsWith('/v1/')) return true;
  if (role === 'owner') return true;
  if (method === 'GET' && /^\/v1\/plans$/.test(path)) return true;     // everyone needs plan names on client pages
  if (OWNER_ONLY.some((re) => re.test(path))) return false;
  if (method !== 'GET' && OWNER_WRITES.some((re) => re.test(path))) return false;
  if (role === 'coach') return !COACH_DENY.some(([m, re]) => m === method && re.test(path));
  if (role === 'front_desk') return !FRONT_DESK_DENY.some((re) => re.test(path)) && FRONT_DESK.some(([m, re]) => m === method && re.test(path));
  return false;
}
// API keys act for the owner on the routes an API key can use at all (auth 'any'), within their access level: read only
// keys only read (GET), "read and send results" keys may also send test results and device files, and full-access keys
// do everything. Anything unknown is treated as read only. Checked on every request in server.js.
const RESULTS_WRITES = [['POST', /^\/v1\/results$/], ['POST', /^\/v1\/imports$/]];
export function keyAllows(scope, method, path) {
  if (scope === 'full') return true;
  if (method === 'GET' || method === 'HEAD') return true;
  return scope === 'results' && RESULTS_WRITES.some(([m, re]) => m === method && re.test(path));
}
// Coaches and front desk never see money. They take payments at the counter, so what the counter sells from (products,
// stock, plans), sales and collecting for a booking keep their amounts (coaches only get their own sales; the iPhone app
// needs the amount on a sale); front desk also collects for a session, a camp or a private. Every other _cents field is
// removed from what they get back, whether they read or save (saving a client returns the client, membership price too).
const COUNTER = /^\/v1\/(products|inventory|plans|sales|terminal)(\/|$)|^\/v1\/bookings\/:id\/pay$/;
const SEES_PRICES = {
  coach: COUNTER,
  front_desk: new RegExp(`${COUNTER.source}|^\\/v1\\/slots(\\/|$)|^\\/v1\\/(sessions|class-series)\\/:id$`)
};
const withoutCents = (x) => (Array.isArray(x) ? x.map(withoutCents)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !k.endsWith('_cents')).map(([k, val]) => [k, withoutCents(val)])) : x);
export function hideMoney(role, method, path, out) {
  if (!SEES_PRICES[role] || SEES_PRICES[role].test(path)) return out;
  return withoutCents(out);
}
// Activity that is only about money (memberships, refunds, school contracts) stays with the owner.
export const OWNER_EVENTS = /^(invoice|subscription|team_invoice|team_contract|sale\.refunded)/;
// Leads in the activity feed name families who asked about training: coaches see only the leads given to them, so none here.
export const LEAD_EVENTS = /^leads?\./;
export const roleName = (r) => ({ owner: 'Owner', coach: 'Coach', front_desk: 'Front desk' }[r] ?? r);

// ---------- Staff ----------
const tempPassword = () => randomBytes(9).toString('base64url');             // 12 characters
// What someone still leads: upcoming sessions, weekly classes (and camps, clinics, team sessions) and private or
// evaluation hours. Shown before turning a coach off or moving them to front desk, and flagged while it isn't handed over.
export function workload(ctx, userId) {
  const now = ctx.now();
  return {
    sessions: ctx.db.get(`SELECT COUNT(*) AS n FROM class_sessions WHERE coach_id = ? AND status = 'scheduled' AND starts_at >= ?`, userId, now).n,
    classes: ctx.db.get('SELECT COUNT(*) AS n FROM class_series WHERE coach_id = ? AND active = 1', userId).n,
    hours: ctx.db.get('SELECT COUNT(*) AS n FROM availability WHERE coach_id = ?', userId).n,
    booked_clients: ctx.db.get(`SELECT COUNT(DISTINCT b.client_id) AS n FROM bookings b JOIN class_sessions s ON s.id = b.session_id
      WHERE s.coach_id = ? AND s.status = 'scheduled' AND s.starts_at >= ? AND b.status IN ('booked','waitlisted')`, userId, now).n
  };
}
const hasWork = (w) => w.sessions + w.classes + w.hours > 0;
export function listStaff(ctx) {
  const now = ctx.now();
  return ctx.db.all(`SELECT id, email, name, role, active, must_change_password, locked_until, last_login_at, created_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = users.id AND s.expires_at > ?) AS devices FROM users ORDER BY active DESC, role, name`, now)
    .map((u) => {
      const work = workload(ctx, u.id);
      return { ...u, active: !!u.active, must_change_password: !!u.must_change_password, locked: !!(u.locked_until && u.locked_until > now),
        never_signed_in: !u.last_login_at, work, still_leading: (!u.active || u.role === 'front_desk') && hasWork(work) };
    });
}
const activeOwners = (ctx) => ctx.db.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1`).n;
// Emailed "forgot password" links still open for someone stop working when their password is set another way (an owner
// reset, changing it themselves, a reset link used), their email changes or their account is turned off.
export const cancelResets = (ctx, userId) => Number(ctx.db.run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', ctx.now(), userId).changes);
const staffAccountEmail = (ctx, { name, email, role, pw, baseUrl, again }) => sendEmail(ctx, { to: email, sensitive: true, secret: pw,
  subject: `Your ${getSetting(ctx, 'business_name')} staff account`,
  text: `Hi ${name.split(' ')[0]},\n\n${again ? 'Here is a new one-time password for your staff account' : `You've been added as ${roleName(role)}`}.\n\nSign in at ${baseUrl ?? ctx.publicUrl ?? ''}/ with:\nEmail: ${email}\nOne-time password: ${pw}\n\nYou'll choose your own password when you sign in.` });

// New staff get a one-time password (shown once and emailed); they must choose their own on first sign-in.
export async function addStaff(ctx, body, baseUrl) {
  const email = v.email(body.email), name = v.str(body.name, 'name', { max: 120 }), role = v.oneOf(body.role ?? 'coach', 'role', Object.keys(ROLES));
  const existing = ctx.db.get('SELECT id, name, active FROM users WHERE email = ?', email);
  if (existing) throw Object.assign(conflict(existing.active ? `${email} already has a staff account.` : `${existing.name}'s turned-off account uses ${email}. Turn their account back on instead.`), { details: { user_id: existing.id, active: !!existing.active } });
  const pw = tempPassword(), id = newId('usr');
  ctx.db.run('INSERT INTO users (id, email, name, password_hash, role, active, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)', id, email, name, hashPassword(pw), role, ctx.now());
  await staffAccountEmail(ctx, { name, email, role, pw, baseUrl });
  return { ...listStaff(ctx).find((u) => u.id === id), temporary_password: pw };
}
export function updateStaff(ctx, id, body, actor) {
  const u = ctx.db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('Staff member');
  const role = body.role !== undefined ? v.oneOf(body.role, 'role', Object.keys(ROLES)) : u.role;
  const active = body.active !== undefined ? !!body.active : !!u.active;
  const email = body.email !== undefined ? v.email(body.email) : u.email;
  const emailChanged = email.toLowerCase() !== u.email.toLowerCase();
  if (emailChanged && ctx.db.get('SELECT id FROM users WHERE email = ? AND id != ?', email, id)) throw conflict(`${email} already has a staff account.`);
  if (u.role === 'owner' && u.active && (role !== 'owner' || !active) && activeOwners(ctx) <= 1) throw conflict('There has to be at least one active owner. Make someone else an owner first.');
  if (actor?.id === id && !active) throw conflict('You can\'t turn off your own account. Ask another owner.');
  if (actor?.id === id && role !== u.role) throw conflict('You can\'t change your own role. Ask another owner.');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET name = ?, email = ?, role = ?, active = ?, locked_until = CASE WHEN ? THEN NULL ELSE locked_until END, failed_logins = CASE WHEN ? THEN 0 ELSE failed_logins END WHERE id = ?',
      body.name !== undefined ? v.str(body.name, 'name', { max: 120 }) : u.name, email, role, active ? 1 : 0, body.unlock ? 1 : 0, body.unlock ? 1 : 0, id);
    if (!active || role !== u.role) ctx.db.run('DELETE FROM sessions WHERE user_id = ?', id);       // takes effect immediately
    if (!active || emailChanged) cancelResets(ctx, id);                                             // a link sent to the old address stops working
  });
  return listStaff(ctx).find((x) => x.id === id);
}
// A new one-time password, emailed (and shown once to the owner). Signs them out everywhere and cancels any emailed
// reset link, so an owner's reset of a lost or shared account always wins. For someone who never signed in it's
// "Resend invite".
export async function resetStaffPassword(ctx, id, baseUrl) {
  const u = ctx.db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('Staff member');
  if (!u.active) throw conflict(`${u.name}'s account is turned off. Turn it on first.`);
  const invite = !u.last_login_at;
  const pw = tempPassword();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', hashPassword(pw), id);
    ctx.db.run('DELETE FROM sessions WHERE user_id = ?', id);
    cancelResets(ctx, id);
  });
  await staffAccountEmail(ctx, { name: u.name, email: u.email, role: u.role, pw, baseUrl, again: true });
  return { id, temporary_password: pw, invite };
}
export const passwordChangedEmail = (ctx, u, how) => sendEmail(ctx, { to: u.email, subject: `Your ${getSetting(ctx, 'business_name')} password was changed`,
  text: `Hi ${u.name.split(' ')[0]},\n\nThe password for ${u.email} was changed ${how}. Your other devices were signed out.\n\nIf this wasn't you, ask an owner to reset your password straight away.` }).catch(() => {});
// Changing your own password needs the current one, signs out your other devices (not this one), cancels any emailed
// reset link and emails you that it happened.
export function changePassword(ctx, user, body) {
  const u = ctx.db.get('SELECT * FROM users WHERE id = ?', user.id);
  if (!verifyPassword(String(body.current_password ?? ''), u.password_hash)) throw new HttpError(400, 'invalid_request', 'Your current password is wrong.');
  const pw = v.str(body.new_password, 'new_password', { max: 200 });
  if (pw.length < 10) throw badRequest('Use at least 10 characters.');
  if (pw === body.current_password) throw badRequest('Choose a different password.');
  let signedOut = 0;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(pw), u.id);
    signedOut = Number((user.session_id ? ctx.db.run('DELETE FROM sessions WHERE user_id = ? AND (id IS NULL OR id != ?)', u.id, user.session_id) : ctx.db.run('DELETE FROM sessions WHERE user_id = ?', u.id)).changes);
    cancelResets(ctx, u.id);
  });
  if (!u.must_change_password) passwordChangedEmail(ctx, u, 'from your account page');     // not for choosing a first password
  return { ok: true, signed_out: signedOut };
}

// ---------- Connection check (owner, Staff & security) ----------
// Shows what the hosting proxy sent and which address the app picked, so the owner can confirm TRUST_PROXY. Each proxy
// adds the address it heard from at the end of X-Forwarded-For, and TRUST_PROXY=N picks the Nth entry from the end.
// If that entry is a proxy's own address (a private hosting-network address or a Cloudflare edge; Render fronts every
// service with Cloudflare), N is too low; previews show what each value would pick.
const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80:|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i;
// Cloudflare's published ranges (https://www.cloudflare.com/ips/).
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CLOUDFLARE_V6 = /^(2400:cb00|2606:4700|2803:f800|2405:b500|2405:8100|2a06:98c[0-7]|2c0f:f248):/i;
const v4num = (ip) => { const p = ip.split('.').map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null; };
export function addressKind(ip) {
  const a = String(ip ?? '').trim().replace(/^::ffff:(?=\d+\.)/i, '');
  if (!a) return null;
  if (PRIVATE.test(a) || PRIVATE.test(String(ip))) return 'private';
  const n = v4num(a);
  if (n != null) return CLOUDFLARE_V4.some((c) => { const [base, bits] = c.split('/'); const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0; return ((n & mask) >>> 0) === ((v4num(base) & mask) >>> 0); }) ? 'cloudflare' : 'public';
  return CLOUDFLARE_V6.test(a) ? 'cloudflare' : 'public';
}
const KIND_WORDS = { private: 'a private address inside the hosting network', cloudflare: 'a Cloudflare proxy address', public: 'a public address' };
export function connectionCheck({ forwardedFor, socketAddress, clientIp, trustProxy, hops }) {
  const list = String(forwardedFor ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const pick = (n) => list[Math.max(0, list.length - n)];
  const previews = list.map((_, i) => ({ trust_proxy: i + 1, address: pick(i + 1), kind: addressKind(pick(i + 1)) }));
  const kind = addressKind(clientIp), left = hops ? list.length - hops : 0;     // entries to the left of the one picked
  let guidance;
  if (!hops && list.length) guidance = `Requests reach the app through ${list.length === 1 ? 'a proxy' : 'proxies'} but TRUST_PROXY is off, so every visitor looks like ${socketAddress} and shares one rate limit: set TRUST_PROXY to ${list.length} if ${list[0]} is your own internet address.`;
  else if (!hops) guidance = 'No proxy header arrived and TRUST_PROXY is off, which is right when nothing sits in front of the app.';
  else if (!list.length) guidance = 'TRUST_PROXY is on but no X-Forwarded-For header arrived, so the app uses the connection address; turn TRUST_PROXY off unless a proxy sits in front of the app.';
  else if (hops > list.length) guidance = `TRUST_PROXY is ${hops} but only ${list.length} ${list.length === 1 ? 'address arrived' : 'addresses arrived'}, so the app falls back to ${clientIp}: lower TRUST_PROXY to ${list.length}.`;
  else if ((kind === 'private' || kind === 'cloudflare') && left > 0) guidance = `The app picked ${clientIp}, ${KIND_WORDS[kind]}, not yours: raise TRUST_PROXY to ${hops + 1} and the app would pick ${pick(hops + 1)}${addressKind(pick(hops + 1)) === 'public' ? ' (check it matches "what is my IP" on this device)' : `, which is also ${KIND_WORDS[addressKind(pick(hops + 1))]}, so you may need more`}.`;
  else if (kind === 'private' || kind === 'cloudflare') guidance = `The app picked ${clientIp}, ${KIND_WORDS[kind]}, and nothing further arrived in the header, so the proxy in front isn't passing your address along. Check the proxy's settings.`;
  else if (left > 0) guidance = `If ${clientIp} is your own internet address (search "what is my IP" on this device to compare), TRUST_PROXY is set right. If it isn't, raise TRUST_PROXY to ${hops + 1} and the app would pick ${pick(hops + 1)}.`;
  else guidance = `If ${clientIp} is your own internet address (search "what is my IP" on this device to compare), TRUST_PROXY is set right${hops > 1 ? '; if it isn\'t, lower TRUST_PROXY by one and check again' : ''}.`;
  return { forwarded_for: forwardedFor || null, forwarded_addresses: list, connection_address: socketAddress ?? null, decided_address: clientIp ?? null, decided_kind: kind, trust_proxy: trustProxy ?? null, proxies_trusted: hops, previews, guidance };
}

// ---------- Audit log ----------
export function audit(ctx, e) {
  try {
    ctx.db.run('INSERT INTO audit_log (id, at, actor_type, actor_id, actor_name, role, action, target, status, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('aud'), new Date().toISOString(), e.actor_type, e.actor_id ?? null, e.actor_name ?? null, e.role ?? null, e.action, e.target ?? null, e.status ?? null, e.ip ?? null);
  } catch (err) { console.error('audit', err.message); }
}
// Filters shared by the activity log and its CSV export:
//   who (staff, api_key, parent, public, system), staff_id (that person's own actions, plus sign-ins and reset requests
//   typed with their email), actor_id, target, kind (sign_ins, refused, failures), failures=true, since and until
//   (YYYY-MM-DD, whole days in the business time zone) and q (name, record, address, or the plain-English description:
//   actions lists the log actions whose description matches, worked out by routes.js).
const AUDIT_WHO = ['staff', 'api_key', 'parent', 'athlete', 'public', 'system'];
const SIGN_IN_ACTIONS = ['sign-in', 'POST /auth/forgot', 'POST /auth/reset'];
function auditWhere(ctx, q) {
  const where = [], p = [];
  if (q.who) {
    if (!AUDIT_WHO.includes(q.who)) throw badRequest(`who must be one of: ${AUDIT_WHO.join(', ')}.`);
    where.push('actor_type = ?'); p.push(q.who);
  }
  if (q.staff_id) {
    const u = ctx.db.get('SELECT id, email FROM users WHERE id = ?', q.staff_id);
    if (!u) throw notFound('Staff member');
    where.push(`((actor_type = 'staff' AND actor_id = ?) OR (actor_type = 'public' AND action IN (${SIGN_IN_ACTIONS.map(() => '?').join(', ')}) AND actor_name = ? COLLATE NOCASE))`);
    p.push(u.id, ...SIGN_IN_ACTIONS, u.email);
  }
  if (q.actor_id) { where.push('actor_id = ?'); p.push(q.actor_id); }
  if (q.target) { where.push('target = ?'); p.push(q.target); }
  if (q.failures === 'true' || q.kind === 'failures') where.push('status >= 400');
  if (q.kind === 'sign_ins') { where.push(`action IN (${SIGN_IN_ACTIONS.map(() => '?').join(', ')})`); p.push(...SIGN_IN_ACTIONS); }
  else if (q.kind === 'refused') where.push('status = 403');
  else if (q.kind && q.kind !== 'failures') throw badRequest('kind must be sign_ins, refused or failures.');
  const zone = getSetting(ctx, 'timezone');
  const day = (x, name) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x)) || Number.isNaN(Date.parse(x))) throw badRequest(`${name} must be a date like 2026-09-01.`); return x; };
  if (q.since) { where.push('at >= ?'); p.push(zonedToUtc(day(q.since, 'since'), '00:00', zone)); }
  if (q.until) { where.push('at < ?'); p.push(zonedToUtc(addDaysToDate(day(q.until, 'until'), 1), '00:00', zone)); }
  const text = String(q.q ?? '').trim().slice(0, 100);
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const actions = (q.actions ?? []).slice(0, 500);
    where.push(`(actor_name LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\'${actions.length ? ` OR action IN (${actions.map(() => '?').join(', ')})` : ''})`);
    p.push(like, like, like, like, ...actions);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', p };
}
export function listAudit(ctx, q = {}) {
  const { sql, p } = auditWhere(ctx, q);
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000), offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);
  return ctx.db.all(`SELECT * FROM audit_log ${sql} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
}
export function countAudit(ctx, q = {}) {
  const { sql, p } = auditWhere(ctx, q);
  return ctx.db.get(`SELECT COUNT(*) AS n FROM audit_log ${sql}`, ...p).n;
}
// A spreadsheet cell that starts with = + - @ (or a tab or carriage return) could run as a formula when opened, so it
// gets a leading apostrophe (also after leading spaces, which some spreadsheets skip); every cell is quoted.
export const csvCell = (x) => { let t = x == null ? '' : String(x); if (/^[\s]*[=+\-@]|^[\t\r]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
export function auditCsv(ctx, q, describe) {
  const { sql, p } = auditWhere(ctx, q);
  const zone = getSetting(ctx, 'timezone');
  const local = (iso) => { const d = new Date(iso); return `${localDate(iso, zone)} ${new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)}`; };
  const rows = ctx.db.all(`SELECT * FROM audit_log ${sql} ORDER BY at DESC, rowid DESC LIMIT 20000`, ...p);
  const lines = [['When (UTC)', `When (${zone})`, 'Who', 'Kind', 'Role', 'What', 'Record', 'Result', 'From'].map(csvCell).join(',')]
    .concat(rows.map((a) => [a.at, local(a.at), a.actor_name ?? '', a.actor_type, a.role ? roleName(a.role) : '', describe(a), a.target ?? '', a.status ?? '', a.ip ?? ''].map(csvCell).join(',')));
  return { csv: `${lines.join('\r\n')}\r\n`, count: rows.length };
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
