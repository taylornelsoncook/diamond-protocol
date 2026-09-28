import { newId, token, v, notFound, badRequest, conflict, HttpError, withLock, isDate, localDate, zonedToUtc, addDaysToDate, startOfLocalDay } from '../util.js';
import { emit } from './events.js';
import { payerFor, getSetting } from './families.js';
import { handleInvoiceCheckout } from './teams.js';
import { handlePayLinkCheckout } from './paylinks.js';
import { saleReceipt } from './notify.js';
import { retryWithNewCard } from './billing.js';
import { stockFields, stockSettings, pickVariant, stockForSale, activeVariants } from './inventory.js';

const KINDS = ['facility', 'mobile', 'park', 'client_home', 'other'];
const hasAddress = (l) => !!(l.address_line1 && l.city && l.state && l.postal_code);
const paymentError = (e) => new HttpError(502, 'payment_provider_error', `The payment service returned an error: ${e.message}`);

// ---------- Locations ----------
export function listLocations(ctx, { includeInactive = false } = {}) {
  return ctx.db.all(`SELECT * FROM locations ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY kind = 'facility' DESC, name`).map(shapeLocation);
}
const shapeLocation = (l) => ({ ...l, active: !!l.active, card_ready: !!l.stripe_location_id });
export function getLocation(ctx, id) {
  const l = ctx.db.get('SELECT * FROM locations WHERE id = ?', id);
  if (!l) throw notFound('Location');
  return shapeLocation(l);
}
function addressFrom(body, current = {}) {
  const pick = (k, max) => (body[k] !== undefined ? v.str(body[k], k, { max, optional: true }) : current[k] ?? null);
  return { address_line1: pick('address_line1', 200), city: pick('city', 100), state: pick('state', 50), postal_code: pick('postal_code', 20), country: (body.country ?? current.country ?? 'US').toUpperCase() };
}
// Two places or two products with the same name would be confused at the counter and in reports.
function uniqueName(ctx, table, name, id, what) {
  const other = ctx.db.get(`SELECT id, active FROM ${table} WHERE lower(name) = lower(?) AND id != ?`, name, id ?? '');
  if (other) throw conflict(`There's already a ${what} called ${name}${other.active ? '' : ` (${table === 'products' ? 'no longer sold: press Sell again to bring it back' : 'archived: press Restore to bring it back'})`}. Use a different name.`);
  return name;
}
export async function createLocation(ctx, body) {
  const loc = { id: newId('loc'), name: uniqueName(ctx, 'locations', v.str(body.name, 'name', { max: 80 }), null, 'location'), kind: v.oneOf(body.kind ?? 'other', 'kind', KINDS), ...addressFrom(body) };
  ctx.db.run(`INSERT INTO locations (id, name, kind, address_line1, city, state, postal_code, country, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    loc.id, loc.name, loc.kind, loc.address_line1, loc.city, loc.state, loc.postal_code, loc.country, ctx.now());
  if (hasAddress(loc)) await syncLocation(ctx, loc.id).catch(() => {});
  return getLocation(ctx, loc.id);
}
export async function updateLocation(ctx, id, body) {
  const cur = getLocation(ctx, id);
  const addr = addressFrom(body, cur);
  const addressChanged = ['address_line1', 'city', 'state', 'postal_code', 'country'].some((k) => addr[k] !== cur[k]);
  ctx.db.run(`UPDATE locations SET name = ?, kind = ?, address_line1 = ?, city = ?, state = ?, postal_code = ?, country = ?, active = ?, stripe_location_id = ? WHERE id = ?`,
    body.name !== undefined ? uniqueName(ctx, 'locations', v.str(body.name, 'name', { max: 80 }), id, 'location') : cur.name,
    body.kind !== undefined ? v.oneOf(body.kind, 'kind', KINDS) : cur.kind,
    addr.address_line1, addr.city, addr.state, addr.postal_code, addr.country,
    body.active !== undefined ? !!body.active : cur.active,
    addressChanged ? null : cur.stripe_location_id, id);
  if (addressChanged && hasAddress(addr)) await syncLocation(ctx, id).catch(() => {});
  return getLocation(ctx, id);
}
// Card payments need the location registered with the payment provider, which needs a street address.
export async function syncLocation(ctx, id) {
  const l = getLocation(ctx, id);
  if (l.stripe_location_id) return l.stripe_location_id;
  if (!hasAddress(l)) throw conflict(`Add a street address, city, state and ZIP to ${l.name} to take card payments there.`);
  let ref;
  try { ref = await ctx.payments.createLocation(l); } catch (e) { throw paymentError(e); }
  ctx.db.run('UPDATE locations SET stripe_location_id = ? WHERE id = ?', ref, id);
  return ref;
}

// ---------- Readers (front-desk smart readers) ----------
export function listReaders(ctx) {
  return ctx.db.all('SELECT r.*, l.name AS location_name FROM readers r JOIN locations l ON l.id = r.location_id ORDER BY r.created_at');
}
export async function registerReader(ctx, body) {
  const loc = getLocation(ctx, v.str(body.location_id, 'location_id'));
  const code = v.str(body.registration_code, 'registration_code', { max: 60 }).toLowerCase();
  const label = v.str(body.label, 'label', { max: 60 });
  const locationRef = await syncLocation(ctx, loc.id);
  const r = await ctx.payments.registerReader({ code, label, locationRef });
  if (!r.ok) throw badRequest(r.error, 'reader_registration_failed');
  const id = newId('rdr');
  ctx.db.run('INSERT INTO readers (id, label, location_id, provider_reader_id, device_type, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, label, loc.id, r.id, r.deviceType, ctx.now());
  return listReaders(ctx).find((x) => x.id === id);
}
export function removeReader(ctx, id) {
  if (!ctx.db.get('SELECT id FROM readers WHERE id = ?', id)) throw notFound('Reader');
  if (ctx.db.get(`SELECT id FROM sales WHERE reader_id = ? AND status = 'pending'`, id)) throw conflict('This reader has a payment in progress. Cancel it first.');
  ctx.db.run('UPDATE sales SET reader_id = NULL WHERE reader_id = ?', id);
  ctx.db.run('DELETE FROM readers WHERE id = ?', id);
  return { id, deleted: true };
}

// ---------- Products ----------
const PRODUCT_KINDS = ['session', 'pack', 'gear', 'other'];
const shapeProduct = (ctx, p) => ({ ...p, active: !!p.active, ...stockFields(ctx, p) });
export function listProducts(ctx, { includeInactive = false } = {}) {
  return ctx.db.all(`SELECT * FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY CASE kind WHEN 'session' THEN 0 WHEN 'pack' THEN 1 ELSE 2 END, price_cents`).map((p) => shapeProduct(ctx, p));
}
export function getProduct(ctx, id) {
  const p = ctx.db.get('SELECT * FROM products WHERE id = ?', id);
  if (!p) throw notFound('Product');
  return shapeProduct(ctx, p);
}
function productSessions(kind, sessions) {
  if (kind === 'session') return 1;
  if (kind === 'pack') return v.int(sessions, 'sessions', { min: 2, max: 500 });
  return 0;
}
const CREDIT_TYPES = ['private', 'group'];
export function createProduct(ctx, body) {
  if (!PRODUCT_KINDS.includes(body.kind)) throw badRequest('Choose the type of product: a single session, a session pack, gear or other.');
  const kind = body.kind;
  const id = newId('prod');
  const stock = stockSettings(ctx, ['session', 'pack'].includes(kind) ? {} : body);
  ctx.db.run('INSERT INTO products (id, name, kind, price_cents, sessions, credit_type, active, created_at, track_stock, low_stock_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
    id, uniqueName(ctx, 'products', v.str(body.name, 'name', { max: 80 }), null, 'product'), kind, v.int(body.price_cents, 'price_cents', { min: 0, max: 10000000 }), productSessions(kind, body.sessions),
    v.oneOf(body.credit_type ?? 'private', 'credit_type', CREDIT_TYPES), ctx.now(), stock.track_stock, stock.low_stock_at);
  return getProduct(ctx, id);
}
export function updateProduct(ctx, id, body) {
  const p = getProduct(ctx, id);
  const kind = body.kind !== undefined ? v.oneOf(body.kind, 'kind', PRODUCT_KINDS) : p.kind;
  const stock = stockSettings(ctx, ['session', 'pack'].includes(kind) ? { track_stock: false } : body, p);
  ctx.db.run('UPDATE products SET name = ?, kind = ?, price_cents = ?, sessions = ?, credit_type = ?, active = ?, track_stock = ?, low_stock_at = ? WHERE id = ?',
    body.name !== undefined ? uniqueName(ctx, 'products', v.str(body.name, 'name', { max: 80 }), id, 'product') : p.name, kind,
    body.price_cents !== undefined ? v.int(body.price_cents, 'price_cents', { min: 0, max: 10000000 }) : p.price_cents,
    productSessions(kind, body.sessions ?? p.sessions),
    body.credit_type !== undefined ? v.oneOf(body.credit_type, 'credit_type', CREDIT_TYPES) : p.credit_type,
    body.active !== undefined ? !!body.active : p.active, stock.track_stock, stock.low_stock_at, id);
  return getProduct(ctx, id);
}

// ---------- Cards on file ----------
function clientRow(ctx, id) {
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', id);
  if (!c) throw notFound('Client');
  return c;
}
// Cards live on the payer: the family for athletes with parents, otherwise the client.
async function ensureCustomer(ctx, payer) {
  if (payer.stripe_customer_id) return payer.stripe_customer_id;
  let id;
  try { id = await ctx.payments.ensureCustomer(payer); } catch (e) { throw paymentError(e); }
  ctx.db.run(`UPDATE ${payer.table} SET stripe_customer_id = ? WHERE id = ?`, id, payer.id);
  payer.stripe_customer_id = id;
  return id;
}
function saveCard(ctx, payer, { paymentMethod, brand, last4 }) {
  ctx.db.run(`UPDATE ${payer.table} SET card_payment_method = ?, card_brand = ?, card_last4 = ? WHERE id = ?`, paymentMethod ?? null, brand ?? null, last4 ?? null, payer.id);
  emit(ctx, 'client.card_updated', { [payer.metadataKey]: payer.id, client_name: payer.name, card_brand: paymentMethod ? brand ?? null : null, card_last4: paymentMethod ? last4 ?? null : null });
}
const payerById = (ctx, table, id) => {
  if (table === 'families') { const c = ctx.db.get('SELECT id FROM clients WHERE family_id = ? LIMIT 1', id); if (c) return payerFor(ctx, c.id); const f = ctx.db.get('SELECT * FROM families WHERE id = ?', id); return f && { table, id, name: f.name, metadataKey: 'family_id', ...f }; }
  return ctx.db.get('SELECT id FROM clients WHERE id = ?', id) ? payerFor(ctx, id) : null;
};
// A link the client or parent opens to add a card on Stripe's secure page.
export async function cardSetupLink(ctx, clientId, baseUrl) {
  const payer = payerFor(ctx, clientId);
  return setupLinkFor(ctx, payer, baseUrl);
}
export async function setupLinkFor(ctx, payer, baseUrl) {
  const customerId = await ensureCustomer(ctx, payer);
  let s;
  try { s = await ctx.payments.cardSetupSession({ customerId, ownerKey: payer.metadataKey, ownerId: payer.id, successUrl: `${baseUrl}/card-saved.html`, cancelUrl: `${baseUrl}/card-saved.html?canceled=1` }); }
  catch (e) { throw paymentError(e); }
  if (!s.url) throw conflict('Card links need Stripe. In test mode, use "Add test card".');
  return { url: s.url };
}
export async function addTestCard(ctx, clientId) {
  if (ctx.payments.live || !ctx.payments.testCard) throw conflict('Test cards are only available in test mode.');
  const payer = payerFor(ctx, clientId);
  await ensureCustomer(ctx, payer);
  saveCard(ctx, payer, ctx.payments.testCard());
  await retryFailed(ctx, payer);
  return cardSummary(ctx, clientId);
}
// A new card pays any membership payment that failed on the old one.
const retryFailed = (ctx, payer) => retryWithNewCard(ctx, payer.table === 'families' ? { familyId: payer.id } : { clientId: payer.id }).catch((e) => console.error('retry', e.message));
export function removeCard(ctx, clientId) {
  saveCard(ctx, payerFor(ctx, clientId), {});
  return cardSummary(ctx, clientId);
}
export function cardSummary(ctx, clientId) {
  const p = payerFor(ctx, clientId);
  return p.card_payment_method ? { on_file: true, brand: p.card_brand, last4: p.card_last4, owner: p.table === 'families' ? 'family' : 'client' } : { on_file: false, owner: p.table === 'families' ? 'family' : 'client' };
}

// ---------- Session credits and check-ins ----------
export const creditBalance = (ctx, clientId, type) => type
  ? ctx.db.get('SELECT COALESCE(SUM(delta), 0) AS n FROM session_credits WHERE client_id = ? AND credit_type = ?', clientId, type).n
  : ctx.db.get('SELECT COALESCE(SUM(delta), 0) AS n FROM session_credits WHERE client_id = ?', clientId).n;
export const creditBalances = (ctx, clientId) => ({ private: creditBalance(ctx, clientId, 'private'), group: creditBalance(ctx, clientId, 'group') });

export function adjustCredits(ctx, clientId, body) {
  clientRow(ctx, clientId);
  const delta = v.int(body.delta, 'delta', { min: -500, max: 500 });
  const type = v.oneOf(body.credit_type ?? 'private', 'credit_type', CREDIT_TYPES);
  if (delta === 0) throw badRequest('delta cannot be zero.');
  if (creditBalance(ctx, clientId, type) + delta < 0) throw conflict('That would leave a negative session balance.');
  ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, note, created_at) VALUES (?, ?, ?, ?, 'adjustment', ?, ?)`,
    newId('cr'), clientId, type, delta, v.str(body.note, 'note', { max: 200, optional: true }), ctx.now());
  return { balance: creditBalance(ctx, clientId, type), credits: creditBalances(ctx, clientId) };
}

