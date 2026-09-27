// Programs, exercise library, program builder, assignment, and the athlete workout app API (/api/w/:token).
'use strict';
const { db, get, all, run, insert, update, tx } = require('../db');
const { h, bad, notFound, log, emit, today, randomToken, sendEmail, appUrl, businessName } = require('../lib');
const { requireStaff } = require('../auth');
const { cleanVideoUrl } = require('../services/ops-video');
const workout = require('../services/ops-workout');

const EDIT = requireStaff('owner', 'coach');
const VIEW = requireStaff();

// Exercise categories for filtering the library. Older databases get the column on start.
const CATEGORIES = ['Speed', 'Power', 'Lower body', 'Upper body', 'Core', 'Arm care', 'Mobility', 'Conditioning'];
if (!all('PRAGMA table_info(exercises)').some((c) => c.name === 'category')) db.exec('ALTER TABLE exercises ADD COLUMN category TEXT');

const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const intIn = (v, min, max, msg) => { const n = Number(v); if (v === '' || v === null || !Number.isInteger(n) || n < min || n > max) throw bad(msg); return n; };
const isBlank = (v) => v === undefined || v === null || v === '';
const weeksList = (ws) => ws.length === 1 ? `Week ${ws[0]} already has` : `Weeks ${ws.slice(0, -1).join(', ')} and ${ws[ws.length - 1]} already have`;
// Days since a UTC SQLite timestamp or a local YYYY-MM-DD date.
const daysSince = (s) => { if (!s) return null; const t = Date.parse(s.length <= 10 ? s + 'T12:00:00' : s.replace(' ', 'T') + 'Z'); return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 864e5)); };
const QUIET_DAYS = 7;

function programOr404(id) {
  const p = get('SELECT * FROM programs WHERE id=? AND archived=0', Number(id));
  if (!p) throw notFound('That program');
  return p;
}
function dayOr404(id) {
  const d = get('SELECT d.*, p.name AS program_name, p.weeks AS program_weeks FROM program_days d JOIN programs p ON p.id=d.program_id WHERE d.id=? AND p.archived=0', Number(id));
  if (!d) throw notFound('That workout');
  return d;
}
function itemOr404(id) {
  const i = get(`SELECT i.*, d.program_id, d.week, d.day, p.name AS program_name, e.name AS exercise_name FROM program_items i
    JOIN program_days d ON d.id=i.day_id JOIN programs p ON p.id=d.program_id JOIN exercises e ON e.id=i.exercise_id WHERE i.id=? AND p.archived=0`, Number(id));
  if (!i) throw notFound('That exercise');
  return i;
}
const exerciseOr400 = (id) => {
  const ex = isBlank(id) ? null : get('SELECT * FROM exercises WHERE id=?', Number(id));
  if (!ex) throw bad('Choose an exercise from the library.');
  return ex;
};
const athleteName = (a) => `${a.first_name} ${a.last_name}`;

// Progress for every client on a program (or on any program): workouts finished, last workout, what's next.
function clientProgress({ programId, athleteId } = {}) {
  const where = ['a.archived=0', 'p.archived=0'];
  const args = [];
  if (programId) { where.push('a.program_id=?'); args.push(programId); }
  if (athleteId) { where.push('a.id=?'); args.push(athleteId); }
  const rows = all(`SELECT a.id, a.code, a.first_name, a.last_name, a.program_id, a.program_started, a.workout_token, p.name AS program,
      (SELECT COUNT(*) FROM program_days d WHERE d.program_id=a.program_id) AS total_days,
      (SELECT COUNT(DISTINCT l.day_id) FROM workout_logs l JOIN program_days d ON d.id=l.day_id
        WHERE l.athlete_id=a.id AND d.program_id=a.program_id AND l.finished_at IS NOT NULL) AS finished_days,
      (SELECT MAX(l.finished_at) FROM workout_logs l JOIN program_days d ON d.id=l.day_id
        WHERE l.athlete_id=a.id AND d.program_id=a.program_id AND l.finished_at IS NOT NULL) AS last_workout_at
    FROM athletes a JOIN programs p ON p.id=a.program_id WHERE ${where.join(' AND ')} ORDER BY a.first_name, a.last_name`, ...args);
  const dayCache = {};
  return rows.map((r) => {
    const days = (dayCache[r.program_id] ||= workout.programDays(r.program_id));
    const done = new Set(all(`SELECT DISTINCT l.day_id FROM workout_logs l JOIN program_days d ON d.id=l.day_id
      WHERE l.athlete_id=? AND d.program_id=? AND l.finished_at IS NOT NULL`, r.id, r.program_id).map((x) => x.day_id));
    const next = days.find((d) => !done.has(d.id));
    const idle = daysSince(r.last_workout_at || r.program_started);
    const complete = r.total_days > 0 && !next;
    return { ...r, next: next ? { week: next.week, day: next.day, title: next.title || `Day ${next.day}` } : null,
      complete, days_idle: idle, quiet: !complete && r.total_days > 0 && idle != null && idle >= QUIET_DAYS };
  });
}

