import { newId, token, v, notFound, conflict, HttpError, ageOn } from '../util.js';
import { getSetting } from './families.js';
import { getSession, listSessions, book } from './schedule.js';
import { sendEmail } from './mail.js';
import { textFamily } from './sms.js';
import { emit } from './events.js';

// Filling light classes. A group class or clinic starting in the next 2 days with open spots and nobody waiting shows
// on Today with how many families fit it. A coach sends offers with one tap (or, with the open_spot_offers setting on
// 'auto', the hourly job sends them in the daytime). Each family gets an email, and a text if they turned texts on,
// with a link (/spot/<token>) that books without signing in. First to tap gets the spot; after that the link says so.
//
// Families who fit: an athlete the right age, not already on the session, and one of: came to this class in the last
// 60 days, has a membership, or came to anything in the last 45 days. Regulars of the class go first. No family with an
// open deletion request, no stopped email address, and at most 2 offers a family a day.

const WINDOW_HOURS = 48, MIN_LEAD_HOURS = 2, PER_SPOT = 4, MAX_PER_ROUND = 30, FAMILY_DAILY = 2;
const KINDS = ['group', 'clinic'];
const first = (name) => String(name ?? '').split(' ')[0];
const when = (ctx, iso) => new Intl.DateTimeFormat('en-US', { timeZone: getSetting(ctx, 'timezone'), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const hoursFrom = (iso, h) => new Date(Date.parse(iso) + h * 3600000).toISOString();
const daysBefore = (iso, d) => new Date(Date.parse(iso) - d * 86400000).toISOString();

// Sessions a parent can book a single spot in (not camps sold as a whole).
const bookable = (s) => KINDS.includes(s.kind) && !(s.registration_cents != null && s.drop_in_cents == null && s.series_id);
function lightSessions(ctx, asOf) {
  return listSessions(ctx, { from: hoursFrom(asOf, MIN_LEAD_HOURS), to: hoursFrom(asOf, WINDOW_HOURS) })
    .filter((s) => bookable(s) && s.spots_left > 0 && s.waitlist_count === 0);
}

// The families who fit a session, regulars of the class first. Each with the athletes who fit.
export function candidates(ctx, s, asOf = ctx.now()) {
  const kids = ctx.db.all(`SELECT c.id, c.name, c.birth_date, c.family_id FROM clients c JOIN families f ON f.id = c.family_id
    WHERE c.name != 'Deleted athlete' AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM data_requests d WHERE d.family_id = c.family_id AND d.kind = 'delete' AND d.status = 'open')
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = ? AND b.client_id = c.id AND b.status IN ('booked','attended','waitlisted'))
      AND NOT EXISTS (SELECT 1 FROM spot_offers o WHERE o.session_id = ? AND o.family_id = c.family_id)`, s.id, s.id);
  const fitsAge = (c) => {
    if (s.age_min == null && s.age_max == null) return true;
    const age = ageOn(c.birth_date, s.starts_at);
    return age != null && (s.age_min == null || age >= s.age_min) && (s.age_max == null || age <= s.age_max);
  };
  const rank = (c) => {
    if (s.series_id && ctx.db.get(`SELECT 1 FROM bookings b JOIN class_sessions x ON x.id = b.session_id WHERE b.client_id = ? AND x.series_id = ? AND b.status = 'attended' AND x.starts_at >= ?`, c.id, s.series_id, daysBefore(asOf, 60))) return 0;
    if (ctx.db.get(`SELECT 1 FROM subscriptions WHERE client_id = ? AND status IN ('active','trialing','past_due')`, c.id)) return 1;
    if (ctx.db.get(`SELECT 1 FROM bookings b JOIN class_sessions x ON x.id = b.session_id WHERE b.client_id = ? AND b.status = 'attended' AND x.starts_at >= ?`, c.id, daysBefore(asOf, 45))) return 2;
    return null;
  };
  const byFamily = new Map();
  for (const c of kids) {
    if (!fitsAge(c)) continue;
    const r = rank(c);
    if (r == null) continue;
    const f = byFamily.get(c.family_id) ?? { family_id: c.family_id, rank: r, athletes: [] };
    f.rank = Math.min(f.rank, r);
    f.athletes.push({ id: c.id, name: c.name });
    byFamily.set(c.family_id, f);
  }
  const today = daysBefore(asOf, 1);
  return [...byFamily.values()]
    .filter((f) => ctx.db.get('SELECT COUNT(*) AS n FROM spot_offers WHERE family_id = ? AND sent_at >= ?', f.family_id, today).n < FAMILY_DAILY)
    .sort((a, b) => a.rank - b.rank);
}

function offerStats(ctx, sessionId) {
  const r = ctx.db.get('SELECT COUNT(*) AS sent, COUNT(opened_at) AS opened, COUNT(booked_at) AS booked, MAX(sent_at) AS last_sent FROM spot_offers WHERE session_id = ?', sessionId);
  return { sent: r.sent, opened: r.opened, booked: r.booked, last_sent_at: r.last_sent };
}

// Today: light sessions and how many families could fill them.
export function openSpots(ctx, asOf = ctx.now()) {
  const mode = getSetting(ctx, 'open_spot_offers');
  if (mode === 'off') return { mode, data: [] };
  return { mode, data: lightSessions(ctx, asOf).map((s) => ({ id: s.id, name: s.name, kind: s.kind, starts_at: s.starts_at, location_name: s.location_name,
    capacity: s.capacity, booked: s.booked_count, spots_left: s.spots_left, families_who_fit: candidates(ctx, s, asOf).length, offers: offerStats(ctx, s.id) })) };
}

// Send offers for one session: up to 4 families per open spot (30 at most), best fits first.
export async function sendOffers(ctx, sessionId, { actor, asOf = ctx.now() } = {}) {
  const s = getSession(ctx, sessionId);
  if (!bookable(s)) throw conflict('Offers are for group classes and clinics that sell single spots.');
  if (s.status !== 'scheduled' || s.starts_at <= hoursFrom(asOf, MIN_LEAD_HOURS)) throw conflict('This session starts too soon for offers.');
  if (s.spots_left <= 0) throw conflict('This session is full.');
  if (s.waitlist_count > 0) throw conflict('Families are on the waitlist; they get open spots first.');
  const who = candidates(ctx, s, asOf).slice(0, Math.min(MAX_PER_ROUND, s.spots_left * PER_SPOT));
  const biz = getSetting(ctx, 'business_name');
  let sent = 0;
  for (const f of who) {
    const guardian = ctx.db.get('SELECT name, email FROM guardians WHERE family_id = ? AND email IS NOT NULL AND email NOT IN (SELECT email FROM email_optouts) ORDER BY is_primary DESC, created_at LIMIT 1', f.family_id);
    const tok = token(16), link = `${ctx.publicUrl ?? ''}/spot/${tok}`;
    const names = f.athletes.map((a) => first(a.name)).join(' or ');
    ctx.db.run('INSERT INTO spot_offers (id, token, session_id, family_id, client_ids, sent_to, sent_by, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId('spot'), tok, s.id, f.family_id, f.athletes.map((a) => a.id).join(','), guardian?.email ?? null, actor ?? 'Automatic', ctx.now());
    if (guardian) await sendEmail(ctx, { to: guardian.email, subject: `Open spot: ${s.name}, ${when(ctx, s.starts_at)}`,
      text: `Hi ${first(guardian.name)},\n\n${s.name} at ${s.location_name} on ${when(ctx, s.starts_at)} has ${s.spots_left === 1 ? 'one open spot' : `${s.spots_left} open spots`}, and we thought of ${names}.\n\nFirst to grab it gets it. Book in one tap, no sign-in needed:\n${link}\n\nCan't make it? No need to reply.\n\n${biz}` });
    textFamily(ctx, f.family_id, 'open_spot', `Open spot for ${names}: ${s.name}, ${when(ctx, s.starts_at)}. First to book gets it: ${link}`);
    sent++;
  }
  if (sent) emit(ctx, 'spots.offered', { session_id: s.id, session_name: s.name, starts_at: s.starts_at, families: sent, spots_left: s.spots_left });
  return { session_id: s.id, sent, families_left: Math.max(0, candidates(ctx, s, asOf).length), offers: offerStats(ctx, s.id) };
}

// Hourly, with open_spot_offers on 'auto': sessions starting in the next 30 hours that haven't had offers in 12 hours,
// between 10 am and 7 pm.
export async function runSlotFilling(ctx, { asOf = ctx.now() } = {}) {
  if (getSetting(ctx, 'open_spot_offers') !== 'auto') return 0;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: getSetting(ctx, 'timezone'), hour: 'numeric', hourCycle: 'h23' }).format(new Date(asOf)));
  if (hour < 10 || hour >= 19) return 0;
  let sent = 0;
  for (const s of lightSessions(ctx, asOf).filter((x) => x.starts_at <= hoursFrom(asOf, 30))) {
    const last = offerStats(ctx, s.id).last_sent_at;
    if (last && last > hoursFrom(asOf, -12)) continue;
    sent += (await sendOffers(ctx, s.id, { asOf }).catch(() => ({ sent: 0 }))).sent;
  }
  return sent;
}

