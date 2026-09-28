import { newId, token, v, notFound, badRequest, conflict, HttpError, localDate, withLock } from '../util.js';
import { getSetting, createFamilyWithGuardian } from './families.js';
import { sendEmail } from './mail.js';
import { sendText, normalizePhone, numberStopped } from './sms.js';
import { emit } from './events.js';
import { createClient, getClient } from './clients.js';
import { findByAthleteId } from './athlete-ids.js';
import { welcomeFamily } from './notify.js';

export const US_MOBILE = /^\+1\d{10}$/;

// Leads: families who asked about training but aren't signed up yet. They come from the public "Ask about training"
// form (/start), from sign-ups started but never finished, from a CSV import, or are added by staff. Each lead gets a
// short, automatic follow-up (a thank-you right away, a nudge after 2 days, a last note after 7) that stops as soon as
// they sign up, book an evaluation, or a coach marks them joined or lost. Leads move forward on their own as the family
// signs up, books an evaluation, starts a free trial and buys a membership or pack.
//
// The CRM (version 45) adds: every stage change kept in lead_stage_history (days in stage, stale after 7 days without
// anyone working the lead), a trial stage, a required reason for lost leads, duplicate checks by email and phone,
// converting a lead to a client through the same new-client code as the Clients screen, and (contact.js, tasks.js,
// lead-reports.js) the timeline, one-to-one emails and texts, follow-up tasks, import, export and reports.

export const STAGES = ['new', 'contacted', 'signed_up', 'evaluation', 'trial', 'member', 'lost'];
export const OPEN_STAGES = ['new', 'contacted', 'signed_up', 'evaluation', 'trial'];
export const STAGE_LABELS = { new: 'New', contacted: 'Contacted', signed_up: 'Signed up', evaluation: 'Evaluation booked', trial: 'Trial', member: 'Member', lost: 'Lost' };
export const SOURCE_LABELS = { inquiry: 'Website form', signup_unfinished: 'Unfinished sign-up', manual: 'Added by staff', phone: 'Phone call', walk_in: 'Walk-in', event: 'Event',
  referral: 'Referral', social: 'Social media', camp: 'Camp', team: 'Team or school', import: 'Imported', client: 'Back from a client profile' };
export const STAFF_SOURCES = ['manual', 'phone', 'walk_in', 'event', 'referral', 'social', 'camp', 'team'];
export const LOST_REASONS = { price: 'Price', schedule: 'Schedule', distance: 'Too far', elsewhere: 'Went elsewhere', no_response: 'No response', not_ready: 'Not ready yet', other: 'Other' };
export const STALE_DAYS = 7;
const RANK = { new: 0, contacted: 1, signed_up: 2, evaluation: 3, trial: 4, member: 5, lost: -1 };
const FOLLOW_UP_DAYS = [0, 2, 7];
const biz = (ctx) => getSetting(ctx, 'business_name');
const base = (ctx) => ctx.publicUrl ?? '';
const first = (name) => String(name ?? '').split(' ')[0];
const zone = (ctx) => getSetting(ctx, 'timezone');
const dayOf = (ctx, iso) => (iso ? localDate(iso, zone(ctx)) : null);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const isCoach = (user) => user?.role === 'coach';

function leadInput(body, { needContact = true, partial = false } = {}) {
  const has = (k) => !partial || body[k] !== undefined;
  const out = {};
  if (has('parent_name') || (!partial && body.name !== undefined)) out.parent_name = v.str(body.parent_name ?? body.name, 'your name', { max: 120 });
  if (has('email')) out.email = body.email ? v.email(body.email, 'email') : null;
  if (has('phone')) out.phone = v.str(body.phone, 'phone', { max: 40, optional: true }) ?? null;
  if (has('athlete_name')) out.athlete_name = v.str(body.athlete_name, 'athlete\'s name', { max: 120, optional: true }) ?? null;
  if (has('athlete_age')) out.athlete_age = v.int(body.athlete_age, 'athlete\'s age', { min: 3, max: 99, optional: true }) ?? null;
  if (has('sport')) out.sport = v.str(body.sport, 'sport', { max: 60, optional: true }) ?? null;
  if (has('message')) out.message = v.str(body.message, 'message', { max: 2000, optional: true }) ?? null;
  if (out.phone && !normalizePhone(out.phone)) throw badRequest('Enter a phone number with its area code, like (512) 555-0100.');
  if (out.phone) out.phone = normalizePhone(out.phone);
  if (needContact && !out.email) throw badRequest('Enter an email so we can reply.');
  return out;
}
const openLeadFor = (ctx, email, exceptId = null) => (email ? ctx.db.get(`SELECT * FROM leads WHERE email = ? AND status IN ('new','contacted') AND id IS NOT ? ORDER BY created_at DESC LIMIT 1`, email, exceptId) : null);

