import { newId, v, notFound, conflict, badRequest, HttpError } from '../util.js';
import { parentFilter } from './performance.js';
import { notify as pushNotify } from './push.js';
import { sendEmail } from './mail.js';
import { getSetting } from './families.js';
import { emit } from './events.js';

// Groups (version 87; owner's ask: "under the Teams tab I want to create a group ... rename the group, for example
// Kings 2031 ... put athletes into that group where they have access to go to it and it shows how many times they
// have attended, their best times sprints in each category, and be able to message the coach where everyone can see").
// A group is a name, a note and a coach, with members (clients) and a board. Nothing here carries money. A group is
// not a team contract: no school, no invoices; the same athlete can be in any number of groups.
export const MAX_NAME = 60;
export const MAX_NOTE = 500;
export const MAX_BODY = 1000;
export const MAX_MEMBERS = 200;
const COACH_EMAIL_GAP_MS = 60 * 60 * 1000;   // the coach is emailed about new messages at most once an hour per group

const row = (ctx, id) => { const g = ctx.db.get('SELECT * FROM groups WHERE id = ?', id); if (!g) throw notFound('Group'); return g; };
const nameTaken = (ctx, name, exceptId = null) => ctx.db.get('SELECT id FROM groups WHERE lower(name) = lower(?) AND id IS NOT ?', name, exceptId);
const coachOf = (ctx, id) => (id ? ctx.db.get(`SELECT id, name, email FROM users WHERE id = ? AND role IN ('owner', 'coach') AND active = 1`, id) : null);
const firstName = (name) => String(name ?? '').split(' ')[0];
const shortName = (name) => { const [first, ...rest] = String(name ?? '').trim().split(/\s+/); return rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first; };

function fields(ctx, body, { partial = false, exceptId = null } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = v.str(body.name, 'name', { max: MAX_NAME });
    if (nameTaken(ctx, out.name, exceptId)) throw conflict(`There is already a group called ${out.name}.`);
  }
  if (!partial || body.note !== undefined) out.note = v.str(body.note, 'note', { max: MAX_NOTE, optional: true });
  if (!partial || body.coach_id !== undefined) {
    const id = v.str(body.coach_id, 'coach_id', { max: 80, optional: true });
    if (id && !coachOf(ctx, id)) throw badRequest('coach_id must be an owner or coach whose account is on.');
    out.coach_id = id;
  }
  return out;
}

function shape(ctx, g) {
  const coach = coachOf(ctx, g.coach_id);
  const counts = ctx.db.get(`SELECT (SELECT COUNT(*) FROM group_members m JOIN clients c ON c.id = m.client_id WHERE m.group_id = ? AND c.archived_at IS NULL) AS members,
    (SELECT COUNT(*) FROM group_messages WHERE group_id = ? AND hidden_at IS NULL) AS messages,
    (SELECT MAX(created_at) FROM group_messages WHERE group_id = ? AND hidden_at IS NULL) AS last_message_at,
    (SELECT COUNT(*) FROM group_messages WHERE group_id = ? AND hidden_at IS NULL AND author_kind != 'staff' AND created_at > COALESCE((SELECT MAX(created_at) FROM group_messages WHERE group_id = ? AND author_kind = 'staff'), '')) AS unanswered`,
  g.id, g.id, g.id, g.id, g.id);
  return { id: g.id, name: g.name, note: g.note, coach_id: g.coach_id, coach_name: coach?.name ?? null, members: counts.members, messages: counts.messages, last_message_at: counts.last_message_at,
    unanswered: counts.unanswered, created_at: g.created_at, updated_at: g.updated_at };
}

