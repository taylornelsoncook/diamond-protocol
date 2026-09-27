// Schedule: sessions for the next two weeks, classes and camps, session rosters (check-in, collect, waitlist,
// cancel, team "Everyone's here") and bookable hours for privates and evaluations.
'use strict';
const { get, all, run, insert, update, tx } = require('../db');
const { h, bad, notFound, log, money, addDays, emit, payments, sendEmail, businessName } = require('../lib');
const { requireStaff } = require('../auth');
const booking = require('../services/booking');
const billing = require('../services/billing');
const { eventsBetween, eventById, athleteCard, fullName } = require('../services/floor-util');

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const intOrNull = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const when = (e) => {
  const d = new Date(e.starts_at.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const [hh, mm] = e.starts_at.slice(11, 16).split(':').map(Number);
  return `${d}, ${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
};

function classRow(c) {
  const loc = c.location_id ? get('SELECT name FROM locations WHERE id=?', c.location_id) : null;
  return { ...c, location: loc?.name || null, days: String(c.weekdays).split(',').map((d) => DAY[+d]).join(', ') };
}

function loadBooking(id) {
  const b = get('SELECT * FROM bookings WHERE id=?', id);
  if (!b) throw notFound('That booking');
  const e = get('SELECT * FROM events WHERE id=?', b.event_id);
  const a = get('SELECT * FROM athletes WHERE id=?', b.athlete_id);
  return { b, e, a };
}

function roster(e, role) {
  const on = e.starts_at.slice(0, 10);
  const rows = all("SELECT * FROM bookings WHERE event_id=? AND status IN ('booked','waitlist') ORDER BY id", e.id).map((b) => {
    const a = get('SELECT * FROM athletes WHERE id=?', b.athlete_id);
    return { id: b.id, status: b.status, coverage: b.coverage, paid_cents: b.paid_cents, checked_in_at: b.checked_in_at, source: b.source, note: b.note || null, athlete: athleteCard(a, on) };
  });
  const booked = rows.filter((r) => r.status === 'booked').sort((x, y) => fullName(x.athlete).localeCompare(fullName(y.athlete)));
  const out = { booked, waitlist: rows.filter((r) => r.status === 'waitlist') };
  if (e.team_id) {
    const t = get('SELECT t.id, t.team_name, s.name AS school FROM team_contracts t LEFT JOIN schools s ON s.id=t.school_id WHERE t.id=?', e.team_id);
    const byAthlete = Object.fromEntries(booked.map((r) => [r.athlete.id, r]));
    const players = all('SELECT * FROM athletes WHERE team_id=? AND archived=0 ORDER BY last_name, first_name', e.team_id);
    out.team = {
      id: t?.id, name: t?.team_name, school: t?.school,
      roster: players.map((a) => ({ athlete: athleteCard(a, on), booking: byAthlete[a.id] || null })),
    };
    // Guests booked into a team session who aren't on the team.
    out.guests = booked.filter((r) => !players.some((p) => p.id === r.athlete.id));
  }
  void role;
  return out;
}

// Drop-ins collected at a session are refunded when the booking or session is cancelled; keep the sale in step.
function markSalesRefunded(bookingIds) {
  for (const id of bookingIds) run("UPDATE sales SET status='refunded', refunded_cents=total_cents WHERE booking_id=? AND status IN ('paid','partial_refund')", id);
}

// Families of everyone booked into a session (one email per family), for change notices and messages.
function bookedFamilies(eventId, { waitlist = false } = {}) {
  const seen = new Map();
  for (const b of all(`SELECT athlete_id FROM bookings WHERE event_id=? AND status IN (${waitlist ? "'booked','waitlist'" : "'booked'"}) ORDER BY id`, eventId)) {
    const a = get('SELECT * FROM athletes WHERE id=?', b.athlete_id);
    const to = a.family_id ? billing.billingEmail(a.family_id) : a.email;
    if (!to) continue;
    const key = String(to).toLowerCase();
    if (seen.has(key)) seen.get(key).names.push(a.first_name); else seen.set(key, { to, names: [a.first_name] });
  }
  return [...seen.values()];
}
const names = (list) => (list.length < 3 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

// Tell booked families their sessions moved (new day, time or place): one email per family, however many
// of their sessions changed. `moves` is [{ before, after }]. Returns the number of families emailed.
function notifyMoved(moves) {
  const loc = (id) => (id ? get('SELECT name FROM locations WHERE id=?', id)?.name : null);
  const byFamily = new Map();
  for (const { before, after } of moves) {
    const place = before.location_id !== after.location_id && loc(after.location_id) ? ` at ${loc(after.location_id)}` : '';
    const line = `${after.name} on ${when(before)} has moved to ${when(after)}${place}.`;
    for (const f of bookedFamilies(after.id)) {
      const key = f.to.toLowerCase();
      if (!byFamily.has(key)) byFamily.set(key, { to: f.to, names: new Set(), lines: [], subject: after.name });
      const x = byFamily.get(key);
      f.names.forEach((n) => x.names.add(n));
      x.lines.push(line);
    }
  }
  for (const f of byFamily.values()) {
    const who = [...f.names];
    const body = f.lines.length === 1 ? f.lines[0] : `These sessions have moved:\n${f.lines.map((l) => `- ${l}`).join('\n')}\n`;
    sendEmail(f.to, `New time: ${f.subject}`, `${body} ${names(who)} ${who.length > 1 ? 'are' : 'is'} still booked. If the new time doesn't work, cancel from the parent portal.`);
  }
  return byFamily.size;
}

