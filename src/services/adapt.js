// The adaptive plan (version 69; owner decision, the fourth Farren improvement: the plan bends around the athlete, not
// only the numbers). Programs are shared and never change here; what moves is one athlete's calendar:
//   shift    a whole training week went by with nothing done (every planned workout of the week missed): the start date
//            moves forward by those weeks, so the missed week comes round again instead of piling up as "missed".
//   minimum  three planned workouts missed in a row (adapt_minimum_streak): the rest of this week is a minimum week, half
//            the sets on every exercise (never below one), so getting back in is easy; the plan's numbers return next week.
//   advance  every planned workout done for the last two weeks, in a program with phases, with the current phase running
//            at least two more weeks: the next phase starts next week; the rest of this phase is skipped (dated in the
//            past, never counted missed) and the start date moves back so the later weeks keep their place.
// adapt_mode: suggest (default, the coach approves on Today or the client page), auto (applied at once), off. One open
// suggestion per athlete and kind; a decided one holds until the picture changes (a shift or minimum week waits a week,
// an advance waits for the next phase). Every change is undoable (applied says what moved).
import { newId, notFound, conflict, badRequest, addDaysToDate } from '../util.js';
import { getSetting } from './families.js';
import { emit } from './events.js';
import { getProgram } from './programs.js';
import { datedWorkouts, weekStats, dateOnly, today as localToday } from './training-calendar.js';

export const KINDS = ['shift', 'minimum', 'advance'];
export const MODES = ['suggest', 'auto', 'off'];
const ADVANCE_DAYS = 14, ADVANCE_MIN_DONE = 4, ADVANCE_WEEKS_LEFT = 2;
const mode = (ctx) => { const m = getSetting(ctx, 'adapt_mode'); return MODES.includes(m) ? m : 'suggest'; };
const minStreak = (ctx) => Math.min(6, Math.max(2, Number(getSetting(ctx, 'adapt_minimum_streak')) || 3));
const tz = (ctx) => getSetting(ctx, 'timezone');
const parse = (s) => { try { return JSON.parse(s ?? 'null'); } catch { return null; } };
const weekStartOf = (date) => { const d = new Date(`${date}T12:00:00Z`); return addDaysToDate(date, -((d.getUTCDay() + 6) % 7)); };   // Monday
const TEXT = {
  shift: (d) => `Move the plan ${d.weeks === 1 ? 'a week' : `${d.weeks} weeks`} forward: ${d.weeks === 1 ? 'the week' : 'the weeks'} nothing was done come${d.weeks === 1 ? 's' : ''} round again instead of counting as missed.`,
  minimum: (d) => `A minimum week through ${d.until}: half the sets on every exercise, just get the work in. The plan's numbers are back next week.`,
  advance: (d) => `Start ${d.next_phase} next week: skip the last ${d.weeks_skipped === 1 ? 'week' : `${d.weeks_skipped} weeks`} of ${d.phase} (${d.workouts_skipped} workouts).`
};
const shape = (r) => ({ id: r.id, client_id: r.client_id, client_name: r.client_name, assignment_id: r.assignment_id, kind: r.kind, status: r.status, detail: parse(r.detail) ?? {}, applied: parse(r.applied), text: TEXT[r.kind]?.(parse(r.detail) ?? {}) ?? '', created_at: r.created_at, decided_at: r.decided_at, decided_by: r.decided_by });
const SELECT = 'SELECT a.*, c.name AS client_name FROM plan_adjustments a JOIN clients c ON c.id = a.client_id';
const row = (ctx, id) => ctx.db.get(`${SELECT} WHERE a.id = ?`, String(id));

