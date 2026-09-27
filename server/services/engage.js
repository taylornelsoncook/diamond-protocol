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
CREATE TABLE IF NOT EXISTS lesson_views (lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, athlete_id INTEGER NOT NULL REFERENCES athletes(id), opened_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (lesson_id, athlete_id));
`);
// Added after launch: when a coach last sent a reminder for an assignment.
if (!all('PRAGMA table_info(assignments)').some((c) => c.name === 'reminded_at')) run('ALTER TABLE assignments ADD COLUMN reminded_at TEXT');
// Added later: athletes (or their parents) reply to a coach's message, and parents' reads are kept apart from the athlete's,
// so a parent opening the tab doesn't clear the athlete's "New" messages.
const hadParentReads = !!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='parent_message_reads'");
db.exec(`
CREATE TABLE IF NOT EXISTS message_replies (
  id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES coach_messages(id) ON DELETE CASCADE, athlete_id INTEGER NOT NULL REFERENCES athletes(id),
  parent_id INTEGER REFERENCES parents(id), body TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS message_replies_msg ON message_replies(message_id);
CREATE TABLE IF NOT EXISTS parent_message_reads (message_id INTEGER NOT NULL REFERENCES coach_messages(id) ON DELETE CASCADE, parent_id INTEGER NOT NULL, athlete_id INTEGER NOT NULL,
  read_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (message_id, parent_id, athlete_id));
`);
// Before parents had their own reads, a parent opening the tab wrote to message_reads. On upgrade, anything already read
// stays read for the family's parents, so they don't see every old message as new.
function backfillParentReads() {
  run(`INSERT OR IGNORE INTO parent_message_reads (message_id, parent_id, athlete_id, read_at)
    SELECT r.message_id, p.id, r.athlete_id, r.read_at FROM message_reads r JOIN athletes a ON a.id=r.athlete_id JOIN parents p ON p.family_id=a.family_id`);
}
if (!hadParentReads) backfillParentReads();

const SCALE = ['hydration', 'soreness', 'energy', 'mood']; // 1–5
const GOAL_KINDS = { workouts: 'Workouts', sessions: 'Sessions attended', checkins: 'Daily check-ins', custom: 'Custom' };

// ---- dates ----
// Weeks run Monday to Sunday.
function weekStart(date = todayLocal()) {
  const d = new Date(date + 'T12:00:00');
  return addDays(date, -((d.getDay() + 6) % 7));
}
const athleteRow = (id) => get('SELECT * FROM athletes WHERE id=? AND archived=0', id);

// Finished workouts between two local dates. finished_at is UTC, so each one is dated in the business time zone
// (a workout finished at 8pm in Provo belongs to that day, not to the next UTC day).
function localDater() {
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: setting('timezone', 'America/Denver'), year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  return (ts) => { const s = String(ts); const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z'); return Number.isNaN(d.getTime()) ? s.slice(0, 10) : fmt.format(d); };
}
function finishedWorkouts(athleteId, from, to) {
  const dateOf = localDater();
  return all(`SELECT w.finished_at, COALESCE(NULLIF(pd.title,''), 'Week ' || pd.week || ', day ' || pd.day) AS name FROM workout_logs w
    LEFT JOIN program_days pd ON pd.id=w.day_id WHERE w.athlete_id=? AND w.finished_at IS NOT NULL AND w.finished_at >= ? AND w.finished_at < ? ORDER BY w.finished_at`,
  athleteId, addDays(from, -1), addDays(to, 2)).map((r) => ({ d: dateOf(r.finished_at), name: r.name || 'Workout' })).filter((r) => r.d >= from && r.d <= to);
}
// Days the athlete trained: a finished workout or a checked-in session.
function activeDays(athleteId, from, to) {
  const rows = all('SELECT substr(e.starts_at,1,10) AS d FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.checked_in_at IS NOT NULL AND substr(e.starts_at,1,10) BETWEEN ? AND ?',
    athleteId, from, to);
  return new Set([...rows.map((r) => r.d), ...finishedWorkouts(athleteId, from, to).map((w) => w.d)]);
}
function counts(athleteId, from, to) {
  return {
    workouts: finishedWorkouts(athleteId, from, to).length,
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
// Longest run of check-in days in a row over the last year.
function bestCheckinStreak(athleteId) {
  const dates = all('SELECT date FROM checkins WHERE athlete_id=? AND date>=? ORDER BY date', athleteId, addDays(todayLocal(), -400)).map((r) => r.date);
  let best = 0, run_ = 0, prev = null;
  for (const d of dates) { run_ = prev && addDays(prev, 1) === d ? run_ + 1 : 1; best = Math.max(best, run_); prev = d; }
  return best;
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
// How far a goal got in one week (Monday start).
function goalProgress(g, athleteId, ws, weekCounts) {
  if (g.kind === 'custom') return get('SELECT COUNT(*) n FROM goal_checks WHERE goal_id=? AND athlete_id=? AND date BETWEEN ? AND ?', g.id, athleteId, ws, addDays(ws, 6)).n;
  return (weekCounts(ws))[g.kind];
}
function goalsFor(athleteId) {
  const a = athleteRow(athleteId);
  const list = all(`SELECT * FROM goals WHERE active=1 AND (athlete_id=? OR (team_id IS NOT NULL AND team_id=?)) ORDER BY id`, athleteId, a?.team_id ?? -1);
  const T = todayLocal();
  const ws = weekStart(T), we = addDays(ws, 6);
  const cache = new Map();
  const weekCounts = (w) => { if (!cache.has(w)) cache.set(w, counts(athleteId, w, addDays(w, 6))); return cache.get(w); };
  return list.map((g) => {
    const checks = g.kind === 'custom' ? all('SELECT date FROM goal_checks WHERE goal_id=? AND athlete_id=? AND date BETWEEN ? AND ?', g.id, athleteId, ws, we).map((r) => r.date) : [];
    const progress = g.kind === 'custom' ? checks.length : weekCounts(ws)[g.kind];
    // Earlier weeks since the goal was set: last week's result and how many weeks in a row it was met.
    const since = weekStart(String(g.created_at || T).slice(0, 10));
    let last_week = null, streak = 0;
    for (let w = addDays(ws, -7), i = 0; w >= since && i < 26; w = addDays(w, -7), i++) {
      const p = goalProgress(g, athleteId, w, weekCounts);
      if (i === 0) last_week = { progress: p, target: g.target, met: p >= g.target };
      if (p >= g.target) streak++; else break;
    }
    if (progress >= g.target) streak++;
    return { id: g.id, title: g.title, kind: g.kind, kind_label: GOAL_KINDS[g.kind], target: g.target, progress, done: progress >= g.target,
      team: !!g.team_id, checked_today: checks.includes(T), checked_days: checks.sort(), week_start: ws, week_end: we, last_week, streak };
  });
}
// Tick a custom goal for today, or for an earlier day this week that was missed.
function checkGoal(athleteId, goalId, done, date) {
  const g = get('SELECT * FROM goals WHERE id=? AND active=1', goalId);
  const a = athleteRow(athleteId);
  if (!g || !a || !(g.athlete_id === a.id || (g.team_id && g.team_id === a.team_id))) throw notFound('That goal');
  if (g.kind !== 'custom') throw bad('This goal counts itself from your training.');
  const T = todayLocal();
  const d = date == null || date === '' ? T : String(date);
  if (!isDate(d)) throw bad('Pick a day this week.');
  if (d > T) throw bad("You can't tick off a day that hasn't happened yet.");
  if (d < weekStart(T)) throw bad('Only days this week can be ticked off. Last week is done.');
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
// Messages to an athlete (and their team), newest first, each with this athlete's replies.
// `read` is the athlete's own read; a parent (parentId) gets their own read state instead.
function messagesFor(athleteId, limit = 30, { parentId = null } = {}) {
  const a = athleteRow(athleteId);
  const readJoin = parentId
    ? 'LEFT JOIN parent_message_reads r ON r.message_id=m.id AND r.athlete_id=? AND r.parent_id=?'
    : 'LEFT JOIN message_reads r ON r.message_id=m.id AND r.athlete_id=?';
  const list = all(`SELECT m.id, m.body, m.created_at, m.team_id, s.name AS coach, (r.read_at IS NOT NULL) AS read
    FROM coach_messages m LEFT JOIN staff s ON s.id=m.staff_id ${readJoin}
    WHERE m.athlete_id=? OR (m.team_id IS NOT NULL AND m.team_id=?) ORDER BY m.id DESC LIMIT ?`, ...(parentId ? [athleteId, parentId] : [athleteId]), athleteId, a?.team_id ?? -1, limit)
    .map((m) => ({ ...m, read: !!m.read, team: !!m.team_id, replies: [] }));
  if (list.length) {
    const byId = new Map(list.map((m) => [m.id, m]));
    const rows = all(`SELECT x.id, x.message_id, x.body, x.created_at, x.parent_id, p.name AS parent FROM message_replies x LEFT JOIN parents p ON p.id=x.parent_id
      WHERE x.athlete_id=? AND x.message_id IN (${list.map(() => '?').join(',')}) ORDER BY x.id`, athleteId, ...list.map((m) => m.id));
    for (const r of rows) byId.get(r.message_id)?.replies.push({ id: r.id, body: r.body, created_at: r.created_at, from: r.parent_id ? 'parent' : 'athlete', parent: r.parent || null });
  }
  return list;
}
function markRead(athleteId, { parentId = null } = {}) {
  for (const m of messagesFor(athleteId, 200, { parentId }).filter((x) => !x.read)) {
    if (parentId) run('INSERT OR IGNORE INTO parent_message_reads (message_id, parent_id, athlete_id) VALUES (?,?,?)', m.id, parentId, athleteId);
    else run('INSERT OR IGNORE INTO message_reads (message_id, athlete_id) VALUES (?,?)', m.id, athleteId);
  }
}
// The athlete (or a parent, on their behalf) answers a coach's message. The coach who wrote it gets an email.
const REPLY_DAILY_LIMIT = 20;
function replyToMessage(athleteId, messageId, body, { parent = null } = {}) {
  const a = athleteRow(athleteId);
  if (!a) throw notFound('That athlete');
  const m = get('SELECT m.*, s.name AS coach, s.email AS coach_email, s.active AS coach_active FROM coach_messages m LEFT JOIN staff s ON s.id=m.staff_id WHERE m.id=?', messageId);
  if (!m || !(m.athlete_id === a.id || (m.team_id && m.team_id === a.team_id))) throw notFound('That message');
  if (body != null && typeof body !== 'string') throw bad('Write a reply first.');
  const text = String(body || '').trim();
  if (!text) throw bad('Write a reply first.');
  if (text.length > 1000) throw bad('Keep replies under 1,000 characters.');
  if (get("SELECT COUNT(*) n FROM message_replies WHERE athlete_id=? AND created_at >= datetime('now','-1 day')", a.id).n >= REPLY_DAILY_LIMIT) {
    throw bad('That is a lot of replies for one day. Talk to your coach at your next session.');
  }
  const id = insert('message_replies', { message_id: m.id, athlete_id: a.id, parent_id: parent?.id || null, body: text });
  const who = parent ? `${parent.name} (${a.first_name} ${a.last_name}'s parent)` : `${a.first_name} ${a.last_name}`;
  const to = m.coach_email && m.coach_active ? m.coach_email : null;
  if (to) {
    const quoted = m.body.length > 300 ? `${m.body.slice(0, 300)}…` : m.body;
    sendEmail(to, `Reply from ${who}`, `${who} replied to your message:\n\n${text}\n\nYour message:\n${quoted}\n\nOpen their profile: ${appUrl()}/app/clients/${a.id}\n\n${businessName()}`);
  }
  return { id, who, emailed: !!to, coach: m.coach || null };
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
// How far a best result is from the target, in the test's unit ("3 in to go", "0.13 s to go").
function gapText(best, target, unit, lowerBetter) {
  if (best == null) return null;
  const gap = lowerBetter ? best - target : target - best;
  if (gap <= 0) return null;
  const n = Math.round(gap * 100) / 100;
  if (unit === 'in' && n >= 12) { const tenths = Math.round(n * 10), ft = Math.floor(tenths / 120), inch = (tenths - ft * 120) / 10; return inch ? `${ft} ft ${inch} in to go` : `${ft} ft to go`; }
  const u = unit === 's' ? 's' : unit === '%' ? '%' : unit === 'ratio' ? '' : unit;
  return `${Number.isInteger(n) ? n : n.toFixed(unit === 's' ? 2 : n < 1 ? 2 : 1)}${u ? (u === '%' ? '%' : ` ${u}`) : ''} to go`;
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
    const reached = pct === 100;
    return { id: x.id, test_id: x.test_id, test: x.name, unit: x.unit, lower_better: !!x.lower_better, target: x.target, due_date: x.due_date, best, first, pct, reached,
      best_text: best != null ? core.fmtValue(best, x.unit) : null, target_text: core.fmtValue(x.target, x.unit),
      to_go_text: reached ? null : gapText(best, x.target, x.unit, x.lower_better), overdue: !reached && !!x.due_date && x.due_date < todayLocal() };
  });
}
function setTarget({ athlete_id, test_id, target, due_date }, staffId) {
  const t = get('SELECT * FROM tests WHERE id=?', test_id);
  if (!t || !athleteRow(athlete_id)) throw bad('Choose an athlete and a test.');
  const v = core.parseEntry(String(target), t.unit); // accepts 6'5" for inches and 1:05 for seconds
  if (!Number.isFinite(v) || v <= 0) throw bad(`Enter the target in ${t.unit}.`);
  if (due_date != null && due_date !== '' && !isDate(due_date)) throw bad('Pick a date for the target, or leave it blank.');
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
// A real calendar date in YYYY-MM-DD form.
const isDate = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false; const x = new Date(`${d}T12:00:00Z`); return !Number.isNaN(x.getTime()) && x.toISOString().slice(0, 10) === d; };
const shortDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const firstName = (staff) => String(staff?.name || 'Your coach').split(' ')[0];

