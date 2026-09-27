import { newId, v, notFound, badRequest, conflict } from '../util.js';
import { emit } from './events.js';

// Retail inventory for gear: shirts, hoodies, bats, bands. A product counts its stock when "track stock" is on.
// Stock is a ledger (stock_moves) so every change has a reason and a name: sales take stock out, full refunds put it
// back, deliveries add it, and a shelf count sets it to what's really there. Sizes (variants) each have their own count.
// Selling something the system thinks is out of stock is allowed (the shelf is the truth); it shows as a negative
// count to fix with a recount.

const REASONS = ['received', 'count', 'adjust'];
const onHand = (ctx, productId, variantId) => variantId === undefined
  ? ctx.db.get('SELECT COALESCE(SUM(delta), 0) AS n FROM stock_moves WHERE product_id = ?', productId).n
  : ctx.db.get('SELECT COALESCE(SUM(delta), 0) AS n FROM stock_moves WHERE product_id = ? AND variant_id IS ?', productId, variantId).n;

function productRow(ctx, id) {
  const p = ctx.db.get('SELECT * FROM products WHERE id = ?', id);
  if (!p) throw notFound('Product');
  return p;
}
export const activeVariants = (ctx, productId) => ctx.db.all('SELECT id, name, sku FROM product_variants WHERE product_id = ? AND active = 1 ORDER BY rowid', productId);

// What the product list shows: sizes and what's left of each, for products that have them or count stock.
export function stockFields(ctx, p) {
  const variants = ctx.db.all('SELECT id, name, sku, active FROM product_variants WHERE product_id = ? ORDER BY rowid', p.id).map((x) => ({ ...x, active: !!x.active }));
  const out = { track_stock: !!p.track_stock, low_stock_at: p.low_stock_at ?? null, variants };
  if (!p.track_stock) return out;
  for (const x of variants) { x.on_hand = onHand(ctx, p.id, x.id); x.low = p.low_stock_at != null && x.active && x.on_hand <= p.low_stock_at; }
  out.on_hand = onHand(ctx, p.id);
  const unsized = variants.length ? onHand(ctx, p.id, null) : 0;
  if (unsized) out.unsized_on_hand = unsized;                 // moves recorded before sizes were added
  out.low = p.low_stock_at != null && (variants.some((x) => x.low) || (!variants.some((x) => x.active) && out.on_hand <= p.low_stock_at));
  return out;
}

// Product settings: track_stock, low_stock_at (blank to turn the warning off).
export function stockSettings(ctx, body, current = {}) {
  return {
    track_stock: (body.track_stock !== undefined ? body.track_stock : current.track_stock) ? 1 : 0,
    low_stock_at: body.low_stock_at === undefined ? current.low_stock_at ?? null
      : body.low_stock_at === null || body.low_stock_at === '' ? null : v.int(body.low_stock_at, 'low_stock_at', { min: 0, max: 10000 })
  };
}

// ---------- Sizes ----------
export function addVariant(ctx, productId, body) {
  const p = productRow(ctx, productId);
  if (['session', 'pack'].includes(p.kind)) throw badRequest('Sizes are for gear and other items, not sessions or packs.');
  const name = v.str(body.name, 'name', { max: 30 });
  if (ctx.db.get('SELECT id FROM product_variants WHERE product_id = ? AND name = ? COLLATE NOCASE AND active = 1', p.id, name)) throw conflict(`${p.name} already has a size called ${name}.`);
  const id = newId('var');
  ctx.db.run('INSERT INTO product_variants (id, product_id, name, sku, active, created_at) VALUES (?, ?, ?, ?, 1, ?)', id, p.id, name, v.str(body.sku, 'sku', { max: 40, optional: true }) ?? null, ctx.now());
  return ctx.db.get('SELECT * FROM product_variants WHERE id = ?', id);
}
export function updateVariant(ctx, productId, variantId, body) {
  const x = ctx.db.get('SELECT * FROM product_variants WHERE id = ? AND product_id = ?', variantId, productId);
  if (!x) throw notFound('Size');
  ctx.db.run('UPDATE product_variants SET name = ?, sku = ?, active = ? WHERE id = ?',
    body.name !== undefined ? v.str(body.name, 'name', { max: 30 }) : x.name,
    body.sku !== undefined ? v.str(body.sku, 'sku', { max: 40, optional: true }) ?? null : x.sku,
    body.active !== undefined ? (body.active ? 1 : 0) : x.active, x.id);
  return ctx.db.get('SELECT * FROM product_variants WHERE id = ?', x.id);
}

