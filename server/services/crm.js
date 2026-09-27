// CRM: leads (people who aren't clients yet), the pipeline and its automatic moves, tasks, the timeline, emails and
// texts to leads and families (templates, segments, unsubscribe), website enquiries, CSV import, and reports.
// Schema is created here and upgraded in place on start (routes and seeds load this module).
'use strict';
const crypto = require('crypto');
const { db, get, all, run, insert, update, tx, setting, setSetting } = require('../db');
const { bad, notFound, HttpError, emit, sendEmail, today, addDays, appUrl, businessName, money, randomToken } = require('../lib');
const messaging = require('../messaging');
require('./clients'); // client_notes, athlete phone and grad year

db.exec(`CREATE TABLE IF NOT EXISTS crm_leads (
  id INTEGER PRIMARY KEY, parent_name TEXT NOT NULL, email TEXT COLLATE NOCASE, phone TEXT,
  athletes TEXT NOT NULL DEFAULT '[]', sport TEXT, position TEXT,
  source TEXT NOT NULL DEFAULT 'other', source_detail TEXT, interest TEXT, notes TEXT,
  owner_id INTEGER REFERENCES staff(id), stage TEXT NOT NULL DEFAULT 'new', lost_reason TEXT, lost_note TEXT,
  stage_changed_at TEXT DEFAULT (datetime('now')), last_activity_at TEXT DEFAULT (datetime('now')), first_contact TEXT,
  family_id INTEGER REFERENCES families(id), family_linked_on TEXT, converted_at TEXT, reengaged INTEGER DEFAULT 0,
  email_opt_out INTEGER DEFAULT 0, email_opt_out_at TEXT,
  sms_opt_in INTEGER DEFAULT 0, sms_opt_in_at TEXT, sms_opt_in_source TEXT, sms_opt_out INTEGER DEFAULT 0, sms_opt_out_at TEXT,
  created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS crm_leads_stage ON crm_leads(stage);
CREATE INDEX IF NOT EXISTS crm_leads_email ON crm_leads(email);
CREATE INDEX IF NOT EXISTS crm_leads_phone ON crm_leads(phone);
CREATE INDEX IF NOT EXISTS crm_leads_family ON crm_leads(family_id);

-- Everything that happens with a lead or family: notes, calls, emails, stage changes, bookings from the CRM.
CREATE TABLE IF NOT EXISTS crm_activities (
  id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES crm_leads(id) ON DELETE CASCADE, family_id INTEGER REFERENCES families(id),
  kind TEXT NOT NULL, outcome TEXT, body TEXT, meta TEXT, staff_id INTEGER, staff_name TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS crm_act_lead ON crm_activities(lead_id);
CREATE INDEX IF NOT EXISTS crm_act_family ON crm_activities(family_id);

CREATE TABLE IF NOT EXISTS crm_stage_changes (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE, from_stage TEXT, to_stage TEXT NOT NULL,
  auto INTEGER DEFAULT 0, staff_name TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS crm_stage_lead ON crm_stage_changes(lead_id);

CREATE TABLE IF NOT EXISTS crm_tasks (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_date TEXT NOT NULL, assignee_id INTEGER NOT NULL REFERENCES staff(id),
  lead_id INTEGER REFERENCES crm_leads(id) ON DELETE CASCADE, family_id INTEGER REFERENCES families(id),
  done_at TEXT, done_by TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS crm_tasks_assignee ON crm_tasks(assignee_id, done_at);`);

// An evaluation booked for a lead before they're a client: the session exists, the athlete doesn't yet.
const eventCols = all('PRAGMA table_info(events)').map((c) => c.name);
if (!eventCols.includes('lead_id')) db.exec('ALTER TABLE events ADD COLUMN lead_id INTEGER');
// Parents who unsubscribed from CRM emails (group emails leave them out).
const parentCols = all('PRAGMA table_info(parents)').map((c) => c.name);
if (!parentCols.includes('email_opt_out')) db.exec('ALTER TABLE parents ADD COLUMN email_opt_out INTEGER DEFAULT 0');
if (!parentCols.includes('email_opt_out_at')) db.exec('ALTER TABLE parents ADD COLUMN email_opt_out_at TEXT');

// ---- vocabulary ----
const STAGES = [['new', 'New'], ['contacted', 'Contacted'], ['evaluation', 'Evaluation booked'], ['trial', 'Trial'], ['member', 'Member'], ['lost', 'Lost']];
const STAGE_KEYS = STAGES.map((s) => s[0]);
const OPEN_STAGES = ['new', 'contacted', 'evaluation', 'trial'];
const RANK = { new: 0, contacted: 1, evaluation: 2, trial: 3, member: 4, lost: -1 };
const SOURCES = [['website', 'Website form'], ['phone', 'Phone call'], ['walk_in', 'Walk-in'], ['referral', 'Referral'], ['camp', 'Camp'], ['team', 'Team or school'], ['social', 'Social media'], ['other', 'Other']];
const INTERESTS = [['evaluation', 'Evaluation'], ['group', 'Group training'], ['privates', 'Private lessons'], ['team', 'Team training'], ['camp', 'Camp']];
const LOST_REASONS = [['price', 'Price'], ['schedule', 'Schedule'], ['distance', 'Distance'], ['elsewhere', 'Went elsewhere'], ['no_response', 'No response'], ['other', 'Other']];
const OUTCOMES = [['reached', 'Reached'], ['voicemail', 'Left a voicemail'], ['no_answer', 'No answer']];
const label = (list, k) => list.find((x) => x[0] === k)?.[1] || k || '';
const STALE_DAYS = 7;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v, max = 200) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
const cleanText = (v, max = 2000) => { const s = String(v ?? '').trim(); return s || null; };
const nowUtc = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && addDays(d, 0) === d;
const daysBetween = (a, b) => Math.round((Date.parse(String(b).slice(0, 10) + 'T12:00:00Z') - Date.parse(String(a).slice(0, 10) + 'T12:00:00Z')) / 864e5);
const utcToDate = (t) => String(t || '').slice(0, 10);
const fullName = (a) => `${a.first_name} ${a.last_name}`;
const staffOf = (req) => req?.staff || null;

// ---- templates (editable in CRM settings; {first_name} {athlete} {business} {staff} fill in per person) ----
const DEFAULT_TEMPLATES = [
  { key: 'enquiry', name: 'After an enquiry', subject: 'Thanks for getting in touch with {business}',
    body: 'Hi {first_name},\n\nThanks for reaching out about training for {athlete}. The best first step is an evaluation: 30 minutes where a coach tests speed, power and movement, then talks through a plan.\n\nReply with a couple of times that work, or call us, and we will get it booked.\n\n{staff}\n{business}' },
  { key: 'evaluation', name: 'After an evaluation', subject: 'Next steps for {athlete}',
    body: 'Hi {first_name},\n\nThanks for bringing {athlete} in for the evaluation. The results are a good starting point and we know what to work on first.\n\nThe next step is a free trial week of group training. Reply and we will set it up.\n\n{staff}\n{business}' },
  { key: 'trial_ending', name: 'Trial ending', subject: '{athlete}\'s trial ends soon',
    body: 'Hi {first_name},\n\n{athlete}\'s free trial ends in a few days. If you want to keep going, there is nothing to do: the membership starts on its own. If you have questions about the plan or the schedule, reply here.\n\n{staff}\n{business}' },
  { key: 'winback', name: 'Win-back', subject: 'Come back and train with {business}',
    body: 'Hi {first_name},\n\nIt has been a while. We have new class times this season and would like to see {athlete} back in the building.\n\nReply and we will find a time that fits your schedule.\n\n{staff}\n{business}' },
];
function templates() {
  const saved = setting('crm_templates', null);
  if (!Array.isArray(saved)) return DEFAULT_TEMPLATES.map((t) => ({ ...t }));
  return DEFAULT_TEMPLATES.map((d) => ({ ...d, ...(saved.find((s) => s.key === d.key) || {}), key: d.key }));
}
function saveTemplates(list) {
  if (!Array.isArray(list)) throw bad('Send the templates to save.');
  const out = DEFAULT_TEMPLATES.map((d) => {
    const t = list.find((x) => x && x.key === d.key);
    if (!t) return { ...d };
    const name = clean(t.name, 60), subject = clean(t.subject, 150), body = cleanText(t.body);
    if (!name) throw bad('Give every template a name.');
    if (!subject) throw bad(`Give "${name}" a subject.`);
    if (!body) throw bad(`Write the message for "${name}".`);
    if (body.length > 5000) throw bad(`Keep "${name}" under 5,000 characters.`);
    return { key: d.key, name, subject, body };
  });
  setSetting('crm_templates', out);
  return out;
}
function fill(text, vars) {
  return String(text || '').replace(/\{(first_name|athlete|business|staff)\}/g, (_, k) => vars[k] ?? '');
}
function varsFor({ name, athletes }, staff) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const kids = (athletes || []).map((a) => String(a).trim().split(/\s+/)[0]).filter(Boolean);
  const athlete = kids.length ? (kids.length === 1 ? kids[0] : `${kids.slice(0, -1).join(', ')} and ${kids[kids.length - 1]}`) : 'your athlete';
  return { first_name: first, athlete, business: businessName(), staff: staff?.name ? staff.name.split(' ')[0] : businessName() };
}

