import { createHmac } from 'node:crypto';
import { newId, badRequest, safeEqual } from '../util.js';
import { getSetting } from './families.js';
import { sendEmail, cleanSetting as clean } from './mail.js';

// Text messages. Every text is recorded in the texts log. With TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_FROM set, texts are also sent through Twilio. Without them (local, test mode, or before the owner has
// a Twilio account) nothing is sent and the owner can read every text under API & integrations → Texts.
// SMS_ONLY_TO (comma list of phone numbers) limits real delivery on a staging copy, like EMAIL_ONLY_TO.
// Parents only get texts after they turn them on in the parent portal, and replying STOP turns them off.

export const TEXT_KINDS = {
  reminder: 'Reminder the day before a booked session',
  waitlist: 'When an athlete moves off the waitlist',
  canceled: 'When you cancel a session',
  payment_failed: 'When a membership payment doesn\'t go through'
};
const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'];
const START_WORDS = ['START', 'UNSTOP', 'YES'];

// US numbers in any common format become +15125550100. Numbers with a + and country code are kept.
export function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
const pretty = (p) => (/^\+1\d{10}$/.test(p) ? `(${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}` : p);

const cfg = (ctx) => ({ sid: clean(ctx.sms?.accountSid), token: clean(ctx.sms?.authToken), from: clean(ctx.sms?.from) });
function onlyTo(ctx) { return clean(ctx.sms?.onlyTo).split(',').map(normalizePhone).filter(Boolean); }
export function smsMode(ctx) {
  const c = cfg(ctx);
  if (!c.sid || !c.token || !c.from) return 'test';
  return onlyTo(ctx).length ? 'restricted' : 'live';
}

