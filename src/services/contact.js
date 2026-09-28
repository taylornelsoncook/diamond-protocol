import { newId, v, notFound, badRequest, conflict } from '../util.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';
import { sendText, normalizePhone, numberStopped, smsMode } from './sms.js';
import { getLead, leadScope, logActivity, emailFooter, emailBlock, textBlock, moveStage, STAGE_LABELS, SOURCE_LABELS, LOST_REASONS, US_MOBILE } from './leads.js';

// Contact with leads and families (CRM, version 45): notes and calls logged by staff, one-to-one emails and texts from
// the lead page and the client profile with editable templates, and the timeline of everything that happened.
// - Emails go only to addresses that haven't asked us to stop (email_optouts, which covers every lead and parent with
//   that address) and end with the business's address and a one-press stop link (/u/<token>).
// - Texts go to a lead only when they said texts are OK (texts_ok) on a US mobile that hasn't texted STOP; to a family
//   only to parents who turned texts on in the parent portal (and haven't replied STOP). Every text says how to stop.
// - The timeline shows payments to the owner only, and a coach sees only the leads the owner gave them.

const biz = (ctx) => getSetting(ctx, 'business_name');
const first = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'there';
const CALL_OUTCOMES = { reached: 'Reached them', voicemail: 'Left a voicemail', no_answer: 'No answer' };
export const TEXT_MAX = 480;
const EMAIL_MAX = 10000;

