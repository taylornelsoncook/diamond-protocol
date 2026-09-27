// Athlete workout progress: which program day comes next, what's logged (exercises and sets), and finishing a workout.
'use strict';
const { db, get, all, run, insert, tx } = require('../db');
const { bad, notFound, emit, addDays } = require('../lib');
const { todayLocal } = require('./booking');

// Sets the athlete logs: weight (lb) and reps per set. exercise_id is kept so "last time" and bests
// follow the exercise across programs. No foreign key on item_id: coaches can delete program items.
db.exec(`
CREATE TABLE IF NOT EXISTS workout_sets (
  id INTEGER PRIMARY KEY, log_id INTEGER NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL, exercise_id INTEGER NOT NULL, set_no INTEGER NOT NULL,
  weight REAL, reps INTEGER, created_at TEXT DEFAULT (datetime('now')), UNIQUE (log_id, item_id, set_no));
CREATE INDEX IF NOT EXISTS workout_sets_exercise ON workout_sets(exercise_id);
`);
// Added after launch: how hard the athlete rated the workout (session RPE, 1–10).
if (!all('PRAGMA table_info(workout_logs)').some((c) => c.name === 'rpe')) run('ALTER TABLE workout_logs ADD COLUMN rpe INTEGER');

const MAX_SETS = 12;
const MAX_WEIGHT = 2000;
const MAX_REPS = 500;
const REOPEN_HOURS = 2;
const RPE_WORDS = ['', 'very easy', 'easy', 'moderate', 'somewhat hard', 'hard', 'hard', 'very hard', 'very hard', 'near max', 'max effort'];

const parseDone = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; } };
const plural = (n, one) => `${n} ${n === 1 ? one : one + 's'}`;
const fmtLb = (w) => `${Number.isInteger(w) ? w : w.toFixed(1)} lb`;
// "3" → 3 sets; anything odd → 1 set; never more than 10 rows to start with.
const targetSets = (sets) => { const n = parseInt(sets, 10); return Number.isInteger(n) && n > 0 ? Math.min(n, 10) : 1; };
// "8" or "8 each side" → 8 reps to count. "20 sec" or "20 yd" → null: the set is done, not counted.
const targetReps = (reps) => { const m = /^\s*(\d{1,3})\s*(each side|each|per side|\/side|reps?)?\s*$/i.exec(String(reps ?? '')); return m ? Number(m[1]) : null; };
// Minutes from the first thing logged to Finish, when that looks like a real session.
function minutesBetween(from, to) {
  if (!from || !to) return null;
  const ms = (s) => Date.parse(String(s).replace(' ', 'T') + (/[zZ]$/.test(s) ? '' : 'Z'));
  const m = Math.round((ms(to) - ms(from)) / 60000);
  return m >= 1 && m <= 240 ? m : null;
}

function programDays(programId) {
  return all('SELECT * FROM program_days WHERE program_id=? ORDER BY week, day, id', programId);
}
function dayItems(dayId) {
  return all(`SELECT i.id, i.sets, i.reps, i.cue, i.ord, e.id AS exercise_id, e.name, e.cues, e.video_url
    FROM program_items i JOIN exercises e ON e.id=i.exercise_id WHERE i.day_id=? ORDER BY i.ord, i.id`, dayId);
}
function finishedDayIds(athleteId, programId) {
  return new Set(all(`SELECT DISTINCT l.day_id FROM workout_logs l JOIN program_days d ON d.id=l.day_id
    WHERE l.athlete_id=? AND d.program_id=? AND l.finished_at IS NOT NULL`, athleteId, programId).map((r) => r.day_id));
}
const logSets = (logId) => (logId ? all('SELECT item_id, set_no, weight, reps FROM workout_sets WHERE log_id=? ORDER BY item_id, set_no', logId) : []);

// The most recent finished workout with sets for this exercise.
function lastTime(athleteId, exerciseId, exceptLogId) {
  const l = get(`SELECT l.id, l.finished_at FROM workout_logs l JOIN workout_sets s ON s.log_id=l.id
    WHERE l.athlete_id=? AND s.exercise_id=? AND l.finished_at IS NOT NULL AND l.id<>? ORDER BY l.finished_at DESC, l.id DESC LIMIT 1`, athleteId, exerciseId, exceptLogId || 0);
  if (!l) return null;
  return { date: l.finished_at, sets: all('SELECT set_no, weight, reps FROM workout_sets WHERE log_id=? AND exercise_id=? ORDER BY set_no', l.id, exerciseId) };
}
// The heaviest weight in any earlier finished workout for this exercise.
function bestWeight(athleteId, exerciseId, exceptLogId) {
  return get(`SELECT MAX(s.weight) AS w FROM workout_sets s JOIN workout_logs l ON l.id=s.log_id
    WHERE l.athlete_id=? AND s.exercise_id=? AND l.finished_at IS NOT NULL AND l.id<>? AND s.weight > 0`, athleteId, exerciseId, exceptLogId || 0).w || null;
}

