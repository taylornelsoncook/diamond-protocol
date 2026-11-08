// Locked prices: the Legacy price lock (owner's choice, Nov 8 2026: "profiles with the Legacy ★ tag get their locked
// Legacy package price automatically at checkout"; schema 97, table price_locks). The member-facing rules are on the
// owners' Legacy page (owners.adastrahp.org/legacy.html):
//
// - A tag can lock prices (profile_tags.locks_price), for up to lock_limit members (the first 100; NULL = no limit). A
//   member with such a tag who starts a package (a membership plan) keeps the price the plan had that day: every renewal,
//   resume and first charge on that plan uses the lower of the lock and the plan's current price, so raising a plan's
//   price never reaches a locked member and lowering it always does.
// - The lock follows the package. Moving to another plan pays that plan's price on the day of the move, and that price
//   locks too while they still hold the tag. The old plan's lock ends, unless the owner keeps it (the in-season drop to
//   Rigel: the original package keeps its price for the return). Pausing keeps every lock.
// - Cancel or lapse and the locks end (canceled by hand, after the last automatic retry, or the online sales page's
//   declined first charge). A lock whose membership never had a paid month is removed instead of ended, so a declined
//   card or a trial that never paid doesn't use one of the founding spots. An ended lock still uses its spot: once the
//   first 100 are gone, they're gone.
// - The owner sets a lock by hand (any plan and price, for example a founder who reserved before the plan existed) or
//   ends one. Taking the tag off a profile, or deleting the tag, leaves locks already given; the owner ends those by hand.
//
// Staff other than the owner never see these amounts (hideMoney); families see only the price they pay.
import { newId, v, notFound, conflict } from '../util.js';
import { tagsOfClient } from './profiletags.js';

// SQL for what a membership costs a month, for queries over `subscriptions s JOIN plans p`: the plan's price, or the
// member's live lock on it when that's lower. pendingPriceSql is the same for a plan change waiting for the renewal.
export const priceSql = (s = 's', p = 'p') => `MIN(${p}.price_cents, COALESCE((SELECT lk.price_cents FROM price_locks lk WHERE lk.client_id = ${s}.client_id AND lk.plan_id = ${s}.plan_id AND lk.ended_at IS NULL), ${p}.price_cents))`;
export const lockSql = (s = 's') => `(SELECT lk.price_cents FROM price_locks lk WHERE lk.client_id = ${s}.client_id AND lk.plan_id = ${s}.plan_id AND lk.ended_at IS NULL)`;
export const pendingPriceSql = (s = 's') => `(SELECT MIN(pp2.price_cents, COALESCE((SELECT lk.price_cents FROM price_locks lk WHERE lk.client_id = ${s}.client_id AND lk.plan_id = pp2.id AND lk.ended_at IS NULL), pp2.price_cents)) FROM plans pp2 WHERE pp2.id = ${s}.pending_plan_id)`;

const liveLock = (ctx, clientId, planId) => ctx.db.get('SELECT * FROM price_locks WHERE client_id = ? AND plan_id = ? AND ended_at IS NULL', clientId, planId);
// Members who got a lock from the tag (ended ones too: a founding spot is used for good).
export const spotsUsed = (ctx, tagId) => ctx.db.get('SELECT COUNT(DISTINCT client_id) AS n FROM price_locks WHERE tag_id = ?', tagId).n;

