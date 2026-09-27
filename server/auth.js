// Staff (email + password) and parent (emailed code) sign-in, sessions, roles and API keys.
'use strict';
const crypto = require('crypto');
const express = require('express');
const { get, run, insert, update } = require('./db');
const { randomToken, sha256, HttpError, bad, h, sendEmail, log, businessName, appUrl } = require('./lib');

const STAFF_COOKIE = 'dp_staff', PARENT_COOKIE = 'dp_parent';
const STAFF_DAYS = 14, PARENT_DAYS = 30;
const MAX_FAILS = 5, LOCK_MIN = 15;

// ---- passwords ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [, saltHex, keyHex] = stored.split('$');
  const key = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
function tempPassword() {
  const words = ['granite', 'carbon', 'quartz', 'forge', 'anvil', 'steel', 'summit', 'ridge', 'vault', 'onyx'];
  return words[crypto.randomInt(words.length)] + '-' + crypto.randomInt(1000, 9999) + '-' + words[crypto.randomInt(words.length)];
}

// ---- sessions ----
function startSession(res, kind, userId) {
  const token = randomToken(32);
  const days = kind === 'staff' ? STAFF_DAYS : PARENT_DAYS;
  const expires = new Date(Date.now() + days * 864e5);
  insert('auth_sessions', { token_hash: sha256(token), kind, user_id: userId, expires_at: expires.toISOString() });
  res.cookie(kind === 'staff' ? STAFF_COOKIE : PARENT_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', expires, path: '/',
  });
  return token;
}
function sessionUser(req, kind) {
  const token = req.cookies?.[kind === 'staff' ? STAFF_COOKIE : PARENT_COOKIE];
  if (!token) return null;
  const s = get('SELECT * FROM auth_sessions WHERE token_hash=? AND kind=?', sha256(token), kind);
  if (!s || s.expires_at < new Date().toISOString()) return null;
  return s.user_id;
}
function endSession(req, res, kind) {
  const name = kind === 'staff' ? STAFF_COOKIE : PARENT_COOKIE;
  const token = req.cookies?.[name];
  if (token) run('DELETE FROM auth_sessions WHERE token_hash=?', sha256(token));
  res.clearCookie(name, { path: '/' });
}

// ---- middleware ----
function loadUser(req, _res, next) {
  const sid = sessionUser(req, 'staff');
  if (sid) {
    const s = get('SELECT id,name,email,role,must_change,active FROM staff WHERE id=?', sid);
    if (s && s.active) { req.staff = s; require('./services/ops-staff').seen(req, req.cookies?.[STAFF_COOKIE]); }
  }
  const pid = sessionUser(req, 'parent');
  if (pid) {
    const p = get('SELECT * FROM parents WHERE id=?', pid);
    if (p) req.parent = p;
  }
  next();
}
// requireStaff() = any role; requireStaff('owner','coach') = only those roles.
function requireStaff(...roles) {
  return (req, _res, next) => {
    if (!req.staff) return next(new HttpError(401, 'Please sign in.'));
    if (req.staff.must_change && !req.originalUrl.startsWith('/api/auth/')) return next(new HttpError(403, 'Choose a new password first.', { must_change: true }));
    if (roles.length && !roles.includes(req.staff.role)) {
      log(req, 'Refused', `${req.method} ${req.originalUrl}`, 'refused');
      return next(new HttpError(403, "Your role can't do that. Ask an owner."));
    }
    next();
  };
}
function requireParent(req, _res, next) {
  if (!req.parent) return next(new HttpError(401, 'Please sign in.'));
  next();
}
function requireApiKey(req, _res, next) {
  const hdr = req.get('authorization') || '';
  const key = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : req.get('x-api-key');
  if (!key) return next(new HttpError(401, 'Missing API key. Send Authorization: Bearer <key>.'));
  const k = get('SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL', sha256(key));
  if (!k) return next(new HttpError(401, 'That API key is not valid or was revoked.'));
  run("UPDATE api_keys SET last_used=datetime('now') WHERE id=?", k.id);
  req.apiKey = k;
  // Every request with a key is logged for API & integrations; read-only keys can't send data.
  const apiOps = require('./services/ops-api');
  apiOps.track(req, _res, k);
  if (apiOps.scopeOf(k) === 'read' && !['GET', 'HEAD'].includes(req.method)) {
    return next(new HttpError(403, 'This API key is read-only. Create a key with "Read and send results" to send data.'));
  }
  next();
}