// Suggest a weekday for the next workout: tomorrow when training 4+ days a week, otherwise after a rest day.
// Uses the business's own date, so an evening workout doesn't skip a day.
function suggestDay(daysInWeek, from = todayLocal()) {
  const d = addDays(from, daysInWeek >= 4 ? 1 : 2);
  return { date: d, weekday: new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }) };
}

// Full state for the workout app.
function state(athlete) {
  const out = { athlete: { first_name: athlete.first_name, last_name: athlete.last_name, code: athlete.code }, program: null, history: history(athlete.id) };
  if (!athlete.program_id) return out;
  const program = get('SELECT id,name,weeks,level,description FROM programs WHERE id=?', athlete.program_id);
  if (!program) return out;
  const days = programDays(program.id);
  const finished = finishedDayIds(athlete.id, program.id);
  const current = days.find((d) => !finished.has(d.id)) || null;
  out.program = { ...program, started: athlete.program_started, total_days: days.length, finished_days: days.filter((d) => finished.has(d.id)).length };
  out.current = null;
  out.upcoming = [];
  if (!current) return out;
  const log = get('SELECT * FROM workout_logs WHERE athlete_id=? AND day_id=? AND finished_at IS NULL ORDER BY id DESC LIMIT 1', athlete.id, current.id);
  const items = dayItems(current.id).map((i) => ({
    ...i, target_sets: targetSets(i.sets), target_reps: targetReps(i.reps),
    last: lastTime(athlete.id, i.exercise_id, log?.id), best_weight: bestWeight(athlete.id, i.exercise_id, log?.id),
  }));
  out.current = { day_id: current.id, week: current.week, day: current.day, title: current.title || `Day ${current.day}`, items,
    log: log ? { id: log.id, done: parseDone(log.done), note: log.note || '', sets: logSets(log.id), started_at: log.created_at }
      : { id: null, done: [], note: '', sets: [], started_at: null } };
  const idx = days.indexOf(current);
  const after = days[idx + 1];
  out.after = after ? { week: after.week, day: after.day, title: after.title || `Day ${after.day}` } : null;
  // What's coming after today, so athletes can plan their week.
  out.upcoming = days.slice(idx + 1).filter((d) => !finished.has(d.id)).slice(0, 3).map((d) => ({
    week: d.week, day: d.day, title: d.title || `Day ${d.day}`,
    exercises: all('SELECT e.name FROM program_items i JOIN exercises e ON e.id=i.exercise_id WHERE i.day_id=? ORDER BY i.ord, i.id', d.id).map((r) => r.name),
  }));
  return out;
}

function history(athleteId) {
  return all(`SELECT l.id, l.finished_at, l.created_at, l.done, l.note, l.rpe, d.week, d.day, d.title, p.name AS program,
      (SELECT COUNT(*) FROM program_items i WHERE i.day_id=d.id) AS total,
      (SELECT COUNT(*) FROM workout_sets s WHERE s.log_id=l.id) AS sets
    FROM workout_logs l JOIN program_days d ON d.id=l.day_id JOIN programs p ON p.id=d.program_id
    WHERE l.athlete_id=? AND l.finished_at IS NOT NULL ORDER BY l.finished_at DESC, l.id DESC LIMIT 20`, athleteId)
    .map(({ created_at, ...h }) => ({ ...h, title: h.title || `Day ${h.day}`, done: parseDone(h.done).length, minutes: minutesBetween(created_at, h.finished_at) }));
}

// One finished workout in full: every exercise, whether it was done, and the sets logged.
function historyDetail(athlete, logId) {
  const l = get(`SELECT l.*, d.week, d.day, d.title, p.name AS program FROM workout_logs l JOIN program_days d ON d.id=l.day_id
    JOIN programs p ON p.id=d.program_id WHERE l.id=? AND l.athlete_id=? AND l.finished_at IS NOT NULL`, Number(logId) || 0, athlete.id);
  if (!l) throw notFound('That workout');
  const done = new Set(parseDone(l.done));
  const sets = logSets(l.id);
  return {
    id: l.id, program: l.program, week: l.week, day: l.day, title: l.title || `Day ${l.day}`, finished_at: l.finished_at,
    minutes: minutesBetween(l.created_at, l.finished_at), rpe: l.rpe ?? null, note: l.note || '',
    items: dayItems(l.day_id).map((i) => ({ id: i.id, name: i.name, sets: i.sets, reps: i.reps, done: done.has(i.id),
      logged: sets.filter((x) => x.item_id === i.id).map(({ set_no, weight, reps }) => ({ set_no, weight, reps })) })),
  };
}

