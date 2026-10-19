import { newId, token, sha256, v, notFound, conflict, HttpError } from '../util.js';
import { getSetting } from './families.js';
import { setAttendance, book, cancelBooking } from './schedule.js';
import { clientLock } from './lockout.js';
import { findByAthleteId } from './athlete-ids.js';
import { setTeamAttendance, teamRosterFor } from './teams.js';
import { rateLimit } from './security.js';

// Self check-in. Two ways, both marking a booked athlete "attended" on the roster, exactly like the coach's tap:
// - A check-in tablet at the front desk: a browser opened with a secret link (/kiosk#<key>) that shows the classes
//   starting soon at its location. Athletes tap their name. Names show as first name and last initial.
// - A QR code on the door: it opens /here/<code> on a parent's phone. After signing in to the parent portal, they
//   check in their own athletes who are booked at that location right now.
// Check-in opens 30 minutes before a session starts and closes when it ends. Only booked athletes can check in; an
// athlete whose session isn't paid for is still checked in and asked to see the front desk.
// The front-desk sign-in page (owner's ask: "list every class or session within a 2 hour window; they click the private,
// class or session, log in with their ID and it checks them in"): the tablet lists everything running now or starting in
// the next 2 hours (KIOSK_WINDOW_MIN) and athletes check in by typing their Athlete ID (kioskCheckInById).

const OPENS_MIN = 30, KIOSK_WINDOW_MIN = 120;
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
export function openSessions(ctx, locationId, asOf = ctx.now(), minutes = OPENS_MIN) {
  const opens = new Date(Date.parse(asOf) + minutes * 60000).toISOString();
  return ctx.db.all(`SELECT s.id, s.name, s.kind, s.starts_at, s.ends_at, s.capacity, s.series_id, u.name AS coach_name FROM class_sessions s LEFT JOIN users u ON u.id = s.coach_id
    WHERE s.location_id = ? AND s.status = 'scheduled' AND s.starts_at <= ? AND s.ends_at > ? ORDER BY s.starts_at, s.name`, locationId, opens, asOf);
}
const kioskSessions = (ctx, locationId, asOf) => openSessions(ctx, locationId, asOf, KIOSK_WINDOW_MIN);
const KIND_WORDS = { group: 'Class', clinic: 'Clinic', camp: 'Camp', team: 'Team', private: 'Private', evaluation: 'Evaluation' };
// What the board calls a session: a private or evaluation is named after the athlete ("Private: Ava Lopez"), so the
// board says "Private · Ava L." instead; everything else keeps its own name.
function boardName(ctx, s, booked) {
  if (!['private', 'evaluation'].includes(s.kind)) return s.name;
  const who = booked.find((b) => b.status !== 'waitlisted');
  return who ? `${KIND_WORDS[s.kind]} · ${nameOnBoard(who.name)}` : `${KIND_WORDS[s.kind]} session`;
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
    business_name: getSetting(ctx, 'business_name'), location_name: k.location_name, tablet: k.name, window_minutes: KIOSK_WINDOW_MIN,
    sessions: kioskSessions(ctx, k.location_id, asOf).map((s) => {
      const booked = bookingsIn(ctx, s.id);
      const team = s.kind === 'team' ? teamRosterFor(ctx, s) : null;
      return { id: s.id, name: boardName(ctx, s, booked), kind: s.kind, kind_label: KIND_WORDS[s.kind] ?? 'Session', starts_at: s.starts_at, ends_at: s.ends_at, coach_name: s.coach_name ?? null,
        started: s.starts_at <= asOf, checked_in: team ? team.athletes.filter((a) => a.present).length : booked.filter((b) => b.status === 'attended').length,
        expected: team ? team.athletes.length : booked.length,
        athletes: booked.map((b) => ({ booking_id: b.id, name: nameOnBoard(b.name), checked_in: b.status === 'attended' })) };
    })
  };
}
export function kioskCheckIn(ctx, key, body, asOf = ctx.now()) {
  const k = kioskFor(ctx, key);
  const bookingId = v.str(body.booking_id, 'booking_id');
  const b = ctx.db.get(`SELECT b.id, b.status, b.client_id, s.id AS session_id, s.name AS session_name, c.name FROM bookings b JOIN class_sessions s ON s.id = b.session_id JOIN clients c ON c.id = b.client_id WHERE b.id = ?`, bookingId);
  if (!b || !kioskSessions(ctx, k.location_id, asOf).some((s) => s.id === b.session_id) || !['booked', 'attended'].includes(b.status)) throw conflict('Check-in for that session isn\'t open here. See a coach.');
  // A family locked out over a declined payment checks in at the desk, where it can be paid (lockout.js).
  if (b.status !== 'attended' && clientLock(ctx, b.client_id)) throw new HttpError(402, 'payment_locked', `${b.name.split(' ')[0]}, please check in at the front desk.`);
  return { name: b.name.split(' ')[0], session: b.session_name, ...checkInBooking(ctx, b.id) };
}

