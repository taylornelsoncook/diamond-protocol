import { newId, v, notFound, conflict, badRequest, withLock } from '../util.js';
import { getSetting, payerFor } from './families.js';
import { createSale, onlineLocation } from './commerce.js';
import { assign, unassign } from './programs.js';
import { sendEmail } from './mail.js';
import { emit } from './events.js';
import { cardFee } from './fees.js';

// Programs and courses sold online. The owner sets a price on a program or an athlete course and turns on "Sell
// online". Families buy from the parent portal's Programs tab with the family card; out-of-town athletes find them on
// the public page /shop, which sends them to sign up (or sign in) first so every buyer has a proven email and an
// account. A bought program goes straight into the athlete's app, even without a membership. A course for sale is
// locked for athletes until it's bought (or a coach assigns it). A full refund of the sale ends access.

const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const first = (name) => String(name ?? '').split(' ')[0];
const KINDS = ['program', 'course'];
export const MAX_TRIAL_DAYS = 30;
const TRIAL_TRIES = 3;                      // charges tried at the end of a trial (one a day) before the program closes
const DAY = 86400000;
const niceDate = (iso, tz) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz || 'UTC' });

// The coach shown on a program's sales page (version 72): an owner or coach whose account is on. Nothing private.
export function coachCard(ctx, userId) {
  if (!userId) return null;
  const u = ctx.db.get(`SELECT id, name, title, bio, photo_url FROM users WHERE id = ? AND active = 1 AND role IN ('owner', 'coach')`, userId);
  return u ? { id: u.id, name: u.name, title: u.title ?? null, bio: u.bio ?? null, photo_url: u.photo_url ?? null } : null;
}

function programItem(ctx, p) {
  const workouts = ctx.db.all('SELECT week, day, title FROM workouts WHERE program_id = ? ORDER BY week, day', p.id);
  return { kind: 'program', id: p.id, title: p.name, description: p.description, level: p.level, weeks: p.weeks, workouts: workouts.length,
    per_week: workouts.length ? Math.round(workouts.length / Math.max(1, new Set(workouts.map((w) => w.week)).size)) : 0,
    outline: workouts.filter((w) => w.week === workouts[0]?.week).map((w) => w.title), price_cents: p.price_cents, fee_cents: cardFee(ctx, p.price_cents, 'store').cents, for_sale: !!p.for_sale,
    pitch: p.pitch ?? null, trial_days: p.trial_days ?? 0, coach_id: p.coach_id ?? null, coach: coachCard(ctx, p.coach_id) };
}
function courseItem(ctx, c) {
  const lessons = ctx.db.all('SELECT title, minutes, quiz FROM lessons WHERE course_id = ? AND published = 1 ORDER BY position, created_at', c.id);
  return { kind: 'course', id: c.id, title: c.title, description: c.description, lessons: lessons.length, minutes: lessons.reduce((t, l) => t + (l.minutes ?? 0), 0),
    quizzes: lessons.filter((l) => l.quiz).length, outline: lessons.map((l) => l.title), price_cents: c.price_cents, fee_cents: cardFee(ctx, c.price_cents, 'store').cents, for_sale: !!c.for_sale };
}

// What's for sale: priced, turned on, and with something inside (a program with workouts, a published course with lessons).
export function shopItems(ctx) {
  const programs = ctx.db.all(`SELECT * FROM programs WHERE for_sale = 1 AND price_cents > 0 AND kind = 'program' ORDER BY name`).map((p) => programItem(ctx, p)).filter((p) => p.workouts > 0);
  const courses = ctx.db.all(`SELECT * FROM courses WHERE for_sale = 1 AND price_cents > 0 AND published = 1 AND audience = 'athletes' ORDER BY title`).map((c) => courseItem(ctx, c)).filter((c) => c.lessons > 0);
  return [...programs, ...courses];
}
function forSale(ctx, kind, id) {
  const item = shopItems(ctx).find((x) => x.kind === kind && x.id === id);
  if (!item) throw notFound(kind === 'program' ? 'Program for sale' : 'Course for sale');
  return item;
}

