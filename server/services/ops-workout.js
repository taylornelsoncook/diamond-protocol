// Athlete workout progress: which program day comes next, what's logged, and finishing a workout.
'use strict';
const { get, all, run, insert, tx } = require('../db');
const { bad, emit, addDays, today } = require('../lib');

const parseDone = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; } };

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

// Suggest a weekday for the next workout: tomorrow when training 4+ days a week, otherwise after a rest day.
function suggestDay(daysInWeek, from = today()) {
  const d = addDays(from, daysInWeek >= 4 ? 1 : 2);
  return { date: d, weekday: new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }) };
}

// Full state for the workout app.
function state(athlete) {
  const out = { athlete: { first_name: athlete.first_name, last_name: athlete.last_name, code: athlete.code }, program: null };
  if (!athlete.program_id) return out;
  const program = get('SELECT id,name,weeks,level,description FROM programs WHERE id=?', athlete.program_id);
  if (!program) return out;
  const days = programDays(program.id);
  const finished = finishedDayIds(athlete.id, program.id);
  const current = days.find((d) => !finished.has(d.id)) || null;
  out.program = { ...program, started: athlete.program_started, total_days: days.length, finished_days: days.filter((d) => finished.has(d.id)).length };
  if (current) {
    const log = get('SELECT * FROM workout_logs WHERE athlete_id=? AND day_id=? AND finished_at IS NULL ORDER BY id DESC LIMIT 1', athlete.id, current.id);
    out.current = { day_id: current.id, week: current.week, day: current.day, title: current.title || `Day ${current.day}`,
      items: dayItems(current.id), log: log ? { id: log.id, done: parseDone(log.done), note: log.note || '' } : { id: null, done: [], note: '' } };
    const after = days[days.indexOf(current) + 1];
    out.after = after ? { week: after.week, day: after.day, title: after.title || `Day ${after.day}` } : null;
  } else out.current = null;
  out.history = all(`SELECT l.id, l.finished_at, l.done, l.note, d.week, d.day, d.title, p.name AS program,
      (SELECT COUNT(*) FROM program_items i WHERE i.day_id=d.id) AS total
    FROM workout_logs l JOIN program_days d ON d.id=l.day_id JOIN programs p ON p.id=d.program_id
    WHERE l.athlete_id=? AND l.finished_at IS NOT NULL ORDER BY l.finished_at DESC, l.id DESC LIMIT 20`, athlete.id)
    .map((h) => ({ ...h, done: parseDone(h.done).length }));
  return out;
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
      if (item_id == null && !noteVal) return { done: list, note: '' };
      logId = insert('workout_logs', { athlete_id: athlete.id, day_id: s.current.day_id, done: JSON.stringify(list), note: noteVal || null });
    } else {
      run('UPDATE workout_logs SET done=? WHERE id=?', JSON.stringify(list), logId);
      if (noteVal !== undefined) run('UPDATE workout_logs SET note=? WHERE id=?', noteVal || null, logId);
    }
    const row = get('SELECT done, note FROM workout_logs WHERE id=?', logId);
    return { done: parseDone(row.done), note: row.note || '' };
  });
}

function finish(athlete, { day_id, note }, ip) {
  const s = requireCurrent(athlete, day_id);
  const cur = s.current;
  const done = s.current.log.done.filter((id) => cur.items.some((i) => i.id === id));
  if (!done.length) throw bad('Log at least one exercise before you finish.');
  const name = `${athlete.first_name} ${athlete.last_name}`;
  tx(() => {
    const noteVal = note === undefined ? cur.log.note : String(note || '').slice(0, 2000);
    run("UPDATE workout_logs SET finished_at=datetime('now'), note=? WHERE id=?", noteVal || null, cur.log.id);
    insert('activity', { actor: `${name} (athlete)`, action: `Workout logged: ${name}, ${cur.title}`, detail: `${s.program.name} · week ${cur.week}, day ${cur.day} · ${done.length} of ${cur.items.length} exercises`, ip: ip || null, kind: 'change' });
  });
  const log = get('SELECT * FROM workout_logs WHERE id=?', cur.log.id);
  emit('workout.completed', {
    athlete_code: athlete.code, athlete: name, program: s.program.name, week: cur.week, day: cur.day, title: cur.title,
    exercises_done: done.length, exercises_total: cur.items.length, note: log.note || null, finished_at: log.finished_at,
  });
  const next = state(athlete);
  let nextUp = null;
  if (next.current) {
    const perWeek = all('SELECT COUNT(*) AS n FROM program_days WHERE program_id=? AND week=?', athlete.program_id, next.current.week)[0].n;
    nextUp = { week: next.current.week, day: next.current.day, title: next.current.title, ...suggestDay(perWeek) };
  }
  return { ok: true, finished: { week: cur.week, day: cur.day, title: cur.title, done: done.length, total: cur.items.length }, next_up: nextUp, state: next };
}

module.exports = { state, logItem, finish, programDays, dayItems, suggestDay, parseDone };