// Walk-in check-in (no booking). Members train group sessions on their membership; otherwise a credit of that type is used.
export function checkIn(ctx, clientId, body) {
  const c = clientRow(ctx, clientId);
  if (c.archived_at) throw conflict(`${c.name} is archived. Restore them on their client page before checking them in.`);
  const loc = getLocation(ctx, v.str(body.location_id, 'location_id'));
  const type = v.oneOf(body.credit_type ?? 'group', 'credit_type', CREDIT_TYPES);
  const sub = ctx.db.get(`SELECT status FROM subscriptions WHERE client_id = ? AND status IN ('active','trialing','past_due') LIMIT 1`, clientId);
  let covered = 'membership';
  const id = newId('chk');
  ctx.db.tx(() => {
    if (!(sub && type === 'group')) {
      if (creditBalance(ctx, clientId, type) < 1) throw conflict(`${c.name.split(' ')[0]} has no ${type} sessions left. Sell a session or pack${type === 'group' ? ', or start a membership' : ''}.`);
      covered = 'credit';
      ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, note, created_at) VALUES (?, ?, ?, -1, 'check_in', ?, ?)`, newId('cr'), clientId, type, loc.name, ctx.now());
    }
    ctx.db.run('INSERT INTO check_ins (id, client_id, location_id, covered_by, created_at) VALUES (?, ?, ?, ?, ?)', id, clientId, loc.id, covered, ctx.now());
    emit(ctx, 'session.checked_in', { check_in_id: id, client_id: clientId, client_name: c.name, location_id: loc.id, location_name: loc.name, covered_by: covered, credit_type: type });
  });
  return { id, covered_by: covered, credit_type: type, credits_left: creditBalance(ctx, clientId, type), credits: creditBalances(ctx, clientId) };
}
export function listCheckIns(ctx, { clientId, limit = 50 } = {}) {
  return ctx.db.all(
    `SELECT k.*, c.name AS client_name, l.name AS location_name FROM check_ins k JOIN clients c ON c.id = k.client_id JOIN locations l ON l.id = k.location_id
     ${clientId ? 'WHERE k.client_id = ?' : ''} ORDER BY k.created_at DESC LIMIT ?`, ...(clientId ? [clientId, limit] : [limit]));
}

// ---------- Sales ----------
const METHODS = ['tap_to_pay', 'reader', 'card_on_file', 'cash'];
export const METHOD_LABEL = { tap_to_pay: 'Tap to Pay', reader: 'Front-desk reader', card_on_file: 'Card on file', cash: 'Cash', online: 'Online' };
export const UNDO_MINUTES = 10;            // the person who rang up a sale can undo it this long after it was paid
const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: Math.abs(c) % 100 ? 2 : 0 })}`;

// Undo is for "I rang that up wrong": only the person who took the sale, only while nothing has been refunded,
// and only for UNDO_MINUTES after it was paid. The screen gets the seconds left so it can hide the button in time.
function undoInfo(ctx, s, userId) {
  if (!userId || s.created_by !== userId || s.status !== 'succeeded' || s.refunded_cents || !s.completed_at) return { can_undo: false };
  const left = Math.floor((Date.parse(s.completed_at) + UNDO_MINUTES * 60000 - Date.parse(ctx.now())) / 1000);
  return left > 0 ? { can_undo: true, undo_seconds_left: left } : { can_undo: false };
}

export function getSale(ctx, id, { withSecret = false, userId } = {}) {
  const s = ctx.db.get(
    `SELECT s.*, c.name AS client_name, l.name AS location_name, l.stripe_location_id, r.label AS reader_label, u.name AS created_by_name
     FROM sales s LEFT JOIN clients c ON c.id = s.client_id JOIN locations l ON l.id = s.location_id LEFT JOIN readers r ON r.id = s.reader_id LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?`, id);
  if (!s) throw notFound('Sale');
  s.items = ctx.db.all('SELECT id, product_id, variant_id, name, unit_price_cents, quantity, sessions FROM sale_items WHERE sale_id = ?', id);
  s.save_card = !!s.save_card;
  s.subtotal_cents = s.amount_cents + s.discount_cents;
  s.method_label = METHOD_LABEL[s.method] ?? s.method;
  s.refunds = ctx.db.all('SELECT r.amount_cents, r.kind, r.reason, r.created_at, u.name AS by_name FROM sale_refunds r LEFT JOIN users u ON u.id = r.created_by WHERE r.sale_id = ? ORDER BY r.created_at', id);
  // The printable receipt: a private link, only once the sale is paid.
  s.receipt_url = s.receipt_token && ['succeeded', 'partially_refunded', 'refunded'].includes(s.status) ? `${ctx.publicUrl ?? ''}/receipt/${s.receipt_token}` : null;
  Object.assign(s, undoInfo(ctx, s, userId));
  const secret = s.client_secret;
  delete s.client_secret; delete s.receipt_token; delete s.receipt_opt; delete s.request_id;
  // The iPhone app needs these two values to collect a Tap to Pay payment.
  if (withSecret && s.status === 'pending' && s.method === 'tap_to_pay') s.tap_to_pay = { client_secret: secret, location_ref: s.stripe_location_id };
  delete s.stripe_location_id;
  return s;
}
// days=1 is today since midnight in the business's time zone, days=7 today and the 6 days before, and so on.
export function salesSince(ctx, days) {
  const zone = getSetting(ctx, 'timezone'), today = localDate(ctx.now(), zone);
  return startOfLocalDay(zonedToUtc(addDaysToDate(today, -(days - 1)), '12:00', zone), zone);
}
const likeText = (q) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
export function listSales(ctx, { since, days, q, locationId, clientId, status, createdBy, userId, limit = 100 } = {}) {
  const where = [], p = [];
  if (days !== undefined) since = salesSince(ctx, v.int(days, 'days', { min: 1, max: 366 }));
  if (createdBy) { where.push('s.created_by = ?'); p.push(createdBy); }
  if (since) { where.push('s.created_at >= ?'); p.push(since); }
  if (locationId) { where.push('s.location_id = ?'); p.push(locationId); }
  if (clientId) { where.push('s.client_id = ?'); p.push(clientId); }
  if (status) { where.push('s.status = ?'); p.push(status); }
  if (q && String(q).trim()) {
    const like = likeText(String(q).trim().slice(0, 80));
    where.push(`(c.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = s.id AND i.name LIKE ? ESCAPE '\\'))`); p.push(like, like);
  }
  return ctx.db.all(
    `SELECT s.id, s.client_id, c.name AS client_name, s.location_id, l.name AS location_name, s.method, s.status, s.amount_cents, s.refunded_cents, s.discount_cents, s.discount_reason,
       s.card_brand, s.card_last4, s.failure_reason, s.created_at, s.completed_at, s.created_by, u.name AS created_by_name, s.receipt_sent_at,
       (SELECT GROUP_CONCAT(CASE WHEN quantity > 1 THEN quantity || ' × ' || name ELSE name END, ', ') FROM sale_items i WHERE i.sale_id = s.id) AS description
     FROM sales s LEFT JOIN clients c ON c.id = s.client_id JOIN locations l ON l.id = s.location_id LEFT JOIN users u ON u.id = s.created_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`, ...p, Math.min(Math.max(Number(limit) || 100, 1), 200))
    .map((s) => ({ ...s, method_label: METHOD_LABEL[s.method] ?? s.method, ...undoInfo(ctx, s, userId) }));
}

// A discount on the whole sale: a percent (1 to 100) or an amount off, always with a reason, and never the whole sale.
// Owners give any discount; coaches and front desk up to the owner's limit (staff_discount_max_pct; 0 = owners only).
function parseDiscount(ctx, d, subtotal, role) {
  if (d === undefined || d === null) return { cents: 0, reason: null };
  if (typeof d !== 'object' || Array.isArray(d)) throw badRequest('discount must be { type: "percent" or "amount", value, reason }.');
  const type = v.oneOf(d.type, 'discount.type', ['percent', 'amount']);
  const pct = type === 'percent' ? v.int(d.value, 'discount.value', { min: 1, max: 100 }) : null;
  const cents = pct ? Math.round(subtotal * pct / 100) : v.int(d.value, 'discount.value', { min: 1, max: 10000000 });
  if (typeof d.reason !== 'string' || !d.reason.trim()) throw badRequest('Say why you\'re giving the discount, like "Sibling discount" or "Damaged box".');
  const reason = v.str(d.reason, 'discount.reason', { max: 80 });
  if (cents < 1) throw badRequest('That discount comes to less than a cent. Enter a bigger one or remove it.');
  if (cents >= subtotal) throw badRequest(`A discount has to leave something to pay. The sale is ${money(subtotal)} before the discount.`);
  if (role && role !== 'owner') {
    const max = Number(getSetting(ctx, 'staff_discount_max_pct'));
    if (!(max > 0)) throw new HttpError(403, 'forbidden', 'Only the owner can give discounts. Ask the owner, who can allow them in Point of sale setup.');
    if (pct ? pct > max : cents * 100 > subtotal * max) throw new HttpError(403, 'forbidden', `You can give up to ${max}% off (${money(Math.floor(subtotal * max / 100))} on this sale). Ask the owner for a bigger discount.`);
  }
  return { cents, reason };
}

export { payerById };

// request_id (from the sale screen): a second press of Charge, or a retry after a dropped connection, gets the first
// sale back instead of charging again. The screen makes a new one for each new sale.
export async function createSale(ctx, body, actor, opts = {}) {
  const key = v.str(body.request_id, 'request_id', { max: 64, optional: true });
  if (!key) return createSaleNow(ctx, body, actor, opts, null);
  return withLock(`sale-request:${key}`, async () => {
    const prev = ctx.db.get('SELECT id FROM sales WHERE request_id = ? AND COALESCE(created_by, \'\') = ?', key, actor ?? '');
    if (prev) return { ...getSale(ctx, prev.id, { withSecret: true, userId: opts.userId }), repeated: true };
    return createSaleNow(ctx, body, actor, opts, key);
  });
}
async function createSaleNow(ctx, body, actor, { online = false, counter = false, role, userId } = {}, requestId) {
  const method = v.oneOf(body.method, 'method', METHODS);
  const loc = getLocation(ctx, v.str(body.location_id, 'location_id'));
  if (!loc.active && !online) throw conflict(`${loc.name} is archived. Choose another location.`);
  const client = body.client_id ? clientRow(ctx, v.str(body.client_id, 'client_id')) : null;
  if (counter && client?.archived_at) throw conflict(`${client.name} is archived. Restore them on their client page, or sell to a walk-in.`);

  const lines = [];
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const p = getProduct(ctx, v.str(it.product_id, 'product_id'));
    if (!p.active) throw conflict(`${p.name} is no longer sold.`);
    const size = pickVariant(ctx, p, it.variant_id);
    lines.push({ product_id: p.id, variant_id: size?.id ?? null, name: size ? `${p.name} (${size.name})` : p.name, unit: p.price_cents, qty: v.int(it.quantity ?? 1, 'quantity', { min: 1, max: 99 }), sessions: p.sessions });
  }
  if (body.custom) lines.push({ product_id: null, name: v.str(body.custom.description, 'custom.description', { max: 80 }), unit: v.int(body.custom.amount_cents, 'custom.amount_cents', { min: 1, max: 10000000 }), qty: 1, sessions: 0 });
  if (!lines.length) throw badRequest('Add at least one item to the sale.');
  if (!client && lines.some((l) => l.sessions > 0)) throw badRequest('Choose a client. Sessions and packs are added to their account.');
  const subtotal = lines.reduce((t, l) => t + l.unit * l.qty, 0);
  if (subtotal <= 0) throw badRequest('The sale total must be more than $0.');
  const discount = parseDiscount(ctx, body.discount, subtotal, role);
  const amount = subtotal - discount.cents;

  const wantsSave = !!body.save_card && ['tap_to_pay', 'reader'].includes(method);
  if (wantsSave && !client) throw badRequest('Choose a client to save their card.');
  let reader = null;
  if (method === 'reader') {
    reader = ctx.db.get('SELECT * FROM readers WHERE id = ?', v.str(body.reader_id, 'reader_id'));
    if (!reader) throw notFound('Reader');
    if (reader.location_id !== loc.id) throw conflict(`${reader.label} is at ${getLocation(ctx, reader.location_id).name}, not ${loc.name}. Choose the reader where you are, or another way to pay.`);
    if (ctx.db.get(`SELECT id FROM sales WHERE reader_id = ? AND status = 'pending'`, reader.id)) throw conflict(`${reader.label} is busy with another payment. Finish or cancel it first.`);
  }
  const payer = client ? payerFor(ctx, client.id) : null;
  if (method === 'card_on_file' && !payer?.card_payment_method) throw conflict(client ? `${client.name.split(' ')[0]} has no card on file${payer.table === 'families' ? ' for the family' : ''}.` : 'Choose a client with a card on file.');
  // Receipt: email_receipt true sends one (to receipt_email, or the family's billing email), false sends none,
  // left out follows the automatic-receipt setting.
  const receiptOpt = body.email_receipt === undefined || body.email_receipt === null ? null : body.email_receipt ? 1 : 0;
  const receiptEmail = receiptOpt === 1 && body.receipt_email ? v.email(body.receipt_email, 'receipt_email') : null;
  if (receiptOpt === 1 && !receiptEmail && !payer?.email) throw badRequest(client ? `There's no email on file for ${client.name.split(' ')[0]}${payer.table === 'families' ? '\'s family' : ''}. Type one in for the receipt, or untick Email a receipt.` : 'Type an email address for the receipt, or untick Email a receipt.');

  const id = newId('sale');
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO sales (id, client_id, location_id, method, status, amount_cents, save_card, reader_id, note, created_by, created_at, discount_cents, discount_reason, request_id, receipt_opt, receipt_email, receipt_token)
                VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, client?.id, loc.id, method, amount, wantsSave, reader?.id, v.str(body.note, 'note', { max: 200, optional: true }), actor ?? null, ctx.now(),
      discount.cents, discount.reason, requestId, receiptOpt, receiptEmail, token(18));
    for (const l of lines) ctx.db.run('INSERT INTO sale_items (id, sale_id, product_id, variant_id, name, unit_price_cents, quantity, sessions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('si'), id, l.product_id, l.variant_id ?? null, l.name, l.unit, l.qty, l.sessions);
  });
  const description = `${lines.map((l) => l.name).join(', ')}${discount.cents ? ` less ${money(discount.cents)} discount` : ''}`.slice(0, 200);
  const metadata = { sale_id: id, location: loc.name, ...(client ? { client_id: client.id } : {}) };

  if (method === 'cash') {
    completeSale(ctx, id, {});
  } else if (method === 'card_on_file') {
    const r = await ctx.payments.chargeSaved({ client: payer, amountCents: amount, description, idempotencyKey: `sale-${id}`, metadata });
    if (r.ok) { ctx.db.run('UPDATE sales SET payment_ref = ? WHERE id = ?', r.ref, id); completeSale(ctx, id, { card: { brand: payer.card_brand, last4: payer.card_last4 } }); }
    else failSale(ctx, id, r.error);
  } else {
    try {
      const locationRef = await syncLocation(ctx, loc.id);
      const customerId = payer && wantsSave ? await ensureCustomer(ctx, payer) : payer?.stripe_customer_id ?? null;
      const intent = await ctx.payments.createInPersonIntent({ amountCents: amount, customerId, saveCard: wantsSave, description, metadata, idempotencyKey: `sale-${id}` });
      ctx.db.run('UPDATE sales SET payment_ref = ?, client_secret = ? WHERE id = ?', intent.id, intent.clientSecret, id);
      void locationRef;
      if (reader) {
        const r = await ctx.payments.processOnReader(reader.provider_reader_id, intent.id);
        if (!r.ok) { await ctx.payments.cancelIntent(intent.id).catch(() => {}); failSale(ctx, id, `The reader could not start the payment: ${r.error}`); }
      }
    } catch (e) {
      failSale(ctx, id, e.message);
      if (e instanceof HttpError) throw e;
      throw paymentError(e);
    }
  }
  return getSale(ctx, id, { withSecret: true, userId });
}