// The public page. No names, no counts of buyers.
export function publicShop(ctx) {
  return { business_name: getSetting(ctx, 'business_name'), signup_open: getSetting(ctx, 'public_signup') === 'on', items: shopItems(ctx) };
}
// One program's sales page (/shop/<id>, version 72): the pitch, every week's workouts with its phase, how many exercises
// have a demo video, the coach, the price and the trial. Only a program that is in the store; nothing about who bought it.
export function publicProgram(ctx, id) {
  const item = shopItems(ctx).find((x) => x.kind === 'program' && x.id === id);
  if (!item) throw notFound('Program for sale');
  const workouts = ctx.db.all('SELECT id, week, day, title FROM workouts WHERE program_id = ? ORDER BY week, day', id);
  const phases = ctx.db.all('SELECT name, start_week, end_week FROM program_phases WHERE program_id = ? ORDER BY start_week', id);
  const weeks = [];
  for (let w = 1; w <= item.weeks; w++) {
    const phase = phases.find((p) => w >= p.start_week && w <= p.end_week)?.name ?? null;
    weeks.push({ week: w, phase, workouts: workouts.filter((x) => x.week === w).map((x) => x.title) });
  }
  const ex = ctx.db.get(`SELECT COUNT(DISTINCT e.id) AS n, COUNT(DISTINCT CASE WHEN e.video_url IS NOT NULL AND e.video_url != '' THEN e.id END) AS with_video
    FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id JOIN exercises e ON e.id = we.exercise_id WHERE w.program_id = ?`, id);
  const cues = ctx.db.get(`SELECT COUNT(DISTINCT e.id) AS n FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id JOIN exercises e ON e.id = we.exercise_id
    JOIN exercise_cues c ON c.exercise_id = e.id WHERE w.program_id = ? AND (c.audio IS NOT NULL OR (c.transcript IS NOT NULL AND c.transcript != ''))`, id)?.n ?? 0;
  const { coach_id, ...rest } = item;
  return { business_name: getSetting(ctx, 'business_name'), signup_open: getSetting(ctx, 'public_signup') === 'on', fee_label: getSetting(ctx, 'card_fee_label'),
    program: { ...rest, weeks_outline: weeks, exercises: ex?.n ?? 0, videos: ex?.with_video ?? 0, cues, phases: phases.map((p) => p.name) } };
}

