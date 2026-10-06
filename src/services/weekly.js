// The weekly coach's note and the team board (version 71; owner decision, Farren improvements 7 and 8: a remote athlete
// hears from a person every week, and a program feels like a team even at home).
//
// Every Monday (weekly_notes: review by default, auto, or off) a line is drafted for each athlete on a program from last
// week's facts (workouts done against planned, sets, minutes, check-ins, the best lift, the run of clean weeks); the
// coaches read the drafts on the Programs page, change the words, and send (or Send all; auto mode sends the drafts as
// they are). A sent note shows on the athlete's Workout tab with the coach's name and taps the phone (push.js); it isn't
// an email. Streaks: clean weeks in a row = weeks with every planned workout done, from the training calendar. The team
// board (the owner's rankings setting on, and the athlete's own opt-in): this week's workouts done and clean weeks for
// everyone opted in on the athlete's teams and program, first name and last initial only.
import { newId, v, notFound, conflict, badRequest, addDaysToDate, weekdayOf } from '../util.js';
import { getSetting } from './families.js';
import { emit } from './events.js';
import { notify as pushNotify } from './push.js';
import { getProgram } from './programs.js';
import { datedWorkouts, today as localToday } from './training-calendar.js';

export const MODES = ['review', 'auto', 'off'];
const mode = (ctx) => { const m = getSetting(ctx, 'weekly_notes'); return MODES.includes(m) ? m : 'review'; };
const mondayOf = (date) => addDaysToDate(date, -((weekdayOf(date) + 6) % 7));
const parse = (s) => { try { return JSON.parse(s ?? 'null'); } catch { return null; } };
const first = (name) => String(name ?? '').split(' ')[0];
const initial = (name) => { const parts = String(name ?? '').trim().split(/\s+/); return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : parts[0]; };
const weekLabel = (ws) => { const d = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); return `${d(ws)} to ${d(addDaysToDate(ws, 6))}`; };
const activeOf = (ctx, clientId) => ctx.db.get('SELECT * FROM assignments WHERE client_id = ? AND active = 1', clientId);

// ---------- Weeks and streaks (the training calendar) ----------
// One athlete's calendar weeks: Monday → { planned, done, missed, skipped }, from the program's dates.
function weeksOf(ctx, clientId, program = null) {
  const a = activeOf(ctx, clientId);
  if (!a) return new Map();
  const cal = datedWorkouts(ctx, a, program ?? getProgram(ctx, a.program_id));
  const out = new Map();
  for (const w of cal.workouts) {
    if (w.status === 'skipped') continue;
    const ws = mondayOf(w.date), row = out.get(ws) ?? { planned: 0, done: 0, missed: 0, upcoming: 0 };
    row.planned++; if (w.status === 'done') row.done++; else if (w.status === 'missed') row.missed++; else row.upcoming++;
    out.set(ws, row);
  }
  return out;
}
// Clean weeks in a row: every planned workout done, counting back from last week (this week counts once it's complete).
export function planWeekStreak(ctx, clientId, { weeks = null } = {}) {
  const map = weeks ?? weeksOf(ctx, clientId);
  const thisMonday = mondayOf(localToday(ctx));
  const clean = (ws) => { const r = map.get(ws); return !!r && r.planned > 0 && r.done === r.planned; };
  let ws = clean(thisMonday) ? thisMonday : addDaysToDate(thisMonday, -7), n = 0;
  while (n < 104 && clean(ws)) { n++; ws = addDaysToDate(ws, -7); }
  return n;
}
// This week for the app's strip: planned, done, missed, sets logged, and the streak.
export function thisWeek(ctx, clientId) {
  const map = weeksOf(ctx, clientId), ws = mondayOf(localToday(ctx));
  const row = map.get(ws) ?? { planned: 0, done: 0, missed: 0, upcoming: 0 };
  const sets = ctx.db.get(`SELECT COUNT(*) AS n FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id WHERE l.client_id = ? AND l.completed_at >= ? AND l.completed_at < ?`, clientId, `${ws}T00:00:00`, `${addDaysToDate(ws, 7)}T00:00:00`).n;
  return { week_start: ws, ...row, sets, streak: planWeekStreak(ctx, clientId, { weeks: map }) };
}

