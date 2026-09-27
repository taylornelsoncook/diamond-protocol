import { newId, token, v, notFound, conflict, badRequest, ageOn } from '../util.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';

// Announcement emails to a group: camp registration opening, a closure, a new class. The owner picks who gets it
// (everyone, members, lapsed members, families without a membership, or families who asked about training),
// narrowed by athlete age and sport. Every email has a one-click "stop these emails" link and the business
// address, and links in it are counted when clicked (opens can't be counted reliably, so we don't pretend to).
// Parents who asked to stop, and families with an open deletion request, are never included.

const GROUPS = ['everyone', 'members', 'lapsed', 'no_membership', 'leads'];
const DAY = 86400000;
const first = (name) => String(name ?? '').trim().split(/\s+/)[0];

function audienceInput(a = {}) {
  const group = v.oneOf(a.group ?? 'everyone', 'group', GROUPS);
  const ageMin = a.age_min === undefined || a.age_min === null || a.age_min === '' ? null : v.int(a.age_min, 'age_min', { min: 3, max: 99 });
  const ageMax = a.age_max === undefined || a.age_max === null || a.age_max === '' ? null : v.int(a.age_max, 'age_max', { min: 3, max: 99 });
  if (ageMin != null && ageMax != null && ageMin > ageMax) throw badRequest('The youngest age is higher than the oldest. Swap them.');
  return { group, age_min: ageMin, age_max: ageMax, sport: v.str(a.sport, 'sport', { max: 40, optional: true }) };
}
export const describeAudience = (a) => {
  const who = { everyone: 'All families', members: 'Members', lapsed: 'Lapsed members', no_membership: 'Families without a membership', leads: 'Families who asked about training' }[a.group];
  const ages = a.age_min != null && a.age_max != null ? `ages ${a.age_min}–${a.age_max}` : a.age_min != null ? `ages ${a.age_min}+` : a.age_max != null ? `up to age ${a.age_max}` : null;
  return [who, ages, a.sport ? a.sport : null].filter(Boolean).join(', ');
};

// Who a campaign would go to right now: one row per email address.
export function recipients(ctx, audience) {
  const a = audienceInput(audience);
  const optedOut = new Set(ctx.db.all('SELECT email FROM email_optouts').map((r) => r.email.toLowerCase()));
  const byEmail = new Map();
  const add = (email, row) => { const e = String(email ?? '').trim().toLowerCase(); if (e && !optedOut.has(e) && !byEmail.has(e)) byEmail.set(e, { ...row, email: e }); };
  if (a.group === 'leads') {
    for (const l of ctx.db.all(`SELECT id, parent_name, email, athlete_age, sport FROM leads WHERE status IN ('new','contacted') AND email IS NOT NULL ORDER BY created_at DESC`)) {
      if (a.age_min != null && (l.athlete_age == null || l.athlete_age < a.age_min)) continue;
      if (a.age_max != null && (l.athlete_age == null || l.athlete_age > a.age_max)) continue;
      if (a.sport && !String(l.sport ?? '').toLowerCase().includes(a.sport.toLowerCase())) continue;
      add(l.email, { lead_id: l.id, name: l.parent_name });
    }
    return [...byEmail.values()];
  }
  const now = ctx.now(), yearAgo = new Date(Date.now() - 365 * DAY).toISOString();
  const athletes = ctx.db.all(`SELECT c.id, c.name, c.email, c.birth_date, c.sport, c.family_id,
      (SELECT status FROM subscriptions s WHERE s.client_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS sub_status,
      (SELECT canceled_at FROM subscriptions s WHERE s.client_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS canceled_at
    FROM clients c WHERE c.archived_at IS NULL AND (c.family_id IS NULL OR c.family_id NOT IN (SELECT family_id FROM data_requests WHERE status = 'open' AND family_id IS NOT NULL)) ORDER BY c.name`);
  for (const c of athletes) {
    const member = ['active', 'trialing', 'past_due', 'paused'].includes(c.sub_status);
    if (a.group === 'members' && !member) continue;
    if (a.group === 'lapsed' && !(c.sub_status === 'canceled' && (c.canceled_at ?? '') >= yearAgo)) continue;
    if (a.group === 'no_membership' && member) continue;
    const age = ageOn(c.birth_date, now);
    if (a.age_min != null && (age == null || age < a.age_min)) continue;
    if (a.age_max != null && (age == null || age > a.age_max)) continue;
    if (a.sport && !String(c.sport ?? '').toLowerCase().includes(a.sport.toLowerCase())) continue;
    if (c.family_id) for (const g of ctx.db.all('SELECT name, email FROM guardians WHERE family_id = ? ORDER BY is_primary DESC', c.family_id)) add(g.email, { family_id: c.family_id, client_id: c.id, name: g.name });
    else add(c.email, { client_id: c.id, name: c.name });
  }
  return [...byEmail.values()];
}

