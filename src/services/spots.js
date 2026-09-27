import { newId, token, v, notFound, conflict, badRequest, HttpError, ageOn } from '../util.js';
import { getSetting } from './families.js';
import { getSession, listSessions, book } from './schedule.js';
import { sendEmail } from './mail.js';
import { textFamily } from './sms.js';
import { emit } from './events.js';

// Filling open spots. Today lists every class families book single spots in (group classes, clinics, and camp days
// sold by the day) with a spot left in the next 7 days, whoever leads it, with how many families fit it. A coach sends
// offers with one tap (or, with the open_spot_offers setting on 'auto', the hourly job sends them in the daytime for
// group classes and clinics in the last 30 hours). Each family gets an email, and a text if they turned texts on, with a
// link (/spot/<token>) that books without signing in. First to tap gets the spot; after that the link says so.
//
// Trial offers (owner only): the same link at a special price the owner picks ($0 = free). Booking from it charges that
// price to the family's card instead of the drop-in (or books it free); a membership that covers the class still covers
// it. The price lives on the offer row, so it applies to that one link and to nothing else.
//
// Families who fit: an athlete the right age, not already on the session, and one of: came to this class in the last
// 60 days, has a membership, or came to anything in the last 45 days. Regulars of the class go first. No family with an
// open deletion request, no stopped email address, and at most 2 offers a family a day.