// ---- unsubscribe links: signed, so nobody can unsubscribe someone else by guessing ----
function secret() {
  let s = setting('crm_secret', null);
  if (!s) { s = randomToken(32); setSetting('crm_secret', s); }
  return s;
}
function unsubToken(kind, id) {
  const payload = `${kind}${id}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url').slice(0, 22);
  return `${payload}.${sig}`;
}
function readUnsubToken(token) {
  const m = /^([lp])(\d+)\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!m) return null;
  const expected = crypto.createHmac('sha256', secret()).update(`${m[1]}${m[2]}`).digest('base64url').slice(0, 22);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[3]))) return null;
  return { kind: m[1] === 'l' ? 'lead' : 'parent', id: Number(m[2]) };
}
const unsubUrl = (kind, id) => `${appUrl()}/unsubscribe/${unsubToken(kind === 'lead' ? 'l' : 'p', id)}`;
const footer = (kind, id) => `\n\n--\nDon't want these emails from ${businessName()}? Unsubscribe: ${unsubUrl(kind, id)}`;
function unsubscribe(token) {
  const t = readUnsubToken(token);
  if (!t) throw bad('That unsubscribe link isn’t valid. Reply to the email and we will take you off the list.');
  const row = t.kind === 'lead' ? get('SELECT id, email, email_opt_out FROM crm_leads WHERE id=?', t.id) : get('SELECT id, email, email_opt_out FROM parents WHERE id=?', t.id);
  if (!row) throw notFound('That contact');
  if (!row.email_opt_out) {
    if (t.kind === 'lead') { update('crm_leads', row.id, { email_opt_out: 1, email_opt_out_at: nowUtc() }); activity({ leadId: row.id, kind: 'consent', body: 'Unsubscribed from emails (link in an email)' }); }
    else {
      update('parents', row.id, { email_opt_out: 1, email_opt_out_at: nowUtc() });
      const p = get('SELECT family_id, name FROM parents WHERE id=?', row.id);
      activity({ familyId: p.family_id, kind: 'consent', body: `${p.name} unsubscribed from emails (link in an email)` });
    }
  }
  return { kind: t.kind, email: row.email, already: !!row.email_opt_out };
}
function unsubInfo(token) {
  const t = readUnsubToken(token);
  if (!t) throw bad('That unsubscribe link isn’t valid. Reply to the email and we will take you off the list.');
  const row = t.kind === 'lead' ? get('SELECT email, email_opt_out FROM crm_leads WHERE id=?', t.id) : get('SELECT email, email_opt_out FROM parents WHERE id=?', t.id);
  if (!row) throw notFound('That contact');
  const [user, domain] = String(row.email || '').split('@');
  return { email: user ? `${user.slice(0, 2)}${'•'.repeat(Math.max(1, user.length - 2))}@${domain}` : '', already: !!row.email_opt_out, business: businessName() };
}

// ---- staff who can own leads and take tasks: owners and front desk (coaches have no CRM) ----
function crmStaff() {
  return all("SELECT id, name, role FROM staff WHERE active=1 AND role IN ('owner','frontdesk') ORDER BY role DESC, name");
}
function staffId(v, what = 'owner') {
  if (v == null || v === '') return null;
  const s = get("SELECT id FROM staff WHERE id=? AND active=1 AND role IN ('owner','frontdesk')", Number(v));
  if (!s) throw bad(what === 'owner' ? 'Choose an owner or front desk person to own this lead.' : 'Assign the task to an owner or front desk person.');
  return s.id;
}

// ---- activity on a lead or family (the timeline), and when a lead last had one ----
function activity({ leadId = null, familyId = null, kind, outcome = null, body = null, meta = null, staff = null }) {
  const id = insert('crm_activities', { lead_id: leadId, family_id: familyId, kind, outcome, body, meta: meta ? JSON.stringify(meta) : null, staff_id: staff?.id || null, staff_name: staff?.name || null });
  if (leadId) run("UPDATE crm_leads SET last_activity_at=datetime('now') WHERE id=?", leadId);
  return id;
}

// ---- leads ----
function leadRow(id) {
  const l = get('SELECT * FROM crm_leads WHERE id=?', Number(id));
  if (!l) throw notFound('That lead');
  return l;
}
function parseAthletes(v) {
  let list = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch { list = v.split(/[,;]| and /).map((name) => ({ name })); } }
  if (!Array.isArray(list)) list = [];
  const yr = new Date().getFullYear();
  const out = [];
  for (const a of list.slice(0, 8)) {
    const x = typeof a === 'string' ? { name: a } : a || {};
    const name = clean(x.name, 80);
    const age = x.age === '' || x.age == null ? null : Number(x.age);
    const grad = x.grad_year === '' || x.grad_year == null ? null : Number(x.grad_year);
    if (!name && age == null && grad == null) continue;
    if (!name) throw bad('Give each athlete a name (a first name is fine).');
    if (age != null && (!Number.isInteger(age) || age < 4 || age > 70)) throw bad(`Enter ${name}'s age as a whole number, like 12.`);
    if (grad != null && (!Number.isInteger(grad) || grad < yr - 30 || grad > yr + 20)) throw bad(`Enter ${name}'s grad year as four digits, like ${yr + 3}.`);
    out.push({ name, age, grad_year: grad });
  }
  if (out.length > 6) throw bad('Add up to 6 athletes on one lead.');
  return out;
}
function leadView(l, staff) {
  const T = today();
  const athletes = JSON.parse(l.athletes || '[]');
  const lastAct = l.last_activity_at || l.created_at;
  const open = OPEN_STAGES.includes(l.stage);
  const owner = l.owner_id ? get('SELECT name FROM staff WHERE id=?', l.owner_id) : null;
  const tasks = get(`SELECT COUNT(*) n, MIN(due_date) next FROM crm_tasks WHERE lead_id=? AND done_at IS NULL ${staff?.role === 'frontdesk' ? 'AND assignee_id=?' : ''}`, l.id, ...(staff?.role === 'frontdesk' ? [staff.id] : []));
  return {
    id: l.id, parent_name: l.parent_name, email: l.email, phone: l.phone, phone_display: messaging.formatPhone(l.phone), athletes,
    athlete_names: athletes.map((a) => a.name).join(', '), sport: l.sport, position: l.position,
    source: l.source, source_label: label(SOURCES, l.source), source_detail: l.source_detail, interest: l.interest, interest_label: label(INTERESTS, l.interest),
    notes: l.notes, owner_id: l.owner_id, owner_name: owner?.name || null, stage: l.stage, stage_label: label(STAGES, l.stage),
    lost_reason: l.lost_reason, lost_reason_label: label(LOST_REASONS, l.lost_reason), lost_note: l.lost_note,
    stage_changed_at: l.stage_changed_at, days_in_stage: Math.max(0, daysBetween(utcToDate(l.stage_changed_at || l.created_at), T)),
    last_activity_at: lastAct, stale: open && daysBetween(utcToDate(lastAct), T) >= STALE_DAYS, days_since_activity: Math.max(0, daysBetween(utcToDate(lastAct), T)),
    first_contact: l.first_contact || utcToDate(l.created_at), created_at: l.created_at, created_by: l.created_by,
    family_id: l.family_id, converted_at: l.converted_at, reengaged: !!l.reengaged,
    email_opt_out: !!l.email_opt_out, email_opt_out_at: l.email_opt_out_at,
    sms_opt_in: !!l.sms_opt_in, sms_opt_in_at: l.sms_opt_in_at, sms_opt_in_source: l.sms_opt_in_source, sms_opt_out: !!l.sms_opt_out, sms_opt_out_at: l.sms_opt_out_at,
    open_tasks: tasks.n, next_task_due: tasks.next, overdue_task: !!tasks.next && tasks.next < T,
  };
}

// People already on file with this email or phone: other leads and client families.
function duplicates({ email, phone }, exceptId = 0) {
  const out = [];
  if (!email && !phone) return out;
  for (const l of all(`SELECT id, parent_name, stage, email, phone FROM crm_leads WHERE id<>? AND ((? IS NOT NULL AND email=?) OR (? IS NOT NULL AND phone=?)) ORDER BY id DESC LIMIT 5`,
    exceptId, email || null, email || null, phone || null, phone || null)) {
    out.push({ kind: 'lead', id: l.id, name: l.parent_name, detail: `Lead · ${label(STAGES, l.stage)}`, match: email && l.email?.toLowerCase() === email.toLowerCase() ? 'email' : 'phone', href: `/app/crm/leads/${l.id}` });
  }
  for (const p of all(`SELECT p.id, p.name, p.family_id, p.email, p.phone_e164, f.name AS family,
      (SELECT id FROM athletes a WHERE a.family_id=p.family_id ORDER BY archived, id LIMIT 1) AS athlete_id
    FROM parents p JOIN families f ON f.id=p.family_id WHERE (? IS NOT NULL AND p.email=?) OR (? IS NOT NULL AND p.phone_e164=?) LIMIT 5`, email || null, email || null, phone || null, phone || null)) {
    out.push({ kind: 'family', id: p.family_id, name: p.name, detail: `Client · ${p.family}`, match: email && p.email?.toLowerCase() === email.toLowerCase() ? 'email' : 'phone', href: p.athlete_id ? `/app/clients/${p.athlete_id}` : '/app/clients', athlete_id: p.athlete_id });
  }
  return out;
}