export async function sendText(ctx, { to, body, kind = 'manual', familyId = null }) {
  const phone = normalizePhone(to);
  if (!phone) throw badRequest('Enter a phone number with its area code, like (512) 555-0100.');
  const text = String(body).slice(0, 1000);
  const id = newId('txt');
  let status = 'logged', error = null, providerId = null;
  if (smsMode(ctx) !== 'test') {
    const list = onlyTo(ctx);
    if (list.length && !list.includes(phone)) { status = 'held'; error = `Held: this server only texts ${list.map(pretty).join(', ')}.`; }
    else {
      const c = cfg(ctx);
      try {
        const form = new URLSearchParams({ To: phone, Body: text, ...(c.from.startsWith('MG') ? { MessagingServiceSid: c.from } : { From: normalizePhone(c.from) ?? c.from }) });
        const res = await fetch(`${ctx.sms.twilioUrl || 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/Messages.json`, {
          method: 'POST',
          headers: { authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: form, signal: AbortSignal.timeout(10000)
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) { status = 'sent'; providerId = d.sid ?? null; }
        else { status = 'failed'; error = d.message || `Text service responded ${res.status}`; }
      } catch (e) { status = 'failed'; error = e.message; }
    }
  }
  ctx.db.run(`INSERT INTO texts (id, direction, phone, family_id, kind, body, status, error, provider_id, created_at) VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, phone, familyId, kind, text, status, error, providerId, ctx.now());
  return { id, status, error };
}
export const listTexts = (ctx, limit = 50) => ctx.db.all('SELECT * FROM texts ORDER BY created_at DESC, rowid DESC LIMIT ?', limit);

// ---------- Automatic texts to families ----------
const textsOn = (ctx, kind) => !getSetting(ctx, 'texts_off').split(',').includes(kind);
const optedIn = 'sms_opt_in_at IS NOT NULL AND sms_opt_out_at IS NULL';
export function familyPhones(ctx, familyId) {
  return [...new Set(ctx.db.all(`SELECT phone FROM guardians WHERE family_id = ? AND ${optedIn}`, familyId).map((g) => normalizePhone(g.phone)).filter(Boolean))];
}
// Fire-and-forget text to every parent in a family who turned texts on. The business name leads every text.
export function textFamily(ctx, familyId, kind, body) {
  if (!familyId || !textsOn(ctx, kind)) return;
  for (const phone of familyPhones(ctx, familyId)) sendText(ctx, { to: phone, body: `${getSetting(ctx, 'business_name')}: ${body}`, kind, familyId }).catch((e) => console.error('text', e.message));
}

// Reminder texts for sessions starting in the next 24 hours, one per family per session. Bookings made less than
// a day ahead are skipped (the family just got a confirmation). Runs hourly; each booking is reminded at most once.
export async function sendReminders(ctx, asOf = ctx.now()) {
  const until = new Date(Date.parse(asOf) + 24 * 3600000).toISOString();
  const rows = ctx.db.all(`SELECT b.id, b.created_at, s.id AS session_id, s.name AS session_name, s.starts_at, l.name AS location_name, c.name AS client_name, c.family_id
    FROM bookings b JOIN class_sessions s ON s.id = b.session_id JOIN locations l ON l.id = s.location_id JOIN clients c ON c.id = b.client_id
    WHERE b.status = 'booked' AND b.reminded_at IS NULL AND s.status = 'scheduled' AND s.starts_at > ? AND s.starts_at <= ? ORDER BY s.starts_at, c.name`, asOf, until);
  if (!textsOn(ctx, 'reminder')) return 0;
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.family_id}|${r.session_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const zone = getSetting(ctx, 'timezone');
  const when = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  let sent = 0;
  for (const list of groups.values()) {
    const s = list[0];
    const due = list.filter((r) => Date.parse(r.created_at) <= Date.parse(r.starts_at) - 24 * 3600000);
    if (s.family_id && due.length && familyPhones(ctx, s.family_id).length) {
      const names = due.map((r) => r.client_name.split(' ')[0]);
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} have` : `${names[0]} has`;
      textFamily(ctx, s.family_id, 'reminder', `Reminder: ${who} ${s.session_name} ${when(s.starts_at)} at ${s.location_name}. Can't make it? Cancel in the parent portal: ${ctx.publicUrl ?? ''}/parent`);
      sent++;
    }
    for (const r of list) ctx.db.run('UPDATE bookings SET reminded_at = ? WHERE id = ?', ctx.now(), r.id);
  }
  return sent;
}

// ---------- Parents turn texts on and off ----------
export function textStatus(g) {
  if (!g.sms_opt_in_at) return 'off';
  return g.sms_opt_out_at ? 'stopped' : 'on';
}
export async function setTextPrefs(ctx, guardian, body) {
  if (body.texts === true) {
    const phone = normalizePhone(body.phone ?? guardian.phone);
    if (!phone) throw badRequest('Enter your mobile number with its area code, like (512) 555-0100.');
    ctx.db.run('UPDATE guardians SET phone = ?, sms_opt_in_at = ?, sms_opt_out_at = NULL WHERE id = ?', phone, ctx.now(), guardian.id);
    await sendText(ctx, { to: phone, kind: 'opt_in', familyId: guardian.family_id,
      body: `${getSetting(ctx, 'business_name')}: You'll get texts about bookings, schedule changes and payments. Msg & data rates may apply. Reply HELP for help, STOP to stop.` }).catch((e) => console.error('text', e.message));
  } else if (body.texts === false) {
    ctx.db.run('UPDATE guardians SET sms_opt_in_at = NULL, sms_opt_out_at = NULL WHERE id = ?', guardian.id);
  } else throw badRequest('Set texts to true or false.');
  const g = ctx.db.get('SELECT phone, sms_opt_in_at, sms_opt_out_at FROM guardians WHERE id = ?', guardian.id);
  return { phone: g.phone, texts: textStatus(g) };
}

// ---------- Replies from parents (Twilio calls POST /sms/inbound) ----------
// Twilio signs each request: base64 HMAC-SHA1 of the full URL followed by every form field (name + value, sorted by name).
export function verifyTwilio(ctx, url, params, signature) {
  const { token } = cfg(ctx);
  if (!token || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return safeEqual(createHmac('sha1', token).update(data).digest('base64'), signature);
}
// Records the reply, handles STOP / START / HELP, and emails anything else to the owners. Returns the text to reply with, if any.
export async function handleInbound(ctx, params) {
  const phone = normalizePhone(params.From);
  const body = String(params.Body ?? '').trim().slice(0, 1000);
  if (!phone) return null;
  const parents = ctx.db.all('SELECT id, name, family_id, phone, sms_opt_in_at FROM guardians WHERE phone IS NOT NULL').filter((g) => normalizePhone(g.phone) === phone);
  const familyId = parents[0]?.family_id ?? null;
  ctx.db.run(`INSERT INTO texts (id, direction, phone, family_id, kind, body, status, provider_id, created_at) VALUES (?, 'in', ?, ?, 'reply', ?, 'received', ?, ?)`,
    newId('txt'), phone, familyId, body, String(params.MessageSid ?? '').slice(0, 64) || null, ctx.now());
  const word = body.toUpperCase().replace(/[^A-Z]/g, '');
  const biz = getSetting(ctx, 'business_name');
  if (STOP_WORDS.includes(word)) {
    for (const g of parents) ctx.db.run('UPDATE guardians SET sms_opt_out_at = ? WHERE id = ?', ctx.now(), g.id);
    for (const l of ctx.db.all('SELECT id, phone FROM leads WHERE texts_ok = 1')) if (normalizePhone(l.phone) === phone) ctx.db.run('UPDATE leads SET texts_ok = 0 WHERE id = ?', l.id);   // leads who asked about training
    return null;                                           // Twilio sends the carrier's standard "unsubscribed" reply
  }
  if (START_WORDS.includes(word)) {
    for (const g of parents.filter((p) => p.sms_opt_in_at)) ctx.db.run('UPDATE guardians SET sms_opt_out_at = NULL WHERE id = ?', g.id);
    return null;
  }
  if (word === 'HELP' || word === 'INFO') return `${biz}: texts about bookings, schedule changes and payments. Manage them in the parent portal: ${ctx.publicUrl ?? ''}/parent. Reply STOP to stop.`;
  const who = parents.length ? `${parents[0].name} (${pretty(phone)})` : pretty(phone);
  for (const o of ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`)) {
    sendEmail(ctx, { to: o.email, subject: `Text from ${parents[0]?.name ?? pretty(phone)}`, text: `${who} texted:\n\n${body}\n\nTexts can't be answered from the app yet. Reply by phone or email.` }).catch(() => {});
  }
  return null;
}
