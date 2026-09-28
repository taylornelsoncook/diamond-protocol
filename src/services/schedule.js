import { newId, v, notFound, badRequest, conflict, HttpError, zonedToUtc, localDate, weekdayOf, addDaysToDate, ageOn, isTime, isDate, withLock, sha256 } from '../util.js';
import { emit } from './events.js';
import { getSetting, payerFor } from './families.js';
import { notifyFamily, sendEmail } from './mail.js';
import { textFamily } from './sms.js';
import * as commerce from './commerce.js';
import { teamRosterFor } from './teams.js';

const SERIES_KINDS = ['group', 'camp', 'clinic', 'team', 'evaluation'];
const HORIZON_DAYS = 56;                     // open-ended classes are scheduled 8 weeks ahead, extended daily
const creditTypeFor = (kind) => (kind === 'private' ? 'private' : kind === 'group' ? 'group' : null);
const tz = (ctx) => getSetting(ctx, 'timezone');
const first = (name) => name.split(' ')[0];
const isMember = (ctx, clientId) => !!ctx.db.get(`SELECT id FROM subscriptions WHERE client_id = ? AND status IN ('active','trialing','past_due') LIMIT 1`, clientId);
const notArchived = (c, isCoach) => { if (c.archived_at) throw conflict(isCoach ? `${first(c.name)} is archived. Restore them on their client page first.` : `${first(c.name)}'s account is archived. Ask your coach to reopen it.`); };
const when = (ctx, iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz(ctx), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
// '17:30': the wall-clock time of an instant in the business time zone (daylight saving included).
const localTime = (iso, zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const minutesOf = (x) => Math.round((Date.parse(x.ends_at) - Date.parse(x.starts_at)) / 60000);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
// The class day a session of a series stands for: where it was first scheduled, even if it moved to another day since.
const slotDay = (x, zone) => x.slot_date ?? localDate(x.starts_at, zone);

// ---------- Coaches ----------
// Staff who can lead a session: active owners and coaches. Front desk accounts don't lead sessions.
export function listCoaches(ctx) {
  return ctx.db.all(`SELECT id, name, role FROM users WHERE active = 1 AND role IN ('owner','coach') ORDER BY name COLLATE NOCASE`);
}
// The owner's Coaches panel on Today: for each active coach (and owner who leads sessions), today's sessions and the next
// one, the next 7 days (sessions, how full the classes are, privates booked), attendance at what they led in the last 7
// days, and their upcoming days off. Sessions with no coach are counted too, so nothing goes unnoticed. No money.
const CLASS_KINDS = ['group', 'clinic', 'camp'];
export function coachSummary(ctx) {
  const zone = tz(ctx), now = ctx.now(), today = localDate(now, zone);
  const dayEnd = zonedToUtc(addDaysToDate(today, 1), '00:00', zone), weekEnd = zonedToUtc(addDaysToDate(today, 7), '00:00', zone);
  const week = listSessions(ctx, { from: zonedToUtc(today, '00:00', zone), to: weekEnd });
  const att = new Map(ctx.db.all(`SELECT s.coach_id, SUM(b.status = 'attended') AS came, SUM(b.status = 'no_show') AS missed FROM bookings b JOIN class_sessions s ON s.id = b.session_id
    WHERE s.status = 'scheduled' AND s.starts_at >= ? AND s.starts_at < ? GROUP BY s.coach_id`, new Date(Date.parse(now) - 7 * 86400000).toISOString(), now).map((r) => [r.coach_id, r]));
  const off = listTimeOff(ctx, { from: today, to: addDaysToDate(today, 30) });
  const facilityOff = off.filter((t) => !t.user_id).map(({ id, start_date, end_date, note }) => ({ id, start_date, end_date, note }));
  const summarize = (list, a) => {
    const classes = list.filter((x) => CLASS_KINDS.includes(x.kind));
    const cap = classes.reduce((t, x) => t + x.capacity, 0), booked = classes.reduce((t, x) => t + x.booked_count, 0);
    const todays = list.filter((x) => x.starts_at < dayEnd), next = list.find((x) => x.ends_at > now);
    return {
      today: { sessions: todays.length, booked: todays.reduce((t, x) => t + x.booked_count, 0) },
      next_session: next ? { id: next.id, name: next.name, kind: next.kind, starts_at: next.starts_at, location_name: next.location_name, booked: next.booked_count, capacity: next.capacity } : null,
      week: { sessions: list.length, classes: classes.length, class_spots: cap, class_booked: booked, fill_pct: cap ? Math.round((booked / cap) * 100) : null,
        privates_booked: list.filter((x) => x.kind === 'private' && x.booked_count > 0).length, evaluations_booked: list.filter((x) => x.kind === 'evaluation' && x.booked_count > 0).length },
      attendance_7_days: { came: a?.came ?? 0, missed: a?.missed ?? 0 }
    };
  };
  const coaches = listCoaches(ctx).map((c) => ({ id: c.id, name: c.name, role: c.role, ...summarize(week.filter((x) => x.coach_id === c.id), att.get(c.id)),
    time_off: off.filter((t) => t.user_id === c.id).map(({ id, start_date, end_date, note }) => ({ id, start_date, end_date, note })) }));
  const unassigned = week.filter((x) => !x.coach_id);
  return { date: today, timezone: zone, coaches, no_coach: { sessions: unassigned.length, next: unassigned[0] ? { id: unassigned[0].id, name: unassigned[0].name, starts_at: unassigned[0].starts_at } : null }, facility_time_off: facilityOff };
}
// A coach_id from a request: null or '' clears it, anything else must be an active owner or coach.
function coachInput(ctx, x) {
  if (x === null || x === '') return null;
  const u = ctx.db.get('SELECT id, name, role, active FROM users WHERE id = ?', v.str(x, 'coach_id', { max: 64 }));
  if (!u) throw notFound('Coach');
  if (!u.active) throw conflict(`${u.name}'s account is turned off. Pick an active coach.`);
  if (u.role === 'front_desk') throw badRequest(`${u.name} is front desk. Pick a coach or an owner to lead this.`);
  return u.id;
}

// ---------- Series (recurring classes, camps, clinics, team sessions) ----------
function seriesInput(body, cur = {}) {
  const pick = (k, fn) => (body[k] !== undefined ? fn(body[k]) : cur[k]);
  const out = {
    name: pick('name', (x) => v.str(x, 'name', { max: 80 })),
    kind: pick('kind', (x) => v.oneOf(x, 'kind', SERIES_KINDS)),
    description: pick('description', (x) => v.str(x, 'description', { max: 2000, optional: true })),
    location_id: pick('location_id', (x) => v.str(x, 'location_id')),
    weekdays: pick('weekdays', (x) => { if (!Array.isArray(x) || !x.length || x.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw badRequest('weekdays must list days 0 (Sunday) to 6 (Saturday).'); return JSON.stringify([...new Set(x)].sort()); }),
    start_time: pick('start_time', (x) => { if (!isTime(x)) throw badRequest('start_time must look like 17:30.'); return x; }),
    duration_min: pick('duration_min', (x) => v.int(x, 'duration_min', { min: 10, max: 600 })),
    capacity: pick('capacity', (x) => v.int(x, 'capacity', { min: 1, max: 500 })),
    age_min: pick('age_min', (x) => v.int(x, 'age_min', { min: 3, max: 99, optional: true })),
    age_max: pick('age_max', (x) => v.int(x, 'age_max', { min: 3, max: 99, optional: true })),
    drop_in_cents: pick('drop_in_cents', (x) => v.int(x, 'drop_in_cents', { min: 0, max: 10000000, optional: true })),
    registration_cents: pick('registration_cents', (x) => v.int(x, 'registration_cents', { min: 0, max: 10000000, optional: true })),
    start_date: pick('start_date', (x) => { if (!isDate(x)) throw badRequest('start_date must look like 2026-10-05.'); return x; }),
    end_date: pick('end_date', (x) => { if (x === null || x === '') return null; if (!isDate(x)) throw badRequest('end_date must look like 2026-12-18.'); return x; })
  };
  if (out.age_min && out.age_max && out.age_min > out.age_max) throw badRequest('age_min must be less than age_max.');
  if (out.end_date && out.end_date < out.start_date) throw badRequest('end_date must be after start_date.');
  if (['camp', 'clinic'].includes(out.kind) && !out.end_date) throw badRequest('Camps and clinics need an end_date.');
  if (['camp', 'clinic'].includes(out.kind) && out.registration_cents == null && out.drop_in_cents == null) throw badRequest('Give camps and clinics a registration price, a single-day price, or both.');
  return out;
}

export async function createSeries(ctx, body) {
  const s = seriesInput(body);
  commerce.getLocation(ctx, s.location_id);
  let contractId = null;
  if (body.contract_id) {
    if (s.kind !== 'team') throw badRequest('Only team sessions can belong to a team contract.');
    contractId = ctx.db.get('SELECT id FROM team_contracts WHERE id = ?', body.contract_id)?.id;
    if (!contractId) throw notFound('Team contract');
  }
  const coachId = body.coach_id !== undefined ? coachInput(ctx, body.coach_id) : null;
  const id = newId('ser');
  ctx.db.run(`INSERT INTO class_series (id, name, kind, description, location_id, weekdays, start_time, duration_min, capacity, age_min, age_max, drop_in_cents, registration_cents, start_date, end_date, contract_id, coach_id, active, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    id, s.name, s.kind, s.description, s.location_id, s.weekdays, s.start_time, s.duration_min, s.capacity, s.age_min, s.age_max, s.drop_in_cents, s.registration_cents, s.start_date, s.end_date, contractId, coachId, ctx.now());
  await generateSessions(ctx, id);
  return getSeries(ctx, id);
}
export function getSeries(ctx, id) {
  const s = ctx.db.get('SELECT s.*, l.name AS location_name, u.name AS coach_name FROM class_series s JOIN locations l ON l.id = s.location_id LEFT JOIN users u ON u.id = s.coach_id WHERE s.id = ?', id);
  if (!s) throw notFound('Class');
  s.weekdays = JSON.parse(s.weekdays);
  s.active = !!s.active;
  s.enrolled = ctx.db.all(`SELECT e.id, e.kind, c.id AS client_id, c.name FROM enrollments e JOIN clients c ON c.id = e.client_id WHERE e.series_id = ? AND e.status = 'active' ORDER BY c.name`, id);
  s.upcoming_sessions = ctx.db.get(`SELECT COUNT(*) AS n FROM class_sessions WHERE series_id = ? AND status = 'scheduled' AND starts_at > ?`, id, ctx.now()).n;
  return s;
}
export function listSeries(ctx, { kind, includeInactive = false } = {}) {
  const where = [], p = [];
  if (kind) { where.push('s.kind = ?'); p.push(kind); }
  if (!includeInactive) where.push('s.active = 1');
  return ctx.db.all(`SELECT s.*, l.name AS location_name, u.name AS coach_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.series_id = s.id AND e.status = 'active') AS enrolled_count
    FROM class_series s JOIN locations l ON l.id = s.location_id LEFT JOIN users u ON u.id = s.coach_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.kind, s.start_date, s.start_time`, ...p)
    .map((s) => ({ ...s, weekdays: JSON.parse(s.weekdays), active: !!s.active }));
}
// Edit a class, camp or clinic. Every upcoming session follows what changed: a new time or place (booked families get
// one email listing every session of theirs that moved), length, spots, ages, price, coach and name. A session changed on
// its own (a sub coach, a moved time, more spots) keeps that change: a field is carried to a session only while the
// session still has the class's old value. Sessions on days the class no longer runs are canceled (credits back, paid
// drop-ins refunded, one email per family); new days are added. Sessions never move into the past, spots never drop
// below what a session already has booked, and a time another session of the class already has is refused.
// active=false archives the class: every future session is canceled. A new coach takes over the upcoming sessions,
// except ones given to a sub. One edit at a time per class, and never while the schedule job is adding its sessions.
export function updateSeries(ctx, id, body) { return withLock(`series:${id}`, () => updateSeriesNow(ctx, id, body)); }
const SESSION_COPIES = ['name', 'capacity', 'age_min', 'age_max', 'drop_in_cents', 'location_id', 'coach_id'];
async function updateSeriesNow(ctx, id, body) {
  const cur = getSeries(ctx, id);
  const zone = tz(ctx), now = ctx.now();
  const s = seriesInput({ ...body, kind: undefined }, { ...cur, weekdays: JSON.stringify(cur.weekdays) });   // the type never changes
  if (s.location_id !== cur.location_id) commerce.getLocation(ctx, s.location_id);
  const coachId = body.coach_id !== undefined ? coachInput(ctx, body.coach_id) : cur.coach_id ?? null;
  if (body.active === false) {
    ctx.db.run('UPDATE class_series SET active = 0 WHERE id = ?', id);
    const canceled = await cancelMany(ctx, cur, ctx.db.all(`SELECT * FROM class_sessions WHERE series_id = ? AND status = 'scheduled' AND starts_at > ? ORDER BY starts_at`, id, now), 'This class is no longer on the schedule.');
    return { ...getSeries(ctx, id), changes: { updated: 0, moved: 0, canceled: canceled.sessions, added: 0, families_emailed: canceled.families, promoted: 0 } };
  }
  if (!cur.active && body.active !== true) throw conflict('This class is archived. Send active: true to put it back on the schedule.');
  const after = { ...s, coach_id: coachId };
  const days = JSON.parse(s.weekdays);
  const fits = (d) => days.includes(weekdayOf(d)) && d >= s.start_date && (!s.end_date || d <= s.end_date);
  const futureSql = `SELECT x.*, (SELECT COUNT(*) FROM bookings b WHERE b.session_id = x.id AND b.status IN ('booked','attended')) AS booked_count
    FROM class_sessions x WHERE x.series_id = ? AND x.status = 'scheduled' AND x.starts_at > ? ORDER BY x.starts_at`;
  // Check and save while holding every upcoming session's booking lock: a card payment for the last spot that is still
  // going through finishes first, so its booking is counted before spots are lowered.
  const ids = ctx.db.all(futureSql, id, now).map((x) => x.id);
  const { plan, drop } = await withSessionLocks(ids, () => {
    const future = ctx.db.all(futureSql, id, now);
    const keep = future.filter((x) => fits(slotDay(x, zone))), drop = future.filter((x) => !fits(slotDay(x, zone)));
    // What each kept session becomes: only the class fields that changed, only where the session still had the old value.
    const plan = keep.map((x) => {
      const next = {};
      for (const k of SESSION_COPIES) if ((after[k] ?? null) !== (cur[k] ?? null) && (x[k] ?? null) === (cur[k] ?? null)) next[k] = after[k] ?? null;
      let starts = x.starts_at, dur = minutesOf(x);
      if (s.start_time !== cur.start_time && localTime(x.starts_at, zone) === cur.start_time) {
        const moved = zonedToUtc(localDate(x.starts_at, zone), s.start_time, zone);
        if (moved > now) starts = moved;                                     // never move a session into the past
      }
      if (s.duration_min !== cur.duration_min && dur === cur.duration_min) dur = s.duration_min;
      if (starts !== x.starts_at) next.starts_at = starts;
      if (starts !== x.starts_at || dur !== minutesOf(x)) next.ends_at = new Date(Date.parse(starts) + dur * 60000).toISOString();
      if (next.starts_at && !x.slot_date) next.slot_date = localDate(x.starts_at, zone);
      return { x, next };
    });
    const planned = new Set();
    for (const { x, next } of plan) {
      // Never squeeze anyone out: spots can't go below what an upcoming session already has booked.
      if (next.capacity != null && x.booked_count > next.capacity) throw badRequest(`${plural(x.booked_count, 'athlete')} ${x.booked_count === 1 ? 'is' : 'are'} booked on ${when(ctx, x.starts_at)}. Set spots to ${x.booked_count} or more, or remove someone first.`);
      const at = next.starts_at ?? x.starts_at;
      if (planned.has(at) || (next.starts_at && ctx.db.get('SELECT 1 FROM class_sessions WHERE series_id = ? AND starts_at = ? AND id != ?', id, at, x.id))) throw conflict(`${cur.name} already has a session at ${when(ctx, at)}. Move or cancel it first.`);
      planned.add(at);
    }
    ctx.db.tx(() => {
      ctx.db.run(`UPDATE class_series SET name = ?, description = ?, location_id = ?, weekdays = ?, start_time = ?, duration_min = ?, capacity = ?, age_min = ?, age_max = ?, drop_in_cents = ?, registration_cents = ?, start_date = ?, end_date = ?, coach_id = ?, active = 1 WHERE id = ?`,
        s.name, s.description, s.location_id, s.weekdays, s.start_time, s.duration_min, s.capacity, s.age_min, s.age_max, s.drop_in_cents, s.registration_cents, s.start_date, s.end_date, coachId, id);
      for (const { x, next } of plan) {
        const keys = Object.keys(next);
        if (keys.length) ctx.db.run(`UPDATE class_sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => next[k]), x.id);
      }
    });
    return { plan, drop };
  });
  const moves = plan.filter(({ next }) => next.starts_at || next.location_id).map(({ x, next }) => ({ before: x, after: { ...x, ...next } }));
  const families = notifyMoved(ctx, moves);
  let promoted = 0;
  for (const { x, next } of plan) if (next.capacity > x.capacity) promoted += await promoteWaitlist(ctx, x.id);
  const canceled = await cancelMany(ctx, { ...cur, name: s.name }, drop, `${s.name} no longer runs on that day.`);
  const added = await generateNow(ctx, id);
  return { ...getSeries(ctx, id), changes: { updated: plan.filter(({ next }) => Object.keys(next).length).length, moved: moves.length, canceled: canceled.sessions, added, families_emailed: families + canceled.families, promoted } };
}