// The sign-in page: the athlete picks the session and types their Athlete ID. Booked: checked in. On a team's roster:
// marked present. Not booked for a class, clinic or camp day with a spot left: booked at the desk's terms (their
// membership or a pack session if they have one, else to pay at the front desk; the card on file is never charged from
// the tablet) and checked in. A private or evaluation is only for the athlete booked on it. Wrong IDs are limited per
// tablet (30 in 15 minutes) so the board can't be used to find out who trains here.
export async function kioskCheckInById(ctx, key, body = {}, asOf = ctx.now()) {
  const k = kioskFor(ctx, key);
  const s = kioskSessions(ctx, k.location_id, asOf).find((x) => x.id === v.str(body.session_id, 'session_id', { max: 60 }));
  if (!s) throw conflict('Check-in for that session isn\'t open here. See the front desk.');
  const raw = v.str(body.athlete_id, 'Athlete ID', { max: 30 });
  const found = findByAthleteId(ctx, raw);
  const c = found && ctx.db.get('SELECT id, name, family_id, archived_at, access_token FROM clients WHERE id = ?', found.client_id);
  if (!c || String(c.access_token ?? '').startsWith('gone_')) {   // a deleted family's athlete
    rateLimit(`kiosk-miss:${k.id}`, 30, 15 * 60000);
    throw new HttpError(404, 'not_found', 'We couldn\'t find that Athlete ID. Check it (like AVALOP2026), or see the front desk.');
  }
  const first = c.name.split(' ')[0];
  const desk = (why) => new HttpError(409, 'see_front_desk', `${first}, ${why} Please see the front desk.`);
  if (c.archived_at) throw desk('your profile isn\'t active right now.');
  const base = { name: first, session: boardName(ctx, s, bookingsIn(ctx, s.id)), session_id: s.id };
  if (s.kind === 'team') {
    const team = teamRosterFor(ctx, s);
    const me = team?.athletes.find((a) => a.client_id === c.id);
    if (!me) throw desk('you\'re not on this team\'s roster.');
    if (!me.present) setTeamAttendance(ctx, s, { client_id: c.id }, true);
    return { ...base, already: me.present, pay_at_desk: false, walk_in: false };
  }
  const existing = ctx.db.get('SELECT id, status, coverage FROM bookings WHERE session_id = ? AND client_id = ?', s.id, c.id);
  if (existing?.status === 'waitlisted') throw desk('you\'re on the waitlist for this one.');
  if (existing && ['booked', 'attended', 'no_show'].includes(existing.status)) {   // marked a no-show too early: here after all
    if (existing.status !== 'attended' && clientLock(ctx, c.id)) throw new HttpError(402, 'payment_locked', `${first}, please check in at the front desk.`);
    return { ...base, ...checkInBooking(ctx, existing.id), walk_in: false, ...waiverNote(ctx, c) };
  }
  // Not booked yet.
  if (['private', 'evaluation'].includes(s.kind)) throw desk('this session is booked for someone else.');
  if (clientLock(ctx, c.id)) throw new HttpError(402, 'payment_locked', `${first}, please check in at the front desk.`);
  const left = s.capacity - ctx.db.get(`SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status IN ('booked','attended')`, s.id).n;
  if (left <= 0) throw desk('this session is full.');
  let made;
  try { made = await book(ctx, { sessionId: s.id, clientId: c.id, actor: `Check-in tablet (${k.name})`, isCoach: true }); }
  catch (e) { if (e instanceof HttpError) throw new HttpError(409, 'see_front_desk', `${first}, we couldn't add you to this session (${String(e.message).replace(/\.$/, '')}). Please see the front desk.`); throw e; }
  if (made.status === 'waitlisted') {   // the last spot went to someone else a moment ago
    await cancelBooking(ctx, made.id, { isCoach: true, waive: true });
    throw desk('this session just filled up.');
  }
  return { ...base, ...checkInBooking(ctx, made.id), walk_in: true, coverage: made.coverage, ...waiverNote(ctx, c) };
}
// A family that hasn't signed the current waiver is asked to at the desk (it isn't a block here: staff decide).
function waiverNote(ctx, c) {
  if (!c.family_id) return {};
  const f = ctx.db.get('SELECT waiver_version FROM families WHERE id = ?', c.family_id);
  return Number(f?.waiver_version ?? 0) !== Number(getSetting(ctx, 'waiver_version')) ? { waiver_needed: true } : {};
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