// ---------- Owner: prices and what sold ----------
export function setForSale(ctx, kind, id, body = {}) {
  v.oneOf(kind, 'kind', KINDS);
  const row = kind === 'program' ? ctx.db.get('SELECT * FROM programs WHERE id = ?', id) : ctx.db.get('SELECT * FROM courses WHERE id = ?', id);
  if (!row) throw notFound(kind === 'program' ? 'Program' : 'Course');
  if (kind === 'course' && row.audience === 'parents') throw conflict('Parent courses are free in the parent portal. Only athlete courses can be sold.');
  if (kind === 'program' && row.kind !== 'program') throw conflict('A template can\'t be sold. Start a program from it first.');
  const on = body.for_sale === undefined ? !!row.for_sale : body.for_sale === true;
  const price = body.price_cents === undefined ? row.price_cents : body.price_cents === null || body.price_cents === '' ? null : Number(body.price_cents);
  if (price != null && (!Number.isInteger(price) || price < 100 || price > 100000)) throw badRequest('Set a price between $1 and $1,000.');
  if (on && !price) throw badRequest('Set a price before selling it online.');
  const extra = kind === 'program' ? pageFields(ctx, body, row) : {};
  if (kind === 'course' && (body.pitch !== undefined || body.trial_days !== undefined || body.coach_id !== undefined)) throw badRequest('A sales page, a trial and a coach are for programs.');
  ctx.db.run(`UPDATE ${kind === 'program' ? 'programs' : 'courses'} SET for_sale = ?, price_cents = ?${kind === 'program' ? ', pitch = ?, coach_id = ?, trial_days = ?' : ''} WHERE id = ?`,
    ...[on ? 1 : 0, price, ...(kind === 'program' ? [extra.pitch, extra.coach_id, extra.trial_days] : []), id]);
  return saleInfo(ctx, kind, id);
}
// The sales page's own fields (version 72): a longer pitch, the coach shown (an owner or coach whose account is on) and
// a free trial of 0 to 30 days before the card is charged.
function pageFields(ctx, body, cur) {
  const pitch = body.pitch === undefined ? cur.pitch ?? null : (v.str(body.pitch, 'pitch', { max: 3000, optional: true }) || null);
  let coachId = cur.coach_id ?? null;
  if (body.coach_id !== undefined) {
    coachId = body.coach_id === null || body.coach_id === '' ? null : v.str(body.coach_id, 'coach_id', { max: 64 });
    if (coachId && !coachCard(ctx, coachId)) throw badRequest('Pick an owner or coach whose account is on.');
  }
  const trialDays = body.trial_days === undefined ? cur.trial_days ?? 0 : v.int(body.trial_days, 'trial_days', { min: 0, max: MAX_TRIAL_DAYS });
  return { pitch, coach_id: coachId, trial_days: trialDays };
}
function saleInfo(ctx, kind, id) {
  const row = kind === 'program' ? ctx.db.get('SELECT * FROM programs WHERE id = ?', id) : ctx.db.get('SELECT * FROM courses WHERE id = ?', id);
  const item = kind === 'program' ? programItem(ctx, row) : courseItem(ctx, row);
  const sold = ctx.db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM purchases WHERE item_kind = ? AND item_id = ? AND status = 'active'`, kind, id);
  const listed = shopItems(ctx).some((x) => x.kind === kind && x.id === id);
  const why = !item.for_sale ? null : listed ? null : kind === 'program' ? 'Add at least one workout so it shows in the store.' : !row.published ? 'Publish the course so it shows in the store.' : 'Add a published lesson so it shows in the store.';
  return { ...item, listed, not_listed_because: why, sold: sold.n, sold_cents: sold.cents };
}
// Everything that could be sold, with prices and sales. Owners only.
export function shopAdmin(ctx) {
  const programs = ctx.db.all('SELECT id FROM programs ORDER BY name').map((p) => saleInfo(ctx, 'program', p.id));
  const courses = ctx.db.all(`SELECT id FROM courses WHERE audience = 'athletes' ORDER BY title`).map((c) => saleInfo(ctx, 'course', c.id));
  const recent = ctx.db.all(`SELECT b.*, c.name AS client_name FROM purchases b JOIN clients c ON c.id = b.client_id ORDER BY b.created_at DESC LIMIT 50`);
  const month = new Date(Date.parse(ctx.now()) - 30 * 86400000).toISOString();
  const last30 = ctx.db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM purchases WHERE status = 'active' AND created_at >= ?`, month);
  return { programs, courses, recent, last_30_days: { sold: last30.n, cents: last30.cents } };
}

// ---------- Families ----------
export function ownedBy(ctx, clientIds) {
  if (!clientIds.length) return [];
  return ctx.db.all(`SELECT id, client_id, item_kind, item_id, title, amount_cents, status, trial_ends_at, created_at FROM purchases WHERE status IN ('active', 'trial') AND client_id IN (${clientIds.map(() => '?').join(',')}) ORDER BY created_at DESC`, ...clientIds);
}
export function familyShop(ctx, familyId) {
  const kids = ctx.db.all('SELECT id FROM clients WHERE family_id = ?', familyId).map((c) => c.id);
  return { items: shopItems(ctx), owned: ownedBy(ctx, kids) };
}

