// Text messages (SMS). Mirrors server/email.js: every text is saved in the SMS outbox first, then sent by the
// configured provider:
//   DP_SMS_PROVIDER=twilio + TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM  → sent through Twilio
//   nothing set                                                                  → kept in the outbox only (test mode)
// DP_SMS_ONLY_TO (comma list of numbers) restricts delivery on staging; anything else stays in the outbox, "held".
// Adding another provider means one more entry in PROVIDERS: configured(), send(), verifyInbound(), parseInbound().
// Consent (who agreed to texts, who texted STOP) lives on leads and parents; see services/crm (canText, inbound keywords).
'use strict';
const crypto = require('crypto');
const { db, get, all, run, insert } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS sms_messages (
  id INTEGER PRIMARY KEY, direction TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('out','in')),
  to_phone TEXT NOT NULL, from_phone TEXT, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'logged', provider TEXT, provider_id TEXT, error TEXT, attempts INTEGER DEFAULT 0,
  lead_id INTEGER, family_id INTEGER, parent_id INTEGER, kind TEXT DEFAULT 'one', sent_by TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS sms_lead ON sms_messages(lead_id);
CREATE INDEX IF NOT EXISTS sms_family ON sms_messages(family_id);
CREATE INDEX IF NOT EXISTS sms_time ON sms_messages(created_at);`);

// ---- phone numbers: E.164 ("+18015550142"), US numbers by default ----
// Returns the E.164 form, or null when it isn't a phone number we can text.
function toE164(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/[a-z]/i.test(s.replace(/\s*(ext|x)\.?\s*\d+$/i, ''))) return null;
  const digits = s.replace(/\s*(ext|x)\.?\s*\d+$/i, '').replace(/\D/g, '');
  if (s.startsWith('+') && !s.startsWith('+1')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  const us = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (us.length !== 10 || !/[2-9]/.test(us[0]) || !/[2-9]/.test(us[3])) return null;
  return '+1' + us;
}
// "+18015550142" → "(801) 555-0142"; other countries stay as E.164.
function formatPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e164 || ''));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
}
// The same rule in SQL, for the parents trigger and the one-time migration (typed phones stay as typed for display).
const SQL_DIGITS = (col) => `replace(replace(replace(replace(replace(replace(${col},' ',''),'-',''),'(',''),')',''),'.',''),'+','')`;
const SQL_E164 = (col) => `(CASE WHEN ${col} IS NULL OR trim(${col})='' OR ${SQL_DIGITS(col)} GLOB '*[^0-9]*' THEN NULL
  WHEN length(${SQL_DIGITS(col)})=10 AND substr(${SQL_DIGITS(col)},1,1) BETWEEN '2' AND '9' AND substr(${SQL_DIGITS(col)},4,1) BETWEEN '2' AND '9' THEN '+1' || ${SQL_DIGITS(col)}
  WHEN length(${SQL_DIGITS(col)})=11 AND substr(${SQL_DIGITS(col)},1,1)='1' AND substr(${SQL_DIGITS(col)},2,1) BETWEEN '2' AND '9' AND substr(${SQL_DIGITS(col)},5,1) BETWEEN '2' AND '9' THEN '+' || ${SQL_DIGITS(col)}
  WHEN substr(trim(${col}),1,1)='+' AND substr(trim(${col}),1,2)<>'+1' AND length(${SQL_DIGITS(col)}) BETWEEN 8 AND 15 THEN '+' || ${SQL_DIGITS(col)}
  ELSE NULL END)`;

// Parents: an E.164 copy of the phone (kept in step by triggers, whoever saves the phone), and text consent.
const parentCols = all('PRAGMA table_info(parents)').map((c) => c.name);
for (const [col, type] of [['phone_e164', 'TEXT'], ['sms_opt_in', 'INTEGER DEFAULT 0'], ['sms_opt_in_at', 'TEXT'], ['sms_opt_in_source', 'TEXT'], ['sms_opt_out', 'INTEGER DEFAULT 0'], ['sms_opt_out_at', 'TEXT']]) {
  if (!parentCols.includes(col)) db.exec(`ALTER TABLE parents ADD COLUMN ${col} ${type}`);
}
db.exec(`CREATE TRIGGER IF NOT EXISTS parents_phone_e164_ins AFTER INSERT ON parents BEGIN
  UPDATE parents SET phone_e164=${SQL_E164('NEW.phone')} WHERE id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS parents_phone_e164_upd AFTER UPDATE OF phone ON parents BEGIN
  UPDATE parents SET phone_e164=${SQL_E164('NEW.phone')} WHERE id=NEW.id; END;`);
if (!parentCols.includes('phone_e164')) db.exec(`UPDATE parents SET phone_e164=${SQL_E164('phone')}`); // existing numbers, once
db.exec('CREATE INDEX IF NOT EXISTS parents_phone_e164 ON parents(phone_e164)');

// ---- message length: GSM-7 texts fit 160 characters (153 per part when split); anything else 70 (67) ----
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';
function segments(body) {
  const s = String(body ?? '');
  let gsm = true, units = 0;
  for (const ch of s) { if (GSM.includes(ch)) units += 1; else if (GSM_EXT.includes(ch)) units += 2; else { gsm = false; break; } }
  if (!gsm) { const n = [...s].length; return { chars: n, encoding: 'unicode', segments: n === 0 ? 0 : n <= 70 ? 1 : Math.ceil(n / 67), per: n <= 70 ? 70 : 67 }; }
  return { chars: units, encoding: 'gsm', segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), per: units <= 160 ? 160 : 153 };
}
const MAX_SEGMENTS = 6;

// ---- providers ----
const clean = (v) => String(v || '').replace(/[​-‍⁠﻿ ]/g, '').trim().replace(/^["']+|["']+$/g, '').trim();
const PROVIDERS = {
  twilio: {
    label: 'Twilio',
    configured: () => !!(clean(process.env.TWILIO_ACCOUNT_SID) && clean(process.env.TWILIO_AUTH_TOKEN) && clean(process.env.TWILIO_FROM)),
    from: () => clean(process.env.TWILIO_FROM),
    async send({ to, body }) {
      const sid = clean(process.env.TWILIO_ACCOUNT_SID), token = clean(process.env.TWILIO_AUTH_TOKEN);
      const r = await fetch(`${process.env.TWILIO_API_URL || 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: clean(process.env.TWILIO_FROM), Body: body }).toString(),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || `Twilio answered ${r.status}`);
      return { id: data.sid || null };
    },
    // X-Twilio-Signature: base64 HMAC-SHA1 of the full URL followed by each POST field name and value, sorted by name.
    verifyInbound(req) {
      const token = clean(process.env.TWILIO_AUTH_TOKEN);
      const sig = String(req.get('x-twilio-signature') || '');
      const url = (process.env.DP_APP_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '') + req.originalUrl;
      const params = req.body && typeof req.body === 'object' ? req.body : {};
      const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
      const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
      return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    },
    parseInbound: (b) => ({ from: b.From, to: b.To, body: b.Body, id: b.MessageSid || b.SmsSid || null }),
    reply: (res) => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>'),
  },
};

