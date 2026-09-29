import { newId, v, notFound, badRequest, conflict, HttpError, startOfLocalDay } from '../util.js';
import { clientLock, athleteLockMessage } from './lockout.js';
import { emit } from './events.js';
import { parentFilter } from './performance.js';
import { readinessToday } from './engage.js';
import { suggestAfterLog, appliedFor } from './progression.js';
import { blocksFor, attachFields as routineFields } from './routines.js';
import { getSetting } from './families.js';
import { MAX_SETS, GROUP_KINDS, SET_FIELDS, REST_MAX, splitRx, rxText, parseRx, tagGroups } from './rx.js';
import { trimPhases, copyPhases } from './planner.js';
export { parseRx, rxText, splitRx, GROUP_KINDS, SET_FIELDS } from './rx.js';

// ---- Exercise library ----
// Categories for finding exercises in the library. An exercise can have none.
// The reasons a coach lists a swap under (services/substitutions.js); the app shows the label.
export const ALT_TAGS = { no_barbell: 'No barbell', no_equipment: 'No equipment', at_home: 'At home', knee: 'Knee', shoulder: 'Shoulder', back: 'Back', easier: 'Easier', harder: 'Harder', other: 'Other' };
export const CATEGORIES = ['Speed', 'Power', 'Lower body', 'Upper body', 'Core', 'Arm care', 'Mobility', 'Conditioning'];
const category = (val) => {
  if (val === undefined || val === null || val === '') return null;
  if (!CATEGORIES.includes(val)) throw badRequest(`Choose a category: ${CATEGORIES.join(', ')}. Or leave it empty.`);
  return val;
};
const uniqueName = (ctx, name, exceptId = '') => {
  if (ctx.db.get('SELECT id FROM exercises WHERE name = ? COLLATE NOCASE AND id != ?', name, exceptId)) throw conflict(`${name} is already in the library.`);
  return name;
};

// Every exercise with how many workouts use it and the programs it's in. Filters: q (name or cues), category,
// filter=no_video (missing a demo video) or unused (in no workout).
export function listExercises(ctx, { q, category: cat, filter } = {}) {
  const inPrograms = new Map();
  for (const r of ctx.db.all(`SELECT DISTINCT we.exercise_id, p.id, p.name FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id
    JOIN programs p ON p.id = w.program_id ORDER BY p.name COLLATE NOCASE`)) {
    if (!inPrograms.has(r.exercise_id)) inPrograms.set(r.exercise_id, []);
    inPrograms.get(r.exercise_id).push({ id: r.id, name: r.name });
  }
  const needle = String(q ?? '').trim().toLowerCase();
  const uses = new Map(ctx.db.all('SELECT exercise_id, COUNT(*) AS n FROM workout_exercises GROUP BY exercise_id').map((r) => [r.exercise_id, r.n]));
  return ctx.db.all('SELECT e.* FROM exercises e ORDER BY e.name COLLATE NOCASE').map((e) => ({ ...e, uses: uses.get(e.id) ?? 0 }))
    .map((e) => ({ ...e, programs: inPrograms.get(e.id) ?? [] }))
    .filter((e) => (!needle || e.name.toLowerCase().includes(needle) || (e.instructions ?? '').toLowerCase().includes(needle))
      && (!cat || e.category === cat) && (filter !== 'no_video' || !e.video_url) && (filter !== 'unused' || !e.uses));
}
export function getExercise(ctx, id) {
  const e = ctx.db.get('SELECT * FROM exercises WHERE id = ?', id);
  if (!e) throw notFound('Exercise');
  return e;
}
export function createExercise(ctx, body) {
  const e = {
    id: newId('ex'),
    name: uniqueName(ctx, v.str(body.name, 'name', { max: 120 }).normalize('NFC')),
    video_url: v.url(body.video_url, 'video_url', { optional: true }),
    poster_url: v.url(body.poster_url, 'poster_url', { optional: true }),
    instructions: v.str(body.instructions, 'instructions', { max: 4000, optional: true }),
    category: category(body.category)
  };
  ctx.db.run('INSERT INTO exercises (id, name, video_url, poster_url, instructions, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', e.id, e.name, e.video_url, e.poster_url, e.instructions, e.category, ctx.now());
  return getExercise(ctx, e.id);
}
export function updateExercise(ctx, id, body) {
  const e = getExercise(ctx, id);
  // A new video link drops the old still unless a new one comes with it (the still showed the old video).
  const newVideo = body.video_url !== undefined ? v.url(body.video_url, 'video_url', { optional: true }) : e.video_url;
  const poster = body.poster_url !== undefined ? v.url(body.poster_url, 'poster_url', { optional: true }) : newVideo === e.video_url ? e.poster_url : null;
  ctx.db.run('UPDATE exercises SET name = ?, video_url = ?, poster_url = ?, instructions = ?, category = ? WHERE id = ?',
    body.name !== undefined ? uniqueName(ctx, v.str(body.name, 'name', { max: 120 }).normalize('NFC'), id) : e.name,
    newVideo, poster,
    body.instructions !== undefined ? v.str(body.instructions, 'instructions', { max: 4000, optional: true }) : e.instructions,
    body.category !== undefined ? category(body.category) : e.category,
    id);
  return getExercise(ctx, id);
}
// Only an exercise no workout uses. Sets athletes logged keep its name.
export function deleteExercise(ctx, id) {
  const e = getExercise(ctx, id);
  const used = ctx.db.all(`SELECT DISTINCT p.name FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id JOIN programs p ON p.id = w.program_id WHERE we.exercise_id = ? ORDER BY p.name`, id).map((r) => r.name);
  if (used.length) throw conflict(`${e.name} is in ${used.join(', ')}. Remove it from ${used.length === 1 ? 'that program' : 'those programs'} first.`);
  const swapped = ctx.db.get('SELECT COUNT(DISTINCT client_id) AS n FROM exercise_swaps WHERE exercise_id = ?', id).n;
  if (swapped) throw conflict(`${e.name} is swapped in for ${swapped === 1 ? 'an athlete' : `${swapped} athletes`} right now. Undo those swaps first.`);
  ctx.db.run('DELETE FROM exercises WHERE id = ?', id);
  return { id, deleted: true };
}

// ---- Programs ----
const WEEK_AGO = (ctx) => new Date(Date.parse(ctx.now()) - 7 * 86400000).toISOString();
export function listPrograms(ctx) {
  return ctx.db.all(
    `SELECT p.*,
      (SELECT COUNT(*) FROM workouts w WHERE w.program_id = p.id) AS workout_count,
      (SELECT COUNT(*) FROM assignments a JOIN clients c ON c.id = a.client_id WHERE a.program_id = p.id AND a.active = 1 AND c.archived_at IS NULL) AS client_count,
      (SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM workouts w WHERE w.program_id = p.id GROUP BY w.week)) AS days_per_week,
      (SELECT COUNT(*) FROM workout_logs l JOIN workouts w ON w.id = l.workout_id JOIN clients c ON c.id = l.client_id
        WHERE w.program_id = p.id AND c.archived_at IS NULL AND l.completed_at >= ?) AS logged_7d
     FROM programs p ORDER BY p.created_at`, WEEK_AGO(ctx));
}
export function getProgram(ctx, id) {
  const p = ctx.db.get('SELECT * FROM programs WHERE id = ?', id);
  if (!p) throw notFound('Program');
  const items = ctx.db.all(
    `SELECT we.id, we.workout_id, we.position, we.prescription, we.load_test, we.load_pct, ${SLOT_COLS.map((c) => `we.${c}`).join(', ')},
       e.id AS exercise_id, e.name, e.video_url, e.poster_url, e.instructions, e.category
     FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
     JOIN workouts w ON w.id = we.workout_id WHERE w.program_id = ? ORDER BY we.position`, id);
  const rows = ctx.db.all('SELECT * FROM workouts WHERE program_id = ? ORDER BY week, day', id);
  const blocks = blocksFor(ctx, rows);   // every warm-up and cool-down the program uses, read once
  p.workouts = rows.map((w) => ({
    ...w, warmup: blocks.get(w.warmup_id) ?? null, cooldown: blocks.get(w.cooldown_id) ?? null, exercises: tagGroups(items.filter((i) => i.workout_id === w.id).map(({ workout_id, ...rest }) => rest))
  }));
  p.clients = ctx.db.all(
    `SELECT c.id, c.name FROM assignments a JOIN clients c ON c.id = a.client_id WHERE a.program_id = ? AND a.active = 1 AND c.archived_at IS NULL ORDER BY c.name`, id);
  return p;
}
// The builder's view: the program, how many times each workout was logged, each client's progress, and the last week
// that has workouts (the program can't be made shorter than that).
export function programDetail(ctx, id) {
  const p = getProgram(ctx, id);
  const logs = new Map(ctx.db.all('SELECT l.workout_id, COUNT(*) AS n FROM workout_logs l JOIN workouts w ON w.id = l.workout_id WHERE w.program_id = ? GROUP BY l.workout_id', id).map((r) => [r.workout_id, r.n]));
  for (const w of p.workouts) w.logs = logs.get(w.id) ?? 0;
  p.last_week = p.workouts.reduce((m, w) => Math.max(m, w.week), 0);
  p.clients = clientProgress(ctx, { programId: id });
  p.logged_7d = ctx.db.get(`SELECT COUNT(*) AS n FROM workout_logs l JOIN workouts w ON w.id = l.workout_id JOIN clients c ON c.id = l.client_id
    WHERE w.program_id = ? AND c.archived_at IS NULL AND l.completed_at >= ?`, id, WEEK_AGO(ctx)).n;
  return p;
}
const lastWeekOf = (ctx, programId) => ctx.db.get('SELECT COALESCE(MAX(week), 0) AS w FROM workouts WHERE program_id = ?', programId).w;
const setWeeks = (ctx, programId, weeks) => { ctx.db.run('UPDATE programs SET weeks = ? WHERE id = ?', weeks, programId); trimPhases(ctx, programId, weeks); };