// Validate a lead from the form, the website, the API or an import row. partial: only the fields sent (edits).
function cleanLead(b, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || Object.hasOwn(b, k);
  if (has('parent_name')) {
    out.parent_name = clean(b.parent_name, 120);
    if (!out.parent_name) throw bad('Enter the parent’s name (or the athlete’s, for an adult).');
  }
  if (has('email')) {
    const e = clean(b.email, 200)?.toLowerCase() || null;
    if (e && !EMAIL_RE.test(e)) throw bad('That email doesn’t look right. Check it, or leave it blank.');
    out.email = e;
  }
  if (has('phone')) {
    const raw = clean(b.phone, 40);
    if (raw) {
      out.phone = messaging.toE164(raw);
      if (!out.phone) throw bad('Enter the phone number with its area code, like 801-555-0142.');
    } else out.phone = null;
  }
  if (!partial && !out.email && !out.phone) throw bad('Add an email or a phone number so you can follow up.');
  if (has('athletes')) out.athletes = JSON.stringify(parseAthletes(b.athletes));
  if (has('sport')) out.sport = clean(b.sport, 60);
  if (has('position')) out.position = clean(b.position, 60);
  if (has('source')) {
    const s = b.source || 'other';
    if (!SOURCES.some((x) => x[0] === s)) throw bad('Choose where the lead came from.');
    out.source = s;
  }
  if (has('source_detail')) out.source_detail = clean(b.source_detail, 120);
  if ((out.source || (partial ? null : 'other')) === 'referral' && !out.source_detail && has('source_detail')) throw bad('Enter who referred them.');
  if (has('interest')) {
    const i = b.interest || null;
    if (i && !INTERESTS.some((x) => x[0] === i)) throw bad('Choose what they’re interested in.');
    out.interest = i;
  }
  if (has('notes')) {
    out.notes = cleanText(b.notes);
    if (out.notes && out.notes.length > 2000) throw bad('Keep notes under 2,000 characters.');
  }
  if (has('owner_id')) out.owner_id = staffId(b.owner_id);
  if (has('first_contact')) {
    const d = b.first_contact || null;
    if (d && (!isDate(d) || d > today())) throw bad('Use a real date for when they first got in touch, today or earlier.');
    if (d) out.first_contact = d;
  }
  return out;
}

function createLead(b, { staff = null, source = null, by = null, allowDuplicate = false, smsConsent = null, stage = 'new' } = {}) {
  const data = cleanLead({ ...b, ...(source ? { source } : {}) });
  if (!data.first_contact) data.first_contact = today();
  if (!allowDuplicate) {
    const dups = duplicates(data);
    if (dups.length) throw new HttpError(409, `${data.parent_name} may already be on file (${dups.map((d) => `${d.name}, ${d.detail.toLowerCase()}`).join('; ')}). Open the existing record, or add the lead anyway.`, { duplicates: dups });
  }
  const consent = smsConsent || (b.sms_opt_in === true ? { source: clean(b.sms_opt_in_source, 120) || (staff ? `Told ${staff.name}` : 'Enquiry form') } : null);
  if (consent && !data.phone) throw bad('Add a mobile number to record that it’s OK to text them.');
  const id = tx(() => {
    const leadId = insert('crm_leads', {
      ...data, stage, stage_changed_at: nowUtc(), last_activity_at: nowUtc(), created_by: by || staff?.name || null,
      ...(consent ? { sms_opt_in: 1, sms_opt_in_at: nowUtc(), sms_opt_in_source: consent.source } : {}),
    });
    insert('crm_stage_changes', { lead_id: leadId, from_stage: null, to_stage: stage, auto: staff ? 0 : 1, staff_name: staff?.name || by || 'System' });
    activity({ leadId, kind: 'created', body: by && !staff ? `Lead added from ${by}` : `Lead added · ${label(SOURCES, data.source)}${data.source_detail ? ` (${data.source_detail})` : ''}`, staff });
    return leadId;
  });
  const l = leadRow(id);
  emit('lead.created', webhookLead(l));
  return l;
}
function webhookLead(l) {
  return { id: l.id, parent_name: l.parent_name, email: l.email, phone: l.phone, athletes: JSON.parse(l.athletes || '[]'), sport: l.sport,
    source: l.source, source_detail: l.source_detail, interest: l.interest, stage: l.stage, first_contact: l.first_contact, family_id: l.family_id };
}

// Move a lead to a stage (by a person, or automatically from real data). Records the change, the timeline and the webhook.
function moveStage(lead, stage, { staff = null, auto = false, lostReason = null, lostNote = null, why = null } = {}) {
  if (!STAGE_KEYS.includes(stage)) throw bad('Choose a stage.');
  if (stage === 'lost') {
    if (!LOST_REASONS.some((r) => r[0] === lostReason)) throw bad('Choose why the lead was lost.');
    if (lostReason === 'other' && !clean(lostNote, 300)) throw bad('Say briefly why the lead was lost.');
  }
  if (lead.stage === stage && stage !== 'lost') return false;
  const from = lead.stage;
  tx(() => {
    update('crm_leads', lead.id, { stage, stage_changed_at: nowUtc(), lost_reason: stage === 'lost' ? lostReason : null, lost_note: stage === 'lost' ? clean(lostNote, 300) : null });
    insert('crm_stage_changes', { lead_id: lead.id, from_stage: from, to_stage: stage, auto: auto ? 1 : 0, staff_name: auto ? 'System' : staff?.name || null });
    activity({ leadId: lead.id, kind: 'stage', body: `${label(STAGES, from)} → ${label(STAGES, stage)}${stage === 'lost' ? `: ${label(LOST_REASONS, lostReason)}${lostNote ? ` (${clean(lostNote, 300)})` : ''}` : ''}${why ? `: ${why}` : ''}`,
      meta: { from, to: stage, auto }, staff: auto ? null : staff });
  });
  emit('lead.stage_changed', { id: lead.id, parent_name: lead.parent_name, from, to: stage, lost_reason: stage === 'lost' ? lostReason : null, auto, family_id: lead.family_id });
  return true;
}

