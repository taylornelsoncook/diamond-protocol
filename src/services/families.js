import { randomInt } from 'node:crypto';
import { newId, token, sha256, v, notFound, badRequest, conflict, HttpError, addDays, safeEqual, hashPassword, verifyPassword } from '../util.js';
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
  readiness_adjust: 'on',                 // lighter weights in the athlete app after a rough daily check-in
  readiness_wearable: 'on',               // ...and after a rough night the athlete's wearable saw (recovery, sleep, HRV from athlete_metrics)
  readiness_yellow_drop: '10',            // points of the tested max taken off on a "go a little lighter" day (0 to 40)
  readiness_red_drop: '20',               // ...and on a "take it easy" day (0 to 50)
  readiness_red_sets: '1',                // sets taken off each exercise on a "take it easy" day (0 to 3)
  readiness_recovery_yellow: '50',        // a wearable recovery or readiness score under this is a reason to go lighter (1 to 99)...
  readiness_recovery_red: '34',           // ...and under this, an easy day on its own (1 to 99, below the yellow one)
  readiness_sleep_yellow_min: '360',      // wearable sleep under this many minutes is a reason (6 hours)...
  readiness_sleep_red_min: '300',         // ...and under this, an easy day on its own (5 hours)
  readiness_hrv_drop_pct: '20',           // HRV this many percent under the athlete's 30-day average is a reason (5 to 60; 0 = ignore HRV)
  progression_mode: 'suggest',            // after two workouts hitting every set at the top of the range: suggest a step to the coach, auto (approve at once) or off
  adapt_mode: 'suggest',                  // the adaptive plan (version 69): suggest to the coach, auto (applied at once) or off
  adapt_minimum_streak: '3',              // misses in a row that make the rest of the week a minimum week (2 to 6)
  auto_program: 'auto',                   // the start-up questions (version 67): auto puts the athlete on the matching program at once, review waits for a coach on Today, off asks nothing of the rules
  progression_upper_lb: '5',              // the step for an upper-body (or uncategorized) exercise lifted with a weight...
  progression_lower_lb: '10',             // ...and for lower body and power exercises
  emails_off: '',                         // comma list of automatic emails turned off: welcome, receipts, trial_ending, payment_failed
  texts_off: '',                          // comma list of automatic texts turned off: reminder, waitlist, canceled, payment_failed
  weekly_digest: 'on',                    // Monday summary email to the owners
  monthly_reports: 'review',              // monthly parent reports: review (coaches send), auto (sent on the 1st), off
  lead_follow_up: 'on',                   // automatic follow-up emails (and texts, if they asked) to new leads
  public_schedule: 'on',                  // the public Book now page (/book) and website widget
  review_url: '',                         // Google review link; review requests stay off until it's set
  review_requests: 'on',                  // ask happy families for a review after a 10th session or a personal best
  staff_discount_max_pct: '0',            // the biggest discount coaches and front desk may give at the counter, as a percent of the sale. Owner decision: 0 (only the owner gives discounts)
  payment_lock_tries: '4',                // lock a family out (but for fixing the card) once a membership payment declined on this many automatic tries; owner decision: 4 = the first charge and 3 retries; 0 = never (lockout.js)
  open_spot_offers: 'suggest',            // light classes: 'suggest' shows them on Today to send offers by hand, 'auto' sends them, 'off' hides them
  card_fee_pct: '0',                      // a card processing fee passed to the payer (services/fees.js): percent of the amount (0 to 4, tenths)...
  card_fee_flat: '0',                     // ...plus a flat amount in whole cents (0 to 100; not named _cents so the counter, which staff run, can read it)...
  card_fee_label: 'Card processing fee',  // ...shown as its own line under this name...
  card_fee_on: '',                        // ...on these card payments: a comma list of memberships, counter, pay_links, store (empty = off everywhere, the default)
  form_check_keep_days: '90'              // how long an athlete's form-check clip is kept in the private bucket (30 to 365 days; services/formchecks.js)
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
  if (body.readiness_wearable !== undefined) next.readiness_wearable = body.readiness_wearable === true || body.readiness_wearable === 'on' ? 'on' : 'off';
  if (body.readiness_yellow_drop !== undefined) next.readiness_yellow_drop = String(v.int(body.readiness_yellow_drop, 'readiness_yellow_drop', { min: 0, max: 40 }));
  if (body.readiness_red_drop !== undefined) next.readiness_red_drop = String(v.int(body.readiness_red_drop, 'readiness_red_drop', { min: 0, max: 50 }));
  if (body.readiness_red_sets !== undefined) next.readiness_red_sets = String(v.int(body.readiness_red_sets, 'readiness_red_sets', { min: 0, max: 3 }));
  if (body.readiness_recovery_yellow !== undefined) next.readiness_recovery_yellow = String(v.int(body.readiness_recovery_yellow, 'readiness_recovery_yellow', { min: 1, max: 99 }));
  if (body.readiness_recovery_red !== undefined) next.readiness_recovery_red = String(v.int(body.readiness_recovery_red, 'readiness_recovery_red', { min: 1, max: 99 }));
  if (Number(next.readiness_recovery_red ?? cur.readiness_recovery_red) >= Number(next.readiness_recovery_yellow ?? cur.readiness_recovery_yellow)) throw badRequest('The easy-day recovery score has to be below the lighter-day one.');
  if (body.readiness_sleep_yellow_min !== undefined) next.readiness_sleep_yellow_min = String(v.int(body.readiness_sleep_yellow_min, 'readiness_sleep_yellow_min', { min: 60, max: 720 }));
  if (body.readiness_sleep_red_min !== undefined) next.readiness_sleep_red_min = String(v.int(body.readiness_sleep_red_min, 'readiness_sleep_red_min', { min: 60, max: 720 }));
  if (Number(next.readiness_sleep_red_min ?? cur.readiness_sleep_red_min) >= Number(next.readiness_sleep_yellow_min ?? cur.readiness_sleep_yellow_min)) throw badRequest('The easy-day sleep has to be shorter than the lighter-day sleep.');
  if (body.readiness_hrv_drop_pct !== undefined) { const n = v.int(body.readiness_hrv_drop_pct, 'readiness_hrv_drop_pct', { min: 0, max: 60 }); if (n && n < 5) throw badRequest('The HRV drop is 5 to 60 percent, or 0 to ignore HRV.'); next.readiness_hrv_drop_pct = String(n); }
  if (body.progression_mode !== undefined) next.progression_mode = v.oneOf(String(body.progression_mode), 'progression_mode', ['suggest', 'auto', 'off']);
  if (body.auto_program !== undefined) next.auto_program = v.oneOf(String(body.auto_program), 'auto_program', ['auto', 'review', 'off']);
  if (body.adapt_mode !== undefined) next.adapt_mode = v.oneOf(String(body.adapt_mode), 'adapt_mode', ['suggest', 'auto', 'off']);
  if (body.adapt_minimum_streak !== undefined) next.adapt_minimum_streak = String(v.int(body.adapt_minimum_streak, 'adapt_minimum_streak', { min: 2, max: 6 }));
  if (body.progression_upper_lb !== undefined) next.progression_upper_lb = String(v.int(body.progression_upper_lb, 'progression_upper_lb', { min: 1, max: 50 }));
  if (body.progression_lower_lb !== undefined) next.progression_lower_lb = String(v.int(body.progression_lower_lb, 'progression_lower_lb', { min: 1, max: 50 }));
  if (body.readiness_adjust !== undefined) next.readiness_adjust = body.readiness_adjust === true || body.readiness_adjust === 'on' ? 'on' : 'off';
  if (body.rankings !== undefined) next.rankings = body.rankings === true || body.rankings === 'on' ? 'on' : 'off';
  if (body.review_url !== undefined) {
    const url = v.str(body.review_url, 'review_url', { max: 500, optional: true }) ?? '';
    if (url && !/^https:\/\/\S+$/.test(url)) throw badRequest('Paste the full review link from your Google Business Profile. It starts with https://');
    next.review_url = url;
  }
  if (body.review_requests !== undefined) next.review_requests = body.review_requests === true || body.review_requests === 'on' ? 'on' : 'off';
  if (body.public_schedule !== undefined) next.public_schedule = body.public_schedule === true || body.public_schedule === 'on' ? 'on' : 'off';
  if (body.open_spot_offers !== undefined) next.open_spot_offers = v.oneOf(body.open_spot_offers, 'open_spot_offers', ['off', 'suggest', 'auto']);
  if (body.payment_lock_tries !== undefined) next.payment_lock_tries = String(v.int(body.payment_lock_tries, 'payment_lock_tries', { min: 0, max: 4 }));
  if (body.staff_discount_max_pct !== undefined) next.staff_discount_max_pct = String(v.int(body.staff_discount_max_pct, 'staff_discount_max_pct', { min: 0, max: 100 }));
  if (body.card_fee_pct !== undefined) {
    const n = Number(body.card_fee_pct);
    if (!Number.isFinite(n) || n < 0 || n > 4 || Math.round(n * 10) !== n * 10) throw badRequest('Enter the card fee percent from 0 to 4, in tenths (like 2.9).');
    next.card_fee_pct = String(n);
  }
  if (body.form_check_keep_days !== undefined) next.form_check_keep_days = String(v.int(body.form_check_keep_days, 'form_check_keep_days', { min: 30, max: 365 }));
  if (body.card_fee_flat !== undefined) next.card_fee_flat = String(v.int(body.card_fee_flat, 'card_fee_flat', { min: 0, max: 100 }));
  if (body.card_fee_label !== undefined) next.card_fee_label = v.str(body.card_fee_label, 'card_fee_label', { max: 40, optional: true }) ?? 'Card processing fee';
  if (body.card_fee_on !== undefined) {
    const list = (Array.isArray(body.card_fee_on) ? body.card_fee_on : String(body.card_fee_on).split(',')).map((x) => String(x).trim()).filter(Boolean);
    for (const x of list) v.oneOf(x, 'card_fee_on', ['memberships', 'counter', 'pay_links', 'store']);
    next.card_fee_on = [...new Set(list)].join(',');
  }
  if (body.lead_follow_up !== undefined) next.lead_follow_up = body.lead_follow_up === true || body.lead_follow_up === 'on' ? 'on' : 'off';
  if (body.weekly_digest !== undefined) next.weekly_digest = body.weekly_digest === true || body.weekly_digest === 'on' ? 'on' : 'off';
  if (body.monthly_reports !== undefined) next.monthly_reports = v.oneOf(body.monthly_reports, 'monthly_reports', ['review', 'auto', 'off']);
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
// A card expiring: expired once its month is over, expiring in its last month and the month before (a card is good
// through the last day of its month). Months are compared in UTC; a day either way doesn't matter for a reminder.
export function cardExpiry(exp, now = new Date().toISOString()) {
  if (!/^\d{4}-\d{2}$/.test(exp ?? '')) return { expired: false, expiring: false };
  const cur = now.slice(0, 7), [y, m] = cur.split('-').map(Number), next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { expired: exp < cur, expiring: exp >= cur && exp <= next };
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
    card: f.card_payment_method ? { on_file: true, brand: f.card_brand, last4: f.card_last4, exp: f.card_exp ?? null, ...cardExpiry(f.card_exp) } : { on_file: false },
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
  // Their portal sign-in ends at once (sessions and codes go with them).
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM portal_sessions WHERE guardian_id = ?', guardianId);
    ctx.db.run('DELETE FROM login_codes WHERE guardian_id = ?', guardianId);
    ctx.db.run('DELETE FROM guardians WHERE id = ?', guardianId);
    if (f.guardians.find((g) => g.id === guardianId).is_primary) ctx.db.run('UPDATE guardians SET is_primary = 1 WHERE id = (SELECT id FROM guardians WHERE family_id = ? ORDER BY created_at LIMIT 1)', familyId);
  });
  return getFamily(ctx, familyId);
}
// Fix a parent's name, email, phone or relationship (a typo in the email is the usual reason a parent can't sign in).
// An athlete in the family who used the same email (an adult who trains and pays) keeps it in step. A new phone
// number hasn't agreed to texts, so texts turn off until the parent turns them on again in the portal.
const last10 = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);
export function updateGuardian(ctx, familyId, guardianId, body) {
  getFamily(ctx, familyId);
  const g = ctx.db.get('SELECT * FROM guardians WHERE id = ? AND family_id = ?', guardianId, familyId);
  if (!g) throw notFound('Parent');
  if (!['name', 'email', 'phone', 'relationship'].some((k) => body[k] !== undefined)) throw badRequest('Send name, email, phone or relationship.');
  const name = body.name !== undefined ? v.str(body.name, 'parent name', { max: 120 }) : g.name;
  const email = body.email !== undefined ? v.email(body.email, 'parent email') : g.email;
  const phone = body.phone !== undefined ? v.str(body.phone, 'parent phone', { max: 40, optional: true }) : g.phone;
  const relationship = body.relationship !== undefined ? v.str(body.relationship, 'relationship', { max: 40, optional: true }) : g.relationship;
  const emailChanged = email.toLowerCase() !== g.email.toLowerCase();
  if (emailChanged && ctx.db.get('SELECT id FROM guardians WHERE email = ? AND id != ?', email, guardianId)) throw conflict(`${email} already belongs to another parent account.`);
  const sameEmailKids = emailChanged ? ctx.db.all('SELECT id FROM clients WHERE family_id = ? AND email = ?', familyId, g.email).map((c) => c.id) : [];
  if (sameEmailKids.length && ctx.db.get(`SELECT id FROM clients WHERE email = ? AND id NOT IN (${sameEmailKids.map(() => '?').join(',')})`, email, ...sameEmailKids)) throw conflict(`${email} already belongs to a client.`);
  const phoneChanged = last10(phone) !== last10(g.phone);
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE guardians SET name = ?, email = ?, phone = ?, relationship = ?, sms_opt_in_at = CASE WHEN ? THEN NULL ELSE sms_opt_in_at END WHERE id = ?`, name, email, phone, relationship, phoneChanged ? 1 : 0, guardianId);
    for (const id of sameEmailKids) ctx.db.run('UPDATE clients SET email = ? WHERE id = ?', email, id);
    // A new sign-in address: whoever signed in or got a code through the old one (often a typo, someone else's inbox) is signed out.
    if (emailChanged) { ctx.db.run('DELETE FROM portal_sessions WHERE guardian_id = ?', guardianId); ctx.db.run('DELETE FROM login_codes WHERE guardian_id = ?', guardianId); }
  });
  return { ...getFamily(ctx, familyId), texts_turned_off: phoneChanged && !!g.sms_opt_in_at && !g.sms_opt_out_at };
}
// The family signed the waiver on paper at the desk: record who signed it, against the current version.
export function recordPaperWaiver(ctx, familyId, body, actor) {
  const f = getFamily(ctx, familyId);
  if (f.waiver.signed) throw conflict('The current waiver is already signed.');
  const signer = v.str(body.signed_by, 'signed_by', { max: 120 });
  const version = Number(getSetting(ctx, 'waiver_version'));
  ctx.db.run('UPDATE families SET waiver_version = ?, waiver_signed_by = ?, waiver_signed_at = ? WHERE id = ?', version, `${signer} (on paper, recorded by ${actor?.name ?? 'staff'})`, ctx.now(), familyId);
  emit(ctx, 'family.waiver_signed', { family_id: familyId, guardian_name: `${signer} (on paper)`, version, paper: true });
  return getFamily(ctx, familyId);
}

// A birthday has to be a real date (no February 30th), not in the future and not before 1900.
function birthDate(x) {
  const d = v.str(x, 'birth_date', { max: 10, optional: true });
  if (!d) return null;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
  if (!ok) throw badRequest(`"${d}" isn't a real date. Enter the birthday like 2012-04-30.`);
  if (d > new Date(Date.now() + 14 * 3600000).toISOString().slice(0, 10)) throw badRequest('That birthday is in the future. Check the year.');
  if (d < '1900-01-01') throw badRequest('That birthday is too long ago. Check the year.');
  return d;
}
// Athlete profile fields, shared by the coach dashboard and the parent portal.
export function athleteFields(body, cur = {}) {
  const pick = (k, fn) => (body[k] !== undefined ? fn(body[k]) : cur[k] ?? null);
  return {
    sex: pick('sex', (x) => (x === null || x === '' ? null : v.oneOf(String(x).toUpperCase()[0], 'sex', ['M', 'F']))),
    birth_date: pick('birth_date', birthDate),
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
    return { table: 'families', id: f.id, name: g?.name ?? f.name, email: g?.email ?? null, metadataKey: 'family_id', stripe_customer_id: f.stripe_customer_id, card_payment_method: f.card_payment_method, card_brand: f.card_brand, card_last4: f.card_last4, card_exp: f.card_exp, card_status: f.card_status };
  }
  return { table: 'clients', id: c.id, name: c.name, email: c.email, metadataKey: 'client_id', stripe_customer_id: c.stripe_customer_id, card_payment_method: c.card_payment_method, card_brand: c.card_brand, card_last4: c.card_last4, card_exp: c.card_exp, card_status: c.card_status };
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

// ---------- Portal sign-in: parents and athletes, with an emailed code or an optional password ----------
// One sign-in page (/portal) for everyone in a family. An email on file signs in as the parent it belongs to, as the
// athlete whose own address it is, or as both when one person is both (an adult training for themselves). A 6-digit
// code emailed to the address always works; a password is optional and set inside the portal.
const CODE_MINUTES = 10, MAX_ATTEMPTS = 5, SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;

// Who an email belongs to: { guardian, client } (either may be missing). Archived and deleted athletes can't sign in.
export function whoSignsIn(ctx, email) {
  const guardian = ctx.db.get('SELECT * FROM guardians WHERE email = ?', email) ?? null;
  const client = ctx.db.get(`SELECT * FROM clients WHERE email = ? AND archived_at IS NULL AND name != 'Deleted athlete'`, email) ?? null;
  return { guardian, client };
}
const hasSomeone = (who) => !!(who.guardian || who.client);

export async function requestCode(ctx, body) {
  const email = v.email(body.email);
  const who = whoSignsIn(ctx, email);
  // Same response whether or not the email has an account, so the form can't be used to look people up.
  const out = { ok: true, message: 'If that email has an account, a sign-in code is on its way.' };
  if (!hasSomeone(who)) return out;
  const recent = ctx.db.get('SELECT COUNT(*) AS n FROM login_codes WHERE (guardian_id = ? OR client_id = ?) AND expires_at > ?', who.guardian?.id ?? '', who.client?.id ?? '', new Date().toISOString());   // codes issued in the last 10 minutes
  if (recent.n >= 3) return out;                                         // at most 3 codes per 10 minutes
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  ctx.db.run('INSERT INTO login_codes (id, guardian_id, client_id, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)', newId('lc'), who.guardian?.id ?? null, who.client?.id ?? null, sha256(`${email.toLowerCase()}:${code}`), new Date(Date.now() + CODE_MINUTES * 60000).toISOString());
  await sendEmail(ctx, { to: email, subject: `Your ${getSetting(ctx, 'business_name')} sign-in code: ${code}`, text: `Your sign-in code is ${code}. It expires in ${CODE_MINUTES} minutes.\n\nIf you didn't ask for this, you can ignore this email.` });
  if (ctx.testMode && !willDeliver(ctx, email)) out.dev_code = code; // test mode and the email won't really arrive: show the code so you can sign in
  return out;
}
// 15 wrong codes or passwords in an hour for one email lock that email's sign-in for the rest of the hour. Counted by
// the address typed, whether or not it has an account, so a wrong code, "too many tries" and the lock answer the same
// for every email (the form can't be used to find out who has an account). Kept in memory, like the other rate limits.
export const LOCK_WRONG_CODES = 15;
const wrongCodes = new Map();
const lockKey = (email) => sha256(`portal-lock:${String(email).toLowerCase()}`);
function signInLocked(email) {
  const k = lockKey(email), now = Date.now(), list = (wrongCodes.get(k) ?? []).filter((t) => t > now - 3600000);
  wrongCodes.set(k, list);
  if (wrongCodes.size > 50000) for (const [key, l] of wrongCodes) if (!l.some((t) => t > now - 3600000)) wrongCodes.delete(key);
  return list.length >= LOCK_WRONG_CODES ? Math.max(1, Math.ceil((list[0] + 3600000 - now) / 60000)) : 0;
}
const countWrongCode = (email) => { const k = lockKey(email); wrongCodes.set(k, [...(wrongCodes.get(k) ?? []), Date.now()]); };
export const resetSignInLocks = () => wrongCodes.clear();
const lockedError = (locked) => new HttpError(429, 'signin_locked', `Too many wrong tries. For your safety, sign-in with this email is paused. Try again in ${locked} minute${locked === 1 ? '' : 's'}.`);
// A session for a parent (guardianId), an athlete (clientId) or both. ids may be a guardian id alone (older callers).
export function startPortalSession(ctx, ids, { userAgent } = {}) {
  const { guardianId = null, clientId = null } = typeof ids === 'string' ? { guardianId: ids } : ids;
  if (!guardianId && !clientId) throw new Error('A portal session needs a parent or an athlete.');
  const raw = `dp_fam_${token(32)}`;
  ctx.db.run('INSERT INTO portal_sessions (token_hash, guardian_id, client_id, expires_at, created_at, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(raw), guardianId, clientId, addDays(ctx.now(), SESSION_DAYS), ctx.now(), userAgent ? String(userAgent).slice(0, 300) : null, ctx.now());
  ctx.db.run('DELETE FROM portal_sessions WHERE expires_at < ?', ctx.now());
  return raw;
}
const signedIn = (ctx, who, meta) => {
  const raw = startPortalSession(ctx, { guardianId: who.guardian?.id, clientId: who.client?.id }, meta);
  const person = who.guardian ?? who.client;
  return { token: raw, maxAge: SESSION_DAYS * 86400, guardian: who.guardian ? { id: who.guardian.id, name: who.guardian.name, email: who.guardian.email } : null,
    athlete: who.client ? { id: who.client.id, name: who.client.name } : null, name: person.name, kind: sessionKind(who) };
};
export const sessionKind = (who) => (who.guardian && who.client ? 'both' : who.guardian ? 'parent' : 'athlete');
export function verifyCode(ctx, body, { userAgent } = {}) {
  const email = v.email(body.email);
  const code = v.str(body.code, 'code', { max: 12 }).replace(/\s/g, '');
  const locked = signInLocked(email);
  if (locked) throw lockedError(locked);
  const who = whoSignsIn(ctx, email);
  const wrong = new HttpError(401, 'invalid_code', 'That code is wrong or has expired. Request a new one.');
  if (!hasSomeone(who)) { countWrongCode(email); throw wrong; }
  const lc = ctx.db.get('SELECT * FROM login_codes WHERE (guardian_id = ? OR client_id = ?) AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1', who.guardian?.id ?? '', who.client?.id ?? '', new Date().toISOString());
  if (!lc || lc.attempts >= MAX_ATTEMPTS) { countWrongCode(email); throw wrong; }
  // Codes from before version 60 were hashed with the parent's id; both forms are checked so a code in flight during the upgrade still works.
  if (!safeEqual(lc.code_hash, sha256(`${email.toLowerCase()}:${code}`)) && !(lc.guardian_id && safeEqual(lc.code_hash, sha256(`${lc.guardian_id}:${code}`)))) {
    ctx.db.run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', lc.id); countWrongCode(email); throw wrong;
  }
  ctx.db.run('UPDATE login_codes SET used_at = ? WHERE id = ?', ctx.now(), lc.id);
  return signedIn(ctx, who, { userAgent });
}
// Email and password. The answer is the same for an unknown email, no password set and a wrong password, and a hash
// is checked either way so the timing doesn't tell them apart. Wrong tries count toward the same hourly lock as codes.
export function passwordLogin(ctx, body, { userAgent } = {}) {
  const email = v.email(body.email);
  const password = String(body.password ?? '');
  const locked = signInLocked(email);
  if (locked) throw lockedError(locked);
  const who = whoSignsIn(ctx, email);
  const stored = who.guardian?.password_hash || who.client?.password_hash || 'scrypt$00$00';
  const ok = password.length > 0 && verifyPassword(password, stored) && stored !== 'scrypt$00$00';
  if (!ok) { countWrongCode(email); throw new HttpError(401, 'invalid_login', 'That email and password don\'t match. Check them, or email yourself a sign-in code instead.'); }
  return signedIn(ctx, who, { userAgent });
}
// Set, change or remove the password of whoever is signed in (a person who is both a parent and an athlete sets one
// password for both). Being signed in (by code or password) is the proof, so no current password is asked for. The
// address is emailed so a password nobody expected is noticed.
export async function setPassword(ctx, who, body = {}) {
  const pw = v.str(body.password, 'password', { max: 200 });
  if (pw.length < MIN_PASSWORD) throw badRequest(`Use at least ${MIN_PASSWORD} characters. A short sentence works well.`);
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|password|qwertyuiop)/i.test(pw)) throw badRequest('That password is too easy to guess. Try a short sentence.');
  const hash = hashPassword(pw), now = ctx.now();
  if (who.guardian) ctx.db.run('UPDATE guardians SET password_hash = ?, password_set_at = ? WHERE id = ?', hash, now, who.guardian.id);
  if (who.client) ctx.db.run('UPDATE clients SET password_hash = ?, password_set_at = ? WHERE id = ?', hash, now, who.client.id);
  const person = who.guardian ?? who.client;
  await sendEmail(ctx, { to: person.email, subject: `Your ${getSetting(ctx, 'business_name')} portal password was ${hadPassword(who) ? 'changed' : 'set'}`,
    text: `Hi ${person.name.split(' ')[0]},\n\nA password was just ${hadPassword(who) ? 'changed' : 'set'} for signing in to the portal with ${person.email}. Emailed sign-in codes keep working too.\n\nIf this wasn't you, sign in with a code right away and change it, or tell your coach.` });
  return { ok: true, has_password: true };
}
const hadPassword = (who) => !!(who.guardian?.password_hash || who.client?.password_hash);
export function removePassword(ctx, who) {
  if (who.guardian) ctx.db.run('UPDATE guardians SET password_hash = NULL, password_set_at = NULL WHERE id = ?', who.guardian.id);
  if (who.client) ctx.db.run('UPDATE clients SET password_hash = NULL, password_set_at = NULL WHERE id = ?', who.client.id);
  return { ok: true, has_password: false };
}
// The signed-in person behind a portal cookie: { guardian, client, kind } or null. Every portal route reads this;
// the family routes want the guardian, the athlete app the client.
export function whoForToken(ctx, raw) {
  if (!raw) return null;
  const hash = sha256(raw);
  const s = ctx.db.get('SELECT * FROM portal_sessions WHERE token_hash = ? AND expires_at > ?', hash, ctx.now());
  if (!s) return null;
  const guardian = s.guardian_id ? ctx.db.get('SELECT * FROM guardians WHERE id = ?', s.guardian_id) ?? null : null;
  const client = s.client_id ? ctx.db.get(`SELECT * FROM clients WHERE id = ? AND archived_at IS NULL AND name != 'Deleted athlete'`, s.client_id) ?? null : null;
  if (!guardian && !client) return null;
  // "Last used" on the Family tab's device list, written at most every 5 minutes.
  if (!s.last_seen_at || Date.parse(ctx.now()) - Date.parse(s.last_seen_at) > 300000) ctx.db.run('UPDATE portal_sessions SET last_seen_at = ? WHERE token_hash = ?', ctx.now(), hash);
  return { guardian, client, kind: sessionKind({ guardian, client }), has_password: hadPassword({ guardian, client }) };
}
export const guardianForToken = (ctx, raw) => whoForToken(ctx, raw)?.guardian ?? null;
export const clientForPortalToken = (ctx, raw) => whoForToken(ctx, raw)?.client ?? null;
export function portalLogout(ctx, raw) { if (raw) ctx.db.run('DELETE FROM portal_sessions WHERE token_hash = ?', sha256(raw)); }
