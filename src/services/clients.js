import { newId, token, v, notFound, conflict, badRequest, HttpError } from '../util.js';
import { emit } from './events.js';
import * as billing from './billing.js';
import * as programs from './programs.js';
import { createFamilyWithGuardian, athleteFields, payerFor, getFamily, getSetting } from './families.js';
import { newAthleteId, validateAthleteId } from './athlete-ids.js';
import { welcomeFamily, welcomeClient, sendAppLink } from './notify.js';
import { clientBookings, endEnrollment, cancelBooking } from './schedule.js';

const LIST_SQL = `
  SELECT c.id, c.athlete_id, c.name, c.email, c.phone, c.created_at, c.archived_at, c.archived_by, c.family_id, f.name AS family_name, c.birth_date, c.sport,
    c.school, c.grad_year, TRIM(COALESCE(c.medical_notes, '')) != '' AS medical, f.waiver_version,
    (SELECT GROUP_CONCAT(x, char(30)) FROM (SELECT g.name || char(31) || g.email || char(31) || COALESCE(g.phone, '') AS x FROM guardians g WHERE g.family_id = c.family_id ORDER BY g.is_primary DESC, g.created_at)) AS parent_list,
    (SELECT MAX(k.created_at) FROM check_ins k WHERE k.client_id = c.id) AS last_check_in_at,
    MAX(COALESCE((SELECT MAX(x.starts_at) FROM bookings b JOIN class_sessions x ON x.id = b.session_id WHERE b.client_id = c.id AND b.status = 'attended'), ''),
      COALESCE((SELECT MAX(x.starts_at) FROM team_attendance ta JOIN team_roster t ON t.id = ta.roster_id JOIN class_sessions x ON x.id = ta.session_id WHERE t.client_id = c.id), '')) AS last_attended_at,
    (SELECT GROUP_CONCAT(tc.id || '|' || o.name || ' ' || tc.name, char(10)) FROM team_roster t JOIN team_contracts tc ON tc.id = t.contract_id JOIN organizations o ON o.id = tc.org_id
      WHERE t.client_id = c.id AND t.active = 1 AND tc.status = 'active') AS team_list,
    (SELECT COUNT(*) FROM client_notes n WHERE n.client_id = c.id AND n.pinned = 1) AS pinned_all,
    (SELECT COUNT(*) FROM client_notes n WHERE n.client_id = c.id AND n.pinned = 1 AND n.coach_only = 0) AS pinned_shared,
    s.id AS subscription_id, s.status AS subscription_status, s.current_period_end, s.trial_ends_at,
    p.id AS plan_id, p.name AS plan_name, p.price_cents,
    a.program_id, pr.name AS program_name,
    (SELECT MAX(completed_at) FROM workout_logs l WHERE l.client_id = c.id) AS last_workout_at,
    (SELECT COALESCE(SUM(delta), 0) FROM session_credits k WHERE k.client_id = c.id AND k.credit_type = 'private') AS private_credits,
    (SELECT COALESCE(SUM(delta), 0) FROM session_credits k WHERE k.client_id = c.id AND k.credit_type = 'group') AS group_credits,
    COALESCE(f.card_payment_method, c.card_payment_method) IS NOT NULL AS has_card
  FROM clients c
  LEFT JOIN subscriptions s ON s.id = (SELECT id FROM subscriptions WHERE client_id = c.id ORDER BY (status = 'canceled'), created_at DESC LIMIT 1)
  LEFT JOIN plans p ON p.id = s.plan_id
  LEFT JOIN assignments a ON a.client_id = c.id AND a.active = 1
  LEFT JOIN programs pr ON pr.id = a.program_id
  LEFT JOIN families f ON f.id = c.family_id`;