// What is being assigned: a published lesson, or a published course with at least one published lesson.
function assignable(lesson_id, course_id) {
  if (!lesson_id === !course_id) throw bad('Choose a lesson or a course.');
  if (lesson_id) {
    const l = get('SELECT id, title, published FROM lessons WHERE id=?', lesson_id);
    if (!l) throw notFound('That lesson');
    if (!l.published) throw bad('Publish that lesson before you assign it. Athletes only see published lessons.');
    return l;
  }
  const c = get('SELECT id, title, published FROM courses WHERE id=?', course_id);
  if (!c) throw notFound('That course');
  if (!c.published || !get('SELECT 1 FROM lessons WHERE course_id=? AND published=1', c.id)) throw bad('Publish the course and at least one of its lessons before you assign it.');
  return c;
}
function cleanDue(due_date) {
  if (due_date == null || due_date === '') return null;
  if (!isDate(due_date)) throw bad('Pick a due date.');
  return due_date;
}
const cleanNote = (note) => (note ? String(note).trim().slice(0, 500) || null : null);
const already = (lesson_id, course_id, col, id) => get(`SELECT id FROM assignments WHERE ${lesson_id ? 'lesson_id=?' : 'course_id=?'} AND ${col}=?`, lesson_id || course_id, id);

function assign({ lesson_id = null, course_id = null, athlete_id = null, team_id = null, due_date = null, note = null }, staff) {
  const item = assignable(lesson_id, course_id);
  if (!athlete_id === !team_id) throw bad('Choose an athlete or a team.');
  let targets, who;
  if (athlete_id) {
    const a = athleteRow(athlete_id);
    if (!a) throw notFound('That athlete');
    targets = [a]; who = `${a.first_name} ${a.last_name}`;
  } else {
    const t = get('SELECT * FROM team_contracts WHERE id=?', team_id);
    if (!t) throw notFound('That team');
    if (t.status !== 'active') throw bad(`${t.team_name}'s contract has ended. Assign it to the athletes one by one instead.`);
    targets = all('SELECT * FROM athletes WHERE team_id=? AND archived=0', team_id); who = t.team_name;
  }
  if (already(lesson_id, course_id, athlete_id ? 'athlete_id' : 'team_id', athlete_id || team_id)) throw bad(`${who} already has "${item.title}". Change the due date on that assignment instead.`);
  const due = cleanDue(due_date), text = cleanNote(note);
  const id = insert('assignments', { lesson_id, course_id, athlete_id, team_id, due_date: due, note: text, created_by: staff.id });
  const by = due ? ` by ${shortDate(due)}` : '';
  for (const a of targets) notify(a, `New ${lesson_id ? 'lesson' : 'course'} for ${a.first_name}: ${item.title}`, `${firstName(staff)} assigned "${item.title}" to ${a.first_name}${by}.${text ? `\n\n${text}` : ''}`);
  return id;
}
// Assign to several athletes at once. Athletes who already have it are skipped, not doubled up.
function assignMany({ athlete_ids = [], ...rest }, staff) {
  const ids = [...new Set((Array.isArray(athlete_ids) ? athlete_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw bad('Choose at least one athlete.');
  if (ids.length > 100) throw bad('Assign to 100 athletes or fewer at a time, or assign it to a team.');
  const item = assignable(rest.lesson_id, rest.course_id);
  cleanDue(rest.due_date);
  const athletes = ids.map((id) => athleteRow(id));
  if (athletes.some((a) => !a)) throw notFound('One of those athletes');
  const skipped = athletes.filter((a) => already(rest.lesson_id, rest.course_id, 'athlete_id', a.id));
  const todo = athletes.filter((a) => !skipped.includes(a));
  if (!todo.length) throw bad(skipped.length === 1 ? `${skipped[0].first_name} ${skipped[0].last_name} already has "${item.title}".` : `They all already have "${item.title}".`);
  const created = tx(() => todo.map((a) => assign({ ...rest, athlete_id: a.id, team_id: null }, staff)));
  return { ids: created, title: item.title, assigned: todo.map((a) => `${a.first_name} ${a.last_name}`), skipped: skipped.map((a) => `${a.first_name} ${a.last_name}`) };
}
function updateAssignment(id, b = {}) {
  const x = get('SELECT * FROM assignments WHERE id=?', id);
  if (!x) throw notFound('That assignment');
  const patch = {};
  if ('due_date' in b) patch.due_date = cleanDue(b.due_date);
  if ('note' in b) patch.note = cleanNote(b.note);
  if (Object.keys(patch).length) update('assignments', x.id, patch);
  return x;
}
// Someone opened a lesson (the athlete, or a parent reading it with them). First open is kept.
function recordView(athleteId, lessonId) {
  run('INSERT OR IGNORE INTO lesson_views (lesson_id, athlete_id) VALUES (?,?)', lessonId, athleteId);
}
function duplicateLesson(id) {
  const l = get('SELECT * FROM lessons WHERE id=?', id);
  if (!l) throw notFound('That lesson');
  const ord = l.course_id ? (get('SELECT MAX(ord) m FROM lessons WHERE course_id=?', l.course_id).m ?? -1) + 1 : 0;
  const title = `${l.title} (copy)`.slice(0, 120);
  return { id: insert('lessons', { title, summary: l.summary, body: l.body, video_url: l.video_url, minutes: l.minutes, course_id: l.course_id, ord, published: 0 }), title };
}

// ---- the three tabs, as the athlete (or their parent) sees them ----
// What happened on each day of a date range: finished workouts and attended sessions, by name.
function dayDetails(athleteId, from, to) {
  const out = new Map();
  const add = (d, k, v) => { if (!out.has(d)) out.set(d, { workouts: [], sessions: [] }); out.get(d)[k].push(v); };
  for (const w of finishedWorkouts(athleteId, from, to)) add(w.d, 'workouts', w.name);
  for (const r of all(`SELECT substr(e.starts_at,1,10) AS d, e.name FROM bookings b JOIN events e ON e.id=b.event_id
    WHERE b.athlete_id=? AND b.checked_in_at IS NOT NULL AND substr(e.starts_at,1,10) BETWEEN ? AND ? ORDER BY e.starts_at`, athleteId, from, to)) add(r.d, 'sessions', r.name);
  return out;
}
function accountability(athleteId, { parentId = null } = {}) {
  const a = athleteRow(athleteId);
  if (!a) throw notFound('That athlete');
  const T = todayLocal();
  const ws = weekStart(T);
  const from = addDays(T, -27);
  const days = activeDays(a.id, from, T);
  const details = dayDetails(a.id, from, T);
  const checkinRows = new Map(all('SELECT * FROM checkins WHERE athlete_id=? AND date BETWEEN ? AND ?', a.id, from, T).map((r) => [r.date, r]));
  const calendar = [...Array(28).keys()].map((i) => {
    const d = addDays(from, i); const c = checkinRows.get(d); const x = details.get(d) || { workouts: [], sessions: [] };
    return { date: d, trained: days.has(d), checked_in: !!c, workouts: x.workouts, sessions: x.sessions,
      checkin: c ? { sleep_hours: c.sleep_hours, hydration: c.hydration, soreness: c.soreness, energy: c.energy, mood: c.mood, flags: flagsOf(c) } : null };
  });
  const today = get('SELECT * FROM checkins WHERE athlete_id=? AND date=?', a.id, T);
  const recent = all('SELECT * FROM checkins WHERE athlete_id=? ORDER BY date DESC LIMIT 7', a.id).map((c) => ({ ...c, flags: flagsOf(c) }));
  const monthStart = T.slice(0, 8) + '01';
  const messages = messagesFor(a.id, 30, { parentId });
  return {
    today: T, week_start: ws,
    streaks: { active_weeks: activeWeekStreak(a.id), checkin_days: checkinStreak(a.id), checkin_best: bestCheckinStreak(a.id) },
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

// Everything needed to say who has finished what, loaded once: completions, opens, published course lessons, team rosters.
function progressContext() {
  const done = new Map(), seen = new Map();
  for (const r of all('SELECT lesson_id, athlete_id, completed_at FROM lesson_progress')) { if (!done.has(r.athlete_id)) done.set(r.athlete_id, new Map()); done.get(r.athlete_id).set(r.lesson_id, r.completed_at); }
  for (const r of all('SELECT lesson_id, athlete_id FROM lesson_views')) { if (!seen.has(r.athlete_id)) seen.set(r.athlete_id, new Set()); seen.get(r.athlete_id).add(r.lesson_id); }
  const courseLessons = new Map();
  for (const r of all('SELECT id, course_id FROM lessons WHERE published=1 AND course_id IS NOT NULL ORDER BY ord, id')) { if (!courseLessons.has(r.course_id)) courseLessons.set(r.course_id, []); courseLessons.get(r.course_id).push(r.id); }
  const rosters = new Map();
  for (const a of all('SELECT * FROM athletes WHERE team_id IS NOT NULL AND archived=0 ORDER BY last_name, first_name')) { if (!rosters.has(a.team_id)) rosters.set(a.team_id, []); rosters.get(a.team_id).push(a); }
  return { done, seen, courseLessons, rosters };
}
// Where one athlete is on one assignment: finished, started (opened or part way), or not started.
function personStatus(ctx, x, a) {
  const mine = ctx.done.get(a.id) || new Map(), opened = ctx.seen.get(a.id) || new Set();
  const base = { id: a.id, name: `${a.first_name} ${a.last_name}` };
  if (x.lesson_id) {
    const at = mine.get(x.lesson_id);
    return { ...base, status: at ? 'finished' : opened.has(x.lesson_id) ? 'started' : 'not_started', completed_at: at || null };
  }
  const ids = ctx.courseLessons.get(x.course_id) || [];
  const dates = ids.map((id) => mine.get(id)).filter(Boolean);
  const finished = ids.length > 0 && dates.length === ids.length;
  return { ...base, status: finished ? 'finished' : dates.length || ids.some((id) => opened.has(id)) ? 'started' : 'not_started',
    done: dates.length, of: ids.length, completed_at: finished ? dates.sort().at(-1) : null };
}
function assignmentView(ctx, x, T = todayLocal()) {
  const who = x.athlete_id ? [athleteRow(x.athlete_id)].filter(Boolean) : ctx.rosters.get(x.team_id) || [];
  const people = who.map((a) => personStatus(ctx, x, a));
  const finished = people.filter((p) => p.status === 'finished').length;
  const complete = people.length > 0 && finished === people.length;
  // Overdue only when someone can still read it: an archived athlete or an empty roster is never overdue.
  const status = complete ? 'finished' : people.length && x.due_date && x.due_date < T ? 'overdue' : 'open';
  const order = { not_started: 0, started: 1, finished: 2 };
  people.sort((p, q) => order[p.status] - order[q.status] || p.name.localeCompare(q.name));
  return {
    id: x.id, title: x.lesson_title || x.course_title, type: x.lesson_id ? 'lesson' : 'course', lesson_id: x.lesson_id, course_id: x.course_id,
    assigned_to: x.athlete_id ? (x.first_name ? `${x.first_name} ${x.last_name}` : null) : x.team_name, athlete_id: x.athlete_id, team_id: x.team_id,
    due_date: x.due_date, note: x.note, created_at: x.created_at, reminded_at: x.reminded_at || null, assigned_by: x.assigned_by || null,
    finished, total: people.length, started: people.filter((p) => p.status === 'started').length, status,
    not_finished: people.filter((p) => p.status !== 'finished').map((p) => p.name).slice(0, 30), people,
  };
}
const ASSIGNMENT_SQL = `SELECT x.*, l.title AS lesson_title, c.title AS course_title, a.first_name, a.last_name, t.team_name, s.name AS assigned_by FROM assignments x
  LEFT JOIN lessons l ON l.id=x.lesson_id LEFT JOIN courses c ON c.id=x.course_id LEFT JOIN athletes a ON a.id=x.athlete_id
  LEFT JOIN team_contracts t ON t.id=x.team_id LEFT JOIN staff s ON s.id=x.created_by`;

// Completion report for the Education screen.
function educationReport() {
  const T = todayLocal();
  const ctx = progressContext();
  const lessons = all(`SELECT l.*, (SELECT COUNT(*) FROM lesson_progress p WHERE p.lesson_id=l.id) AS completions,
      (SELECT COUNT(*) FROM lesson_views v WHERE v.lesson_id=l.id AND NOT EXISTS (SELECT 1 FROM lesson_progress p WHERE p.lesson_id=v.lesson_id AND p.athlete_id=v.athlete_id)) AS opened,
      (SELECT COUNT(*) FROM assignments x WHERE x.lesson_id=l.id) AS assigned
    FROM lessons l ORDER BY l.course_id, l.ord, l.id`);
  const courses = all('SELECT c.*, (SELECT COUNT(*) FROM assignments x WHERE x.course_id=c.id) AS assigned FROM courses c ORDER BY c.id').map((c) => {
    const ids = ctx.courseLessons.get(c.id) || [];
    const finishers = ids.length ? [...ctx.done.values()].filter((m) => ids.every((id) => m.has(id))).length : 0;
    return { ...c, finishers, lessons: lessons.filter((l) => l.course_id === c.id) };
  });
  const assignments = all(`${ASSIGNMENT_SQL} ORDER BY x.id DESC LIMIT 500`).map((x) => assignmentView(ctx, x, T));
  const recent = all(`SELECT p.completed_at, p.athlete_id, a.first_name || ' ' || a.last_name AS name, l.id AS lesson_id, l.title, c.title AS course
    FROM lesson_progress p JOIN athletes a ON a.id=p.athlete_id AND a.archived=0 JOIN lessons l ON l.id=p.lesson_id LEFT JOIN courses c ON c.id=l.course_id
    ORDER BY p.completed_at DESC, p.rowid DESC LIMIT 40`);
  const stats = {
    open: assignments.filter((x) => x.status !== 'finished').length,
    overdue: assignments.filter((x) => x.status === 'overdue').length,
    finished: assignments.filter((x) => x.status === 'finished').length,
    finished_week: get("SELECT COUNT(*) n FROM lesson_progress p JOIN athletes a ON a.id=p.athlete_id AND a.archived=0 WHERE p.completed_at >= datetime('now','-7 days')").n,
    readers_week: get("SELECT COUNT(DISTINCT p.athlete_id) n FROM lesson_progress p JOIN athletes a ON a.id=p.athlete_id AND a.archived=0 WHERE p.completed_at >= datetime('now','-7 days')").n,
    published: lessons.filter((l) => l.published).length, drafts: lessons.filter((l) => !l.published).length,
  };
  return { courses, lessons: lessons.filter((l) => !l.course_id), assignments, recent, stats, today: T };
}

// Who finished one lesson, who opened it but hasn't finished, and where it is assigned.
function lessonProgress(lessonId) {
  const l = get('SELECT l.*, c.title AS course FROM lessons l LEFT JOIN courses c ON c.id=l.course_id WHERE l.id=?', lessonId);
  if (!l) throw notFound('That lesson');
  const finished = all(`SELECT a.id AS athlete_id, a.first_name || ' ' || a.last_name AS name, p.completed_at FROM lesson_progress p JOIN athletes a ON a.id=p.athlete_id AND a.archived=0
    WHERE p.lesson_id=? ORDER BY p.completed_at DESC`, l.id);
  const opened = all(`SELECT a.id AS athlete_id, a.first_name || ' ' || a.last_name AS name, v.opened_at FROM lesson_views v JOIN athletes a ON a.id=v.athlete_id AND a.archived=0
    WHERE v.lesson_id=? AND NOT EXISTS (SELECT 1 FROM lesson_progress p WHERE p.lesson_id=v.lesson_id AND p.athlete_id=v.athlete_id) ORDER BY v.opened_at DESC`, l.id);
  const assignments = all(`SELECT x.id, x.due_date, COALESCE(a.first_name || ' ' || a.last_name, t.team_name) AS assigned_to, x.athlete_id, x.team_id FROM assignments x
    LEFT JOIN athletes a ON a.id=x.athlete_id LEFT JOIN team_contracts t ON t.id=x.team_id WHERE x.lesson_id=? OR (x.course_id IS NOT NULL AND x.course_id=?) ORDER BY x.id DESC`, l.id, l.course_id ?? -1);
  return { id: l.id, title: l.title, course: l.course, published: !!l.published, finished, opened, assignments };
}

// Email everyone on an assignment who hasn't finished it. At most once every 12 hours per assignment.
const REMIND_GAP = '-12 hours';
function remindAssignment(id, staff, ctx = progressContext()) {
  const x = get(`${ASSIGNMENT_SQL} WHERE x.id=?`, id);
  if (!x) throw notFound('That assignment');
  if (x.reminded_at && get('SELECT ? > datetime(\'now\', ?) AS recent', x.reminded_at, REMIND_GAP).recent) throw bad('A reminder went out less than 12 hours ago. Give them time to read it.');
  const v = assignmentView(ctx, x);
  const todo = v.people.filter((p) => p.status !== 'finished');
  if (!v.people.length) throw bad('Nobody on this assignment can be reminded. The athlete is archived or the roster is empty.');
  if (!todo.length) throw bad('Everyone has finished it. There is nobody to remind.');
  const T = todayLocal();
  for (const p of todo) {
    const a = athleteRow(p.id);
    const progress = v.type === 'course' && p.done ? ` (${p.done} of ${p.of} lessons done)` : '';
    const due = x.due_date ? (x.due_date < T ? ` It was due ${shortDate(x.due_date)}.` : ` It's due ${shortDate(x.due_date)}.`) : '';
    notify(a, `Reminder for ${a.first_name}: ${v.title}`, `${firstName(staff)} is checking in: ${a.first_name} hasn't finished "${v.title}" yet${progress}.${due}${x.note ? `\n\n${x.note}` : ''}`);
  }
  run("UPDATE assignments SET reminded_at=datetime('now') WHERE id=?", x.id);
  return { sent: todo.length, names: todo.map((p) => p.name), title: v.title };
}
// Remind every overdue assignment that hasn't had a reminder in the last 12 hours.
function remindOverdue(staff) {
  const T = todayLocal();
  const ctx = progressContext();
  const due = all(`${ASSIGNMENT_SQL} WHERE x.due_date IS NOT NULL AND x.due_date < ? AND (x.reminded_at IS NULL OR x.reminded_at <= datetime('now', ?))`, T, REMIND_GAP)
    .filter((x) => { const v = assignmentView(ctx, x, T); return v.status === 'overdue' && v.people.some((p) => p.status !== 'finished'); });
  let athletes = 0;
  for (const x of due) athletes += remindAssignment(x.id, staff, ctx).sent;
  return { assignments: due.length, athletes };
}

module.exports = {
  GOAL_KINDS, weekStart, flagsOf, saveCheckin, checkinStreak, activeWeekStreak, goalsFor, checkGoal, createGoal, messagesFor, markRead, sendMessage,
  performance, targetsFor, setTarget, replyToMessage, bestCheckinStreak, gapText, rankings, education, lessonFor, completeLesson, assign, accountability, staffOverview, recentFlags, educationReport, athleteRow,
  assignMany, updateAssignment, recordView, duplicateLesson, lessonProgress, remindAssignment, remindOverdue, isDate, backfillParentReads,
};
