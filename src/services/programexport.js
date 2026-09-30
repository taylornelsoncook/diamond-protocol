// Export a program (Relay plan step 8): an Excel workbook with a Plan sheet (weeks down, days across, the phase of each
// week), one sheet per workout (every exercise with its set details, load, group, cue and form-check ask, then the
// warm-up and cool-down), and a Phases sheet. The printable page (/program.html?id=) reads the same data through
// GET /v1/programs/:id and /plan and is styled for paper by the browser's print dialog, which saves it as a PDF.
import { getProgram, LOAD_TESTS } from './programs.js';
import { planOf } from './planner.js';
import { getSetting } from './families.js';
import { writeXlsx } from './xlsx.js';

const restText = (s) => (s == null ? '' : s === 0 ? 'none' : s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} s`);
export const loadText = (x) => (x.load_text ? x.load_text : x.load_test ? `${x.load_pct}% of ${LOAD_TESTS[x.load_test] ?? x.load_test} max` : '');
const safeSheetName = (s, taken) => {
  let base = String(s).replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Workout';
  let name = base, n = 2;
  while (taken.has(name.toLowerCase())) { const tail = ` (${n++})`; name = `${base.slice(0, 31 - tail.length)}${tail}`; }
  taken.add(name.toLowerCase());
  return name;
};

export function workbook(ctx, programId) {
  const p = getProgram(ctx, programId);
  const plan = planOf(ctx, programId);
  const business = getSetting(ctx, 'business_name');
  const phaseOf = (week) => plan.phases.find((f) => week >= f.start_week && week <= f.end_week);
  const days = Math.max(1, ...p.workouts.map((w) => w.day));
  const planRows = [['Week', 'Phase', ...Array.from({ length: days }, (_, i) => `Day ${i + 1}`), 'Sets'],
    ...plan.weeks.map((wk) => [wk.week, phaseOf(wk.week)?.name ?? '', ...Array.from({ length: days }, (_, i) => { const w = p.workouts.find((x) => x.week === wk.week && x.day === i + 1); return w ? `${w.title} (${w.exercises.length} ${w.exercises.length === 1 ? 'exercise' : 'exercises'})` : ''; }), wk.sets])];
  const taken = new Set(['plan', 'phases']);
  const sheets = [{ name: 'Plan', rows: [[`${p.name} · ${business}`], [[p.weeks === 1 ? '1 week' : `${p.weeks} weeks`, p.level ?? 'Any level', p.description ?? ''].filter(Boolean).join(' · ')], [], ...planRows], widths: [8, 14, ...Array.from({ length: days }, () => 26), 8] }];
  for (const w of [...p.workouts].sort((a, b) => a.week - b.week || a.day - b.day)) {
    const rows = [['#', 'Exercise', 'Sets', 'Reps', 'Load', 'Tempo', 'Rest', 'Target RPE', 'Group', 'Cue', 'Form check']];
    for (const x of w.exercises) rows.push([x.group_tag ?? '', x.name, x.sets ?? '', x.reps ?? x.prescription ?? '', loadText(x), x.tempo ?? '', restText(x.rest_seconds), x.target_rpe ?? '', x.group_kind ? `${x.group_kind} ${x.group_label}` : '', x.note ?? '', x.form_check ? `Yes${x.form_check_note ? `: ${x.form_check_note}` : ''}` : '']);
    rows.push([]);
    rows.push([`Week ${w.week}, day ${w.day}: ${w.title}`]);
    if (w.warmup) rows.push([`Warm-up: ${w.warmup.name}`, ...(w.warmup.exercises ?? []).map((e) => `${e.name} ${e.prescription ?? ''}`.trim())]);
    if (w.cooldown) rows.push([`Cool-down: ${w.cooldown.name}`, ...(w.cooldown.exercises ?? []).map((e) => `${e.name} ${e.prescription ?? ''}`.trim())]);
    sheets.push({ name: safeSheetName(`W${w.week} D${w.day} ${w.title}`, taken), rows, widths: [5, 30, 6, 10, 26, 8, 8, 10, 12, 40, 30] });
  }
  sheets.push({ name: 'Phases', rows: [['Phase', 'Kind', 'From week', 'To week', 'Note'], ...plan.phases.map((f) => [f.name, f.kind, f.start_week, f.end_week, f.note ?? ''])], widths: [24, 10, 10, 10, 60] });
  const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'program';
  return { filename: `${slug}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsx(sheets) };
}
