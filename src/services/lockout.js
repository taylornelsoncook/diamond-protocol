// Payment lockout (owner decision): when a membership payment keeps declining, the family is locked out of everything but
// fixing it. It starts once the payment has declined on payment_lock_tries automatic tries (the first charge and the
// scheduled retries; retries the owner or a parent start don't count, like the cancel limit), and ends the moment it's
// paid (a new card, Try again, a pay link, or the owner), voided or the membership ends.
// While locked:
//   - the parent portal answers only sign-in, the family's card, payments (receipts and Try again), their own details,
//     agreements, the waiver, devices, the data export and deletion requests; everything else is 402 payment_locked;
//   - the family's athletes can't open the workout app, book from an open-spot link or check themselves in (door QR or
//     tablet).
// Staff can still book and check them in at the desk (and take the payment there); the client page says they're locked.
// A family is locked when any of its athletes' payments is; an adult with no family when their own is.
import { getSetting } from './families.js';

export const LOCK_TRIES = [0, 1, 2, 3];      // 0 = never lock; 4 automatic tries cancel the membership (billing.MAX_ATTEMPTS)
export const lockTries = (ctx) => Number(getSetting(ctx, 'payment_lock_tries'));

const LOCKING = `FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id JOIN clients c ON c.id = i.client_id
  WHERE i.status = 'failed' AND s.status = 'past_due' AND i.auto_attempts >= ?`;
function lockOf(ctx, rows) {
  if (!rows.length) return null;
  const cents = rows.reduce((t, r) => t + r.amount_cents, 0);
  return { locked: true, amount_cents: cents, invoices: rows, athletes: [...new Set(rows.map((r) => r.client_name))] };
}
export function familyLock(ctx, familyId) {
  const tries = lockTries(ctx);
  if (!tries || !familyId) return null;
  return lockOf(ctx, ctx.db.all(`SELECT i.id, i.client_id, c.name AS client_name, i.amount_cents, i.auto_attempts ${LOCKING} AND c.family_id = ? ORDER BY i.created_at`, tries, familyId));
}
export function clientLock(ctx, clientId) {
  const tries = lockTries(ctx);
  if (!tries) return null;
  const c = ctx.db.get('SELECT family_id FROM clients WHERE id = ?', clientId);
  if (!c) return null;
  if (c.family_id) return familyLock(ctx, c.family_id);
  return lockOf(ctx, ctx.db.all(`SELECT i.id, i.client_id, c.name AS client_name, i.amount_cents, i.auto_attempts ${LOCKING} AND c.id = ? ORDER BY i.created_at`, tries, clientId));
}

// The portal routes a locked family can still use.
export const OPEN_WHILE_LOCKED = new Set([
  'GET /portal/api/me', 'PATCH /portal/api/me', 'POST /portal/api/logout',
  'POST /portal/api/card/setup-link', 'POST /portal/api/card/test', 'DELETE /portal/api/card',
  'GET /portal/api/payments', 'GET /portal/api/payments/membership/:id', 'POST /portal/api/payments/:id/retry',
  'POST /portal/api/agreements', 'POST /portal/api/waiver', 'POST /portal/api/waiver/email',
  'GET /portal/api/devices', 'POST /portal/api/devices/sign-out-others',
  'GET /portal/api/export', 'POST /portal/api/deletion-request'
]);
export const lockMessage = (lock) => `A membership payment of $${(lock.amount_cents / 100).toFixed(2).replace(/\.00$/, '')} didn't go through. Update your card or try the payment again on the Family tab; everything opens again as soon as it's paid.`;
export const athleteLockMessage = 'A membership payment didn\'t go through. Ask your parent to update the card in the parent portal, and you\'re back in as soon as it\'s paid.';
