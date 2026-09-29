// Progression from what the athlete did. After a workout is logged, each exercise with a counted rep target is checked:
// when the athlete has hit every set at the top of the rep range in their last two logs of it (this one and the one
// before), a step up is suggested for that athlete alone (programs are shared; the plan itself never changes): more
// weight where they lift a weight (5 lb upper body, 10 lb lower body and power, owner settings), otherwise a rep a set,
// or a set when the reps are already 20 or more. The coach approves or dismisses it on the client page or from Today
// (progression_mode 'suggest'; 'auto' approves at once, 'off' suggests nothing). Approved steps add up per athlete and
// exercise and show in the app on top of the plan; the coach can undo one. Each new suggestion needs two hits after
// the last decision, so one good day never stacks steps.
import { newId, v, badRequest, notFound, conflict } from '../util.js';
import { getSetting } from './families.js';
import { repCount, parseRx, MAX_SETS } from './rx.js';
import { emit } from './events.js';

export const MODES = ['suggest', 'auto', 'off'];
const mode = (ctx) => { const m = getSetting(ctx, 'progression_mode'); return MODES.includes(m) ? m : 'suggest'; };
const stepLb = (ctx, category) => Number(getSetting(ctx, /lower|power/i.test(String(category ?? '')) ? 'progression_lower_lb' : 'progression_upper_lb')) || 5;
// The top of a rep range: "8-10" → 10, "8" → 8, "5/side" → 5; null for time, distance or max.
export function topReps(reps) {
  const low = repCount(reps);
  if (low == null) return null;
  const m = /^(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})/.exec(String(reps).trim());
  return m ? Math.max(Number(m[1]), Number(m[2])) : low;
}
// Did every set of this exercise in a log reach the target: at least the planned sets, each at or over the top reps?
export function hit(sets, slot, applied = null) {
  const rx = parseRx(slot), top = topReps(slot.reps ?? null) ?? (slot.reps == null ? repCount(String(rx.reps ?? '')) : null);
  const base = top ?? rx.reps;
  if (base == null || !sets.length) return false;
  // Steps already approved raise the bar: the athlete is asked for them, so a hit means reaching them.
  const target = base + (applied?.reps ?? 0), planned = Math.min(MAX_SETS, rx.sets + (applied?.sets ?? 0));
  if (sets.length < planned) return false;
  return sets.every((s) => s.reps != null && s.reps >= target);
}

