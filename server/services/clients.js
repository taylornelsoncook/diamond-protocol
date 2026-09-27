// Clients: schema added after launch (athlete phone and grad year, staff notes on a client) and the read helpers
// the client list and profile share (visit history, notes a role may see). Loaded by routes and seeds, so an
// existing database upgrades in place on start.
'use strict';
const { db, get, all } = require('../db');
const { bad } = require('../lib');

const athleteCols = all('PRAGMA table_info(athletes)').map((c) => c.name);
if (!athleteCols.includes('phone')) db.exec('ALTER TABLE athletes ADD COLUMN phone TEXT');
if (!athleteCols.includes('grad_year')) db.exec('ALTER TABLE athletes ADD COLUMN grad_year INTEGER');

// Dated notes staff leave on a client ("Mom called: out for two weeks"). Pinned notes show at the top of the
// profile for everyone; coach-only notes are hidden from the front desk.
db.exec(`CREATE TABLE IF NOT EXISTS client_notes (
  id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES athletes(id), staff_id INTEGER REFERENCES staff(id),
  staff_name TEXT, body TEXT NOT NULL, pinned INTEGER DEFAULT 0, coach_only INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS client_notes_athlete ON client_notes(athlete_id);`);

// Grad year: a four-digit class year a few years either side of now (baseball recruiting uses it everywhere).
function gradYear(v) {
  if (v == null || v === '') return null;
  const n = Number(v), y = new Date().getFullYear();
  if (!Number.isInteger(n) || n < y - 30 || n > y + 20) throw bad('Enter the grad year as four digits, like 2029.');
  return n;
}

function notesFor(athleteId, staff) {
  const coachSide = staff.role !== 'frontdesk';
  return all(`SELECT id, body, pinned, coach_only, staff_id, staff_name, created_at FROM client_notes
    WHERE athlete_id=? ${coachSide ? '' : 'AND coach_only=0'} ORDER BY pinned DESC, id DESC LIMIT 50`, athleteId)
    .map((n) => ({ ...n, pinned: !!n.pinned, coach_only: !!n.coach_only, mine: n.staff_id === staff.id, can_delete: n.staff_id === staff.id || staff.role === 'owner' }));
}

// Visits: past booked sessions. Attended = checked in; no-show = booked, not checked in, and the session is over
// (someone in a session that's still running may just not be checked in yet).
function visits(athleteId, nowLocal) {
  const today = nowLocal.slice(0, 10);
  const day = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const ended = "strftime('%Y-%m-%dT%H:%M', e.starts_at, '+' || COALESCE(e.duration_min, 60) || ' minutes')";
  const past = `FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND e.cancelled=0 AND e.starts_at<?`;
  const count = (extra, since) => get(`SELECT COUNT(*) n ${past} ${extra} AND e.starts_at>=?`, athleteId, nowLocal, ...(extra.includes('?') ? [nowLocal] : []), since).n;
  const attended = "AND b.status='booked' AND b.checked_in_at IS NOT NULL";
  const noShow = `AND b.status='booked' AND b.checked_in_at IS NULL AND ${ended}<=?`;
  const history = all(`SELECT b.id, b.status, b.coverage, b.checked_in_at, e.id AS event_id, e.name, e.starts_at, e.type
    ${past} AND (b.status='late_cancel' OR (b.status='booked' AND (b.checked_in_at IS NOT NULL OR ${ended}<=?))) ORDER BY e.starts_at DESC LIMIT 12`, athleteId, nowLocal, nowLocal)
    .map((r) => ({ ...r, outcome: r.status === 'late_cancel' ? 'late_cancel' : r.checked_in_at ? 'attended' : 'no_show' }));
  return {
    summary: {
      visits_30: count(attended, day(30)), no_shows_30: count(noShow, day(30)), late_cancels_30: count("AND b.status='late_cancel'", day(30)),
      visits_90: count(attended, day(90)),
      last_visit: get(`SELECT MAX(b.checked_in_at) t FROM bookings b WHERE b.athlete_id=? AND b.status='booked'`, athleteId)?.t || null,
    },
    history,
  };
}

module.exports = { gradYear, notesFor, visits };
