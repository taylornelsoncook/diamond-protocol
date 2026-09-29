import { newId, v, notFound, conflict, badRequest, withLock } from '../util.js';
import { getSetting, payerFor } from './families.js';
import { createSale, onlineLocation } from './commerce.js';
import { assign } from './programs.js';
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

function programItem(ctx, p) {
  const workouts = ctx.db.all('SELECT week, day, title FROM workouts WHERE program_id = ? ORDER BY week, day', p.id);
  return { kind: 'program', id: p.id, title: p.name, description: p.description, level: p.level, weeks: p.weeks, workouts: workouts.length,
    per_week: workouts.length ? Math.round(workouts.length / Math.max(1, new Set(workouts.map((w) => w.week)).size)) : 0,
    outline: workouts.filter((w) => w.week === workouts[0]?.week).map((w) => w.title), price_cents: p.price_cents, fee_cents: cardFee(ctx, p.price_cents, 'store').cents, for_sale: !!p.for_sale };
}
function courseItem(ctx, c) {
  const lessons = ctx.db.all('SELECT title, minutes, quiz FROM lessons WHERE course_id = ? AND published = 1 ORDER BY position, created_at', c.id);
  return { kind: 'course', id: c.id, title: c.title, description: c.description, lessons: lessons.length, minutes: lessons.reduce((t, l) => t + (l.minutes ?? 0), 0),
    quizzes: lessons.filter((l) => l.quiz).length, outline: lessons.map((l) => l.title), price_cents: c.price_cents, fee_cents: cardFee(ctx, c.price_cents, 'store').cents, for_sale: !!c.for_sale };
}

// What's for sale: priced, turned on, and with something inside (a program with workouts, a published course with lessons).
export function shopItems(ctx) {
  const programs = ctx.db.all('SELECT * FROM programs WHERE for_sale = 1 AND price_cents > 0 ORDER BY name').map((p) => programItem(ctx, p)).filter((p) => p.workouts > 0);
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

// ---------- Owner: prices and what sold ----------
export function setForSale(ctx, kind, id, body = {}) {
  v.oneOf(kind, 'kind', KINDS);
  const row = kind === 'program' ? ctx.db.get('SELECT * FROM programs WHERE id = ?', id) : ctx.db.get('SELECT * FROM courses WHERE id = ?', id);
  if (!row) throw notFound(kind === 'program' ? 'Program' : 'Course');
  if (kind === 'course' && row.audience === 'parents') throw conflict('Parent courses are free in the parent portal. Only athlete courses can be sold.');
  const on = body.for_sale === undefined ? !!row.for_sale : body.for_sale === true;
  const price = body.price_cents === undefined ? row.price_cents : body.price_cents === null || body.price_cents === '' ? null : Number(body.price_cents);
  if (price != null && (!Number.isInteger(price) || price < 100 || price > 100000)) throw badRequest('Set a price between $1 and $1,000.');
  if (on && !price) throw badRequest('Set a price before selling it online.');
  ctx.db.run(`UPDATE ${kind === 'program' ? 'programs' : 'courses'} SET for_sale = ?, price_cents = ? WHERE id = ?`, on ? 1 : 0, price, id);
  return saleInfo(ctx, kind, id);
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
  return ctx.db.all(`SELECT id, client_id, item_kind, item_id, title, amount_cents, created_at FROM purchases WHERE status = 'active' AND client_id IN (${clientIds.map(() => '?').join(',')}) ORDER BY created_at DESC`, ...clientIds);
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
  if (ctx.db.get(`SELECT id FROM purchases WHERE client_id = ? AND item_kind = ? AND item_id = ? AND status = 'active'`, client.id, kind, item.id)) throw conflict(`${first(client.name)} already has ${item.title}.`);
  if (kind === 'program' && ctx.db.get('SELECT id FROM assignments WHERE client_id = ? AND program_id = ? AND active = 1', client.id, item.id)) throw conflict(`${first(client.name)} is already on ${item.title}.`);
  const payer = payerFor(ctx, client.id);
  if (!payer.card_payment_method) throw conflict('Add a card on the Family tab first.');
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
  return { purchase: { id, kind, item_id: item.id, title: item.title, amount_cents: item.price_cents }, sale_id: sale.id };
}
