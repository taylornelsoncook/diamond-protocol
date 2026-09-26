// API & integrations: API keys, webhooks and deliveries, the email outbox, and the open API's read endpoints (/api/v1/*).
'use strict';
const email = require('../email');
const crypto = require('crypto');
const { get, all, run, insert, update } = require('../db');
const { h, bad, notFound, log, sha256, WEBHOOK_EVENTS, addDays, businessName, appUrl } = require('../lib');
const { requireStaff, requireApiKey } = require('../auth');
const hooks = require('../services/ops-webhooks');
const { nowLocal } = require('../services/booking');

const OWNER = requireStaff('owner');

const hookView = (w) => ({
  id: w.id, url: w.url, events: JSON.parse(w.events || '[]'), active: !!w.active, created_at: w.created_at,
  secret_hint: w.secret ? w.secret.slice(0, 10) + '…' + w.secret.slice(-4) : null,
  deliveries: all('SELECT id, event, status, error, created_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 8', w.id),
  delivered: get('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id=?', w.id).n,
});

function cleanUrl(v) {
  const s = String(v || '').trim();
  let u;
  try { u = new URL(s); } catch { throw bad('Enter the full URL, starting with https://'); }
  if (!/^https?:$/.test(u.protocol)) throw bad('Webhook URLs must start with https:// (or http:// for testing).');
  if (s.length > 500) throw bad('That URL is too long.');
  return s;
}
function cleanEvents(list) {
  const ev = (Array.isArray(list) ? list : [list]).filter((e) => WEBHOOK_EVENTS.includes(e));
  if (!ev.length) throw bad('Choose at least one event to send.');
  return [...new Set(ev)];
}
const dateOnly = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : fallback);

