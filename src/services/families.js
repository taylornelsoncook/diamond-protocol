import { randomInt } from 'node:crypto';
import { newId, token, sha256, v, notFound, badRequest, conflict, HttpError, addDays, safeEqual } from '../util.js';
import { emit } from './events.js';
import { sendEmail, willDeliver } from './mail.js';

// ---------- Settings (waiver text, cancellation window, time zone) ----------
const DEFAULTS = {
  timezone: process.env.BUSINESS_TZ || 'America/Chicago',
  late_cancel_hours: '12',
  waiver_version: '1',
  waiver_text: '[Your waiver text goes here. Have a lawyer write the release of liability, medical consent and photo policy for your business.]',
  business_name: 'Diamond Protocol',
  share_results: 'reviewed',
  business_address: '',
  payment_instructions: 'Pay online with the link on this invoice, or mail a check payable to Diamond Protocol.',
  // Placeholders start with "[" and count as not yet published; parents aren't asked to accept them.
  terms_text: '[Your terms of service go here. Have a lawyer write them: what you provide, payment terms, cancellations, refunds and closing an account.]',
  terms_version: '1',
  terms_updated: '',
  privacy_text: '[Your privacy policy goes here. Have a lawyer write it: what you collect, why, who can see it, how long you keep it, and how a parent can get a copy or have it deleted.]',
  privacy_version: '1',
  privacy_updated: '',
  public_signup: 'on',
  rankings: 'off',                        // athletes and parents see where a best result ranks (no names); coaches turn it on
  emails_off: '',                         // comma list of automatic emails turned off: welcome, receipts, trial_ending, payment_failed
  texts_off: '',                          // comma list of automatic texts turned off: reminder, waitlist, canceled, payment_failed
  weekly_digest: 'on',                    // Monday summary email to the owners
  lead_follow_up: 'on',                   // automatic follow-up emails (and texts, if they asked) to new leads
  public_schedule: 'on',                  // the public Book now page (/book) and website widget
  review_url: '',                         // Google review link; review requests stay off until it's set
  review_requests: 'on'                   // ask happy families for a review after a 10th session or a personal best
};
export function getSetting(ctx, key) { return ctx.db.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? DEFAULTS[key]; }
export function getSettings(ctx) { return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, getSetting(ctx, k)])); }
export function updateSettings(ctx, body) {
  const cur = getSettings(ctx);
  const next = {};
  if (body.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }); } catch { throw badRequest('timezone must be a time zone like America/Chicago.'); }
    next.timezone = body.timezone;
  }
  if (body.late_cancel_hours !== undefined) next.late_cancel_hours = String(v.int(body.late_cancel_hours, 'late_cancel_hours', { min: 0, max: 168 }));
  if (body.business_name !== undefined) next.business_name = v.str(body.business_name, 'business_name', { max: 80 });
  if (body.share_results !== undefined) next.share_results = v.oneOf(body.share_results, 'share_results', ['reviewed', 'all']);
  if (body.business_address !== undefined) next.business_address = v.str(body.business_address, 'business_address', { max: 400, optional: true }) ?? '';
  if (body.payment_instructions !== undefined) next.payment_instructions = v.str(body.payment_instructions, 'payment_instructions', { max: 1000, optional: true }) ?? '';
  if (body.waiver_text !== undefined) {
    const text = v.str(body.waiver_text, 'waiver_text', { max: 20000 });
    if (text !== cur.waiver_text) { next.waiver_text = text; next.waiver_version = String(Number(cur.waiver_version) + 1); }   // families re-sign a changed waiver
  }
  for (const kind of ['terms', 'privacy']) {
    if (body[`${kind}_text`] === undefined) continue;
    const text = v.str(body[`${kind}_text`], `${kind}_text`, { max: 100000 });
    if (text !== cur[`${kind}_text`]) { next[`${kind}_text`] = text; next[`${kind}_version`] = String(Number(cur[`${kind}_version`]) + 1); next[`${kind}_updated`] = ctx.now().slice(0, 10); }   // parents accept a changed version
  }
  if (body.rankings !== undefined) next.rankings = body.rankings === true || body.rankings === 'on' ? 'on' : 'off';
  if (body.review_url !== undefined) {
    const url = v.str(body.review_url, 'review_url', { max: 500, optional: true }) ?? '';
    if (url && !/^https:\/\/\S+$/.test(url)) throw badRequest('Paste the full review link from your Google Business Profile. It starts with https://');
    next.review_url = url;
  }
  if (body.review_requests !== undefined) next.review_requests = body.review_requests === true || body.review_requests === 'on' ? 'on' : 'off';
  if (body.public_schedule !== undefined) next.public_schedule = body.public_schedule === true || body.public_schedule === 'on' ? 'on' : 'off';
  if (body.lead_follow_up !== undefined) next.lead_follow_up = body.lead_follow_up === true || body.lead_follow_up === 'on' ? 'on' : 'off';
  if (body.weekly_digest !== undefined) next.weekly_digest = body.weekly_digest === true || body.weekly_digest === 'on' ? 'on' : 'off';
  if (body.public_signup !== undefined) next.public_signup = body.public_signup === true || body.public_signup === 'on' ? 'on' : 'off';
  if (body.emails_off !== undefined) {
    const list = (Array.isArray(body.emails_off) ? body.emails_off : String(body.emails_off).split(',')).map((x) => String(x).trim()).filter(Boolean);
    for (const x of list) v.oneOf(x, 'emails_off', ['welcome', 'receipts', 'trial_ending', 'payment_failed']);
    next.emails_off = [...new Set(list)].join(',');
  }
  if (body.texts_off !== undefined) {
    const list = (Array.isArray(body.texts_off) ? body.texts_off : String(body.texts_off).split(',')).map((x) => String(x).trim()).filter(Boolean);
    for (const x of list) v.oneOf(x, 'texts_off', ['reminder', 'waitlist', 'canceled', 'payment_failed']);
    next.texts_off = [...new Set(list)].join(',');
  }
  for (const [k, val] of Object.entries(next)) ctx.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, val);
  return getSettings(ctx);
}

