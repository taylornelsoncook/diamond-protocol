import { newId, token, v, notFound, conflict, badRequest, ageOn } from '../util.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';
import { sendText, normalizePhone, numberStopped } from './sms.js';
import { STAGES, STAGE_LABELS, US_MOBILE } from './leads.js';
import { textWithStop, TEXT_MAX } from './contact.js';

// Announcement emails to a group: camp registration opening, a closure, a new class. The owner picks who gets it
// (everyone, members, lapsed members, families without a membership, or families who asked about training),
// narrowed by athlete age and sport. Every email has a one-click "stop these emails" link and the business
// address, and links in it are counted when clicked (opens can't be counted reliably, so we don't pretend to).
// Parents who asked to stop, and families with an open deletion request, are never included.

const GROUPS = ['everyone', 'members', 'lapsed', 'no_membership', 'trial_ended', 'leads'];
const CHANNELS = ['email', 'text'];
const DAY = 86400000;
const first = (name) => String(name ?? '').trim().split(/\s+/)[0];

// Version 45 (CRM): a group message can be a text (to parents who turned texts on, and leads who said texts are OK and
// haven't texted STOP), the leads group can pick its stages (new and contacted unless chosen), families whose free trial
// ended without joining are a group, and the preview says who is left out and why.
function audienceInput(a = {}) {
  const group = v.oneOf(a.group ?? 'everyone', 'group', GROUPS);
  const ageMin = a.age_min === undefined || a.age_min === null || a.age_min === '' ? null : v.int(a.age_min, 'age_min', { min: 3, max: 99 });
  const ageMax = a.age_max === undefined || a.age_max === null || a.age_max === '' ? null : v.int(a.age_max, 'age_max', { min: 3, max: 99 });
  if (ageMin != null && ageMax != null && ageMin > ageMax) throw badRequest('The youngest age is higher than the oldest. Swap them.');
  const out = { group, age_min: ageMin, age_max: ageMax, sport: v.str(a.sport, 'sport', { max: 40, optional: true }) };
  if (group === 'leads' && a.stages !== undefined && a.stages !== null) {
    if (!Array.isArray(a.stages) || !a.stages.length || a.stages.some((x) => !STAGES.includes(x))) throw badRequest(`stages must be a list of: ${STAGES.join(', ')}.`);
    out.stages = [...new Set(a.stages)];
  }
  return out;
}
const DEFAULT_LEAD_STAGES = ['new', 'contacted'];
export const describeAudience = (a) => {
  const who = { everyone: 'All families', members: 'Members', lapsed: 'Lapsed members', no_membership: 'Families without a membership', trial_ended: 'Families whose free trial ended without joining', leads: 'Families who asked about training' }[a.group];
  const stages = a.group === 'leads' && a.stages ? `(${a.stages.map((x) => STAGE_LABELS[x].toLowerCase()).join(', ')})` : null;
  const ages = a.age_min != null && a.age_max != null ? `ages ${a.age_min}–${a.age_max}` : a.age_min != null ? `ages ${a.age_min}+` : a.age_max != null ? `up to age ${a.age_max}` : null;
  return [[who, stages].filter(Boolean).join(' '), ages, a.sport ? a.sport : null].filter(Boolean).join(', ');
};

