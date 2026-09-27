// Clients: schema added after launch (athlete phone and grad year, staff notes on a client) and the read helpers
// the client list and profile share (visit history, notes a role may see). Loaded by routes and seeds, so an
// existing database upgrades in place on start.
'use strict';
const { db, get, all, insert, tx } = require('../db');
const { bad, HttpError, emit, sendEmail, makeAthleteCode, randomToken, today, appUrl, businessName } = require('../lib');

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

// ---- New client: the athlete, the family and parent login, the plan and the program, in one step. ----
// Used by New client (routes/20-clients) and by converting a CRM lead (services/crm), so both follow the same rules.
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) throw bad('Enter the athlete\'s first and last name.');
  return [parts[0], parts.slice(1).join(' ')];
}
function athleteNames(b) {
  if (b.first_name || b.last_name) {
    const f = clean(b.first_name), l = clean(b.last_name);
    if (!f || !l) throw bad('Enter the athlete\'s first and last name.');
    return [f, l];
  }
  return splitName(b.name);
}
const validDate = (d) => (d == null || d === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d ? d : (() => { throw bad('Use a real date.'); })());
const birthDate = (d) => {
  const v = validDate(d);
  if (v && v > today()) throw bad('The birthday is in the future. Check the year.');
  if (v && v < '1900-01-01') throw bad('That birthday is too long ago. Check the year.');
  return v;
};
const sex = (s) => (s === 'M' || s === 'F' ? s : null);

