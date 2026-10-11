import { newId, v, notFound, badRequest, conflict } from '../util.js';
import { getExercise, slotFields, loadInput, syncBlocks } from './programs.js';
import { GROUP_KINDS, SET_FIELDS, tagGroups } from './rx.js';

// Complexes (version 74, owner's ask): a named group of exercises written once ("Acceleration Primer": backwards sprint,
// broad jump, sled sprint) and loaded into any workout, in any program, as a block in one click. Edited under
// Settings → Exercise library → Complexes; a change there never touches the workouts already built from it (each
// workout holds its own copy). Library content from coaches, nothing personal.
export const MAX_COMPLEX_EXERCISES = 30, MAX_COMPLEX_NAME = 60;
const COLS = SET_FIELDS.filter((k) => k !== 'group_label' && k !== 'group_kind');   // a complex's exercises take the complex's kind
const itemsOf = (ctx, ids) => ids.length ? ctx.db.all(`SELECT cx.*, e.name, e.video_url, e.poster_url, e.category FROM complex_exercises cx JOIN exercises e ON e.id = cx.exercise_id WHERE cx.complex_id IN (${ids.map(() => '?').join(',')}) ORDER BY cx.position`, ...ids) : [];
function shape(ctx, rows) {
  const items = itemsOf(ctx, rows.map((r) => r.id));
  const used = new Map(rows.length ? ctx.db.all(`SELECT complex_id, COUNT(*) AS n FROM workout_blocks WHERE complex_id IN (${rows.map(() => '?').join(',')}) GROUP BY complex_id`, ...rows.map((r) => r.id)).map((r) => [r.complex_id, r.n]) : []);
  return rows.map((r) => ({ ...r, kind_label: GROUP_KINDS[r.kind], used_in: used.get(r.id) ?? 0, exercises: tagGroups(items.filter((x) => x.complex_id === r.id).map(({ complex_id, ...x }) => x)) }));
}
export function listComplexes(ctx) {
  return shape(ctx, ctx.db.all('SELECT * FROM complexes ORDER BY name COLLATE NOCASE'));
}
export function getComplex(ctx, id) {
  const r = ctx.db.get('SELECT * FROM complexes WHERE id = ?', id);
  if (!r) throw notFound('Complex');
  return shape(ctx, [r])[0];
}
function fields(body, cur = null) {
  const f = { name: cur?.name ?? null, kind: cur?.kind ?? 'block', note: cur?.note ?? null };
  if (body.name !== undefined || !cur) { f.name = v.str(body.name, 'name', { max: MAX_COMPLEX_NAME }).trim(); if (!f.name) throw badRequest('Name the complex, like Acceleration Primer.'); }
  if (body.kind !== undefined) f.kind = body.kind === null || body.kind === '' ? 'block' : v.oneOf(body.kind, 'kind', Object.keys(GROUP_KINDS));
  if (body.note !== undefined) f.note = v.str(body.note, 'note', { max: 500, optional: true }) || null;
  return f;
}
// Every exercise checked before anything is written (all or nothing), each with the builder's set fields.
function exerciseRows(ctx, list) {
  if (!Array.isArray(list) || !list.length) throw badRequest('Add at least one exercise to the complex.');
  if (list.length > MAX_COMPLEX_EXERCISES) throw badRequest(`A complex can have up to ${MAX_COMPLEX_EXERCISES} exercises.`);
  return list.map((x, i) => {
    if (!x || typeof x !== 'object') throw badRequest(`Exercise ${i + 1}: send its exercise_id and set details.`);
    const e = getExercise(ctx, v.str(x.exercise_id, `exercise ${i + 1}`));
    const { group_label, group_kind, ...rest } = x;
    const load = loadInput(rest);
    return { ...slotFields(rest), exercise_id: e.id, load_test: load.test, load_pct: load.pct };
  });
}
const nameTaken = (ctx, name, exceptId = null) => ctx.db.get('SELECT id FROM complexes WHERE lower(name) = lower(?) AND id IS NOT ?', name, exceptId);
function writeExercises(ctx, complexId, rows) {
  ctx.db.run('DELETE FROM complex_exercises WHERE complex_id = ?', complexId);
  rows.forEach((f, i) => ctx.db.run(`INSERT INTO complex_exercises (id, complex_id, exercise_id, position, prescription, load_test, load_pct, ${COLS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ${COLS.map(() => '?').join(', ')})`,
    newId('cx'), complexId, f.exercise_id, i + 1, f.prescription, f.load_test ?? null, f.load_pct ?? null, ...COLS.map((c) => (c === 'form_check' ? (f.form_check ? 1 : 0) : f[c] ?? null))));
}
export function createComplex(ctx, body = {}, user = null) {
  const f = fields(body);
  if (nameTaken(ctx, f.name)) throw conflict(`A complex called ${f.name} is already in the library. Open it under Complexes, or pick another name.`);
  const rows = exerciseRows(ctx, body.exercises);
  const id = newId('cpx');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO complexes (id, name, kind, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, f.name, f.kind, f.note, user?.name ?? null, ctx.now());
    writeExercises(ctx, id, rows);
  });
  return getComplex(ctx, id);
}
// The whole list again when exercises are sent; the name, kind and note alone otherwise. Workouts built from it keep what they have.
export function updateComplex(ctx, id, body = {}) {
  const cur = ctx.db.get('SELECT * FROM complexes WHERE id = ?', id);
  if (!cur) throw notFound('Complex');
  const f = fields(body, cur);
  if (nameTaken(ctx, f.name, id)) throw conflict(`A complex called ${f.name} is already in the library.`);
  const rows = body.exercises !== undefined ? exerciseRows(ctx, body.exercises) : null;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE complexes SET name = ?, kind = ?, note = ?, updated_at = ? WHERE id = ?', f.name, f.kind, f.note, ctx.now(), id);
    if (rows) writeExercises(ctx, id, rows);
  });
  return getComplex(ctx, id);
}
// Deleting a complex leaves every workout built from it as it is (the block just stops saying where it came from).
export function deleteComplex(ctx, id) {
  const c = getComplex(ctx, id);
  ctx.db.run('DELETE FROM complexes WHERE id = ?', id);
  return { id, deleted: true, name: c.name, was_used_in: c.used_in };
}
// Save a workout's block as a complex (name defaults to the block's), so it can be loaded into other workouts.
export function saveBlockAsComplex(ctx, blockId, body = {}, user = null) {
  const b = ctx.db.get('SELECT * FROM workout_blocks WHERE id = ?', blockId);
  if (!b) throw notFound('Block');
  const items = ctx.db.all('SELECT * FROM workout_exercises WHERE block_id = ? ORDER BY position', blockId);
  if (!items.length) throw badRequest('Add exercises to the block first, then save it as a complex.');
  const f = fields({ ...body, name: body.name ?? b.name, kind: body.kind ?? b.kind });
  if (nameTaken(ctx, f.name)) throw conflict(`A complex called ${f.name} is already in the library. Pick another name.`);
  const id = newId('cpx');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO complexes (id, name, kind, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, f.name, f.kind, f.note, user?.name ?? null, ctx.now());
    writeExercises(ctx, id, items.map((x) => ({ ...x, form_check: x.form_check })));
    ctx.db.run('UPDATE workout_blocks SET complex_id = ? WHERE id = ?', id, blockId);
    syncBlocks(ctx, b.workout_id);
  });
  return getComplex(ctx, id);
}
// Used by deleteExercise: an exercise in a complex can't leave the library.
export const complexesUsing = (ctx, exerciseId) => ctx.db.all('SELECT DISTINCT c.name FROM complex_exercises cx JOIN complexes c ON c.id = cx.complex_id WHERE cx.exercise_id = ? ORDER BY c.name', exerciseId).map((r) => r.name);
