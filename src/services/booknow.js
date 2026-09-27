import { localDate, addDaysToDate, zonedToUtc } from '../util.js';
import { getSetting } from './families.js';
import { listSessions, openSlots } from './schedule.js';

// The public "Book now" page (/book), for the website, Instagram and Google. It shows what's coming up with open
// spots and the next evaluation times, and sends families to the parent portal to book (or to sign up first).
// No names or bookings are shown, only counts. Owners can turn it off in settings (public_schedule).

const DAYS = 14;
export function publicSchedule(ctx) {
  const on = getSetting(ctx, 'public_schedule') !== 'off';
  const base = { business_name: getSetting(ctx, 'business_name'), timezone: getSetting(ctx, 'timezone'), signup_open: getSetting(ctx, 'public_signup') === 'on', open: on };
  if (!on) return { ...base, classes: [], evaluations: [] };
  const zone = base.timezone, from = ctx.now(), to = zonedToUtc(addDaysToDate(localDate(from, zone), DAYS + 1), '00:00', zone);
  const classes = listSessions(ctx, { from, to }).filter((s) => ['group', 'clinic', 'camp'].includes(s.kind)).map((s) => ({
    id: s.id, name: s.name, kind: s.kind, starts_at: s.starts_at, ends_at: s.ends_at, location_name: s.location_name,
    spots_left: s.spots_left, age_min: s.age_min ?? null, age_max: s.age_max ?? null,
    drop_in_cents: s.drop_in_cents ?? null, registration_cents: s.registration_cents ?? null
  }));
  // The next few evaluation times, at most three a day so one open afternoon doesn't fill the page.
  // Two coaches free at the same time and place are one time on this page (the portal picks the coach).
  const perDay = {}, seen = new Set();
  const evaluations = openSlots(ctx, { kind: 'evaluation', days: DAYS }).filter((s) => { const k = `${s.starts_at} ${s.location_id}`; if (seen.has(k)) return false; seen.add(k); const d = localDate(s.starts_at, zone); perDay[d] = (perDay[d] ?? 0) + 1; return perDay[d] <= 3; })
    .slice(0, 12).map((s) => ({ starts_at: s.starts_at, location_name: s.location_name, price_cents: s.price_cents ?? null }));
  return { ...base, classes, evaluations };
}