function failSale(ctx, id, reason) {
  const s = ctx.db.get('SELECT * FROM sales WHERE id = ?', id);
  const r = ctx.db.run(`UPDATE sales SET status = 'failed', failure_reason = ?, completed_at = ? WHERE id = ? AND status = 'pending'`, reason, ctx.now(), id);
  if (r.changes) {
    const c = s.client_id ? clientRow(ctx, s.client_id) : null;
    emit(ctx, 'sale.failed', { sale_id: id, client_id: s.client_id, client_name: c?.name ?? 'Walk-in', amount_cents: s.amount_cents, method: s.method, reason });
  }
}

// A sale taken for an unpaid booking (at the session) marks it paid; for a camp, every day of the registration.
function settleBooking(ctx, bookingId, saleId) {
  const b = ctx.db.get(`SELECT b.*, s.series_id FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.id = ?`, bookingId);
  if (!b || b.coverage !== 'unpaid') return;
  const reg = b.series_id && ctx.db.get(`SELECT id FROM enrollments WHERE series_id = ? AND client_id = ? AND kind = 'registration' AND status = 'active'`, b.series_id, b.client_id);
  if (reg) {
    ctx.db.run(`UPDATE enrollments SET sale_id = ? WHERE id = ?`, saleId, reg.id);
    ctx.db.run(`UPDATE bookings SET coverage = 'registration', sale_id = ?, updated_at = ? WHERE enrollment_id = ? AND coverage = 'unpaid'`, saleId, ctx.now(), reg.id);
  } else {
    ctx.db.run(`UPDATE bookings SET coverage = 'paid', sale_id = ?, updated_at = ? WHERE id = ?`, saleId, ctx.now(), bookingId);
  }
}

