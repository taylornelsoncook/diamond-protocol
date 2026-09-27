import { newId, v, notFound, badRequest, HttpError } from '../util.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';
import { sendText, normalizePhone, numberStopped } from './sms.js';
import { emit } from './events.js';

const US_MOBILE = /^\+1\d{10}$/;

// Leads: families who asked about training but aren't signed up yet. They come from the public "Ask about training"
// form (/start), from sign-ups started but never finished, or are added by staff. Each lead gets a short, automatic
// follow-up (a thank-you right away, a nudge after 2 days, a last note after 7) that stops as soon as they sign up,
// book an evaluation, or a coach marks them joined or lost. Leads move forward on their own as the family signs up,
// books an evaluation and buys a membership or pack.

export const STAGES = ['new', 'contacted', 'signed_up', 'evaluation', 'member', 'lost'];
const FOLLOW_UP_DAYS = [0, 2, 7];
const biz = (ctx) => getSetting(ctx, 'business_name');
const base = (ctx) => ctx.publicUrl ?? '';
const first = (name) => String(name ?? '').split(' ')[0];

function leadInput(body, { needContact = true } = {}) {
  const out = {
    parent_name: v.str(body.parent_name ?? body.name, 'your name', { max: 120 }),
    email: body.email ? v.email(body.email, 'email') : null,
    phone: v.str(body.phone, 'phone', { max: 40, optional: true }) ?? null,
    athlete_name: v.str(body.athlete_name, 'athlete\'s name', { max: 120, optional: true }) ?? null,
    athlete_age: v.int(body.athlete_age, 'athlete\'s age', { min: 3, max: 99, optional: true }) ?? null,
    sport: v.str(body.sport, 'sport', { max: 60, optional: true }) ?? null,
    message: v.str(body.message, 'message', { max: 2000, optional: true }) ?? null
  };
  if (out.phone && !normalizePhone(out.phone)) throw badRequest('Enter a phone number with its area code, like (512) 555-0100.');
  if (out.phone) out.phone = normalizePhone(out.phone);
  if (needContact && !out.email) throw badRequest('Enter an email so we can reply.');
  return out;
}
const openLeadFor = (ctx, email) => (email ? ctx.db.get(`SELECT * FROM leads WHERE email = ? AND status IN ('new','contacted') ORDER BY created_at DESC LIMIT 1`, email) : null);

function createLead(ctx, data, { source, textsOk = false, createdBy = null }) {
  const id = newId('lead');
  ctx.db.run(`INSERT INTO leads (id, parent_name, email, phone, athlete_name, athlete_age, sport, message, source, status, texts_ok, follow_up_step, next_follow_up_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, 0, ?, ?, ?, ?)`,
    id, data.parent_name, data.email, data.phone, data.athlete_name, data.athlete_age, data.sport, data.message, source, textsOk ? 1 : 0,
    data.email && getSetting(ctx, 'lead_follow_up') === 'on' ? ctx.now() : null, createdBy, ctx.now(), ctx.now());
  emit(ctx, 'lead.created', { lead_id: id, source, parent_name: data.parent_name, athlete_name: data.athlete_name });
  return id;
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
    ctx.db.run('UPDATE leads SET message = ?, updated_at = ? WHERE id = ?',
      [existing.message, note].filter(Boolean).join('\n\n').slice(0, 4000) || null, ctx.now(), existing.id);
    return out;
  }
  if (ctx.db.get('SELECT id FROM guardians WHERE email = ?', data.email)) {
    await sendEmail(ctx, { to: data.email, subject: `Your ${biz(ctx)} account`, text: `Thanks for reaching out! You already have a family account. Sign in to book: ${base(ctx)}/parent\n\n${biz(ctx)}` });
    return out;
  }
  const id = createLead(ctx, data, { source: 'inquiry', textsOk });
  for (const o of ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`)) {
    sendEmail(ctx, { to: o.email, subject: `New inquiry: ${data.parent_name}${data.athlete_name ? ` for ${data.athlete_name}` : ''}`,
      text: `${data.parent_name} asked about training.\n\n${[data.athlete_name && `Athlete: ${data.athlete_name}${data.athlete_age ? `, ${data.athlete_age}` : ''}`, data.sport && `Sport: ${data.sport}`, `Email: ${data.email}`, data.phone && `Phone: ${data.phone}`].filter(Boolean).join('\n')}${data.message ? `\n\n"${data.message}"` : ''}\n\nThey've been sent a thank-you with the sign-up link. See every lead under Leads: ${base(ctx)}/#/leads` }).catch(() => {});
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
    createLead(ctx, { parent_name: parent.name, email: parent.email, phone: parent.phone ?? null, athlete_name: athletes?.[0]?.name ?? null, athlete_age: null, sport: athletes?.[0]?.sport ?? null, message: null }, { source: 'signup_unfinished' });
  }
  return seen.size;
}

