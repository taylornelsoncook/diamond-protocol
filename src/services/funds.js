import { newId, v, badRequest, HttpError } from '../util.js';
import { payerFor } from './families.js';
import { emit } from './events.js';

// The prepaid balance (version 95, owner's ask: "a lump sum payment to an athlete's account that they can work off of:
// a parent pays $1000, then they get charged per session and it comes out of that total, or a package comes off it").
// The balance belongs to the payer (the family, so siblings share it; the athlete when there is no family) and is a
// ledger: a deposit is a sale (paid any way the counter takes money) whose amount is added to it; a sale paid with the
// method 'balance' takes from it (a session at the counter or booked into a class, a pack, gear, a camp); a refund of
// such a sale puts it back; the owner adjusts it by hand with a note. Nothing is counted twice: the deposit was the
// money in; spending the balance is never money in again (billing.moneyIn and the takings leave such sales out).
export const KINDS = ['deposit', 'sale', 'refund', 'adjust'];
export const MAX_DEPOSIT = 1000000;   // $10,000 at a time

export function payerOf(ctx, clientId) {
  const p = payerFor(ctx, clientId);
  return { kind: p.table, id: p.id };
}
export function balanceFor(ctx, payer) {
  return ctx.db.get('SELECT COALESCE(SUM(delta_cents), 0) AS c FROM account_funds WHERE payer_kind = ? AND payer_id = ?', payer.kind, payer.id).c;
}
export const balanceOf = (ctx, clientId) => balanceFor(ctx, payerOf(ctx, clientId));

// One ledger line. A spend (delta < 0) must be covered; the check and the write are one transaction, so two sales at
// once can't both take the last of it.
export function addFunds(ctx, clientId, delta, { kind, saleId = null, note = null, createdBy = null }) {
  if (!KINDS.includes(kind)) throw new Error(`funds kind ${kind}`);
  if (!Number.isInteger(delta) || delta === 0) throw badRequest('The amount must be whole cents and not zero.');
  const payer = payerOf(ctx, clientId);
  return ctx.db.tx(() => {
    const before = balanceFor(ctx, payer);
    if (delta < 0 && before + delta < 0) throw new HttpError(402, 'insufficient_balance', `The prepaid balance is ${money(before)}; this needs ${money(-delta)}.`);
    const id = newId('fund');
    ctx.db.run('INSERT INTO account_funds (id, payer_kind, payer_id, client_id, delta_cents, kind, sale_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, payer.kind, payer.id, clientId, delta, kind, saleId, note, createdBy, ctx.now());
    const balance = before + delta;
    const c = ctx.db.get('SELECT name FROM clients WHERE id = ?', clientId);
    emit(ctx, 'prepaid.changed', { client_id: clientId, client_name: c?.name ?? null, delta_cents: delta, balance_cents: balance, kind, sale_id: saleId, shared: payer.kind === 'families' });
    return { id, balance };
  });
}
// The owner fixes a balance by hand (a payment taken outside the app, a goodwill credit, a correction), with a note.
export function adjust(ctx, clientId, body = {}, user = null) {
  const amount = v.int(body.amount_cents, 'amount_cents', { min: -MAX_DEPOSIT, max: MAX_DEPOSIT });
  if (amount === 0) throw badRequest('Enter the amount to add (or take off, with a minus).');
  const note = v.str(body.note, 'note', { max: 200 });
  if (!note.trim()) throw badRequest('Say why, so the family and your books agree.');
  const c = ctx.db.get('SELECT id, archived_at FROM clients WHERE id = ?', clientId);
  if (!c) throw new HttpError(404, 'not_found', 'Client not found.');
  addFunds(ctx, clientId, amount, { kind: 'adjust', note: note.trim(), createdBy: user?.name ?? null });
  return summaryFor(ctx, clientId);
}
// The balance and its ledger for one athlete's payer (the client page, the counter, the family export). Amounts are
// `balance` and `delta` (not `_cents`): the counter, which every staff role runs, has to see them to take a payment.
export function summaryFor(ctx, clientId, { limit = 200 } = {}) {
  const payer = payerOf(ctx, clientId);
  // created_by holds whoever did it (a staff id from the counter, a parent's id from the portal, a name from an adjustment); the name is shown.
  const entries = ctx.db.all(`SELECT f.id, f.client_id, c.name AS client_name, f.delta_cents, f.kind, f.sale_id, f.note, COALESCE(u.name, g.name, f.created_by) AS created_by, f.created_at
    FROM account_funds f LEFT JOIN clients c ON c.id = f.client_id LEFT JOIN users u ON u.id = f.created_by LEFT JOIN guardians g ON g.id = f.created_by
    WHERE f.payer_kind = ? AND f.payer_id = ? ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?`, payer.kind, payer.id, limit);
  return { balance: balanceFor(ctx, payer), shared: payer.kind === 'families', entries: entries.map(({ delta_cents, ...e }) => ({ ...e, delta: delta_cents })) };
}
// What a sale's refunds have already taken back off the balance (a deposit refunded in part).
export const takenBackFor = (ctx, saleId) => -ctx.db.get(`SELECT COALESCE(SUM(delta_cents), 0) AS c FROM account_funds WHERE sale_id = ? AND kind = 'refund' AND delta_cents < 0`, saleId).c;
export const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