// Hold several sessions' booking locks at once, taken in the same order every time. Nothing else holds more than one.
// fn must not take any of these locks again (they aren't reentrant).
function withSessionLocks(ids, fn) {
  const keys = [...new Set(ids)].sort();
  const step = (i) => (i === keys.length ? fn() : withLock(`book:${keys[i]}`, () => step(i + 1)));
  return step(0);
}
// Families of the athletes booked into these sessions (and waitlisted, if asked): one entry per family, with their
// athletes' first names and which of the sessions they're in.
function bookedFamilies(ctx, sessionIds, { waitlist = false } = {}) {
  const out = new Map();
  for (const sid of sessionIds) {
    for (const b of ctx.db.all(`SELECT c.name, c.family_id FROM bookings b JOIN clients c ON c.id = b.client_id WHERE b.session_id = ? AND b.status IN (${waitlist ? "'booked','attended','waitlisted'" : "'booked','attended'"}) AND c.family_id IS NOT NULL AND c.archived_at IS NULL ORDER BY b.created_at`, sid)) {
      if (!out.has(b.family_id)) out.set(b.family_id, { names: new Set(), sessions: new Set() });
      out.get(b.family_id).names.add(first(b.name));
      out.get(b.family_id).sessions.add(sid);
    }
  }
  return out;
}
// Tell booked families their sessions moved (new day, time or place): one email per family however many of their
// sessions changed. moves: [{ before, after }]. Returns how many families were emailed.
function notifyMoved(ctx, moves) {
  if (!moves.length) return 0;
  const byId = new Map(moves.map((m) => [m.after.id, m]));
  const place = (m) => (m.before.location_id !== m.after.location_id ? ` at ${ctx.db.get('SELECT name FROM locations WHERE id = ?', m.after.location_id)?.name ?? 'a new place'}` : '');
  const line = (m) => (m.before.starts_at !== m.after.starts_at ? `${m.after.name} on ${when(ctx, m.before.starts_at)} has moved to ${when(ctx, m.after.starts_at)}${place(m)}.` : `${m.after.name} on ${when(ctx, m.after.starts_at)} has moved${place(m)}.`);
  const fams = bookedFamilies(ctx, moves.map((m) => m.after.id));
  for (const [fam, f] of fams) {
    const lines = [...f.sessions].map((sid) => line(byId.get(sid)));
    const who = [...f.names];
    notifyFamily(ctx, fam, `New time: ${moves[0].after.name}`, `${lines.length === 1 ? lines[0] : `These sessions have moved:\n${lines.map((l) => `- ${l}`).join('\n')}\n`} ${andList(who)} ${who.length > 1 ? 'are' : 'is'} still booked. If the new time doesn't work, cancel from the parent portal.`);
  }
  return fams.size;
}
// Cancel several sessions of one class (days it no longer runs, or the whole class archived): credits back, paid drop-ins
// refunded, and one email (and text) per family listing every session of theirs, instead of one per session. A session
// nobody was booked on (no bookings, team check-ins or open-spot offers) is removed instead, like team sessions after a
// shorter contract, so putting the day back (or the class back on the schedule) schedules it again.
async function cancelMany(ctx, series, sessions, reason) {
  const byFamily = new Map();
  for (const x of sessions) {
    if (await withLock(`book:${x.id}`, () => removeIfUnused(ctx, x.id))) continue;
    const r = await cancelSessionNow(ctx, x.id, { reason, notify: false });
    for (const b of r.released) {
      if (!b.family_id) continue;
      if (!byFamily.has(b.family_id)) byFamily.set(b.family_id, []);
      byFamily.get(b.family_id).push(`${when(ctx, r.session.starts_at)}: ${releaseWords(b)}`);
    }
  }
  for (const [fam, lines] of byFamily) {
    notifyFamily(ctx, fam, `Canceled: ${series.name}${lines.length > 1 ? ` (${lines.length} sessions)` : ''}`, `${reason} ${lines.length === 1 ? 'This session is canceled' : 'These sessions are canceled'}:\n${lines.map((l) => `- ${l}`).join('\n')}`);
    textFamily(ctx, fam, 'canceled', `${series.name}: ${lines.length === 1 ? '1 session is' : `${lines.length} sessions are`} canceled. Details are in your email.`);
  }
  return { sessions: sessions.length, families: byFamily.size };
}
function removeIfUnused(ctx, id) {
  const used = ctx.db.get(`SELECT (SELECT COUNT(*) FROM bookings WHERE session_id = ?) + (SELECT COUNT(*) FROM team_attendance WHERE session_id = ?) + (SELECT COUNT(*) FROM spot_offers WHERE session_id = ?) AS n`, id, id, id).n;
  if (used) return false;
  return ctx.db.run(`DELETE FROM class_sessions WHERE id = ? AND status = 'scheduled'`, id).changes > 0;
}
const releaseWords = (b) => `${first(b.name)}'s ${b.coverage === 'credit' && b.status === 'booked' ? 'session credit has been returned' : b.coverage === 'paid' && b.status === 'booked' ? 'payment has been refunded' : 'spot has been released'}.`;

