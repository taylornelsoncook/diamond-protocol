// Athlete engagement: accountability (daily check-ins, streaks, weekly goals, coach messages),
// performance (test targets and opt-in rankings, on top of the testing results) and education
// (lessons, courses, assigned reading). Athletes are clients; a team is a contract's roster, and
// team goals, messages and reading reach its roster athletes (every one has a client profile).
import { newId, token, v, notFound, badRequest, conflict, localDate, zonedToUtc, addDaysToDate, weekdayOf, ageOn, isDate, HttpError } from '../util.js';
import { updateSettings, getSetting } from './families.js';
import { sendEmail, notifyFamily } from './mail.js';
import { athleteProfile, getTest, parentFilter } from './performance.js';
import { emit } from './events.js';

const SCALES = ['hydration', 'soreness', 'energy', 'mood'];           // 1 to 5
export const GOAL_KINDS = { workouts: 'Workouts', sessions: 'Sessions attended', checkins: 'Daily check-ins', custom: 'Custom' };

// ---------- Dates (business time zone) ----------
const zone = (ctx) => getSetting(ctx, 'timezone');
export const today = (ctx) => localDate(ctx.now(), zone(ctx));
// Weeks run Monday to Sunday.
export const weekStart = (date) => addDaysToDate(date, -((weekdayOf(date) + 6) % 7));
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function clientRow(ctx, id) {
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', id);
  if (!c) throw notFound('Athlete');
  return c;
}
const firstName = (c) => String(c.name ?? '').split(' ')[0];
// Active team rosters an athlete is on (a roster row linked to their client record).
const teamsOf = (ctx, clientId) => ctx.db.all('SELECT DISTINCT contract_id FROM team_roster WHERE client_id = ? AND active = 1', clientId).map((r) => r.contract_id);
const inList = (ids) => (ids.length ? ids.map(() => '?').join(', ') : 'NULL');
// Athletes a team goal, message or assignment reaches: clients on the active roster.
const rosterClients = (ctx, contractId) => ctx.db.all(`SELECT DISTINCT c.* FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.contract_id = ? AND r.active = 1 AND c.archived_at IS NULL ORDER BY c.name`, contractId);
function teamRow(ctx, id) {
  const t = ctx.db.get('SELECT t.id, t.name, o.name AS org_name FROM team_contracts t JOIN organizations o ON o.id = t.org_id WHERE t.id = ?', id);
  if (!t) throw notFound('Team');
  return t;
}
const teamLabel = (t) => `${t.org_name} ${t.name}`;

// Training: finished workouts plus sessions attended (booked classes, walk-in check-ins, team sessions),
// each with the local date it happened on.
function training(ctx, clientId, from, to) {
  const tz = zone(ctx), lo = zonedToUtc(from, '00:00', tz), hi = zonedToUtc(addDaysToDate(to, 1), '00:00', tz);
  const rows = [
    ...ctx.db.all('SELECT completed_at AS at FROM workout_logs WHERE client_id = ? AND completed_at >= ? AND completed_at < ?', clientId, lo, hi).map((r) => ({ kind: 'workouts', at: r.at })),
    ...ctx.db.all(`SELECT s.starts_at AS at FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.status = 'attended' AND s.starts_at >= ? AND s.starts_at < ?`, clientId, lo, hi).map((r) => ({ kind: 'sessions', at: r.at })),
    ...ctx.db.all('SELECT created_at AS at FROM check_ins WHERE client_id = ? AND created_at >= ? AND created_at < ?', clientId, lo, hi).map((r) => ({ kind: 'sessions', at: r.at })),
    ...ctx.db.all(`SELECT s.starts_at AS at FROM team_attendance a JOIN class_sessions s ON s.id = a.session_id WHERE a.client_id = ? AND s.starts_at >= ? AND s.starts_at < ?`, clientId, lo, hi).map((r) => ({ kind: 'sessions', at: r.at }))
  ];
  return rows.map((r) => ({ kind: r.kind, date: localDate(r.at, tz) }));
}
const trainingDays = (ctx, clientId, from, to) => new Set(training(ctx, clientId, from, to).map((r) => r.date));
function counts(ctx, clientId, from, to) {
  const t = training(ctx, clientId, from, to);
  return {
    workouts: t.filter((r) => r.kind === 'workouts').length,
    sessions: t.filter((r) => r.kind === 'sessions').length,
    checkins: ctx.db.get('SELECT COUNT(*) AS n FROM daily_checkins WHERE client_id = ? AND date BETWEEN ? AND ?', clientId, from, to).n
  };
}

// ---------- Daily check-ins ----------
// A check-in needs a look when sleep is short, soreness high, or energy, mood or hydration low.
export function flagsOf(c) {
  if (!c) return [];
  const f = [];
  if (c.sleep_hours != null && c.sleep_hours < 6) f.push(`Slept ${c.sleep_hours} hours`);
  if (c.soreness != null && c.soreness >= 4) f.push(`Soreness ${c.soreness} of 5`);
  if (c.energy != null && c.energy <= 2) f.push(`Energy ${c.energy} of 5`);
  if (c.mood != null && c.mood <= 2) f.push(`Mood ${c.mood} of 5`);
  if (c.hydration != null && c.hydration <= 2) f.push(`Hydration ${c.hydration} of 5`);
  return f;
}
// The owner's readiness rules (Programs → Hours & settings): how much comes off on a lighter or an easy day, and what
// the wearable's numbers have to look like to count.
export const DEFAULT_RULES = { yellow_drop: 10, red_drop: 20, red_sets: 1, recovery_yellow: 50, recovery_red: 34, sleep_yellow_min: 360, sleep_red_min: 300, hrv_drop_pct: 20, wearable: true };
export function readinessRules(ctx) {
  const n = (k, d) => { const x = Number(getSetting(ctx, k)); return Number.isFinite(x) ? x : d; };
  return { yellow_drop: n('readiness_yellow_drop', 10), red_drop: n('readiness_red_drop', 20), red_sets: n('readiness_red_sets', 1), recovery_yellow: n('readiness_recovery_yellow', 50), recovery_red: n('readiness_recovery_red', 34),
    sleep_yellow_min: n('readiness_sleep_yellow_min', 360), sleep_red_min: n('readiness_sleep_red_min', 300), hrv_drop_pct: n('readiness_hrv_drop_pct', 20), wearable: getSetting(ctx, 'readiness_wearable') !== 'off' };
}
// What the athlete's wearable saw for a day (from athlete_metrics, whether pulled or imported): recovery or readiness
// score, sleep, and HRV against their own 30-day average. A WHOOP day is the morning they woke up, so today's row is
// last night. Null when nothing is on file for the day.
export function wearableDay(ctx, clientId, day) {
  const rows = ctx.db.all(`SELECT metric, value, source FROM athlete_metrics WHERE client_id = ? AND day = ? AND metric IN ('recovery_pct', 'readiness_pct', 'sleep_min', 'hrv_ms')`, clientId, day);
  if (!rows.length) return null;
  const get = (m) => rows.find((r) => r.metric === m) ?? null;
  const rec = get('recovery_pct') ?? get('readiness_pct');
  const src = (r) => (r ? /oura/i.test(r.source) ? 'Oura' : /whoop/i.test(r.source) ? 'WHOOP' : /apple/i.test(r.source) ? 'Apple Watch' : /fitbit/i.test(r.source) ? 'Fitbit' : /garmin/i.test(r.source) ? 'Garmin' : 'wearable' : null);
  const hrv = get('hrv_ms');
  const avg = hrv ? ctx.db.get(`SELECT AVG(value) AS a, COUNT(*) AS n FROM athlete_metrics WHERE client_id = ? AND metric = 'hrv_ms' AND day < ? AND day >= date(?, '-30 days')`, clientId, day, day) : null;
  return { day, recovery: rec ? rec.value : null, recovery_kind: rec ? (rec.metric === 'readiness_pct' ? 'Readiness' : 'Recovery') : null, sleep_min: get('sleep_min')?.value ?? null, hrv: hrv?.value ?? null,
    hrv_avg: avg && avg.n >= 7 ? Math.round(avg.a * 10) / 10 : null, source: src(rec ?? get('sleep_min') ?? hrv) };
}
const hm = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
// Readiness from the check-in and the wearable together, under the rules: train as written, go a little lighter, or
// take it easy. reasons say why (each with where it came from); the athlete and coach both see them.
export function readinessFrom(c, wear, rules = DEFAULT_RULES) {
  if (!c && !wear) return null;
  const reasons = flagsOf(c), hard = [];
  if (c && ((c.sleep_hours != null && c.sleep_hours < 5) || c.soreness === 5)) hard.push('check-in');
  const sources = [];
  if (c) sources.push('your check-in');
  if (wear && rules.wearable) {
    const w = wear.source ?? 'wearable';
    sources.push(`your ${w}`);
    if (wear.recovery != null && wear.recovery < rules.recovery_yellow) { reasons.push(`${wear.recovery_kind} ${Math.round(wear.recovery)}% (${w})`); if (wear.recovery < rules.recovery_red) hard.push('recovery'); }
    // The athlete's own sleep answer speaks for the night; the band's sleep counts only when the check-in has none.
    if (wear.sleep_min != null && wear.sleep_min < rules.sleep_yellow_min && !(c && c.sleep_hours != null)) { reasons.push(`Slept ${hm(wear.sleep_min)} (${w})`); if (wear.sleep_min < rules.sleep_red_min) hard.push('sleep'); }
    if (rules.hrv_drop_pct && wear.hrv != null && wear.hrv_avg && wear.hrv < wear.hrv_avg * (1 - rules.hrv_drop_pct / 100)) reasons.push(`HRV ${Math.round(wear.hrv)} ms, ${Math.round((1 - wear.hrv / wear.hrv_avg) * 100)}% under your usual (${w})`);
  }
  const from = sources.join(' and ');
  const dropText = (d) => (d ? `Weights from your max come down ${d} points (75% becomes ${75 - d}%).` : 'Weights stay as written.');
  const red = hard.length > 0 || reasons.length >= 2;
  if (red) return { level: 'red', drop: rules.red_drop, sets_off: rules.red_sets, reasons, sources, from, headline: 'Take it easy today',
    advice: `${dropText(rules.red_drop)}${rules.red_sets ? ` Do ${rules.red_sets === 1 ? 'one set' : `${rules.red_sets} sets`} less of each exercise.` : ''} Stop and tell your coach if anything hurts.` };
  if (reasons.length) return { level: 'yellow', drop: rules.yellow_drop, sets_off: 0, reasons, sources, from, headline: 'Go a little lighter today', advice: `${dropText(rules.yellow_drop)} Keep your form sharp.` };
  return { level: 'green', drop: 0, sets_off: 0, reasons, sources, from, headline: 'Ready to go', advice: 'Train as written.' };
}
// From a check-in alone, with the default rules (the check-in's own row in lists).
export const readinessOf = (c) => readinessFrom(c, null);
export const readinessOn = (ctx) => getSetting(ctx, 'readiness_adjust') !== 'off';
// Today's readiness for one athlete: the check-in and the wearable together; with only the wearable, the level still
// shows and the app nudges the check-in; with neither, a nudge to check in first. Null when coaches turned it off.
export function readinessToday(ctx, clientId) {
  if (!readinessOn(ctx)) return null;
  const day = today(ctx), rules = readinessRules(ctx);
  const c = ctx.db.get('SELECT * FROM daily_checkins WHERE client_id = ? AND date = ?', clientId, day);
  const wear = rules.wearable ? wearableDay(ctx, clientId, day) : null;
  const r = readinessFrom(c, wear, rules);
  if (!r) return { level: null, drop: 0, sets_off: 0, reasons: [], sources: [], headline: 'Check in first', advice: 'Answer today\'s check-in to see if your workout should be lighter.' };
  return { ...r, checkin_missing: !c };
}
const shapeCheckin = (c) => (c ? { id: c.id, date: c.date, sleep_hours: c.sleep_hours, hydration: c.hydration, soreness: c.soreness, energy: c.energy, mood: c.mood, note: c.note, updated_at: c.updated_at, flags: flagsOf(c), readiness: readinessOf(c)?.level ?? null } : null);
const blank = (x) => x === undefined || x === null || x === '';

