// Scheduling rules shared by the dashboard and parent portal: sessions, bookings, coverage, waitlists, cancellations.
// Event times are local wall-clock strings ("2026-09-28T16:30") in the business time zone from settings.
'use strict';
const { get, all, run, insert, update, tx, setting } = require('../db');
const { bad, sendEmail, emit, addDays, ageOn, money } = require('../lib');
const billing = require('./billing');

const GENERATE_WEEKS = 8;

// Current wall-clock time in the business time zone, as "YYYY-MM-DDTHH:MM".
function nowLocal() {
  const tz = setting('timezone', 'America/Denver');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const todayLocal = () => nowLocal().slice(0, 10);
function hoursUntil(startsAt) {
  const toMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16));
  return (toMs(startsAt) - toMs(nowLocal())) / 36e5;
}

// Job: create sessions for every weekly class up to 8 weeks ahead (camps only within their dates).
function generateEvents() {
  const start = todayLocal();
  const horizon = addDays(start, GENERATE_WEEKS * 7);
  let made = 0;
  for (const c of all('SELECT * FROM classes WHERE archived=0')) {
    const days = String(c.weekdays).split(',').map(Number);
    const from = c.start_date && c.start_date > start ? c.start_date : start;
    const to = c.end_date && c.end_date < horizon ? c.end_date : horizon;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (!days.includes(new Date(d + 'T12:00:00').getDay())) continue;
      const starts_at = `${d}T${c.start_time}`;
      if (get('SELECT 1 FROM events WHERE class_id=? AND starts_at=?', c.id, starts_at)) continue;
      const eid = insert('events', { class_id: c.id, type: c.type, name: c.name, starts_at, duration_min: c.duration_min, capacity: c.capacity, price_cents: c.price_cents, location_id: c.location_id, team_id: c.team_id, coach_id: c.coach_id });
      made++;
      // Standing weekly spots and camp registrations carry into new sessions.
      // Standing spots ride on the membership only: never spend pack credits or book unpaid.
      for (const s of all('SELECT athlete_id FROM standing_spots WHERE class_id=?', c.id)) {
        const a = get('SELECT * FROM athletes WHERE id=?', s.athlete_id);
        if (cover(eventWithCounts(eid), a, { dryRun: true }).coverage !== 'member') continue;
        try { book(eid, s.athlete_id, { source: 'standing', quiet: true, requireCovered: true }); } catch { /* full */ }
      }
      if (c.type === 'camp' || c.type === 'clinic') {
        for (const r of all(`SELECT DISTINCT b.athlete_id FROM bookings b JOIN events e ON e.id=b.event_id WHERE e.class_id=? AND b.coverage='registered' AND b.status='booked'`, c.id)) {
          if (!get('SELECT 1 FROM bookings WHERE event_id=? AND athlete_id=?', eid, r.athlete_id)) insert('bookings', { event_id: eid, athlete_id: r.athlete_id, status: 'booked', coverage: 'registered', source: 'registration' });
        }
      }
    }
  }
  return made;
}

function eventWithCounts(id) {
  return get(`SELECT e.*, (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='booked') AS booked,
    (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='waitlist') AS waitlisted FROM events e WHERE e.id=?`, id);
}