// ---------- Looking at one athlete ----------
// The program week a date falls in (1-based), from the start date.
const weekNo = (start, date) => Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / (7 * 86400000)) + 1;
function lastDecision(ctx, clientId, kind) {
  return ctx.db.get(`SELECT decided_at, created_at, status, detail FROM plan_adjustments WHERE client_id = ? AND kind = ? AND status != 'suggested' ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 1`, clientId, kind);
}
const openOne = (ctx, clientId, kind) => ctx.db.get(`SELECT id FROM plan_adjustments WHERE client_id = ? AND kind = ? AND status = 'suggested'`, clientId, kind);
// What this athlete's calendar calls for right now: a list of { kind, detail } (nothing already open or recently decided).
export function evaluate(ctx, a, program = getProgram(ctx, a.program_id)) {
  const cal = datedWorkouts(ctx, a, program);
  const day = cal.today, out = [];
  const planned = cal.workouts.filter((w) => w.status !== 'skipped');
  const sinceDecision = (kind, days) => { const d = lastDecision(ctx, a.client_id, kind); return !d || Date.parse(d.decided_at ?? d.created_at) < Date.parse(ctx.now()) - days * 86400000; };
  // shift: whole training weeks (Monday to Sunday, fully before this week) with every planned workout missed, counting back from last week.
  const thisMonday = weekStartOf(day);
  let weeks = 0;
  for (let monday = addDaysToDate(thisMonday, -7); ; monday = addDaysToDate(monday, -7)) {
    const inWeek = planned.filter((w) => w.date >= monday && w.date <= addDaysToDate(monday, 6));
    if (!inWeek.length || inWeek.some((w) => w.status !== 'missed')) break;
    weeks++;
    if (weeks >= 8) break;
  }
  if (weeks && !openOne(ctx, a.client_id, 'shift') && sinceDecision('shift', 6)) out.push({ kind: 'shift', detail: { weeks, from: addDaysToDate(thisMonday, -7 * weeks), start_date: cal.start_date, new_start_date: addDaysToDate(cal.start_date, 7 * weeks) } });
  // minimum: misses in a row (counting back from the latest planned workout before today), through the end of this week.
  // A whole missed week is the shift's to fix (it brings those workouts back), so no minimum week is offered beside it.
  const stats = weekStats(planned, day);
  const until = addDaysToDate(thisMonday, 6);
  const activeMin = activeMinimum(ctx, a.client_id, day);
  if (!weeks && stats.missed_streak >= minStreak(ctx) && !activeMin && !openOne(ctx, a.client_id, 'minimum') && sinceDecision('minimum', 6) && planned.some((w) => w.status !== 'done' && w.date >= day && w.date <= until)) {
    out.push({ kind: 'minimum', detail: { streak: stats.missed_streak, from: day, until } });
  }
  // advance: two clean weeks in a program with phases, the current phase running at least two more full weeks.
  const phases = ctx.db.all('SELECT id, name, kind, start_week, end_week FROM program_phases WHERE program_id = ? ORDER BY start_week', a.program_id);
  if (phases.length > 1 && !openOne(ctx, a.client_id, 'advance')) {
    const windowStart = addDaysToDate(day, -ADVANCE_DAYS);
    const recent = planned.filter((w) => w.date >= windowStart && w.date < day);
    const clean = recent.length >= ADVANCE_MIN_DONE && recent.every((w) => w.status === 'done');
    const wk = weekNo(cal.start_date, day);
    const phase = phases.find((p) => wk >= p.start_week && wk <= p.end_week);
    const next = phase ? phases.find((p) => p.start_week === phase.end_week + 1) : null;
    const weeksLeft = phase ? phase.end_week - wk : 0;
    const d = lastDecision(ctx, a.client_id, 'advance');
    const decidedThisPhase = d && parse(d.detail)?.phase_id === phase?.id;
    if (clean && phase && next && weeksLeft >= ADVANCE_WEEKS_LEFT && !decidedThisPhase) {
      const skipped = planned.filter((w) => w.week > wk && w.week <= phase.end_week && w.status !== 'done');
      out.push({ kind: 'advance', detail: { phase: phase.name, phase_id: phase.id, next_phase: next.name, next_phase_id: next.id, from_week: wk + 1, through_week: phase.end_week, weeks_skipped: weeksLeft, workouts_skipped: skipped.length, done_recently: recent.length } });
    }
  }
  return out;
}
// A minimum week in force today for this athlete: the approved row whose window covers the day.
export function activeMinimum(ctx, clientId, day = localToday(ctx)) {
  const r = ctx.db.all(`SELECT id, detail FROM plan_adjustments WHERE client_id = ? AND kind = 'minimum' AND status = 'approved' ORDER BY decided_at DESC LIMIT 5`, clientId)
    .map((x) => ({ id: x.id, ...(parse(x.detail) ?? {}) })).find((x) => x.from <= day && day <= x.until);
  return r ? { id: r.id, from: r.from, until: r.until, streak: r.streak } : null;
}

