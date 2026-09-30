// The mesocycle planner: a program's whole plan on one screen (weeks down, days across), training phases as bands
// across weeks (base, build, peak, deload, test), each week's volume (sets) and intensity (the average percent of a
// tested max and the average target RPE), and a progression that copies one week across a run of weeks changing
// the sets, percents or RPE by a step each week. Phases are labels for the coach: they never change a workout.
import { newId, v, badRequest, notFound } from '../util.js';
import { programDetail, copyWeek, rxText, updateWorkoutExercise, guardLogged } from './programs.js';

export const PHASE_KINDS = { base: 'Base', build: 'Build', peak: 'Peak', deload: 'Deload', test: 'Testing', other: 'Other' };
const MAX_SETS = 12;

const phasesOf = (ctx, programId) => ctx.db.all('SELECT id, program_id, name, kind, start_week, end_week, note FROM program_phases WHERE program_id = ? ORDER BY start_week', programId);
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

// One workout's numbers: sets to log (an exercise with no set count is one set), the average percent of a max and RPE.
function numbersOf(exercises) {
  const sets = exercises.reduce((n, x) => n + (x.sets ?? 1), 0);
  return { exercises: exercises.length, sets, groups: new Set(exercises.map((x) => x.group_label).filter(Boolean)).size,
    avg_pct: avg(exercises.filter((x) => x.load_test).map((x) => x.load_pct)), avg_rpe: avg(exercises.filter((x) => x.target_rpe != null).map((x) => x.target_rpe)) };
}
export function planOf(ctx, programId) {
  const p = programDetail(ctx, programId);
  const phases = phasesOf(ctx, programId);
  const days = Math.max(1, ...p.workouts.map((w) => w.day));
  const weeks = Array.from({ length: p.weeks }, (_, i) => i + 1).map((week) => {
    const ws = p.workouts.filter((w) => w.week === week).map((w) => ({ id: w.id, day: w.day, title: w.title, logs: w.logs, ...numbersOf(w.exercises) }));
    const all = p.workouts.filter((w) => w.week === week).flatMap((w) => w.exercises);
    const n = numbersOf(all);
    return { week, phase_id: phases.find((f) => week >= f.start_week && week <= f.end_week)?.id ?? null, workouts: ws, sets: n.sets, exercises: n.exercises, avg_pct: n.avg_pct, avg_rpe: n.avg_rpe };
  });
  return { program: { id: p.id, name: p.name, weeks: p.weeks }, days, phases, weeks, max_sets: Math.max(1, ...weeks.map((w) => w.sets)), kinds: PHASE_KINDS };
}

