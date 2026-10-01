// Sprint analysis (schema 65): a clip of one rep (top speed, acceleration or change of direction) is filmed side-on,
// uploaded straight from the phone to the private clips bucket (the form-check bucket, under sprint/), and a coach
// marks the key frames (toe-off, max vertical projection, touchdown, full support for two steps, or the four moments of
// a cut) and taps the body points on each. From those this works out the angles (thigh separation, knee angles, shin
// and trunk), grades each one against the reference (A on it, B a little off, C well off; a position takes its weakest
// measure, the rep the average), and the timing (ground contact, flight, step rate and distance per step). Nothing
// worked out is stored: the marks and points are, and everything else is computed on read, so a changed reference
// re-grades every clip. The method follows the kinogram positions ALTIS teaches; the reference numbers are starting
// values the owner replaces (PATCH /v1/sprint/references).
//
// Athletes (and parents through the family's Workout tab) upload a rep and see the analysis once a coach sends it;
// coaches upload for any athlete, mark, compare and send. Front desk has no part. Clips are videos of minors: they never
// touch this server's disk, live only in the private bucket, are played through 10-minute signed addresses, are
// removed with the clip or the family, and uploads that never finish go after a day (the form-check cleanup job).
import { newId, v, notFound, conflict, badRequest, HttpError } from '../util.js';
import { rateLimit } from './security.js';
import { emit } from './events.js';
import { sendMessage } from './engage.js';
import * as store from './formchecks.js';

export const MAX_BYTES = 150 * 1024 * 1024, MAX_SECONDS = 60, PER_DAY = 10;

// ---------- Kinds and positions ----------
const STRIDE = ['toe_off', 'mvp', 'touchdown', 'full_support'];
export const KINDS = {
  top_speed: { label: 'Top speed', steps: 2, positions: STRIDE, finish: true, tip: 'Film side-on at hip height, 10 to 15 m from the lane, after the athlete has built up to top speed.' },
  acceleration: { label: 'Acceleration', steps: 2, positions: STRIDE, finish: true, tip: 'Film side-on from the start through the first 10 m, the camera still, two cones a known distance apart in the lane.' },
  cod: { label: 'Change of direction', steps: 1, positions: ['penultimate', 'plant', 'deepest', 'push_off'], finish: false, tip: 'Film the cut side-on to the plant leg, the whole body in frame from the last step in to the push away.' }
};
export const POSITIONS = {
  toe_off: { label: 'Toe-off', hint: 'The last frame the pushing foot is on the ground.' },
  mvp: { label: 'MVP', hint: 'Max vertical projection: the highest point of the flight.' },
  touchdown: { label: 'Touchdown', hint: 'The first frame the landing foot touches the ground.' },
  full_support: { label: 'Full support', hint: 'The hip right over the foot on the ground.' },
  finish: { label: 'Next toe-off', hint: 'Step 3 leaving the ground: it closes step 2\'s contact.' },
  penultimate: { label: 'Penultimate step', hint: 'The step before the plant, where braking starts.' },
  plant: { label: 'Plant', hint: 'The plant foot touching down.' },
  deepest: { label: 'Deepest point', hint: 'The lowest point over the plant leg.' },
  push_off: { label: 'Push-off', hint: 'The plant foot leaving the ground.' }
};
// The points a coach taps. "Swing" is the leg in the air moving forward (the recovery leg); "stance" is the leg that
// pushed, is about to land or is on the ground. foot = where the stance foot meets the ground (for distance per step).
export const LANDMARKS = {
  shoulder: 'Shoulder', hip: 'Hip', knee_swing: 'Knee of the swing leg', ankle_swing: 'Ankle of the swing leg',
  knee_stance: 'Knee of the stance leg', ankle_stance: 'Ankle of the stance leg', foot: 'Stance foot on the ground'
};
// What each measure needs, how it's read, and what to say when it's off (more = over the reference, less = under).
export const MEASURES = {
  thigh_separation: { label: 'Thigh separation', needs: ['hip', 'knee_swing', 'knee_stance'], more: 'The thighs are split wider than the reference.', less: 'The thighs are closer together than the reference.' },
  swing_knee: { label: 'Front knee', needs: ['hip', 'knee_swing', 'ankle_swing'], more: 'The swing knee is more open than the reference.', less: 'The swing knee is more folded than the reference.' },
  stance_knee: { label: 'Stance knee', needs: ['hip', 'knee_stance', 'ankle_stance'], more: 'The stance knee is straighter than the reference.', less: 'The stance knee is more bent than the reference.' },
  shin_angle: { label: 'Shin angle', needs: ['knee_stance', 'ankle_stance'], more: 'The shin leans forward more than the reference.', less: 'The foot lands ahead of the knee: the shin leans back.' },
  shin_lean: { label: 'Shin lean', needs: ['knee_stance', 'ankle_stance'], more: 'The shin is laid over more than the reference.', less: 'The shin is more upright than the reference.' },
  trunk_lean: { label: 'Trunk lean', needs: ['shoulder', 'hip'], more: 'The trunk leans forward more than the reference.', less: 'The trunk is more upright than the reference.' },
  trunk_lean_any: { label: 'Trunk lean', needs: ['shoulder', 'hip'], more: 'The trunk leans more than the reference.', less: 'The trunk is more upright than the reference.' },
  recovery_thigh: { label: 'Recovery thigh', needs: ['hip', 'knee_swing'], more: 'The recovery thigh is further forward than the reference.', less: 'The recovery thigh is further back than the reference: it comes through late.' }
};
// Starting references in degrees: target, A within ±a, B within ±b, C beyond. The owner replaces them with their own.
const R = (measure, target, a, b) => ({ measure, target, a, b });
export const DEFAULT_REFERENCES = {
  top_speed: {
    toe_off: [R('thigh_separation', 100, 15, 30), R('stance_knee', 160, 12, 25)],
    mvp: [R('thigh_separation', 90, 15, 30), R('swing_knee', 110, 15, 30)],
    touchdown: [R('shin_angle', 0, 6, 14), R('swing_knee', 45, 15, 30)],
    full_support: [R('recovery_thigh', 45, 12, 25), R('stance_knee', 145, 10, 20)]
  },
  acceleration: {
    toe_off: [R('trunk_lean', 45, 10, 20), R('stance_knee', 165, 10, 20)],
    mvp: [R('thigh_separation', 90, 15, 30), R('swing_knee', 110, 15, 30)],
    touchdown: [R('shin_angle', 0, 8, 18), R('swing_knee', 45, 15, 30)],
    full_support: [R('recovery_thigh', 45, 12, 25), R('trunk_lean', 40, 10, 20)]
  },
  cod: {
    penultimate: [R('trunk_lean_any', 5, 10, 20), R('stance_knee', 130, 15, 30)],
    plant: [R('shin_lean', 40, 10, 20), R('trunk_lean_any', 15, 10, 20)],
    deepest: [R('stance_knee', 110, 15, 30), R('trunk_lean_any', 20, 10, 20)],
    push_off: [R('shin_lean', 45, 10, 20), R('stance_knee', 160, 12, 25)]
  }
};

