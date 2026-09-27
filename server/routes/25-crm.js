// CRM: leads and the pipeline, lead detail and timeline, calls, notes, emails and texts, evaluations, converting and
// re-engaging, tasks, templates, group messages, import and export, reports and settings. Also the public website
// enquiry form, unsubscribe links, inbound texts (STOP/START/HELP), the SMS outbox, and leads in the open API.
// Owners do everything; the front desk works leads and their own tasks (no reports, group messages, import/export or
// money); coaches have no CRM.
'use strict';
const express = require('express');
const { get, all, run, update, setting, setSetting } = require('../db');
const { h, bad, notFound, HttpError, log, today, appUrl, businessName } = require('../lib');
const { requireStaff, requireApiKey } = require('../auth');
const crm = require('../services/crm');
const messaging = require('../messaging');

const CRM = requireStaff('owner', 'frontdesk');
const OWNER = requireStaff('owner');
const isOwner = (req) => req.staff.role === 'owner';
const intIn = (v, dflt, min, max) => { const n = Number(v); return Math.min(Math.max(v !== '' && v != null && Number.isFinite(n) ? Math.trunc(n) : dflt, min), max); };

function leadOr404(id) { return crm.leadRow(id); }
function familyOr404(id) {
  const f = get('SELECT * FROM families WHERE id=?', Number(id));
  if (!f) throw notFound('That family');
  return f;
}
function taskOr404(req) {
  const t = get('SELECT * FROM crm_tasks WHERE id=?', Number(req.params.id));
  if (!t) throw notFound('That task');
  // The front desk sees and works only the tasks assigned to them.
  if (req.staff.role === 'frontdesk' && t.assignee_id !== req.staff.id) throw notFound('That task');
  return t;
}
function familyInfo(familyId) {
  const f = get('SELECT id, name FROM families WHERE id=?', familyId);
  if (!f) return null;
  return {
    ...f,
    athletes: all('SELECT id, code, first_name, last_name FROM athletes WHERE family_id=? AND archived=0 ORDER BY id', familyId),
    parents: all('SELECT id, name, email, phone, phone_e164, email_opt_out, sms_opt_in, sms_opt_in_at, sms_opt_in_source, sms_opt_out, sms_opt_out_at FROM parents WHERE family_id=? ORDER BY is_self DESC, id', familyId)
      .map((p) => ({ ...p, email_opt_out: !!p.email_opt_out || crm.emailOptedOut(p.email), sms_opt_in: !!p.sms_opt_in, sms_opt_out: !!p.sms_opt_out, can_text: !crm.textBlock(p), text_block: crm.textBlock(p) })),
  };
}
function evaluationsFor(l, role) {
  const booking = require('../services/booking');
  const now = booking.nowLocal().slice(0, 10);
  const rows = all(`SELECT e.id, e.name, e.starts_at, e.duration_min, e.price_cents, e.cancelled, s.name AS coach, lo.name AS location,
      (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='booked') AS booked
    FROM events e LEFT JOIN staff s ON s.id=e.coach_id LEFT JOIN locations lo ON lo.id=e.location_id
    WHERE e.type='evaluation' AND e.cancelled=0 AND e.starts_at>=? AND (e.lead_id=? ${l.family_id ? 'OR e.id IN (SELECT b.event_id FROM bookings b JOIN athletes a ON a.id=b.athlete_id WHERE a.family_id=? AND b.status=\'booked\')' : ''})
    ORDER BY e.starts_at`, now, l.id, ...(l.family_id ? [l.family_id] : []));
  return rows.map(({ price_cents, ...e }) => (role === 'owner' ? { ...e, price_cents } : e));
}
function leadDetail(req, l) {
  crm.syncStages([l.id]);
  l = crm.leadRow(l.id);
  const desk = req.staff.role === 'frontdesk';
  const tasks = all(`SELECT * FROM crm_tasks WHERE lead_id=? ${desk ? 'AND assignee_id=?' : ''} ORDER BY done_at IS NOT NULL, due_date, id`, l.id, ...(desk ? [req.staff.id] : [])).map(crm.taskView);
  const view = crm.leadView(l, req.staff);
  return {
    lead: view, timeline: crm.leadTimeline(l, req.staff), tasks, evaluations: evaluationsFor(l, req.staff.role),
    family: l.family_id ? familyInfo(l.family_id) : null,
    can_text: !crm.textBlock(l), text_block: crm.textBlock(l), sms_mode: messaging.mode(), email_mode: require('../email').mode(),
    unsubscribe_url: isOwner(req) ? crm.unsubUrl('lead', l.id) : undefined,
  };
}
const parseBody = (b) => (b && typeof b === 'object' ? b : {});

