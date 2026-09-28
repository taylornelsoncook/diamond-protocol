import { newId, v, notFound, badRequest, HttpError, isDate } from '../util.js';
import { getLead, todayDate, daysBetween } from './leads.js';

// Follow-up tasks (CRM, version 45): "call back Thursday", "send the camp flyer". Each is on a lead or on a client's
// family, due on a day (business time zone) and for one staff member; overdue and today's tasks show on that person's
// Today. Who does what (owner decision on leads):
// - Owners see and manage every task, and give tasks to anyone active.
// - Front desk see their own tasks (and every task on a lead they open); they give tasks to themselves, the owner or
//   other front desk, never to a coach (only the owner hands work to coaches).
// - Coaches see and add only their own tasks, and only on leads the owner gave them (or clients).
// An API key works like the owner.

const isCoach = (u) => u?.role === 'coach';
const forbidden = (m) => new HttpError(403, 'forbidden', m);
function assigneeFor(ctx, raw, user, lead) {
  const id = raw === undefined || raw === null || raw === '' ? user?.id : v.str(raw, 'assignee_id', { max: 64 });
  if (!id) throw badRequest('Pick who the task is for (assignee_id).');
  const a = ctx.db.get('SELECT id, name, role, active FROM users WHERE id = ?', id);
  if (!a) throw notFound('Staff member');
  if (!a.active) throw badRequest(`${a.name}'s account is turned off. Pick someone else.`);
  if (isCoach(user) && a.id !== user.id) throw forbidden('Coaches add tasks for themselves. Ask the owner to give work to someone else.');
  if (user?.role === 'front_desk' && a.role === 'coach') throw forbidden('Only the owner gives coaches work. Give the task to yourself or the owner.');
  // A coach can only work leads given to them, so a task on someone else's lead can't go to a coach.
  if (lead && a.role === 'coach' && lead.coach_id !== a.id) throw badRequest(`${a.name} can't see this lead. Give them the lead first, or pick someone else.`);
  return a;
}
function targetOf(ctx, body, user) {
  if (body.lead_id) {
    const l = getLead(ctx, v.str(body.lead_id, 'lead_id', { max: 64 }), { user });
    return { lead: l, lead_id: l.id, family_id: l.family_id ?? null, client_id: l.client_id ?? null };
  }
  if (body.client_id) {
    const c = ctx.db.get('SELECT id, family_id FROM clients WHERE id = ?', v.str(body.client_id, 'client_id', { max: 64 }));
    if (!c) throw notFound('Client');
    return { lead: null, lead_id: null, family_id: c.family_id ?? null, client_id: c.id };
  }
  throw badRequest('Say what the task is about: lead_id or client_id.');
}
const dueInput = (x, ctx) => {
  if (x === undefined || x === null || x === '') return todayDate(ctx);
  if (!isDate(String(x))) throw badRequest('due_date must be a date like 2026-10-01.');
  return String(x);
};
const SELECT = `SELECT t.*, u.name AS assignee_name, u.role AS assignee_role, l.parent_name AS lead_name, l.athlete_name AS lead_athlete, l.coach_id AS lead_coach_id, l.status AS lead_status, c.name AS client_name
  FROM crm_tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN clients c ON c.id = t.client_id`;