function routes(api) {
  api.get('/integrations', OWNER, (_req, res) => {
    res.json({
      events: WEBHOOK_EVENTS,
      keys: all('SELECT id, label, last4, created_at, last_used, revoked_at FROM api_keys ORDER BY revoked_at IS NOT NULL, id DESC'),
      webhooks: all('SELECT * FROM webhooks ORDER BY id DESC').map(hookView),
    });
  });

  // ---- API keys: the full key is shown once; we keep only its SHA-256 and last four characters ----
  api.post('/api-keys', OWNER, h(async (req, res) => {
    const label = String(req.body.label || '').trim().slice(0, 60);
    if (!label) throw bad('Give the key a label, like the system that will use it.');
    const key = 'dp_live_' + crypto.randomBytes(24).toString('base64url');
    const id = insert('api_keys', { label, key_hash: sha256(key), last4: key.slice(-4) });
    log(req, 'Created API key', `${label} (…${key.slice(-4)})`);
    res.json({ id, label, key, last4: key.slice(-4) });
  }));
  api.delete('/api-keys/:id', OWNER, h(async (req, res) => {
    const k = get('SELECT * FROM api_keys WHERE id=?', Number(req.params.id));
    if (!k) throw notFound('That API key');
    if (!k.revoked_at) run("UPDATE api_keys SET revoked_at=datetime('now') WHERE id=?", k.id);
    log(req, 'Revoked API key', `${k.label} (…${k.last4})`);
    res.json({ ok: true });
  }));

  // ---- webhooks ----
  api.post('/webhooks', OWNER, h(async (req, res) => {
    const url = cleanUrl(req.body.url);
    const events = cleanEvents(req.body.events);
    const secret = hooks.newSecret();
    const id = insert('webhooks', { url, events: JSON.stringify(events), secret, active: 1 });
    log(req, 'Added webhook', `${url} (${events.length} event${events.length === 1 ? '' : 's'})`);
    res.json({ id, secret, ...hookView(get('SELECT * FROM webhooks WHERE id=?', id)) });
  }));
  api.put('/webhooks/:id', OWNER, h(async (req, res) => {
    const w = get('SELECT * FROM webhooks WHERE id=?', Number(req.params.id));
    if (!w) throw notFound('That webhook');
    const patch = {};
    if (req.body.active !== undefined) patch.active = req.body.active ? 1 : 0;
    if (req.body.events !== undefined) patch.events = JSON.stringify(cleanEvents(req.body.events));
    if (req.body.url !== undefined) patch.url = cleanUrl(req.body.url);
    update('webhooks', w.id, patch);
    log(req, patch.active === 0 ? 'Paused webhook' : patch.active === 1 ? 'Resumed webhook' : 'Updated webhook', patch.url || w.url);
    res.json(hookView(get('SELECT * FROM webhooks WHERE id=?', w.id)));
  }));
  api.delete('/webhooks/:id', OWNER, h(async (req, res) => {
    const w = get('SELECT * FROM webhooks WHERE id=?', Number(req.params.id));
    if (!w) throw notFound('That webhook');
    run('DELETE FROM webhook_deliveries WHERE webhook_id=?', w.id);
    run('DELETE FROM webhooks WHERE id=?', w.id);
    log(req, 'Deleted webhook', w.url);
    res.json({ ok: true });
  }));
  api.post('/webhooks/:id/test', OWNER, h(async (req, res) => {
    const w = get('SELECT * FROM webhooks WHERE id=?', Number(req.params.id));
    if (!w) throw notFound('That webhook');
    const d = hooks.deliver(w, 'test.ping', { message: 'Test event from Diamond Protocol. If you can read this, your endpoint works.' });
    const status = await d.done;
    log(req, 'Sent test webhook', `${w.url} → ${status || 'no response'}`);
    res.json({ ok: status >= 200 && status < 300, status, delivery: get('SELECT id, event, status, error, created_at FROM webhook_deliveries WHERE id=?', d.id) });
  }));
  api.get('/webhooks/:id/deliveries', OWNER, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(all('SELECT * FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT ?', Number(req.params.id), limit));
  });

  // ---- email outbox ----
  api.get('/outbox', OWNER, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const q = String(req.query.q || '').trim();
    const where = q ? 'WHERE to_email LIKE ? OR subject LIKE ?' : '';
    const args = q ? [`%${q}%`, `%${q}%`] : [];
    res.json({
      total: get(`SELECT COUNT(*) AS n FROM outbox ${where}`, ...args).n,
      items: all(`SELECT * FROM outbox ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, limit, offset),
      mode: email.mode(), provider: email.provider(), from: process.env.DP_EMAIL_FROM || null, only_to: process.env.DP_EMAIL_ONLY_TO || null,
    });
  });

  // Send a test email and wait for the provider's answer.
  api.post('/outbox/test', OWNER, h(async (req, res) => {
    const to = String(req.body.to || req.staff.email).trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) throw bad('Enter an email address.');
    const r = await email.sendEmailNow(to, `Test email from ${businessName()}`, `This is a test from your Diamond Protocol server at ${appUrl()}.\n\nIf you're reading this, email is working: sign-in codes, invoices and receipts will arrive like this one.`);
    log(req, 'Sent a test email', `${to}: ${r.ok ? 'delivered to the provider' : r.error}`);
    if (!r.ok) throw bad(r.error);
    res.json({ ok: true });
  }));

  // ---- open API (Authorization: Bearer dp_live_…) ----
  const athleteSql = `SELECT a.code, a.first_name, a.last_name, a.sport, a.position, a.school, a.birthday, a.created_at,
      t.id AS team_id, t.team_name, s.name AS school_name, p.id AS program_id, p.name AS program_name, a.program_started
    FROM athletes a LEFT JOIN team_contracts t ON t.id=a.team_id LEFT JOIN schools s ON s.id=t.school_id LEFT JOIN programs p ON p.id=a.program_id`;
  const v1Athlete = (r, full = false) => ({
    code: r.code, first_name: r.first_name, last_name: r.last_name, sport: r.sport || null,
    team: r.team_id ? { id: r.team_id, name: r.team_name, school: r.school_name } : null,
    ...(full ? { position: r.position || null, school: r.school || null, birth_year: r.birthday ? Number(r.birthday.slice(0, 4)) : null,
      program: r.program_id ? { id: r.program_id, name: r.program_name, started: r.program_started } : null, created_at: r.created_at } : {}),
  });

  api.get('/v1/athletes', requireApiKey, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const q = String(req.query.q || '').trim();
    const where = `WHERE a.archived=0${q ? " AND (a.first_name || ' ' || a.last_name LIKE ? OR a.code LIKE ?)" : ''}`;
    const args = q ? [`%${q}%`, `%${q}%`] : [];
    const total = get(`SELECT COUNT(*) AS n FROM athletes a ${where}`, ...args).n;
    const rows = all(`${athleteSql} ${where} ORDER BY a.last_name, a.first_name LIMIT ? OFFSET ?`, ...args, limit, offset);
    res.json({ data: rows.map((r) => v1Athlete(r)), total, limit, offset });
  });
  api.get('/v1/athletes/:code', requireApiKey, (req, res) => {
    const r = get(`${athleteSql} WHERE a.archived=0 AND a.code=?`, String(req.params.code).toUpperCase());
    if (!r) throw notFound('That athlete');
    res.json({ data: v1Athlete(r, true) });
  });
  api.get('/v1/programs', requireApiKey, (_req, res) => {
    res.json({ data: all(`SELECT p.id, p.name, p.weeks, p.level, p.description,
      (SELECT COUNT(*) FROM program_days d WHERE d.program_id=p.id) AS workouts
      FROM programs p WHERE p.archived=0 ORDER BY p.name`) });
  });
  api.get('/v1/events', requireApiKey, (req, res) => {
    const today = nowLocal().slice(0, 10);
    const from = dateOnly(req.query.from, today);
    const to = dateOnly(req.query.to, addDays(from, 14));
    if (to < from) throw bad('"to" must be on or after "from".');
    if (addDays(from, 92) < to) throw bad('Ask for 92 days or fewer at a time.');
    const rows = all(`SELECT e.id, e.name, e.type, e.starts_at, e.duration_min, e.capacity, e.cancelled,
        l.name AS location, st.name AS coach,
        (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='booked') AS booked,
        (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='waitlist') AS waitlisted
      FROM events e LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN staff st ON st.id=e.coach_id
      WHERE e.starts_at >= ? AND e.starts_at < ? ORDER BY e.starts_at, e.id`, from, addDays(to, 1));
    res.json({ from, to, data: rows.map((e) => ({ ...e, cancelled: !!e.cancelled, spots_left: e.capacity == null ? null : Math.max(e.capacity - e.booked, 0) })) });
  });
}

module.exports = { routes };