// Create the individual sessions for a series up to the scheduling horizon, and book enrolled athletes into new ones.
// At most one session per class day: a day that already has one (moved to another time or day, or canceled) gets no
// second one, so changing a class's time after today's session, or moving one session, never doubles a day.
export function generateSessions(ctx, seriesId) { return withLock(`series:${seriesId}`, () => generateNow(ctx, seriesId)); }
async function generateNow(ctx, seriesId) {
  const s = ctx.db.get('SELECT * FROM class_series WHERE id = ?', seriesId);
  if (!s || !s.active) return 0;
  const zone = tz(ctx);
  const today = localDate(ctx.now(), zone);
  const horizon = addDaysToDate(today, HORIZON_DAYS);
  const days = JSON.parse(s.weekdays);
  const last = s.end_date && s.end_date < horizon ? s.end_date : horizon;
  const taken = new Set(ctx.db.all('SELECT slot_date, starts_at FROM class_sessions WHERE series_id = ? AND (slot_date >= ? OR starts_at >= ?)', s.id, addDaysToDate(today, -1), zonedToUtc(addDaysToDate(today, -8), '00:00', zone))
    .map((x) => slotDay(x, zone)));
  let made = 0;
  for (let d = s.start_date > today ? s.start_date : today; d <= last; d = addDaysToDate(d, 1)) {
    if (!days.includes(weekdayOf(d)) || taken.has(d)) continue;
    const starts = zonedToUtc(d, s.start_time, zone);
    if (starts <= ctx.now()) continue;
    const r = ctx.db.run(`INSERT OR IGNORE INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, age_min, age_max, drop_in_cents, coach_id, slot_date, status, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      newId('cls'), s.id, s.name, s.kind, s.location_id, starts, new Date(Date.parse(starts) + s.duration_min * 60000).toISOString(), s.capacity, s.age_min, s.age_max, s.drop_in_cents, s.coach_id ?? null, d, ctx.now());
    if (r.changes) {
      made++;
      const sessionId = ctx.db.get('SELECT id FROM class_sessions WHERE series_id = ? AND starts_at = ?', s.id, starts).id;
      for (const e of ctx.db.all(`SELECT * FROM enrollments WHERE series_id = ? AND status = 'active'`, s.id)) await bookFromEnrollment(ctx, sessionId, e);
    }
  }
  return made;
}
export async function extendSchedule(ctx) {
  let made = 0;
  for (const s of ctx.db.all('SELECT id FROM class_series WHERE active = 1')) made += await generateSessions(ctx, s.id);
  return made;
}

// ---------- Sessions ----------
// A one-off session (a makeup, a one-time clinic): not part of a class. staff_note is for staff only.
export async function createSession(ctx, body) {
  const kind = v.oneOf(body.kind ?? 'group', 'kind', ['group', 'clinic', 'team', 'evaluation', 'private']);
  const loc = commerce.getLocation(ctx, v.str(body.location_id, 'location_id'));
  if (!isDate(body.date)) throw badRequest('date must look like 2026-10-05.');
  if (!isTime(body.start_time)) throw badRequest('start_time must look like 17:30.');
  const starts = zonedToUtc(body.date, body.start_time, tz(ctx));
  const dur = v.int(body.duration_min ?? 60, 'duration_min', { min: 10, max: 600 });
  const coachId = body.coach_id !== undefined ? coachInput(ctx, body.coach_id) : null;
  const id = newId('cls');
  ctx.db.run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, age_min, age_max, drop_in_cents, coach_id, staff_note, status, created_at)
              VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
    id, v.str(body.name, 'name', { max: 80 }), kind, loc.id, starts, new Date(Date.parse(starts) + dur * 60000).toISOString(),
    v.int(body.capacity ?? (kind === 'private' ? 1 : 12), 'capacity', { min: 1, max: 500 }),
    v.int(body.age_min, 'age_min', { min: 3, max: 99, optional: true }), v.int(body.age_max, 'age_max', { min: 3, max: 99, optional: true }),
    v.int(body.drop_in_cents, 'drop_in_cents', { min: 0, max: 10000000, optional: true }), coachId, v.str(body.staff_note, 'staff_note', { max: 500, optional: true }), ctx.now());
  return getSession(ctx, id);
}
// Change one session: coach_id (a sub for this day; null leaves it with nobody), name, date and start_time, duration_min,
// capacity (never below who is booked; more spots move the waitlist up), location_id and staff_note. Only real changes
// count: nothing changed is refused. A new time or place emails booked families (one email each) unless notify is false.
// A class session moved to another day still stands for its class day, so the schedule job doesn't add that day again.
// Runs under the session's booking lock, so a booking can't slip in between the spots check and the save.
const SESSION_FIELD_WORDS = { name: 'name', starts_at: 'time', ends_at: 'length', capacity: 'spots', location_id: 'place', coach_id: 'coach', staff_note: 'note' };
export function updateSession(ctx, id, body) { return withLock(`book:${id}`, () => updateSessionNow(ctx, id, body)); }
async function updateSessionNow(ctx, id, body) {
  const s = getSession(ctx, id);
  if (s.status !== 'scheduled') throw conflict('This session was canceled. Add a new one instead.');
  const zone = tz(ctx), next = {};
  if (body.name !== undefined) { const n = v.str(body.name, 'name', { max: 80 }); if (n !== s.name) next.name = n; }
  if (body.coach_id !== undefined) { const c = coachInput(ctx, body.coach_id); if (c !== (s.coach_id ?? null)) next.coach_id = c; }
  if (body.location_id !== undefined) { const l = commerce.getLocation(ctx, v.str(body.location_id, 'location_id')).id; if (l !== s.location_id) next.location_id = l; }
  if (body.staff_note !== undefined) { const n = v.str(body.staff_note, 'staff_note', { max: 500, optional: true }); if (n !== (s.staff_note ?? null)) next.staff_note = n; }
  if (body.date !== undefined || body.start_time !== undefined || body.duration_min !== undefined) {
    const date = body.date ?? localDate(s.starts_at, zone), time = body.start_time ?? localTime(s.starts_at, zone);
    if (!isDate(date)) throw badRequest('date must look like 2026-10-05.');
    if (!isTime(time)) throw badRequest('start_time must look like 17:30.');
    const dur = body.duration_min !== undefined ? v.int(body.duration_min, 'duration_min', { min: 10, max: 600 }) : minutesOf(s);
    const starts = zonedToUtc(date, time, zone);
    if (starts !== s.starts_at) {
      if (date < localDate(ctx.now(), zone)) throw badRequest('Pick today or a later date.');
      if (starts <= ctx.now()) throw badRequest('That time has already passed today. Pick a later time.');
      if (s.series_id && ctx.db.get('SELECT 1 FROM class_sessions WHERE series_id = ? AND starts_at = ? AND id != ?', s.series_id, starts, id)) throw conflict('This class already has a session at that time. Move or cancel that one first.');
      next.starts_at = starts;
      if (s.series_id && !s.slot_date) next.slot_date = localDate(s.starts_at, zone);
    }
    if (starts !== s.starts_at || dur !== minutesOf(s)) next.ends_at = new Date(Date.parse(starts) + dur * 60000).toISOString();
  }
  if (body.capacity !== undefined) {
    const c = v.int(body.capacity, 'capacity', { min: 1, max: 500 });
    if (c !== s.capacity) {
      if (c < s.booked_count) throw badRequest(`${plural(s.booked_count, 'athlete')} ${s.booked_count === 1 ? 'is' : 'are'} booked. Set spots to ${s.booked_count} or more, or remove someone first.`);
      next.capacity = c;
    }
  }
  const keys = Object.keys(next);
  if (!keys.length) throw badRequest('Nothing to change.');
  ctx.db.run(`UPDATE class_sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => next[k]), id);
  const promoted = next.capacity > s.capacity ? await promoteNow(ctx, id) : 0;
  const moved = !!(next.starts_at || next.location_id);
  const emailed = moved && body.notify !== false ? notifyMoved(ctx, [{ before: s, after: { ...s, ...next } }]) : 0;
  const changed = [...new Set(keys.filter((k) => k !== 'slot_date' && !(k === 'ends_at' && next.starts_at && minutesOf({ ...s, ...next }) === minutesOf(s))).map((k) => SESSION_FIELD_WORDS[k]))];
  return { ...getSession(ctx, id), changed, families_emailed: emailed, promoted };
}