function creditsInSale(ctx, s) {
  const out = { private: 0, group: 0 };
  for (const i of s.items) {
    if (!i.sessions) continue;
    const type = i.product_id ? ctx.db.get('SELECT credit_type FROM products WHERE id = ?', i.product_id)?.credit_type ?? 'private' : 'private';
    out[type] += i.sessions * i.quantity;
  }
  return out;
}

function completeSale(ctx, id, { card, savedCard }) {
  let completed = false;
  ctx.db.tx(() => {
    const r = ctx.db.run(`UPDATE sales SET status = 'succeeded', completed_at = ?, card_brand = ?, card_last4 = ?, failure_reason = NULL WHERE id = ? AND status = 'pending'`,
      ctx.now(), card?.brand ?? null, card?.last4 ?? null, id);
    if (!r.changes) return;          // already completed by the other path (app sync vs. webhook)
    completed = true;
    const s = getSale(ctx, id);
    const byType = creditsInSale(ctx, s);
    const sessions = byType.private + byType.group;
    if (s.client_id) for (const type of CREDIT_TYPES) if (byType[type] > 0) {
      ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, sale_id, created_at) VALUES (?, ?, ?, ?, 'purchase', ?, ?)`, newId('cr'), s.client_id, type, byType[type], id, ctx.now());
    }
    if (s.client_id && s.save_card && savedCard) saveCard(ctx, payerFor(ctx, s.client_id), { paymentMethod: savedCard, brand: card?.brand, last4: card?.last4 });
    if (s.note?.startsWith('booking:')) settleBooking(ctx, s.note.slice(8), id);
    stockForSale(ctx, id, -1, 'sale');
    emit(ctx, 'sale.completed', {
      sale_id: id, client_id: s.client_id, client_name: s.client_name ?? 'Walk-in', location_id: s.location_id, location_name: s.location_name,
      amount_cents: s.amount_cents, discount_cents: s.discount_cents, method: s.method, items: s.items.map((i) => ({ name: i.name, quantity: i.quantity })), sessions_added: sessions
    });
  });
  if (completed) saleReceipt(ctx, id).catch((e) => console.error('receipt', e.message));
  if (completed && savedCard) { const s = ctx.db.get('SELECT client_id, save_card FROM sales WHERE id = ?', id); if (s.client_id && s.save_card) retryFailed(ctx, payerFor(ctx, s.client_id)); }
}

// Online sales need a sales location; one named "Online" is created the first time.
export function onlineLocation(ctx) {
  const l = ctx.db.get(`SELECT id FROM locations WHERE name = 'Online' AND kind = 'other'`);
  if (l) return l.id;
  const id = newId('loc');
  ctx.db.run(`INSERT INTO locations (id, name, kind, country, active, created_at) VALUES (?, 'Online', 'other', 'US', 0, ?)`, id, ctx.now());
  return id;
}
// A payment that already happened online (a pay link): record it as a sale so it shows in sales, reports and receipts,
// adds any sessions from a pack, and settles an unpaid booking (note 'booking:<id>').
export function recordOnlineSale(ctx, { clientId, productId, description, amountCents, note, paymentRef, actor }) {
  const id = newId('sale');
  const p = productId ? ctx.db.get('SELECT * FROM products WHERE id = ?', productId) : null;
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO sales (id, client_id, location_id, method, status, amount_cents, payment_ref, note, created_by, created_at) VALUES (?, ?, ?, 'online', 'pending', ?, ?, ?, ?, ?)`,
      id, clientId ?? null, onlineLocation(ctx), amountCents, paymentRef ?? null, note ?? null, actor ?? 'Pay link', ctx.now());
    const sizes = p ? activeVariants(ctx, p.id) : [];
    ctx.db.run('INSERT INTO sale_items (id, sale_id, product_id, variant_id, name, unit_price_cents, quantity, sessions) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', newId('si'), id, p?.id ?? null, sizes.length === 1 ? sizes[0].id : null, description.slice(0, 80), amountCents, p?.sessions ?? 0);
  });
  completeSale(ctx, id, {});
  return id;
}