// ---------- The family's page ----------
function byToken(ctx, tok) {
  const o = ctx.db.get('SELECT * FROM spot_offers WHERE token = ?', String(tok ?? ''));
  if (!o) throw notFound('Offer');
  return o;
}
export function publicOffer(ctx, tok) {
  const o = byToken(ctx, tok);
  if (!o.opened_at) ctx.db.run('UPDATE spot_offers SET opened_at = ? WHERE id = ?', ctx.now(), o.id);
  const s = getSession(ctx, o.session_id);
  const ids = o.client_ids.split(',');
  const athletes = ids.map((id) => ctx.db.get('SELECT id, name FROM clients WHERE id = ?', id)).filter(Boolean).map((c) => {
    const b = ctx.db.get(`SELECT status FROM bookings WHERE session_id = ? AND client_id = ? AND status IN ('booked','attended','waitlisted')`, s.id, c.id);
    return { id: c.id, first_name: first(c.name), status: b?.status ?? null };
  });
  const fam = ctx.db.get('SELECT waiver_version, card_last4, card_payment_method FROM families WHERE id = ?', o.family_id);
  const status = s.status !== 'scheduled' ? 'canceled' : s.starts_at <= ctx.now() ? 'started' : athletes.some((a) => a.status === 'booked') ? 'booked' : s.spots_left <= 0 ? 'full' : 'open';
  return { business_name: getSetting(ctx, 'business_name'), status,
    session: { name: s.name, starts_at: s.starts_at, ends_at: s.ends_at, location_name: s.location_name, spots_left: s.spots_left, drop_in_cents: s.drop_in_cents ?? null },
    athletes, timezone: getSetting(ctx, 'timezone'), waiver_signed: fam?.waiver_version != null && Number(fam.waiver_version) === Number(getSetting(ctx, 'waiver_version')), card_last4: fam?.card_payment_method ? fam.card_last4 : null };
}
// Book from the offer. The family's usual cover applies (membership, a pack, or pay with the family card).
export async function bookOffer(ctx, tok, body = {}) {
  const o = byToken(ctx, tok);
  const view = publicOffer(ctx, tok);
  if (view.status === 'canceled') throw conflict('This session was canceled.');
  if (view.status === 'started') throw conflict('This session has already started.');
  if (view.status === 'full') throw conflict('Sorry, that spot was just taken. We\'ll let you know next time one opens.');
  const clientId = v.str(body.athlete_id, 'athlete_id');
  if (!o.client_ids.split(',').includes(clientId)) throw notFound('Athlete');
  if (!view.waiver_signed) throw new HttpError(409, 'waiver_required', 'Sign the waiver in the parent portal first (Family tab), then come back to this link.');
  const b = await book(ctx, { sessionId: o.session_id, clientId, pay: body.pay === 'card_on_file' ? 'card_on_file' : undefined, actor: 'Open spot offer' });
  if (b.status === 'booked') ctx.db.run('UPDATE spot_offers SET booking_id = ?, booked_at = ? WHERE id = ?', b.id, ctx.now(), o.id);
  return { ...publicOffer(ctx, tok), booked: b.status === 'booked', waitlisted: b.status === 'waitlisted', coverage: b.coverage,
    message: b.status === 'booked' ? `${first(b.client_name)} is booked for ${b.session_name}.${b.coverage === 'paid' ? ` ${money(view.session.drop_in_cents)} was charged to the card ending ${view.card_last4}.` : ''}` : `The last spot was just taken, so ${first(b.client_name)} is on the waitlist.` };
}