// Everyone the group matches, one row per person we could contact (each parent of a family, an athlete without a family,
// or a lead), with what we know about reaching them. Archived athletes and families with an open deletion request are
// matched too, so the preview can say they're left out.
function matched(ctx, a) {
  const people = [];
  const fits = (age, sport) => !(a.age_min != null && (age == null || age < a.age_min)) && !(a.age_max != null && (age == null || age > a.age_max))
    && !(a.sport && !String(sport ?? '').toLowerCase().includes(a.sport.toLowerCase()));
  if (a.group === 'leads') {
    const stages = a.stages ?? DEFAULT_LEAD_STAGES;
    for (const l of ctx.db.all(`SELECT id, parent_name, email, phone, texts_ok, athlete_age, sport FROM leads WHERE status IN (${stages.map(() => '?').join(',')}) ORDER BY created_at DESC`, ...stages)) {
      if (!fits(l.athlete_age, l.sport)) continue;
      people.push({ lead_id: l.id, name: l.parent_name, email: l.email, phone: l.phone, texts_on: !!l.texts_ok, lead: true });
    }
    return people;
  }
  const now = ctx.now(), yearAgo = new Date(Date.now() - 365 * DAY).toISOString(), halfYear = new Date(Date.now() - 183 * DAY).toISOString();
  const deleting = new Set(ctx.db.all(`SELECT family_id FROM data_requests WHERE status = 'open' AND family_id IS NOT NULL`).map((r) => r.family_id));
  const athletes = ctx.db.all(`SELECT c.id, c.name, c.email, c.phone, c.birth_date, c.sport, c.family_id, c.archived_at,
      (SELECT status FROM subscriptions s WHERE s.client_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS sub_status,
      (SELECT canceled_at FROM subscriptions s WHERE s.client_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS canceled_at,
      (SELECT trial_ends_at FROM subscriptions s WHERE s.client_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS trial_ends_at,
      (SELECT COUNT(*) FROM invoices i WHERE i.client_id = c.id AND i.status = 'paid') AS paid
    FROM clients c WHERE c.name != 'Deleted athlete' ORDER BY c.name`);
  for (const c of athletes) {
    const member = ['active', 'trialing', 'past_due', 'paused'].includes(c.sub_status);
    if (a.group === 'members' && !member) continue;
    if (a.group === 'lapsed' && !(c.sub_status === 'canceled' && (c.canceled_at ?? '') >= yearAgo)) continue;
    if (a.group === 'no_membership' && member) continue;
    // A free trial that ended (canceled, never paid) in the last six months.
    if (a.group === 'trial_ended' && !(c.sub_status === 'canceled' && c.trial_ends_at && !c.paid && (c.canceled_at ?? '') >= halfYear)) continue;
    if (!fits(ageOn(c.birth_date, now), c.sport)) continue;
    const extra = { client_id: c.id, archived: !!c.archived_at, deleting: !!c.family_id && deleting.has(c.family_id) };
    if (c.family_id) for (const g of ctx.db.all('SELECT name, email, phone, sms_opt_in_at, sms_opt_out_at FROM guardians WHERE family_id = ? ORDER BY is_primary DESC', c.family_id)) {
      people.push({ ...extra, family_id: c.family_id, name: g.name, email: g.email, phone: g.phone, texts_on: !!g.sms_opt_in_at && !g.sms_opt_out_at });
    } else people.push({ ...extra, name: c.name, email: c.email, phone: c.phone, texts_on: false, no_family: true });
  }
  return people;
}
// Who a group message would go to right now (one row per email address, or per phone number for a text) and who is left
// out, with why.
export function audienceFor(ctx, audience, channel = 'email') {
  const a = audienceInput(audience);
  v.oneOf(channel, 'channel', CHANNELS);
  const optedOut = new Set(ctx.db.all('SELECT email FROM email_optouts').map((r) => r.email.toLowerCase()));
  const list = [], left = [], seen = new Set(), leftSeen = new Set();
  const leave = (p, reason) => { const k = `${p.name}|${reason}`; if (!leftSeen.has(k)) { leftSeen.add(k); left.push({ name: p.name, reason, lead_id: p.lead_id ?? null, client_id: p.client_id ?? null }); } };
  for (const p of matched(ctx, a)) {
    if (p.archived) { leave(p, 'Archived'); continue; }
    if (p.deleting) { leave(p, 'Asked for their data to be deleted'); continue; }
    if (channel === 'email') {
      const e = String(p.email ?? '').trim().toLowerCase();
      if (!e) { leave(p, 'No email'); continue; }
      if (optedOut.has(e)) { leave(p, 'Asked us to stop emailing'); continue; }
      if (seen.has(e)) continue;
      seen.add(e);
      list.push({ ...p, email: e });
    } else {
      const phone = normalizePhone(p.phone);
      if (!phone) { leave(p, 'No mobile number'); continue; }
      if (p.no_family) { leave(p, 'No parent account (texts go to parents who turned them on)'); continue; }
      if (!p.texts_on) { leave(p, p.lead ? 'Hasn\'t said texts are OK' : 'Hasn\'t turned texts on'); continue; }
      if (p.lead && !US_MOBILE.test(phone)) { leave(p, 'Not a US mobile number'); continue; }
      if (numberStopped(ctx, phone)) { leave(p, 'Texted STOP'); continue; }
      if (seen.has(phone)) continue;
      seen.add(phone);
      list.push({ ...p, phone });
    }
  }
  // Someone left out as one person but reached as another (a parent of two athletes, say) isn't left out.
  const reached = new Set(list.map((p) => p.name));
  return { list, left: left.filter((x) => !reached.has(x.name)), audience: a };
}
export function recipients(ctx, audience, channel = 'email') { return audienceFor(ctx, audience, channel).list; }