// Ask the payment provider where an in-person payment stands and record the result.
// Called by the iPhone app after a tap, by the dashboard while waiting on a reader, and by Stripe webhooks.
export async function syncSale(ctx, id) {
  const s = ctx.db.get('SELECT * FROM sales WHERE id = ?', id);
  if (!s) throw notFound('Sale');
  if (s.status !== 'pending' || !s.payment_ref) return getSale(ctx, id);
  let i;
  try {
    i = await ctx.payments.getIntent(s.payment_ref);
    if (i.status === 'requires_capture') { await ctx.payments.captureIntent(s.payment_ref); i = await ctx.payments.getIntent(s.payment_ref); }
  } catch (e) { throw paymentError(e); }
  if (i.status === 'succeeded') completeSale(ctx, id, { card: i.card, savedCard: i.savedCard });
  else if (i.status === 'canceled') ctx.db.run(`UPDATE sales SET status = 'canceled', completed_at = ? WHERE id = ? AND status = 'pending'`, ctx.now(), id);
  else if (i.status === 'requires_payment_method' && i.error) failSale(ctx, id, i.error);
  return getSale(ctx, id, { withSecret: true });
}

export async function cancelSale(ctx, id) {
  const s = ctx.db.get('SELECT * FROM sales WHERE id = ?', id);
  if (!s) throw notFound('Sale');
  if (s.status !== 'pending') throw conflict('Only a payment in progress can be canceled.');
  if (s.payment_ref) {
    const latest = await syncSale(ctx, id);
    if (latest.status !== 'pending') return latest;        // it completed before we could cancel
    if (s.reader_id) { const r = ctx.db.get('SELECT provider_reader_id FROM readers WHERE id = ?', s.reader_id); if (r) await ctx.payments.cancelReaderAction(r.provider_reader_id); }
    try { await ctx.payments.cancelIntent(s.payment_ref); } catch (e) { throw paymentError(e); }
  }
  ctx.db.run(`UPDATE sales SET status = 'canceled', completed_at = ? WHERE id = ? AND status = 'pending'`, ctx.now(), id);
  return getSale(ctx, id);
}