const shape = (r, waiverVersion = 1, role = 'owner') => ({
  id: r.id, athlete_id: r.athlete_id, name: r.name, email: r.email ?? null, phone: r.phone ?? null, created_at: r.created_at,
  family: r.family_id ? { id: r.family_id, name: r.family_name } : null,
  birth_date: r.birth_date ?? null, sport: r.sport ?? null,
  status: r.subscription_status ?? 'none',
  subscription: r.subscription_id ? {
    id: r.subscription_id, status: r.subscription_status, plan_id: r.plan_id, plan_name: r.plan_name,
    price_cents: r.price_cents, current_period_end: r.current_period_end, trial_ends_at: r.trial_ends_at
  } : null,
  program: r.program_id ? { id: r.program_id, name: r.program_name } : null,
  last_workout_at: r.last_workout_at ?? null,
  credits: { private: r.private_credits ?? 0, group: r.group_credits ?? 0 },
  session_credits: (r.private_credits ?? 0) + (r.group_credits ?? 0),
  has_card: !!r.has_card,
  archived_at: r.archived_at ?? null, archived_by: r.archived_by ?? null,
  school: r.school ?? null, grad_year: r.grad_year ?? null,
  // Parents (primary first) with their contact details, so the list can search and call them.
  parents: r.parent_list ? r.parent_list.split('\x1e').map((x) => { const [name, email, phone] = x.split('\x1f'); return { name, email, phone: phone || null }; }) : [],
  teams: r.team_list ? r.team_list.split('\n').map((x) => { const [id, ...name] = x.split('|'); return { id, name: name.join('|') }; }) : [],
  // Flags for the list: medical notes on file, the family's waiver isn't signed (current version), no saved card.
  flags: { medical: !!r.medical, no_waiver: !!r.family_id && Number(r.waiver_version ?? 0) !== waiverVersion, no_card: !r.has_card },
  // Pinned staff notes: front desk never counts coach-only ones.
  pinned_notes: role === 'front_desk' ? r.pinned_shared ?? 0 : r.pinned_all ?? 0,
  // Last seen: the latest check-in (desk, door, kiosk or roster) or logged workout.
  last_visit_at: [r.last_check_in_at, r.last_attended_at].filter(Boolean).sort().pop() ?? null,
  last_seen_at: [r.last_check_in_at, r.last_attended_at, r.last_workout_at].filter(Boolean).sort().pop() ?? null,
});
const shapeAll = (ctx, rows, role) => { const wv = Number(getSetting(ctx, 'waiver_version')); return rows.map((r) => shape(r, wv, role)); };

// "Active client" means one thing everywhere (the Today metric, the client list's Active filter, the owner summary):
// not archived, with a membership that is paid up or on a free trial.
export const ACTIVE_STATUSES = ['active', 'trialing'];
export const isActiveClient = (c) => !c.archived_at && ACTIVE_STATUSES.includes(c.status);
// Search: name, Athlete ID, email, family, school, or any parent's name, email or phone. Phone numbers also match on
// their digits, so 8015550142 or (801) 555-0142 find 801-555-0142.
const digitsOf = (x) => String(x ?? '').replace(/\D/g, '');
export function matches(c, q) {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) return true;
  const text = [c.name, c.email, c.athlete_id, c.family?.name, c.school, c.phone, ...c.parents.flatMap((p) => [p.name, p.email, p.phone])].filter(Boolean).join(' ').toLowerCase();
  if (text.includes(s)) return true;
  const d = digitsOf(s);
  return /^[\d\s().+-]+$/.test(s) && d.length >= 4 && [c.phone, ...c.parents.map((p) => p.phone)].some((p) => digitsOf(p).includes(d));
}

// Views on top of the membership statuses: team (on a school or club team roster, no membership) and no_waiver
// (the family hasn't signed the current waiver). They count current clients only; archived clients are their own view.
export const CLIENT_VIEWS = ['current', 'active', 'trialing', 'past_due', 'paused', 'canceled', 'none', 'team', 'no_waiver'];
export function inView(c, view) {
  if (!view) return true;
  if (view === 'current') return isActiveClient(c);
  if (view === 'team') return c.teams.length > 0 && ['none', 'canceled'].includes(c.status);
  if (view === 'no_waiver') return c.flags.no_waiver;
  return c.status === view;
}
export const CLIENT_SORTS = ['name', 'last_seen', 'newest'];
const sorters = {
  name: null,
  last_seen: (a, b) => (a.last_seen_at ?? '').localeCompare(b.last_seen_at ?? '') || a.name.localeCompare(b.name),   // longest since seen first, never seen at the top
  newest: (a, b) => b.created_at.localeCompare(a.created_at)
};

