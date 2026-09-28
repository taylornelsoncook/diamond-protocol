import { newId, v, notFound, conflict, badRequest } from '../util.js';

// Every email is recorded in the outbox. With RESEND_API_KEY set, it's also sent through Resend
// as a branded HTML email with a plain-text copy. Without it (local and test mode), coaches can read
// messages under API & integrations → Outbox.
// EMAIL_ONLY_TO (comma list of addresses or @domains) limits real delivery, e.g. on a staging copy with
// demo families; anything else stays in the outbox marked "held".

const clean = (v) => cleanSetting(v);
// Settings pasted on a phone can pick up curly quotes, spaces or invisible characters.
export function cleanSetting(v) {
  return String(v || '').replace(/[​-‍⁠﻿ ]/g, '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
}
function resendKey(ctx) {
  const key = clean(ctx.mail?.resendKey).replace(/\s+/g, '');
  if (!key) return null;
  if (/[^\x21-\x7E]/.test(key)) throw new Error("The RESEND_API_KEY setting has a character that isn't part of the key. Paste the key again with nothing around it.");
  if (!key.startsWith('re_')) throw new Error("The RESEND_API_KEY setting doesn't look like a Resend key (they start with re_).");
  return key;
}
function onlyTo(ctx) {
  return clean(ctx.mail?.onlyTo).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function allowed(ctx, to) {
  const list = onlyTo(ctx);
  if (!list.length) return true;
  const addr = String(to).toLowerCase();
  return list.some((x) => (x.startsWith('@') ? addr.endsWith(x) : addr === x));
}

// True when an email to this address will really be delivered (a provider is set and the address is allowed).
export const willDeliver = (ctx, to) => !!clean(ctx.mail?.resendKey) && allowed(ctx, to);
export function mailMode(ctx) {
  if (!clean(ctx.mail?.resendKey)) return 'test';
  return onlyTo(ctx).length ? 'restricted' : 'live';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Plain text → branded HTML: paragraphs, clickable links, a big sign-in code.
export function toHtml(ctx, text) {
  const base = (ctx.publicUrl || '').replace(/\/$/, '');
  const paras = String(text).split(/\n{2,}/).map((p) => {
    let h = esc(p).replace(/\n/g, '<br>');
    h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2F6B34;font-weight:600">$1</a>');
    h = h.replace(/\b(\d{6})\b/, '<span style="font:700 28px/1.2 \'Courier New\',monospace;letter-spacing:4px;color:#111">$1</span>');
    return `<p style="margin:0 0 16px">${h}</p>`;
  }).join('');
  const logo = base ? `<tr><td style="background:#000;padding:20px;text-align:center"><img src="${base}/brand/logo.png" width="120" height="120" alt="Diamond Protocol" style="display:inline-block"></td></tr>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f4f2;padding:24px 12px;font:16px/1.55 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1f1d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #d6dad7;border-radius:10px;overflow:hidden">
${logo}<tr><td style="padding:28px 28px 12px">${paras}</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #e3e6e4;font-size:12px;color:#5d6461;letter-spacing:.12em;text-transform:uppercase">Diamond Protocol · Built under pressure</td></tr>
</table></td></tr></table></body></html>`;
}

// sensitive: the email holds a password or a private link (sign-in, reset). It is marked so it's never sent to another
// address from the outbox, and secret (a string or a list) is hidden from the outbox's copy once the email really went
// out; while nothing is sent (no email service, or held on a staging copy) the outbox is the only copy, so it stays.
export async function sendEmail(ctx, { to, subject, text, sensitive = false, secret = null }) {
  const id = newId('msg');
  let status = 'logged', error = null;
  if (clean(ctx.mail?.resendKey)) {
    if (!allowed(ctx, to)) { status = 'logged'; error = `Held: this server only delivers to ${clean(ctx.mail.onlyTo)}.`; }
    else {
      try {
        const replyTo = clean(ctx.mail.replyTo);
        const res = await fetch(ctx.mail.resendUrl || 'https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${resendKey(ctx)}`, 'content-type': 'application/json', 'idempotency-key': `dp-${id}` },
          body: JSON.stringify({ from: clean(ctx.mail.from).replace(/[“”]/g, '"'), to: [to], subject, text, html: toHtml(ctx, text), ...(replyTo ? { reply_to: replyTo } : {}) }),
          signal: AbortSignal.timeout(10000)
        });
        status = res.ok ? 'sent' : 'failed';
        if (!res.ok) { const d = await res.json().catch(() => ({})); error = d.message || `Email service responded ${res.status}`; }
      } catch (e) { status = 'failed'; error = e.message; }
    }
  }
  let kept = text;
  if (status !== 'logged') for (const s of [secret].flat().filter(Boolean)) kept = kept.split(s).join('[hidden once sent]');
  ctx.db.run('INSERT INTO outbox (id, to_email, subject, body, status, error, created_at, sensitive) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, to, subject, kept, status, error, ctx.now(), sensitive || privateContent(subject, text) ? 1 : 0);
  return { id, status: error?.startsWith('Held:') ? 'held' : status, error };
}
// Emails that carry a way in (a sign-in or sign-up code, a password, a reset link, an athlete's app link, a pay, invoice,
// receipt, report or offer link, a personal unsubscribe link) go only to the address they were written for.
const PRIVATE = /(sign-in code|sign-up code|one-time password|[?&#](token|reset|share)=|\/(pay|here|spot|receipt|invoice|r|c|cal)\/[\w-]{8,}|\/app\?)/i;
export const privateContent = (subject, text) => PRIVATE.test(subject) || PRIVATE.test(text);

// The outbox: status (sent, failed, held, not_sent), q (address, subject or text), newest first, with counts by status.
const OUTBOX_STATUS = { sent: `status = 'sent'`, failed: `status = 'failed'`, held: `status = 'logged' AND error LIKE 'Held:%'`, not_sent: `status = 'logged' AND (error IS NULL OR error NOT LIKE 'Held:%')` };
export function listOutbox(ctx, q = {}) {
  if (typeof q === 'number') q = { limit: q };
  const where = [], p = [];
  if (q.status) {
    if (!OUTBOX_STATUS[q.status]) throw badRequest('status must be sent, failed, held or not_sent.');
    where.push(OUTBOX_STATUS[q.status]);
  }
  const text = String(q.q ?? '').trim().slice(0, 100);
  if (text) { const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; where.push(`(to_email LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`); p.push(like, like, like); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200), offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);
  return ctx.db.all(`SELECT id, to_email, subject, body, status, error, created_at, sensitive FROM outbox ${w} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, ...p, limit, offset)
    .map((m) => ({ ...m, status: m.status === 'logged' && m.error?.startsWith('Held:') ? 'held' : m.status, sensitive: !!m.sensitive }));
}
export function outboxCounts(ctx, q = {}) {
  const out = {};
  for (const [k, cond] of Object.entries(OUTBOX_STATUS)) out[k] = ctx.db.get(`SELECT COUNT(*) AS n FROM outbox WHERE ${cond}`).n;
  if (q.q) out.matching = listOutbox(ctx, { q: q.q, status: q.status, limit: 200 }).length;
  return out;
}
// Send an outbox email again as a new message: to the same address, or (for emails without a way in) another one.
export async function resendEmail(ctx, id, body = {}) {
  const m = ctx.db.get('SELECT * FROM outbox WHERE id = ?', id);
  if (!m) throw notFound('Email');
  const to = body.to === undefined || body.to === '' ? m.to_email : v.email(body.to);
  const elsewhere = to.toLowerCase() !== m.to_email.toLowerCase();
  if (elsewhere && (m.sensitive || privateContent(m.subject, m.body))) throw conflict('This email holds a sign-in code, password or private link, so it only goes to the address it was written for. Send them a new one instead (a new code, reset or link).');
  if (m.body.includes('[hidden once sent]')) throw conflict('Part of this email was hidden after it was sent (a password or link), so it can\'t be sent again. Send a new one instead.');
  if (mailMode(ctx) === 'test') throw badRequest('No email service is connected, so nothing can be sent. Set RESEND_API_KEY on the server.');
  const out = await sendEmail(ctx, { to, subject: m.subject, text: m.body, sensitive: !!m.sensitive });
  if (out.status === 'held') throw badRequest(`This server only delivers to ${ctx.mail.onlyTo}.`);
  if (out.status !== 'sent') throw badRequest(out.error || 'The email service refused the message.');
  return { ok: true, id: out.id, to };
}

// Fire-and-forget notification to every guardian in a family.
export function notifyFamily(ctx, familyId, subject, text) {
  if (!familyId) return;
  for (const g of ctx.db.all('SELECT email FROM guardians WHERE family_id = ?', familyId)) sendEmail(ctx, { to: g.email, subject, text }).catch(() => {});
}