function provider() {
  const name = String(process.env.DP_SMS_PROVIDER || '').trim().toLowerCase();
  return name && PROVIDERS[name]?.configured() ? name : null;
}
function allowed(to) {
  const list = (process.env.DP_SMS_ONLY_TO || '').split(',').map((s) => toE164(s)).filter(Boolean);
  return !list.length || list.includes(to);
}
function mode() {
  if (!provider()) return 'test';
  return process.env.DP_SMS_ONLY_TO ? 'restricted' : 'live';
}
const willDeliver = (to) => !!provider() && allowed(to);

// Has this number texted STOP (on any lead or parent)? Stopped numbers get nothing, whoever sends.
function stopped(e164) {
  if (!e164) return false;
  if (get('SELECT 1 FROM parents WHERE phone_e164=? AND sms_opt_out=1', e164)) return true;
  try { return !!get('SELECT 1 FROM crm_leads WHERE phone=? AND sms_opt_out=1', e164); } catch { return false; }
}

async function deliver(row) {
  const name = provider();
  run("UPDATE sms_messages SET attempts=attempts+1, updated_at=datetime('now') WHERE id=?", row.id);
  try {
    const r = await PROVIDERS[name].send({ to: row.to_phone, body: row.body });
    run("UPDATE sms_messages SET status='sent', error=NULL, provider=?, provider_id=?, updated_at=datetime('now') WHERE id=?", name, r.id || null, row.id);
    return { ok: true };
  } catch (e) {
    run("UPDATE sms_messages SET status='failed', provider=?, error=?, updated_at=datetime('now') WHERE id=?", name, String(e.message || e).slice(0, 500), row.id);
    return { ok: false, error: String(e.message || e) };
  }
}

// Save a text to the SMS outbox and send it in the background. Returns { id, status } or throws on a bad number,
// an empty or too-long message, or a number that texted STOP. Callers check consent (services/crm canText) first;
// meta.compliance marks the STOP/HELP replies the law requires, which go even to a stopped number.
function sendSms(to, body, meta = {}) {
  const phone = toE164(to);
  const text = String(body ?? '').trim();
  const { bad } = require('./lib');
  if (!phone) throw bad('That phone number can’t get texts. Use a mobile number with its area code.');
  if (!text) throw bad('Write the message first.');
  if (segments(text).segments > MAX_SEGMENTS) throw bad(`Keep texts to ${MAX_SEGMENTS} parts (about ${MAX_SEGMENTS * 153} characters).`);
  if (!meta.compliance && stopped(phone)) throw bad('That number replied STOP, so it can’t be texted. They can reply START to get texts again.');
  const status = !provider() ? 'logged' : allowed(phone) ? 'queued' : 'held';
  const id = insert('sms_messages', {
    direction: 'out', to_phone: phone, from_phone: provider() ? PROVIDERS[provider()].from() : null, body: text, status, provider: provider(),
    lead_id: meta.leadId || null, family_id: meta.familyId || null, parent_id: meta.parentId || null, kind: meta.kind || 'one', sent_by: meta.sentBy || null,
  });
  if (status === 'queued') deliver(get('SELECT * FROM sms_messages WHERE id=?', id));
  return { id, status };
}

// An inbound text from the provider (already verified), saved with whoever it's from.
function recordInbound({ from, to, body, id }, meta = {}) {
  return insert('sms_messages', {
    direction: 'in', to_phone: toE164(to) || String(to || ''), from_phone: toE164(from) || String(from || ''), body: String(body ?? '').slice(0, 1600),
    status: 'received', provider: provider(), provider_id: id || null, lead_id: meta.leadId || null, family_id: meta.familyId || null, parent_id: meta.parentId || null, kind: 'inbound',
  });
}

// Job: retry failed texts (up to 3 tries).
async function retryFailed() {
  if (!provider()) return 0;
  const rows = all("SELECT * FROM sms_messages WHERE direction='out' AND attempts<3 AND (status='failed' OR (status='queued' AND created_at<datetime('now','-5 minutes'))) ORDER BY id LIMIT 50");
  for (const r of rows) await deliver(r);
  return rows.length;
}

module.exports = { toE164, formatPhone, SQL_E164, segments, MAX_SEGMENTS, PROVIDERS, provider, mode, allowed, willDeliver, stopped, sendSms, recordInbound, retryFailed };
