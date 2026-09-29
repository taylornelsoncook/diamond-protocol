import { newId, v, notFound, conflict, badRequest } from '../util.js';
import { getSetting } from './families.js';
import { kioskFor, openSessions, bookingsIn, checkInBooking, nameOnBoard } from './checkin.js';
import { getProgram, loadFor, LOAD_TESTS, readLog, saveSets, startOfToday } from './programs.js';
import { teamRosterFor } from './teams.js';
import { readinessToday } from './engage.js';
import { emit } from './events.js';

// The weight-room screen: a TV or shared tablet opened with a check-in tablet's secret link at /tv#<key>. It shows the
// workout a coach picked for each session running now at that location, big enough to read across the room. Athletes
// tap their name (first name and last initial) to see their own weights and log the workout, which also checks them in.
// Athletes don't need to be on that program: a log from the screen counts toward streaks and goals, and toward the
// athlete's program only when the workout is part of it.

// Coaches pick the workout for a session (or clear it).
export function setSessionWorkout(ctx, sessionId, body = {}) {
  if (!ctx.db.get('SELECT id FROM class_sessions WHERE id = ?', sessionId)) throw notFound('Session');
  const workoutId = body.workout_id === null || body.workout_id === '' ? null : v.str(body.workout_id, 'workout_id');
  if (workoutId && !ctx.db.get('SELECT id FROM workouts WHERE id = ?', workoutId)) throw notFound('Workout');
  ctx.db.run('UPDATE class_sessions SET workout_id = ? WHERE id = ?', workoutId, sessionId);
  return { session_id: sessionId, workout: workoutId ? workoutView(ctx, workoutId) : null };
}

export function workoutView(ctx, workoutId) {
  const w = ctx.db.get('SELECT * FROM workouts WHERE id = ?', workoutId);
  if (!w) return null;
  const p = getProgram(ctx, w.program_id);
  const full = p.workouts.find((x) => x.id === w.id);
  return { id: w.id, title: w.title, week: w.week, day: w.day, program_id: p.id, program_name: p.name,
    exercises: full.exercises.map((x) => ({ id: x.id, name: x.name, prescription: x.prescription, instructions: x.instructions, details: x.details, note: x.note,
      group_label: x.group_label, group_kind: x.group_kind, group_tag: x.group_tag,
      load: x.load_test ? `${x.load_pct}% of ${LOAD_TESTS[x.load_test]} max` : null })) };
}

