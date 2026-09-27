// Staff & security: staff accounts and roles, password resets, unlocks, turning accounts off (with handing their
// sessions to another coach), devices, the security summary, the activity log (filters + CSV), database backups
// (daily job + back up now + download), your own account (devices) and emailed password-reset links.
'use strict';
const fs = require('fs');
const { get, all, run, insert, update, tx } = require('../db');
const { h, bad, notFound, log, HttpError } = require('../lib');
const { requireStaff, hashPassword, checkPassword, tempPassword, welcomeStaffEmail } = require('../auth');
const backup = require('../services/ops-backup');
const ops = require('../services/ops-staff');

const OWNER = requireStaff('owner');
const ANY = requireStaff();
const ROLES = ['owner', 'coach', 'frontdesk'];
const ROLE_LABEL = ops.ROLE_LABEL;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 80);

function staffOr404(id) {
  const s = get('SELECT * FROM staff WHERE id=?', Number(id));
  if (!s) throw notFound('That staff member');
  return s;
}
const otherActiveOwners = (id) => get("SELECT COUNT(*) AS n FROM staff WHERE role='owner' AND active=1 AND id<>?", id).n;
const activityRow = (a) => ({ ...a, created_at: ops.iso(a.created_at), ip: ops.cleanIp(a.ip) });

const lastSignIn = ops.lastSignIn;

function view(s) {
  const locked = !!(s.locked_until && s.locked_until > new Date().toISOString());
  return {
    id: s.id, name: s.name, email: s.email, role: s.role, active: !!s.active, must_change: !!s.must_change,
    locked, locked_until: locked ? s.locked_until : null, failed_count: s.failed_count, created_at: ops.iso(s.created_at),
    last_signed_in: lastSignIn(s), last_signin_ip: s.last_signin_ip || null,
    devices: get("SELECT COUNT(*) AS n FROM auth_sessions WHERE kind='staff' AND user_id=? AND expires_at>?", s.id, new Date().toISOString()).n,
    work: ops.workload(s.id),
  };
}

// hand_to: undefined = leave their sessions alone, '' / null = unassign, id = an active owner or coach.
function handTarget(b, s) {
  if (b.hand_to === undefined) return undefined;
  if (b.hand_to === '' || b.hand_to === null) return null;
  const t = get("SELECT * FROM staff WHERE id=? AND active=1 AND role IN ('owner','coach')", Number(b.hand_to));
  if (!t || t.id === s.id) throw bad('Choose an active coach or owner to take over their sessions.');
  return t;
}
function applyHandOff(req, s, target) {
  if (target === undefined) return;
  const text = ops.workText(ops.handOff(s.id, target ? target.id : null));
  if (text) log(req, target ? 'Handed over sessions' : 'Unassigned sessions', `${s.name} → ${target ? target.name : 'no coach'}: ${text}`);
}