// ---- routes ----
const router = express.Router();

router.post('/staff/login', h(async (req, res) => {
  const email = String(req.body.email || '').trim();
  const s = get('SELECT * FROM staff WHERE email=?', email);
  const fail = (msg) => { log(req, 'Sign-in failed', email, 'signin'); throw new HttpError(401, msg); };
  if (!s || !s.active) fail('That email and password don\'t match.');
  if (s.locked_until && s.locked_until > new Date().toISOString()) {
    fail(`Too many wrong passwords. Try again after ${new Date(s.locked_until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}, or ask an owner to unlock you.`);
  }
  if (!checkPassword(req.body.password || '', s.pw_hash)) {
    const n = s.failed_count + 1;
    const lock = n >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 6e4).toISOString() : null;
    update('staff', s.id, { failed_count: lock ? 0 : n, locked_until: lock });
    fail(lock ? `Too many wrong passwords. Your account is locked for ${LOCK_MIN} minutes.` : 'That email and password don\'t match.');
  }
  update('staff', s.id, { failed_count: 0, locked_until: null });
  const token = startSession(res, 'staff', s.id);
  require('./services/ops-staff').noteSignIn(req, s.id, token);
  req.staff = s;
  log(req, 'Signed in', null, 'signin');
  res.json({ ok: true, must_change: !!s.must_change });
}));

router.post('/staff/logout', (req, res) => { endSession(req, res, 'staff'); res.json({ ok: true }); });

router.get('/staff/me', (req, res) => {
  if (!req.staff) return res.status(401).json({ error: 'Please sign in.' });
  res.json({ ...req.staff, business: businessName() });
});

router.post('/staff/password', requireStaff(), h(async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 10) throw bad('Use at least 10 characters.');
  // Changing a known password needs the current one (an unlocked screen isn't enough); choosing the first one doesn't.
  const row = get('SELECT pw_hash FROM staff WHERE id=?', req.staff.id);
  if (!req.staff.must_change && !checkPassword(req.body.current_password || '', row.pw_hash)) {
    log(req, 'Password change failed', 'current password did not match', 'refused');
    throw bad("Your current password doesn't match.");
  }
  if (checkPassword(pw, row.pw_hash)) throw bad(req.staff.must_change ? 'Choose a password different from your one-time password.' : "That's your current password. Choose a new one.");
  update('staff', req.staff.id, { pw_hash: hashPassword(pw), must_change: 0 });
  const ops = require('./services/ops-staff');
  const others = ops.endSessions(req.staff.id, req.staffSession || null);
  ops.cancelResets(req.staff.id); // a reset link asked for earlier can't undo the new password
  if (!req.staff.must_change) ops.passwordChangedEmail(req.staff, 'on the Account page');
  log(req, req.staff.must_change ? 'Chose a password' : 'Changed password', others ? `other devices signed out (${others})` : null);
  res.json({ ok: true });
}));

router.post('/parent/code', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter the email address your coach has on file.');
  codeLimit(req, email); // same limit for every address, so it can't tell which emails are on file
  const p = get('SELECT * FROM parents WHERE email=?', email);
  const out = { ok: true };
  run('UPDATE parent_codes SET used=1 WHERE email=?', email);
  if (!p) {
    // Not on file: keep a code nobody knows, so checking a code answers exactly as it would for a real account.
    insert('parent_codes', { email, code_hash: sha256(randomToken(24)), expires_at: new Date(Date.now() + 10 * 6e4).toISOString() });
  } else {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    insert('parent_codes', { email, code_hash: sha256(code), expires_at: new Date(Date.now() + 10 * 6e4).toISOString() });
    sendEmail(email, `Your ${businessName()} sign-in code: ${code}`, `Your sign-in code is ${code}. It works once, for 10 minutes.\n\nIf you didn't ask for it, you can ignore this email.`);
    // Test mode (or a restricted staging server): the email won't arrive, so show the code on screen.
    if (!require('./email').willDeliver(email)) out.test_code = code;
  }
  out.resend_in = RESEND_SEC;
  res.json(out); // same answer either way, so emails can't be probed
}));

