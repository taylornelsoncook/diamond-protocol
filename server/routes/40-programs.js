// Programs, exercise library, program builder, assignment, and the athlete workout app API (/api/w/:token).
'use strict';
const { get, all, run, insert, update, tx } = require('../db');
const { h, bad, notFound, log, emit, today, randomToken, sendEmail, appUrl, businessName } = require('../lib');
const { requireStaff } = require('../auth');
const { cleanVideoUrl } = require('../services/ops-video');
const workout = require('../services/ops-workout');

const EDIT = requireStaff('owner', 'coach');
const VIEW = requireStaff();

const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const intIn = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw bad(msg); return n; };

function programOr404(id) {
  const p = get('SELECT * FROM programs WHERE id=? AND archived=0', Number(id));
  if (!p) throw notFound('That program');
  return p;
}
function dayOr404(id) {
  const d = get('SELECT d.*, p.name AS program_name FROM program_days d JOIN programs p ON p.id=d.program_id WHERE d.id=?', Number(id));
  if (!d) throw notFound('That workout');
  return d;
}
function itemOr404(id) {
  const i = get('SELECT i.*, d.program_id FROM program_items i JOIN program_days d ON d.id=i.day_id WHERE i.id=?', Number(id));
  if (!i) throw notFound('That exercise');
  return i;
}

function programDetail(id) {
  const p = programOr404(id);
  const days = workout.programDays(p.id).map((d) => ({
    ...d, items: workout.dayItems(d.id),
    logs: get('SELECT COUNT(*) AS n FROM workout_logs WHERE day_id=?', d.id).n,
  }));
  const athletes = all(`SELECT id, code, first_name, last_name, program_started, workout_token FROM athletes
    WHERE program_id=? AND archived=0 ORDER BY first_name, last_name`, p.id);
  const maxWeek = days.reduce((m, d) => Math.max(m, d.week), 0);
  return { ...p, weeks_shown: Math.max(p.weeks || 1, maxWeek), days, athletes };
}

function cleanExercise(b) {
  const name = text(b.name, 80);
  if (!name) throw bad('Give the exercise a name.');
  return { name, cues: text(b.cues, 500), video_url: cleanVideoUrl(b.video_url) };
}
function cleanItem(b) {
  return { sets: text(b.sets, 20), reps: text(b.reps, 40), cue: text(b.cue, 300) };
}

