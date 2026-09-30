// Training volume (Relay plan step 3): what an athlete has done, week by week and phase by phase, from the sets they
// logged. Sets, reps, tonnage (weight × reps, pounds), workouts and minutes per week (Monday to Sunday, business time
// zone), the same per exercise for the exercises they log most, and per phase of the program they're on (the planner's
// phases put on dates by their training calendar). Nothing is stored: it's all read from workout_logs and workout_sets.
import { notFound, localDate, addDaysToDate } from '../util.js';
import { getSetting } from './families.js';
import { getProgram } from './programs.js';
import { scheduleOf, weekOf } from './training-calendar.js';

export const VOLUME_WEEKS = 12;
const tz = (ctx) => getSetting(ctx, 'timezone');
const minutesOf = (l) => { if (!l.started_at) return 0; const m = Math.round((Date.parse(l.completed_at) - Date.parse(l.started_at)) / 60000); return m >= 1 && m <= 240 ? m : 0; };
const empty = () => ({ workouts: 0, sets: 0, reps: 0, tonnage: 0, minutes: 0 });
const add = (t, s) => { t.sets += 1; t.reps += s.reps ?? 0; t.tonnage += (s.weight ?? 0) * (s.reps ?? 0); };

// Every logged workout with its sets in the window, dated in the business time zone.
function logsSince(ctx, clientId, sinceDate) {
  const zone = tz(ctx);
  const logs = ctx.db.all(`SELECT l.id, l.completed_at, l.started_at, COALESCE(w.title, l.workout_title) AS title FROM workout_logs l LEFT JOIN workouts w ON w.id = l.workout_id
    WHERE l.client_id = ? AND l.completed_at >= ? ORDER BY l.completed_at`, clientId, `${sinceDate}T00:00:00.000Z`).map((l) => ({ ...l, date: localDate(l.completed_at, zone) })).filter((l) => l.date >= sinceDate);
  const sets = logs.length ? ctx.db.all(`SELECT s.workout_log_id, s.exercise_id, s.exercise_name, s.weight, s.reps FROM workout_sets s WHERE s.workout_log_id IN (${logs.map(() => '?').join(', ')})`, ...logs.map((l) => l.id)) : [];
  const byLog = new Map();
  for (const s of sets) byLog.set(s.workout_log_id, [...(byLog.get(s.workout_log_id) ?? []), s]);
  return logs.map((l) => ({ ...l, sets: byLog.get(l.id) ?? [] }));
}

// Weeks (oldest first, every week in the window even when empty), the top exercises with their weekly sets, and the
// phases of the athlete's current program with what was done in each.
export function volumeFor(ctx, clientId, { weeks = VOLUME_WEEKS } = {}) {
  if (!ctx.db.get('SELECT id FROM clients WHERE id = ?', clientId)) throw notFound('Client');
  const today = localDate(ctx.now(), tz(ctx));
  const thisWeek = weekOf(today).start;
  const starts = Array.from({ length: weeks }, (_, i) => addDaysToDate(thisWeek, -7 * (weeks - 1 - i)));
  const logs = logsSince(ctx, clientId, starts[0]);
  const weekRows = new Map(starts.map((s) => [s, { week_start: s, week_end: addDaysToDate(s, 6), ...empty() }]));
  const exRows = new Map();
  for (const l of logs) {
    const wk = weekRows.get(weekOf(l.date).start);
    if (!wk) continue;
    wk.workouts += 1; wk.minutes += minutesOf(l);
    for (const s of l.sets) {
      add(wk, s);
      const key = s.exercise_id ?? `name:${s.exercise_name}`;
      if (!exRows.has(key)) exRows.set(key, { exercise_id: s.exercise_id, name: s.exercise_name, ...empty(), top: 0, weeks: new Map(starts.map((x) => [x, 0])) });
      const e = exRows.get(key);
      add(e, s); e.top = Math.max(e.top, s.weight ?? 0);
      e.weeks.set(weekOf(l.date).start, (e.weeks.get(weekOf(l.date).start) ?? 0) + 1);
    }
  }
  const weeksOut = [...weekRows.values()].map((w) => ({ ...w, tonnage: Math.round(w.tonnage), current: w.week_start === thisWeek }));
  const cur = weeksOut.at(-1), prev = weeksOut.at(-2);
  const exercises = [...exRows.values()].sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name)).slice(0, 8)
    .map((e) => ({ exercise_id: e.exercise_id, name: e.name, sets: e.sets, reps: e.reps, tonnage: Math.round(e.tonnage), top: e.top, weekly_sets: starts.map((s) => ({ date: s, value: e.weeks.get(s) ?? 0 })) }));
  return { today, weeks: weeksOut, this_week: cur, last_week: prev ?? null, exercises, phases: phasesFor(ctx, clientId, today),
    totals: { workouts: logs.length, sets: weeksOut.reduce((t, w) => t + w.sets, 0), tonnage: weeksOut.reduce((t, w) => t + w.tonnage, 0), minutes: weeksOut.reduce((t, w) => t + w.minutes, 0) } };
}
// The current program's phases on the athlete's calendar: each phase's dates (from its first to its last workout's date,
// or the week span when a week has no workouts), planned and done workouts, and the sets and tonnage logged in it.
export function phasesFor(ctx, clientId, today = localDate(ctx.now(), tz(ctx))) {
  const a = ctx.db.get('SELECT * FROM assignments WHERE client_id = ? AND active = 1', clientId);
  if (!a) return [];
  const program = getProgram(ctx, a.program_id);
  const phases = ctx.db.all('SELECT id, name, kind, start_week, end_week, note FROM program_phases WHERE program_id = ? ORDER BY start_week', program.id);
  if (!phases.length) return [];
  const sched = scheduleOf(ctx, a, program);
  const logged = new Map(ctx.db.all('SELECT id, workout_id, completed_at FROM workout_logs WHERE assignment_id = ?', a.id).map((l) => [l.workout_id, l]));
  const setsOf = (logIds) => (logIds.length ? ctx.db.get(`SELECT COUNT(*) AS sets, COALESCE(SUM(COALESCE(weight, 0) * COALESCE(reps, 0)), 0) AS tonnage FROM workout_sets WHERE workout_log_id IN (${logIds.map(() => '?').join(', ')})`, ...logIds) : { sets: 0, tonnage: 0 });
  return phases.map((f) => {
    const ws = program.workouts.filter((w) => w.week >= f.start_week && w.week <= f.end_week);
    const dates = ws.map((w) => sched.dates.get(w.id)).sort();
    const start = dates[0] ?? addDaysToDate(sched.start_date, (f.start_week - 1) * 7), end = dates.at(-1) ?? addDaysToDate(sched.start_date, f.end_week * 7 - 1);
    const done = ws.filter((w) => logged.has(w.id));
    const v = setsOf(done.map((w) => logged.get(w.id).id));
    return { id: f.id, name: f.name, kind: f.kind, start_week: f.start_week, end_week: f.end_week, note: f.note, start_date: start, end_date: end,
      state: end < today ? 'past' : start > today ? 'ahead' : 'current', planned: ws.length, done: done.length, missed: ws.filter((w) => !logged.has(w.id) && sched.dates.get(w.id) < today).length,
      sets: v.sets, tonnage: Math.round(v.tonnage) };
  });
}