// Email the families of everyone booked (and the waitlist, if asked), like "Running 10 minutes late" or "Bring your
// cleats". A team session reaches every family on the team roster too. One email per family, signed by who sent it;
// the same message to the same session twice within 10 minutes is refused (a double tap).
export function messageSession(ctx, id, body, actor) { return withLock(`message:${id}`, () => messageNow(ctx, id, body, actor)); }
function messageNow(ctx, id, body, actor) {
  const s = getSession(ctx, id);
  const text = v.str(body.message, 'message', { max: 1000 });
  const fams = bookedFamilies(ctx, [id], { waitlist: !!body.include_waitlist });
  if (s.team) {
    for (const a of s.team.athletes) {
      const c = ctx.db.get('SELECT name, family_id, archived_at FROM clients WHERE id = ?', a.client_id);
      if (!c?.family_id || c.archived_at) continue;
      if (!fams.has(c.family_id)) fams.set(c.family_id, { names: new Set(), sessions: new Set([id]) });
      fams.get(c.family_id).names.add(first(c.name));
    }
  }
  if (!fams.size) throw conflict('Nobody to email yet. Book someone first.');
  const hash = sha256(text.toLowerCase());
  const since = new Date(Date.parse(ctx.now()) - 10 * 60000).toISOString();
  if (ctx.db.all(`SELECT data FROM events WHERE type = 'session.messaged' AND created_at >= ?`, since).some((e) => { const d = JSON.parse(e.data); return d.session_id === id && d.hash === hash; })) {
    throw conflict('That message already went to these families a few minutes ago.');
  }
  const by = actor?.name ?? 'Your coach';
  for (const [fam] of fams) notifyFamily(ctx, fam, `${s.name}, ${when(ctx, s.starts_at)}`, `${text}\n\n${by}, ${getSetting(ctx, 'business_name')}`);
  emit(ctx, 'session.messaged', { session_id: id, session_name: s.name, starts_at: s.starts_at, families: fams.size, by, hash });
  return { sent: fams.size };
}

// Staff booking an athlete who is already booked (or waitlisted) for another session at an overlapping time: allowed,
// but staff hear about it. Returns the other session, or null.
export function clashFor(ctx, clientId, sessionId) {
  const s = ctx.db.get('SELECT starts_at, ends_at FROM class_sessions WHERE id = ?', sessionId);
  if (!s) return null;
  return ctx.db.get(`SELECT x.id, x.name, x.starts_at, l.name AS location_name, b.status FROM bookings b JOIN class_sessions x ON x.id = b.session_id JOIN locations l ON l.id = x.location_id
    WHERE b.client_id = ? AND b.session_id != ? AND b.status IN ('booked','attended','waitlisted') AND x.status = 'scheduled' AND x.starts_at < ? AND x.ends_at > ? ORDER BY x.starts_at LIMIT 1`, clientId, sessionId, s.ends_at, s.starts_at) ?? null;
}

const SESSION_LIST_SQL = `SELECT s.*, l.name AS location_name, cs.registration_cents, cu.name AS coach_name,
    (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','attended')) AS booked_count,
    (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status = 'waitlisted') AS waitlist_count,
    (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status = 'attended') AS attended_count,
    (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','attended') AND b.coverage = 'unpaid') AS unpaid_count
  FROM class_sessions s JOIN locations l ON l.id = s.location_id LEFT JOIN class_series cs ON cs.id = s.series_id LEFT JOIN users cu ON cu.id = s.coach_id`;

export function listSessions(ctx, { from, to, kind, locationId, coachId, includeCanceled = false } = {}) {
  const where = ['s.starts_at >= ?', 's.starts_at < ?'], p = [from, to];
  if (coachId) { where.push('s.coach_id = ?'); p.push(coachId); }
  if (kind) { where.push('s.kind = ?'); p.push(kind); }
  if (locationId) { where.push('s.location_id = ?'); p.push(locationId); }
  if (!includeCanceled) where.push(`s.status = 'scheduled'`);
  return ctx.db.all(`${SESSION_LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY s.starts_at`, ...p).map(shapeSession);
}
const shapeSession = (s) => ({ ...s, spots_left: Math.max(0, s.capacity - s.booked_count), credit_type: creditTypeFor(s.kind) });

export function getSession(ctx, id) {
  const s = ctx.db.get(`${SESSION_LIST_SQL} WHERE s.id = ?`, id);
  if (!s) throw notFound('Session');
  const roster = ctx.db.all(
    `SELECT b.id, b.status, b.coverage, b.credit_type, b.sale_id, b.created_at, c.id AS client_id, c.name, c.athlete_id, c.birth_date, c.medical_notes, c.family_id,
       f.name AS family_name, f.waiver_version, (SELECT phone FROM guardians g WHERE g.family_id = c.family_id ORDER BY is_primary DESC LIMIT 1) AS parent_phone
     FROM bookings b JOIN clients c ON c.id = b.client_id LEFT JOIN families f ON f.id = c.family_id
     WHERE b.session_id = ? ORDER BY CASE b.status WHEN 'waitlisted' THEN 1 WHEN 'canceled' THEN 2 WHEN 'late_canceled' THEN 2 ELSE 0 END, b.created_at`, id);
  // Flags for the roster: the family hasn't signed the current waiver, it's the athlete's birthday on the session's day.
  const waiver = Number(getSetting(ctx, 'waiver_version')), day = localDate(s.starts_at, tz(ctx));
  const out = roster.map(({ waiver_version, ...r }) => ({ ...r, age: ageOn(r.birth_date, s.starts_at), has_medical_notes: !!r.medical_notes,
    no_waiver: !!r.family_id && Number(waiver_version ?? 0) !== waiver, birthday: isBirthday(r.birth_date, day) }));
  return { ...shapeSession(s), roster: out, team: teamRosterFor(ctx, s) };
}
// A birthday on this day (YYYY-MM-DD). Someone born on February 29 celebrates on February 28 in other years.
export function isBirthday(birthDate, day) {
  if (!birthDate) return false;
  const md = birthDate.slice(5), leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return md === day.slice(5) || (md === '02-29' && day.slice(5) === '02-28' && !leap(Number(day.slice(0, 4))));
}

// Cancel a whole session (weather, coach sick). Credits go back, paid drop-ins are refunded, families are emailed.
// notifyTeam (staff canceling one team session): the school or club contact is emailed too, since most players never
// book. Runs under the session's booking lock, so a double tap can't return a credit or refund twice.
export async function cancelSession(ctx, id, opts = {}) {
  const r = await cancelSessionNow(ctx, id, opts);
  return { ...r.session, families_emailed: r.families_emailed, team_contact_emailed: r.team_contact_emailed };
}
function cancelSessionNow(ctx, id, opts) { return withLock(`book:${id}`, () => cancelInner(ctx, id, opts)); }
async function cancelInner(ctx, id, { reason, notify = true, notifyTeam = false } = {}) {
  const s = getSession(ctx, id);
  if (s.status === 'canceled') return { session: s, released: [], families_emailed: 0, team_contact_emailed: false };
  ctx.db.run(`UPDATE class_sessions SET status = 'canceled' WHERE id = ?`, id);
  const released = [], fams = new Set();
  for (const b of s.roster.filter((r) => ['booked', 'waitlisted'].includes(r.status))) {
    await releaseBooking(ctx, b, 'canceled');
    released.push(b);
    if (!notify || !b.family_id) continue;
    fams.add(b.family_id);
    notifyFamily(ctx, b.family_id, `Canceled: ${s.name} on ${when(ctx, s.starts_at)}`, `${s.name} on ${when(ctx, s.starts_at)} is canceled.${reason ? ` ${reason}` : ''} ${releaseWords(b)}`);
    textFamily(ctx, b.family_id, 'canceled', `${s.name} on ${when(ctx, s.starts_at)} is canceled.${reason ? ` ${reason}` : ''} Details are in your email.`);
  }
  let teamEmailed = false;
  if (notifyTeam && s.team) {
    const org = ctx.db.get('SELECT o.contact_email, o.contact_name FROM team_contracts t JOIN organizations o ON o.id = t.org_id WHERE t.id = ?', s.team.contract_id);
    if (org?.contact_email) {
      sendEmail(ctx, { to: org.contact_email, subject: `Canceled: ${s.name} on ${when(ctx, s.starts_at)}`, text: `Hi${org.contact_name ? ` ${first(org.contact_name)}` : ''},\n\n${s.name} for ${s.team.org_name} ${s.team.team_name} on ${when(ctx, s.starts_at)} is canceled.${reason ? ` ${reason}` : ''}\n\n${getSetting(ctx, 'business_name')}` }).catch(() => {});
      teamEmailed = true;
    }
  }
  emit(ctx, 'session.canceled', { session_id: id, name: s.name, starts_at: s.starts_at, reason: reason ?? null });
  return { session: getSession(ctx, id), released, families_emailed: fams.size, team_contact_emailed: teamEmailed };
}
// ---------- Booking ----------
function ageCheck(client, session) {
  const age = ageOn(client.birth_date, session.starts_at);
  if (age == null || (session.age_min == null && session.age_max == null)) return null;
  if ((session.age_min != null && age < session.age_min) || (session.age_max != null && age > session.age_max)) {
    return `${first(client.name)} is ${age}. This session is for ages ${session.age_min ?? 'any'}–${session.age_max ?? 'up'}.`;
  }
  return null;
}

