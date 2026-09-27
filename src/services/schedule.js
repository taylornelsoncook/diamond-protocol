import { newId, v, notFound, badRequest, conflict, HttpError, zonedToUtc, localDate, weekdayOf, addDaysToDate, ageOn, isTime, isDate, withLock } from '../util.js';
import { emit } from './events.js';
import { getSetting, payerFor } from './families.js';
import { notifyFamily } from './mail.js';
import { textFamily } from './sms.js';
import * as commerce from './commerce.js';
import { teamRosterFor } from './teams.js';

const SERIES_KINDS = ['group', 'camp', 'clinic', 'team', 'evaluation'];
const HORIZON_DAYS = 56;                     // open-ended classes are scheduled 8 weeks ahead, extended daily
const creditTypeFor = (kind) => (kind === 'private' ? 'private' : kind === 'group' ? 'group' : null);
const tz = (ctx) => getSetting(ctx, 'timezone');
const first = (name) => name.split(' ')[0];
const isMember = (ctx, clientId) => !!ctx.db.get(`SELECT id FROM subscriptions WHERE client_id = ? AND status IN ('active','trialing','past_due') LIMIT 1`, clientId);
const when = (ctx, iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz(ctx), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

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
  const id = newId('ser');
  ctx.db.run(`INSERT INTO class_series (id, name, kind, description, location_id, weekdays, start_time, duration_min, capacity, age_min, age_max, drop_in_cents, registration_cents, start_date, end_date, contract_id, active, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    id, s.name, s.kind, s.description, s.location_id, s.weekdays, s.start_time, s.duration_min, s.capacity, s.age_min, s.age_max, s.drop_in_cents, s.registration_cents, s.start_date, s.end_date, contractId, ctx.now());
  await generateSessions(ctx, id);
  return getSeries(ctx, id);
}
export function getSeries(ctx, id) {
  const s = ctx.db.get('SELECT s.*, l.name AS location_name FROM class_series s JOIN locations l ON l.id = s.location_id WHERE s.id = ?', id);
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
  return ctx.db.all(`SELECT s.*, l.name AS location_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.series_id = s.id AND e.status = 'active') AS enrolled_count
    FROM class_series s JOIN locations l ON l.id = s.location_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.kind, s.start_date, s.start_time`, ...p)
    .map((s) => ({ ...s, weekdays: JSON.parse(s.weekdays), active: !!s.active }));
}
// Changes apply to future sessions. Archiving cancels future sessions (credits returned, families emailed).
export async function updateSeries(ctx, id, body) {
  const cur = getSeries(ctx, id);
  const s = seriesInput(body, { ...cur, weekdays: undefined });
  const weekdays = body.weekdays !== undefined ? s.weekdays : JSON.stringify(cur.weekdays);
  ctx.db.run(`UPDATE class_series SET name = ?, description = ?, capacity = ?, age_min = ?, age_max = ?, drop_in_cents = ?, registration_cents = ?, end_date = ?, weekdays = ?, active = ? WHERE id = ?`,
    s.name, s.description, s.capacity, s.age_min, s.age_max, s.drop_in_cents, s.registration_cents, s.end_date, weekdays, body.active !== undefined ? !!body.active : cur.active, id);
  ctx.db.run(`UPDATE class_sessions SET name = ?, capacity = ?, age_min = ?, age_max = ?, drop_in_cents = ? WHERE series_id = ? AND starts_at > ? AND status = 'scheduled'`,
    s.name, s.capacity, s.age_min, s.age_max, s.drop_in_cents, id, ctx.now());
  if (body.active === false || (s.end_date && s.end_date !== cur.end_date)) {
    const cutoff = body.active === false ? ctx.now() : zonedToUtc(addDaysToDate(s.end_date, 1), '00:00', tz(ctx));
    for (const row of ctx.db.all(`SELECT id FROM class_sessions WHERE series_id = ? AND status = 'scheduled' AND starts_at > ?`, id, cutoff)) await cancelSession(ctx, row.id, { reason: 'This class is no longer on the schedule.' });
  }
  if (body.active !== false) await generateSessions(ctx, id);
  return getSeries(ctx, id);
}

// Create the individual sessions for a series up to the scheduling horizon, and book enrolled athletes into new ones.
export async function generateSessions(ctx, seriesId) {
  const s = ctx.db.get('SELECT * FROM class_series WHERE id = ?', seriesId);
  if (!s || !s.active) return 0;
  const zone = tz(ctx);
  const today = localDate(ctx.now(), zone);
  const horizon = addDaysToDate(today, HORIZON_DAYS);
  const days = JSON.parse(s.weekdays);
  const last = s.end_date && s.end_date < horizon ? s.end_date : horizon;
  let made = 0;
  for (let d = s.start_date > today ? s.start_date : today; d <= last; d = addDaysToDate(d, 1)) {
    if (!days.includes(weekdayOf(d))) continue;
    const starts = zonedToUtc(d, s.start_time, zone);
    if (starts <= ctx.now()) continue;
    const r = ctx.db.run(`INSERT OR IGNORE INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, age_min, age_max, drop_in_cents, status, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      newId('cls'), s.id, s.name, s.kind, s.location_id, starts, new Date(Date.parse(starts) + s.duration_min * 60000).toISOString(), s.capacity, s.age_min, s.age_max, s.drop_in_cents, ctx.now());
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
export async function createSession(ctx, body) {
  const kind = v.oneOf(body.kind ?? 'group', 'kind', ['group', 'clinic', 'team', 'evaluation', 'private']);
  const loc = commerce.getLocation(ctx, v.str(body.location_id, 'location_id'));
  if (!isDate(body.date)) throw badRequest('date must look like 2026-10-05.');
  if (!isTime(body.start_time)) throw badRequest('start_time must look like 17:30.');
  const starts = zonedToUtc(body.date, body.start_time, tz(ctx));
  const dur = v.int(body.duration_min ?? 60, 'duration_min', { min: 10, max: 600 });
  const id = newId('cls');
  ctx.db.run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, age_min, age_max, drop_in_cents, status, created_at)
              VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
    id, v.str(body.name, 'name', { max: 80 }), kind, loc.id, starts, new Date(Date.parse(starts) + dur * 60000).toISOString(),
    v.int(body.capacity ?? (kind === 'private' ? 1 : 12), 'capacity', { min: 1, max: 500 }),
    v.int(body.age_min, 'age_min', { min: 3, max: 99, optional: true }), v.int(body.age_max, 'age_max', { min: 3, max: 99, optional: true }),
    v.int(body.drop_in_cents, 'drop_in_cents', { min: 0, max: 10000000, optional: true }), ctx.now());
  return getSession(ctx, id);
}

