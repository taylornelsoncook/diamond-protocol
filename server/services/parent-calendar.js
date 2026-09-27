// Calendar files for families: one session as an .ics file, and a private feed of every booking that
// phone calendars subscribe to (Apple, Google, Outlook refresh it on their own).
// Event times are local wall-clock in the business time zone; the files carry them in UTC so every calendar agrees.
'use strict';
const { get, all, run, setting } = require('../db');
const { randomToken, businessName } = require('../lib');

if (!all('PRAGMA table_info(families)').some((c) => c.name === 'calendar_token')) run('ALTER TABLE families ADD COLUMN calendar_token TEXT');
run('CREATE UNIQUE INDEX IF NOT EXISTS families_calendar_token ON families(calendar_token) WHERE calendar_token IS NOT NULL');

const tz = () => setting('timezone', 'America/Denver');

// Minutes the zone is ahead of UTC at a given instant.
function offsetMin(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 6e4;
}
// "2026-09-28T16:30" in the business zone -> UTC milliseconds (handles daylight saving on either side).
function localToUtc(local, zone = tz()) {
  const guess = Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), +local.slice(11, 13), +local.slice(14, 16));
  const first = guess - offsetMin(guess, zone) * 6e4;
  return guess - offsetMin(first, zone) * 6e4;
}
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const text = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 bytes are folded with CRLF + space (RFC 5545).
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// Rows need: booking id, status, athlete first_name, event name, starts_at, duration_min, location, address.
function vevent(r, url) {
  const start = localToUtc(r.starts_at);
  const wait = r.status === 'waitlist';
  return [
    'BEGIN:VEVENT',
    `UID:dp-booking-${r.id}@diamond-protocol`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(start + (r.duration_min || 60) * 6e4)}`,
    `SUMMARY:${text(`${wait ? 'Waitlist: ' : ''}${r.first_name}: ${r.name}`)}`,
    r.location ? `LOCATION:${text([r.location, r.address].filter(Boolean).join(', '))}` : null,
    `DESCRIPTION:${text(`${wait ? `${r.first_name} is on the waitlist. You'll get an email if a spot opens.\n` : ''}Booked with ${businessName()}. Manage bookings: ${url}`)}`,
    `STATUS:${wait ? 'TENTATIVE' : 'CONFIRMED'}`,
    'END:VEVENT',
  ].filter(Boolean);
}
function calendar(name, events, url, { feed = true } = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Diamond Protocol//Parent portal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...(feed ? [`X-WR-CALNAME:${text(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'] : []),
    ...events.flatMap((r) => vevent(r, url)),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

const ROWS = `SELECT b.id, b.status, a.first_name, e.name, e.starts_at, e.duration_min, l.name AS location, l.address
  FROM bookings b JOIN events e ON e.id=b.event_id JOIN athletes a ON a.id=b.athlete_id LEFT JOIN locations l ON l.id=e.location_id`;

// Every booking for the family from 30 days back, so a session doesn't vanish from the calendar the moment it ends.
function familyFeed(familyId, since, url) {
  const f = get('SELECT name FROM families WHERE id=?', familyId);
  const rows = all(`${ROWS} WHERE a.family_id=? AND a.archived=0 AND b.status IN ('booked','waitlist') AND e.cancelled=0 AND e.starts_at>=? ORDER BY e.starts_at, b.id`, familyId, since);
  return calendar(`${businessName()} · ${f?.name || 'Family'}`, rows, url);
}
function oneBooking(bookingId, familyId, url) {
  const r = get(`${ROWS} WHERE b.id=? AND a.family_id=? AND b.status IN ('booked','waitlist') AND e.cancelled=0`, bookingId, familyId);
  return r ? calendar(businessName(), [r], url, { feed: false }) : null;
}

function tokenFor(familyId, { reset = false } = {}) {
  const f = get('SELECT calendar_token FROM families WHERE id=?', familyId);
  if (f?.calendar_token && !reset) return { token: f.calendar_token, created: false };
  const token = randomToken(18);
  run('UPDATE families SET calendar_token=? WHERE id=?', token, familyId);
  return { token, created: true };
}
const familyByToken = (token) => (/^[\w-]{16,64}$/.test(token) ? get('SELECT id, name FROM families WHERE calendar_token=?', token) : null);

module.exports = { localToUtc, familyFeed, oneBooking, tokenFor, familyByToken, calendar };
