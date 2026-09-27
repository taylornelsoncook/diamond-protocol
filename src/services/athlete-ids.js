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
const taken = (ctx, id) => !!(ctx.db.get('SELECT 1 FROM clients WHERE athlete_id = ?', id) || ctx.db.get('SELECT 1 FROM team_roster WHERE athlete_id = ?', id));

export function newAthleteId(ctx, fullName, createdAt = ctx.now()) {
  const year = localDate(createdAt, getSetting(ctx, 'timezone')).slice(0, 4);
  const base = baseAthleteId(fullName, year);
  if (!taken(ctx, base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken(ctx, `${base}-${n}`)) return `${base}-${n}`;
  throw conflict('Could not create a unique athlete ID.');
}
// Coaches can correct an ID (for example to match a device), but IDs stay unique.
export function validateAthleteId(ctx, raw, { exceptClient, exceptRoster } = {}) {
  const id = String(raw ?? '').trim().toUpperCase();
  if (!ID_PATTERN.test(id)) throw badRequest('Athlete IDs look like AVALOP2026 (3 + 3 letters and a year), optionally with -2.');
  const c = ctx.db.get('SELECT id FROM clients WHERE athlete_id = ?', id), r = ctx.db.get('SELECT id FROM team_roster WHERE athlete_id = ?', id);
  if ((c && c.id !== exceptClient) || (r && r.id !== exceptRoster)) throw conflict(`${id} already belongs to another athlete.`);
  return id;
}
// Gives an ID to anyone who doesn't have one yet (athletes created before IDs existed), oldest first.
export function assignMissingIds(ctx) {
  const rows = [
    ...ctx.db.all('SELECT id, name, created_at, \'clients\' AS t FROM clients WHERE athlete_id IS NULL'),
    ...ctx.db.all('SELECT id, name, created_at, \'team_roster\' AS t FROM team_roster WHERE athlete_id IS NULL')
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const r of rows) ctx.db.run(`UPDATE ${r.t} SET athlete_id = ? WHERE id = ?`, newAthleteId(ctx, r.name, r.created_at), r.id);
  return rows.length;
}
// Finds an athlete by ID, any capitalization.
export function findByAthleteId(ctx, raw) {
  const id = String(raw ?? '').trim().toUpperCase();
  if (!ID_PATTERN.test(id)) return null;
  const c = ctx.db.get('SELECT id FROM clients WHERE athlete_id = ?', id);
  if (c) return { client_id: c.id };
  const r = ctx.db.get('SELECT id FROM team_roster WHERE athlete_id = ?', id);
  return r ? { roster_id: r.id } : null;
}
