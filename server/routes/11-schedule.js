// Schedule: sessions for the next two weeks, classes and camps, session rosters (check-in, collect, waitlist,
// cancel, team "Everyone's here") and bookable hours for privates and evaluations.
'use strict';
const { get, all, run, insert, update, tx } = require('../db');
const { h, bad, notFound, log, money, addDays, emit, payments } = require('../lib');
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
    return { id: b.id, status: b.status, coverage: b.coverage, paid_cents: b.paid_cents, checked_in_at: b.checked_in_at, source: b.source, athlete: athleteCard(a, on) };
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

function routes(api) {
  // ---- sessions ----
  api.get('/events', requireStaff(), h(async (req, res) => {
    const T = booking.todayLocal();
    const from = isDate(req.query.from) ? req.query.from : T;
    const to = isDate(req.query.to) ? req.query.to : addDays(from, 13);
    if (to < from) throw bad('The end date is before the start date.');
    if (addDays(from, 92) < to) throw bad('Ask for three months or less at a time.');
    res.json(eventsBetween(from, to, { includeCancelled: req.query.cancelled !== '0' }));
  }));

  api.get('/events/:id', requireStaff(), h(async (req, res) => {
    const e = eventById(req.params.id);
    if (!e) throw notFound('That session');
    const cls = e.class_id ? get('SELECT * FROM classes WHERE id=?', e.class_id) : null;
    res.json({ event: e, class: cls ? classRow(cls) : null, ...roster(e, req.staff.role), payments_mode: payments.mode() });
  }));

  // Add an athlete. A full session puts them on the waitlist.
  api.post('/events/:id/bookings', requireStaff(), h(async (req, res) => {
    const e = get('SELECT * FROM events WHERE id=?', req.params.id);
    if (!e) throw notFound('That session');
    const a = get('SELECT * FROM athletes WHERE id=? AND archived=0', Number(req.body.athlete_id));
    if (!a) throw bad('Choose an athlete to add.');
    const b = booking.book(e.id, a.id, { source: 'staff' });
    log(req, b.status === 'waitlist' ? 'Added to waitlist' : 'Booked', `${fullName(a)} · ${e.name} · ${when(e)}`);
    res.json({ ok: true, booking: b, message: b.status === 'waitlist' ? `The session is full. ${a.first_name} is on the waitlist.` : `${a.first_name} is booked.` });
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
      const r = billing.charge({ family_id: a.family_id, athlete_id: a.id, amount_cents: amount, description: `${e.name}, ${e.starts_at.replace('T', ' ')}`, method });
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
    log(req, 'Cancelled session', `${e.name} · ${when(e)} · ${reason} · ${n} famil${n === 1 ? 'y' : 'ies'} notified`);
    res.json({ ok: true, notified: n });
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

  // ---- classes and camps ----
  api.get('/classes', requireStaff(), h(async (req, res) => {
    const rows = all(`SELECT * FROM classes WHERE archived=${req.query.archived === '1' ? 1 : 0} ORDER BY name`).map(classRow);
    if (req.staff.role === 'coach') rows.forEach((c) => { delete c.price_cents; delete c.reg_price_cents; });
    res.json(rows);
  }));

  api.post('/classes', requireStaff('owner', 'coach'), h(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw bad('Give the class a name.');
    const type = b.type || 'class';
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
    const price = intOrNull(b.price_cents) ?? 0;
    if (!(price >= 0)) throw bad('Enter a drop-in price of $0 or more.');
    const row = { name, type, weekdays: days.join(','), start_time: b.start_time, duration_min: duration, capacity, min_age: minAge, max_age: maxAge, price_cents: price };
    if (type === 'camp' || type === 'clinic') {
      if (!isDate(b.start_date) || !isDate(b.end_date)) throw bad('Camps and clinics need a first and last date.');
      if (b.end_date < b.start_date) throw bad('The last date is before the first date.');
      const reg = intOrNull(b.reg_price_cents);
      if (Number.isNaN(reg) || (reg != null && reg < 0)) throw bad('Enter a registration price of $0 or more.');
      if (b.reg_deadline && !isDate(b.reg_deadline)) throw bad('Enter the last day to register as a date.');
      Object.assign(row, { reg_price_cents: reg || null, reg_deadline: b.reg_deadline || null, start_date: b.start_date, end_date: b.end_date });
    } else if (isDate(b.start_date)) row.start_date = b.start_date;
    if (type === 'team') {
      if (!get("SELECT 1 FROM team_contracts WHERE id=? AND status='active'", b.team_id)) throw bad('Choose the team.');
      row.team_id = Number(b.team_id);
    }
    const loc = b.location_id ? get('SELECT id FROM locations WHERE id=? AND archived=0', b.location_id) : get('SELECT id FROM locations WHERE archived=0 ORDER BY id LIMIT 1');
    if (b.location_id && !loc) throw bad('Choose a location.');
    row.location_id = loc?.id || null;
    row.coach_id = b.coach_id ? Number(b.coach_id) : req.staff.role === 'frontdesk' ? null : req.staff.id;
    if (row.coach_id && !get("SELECT 1 FROM staff WHERE id=? AND active=1", row.coach_id)) throw bad('Choose a coach.');
    const id = insert('classes', row);
    const made = booking.generateEvents();
    const count = get('SELECT COUNT(*) n FROM events WHERE class_id=?', id).n;
    log(req, `Added ${type}`, `${name} · ${row.weekdays.split(',').map((d) => DAY[d]).join(', ')} ${row.start_time} · ${count} sessions`);
    void made;
    res.json({ ok: true, id, sessions: count });
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

  api.post('/availability', requireStaff('owner', 'coach'), h(async (req, res) => {
    const b = req.body || {};
    if (!['private', 'evaluation'].includes(b.kind)) throw bad('Choose private training or evaluations.');
    const wd = Number(b.weekday);
    if (!(Number.isInteger(wd) && wd >= 0 && wd <= 6)) throw bad('Pick a day.');
    if (!isTime(b.start_time) || !isTime(b.end_time)) throw bad('Enter a start and end time.');
    if (toMin(b.end_time) <= toMin(b.start_time)) throw bad('The end time must be after the start time.');
    const slot = Number(b.slot_min);
    if (!(Number.isInteger(slot) && slot >= 15 && slot <= 240)) throw bad('Minutes each must be between 15 and 240.');
    if (slot > toMin(b.end_time) - toMin(b.start_time)) throw bad('One slot is longer than the time range.');
    const price = b.kind === 'evaluation' ? intOrNull(b.price_cents) ?? 0 : 0;
    if (!(price >= 0)) throw bad('Enter a price of $0 or more.');
    const loc = b.location_id ? get('SELECT id, name FROM locations WHERE id=? AND archived=0', b.location_id) : null;
    if (!loc) throw bad('Choose where.');
    const coach = Number(b.coach_id) || req.staff.id;
    const clash = all('SELECT * FROM availability WHERE kind=? AND weekday=? AND (coach_id IS ? OR coach_id=?)', b.kind, wd, coach, coach)
      .find((x) => toMin(x.start_time) < toMin(b.end_time) && toMin(x.end_time) > toMin(b.start_time));
    if (clash) throw bad(`That overlaps ${DAY[wd]} ${clash.start_time}–${clash.end_time}. Remove it first or pick another time.`);
    const id = insert('availability', { kind: b.kind, weekday: wd, start_time: b.start_time, end_time: b.end_time, slot_min: slot, location_id: loc.id, price_cents: price, coach_id: coach });
    log(req, 'Added hours', `${DAY[wd]} ${b.start_time}–${b.end_time} · ${b.kind === 'private' ? 'Privates' : 'Evaluations'} · ${slot} min · ${loc.name}`);
    res.json({ ok: true, id });
  }));

  api.delete('/availability/:id', requireStaff('owner', 'coach'), h(async (req, res) => {
    const v = get('SELECT * FROM availability WHERE id=?', req.params.id);
    if (!v) throw notFound('Those hours');
    run('DELETE FROM availability WHERE id=?', v.id);
    log(req, 'Removed hours', `${DAY[v.weekday]} ${v.start_time}–${v.end_time} · ${v.kind === 'private' ? 'Privates' : 'Evaluations'}`);
    res.json({ ok: true });
  }));
}

module.exports = { routes };