// ---------- The facts and the draft ----------
const EPLEY = (w, r) => Math.round(w * (1 + r / 30));
export function factsFor(ctx, clientId, weekStart) {
  const from = weekStart, to = addDaysToDate(weekStart, 6);
  const lo = `${from}T00:00:00`, hi = `${addDaysToDate(to, 1)}T00:00:00`;
  const map = weeksOf(ctx, clientId);
  const wk = map.get(from) ?? { planned: 0, done: 0, missed: 0, upcoming: 0 };
  const logs = ctx.db.all('SELECT id, started_at, completed_at FROM workout_logs WHERE client_id = ? AND completed_at >= ? AND completed_at < ?', clientId, lo, hi);
  const minutes = logs.reduce((t, l) => { if (!l.started_at) return t; const m = (Date.parse(l.completed_at) - Date.parse(l.started_at)) / 60000; return t + (m > 0 && m <= 240 ? m : 0); }, 0);
  const sets = ctx.db.all(`SELECT s.exercise_name, s.weight, s.reps FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id WHERE l.client_id = ? AND l.completed_at >= ? AND l.completed_at < ?`, clientId, lo, hi);
  const checkins = ctx.db.get('SELECT COUNT(*) AS n FROM daily_checkins WHERE client_id = ? AND date BETWEEN ? AND ?', clientId, from, to).n;
  // The best estimated one-rep max of the week per exercise, against the best of the eight weeks before.
  const best = new Map();
  for (const s of sets) if (s.weight > 0 && s.reps >= 1 && s.reps <= 12) { const e = EPLEY(s.weight, s.reps); if ((best.get(s.exercise_name) ?? 0) < e) best.set(s.exercise_name, e); }
  const before = ctx.db.all(`SELECT s.exercise_name, MAX(s.weight * (1 + s.reps / 30.0)) AS e FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id
    WHERE l.client_id = ? AND l.completed_at >= ? AND l.completed_at < ? AND s.weight > 0 AND s.reps BETWEEN 1 AND 12 GROUP BY s.exercise_name`, clientId, `${addDaysToDate(from, -56)}T00:00:00`, lo);
  const prior = new Map(before.map((r) => [r.exercise_name, Math.round(r.e)]));
  const lifts = [...best.entries()].map(([name, e1rm]) => ({ name, e1rm, change: prior.has(name) ? e1rm - prior.get(name) : null })).sort((a, b) => (b.change ?? -1) - (a.change ?? -1) || b.e1rm - a.e1rm);
  return { week_start: from, planned: wk.planned, done: wk.done, missed: wk.missed, sets: sets.length, minutes: Math.round(minutes), checkins, streak: planWeekStreak(ctx, clientId, { weeks: map }), top_lift: lifts[0] ?? null, quiet: !wk.planned && !logs.length && !checkins };
}
// The drafted line, from the facts. Plain words a coach would say; the coach changes it before sending.
export function draftText(f, name) {
  const who = first(name);
  const parts = [];
  if (f.planned) {
    if (f.done === f.planned) parts.push(f.streak >= 2 ? `${f.done} of ${f.planned} workouts done, ${f.streak} clean weeks in a row. That's how it's built.` : `All ${f.planned} workouts done last week. That's how it's built.`);
    else if (f.done) parts.push(`${f.done} of ${f.planned} workouts last week. ${f.missed === 1 ? 'One slipped' : `${f.missed} slipped`}; let's get every one this week.`);
    else parts.push(`Nothing logged last week. One workout this week gets it moving again; just open the app and start.`);
  } else if (f.sets) parts.push(`${f.sets} sets logged last week.`);
  if (f.top_lift?.change > 0) parts.push(`${f.top_lift.name} is up about ${f.top_lift.change} lb on your estimated max.`);
  else if (f.top_lift && f.done) parts.push(`Best work: ${f.top_lift.name}, around ${f.top_lift.e1rm} lb estimated max.`);
  if (f.checkins >= 5) parts.push(`${f.checkins} check-ins, which is what lets me adjust your days.`);
  else if (f.planned && f.checkins === 0) parts.push(`Check in before you train this week so I can see how you're feeling.`);
  return parts.length ? `${who}: ${parts.join(' ')}` : `${who}: a quiet week. This week, one workout and one check-in.`;
}