// Decide how a booking is paid for: membership, a credit, a card charge, or (coach only) pay later.
// offerPriceCents: a trial offer's special price (spots.js). A membership that covers the class still covers it; otherwise
// the family pays that price with the card on file instead of using a pack or the drop-in, and 0 books it free.
async function cover(ctx, session, client, { pay, allowUnpaid, actor, offerPriceCents }) {
  const type = creditTypeFor(session.kind);
  if (session.kind === 'team') return { coverage: 'none' };                       // billed through the team contract
  if (type === 'group' && isMember(ctx, client.id)) return { coverage: 'membership' };
  if (offerPriceCents != null) {
    if (offerPriceCents === 0) return { coverage: 'none' };
    const sale = await commerce.createSale(ctx, { location_id: session.location_id, method: 'card_on_file', client_id: client.id, custom: { description: `${session.name} ${localDate(session.starts_at, tz(ctx))} (trial offer)`, amount_cents: offerPriceCents } }, actor);
    if (sale.status !== 'succeeded') throw new HttpError(402, 'payment_failed', `The card was declined: ${sale.failure_reason}`);
    return { coverage: 'paid', sale_id: sale.id };
  }
  if (type && commerce.creditBalance(ctx, client.id, type) > 0 && pay !== 'card_on_file') {
    ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, note, created_at) VALUES (?, ?, ?, -1, 'booking', ?, ?)`, newId('cr'), client.id, type, `${session.name} ${localDate(session.starts_at, tz(ctx))}`, ctx.now());
    return { coverage: 'credit', credit_type: type };
  }
  if (pay === 'card_on_file' && session.drop_in_cents) {
    const sale = await commerce.createSale(ctx, { location_id: session.location_id, method: 'card_on_file', client_id: client.id, custom: { description: `${session.name} ${localDate(session.starts_at, tz(ctx))}`, amount_cents: session.drop_in_cents } }, actor);
    if (sale.status !== 'succeeded') throw new HttpError(402, 'payment_failed', `The card was declined: ${sale.failure_reason}`);
    return { coverage: 'paid', sale_id: sale.id };
  }
  if (allowUnpaid) return { coverage: 'unpaid' };
  const options = [
    type === 'group' ? 'a membership' : null,
    type ? `a ${type} session pack` : null,
    session.drop_in_cents ? `paying ${commerceMoney(session.drop_in_cents)} with the card on file` : null
  ].filter(Boolean);
  throw new HttpError(402, 'payment_required', `${first(client.name)} has no ${type ?? ''} sessions left for this. Book with ${options.join(', or ') || 'help from your coach'}.`.replace('  ', ' '));
}
async function undoCover(ctx, clientId, r) {
  if (r.coverage === 'credit') ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, note, created_at) VALUES (?, ?, ?, 1, 'cancel', 'Booking not made', ?)`, newId('cr'), clientId, r.credit_type, ctx.now());
  if (r.sale_id) await commerce.refundSale(ctx, r.sale_id, {});
}
const commerceMoney = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

