// Bar speed (velocity-based training; owner's ask: "create a connection using API keys so someone can upload their
// information straight to their profile, like from Output VBT devices"). One row per set in vbt_sets, from any device
// or app: pushed to the open API with a results-scope key (POST /v1/vbt/sets), or imported from the system's own
// export (Output Hub, GymAware Cloud and FLEX, Vitruve, Enode, Perch, RepOne, Metric, or any spreadsheet). The athlete
// is found the way results are (performance.resolveAthlete): our Athlete ID, our ids, or a device ID or name the coach
// linked; anything else waits (client_id NULL) until the coach links that device name or ID, never guessed by name.
// Nothing worked out is stored: the load-velocity profile, the estimated max at the minimum velocity threshold and the
// trends are computed on read (profileFor). docs/vbt-devices.md is the research brief behind SYSTEMS and the thresholds.
import { newId, v, badRequest, notFound, localDate, HttpError } from '../util.js';
import { getSetting } from './families.js';
import { resolveAthlete, identityOf, linkAthlete } from './performance.js';
import { parseCsv } from './perf-import.js';
import { readXlsx } from './xlsx.js';
import { emit } from './events.js';

// The systems coaches use, with where each keeps its export and what it offers for a live connection (from the brief).
export const SYSTEMS = {
  output: { label: 'Output Sports (Capture app, Output Hub)', kind: 'IMU sensor', export: 'In Output Hub, open the athlete or group, pick the date range, exercise and metrics, and export the CSV. The Capture app syncs to the Hub whenever it\'s online.',
    api: 'Output offers an Open API on its Pro Teams plan (pre-built for TeamBuildr, Movella and Teamworks). Ask Output for access; a short script, or Output\'s team, can forward each set to the address below with your key.' },
  gymaware: { label: 'GymAware Cloud (RS, PowerTool)', kind: 'linear position transducer', export: 'In GymAware Cloud, CSV export is on the Essentials+ tiers: open the athlete or team, choose the dates and Export.',
    api: 'GymAware\'s Cloud API (cloud.gymaware.com/api/summaries, included with the Premium or Pro Cloud licence) streams one JSON object per set with meanVelocity, peakVelocity, meanPower and peakPower. Post those objects to the address below as they are: the field names are accepted.' },
  flex: { label: 'GymAware FLEX', kind: 'laser bar tracker', export: 'In the FLEX app or GymAware Cloud: Export → CSV (the CSV export is on the Essentials and higher tiers).', api: 'Same cloud as GymAware above.' },
  vitruve: { label: 'Vitruve (Encoder, Teams)', kind: 'linear position transducer', export: 'Vitruve Teams: Progress → the athlete → the exercise → Export → CSV or Excel (30 days, 180 days or everything, by plan). The athlete app exports one day of one exercise at a time.',
    api: 'No public API; export the file.' },
  enode: { label: 'Enode Pro (formerly Vmaxpro)', kind: 'IMU sensor', export: 'In the Enode app: Export → choose the athlete, exercise, metrics and date range → CSV (every plan, the free one too).',
    api: 'API access starts on Enode\'s Trainer plan; ask Enode for the documentation and forward sets to the address below.' },
  perch: { label: 'Perch', kind: '3D camera', export: 'In Perch: Reports → export the collected data as CSV.',
    api: 'Perch\'s API (an optional add-on) gives read-only tokens; its documentation is on GitHub (SBGSports/perch-api-docs). A short script can read your sets from Perch and post them to the address below.' },
  repone: { label: 'RepOne Strength', kind: 'linear position transducer', export: 'Export your training data from the RepOne app (StrengthOS) and upload the file.', api: 'No public API.' },
  metric: { label: 'Metric VBT (phone app)', kind: 'phone camera', export: 'Metric Pro: Export training data (a spreadsheet file) from the app and upload it.', api: 'No API.' },
  other: { label: 'Another device or spreadsheet', kind: '', export: 'Any CSV or Excel file with an exercise, a load and a velocity per set (one row per set, or one per rep). Columns named like the usual ones are matched; the rest is matched by hand.', api: 'Any script can post sets to the address below with a results-scope API key.' }
};
export const PROVIDERS = Object.keys(SYSTEMS);
export const MAX_PER_REQUEST = 1000;
export const PROFILE_DAYS = 90;
const KG_TO_LB = 2.2046226218;

// Minimum velocity thresholds: the mean velocity of a true one-rep max, per lift family (the owner's settings; the
// defaults are the brief's: squat ≈0.30 m/s, bench ≈0.17, deadlift ≈0.15; youth squat studies give 0.28 to 0.29).
// A ballistic lift (cleans, jumps, throws) has no 1RM velocity, so no estimate.
const MVT_RULES = [[/clean|snatch|jerk|jump|throw|swing|slam/, 'ballistic'], [/bench|press|push ?up|dip/, 'bench'], [/deadlift|rdl|pull|row|hinge|hip thrust/, 'deadlift'], [/squat|lunge|split|step ?up/, 'squat']];
export const MVT_DEFAULTS = { squat: 0.30, bench: 0.17, deadlift: 0.15, other: 0.30 };
export function mvtKind(exerciseName) {
  const n = String(exerciseName ?? '').toLowerCase();
  return MVT_RULES.find(([re]) => re.test(n))?.[1] ?? 'other';
}
export function mvtFor(ctx, exerciseName) {
  const kind = mvtKind(exerciseName);
  if (kind === 'ballistic') return { kind, value: null };
  const raw = Number(getSetting(ctx, `vbt_mvt_${kind}`));
  return { kind, value: Number.isFinite(raw) && raw > 0 ? raw : MVT_DEFAULTS[kind] };
}

