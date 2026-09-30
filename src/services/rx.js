// How an exercise in a workout is prescribed: separate fields for sets, reps, tempo, rest, a target RPE and a load the
// coach types, plus the group it belongs to (superset, circuit or block). prescription stays the short text the app,
// the weight-room screen and older integrations show ("3 × 8 @ 135 lb"), built from the fields; text typed on its own
// (an older integration, a program read from a PDF) is split into the fields, the best we can tell. No imports, so the
// database upgrade can use it too.
export const MAX_SETS = 12;
export const GROUP_KINDS = { superset: 'Superset', circuit: 'Circuit', block: 'Block' };
export const SET_FIELDS = ['sets', 'reps', 'tempo', 'rest_seconds', 'target_rpe', 'load_text', 'group_label', 'group_kind', 'note', 'form_check', 'form_check_note'];   // form_check: version 61, the coach asks for a clip
export const REST_MAX = 1800;

const RX_SPLIT = /^(\d{1,2})\s*(?:×|x|\*|sets?\s+of)\s*(.+)$/i;
const SETS_ONLY = /^(\d{1,2})\s*sets?$/i;
const RPE_IN = /\s*(?:@\s*)?\bRPE\s*(\d{1,2}(?:\.5)?)\s*$/i;
const LOAD_IN = /\s*@\s*([^@]+)$/;

// "3 × 8 @ 135 lb, RPE 8" → { sets: 3, reps: "8", load_text: "135 lb", target_rpe: 8 }. Text that isn't sets × reps
// is kept whole as the reps ("Warm-up 5 min easy"); more than MAX_SETS sets stays text too.
export function splitRx(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const out = { sets: null, reps: null, load_text: null, target_rpe: null };
  if (!t) return out;
  const rpe = RPE_IN.exec(t);
  if (rpe) { const n = Number(rpe[1]); if (n >= 1 && n <= 10) { out.target_rpe = n; t = t.slice(0, rpe.index).replace(/[,;]\s*$/, '').trim(); } }
  const only = SETS_ONLY.exec(t);
  if (only && Number(only[1]) >= 1 && Number(only[1]) <= MAX_SETS) return { ...out, sets: Number(only[1]) };
  const m = RX_SPLIT.exec(t);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= MAX_SETS) { out.sets = Number(m[1]); t = m[2].trim(); }
  const load = LOAD_IN.exec(t);
  if (load && load[1].trim().length <= 40 && load.index > 0) { out.load_text = load[1].trim(); t = t.slice(0, load.index).trim(); }
  out.reps = t || null;
  return out;
}

// The short text: "3 × 8", "3 × 8 @ 135 lb", "3 sets", "Warm-up 5 min".
export function rxText(f) {
  const sets = f.sets ?? null, reps = f.reps ? String(f.reps).trim() : '';
  const core = sets && reps ? `${sets} × ${reps}` : sets ? `${sets} sets` : reps;
  return [core, f.load_text ? `@ ${String(f.load_text).trim()}` : null].filter(Boolean).join(' ');
}
export function restText(s) {
  if (s === null || s === undefined) return null;
  if (s === 0) return 'none';
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}:${String(r).padStart(2, '0')}` : `${m} min`;
}
// The details line under the sets: "Tempo 3-1-1 · Rest 90 sec · RPE 8".
export function rxDetails(x) {
  return [x.tempo ? `Tempo ${x.tempo}` : null, x.rest_seconds === 0 ? 'No rest' : x.rest_seconds != null ? `Rest ${restText(x.rest_seconds)}` : null,
    x.target_rpe != null ? `RPE ${x.target_rpe}` : null].filter(Boolean).join(' · ') || null;
}

// Reps to count from the reps text: "8" → 8, "8-10" and "5/side" → the low end, time, distance and "max" → null (the
// athlete ticks each set instead of typing reps).
const TIME_OR_DISTANCE = /\d\s*(s|secs?|seconds?|min|mins|minutes?|yds?|yards?|m|meters?|metres?|ft|feet|km|mi|miles?)\b|:\d|\b(amrap|max)\b/i;
export function repCount(reps) {
  const rest = String(reps ?? '').trim();
  if (!rest || TIME_OR_DISTANCE.test(rest)) return null;
  const r = /^(\d{1,3})(?:\s*(?:-|–|—|to)\s*\d{1,3})?(?:\s*(?:\/\s*(?:side|leg|arm)|(?:each|per)(?:\s+(?:side|leg|arm))?|reps?))?\s*$/i.exec(rest);
  return r ? Number(r[1]) : null;
}
// Sets and reps to log for a slot (a row with the fields, a kept snapshot, or prescription text on its own).
export function parseRx(x) {
  let f = x == null || typeof x === 'string' ? splitRx(x) : x.sets != null || x.reps != null ? x : splitRx(x.prescription);
  const big = f.sets == null ? RX_SPLIT.exec(String(f.reps ?? '').trim()) : null;   // "20 × 3" stayed text: never more than MAX_SETS rows to start with
  if (big) f = { sets: Number(big[1]), reps: big[2] };
  const sets = Math.min(Math.max(Number(f.sets) || 1, 1), MAX_SETS);
  return { sets, reps: repCount(f.reps) };
}
// A1, A2... for exercises sharing a group in one workout, and the details line, in order.
export function tagGroups(list) {
  const n = {};
  for (const x of list) {
    x.details = rxDetails(x);
    if (x.group_label) { n[x.group_label] = (n[x.group_label] ?? 0) + 1; x.group_tag = `${x.group_label}${n[x.group_label]}`; }
    else x.group_tag = null;
  }
  return list;
}
