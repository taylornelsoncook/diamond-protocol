import { localDate, badRequest, conflict } from '../util.js';
import { getSetting } from './families.js';

// Athlete ID: first 3 letters of the first name + first 3 of the last name + the year they joined.
// Ava Lopez, 2026 → AVALOP2026. A second Ava Lopez that year gets AVALOP2026-2.
// It never changes when a name changes, so every result, booking and file stays connected.
const letters = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g, '');

export function baseAthleteId(fullName, year) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  const first = letters(parts[0]);
  const last = letters(parts.slice(1).join(' ').replace(/\b(jr|sr|ii|iii|iv|v)\.?$/i, ''));
  const pad = (s) => (s + 'XXX').slice(0, 3);
  return `${pad(first)}${pad(last)}${year}`;
}
export const ID_PATTERN = /^[A-Z]{6}\d{4}(-\d{1,3})?$/;
// One profile per athlete: an ID is taken when a client has it, or when it still finds a client as an old roster ID
// (athlete_id_aliases). Roster lines carry a copy of their client's ID, so they're checked too (for databases mid-upgrade).
const aliasOf = (ctx, id) => ctx.db.get('SELECT client_id FROM athlete_id_aliases WHERE athlete_id = ?', id);
const taken = (ctx, id) => !!(ctx.db.get('SELECT 1 FROM clients WHERE athlete_id = ?', id) || aliasOf(ctx, id) || ctx.db.get('SELECT 1 FROM team_roster WHERE athlete_id = ?', id));

export function newAthleteId(ctx, fullName, createdAt = ctx.now()) {
  const year = localDate(createdAt, getSetting(ctx, 'timezone')).slice(0, 4);
  const base = baseAthleteId(fullName, year);
  if (!taken(ctx, base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken(ctx, `${base}-${n}`)) return `${base}-${n}`;
  throw conflict('Could not create a unique athlete ID.');
}
// Coaches can correct an ID (for example to match a device), but IDs stay unique. An old roster ID that still finds
// this same athlete may become their ID again.
export function validateAthleteId(ctx, raw, { exceptClient } = {}) {
  const id = String(raw ?? '').trim().toUpperCase();
  if (!ID_PATTERN.test(id)) throw badRequest('Athlete IDs look like AVALOP2026 (3 + 3 letters and a year), optionally with -2.');
  const c = ctx.db.get('SELECT id FROM clients WHERE athlete_id = ?', id), alias = aliasOf(ctx, id);
  const r = ctx.db.get('SELECT client_id FROM team_roster WHERE athlete_id = ? AND (client_id IS NULL OR client_id != ?) LIMIT 1', id, exceptClient ?? '');
  if ((c && c.id !== exceptClient) || (alias && alias.client_id !== exceptClient) || r) throw conflict(`${id} already belongs to another athlete.`);
  return id;
}
// Gives an ID to anyone who doesn't have one yet (athletes created before IDs existed), oldest first. Roster lines
// then copy their client's ID.
export function assignMissingIds(ctx) {
  const rows = ctx.db.all('SELECT id, name, created_at FROM clients WHERE athlete_id IS NULL ORDER BY created_at');
  for (const r of rows) ctx.db.run('UPDATE clients SET athlete_id = ? WHERE id = ?', newAthleteId(ctx, r.name, r.created_at), r.id);
  ctx.db.run(`UPDATE team_roster SET athlete_id = (SELECT c.athlete_id FROM clients c WHERE c.id = team_roster.client_id)
    WHERE client_id IS NOT NULL AND athlete_id IS NOT (SELECT c.athlete_id FROM clients c WHERE c.id = team_roster.client_id)`);
  return rows.length;
}
// Finds an athlete's profile by ID, any capitalization: their Athlete ID, or an old team roster ID from before
// version 36 that now belongs to their profile. Always { client_id } (or null).
export function findByAthleteId(ctx, raw) {
  const id = String(raw ?? '').trim().toUpperCase();
  if (!ID_PATTERN.test(id)) return null;
  const c = ctx.db.get('SELECT id FROM clients WHERE athlete_id = ?', id);
  if (c) return { client_id: c.id };
  const a = aliasOf(ctx, id);
  return a ? { client_id: a.client_id } : null;
}
// The profile a team roster line belongs to (every line has one since version 36).
export const clientOfRoster = (ctx, rosterId) => (rosterId ? ctx.db.get('SELECT client_id FROM team_roster WHERE id = ?', String(rosterId))?.client_id ?? null : null);
