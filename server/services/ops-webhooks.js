// Webhooks for API & integrations: secrets, signed delivery (used by lib.emit and "Send test event"), resend,
// automatic retries with backoff, per-hook health, and the event catalogue with sample payloads.
'use strict';
const crypto = require('crypto');
const { db, all, get, insert, run } = require('../db');

// Older databases: a label on each webhook, and delivery attempt details.
const hookCols = all('PRAGMA table_info(webhooks)').map((c) => c.name);
if (!hookCols.includes('label')) db.exec('ALTER TABLE webhooks ADD COLUMN label TEXT');
const delCols = all('PRAGMA table_info(webhook_deliveries)').map((c) => c.name);
if (!delCols.includes('attempts')) db.exec('ALTER TABLE webhook_deliveries ADD COLUMN attempts INTEGER DEFAULT 1');
if (!delCols.includes('last_attempt_at')) db.exec('ALTER TABLE webhook_deliveries ADD COLUMN last_attempt_at TEXT');
if (!delCols.includes('duration_ms')) db.exec('ALTER TABLE webhook_deliveries ADD COLUMN duration_ms INTEGER');
if (!delCols.includes('response')) db.exec('ALTER TABLE webhook_deliveries ADD COLUMN response TEXT');
db.exec('CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries(webhook_id, id)');

const TIMEOUT_MS = 8000;
// Minutes to wait after attempt 1, 2 and 3 before trying again. Four attempts in all, then we stop.
const RETRY_AFTER_MIN = [5, 30, 120];
const MAX_ATTEMPTS = RETRY_AFTER_MIN.length + 1;

const newSecret = () => 'whsec_' + crypto.randomBytes(24).toString('hex');
const sign = (secret, body) => crypto.createHmac('sha256', secret || '').update(body).digest('hex');
const isOk = (status) => status >= 200 && status < 300;

// Turn a network failure into something an owner can act on.
function reason(e) {
  const code = e?.cause?.code || e?.code || '';
  if (e?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return `No answer within ${TIMEOUT_MS / 1000} seconds.`;
  if (code === 'ECONNREFUSED') return 'Connection refused. Nothing is listening at that address.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "That address doesn't exist (the DNS lookup failed).";
  if (code === 'ECONNRESET') return 'The connection was cut off before an answer came back.';
  if (/CERT|SSL|TLS/i.test(code)) return `The site's HTTPS certificate was rejected (${code}).`;
  return String(code || e?.message || e).slice(0, 300);
}

// POST one stored delivery to its webhook and record the answer. Resolves to the HTTP status (0 = no answer).
function attempt(hook, did, body, event) {
  const started = Date.now();
  run("UPDATE webhook_deliveries SET status=NULL, last_attempt_at=datetime('now') WHERE id=?", did);
  let p;
  try {
    p = fetch(hook.url, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual',
      headers: { 'content-type': 'application/json', 'user-agent': 'DiamondProtocol-Webhooks/1.0', 'x-dp-signature': sign(hook.secret, body), 'x-dp-event': String(event), 'x-dp-delivery': String(did) },
      body,
    });
  } catch (e) { p = Promise.reject(e); }
  return p.then(async (r) => {
    const text = await r.text().catch(() => '');
    run('UPDATE webhook_deliveries SET status=?, error=NULL, duration_ms=?, response=? WHERE id=?', r.status, Date.now() - started, text.slice(0, 500) || null, did);
    return r.status;
  }).catch((e) => {
    run('UPDATE webhook_deliveries SET status=0, error=?, duration_ms=?, response=NULL WHERE id=?', reason(e), Date.now() - started, did);
    return 0;
  });
}

// Send one event to one webhook, recording the delivery. Returns { id, done } where done resolves to the status.
function deliver(hook, event, data) {
  const body = JSON.stringify({ event, created_at: new Date().toISOString(), data });
  const did = insert('webhook_deliveries', { webhook_id: hook.id, event, payload: body, status: null, attempts: 1 });
  return { id: did, done: attempt(hook, did, body, event) };
}

// Send a stored delivery again: same body and x-dp-delivery id, signed with the current secret.
function redeliver(delivery) {
  const hook = get('SELECT * FROM webhooks WHERE id=?', delivery.webhook_id);
  run('UPDATE webhook_deliveries SET attempts=COALESCE(attempts,1)+1 WHERE id=?', delivery.id);
  return attempt(hook, delivery.id, delivery.payload, delivery.event);
}