// ---------- Drafts ----------
const SELECT = 'SELECT n.*, c.name AS client_name FROM weekly_notes n JOIN clients c ON c.id = n.client_id';
const shape = (r) => ({ id: r.id, client_id: r.client_id, client_name: r.client_name, week_start: r.week_start, week_label: weekLabel(r.week_start), body: r.body, drafted: r.drafted, facts: parse(r.facts), status: r.status, sent_at: r.sent_at, sent_by: r.sent_by, created_at: r.created_at, updated_at: r.updated_at });
const row = (ctx, id) => ctx.db.get(`${SELECT} WHERE n.id = ?`, String(id));
// Write the drafts for the week that just ended (or any week): every current athlete on a program. Athletes who already
// have a note for the week are left alone; a quiet week with nothing planned gets no note.
export function generateWeek(ctx, weekStart = addDaysToDate(mondayOf(localToday(ctx)), -7)) {
  const ws = mondayOf(weekStart);
  if (ws >= mondayOf(localToday(ctx))) throw badRequest('That week isn\'t over yet.');
  const rows = ctx.db.all('SELECT c.id, c.name FROM assignments a JOIN clients c ON c.id = a.client_id WHERE a.active = 1 AND c.archived_at IS NULL');
  let written = 0, kept = 0, quiet = 0;
  const now = ctx.now();
  for (const c of rows) {
    if (ctx.db.get('SELECT id FROM weekly_notes WHERE client_id = ? AND week_start = ?', c.id, ws)) { kept++; continue; }
    const f = factsFor(ctx, c.id, ws);
    if (f.quiet) { quiet++; continue; }
    const body = draftText(f, c.name);
    ctx.db.run('INSERT INTO weekly_notes (id, client_id, week_start, body, drafted, facts, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('wn'), c.id, ws, body, body, JSON.stringify(f), 'draft', now, now);
    written++;
  }
  return { week_start: ws, written, kept, quiet };
}
// Hourly: on Monday from 6 am business time, write last week's drafts once (weekly_notes_generated), and in auto mode send them.
export function runWeekly(ctx) {
  const m = mode(ctx);
  if (m === 'off') return { skipped: 'off' };
  const zone = getSetting(ctx, 'timezone');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ctx.now())).map((p) => [p.type, p.value]));
  if (Number(parts.hour) < 6) return { skipped: 'early' };
  const target = addDaysToDate(mondayOf(localToday(ctx)), -7);
  if (getSetting(ctx, 'weekly_notes_generated') === target) return { skipped: 'done' };
  const r = generateWeek(ctx, target);
  ctx.db.run(`INSERT INTO settings (key, value) VALUES ('weekly_notes_generated', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, target);
  let sent = 0;
  if (m === 'auto') for (const n of list(ctx, { week: target, status: 'draft' })) { send(ctx, n.id, { name: 'automatic' }); sent++; }
  return { ...r, sent };
}
export function list(ctx, { week, status, clientId } = {}) {
  const where = ['c.archived_at IS NULL'], p = [];
  if (week) { where.push('n.week_start = ?'); p.push(mondayOf(String(week).slice(0, 10))); }
  if (status && ['draft', 'sent', 'skipped'].includes(status)) { where.push('n.status = ?'); p.push(status); }
  if (clientId) { where.push('n.client_id = ?'); p.push(clientId); }
  return ctx.db.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY n.week_start DESC, c.name COLLATE NOCASE`, ...p).map(shape);
}
export const weeks = (ctx) => ctx.db.all(`SELECT week_start, COUNT(*) AS n, SUM(status = 'draft') AS drafts, SUM(status = 'sent') AS sent FROM weekly_notes GROUP BY week_start ORDER BY week_start DESC LIMIT 12`).map((w) => ({ ...w, label: weekLabel(w.week_start) }));
export function update(ctx, id, body = {}) {
  const n = row(ctx, id);
  if (!n) throw notFound('Weekly note');
  if (n.status === 'sent') throw conflict('This note was sent. It can\'t be changed now.');
  const text = v.str(body.body, 'body', { max: 600 });
  ctx.db.run('UPDATE weekly_notes SET body = ?, updated_at = ? WHERE id = ?', text, ctx.now(), n.id);
  return shape(row(ctx, id));
}
export function send(ctx, id, user) {
  const n = row(ctx, id);
  if (!n) throw notFound('Weekly note');
  if (n.status === 'sent') throw conflict('This note was already sent.');
  if (!String(n.body ?? '').trim()) throw badRequest('Write the note first.');
  const by = user?.name ?? 'Your coach';
  ctx.db.run(`UPDATE weekly_notes SET status = 'sent', sent_at = ?, sent_by = ?, updated_at = ? WHERE id = ?`, ctx.now(), by, ctx.now(), n.id);
  pushNotify(ctx, n.client_id, { title: `This week, from ${by === 'automatic' ? 'your coach' : `Coach ${first(by)}`}`, body: n.body, url: '/app', kind: 'weekly_note' });
  emit(ctx, 'weekly_note.sent', { weekly_note_id: n.id, client_id: n.client_id, client_name: n.client_name, week_start: n.week_start, by });
  return shape(row(ctx, id));
}
export function sendAll(ctx, week, user) {
  const drafts = list(ctx, { week: week ?? addDaysToDate(mondayOf(localToday(ctx)), -7), status: 'draft' });
  const sent = [], skipped = [];
  for (const n of drafts) { if (String(n.body ?? '').trim()) { send(ctx, n.id, user); sent.push(n.client_name); } else skipped.push(n.client_name); }
  return { sent: sent.length, skipped };
}
export function skip(ctx, id) {
  const n = row(ctx, id);
  if (!n) throw notFound('Weekly note');
  if (n.status === 'sent') throw conflict('This note was already sent.');
  ctx.db.run(`UPDATE weekly_notes SET status = 'skipped', updated_at = ? WHERE id = ?`, ctx.now(), n.id);
  return shape(row(ctx, id));
}
export const waiting = (ctx) => ctx.db.get(`SELECT COUNT(*) AS n, MIN(week_start) AS week FROM weekly_notes n JOIN clients c ON c.id = n.client_id WHERE n.status = 'draft' AND c.archived_at IS NULL`);
// The app's Workout tab: the latest sent note from the last two weeks.
export function forAthlete(ctx, clientId) {
  const since = addDaysToDate(mondayOf(localToday(ctx)), -14);
  const n = ctx.db.get(`SELECT id, body, sent_at, sent_by, week_start FROM weekly_notes WHERE client_id = ? AND status = 'sent' AND week_start >= ? ORDER BY week_start DESC LIMIT 1`, clientId, since);
  return n ? { id: n.id, body: n.body, by: n.sent_by === 'automatic' ? null : n.sent_by, sent_at: n.sent_at, week_label: weekLabel(n.week_start) } : null;
}