// Who can log in a session: booked athletes, plus the team's roster athletes (each has a profile).
function athletesIn(ctx, s) {
  const out = bookingsIn(ctx, s.id).map((b) => ({ ref: `b_${b.id}`, client_id: b.client_id, name: b.name, booking_id: b.id, here: b.status === 'attended' }));
  const team = teamRosterFor(ctx, s);
  if (team) {
    const seen = new Set(out.map((a) => a.client_id));
    for (const r of team.athletes) {
      if (seen.has(r.client_id)) continue;
      seen.add(r.client_id);
      out.push({ ref: `r_${r.id}`, client_id: r.client_id, name: r.name, team: true, here: r.present });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
const loggedIn = (ctx, sessionId) => new Set(ctx.db.all('SELECT client_id FROM workout_logs WHERE session_id = ?', sessionId).map((r) => r.client_id));

export function screenBoard(ctx, key, asOf = ctx.now()) {
  const k = kioskFor(ctx, key);
  const sessions = openSessions(ctx, k.location_id, asOf).map((s) => ({ ...s, ...ctx.db.get('SELECT series_id, workout_id FROM class_sessions WHERE id = ?', s.id) }));
  return {
    business_name: getSetting(ctx, 'business_name'), location_name: k.location_name, screen: k.name,
    sessions: sessions.map((s) => {
      const logged = loggedIn(ctx, s.id);
      return { id: s.id, name: s.name, starts_at: s.starts_at, ends_at: s.ends_at, workout: s.workout_id ? workoutView(ctx, s.workout_id) : null,
        athletes: athletesIn(ctx, s).map((a) => ({ ref: a.ref, name: nameOnBoard(a.name), logged: logged.has(a.client_id) })) };
    })
  };
}

function pickAthlete(ctx, key, body, asOf) {
  const k = kioskFor(ctx, key);
  const sessionId = v.str(body.session_id, 'session_id');
  const s = openSessions(ctx, k.location_id, asOf).find((x) => x.id === sessionId);
  if (!s) throw conflict('That session isn\'t running here now. See a coach.');
  const full = { ...s, ...ctx.db.get('SELECT series_id, workout_id FROM class_sessions WHERE id = ?', s.id) };
  if (!full.workout_id) throw conflict('No workout is set for this session yet. Ask your coach to pick one.');
  const a = athletesIn(ctx, full).find((x) => x.ref === String(body.ref ?? ''));
  if (!a) throw badRequest('Tap your name on the list.');
  return { s: full, a, client: ctx.db.get('SELECT * FROM clients WHERE id = ?', a.client_id) };
}

// One athlete's own weights for the session's workout, after they tap their name.
export function screenAthlete(ctx, key, body = {}, asOf = ctx.now()) {
  const { s, a, client } = pickAthlete(ctx, key, body, asOf);
  const readiness = readinessToday(ctx, client.id);
  const w = getProgram(ctx, ctx.db.get('SELECT program_id FROM workouts WHERE id = ?', s.workout_id).program_id).workouts.find((x) => x.id === s.workout_id);
  return {
    name: client.name.split(' ')[0], logged: loggedIn(ctx, s.id).has(client.id),
    readiness: readiness?.level ? { level: readiness.level, headline: readiness.headline } : null,
    weights: w.exercises.filter((x) => x.load_test).map((x) => {
      const l = loadFor(ctx, client.id, x, { visibleOnly: true, drop: readiness?.drop ?? 0 });
      return { exercise_id: x.id, name: x.name, text: l.missing ? `Test your ${l.lift} max first` : `${l.lb} lb${l.planned_pct ? ' (lighter today)' : ''}` };
    })
  };
}

// Log the workout from the screen. It also checks the athlete in. Optional sets (workout_exercise_id, set_no, weight,
// reps) are saved like the app's. If the athlete already logged this workout in the app today, that log is linked to
// the session (and they're checked in) instead of logging it twice.
export function screenLog(ctx, key, body = {}, asOf = ctx.now()) {
  const { s, a, client } = pickAthlete(ctx, key, body, asOf);
  if (loggedIn(ctx, s.id).has(client.id)) throw conflict(`${client.name.split(' ')[0]}, you already logged this one.`);
  const w = ctx.db.get('SELECT w.*, p.name AS program_name FROM workouts w JOIN programs p ON p.id = w.program_id WHERE w.id = ?', s.workout_id);
  const valid = new Set(ctx.db.all('SELECT id FROM workout_exercises WHERE workout_id = ?', w.id).map((r) => r.id));
  const data = readLog(ctx, w.id, { sets: body.sets, exercise_ids: Array.isArray(body.exercise_ids) ? body.exercise_ids.map(String) : body.sets?.length ? [] : [...valid] });
  const ids = data.ids;
  const checkIn = () => {
    if (a.booking_id && !a.here) checkInBooking(ctx, a.booking_id);
    if (a.team) ctx.db.run('INSERT INTO team_attendance (session_id, client_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', s.id, a.client_id, ctx.now());
  };
  const inApp = ctx.db.get('SELECT id FROM workout_logs WHERE client_id = ? AND workout_id = ? AND session_id IS NULL AND completed_at >= ? ORDER BY completed_at DESC LIMIT 1', client.id, w.id, startOfToday(ctx));
  if (inApp) {
    ctx.db.tx(() => { ctx.db.run('UPDATE workout_logs SET session_id = ? WHERE id = ?', s.id, inApp.id); checkIn(); });
    return { name: client.name.split(' ')[0], logged: true, already: true, exercises_logged: ctx.db.get('SELECT COUNT(*) AS n FROM exercise_logs WHERE workout_log_id = ?', inApp.id).n };
  }
  // Counts toward their program when this workout is part of it and not logged there yet.
  const asg = ctx.db.get('SELECT id FROM assignments WHERE client_id = ? AND active = 1 AND program_id = ?', client.id, w.program_id);
  const assignmentId = asg && !ctx.db.get('SELECT id FROM workout_logs WHERE assignment_id = ? AND workout_id = ?', asg.id, w.id) ? asg.id : null;
  const id = newId('wlog');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO workout_logs (id, client_id, assignment_id, workout_id, notes, completed_at, session_id) VALUES (?, ?, ?, ?, NULL, ?, ?)', id, client.id, assignmentId, w.id, ctx.now(), s.id);
    saveSets(ctx, id, data);
    checkIn();
  });
  emit(ctx, 'workout.completed', { workout_log_id: id, client_id: client.id, client_name: client.name, workout_id: w.id, workout_title: w.title, program_name: w.program_name, exercises_logged: ids.length, exercises_total: valid.size, sets: data.sets.length, effort: null, bests: [], session_id: s.id });
  return { name: client.name.split(' ')[0], logged: true, exercises_logged: ids.length };
}