const normName = (s) => String(s ?? '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const num = (x) => { if (x === undefined || x === null || x === '') return null; const n = Number(String(x).replace(/,/g, '.').replace(/[^0-9.eE+-]/g, '')); return Number.isFinite(n) ? n : NaN; };
const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const round5 = (x) => Math.max(5, Math.round(x / 5) * 5);
function exerciseIdFor(ctx, name) {
  const n = normName(name);
  if (!n) return null;
  return ctx.db.all('SELECT id, name FROM exercises').find((e) => normName(e.name) === n)?.id ?? null;
}

// ---------- One set, checked ----------
// Accepts our field names, the GymAware summary's camelCase ones and a few common spellings; values outside what a
// human can lift or move are refused with the field named.
const FIELD_ALIASES = {
  exercise: ['exercise', 'exercise_name', 'activityName', 'activity', 'movement', 'lift', 'name'],
  performed_at: ['performed_at', 'recorded_at', 'recorded', 'date', 'datetime', 'timestamp', 'time', 'start_time', 'created_at'],
  set_no: ['set_no', 'set', 'setNumber', 'set_number'],
  reps: ['reps', 'rep_count', 'repetitions', 'repCount', 'numReps'],
  load: ['load', 'weight', 'load_kg', 'load_lb', 'weight_kg', 'weight_lb', 'mass'],
  mean_velocity: ['mean_velocity', 'meanVelocity', 'avg_velocity', 'average_velocity', 'velocity', 'mean_concentric_velocity', 'mcv', 'mpv', 'mean_propulsive_velocity'],
  peak_velocity: ['peak_velocity', 'peakVelocity', 'max_velocity', 'top_velocity'],
  best_velocity: ['best_velocity', 'fastest_rep_velocity', 'best_rep_velocity', 'first_rep_velocity'],
  last_velocity: ['last_velocity', 'last_rep_velocity'],
  velocity_loss_pct: ['velocity_loss_pct', 'velocity_loss', 'fatigue', 'velocityLoss'],
  mean_power: ['mean_power', 'meanPower', 'avg_power', 'average_power', 'power'],
  peak_power: ['peak_power', 'peakPower', 'max_power'],
  rom_cm: ['rom_cm', 'rom', 'range_of_motion', 'distance', 'displacement', 'rom_m', 'rom_mm'],
  duration_s: ['duration_s', 'duration', 'rep_duration', 'time_s'],
  external_id: ['external_id', 'id', 'reference', 'set_id', 'uuid']
};
const pick = (raw, field) => { for (const k of FIELD_ALIASES[field]) if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return { key: k, value: raw[k] }; return null; };
const LIMITS = { load_lb: [0, 2000], reps: [1, 100], set_no: [1, 99], mean_velocity: [0, 6], peak_velocity: [0, 8], best_velocity: [0, 6], last_velocity: [0, 6], velocity_loss_pct: [-50, 100], mean_power: [0, 20000], peak_power: [0, 30000], rom_cm: [0, 300], duration_s: [0, 120] };
function within(field, value) {
  if (value == null) return null;
  if (Number.isNaN(value)) throw badRequest(`${field} must be a number.`);
  const [lo, hi] = LIMITS[field];
  if (value < lo || value > hi) throw badRequest(`${field} must be between ${lo} and ${hi}.`);
  return value;
}
// A time as devices write it: ISO, "2026-10-05 17:03", a date alone, or epoch seconds/milliseconds (GymAware).
function whenOf(x, fallback) {
  if (x === undefined || x === null || x === '') return fallback;
  if (typeof x === 'number' || /^\d{9,13}$/.test(String(x).trim())) { const n = Number(x); const ms = n > 1e11 ? n : n * 1000; const d = new Date(ms); if (Number.isNaN(d.getTime())) throw badRequest('performed_at must be a date and time.'); return d.toISOString(); }
  const s = String(x).trim();
  let d = new Date(s);
  if (Number.isNaN(d.getTime())) { const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/); if (m) { let h = Number(m[4] ?? 0); if (m[7]) { const pm = /p/i.test(m[7]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; } d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], h, +(m[5] ?? 0), +(m[6] ?? 0))); } }
  if (Number.isNaN(d.getTime())) throw badRequest(`performed_at must be a date and time (got "${s.slice(0, 40)}").`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00.000Z`;    // a date alone: midday, so the business day is right in any US zone
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return new Date(`${s.replace(' ', 'T')}Z`).toISOString();   // no zone: taken as written
  return d.toISOString();
}
// Reads one set as sent (API body or a file row already put into our field names). Returns the clean row, or throws.
export function cleanSet(ctx, raw, { now, loadUnit = null } = {}) {
  const ex = pick(raw, 'exercise');
  const exercise = v.str(ex?.value == null ? null : String(ex.value), 'exercise', { max: 120 });
  const performed_at = whenOf(pick(raw, 'performed_at')?.value, now);
  const loadPick = pick(raw, 'load');
  let load = num(loadPick?.value);
  const unit = String(raw.load_unit ?? raw.unit ?? loadUnit ?? (loadPick && /_?kg$/i.test(loadPick.key) ? 'kg' : loadPick && /_?lb$/i.test(loadPick.key) ? 'lb' : 'lb')).toLowerCase();
  if (!['lb', 'lbs', 'kg', 'kgs'].includes(unit)) throw badRequest('load_unit must be lb or kg.');
  if (load != null && Number.isNaN(load)) throw badRequest('load must be a number.');
  if (load != null && unit.startsWith('kg')) load *= KG_TO_LB;
  const n = (f) => within(f, num(pick(raw, f)?.value));
  let reps = n('reps') != null ? Math.round(n('reps')) : null;
  const set_no = n('set_no') != null ? Math.round(n('set_no')) : null;
  let mean_velocity = n('mean_velocity'), peak_velocity = n('peak_velocity'), best_velocity = n('best_velocity'), last_velocity = n('last_velocity'), velocity_loss_pct = n('velocity_loss_pct');
  const romPick = pick(raw, 'rom_cm');
  let rom_cm = within('rom_cm', num(romPick?.value) == null ? null : num(romPick.value) * (/_m$|_mm$/.test(romPick.key) ? (romPick.key.endsWith('_mm') ? 0.1 : 100) : raw.rom_unit === 'm' ? 100 : raw.rom_unit === 'mm' ? 0.1 : raw.rom_unit === 'in' ? 2.54 : 1));
  // Reps sent one by one: the set's numbers come from them.
  let reps_detail = null;
  if (Array.isArray(raw.reps_detail) && raw.reps_detail.length) {
    if (raw.reps_detail.length > 100) throw badRequest('reps_detail may list up to 100 reps.');
    reps_detail = raw.reps_detail.map((r, i) => {
      const vel = within('mean_velocity', num(r.velocity ?? r.mean_velocity ?? r.meanVelocity)), pk = within('peak_velocity', num(r.peak_velocity ?? r.peakVelocity)), pw = within('mean_power', num(r.power ?? r.mean_power));
      if (vel == null && pk == null) throw badRequest(`reps_detail[${i}] needs a velocity.`);
      return { velocity: round(vel, 3), peak_velocity: round(pk, 3), power: round(pw, 0) };
    });
    const vels = reps_detail.map((r) => r.velocity).filter((x) => x != null);
    if (vels.length) {
      if (reps == null) reps = reps_detail.length;   // the reps are the ones sent
      mean_velocity ??= vels.reduce((a, b) => a + b, 0) / vels.length;
      best_velocity ??= Math.max(...vels); last_velocity ??= vels[vels.length - 1];
      peak_velocity ??= reps_detail.some((r) => r.peak_velocity != null) ? Math.max(...reps_detail.map((r) => r.peak_velocity ?? 0)) : null;
    }
  }
  if (mean_velocity == null && peak_velocity == null && n('mean_power') == null) throw badRequest('A set needs a velocity (mean_velocity or peak_velocity) or a power.');
  if (velocity_loss_pct == null && best_velocity != null && last_velocity != null && best_velocity > 0) velocity_loss_pct = ((best_velocity - last_velocity) / best_velocity) * 100;
  if (velocity_loss_pct != null && velocity_loss_pct > 0 && velocity_loss_pct <= 1 && best_velocity != null) velocity_loss_pct *= 100;   // a fraction (0.18) means a percent
  const extPick = pick(raw, 'external_id');
  const external_id = extPick ? String(extPick.value).trim().slice(0, 200) || null : null;
  return { exercise_name: exercise, performed_at, set_no, reps, load_lb: load == null ? null : within('load_lb', Math.round(load * 10) / 10),
    mean_velocity: round(mean_velocity, 3), peak_velocity: round(peak_velocity, 3), best_velocity: round(best_velocity, 3), last_velocity: round(last_velocity, 3), velocity_loss_pct: round(velocity_loss_pct, 1),
    mean_power: round(n('mean_power'), 0), peak_power: round(n('peak_power'), 0), rom_cm: round(rom_cm, 1), duration_s: round(n('duration_s'), 2), reps_detail, external_id };
}
const athleteRefOf = (raw) => raw.athlete && typeof raw.athlete === 'object' ? raw.athlete
  : { athlete_id: raw.athlete_id, client_id: raw.client_id, roster_id: raw.roster_id, email: raw.athlete_email ?? raw.email, external_id: raw.athlete_external_id ?? raw.athleteReference ?? raw.athlete_ref, name: raw.athlete_name ?? raw.athleteName ?? raw.athlete };
const cleanRef = (ref = {}) => Object.fromEntries(Object.entries({ athlete_id: ref.athlete_id, client_id: ref.client_id, external_id: ref.external_id, name: ref.name, email: ref.email }).filter(([, x]) => x != null && x !== '').map(([k, x]) => [k, String(x).trim().slice(0, 200)]));

// ---------- Saving ----------
// items: sets as sent. Each lands on its athlete, waits (client_id NULL, keyed by how the sender named them), or is a
// duplicate (same provider and external_id, or the same athlete, exercise, time and set number from the same system).
export function recordSets(ctx, items, { provider, source, importId = null, clientId = null } = {}) {
  if (!Array.isArray(items)) throw badRequest('sets must be a list.');
  if (!items.length) throw badRequest('Send at least one set.');
  if (items.length > MAX_PER_REQUEST) throw badRequest(`Send up to ${MAX_PER_REQUEST} sets at a time.`);
  const prov = v.str(String(provider ?? 'other').toLowerCase(), 'provider', { max: 40 });
  const tz = getSetting(ctx, 'timezone'), now = ctx.now();
  const out = { saved: 0, waiting: 0, duplicates: 0, errors: [], saved_ids: [], athletes: new Map(), waiting_for: new Map() };
  ctx.db.tx(() => {
    items.forEach((raw, index) => {
      let set, ref, who;
      try {
        if (!raw || typeof raw !== 'object') throw badRequest('Each set must be an object.');
        set = cleanSet(ctx, raw, { now });
        ref = clientId ? { client_id: clientId } : cleanRef(athleteRefOf(raw));
        who = resolveAthlete(ctx, ref, prov);
        if (!who && !Object.keys(ref).length) throw badRequest('Say whose set it is: athlete {athlete_id} (ours), {client_id}, or {external_id, name} as the device knows them.');
      } catch (e) { if (e instanceof HttpError) { out.errors.push({ index, message: e.message }); return; } throw e; }
      if (who && ctx.db.get('SELECT 1 FROM clients WHERE id = ? AND archived_at IS NOT NULL', who.client_id)) { out.errors.push({ index, message: 'That athlete is archived.' }); return; }
      const identity = who ? null : identityOf(ref);
      const dedupe = set.external_id ?? `${who ? `client:${who.client_id}` : identity}|${normName(set.exercise_name)}|${set.performed_at}|${set.set_no ?? ''}`;
      if (ctx.db.get('SELECT 1 FROM vbt_sets WHERE provider = ? AND dedupe_key = ?', prov, dedupe)) { out.duplicates++; return; }
      const id = newId('vbt');
      ctx.db.run(`INSERT INTO vbt_sets (id, client_id, provider, identity, athlete_ref, exercise_id, exercise_name, performed_at, day, set_no, reps, load_lb, mean_velocity, peak_velocity, best_velocity, last_velocity,
          velocity_loss_pct, mean_power, peak_power, rom_cm, duration_s, reps_detail, external_id, dedupe_key, source, import_id, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, who?.client_id ?? null, prov, identity, who ? null : JSON.stringify(ref), exerciseIdFor(ctx, set.exercise_name), set.exercise_name, set.performed_at, localDate(set.performed_at, tz), set.set_no, set.reps, set.load_lb,
        set.mean_velocity, set.peak_velocity, set.best_velocity, set.last_velocity, set.velocity_loss_pct, set.mean_power, set.peak_power, set.rom_cm, set.duration_s, set.reps_detail ? JSON.stringify(set.reps_detail) : null,
        set.external_id, dedupe, source, importId, now);
      out.saved_ids.push(id);
      if (who) { out.saved++; const a = out.athletes.get(who.client_id) ?? { client_id: who.client_id, sets: 0, exercises: new Set() }; a.sets++; a.exercises.add(set.exercise_name); out.athletes.set(who.client_id, a); }
      else { out.waiting++; const w = out.waiting_for.get(identity) ?? { identity, ...ref, sets: 0 }; w.sets++; out.waiting_for.set(identity, w); }
    });
  });
  for (const a of out.athletes.values()) {
    const c = ctx.db.get('SELECT name FROM clients WHERE id = ?', a.client_id);
    emit(ctx, 'bar_speed.recorded', { client_id: a.client_id, client_name: c?.name ?? null, provider: prov, sets: a.sets, exercises: [...a.exercises].slice(0, 10) });
  }
  return { saved: out.saved, waiting: out.waiting, duplicates: out.duplicates, errors: out.errors, saved_ids: out.saved_ids,
    athletes: [...out.athletes.values()].map((a) => ({ client_id: a.client_id, sets: a.sets })), waiting_for: [...out.waiting_for.values()] };
}

