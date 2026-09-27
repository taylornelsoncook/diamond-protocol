// Athlete engagement: accountability (streaks, daily check-ins, weekly goals, coach messages),
// performance (test results, targets, peer rankings) and education (lessons, courses, assigned reading).
'use strict';
const { db, get, all, run, insert, update, tx, setting } = require('../db');
const { bad, notFound, addDays, ageOn, sendEmail, appUrl, businessName } = require('../lib');
const { todayLocal } = require('./booking');
const core = require('./testing-core');

db.exec(`
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES athletes(id), date TEXT NOT NULL,
  sleep_hours REAL, hydration INTEGER, soreness INTEGER, energy INTEGER, mood INTEGER, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), UNIQUE (athlete_id, date));
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY, athlete_id INTEGER REFERENCES athletes(id), team_id INTEGER REFERENCES team_contracts(id),
  title TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('workouts','sessions','checkins','custom')),
  target INTEGER NOT NULL, active INTEGER DEFAULT 1, created_by INTEGER REFERENCES staff(id), created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS goal_checks (goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE, athlete_id INTEGER NOT NULL REFERENCES athletes(id), date TEXT NOT NULL, PRIMARY KEY (goal_id, athlete_id, date));
CREATE TABLE IF NOT EXISTS coach_messages (
  id INTEGER PRIMARY KEY, athlete_id INTEGER REFERENCES athletes(id), team_id INTEGER REFERENCES team_contracts(id),
  staff_id INTEGER REFERENCES staff(id), body TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS message_reads (message_id INTEGER NOT NULL REFERENCES coach_messages(id) ON DELETE CASCADE, athlete_id INTEGER NOT NULL, read_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (message_id, athlete_id));
CREATE TABLE IF NOT EXISTS test_targets (
  id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES athletes(id), test_id INTEGER NOT NULL REFERENCES tests(id),
  target REAL NOT NULL, due_date TEXT, created_by INTEGER REFERENCES staff(id), created_at TEXT DEFAULT (datetime('now')), UNIQUE (athlete_id, test_id));
CREATE TABLE IF NOT EXISTS courses (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT, published INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, summary TEXT, body TEXT, video_url TEXT, minutes INTEGER,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL, ord INTEGER DEFAULT 0, published INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS lesson_progress (lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, athlete_id INTEGER NOT NULL REFERENCES athletes(id), completed_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (lesson_id, athlete_id));
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY, lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE, course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
  athlete_id INTEGER REFERENCES athletes(id), team_id INTEGER REFERENCES team_contracts(id), due_date TEXT,
  note TEXT, created_by INTEGER REFERENCES staff(id), created_at TEXT DEFAULT (datetime('now')));
`);

const SCALE = ['hydration', 'soreness', 'energy', 'mood']; // 1–5
const GOAL_KINDS = { workouts: 'Workouts', sessions: 'Sessions attended', checkins: 'Daily check-ins', custom: 'Custom' };

// ---- dates ----
// Weeks run Monday to Sunday.
function weekStart(date = todayLocal()) {
  const d = new Date(date + 'T12:00:00');
  return addDays(date, -((d.getDay() + 6) % 7));
}
const athleteRow = (id) => get('SELECT * FROM athletes WHERE id=? AND archived=0', id);

// Days the athlete trained: a finished workout or a checked-in session.
function activeDays(athleteId, from, to) {
  const rows = all(`SELECT substr(finished_at,1,10) AS d FROM workout_logs WHERE athlete_id=? AND finished_at IS NOT NULL AND substr(finished_at,1,10) BETWEEN ? AND ?
    UNION SELECT substr(e.starts_at,1,10) FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.checked_in_at IS NOT NULL AND substr(e.starts_at,1,10) BETWEEN ? AND ?`,
  athleteId, from, to, athleteId, from, to);
  return new Set(rows.map((r) => r.d));
}
function counts(athleteId, from, to) {
  return {
    workouts: get("SELECT COUNT(*) n FROM workout_logs WHERE athlete_id=? AND finished_at IS NOT NULL AND substr(finished_at,1,10) BETWEEN ? AND ?", athleteId, from, to).n,
    sessions: get('SELECT COUNT(*) n FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.checked_in_at IS NOT NULL AND substr(e.starts_at,1,10) BETWEEN ? AND ?', athleteId, from, to).n,
    checkins: get('SELECT COUNT(*) n FROM checkins WHERE athlete_id=? AND date BETWEEN ? AND ?', athleteId, from, to).n,
  };
}

