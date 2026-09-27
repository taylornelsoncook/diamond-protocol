import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { buildDigest, digestText } from '../src/services/insights.js';

let app, base, owner, desk;
const call = async (method, path, body, token = owner) => {
  const headers = { authorization: `Bearer ${token}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const signIn = async (email) => (await (await fetch(base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) })).json()).token;

let loc, hoodie, bat, pack, sizes = {};

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev');
  desk = await signIn('desk@test.dev');
  loc = (await call('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '100 Main St', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

test('gear counts its stock per size', async () => {
  hoodie = (await call('POST', '/v1/products', { name: 'DP hoodie', kind: 'gear', price_cents: 5500, track_stock: true, low_stock_at: 2 })).body;
  assert.equal(hoodie.track_stock, true);
  assert.equal(hoodie.on_hand, 0);
  for (const name of ['Youth L', 'M', 'L']) sizes[name] = (await call('POST', `/v1/products/${hoodie.id}/variants`, { name })).body;
  assert.equal((await call('POST', `/v1/products/${hoodie.id}/variants`, { name: 'm' })).status, 409);

  // A delivery needs a size when there are several.
  const noSize = await call('POST', `/v1/products/${hoodie.id}/stock`, { reason: 'received', quantity: 5 });
  assert.equal(noSize.status, 400);
  assert.match(noSize.body.error.message, /which size/);
  for (const [name, n] of [['Youth L', 4], ['M', 6], ['L', 3]]) assert.equal((await call('POST', `/v1/products/${hoodie.id}/stock`, { reason: 'received', variant_id: sizes[name].id, quantity: n })).status, 201);
  const bad = await call('POST', `/v1/products/${hoodie.id}/stock`, { reason: 'received', variant_id: sizes.M.id, quantity: 0 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /how many arrived/);

  const p = (await call('GET', '/v1/products')).body.data.find((x) => x.id === hoodie.id);
  assert.equal(p.on_hand, 13);
  assert.deepEqual(p.variants.map((x) => [x.name, x.on_hand, x.low]), [['Youth L', 4, false], ['M', 6, false], ['L', 3, false]]);

  // Sessions and packs never count stock.
  pack = (await call('POST', '/v1/products', { name: '5 pack', kind: 'pack', price_cents: 30000, sessions: 5, track_stock: true })).body;
  assert.equal(pack.track_stock, false);
  assert.equal((await call('POST', `/v1/products/${pack.id}/variants`, { name: 'M' })).status, 400);
});

test('a sale takes stock out, a full refund puts it back', async () => {
  const noSize = await call('POST', '/v1/sales', { location_id: loc.id, method: 'cash', items: [{ product_id: hoodie.id }] });
  assert.equal(noSize.status, 400);
  assert.match(noSize.body.error.message, /Choose a size for DP hoodie \(Youth L, M, L\)/);

  const sale = (await call('POST', '/v1/sales', { location_id: loc.id, method: 'cash', items: [{ product_id: hoodie.id, variant_id: sizes.L.id, quantity: 2 }] })).body;
  assert.equal(sale.status, 'succeeded');
  assert.equal(sale.items[0].name, 'DP hoodie (L)');
  assert.equal(sale.items[0].variant_id, sizes.L.id);
  let inv = (await call('GET', '/v1/inventory')).body;
  assert.deepEqual(inv.low.map((x) => [x.name, x.on_hand]), [['DP hoodie (L)', 1]]);

  await call('POST', `/v1/sales/${sale.id}/refund`, {});
  inv = (await call('GET', '/v1/inventory')).body;
  assert.equal(inv.data[0].variants.find((x) => x.name === 'L').on_hand, 3);
  assert.equal(inv.low.length, 0);

  // A refund for something that can't be sold again leaves the count alone.
  const again = (await call('POST', '/v1/sales', { location_id: loc.id, method: 'cash', items: [{ product_id: hoodie.id, variant_id: sizes.M.id }] })).body;
  await call('POST', `/v1/sales/${again.id}/refund`, { restock: false });
  assert.equal((await call('GET', '/v1/inventory')).body.data[0].variants.find((x) => x.name === 'M').on_hand, 5);

  const history = (await call('GET', `/v1/products/${hoodie.id}/stock`)).body.data;
  assert.deepEqual(history.slice(0, 3).map((m) => [m.reason, m.size, m.delta]), [['sale', 'M', -1], ['refund', 'L', 2], ['sale', 'L', -2]]);
});

test('selling past zero is allowed and a shelf count fixes it', async () => {
  bat = (await call('POST', '/v1/products', { name: 'Wood bat', kind: 'gear', price_cents: 9000, track_stock: true, low_stock_at: 1 })).body;
  // With one size, sales and counts pick it by themselves (older app versions don't send sizes).
  const only = (await call('POST', `/v1/products/${bat.id}/variants`, { name: '32 in' })).body;
  const sale = (await call('POST', '/v1/sales', { location_id: loc.id, method: 'cash', items: [{ product_id: bat.id }] })).body;
  assert.equal(sale.items[0].variant_id, only.id);
  let p = (await call('GET', '/v1/products')).body.data.find((x) => x.id === bat.id);
  assert.equal(p.on_hand, -1);
  assert.equal(p.low, true);

  const counted = (await call('POST', `/v1/products/${bat.id}/stock`, { reason: 'count', quantity: 4, note: 'Found a box in the back' }, desk)).body;
  assert.deepEqual([counted.before, counted.delta, counted.on_hand], [-1, 5, 4]);
  const adjusted = (await call('POST', `/v1/products/${bat.id}/stock`, { reason: 'adjust', quantity: -1, note: 'Cracked' })).body;
  assert.equal(adjusted.on_hand, 3);
  p = (await call('GET', '/v1/products')).body.data.find((x) => x.id === bat.id);
  assert.equal(p.low, false);

  // Front desk can receive and count, not change products or sizes.
  assert.equal((await call('GET', '/v1/inventory', null, desk)).status, 200);
  assert.equal((await call('POST', `/v1/products/${bat.id}/variants`, { name: '33 in' }, desk)).status, 403);
  assert.equal((await call('PATCH', `/v1/products/${bat.id}`, { low_stock_at: 5 }, desk)).status, 403);

  // Stock only moves for products that count it.
  const cap = (await call('POST', '/v1/products', { name: 'Cap', kind: 'gear', price_cents: 2500 })).body;
  assert.equal((await call('POST', `/v1/products/${cap.id}/stock`, { reason: 'received', quantity: 3 })).status, 409);
});

test('low stock shows on Today and in the Monday summary', async () => {
  await call('POST', `/v1/products/${hoodie.id}/stock`, { reason: 'count', variant_id: sizes['Youth L'].id, quantity: 1 });
  const today = (await call('GET', '/v1/dashboard', null, desk)).body;
  const low = today.attention.find((a) => a.kind === 'low_stock');
  assert.deepEqual(low.items, [{ name: 'DP hoodie (Youth L)', on_hand: 1 }]);
  const d = buildDigest(app.ctx);
  assert.ok(d.actions.some((a) => a === 'Reorder DP hoodie (Youth L): running low (Point of sale).'), d.actions.join('\n'));
  assert.match(digestText(app.ctx, d), /1 item running low/);

  // A size that's no longer sold stops warning.
  await call('PATCH', `/v1/products/${hoodie.id}/variants/${sizes['Youth L'].id}`, { active: false });
  assert.equal((await call('GET', '/v1/inventory')).body.low.length, 0);
});

test('changing a counted product keeps it counted', async () => {
  const p = (await call('PATCH', `/v1/products/${bat.id}`, { low_stock_at: 5, price_cents: 9500 })).body;
  assert.deepEqual([p.track_stock, p.low_stock_at, p.on_hand], [true, 5, 3]);
  assert.equal((await call('PATCH', `/v1/products/${bat.id}`, { low_stock_at: null })).body.low_stock_at, null);
});