// One refund (or undo) per sale at a time, so two presses can't put stock back, take credits away or pay back twice.
export function refundSale(ctx, id, body = {}, { actor } = {}) { return withLock(`sale:${id}`, () => refundNow(ctx, id, body, { actor })); }
async function refundNow(ctx, id, body, { actor, kind = 'refund' } = {}) {
  const s = getSale(ctx, id);
  if (!['succeeded', 'partially_refunded'].includes(s.status)) throw conflict(s.status === 'refunded' ? 'This sale has already been refunded in full.' : 'Only a completed sale can be refunded.');
  const remaining = s.amount_cents - s.refunded_cents;
  const amount = body.amount_cents !== undefined ? v.int(body.amount_cents, 'amount_cents', { min: 1, max: remaining }) : remaining;
  const reason = v.str(body.reason, 'reason', { max: 120, optional: true });
  if (s.method !== 'cash') {
    const r = await ctx.payments.refund({ paymentRef: s.payment_ref, amountCents: amount, idempotencyKey: `refund-${id}-${s.refunded_cents + amount}` });
    if (!r.ok) throw new HttpError(502, 'refund_failed', `The refund didn't go through: ${r.error}`);
  }
  const total = s.refunded_cents + amount;
  const full = total >= s.amount_cents;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE sales SET refunded_cents = ?, status = ? WHERE id = ?', total, full ? 'refunded' : 'partially_refunded', id);
    ctx.db.run('INSERT INTO sale_refunds (id, sale_id, amount_cents, kind, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('ref'), id, amount, kind, reason, actor ?? null, ctx.now());
    // An undone sale never happened: a session or camp it paid for at the counter is unpaid again.
    if (kind === 'undo') {
      ctx.db.run(`UPDATE enrollments SET sale_id = NULL WHERE sale_id = ?`, id);
      ctx.db.run(`UPDATE bookings SET coverage = 'unpaid', sale_id = NULL, updated_at = ? WHERE sale_id = ? AND coverage IN ('paid','registration') AND status != 'canceled'`, ctx.now(), id);
    }
    let removed = 0;
    if (full && s.client_id) {
      const bought = creditsInSale(ctx, s);
      for (const type of CREDIT_TYPES) {
        const n = Math.min(bought[type], creditBalance(ctx, s.client_id, type));      // sessions already used stay used
        if (n > 0) { ctx.db.run(`INSERT INTO session_credits (id, client_id, credit_type, delta, reason, sale_id, created_at) VALUES (?, ?, ?, ?, 'refund', ?, ?)`, newId('cr'), s.client_id, type, -n, id, ctx.now()); removed += n; }
      }
    }
    // Gear comes back on the shelf with a full refund, unless it can't be sold again (restock: false).
    const restocked = full && body.restock !== false ? stockForSale(ctx, id, 1, 'refund') : 0;
    // A program or course bought online ends with a full refund: the athlete comes off the program (or the course locks).
    if (full) for (const b of ctx.db.all(`SELECT * FROM purchases WHERE sale_id = ? AND status = 'active'`, id)) {
      ctx.db.run(`UPDATE purchases SET status = 'refunded', refunded_at = ? WHERE id = ?`, ctx.now(), b.id);
      if (b.item_kind === 'program') ctx.db.run('UPDATE assignments SET active = 0 WHERE client_id = ? AND program_id = ? AND active = 1', b.client_id, b.item_id);
    }
    emit(ctx, 'sale.refunded', { sale_id: id, client_id: s.client_id, client_name: s.client_name ?? 'Walk-in', amount_cents: amount, total_refunded_cents: total, full, sessions_removed: removed, items_restocked: restocked, method: s.method, undo: kind === 'undo', reason });
  });
  return getSale(ctx, id, { userId: actor });
}