export function previewAudience(ctx, audience, channel = 'email') {
  const { list, left, audience: a } = audienceFor(ctx, audience, channel);
  const reasons = {};
  for (const x of left) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
  return { count: list.length, channel, description: describeAudience(a), sample: list.slice(0, 8).map((r) => r.name),
    left_out: { count: left.length, reasons, people: left.slice(0, 50) } };
}

const shape = (ctx, c) => {
  const stats = ctx.db.get('SELECT COUNT(*) AS sent, COUNT(clicked_at) AS clicked, COUNT(unsubscribed_at) AS stopped FROM campaign_recipients WHERE campaign_id = ?', c.id);
  const audience = JSON.parse(c.audience);
  return { id: c.id, channel: c.channel ?? 'email', subject: c.subject, body: c.body, audience, audience_text: describeAudience(audience), status: c.status, created_by: c.created_by, created_at: c.created_at, sent_at: c.sent_at, ...stats };
};
export function listCampaigns(ctx) { return ctx.db.all('SELECT * FROM campaigns ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 100').map((c) => shape(ctx, c)); }
export function getCampaign(ctx, id) {
  const c = ctx.db.get('SELECT * FROM campaigns WHERE id = ?', id);
  if (!c) throw notFound('Email');
  return shape(ctx, c);
}
// A text has no subject: the list shows its first words instead.
function content(body) {
  const channel = v.oneOf(body.channel ?? 'email', 'channel', CHANNELS);
  const text = v.str(body.body, 'body', { max: channel === 'text' ? TEXT_MAX : 20000 });
  return {
    channel,
    subject: channel === 'text' ? (text.length > 60 ? `${text.slice(0, 57)}...` : text) : v.str(body.subject, 'subject', { max: 120 }),
    body: text,
    audience: JSON.stringify(audienceInput(body.audience))
  };
}
export function createCampaign(ctx, body, actor) {
  const c = content(body), id = newId('cmp');
  ctx.db.run(`INSERT INTO campaigns (id, channel, subject, body, audience, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`, id, c.channel, c.subject, c.body, c.audience, actor ?? null, ctx.now());
  return getCampaign(ctx, id);
}
export function updateCampaign(ctx, id, body) {
  const cur = getCampaign(ctx, id);
  if (cur.status !== 'draft') throw conflict('This message was already sent. Make a copy to change it.');
  const c = content({ channel: body.channel ?? cur.channel, subject: body.subject ?? cur.subject, body: body.body ?? cur.body, audience: body.audience ?? cur.audience });
  ctx.db.run('UPDATE campaigns SET channel = ?, subject = ?, body = ?, audience = ? WHERE id = ?', c.channel, c.subject, c.body, c.audience, id);
  return getCampaign(ctx, id);
}
export function copyCampaign(ctx, id, actor) {
  const c = getCampaign(ctx, id);
  return createCampaign(ctx, { channel: c.channel, subject: c.subject, body: c.body, audience: c.audience }, actor);
}
export function deleteCampaign(ctx, id) {
  if (getCampaign(ctx, id).status !== 'draft') throw conflict('Sent emails stay in the list so you can see who got them.');
  ctx.db.run('DELETE FROM campaigns WHERE id = ?', id);
  return { ok: true };
}

