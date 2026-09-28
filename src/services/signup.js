import { randomInt } from 'node:crypto';
import { newId, token, sha256, v, badRequest, conflict, HttpError, addDays, safeEqual, isDate } from '../util.js';
import { getSetting, createFamilyWithGuardian, startPortalSession } from './families.js';
import { createClient } from './clients.js';
import { recordConsent, published } from './legal.js';
import { sendEmail } from './mail.js';
import { welcomeFamily } from './notify.js';
import { emit } from './events.js';
import { claimCode, tryClaim, fileClaim, claimPendingText } from './profiles.js';

const CODE_MINUTES = 30, MAX_ATTEMPTS = 5, SESSION_DAYS = 30, MAX_ATHLETES = 8;

export function signupInfo(ctx) {
  return { business_name: getSetting(ctx, 'business_name'), open: getSetting(ctx, 'public_signup') === 'on',
    terms_published: published(ctx, 'terms'), privacy_published: published(ctx, 'privacy') };
}

function athleteInput(a, i) {
  const n = i + 1;
  const birth = v.str(a?.birth_date, `athlete ${n} birthday`, { max: 10 });
  if (!isDate(birth) || birth > new Date().toISOString().slice(0, 10) || birth < '1920-01-01') throw badRequest(`Athlete ${n}: enter a real birthday.`);
  return {
    name: v.str(a?.name, `athlete ${n} name`, { max: 120 }), birth_date: birth,
    sex: a?.sex ? v.oneOf(String(a.sex).toUpperCase()[0], `athlete ${n} sex`, ['M', 'F']) : undefined,
    sport: v.str(a?.sport, 'sport', { max: 60, optional: true }) ?? undefined, school: v.str(a?.school, 'school', { max: 120, optional: true }) ?? undefined,
    medical_notes: v.str(a?.medical_notes, 'medical notes', { max: 2000, optional: true }) ?? undefined,
    emergency_name: v.str(a?.emergency_name, 'emergency contact', { max: 120, optional: true }) ?? undefined,
    emergency_phone: v.str(a?.emergency_phone, 'emergency phone', { max: 40, optional: true }) ?? undefined,
    athlete_code: claimCode(a?.athlete_code) ?? undefined         // "already has a profile": their Athlete ID (profiles.js)
  };
}

