// Parent portal API (/api/parent/*): family overview, bookings, privates and evaluations, camps,
// standing spots, packs, memberships, card on file, waiver, athletes and parents.
// Every endpoint is scoped to the signed-in parent's family; anything else answers 404.
// (GET /api/parent/athletes/:id/progress lives in the testing area.)
'use strict';
const { get, all, run, insert, update, tx, setting } = require('../db');
const { h, bad, notFound, log, makeAthleteCode, randomToken, sendEmail, payments, addDays, ageOn, money, businessName, appUrl } = require('../lib');
const { requireParent } = require('../auth');
const booking = require('../services/booking');
const billing = require('../services/billing');
const { luhnValid, cardBrand, parseExpiry } = require('../services/parent-card');
const cal = require('../services/parent-calendar');
const { endAt, bookedBetween, clashIn, clashText, whenText } = require('../services/parent-book');

const ATHLETE_FIELDS = ['first_name', 'last_name', 'birthday', 'sex', 'sport', 'position', 'school', 'allergies', 'injuries', 'medical_notes', 'emergency_name', 'emergency_phone'];
const BOOKABLE_TYPES = ['class', 'camp', 'clinic'];
const WINDOW_DAYS = 21;
const NOTE_MAX = 500;

// ---- helpers ----
function family(req) { return get('SELECT * FROM families WHERE id=?', req.parent.family_id); }
function ownAthlete(req, id) {
  const a = get('SELECT * FROM athletes WHERE id=? AND family_id=? AND archived=0', Number(id) || 0, req.parent.family_id);
  if (!a) throw notFound('That athlete');
  return a;
}
function needCard(fam) { if (!fam?.card_last4) throw bad('Add a card on the Family tab first.', { needs_card: true }); }
const cardLabel = (f) => (f?.card_last4 ? `${f.card_brand || 'Card'} ending ${f.card_last4}` : null);
const athleteName = (a) => `${a.first_name} ${a.last_name}`;
const locName = (id) => (id ? get('SELECT name FROM locations WHERE id=?', id)?.name || null : null);
const voidInvoice = (id) => { if (id) run("UPDATE invoices SET status='void', next_retry=NULL WHERE id=? AND status='failed'", id); };
const leftOf = (n) => (n === Infinity ? 'unlimited' : n);
const firstName = (n) => (n ? String(n).split(' ')[0] : null);
const lateHours = () => Number(setting('late_cancel_hours', 12));
// Privates and evaluations belong to one coach: tell them when a family books or cancels one.
function tellCoach(coachId, subject, body) {
  const c = coachId ? get('SELECT name, email FROM staff WHERE id=? AND active=1', coachId) : null;
  if (c?.email) sendEmail(c.email, subject, `Hi ${firstName(c.name)},\n\n${body}`);
}