// ---------- Waiting sets and linking ----------
export function waiting(ctx) {
  const rows = ctx.db.all(`SELECT provider, identity, athlete_ref, COUNT(*) AS sets, MIN(performed_at) AS first_at, MAX(performed_at) AS last_at, GROUP_CONCAT(DISTINCT exercise_name) AS exercises
    FROM vbt_sets WHERE client_id IS NULL GROUP BY provider, identity ORDER BY last_at DESC`);
  return rows.map((r) => ({ provider: r.provider, system: SYSTEMS[r.provider]?.label ?? r.provider, identity: r.identity, athlete: JSON.parse(r.athlete_ref ?? '{}'), sets: r.sets, first_at: r.first_at, last_at: r.last_at, exercises: String(r.exercises ?? '').split(',').slice(0, 6) }));
}
// Everything waiting under this sender's name or ID goes to the athlete (performance.linkDevice and the queue call this
// after linking the device, so one link covers test results and bar speed).
export function adopt(ctx, provider, identity, clientId) {
  const r = ctx.db.run('UPDATE vbt_sets SET client_id = ?, identity = NULL, athlete_ref = NULL WHERE provider = ? AND identity = ? AND client_id IS NULL', clientId, provider, identity);
  const n = r?.changes ?? 0;
  if (n) { const c = ctx.db.get('SELECT name FROM clients WHERE id = ?', clientId); emit(ctx, 'bar_speed.recorded', { client_id: clientId, client_name: c?.name ?? null, provider, sets: n, exercises: [], linked: true }); }
  return n;
}
// Link waiting sets by hand: provider + identity to an athlete; remember = true also links the device for next time.
export function linkWaiting(ctx, body) {
  const provider = v.str(String(body.provider ?? '').toLowerCase(), 'provider', { max: 40 });
  const identity = v.str(body.identity, 'identity', { max: 220 });
  const who = resolveAthlete(ctx, { athlete_id: body.athlete_id, client_id: body.athlete_id ? undefined : body.client_id });
  if (!who) throw badRequest('Choose the athlete to link.');
  if (!ctx.db.get('SELECT 1 FROM vbt_sets WHERE provider = ? AND identity = ? AND client_id IS NULL', provider, identity)) throw notFound('Waiting sets');
  return ctx.db.tx(() => {
    const ref = JSON.parse(ctx.db.get('SELECT athlete_ref FROM vbt_sets WHERE provider = ? AND identity = ? AND client_id IS NULL', provider, identity)?.athlete_ref ?? '{}');
    if (body.remember !== false) linkAthlete(ctx, { provider, external_id: identity.replace(/^id:/, ''), external_name: ref.name ?? null, client_id: who.client_id });
    const linked = adopt(ctx, provider, identity, who.client_id);
    return { linked, client_id: who.client_id, remembered: body.remember !== false };
  });
}
export function discardWaiting(ctx, body) {
  const provider = v.str(String(body.provider ?? '').toLowerCase(), 'provider', { max: 40 }), identity = v.str(body.identity, 'identity', { max: 220 });
  const r = ctx.db.run('DELETE FROM vbt_sets WHERE provider = ? AND identity = ? AND client_id IS NULL', provider, identity);
  return { discarded: r?.changes ?? 0 };
}

