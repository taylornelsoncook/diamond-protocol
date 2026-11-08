// Locked prices (the Legacy price lock; owner's choice Nov 8 2026: "profiles with the Legacy ★ tag get their locked
// Legacy package price automatically at checkout"; schema 97, services/pricelocks.js). Rules from the owners' Legacy
// page: the price of the package you start is yours while the membership stays active; the lock follows the package;
// cancel or lapse ends it; the in-season drop keeps the original package's price; the first 100 members only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { addTestCard } from '../src/services/commerce.js';
import { runBilling } from '../src/services/billing.js';
import { forExport as locksForExport } from '../src/services/pricelocks.js';

let app, base, owner, coach, polaris, rigel, legacy;
const signIn = async (email, password) => {
  const token = (await (await fetch(base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token;
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
};
const setNow = (iso) => { app.ctx.now = () => iso; };
let n = 0;
const client = async (name, { card = true } = {}) => {
  const c = (await owner('POST', '/v1/clients', { name, email: `pl${++n}@example.com` })).body;
  if (card) await addTestCard(app.ctx, c.id);
  return c;
};
const start = async (c, plan) => owner('POST', `/v1/clients/${c.id}/subscription`, { plan_id: plan.id });
const lastInvoice = (clientId) => app.ctx.db.get('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', clientId);
const live = (clientId) => app.ctx.db.all('SELECT plan_id, price_cents FROM price_locks WHERE client_id = ? AND ended_at IS NULL ORDER BY created_at, rowid', clientId);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.test' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley Coach', password: 'coach-password-1', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev', 'owner-password-1');
  coach = await signIn('coach@test.dev', 'coach-password-1');
  setNow('2026-11-01T06:00:00.000Z');                                   // Nov 1 midnight Chicago: whole months, no proration
  polaris = (await owner('POST', '/v1/plans', { name: 'Polaris', price_cents: 60000, trial_days: 0 })).body;
  rigel = (await owner('POST', '/v1/plans', { name: 'Rigel', price_cents: 16000, trial_days: 0 })).body;
  legacy = (await owner('POST', '/v1/profile-tags', { name: 'Legacy', starts_on: '2026-10-01', ends_on: '2027-02-28', locks_price: true, lock_limit: 2 })).body;
});
after(() => app.server.close());

test('a tag can lock prices, for a limited number of members', async () => {
  assert.deepEqual([legacy.locks_price, legacy.lock_limit], [true, 2]);
  const bad = await owner('PATCH', `/v1/profile-tags/${legacy.id}`, { lock_limit: 0 });
  assert.equal(bad.status, 400);
  const other = (await owner('POST', '/v1/profile-tags', { name: 'Staff kid', starts_on: '2026-10-01' })).body;
  assert.equal(other.locks_price, false, 'off unless asked for');
  await owner('DELETE', `/v1/profile-tags/${other.id}`);
});

test('a Legacy member keeps the price they joined at; a raise reaches only new members', async () => {
  const ava = await client('Ava Founder');
  const q = (await owner('GET', `/v1/plans/${polaris.id}/quote?client_id=${ava.id}`)).body;
  assert.deepEqual([q.monthly_cents, q.price_lock?.new, q.price_lock?.tag_name], [60000, true, 'Legacy'], 'the quote says the price will lock');
  const s = await start(ava, polaris);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.first_charge.amount_cents, 60000);
  assert.deepEqual(live(ava.id), [{ plan_id: polaris.id, price_cents: 60000 }]);

  await owner('PATCH', `/v1/plans/${polaris.id}`, { price_cents: 65000 });
  setNow('2026-12-01T06:00:00.000Z');
  await runBilling(app.ctx);
  assert.deepEqual([lastInvoice(ava.id).amount_cents, lastInvoice(ava.id).status], [60000, 'paid'], 'renewed at the locked price');
  const page = (await owner('GET', `/v1/clients/${ava.id}`)).body;
  assert.deepEqual([page.subscription.price_cents, page.subscription.locked_price_cents, page.subscription.plan_price_cents], [60000, 60000, 65000]);
  assert.equal(page.price_locks.length, 1);
  const q2 = (await owner('GET', `/v1/plans/${polaris.id}/quote?client_id=${ava.id}`)).body;
  assert.deepEqual([q2.monthly_cents, q2.plan_price_cents, q2.price_lock.new], [60000, 65000, false]);
  const parent = (await owner('GET', '/v1/billing/summary')).body;
  assert.ok(parent.mrr.members_cents >= 60000);

  // Lowering the plan below the lock reaches the member too: never more than the plan.
  await owner('PATCH', `/v1/plans/${polaris.id}`, { price_cents: 55000 });
  setNow('2027-01-01T06:00:00.000Z');
  await runBilling(app.ctx);
  assert.equal(lastInvoice(ava.id).amount_cents, 55000);
  await owner('PATCH', `/v1/plans/${polaris.id}`, { price_cents: 65000 });
  setNow('2027-01-05T18:00:00.000Z');
});

