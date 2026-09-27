// Parent booking helpers: the note a family leaves for the coach, and keeping an athlete from being booked in two places at once.
'use strict';
const { all, run } = require('../db');
const { addDays } = require('../lib');

// Added later: what a family tells the coach when booking a private or an evaluation.
if (!all('PRAGMA table_info(bookings)').some((c) => c.name === 'note')) run('ALTER TABLE bookings ADD COLUMN note TEXT');

// End of a session as a local wall-clock string.
function endAt(startsAt, minutes) { const d = new Date(startsAt + ':00Z'); d.setUTCMinutes(d.getUTCMinutes() + (minutes || 60)); return d.toISOString().slice(0, 16); }
// The athlete's booked sessions that touch [from, to), to stop a family booking two places at once.
function bookedBetween(athleteId, from, to) {
  return all(`SELECT e.id, e.name, e.type, e.starts_at, e.duration_min FROM bookings b JOIN events e ON e.id=b.event_id
    WHERE b.athlete_id=? AND b.status='booked' AND e.cancelled=0 AND e.starts_at>=? AND e.starts_at<?`, athleteId, addDays(from.slice(0, 10), -1) + 'T00:00', to);
}
function clashIn(busy, startsAt, minutes, eventId = null) {
  const end = endAt(startsAt, minutes);
  return busy.find((x) => x.id !== eventId && x.starts_at < end && endAt(x.starts_at, x.duration_min) > startsAt) || null;
}
// "Tue, Sep 29 at 12:00 PM" for emails and messages, from a local wall-clock string.
function whenText(startsAt) {
  const d = new Date(startsAt + ':00Z');
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${day} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`;
}

module.exports = { endAt, bookedBetween, clashIn, whenText };