// ---------- Reading ----------
export function listSets(ctx, { client_id, exercise, provider, from, to, limit } = {}) {
  const where = ['client_id IS NOT NULL'], p = [];
  if (client_id) { where.push('client_id = ?'); p.push(client_id); }
  if (exercise) { where.push('lower(exercise_name) = lower(?)'); p.push(exercise); }
  if (provider) { where.push('provider = ?'); p.push(provider); }
  if (from) { where.push('day >= ?'); p.push(v.date(from, 'from').slice(0, 10)); }
  if (to) { where.push('day <= ?'); p.push(v.date(to, 'to').slice(0, 10)); }
  const n = Math.min(1000, Math.max(1, Number(limit) || 200));
  return ctx.db.all(`SELECT s.*, c.name AS athlete_name, c.athlete_id FROM vbt_sets s JOIN clients c ON c.id = s.client_id WHERE ${where.join(' AND ')} ORDER BY performed_at DESC, set_no DESC LIMIT ?`, ...p, n).map(shape);
}
function shape(r) {
  const { dedupe_key, identity, athlete_ref, reps_detail, ...rest } = r;
  return { ...rest, reps_detail: reps_detail ? JSON.parse(reps_detail) : null, system: SYSTEMS[r.provider]?.label ?? r.provider };
}
export function removeSet(ctx, id) {
  const r = ctx.db.get('SELECT id FROM vbt_sets WHERE id = ?', id);
  if (!r) throw notFound('Set');
  ctx.db.run('DELETE FROM vbt_sets WHERE id = ?', id);
  return { deleted: true };
}