test('only the first members get a lock; a declined first charge gives its spot back', async () => {
  const ben = await client('Ben Second');
  await start(ben, polaris);
  assert.deepEqual(live(ben.id), [{ plan_id: polaris.id, price_cents: 65000 }], 'the price on the day they joined');
  const tags = (await owner('GET', '/v1/profile-tags')).body.data;
  assert.equal(tags.find((t) => t.id === legacy.id).locks_used, 2);

  const cal = await client('Cal Third');
  assert.equal((await owner('GET', `/v1/plans/${rigel.id}/quote?client_id=${cal.id}`)).body.price_lock, null, 'no spot left');
  await start(cal, rigel);
  assert.deepEqual(live(cal.id), []);
  await owner('POST', `/v1/clients/${cal.id}/subscription/cancel`);

  // Ben cancels: his lock ends but his founding spot stays used.
  await owner('POST', `/v1/clients/${ben.id}/subscription/cancel`);
  assert.deepEqual(live(ben.id), []);
  assert.equal(app.ctx.db.get('SELECT end_reason FROM price_locks WHERE client_id = ?', ben.id).end_reason, 'canceled');
  assert.equal((await owner('GET', '/v1/profile-tags')).body.data.find((t) => t.id === legacy.id).locks_used, 2);

  // Raise the limit: Dia's card has nothing on file, the first charge fails, and canceling removes the lock entirely.
  await owner('PATCH', `/v1/profile-tags/${legacy.id}`, { lock_limit: 3 });
  const dia = await client('Dia NoCard', { card: false });
  await start(dia, rigel);
  assert.equal(live(dia.id).length, 1);
  await owner('POST', `/v1/clients/${dia.id}/subscription/cancel`);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM price_locks WHERE client_id = ?', dia.id).n, 0, 'never paid: no spot used');
  assert.equal((await owner('GET', '/v1/profile-tags')).body.data.find((t) => t.id === legacy.id).locks_used, 2);
});

test('the lock follows the package; the in-season drop keeps the original price for the return', async () => {
  const eve = await client('Eve Season');
  await start(eve, polaris);                                             // locks at 65000 (spot 3 of 3)
  await owner('PATCH', `/v1/plans/${polaris.id}`, { price_cents: 70000 });

  // Drop to Rigel for the season, keeping Polaris.
  let r = await owner('POST', `/v1/clients/${eve.id}/subscription/plan`, { plan_id: rigel.id, when: 'now', keep_lock: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(live(eve.id).map((l) => [l.plan_id, l.price_cents]), [[polaris.id, 65000], [rigel.id, 16000]]);
  assert.equal(r.body.price_cents, 16000);
  // Back to Polaris: the kept 65000, not today's 70000; the Rigel lock ends with the move.
  r = await owner('POST', `/v1/clients/${eve.id}/subscription/plan`, { plan_id: polaris.id, when: 'renewal' });
  assert.equal(r.body.pending_price_cents, 65000);
  setNow('2027-02-01T06:00:00.000Z');
  await runBilling(app.ctx);
  assert.equal(lastInvoice(eve.id).amount_cents, 65000);
  assert.deepEqual(live(eve.id).map((l) => l.plan_id), [polaris.id]);

  // A plain switch ends the old lock: coming back later pays the price of the day.
  await owner('POST', `/v1/clients/${eve.id}/subscription/plan`, { plan_id: rigel.id, when: 'now' });
  assert.deepEqual(live(eve.id).map((l) => l.plan_id), [rigel.id]);
  await owner('POST', `/v1/clients/${eve.id}/subscription/plan`, { plan_id: polaris.id, when: 'now' });
  assert.deepEqual(live(eve.id).map((l) => [l.plan_id, l.price_cents]), [[polaris.id, 70000]]);
});

test('pausing keeps the lock; resuming charges it', async () => {
  const ava = app.ctx.db.get(`SELECT id FROM clients WHERE name = 'Ava Founder'`);
  await owner('POST', `/v1/clients/${ava.id}/subscription/pause`);
  assert.equal(live(ava.id).length, 1);
  await owner('POST', `/v1/clients/${ava.id}/subscription/resume`);
  const inv = lastInvoice(ava.id);
  assert.ok(inv.amount_cents <= 60000 && inv.amount_cents > 0, `prorated from the locked 60000, got ${inv.amount_cents}`);
});

test('the owner sets and ends a lock by hand; coaches never see or change them', async () => {
  const fay = await client('Fay Reserved');
  let r = await owner('POST', `/v1/clients/${fay.id}/price-locks`, { plan_id: polaris.id, price_cents: 60000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.source, r.body.price_cents, r.body.tag_name, r.body.by_name], ['hand', 60000, 'Legacy', 'Olivia Owner'], 'counts toward the founding spots');
  await start(fay, polaris);
  assert.equal(lastInvoice(fay.id).amount_cents, 60000, 'the first charge uses it');
  assert.equal((await owner('POST', `/v1/clients/${fay.id}/price-locks`, { plan_id: polaris.id, price_cents: -1 })).status, 400);

  assert.equal((await coach('GET', `/v1/clients/${fay.id}/price-locks`)).status, 403);
  assert.equal((await coach('POST', `/v1/clients/${fay.id}/price-locks`, { plan_id: polaris.id, price_cents: 1 })).status, 403);
  const seen = (await coach('GET', `/v1/clients/${fay.id}`)).body;
  assert.ok(seen.price_locks.every((l) => l.price_cents === undefined), 'amounts are hidden from coaches');

  const lock = (await owner('GET', `/v1/clients/${fay.id}/price-locks`)).body.data[0];
  r = await owner('DELETE', `/v1/clients/${fay.id}/price-locks/${lock.id}`);
  assert.deepEqual([r.status, r.body.end_reason], [200, 'ended by hand']);
  assert.equal((await owner('DELETE', `/v1/clients/${fay.id}/price-locks/${lock.id}`)).status, 409);
  assert.equal((await owner('GET', `/v1/clients/${fay.id}`)).body.subscription.price_cents, 70000);
});

test('a data request hands over the locked prices', async () => {
  const ava = app.ctx.db.get(`SELECT id FROM clients WHERE name = 'Ava Founder'`);
  const out = locksForExport(app.ctx, ava.id);
  assert.deepEqual(out.map((l) => [l.plan, l.price_cents, l.ended_at]), [['Polaris', 60000, null]]);
});
