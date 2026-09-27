import { newId, v, notFound, badRequest, conflict } from '../util.js';
import { emit } from './events.js';
import { parentFilter } from './performance.js';

// ---- Exercise library ----
export function listExercises(ctx) {
  return ctx.db.all('SELECT * FROM exercises ORDER BY name COLLATE NOCASE');
}
export function getExercise(ctx, id) {
  const e = ctx.db.get('SELECT * FROM exercises WHERE id = ?', id);
  if (!e) throw notFound('Exercise');
  return e;
}
export function createExercise(ctx, body) {
  const e = {
    id: newId('ex'),
    name: v.str(body.name, 'name', { max: 120 }),
    video_url: v.url(body.video_url, 'video_url', { optional: true }),
    instructions: v.str(body.instructions, 'instructions', { max: 4000, optional: true })
  };
  ctx.db.run('INSERT INTO exercises (id, name, video_url, instructions, created_at) VALUES (?, ?, ?, ?, ?)', e.id, e.name, e.video_url, e.instructions, ctx.now());
  return getExercise(ctx, e.id);
}
export function updateExercise(ctx, id, body) {
  const e = getExercise(ctx, id);
  ctx.db.run('UPDATE exercises SET name = ?, video_url = ?, instructions = ? WHERE id = ?',
    body.name !== undefined ? v.str(body.name, 'name', { max: 120 }) : e.name,
    body.video_url !== undefined ? v.url(body.video_url, 'video_url', { optional: true }) : e.video_url,
    body.instructions !== undefined ? v.str(body.instructions, 'instructions', { max: 4000, optional: true }) : e.instructions,
    id);
  return getExercise(ctx, id);
}

// ---- Programs ----
export function listPrograms(ctx) {
  return ctx.db.all(
    `SELECT p.*,
      (SELECT COUNT(*) FROM workouts w WHERE w.program_id = p.id) AS workout_count,
      (SELECT COUNT(*) FROM assignments a WHERE a.program_id = p.id AND a.active = 1) AS client_count
     FROM programs p ORDER BY p.created_at`);
}
export function getProgram(ctx, id) {
  const p = ctx.db.get('SELECT * FROM programs WHERE id = ?', id);
  if (!p) throw notFound('Program');
  const items = ctx.db.all(
    `SELECT we.id, we.workout_id, we.position, we.prescription, we.load_test, we.load_pct, e.id AS exercise_id, e.name, e.video_url, e.instructions
     FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
     JOIN workouts w ON w.id = we.workout_id WHERE w.program_id = ? ORDER BY we.position`, id);
  p.workouts = ctx.db.all('SELECT * FROM workouts WHERE program_id = ? ORDER BY week, day', id).map((w) => ({
    ...w, exercises: items.filter((i) => i.workout_id === w.id).map(({ workout_id, ...rest }) => rest)
  }));
  p.clients = ctx.db.all(
    `SELECT c.id, c.name FROM assignments a JOIN clients c ON c.id = a.client_id WHERE a.program_id = ? AND a.active = 1 ORDER BY c.name`, id);
  return p;
}
export function createProgram(ctx, body) {
  const id = newId('prog');
  ctx.db.run('INSERT INTO programs (id, name, description, level, weeks, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, v.str(body.name, 'name', { max: 120 }),
    v.str(body.description, 'description', { max: 2000, optional: true }),
    v.str(body.level, 'level', { max: 40, optional: true }),
    v.int(body.weeks ?? 4, 'weeks', { min: 1, max: 52 }), ctx.now());
  return getProgram(ctx, id);
}
export function updateProgram(ctx, id, body) {
  const p = getProgram(ctx, id);
  ctx.db.run('UPDATE programs SET name = ?, description = ?, level = ?, weeks = ? WHERE id = ?',
    body.name !== undefined ? v.str(body.name, 'name', { max: 120 }) : p.name,
    body.description !== undefined ? v.str(body.description, 'description', { max: 2000, optional: true }) : p.description,
    body.level !== undefined ? v.str(body.level, 'level', { max: 40, optional: true }) : p.level,
    body.weeks !== undefined ? v.int(body.weeks, 'weeks', { min: 1, max: 52 }) : p.weeks, id);
  return getProgram(ctx, id);
}
export function deleteProgram(ctx, id) {
  const p = getProgram(ctx, id);
  if (p.clients.length) throw conflict(`${p.clients.length} client(s) are on this program. Assign them another program first.`);
  ctx.db.run('DELETE FROM programs WHERE id = ?', id);
  return { id, deleted: true };
}