// Least squares velocity = a + b·load over the best mean velocity at each load. Needs 3 loads spread 15% apart or
// more and a downward slope; r² says how straight the line is. e1RM = the load where the line hits the threshold.
export function fitProfile(points, mvt) {
  const pts = points.filter((p) => p.load_lb > 0 && p.velocity > 0);
  const loads = [...new Set(pts.map((p) => p.load_lb))];
  if (loads.length < 3) return null;
  const maxL = Math.max(...loads), minL = Math.min(...loads);
  if (maxL - minL < 0.15 * maxL) return null;
  const n = pts.length, mx = pts.reduce((s, p) => s + p.load_lb, 0) / n, my = pts.reduce((s, p) => s + p.velocity, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.load_lb - mx) * (p.velocity - my); sxx += (p.load_lb - mx) ** 2; syy += (p.velocity - my) ** 2; }
  if (!sxx || !syy) return null;
  const slope = sxy / sxx, intercept = my - slope * mx, r2 = (sxy * sxy) / (sxx * syy);
  if (slope >= 0) return null;
  const e1rm = mvt != null ? (mvt - intercept) / slope : null;
  return { slope: round(slope, 5), intercept: round(intercept, 3), r2: round(r2, 3), points: pts.length, loads: loads.length,
    e1rm: e1rm != null && e1rm > 0 && e1rm < 2000 && e1rm >= maxL * 0.9 ? round5(e1rm) : null, e1rm_exact: e1rm != null ? round(e1rm, 0) : null, max_load: maxL,
    velocity_at: (load) => round(intercept + slope * load, 2) };
}