// ---- check-ins ----
// A check-in needs attention when sleep is short, soreness high, or energy or mood low.
function flagsOf(c) {
  if (!c) return [];
  const f = [];
  if (c.sleep_hours != null && c.sleep_hours < 6) f.push(`Slept ${c.sleep_hours} hours`);
  if (c.soreness != null && c.soreness >= 4) f.push(`Soreness ${c.soreness} of 5`);
  if (c.energy != null && c.energy <= 2) f.push(`Energy ${c.energy} of 5`);
  if (c.mood != null && c.mood <= 2) f.push(`Mood ${c.mood} of 5`);
  if (c.hydration != null && c.hydration <= 2) f.push(`Hydration ${c.hydration} of 5`);
  return f;
}
function saveCheckin(athleteId, b = {}) {
  if (!athleteRow(athleteId)) throw notFound('That athlete');
  const row = { note: b.note ? String(b.note).trim().slice(0, 500) : null };
  if (b.sleep_hours !== undefined && b.sleep_hours !== '' && b.sleep_hours !== null) {
    const s = Number(b.sleep_hours);
    if (!(s >= 0 && s <= 16)) throw bad('Enter hours of sleep between 0 and 16.');
    row.sleep_hours = Math.round(s * 2) / 2;
  } else row.sleep_hours = null;
  for (const k of SCALE) {
    if (b[k] === undefined || b[k] === '' || b[k] === null) { row[k] = null; continue; }
    const v = Number(b[k]);
    if (!(Number.isInteger(v) && v >= 1 && v <= 5)) throw bad('Rate each one from 1 to 5.');
    row[k] = v;
  }
  if ([row.sleep_hours, ...SCALE.map((k) => row[k])].every((v) => v == null)) throw bad('Fill in at least one answer.');
  const date = todayLocal();
  const existing = get('SELECT id FROM checkins WHERE athlete_id=? AND date=?', athleteId, date);
  if (existing) update('checkins', existing.id, row); else insert('checkins', { athlete_id: athleteId, date, ...row });
  const c = get('SELECT * FROM checkins WHERE athlete_id=? AND date=?', athleteId, date);
  return { ...c, flags: flagsOf(c) };
}
function checkinStreak(athleteId) {
  const dates = new Set(all('SELECT date FROM checkins WHERE athlete_id=? AND date>=?', athleteId, addDays(todayLocal(), -400)).map((r) => r.date));
  let d = todayLocal();
  if (!dates.has(d)) d = addDays(d, -1); // today not done yet doesn't break the streak
  let n = 0;
  while (dates.has(d)) { n++; d = addDays(d, -1); }
  return n;
}
// Weeks in a row (ending this week or last) with at least 2 training days.
function activeWeekStreak(athleteId) {
  const thisWeek = weekStart();
  const days = activeDays(athleteId, addDays(thisWeek, -7 * 52), addDays(thisWeek, 6));
  const inWeek = (ws) => [...Array(7).keys()].filter((i) => days.has(addDays(ws, i))).length;
  let ws = inWeek(thisWeek) >= 2 ? thisWeek : addDays(thisWeek, -7);
  let n = 0;
  while (inWeek(ws) >= 2) { n++; ws = addDays(ws, -7); }
  return n;
}