export function addWorkout(ctx, programId, body) {
  const p = getProgram(ctx, programId);
  const week = v.int(body.week, 'week', { min: 1, max: p.weeks });
  const day = v.int(body.day, 'day', { min: 1, max: 7 });
  if (ctx.db.get('SELECT id FROM workouts WHERE program_id = ? AND week = ? AND day = ?', programId, week, day)) throw conflict(`Week ${week}, day ${day} already has a workout.`);
  const id = newId('wo');
  ctx.db.run('INSERT INTO workouts (id, program_id, week, day, title) VALUES (?, ?, ?, ?, ?)', id, programId, week, day, v.str(body.title, 'title', { max: 120 }));
  return getProgram(ctx, programId).workouts.find((w) => w.id === id);
}
export function deleteWorkout(ctx, workoutId) {
  const w = ctx.db.get('SELECT * FROM workouts WHERE id = ?', workoutId);
  if (!w) throw notFound('Workout');
  ctx.db.run('DELETE FROM workouts WHERE id = ?', workoutId);
  return { id: workoutId, deleted: true };
}
export function addWorkoutExercise(ctx, workoutId, body) {
  const w = ctx.db.get('SELECT * FROM workouts WHERE id = ?', workoutId);
  if (!w) throw notFound('Workout');
  getExercise(ctx, v.str(body.exercise_id, 'exercise_id'));
  const pos = ctx.db.get('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM workout_exercises WHERE workout_id = ?', workoutId).n;
  const id = newId('wex');
  const load = loadInput(body);
  ctx.db.run('INSERT INTO workout_exercises (id, workout_id, exercise_id, position, prescription, load_test, load_pct) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, workoutId, body.exercise_id, pos, v.str(body.prescription, 'prescription', { max: 80 }), load.test, load.pct);
  return getProgram(ctx, w.program_id).workouts.find((x) => x.id === workoutId);
}
// Weights from test results: an exercise can be prescribed as a percent of the athlete's latest tested max
// (back squat, bench press or power clean 1RM). The weight updates on its own when a new max is recorded, rounded
// to the nearest 5 lb. Athletes only see weights from results their family can see (the share rule).
export const LOAD_TESTS = { squat_1rm: 'back squat', bench_1rm: 'bench press', power_clean_1rm: 'power clean' };
function loadInput(body) {
  if (!body.load_test) return { test: null, pct: null };
  const test = v.oneOf(body.load_test, 'load_test', Object.keys(LOAD_TESTS));
  const pct = Number(body.load_pct);
  if (!Number.isInteger(pct) || pct < 30 || pct > 110) throw badRequest('Enter the percent of their max as a whole number from 30 to 110, like 75.');
  return { test, pct };
}
export function updateWorkoutExercise(ctx, id, body) {
  const x = ctx.db.get('SELECT * FROM workout_exercises WHERE id = ?', id);
  if (!x) throw notFound('Workout exercise');
  const load = body.load_test === undefined ? { test: x.load_test, pct: x.load_pct } : loadInput(body);
  ctx.db.run('UPDATE workout_exercises SET prescription = ?, load_test = ?, load_pct = ? WHERE id = ?',
    body.prescription !== undefined ? v.str(body.prescription, 'prescription', { max: 80 }) : x.prescription, load.test, load.pct, id);
  return ctx.db.get('SELECT id, prescription, load_test, load_pct FROM workout_exercises WHERE id = ?', id);
}
export function latestMax(ctx, clientId, testKey, { visibleOnly = false } = {}) {
  return ctx.db.get(`SELECT r.value, r.recorded_at FROM perf_results r JOIN perf_tests t ON t.id = r.test_id
    WHERE r.client_id = ? AND t.key = ? AND r.metric = 'load' AND r.voided = 0 ${visibleOnly ? parentFilter(ctx) : ''} ORDER BY r.recorded_at DESC, r.rowid DESC LIMIT 1`, clientId, testKey) ?? null;
}
export function loadFor(ctx, clientId, x, opts) {
  if (!x.load_test) return null;
  const max = latestMax(ctx, clientId, x.load_test, opts);
  const lift = LOAD_TESTS[x.load_test];
  if (!max) return { pct: x.load_pct, lift, missing: true, text: `${x.load_pct}% of your ${lift} max. Test your max to get a weight.` };
  const lb = Math.max(5, Math.round((max.value * x.load_pct) / 100 / 5) * 5);
  return { pct: x.load_pct, lift, lb, max_lb: max.value, tested_at: max.recorded_at, text: `${lb} lb (${x.load_pct}% of your ${max.value} lb ${lift} max)` };
}

export function removeWorkoutExercise(ctx, id) {
  if (!ctx.db.get('SELECT id FROM workout_exercises WHERE id = ?', id)) throw notFound('Workout exercise');
  ctx.db.run('DELETE FROM workout_exercises WHERE id = ?', id);
  return { id, deleted: true };
}

// ---- Assignments ----
export function assign(ctx, programId, clientId, startDate) {
  const p = ctx.db.get('SELECT id, name FROM programs WHERE id = ?', programId);
  if (!p) throw notFound('Program');
  const c = ctx.db.get('SELECT id, name FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Client');
  const id = newId('asg');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE assignments SET active = 0 WHERE client_id = ? AND active = 1', clientId);
    ctx.db.run('INSERT INTO assignments (id, client_id, program_id, start_date, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      id, clientId, programId, v.date(startDate, 'start_date', { optional: true }) ?? ctx.now(), ctx.now());
    emit(ctx, 'program.assigned', { assignment_id: id, client_id: clientId, client_name: c.name, program_id: programId, program_name: p.name });
  });
  return { id, client_id: clientId, program_id: programId };
}