// ---------- The team board ----------
const boardOn = (ctx) => getSetting(ctx, 'rankings') === 'on';
export const optedIn = (ctx, clientId) => !!ctx.db.get('SELECT 1 FROM leaderboard_optins WHERE client_id = ?', clientId);
export function setOptIn(ctx, clientId, on) {
  if (on) ctx.db.run('INSERT OR IGNORE INTO leaderboard_optins (client_id, created_at) VALUES (?, ?)', clientId, ctx.now());
  else ctx.db.run('DELETE FROM leaderboard_optins WHERE client_id = ?', clientId);
  return board(ctx, clientId);
}
// This week's workouts done and clean weeks for everyone opted in on each of the athlete's teams and on their program
// (groups with fewer than 3 opted in aren't shown). Names are first name and last initial.
export function board(ctx, clientId) {
  const c = ctx.db.get('SELECT id, name FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  const on = boardOn(ctx), mine = optedIn(ctx, clientId);
  const groups = [];
  for (const t of ctx.db.all(`SELECT t.id, t.name, o.name AS org_name FROM team_roster r JOIN team_contracts t ON t.id = r.contract_id JOIN organizations o ON o.id = t.org_id WHERE r.client_id = ? AND r.active = 1`, clientId)) {
    groups.push({ key: `team:${t.id}`, label: `${t.org_name} ${t.name}`, ids: ctx.db.all('SELECT client_id FROM team_roster WHERE contract_id = ? AND active = 1 AND client_id IS NOT NULL', t.id).map((r) => r.client_id) });
  }
  const a = activeOf(ctx, clientId);
  if (a) { const p = ctx.db.get('SELECT id, name FROM programs WHERE id = ?', a.program_id); groups.push({ key: `program:${p.id}`, label: `Everyone on ${p.name}`, ids: ctx.db.all('SELECT client_id FROM assignments WHERE program_id = ? AND active = 1', p.id).map((r) => r.client_id) }); }
  const out = { enabled: on, opted_in: mine, groups: [], teams: groups.length };
  if (!on || !mine) return out;
  const cache = new Map();
  const statsOf = (id) => { if (!cache.has(id)) { const w = thisWeek(ctx, id); cache.set(id, w); } return cache.get(id); };
  const programs = new Map();
  for (const g of groups) {
    const members = ctx.db.all(`SELECT c.id, c.name FROM clients c JOIN leaderboard_optins o ON o.client_id = c.id WHERE c.archived_at IS NULL AND c.id IN (${g.ids.map(() => '?').join(', ') || "''"})`, ...g.ids);
    if (members.length < 3) continue;
    const rows = members.map((m) => { const s = statsOf(m.id); return { client_id: m.id, name: initial(m.name), me: m.id === clientId, done: s.done, planned: s.planned, streak: s.streak, sets: s.sets }; })
      .sort((x, y) => y.done - x.done || y.streak - x.streak || y.sets - x.sets || x.name.localeCompare(y.name));
    out.groups.push({ key: g.key, label: g.label, rows: rows.map((r, i) => ({ ...r, rank: i + 1 })) });
  }
  void programs;
  return out;
}
export const forExport = (ctx, clientId) => ({ weekly_notes: ctx.db.all('SELECT week_start, body, status, sent_at, sent_by FROM weekly_notes WHERE client_id = ? ORDER BY week_start', clientId), team_board_opt_in: optedIn(ctx, clientId) });
export function forgetClient(ctx, clientId) {
  ctx.db.run('DELETE FROM weekly_notes WHERE client_id = ?', clientId);
  ctx.db.run('DELETE FROM leaderboard_optins WHERE client_id = ?', clientId);
}