// ---- goals ----
function goalsFor(athleteId) {
  const a = athleteRow(athleteId);
  const list = all(`SELECT * FROM goals WHERE active=1 AND (athlete_id=? OR (team_id IS NOT NULL AND team_id=?)) ORDER BY id`, athleteId, a?.team_id ?? -1);
  const ws = weekStart(), we = addDays(ws, 6);
  const c = counts(athleteId, ws, we);
  return list.map((g) => {
    const checks = g.kind === 'custom' ? all('SELECT date FROM goal_checks WHERE goal_id=? AND athlete_id=? AND date BETWEEN ? AND ?', g.id, athleteId, ws, we).map((r) => r.date) : [];
    const progress = g.kind === 'custom' ? checks.length : c[g.kind];
    return { id: g.id, title: g.title, kind: g.kind, kind_label: GOAL_KINDS[g.kind], target: g.target, progress, done: progress >= g.target,
      team: !!g.team_id, checked_today: checks.includes(todayLocal()), week_start: ws, week_end: we };
  });
}
function checkGoal(athleteId, goalId, done) {
  const g = get('SELECT * FROM goals WHERE id=? AND active=1', goalId);
  const a = athleteRow(athleteId);
  if (!g || !a || !(g.athlete_id === a.id || (g.team_id && g.team_id === a.team_id))) throw notFound('That goal');
  if (g.kind !== 'custom') throw bad('This goal counts itself from your training.');
  const d = todayLocal();
  if (done) run('INSERT OR IGNORE INTO goal_checks (goal_id, athlete_id, date) VALUES (?,?,?)', g.id, a.id, d);
  else run('DELETE FROM goal_checks WHERE goal_id=? AND athlete_id=? AND date=?', g.id, a.id, d);
  return goalsFor(a.id).find((x) => x.id === g.id);
}
function createGoal({ athlete_id = null, team_id = null, title, kind, target }, staffId) {
  if (!athlete_id && !team_id) throw bad('Choose an athlete or a team.');
  if (!GOAL_KINDS[kind]) throw bad('Choose what the goal counts.');
  const t = Number(target);
  if (!(Number.isInteger(t) && t >= 1 && t <= 14)) throw bad('Set a weekly target from 1 to 14.');
  const name = String(title || '').trim() || `${t} ${GOAL_KINDS[kind].toLowerCase()} a week`;
  return insert('goals', { athlete_id, team_id, title: name.slice(0, 120), kind, target: t, created_by: staffId });
}

// ---- messages ----
function messagesFor(athleteId, limit = 30) {
  const a = athleteRow(athleteId);
  return all(`SELECT m.id, m.body, m.created_at, m.team_id, s.name AS coach, (r.read_at IS NOT NULL) AS read
    FROM coach_messages m LEFT JOIN staff s ON s.id=m.staff_id LEFT JOIN message_reads r ON r.message_id=m.id AND r.athlete_id=?
    WHERE m.athlete_id=? OR (m.team_id IS NOT NULL AND m.team_id=?) ORDER BY m.id DESC LIMIT ?`, athleteId, athleteId, a?.team_id ?? -1, limit)
    .map((m) => ({ ...m, read: !!m.read, team: !!m.team_id }));
}
function markRead(athleteId) {
  for (const m of messagesFor(athleteId, 200).filter((x) => !x.read)) run('INSERT OR IGNORE INTO message_reads (message_id, athlete_id) VALUES (?,?)', m.id, athleteId);
}
function recipients(a) {
  const parents = a.family_id ? all('SELECT email FROM parents WHERE family_id=?', a.family_id).map((p) => p.email) : [];
  return [...new Set([a.email, ...parents].filter(Boolean))];
}
function notify(a, subject, body) {
  const link = a.family_id ? `${appUrl()}/parent` : a.workout_token ? `${appUrl()}/w/${a.workout_token}` : appUrl();
  for (const to of recipients(a)) sendEmail(to, subject, `${body}\n\nOpen it here: ${link}\n\n${businessName()}`);
}
function sendMessage({ athlete_id = null, team_id = null, body }, staff) {
  const text = String(body || '').trim();
  if (!text) throw bad('Write a message first.');
  if (text.length > 2000) throw bad('Keep messages under 2,000 characters.');
  if (!athlete_id && !team_id) throw bad('Choose an athlete or a team.');
  const id = insert('coach_messages', { athlete_id, team_id, staff_id: staff.id, body: text });
  const targets = athlete_id ? [athleteRow(athlete_id)].filter(Boolean) : all('SELECT * FROM athletes WHERE team_id=? AND archived=0', team_id);
  for (const a of targets) notify(a, `A note from ${staff.name.split(' ')[0]} at ${businessName()}`, `${staff.name.split(' ')[0]} wrote to ${a.first_name}:\n\n${text}`);
  return id;
}