// The athlete's bar speed by exercise: the last PROFILE_DAYS of sets as a load-velocity profile with the estimated max,
// the fastest rep at each load, the speed at the load they lift most as a trend, and the recent sessions. parentView
// changes nothing (bar speed is the athlete's own training, like logged sets).
export function profileFor(ctx, clientId, { days = PROFILE_DAYS } = {}) {
  const tz = getSetting(ctx, 'timezone');
  const today = localDate(ctx.now(), tz);
  const since = new Date(`${today}T00:00:00Z`); since.setUTCDate(since.getUTCDate() - days);
  const sinceDay = since.toISOString().slice(0, 10);
  const all = ctx.db.all('SELECT * FROM vbt_sets WHERE client_id = ? ORDER BY performed_at DESC, set_no DESC LIMIT 5000', clientId);
  if (!all.length) return { has_data: false, days, exercises: [], recent: [], totals: { sets: 0, days: 0, exercises: 0 }, systems: [] };
  const byEx = new Map();
  for (const s of all) { const k = normName(s.exercise_name); if (!byEx.has(k)) byEx.set(k, { name: s.exercise_name, exercise_id: s.exercise_id, sets: [] }); byEx.get(k).sets.push(s); }
  const exercises = [...byEx.values()].map((ex) => {
    const recent = ex.sets.filter((s) => s.day >= sinceDay);
    const vel = (s) => s.best_velocity ?? s.mean_velocity;
    const byLoad = new Map();
    for (const s of recent) { if (s.load_lb == null || vel(s) == null) continue; const L = Math.round(s.load_lb / 5) * 5 || Math.round(s.load_lb); const cur = byLoad.get(L); if (!cur || vel(s) > cur.velocity) byLoad.set(L, { load_lb: L, velocity: vel(s), day: s.day, reps: s.reps }); }
    const points = [...byLoad.values()].sort((a, b) => a.load_lb - b.load_lb);
    const mvt = mvtFor(ctx, ex.name);
    const fit = fitProfile(points, mvt.value);
    // The load they lift most (rounded to 5): its best speed per day is the trend.
    const counts = new Map();
    for (const s of recent) if (s.load_lb != null && vel(s) != null) { const L = Math.round(s.load_lb / 5) * 5 || Math.round(s.load_lb); counts.set(L, (counts.get(L) ?? 0) + 1); }
    const trackLoad = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;
    const trend = trackLoad == null ? [] : [...recent.filter((s) => s.load_lb != null && vel(s) != null && (Math.round(s.load_lb / 5) * 5 || Math.round(s.load_lb)) === trackLoad)
      .reduce((m, s) => { m.set(s.day, Math.max(m.get(s.day) ?? 0, vel(s))); return m; }, new Map()).entries()].map(([date, value]) => ({ date, value: round(value, 2) })).sort((a, b) => (a.date < b.date ? -1 : 1));
    const fastest = ex.sets.reduce((b, s) => (vel(s) != null && (!b || vel(s) > vel(b)) ? s : b), null);
    const heaviest = ex.sets.reduce((b, s) => (s.load_lb != null && (!b || s.load_lb > b.load_lb) ? s : b), null);
    const days = new Set(ex.sets.map((s) => s.day));
    return { name: ex.name, exercise_id: ex.exercise_id, sets: ex.sets.length, recent_sets: recent.length, days: days.size, last_day: ex.sets[0].day, mvt,
      profile: fit ? { slope: fit.slope, intercept: fit.intercept, r2: fit.r2, points, e1rm: fit.e1rm, e1rm_exact: fit.e1rm_exact, loads: fit.loads, straight: fit.r2 >= 0.8,
        zones: [1.0, 0.75, 0.5].map((vv) => ({ velocity: vv, load_lb: fit.slope ? Math.max(0, round5((vv - fit.intercept) / fit.slope)) : null })) } : null,
      profile_points: points, track_load: trackLoad, trend, fastest: fastest ? { velocity: vel(fastest), load_lb: fastest.load_lb, day: fastest.day } : null, heaviest: heaviest ? { load_lb: heaviest.load_lb, velocity: vel(heaviest), day: heaviest.day } : null,
      avg_loss: round(avg(recent.map((s) => s.velocity_loss_pct).filter((x) => x != null)), 0) };
  }).sort((a, b) => (a.last_day < b.last_day ? 1 : a.last_day > b.last_day ? -1 : b.sets - a.sets));
  // Recent sessions: the last 10 days with sets, each exercise's sets in order.
  const dayList = [...new Set(all.map((s) => s.day))].slice(0, 10);
  const recent = dayList.map((day) => {
    const sets = all.filter((s) => s.day === day).sort((a, b) => (a.performed_at < b.performed_at ? -1 : a.performed_at > b.performed_at ? 1 : (a.set_no ?? 0) - (b.set_no ?? 0)));
    const groups = new Map();
    for (const s of sets) { const k = normName(s.exercise_name); if (!groups.has(k)) groups.set(k, { name: s.exercise_name, sets: [] }); groups.get(k).sets.push({ id: s.id, set_no: s.set_no, reps: s.reps, load_lb: s.load_lb, mean_velocity: s.mean_velocity, peak_velocity: s.peak_velocity, best_velocity: s.best_velocity, last_velocity: s.last_velocity, velocity_loss_pct: s.velocity_loss_pct, mean_power: s.mean_power, peak_power: s.peak_power, rom_cm: s.rom_cm, provider: s.provider }); }
    return { day, sets: sets.length, exercises: [...groups.values()].map((g) => ({ ...g, top: g.sets.reduce((b, s) => (s.load_lb != null && (!b || s.load_lb > b.load_lb) ? s : b), null), max_loss: Math.max(0, ...g.sets.map((s) => s.velocity_loss_pct ?? 0)) })) };
  });
  return { has_data: true, days, exercises, recent, totals: { sets: all.length, days: new Set(all.map((s) => s.day)).size, exercises: exercises.length, last_day: all[0].day },
    systems: [...new Set(all.map((s) => s.provider))].map((p) => ({ provider: p, label: SYSTEMS[p]?.label ?? p })) };
}
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------- Files ----------
// Column roles, matched by header (case and punctuation don't matter; a unit in brackets is read for the load and ROM).
const clean = (h) => String(h).replace(/[([][^()[\]]*[)\]]\s*$/, '').toLowerCase().replace(/[_\-–.]+/g, ' ').replace(/[^a-z0-9%/ ]/g, '').replace(/\s+/g, ' ').trim();
export const ROLES = {
  athlete_id: /^(athlete|profile|player|user|external|hub athlete|member)\s?(id|ref|reference)$|^id athlete$|^athlete reference$/,
  first_name: /^first\s?name$|^given name$/, last_name: /^last\s?name$|^surname$|^family name$/,
  athlete: /^(athlete|name|full name|athlete name|player|player name|profile|profile name|user|user name|client|lifter)$/,
  email: /^e?mail$/,
  date: /^(date|day|session date|test date|workout date|training date)$/,
  datetime: /^(date ?time|timestamp|time|start time|recorded|recorded at|created|created at|set time|rep time|date and time)$/,
  exercise: /^(exercise|exercise name|movement|lift|activity|activity name|drill|test)$/,
  set: /^(set|set no|set number|set #|set index)$/,
  rep: /^(rep|rep no|rep number|rep #|repetition|rep index)$/,
  reps: /^(reps|rep count|repetitions|number of reps|no of reps|num reps|total reps)$/,
  load: /^(load|weight|mass|bar weight|external load|resistance|kg|lb|lbs|load kg|load lb|weight kg|weight lb)$/,
  mean_velocity: /^((mean|avg|average|mean concentric|avg concentric|average concentric|mean propulsive|mcv|mpv|acv)\s?(velocity|vel|speed)?|velocity|bar speed|speed|set average velocity|set velocity|average velocity m\/s|mean velocity m\/s)$/,
  peak_velocity: /^((peak|max|maximum|top)\s?(concentric\s?)?(velocity|vel|speed))$/,
  best_velocity: /^((best|fastest|first)\s?(rep\s?)?(velocity|vel|speed)|fastest rep|best rep)$/,
  last_velocity: /^((last|final)\s?(rep\s?)?(velocity|vel|speed))$/,
  velocity_loss_pct: /^(velocity loss|vel loss|fatigue|velocity drop|loss|% loss|velocity loss %)$/,
  mean_power: /^((mean|avg|average)\s?power|power|mean power w|watts)$/,
  peak_power: /^((peak|max|maximum)\s?power)$/,
  rom: /^(rom|range of motion|distance|displacement|height|range)$/,
  duration: /^(duration|rep duration|time under tension|concentric duration|set duration)$/,
  external_id: /^(set id|rep id|uuid|id|record id|reference)$/,
  velocity_zone: /^(velocity zone|zone)$/
};
const unitIn = (h) => { const m = String(h).match(/[([]\s*([a-zA-Z/%]+)\s*[)\]]\s*$/); return m ? m[1].toLowerCase() : null; };
export function guessMapping(headers) {
  const map = {};
  for (const h of headers) {
    const c = clean(h);
    for (const [role, re] of Object.entries(ROLES)) {
      if (map[role] || !re.test(c)) continue;
      // "Velocity (m/s)" alone is the mean; a header that says peak or best is matched by its own role first.
      map[role] = h; break;
    }
  }
  const loadUnit = map.load ? unitIn(map.load) ?? (/kg/.test(clean(map.load)) ? 'kg' : /lb/.test(clean(map.load)) ? 'lb' : null) : null;
  const romUnit = map.rom ? unitIn(map.rom) : null;
  return { ...map, load_unit: loadUnit, rom_unit: romUnit };
}
const b64 = (s, field) => { try { return Buffer.from(String(s).replace(/^data:[^,]*,/, ''), 'base64'); } catch { throw badRequest(`${field} must be base64.`); } };
export function readFile(body) {
  const f = body.file ?? body;
  if (f.xlsx_base64) {
    let rows;
    try { rows = readXlsx(b64(f.xlsx_base64, 'xlsx_base64')); } catch (e) { throw badRequest(`That Excel file couldn't be read (${e.message}). Save it as .xlsx or export a CSV.`); }
    if (!rows?.length || rows.length < 2) throw badRequest('The file needs a header row and at least one row of sets.');
    const headers = rows[0].map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
    return { headers, rows: rows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()]))), kind: 'xlsx' };
  }
  if (f.csv) { const t = parseCsv(v.str(f.csv, 'csv', { max: 30_000_000 })); return { ...t, kind: 'csv' }; }
  throw badRequest('Send the file as csv text or xlsx_base64.');
}
// Rows to sets in our field names. One row per set, or one per rep (a rep column, or several rows sharing athlete,
// time, exercise and set) folded into sets. Problems name the row and column; the athlete is checked separately.
export function rowsToSets(ctx, rows, mapping, { provider } = {}) {
  const m = mapping, problems = [], sets = [];
  if (!m.exercise) problems.push({ row: 1, column: null, message: 'Which column is the exercise? Match the columns by hand.' });
  if (!m.mean_velocity && !m.peak_velocity && !m.mean_power) problems.push({ row: 1, column: null, message: 'Which column is the velocity? Match the columns by hand.' });
  if (problems.length) return { sets, problems };
  const perRep = !!m.rep || (!m.reps && !m.set);
  const groups = new Map();
  rows.forEach((r, i) => {
    const row = i + 2;
    const g = (role) => (m[role] ? r[m[role]] : undefined);
    const athlete = {};
    if (g('athlete_id')) athlete.external_id = String(g('athlete_id')).trim();
    const name = g('athlete') ?? [g('first_name'), g('last_name')].filter(Boolean).join(' ');
    if (name) athlete.name = String(name).trim();
    if (g('email')) athlete.email = String(g('email')).trim();
    const when = g('datetime') ?? [g('date'), m.time ? r[m.time] : null].filter(Boolean).join(' ');
    const exercise = g('exercise');
    if (!exercise) { problems.push({ row, column: m.exercise, message: 'The exercise is empty.' }); return; }
    const raw = { exercise, performed_at: when || undefined, set_no: g('set'), reps: g('reps'), load: g('load'), load_unit: m.load_unit ?? undefined,
      mean_velocity: g('mean_velocity'), peak_velocity: g('peak_velocity'), best_velocity: g('best_velocity'), last_velocity: g('last_velocity'), velocity_loss_pct: g('velocity_loss_pct'),
      mean_power: g('mean_power'), peak_power: g('peak_power'), rom: g('rom'), rom_unit: m.rom_unit ?? undefined, duration: g('duration'), external_id: perRep ? undefined : g('external_id') };
    let s;
    try { s = cleanSet(ctx, raw, { now: ctx.now() }); } catch (e) { if (e instanceof HttpError) { problems.push({ row, column: columnFor(m, e.message), message: e.message }); return; } throw e; }
    if (perRep) {
      const key = `${JSON.stringify(athlete)}|${s.performed_at.slice(0, 16)}|${normName(s.exercise_name)}|${s.set_no ?? ''}|${s.load_lb ?? ''}`;
      const grp = groups.get(key) ?? { athlete, set: { ...s, reps_detail: [] }, rows: [] };
      grp.set.reps_detail.push({ velocity: s.mean_velocity, peak_velocity: s.peak_velocity, power: s.mean_power });
      grp.rows.push(row);
      groups.set(key, grp);
    } else sets.push({ athlete, set: s, row });
  });
  for (const grp of groups.values()) {
    const vels = grp.set.reps_detail.map((x) => x.velocity).filter((x) => x != null);
    const s = grp.set;
    if (vels.length) { s.reps = s.reps ?? vels.length; s.mean_velocity = round(avg(vels), 3); s.best_velocity = round(Math.max(...vels), 3); s.last_velocity = round(vels[vels.length - 1], 3); s.velocity_loss_pct = s.best_velocity > 0 ? round(((s.best_velocity - s.last_velocity) / s.best_velocity) * 100, 1) : null; }
    const pks = grp.set.reps_detail.map((x) => x.peak_velocity).filter((x) => x != null);
    if (pks.length) s.peak_velocity = round(Math.max(...pks), 3);
    if (grp.set.reps_detail.length === 1 && grp.set.reps_detail[0].velocity == null) s.reps_detail = null;
    sets.push({ athlete: grp.athlete, set: s, row: grp.rows[0] });
  }
  return { sets, problems };
}
const columnFor = (m, message) => { const f = message.split(' ')[0]; const role = { load: 'load', reps: 'reps', set_no: 'set', mean_velocity: 'mean_velocity', peak_velocity: 'peak_velocity', mean_power: 'mean_power', peak_power: 'peak_power', rom_cm: 'rom', duration_s: 'duration', performed_at: 'datetime', velocity_loss_pct: 'velocity_loss_pct' }[f]; return role ? m[role] ?? m.date ?? null : null; };