// ---------- Templates ----------
const DEFAULT_TEMPLATES = [
  ['email', 'Thanks for asking', 'Training for {athlete}', 'Hi {first_name},\n\nThanks for asking about training for {athlete}. The best next step is a free evaluation: we see where {athlete} is today and suggest a plan. Pick a time that works here: {book_link}\n\nAny questions, just reply to this email.\n\n{my_name}\n{business}'],
  ['email', 'After the evaluation', 'Next steps for {athlete}', 'Hi {first_name},\n\nIt was great to meet {athlete}. Here is what we suggest next, and how to get started: {join_link}\n\nReply with any questions.\n\n{my_name}\n{business}'],
  ['email', 'Checking in', 'Still thinking about training?', 'Hi {first_name},\n\nJust checking in about training for {athlete}. If now isn\'t the right time, no problem: reply and let us know what would help.\n\n{my_name}\n{business}'],
  ['text', 'Quick hello', null, 'Hi {first_name}, it\'s {my_name} from {business}. Thanks for asking about training for {athlete}! When is a good time for a quick call?'],
  ['text', 'Book a time', null, 'Hi {first_name}, here is where to book {athlete}\'s free evaluation: {book_link}'],
  ['text', 'Evaluation reminder', null, 'Hi {first_name}, a reminder about {athlete}\'s evaluation with us. Reply here with any questions.']
];
export function listTemplates(ctx) {
  if (getSetting(ctx, 'crm_templates_seeded') !== 'yes') {
    ctx.db.tx(() => {
      if (!ctx.db.get('SELECT 1 FROM message_templates LIMIT 1')) DEFAULT_TEMPLATES.forEach(([channel, name, subject, body], i) => ctx.db.run('INSERT INTO message_templates (id, channel, name, subject, body, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('tpl'), channel, name, subject, body, i, ctx.now(), ctx.now()));
      ctx.db.run(`INSERT INTO settings (key, value) VALUES ('crm_templates_seeded', 'yes') ON CONFLICT(key) DO UPDATE SET value = 'yes'`);
    });
  }
  return { data: ctx.db.all('SELECT * FROM message_templates ORDER BY channel, sort, name'), placeholders: PLACEHOLDERS };
}
const PLACEHOLDERS = { '{first_name}': 'The parent\'s first name', '{athlete}': 'The athlete\'s first name', '{my_name}': 'Your name', '{business}': 'Your business name', '{book_link}': 'Your Book now page', '{join_link}': 'Family sign-up page' };
function templateInput(body, cur = {}) {
  const channel = v.oneOf(body.channel ?? cur.channel, 'channel', ['email', 'text']);
  const out = { channel, name: v.str(body.name ?? cur.name, 'name', { max: 80 }), body: v.str(body.body ?? cur.body, 'body', { max: channel === 'text' ? TEXT_MAX : EMAIL_MAX }) };
  out.subject = channel === 'email' ? v.str(body.subject ?? cur.subject, 'subject', { max: 150 }) : null;
  return out;
}
export function createTemplate(ctx, body) {
  listTemplates(ctx);
  const t = templateInput(body), id = newId('tpl');
  ctx.db.run('INSERT INTO message_templates (id, channel, name, subject, body, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM message_templates), ?, ?)', id, t.channel, t.name, t.subject, t.body, ctx.now(), ctx.now());
  return ctx.db.get('SELECT * FROM message_templates WHERE id = ?', id);
}
export function updateTemplate(ctx, id, body) {
  const cur = ctx.db.get('SELECT * FROM message_templates WHERE id = ?', id);
  if (!cur) throw notFound('Template');
  const t = templateInput({ ...body, channel: cur.channel }, cur);
  ctx.db.run('UPDATE message_templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?', t.name, t.subject, t.body, ctx.now(), id);
  return ctx.db.get('SELECT * FROM message_templates WHERE id = ?', id);
}
export function deleteTemplate(ctx, id) {
  if (!ctx.db.run('DELETE FROM message_templates WHERE id = ?', id).changes) throw notFound('Template');
  return { ok: true };
}
export function fillTemplate(ctx, text, { parentName, athleteName, user }) {
  const base = ctx.publicUrl ?? '';
  return String(text ?? '').replace(/\{first_name\}/g, first(parentName)).replace(/\{athlete\}/g, athleteName ? first(athleteName) : 'your athlete')
    .replace(/\{my_name\}/g, user?.name ? first(user.name) : biz(ctx)).replace(/\{business\}/g, biz(ctx))
    .replace(/\{book_link\}/g, `${base}/book`).replace(/\{join_link\}/g, `${base}/join`);
}
// What the message says, from a template (template_id) or typed, placeholders filled in.
function messageFrom(ctx, body, channel, who) {
  let subject = body.subject, text = body.body;
  if (body.template_id) {
    const t = ctx.db.get('SELECT * FROM message_templates WHERE id = ? AND channel = ?', String(body.template_id), channel);
    if (!t) throw notFound('Template');
    subject ??= t.subject; text ??= t.body;
  }
  const out = { body: fillTemplate(ctx, v.str(text, 'message (body)', { max: channel === 'text' ? TEXT_MAX : EMAIL_MAX }), who) };
  if (channel === 'email') out.subject = fillTemplate(ctx, v.str(subject, 'subject', { max: 150 }), who);
  return out;
}
// A text as it goes out: the business name first, and how to stop at the end.
export function textWithStop(ctx, body) {
  const name = biz(ctx);
  let t = body.trim();
  if (!t.toLowerCase().startsWith(name.toLowerCase())) t = `${name}: ${t}`;
  if (!/\bSTOP\b/i.test(t)) t = `${t} Reply STOP to stop.`;
  return t;
}
const TEST_NOTE = 'Texting isn\'t connected yet, so the text was saved in API & integrations → Texts, not sent.';
const textNote = (ctx, r) => (r.status === 'logged' ? TEST_NOTE : r.status === 'held' ? r.error : r.status === 'failed' ? `The text service refused it: ${r.error}` : null);

// ---------- Leads ----------
export function logLeadActivity(ctx, id, body, { user } = {}) {
  const l = getLead(ctx, id, { user });
  const kind = v.oneOf(body.kind ?? 'note', 'kind', ['note', 'call']);
  const outcome = kind === 'call' ? v.oneOf(body.outcome, 'outcome', Object.keys(CALL_OUTCOMES)) : null;
  const text = v.str(body.body, kind === 'call' ? 'what you talked about (body)' : 'note (body)', { max: 4000, optional: kind === 'call' });
  const act = logActivity(ctx, { leadId: l.id, familyId: l.family_id, clientId: l.client_id, kind, outcome, body: text, user });
  if (kind === 'call') {
    ctx.db.run('UPDATE leads SET last_contacted_at = ? WHERE id = ?', ctx.now(), l.id);
    if (l.status === 'new') moveStage(ctx, l, 'contacted', { user, reason: `Called: ${CALL_OUTCOMES[outcome].toLowerCase()}`, byName: user?.name ?? 'API' });
  }
  return { id: act.id, lead: getLead(ctx, l.id, { user }) };
}
export async function emailLead(ctx, id, body, { user } = {}) {
  const l = getLead(ctx, id, { user });
  const block = emailBlock(ctx, l.email);
  if (block) throw conflict(block);
  const m = messageFrom(ctx, body, 'email', { parentName: l.parent_name, athleteName: l.athlete_name, user });
  const act = logActivity(ctx, { leadId: l.id, familyId: l.family_id, clientId: l.client_id, kind: 'email', subject: m.subject, body: m.body, sentTo: l.email, withToken: true, user });
  const sent = await sendEmail(ctx, { to: l.email, subject: m.subject, text: m.body + emailFooter(ctx, act.token) });
  ctx.db.run('UPDATE lead_activity SET outcome = ? WHERE id = ?', sent.status, act.id);
  ctx.db.run('UPDATE leads SET last_contacted_at = ? WHERE id = ?', ctx.now(), l.id);
  if (l.status === 'new') moveStage(ctx, l, 'contacted', { user, reason: 'Emailed', byName: user?.name ?? 'API' });
  return { id: act.id, status: sent.status, sent_to: l.email, note: sent.status === 'logged' ? 'Email isn\'t connected yet, so the email was saved in the outbox, not sent.' : sent.error ?? null, lead: getLead(ctx, l.id, { user }) };
}
export async function textLead(ctx, id, body, { user } = {}) {
  const l = getLead(ctx, id, { user });
  const block = textBlock(ctx, l);
  if (block) throw conflict(block);
  const m = messageFrom(ctx, body, 'text', { parentName: l.parent_name, athleteName: l.athlete_name, user });
  const out = textWithStop(ctx, m.body);
  const r = await sendText(ctx, { to: l.phone, body: out, kind: 'crm', familyId: l.family_id ?? null });
  const act = logActivity(ctx, { leadId: l.id, familyId: l.family_id, clientId: l.client_id, kind: 'text', outcome: r.status, body: out, sentTo: normalizePhone(l.phone), user });
  ctx.db.run('UPDATE leads SET last_contacted_at = ? WHERE id = ?', ctx.now(), l.id);
  if (l.status === 'new') moveStage(ctx, l, 'contacted', { user, reason: 'Texted', byName: user?.name ?? 'API' });
  return { id: act.id, status: r.status, mode: smsMode(ctx), note: textNote(ctx, r), text: out, lead: getLead(ctx, l.id, { user }) };
}

// ---------- Families (from the client profile) ----------
function familyOf(ctx, clientId) {
  const c = ctx.db.get('SELECT id, name, family_id, email, phone FROM clients WHERE id = ?', String(clientId));
  if (!c) throw notFound('Client');
  return c;
}
export function logClientActivity(ctx, clientId, body, { user } = {}) {
  const c = familyOf(ctx, clientId);
  const kind = v.oneOf(body.kind ?? 'note', 'kind', ['note', 'call']);
  const outcome = kind === 'call' ? v.oneOf(body.outcome, 'outcome', Object.keys(CALL_OUTCOMES)) : null;
  const text = v.str(body.body, kind === 'call' ? 'what you talked about (body)' : 'note (body)', { max: 4000, optional: kind === 'call' });
  return { id: logActivity(ctx, { familyId: c.family_id, clientId: c.id, kind, outcome, body: text, user }).id };
}
// Who in a family can get an email or text: the parent picked (guardian_id) or, by default, the primary parent (emails)
// or every parent who turned texts on (texts). An athlete without a family is emailed at their own address.
function recipientsOf(ctx, c, guardianId) {
  if (!c.family_id) return [{ name: c.name, email: c.email, phone: c.phone, texts: false, guardian_id: null }];
  const gs = ctx.db.all('SELECT id, name, email, phone, sms_opt_in_at, sms_opt_out_at, is_primary FROM guardians WHERE family_id = ? ORDER BY is_primary DESC, created_at', c.family_id);
  const list = guardianId ? gs.filter((g) => g.id === String(guardianId)) : gs;
  if (guardianId && !list.length) throw notFound('Parent');
  return list.map((g) => ({ name: g.name, email: g.email, phone: g.phone, texts: !!g.sms_opt_in_at && !g.sms_opt_out_at, guardian_id: g.id }));
}
export async function emailClient(ctx, clientId, body, { user } = {}) {
  const c = familyOf(ctx, clientId);
  const to = recipientsOf(ctx, c, body.guardian_id)[0];
  if (!to) throw conflict('There\'s nobody to email in this family.');
  const block = emailBlock(ctx, to.email);
  if (block) throw conflict(block);
  const m = messageFrom(ctx, body, 'email', { parentName: to.name, athleteName: c.name, user });
  const act = logActivity(ctx, { familyId: c.family_id, clientId: c.id, kind: 'email', subject: m.subject, body: m.body, sentTo: to.email, withToken: true, user });
  const sent = await sendEmail(ctx, { to: to.email, subject: m.subject, text: m.body + emailFooter(ctx, act.token) });
  ctx.db.run('UPDATE lead_activity SET outcome = ? WHERE id = ?', sent.status, act.id);
  return { id: act.id, status: sent.status, sent_to: to.email, note: sent.status === 'logged' ? 'Email isn\'t connected yet, so the email was saved in the outbox, not sent.' : sent.error ?? null };
}
export async function textClient(ctx, clientId, body, { user } = {}) {
  const c = familyOf(ctx, clientId);
  const all = recipientsOf(ctx, c, body.guardian_id);
  const phones = [...new Set(all.filter((g) => g.texts).map((g) => normalizePhone(g.phone)).filter((p) => p && !numberStopped(ctx, p)))];
  if (!phones.length) throw conflict(c.family_id ? `${body.guardian_id ? 'This parent hasn\'t' : 'Nobody in the family has'} turned texts on (or they replied STOP). Parents turn texts on in the parent portal's Family tab.` : 'Texts go to parents who turned them on in the parent portal. This athlete has no family.');
  const m = messageFrom(ctx, body, 'text', { parentName: all[0]?.name, athleteName: c.name, user });
  const out = textWithStop(ctx, m.body);
  const results = [];
  for (const p of phones) results.push(await sendText(ctx, { to: p, body: out, kind: 'crm', familyId: c.family_id }));
  const worst = results.find((r) => r.status !== 'sent' && r.status !== 'logged') ?? results[0];
  const act = logActivity(ctx, { familyId: c.family_id, clientId: c.id, kind: 'text', outcome: worst.status, body: out, sentTo: phones.join(', '), user });
  return { id: act.id, status: worst.status, sent_to: phones, mode: smsMode(ctx), note: textNote(ctx, worst), text: out };
}
// What the contact panel needs to offer email and text: each parent, whether they can be emailed or texted and why not.
export function contactOptions(ctx, clientId) {
  const c = familyOf(ctx, clientId);
  return {
    recipients: recipientsOf(ctx, c).map((r) => {
      const phone = normalizePhone(r.phone);
      return { guardian_id: r.guardian_id, name: r.name, email: r.email, email_block: emailBlock(ctx, r.email),
        text_block: !c.family_id ? 'Texts go to parents who turned them on in the parent portal.' : !r.texts ? 'Hasn\'t turned texts on in the parent portal.' : !phone || numberStopped(ctx, phone) ? 'Replied STOP to our texts.' : null };
    }),
    text_max: TEXT_MAX, sms_mode: smsMode(ctx)
  };
}

// ---------- The "stop these emails" link in a CRM email ----------
export function followContactLink(ctx, tok, { stop = false } = {}) {
  const a = ctx.db.get('SELECT * FROM lead_activity WHERE token = ?', String(tok));
  if (!a || !a.sent_to) return { page: 'This link isn\'t in use any more.' };
  if (!stop) return { page: 'This link isn\'t in use any more.' };
  ctx.db.run('INSERT INTO email_optouts (email, created_at, source) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING', a.sent_to, ctx.now(), a.lead_id ? `lead:${a.lead_id}` : 'family');
  if (a.lead_id) ctx.db.run('UPDATE leads SET next_follow_up_at = NULL WHERE email = ?', a.sent_to);
  return { page: `Done. ${biz(ctx)} won't send you these emails any more. You'll still get receipts and booking emails if you train with us.` };
}

// ---------- Timeline ----------
// Newest first. For a lead: when it came in, stage changes, notes, calls, emails and texts (the automatic ones too, and
// replies from their phone), tasks and, once the family has an account, bookings, trials and memberships; payments for
// the owner only. For a client profile: the same for the family, plus the family's leads (a coach only the ones the
// owner gave them).
const money = (c) => `$${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
function actItem(a) {
  const byName = a.by_name ?? null;
  if (a.kind === 'note') return { at: a.at, kind: 'note', title: 'Note', body: a.body, by: byName };
  if (a.kind === 'call') return { at: a.at, kind: 'call', title: `Call: ${CALL_OUTCOMES[a.outcome] ?? 'logged'}`, body: a.body, by: byName, outcome: a.outcome };
  if (a.kind === 'email') return { at: a.at, kind: 'email', title: `Email: ${a.subject ?? ''}`, body: a.body, by: byName, outcome: a.outcome, to: a.sent_to };
  return { at: a.at, kind: 'text', title: 'Text sent', body: a.body, by: byName, outcome: a.outcome, to: a.sent_to };
}
function familyEvents(ctx, clientIds, role, since = '') {
  if (!clientIds.length) return [];
  const inList = clientIds.map(() => '?').join(',');
  const out = [];
  for (const b of ctx.db.all(`SELECT b.id, b.status, b.created_at, s.name, s.kind, s.starts_at, c.name AS client_name FROM bookings b JOIN class_sessions s ON s.id = b.session_id JOIN clients c ON c.id = b.client_id
      WHERE b.client_id IN (${inList}) AND b.created_at >= ? ORDER BY b.created_at DESC LIMIT 60`, ...clientIds, since)) {
    out.push({ at: b.created_at, kind: 'booking', title: `${b.status === 'waitlisted' ? 'Waitlisted for' : 'Booked'} ${b.name}`, body: `${b.client_name}${b.status === 'canceled' ? ' (canceled)' : b.status === 'attended' ? ' (came)' : b.status === 'no_show' ? ' (no-show)' : ''}`, session_starts_at: b.starts_at });
  }
  for (const s of ctx.db.all(`SELECT s.status, s.created_at, s.canceled_at, s.trial_ends_at, p.name AS plan, c.name AS client_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = s.client_id
      WHERE s.client_id IN (${inList}) AND (s.created_at >= ? OR s.canceled_at >= ?)`, ...clientIds, since, since)) {
    out.push({ at: s.created_at, kind: 'membership', title: `${s.trial_ends_at ? 'Started a free trial of' : 'Started'} ${s.plan}`, body: s.client_name });
    if (s.canceled_at) out.push({ at: s.canceled_at, kind: 'membership', title: `${s.plan} ended`, body: s.client_name });
  }
  if (role === 'owner') {
    for (const i of ctx.db.all(`SELECT i.amount_cents, i.paid_at, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.client_id IN (${inList}) AND i.status = 'paid' AND i.paid_at >= ?`, ...clientIds, since)) {
      out.push({ at: i.paid_at, kind: 'payment', title: `Membership payment ${money(i.amount_cents)}`, body: i.client_name, amount_cents: i.amount_cents });
    }
    for (const s of ctx.db.all(`SELECT s.amount_cents, s.discount_cents, COALESCE(s.completed_at, s.created_at) AS at, c.name AS client_name FROM sales s JOIN clients c ON c.id = s.client_id WHERE s.client_id IN (${inList}) AND s.status IN ('succeeded','partially_refunded','refunded') AND COALESCE(s.completed_at, s.created_at) >= ?`, ...clientIds, since)) {
      out.push({ at: s.at, kind: 'payment', title: `Paid ${money(s.amount_cents)} at the counter`, body: s.client_name, amount_cents: s.amount_cents });
    }
  }
  return out;
}
function leadItems(ctx, l) {
  const out = [{ at: l.created_at, kind: 'created', title: `Asked about training (${SOURCE_LABELS[l.source] ?? l.source})`, body: l.message ?? null, by: l.created_by ?? null }];
  for (const h of ctx.db.all('SELECT * FROM lead_stage_history WHERE lead_id = ? AND from_stage IS NOT NULL ORDER BY at', l.id)) {
    out.push({ at: h.at, kind: 'stage', title: `Moved to ${STAGE_LABELS[h.to_stage] ?? h.to_stage}`, body: [h.reason, h.to_stage === 'lost' && l.status === 'lost' && l.lost_reason ? `Why: ${LOST_REASONS[l.lost_reason] ?? l.lost_reason}${l.lost_note ? `. ${l.lost_note}` : ''}` : null].filter(Boolean).join('. ') || null, by: h.auto ? 'Automatic' : h.by_name });
  }
  for (const a of ctx.db.all('SELECT * FROM lead_activity WHERE lead_id = ? ORDER BY at', l.id)) out.push({ ...actItem(a), lead_id: l.id });
  const phone = normalizePhone(l.phone);
  if (phone) {
    for (const t of ctx.db.all(`SELECT direction, kind, body, status, created_at FROM texts WHERE phone = ? AND (direction = 'in' OR kind = 'lead') AND created_at >= ? ORDER BY created_at`, phone, l.created_at)) {
      out.push(t.direction === 'in' ? { at: t.created_at, kind: 'text_in', title: 'Text from them', body: t.body } : { at: t.created_at, kind: 'text', title: 'Automatic text', body: t.body, outcome: t.status, by: 'Automatic follow-up' });
    }
  }
  for (const t of ctx.db.all('SELECT t.*, u.name AS assignee FROM crm_tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.lead_id = ?', l.id)) {
    out.push({ at: t.created_at, kind: 'task', title: `Task: ${t.title}`, body: `Due ${t.due_date}${t.assignee ? ` · ${t.assignee}` : ''}`, by: t.created_by });
    if (t.done_at) out.push({ at: t.done_at, kind: 'task_done', title: `Done: ${t.title}`, by: t.done_by });
  }
  return out;
}
const newestFirst = (a, b) => String(b.at).localeCompare(String(a.at));
export function leadTimeline(ctx, id, { user } = {}) {
  const l = getLead(ctx, id, { user });
  const items = leadItems(ctx, l);
  const clientIds = l.family_id ? ctx.db.all('SELECT id FROM clients WHERE family_id = ?', l.family_id).map((c) => c.id) : [];
  if (l.client_id && !clientIds.includes(l.client_id)) clientIds.push(l.client_id);
  items.push(...familyEvents(ctx, clientIds, user?.role ?? 'owner', l.source === 'client' ? l.created_at : ''));
  return { data: items.sort(newestFirst).slice(0, 300) };
}
export function clientTimeline(ctx, clientId, { user, limit = 100 } = {}) {
  const c = familyOf(ctx, clientId);
  const role = user?.role ?? 'owner';
  const kids = c.family_id ? ctx.db.all('SELECT id FROM clients WHERE family_id = ?', c.family_id).map((k) => k.id) : [c.id];
  const inList = kids.map(() => '?').join(',');
  const items = [];
  for (const a of ctx.db.all(`SELECT * FROM lead_activity WHERE lead_id IS NULL AND (family_id IS ? AND family_id IS NOT NULL OR client_id IN (${inList}))`, c.family_id, ...kids)) items.push(actItem(a));
  const scope = leadScope(user);
  const leads = ctx.db.all(`SELECT l.* FROM leads l WHERE ${scope.sql} AND (l.client_id IN (${inList}) OR (l.family_id IS NOT NULL AND l.family_id IS ?))`, ...scope.args, ...kids, c.family_id);
  for (const l of leads) items.push(...leadItems(ctx, l).map((x) => ({ ...x, lead_id: l.id })));
  for (const t of ctx.db.all(`SELECT t.*, u.name AS assignee FROM crm_tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.lead_id IS NULL AND (t.family_id IS ? AND t.family_id IS NOT NULL OR t.client_id IN (${inList}))`, c.family_id, ...kids)) {
    items.push({ at: t.created_at, kind: 'task', title: `Task: ${t.title}`, body: `Due ${t.due_date}${t.assignee ? ` · ${t.assignee}` : ''}`, by: t.created_by });
    if (t.done_at) items.push({ at: t.done_at, kind: 'task_done', title: `Done: ${t.title}`, by: t.done_by });
  }
  if (c.family_id) for (const t of ctx.db.all(`SELECT direction, kind, body, status, created_at FROM texts WHERE family_id = ? AND kind != 'crm' ORDER BY created_at DESC LIMIT 50`, c.family_id)) {
    items.push(t.direction === 'in' ? { at: t.created_at, kind: 'text_in', title: 'Text from the family', body: t.body } : { at: t.created_at, kind: 'text', title: 'Automatic text', body: t.body, outcome: t.status });
  }
  items.push(...familyEvents(ctx, kids, role));
  const n = Math.min(Math.max(Number(limit) || 100, 1), 300);
  return { data: items.sort(newestFirst).slice(0, n), leads: leads.map((l) => ({ id: l.id, parent_name: l.parent_name, status: l.status, stage_label: STAGE_LABELS[l.status] })), ...contactOptions(ctx, clientId) };
}
export { CALL_OUTCOMES, US_MOBILE };