// Job: failed deliveries from the last day to active webhooks are tried again after 5 min, 30 min and 2 h.
async function retryDue(now = Date.now()) {
  const due = all(`SELECT d.* FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
    WHERE w.active=1 AND d.status IS NOT NULL AND (d.status<200 OR d.status>=300) AND COALESCE(d.attempts,1)<?
      AND d.event<>'test.ping' AND d.created_at >= datetime('now','-1 day') ORDER BY d.id LIMIT 50`, MAX_ATTEMPTS)
    .filter((d) => {
      const last = Date.parse(String(d.last_attempt_at || d.created_at).replace(' ', 'T') + 'Z');
      return now - last >= RETRY_AFTER_MIN[(d.attempts || 1) - 1] * 60e3;
    });
  for (const d of due) await redeliver(d);
  return due.length;
}

// How a webhook is doing: last answer, failures this week, and whether the last few all failed.
function health(hookId) {
  const recent = all('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND status IS NOT NULL ORDER BY id DESC LIMIT 3', hookId);
  const week = get(`SELECT COUNT(*) AS n, SUM(CASE WHEN status>=200 AND status<300 THEN 1 ELSE 0 END) AS ok
    FROM webhook_deliveries WHERE webhook_id=? AND status IS NOT NULL AND created_at >= datetime('now','-7 days')`, hookId);
  const last = get('SELECT status, created_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 1', hookId);
  return {
    sent_7d: week.n, ok_7d: week.ok || 0, failed_7d: week.n - (week.ok || 0),
    last_status: last ? last.status : null, last_at: last ? last.created_at : null,
    failing: recent.length >= 3 && recent.every((r) => !isOk(r.status)),
  };
}

// Every event we send, what it means and a realistic sample of its data (used for test events and the reference).
const EVENT_INFO = {
  'client.created': { about: 'A new client is added.', sample: { athlete_id: 101, athlete_code: 'AVALOP2026', first_name: 'Ava', last_name: 'Lopez', family_id: 42, parent_email: 'maria.lopez@example.com' } },
  'booking.created': { about: 'A session is booked by staff, a parent or a standing spot.', sample: { booking_id: 5120, event_id: 41, athlete_code: 'AVALOP2026', starts_at: '2026-09-28T16:30', name: 'Youth Speed & Agility' } },
  'booking.cancelled': { about: 'A booking is cancelled.', sample: { booking_id: 5120, event_id: 41, late: false } },
  'checkin.created': { about: 'An athlete is checked in.', sample: { booking_id: 5120, athlete_id: 101, event_id: 41 } },
  'payment.succeeded': { about: 'A charge goes through.', sample: { invoice_id: 880, family_id: 42, athlete_id: 101, amount_cents: 18900, description: 'Performance membership', method: 'card' } },
  'payment.failed': { about: 'A charge is declined.', sample: { invoice_id: 881, family_id: 42, athlete_id: 101, amount_cents: 18900, description: 'Performance membership', method: 'card' } },
  'invoice.paid': { about: 'A school invoice is paid online or recorded as paid.', sample: { invoice_id: 77, number: 'DP-2026-0036', amount_cents: 240000, method: 'check', contract_id: 3 } },
  'result.created': { about: 'A test result is saved to a profile.', sample: { id: 812, athlete: { id: 101, code: 'AVALOP2026', name: 'Ava Lopez' }, test: 'Vertical jump', unit: 'in', value: 21.5, attempt: 1, day_id: null, source: 'api', hand_timed: false } },
  'pr.set': { about: 'A result is a personal record.', sample: { id: 812, athlete: { id: 101, code: 'AVALOP2026', name: 'Ava Lopez' }, test: 'Vertical jump', unit: 'in', value: 21.5, attempt: 1, day_id: null, source: 'api', hand_timed: false } },
  'workout.completed': { about: 'An athlete finishes a workout in the workout app.', sample: { athlete_code: 'AVALOP2026', athlete: 'Ava Lopez', program: 'Youth Speed Foundations', week: 2, day: 2, title: 'Strength', exercises_done: 4, exercises_total: 4, note: 'Felt strong today.', finished_at: '2026-09-26 23:12:04' } },
  'program.assigned': { about: 'A program is assigned to an athlete.', sample: { athlete_code: 'AVALOP2026', athlete: 'Ava Lopez', program_id: 3, program: 'Youth Speed Foundations', started: '2026-09-28', workout_url: 'https://your-site/w/abc123' } },
};

module.exports = { newSecret, sign, deliver, redeliver, retryDue, health, isOk, reason, EVENT_INFO, MAX_ATTEMPTS, RETRY_AFTER_MIN };