function routes(api) {
  // ---- vocabulary, people and counts the screen needs ----
  api.get('/crm/meta', CRM, (req, res) => {
    res.json({
      stages: crm.STAGES, sources: crm.SOURCES, interests: crm.INTERESTS, lost_reasons: crm.LOST_REASONS, outcomes: crm.OUTCOMES, stale_days: crm.STALE_DAYS,
      staff: crm.crmStaff(), counts: crm.stageCounts(), templates: crm.templates(),
      sms_mode: messaging.mode(), sms_max_segments: messaging.MAX_SEGMENTS, email_mode: require('../email').mode(),
      my_open_tasks: get('SELECT COUNT(*) n FROM crm_tasks WHERE assignee_id=? AND done_at IS NULL', req.staff.id).n,
      my_overdue_tasks: get('SELECT COUNT(*) n FROM crm_tasks WHERE assignee_id=? AND done_at IS NULL AND due_date<?', req.staff.id, today()).n,
    });
  });

  // ---- leads ----
  api.get('/crm/leads', CRM, h(async (req, res) => {
    crm.syncStages();
    const leads = crm.listLeads(req.query, req.staff);
    res.json({ total: get('SELECT COUNT(*) n FROM crm_leads').n, counts: crm.stageCounts(), leads });
  }));

  // Board: every open lead, and those who joined or were lost in the last 30 days.
  api.get('/crm/board', CRM, h(async (req, res) => {
    crm.syncStages();
    const q = { ...req.query, stage: '' };
    const all_ = crm.listLeads(q, req.staff);
    const recent = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const columns = crm.STAGES.map(([k, name]) => {
      const list = all_.filter((l) => l.stage === k);
      const shown = ['member', 'lost'].includes(k) ? list.filter((l) => String(l.stage_changed_at).slice(0, 10) >= recent) : list;
      return { stage: k, label: name, total: list.length, older: list.length - shown.length, leads: shown };
    });
    res.json({ columns, counts: crm.stageCounts() });
  }));

  api.get('/crm/duplicates', CRM, h(async (req, res) => {
    const d = crm.cleanLead({ email: req.query.email || '', phone: req.query.phone || '' }, { partial: true });
    const except = Number(req.query.except) || 0;
    const fam = except ? get('SELECT family_id FROM crm_leads WHERE id=?', except)?.family_id : null;
    res.json({ duplicates: crm.duplicates(d, except).filter((x) => !(x.kind === 'family' && x.id === fam)) });
  }));

  api.post('/crm/leads', CRM, h(async (req, res) => {
    const b = parseBody(req.body);
    const l = crm.createLead(b, { staff: req.staff, allowDuplicate: b.allow_duplicate === true });
    log(req, 'Added a lead', `${l.parent_name} (${crm.label(crm.SOURCES, l.source)})`);
    res.status(201).json({ lead: crm.leadView(l, req.staff) });
  }));

  api.get('/crm/leads/:id', CRM, h(async (req, res) => { res.json(leadDetail(req, leadOr404(req.params.id))); }));

  api.put('/crm/leads/:id', CRM, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    const b = parseBody(req.body);
    const patch = crm.cleanLead(b, { partial: true });
    if (!Object.keys(patch).length) throw bad('Nothing to save.');
    if (('email' in patch || 'phone' in patch) && b.allow_duplicate !== true) {
      const dups = crm.duplicates({ email: 'email' in patch ? patch.email : l.email, phone: 'phone' in patch ? patch.phone : l.phone }, l.id)
        .filter((d) => !(d.kind === 'family' && d.id === l.family_id));
      if (dups.length) throw new HttpError(409, `That ${dups[0].match} is already on file (${dups[0].name}, ${dups[0].detail.toLowerCase()}). Open it, or save anyway.`, { duplicates: dups });
    }
    if (!(patch.email ?? l.email) && !(patch.phone ?? l.phone)) throw bad('Keep an email or a phone number so you can follow up.');
    if ('phone' in patch && patch.phone !== l.phone) Object.assign(patch, { sms_opt_in: 0, sms_opt_in_at: null, sms_opt_in_source: null }); // consent belongs to a number
    update('crm_leads', l.id, patch);
    log(req, 'Updated a lead', `${patch.parent_name || l.parent_name}`);
    res.json({ lead: crm.leadView(crm.leadRow(l.id), req.staff) });
  }));

  api.delete('/crm/leads/:id', OWNER, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    const booking = require('../services/booking');
    if (get('SELECT 1 FROM events WHERE lead_id=? AND cancelled=0 AND starts_at>=?', l.id, booking.nowLocal())) throw bad('Cancel the evaluation booked for this lead first.');
    run('UPDATE events SET lead_id=NULL WHERE lead_id=?', l.id);
    run('DELETE FROM crm_leads WHERE id=?', l.id);
    log(req, 'Deleted a lead', l.parent_name);
    res.json({ ok: true });
  }));

  api.post('/crm/leads/:id/stage', CRM, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    const b = parseBody(req.body);
    if (!crm.STAGE_KEYS.includes(b.stage)) throw bad('Choose a stage.');
    if (l.stage === b.stage && b.stage !== 'lost') throw bad(`${l.parent_name} is already in ${crm.label(crm.STAGES, b.stage)}.`);
    crm.moveStage(l, b.stage, { staff: req.staff, lostReason: b.lost_reason, lostNote: b.lost_note });
    log(req, 'Moved a lead', `${l.parent_name}: ${crm.label(crm.STAGES, l.stage)} to ${crm.label(crm.STAGES, b.stage)}`);
    res.json({ lead: crm.leadView(crm.leadRow(l.id), req.staff) });
  }));

  api.post('/crm/leads/:id/notes', CRM, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    const body = crm.cleanText(req.body?.body);
    if (!body) throw bad('Write the note first.');
    if (body.length > 2000) throw bad('Keep notes under 2,000 characters.');
    crm.activity({ leadId: l.id, familyId: l.family_id, kind: 'note', body, staff: req.staff });
    log(req, 'Added a lead note', l.parent_name);
    res.status(201).json({ ok: true });
  }));

  api.post('/crm/leads/:id/calls', CRM, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    const b = parseBody(req.body);
    if (!crm.OUTCOMES.some((o) => o[0] === b.outcome)) throw bad('Choose how the call went: reached, voicemail or no answer.');
    const body = crm.cleanText(b.body);
    if (body && body.length > 2000) throw bad('Keep call notes under 2,000 characters.');
    crm.activity({ leadId: l.id, familyId: l.family_id, kind: 'call', outcome: b.outcome, body, staff: req.staff });
    if (b.outcome !== 'no_answer') crm.touch(l, req.staff);
    log(req, 'Logged a call', `${l.parent_name}: ${crm.label(crm.OUTCOMES, b.outcome)}`);
    res.status(201).json({ lead: crm.leadView(crm.leadRow(l.id), req.staff) });
  }));

  api.post('/crm/leads/:id/email', CRM, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    const b = parseBody(req.body);
    crm.sendLeadEmail(l, { subject: b.subject, body: b.body }, req.staff);
    log(req, 'Emailed a lead', `${l.parent_name}: ${crm.clean(b.subject, 150)}`);
    res.json({ ok: true, lead: crm.leadView(crm.leadRow(l.id), req.staff), message: require('../email').mode() === 'test' ? `Saved to the outbox for ${l.email}. Test mode: it isn't sent.` : `Email sent to ${l.email}.` });
  }));

  api.post('/crm/leads/:id/text', CRM, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    const r = crm.sendLeadText(l, req.body?.body, req.staff);
    log(req, 'Texted a lead', l.parent_name);
    res.json({ ok: true, status: r.status, lead: crm.leadView(crm.leadRow(l.id), req.staff), message: r.status === 'logged' ? 'Text saved to the outbox. Test mode: it isn’t sent until a texting service is connected.' : r.status === 'held' ? 'Text held: this server only texts listed numbers.' : 'Text sent.' });
  }));

  api.post('/crm/leads/:id/consent', CRM, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    crm.setConsent('lead', l, parseBody(req.body), req.staff);
    log(req, 'Updated contact preferences', l.parent_name);
    res.json({ lead: crm.leadView(crm.leadRow(l.id), req.staff) });
  }));

  // ---- evaluations ----
  api.get('/crm/eval-slots', CRM, (req, res) => { res.json(crm.evalSlots(req.staff.role)); });

  api.post('/crm/leads/:id/evaluation', CRM, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    const b = parseBody(req.body);
    const e = crm.bookEvaluation(l, b.starts_at, { athleteId: b.athlete_id || null, coachId: b.coach_id || null });
    const { whenLocal } = require('../lib');
    crm.activity({ leadId: l.id, familyId: l.family_id, kind: 'booking', body: `Evaluation booked for ${whenLocal(e.starts_at)}`, staff: req.staff });
    const fresh = crm.leadRow(l.id);
    if (fresh.stage === 'lost' || ['new', 'contacted'].includes(fresh.stage)) crm.moveStage(fresh, 'evaluation', { staff: req.staff, auto: true, why: 'an evaluation is on the schedule' });
    log(req, 'Booked an evaluation', `${l.parent_name}: ${whenLocal(e.starts_at)}`);
    res.status(201).json({ event_id: e.id, starts_at: e.starts_at, lead: crm.leadView(crm.leadRow(l.id), req.staff) });
  }));

  api.post('/crm/evaluations/:eventId/cancel', CRM, h(async (req, res) => {
    const e = get("SELECT * FROM events WHERE id=? AND type='evaluation'", Number(req.params.eventId));
    if (!e) throw notFound('That evaluation');
    const lead = e.lead_id ? get('SELECT * FROM crm_leads WHERE id=?', e.lead_id) : null;
    if (!lead) throw bad('Cancel this evaluation from the schedule.');
    require('../services/booking').cancelEvent(e.id, crm.clean(req.body?.reason, 200) || 'Cancelled from the CRM');
    const { whenLocal } = require('../lib');
    crm.activity({ leadId: lead.id, familyId: lead.family_id, kind: 'booking', body: `Evaluation on ${whenLocal(e.starts_at)} cancelled`, staff: req.staff });
    log(req, 'Cancelled an evaluation', `${lead.parent_name}: ${whenLocal(e.starts_at)}`);
    res.json({ ok: true });
  }));

  // ---- converting and re-engaging ----
  api.post('/crm/leads/:id/convert', CRM, h(async (req, res) => {
    const l = leadOr404(req.params.id);
    const r = crm.convertLead(l, parseBody(req.body), req.staff);
    log(req, 'Converted a lead to a client', `${l.parent_name}: ${[r.athlete, ...r.siblings].map((a) => `${a.first_name} ${a.last_name} (${a.code})`).join(', ')}`);
    const reply = { athlete_id: r.athlete.id, code: r.athlete.code, family_id: r.familyId, athletes: [r.athlete, ...r.siblings].map((a) => ({ id: a.id, code: a.code, name: `${a.first_name} ${a.last_name}` })), lead: crm.leadView(crm.leadRow(l.id), req.staff) };
    if (r.membership) reply.membership = { ok: r.membership.ok, trial: !!r.membership.trial, error: r.membership.error || null };
    res.status(201).json(reply);
  }));

  api.get('/crm/reengage', CRM, (_req, res) => {
    res.json(crm.trialsEnded().map((f) => ({ ...f, athlete_id: get('SELECT id FROM athletes WHERE family_id=? ORDER BY archived, id LIMIT 1', f.family_id)?.id || null })));
  });
  api.post('/crm/reengage', CRM, h(async (req, res) => {
    const l = crm.reengage(req.body?.family_id, req.staff, { note: req.body?.note });
    log(req, 'Put a family back in the pipeline', l.parent_name);
    res.status(201).json({ lead: crm.leadView(l, req.staff) });
  }));

  // ---- families (clients) in the CRM: timeline, email, text, contact preferences ----
  api.get('/crm/families/:id/timeline', CRM, h(async (req, res) => {
    const f = familyOr404(req.params.id);
    crm.syncStages(all('SELECT id FROM crm_leads WHERE family_id=?', f.id).map((r) => r.id).concat([0]));
    const leads = all('SELECT * FROM crm_leads WHERE family_id=? ORDER BY id DESC', f.id).map((l) => crm.leadView(l, req.staff));
    const open = leads.find((l) => crm.OPEN_STAGES.includes(l.stage));
    const reengageable = !open && !!crm.trialsEnded().find((t) => t.family_id === f.id);
    res.json({ family: familyInfo(f.id), timeline: crm.familyTimeline(f.id, req.staff, { compact: req.query.compact === '1' }), leads, open_lead: open || null, can_reengage: reengageable,
      tasks: all(`SELECT * FROM crm_tasks WHERE family_id=? AND done_at IS NULL ${req.staff.role === 'frontdesk' ? 'AND assignee_id=?' : ''} ORDER BY due_date`, f.id, ...(req.staff.role === 'frontdesk' ? [req.staff.id] : [])).map(crm.taskView),
      sms_mode: messaging.mode(), email_mode: require('../email').mode() });
  }));
  api.post('/crm/families/:id/email', CRM, h(async (req, res) => {
    const f = familyOr404(req.params.id);
    const b = parseBody(req.body);
    const p = b.parent_id ? get('SELECT * FROM parents WHERE id=? AND family_id=?', Number(b.parent_id), f.id) : null;
    if (b.parent_id && !p) throw notFound('That parent');
    crm.sendFamilyEmail(f.id, { subject: b.subject, body: b.body }, req.staff, 'one', p);
    log(req, 'Emailed a family', `${f.name}: ${crm.clean(b.subject, 150)}`);
    res.json({ ok: true });
  }));
  api.post('/crm/families/:id/text', CRM, h(async (req, res) => {
    const f = familyOr404(req.params.id);
    const b = parseBody(req.body);
    const p = b.parent_id ? get('SELECT * FROM parents WHERE id=? AND family_id=?', Number(b.parent_id), f.id) : null;
    if (b.parent_id && !p) throw notFound('That parent');
    const r = crm.sendFamilyText(f.id, b.body, req.staff, 'one', p);
    log(req, 'Texted a family', f.name);
    res.json({ ok: true, status: r.status, message: r.status === 'logged' ? 'Text saved to the outbox. Test mode: it isn’t sent until a texting service is connected.' : r.status === 'held' ? 'Text held: this server only texts listed numbers.' : 'Text sent.' });
  }));
  api.post('/crm/parents/:id/consent', CRM, h(async (req, res) => {
    const p = get('SELECT * FROM parents WHERE id=?', Number(req.params.id));
    if (!p) throw notFound('That parent');
    crm.setConsent('parent', p, parseBody(req.body), req.staff);
    log(req, 'Updated contact preferences', p.name);
    res.json({ ok: true });
  }));

  // ---- tasks ----
  api.get('/crm/tasks', CRM, (req, res) => {
    const desk = req.staff.role === 'frontdesk';
    const mine = desk || req.query.scope !== 'all';
    const status = req.query.status === 'done' ? 'done' : 'open';
    const where = [status === 'done' ? 'done_at IS NOT NULL' : 'done_at IS NULL'];
    const args = [];
    if (mine) { where.push('assignee_id=?'); args.push(req.staff.id); }
    else if (req.query.assignee && Number(req.query.assignee)) { where.push('assignee_id=?'); args.push(Number(req.query.assignee)); }
    if (req.query.lead_id) { where.push('lead_id=?'); args.push(Number(req.query.lead_id)); }
    const rows = all(`SELECT * FROM crm_tasks WHERE ${where.join(' AND ')} ORDER BY ${status === 'done' ? 'done_at DESC' : 'due_date, id'} LIMIT 300`, ...args).map(crm.taskView);
    res.json({ tasks: rows, scope: mine ? 'mine' : 'all' });
  });
  api.post('/crm/tasks', CRM, h(async (req, res) => {
    const data = crm.cleanTask(parseBody(req.body));
    const { insert } = require('../db');
    const id = insert('crm_tasks', { ...data, created_by: req.staff.name });
    if (data.lead_id) crm.activity({ leadId: data.lead_id, familyId: data.family_id, kind: 'task_added', body: `For ${get('SELECT name FROM staff WHERE id=?', data.assignee_id).name}: ${data.title}, due ${new Date(data.due_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}`, staff: req.staff });
    log(req, 'Added a task', data.title);
    res.status(201).json({ task: crm.taskView(get('SELECT * FROM crm_tasks WHERE id=?', id)) });
  }));
  api.put('/crm/tasks/:id', CRM, h(async (req, res) => {
    const t = taskOr404(req);
    const patch = crm.cleanTask(parseBody(req.body), { partial: true });
    if (!Object.keys(patch).length) throw bad('Nothing to save.');
    update('crm_tasks', t.id, patch);
    log(req, 'Updated a task', patch.title || t.title);
    res.json({ task: crm.taskView(get('SELECT * FROM crm_tasks WHERE id=?', t.id)) });
  }));
  api.post('/crm/tasks/:id/done', CRM, h(async (req, res) => {
    const t = taskOr404(req);
    if (t.done_at) throw bad('That task is already done.');
    update('crm_tasks', t.id, { done_at: crm.nowUtc(), done_by: req.staff.name });
    if (t.lead_id || t.family_id) crm.activity({ leadId: t.lead_id, familyId: t.family_id, kind: 'task', body: t.title, staff: req.staff });
    log(req, 'Completed a task', t.title);
    res.json({ ok: true, message: `Done: ${t.title}.`, task: crm.taskView(get('SELECT * FROM crm_tasks WHERE id=?', t.id)) });
  }));
  api.post('/crm/tasks/:id/undo', CRM, h(async (req, res) => {
    const t = taskOr404(req);
    if (!t.done_at) throw bad('That task isn’t done.');
    update('crm_tasks', t.id, { done_at: null, done_by: null });
    log(req, 'Reopened a task', t.title);
    res.json({ ok: true, task: crm.taskView(get('SELECT * FROM crm_tasks WHERE id=?', t.id)) });
  }));
  api.delete('/crm/tasks/:id', CRM, h(async (req, res) => {
    const t = taskOr404(req);
    if (!isOwner(req) && t.created_by !== req.staff.name) throw new HttpError(403, 'Only the person who added a task, or an owner, can delete it.');
    run('DELETE FROM crm_tasks WHERE id=?', t.id);
    log(req, 'Deleted a task', t.title);
    res.json({ ok: true });
  }));

  // ---- templates and settings ----
  api.get('/crm/templates', CRM, (_req, res) => { res.json(crm.templates()); });
  api.put('/crm/templates', OWNER, h(async (req, res) => {
    const list = req.body?.reset ? (setSetting('crm_templates', null), crm.templates()) : crm.saveTemplates(req.body?.templates);
    log(req, req.body?.reset ? 'Reset CRM email templates' : 'Updated CRM email templates');
    res.json(list);
  }));
  api.get('/crm/settings', OWNER, (_req, res) => {
    const url = `${appUrl()}/enquire`;
    res.json({
      notify_email: setting('crm_notify_email', '') || '', notify_default: crm.notifyEmails(), form_url: url, form_json: `${appUrl()}/api/public/enquiry`,
      embed: `<iframe src="${url}?embed=1" title="Enquire about training at ${businessName().replace(/"/g, '&quot;')}" style="width:100%;max-width:560px;height:900px;border:0"></iframe>`,
      sms_mode: messaging.mode(), sms_inbound_url: `${appUrl()}/api/sms/inbound`,
    });
  });
  api.put('/crm/settings', OWNER, h(async (req, res) => {
    const v = String(req.body?.notify_email ?? '').trim();
    const list = v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (list.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw bad('Enter email addresses separated by commas, or leave it blank to email the owners.');
    if (list.length > 5) throw bad('Up to 5 addresses.');
    setSetting('crm_notify_email', list.join(', '));
    log(req, 'Updated enquiry notifications', list.join(', ') || 'owners');
    res.json({ ok: true, notify_email: list.join(', ') });
  }));

  // ---- group messages (owners): preview who gets it, then send ----
  const cleanSpec = (s) => {
    const spec = s && typeof s === 'object' ? s : {};
    return { audience: spec.audience === 'trials_ended' ? 'trials_ended' : 'leads', stage: String(spec.stage || ''), lost_reason: String(spec.lost_reason || ''), interest: String(spec.interest || ''), source: String(spec.source || '') };
  };
  api.post('/crm/group/preview', OWNER, h(async (req, res) => {
    const spec = cleanSpec(req.body?.segment);
    const channel = req.body?.channel === 'text' ? 'text' : 'email';
    const { recipients, excluded } = crm.segment(spec, channel);
    const strip = (r) => ({ kind: r.kind, id: r.id, name: r.name, email: r.email, phone: messaging.formatPhone(r.phone), detail: r.detail, reason: r.reason, href: r.kind === 'lead' ? `/app/crm/leads/${r.id}` : null });
    res.json({ description: crm.describeSegment(spec), channel, count: recipients.length, recipients: recipients.slice(0, 300).map(strip), excluded_count: excluded.length, excluded: excluded.slice(0, 300).map(strip), sms_mode: messaging.mode() });
  }));
  api.post('/crm/group/send', OWNER, h(async (req, res) => {
    const spec = cleanSpec(req.body?.segment);
    const channel = req.body?.channel === 'text' ? 'text' : 'email';
    const { recipients } = crm.segment(spec, channel);
    if (Number(req.body?.expected_count) !== recipients.length) throw new HttpError(409, `The group changed since the preview: it has ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'} now. Check the list again before sending.`, { count: recipients.length });
    const r = crm.sendGroup(spec, channel, { subject: req.body?.subject, body: req.body?.body }, req.staff);
    log(req, channel === 'text' ? 'Sent a group text' : 'Sent a group email', `${crm.describeSegment(spec)}: ${r.sent} sent${r.failed.length ? `, ${r.failed.length} not sent` : ''}${channel === 'email' ? ` · ${String(crm.clean(req.body?.subject, 150) || '').replace(/\{business\}/g, businessName())}` : ''}`);
    res.json(r);
  }));

  // ---- import and export (owners) ----
  api.post('/crm/import', OWNER, h(async (req, res) => {
    const b = typeof req.body === 'string' ? { text: req.body, preview: true } : parseBody(req.body);
    const text = String(b.text || '');
    if (!text.trim()) throw bad('Choose a CSV file or paste rows from your spreadsheet.');
    if (text.length > 1e6) throw bad('That file is too big. Import up to 1,000 leads at a time.');
    if (b.preview) {
      const rows = crm.planImport(text);
      const count = (s) => rows.filter((r) => r.status === s).length;
      return res.json({ rows: rows.map(({ data, ...r }) => r), counts: { new: count('new'), duplicate: count('duplicate'), error: count('error') } });
    }
    const r = crm.importLeads(text, { skipErrors: b.skip_errors === true, includeDuplicates: b.include_duplicates === true }, req.staff);
    log(req, 'Imported leads', `${r.created} added${r.skipped ? `, ${r.skipped} skipped` : ''}`);
    res.status(201).json(r);
  }));
  api.get('/crm/export.csv', OWNER, (req, res) => {
    log(req, 'Exported leads', Object.entries(req.query).map(([k, v]) => `${k}=${v}`).join(', ') || 'all');
    res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="leads-${today()}.csv"` }).send(crm.exportCsv(req.query));
  });

  // ---- reports (owners) ----
  api.get('/crm/reports', OWNER, h(async (req, res) => {
    crm.syncStages();
    const T = today();
    const { addDays } = require('../lib');
    res.json(crm.report(String(req.query.from || addDays(T, -89)), String(req.query.to || T)));
  }));

  // ---- SMS outbox (owners), and a simulated reply while in test mode ----
  api.get('/sms/outbox', OWNER, (req, res) => {
    const limit = intIn(req.query.limit, 50, 1, 200), offset = intIn(req.query.offset, 0, 0, 1e9);
    const where = [], args = [];
    if (['out', 'in'].includes(req.query.direction)) { where.push('m.direction=?'); args.push(req.query.direction); }
    if (['logged', 'queued', 'sent', 'failed', 'held', 'received'].includes(req.query.status)) { where.push('m.status=?'); args.push(req.query.status); }
    const q = String(req.query.q || '').trim();
    if (q) { const digits = q.replace(/\D/g, ''); where.push(`(m.body LIKE ?${digits.length >= 3 ? ' OR m.to_phone LIKE ? OR m.from_phone LIKE ?' : ''})`); args.push(`%${q}%`, ...(digits.length >= 3 ? [`%${digits}%`, `%${digits}%`] : [])); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const counts = Object.fromEntries(all("SELECT CASE WHEN direction='in' THEN 'received' ELSE status END s, COUNT(*) n FROM sms_messages GROUP BY s").map((r) => [r.s, r.n]));
    res.json({
      mode: messaging.mode(), provider: messaging.provider(), only_to: process.env.DP_SMS_ONLY_TO || null, counts,
      total: get(`SELECT COUNT(*) n FROM sms_messages m ${w}`, ...args).n,
      items: all(`SELECT m.*, l.parent_name AS lead_name, p.name AS parent_name FROM sms_messages m LEFT JOIN crm_leads l ON l.id=m.lead_id LEFT JOIN parents p ON p.id=m.parent_id ${w} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset)
        .map((m) => ({ ...m, to_display: messaging.formatPhone(m.to_phone), from_display: messaging.formatPhone(m.from_phone), segments: messaging.segments(m.body).segments })),
    });
  });

  // ---- inbound texts from the provider: STOP / START / HELP and replies, recorded on the timeline ----
  // With a provider connected the request must carry its signature; in test mode an owner can simulate a reply.
  api.post('/sms/inbound', express.urlencoded({ extended: false, limit: '64kb' }), h(async (req, res) => {
    const name = messaging.provider();
    const p = name ? messaging.PROVIDERS[name] : null;
    if (p) {
      if (!p.verifyInbound(req)) throw new HttpError(403, 'That request isn’t signed by the texting service.');
    } else if (req.staff?.role !== 'owner' || req.staff.must_change) {
      throw new HttpError(403, 'No texting service is connected. In test mode, an owner can simulate a reply from the SMS outbox.');
    }
    const b = parseBody(req.body);
    const msg = p ? p.parseInbound(b) : { from: b.from || b.From, to: b.to || b.To || 'test', body: b.body || b.Body, id: null };
    if (!messaging.toE164(msg.from)) throw bad('That isn’t a phone number.');
    if (!String(msg.body || '').trim()) throw bad('The message is empty.');
    const r = crm.inboundSms(msg);
    if (!p) log(req, 'Simulated a text reply', `${messaging.formatPhone(messaging.toE164(msg.from))}: ${String(msg.body).slice(0, 60)}`);
    if (p?.reply && !req.is('json')) return p.reply(res);
    res.json({ ok: true, ...r });
  }));

  // ---- public: the website enquiry form ----
  api.get('/public/enquiry-config', (_req, res) => {
    res.json({ business: businessName(), interests: crm.INTERESTS, sms_mode: messaging.mode() });
  });
  api.post('/public/enquiry', express.urlencoded({ extended: false, limit: '64kb' }), h(async (req, res) => {
    const r = crm.websiteEnquiry(parseBody(req.body), req.ip);
    res.status(r.spam ? 200 : 201).json({ ok: true, message: `Thanks. We have your enquiry and will be in touch within one business day.` });
  }));

  // ---- public: unsubscribe links in CRM emails ----
  api.get('/public/unsubscribe/:token', h(async (req, res) => { res.json(crm.unsubInfo(req.params.token)); }));
  api.post('/public/unsubscribe/:token', h(async (req, res) => {
    const r = crm.unsubscribe(req.params.token);
    if (!r.already) log(null, 'Unsubscribed from emails', `${r.kind === 'lead' ? 'Lead' : 'Parent'} ${r.email}`);
    res.json({ ok: true, already: r.already, business: businessName() });
  }));

  // ---- open API: leads ----
  const v1Lead = (l) => {
    const v = crm.leadView(l, null);
    return { id: v.id, parent_name: v.parent_name, email: v.email, phone: v.phone, athletes: v.athletes, sport: v.sport, position: v.position, source: v.source, source_detail: v.source_detail,
      interest: v.interest, stage: v.stage, lost_reason: v.lost_reason, first_contact: v.first_contact, stage_changed_at: v.stage_changed_at, family_id: v.family_id, created_at: v.created_at };
  };
  api.get('/v1/leads', requireApiKey, (req, res) => {
    const limit = intIn(req.query.limit, 100, 1, 500), offset = intIn(req.query.offset, 0, 0, 1e9);
    const where = ['1=1'], args = [];
    if (req.query.stage) { if (!crm.STAGE_KEYS.includes(req.query.stage)) throw bad(`"stage" must be one of: ${crm.STAGE_KEYS.join(', ')}.`); where.push('stage=?'); args.push(req.query.stage); }
    if (req.query.since) { if (!crm.isDate(req.query.since)) throw bad('"since" must be a date like 2026-09-01.'); where.push('COALESCE(first_contact, substr(created_at,1,10))>=?'); args.push(req.query.since); }
    const total = get(`SELECT COUNT(*) n FROM crm_leads WHERE ${where.join(' AND ')}`, ...args).n;
    const rows = all(`SELECT * FROM crm_leads WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    res.json({ data: rows.map(v1Lead), total, limit, offset });
  });
  api.get('/v1/leads/:id', requireApiKey, (req, res) => {
    const l = get('SELECT * FROM crm_leads WHERE id=?', Number(req.params.id));
    if (!l) throw notFound('That lead');
    res.json({ data: v1Lead(l) });
  });
  api.post('/v1/leads', requireApiKey, h(async (req, res) => {
    const b = parseBody(req.body);
    const l = crm.createLead({ ...b, source: b.source || 'other' }, { by: `API key ${req.apiKey.label}`, allowDuplicate: b.allow_duplicate === true });
    log(req, 'Added a lead', `${l.parent_name} (API)`);
    res.status(201).json({ data: v1Lead(l) });
  }));
}

module.exports = {
  routes,
  jobs: [
    { name: 'crm-stages', everyMin: 10, run: () => crm.syncStages() },
    { name: 'sms-retry', everyMin: 10, run: () => { messaging.retryFailed().catch((e) => console.error('[job sms-retry]', e)); } },
  ],
};