// Buy for one athlete with the family card. The program replaces the athlete's current one.
export async function buyForAthlete(ctx, guardian, client, body = {}) {
  const kind = v.oneOf(body.kind, 'kind', KINDS);
  // A second tap waits for the first, then finds the purchase and stops before charging.
  return withLock(`buy:${client.id}:${kind}:${body.item_id}`, () => buyNow(ctx, guardian, client, kind, body));
}
async function buyNow(ctx, guardian, client, kind, body) {
  const item = forSale(ctx, kind, v.str(body.item_id, 'item_id'));
  if (ctx.db.get(`SELECT id FROM purchases WHERE client_id = ? AND item_kind = ? AND item_id = ? AND status IN ('active', 'trial')`, client.id, kind, item.id)) throw conflict(`${first(client.name)} already has ${item.title}.`);
  if (kind === 'program' && ctx.db.get('SELECT id FROM assignments WHERE client_id = ? AND program_id = ? AND active = 1', client.id, item.id)) throw conflict(`${first(client.name)} is already on ${item.title}.`);
  const payer = payerFor(ctx, client.id);
  if (!payer.card_payment_method) throw conflict('Add a card on the Family tab first.');
  // A free trial (version 72): one per athlete and program, with a card on file, charged by the hourly job when it ends.
  const triedBefore = kind === 'program' && ctx.db.get('SELECT id FROM purchases WHERE client_id = ? AND item_kind = ? AND item_id = ? AND trial_ends_at IS NOT NULL', client.id, kind, item.id);
  if (kind === 'program' && item.trial_days > 0 && !triedBefore && body.trial !== false) return startTrial(ctx, guardian, client, item, payer);
  const sale = await createSale(ctx, { location_id: onlineLocation(ctx), method: 'card_on_file', client_id: client.id,
    custom: { description: `${item.title} (online ${kind})`, amount_cents: item.price_cents }, note: `Online ${kind} ${item.id}` }, guardian.id, { online: true });
  if (sale.status !== 'succeeded') throw conflict(`The card was declined: ${sale.failure_reason ?? 'try another card'}.`);
  const id = newId('buy');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO purchases (id, client_id, item_kind, item_id, title, amount_cents, sale_id, guardian_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, client.id, kind, item.id, item.title, item.price_cents, sale.id, guardian.id, ctx.now());
    if (kind === 'program') assign(ctx, item.id, client.id);
  });
  emit(ctx, 'purchase.completed', { purchase_id: id, client_id: client.id, client_name: client.name, kind, item_id: item.id, title: item.title, amount_cents: item.price_cents, sale_id: sale.id });
  const c = ctx.db.get('SELECT name, access_token FROM clients WHERE id = ?', client.id);
  const biz = getSetting(ctx, 'business_name');
  const where = kind === 'program' ? 'is in' : 'is unlocked in the Education tab of';
  sendEmail(ctx, { to: guardian.email, subject: `${item.title} is ready for ${first(c.name)}`,
    text: `Hi ${first(guardian.name)},\n\nThanks for buying ${item.title}. It ${where} ${first(c.name)}'s app now:\n${ctx.publicUrl ?? ''}/app?token=${c.access_token}\n\nThat link is just for ${first(c.name)}, so keep it private. You can follow along from the parent portal too.\n\n${money(sale.amount_cents)} was charged to the card ending ${payer.card_last4 ?? ''}${sale.fee_cents ? ` (${money(item.price_cents)} plus a ${money(sale.fee_cents)} ${(sale.fee_label ?? 'card processing fee').toLowerCase()})` : ''}.\n\n${biz}` }).catch(() => {});
  return { purchase: { id, kind, item_id: item.id, title: item.title, amount_cents: item.price_cents, status: 'active' }, sale_id: sale.id };
}