// Automatic moves from what really happened: an evaluation booked → Evaluation booked; a trial → Trial;
// an active membership → Member. Only forward; a Lost lead moves only when they start a trial or join.
function autoStageFor(l) {
  const since = l.family_linked_on || '0000-00-00';
  if (l.family_id) {
    const m = get(`SELECT MAX(CASE WHEN m.status IN ('active','past_due') THEN 2 WHEN m.status='trial' THEN 1 ELSE 0 END) r FROM memberships m JOIN athletes a ON a.id=m.athlete_id
      WHERE a.family_id=? AND m.started_at>=?`, l.family_id, since)?.r || 0;
    if (m === 2) return ['member', 'a membership started'];
    if (m === 1) return ['trial', 'a free trial started'];
    if (get(`SELECT 1 FROM bookings b JOIN events e ON e.id=b.event_id JOIN athletes a ON a.id=b.athlete_id WHERE a.family_id=? AND e.type='evaluation'
      AND e.cancelled=0 AND b.status='booked' AND substr(e.starts_at,1,10)>=?`, l.family_id, since)) return ['evaluation', 'an evaluation is on the schedule'];
  }
  if (get("SELECT 1 FROM events WHERE lead_id=? AND type='evaluation' AND cancelled=0", l.id)) return ['evaluation', 'an evaluation is on the schedule'];
  return null;
}
function syncLead(l) {
  const t = autoStageFor(l);
  if (!t) return false;
  const [stage, why] = t;
  if (l.stage === 'member') return false;
  if (l.stage === 'lost' ? !['trial', 'member'].includes(stage) : RANK[stage] <= RANK[l.stage]) return false;
  return moveStage(l, stage, { auto: true, why });
}
function syncStages(ids = null) {
  const rows = ids ? all(`SELECT * FROM crm_leads WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : all("SELECT * FROM crm_leads WHERE stage<>'member' AND (family_id IS NOT NULL OR id IN (SELECT lead_id FROM events WHERE lead_id IS NOT NULL AND cancelled=0))");
  let moved = 0;
  for (const l of rows) if (syncLead(l)) moved++;
  return moved;
}

// A New lead that staff reach (call, email or text) is Contacted.
function touch(l, staff) {
  if (l.stage === 'new') moveStage(l, 'contacted', { staff, auto: true, why: 'first contact logged' });
}

// ---- listing and filtering ----
const SORTS = ['newest', 'oldest', 'stale', 'name', 'stage_age', 'next_task'];
function listLeads(q, staff) {
  const where = ['1=1'], args = [];
  const s = String(q.q || '').trim();
  if (s) {
    const like = `%${s}%`, digits = s.replace(/\D/g, '');
    where.push(`(parent_name LIKE ? OR email LIKE ? OR athletes LIKE ? OR sport LIKE ? OR source_detail LIKE ?${digits.length >= 4 ? ' OR phone LIKE ?' : ''})`);
    args.push(like, like, like, like, like, ...(digits.length >= 4 ? [`%${digits}%`] : []));
  }
  if (q.stage === 'open') where.push(`stage IN (${OPEN_STAGES.map(() => '?').join(',')})`), args.push(...OPEN_STAGES);
  else if (q.stage && STAGE_KEYS.includes(q.stage)) { where.push('stage=?'); args.push(q.stage); }
  if (q.source && SOURCES.some((x) => x[0] === q.source)) { where.push('source=?'); args.push(q.source); }
  if (q.interest && INTERESTS.some((x) => x[0] === q.interest)) { where.push('interest=?'); args.push(q.interest); }
  if (q.owner === 'none') where.push('owner_id IS NULL');
  else if (q.owner === 'me' && staff) { where.push('owner_id=?'); args.push(staff.id); }
  else if (q.owner && Number(q.owner)) { where.push('owner_id=?'); args.push(Number(q.owner)); }
  if (q.lost_reason && LOST_REASONS.some((x) => x[0] === q.lost_reason)) { where.push('lost_reason=?'); args.push(q.lost_reason); }
  let rows = all(`SELECT * FROM crm_leads WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`, ...args).map((l) => leadView(l, staff));
  if (q.stale === '1') rows = rows.filter((r) => r.stale);
  const sort = SORTS.includes(q.sort) ? q.sort : 'newest';
  const by = {
    newest: (a, b) => b.first_contact.localeCompare(a.first_contact) || b.id - a.id,
    oldest: (a, b) => a.first_contact.localeCompare(b.first_contact) || a.id - b.id,
    stale: (a, b) => b.days_since_activity - a.days_since_activity || a.id - b.id,
    name: (a, b) => a.parent_name.localeCompare(b.parent_name),
    stage_age: (a, b) => b.days_in_stage - a.days_in_stage || a.id - b.id,
    next_task: (a, b) => (a.next_task_due || '9999').localeCompare(b.next_task_due || '9999') || a.id - b.id,
  }[sort];
  return rows.sort(by);
}
function stageCounts() {
  const counts = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0]));
  for (const r of all('SELECT stage, COUNT(*) n FROM crm_leads GROUP BY stage')) counts[r.stage] = r.n;
  return counts;
}

// ---- tasks ----
function taskView(t) {
  const T = today();
  const lead = t.lead_id ? get('SELECT id, parent_name, phone FROM crm_leads WHERE id=?', t.lead_id) : null;
  const fam = t.family_id ? get(`SELECT f.id, f.name, (SELECT id FROM athletes a WHERE a.family_id=f.id ORDER BY archived, id LIMIT 1) AS athlete_id FROM families f WHERE f.id=?`, t.family_id) : null;
  const who = get('SELECT name FROM staff WHERE id=?', t.assignee_id);
  return { id: t.id, title: t.title, due_date: t.due_date, assignee_id: t.assignee_id, assignee_name: who?.name || null, done: !!t.done_at, done_at: t.done_at, done_by: t.done_by,
    overdue: !t.done_at && t.due_date < T, due_today: !t.done_at && t.due_date === T, created_by: t.created_by, created_at: t.created_at,
    lead: lead ? { id: lead.id, name: lead.parent_name, phone: lead.phone } : null, family: fam ? { id: fam.id, name: fam.name, athlete_id: fam.athlete_id } : null,
    href: lead ? `/app/crm/leads/${lead.id}` : fam?.athlete_id ? `/app/clients/${fam.athlete_id}` : '/app/crm' };
}
function cleanTask(b, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || Object.hasOwn(b, k);
  if (has('title')) { out.title = clean(b.title, 160); if (!out.title) throw bad('Say what needs doing, like "Call back about evaluation times".'); }
  if (has('due_date')) { if (!isDate(b.due_date)) throw bad('Choose a due date.'); out.due_date = b.due_date; }
  if (has('assignee_id')) { out.assignee_id = staffId(b.assignee_id, 'task'); if (!out.assignee_id) throw bad('Choose who the task is for.'); }
  if (!partial) {
    const leadId = b.lead_id ? Number(b.lead_id) : null, familyId = b.family_id ? Number(b.family_id) : null;
    if (leadId && !get('SELECT 1 FROM crm_leads WHERE id=?', leadId)) throw notFound('That lead');
    if (familyId && !get('SELECT 1 FROM families WHERE id=?', familyId)) throw notFound('That family');
    out.lead_id = leadId; out.family_id = leadId ? (get('SELECT family_id FROM crm_leads WHERE id=?', leadId).family_id || null) : familyId;
  }
  return out;
}
// Overdue and today's open tasks for one person (Today's Needs your attention).
function dueTasksFor(staffIdN, T = today()) {
  return all('SELECT * FROM crm_tasks WHERE assignee_id=? AND done_at IS NULL AND due_date<=? ORDER BY due_date, id LIMIT 20', staffIdN, T).map(taskView);
}

// ---- timeline ----
const atOf = (t) => (String(t).length === 10 ? `${t} 12:00:00` : String(t).replace('T', ' ').slice(0, 19));
function activityItems(where, args) {
  return all(`SELECT * FROM crm_activities WHERE ${where} ORDER BY id DESC LIMIT 200`, ...args).map((a) => {
    const meta = a.meta ? JSON.parse(a.meta) : {};
    const title = { note: 'Note', call: `Call: ${label(OUTCOMES, a.outcome)}`, email: `Email sent: ${meta.subject || ''}`.trim(), stage: 'Stage changed', created: 'Lead added',
      converted: 'Converted to a client', reengaged: 'Back in the pipeline', booking: 'Evaluation', task: 'Task done', task_added: 'Task added', consent: 'Contact preferences', enquiry: 'Website enquiry' }[a.kind] || a.kind;
    return { kind: a.kind, at: atOf(a.created_at), title, body: a.body, outcome: a.outcome, by: a.staff_name || (meta.auto ? 'Automatic' : null), auto: !!meta.auto, id: `a${a.id}` };
  });
}
function smsItems(where, args) {
  return all(`SELECT * FROM sms_messages WHERE ${where} ORDER BY id DESC LIMIT 100`, ...args).map((m) => ({
    kind: m.direction === 'in' ? 'text_in' : 'text', at: atOf(m.created_at), title: m.direction === 'in' ? `Text received from ${messaging.formatPhone(m.from_phone)}` : `Text sent to ${messaging.formatPhone(m.to_phone)}`,
    body: m.body, by: m.direction === 'in' ? null : m.sent_by, status: m.status, id: `s${m.id}`,
  }));
}
function familyItems(familyId, staff, { compact = false } = {}) {
  const items = [];
  const kids = all('SELECT id, first_name, last_name FROM athletes WHERE family_id=?', familyId);
  const ids = kids.map((k) => k.id);
  if (!ids.length) return items;
  const byId = Object.fromEntries(kids.map((k) => [k.id, k]));
  const IN = `(${ids.map(() => '?').join(',')})`;
  for (const b of all(`SELECT b.id, b.athlete_id, b.status, b.created_at, e.name, e.starts_at, e.type FROM bookings b JOIN events e ON e.id=b.event_id
      WHERE b.athlete_id IN ${IN} ${compact ? "AND e.type IN ('evaluation','private')" : ''} ORDER BY b.id DESC LIMIT ${compact ? 10 : 40}`, ...ids)) {
    const d = new Date(b.starts_at + ':00Z');
    const when = `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`;
    items.push({ kind: 'booking', at: atOf(b.created_at), title: b.type === 'evaluation' ? 'Evaluation booked' : 'Booked', body: `${byId[b.athlete_id].first_name}: ${b.name}, ${when}${['cancelled', 'late_cancel'].includes(b.status) ? ' (cancelled)' : ''}`, id: `b${b.id}` });
  }
  for (const m of all(`SELECT m.*, p.name AS plan FROM memberships m JOIN plans p ON p.id=m.plan_id WHERE m.athlete_id IN ${IN} ORDER BY m.id DESC LIMIT 20`, ...ids)) {
    const who = byId[m.athlete_id].first_name;
    const trialStart = m.status === 'trial' || (m.status === 'cancelled' && !get("SELECT 1 FROM invoices WHERE membership_id=? AND status='paid'", m.id) && m.next_charge > m.started_at && daysBetween(m.started_at, m.next_charge) < 28);
    items.push({ kind: 'membership', at: atOf(m.started_at), day: m.started_at, title: trialStart ? 'Free trial started' : 'Membership started', body: `${who}: ${m.plan}`, id: `m${m.id}` });
    if (m.cancelled_at) items.push({ kind: 'membership', at: atOf(m.cancelled_at), day: m.cancelled_at, title: trialStart ? 'Trial ended without joining' : 'Membership cancelled', body: `${who}: ${m.plan}`, id: `mc${m.id}` });
  }
  if (staff?.role === 'owner') {
    for (const i of all(`SELECT id, number, description, amount_cents, status, created_at FROM invoices WHERE family_id=? AND status IN ('paid','failed') ORDER BY id DESC LIMIT ${compact ? 5 : 20}`, familyId)) {
      items.push({ kind: 'payment', at: atOf(i.created_at), title: i.amount_cents < 0 ? 'Refund' : i.status === 'paid' ? 'Payment' : 'Payment declined', body: `${money(i.amount_cents)} · ${i.description || i.number}`, id: `i${i.id}` });
    }
  }
  if (!compact) {
    const deskOnly = staff?.role === 'frontdesk';
    for (const n of all(`SELECT id, athlete_id, body, staff_name, created_at FROM client_notes WHERE athlete_id IN ${IN} ${deskOnly ? 'AND coach_only=0' : ''} ORDER BY id DESC LIMIT 30`, ...ids)) {
      items.push({ kind: 'note', at: atOf(n.created_at), title: `Client note on ${byId[n.athlete_id].first_name}`, body: n.body, by: n.staff_name, id: `n${n.id}` });
    }
  }
  return items;
}
const byNewest = (a, b) => b.at.localeCompare(a.at) || String(b.id).localeCompare(String(a.id));
function leadTimeline(l, staff) {
  const items = [
    ...activityItems(`lead_id=?${l.family_id ? ' OR (family_id=? AND lead_id IS NULL)' : ''}`, [l.id, ...(l.family_id ? [l.family_id] : [])]),
    ...smsItems(`lead_id=?${l.family_id ? ' OR family_id=?' : ''}`, [l.id, ...(l.family_id ? [l.family_id] : [])]),
    ...all("SELECT id, name, starts_at, cancelled FROM events WHERE lead_id=? ORDER BY id DESC", l.id).map((e) => ({ kind: 'booking', at: atOf(e.starts_at), when: require('../lib').whenLocal(e.starts_at), title: e.cancelled ? 'Evaluation cancelled' : 'Evaluation', body: e.name, id: `e${e.id}` })),
    ...(l.family_id ? familyItems(l.family_id, staff) : []),
  ];
  return items.sort(byNewest);
}
function familyTimeline(familyId, staff, { compact = false } = {}) {
  const leadIds = all('SELECT id FROM crm_leads WHERE family_id=?', familyId).map((r) => r.id);
  const inLeads = leadIds.length ? ` OR lead_id IN (${leadIds.map(() => '?').join(',')})` : '';
  const items = [
    ...activityItems(`family_id=?${inLeads}`, [familyId, ...leadIds]),
    ...smsItems(`family_id=?${inLeads}`, [familyId, ...leadIds]),
    ...familyItems(familyId, staff, { compact }),
  ].sort(byNewest);
  return compact ? items.slice(0, 8) : items;
}

// ---- email and text from the CRM ----
function canEmail(r) { return !!r.email && !r.email_opt_out; }
// Texting needs a mobile number, a recorded OK to text, and no STOP since.
function textBlock(r) {
  const phone = r.phone_e164 !== undefined ? r.phone_e164 : r.phone;
  if (!phone) return 'no mobile number';
  if (r.sms_opt_out || messaging.stopped(phone)) return 'replied STOP';
  if (!r.sms_opt_in) return 'no OK to text on file';
  return null;
}
function sendLeadEmail(l, { subject, body }, staff, kind = 'one') {
  if (!l.email) throw bad('This lead has no email address. Add one first.');
  if (l.email_opt_out) throw bad(`${l.parent_name} unsubscribed from emails. They won't get CRM emails.`);
  const s = clean(subject, 150), t = cleanText(body);
  if (!s) throw bad('Add a subject.');
  if (!t) throw bad('Write the message first.');
  if (t.length > 10000) throw bad('Keep the message under 10,000 characters.');
  const outboxId = sendEmail(l.email, s, t + footer('lead', l.id));
  activity({ leadId: l.id, familyId: l.family_id, kind: 'email', body: t, meta: { subject: s, outbox_id: outboxId, to: l.email, group: kind === 'group' }, staff });
  if (kind !== 'group') touch(leadRow(l.id), staff);
  return outboxId;
}
function primaryParent(familyId) {
  return get('SELECT * FROM parents WHERE family_id=? ORDER BY is_self DESC, id LIMIT 1', familyId);
}
function sendFamilyEmail(familyId, { subject, body }, staff, kind = 'one', parent = null) {
  const p = parent || primaryParent(familyId);
  if (!p) throw bad('This family has no parent on file.');
  if (p.email_opt_out) throw bad(`${p.name} unsubscribed from emails. They won't get CRM emails.`);
  const s = clean(subject, 150), t = cleanText(body);
  if (!s) throw bad('Add a subject.');
  if (!t) throw bad('Write the message first.');
  const outboxId = sendEmail(p.email, s, t + footer('parent', p.id));
  activity({ familyId, kind: 'email', body: t, meta: { subject: s, outbox_id: outboxId, to: p.email, group: kind === 'group' }, staff });
  return outboxId;
}
function sendLeadText(l, body, staff, kind = 'one') {
  const block = textBlock(l);
  if (block) throw bad(block === 'no mobile number' ? 'This lead has no mobile number. Add one first.' : block === 'replied STOP' ? `${l.parent_name} replied STOP, so they can’t be texted.` : `There’s no OK to text ${l.parent_name} on file. Ask them, then record it under Contact preferences.`);
  const r = messaging.sendSms(l.phone, body, { leadId: l.id, familyId: l.family_id, kind, sentBy: staff?.name });
  run("UPDATE crm_leads SET last_activity_at=datetime('now') WHERE id=?", l.id);
  if (kind !== 'group') touch(leadRow(l.id), staff);
  return r;
}
function sendFamilyText(familyId, body, staff, kind = 'one', parent = null) {
  const p = parent || primaryParent(familyId);
  if (!p) throw bad('This family has no parent on file.');
  const block = textBlock(p);
  if (block) throw bad(block === 'no mobile number' ? `${p.name} has no mobile number we can text.` : block === 'replied STOP' ? `${p.name} replied STOP, so they can’t be texted.` : `There’s no OK to text ${p.name} on file. Ask them, then record it under Contact preferences.`);
  return messaging.sendSms(p.phone_e164, body, { familyId, parentId: p.id, kind, sentBy: staff?.name });
}

// Contact preferences staff record (an OK to text given in person or on the phone; unsubscribes).
function setConsent(kind, row, b, staff) {
  const table = kind === 'lead' ? 'crm_leads' : 'parents';
  const patch = {};
  const notes = [];
  if (Object.hasOwn(b, 'sms_opt_in')) {
    if (b.sms_opt_in) {
      const how = clean(b.source, 120);
      if (!how) throw bad('Say how they agreed, like "Asked on the phone" or "Ticked the box on the enquiry form".');
      const phone = kind === 'lead' ? row.phone : row.phone_e164;
      if (!phone) throw bad('Add a mobile number first.');
      if (row.sms_opt_out) throw bad('They replied STOP. Only they can turn texts back on, by replying START.');
      Object.assign(patch, { sms_opt_in: 1, sms_opt_in_at: nowUtc(), sms_opt_in_source: `${how} (recorded by ${staff.name})` });
      notes.push(`OK to text: ${how}`);
    } else { Object.assign(patch, { sms_opt_in: 0 }); notes.push('No longer OK to text'); }
  }
  if (Object.hasOwn(b, 'email_opt_out')) {
    if (b.email_opt_out) { Object.assign(patch, { email_opt_out: 1, email_opt_out_at: nowUtc() }); notes.push('Unsubscribed from emails'); }
    else {
      if (staff.role !== 'owner') throw new HttpError(403, 'Only an owner can subscribe someone again, and only when they ask.');
      Object.assign(patch, { email_opt_out: 0, email_opt_out_at: null }); notes.push('Subscribed to emails again (they asked)');
    }
  }
  if (!Object.keys(patch).length) throw bad('Nothing to change.');
  update(table, row.id, patch);
  activity({ leadId: kind === 'lead' ? row.id : null, familyId: kind === 'lead' ? row.family_id : row.family_id, kind: 'consent', body: `${kind === 'parent' ? `${row.name}: ` : ''}${notes.join('. ')}`, staff });
}

// Inbound text: STOP (and its synonyms) opts out, START opts back in, HELP gets the business contact. Everything is
// recorded on the timeline of whoever has that number. Returns the reply to send (or null).
const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke'];
const START_WORDS = ['start', 'unstop', 'yes', 'subscribe'];
const HELP_WORDS = ['help', 'info'];
function inboundSms(msg) {
  const from = messaging.toE164(msg.from);
  const leads = from ? all('SELECT * FROM crm_leads WHERE phone=? ORDER BY id DESC', from) : [];
  const parents = from ? all('SELECT * FROM parents WHERE phone_e164=?', from) : [];
  const lead = leads[0] || null, parent = parents[0] || null;
  const id = messaging.recordInbound(msg, { leadId: lead?.id, familyId: lead?.family_id || parent?.family_id, parentId: parent?.id });
  const word = String(msg.body || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  let action = null, reply = null;
  const biz = businessName();
  if (STOP_WORDS.includes(word)) {
    action = 'stop';
    if (from) {
      run("UPDATE crm_leads SET sms_opt_out=1, sms_opt_out_at=datetime('now'), sms_opt_in=0 WHERE phone=?", from);
      run("UPDATE parents SET sms_opt_out=1, sms_opt_out_at=datetime('now'), sms_opt_in=0 WHERE phone_e164=?", from);
    }
    reply = `${biz}: You're unsubscribed and won't get more texts. Reply START to get texts again.`;
  } else if (START_WORDS.includes(word)) {
    action = 'start';
    if (from) {
      run("UPDATE crm_leads SET sms_opt_out=0, sms_opt_out_at=NULL, sms_opt_in=1, sms_opt_in_at=datetime('now'), sms_opt_in_source='Replied START' WHERE phone=?", from);
      run("UPDATE parents SET sms_opt_out=0, sms_opt_out_at=NULL, sms_opt_in=1, sms_opt_in_at=datetime('now'), sms_opt_in_source='Replied START' WHERE phone_e164=?", from);
    }
    reply = `${biz}: You'll get texts from us again. Reply STOP to unsubscribe, HELP for help.`;
  } else if (HELP_WORDS.includes(word)) {
    action = 'help';
    const addr = setting('business_address', '');
    reply = `${biz}: Texts about training and bookings. Msg & data rates may apply. Reply STOP to unsubscribe.${addr ? ` ${addr}` : ''}`;
  }
  for (const l of leads) {
    run("UPDATE crm_leads SET last_activity_at=datetime('now') WHERE id=?", l.id);
    if (action === 'stop' || action === 'start') activity({ leadId: l.id, familyId: l.family_id, kind: 'consent', body: action === 'stop' ? 'Replied STOP: no more texts' : 'Replied START: texts back on' });
  }
  for (const p of parents) if (action === 'stop' || action === 'start') activity({ familyId: p.family_id, kind: 'consent', body: `${p.name} ${action === 'stop' ? 'replied STOP: no more texts' : 'replied START: texts back on'}` });
  if (reply && from) {
    try { messaging.sendSms(from, reply, { leadId: lead?.id, familyId: lead?.family_id || parent?.family_id, parentId: parent?.id, kind: 'auto', sentBy: 'Automatic reply', compliance: true }); } catch { /* bad number */ }
  }
  return { id, action, lead_id: lead?.id || null, family_id: lead?.family_id || parent?.family_id || null };
}

// ---- segments for group messages ----
// spec: { audience: 'leads', stage, lost_reason, interest, source } or { audience: 'trials_ended' } (families whose
// free trial ended without joining). channel: 'email' | 'text'. Returns who gets it and who's left out and why.
function trialsEnded() {
  return all(`SELECT f.id AS family_id, f.name AS family, MAX(m.cancelled_at) AS ended, GROUP_CONCAT(DISTINCT a.first_name) AS kids
    FROM memberships m JOIN athletes a ON a.id=m.athlete_id JOIN families f ON f.id=a.family_id
    WHERE m.status='cancelled' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.membership_id=m.id AND i.status='paid')
      AND NOT EXISTS (SELECT 1 FROM memberships m2 JOIN athletes a2 ON a2.id=m2.athlete_id WHERE a2.family_id=f.id AND m2.status IN ('trial','active','past_due','paused'))
    GROUP BY f.id ORDER BY ended DESC`).map((r) => ({ ...r, open_lead: get(`SELECT id FROM crm_leads WHERE family_id=? AND stage IN (${OPEN_STAGES.map(() => '?').join(',')})`, r.family_id, ...OPEN_STAGES)?.id || null }));
}
function segment(spec = {}, channel = 'email') {
  if (!['email', 'text'].includes(channel)) throw bad('Choose email or text.');
  const recipients = [], excluded = [];
  const check = (r) => {
    const why = channel === 'email' ? (!r.email ? 'no email' : r.email_opt_out ? 'unsubscribed' : null) : textBlock(r);
    return why;
  };
  if (spec.audience === 'trials_ended') {
    for (const f of trialsEnded()) {
      const p = primaryParent(f.family_id);
      if (!p) continue;
      const kids = all('SELECT first_name, last_name FROM athletes WHERE family_id=? AND archived=0', f.family_id).map(fullName);
      const r = { kind: 'parent', id: p.id, name: p.name, email: p.email, phone: p.phone_e164, family_id: f.family_id, athletes: kids, detail: `Trial ended ${f.ended || ''}`.trim() };
      const why = check(p);
      (why ? excluded : recipients).push(why ? { ...r, reason: why } : r);
    }
  } else if (spec.audience === 'leads' || !spec.audience) {
    const rows = listLeads({ stage: spec.stage || '', source: spec.source || '', interest: spec.interest || '', lost_reason: spec.lost_reason || '', owner: spec.owner || '' }, null);
    for (const v of rows) {
      const l = get('SELECT * FROM crm_leads WHERE id=?', v.id);
      const r = { kind: 'lead', id: l.id, name: l.parent_name, email: l.email, phone: l.phone, lead_id: l.id, family_id: l.family_id, athletes: JSON.parse(l.athletes || '[]').map((a) => a.name), detail: `${label(STAGES, l.stage)}${l.lost_reason ? `: ${label(LOST_REASONS, l.lost_reason)}` : ''}` };
      const why = check(l);
      (why ? excluded : recipients).push(why ? { ...r, reason: why } : r);
    }
  } else throw bad('Choose who the message is for.');
  return { recipients, excluded };
}
function describeSegment(spec) {
  if (spec.audience === 'trials_ended') return 'Families whose trial ended without joining';
  const bits = [spec.stage === 'open' ? 'Open leads' : spec.stage ? `${label(STAGES, spec.stage)} leads` : 'All leads'];
  if (spec.lost_reason) bits.push(`lost for ${label(LOST_REASONS, spec.lost_reason).toLowerCase()}`);
  if (spec.interest) bits.push(`interested in ${label(INTERESTS, spec.interest).toLowerCase()}`);
  if (spec.source) bits.push(`from ${label(SOURCES, spec.source).toLowerCase()}`);
  return bits.join(', ');
}
function sendGroup(spec, channel, { subject, body }, staff) {
  const { recipients } = segment(spec, channel);
  if (!recipients.length) throw bad('Nobody in this group can get the message. Check the people left out.');
  if (channel === 'email' && !clean(subject, 150)) throw bad('Add a subject.');
  if (!cleanText(body)) throw bad('Write the message first.');
  if (channel === 'text' && messaging.segments(fill(body, varsFor({ name: 'Alexandra', athletes: ['Maximilian'] }, staff))).segments > messaging.MAX_SEGMENTS) {
    throw bad(`Keep texts to ${messaging.MAX_SEGMENTS} parts (about ${messaging.MAX_SEGMENTS * 153} characters).`);
  }
  let sent = 0;
  const failed = [];
  for (const r of recipients) {
    const vars = varsFor({ name: r.name, athletes: r.athletes }, staff);
    try {
      if (channel === 'email') {
        if (r.kind === 'lead') sendLeadEmail(leadRow(r.id), { subject: fill(subject, vars), body: fill(body, vars) }, staff, 'group');
        else sendFamilyEmail(r.family_id, { subject: fill(subject, vars), body: fill(body, vars) }, staff, 'group', get('SELECT * FROM parents WHERE id=?', r.id));
      } else if (r.kind === 'lead') sendLeadText(leadRow(r.id), fill(body, vars), staff, 'group');
      else sendFamilyText(r.family_id, fill(body, vars), staff, 'group', get('SELECT * FROM parents WHERE id=?', r.id));
      sent++;
    } catch (e) { failed.push({ name: r.name, error: e.message }); }
  }
  return { sent, failed };
}

// ---- evaluations booked from the CRM ----
function evalSlots(role) {
  const booking = require('./booking');
  const coaches = Object.fromEntries(all('SELECT id, name FROM staff').map((s) => [s.id, s.name]));
  const loc = Object.fromEntries(all('SELECT id, name FROM locations').map((l) => [l.id, l.name]));
  return booking.openSlots('evaluation', booking.todayLocal(), 21).map((s) => ({
    starts_at: s.starts_at, duration_min: s.duration_min, coach_id: s.coach_id, coach: coaches[s.coach_id] || null, location: loc[s.location_id] || null,
    ...(role === 'owner' ? { price_cents: s.price_cents } : {}),
  }));
}
// Creates the evaluation session. With athleteId (a family already on file) the athlete is booked in; without, the session
// holds the time for the lead and the athlete is booked in when the lead becomes a client. Nothing is charged here:
// an evaluation with a price shows as unpaid on the roster and is collected at the door.
function bookEvaluation(l, startsAt, { athleteId = null, coachId = null } = {}) {
  const booking = require('./booking');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(startsAt || ''))) throw bad('Choose an evaluation time.');
  const slot = booking.openSlots('evaluation', startsAt.slice(0, 10), 1).find((s) => s.starts_at === startsAt && (!coachId || s.coach_id === Number(coachId)));
  if (!slot) throw bad('That time was just taken. Pick another.');
  let athlete = null;
  if (athleteId) {
    athlete = get('SELECT * FROM athletes WHERE id=? AND archived=0', Number(athleteId));
    if (!athlete || !l.family_id || athlete.family_id !== l.family_id) throw bad('Choose one of this family’s athletes.');
  }
  const names = JSON.parse(l.athletes || '[]').map((a) => a.name);
  const who = athlete ? fullName(athlete) : names.length ? names.join(' & ') : l.parent_name;
  return tx(() => {
    const eid = insert('events', { type: 'evaluation', name: `Evaluation: ${who}${athlete ? '' : ' (new enquiry)'}`, starts_at: startsAt, duration_min: slot.duration_min, capacity: 1,
      price_cents: slot.price_cents || 0, location_id: slot.location_id, coach_id: slot.coach_id, lead_id: l.id });
    if (athlete) booking.book(eid, athlete.id, { source: 'staff' });
    return get('SELECT * FROM events WHERE id=?', eid);
  });
}