export function previewAudience(ctx, audience) {
  const list = recipients(ctx, audience);
  return { count: list.length, description: describeAudience(audienceInput(audience)), sample: list.slice(0, 8).map((r) => r.name) };
}

const shape = (ctx, c) => {
  const stats = ctx.db.get('SELECT COUNT(*) AS sent, COUNT(clicked_at) AS clicked, COUNT(unsubscribed_at) AS stopped FROM campaign_recipients WHERE campaign_id = ?', c.id);
  const audience = JSON.parse(c.audience);
  return { id: c.id, subject: c.subject, body: c.body, audience, audience_text: describeAudience(audience), status: c.status, created_by: c.created_by, created_at: c.created_at, sent_at: c.sent_at, ...stats };
};
export function listCampaigns(ctx) { return ctx.db.all('SELECT * FROM campaigns ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 100').map((c) => shape(ctx, c)); }
export function getCampaign(ctx, id) {
  const c = ctx.db.get('SELECT * FROM campaigns WHERE id = ?', id);
  if (!c) throw notFound('Email');
  return shape(ctx, c);
}
function content(body) {
  return {
    subject: v.str(body.subject, 'subject', { max: 120 }),
    body: v.str(body.body, 'body', { max: 20000 }),
    audience: JSON.stringify(audienceInput(body.audience))
  };
}
export function createCampaign(ctx, body, actor) {
  const c = content(body), id = newId('cmp');
  ctx.db.run(`INSERT INTO campaigns (id, subject, body, audience, status, created_by, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)`, id, c.subject, c.body, c.audience, actor ?? null, ctx.now());
  return getCampaign(ctx, id);
}
export function updateCampaign(ctx, id, body) {
  const cur = getCampaign(ctx, id);
  if (cur.status !== 'draft') throw conflict('This email was already sent. Make a copy to change it.');
  const c = content({ subject: body.subject ?? cur.subject, body: body.body ?? cur.body, audience: body.audience ?? cur.audience });
  ctx.db.run('UPDATE campaigns SET subject = ?, body = ?, audience = ? WHERE id = ?', c.subject, c.body, c.audience, id);
  return getCampaign(ctx, id);
}
export function copyCampaign(ctx, id, actor) {
  const c = getCampaign(ctx, id);
  return createCampaign(ctx, { subject: c.subject, body: c.body, audience: c.audience }, actor);
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
  const to = v.email(user?.email, 'your email');
  const m = render(ctx, c, { name: user.name }, null);
  await sendEmail(ctx, { to, subject: `[Test] ${m.subject}`, text: m.text });
  return { sent_to: to };
}

// Sending needs the number of people it will go to, as a check that it's going to the group you meant.
export async function sendCampaign(ctx, id, body = {}) {
  const c = getCampaign(ctx, id);
  if (c.status !== 'draft') throw conflict('This email was already sent.');
  const list = recipients(ctx, c.audience);
  if (!list.length) throw conflict('Nobody matches this group. Change who it goes to.');
  if (Number(body.confirm_count) !== list.length) throw conflict(`This will go to ${list.length} ${list.length === 1 ? 'person' : 'people'}. Confirm that number to send.`);
  const claimed = ctx.db.run(`UPDATE campaigns SET status = 'sending' WHERE id = ? AND status = 'draft'`, id);
  if (!claimed.changes) throw conflict('This email is already being sent.');
  let sent = 0;
  try {
    for (const r of list) {
      const tok = token(12);
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
