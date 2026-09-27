// Parent portal demo data: a few bookings families made themselves, so Home has something coming up.
'use strict';
const { get, all } = require('../db');
const booking = require('../services/booking');

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
}

module.exports = { seed };