// A contact log row for a lead or a family (notes, calls, emails, texts). Also used by contact.js.
export function logActivity(ctx, { leadId = null, familyId = null, clientId = null, kind, outcome = null, subject = null, body = null, sentTo = null, withToken = false, user = null, byName = null }) {
  const id = newId('act'), tok = withToken ? token(18) : null;
  ctx.db.run(`INSERT INTO lead_activity (id, lead_id, family_id, client_id, kind, outcome, subject, body, sent_to, token, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, leadId, familyId, clientId, kind, outcome, subject, body, sentTo, tok, user?.id ?? null, byName ?? user?.name ?? 'API', ctx.now());
  if (leadId) ctx.db.run('UPDATE leads SET last_activity_at = ?, updated_at = ? WHERE id = ?', ctx.now(), ctx.now(), leadId);
  return { id, token: tok };
}
// The end of every email a lead or family gets from the CRM: the business, its address and a one-press stop link.
export function emailFooter(ctx, tok) {
  const address = getSetting(ctx, 'business_address');
  return `\n\n--\n${biz(ctx)}${address ? `\n${address}` : ''}\nDon't want these emails? Stop them: ${base(ctx)}/u/${tok}`;
}
export const emailOptedOut = (ctx, email) => (email ? ctx.db.get('SELECT created_at FROM email_optouts WHERE email = ?', email) ?? null : null);
// Why a lead can't be texted right now (null when it can): texts only go to a US mobile number the family said is OK to
// text and that hasn't texted STOP since.
export function textBlock(ctx, lead) {
  const phone = normalizePhone(lead.phone);
  if (!phone) return 'There\'s no mobile number for them.';
  if (!US_MOBILE.test(phone)) return 'Texts only go to US numbers.';
  if (numberStopped(ctx, phone)) return 'They texted STOP. Texts start again only if they text START.';
  if (!lead.texts_ok) return 'They haven\'t said texts are OK. Ask them first, then turn on "OK to text".';
  return null;
}
export function emailBlock(ctx, email) {
  if (!email) return 'There\'s no email for them.';
  const out = emailOptedOut(ctx, email);
  if (out) return `${email} asked us to stop emailing them (${dayOf(ctx, out.created_at)}). Call or text instead.`;
  return null;
}

function createLead(ctx, data, { source, textsOk = false, textsOkSource = null, createdBy = null, followUp = true, status = 'new', familyId = null, clientId = null, user = null }) {
  const id = newId('lead'), now = ctx.now();
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO leads (id, parent_name, email, phone, athlete_name, athlete_age, sport, message, source, status, texts_ok, texts_ok_source, texts_ok_at, follow_up_step, next_follow_up_at,
        created_by, family_id, client_id, stage_changed_at, last_activity_at, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, data.parent_name, data.email, data.phone, data.athlete_name, data.athlete_age, data.sport, data.message, source, status, textsOk ? 1 : 0, textsOk ? textsOkSource : null, textsOk ? now : null,
      followUp && data.email && getSetting(ctx, 'lead_follow_up') === 'on' ? now : null, createdBy, familyId, clientId, now, now, data.notes ?? null, now, now);
    ctx.db.run('INSERT INTO lead_stage_history (id, lead_id, from_stage, to_stage, auto, reason, by_id, by_name, at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
      newId('lsh'), id, status, user ? 0 : 1, { inquiry: 'Asked on the website form', signup_unfinished: 'Started signing up', import: 'Imported', client: 'Put back in the pipeline' }[source] ?? 'Added', user?.id ?? null, user?.name ?? createdBy, now);
  });
  emit(ctx, 'lead.created', { lead_id: id, source, parent_name: data.parent_name, athlete_name: data.athlete_name });
  return id;
}

// ---------- Duplicates ----------
// Everyone who shares an email or phone with a new lead: other leads (open or closed), families (a parent's email or
// phone) and clients (their own email or phone). Staff see this before adding a lead (the form warns as they type) and
// when importing; the public form never gets it. Phones match on their last 10 digits.
const last10 = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);
export function findDuplicates(ctx, { email, phone, exceptId = null, user = null } = {}) {
  const e = email ? String(email).trim().toLowerCase() : null, d = last10(phone);
  const byPhone = d.length >= 7;
  const out = { leads: [], families: [], clients: [] };
  if (!e && !byPhone) return out;
  const leadRows = ctx.db.all('SELECT id, parent_name, athlete_name, email, phone, status, coach_id FROM leads WHERE id IS NOT ? AND (email = ? OR phone IS NOT NULL)', exceptId, e ?? '');
  for (const l of leadRows) {
    const match = e && l.email && l.email.toLowerCase() === e ? 'email' : byPhone && last10(l.phone) === d ? 'phone' : null;
    if (!match || (isCoach(user) && l.coach_id !== user.id)) continue;
    out.leads.push({ id: l.id, parent_name: l.parent_name, athlete_name: l.athlete_name, status: l.status, stage: STAGE_LABELS[l.status], open: OPEN_STAGES.includes(l.status), match });
  }
  for (const g of ctx.db.all(`SELECT g.family_id, g.name, g.email, g.phone, f.name AS family_name FROM guardians g JOIN families f ON f.id = g.family_id WHERE g.email = ? OR g.phone IS NOT NULL`, e ?? '')) {
    const match = e && g.email.toLowerCase() === e ? 'email' : byPhone && last10(g.phone) === d ? 'phone' : null;
    if (!match || out.families.some((f) => f.id === g.family_id)) continue;
    const kid = ctx.db.get('SELECT id, name FROM clients WHERE family_id = ? ORDER BY archived_at IS NOT NULL, created_at LIMIT 1', g.family_id);
    out.families.push({ id: g.family_id, name: g.family_name, parent_name: g.name, client_id: kid?.id ?? null, client_name: kid?.name ?? null, match });
  }
  for (const c of ctx.db.all('SELECT id, name, athlete_id, email, phone, archived_at FROM clients WHERE email = ? OR phone IS NOT NULL', e ?? '')) {
    const match = e && c.email && c.email.toLowerCase() === e ? 'email' : byPhone && last10(c.phone) === d ? 'phone' : null;
    if (match) out.clients.push({ id: c.id, name: c.name, athlete_id: c.athlete_id, archived: !!c.archived_at, match });
  }
  out.count = out.leads.length + out.families.length + out.clients.length;
  return out;
}
function duplicateMessage(dups) {
  const l = dups.leads[0], f = dups.families[0], c = dups.clients[0];
  const what = (m) => (m === 'email' ? 'email' : 'phone number');
  if (l) return `${l.parent_name} (a lead, ${l.stage}) has the same ${what(l.match)}. Open that lead, or add this one anyway.`;
  if (f) return `The ${f.name} (${f.parent_name}) has the same ${what(f.match)}: they already have a family account. Open their profile, or add the lead anyway.`;
  return `${c.name}${c.athlete_id ? ` (${c.athlete_id})` : ''} has the same ${what(c.match)}. Open their profile, or add the lead anyway.`;
}

