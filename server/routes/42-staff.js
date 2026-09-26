// Staff & security: staff accounts and roles, password resets, unlocks, turning accounts off,
// the activity log, and database backups (daily job + back up now + download).
'use strict';
const fs = require('fs');
const { get, all, run, insert, update } = require('../db');
const { h, bad, notFound, log, HttpError } = require('../lib');
const { requireStaff, hashPassword, tempPassword, welcomeStaffEmail } = require('../auth');
const backup = require('../services/ops-backup');

const OWNER = requireStaff('owner');
const ROLES = ['owner', 'coach', 'frontdesk'];
const ROLE_LABEL = { owner: 'Owner', coach: 'Coach', frontdesk: 'Front desk' };

function staffOr404(id) {
  const s = get('SELECT * FROM staff WHERE id=?', Number(id));
  if (!s) throw notFound('That staff member');
  return s;
}
const otherActiveOwners = (id) => get("SELECT COUNT(*) AS n FROM staff WHERE role='owner' AND active=1 AND id<>?", id).n;
const signOutEverywhere = (id) => run("DELETE FROM auth_sessions WHERE kind='staff' AND user_id=?", id);

function view(s) {
  const lastSession = get("SELECT MAX(created_at) AS t FROM auth_sessions WHERE kind='staff' AND user_id=?", s.id).t;
  const lastLog = get("SELECT MAX(created_at) AS t FROM activity WHERE kind='signin' AND action='Signed in' AND actor=?", `${s.name} (${s.role})`).t;
  const last = [lastSession, lastLog].filter(Boolean).sort().pop() || null;
  const locked = !!(s.locked_until && s.locked_until > new Date().toISOString());
  return {
    id: s.id, name: s.name, email: s.email, role: s.role, active: !!s.active, must_change: !!s.must_change,
    locked, locked_until: locked ? s.locked_until : null, failed_count: s.failed_count, created_at: s.created_at,
    last_signed_in: last ? last.replace(' ', 'T') + (last.includes('T') ? '' : 'Z') : null,
  };
}

function routes(api) {
  api.get('/staff', OWNER, (_req, res) => {
    res.json(all("SELECT * FROM staff ORDER BY active DESC, CASE role WHEN 'owner' THEN 0 WHEN 'coach' THEN 1 ELSE 2 END, name").map(view));
  });

  api.post('/staff', OWNER, h(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const email = String(req.body.email || '').trim().toLowerCase();
    const role = String(req.body.role || '');
    if (!name) throw bad('Enter their name.');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter a valid email address.');
    if (!ROLES.includes(role)) throw bad('Choose a role: Owner, Coach or Front desk.');
    if (get('SELECT 1 FROM staff WHERE email=?', email)) throw bad('Someone on staff already uses that email.');
    const pw = tempPassword();
    const id = insert('staff', { name, email, role, pw_hash: hashPassword(pw), must_change: 1, active: 1 });
    welcomeStaffEmail({ name, email, role }, pw);
    log(req, 'Added staff member', `${name} (${ROLE_LABEL[role]}), ${email}`);
    res.json(view(staffOr404(id)));
  }));

  api.put('/staff/:id', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    const role = String(req.body.role || '');
    if (!ROLES.includes(role)) throw bad('Choose a role: Owner, Coach or Front desk.');
    if (role === s.role) return res.json(view(s));
    if (s.role === 'owner' && s.active && !otherActiveOwners(s.id)) {
      log(req, 'Refused', `Change role of ${s.name}: last owner`, 'refused');
      throw bad(`${s.name} is the only owner. Make someone else an owner first.`);
    }
    update('staff', s.id, { role });
    log(req, 'Changed role', `${s.name}: ${ROLE_LABEL[s.role]} → ${ROLE_LABEL[role]}`);
    res.json(view(staffOr404(s.id)));
  }));

  api.post('/staff/:id/reset-password', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    if (!s.active) throw bad(`${s.name}'s account is off. Turn it on first.`);
    const pw = tempPassword();
    update('staff', s.id, { pw_hash: hashPassword(pw), must_change: 1, failed_count: 0, locked_until: null });
    signOutEverywhere(s.id);
    welcomeStaffEmail(s, pw);
    log(req, 'Reset password', `${s.name}: one-time password emailed to ${s.email}, signed out everywhere`);
    res.json(view(staffOr404(s.id)));
  }));

  api.post('/staff/:id/unlock', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    update('staff', s.id, { failed_count: 0, locked_until: null });
    log(req, 'Unlocked account', s.name);
    res.json(view(staffOr404(s.id)));
  }));

  api.post('/staff/:id/turn-off', OWNER, h(async (req, res) => {
    const s = staffOr404(req.params.id);
    if (s.id === req.staff.id) throw bad("You can't turn off your own account. Ask another owner.");
    if (s.role === 'owner' && s.active && !otherActiveOwners(s.id)) {
      log(req, 'Refused', `Turn off ${s.name}: last owner`, 'refused');
      throw bad(`${s.name} is the only owner. Make someone else an owner first.`);
    }
    update('staff', s.id, { active: 0 });
    signOutEverywhere(s.id);
    log(req, 'Turned off account', `${s.name}: signed out everywhere`);
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
    const page = Math.max(Number(req.query.page) || 1, 1);
    const kind = ['change', 'refused', 'signin'].includes(req.query.kind) ? req.query.kind : null;
    const q = String(req.query.q || '').trim();
    const conds = [], args = [];
    if (kind) { conds.push('kind=?'); args.push(kind); }
    if (q) { conds.push("(actor LIKE ? OR action LIKE ? OR detail LIKE ? OR ip LIKE ?)"); args.push(...Array(4).fill(`%${q}%`)); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = get(`SELECT COUNT(*) AS n FROM activity ${where}`, ...args).n;
    const items = all(`SELECT * FROM activity ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, per, (page - 1) * per);
    res.json({ total, page, per, pages: Math.max(Math.ceil(total / per), 1), items });
  });

  // ---- backups ----
  api.get('/backups', OWNER, (_req, res) => res.json({ keep: backup.KEEP, items: backup.list() }));
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
}

module.exports = {
  routes,
  jobs: [{ name: 'daily-backup', everyMin: 60, run: () => backup.daily() }],
};
