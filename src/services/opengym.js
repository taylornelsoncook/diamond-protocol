// Open gym (owner's ask: "on the kiosk add a separate button at the top that says open gym and lives there; someone
// clicks it, checks in to open gym and goes back to the sign-in screen, so we can track open gym members"; schema 91).
//
// The front-desk tablet always shows Open gym above the sessions. An athlete taps it and types their Athlete ID; the
// visit is kept in open_gym_visits (one per athlete, location and business day: a second sign-in the same day answers
// "already"). It only tracks who uses open gym: no membership visit or pack session is used and nothing is charged. The
// same rules as a session sign-in: an unknown ID counts toward the tablet's misses, an archived profile and a family
// locked out over a payment go to the front desk. Staff read the visits on Schedule → Open gym (report), and each one is
// on the athlete's timeline and attendance, counts as "last seen" and in a group's times attended.
import { newId, v, conflict, HttpError, isDate, addDaysToDate, localDate } from '../util.js';
import { getSetting } from './families.js';
import { findByAthleteId } from './athlete-ids.js';
import { clientLock } from './lockout.js';
import { rateLimit } from './security.js';
import { emit } from './events.js';

const zone = (ctx) => getSetting(ctx, 'timezone');

// The tablet: kioskFor (from checkin.js) is passed in so the two files don't import each other.
export function signIn(ctx, k, body = {}) {
  const raw = v.str(body.athlete_id, 'Athlete ID', { max: 30 });
  const found = findByAthleteId(ctx, raw);
  const c = found && ctx.db.get('SELECT id, name, family_id, archived_at, access_token FROM clients WHERE id = ?', found.client_id);
  if (!c || String(c.access_token ?? '').startsWith('gone_')) {   // a deleted family's athlete
    rateLimit(`kiosk-miss:${k.id}`, 30, 15 * 60000);
    throw new HttpError(404, 'not_found', 'We couldn\'t find that Athlete ID. Check it (like AVALOP2026), or see the front desk.');
  }
  const first = c.name.split(' ')[0];
  if (c.archived_at) throw new HttpError(409, 'see_front_desk', `${first}, your profile isn't active right now. Please see the front desk.`);
  if (clientLock(ctx, c.id)) throw new HttpError(402, 'payment_locked', `${first}, please check in at the front desk.`);
  const day = localDate(ctx.now(), zone(ctx));
  const id = newId('ogv');
  const r = ctx.db.run(`INSERT INTO open_gym_visits (id, client_id, location_id, day, source, by_name, created_at) VALUES (?, ?, ?, ?, 'kiosk', ?, ?) ON CONFLICT (client_id, location_id, day) DO NOTHING`,
    id, c.id, k.location_id, day, k.name, ctx.now());
  if (r.changes) emit(ctx, 'open_gym.checked_in', { visit_id: id, client_id: c.id, client_name: c.name, location_id: k.location_id, location_name: k.location_name });
  return { name: first, session: 'Open gym', already: !r.changes, pay_at_desk: false, open_gym: true, visits_this_month: monthCount(ctx, c.id, day) };
}
const monthCount = (ctx, clientId, day) => ctx.db.get('SELECT COUNT(*) AS n FROM open_gym_visits WHERE client_id = ? AND day >= ? AND day <= ?', clientId, `${day.slice(0, 7)}-01`, day).n;

// GET /v1/open-gym: the visits between two business days (default the last 30 days), at one place or all: the count,
// how many athletes, each day's count, each athlete's visits (most first) and the visits themselves (newest first).
export function report(ctx, query = {}) {
  const today = localDate(ctx.now(), zone(ctx));
  const from = query.from ? String(query.from) : addDaysToDate(today, -29), to = query.to ? String(query.to) : today;
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, 'invalid_request', 'Choose real dates, like 2026-10-01.');
  if (from > to) throw new HttpError(400, 'invalid_request', 'The start date is after the end date. Swap them.');
  const loc = query.location_id ? v.str(query.location_id, 'location_id', { max: 60 }) : null;
  const rows = ctx.db.all(`SELECT g.id, g.day, g.created_at, g.source, g.by_name, g.client_id, c.name, c.athlete_id, c.archived_at, l.name AS location_name, g.location_id
    FROM open_gym_visits g JOIN clients c ON c.id = g.client_id JOIN locations l ON l.id = g.location_id
    WHERE g.day >= ? AND g.day <= ? ${loc ? 'AND g.location_id = ?' : ''} ORDER BY g.created_at DESC`, from, to, ...(loc ? [loc] : []));
  const byDay = new Map(), byAthlete = new Map();
  for (const r of rows) {
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + 1);
    const a = byAthlete.get(r.client_id) ?? { client_id: r.client_id, name: r.name, athlete_id: r.athlete_id, archived: !!r.archived_at, visits: 0, last_at: r.created_at };
    a.visits += 1;
    byAthlete.set(r.client_id, a);
  }
  const days = [];
  for (let d = from; d <= to && days.length < 400; d = addDaysToDate(d, 1)) days.push({ day: d, visits: byDay.get(d) ?? 0 });
  return {
    from, to, location_id: loc, total: rows.length, athletes: byAthlete.size, today: byDay.get(today) ?? 0,
    by_day: days, by_athlete: [...byAthlete.values()].sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name)),
    visits: rows.slice(0, 500).map((r) => ({ id: r.id, at: r.created_at, day: r.day, client_id: r.client_id, name: r.name, athlete_id: r.athlete_id, location_name: r.location_name, by: r.by_name }))
  };
}
// The visits as a spreadsheet (same filter).
export function exportCsv(ctx, query = {}) {
  const r = report(ctx, query);
  const z = zone(ctx);
  const cell = (x) => { const s = String(x ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s); };
  const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: z });
  const lines = [['Day', 'Time', 'Athlete', 'Athlete ID', 'Location', 'Signed in on'], ...r.visits.map((x) => [x.day, time(x.at), x.name, x.athlete_id, x.location_name, x.by])];
  return { filename: `open-gym-${r.from}-to-${r.to}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(`﻿${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`) };
}
// Staff take back a visit signed in by mistake.
export function removeVisit(ctx, id) {
  const r = ctx.db.run('DELETE FROM open_gym_visits WHERE id = ?', v.str(id, 'id', { max: 60 }));
  if (!r.changes) throw conflict('That open gym visit is already gone.');
  return { deleted: true };
}
// The family export: when and where.
export const forExport = (ctx, clientId) => ctx.db.all('SELECT g.day, g.created_at AS signed_in_at, l.name AS location FROM open_gym_visits g JOIN locations l ON l.id = g.location_id WHERE g.client_id = ? ORDER BY g.created_at', clientId);