// Per-step measures in the Speedworks style the owner asked for: the hip's travel, thigh angles at toe-off, hip height
// at full support (projection), and how fast the thigh comes through and where the foot lands and leaves against the
// hip (switching). Each has an average band (low..high) per kind; better says which way is good. Distances need a
// scale (two cones). Starting values; the owner replaces them.
export const STEP_METRICS = {
  hip_displacement_m: { label: 'Hip displacement', chapter: 'projection', unit: 'm', better: 'higher', about: 'How far the hip travels from one toe-off to the next.' },
  hip_flexion_deg: { label: 'Hip flexion', chapter: 'projection', unit: '°', better: 'range', about: 'The front thigh forward of vertical at toe-off.' },
  hip_extension_deg: { label: 'Hip extension', chapter: 'projection', unit: '°', better: 'range', about: 'The pushing thigh behind vertical at toe-off.' },
  hip_height_m: { label: 'Hip height', chapter: 'projection', unit: 'm', better: 'higher', about: 'The hip above the ground at full support.' },
  thigh_velocity_dps: { label: 'Thigh angular velocity', chapter: 'switching', unit: '°/s', better: 'higher', about: 'How fast the pushing thigh swings through, from toe-off to touchdown.' },
  touchdown_dist_m: { label: 'Touchdown distance', chapter: 'switching', unit: 'm', better: 'lower', about: 'How far ahead of the hip the foot lands.' },
  takeoff_dist_m: { label: 'Take-off distance', chapter: 'switching', unit: 'm', better: 'range', about: 'How far behind the hip the foot leaves the ground.' }
};
export const CHAPTERS = { projection: '1. Projection', switching: '2. Switching' };
export const DEFAULT_STEP_REFS = {
  top_speed: { hip_displacement_m: [1.95, 2.25], hip_flexion_deg: [60, 75], hip_extension_deg: [20, 35], hip_height_m: [0.8, 0.88], thigh_velocity_dps: [300, 380], touchdown_dist_m: [0.3, 0.45], takeoff_dist_m: [0.45, 0.65] },
  acceleration: { hip_displacement_m: [1.1, 1.5], hip_flexion_deg: [55, 75], hip_extension_deg: [30, 50], hip_height_m: [0.7, 0.82], thigh_velocity_dps: [250, 350], touchdown_dist_m: [-0.1, 0.15], takeoff_dist_m: [0.6, 0.9] }
};