// The tag that would lock a price for this client now: a price-locking tag they have, with a spot left or a spot they
// already hold. Tags in name order, so the answer is the same every time.
function lockingTag(ctx, clientId, { ignoreLimit = false } = {}) {
  const locking = new Map(ctx.db.all('SELECT id, name, lock_limit FROM profile_tags WHERE locks_price = 1').map((t) => [t.id, t]));
  if (!locking.size) return null;
  const mine = tagsOfClient(ctx, clientId).map((t) => locking.get(t.id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return mine.find((t) => ignoreLimit || t.lock_limit == null || ctx.db.get('SELECT 1 FROM price_locks WHERE tag_id = ? AND client_id = ?', t.id, clientId) || spotsUsed(ctx, t.id) < t.lock_limit) ?? null;
}

const shape = (l) => l && ({ id: l.id, plan_id: l.plan_id, plan_name: l.plan_name ?? null, plan_price_cents: l.plan_price_cents ?? null, price_cents: l.price_cents,
  tag_id: l.tag_id ?? null, tag_name: l.tag_name ?? null, source: l.source, by_name: l.by_name ?? null, created_at: l.created_at, ended_at: l.ended_at ?? null, end_reason: l.end_reason ?? null });

// What this client pays a month on this plan, and why: { price_cents, plan_price_cents, lock, new_lock }. lock is a live
// lock on the plan; new_lock says the plan's price would lock now (a locking tag with a spot), for the quote.
export function priceFor(ctx, clientId, plan) {
  const lock = clientId ? liveLock(ctx, clientId, plan.id) : null;
  if (lock) return { price_cents: Math.min(lock.price_cents, plan.price_cents), plan_price_cents: plan.price_cents, lock: shape(lock), new_lock: null };
  const tag = clientId ? lockingTag(ctx, clientId) : null;
  return { price_cents: plan.price_cents, plan_price_cents: plan.price_cents, lock: null, new_lock: tag ? { tag_id: tag.id, tag_name: tag.name, price_cents: plan.price_cents } : null };
}

// Locks the plan's price today for the client, when a locking tag lets it (a membership starting, a plan change). Returns
// the live lock (an existing one stays as it is), or null.
export function grant(ctx, clientId, planId, subscriptionId = null) {
  const have = liveLock(ctx, clientId, planId);
  if (have) return shape(have);
  const plan = ctx.db.get('SELECT id, price_cents FROM plans WHERE id = ?', planId);
  const tag = plan ? lockingTag(ctx, clientId) : null;
  if (!tag) return null;
  const id = newId('lock');
  ctx.db.run(`INSERT INTO price_locks (id, client_id, plan_id, tag_id, subscription_id, price_cents, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'tag', ?)`,
    id, clientId, planId, tag.id, subscriptionId, plan.price_cents, ctx.now());
  return shape(ctx.db.get('SELECT * FROM price_locks WHERE id = ?', id));
}

// A plan change took effect: the old plan's lock ends unless kept, and the new plan's price locks.
export function onPlanChange(ctx, clientId, subscriptionId, fromPlanId, toPlanId, { keep = false } = {}) {
  if (!keep && fromPlanId !== toPlanId) ctx.db.run(`UPDATE price_locks SET ended_at = ?, end_reason = 'plan changed' WHERE client_id = ? AND plan_id = ? AND ended_at IS NULL`, ctx.now(), clientId, fromPlanId);
  return grant(ctx, clientId, toPlanId, subscriptionId);
}

// A membership was canceled: every live lock of the client ends. The ones that came with this membership go entirely
// when it never had a paid month (a declined first charge, a trial canceled before it paid).
export function onCanceled(ctx, clientId, subscriptionId) {
  const paid = ctx.db.get(`SELECT 1 FROM invoices WHERE subscription_id = ? AND status = 'paid'`, subscriptionId);
  if (!paid) ctx.db.run(`DELETE FROM price_locks WHERE client_id = ? AND subscription_id = ? AND source = 'tag' AND ended_at IS NULL`, clientId, subscriptionId);
  ctx.db.run(`UPDATE price_locks SET ended_at = ?, end_reason = 'canceled' WHERE client_id = ? AND ended_at IS NULL`, ctx.now(), clientId);
}

// ---- The owner's screens: GET/POST /v1/clients/:id/price-locks, DELETE /v1/clients/:id/price-locks/:lockId ----
const LIST = `SELECT l.*, p.name AS plan_name, p.price_cents AS plan_price_cents, t.name AS tag_name FROM price_locks l
  JOIN plans p ON p.id = l.plan_id LEFT JOIN profile_tags t ON t.id = l.tag_id`;
export const listFor = (ctx, clientId) => ctx.db.all(`${LIST} WHERE l.client_id = ? ORDER BY l.ended_at IS NOT NULL, l.created_at DESC, l.rowid DESC LIMIT 50`, clientId).map(shape);

// Set a lock by hand { plan_id, price_cents }: replaces a live lock on that plan. Counts toward the client's locking tag
// when they have one (so a founder set by hand uses a founding spot), whether or not spots are left.
export function setLock(ctx, client, body = {}, actor) {
  const plan = ctx.db.get('SELECT id, name FROM plans WHERE id = ?', v.str(body.plan_id, 'plan_id', { max: 60 }));
  if (!plan) throw notFound('Plan');
  const price = v.int(body.price_cents, 'price_cents', { min: 0, max: 10000000 });
  const tag = lockingTag(ctx, client.id, { ignoreLimit: true });
  const sub = ctx.db.get(`SELECT id FROM subscriptions WHERE client_id = ? AND status != 'canceled' ORDER BY created_at DESC LIMIT 1`, client.id);
  const id = newId('lock');
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE price_locks SET ended_at = ?, end_reason = 'replaced' WHERE client_id = ? AND plan_id = ? AND ended_at IS NULL`, ctx.now(), client.id, plan.id);
    ctx.db.run(`INSERT INTO price_locks (id, client_id, plan_id, tag_id, subscription_id, price_cents, source, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, 'hand', ?, ?)`,
      id, client.id, plan.id, tag?.id ?? null, sub?.id ?? null, price, actor?.name ?? null, ctx.now());
  });
  return shape(ctx.db.get(`${LIST} WHERE l.id = ?`, id));
}
export function endLock(ctx, client, lockId) {
  const l = ctx.db.get('SELECT * FROM price_locks WHERE id = ? AND client_id = ?', String(lockId ?? ''), client.id);
  if (!l) throw notFound('Price lock');
  if (l.ended_at) throw conflict('This lock has already ended.');
  ctx.db.run(`UPDATE price_locks SET ended_at = ?, end_reason = 'ended by hand' WHERE id = ?`, ctx.now(), l.id);
  return shape(ctx.db.get(`${LIST} WHERE l.id = ?`, l.id));
}

// The family export (a data request): the member's locked prices, live and ended.
export const forExport = (ctx, clientId) => listFor(ctx, clientId).map((l) => ({ plan: l.plan_name, price_cents: l.price_cents, since: l.created_at, ended_at: l.ended_at, end_reason: l.end_reason }));