// ---- performance ----
const AGE_BANDS = [[0, 9, '9 and under'], [10, 11, '10–11'], [12, 13, '12–13'], [14, 15, '14–15'], [16, 18, '16–18'], [19, 200, 'Adults']];
function band(age) { return AGE_BANDS.find(([lo, hi]) => age >= lo && age <= hi); }

// Best result per athlete for a test, among a set of athletes (shared days only when parent-facing).
function bestByAthlete(testId, ids, onlyShared) {
  if (!ids.length) return new Map();
  const t = get('SELECT lower_better FROM tests WHERE id=?', testId);
  const rows = all(`SELECT r.athlete_id, ${t.lower_better ? 'MIN' : 'MAX'}(r.value) AS best FROM results r LEFT JOIN testing_days d ON d.id=r.day_id
    WHERE r.test_id=? AND r.athlete_id IN (${ids.map(() => '?').join(',')}) ${onlyShared ? "AND (r.day_id IS NULL OR d.status='shared')" : ''} GROUP BY r.athlete_id`, testId, ...ids);
  return new Map(rows.map((r) => [r.athlete_id, r.best]));
}
function rankIn(group, testId, athleteId, lowerBetter, onlyShared) {
  const bests = bestByAthlete(testId, group.ids, onlyShared);
  if (bests.size < 4 || !bests.has(athleteId)) return null; // too few to be meaningful
  const mine = bests.get(athleteId);
  const vals = [...bests.values()];
  const better = vals.filter((v) => (lowerBetter ? v < mine : v > mine)).length;
  const beaten = vals.filter((v) => (lowerBetter ? v > mine : v < mine)).length;
  const ties = vals.length - better - beaten - 1; // others with the same best
  return { group: group.label, rank: better + 1, of: vals.length, percentile: Math.round(((beaten + ties / 2) / (vals.length - 1)) * 100) };
}
function rankings(a, tests, onlyShared) {
  if (!setting('rankings_enabled', false)) return null;
  const groups = [];
  const age = ageOn(a.birthday);
  if (age != null && a.sex) {
    const [lo, hi, label] = band(age);
    const ids = all('SELECT id, birthday FROM athletes WHERE archived=0 AND sex=? AND birthday IS NOT NULL', a.sex)
      .filter((x) => { const g = ageOn(x.birthday); return g >= lo && g <= hi; }).map((x) => x.id);
    groups.push({ label: `${a.sex === 'F' ? 'Girls' : 'Boys'} ${label}`.replace(/^(Girls|Boys) Adults$/, a.sex === 'F' ? 'Women' : 'Men'), ids });
  }
  if (a.team_id) {
    const team = get('SELECT team_name FROM team_contracts WHERE id=?', a.team_id);
    groups.push({ label: team?.team_name || 'Team', ids: all('SELECT id FROM athletes WHERE team_id=? AND archived=0', a.team_id).map((x) => x.id) });
  }
  groups.push({ label: `Everyone at ${require('../lib').businessName()}`, ids: all('SELECT id FROM athletes WHERE archived=0').map((x) => x.id) });
  const out = [];
  for (const t of tests.filter((x) => x.category !== 'Body')) {
    const ranks = groups.map((g) => rankIn(g, t.test_id, a.id, t.lower_better, onlyShared)).filter(Boolean);
    if (ranks.length) out.push({ test_id: t.test_id, test: t.name, unit: t.unit, best: t.best, ranks });
  }
  return out;
}
function targetsFor(athleteId, tests) {
  return all('SELECT tt.*, t.name, t.unit, t.lower_better FROM test_targets tt JOIN tests t ON t.id=tt.test_id WHERE tt.athlete_id=? ORDER BY t.name', athleteId).map((x) => {
    const r = tests.find((t) => t.test_id === x.test_id);
    const best = r?.best ?? null, first = r?.first ?? null;
    let pct = 0;
    if (best != null) {
      const reached = x.lower_better ? best <= x.target : best >= x.target;
      if (reached) pct = 100;
      else if (first != null && first !== x.target) pct = Math.max(0, Math.min(99, Math.round(((x.lower_better ? first - best : best - first) / Math.abs(x.target - first)) * 100)));
    }
    return { id: x.id, test_id: x.test_id, test: x.name, unit: x.unit, lower_better: !!x.lower_better, target: x.target, due_date: x.due_date, best, first, pct, reached: pct === 100,
      best_text: best != null ? core.fmtValue(best, x.unit) : null, target_text: core.fmtValue(x.target, x.unit) };
  });
}
function setTarget({ athlete_id, test_id, target, due_date }, staffId) {
  const t = get('SELECT * FROM tests WHERE id=?', test_id);
  if (!t || !athleteRow(athlete_id)) throw bad('Choose an athlete and a test.');
  const v = core.parseEntry(String(target), t.unit); // accepts 6'5" for inches and 1:05 for seconds
  if (!Number.isFinite(v) || v <= 0) throw bad(`Enter the target in ${t.unit}.`);
  run(`INSERT INTO test_targets (athlete_id, test_id, target, due_date, created_by) VALUES (?,?,?,?,?)
    ON CONFLICT(athlete_id, test_id) DO UPDATE SET target=excluded.target, due_date=excluded.due_date`, athlete_id, t.id, v, due_date || null, staffId);
  return get('SELECT id FROM test_targets WHERE athlete_id=? AND test_id=?', athlete_id, t.id).id;
}
function performance(athleteId, { view = 'staff' } = {}) {
  const a = athleteRow(athleteId);
  if (!a) throw notFound('That athlete');
  const visibility = setting('results_visibility', 'shared');
  const p = core.progress(a.id, view === 'staff' ? { view: 'staff' } : { view: 'parent', visibility });
  const onlyShared = view !== 'staff' && visibility !== 'immediate';
  return { ...p, targets: targetsFor(a.id, p.tests), rankings: rankings(a, p.tests, onlyShared), rankings_enabled: !!setting('rankings_enabled', false) };
}

