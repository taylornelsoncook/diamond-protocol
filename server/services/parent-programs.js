// Parent Programs tab helpers: camp spots, what the family already has, and membership change requests.
// Families can't change, pause or cancel a membership themselves; they ask here, the owners are emailed and
// the request shows in Recent activity, and the Programs tab shows it was sent.
'use strict';
const { db, get, all, insert } = require('../db');
const { bad, sendEmail, businessName } = require('../lib');
const { nowLocal } = require('./booking');

db.exec(`
CREATE TABLE IF NOT EXISTS membership_requests (
  id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES athletes(id), membership_id INTEGER REFERENCES memberships(id),
  parent_id INTEGER REFERENCES parents(id), kind TEXT NOT NULL CHECK (kind IN ('change','pause','cancel')),
  plan_id INTEGER REFERENCES plans(id), note TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS membership_requests_athlete ON membership_requests(athlete_id);
`);

const KINDS = { change: 'switch plans', pause: 'pause', cancel: 'cancel' };
const NOTE_MAX = 500;
const PER_DAY = 3; // requests per athlete in 24 hours

// Spots left in a camp: the tightest remaining day (null when the camp has no cap).
function campSpots(classId) {
  const r = get(`SELECT MIN(e.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status='booked')) AS left, COUNT(*) AS n
    FROM events e WHERE e.class_id=? AND e.cancelled=0 AND e.starts_at>=? AND e.capacity IS NOT NULL AND e.capacity>0`, classId, nowLocal());
  return r?.n ? Math.max(0, r.left) : null;
}

// Other athletes in the family registered for a camp ("Ben is registered").
function siblingsRegistered(classId, familyId, athleteId) {
  return all(`SELECT DISTINCT a.first_name FROM bookings b JOIN events e ON e.id=b.event_id JOIN athletes a ON a.id=b.athlete_id
    WHERE e.class_id=? AND a.family_id=? AND a.id<>? AND a.archived=0 AND b.coverage='registered' AND b.status='booked' ORDER BY a.first_name`, classId, familyId, athleteId).map((r) => r.first_name);
}

// The next session of a weekly class, and (for a held spot) how many upcoming sessions the athlete is booked into.
function classNext(classId, athleteId) {
  const now = nowLocal();
  const next = get('SELECT MIN(starts_at) s FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=?', classId, now)?.s || null;
  const mine = get(`SELECT MIN(e.starts_at) s, COUNT(*) n FROM bookings b JOIN events e ON e.id=b.event_id
    WHERE e.class_id=? AND b.athlete_id=? AND b.status='booked' AND e.cancelled=0 AND e.starts_at>=?`, classId, athleteId, now);
  return { next_at: next, my_next_at: mine?.s || null, my_upcoming: mine?.n || 0 };
}

function lastRequest(athleteId) {
  const r = get(`SELECT r.id, r.kind, r.plan_id, r.note, r.created_at, p.name AS plan_name FROM membership_requests r LEFT JOIN plans p ON p.id=r.plan_id
    WHERE r.athlete_id=? AND r.created_at >= datetime('now','-14 days') ORDER BY r.id DESC LIMIT 1`, athleteId);
  return r || null;
}

// Validate and record a request; emails every active owner. Returns the saved request.
function request({ athlete, membership, parent, kind, plan_id, note }) {
  if (!KINDS[kind]) throw bad('Choose switch plans, pause or cancel.');
  if (!membership) throw bad(`${athlete.first_name} doesn't have a membership to change.`);
  const text = String(note ?? '').trim().replace(/\r\n/g, '\n');
  if (text.length > NOTE_MAX) throw bad(`Keep the note under ${NOTE_MAX} characters.`);
  let plan = null;
  if (kind === 'change') {
    plan = get('SELECT id, name, price_cents FROM plans WHERE id=? AND active=1', Number(plan_id) || 0);
    if (!plan) throw bad('Pick the plan to switch to.');
    if (plan.id === membership.plan_id) throw bad(`${athlete.first_name} is already on ${plan.name}.`);
  }
  const recent = get("SELECT COUNT(*) n FROM membership_requests WHERE athlete_id=? AND created_at >= datetime('now','-1 day')", athlete.id).n;
  if (recent >= PER_DAY) throw bad('You have sent a few requests today. The front desk will reply by email.');
  const id = insert('membership_requests', { athlete_id: athlete.id, membership_id: membership.id, parent_id: parent.id, kind, plan_id: plan?.id || null, note: text || null });
  const what = kind === 'change' ? `switch ${athlete.first_name} from ${membership.plan_name} to ${plan.name}` : `${KINDS[kind]} ${athlete.first_name}'s ${membership.plan_name} membership`;
  const owners = all("SELECT name, email FROM staff WHERE role='owner' AND active=1 AND email IS NOT NULL AND email<>''");
  for (const o of owners) {
    sendEmail(o.email, `Membership request: ${athlete.first_name} ${athlete.last_name}`,
      `Hi ${String(o.name || '').split(' ')[0] || 'there'},\n\n${parent.name} (${parent.email}) asked to ${what}.${text ? `\n\nTheir note:\n${text}` : ''}\n\n`
      + `Make the change on ${athlete.first_name}'s client profile, then reply to ${parent.email} to confirm.\n\n${businessName()}`);
  }
  return { ...lastRequest(athlete.id), id, what };
}

module.exports = { campSpots, siblingsRegistered, classNext, lastRequest, request, KINDS, NOTE_MAX };