// ---- convert a lead into a client, with no retyping ----
// b: optional overrides from the review form (parent fields, athletes with birthdays, plan, program).
function convertLead(l, b, staff) {
  if (l.family_id && l.converted_at) throw bad('This lead is already a client.');
  if (l.family_id) throw bad('This lead is linked to a family already. Book or start a membership from the client profile.');
  const athletes = Array.isArray(b.athletes) && b.athletes.length ? b.athletes : JSON.parse(l.athletes || '[]');
  const parentLast = String(b.parent_name || l.parent_name).trim().split(/\s+/).slice(-1)[0];
  const named = athletes.map((a) => {
    const name = String(a.name || '').trim();
    return { ...a, name: name.split(/\s+/).length >= 2 ? name : `${name} ${parentLast}`.trim() };
  }).filter((a) => a.name);
  const selfPays = b.with_parent === false || (!named.length);
  if (b.plan_id && staff.role === 'frontdesk') {
    const plan = get('SELECT trial_days FROM plans WHERE id=? AND active=1', Number(b.plan_id));
    if (plan && !plan.trial_days) throw new HttpError(403, 'The front desk can start a free trial but not a paid plan. Leave the plan for an owner.');
  }
  const first = named[0] || { name: l.parent_name };
  const form = {
    with_parent: !selfPays,
    name: first.name, birthday: first.birthday || null, grad_year: first.grad_year || null, sport: b.sport ?? l.sport, position: b.position ?? l.position, school: first.school || null,
    parent_name: b.parent_name || l.parent_name, parent_email: b.parent_email || l.email, parent_phone: b.parent_phone || messaging.formatPhone(l.phone) || null,
    email: b.parent_email || l.email, phone: b.parent_phone || messaging.formatPhone(l.phone) || null,
    plan_id: b.plan_id || null, program_id: b.program_id || null, allow_duplicate: b.allow_duplicate === true,
  };
  const siblings = named.slice(1).map((a) => ({ name: a.name, birthday: a.birthday || null, grad_year: a.grad_year || null, sport: form.sport, position: null }));
  const T = today();
  const r = require('./clients').createClient(form, {
    role: staff.role, siblings,
    inTx: ({ athlete, familyId, parentId, siblings: more }) => {
      update('crm_leads', l.id, { family_id: familyId, family_linked_on: T, converted_at: nowUtc() });
      // The parent keeps the lead's contact preferences.
      update('parents', parentId, { email_opt_out: l.email_opt_out, email_opt_out_at: l.email_opt_out_at, sms_opt_in: l.sms_opt_in, sms_opt_in_at: l.sms_opt_in_at, sms_opt_in_source: l.sms_opt_in_source, sms_opt_out: l.sms_opt_out, sms_opt_out_at: l.sms_opt_out_at });
      // Notes carry over to the client profile, with who wrote them and when.
      const notes = [];
      if (l.notes) notes.push({ body: l.notes, staff_name: l.created_by, created_at: l.created_at });
      for (const n of all("SELECT body, staff_id, staff_name, created_at FROM crm_activities WHERE lead_id=? AND kind IN ('note','call') AND body IS NOT NULL ORDER BY id", l.id)) notes.push(n);
      for (const n of notes) insert('client_notes', { athlete_id: athlete.id, staff_id: n.staff_id || null, staff_name: n.staff_name || null, body: `From the enquiry: ${n.body}`.slice(0, 2000), created_at: n.created_at });
      // An evaluation already held for the lead gets the athlete booked in.
      const booking = require('./booking');
      for (const e of all("SELECT id FROM events WHERE lead_id=? AND cancelled=0 AND starts_at>=?", l.id, booking.nowLocal().slice(0, 10))) {
        if (!get("SELECT 1 FROM bookings WHERE event_id=? AND status IN ('booked','waitlist')", e.id)) booking.book(e.id, athlete.id, { source: 'staff', quiet: true });
        update('events', e.id, { name: `Evaluation: ${fullName(athlete)}` });
      }
      run('UPDATE crm_tasks SET family_id=? WHERE lead_id=?', familyId, l.id);
      activity({ leadId: l.id, familyId, kind: 'converted', body: `Now a client: ${[athlete, ...more].map((x) => `${fullName(x)} (${x.code})`).join(', ')}`, staff });
    },
  });
  syncStages([l.id]);
  return r;
}