const SESSION_LIST_SQL = `SELECT s.*, l.name AS location_name, cs.registration_cents,
    (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','attended')) AS booked_count,
    (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status = 'waitlisted') AS waitlist_count,
    (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status = 'attended') AS attended_count,
    (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','attended') AND b.coverage = 'unpaid') AS unpaid_count
  FROM class_sessions s JOIN locations l ON l.id = s.location_id LEFT JOIN class_series cs ON cs.id = s.series_id`;

export function listSessions(ctx, { from, to, kind, locationId, includeCanceled = false } = {}) {
  const where = ['s.starts_at >= ?', 's.starts_at < ?'], p = [from, to];
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
    `SELECT b.id, b.status, b.coverage, b.credit_type, b.sale_id, b.created_at, c.id AS client_id, c.name, c.birth_date, c.medical_notes, c.family_id,
       f.name AS family_name, (SELECT phone FROM guardians g WHERE g.family_id = c.family_id ORDER BY is_primary DESC LIMIT 1) AS parent_phone
     FROM bookings b JOIN clients c ON c.id = b.client_id LEFT JOIN families f ON f.id = c.family_id
     WHERE b.session_id = ? ORDER BY CASE b.status WHEN 'waitlisted' THEN 1 WHEN 'canceled' THEN 2 WHEN 'late_canceled' THEN 2 ELSE 0 END, b.created_at`, id)
    .map((r) => ({ ...r, age: ageOn(r.birth_date, s.starts_at), has_medical_notes: !!r.medical_notes }));
  return { ...shapeSession(s), roster, team: teamRosterFor(ctx, s) };
}