// Work out how a booking is paid for. payWith: 'card' charges the drop-in price to the card on file.
function cover(event, athlete, { payWith = null, dryRun = false } = {}) {
  if (event.type === 'team') return { coverage: 'team' };
  if (event.type === 'camp' || event.type === 'clinic') {
    const cls = event.class_id ? get('SELECT * FROM classes WHERE id=?', event.class_id) : null;
    if (cls?.reg_price_cents) {
      const reg = get(`SELECT 1 FROM bookings b JOIN events e ON e.id=b.event_id WHERE e.class_id=? AND b.athlete_id=? AND b.coverage='registered' AND b.status='booked'`, cls.id, athlete.id);
      return { coverage: reg ? 'registered' : 'unpaid' };
    }
  }
  if (event.type === 'private') {
    if (athlete.private_credits > 0) { if (!dryRun) run('UPDATE athletes SET private_credits=private_credits-1 WHERE id=?', athlete.id); return { coverage: 'credit' }; }
  } else if (event.type === 'class' || event.type === 'camp' || event.type === 'clinic') {
    if (billing.memberSessionsLeft(athlete.id, event.starts_at.slice(0, 10)) > 0) return { coverage: 'member' };
    if (athlete.group_credits > 0) { if (!dryRun) run('UPDATE athletes SET group_credits=group_credits-1 WHERE id=?', athlete.id); return { coverage: 'credit' }; }
  }
  if (!event.price_cents) return { coverage: 'paid' };
  if (payWith === 'card' && !dryRun) {
    const r = billing.charge({ family_id: athlete.family_id, athlete_id: athlete.id, amount_cents: event.price_cents, description: `${event.name}, ${event.starts_at.replace('T', ' ')}`, method: 'card' });
    if (!r.ok) {
      run("UPDATE invoices SET status='void', next_retry=NULL WHERE id=?", r.invoice_id); // booking refused, so never retry it
      throw bad(r.error || 'The card was declined.');
    }
    return { coverage: 'paid', paid_cents: event.price_cents };
  }
  return { coverage: 'unpaid' };
}

// Book an athlete. Full sessions go to the waitlist. Returns the booking row.
function book(eventId, athleteId, { source = 'staff', payWith = null, requireCovered = false, quiet = false } = {}) {
  return tx(() => {
    const e = eventWithCounts(eventId);
    if (!e || e.cancelled) throw bad('That session was cancelled or no longer exists.');
    const a = get('SELECT * FROM athletes WHERE id=?', athleteId);
    if (!a) throw bad('No such athlete.');
    const existing = get("SELECT * FROM bookings WHERE event_id=? AND athlete_id=? AND status IN ('booked','waitlist')", eventId, athleteId);
    if (existing) throw bad(`${a.first_name} is already ${existing.status === 'waitlist' ? 'on the waitlist' : 'booked'}.`);
    if (source === 'parent') {
      const cls = e.class_id ? get('SELECT * FROM classes WHERE id=?', e.class_id) : null;
      const age = ageOn(a.birthday, e.starts_at.slice(0, 10));
      if (cls && age != null && ((cls.min_age && age < cls.min_age) || (cls.max_age && age > cls.max_age))) throw bad(`${e.name} is for ages ${cls.min_age || ''}–${cls.max_age || ''}.`);
      if (hoursUntil(e.starts_at) < 0) throw bad('That session has already started.');
    }
    const full = e.capacity && e.booked >= e.capacity;
    if (full) {
      const id = insert('bookings', { event_id: eventId, athlete_id: athleteId, status: 'waitlist', coverage: null, source });
      return get('SELECT * FROM bookings WHERE id=?', id);
    }
    const c = cover(e, a, { payWith });
    if (requireCovered && c.coverage === 'unpaid') throw bad('No sessions left. Pay the drop-in price or buy a pack.');
    const id = insert('bookings', { event_id: eventId, athlete_id: athleteId, status: 'booked', coverage: c.coverage, paid_cents: c.paid_cents || 0, source });
    if (!quiet) emit('booking.created', { booking_id: id, event_id: eventId, athlete_code: a.code, starts_at: e.starts_at, name: e.name });
    return get('SELECT * FROM bookings WHERE id=?', id);
  });
}

// Give back whatever paid for a booking: credits return, drop-ins are refunded.
function restore(b) {
  if (b.coverage === 'credit') {
    const e = get('SELECT type FROM events WHERE id=?', b.event_id);
    run(`UPDATE athletes SET ${e.type === 'private' ? 'private_credits' : 'group_credits'}=${e.type === 'private' ? 'private_credits' : 'group_credits'}+1 WHERE id=?`, b.athlete_id);
  } else if (b.coverage === 'paid' && b.paid_cents > 0) {
    const inv = get("SELECT id FROM invoices WHERE athlete_id=? AND amount_cents=? AND status='paid' AND kind='charge' ORDER BY id DESC LIMIT 1", b.athlete_id, b.paid_cents);
    if (inv) billing.refundInvoice(inv.id, b.paid_cents);
  }
}