function shape(ctx, t, today = todayDate(ctx)) {
  const { lead_coach_id, ...rest } = t;
  return { ...rest, done: !!t.done_at, overdue: !t.done_at && t.due_date < today, due_today: !t.done_at && t.due_date === today, days_overdue: !t.done_at && t.due_date < today ? daysBetween(t.due_date, today) : 0,
    about: t.lead_id ? `${t.lead_name}${t.lead_athlete ? ` (for ${t.lead_athlete})` : ''}` : t.client_name ?? null, link: t.lead_id ? `#/leads/${t.lead_id}` : t.client_id ? `#/clients/${t.client_id}` : null };
}
// A task the signed-in person may see: owners all; others their own, and a coach only on leads still given to them.
function visible(t, user, { onLead = false } = {}) {
  if (!user || user.role === 'owner') return true;
  if (t.lead_id && isCoach(user) && t.lead_coach_id !== user.id) return false;
  if (onLead) return true;                                             // the lead's page: whoever may open the lead sees its tasks
  return t.assignee_id === user.id || t.created_by_id === user.id;
}
function taskRow(ctx, id, user) {
  const t = ctx.db.get(`${SELECT} WHERE t.id = ?`, String(id));
  if (!t || !visible(t, user, { onLead: !!t.lead_id })) throw notFound('Task');
  return t;
}
export function listTasks(ctx, q = {}, { user } = {}) {
  const where = [], args = [];
  const status = q.status ?? 'open';
  if (!['open', 'done', 'all'].includes(status)) throw badRequest('status must be open, done or all.');
  if (status === 'open') where.push('t.done_at IS NULL'); else if (status === 'done') where.push('t.done_at IS NOT NULL');
  if (q.lead_id) { getLead(ctx, String(q.lead_id), { user }); where.push('t.lead_id = ?'); args.push(String(q.lead_id)); }
  if (q.client_id) {
    const c = ctx.db.get('SELECT id, family_id FROM clients WHERE id = ?', String(q.client_id));
    if (!c) throw notFound('Client');
    where.push('t.lead_id IS NULL AND (t.client_id = ? OR (t.family_id IS NOT NULL AND t.family_id IS ?))'); args.push(c.id, c.family_id ?? null);
  }
  const mine = q.mine === 'true' || q.mine === true || (user && user.role !== 'owner' && !q.lead_id && !q.client_id);
  if (mine && user) { where.push('t.assignee_id = ?'); args.push(user.id); }
  if (q.assignee_id && (!user || user.role === 'owner')) { where.push('t.assignee_id = ?'); args.push(String(q.assignee_id)); }
  const today = todayDate(ctx);
  if (q.due === 'overdue') where.push(`t.due_date < '${today}'`);
  else if (q.due === 'today') where.push(`t.due_date <= '${today}'`);
  else if (q.due && q.due !== 'all') throw badRequest('due must be overdue, today or all.');
  const rows = ctx.db.all(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.done_at IS NOT NULL, t.due_date, t.created_at LIMIT 500`, ...args)
    .filter((t) => visible(t, user, { onLead: !!q.lead_id || !!q.client_id }));
  return { data: rows.map((t) => shape(ctx, t, today)), today };
}
// Overdue and today's open tasks for one person: their Today.
export function dueTasks(ctx, user) {
  if (!user?.id) return [];
  return listTasks(ctx, { status: 'open', due: 'today', mine: true }, { user }).data;
}
export function createTask(ctx, body, { user } = {}) {
  const target = targetOf(ctx, body, user);
  if (isCoach(user) && !target.lead && body.assignee_id && body.assignee_id !== user.id) throw forbidden('Coaches add tasks for themselves.');
  const a = assigneeFor(ctx, body.assignee_id, user, target.lead);
  const id = newId('task');
  ctx.db.run('INSERT INTO crm_tasks (id, lead_id, family_id, client_id, title, due_date, assignee_id, created_by_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, target.lead_id, target.family_id, target.client_id, v.str(body.title, 'what to do (title)', { max: 200 }), dueInput(body.due_date, ctx), a.id, user?.id ?? null, user?.name ?? 'API', ctx.now());
  if (target.lead_id) ctx.db.run('UPDATE leads SET last_activity_at = ?, updated_at = ? WHERE id = ?', ctx.now(), ctx.now(), target.lead_id);
  return shape(ctx, taskRow(ctx, id, user));
}
export function updateTask(ctx, id, body, { user } = {}) {
  const t = taskRow(ctx, id, user);
  // Changing a task is for the owner, the person it's for, and whoever added it.
  if (user && user.role !== 'owner' && t.assignee_id !== user.id && t.created_by_id !== user.id) throw forbidden('This task is someone else\'s. Ask the owner or the person it\'s for.');
  const lead = t.lead_id ? ctx.db.get('SELECT id, coach_id FROM leads WHERE id = ?', t.lead_id) : null;
  if (body.title !== undefined) ctx.db.run('UPDATE crm_tasks SET title = ? WHERE id = ?', v.str(body.title, 'what to do (title)', { max: 200 }), t.id);
  if (body.due_date !== undefined) ctx.db.run('UPDATE crm_tasks SET due_date = ? WHERE id = ?', dueInput(body.due_date, ctx), t.id);
  if (body.assignee_id !== undefined) ctx.db.run('UPDATE crm_tasks SET assignee_id = ? WHERE id = ?', assigneeFor(ctx, body.assignee_id, user, lead).id, t.id);
  if (body.done !== undefined) {
    if (typeof body.done !== 'boolean') throw badRequest('done must be true or false.');
    if (body.done) ctx.db.run('UPDATE crm_tasks SET done_at = COALESCE(done_at, ?), done_by = COALESCE(done_by, ?) WHERE id = ?', ctx.now(), user?.name ?? 'API', t.id);
    else ctx.db.run('UPDATE crm_tasks SET done_at = NULL, done_by = NULL WHERE id = ?', t.id);
    if (t.lead_id) ctx.db.run('UPDATE leads SET last_activity_at = ?, updated_at = ? WHERE id = ?', ctx.now(), ctx.now(), t.lead_id);
  }
  return shape(ctx, taskRow(ctx, id, user));
}
export function deleteTask(ctx, id, { user } = {}) {
  const t = taskRow(ctx, id, user);
  if (user && user.role !== 'owner' && t.created_by_id !== user.id) throw forbidden('Only the owner or whoever added a task deletes it. Mark it done instead.');
  ctx.db.run('DELETE FROM crm_tasks WHERE id = ?', t.id);
  return { ok: true };
}