// ---------- Public "Ask about training" form ----------
export async function submitInquiry(ctx, body) {
  const out = { ok: true, message: 'Thanks! We\'ll be in touch soon. Check your email for next steps.' };
  if (body.website) return out;                                     // hidden field only bots fill in
  const data = leadInput(body);
  // Texts only go to US numbers that haven't texted STOP: a public form must not be usable to text strangers abroad.
  const textsOk = body.texts_ok === true && US_MOBILE.test(data.phone ?? '') && !numberStopped(ctx, data.phone);
  const existing = openLeadFor(ctx, data.email);
  if (existing) {                                                    // asked twice: keep one lead, add the new note
    // Anyone can type someone else's email, so a repeat inquiry never changes the phone number or text setting.
    const note = [data.message, data.phone && data.phone !== existing.phone ? `(Gave phone ${data.phone} on a later inquiry.)` : null].filter(Boolean).join(' ');
    ctx.db.run('UPDATE leads SET message = ?, last_activity_at = ?, updated_at = ? WHERE id = ?',
      [existing.message, note].filter(Boolean).join('\n\n').slice(0, 4000) || null, ctx.now(), ctx.now(), existing.id);
    return out;
  }
  if (ctx.db.get('SELECT id FROM guardians WHERE email = ?', data.email)) {
    await sendEmail(ctx, { to: data.email, subject: `Your ${biz(ctx)} account`, text: `Thanks for reaching out! You already have a family account. Sign in to book: ${base(ctx)}/parent\n\n${biz(ctx)}` });
    return out;
  }
  const id = createLead(ctx, data, { source: 'inquiry', textsOk, textsOkSource: textsOk ? 'Ticked "text me" on the website form' : null });
  for (const o of ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`)) {
    sendEmail(ctx, { to: o.email, subject: `New inquiry: ${data.parent_name}${data.athlete_name ? ` for ${data.athlete_name}` : ''}`,
      text: `${data.parent_name} asked about training.\n\n${[data.athlete_name && `Athlete: ${data.athlete_name}${data.athlete_age ? `, ${data.athlete_age}` : ''}`, data.sport && `Sport: ${data.sport}`, `Email: ${data.email}`, data.phone && `Phone: ${data.phone}`].filter(Boolean).join('\n')}${data.message ? `\n\n"${data.message}"` : ''}\n\nThey've been sent a thank-you with the sign-up link. See the lead: ${base(ctx)}/#/leads/${id}` }).catch(() => {});
  }
  await runFollowUps(ctx, { only: id });
  return out;
}

// ---------- Sign-ups started but never finished become leads ----------
export function captureUnfinishedSignups(ctx, asOf = ctx.now()) {
  const hourAgo = new Date(Date.parse(asOf) - 3600000).toISOString(), weekAgo = new Date(Date.parse(asOf) - 7 * 86400000).toISOString();
  const rows = ctx.db.all(`SELECT r.* FROM signup_requests r WHERE r.used_at IS NULL AND r.created_at < ? AND r.created_at > ?
    AND NOT EXISTS (SELECT 1 FROM guardians g WHERE g.email = r.email) AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.email = r.email)
    AND NOT EXISTS (SELECT 1 FROM signup_requests r2 WHERE r2.email = r.email AND r2.used_at IS NOT NULL) ORDER BY r.created_at DESC`, hourAgo, weekAgo);
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.email.toLowerCase())) continue;
    seen.add(r.email.toLowerCase());
    const { parent, athletes } = JSON.parse(r.payload);
    createLead(ctx, { parent_name: parent.name, email: parent.email, phone: normalizePhone(parent.phone) ?? null, athlete_name: athletes?.[0]?.name ?? null, athlete_age: null, sport: athletes?.[0]?.sport ?? null, message: null }, { source: 'signup_unfinished' });
  }
  return seen.size;
}

// ---------- Stages ----------
// Moves a lead to another stage: kept in the stage history, with lead.updated (as before) and lead.stage_changed.
// A lost lead needs a reason (lostReason, a LOST_REASONS key). auto = the lead moved on its own (reason says why).
export function moveStage(ctx, lead, to, { user = null, auto = false, reason = null, lostReason = null, lostNote = null, byName = null } = {}) {
  const from = lead.status, now = ctx.now();
  if (from === to && to !== 'lost') return false;
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE leads SET status = ?, stage_changed_at = CASE WHEN status = ? THEN stage_changed_at ELSE ? END,
        next_follow_up_at = CASE WHEN ? IN ('new','contacted') THEN next_follow_up_at ELSE NULL END,
        lost_reason = ?, lost_note = ?, converted_at = CASE WHEN ? IN ('signed_up','evaluation','trial','member') THEN COALESCE(converted_at, ?) ELSE converted_at END,
        last_activity_at = CASE WHEN ? THEN last_activity_at ELSE ? END, updated_at = ? WHERE id = ?`,
      to, to, now, to, to === 'lost' ? lostReason : null, to === 'lost' ? lostNote : null, to, now, auto ? 1 : 0, now, now, lead.id);
    if (from !== to) ctx.db.run('INSERT INTO lead_stage_history (id, lead_id, from_stage, to_stage, auto, reason, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('lsh'), lead.id, from, to, auto ? 1 : 0, reason, user?.id ?? null, auto ? null : (byName ?? user?.name ?? 'API'), now);
  });
  if (from === to) return true;
  const familyId = ctx.db.get('SELECT family_id FROM leads WHERE id = ?', lead.id)?.family_id ?? null;
  emit(ctx, 'lead.updated', { lead_id: lead.id, status: to, family_id: familyId });
  emit(ctx, 'lead.stage_changed', { lead_id: lead.id, from, to, auto: !!auto, reason, family_id: familyId });
  return true;
}
function lostInput(body) {
  const raw = body.lost_reason;
  const note = v.str(body.lost_note, 'lost_note', { max: 500, optional: true });
  if (typeof raw === 'string' && LOST_REASONS[raw]) return { lostReason: raw, lostNote: note };
  // Integrations from before version 45 sent a reason in their own words: kept as the note, under "other".
  const text = v.str(raw, 'lost_reason', { max: 500, optional: true });
  if (text) return { lostReason: 'other', lostNote: note ? `${text} ${note}` : text };
  throw badRequest(`Pick why they didn't join (lost_reason: ${Object.keys(LOST_REASONS).join(', ')}).`);
}