function welcomeParent(p, athleteFirst) {
  const self = p.is_self;
  sendEmail(p.email, `Your ${businessName()} account`,
    `Hi ${p.name.split(' ')[0]},\n\n${self ? 'Your account is ready.' : `${athleteFirst}'s account is ready.`} Sign in to the parent portal to sign the waiver, add a card and book sessions:\n\n${appUrl()}/parent\n\nUse this email address (${p.email}). We'll email you a one-time code; there's no password to remember.\n\n${businessName()}`);
}

function createAthlete(familyId, b, extra = {}) {
  const [first, last] = athleteNames(b);
  const id = insert('athletes', {
    code: makeAthleteCode(first, last), family_id: familyId, first_name: first, last_name: last,
    email: clean(b.email)?.toLowerCase() || null, birthday: birthDate(b.birthday), sex: sex(b.sex), sport: clean(b.sport), position: clean(b.position), school: clean(b.school),
    phone: clean(b.phone), grad_year: gradYear(b.grad_year),
    allergies: clean(b.allergies), injuries: clean(b.injuries), emergency_name: clean(b.emergency_name), emergency_phone: clean(b.emergency_phone),
    workout_token: randomToken(12), ...extra,
  });
  return get('SELECT * FROM athletes WHERE id=?', id);
}

// b: the New client form. opts.role is the staff role (the front desk can't assign programs);
// opts.siblings adds more athletes to the same family (a lead with two kids); opts.inTx runs extra work in the same transaction.
function createClient(b, { role, siblings = [], inTx = null } = {}) {
  const billing = require('./billing');
  const withParent = b.with_parent !== false && b.with_parent !== 'false';
  const [first, last] = athleteNames(b);
  const planId = b.plan_id ? Number(b.plan_id) : null;
  const programId = b.program_id ? Number(b.program_id) : null;
  let parent;
  if (withParent) {
    parent = { name: clean(b.parent_name), email: clean(b.parent_email)?.toLowerCase(), phone: clean(b.parent_phone), is_self: 0 };
    if (!parent.name) throw bad('Enter the parent or guardian\'s name.');
    if (!EMAIL_RE.test(parent.email || '')) throw bad('Enter the parent\'s email. It\'s how they sign in.');
  } else {
    parent = { name: `${first} ${last}`, email: clean(b.email)?.toLowerCase(), phone: clean(b.phone), is_self: 1 };
    if (!EMAIL_RE.test(parent.email || '')) throw bad('Enter their email. It\'s how they sign in.');
  }
  const existing = get(`SELECT p.family_id, f.name AS family, a.id AS athlete_id, a.first_name, a.last_name FROM parents p JOIN families f ON f.id=p.family_id
    LEFT JOIN athletes a ON a.id=(SELECT id FROM athletes WHERE family_id=p.family_id ORDER BY archived, id LIMIT 1) WHERE p.email=?`, parent.email);
  if (existing) {
    throw bad(`That email already has a portal login (${existing.family}). Open ${existing.first_name ? `${existing.first_name} ${existing.last_name}` : 'that family'} and use Add sibling.`,
      existing.athlete_id ? { existing: { athlete_id: existing.athlete_id, name: `${existing.first_name} ${existing.last_name}`, family: existing.family, family_id: existing.family_id } } : undefined);
  }
  if (planId && !get('SELECT 1 FROM plans WHERE id=? AND active=1', planId)) throw bad('Choose a plan.');
  if (programId && role === 'frontdesk') throw new HttpError(403, 'Only coaches and owners assign programs. Leave it for a coach.');
  if (programId && !get('SELECT 1 FROM programs WHERE id=? AND archived=0', programId)) throw bad('Choose a program.');
  gradYear(b.grad_year);
  const sibNames = siblings.map((x) => athleteNames(x));
  // Same name (and the same birthday, when both are known) is probably someone already on file.
  if (b.allow_duplicate !== true) {
    const bd = birthDate(b.birthday);
    const dup = all(`SELECT id, code, first_name, last_name, birthday, archived FROM athletes WHERE first_name=? COLLATE NOCASE AND last_name=? COLLATE NOCASE
      ${bd ? 'AND (birthday IS NULL OR birthday=?)' : ''} ORDER BY archived, id LIMIT 3`, first, last, ...(bd ? [bd] : []));
    if (dup.length) {
      throw new HttpError(409, `${first} ${last} may already be a client (${dup.map((d) => d.code + (d.archived ? ', archived' : '')).join('; ')}). Open them, or create the account anyway.`,
        { duplicates: dup.map((d) => ({ id: d.id, code: d.code, name: `${d.first_name} ${d.last_name}`, birthday: d.birthday, archived: !!d.archived })) });
    }
  }

  const out = tx(() => {
    const familyId = insert('families', { name: `${withParent ? parent.name.split(' ').slice(-1)[0] : last} family` });
    const parentId = insert('parents', { family_id: familyId, ...parent });
    const a = createAthlete(familyId, { ...b, first_name: first, last_name: last, email: withParent ? b.athlete_email : parent.email, phone: withParent ? b.athlete_phone : parent.phone },
      programId ? { program_id: programId, program_started: today() } : {});
    const more = siblings.map((x, i) => createAthlete(familyId, { ...x, first_name: sibNames[i][0], last_name: sibNames[i][1] }));
    let membership = null;
    if (planId) membership = billing.startMembership(a.id, planId);
    const extra = inTx ? inTx({ athlete: a, familyId, parentId, siblings: more }) : null;
    return { a, familyId, parentId, membership, more, extra };
  });
  const { a, familyId, membership, more } = out;
  welcomeParent(parent, first);
  for (const x of [a, ...more]) emit('client.created', { athlete_id: x.id, athlete_code: x.code, first_name: x.first_name, last_name: x.last_name, family_id: familyId, ...(x === a ? { parent_email: parent.email } : { sibling: true }) });
  if (programId) emit('program.assigned', { athlete_id: a.id, athlete_code: a.code, program_id: programId });
  return { athlete: a, siblings: more, familyId, parentId: out.parentId, parent, membership, extra: out.extra };
}

module.exports = { gradYear, notesFor, visits, EMAIL_RE, athleteNames, birthDate, validDate, sex, welcomeParent, createAthlete, createClient };