// ---------- Stages move forward on their own ----------
function advance(ctx, lead) {
  if (!lead.email || lead.status === 'lost' || lead.status === 'member') return lead;
  const g = ctx.db.get('SELECT family_id FROM guardians WHERE email = ?', lead.email);
  if (!g) return lead;
  const kids = `SELECT id FROM clients WHERE family_id = ?`;
  const member = ctx.db.get(`SELECT 1 FROM subscriptions WHERE client_id IN (${kids}) AND status IN ('active','trialing','past_due')`, g.family_id)
    || ctx.db.get(`SELECT 1 FROM session_credits WHERE client_id IN (${kids}) AND reason = 'purchase'`, g.family_id)
    || ctx.db.get(`SELECT 1 FROM enrollments WHERE client_id IN (${kids}) AND status = 'active'`, g.family_id);
  const evaluation = ctx.db.get(`SELECT 1 FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id IN (${kids}) AND s.kind = 'evaluation' AND b.status IN ('booked','attended')`, g.family_id);
  const stage = member ? 'member' : evaluation ? 'evaluation' : 'signed_up';
  if (STAGES.indexOf(stage) > STAGES.indexOf(lead.status)) {
    ctx.db.run('UPDATE leads SET status = ?, family_id = ?, next_follow_up_at = NULL, converted_at = COALESCE(converted_at, ?), updated_at = ? WHERE id = ?', stage, g.family_id, ctx.now(), ctx.now(), lead.id);
    emit(ctx, 'lead.updated', { lead_id: lead.id, status: stage, family_id: g.family_id });
    return { ...lead, status: stage, family_id: g.family_id, next_follow_up_at: null };
  }
  return lead;
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

// Sends every follow-up that's due. Runs hourly, and right away for a new inquiry.
export async function runFollowUps(ctx, { asOf = ctx.now(), only = null } = {}) {
  if (!only) captureUnfinishedSignups(ctx, asOf);
  for (const l of ctx.db.all(`SELECT * FROM leads WHERE status IN ('new','contacted','signed_up','evaluation')`)) advance(ctx, l);
  if (getSetting(ctx, 'lead_follow_up') !== 'on') return 0;
  const due = ctx.db.all(`SELECT * FROM leads WHERE status IN ('new','contacted') AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= ? AND email IS NOT NULL${only ? ' AND id = ?' : ''}`, asOf, ...(only ? [only] : []));
  let sent = 0;
  for (const lead of due) {
    const step = lead.follow_up_step;
    const m = followUpMessage(ctx, lead, step);
    await sendEmail(ctx, { to: lead.email, subject: m.subject, text: m.text });
    const phone = lead.texts_ok && US_MOBILE.test(normalizePhone(lead.phone) ?? '') && !numberStopped(ctx, normalizePhone(lead.phone)) ? normalizePhone(lead.phone) : null;
    if (phone && m.sms) await sendText(ctx, { to: phone, kind: 'lead', body: `${biz(ctx)}: ${m.sms}` }).catch((e) => console.error('text', e.message));
    const nextStep = step + 1;
    const next = nextStep < FOLLOW_UP_DAYS.length ? new Date(Date.parse(lead.created_at) + FOLLOW_UP_DAYS[nextStep] * 86400000).toISOString() : null;
    ctx.db.run(`UPDATE leads SET status = 'contacted', follow_up_step = ?, next_follow_up_at = ?, last_contacted_at = ?, updated_at = ? WHERE id = ?`, nextStep, next, ctx.now(), ctx.now(), lead.id);
    sent++;
  }
  return sent;
}

// ---------- Staff ----------
export function listLeads(ctx, { status } = {}) {
  const rows = ctx.db.all(`SELECT l.*, f.name AS family_name FROM leads l LEFT JOIN families f ON f.id = l.family_id ${status ? 'WHERE l.status = ?' : ''} ORDER BY CASE l.status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END, l.created_at DESC LIMIT 500`, ...(status ? [status] : []));
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of ctx.db.all('SELECT status, COUNT(*) AS n FROM leads GROUP BY status')) counts[r.status] = r.n;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const month = ctx.db.get(`SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('signed_up','evaluation','member') THEN 1 ELSE 0 END) AS won FROM leads WHERE created_at >= ?`, since);
  return { data: rows.map((r) => ({ ...r, texts_ok: !!r.texts_ok, follow_up: r.next_follow_up_at ? 'on' : 'done' })), counts, last_30_days: { leads: month.n, signed_up: month.won ?? 0 } };
}
export function getLead(ctx, id) {
  const l = ctx.db.get('SELECT * FROM leads WHERE id = ?', id);
  if (!l) throw notFound('Lead');
  return { ...l, texts_ok: !!l.texts_ok };
}
export async function addLead(ctx, body, actor) {
  const data = leadInput(body, { needContact: false });
  if (!data.email && !data.phone) throw badRequest('Add an email or a phone number so you can follow up.');
  if (data.email && openLeadFor(ctx, data.email)) throw new HttpError(409, 'conflict', `There's already an open lead for ${data.email}.`);
  const id = createLead(ctx, data, { source: v.oneOf(body.source ?? 'manual', 'source', ['manual', 'phone', 'walk_in', 'event', 'referral']), textsOk: body.texts_ok === true, createdBy: actor?.name ?? null });
  if (body.follow_up === false) ctx.db.run('UPDATE leads SET next_follow_up_at = NULL WHERE id = ?', id);
  else await runFollowUps(ctx, { only: id });
  return getLead(ctx, id);
}
export function updateLead(ctx, id, body) {
  const l = getLead(ctx, id);
  if (body.status !== undefined) {
    const status = v.oneOf(body.status, 'status', STAGES);
    ctx.db.run('UPDATE leads SET status = ?, next_follow_up_at = CASE WHEN ? IN (\'new\',\'contacted\') THEN next_follow_up_at ELSE NULL END, lost_reason = ?, updated_at = ? WHERE id = ?',
      status, status, status === 'lost' ? v.str(body.lost_reason, 'lost_reason', { max: 200, optional: true }) ?? null : null, ctx.now(), id);
    emit(ctx, 'lead.updated', { lead_id: id, status });
  }
  if (body.notes !== undefined) ctx.db.run('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?', v.str(body.notes, 'notes', { max: 4000, optional: true }) ?? null, ctx.now(), id);
  if (body.follow_up === false) ctx.db.run('UPDATE leads SET next_follow_up_at = NULL, updated_at = ? WHERE id = ?', ctx.now(), id);
  if (body.contacted === true) ctx.db.run(`UPDATE leads SET status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, last_contacted_at = ?, updated_at = ? WHERE id = ?`, ctx.now(), ctx.now(), id);
  return getLead(ctx, l.id);
}
export function deleteLead(ctx, id) {
  getLead(ctx, id);
  ctx.db.run('DELETE FROM leads WHERE id = ?', id);
  return { ok: true };
}