// Cancel a whole session (weather, coach sick). Credits go back, paid drop-ins are refunded, families are emailed.
export async function cancelSession(ctx, id, { reason } = {}) {
  const s = getSession(ctx, id);
  if (s.status === 'canceled') return s;
  ctx.db.run(`UPDATE class_sessions SET status = 'canceled' WHERE id = ?`, id);
  for (const b of s.roster.filter((r) => ['booked', 'waitlisted'].includes(r.status))) {
    await releaseBooking(ctx, b, 'canceled');
    const fam = ctx.db.get('SELECT family_id FROM clients WHERE id = ?', b.client_id).family_id;
    notifyFamily(ctx, fam, `Canceled: ${s.name} on ${when(ctx, s.starts_at)}`,
      `${s.name} on ${when(ctx, s.starts_at)} is canceled.${reason ? ` ${reason}` : ''} ${first(b.name)}'s ${b.coverage === 'credit' ? 'session credit has been returned' : b.coverage === 'paid' ? 'payment has been refunded' : 'spot has been released'}.`);
    textFamily(ctx, fam, 'canceled', `${s.name} on ${when(ctx, s.starts_at)} is canceled.${reason ? ` ${reason}` : ''} Details are in your email.`);
  }
  emit(ctx, 'session.canceled', { session_id: id, name: s.name, starts_at: s.starts_at, reason: reason ?? null });
  return getSession(ctx, id);
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
async function cover(ctx, session, client, { pay, allowUnpaid, actor }) {
  const type = creditTypeFor(session.kind);
  if (session.kind === 'team') return { coverage: 'none' };                       // billed through the team contract
  if (type === 'group' && isMember(ctx, client.id)) return { coverage: 'membership' };
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
const commerceMoney = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

async function releaseBooking(ctx, b, status) {
  if (b.coverage === 'credit' && status === 'canceled' && ['booked'].includes(b.status)) {
    ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, note, created_at) VALUES (?, ?, ?, 1, 'cancel', 'Booking canceled', ?)`, newId('cr'), b.client_id, b.credit_type, ctx.now());
  }
  if (b.coverage === 'paid' && b.sale_id && status === 'canceled') {
    const sale = ctx.db.get('SELECT status FROM sales WHERE id = ?', b.sale_id);
    if (['succeeded', 'partially_refunded'].includes(sale?.status)) await commerce.refundSale(ctx, b.sale_id, {});
  }
  ctx.db.run('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?', status, ctx.now(), b.id);
}

// Bookings for one session go one at a time, so a double tap can't charge twice and two families can't both take the last spot.
export function book(ctx, args) { return withLock(`book:${args.sessionId}`, () => bookNow(ctx, args)); }
async function bookNow(ctx, { sessionId, clientId, pay, actor, isCoach = false, overrideAge = false }) {
  const s = getSession(ctx, sessionId);
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  if (s.status !== 'scheduled') throw conflict('This session was canceled.');
  if (!isCoach && s.starts_at <= ctx.now()) throw conflict('This session has already started.');
  if (!isCoach && s.kind === 'team') throw conflict('Team sessions are booked by your coach.');
  if (s.registration_cents != null && s.drop_in_cents == null && s.series_id) throw conflict('This camp is sold as a whole. Register for the full camp instead.');
  const ageProblem = ageCheck(c, s);
  if (ageProblem && !(isCoach && overrideAge)) throw conflict(ageProblem);
  const existing = ctx.db.get('SELECT * FROM bookings WHERE session_id = ? AND client_id = ?', sessionId, clientId);
  if (existing && ['booked', 'attended', 'waitlisted'].includes(existing.status)) throw conflict(`${first(c.name)} is already ${existing.status === 'waitlisted' ? 'on the waitlist' : 'booked'} for this session.`);

  const full = s.booked_count >= s.capacity;
  let result = { coverage: 'none' }, status = 'waitlisted';
  if (!full) { result = await cover(ctx, s, c, { pay, allowUnpaid: isCoach, actor }); status = 'booked'; }
  const id = existing?.id ?? newId('bkg');
  ctx.db.tx(() => {
    if (existing) ctx.db.run('UPDATE bookings SET status = ?, coverage = ?, credit_type = ?, sale_id = ?, booked_by = ?, created_at = ?, updated_at = ? WHERE id = ?', status, result.coverage, result.credit_type ?? null, result.sale_id ?? null, actor ?? null, ctx.now(), ctx.now(), id);
    else ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, credit_type, sale_id, booked_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, sessionId, clientId, status, result.coverage, result.credit_type ?? null, result.sale_id ?? null, actor ?? null, ctx.now(), ctx.now());
    emit(ctx, status === 'waitlisted' ? 'booking.waitlisted' : 'booking.created', { booking_id: id, session_id: sessionId, session_name: s.name, starts_at: s.starts_at, client_id: clientId, client_name: c.name, coverage: result.coverage });
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

// Parents cancelling inside the late window keep the booking charged; coaches can waive it.
export async function cancelBooking(ctx, id, { isCoach = false, waive = false } = {}) {
  const b = bookingDetail(ctx, id);
  if (!['booked', 'waitlisted'].includes(b.status)) throw conflict('This booking is already canceled or finished.');
  const hours = Number(getSetting(ctx, 'late_cancel_hours'));
  const late = b.status === 'booked' && Date.parse(b.starts_at) - Date.now() < hours * 3600000 && !(isCoach && waive);
  if (!isCoach && b.starts_at <= ctx.now()) throw conflict('This session has already started. Message your coach.');
  await releaseBooking(ctx, b, late ? 'late_canceled' : 'canceled');
  emit(ctx, 'booking.canceled', { booking_id: id, session_id: b.session_id, session_name: b.session_name, client_id: b.client_id, client_name: b.client_name, late });
  if (b.status === 'booked') await promoteWaitlist(ctx, b.session_id);
  return { ...bookingDetail(ctx, id), late, message: late ? `Canceled less than ${hours} hours before the session, so the session is still used.` : 'Canceled.' };
}

// Fill open spots from the waitlist in order. Covered automatically when possible; otherwise payment is due at the session.
export async function promoteWaitlist(ctx, sessionId) {
  let s = getSession(ctx, sessionId);
  while (s.booked_count < s.capacity && s.status === 'scheduled' && s.starts_at > ctx.now()) {
    const next = ctx.db.get(`SELECT b.*, c.name, c.family_id FROM bookings b JOIN clients c ON c.id = b.client_id WHERE b.session_id = ? AND b.status = 'waitlisted' ORDER BY b.created_at LIMIT 1`, sessionId);
    if (!next) break;
    const client = ctx.db.get('SELECT * FROM clients WHERE id = ?', next.client_id);
    const r = await cover(ctx, s, client, { allowUnpaid: true });
    ctx.db.run('UPDATE bookings SET status = ?, coverage = ?, credit_type = ?, updated_at = ? WHERE id = ?', 'booked', r.coverage, r.credit_type ?? null, ctx.now(), next.id);
    emit(ctx, 'booking.created', { booking_id: next.id, session_id: sessionId, session_name: s.name, starts_at: s.starts_at, client_id: next.client_id, client_name: next.name, coverage: r.coverage, from_waitlist: true });
    notifyFamily(ctx, next.family_id, `A spot opened: ${s.name}, ${when(ctx, s.starts_at)}`,
      `Good news: ${first(next.name)} moved off the waitlist and is booked for ${s.name}, ${when(ctx, s.starts_at)}.${r.coverage === 'unpaid' ? ' Payment is due at the session. If you can\'t make it, cancel from the parent portal.' : ''}`);
    textFamily(ctx, next.family_id, 'waitlist', `A spot opened. ${first(next.name)} is now booked for ${s.name}, ${when(ctx, s.starts_at)}. Can't make it? Cancel in the parent portal: ${ctx.publicUrl ?? ''}/parent`);
    s = getSession(ctx, sessionId);
  }
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
  const sale = await commerce.createSale(ctx, { location_id: s.location_id, method, reader_id, client_id: b.client_id, note: `booking:${bookingId}`, custom: { description: `${s.name}${reg ? ' (registration)' : ''}`, amount_cents: amount } }, actor);
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
  if (!['camp', 'clinic'].includes(s.kind) || s.registration_cents == null) throw conflict('This class doesn\'t take registrations.');
  if (!s.active) throw conflict('Registration for this camp is closed.');
  if (s.enrolled.some((e) => e.client_id === clientId)) throw conflict(`${first(c.name)} is already registered.`);
  const sessions = ctx.db.all(`${SESSION_LIST_SQL} WHERE s.series_id = ? AND s.status = 'scheduled' AND s.starts_at > ? ORDER BY s.starts_at`, seriesId, ctx.now());
  if (!sessions.length) throw conflict('This camp has no upcoming days.');
  if (sessions.some((x) => x.booked_count >= x.capacity)) throw conflict(`${s.name} is full.`);
  const ageProblem = ageCheck(c, sessions[0]);
  if (ageProblem && !isCoach) throw conflict(ageProblem);
  let saleId = null;
  if (pay === 'card_on_file' && s.registration_cents > 0) {
    const sale = await commerce.createSale(ctx, { location_id: s.location_id, method: 'card_on_file', client_id: clientId, custom: { description: `${s.name} registration`, amount_cents: s.registration_cents } }, actor);
    if (sale.status !== 'succeeded') throw new HttpError(402, 'payment_failed', `The card was declined: ${sale.failure_reason}`);
    saleId = sale.id;
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
  return ctx.db.all('SELECT a.*, l.name AS location_name FROM availability a JOIN locations l ON l.id = a.location_id ORDER BY a.kind, a.weekday, a.start_time');
}
export function addAvailability(ctx, body) {
  const kind = v.oneOf(body.kind ?? 'private', 'kind', ['private', 'evaluation']);
  const loc = commerce.getLocation(ctx, v.str(body.location_id, 'location_id'));
  if (!isTime(body.start_time) || !isTime(body.end_time) || body.end_time <= body.start_time) throw badRequest('Give a start_time and a later end_time, like 15:00 and 19:00.');
  const id = newId('av');
  ctx.db.run('INSERT INTO availability (id, kind, location_id, weekday, start_time, end_time, slot_minutes, price_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, kind, loc.id, v.int(body.weekday, 'weekday', { min: 0, max: 6 }), body.start_time, body.end_time,
    v.int(body.slot_minutes ?? 60, 'slot_minutes', { min: 15, max: 240 }), v.int(body.price_cents, 'price_cents', { min: 0, max: 10000000, optional: true }), ctx.now());
  return listAvailability(ctx).find((a) => a.id === id);
}
export function removeAvailability(ctx, id) {
  if (!ctx.db.get('SELECT id FROM availability WHERE id = ?', id)) throw notFound('Availability');
  ctx.db.run('DELETE FROM availability WHERE id = ?', id);
  return { id, deleted: true };
}
// Open slots are your availability minus anything already on your schedule (you can't be in two places).
export function openSlots(ctx, { kind = 'private', days = 14 } = {}) {
  const zone = tz(ctx);
  const today = localDate(ctx.now(), zone);
  const blocks = ctx.db.all('SELECT a.*, l.name AS location_name FROM availability a JOIN locations l ON l.id = a.location_id WHERE a.kind = ?', kind);
  const end = zonedToUtc(addDaysToDate(today, days + 1), '00:00', zone);
  const busy = ctx.db.all(`SELECT starts_at, ends_at FROM class_sessions WHERE status = 'scheduled' AND ends_at > ? AND starts_at < ?`, ctx.now(), end);
  const minStart = new Date(Date.now() + 2 * 3600000).toISOString();            // at least 2 hours' notice
  const out = [];
  for (let d = today, i = 0; i <= days; d = addDaysToDate(d, 1), i++) {
    for (const a of blocks.filter((b) => b.weekday === weekdayOf(d))) {
      const blockEnd = zonedToUtc(d, a.end_time, zone);
      for (let t = zonedToUtc(d, a.start_time, zone); Date.parse(t) + a.slot_minutes * 60000 <= Date.parse(blockEnd); t = new Date(Date.parse(t) + a.slot_minutes * 60000).toISOString()) {
        const tEnd = new Date(Date.parse(t) + a.slot_minutes * 60000).toISOString();
        if (t < minStart || busy.some((b) => b.starts_at < tEnd && b.ends_at > t)) continue;
        out.push({ kind, starts_at: t, ends_at: tEnd, location_id: a.location_id, location_name: a.location_name, price_cents: a.price_cents, availability_id: a.id });
      }
    }
  }
  return out.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
}
export async function bookSlot(ctx, { kind = 'private', startsAt, availabilityId, clientId, pay, actor, isCoach = false }) {
  const slot = openSlots(ctx, { kind, days: 60 }).find((x) => x.starts_at === startsAt && x.availability_id === availabilityId);
  if (!slot) throw conflict('That time was just taken or is no longer available. Pick another.');
  const c = ctx.db.get('SELECT name FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  const id = newId('cls');
  ctx.db.run(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, status, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, 1, ?, 'scheduled', ?)`,
    id, `${kind === 'private' ? 'Private' : 'Evaluation'}: ${c.name}`, kind, slot.location_id, slot.starts_at, slot.ends_at, slot.price_cents, ctx.now());
  try { return await book(ctx, { sessionId: id, clientId, pay, actor, isCoach }); }
  catch (e) { ctx.db.run('DELETE FROM class_sessions WHERE id = ?', id); throw e; }        // release the slot if payment fails
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