export function listCompletions(ctx, { clientId, since, limit = 50 } = {}) {
  const where = [], params = [];
  if (clientId) { where.push('l.client_id = ?'); params.push(clientId); }
  if (since) { where.push('l.completed_at >= ?'); params.push(since); }
  return ctx.db.all(
    `SELECT l.id, l.client_id, c.name AS client_name, l.workout_id, w.title AS workout_title, w.week, w.day,
       pr.name AS program_name, l.notes, l.completed_at,
       (SELECT COUNT(*) FROM exercise_logs x WHERE x.workout_log_id = l.id) AS exercises_logged
     FROM workout_logs l JOIN clients c ON c.id = l.client_id JOIN workouts w ON w.id = l.workout_id JOIN programs pr ON pr.id = w.program_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.completed_at DESC LIMIT ?`, ...params, limit);
}

// ---- Client app ----
const ACCESS = { active: true, trialing: true, past_due: true };   // past_due keeps access while payment is retried

export function clientHome(ctx, client) {
  const sub = ctx.db.get(`SELECT status FROM subscriptions WHERE client_id = ? ORDER BY (status = 'canceled'), created_at DESC LIMIT 1`, client.id);
  const status = sub?.status ?? 'none';
  const base = { client: { name: client.name, first_name: client.name.split(' ')[0] }, membership: status };
  if (!ACCESS[status]) return { ...base, locked: true, message: status === 'paused' ? 'Your membership is paused. Message your coach to pick back up.' : 'You don\'t have an active membership. Message your coach to get started.' };
  const a = ctx.db.get('SELECT * FROM assignments WHERE client_id = ? AND active = 1', client.id);
  if (!a) return { ...base, locked: false, program: null, message: 'Your coach is building your program. Check back soon.' };
  const program = getProgram(ctx, a.program_id);
  const done = new Set(ctx.db.all('SELECT workout_id FROM workout_logs WHERE assignment_id = ?', a.id).map((r) => r.workout_id));
  const next = program.workouts.find((w) => !done.has(w.id)) ?? null;
  return {
    ...base, locked: false,
    program: { id: program.id, name: program.name, weeks: program.weeks },
    progress: { completed: done.size, total: program.workouts.length },
    workout: next && { ...next, exercises: next.exercises.map((x) => ({ ...x, load: loadFor(ctx, client.id, x, { visibleOnly: true }) })) },
    message: next ? null : 'Program complete. Your coach will set your next block.'
  };
}

export function completeWorkout(ctx, client, workoutId, body = {}) {
  const home = clientHome(ctx, client);
  if (home.locked) throw conflict(home.message);
  const a = ctx.db.get('SELECT * FROM assignments WHERE client_id = ? AND active = 1', client.id);
  const w = a && ctx.db.get('SELECT * FROM workouts WHERE id = ? AND program_id = ?', workoutId, a.program_id);
  if (!w) throw notFound('Workout');
  if (ctx.db.get('SELECT id FROM workout_logs WHERE assignment_id = ? AND workout_id = ?', a.id, workoutId)) throw conflict('This workout is already logged.');
  const valid = new Set(ctx.db.all('SELECT id FROM workout_exercises WHERE workout_id = ?', workoutId).map((r) => r.id));
  const ids = Array.isArray(body.exercise_ids) ? body.exercise_ids.filter((x) => valid.has(x)) : [];
  if (Array.isArray(body.exercise_ids) && ids.length !== new Set(body.exercise_ids).size) throw badRequest('exercise_ids contains exercises that are not in this workout.');
  const id = newId('log');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO workout_logs (id, client_id, assignment_id, workout_id, notes, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, client.id, a.id, workoutId, v.str(body.notes, 'notes', { max: 2000, optional: true }), ctx.now());
    for (const x of new Set(ids)) ctx.db.run('INSERT INTO exercise_logs (workout_log_id, workout_exercise_id) VALUES (?, ?)', id, x);
    const prog = ctx.db.get('SELECT name FROM programs WHERE id = ?', a.program_id);
    emit(ctx, 'workout.completed', { workout_log_id: id, client_id: client.id, client_name: client.name, workout_id: workoutId, workout_title: w.title, program_name: prog.name, exercises_logged: new Set(ids).size, exercises_total: valid.size });
  });
  return { id, next: clientHome(ctx, client) };
}