// After a log is saved: look at each exercise it covered and suggest where two hits in a row earn a step.
export function suggestAfterLog(ctx, client, logId) {
  if (mode(ctx) === 'off') return [];
  const rows = ctx.db.all(`SELECT DISTINCT s.exercise_id, s.workout_exercise_id, e.name, e.category FROM workout_sets s JOIN exercises e ON e.id = s.exercise_id WHERE s.workout_log_id = ? AND s.exercise_id IS NOT NULL`, logId);
  const out = [];
  for (const r of rows) {
    const slot = ctx.db.get('SELECT sets, reps, load_test, load_pct, load_text, prescription FROM workout_exercises WHERE id = ?', r.workout_exercise_id);
    if (!slot) continue;
    const these = ctx.db.all('SELECT set_no, weight, reps FROM workout_sets WHERE workout_log_id = ? AND exercise_id = ? ORDER BY set_no', logId, r.exercise_id);
    const applied = appliedFor(ctx, client.id, r.exercise_id);
    if (!hit(these, slot, applied)) continue;
    // The log before this one for the same exercise, and only since the coach's last decision on it.
    const since = ctx.db.get(`SELECT MAX(decided_at) AS t FROM progressions WHERE client_id = ? AND exercise_id = ? AND status IN ('approved', 'dismissed', 'removed')`, client.id, r.exercise_id)?.t ?? '';
    const open = ctx.db.get(`SELECT id FROM progressions WHERE client_id = ? AND exercise_id = ? AND status = 'suggested'`, client.id, r.exercise_id);
    if (open) continue;
    const thisLog = ctx.db.get('SELECT completed_at FROM workout_logs WHERE id = ?', logId);
    const prev = ctx.db.get(`SELECT l.id, l.completed_at FROM workout_logs l JOIN workout_sets s ON s.workout_log_id = l.id
      WHERE l.client_id = ? AND s.exercise_id = ? AND l.id != ? AND l.completed_at <= ? AND l.completed_at > ? ORDER BY l.completed_at DESC, l.rowid DESC LIMIT 1`, client.id, r.exercise_id, logId, thisLog.completed_at, since);
    if (!prev) continue;
    const prevSlotId = ctx.db.get('SELECT workout_exercise_id FROM workout_sets WHERE workout_log_id = ? AND exercise_id = ? LIMIT 1', prev.id, r.exercise_id)?.workout_exercise_id;
    const prevSlot = prevSlotId ? ctx.db.get('SELECT sets, reps, load_test, load_pct, load_text, prescription FROM workout_exercises WHERE id = ?', prevSlotId) : null;
    const before = ctx.db.all('SELECT set_no, weight, reps FROM workout_sets WHERE workout_log_id = ? AND exercise_id = ? ORDER BY set_no', prev.id, r.exercise_id);
    if (!hit(before, prevSlot ?? slot, applied)) continue;
    const weighted = these.some((s) => s.weight > 0);
    const top = topReps(slot.reps) ?? parseRx(slot).reps;
    const kind = weighted ? 'weight' : top >= 20 ? 'sets' : 'reps';
    if (kind === 'sets' && parseRx(slot).sets + (applied?.sets ?? 0) >= MAX_SETS) continue;
    const amount = kind === 'weight' ? stepLb(ctx, r.category) : 1;
    const basis = { logs: [prev.id, logId], sets: these.map((s) => ({ weight: s.weight, reps: s.reps })), target: `${parseRx(slot).sets} × ${slot.reps ?? parseRx(slot).reps}` };
    const p = insert(ctx, client.id, r.exercise_id, kind, amount, basis, mode(ctx) === 'auto' ? { status: 'approved', by: 'automatic' } : {});
    out.push(p);
  }
  return out;
}
function insert(ctx, clientId, exerciseId, kind, amount, basis, { status = 'suggested', by = null } = {}) {
  const id = newId('prog'), now = ctx.now();
  ctx.db.run(`INSERT INTO progressions (id, client_id, exercise_id, kind, amount, basis, status, created_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, clientId, exerciseId, kind, amount, JSON.stringify(basis ?? {}), status, now, status === 'approved' ? now : null, status === 'approved' ? by : null);
  const p = shape(ctx, row(ctx, id));
  emit(ctx, status === 'approved' ? 'progression.approved' : 'progression.suggested', { progression_id: id, client_id: clientId, client_name: p.client_name, exercise_id: exerciseId, exercise_name: p.exercise_name, kind, amount, by });
  return p;
}
const row = (ctx, id) => ctx.db.get('SELECT p.*, e.name AS exercise_name, c.name AS client_name FROM progressions p JOIN exercises e ON e.id = p.exercise_id JOIN clients c ON c.id = p.client_id WHERE p.id = ?', id);
export const stepText = (kind, amount) => (kind === 'weight' ? `+${amount} lb` : kind === 'reps' ? `+${amount} rep${amount === 1 ? '' : 's'} a set` : `+${amount} set${amount === 1 ? '' : 's'}`);
const shape = (ctx, p) => p && ({ id: p.id, client_id: p.client_id, client_name: p.client_name, exercise_id: p.exercise_id, exercise_name: p.exercise_name, kind: p.kind, amount: p.amount, text: stepText(p.kind, p.amount),
  basis: (() => { try { return JSON.parse(p.basis ?? '{}'); } catch { return {}; } })(), status: p.status, created_at: p.created_at, decided_at: p.decided_at, decided_by: p.decided_by });

// ---------- What applies in the app ----------
// The approved steps for one athlete and exercise, added up by kind.
export function appliedFor(ctx, clientId, exerciseId) {
  const rows = ctx.db.all(`SELECT kind, SUM(amount) AS total FROM progressions WHERE client_id = ? AND exercise_id = ? AND status = 'approved' GROUP BY kind`, clientId, exerciseId);
  if (!rows.length) return null;
  const out = { weight_lb: 0, reps: 0, sets: 0 };
  for (const r of rows) out[r.kind === 'weight' ? 'weight_lb' : r.kind] = r.total;
  out.text = [out.weight_lb ? `+${out.weight_lb} lb` : null, out.reps ? `+${out.reps} rep${out.reps === 1 ? '' : 's'} a set` : null, out.sets ? `+${out.sets} set${out.sets === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
  return out;
}

// ---------- The coach's side ----------
export function list(ctx, { status: st, clientId, limit = 50 } = {}) {
  const where = ['c.archived_at IS NULL'], p = [];
  if (st && ['suggested', 'approved', 'dismissed', 'removed'].includes(st)) { where.push('p.status = ?'); p.push(st); }
  if (clientId) { where.push('p.client_id = ?'); p.push(clientId); }
  return ctx.db.all(`SELECT p.*, e.name AS exercise_name, c.name AS client_name FROM progressions p JOIN exercises e ON e.id = p.exercise_id JOIN clients c ON c.id = p.client_id WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT ?`, ...p, Math.min(Math.max(Number(limit) || 50, 1), 200)).map((r) => shape(ctx, r));
}
export function waiting(ctx) { return list(ctx, { status: 'suggested', limit: 100 }); }
export function decide(ctx, id, decision, user) {
  const p = row(ctx, id);
  if (!p) throw notFound('Suggestion');
  if (p.status !== 'suggested') throw conflict(`This one was already ${p.status}.`);
  const status = decision === 'approve' ? 'approved' : 'dismissed';
  ctx.db.run('UPDATE progressions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?', status, ctx.now(), user?.name ?? null, id);
  if (status === 'approved') emit(ctx, 'progression.approved', { progression_id: id, client_id: p.client_id, client_name: p.client_name, exercise_id: p.exercise_id, exercise_name: p.exercise_name, kind: p.kind, amount: p.amount, by: user?.name ?? null });
  return shape(ctx, row(ctx, id));
}
// A step the coach adds by hand (approved at once), for an athlete who's plainly ready.
export function add(ctx, clientId, body = {}, user) {
  const c = ctx.db.get('SELECT id, archived_at FROM clients WHERE id = ?', v.str(clientId, 'client_id'));
  if (!c) throw notFound('Athlete');
  if (c.archived_at) throw conflict('This athlete is archived.');
  const e = ctx.db.get('SELECT id FROM exercises WHERE id = ?', v.str(body.exercise_id, 'exercise_id'));
  if (!e) throw notFound('Exercise');
  const kind = v.oneOf(String(body.kind ?? 'weight'), 'kind', ['weight', 'reps', 'sets']);
  const amount = kind === 'weight' ? v.int(body.amount, 'amount', { min: -100, max: 100 }) : v.int(body.amount, 'amount', { min: -5, max: 5 });
  if (!amount) throw badRequest('Say how much: pounds, reps a set, or sets (a minus takes some off).');
  return insert(ctx, c.id, e.id, kind, amount, { by_hand: true }, { status: 'approved', by: user?.name ?? null });
}
// Take an approved step back out (or drop a suggestion the athlete outgrew).
// Take a step back out. An approved step is kept as 'removed' (a decision, so the next suggestion still needs two hits
// after it); a suggestion nobody decided on is dropped.
export function remove(ctx, id, user) {
  const p = ctx.db.get('SELECT id, status FROM progressions WHERE id = ?', id);
  if (!p) throw notFound('Suggestion');
  if (p.status === 'approved') ctx.db.run(`UPDATE progressions SET status = 'removed', decided_at = ?, decided_by = ? WHERE id = ?`, ctx.now(), user?.name ?? null, id);
  else ctx.db.run('DELETE FROM progressions WHERE id = ?', id);
  return { id, deleted: true };
}
export const forExport = (ctx, clientId) => ctx.db.all('SELECT e.name AS exercise, p.kind, p.amount, p.status, p.created_at, p.decided_at, p.decided_by FROM progressions p JOIN exercises e ON e.id = p.exercise_id WHERE p.client_id = ? ORDER BY p.created_at', clientId);
