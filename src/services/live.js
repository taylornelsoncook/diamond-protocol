import { newId, v, notFound, badRequest, conflict } from '../util.js';
import { athletesIn } from './screen.js';
import { getProgram, appExercise, swapsFor, nextWorkoutFor, startOfToday } from './programs.js';
import { readinessToday } from './engage.js';
import { emit } from './events.js';

// The coach's live session view (version 56): one screen for a class in progress. Every athlete booked (or on the
// team's roster), whether they're here, today's readiness, the workout they're on (their own program's next workout,
// else the one on the weight-room screen), what they've logged so far, and a swap for an athlete who can't do an
// exercise today. Nothing here is money, so every staff role may look; swapping is for owners and coaches.

function workoutOf(ctx, workoutId) {
  const w = ctx.db.get('SELECT program_id FROM workouts WHERE id = ?', workoutId);
  if (!w) return null;
  const p = getProgram(ctx, w.program_id);
  const full = p.workouts.find((x) => x.id === workoutId);
  return full ? { ...full, program_name: p.name, program_id: p.id } : null;
}

export function liveSession(ctx, sessionId) {
  const s = ctx.db.get('SELECT id, name, kind, starts_at, ends_at, status, workout_id FROM class_sessions WHERE id = ?', sessionId);
  if (!s) throw notFound('Session');
  const onScreen = s.workout_id ? workoutOf(ctx, s.workout_id) : null;
  const athletes = athletesIn(ctx, s).filter((a) => !ctx.db.get('SELECT archived_at FROM clients WHERE id = ?', a.client_id)?.archived_at).map((a) => athleteLive(ctx, s, a, onScreen));
  return { session_id: s.id, name: s.name, starts_at: s.starts_at, ends_at: s.ends_at, status: s.status,
    screen_workout: onScreen ? { id: onScreen.id, title: onScreen.title, program_name: onScreen.program_name } : null,
    counts: { athletes: athletes.length, here: athletes.filter((a) => a.here).length, logged: athletes.filter((a) => a.logged).length, started: athletes.filter((a) => !a.logged && a.sets_logged > 0).length },
    athletes };
}

function athleteLive(ctx, s, a, onScreen) {
  const own = nextWorkoutFor(ctx, a.client_id);
  // What they logged today (in this session, or earlier today in the app) stays their workout for the day; otherwise
  // it's their program's next workout, else the one on the screen.
  const log = ctx.db.get(`SELECT id, workout_id, completed_at, session_id, rpe FROM workout_logs WHERE client_id = ? AND workout_id IS NOT NULL AND (session_id = ? OR completed_at >= ?) ORDER BY completed_at DESC, rowid DESC LIMIT 1`, a.client_id, s.id, startOfToday(ctx));
  const logged = log ? workoutOf(ctx, log.workout_id) : null;
  const w = logged ? { ...logged, source: own && logged.program_id === own.program.id ? 'program' : 'screen' }
    : own?.next ? { ...own.next, program_name: own.program.name, source: 'program' } : onScreen ? { ...onScreen, source: 'screen' } : null;
  const readiness = readinessToday(ctx, a.client_id);
  const setsBySlot = new Map(log ? ctx.db.all('SELECT workout_exercise_id, COUNT(*) AS n FROM workout_sets WHERE workout_log_id = ? GROUP BY workout_exercise_id', log.id).map((r) => [r.workout_exercise_id, r.n]) : []);
  const doneSlots = new Set(log ? ctx.db.all('SELECT workout_exercise_id FROM exercise_logs WHERE workout_log_id = ?', log.id).map((r) => r.workout_exercise_id) : []);
  const swaps = w ? swapsFor(ctx, a.client_id, w.id) : null;
  const exercises = w ? w.exercises.map((x) => {
    const e = appExercise(ctx, a.client_id, x, readiness, swaps), n = setsBySlot.get(x.id) ?? 0;
    return { id: e.id, exercise_id: e.exercise_id, name: e.name, group_tag: e.group_tag, prescription: e.prescription, details: e.details,
      load: e.load ? { lb: e.load.lb ?? null, text: e.load.text, missing: !!e.load.missing } : null,
      target_sets: e.target_sets, planned_sets: e.planned_sets ?? null, target_reps: e.target_reps, progression: e.progression?.text ?? null, swapped: e.swapped ?? null,
      sets_logged: n, done: doneSlots.has(x.id) || n >= e.target_sets };
  }) : [];
  return { client_id: a.client_id, name: a.name, booking_id: a.booking_id ?? null, team: !!a.team, here: !!a.here,
    readiness: readiness?.level ? { level: readiness.level, headline: readiness.headline, sets_off: readiness.sets_off, drop: readiness.drop } : null,
    workout: w ? { id: w.id, title: w.title, week: w.week, day: w.day, program_name: w.program_name, source: w.source } : null,
    program_progress: own ? { completed: own.program.workouts.length - own.left.length, total: own.program.workouts.length, name: own.program.name } : null,
    logged: !!log, logged_at: log?.completed_at ?? null, on_screen: !!log?.session_id, effort: log?.rpe ?? null,
    exercises_done: exercises.filter((e) => e.done).length, sets_logged: [...setsBySlot.values()].reduce((t, n) => t + n, 0), exercises };
}