// The card refund goes first (if it fails, nothing changes and the booking can be canceled again); then the credit, the
// booking's new status and anything the caller adds (then) are saved in one transaction. Callers hold the session's
// booking lock, so a double tap can't return a credit or refund twice.
async function releaseBooking(ctx, b, status, then) {
  if (b.coverage === 'paid' && b.sale_id && status === 'canceled') {
    const sale = ctx.db.get('SELECT status FROM sales WHERE id = ?', b.sale_id);
    if (['succeeded', 'partially_refunded'].includes(sale?.status)) await commerce.refundSale(ctx, b.sale_id, {});
  }
  ctx.db.tx(() => {
    if (b.coverage === 'credit' && status === 'canceled' && ['booked'].includes(b.status)) {
      ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, note, created_at) VALUES (?, ?, ?, 1, 'cancel', 'Booking canceled', ?)`, newId('cr'), b.client_id, b.credit_type, ctx.now());
    }
    ctx.db.run('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?', status, ctx.now(), b.id);
    then?.();
  });
}

// Bookings for one session go one at a time, so a double tap can't charge twice and two families can't both take the last spot.
// A parent booking also holds the athlete's lock, so two bookings of one athlete into overlapping sessions can't both pass
// the clash check at once.
export function book(ctx, args) {
  const run = () => withLock(`book:${args.sessionId}`, () => bookNow(ctx, args));
  return args.isCoach ? run() : withLock(`athlete-book:${args.clientId}`, run);
}
// Families can't book an athlete into two sessions at the same time (a waitlist spot counts: it could move up). Staff can,
// with a warning (clashFor). Returns the reason, or null.
export function clashText(ctx, clientId, sessionId, name) {
  const x = clashFor(ctx, clientId, sessionId);
  if (!x) return null;
  return `${first(name)} is already ${x.status === 'waitlisted' ? 'on the waitlist for' : 'booked for'} ${x.name} at ${when(ctx, x.starts_at)}, which overlaps. Cancel that first to book this one.`;
}
async function bookNow(ctx, { sessionId, clientId, pay, actor, isCoach = false, overrideAge = false, offerPriceCents }) {
  const s = getSession(ctx, sessionId);
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  notArchived(c, isCoach);
  if (s.status !== 'scheduled') throw conflict('This session was canceled.');
  if (!isCoach && s.starts_at <= ctx.now()) throw conflict('This session has already started.');
  if (!isCoach && s.kind === 'team') throw conflict('Team sessions are booked by your coach.');
  if (s.registration_cents != null && s.drop_in_cents == null && s.series_id) throw conflict('This camp is sold as a whole. Register for the full camp instead.');
  const ageProblem = ageCheck(c, s);
  if (ageProblem && !(isCoach && overrideAge)) throw conflict(ageProblem);
  const existing = ctx.db.get('SELECT * FROM bookings WHERE session_id = ? AND client_id = ?', sessionId, clientId);
  if (existing && ['booked', 'attended', 'waitlisted'].includes(existing.status)) throw conflict(`${first(c.name)} is already ${existing.status === 'waitlisted' ? 'on the waitlist' : 'booked'} for this session.`);
  if (!isCoach) { const clash = clashText(ctx, clientId, sessionId, c.name); if (clash) throw conflict(clash); }

  const full = s.booked_count >= s.capacity;
  // A trial offer is for a spot, not the waitlist: the waitlist later books at the usual price.
  if (full && offerPriceCents != null) throw conflict('Sorry, that spot was just taken. We\'ll let you know next time one opens.');
  let result = { coverage: 'none' }, status = 'waitlisted';
  if (!full) { result = await cover(ctx, s, c, { pay, allowUnpaid: isCoach, actor, offerPriceCents }); status = 'booked'; }
  // Archived while the card was being charged: give the credit or payment back rather than book an archived client.
  if (ctx.db.get('SELECT archived_at FROM clients WHERE id = ?', clientId)?.archived_at) {
    await undoCover(ctx, clientId, result);
    notArchived({ ...c, archived_at: true }, isCoach);
  }
  const id = existing?.id ?? newId('bkg');
  ctx.db.tx(() => {
    if (existing) ctx.db.run('UPDATE bookings SET status = ?, coverage = ?, credit_type = ?, sale_id = ?, booked_by = ?, created_at = ?, updated_at = ? WHERE id = ?', status, result.coverage, result.credit_type ?? null, result.sale_id ?? null, actor ?? null, ctx.now(), ctx.now(), id);
    else ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, credit_type, sale_id, booked_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, sessionId, clientId, status, result.coverage, result.credit_type ?? null, result.sale_id ?? null, actor ?? null, ctx.now(), ctx.now());
    emit(ctx, status === 'waitlisted' ? 'booking.waitlisted' : 'booking.created', { booking_id: id, session_id: sessionId, session_name: s.name, starts_at: s.starts_at, client_id: clientId, client_name: c.name, coverage: result.coverage, ...(offerPriceCents != null && status === 'booked' ? { trial_offer: true, price_cents: offerPriceCents } : {}) });
  });
  notifyFamily(ctx, c.family_id, status === 'waitlisted' ? `Waitlisted: ${s.name}, ${when(ctx, s.starts_at)}` : `Booked: ${s.name}, ${when(ctx, s.starts_at)}`,
    status === 'waitlisted' ? `${first(c.name)} is on the waitlist for ${s.name} at ${s.location_name}, ${when(ctx, s.starts_at)}. We'll email you if a spot opens.`
      : `${first(c.name)} is booked for ${s.name} at ${s.location_name}, ${when(ctx, s.starts_at)}.${result.coverage === 'unpaid' ? ' Payment is due at the session.' : ''}`);
  return bookingDetail(ctx, id);
}

export function bookingDetail(ctx, id) {
  const b = ctx.db.get(`SELECT b.*, s.name AS session_name, s.starts_at, s.ends_at, s.kind, l.name AS location_name, c.name AS client_name
    FROM bookings b JOIN class_sessions s ON s.id = b.session_id JOIN locations l ON l.id = s.location_id JOIN clients c ON c.id = b.client_id WHERE b.id = ?`, id);
  if (!b) throw notFound('Booking');
  return b;
}

// Parents cancelling inside the late window keep the booking charged; coaches can waive it. Runs under the session's
// booking lock: a double tap can't return a credit twice, and the waitlist moves up once.
export async function cancelBooking(ctx, id, opts = {}) {
  const sessionId = bookingDetail(ctx, id).session_id;
  return withLock(`book:${sessionId}`, () => cancelBookingNow(ctx, id, opts));
}
async function cancelBookingNow(ctx, id, { isCoach = false, waive = false } = {}) {
  const b = bookingDetail(ctx, id);
  if (!['booked', 'waitlisted'].includes(b.status)) throw conflict('This booking is already canceled or finished.');
  const hours = Number(getSetting(ctx, 'late_cancel_hours'));
  const late = b.status === 'booked' && Date.parse(b.starts_at) - Date.now() < hours * 3600000 && !(isCoach && waive);
  if (!isCoach && b.starts_at <= ctx.now()) throw conflict('This session has already started. Message your coach.');
  const oneOff = ['private', 'evaluation'].includes(b.kind) && !ctx.db.get('SELECT series_id FROM class_sessions WHERE id = ?', b.session_id).series_id;
  // A private or evaluation booked from open hours exists only for this athlete: take it off the schedule (in the same
  // transaction as the cancel) so the time opens again.
  await releaseBooking(ctx, b, late ? 'late_canceled' : 'canceled', () => {
    if (oneOff && !ctx.db.get(`SELECT 1 FROM bookings WHERE session_id = ? AND status IN ('booked','attended','waitlisted')`, b.session_id)) {
      ctx.db.run(`UPDATE class_sessions SET status = 'canceled' WHERE id = ? AND status = 'scheduled'`, b.session_id);
    }
  });
  emit(ctx, 'booking.canceled', { booking_id: id, session_id: b.session_id, session_name: b.session_name, client_id: b.client_id, client_name: b.client_name, late });
  // The coach hears when a family cancels a private or evaluation (after it's saved).
  if (!isCoach && ['private', 'evaluation'].includes(b.kind)) {
    const coach = ctx.db.get('SELECT u.name, u.email FROM class_sessions s JOIN users u ON u.id = s.coach_id WHERE s.id = ? AND u.active = 1', b.session_id);
    if (coach?.email) sendEmail(ctx, { to: coach.email, subject: `Canceled: ${b.session_name}, ${when(ctx, b.starts_at)}`, text: `Hi ${first(coach.name)},\n\n${b.client_name}'s family canceled ${b.kind === 'private' ? 'the private session' : 'the evaluation'} on ${when(ctx, b.starts_at)} at ${b.location_name}.${late ? ` It was less than ${hours} hours before, so it still counts as used.` : oneOff ? ' The time is open for booking again.' : ''}\n\n${getSetting(ctx, 'business_name')}` }).catch(() => {});
  }
  if (b.status === 'booked') await promoteNow(ctx, b.session_id);
  return { ...bookingDetail(ctx, id), late, message: late ? `Canceled less than ${hours} hours before the session, so the session is still used.` : 'Canceled.' };
}

// Fill open spots from the waitlist in order. Covered automatically when possible; otherwise payment is due at the session.
// Returns how many moved up.
export function promoteWaitlist(ctx, sessionId) { return withLock(`book:${sessionId}`, () => promoteNow(ctx, sessionId)); }
async function promoteNow(ctx, sessionId) {
  let s = getSession(ctx, sessionId), moved = 0;
  while (s.booked_count < s.capacity && s.status === 'scheduled' && s.starts_at > ctx.now()) {
    const next = ctx.db.get(`SELECT b.*, c.name, c.family_id FROM bookings b JOIN clients c ON c.id = b.client_id WHERE b.session_id = ? AND b.status = 'waitlisted' ORDER BY b.created_at LIMIT 1`, sessionId);
    if (!next) break;
    await moveUp(ctx, s, next);
    moved++;
    s = getSession(ctx, sessionId);
  }
  return moved;
}
async function moveUp(ctx, s, next, { staff = false } = {}) {
  const client = ctx.db.get('SELECT * FROM clients WHERE id = ?', next.client_id);
  const r = await cover(ctx, s, client, { allowUnpaid: true });
  ctx.db.run('UPDATE bookings SET status = ?, coverage = ?, credit_type = ?, updated_at = ? WHERE id = ?', 'booked', r.coverage, r.credit_type ?? null, ctx.now(), next.id);
  emit(ctx, 'booking.created', { booking_id: next.id, session_id: s.id, session_name: s.name, starts_at: s.starts_at, client_id: next.client_id, client_name: next.name, coverage: r.coverage, from_waitlist: true, ...(staff ? { over_spots: s.booked_count >= s.capacity } : {}) });
  notifyFamily(ctx, next.family_id, `A spot opened: ${s.name}, ${when(ctx, s.starts_at)}`,
    `Good news: ${first(next.name)} moved off the waitlist and is booked for ${s.name}, ${when(ctx, s.starts_at)}.${r.coverage === 'unpaid' ? ' Payment is due at the session. If you can\'t make it, cancel from the parent portal.' : ''}`);
  textFamily(ctx, next.family_id, 'waitlist', `A spot opened. ${first(next.name)} is now booked for ${s.name}, ${when(ctx, s.starts_at)}. Can't make it? Cancel in the parent portal: ${ctx.publicUrl ?? ''}/parent`);
  return r;
}
// Staff move someone off the waitlist now, even when it puts the session over its spots (the coach decides).
export async function promoteBooking(ctx, id) {
  const sessionId = bookingDetail(ctx, id).session_id;
  return withLock(`book:${sessionId}`, async () => {
    const b = ctx.db.get('SELECT b.*, c.name, c.family_id, c.archived_at FROM bookings b JOIN clients c ON c.id = b.client_id WHERE b.id = ?', id);
    if (b.status !== 'waitlisted') throw conflict(`${first(b.name)} isn't on the waitlist.`);
    if (b.archived_at) throw conflict(`${first(b.name)} is archived. Restore them on their client page first.`);
    const s = getSession(ctx, sessionId);
    if (s.status !== 'scheduled') throw conflict('This session was canceled.');
    const r = await moveUp(ctx, s, b, { staff: true });
    const after = getSession(ctx, sessionId);
    return { ...bookingDetail(ctx, id), over_spots: after.booked_count > after.capacity, message: `${first(b.name)} is booked.${r.coverage === 'unpaid' ? ' Payment is due at the session.' : ''}${after.booked_count > after.capacity ? ` The session is now ${after.booked_count - after.capacity} over its spots.` : ''}` };
  });
}

export function setAttendance(ctx, bookingId, status) {
  const b = bookingDetail(ctx, bookingId);
  v.oneOf(status, 'status', ['attended', 'no_show', 'booked']);
  if (!['booked', 'attended', 'no_show'].includes(b.status)) throw conflict('Only booked athletes can be checked in.');
  ctx.db.run('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?', status, ctx.now(), bookingId);
  if (status === 'attended' && b.status !== 'attended') emit(ctx, 'session.checked_in', { booking_id: bookingId, session_id: b.session_id, client_id: b.client_id, client_name: b.client_name, location_name: b.location_name, covered_by: b.coverage });
  return bookingDetail(ctx, bookingId);
}

// Collect for an unpaid booking right at the session (card on file, cash, or start a Tap to Pay sale).
export async function payBooking(ctx, bookingId, { method, reader_id }, actor) {
  const b = bookingDetail(ctx, bookingId);
  if (b.coverage !== 'unpaid') throw conflict('This booking is already covered.');
  const s = getSession(ctx, b.session_id);
  const reg = s.series_id ? ctx.db.get(`SELECT e.id FROM enrollments e WHERE e.series_id = ? AND e.client_id = ? AND e.kind = 'registration' AND e.status = 'active'`, s.series_id, b.client_id) : null;
  const amount = reg ? s.registration_cents : s.drop_in_cents;
  if (!amount) throw conflict('This session has no price set. Take payment in Point of sale instead.');
  // The booking is marked paid when the sale completes: now for card on file and cash, after the tap for Tap to Pay and readers.
  // Starting over after a tap that was never finished: the old payment is canceled first (if it went through after all,
  // the booking is paid and this one is refused).
  for (const p of ctx.db.all(`SELECT id FROM sales WHERE booking_id = ? AND status = 'pending'`, bookingId)) await commerce.cancelSale(ctx, p.id);
  const sale = await commerce.createSale(ctx, { location_id: s.location_id, method, reader_id, client_id: b.client_id, booking_id: bookingId, custom: { description: `${s.name}${reg ? ' (registration)' : ''}`, amount_cents: amount } }, actor);
  return { sale, booking: bookingDetail(ctx, bookingId) };
}
// ---------- Enrollment (recurring group spots) and camp registration ----------
async function bookFromEnrollment(ctx, sessionId, e) {
  const s = getSession(ctx, sessionId);
  if (ctx.db.get('SELECT id FROM bookings WHERE session_id = ? AND client_id = ?', sessionId, e.client_id)) return;
  const full = s.booked_count >= s.capacity;
  const free = e.kind === 'registration' && ctx.db.get('SELECT registration_cents FROM class_series WHERE id = ?', e.series_id)?.registration_cents === 0;
  const coverage = e.kind === 'registration' ? (e.sale_id || free ? 'registration' : 'unpaid') : isMember(ctx, e.client_id) ? 'membership' : 'unpaid';
  ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, enrollment_id, booked_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'enrollment', ?, ?)`,
    newId('bkg'), sessionId, e.client_id, full && e.kind !== 'registration' ? 'waitlisted' : 'booked', full && e.kind !== 'registration' ? 'none' : coverage, e.id, ctx.now(), ctx.now());
}

// Members get a standing spot in a recurring group class.
export async function enroll(ctx, seriesId, clientId, { isCoach = false } = {}) {
  const s = getSeries(ctx, seriesId);
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  notArchived(c, isCoach);
  if (s.kind !== 'group') throw conflict(s.kind === 'camp' || s.kind === 'clinic' ? 'Register for camps and clinics instead of enrolling.' : 'Only group classes take standing enrollments.');
  if (!isMember(ctx, clientId)) throw conflict(`Standing spots are for members. Book ${first(c.name)} into single classes with group sessions, or start a membership.`);
  if (s.enrolled.some((e) => e.client_id === clientId)) throw conflict(`${first(c.name)} is already enrolled.`);
  const probe = { starts_at: new Date(Date.now() + 86400000).toISOString(), age_min: s.age_min, age_max: s.age_max };
  const ageProblem = ageCheck(c, probe);
  if (ageProblem && !isCoach) throw conflict(ageProblem);
  const id = newId('enr');
  ctx.db.run(`INSERT INTO enrollments (id, series_id, client_id, kind, status, created_at) VALUES (?, ?, ?, 'recurring', 'active', ?)`, id, seriesId, clientId, ctx.now());
  const e = ctx.db.get('SELECT * FROM enrollments WHERE id = ?', id);
  for (const row of ctx.db.all(`SELECT id FROM class_sessions WHERE series_id = ? AND status = 'scheduled' AND starts_at > ? ORDER BY starts_at`, seriesId, ctx.now())) await bookFromEnrollment(ctx, row.id, e);
  emit(ctx, 'enrollment.created', { enrollment_id: id, series_id: seriesId, series_name: s.name, client_id: clientId, client_name: c.name });
  notifyFamily(ctx, c.family_id, `Enrolled: ${s.name}`, `${first(c.name)} has a standing spot in ${s.name} at ${s.location_name}. Cancel any single class from the parent portal if they can't make it.`);
  return getSeries(ctx, seriesId);
}
export async function endEnrollment(ctx, seriesId, clientId) {
  const e = ctx.db.get(`SELECT * FROM enrollments WHERE series_id = ? AND client_id = ? AND status = 'active'`, seriesId, clientId);
  if (!e) throw notFound('Enrollment');
  ctx.db.run(`UPDATE enrollments SET status = 'ended' WHERE id = ?`, e.id);
  const future = ctx.db.all(`SELECT b.* FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.enrollment_id = ? AND b.status IN ('booked','waitlisted') AND s.starts_at > ?`, e.id, ctx.now());
  for (const b of future) { await releaseBooking(ctx, b, 'canceled'); await promoteWaitlist(ctx, b.session_id); }
  return getSeries(ctx, seriesId);
}

