// Staff accounts beyond sign-in itself: sign-in records, devices (sessions), handing work to another coach,
// emailed password-reset links, the security summary and activity-log filters.
'use strict';
const { db, get, all, run, insert, update, tx } = require('../db');
const { randomToken, sha256, sendEmail, businessName, appUrl } = require('../lib');

// ---- schema upgrades (idempotent) ----
const staffCols = all('PRAGMA table_info(staff)').map((c) => c.name);
if (!staffCols.includes('last_signin_at')) db.exec('ALTER TABLE staff ADD COLUMN last_signin_at TEXT');
if (!staffCols.includes('last_signin_ip')) db.exec('ALTER TABLE staff ADD COLUMN last_signin_ip TEXT');
const sessCols = all('PRAGMA table_info(auth_sessions)').map((c) => c.name);
if (!sessCols.includes('ip')) db.exec('ALTER TABLE auth_sessions ADD COLUMN ip TEXT');
if (!sessCols.includes('user_agent')) db.exec('ALTER TABLE auth_sessions ADD COLUMN user_agent TEXT');
if (!sessCols.includes('last_seen')) db.exec('ALTER TABLE auth_sessions ADD COLUMN last_seen TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS staff_resets (
  id INTEGER PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff(id), token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL, used_at TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')));`);

const RESET_MIN = 30, RESET_PER_HOUR = 3, SEEN_EVERY_MS = 5 * 6e4;
const ROLE_LABEL = { owner: 'Owner', coach: 'Coach', frontdesk: 'Front desk' };
const cleanIp = (ip) => (ip ? String(ip).replace(/^::ffff:/, '') : null);
// SQLite datetime('now') is UTC without a zone; hand the browser real ISO strings.
const iso = (t) => (!t ? null : t.includes('T') ? t : t.replace(' ', 'T') + 'Z');

// "Chrome on Mac", "Safari on iPhone"; good enough to recognize your own devices.
function deviceLabel(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown device';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'Mac'
    : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : null;
  const br = /DPCoach/i.test(s) ? 'DP Coach app' : /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /CriOS|Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : /node|undici|curl/i.test(s) ? 'Script' : 'Browser';
  return os ? `${br} on ${os}` : br;
}

// Called by auth.js right after a staff sign-in starts a session.
function noteSignIn(req, staffId, token) {
  const ip = cleanIp(req.ip), now = new Date().toISOString();
  update('staff', staffId, { last_signin_at: now, last_signin_ip: ip });
  if (token) run('UPDATE auth_sessions SET ip=?, user_agent=?, last_seen=? WHERE token_hash=?', ip, String(req.get?.('user-agent') || '').slice(0, 300), now, sha256(token));
}

// Called by auth.js loadUser for signed-in staff: remembers this device's session and when it was last used.
function seen(req, token) {
  if (!token) return;
  const hash = sha256(token);
  req.staffSession = hash;
  const cutoff = new Date(Date.now() - SEEN_EVERY_MS).toISOString();
  run("UPDATE auth_sessions SET last_seen=? WHERE token_hash=? AND kind='staff' AND (last_seen IS NULL OR last_seen<?)", new Date().toISOString(), hash, cutoff);
}

function sessions(staffId, currentHash) {
  return all("SELECT rowid AS id, token_hash, ip, user_agent, last_seen, created_at, expires_at FROM auth_sessions WHERE kind='staff' AND user_id=? AND expires_at>? ORDER BY COALESCE(last_seen, created_at) DESC",
    staffId, new Date().toISOString())
    .map((s) => ({ id: s.id, device: deviceLabel(s.user_agent), ip: s.ip, signed_in_at: iso(s.created_at), last_seen: iso(s.last_seen) || iso(s.created_at), current: !!currentHash && s.token_hash === currentHash }));
}
const endSessions = (staffId, exceptHash = null) =>
  Number(run("DELETE FROM auth_sessions WHERE kind='staff' AND user_id=? AND token_hash IS NOT ?", staffId, exceptHash).changes);

// ---- handing work to someone else when a coach leaves or changes role ----
function workload(staffId) {
  const { nowLocal } = require('./booking');
  const now = nowLocal();
  return {
    sessions: get('SELECT COUNT(*) AS n FROM events WHERE coach_id=? AND cancelled=0 AND starts_at>=?', staffId, now).n,
    classes: get('SELECT COUNT(*) AS n FROM classes WHERE coach_id=? AND archived=0', staffId).n,
    hours: get('SELECT COUNT(*) AS n FROM availability WHERE coach_id=?', staffId).n,
  };
}
function handOff(fromId, toId) {
  const { nowLocal } = require('./booking');
  const now = nowLocal();
  return tx(() => ({
    sessions: Number(run('UPDATE events SET coach_id=? WHERE coach_id=? AND cancelled=0 AND starts_at>=?', toId, fromId, now).changes),
    classes: Number(run('UPDATE classes SET coach_id=? WHERE coach_id=? AND archived=0', toId, fromId).changes),
    hours: Number(run('UPDATE availability SET coach_id=? WHERE coach_id=?', toId, fromId).changes),
  }));
}
const workText = (w) => [w.sessions && `${w.sessions} upcoming session${w.sessions === 1 ? '' : 's'}`, w.classes && `${w.classes} weekly class${w.classes === 1 ? '' : 'es'}`,
  w.hours && `${w.hours} block${w.hours === 1 ? '' : 's'} of private hours`].filter(Boolean).join(', ');

// ---- emailed reset links (self-service "forgot password") ----
function requestReset(req, email) {
  const s = get('SELECT * FROM staff WHERE email=?', String(email || '').trim());
  if (!s || !s.active) return false;
  const recent = get("SELECT COUNT(*) AS n FROM staff_resets WHERE staff_id=? AND created_at>datetime('now','-1 hour')", s.id).n;
  if (recent >= RESET_PER_HOUR) return false;
  const token = randomToken(32);
  insert('staff_resets', { staff_id: s.id, token_hash: sha256(token), expires_at: new Date(Date.now() + RESET_MIN * 6e4).toISOString(), ip: cleanIp(req.ip) });
  sendEmail(s.email, `Reset your ${businessName()} password`,
    `Hi ${s.name.split(' ')[0]},\n\nSomeone asked to reset the password for ${s.email}. Choose a new one here (the link works once, for ${RESET_MIN} minutes):\n\n${appUrl()}/?reset=${token}\n\nIf it wasn't you, ignore this email. Your password stays the same.`);
  return true;
}
function findReset(token) {
  if (!token) return null;
  const r = get('SELECT r.*, s.name, s.email, s.active FROM staff_resets r JOIN staff s ON s.id=r.staff_id WHERE r.token_hash=?', sha256(String(token)));
  if (!r || r.used_at || r.expires_at < new Date().toISOString() || !r.active) return null;
  return r;
}
function passwordChangedEmail(s, how) {
  sendEmail(s.email, `Your ${businessName()} password was changed`,
    `Hi ${s.name.split(' ')[0]},\n\nThe password for ${s.email} was changed ${how}. Other devices were signed out.\n\nIf this wasn't you, ask an owner to reset your password straight away.`);
}

// ---- security summary for the top of Staff & security ----
function summary(backups) {
  const staff = all('SELECT * FROM staff');
  const nowIso = new Date().toISOString();
  const last = backups[0] || null;
  const hoursSince = last ? (Date.now() - new Date(last.created_at).getTime()) / 36e5 : null;
  return {
    active: staff.filter((s) => s.active).length,
    off: staff.filter((s) => !s.active).length,
    locked: staff.filter((s) => s.active && s.locked_until && s.locked_until > nowIso).length,
    waiting: staff.filter((s) => s.active && s.must_change).length,
    failed_24h: get("SELECT COUNT(*) AS n FROM activity WHERE kind='signin' AND action LIKE 'Sign-in failed%' AND created_at>datetime('now','-1 day')").n,
    refused_7d: get("SELECT COUNT(*) AS n FROM activity WHERE kind='refused' AND created_at>datetime('now','-7 days')").n,
    last_backup_at: last ? last.created_at : null,
    backup_stale: hoursSince == null || hoursSince > 26,
  };
}

// ---- activity-log filters shared by the list and the CSV export ----
const WHO = {
  staff: "(actor LIKE '% (owner)' OR actor LIKE '% (coach)' OR actor LIKE '% (frontdesk)')",
  parent: "actor LIKE '% (parent)'", athlete: "actor LIKE '% (athlete)'", api: "actor LIKE 'API key %'", system: "(actor IS NULL OR actor='System')",
};
const toSqlTime = (v) => { const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' '); };
function activityWhere(q) {
  const conds = [], args = [];
  const kind = ['change', 'refused', 'signin'].includes(q.kind) ? q.kind : null;
  if (kind) { conds.push('kind=?'); args.push(kind); }
  if (WHO[q.who]) conds.push(WHO[q.who]);
  if (q.staff_id) {
    const s = get('SELECT name, email FROM staff WHERE id=?', Number(q.staff_id));
    // Their own actions (any role they've had), plus failed sign-ins typed with their email.
    if (s) { conds.push("(actor LIKE ? ESCAPE '\\' OR (kind='signin' AND detail=?))"); args.push(`${s.name.replace(/[\\%_]/g, '\\$&')} (%)`, s.email); }
    else conds.push('0');
  }
  const since = q.since ? toSqlTime(q.since) : null, until = q.until ? toSqlTime(q.until) : null;
  if (since) { conds.push('created_at>=?'); args.push(since); }
  if (until) { conds.push('created_at<?'); args.push(until); }
  const text = String(q.q || '').trim();
  if (text) { conds.push('(actor LIKE ? OR action LIKE ? OR detail LIKE ? OR ip LIKE ?)'); args.push(...Array(4).fill(`%${text}%`)); }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', args };
}

module.exports = {
  ROLE_LABEL, deviceLabel, noteSignIn, seen, sessions, endSessions, workload, handOff, workText,
  requestReset, findReset, passwordChangedEmail, summary, activityWhere, iso, cleanIp, RESET_MIN,
};