// Swap one athlete's exercise: this slot only, or every slot in the program with that exercise in a workout they
// haven't logged yet (scope program). Swapping the same slot again replaces the earlier swap.
export function swapExercise(ctx, clientId, body = {}, user) {
  const c = ctx.db.get('SELECT id, name, archived_at FROM clients WHERE id = ?', v.str(clientId, 'client_id'));
  if (!c) throw notFound('Athlete');
  if (c.archived_at) throw conflict('This athlete is archived.');
  const slot = ctx.db.get(`SELECT we.id, we.exercise_id, we.workout_id, w.program_id, e.name FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id JOIN exercises e ON e.id = we.exercise_id WHERE we.id = ?`, v.str(body.workout_exercise_id, 'workout_exercise_id'));
  if (!slot) throw notFound('Exercise in the workout');
  const to = ctx.db.get('SELECT id, name FROM exercises WHERE id = ?', v.str(body.exercise_id, 'exercise_id'));
  if (!to) throw notFound('Exercise');
  if (to.id === slot.exercise_id) throw badRequest(`${to.name} is already the exercise there. Pick a different one.`);
  const reason = v.str(body.reason, 'reason', { max: 200, optional: true }) || null;
  const scope = v.oneOf(body.scope ?? 'workout', 'scope', ['workout', 'program']);
  const sessionId = body.session_id ? ctx.db.get('SELECT id FROM class_sessions WHERE id = ?', String(body.session_id))?.id ?? null : null;
  const slots = scope === 'workout' ? [slot.id] : ctx.db.all(`SELECT we.id FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id
    WHERE w.program_id = ? AND we.exercise_id = ? AND (we.id = ? OR NOT EXISTS (SELECT 1 FROM workout_logs l WHERE l.client_id = ? AND l.workout_id = w.id)) ORDER BY w.week, w.day, we.position`, slot.program_id, slot.exercise_id, slot.id, c.id).map((r) => r.id);
  const now = ctx.now(), by = user?.name ?? null;
  ctx.db.tx(() => {
    for (const id of slots) ctx.db.run(`INSERT INTO exercise_swaps (id, client_id, workout_exercise_id, exercise_id, reason, session_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (client_id, workout_exercise_id) DO UPDATE SET exercise_id = excluded.exercise_id, reason = excluded.reason, session_id = excluded.session_id, created_by = excluded.created_by, created_at = excluded.created_at`,
      newId('swap'), c.id, id, to.id, reason, sessionId, by, now);
  });
  const row = ctx.db.get('SELECT id FROM exercise_swaps WHERE client_id = ? AND workout_exercise_id = ?', c.id, slot.id);
  emit(ctx, 'exercise.swapped', { swap_id: row.id, client_id: c.id, client_name: c.name, exercise_id: to.id, exercise_name: to.name, instead_of: slot.name, reason, workouts: slots.length, scope, by, ...(sessionId ? { session_id: sessionId } : {}) });
  return { id: row.id, client_id: c.id, workout_exercise_id: slot.id, exercise_id: to.id, exercise_name: to.name, instead_of: slot.name, reason, scope, workouts: slots.length, by, created_at: now };
}
// Put the plan's exercise back (this slot only; a program-wide swap is undone slot by slot or from the athlete's list).
export function removeSwap(ctx, id, { all = false } = {}) {
  const sw = ctx.db.get('SELECT id, client_id, exercise_id, workout_exercise_id FROM exercise_swaps WHERE id = ?', id);
  if (!sw) throw notFound('Swap');
  let n = 1;
  if (all) {
    const planned = ctx.db.get('SELECT we.exercise_id, w.program_id FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id WHERE we.id = ?', sw.workout_exercise_id);
    n = ctx.db.run(`DELETE FROM exercise_swaps WHERE client_id = ? AND exercise_id = ? AND workout_exercise_id IN (SELECT we.id FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id WHERE w.program_id = ? AND we.exercise_id = ?)`, sw.client_id, sw.exercise_id, planned.program_id, planned.exercise_id).changes;
  } else ctx.db.run('DELETE FROM exercise_swaps WHERE id = ?', id);
  return { id, deleted: true, removed: n };
}
// One athlete's swaps, newest first, for the client page.
export function listSwaps(ctx, clientId) {
  return ctx.db.all(`SELECT s.id, s.reason, s.created_by, s.created_at, s.workout_exercise_id, e.name AS exercise_name, e0.name AS instead_of, w.id AS workout_id, w.title AS workout_title, w.week, w.day, p.name AS program_name
    FROM exercise_swaps s JOIN exercises e ON e.id = s.exercise_id JOIN workout_exercises we ON we.id = s.workout_exercise_id JOIN exercises e0 ON e0.id = we.exercise_id
    JOIN workouts w ON w.id = we.workout_id JOIN programs p ON p.id = w.program_id WHERE s.client_id = ? ORDER BY s.created_at DESC, w.week, w.day`, clientId);
}
export const forExport = (ctx, clientId) => listSwaps(ctx, clientId).map(({ id, workout_exercise_id, workout_id, ...r }) => r);