function requireCurrent(athlete, dayId) {
  const s = state(athlete);
  if (!s.program) throw bad('No program is assigned yet. Ask your coach.');
  if (!s.current) throw bad('Every workout in this program is done. Your coach will set up what comes next.');
  if (dayId != null && Number(dayId) !== s.current.day_id) {
    const e = bad('Your program changed since this page loaded. Reload to see the latest.');
    e.status = 409;
    throw e;
  }
  return s;
}
const startLog = (athlete, s, list, note) => insert('workout_logs', { athlete_id: athlete.id, day_id: s.current.day_id, done: JSON.stringify(list), note: note || null });
const logResult = (logId) => { const row = get('SELECT done, note FROM workout_logs WHERE id=?', logId); return { done: parseDone(row.done), note: row.note || '', sets: logSets(logId) }; };

// Log (or un-log) one exercise, and/or save the note. Creates the log row on first use.
function logItem(athlete, { day_id, item_id, done, note }) {
  const s = requireCurrent(athlete, day_id);
  return tx(() => {
    let logId = s.current.log.id;
    let list = s.current.log.done.slice();
    if (item_id != null) {
      const iid = Number(item_id);
      if (!s.current.items.some((i) => i.id === iid)) throw bad("That exercise isn't in today's workout.");
      list = list.filter((x) => x !== iid);
      if (done !== false) list.push(iid);
    }
    const noteVal = note === undefined ? undefined : String(note || '').slice(0, 2000);
    if (!logId) {
      if (item_id == null && !noteVal) return { done: list, note: '', sets: [] };
      logId = startLog(athlete, s, list, noteVal);
    } else {
      run('UPDATE workout_logs SET done=? WHERE id=?', JSON.stringify(list), logId);
      if (noteVal !== undefined) run('UPDATE workout_logs SET note=? WHERE id=?', noteVal || null, logId);
    }
    return logResult(logId);
  });
}

// Optional number within a range; '' and null mean "not given".
function optNumber(v, { max, whole, msg }) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max || (whole && !Number.isInteger(n))) throw bad(msg);
  return whole ? n : Math.round(n * 10) / 10;
}

// Log (or clear) one set of one exercise with its weight and reps. Logging the last set marks the exercise done;
// clearing a set un-marks it, since it's no longer finished.
function logSet(athlete, { day_id, item_id, set_no, weight, reps, done }) {
  const s = requireCurrent(athlete, day_id);
  const item = s.current.items.find((i) => i.id === Number(item_id));
  if (!item) throw bad("That exercise isn't in today's workout.");
  const n = Number(set_no);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SETS) throw bad(`Sets are numbered 1 to ${MAX_SETS}.`);
  const w = optNumber(weight, { max: MAX_WEIGHT, msg: `Enter a weight from 0 to ${MAX_WEIGHT} lb, or leave it blank.` });
  const r = optNumber(reps, { max: MAX_REPS, whole: true, msg: `Enter reps as a whole number from 0 to ${MAX_REPS}, or leave it blank.` });
  return tx(() => {
    let logId = s.current.log.id;
    const others = s.current.log.done.filter((x) => x !== item.id);
    if (!logId) {
      if (done === false) return { done: [], note: '', sets: [] };
      logId = startLog(athlete, s, others, null);
    }
    let markDone = false;
    if (done === false) run('DELETE FROM workout_sets WHERE log_id=? AND item_id=? AND set_no=?', logId, item.id, n);
    else {
      run(`INSERT INTO workout_sets (log_id, item_id, exercise_id, set_no, weight, reps) VALUES (?,?,?,?,?,?)
        ON CONFLICT (log_id, item_id, set_no) DO UPDATE SET weight=excluded.weight, reps=excluded.reps`, logId, item.id, item.exercise_id, n, w, r);
      const count = get('SELECT COUNT(*) AS n FROM workout_sets WHERE log_id=? AND item_id=?', logId, item.id).n;
      markDone = count >= item.target_sets || s.current.log.done.includes(item.id);
    }
    run('UPDATE workout_logs SET done=? WHERE id=?', JSON.stringify(markDone ? [...others, item.id] : others), logId);
    return logResult(logId);
  });
}