// The email as one person gets it: {first_name} filled in, links counted, and the stop link and address at the end.
const LINK = /https?:\/\/[^\s<>"')]+[^\s<>"').,!?;:]/g;
function render(ctx, c, r, tok) {
  const base = ctx.publicUrl ?? '';
  let i = 0;
  const links = [];
  const text = c.body.replace(/\{first_name\}/g, first(r.name) || 'there').replace(LINK, (url) => { links.push(url); return tok ? `${base}/c/${tok}/${i++}` : url; });
  const address = getSetting(ctx, 'business_address');
  const footer = `\n\n--\n${getSetting(ctx, 'business_name')}${address ? `\n${address}` : ''}\nYou're getting this because your family trains with us${r.lead_id ? ' or asked about training' : ''}. Stop these emails: ${tok ? `${base}/c/${tok}?stop=1` : '(link to stop)'}`;
  return { subject: c.subject.replace(/\{first_name\}/g, first(r.name) || 'there'), text: text + footer, links };
}

export async function sendTest(ctx, id, user) {
  const c = getCampaign(ctx, id);
  if (c.channel === 'text') throw badRequest('Test sends are for emails. Check a text in the preview before sending it.');
  const to = v.email(user?.email, 'your email');
  const m = render(ctx, c, { name: user.name }, null);
  await sendEmail(ctx, { to, subject: `[Test] ${m.subject}`, text: m.text });
  return { sent_to: to };
}

// Sending needs the number of people it will go to, as a check that it's going to the group you meant.
export async function sendCampaign(ctx, id, body = {}) {
  const c = getCampaign(ctx, id);
  if (c.status !== 'draft') throw conflict('This email was already sent.');
  const list = recipients(ctx, c.audience, c.channel);
  if (!list.length) throw conflict(c.channel === 'text' ? 'Nobody in this group can get texts. Change who it goes to, or send an email.' : 'Nobody matches this group. Change who it goes to.');
  if (Number(body.confirm_count) !== list.length) throw conflict(`This will go to ${list.length} ${list.length === 1 ? 'person' : 'people'}. Confirm that number to send.`);
  const claimed = ctx.db.run(`UPDATE campaigns SET status = 'sending' WHERE id = ? AND status = 'draft'`, id);
  if (!claimed.changes) throw conflict('This email is already being sent.');
  let sent = 0;
  try {
    for (const r of list) {
      const tok = token(12);
      if (c.channel === 'text') {
        const body = textWithStop(ctx, c.body.replace(/\{first_name\}/g, first(r.name) || 'there'));
        ctx.db.run('INSERT INTO campaign_recipients (id, campaign_id, email, phone, name, family_id, client_id, lead_id, token, links, sent_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)',
          newId('cr'), id, r.phone, r.name ?? null, r.family_id ?? null, r.client_id ?? null, r.lead_id ?? null, tok, ctx.now());
        await sendText(ctx, { to: r.phone, body, kind: 'group', familyId: r.family_id ?? null }).catch((e) => console.error('text', e.message));
        sent++;
        continue;
      }
      const m = render(ctx, c, r, tok);
      ctx.db.run('INSERT INTO campaign_recipients (id, campaign_id, email, name, family_id, client_id, lead_id, token, links, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId('cr'), id, r.email, r.name ?? null, r.family_id ?? null, r.client_id ?? null, r.lead_id ?? null, tok, JSON.stringify(m.links), ctx.now());
      await sendEmail(ctx, { to: r.email, subject: m.subject, text: m.text });
      sent++;
    }
  } finally {
    ctx.db.run(`UPDATE campaigns SET status = 'sent', sent_at = ? WHERE id = ?`, ctx.now(), id);
  }
  return { ...getCampaign(ctx, id), sent };
}

// The links in the email: count the click and go on, or stop all announcement emails to that address.
export function followCampaignLink(ctx, tok, index, { stop = false } = {}) {
  const r = ctx.db.get('SELECT * FROM campaign_recipients WHERE token = ?', String(tok));
  if (!r) return { page: 'This link isn\'t in use any more.' };
  if (stop) {
    ctx.db.run('UPDATE campaign_recipients SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?', ctx.now(), r.id);
    ctx.db.run('INSERT INTO email_optouts (email, created_at, source) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING', r.email, ctx.now(), r.campaign_id);
    return { page: `Done. ${getSetting(ctx, 'business_name')} won't send you announcement emails any more. You'll still get receipts and booking emails.` };
  }
  const url = JSON.parse(r.links ?? '[]')[Number(index)];
  if (!url) return { page: 'This link isn\'t in use any more.' };
  ctx.db.run('UPDATE campaign_recipients SET clicked_at = COALESCE(clicked_at, ?) WHERE id = ?', ctx.now(), r.id);
  return { redirect: url };
}