// "I rang that up wrong": a full refund by the person who took the sale, within UNDO_MINUTES of it being paid.
// It takes the same lock as a refund, so an undo and a refund of the same sale can't both pay money back.
export function undoSale(ctx, id, user) {
  return withLock(`sale:${id}`, async () => {
    const s = ctx.db.get('SELECT * FROM sales WHERE id = ?', id);
    if (!s) throw notFound('Sale');
    const refundInstead = user?.role === 'owner' ? 'Refund it instead.' : 'Ask the owner for a refund.';
    if (!user || s.created_by !== user.id) throw conflict(`Only the person who took this sale can undo it. ${refundInstead}`);
    if (s.status === 'pending') throw conflict('This payment is still waiting for the card. Cancel it instead.');
    if (s.status !== 'succeeded' || s.refunded_cents) throw conflict(s.status === 'refunded' || s.refunded_cents ? `This sale has already been refunded${s.status === 'refunded' ? '' : ' in part'}. ${refundInstead}` : 'Only a completed sale can be undone.');
    if (!undoInfo(ctx, s, user.id).can_undo) throw conflict(`Sales can be undone for ${UNDO_MINUTES} minutes after they're paid. ${refundInstead}`);
    return refundNow(ctx, id, { reason: 'Undone at the counter' }, { actor: user.id, kind: 'undo' });
  });
}

// ---------- Receipts ----------
// Email (or re-send) a sale's receipt, by hand from the sale screen: to the address typed, or the family's billing email,
// or the address the counter typed when the sale was taken. Sent even when automatic receipts are turned off.
export async function emailReceipt(ctx, id, body = {}) {
  const s = ctx.db.get('SELECT * FROM sales WHERE id = ?', id);
  if (!s) throw notFound('Sale');
  if (!['succeeded', 'partially_refunded', 'refunded'].includes(s.status)) throw conflict(s.status === 'pending' ? 'This payment is still waiting for the card. The receipt goes out once it\'s paid.' : 'That payment didn\'t go through, so there\'s no receipt.');
  const typed = body.email ? v.email(body.email, 'email') : null;
  const to = typed ?? (s.client_id ? payerFor(ctx, s.client_id).email : null) ?? s.receipt_email;
  if (!to) throw badRequest(s.client_id ? 'There\'s no email on file for this client. Type one in for the receipt.' : 'Type an email address for the receipt.');
  await saleReceipt(ctx, id, { to, force: true });
  return { ...getSale(ctx, id), receipt_to: to };
}
// The printable receipt behind the link in the email (no sign-in; the link is the key). No contact details or card numbers beyond the last 4.
export function publicReceipt(ctx, receiptToken) {
  const s = ctx.db.get('SELECT id FROM sales WHERE receipt_token = ?', String(receiptToken ?? ''));
  const sale = s && getSale(ctx, s.id);
  if (!sale || !['succeeded', 'partially_refunded', 'refunded'].includes(sale.status)) throw notFound('Receipt');
  return {
    id: sale.id, business_name: getSetting(ctx, 'business_name'), business_address: getSetting(ctx, 'business_address') || null, timezone: getSetting(ctx, 'timezone'),
    paid_at: sale.completed_at ?? sale.created_at, location_name: sale.location_name, client_name: sale.client_name ?? null, method_label: sale.method_label, card_last4: sale.card_last4 ?? null,
    items: sale.items.map((i) => ({ name: i.name, quantity: i.quantity, unit_price_cents: i.unit_price_cents })),
    subtotal_cents: sale.subtotal_cents, discount_cents: sale.discount_cents, discount_reason: sale.discount_reason, amount_cents: sale.amount_cents, refunded_cents: sale.refunded_cents, status: sale.status
  };
}