function programDetail(id) {
  const p = programOr404(id);
  const days = workout.programDays(p.id).map((d) => ({
    ...d, items: workout.dayItems(d.id),
    logs: get('SELECT COUNT(*) AS n FROM workout_logs WHERE day_id=?', d.id).n,
  }));
  const athletes = clientProgress({ programId: p.id });
  const maxWeek = days.reduce((m, d) => Math.max(m, d.week), 0);
  const logged7 = get(`SELECT COUNT(*) AS n FROM workout_logs l JOIN program_days d ON d.id=l.day_id
    WHERE d.program_id=? AND l.finished_at >= datetime('now','-7 days')`, p.id).n;
  return { ...p, weeks_shown: Math.max(p.weeks || 1, maxWeek), days, athletes, logged_7d: logged7 };
}

function cleanExercise(b) {
  const name = text(b.name, 80);
  if (!name) throw bad('Give the exercise a name.');
  const category = text(b.category, 40) || null;
  if (category && !CATEGORIES.includes(category)) throw bad(`Choose a category: ${CATEGORIES.join(', ')}.`);
  return { name, cues: text(b.cues, 500), video_url: cleanVideoUrl(b.video_url), category };
}
function cleanItem(b) {
  return { sets: text(b.sets, 20), reps: text(b.reps, 40), cue: text(b.cue, 300) };
}

// Remove workouts (and athlete logs of them) inside a transaction.
function deleteDays(ids) {
  for (const id of ids) {
    run('DELETE FROM workout_logs WHERE day_id=?', id);
    run('DELETE FROM program_items WHERE day_id=?', id);
    run('DELETE FROM program_days WHERE id=?', id);
  }
}
function copyDayInto(srcDayId, programId, week, day, title) {
  const nd = insert('program_days', { program_id: programId, week, day, title });
  run('INSERT INTO program_items (day_id, exercise_id, sets, reps, cue, ord) SELECT ?, exercise_id, sets, reps, cue, ord FROM program_items WHERE day_id=? ORDER BY ord, id', nd, srcDayId);
  return nd;
}
// A new program from an existing one: same workouts in the weeks kept.
function copyProgram(src, fields) {
  return tx(() => {
    const id = insert('programs', fields);
    for (const d of all('SELECT * FROM program_days WHERE program_id=? AND week<=? ORDER BY week, day', src.id, fields.weeks)) copyDayInto(d.id, id, d.week, d.day, d.title);
    return id;
  });
}

function workoutEmail(a, p, token) {
  const link = `${appUrl()}/w/${token}`;
  const to = a.email ? [a.email] : all('SELECT email FROM parents WHERE family_id=?', a.family_id || 0).map((r) => r.email);
  for (const email of to) {
    sendEmail(email, `${a.first_name}'s new program: ${p.name}`,
      `${a.first_name} is now on ${p.name}${p.level ? ` (${p.level})` : ''}.\n\nOpen the workout app on a phone to see each workout, the demo videos and to log what's done:\n${link}\n\nKeep this link private. It opens ${a.first_name}'s workouts without a password.\n\n${businessName()}`);
  }
  return { link, to };
}

