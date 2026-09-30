// Today's floor: who is coming in and who is here (one-tap check-in), what each session is doing now, birthdays this
// week, follow-ups on athletes and check-ins, and the recent activity feed with filters. No money for coaches and front
// desk: "unpaid" is a flag, never an amount (hideMoney also strips any amount from what they read).
import { localDate, zonedToUtc, addDaysToDate, ageOn, badRequest, v } from '../util.js';
import { getSetting } from './families.js';
import { listSessions, isBirthday } from './schedule.js';
import { recentFlags } from './engage.js';
import { atRisk, activeSnoozes } from './insights.js';
import { programsActivity } from './programs.js';
import { OWNER_EVENTS, LEAD_EVENTS } from './security.js';

const BIRTHDAY_DAYS = 7;

// Session state against the clock: done, live (running now), next (the first still to start), later.
function withState(sessions, now) {
  let nextSet = false;
  return sessions.map((s) => {
    let state = 'later';
    if (s.ends_at <= now) state = 'done';
    else if (s.starts_at <= now) state = 'live';
    else if (!nextSet) { state = 'next'; nextSet = true; }
    return { ...s, state };
  });
}
// Door order: still to arrive for a session that hasn't ended, then no-shows and not-here from sessions already over,
// then those checked in.
const arrivalRank = (r) => (r.status === 'attended' ? 2 : r.state === 'done' ? 1 : 0);

// The roster's training week (the training calendar): who is behind (two planned workouts missed in a row) and the totals.
function trainingWeek(ctx) {
  const act = programsActivity(ctx, {});
  return { ...act.week, on_programs: act.on_programs, behind_athletes: act.behind.slice(0, 8) };
}
export function todayBoard(ctx, { role = 'owner' } = {}) {
  const zone = getSetting(ctx, 'timezone'), now = ctx.now(), today = localDate(now, zone);
  const dayStart = zonedToUtc(today, '00:00', zone), dayEnd = zonedToUtc(addDaysToDate(today, 1), '00:00', zone);
  const sessions = withState(listSessions(ctx, { from: dayStart, to: dayEnd }), now);
  const tomorrowList = listSessions(ctx, { from: dayEnd, to: zonedToUtc(addDaysToDate(today, 2), '00:00', zone) });
  const snoozes = activeSnoozes(ctx);
  const hidden = new Set(snoozes.map((z) => z.key));

  // Daily check-ins with red flags (today or yesterday), saying whether the athlete trains today.
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const trainsToday = (clientId) => {
    const b = sessions.length ? ctx.db.get(`SELECT session_id FROM bookings WHERE client_id = ? AND status IN ('booked','attended') AND session_id IN (${sessions.map(() => '?').join(',')})`, clientId, ...sessions.map((s) => s.id)) : null;
    return b ? byId.get(b.session_id) : null;
  };
  const archived = new Set(ctx.db.all('SELECT id FROM clients WHERE archived_at IS NOT NULL').map((r) => r.id));
  const flags = recentFlags(ctx).filter((f) => !archived.has(f.client_id)).map((f) => {
    const s = trainsToday(f.client_id);
    return { ...f, key: `flag:${f.client_id}:${f.date}`, today: f.date === today, session: s ? { id: s.id, name: s.name, starts_at: s.starts_at } : null };
  }).filter((f) => !hidden.has(f.key));
  const flagsBy = new Map(flags.filter((f) => f.today).map((f) => [f.client_id, f.flags]));

  // Everyone booked into today's sessions, for one-tap check-in, with what the door should know.
  const waiver = Number(getSetting(ctx, 'waiver_version'));
  const ids = sessions.map((s) => s.id);
  const arrivals = !ids.length ? [] : ctx.db.all(`SELECT b.id AS booking_id, b.session_id, b.status, b.coverage, c.id AS client_id, c.name, c.athlete_id, c.birth_date, c.medical_notes, c.family_id, f.waiver_version
      FROM bookings b JOIN clients c ON c.id = b.client_id LEFT JOIN families f ON f.id = c.family_id
      WHERE b.status IN ('booked','attended','no_show') AND b.session_id IN (${ids.map(() => '?').join(',')})`, ...ids)
    .map((r) => {
      const s = byId.get(r.session_id);
      return {
        booking_id: r.booking_id, session_id: r.session_id, session_name: s.name, starts_at: s.starts_at, ends_at: s.ends_at, state: s.state, location_name: s.location_name,
        client_id: r.client_id, name: r.name, athlete_id: r.athlete_id, status: r.status,
        medical: r.medical_notes?.trim() || null, no_waiver: !!r.family_id && Number(r.waiver_version ?? 0) !== waiver, unpaid: r.coverage === 'unpaid',
        birthday: isBirthday(r.birth_date, today), flags: flagsBy.get(r.client_id) ?? []
      };
    }).sort((x, y) => arrivalRank(x) - arrivalRank(y) || x.starts_at.localeCompare(y.starts_at) || x.name.localeCompare(y.name));

  // Birthdays in the next week among current athletes (families and team rosters), soonest first.
  const days = Array.from({ length: BIRTHDAY_DAYS }, (_, i) => addDaysToDate(today, i));
  const birthdays = ctx.db.all(`SELECT c.id, c.name, c.birth_date FROM clients c WHERE c.archived_at IS NULL AND c.athlete_id IS NOT NULL AND c.birth_date IS NOT NULL
      AND (c.family_id IS NOT NULL OR EXISTS (SELECT 1 FROM team_roster r WHERE r.client_id = c.id AND r.active = 1))`)
    .map((c) => { const d = days.find((x) => isBirthday(c.birth_date, x)); return d ? { client_id: c.id, name: c.name, date: d, today: d === today, turning: ageOn(c.birth_date, `${d}T12:00:00Z`) } : null; })
    .filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  const out = {
    date: today, now, timezone: zone, sessions, arrivals, birthdays, flags,
    tomorrow: { date: addDaysToDate(today, 1), sessions: tomorrowList.length, first_at: tomorrowList[0]?.starts_at ?? null, booked: tomorrowList.reduce((t, s) => t + s.booked_count, 0) }
  };
  out.training = trainingWeek(ctx);
  // Follow-ups (owners and coaches): athletes to check on, and what was followed up lately (Undo / Bring back).
  if (role !== 'front_desk') {
    out.follow_ups = atRisk(ctx, { role, hideSnoozed: true, limit: 8 });
    out.followed_up = snoozes;
  }
  return out;
}