// ---------- The day's takings (closing the drawer) ----------
// Sales paid between midnight and midnight in the business's time zone, and refunds made that day (a refund counts on
// the day the money went back, whichever day the sale was). Cash to count = cash taken minus cash handed back.
export function takings(ctx, { date, locationId } = {}) {
  const zone = getSetting(ctx, 'timezone');
  const day = date === undefined || date === '' ? localDate(ctx.now(), zone) : String(date);
  if (!isDate(day)) throw badRequest('Choose a real date, like 2026-09-27.');
  let loc = null;
  if (locationId !== undefined && locationId !== '') {
    loc = ctx.db.get('SELECT id, name FROM locations WHERE id = ?', String(locationId));
    if (!loc) throw badRequest('That location doesn\'t exist. Choose one from the list, or leave it blank for all locations.');
  }
  const from = startOfLocalDay(zonedToUtc(day, '12:00', zone), zone), to = startOfLocalDay(zonedToUtc(addDaysToDate(day, 1), '12:00', zone), zone);
  const at = loc ? 'AND s.location_id = ?' : '', p = loc ? [loc.id] : [];
  const sales = ctx.db.all(`SELECT s.method, s.amount_cents, s.discount_cents FROM sales s WHERE s.status IN ('succeeded','partially_refunded','refunded') AND s.completed_at >= ? AND s.completed_at < ? ${at}`, from, to, ...p);
  const refunds = ctx.db.all(`SELECT s.method, r.amount_cents FROM sale_refunds r JOIN sales s ON s.id = r.sale_id WHERE r.created_at >= ? AND r.created_at < ? ${at}`, from, to, ...p);
  const by = Object.fromEntries(Object.keys(METHOD_LABEL).map((m) => [m, { method: m, label: METHOD_LABEL[m], sales: 0, taken_cents: 0, refunds: 0, refunded_cents: 0, net_cents: 0 }]));
  const out = { date: day, timezone: zone, from, to, location_id: loc?.id ?? null, location_name: loc?.name ?? null, sales: 0, taken_cents: 0, discount_cents: 0, discounted_sales: 0, refunds: 0, refunded_cents: 0, net_cents: 0 };
  for (const s of sales) { const m = by[s.method]; m.sales++; m.taken_cents += s.amount_cents; out.sales++; out.taken_cents += s.amount_cents; out.discount_cents += s.discount_cents; if (s.discount_cents) out.discounted_sales++; }
  for (const r of refunds) { const m = by[r.method]; m.refunds++; m.refunded_cents += r.amount_cents; out.refunds++; out.refunded_cents += r.amount_cents; }
  for (const m of Object.values(by)) m.net_cents = m.taken_cents - m.refunded_cents;
  out.net_cents = out.taken_cents - out.refunded_cents;
  out.cash_cents = by.cash.net_cents;
  out.card_cents = by.tap_to_pay.net_cents + by.reader.net_cents + by.card_on_file.net_cents;
  out.online_cents = by.online.net_cents;
  out.by_method = Object.values(by).filter((m) => m.sales || m.refunds || m.method !== 'online');
  return out;
}

// Test mode only: stand in for the client tapping their card.
export async function simulateTap(ctx, id, outcome) {
  if (ctx.payments.live || !ctx.payments.simulate) throw conflict('Simulated taps are only available in test mode.');
  const s = ctx.db.get('SELECT * FROM sales WHERE id = ?', id);
  if (!s) throw notFound('Sale');
  if (s.status !== 'pending' || !s.payment_ref) throw conflict('This sale is not waiting for a card.');
  ctx.payments.simulate(s.payment_ref, v.oneOf(outcome ?? 'approved', 'outcome', ['approved', 'declined']));
  return syncSale(ctx, id);
}

export async function connectionToken(ctx, locationId) {
  const ref = locationId ? await syncLocation(ctx, locationId) : undefined;
  try { return { secret: await ctx.payments.connectionToken(ref), location_ref: ref ?? null }; } catch (e) { throw paymentError(e); }
}

// ---------- Stripe webhooks ----------
export async function handleStripeEvent(ctx, event) {
  const obj = event.data?.object ?? {};
  if (event.type.startsWith('payment_intent.')) {
    const s = ctx.db.get('SELECT id FROM sales WHERE payment_ref = ?', obj.id);
    if (s) await syncSale(ctx, s.id);
  } else if (event.type.startsWith('checkout.session.') && obj.mode === 'payment') {
    if (!(await handlePayLinkCheckout(ctx, event.type, obj))) await handleInvoiceCheckout(ctx, event.type, obj);
  } else if (event.type === 'checkout.session.completed' && obj.mode === 'setup') {
    const info = await ctx.payments.getSetupSession(obj.id);
    const payer = info.familyId ? payerById(ctx, 'families', info.familyId) : info.clientId ? payerById(ctx, 'clients', info.clientId) : null;
    if (payer && info.paymentMethod) { saveCard(ctx, payer, info); await retryFailed(ctx, payer); }
  }
  return { received: true };
}

// ---------- Reporting ----------
export function revenueByLocation(ctx, since) {
  const rows = ctx.db.all(
    `SELECT l.id, l.name, l.kind, COALESCE(SUM(s.amount_cents - s.refunded_cents), 0) AS cents, COUNT(s.id) AS sales
     FROM locations l LEFT JOIN sales s ON s.location_id = l.id AND s.status IN ('succeeded','partially_refunded') AND s.completed_at >= ?
     GROUP BY l.id ORDER BY cents DESC`, since);
  const memberships = ctx.db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n FROM invoices WHERE status = 'paid' AND paid_at >= ?`, since);
  return { since, locations: rows.filter((r) => r.sales > 0 || ctx.db.get('SELECT active FROM locations WHERE id = ?', r.id).active), memberships_cents: memberships.cents, membership_payments: memberships.n };
}
