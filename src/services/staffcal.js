// A coach's own calendar feed (version 84): one private address per staff member for Apple, Google or Outlook calendar,
// with the sessions they lead (the owner: every session) from two weeks back to three months ahead. Only a hash of the
// secret is stored; the address is shown once when made, and a reset makes a new one so the old stops at once. The feed
// has session names, times, places, the coach and how many are booked: no athlete names, no money.
import { getSetting } from './families.js';
import { hashCal, icsText, icsTime, fold } from './portal.js';
import { listSessions, openSlots } from './schedule.js';
import { token, HttpError, localDate, weekdayOf, addDaysToDate, zonedToUtc, notFound } from '../util.js';

export const status = (user) => ({ on: !!user.calendar_token_hash, created_at: user.calendar_created_at ?? null });
// A coach the owner makes a link for (owner's ask: "a link per coach"): an active owner or coach, never front desk.
export function coachFor(ctx, id) {
  const u = ctx.db.get(`SELECT * FROM users WHERE id = ? AND active = 1 AND role IN ('owner','coach')`, id);
  if (!u) throw notFound('Coach');
  return u;
}
export const coachStatus = (ctx, user) => ({ ...status(user), coach_id: user.id, coach_name: user.name, role: user.role });
export function reset(ctx, user, baseUrl) {
  const secret = token(24);
  ctx.db.run('UPDATE users SET calendar_token_hash = ?, calendar_created_at = ? WHERE id = ?', hashCal(`staff:${secret}`), ctx.now(), user.id);
  const url = `${baseUrl ?? ctx.publicUrl ?? ''}/cal/staff/${secret}.ics`;
  return { on: true, created_at: ctx.now(), url, webcal: url.replace(/^https?:/, 'webcal:') };
}
export function stop(ctx, user) {
  ctx.db.run('UPDATE users SET calendar_token_hash = NULL, calendar_created_at = NULL WHERE id = ?', user.id);
  return { on: false, created_at: null };
}
export function feed(ctx, secret, host = 'diamondprotocol') {
  const gone = new HttpError(404, 'not_found', 'This calendar link was reset or turned off. Get the new one on the Schedule page.');
  if (typeof secret !== 'string' || !/^[\w-]{20,64}$/.test(secret)) throw gone;
  const u = ctx.db.get(`SELECT id, name, role, active FROM users WHERE calendar_token_hash = ? AND active = 1 AND role IN ('owner','coach')`, hashCal(`staff:${secret}`));
  if (!u) throw gone;
  const from = new Date(Date.parse(ctx.now()) - 14 * 86400000).toISOString(), to = new Date(Date.parse(ctx.now()) + 92 * 86400000).toISOString();
  const rows = listSessions(ctx, { from, to, coachId: u.role === 'owner' ? undefined : u.id });
  const hours = openHours(ctx, u);
  const places = new Map(ctx.db.all('SELECT id, name, address_line1, city, state, postal_code FROM locations').map((l) => [l.id, { name: l.name, address: [l.address_line1, [l.city, l.state].filter(Boolean).join(', '), l.postal_code].filter(Boolean).join(', ') }]));
  const biz = getSetting(ctx, 'business_name');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${icsText(biz)}//Coach dashboard//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(u.role === 'owner' ? `${biz} schedule` : `${biz}: ${u.name}`)}`, 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const s of rows) {
    const l = places.get(s.location_id), place = [l?.name ?? s.location_name, l?.address].filter(Boolean).join(', ');
    lines.push('BEGIN:VEVENT', `UID:${s.id}@${host}`, `DTSTAMP:${icsTime(ctx.now())}`, `DTSTART:${icsTime(s.starts_at)}`, `DTEND:${icsTime(s.ends_at)}`,
      `SUMMARY:${icsText(`${s.name} (${s.booked_count}/${s.capacity})`)}`, `LOCATION:${icsText(place)}`,
      `DESCRIPTION:${icsText([`Coach: ${s.coach_name ?? 'no coach set'}`, `${s.booked_count} of ${s.capacity} booked${s.waitlist_count ? `, ${s.waitlist_count} waitlisted` : ''}`, `Roster: ${ctx.publicUrl ?? ''}/#/schedule/${s.id}`].join('\n'))}`,
      'STATUS:CONFIRMED', 'END:VEVENT');
  }
  // Bookable hours (owner's ask: the hours families book on their own): one entry per block of hours per day, marked
  // free time so it never blocks the coach's own calendar, with how many slots are still open and the Book now link.
  const bookUrl = `${ctx.publicUrl ?? ''}/book`;
  for (const hb of hours) {
    const l = places.get(hb.location_id), place = [l?.name ?? hb.location_name, l?.address].filter(Boolean).join(', ');
    const what = hb.kind === 'evaluation' ? 'evaluations' : 'privates';
    lines.push('BEGIN:VEVENT', `UID:${hb.availability_id}-${hb.date}@${host}`, `DTSTAMP:${icsTime(ctx.now())}`, `DTSTART:${icsTime(hb.starts_at)}`, `DTEND:${icsTime(hb.ends_at)}`,
      `SUMMARY:${icsText(`Open for ${what}: ${hb.open} of ${hb.slots} ${hb.slots === 1 ? 'slot' : 'slots'} open`)}`, `LOCATION:${icsText(place)}`,
      `DESCRIPTION:${icsText([`${hb.slot_minutes}-minute ${what}${hb.coach_name ? ` with ${hb.coach_name}` : ''}`, `${hb.open} of ${hb.slots} ${hb.slots === 1 ? 'slot' : 'slots'} still open. Families book them on their own; each booking shows up here as a session.`, `Book now page: ${bookUrl}`].join('\n'))}`,
      'TRANSP:TRANSPARENT', 'STATUS:CONFIRMED', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
// The coach's blocks of bookable hours over the next 92 days (the owner: everyone's), each with the slots still open
// from the same count the Book now page and the portal use (openSlots).
const HOURS_DAYS = 92;
export function openHours(ctx, u) {
  const zone = getSetting(ctx, 'timezone'), today = localDate(ctx.now(), zone);
  const blocks = ctx.db.all(`SELECT a.*, l.name AS location_name, cu.name AS coach_name FROM availability a JOIN locations l ON l.id = a.location_id LEFT JOIN users cu ON cu.id = a.coach_id
    WHERE ${u.role === 'owner' ? '1 = 1' : 'a.coach_id = ?'}`, ...(u.role === 'owner' ? [] : [u.id]));
  if (!blocks.length) return [];
  const off = ctx.db.all('SELECT user_id, start_date, end_date FROM time_off WHERE end_date >= ? AND start_date <= ?', today, addDaysToDate(today, HOURS_DAYS));
  const isOff = (a, d) => off.some((t) => t.start_date <= d && t.end_date >= d && (t.user_id == null || t.user_id === a.coach_id));
  const open = new Map();   // availability id + date → open slots
  for (const kind of ['private', 'evaluation']) {
    if (!blocks.some((b) => b.kind === kind)) continue;
    for (const s of openSlots(ctx, { kind, days: HOURS_DAYS })) { const k = `${s.availability_id}|${localDate(s.starts_at, zone)}`; open.set(k, (open.get(k) ?? 0) + 1); }
  }
  const out = [];
  for (let d = today, i = 0; i <= HOURS_DAYS; d = addDaysToDate(d, 1), i++) {
    for (const a of blocks) {
      if (a.weekday !== weekdayOf(d) || isOff(a, d)) continue;
      const starts = zonedToUtc(d, a.start_time, zone), ends = zonedToUtc(d, a.end_time, zone);
      const slots = Math.floor((Date.parse(ends) - Date.parse(starts)) / (a.slot_minutes * 60000));
      out.push({ availability_id: a.id, date: d, kind: a.kind, starts_at: starts, ends_at: ends, slot_minutes: a.slot_minutes, slots, open: Math.min(slots, open.get(`${a.id}|${d}`) ?? 0),
        location_id: a.location_id, location_name: a.location_name, coach_id: a.coach_id ?? null, coach_name: a.coach_name ?? null });
    }
  }
  return out;
}
