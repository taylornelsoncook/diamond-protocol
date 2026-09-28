import { newId, token, sha256, v, notFound, conflict, HttpError } from '../util.js';
import { getSetting } from './families.js';
import { setAttendance } from './schedule.js';
import { clientLock } from './lockout.js';

// Self check-in. Two ways, both marking a booked athlete "attended" on the roster, exactly like the coach's tap:
// - A check-in tablet at the front desk: a browser opened with a secret link (/kiosk#<key>) that shows the classes
//   starting soon at its location. Athletes tap their name. Names show as first name and last initial.
// - A QR code on the door: it opens /here/<code> on a parent's phone. After signing in to the parent portal, they
//   check in their own athletes who are booked at that location right now.
// Check-in opens 30 minutes before a session starts and closes when it ends. Only booked athletes can check in; an
// athlete whose session isn't paid for is still checked in and asked to see the front desk.

const OPENS_MIN = 30;
export const nameOnBoard = (name) => { const [f, ...rest] = String(name).trim().split(/\s+/); return rest.length ? `${f} ${rest.at(-1)[0]}.` : f; };
const newCode = () => token(8).replace(/[-_]/g, '').slice(0, 10).padEnd(10, 'x');

// ---------- Door poster ----------
export function checkinCode(ctx, locationId, { reset = false } = {}) {
  const loc = ctx.db.get('SELECT * FROM locations WHERE id = ?', locationId);
  if (!loc) throw notFound('Location');
  let code = loc.checkin_code;
  if (!code || reset) { code = newCode(); ctx.db.run('UPDATE locations SET checkin_code = ? WHERE id = ?', code, loc.id); }
  return { location_id: loc.id, location_name: loc.name, code, url: `${ctx.publicUrl ?? ''}/here/${code}`, poster_url: `${ctx.publicUrl ?? ''}/poster.html?code=${code}` };
}
function locationByCode(ctx, code) {
  const loc = ctx.db.get('SELECT * FROM locations WHERE checkin_code = ? AND active = 1', String(code ?? ''));
  if (!loc) throw new HttpError(404, 'not_found', 'This check-in code isn\'t in use any more. Ask a coach for the current one.');
  return loc;
}
export function publicPlace(ctx, code) {
  const loc = locationByCode(ctx, code);
  return { business_name: getSetting(ctx, 'business_name'), location_name: loc.name };
}

// Sessions at a location open for check-in now, with who's booked.
export function openSessions(ctx, locationId, asOf = ctx.now()) {
  const opens = new Date(Date.parse(asOf) + OPENS_MIN * 60000).toISOString();
  return ctx.db.all(`SELECT id, name, kind, starts_at, ends_at FROM class_sessions WHERE location_id = ? AND status = 'scheduled' AND starts_at <= ? AND ends_at > ? ORDER BY starts_at, name`, locationId, opens, asOf);
}
export function bookingsIn(ctx, sessionId) {
  return ctx.db.all(`SELECT b.id, b.status, b.coverage, b.client_id, c.name, c.family_id FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE b.session_id = ? AND b.status IN ('booked','attended') ORDER BY c.name`, sessionId);
}
export function checkInBooking(ctx, bookingId) {
  const b = ctx.db.get('SELECT status, coverage FROM bookings WHERE id = ?', bookingId);
  const already = b.status === 'attended';
  if (!already) setAttendance(ctx, bookingId, 'attended');
  return { already, pay_at_desk: b.coverage === 'unpaid' };
}