// ---------- Free trials (version 72) ----------
function startTrial(ctx, guardian, client, item, payer) {
  const id = newId('buy');
  const ends = new Date(Date.parse(ctx.now()) + item.trial_days * DAY).toISOString();
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO purchases (id, client_id, item_kind, item_id, title, amount_cents, guardian_id, status, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'trial', ?, ?)`,
      id, client.id, 'program', item.id, item.title, item.price_cents, guardian.id, ends, ctx.now());
    assign(ctx, item.id, client.id);
  });
  emit(ctx, 'purchase.trial_started', { purchase_id: id, client_id: client.id, client_name: client.name, kind: 'program', item_id: item.id, title: item.title, amount_cents: item.price_cents, trial_ends_at: ends });
  const c = ctx.db.get('SELECT name, access_token FROM clients WHERE id = ?', client.id);
  const biz = getSetting(ctx, 'business_name'), tz = getSetting(ctx, 'timezone');
  const total = item.price_cents + (item.fee_cents ?? 0);
  sendEmail(ctx, { to: guardian.email, subject: `${first(c.name)}'s free trial of ${item.title} has started`,
    text: `Hi ${first(guardian.name)},\n\n${item.title} is in ${first(c.name)}'s app now:\n${ctx.publicUrl ?? ''}/app?token=${c.access_token}\n\nThat link is just for ${first(c.name)}, so keep it private. You can follow along from the parent portal too.\n\nThe trial is free for ${item.trial_days} days. On ${niceDate(ends, tz)} we charge ${money(total)} to the card ending ${payer.card_last4 ?? ''}${item.fee_cents ? ` (${money(item.price_cents)} plus a ${money(item.fee_cents)} card processing fee)` : ''}, unless you end the trial first in the parent portal (Programs tab).\n\n${biz}` }).catch(() => {});
  return { purchase: { id, kind: 'program', item_id: item.id, title: item.title, amount_cents: item.price_cents, status: 'trial', trial_ends_at: ends }, trial: true };
}
// A parent ends a trial before it's charged: the program closes in the app, nothing is owed. Only their own family's.
export function cancelTrial(ctx, guardian, purchaseId) {
  const b = ctx.db.get(`SELECT b.*, c.name AS client_name FROM purchases b JOIN clients c ON c.id = b.client_id WHERE b.id = ? AND c.family_id = ?`, v.str(purchaseId, 'purchase'), guardian.family_id);
  if (!b) throw notFound('Purchase');
  if (b.status !== 'trial') throw conflict(b.status === 'active' ? `${b.title} was paid for. Message your coach about a refund.` : 'That trial is already over.');
  return withLock(`buy:${b.client_id}:program:${b.item_id}`, () => endTrial(ctx, b, 'canceled', { by: 'parent' }));
}
function endTrial(ctx, b, status, { by }) {
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE purchases SET status = 'canceled', canceled_at = ? WHERE id = ? AND status = 'trial'`, ctx.now(), b.id);
    if (ctx.db.get('SELECT id FROM assignments WHERE client_id = ? AND program_id = ? AND active = 1', b.client_id, b.item_id)) unassign(ctx, b.item_id, b.client_id);
  });
  emit(ctx, 'purchase.trial_ended', { purchase_id: b.id, client_id: b.client_id, client_name: b.client_name, kind: 'program', item_id: b.item_id, title: b.title, outcome: status, by });
  return { id: b.id, status: 'canceled', title: b.title, client_id: b.client_id };
}
// The hourly job: charge the family card when a trial ends. A decline is tried again a day later, up to three tries, then
// the program closes and the family and the owners are told. Nothing is charged twice: each try is under the same lock
// as buying, and the row is read again inside it.
export async function runTrials(ctx) {
  const now = ctx.now(), retryBefore = new Date(Date.parse(now) - 20 * 3600000).toISOString();
  const due = ctx.db.all(`SELECT b.id FROM purchases b JOIN clients c ON c.id = b.client_id WHERE b.status = 'trial' AND b.trial_ends_at <= ? AND (b.last_try_at IS NULL OR b.last_try_at <= ?) AND c.archived_at IS NULL ORDER BY b.trial_ends_at`, now, retryBefore);
  const out = { charged: 0, failed: 0, closed: 0 };
  for (const { id } of due) {
    const b = ctx.db.get(`SELECT b.*, c.name AS client_name FROM purchases b JOIN clients c ON c.id = b.client_id WHERE b.id = ?`, id);
    if (!b || b.status !== 'trial') continue;
    await withLock(`buy:${b.client_id}:program:${b.item_id}`, async () => {
      const fresh = ctx.db.get('SELECT status FROM purchases WHERE id = ?', b.id);
      if (fresh?.status !== 'trial') return;
      const r = await chargeTrial(ctx, b);
      out[r] += 1;
    });
  }
  return out;
}
async function chargeTrial(ctx, b) {
  const guardian = b.guardian_id ? ctx.db.get('SELECT * FROM guardians WHERE id = ?', b.guardian_id) : null;
  const payer = payerFor(ctx, b.client_id);
  const biz = getSetting(ctx, 'business_name');
  const item = shopItems(ctx).find((x) => x.kind === 'program' && x.id === b.item_id);
  const price = b.amount_cents;
  let sale = null, why = 'no card on file';
  if (payer.card_payment_method) {
    try {
      sale = await createSale(ctx, { location_id: onlineLocation(ctx), method: 'card_on_file', client_id: b.client_id,
        custom: { description: `${b.title} (online program, after the trial)`, amount_cents: price }, note: `Online program ${b.item_id} (trial ended)` }, 'program-trials', { online: true });
      if (sale.status !== 'succeeded') why = sale.failure_reason ?? 'the card was declined';
    } catch (e) { why = e.message; }
  }
  if (sale?.status === 'succeeded') {
    ctx.db.run(`UPDATE purchases SET status = 'active', sale_id = ?, charge_tries = charge_tries + 1, last_try_at = ? WHERE id = ?`, sale.id, ctx.now(), b.id);
    emit(ctx, 'purchase.completed', { purchase_id: b.id, client_id: b.client_id, client_name: b.client_name, kind: 'program', item_id: b.item_id, title: b.title, amount_cents: price, sale_id: sale.id, after_trial: true });
    if (guardian?.email) sendEmail(ctx, { to: guardian.email, subject: `${first(b.client_name)}'s ${b.title} is paid for`,
      text: `Hi ${first(guardian.name)},\n\nThe free trial of ${b.title} ended, and ${money(sale.amount_cents)} was charged to the card ending ${payer.card_last4 ?? ''}${sale.fee_cents ? ` (${money(price)} plus a ${money(sale.fee_cents)} ${(sale.fee_label ?? 'card processing fee').toLowerCase()})` : ''}. ${first(b.client_name)} keeps the program in their app.\n\n${biz}` }).catch(() => {});
    return 'charged';
  }
  const tries = (b.charge_tries ?? 0) + 1;
  ctx.db.run('UPDATE purchases SET charge_tries = ?, last_try_at = ? WHERE id = ?', tries, ctx.now(), b.id);
  if (tries >= TRIAL_TRIES) {
    endTrial(ctx, b, 'canceled', { by: 'unpaid' });
    if (guardian?.email) sendEmail(ctx, { to: guardian.email, subject: `${b.title} has closed for ${first(b.client_name)}`,
      text: `Hi ${first(guardian.name)},\n\nWe couldn't charge the card on file for ${b.title} (${why}) after the free trial, so the program has closed in ${first(b.client_name)}'s app. Nothing is owed.\n\nTo pick it back up, add a working card in the parent portal (Family tab) and buy it from the Programs tab${item ? ` for ${money(item.price_cents)}` : ''}.\n\n${biz}` }).catch(() => {});
    for (const o of ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`)) sendEmail(ctx, { to: o.email, subject: `${b.client_name}'s trial of ${b.title} ended unpaid`,
      text: `${b.client_name}'s free trial of ${b.title} ended and the family's card couldn't be charged ${TRIAL_TRIES} days running (${why}). The program has closed in their app and the family was told. Their client page has the details.\n\n${biz}` }).catch(() => {});
    return 'closed';
  }
  if (guardian?.email) sendEmail(ctx, { to: guardian.email, subject: `We couldn't charge your card for ${b.title}`,
    text: `Hi ${first(guardian.name)},\n\nThe free trial of ${b.title} ended, but we couldn't charge the card on file (${why}). ${first(b.client_name)} keeps the program for now; we'll try again tomorrow, and after ${TRIAL_TRIES} tries the program closes.\n\nUpdate the card in the parent portal (Family tab): ${ctx.publicUrl ?? ''}/portal\n\n${biz}` }).catch(() => {});
  return 'failed';
}