// ---- re-engage: a family whose trial ended without joining goes back into the pipeline ----
function reengage(familyId, staff, { note = null } = {}) {
  const fam = get('SELECT * FROM families WHERE id=?', Number(familyId));
  if (!fam) throw notFound('That family');
  const open = get(`SELECT id FROM crm_leads WHERE family_id=? AND stage IN (${OPEN_STAGES.map(() => '?').join(',')})`, fam.id, ...OPEN_STAGES);
  if (open) throw bad('This family is already in the pipeline.', { lead_id: open.id });
  if (get("SELECT 1 FROM memberships m JOIN athletes a ON a.id=m.athlete_id WHERE a.family_id=? AND m.status IN ('trial','active','past_due','paused')", fam.id)) throw bad('This family has a membership. Only families without one go back into the pipeline.');
  const p = primaryParent(fam.id);
  if (!p) throw bad('This family has no parent on file.');
  const T = today();
  const kids = all('SELECT first_name, last_name, birthday, grad_year, sport, position FROM athletes WHERE family_id=? AND archived=0 ORDER BY id', fam.id);
  const { ageOn } = require('../lib');
  const ended = trialsEnded().find((t) => t.family_id === fam.id);
  const id = tx(() => {
    const leadId = insert('crm_leads', {
      parent_name: p.name, email: p.email, phone: p.phone_e164 || null, athletes: JSON.stringify(kids.map((k) => ({ name: fullName(k), age: ageOn(k.birthday, T), grad_year: k.grad_year || null }))),
      sport: kids[0]?.sport || null, position: kids[0]?.position || null, source: 'other', source_detail: ended ? 'Trial ended without joining' : 'Former client', interest: 'group',
      owner_id: staff.role === 'frontdesk' || staff.role === 'owner' ? staff.id : null, stage: 'contacted', stage_changed_at: nowUtc(), last_activity_at: nowUtc(), first_contact: T,
      family_id: fam.id, family_linked_on: T, reengaged: 1, created_by: staff.name,
      email_opt_out: p.email_opt_out || 0, sms_opt_in: p.sms_opt_in || 0, sms_opt_in_at: p.sms_opt_in_at, sms_opt_in_source: p.sms_opt_in_source, sms_opt_out: p.sms_opt_out || 0,
    });
    insert('crm_stage_changes', { lead_id: leadId, from_stage: null, to_stage: 'contacted', auto: 0, staff_name: staff.name });
    activity({ leadId, familyId: fam.id, kind: 'reengaged', body: `${fam.name} back in the pipeline${ended ? ' after a trial that ended without joining' : ''}${note ? `: ${clean(note, 300)}` : ''}`, staff });
    return leadId;
  });
  const l = leadRow(id);
  emit('lead.created', webhookLead(l));
  return l;
}

