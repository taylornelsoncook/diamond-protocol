// API & integrations: API keys (access levels, request log), webhooks (deliveries, resend, retries, rotation),
// the email outbox (filters, send again), exercise video coverage, and the open API's read endpoints (/api/v1/*).
'use strict';
const email = require('../email');
const crypto = require('crypto');
const { get, all, run, insert, update, setting } = require('../db');
const { h, bad, notFound, log, sha256, WEBHOOK_EVENTS, addDays, businessName, appUrl } = require('../lib');
const { requireStaff, requireApiKey } = require('../auth');
const hooks = require('../services/ops-webhooks');
const apiOps = require('../services/ops-api');
const { parseVideo } = require('../services/ops-video');
const { nowLocal } = require('../services/booking');

const OWNER = requireStaff('owner');
const DELIVERY_COLS = 'id, webhook_id, event, status, error, attempts, duration_ms, last_attempt_at, created_at';
const MAIL_STATUSES = ['sent', 'queued', 'failed', 'held', 'logged'];

const hookView = (w) => ({
  id: w.id, url: w.url, label: w.label || null, events: JSON.parse(w.events || '[]'), active: !!w.active, created_at: w.created_at,
  secret_hint: w.secret ? w.secret.slice(0, 10) + '…' + w.secret.slice(-4) : null,
  deliveries: all(`SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 8`, w.id),
  delivered: get('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id=?', w.id).n,
  health: hooks.health(w.id),
});