// ---------- Recent activity ----------
// Newest first, a page at a time (before: the cursor from the last page). filter narrows it to one kind of activity;
// money is the owner's only, and owner-only events (payments, refunds, school contracts) never reach anyone else.
const FILTERS = {
  checkins: /^session\.checked_in$/,
  bookings: /^(booking\.|session\.(canceled|messaged)$|enrollment\.|spots\.)/,
  training: /^(workout\.|program\.|badge\.|course\.)/,
  testing: /^(results\.|performance\.|testing\.|queue\.|integration\.|progress_note\.)/,
  clients: /^(client\.|clients\.|family\.|leads?\.)/,
  money: /^(invoice\.|sale\.|subscription\.|team_invoice\.|team_contract\.|pay_link\.|purchase\.|payment\.|money_check\.)/
};
export function activity(ctx, { role = 'owner', filter, before, limit = 20 } = {}) {
  if (filter !== undefined && filter !== '' && !FILTERS[filter]) throw badRequest(`filter must be one of ${Object.keys(FILTERS).join(', ')}.`);
  if (filter === 'money' && role !== 'owner') throw badRequest('Money activity is for the owner.');
  const n = v.int(limit, 'limit', { min: 1, max: 100 });
  let cursor = null;
  if (before) {
    const m = /^(.+)~(\d+)$/.exec(String(before));
    if (!m) throw badRequest('before must be the next value from the last page.');
    cursor = { at: m[1], row: Number(m[2]) };
  }
  const re = filter ? FILTERS[filter] : null;
  const out = [];
  let last = cursor;
  // Read in chunks until a page is full: filtered-out and owner-only rows are skipped here, not in SQL.
  for (let guard = 0; out.length < n && guard < 50; guard++) {
    const rows = last
      ? ctx.db.all('SELECT rowid AS row, * FROM events WHERE created_at < ? OR (created_at = ? AND rowid < ?) ORDER BY created_at DESC, rowid DESC LIMIT 200', last.at, last.at, last.row)
      : ctx.db.all('SELECT rowid AS row, * FROM events ORDER BY created_at DESC, rowid DESC LIMIT 200');
    if (!rows.length) { last = null; break; }
    for (const r of rows) {
      last = { at: r.created_at, row: r.row };
      if (role !== 'owner' && OWNER_EVENTS.test(r.type)) continue;
      if (role === 'coach' && LEAD_EVENTS.test(r.type)) continue;           // coaches see only the leads given to them (Leads)
      if (re && !re.test(r.type)) continue;
      out.push({ id: r.id, type: r.type, data: JSON.parse(r.data), created_at: r.created_at });
      if (out.length === n) break;
    }
    if (rows.length < 200 && out.length < n) { last = null; break; }
  }
  return { data: out, next: out.length === n && last ? `${last.at}~${last.row}` : null, filters: Object.keys(FILTERS).filter((k) => k !== 'money' || role === 'owner') };
}