// ---- Phases ----
function programRow(ctx, id) {
  const p = ctx.db.get('SELECT id, name, weeks FROM programs WHERE id = ?', id);
  if (!p) throw notFound('Program');
  return p;
}
function phaseInput(ctx, p, body, cur = null, exceptId = null) {
  const kind = body.kind === undefined ? cur?.kind : v.oneOf(body.kind, 'kind', Object.keys(PHASE_KINDS));
  if (!kind) throw badRequest(`Choose what kind of phase it is: ${Object.values(PHASE_KINDS).join(', ')}.`);
  const start = body.start_week === undefined ? cur?.start_week : v.int(body.start_week, 'start_week', { min: 1, max: 52 });
  const end = body.end_week === undefined ? cur?.end_week ?? start : v.int(body.end_week, 'end_week', { min: 1, max: 52 });
  if (start == null) throw badRequest('Choose the first week of the phase.');
  if (end < start) throw badRequest('The phase\'s last week can\'t be before its first.');
  if (end > p.weeks) throw badRequest(`The program is ${p.weeks} ${p.weeks === 1 ? 'week' : 'weeks'} long. Add weeks first, or end the phase by week ${p.weeks}.`);
  const name = body.name === undefined ? cur?.name ?? PHASE_KINDS[kind] : v.str(body.name, 'name', { max: 60, optional: true }) ?? PHASE_KINDS[kind];
  const note = body.note === undefined ? cur?.note ?? null : v.str(body.note, 'note', { max: 500, optional: true });
  const clash = phasesOf(ctx, p.id).find((f) => f.id !== exceptId && start <= f.end_week && end >= f.start_week);
  if (clash) throw badRequest(`Weeks ${start === end ? start : `${start} to ${end}`} overlap ${clash.name} (weeks ${clash.start_week === clash.end_week ? clash.start_week : `${clash.start_week} to ${clash.end_week}`}). Phases don't overlap: shorten one of them.`);
  return { name, kind, start_week: start, end_week: end, note };
}
export function addPhase(ctx, programId, body = {}) {
  const f = phaseInput(ctx, programRow(ctx, programId), body);
  const id = newId('ph');
  ctx.db.run('INSERT INTO program_phases (id, program_id, name, kind, start_week, end_week, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, programId, f.name, f.kind, f.start_week, f.end_week, f.note, ctx.now());
  return phasesOf(ctx, programId).find((x) => x.id === id);
}
export function updatePhase(ctx, id, body = {}) {
  const cur = ctx.db.get('SELECT * FROM program_phases WHERE id = ?', id);
  if (!cur) throw notFound('Phase');
  const f = phaseInput(ctx, programRow(ctx, cur.program_id), body, cur, id);
  ctx.db.run('UPDATE program_phases SET name = ?, kind = ?, start_week = ?, end_week = ?, note = ? WHERE id = ?', f.name, f.kind, f.start_week, f.end_week, f.note, id);
  return phasesOf(ctx, cur.program_id).find((x) => x.id === id);
}
export function deletePhase(ctx, id) {
  const cur = ctx.db.get('SELECT id FROM program_phases WHERE id = ?', id);
  if (!cur) throw notFound('Phase');
  ctx.db.run('DELETE FROM program_phases WHERE id = ?', id);
  return { id, deleted: true };
}
// When a program gets shorter, phases past its end are cut back or dropped (programs.js calls this from setWeeks).
export function trimPhases(ctx, programId, weeks) {
  ctx.db.run('DELETE FROM program_phases WHERE program_id = ? AND start_week > ?', programId, weeks);
  ctx.db.run('UPDATE program_phases SET end_week = ? WHERE program_id = ? AND end_week > ?', weeks, programId, weeks);
}
// A copy of a program takes its phases, within the weeks kept.
export function copyPhases(ctx, fromId, toId, weeks) {
  for (const f of phasesOf(ctx, fromId).filter((f) => f.start_week <= weeks)) {
    ctx.db.run('INSERT INTO program_phases (id, program_id, name, kind, start_week, end_week, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('ph'), toId, f.name, f.kind, f.start_week, Math.min(f.end_week, weeks), f.note, ctx.now());
  }
}

// ---- Progression ----
// Copies week from to weeks to..through, changing every exercise by the steps for each week of distance: week from+2
// gets two steps. sets_step (whole sets, -3 to 3), pct_step (percent of a max, -20 to 20) and rpe_step (-2 to 2 in
// halves); an exercise without that field is left as it is. Results stay within the builder's limits (1 to 12 sets,
// 30 to 110 percent, RPE 1 to 10). Weeks with workouts are replaced only with replace: true, and confirm: true when
// athletes logged them, like copying a week.
const step = (val, name, min, max, halves = false) => {
  if (val === undefined || val === null || val === '') return 0;
  const n = Number(val);
  if (!Number.isFinite(n) || n < min || n > max || (halves ? Math.round(n * 2) !== n * 2 : !Number.isInteger(n))) throw badRequest(`${name} must be a ${halves ? 'number in halves' : 'whole number'} from ${min} to ${max}.`);
  return n;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// Bulk edit (Relay plan step 7): change one exercise everywhere it appears in a run of weeks, in place. Steps move the
// numbers (sets, percent of max, RPE, rest) from where each slot is; reps and tempo replace the text. Slots without the
// field are left alone; results stay within the builder's limits. Workouts athletes already logged need confirm: true.
export function bulkEdit(ctx, programId, body = {}) {
  const p = programDetail(ctx, programId);
  const exerciseId = v.str(body.exercise_id, 'exercise_id');
  const from = v.int(body.from_week ?? 1, 'from_week', { min: 1, max: 52 });
  const to = v.int(body.to_week ?? p.weeks, 'to_week', { min: from, max: 52 });
  const sets = step(body.sets_step, 'sets_step', -6, 6), pct = step(body.pct_step, 'pct_step', -30, 30), rpe = step(body.rpe_step, 'rpe_step', -3, 3, true);
  const rest = body.rest_step === undefined || body.rest_step === null || body.rest_step === '' ? 0 : v.int(body.rest_step, 'rest_step', { min: -600, max: 600 });
  const reps = body.reps === undefined ? undefined : body.reps === null || body.reps === '' ? null : v.str(body.reps, 'reps', { max: 80 });
  const tempo = body.tempo === undefined ? undefined : body.tempo === null || body.tempo === '' ? null : v.str(body.tempo, 'tempo', { max: 20 });
  if (!sets && !pct && !rpe && !rest && reps === undefined && tempo === undefined) throw badRequest('Choose at least one change: sets, percent of max, RPE, rest, reps or tempo.');
  const slots = p.workouts.filter((w) => w.week >= from && w.week <= to).flatMap((w) => w.exercises.filter((x) => x.exercise_id === exerciseId).map((x) => ({ ...x, workout_id: w.id, week: w.week, day: w.day, title: w.title })));
  if (!slots.length) throw badRequest(`That exercise isn't in weeks ${from === to ? from : `${from} to ${to}`} of this program.`);
  guardLogged(ctx, [...new Set(slots.map((s) => s.workout_id))], body.confirm, `Weeks ${from === to ? from : `${from} to ${to}`}`);
  const changed = [];
  ctx.db.tx(() => {
    for (const x of slots) {
      const next = {};
      if (sets && x.sets != null) next.sets = clamp(x.sets + sets, 1, MAX_SETS);
      if (pct && x.load_test) { next.load_test = x.load_test; next.load_pct = clamp(x.load_pct + pct, 30, 110); }
      if (rpe && x.target_rpe != null) next.target_rpe = clamp(Math.round((x.target_rpe + rpe) * 2) / 2, 1, 10);
      if (rest && x.rest_seconds != null) next.rest_seconds = clamp(x.rest_seconds + rest, 0, 1800);
      if (reps !== undefined) next.reps = reps;
      if (tempo !== undefined) next.tempo = tempo;
      if (!Object.keys(next).length) continue;
      updateWorkoutExercise(ctx, x.id, next);
      changed.push({ id: x.id, workout_id: x.workout_id, week: x.week, day: x.day, title: x.title, ...next });
    }
  });
  return { exercise_id: exerciseId, from_week: from, to_week: to, slots: slots.length, changed: changed.length, changes: changed };
}
export function progressWeeks(ctx, programId, body = {}) {
  const p = programDetail(ctx, programId);
  const from = v.int(body.from, 'from', { min: 1, max: 52 });
  const to = v.int(body.to ?? from + 1, 'to', { min: 1, max: 52 });
  const through = body.through === undefined || body.through === null || body.through === '' ? to : v.int(body.through, 'through', { min: to, max: 52 });
  if (to <= from) throw badRequest(`Build forward from week ${from}: choose a week after it to progress into.`);
  const sets = step(body.sets_step, 'sets_step', -3, 3), pct = step(body.pct_step, 'pct_step', -20, 20), rpe = step(body.rpe_step, 'rpe_step', -2, 2, true);
  if (!sets && !pct && !rpe) throw badRequest('Choose at least one change each week: sets, percent of max, or RPE.');
  if (!p.workouts.some((w) => w.week === from)) throw badRequest(`Week ${from} has no workouts to build from.`);
  const adjust = (week) => {
    const k = week - from;
    return (x) => {
      const out = { ...x };
      if (sets && x.sets != null) out.sets = clamp(x.sets + k * sets, 1, MAX_SETS);
      if (pct && x.load_test) out.load_pct = clamp(x.load_pct + k * pct, 30, 110);
      if (rpe && x.target_rpe != null) out.target_rpe = clamp(Math.round((x.target_rpe + k * rpe) * 2) / 2, 1, 10);
      out.prescription = rxText(out);
      return out;
    };
  };
  const out = copyWeek(ctx, programId, from, { to, through, replace: body.replace, confirm: body.confirm }, adjust);
  return { ...out, progressed: { from, to, through, sets_step: sets, pct_step: pct, rpe_step: rpe } };
}