router.post('/parent/verify', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').replace(/\D/g, '');
  const row = get("SELECT * FROM parent_codes WHERE email=? AND used=0 ORDER BY id DESC LIMIT 1", email);
  if (!row || row.expires_at < new Date().toISOString()) throw bad('That code has expired. Ask for a new one.');
  if (row.attempts >= 5) throw bad('Too many tries. Ask for a new code.');
  // Wrong codes across every code asked for in the last hour: stops guessing by asking for code after code.
  const since = new Date(Date.now() - 50 * 6e4).toISOString(); // codes last 10 minutes, so this is an hour of codes
  if ((get('SELECT COALESCE(SUM(attempts),0) n FROM parent_codes WHERE email=? AND expires_at>?', email, since)?.n || 0) >= MAX_WRONG_CODES) {
    throw new HttpError(429, 'Too many wrong codes. Try again in an hour, or ask the front desk for help.');
  }
  if (sha256(code) !== row.code_hash) {
    run('UPDATE parent_codes SET attempts=attempts+1 WHERE id=?', row.id);
    if (row.attempts + 1 >= 5) log(req, 'Sign-in failed', `${email}: too many wrong codes`, 'signin');
    throw bad("That code doesn't match. Check the latest email.");
  }
  run('UPDATE parent_codes SET used=1 WHERE id=?', row.id);
  const p = get('SELECT * FROM parents WHERE email=?', email);
  if (!p) throw bad('No account uses that email.');
  startSession(res, 'parent', p.id);
  req.parent = p;
  log(req, 'Signed in', 'Parent portal', 'signin');
  res.json({ ok: true });
}));

router.post('/parent/logout', (req, res) => { endSession(req, res, 'parent'); res.json({ ok: true }); });

// Whether this browser has a parent session. Answers 200 either way so opening the portal signed out logs no error.
router.get('/parent/session', (req, res) => { res.json({ signed_in: !!req.parent }); });

// ---- parent code limits: per email and per network address, kept in memory ----
const RESEND_SEC = 30, CODES_PER_EMAIL = 10, CODES_PER_IP = 60, MAX_WRONG_CODES = 15, LIMIT_WINDOW = 60 * 6e4;
const codeAsks = new Map(); // key -> [timestamps]
function codeLimit(req, email) {
  const now = Date.now();
  const recent = (key) => (codeAsks.get(key) || []).filter((t) => now - t < LIMIT_WINDOW);
  const byEmail = recent('e:' + email), byIp = recent('i:' + (req.ip || ''));
  if (byEmail.length >= CODES_PER_EMAIL || byIp.length >= CODES_PER_IP) {
    const oldest = Math.min(...(byEmail.length >= CODES_PER_EMAIL ? byEmail : byIp));
    const mins = Math.max(1, Math.ceil((oldest + LIMIT_WINDOW - now) / 6e4));
    throw new HttpError(429, `Too many codes asked for. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask the front desk for help.`, { retry_after: mins * 60 });
  }
  codeAsks.set('e:' + email, [...byEmail, now]);
  codeAsks.set('i:' + (req.ip || ''), [...byIp, now]);
  if (codeAsks.size > 5000) for (const [k, v] of codeAsks) if (!v.some((t) => now - t < LIMIT_WINDOW)) codeAsks.delete(k);
}

function welcomeStaffEmail(s, pw) {
  sendEmail(s.email, `Your ${businessName()} account`, `Hi ${s.name.split(' ')[0]},\n\nYou've been added as ${s.role === 'frontdesk' ? 'front desk' : s.role}.\n\nSign in at ${appUrl()}/ with:\nEmail: ${s.email}\nOne-time password: ${pw}\n\nYou'll choose your own password when you sign in.`);
}

module.exports = { router, loadUser, requireStaff, requireParent, requireApiKey, hashPassword, checkPassword, tempPassword, welcomeStaffEmail, endSession };