const isActiveCoach = (id) => !!get("SELECT 1 FROM staff WHERE id=? AND active=1 AND role IN ('owner','coach')", id);

// Validate a class or camp from the form. `existing` is the class being edited (its type and team never change).
function classBody(b, req, existing = null) {
  const name = String(b.name || '').trim();
  if (!name) throw bad('Give the class a name.');
  if (name.length > 80) throw bad('Keep the name to 80 characters or fewer.');
  const type = existing ? existing.type : b.type || 'class';
  if (!['class', 'camp', 'clinic', 'team'].includes(type)) throw bad('Choose class, camp or clinic.');
  const days = [...new Set((Array.isArray(b.weekdays) ? b.weekdays : String(b.weekdays || '').split(',')).filter((d) => d !== '').map(Number))].sort();
  if (!days.length || days.some((d) => !(d >= 0 && d <= 6))) throw bad('Pick at least one day.');
  if (!isTime(b.start_time)) throw bad('Enter a start time like 16:30.');
  const duration = intOrNull(b.duration_min);
  if (!(duration >= 15 && duration <= 600)) throw bad('Length must be between 15 and 600 minutes.');
  const capacity = intOrNull(b.capacity);
  if (!(capacity >= 1 && capacity <= 500)) throw bad('Spots must be between 1 and 500.');
  const minAge = intOrNull(b.min_age), maxAge = intOrNull(b.max_age);
  if (Number.isNaN(minAge) || Number.isNaN(maxAge)) throw bad('Ages must be whole numbers.');
  if (minAge != null && maxAge != null && minAge > maxAge) throw bad('The youngest age is above the oldest.');
  const price = existing && req.staff.role === 'coach' && b.price_cents === undefined ? existing.price_cents : intOrNull(b.price_cents) ?? 0;
  if (!(price >= 0)) throw bad('Enter a drop-in price of $0 or more.');
  const row = { name, type, weekdays: days.join(','), start_time: b.start_time, duration_min: duration, capacity, min_age: minAge, max_age: maxAge, price_cents: price };
  if (type === 'camp' || type === 'clinic') {
    if (!isDate(b.start_date) || !isDate(b.end_date)) throw bad('Camps and clinics need a first and last date.');
    if (b.end_date < b.start_date) throw bad('The last date is before the first date.');
    const reg = existing && req.staff.role === 'coach' && b.reg_price_cents === undefined ? existing.reg_price_cents : intOrNull(b.reg_price_cents);
    if (Number.isNaN(reg) || (reg != null && reg < 0)) throw bad('Enter a registration price of $0 or more.');
    if (b.reg_deadline && !isDate(b.reg_deadline)) throw bad('Enter the last day to register as a date.');
    if (b.reg_deadline && b.reg_deadline > b.end_date) throw bad('The last day to register is after the camp ends.');
    Object.assign(row, { reg_price_cents: reg || null, reg_deadline: b.reg_deadline || null, start_date: b.start_date, end_date: b.end_date });
  } else if (isDate(b.start_date)) row.start_date = b.start_date;
  else if (existing) row.start_date = existing.start_date;
  if (type === 'team') {
    if (existing) row.team_id = existing.team_id;
    else {
      if (!get("SELECT 1 FROM team_contracts WHERE id=? AND status='active'", b.team_id)) throw bad('Choose the team.');
      row.team_id = Number(b.team_id);
    }
  }
  const loc = b.location_id ? get('SELECT id FROM locations WHERE id=? AND archived=0', b.location_id)
    : existing ? { id: existing.location_id } : get('SELECT id FROM locations WHERE archived=0 ORDER BY id LIMIT 1');
  if (b.location_id && !loc) throw bad('Choose a location.');
  row.location_id = loc?.id || null;
  // A blank coach means "no coach set"; leaving the field out keeps the current coach (or you, for a new class).
  if ('coach_id' in b) row.coach_id = b.coach_id ? Number(b.coach_id) : null;
  else row.coach_id = existing ? existing.coach_id : req.staff.role === 'frontdesk' ? null : req.staff.id;
  if (row.coach_id && !isActiveCoach(row.coach_id)) throw bad('Choose a coach.');
  return row;
}

