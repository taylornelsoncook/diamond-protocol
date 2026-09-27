// Floor operations helpers: session lists with counts, local dates for UTC timestamps, athlete lookups.
'use strict';
const { db, get, all, setting } = require('../db');
const { ageOn } = require('../lib');

// Schedule schema added after launch: time off (a coach away, or the whole facility closed), a staff-only
// note on a session, and the class day a moved session stands for. Both upgrade existing databases in place on start.
db.exec(`CREATE TABLE IF NOT EXISTS time_off (
  id INTEGER PRIMARY KEY, coach_id INTEGER REFERENCES staff(id), -- NULL = the whole facility is closed
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, note TEXT, created_at TEXT DEFAULT (datetime('now')));`);
const eventCols = all('PRAGMA table_info(events)').map((c) => c.name);
if (!eventCols.includes('staff_note')) db.exec('ALTER TABLE events ADD COLUMN staff_note TEXT');
// A class session moved to another day keeps the day it stands for, so the weekly job doesn't make it again.
if (!eventCols.includes('slot_date')) db.exec('ALTER TABLE events ADD COLUMN slot_date TEXT');

// Is this coach (or everyone) off on this local date? Off days offer no private or evaluation times.
function isTimeOff(coachId, date) {
  return !!get('SELECT 1 FROM time_off WHERE ? BETWEEN start_date AND end_date AND (coach_id IS NULL OR coach_id IS ?)', date, coachId ?? null);
}

// "2026-09-26 18:03:11" (UTC, SQLite) or ISO → local "YYYY-MM-DD" in the business time zone.
function localDateOf(ts) {
  if (!ts) return null;
  const s = String(ts);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  let tz = setting('timezone', 'America/Denver');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = 'America/Denver'; }
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const EVENT_COLS = `e.*, l.name AS location, l.address AS location_address, s.name AS coach,
  (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='booked') AS booked,
  (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='waitlist') AS waitlisted,
  (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='booked' AND b.checked_in_at IS NOT NULL) AS checked_in,
  (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='booked' AND b.coverage='unpaid') AS unpaid,
  (SELECT COUNT(*) FROM athletes a WHERE e.team_id IS NOT NULL AND a.team_id=e.team_id AND a.archived=0) AS team_size`;

// Sessions whose date falls between from and to (inclusive, "YYYY-MM-DD").
function eventsBetween(from, to, { includeCancelled = true } = {}) {
  return all(`SELECT ${EVENT_COLS} FROM events e LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN staff s ON s.id=e.coach_id
    WHERE substr(e.starts_at,1,10) BETWEEN ? AND ? ${includeCancelled ? '' : 'AND e.cancelled=0'} ORDER BY e.starts_at, e.id`, from, to);
}
function eventById(id) {
  return get(`SELECT ${EVENT_COLS} FROM events e LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN staff s ON s.id=e.coach_id WHERE e.id=?`, id);
}

// Everything a roster row needs about an athlete: age, family, first parent phone, medical flags, card on file.
function athleteCard(a, on) {
  const fam = a.family_id ? get('SELECT id,name,card_brand,card_last4,waiver_version FROM families WHERE id=?', a.family_id) : null;
  const parent = a.family_id ? get('SELECT name, phone, email FROM parents WHERE family_id=? ORDER BY is_self DESC, id LIMIT 1', a.family_id) : null;
  return {
    id: a.id, code: a.code, first_name: a.first_name, last_name: a.last_name, age: ageOn(a.birthday, on), team_id: a.team_id,
    family: fam?.name || null, family_id: fam?.id || null, card: fam?.card_last4 ? { brand: fam.card_brand, last4: fam.card_last4 } : null,
    parent_name: parent?.name || null, parent_phone: parent?.phone || a.emergency_phone || null,
    allergies: a.allergies || null, injuries: a.injuries || null, medical_notes: a.medical_notes || null,
    waiver_missing: !!fam && Number(fam.waiver_version || 0) < Number(setting('waiver_version', 1)),
    birthday_today: !!(a.birthday && on && String(a.birthday).slice(5, 10) === String(on).slice(5, 10)),
  };
}

const fullName = (a) => (a ? `${a.first_name} ${a.last_name}` : '');

module.exports = { localDateOf, eventsBetween, eventById, athleteCard, fullName, isTimeOff };