// Step 1: check the details and email a code. The answer looks the same whether or not the email
// already has an account, so the form can't be used to find out who trains here.
export async function startSignup(ctx, body, ip) {
  if (getSetting(ctx, 'public_signup') !== 'on') throw new HttpError(403, 'signup_closed', 'Sign-up is closed right now. Contact us to join.');
  const out = { signup_id: newId('su'), message: 'Check your email for a 6-digit code to finish signing up.' };
  if (body.website) return out;                                                   // hidden field only bots fill in
  if (body.accept_terms !== true) throw badRequest('Please agree to the terms of service and privacy policy.');
  const parent = { name: v.str(body.parent?.name, 'your name', { max: 120 }), email: v.email(body.parent?.email, 'your email'), phone: v.str(body.parent?.phone, 'phone', { max: 40, optional: true }) ?? undefined };
  const athletes = Array.isArray(body.athletes) ? body.athletes : [];
  if (!athletes.length) throw badRequest('Add at least one athlete.');
  if (athletes.length > MAX_ATHLETES) throw badRequest(`Add up to ${MAX_ATHLETES} athletes here; add more later from the parent portal.`);
  const kids = athletes.map(athleteInput);
  const names = kids.map((k) => k.name.trim().toLowerCase().replace(/\s+/g, ' '));
  if (new Set(names).size < names.length) throw badRequest('Two athletes have the same name. Use a middle initial or nickname to tell them apart.');
  const biz = getSetting(ctx, 'business_name');
  if (ctx.db.get('SELECT id FROM guardians WHERE email = ?', parent.email)) {
    await sendEmail(ctx, { to: parent.email, subject: `You already have a ${biz} account`, text: `Someone (probably you) tried to sign up with this email, but you already have an account.\n\nSign in instead: ${ctx.publicUrl ?? ''}/parent\n\nIf this wasn't you, you can ignore this email.` });
    return out;
  }
  const recent = ctx.db.get('SELECT COUNT(*) AS n FROM signup_requests WHERE email = ? AND created_at > ?', parent.email, new Date(Date.now() - 3600000).toISOString()).n;
  if (recent >= 5) return out;
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  ctx.db.run('INSERT INTO signup_requests (id, email, payload, code_hash, ip, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    out.signup_id, parent.email, JSON.stringify({ parent, athletes: kids }), sha256(`${out.signup_id}:${code}`), ip ?? null, new Date(Date.now() + CODE_MINUTES * 60000).toISOString(), ctx.now());
  await sendEmail(ctx, { to: parent.email, subject: `Your ${biz} sign-up code: ${code}`, text: `Your code to finish signing up is ${code}. It expires in ${CODE_MINUTES} minutes.\n\nIf you didn't ask for this, you can ignore this email.` });
  if (ctx.testMode && !ctx.mail?.resendKey) out.dev_code = code;
  return out;
}

// Step 2: the code proves the email is theirs. Create the family, the athletes, record the agreements, sign them in.
export async function finishSignup(ctx, body, ip, { userAgent } = {}) {
  const id = v.str(body.signup_id, 'signup_id', { max: 60 });
  const code = v.str(body.code, 'code', { max: 12 }).replace(/\s/g, '');
  const wrong = new HttpError(401, 'invalid_code', 'That code is wrong or has expired. Check the latest email, or start again.');
  const r = ctx.db.get('SELECT * FROM signup_requests WHERE id = ?', id);
  if (!r || r.used_at || r.expires_at < new Date().toISOString() || r.attempts >= MAX_ATTEMPTS) throw wrong;
  if (!safeEqual(r.code_hash, sha256(`${r.id}:${code}`))) { ctx.db.run('UPDATE signup_requests SET attempts = attempts + 1 WHERE id = ?', r.id); throw wrong; }
  const { parent, athletes } = JSON.parse(r.payload);
  if (ctx.db.get('SELECT id FROM guardians WHERE email = ?', parent.email)) throw conflict('This email already has an account. Sign in instead.');
  const familyId = createFamilyWithGuardian(ctx, parent);
  ctx.db.run('UPDATE signup_requests SET used_at = ? WHERE id = ?', ctx.now(), r.id);
  const guardian = ctx.db.get('SELECT * FROM guardians WHERE family_id = ?', familyId);
  // A child who already has a profile (a team athlete) joins the family when the Athlete ID, name and birth year match;
  // otherwise a new profile is made and the owner is asked to check. The answer reads the same either way.
  const created = [];
  for (const { athlete_code: claim, ...a } of athletes) {
    const tried = claim ? tryClaim(ctx, { code: claim, name: a.name, birthDate: a.birth_date, familyId, guardian, fields: a }) : null;
    if (tried?.attached) { created.push({ ...tried.attached, claim: 'attached' }); continue; }
    const c = await createClient(ctx, { ...a, family_id: familyId, send_welcome: false });
    if (claim) fileClaim(ctx, { code: claim, familyId, guardian, claim: tried, newClientId: c.id });
    created.push({ ...c, claim: claim ? 'pending' : null });
  }
  recordConsent(ctx, guardian, { ip });
  const raw = startPortalSession(ctx, guardian.id, { userAgent });
  emit(ctx, 'family.signed_up', { family_id: familyId, parent_name: parent.name, athletes: created.map((c) => ({ client_id: c.id, name: c.name, athlete_id: c.athlete_id })) });
  await welcomeFamily(ctx, familyId, { selfSignup: true });
  return { token: raw, maxAge: SESSION_DAYS * 86400, guardian: { id: guardian.id, name: guardian.name, email: guardian.email }, athletes: created.map((c) => ({ id: c.id, name: c.name, athlete_id: c.athlete_id, claim: c.claim, ...(c.claim === 'pending' ? { message: claimPendingText(c.name) } : {}) })) };
}