// Leads move forward on their own from what the family does: a family account (signed up), an evaluation booked, a
// free trial, a membership or a pack bought. Never backwards, and never out of Lost (a family who comes back does so
// through a new lead). A lead put back in the pipeline from a client profile counts only what happened after that.
const AUTO_REASONS = { signed_up: 'Created a family account', evaluation: 'Booked an evaluation', trial: 'Started a free trial', member: 'Became a member' };
function advance(ctx, lead) {
  if (lead.status === 'lost' || lead.status === 'member') return lead;
  let familyId = lead.family_id;
  if (!familyId && lead.client_id) familyId = ctx.db.get('SELECT family_id FROM clients WHERE id = ?', lead.client_id)?.family_id ?? null;
  if (!familyId && lead.email) familyId = ctx.db.get('SELECT family_id FROM guardians WHERE email = ?', lead.email)?.family_id ?? null;
  const ids = familyId ? ctx.db.all('SELECT id FROM clients WHERE family_id = ?', familyId).map((c) => c.id) : [];
  if (lead.client_id && !ids.includes(lead.client_id)) ids.push(lead.client_id);
  if (!ids.length) return lead;
  const since = lead.source === 'client' ? lead.created_at : '';
  const inList = ids.map(() => '?').join(',');
  const member = ctx.db.get(`SELECT 1 FROM subscriptions WHERE client_id IN (${inList}) AND status IN ('active','past_due') AND updated_at >= ?`, ...ids, since)
    || ctx.db.get(`SELECT 1 FROM session_credits WHERE client_id IN (${inList}) AND reason = 'purchase' AND created_at >= ?`, ...ids, since)
    || ctx.db.get(`SELECT 1 FROM enrollments WHERE client_id IN (${inList}) AND status = 'active' AND created_at >= ?`, ...ids, since);
  const trial = ctx.db.get(`SELECT 1 FROM subscriptions WHERE client_id IN (${inList}) AND status = 'trialing' AND created_at >= ?`, ...ids, since);
  const evaluation = ctx.db.get(`SELECT 1 FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id IN (${inList}) AND s.kind = 'evaluation' AND b.status IN ('booked','attended') AND b.created_at >= ?`, ...ids, since);
  const stage = member ? 'member' : trial ? 'trial' : evaluation ? 'evaluation' : lead.source === 'client' ? null : familyId ? 'signed_up' : null;
  if (familyId && !lead.family_id) ctx.db.run('UPDATE leads SET family_id = ? WHERE id = ?', familyId, lead.id);
  if (stage && RANK[stage] > RANK[lead.status]) {
    moveStage(ctx, { ...lead, family_id: familyId }, stage, { auto: true, reason: AUTO_REASONS[stage] });
    ctx.db.run('UPDATE leads SET next_follow_up_at = NULL WHERE id = ?', lead.id);
    return { ...lead, status: stage, family_id: familyId, next_follow_up_at: null };
  }
  return { ...lead, family_id: familyId };
}
export function syncLead(ctx, id) {
  const l = ctx.db.get('SELECT * FROM leads WHERE id = ?', id);
  return l ? advance(ctx, l) : null;
}

// ---------- Automatic follow-up ----------
function followUpMessage(ctx, lead, step) {
  const who = lead.athlete_name ? first(lead.athlete_name) : 'your athlete';
  const join = getSetting(ctx, 'public_signup') === 'on'
    ? `The next step is a free evaluation. Create your family account at ${base(ctx)}/join (it takes two minutes), then book an evaluation on the Book tab.`
    : 'The next step is a free evaluation. Reply to this email with a few times that work and we\'ll set it up.';
  const unfinished = lead.source === 'signup_unfinished';
  if (step === 0) return {
    subject: unfinished ? `Finish signing up with ${biz(ctx)}` : `Thanks for reaching out to ${biz(ctx)}`,
    text: unfinished
      ? `Hi ${first(lead.parent_name)},\n\nIt looks like you started signing up but didn't finish. It only takes a minute: ${base(ctx)}/join\n\nQuestions first? Just reply to this email.\n\n${biz(ctx)}`
      : `Hi ${first(lead.parent_name)},\n\nThanks for asking about training for ${who}. ${join}\n\nQuestions? Just reply to this email.\n\n${biz(ctx)}`,
    sms: `Thanks for reaching out about training for ${who}! Next step is a free evaluation: ${base(ctx)}/join. Reply STOP to stop.`
  };
  if (step === 1) return {
    subject: `Still thinking about training for ${who}?`,
    text: `Hi ${first(lead.parent_name)},\n\nJust checking in. ${unfinished ? `Your sign-up is one step from done: ${base(ctx)}/join` : join}\n\nIf now isn't the right time, no problem. Reply and let us know what would help.\n\n${biz(ctx)}`,
    sms: `Hi ${first(lead.parent_name)}, still interested in training for ${who}? Book a free evaluation: ${base(ctx)}/join`
  };
  return {
    subject: `One last note from ${biz(ctx)}`,
    text: `Hi ${first(lead.parent_name)},\n\nThis is our last follow-up so we don't fill your inbox. Whenever you're ready, you can sign up at ${base(ctx)}/join or just reply to this email.\n\n${biz(ctx)}`,
    sms: null
  };
}

// Sends every follow-up that's due. Runs hourly, and right away for a new inquiry. An address that asked us to stop
// emailing gets nothing more (its follow-up stops); every follow-up email has its own stop link and is on the timeline.
export async function runFollowUps(ctx, { asOf = ctx.now(), only = null } = {}) {
  if (!only) captureUnfinishedSignups(ctx, asOf);
  for (const l of ctx.db.all(`SELECT * FROM leads WHERE status IN ('new','contacted','signed_up','evaluation','trial')`)) advance(ctx, l);
  if (getSetting(ctx, 'lead_follow_up') !== 'on') return 0;
  const due = ctx.db.all(`SELECT * FROM leads WHERE status IN ('new','contacted') AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= ? AND email IS NOT NULL${only ? ' AND id = ?' : ''}`, asOf, ...(only ? [only] : []));
  let sent = 0;
  for (const lead of due) {
    if (emailOptedOut(ctx, lead.email)) { ctx.db.run('UPDATE leads SET next_follow_up_at = NULL WHERE id = ?', lead.id); continue; }
    const step = lead.follow_up_step;
    const m = followUpMessage(ctx, lead, step);
    const act = logActivity(ctx, { leadId: lead.id, kind: 'email', subject: m.subject, body: m.text, sentTo: lead.email, withToken: true, byName: 'Automatic follow-up' });
    const mail = await sendEmail(ctx, { to: lead.email, subject: m.subject, text: m.text + emailFooter(ctx, act.token) });
    ctx.db.run('UPDATE lead_activity SET outcome = ? WHERE id = ?', mail?.status ?? null, act.id);
    const phone = lead.texts_ok && US_MOBILE.test(normalizePhone(lead.phone) ?? '') && !numberStopped(ctx, normalizePhone(lead.phone)) ? normalizePhone(lead.phone) : null;
    if (phone && m.sms) await sendText(ctx, { to: phone, kind: 'lead', body: `${biz(ctx)}: ${m.sms}` }).catch((e) => console.error('text', e.message));
    const nextStep = step + 1;
    const next = nextStep < FOLLOW_UP_DAYS.length ? new Date(Date.parse(lead.created_at) + FOLLOW_UP_DAYS[nextStep] * 86400000).toISOString() : null;
    if (lead.status === 'new') moveStage(ctx, lead, 'contacted', { auto: true, reason: 'Sent the automatic thank-you' });
    ctx.db.run(`UPDATE leads SET follow_up_step = ?, next_follow_up_at = ?, last_contacted_at = ?, updated_at = ? WHERE id = ?`, nextStep, next, ctx.now(), ctx.now(), lead.id);
    sent++;
  }
  return sent;
}