// ---------- Families, guardians, athletes ----------
function guardianInput(g) {
  return { name: v.str(g?.name, 'parent name', { max: 120 }), email: v.email(g?.email, 'parent email'), phone: v.str(g?.phone, 'parent phone', { max: 40, optional: true }), relationship: v.str(g?.relationship, 'relationship', { max: 40, optional: true }) };
}
export function createFamilyWithGuardian(ctx, guardian, familyName) {
  const g = guardianInput(guardian);
  if (ctx.db.get('SELECT id FROM guardians WHERE email = ?', g.email)) throw conflict(`A parent with ${g.email} already has an account. Add the athlete to that family instead.`);
  const familyId = newId('fam');
  const last = g.name.trim().split(/\s+/).pop();
  ctx.db.run('INSERT INTO families (id, name, created_at) VALUES (?, ?, ?)', familyId, v.str(familyName, 'family name', { max: 120, optional: true }) ?? `${last} family`, ctx.now());
  ctx.db.run('INSERT INTO guardians (id, family_id, name, email, phone, relationship, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', newId('gdn'), familyId, g.name, g.email, g.phone, g.relationship, ctx.now());
  return familyId;
}
export function listFamilies(ctx) {
  return ctx.db.all(`SELECT f.id, f.name, f.card_last4, f.card_brand, f.waiver_version, f.waiver_signed_at,
      (SELECT GROUP_CONCAT(name, ', ') FROM guardians g WHERE g.family_id = f.id) AS guardians,
      (SELECT GROUP_CONCAT(name, ', ') FROM clients c WHERE c.family_id = f.id) AS athletes
    FROM families f ORDER BY f.name`).map((f) => ({ ...f, waiver_current: Number(f.waiver_version) === Number(getSetting(ctx, 'waiver_version')) }));
}
export function getFamily(ctx, id) {
  const f = ctx.db.get('SELECT * FROM families WHERE id = ?', id);
  if (!f) throw notFound('Family');
  return {
    id: f.id, name: f.name, created_at: f.created_at,
    card: f.card_payment_method ? { on_file: true, brand: f.card_brand, last4: f.card_last4 } : { on_file: false },
    waiver: { signed: Number(f.waiver_version) === Number(getSetting(ctx, 'waiver_version')), signed_by: f.waiver_signed_by, signed_at: f.waiver_signed_at, version_signed: f.waiver_version },
    guardians: ctx.db.all('SELECT id, name, email, phone, relationship, is_primary, sms_opt_in_at, sms_opt_out_at FROM guardians WHERE family_id = ? ORDER BY is_primary DESC, created_at', id)
      .map(({ sms_opt_in_at, sms_opt_out_at, ...g }) => ({ ...g, is_primary: !!g.is_primary, texts: !sms_opt_in_at ? 'off' : sms_opt_out_at ? 'stopped' : 'on' })),
    athlete_ids: ctx.db.all('SELECT id FROM clients WHERE family_id = ? ORDER BY name', id).map((r) => r.id)
  };
}
export function updateFamily(ctx, id, body) {
  getFamily(ctx, id);
  if (body.name !== undefined) ctx.db.run('UPDATE families SET name = ? WHERE id = ?', v.str(body.name, 'name', { max: 120 }), id);
  if (body.card_status !== undefined) {
    if (!ctx.testMode) throw conflict('card_status can only be changed in test mode.');
    ctx.db.run('UPDATE families SET card_status = ? WHERE id = ?', v.oneOf(body.card_status, 'card_status', ['ok', 'declining']), id);
  }
  return getFamily(ctx, id);
}
export function addGuardian(ctx, familyId, body) {
  getFamily(ctx, familyId);
  const g = guardianInput(body);
  if (ctx.db.get('SELECT id FROM guardians WHERE email = ?', g.email)) throw conflict(`${g.email} already belongs to a parent account.`);
  const id = newId('gdn');
  ctx.db.run('INSERT INTO guardians (id, family_id, name, email, phone, relationship, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', id, familyId, g.name, g.email, g.phone, g.relationship, ctx.now());
  return getFamily(ctx, familyId);
}
export function removeGuardian(ctx, familyId, guardianId) {
  const f = getFamily(ctx, familyId);
  if (!f.guardians.some((g) => g.id === guardianId)) throw notFound('Parent');
  if (f.guardians.length === 1) throw conflict('A family needs at least one parent.');
  ctx.db.run('DELETE FROM guardians WHERE id = ?', guardianId);
  if (f.guardians.find((g) => g.id === guardianId).is_primary) ctx.db.run('UPDATE guardians SET is_primary = 1 WHERE id = (SELECT id FROM guardians WHERE family_id = ? ORDER BY created_at LIMIT 1)', familyId);
  return getFamily(ctx, familyId);
}

