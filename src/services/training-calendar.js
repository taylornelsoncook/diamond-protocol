// The training calendar (schema 62). A program is written as weeks and days ("week 2, day 3"); each athlete's copy lands
// on real dates: the coach picks the start date and the weekdays the athlete trains, and every workout gets a date.
// Week 1 is the seven days from the start date. Day 1 falls on the first training weekday from the start date on,
// day 2 on the next, and so on, so a program started on a Wednesday with Monday/Wednesday/Friday runs Wed, Fri, Mon.
// A "day 4" in a week with three training days still gets a date of its own (the next free weekday), never another
// workout's. One workout of one athlete can be moved to another date (assignment_moves); the plan itself never changes,
// and setting the schedule again clears the moves. The app opens on today's workout, else the earliest one missed, else
// the next one coming up, and the athlete can open any workout from the calendar.
import { newId, notFound, badRequest, conflict, localDate, weekdayOf, addDaysToDate, isDate } from '../util.js';
import { getSetting } from './families.js';
import { getProgram } from './programs.js';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The usual spread for a program with n days a week, until the coach picks otherwise.
export const DEFAULT_DAYS = { 1: [1], 2: [2, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5], 5: [1, 2, 3, 4, 5], 6: [1, 2, 3, 4, 5, 6], 7: [0, 1, 2, 3, 4, 5, 6] };
export const defaultDays = (n) => DEFAULT_DAYS[Math.min(7, Math.max(1, n || 1))];
const tz = (ctx) => getSetting(ctx, 'timezone');
export const today = (ctx) => localDate(ctx.now(), tz(ctx));
// The most days any week of the program has: its "day 4" needs four training days.
export const daysNeeded = (ctx, programId) => ctx.db.get('SELECT COALESCE(MAX(day), 0) AS d FROM workouts WHERE program_id = ?', programId).d;
// Rows from before version 62 kept a timestamp as the start; the date is the business day it fell on.
export const dateOnly = (s, zone) => (typeof s === 'string' && s.includes('T') ? localDate(s, zone) : String(s).slice(0, 10));

export function parseDays(val, { optional = false } = {}) {
  if (val === undefined || val === null || val === '') { if (optional) return null; throw badRequest('Pick the training days.'); }
  const list = Array.isArray(val) ? val : String(val).split(',');
  const days = [...new Set(list.map((x) => Number(String(x).trim())))];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw badRequest('Training days are weekdays from 0 (Sunday) to 6 (Saturday).');
  return days.sort((a, b) => a - b);
}
export function parseDate(val, field, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const s = String(val).slice(0, 10);
  if (!isDate(s)) throw badRequest(`${field} must be a date like 2026-10-05.`);
  return s;
}
const dayList = (days) => days.map((d) => WEEKDAYS[d].slice(0, 3)).join(', ');

// How many days after the week's start each program day falls: the training weekdays first, in order from the start
// date's weekday, then the other weekdays in the same order (index = program day - 1).
export function dayOffsets(startDate, trainingDays) {
  const start = weekdayOf(startDate);
  const off = (wd) => (wd - start + 7) % 7;
  const byOffset = (a, b) => off(a) - off(b);
  const rest = [0, 1, 2, 3, 4, 5, 6].filter((d) => !trainingDays.includes(d));
  return [...trainingDays].sort(byOffset).concat(rest.sort(byOffset)).map(off);
}
// The schedule of one assignment: start date, training days (the program's default until set), and a date for every workout.
export function scheduleOf(ctx, a, program) {
  const start = dateOnly(a.start_date, tz(ctx));
  const need = daysNeeded(ctx, program.id);
  const days = a.training_days ? parseDays(a.training_days) : defaultDays(need);
  const offsets = dayOffsets(start, days);
  const moves = new Map(ctx.db.all('SELECT workout_id, date FROM assignment_moves WHERE assignment_id = ?', a.id).map((m) => [m.workout_id, m.date]));
  const dates = new Map(program.workouts.map((w) => [w.id, moves.get(w.id) ?? addDaysToDate(start, (w.week - 1) * 7 + offsets[Math.min(Math.max(w.day, 1), 7) - 1])]));
  return { start_date: start, training_days: days, days_default: !a.training_days, days_needed: need, dates, moves };
}
// Every workout with its date and where it stands: done (logged), today, missed (dated before today and not logged) or
// upcoming, in date order.
export function datedWorkouts(ctx, a, program) {
  const s = scheduleOf(ctx, a, program);
  const day = today(ctx);
  const logged = new Map(ctx.db.all('SELECT id, workout_id, completed_at FROM workout_logs WHERE assignment_id = ?', a.id).map((l) => [l.workout_id, l]));
  const workouts = program.workouts.map((w) => {
    const date = s.dates.get(w.id), log = logged.get(w.id) ?? null;
    return { id: w.id, week: w.week, day: w.day, title: w.title, date, moved: s.moves.has(w.id), exercises: w.exercises.length,
      status: log ? 'done' : date === day ? 'today' : date < day ? 'missed' : 'upcoming', log_id: log?.id ?? null, completed_at: log?.completed_at ?? null };
  }).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.week - y.week || x.day - y.day));
  const count = (st) => workouts.filter((w) => w.status === st).length;
  return { today: day, start_date: s.start_date, training_days: s.training_days, days_default: s.days_default, days_needed: s.days_needed, days_text: dayList(s.training_days),
    end_date: workouts.at(-1)?.date ?? null, workouts, counts: { done: count('done'), missed: count('missed'), upcoming: count('upcoming') + count('today'), total: workouts.length } };
}
// The Monday-to-Sunday week a date falls in.
export function weekOf(date) {
  const start = addDaysToDate(date, -((weekdayOf(date) + 6) % 7));
  return { start, end: addDaysToDate(start, 6) };
}
// This week for one athlete: planned, done and missed workouts dated Monday to Sunday of the week `day` is in, and how
// many planned workouts dated before today were missed in a row, counting back from the latest (a done one ends the run).
export function weekStats(workouts, day) {
  const { start, end } = weekOf(day);
  const inWeek = workouts.filter((w) => w.date >= start && w.date <= end);
  let streak = 0;
  for (const w of [...workouts].reverse()) { if (w.date >= day) continue; if (w.status === 'missed') streak++; else break; }
  return { start, end, planned: inWeek.length, done: inWeek.filter((w) => w.status === 'done').length, missed: inWeek.filter((w) => w.status === 'missed').length,
    today: inWeek.filter((w) => w.status === 'today').length, upcoming: inWeek.filter((w) => w.status === 'upcoming').length, missed_streak: streak };
}
// What the app opens on: today's workout; on a rest day, the earliest one missed (pick up where you left off), else
// the next one coming up. The athlete can open any other workout from the calendar.
export function pickNext(workouts) {
  const open = workouts.filter((w) => w.status !== 'done');
  return open.find((w) => w.status === 'today') ?? open.find((w) => w.status === 'missed') ?? open[0] ?? null;
}