function membershipOf(a) {
  const m = billing.activeMembership(a.id);
  if (!m) return null;
  return { id: m.id, plan_id: m.plan_id, plan_name: m.plan_name, status: m.status, group_per_month: m.group_per_month, private_per_month: m.private_per_month, next_charge: m.next_charge, price_cents: m.price_cents, started_at: m.started_at };
}
function athleteSummary(a) {
  return {
    id: a.id, code: a.code, first_name: a.first_name, last_name: a.last_name, birthday: a.birthday, age: ageOn(a.birthday), sex: a.sex,
    sport: a.sport, position: a.position, school: a.school, allergies: a.allergies, injuries: a.injuries, medical_notes: a.medical_notes,
    emergency_name: a.emergency_name, emergency_phone: a.emergency_phone, group_credits: a.group_credits, private_credits: a.private_credits,
    workout_token: a.workout_token, has_program: !!a.program_id, team: !!a.team_id,
    membership: membershipOf(a), member_left: leftOf(billing.memberSessionsLeft(a.id, booking.todayLocal())),
  };
}
// Sessions attended (checked in) in the last 30 days and the latest one, for Home.
function attendanceOf(athleteId) {
  const now = booking.nowLocal();
  const since = addDays(now.slice(0, 10), -30) + 'T00:00';
  const r = get(`SELECT COUNT(*) n, MAX(e.starts_at) last FROM bookings b JOIN events e ON e.id=b.event_id
    WHERE b.athlete_id=? AND b.checked_in_at IS NOT NULL AND e.starts_at<=? AND e.starts_at>=?`, athleteId, now, since);
  const last = r.last || get('SELECT MAX(e.starts_at) s FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.checked_in_at IS NOT NULL AND e.starts_at<=?', athleteId, now)?.s || null;
  return { last_30: r.n, last_at: last };
}
// Link the calendar apps use; the portal's own address when the app URL isn't configured.
const origin = (req) => (process.env.DP_APP_URL || process.env.RENDER_EXTERNAL_URL ? appUrl() : `${req.protocol}://${req.get('host')}`);
function feedLinks(req, token) {
  const url = `${origin(req)}/api/calendar/${token}.ics`;
  return { url, webcal: url.replace(/^https?:/, 'webcal:'), google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url.replace(/^https?:/, 'webcal:'))}` };
}

function familyAthletes(req) {
  return all('SELECT * FROM athletes WHERE family_id=? AND archived=0 ORDER BY birthday IS NULL, birthday, id', req.parent.family_id);
}
function ageFits(cls, a, date) {
  const age = ageOn(a.birthday, date);
  if (!cls || age == null) return true;
  return !((cls.min_age && age < cls.min_age) || (cls.max_age && age > cls.max_age));
}
const ageLabel = (c) => (c.min_age && c.max_age ? `Ages ${c.min_age}–${c.max_age}` : c.min_age ? `Ages ${c.min_age}+` : c.max_age ? `Ages ${c.max_age} and under` : null);

function routes(api) {
  api.use('/parent', requireParent);

  // ---- overview ----
  api.get('/parent/me', h(async (req, res) => {
    const f = family(req);
    const current = Number(setting('waiver_version', 1));
    res.json({
      parent: { id: req.parent.id, name: req.parent.name, email: req.parent.email, phone: req.parent.phone },
      family: {
        id: f.id, name: f.name, card_brand: f.card_brand, card_last4: f.card_last4, card_exp: f.card_exp, card_label: cardLabel(f),
        waiver_version: f.waiver_version, waiver_signed_at: f.waiver_signed_at, waiver_signed_by: f.waiver_signed_by,
        waiver_current: f.waiver_version != null && Number(f.waiver_version) >= current,
      },
      parents: all('SELECT id, name, email, phone FROM parents WHERE family_id=? ORDER BY is_self DESC, id', f.id),
      athletes: familyAthletes(req).map((a) => ({ ...athleteSummary(a), attendance: attendanceOf(a.id) })),
      settings: {
        business_name: businessName(), late_cancel_hours: Number(setting('late_cancel_hours', 12)), waiver_version: current,
        waiver_text: setting('waiver_text', ''), payments_mode: payments.mode(),
      },
    });
  }));

  // ---- bookings ----
  api.get('/parent/bookings', h(async (req, res) => {
    const lateH = Number(setting('late_cancel_hours', 12));
    // Sessions that have started but not finished stay listed until they end.
    const rows = all(`SELECT b.id, b.athlete_id, b.status, b.coverage, b.paid_cents, b.checked_in_at, b.note, e.id AS event_id, e.name, e.type, e.starts_at, e.duration_min, e.location_id,
        l.name AS location, l.address, s.name AS coach,
        (SELECT COUNT(*) FROM bookings w WHERE w.event_id=b.event_id AND w.status='waitlist' AND w.id<=b.id) AS waitlist_pos
      FROM bookings b JOIN events e ON e.id=b.event_id JOIN athletes a ON a.id=b.athlete_id LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN staff s ON s.id=e.coach_id
      WHERE a.family_id=? AND a.archived=0 AND b.status IN ('booked','waitlist') AND e.cancelled=0 AND e.starts_at>=? ORDER BY e.starts_at, b.id`, req.parent.family_id, addDays(booking.todayLocal(), -1) + 'T00:00');
    const now = booking.nowLocal();
    const endOf = (r) => { const d = new Date(r.starts_at + ':00Z'); d.setUTCMinutes(d.getUTCMinutes() + (r.duration_min || 60)); return d.toISOString().slice(0, 16); };
    res.json(rows.filter((r) => endOf(r) > now).map((r) => ({
      ...r, coach: r.coach ? r.coach.split(' ')[0] : null, waitlist_pos: r.status === 'waitlist' ? r.waitlist_pos : null,
      started: r.starts_at <= now, checked_in: !!r.checked_in_at, checked_in_at: undefined,
      late: r.status === 'booked' && booking.hoursUntil(r.starts_at) < lateH,
    })));
  }));

  // One session as a calendar file ("Add to calendar").
  api.get('/parent/bookings/:id/ics', h(async (req, res) => {
    const body = cal.oneBooking(Number(req.params.id) || 0, req.parent.family_id, `${origin(req)}/parent`);
    if (!body) throw notFound('That booking');
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="session-${Number(req.params.id)}.ics"`, 'Cache-Control': 'no-store' });
    res.send(body);
  }));

  // ---- calendar feed: a private link phone calendars subscribe to ----
  api.get('/parent/calendar', h(async (req, res) => {
    const { token, created } = cal.tokenFor(req.parent.family_id);
    if (created) log(req, 'Turned on calendar link', family(req).name);
    res.json(feedLinks(req, token));
  }));
  api.post('/parent/calendar/reset', h(async (req, res) => {
    const { token } = cal.tokenFor(req.parent.family_id, { reset: true });
    log(req, 'Reset calendar link', `${family(req).name}: the old link stopped working`);
    res.json(feedLinks(req, token));
  }));
  // Public by design (calendar apps can't sign in): the unguessable token is the key, and it can be reset.
  api.get('/calendar/:file', h(async (req, res) => {
    const token = String(req.params.file || '').replace(/\.ics$/i, '');
    const f = cal.familyByToken(token);
    if (!f) throw notFound('That calendar');
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="sessions.ics"', 'Cache-Control': 'private, max-age=900', 'X-Robots-Tag': 'noindex' });
    res.send(cal.familyFeed(f.id, addDays(booking.todayLocal(), -30) + 'T00:00', `${origin(req)}/parent`));
  }));

  api.post('/parent/bookings', h(async (req, res) => {
    const a = ownAthlete(req, req.body.athlete_id);
    const e = booking.eventWithCounts(Number(req.body.event_id) || 0);
    if (!e || e.cancelled || !BOOKABLE_TYPES.includes(e.type)) throw notFound('That session');
    const cls = e.class_id ? get('SELECT * FROM classes WHERE id=?', e.class_id) : null;
    if (cls?.reg_price_cents && !get(`SELECT 1 FROM bookings b JOIN events x ON x.id=b.event_id WHERE x.class_id=? AND b.athlete_id=? AND b.coverage='registered' AND b.status='booked'`, cls.id, a.id)) {
      throw bad(`${e.name} takes one registration for every day. Register for it first.`, { needs_registration: true, class_id: cls.id });
    }
    // One place at a time: a waitlist spot counts too, since it books itself when a spot opens.
    const clash = clashIn(bookedBetween(a.id, e.starts_at, endAt(e.starts_at, e.duration_min)), e.starts_at, e.duration_min, e.id);
    if (clash) throw bad(`${a.first_name} is already ${clashText(clash)} at that time (${whenText(clash.starts_at)}). Cancel that first, or pick another session.`, { clash_event_id: clash.id });
    const pay = req.body.pay === 'card' ? 'card' : null;
    const full = e.capacity && e.booked >= e.capacity;
    if (!full) {
      const dry = booking.cover(e, a, { dryRun: true });
      if (dry.coverage === 'unpaid') {
        if (!pay) throw bad(`${a.first_name} has no sessions left. Pay the ${money(e.price_cents)} drop-in with the card on file, or buy a pack.`, { needs_payment: true, price_cents: e.price_cents });
        needCard(family(req));
      }
    }
    const b = booking.book(e.id, a.id, { source: 'parent', payWith: pay, requireCovered: true });
    log(req, b.status === 'waitlist' ? 'Joined waitlist' : 'Booked session', `${athleteName(a)}: ${e.name}, ${e.starts_at.replace('T', ' ')}${b.coverage === 'paid' && b.paid_cents ? ` (drop-in ${money(b.paid_cents)})` : ''}`);
    res.json(b);
  }));

  api.delete('/parent/bookings/:id', h(async (req, res) => {
    const b = get(`SELECT b.*, e.name, e.type, e.starts_at, e.coach_id, a.first_name, a.last_name FROM bookings b JOIN athletes a ON a.id=b.athlete_id JOIN events e ON e.id=b.event_id
      WHERE b.id=? AND a.family_id=?`, Number(req.params.id) || 0, req.parent.family_id);
    if (!b) throw notFound('That booking');
    if (b.status === 'booked' && (b.checked_in_at || b.starts_at <= booking.nowLocal())) throw bad('That session has already started, so it can’t be cancelled here. Talk to the front desk.');
    // A private or evaluation is its own session: with nobody left on it, the time opens up again for booking.
    let freed = false;
    const r = tx(() => {
      const out = booking.cancelBooking(b.id, { byParent: true });
      if (['private', 'evaluation'].includes(b.type) && !get("SELECT 1 FROM bookings WHERE event_id=? AND status IN ('booked','waitlist')", b.event_id)) {
        run("UPDATE events SET cancelled=1, cancel_reason='Cancelled by the family' WHERE id=? AND cancelled=0", b.event_id);
        freed = true;
      }
      return out;
    });
    if (freed) {
      tellCoach(b.coach_id, `Cancelled: ${b.first_name} ${b.last_name}, ${whenText(b.starts_at)}`,
        `${b.first_name} ${b.last_name}'s ${b.type} on ${whenText(b.starts_at)} was cancelled by the family.${r.late ? ' It was inside the late-cancel window, so the session still counts as used.' : ''} The time is open again for booking.`);
    }
    log(req, r.late ? 'Late cancel' : 'Cancelled booking', `${b.first_name} ${b.last_name}: ${b.name}, ${b.starts_at.replace('T', ' ')}`);
    res.json({ ok: true, late: r.late, freed });
  }));

  // ---- classes, three weeks ahead ----
  api.get('/parent/classes', h(async (req, res) => {
    const a = ownAthlete(req, req.query.athlete_id);
    const T = booking.todayLocal(), now = booking.nowLocal();
    const until = addDays(T, WINDOW_DAYS);
    const lateH = lateHours();
    const rows = all(`SELECT e.id, e.class_id, e.type, e.name, e.starts_at, e.duration_min, e.capacity, e.price_cents, e.location_id, l.name AS location, l.address,
        s.name AS coach, c.min_age, c.max_age, c.reg_price_cents, c.reg_deadline,
        (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='booked') AS booked,
        (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='waitlist') AS waitlisted,
        m.id AS my_booking_id, m.status AS my_status, m.coverage AS my_coverage, m.paid_cents AS my_paid_cents,
        (SELECT COUNT(*) FROM bookings w WHERE w.event_id=e.id AND w.status='waitlist' AND w.id<=m.id) AS my_waitlist_pos
      FROM events e LEFT JOIN classes c ON c.id=e.class_id LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN staff s ON s.id=e.coach_id
        LEFT JOIN bookings m ON m.id=(SELECT b.id FROM bookings b WHERE b.event_id=e.id AND b.athlete_id=? AND b.status IN ('booked','waitlist') ORDER BY b.id LIMIT 1)
      WHERE e.type IN ('class','camp','clinic') AND e.cancelled=0 AND e.starts_at>=? AND e.starts_at<? ORDER BY e.starts_at, e.name`,
    a.id, now, until);
    const leftByMonth = {};
    const memberLeft = (d) => (leftByMonth[d.slice(0, 7)] ??= billing.memberSessionsLeft(a.id, d));
    const registered = new Set(all(`SELECT DISTINCT e.class_id FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.coverage='registered' AND b.status='booked'`, a.id).map((r) => r.class_id));
    // Camp days left to register for (the whole camp, not just the three weeks shown).
    const campDays = {};
    const daysOf = (classId) => (campDays[classId] ??= get('SELECT COUNT(*) n FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=?', classId, now).n);
    const busy = bookedBetween(a.id, now, until);
    const events = rows.filter((r) => ageFits(r, a, r.starts_at.slice(0, 10))).map((r) => {
      const needsReg = !!(r.reg_price_cents && !registered.has(r.class_id));
      const clash = r.my_status ? null : clashIn(busy, r.starts_at, r.duration_min, r.id);
      return {
        id: r.id, class_id: r.class_id, type: r.type, name: r.name, starts_at: r.starts_at, duration_min: r.duration_min,
        location: r.location, address: r.address, coach: firstName(r.coach), ages: ageLabel(r),
        price_cents: r.price_cents, capacity: r.capacity, booked: r.booked, waitlisted: r.waitlisted,
        spots_left: r.capacity ? Math.max(0, r.capacity - r.booked) : null, full: !!(r.capacity && r.booked >= r.capacity),
        my_booking_id: r.my_booking_id, my_status: r.my_status, my_coverage: r.my_coverage, my_paid_cents: r.my_paid_cents || 0,
        waitlist_pos: r.my_status === 'waitlist' ? r.my_waitlist_pos : null,
        late: booking.hoursUntil(r.starts_at) < lateH,
        clash: clash ? { name: clash.name, starts_at: clash.starts_at, status: clash.status } : null,
        needs_registration: needsReg, reg_price_cents: r.reg_price_cents,
        reg_days: r.reg_price_cents ? daysOf(r.class_id) : null,
        reg_closed: !!(needsReg && r.reg_deadline && r.reg_deadline < T),
        covered: !r.price_cents || memberLeft(r.starts_at.slice(0, 10)) > 0 || a.group_credits > 0,
      };
    });
    const f = family(req);
    res.json({
      athlete: athleteSummary(a), card_label: cardLabel(f), late_cancel_hours: lateH,
      waiver_current: f.waiver_version != null && Number(f.waiver_version) >= Number(setting('waiver_version', 1)),
      events,
    });
  }));

  // ---- privates and evaluations ----
  // Open times from the hours in settings, each with its coach; times the athlete is already booked elsewhere are left out.
  function slotsFor(kind, a) {
    const T = booking.todayLocal();
    const busy = bookedBetween(a.id, booking.nowLocal(), addDays(T, WINDOW_DAYS + 1));
    const coachName = {};
    const nameOf = (id) => (id ? (coachName[id] ??= get('SELECT name FROM staff WHERE id=?', id)?.name || null) : null);
    const seen = new Set();
    const out = [];
    for (const s of booking.openSlots(kind, T, WINDOW_DAYS)) {
      const key = `${s.starts_at}|${s.coach_id || ''}`;
      if (seen.has(key) || clashIn(busy, s.starts_at, s.duration_min)) continue;
      seen.add(key);
      out.push({ starts_at: s.starts_at, duration_min: s.duration_min, location: locName(s.location_id), price_cents: s.price_cents, coach_id: s.coach_id || null, coach: firstName(nameOf(s.coach_id)) });
    }
    return out;
  }

  api.get('/parent/slots', h(async (req, res) => {
    const kind = req.query.kind === 'evaluation' ? 'evaluation' : 'private';
    const a = ownAthlete(req, req.query.athlete_id);
    const slots = slotsFor(kind, a);
    const coaches = [...new Map(slots.filter((s) => s.coach_id).map((s) => [s.coach_id, { id: s.coach_id, name: s.coach }])).values()];
    const lateH = lateHours();
    // What this athlete already has booked of this kind, so it can be seen and cancelled here.
    const booked = all(`SELECT b.id, b.status, b.coverage, b.paid_cents, b.note, e.starts_at, e.duration_min, l.name AS location, l.address, s.name AS coach
      FROM bookings b JOIN events e ON e.id=b.event_id LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN staff s ON s.id=e.coach_id
      WHERE b.athlete_id=? AND e.type=? AND b.status='booked' AND e.cancelled=0 AND e.starts_at>=? ORDER BY e.starts_at`, a.id, kind, booking.nowLocal())
      .map((b) => ({ ...b, coach: firstName(b.coach), late: booking.hoursUntil(b.starts_at) < lateH }));
    const single = kind === 'private' ? get("SELECT id, name, price_cents FROM products WHERE kind='private_pack' AND credits=1 AND archived=0 ORDER BY price_cents LIMIT 1") : null;
    res.json({ kind, athlete: athleteSummary(a), card_label: cardLabel(family(req)), late_cancel_hours: lateH, coaches, booked, single_private: single || null, slots });
  }));

  api.post('/parent/slots', h(async (req, res) => {
    const kind = req.body.kind === 'evaluation' ? 'evaluation' : req.body.kind === 'private' ? 'private' : null;
    if (!kind) throw bad('Choose Private or Evaluation.');
    const a = ownAthlete(req, req.body.athlete_id);
    const starts_at = String(req.body.starts_at || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(starts_at)) throw bad('Pick a time.');
    const coachId = req.body.coach_id == null || req.body.coach_id === '' ? null : Number(req.body.coach_id);
    if (coachId !== null && !(Number.isInteger(coachId) && coachId > 0)) throw bad('Pick a coach from the list.');
    const note = String(req.body.note ?? '').trim().replace(/\r\n/g, '\n');
    if (note.length > NOTE_MAX) throw bad(`Keep the note for the coach under ${NOTE_MAX} characters.`);
    if (kind === 'evaluation') needCard(family(req));
    const slotLen = booking.openSlots(kind, starts_at.slice(0, 10), 1).find((s) => s.starts_at === starts_at && (!coachId || s.coach_id === coachId))?.duration_min || 60;
    const clash = clashIn(bookedBetween(a.id, starts_at, addDays(starts_at.slice(0, 10), 1) + 'T00:00'), starts_at, slotLen);
    if (clash) throw bad(`${a.first_name} is already ${clashText(clash)} at that time. Pick another time.`, { clash_event_id: clash.id });
    const b = booking.bookSlot(kind, starts_at, a.id, { source: 'parent', coachId });
    if (note) update('bookings', b.id, { note });
    const ev = get('SELECT coach_id FROM events WHERE id=?', b.event_id);
    tellCoach(ev?.coach_id, `New ${kind}: ${athleteName(a)}, ${whenText(starts_at)}`,
      `${req.parent.name} booked ${kind === 'private' ? 'a private' : 'an evaluation'} for ${athleteName(a)} on ${whenText(starts_at)}.${note ? `\n\nNote from the family:\n${note}` : ''}`);
    log(req, kind === 'private' ? 'Booked private' : 'Booked evaluation', `${athleteName(a)}: ${starts_at.replace('T', ' ')}${note ? ' (with a note for the coach)' : ''}`);
    res.json({ ...b, note: note || null });
  }));

  // ---- programs: camps, standing spots, packs, plans ----
  api.get('/parent/shop', h(async (req, res) => {
    const a = ownAthlete(req, req.query.athlete_id);
    const T = booking.todayLocal(), now = booking.nowLocal();
    const camps = all(`SELECT c.*, l.name AS location,
        (SELECT MIN(starts_at) FROM events e WHERE e.class_id=c.id AND e.cancelled=0 AND e.starts_at>=?) AS first_at,
        (SELECT MAX(starts_at) FROM events e WHERE e.class_id=c.id AND e.cancelled=0 AND e.starts_at>=?) AS last_at,
        (SELECT COUNT(*) FROM events e WHERE e.class_id=c.id AND e.cancelled=0 AND e.starts_at>=?) AS days
      FROM classes c LEFT JOIN locations l ON l.id=c.location_id
      WHERE c.archived=0 AND c.type IN ('camp','clinic') AND c.reg_price_cents>0 AND (c.end_date IS NULL OR c.end_date>=?) AND (c.reg_deadline IS NULL OR c.reg_deadline>=?)
      ORDER BY COALESCE(c.start_date, ''), c.name`, now, now, now, T, T)
      .map((c) => ({
        id: c.id, name: c.name, type: c.type, weekdays: c.weekdays, start_time: c.start_time, duration_min: c.duration_min, location: c.location,
        start_date: c.first_at?.slice(0, 10) || c.start_date, end_date: c.last_at?.slice(0, 10) || c.end_date, days: c.days, ages: ageLabel(c),
        reg_price_cents: c.reg_price_cents, reg_deadline: c.reg_deadline, eligible: ageFits(c, a, (c.first_at || T).slice(0, 10)),
        registered: !!get(`SELECT 1 FROM bookings b JOIN events e ON e.id=b.event_id WHERE e.class_id=? AND b.athlete_id=? AND b.coverage='registered' AND b.status='booked'`, c.id, a.id),
      }));
    const spots = new Map(all('SELECT id, class_id FROM standing_spots WHERE athlete_id=?', a.id).map((s) => [s.class_id, s.id]));
    const classes = all(`SELECT c.*, l.name AS location FROM classes c LEFT JOIN locations l ON l.id=c.location_id
      WHERE c.archived=0 AND c.type='class' AND (c.end_date IS NULL OR c.end_date>=?) ORDER BY c.name`, T)
      .filter((c) => ageFits(c, a, T) || spots.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, weekdays: c.weekdays, start_time: c.start_time, duration_min: c.duration_min, location: c.location, ages: ageLabel(c), standing_id: spots.get(c.id) || null }));
    const m = membershipOf(a);
    res.json({
      athlete: athleteSummary(a), card_label: cardLabel(family(req)),
      is_member: !!m && ['active', 'trial'].includes(m.status), camps, classes,
      packs: all("SELECT id, name, kind, price_cents, credits FROM products WHERE archived=0 AND kind IN ('group_pack','private_pack') ORDER BY kind, price_cents"),
      plans: all('SELECT id, name, price_cents, trial_days, group_per_month, private_per_month FROM plans WHERE active=1 ORDER BY price_cents'),
      membership: m,
    });
  }));

  api.post('/parent/camps/:classId/register', h(async (req, res) => {
    const a = ownAthlete(req, req.body.athlete_id);
    const c = get("SELECT * FROM classes WHERE id=? AND archived=0 AND type IN ('camp','clinic')", Number(req.params.classId) || 0);
    if (!c) throw notFound('That camp');
    const first = get('SELECT MIN(starts_at) s FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=?', c.id, booking.nowLocal())?.s;
    if (!ageFits(c, a, (first || booking.todayLocal()).slice(0, 10))) throw bad(`${c.name} is for ${(ageLabel(c) || 'other ages').toLowerCase()}.`);
    if (!first) throw bad('There are no days left to register for.');
    needCard(family(req));
    const lastInvoice = get('SELECT MAX(id) m FROM invoices').m || 0;
    let r;
    try { r = booking.registerCamp(c.id, a.id, { method: 'card', source: 'parent' }); }
    catch (e) {
      // A declined registration leaves a failed invoice; void it so the retry job never charges for a camp that wasn't booked.
      for (const inv of all("SELECT id FROM invoices WHERE id>? AND athlete_id=? AND status='failed'", lastInvoice, a.id)) voidInvoice(inv.id);
      throw e;
    }
    log(req, 'Registered for camp', `${athleteName(a)}: ${c.name} (${money(c.reg_price_cents)}, ${r.days} days)`);
    res.json({ ok: true, ...r });
  }));

  api.post('/parent/standing', h(async (req, res) => {
    const a = ownAthlete(req, req.body.athlete_id);
    const c = get("SELECT * FROM classes WHERE id=? AND archived=0 AND type='class'", Number(req.body.class_id) || 0);
    if (!c) throw notFound('That class');
    const m = billing.activeMembership(a.id);
    if (!m || !['active', 'trial'].includes(m.status)) throw bad('Standing spots are for members. Start a membership first.');
    if (!ageFits(c, a, booking.todayLocal())) throw bad(`${c.name} is for ${(ageLabel(c) || 'other ages').toLowerCase()}.`);
    if (get('SELECT 1 FROM standing_spots WHERE athlete_id=? AND class_id=?', a.id, c.id)) throw bad(`${a.first_name} already holds a spot in ${c.name}.`);
    const id = insert('standing_spots', { athlete_id: a.id, class_id: c.id });
    let booked = 0, skipped = 0;
    for (const e of all('SELECT id FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=? ORDER BY starts_at', c.id, booking.nowLocal())) {
      const ev = booking.eventWithCounts(e.id);
      if (get("SELECT 1 FROM bookings WHERE event_id=? AND athlete_id=? AND status IN ('booked','waitlist')", e.id, a.id)) continue;
      if (ev.capacity && ev.booked >= ev.capacity) { skipped++; continue; }
      // A standing spot rides on the membership; it never spends pack credits or books unpaid.
      if (booking.cover(ev, get('SELECT * FROM athletes WHERE id=?', a.id), { dryRun: true }).coverage !== 'member') { skipped++; continue; }
      try { booking.book(e.id, a.id, { source: 'standing', requireCovered: true, quiet: true }); booked++; } catch { skipped++; }
    }
    log(req, 'Held standing spot', `${athleteName(a)}: ${c.name} (${booked} sessions booked)`);
    res.json({ ok: true, id, booked, skipped });
  }));

  api.delete('/parent/standing/:id', h(async (req, res) => {
    const s = get(`SELECT s.*, a.first_name, a.last_name, c.name AS class_name FROM standing_spots s JOIN athletes a ON a.id=s.athlete_id JOIN classes c ON c.id=s.class_id
      WHERE s.id=? AND a.family_id=?`, Number(req.params.id) || 0, req.parent.family_id);
    if (!s) throw notFound('That standing spot');
    const lateH = Number(setting('late_cancel_hours', 12));
    let cancelled = 0, kept = 0;
    tx(() => {
      run('DELETE FROM standing_spots WHERE id=?', s.id);
      const list = all(`SELECT b.id, e.starts_at FROM bookings b JOIN events e ON e.id=b.event_id WHERE e.class_id=? AND b.athlete_id=? AND b.source='standing'
        AND b.status IN ('booked','waitlist') AND e.starts_at>=?`, s.class_id, s.athlete_id, booking.nowLocal());
      for (const b of list) {
        if (booking.hoursUntil(b.starts_at) < lateH) { kept++; continue; } // inside the window: stays booked
        booking.cancelBooking(b.id, { byParent: true }); cancelled++;
      }
    });
    log(req, 'Left standing spot', `${s.first_name} ${s.last_name}: ${s.class_name} (${cancelled} sessions cancelled)`);
    res.json({ ok: true, cancelled, kept });
  }));

  api.post('/parent/packs', h(async (req, res) => {
    const a = ownAthlete(req, req.body.athlete_id);
    const p = get("SELECT * FROM products WHERE id=? AND archived=0 AND kind IN ('group_pack','private_pack')", Number(req.body.product_id) || 0);
    if (!p) throw notFound('That pack');
    const f = family(req);
    needCard(f);
    const r = billing.charge({ family_id: f.id, athlete_id: a.id, amount_cents: p.price_cents, description: `${p.name} for ${a.first_name}`, method: 'card' });
    if (!r.ok) {
      voidInvoice(r.invoice_id); // nothing was delivered, so the retry job must not collect it later
      log(req, 'Pack payment failed', `${athleteName(a)}: ${p.name}`);
      throw bad(`${r.error || 'The card was declined.'} Try another card on the Family tab.`); }
    billing.applyProduct(a.id, p);
    log(req, 'Bought pack', `${athleteName(a)}: ${p.name} (${money(p.price_cents)})`);
    const after = get('SELECT group_credits, private_credits FROM athletes WHERE id=?', a.id);
    res.json({ ok: true, invoice_id: r.invoice_id, ...after });
  }));

  api.post('/parent/membership', h(async (req, res) => {
    const a = ownAthlete(req, req.body.athlete_id);
    const plan = get('SELECT * FROM plans WHERE id=? AND active=1', Number(req.body.plan_id) || 0);
    if (!plan) throw notFound('That plan');
    needCard(family(req));
    const r = billing.startMembership(a.id, plan.id);
    log(req, 'Started membership', `${athleteName(a)}: ${plan.name}${r.trial ? ' (trial)' : ''}${r.ok ? '' : ' (payment failed)'}`);
    if (!r.ok) throw bad(`${r.error || 'The card was declined.'} The membership is on hold until the card works. Update it on the Family tab.`, { membership_id: r.id });
    res.json({ ok: true, id: r.id, trial: !!r.trial, trial_days: r.trial ? plan.trial_days : 0 });
  }));

  // ---- family: card, waiver, athletes, parents ----
  api.put('/parent/card', h(async (req, res) => {
    if (payments.mode() === 'live') throw bad('Cards are added on Stripe’s secure page in live mode.');
    const number = String(req.body.number || '').replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(number) || !luhnValid(number)) throw bad('That card number isn’t valid. Check the digits.');
    const exp = parseExpiry(req.body.exp);
    if (!exp) throw bad('Enter the expiry as MM/YY.');
    if (exp.expired) throw bad('That card has expired.');
    const cvc = String(req.body.cvc || '').trim();
    if (!/^\d{3,4}$/.test(cvc)) throw bad('Enter the 3 or 4 digit security code.');
    const zip = String(req.body.zip || '').trim();
    if (!/^\d{5}(-\d{4})?$/.test(zip)) throw bad('Enter the billing ZIP code.');
    const f = family(req);
    // Only brand, last 4 and expiry are kept. The full number and CVC are never stored.
    const card = { card_brand: cardBrand(number), card_last4: number.slice(-4), card_exp: exp.label };
    update('families', f.id, card);
    log(req, f.card_last4 ? 'Replaced card' : 'Added card', `${card.card_brand} ending ${card.card_last4}`);
    // Past-due membership charges are retried on the new card.
    let retried = 0, paid = 0;
    for (const inv of all("SELECT id FROM invoices WHERE family_id=? AND status='failed' AND kind='membership' AND attempts<4", f.id)) {
      const r = billing.retryFailed({ invoiceId: inv.id }); retried += r.tried; paid += r.paid;
    }
    res.json({ ok: true, ...card, card_label: `${card.card_brand} ending ${card.card_last4}`, retried, paid });
  }));

  api.post('/parent/waiver', h(async (req, res) => {
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 3 || !name.includes(' ')) throw bad('Type your full name to sign.');
    if (!req.body.agree) throw bad('Tick the box to agree to the waiver.');
    const f = family(req);
    const version = Number(setting('waiver_version', 1));
    update('families', f.id, { waiver_version: version, waiver_signed_at: new Date().toISOString(), waiver_signed_by: name });
    log(req, 'Signed waiver', `${f.name}, version ${version}, signed by ${name}`);
    res.json({ ok: true, waiver_version: version });
  }));

  function cleanAthlete(body, { requireName = false } = {}) {
    const out = {};
    for (const k of ATHLETE_FIELDS) {
      if (!(k in body)) continue;
      let v = body[k] == null ? '' : String(body[k]).trim();
      if (v.length > 500) throw bad('Keep each field under 500 characters.');
      if (k === 'birthday' && v) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v + 'T12:00:00')) || v > booking.todayLocal() || v < '1920-01-01') throw bad('Enter a real birthday.');
      }
      if (k === 'sex' && v && !['M', 'F'].includes(v)) throw bad('Choose M or F, or leave it blank.');
      out[k] = v || null;
    }
    if (requireName || 'first_name' in out || 'last_name' in out) {
      if (('first_name' in out || requireName) && !out.first_name) throw bad('Enter a first name.');
      if (('last_name' in out || requireName) && !out.last_name) throw bad('Enter a last name.');
    }
    return out;
  }

  api.put('/parent/athletes/:id', h(async (req, res) => {
    const a = ownAthlete(req, req.params.id);
    const patch = cleanAthlete(req.body || {});
    update('athletes', a.id, patch);
    log(req, 'Updated athlete', `${athleteName({ ...a, ...patch })}: ${Object.keys(patch).join(', ')}`);
    res.json(athleteSummary(get('SELECT * FROM athletes WHERE id=?', a.id)));
  }));

  api.post('/parent/athletes', h(async (req, res) => {
    const d = cleanAthlete(req.body || {}, { requireName: true });
    const f = family(req);
    const id = insert('athletes', { ...d, code: makeAthleteCode(d.first_name, d.last_name), family_id: f.id, workout_token: randomToken(12) });
    const a = get('SELECT * FROM athletes WHERE id=?', id);
    log(req, 'Added athlete', `${athleteName(a)} (${a.code}) to ${f.name}`);
    res.json(athleteSummary(a));
  }));

  api.post('/parent/parents', h(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim() || null;
    if (!name) throw bad('Enter their name.');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter their email address.');
    if (get('SELECT 1 FROM parents WHERE email=?', email)) throw bad('That email already has a parent account. Ask your coach to link it.');
    const f = family(req);
    const id = insert('parents', { family_id: f.id, name, email, phone });
    sendEmail(email, `You've been added to the ${f.name} at ${businessName()}`,
      `Hi ${name.split(' ')[0]},\n\n${req.parent.name} added you to the ${f.name} account. You can book sessions, see progress and manage the family.\n\nSign in at ${appUrl()}/parent with this email. We'll send you a code; there's no password.`);
    log(req, 'Added parent', `${name} (${email}) to ${f.name}`);
    res.json({ id, name, email, phone });
  }));
}

module.exports = { routes };