// adjust (the planner's progression) changes each exercise's fields on the way.
function copyWorkoutInto(ctx, src, programId, week, day, title, adjust = null) {
  const id = newId('wo');
  ctx.db.run('INSERT INTO workouts (id, program_id, week, day, title, warmup_id, cooldown_id) VALUES (?, ?, ?, ?, ?, ?, ?)', id, programId, week, day, title ?? src.title, src.warmup_id ?? null, src.cooldown_id ?? null);
  for (const x of ctx.db.all('SELECT * FROM workout_exercises WHERE workout_id = ? ORDER BY position', src.id)) insertSlot(ctx, id, x.exercise_id, x.position, adjust ? adjust(x) : x);
  return id;
}
// The set-detail columns of workout_exercises, and one row written with them (the builder, a copy, a program read from a PDF).
const SLOT_COLS = SET_FIELDS;
export function insertSlot(ctx, workoutId, exerciseId, position, f, id = newId('wex')) {
  ctx.db.run(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position, prescription, load_test, load_pct, ${SLOT_COLS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ${SLOT_COLS.map(() => '?').join(', ')})`,
    id, workoutId, exerciseId, position, f.prescription, f.load_test ?? null, f.load_pct ?? null, ...SLOT_COLS.map((c) => f[c] ?? null));
  return id;
}
// A new program, empty or as a copy of another (copy_from: its workouts in the weeks kept).
export function createProgram(ctx, body) {
  const src = body.copy_from ? getProgram(ctx, v.str(body.copy_from, 'copy_from')) : null;
  const id = newId('prog');
  const weeks = v.int(body.weeks ?? src?.weeks ?? 4, 'weeks', { min: 1, max: 52 });
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO programs (id, name, description, level, weeks, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, v.str(body.name, 'name', { max: 120 }),
      body.description !== undefined ? v.str(body.description, 'description', { max: 2000, optional: true }) : src?.description ?? null,
      body.level !== undefined ? v.str(body.level, 'level', { max: 40, optional: true }) : src?.level ?? null,
      weeks, ctx.now());
    if (src) { for (const w of src.workouts.filter((x) => x.week <= weeks)) copyWorkoutInto(ctx, w, id, w.week, w.day); copyPhases(ctx, src.id, id, weeks); }
  });
  return getProgram(ctx, id);
}
// Duplicate: every week and workout, under a new name. Not for sale until the owner says so.
export function duplicateProgram(ctx, id, body = {}) {
  const src = getProgram(ctx, id);
  const name = body.name ? v.str(body.name, 'name', { max: 120 }) : `${src.name} (copy)`.slice(0, 120);
  return createProgram(ctx, { name, copy_from: id, weeks: Math.max(src.weeks, lastWeekOf(ctx, id)) });
}
export function updateProgram(ctx, id, body) {
  const p = getProgram(ctx, id);
  const weeks = body.weeks !== undefined ? v.int(body.weeks, 'weeks', { min: 1, max: 52 }) : p.weeks;
  const last = lastWeekOf(ctx, id);
  if (weeks < last) throw conflict(`Week ${last} still has workouts. Delete week ${last} first, or keep ${last} weeks.`);
  const name = body.name !== undefined ? v.str(body.name, 'name', { max: 120 }) : p.name;
  const description = body.description !== undefined ? v.str(body.description, 'description', { max: 2000, optional: true }) : p.description;
  const level = body.level !== undefined ? v.str(body.level, 'level', { max: 40, optional: true }) : p.level;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE programs SET name = ?, description = ?, level = ?, weeks = ? WHERE id = ?', name, description, level, weeks, id);
    if (weeks < p.weeks) trimPhases(ctx, id, weeks);       // a shorter program cuts its phases back too
  });
  return getProgram(ctx, id);
}
// Owner decision: deleting a program or workout keeps every athlete's logged workouts (and their sets) in their history.
// Before the workout goes, each of its logs is given what it was (program, workout, week and day, and the exercises with
// whether each was done), so the log reads the same without it; the log's workout and assignment become empty, so it
// drops out of the program's numbers but stays in the athlete's history, the app, the client page and exports.
function keepLogsOf(ctx, workoutIds) {
  for (const wid of workoutIds) {
    const w = ctx.db.get('SELECT w.*, p.name AS program_name FROM workouts w JOIN programs p ON p.id = w.program_id WHERE w.id = ?', wid);
    if (!w) continue;
    const items = tagGroups(ctx.db.all(`SELECT we.id, we.exercise_id, e.name, we.prescription, ${SLOT_COLS.map((c) => `we.${c}`).join(', ')} FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.workout_id = ? ORDER BY we.position`, wid));
    for (const l of ctx.db.all('SELECT id, client_id FROM workout_logs WHERE workout_id = ?', wid)) {
      const done = new Set(ctx.db.all('SELECT workout_exercise_id FROM exercise_logs WHERE workout_log_id = ?', l.id).map((r) => r.workout_exercise_id));
      const swaps = swapsFor(ctx, l.client_id, wid);   // the snapshot keeps the exercise this athlete actually did
      ctx.db.run('UPDATE workout_logs SET program_id = ?, program_name = ?, workout_title = ?, workout_week = ?, workout_day = ?, exercises_snapshot = ? WHERE id = ?',
        w.program_id, w.program_name, w.title, w.week, w.day, JSON.stringify(items.map((i) => { const { swapped, ...x } = slotFor(i, swaps.get(i.id)); return { ...x, ...(swapped ? { swapped_from: swapped.from } : {}), done: done.has(i.id) }; })), l.id);
    }
  }
}
const deleteWorkouts = (ctx, ids) => { keepLogsOf(ctx, ids); for (const id of ids) ctx.db.run('DELETE FROM workouts WHERE id = ?', id); };

// Refused while current clients are on it. Archived clients still on it (not shown on the program) are taken off.
// Athletes' logged workouts stay in their history (keepLogsOf).
export function deleteProgram(ctx, id) {
  getProgram(ctx, id);
  const on = ctx.db.get('SELECT COUNT(*) AS n FROM assignments a JOIN clients c ON c.id = a.client_id WHERE a.program_id = ? AND a.active = 1 AND c.archived_at IS NULL', id).n;
  if (on) throw conflict(`${on} ${on === 1 ? 'client is' : 'clients are'} on this program. Move them to another program or remove them first.`);
  const kept = ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs l JOIN workouts w ON w.id = l.workout_id WHERE w.program_id = ?', id).n;
  ctx.db.tx(() => {
    keepLogsOf(ctx, ctx.db.all('SELECT id FROM workouts WHERE program_id = ?', id).map((w) => w.id));
    ctx.db.run('DELETE FROM programs WHERE id = ?', id);
  });
  return { id, deleted: true, logs_kept: kept };
}

const workoutRow = (ctx, id) => {
  const w = ctx.db.get('SELECT w.*, p.weeks AS program_weeks, p.name AS program_name FROM workouts w JOIN programs p ON p.id = w.program_id WHERE w.id = ?', id);
  if (!w) throw notFound('Workout');
  return w;
};
// The day asked for, or the next free day of the week. A week has at most 7 days.
function freeDay(ctx, programId, week, day) {
  if (day === undefined || day === null || day === '') {
    const next = ctx.db.get('SELECT COALESCE(MAX(day), 0) + 1 AS n FROM workouts WHERE program_id = ? AND week = ?', programId, week).n;
    if (next > 7) throw conflict(`Week ${week} already has 7 days.`);
    return next;
  }
  const d = v.int(day, 'day', { min: 1, max: 7 });
  if (ctx.db.get('SELECT id FROM workouts WHERE program_id = ? AND week = ? AND day = ?', programId, week, d)) throw conflict(`Week ${week}, day ${d} already has a workout. Pick another day.`);
  return d;
}
export function addWorkout(ctx, programId, body) {
  const p = getProgram(ctx, programId);
  const week = v.int(body.week, 'week', { min: 1, max: p.weeks });
  const day = freeDay(ctx, programId, week, body.day);
  const id = newId('wo');
  const blocks = routineFields(ctx, {}, body);
  ctx.db.run('INSERT INTO workouts (id, program_id, week, day, title, warmup_id, cooldown_id) VALUES (?, ?, ?, ?, ?, ?, ?)', id, programId, week, day, v.str(body.title, 'title', { max: 120, optional: true }) ?? `Day ${day}`, blocks.warmup_id ?? null, blocks.cooldown_id ?? null);
  return getProgram(ctx, programId).workouts.find((w) => w.id === id);
}
// Rename a workout, or attach or clear its warm-up and cool-down blocks (warmup_id / cooldown_id, null clears).
export function updateWorkout(ctx, workoutId, body = {}) {
  const w = workoutRow(ctx, workoutId);
  const title = body.title !== undefined ? v.str(body.title, 'title', { max: 120 }) : w.title;
  const blocks = routineFields(ctx, w, body);
  ctx.db.run('UPDATE workouts SET title = ?, warmup_id = ?, cooldown_id = ? WHERE id = ?', title, blocks.warmup_id, blocks.cooldown_id, workoutId);
  return getProgram(ctx, w.program_id).workouts.find((x) => x.id === workoutId);
}
// Like clearing a week, removing a workout athletes logged needs confirm: true (their logs stay in their history).
export function deleteWorkout(ctx, workoutId, body = {}) {
  const w = workoutRow(ctx, workoutId);
  guardLogged(ctx, [workoutId], body?.confirm, w.title);
  ctx.db.tx(() => deleteWorkouts(ctx, [workoutId]));
  return { id: workoutId, deleted: true };
}
// Copy a workout to another week and day (default: the next free day of that week).
export function copyWorkout(ctx, workoutId, body = {}) {
  const w = workoutRow(ctx, workoutId);
  const week = v.int(body.week ?? w.week, 'week', { min: 1, max: w.program_weeks });
  const day = freeDay(ctx, w.program_id, week, body.day);
  const id = ctx.db.tx(() => copyWorkoutInto(ctx, w, w.program_id, week, day, v.str(body.title, 'title', { max: 120, optional: true }) ?? w.title));
  return getProgram(ctx, w.program_id).workouts.find((x) => x.id === id);
}
// Removing workouts athletes already logged needs confirm: true. Their logs stay in the athletes' history (keepLogsOf)
// but leave the program's numbers.
function guardLogged(ctx, ids, confirm, what) {
  if (!ids.length) return;
  const n = ctx.db.get(`SELECT COUNT(*) AS n FROM workout_logs WHERE workout_id IN (${ids.map(() => '?').join(', ')})`, ...ids).n;
  if (n && confirm !== true) {
    const e = new HttpError(409, 'confirm_needed', `${what} ${n === 1 ? 'has 1 logged workout' : `has ${n} logged workouts`}. ${n === 1 ? 'That log stays' : 'Those logs stay'} in the athletes' history but ${n === 1 ? 'leaves' : 'leave'} this program's numbers. Send confirm: true to go ahead.`);
    e.details = { logs: n };
    throw e;
  }
}
// Copy every workout in a week to another week, or to a run of weeks (to ... through). Weeks that already have workouts
// are replaced only with replace: true. The program grows to the last week copied to.
export function copyWeek(ctx, programId, fromWeek, body = {}, adjustFor = null) {
  const p = getProgram(ctx, programId);
  const from = v.int(fromWeek, 'week', { min: 1, max: 52 });
  const to = v.int(body.to ?? from + 1, 'to', { min: 1, max: 52 });
  const through = body.through === undefined || body.through === null || body.through === '' ? to : v.int(body.through, 'through', { min: to, max: 52 });
  if (through - to > 51) throw badRequest('Copy to at most 52 weeks.');
  const targets = [];
  for (let w = to; w <= through; w++) if (w !== from) targets.push(w);
  if (!targets.length) throw badRequest('Choose a different week to copy to.');
  const src = p.workouts.filter((w) => w.week === from);
  if (!src.length) throw badRequest(`Week ${from} has no workouts to copy.`);
  const taken = targets.filter((w) => p.workouts.some((x) => x.week === w));
  if (taken.length && body.replace !== true) {
    const e = new HttpError(409, 'replace_needed', `${taken.length === 1 ? `Week ${taken[0]} already has` : `Weeks ${taken.slice(0, -1).join(', ')} and ${taken.at(-1)} already have`} workouts. Replace them to copy.`);
    e.details = { weeks: taken };
    throw e;
  }
  const replaced = p.workouts.filter((w) => taken.includes(w.week)).map((w) => w.id);
  guardLogged(ctx, replaced, body.confirm, taken.length === 1 ? `Week ${taken[0]}` : `Weeks ${taken.join(', ')}`);
  ctx.db.tx(() => {
    deleteWorkouts(ctx, replaced);
    for (const w of targets) for (const s of src) copyWorkoutInto(ctx, s, programId, w, s.day, undefined, adjustFor?.(w));
    if (through > p.weeks) setWeeks(ctx, programId, through);
  });
  return programDetail(ctx, programId);
}
// Clear a week. The last week also comes off the program (down to the last week that still has workouts).
export function deleteWeek(ctx, programId, week, body = {}) {
  const p = getProgram(ctx, programId);
  const n = v.int(week, 'week', { min: 1, max: 52 });
  const ids = p.workouts.filter((w) => w.week === n).map((w) => w.id);
  if (!ids.length && n !== p.weeks) throw badRequest(`Week ${n} has no workouts.`);
  guardLogged(ctx, ids, body.confirm, `Week ${n}`);
  ctx.db.tx(() => {
    deleteWorkouts(ctx, ids);
    if (n >= p.weeks && p.weeks > 1) setWeeks(ctx, programId, Math.max(1, lastWeekOf(ctx, programId), n - 1));
  });
  return programDetail(ctx, programId);
}

// Add an exercise to a workout. position puts it back where it was (Undo after removing); otherwise it goes last.
export function addWorkoutExercise(ctx, workoutId, body) {
  const w = ctx.db.get('SELECT * FROM workouts WHERE id = ?', workoutId);
  if (!w) throw notFound('Workout');
  getExercise(ctx, v.str(body.exercise_id, 'exercise_id'));
  const last = ctx.db.get('SELECT COALESCE(MAX(position), 0) AS n FROM workout_exercises WHERE workout_id = ?', workoutId).n;
  const load = loadInput(body);
  const f = adoptKind(ctx, workoutId, slotFields(body), body);
  // No position given: last, or right after the group it joins (a superset's second exercise goes under its first).
  const group = f.group_label ? ctx.db.get('SELECT MIN(position) AS lo, MAX(position) AS hi FROM workout_exercises WHERE workout_id = ? AND group_label = ?', workoutId, f.group_label) : null;
  let at = body.position === undefined || body.position === null ? (group?.hi ? group.hi + 1 : last + 1) : Math.min(v.int(body.position, 'position', { min: 1, max: 1000 }), last + 1);
  if (group?.hi) at = Math.min(Math.max(at, group.lo), group.hi + 1);   // a given place still keeps the group together
  const id = newId('wex');
  ctx.db.tx(() => {
    if (at <= last) ctx.db.run('UPDATE workout_exercises SET position = position + 1 WHERE workout_id = ? AND position >= ?', workoutId, at);
    insertSlot(ctx, workoutId, body.exercise_id, at, { ...f, load_test: load.test, load_pct: load.pct }, id);
    if (f.group_label) sameKind(ctx, workoutId, f.group_label, f.group_kind);
  });
  return getProgram(ctx, w.program_id).workouts.find((x) => x.id === workoutId);
}
// Every exercise in a group shares its kind (one superset can't be half circuit): joining a group without saying the
// kind takes the group's; saying it changes the whole group.
const sameKind = (ctx, workoutId, label, kind) => ctx.db.run('UPDATE workout_exercises SET group_kind = ? WHERE workout_id = ? AND group_label = ?', kind, workoutId, label);
function adoptKind(ctx, workoutId, f, body, exceptId = null) {
  if (!f.group_label || body.group_kind) return f;
  const other = ctx.db.get('SELECT group_kind FROM workout_exercises WHERE workout_id = ? AND group_label = ? AND id IS NOT ? AND group_kind IS NOT NULL LIMIT 1', workoutId, f.group_label, exceptId);
  return other ? { ...f, group_kind: other.group_kind } : f;
}
// The set details of one slot from a request: the fields given, over the row as it is (cur) for a change. A body with
// a prescription but no sets or reps (an older integration, the PDF draft) has the text split into them. Blank clears.
export function slotFields(body = {}, cur = null) {
  const f = Object.fromEntries(SET_FIELDS.map((k) => [k, cur?.[k] ?? null]));
  const has = (k) => body[k] !== undefined;
  const blankOr = (k, fn) => (body[k] === null || body[k] === '' ? null : fn());
  if (has('sets')) f.sets = blankOr('sets', () => v.int(body.sets, 'sets', { min: 1, max: MAX_SETS }));
  if (has('reps')) f.reps = blankOr('reps', () => v.str(body.reps, 'reps', { max: 80 }));
  if (has('tempo')) f.tempo = blankOr('tempo', () => v.str(body.tempo, 'tempo', { max: 20 }));
  if (has('rest_seconds')) f.rest_seconds = blankOr('rest_seconds', () => v.int(body.rest_seconds, 'rest_seconds', { min: 0, max: REST_MAX }));
  if (has('target_rpe')) f.target_rpe = blankOr('target_rpe', () => {
    const n = typeof body.target_rpe === 'number' || typeof body.target_rpe === 'string' ? Number(body.target_rpe) : NaN;
    if (!Number.isFinite(n) || n < 1 || n > 10 || Math.round(n * 2) !== n * 2) throw badRequest('Enter the target RPE from 1 to 10, in halves (like 7 or 7.5).');
    return n;
  });
  if (has('load_text')) f.load_text = blankOr('load_text', () => v.str(body.load_text, 'load_text', { max: 40 }));
  if (has('note')) f.note = blankOr('note', () => v.str(body.note, 'note', { max: 200 }));
  if (has('prescription') && !has('sets') && !has('reps')) {
    if (body.prescription !== null && typeof body.prescription !== 'string') throw badRequest('The sets and reps must be text, like 3 × 8.');
    const s = splitRx(body.prescription);
    if (String(body.prescription ?? '').trim().length > 80) throw badRequest('Keep the sets and reps to 80 characters.');
    f.sets = s.sets; f.reps = s.reps;
    if (!has('load_text')) f.load_text = s.load_text;       // the text is the whole story: a load or RPE it no longer has goes too
    if (!has('target_rpe')) f.target_rpe = s.target_rpe;
  }
  if (has('group_label')) {
    if (body.group_label !== null && typeof body.group_label !== 'string') throw badRequest('Name the group with one letter, A to Z.');
    const label = blankOr('group_label', () => body.group_label.trim().toUpperCase());
    if (label !== null && !/^[A-Z]$/.test(label)) throw badRequest('Name the group with one letter, A to Z.');
    f.group_label = label;
    f.group_kind = label === null ? null : has('group_kind') && body.group_kind ? v.oneOf(body.group_kind, 'group_kind', Object.keys(GROUP_KINDS)) : f.group_kind ?? 'superset';
  } else if (has('group_kind')) {
    f.group_kind = blankOr('group_kind', () => v.oneOf(body.group_kind, 'group_kind', Object.keys(GROUP_KINDS)));
    if (f.group_kind && !f.group_label) throw badRequest('Give the group a letter too (A, B, C...), so the exercises in it go together.');
    if (!f.group_kind) f.group_label = null;
  }
  if (f.sets == null && !f.reps) throw badRequest('Add the sets and reps, like 3 × 8.');
  f.prescription = rxText(f);
  return f;
}
// Weights from test results: an exercise can be prescribed as a percent of the athlete's latest tested max
// (back squat, bench press or power clean 1RM). The weight updates on its own when a new max is recorded, rounded
// to the nearest 5 lb. Athletes only see weights from results their family can see (the share rule).
export const LOAD_TESTS = { squat_1rm: 'back squat', bench_1rm: 'bench press', power_clean_1rm: 'power clean' };
export function loadInput(body) {
  if (!body.load_test) return { test: null, pct: null };
  const test = v.oneOf(body.load_test, 'load_test', Object.keys(LOAD_TESTS));
  const pct = Number(body.load_pct);
  if (!Number.isInteger(pct) || pct < 30 || pct > 110) throw badRequest('Enter the percent of their max as a whole number from 30 to 110, like 75.');
  return { test, pct };
}
// Change an exercise's prescription or weight, or swap it for another exercise (exercise_id) in the same slot.
export function updateWorkoutExercise(ctx, id, body) {
  const x = ctx.db.get('SELECT * FROM workout_exercises WHERE id = ?', id);
  if (!x) throw notFound('Workout exercise');
  const load = body.load_test === undefined ? { test: x.load_test, pct: x.load_pct } : loadInput(body);
  const exerciseId = body.exercise_id !== undefined ? getExercise(ctx, v.str(body.exercise_id, 'exercise_id')).id : x.exercise_id;
  const f = adoptKind(ctx, x.workout_id, slotFields(body, x), body, id);
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE workout_exercises SET prescription = ?, load_test = ?, load_pct = ?, exercise_id = ?, ${SLOT_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      f.prescription, load.test, load.pct, exerciseId, ...SLOT_COLS.map((c) => f[c]), id);
    if (f.group_label) {
      sameKind(ctx, x.workout_id, f.group_label, f.group_kind);
      // Joining a group moves the exercise to sit right after the others in it.
      if (f.group_label !== x.group_label) {
        const end = ctx.db.get('SELECT MAX(position) AS n FROM workout_exercises WHERE workout_id = ? AND group_label = ? AND id != ?', x.workout_id, f.group_label, id).n;
        if (end) moveSlot(ctx, x, x.position < end ? end : end + 1);
      }
    }
  });
  const rows = tagGroups(ctx.db.all('SELECT we.*, e.name FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.workout_id = ? ORDER BY we.position', x.workout_id));
  return rows.find((r) => r.id === id);
}
function moveSlot(ctx, x, to) {
  if (to === x.position) return;
  if (to < x.position) ctx.db.run('UPDATE workout_exercises SET position = position + 1 WHERE workout_id = ? AND position >= ? AND position < ?', x.workout_id, to, x.position);
  else ctx.db.run('UPDATE workout_exercises SET position = position - 1 WHERE workout_id = ? AND position > ? AND position <= ?', x.workout_id, x.position, to);
  ctx.db.run('UPDATE workout_exercises SET position = ? WHERE id = ?', to, x.id);
}
export function latestMax(ctx, clientId, testKey, { visibleOnly = false } = {}) {
  return ctx.db.get(`SELECT r.value, r.recorded_at FROM perf_results r JOIN perf_tests t ON t.id = r.test_id
    WHERE r.client_id = ? AND t.key = ? AND r.metric = 'load' AND r.voided = 0 ${visibleOnly ? parentFilter(ctx) : ''} ORDER BY r.recorded_at DESC, r.rowid DESC LIMIT 1`, clientId, testKey) ?? null;
}
// drop: percentage points to take off today after a rough daily check-in (readiness).
export function loadFor(ctx, clientId, x, { drop = 0, ...opts } = {}) {
  if (!x.load_test) return null;
  const max = latestMax(ctx, clientId, x.load_test, opts);
  const lift = LOAD_TESTS[x.load_test];
  const pct = drop ? Math.max(30, x.load_pct - drop) : x.load_pct;
  const lighter = pct < x.load_pct ? { planned_pct: x.load_pct } : {};
  if (!max) return { pct, lift, ...lighter, missing: true, text: `${pct}% of your ${lift} max${lighter.planned_pct ? ' (lighter today)' : ''}. Test your max to get a weight.` };
  const lb = Math.max(5, Math.round((max.value * pct) / 100 / 5) * 5);
  return { pct, lift, lb, max_lb: max.value, tested_at: max.recorded_at, ...lighter,
    text: lighter.planned_pct ? `${lb} lb (lighter today: ${pct}% instead of ${x.load_pct}% of your ${max.value} lb ${lift} max)` : `${lb} lb (${pct}% of your ${max.value} lb ${lift} max)` };
}

// Remove an exercise from a workout. The answer carries what Undo needs to put it back in the same place.
export function removeWorkoutExercise(ctx, id) {
  const x = ctx.db.get('SELECT * FROM workout_exercises WHERE id = ?', id);
  if (!x) throw notFound('Workout exercise');
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM workout_exercises WHERE id = ?', id);
    ctx.db.run('UPDATE workout_exercises SET position = position - 1 WHERE workout_id = ? AND position > ?', x.workout_id, x.position);
  });
  return { id, deleted: true, restore: { workout_id: x.workout_id, exercise_id: x.exercise_id, prescription: x.prescription, load_test: x.load_test, load_pct: x.load_pct, position: x.position, ...Object.fromEntries(SET_FIELDS.map((k) => [k, x[k]])) } };
}

// ---- Assignments ----
export function assign(ctx, programId, clientId, startDate) {
  const p = ctx.db.get('SELECT id, name FROM programs WHERE id = ?', programId);
  if (!p) throw notFound('Program');
  const c = ctx.db.get('SELECT id, name, archived_at FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Client');
  const first = c.name.split(' ')[0];
  if (c.archived_at) throw conflict(`${first} is archived. Bring them back before giving them a program.`);
  const current = ctx.db.get('SELECT a.program_id, p.name FROM assignments a JOIN programs p ON p.id = a.program_id WHERE a.client_id = ? AND a.active = 1', clientId);
  if (current?.program_id === programId) throw conflict(`${first} is already on ${p.name}.`);
  const id = newId('asg');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE assignments SET active = 0 WHERE client_id = ? AND active = 1', clientId);
    ctx.db.run('INSERT INTO assignments (id, client_id, program_id, start_date, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      id, clientId, programId, v.date(startDate, 'start_date', { optional: true }) ?? ctx.now(), ctx.now());
    emit(ctx, 'program.assigned', { assignment_id: id, client_id: clientId, client_name: c.name, program_id: programId, program_name: p.name });
  });
  return { id, client_id: clientId, program_id: programId, previous_program: current ? { id: current.program_id, name: current.name } : null };
}
// Take a client off a program. Their logged workouts stay in their history.
export function unassign(ctx, programId, clientId) {
  const a = ctx.db.get('SELECT id FROM assignments WHERE program_id = ? AND client_id = ? AND active = 1', programId, clientId);
  if (!a) throw notFound('That client on this program');
  ctx.db.run('UPDATE assignments SET active = 0 WHERE id = ?', a.id);
  return { client_id: clientId, program_id: programId, removed: true };
}

// Who can open the workout app: a membership that is active, in a trial or being retried, or a program bought online.
// Archived clients can't until they're brought back.
const ACCESS = { active: true, trialing: true, past_due: true };
export function appAccess(ctx, client) {
  const sub = ctx.db.get(`SELECT status FROM subscriptions WHERE client_id = ? ORDER BY (status = 'canceled'), created_at DESC LIMIT 1`, client.id);
  const status = sub?.status ?? 'none';
  if (client.archived_at) return { status, open: false, message: 'Your profile is on hold. Message your coach to get back in.' };
  if (clientLock(ctx, client.id)) return { status, open: false, payment_locked: true, message: athleteLockMessage };
  const bought = !ACCESS[status] && ctx.db.get(`SELECT a.id FROM assignments a JOIN purchases b ON b.client_id = a.client_id AND b.item_kind = 'program' AND b.item_id = a.program_id AND b.status = 'active' WHERE a.client_id = ? AND a.active = 1`, client.id);
  if (ACCESS[status] || bought) return { status, open: true };
  return { status, open: false, message: status === 'paused' ? 'Your membership is paused. Message your coach to pick back up.' : 'You don\'t have an active membership. Message your coach to get started.' };
}

// Progress for every current (not archived) client on a program, or on any program: workouts done, last workout,
// what's next. Quiet: no workout for 7 days or more (only when they can open the app). Complete: every workout done.
const QUIET_DAYS = 7;
export function clientProgress(ctx, { programId, clientId } = {}) {
  const where = ['a.active = 1', 'c.archived_at IS NULL'], args = [];
  if (programId) { where.push('a.program_id = ?'); args.push(programId); }
  if (clientId) { where.push('a.client_id = ?'); args.push(clientId); }
  const rows = ctx.db.all(`SELECT c.id, c.name, c.athlete_id, c.archived_at, a.id AS assignment_id, a.program_id, a.start_date, p.name AS program_name,
      (SELECT COUNT(*) FROM workouts w WHERE w.program_id = a.program_id) AS total,
      (SELECT MAX(l.completed_at) FROM workout_logs l WHERE l.client_id = c.id) AS last_workout_at
    FROM assignments a JOIN clients c ON c.id = a.client_id JOIN programs p ON p.id = a.program_id WHERE ${where.join(' AND ')} ORDER BY c.name COLLATE NOCASE`, ...args);
  const workoutsOf = new Map();
  const now = Date.parse(ctx.now());
  return rows.map((r) => {
    if (!workoutsOf.has(r.program_id)) workoutsOf.set(r.program_id, ctx.db.all('SELECT id, week, day, title FROM workouts WHERE program_id = ? ORDER BY week, day', r.program_id));
    const done = new Set(ctx.db.all('SELECT workout_id FROM workout_logs WHERE assignment_id = ?', r.assignment_id).map((x) => x.workout_id));
    const next = workoutsOf.get(r.program_id).find((w) => !done.has(w.id)) ?? null;
    const since = r.last_workout_at && r.last_workout_at > r.start_date ? r.last_workout_at : r.start_date;
    const idle = Math.max(0, Math.floor((now - Date.parse(since)) / 86400000));
    const access = appAccess(ctx, r);
    const complete = r.total > 0 && !next;
    return { id: r.id, name: r.name, athlete_id: r.athlete_id, program_id: r.program_id, program_name: r.program_name, start_date: r.start_date,
      done: workoutsOf.get(r.program_id).filter((w) => done.has(w.id)).length, total: r.total,
      next: next && { id: next.id, week: next.week, day: next.day, title: next.title }, last_workout_at: r.last_workout_at, days_idle: idle,
      membership: access.status, app_open: access.open, complete, quiet: !complete && r.total > 0 && access.open && idle >= QUIET_DAYS };
  });
}

// ---- Logged workouts ----
// A log whose program or workout was deleted reads from what was kept on it (program_deleted says so; program_id is empty).
const LOG_COLS = `l.id, l.client_id, c.name AS client_name, l.workout_id, COALESCE(w.title, l.workout_title) AS workout_title, COALESCE(w.week, l.workout_week) AS week,
  COALESCE(w.day, l.workout_day) AS day, pr.id AS program_id, COALESCE(pr.name, l.program_name) AS program_name, (w.id IS NULL) AS program_deleted,
  l.notes, l.rpe, l.completed_at, l.started_at, l.edited_at, l.session_id,
  CASE WHEN w.id IS NULL THEN (SELECT COUNT(*) FROM json_each(COALESCE(l.exercises_snapshot, '[]')) j WHERE json_extract(j.value, '$.done'))
    ELSE (SELECT COUNT(*) FROM exercise_logs x WHERE x.workout_log_id = l.id) END AS exercises_logged,
  CASE WHEN w.id IS NULL THEN json_array_length(COALESCE(l.exercises_snapshot, '[]'))
    ELSE (SELECT COUNT(*) FROM workout_exercises we WHERE we.workout_id = l.workout_id) END AS exercises_total,
  (SELECT COUNT(*) FROM workout_sets s WHERE s.workout_log_id = l.id) AS sets`;
const LOG_FROM = 'FROM workout_logs l JOIN clients c ON c.id = l.client_id LEFT JOIN workouts w ON w.id = l.workout_id LEFT JOIN programs pr ON pr.id = w.program_id';
// Minutes from the first set to Finish, when that looks like a real session.
const minutesOf = (l) => {
  if (!l.started_at) return null;
  const m = Math.round((Date.parse(l.completed_at) - Date.parse(l.started_at)) / 60000);
  return m >= 1 && m <= 240 ? m : null;
};
// New bests in a logged workout: the heaviest set of an exercise beats every earlier workout of that athlete.
export function bestsOf(ctx, logId) {
  return ctx.db.all(`SELECT s.exercise_name AS name, MAX(s.weight) AS weight,
      (SELECT MAX(s2.weight) FROM workout_sets s2 JOIN workout_logs l2 ON l2.id = s2.workout_log_id
        WHERE l2.client_id = l.client_id AND s2.exercise_id = s.exercise_id AND s2.weight > 0 AND l2.id != l.id AND l2.completed_at <= l.completed_at) AS previous
    FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id WHERE s.workout_log_id = ? AND s.weight > 0 AND s.exercise_id IS NOT NULL
    GROUP BY s.exercise_id ORDER BY MIN(s.rowid)`, logId).filter((b) => b.previous != null && b.weight > b.previous);
}
const shapeLog = (ctx, l) => ({ ...l, program_deleted: !!l.program_deleted, source: l.session_id ? 'screen' : 'app', minutes: minutesOf(l), bests: l.sets ? bestsOf(ctx, l.id) : [] });

// Completed workouts, newest first: effort, sets, new bests, notes. Archived clients are left out of the feed across
// clients (a client's own page still lists theirs).
export function listCompletions(ctx, { clientId, programId, since, limit = 50 } = {}) {
  const where = [], params = [];
  if (clientId) { where.push('l.client_id = ?'); params.push(clientId); } else where.push('c.archived_at IS NULL');
  if (programId) { where.push('pr.id = ?'); params.push(programId); }
  if (since) { where.push('l.completed_at >= ?'); params.push(since); }
  return ctx.db.all(
    `SELECT ${LOG_COLS} ${LOG_FROM}
     WHERE ${where.join(' AND ')} ORDER BY l.completed_at DESC, l.rowid DESC LIMIT ?`, ...params, limit).map((l) => shapeLog(ctx, l));
}
// The Programs page: workouts logged this week, who is on a program, who needs a check-in, who finished, and the feed.
export function programsActivity(ctx, { programId, days = 14 } = {}) {
  const progress = clientProgress(ctx, { programId });
  const since = new Date(Date.parse(ctx.now()) - days * 86400000).toISOString();
  return {
    recent: listCompletions(ctx, { programId, since, limit: 40 }),
    logged_7d: ctx.db.get(`SELECT COUNT(*) AS n FROM workout_logs l JOIN clients c ON c.id = l.client_id JOIN workouts w ON w.id = l.workout_id
      WHERE c.archived_at IS NULL AND l.completed_at >= ? ${programId ? 'AND w.program_id = ?' : ''}`, WEEK_AGO(ctx), ...(programId ? [programId] : [])).n,
    on_programs: progress.length,
    quiet: progress.filter((a) => a.quiet).sort((a, b) => b.days_idle - a.days_idle),
    complete: progress.filter((a) => a.complete)
  };
}

// ---- Set-by-set logging ----
// Sets to log come from the slot's fields (rx.js parseRx): "3 × 8-10", "4 × 5/side" count the low end; time, distance
// and "max" are sets the athlete ticks without a rep count.
const MAX_WEIGHT = 2000, MAX_REPS = 500;
export const REOPEN_HOURS = 2;
// The slots of a workout with the exercise each one logs as: the plan's, or the one a coach swapped in for this athlete.
function workoutItems(ctx, workoutId, clientId = null) {
  const items = ctx.db.all('SELECT we.id, we.exercise_id, e.name FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.workout_id = ? ORDER BY we.position', workoutId);
  const swaps = clientId ? swapsFor(ctx, clientId, workoutId) : null;
  return swaps?.size ? items.map((i) => { const sw = swaps.get(i.id); return sw ? { ...i, exercise_id: sw.exercise_id, name: sw.name } : i; }) : items;
}
// Version 56: the exercises a coach swapped for this athlete in one workout, by slot (services/live.js writes them).
export function swapsFor(ctx, clientId, workoutId) {
  const rows = ctx.db.all(`SELECT s.id, s.workout_exercise_id, s.reason, s.created_by, s.by_kind, s.created_at, e.id AS exercise_id, e.name, e.video_url, e.poster_url, e.instructions, e.category
    FROM exercise_swaps s JOIN exercises e ON e.id = s.exercise_id JOIN workout_exercises we ON we.id = s.workout_exercise_id WHERE s.client_id = ? AND we.workout_id = ?`, clientId, workoutId);
  return new Map(rows.map((r) => [r.workout_exercise_id, r]));
}
// A slot as this athlete does it: the swapped-in exercise takes the slot's sets and reps; a weight from a tested max
// doesn't carry over (it belonged to the other lift), and `swapped` says what it replaced and why.
export function slotFor(x, swap) {
  if (!swap) return x;
  return { ...x, exercise_id: swap.exercise_id, name: swap.name, video_url: swap.video_url, poster_url: swap.poster_url, instructions: swap.instructions, category: swap.category,
    load_test: null, load_pct: null, swapped: { id: swap.id, from: x.name, reason: swap.reason, by: swap.created_by, by_kind: swap.by_kind ?? 'coach' } };
}
const blank = (x) => x === undefined || x === null || x === '';

// Reads what an athlete logged for one workout: exercise_ids ticked, sets (workout_exercise_id, set_no, weight, reps),
// effort (rpe 1-10), notes, and when they started and finished (the phone's clock, kept only when it makes sense: a
// workout saved offline is sent later but counts on the day it was done). Used by the app and the weight-room screen.
export function readLog(ctx, workoutId, body = {}, clientId = null) {
  const items = workoutItems(ctx, workoutId, clientId), byId = new Map(items.map((i) => [i.id, i]));
  if (body.exercise_ids !== undefined && !Array.isArray(body.exercise_ids)) throw badRequest('exercise_ids must be a list.');
  if (body.sets !== undefined && body.sets !== null && !Array.isArray(body.sets)) throw badRequest('sets must be a list.');
  const ids = new Set();
  for (const x of body.exercise_ids ?? []) {
    if (!byId.has(String(x))) throw badRequest('exercise_ids contains exercises that are not in this workout.');
    ids.add(String(x));
  }
  const sets = [], seen = new Set();
  for (const [i, s] of (body.sets ?? []).entries()) {
    const item = byId.get(String(s?.workout_exercise_id ?? ''));
    if (!item) throw badRequest(`Set ${i + 1}: that exercise isn't in this workout.`);
    const n = Number(s.set_no);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SETS) throw badRequest(`${item.name}: sets are numbered 1 to ${MAX_SETS}.`);
    if (seen.has(`${item.id}:${n}`)) throw badRequest(`${item.name}: set ${n} is in the list twice.`);
    seen.add(`${item.id}:${n}`);
    let weight = null, reps = null;
    if (!blank(s.weight)) {
      weight = Number(s.weight);
      if (!Number.isFinite(weight) || weight < 0 || weight > MAX_WEIGHT) throw badRequest(`${item.name}, set ${n}: enter a weight from 0 to ${MAX_WEIGHT} lb, or leave it blank.`);
      weight = Math.round(weight * 10) / 10;
    }
    if (!blank(s.reps)) {
      reps = Number(s.reps);
      if (!Number.isInteger(reps) || reps < 0 || reps > MAX_REPS) throw badRequest(`${item.name}, set ${n}: enter reps as a whole number from 0 to ${MAX_REPS}, or leave it blank.`);
    }
    sets.push({ item, set_no: n, weight, reps });
    ids.add(item.id);
  }
  let rpe = null;
  if (!blank(body.rpe)) {
    rpe = Number(body.rpe);
    if (!Number.isInteger(rpe) || rpe < 1 || rpe > 10) throw badRequest('Rate how hard it was from 1 to 10, or leave it blank.');
  }
  const now = Date.parse(ctx.now());
  const when = (x) => { if (blank(x)) return null; const t = Date.parse(String(x)); return Number.isNaN(t) ? null : t; };
  let finished = when(body.finished_at);
  if (finished == null || finished > now + 5 * 60000 || finished < now - 72 * 3600000) finished = now;
  let started = when(body.started_at);
  if (started != null && (started > finished || started < finished - 6 * 3600000)) started = null;
  return { ids: [...ids], sets, rpe, notes: v.str(body.notes, 'notes', { max: 2000, optional: true }), total: items.length,
    completed_at: new Date(finished).toISOString(), started_at: started == null ? null : new Date(started).toISOString() };
}
export function saveSets(ctx, logId, data) {
  for (const x of data.ids) ctx.db.run('INSERT OR IGNORE INTO exercise_logs (workout_log_id, workout_exercise_id) VALUES (?, ?)', logId, x);
  for (const s of data.sets) {
    ctx.db.run('INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('set'), logId, s.item.id, s.item.exercise_id, s.item.name, s.set_no, s.weight, s.reps, ctx.now());
  }
}
const setsOf = (ctx, logId) => ctx.db.all('SELECT workout_exercise_id, set_no, weight, reps FROM workout_sets WHERE workout_log_id = ? ORDER BY workout_exercise_id, set_no', logId);

// The most recent workout with sets for this exercise, and the heaviest weight ever logged for it.
function lastTime(ctx, clientId, exerciseId) {
  const l = ctx.db.get(`SELECT l.id, l.completed_at FROM workout_logs l JOIN workout_sets s ON s.workout_log_id = l.id
    WHERE l.client_id = ? AND s.exercise_id = ? ORDER BY l.completed_at DESC, l.rowid DESC LIMIT 1`, clientId, exerciseId);
  if (!l) return null;
  return { date: l.completed_at, sets: ctx.db.all('SELECT set_no, weight, reps FROM workout_sets WHERE workout_log_id = ? AND exercise_id = ? ORDER BY set_no', l.id, exerciseId) };
}
const bestWeight = (ctx, clientId, exerciseId) => ctx.db.get(`SELECT MAX(s.weight) AS w FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id
  WHERE l.client_id = ? AND s.exercise_id = ? AND s.weight > 0`, clientId, exerciseId).w ?? null;

// ---- Client app ----
// A finished workout can be reopened (edited and saved again) by the athlete: only their latest one, for 2 hours.
function reopenBlock(ctx, clientId, l) {
  const latest = ctx.db.get('SELECT id FROM workout_logs WHERE client_id = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1', clientId);
  if (latest?.id !== l.id) return 'Only your most recent workout can be reopened.';
  if (Date.parse(ctx.now()) - Date.parse(l.completed_at) > REOPEN_HOURS * 3600000) return `Workouts can be reopened for ${REOPEN_HOURS} hours after you finish. Put anything you missed in a note next time.`;
  return null;
}
function recentLogs(ctx, clientId, limit = 10) {
  return ctx.db.all(`SELECT ${LOG_COLS} ${LOG_FROM}
    WHERE l.client_id = ? ORDER BY l.completed_at DESC, l.rowid DESC LIMIT ?`, clientId, limit)
    .map(({ client_id, client_name, session_id, started_at, ...l }) => ({ ...l, program_deleted: !!l.program_deleted, on_screen: !!session_id, minutes: minutesOf({ ...l, started_at }) }));
}
function reopenId(ctx, clientId) {
  const l = ctx.db.get('SELECT * FROM workout_logs WHERE client_id = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1', clientId);
  return l && l.workout_id && !reopenBlock(ctx, clientId, l) ? l.id : null;      // a removed workout can't be reopened
}
// One exercise as the app shows it: today's weight from a tested max, sets and reps to log, last time and best weight.
// One exercise as the app shows it: the plan, today's weight (lighter on a rough day), an easy day's sets taken off
// (never below one), and the coach-approved steps for this athlete on top (progression.js).
export function appExercise(ctx, clientId, x0, readiness, swaps = null) {
  const x = slotFor(x0, swaps?.get(x0.id));
  const drop = readiness?.drop ?? 0, setsOff = readiness?.sets_off ?? 0;
  const rx = parseRx(x);
  const step = appliedFor(ctx, clientId, x.exercise_id);
  const load = loadFor(ctx, clientId, x, { visibleOnly: true, drop });
  if (load && load.lb != null && step?.weight_lb) { load.lb = Math.max(5, load.lb + step.weight_lb); load.text = `${load.lb} lb (${load.text.replace(/^\d+ lb \((.*)\)$/, '$1')}, ${step.weight_lb > 0 ? '+' : ''}${step.weight_lb} lb from your progression)`; }
  const planned = Math.min(MAX_SETS, rx.sets + (step?.sets ?? 0));
  const targetSets = Math.max(1, planned - setsOff);
  return { ...x, load, target_sets: targetSets, ...(targetSets < planned ? { planned_sets: planned } : {}), target_reps: rx.reps == null ? null : Math.max(1, rx.reps + (step?.reps ?? 0)),
    progression: step, last: lastTime(ctx, clientId, x.exercise_id), best_weight: bestWeight(ctx, clientId, x.exercise_id) };
}

// The athlete's active program and the workouts left in it (the next one is what the app opens on).
export function nextWorkoutFor(ctx, clientId, load = (id) => getProgram(ctx, id)) {
  const a = ctx.db.get('SELECT * FROM assignments WHERE client_id = ? AND active = 1', clientId);
  if (!a) return null;
  const program = load(a.program_id);
  const done = new Set(ctx.db.all('SELECT workout_id FROM workout_logs WHERE assignment_id = ?', a.id).map((r) => r.workout_id));
  const left = program.workouts.filter((w) => !done.has(w.id));
  return { assignment: a, program, left, next: left[0] ?? null };
}
// The swaps the coach listed for a slot's planned exercise, for the app's "Can't do this today?".
function alternativesFor(ctx, x) {
  return ctx.db.all(`SELECT a.id, a.alt_exercise_id AS exercise_id, e.name, a.tag, a.note FROM exercise_alternatives a JOIN exercises e ON e.id = a.alt_exercise_id WHERE a.exercise_id = ? ORDER BY e.name COLLATE NOCASE`, x.exercise_id)
    .map((a) => ({ ...a, tag_label: ALT_TAGS[a.tag] ?? a.tag }));
}
export function clientHome(ctx, client) {
  const access = appAccess(ctx, client);
  const base = { client: { name: client.name, first_name: client.name.split(' ')[0] }, membership: access.status };
  if (!access.open) return { ...base, locked: true, message: access.message };
  const history = recentLogs(ctx, client.id), reopen_id = reopenId(ctx, client.id);
  const own = nextWorkoutFor(ctx, client.id);
  if (!own) return { ...base, locked: false, program: null, history, reopen_id, upcoming: [], message: 'Your coach is building your program. Check back soon.' };
  const { program, left, next } = own;
  const readiness = next ? readinessToday(ctx, client.id) : null;
  const swaps = next ? swapsFor(ctx, client.id, next.id) : null;
  return {
    ...base, locked: false,
    program: { id: program.id, name: program.name, weeks: program.weeks },
    progress: { completed: program.workouts.length - left.length, total: program.workouts.length },
    readiness,
    workout: next && { ...next, exercises: next.exercises.map((x) => ({ ...appExercise(ctx, client.id, x, readiness, swaps), alternatives: alternativesFor(ctx, x) })) },
    upcoming: left.slice(1, 4).map((w) => ({ id: w.id, week: w.week, day: w.day, title: w.title, exercises: w.exercises.map((x) => x.name) })),
    history, reopen_id,
    message: next ? null : 'Program complete. Your coach will set your next block.'
  };
}

// What the done screen shows.
function finishedSummary(ctx, logId, extra = {}) {
  const l = ctx.db.get(`SELECT ${LOG_COLS} ${LOG_FROM} WHERE l.id = ?`, logId);
  return { id: l.id, title: l.workout_title, week: l.week, day: l.day, program_name: l.program_name, exercises_logged: l.exercises_logged, exercises_total: l.exercises_total,
    sets: l.sets, rpe: l.rpe, notes: l.notes, minutes: minutesOf(l), bests: bestsOf(ctx, l.id), completed_at: l.completed_at, reopen_hours: REOPEN_HOURS, ...extra };
}
function announce(ctx, client, logId) {
  const f = finishedSummary(ctx, logId);
  const l = ctx.db.get('SELECT workout_id, session_id FROM workout_logs WHERE id = ?', logId);
  emit(ctx, 'workout.completed', { workout_log_id: logId, client_id: client.id, client_name: client.name, workout_id: l.workout_id, workout_title: f.title, program_name: f.program_name,
    exercises_logged: f.exercises_logged, exercises_total: f.exercises_total, sets: f.sets, effort: f.rpe, minutes: f.minutes, bests: f.bests, notes: f.notes, ...(l.session_id ? { session_id: l.session_id } : {}) });
}

// Finish a workout from the app: the exercises done, every set, effort and a note, saved together. request_id (made by
// the phone for each Finish) makes a resend (a second tap, or a workout saved offline and sent again) return the first
// save instead of logging twice. If the athlete already logged it on the weight-room screen, the sets join that log.
export function completeWorkout(ctx, client, workoutId, body = {}) {
  // A resend of a Finish the server already has returns that save, even if access changed in between (nothing is written).
  const requestId = v.str(body.request_id, 'request_id', { max: 80, optional: true });
  if (requestId) {
    const first = ctx.db.get('SELECT id FROM workout_logs WHERE client_id = ? AND request_id = ?', client.id, requestId);
    if (first) return { id: first.id, repeat: true, finished: finishedSummary(ctx, first.id), next: clientHome(ctx, client) };
  }
  const access = appAccess(ctx, client);
  if (!access.open) throw conflict(access.message);
  const a = ctx.db.get('SELECT * FROM assignments WHERE client_id = ? AND active = 1', client.id);
  if (!a) throw conflict('You aren\'t on a program right now, so this workout couldn\'t be saved. Tell your coach what you did.');
  const w = ctx.db.get('SELECT * FROM workouts WHERE id = ? AND program_id = ?', workoutId, a.program_id);
  if (!w) throw conflict('Your coach changed your program, so this workout couldn\'t be saved. Tell your coach what you did.');
  const data = readLog(ctx, workoutId, body, client.id);
  const existing = ctx.db.get('SELECT * FROM workout_logs WHERE assignment_id = ? AND workout_id = ?', a.id, workoutId);
  if (existing) {
    const bare = existing.session_id && existing.rpe == null && !ctx.db.get('SELECT 1 FROM workout_sets WHERE workout_log_id = ?', existing.id);
    if (!bare) throw conflict('This workout is already logged.');
    ctx.db.tx(() => {
      ctx.db.run('UPDATE workout_logs SET notes = COALESCE(?, notes), rpe = ?, started_at = COALESCE(started_at, ?), request_id = COALESCE(request_id, ?) WHERE id = ?', data.notes, data.rpe, data.started_at, requestId, existing.id);
      saveSets(ctx, existing.id, data);
    });
    return { id: existing.id, merged: true, finished: finishedSummary(ctx, existing.id, { merged: true }), next: clientHome(ctx, client) };
  }
  const id = newId('log');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO workout_logs (id, client_id, assignment_id, workout_id, notes, completed_at, rpe, started_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, client.id, a.id, workoutId, data.notes, data.completed_at, data.rpe, data.started_at, requestId);
    saveSets(ctx, id, data);
    announce(ctx, client, id);
  });
  let progressions = [];
  try { progressions = suggestAfterLog(ctx, client, id); } catch (e) { console.error('progression check:', e.message); }   // a suggestion is never worth failing the save
  return { id, finished: { ...finishedSummary(ctx, id), progressions: progressions.map((p) => ({ exercise_name: p.exercise_name, text: p.text, status: p.status })) }, next: clientHome(ctx, client) };
}