// Cancel one booking. Inside the late-cancel window (parents only) the session is still used.
function cancelBooking(bookingId, { byParent = false } = {}) {
  return tx(() => {
    const b = get('SELECT * FROM bookings WHERE id=?', bookingId);
    if (!b || !['booked', 'waitlist'].includes(b.status)) throw bad('That booking is already cancelled.');
    const e = get('SELECT * FROM events WHERE id=?', b.event_id);
    if (b.status === 'waitlist') { update('bookings', b.id, { status: 'cancelled' }); return { late: false }; }
    const late = byParent && hoursUntil(e.starts_at) < Number(setting('late_cancel_hours', 12));
    update('bookings', b.id, { status: late ? 'late_cancel' : 'cancelled' });
    if (!late) restore(b);
    emit('booking.cancelled', { booking_id: b.id, event_id: e.id, late });
    promoteWaitlist(e.id);
    return { late };
  });
}

// Move the first waitlisted athlete up when a spot opens, and email the family.
function promoteWaitlist(eventId) {
  const e = eventWithCounts(eventId);
  if (!e || e.cancelled || (e.capacity && e.booked >= e.capacity)) return null;
  const w = get("SELECT * FROM bookings WHERE event_id=? AND status='waitlist' ORDER BY id LIMIT 1", eventId);
  if (!w) return null;
  const a = get('SELECT * FROM athletes WHERE id=?', w.athlete_id);
  const c = cover(e, a, {});
  update('bookings', w.id, { status: 'booked', coverage: c.coverage });
  const to = a.family_id ? billing.billingEmail(a.family_id) : a.email;
  sendEmail(to, `${a.first_name} is in: ${e.name}`, `A spot opened up. ${a.first_name} is now booked for ${e.name} on ${e.starts_at.replace('T', ' at ')}.${c.coverage === 'unpaid' ? ` The drop-in price is ${money(e.price_cents)}, due at the session.` : ''}`);
  return w.id;
}

// Cancel a whole session (weather, say): credits back, drop-ins refunded, families emailed with the reason.
function cancelEvent(eventId, reason) {
  return tx(() => {
    const e = get('SELECT * FROM events WHERE id=?', eventId);
    if (!e || e.cancelled) throw bad('That session is already cancelled.');
    update('events', eventId, { cancelled: 1, cancel_reason: reason || null });
    const list = all("SELECT * FROM bookings WHERE event_id=? AND status IN ('booked','waitlist')", eventId);
    for (const b of list) {
      if (b.status === 'booked') restore(b);
      update('bookings', b.id, { status: 'cancelled' });
      const a = get('SELECT * FROM athletes WHERE id=?', b.athlete_id);
      const to = a.family_id ? billing.billingEmail(a.family_id) : a.email;
      if (b.status === 'booked') sendEmail(to, `Cancelled: ${e.name} on ${e.starts_at.slice(0, 10)}`, `${e.name} on ${e.starts_at.replace('T', ' at ')} is cancelled.${reason ? ` Reason: ${reason}.` : ''} ${b.coverage === 'credit' ? 'The session credit is back on your account.' : b.coverage === 'paid' ? 'Your drop-in payment has been refunded.' : ''}`.trim());
    }
    return list.length;
  });
}

function checkIn(bookingId, on = true) {
  const b = get('SELECT * FROM bookings WHERE id=?', bookingId);
  if (!b || b.status !== 'booked') throw bad('Only booked athletes can be checked in.');
  update('bookings', bookingId, { checked_in_at: on ? new Date().toISOString() : null });
  if (on) emit('checkin.created', { booking_id: bookingId, athlete_id: b.athlete_id, event_id: b.event_id });
}