// ---- website enquiry form ----
const enquiryHits = new Map(); // ip -> [timestamps]
const ENQUIRY_LIMIT = 5, ENQUIRY_WINDOW = 10 * 6e4;
function enquiryLimit(ip) {
  const now = Date.now();
  const recent = (enquiryHits.get(ip) || []).filter((t) => now - t < ENQUIRY_WINDOW);
  if (recent.length >= ENQUIRY_LIMIT) throw new HttpError(429, 'Thanks, we already have your enquiry. If you need us sooner, please call.', { retry_after: Math.ceil((recent[0] + ENQUIRY_WINDOW - now) / 1000) });
  recent.push(now);
  enquiryHits.set(ip, recent);
  if (enquiryHits.size > 5000) for (const [k, v] of enquiryHits) if (!v.some((t) => now - t < ENQUIRY_WINDOW)) enquiryHits.delete(k);
}
function notifyEmails() {
  const to = String(setting('crm_notify_email', '') || '').trim();
  if (to) return to.split(',').map((s) => s.trim()).filter((s) => EMAIL_RE.test(s));
  return all("SELECT email FROM staff WHERE role='owner' AND active=1").map((s) => s.email);
}
function websiteEnquiry(b, ip) {
  // Honeypot: people never see the "website" field; bots fill it. Answer as if it worked and save nothing.
  if (clean(b.website, 200) || clean(b.company_url, 200)) return { ok: true, spam: true };
  enquiryLimit(ip || 'unknown');
  const athletes = [];
  const name = clean(b.athlete_name, 80);
  if (name) athletes.push({ name, age: b.athlete_age || null, grad_year: b.grad_year || null });
  const message = cleanText(b.message);
  if (message && message.length > 2000) throw bad('Keep the message under 2,000 characters.');
  const input = { parent_name: b.parent_name, email: b.email, phone: b.phone, athletes, sport: b.sport, position: b.position, interest: b.interest || null, notes: message };
  const data = cleanLead({ ...input, source: 'website' });
  if (!data.email) throw bad('Enter your email so we can reply.');
  const wantsTexts = b.sms_opt_in === true || b.sms_opt_in === 'on' || b.sms_opt_in === 'true';
  // Someone who writes in again: added to their open lead instead of a second one.
  const existing = get(`SELECT * FROM crm_leads WHERE (email=? OR (? IS NOT NULL AND phone=?)) AND stage IN (${OPEN_STAGES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
    data.email, data.phone || null, data.phone || null, ...OPEN_STAGES);
  let lead;
  if (existing) {
    lead = existing;
    activity({ leadId: lead.id, familyId: lead.family_id, kind: 'enquiry', body: `Sent the website form again${message ? `: ${message}` : ''}` });
    if (wantsTexts && data.phone && !existing.sms_opt_out) update('crm_leads', lead.id, { sms_opt_in: 1, sms_opt_in_at: nowUtc(), sms_opt_in_source: 'Ticked "OK to text me" on the website form' });
  } else {
    lead = createLead(input, { source: 'website', by: 'the website form', allowDuplicate: true, smsConsent: wantsTexts && data.phone ? { source: 'Ticked "OK to text me" on the website form' } : null });
    if (message) activity({ leadId: lead.id, kind: 'enquiry', body: message });
  }
  const l = leadRow(lead.id);
  const kids = JSON.parse(l.athletes || '[]').map((a) => `${a.name}${a.age ? `, age ${a.age}` : ''}${a.grad_year ? `, class of ${a.grad_year}` : ''}`).join('; ');
  for (const to of notifyEmails()) {
    sendEmail(to, `New enquiry: ${l.parent_name}`, `${existing ? 'An existing lead sent the website form again.' : 'A new enquiry came in from the website form.'}\n\nName: ${l.parent_name}\nEmail: ${l.email || '-'}\nPhone: ${messaging.formatPhone(l.phone) || '-'}${kids ? `\nAthlete: ${kids}` : ''}${l.interest ? `\nInterested in: ${label(INTERESTS, l.interest)}` : ''}${message ? `\n\nMessage:\n${message}` : ''}\n\nOpen the lead: ${appUrl()}/app/crm/leads/${l.id}`);
  }
  return { ok: true, lead_id: l.id, existing: !!existing };
}

// ---- CSV import ----
const HEADERS = {
  parent_name: ['parent name', 'parent', 'name', 'contact', 'contact name', 'guardian'], email: ['email', 'e-mail', 'email address', 'parent email'],
  phone: ['phone', 'mobile', 'cell', 'phone number', 'parent phone'], athletes: ['athlete', 'athletes', 'athlete name', 'athlete names', 'child', 'kids'],
  age: ['age', 'athlete age'], grad_year: ['grad year', 'class', 'class of', 'graduation year'], sport: ['sport'], position: ['position'],
  source: ['source', 'lead source'], source_detail: ['referred by', 'referral', 'source detail'], interest: ['interest', 'interested in'],
  stage: ['stage', 'status'], notes: ['notes', 'note', 'message', 'comments'], first_contact: ['created', 'date', 'first contact', 'created date'], owner: ['owner', 'assigned to'],
};
const byLabel = (list, v) => { const s = String(v || '').trim().toLowerCase(); if (!s) return null; return list.find(([k, l]) => k === s || l.toLowerCase() === s || l.toLowerCase().startsWith(s))?.[0] || undefined; };
function planImport(text) {
  const rows = require('./testing-sheet').parseCSV(String(text || '')).filter((r) => r.some((c) => String(c).trim()));
  if (rows.length < 2) throw bad('The file needs a header row and at least one lead.');
  if (rows.length > 1001) throw bad('Import up to 1,000 leads at a time.');
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(HEADERS)) { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) col[k] = i; }
  if (col.parent_name == null) throw bad('Add a "Parent name" column (the header row names the columns).');
  if (col.email == null && col.phone == null) throw bad('Add an "Email" or "Phone" column.');
  const staffByKey = Object.fromEntries(crmStaff().flatMap((s) => [[s.name.toLowerCase(), s.id], [String(get('SELECT email FROM staff WHERE id=?', s.id).email).toLowerCase(), s.id]]));
  const seen = new Set();
  return rows.slice(1).map((r, i) => {
    const v = (k) => (col[k] == null ? '' : String(r[col[k]] ?? '').trim());
    const line = i + 2;
    try {
      const names = v('athletes') ? v('athletes').split(/[;&]|, | and /).map((s) => s.trim()).filter(Boolean) : [];
      const src = v('source') ? byLabel(SOURCES, v('source').replace(/-/g, ' ').replace(/^walk in$/, 'walk_in')) : 'other';
      if (src === undefined) throw bad(`"${v('source')}" isn't a source. Use one of: ${SOURCES.map((s) => s[1]).join(', ')}.`);
      const interest = v('interest') ? byLabel(INTERESTS, v('interest')) : null;
      if (interest === undefined) throw bad(`"${v('interest')}" isn't an interest. Use one of: ${INTERESTS.map((s) => s[1]).join(', ')}.`);
      const stage = v('stage') ? byLabel(STAGES, v('stage')) : 'new';
      if (stage === undefined || stage === 'lost' || stage === 'member') throw bad(v('stage') && ['lost', 'member'].includes(stage) ? 'Import open leads only (New, Contacted, Evaluation booked or Trial).' : `"${v('stage')}" isn't a stage.`);
      let owner = null;
      if (v('owner')) { owner = staffByKey[v('owner').toLowerCase()]; if (!owner) throw bad(`"${v('owner')}" isn't an owner or front desk person.`); }
      const date = v('first_contact');
      let first_contact = null;
      if (date) {
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(date);
        first_contact = m ? `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : date.slice(0, 10);
      }
      const athletes = names.map((name, j) => ({ name, age: j === 0 && v('age') ? Number(v('age')) : null, grad_year: j === 0 && v('grad_year') ? Number(v('grad_year')) : null }));
      if (!names.length && (v('age') || v('grad_year'))) throw bad('Add the athlete’s name for the age or grad year.');
      const data = cleanLead({ parent_name: v('parent_name'), email: v('email'), phone: v('phone'), athletes, sport: v('sport'), position: v('position'), source: src,
        source_detail: v('source_detail'), interest, notes: v('notes'), owner_id: owner, first_contact });
      const key = [data.email, data.phone].filter(Boolean);
      if (key.some((k) => seen.has(k))) return { line, status: 'duplicate', name: data.parent_name, email: data.email, phone: data.phone, reason: 'Appears earlier in this file', data: { ...data, stage } };
      key.forEach((k) => seen.add(k));
      const dups = duplicates(data);
      if (dups.length) return { line, status: 'duplicate', name: data.parent_name, email: data.email, phone: data.phone, reason: `Already on file: ${dups[0].name} (${dups[0].detail})`, data: { ...data, stage } };
      return { line, status: 'new', name: data.parent_name, email: data.email, phone: data.phone, source: label(SOURCES, data.source), data: { ...data, stage } };
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return { line, status: 'error', name: v('parent_name') || null, error: e.message };
    }
  });
}
function importLeads(text, { skipErrors = false, includeDuplicates = false } = {}, staff) {
  const rows = planImport(text);
  const errs = rows.filter((r) => r.status === 'error');
  if (errs.length && !skipErrors) throw bad(`Row ${errs[0].line}: ${errs[0].error} Fix it, or save the other rows and skip the ${errs.length === 1 ? 'one' : errs.length} with problems.`, { errors: errs });
  const take = rows.filter((r) => r.status === 'new' || (includeDuplicates && r.status === 'duplicate'));
  if (!take.length) throw bad('There are no new leads to save in this file.');
  const created = tx(() => take.map((r) => {
    const { stage, ...data } = r.data;
    const id = insert('crm_leads', { ...data, athletes: data.athletes, first_contact: data.first_contact || today(), stage, stage_changed_at: nowUtc(), last_activity_at: nowUtc(), created_by: `${staff.name} (import)` });
    insert('crm_stage_changes', { lead_id: id, from_stage: null, to_stage: stage, auto: 0, staff_name: staff.name });
    activity({ leadId: id, kind: 'created', body: `Imported from a spreadsheet · ${label(SOURCES, data.source)}`, staff });
    return id;
  }));
  for (const id of created) emit('lead.created', webhookLead(leadRow(id)));
  return { created: created.length, skipped: rows.length - created.length, errors: errs.length };
}
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=@\t\r]/.test(s) || /^[+-](?![\d\s().-]*$)/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function exportCsv(q) {
  const rows = listLeads(q, null);
  const head = ['Parent name', 'Email', 'Phone', 'Athletes', 'Age', 'Grad year', 'Sport', 'Position', 'Source', 'Referred by', 'Interest', 'Stage', 'Lost reason', 'Owner', 'First contact', 'Days in stage', 'Last activity', 'Unsubscribed', 'OK to text', 'Notes'];
  const lines = [head, ...rows.map((l) => [l.parent_name, l.email, l.phone_display, l.athlete_names, l.athletes[0]?.age ?? '', l.athletes[0]?.grad_year ?? '', l.sport, l.position, l.source_label, l.source_detail,
    l.interest_label, l.stage_label, l.lost_reason_label, l.owner_name, l.first_contact, l.days_in_stage, utcToDate(l.last_activity_at), l.email_opt_out ? 'Yes' : '', l.sms_opt_in && !l.sms_opt_out ? 'Yes' : '', l.notes])];
  return '﻿' + lines.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---- reports: leads that first got in touch in the period ----
function report(from, to) {
  if (!isDate(from) || !isDate(to)) throw bad('Choose a start and end date.');
  if (to < from) throw bad('The end date is before the start date.');
  const leads = all('SELECT * FROM crm_leads WHERE COALESCE(first_contact, substr(created_at,1,10)) BETWEEN ? AND ?', from, to);
  const joinedAt = (l) => get("SELECT MIN(created_at) t FROM crm_stage_changes WHERE lead_id=? AND to_stage='member'", l.id)?.t || null;
  const bySource = SOURCES.map(([k, name]) => {
    const list = leads.filter((l) => l.source === k);
    const members = list.filter((l) => l.stage === 'member').length;
    return { source: k, label: name, leads: list.length, members, rate: list.length ? Math.round((members / list.length) * 100) : null };
  }).filter((s) => s.leads);
  const members = leads.filter((l) => l.stage === 'member');
  const days = members.map((l) => { const t = joinedAt(l); return t ? Math.max(0, daysBetween(l.first_contact || utcToDate(l.created_at), utcToDate(t))) : null; }).filter((d) => d != null).sort((a, b) => a - b);
  const lost = LOST_REASONS.map(([k, name]) => ({ reason: k, label: name, count: leads.filter((l) => l.stage === 'lost' && l.lost_reason === k).length })).filter((r) => r.count);
  const stages = STAGES.map(([k, name]) => ({ stage: k, label: name, count: leads.filter((l) => l.stage === k).length }));
  return {
    from, to, leads: leads.length, members: members.length, conversion_rate: leads.length ? Math.round((members.length / leads.length) * 100) : null,
    by_source: bySource, lost_reasons: lost, stages,
    time_to_member: { count: days.length, average_days: days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null, median_days: days.length ? days[Math.floor((days.length - 1) / 2)] : null },
    open: leads.filter((l) => OPEN_STAGES.includes(l.stage)).length,
  };
}

module.exports = {
  STAGES, STAGE_KEYS, OPEN_STAGES, SOURCES, INTERESTS, LOST_REASONS, OUTCOMES, STALE_DAYS, label,
  templates, saveTemplates, fill, varsFor, unsubToken, readUnsubToken, unsubscribe, unsubInfo, unsubUrl,
  crmStaff, staffId, activity, leadRow, leadView, duplicates, cleanLead, createLead, moveStage, syncStages, syncLead, touch, listLeads, stageCounts, webhookLead,
  taskView, cleanTask, dueTasksFor, leadTimeline, familyTimeline, primaryParent,
  sendLeadEmail, sendFamilyEmail, sendLeadText, sendFamilyText, textBlock, setConsent, inboundSms,
  trialsEnded, segment, describeSegment, sendGroup, evalSlots, bookEvaluation, convertLead, reengage,
  websiteEnquiry, notifyEmails, planImport, importLeads, exportCsv, report, clean, cleanText, nowUtc, isDate,
  _resetEnquiryLimit: () => enquiryHits.clear(),
};
