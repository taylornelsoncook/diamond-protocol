// A coach's own calendar feed (version 84): one private address per staff member for Apple, Google or Outlook calendar,
// with the sessions they lead (the owner: every session) from two weeks back to three months ahead. Only a hash of the
// secret is stored; the address is shown once when made, and a reset makes a new one so the old stops at once. The feed
// has session names, times, places, the coach and how many are booked: no athlete names, no money.
import { token, HttpError } from '../util.js';
import { getSetting } from './families.js';
import { hashCal, icsText, icsTime, fold } from './portal.js';
import { listSessions } from './schedule.js';

export const status = (user) => ({ on: !!user.calendar_token_hash, created_at: user.calendar_created_at ?? null });
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
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