// Athlete profile fields, shared by the coach dashboard and the parent portal.
export function athleteFields(body, cur = {}) {
  const pick = (k, fn) => (body[k] !== undefined ? fn(body[k]) : cur[k] ?? null);
  return {
    sex: pick('sex', (x) => (x === null || x === '' ? null : v.oneOf(String(x).toUpperCase()[0], 'sex', ['M', 'F']))),
    birth_date: pick('birth_date', (x) => { const d = v.str(x, 'birth_date', { max: 10, optional: true }); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw badRequest('birth_date must look like 2012-04-30.'); return d; }),
    sport: pick('sport', (x) => v.str(x, 'sport', { max: 60, optional: true })),
    position: pick('position', (x) => v.str(x, 'position', { max: 60, optional: true })),
    school: pick('school', (x) => v.str(x, 'school', { max: 120, optional: true })),
    grad_year: pick('grad_year', (x) => v.int(x, 'grad_year', { min: 2000, max: 2060, optional: true })),
    medical_notes: pick('medical_notes', (x) => v.str(x, 'medical_notes', { max: 2000, optional: true })),
    emergency_name: pick('emergency_name', (x) => v.str(x, 'emergency_name', { max: 120, optional: true })),
    emergency_phone: pick('emergency_phone', (x) => v.str(x, 'emergency_phone', { max: 40, optional: true }))
  };
}

// Who pays for a client: their family when they have one, otherwise themselves.
export function payerFor(ctx, clientId) {
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Client');
  if (c.family_id) {
    const f = ctx.db.get('SELECT * FROM families WHERE id = ?', c.family_id);
    const g = ctx.db.get('SELECT name, email FROM guardians WHERE family_id = ? ORDER BY is_primary DESC, created_at LIMIT 1', f.id);
    return { table: 'families', id: f.id, name: g?.name ?? f.name, email: g?.email ?? null, metadataKey: 'family_id', stripe_customer_id: f.stripe_customer_id, card_payment_method: f.card_payment_method, card_brand: f.card_brand, card_last4: f.card_last4, card_status: f.card_status };
  }
  return { table: 'clients', id: c.id, name: c.name, email: c.email, metadataKey: 'client_id', stripe_customer_id: c.stripe_customer_id, card_payment_method: c.card_payment_method, card_brand: c.card_brand, card_last4: c.card_last4, card_status: c.card_status };
}