// ---------- Staff ----------
// Owner decision: owners and front desk work every lead; a coach sees, and works, only the leads the owner gave them
// (coach_id), and can't hand a lead to anyone. Coaches don't add leads (security.js). user is the signed-in staff member
// (none for an API key, which works like the owner).
export function leadScope(user, alias = 'l') { return isCoach(user) ? { sql: `${alias}.coach_id = ?`, args: [user.id] } : { sql: '1 = 1', args: [] }; }
// Days in the stage and stale (an open lead nobody has worked for 7 days), in business days.
export function shapeLead(ctx, l, today = dayOf(ctx, ctx.now())) {
  const lastTouch = [l.stage_changed_at, l.last_activity_at, l.created_at].filter(Boolean).sort().at(-1);
  const idle = lastTouch ? daysBetween(dayOf(ctx, lastTouch), today) : 0;
  return {
    ...l, texts_ok: !!l.texts_ok, follow_up: l.next_follow_up_at ? 'on' : 'done',
    stage_label: STAGE_LABELS[l.status], source_label: SOURCE_LABELS[l.source] ?? l.source,
    days_in_stage: l.stage_changed_at ? daysBetween(dayOf(ctx, l.stage_changed_at), today) : 0,
    idle_days: idle, stale: OPEN_STAGES.includes(l.status) && idle >= STALE_DAYS,
    lost_reason_label: l.status === 'lost' && l.lost_reason ? LOST_REASONS[l.lost_reason] ?? l.lost_reason : null
  };
}
const LEAD_SORTS = ['newest', 'oldest', 'stale', 'name', 'next_task', 'stage_age'];
export function listLeads(ctx, { status, user, q, source, stale, sort = 'newest', coach_id: coachFilter, open } = {}) {
  const scope = leadScope(user);
  if (sort && !LEAD_SORTS.includes(sort)) throw badRequest(`sort must be one of: ${LEAD_SORTS.join(', ')}.`);
  if (source && !SOURCE_LABELS[source]) throw badRequest(`source must be one of: ${Object.keys(SOURCE_LABELS).join(', ')}.`);
  const where = [scope.sql], args = [...scope.args];
  if (status) { where.push('l.status = ?'); args.push(status); }
  else if (open === 'true' || open === true) where.push(`l.status IN (${OPEN_STAGES.map((s) => `'${s}'`).join(',')})`);
  if (source) { where.push('l.source = ?'); args.push(source); }
  if (coachFilter && !isCoach(user)) { if (coachFilter === 'none') where.push('l.coach_id IS NULL'); else { where.push('l.coach_id = ?'); args.push(String(coachFilter)); } }
  const text = String(q ?? '').trim().slice(0, 100);
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, digits = text.replace(/\D/g, '');
    where.push(`(l.parent_name LIKE ? ESCAPE '\\' OR l.athlete_name LIKE ? ESCAPE '\\' OR l.email LIKE ? ESCAPE '\\' OR l.sport LIKE ? ESCAPE '\\'${digits.length >= 4 ? ' OR l.phone LIKE ?' : ''})`);
    args.push(like, like, like, like, ...(digits.length >= 4 ? [`%${digits}%`] : []));
  }
  const today = dayOf(ctx, ctx.now());
  let rows = ctx.db.all(`SELECT l.*, f.name AS family_name, u.name AS coach_name,
      (SELECT COUNT(*) FROM crm_tasks t WHERE t.lead_id = l.id AND t.done_at IS NULL) AS open_tasks,
      (SELECT MIN(due_date) FROM crm_tasks t WHERE t.lead_id = l.id AND t.done_at IS NULL) AS next_task_due
    FROM leads l LEFT JOIN families f ON f.id = l.family_id LEFT JOIN users u ON u.id = l.coach_id
    WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT 1000`, ...args).map((r) => shapeLead(ctx, r, today));
  if (stale === 'true' || stale === true) rows = rows.filter((r) => r.stale);
  const by = {
    newest: () => 0, oldest: (a, b) => a.created_at.localeCompare(b.created_at), name: (a, b) => a.parent_name.localeCompare(b.parent_name),
    stale: (a, b) => b.idle_days - a.idle_days, stage_age: (a, b) => b.days_in_stage - a.days_in_stage,
    next_task: (a, b) => (a.next_task_due ?? '9999').localeCompare(b.next_task_due ?? '9999')
  }[sort ?? 'newest'];
  rows.sort((a, b) => by(a, b) || b.created_at.localeCompare(a.created_at));
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of ctx.db.all(`SELECT l.status, COUNT(*) AS n FROM leads l WHERE ${scope.sql} GROUP BY l.status`, ...scope.args)) counts[r.status] = r.n;
  const staleCount = ctx.db.all(`SELECT l.* FROM leads l WHERE ${scope.sql} AND l.status IN (${OPEN_STAGES.map((s) => `'${s}'`).join(',')})`, ...scope.args).filter((r) => shapeLead(ctx, r, today).stale).length;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const month = ctx.db.get(`SELECT COUNT(*) AS n, SUM(CASE WHEN l.status IN ('signed_up','evaluation','trial','member') THEN 1 ELSE 0 END) AS won FROM leads l WHERE ${scope.sql} AND l.created_at >= ?`, ...scope.args, since);
  return { data: rows.slice(0, 500), counts, stale: staleCount, last_30_days: { leads: month.n, signed_up: month.won ?? 0 }, only_assigned: isCoach(user),
    stages: STAGES.map((k) => ({ key: k, label: STAGE_LABELS[k] })), sources: SOURCE_LABELS, lost_reasons: LOST_REASONS };
}
function leadRow(ctx, id, user) {
  const l = ctx.db.get('SELECT l.*, u.name AS coach_name, f.name AS family_name FROM leads l LEFT JOIN users u ON u.id = l.coach_id LEFT JOIN families f ON f.id = l.family_id WHERE l.id = ?', String(id));
  if (!l || (isCoach(user) && l.coach_id !== user.id)) throw notFound('Lead');      // a coach can't tell other leads exist
  return l;
}
export function getLead(ctx, id, { user, sync = false, details = false } = {}) {
  leadRow(ctx, id, user);
  if (sync) syncLead(ctx, id);
  const l = shapeLead(ctx, leadRow(ctx, id, user));
  if (!details) return l;
  const client = l.client_id ? ctx.db.get('SELECT id, name, athlete_id, archived_at FROM clients WHERE id = ?', l.client_id) : null;
  const optOut = emailOptedOut(ctx, l.email);
  return {
    ...l,
    client: client ? { id: client.id, name: client.name, athlete_id: client.athlete_id, archived: !!client.archived_at } : null,
    email_opted_out: !!optOut, email_opted_out_at: optOut?.created_at ?? null,
    email_block: emailBlock(ctx, l.email), text_block: textBlock(ctx, l), texts_stopped: !!(normalizePhone(l.phone) && numberStopped(ctx, normalizePhone(l.phone))),
    history: ctx.db.all('SELECT from_stage, to_stage, auto, reason, by_name, at FROM lead_stage_history WHERE lead_id = ? ORDER BY at, rowid', l.id)
      .map((h) => ({ ...h, auto: !!h.auto, from_label: STAGE_LABELS[h.from_stage] ?? null, to_label: STAGE_LABELS[h.to_stage] ?? h.to_stage })),
    duplicates: findDuplicates(ctx, { email: l.email, phone: l.phone, exceptId: l.id, user })
  };
}
// Who a lead can go to: an active owner or coach (front desk accounts don't take leads).
function leadCoach(ctx, x) {
  if (x === null || x === '') return null;
  const u = ctx.db.get('SELECT id, name, role, active FROM users WHERE id = ?', v.str(x, 'coach_id', { max: 64 }));
  if (!u) throw notFound('Coach');
  if (!u.active) throw badRequest(`${u.name}'s account is turned off. Pick an active coach.`);
  if (u.role === 'front_desk') throw badRequest(`${u.name} is front desk. Give the lead to a coach, or leave it with the front desk and you.`);
  return u;
}
// Staff add a lead. An open lead with the same email is refused (open it instead). With check_duplicates: true (the
// dashboard sends it) the same phone as another lead, a family or a client, or an email a family or client already has,
// asks first (409 possible_duplicate, details.duplicates); sending it again without the flag adds it anyway.
export async function addLead(ctx, body, actor) {
  const data = leadInput(body, { needContact: false });
  if (!data.email && !data.phone) throw badRequest('Add an email or a phone number so you can follow up.');
  if (body.check_duplicates !== undefined && typeof body.check_duplicates !== 'boolean') throw badRequest('check_duplicates must be true or false.');
  const open = openLeadFor(ctx, data.email);
  if (open) throw Object.assign(new HttpError(409, 'conflict', `There's already an open lead for ${data.email}.`), { details: { lead_id: open.id } });
  if (body.check_duplicates === true) {
    const dups = findDuplicates(ctx, { email: data.email, phone: data.phone });
    if (dups.count) throw Object.assign(new HttpError(409, 'possible_duplicate', duplicateMessage(dups)), { details: { duplicates: dups } });
  }
  const user = actor?.role ? actor : null;
  let textsOk = false, textsSource = null;
  if (body.texts_ok === true) {
    if (!data.phone || !US_MOBILE.test(data.phone)) throw badRequest('Texts only go to a US mobile number. Add one, or leave "OK to text" off.');
    if (numberStopped(ctx, data.phone)) throw conflict('That number texted STOP to us. Texts start again only if they text START.');
    textsOk = true;
    textsSource = v.str(body.texts_ok_source, 'texts_ok_source', { max: 120, optional: true }) ?? (user ? `Told ${user.name}` : `Added through the API (${actor?.label ?? 'key'})`);
  }
  const notes = v.str(body.notes, 'notes', { max: 4000, optional: true });
  const id = createLead(ctx, { ...data, notes }, { source: v.oneOf(body.source ?? 'manual', 'source', STAFF_SOURCES), textsOk, textsOkSource: textsSource,
    createdBy: actor?.name ?? actor?.label ?? null, followUp: body.follow_up !== false, user });
  if (body.follow_up !== false) await runFollowUps(ctx, { only: id });
  return getLead(ctx, id);
}
export async function updateLead(ctx, id, body, { user } = {}) {
  const l = leadRow(ctx, id, user);
  if (body.coach_id !== undefined) {
    if (user && user.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only the owner gives a lead to a coach.');
    const coach = leadCoach(ctx, body.coach_id);
    if ((coach?.id ?? null) !== (l.coach_id ?? null)) {
      ctx.db.run('UPDATE leads SET coach_id = ?, updated_at = ? WHERE id = ?', coach?.id ?? null, ctx.now(), id);
      emit(ctx, 'lead.updated', { lead_id: id, coach_id: coach?.id ?? null, coach_name: coach?.name ?? null });
      if (coach && coach.role === 'coach' && coach.id !== user?.id) {
        const c = ctx.db.get('SELECT email FROM users WHERE id = ?', coach.id);
        await sendEmail(ctx, { to: c.email, subject: `A lead for you: ${l.parent_name}`, text: `Hi ${first(coach.name)},\n\n${l.parent_name}${l.athlete_name ? ` (for ${l.athlete_name}${l.athlete_age ? `, ${l.athlete_age}` : ''})` : ''} asked about training, and it's yours to follow up. See the lead: ${base(ctx)}/#/leads/${l.id}\n\n${biz(ctx)}` }).catch(() => {});
      }
    }
  }
  // Details: fixing a name, adding an email or phone. A new phone number turns "OK to text" off (the OK was for the old one).
  const details = leadInput(body, { needContact: false, partial: true });
  if (Object.keys(details).length) {
    const next = { ...l, ...details };
    if (!next.email && !next.phone) throw badRequest('Keep an email or a phone number so you can follow up.');
    if (details.email && details.email !== l.email && openLeadFor(ctx, details.email, l.id)) throw conflict(`There's already an open lead for ${details.email}.`);
    const phoneChanged = details.phone !== undefined && (details.phone ?? null) !== (l.phone ?? null);
    const keys = Object.keys(details);
    ctx.db.run(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}${phoneChanged ? ', texts_ok = 0, texts_ok_source = NULL, texts_ok_at = NULL' : ''}, last_activity_at = ?, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => details[k]), ctx.now(), ctx.now(), id);
  }
  if (body.texts_ok !== undefined) {
    const cur = leadRow(ctx, id, user);
    if (body.texts_ok === true) {
      const phone = normalizePhone(cur.phone);
      if (!phone || !US_MOBILE.test(phone)) throw badRequest('Texts only go to a US mobile number. Add one first.');
      if (numberStopped(ctx, phone)) throw conflict('They texted STOP. Texts start again only if they text START from that phone.');
      if (!cur.texts_ok) ctx.db.run('UPDATE leads SET texts_ok = 1, texts_ok_source = ?, texts_ok_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?',
        v.str(body.texts_ok_source, 'how they said texts are OK (texts_ok_source)', { max: 120, optional: !user }) ?? 'Through the API', ctx.now(), ctx.now(), ctx.now(), id);
    } else if (body.texts_ok === false) ctx.db.run('UPDATE leads SET texts_ok = 0, texts_ok_source = NULL, texts_ok_at = NULL, updated_at = ? WHERE id = ?', ctx.now(), id);
    else throw badRequest('texts_ok must be true or false.');
  }
  // "Don't email": the address joins the opt-out list, which covers every lead and parent with it. Only the family can
  // undo that (there's no way for staff to take someone off it).
  if (body.email_ok !== undefined) {
    const cur = leadRow(ctx, id, user);
    if (body.email_ok === false) {
      if (!cur.email) throw badRequest('There\'s no email to stop.');
      ctx.db.run('INSERT INTO email_optouts (email, created_at, source) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING', cur.email, ctx.now(), `staff:${user?.name ?? 'API'}`);
      ctx.db.run('UPDATE leads SET next_follow_up_at = NULL, updated_at = ? WHERE id = ?', ctx.now(), id);
    } else if (body.email_ok === true) {
      if (emailOptedOut(ctx, cur.email)) throw conflict(`${cur.email} asked us to stop emailing them. Only they can change that; call or text instead.`);
    } else throw badRequest('email_ok must be true or false.');
  }
  if (body.status !== undefined) {
    const status = v.oneOf(body.status, 'status', STAGES);
    const cur = leadRow(ctx, id, user);
    const lost = status === 'lost' ? lostInput(body) : {};
    moveStage(ctx, cur, status, { user, ...lost, byName: user?.name ?? 'API' });
  }
  if (body.notes !== undefined) ctx.db.run('UPDATE leads SET notes = ?, last_activity_at = ?, updated_at = ? WHERE id = ?', v.str(body.notes, 'notes', { max: 4000, optional: true }) ?? null, ctx.now(), ctx.now(), id);
  if (body.follow_up === false) ctx.db.run('UPDATE leads SET next_follow_up_at = NULL, updated_at = ? WHERE id = ?', ctx.now(), id);
  if (body.contacted === true) {
    const cur = leadRow(ctx, id, user);
    if (cur.status === 'new') moveStage(ctx, cur, 'contacted', { user, reason: 'Reached out' });
    ctx.db.run('UPDATE leads SET last_contacted_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?', ctx.now(), ctx.now(), ctx.now(), id);
  }
  return getLead(ctx, l.id, { user });
}
export function deleteLead(ctx, id) {
  leadRow(ctx, id);
  ctx.db.run('DELETE FROM leads WHERE id = ?', id);
  return { ok: true };
}
// ---------- Converting a lead to a client ----------
// One profile per athlete: a lead becomes a client either by linking a client the staff member chose (client_id, or an
// exact Athlete ID; names are never matched on their own) or by creating one through clients.createClient, the same
// rules as the Clients screen (a parent's email that already signs in is refused with a link to that family; with
// check_duplicates: true the same name and birthday, or a phone on file, asks first). The lead is linked (client_id,
// family_id) in the same transaction, its notes and message become a staff note on the client, and it moves to Signed up
// (or further, from what the family already did). One conversion per lead, even when the button is pressed twice.
// Text consent doesn't carry over (parents turn texts on in the portal); a STOP and an email opt-out always do.
export async function convertLead(ctx, id, body = {}, { user } = {}) {
  return withLock(`lead:${id}`, async () => {
    const l = leadRow(ctx, id, user);
    if (l.client_id) {
      const c = ctx.db.get('SELECT id, name FROM clients WHERE id = ?', l.client_id);
      throw Object.assign(conflict(`${l.parent_name}'s lead is already ${c ? `${c.name}'s profile` : 'a client'}. Open it from the lead.`), { details: { client_id: l.client_id } });
    }
    const note = [l.message ? `They wrote: "${l.message}"` : null, l.notes ? `Lead notes: ${l.notes}` : null].filter(Boolean).join('\n\n');
    const link = (clientId, familyId) => {
      const cur = ctx.db.get('SELECT client_id FROM leads WHERE id = ?', id);
      if (cur.client_id) throw conflict('This lead was just converted. Open it again.');
      ctx.db.run('UPDATE leads SET client_id = ?, family_id = COALESCE(?, family_id), converted_at = COALESCE(converted_at, ?), next_follow_up_at = NULL, last_activity_at = ?, updated_at = ? WHERE id = ?',
        clientId, familyId, ctx.now(), ctx.now(), ctx.now(), id);
      if (note) ctx.db.run('INSERT INTO client_notes (id, client_id, body, pinned, coach_only, author_id, author_name, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)',
        newId('note'), clientId, `From ${l.parent_name}'s lead (${SOURCE_LABELS[l.source] ?? l.source}, ${dayOf(ctx, l.created_at)}):\n\n${note}`.slice(0, 4000), user?.id ?? null, user?.name ?? 'Lead', ctx.now(), ctx.now());
    };
    let clientId;
    const existing = body.client_id ? ctx.db.get('SELECT id FROM clients WHERE id = ?', v.str(body.client_id, 'client_id', { max: 64 }))
      : body.athlete_id ? (() => { const f = findByAthleteId(ctx, body.athlete_id); return f ? { id: f.client_id } : null; })() : null;
    if (body.client_id || body.athlete_id) {
      if (!existing) throw body.athlete_id ? badRequest(`No athlete has the ID ${String(body.athlete_id).trim().toUpperCase()}. Check it, or add them as a new client.`) : notFound('Client');
      const c = getClient(ctx, existing.id);
      if (c.archived_at) throw conflict(`${c.name} is archived. Bring them back first, then link the lead.`);
      let newFamily = null;
      ctx.db.tx(() => {
        let familyId = c.family?.id ?? null;
        // A client without a family (a team roster athlete, say) goes into one: the family the staff member picked, or a new
        // one for the lead's parent, so the parents see them in the portal.
        if (!familyId && (body.family_id || body.parent || l.email)) {
          familyId = body.family_id ? ctx.db.get('SELECT id FROM families WHERE id = ?', String(body.family_id))?.id : null;
          if (body.family_id && !familyId) throw notFound('Family');
          if (!familyId) familyId = newFamily = createFamilyWithGuardian(ctx, body.parent ?? { name: l.parent_name, email: l.email, phone: l.phone }, body.family_name);
          ctx.db.run('UPDATE clients SET family_id = ? WHERE id = ? AND family_id IS NULL', familyId, c.id);
        }
        link(c.id, familyId);
      });
      if (newFamily && body.send_welcome !== false) await welcomeFamily(ctx, newFamily);
      clientId = c.id;
    } else {
      const athleteName = v.str(body.name ?? body.athlete_name ?? l.athlete_name, 'athlete\'s name (name)', { max: 120 });
      const input = {
        name: athleteName, birth_date: body.birth_date, sex: body.sex, sport: body.sport ?? l.sport ?? undefined, school: body.school, position: body.position, grad_year: body.grad_year,
        email: body.email, phone: body.phone, notes: undefined, send_welcome: body.send_welcome, check_duplicates: body.check_duplicates,
        ...(body.family_id ? { family_id: String(body.family_id) } : { parent: body.parent ?? { name: l.parent_name, email: l.email, phone: l.phone } })
      };
      if (!input.family_id && !input.parent?.email) throw badRequest(`Add ${first(l.parent_name)}'s email first: the family signs in with it.`);
      const made = await createClient(ctx, input, { staff: user ?? { role: 'owner' }, inTx: (cid, fid) => link(cid, fid) });
      clientId = made.id;
    }
    const cur = ctx.db.get('SELECT * FROM leads WHERE id = ?', id);
    if (RANK[cur.status] < RANK.signed_up && cur.status !== 'lost') moveStage(ctx, cur, 'signed_up', { user, reason: 'Converted to a client', byName: user?.name ?? 'API' });
    else if (cur.status === 'lost') moveStage(ctx, cur, 'signed_up', { user, reason: 'Converted to a client', byName: user?.name ?? 'API' });
    syncLead(ctx, id);
    const done = ctx.db.get('SELECT family_id FROM leads WHERE id = ?', id);
    emit(ctx, 'lead.converted', { lead_id: id, client_id: clientId, family_id: done.family_id ?? null });
    return { lead: getLead(ctx, id, { user, details: true }), client: getClient(ctx, clientId) };
  });
}

// ---------- A client back in the pipeline ----------
// From a client profile (a family whose trial ended, a lapsed member): a new lead for that family, linked to the client,
// so the family can be worked like any lead. It counts only what the family does from now on, so an old membership or
// sign-up doesn't move it along. One open lead per family.
export function reengageClient(ctx, clientId, body = {}, { user } = {}) {
  const c = getClient(ctx, clientId);
  if (c.archived_at) throw conflict(`${c.name} is archived. Bring them back first.`);
  const open = ctx.db.get(`SELECT id FROM leads WHERE (client_id = ? OR (family_id IS NOT NULL AND family_id IS ?)) AND status IN (${OPEN_STAGES.map((s) => `'${s}'`).join(',')})`, c.id, c.family?.id ?? null);
  if (open) throw Object.assign(conflict(`${c.name}'s family already has an open lead. Open it instead.`), { details: { lead_id: open.id } });
  const g = c.family ? ctx.db.get('SELECT name, email, phone FROM guardians WHERE family_id = ? ORDER BY is_primary DESC, created_at LIMIT 1', c.family.id) : null;
  const note = v.str(body.note, 'note', { max: 2000, optional: true });
  const id = createLead(ctx, { parent_name: g?.name ?? c.name, email: g?.email ?? c.email ?? null, phone: normalizePhone(g?.phone ?? c.phone) ?? null, athlete_name: c.name, athlete_age: null, sport: c.sport ?? null, message: null, notes: note },
    { source: 'client', createdBy: user?.name ?? 'API', followUp: false, familyId: c.family?.id ?? null, clientId: c.id, user: user ?? { name: 'API' }, status: 'contacted' });
  return getLead(ctx, id, { user });
}

// Leads for a family or client (the client profile's "In the pipeline" line). A coach only sees leads given to them.
export function leadsForClient(ctx, clientId, user) {
  const c = ctx.db.get('SELECT id, family_id FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Client');
  const scope = leadScope(user);
  return ctx.db.all(`SELECT l.* FROM leads l WHERE ${scope.sql} AND (l.client_id = ? OR (l.family_id IS NOT NULL AND l.family_id IS ?)) ORDER BY l.created_at DESC`, ...scope.args, c.id, c.family_id ?? null).map((l) => shapeLead(ctx, l));
}
export const todayDate = (ctx) => dayOf(ctx, ctx.now());
export { daysBetween, dayOf };