function routes(api) {
  api.get('/staff', OWNER, (_req, res) => {
    res.json(all("SELECT * FROM staff ORDER BY active DESC, CASE role WHEN 'owner' THEN 0 WHEN 'coach' THEN 1 ELSE 2 END, name").map(view));
  });

  api.get('/staff/summary', OWNER, (_req, res) => res.json(ops.summary(backup.list())));

  api.post('/staff', OWNER, h(async (req, res) => {
    const name = cleanName(req.body.name);
    const email = String(req.body.email || '').trim().toLowerCase();
    const role = String(req.body.role || '');
    if (!name) throw bad('Enter their name.');
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
    if (!ROLES.includes(role)) throw bad('Choose a role: Owner, Coach or Front desk.');
    const existing = get('SELECT * FROM staff WHERE email=?', email);
    if (existing) throw bad(existing.active ? 'Someone on staff already uses that email.' : `${existing.name} used that email and is turned off. Turn their account back on instead.`);
    const pw = tempPassword();
    const id = insert('staff', { name, email, role, pw_hash: hashPassword(pw), must_change: 1, active: 1 });
    welcomeStaffEmail({ name, email, role }, pw);
    log(req, 'Added staff member', `${name} (${ROLE_LABEL[role]}), ${email}`);
    res.json(view(staffOr404(id)));
  }));

  // Edit name, email and/or role. Moving someone to front desk can hand their sessions to a coach (hand_to).
  api.put('/staff/:id', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    const b = req.body || {};
    const next = {}, edits = [];
    if ('name' in b) {
      const name = cleanName(b.name);
      if (!name) throw bad('Enter their name.');
      if (name !== s.name) { next.name = name; edits.push(`name ${s.name} → ${name}`); }
    }
    if ('email' in b) {
      const email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
      if (email !== s.email.toLowerCase()) {
        if (get('SELECT 1 FROM staff WHERE email=? AND id<>?', email, s.id)) throw bad('Someone on staff already uses that email.');
        next.email = email; edits.push(`email ${s.email} → ${email}`);
      }
    }
    if ('role' in b || !Object.keys(b).length) {
      const role = String(b.role || '');
      if (!ROLES.includes(role)) throw bad('Choose a role: Owner, Coach or Front desk.');
      if (role !== s.role) {
        if (s.role === 'owner' && s.active && !otherActiveOwners(s.id)) {
          log(req, 'Refused', `Change role of ${s.name}: last owner`, 'refused');
          throw bad(`${s.name} is the only owner. Make someone else an owner first.`);
        }
        next.role = role;
      }
    }
    if (!Object.keys(next).length) return res.json(view(s));
    const target = next.role === 'frontdesk' ? handTarget(b, s) : undefined;
    tx(() => {
      update('staff', s.id, next);
      if (next.email) ops.cancelResets(s.id); // a link sent to the old address stops working
      if (edits.length) log(req, 'Edited staff member', `${s.name}: ${edits.join(', ')}`);
      if (next.role) log(req, 'Changed role', `${next.name || s.name}: ${ROLE_LABEL[s.role]} → ${ROLE_LABEL[next.role]}`);
      applyHandOff(req, { ...s, ...next }, target);
    });
    res.json(view(staffOr404(s.id)));
  }));

  api.post('/staff/:id/reset-password', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    if (!s.active) throw bad(`${s.name}'s account is off. Turn it on first.`);
    const invite = s.must_change && !lastSignIn(s);
    const pw = tempPassword();
    update('staff', s.id, { pw_hash: hashPassword(pw), must_change: 1, failed_count: 0, locked_until: null });
    ops.endSessions(s.id);
    ops.cancelResets(s.id); // an owner reset overrides any emailed link still open
    welcomeStaffEmail(s, pw);
    log(req, invite ? 'Resent invite' : 'Reset password', `${s.name}: one-time password emailed to ${s.email}${invite ? '' : ', signed out everywhere'}`);
    res.json(view(staffOr404(s.id)));
  }));

  api.post('/staff/:id/unlock', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    update('staff', s.id, { failed_count: 0, locked_until: null });
    log(req, 'Unlocked account', s.name);
    res.json(view(staffOr404(s.id)));
  }));

  // Sign someone out of every device without changing their password (lost phone, shared computer).
  api.post('/staff/:id/sign-out', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    const self = s.id === req.staff.id;
    const n = ops.endSessions(s.id, self ? req.staffSession || null : null);
    log(req, 'Signed out everywhere', `${s.name}: ${n} device${n === 1 ? '' : 's'}${self ? ', kept this one' : ''}`);
    res.json({ ...view(staffOr404(s.id)), signed_out: n });
  }));

  api.post('/staff/:id/turn-off', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    if (s.id === req.staff.id) throw bad("You can't turn off your own account. Ask another owner.");
    if (s.role === 'owner' && s.active && !otherActiveOwners(s.id)) {
      log(req, 'Refused', `Turn off ${s.name}: last owner`, 'refused');
      throw bad(`${s.name} is the only owner. Make someone else an owner first.`);
    }
    const target = handTarget(req.body || {}, s);
    tx(() => {
      update('staff', s.id, { active: 0 });
      ops.endSessions(s.id);
      ops.cancelResets(s.id);
      log(req, 'Turned off account', `${s.name}: signed out everywhere`);
      applyHandOff(req, s, target);
    });
    res.json(view(staffOr404(s.id)));
  }));

  // Hand someone's upcoming sessions, weekly classes and private hours to another coach (or nobody) on their own,
  // e.g. for an account that was turned off before hand-overs existed.
  api.post('/staff/:id/hand-over', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    const target = handTarget(req.body || {}, s);
    if (target === undefined) throw bad('Choose who takes over their sessions.');
    applyHandOff(req, s, target);
    res.json(view(staffOr404(s.id)));
  }));

  api.post('/staff/:id/turn-on', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    update('staff', s.id, { active: 1, failed_count: 0, locked_until: null });
    log(req, 'Turned on account', s.name);
    res.json(view(staffOr404(s.id)));
  }));

  // ---- activity log ----
  api.get('/staff/activity', OWNER, (req, res) => {
    const per = Math.min(Math.max(Number(req.query.per) || 50, 10), 200);
    const page = Math.max(Math.floor(Number(req.query.page)) || 1, 1);
    const { where, args } = ops.activityWhere(req.query);
    const total = get(`SELECT COUNT(*) AS n FROM activity ${where}`, ...args).n;
    const items = all(`SELECT * FROM activity ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...args, per, (page - 1) * per).map(activityRow);
    res.json({ total, page, per, pages: Math.max(Math.ceil(total / per), 1), items });
  });

  api.get('/staff/activity.csv', OWNER, (req, res) => {
    const { where, args } = ops.activityWhere(req.query);
    const rows = all(`SELECT * FROM activity ${where} ORDER BY created_at DESC, id DESC LIMIT 20000`, ...args);
    // Quote every cell; prefix formula-looking text so spreadsheets don't run it.
    const cell = (v) => { let t = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
    const lines = [['When (UTC)', 'Who', 'What', 'Detail', 'From', 'Type'].map(cell).join(',')]
      .concat(rows.map((a) => [a.created_at, a.actor || 'System', a.action, a.detail, ops.cleanIp(a.ip), a.kind].map(cell).join(',')));
    log(req, 'Exported activity log', `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.send(lines.join('\r\n') + '\r\n');
  });

  // One person: devices, what they'd hand over, and their recent activity.
  api.get('/staff/:id', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    const { where, args } = ops.activityWhere({ staff_id: s.id });
    res.json({
      ...view(s),
      sessions: ops.sessions(s.id, req.staffSession),
      recent: all(`SELECT * FROM activity ${where} ORDER BY created_at DESC, id DESC LIMIT 8`, ...args).map(activityRow),
    });
  }));

  // ---- backups ----
  api.get('/backups', OWNER, (_req, res) => {
    const items = backup.list();
    res.json({ keep: backup.KEEP, items, total_size: items.reduce((n, b) => n + b.size, 0) });
  });
  api.post('/backups', OWNER, h(async (req, res) => {
    const b = backup.backupNow();
    log(req, 'Backed up database', `${b.name} (${Math.round(b.size / 1024)} KB)`);
    res.json(b);
  }));
  api.get('/backups/:name', OWNER, (req, res, next) => {
    const file = backup.resolve(req.params.name);
    if (!file) return next(new HttpError(404, "That backup wasn't found."));
    log(req, 'Downloaded backup', req.params.name);
    res.set({ 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="${req.params.name}"`, 'Cache-Control': 'no-store', 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).on('error', next).pipe(res);
  });

  // ---- your own account (any staff role) ----
  api.get('/account', ANY, (req, res) => {
    const s = staffOr404(req.staff.id);
    const { where, args } = ops.activityWhere({ staff_id: s.id, kind: 'signin' });
    res.json({
      id: s.id, name: s.name, email: s.email, role: s.role, created_at: ops.iso(s.created_at), last_signed_in: lastSignIn(s),
      sessions: ops.sessions(s.id, req.staffSession),
      signins: all(`SELECT * FROM activity ${where} ORDER BY created_at DESC, id DESC LIMIT 10`, ...args).map((a) => ({ action: a.action, created_at: ops.iso(a.created_at), ip: ops.cleanIp(a.ip) })),
    });
  });
  api.post('/account/sessions/:sid/sign-out', ANY, h(async (req, res) => {
    const row = get("SELECT rowid AS id, token_hash, user_agent FROM auth_sessions WHERE rowid=? AND kind='staff' AND user_id=?", Number(req.params.sid), req.staff.id);
    if (!row) throw notFound('That device');
    if (row.token_hash === req.staffSession) throw bad('That is this device. Use Sign out instead.');
    run('DELETE FROM auth_sessions WHERE rowid=?', row.id);
    log(req, 'Signed out a device', ops.deviceLabel(row.user_agent));
    res.json({ ok: true });
  }));
  api.post('/account/sign-out-others', ANY, h(async (req, res) => {
    const n = ops.endSessions(req.staff.id, req.staffSession || null);
    log(req, 'Signed out other devices', `${n} device${n === 1 ? '' : 's'}`);
    res.json({ ok: true, signed_out: n });
  }));

  // ---- forgot password: an emailed single-use link (no sign-in needed) ----
  const EXPIRED = 'That reset link has expired or was already used. Ask for a new one.';
  api.post('/staff-reset', h(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad('Enter the email you sign in with.');
    ops.requestReset(req, email);
    log(req, 'Asked for a password reset', email, 'signin');
    res.json({ ok: true, minutes: ops.RESET_MIN }); // same answer either way, so staff emails can't be probed
  }));
  api.get('/staff-reset/:token', (req, res, next) => {
    const r = ops.findReset(req.params.token);
    if (!r) return next(bad(EXPIRED));
    res.json({ ok: true, name: r.name.split(' ')[0], email: r.email });
  });
  api.post('/staff-reset/:token', h(async (req, res) => {
    const r = ops.findReset(req.params.token);
    if (!r) throw bad(EXPIRED);
    const pw = String(req.body?.password || '');
    if (pw.length < 10) throw bad('Use at least 10 characters.');
    const s = staffOr404(r.staff_id);
    if (checkPassword(pw, s.pw_hash)) throw bad("That's your current password. Choose a new one, or go back and sign in with it.");
    const now = new Date().toISOString();
    tx(() => {
      update('staff', s.id, { pw_hash: hashPassword(pw), must_change: 0, failed_count: 0, locked_until: null });
      ops.cancelResets(s.id, now); // every open link for them
      ops.endSessions(s.id);
    });
    ops.passwordChangedEmail(s, 'with an emailed reset link');
    log({ ip: req.ip, staff: { name: s.name, role: s.role } }, 'Reset own password', 'with an emailed link, signed out everywhere', 'signin');
    res.json({ ok: true, email: s.email });
  }));
}

module.exports = {
  routes,
  jobs: [{ name: 'daily-backup', everyMin: 60, run: () => backup.daily() }],
};
