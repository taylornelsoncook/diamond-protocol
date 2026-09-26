// Email delivery. Every message is saved in the outbox first, then sent by the configured provider:
//   RESEND_API_KEY     → sent through Resend (https://resend.com)
//   DP_EMAIL_WEBHOOK   → POSTed as {to, subject, body, html} to your own relay
//   neither            → kept in the outbox only (test mode)
// DP_EMAIL_FROM sets the sender, DP_EMAIL_REPLY_TO where replies go.
// DP_EMAIL_ONLY_TO (comma list of addresses or @domains) restricts delivery, e.g. on staging;
// anything else stays in the outbox marked "held".
'use strict';
const { db, get, run, insert } = require('./db');

// Older databases: add delivery columns to the outbox.
const cols = db.prepare('PRAGMA table_info(outbox)').all().map((c) => c.name);
if (!cols.includes('error')) db.exec('ALTER TABLE outbox ADD COLUMN error TEXT');
if (!cols.includes('attempts')) db.exec('ALTER TABLE outbox ADD COLUMN attempts INTEGER DEFAULT 0');
if (!cols.includes('provider_id')) db.exec('ALTER TABLE outbox ADD COLUMN provider_id TEXT');

const MAX_ATTEMPTS = 3;

// Settings pasted on a phone can pick up curly quotes, spaces or invisible characters. Strip them.
function clean(v) {
  return String(v || '').replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/g, '').trim().replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g, '').trim();
}
function resendKey() {
  const key = clean(process.env.RESEND_API_KEY).replace(/\s+/g, '');
  if (/[^\x21-\x7E]/.test(key)) throw new Error("The RESEND_API_KEY setting has a character that isn't part of the key. In Render, delete the value, copy the key again from Resend and paste it with nothing around it.");
  if (!key.startsWith('re_')) throw new Error("The RESEND_API_KEY setting doesn't look like a Resend key (they start with re_). Copy it again from Resend.");
  return key;
}

function provider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.DP_EMAIL_WEBHOOK) return 'webhook';
  return null;
}

function allowed(to) {
  const list = (process.env.DP_EMAIL_ONLY_TO || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const addr = String(to).toLowerCase();
  return list.some((x) => (x.startsWith('@') ? addr.endsWith(x) : addr === x));
}

// True when a message to this address will really be delivered.
const willDeliver = (to) => !!provider() && allowed(to);

function mode() {
  if (!provider()) return 'test';
  return process.env.DP_EMAIL_ONLY_TO ? 'restricted' : 'live';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Plain text → branded HTML: paragraphs, line breaks, clickable links, big sign-in codes.
function toHtml(subject, text) {
  const base = require('./lib').appUrl();
  const business = require('./lib').businessName();
  const paras = String(text).split(/\n{2,}/).map((p) => {
    let h = esc(p).replace(/\n/g, '<br>');
    h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2F6B34;font-weight:600">$1</a>');
    h = h.replace(/\b(\d{6})\b/, '<span style="font:700 28px/1.2 \'Courier New\',monospace;letter-spacing:4px;color:#111">$1</span>');
    return `<p style="margin:0 0 16px">${h}</p>`;
  }).join('');
  return `<!doctype html><html><body style="margin:0;background:#f3f4f2;padding:24px 12px;font:16px/1.55 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1f1d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #d6dad7;border-radius:10px;overflow:hidden">
<tr><td style="background:#000;padding:20px;text-align:center"><img src="${base}/img/logo-320.png" width="120" height="120" alt="${esc(business)}" style="display:inline-block"></td></tr>
<tr><td style="padding:28px 28px 12px">${paras}</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #e3e6e4;font-size:12px;color:#5d6461;letter-spacing:.12em;text-transform:uppercase">${esc(business)} · Built under pressure</td></tr>
</table></td></tr></table></body></html>`;
}

async function deliver(row) {
  const p = provider();
  const html = toHtml(row.subject, row.body);
  run('UPDATE outbox SET attempts=attempts+1 WHERE id=?', row.id);
  try {
    let providerId = null;
    if (p === 'resend') {
      const from = clean(process.env.DP_EMAIL_FROM).replace(/[\u201C\u201D]/g, '"') || `${require('./lib').businessName()} <onboarding@resend.dev>`;
      const r = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${resendKey()}`, 'content-type': 'application/json', 'idempotency-key': `dp-outbox-${row.id}` },
        body: JSON.stringify({ from, to: [row.to_email], subject: row.subject, text: row.body, html, ...(process.env.DP_EMAIL_REPLY_TO ? { reply_to: process.env.DP_EMAIL_REPLY_TO } : {}) }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || `Resend answered ${r.status}`);
      providerId = data.id || null;
    } else if (p === 'webhook') {
      const r = await fetch(process.env.DP_EMAIL_WEBHOOK, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: row.to_email, subject: row.subject, body: row.body, html }) });
      if (!r.ok) throw new Error(`Relay answered ${r.status}`);
    }
    run("UPDATE outbox SET status='sent', error=NULL, provider_id=? WHERE id=?", providerId, row.id);
    return { ok: true };
  } catch (e) {
    run("UPDATE outbox SET status='failed', error=? WHERE id=?", String(e.message || e).slice(0, 500), row.id);
    return { ok: false, error: String(e.message || e) };
  }
}

// Save to the outbox and send in the background. Returns the outbox id.
function sendEmail(to, subject, body) {
  if (!to) return null;
  const status = !provider() ? 'logged' : allowed(to) ? 'queued' : 'held';
  const id = insert('outbox', { to_email: to, subject, body, status });
  if (status === 'queued') deliver(get('SELECT * FROM outbox WHERE id=?', id));
  return id;
}

// Same, but waits for the provider's answer (used by "Send test email").
async function sendEmailNow(to, subject, body) {
  if (!provider()) return { ok: false, error: 'No email provider is connected. Set RESEND_API_KEY.' };
  if (!allowed(to)) return { ok: false, error: `This server only delivers to ${process.env.DP_EMAIL_ONLY_TO}.` };
  const id = insert('outbox', { to_email: to, subject, body, status: 'queued' });
  return deliver(get('SELECT * FROM outbox WHERE id=?', id));
}

// Job: retry failed (or stuck queued) messages, up to 3 tries each.
async function retryFailed() {
  if (!provider()) return 0;
  const rows = db.prepare(`SELECT * FROM outbox WHERE attempts<? AND (status='failed' OR (status='queued' AND created_at<datetime('now','-5 minutes'))) ORDER BY id LIMIT 50`).all(MAX_ATTEMPTS);
  for (const r of rows) await deliver(r);
  return rows.length;
}

module.exports = { sendEmail, sendEmailNow, retryFailed, willDeliver, mode, provider, toHtml };