function cleanUrl(v) {
  const s = String(v || '').trim();
  if (!s) throw bad('Enter the URL to send events to, starting with https://');
  if (s.length > 500) throw bad('That URL is too long.');
  let u;
  try { u = new URL(s); } catch { throw bad('Enter the full URL, starting with https://'); }
  if (!/^https?:$/.test(u.protocol)) throw bad('Webhook URLs must start with https:// (or http:// for testing).');
  return s;
}
function cleanEvents(list) {
  const ev = (Array.isArray(list) ? list : [list]).filter((e) => WEBHOOK_EVENTS.includes(e));
  if (!ev.length) throw bad('Choose at least one event to send.');
  return [...new Set(ev)];
}
const cleanLabel = (v, max = 60) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
function cleanScope(v, { required = false } = {}) {
  if (!required && (v === undefined || v === null || v === '')) return 'full';
  if (!Object.hasOwn(apiOps.SCOPES, v)) throw bad('Choose what the key can do: read only, or read and send results.');
  return v;
}
// The same address counts as a duplicate whatever the host's case or a trailing slash.
function urlKey(s) {
  try { const u = new URL(s); return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`; } catch { return String(s); }
}
function dupUrl(url, exceptId = 0) {
  const key = urlKey(url);
  if (all('SELECT url FROM webhooks WHERE id<>?', exceptId).some((w) => urlKey(w.url) === key)) throw bad('A webhook already sends to that URL. Edit that one instead.');
}
const dateOnly = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : fallback);
const intIn = (v, dflt, min, max) => { const n = Number(v); return Math.min(Math.max(v !== '' && v != null && Number.isFinite(n) ? Math.trunc(n) : dflt, min), max); };
const hookOr404 = (id) => { const w = get('SELECT * FROM webhooks WHERE id=?', Number(id)); if (!w) throw notFound('That webhook'); return w; };
const keyOr404 = (id) => { const k = get('SELECT * FROM api_keys WHERE id=?', Number(id)); if (!k) throw notFound('That API key'); return k; };
const hookName = (w) => w.label || w.url;

// Start of a local day in the business time zone, as a UTC SQLite timestamp ("2026-09-01" → "2026-09-01 06:00:00" in Denver).
// Results store recorded_at in UTC, so "since" a date means since local midnight, not UTC midnight.
function localMidnightUtc(date) {
  let tz = setting('timezone', 'America/Denver');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = 'America/Denver'; }
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const target = Date.parse(`${date}T00:00:00Z`);
  let t = target;
  for (let i = 0; i < 3; i++) { // the zone's offset at that moment; twice more covers a DST change near midnight
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    t += target - wall;
  }
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

// Exercise demo videos: how much of the library can play in the workout app, and what needs a link.
function videoCoverage() {
  const rows = all(`SELECT e.id, e.name, e.category, e.video_url,
      (SELECT COUNT(*) FROM program_items i JOIN program_days d ON d.id=i.day_id JOIN programs p ON p.id=d.program_id WHERE i.exercise_id=e.id AND p.archived=0) AS uses
    FROM exercises e ORDER BY e.name COLLATE NOCASE`);
  const by_kind = { youtube: 0, vimeo: 0, file: 0 };
  const attention = [];
  for (const r of rows) {
    const v = parseVideo(r.video_url);
    if (v) by_kind[v.kind]++;
    else attention.push({ id: r.id, name: r.name, category: r.category || null, uses: r.uses, video_url: r.video_url || null, problem: r.video_url ? 'unplayable' : 'missing' });
  }
  attention.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  const withVideo = by_kind.youtube + by_kind.vimeo + by_kind.file;
  return { total: rows.length, with_video: withVideo, by_kind, in_use_missing: attention.filter((a) => a.uses > 0).length, attention };
}

function keyView(k, usage) {
  const u = usage[k.id] || { requests: 0, errors: 0 };
  return { id: k.id, label: k.label, last4: k.last4, scope: apiOps.scopeOf(k), created_at: k.created_at, last_used: k.last_used, revoked_at: k.revoked_at,
    requests_30d: u.requests, errors_30d: u.errors };
}

function mailCounts() {
  const counts = Object.fromEntries(MAIL_STATUSES.map((s) => [s, 0]));
  for (const r of all('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status')) counts[r.status || 'logged'] = (counts[r.status || 'logged'] || 0) + r.n;
  return counts;
}

function routes(api) {
  api.get('/integrations', OWNER, (_req, res) => {
    const usage = apiOps.usage();
    res.json({
      events: WEBHOOK_EVENTS,
      event_info: Object.fromEntries(WEBHOOK_EVENTS.map((e) => [e, hooks.EVENT_INFO[e]?.about || ''])),
      scopes: apiOps.SCOPES,
      keys: all('SELECT * FROM api_keys ORDER BY revoked_at IS NOT NULL, id DESC').map((k) => keyView(k, usage)),
      webhooks: all('SELECT * FROM webhooks ORDER BY id DESC').map(hookView),
      email: { mode: email.mode(), provider: email.provider(), counts: mailCounts(),
        failed_7d: get("SELECT COUNT(*) AS n FROM outbox WHERE status='failed' AND created_at >= datetime('now','-7 days')").n },
      video: videoCoverage(),
      retry_after_min: hooks.RETRY_AFTER_MIN,
    });
  });

  // ---- API keys: the full key is shown once; we keep only its SHA-256 and last four characters ----
  api.post('/api-keys', OWNER, h(async (req, res) => {
    const label = cleanLabel(req.body.label);
    if (!label) throw bad('Give the key a label, like the system that will use it.');
    const scope = cleanScope(req.body.scope);
    const key = 'dp_live_' + crypto.randomBytes(24).toString('base64url');
    const id = insert('api_keys', { label, key_hash: sha256(key), last4: key.slice(-4), scope });
    log(req, 'Created API key', `${label} (…${key.slice(-4)}, ${apiOps.SCOPES[scope].toLowerCase()})`);
    res.json({ id, label, key, last4: key.slice(-4), scope });
  }));
  api.put('/api-keys/:id', OWNER, h(async (req, res) => {
    const k = keyOr404(req.params.id);
    const patch = {};
    if (req.body.label !== undefined) {
      patch.label = cleanLabel(req.body.label);
      if (!patch.label) throw bad('Give the key a label, like the system that will use it.');
    }
    if (req.body.scope !== undefined) {
      if (k.revoked_at) throw bad('That key is revoked. Create a new key instead.');
      patch.scope = cleanScope(req.body.scope, { required: true }); // never widen a key by sending an empty value
    }
    if (!Object.keys(patch).length) throw bad('Nothing to change.');
    update('api_keys', k.id, patch);
    const changes = [patch.label && patch.label !== k.label ? `renamed to ${patch.label}` : '', patch.scope && patch.scope !== apiOps.scopeOf(k) ? apiOps.SCOPES[patch.scope].toLowerCase() : ''].filter(Boolean);
    if (changes.length) log(req, 'Updated API key', `${k.label} (…${k.last4}): ${changes.join(', ')}`);
    res.json(keyView(get('SELECT * FROM api_keys WHERE id=?', k.id), apiOps.usage()));
  }));
  api.delete('/api-keys/:id', OWNER, h(async (req, res) => {
    const k = keyOr404(req.params.id);
    if (!k.revoked_at) {
      run("UPDATE api_keys SET revoked_at=datetime('now') WHERE id=?", k.id);
      log(req, 'Revoked API key', `${k.label} (…${k.last4})`);
    }
    res.json({ ok: true });
  }));
  api.get('/api-keys/:id/requests', OWNER, (req, res) => {
    const k = keyOr404(req.params.id);
    const u = apiOps.usage()[k.id] || { requests: 0, errors: 0 };
    res.json({ key: { id: k.id, label: k.label, last4: k.last4 }, requests_30d: u.requests, errors_30d: u.errors, items: apiOps.recent(k.id, intIn(req.query.limit, 50, 1, 200)) });
  });

  // ---- webhooks ----
  api.post('/webhooks', OWNER, h(async (req, res) => {
    const url = cleanUrl(req.body.url);
    const events = cleanEvents(req.body.events);
    dupUrl(url);
    const label = cleanLabel(req.body.label) || null;
    const secret = hooks.newSecret();
    const id = insert('webhooks', { url, label, events: JSON.stringify(events), secret, active: 1 });
    log(req, 'Added webhook', `${label ? label + ': ' : ''}${url} (${events.length} event${events.length === 1 ? '' : 's'})`);
    res.json({ id, secret, ...hookView(get('SELECT * FROM webhooks WHERE id=?', id)) });
  }));
  api.put('/webhooks/:id', OWNER, h(async (req, res) => {
    const w = hookOr404(req.params.id);
    const patch = {};
    if (req.body.active !== undefined) patch.active = req.body.active ? 1 : 0;
    if (req.body.events !== undefined) patch.events = JSON.stringify(cleanEvents(req.body.events));
    if (req.body.url !== undefined) { patch.url = cleanUrl(req.body.url); dupUrl(patch.url, w.id); }
    if (req.body.label !== undefined) patch.label = cleanLabel(req.body.label) || null;
    if (!Object.keys(patch).length) throw bad('Nothing to change.');
    update('webhooks', w.id, patch);
    const onlyActive = Object.keys(patch).length === 1 && 'active' in patch;
    log(req, onlyActive ? (patch.active ? 'Resumed webhook' : 'Paused webhook') : 'Updated webhook', patch.label || w.label || patch.url || w.url);
    res.json(hookView(get('SELECT * FROM webhooks WHERE id=?', w.id)));
  }));
  api.delete('/webhooks/:id', OWNER, h(async (req, res) => {
    const w = hookOr404(req.params.id);
    run('DELETE FROM webhook_deliveries WHERE webhook_id=?', w.id);
    run('DELETE FROM webhooks WHERE id=?', w.id);
    log(req, 'Deleted webhook', hookName(w));
    res.json({ ok: true });
  }));
  // A test event: test.ping, or a sample of any event (marked "test": true) so a receiving system can be built against it.
  api.post('/webhooks/:id/test', OWNER, h(async (req, res) => {
    const w = hookOr404(req.params.id);
    const event = String(req.body?.event || 'test.ping');
    if (event !== 'test.ping' && !WEBHOOK_EVENTS.includes(event)) throw bad('Choose an event to send as a test.');
    const data = event === 'test.ping'
      ? { message: 'Test event from Diamond Protocol. If you can read this, your endpoint works.' }
      : { ...hooks.EVENT_INFO[event].sample, test: true };
    const d = hooks.deliver(w, event, data);
    const status = await d.done;
    log(req, 'Sent test webhook', `${hookName(w)}: ${event} → ${status || 'no response'}`);
    res.json({ ok: hooks.isOk(status), status, delivery: get(`SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE id=?`, d.id) });
  }));
  // New signing secret, shown once. The old one stops being used straight away.
  api.post('/webhooks/:id/rotate', OWNER, h(async (req, res) => {
    const w = hookOr404(req.params.id);
    const secret = hooks.newSecret();
    update('webhooks', w.id, { secret });
    log(req, 'Rotated webhook signing secret', hookName(w));
    res.json({ id: w.id, secret, secret_hint: secret.slice(0, 10) + '…' + secret.slice(-4) });
  }));
  api.get('/webhooks/:id/deliveries', OWNER, (req, res) => {
    const w = hookOr404(req.params.id);
    const limit = intIn(req.query.limit, 50, 1, 200);
    const offset = intIn(req.query.offset, 0, 0, 1e9);
    const where = ['webhook_id=?'];
    const args = [w.id];
    if (req.query.status === 'failed') where.push('status IS NOT NULL AND (status<200 OR status>=300)');
    else if (req.query.status === 'ok') where.push('status>=200 AND status<300');
    if (req.query.event) { where.push('event=?'); args.push(String(req.query.event)); }
    const sql = `FROM webhook_deliveries WHERE ${where.join(' AND ')}`;
    res.json({
      total: get(`SELECT COUNT(*) AS n ${sql}`, ...args).n,
      items: all(`SELECT ${DELIVERY_COLS} ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, limit, offset),
      health: hooks.health(w.id),
    });
  });
  api.get('/webhooks/:id/deliveries/:did', OWNER, (req, res) => {
    const w = hookOr404(req.params.id);
    const d = get('SELECT * FROM webhook_deliveries WHERE id=? AND webhook_id=?', Number(req.params.did), w.id);
    if (!d) throw notFound('That delivery');
    res.json({ ...d, url: w.url, max_attempts: hooks.MAX_ATTEMPTS });
  });
  api.post('/webhooks/:id/deliveries/:did/resend', OWNER, h(async (req, res) => {
    const w = hookOr404(req.params.id);
    const d = get('SELECT * FROM webhook_deliveries WHERE id=? AND webhook_id=?', Number(req.params.did), w.id);
    if (!d) throw notFound('That delivery');
    if (d.status == null && !hooks.isStuck(d)) throw bad('That delivery is still being sent. Try again in a few seconds.');
    const status = await hooks.redeliver(d);
    log(req, 'Resent webhook delivery', `${hookName(w)}: ${d.event} #${d.id} → ${status || 'no response'}`);
    res.json({ ok: hooks.isOk(status), status, delivery: get(`SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE id=?`, d.id) });
  }));
  // Resend everything that failed in the last 7 days (after fixing the receiving end).
  api.post('/webhooks/:id/resend-failed', OWNER, h(async (req, res) => {
    const w = hookOr404(req.params.id);
    const list = all(`SELECT * FROM webhook_deliveries WHERE webhook_id=? AND status IS NOT NULL AND (status<200 OR status>=300)
      AND created_at >= datetime('now','-7 days') ORDER BY id LIMIT 50`, w.id);
    if (!list.length) throw bad('Nothing to resend. No failed deliveries in the last 7 days.');
    const statuses = await Promise.all(list.map((d) => hooks.redeliver(d)));
    const ok = statuses.filter(hooks.isOk).length;
    log(req, 'Resent failed webhook deliveries', `${hookName(w)}: ${ok} of ${list.length} accepted`);
    res.json({ tried: list.length, ok, failed: list.length - ok });
  }));

  // ---- email outbox ----
  api.get('/outbox', OWNER, (req, res) => {
    const limit = intIn(req.query.limit, 50, 1, 200);
    const offset = intIn(req.query.offset, 0, 0, 1e9);
    const q = String(req.query.q || '').trim();
    const status = MAIL_STATUSES.includes(req.query.status) ? req.query.status : null;
    const where = [];
    const args = [];
    if (q) { where.push('(to_email LIKE ? OR subject LIKE ? OR body LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('status=?'); args.push(status); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    res.json({
      total: get(`SELECT COUNT(*) AS n FROM outbox ${w}`, ...args).n,
      items: all(`SELECT * FROM outbox ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, limit, offset),
      counts: mailCounts(),
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

  // Send an outbox email again, as a new message (to the same address, or a corrected one).
  api.post('/outbox/:id/resend', OWNER, h(async (req, res) => {
    const m = get('SELECT * FROM outbox WHERE id=?', Number(req.params.id));
    if (!m) throw notFound('That email');
    const to = String(req.body?.to || m.to_email).trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) throw bad('Enter an email address.');
    const r = await email.sendEmailNow(to, m.subject, m.body);
    log(req, r.ok ? 'Sent an email again' : 'Email could not be sent again', `${m.subject} → ${to}${r.ok ? '' : `: ${r.error}`}`);
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
  // One athlete's test results, newest first; "best" marks each test's best result among those returned.
  api.get('/v1/athletes/:code/results', requireApiKey, (req, res) => {
    const a = get('SELECT id, code FROM athletes WHERE archived=0 AND code=?', String(req.params.code).toUpperCase());
    if (!a) throw notFound('That athlete');
    const limit = intIn(req.query.limit, 200, 1, 1000);
    const where = ['r.athlete_id=?'];
    const args = [a.id];
    if (req.query.test) {
      const t = get('SELECT id FROM tests WHERE name=? COLLATE NOCASE', String(req.query.test).trim());
      if (!t) throw bad(`"${String(req.query.test).slice(0, 60)}" doesn't match a test in the library. GET /api/v1/tests lists them.`);
      where.push('r.test_id=?'); args.push(t.id);
    }
    if (req.query.since) {
      const since = dateOnly(req.query.since, null);
      if (!since) throw bad('"since" must be a date like 2026-09-01.');
      where.push('r.recorded_at >= ?'); args.push(localMidnightUtc(since));
    }
    const rows = all(`SELECT r.id, t.name AS test, t.category, t.unit, t.lower_better, r.value, r.attempt, r.source, r.hand_timed, r.recorded_at, r.day_id, d.name AS testing_day
      FROM results r JOIN tests t ON t.id=r.test_id LEFT JOIN testing_days d ON d.id=r.day_id
      WHERE ${where.join(' AND ')} ORDER BY r.recorded_at DESC, r.id DESC LIMIT ?`, ...args, limit);
    const best = {};
    for (const r of rows) {
      const b = best[r.test];
      if (!b || (r.lower_better ? r.value < b.value : r.value > b.value)) best[r.test] = r;
    }
    res.json({
      athlete_code: a.code,
      data: rows.map((r) => ({ id: r.id, test: r.test, category: r.category, unit: r.unit, value: r.value, attempt: r.attempt, source: r.source,
        hand_timed: !!r.hand_timed, recorded_at: r.recorded_at, testing_day: r.day_id ? { id: r.day_id, name: r.testing_day } : null, best: best[r.test] === r })),
    });
  });
  api.get('/v1/tests', requireApiKey, (_req, res) => {
    res.json({ data: all('SELECT name, category, unit, lower_better FROM tests WHERE hidden=0 ORDER BY category, name')
      .map((t) => ({ name: t.name, category: t.category, unit: t.unit, lower_is_better: !!t.lower_better })) });
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

module.exports = {
  routes,
  jobs: [
    { name: 'retry-webhooks', everyMin: 5, run: () => { hooks.retryDue().catch((e) => console.error('[job retry-webhooks]', e)); } },
    { name: 'prune-api-requests', everyMin: 24 * 60, run: () => apiOps.prune() },
  ],
};
