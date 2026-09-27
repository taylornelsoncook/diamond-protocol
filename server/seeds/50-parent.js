// Parent portal demo data: a few bookings families made themselves, so Home has something coming up.
'use strict';
const { get, all, run, insert, update } = require('../db');
const booking = require('../services/booking');
require('../services/parent-book'); // adds bookings.note

function seed() {
  booking.generateEvents();
  const now = booking.nowLocal();
  const athlete = (email, first) => get(`SELECT a.* FROM athletes a JOIN parents p ON p.family_id=a.family_id WHERE p.email=? AND a.first_name=?`, email, first);
  const nextOf = (className, n) => all(`SELECT e.id FROM events e JOIN classes c ON c.id=e.class_id WHERE c.name=? AND e.cancelled=0 AND e.starts_at>? ORDER BY e.starts_at LIMIT ?`, className, now, n);
  const plan = [
    ['maria.lopez@example.com', 'Ava', 'High School Performance', 2],
    ['maria.lopez@example.com', 'Ava', 'Saturday Strength', 1],
    ['kurt.jensen@example.com', 'Nate', 'Youth Speed & Agility', 2],
    ['kurt.jensen@example.com', 'Emma', 'Saturday Strength', 1],
  ];
  for (const [email, first, cls, n] of plan) {
    const a = athlete(email, first);
    if (!a) continue;
    for (const e of nextOf(cls, n)) { try { booking.book(e.id, a.id, { source: 'parent', quiet: true }); } catch { /* not eligible or already booked */ } }
  }
  // Nate joins the waitlist of the full session, so Home shows a waitlist spot and its place in line.
  const nate = athlete('kurt.jensen@example.com', 'Nate');
  const full = get(`SELECT e.id FROM events e WHERE e.cancelled=0 AND e.starts_at>? AND e.capacity>0
    AND (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='waitlist')>0 ORDER BY e.starts_at LIMIT 1`, now);
  if (nate && full) { try { booking.book(full.id, nate.id, { source: 'parent', quiet: true }); } catch { /* already on it */ } }

  // A second coach takes privates late on Tuesdays and Thursdays, so families can pick who they train with.
  const owner = get("SELECT id FROM staff WHERE role='owner' ORDER BY id LIMIT 1");
  const facility = get('SELECT location_id FROM availability WHERE kind=? LIMIT 1', 'private')?.location_id || null;
  if (owner && !get("SELECT 1 FROM availability WHERE kind='private' AND coach_id=?", owner.id)) {
    for (const wd of [2, 4]) insert('availability', { kind: 'private', weekday: wd, start_time: '15:00', end_time: '17:00', slot_min: 60, location_id: facility, coach_id: owner.id });
  }
  // Ava has privates from a pack and one booked with a note for the coach, so the Private tab shows what's booked.
  const ava = athlete('maria.lopez@example.com', 'Ava');
  if (ava && !get("SELECT 1 FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND e.type='private'", ava.id)) {
    run('UPDATE athletes SET private_credits=private_credits+3 WHERE id=?', ava.id);
    const slot = booking.openSlots('private', booking.todayLocal(), 14).find((s) => s.starts_at.slice(0, 10) > now.slice(0, 10));
    if (slot) {
      try {
        const b = booking.bookSlot('private', slot.starts_at, ava.id, { source: 'parent', coachId: slot.coach_id });
        update('bookings', b.id, { note: 'Working on first-step quickness before tryouts.' });
      } catch { /* time taken */ }
    }
  }
}

module.exports = { seed };