function routes(api) {
  // ---- exercise library ----
  api.get('/exercises', VIEW, (_req, res) => {
    res.json(all(`SELECT e.*, (SELECT COUNT(*) FROM program_items i WHERE i.exercise_id=e.id) AS uses FROM exercises e ORDER BY e.name COLLATE NOCASE`));
  });
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
    const uses = get('SELECT COUNT(*) AS n FROM program_items WHERE exercise_id=?', cur.id).n;
    if (uses) throw bad(`${cur.name} is used in ${uses} workout${uses === 1 ? '' : 's'}. Remove it from those first.`);
    run('DELETE FROM exercises WHERE id=?', cur.id);
    log(req, 'Deleted exercise', cur.name);
    res.json({ ok: true });
  }));

  // ---- programs ----
  api.get('/programs', VIEW, (_req, res) => {
    res.json(all(`SELECT p.*, (SELECT COUNT(*) FROM program_days d WHERE d.program_id=p.id) AS workouts,
      (SELECT COUNT(*) FROM athletes a WHERE a.program_id=p.id AND a.archived=0) AS clients
      FROM programs p WHERE p.archived=0 ORDER BY p.name COLLATE NOCASE`));
  });
  api.post('/programs', EDIT, h(async (req, res) => {
    const name = text(req.body.name, 80);
    if (!name) throw bad('Give the program a name.');
    const weeks = intIn(req.body.weeks ?? 4, 1, 52, 'Weeks must be between 1 and 52.');
    const id = insert('programs', { name, weeks, level: text(req.body.level, 40) || null, description: text(req.body.description, 500) || null });
    log(req, 'Created program', name);
    res.json({ id });
  }));
  api.get('/programs/:id', VIEW, (req, res) => res.json(programDetail(req.params.id)));
  api.put('/programs/:id', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) { patch.name = text(b.name, 80); if (!patch.name) throw bad('Give the program a name.'); }
    if (b.weeks !== undefined) patch.weeks = intIn(b.weeks, 1, 52, 'Weeks must be between 1 and 52.');
    if (b.level !== undefined) patch.level = text(b.level, 40) || null;
    if (b.description !== undefined) patch.description = text(b.description, 500) || null;
    update('programs', p.id, patch);
    log(req, 'Updated program', patch.name || p.name);
    res.json(programDetail(p.id));
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
    const day = req.body.day === undefined || req.body.day === '' ? next : intIn(req.body.day, 1, 7, 'Choose a day between 1 and 7.');
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
    tx(() => {
      run('DELETE FROM workout_logs WHERE day_id=?', d.id);
      run('DELETE FROM program_items WHERE day_id=?', d.id);
      run('DELETE FROM program_days WHERE id=?', d.id);
    });
    log(req, 'Deleted workout', `${d.program_name}: week ${d.week}, day ${d.day} (${d.title || ''})`);
    res.json({ ok: true });
  }));

  // Copy every workout in a week to another week (default: the next one).
  api.post('/programs/:id/weeks/:week/copy', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const from = intIn(req.params.week, 1, 52, 'Choose a week to copy.');
    const to = intIn(req.body.to ?? from + 1, 1, 52, 'Weeks go up to 52.');
    if (to === from) throw bad('Choose a different week to copy to.');
    const src = all('SELECT * FROM program_days WHERE program_id=? AND week=? ORDER BY day', p.id, from);
    if (!src.length) throw bad(`Week ${from} has no workouts to copy.`);
    const existing = all('SELECT id FROM program_days WHERE program_id=? AND week=?', p.id, to);
    if (existing.length && !req.body.replace) throw bad(`Week ${to} already has workouts. Replace them to copy.`, { needs_replace: true });
    tx(() => {
      for (const d of existing) {
        run('DELETE FROM workout_logs WHERE day_id=?', d.id);
        run('DELETE FROM program_items WHERE day_id=?', d.id);
        run('DELETE FROM program_days WHERE id=?', d.id);
      }
      for (const d of src) {
        const nd = insert('program_days', { program_id: p.id, week: to, day: d.day, title: d.title });
        run('INSERT INTO program_items (day_id, exercise_id, sets, reps, cue, ord) SELECT ?, exercise_id, sets, reps, cue, ord FROM program_items WHERE day_id=?', nd, d.id);
      }
      if (to > (p.weeks || 0)) update('programs', p.id, { weeks: to });
    });
    log(req, 'Copied week', `${p.name}: week ${from} → week ${to}`);
    res.json(programDetail(p.id));
  }));

  // ---- items (exercises in a workout) ----
  api.post('/program-days/:id/items', EDIT, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const ex = get('SELECT * FROM exercises WHERE id=?', Number(req.body.exercise_id));
    if (!ex) throw bad('Choose an exercise from the library.');
    const it = cleanItem(req.body);
    if (!it.sets && !it.reps) throw bad('Add sets and reps, like 3 and 10.');
    const ord = get('SELECT COALESCE(MAX(ord),-1)+1 AS n FROM program_items WHERE day_id=?', d.id).n;
    const id = insert('program_items', { day_id: d.id, exercise_id: ex.id, ...it, ord });
    log(req, 'Added exercise to workout', `${d.program_name}: week ${d.week}, day ${d.day}: ${ex.name}`);
    res.json({ id });
  }));
  api.put('/program-items/:id', EDIT, h(async (req, res) => {
    const i = itemOr404(req.params.id);
    const it = cleanItem({ ...i, ...req.body });
    if (!it.sets && !it.reps) throw bad('Add sets and reps, like 3 and 10.');
    update('program_items', i.id, it);
    log(req, 'Updated exercise in workout', `${it.sets} × ${it.reps}`);
    res.json({ ok: true });
  }));
  api.delete('/program-items/:id', EDIT, h(async (req, res) => {
    const i = itemOr404(req.params.id);
    const ex = get('SELECT name FROM exercises WHERE id=?', i.exercise_id);
    run('DELETE FROM program_items WHERE id=?', i.id);
    log(req, 'Removed exercise from workout', ex?.name);
    res.json({ ok: true });
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
  api.post('/programs/:id/assign', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const a = get('SELECT * FROM athletes WHERE id=? AND archived=0', Number(req.body.athlete_id));
    if (!a) throw bad('Choose a client to assign.');
    const token = a.workout_token || randomToken(12);
    const started = today();
    update('athletes', a.id, { program_id: p.id, program_started: started, workout_token: token });
    const name = `${a.first_name} ${a.last_name}`;
    log(req, 'Assigned program', `${name} → ${p.name}`);
    const link = `${appUrl()}/w/${token}`;
    emit('program.assigned', { athlete_code: a.code, athlete: name, program_id: p.id, program: p.name, started, workout_url: link });
    // Let the athlete (or their parents) know where to find it.
    const to = a.email ? [a.email] : all('SELECT email FROM parents WHERE family_id=?', a.family_id || 0).map((r) => r.email);
    for (const email of to) {
      sendEmail(email, `${a.first_name}'s new program: ${p.name}`,
        `${a.first_name} is now on ${p.name}${p.level ? ` (${p.level})` : ''}.\n\nOpen the workout app on a phone to see each workout, the demo videos and to log what's done:\n${link}\n\nKeep this link private. It opens ${a.first_name}'s workouts without a password.\n\n${businessName()}`);
    }
    res.json({ ok: true, workout_url: `/w/${token}` });
  }));
  api.post('/programs/:id/unassign', EDIT, h(async (req, res) => {
    const p = programOr404(req.params.id);
    const a = get('SELECT * FROM athletes WHERE id=? AND program_id=?', Number(req.body.athlete_id), p.id);
    if (!a) throw bad("That client isn't on this program.");
    update('athletes', a.id, { program_id: null, program_started: null });
    log(req, 'Removed from program', `${a.first_name} ${a.last_name} ← ${p.name}`);
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