// Which size a sale line is for. A product with one size needs no choice (so older apps keep working).
export function pickVariant(ctx, p, variantId) {
  const sizes = activeVariants(ctx, p.id);
  if (variantId) {
    const x = sizes.find((s) => s.id === variantId);
    if (!x) throw badRequest(`That size of ${p.name} isn't sold any more. Choose another.`);
    return x;
  }
  if (sizes.length === 1) return sizes[0];
  if (sizes.length > 1) throw badRequest(`Choose a size for ${p.name} (${sizes.map((s) => s.name).join(', ')}).`);
  return null;
}

// ---------- Moves ----------
// Receive a delivery (quantity added), record a count (quantity = what's on the shelf) or adjust (+/-, e.g. damaged).
export function recordStock(ctx, productId, body, actor) {
  const p = productRow(ctx, productId);
  if (!p.track_stock) throw conflict(`Turn on stock counting for ${p.name} first.`);
  const reason = v.oneOf(body.reason ?? 'received', 'reason', REASONS);
  const sizes = activeVariants(ctx, p.id);
  let variantId = null;
  if (body.variant_id) { if (!sizes.some((s) => s.id === body.variant_id)) throw notFound('Size'); variantId = body.variant_id; }
  else if (sizes.length === 1) variantId = sizes[0].id;
  else if (sizes.length > 1) throw badRequest(`Choose which size of ${p.name}.`);
  const qty = Number(body.quantity);
  const [min, max, say] = { received: [1, 10000, 'Enter how many arrived, like 12.'], count: [0, 100000, 'Enter how many are on the shelf, like 8 (0 if none).'], adjust: [-10000, 10000, 'Enter how many to add, or a minus number to take off, like -2.'] }[reason];
  if (body.quantity === '' || body.quantity == null || !Number.isInteger(qty) || qty < min || qty > max) throw badRequest(say);
  const before = onHand(ctx, p.id, variantId);
  const delta = reason === 'count' ? qty - before : qty;
  if (!delta && reason !== 'count') throw badRequest('Enter a number other than 0.');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO stock_moves (id, product_id, variant_id, delta, reason, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId('stk'), p.id, variantId, delta, reason, v.str(body.note, 'note', { max: 200, optional: true }) ?? null, actor ?? null, ctx.now());
    emit(ctx, 'stock.changed', { product_id: p.id, product_name: p.name, variant_id: variantId, size: sizes.find((s) => s.id === variantId)?.name ?? null, reason, delta, on_hand: before + delta });
  });
  return { product_id: p.id, variant_id: variantId, before, delta, on_hand: before + delta };
}

// Called inside the sale's transaction when it completes, and on a full refund with restock.
export function stockForSale(ctx, saleId, sign, reason) {
  const items = ctx.db.all(`SELECT i.product_id, i.variant_id, i.quantity FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = ? AND p.track_stock = 1`, saleId);
  for (const i of items) ctx.db.run('INSERT INTO stock_moves (id, product_id, variant_id, delta, reason, sale_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('stk'), i.product_id, i.variant_id, sign * i.quantity, reason, saleId, ctx.now());
  return items.length;
}

export function stockHistory(ctx, productId, { limit = 50 } = {}) {
  productRow(ctx, productId);
  return ctx.db.all(`SELECT m.id, m.variant_id, x.name AS size, m.delta, m.reason, m.sale_id, m.note, m.created_by, m.created_at
    FROM stock_moves m LEFT JOIN product_variants x ON x.id = m.variant_id WHERE m.product_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`, productId, limit);
}

// Everything that counts stock, with what's low. For the Inventory panel, Today and the Monday summary.
export function inventory(ctx) {
  const products = ctx.db.all('SELECT * FROM products WHERE track_stock = 1 AND active = 1 ORDER BY name');
  const data = products.map((p) => ({ id: p.id, name: p.name, price_cents: p.price_cents, ...stockFields(ctx, p) }));
  const low = [];
  for (const p of data) {
    const sized = p.variants.filter((x) => x.active);
    if (sized.length) for (const x of sized) { if (x.low) low.push({ product_id: p.id, variant_id: x.id, name: `${p.name} (${x.name})`, on_hand: x.on_hand, low_stock_at: p.low_stock_at }); }
    else if (p.low) low.push({ product_id: p.id, variant_id: null, name: p.name, on_hand: p.on_hand, low_stock_at: p.low_stock_at });
  }
  return { data, low };
}
