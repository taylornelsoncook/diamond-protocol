// Athlete maxes (owner decision: athletes and parents keep their own maxes, and when nothing is tested or typed the
// weight comes from an estimate out of their logged sets, so percent-of-max programs work for every athlete).
// A typed max is a perf_results row on the lift's 1RM test with no testing day and source athlete, parent or coach,
// so testing history, PRs, the progress report and the charts already know it, and the family sees it at once
// (performance.parentFilter). Estimates are never stored: on read, the best Epley estimate (weight × (1 + reps/30))
// from sets of 1 to 12 reps in the last ESTIMATE_DAYS on an exercise that is that lift (LIFT_NAMES).
import { badRequest, notFound, isDate, addDaysToDate, localDate } from '../util.js';
import { getSetting } from './families.js';
import { recordResults, getTest, rangeOf, parentFilter, voidResult } from './performance.js';
import { LOAD_TESTS, latestMax } from './programs.js';

export const ESTIMATE_DAYS = 90;
export const TREND_WEEKS = 26;
// Library names that count as each lift (matched after lower-casing and dropping anything in brackets).
export const LIFT_NAMES = {
  squat_1rm: ['back squat', 'barbell back squat', 'squat', 'high bar back squat', 'low bar back squat', 'barbell squat'],
  bench_1rm: ['bench press', 'barbell bench press', 'flat bench press', 'bench', 'flat barbell bench press'],
  power_clean_1rm: ['power clean', 'clean', 'barbell power clean', 'power clean from the floor', 'hang power clean']
};
const SOURCE_TEXT = { athlete: 'entered in the app', parent: 'entered by a parent', coach: 'entered by a coach', manual: 'testing day', stopwatch: 'testing day', api: 'device', estimated: 'estimated from sets' };
const norm = (s) => String(s ?? '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
export function liftExercises(ctx, testKey) {
  const names = new Set(LIFT_NAMES[testKey] ?? []);
  return ctx.db.all('SELECT id, name FROM exercises').filter((e) => names.has(norm(e.name))).map((e) => e.id);
}
const E1RM = 's.weight * (1 + CASE WHEN s.reps <= 1 THEN 0 ELSE s.reps / 30.0 END)';
const inList = (ids) => ids.map(() => '?').join(', ');
const round5 = (x) => Math.max(5, Math.round(x / 5) * 5);
const limitOf = (ctx, testKey) => { const t = getTest(ctx, testKey); const m = t.metrics.find((x) => x.key === 'load') ?? t.metrics[0]; return rangeOf(t, m); };

// The best estimate from recent sets, or null. Sets whose estimate isn't a possible value for the lift (a typo) are left out.
export function estimatedMax(ctx, clientId, testKey, { days = ESTIMATE_DAYS } = {}) {
  const ids = liftExercises(ctx, testKey);
  if (!ids.length) return null;
  const [lo, hi] = limitOf(ctx, testKey);
  const since = addDaysToDate(localDate(ctx.now(), getSetting(ctx, 'timezone')), -days);
  const row = ctx.db.get(`SELECT s.weight, s.reps, s.exercise_name, l.completed_at, ${E1RM} AS e1rm FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id
    WHERE l.client_id = ? AND s.exercise_id IN (${inList(ids)}) AND s.weight > 0 AND s.reps BETWEEN 1 AND 12 AND l.completed_at >= ?
      ${lo != null ? `AND ${E1RM} >= ${Number(lo)}` : ''} ${hi != null ? `AND ${E1RM} <= ${Number(hi)}` : ''}
    ORDER BY e1rm DESC, l.completed_at DESC LIMIT 1`, clientId, ...ids, since);
  if (!row) return null;
  return { value: round5(row.e1rm), exact: Math.round(row.e1rm), date: row.completed_at, from: { weight: row.weight, reps: row.reps, exercise_name: row.exercise_name } };
}
// Weekly best estimate over the last TREND_WEEKS weeks, for the chart: [{ date (the week's Monday), value }].
export function trend(ctx, clientId, exerciseIds, { weeks = TREND_WEEKS } = {}) {
  if (!exerciseIds.length) return [];
  const since = addDaysToDate(localDate(ctx.now(), getSetting(ctx, 'timezone')), -7 * weeks);
  const rows = ctx.db.all(`SELECT substr(l.completed_at, 1, 10) AS date, MAX(${E1RM}) AS e1rm FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id
    WHERE l.client_id = ? AND s.exercise_id IN (${inList(exerciseIds)}) AND s.weight > 0 AND s.reps BETWEEN 1 AND 12 AND l.completed_at >= ? GROUP BY date ORDER BY date`, clientId, ...exerciseIds, since);
  const byWeek = new Map();
  for (const r of rows) {
    const wd = new Date(`${r.date}T12:00:00Z`).getUTCDay();
    const monday = addDaysToDate(r.date, -((wd + 6) % 7));
    byWeek.set(monday, Math.max(byWeek.get(monday) ?? 0, r.e1rm));
  }
  return [...byWeek.entries()].map(([date, value]) => ({ date, value: Math.round(value) }));
}
// The typed and tested maxes on file for a lift, newest first (only what the family may see when parentView).
function recorded(ctx, clientId, testKey, { parentView }) {
  return ctx.db.all(`SELECT r.id, r.value, r.recorded_at, r.source, r.notes, r.session_id FROM perf_results r JOIN perf_tests t ON t.id = r.test_id
    WHERE r.client_id = ? AND t.key = ? AND r.metric = 'load' AND r.voided = 0 ${parentView ? parentFilter(ctx) : ''} ORDER BY r.recorded_at DESC, r.rowid DESC`, clientId, testKey)
    .map((r) => ({ id: r.id, value: r.value, date: r.recorded_at, source: r.source, source_text: SOURCE_TEXT[r.source] ?? (r.source.startsWith('csv:') ? 'file' : r.source), note: r.notes, own: !r.session_id && ['athlete', 'parent'].includes(r.source) }));
}
// Every lift a program can load from: the max on file, the estimate from sets, which one weights use, and the trend.
export function maxesFor(ctx, clientId, { parentView = false } = {}) {
  if (!ctx.db.get('SELECT id FROM clients WHERE id = ?', clientId)) throw notFound('Client');
  const lifts = Object.entries(LOAD_TESTS).map(([test, lift]) => {
    const history = recorded(ctx, clientId, test, { parentView });
    const on = latestMax(ctx, clientId, test, { visibleOnly: parentView });
    const estimate = estimatedMax(ctx, clientId, test);
    const rec = on ? history.find((h) => h.value === on.value && h.date === on.recorded_at) ?? { value: on.value, date: on.recorded_at } : null;
    const using = rec ? 'recorded' : estimate ? 'estimate' : null;
    // An estimate well above the max on file (5 percent or more) is worth saving: the athlete is stronger than the file says.
    const suggest = estimate && (!rec || estimate.value >= rec.value * 1.05) ? estimate.value : null;
    return { test, lift, unit: 'lb', recorded: rec, estimate, using, value: rec?.value ?? estimate?.value ?? null, suggest: suggest && suggest !== rec?.value ? suggest : null,
      history: [...history].reverse().map((h) => ({ date: h.date.slice(0, 10), value: h.value, source: h.source })), trend: trend(ctx, clientId, liftExercises(ctx, test)) };
  });
  return { lifts, exercises: strengthByExercise(ctx, clientId), estimate_days: ESTIMATE_DAYS };
}
// Strength by exercise: every exercise with weights logged in the trend window, best estimate, latest, and the trend.
export function strengthByExercise(ctx, clientId, { limit = 12 } = {}) {
  const since = addDaysToDate(localDate(ctx.now(), getSetting(ctx, 'timezone')), -7 * TREND_WEEKS);
  const rows = ctx.db.all(`SELECT s.exercise_id, s.exercise_name AS name, COUNT(*) AS sets, MAX(${E1RM}) AS best, MAX(s.weight) AS top FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id
    WHERE l.client_id = ? AND s.exercise_id IS NOT NULL AND s.weight > 0 AND s.reps BETWEEN 1 AND 12 AND l.completed_at >= ? GROUP BY s.exercise_id ORDER BY sets DESC, best DESC LIMIT ?`, clientId, since, limit);
  return rows.map((r) => {
    const t = trend(ctx, clientId, [r.exercise_id]);
    return { exercise_id: r.exercise_id, name: r.name, sets: r.sets, best: Math.round(r.best), top: r.top, latest: t.at(-1)?.value ?? null, first: t[0]?.value ?? null, trend: t };
  });
}
// After a workout: lifts whose estimate from sets is now well above the max on file (or there is none), for the done
// screen's one-tap save.
export function suggestions(ctx, clientId) {
  return maxesFor(ctx, clientId, { parentView: true }).lifts.filter((l) => l.suggest).map((l) => ({ test: l.test, lift: l.lift, value: l.suggest, on_file: l.recorded?.value ?? null }));
}
// Save a max someone typed. by: athlete, parent or coach. value in lb (or unit kg); date today or earlier, within two years.
export function saveMax(ctx, clientId, body = {}, { by = 'athlete', name = null } = {}) {
  if (!ctx.db.get('SELECT id FROM clients WHERE id = ?', clientId)) throw notFound('Client');
  const test = String(body.test ?? '');
  if (!LOAD_TESTS[test]) throw badRequest(`test must be one of: ${Object.keys(LOAD_TESTS).join(', ')}.`);
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0) throw badRequest('Enter the max as a number of pounds, like 185.');
  const unit = body.unit === 'kg' ? 'kg' : 'lb';
  const today = localDate(ctx.now(), getSetting(ctx, 'timezone'));
  let date = today;
  if (body.date !== undefined && body.date !== null && body.date !== '') {
    date = String(body.date).slice(0, 10);
    if (!isDate(date)) throw badRequest('date must be a day like 2026-10-05.');
    if (date > today) throw badRequest('The date can\'t be in the future.');
    if (date < addDaysToDate(today, -730)) throw badRequest('The date can\'t be more than two years ago.');
  }
  const notes = body.note != null && String(body.note).trim() ? String(body.note).trim().slice(0, 200) : null;
  const out = recordResults(ctx, [{ client_id: clientId, test, metric: 'load', value, unit, recorded_at: `${date}T12:00:00.000Z`, notes, device: name ? `${by}: ${name}`.slice(0, 80) : by }], { source: by, queue: false, internal: true });
  if (out.errors.length) throw badRequest(out.errors[0].message);
  const saved = out.results[0];   // recordResults answers a count in created and the rows in results
  return { saved: { id: saved.id, test, value: saved.value, date, pr: saved.pr, first: saved.first }, ...maxesFor(ctx, clientId, { parentView: by !== 'coach' }) };
}
// Take back a max someone typed (never a testing day's result). The athlete and the family may remove their own.
export function removeMax(ctx, clientId, id, { ownOnly = true } = {}) {
  const r = ctx.db.get('SELECT id, source, session_id FROM perf_results WHERE id = ? AND client_id = ? AND voided = 0', String(id), clientId);
  if (!r) throw notFound('That max');
  if (ownOnly && (r.session_id || !['athlete', 'parent'].includes(r.source))) throw badRequest('Only a max entered in the app or the portal can be removed here. Ask your coach about the others.');
  if (r.session_id) throw badRequest('That result is from a testing day. Remove it from Testing.');
  voidResult(ctx, r.id);
  return { removed: true, ...maxesFor(ctx, clientId, { parentView: ownOnly }) };
}