// ---------- Front-desk tablets ----------
export function listKiosks(ctx) {
  return ctx.db.all(`SELECT k.id, k.name, k.location_id, l.name AS location_name, k.last_seen_at, k.created_by, k.created_at FROM kiosks k JOIN locations l ON l.id = k.location_id WHERE k.revoked_at IS NULL ORDER BY k.created_at`);
}
// The key is shown once, inside the link to open on the tablet.
export function createKiosk(ctx, body, actor) {
  const loc = ctx.db.get('SELECT * FROM locations WHERE id = ?', v.str(body.location_id, 'location_id'));
  if (!loc) throw notFound('Location');
  if (!loc.active) throw conflict(`${loc.name} is archived. Choose another location.`);
  const key = token(24), id = newId('ksk');
  ctx.db.run('INSERT INTO kiosks (id, name, location_id, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, v.str(body.name ?? `${loc.name} front desk`, 'name', { max: 60 }), loc.id, sha256(key), actor ?? null, ctx.now());
  return { ...listKiosks(ctx).find((k) => k.id === id), link: `${ctx.publicUrl ?? ''}/kiosk#${key}`, screen_link: `${ctx.publicUrl ?? ''}/tv#${key}` };
}
export function revokeKiosk(ctx, id) {
  const r = ctx.db.run('UPDATE kiosks SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', ctx.now(), id);
  if (!r.changes) throw notFound('Check-in tablet');
  return { ok: true };
}
export function kioskFor(ctx, key) {
  const k = key && ctx.db.get(`SELECT k.*, l.name AS location_name, l.active FROM kiosks k JOIN locations l ON l.id = k.location_id WHERE k.key_hash = ? AND k.revoked_at IS NULL`, sha256(String(key)));
  if (!k) throw new HttpError(401, 'kiosk_unknown', 'This tablet isn\'t set up for check-in any more. Open a new check-in link from Schedule → Hours & settings.');
  ctx.db.run('UPDATE kiosks SET last_seen_at = ? WHERE id = ?', ctx.now(), k.id);
  return k;
}
export function kioskBoard(ctx, key, asOf = ctx.now()) {
  const k = kioskFor(ctx, key);
  return {
    business_name: getSetting(ctx, 'business_name'), location_name: k.location_name, tablet: k.name,
    sessions: openSessions(ctx, k.location_id, asOf).map((s) => ({ id: s.id, name: s.name, starts_at: s.starts_at, ends_at: s.ends_at,
      athletes: bookingsIn(ctx, s.id).map((b) => ({ booking_id: b.id, name: nameOnBoard(b.name), checked_in: b.status === 'attended' })) }))
  };
}
export function kioskCheckIn(ctx, key, body, asOf = ctx.now()) {
  const k = kioskFor(ctx, key);
  const bookingId = v.str(body.booking_id, 'booking_id');
  const b = ctx.db.get(`SELECT b.id, b.status, b.client_id, s.id AS session_id, s.name AS session_name, c.name FROM bookings b JOIN class_sessions s ON s.id = b.session_id JOIN clients c ON c.id = b.client_id WHERE b.id = ?`, bookingId);
  if (!b || !openSessions(ctx, k.location_id, asOf).some((s) => s.id === b.session_id) || !['booked', 'attended'].includes(b.status)) throw conflict('Check-in for that session isn\'t open here. See a coach.');
  // A family locked out over a declined payment checks in at the desk, where it can be paid (lockout.js).
  if (b.status !== 'attended' && clientLock(ctx, b.client_id)) throw new HttpError(402, 'payment_locked', `${b.name.split(' ')[0]}, please check in at the front desk.`);
  return { name: b.name.split(' ')[0], session: b.session_name, ...checkInBooking(ctx, b.id) };
}

// ---------- Parents, from the door QR code ----------
export function familyCheckIns(ctx, familyId, code, asOf = ctx.now()) {
  const loc = locationByCode(ctx, code);
  const out = [];
  for (const s of openSessions(ctx, loc.id, asOf)) for (const b of bookingsIn(ctx, s.id)) if (b.family_id === familyId) {
    out.push({ booking_id: b.id, athlete: b.name.split(' ')[0], session: s.name, starts_at: s.starts_at, checked_in: b.status === 'attended' });
  }
  return { business_name: getSetting(ctx, 'business_name'), location_name: loc.name, data: out };
}
export function familyCheckIn(ctx, familyId, body, asOf = ctx.now()) {
  const list = familyCheckIns(ctx, familyId, body.code, asOf).data;
  const want = body.booking_id ? list.filter((b) => b.booking_id === body.booking_id) : list.filter((b) => !b.checked_in);
  if (!want.length) throw conflict(body.booking_id ? 'Check-in for that session isn\'t open here.' : 'Nobody in your family is booked here right now.');
  const done = want.map((b) => ({ athlete: b.athlete, session: b.session, ...checkInBooking(ctx, b.booking_id) }));
  return { checked_in: done, pay_at_desk: done.some((d) => d.pay_at_desk) };
}
