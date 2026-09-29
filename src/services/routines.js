import { newId, v, notFound, badRequest, HttpError } from '../util.js';

// Warm-up and cool-down blocks (version 58): a coach writes one once (a name and a short list of exercises with what
// to do, like "2 × 10" or "30 sec each side") and attaches it to workouts. The block follows the workout everywhere:
// the builder, the athlete app, the weight-room screen and the coach's live view. Nothing in a block is logged.

export const KINDS = { warmup: 'Warm-up', cooldown: 'Cool-down' };
export const MAX_ITEMS = 20;

function shape(ctx, r) {
  const exercises = ctx.db.all(`SELECT re.id, re.exercise_id, e.name, re.prescription, re.note, e.video_url, e.poster_url, e.instructions
    FROM routine_exercises re JOIN exercises e ON e.id = re.exercise_id WHERE re.routine_id = ? ORDER BY re.position`, r.id);
  const used = ctx.db.get('SELECT COUNT(*) AS n FROM workouts WHERE warmup_id = ? OR cooldown_id = ?', r.id, r.id).n;
  return { ...r, kind_label: KINDS[r.kind], exercises, used_in: used };
}
export function listRoutines(ctx, { kind } = {}) {
  const k = kind ? v.oneOf(kind, 'kind', Object.keys(KINDS)) : null;
  return ctx.db.all(`SELECT * FROM routines ${k ? 'WHERE kind = ?' : ''} ORDER BY kind, name COLLATE NOCASE`, ...(k ? [k] : [])).map((r) => shape(ctx, r));
}
export function getRoutine(ctx, id) {
  const r = ctx.db.get('SELECT * FROM routines WHERE id = ?', String(id));
  if (!r) throw notFound('Block');
  return shape(ctx, r);
}
// The exercises of a block, checked as one: every one must be in the library, with what to do (up to 80 characters).
function itemsOf(ctx, list) {
  if (!Array.isArray(list) || !list.length) throw badRequest('Add at least one exercise to the block.');
  if (list.length > MAX_ITEMS) throw badRequest(`A block can have up to ${MAX_ITEMS} exercises.`);
  return list.map((x, i) => {
    const e = ctx.db.get('SELECT id FROM exercises WHERE id = ?', v.str(x?.exercise_id, `exercises[${i + 1}].exercise_id`));
    if (!e) throw notFound(`Exercise ${i + 1}`);
    return { exercise_id: e.id, prescription: v.str(x.prescription, `exercises[${i + 1}].prescription`, { max: 80 }), note: v.str(x.note, `exercises[${i + 1}].note`, { max: 200, optional: true }) || null };
  });
}
const writeItems = (ctx, id, items) => {
  ctx.db.run('DELETE FROM routine_exercises WHERE routine_id = ?', id);
  items.forEach((x, i) => ctx.db.run('INSERT INTO routine_exercises (id, routine_id, exercise_id, position, prescription, note) VALUES (?, ?, ?, ?, ?, ?)', newId('rex'), id, x.exercise_id, i + 1, x.prescription, x.note));
};
export function createRoutine(ctx, body = {}) {
  const name = v.str(body.name, 'name', { max: 80 }), kind = v.oneOf(body.kind, 'kind', Object.keys(KINDS));
  const note = v.str(body.note, 'note', { max: 500, optional: true }) || null;
  const items = itemsOf(ctx, body.exercises);
  const id = newId('rtn'), now = ctx.now();
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO routines (id, name, kind, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, kind, note, now, now);
    writeItems(ctx, id, items);
  });
  return getRoutine(ctx, id);
}
export function updateRoutine(ctx, id, body = {}) {
  const r = getRoutine(ctx, id);
  const name = body.name !== undefined ? v.str(body.name, 'name', { max: 80 }) : r.name;
  const note = body.note !== undefined ? v.str(body.note, 'note', { max: 500, optional: true }) || null : r.note;
  if (body.kind !== undefined && body.kind !== r.kind) throw badRequest('A block keeps its kind. Make a new one for the other end of the workout.');
  const items = body.exercises !== undefined ? itemsOf(ctx, body.exercises) : null;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE routines SET name = ?, note = ?, updated_at = ? WHERE id = ?', name, note, ctx.now(), r.id);
    if (items) writeItems(ctx, r.id, items);
  });
  return getRoutine(ctx, r.id);
}
// Deleting a block that workouts use needs confirm: true; those workouts go on without it.
export function deleteRoutine(ctx, id, body = {}) {
  const r = getRoutine(ctx, id);
  if (r.used_in && body?.confirm !== true) {
    const e = new HttpError(409, 'in_use', `${r.name} is on ${r.used_in} ${r.used_in === 1 ? 'workout' : 'workouts'}. Send confirm: true to take it off them and delete it.`);
    e.details = { used_in: r.used_in };
    throw e;
  }
  ctx.db.tx(() => {
    ctx.db.run('UPDATE workouts SET warmup_id = NULL WHERE warmup_id = ?', r.id);
    ctx.db.run('UPDATE workouts SET cooldown_id = NULL WHERE cooldown_id = ?', r.id);
    ctx.db.run('DELETE FROM routines WHERE id = ?', r.id);
  });
  return { id: r.id, deleted: true, workouts_cleared: r.used_in };
}
// The blocks on a workout row, for every screen that shows the workout (null where none).
export function forWorkout(ctx, w) {
  const light = (id) => { if (!id) return null; const r = ctx.db.get('SELECT * FROM routines WHERE id = ?', id); return r ? shape(ctx, r) : null; };
  return { warmup: light(w.warmup_id), cooldown: light(w.cooldown_id) };
}
// What a workout's warmup_id / cooldown_id become from a request: null clears, an id must be a block of that kind.
export function attachFields(ctx, w, body = {}) {
  const pick = (key, kind) => {
    if (body[key] === undefined) return w[key];
    if (body[key] === null || body[key] === '') return null;
    const r = ctx.db.get('SELECT id, kind, name FROM routines WHERE id = ?', v.str(body[key], key));
    if (!r) throw notFound(KINDS[kind]);
    if (r.kind !== kind) throw badRequest(`${r.name} is a ${KINDS[r.kind].toLowerCase()}, not a ${KINDS[kind].toLowerCase()}.`);
    return r.id;
  };
  return { warmup_id: pick('warmup_id', 'warmup'), cooldown_id: pick('cooldown_id', 'cooldown') };
}
