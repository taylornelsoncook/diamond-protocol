// Accountability, performance and education: the athlete app (/w/:token), the parent portal, and the coach side.
'use strict';
const { get, all, run, insert, update, tx, setting, setSetting } = require('../db');
const { h, bad, notFound, log } = require('../lib');
const { requireStaff, requireParent } = require('../auth');
const e = require('../services/engage');

const STAFF = requireStaff();
const COACH = requireStaff('owner', 'coach');
const noStore = (res) => res.set('Cache-Control', 'no-store');

function byToken(token) {
  if (!/^[\w-]{8,64}$/.test(String(token || ''))) throw notFound('That link');
  const a = get('SELECT * FROM athletes WHERE workout_token=? AND archived=0', token);
  if (!a) throw notFound('That link');
  return a;
}
function familyAthlete(req) {
  const a = get('SELECT * FROM athletes WHERE id=? AND family_id=? AND archived=0', Number(req.params.id) || 0, req.parent.family_id);
  if (!a) throw notFound('That athlete');
  return a;
}
const everything = (a, view, parentId = null) => ({
  athlete: { id: a.id, first_name: a.first_name, last_name: a.last_name, code: a.code },
  accountability: e.accountability(a.id, { parentId }), performance: e.performance(a.id, { view }), education: e.education(a.id),
});
const replyLog = (req, a, r, text) => log(req, `${r.who} replied to ${r.coach ? r.coach.split(' ')[0] : 'a coach'}`, text.length > 120 ? `${text.slice(0, 120)}…` : text);
const toInt = (v) => (v == null || v === '' ? null : Number(v));

