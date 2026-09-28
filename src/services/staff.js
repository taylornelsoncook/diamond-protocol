// Staff & security beyond the basics in security.js: the security summary, one person's manage panel (devices, recent
// activity, what they still lead), handing a departing coach's work to someone else, and "forgot password" links.
import { newId, token, sha256, hashPassword, verifyPassword, v, notFound, conflict, badRequest } from '../util.js';
import { sendEmail } from './mail.js';
import { getSetting } from './families.js';
import { listBackups } from './backups.js';
import * as offsite from './offsite.js';
import { listDevices } from './access.js';
import { listStaff, workload, cancelResets, passwordChangedEmail, listAudit, audit } from './security.js';

// ---------- Security summary (top of Staff & security) ----------
export function securitySummary(ctx) {
  const staff = listStaff(ctx);
  const day = new Date(Date.now() - 86400000).toISOString(), week = new Date(Date.now() - 7 * 86400000).toISOString();
  const backups = listBackups(ctx), last = backups[0] ?? null;
  const hoursSince = last ? (Date.now() - Date.parse(last.created_at)) / 3600e3 : null;
  return {
    can_sign_in: staff.filter((u) => u.active).length,
    turned_off: staff.filter((u) => !u.active).length,
    locked: staff.filter((u) => u.active && u.locked).length,
    // Invited and never signed in (not someone an owner just reset, who has signed in before).
    not_signed_in_yet: staff.filter((u) => u.active && u.must_change_password && u.never_signed_in).length,
    still_leading: staff.filter((u) => u.still_leading).map((u) => ({ id: u.id, name: u.name, active: u.active, role: u.role, work: u.work })),
    failed_sign_ins_24h: ctx.db.get(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sign-in' AND status >= 400 AND at >= ?`, day).n,
    refused_7d: ctx.db.get('SELECT COUNT(*) AS n FROM audit_log WHERE status = 403 AND at >= ?', week).n,
    backups: { count: backups.length, total_bytes: backups.reduce((t, b) => t + b.bytes, 0), last_at: last?.created_at ?? null,
      // A backup runs every day; more than 26 hours without one means the job isn't running (a database in memory has none).
      overdue: ctx.dbFile !== ':memory:' && ctx.dbFile != null && (hoursSince == null || hoursSince > 26), offsite: offsite.status(ctx) }
  };
}

// ---------- One staff member ----------
export function staffDetail(ctx, id, currentSessionId = null) {
  const u = listStaff(ctx).find((x) => x.id === id);
  if (!u) throw notFound('Staff member');
  return { ...u, devices: listDevices(ctx, id, currentSessionId), recent: listAudit(ctx, { staff_id: id, limit: 10 }) };
}

// ---------- Handing over a coach's work ----------
// Everything they lead from now on goes to another active coach or owner (to), or to nobody (to = null): upcoming
// sessions (their own and ones they sub for), weekly classes, camps, clinics and team sessions (so new sessions follow),
// and private or evaluation hours. Hours can't be "nobody's" (hours with no coach mean the place's own hours), so with
// nobody they are removed. Past sessions keep who led them. Sessions that would double-book the new coach (they already
// lead something at that time) are refused unless leave_conflicts is set, which leaves those with the old coach to sort
// out on the schedule. One transaction; the audit log gets a plain-English line.
function target(ctx, fromId, to) {
  if (to === null || to === '') return null;
  const u = ctx.db.get('SELECT id, name, role, active FROM users WHERE id = ?', v.str(to, 'to', { max: 64 }));
  if (!u) throw notFound('Coach');
  if (u.id === fromId) throw badRequest('Choose someone else to take over.');
  if (!u.active) throw conflict(`${u.name}'s account is turned off. Choose an active coach or owner.`);
  if (u.role === 'front_desk') throw badRequest(`${u.name} is front desk. Choose a coach or an owner to lead these sessions.`);
  return u;
}
function conflictsFor(ctx, fromId, toId) {
  if (!toId) return [];
  return ctx.db.all(`SELECT s.id, s.name, s.starts_at, s.ends_at, o.id AS clash_id, o.name AS clash_name FROM class_sessions s
    JOIN class_sessions o ON o.coach_id = ? AND o.status = 'scheduled' AND o.id != s.id AND o.starts_at < s.ends_at AND o.ends_at > s.starts_at
    WHERE s.coach_id = ? AND s.status = 'scheduled' AND s.starts_at >= ? ORDER BY s.starts_at`, toId, fromId, ctx.now());
}
export function handOverPreview(ctx, fromId, to) {
  const from = ctx.db.get('SELECT id, name, role, active FROM users WHERE id = ?', fromId);
  if (!from) throw notFound('Staff member');
  const t = to === undefined ? undefined : target(ctx, fromId, to);
  const upcoming = ctx.db.all(`SELECT s.id, s.name, s.kind, s.starts_at, l.name AS location_name, (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','waitlisted')) AS booked
    FROM class_sessions s JOIN locations l ON l.id = s.location_id WHERE s.coach_id = ? AND s.status = 'scheduled' AND s.starts_at >= ? ORDER BY s.starts_at LIMIT 10`, fromId, ctx.now());
  return { from: { id: from.id, name: from.name, role: from.role, active: !!from.active }, to: t ? { id: t.id, name: t.name } : t ?? undefined, work: workload(ctx, fromId), upcoming,
    conflicts: t ? conflictsFor(ctx, fromId, t.id) : [] };
}
export function handOver(ctx, fromId, body = {}, actor = null) {
  const from = ctx.db.get('SELECT id, name FROM users WHERE id = ?', fromId);
  if (!from) throw notFound('Staff member');
  if (body.to === undefined) throw badRequest('Choose who takes over (to), or null for nobody.');
  const t = target(ctx, fromId, body.to);
  return ctx.db.tx(() => {
    const clashes = conflictsFor(ctx, fromId, t?.id);
    if (clashes.length && !body.leave_conflicts) {
      throw Object.assign(conflict(`${t.name} already leads something at the same time as ${clashes.length === 1 ? `${clashes[0].name}` : `${clashes.length} of these sessions`}. Choose someone else, move ${clashes.length === 1 ? 'it' : 'them'} first, or leave ${clashes.length === 1 ? 'it' : 'them'} with ${from.name} for now.`),
        { details: { conflicts: clashes } });
    }
    const now = ctx.now(), toId = t?.id ?? null, skip = clashes.map((c) => c.id);
    const sessions = Number(ctx.db.run(`UPDATE class_sessions SET coach_id = ? WHERE coach_id = ? AND status = 'scheduled' AND starts_at >= ?${skip.length ? ` AND id NOT IN (${skip.map(() => '?').join(', ')})` : ''}`,
      toId, fromId, now, ...skip).changes);
    const classes = Number(ctx.db.run('UPDATE class_series SET coach_id = ? WHERE coach_id = ? AND active = 1', toId, fromId).changes);
    const hours = Number((toId ? ctx.db.run('UPDATE availability SET coach_id = ? WHERE coach_id = ?', toId, fromId) : ctx.db.run('DELETE FROM availability WHERE coach_id = ?', fromId)).changes);
    const out = { from: { id: from.id, name: from.name }, to: t ? { id: t.id, name: t.name } : null, sessions, classes, hours, hours_removed: !toId, left_with_them: skip.length, still: workload(ctx, fromId) };
    const parts = [sessions && `${sessions} upcoming ${sessions === 1 ? 'session' : 'sessions'}`, classes && `${classes} ${classes === 1 ? 'class' : 'classes'}`, hours && `${hours} ${hours === 1 ? 'block' : 'blocks'} of hours${toId ? '' : ' (removed)'}`].filter(Boolean);
    if (actor) audit(ctx, { actor_type: 'staff', actor_id: actor.id, actor_name: actor.name, role: actor.role, action: `Handed over ${from.name}'s work to ${t ? t.name : 'nobody'}: ${parts.join(', ') || 'nothing to move'}${skip.length ? `; ${skip.length} left with ${from.name}` : ''}`, target: from.id, status: 200 });
    return out;
  });
}

// ---------- "Forgot password" for staff ----------
// Anyone can ask; the answer is the same whether or not the email belongs to an account, and the email goes out in the
// background, so neither the answer nor its timing tells which emails are staff. An active account gets a link to
// /#reset=<secret> that works once, for 30 minutes; only a hash of the secret is stored. Asking again replaces the
// earlier link, and at most 3 links an hour go to one account (more asks are quietly ignored). Any other way the
// password is set (an owner reset, changing it yourself), an email change or turning the account off cancels open links.
const RESET_MINUTES = 30, RESETS_PER_HOUR = 3;
const EXPIRED = 'That reset link has expired or was already used. Ask for a new one from the sign-in page.';
export function requestPasswordReset(ctx, body, { ip, baseUrl } = {}) {
  let email;
  try { email = v.email(body.email); } catch { throw badRequest('Enter the email you sign in with.'); }
  const u = ctx.db.get('SELECT id, name, email, active FROM users WHERE email = ?', email);
  if (u?.active) {
    const recent = ctx.db.get('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at >= ?', u.id, new Date(Date.now() - 3600e3).toISOString()).n;
    if (recent < RESETS_PER_HOUR) {
      const raw = token(32), now = ctx.now();
      ctx.db.tx(() => {
        cancelResets(ctx, u.id);
        ctx.db.run('INSERT INTO password_resets (id, user_id, token_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          newId('pwr'), u.id, sha256(raw), new Date(Date.now() + RESET_MINUTES * 60000).toISOString(), ip ? String(ip).slice(0, 64) : null, now);
      });
      const link = `${baseUrl ?? ctx.publicUrl ?? ''}/#reset=${raw}`;
      sendEmail(ctx, { to: u.email, sensitive: true, secret: raw, subject: `Reset your ${getSetting(ctx, 'business_name')} password`,
        text: `Hi ${u.name.split(' ')[0]},\n\nSomeone asked to reset the password for ${u.email}. Choose a new one here (the link works once, for ${RESET_MINUTES} minutes):\n\n${link}\n\nIf it wasn't you, ignore this email. Your password stays the same.` }).catch(() => {});
    }
  }
  return { ok: true, minutes: RESET_MINUTES, message: `If ${email} belongs to a staff account, a reset link is on its way. It works once, for ${RESET_MINUTES} minutes.` };
}
function openReset(ctx, raw) {
  if (typeof raw !== 'string' || !/^[\w-]{20,80}$/.test(raw)) return null;
  const r = ctx.db.get(`SELECT p.id, p.user_id, u.name, u.email, u.password_hash FROM password_resets p JOIN users u ON u.id = p.user_id
    WHERE p.token_hash = ? AND p.used_at IS NULL AND p.expires_at > ? AND u.active = 1`, sha256(raw), ctx.now());
  return r ?? null;
}
export function checkReset(ctx, body) {
  const r = openReset(ctx, body.token);
  if (!r) throw badRequest(EXPIRED, 'reset_expired');
  return { ok: true, first_name: r.name.split(' ')[0], email: r.email };
}
export function resetPassword(ctx, body) {
  const pw = v.str(body.password, 'password', { max: 200 });
  if (pw.length < 10) throw badRequest('Use at least 10 characters.');
  const r = ctx.db.tx(() => {
    const open = openReset(ctx, body.token);
    if (!open) throw badRequest(EXPIRED, 'reset_expired');
    if (verifyPassword(pw, open.password_hash)) throw badRequest('That\'s your current password. Choose a new one, or go back and sign in with it.');
    // Used exactly once: the first request to mark it wins.
    if (!ctx.db.run('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', ctx.now(), open.id).changes) throw badRequest(EXPIRED, 'reset_expired');
    ctx.db.run('UPDATE users SET password_hash = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL WHERE id = ?', hashPassword(pw), open.user_id);
    cancelResets(ctx, open.user_id);
    ctx.db.run('DELETE FROM sessions WHERE user_id = ?', open.user_id);
    return open;
  });
  passwordChangedEmail(ctx, { name: r.name, email: r.email }, 'with an emailed reset link');
  return { ok: true, email: r.email };
}