const WINDOW_HOURS = 48, MIN_LEAD_HOURS = 2, PER_SPOT = 4, MAX_PER_ROUND = 30, FAMILY_DAILY = 2, LIST_DAYS = 7;
const TRIAL_MAX_CENTS = 20000;                    // a class with no drop-in price: trial offers up to $200
const AUTO_KINDS = ['group', 'clinic'];           // what the automatic job offers (unchanged)
const SPOT_KINDS = ['group', 'clinic', 'camp'];   // families book single spots in these; privates, evaluations and team sessions aren't listed
const first = (name) => String(name ?? '').split(' ')[0];
const when = (ctx, iso) => new Intl.DateTimeFormat('en-US', { timeZone: getSetting(ctx, 'timezone'), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const priceText = (c) => (c === 0 ? 'free' : money(c));
const hoursFrom = (iso, h) => new Date(Date.parse(iso) + h * 3600000).toISOString();
const daysBefore = (iso, d) => new Date(Date.parse(iso) - d * 86400000).toISOString();

// Sessions a parent can book a single spot in (not camps sold only as a whole).
const bookable = (s) => SPOT_KINDS.includes(s.kind) && !(s.registration_cents != null && s.drop_in_cents == null && s.series_id);
function lightSessions(ctx, asOf) {
  return listSessions(ctx, { from: hoursFrom(asOf, MIN_LEAD_HOURS), to: hoursFrom(asOf, WINDOW_HOURS) })
    .filter((s) => AUTO_KINDS.includes(s.kind) && bookable(s) && s.spots_left > 0 && s.waitlist_count === 0);
}

// Everything "who fits" needs, read once so a week of classes stays quick.
function fitPool(ctx, asOf) {
  const ids = (sql, ...p) => new Set(ctx.db.all(sql, ...p).map((r) => r.client_id));
  const regulars = new Map();
  for (const r of ctx.db.all(`SELECT DISTINCT x.series_id, b.client_id FROM bookings b JOIN class_sessions x ON x.id = b.session_id WHERE b.status = 'attended' AND x.series_id IS NOT NULL AND x.starts_at >= ?`, daysBefore(asOf, 60))) {
    if (!regulars.has(r.series_id)) regulars.set(r.series_id, new Set());
    regulars.get(r.series_id).add(r.client_id);
  }
  return {
    kids: ctx.db.all(`SELECT c.id, c.name, c.birth_date, c.family_id FROM clients c JOIN families f ON f.id = c.family_id
      WHERE c.name != 'Deleted athlete' AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM data_requests d WHERE d.family_id = c.family_id AND d.kind = 'delete' AND d.status = 'open')`),
    members: ids(`SELECT DISTINCT client_id FROM subscriptions WHERE status IN ('active','trialing','past_due')`),
    recent: ids(`SELECT DISTINCT b.client_id FROM bookings b JOIN class_sessions x ON x.id = b.session_id WHERE b.status = 'attended' AND x.starts_at >= ?`, daysBefore(asOf, 45)),
    regulars,
    offeredToday: new Map(ctx.db.all('SELECT family_id, COUNT(*) AS n FROM spot_offers WHERE sent_at >= ? GROUP BY family_id', daysBefore(asOf, 1)).map((r) => [r.family_id, r.n]))
  };
}
const fitsAge = (s, c) => {
  if (s.age_min == null && s.age_max == null) return true;
  const age = ageOn(c.birth_date, s.starts_at);
  return age != null && (s.age_min == null || age >= s.age_min) && (s.age_max == null || age <= s.age_max);
};

// The families who fit a session, regulars of the class first. Each with the athletes who fit.
export function candidates(ctx, s, asOf = ctx.now(), pool = fitPool(ctx, asOf)) {
  const taken = new Set(ctx.db.all(`SELECT client_id FROM bookings WHERE session_id = ? AND status IN ('booked','attended','waitlisted')`, s.id).map((r) => r.client_id));
  const offered = new Set(ctx.db.all('SELECT family_id FROM spot_offers WHERE session_id = ?', s.id).map((r) => r.family_id));
  const rank = (c) => (s.series_id && pool.regulars.get(s.series_id)?.has(c.id) ? 0 : pool.members.has(c.id) ? 1 : pool.recent.has(c.id) ? 2 : null);
  const byFamily = new Map();
  for (const c of pool.kids) {
    if (taken.has(c.id) || offered.has(c.family_id) || !fitsAge(s, c)) continue;
    const r = rank(c);
    if (r == null) continue;
    const f = byFamily.get(c.family_id) ?? { family_id: c.family_id, rank: r, athletes: [] };
    f.rank = Math.min(f.rank, r);
    f.athletes.push({ id: c.id, name: c.name });
    byFamily.set(c.family_id, f);
  }
  return [...byFamily.values()].filter((f) => (pool.offeredToday.get(f.family_id) ?? 0) < FAMILY_DAILY).sort((a, b) => a.rank - b.rank);
}

// Families who had a standard offer for this session and haven't booked: a trial offer goes to them too, on the same link.
function reofferable(ctx, s, asOf, pool) {
  const taken = new Set(ctx.db.all(`SELECT client_id FROM bookings WHERE session_id = ? AND status IN ('booked','attended','waitlisted')`, s.id).map((r) => r.client_id));
  const kids = new Map(pool.kids.map((c) => [c.id, c]));
  return ctx.db.all('SELECT * FROM spot_offers WHERE session_id = ? AND booked_at IS NULL AND price_cents IS NULL ORDER BY sent_at', s.id)
    .map((o) => ({ offer: o, family_id: o.family_id, rank: 3, athletes: o.client_ids.split(',').map((id) => kids.get(id)).filter((c) => c && !taken.has(c.id)).map((c) => ({ id: c.id, name: c.name })) }))
    .filter((f) => f.athletes.length && (pool.offeredToday.get(f.family_id) ?? 0) - (f.offer.sent_at >= daysBefore(asOf, 1) ? 1 : 0) < FAMILY_DAILY);
}
function trialAudience(ctx, s, asOf, pool = fitPool(ctx, asOf)) { return [...candidates(ctx, s, asOf, pool), ...reofferable(ctx, s, asOf, pool)]; }

const STATS_SQL = `SELECT session_id, COUNT(*) AS sent, COUNT(opened_at) AS opened, COUNT(booked_at) AS booked, MAX(sent_at) AS last_sent,
    COUNT(price_cents) AS trial_sent, SUM(price_cents IS NOT NULL AND booked_at IS NOT NULL) AS trial_booked,
    (SELECT o2.price_cents FROM spot_offers o2 WHERE o2.session_id = o.session_id AND o2.price_cents IS NOT NULL ORDER BY o2.sent_at DESC LIMIT 1) AS trial_price,
    SUM(booked_at IS NULL AND price_cents IS NULL) AS unbooked_standard
  FROM spot_offers o`;
const shapeStats = (r) => ({ sent: r?.sent ?? 0, opened: r?.opened ?? 0, booked: r?.booked ?? 0, last_sent_at: r?.last_sent ?? null,
  trial_sent: r?.trial_sent ?? 0, trial_booked: r?.trial_booked ?? 0, trial_price_cents: r?.trial_price ?? null });
function offerStats(ctx, sessionId) { return shapeStats(ctx.db.get(`${STATS_SQL} WHERE session_id = ? GROUP BY session_id`, sessionId)); }

// Why a session can't take offers right now, or null when it can.
function offerBlock(s, asOf) {
  if (!bookable(s)) return 'Offers are for classes, clinics and camp days that sell single spots.';
  if (s.status !== 'scheduled') return 'This session was canceled.';
  if (s.starts_at <= hoursFrom(asOf, MIN_LEAD_HOURS)) return 'Starts in under 2 hours, too soon for offers.';
  if (s.spots_left <= 0) return 'This session is full.';
  if (s.waitlist_count > 0) return 'Families are on the waitlist; they get open spots first.';
  return null;
}
const maxTrialPrice = (s) => (s.drop_in_cents != null ? s.drop_in_cents : TRIAL_MAX_CENTS);

// Today: every upcoming class with a spot left in the next 7 days (or ?days=), soonest first, for every coach (coachId
// narrows it to one). With how many families fit, what a tap would send, and why offers can't go out when they can't.
export function openSpots(ctx, { asOf = ctx.now(), days = LIST_DAYS, coachId } = {}) {
  const mode = getSetting(ctx, 'open_spot_offers');
  const sessions = listSessions(ctx, { from: asOf, to: hoursFrom(asOf, days * 24), coachId }).filter((s) => bookable(s) && s.spots_left > 0);
  if (!sessions.length) return { mode, days, data: [] };
  const pool = fitPool(ctx, asOf);
  const ph = sessions.map(() => '?').join(',');
  const stats = new Map(ctx.db.all(`${STATS_SQL} WHERE session_id IN (${ph}) GROUP BY session_id`, ...sessions.map((s) => s.id)).map((r) => [r.session_id, r]));
  return { mode, days, data: sessions.map((s) => {
    const fits = candidates(ctx, s, asOf, pool).length, st = stats.get(s.id), block = offerBlock(s, asOf);
    const offerCount = Math.min(fits, s.spots_left * PER_SPOT, MAX_PER_ROUND), trialFamilies = fits + (st?.unbooked_standard ?? 0);
    const offerNote = block ?? (mode === 'off' ? 'Offers are turned off. Pick "Send offers when I tap" above to turn them on.' : !fits ? (st?.sent ? 'Every family who fits has an offer or is booked.' : 'No families fit this class yet (the right age and a regular, a member or here in the last 45 days).') : null);
    return { id: s.id, name: s.name, kind: s.kind, starts_at: s.starts_at, ends_at: s.ends_at, location_name: s.location_name, coach_id: s.coach_id ?? null, coach_name: s.coach_name ?? null,
      capacity: s.capacity, booked: s.booked_count, spots_left: s.spots_left, waitlist: s.waitlist_count, drop_in_cents: s.drop_in_cents ?? null,
      families_who_fit: fits, offer_count: offerNote ? 0 : offerCount, can_offer: !offerNote, offer_note: offerNote,
      can_trial: !block && trialFamilies > 0, trial_note: block ?? (trialFamilies ? null : 'No families to send it to yet.'),
      auto: mode === 'auto' && AUTO_KINDS.includes(s.kind) && s.starts_at <= hoursFrom(asOf, 30),
      offers: shapeStats(st) };
  }) };
}

// One family's offer: save it (or turn their standard offer into this trial offer, same link), then email and text.
async function deliver(ctx, s, f, { actor, priceCents = null, subject, body, text }) {
  const guardian = ctx.db.get('SELECT name, email FROM guardians WHERE family_id = ? AND email IS NOT NULL AND email NOT IN (SELECT email FROM email_optouts) ORDER BY is_primary DESC, created_at LIMIT 1', f.family_id);
  let tok;
  if (f.offer) {
    tok = f.offer.token;
    ctx.db.run('UPDATE spot_offers SET price_cents = ?, client_ids = ?, sent_to = ?, sent_by = ?, sent_at = ? WHERE id = ?', priceCents, f.athletes.map((a) => a.id).join(','), guardian?.email ?? null, actor ?? 'Automatic', ctx.now(), f.offer.id);
  } else {
    tok = token(16);
    ctx.db.run('INSERT INTO spot_offers (id, token, session_id, family_id, client_ids, sent_to, sent_by, sent_at, price_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('spot'), tok, s.id, f.family_id, f.athletes.map((a) => a.id).join(','), guardian?.email ?? null, actor ?? 'Automatic', ctx.now(), priceCents);
  }
  const link = `${ctx.publicUrl ?? ''}/spot/${tok}`, names = f.athletes.map((a) => first(a.name)).join(' or ');
  if (guardian) await sendEmail(ctx, { to: guardian.email, subject, text: body({ parent: first(guardian.name), names, link }) });
  textFamily(ctx, f.family_id, 'open_spot', text({ names, link }));
}

// Send offers for one session: up to 4 families per open spot (30 at most), best fits first.
export async function sendOffers(ctx, sessionId, { actor, asOf = ctx.now() } = {}) {
  const s = getSession(ctx, sessionId);
  const block = offerBlock(s, asOf);
  if (block) throw conflict(block);
  const pool = fitPool(ctx, asOf);
  const who = candidates(ctx, s, asOf, pool).slice(0, Math.min(MAX_PER_ROUND, s.spots_left * PER_SPOT));
  const biz = getSetting(ctx, 'business_name');
  for (const f of who) await deliver(ctx, s, f, { actor, subject: `Open spot: ${s.name}, ${when(ctx, s.starts_at)}`,
    body: ({ parent, names, link }) => `Hi ${parent},\n\n${s.name} at ${s.location_name} on ${when(ctx, s.starts_at)} has ${s.spots_left === 1 ? 'one open spot' : `${s.spots_left} open spots`}, and we thought of ${names}.\n\nFirst to grab it gets it. Book in one tap, no sign-in needed:\n${link}\n\nCan't make it? No need to reply.\n\n${biz}`,
    text: ({ names, link }) => `Open spot for ${names}: ${s.name}, ${when(ctx, s.starts_at)}. First to book gets it: ${link}` });
  const sent = who.length;
  if (sent) emit(ctx, 'spots.offered', { session_id: s.id, session_name: s.name, starts_at: s.starts_at, families: sent, spots_left: s.spots_left });
  return { session_id: s.id, sent, families_left: candidates(ctx, s, asOf).length, offers: offerStats(ctx, s.id) };
}

// ---------- Trial offers: "try this session for $X" (owner only; routes and security.js keep it that way) ----------
const DEFAULT_TRIAL = (ctx, s) => `We'd love to have {athlete} try ${s.name} at ${s.location_name} on ${when(ctx, s.starts_at)}. This session is {price} for you.`;
const fill = (tpl, { names, price }) => tpl.replaceAll('{athlete}', names).replaceAll('{price}', price);

// What the dialog needs: the price range, who it would reach, and the message to start from.
export function trialOfferPreview(ctx, sessionId, asOf = ctx.now()) {
  const s = getSession(ctx, sessionId);
  const block = offerBlock(s, asOf);
  if (block) throw conflict(block);
  const pool = fitPool(ctx, asOf);
  const fresh = candidates(ctx, s, asOf, pool).length, again = reofferable(ctx, s, asOf, pool).length;
  return {
    session: { id: s.id, name: s.name, kind: s.kind, starts_at: s.starts_at, location_name: s.location_name, coach_name: s.coach_name ?? null, spots_left: s.spots_left, drop_in_cents: s.drop_in_cents ?? null },
    default_price_cents: s.drop_in_cents ?? 0, max_price_cents: maxTrialPrice(s),
    families: fresh + again, new_families: fresh, offered_before: again, max_families: MAX_PER_ROUND,
    open_leads_with_email: ctx.db.get(`SELECT COUNT(*) AS n FROM leads WHERE family_id IS NULL AND email IS NOT NULL AND status IN ('new','contacted','evaluation')`).n,
    message: DEFAULT_TRIAL(ctx, s), expires_at: s.starts_at
  };
}

// Send a trial offer: price_cents (0 up to the drop-in, or $200 with no drop-in), max_families (1 to 30), message
// ({athlete} and {price} filled in per family). Valid until the session starts; first to book gets each spot.
export async function sendTrialOffer(ctx, sessionId, body = {}, { actor, asOf = ctx.now() } = {}) {
  const s = getSession(ctx, sessionId);
  const block = offerBlock(s, asOf);
  if (block) throw conflict(block);
  const max = maxTrialPrice(s), raw = body.price_cents;
  const price = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
  if (!Number.isInteger(price) || price < 0 || price > max) throw badRequest(`Set the price in whole cents from $0 (free) to ${money(max)}${s.drop_in_cents != null ? ', the drop-in price' : ''}.`);
  const cap = v.int(body.max_families ?? MAX_PER_ROUND, 'max_families', { min: 1, max: MAX_PER_ROUND });
  const tpl = body.message === undefined || body.message === null || String(body.message).trim() === '' ? DEFAULT_TRIAL(ctx, s) : v.str(String(body.message).trim(), 'message', { max: 1000 });
  const who = trialAudience(ctx, s, asOf).slice(0, cap);
  if (!who.length) throw conflict('No families to send this to: everyone who fits is booked, already has a trial offer, or had 2 offers today.');
  const biz = getSetting(ctx, 'business_name'), price$ = priceText(price);
  for (const f of who) await deliver(ctx, s, f, { actor, priceCents: price, subject: `Try ${s.name} ${price === 0 ? 'free' : `for ${price$}`}: ${when(ctx, s.starts_at)}`,
    body: ({ parent, names, link }) => `Hi ${parent},\n\n${fill(tpl, { names, price: price$ })}\n\n${s.spots_left === 1 ? 'There\'s one spot' : `There are ${s.spots_left} spots`}, and the first to book gets ${s.spots_left === 1 ? 'it' : 'them'}. The offer ends when the session starts. Book in one tap, no sign-in needed:\n${link}\n\nCan't make it? No need to reply.\n\n${biz}`,
    text: ({ names, link }) => `${biz}: ${names} can try ${s.name}, ${when(ctx, s.starts_at)}, ${price === 0 ? 'free' : `for ${price$}`}. First to book gets it: ${link}` });
  emit(ctx, 'spots.offered', { session_id: s.id, session_name: s.name, starts_at: s.starts_at, families: who.length, spots_left: s.spots_left, trial: true, price_cents: price, sent_by: actor ?? null });
  return { session_id: s.id, sent: who.length, price_cents: price, families_left: Math.max(0, trialAudience(ctx, s, asOf).length), offers: offerStats(ctx, s.id) };
}

// Hourly, with open_spot_offers on 'auto': group classes and clinics starting in the next 30 hours that haven't had
// offers in 12 hours, between 10 am and 7 pm.
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
    session: { name: s.name, kind: s.kind, starts_at: s.starts_at, ends_at: s.ends_at, location_name: s.location_name, spots_left: s.spots_left, drop_in_cents: s.drop_in_cents ?? null },
    trial: o.price_cents != null ? { price_cents: o.price_cents, used: !!o.booked_at } : null,
    athletes, timezone: getSetting(ctx, 'timezone'), waiver_signed: fam?.waiver_version != null && Number(fam.waiver_version) === Number(getSetting(ctx, 'waiver_version')), card_last4: fam?.card_payment_method ? fam.card_last4 : null };
}
// Book from the offer. A standard offer uses the family's usual cover (membership, a pack, or pay with the family card).
// A trial offer charges its own price to the family card (or books free at $0), once; a membership that covers the class
// still covers it. The special price comes only from this offer's row, so no other booking is affected.
export async function bookOffer(ctx, tok, body = {}) {
  const o = byToken(ctx, tok);
  const view = publicOffer(ctx, tok);
  if (view.status === 'canceled') throw conflict('This session was canceled.');
  if (view.status === 'started') throw conflict('This session has already started.');
  if (view.status === 'full') throw conflict('Sorry, that spot was just taken. We\'ll let you know next time one opens.');
  const clientId = v.str(body.athlete_id, 'athlete_id');
  if (!o.client_ids.split(',').includes(clientId)) throw notFound('Athlete');
  if (!view.waiver_signed) throw new HttpError(409, 'waiver_required', 'Sign the waiver in the parent portal first (Family tab), then come back to this link.');
  const trial = o.price_cents != null;
  if (trial && o.booked_at) throw conflict('This trial offer has already been used. Book another session from the parent portal.');
  const member = view.session.kind === 'group' && !!ctx.db.get(`SELECT 1 FROM subscriptions WHERE client_id = ? AND status IN ('active','trialing','past_due')`, clientId);
  if (trial && o.price_cents > 0 && !member && !view.card_last4) throw new HttpError(402, 'payment_required', `Add a card in the parent portal (Family tab), then come back to this link to book for ${money(o.price_cents)}.`);
  const b = await book(ctx, { sessionId: o.session_id, clientId, pay: body.pay === 'card_on_file' ? 'card_on_file' : undefined, actor: trial ? 'Trial offer' : 'Open spot offer', offerPriceCents: trial ? o.price_cents : undefined });
  if (b.status === 'booked') ctx.db.run('UPDATE spot_offers SET booking_id = ?, booked_at = ? WHERE id = ?', b.id, ctx.now(), o.id);
  const charged = b.coverage === 'paid' ? ctx.db.get('SELECT amount_cents FROM sales WHERE id = ?', b.sale_id)?.amount_cents : null;
  return { ...publicOffer(ctx, tok), booked: b.status === 'booked', waitlisted: b.status === 'waitlisted', coverage: b.coverage,
    message: b.status === 'booked' ? `${first(b.client_name)} is booked for ${b.session_name}.${charged != null ? ` ${money(charged)} was charged to the card ending ${view.card_last4}.` : trial && b.coverage === 'none' ? ' It\'s free, nothing to pay.' : b.coverage === 'membership' && trial ? ' Covered by the membership.' : ''}` : `The last spot was just taken, so ${first(b.client_name)} is on the waitlist.` };
}