// Camps and clinics: one registration books every day. Paid by card on file now, or (coach) collected later.
export async function registerCamp(ctx, seriesId, clientId, { pay, actor, isCoach = false }) {
  const s = getSeries(ctx, seriesId);
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  notArchived(c, isCoach);
  if (!['camp', 'clinic'].includes(s.kind) || s.registration_cents == null) throw conflict('This class doesn\'t take registrations.');
  if (!s.active) throw conflict('Registration for this camp is closed.');
  if (s.enrolled.some((e) => e.client_id === clientId)) throw conflict(`${first(c.name)} is already registered.`);
  const sessions = ctx.db.all(`${SESSION_LIST_SQL} WHERE s.series_id = ? AND s.status = 'scheduled' AND s.starts_at > ? ORDER BY s.starts_at`, seriesId, ctx.now());
  if (!sessions.length) throw conflict('This camp has no upcoming days.');
  if (sessions.some((x) => x.booked_count >= x.capacity)) throw conflict(`${s.name} is full.`);
  const ageProblem = ageCheck(c, sessions[0]);
  if (ageProblem && !isCoach) throw conflict(ageProblem);
  if (!isCoach) for (const x of sessions) { const clash = clashText(ctx, clientId, x.id, c.name); if (clash) throw conflict(clash); }
  let saleId = null;
  if (pay === 'card_on_file' && s.registration_cents > 0) {
    const sale = await commerce.createSale(ctx, { location_id: s.location_id, method: 'card_on_file', client_id: clientId, custom: { description: `${s.name} registration`, amount_cents: s.registration_cents } }, actor);
    if (sale.status !== 'succeeded') throw new HttpError(402, 'payment_failed', `The card was declined: ${sale.failure_reason}`);
    saleId = sale.id;
    if (ctx.db.get('SELECT archived_at FROM clients WHERE id = ?', clientId)?.archived_at) { await undoCover(ctx, clientId, { sale_id: saleId }); notArchived({ ...c, archived_at: true }, isCoach); }
  } else if (s.registration_cents > 0 && !isCoach) {
    throw new HttpError(402, 'payment_required', 'Add a card to your family account to register.');
  }
  const id = newId('enr');
  ctx.db.run(`INSERT INTO enrollments (id, series_id, client_id, kind, sale_id, status, created_at) VALUES (?, ?, ?, 'registration', ?, 'active', ?)`, id, seriesId, clientId, saleId, ctx.now());
  const e = ctx.db.get('SELECT * FROM enrollments WHERE id = ?', id);
  for (const x of sessions) await bookFromEnrollment(ctx, x.id, e);
  emit(ctx, 'enrollment.created', { enrollment_id: id, series_id: seriesId, series_name: s.name, client_id: clientId, client_name: c.name, registration: true, paid: !!saleId });
  notifyFamily(ctx, c.family_id, `Registered: ${s.name}`, `${first(c.name)} is registered for ${s.name} at ${s.location_name}, ${sessions.length} ${sessions.length === 1 ? 'day' : 'days'} starting ${when(ctx, sessions[0].starts_at)}.${saleId ? '' : ' Payment is due at the first session.'}`);
  return getSeries(ctx, seriesId);
}