// Check a file (dry_run) or save it: provider, file {name, csv | xlsx_base64}, optional mapping (column names per role,
// from the preview, changed by hand) and client_id when the file has no athlete column (everything is that athlete's).
// Saving is all or nothing: any problem stops it; unmatched athletes aren't problems, their sets wait.
export function importFile(ctx, body, { user = null, dryRun = false } = {}) {
  const provider = v.oneOf(String(body.provider ?? 'other'), 'provider', PROVIDERS);
  const { headers, rows, kind } = readFile(body);
  if (rows.length > 50000) throw badRequest('Import up to 50,000 rows at a time.');
  const guessed = guessMapping(headers);
  const mapping = body.mapping && typeof body.mapping === 'object' ? { ...guessed, ...Object.fromEntries(Object.entries(body.mapping).filter(([k, val]) => (k in ROLES || k === 'load_unit' || k === 'rom_unit' || k === 'time') && (val == null || val === '' || k.endsWith('_unit') || headers.includes(val)))) } : guessed;
  const clientId = body.client_id ? v.str(body.client_id, 'client_id') : null;
  if (clientId && !ctx.db.get('SELECT 1 FROM clients WHERE id = ? AND archived_at IS NULL', clientId)) throw badRequest('That athlete isn\'t on file (or is archived).');
  const { sets, problems } = rowsToSets(ctx, rows, mapping, { provider });
  if (!clientId && !mapping.athlete && !mapping.athlete_id && !mapping.first_name && !mapping.email && sets.length) problems.unshift({ row: 1, column: null, message: 'The file names no athlete: choose the athlete these sets belong to, or match an athlete column.' });
  const unmatched = new Map();
  if (!clientId) for (const s of sets) { const idn = identityOf(s.athlete); if (!unmatched.has(idn) && Object.keys(s.athlete).length && !resolveAthlete(ctx, s.athlete, provider)) unmatched.set(idn, { ...s.athlete, identity: idn, sets: 0 }); if (unmatched.has(idn)) unmatched.get(idn).sets++; }
  const summary = { provider, system: SYSTEMS[provider].label, filename: body.file?.name ?? body.filename ?? null, kind, headers, mapping, rows: rows.length, sets_found: sets.length, per_rep: !!mapping.rep || (!mapping.reps && !mapping.set),
    problems: problems.slice(0, 100), problem_count: problems.length, unmatched_athletes: [...unmatched.values()].slice(0, 200), roles: Object.keys(ROLES),
    preview: sets.slice(0, 15).map((s) => ({ athlete: s.athlete, ...s.set, reps_detail: s.set.reps_detail ? s.set.reps_detail.length : null })) };
  if (dryRun) return summary;
  if (problems.length) throw Object.assign(badRequest(`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} to fix before this file can be saved.`, 'problems'), { details: { problems: problems.slice(0, 100) } });
  if (!sets.length) throw badRequest('No sets found in that file.');
  const id = newId('vimp');
  return ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO vbt_imports (id, provider, filename, rows, problems, created_by, created_at) VALUES (?, ?, ?, ?, '[]', ?, ?)`, id, provider, summary.filename ? String(summary.filename).slice(0, 200) : null, rows.length, user?.id ?? null, ctx.now());
    const items = sets.map((s) => ({ ...s.set, athlete: s.athlete, reps_detail: s.set.reps_detail }));
    const r = recordSets(ctx, items, { provider, source: `csv:${provider}`, importId: id, clientId });
    if (r.errors.length) throw Object.assign(badRequest(`${r.errors.length} ${r.errors.length === 1 ? 'row couldn\'t' : 'rows couldn\'t'} be saved.`, 'problems'), { details: { problems: r.errors.map((e) => ({ row: sets[e.index]?.row ?? null, column: null, message: e.message })) } });
    ctx.db.run('UPDATE vbt_imports SET saved = ?, waiting = ?, duplicates = ? WHERE id = ?', r.saved, r.waiting, r.duplicates, id);
    return { ...getImport(ctx, id), athletes: r.athletes, waiting_for: r.waiting_for };
  });
}
export function getImport(ctx, id) {
  const b = ctx.db.get('SELECT * FROM vbt_imports WHERE id = ?', id);
  if (!b) throw notFound('Import');
  const by = b.created_by ? ctx.db.get('SELECT name FROM users WHERE id = ?', b.created_by)?.name ?? null : null;
  return { id: b.id, provider: b.provider, system: SYSTEMS[b.provider]?.label ?? b.provider, filename: b.filename, rows: b.rows, saved: b.saved, waiting: b.waiting, duplicates: b.duplicates, created_by: by, created_at: b.created_at, undone_at: b.undone_at,
    still_waiting: ctx.db.get('SELECT COUNT(*) AS n FROM vbt_sets WHERE import_id = ? AND client_id IS NULL', id).n };
}
export function listImports(ctx, { limit = 30 } = {}) { return ctx.db.all('SELECT id FROM vbt_imports ORDER BY created_at DESC LIMIT ?', Math.min(200, limit)).map((b) => getImport(ctx, b.id)); }
// Undo: the sets this import brought in go (a set that was already there stayed with its first import, so it stays).
export function undoImport(ctx, id, { user = null } = {}) {
  const b = ctx.db.get('SELECT * FROM vbt_imports WHERE id = ?', id);
  if (!b) throw notFound('Import');
  if (b.undone_at) throw badRequest('This import was already undone.');
  return ctx.db.tx(() => {
    const r = ctx.db.run('DELETE FROM vbt_sets WHERE import_id = ?', id);
    ctx.db.run('UPDATE vbt_imports SET undone_at = ?, undone_by = ? WHERE id = ?', ctx.now(), user?.id ?? null, id);
    return { ...getImport(ctx, id), removed: r?.changes ?? 0 };
  });
}

// ---------- The family export and deletion ----------
export function forExport(ctx, clientId) {
  return ctx.db.all(`SELECT exercise_name AS exercise, performed_at, set_no, reps, load_lb, mean_velocity, peak_velocity, best_velocity, last_velocity, velocity_loss_pct, mean_power, peak_power, rom_cm, provider AS system
    FROM vbt_sets WHERE client_id = ? ORDER BY performed_at, set_no`, clientId);
}
export function forgetClient(ctx, clientId) { ctx.db.run('DELETE FROM vbt_sets WHERE client_id = ?', clientId); }

// For the timeline: one line per exercise and day.
export function timelineRows(ctx, clientId, limit = 400) {
  return ctx.db.all(`SELECT day, exercise_name, MAX(performed_at) AS at, COUNT(*) AS sets, MAX(COALESCE(best_velocity, mean_velocity)) AS best, MAX(load_lb) AS top_load, provider,
      (SELECT load_lb FROM vbt_sets x WHERE x.client_id = s.client_id AND x.day = s.day AND lower(x.exercise_name) = lower(s.exercise_name) ORDER BY COALESCE(best_velocity, mean_velocity) DESC LIMIT 1) AS best_load
    FROM vbt_sets s WHERE client_id = ? GROUP BY day, lower(exercise_name) ORDER BY at DESC LIMIT ?`, clientId, limit);
}
// The owner's thresholds, for the settings screen.
export function thresholds(ctx) {
  return Object.fromEntries(Object.keys(MVT_DEFAULTS).map((k) => [k, mvtFor(ctx, k === 'other' ? 'curl' : k).value]));
}