// ---- education ----
const lessonRow = (l, doneSet) => ({ id: l.id, title: l.title, summary: l.summary, minutes: l.minutes, has_video: !!l.video_url, course_id: l.course_id, done: doneSet.has(l.id) });
function doneSet(athleteId) { return new Set(all('SELECT lesson_id FROM lesson_progress WHERE athlete_id=?', athleteId).map((r) => r.lesson_id)); }
function education(athleteId) {
  const a = athleteRow(athleteId);
  if (!a) throw notFound('That athlete');
  const done = doneSet(a.id);
  const lessons = all('SELECT * FROM lessons WHERE published=1 ORDER BY course_id, ord, id');
  const courses = all('SELECT * FROM courses WHERE published=1 ORDER BY id').map((c) => {
    const ls = lessons.filter((l) => l.course_id === c.id).map((l) => lessonRow(l, done));
    return { id: c.id, title: c.title, description: c.description, lessons: ls, done: ls.filter((l) => l.done).length, total: ls.length, complete: ls.length > 0 && ls.every((l) => l.done) };
  }).filter((c) => c.total > 0);
  const assigned = all(`SELECT * FROM assignments WHERE athlete_id=? OR (team_id IS NOT NULL AND team_id=?) ORDER BY COALESCE(due_date,'9999'), id`, a.id, a.team_id ?? -1).map((x) => {
    if (x.lesson_id) {
      const l = lessons.find((y) => y.id === x.lesson_id);
      if (!l) return null;
      return { id: x.id, type: 'lesson', lesson_id: l.id, title: l.title, due_date: x.due_date, note: x.note, done: done.has(l.id), overdue: !done.has(l.id) && x.due_date && x.due_date < todayLocal() };
    }
    const c = courses.find((y) => y.id === x.course_id);
    if (!c) return null;
    return { id: x.id, type: 'course', course_id: c.id, title: c.title, due_date: x.due_date, note: x.note, done: c.complete, progress: `${c.done} of ${c.total}`, overdue: !c.complete && x.due_date && x.due_date < todayLocal() };
  }).filter(Boolean);
  return { assigned, courses, lessons: lessons.filter((l) => !l.course_id).map((l) => lessonRow(l, done)), completed: done.size };
}
function lessonFor(athleteId, lessonId) {
  const l = get('SELECT * FROM lessons WHERE id=? AND published=1', lessonId);
  if (!l || !athleteRow(athleteId)) throw notFound('That lesson');
  const course = l.course_id ? get('SELECT id, title FROM courses WHERE id=?', l.course_id) : null;
  const siblings = l.course_id ? all('SELECT id, title FROM lessons WHERE course_id=? AND published=1 ORDER BY ord, id', l.course_id) : [];
  const i = siblings.findIndex((s) => s.id === l.id);
  return { id: l.id, title: l.title, summary: l.summary, body: l.body, video_url: l.video_url, minutes: l.minutes, course,
    done: !!get('SELECT 1 FROM lesson_progress WHERE lesson_id=? AND athlete_id=?', l.id, athleteId),
    next: i >= 0 ? siblings[i + 1] || null : null, position: i >= 0 ? { n: i + 1, of: siblings.length } : null };
}
function completeLesson(athleteId, lessonId, done = true) {
  if (!get('SELECT 1 FROM lessons WHERE id=? AND published=1', lessonId) || !athleteRow(athleteId)) throw notFound('That lesson');
  if (done) run('INSERT OR IGNORE INTO lesson_progress (lesson_id, athlete_id) VALUES (?,?)', lessonId, athleteId);
  else run('DELETE FROM lesson_progress WHERE lesson_id=? AND athlete_id=?', lessonId, athleteId);
  return lessonFor(athleteId, lessonId);
}
function assign({ lesson_id = null, course_id = null, athlete_id = null, team_id = null, due_date = null, note = null }, staff) {
  if (!lesson_id === !course_id) throw bad('Choose a lesson or a course.');
  if (!athlete_id === !team_id) throw bad('Choose an athlete or a team.');
  const item = lesson_id ? get('SELECT title FROM lessons WHERE id=?', lesson_id) : get('SELECT title FROM courses WHERE id=?', course_id);
  if (!item) throw notFound(lesson_id ? 'That lesson' : 'That course');
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) throw bad('Pick a due date.');
  const id = insert('assignments', { lesson_id, course_id, athlete_id, team_id, due_date: due_date || null, note: note ? String(note).slice(0, 500) : null, created_by: staff.id });
  const targets = athlete_id ? [athleteRow(athlete_id)].filter(Boolean) : all('SELECT * FROM athletes WHERE team_id=? AND archived=0', team_id);
  const due = due_date ? ` by ${new Date(due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : '';
  for (const a of targets) notify(a, `New ${lesson_id ? 'lesson' : 'course'} for ${a.first_name}: ${item.title}`, `${staff.name.split(' ')[0]} assigned "${item.title}" to ${a.first_name}${due}.${note ? `\n\n${note}` : ''}`);
  return id;
}

// ---- the three tabs, as the athlete (or their parent) sees them ----
function accountability(athleteId) {
  const a = athleteRow(athleteId);
  if (!a) throw notFound('That athlete');
  const T = todayLocal();
  const ws = weekStart(T);
  const from = addDays(T, -27);
  const days = activeDays(a.id, from, T);
  const checkinDates = new Set(all('SELECT date FROM checkins WHERE athlete_id=? AND date BETWEEN ? AND ?', a.id, from, T).map((r) => r.date));
  const calendar = [...Array(28).keys()].map((i) => { const d = addDays(from, i); return { date: d, trained: days.has(d), checked_in: checkinDates.has(d) }; });
  const today = get('SELECT * FROM checkins WHERE athlete_id=? AND date=?', a.id, T);
  const recent = all('SELECT * FROM checkins WHERE athlete_id=? ORDER BY date DESC LIMIT 7', a.id).map((c) => ({ ...c, flags: flagsOf(c) }));
  const monthStart = T.slice(0, 8) + '01';
  const messages = messagesFor(a.id);
  return {
    today: T, week_start: ws,
    streaks: { active_weeks: activeWeekStreak(a.id), checkin_days: checkinStreak(a.id) },
    this_week: counts(a.id, ws, addDays(ws, 6)), this_month: counts(a.id, monthStart, T),
    calendar, checkin_today: today ? { ...today, flags: flagsOf(today) } : null, recent_checkins: recent,
    goals: goalsFor(a.id), messages, unread: messages.filter((m) => !m.read).length,
  };
}

// Staff view for the client profile: trends and flags over 30 days plus everything the coach set.
function staffOverview(athleteId) {
  const a = athleteRow(athleteId);
  if (!a) throw notFound('That athlete');
  const acc = accountability(a.id);
  const checkins = all('SELECT * FROM checkins WHERE athlete_id=? AND date>=? ORDER BY date', a.id, addDays(todayLocal(), -29)).map((c) => ({ ...c, flags: flagsOf(c) }));
  const avg = (k) => { const v = checkins.map((c) => c[k]).filter((x) => x != null); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null; };
  const perf = performance(a.id, { view: 'staff' });
  const edu = education(a.id);
  return {
    ...acc, checkins, averages: { sleep_hours: avg('sleep_hours'), hydration: avg('hydration'), soreness: avg('soreness'), energy: avg('energy'), mood: avg('mood') },
    flagged: checkins.filter((c) => c.flags.length).reverse().slice(0, 5),
    targets: perf.targets, rankings: perf.rankings, tests: perf.tests.map((t) => ({ test_id: t.test_id, name: t.name, unit: t.unit, best: t.best })),
    education: { assigned: edu.assigned, completed: edu.completed },
  };
}

// Athletes whose latest check-in (last 2 days) needs attention, for Today.
function recentFlags() {
  const since = addDays(todayLocal(), -1);
  return all(`SELECT c.*, a.first_name, a.last_name FROM checkins c JOIN athletes a ON a.id=c.athlete_id WHERE c.date>=? AND a.archived=0 ORDER BY c.date DESC`, since)
    .map((c) => ({ athlete_id: c.athlete_id, name: `${c.first_name} ${c.last_name}`, date: c.date, flags: flagsOf(c) }))
    .filter((c, i, arr) => c.flags.length && arr.findIndex((x) => x.athlete_id === c.athlete_id) === i);
}

// Completion report for the Education screen.
function educationReport() {
  const lessons = all('SELECT l.*, (SELECT COUNT(*) FROM lesson_progress p WHERE p.lesson_id=l.id) AS completions FROM lessons l ORDER BY l.course_id, l.ord, l.id');
  const courses = all('SELECT * FROM courses ORDER BY id').map((c) => ({ ...c, lessons: lessons.filter((l) => l.course_id === c.id) }));
  const assignments = all(`SELECT x.*, l.title AS lesson_title, c.title AS course_title, a.first_name, a.last_name, t.team_name FROM assignments x
    LEFT JOIN lessons l ON l.id=x.lesson_id LEFT JOIN courses c ON c.id=x.course_id LEFT JOIN athletes a ON a.id=x.athlete_id LEFT JOIN team_contracts t ON t.id=x.team_id
    ORDER BY x.id DESC LIMIT 200`).map((x) => {
    const who = x.athlete_id ? [athleteRow(x.athlete_id)].filter(Boolean) : all('SELECT * FROM athletes WHERE team_id=? AND archived=0', x.team_id);
    const finished = who.filter((a) => {
      if (x.lesson_id) return !!get('SELECT 1 FROM lesson_progress WHERE lesson_id=? AND athlete_id=?', x.lesson_id, a.id);
      const ids = all('SELECT id FROM lessons WHERE course_id=? AND published=1', x.course_id).map((r) => r.id);
      return ids.length && ids.every((id) => get('SELECT 1 FROM lesson_progress WHERE lesson_id=? AND athlete_id=?', id, a.id));
    });
    return { id: x.id, title: x.lesson_title || x.course_title, type: x.lesson_id ? 'lesson' : 'course', lesson_id: x.lesson_id, course_id: x.course_id,
      assigned_to: x.athlete_id ? `${x.first_name} ${x.last_name}` : x.team_name, athlete_id: x.athlete_id, team_id: x.team_id, due_date: x.due_date, note: x.note,
      finished: finished.length, total: who.length, not_finished: who.filter((a) => !finished.includes(a)).map((a) => `${a.first_name} ${a.last_name}`).slice(0, 30) };
  });
  return { courses, lessons: lessons.filter((l) => !l.course_id), assignments };
}

module.exports = {
  GOAL_KINDS, weekStart, flagsOf, saveCheckin, checkinStreak, activeWeekStreak, goalsFor, checkGoal, createGoal, messagesFor, markRead, sendMessage,
  performance, targetsFor, setTarget, rankings, education, lessonFor, completeLesson, assign, accountability, staffOverview, recentFlags, educationReport, athleteRow,
};