function lessonBody(b) {
  const row = {};
  if ('title' in b) {
    row.title = String(b.title || '').trim(); if (!row.title) throw bad('Give the lesson a title.');
    if (row.title.length > 120) throw bad('Keep the title under 120 characters.');
  }
  if ('summary' in b) row.summary = String(b.summary || '').trim().slice(0, 300) || null;
  if ('body' in b) row.body = String(b.body || '').slice(0, 50000) || null;
  if ('video_url' in b) {
    row.video_url = String(b.video_url || '').trim() || null;
    if (row.video_url && !/^https:\/\//i.test(row.video_url)) throw bad('Video links must start with https://');
  }
  if ('minutes' in b) {
    row.minutes = toInt(b.minutes);
    if (row.minutes != null && !(Number.isInteger(row.minutes) && row.minutes >= 1 && row.minutes <= 120)) throw bad('Enter minutes to read as a whole number from 1 to 120.');
  }
  if ('course_id' in b) {
    row.course_id = toInt(b.course_id);
    if (row.course_id != null && !(Number.isInteger(row.course_id) && get('SELECT 1 FROM courses WHERE id=?', row.course_id))) throw bad('That course no longer exists.');
  }
  if ('ord' in b) { const o = toInt(b.ord) || 0; row.ord = Number.isInteger(o) ? Math.max(0, Math.min(o, 9999)) : 0; }
  if ('published' in b) row.published = b.published ? 1 : 0;
  return row;
}

function routes(api) {
  // ---- athlete app (private link) ----
  api.get('/w/:token/engage', (req, res) => { noStore(res); res.json(everything(byToken(req.params.token), 'athlete')); });
  api.post('/w/:token/checkin', h(async (req, res) => { const a = byToken(req.params.token); res.json(e.saveCheckin(a.id, req.body)); }));
  api.post('/w/:token/goals/:gid/check', h(async (req, res) => { const a = byToken(req.params.token); res.json(e.checkGoal(a.id, Number(req.params.gid), req.body.done !== false, req.body.date)); }));
  api.post('/w/:token/messages/read', h(async (req, res) => { const a = byToken(req.params.token); e.markRead(a.id); res.json({ ok: true }); }));
  api.post('/w/:token/messages/:mid/reply', h(async (req, res) => {
    const a = byToken(req.params.token);
    const r = e.replyToMessage(a.id, Number(req.params.mid), req.body.body);
    replyLog({ ip: req.ip }, a, r, String(req.body.body).trim());
    res.status(201).json({ ...r, messages: e.messagesFor(a.id) });
  }));
  api.get('/w/:token/lessons/:lid', (req, res) => { noStore(res); const a = byToken(req.params.token); const l = e.lessonFor(a.id, Number(req.params.lid)); e.recordView(a.id, l.id); res.json(l); });
  api.post('/w/:token/lessons/:lid/complete', h(async (req, res) => { const a = byToken(req.params.token); res.json(e.completeLesson(a.id, Number(req.params.lid), req.body.done !== false)); }));

  // ---- parent portal (a parent sees and helps their own athletes) ----
  api.get('/parent/athletes/:id/engage', requireParent, (req, res) => { noStore(res); res.json(everything(familyAthlete(req), 'parent', req.parent.id)); });
  api.post('/parent/athletes/:id/checkin', requireParent, h(async (req, res) => { res.json(e.saveCheckin(familyAthlete(req).id, req.body)); }));
  api.post('/parent/athletes/:id/goals/:gid/check', requireParent, h(async (req, res) => { res.json(e.checkGoal(familyAthlete(req).id, Number(req.params.gid), req.body.done !== false, req.body.date)); }));
  // A parent reading messages marks them read for that parent only; the athlete still sees them as new.
  api.post('/parent/athletes/:id/messages/read', requireParent, h(async (req, res) => { e.markRead(familyAthlete(req).id, { parentId: req.parent.id }); res.json({ ok: true }); }));
  api.post('/parent/athletes/:id/messages/:mid/reply', requireParent, h(async (req, res) => {
    const a = familyAthlete(req);
    const r = e.replyToMessage(a.id, Number(req.params.mid), req.body.body, { parent: req.parent });
    replyLog(req, a, r, String(req.body.body).trim());
    res.status(201).json({ ...r, messages: e.messagesFor(a.id, 30, { parentId: req.parent.id }) });
  }));
  api.get('/parent/athletes/:id/lessons/:lid', requireParent, (req, res) => { noStore(res); const a = familyAthlete(req); const l = e.lessonFor(a.id, Number(req.params.lid)); e.recordView(a.id, l.id); res.json(l); });
  api.post('/parent/athletes/:id/lessons/:lid/complete', requireParent, h(async (req, res) => { res.json(e.completeLesson(familyAthlete(req).id, Number(req.params.lid), req.body.done !== false)); }));

  // ---- coach side: one athlete ----
  api.get('/athletes/:id/engage', STAFF, (req, res) => res.json(e.staffOverview(Number(req.params.id))));
  api.post('/athletes/:id/goals', COACH, h(async (req, res) => {
    const a = e.athleteRow(Number(req.params.id)); if (!a) throw notFound('That athlete');
    const id = e.createGoal({ ...req.body, athlete_id: a.id, team_id: null }, req.staff.id);
    log(req, 'Set a goal', `${a.first_name} ${a.last_name}: ${get('SELECT title FROM goals WHERE id=?', id).title}`);
    res.status(201).json({ id });
  }));
  api.post('/athletes/:id/messages', COACH, h(async (req, res) => {
    const a = e.athleteRow(Number(req.params.id)); if (!a) throw notFound('That athlete');
    const id = e.sendMessage({ athlete_id: a.id, body: req.body.body }, req.staff);
    log(req, 'Sent a message', `${a.first_name} ${a.last_name}`);
    res.status(201).json({ id });
  }));
  api.post('/athletes/:id/targets', COACH, h(async (req, res) => {
    const a = e.athleteRow(Number(req.params.id)); if (!a) throw notFound('That athlete');
    const id = e.setTarget({ ...req.body, athlete_id: a.id }, req.staff.id);
    log(req, 'Set a test target', `${a.first_name} ${a.last_name}`);
    res.status(201).json({ id });
  }));
  api.delete('/targets/:id', COACH, h(async (req, res) => {
    const t = get(`SELECT tt.id, t.name, a.first_name, a.last_name FROM test_targets tt JOIN tests t ON t.id=tt.test_id JOIN athletes a ON a.id=tt.athlete_id WHERE tt.id=?`, Number(req.params.id));
    if (!t) throw notFound('That target');
    run('DELETE FROM test_targets WHERE id=?', t.id);
    log(req, 'Removed a test target', `${t.first_name} ${t.last_name}: ${t.name}`);
    res.json({ ok: true });
  }));

  // ---- coach side: a whole team ----
  const team = (req) => { const t = get('SELECT * FROM team_contracts WHERE id=?', Number(req.params.id)); if (!t) throw notFound('That team'); return t; };
  api.get('/teams/:id/engage', STAFF, (req, res) => {
    const t = team(req);
    res.json({
      goals: all('SELECT * FROM goals WHERE team_id=? AND active=1 ORDER BY id', t.id),
      messages: all('SELECT m.*, s.name AS coach FROM coach_messages m LEFT JOIN staff s ON s.id=m.staff_id WHERE m.team_id=? ORDER BY m.id DESC LIMIT 20', t.id),
    });
  });
  api.post('/teams/:id/goals', COACH, h(async (req, res) => {
    const t = team(req);
    const id = e.createGoal({ ...req.body, athlete_id: null, team_id: t.id }, req.staff.id);
    log(req, 'Set a team goal', t.team_name);
    res.status(201).json({ id });
  }));
  api.post('/teams/:id/messages', COACH, h(async (req, res) => {
    const t = team(req);
    const id = e.sendMessage({ team_id: t.id, body: req.body.body }, req.staff);
    log(req, 'Messaged a team', t.team_name);
    res.status(201).json({ id });
  }));
  api.put('/goals/:id', COACH, h(async (req, res) => {
    const g = get('SELECT * FROM goals WHERE id=?', Number(req.params.id)); if (!g) throw notFound('That goal');
    const patch = {};
    if ('active' in req.body) patch.active = req.body.active ? 1 : 0;
    if ('target' in req.body) { const t = Number(req.body.target); if (!(Number.isInteger(t) && t >= 1 && t <= 14)) throw bad('Set a weekly target from 1 to 14.'); patch.target = t; }
    if ('title' in req.body) patch.title = String(req.body.title || '').trim().slice(0, 120) || g.title;
    update('goals', g.id, patch);
    log(req, patch.active === 0 ? 'Ended a goal' : 'Changed a goal', g.title);
    res.json({ ok: true });
  }));

  // ---- red flags from check-ins (Today) ----
  api.get('/checkins/flags', STAFF, (_req, res) => res.json(e.recentFlags()));

  // ---- rankings setting ----
  api.get('/engage/settings', STAFF, (_req, res) => res.json({ rankings_enabled: !!setting('rankings_enabled', false) }));
  api.put('/engage/settings', COACH, h(async (req, res) => {
    setSetting('rankings_enabled', !!req.body.rankings_enabled);
    log(req, req.body.rankings_enabled ? 'Turned on rankings' : 'Turned off rankings');
    res.json({ ok: true });
  }));

  // ---- education (coach side) ----
  api.get('/education', STAFF, (_req, res) => res.json(e.educationReport()));
  api.get('/lessons/:id', STAFF, (req, res) => {
    const l = get('SELECT * FROM lessons WHERE id=?', Number(req.params.id)); if (!l) throw notFound('That lesson');
    res.json(l);
  });
  api.post('/lessons', COACH, h(async (req, res) => {
    const row = lessonBody({ published: true, ...req.body });
    if (!row.title) throw bad('Give the lesson a title.');
    if (row.course_id && !('ord' in req.body)) row.ord = (get('SELECT MAX(ord) m FROM lessons WHERE course_id=?', row.course_id).m ?? -1) + 1;
    const id = insert('lessons', row);
    log(req, 'Posted a lesson', row.title);
    res.status(201).json({ id });
  }));
  // Who finished a lesson, who opened it, and where it is assigned.
  api.get('/lessons/:id/progress', STAFF, (req, res) => res.json(e.lessonProgress(Number(req.params.id))));
  api.put('/lessons/:id', COACH, h(async (req, res) => {
    const l = get('SELECT * FROM lessons WHERE id=?', Number(req.params.id)); if (!l) throw notFound('That lesson');
    const row = lessonBody(req.body);
    // Moved into a different course without an order: it goes to the end of that course.
    if (row.course_id && row.course_id !== l.course_id && !('ord' in req.body)) row.ord = (get('SELECT MAX(ord) m FROM lessons WHERE course_id=?', row.course_id).m ?? -1) + 1;
    update('lessons', l.id, row);
    const verb = Object.keys(row).length === 1 && 'published' in row ? (row.published ? 'Published a lesson' : 'Unpublished a lesson') : 'Edited a lesson';
    log(req, verb, row.title || l.title);
    res.json({ ok: true });
  }));
  api.post('/lessons/:id/duplicate', COACH, h(async (req, res) => {
    const r = e.duplicateLesson(Number(req.params.id));
    log(req, 'Duplicated a lesson', r.title);
    res.status(201).json(r);
  }));
  api.delete('/lessons/:id', COACH, h(async (req, res) => {
    const l = get('SELECT * FROM lessons WHERE id=?', Number(req.params.id)); if (!l) throw notFound('That lesson');
    run('DELETE FROM lessons WHERE id=?', l.id);
    log(req, 'Deleted a lesson', l.title);
    res.json({ ok: true });
  }));
  api.post('/courses', COACH, h(async (req, res) => {
    const title = String(req.body.title || '').trim(); if (!title) throw bad('Give the course a title.');
    if (title.length > 120) throw bad('Keep the title under 120 characters.');
    const id = insert('courses', { title, description: String(req.body.description || '').trim() || null, published: req.body.published === false ? 0 : 1 });
    log(req, 'Created a course', title);
    res.status(201).json({ id });
  }));
  api.put('/courses/:id', COACH, h(async (req, res) => {
    const c = get('SELECT * FROM courses WHERE id=?', Number(req.params.id)); if (!c) throw notFound('That course');
    const patch = {};
    if ('title' in req.body) { patch.title = String(req.body.title || '').trim(); if (!patch.title) throw bad('Give the course a title.'); }
    if ('description' in req.body) patch.description = String(req.body.description || '').trim() || null;
    if ('published' in req.body) patch.published = req.body.published ? 1 : 0;
    if (patch.title && patch.title.length > 120) throw bad('Keep the title under 120 characters.');
    update('courses', c.id, patch);
    const verb = Object.keys(patch).length === 1 && 'published' in patch ? (patch.published ? 'Published a course' : 'Unpublished a course') : 'Edited a course';
    log(req, verb, patch.title || c.title);
    res.json({ ok: true });
  }));
  api.delete('/courses/:id', COACH, h(async (req, res) => {
    const c = get('SELECT * FROM courses WHERE id=?', Number(req.params.id)); if (!c) throw notFound('That course');
    run('UPDATE lessons SET course_id=NULL WHERE course_id=?', c.id); // lessons stay in the library
    run('DELETE FROM courses WHERE id=?', c.id);
    log(req, 'Deleted a course', c.title);
    res.json({ ok: true });
  }));
  // Reorder a course's lessons in one step.
  api.put('/courses/:id/order', COACH, h(async (req, res) => {
    const c = get('SELECT * FROM courses WHERE id=?', Number(req.params.id)); if (!c) throw notFound('That course');
    const ids = Array.isArray(req.body.lesson_ids) ? req.body.lesson_ids.map(Number) : [];
    const mine = new Set(all('SELECT id FROM lessons WHERE course_id=?', c.id).map((r) => r.id));
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !mine.has(id))) throw bad('That order doesn\'t match the lessons in this course. Reload the page and try again.');
    tx(() => ids.forEach((id, i) => run('UPDATE lessons SET ord=? WHERE id=? AND course_id=?', i, id, c.id)));
    log(req, 'Reordered a course', c.title);
    res.json({ ok: true });
  }));
  api.post('/assignments', COACH, h(async (req, res) => {
    const b = req.body || {};
    if (Array.isArray(b.athlete_ids)) {
      const r = e.assignMany({ lesson_id: toInt(b.lesson_id), course_id: toInt(b.course_id), athlete_ids: b.athlete_ids, due_date: b.due_date || null, note: b.note || null }, req.staff);
      log(req, 'Assigned reading', `${r.title} to ${r.assigned.join(', ')}`);
      return res.status(201).json(r);
    }
    const id = e.assign({ lesson_id: toInt(b.lesson_id), course_id: toInt(b.course_id), athlete_id: toInt(b.athlete_id), team_id: toInt(b.team_id), due_date: b.due_date || null, note: b.note || null }, req.staff);
    const x = get('SELECT COALESCE(l.title, c.title) AS t FROM assignments a LEFT JOIN lessons l ON l.id=a.lesson_id LEFT JOIN courses c ON c.id=a.course_id WHERE a.id=?', id);
    const who = b.athlete_id ? get("SELECT first_name || ' ' || last_name AS n FROM athletes WHERE id=?", toInt(b.athlete_id))?.n : get('SELECT team_name AS n FROM team_contracts WHERE id=?', toInt(b.team_id))?.n;
    log(req, 'Assigned reading', `${x?.t} to ${who}`);
    res.status(201).json({ id });
  }));
  const assignmentLabel = (id) => get(`SELECT COALESCE(l.title, c.title) AS title, COALESCE(a.first_name || ' ' || a.last_name, t.team_name) AS who FROM assignments x
    LEFT JOIN lessons l ON l.id=x.lesson_id LEFT JOIN courses c ON c.id=x.course_id LEFT JOIN athletes a ON a.id=x.athlete_id LEFT JOIN team_contracts t ON t.id=x.team_id WHERE x.id=?`, id);
  api.put('/assignments/:id', COACH, h(async (req, res) => {
    const x = e.updateAssignment(Number(req.params.id), req.body || {});
    const n = assignmentLabel(x.id);
    log(req, 'Changed an assignment', `${n.title} for ${n.who}`);
    res.json({ ok: true });
  }));
  api.post('/assignments/remind-overdue', COACH, h(async (req, res) => {
    const r = e.remindOverdue(req.staff);
    if (r.assignments) log(req, 'Sent overdue reading reminders', `${r.assignments} assignments, ${r.athletes} athletes`);
    res.json(r);
  }));
  api.post('/assignments/:id/remind', COACH, h(async (req, res) => {
    const r = e.remindAssignment(Number(req.params.id), req.staff);
    log(req, 'Sent a reading reminder', `${r.title} to ${r.names.join(', ')}`);
    res.json(r);
  }));
  api.delete('/assignments/:id', COACH, h(async (req, res) => {
    const n = assignmentLabel(Number(req.params.id)); if (!n) throw notFound('That assignment');
    run('DELETE FROM assignments WHERE id=?', Number(req.params.id));
    log(req, 'Removed an assignment', `${n.title} for ${n.who}`);
    res.json({ ok: true });
  }));
}

module.exports = { routes };