// Today's check-in. Saving again the same day updates it.
export function saveCheckin(ctx, clientId, body = {}) {
  clientRow(ctx, clientId);
  const row = { note: v.str(body.note, 'note', { max: 500, optional: true }) };
  if (blank(body.sleep_hours)) row.sleep_hours = null;
  else {
    const s = Number(body.sleep_hours);
    if (!Number.isFinite(s) || s < 0 || s > 16) throw badRequest('Enter hours of sleep between 0 and 16.');
    row.sleep_hours = Math.round(s * 2) / 2;
  }
  for (const k of SCALES) {
    if (blank(body[k])) { row[k] = null; continue; }
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw badRequest(`Rate ${k} from 1 to 5.`);
    row[k] = n;
  }
  if ([row.sleep_hours, ...SCALES.map((k) => row[k])].every((x) => x == null)) throw badRequest('Fill in at least one answer.');
  const date = today(ctx);
  ctx.db.run(`INSERT INTO daily_checkins (id, client_id, date, sleep_hours, hydration, soreness, energy, mood, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, date) DO UPDATE SET sleep_hours = excluded.sleep_hours, hydration = excluded.hydration, soreness = excluded.soreness, energy = excluded.energy, mood = excluded.mood, note = excluded.note, updated_at = excluded.updated_at`,
  newId('chk'), clientId, date, row.sleep_hours, row.hydration, row.soreness, row.energy, row.mood, row.note, ctx.now(), ctx.now());
  return shapeCheckin(ctx.db.get('SELECT * FROM daily_checkins WHERE client_id = ? AND date = ?', clientId, date));
}
// Days in a row with a check-in. Not having checked in yet today doesn't break it.
function checkinStreak(ctx, clientId) {
  const t = today(ctx);
  const dates = new Set(ctx.db.all('SELECT date FROM daily_checkins WHERE client_id = ? AND date >= ?', clientId, addDaysToDate(t, -400)).map((r) => r.date));
  let d = dates.has(t) ? t : addDaysToDate(t, -1), n = 0;
  while (dates.has(d)) { n++; d = addDaysToDate(d, -1); }
  return n;
}
// The longest run of check-in days in the last year.
function bestCheckinStreak(ctx, clientId) {
  const dates = ctx.db.all('SELECT date FROM daily_checkins WHERE client_id = ? AND date >= ? ORDER BY date', clientId, addDaysToDate(today(ctx), -400)).map((r) => r.date);
  let best = 0, run = 0, prev = null;
  for (const d of dates) { run = prev && addDaysToDate(prev, 1) === d ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  return best;
}
// Active weeks in a row: weeks with 2 or more training days, ending this week (or last week if this one isn't there yet).
function activeWeekStreak(ctx, clientId) {
  const thisWeek = weekStart(today(ctx));
  const days = trainingDays(ctx, clientId, addDaysToDate(thisWeek, -7 * 52), addDaysToDate(thisWeek, 6));
  const inWeek = (ws) => [0, 1, 2, 3, 4, 5, 6].filter((i) => days.has(addDaysToDate(ws, i))).length;
  let ws = inWeek(thisWeek) >= 2 ? thisWeek : addDaysToDate(thisWeek, -7), n = 0;
  while (n < 52 && inWeek(ws) >= 2) { n++; ws = addDaysToDate(ws, -7); }
  return n;
}

// ---------- Weekly goals ----------
function goalRows(ctx, clientId, { activeOnly = true } = {}) {
  const teams = teamsOf(ctx, clientId);
  return ctx.db.all(`SELECT * FROM goals WHERE ${activeOnly ? 'active = 1 AND' : ''} (client_id = ? OR contract_id IN (${inList(teams)})) ORDER BY created_at, id`, clientId, ...teams);
}
// This week's progress on each goal, last week's result, and how many weeks in a row it was met (counting this week
// once it's met, and never weeks before the goal was set). Past weeks are measured against today's target. Custom goals
// also get this week's days, Monday to Sunday, so a day missed earlier in the week can be ticked off.
export function goalsFor(ctx, clientId) {
  const rows = goalRows(ctx, clientId);
  if (!rows.length) return [];
  const t = today(ctx), ws = weekStart(t), we = addDaysToDate(ws, 6), lastWs = addDaysToDate(ws, -7), from = addDaysToDate(ws, -7 * 52), tz = zone(ctx);
  const bump = (m, d) => { const k = weekStart(d); m.set(k, (m.get(k) ?? 0) + 1); };
  const weekly = { workouts: new Map(), sessions: new Map(), checkins: new Map() };
  for (const r of training(ctx, clientId, from, we)) bump(weekly[r.kind], r.date);
  for (const r of ctx.db.all('SELECT date FROM daily_checkins WHERE client_id = ? AND date BETWEEN ? AND ?', clientId, from, we)) bump(weekly.checkins, r.date);
  const week = Array.from({ length: 7 }, (_, i) => addDaysToDate(ws, i));
  return rows.map((g) => {
    let perWeek = weekly[g.kind], checks = [];
    if (g.kind === 'custom') {
      const dates = ctx.db.all('SELECT date FROM goal_checks WHERE goal_id = ? AND client_id = ? AND date BETWEEN ? AND ?', g.id, clientId, from, we).map((r) => r.date);
      perWeek = new Map();
      for (const d of dates) bump(perWeek, d);
      checks = dates.filter((d) => d >= ws);
    }
    const progress = perWeek.get(ws) ?? 0, met = (w) => (perWeek.get(w) ?? 0) >= g.target;
    const startDay = localDate(g.created_at, tz), firstWeek = weekStart(startDay);
    let inRow = 0;
    for (let w = met(ws) ? ws : lastWs; w >= firstWeek && inRow < 52 && met(w); w = addDaysToDate(w, -7)) inRow++;
    return { id: g.id, title: g.title, kind: g.kind, kind_label: GOAL_KINDS[g.kind], target: g.target, progress, done: progress >= g.target,
      team: !!g.contract_id, checked_today: checks.includes(t), week_start: ws, week_end: we,
      last_week: lastWs >= firstWeek ? { week_start: lastWs, progress: perWeek.get(lastWs) ?? 0, done: met(lastWs) } : null, weeks_in_row: inRow,
      days: g.kind === 'custom' ? week.map((d) => ({ date: d, checked: checks.includes(d), today: d === t, future: d > t, before_start: d < startDay })) : null };
  });
}
// The athlete (or a parent) ticks a custom goal once per day: today, or a day missed earlier this week (never a future
// day or last week), in the business time zone.
export function checkGoal(ctx, clientId, goalId, done = true, date = null) {
  const g = goalRows(ctx, clientId).find((x) => x.id === goalId);
  if (!g) throw notFound('Goal');
  if (g.kind !== 'custom') throw badRequest('This goal counts itself from training and check-ins.');
  const t = today(ctx), d = blank(date) ? t : date;
  if (!isDate(d) || d > t || d < weekStart(t)) throw badRequest('Tick off a day from this week, up to today.');
  if (done && d < localDate(g.created_at, zone(ctx))) throw badRequest(`This goal was set on ${fmtDay(localDate(g.created_at, zone(ctx)))}. Tick off a day from then on.`);
  if (done) ctx.db.run('INSERT OR IGNORE INTO goal_checks (goal_id, client_id, date) VALUES (?, ?, ?)', g.id, clientId, d);
  else ctx.db.run('DELETE FROM goal_checks WHERE goal_id = ? AND client_id = ? AND date = ?', g.id, clientId, d);
  return goalsFor(ctx, clientId).find((x) => x.id === g.id);
}
const goalTarget = (x) => {
  const t = Number(x);
  if (!Number.isInteger(t) || t < 1 || t > 14) throw badRequest('Set a weekly target from 1 to 14.');
  return t;
};
export function createGoal(ctx, { clientId = null, contractId = null }, body = {}, actor) {
  if (clientId) clientRow(ctx, clientId); else teamRow(ctx, contractId);
  if (!GOAL_KINDS[body.kind]) throw badRequest('Choose what the goal counts: workouts, sessions, checkins or custom.');
  const target = goalTarget(body.target);
  const title = v.str(body.title, 'title', { max: 120, optional: true }) ?? `${target} ${GOAL_KINDS[body.kind].toLowerCase()} a week`;
  const id = newId('goal');
  ctx.db.run('INSERT INTO goals (id, client_id, contract_id, title, kind, target, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', id, clientId, contractId, title, body.kind, target, actor?.id ?? null, ctx.now());
  return ctx.db.get('SELECT * FROM goals WHERE id = ?', id);
}
// Change the target or title, or end a goal (active=false). Past weeks aren't affected.
export function updateGoal(ctx, id, body = {}) {
  const g = ctx.db.get('SELECT * FROM goals WHERE id = ?', id);
  if (!g) throw notFound('Goal');
  const active = body.active === undefined ? !!g.active : !!body.active;
  ctx.db.run('UPDATE goals SET title = ?, target = ?, active = ?, ended_at = ? WHERE id = ?',
    body.title !== undefined ? v.str(body.title, 'title', { max: 120 }) : g.title, body.target !== undefined ? goalTarget(body.target) : g.target,
    active ? 1 : 0, active ? null : g.ended_at ?? ctx.now(), id);
  return ctx.db.get('SELECT * FROM goals WHERE id = ?', id);
}

// ---------- Coach messages ----------
// Read state is the athlete's own, or with guardianId that parent's own.
export function messagesFor(ctx, clientId, limit = 30, { guardianId } = {}) {
  const teams = teamsOf(ctx, clientId);
  const reads = guardianId ? 'guardian_message_reads r ON r.message_id = m.id AND r.guardian_id = ?' : 'message_reads r ON r.message_id = m.id AND r.client_id = ?';
  return ctx.db.all(`SELECT m.id, m.body, m.created_at, m.contract_id, m.staff_name AS coach, m.from_kind, m.author_name, m.staff_read_at, r.read_at FROM coach_messages m
      LEFT JOIN ${reads}
    WHERE m.client_id = ? OR m.contract_id IN (${inList(teams)}) ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`, guardianId ?? clientId, clientId, ...teams, limit)
    .map((m) => ({ id: m.id, body: m.body, created_at: m.created_at, from: m.from_kind, coach: m.from_kind === 'coach' ? m.coach : null, author: m.from_kind === 'coach' ? m.coach : m.author_name,
      team: !!m.contract_id, read: m.from_kind !== 'coach' || !!m.read_at, ...(m.from_kind !== 'coach' ? { seen_by_coach: !!m.staff_read_at } : {}) }));
}
export function markRead(ctx, clientId, { guardianId } = {}) {
  const unread = messagesFor(ctx, clientId, 500, { guardianId }).filter((m) => !m.read);
  for (const m of unread) {
    if (guardianId) ctx.db.run('INSERT OR IGNORE INTO guardian_message_reads (message_id, guardian_id, read_at) VALUES (?, ?, ?)', m.id, guardianId, ctx.now());
    else ctx.db.run('INSERT OR IGNORE INTO message_reads (message_id, client_id, read_at) VALUES (?, ?, ?)', m.id, clientId, ctx.now());
  }
  return { read: unread.length };
}
// Emails the athlete (when they have their own address) and every parent, with a link to see it.
// tab: the app tab the link opens (/app?token=…#education).
function notifyAthlete(ctx, c, subject, text, { tab = null } = {}) {
  const base = ctx.publicUrl ?? '';
  const biz = getSetting(ctx, 'business_name');
  if (c.family_id) notifyFamily(ctx, c.family_id, subject, `${text}\n\nSee it in the parent portal: ${base}/parent\n\n${biz}`);
  if (c.email) sendEmail(ctx, { to: c.email, subject, sensitive: true, text: `${text}\n\nOpen your app: ${base}/app?token=${c.access_token}${tab ? `#${tab}` : ''}\n\n${biz}` }).catch(() => {});
}
const staffName = (actor) => actor?.name ?? actor?.label ?? 'Your coach';
export function sendMessage(ctx, { clientId = null, contractId = null }, body = {}, actor) {
  const text = v.str(body.body, 'Message', { max: 2000 });
  const who = clientId ? [clientRow(ctx, clientId)] : (teamRow(ctx, contractId), rosterClients(ctx, contractId));
  const id = newId('cmsg');
  ctx.db.run('INSERT INTO coach_messages (id, client_id, contract_id, staff_id, staff_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, clientId, contractId, actor?.id ?? null, staffName(actor), text, ctx.now());
  const from = staffName(actor).split(' ')[0];
  for (const c of who) notifyAthlete(ctx, c, `A note from ${from} at ${getSetting(ctx, 'business_name')}`, `${from} wrote to ${firstName(c)}:\n\n${text}`);
  return { id, body: text, created_at: ctx.now(), coach: staffName(actor), team: !!contractId, recipients: who.length };
}

// Replies from the athlete (in their app) or a parent (in the portal). The coach who last wrote to the athlete is
// emailed, or the owners when no coach has written yet. Replies never go to other families.
const REPLIES_PER_DAY = 20;
export function replyMessage(ctx, clientId, body = {}, { from, name, guardianId = null }) {
  const c = clientRow(ctx, clientId);
  const text = v.str(body.body, 'Message', { max: 2000 });
  const today = ctx.db.get(`SELECT COUNT(*) AS n FROM coach_messages WHERE client_id = ? AND from_kind != 'coach' AND created_at >= ?`, clientId, new Date(Date.now() - 86400000).toISOString()).n;
  if (today >= REPLIES_PER_DAY) throw new HttpError(429, 'too_many_messages', 'That\'s a lot of messages today. Call or text your coach if it\'s urgent.');
  const id = newId('cmsg');
  ctx.db.run('INSERT INTO coach_messages (id, client_id, contract_id, staff_id, staff_name, body, created_at, from_kind, author_name, guardian_id) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)',
    id, clientId, text, ctx.now(), from, name, guardianId);
  const last = ctx.db.get(`SELECT u.email FROM coach_messages m JOIN users u ON u.id = m.staff_id WHERE m.client_id = ? AND m.from_kind = 'coach' AND u.active = 1 ORDER BY m.created_at DESC LIMIT 1`, clientId);
  const to = last ? [last.email] : ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`).map((u) => u.email);
  const who = from === 'parent' ? `${name} (${firstName(c)}'s parent)` : name;
  for (const email of to) sendEmail(ctx, { to: email, subject: `${who} replied`, text: `${who} wrote:\n\n${text}\n\nReply on ${firstName(c)}'s page: ${ctx.publicUrl ?? ''}/#/clients/${c.id}` }).catch(() => {});
  return { id, body: text, created_at: ctx.now(), from, author: name };
}
// Replies no coach has seen yet, one row per athlete, for Today.
export function unreadReplies(ctx) {
  return ctx.db.all(`SELECT m.client_id, c.name, COUNT(*) AS count, MAX(m.created_at) AS last_at,
      (SELECT author_name FROM coach_messages x WHERE x.client_id = m.client_id AND x.from_kind != 'coach' AND x.staff_read_at IS NULL ORDER BY x.created_at DESC LIMIT 1) AS author
    FROM coach_messages m JOIN clients c ON c.id = m.client_id WHERE m.from_kind != 'coach' AND m.staff_read_at IS NULL GROUP BY m.client_id ORDER BY last_at DESC`);
}
export function markRepliesSeen(ctx, clientId) {
  clientRow(ctx, clientId);
  return { seen: ctx.db.run(`UPDATE coach_messages SET staff_read_at = ? WHERE client_id = ? AND from_kind != 'coach' AND staff_read_at IS NULL`, ctx.now(), clientId).changes };
}

// ---------- Performance: targets and rankings ----------
// Values as typed: 84, 6'5" or 6 ft 5 for inches, 1:05 for seconds.
export function parseValue(raw, unit) {
  const t = String(raw ?? '').trim().replace(/[′’‘]/g, "'").replace(/[″“”]/g, '"').replace(/\s+/g, ' ');
  if (!t) return null;
  if (unit === 'in') {
    const fi = t.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inches)?)?$/i);
    if (fi) return Number(fi[1]) * 12 + Number(fi[2] ?? 0);
  }
  if (unit === 's') {
    const ms = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (ms) return Number(ms[1]) * 60 + Number(ms[2]);
  }
  const n = Number(t.replace(new RegExp(`\\s*(${String(unit ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}|")$`), '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
const UNIT_TEXT = { ratio: '', level: '', points: 'pts' };
export function fmtValue(val, unit, decimals = 2) {
  if (val == null || !Number.isFinite(val)) return null;
  if (unit === 'in' && Math.abs(val) >= 48) { const ft = Math.floor(val / 12), inch = val - ft * 12; return `${ft}′ ${inch.toFixed(inch % 1 ? 1 : 0)}″`; }
  const u = UNIT_TEXT[unit] ?? unit;
  return `${+Number(val).toFixed(decimals)}${u ? ` ${u}` : ''}`;
}

// One line per test: the headline number, best across sides, first and latest results.
function testSummary(profile) {
  const byTest = new Map();
  for (const p of profile.filter((x) => x.headline && x.better !== 'none')) {
    const cur = byTest.get(p.test);
    if (!cur) { byTest.set(p.test, { ...p }); continue; }
    const lower = p.better === 'lower';
    if (p.best != null && (cur.best == null || (lower ? p.best < cur.best : p.best > cur.best))) { cur.best = p.best; cur.best_date = p.best_date; }
    if (p.first.date < cur.first.date) cur.first = p.first;
    if (p.latest.date > cur.latest.date) cur.latest = p.latest;
    cur.tests_count = Math.max(cur.tests_count, p.tests_count);
    cur.side = null;
  }
  return [...byTest.values()];
}
// How far is left to a target, in the test's own units: "0.13 s to go", "3 in to go", "2 ft 1 in to go".
export function gapText(gap, unit, decimals = 2) {
  if (gap == null || !(gap > 0)) return null;
  if (unit === 'in' && gap >= 12) {
    let ft = Math.floor(gap / 12), inch = Math.round(gap - ft * 12);
    if (inch === 12) { ft++; inch = 0; }
    return `${ft} ft${inch ? ` ${inch} in` : ''} to go`;
  }
  const u = UNIT_TEXT[unit] ?? unit;
  return `${+gap.toFixed(unit === 'in' ? 1 : decimals)}${u ? ` ${u}` : ''} to go`;
}
function targetsFor(ctx, clientId, tests) {
  const t = today(ctx);
  return ctx.db.all(`SELECT tt.*, t.key, t.name FROM test_targets tt JOIN perf_tests t ON t.id = tt.test_id WHERE tt.client_id = ? ORDER BY t.name`, clientId).map((x) => {
    const m = ctx.db.get('SELECT unit, better, decimals FROM perf_metrics WHERE test_id = ? ORDER BY sort LIMIT 1', x.test_id);
    const r = tests.find((t) => t.test === x.key);
    const lower = m.better === 'lower', best = r?.best ?? null, first = r?.first?.value ?? null;
    let pct = 0;
    if (best != null) {
      if (lower ? best <= x.target : best >= x.target) pct = 100;
      else if (first != null && first !== x.target) pct = Math.max(0, Math.min(99, Math.round(((lower ? first - best : best - first) / Math.abs(x.target - first)) * 100)));
    }
    const gap = best == null || pct === 100 ? null : +(lower ? best - x.target : x.target - best).toFixed(Math.max(m.decimals ?? 2, 1));   // no float noise (0.19, not 0.19000000000000039)
    return { id: x.id, test: x.key, test_name: x.name, unit: m.unit, better: m.better, target: x.target, due_date: x.due_date, best, first, pct, reached: pct === 100,
      best_text: fmtValue(best, m.unit, m.decimals), target_text: fmtValue(x.target, m.unit, m.decimals),
      gap, gap_text: gapText(gap, m.unit, m.decimals), overdue: pct !== 100 && !!x.due_date && x.due_date < t };
  });
}
export function setTarget(ctx, clientId, body = {}, actor) {
  clientRow(ctx, clientId);
  if (blank(body.test)) throw badRequest('Choose a test.');
  const test = getTest(ctx, String(body.test));
  const metric = test.metrics[0];
  const val = parseValue(body.target, metric.unit);
  if (val == null || val <= 0) throw badRequest(`Enter the target in ${metric.unit === 'in' ? 'inches, or feet and inches like 6\'5"' : metric.unit}.`);
  const due = blank(body.due_date) ? null : body.due_date;
  if (due && !isDate(due)) throw badRequest('due_date must be a date like 2026-12-01.');
  ctx.db.run(`INSERT INTO test_targets (id, client_id, test_id, target, due_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, test_id) DO UPDATE SET target = excluded.target, due_date = excluded.due_date`, newId('tgt'), clientId, test.id, val, due, actor?.id ?? null, ctx.now());
  const tests = testSummary(athleteProfile(ctx, { client_id: clientId }));
  return targetsFor(ctx, clientId, tests).find((t) => t.test === test.key);
}
export function removeTarget(ctx, id) {
  if (!ctx.db.run('DELETE FROM test_targets WHERE id = ?', id).changes) throw notFound('Target');
  return { id, deleted: true };
}

export const rankingsOn = (ctx) => getSetting(ctx, 'rankings') === 'on';
const AGE_BANDS = [[0, 9, '9 and under'], [10, 11, '10–11'], [12, 13, '12–13'], [14, 15, '14–15'], [16, 18, '16–18'], [19, 200, 'adults']];
// Where the athlete's best result sits among: the same sex and age band, each team they're on, and
// everyone at the gym. Counts and percentages only; no other athlete is ever named. Groups with
// fewer than 4 athletes tested aren't ranked. Ties count half.
function rankings(ctx, c, tests, parentView) {
  if (!rankingsOn(ctx)) return null;
  const keyOf = (r) => `c:${r.client_id}`;   // one profile per athlete: every result is on a client
  const groups = [];
  const age = ageOn(c.birth_date, ctx.now());
  if (age != null && c.sex) {
    const [lo, hi, label] = AGE_BANDS.find(([a, b]) => age >= a && age <= b);
    const ids = ctx.db.all('SELECT id, birth_date FROM clients WHERE sex = ? AND birth_date IS NOT NULL', c.sex).filter((x) => { const a = ageOn(x.birth_date, ctx.now()); return a >= lo && a <= hi; }).map((x) => `c:${x.id}`);
    groups.push({ label: label === 'adults' ? (c.sex === 'F' ? 'Women' : 'Men') : `${c.sex === 'F' ? 'Girls' : 'Boys'} ${label}`, keys: new Set(ids) });
  }
  for (const contractId of teamsOf(ctx, c.id)) {
    const t = teamRow(ctx, contractId);
    groups.push({ label: teamLabel(t), keys: new Set(ctx.db.all('SELECT client_id FROM team_roster WHERE contract_id = ? AND active = 1 AND client_id IS NOT NULL', contractId).map((r) => `c:${r.client_id}`)) });
  }
  groups.push({ label: `Everyone at ${getSetting(ctx, 'business_name')}`, keys: null });
  const me = `c:${c.id}`, out = [];
  for (const t of tests.filter((x) => x.category !== 'body')) {
    const lower = t.better === 'lower';
    const rows = ctx.db.all(`SELECT r.client_id, ${lower ? 'MIN' : 'MAX'}(r.value) AS best FROM perf_results r JOIN perf_tests pt ON pt.id = r.test_id
      WHERE pt.key = ? AND r.metric = ? AND r.voided = 0 AND r.client_id IS NOT NULL ${parentView ? parentFilter(ctx) : ''} GROUP BY r.client_id`, t.test, t.metric);
    const bests = new Map();
    for (const r of rows) { const k = keyOf(r), cur = bests.get(k); if (cur == null || (lower ? r.best < cur : r.best > cur)) bests.set(k, r.best); }
    if (!bests.has(me)) continue;
    const mine = bests.get(me);
    const ranks = groups.map((g) => {
      const vals = [...bests.entries()].filter(([k]) => !g.keys || g.keys.has(k)).map(([, x]) => x);
      if (vals.length < 4) return null;
      const better = vals.filter((x) => (lower ? x < mine : x > mine)).length, worse = vals.filter((x) => (lower ? x > mine : x < mine)).length;
      const ties = vals.length - better - worse - 1;
      return { group: g.label, rank: better + 1, of: vals.length, percentile: Math.round(((worse + ties / 2) / (vals.length - 1)) * 100) };
    }).filter(Boolean);
    if (ranks.length) out.push({ test: t.test, test_name: t.test_name, unit: t.unit, best: mine, best_text: fmtValue(mine, t.unit, t.decimals), ranks });
  }
  return out;
}

export function performance(ctx, clientId, { parentView = false } = {}) {
  const c = clientRow(ctx, clientId);
  const profile = athleteProfile(ctx, { client_id: c.id }, { parentView });
  const tests = testSummary(profile);
  const lastDate = tests.reduce((m, t) => (t.latest.date > m ? t.latest.date : m), '');
  return {
    tests: tests.map((t) => ({ test: t.test, test_name: t.test_name, category: t.category, metric: t.metric, unit: t.unit, decimals: t.decimals, better: t.better,
      best: t.best, best_text: fmtValue(t.best, t.unit, t.decimals), first: t.first, latest: t.latest, change: t.tests_count > 1 ? t.latest.value - t.first.value : null,
      improved: t.tests_count > 1 ? (t.better === 'lower' ? t.latest.value < t.first.value : t.latest.value > t.first.value) : null, tests_count: t.tests_count, history: t.history })),
    prs: tests.filter((t) => t.tests_count > 1 && t.best_date === lastDate && t.best_date !== t.first.date).map((t) => ({ test: t.test, test_name: t.test_name, value: t.best, text: fmtValue(t.best, t.unit, t.decimals), date: t.best_date })),
    last_tested: lastDate || null,
    targets: targetsFor(ctx, c.id, tests),
    rankings: rankings(ctx, c, tests, parentView),
    rankings_enabled: rankingsOn(ctx),
    skill_badges: badgesFor(ctx, c.id),
    milestones: milestonesFor(ctx, c.id, tests)
  };
}

// ---------- Skill badges ----------
// Coaches award these by hand when an athlete shows a skill ("Sprint start", "Hinge pattern"). Athletes and parents
// see them on the Performance tab, and the family gets an email. Removing a badge from the list hides it from new
// awards but keeps the ones already earned.
export const BADGE_CATEGORIES = ['Speed', 'Strength', 'Power', 'Mobility', 'Skill', 'Mindset'];
function badgeRow(ctx, id) {
  const b = ctx.db.get('SELECT * FROM skill_badges WHERE id = ?', id);
  if (!b) throw notFound('Skill badge');
  return b;
}
const shapeBadge = (ctx, b) => ({ id: b.id, name: b.name, description: b.description, category: b.category, archived: !!b.archived, created_at: b.created_at,
  awarded: ctx.db.get('SELECT COUNT(*) AS n FROM badge_awards WHERE badge_id = ?', b.id).n });
export function listBadges(ctx, { all = false } = {}) {
  return ctx.db.all(`SELECT * FROM skill_badges ${all ? '' : 'WHERE archived = 0'} ORDER BY category, name`).map((b) => shapeBadge(ctx, b));
}
function badgeInput(body, cur = {}) {
  const name = v.str(body.name ?? cur.name, 'name', { max: 60 });
  const description = body.description === undefined ? cur.description ?? null : v.str(body.description, 'description', { max: 300, optional: true }) ?? null;
  const category = body.category === undefined ? cur.category ?? null : body.category === null || body.category === '' ? null : v.oneOf(body.category, 'category', BADGE_CATEGORIES);
  return { name, description, category };
}
export function createBadge(ctx, body = {}) {
  const b = badgeInput(body), id = newId('bdg');
  if (ctx.db.get('SELECT id FROM skill_badges WHERE name = ?', b.name)) throw conflict(`There's already a badge called "${b.name}". Pick it from the list or use another name.`);
  ctx.db.run('INSERT INTO skill_badges (id, name, description, category, created_at) VALUES (?, ?, ?, ?, ?)', id, b.name, b.description, b.category, ctx.now());
  return shapeBadge(ctx, badgeRow(ctx, id));
}
export function updateBadge(ctx, id, body = {}) {
  const cur = badgeRow(ctx, id), b = badgeInput(body, cur);
  if (ctx.db.get('SELECT id FROM skill_badges WHERE name = ? AND id != ?', b.name, id)) throw conflict(`There's already a badge called "${b.name}".`);
  const archived = body.archived === undefined ? cur.archived : body.archived ? 1 : 0;
  ctx.db.run('UPDATE skill_badges SET name = ?, description = ?, category = ?, archived = ? WHERE id = ?', b.name, b.description, b.category, archived, id);
  return shapeBadge(ctx, badgeRow(ctx, id));
}
// Award one badge to one or more athletes (after a clinic, say). Athletes who already have it are skipped.
export function awardBadge(ctx, badgeId, body = {}, actor) {
  const b = badgeRow(ctx, badgeId);
  if (b.archived) throw conflict('This badge was removed from the list. Put it back to award it.');
  const ids = Array.isArray(body.client_ids) ? [...new Set(body.client_ids.map(String))] : body.client_id ? [String(body.client_id)] : [];
  if (!ids.length) throw badRequest('Choose at least one athlete.');
  if (ids.length > 200) throw badRequest('Award to 200 athletes or fewer at a time.');
  const who = ids.map((id) => clientRow(ctx, id));
  const note = v.str(body.note, 'note', { max: 300, optional: true }) ?? null;
  const by = staffName(actor);
  const awarded = [];
  ctx.db.tx(() => {
    for (const c of who) {
      const r = ctx.db.run('INSERT INTO badge_awards (id, badge_id, client_id, note, awarded_by, awarded_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(badge_id, client_id) DO NOTHING', newId('bda'), b.id, c.id, note, by, ctx.now());
      if (r.changes) awarded.push(c);
    }
  });
  const coach = by.split(' ')[0];
  for (const c of awarded) {
    emit(ctx, 'badge.awarded', { client_id: c.id, client_name: c.name, badge_id: b.id, badge_name: b.name, awarded_by: by });
    notifyAthlete(ctx, c, `${firstName(c)} earned a skill badge: ${b.name}`, `${firstName(c)} earned the "${b.name}" skill badge from ${coach}.${b.description ? `\n\n${b.description}` : ''}${note ? `\n\n${coach}: "${note}"` : ''}`);
  }
  return { badge: shapeBadge(ctx, b), awarded: awarded.length, already_had: who.length - awarded.length };
}
export function removeAward(ctx, id) {
  if (!ctx.db.run('DELETE FROM badge_awards WHERE id = ?', id).changes) throw notFound('Badge award');
  return { id, deleted: true };
}
// Milestones the app works out on its own: sessions and workouts done, a check-in streak, and PRs.
const STEPS = [10, 25, 50, 100, 250, 500];
export function milestonesFor(ctx, clientId, tests) {
  const t = training(ctx, clientId, '2000-01-01', today(ctx));
  const top = (n) => [...STEPS].reverse().find((x) => n >= x);
  const out = [];
  const sessions = top(t.filter((r) => r.kind === 'sessions').length), workouts = top(t.filter((r) => r.kind === 'workouts').length);
  if (sessions) out.push({ key: `sessions_${sessions}`, name: `${sessions} sessions`, detail: `Showed up for ${sessions} sessions.` });
  if (workouts) out.push({ key: `workouts_${workouts}`, name: `${workouts} workouts`, detail: `Finished ${workouts} app workouts.` });
  const streak = checkinStreak(ctx, clientId), s = [30, 14, 7].find((x) => streak >= x);
  if (s) out.push({ key: `checkins_${s}`, name: `${s}-day check-in streak`, detail: `Checked in ${streak} days in a row.` });
  const improved = tests.filter((x) => x.tests_count > 1 && x.best_date !== x.first.date).length;
  if (improved) out.push({ key: 'prs', name: improved === 1 ? 'First PR' : `PRs in ${improved} tests`, detail: improved === 1 ? 'Beat a first test result.' : `Beat the first result in ${improved} different tests.` });
  return out;
}
export function badgesFor(ctx, clientId) {
  return ctx.db.all(`SELECT a.id, a.badge_id, b.name, b.description, b.category, a.note, a.awarded_by, a.awarded_at FROM badge_awards a JOIN skill_badges b ON b.id = a.badge_id
    WHERE a.client_id = ? ORDER BY a.awarded_at DESC`, clientId);
}

// ---------- Education ----------
const doneSet = (ctx, clientId) => new Set(ctx.db.all('SELECT lesson_id FROM lesson_progress WHERE client_id = ?', clientId).map((r) => r.lesson_id));
const lessonItem = (l, done) => ({ id: l.id, title: l.title, summary: l.summary, minutes: l.minutes, has_video: !!l.video_url, has_quiz: !!l.quiz, course_id: l.course_id, category: l.category ?? 'athlete', done: done.has(l.id) });
// The Education tabs (version 46). Who reads each: athlete (athletes, and their parents with them), parent (parents in the
// portal), coach (staff, and anyone on the public /learn page), blog and research (athletes and parents). A lesson in a
// course is for the course's readers, so it takes the course's audience.
export const EDU_CATEGORIES = { athlete: 'Athlete education', parent: 'Parent education', coach: 'Coach\'s education', blog: 'Blogs', research: 'Research' };
const courseCategory = (audience) => (audience === 'parents' ? 'parent' : 'athlete');

// ---------- Quizzes ----------
// Coaches write a quiz as plain text: a question on one line, then its choices on the lines below, each starting with
// "-", and the right one with "*". A blank line between questions. Athletes need 80% to finish the lesson.
export const QUIZ_PASS_PCT = 80;
export function parseQuiz(text) {
  const blocks = String(text ?? '').replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  if (!blocks.length) return null;
  if (blocks.length > 10) throw badRequest('A quiz can have up to 10 questions.');
  const problems = [];
  const questions = blocks.map((lines, i) => {
    const n = i + 1;
    const [q, ...rest] = lines;
    if (/^[-*]/.test(q)) problems.push(`Question ${n} starts with a choice. Put the question on the first line.`);
    const choices = [], extra = [];
    let answer = -1;
    for (const l of rest) {
      const m = l.match(/^([-*])\s*(.+)$/);
      if (!m) { extra.push(l); continue; }
      if (m[1] === '*') { if (answer >= 0) problems.push(`Question ${n} has more than one right answer. Mark only one with *.`); answer = choices.length; }
      choices.push(m[2].slice(0, 200));
    }
    if (extra.length) problems.push(`Question ${n}: start each choice with - (or * for the right one): "${extra[0].slice(0, 40)}".`);
    if (choices.length < 2 || choices.length > 6) problems.push(`Question ${n} needs 2 to 6 choices.`);
    if (answer < 0) problems.push(`Question ${n} needs a right answer: start it with * instead of -.`);
    return { q: q.replace(/^\d+[.)]\s*/, '').slice(0, 300), choices, answer };
  });
  if (problems.length) throw badRequest(problems.join(' '));
  return questions;
}
export const quizText = (quiz) => (quiz ?? []).map((x) => [x.q, ...x.choices.map((c, i) => `${i === x.answer ? '*' : '-'} ${c}`)].join('\n')).join('\n\n');
const quizOf = (l) => (l?.quiz ? JSON.parse(l.quiz) : null);
const passedQuiz = (ctx, lessonId, clientId) => !!ctx.db.get('SELECT 1 FROM quiz_attempts WHERE lesson_id = ? AND client_id = ? AND passed = 1', lessonId, clientId);
function assignmentRows(ctx, clientId) {
  const teams = teamsOf(ctx, clientId);
  return ctx.db.all(`SELECT * FROM lesson_assignments WHERE client_id = ? OR contract_id IN (${inList(teams)}) ORDER BY COALESCE(due_date, '9999-12-31'), created_at`, clientId, ...teams);
}
// Lessons in parent courses never show to athletes.
// Athletes read athlete education, blogs and research; never parent or coach's education.
const ATHLETE_LESSON = `(category IN ('athlete','blog','research') AND (course_id IS NULL OR course_id NOT IN (SELECT id FROM courses WHERE audience = 'parents')))`;
// A course sold online is locked for an athlete until it's bought, a coach assigns it (to them or their team), or they
// had already started it before it went on sale.
function lockedCourses(ctx, clientId) {
  const paid = ctx.db.all(`SELECT id FROM courses WHERE for_sale = 1 AND price_cents > 0 AND audience = 'athletes'`).map((r) => r.id);
  if (!paid.length) return new Set();
  const open = new Set([
    ...ctx.db.all(`SELECT item_id FROM purchases WHERE client_id = ? AND item_kind = 'course' AND status = 'active'`, clientId).map((r) => r.item_id),
    ...assignmentRows(ctx, clientId).map((x) => x.course_id ?? (x.lesson_id && ctx.db.get('SELECT course_id FROM lessons WHERE id = ?', x.lesson_id)?.course_id)).filter(Boolean),
    ...ctx.db.all('SELECT DISTINCT l.course_id FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id WHERE p.client_id = ? AND l.course_id IS NOT NULL', clientId).map((r) => r.course_id)]);
  return new Set(paid.filter((id) => !open.has(id)));
}
function requireOpen(ctx, clientId, l) {
  if (l.course_id && lockedCourses(ctx, clientId).has(l.course_id)) throw conflict('This lesson is part of a course for sale. A parent can buy it on the Programs tab of the parent portal.');
}
// What the athlete (or their parent) sees: assigned reading first, then courses and the library. Unpublished lessons never show.
export function education(ctx, clientId) {
  clientRow(ctx, clientId);
  const done = doneSet(ctx, clientId), t = today(ctx);
  const seen = new Set(ctx.db.all('SELECT lesson_id FROM lesson_views WHERE client_id = ?', clientId).map((r) => r.lesson_id));
  const lessons = ctx.db.all(`SELECT * FROM lessons WHERE published = 1 AND ${ATHLETE_LESSON} ORDER BY position, created_at`);
  const locked = lockedCourses(ctx, clientId);
  const courses = ctx.db.all(`SELECT * FROM courses WHERE published = 1 AND audience = 'athletes' ORDER BY created_at`).map((c) => {
    const ls = lessons.filter((l) => l.course_id === c.id).map((l) => (locked.has(c.id) ? { ...lessonItem(l, done), locked: true } : lessonItem(l, done)));
    return { id: c.id, title: c.title, description: c.description, lessons: ls, done: ls.filter((l) => l.done).length, total: ls.length, complete: ls.length > 0 && ls.every((l) => l.done),
      ...(locked.has(c.id) ? { locked: true, price_cents: c.price_cents } : {}) };
  }).filter((c) => c.total > 0);
  // The lesson to open next in a course: the first one not done yet.
  const nextOf = (c) => { const n = c.lessons.find((l) => !l.done); return n ? { id: n.id, title: n.title } : null; };
  const assigned = assignmentRows(ctx, clientId).map((x) => {
    if (x.lesson_id) {
      const l = lessons.find((y) => y.id === x.lesson_id);
      if (!l) return null;
      return { id: x.id, type: 'lesson', lesson_id: l.id, title: l.title, due_date: x.due_date, note: x.note, team: !!x.contract_id, done: done.has(l.id), opened: seen.has(l.id), overdue: !done.has(l.id) && !!x.due_date && x.due_date < t };
    }
    const c = courses.find((y) => y.id === x.course_id);
    if (!c) return null;
    return { id: x.id, type: 'course', course_id: c.id, title: c.title, due_date: x.due_date, note: x.note, team: !!x.contract_id, done: c.complete, progress: `${c.done} of ${c.total}`,
      opened: c.lessons.some((l) => seen.has(l.id)), next_lesson: nextOf(c),
      overdue: !c.complete && !!x.due_date && x.due_date < t };
  }).filter(Boolean);
  return { assigned, courses, lessons: lessons.filter((l) => !l.course_id || !courses.some((c) => c.id === l.course_id)).map((l) => lessonItem(l, done)), completed: done.size, certificates: certificatesFor(ctx, clientId) };
}
export function lessonFor(ctx, clientId, lessonId) {
  clientRow(ctx, clientId);
  const l = ctx.db.get(`SELECT * FROM lessons WHERE id = ? AND published = 1 AND ${ATHLETE_LESSON}`, lessonId);
  if (!l) throw notFound('Lesson');
  requireOpen(ctx, clientId, l);
  recordView(ctx, clientId, l.id);
  const course = l.course_id ? ctx.db.get('SELECT id, title FROM courses WHERE id = ? AND published = 1', l.course_id) : null;
  const siblings = course ? ctx.db.all('SELECT id, title FROM lessons WHERE course_id = ? AND published = 1 ORDER BY position, created_at', course.id) : [];
  const i = siblings.findIndex((s) => s.id === l.id);
  const quiz = quizOf(l), last = quiz && ctx.db.get('SELECT score, total, passed, created_at FROM quiz_attempts WHERE lesson_id = ? AND client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', l.id, clientId);
  return { id: l.id, title: l.title, summary: l.summary, body: l.body, video_url: l.video_url, minutes: l.minutes, course: course ?? null,
    quiz: quiz ? { questions: quiz.map((x) => ({ q: x.q, choices: x.choices })), pass_pct: QUIZ_PASS_PCT, passed: passedQuiz(ctx, l.id, clientId), last: last ? { ...last, passed: !!last.passed } : null } : null,
    done: !!ctx.db.get('SELECT 1 FROM lesson_progress WHERE lesson_id = ? AND client_id = ?', l.id, clientId),
    next: i >= 0 ? siblings[i + 1] ?? null : null, position: i >= 0 ? { n: i + 1, of: siblings.length } : null,
    course_complete: siblings.length > 0 && siblings.every((x) => doneSet(ctx, clientId).has(x.id)) };
}
export function completeLesson(ctx, clientId, lessonId, done = true) {
  const l = lessonFor(ctx, clientId, lessonId);
  if (done && l.quiz && !l.quiz.passed) throw conflict(`Pass the quiz at the end to finish this lesson (${QUIZ_PASS_PCT}% or more).`);
  if (done) {
    ctx.db.run('INSERT OR IGNORE INTO lesson_progress (lesson_id, client_id, completed_at) VALUES (?, ?, ?)', l.id, clientId, ctx.now());
    if (l.course) issueCertificate(ctx, clientId, l.course.id);
  } else ctx.db.run('DELETE FROM lesson_progress WHERE lesson_id = ? AND client_id = ?', l.id, clientId);
  return lessonFor(ctx, clientId, lessonId);
}

// Check the answers (the choice number for each question, from 0). Passing finishes the lesson. Tries are unlimited,
// up to 20 a day, and the right answers are never sent: only which questions were wrong.
export function takeQuiz(ctx, clientId, lessonId, body = {}) {
  const l = ctx.db.get(`SELECT * FROM lessons WHERE id = ? AND published = 1 AND ${ATHLETE_LESSON}`, lessonId);
  if (!l) throw notFound('Lesson');
  requireOpen(ctx, clientId, l);
  const quiz = quizOf(l);
  if (!quiz) throw conflict('This lesson has no quiz.');
  const since = new Date(Date.parse(ctx.now()) - 86400000).toISOString();
  if (ctx.db.get('SELECT COUNT(*) AS n FROM quiz_attempts WHERE lesson_id = ? AND client_id = ? AND created_at >= ?', l.id, clientId, since).n >= 20) throw new HttpError(429, 'too_many_tries', 'That\'s 20 tries today. Reread the lesson and try again tomorrow.');
  const answers = Array.isArray(body.answers) ? body.answers : [];
  if (answers.length !== quiz.length) throw badRequest(`Answer all ${quiz.length} questions.`);
  const results = quiz.map((x, i) => ({ correct: Number(answers[i]) === x.answer }));
  const score = results.filter((r) => r.correct).length;
  const passed = score * 100 >= quiz.length * QUIZ_PASS_PCT;
  ctx.db.run('INSERT INTO quiz_attempts (id, lesson_id, client_id, score, total, passed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('qz'), l.id, clientId, score, quiz.length, passed ? 1 : 0, ctx.now());
  const lesson = passed ? completeLesson(ctx, clientId, l.id, true) : lessonFor(ctx, clientId, l.id);
  return { score, total: quiz.length, passed, results, lesson };
}

// ---------- Course certificates ----------
// Finishing every published lesson in a course issues a certificate once, and emails the family its link.
function issueCertificate(ctx, clientId, courseId) {
  const ids = ctx.db.all('SELECT id FROM lessons WHERE course_id = ? AND published = 1', courseId).map((r) => r.id);
  const done = doneSet(ctx, clientId);
  if (!ids.length || !ids.every((x) => done.has(x))) return null;
  const tok = token(16);
  if (!ctx.db.run('INSERT INTO course_certificates (id, course_id, client_id, token, issued_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(course_id, client_id) DO NOTHING', newId('cert'), courseId, clientId, tok, ctx.now()).changes) return null;
  const c = clientRow(ctx, clientId), course = ctx.db.get('SELECT title FROM courses WHERE id = ?', courseId);
  emit(ctx, 'course.completed', { client_id: c.id, client_name: c.name, course_id: courseId, course_title: course.title });
  notifyAthlete(ctx, c, `${firstName(c)} finished ${course.title}`, `${firstName(c)} finished every lesson in "${course.title}". Here's the certificate to print or share: ${ctx.publicUrl ?? ''}/certificate#${tok}`);
  return tok;
}
export function certificatesFor(ctx, clientId) {
  return ctx.db.all('SELECT x.course_id, c.title, x.token, x.issued_at FROM course_certificates x JOIN courses c ON c.id = x.course_id WHERE x.client_id = ? ORDER BY x.issued_at DESC', clientId)
    .map((x) => ({ course_id: x.course_id, title: x.title, issued_at: x.issued_at, url: `/certificate#${x.token}` }));
}
// The shareable certificate page: name, course and date only.
export function publicCertificate(ctx, tok) {
  const x = ctx.db.get(`SELECT x.issued_at, c.title, c.description, cl.name, (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id AND l.published = 1) AS lessons
    FROM course_certificates x JOIN courses c ON c.id = x.course_id JOIN clients cl ON cl.id = x.client_id WHERE x.token = ?`, String(tok ?? ''));
  if (!x) throw notFound('Certificate');
  return { name: x.name, course: x.title, description: x.description, lessons: x.lessons, issued_on: localDate(x.issued_at, zone(ctx)), business_name: getSetting(ctx, 'business_name') };
}

// Coach side: lessons and courses.
function lessonFields(ctx, body, cur = {}) {
  const has = (k) => body[k] !== undefined;
  const out = {
    title: has('title') ? v.str(body.title, 'title', { max: 160 }) : cur.title,
    summary: has('summary') ? v.str(body.summary, 'summary', { max: 300, optional: true }) : cur.summary ?? null,
    body: has('body') ? (blank(body.body) ? null : v.str(body.body, 'body', { max: 50000 })) : cur.body ?? null,
    video_url: has('video_url') ? v.url(body.video_url, 'video_url', { optional: true }) : cur.video_url ?? null,
    minutes: has('minutes') ? v.int(body.minutes, 'minutes', { min: 1, max: 240, optional: true }) : cur.minutes ?? null,
    course_id: has('course_id') ? (blank(body.course_id) ? null : String(body.course_id)) : cur.course_id ?? null,
    published: has('published') ? (body.published ? 1 : 0) : cur.published ?? 1,
    quiz: has('quiz_text') ? (blank(body.quiz_text) ? null : JSON.stringify(parseQuiz(v.str(body.quiz_text, 'quiz_text', { max: 20000 })))) : cur.quiz ?? null,
    category: has('category') ? v.oneOf(body.category, 'category', Object.keys(EDU_CATEGORIES)) : cur.category ?? 'athlete'
  };
  if (!out.title) throw badRequest('Give the lesson a title.');
  if (out.course_id) {
    const course = ctx.db.get('SELECT id, title, audience FROM courses WHERE id = ?', out.course_id);
    if (!course) throw notFound('Course');
    const fits = courseCategory(course.audience);
    if (has('category') && out.category !== fits) throw badRequest(`"${course.title}" is ${EDU_CATEGORIES[fits].toLowerCase()}, so its lessons are too. Make it a stand-alone lesson to put it under ${EDU_CATEGORIES[out.category]}.`);
    out.category = fits;
  }
  return out;
}
export function getLesson(ctx, id) {
  const l = ctx.db.get('SELECT * FROM lessons WHERE id = ?', id);
  if (!l) throw notFound('Lesson');
  const quiz = quizOf(l);
  return { ...l, published: !!l.published, quiz, quiz_text: quiz ? quizText(quiz) : '' };
}
export function createLesson(ctx, body = {}) {
  const f = lessonFields(ctx, body);
  const position = f.course_id ? (ctx.db.get('SELECT MAX(position) AS m FROM lessons WHERE course_id = ?', f.course_id).m ?? -1) + 1 : 0;
  const id = newId('les');
  ctx.db.run('INSERT INTO lessons (id, title, summary, body, video_url, minutes, course_id, position, published, quiz, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, f.title, f.summary, f.body, f.video_url, f.minutes, f.course_id, position, f.published, f.quiz, f.category, ctx.now(), ctx.now());
  return getLesson(ctx, id);
}
export function updateLesson(ctx, id, body = {}) {
  const cur = getLesson(ctx, id);
  const f = lessonFields(ctx, body, { ...cur, published: cur.published ? 1 : 0, quiz: cur.quiz ? JSON.stringify(cur.quiz) : null });
  // Athletes can't open parent or coach's education, so reading assigned to them would be stuck open.
  if (['parent', 'coach'].includes(f.category) && f.category !== cur.category) {
    const n = ctx.db.get('SELECT COUNT(*) AS n FROM lesson_assignments WHERE lesson_id = ?', id).n;
    if (n) throw conflict(`"${cur.title}" is assigned to athletes ${n === 1 ? 'once' : `${n} times`}. Remove ${n === 1 ? 'that assignment' : 'those assignments'} on the Assigned tab first, then move it to ${EDU_CATEGORIES[f.category]}.`);
  }
  const position = f.course_id !== cur.course_id && f.course_id ? (ctx.db.get('SELECT MAX(position) AS m FROM lessons WHERE course_id = ?', f.course_id).m ?? -1) + 1 : cur.position;
  ctx.db.run('UPDATE lessons SET title = ?, summary = ?, body = ?, video_url = ?, minutes = ?, course_id = ?, position = ?, published = ?, quiz = ?, category = ?, updated_at = ? WHERE id = ?',
    f.title, f.summary, f.body, f.video_url, f.minutes, f.course_id, position, f.published, f.quiz, f.category, ctx.now(), id);
  return getLesson(ctx, id);
}
export function deleteLesson(ctx, id) {
  getLesson(ctx, id);
  ctx.db.run('DELETE FROM lessons WHERE id = ?', id);
  return { id, deleted: true };
}
function courseAudience(body, cur = {}) {
  const audience = body.audience === undefined ? cur.audience ?? 'athletes' : v.oneOf(body.audience, 'audience', ['athletes', 'parents']);
  const age = (k) => (body[k] === undefined ? cur[k] ?? null : blank(body[k]) ? null : v.int(body[k], k, { min: 3, max: 25 }));
  const ageMin = age('age_min'), ageMax = age('age_max');
  if (ageMin != null && ageMax != null && ageMin > ageMax) throw badRequest('The youngest age is higher than the oldest. Swap them.');
  return { audience, age_min: audience === 'parents' ? ageMin : null, age_max: audience === 'parents' ? ageMax : null };
}
export function createCourse(ctx, body = {}) {
  const id = newId('crs'), a = courseAudience(body);
  ctx.db.run('INSERT INTO courses (id, title, description, published, audience, age_min, age_max, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, v.str(body.title, 'title', { max: 160 }),
    v.str(body.description, 'description', { max: 1000, optional: true }), body.published === false ? 0 : 1, a.audience, a.age_min, a.age_max, ctx.now());
  return getCourse(ctx, id);
}
export function getCourse(ctx, id) {
  const c = ctx.db.get('SELECT * FROM courses WHERE id = ?', id);
  if (!c) throw notFound('Course');
  return { ...c, published: !!c.published, lessons: ctx.db.all('SELECT id, title, position, published FROM lessons WHERE course_id = ? ORDER BY position, created_at', id).map((l) => ({ ...l, published: !!l.published })) };
}
export function updateCourse(ctx, id, body = {}) {
  const c = getCourse(ctx, id);
  const a = courseAudience(body, c);
  ctx.db.tx(() => {
    ctx.db.run('UPDATE courses SET title = ?, description = ?, published = ?, audience = ?, age_min = ?, age_max = ? WHERE id = ?', body.title !== undefined ? v.str(body.title, 'title', { max: 160 }) : c.title,
      body.description !== undefined ? v.str(body.description, 'description', { max: 1000, optional: true }) : c.description, body.published !== undefined ? (body.published ? 1 : 0) : (c.published ? 1 : 0), a.audience, a.age_min, a.age_max, id);
    ctx.db.run('UPDATE lessons SET category = ? WHERE course_id = ?', courseCategory(a.audience), id);   // a course's lessons follow its audience
  });
  return getCourse(ctx, id);
}
// Deleting a course keeps its lessons in the library.
export function deleteCourse(ctx, id) {
  getCourse(ctx, id);
  ctx.db.tx(() => {
    ctx.db.run('UPDATE lessons SET course_id = NULL WHERE course_id = ?', id);
    ctx.db.run('DELETE FROM courses WHERE id = ?', id);
  });
  return { id, deleted: true };
}
// Reorder a course's lessons in one step: lesson_ids in the new order.
export function reorderCourse(ctx, id, body = {}) {
  const c = getCourse(ctx, id);
  const ids = Array.isArray(body.lesson_ids) ? body.lesson_ids.map(String) : [];
  const mine = new Set(c.lessons.map((l) => l.id));
  if (ids.length !== mine.size || new Set(ids).size !== ids.length || !ids.every((x) => mine.has(x))) throw badRequest('That order doesn\'t match the lessons in this course. Reload the page and try again.');
  ctx.db.tx(() => ids.forEach((lid, i) => ctx.db.run('UPDATE lessons SET position = ? WHERE id = ?', i, lid)));
  return getCourse(ctx, id);
}

// ---------- Assigning reading (coach side) ----------
// Only published work can be assigned: a lesson, or a course with at least one published lesson. Parent courses show in
// the portal on their own. Archived or deleted athletes and teams whose contract ended can't be given new reading, and an
// athlete or team that already has the lesson or course isn't given it twice.
const gone = (c) => String(c?.access_token ?? '').startsWith('gone_');
const LIVE = `c.archived_at IS NULL AND c.access_token NOT LIKE 'gone_%'`;
function assignableItem(ctx, body) {
  if (blank(body.lesson_id) === blank(body.course_id)) throw badRequest('Choose a lesson or a course.');
  const kind = body.lesson_id ? 'lesson' : 'course';
  const item = kind === 'lesson' ? getLesson(ctx, String(body.lesson_id)) : getCourse(ctx, String(body.course_id));
  if (!item.published) throw conflict(`Publish "${item.title}" before assigning it. Athletes only see published ${kind}s.`);
  const forParents = kind === 'course' ? item.audience === 'parents' : !!item.course_id && ctx.db.get(`SELECT 1 FROM courses WHERE id = ? AND audience = 'parents'`, item.course_id);
  if (forParents || (kind === 'lesson' && item.category === 'parent')) throw conflict(`"${item.title}" is for parents. It shows in the parent portal on its own, so there's nothing to assign.`);
  if (kind === 'lesson' && item.category === 'coach') throw conflict(`"${item.title}" is coach's education, for staff and the public page. Athletes don't see it, so it can't be assigned.`);
  if (kind === 'course' && !item.lessons.some((l) => l.published)) throw conflict(`"${item.title}" has no published lessons yet. Add or publish a lesson before assigning it.`);
  return { item, kind };
}
function assignableClient(ctx, id) {
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', String(id));
  if (!c || gone(c)) throw notFound('Athlete');
  if (c.archived_at) throw conflict(`${c.name} is archived. Restore them before assigning reading.`);
  return c;
}
function assignableTeam(ctx, id) {
  const t = ctx.db.get('SELECT t.id, t.name, t.status, o.name AS org_name FROM team_contracts t JOIN organizations o ON o.id = t.org_id WHERE t.id = ?', String(id));
  if (!t) throw notFound('Team');
  if (t.status !== 'active') throw conflict(`${teamLabel(t)}'s contract has ended, so it can't be given new reading.`);
  return t;
}
// A due date is a real day from today to a year out. Empty means no due date. keep: the date already saved (allowed
// even when it has passed, so changing only the note works on an overdue assignment).
function dueDate(ctx, x, { keep = null } = {}) {
  if (blank(x)) return null;
  if (!isDate(x)) throw badRequest('Pick a due date like 2026-12-01.');
  if (x === keep) return x;
  const t = today(ctx);
  if (x < t) throw badRequest('Pick a due date from today on.');
  if (x > addDaysToDate(t, 366)) throw badRequest('Pick a due date within a year.');
  return x;
}
const itemCol = (kind) => (kind === 'lesson' ? 'lesson_id' : 'course_id');
// Why an athlete already has this lesson or course: their own assignment, or one for a team they're on.
function alreadyHas(ctx, kind, itemId, clientId) {
  if (ctx.db.get(`SELECT 1 FROM lesson_assignments WHERE ${itemCol(kind)} = ? AND client_id = ?`, itemId, clientId)) return 'already has it';
  const teams = teamsOf(ctx, clientId);
  const t = teams.length ? ctx.db.get(`SELECT o.name AS org_name, t.name FROM lesson_assignments x JOIN team_contracts t ON t.id = x.contract_id JOIN organizations o ON o.id = t.org_id
    WHERE x.${itemCol(kind)} = ? AND x.contract_id IN (${inList(teams)}) LIMIT 1`, itemId, ...teams) : null;
  return t ? `has it through ${teamLabel(t)}` : null;
}
const assignedEmail = (ctx, c, kind, item, due, note, actor) => notifyAthlete(ctx, c, `New ${kind} for ${firstName(c)}: ${item.title}`,
  `${staffName(actor).split(' ')[0]} assigned "${item.title}" to ${firstName(c)}${due ? ` (due ${fmtDay(due)})` : ''}.${note ? `\n\n${note}` : ''}`, { tab: 'education' });

// Assign a lesson or a course to one athlete, a team (everyone on the roster, including athletes added later), or
// several athletes at once with client_ids (athletes who already have it are skipped and named). Everyone assigned and
// their parents are emailed.
export function assign(ctx, body = {}, actor) {
  if (Array.isArray(body.client_ids)) return assignMany(ctx, body, actor);
  const { item, kind } = assignableItem(ctx, body);
  if (blank(body.client_id) === blank(body.contract_id)) throw badRequest('Choose an athlete or a team.');
  let who, label;
  if (body.client_id) { const c = assignableClient(ctx, body.client_id); who = [c]; label = c.name; }
  else { const t = assignableTeam(ctx, body.contract_id); who = rosterClients(ctx, t.id); label = teamLabel(t); }
  const col = body.client_id ? 'client_id' : 'contract_id', whoId = body.client_id ? who[0].id : String(body.contract_id);
  if (ctx.db.get(`SELECT 1 FROM lesson_assignments WHERE ${itemCol(kind)} = ? AND ${col} = ?`, item.id, whoId)) throw conflict(`${label} already has "${item.title}". Change the due date on that assignment instead.`);
  const due = dueDate(ctx, body.due_date);
  const note = v.str(body.note, 'note', { max: 500, optional: true });
  const id = newId('lasg');
  ctx.db.run('INSERT INTO lesson_assignments (id, lesson_id, course_id, client_id, contract_id, due_date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, kind === 'lesson' ? item.id : null, kind === 'course' ? item.id : null, body.client_id ? whoId : null, body.contract_id ? whoId : null, due, note, actor?.id ?? null, ctx.now());
  for (const c of who) assignedEmail(ctx, c, kind, item, due, note, actor);
  return { id, title: item.title, type: kind, due_date: due, note, assigned_to: label, recipients: who.length };
}
export function assignMany(ctx, body = {}, actor) {
  const { item, kind } = assignableItem(ctx, body);
  const ids = [...new Set(body.client_ids.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean))];
  if (!ids.length) throw badRequest('Choose at least one athlete.');
  if (ids.length > 200) throw badRequest('Assign to 200 athletes or fewer at a time, or assign it to their team.');
  const due = dueDate(ctx, body.due_date);
  const note = v.str(body.note, 'note', { max: 500, optional: true });
  // Every athlete is checked first; nothing is assigned while any of them can't be.
  const rows = ids.map((id) => ctx.db.get('SELECT * FROM clients WHERE id = ?', id));
  const missing = rows.filter((c) => !c || gone(c)).length, archived = rows.filter((c) => c && !gone(c) && c.archived_at);
  if (missing) throw badRequest(`${missing === 1 ? 'One athlete' : `${missing} athletes`} you chose no longer ${missing === 1 ? 'exists' : 'exist'}. Reload the page and choose again.`);
  if (archived.length) throw conflict(`${archived.map((c) => c.name).join(', ')} ${archived.length === 1 ? 'is' : 'are'} archived. Take them off the list, or restore them first.`);
  const skipped = [], todo = [];
  for (const c of rows) { const why = alreadyHas(ctx, kind, item.id, c.id); if (why) skipped.push({ id: c.id, name: c.name, reason: why }); else todo.push(c); }
  if (!todo.length) throw conflict(skipped.length === 1 ? `${skipped[0].name} ${skipped[0].reason} ("${item.title}").` : `Everyone you chose already has "${item.title}".`);
  const assigned = ctx.db.tx(() => todo.map((c) => {
    const id = newId('lasg');
    ctx.db.run('INSERT INTO lesson_assignments (id, lesson_id, course_id, client_id, contract_id, due_date, note, created_by, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)',
      id, kind === 'lesson' ? item.id : null, kind === 'course' ? item.id : null, c.id, due, note, actor?.id ?? null, ctx.now());
    return { id: c.id, name: c.name, assignment_id: id };
  }));
  for (const c of todo) assignedEmail(ctx, c, kind, item, due, note, actor);
  return { title: item.title, type: kind, due_date: due, note, assigned, skipped, recipients: assigned.length };
}
function assignmentRow(ctx, id) {
  const x = ctx.db.get('SELECT * FROM lesson_assignments WHERE id = ?', id);
  if (!x) throw notFound('Assignment');
  return x;
}
// Change the due date (empty removes it) or the note. Nobody is emailed.
export function updateAssignment(ctx, id, body = {}) {
  const x = assignmentRow(ctx, id);
  if (body.due_date === undefined && body.note === undefined) throw badRequest('Send a due_date or a note to change.');
  const due = body.due_date === undefined ? x.due_date : dueDate(ctx, body.due_date, { keep: x.due_date });
  const note = body.note === undefined ? x.note : v.str(body.note, 'note', { max: 500, optional: true });
  ctx.db.run('UPDATE lesson_assignments SET due_date = ?, note = ? WHERE id = ?', due, note, id);
  const { people, ...out } = assignmentView(ctx, progressIndex(ctx), assignmentWithNames(ctx, id), today(ctx));
  return { ...out, people };
}
export function unassign(ctx, id) {
  if (!ctx.db.run('DELETE FROM lesson_assignments WHERE id = ?', id).changes) throw notFound('Assignment');
  return { id, deleted: true };
}
// The athlete (or a parent with them) opened a lesson. Only the first time is kept.
function recordView(ctx, clientId, lessonId) {
  ctx.db.run('INSERT OR IGNORE INTO lesson_views (lesson_id, client_id, opened_at) VALUES (?, ?, ?)', lessonId, clientId, ctx.now());
}
// A copy of a lesson, saved as a draft at the end of the same course.
export function duplicateLesson(ctx, id) {
  const l = getLesson(ctx, id);
  return createLesson(ctx, { title: `${l.title} (copy)`.slice(0, 160), summary: l.summary, body: l.body, video_url: l.video_url, minutes: l.minutes, course_id: l.course_id, published: false, category: l.course_id ? undefined : l.category,
    quiz_text: l.quiz_text || undefined });
}

// ---------- Who has read what ----------
// Everything needed to say where each athlete is on each assignment, loaded once.
function progressIndex(ctx) {
  const done = new Map(), opened = new Map(), courseLessons = new Map();
  const at = (m, k, make) => m.get(k) ?? m.set(k, make()).get(k);
  for (const r of ctx.db.all('SELECT lesson_id, client_id, completed_at FROM lesson_progress')) at(done, r.client_id, () => new Map()).set(r.lesson_id, r.completed_at);
  for (const r of ctx.db.all('SELECT lesson_id, client_id, opened_at FROM lesson_views')) at(opened, r.client_id, () => new Map()).set(r.lesson_id, r.opened_at);
  for (const r of ctx.db.all('SELECT id, course_id FROM lessons WHERE published = 1 AND course_id IS NOT NULL ORDER BY position, created_at')) at(courseLessons, r.course_id, () => []).push(r.id);
  return { done, opened, courseLessons, rosters: new Map() };
}
// Where one athlete is on one assignment: finished (with the date), started part of a course, opened, or not started.
function personStatus(ix, x, c) {
  const mine = ix.done.get(c.id) ?? new Map(), seen = ix.opened.get(c.id) ?? new Map();
  const base = { id: c.id, name: c.name };
  if (x.lesson_id) {
    const doneAt = mine.get(x.lesson_id) ?? null;
    return { ...base, status: doneAt ? 'finished' : seen.has(x.lesson_id) ? 'opened' : 'not_started', completed_at: doneAt, opened_at: seen.get(x.lesson_id) ?? null };
  }
  const ids = ix.courseLessons.get(x.course_id) ?? [];
  const dates = ids.map((id) => mine.get(id)).filter(Boolean).sort();
  const finished = ids.length > 0 && dates.length === ids.length;
  return { ...base, status: finished ? 'finished' : dates.length ? 'started' : ids.some((id) => seen.has(id)) ? 'opened' : 'not_started',
    done: dates.length, of: ids.length, completed_at: finished ? dates.at(-1) : null };
}
const ASSIGNMENT_SQL = `SELECT x.*, l.title AS lesson_title, c.title AS course_title, cl.name AS client_name, cl.archived_at AS client_archived, cl.access_token AS client_token,
    t.name AS team_name, t.status AS team_status, o.name AS org_name, u.name AS assigned_by,
    (SELECT MAX(sent_at) FROM lesson_reminders r WHERE r.assignment_id = x.id) AS reminded_at
  FROM lesson_assignments x LEFT JOIN lessons l ON l.id = x.lesson_id LEFT JOIN courses c ON c.id = x.course_id LEFT JOIN clients cl ON cl.id = x.client_id
  LEFT JOIN team_contracts t ON t.id = x.contract_id LEFT JOIN organizations o ON o.id = t.org_id LEFT JOIN users u ON u.id = x.created_by`;
const assignmentWithNames = (ctx, id) => ctx.db.get(`${ASSIGNMENT_SQL} WHERE x.id = ?`, id);
// One assignment with every athlete's status. Archived athletes are left out (an assignment for one says so), so they
// never make an assignment overdue; a team's roster is today's roster.
function assignmentView(ctx, ix, x, t) {
  const archived = !!x.client_id && (!!x.client_archived || gone({ access_token: x.client_token }));
  let who;
  if (x.client_id) who = archived ? [] : [{ id: x.client_id, name: x.client_name }];
  else {
    if (!ix.rosters.has(x.contract_id)) ix.rosters.set(x.contract_id, rosterClients(ctx, x.contract_id).map((c) => ({ id: c.id, name: c.name })));
    who = ix.rosters.get(x.contract_id);
  }
  const order = { not_started: 0, opened: 1, started: 2, finished: 3 };
  const people = who.map((c) => personStatus(ix, x, c)).sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const finished = people.filter((p) => p.status === 'finished').length;
  // A team whose contract ended keeps its reading, but it's never overdue and nobody on it is reminded.
  const ended = !!x.contract_id && x.team_status !== 'active';
  const status = archived ? 'archived' : people.length && finished === people.length ? 'finished' : x.due_date && x.due_date < t && people.length && !ended ? 'overdue' : 'open';
  return { id: x.id, type: x.lesson_id ? 'lesson' : 'course', lesson_id: x.lesson_id, course_id: x.course_id, title: x.lesson_title ?? x.course_title,
    client_id: x.client_id, contract_id: x.contract_id, assigned_to: x.client_id ? x.client_name : `${x.org_name} ${x.team_name}`, archived, team_ended: ended,
    due_date: x.due_date, note: x.note, created_at: x.created_at, assigned_by: x.assigned_by ?? null, reminded_at: x.reminded_at ?? null, status,
    finished, total: people.length, opened: people.filter((p) => p.status === 'opened' || p.status === 'started').length,
    not_finished: people.filter((p) => p.status !== 'finished').map((p) => ({ id: p.id, name: p.name })).slice(0, 50), people };
}
const STATUS_ORDER = { overdue: 0, open: 1, finished: 2, archived: 3 };
const byUrgency = (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31') || b.created_at.localeCompare(a.created_at);
function allAssignments(ctx, ix = progressIndex(ctx)) {
  const t = today(ctx);
  return ctx.db.all(`${ASSIGNMENT_SQL} ORDER BY x.created_at DESC LIMIT 1000`).map((x) => assignmentView(ctx, ix, x, t)).sort(byUrgency);
}

// The Education screen: summary numbers, every assignment with each athlete's status (overdue first), every course and
// lesson with how many finished and opened, and the latest lessons finished. Archived athletes aren't counted.
export function educationReport(ctx) {
  const ix = progressIndex(ctx);
  const lessons = ctx.db.all(`SELECT l.*,
      (SELECT COUNT(*) FROM lesson_progress p JOIN clients c ON c.id = p.client_id WHERE p.lesson_id = l.id AND ${LIVE}) AS completions,
      (SELECT COUNT(*) FROM lesson_views w JOIN clients c ON c.id = w.client_id WHERE w.lesson_id = l.id AND ${LIVE} AND NOT EXISTS (SELECT 1 FROM lesson_progress p WHERE p.lesson_id = w.lesson_id AND p.client_id = w.client_id)) AS opened,
      (SELECT COUNT(*) FROM lesson_assignments x WHERE x.lesson_id = l.id) AS assigned
    FROM lessons l ORDER BY l.position, l.created_at`)
    .map((l) => ({ id: l.id, title: l.title, summary: l.summary, minutes: l.minutes, has_video: !!l.video_url, has_quiz: !!l.quiz, course_id: l.course_id, category: l.category, position: l.position, published: !!l.published,
      completions: l.completions, opened: l.opened, assigned: l.assigned, updated_at: l.updated_at }));
  const courses = ctx.db.all('SELECT * FROM courses ORDER BY created_at').map((c) => ({ id: c.id, title: c.title, description: c.description, published: !!c.published, lessons: lessons.filter((l) => l.course_id === c.id),
    certificates: ctx.db.get('SELECT COUNT(*) AS n FROM course_certificates WHERE course_id = ?', c.id).n, for_sale: !!c.for_sale && c.price_cents > 0, audience: c.audience, age_min: c.age_min, age_max: c.age_max,
    assigned: ctx.db.get('SELECT COUNT(*) AS n FROM lesson_assignments WHERE course_id = ?', c.id).n,
    parents_reading: c.audience === 'parents' ? ctx.db.get('SELECT COUNT(DISTINCT p.guardian_id) AS n FROM guardian_lesson_progress p JOIN lessons l ON l.id = p.lesson_id WHERE l.course_id = ?', c.id).n : undefined }));
  const assignments = allAssignments(ctx, ix);
  const since = new Date(Date.parse(ctx.now()) - 7 * 86400000).toISOString();
  const recent = ctx.db.all(`SELECT p.completed_at, p.client_id, c.name, l.id AS lesson_id, l.title, co.title AS course FROM lesson_progress p JOIN clients c ON c.id = p.client_id
      JOIN lessons l ON l.id = p.lesson_id LEFT JOIN courses co ON co.id = l.course_id WHERE ${LIVE} ORDER BY p.completed_at DESC, p.rowid DESC LIMIT 40`);
  const parentCourse = new Set(courses.filter((c) => c.audience === 'parents').map((c) => c.id));
  const stats = {
    open: assignments.filter((x) => x.status === 'open' || x.status === 'overdue').length,
    overdue: assignments.filter((x) => x.status === 'overdue').length,
    finished_7d: ctx.db.get(`SELECT COUNT(*) AS n FROM lesson_progress p JOIN clients c ON c.id = p.client_id WHERE p.completed_at >= ? AND ${LIVE}`, since).n,
    readers_7d: ctx.db.get(`SELECT COUNT(DISTINCT p.client_id) AS n FROM lesson_progress p JOIN clients c ON c.id = p.client_id WHERE p.completed_at >= ? AND ${LIVE}`, since).n,
    published: lessons.filter((l) => l.published && !parentCourse.has(l.course_id) && ['athlete', 'blog', 'research'].includes(l.category)).length, drafts: lessons.filter((l) => !l.published).length,
    by_category: Object.fromEntries(Object.keys(EDU_CATEGORIES).map((k) => [k, lessons.filter((l) => l.category === k).length]))
  };
  return { today: today(ctx), stats, categories: EDU_CATEGORIES, courses, lessons: lessons.filter((l) => !l.course_id), assignments, recent };
}
// One lesson: who finished it and when, who opened it but hasn't finished, and where it's assigned (on its own or with its course).
export function lessonProgress(ctx, lessonId) {
  const l = getLesson(ctx, lessonId);
  const course = l.course_id ? ctx.db.get('SELECT id, title, published, audience FROM courses WHERE id = ?', l.course_id) : null;
  const finished = ctx.db.all(`SELECT c.id, c.name, p.completed_at FROM lesson_progress p JOIN clients c ON c.id = p.client_id WHERE p.lesson_id = ? AND ${LIVE} ORDER BY p.completed_at DESC`, l.id);
  const opened = ctx.db.all(`SELECT c.id, c.name, w.opened_at FROM lesson_views w JOIN clients c ON c.id = w.client_id WHERE w.lesson_id = ? AND ${LIVE}
    AND NOT EXISTS (SELECT 1 FROM lesson_progress p WHERE p.lesson_id = w.lesson_id AND p.client_id = w.client_id) ORDER BY w.opened_at DESC`, l.id);
  const ix = progressIndex(ctx), t = today(ctx);
  const assignments = ctx.db.all(`${ASSIGNMENT_SQL} WHERE x.lesson_id = ? OR (x.course_id IS NOT NULL AND x.course_id = ?) ORDER BY x.created_at DESC`, l.id, l.course_id ?? '')
    .map((x) => assignmentView(ctx, ix, x, t)).map(({ people, not_finished, ...x }) => x);
  return { id: l.id, title: l.title, published: l.published, category: l.category, course: course ? { id: course.id, title: course.title, published: !!course.published, audience: course.audience } : null,
    finished, opened, assignments };
}

// ---------- Reading reminders ----------
// A coach reminds everyone on an assignment who hasn't finished it (and their parents), or every overdue assignment at
// once (one email per athlete listing all of theirs). No spam: an assignment is reminded at most every 12 hours, an
// athlete gets at most one reading reminder every 12 hours, archived athletes are never reminded, and addresses that
// asked for no more emails are left out.
const REMIND_GAP_MS = 12 * 3600000;
function reminderAddresses(ctx, c) {
  const out = new Set(ctx.db.all('SELECT email FROM email_optouts').map((r) => String(r.email).toLowerCase()));
  return { athlete: c.email && !out.has(c.email.toLowerCase()) ? c.email : null,
    parents: c.family_id ? ctx.db.all('SELECT email FROM guardians WHERE family_id = ?', c.family_id).map((g) => g.email).filter((e) => e && !out.has(e.toLowerCase())) : [] };
}
const hoursText = (ms) => { const hrs = Math.max(1, Math.ceil(ms / 3600000)); return `${hrs} ${hrs === 1 ? 'hour' : 'hours'}`; };
// items: Map of client id -> [{ assignment, person }]. One email per athlete (and one to each parent).
function remindAthletes(ctx, items, actor) {
  const since = new Date(Date.parse(ctx.now()) - REMIND_GAP_MS).toISOString();
  const base = ctx.publicUrl ?? '', biz = getSetting(ctx, 'business_name'), coach = staffName(actor).split(' ')[0], t = today(ctx);
  const reminded = [], skipped = [];
  for (const [clientId, list] of items) {
    const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', clientId);
    if (!c || c.archived_at || gone(c)) continue;
    if (ctx.db.get('SELECT 1 FROM lesson_reminders WHERE client_id = ? AND sent_at >= ?', c.id, since)) { skipped.push({ id: c.id, name: c.name, reason: 'reminded in the last 12 hours' }); continue; }
    const to = reminderAddresses(ctx, c);
    if (!to.athlete && !to.parents.length) { skipped.push({ id: c.id, name: c.name, reason: c.email || c.family_id ? 'asked for no more emails' : 'no email on file' }); continue; }
    const lines = list.map(({ assignment: x, person: p }) => `- "${x.title}"${x.type === 'course' && p.of ? ` (${p.done} of ${p.of} lessons done)` : ''}${x.due_date ? `, ${x.due_date < t ? 'was due' : 'due'} ${fmtDay(x.due_date)}` : ''}`).join('\n');
    const subject = list.length === 1 ? `Reminder: ${firstName(c)} has "${list[0].assignment.title}" to finish` : `Reminder: ${firstName(c)} has ${list.length} lessons to finish`;
    const text = `${coach} sent a reminder. ${firstName(c)} still has this to finish:\n\n${lines}`;
    if (to.athlete) sendEmail(ctx, { to: to.athlete, subject, sensitive: true, text: `${text}\n\nOpen your app: ${base}/app?token=${c.access_token}#education\n\n${biz}` }).catch(() => {});
    for (const email of to.parents) sendEmail(ctx, { to: email, subject, text: `${text}\n\nSee it in the parent portal: ${base}/parent\n\n${biz}` }).catch(() => {});
    for (const { assignment: x } of list) ctx.db.run('INSERT INTO lesson_reminders (id, assignment_id, client_id, sent_by, sent_at) VALUES (?, ?, ?, ?, ?)', newId('lrem'), x.id, c.id, actor?.id ?? null, ctx.now());
    reminded.push({ id: c.id, name: c.name });
  }
  return { reminded, skipped };
}
export function remindAssignment(ctx, id, actor) {
  assignmentRow(ctx, id);
  const x = assignmentView(ctx, progressIndex(ctx), assignmentWithNames(ctx, id), today(ctx));
  if (x.archived) throw conflict(`${x.assigned_to} is archived, so nobody is reminded.`);
  if (x.team_ended) throw conflict(`${x.assigned_to}'s contract has ended, so nobody is reminded.`);
  const wait = x.reminded_at ? REMIND_GAP_MS - (Date.parse(ctx.now()) - Date.parse(x.reminded_at)) : 0;
  if (wait > 0) throw conflict(`This was reminded less than 12 hours ago. You can remind again in ${hoursText(wait)}.`);
  const todo = x.people.filter((p) => p.status !== 'finished');
  if (!todo.length) throw conflict(x.total ? 'Everyone has finished it, so there\'s nobody to remind.' : 'Nobody is on this roster yet.');
  const out = remindAthletes(ctx, new Map(todo.map((p) => [p.id, [{ assignment: x, person: p }]])), actor);
  return { id: x.id, title: x.title, ...out };
}
export function remindOverdue(ctx, actor) {
  const since = Date.parse(ctx.now()) - REMIND_GAP_MS;
  const due = allAssignments(ctx).filter((x) => x.status === 'overdue' && !(x.reminded_at && Date.parse(x.reminded_at) > since));
  const items = new Map();
  for (const x of due) for (const p of x.people) if (p.status !== 'finished') { if (!items.has(p.id)) items.set(p.id, []); items.get(p.id).push({ assignment: x, person: p }); }
  if (!items.size) return { assignments: 0, reminded: [], skipped: [] };
  return { assignments: due.length, ...remindAthletes(ctx, items, actor) };
}

// ---------- Parent education ----------
// Courses for parents (recruiting, nutrition, recovery, growth spurts) show in the parent portal under Home → For
// parents. A course with an age range shows to parents with an athlete that age; without one, to every parent.
// Each parent's reading is their own.
export function parentCourses(ctx, guardian) {
  const ages = ctx.db.all('SELECT birth_date FROM clients WHERE family_id = ?', guardian.family_id).map((c) => ageOn(c.birth_date, ctx.now())).filter((a) => a != null);
  const fits = (c) => (c.age_min == null && c.age_max == null) || ages.some((a) => (c.age_min == null || a >= c.age_min) && (c.age_max == null || a <= c.age_max));
  const done = new Set(ctx.db.all('SELECT lesson_id FROM guardian_lesson_progress WHERE guardian_id = ?', guardian.id).map((r) => r.lesson_id));
  return ctx.db.all(`SELECT * FROM courses WHERE audience = 'parents' AND published = 1 ORDER BY created_at`).filter(fits).map((c) => {
    const ls = ctx.db.all('SELECT * FROM lessons WHERE course_id = ? AND published = 1 ORDER BY position, created_at', c.id).map((l) => lessonItem(l, done));
    return { id: c.id, title: c.title, description: c.description, age_min: c.age_min, age_max: c.age_max, lessons: ls, done: ls.filter((l) => l.done).length, total: ls.length, complete: ls.length > 0 && ls.every((l) => l.done) };
  }).filter((c) => c.total > 0);
}
// Stand-alone reading for parents (version 46): parent education, blogs and research, newest first, with what this parent read.
const PARENT_ARTICLE = `published = 1 AND course_id IS NULL AND category IN ('parent','blog','research')`;
export function parentArticles(ctx, guardian) {
  const done = new Set(ctx.db.all('SELECT lesson_id FROM guardian_lesson_progress WHERE guardian_id = ?', guardian.id).map((r) => r.lesson_id));
  return ctx.db.all(`SELECT * FROM lessons WHERE ${PARENT_ARTICLE} ORDER BY created_at DESC LIMIT 100`).map((l) => ({ ...lessonItem(l, done), created_at: l.created_at }));
}
export function parentLesson(ctx, guardian, lessonId) {
  const course = parentCourses(ctx, guardian).find((c) => c.lessons.some((l) => l.id === lessonId));
  if (!course) {
    const a = ctx.db.get(`SELECT * FROM lessons WHERE id = ? AND ${PARENT_ARTICLE}`, lessonId);
    if (!a) throw notFound('Lesson');
    return { id: a.id, title: a.title, summary: a.summary, body: a.body, video_url: a.video_url, minutes: a.minutes, category: a.category, course: null, quiz: null,
      done: !!ctx.db.get('SELECT 1 FROM guardian_lesson_progress WHERE lesson_id = ? AND guardian_id = ?', a.id, guardian.id), next: null, position: null };
  }
  const l = ctx.db.get('SELECT * FROM lessons WHERE id = ?', lessonId), i = course.lessons.findIndex((x) => x.id === lessonId);
  return { id: l.id, title: l.title, summary: l.summary, body: l.body, video_url: l.video_url, minutes: l.minutes, course: { id: course.id, title: course.title }, quiz: null,
    done: course.lessons[i].done, next: course.lessons[i + 1] ? { id: course.lessons[i + 1].id, title: course.lessons[i + 1].title } : null, position: { n: i + 1, of: course.lessons.length } };
}
export function completeParentLesson(ctx, guardian, lessonId, done = true) {
  parentLesson(ctx, guardian, lessonId);
  if (done) ctx.db.run('INSERT OR IGNORE INTO guardian_lesson_progress (lesson_id, guardian_id, completed_at) VALUES (?, ?, ?)', lessonId, guardian.id, ctx.now());
  else ctx.db.run('DELETE FROM guardian_lesson_progress WHERE lesson_id = ? AND guardian_id = ?', lessonId, guardian.id);
  return parentLesson(ctx, guardian, lessonId);
}

// ---------- Coach's education on the public page (/learn) ----------
// Published stand-alone coach's education, for anyone: title, summary, text, video and minutes. Nothing about who read it.
const PUBLIC_LESSON = `published = 1 AND course_id IS NULL AND category = 'coach'`;
export function publicLearn(ctx) {
  return { business_name: getSetting(ctx, 'business_name'),
    data: ctx.db.all(`SELECT id, title, summary, minutes, video_url, created_at FROM lessons WHERE ${PUBLIC_LESSON} ORDER BY created_at DESC LIMIT 200`)
      .map((l) => ({ id: l.id, title: l.title, summary: l.summary, minutes: l.minutes, has_video: !!l.video_url, created_at: l.created_at })) };
}
export function publicLearnLesson(ctx, id) {
  const l = ctx.db.get(`SELECT id, title, summary, body, video_url, minutes, created_at FROM lessons WHERE id = ? AND ${PUBLIC_LESSON}`, String(id));
  if (!l) throw notFound('Lesson');
  return { ...l, business_name: getSetting(ctx, 'business_name') };
}

// Starter parent courses, saved as drafts for the owner to read, edit and publish. General guidance only.
const STARTER_PARENT_COURSES = [
  { title: 'Growth spurts and training', description: 'What changes when your athlete grows fast, and how we adjust.', age_min: 10, age_max: 15, lessons: [
    ['What a growth spurt does', 'Bones grow first; muscles and tendons catch up.', 'During a growth spurt, bones get longer before muscles and tendons catch up. For a while your athlete may feel tight, look clumsy, or lose some speed. That is normal and it passes.\n\nMost girls have their fastest growth around 10 to 14 and most boys around 12 to 16, but every child is different.', 4],
    ['Knee and heel pain', 'Why it happens and when to see a doctor.', 'Pain just below the kneecap or at the back of the heel is common in growing athletes. It usually comes from growth plates being pulled on by tight muscles during a busy season.\n\nTell your coach about it so we can adjust training. See a doctor if pain lasts more than two weeks, wakes them at night, causes limping, or comes with swelling.', 4],
    ['How we adjust training', 'Less jumping volume, more mobility, same effort.', 'When an athlete is growing fast we lower jumping and sprinting volume, add mobility work, and keep strength training light and technical. The goal is to keep them moving well so the gains show up when growth slows down.\n\nThe daily check-in in the app helps: soreness and sleep answers tell us when to back off.', 3]] },
  { title: 'Fueling a young athlete', description: 'Everyday eating, game days and water, without the fads.', age_min: null, age_max: null, lessons: [
    ['Everyday eating', 'Three meals, two snacks, and a plate that is half color.', 'Young athletes need more food than you might think. Aim for three meals and two snacks a day, each with a carbohydrate (bread, rice, pasta, fruit), a protein (eggs, dairy, meat, beans) and something colorful.\n\nSkipping breakfast is the most common reason for a flat afternoon practice.', 4],
    ['Game day', 'What to eat 3 hours, 1 hour and 15 minutes out.', '3 hours before: a normal meal with carbohydrates and some protein.\n\n1 hour before: something small and easy, like a banana or crackers.\n\nAfter: a snack with carbohydrates and protein within an hour, like chocolate milk or a sandwich.', 3],
    ['Water and sports drinks', 'Water first; sports drinks for long, hot sessions.', 'Send a full water bottle to every session. Pale yellow urine is a good sign they are drinking enough.\n\nSports drinks help during long or very hot sessions. For most practices under an hour, water is enough. Energy drinks are not sports drinks and are not recommended for kids.', 3]] },
  { title: 'Recruiting basics for parents', description: 'A calm, general overview. Rules change, so always check the official sources.', age_min: 13, age_max: 18, lessons: [
    ['When to start thinking about it', 'Grades count from 9th grade on.', 'College coaches look at grades as well as ability, and high school grades count from the first day of 9th grade. The most useful thing to do early is keep grades up and keep playing.\n\nContact rules between college coaches and athletes depend on the division, the sport and the athlete\'s grade, and they change often. Check the NCAA, NAIA and NJCAA websites for current rules.', 4],
    ['What coaches look for', 'Film, measurable results, grades and character.', 'Coaches look at game film, measurable results (like the testing numbers in our progress reports), grades and test scores, and how an athlete treats teammates and coaches.\n\nOur printable progress report is a simple way to share testing results with a coach.', 3],
    ['Your role as a parent', 'Support, organize, and let your athlete lead.', 'Coaches want to hear from the athlete, not the parent. Help your athlete keep a list of schools, deadlines and emails, and let them do the talking.\n\nBe wary of services that promise scholarships for a fee. Ask your high school counselor and coach what they recommend.', 3]] }
];
export function addStarterParentCourses(ctx) {
  const made = [];
  ctx.db.tx(() => {
    for (const c of STARTER_PARENT_COURSES) {
      if (ctx.db.get('SELECT id FROM courses WHERE title = ?', c.title)) continue;
      const course = createCourse(ctx, { title: c.title, description: c.description, audience: 'parents', age_min: c.age_min, age_max: c.age_max, published: false });
      for (const [title, summary, body, minutes] of c.lessons) createLesson(ctx, { title, summary, body, minutes, course_id: course.id });
      made.push(course.title);
    }
  });
  return { added: made, message: made.length ? `Added ${made.length} draft ${made.length === 1 ? 'course' : 'courses'} for parents. Read and edit them, then publish.` : 'The starter courses are already here.' };
}

// ---------- The three tabs, as the athlete or a parent sees them ----------
// What happened on each day: workouts finished (with effort), sessions attended (booked classes, walk-in check-ins,
// team sessions), in the business time zone.
function dayDetails(ctx, clientId, from, to) {
  const tz = zone(ctx), lo = zonedToUtc(from, '00:00', tz), hi = zonedToUtc(addDaysToDate(to, 1), '00:00', tz);
  const out = new Map(), on = (iso) => { const d = localDate(iso, tz); if (!out.has(d)) out.set(d, { workouts: [], sessions: [] }); return out.get(d); };
  const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  // A log outlives a deleted program or workout (version 43): it shows the title it had then.
  for (const r of ctx.db.all('SELECT COALESCE(w.title, l.workout_title, \'Workout\') AS title, l.completed_at, l.rpe FROM workout_logs l LEFT JOIN workouts w ON w.id = l.workout_id WHERE l.client_id = ? AND l.completed_at >= ? AND l.completed_at < ? ORDER BY l.completed_at', clientId, lo, hi))
    on(r.completed_at).workouts.push({ title: r.title, time: time(r.completed_at), effort: r.rpe ?? null });
  for (const r of ctx.db.all(`SELECT s.name, s.starts_at FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.status = 'attended' AND s.starts_at >= ? AND s.starts_at < ?
      UNION ALL SELECT s.name, s.starts_at FROM team_attendance a JOIN class_sessions s ON s.id = a.session_id WHERE a.client_id = ? AND s.starts_at >= ? AND s.starts_at < ? ORDER BY 2`, clientId, lo, hi, clientId, lo, hi))
    on(r.starts_at).sessions.push({ name: r.name, time: time(r.starts_at) });
  for (const r of ctx.db.all('SELECT k.created_at, l.name FROM check_ins k JOIN locations l ON l.id = k.location_id WHERE k.client_id = ? AND k.created_at >= ? AND k.created_at < ? ORDER BY k.created_at', clientId, lo, hi))
    on(r.created_at).sessions.push({ name: `Checked in at ${r.name}`, time: time(r.created_at) });
  return out;
}
export function accountability(ctx, clientId, { guardianId } = {}) {
  clientRow(ctx, clientId);
  const t = today(ctx), ws = weekStart(t), from = addDaysToDate(t, -27);
  const days = trainingDays(ctx, clientId, from, t), details = dayDetails(ctx, clientId, from, t);
  const checkins = new Map(ctx.db.all('SELECT * FROM daily_checkins WHERE client_id = ? AND date BETWEEN ? AND ?', clientId, from, t).map((r) => [r.date, r]));
  const messages = messagesFor(ctx, clientId, 50, { guardianId });
  return {
    today: t, week_start: ws,
    streaks: { active_weeks: activeWeekStreak(ctx, clientId), checkin_days: checkinStreak(ctx, clientId), best_checkin_days: bestCheckinStreak(ctx, clientId) },
    this_week: counts(ctx, clientId, ws, addDaysToDate(ws, 6)), this_month: counts(ctx, clientId, `${t.slice(0, 8)}01`, t),
    // Each day of the last four weeks, with what happened on it (tap a day to see it).
    calendar: Array.from({ length: 28 }, (_, i) => {
      const d = addDaysToDate(from, i), x = details.get(d) ?? { workouts: [], sessions: [] };
      return { date: d, trained: days.has(d), checked_in: checkins.has(d), workouts: x.workouts, sessions: x.sessions, checkin: shapeCheckin(checkins.get(d)) };
    }),
    checkin_today: shapeCheckin(checkins.get(t)),
    // Yesterday's answers, for "Same as yesterday".
    checkin_yesterday: shapeCheckin(checkins.get(addDaysToDate(t, -1))),
    // The last 7 days, newest first (days without a check-in are left out).
    recent_checkins: [...checkins.values()].filter((c) => c.date >= addDaysToDate(t, -6)).sort((a, b) => b.date.localeCompare(a.date)).map(shapeCheckin),
    goals: goalsFor(ctx, clientId), messages, unread: messages.filter((m) => !m.read).length
  };
}
export function athleteView(ctx, clientId, { parentView = false, guardianId } = {}) {
  const c = clientRow(ctx, clientId);
  return { athlete: { id: c.id, athlete_id: c.athlete_id, name: c.name, first_name: firstName(c) },
    accountability: accountability(ctx, c.id, { guardianId }), performance: performance(ctx, c.id, { parentView }), education: education(ctx, c.id) };
}
// A light summary for the parent portal's athlete list (dots on the tabs).
export function badges(ctx, clientId, { guardianId } = {}) {
  return { unread: messagesFor(ctx, clientId, 200, { guardianId }).filter((m) => !m.read).length, open_assignments: education(ctx, clientId).assigned.filter((x) => !x.done).length,
    checked_in_today: !!ctx.db.get('SELECT 1 FROM daily_checkins WHERE client_id = ? AND date = ?', clientId, today(ctx)) };
}

// Coach view for the client profile: 30-day check-in trends and flags, plus everything the coach set.
export function staffOverview(ctx, clientId) {
  const acc = accountability(ctx, clientId);
  const checkins = ctx.db.all('SELECT * FROM daily_checkins WHERE client_id = ? AND date >= ? ORDER BY date', clientId, addDaysToDate(acc.today, -29)).map(shapeCheckin);
  const avg = (k) => { const vals = checkins.map((c) => c[k]).filter((x) => x != null); return vals.length ? Math.round((vals.reduce((s, x) => s + x, 0) / vals.length) * 10) / 10 : null; };
  const perf = performance(ctx, clientId);
  const edu = education(ctx, clientId);
  return {
    ...acc, checkins, averages: Object.fromEntries(['sleep_hours', ...SCALES].map((k) => [k, avg(k)])),
    flagged: checkins.filter((c) => c.flags.length).reverse().slice(0, 5),
    goals: goalsFor(ctx, clientId).map((g) => ({ ...g, client_goal: !g.team })),
    targets: perf.targets, rankings: perf.rankings, rankings_enabled: perf.rankings_enabled,
    skill_badges: perf.skill_badges,
    tests: perf.tests.map((t) => ({ test: t.test, test_name: t.test_name, unit: t.unit, best: t.best, best_text: t.best_text })),
    education: { assigned: edu.assigned, completed: edu.completed }
  };
}

// Athletes whose latest check-in (today or yesterday) needs a look, for Today.
export function recentFlags(ctx) {
  const on = readinessOn(ctx);
  const since = addDaysToDate(today(ctx), -1);
  const seen = new Set();
  return ctx.db.all('SELECT d.*, c.name, c.athlete_id FROM daily_checkins d JOIN clients c ON c.id = d.client_id WHERE d.date >= ? ORDER BY d.date DESC', since)
    .filter((d) => { if (seen.has(d.client_id)) return false; seen.add(d.client_id); return true; })
    .map((d) => ({ client_id: d.client_id, name: d.name, athlete_id: d.athlete_id, date: d.date, note: d.note, flags: flagsOf(d), readiness: on ? readinessOf(d).level : null }))
    .filter((d) => d.flags.length);
}

// Team side: goals and messages for a roster.
export function teamEngagement(ctx, contractId) {
  const t = teamRow(ctx, contractId);
  return {
    team: { id: t.id, name: teamLabel(t) },
    athletes: rosterClients(ctx, contractId).map((c) => ({ id: c.id, name: c.name })),
    goals: ctx.db.all('SELECT id, title, kind, target, created_at FROM goals WHERE contract_id = ? AND active = 1 ORDER BY created_at', contractId).map((g) => ({ ...g, kind_label: GOAL_KINDS[g.kind] })),
    messages: ctx.db.all('SELECT id, body, staff_name AS coach, created_at FROM coach_messages WHERE contract_id = ? ORDER BY created_at DESC LIMIT 20', contractId),
    assignments: educationReport(ctx).assignments.filter((x) => x.contract_id === contractId)
  };
}
// Team names for pickers (no money).
// Every roster athlete has a profile and the app (version 37); archived athletes aren't reached, so they aren't counted.
export const listTeams = (ctx) => ctx.db.all(`SELECT t.id, t.name, o.name AS org_name,
    (SELECT COUNT(*) FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.contract_id = t.id AND r.active = 1 AND c.archived_at IS NULL) AS roster_count,
    (SELECT COUNT(*) FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.contract_id = t.id AND r.active = 1 AND c.archived_at IS NULL) AS app_athletes
  FROM team_contracts t JOIN organizations o ON o.id = t.org_id WHERE t.status = 'active' ORDER BY o.name, t.name`).map((t) => ({ ...t, label: `${t.org_name} ${t.name}` }));

const RULE_KEYS = ['readiness_wearable', 'readiness_yellow_drop', 'readiness_red_drop', 'readiness_red_sets', 'readiness_recovery_yellow', 'readiness_recovery_red', 'readiness_sleep_yellow_min', 'readiness_sleep_red_min', 'readiness_hrv_drop_pct', 'progression_mode', 'progression_upper_lb', 'progression_lower_lb'];
export function setRankings(ctx, body = {}) {
  const put = (key, on) => ctx.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, on ? 'on' : 'off');
  const flag = (x) => x === 'on' || x === true;
  const rules = Object.fromEntries(RULE_KEYS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  if (body.rankings === undefined && body.rankings_enabled === undefined && body.readiness_adjust === undefined && !Object.keys(rules).length) throw badRequest('Send rankings or readiness_adjust ("on" or "off"), or the readiness and progression rules.');
  if (body.rankings !== undefined || body.rankings_enabled !== undefined) put('rankings', flag(body.rankings) || body.rankings_enabled === true);
  if (body.readiness_adjust !== undefined) put('readiness_adjust', flag(body.readiness_adjust));
  if (Object.keys(rules).length) updateSettings(ctx, rules);   // checked like every other setting (ranges, red below yellow)
  return engagementSettings(ctx);
}
export const engagementSettings = (ctx) => ({ rankings: rankingsOn(ctx) ? 'on' : 'off', readiness_adjust: readinessOn(ctx) ? 'on' : 'off', ...Object.fromEntries(RULE_KEYS.map((k) => [k, getSetting(ctx, k)])) });

// Who can be given reading, for assigning to several athletes at once: every athlete who isn't archived (members and
// team-only athletes), with the active teams they're on and the programs they're following, so a coach can pick by team,
// by program or by hand.
export function assignPicker(ctx) {
  const teamsBy = new Map(), programsBy = new Map();
  for (const r of ctx.db.all(`SELECT DISTINCT r.client_id, r.contract_id FROM team_roster r JOIN team_contracts t ON t.id = r.contract_id WHERE r.active = 1 AND t.status = 'active' AND r.client_id IS NOT NULL`)) {
    if (!teamsBy.has(r.client_id)) teamsBy.set(r.client_id, []);
    teamsBy.get(r.client_id).push(r.contract_id);
  }
  for (const r of ctx.db.all('SELECT DISTINCT client_id, program_id FROM assignments WHERE active = 1')) {
    if (!programsBy.has(r.client_id)) programsBy.set(r.client_id, []);
    programsBy.get(r.client_id).push(r.program_id);
  }
  const athletes = ctx.db.all(`SELECT c.id, c.name, c.athlete_id, EXISTS (SELECT 1 FROM subscriptions s WHERE s.client_id = c.id AND s.status IN ('active', 'trialing')) AS member
    FROM clients c WHERE ${LIVE} ORDER BY c.name`).map((c) => ({ id: c.id, name: c.name, athlete_id: c.athlete_id, member: !!c.member, team_ids: teamsBy.get(c.id) ?? [], program_ids: programsBy.get(c.id) ?? [] }));
  const used = new Set([...programsBy.values()].flat());
  return { athletes, teams: listTeams(ctx).map((t) => ({ id: t.id, label: t.label, roster_count: t.roster_count })),
    programs: ctx.db.all('SELECT id, name FROM programs ORDER BY name').filter((p) => used.has(p.id)) };
}