// ---------- Private and evaluation availability ----------
export function listAvailability(ctx) {
  return ctx.db.all(`SELECT a.*, l.name AS location_name, u.name AS coach_name, u.active AS coach_active, u.role AS coach_role FROM availability a JOIN locations l ON l.id = a.location_id
    LEFT JOIN users u ON u.id = a.coach_id ORDER BY a.kind, a.weekday, a.start_time`).map(({ coach_role, ...a }) => ({ ...a, coach_active: a.coach_id ? !!a.coach_active && coach_role !== 'front_desk' : null }));
}
export function addAvailability(ctx, body) {
  const kind = v.oneOf(body.kind ?? 'private', 'kind', ['private', 'evaluation']);
  const loc = commerce.getLocation(ctx, v.str(body.location_id, 'location_id'));
  if (!isTime(body.start_time) || !isTime(body.end_time) || body.end_time <= body.start_time) throw badRequest('Give a start_time and a later end_time, like 15:00 and 19:00.');
  const coachId = body.coach_id !== undefined ? coachInput(ctx, body.coach_id) : null;
  // One day (weekday) or several at once (weekdays: [1,2,3,4,5] for Monday to Friday).
  const days = body.weekdays !== undefined ? body.weekdays : [body.weekday];
  if (!Array.isArray(days) || !days.length || days.length > 7) throw badRequest('weekdays must list days 0 (Sunday) to 6 (Saturday).');
  const weekdays = [...new Set(days.map((d) => v.int(d, 'weekday', { min: 0, max: 6 })))].sort();
  const slot = v.int(body.slot_minutes ?? 60, 'slot_minutes', { min: 15, max: 240 }), price = v.int(body.price_cents, 'price_cents', { min: 0, max: 10000000, optional: true });
  const ids = ctx.db.tx(() => weekdays.map((wd) => {
    const id = newId('av');
    ctx.db.run('INSERT INTO availability (id, kind, location_id, weekday, start_time, end_time, slot_minutes, price_cents, coach_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, kind, loc.id, wd, body.start_time, body.end_time, slot, price, coachId, ctx.now());
    return id;
  }));
  const all = listAvailability(ctx);
  return { ...all.find((a) => a.id === ids[0]), added: ids.map((id) => all.find((a) => a.id === id)) };
}
// Hand hours to another coach (coach_id), or to nobody (null: the place decides what blocks them).
export function updateAvailability(ctx, id, body) {
  if (!ctx.db.get('SELECT id FROM availability WHERE id = ?', id)) throw notFound('Availability');
  if (body.coach_id === undefined) throw badRequest('Send coach_id (or null to clear it).');
  ctx.db.run('UPDATE availability SET coach_id = ? WHERE id = ?', coachInput(ctx, body.coach_id), id);
  return listAvailability(ctx).find((a) => a.id === id);
}
export function removeAvailability(ctx, id) {
  if (!ctx.db.get('SELECT id FROM availability WHERE id = ?', id)) throw notFound('Availability');
  ctx.db.run('DELETE FROM availability WHERE id = ?', id);
  return { id, deleted: true };
}

// ---------- Time off (a coach, or the whole facility) ----------
export function listTimeOff(ctx, { from, to } = {}) {
  const where = [], p = [];
  for (const [k, x] of [['from', from], ['to', to]]) if (x && !isDate(x)) throw badRequest(`${k} must look like 2026-10-05.`);
  if (from) { where.push('t.end_date >= ?'); p.push(from); }
  if (to) { where.push('t.start_date <= ?'); p.push(to); }
  if (!from && !to) { where.push('t.end_date >= ?'); p.push(localDate(ctx.now(), tz(ctx))); }   // default: today on
  return ctx.db.all(`SELECT t.*, u.name AS coach_name FROM time_off t LEFT JOIN users u ON u.id = t.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.start_date, u.name`, ...p);
}
// Coaches add their own days off; owners add anyone's, or the whole facility's (user_id null). Private and evaluation times
// those days aren't offered. What the coach already leads on those days is listed so someone can cover it.
export function addTimeOff(ctx, body, actor) {
  const role = actor?.role ?? 'owner';
  const userId = body.user_id === undefined ? (role === 'owner' ? null : actor.id) : body.user_id === null || body.user_id === '' ? null : v.str(body.user_id, 'user_id', { max: 64 });
  if (role !== 'owner' && userId !== actor.id) throw new HttpError(403, 'forbidden', 'Coaches can only add their own time off. Ask the owner for anyone else or the whole facility.');
  if (userId) {
    const u = ctx.db.get('SELECT id, role FROM users WHERE id = ?', userId);
    if (!u) throw notFound('Coach');
    if (u.role === 'front_desk') throw badRequest('Time off is for coaches and owners who lead sessions.');
  }
  if (!isDate(body.start_date)) throw badRequest('start_date must look like 2026-10-05.');
  const end = body.end_date == null || body.end_date === '' ? body.start_date : body.end_date;
  if (!isDate(end)) throw badRequest('end_date must look like 2026-10-09.');
  if (end < body.start_date) throw badRequest('end_date must be on or after start_date.');
  if (addDaysToDate(body.start_date, 366) < end) throw badRequest('Time off can be at most a year at a time.');
  const id = newId('off');
  ctx.db.run('INSERT INTO time_off (id, user_id, start_date, end_date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, userId, body.start_date, end, v.str(body.note, 'note', { max: 200, optional: true }), actor?.name ?? 'API', ctx.now());
  const zone = tz(ctx), from = zonedToUtc(body.start_date, '00:00', zone), to = zonedToUtc(addDaysToDate(end, 1), '00:00', zone);
  const toCover = ctx.db.all(`SELECT s.id, s.name, s.starts_at, l.name AS location_name FROM class_sessions s JOIN locations l ON l.id = s.location_id
    WHERE s.status = 'scheduled' AND s.starts_at >= ? AND s.starts_at < ? AND s.starts_at > ? ${userId ? 'AND s.coach_id = ?' : ''} ORDER BY s.starts_at`, from, to, ctx.now(), ...(userId ? [userId] : []));
  return { ...listTimeOff(ctx, { from: body.start_date, to: end }).find((t) => t.id === id), sessions_to_cover: toCover };
}
export function removeTimeOff(ctx, id, actor) {
  const t = ctx.db.get('SELECT * FROM time_off WHERE id = ?', id);
  if (!t) throw notFound('Time off');
  if ((actor?.role ?? 'owner') !== 'owner' && t.user_id !== actor.id) throw new HttpError(403, 'forbidden', 'Only the owner can remove someone else\'s time off.');
  ctx.db.run('DELETE FROM time_off WHERE id = ?', id);
  return { id, deleted: true };
}

// Open slots are your hours minus what is already on the schedule. Hours tied to a coach are taken by anything that coach
// leads (at any place) and by anything at the same place with no coach; hours with no coach are taken by anything at the
// same place. Hours of a coach whose account is turned off aren't offered, nor any on that coach's (or the facility's)
// days off. A one-off private or evaluation whose bookings were all canceled doesn't take the time. One with no bookings
// yet does: that is a slot being booked right now (the booking is saved after the card is charged) or one a coach put on
// the schedule.
export function openSlots(ctx, { kind = 'private', days = 14 } = {}) {
  const zone = tz(ctx);
  const today = localDate(ctx.now(), zone);
  const blocks = ctx.db.all(`SELECT a.*, l.name AS location_name, u.name AS coach_name FROM availability a JOIN locations l ON l.id = a.location_id
    LEFT JOIN users u ON u.id = a.coach_id WHERE a.kind = ? AND (a.coach_id IS NULL OR (u.active = 1 AND u.role IN ('owner','coach')))`, kind);   // a coach moved to front desk no longer leads
  const end = zonedToUtc(addDaysToDate(today, days + 1), '00:00', zone);
  const busy = ctx.db.all(`SELECT s.location_id, s.coach_id, s.starts_at, s.ends_at FROM class_sessions s WHERE s.status = 'scheduled' AND s.ends_at > ? AND s.starts_at < ?
    AND (s.kind NOT IN ('private','evaluation') OR s.series_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id)
      OR EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','attended','waitlisted')))`, ctx.now(), end);
  const off = ctx.db.all('SELECT user_id, start_date, end_date FROM time_off WHERE end_date >= ? AND start_date <= ?', today, addDaysToDate(today, days));
  const isOff = (a, d) => off.some((t) => t.start_date <= d && t.end_date >= d && (t.user_id == null || t.user_id === a.coach_id));
  const takes = (a, b) => (a.coach_id ? b.coach_id === a.coach_id || (b.coach_id == null && b.location_id === a.location_id) : b.location_id === a.location_id);
  const minStart = new Date(Date.now() + 2 * 3600000).toISOString();            // at least 2 hours' notice
  const out = [];
  for (let d = today, i = 0; i <= days; d = addDaysToDate(d, 1), i++) {
    for (const a of blocks.filter((b) => b.weekday === weekdayOf(d))) {
      if (isOff(a, d)) continue;
      const blockEnd = zonedToUtc(d, a.end_time, zone);
      for (let t = zonedToUtc(d, a.start_time, zone); Date.parse(t) + a.slot_minutes * 60000 <= Date.parse(blockEnd); t = new Date(Date.parse(t) + a.slot_minutes * 60000).toISOString()) {
        const tEnd = new Date(Date.parse(t) + a.slot_minutes * 60000).toISOString();
        if (t < minStart || busy.some((b) => takes(a, b) && b.starts_at < tEnd && b.ends_at > t)) continue;
        out.push({ kind, starts_at: t, ends_at: tEnd, location_id: a.location_id, location_name: a.location_name, price_cents: a.price_cents, availability_id: a.id, coach_id: a.coach_id ?? null, coach_name: a.coach_name ?? null });
      }
    }
  }
  return out.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
}
export async function bookSlot(ctx, { kind = 'private', startsAt, availabilityId, clientId, pay, actor, isCoach = false, note }) {
  const noteText = note == null || note === '' ? null : v.str(note, 'note', { max: 500 });
  const slot = openSlots(ctx, { kind, days: 60 }).find((x) => x.starts_at === startsAt && x.availability_id === availabilityId);
  if (!slot) throw conflict('That time was just taken or is no longer available. Pick another.');
  const c = ctx.db.get('SELECT name, archived_at FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  notArchived(c, isCoach);
  // Saved before the card is charged, so a second booking of this time (or of this coach elsewhere) sees it taken.
  const id = newId('cls');
  ctx.db.run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, coach_id, status, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, 'scheduled', ?)`,
    id, `${kind === 'private' ? 'Private' : 'Evaluation'}: ${c.name}`, kind, slot.location_id, slot.starts_at, slot.ends_at, slot.price_cents, slot.coach_id, ctx.now());
  let out;
  try { out = await book(ctx, { sessionId: id, clientId, pay, actor, isCoach }); }
  catch (e) { ctx.db.run('DELETE FROM class_sessions WHERE id = ?', id); throw e; }        // release the slot if payment fails
  // The coach gets the family's note (and hears about the booking) by email.
  const coach = slot.coach_id ? ctx.db.get('SELECT name, email FROM users WHERE id = ? AND active = 1', slot.coach_id) : null;
  if (noteText) ctx.db.run('UPDATE bookings SET note = ? WHERE id = ?', noteText, out.id);
  if (coach?.email && !isCoach) {
    sendEmail(ctx, { to: coach.email, subject: `Booked: ${kind === 'private' ? 'private session' : 'evaluation'} with ${c.name}, ${when(ctx, slot.starts_at)}`,
      text: `Hi ${first(coach.name)},\n\n${c.name} is booked for ${kind === 'private' ? 'a private session' : 'an evaluation'} with you on ${when(ctx, slot.starts_at)} at ${slot.location_name}.${noteText ? `\n\nNote from the family:\n${noteText}` : ''}\n\n${getSetting(ctx, 'business_name')}` }).catch(() => {});
  }
  return bookingDetail(ctx, out.id);
}

// ---------- Coach views ----------
export function agenda(ctx, dateStr) {
  const zone = tz(ctx);
  const day = dateStr && isDate(dateStr) ? dateStr : localDate(ctx.now(), zone);
  const sessions = listSessions(ctx, { from: zonedToUtc(day, '00:00', zone), to: zonedToUtc(addDaysToDate(day, 1), '00:00', zone) }).map((s) => getSession(ctx, s.id));
  return { date: day, timezone: zone, sessions };
}
export function clientBookings(ctx, clientId, { upcoming = true, limit = 50 } = {}) {
  return ctx.db.all(`SELECT b.id, b.status, b.coverage, s.id AS session_id, s.name AS session_name, s.kind, s.starts_at, s.ends_at, l.name AS location_name
    FROM bookings b JOIN class_sessions s ON s.id = b.session_id JOIN locations l ON l.id = s.location_id
    WHERE b.client_id = ? AND ${upcoming ? `s.starts_at > ? AND b.status IN ('booked','waitlisted')` : 's.starts_at <= ?'} ORDER BY s.starts_at ${upcoming ? 'ASC' : 'DESC'} LIMIT ?`, clientId, ctx.now(), limit);
}