function finish(athlete, { day_id, note, rpe }, ip) {
  const s = requireCurrent(athlete, day_id);
  const cur = s.current;
  const done = s.current.log.done.filter((id) => cur.items.some((i) => i.id === id));
  if (!done.length) throw bad('Log at least one exercise before you finish.');
  let effort = null;
  if (rpe != null && rpe !== '') {
    effort = Number(rpe);
    if (!Number.isInteger(effort) || effort < 1 || effort > 10) throw bad('Rate how hard it was from 1 to 10, or leave it blank.');
  }
  const name = `${athlete.first_name} ${athlete.last_name}`;
  const sets = cur.log.sets;
  // New bests: the heaviest set today beats every earlier finished workout for that exercise.
  const bests = [];
  for (const i of cur.items) {
    const top = Math.max(0, ...sets.filter((x) => x.item_id === i.id && x.weight > 0).map((x) => x.weight));
    if (top > 0 && i.best_weight && top > i.best_weight) bests.push({ name: i.name, weight: top, previous: i.best_weight });
  }
  tx(() => {
    const noteVal = note === undefined ? cur.log.note : String(note || '').slice(0, 2000);
    run("UPDATE workout_logs SET finished_at=datetime('now'), note=?, rpe=? WHERE id=?", noteVal || null, effort, cur.log.id);
    const extra = [effort ? `effort ${effort}/10` : '', sets.length ? plural(sets.length, 'set') : '',
      bests.length ? `new best: ${bests.map((b) => `${b.name} ${fmtLb(b.weight)}`).join(', ')}` : ''].filter(Boolean);
    insert('activity', { actor: `${name} (athlete)`, action: `Workout logged: ${name}, ${cur.title}`,
      detail: [`${s.program.name} · week ${cur.week}, day ${cur.day} · ${done.length} of ${cur.items.length} exercises`, ...extra].join(' · '), ip: ip || null, kind: 'change' });
  });
  const log = get('SELECT * FROM workout_logs WHERE id=?', cur.log.id);
  const minutes = minutesBetween(log.created_at, log.finished_at);
  emit('workout.completed', {
    athlete_code: athlete.code, athlete: name, program: s.program.name, week: cur.week, day: cur.day, title: cur.title,
    exercises_done: done.length, exercises_total: cur.items.length, note: log.note || null, finished_at: log.finished_at,
    rpe: effort, minutes, sets: cur.items.filter((i) => sets.some((x) => x.item_id === i.id)).map((i) => ({
      exercise: i.name, sets: sets.filter((x) => x.item_id === i.id).map(({ set_no, weight, reps }) => ({ set_no, weight, reps })) })),
  });
  const next = state(athlete);
  let nextUp = null;
  if (next.current) {
    const perWeek = all('SELECT COUNT(*) AS n FROM program_days WHERE program_id=? AND week=?', athlete.program_id, next.current.week)[0].n;
    nextUp = { week: next.current.week, day: next.current.day, title: next.current.title, ...suggestDay(perWeek) };
  }
  return { ok: true, finished: { log_id: log.id, week: cur.week, day: cur.day, title: cur.title, done: done.length, total: cur.items.length,
    sets: sets.length, rpe: effort, rpe_word: effort ? RPE_WORDS[effort] : null, minutes, bests, reopen_hours: REOPEN_HOURS }, next_up: nextUp, state: next };
}

// Undo Finish workout: the most recent finished workout can be reopened for a couple of hours,
// as long as the next one hasn't been started.
function reopen(athlete, { log_id }, ip) {
  const l = get(`SELECT l.*, d.program_id, d.week, d.day, d.title FROM workout_logs l JOIN program_days d ON d.id=l.day_id
    WHERE l.id=? AND l.athlete_id=? AND l.finished_at IS NOT NULL`, Number(log_id) || 0, athlete.id);
  if (!l) throw notFound('That workout');
  const latest = get('SELECT id FROM workout_logs WHERE athlete_id=? AND finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1', athlete.id);
  if (latest.id !== l.id) throw bad('Only your most recent workout can be reopened.');
  if (l.program_id !== athlete.program_id) throw bad("Your program has changed since, so this workout can't be reopened. Tell your coach instead.");
  if (!get("SELECT 1 AS ok WHERE ? >= datetime('now', ?)", l.finished_at, `-${REOPEN_HOURS} hours`)) {
    throw bad(`Workouts can be reopened for ${REOPEN_HOURS} hours after you finish. Put anything you missed in a note next time.`);
  }
  const started = get(`SELECT l.id FROM workout_logs l WHERE l.athlete_id=? AND l.finished_at IS NULL AND l.day_id<>?
    AND (COALESCE(l.done,'[]') <> '[]' OR EXISTS (SELECT 1 FROM workout_sets s WHERE s.log_id=l.id))`, athlete.id, l.day_id);
  if (started) throw bad("You've already started your next workout, so this one can't be reopened.");
  const name = `${athlete.first_name} ${athlete.last_name}`;
  tx(() => {
    run('UPDATE workout_logs SET finished_at=NULL, rpe=NULL WHERE id=?', l.id);
    insert('activity', { actor: `${name} (athlete)`, action: `Workout reopened: ${name}, ${l.title || `Day ${l.day}`}`, detail: `week ${l.week}, day ${l.day}`, ip: ip || null, kind: 'change' });
  });
  return state(athlete);
}

module.exports = { state, logItem, logSet, finish, reopen, historyDetail, programDays, dayItems, suggestDay, parseDone, targetSets, targetReps };