// ---------- Suggesting and applying ----------
function insert(ctx, a, { kind, detail }, { by = null } = {}) {
  const id = newId('adj');
  ctx.db.run('INSERT INTO plan_adjustments (id, client_id, assignment_id, kind, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, a.client_id, a.id, kind, 'suggested', JSON.stringify(detail), ctx.now());
  const r = shape(row(ctx, id));
  emit(ctx, 'plan.adjustment_suggested', { adjustment_id: id, client_id: a.client_id, client_name: r.client_name, kind, text: r.text, ...detail });
  return mode(ctx) === 'auto' ? apply(ctx, id, { name: by ?? 'automatic' }) : r;
}
// Check one athlete now (after a workout is logged, or from the hourly job); answers what was suggested or applied.
export function checkAthlete(ctx, clientId, { by = null } = {}) {
  if (mode(ctx) === 'off') return [];
  const a = ctx.db.get('SELECT a.* FROM assignments a JOIN clients c ON c.id = a.client_id WHERE a.client_id = ? AND a.active = 1 AND c.archived_at IS NULL', clientId);
  if (!a) return [];
  return evaluate(ctx, a).map((s) => insert(ctx, a, s, { by }));
}
// The hourly job: every current athlete on a program. Quiet before 6 am business time (nothing has been missed yet today).
export function runAdapt(ctx) {
  if (mode(ctx) === 'off') return { skipped: 'off' };
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz(ctx), hour: 'numeric', hourCycle: 'h23' }).format(new Date(ctx.now())));
  if (hour < 6) return { skipped: 'night' };
  const rows = ctx.db.all('SELECT a.* FROM assignments a JOIN clients c ON c.id = a.client_id WHERE a.active = 1 AND c.archived_at IS NULL');
  let suggested = 0, applied = 0;
  const programs = new Map();
  for (const a of rows) {
    if (!programs.has(a.program_id)) programs.set(a.program_id, getProgram(ctx, a.program_id));
    for (const s of evaluate(ctx, a, programs.get(a.program_id))) { const r = insert(ctx, a, s); if (r.status === 'approved') applied++; else suggested++; }
  }
  return { athletes: rows.length, suggested, applied };
}
// Approve: the change is made on the athlete's calendar and remembered for Undo.
export function apply(ctx, id, user) {
  const r = row(ctx, id);
  if (!r) throw notFound('Suggestion');
  if (r.status !== 'suggested') throw conflict(`This one was already ${r.status}.`);
  const a = ctx.db.get('SELECT * FROM assignments WHERE id = ? AND active = 1', r.assignment_id);
  if (!a) { ctx.db.run(`UPDATE plan_adjustments SET status = 'dismissed', decided_at = ?, decided_by = ? WHERE id = ?`, ctx.now(), 'program changed', id); throw conflict('The athlete is on another program now.'); }
  const d = parse(r.detail) ?? {};
  let applied = {};
  ctx.db.tx(() => {
    if (r.kind === 'shift') {
      const from = dateOnly(a.start_date, tz(ctx)), to = addDaysToDate(from, 7 * d.weeks);
      ctx.db.run('UPDATE assignments SET start_date = ? WHERE id = ?', to, a.id);
      const moves = ctx.db.all('SELECT workout_id, date FROM assignment_moves WHERE assignment_id = ?', a.id);
      for (const m of moves) ctx.db.run('UPDATE assignment_moves SET date = ? WHERE assignment_id = ? AND workout_id = ?', addDaysToDate(m.date, 7 * d.weeks), a.id, m.workout_id);
      applied = { start_date_before: from, start_date_after: to, moves: moves.length };
    } else if (r.kind === 'minimum') {
      applied = { from: d.from, until: d.until };
    } else if (r.kind === 'advance') {
      const program = getProgram(ctx, a.program_id);
      const cal = datedWorkouts(ctx, a, program);
      const logged = new Set(ctx.db.all('SELECT workout_id FROM workout_logs WHERE assignment_id = ?', a.id).map((l) => l.workout_id));
      const skip = program.workouts.filter((w) => w.week >= d.from_week && w.week <= d.through_week && !logged.has(w.id));
      for (const w of skip) ctx.db.run('INSERT OR IGNORE INTO assignment_skips (assignment_id, workout_id, adjustment_id, created_at) VALUES (?, ?, ?, ?)', a.id, w.id, id, ctx.now());
      ctx.db.run('DELETE FROM assignment_moves WHERE assignment_id = ? AND workout_id IN (SELECT workout_id FROM assignment_skips WHERE adjustment_id = ?)', a.id, id);
      const from = dateOnly(a.start_date, tz(ctx)), to = addDaysToDate(from, -7 * d.weeks_skipped);
      ctx.db.run('UPDATE assignments SET start_date = ? WHERE id = ?', to, a.id);
      const moves = ctx.db.all('SELECT workout_id, date FROM assignment_moves WHERE assignment_id = ?', a.id);
      for (const m of moves) ctx.db.run('UPDATE assignment_moves SET date = ? WHERE assignment_id = ? AND workout_id = ?', addDaysToDate(m.date, -7 * d.weeks_skipped), a.id, m.workout_id);
      // This week's remaining workouts keep their dates (pinned as moves), so only the weeks after move up.
      const pinned = cal.workouts.filter((w) => w.week < d.from_week && w.date >= cal.today && w.status !== 'done' && w.status !== 'skipped' && !moves.some((m) => m.workout_id === w.id));
      for (const w of pinned) ctx.db.run('INSERT OR REPLACE INTO assignment_moves (id, assignment_id, workout_id, date, moved_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId('mv'), a.id, w.id, w.date, 'adaptive plan', ctx.now());
      applied = { start_date_before: from, start_date_after: to, skipped: skip.map((w) => w.id), pinned: pinned.map((w) => w.id), moves: moves.length };
    }
    ctx.db.run(`UPDATE plan_adjustments SET status = 'approved', applied = ?, decided_at = ?, decided_by = ? WHERE id = ?`, JSON.stringify(applied), ctx.now(), user?.name ?? null, id);
  });
  const out = shape(row(ctx, id));
  emit(ctx, 'plan.adjustment_applied', { adjustment_id: id, client_id: r.client_id, client_name: r.client_name, kind: r.kind, text: out.text, by: user?.name ?? null, ...d });
  return out;
}
export function dismiss(ctx, id, user) {
  const r = row(ctx, id);
  if (!r) throw notFound('Suggestion');
  if (r.status !== 'suggested') throw conflict(`This one was already ${r.status}.`);
  ctx.db.run(`UPDATE plan_adjustments SET status = 'dismissed', decided_at = ?, decided_by = ? WHERE id = ?`, ctx.now(), user?.name ?? null, id);
  return shape(row(ctx, id));
}
// Undo an applied change: the calendar goes back as it was (a logged workout is never touched).
export function undo(ctx, id, user) {
  const r = row(ctx, id);
  if (!r) throw notFound('Adjustment');
  if (r.status === 'suggested') return dismiss(ctx, id, user);
  if (r.status !== 'approved') throw conflict(`This one was already ${r.status}.`);
  const ap = parse(r.applied) ?? {};
  const a = ctx.db.get('SELECT * FROM assignments WHERE id = ?', r.assignment_id);
  ctx.db.tx(() => {
    if (a?.active && r.kind === 'advance' && ap.pinned?.length) ctx.db.run(`DELETE FROM assignment_moves WHERE assignment_id = ? AND workout_id IN (${ap.pinned.map(() => '?').join(', ')})`, a.id, ...ap.pinned);
    if (a?.active && (r.kind === 'shift' || r.kind === 'advance') && ap.start_date_before) {
      const cur = dateOnly(a.start_date, tz(ctx));
      const delta = Math.round((Date.parse(`${ap.start_date_before}T12:00:00Z`) - Date.parse(`${ap.start_date_after}T12:00:00Z`)) / 86400000);
      ctx.db.run('UPDATE assignments SET start_date = ? WHERE id = ?', addDaysToDate(cur, delta), a.id);
      for (const m of ctx.db.all('SELECT workout_id, date FROM assignment_moves WHERE assignment_id = ?', a.id)) ctx.db.run('UPDATE assignment_moves SET date = ? WHERE assignment_id = ? AND workout_id = ?', addDaysToDate(m.date, delta), a.id, m.workout_id);
    }
    if (r.kind === 'advance') ctx.db.run('DELETE FROM assignment_skips WHERE adjustment_id = ?', id);
    ctx.db.run(`UPDATE plan_adjustments SET status = 'undone', decided_at = ?, decided_by = ? WHERE id = ?`, ctx.now(), user?.name ?? null, id);
  });
  return shape(row(ctx, id));
}
// Lists: for one athlete (the client page), or everything waiting (Today).
export function list(ctx, { clientId, status, limit = 50 } = {}) {
  const where = ['c.archived_at IS NULL'], p = [];
  if (clientId) { where.push('a.client_id = ?'); p.push(clientId); }
  if (status && ['suggested', 'approved', 'dismissed', 'undone'].includes(status)) { where.push('a.status = ?'); p.push(status); }
  return ctx.db.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ?`, ...p, Math.min(Math.max(Number(limit) || 50, 1), 200)).map(shape);
}
export const waiting = (ctx) => list(ctx, { status: 'suggested', limit: 100 });
// For the app's home: the minimum week in force, and changes made this week (so the athlete knows why the calendar moved).
export function forAthlete(ctx, clientId) {
  const day = localToday(ctx), weekAgo = new Date(Date.parse(ctx.now()) - 7 * 86400000).toISOString();
  const recent = ctx.db.all(`${SELECT} WHERE a.client_id = ? AND a.status = 'approved' AND a.decided_at >= ? ORDER BY a.decided_at DESC`, clientId, weekAgo).map(shape)
    .map((r) => ({ kind: r.kind, text: r.kind === 'shift' ? `Your plan moved ${r.detail.weeks === 1 ? 'a week' : `${r.detail.weeks} weeks`} forward: last ${r.detail.weeks === 1 ? 'week' : 'weeks'}' workouts are back on your calendar.` : r.kind === 'advance' ? `You're ahead: ${r.detail.next_phase} starts this week.` : null, at: r.decided_at }))
    .filter((r) => r.text);
  return { minimum: activeMinimum(ctx, clientId, day), recent };
}
export function settings(ctx) { return { mode: mode(ctx), minimum_streak: minStreak(ctx) }; }
export const forExport = (ctx, clientId) => ctx.db.all('SELECT kind, status, detail, created_at, decided_at FROM plan_adjustments WHERE client_id = ? ORDER BY created_at', clientId).map((r) => ({ ...r, detail: parse(r.detail) }));
export function forgetClient(ctx, clientId) {
  ctx.db.run('DELETE FROM assignment_skips WHERE assignment_id IN (SELECT id FROM assignments WHERE client_id = ?)', clientId);
  ctx.db.run('DELETE FROM plan_adjustments WHERE client_id = ?', clientId);
}