// ---------- Waiver ----------
export function signWaiver(ctx, familyId, guardian, body) {
  if (body.agree !== true) throw badRequest('Check the box to agree to the waiver.');
  const typed = v.str(body.signed_name, 'signed_name', { max: 120 });
  if (typed.toLowerCase().replace(/\s+/g, ' ') !== guardian.name.toLowerCase().replace(/\s+/g, ' ')) throw badRequest(`Type your full name exactly as it appears on your account: ${guardian.name}.`);
  const version = Number(getSetting(ctx, 'waiver_version'));
  ctx.db.run('UPDATE families SET waiver_version = ?, waiver_signed_by = ?, waiver_signed_at = ? WHERE id = ?', version, `${guardian.name} <${guardian.email}>`, ctx.now(), familyId);
  emit(ctx, 'family.waiver_signed', { family_id: familyId, guardian_name: guardian.name, version });
  return getFamily(ctx, familyId).waiver;
}

// ---------- Parent sign-in with emailed codes ----------
const CODE_MINUTES = 10, MAX_ATTEMPTS = 5, SESSION_DAYS = 30;

export async function requestCode(ctx, body) {
  const email = v.email(body.email);
  const g = ctx.db.get('SELECT * FROM guardians WHERE email = ?', email);
  // Same response whether or not the email has an account, so the form can't be used to look people up.
  const out = { ok: true, message: 'If that email has an account, a sign-in code is on its way.' };
  if (!g) return out;
  const recent = ctx.db.get('SELECT COUNT(*) AS n FROM login_codes WHERE guardian_id = ? AND expires_at > ?', g.id, new Date().toISOString());   // codes issued in the last 10 minutes
  if (recent.n >= 3) return out;                                         // at most 3 codes per 10 minutes
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  ctx.db.run('INSERT INTO login_codes (id, guardian_id, code_hash, expires_at) VALUES (?, ?, ?, ?)', newId('lc'), g.id, sha256(`${g.id}:${code}`), new Date(Date.now() + CODE_MINUTES * 60000).toISOString());
  await sendEmail(ctx, { to: g.email, subject: `Your ${getSetting(ctx, 'business_name')} sign-in code: ${code}`, text: `Your sign-in code is ${code}. It expires in ${CODE_MINUTES} minutes.\n\nIf you didn't ask for this, you can ignore this email.` });
  if (ctx.testMode && !willDeliver(ctx, g.email)) out.dev_code = code; // test mode and the email won't really arrive: show the code so you can sign in
  return out;
}
export function verifyCode(ctx, body) {
  const email = v.email(body.email);
  const code = v.str(body.code, 'code', { max: 12 }).replace(/\s/g, '');
  const g = ctx.db.get('SELECT * FROM guardians WHERE email = ?', email);
  const wrong = new HttpError(401, 'invalid_code', 'That code is wrong or has expired. Request a new one.');
  if (!g) throw wrong;
  const lc = ctx.db.get('SELECT * FROM login_codes WHERE guardian_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1', g.id, new Date().toISOString());
  if (!lc || lc.attempts >= MAX_ATTEMPTS) throw wrong;
  if (!safeEqual(lc.code_hash, sha256(`${g.id}:${code}`))) { ctx.db.run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', lc.id); throw wrong; }
  ctx.db.run('UPDATE login_codes SET used_at = ? WHERE id = ?', ctx.now(), lc.id);
  const raw = `dp_fam_${token(32)}`;
  ctx.db.run('INSERT INTO portal_sessions (token_hash, guardian_id, expires_at) VALUES (?, ?, ?)', sha256(raw), g.id, addDays(ctx.now(), SESSION_DAYS));
  return { token: raw, maxAge: SESSION_DAYS * 86400, guardian: { id: g.id, name: g.name, email: g.email } };
}
export function guardianForToken(ctx, raw) {
  if (!raw) return null;
  return ctx.db.get('SELECT g.* FROM portal_sessions s JOIN guardians g ON g.id = s.guardian_id WHERE s.token_hash = ? AND s.expires_at > ?', sha256(raw), ctx.now()) ?? null;
}
export function portalLogout(ctx, raw) { if (raw) ctx.db.run('DELETE FROM portal_sessions WHERE token_hash = ?', sha256(raw)); }
