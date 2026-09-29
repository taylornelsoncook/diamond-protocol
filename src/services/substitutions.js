import { newId, v, notFound, badRequest, conflict } from '../util.js';
import { ALT_TAGS } from './programs.js';
import { insertSwaps } from './live.js';

// Exercise substitutions (version 57): for each exercise in the library a coach lists the swaps an athlete may pick on
// their own (no barbell, knee, at home...). In the app, "Can't do this today?" on an exercise card offers that list;
// the pick is an exercise_swaps row for that slot, marked by_kind 'athlete', so the log, the screen and the coach's
// live view follow it like a coach's swap. A remote athlete never gets stuck; a coach's own swap is never overridden.

export const TAGS = ALT_TAGS;
const shape = (r) => ({ ...r, tag_label: TAGS[r.tag] ?? r.tag });

export function listAlternatives(ctx, exerciseId) {
  if (!ctx.db.get('SELECT id FROM exercises WHERE id = ?', String(exerciseId))) throw notFound('Exercise');
  return ctx.db.all(`SELECT a.id, a.alt_exercise_id AS exercise_id, e.name, e.category, a.tag, a.note, a.created_at FROM exercise_alternatives a JOIN exercises e ON e.id = a.alt_exercise_id
    WHERE a.exercise_id = ? ORDER BY e.name COLLATE NOCASE`, exerciseId).map(shape);
}
// Add a swap to an exercise's list (owner and coach). Listing the same swap again changes its tag and note.
export function addAlternative(ctx, exerciseId, body = {}) {
  const from = ctx.db.get('SELECT id, name FROM exercises WHERE id = ?', String(exerciseId));
  if (!from) throw notFound('Exercise');
  const to = ctx.db.get('SELECT id, name FROM exercises WHERE id = ?', v.str(body.exercise_id, 'exercise_id'));
  if (!to) throw notFound('Exercise');
  if (to.id === from.id) throw badRequest(`${from.name} can't stand in for itself. Pick a different exercise.`);
  const tag = v.oneOf(body.tag ?? 'other', 'tag', Object.keys(TAGS));
  const note = v.str(body.note, 'note', { max: 200, optional: true }) || null;
  ctx.db.run(`INSERT INTO exercise_alternatives (id, exercise_id, alt_exercise_id, tag, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (exercise_id, alt_exercise_id) DO UPDATE SET tag = excluded.tag, note = excluded.note`, newId('alt'), from.id, to.id, tag, note, ctx.now());
  return listAlternatives(ctx, from.id).find((a) => a.exercise_id === to.id);
}
export function removeAlternative(ctx, id) {
  if (!ctx.db.get('SELECT id FROM exercise_alternatives WHERE id = ?', String(id))) throw notFound('Swap');
  ctx.db.run('DELETE FROM exercise_alternatives WHERE id = ?', String(id));
  return { id, deleted: true };
}
// How many exercises have a list, for the library's count line.
export const counts = (ctx) => ctx.db.get('SELECT COUNT(DISTINCT exercise_id) AS exercises, COUNT(*) AS swaps FROM exercise_alternatives');

// ---------- The athlete's side ----------
// The slot must be in the athlete's own program and not logged yet; the pick must be on the coach's list for the
// plan's exercise there; a coach's own swap on that slot stays.
function slotOf(ctx, client, body) {
  const slot = ctx.db.get(`SELECT we.id, we.exercise_id, we.workout_id, w.program_id, e.name FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id JOIN exercises e ON e.id = we.exercise_id WHERE we.id = ?`, v.str(body.workout_exercise_id, 'workout_exercise_id'));
  if (!slot) throw notFound('Exercise in the workout');
  if (!ctx.db.get('SELECT id FROM assignments WHERE client_id = ? AND active = 1 AND program_id = ?', client.id, slot.program_id)) throw conflict('That workout isn\'t in your program.');
  if (ctx.db.get('SELECT id FROM workout_logs WHERE client_id = ? AND workout_id = ?', client.id, slot.workout_id)) throw conflict('You already logged this workout.');
  return slot;
}
export function athleteSwap(ctx, client, body = {}) {
  const slot = slotOf(ctx, client, body);
  const alt = ctx.db.get('SELECT a.id, a.alt_exercise_id, a.tag, e.name FROM exercise_alternatives a JOIN exercises e ON e.id = a.alt_exercise_id WHERE a.id = ? AND a.exercise_id = ?', v.str(body.alternative_id, 'alternative_id'), slot.exercise_id);
  if (!alt) throw badRequest('Pick one of the swaps your coach listed for this exercise.');
  const cur = ctx.db.get('SELECT id, by_kind FROM exercise_swaps WHERE client_id = ? AND workout_exercise_id = ?', client.id, slot.id);
  if (cur && cur.by_kind !== 'athlete') throw conflict('Your coach already swapped this one for you. Ask them if you need something else.');
  const id = insertSwaps(ctx, { client, slotIds: [slot.id], to: { id: alt.alt_exercise_id, name: alt.name }, insteadOf: slot.name, reason: TAGS[alt.tag] ?? alt.tag, sessionId: null, by: client.name.split(' ')[0], byKind: 'athlete', scope: 'workout' });
  return { id, workout_exercise_id: slot.id, exercise_id: alt.alt_exercise_id, exercise_name: alt.name, instead_of: slot.name, reason: TAGS[alt.tag] ?? alt.tag };
}
// Back to the plan: only a swap the athlete picked themself, on a workout not logged yet.
export function athleteUnswap(ctx, client, id) {
  const sw = ctx.db.get(`SELECT s.id, s.by_kind, we.workout_id FROM exercise_swaps s JOIN workout_exercises we ON we.id = s.workout_exercise_id WHERE s.id = ? AND s.client_id = ?`, String(id), client.id);
  if (!sw) throw notFound('Swap');
  if (sw.by_kind !== 'athlete') throw conflict('Your coach made this swap. Ask them if you need something else.');
  if (ctx.db.get('SELECT id FROM workout_logs WHERE client_id = ? AND workout_id = ?', client.id, sw.workout_id)) throw conflict('You already logged this workout.');
  ctx.db.run('DELETE FROM exercise_swaps WHERE id = ?', sw.id);
  return { id: sw.id, deleted: true };
}