// Validate a one-off session or an edit to one session. Returns only the fields given.
function sessionBody(b, e = null) {
  const out = {};
  if (!e || b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) throw bad('Give the session a name.');
    if (name.length > 80) throw bad('Keep the name to 80 characters or fewer.');
    out.name = name;
  }
  if (!e || b.date !== undefined || b.start_time !== undefined) {
    const date = b.date ?? e?.starts_at.slice(0, 10), time = b.start_time ?? e?.starts_at.slice(11, 16);
    if (!isDate(date)) throw bad('Pick a date.');
    if (!isTime(time)) throw bad('Enter a start time like 16:30.');
    out.starts_at = `${date}T${time}`;
  }
  if (!e || b.duration_min !== undefined) {
    const d = intOrNull(b.duration_min);
    if (!(d >= 15 && d <= 600)) throw bad('Length must be between 15 and 600 minutes.');
    out.duration_min = d;
  }
  if (!e || b.capacity !== undefined) {
    const c = intOrNull(b.capacity);
    if (!(c >= 1 && c <= 500)) throw bad('Spots must be between 1 and 500.');
    out.capacity = c;
  }
  if (b.location_id !== undefined) {
    const loc = b.location_id ? get('SELECT id FROM locations WHERE id=? AND archived=0', b.location_id) : null;
    if (b.location_id && !loc) throw bad('Choose a location.');
    out.location_id = loc?.id || null;
  }
  if (b.coach_id !== undefined) {
    out.coach_id = b.coach_id ? Number(b.coach_id) : null;
    if (out.coach_id && !isActiveCoach(out.coach_id)) throw bad('Choose a coach.');
  }
  if (b.staff_note !== undefined) {
    const note = String(b.staff_note || '').trim();
    if (note.length > 500) throw bad('Keep the note to 500 characters or fewer.');
    out.staff_note = note || null;
  }
  return out;
}