// Save a reopened workout again: the whole log is replaced with what was sent (sending it twice changes nothing).
export function editLog(ctx, client, logId, body = {}) {
  const access = appAccess(ctx, client);
  if (!access.open) throw conflict(access.message);
  const l = ctx.db.get('SELECT * FROM workout_logs WHERE id = ? AND client_id = ?', String(logId), client.id);
  if (!l) throw notFound('Workout');
  if (!l.workout_id) throw conflict('Your coach removed this workout from your program, so it can\'t be reopened. It stays in your history.');
  const why = reopenBlock(ctx, client.id, l);
  if (why) throw conflict(why);
  const data = readLog(ctx, l.workout_id, body, client.id);
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM workout_sets WHERE workout_log_id = ?', l.id);
    ctx.db.run('DELETE FROM exercise_logs WHERE workout_log_id = ?', l.id);
    ctx.db.run('UPDATE workout_logs SET notes = ?, rpe = ?, edited_at = ? WHERE id = ?', data.notes, data.rpe, ctx.now(), l.id);
    saveSets(ctx, l.id, data);
  });
  return { id: l.id, finished: finishedSummary(ctx, l.id, { edited: true }), next: clientHome(ctx, client) };
}

// One finished workout in full, for the athlete who logged it: every exercise, whether it was done, and its sets.
export function logDetail(ctx, client, logId) {
  const l = ctx.db.get(`SELECT ${LOG_COLS} ${LOG_FROM}
    WHERE l.id = ? AND l.client_id = ?`, String(logId), client.id);
  if (!l) throw notFound('Workout');
  const done = new Set(ctx.db.all('SELECT workout_exercise_id FROM exercise_logs WHERE workout_log_id = ?', l.id).map((r) => r.workout_exercise_id));
  const sets = setsOf(ctx, l.id);
  // A deleted workout's exercises come from what was kept on the log, with whether each was done.
  const kept = l.workout_id ? null : (() => { try { return JSON.parse(ctx.db.get('SELECT exercises_snapshot FROM workout_logs WHERE id = ?', l.id).exercises_snapshot || '[]'); } catch { return []; } })();
  if (kept) for (const k of kept) if (k.done) done.add(k.id);
  // A swapped exercise shows as what the athlete did (the sets are under it), with what it replaced.
  const swaps = l.workout_id ? swapsFor(ctx, client.id, l.workout_id) : null;
  const items = tagGroups(kept ?? ctx.db.all(`SELECT we.id, we.prescription, ${SLOT_COLS.map((c) => `we.${c}`).join(', ')}, e.name, e.id AS exercise_id FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.workout_id = ? ORDER BY we.position`, l.workout_id)
    .map((i) => { const { swapped, ...x } = slotFor(i, swaps.get(i.id)); return swapped ? { ...x, swapped_from: swapped.from } : x; }));
  // Sets of exercises the coach has since taken out of the workout still show.
  const gone = ctx.db.all('SELECT DISTINCT workout_exercise_id AS id, exercise_name AS name FROM workout_sets WHERE workout_log_id = ?', l.id).filter((g) => !items.some((i) => i.id === g.id));
  const strip = ({ workout_exercise_id, ...s }) => s;
  const rxOf = (i) => { const r = parseRx(i); return { target_sets: r.sets, target_reps: r.reps }; };
  const slot = (i) => ({ ...Object.fromEntries(SET_FIELDS.map((k) => [k, i[k] ?? null])), details: i.details ?? null, group_tag: i.group_tag ?? null });
  return {
    id: l.id, title: l.workout_title, week: l.week, day: l.day, program_name: l.program_name, completed_at: l.completed_at, rpe: l.rpe, notes: l.notes,
    minutes: minutesOf(l), on_screen: !!l.session_id, bests: bestsOf(ctx, l.id), can_reopen: !!l.workout_id && !reopenBlock(ctx, client.id, l),
    workout_id: l.workout_id, program_deleted: !l.workout_id,
    exercises: [...items.map((i) => ({ id: i.id, exercise_id: i.exercise_id, name: i.name, prescription: i.prescription, ...(i.swapped_from ? { swapped_from: i.swapped_from } : {}), ...slot(i), ...rxOf(i), done: done.has(i.id), sets: sets.filter((s) => s.workout_exercise_id === i.id).map(strip) })),
      ...gone.map((g) => ({ id: g.id, name: g.name, prescription: null, done: true, removed: true, sets: sets.filter((s) => s.workout_exercise_id === g.id).map(strip) }))]
  };
}

// The start of the business's day, for "already logged today" on the weight-room screen.
export const startOfToday = (ctx) => startOfLocalDay(ctx.now(), getSetting(ctx, 'timezone'));