// Archived clients are left out unless asked for: archived=true lists only them, archived=all everyone.
// status=current is the active clients above; team and no_waiver are the views above; any other status is the membership
// status (none = no membership). sort: name (default), last_seen (longest since seen first) or newest.
export function listClients(ctx, { q, status, archived, sort, role } = {}) {
  if (sort && !CLIENT_SORTS.includes(sort)) throw badRequest(`sort must be one of ${CLIENT_SORTS.join(', ')}.`);
  let rows = shapeAll(ctx, ctx.db.all(`${LIST_SQL} ORDER BY c.name COLLATE NOCASE`), role);
  if (q) rows = rows.filter((c) => matches(c, q));
  if (archived === 'true') rows = rows.filter((c) => c.archived_at);
  else if (archived !== 'all') rows = rows.filter((c) => !c.archived_at);
  if (status) rows = rows.filter((c) => !c.archived_at && inView(c, status));
  if (sorters[sort]) rows.sort(sorters[sort]);
  return rows;
}
// How many archived clients a search would have found, so the list can say where to look.
export const archivedMatches = (ctx, q) => shapeAll(ctx, ctx.db.all(`${LIST_SQL} WHERE c.archived_at IS NOT NULL`)).filter((c) => !q || matches(c, q)).length;
export function clientCounts(ctx) {
  const out = { current: 0, active: 0, trialing: 0, past_due: 0, paused: 0, canceled: 0, none: 0, team: 0, no_waiver: 0, archived: 0, total: 0 };
  for (const c of shapeAll(ctx, ctx.db.all(LIST_SQL))) {
    if (c.archived_at) { out.archived++; continue; }
    out.total++;
    out[c.status] = (out[c.status] ?? 0) + 1;
    if (isActiveClient(c)) out.current++;
    if (inView(c, 'team')) out.team++;
    if (c.flags.no_waiver) out.no_waiver++;
  }
  return out;
}