function routes(api) {
  // ---- sessions ----
  api.get('/events', requireStaff(), h(async (req, res) => {
    const T = booking.todayLocal();
    const from = isDate(req.query.from) ? req.query.from : T;
    const to = isDate(req.query.to) ? req.query.to : addDays(from, 13);
    if (to < from) throw bad('The end date is before the start date.');
    if (addDays(from, 92) < to) throw bad('Ask for three months or less at a time.');
    const rows = eventsBetween(from, to, { includeCancelled: req.query.cancelled !== '0' });
    if (req.staff.role !== 'owner') rows.forEach((e) => { delete e.price_cents; }); // the list never needs prices
    res.json(rows);
  }));

  api.get('/events/:id', requireStaff(), h(async (req, res) => {
    const e = eventById(req.params.id);
    if (!e) throw notFound('That session');
    const cls = e.class_id ? classRow(get('SELECT * FROM classes WHERE id=?', e.class_id)) : null;
    if (cls && req.staff.role === 'coach') { delete cls.price_cents; delete cls.reg_price_cents; }
    res.json({ event: e, class: cls, ...roster(e, req.staff.role), payments_mode: payments.mode() });
  }));

  // Add an athlete. A full session puts them on the waitlist.
  api.post('/events/:id/bookings', requireStaff(), h(async (req, res) => {
    const e = get('SELECT * FROM events WHERE id=?', req.params.id);
    if (!e) throw notFound('That session');
    const a = get('SELECT * FROM athletes WHERE id=? AND archived=0', Number(req.body.athlete_id));
    if (!a) throw bad('Choose an athlete to add.');
    // Staff can book over a clash (a parent can't), but they hear about it, like the portal's rule.
    const pb = require('../services/parent-book');
    const clash = pb.clashIn(pb.bookedBetween(a.id, e.starts_at, pb.endAt(e.starts_at, e.duration_min)), e.starts_at, e.duration_min, e.id);
    const b = booking.book(e.id, a.id, { source: 'staff' });
    log(req, b.status === 'waitlist' ? 'Added to waitlist' : 'Booked', `${fullName(a)} · ${e.name} · ${when(e)}`);
    const also = clash ? ` ${a.first_name} is also ${pb.clashText(clash)} at that time (${pb.whenText(clash.starts_at)}).` : '';
    res.json({ ok: true, booking: b, clash: clash ? { event_id: clash.id, name: clash.name, starts_at: clash.starts_at, status: clash.status } : null,
      message: (b.status === 'waitlist' ? `The session is full. ${a.first_name} is on the waitlist.` : `${a.first_name} is booked.`) + also });
  }));

  // Remove a booking: credits go back, drop-ins are refunded, the waitlist moves up.
  api.delete('/bookings/:id', requireStaff(), h(async (req, res) => {
    const { b, e, a } = loadBooking(req.params.id);
    booking.cancelBooking(b.id, { byParent: false });
    if (b.coverage === 'paid' && b.paid_cents > 0) markSalesRefunded([b.id]);
    log(req, b.status === 'waitlist' ? 'Removed from waitlist' : 'Cancelled booking', `${fullName(a)} · ${e.name} · ${when(e)}`);
    res.json({ ok: true });
  }));

  api.post('/bookings/:id/checkin', requireStaff(), h(async (req, res) => {
    const { b, e, a } = loadBooking(req.params.id);
    if (e.cancelled) throw bad('That session was cancelled.');
    if (b.checked_in_at) return res.json({ ok: true, checked_in_at: b.checked_in_at });
    booking.checkIn(b.id, true);
    log(req, 'Checked in', `${fullName(a)} · ${e.name}`);
    res.json({ ok: true, checked_in_at: get('SELECT checked_in_at FROM bookings WHERE id=?', b.id).checked_in_at });
  }));

  api.delete('/bookings/:id/checkin', requireStaff(), h(async (req, res) => {
    const { b, e, a } = loadBooking(req.params.id);
    booking.checkIn(b.id, false);
    log(req, 'Undid check-in', `${fullName(a)} · ${e.name}`);
    res.json({ ok: true });
  }));

  // Collect the drop-in price for an unpaid booking: card on file, cash or Tap to Pay.
  api.post('/bookings/:id/collect', requireStaff(), h(async (req, res) => {
    const { b, e, a } = loadBooking(req.params.id);
    if (b.status !== 'booked') throw bad('Only booked athletes can pay for a session.');
    if (b.coverage !== 'unpaid') throw bad(`${a.first_name} is already covered for this session.`);
    const method = req.body.method;
    if (!['card', 'cash', 'tap'].includes(method)) throw bad('Choose card on file, cash or Tap to Pay.');
    const amount = e.price_cents || 0;
    if (amount <= 0) throw bad('This session has no drop-in price. Nothing to collect.');
    if (method === 'tap') {
      const last4 = String(req.body.card_last4 || '4242');
      if (last4 === '0002') throw bad('Card declined. Try another card or take cash.');
    }
    const result = tx(() => {
      const r = billing.charge({ family_id: a.family_id, athlete_id: a.id, amount_cents: amount, description: `${e.name}, ${require('../lib').whenLocal(e.starts_at)}`, method });
      if (!r.ok) {
        // A declined tap at the session shouldn't retry later on its own.
        if (r.invoice_id) update('invoices', r.invoice_id, { status: 'void', next_retry: null });
        return r;
      }
      update('bookings', b.id, { coverage: 'paid', paid_cents: amount });
      insert('sales', {
        location_id: e.location_id, athlete_id: a.id, family_id: a.family_id,
        items: JSON.stringify([{ name: `Drop-in: ${e.name}`, qty: 1, price_cents: amount, kind: 'session', event_id: e.id }]),
        total_cents: amount, method, status: 'paid', charge_id: r.charge_id, staff_id: req.staff.id, booking_id: b.id,
      });
      return r;
    });
    if (!result.ok) {
      log(req, 'Collect payment declined', `${fullName(a)} · ${money(amount)} · ${e.name}`);
      throw bad(result.error === 'No card on file.' ? `${a.first_name}'s family has no card on file. Take cash or use Tap to Pay.` : `${result.error || 'Card declined.'} Try Tap to Pay or cash.`);
    }
    log(req, 'Collected payment', `${fullName(a)} · ${money(amount)} ${method === 'card' ? 'card on file' : method === 'tap' ? 'Tap to Pay' : 'cash'} · ${e.name}`);
    res.json({ ok: true, message: `${money(amount)} collected. ${a.first_name} is paid.` });
  }));

  // Cancel a whole session (owners and coaches): credits back, drop-ins refunded, families emailed.
  api.post('/events/:id/cancel', requireStaff('owner', 'coach'), h(async (req, res) => {
    const e = get('SELECT * FROM events WHERE id=?', req.params.id);
    if (!e) throw notFound('That session');
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!reason) throw bad('Give a reason. Families see it in the email.');
    const paid = all("SELECT id FROM bookings WHERE event_id=? AND status='booked' AND coverage='paid' AND paid_cents>0", e.id).map((x) => x.id);
    const n = booking.cancelEvent(e.id, reason);
    markSalesRefunded(paid);
    // Team sessions: the school's contact hears about it too, since most players never book.
    let teamNotified = false;
    if (e.team_id) {
      const t = get('SELECT team_name, billing_email, contact_email FROM team_contracts t LEFT JOIN schools s ON s.id=t.school_id WHERE t.id=?', e.team_id);
      const to = t?.billing_email || t?.contact_email;
      if (to) { sendEmail(to, `Cancelled: ${e.name} on ${when(e).split(', ').slice(0, 2).join(', ')}`, `${e.name} for ${t.team_name} on ${when(e)} is cancelled. Reason: ${reason}.`); teamNotified = true; }
    }
    log(req, 'Cancelled session', `${e.name} · ${when(e)} · ${reason} · ${n} famil${n === 1 ? 'y' : 'ies'} notified`);
    res.json({ ok: true, notified: n, team_notified: teamNotified });
  }));

  // Team sessions: check the whole team in at once.
  api.post('/events/:id/everyone-here', requireStaff(), h(async (req, res) => {
    const e = get('SELECT * FROM events WHERE id=?', req.params.id);
    if (!e) throw notFound('That session');
    if (!e.team_id) throw bad('Everyone\'s here is for team sessions.');
    if (e.cancelled) throw bad('That session was cancelled.');
    const now = new Date().toISOString();
    let n = 0;
    tx(() => {
      for (const a of all('SELECT id, code FROM athletes WHERE team_id=? AND archived=0', e.team_id)) {
        const b = get("SELECT * FROM bookings WHERE event_id=? AND athlete_id=? AND status='booked'", e.id, a.id);
        if (b?.checked_in_at) continue;
        const id = b ? b.id : insert('bookings', { event_id: e.id, athlete_id: a.id, status: 'booked', coverage: 'team', source: 'team' });
        update('bookings', id, { checked_in_at: now });
        emit('checkin.created', { booking_id: id, athlete_id: a.id, event_id: e.id });
        n++;
      }
    });
    log(req, 'Checked in team', `${e.name} · ${n} athlete${n === 1 ? '' : 's'}`);
    res.json({ ok: true, checked_in: n });
  }));

  // Team sessions: check in one player (creates their team booking).
  api.post('/events/:id/team-checkin', requireStaff(), h(async (req, res) => {
    const e = get('SELECT * FROM events WHERE id=?', req.params.id);
    if (!e) throw notFound('That session');
    if (e.cancelled) throw bad('That session was cancelled.');
    const a = get('SELECT * FROM athletes WHERE id=? AND archived=0', Number(req.body.athlete_id));
    if (!a || !e.team_id || a.team_id !== e.team_id) throw bad('That athlete isn\'t on this team.');
    let b = get("SELECT * FROM bookings WHERE event_id=? AND athlete_id=? AND status='booked'", e.id, a.id);
    const id = b ? b.id : insert('bookings', { event_id: e.id, athlete_id: a.id, status: 'booked', coverage: 'team', source: 'team' });
    booking.checkIn(id, true);
    log(req, 'Checked in', `${fullName(a)} · ${e.name}`);
    b = get('SELECT * FROM bookings WHERE id=?', id);
    res.json({ ok: true, booking: b });
  }));

  // A one-off session (a makeup, a special clinic): not part of a weekly class.
  api.post('/events', requireStaff('owner', 'coach'), h(async (req, res) => {
    const b = req.body || {};
    const row = sessionBody(b);
    const type = b.type || 'class';
    if (!['class', 'clinic', 'camp'].includes(type)) throw bad('Choose group class, clinic or camp.');
    if (row.starts_at.slice(0, 10) < booking.todayLocal()) throw bad('Pick today or a later date.');
    const price = intOrNull(b.price_cents) ?? 0;
    if (!(price >= 0)) throw bad('Enter a drop-in price of $0 or more.');
    if (!('location_id' in row)) row.location_id = get('SELECT id FROM locations WHERE archived=0 ORDER BY id LIMIT 1')?.id || null;
    if (!('coach_id' in row)) row.coach_id = req.staff.id;
    const id = insert('events', { ...row, type, price_cents: price });
    const e = get('SELECT * FROM events WHERE id=?', id);
    log(req, 'Added session', `${e.name} · ${when(e)} · one time`);
    res.json({ ok: true, id });
  }));

  // Change one session: day and time, length, spots, place, coach (a sub), or the staff note.
  api.put('/events/:id', requireStaff('owner', 'coach'), h(async (req, res) => {
    const e = get('SELECT * FROM events WHERE id=?', req.params.id);
    if (!e) throw notFound('That session');
    if (e.cancelled) throw bad('That session was cancelled. Add a new one instead.');
    const b = req.body || {};
    const next = sessionBody(b, e);
    for (const k of Object.keys(next)) if (next[k] === e[k]) delete next[k]; // the form sends every field; keep only real changes
    if (next.starts_at) {
      if (next.starts_at.slice(0, 10) < booking.todayLocal()) throw bad('Pick today or a later date.');
      if (e.class_id && get('SELECT 1 FROM events WHERE class_id=? AND starts_at=? AND id<>?', e.class_id, next.starts_at, e.id)) throw bad('This class already has a session at that time.');
      // A class session moved to another day still stands for its original day, so the weekly job doesn't add it again.
      if (e.class_id && !e.slot_date && next.starts_at.slice(0, 10) !== e.starts_at.slice(0, 10)) next.slot_date = e.starts_at.slice(0, 10);
    }
    const booked = get("SELECT COUNT(*) n FROM bookings WHERE event_id=? AND status='booked'", e.id).n;
    if (next.capacity != null && next.capacity < booked) throw bad(`${booked} athletes are booked. Set spots to ${booked} or more, or remove someone first.`);
    if (!Object.keys(next).length) throw bad('Nothing to change.');
    let notified = 0, promoted = 0;
    const after = { ...e, ...next };
    tx(() => {
      update('events', e.id, next);
      while (booking.promoteWaitlist(e.id)) promoted++;
      const movedIt = after.starts_at !== e.starts_at || after.location_id !== e.location_id;
      if (movedIt && b.notify !== false) notified = notifyMoved([{ before: e, after }]);
    });
    const changed = Object.keys(next).map((k) => ({ starts_at: 'time', duration_min: 'length', capacity: 'spots', location_id: 'place', coach_id: 'coach', staff_note: 'note', name: 'name' })[k]).filter(Boolean);
    log(req, 'Edited session', `${after.name} · ${when(after)} · ${changed.join(', ')}${notified ? ` · ${notified} famil${notified === 1 ? 'y' : 'ies'} emailed` : ''}`);
    res.json({ ok: true, notified, promoted });
  }));

  // Email everyone booked (and, if asked, the waitlist): "Running 10 minutes late", "Bring your cleats".
  api.post('/events/:id/message', requireStaff(), h(async (req, res) => {
    const e = get('SELECT * FROM events WHERE id=?', req.params.id);
    if (!e) throw notFound('That session');
    const text = String(req.body?.message || '').trim();
    if (!text) throw bad('Write a message first.');
    if (text.length > 1000) throw bad('Keep the message to 1,000 characters or fewer.');
    let fams = bookedFamilies(e.id, { waitlist: !!req.body?.waitlist });
    if (e.team_id) {
      // Team sessions go to the whole team roster, booked or not.
      const seen = new Set(fams.map((f) => f.to.toLowerCase()));
      for (const a of all('SELECT * FROM athletes WHERE team_id=? AND archived=0', e.team_id)) {
        const to = a.family_id ? billing.billingEmail(a.family_id) : a.email;
        if (to && !seen.has(to.toLowerCase())) { seen.add(to.toLowerCase()); fams.push({ to, names: [a.first_name] }); }
      }
    }
    if (!fams.length) throw bad('Nobody to email yet. Book someone first.');
    for (const f of fams) sendEmail(f.to, `${e.name}, ${when(e)}`, `${text}\n\n${req.staff.name}, ${businessName()}`);
    log(req, 'Emailed families', `${e.name} · ${when(e)} · ${fams.length} famil${fams.length === 1 ? 'y' : 'ies'}`);
    res.json({ ok: true, sent: fams.length });
  }));

  // Move someone off the waitlist now, even if it puts the session over its spots.
  api.post('/bookings/:id/promote', requireStaff(), h(async (req, res) => {
    const { b, e, a } = loadBooking(req.params.id);
    if (b.status !== 'waitlist') throw bad(`${a.first_name} isn't on the waitlist.`);
    if (e.cancelled) throw bad('That session was cancelled.');
    const c = booking.cover(booking.eventWithCounts(e.id), a, {});
    update('bookings', b.id, { status: 'booked', coverage: c.coverage });
    const to = a.family_id ? billing.billingEmail(a.family_id) : a.email;
    if (to) sendEmail(to, `${a.first_name} is in: ${e.name}`, `${a.first_name} is now booked for ${e.name} on ${when(e)}.`);
    emit('booking.created', { booking_id: b.id, event_id: e.id, athlete_code: a.code, starts_at: e.starts_at, name: e.name });
    const over = e.capacity && get("SELECT COUNT(*) n FROM bookings WHERE event_id=? AND status='booked'", e.id).n > e.capacity;
    log(req, 'Moved up from waitlist', `${fullName(a)} · ${e.name} · ${when(e)}${over ? ' · over spots' : ''}`);
    res.json({ ok: true, coverage: c.coverage, message: `${a.first_name} is booked.${c.coverage === 'unpaid' ? ' They owe the drop-in.' : ''}` });
  }));

  // ---- classes and camps ----
  api.get('/classes', requireStaff(), h(async (req, res) => {
    const rows = all(`SELECT * FROM classes WHERE archived=${req.query.archived === '1' ? 1 : 0} ORDER BY name`).map(classRow);
    if (req.staff.role === 'coach') rows.forEach((c) => { delete c.price_cents; delete c.reg_price_cents; });
    res.json(rows);
  }));

  api.post('/classes', requireStaff('owner', 'coach'), h(async (req, res) => {
    const row = classBody(req.body || {}, req);
    const name = row.name, type = row.type;
    const id = insert('classes', row);
    const made = booking.generateEvents();
    const count = get('SELECT COUNT(*) n FROM events WHERE class_id=?', id).n;
    log(req, `Added ${type}`, `${name} · ${row.weekdays.split(',').map((d) => DAY[d]).join(', ')} ${row.start_time} · ${count} sessions`);
    void made;
    res.json({ ok: true, id, sessions: count });
  }));

  // Edit a class or camp. Every upcoming session follows what changed: new time or place (booked families get one
  // email), length, spots, price, coach and name. A session changed on its own (a sub coach, a moved time, more
  // spots) keeps that change unless the class field it overrode changes to match. Sessions on days the class no
  // longer runs are cancelled; new days are added.
  api.put('/classes/:id', requireStaff('owner', 'coach'), h(async (req, res) => {
    const c = get('SELECT * FROM classes WHERE id=?', req.params.id);
    if (!c) throw notFound('That class');
    if (c.archived) throw bad('That class is archived. Add it again to bring it back.');
    const row = classBody(req.body || {}, req, c);
    const now = booking.nowLocal();
    const days = row.weekdays.split(',').map(Number);
    const future = all('SELECT * FROM events WHERE class_id=? AND cancelled=0 AND starts_at>? ORDER BY starts_at', c.id, now);
    const eff = { ...c, ...row }; // weekly classes keep any start or end date they already had
    const dayOf = (e) => e.slot_date || e.starts_at.slice(0, 10); // a moved session stands for its class day
    const fits = (d) => days.includes(new Date(d + 'T12:00:00').getDay()) && (!eff.start_date || d >= eff.start_date) && (!eff.end_date || d <= eff.end_date);
    const keep = future.filter((e) => fits(dayOf(e))), drop = future.filter((e) => !fits(dayOf(e)));
    // What each kept session becomes: only class fields that changed, and only where the session still had the old value.
    const FIELDS = ['name', 'duration_min', 'capacity', 'price_cents', 'location_id', 'coach_id'];
    const plan = keep.map((e) => {
      const next = {};
      for (const k of FIELDS) if (row[k] !== c[k] && e[k] === c[k]) next[k] = row[k];
      if (row.start_time !== c.start_time && e.starts_at.slice(11, 16) === c.start_time) {
        const at = `${e.starts_at.slice(0, 10)}T${row.start_time}`;
        if (at > now) next.starts_at = at; // never move a session into the past
      }
      return { e, next };
    });
    for (const { e, next } of plan) {
      // Never squeeze anyone out: spots can't go below what an upcoming session already has booked.
      if (next.capacity != null) {
        const n = get("SELECT COUNT(*) n FROM bookings WHERE event_id=? AND status='booked'", e.id).n;
        if (n > next.capacity) throw bad(`${n} athletes are booked on ${when(e)}. Set spots to ${n} or more.`);
      }
      if (next.starts_at && get('SELECT 1 FROM events WHERE class_id=? AND starts_at=? AND id<>?', c.id, next.starts_at, e.id)) {
        throw bad(`Another session of ${c.name} is already at ${when({ starts_at: next.starts_at })}. Move or cancel it first.`);
      }
    }
    let moved = 0, notified = 0, cancelled = 0, promoted = 0;
    tx(() => {
      update('classes', c.id, row);
      for (const e of drop) {
        const paid = all("SELECT id FROM bookings WHERE event_id=? AND status='booked' AND coverage='paid' AND paid_cents>0", e.id).map((x) => x.id);
        booking.cancelEvent(e.id, `${row.name} no longer runs on ${new Date(dayOf(e) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' })}s`);
        markSalesRefunded(paid);
        cancelled++;
      }
      const moves = [];
      for (const { e, next } of plan) {
        if (Object.keys(next).length) update('events', e.id, next);
        const after = { ...e, ...next };
        if (after.starts_at !== e.starts_at || after.location_id !== e.location_id) { moved++; moves.push({ before: e, after }); }
        while (booking.promoteWaitlist(e.id)) promoted++;
      }
      notified = notifyMoved(moves);
    });
    const before = get('SELECT COUNT(*) n FROM events WHERE class_id=?', c.id).n;
    booking.generateEvents();
    const added = get('SELECT COUNT(*) n FROM events WHERE class_id=?', c.id).n - before;
    const bits = [`${keep.length} upcoming session${keep.length === 1 ? '' : 's'} updated`, moved && `${moved} moved`, cancelled && `${cancelled} cancelled`, added && `${added} added`].filter(Boolean);
    log(req, `Edited ${c.type}`, `${row.name} · ${row.weekdays.split(',').map((d) => DAY[d]).join(', ')} ${row.start_time} · ${bits.join(', ')}${notified ? ` · ${notified} famil${notified === 1 ? 'y' : 'ies'} emailed` : ''}`);
    res.json({ ok: true, updated: keep.length, moved, cancelled, added, notified, promoted });
  }));

  // Archive a class: its future sessions are cancelled (credits back, families emailed).
  api.post('/classes/:id/archive', requireStaff('owner', 'coach'), h(async (req, res) => {
    const c = get('SELECT * FROM classes WHERE id=?', req.params.id);
    if (!c) throw notFound('That class');
    if (c.archived) throw bad('That class is already archived.');
    const reason = String(req.body?.reason || '').trim() || `${c.name} is no longer running`;
    const future = all('SELECT id FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=?', c.id, booking.nowLocal());
    let notified = 0;
    tx(() => {
      update('classes', c.id, { archived: 1 });
      run('DELETE FROM standing_spots WHERE class_id=?', c.id);
      for (const e of future) {
        const paid = all("SELECT id FROM bookings WHERE event_id=? AND status='booked' AND coverage='paid' AND paid_cents>0", e.id).map((x) => x.id);
        notified += booking.cancelEvent(e.id, reason);
        markSalesRefunded(paid);
      }
    });
    log(req, `Archived ${c.type}`, `${c.name} · ${future.length} future sessions cancelled`);
    res.json({ ok: true, cancelled: future.length, notified });
  }));

  // ---- hours for privates and evaluations ----
  api.get('/availability', requireStaff('owner', 'coach'), h(async (_req, res) => {
    res.json(all(`SELECT v.*, l.name AS location, s.name AS coach FROM availability v LEFT JOIN locations l ON l.id=v.location_id LEFT JOIN staff s ON s.id=v.coach_id
      ORDER BY v.kind DESC, v.weekday, v.start_time`));
  }));

  // Add hours on one or more days at once (weekdays: [1,2,3,4,5] for Monday to Friday).
  api.post('/availability', requireStaff('owner', 'coach'), h(async (req, res) => {
    const b = req.body || {};
    if (!['private', 'evaluation'].includes(b.kind)) throw bad('Choose private training or evaluations.');
    const raw = Array.isArray(b.weekdays) ? b.weekdays : b.weekday != null && b.weekday !== '' ? [b.weekday] : [];
    const days = [...new Set(raw.map(Number))].sort();
    if (!days.length || days.some((wd) => !(Number.isInteger(wd) && wd >= 0 && wd <= 6))) throw bad('Pick a day.');
    if (!isTime(b.start_time) || !isTime(b.end_time)) throw bad('Enter a start and end time.');
    if (toMin(b.end_time) <= toMin(b.start_time)) throw bad('The end time must be after the start time.');
    const slot = Number(b.slot_min);
    if (!(Number.isInteger(slot) && slot >= 15 && slot <= 240)) throw bad('Minutes each must be between 15 and 240.');
    if (slot > toMin(b.end_time) - toMin(b.start_time)) throw bad('One slot is longer than the time range.');
    const price = b.kind === 'evaluation' ? intOrNull(b.price_cents) ?? 0 : 0;
    if (!(price >= 0)) throw bad('Enter a price of $0 or more.');
    const loc = b.location_id ? get('SELECT id, name FROM locations WHERE id=? AND archived=0', b.location_id) : null;
    if (!loc) throw bad('Choose where.');
    const coach = b.coach_id ? Number(b.coach_id) : req.staff.id;
    if (!isActiveCoach(coach)) throw bad('Choose a coach.');
    for (const wd of days) {
      const clash = all('SELECT * FROM availability WHERE kind=? AND weekday=? AND (coach_id IS ? OR coach_id=?)', b.kind, wd, coach, coach)
        .find((x) => toMin(x.start_time) < toMin(b.end_time) && toMin(x.end_time) > toMin(b.start_time));
      if (clash) throw bad(`That overlaps ${DAY[wd]} ${clash.start_time}–${clash.end_time}. Remove it first or pick another time.`);
    }
    const ids = tx(() => days.map((wd) => insert('availability', { kind: b.kind, weekday: wd, start_time: b.start_time, end_time: b.end_time, slot_min: slot, location_id: loc.id, price_cents: price, coach_id: coach })));
    log(req, 'Added hours', `${days.map((d) => DAY[d]).join(', ')} ${b.start_time}–${b.end_time} · ${b.kind === 'private' ? 'Privates' : 'Evaluations'} · ${slot} min · ${loc.name}`);
    res.json({ ok: true, id: ids[0], ids });
  }));

  // What parents can book in the next week, so you can see your hours working.
  api.get('/availability/open', requireStaff('owner', 'coach'), h(async (_req, res) => {
    const out = {};
    for (const kind of ['private', 'evaluation']) {
      const slots = booking.openSlots(kind, booking.todayLocal(), 7);
      out[kind] = { count: slots.length, next: slots[0]?.starts_at || null };
    }
    res.json(out);
  }));

  api.delete('/availability/:id', requireStaff('owner', 'coach'), h(async (req, res) => {
    const v = get('SELECT * FROM availability WHERE id=?', req.params.id);
    if (!v) throw notFound('Those hours');
    run('DELETE FROM availability WHERE id=?', v.id);
    log(req, 'Removed hours', `${DAY[v.weekday]} ${v.start_time}–${v.end_time} · ${v.kind === 'private' ? 'Privates' : 'Evaluations'}`);
    res.json({ ok: true });
  }));

  // ---- time off: a coach away, or the facility closed. No private or evaluation times are offered those days. ----
  // Upcoming time off, or (with from and to) any that touches those dates, for looking back on the schedule.
  api.get('/time-off', requireStaff(), h(async (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : booking.todayLocal();
    const to = isDate(req.query.to) ? req.query.to : '9999-12-31';
    res.json(all(`SELECT t.*, s.name AS coach FROM time_off t LEFT JOIN staff s ON s.id=t.coach_id WHERE t.end_date>=? AND t.start_date<=? ORDER BY t.start_date, t.id`, from, to));
  }));

  api.post('/time-off', requireStaff('owner', 'coach'), h(async (req, res) => {
    const b = req.body || {};
    const start = b.start_date, end = b.end_date || b.start_date;
    if (!isDate(start) || !isDate(end)) throw bad('Pick the first and last day off.');
    if (end < start) throw bad('The last day is before the first day.');
    if (end < booking.todayLocal()) throw bad('Those days have already passed.');
    if (addDays(start, 366) < end) throw bad('Add a year or less at a time.');
    const coach = b.coach_id ? Number(b.coach_id) : null;
    if (coach && !isActiveCoach(coach)) throw bad('Choose a coach.');
    const note = String(b.note || '').trim().slice(0, 120) || null;
    const id = insert('time_off', { coach_id: coach, start_date: start, end_date: end, note });
    // Anything already booked stays booked; say how many so they can be moved.
    const booked = get(`SELECT COUNT(*) n FROM events WHERE cancelled=0 AND type IN ('private','evaluation') AND substr(starts_at,1,10) BETWEEN ? AND ? ${coach ? 'AND coach_id=?' : ''}`, ...[start, end, ...(coach ? [coach] : [])]).n;
    const who = coach ? get('SELECT name FROM staff WHERE id=?', coach).name : 'Facility closed';
    log(req, 'Added time off', `${who} · ${start === end ? start : `${start} to ${end}`}${note ? ` · ${note}` : ''}`);
    res.json({ ok: true, id, already_booked: booked });
  }));

  api.delete('/time-off/:id', requireStaff('owner', 'coach'), h(async (req, res) => {
    const t = get('SELECT t.*, s.name AS coach FROM time_off t LEFT JOIN staff s ON s.id=t.coach_id WHERE t.id=?', req.params.id);
    if (!t) throw notFound('That time off');
    run('DELETE FROM time_off WHERE id=?', t.id);
    log(req, 'Removed time off', `${t.coach || 'Facility closed'} · ${t.start_date === t.end_date ? t.start_date : `${t.start_date} to ${t.end_date}`}`);
    res.json({ ok: true });
  }));
}

module.exports = { routes };