export function listGroups(ctx) {
  return ctx.db.all('SELECT * FROM groups ORDER BY lower(name)').map((g) => shape(ctx, g));
}
export function createGroup(ctx, body = {}, actor = null) {
  const f = fields(ctx, body);
  const id = newId('grp'), now = ctx.now();
  ctx.db.run('INSERT INTO groups (id, name, note, coach_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, f.name, f.note, f.coach_id, now, now);
  const ids = Array.isArray(body.client_ids) && body.client_ids.length ? body.client_ids : null;
  const added = ids ? addMembers(ctx, id, { client_ids: ids }, actor) : null;
  return { ...shape(ctx, row(ctx, id)), ...(added ? { added: added.added, skipped: added.skipped } : {}) };
}
export function updateGroup(ctx, id, body = {}) {
  const g = row(ctx, id);
  const f = fields(ctx, body, { partial: true, exceptId: id });
  if (!Object.keys(f).length) throw badRequest('Send a name, a note or a coach_id to change.');
  const next = { ...g, ...f };
  ctx.db.run('UPDATE groups SET name = ?, note = ?, coach_id = ?, updated_at = ? WHERE id = ?', next.name, next.note, next.coach_id, ctx.now(), id);
  return shape(ctx, row(ctx, id));
}
// Deleting a group with members or messages asks first (confirm: true). The athletes' own data (attendance, results)
// is untouched: a group only points at profiles.
export function deleteGroup(ctx, id, { confirm = false } = {}) {
  const g = shape(ctx, row(ctx, id));
  if ((g.members || g.messages) && !confirm) {
    const e = new HttpError(409, 'confirm_needed', `${g.name} has ${g.members} ${g.members === 1 ? 'athlete' : 'athletes'} and ${g.messages} ${g.messages === 1 ? 'message' : 'messages'}. Send confirm: true to delete it anyway; the athletes' profiles are untouched.`);
    e.details = { members: g.members, messages: g.messages };
    throw e;
  }
  ctx.db.run('DELETE FROM groups WHERE id = ?', id);
  return { ok: true, deleted: id };
}

// ---------- Members ----------
// All or nothing like every list we take: each id is checked first; athletes already in the group or archived are
// skipped and named, anything unknown refuses the whole request.
export function addMembers(ctx, id, body = {}, actor = null) {
  row(ctx, id);
  const ids = Array.isArray(body.client_ids) ? body.client_ids : body.client_id ? [body.client_id] : null;
  if (!ids || !ids.length) throw badRequest('Send client_ids: the athletes to add.');
  if (ids.length > 100) throw badRequest('Add up to 100 athletes at a time.');
  const have = ctx.db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', id).n;
  const rows = [...new Set(ids.map(String))].map((cid) => {
    const c = ctx.db.get('SELECT id, name, athlete_id, archived_at FROM clients WHERE id = ? OR athlete_id = ?', cid, cid.toUpperCase());
    if (!c) throw badRequest(`No athlete with the id ${cid}.`);
    return c;
  });
  const added = [], skipped = [];
  ctx.db.tx(() => {
    for (const c of rows) {
      if (c.archived_at) { skipped.push({ id: c.id, name: c.name, reason: 'archived' }); continue; }
      if (ctx.db.get('SELECT 1 FROM group_members WHERE group_id = ? AND client_id = ?', id, c.id)) { skipped.push({ id: c.id, name: c.name, reason: 'already in the group' }); continue; }
      if (have + added.length >= MAX_MEMBERS) throw badRequest(`A group holds up to ${MAX_MEMBERS} athletes.`);
      ctx.db.run('INSERT INTO group_members (group_id, client_id, added_at, added_by) VALUES (?, ?, ?, ?)', id, c.id, ctx.now(), actor?.name ?? actor?.label ?? null);
      added.push({ id: c.id, name: c.name, athlete_id: c.athlete_id });
    }
    ctx.db.run('UPDATE groups SET updated_at = ? WHERE id = ?', ctx.now(), id);
  });
  return { added, skipped, group: shape(ctx, row(ctx, id)) };
}
export function removeMember(ctx, id, clientId) {
  row(ctx, id);
  const r = ctx.db.run('DELETE FROM group_members WHERE group_id = ? AND client_id = ?', id, clientId);
  if (!r.changes) throw notFound('Athlete in this group');
  ctx.db.run('UPDATE groups SET updated_at = ? WHERE id = ?', ctx.now(), id);
  return { ok: true, group: shape(ctx, row(ctx, id)) };
}
const isMember = (ctx, id, clientId) => !!ctx.db.get('SELECT 1 FROM group_members WHERE group_id = ? AND client_id = ?', id, clientId);

// ---------- What each athlete sees about themselves ----------
// Times attended: classes and sessions marked attended, team sessions, and door or tablet check-ins (the same three
// sources as the timeline and the monthly report).
export function attendanceCount(ctx, clientId) {
  const r = ctx.db.get(`SELECT (SELECT COUNT(*) FROM bookings WHERE client_id = ? AND status = 'attended')
    + (SELECT COUNT(*) FROM team_attendance WHERE client_id = ?)
    + (SELECT COUNT(*) FROM check_ins WHERE client_id = ?) AS n`, clientId, clientId, clientId);
  return r?.n ?? 0;
}
// The sprint tests: every active test in the library's speed category, with its first metric (the time, or top speed).
export function speedTests(ctx) {
  const metrics = ctx.db.all('SELECT * FROM perf_metrics ORDER BY sort');
  return ctx.db.all(`SELECT * FROM perf_tests WHERE active = 1 AND category = 'speed' ORDER BY sort, name`).map((t) => {
    const m = metrics.find((x) => x.test_id === t.id);
    return m ? { id: t.id, key: t.key, name: t.name, metric: m.key, metric_name: m.name, unit: m.unit, better: m.better, decimals: m.decimals } : null;
  }).filter(Boolean);
}
// The athlete's best on each sprint test: the lowest time (or the highest speed), over every result that isn't voided.
// familyView applies the family's rule (shared testing days, typed maxes), so an athlete never sees a result the
// coach hasn't shared yet.
export function bestsFor(ctx, clientId, { familyView = false, tests = speedTests(ctx) } = {}) {
  if (!tests.length) return [];
  const byTest = new Map(tests.map((t) => [t.id, t]));
  const rows = ctx.db.all(`SELECT r.test_id, r.metric, r.value, r.recorded_at FROM perf_results r WHERE r.client_id = ? AND r.voided = 0 AND r.test_id IN (${tests.map(() => '?').join(',')}) ${familyView ? parentFilter(ctx) : ''}`, clientId, ...tests.map((t) => t.id));
  const best = new Map();
  for (const r of rows) {
    const t = byTest.get(r.test_id);
    if (!t || r.metric !== t.metric) continue;
    const cur = best.get(t.id);
    const wins = !cur || (t.better === 'higher' ? r.value > cur.value : r.value < cur.value);
    if (wins) best.set(t.id, { value: r.value, recorded_at: r.recorded_at });
  }
  return tests.filter((t) => best.has(t.id)).map((t) => ({ test: t.key, test_id: t.id, name: t.name, metric: t.metric, metric_name: t.metric_name, unit: t.unit, decimals: t.decimals, better: t.better, ...best.get(t.id) }));
}

// ---------- The board ----------
function messageShape(m, { staff = false, me = null } = {}) {
  return { id: m.id, author_kind: m.author_kind, author_name: m.author_name, client_id: staff ? m.client_id : undefined, body: m.hidden_at && !staff ? null : m.body, created_at: m.created_at,
    hidden: !!m.hidden_at, hidden_by: staff ? m.hidden_by : undefined, mine: !!me && m.client_id === me && m.author_kind !== 'staff' };
}
export function listMessages(ctx, id, { before = null, limit = 30, staff = false, client = null } = {}) {
  row(ctx, id);
  if (client && !isMember(ctx, id, client.id)) throw notFound('Group');
  const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const rows = ctx.db.all(`SELECT * FROM group_messages WHERE group_id = ? ${staff ? '' : 'AND hidden_at IS NULL'} ${before ? 'AND created_at < ?' : ''} ORDER BY created_at DESC LIMIT ?`, id, ...(before ? [before] : []), n + 1);
  const page = rows.slice(0, n);
  return { data: page.map((m) => messageShape(m, { staff, me: client?.id ?? null })), next: rows.length > n ? page[page.length - 1].created_at : null };
}
// author: { kind: 'staff', user } | { kind: 'athlete', client } | { kind: 'parent', client, guardian }.
// A coach's message taps every member's phone (nothing personal in the push); an athlete's or parent's emails the
// group's coach (or the owners when the group has none) at most once an hour, so a busy board doesn't flood an inbox.
export function postMessage(ctx, id, author, body = {}) {
  const g = row(ctx, id);
  const text = v.str(body.body, 'body', { max: MAX_BODY });
  const staff = author.kind === 'staff';
  if (!staff) {
    if (!author.client || author.client.archived_at) throw notFound('Group');
    if (!isMember(ctx, id, author.client.id)) throw notFound('Group');
  }
  const name = staff ? (author.user?.name ?? 'Your coach') : author.kind === 'parent' ? `${author.guardian?.name ?? 'A parent'} (${firstName(author.client.name)}'s parent)` : firstName(author.client.name);
  const mid = newId('gm'), now = ctx.now();
  ctx.db.run('INSERT INTO group_messages (id, group_id, author_kind, client_id, user_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    mid, id, author.kind, staff ? null : author.client.id, staff ? (author.user?.id ?? null) : null, name, text, now);
  emit(ctx, 'group.message', { group_id: id, group_name: g.name, message_id: mid, author_kind: author.kind, author_name: name, client_id: staff ? null : author.client.id, athlete_name: staff ? null : author.client.name });
  if (staff) {
    for (const m of ctx.db.all('SELECT m.client_id FROM group_members m JOIN clients c ON c.id = m.client_id WHERE m.group_id = ? AND c.archived_at IS NULL', id)) {
      try { pushNotify(ctx, m.client_id, { title: `${g.name}: a message from ${firstName(name)}`, body: text.slice(0, 140), url: '/app#team', kind: 'group' }); } catch (e) { console.error('push:', e.message); }
    }
  } else {
    tellCoach(ctx, g, name, text);
  }
  return messageShape(ctx.db.get('SELECT * FROM group_messages WHERE id = ?', mid), { staff: true, me: staff ? null : author.client.id });
}
function tellCoach(ctx, g, from, text) {
  if (g.coach_told_at && Date.parse(ctx.now()) - Date.parse(g.coach_told_at) < COACH_EMAIL_GAP_MS) return;
  const coach = coachOf(ctx, g.coach_id);
  const to = coach ? [coach.email] : ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`).map((u) => u.email);
  if (!to.length) return;
  ctx.db.run('UPDATE groups SET coach_told_at = ? WHERE id = ?', ctx.now(), g.id);
  const base = ctx.publicUrl ?? '';
  const biz = getSetting(ctx, 'business_name');
  for (const email of to) {
    sendEmail(ctx, { to: email, subject: `${g.name}: a message from ${from}`, text: `${from} wrote on ${g.name}'s board:\n\n${text}\n\nEveryone in the group can read it. Answer it here: ${base}/#/teams/groups/${g.id}\n\n${biz}` }).catch(() => {});
  }
}
export function hideMessage(ctx, mid, actor, { hide = true } = {}) {
  const m = ctx.db.get('SELECT * FROM group_messages WHERE id = ?', mid);
  if (!m) throw notFound('Message');
  ctx.db.run('UPDATE group_messages SET hidden_at = ?, hidden_by = ? WHERE id = ?', hide ? ctx.now() : null, hide ? (actor?.name ?? 'Coach') : null, mid);
  return messageShape(ctx.db.get('SELECT * FROM group_messages WHERE id = ?', mid), { staff: true });
}
// An athlete (or a parent writing for them) takes back their own message. A coach's message is never theirs to remove.
export function removeOwnMessage(ctx, mid, clientId) {
  const m = ctx.db.get(`SELECT * FROM group_messages WHERE id = ? AND client_id = ? AND author_kind != 'staff'`, mid, clientId);
  if (!m) throw notFound('Message');
  ctx.db.run('DELETE FROM group_messages WHERE id = ?', mid);
  return { ok: true };
}

// ---------- Views ----------
// The coach's page: the group, every member with their attendance count and sprint bests, the tests that have a
// best among the members (the columns), and the latest messages (hidden ones included, marked).
export function getGroup(ctx, id) {
  const g = row(ctx, id);
  const tests = speedTests(ctx);
  const members = ctx.db.all(`SELECT c.id, c.name, c.athlete_id, c.archived_at, c.sport, c.grad_year, m.added_at FROM group_members m JOIN clients c ON c.id = m.client_id WHERE m.group_id = ? ORDER BY c.archived_at IS NOT NULL, lower(c.name)`, id)
    .map((c) => ({ client_id: c.id, name: c.name, athlete_id: c.athlete_id, archived: !!c.archived_at, sport: c.sport, grad_year: c.grad_year, added_at: c.added_at, attended: attendanceCount(ctx, c.id), bests: bestsFor(ctx, c.id, { tests }) }));
  const used = new Set(members.flatMap((m) => m.bests.map((b) => b.test_id)));
  return { ...shape(ctx, g), members, tests: tests.filter((t) => used.has(t.id)).map((t) => ({ test: t.key, test_id: t.id, name: t.name, unit: t.unit, better: t.better, decimals: t.decimals })),
    board: listMessages(ctx, id, { staff: true }) };
}
// The athlete's view (the app's Team tab; a parent through the family's Workout tab): each group they are in, their
// own numbers (never a teammate's), who else is in it by first name, and the board.
export function forClient(ctx, client) {
  const tests = speedTests(ctx);
  const groups = ctx.db.all('SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.client_id = ? ORDER BY lower(g.name)', client.id);
  const you = { attended: attendanceCount(ctx, client.id), bests: bestsFor(ctx, client.id, { familyView: true, tests }) };
  return { data: groups.map((g) => {
    const coach = coachOf(ctx, g.coach_id);
    const mates = ctx.db.all('SELECT c.name FROM group_members m JOIN clients c ON c.id = m.client_id WHERE m.group_id = ? AND c.archived_at IS NULL AND c.id != ? ORDER BY lower(c.name)', g.id, client.id).map((c) => shortName(c.name));
    return { id: g.id, name: g.name, note: g.note, coach_name: coach?.name ?? null, members: mates.length + 1, teammates: mates, board: listMessages(ctx, g.id, { client }) };
  }), you, tests: tests.map((t) => ({ test: t.key, name: t.name, unit: t.unit, better: t.better, decimals: t.decimals })) };
}
// The family export: the groups the athlete is in and what they (or a parent for them) wrote on the boards.
export function forExport(ctx, clientId) {
  return {
    groups: ctx.db.all('SELECT g.name, m.added_at FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.client_id = ? ORDER BY g.name', clientId),
    group_messages: ctx.db.all('SELECT g.name AS "group", m.author_kind, m.author_name, m.body, m.created_at FROM group_messages m JOIN groups g ON g.id = m.group_id WHERE m.client_id = ? ORDER BY m.created_at', clientId)
  };
}