function routes(api) {
  // ---- exercise library ----
  api.get('/exercises', VIEW, (_req, res) => {
    res.json(all(`SELECT e.*,
        (SELECT COUNT(*) FROM program_items i JOIN program_days d ON d.id=i.day_id JOIN programs p ON p.id=d.program_id WHERE i.exercise_id=e.id AND p.archived=0) AS uses,
        (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT DISTINCT p.name FROM program_items i JOIN program_days d ON d.id=i.day_id JOIN programs p ON p.id=d.program_id
          WHERE i.exercise_id=e.id AND p.archived=0 ORDER BY p.name)) AS used_in
      FROM exercises e ORDER BY e.name COLLATE NOCASE`));
  });
  api.get('/exercise-categories', VIEW, (_req, res) => res.json(CATEGORIES));
  api.post('/exercises', EDIT, h(async (req, res) => {
    const e = cleanExercise(req.body || {});
    if (get('SELECT 1 FROM exercises WHERE name=? COLLATE NOCASE', e.name)) throw bad(`${e.name} is already in the library.`);
    const id = insert('exercises', e);
    log(req, 'Added exercise', e.name);
    res.json(get('SELECT * FROM exercises WHERE id=?', id));
  }));
  api.put('/exercises/:id', EDIT, h(async (req, res) => {
    const cur = get('SELECT * FROM exercises WHERE id=?', Number(req.params.id));
    if (!cur) throw notFound('That exercise');
    const e = cleanExercise({ ...cur, ...req.body });
    if (get('SELECT 1 FROM exercises WHERE name=? COLLATE NOCASE AND id<>?', e.name, cur.id)) throw bad(`${e.name} is already in the library.`);
    update('exercises', cur.id, e);
    log(req, 'Updated exercise', e.name);
    res.json(get('SELECT * FROM exercises WHERE id=?', cur.id));
  }));
  api.delete('/exercises/:id', EDIT, h(async (req, res) => {
    const cur = get('SELECT * FROM exercises WHERE id=?', Number(req.params.id));
    if (!cur) throw notFound('That exercise');
    const uses = get(`SELECT COUNT(*) AS n FROM program_items i JOIN program_days d ON d.id=i.day_id JOIN programs p ON p.id=d.program_id
      WHERE i.exercise_id=? AND p.archived=0`, cur.id).n;
    if (uses) throw bad(`${cur.name} is used in ${uses} workout${uses === 1 ? '' : 's'}. Remove it from those first.`);
    tx(() => {
      // Deleted programs keep their workouts for athlete history; drop this exercise from them so it can go.
      run('DELETE FROM program_items WHERE exercise_id=?', cur.id);
      run('DELETE FROM exercises WHERE id=?', cur.id);
    });
    log(req, 'Deleted exercise', cur.name);
    res.json({ ok: true });
  }));

  // ---- programs ----
  api.get('/programs', VIEW, (_req, res) => {
    res.json(all(`SELECT p.*, (SELECT COUNT(*) FROM program_days d WHERE d.program_id=p.id) AS workouts,
      (SELECT COUNT(*) FROM athletes a WHERE a.program_id=p.id AND a.archived=0) AS clients,
      (SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM program_days d WHERE d.program_id=p.id GROUP BY d.week)) AS days_per_week,
      (SELECT COUNT(*) FROM workout_logs l JOIN program_days d ON d.id=l.day_id WHERE d.program_id=p.id AND l.finished_at >= datetime('now','-7 days')) AS logged_7d
      FROM programs p WHERE p.archived=0 ORDER BY p.name COLLATE NOCASE`));
  });
  api.post('/programs', EDIT, h(async (req, res) => {
    const b = req.body || {};
    const name = text(b.name, 80);
    if (!name) throw bad('Give the program a name.');
    const src = isBlank(b.copy_from) ? null : programOr404(b.copy_from);
    const weeks = intIn(b.weeks ?? src?.weeks ?? 4, 1, 52, 'Weeks must be between 1 and 52.');
    const fields = {
      name, weeks,
      level: (b.level !== undefined ? text(b.level, 40) : src?.level) || null,
      description: (b.description !== undefined && text(b.description, 500) ? text(b.description, 500) : src?.description) || null,
    };
    const id = src ? copyProgram(src, fields) : insert('programs', fields);
    log(req, src ? 'Copied program' : 'Created program', src ? `${src.name} → ${name}` : name);
    res.json({ id });
  }));
  api.get('/programs/activity', VIEW, (req, res) => {
    const pid = isBlank(req.query.program_id) ? null : Number(req.query.program_id);
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 60);
    const recent = all(`SELECT l.id, l.finished_at, l.done, l.note, d.week, d.day, d.title, p.id AS program_id, p.name AS program,
        a.id AS athlete_id, a.first_name, a.last_name, a.code, (SELECT COUNT(*) FROM program_items i WHERE i.day_id=d.id) AS total
      FROM workout_logs l JOIN program_days d ON d.id=l.day_id JOIN programs p ON p.id=d.program_id JOIN athletes a ON a.id=l.athlete_id
      WHERE l.finished_at IS NOT NULL AND l.finished_at >= datetime('now', ?) AND a.archived=0 ${pid ? 'AND p.id=?' : ''}
      ORDER BY l.finished_at DESC, l.id DESC LIMIT 40`, `-${days} days`, ...(pid ? [pid] : []))
      .map((r) => ({ ...r, done: workout.parseDone(r.done).length }));
    const progress = clientProgress({ programId: pid });
    const logged7 = get(`SELECT COUNT(*) AS n FROM workout_logs l JOIN program_days d ON d.id=l.day_id JOIN athletes a ON a.id=l.athlete_id
      WHERE a.archived=0 AND l.finished_at >= datetime('now','-7 days') ${pid ? 'AND d.program_id=?' : ''}`, ...(pid ? [pid] : [])).n;
    res.json({
      recent, logged_7d: logged7, on_programs: progress.length,
      quiet: progress.filter((a) => a.quiet).sort((x, y) => y.days_idle - x.days_idle),
      complete: progress.filter((a) => a.complete),
    });
  });
  api.get('/programs/:id', VIEW, (req, res) => res.json(programDetail(req.params.id)));
  api.put('/programs/:id', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) { patch.name = text(b.name, 80); if (!patch.name) throw bad('Give the program a name.'); }
    if (b.weeks !== undefined) {
      patch.weeks = intIn(b.weeks, 1, 52, 'Weeks must be between 1 and 52.');
      const last = get('SELECT MAX(week) AS w FROM program_days WHERE program_id=?', p.id).w || 0;
      if (patch.weeks < last) throw bad(`Week ${last} still has workouts. Delete week ${last} first, or keep ${last} weeks.`);
    }
    if (b.level !== undefined) patch.level = text(b.level, 40) || null;
    if (b.description !== undefined) patch.description = text(b.description, 500) || null;
    update('programs', p.id, patch);
    log(req, 'Updated program', patch.name || p.name);
    res.json(programDetail(p.id));
  }));
  api.post('/programs/:id/duplicate', EDIT, h(async (req, res) => {
    const src = programOr404(req.params.id);
    const name = text(req.body?.name, 80) || `${src.name} (copy)`.slice(0, 80);
    const last = get('SELECT MAX(week) AS w FROM program_days WHERE program_id=?', src.id).w || 0;
    const id = copyProgram(src, { name, weeks: Math.max(src.weeks || 1, last), level: src.level, description: src.description });
    log(req, 'Copied program', `${src.name} → ${name}`);
    res.json({ id });
  }));
  api.delete('/programs/:id', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const on = get('SELECT COUNT(*) AS n FROM athletes WHERE program_id=? AND archived=0', p.id).n;
    if (on) throw bad(`${on} client${on === 1 ? ' is' : 's are'} on this program. Move them to another program or remove them first.`);
    update('programs', p.id, { archived: 1 });
    log(req, 'Deleted program', p.name);
    res.json({ ok: true });
  }));

  // ---- days (workouts) ----
  api.post('/programs/:id/days', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const week = intIn(req.body.week, 1, 52, 'Choose a week between 1 and 52.');
    const next = get('SELECT COALESCE(MAX(day),0)+1 AS n FROM program_days WHERE program_id=? AND week=?', p.id, week).n;
    if (isBlank(req.body.day) && next > 7) throw bad(`Week ${week} already has 7 days.`);
    const day = isBlank(req.body.day) ? next : intIn(req.body.day, 1, 7, 'Choose a day between 1 and 7.');
    if (get('SELECT 1 FROM program_days WHERE program_id=? AND week=? AND day=?', p.id, week, day)) throw bad(`Week ${week} already has a day ${day}. Pick another day.`);
    const title = text(req.body.title, 60) || `Day ${day}`;
    const id = insert('program_days', { program_id: p.id, week, day, title });
    if (week > (p.weeks || 0)) update('programs', p.id, { weeks: week });
    log(req, 'Added workout', `${p.name}: week ${week}, day ${day} (${title})`);
    res.json({ id });
  }));
  api.put('/program-days/:id', EDIT, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const title = text(req.body.title, 60);
    if (!title) throw bad('Give the workout a title.');
    update('program_days', d.id, { title });
    log(req, 'Renamed workout', `${d.program_name}: week ${d.week}, day ${d.day} → ${title}`);
    res.json({ ok: true });
  }));
  api.delete('/program-days/:id', EDIT, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    tx(() => deleteDays([d.id]));
    log(req, 'Deleted workout', `${d.program_name}: week ${d.week}, day ${d.day} (${d.title || ''})`);
    res.json({ ok: true });
  }));
  // Copy one workout to another week (and day). Default: the next free day of that week.
  api.post('/program-days/:id/copy', EDIT, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const week = intIn(req.body?.week ?? d.week, 1, 52, 'Choose a week between 1 and 52.');
    const next = get('SELECT COALESCE(MAX(day),0)+1 AS n FROM program_days WHERE program_id=? AND week=?', d.program_id, week).n;
    if (isBlank(req.body?.day) && next > 7) throw bad(`Week ${week} already has 7 days.`);
    const day = isBlank(req.body?.day) ? next : intIn(req.body.day, 1, 7, 'Choose a day between 1 and 7.');
    if (get('SELECT 1 FROM program_days WHERE program_id=? AND week=? AND day=?', d.program_id, week, day)) throw bad(`Week ${week} already has a day ${day}. Pick another day.`);
    const title = text(req.body?.title, 60) || d.title || `Day ${day}`;
    const id = tx(() => {
      const nd = copyDayInto(d.id, d.program_id, week, day, title);
      if (week > (d.program_weeks || 0)) update('programs', d.program_id, { weeks: week });
      return nd;
    });
    log(req, 'Copied workout', `${d.program_name}: week ${d.week}, day ${d.day} → week ${week}, day ${day}`);
    res.json({ id, week, day });
  }));

  // Copy every workout in a week to another week (default: the next one), or to a run of weeks (to … through).
  api.post('/programs/:id/weeks/:week/copy', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const b = req.body || {};
    const from = intIn(Number(req.params.week), 1, 52, 'Choose a week to copy.');
    const to = intIn(b.to ?? from + 1, 1, 52, 'Weeks go up to 52.');
    const through = isBlank(b.through) ? to : intIn(b.through, to, 52, 'The last week must be on or after the first week, up to 52.');
    const targets = [];
    for (let w = to; w <= through; w++) if (w !== from) targets.push(w);
    if (!targets.length) throw bad('Choose a different week to copy to.');
    const src = all('SELECT * FROM program_days WHERE program_id=? AND week=? ORDER BY day', p.id, from);
    if (!src.length) throw bad(`Week ${from} has no workouts to copy.`);
    const taken = targets.filter((w) => get('SELECT 1 FROM program_days WHERE program_id=? AND week=?', p.id, w));
    if (taken.length && !b.replace) throw bad(`${weeksList(taken)} workouts. Replace them to copy.`, { needs_replace: true, weeks: taken });
    tx(() => {
      for (const w of targets) {
        deleteDays(all('SELECT id FROM program_days WHERE program_id=? AND week=?', p.id, w).map((r) => r.id));
        for (const d of src) copyDayInto(d.id, p.id, w, d.day, d.title);
      }
      if (through > (p.weeks || 0)) update('programs', p.id, { weeks: through });
    });
    log(req, 'Copied week', `${p.name}: week ${from} → week${targets.length > 1 ? `s ${targets[0]}–${targets[targets.length - 1]}` : ` ${targets[0]}`}`);
    res.json(programDetail(p.id));
  }));
  // Clear a week: removes its workouts (and athlete logs of them). The last week also comes off the program length.
  api.delete('/programs/:id/weeks/:week', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const week = intIn(Number(req.params.week), 1, 52, 'Choose a week.');
    const ids = all('SELECT id FROM program_days WHERE program_id=? AND week=?', p.id, week).map((r) => r.id);
    tx(() => {
      deleteDays(ids);
      const last = get('SELECT MAX(week) AS w FROM program_days WHERE program_id=?', p.id).w || 0;
      if (week >= (p.weeks || 1) && p.weeks > 1) update('programs', p.id, { weeks: Math.max(1, last, week - 1) });
    });
    log(req, 'Deleted week', `${p.name}: week ${week} (${ids.length} workout${ids.length === 1 ? '' : 's'})`);
    res.json(programDetail(p.id));
  }));

  // ---- items (exercises in a workout) ----
  api.post('/program-days/:id/items', EDIT, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const ex = exerciseOr400(req.body.exercise_id);
    const it = cleanItem(req.body);
    if (!it.sets && !it.reps) throw bad('Add sets and reps, like 3 and 10.');
    const list = all('SELECT id FROM program_items WHERE day_id=? ORDER BY ord, id', d.id).map((r) => r.id);
    const at = isBlank(req.body.position) ? list.length : Math.min(intIn(req.body.position, 0, 200, 'Choose where the exercise goes.'), list.length);
    const id = tx(() => {
      const nid = insert('program_items', { day_id: d.id, exercise_id: ex.id, ...it, ord: at });
      list.splice(at, 0, nid);
      list.forEach((x, n) => run('UPDATE program_items SET ord=? WHERE id=?', n, x));
      return nid;
    });
    log(req, 'Added exercise to workout', `${d.program_name}: week ${d.week}, day ${d.day}: ${ex.name}`);
    res.json({ id });
  }));
  api.put('/program-items/:id', EDIT, h(async (req, res) => {
    const i = itemOr404(req.params.id);
    const it = cleanItem({ ...i, ...req.body });
    if (!it.sets && !it.reps) throw bad('Add sets and reps, like 3 and 10.');
    let exName = i.exercise_name;
    if (!isBlank(req.body.exercise_id) && Number(req.body.exercise_id) !== i.exercise_id) {
      const ex = exerciseOr400(req.body.exercise_id);
      it.exercise_id = ex.id; exName = ex.name;
    }
    update('program_items', i.id, it);
    log(req, 'Updated exercise in workout', `${i.program_name}: week ${i.week}, day ${i.day}: ${exName !== i.exercise_name ? `${i.exercise_name} → ` : ''}${exName} ${[it.sets, it.reps].filter(Boolean).join(' × ')}`);
    res.json({ ok: true });
  }));
  api.delete('/program-items/:id', EDIT, h(async (req, res) => {
    const i = itemOr404(req.params.id);
    const position = all('SELECT id FROM program_items WHERE day_id=? ORDER BY ord, id', i.day_id).findIndex((r) => r.id === i.id);
    run('DELETE FROM program_items WHERE id=?', i.id);
    log(req, 'Removed exercise from workout', `${i.program_name}: week ${i.week}, day ${i.day}: ${i.exercise_name}`);
    // Enough to put it back (Undo).
    res.json({ ok: true, removed: { day_id: i.day_id, exercise_id: i.exercise_id, sets: i.sets, reps: i.reps, cue: i.cue, position } });
  }));
  api.post('/program-items/:id/move', EDIT, h(async (req, res) => {
    const i = itemOr404(req.params.id);
    const dir = Number(req.body.dir) < 0 ? -1 : 1;
    const list = all('SELECT id FROM program_items WHERE day_id=? ORDER BY ord, id', i.day_id).map((r) => r.id);
    const at = list.indexOf(i.id), to = at + dir;
    if (to >= 0 && to < list.length) {
      [list[at], list[to]] = [list[to], list[at]];
      tx(() => list.forEach((id, n) => run('UPDATE program_items SET ord=? WHERE id=?', n, id)));
    }
    res.json({ ok: true });
  }));

  // ---- assignment ----
  // Clients to assign, with the program each is on now (so moving someone is a clear choice).
  api.get('/programs/:id/candidates', EDIT, (req, res) => {
    programOr404(req.params.id);
    const q = `%${text(req.query.q, 80)}%`;
    res.json(all(`SELECT a.id, a.code, a.first_name, a.last_name, a.sport, a.program_id, p.name AS program
      FROM athletes a LEFT JOIN programs p ON p.id=a.program_id AND p.archived=0 LEFT JOIN families f ON f.id=a.family_id
      WHERE a.archived=0 AND (a.first_name || ' ' || a.last_name LIKE ? OR a.code LIKE ? OR a.email LIKE ? OR f.name LIKE ?)
      ORDER BY a.first_name, a.last_name LIMIT 20`, q, q, q, q));
  });
  api.post('/programs/:id/assign', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const a = get('SELECT * FROM athletes WHERE id=? AND archived=0', Number(req.body.athlete_id));
    if (!a) throw bad('Choose a client to assign.');
    const name = athleteName(a);
    if (a.program_id === p.id) throw bad(`${name} is already on ${p.name}. Use Send link to email the workout app again.`);
    const from = a.program_id ? get('SELECT name FROM programs WHERE id=? AND archived=0', a.program_id) : null;
    const token = a.workout_token || randomToken(12);
    const started = today();
    update('athletes', a.id, { program_id: p.id, program_started: started, workout_token: token });
    log(req, 'Assigned program', `${name} → ${p.name}${from ? ` (was on ${from.name})` : ''}`);
    const { link } = workoutEmail(a, p, token);
    emit('program.assigned', { athlete_code: a.code, athlete: name, program_id: p.id, program: p.name, started, workout_url: link });
    res.json({ ok: true, workout_url: `/w/${token}`, moved_from: from?.name || null });
  }));
  // Email the workout app link again. Any staff member can do this: it changes nothing.
  api.post('/programs/:id/send-link', VIEW, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const a = get('SELECT * FROM athletes WHERE id=? AND program_id=? AND archived=0', Number(req.body?.athlete_id), p.id);
    if (!a) throw bad("That client isn't on this program.");
    const token = a.workout_token || randomToken(12);
    if (!a.workout_token) update('athletes', a.id, { workout_token: token });
    const has = a.email || get('SELECT 1 FROM parents WHERE family_id=?', a.family_id || 0);
    if (!has) throw bad(`There's no email on file for ${athleteName(a)} or their parents. Add one on the client profile.`);
    const { to } = workoutEmail(a, p, token);
    log(req, 'Sent workout link', `${athleteName(a)}: ${p.name} → ${to.join(', ')}`);
    res.json({ ok: true, sent_to: to });
  }));
  api.post('/programs/:id/unassign', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const a = get('SELECT * FROM athletes WHERE id=? AND program_id=?', Number(req.body.athlete_id), p.id);
    if (!a) throw bad("That client isn't on this program.");
    update('athletes', a.id, { program_id: null, program_started: null });
    log(req, 'Removed from program', `${athleteName(a)} ← ${p.name}`);
    res.json({ ok: true });
  }));

  // ---- athlete workout app (no sign-in: the private token is the key) ----
  const byToken = (token) => {
    if (!/^[\w-]{8,64}$/.test(String(token || ''))) throw notFound('That workout link');
    const a = get('SELECT * FROM athletes WHERE workout_token=? AND archived=0', token);
    if (!a) throw notFound('That workout link');
    return a;
  };
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  api.get('/w/:token', (req, res) => { noStore(res); res.json(workout.state(byToken(req.params.token))); });
  api.post('/w/:token/log', h(async (req, res) => {
    noStore(res);
    const a = byToken(req.params.token);
    res.json(workout.logItem(a, req.body || {}));
  }));
  api.post('/w/:token/finish', h(async (req, res) => {
    noStore(res);
    const a = byToken(req.params.token);
    res.json(workout.finish(a, req.body || {}, req.ip));
  }));
}

module.exports = { routes };