// Open private/evaluation times from the hours in settings, minus anything already on the schedule.
function openSlots(kind, fromDate, days = 21) {
  const hours = all('SELECT * FROM availability WHERE kind=?', kind);
  const now = nowLocal();
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(fromDate, i);
    const wd = new Date(d + 'T12:00:00').getDay();
    for (const h of hours.filter((x) => x.weekday === wd)) {
      if (require('./floor-util').isTimeOff(h.coach_id, d)) continue; // coach away or facility closed
      const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
      for (let m = toMin(h.start_time); m + h.slot_min <= toMin(h.end_time); m += h.slot_min) {
        const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const starts_at = `${d}T${t}`;
        if (starts_at <= now) continue;
        const endM = m + h.slot_min;
        const clash = all(`SELECT starts_at, duration_min FROM events WHERE cancelled=0 AND substr(starts_at,1,10)=? AND (? IS NULL OR coach_id IS NULL OR coach_id=?)`, d, h.coach_id, h.coach_id)
          .some((e) => { const s = toMin(e.starts_at.slice(11, 16)); return s < endM && s + e.duration_min > m; });
        if (!clash) out.push({ starts_at, duration_min: h.slot_min, location_id: h.location_id, price_cents: h.price_cents, coach_id: h.coach_id, availability_id: h.id });
      }
    }
  }
  return out;
}

// Book a private or evaluation into an open slot: creates the session, then the booking.
function bookSlot(kind, starts_at, athleteId, { source = 'parent' } = {}) {
  const slot = openSlots(kind, starts_at.slice(0, 10), 1).find((s) => s.starts_at === starts_at);
  if (!slot) throw bad('That time was just taken. Pick another.');
  const a = get('SELECT * FROM athletes WHERE id=?', athleteId);
  if (kind === 'private' && a.private_credits < 1) throw bad('No private sessions left. Buy a private pack first.');
  const privateProduct = get("SELECT price_cents FROM products WHERE kind='private_pack' AND credits=1 AND archived=0 LIMIT 1");
  const eid = insert('events', { type: kind, name: `${kind === 'private' ? 'Private' : 'Evaluation'}: ${a.first_name} ${a.last_name}`, starts_at, duration_min: slot.duration_min, capacity: 1,
    price_cents: kind === 'evaluation' ? slot.price_cents : privateProduct?.price_cents || 0, location_id: slot.location_id, coach_id: slot.coach_id });
  try { return book(eid, athleteId, { source, payWith: kind === 'evaluation' ? 'card' : null }); }
  catch (e) { run('DELETE FROM events WHERE id=?', eid); throw e; }
}

// Camp/clinic registration: charge once, book every remaining day.
function registerCamp(classId, athleteId, { method = 'card', source = 'parent' } = {}) {
  const c = get('SELECT * FROM classes WHERE id=?', classId);
  if (!c || !c.reg_price_cents) throw bad('That camp is not open for registration.');
  if (c.reg_deadline && todayLocal() > c.reg_deadline) throw bad('Registration has closed.');
  const a = get('SELECT * FROM athletes WHERE id=?', athleteId);
  if (get(`SELECT 1 FROM bookings b JOIN events e ON e.id=b.event_id WHERE e.class_id=? AND b.athlete_id=? AND b.coverage='registered' AND b.status='booked'`, classId, athleteId)) throw bad(`${a.first_name} is already registered.`);
  const r = billing.charge({ family_id: a.family_id, athlete_id: a.id, amount_cents: c.reg_price_cents, description: `${c.name} registration`, method });
  if (!r.ok) {
    run("UPDATE invoices SET status='void', next_retry=NULL WHERE id=?", r.invoice_id); // nothing was delivered, so never retry it
    throw bad(r.error || 'The card was declined.');
  }
  const events = all("SELECT id FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=?", classId, nowLocal());
  tx(() => {
    for (const e of events) {
      const ex = get("SELECT id FROM bookings WHERE event_id=? AND athlete_id=? AND status IN ('booked','waitlist')", e.id, a.id);
      if (ex) update('bookings', ex.id, { status: 'booked', coverage: 'registered' });
      else insert('bookings', { event_id: e.id, athlete_id: a.id, status: 'booked', coverage: 'registered', source });
    }
  });
  return { days: events.length, invoice_id: r.invoice_id };
}

module.exports = { nowLocal, todayLocal, hoursUntil, generateEvents, eventWithCounts, cover, book, cancelBooking, promoteWaitlist, cancelEvent, checkIn, openSlots, bookSlot, registerCamp, restore };