// The current view as a spreadsheet (owner only): contact details, membership and last seen, never amounts. Cells a
// spreadsheet would run as a formula (=, +, -, @, tab or return first) get a leading apostrophe; plain numbers stay numbers.
const STATUS_LABEL = { active: 'Active', trialing: 'Trial', past_due: 'Past due', paused: 'Paused', canceled: 'Canceled', none: 'No plan' };
// US numbers saved for texts (+15125550100) read as (512) 555-0100, which a spreadsheet keeps as text.
const phoneText = (p) => (/^\+1\d{10}$/.test(p ?? '') ? `(${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}` : p);
export const csvCell = (x) => { let s = String(x ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function exportClients(ctx, query = {}) {
  const rows = listClients(ctx, query);
  const zone = getSetting(ctx, 'timezone');
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: zone }) : '');
  const head = ['Athlete ID', 'Name', 'Family', 'Parent', 'Parent email', 'Parent phone', 'Email', 'Phone', 'Birthday', 'Grad year', 'Sport', 'School', 'Status', 'Plan', 'Program', 'Teams', 'Waiver signed', 'Card on file', 'Medical notes on file', 'Last seen', 'Client since', 'Archived'];
  const lines = rows.map((c) => [c.athlete_id, c.name, c.family?.name, c.parents[0]?.name, c.parents[0]?.email, phoneText(c.parents[0]?.phone), c.email, phoneText(c.phone), c.birth_date, c.grad_year, c.sport, c.school,
    STATUS_LABEL[c.status] ?? c.status, c.subscription?.plan_name, c.program?.name, c.teams.map((t) => t.name).join('; '), c.family ? (c.flags.no_waiver ? 'No' : 'Yes') : '', c.has_card ? 'Yes' : 'No', c.flags.medical ? 'Yes' : 'No',
    day(c.last_seen_at), day(c.created_at), day(c.archived_at)]);
  const body = [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\r\n');
  return { filename: `clients-${day(ctx.now())}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(`\uFEFF${body}\r\n`), count: rows.length };
}

export function getClient(ctx, id, { withSecrets = false, role = 'owner' } = {}) {
  const r = ctx.db.get(`${LIST_SQL} WHERE c.id = ?`, id);
  if (!r) throw notFound('Client');
  const c = shapeAll(ctx, [r], role)[0];
  const extra = ctx.db.get('SELECT * FROM clients WHERE id = ?', id);
  const payer = payerFor(ctx, id);
  c.notes = extra.notes ?? null;
  c.card_status = payer.card_status;
  c.card = payer.card_payment_method ? { on_file: true, brand: payer.card_brand, last4: payer.card_last4, owner: payer.table === 'families' ? 'family' : 'client' } : { on_file: false, owner: payer.table === 'families' ? 'family' : 'client' };
  Object.assign(c, athleteFields({}, extra));
  if (c.family) {
    const fam = getFamily(ctx, c.family.id);
    c.family = { id: fam.id, name: fam.name, guardians: fam.guardians, waiver: fam.waiver,
      siblings: ctx.db.all('SELECT id, name FROM clients WHERE family_id = ? AND id != ? ORDER BY name', fam.id, id) };
  }
  c.workouts_completed = ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE client_id = ?', id).n;
  if (withSecrets) c.app_link = `/app?token=${extra.access_token}`;
  return c;
}

// ---------- Archive: clients who stopped training ----------
// Hidden from lists, search, pickers and automatic messages; everything about them stays. A client with a membership
// can't be archived (cancel it first). Upcoming bookings and standing spots are canceled, but only once confirmed.
export async function archiveClient(ctx, id, body = {}, actor) {
  const c = getClient(ctx, id);
  const first = c.name.split(' ')[0];
  if (c.archived_at) throw conflict(`${first} is already archived.`);
  const sub = ctx.db.get(`SELECT status FROM subscriptions WHERE client_id = ? AND status != 'canceled' ORDER BY created_at DESC LIMIT 1`, id);
  if (sub) throw conflict(`${first} has a membership (${sub.status.replace('_', ' ')}). Cancel it first, then archive.`);
  const upcoming = clientBookings(ctx, id, { upcoming: true, limit: 500 });
  // Every open enrollment is ended; only ones with days still to come are worth asking about (a camp from last summer isn't).
  const enrolled = ctx.db.all(`SELECT e.series_id, e.kind, e.sale_id, s.name,
      EXISTS (SELECT 1 FROM class_sessions x WHERE x.series_id = s.id AND x.status = 'scheduled' AND x.starts_at > ?) AS upcoming
    FROM enrollments e JOIN class_series s ON s.id = e.series_id WHERE e.client_id = ? AND e.status = 'active'`, ctx.now(), id);
  const standing = enrolled.filter((x) => x.upcoming && x.kind !== 'registration'), camps = enrolled.filter((x) => x.upcoming && x.kind === 'registration');
  if ((upcoming.length || standing.length || camps.length) && body.confirm !== true) {
    const names = (xs) => xs.map((x) => x.name).join(', ');
    const parts = [upcoming.length ? `${upcoming.length} upcoming ${upcoming.length === 1 ? 'booking' : 'bookings'}` : null, standing.length ? `a standing spot in ${names(standing)}` : null, camps.length ? `a registration for ${names(camps)}` : null].filter(Boolean);
    const paidCamps = camps.filter((x) => x.sale_id);
    const e = new HttpError(409, 'confirm_required', `${first} has ${parts.join(' and ')}. Archiving cancels ${upcoming.length + standing.length + camps.length === 1 ? 'it' : 'them'} (credits go back, paid single sessions are refunded).${paidCamps.length ? ` The ${names(paidCamps)} registration fee isn't refunded automatically: the owner can refund it from the sale.` : ''}`);
    e.details = { bookings: upcoming.map((b) => ({ id: b.id, session_name: b.session_name, starts_at: b.starts_at, status: b.status })), standing: standing.map((x) => x.name), registrations: camps.map((x) => x.name) };
    throw e;
  }
  // Cancel, mark archived, then sweep once more: a booking a parent finished while refunds were going through is caught
  // here, and one that finishes after archived_at is set undoes itself (schedule.js#bookNow).
  const cancelAll = async () => {
    for (const e of ctx.db.all(`SELECT series_id FROM enrollments WHERE client_id = ? AND status = 'active'`, id)) await endEnrollment(ctx, e.series_id, id);
    for (const b of clientBookings(ctx, id, { upcoming: true, limit: 500 })) await cancelBooking(ctx, b.id, { isCoach: true, waive: true });
  };
  await cancelAll();
  ctx.db.run('UPDATE clients SET archived_at = ?, archived_by = ? WHERE id = ?', ctx.now(), actor?.name ?? 'API', id);
  await cancelAll();
  emit(ctx, 'client.archived', { client_id: id, client_name: c.name, bookings_canceled: upcoming.length, by: actor?.name ?? null });
  return getClient(ctx, id, { withSecrets: true });
}
export function restoreClient(ctx, id, actor) {
  const c = getClient(ctx, id);
  if (!c.archived_at) throw conflict(`${c.name.split(' ')[0]} isn't archived.`);
  ctx.db.run('UPDATE clients SET archived_at = NULL, archived_by = NULL WHERE id = ?', id);
  emit(ctx, 'client.restored', { client_id: id, client_name: c.name, by: actor?.name ?? null });
  return getClient(ctx, id, { withSecrets: true });
}

// ---------- Staff notes ----------
// Everyone on staff can add notes and change or delete their own; owners can delete any note and pin or unpin any.
// Coach-only notes are never shown to front desk, and front desk can't write them.
const staffActor = (actor) => actor ?? { id: null, name: 'API', role: 'owner' };
const shapeNote = (n) => ({ ...n, pinned: !!n.pinned, coach_only: !!n.coach_only });
export function listNotes(ctx, clientId, actor) {
  getClient(ctx, clientId);
  const hideCoachOnly = staffActor(actor).role === 'front_desk';
  return ctx.db.all(`SELECT * FROM client_notes WHERE client_id = ? ${hideCoachOnly ? 'AND coach_only = 0' : ''} ORDER BY pinned DESC, created_at DESC`, clientId).map(shapeNote);
}
function noteFor(ctx, id, actor) {
  const n = ctx.db.get('SELECT * FROM client_notes WHERE id = ?', id);
  if (!n || (n.coach_only && staffActor(actor).role === 'front_desk')) throw notFound('Note');
  return n;
}
const flag = (x, field) => { if (typeof x !== 'boolean') throw badRequest(`${field} must be true or false.`); return x; };
export function addNote(ctx, clientId, body, actor) {
  const a = staffActor(actor);
  getClient(ctx, clientId);
  const coachOnly = body.coach_only === undefined ? false : flag(body.coach_only, 'coach_only');
  if (coachOnly && a.role === 'front_desk') throw new HttpError(403, 'forbidden', 'Front desk can\'t write coach-only notes.');
  const id = newId('note');
  ctx.db.run('INSERT INTO client_notes (id, client_id, author_id, author_name, body, pinned, coach_only, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, clientId, a.id, a.name, v.str(body.body, 'body', { max: 4000 }), body.pinned === undefined ? false : flag(body.pinned, 'pinned'), coachOnly, ctx.now());
  return shapeNote(ctx.db.get('SELECT * FROM client_notes WHERE id = ?', id));
}
export function updateNote(ctx, id, body, actor) {
  const a = staffActor(actor), n = noteFor(ctx, id, actor);
  const mine = a.id != null ? n.author_id === a.id : a.role === 'owner' && n.author_id == null;
  const changes = Object.keys(body).filter((k) => ['body', 'pinned', 'coach_only'].includes(k));
  if (!changes.length) throw badRequest('Send body, pinned or coach_only.');
  if (!mine && !(a.role === 'owner' && changes.every((k) => k === 'pinned'))) throw new HttpError(403, 'forbidden', 'You can only change your own notes.');
  const coachOnly = body.coach_only === undefined ? !!n.coach_only : flag(body.coach_only, 'coach_only');
  if (coachOnly && a.role === 'front_desk') throw new HttpError(403, 'forbidden', 'Front desk can\'t write coach-only notes.');
  ctx.db.run('UPDATE client_notes SET body = ?, pinned = ?, coach_only = ?, updated_at = ? WHERE id = ?',
    body.body === undefined ? n.body : v.str(body.body, 'body', { max: 4000 }), body.pinned === undefined ? n.pinned : flag(body.pinned, 'pinned'), coachOnly, ctx.now(), id);
  return shapeNote(ctx.db.get('SELECT * FROM client_notes WHERE id = ?', id));
}
export function deleteNote(ctx, id, actor) {
  const a = staffActor(actor), n = noteFor(ctx, id, actor);
  if (a.role !== 'owner' && n.author_id !== a.id) throw new HttpError(403, 'forbidden', 'You can only delete your own notes. Ask the owner.');
  ctx.db.run('DELETE FROM client_notes WHERE id = ?', id);
  return { id, deleted: true };
}

// ---------- Duplicate checks (staff adding a client) ----------
// Before staff create an account: an email that already belongs to a client or a parent login is refused, with a link
// to that record (a parent login means "add a sibling to that family"). The same name with the same birthday (or no
// birthday on one side), or a phone number already on file, is probably someone we have: the answer lists them, and
// the account can be created anyway. Archived clients count, so an old client comes back instead of
// getting a second Athlete ID. The dashboard asks for that check with check_duplicates: true (an integration adding
// clients through the API isn't asked a question it can't answer, unless it sends it too); saying "create anyway"
// sends it again as false. Only staff get these details; the parent portal and public sign-up never do.
const normName = (x) => String(x ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const last10 = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);
const dupRow = (ctx, id, reason) => {
  const c = ctx.db.get('SELECT c.id, c.name, c.athlete_id, c.birth_date, c.archived_at, f.name AS family_name FROM clients c LEFT JOIN families f ON f.id = c.family_id WHERE c.id = ?', id);
  return { id: c.id, name: c.name, athlete_id: c.athlete_id, birth_date: c.birth_date ?? null, family_name: c.family_name ?? null, archived: !!c.archived_at, reason };
};
function checkDuplicates(ctx, { name, email, phone, birthDate, parent, familyId, skipSoft = false }) {
  if (email) {
    const c = ctx.db.get('SELECT id FROM clients WHERE email = ?', email);
    if (c) { const e = new HttpError(409, 'duplicate_email', `${email} already belongs to a client. Open their profile instead.`); e.details = { duplicates: [dupRow(ctx, c.id, 'email')] }; throw e; }
  }
  if (parent?.email) {
    const g = ctx.db.get('SELECT g.family_id, f.name AS family_name FROM guardians g JOIN families f ON f.id = g.family_id WHERE g.email = ?', String(parent.email).trim().toLowerCase());
    if (g) {
      const kid = ctx.db.get('SELECT id FROM clients WHERE family_id = ? ORDER BY archived_at IS NOT NULL, created_at LIMIT 1', g.family_id);
      const e = new HttpError(409, 'parent_exists', `${String(parent.email).trim()} already signs in for the ${g.family_name}. Add the athlete to that family instead, so they share one login and card.`);
      e.details = { family: { id: g.family_id, name: g.family_name }, duplicates: kid ? [dupRow(ctx, kid.id, 'parent_email')] : [] };
      throw e;
    }
  }
  if (skipSoft) return;
  const found = new Map();
  // Compared here rather than in SQL: SQLite's lower() only knows A-Z, and extra spaces inside a name shouldn't hide a match.
  for (const c of ctx.db.all('SELECT id, name, birth_date FROM clients')) {
    if (normName(c.name) === normName(name) && (!birthDate || !c.birth_date || c.birth_date === birthDate)) found.set(c.id, 'name');
  }
  // Phones: the athlete's own, and (for a new family) the parent's. A sibling shares the family's phone, so it's not checked.
  const phones = [phone, familyId ? null : parent?.phone].map(last10).filter((d) => d.length >= 7);
  if (phones.length) {
    for (const c of ctx.db.all(`SELECT c.id, c.family_id, c.phone, (SELECT GROUP_CONCAT(COALESCE(g.phone, ''), ' ') FROM guardians g WHERE g.family_id = c.family_id) AS parent_phones FROM clients c
        WHERE c.phone IS NOT NULL OR c.family_id IS NOT NULL`)) {
      if (found.has(c.id) || (familyId && c.family_id === familyId)) continue;
      const theirs = [c.phone, ...String(c.parent_phones ?? '').split(' ')].map(last10).filter((d) => d.length >= 7);
      if (phones.some((d) => theirs.includes(d))) found.set(c.id, 'phone');
    }
  }
  if (found.size) {
    const list = [...found].slice(0, 5).map(([id, reason]) => dupRow(ctx, id, reason));
    const e = new HttpError(409, 'possible_duplicate', list.length === 1
      ? `${list[0].name} (${list[0].athlete_id}${list[0].archived ? ', archived' : ''}) has the same ${list[0].reason === 'phone' ? 'phone number' : `name${birthDate && list[0].birth_date ? ' and birthday' : ''}`}. Open their profile, or create a new account anyway.`
      : `${list.length} clients look like the same person. Open one of them, or create a new account anyway.`);
    e.details = { duplicates: list };
    throw e;
  }
}

// Create the account, start the subscription (trial first if the plan has one) and assign a program.
// staff: { role } when staff add the client from the dashboard or the API: duplicates are checked (see above) and
// front desk can't assign a program (that's for coaches).
export async function createClient(ctx, body, { staff } = {}) {
  const name = v.str(body.name, 'name', { max: 120 });
  const hasParent = !!(body.family_id || body.parent);
  // Athletes with a parent account don't need their own email; adults paying for themselves do.
  const email = hasParent ? (body.email ? v.email(body.email) : null) : v.email(body.email);
  const phone = v.str(body.phone, 'phone', { max: 40, optional: true });
  const notes = v.str(body.notes, 'notes', { max: 2000, optional: true });
  const profile = athleteFields(body);
  if (body.plan_id) billing.getPlan(ctx, body.plan_id);
  if (body.program_id) programs.getProgram(ctx, body.program_id);
  if (body.family_id) getFamily(ctx, body.family_id);
  if (staff?.role === 'front_desk' && body.program_id) throw new HttpError(403, 'forbidden', 'Only coaches and owners assign programs. Leave it for a coach.');
  if (staff && body.check_duplicates !== undefined && typeof body.check_duplicates !== 'boolean') throw badRequest('check_duplicates must be true or false.');
  if (staff) checkDuplicates(ctx, { name, email, phone, birthDate: profile.birth_date, parent: body.family_id ? null : body.parent, familyId: body.family_id, skipSoft: body.check_duplicates !== true });
  if (email && ctx.db.get('SELECT id FROM clients WHERE email = ?', email)) throw conflict('A client with this email already exists.');

  const id = newId('cli');
  let newFamily = null;
  ctx.db.tx(() => {
    const familyId = body.family_id ?? (body.parent ? (newFamily = createFamilyWithGuardian(ctx, body.parent, body.family_name)) : null);
    ctx.db.run(`INSERT INTO clients (id, athlete_id, name, email, phone, notes, access_token, family_id, birth_date, sex, sport, position, school, grad_year, medical_notes, emergency_name, emergency_phone, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, newAthleteId(ctx, name), name, email, phone, notes, token(24), familyId, profile.birth_date, profile.sex, profile.sport, profile.position, profile.school, profile.grad_year, profile.medical_notes, profile.emergency_name, profile.emergency_phone, ctx.now());
    emit(ctx, 'client.created', { client_id: id, athlete_id: ctx.db.get('SELECT athlete_id FROM clients WHERE id = ?', id).athlete_id, client_name: name, email, family_id: familyId });
    if (body.program_id) programs.assign(ctx, body.program_id, id);
  });
  if (body.plan_id) await billing.subscribe(ctx, id, body.plan_id);
  // Welcome email: to the parents of a new family, or to an adult paying for themselves. Siblings don't trigger another.
  if (body.send_welcome !== false) {
    if (newFamily) await welcomeFamily(ctx, newFamily);
    else if (!body.family_id) await welcomeClient(ctx, id);
  }
  return getClient(ctx, id, { withSecrets: true });
}

export function updateClient(ctx, id, body) {
  const c = getClient(ctx, id);
  const name = body.name !== undefined ? v.str(body.name, 'name', { max: 120 }) : c.name;
  const email = body.email !== undefined ? (body.email === null || body.email === '' ? (c.family ? null : v.email(body.email)) : v.email(body.email)) : c.email;
  const phone = body.phone !== undefined ? v.str(body.phone, 'phone', { max: 40, optional: true }) : c.phone;
  const notes = body.notes !== undefined ? v.str(body.notes, 'notes', { max: 2000, optional: true }) : c.notes;
  const profile = athleteFields(body, c);
  if (body.card_status !== undefined) {
    if (!ctx.testMode) throw conflict('card_status can only be changed in test mode.');
    const payer = payerFor(ctx, id);
    ctx.db.run(`UPDATE ${payer.table} SET card_status = ? WHERE id = ?`, v.oneOf(body.card_status, 'card_status', ['ok', 'declining']), payer.id);
  }
  if (email && email !== c.email && ctx.db.get('SELECT id FROM clients WHERE email = ? AND id != ?', email, id)) throw conflict('A client with this email already exists.');
  if (body.athlete_id !== undefined && String(body.athlete_id).toUpperCase() !== c.athlete_id) ctx.db.run('UPDATE clients SET athlete_id = ? WHERE id = ?', validateAthleteId(ctx, body.athlete_id, { exceptClient: id }), id);
  ctx.db.run(`UPDATE clients SET name = ?, email = ?, phone = ?, notes = ?, birth_date = ?, sex = ?, sport = ?, position = ?, school = ?, grad_year = ?, medical_notes = ?, emergency_name = ?, emergency_phone = ? WHERE id = ?`,
    name, email, phone, notes, profile.birth_date, profile.sex, profile.sport, profile.position, profile.school, profile.grad_year, profile.medical_notes, profile.emergency_name, profile.emergency_phone, id);
  emit(ctx, 'client.updated', { client_id: id, client_name: name, email });
  return getClient(ctx, id, { withSecrets: true });
}

// Issue a new private app link; the old one stops working.
export function resetAppLink(ctx, id) {
  getClient(ctx, id);
  ctx.db.run('UPDATE clients SET access_token = ? WHERE id = ?', token(24), id);
  return getClient(ctx, id, { withSecrets: true });
}

export const clientByToken = (ctx, t) => (t ? ctx.db.get('SELECT * FROM clients WHERE access_token = ?', String(t)) : undefined);

// Email the private workout-app link to the athlete (their own email, if they have one) and their parents.
// Archived clients get nothing: bring them back first.
export async function emailAppLink(ctx, id) {
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', id);
  if (!c) throw notFound('Client');
  const first = c.name.split(' ')[0];
  if (c.archived_at) throw conflict(`${first} is archived. Bring them back before sending the app link.`);
  const sentTo = await sendAppLink(ctx, id);
  if (!sentTo.length) throw conflict(`There's no email to send it to. Add ${first}'s email${c.family_id ? ' or a parent\'s' : ''} first, or copy the link.`);
  return { sent_to: sentTo };
}

// ---------- Attendance ----------
// Visits are roster check-ins (desk, door code, tablet) and walk-in check-ins. A booking is a no-show when the roster
// says so, or when the session is over and nobody checked them in; one in a session that's still running isn't a
// no-show yet. A late cancel counts on the session's date, even when that's later today.
export function attendance(ctx, id) {
  getClient(ctx, id);
  const now = ctx.now(), daysAgo = (d) => new Date(Date.parse(now) - d * 86400000).toISOString();
  const since30 = daysAgo(30), since90 = daysAgo(90);
  const outcome = (b) => (b.status === 'attended' ? 'attended' : b.status === 'late_canceled' ? 'late_cancel' : b.status === 'no_show' || b.ends_at <= now ? 'no_show' : b.starts_at <= now ? 'in_progress' : null);
  const sessions = ctx.db.all(`SELECT b.id, b.status, s.id AS session_id, s.name AS session_name, s.kind, s.starts_at, s.ends_at, l.name AS location_name
      FROM bookings b JOIN class_sessions s ON s.id = b.session_id JOIN locations l ON l.id = s.location_id
      WHERE b.client_id = ? AND s.status = 'scheduled' AND s.starts_at >= ? AND b.status IN ('attended','no_show','booked','late_canceled')`, id, since90)
    .map((b) => ({ id: b.id, outcome: outcome(b), at: b.starts_at, session_id: b.session_id, session_name: b.session_name, kind: b.kind, location_name: b.location_name }))
    .filter((b) => b.outcome && (b.outcome === 'late_cancel' || b.at <= now));
  const walkIns = ctx.db.all(`SELECT k.id, k.created_at, l.name AS location_name FROM check_ins k JOIN locations l ON l.id = k.location_id WHERE k.client_id = ? AND k.created_at >= ?`, id, since90)
    .map((k) => ({ id: k.id, outcome: 'walk_in', at: k.created_at, session_id: null, session_name: null, kind: null, location_name: k.location_name }));
  // Team sessions: the coach ticks the team roster (team_attendance) instead of booking each athlete.
  const team = ctx.db.all(`SELECT ta.session_id, s.name AS session_name, s.kind, s.starts_at, l.name AS location_name
      FROM team_attendance ta JOIN team_roster t ON t.id = ta.roster_id JOIN class_sessions s ON s.id = ta.session_id JOIN locations l ON l.id = s.location_id
      WHERE t.client_id = ? AND s.status = 'scheduled' AND s.starts_at >= ? AND s.starts_at <= ?`, id, since90, now)
    .map((t) => ({ id: `team:${t.session_id}`, outcome: 'attended', at: t.starts_at, session_id: t.session_id, session_name: t.session_name, kind: t.kind, location_name: t.location_name }));
  const all = [...sessions, ...walkIns, ...team];
  const count = (since, ...outcomes) => all.filter((x) => outcomes.includes(x.outcome) && x.at >= since).length;
  const lastVisit = [ctx.db.get(`SELECT MAX(s.starts_at) AS t FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.status = 'attended'`, id).t,
    ctx.db.get('SELECT MAX(created_at) AS t FROM check_ins WHERE client_id = ?', id).t,
    ctx.db.get('SELECT MAX(s.starts_at) AS t FROM team_attendance ta JOIN team_roster t ON t.id = ta.roster_id JOIN class_sessions s ON s.id = ta.session_id WHERE t.client_id = ?', id).t].filter(Boolean).sort().pop() ?? null;
  return {
    summary: { visits_30: count(since30, 'attended', 'walk_in'), no_shows_30: count(since30, 'no_show'), late_cancels_30: count(since30, 'late_cancel'), visits_90: count(since90, 'attended', 'walk_in'), last_visit_at: lastVisit },
    recent: all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12)
  };
}