// ---------- References (owner setting sprint_references, JSON over the defaults) ----------
const savedRefs = (ctx) => { try { return JSON.parse(ctx.db.get(`SELECT value FROM settings WHERE key = 'sprint_references'`)?.value ?? '{}') ?? {}; } catch { return {}; } };
export function stepReferences(ctx, saved = savedRefs(ctx)) {
  const out = {};
  for (const [kind, metrics] of Object.entries(DEFAULT_STEP_REFS)) {
    out[kind] = {};
    for (const [k, band] of Object.entries(metrics)) { const s = saved.steps?.[kind]?.[k]; out[kind][k] = Array.isArray(s) && s.length === 2 ? s : band; }
  }
  return out;
}
export function references(ctx) {
  const saved = savedRefs(ctx);
  const out = {};
  for (const [kind, positions] of Object.entries(DEFAULT_REFERENCES)) {
    out[kind] = {};
    for (const [pos, list] of Object.entries(positions)) out[kind][pos] = Array.isArray(saved[kind]?.[pos]) ? saved[kind][pos] : list;
  }
  return out;
}
export function referencesView(ctx) {
  const refs = references(ctx);
  return { kinds: Object.entries(KINDS).map(([key, k]) => ({ key, ...k, positions: k.positions.map((p) => ({ key: p, ...POSITIONS[p], measures: refs[key][p].map((r) => ({ ...r, label: MEASURES[r.measure].label, needs: MEASURES[r.measure].needs })) })) })),
    positions: POSITIONS, landmarks: LANDMARKS, measures: Object.fromEntries(Object.entries(MEASURES).map(([k, m]) => [k, { label: m.label, needs: m.needs }])),
    step_metrics: Object.entries(STEP_METRICS).map(([key, m]) => ({ key, ...m, chapter_label: CHAPTERS[m.chapter] })), step_references: stepReferences(ctx),
    customized: !!ctx.db.get(`SELECT 1 FROM settings WHERE key = 'sprint_references'`) };
}
// body: { references: { kind: { position: [{ measure, target, a, b }] } } } (any kinds and positions; the rest stay), or { reset: true }.
export function saveReferences(ctx, body = {}) {
  if (body.reset) { ctx.db.run(`DELETE FROM settings WHERE key = 'sprint_references'`); return referencesView(ctx); }
  const next = references(ctx), given = body.references ?? {}, steps = stepReferences(ctx);
  if (typeof given !== 'object' || (!body.references && !body.step_references)) throw badRequest('Send references: { kind: { position: [{ measure, target, a, b }] } } and/or step_references: { kind: { metric: [low, high] } }.');
  for (const [kind, metrics] of Object.entries(body.step_references ?? {})) {
    if (!DEFAULT_STEP_REFS[kind]) throw badRequest(`${kind} has no per-step measures (top_speed, acceleration).`);
    for (const [k, band] of Object.entries(metrics ?? {})) {
      if (!STEP_METRICS[k]) throw badRequest(`${k} isn't a per-step measure: ${Object.keys(STEP_METRICS).join(', ')}.`);
      const [lo, hi] = Array.isArray(band) ? band.map(Number) : [NaN, NaN];
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi || Math.abs(lo) > 5000 || Math.abs(hi) > 5000) throw badRequest(`${KINDS[kind].label}, ${STEP_METRICS[k].label}: give [low, high] with low under high.`);
      steps[kind][k] = [Math.round(lo * 100) / 100, Math.round(hi * 100) / 100];
    }
  }
  for (const [kind, positions] of Object.entries(given)) {
    if (!KINDS[kind]) throw badRequest(`${kind} isn't a sprint kind (top_speed, acceleration, cod).`);
    for (const [pos, list] of Object.entries(positions ?? {})) {
      if (!KINDS[kind].positions.includes(pos)) throw badRequest(`${pos} isn't a position of ${KINDS[kind].label.toLowerCase()}.`);
      if (!Array.isArray(list) || list.length < 1 || list.length > 4) throw badRequest(`${KINDS[kind].label}, ${POSITIONS[pos].label}: give 1 to 4 measures.`);
      const seen = new Set();
      next[kind][pos] = list.map((r, i) => {
        const where = `${KINDS[kind].label}, ${POSITIONS[pos].label}, measure ${i + 1}`;
        if (!MEASURES[r?.measure]) throw badRequest(`${where}: measure must be one of ${Object.keys(MEASURES).join(', ')}.`);
        if (seen.has(r.measure)) throw badRequest(`${where}: ${MEASURES[r.measure].label} is listed twice.`);
        seen.add(r.measure);
        const num = (x, f, min, max) => { const n = Number(x); if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${where}: ${f} must be a number from ${min} to ${max}.`); return Math.round(n * 10) / 10; };
        const target = num(r.target, 'the target', -90, 180), a = num(r.a, 'the A band', 1, 60), b = num(r.b, 'the B band', 1, 90);
        if (b <= a) throw badRequest(`${where}: the B band must be wider than the A band.`);
        return { measure: r.measure, target, a, b };
      });
    }
  }
  ctx.db.run(`INSERT INTO settings (key, value) VALUES ('sprint_references', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify({ ...next, steps }));
  return referencesView(ctx);
}

// ---------- The maths ----------
// Points are in the video's own pixels, y downward. dir = +1 when the athlete runs to the right of the frame.
const deg = (r) => (r * 180) / Math.PI;
const between = (o, a, b) => {   // the angle at o between o→a and o→b, 0..180
  const ax = a[0] - o[0], ay = a[1] - o[1], bx = b[0] - o[0], by = b[1] - o[1];
  const n = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return n ? deg(Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / n)))) : null;
};
const fromVertical = (top, bottom, dir) => {   // how far the segment top→bottom leans from vertical; + when top is ahead of bottom
  const dx = (top[0] - bottom[0]) * dir, dy = bottom[1] - top[1];
  return dy === 0 && dx === 0 ? null : deg(Math.atan2(dx, dy));
};
export function measure(key, p, dir = 1) {
  if (!MEASURES[key] || MEASURES[key].needs.some((n) => !Array.isArray(p?.[n]))) return null;
  let val;
  switch (key) {
    case 'thigh_separation': val = between(p.hip, p.knee_swing, p.knee_stance); break;
    case 'swing_knee': val = between(p.knee_swing, p.hip, p.ankle_swing); break;
    case 'stance_knee': val = between(p.knee_stance, p.hip, p.ankle_stance); break;
    case 'shin_angle': val = fromVertical(p.knee_stance, p.ankle_stance, dir); break;
    case 'shin_lean': { const x = fromVertical(p.knee_stance, p.ankle_stance, 1); val = x === null ? null : Math.abs(x); break; }
    case 'trunk_lean': val = fromVertical(p.shoulder, p.hip, dir); break;
    case 'trunk_lean_any': { const x = fromVertical(p.shoulder, p.hip, 1); val = x === null ? null : Math.abs(x); break; }
    case 'recovery_thigh': { const x = fromVertical(p.hip, p.knee_swing, dir); val = x === null ? null : -x; break; }   // knee ahead of the hip = forward
    default: val = null;
  }
  return val === null || !Number.isFinite(val) ? null : Math.round(val);
}
const SCORE = { A: 4, B: 3, C: 2 };
const VERDICT = { A: 'On the reference', B: 'A little off', C: 'Well off' };
export function gradeOf(value, ref) {
  const off = Math.abs(value - ref.target);
  return off <= ref.a ? 'A' : off <= ref.b ? 'B' : 'C';
}
// The rep's grade from its positions' grades: the average, with + and − between letters.
export function repGrade(grades) {
  if (!grades.length) return null;
  const m = grades.reduce((s, g) => s + SCORE[g], 0) / grades.length;
  return m >= 3.85 ? 'A' : m >= 3.6 ? 'A−' : m >= 3.35 ? 'B+' : m >= 2.85 ? 'B' : m >= 2.6 ? 'B−' : m >= 2.35 ? 'C+' : 'C';
}

// ---------- Reading a clip ----------
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const markKey = (step, position) => `${step}:${position}`;
// How many steps a clip marks: a cut is one; top speed and acceleration 2 by default, up to 4 (sprint_clips.steps).
export const stepsOf = (clip) => (KINDS[clip.kind].steps === 1 ? 1 : Math.min(4, Math.max(2, Number(clip.steps) || 2)));
// Everything worked out for one clip: positions with measures and grades, timing per step, the rep's grade.
export function analyse(ctx, clip, marks, refs = references(ctx), stepRefs = null) {
  const kind = KINDS[clip.kind], dir = clip.direction === -1 ? -1 : 1, nSteps = stepsOf(clip);
  const byKey = new Map(marks.map((m) => [markKey(m.step, m.position), { ...m, points: parse(m.points) ?? {} }]));
  const real = (dt) => (dt * clip.file_fps) / clip.capture_fps;   // media seconds → real seconds (a slowed-down file plays longer)
  const positions = [], grades = [];
  for (let step = 1; step <= nSteps; step++) {
    for (const pos of kind.positions) {
      const m = byKey.get(markKey(step, pos));
      const measures = refs[clip.kind][pos].map((ref) => {
        const value = m ? measure(ref.measure, m.points, dir) : null;
        const grade = value === null ? null : gradeOf(value, ref);
        const side = value === null || grade === 'A' ? null : value > ref.target ? 'more' : 'less';
        return { measure: ref.measure, label: MEASURES[ref.measure].label, value, target: ref.target, a: ref.a, b: ref.b, grade, verdict: grade ? VERDICT[grade] : null, cue: side ? MEASURES[ref.measure][side] : null, needs: MEASURES[ref.measure].needs };
      });
      const got = measures.filter((x) => x.grade);
      const grade = got.length ? got.reduce((w, x) => (SCORE[x.grade] < SCORE[w] ? x.grade : w), 'A') : null;   // the weakest measure
      if (grade) grades.push(grade);
      positions.push({ step, position: pos, label: POSITIONS[pos].label, hint: POSITIONS[pos].hint, t: m?.t ?? null, points: m?.points ?? {}, marked: !!m, measures, grade });
    }
  }
  if (kind.finish) {
    const m = byKey.get(markKey(nSteps + 1, 'toe_off'));
    positions.push({ step: nSteps + 1, position: 'toe_off', label: POSITIONS.finish.label, hint: POSITIONS.finish.hint, t: m?.t ?? null, points: m?.points ?? {}, marked: !!m, measures: [], grade: null, finish: true });
  }
  const at = (step, pos) => byKey.get(markKey(step, pos));
  const cal = parse(clip.calibration);
  const scale = cal && Array.isArray(cal.a) && Array.isArray(cal.b) && cal.meters > 0 ? cal.meters / Math.hypot(cal.b[0] - cal.a[0], cal.b[1] - cal.a[1]) : null;
  const steps = [];
  if (clip.kind === 'cod') {
    const plant = at(1, 'plant'), deepest = at(1, 'deepest'), push = at(1, 'push_off');
    steps.push({ step: 1, contact_s: plant && push && push.t > plant.t ? r3(real(push.t - plant.t)) : null,
      braking_s: plant && deepest && deepest.t > plant.t ? r3(real(deepest.t - plant.t)) : null,
      propulsion_s: deepest && push && push.t > deepest.t ? r3(real(push.t - deepest.t)) : null });
  } else {
    for (let s = 1; s <= nSteps; s++) {
      const off = at(s, 'toe_off'), down = at(s, 'touchdown'), next = at(s + 1, 'toe_off');
      const flight = off && down && down.t > off.t ? real(down.t - off.t) : null;
      const contact = down && next && next.t > down.t ? real(next.t - down.t) : null;
      const stepTime = off && next && next.t > off.t ? real(next.t - off.t) : null;
      let length = null, lengthFrom = null;
      const f1 = off?.points?.foot, f2 = next?.points?.foot;
      if (scale && Array.isArray(f1) && Array.isArray(f2)) { length = Math.abs(f2[0] - f1[0]) * scale; lengthFrom = 'cones'; }
      else if (clip.speed_mps && stepTime) { length = clip.speed_mps * stepTime; lengthFrom = 'speed'; }
      steps.push({ step: s, flight_s: r3(flight), contact_s: r3(contact), step_time_s: r3(stepTime), step_rate_hz: stepTime ? Math.round((1 / stepTime) * 100) / 100 : null,
        step_length_m: length === null ? null : Math.round(length * 100) / 100, step_length_from: lengthFrom });
    }
  }
  const avg = (k) => { const xs = steps.map((s) => s[k]).filter((x) => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const timing = { steps, contact_s: r3(avg('contact_s')), flight_s: r3(avg('flight_s')), step_rate_hz: avg('step_rate_hz') == null ? null : Math.round(avg('step_rate_hz') * 100) / 100,
    step_length_m: avg('step_length_m') == null ? null : Math.round(avg('step_length_m') * 100) / 100 };
  const total = nSteps * kind.positions.length + (kind.finish ? 1 : 0), marked = positions.filter((p) => p.marked).length;
  const breakdown = clip.kind === 'cod' ? null : breakdownOf({ clip, at, nSteps, dir, scale, real, refs: (stepRefs ?? stepReferences(ctx))[clip.kind] });
  return { positions, timing, grade: repGrade(grades), marked, total, calibrated: !!scale, steps: nSteps, breakdown };
}

// ---------- The breakdown (per-step measures, chapters and scores) ----------
// A value against its band: tone good / ok / bad, a word, and a 0-100 score (the band's edges are 40 and 70).
export function judge(value, [low, high], better) {
  const width = high - low;
  if (better === 'range') {
    const mid = (low + high) / 2, half = width / 2, off = Math.abs(value - mid);
    const inside = value >= low && value <= high;
    return { tone: inside ? 'good' : 'bad', word: inside ? 'Within the optimal range' : value < low ? 'Under the optimal range' : 'Over the optimal range',
      score: Math.round(Math.max(0, Math.min(100, inside ? 100 - (30 * off) / half : 70 - (70 * (off - half)) / half))) };
  }
  const x = better === 'higher' ? (value - low) / width : (high - value) / width;   // 0 at the poor edge, 1 at the good edge
  const tone = x < 0 ? 'bad' : x > 1 ? 'good' : 'ok';
  const word = better === 'higher' ? (x < 0 ? 'Below average' : x > 1 ? 'Above average' : 'Average') : (x < 0 ? 'Worse than average' : x > 1 ? 'Better than average' : 'Average');
  return { tone, word, score: Math.round(Math.max(0, Math.min(100, 40 + 30 * x))) };
}
const scoreWord = (n) => (n >= 70 ? 'Good' : n >= 40 ? 'Average' : 'Needs work');
function breakdownOf({ clip, at, nSteps, dir, scale, real, refs }) {
  const pts = (m) => m?.points ?? {};
  const has = (p, ...ks) => ks.every((k) => Array.isArray(p[k]));
  const vals = Object.fromEntries(Object.keys(STEP_METRICS).map((k) => [k, []]));
  const add = (k, step, value, mark, extra = {}) => { if (value != null && Number.isFinite(value)) vals[k].push({ step, value, at: { step: mark.step, position: mark.position }, t: mark.t, ...extra }); };
  for (let s = 1; s <= nSteps; s++) {
    const off = at(s, 'toe_off'), down = at(s, 'touchdown'), full = at(s, 'full_support'), next = at(s + 1, 'toe_off');
    const po = pts(off), pd = pts(down), pf = pts(full), pn = pts(next);
    if (off && has(po, 'hip', 'knee_swing')) add('hip_flexion_deg', s, measure('recovery_thigh', po, dir), off);
    if (off && has(po, 'hip', 'knee_stance')) add('hip_extension_deg', s, -measure('recovery_thigh', { hip: po.hip, knee_swing: po.knee_stance }, dir), off);
    if (scale && off && has(po, 'hip', 'foot')) add('takeoff_dist_m', s, (po.hip[0] - po.foot[0]) * dir * scale, off);
    if (scale && down && has(pd, 'hip', 'foot')) add('touchdown_dist_m', s, (pd.foot[0] - pd.hip[0]) * dir * scale, down);
    if (scale && full && has(pf, 'hip', 'foot')) add('hip_height_m', s, (pf.foot[1] - pf.hip[1]) * scale, full);
    if (scale && off && next && has(po, 'hip') && has(pn, 'hip')) add('hip_displacement_m', s, (pn.hip[0] - po.hip[0]) * dir * scale, next, { from: { step: off.step, position: off.position } });
    if (off && down && down.t > off.t && has(po, 'hip', 'knee_stance') && has(pd, 'hip', 'knee_swing')) {
      const before = measure('recovery_thigh', { hip: po.hip, knee_swing: po.knee_stance }, dir), after = measure('recovery_thigh', pd, dir);
      add('thigh_velocity_dps', s, (after - before) / real(down.t - off.t), down, { from: { step: off.step, position: off.position } });
    }
  }
  const round = (k, x) => (STEP_METRICS[k].unit === 'm' ? Math.round(x * 100) / 100 : Math.round(x));
  const chapters = Object.entries(CHAPTERS).map(([key, label]) => {
    const metrics = Object.entries(STEP_METRICS).filter(([, m]) => m.chapter === key).map(([k, m]) => {
      const band = refs[k], values = vals[k].map((x) => { const v = round(k, x.value); return { ...x, value: v, ...judge(v, band, m.better) }; });
      const words = [...new Set(values.map((x) => x.word))];
      const summary = !values.length ? null : words.length === 1 ? `${words[0]} ${values.length === 1 ? 'on the step' : 'in all steps'}` : words.map((w) => `${w} on ${values.filter((x) => x.word === w).length}`).join(', ');
      const tones = values.map((x) => x.tone), tone = !values.length ? null : tones.every((t) => t === 'good') ? 'good' : tones.some((t) => t === 'bad') ? 'bad' : 'ok';
      const score = values.length ? Math.round(values.reduce((a, x) => a + x.score, 0) / values.length) : null;
      return { key: k, label: m.label, unit: m.unit, better: m.better, about: m.about, low: band[0], high: band[1], values, summary, tone, score, needs_scale: m.unit === 'm' && !scale };
    });
    const scored = metrics.filter((m) => m.score != null);
    const score = scored.length ? Math.round(scored.reduce((a, m) => a + m.score, 0) / scored.length) : null;
    return { key, label, score, word: score == null ? null : scoreWord(score), metrics };
  });
  return { chapters, needs_scale: !scale };
}

const shape = (clip, extra = {}) => ({ id: clip.id, client_id: clip.client_id, client_name: clip.client_name, athlete_id: clip.athlete_id, kind: clip.kind, kind_label: KINDS[clip.kind]?.label,
  title: clip.title, note: clip.note, status: clip.status, uploaded_by_kind: clip.uploaded_by_kind, uploaded_by_name: clip.uploaded_by_name, bytes: clip.bytes, duration_s: clip.duration_s,
  capture_fps: clip.capture_fps, file_fps: clip.file_fps, steps: stepsOf(clip), direction: clip.direction, video_w: clip.video_w, video_h: clip.video_h, calibration: parse(clip.calibration),
  speed_mps: clip.speed_mps, rep_time_s: clip.rep_time_s, review_note: clip.review_note, reviewed_at: clip.reviewed_at, reviewed_by_name: clip.reviewed_by_name, seen_at: clip.seen_at,
  created_at: clip.created_at, sent_at: clip.sent_at, ...extra });
const SELECT = `SELECT s.*, c.name AS client_name, c.athlete_id, c.family_id FROM sprint_clips s JOIN clients c ON c.id = s.client_id`;
function rowFor(ctx, id, { clientId = null, familyId = null } = {}) {
  const clip = ctx.db.get(`${SELECT} WHERE s.id = ?`, id);
  if (!clip || clip.status === 'uploading' || (clientId && clip.client_id !== clientId) || (familyId && clip.family_id !== familyId)) throw notFound('Sprint clip');
  return clip;
}
const marksOf = (ctx, id) => ctx.db.all('SELECT * FROM sprint_marks WHERE clip_id = ? ORDER BY step, position', id);
// One clip with its analysis. An athlete sees the analysis only once a coach has sent it.
export function getClip(ctx, id, scope = {}, { athleteView = false } = {}) {
  const clip = rowFor(ctx, id, scope);
  if (athleteView && clip.status !== 'reviewed') return shape(clip, { analysis: null });
  return shape(clip, { analysis: analyse(ctx, clip, marksOf(ctx, id)) });
}
// A list with each clip's grade and timing (for the Sprint screen, the client page and the athlete app).
export function list(ctx, { clientId = null, status = null, kind = null, limit = 100, athleteView = false } = {}) {
  const where = [`s.status != 'uploading'`, 'c.archived_at IS NULL'], args = [];
  if (clientId) { where.push('s.client_id = ?'); args.push(clientId); }
  if (status === 'waiting' || status === 'reviewed') { where.push('s.status = ?'); args.push(status); }
  if (kind) { if (!KINDS[kind]) throw badRequest('kind must be top_speed, acceleration or cod.'); where.push('s.kind = ?'); args.push(kind); }
  const rows = ctx.db.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.sent_at, s.created_at) DESC LIMIT ?`, ...args, Math.min(500, Math.max(1, Number(limit) || 100)));
  const refs = references(ctx), sref = stepReferences(ctx);
  return rows.map((clip) => {
    if (athleteView && clip.status !== 'reviewed') return shape(clip, { grade: null, timing: null, marked: 0 });
    const a = analyse(ctx, clip, marksOf(ctx, clip.id), refs, sref);
    return shape(clip, { grade: a.grade, scores: a.breakdown ? a.breakdown.chapters.map((c) => ({ key: c.key, label: c.label, score: c.score, word: c.word })) : null, timing: { contact_s: a.timing.contact_s, flight_s: a.timing.flight_s, step_rate_hz: a.timing.step_rate_hz, step_length_m: a.timing.step_length_m }, marked: a.marked, total: a.total });
  });
}
// Across one athlete's reps of a kind: each measure's average and spread per position, and the timing over time.
export function summary(ctx, clientId, { athleteView = false } = {}) {
  const refs = references(ctx), sref = stepReferences(ctx), out = {};
  for (const kind of Object.keys(KINDS)) {
    const clips = ctx.db.all(`${SELECT} WHERE s.client_id = ? AND s.kind = ? AND s.status ${athleteView ? `= 'reviewed'` : `!= 'uploading'`} ORDER BY COALESCE(s.sent_at, s.created_at)`, clientId, kind);
    if (!clips.length) continue;
    const reps = clips.map((c) => ({ clip: c, a: analyse(ctx, c, marksOf(ctx, c.id), refs, sref) }));
    const positions = [];
    for (const pos of KINDS[kind].positions) {
      for (const ref of refs[kind][pos]) {
        const vals = reps.flatMap(({ a }) => a.positions.filter((p) => p.position === pos && !p.finish).map((p) => p.measures.find((m) => m.measure === ref.measure)?.value)).filter((x) => x != null);
        if (!vals.length) continue;
        const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
        positions.push({ position: pos, label: POSITIONS[pos].label, measure: ref.measure, measure_label: MEASURES[ref.measure].label, target: ref.target, average: Math.round(mean), low: Math.min(...vals), high: Math.max(...vals), count: vals.length, grade: gradeOf(mean, ref) });
      }
    }
    out[kind] = { label: KINDS[kind].label, reps: reps.map(({ clip, a }) => ({ id: clip.id, date: (clip.sent_at ?? clip.created_at).slice(0, 10), title: clip.title, grade: a.grade, rep_time_s: clip.rep_time_s, ...Object.fromEntries(['contact_s', 'flight_s', 'step_rate_hz', 'step_length_m'].map((k) => [k, a.timing[k]])) })),
      positions, consistent: positions.filter((p) => p.count > 1 && p.high - p.low <= 10).map((p) => `${p.measure_label} at ${p.label.toLowerCase()}`), varies: positions.filter((p) => p.count > 1 && p.high - p.low > 20).map((p) => `${p.measure_label} at ${p.label.toLowerCase()}`) };
  }
  return out;
}

// ---------- Uploading ----------
const num = (val, field, min, max, { optional = true, whole = false } = {}) => {
  if (val === undefined || val === null || val === '') { if (optional) return null; throw badRequest(`${field} is required.`); }
  const n = Number(val);
  if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) throw badRequest(`${field} must be a number from ${min} to ${max}.`);
  return n;
};
const FPS = [24, 25, 30, 50, 60, 120, 240, 480, 960];
const fps = (val, field) => { const n = num(val, field, 1, 1000, { whole: true }); if (n !== null && !FPS.includes(n)) throw badRequest(`${field} must be one of ${FPS.join(', ')} frames a second.`); return n; };
// who: { kind: 'athlete' | 'parent' | 'staff', name, userId }
export function startUpload(ctx, client, body = {}, who) {
  store.needReady();
  if (client.archived_at) throw conflict('This profile is archived, so clips can\'t be added to it.');
  const kind = v.oneOf(body.kind, 'kind', Object.keys(KINDS));
  const contentType = store.typeOf(body.content_type);
  const bytes = v.int(body.bytes, 'bytes', { min: 1, max: MAX_BYTES * 4 });
  if (bytes > MAX_BYTES) throw badRequest(`That clip is ${(bytes / 1024 / 1024).toFixed(0)} MB. Keep sprint clips under ${MAX_BYTES / 1024 / 1024} MB: trim it to the one rep.`);
  const duration = num(body.duration_s, 'duration_s', 0, 3600);
  if (duration !== null && duration > MAX_SECONDS + 1) throw badRequest(`Keep a sprint clip to ${MAX_SECONDS} seconds: trim it to the one rep.`);
  const capture = fps(body.capture_fps, 'capture_fps') ?? 240, file = fps(body.file_fps, 'file_fps') ?? capture;
  const title = v.str(body.title, 'title', { max: 80, optional: true }), note = v.str(body.note, 'note', { max: 500, optional: true });
  const rep = num(body.rep_time_s, 'rep_time_s', 0.3, 30);
  const nSteps = kind === 'cod' ? 1 : (num(body.steps, 'steps', 2, 4, { whole: true }) ?? 2);
  if (who.kind !== 'staff') rateLimit(`sprint:${client.id}`, PER_DAY, 24 * 60 * 60000);
  const id = newId('spr'), key = `sprint/${client.id}/${id}.${store.TYPES[contentType]}`;
  ctx.db.run(`INSERT INTO sprint_clips (id, client_id, kind, title, note, status, uploaded_by_kind, uploaded_by_user, uploaded_by_name, object_key, content_type, bytes, duration_s, capture_fps, file_fps, rep_time_s, steps, created_at)
    VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, client.id, kind, title, note, who.kind, who.userId ?? null, who.name ?? null, key, contentType, bytes, duration, capture, file, rep, nSteps, ctx.now());
  return { id, upload: store.uploadFor(ctx, key, contentType), max_bytes: MAX_BYTES, max_seconds: MAX_SECONDS };
}
export async function finishUpload(ctx, id, { clientId = null } = {}) {
  const clip = ctx.db.get(`${SELECT} WHERE s.id = ?`, id);
  if (!clip || (clientId && clip.client_id !== clientId)) throw notFound('Sprint clip');
  if (clip.status !== 'uploading') return getClip(ctx, id);
  const head = await store.checkObject(ctx, clip.object_key, clip.content_type);
  if (!head.ok) {
    if (head.kind === 'store') throw new HttpError(503, 'storage_unavailable', head.why);
    if (head.kind === 'missing' || head.removed) ctx.db.run('DELETE FROM sprint_clips WHERE id = ?', id);
    throw badRequest(head.why);
  }
  const done = ctx.db.run(`UPDATE sprint_clips SET status = 'waiting', sent_at = ?, bytes = ?, etag = ? WHERE id = ? AND status = 'uploading'`, ctx.now(), head.bytes, head.etag, id);
  if (done.changes === 1) emit(ctx, 'sprint_clip.sent', { sprint_clip_id: id, client_id: clip.client_id, client_name: clip.client_name, kind: clip.kind, by: clip.uploaded_by_kind });
  return getClip(ctx, id);
}
export async function playUrl(ctx, id, scope = {}) {
  const clip = rowFor(ctx, id, scope);
  return store.playObject(ctx, { key: clip.object_key, contentType: clip.content_type, etag: clip.etag, onSwapped: () => ctx.db.run('DELETE FROM sprint_clips WHERE id = ?', id) });
}

// ---------- The coach's work ----------
const point = (p, field, w, h) => {
  if (!Array.isArray(p) || p.length !== 2 || !p.every((x) => Number.isFinite(Number(x)))) throw badRequest(`${field} must be [x, y] in the video's pixels.`);
  const [x, y] = p.map(Number);
  if (x < 0 || y < 0 || x > (w || 10000) || y > (h || 10000)) throw badRequest(`${field} is outside the video.`);
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
};
// Details a coach sets once watching: direction of travel, the real frame rates, the video's size, the cones, speed.
export function updateClip(ctx, id, body = {}) {
  const clip = rowFor(ctx, id), set = {};
  if (body.kind !== undefined) {
    const kind = v.oneOf(body.kind, 'kind', Object.keys(KINDS));
    if (kind !== clip.kind && ctx.db.get('SELECT 1 FROM sprint_marks WHERE clip_id = ?', id) && body.confirm !== true) throw new HttpError(409, 'confirm_needed', 'Changing the kind clears the frames already marked. Send confirm: true to go ahead.');
    if (kind !== clip.kind) { ctx.db.run('DELETE FROM sprint_marks WHERE clip_id = ?', id); set.kind = kind; }
  }
  if (body.steps !== undefined) {
    if (KINDS[set.kind ?? clip.kind].steps === 1) throw badRequest('A change of direction is one cut.');
    set.steps = v.int(body.steps, 'steps', { min: 2, max: 4 });
    // Marks past the new last step go (the last step's closing toe-off stays as the new "next toe-off").
    ctx.db.run(`DELETE FROM sprint_marks WHERE clip_id = ? AND (step > ? OR (step = ? AND position != 'toe_off'))`, id, set.steps + 1, set.steps + 1);
  }
  if (body.title !== undefined) set.title = v.str(body.title, 'title', { max: 80, optional: true });
  if (body.note !== undefined) set.note = v.str(body.note, 'note', { max: 500, optional: true });
  if (body.direction !== undefined) { const d = Number(body.direction); if (d !== 1 && d !== -1) throw badRequest('direction is 1 (running to the right) or -1 (to the left).'); set.direction = d; }
  if (body.capture_fps !== undefined) set.capture_fps = fps(body.capture_fps, 'capture_fps') ?? 240;
  if (body.file_fps !== undefined) set.file_fps = fps(body.file_fps, 'file_fps') ?? (set.capture_fps ?? clip.capture_fps);
  if (body.video_w !== undefined) set.video_w = num(body.video_w, 'video_w', 16, 8000, { whole: true });
  if (body.video_h !== undefined) set.video_h = num(body.video_h, 'video_h', 16, 8000, { whole: true });
  if (body.speed_mps !== undefined) set.speed_mps = num(body.speed_mps, 'speed_mps', 1, 13);
  if (body.rep_time_s !== undefined) set.rep_time_s = num(body.rep_time_s, 'rep_time_s', 0.3, 30);
  if (body.calibration !== undefined) {
    if (body.calibration === null) set.calibration = null;
    else {
      const w = set.video_w ?? clip.video_w, hgt = set.video_h ?? clip.video_h, c = body.calibration;
      const a = point(c.a, 'calibration.a', w, hgt), b = point(c.b, 'calibration.b', w, hgt), meters = num(c.meters, 'calibration.meters', 0.5, 60, { optional: false });
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 20) throw badRequest('Tap the two cones further apart: they look like the same spot.');
      set.calibration = JSON.stringify({ a, b, meters });
    }
  }
  if (Object.keys(set).length) ctx.db.run(`UPDATE sprint_clips SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), id);
  return getClip(ctx, id);
}
// Mark one position: the frame (t, the video's time in seconds) and the points tapped on it (any of LANDMARKS).
export function saveMark(ctx, id, body = {}, user) {
  const clip = rowFor(ctx, id), kind = KINDS[clip.kind], nSteps = stepsOf(clip);
  const step = v.int(body.step, 'step', { min: 1, max: nSteps + (kind.finish ? 1 : 0) });
  const position = v.str(body.position, 'position', { max: 20 });
  const finish = kind.finish && step === nSteps + 1;
  if (finish ? position !== 'toe_off' : !kind.positions.includes(position)) throw badRequest(finish ? `Step ${step} is the next toe-off only.` : `${position} isn't a position of ${kind.label.toLowerCase()}: ${kind.positions.join(', ')}.`);
  const t = num(body.t, 't', 0, 3600, { optional: false });
  if (clip.duration_s && t > clip.duration_s + 0.5) throw badRequest('That time is past the end of the clip.');
  const points = {};
  for (const [k, p] of Object.entries(body.points ?? {})) {
    if (!LANDMARKS[k]) throw badRequest(`${k} isn't a point we use: ${Object.keys(LANDMARKS).join(', ')}.`);
    if (p !== null) points[k] = point(p, k, clip.video_w, clip.video_h);
  }
  ctx.db.run(`INSERT INTO sprint_marks (clip_id, step, position, t, points, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (clip_id, step, position) DO UPDATE SET t = excluded.t, points = excluded.points, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    id, step, position, Math.round(t * 10000) / 10000, JSON.stringify(points), ctx.now(), user?.name ?? null);
  return getClip(ctx, id);
}
export function clearMark(ctx, id, body = {}) {
  rowFor(ctx, id);
  ctx.db.run('DELETE FROM sprint_marks WHERE clip_id = ? AND step = ? AND position = ?', id, v.int(body.step, 'step', { min: 1, max: 5 }), v.str(body.position, 'position', { max: 20 }));
  return getClip(ctx, id);
}
// Send the analysis to the athlete: it shows in their app and the note goes as a coach message (so the usual email goes).
export function review(ctx, id, body = {}, user) {
  const clip = rowFor(ctx, id);
  const note = v.str(body.note, 'note', { max: 1500, optional: true });
  const a = analyse(ctx, clip, marksOf(ctx, id));
  if (!a.marked) throw badRequest('Mark at least one position before sending the analysis.');
  ctx.db.run(`UPDATE sprint_clips SET status = 'reviewed', review_note = ?, reviewed_at = ?, reviewed_by = ?, reviewed_by_name = ?, seen_at = NULL WHERE id = ?`, note, ctx.now(), user?.id ?? null, user?.name ?? null, id);
  const t = a.timing, bits = [a.grade ? `grade ${a.grade}` : null, t.contact_s ? `ground contact ${Math.round(t.contact_s * 1000)} ms` : null, t.step_length_m ? `${t.step_length_m} m a step` : null].filter(Boolean);
  sendMessage(ctx, { clientId: clip.client_id }, { body: `Sprint analysis, ${KINDS[clip.kind].label.toLowerCase()}${bits.length ? ` (${bits.join(', ')})` : ''}: ${note ?? 'Open the Sprint tab in your app to see each position.'}` }, user);
  emit(ctx, 'sprint_clip.reviewed', { sprint_clip_id: id, client_id: clip.client_id, client_name: clip.client_name, kind: clip.kind, grade: a.grade, coach_name: user?.name ?? null });
  return getClip(ctx, id);
}
export function markSeen(ctx, client, id) {
  const clip = rowFor(ctx, id, { clientId: client.id });
  if (clip.status === 'reviewed' && !clip.seen_at) ctx.db.run('UPDATE sprint_clips SET seen_at = ? WHERE id = ?', ctx.now(), id);
  return getClip(ctx, id, { clientId: client.id }, { athleteView: true });
}
export async function remove(ctx, id, scope = {}) {
  const clip = ctx.db.get(`${SELECT} WHERE s.id = ?`, id);
  if (!clip || (scope.clientId && clip.client_id !== scope.clientId) || (scope.familyId && clip.family_id !== scope.familyId)) throw notFound('Sprint clip');
  await store.forget(ctx, clip.object_key);
  ctx.db.run('DELETE FROM sprint_clips WHERE id = ?', id);
  return { id, deleted: true };
}
export async function removeAllFor(ctx, clientId) {
  for (const c of ctx.db.all('SELECT object_key FROM sprint_clips WHERE client_id = ?', clientId)) await store.forget(ctx, c.object_key);
  ctx.db.run('DELETE FROM sprint_clips WHERE client_id = ?', clientId);
}
// The daily job (with the form-check cleanup): uploads that never finished go after a day.
export async function cleanup(ctx) {
  const dayAgo = new Date(Date.parse(ctx.now()) - 86400000).toISOString();
  let removed = 0;
  for (const c of ctx.db.all(`SELECT id, object_key FROM sprint_clips WHERE status = 'uploading' AND created_at < ?`, dayAgo)) { await store.forget(ctx, c.object_key); ctx.db.run('DELETE FROM sprint_clips WHERE id = ?', c.id); removed++; }
  return { removed };
}
export function waitingCount(ctx) {
  return ctx.db.get(`SELECT COUNT(*) AS n FROM sprint_clips s JOIN clients c ON c.id = s.client_id WHERE s.status = 'waiting' AND s.uploaded_by_kind != 'staff' AND c.archived_at IS NULL`).n;
}
// The family export: what was analysed and the coach's notes, never the clip or its address.
export function forExport(ctx, clientId) {
  return ctx.db.all(`SELECT id, kind, title, note, status, uploaded_by_kind, sent_at, reviewed_at, reviewed_by_name, review_note FROM sprint_clips WHERE client_id = ? AND status != 'uploading' ORDER BY sent_at`, clientId)
    .map((c) => { const full = ctx.db.get(`${SELECT} WHERE s.id = ?`, c.id), a = analyse(ctx, full, marksOf(ctx, c.id)); return { ...c, id: undefined, grade: a.grade, timing: a.timing }; });
}