// ---- The coach's side ----
const clientOf = (ctx, clientId) => { const c = ctx.db.get('SELECT id, name FROM clients WHERE id = ?', clientId); if (!c) throw notFound('Client'); return c; };
const activeOf = (ctx, clientId) => ctx.db.get('SELECT * FROM assignments WHERE client_id = ? AND active = 1', clientId);
export function clientCalendar(ctx, clientId) {
  const c = clientOf(ctx, clientId);
  const a = activeOf(ctx, clientId);
  if (!a) return { client_id: c.id, program: null, workouts: [], counts: { done: 0, missed: 0, upcoming: 0, total: 0 } };
  const program = getProgram(ctx, a.program_id);
  const cal = datedWorkouts(ctx, a, program);
  return { client_id: c.id, assignment_id: a.id, program: { id: program.id, name: program.name, weeks: program.weeks }, ...cal, next: pickNext(cal.workouts, cal.today) };
}
// Checks the days against the program (a four-day program needs four training days) and answers the list to store.
export function daysFor(ctx, programId, val) {
  const days = parseDays(val, { optional: true });
  if (!days) return null;
  const need = daysNeeded(ctx, programId);
  if (days.length < need) throw badRequest(`This program has ${need} training days a week. Pick at least ${need} days.`);
  return days.join(',');
}
// Start date and training days for the athlete's current program. Moves are cleared: they were dates on the old schedule.
export function setSchedule(ctx, clientId, body = {}) {
  const c = clientOf(ctx, clientId);
  const a = activeOf(ctx, clientId);
  if (!a) throw conflict(`${c.name.split(' ')[0]} isn't on a program. Assign one first.`);
  const start = parseDate(body.start_date, 'start_date', dateOnly(a.start_date, tz(ctx)));
  const days = body.training_days === undefined ? a.training_days : daysFor(ctx, a.program_id, body.training_days);
  let cleared = 0;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE assignments SET start_date = ?, training_days = ? WHERE id = ?', start, days, a.id);
    cleared = ctx.db.run('DELETE FROM assignment_moves WHERE assignment_id = ?', a.id).changes;
  });
  return { ...clientCalendar(ctx, clientId), moves_cleared: cleared };
}
// Move one workout of this athlete's program to another date (date null puts it back on the plan's day).
export function moveWorkout(ctx, clientId, body = {}, actor = null) {
  const c = clientOf(ctx, clientId);
  const a = activeOf(ctx, clientId);
  if (!a) throw conflict(`${c.name.split(' ')[0]} isn't on a program.`);
  const w = ctx.db.get('SELECT id, title FROM workouts WHERE id = ? AND program_id = ?', String(body.workout_id ?? ''), a.program_id);
  if (!w) throw notFound('That workout in this athlete\'s program');
  if (ctx.db.get('SELECT 1 FROM workout_logs WHERE assignment_id = ? AND workout_id = ?', a.id, w.id)) throw conflict(`${w.title} is already logged. It stays on the day it was done.`);
  if (body.date === null || body.date === '') ctx.db.run('DELETE FROM assignment_moves WHERE assignment_id = ? AND workout_id = ?', a.id, w.id);
  else {
    const date = parseDate(body.date, 'date');
    if (!date) throw badRequest('date is required (or null to put the workout back on its day).');
    ctx.db.run(`INSERT INTO assignment_moves (id, assignment_id, workout_id, date, moved_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (assignment_id, workout_id) DO UPDATE SET date = excluded.date, moved_by = excluded.moved_by, created_at = excluded.created_at`, newId('mv'), a.id, w.id, date, actor?.name ?? null, ctx.now());
  }
  return clientCalendar(ctx, clientId);
}
