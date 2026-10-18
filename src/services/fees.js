// A card processing fee passed to the payer (owner setting, off by default): a percent of the amount plus a flat
// amount, added as its own line to the card payments the platform takes where the owner turned it on: membership
// charges, card sales at the counter (bookings collected there too), pay links and the online store. Cash and check
// never carry it, a payment by hand on a membership drops it, and school invoices are left out (schools pay by check
// or bank transfer as often as by card). The owner is told that surcharge rules differ by state and card network.
import { getSetting } from './families.js';

export const FEE_PLACES = { memberships: 'Membership charges', counter: 'Card sales at the counter', pay_links: 'Pay links', store: 'Online store' };
export const CARD_METHODS = ['tap_to_pay', 'reader', 'card_on_file', 'online'];
export const MAX_FEE_PCT = 4, MAX_FEE_CENTS = 100;

export function feeSettings(ctx) {
  const on = String(getSetting(ctx, 'card_fee_on') ?? '').split(',').map((s) => s.trim()).filter((k) => Object.hasOwn(FEE_PLACES, k));
  return { pct: Number(getSetting(ctx, 'card_fee_pct')) || 0, flat_cents: Number(getSetting(ctx, 'card_fee_flat')) || 0, label: getSetting(ctx, 'card_fee_label') || 'Card processing fee', on, places: FEE_PLACES };
}
// Debit and prepaid cards are never charged the fee (Colorado C.R.S. § 5-2-212 and the card networks allow a surcharge on
// credit cards only). Stripe says what a card is (card.funding); a card whose funding isn't known yet (saved before version
// 88 and not looked up yet, or a card about to be tapped) is treated as credit until it's known, and the fee is given back
// once it turns out to be debit (commerce.js removeDebitFee).
export const NO_FEE_FUNDING = ['debit', 'prepaid'];
export const FUNDINGS = ['credit', 'debit', 'prepaid', 'unknown'];
export const feeFree = (funding) => NO_FEE_FUNDING.includes(String(funding ?? '').toLowerCase());
// The fee on a card payment of cents at a place, in whole cents: 0 when the fee is off there, there's nothing to pay, or the
// card is a debit or prepaid card (funding, when the card is known).
export function cardFee(ctx, cents, place, { funding = null } = {}) {
  const f = feeSettings(ctx);
  if (!(cents > 0) || !f.on.includes(place) || (!f.pct && !f.flat_cents)) return { cents: 0, label: f.label };
  if (feeFree(funding)) return { cents: 0, label: f.label, debit: true };
  return { cents: Math.round((cents * f.pct) / 100) + f.flat_cents, label: f.label };
}
// The funding of the card that pays for a client (the family's card when they have one, else their own), or null.
export function cardFunding(ctx, clientId) {
  const r = ctx.db.get(`SELECT c.card_payment_method AS own_pm, c.card_funding AS own_funding, f.card_payment_method AS fam_pm, f.card_funding AS fam_funding
    FROM clients c LEFT JOIN families f ON f.id = c.family_id WHERE c.id = ?`, clientId);
  if (!r) return null;
  if (r.fam_pm !== undefined && r.fam_pm !== null) return r.fam_funding ?? null;
  return r.own_pm ? r.own_funding ?? null : null;
}
// A saved card whose funding isn't on file yet is looked up once with the payment provider (Stripe) and remembered.
// payer: { table, id, card_payment_method, card_funding }. Answers the funding, or null when it can't be known.
export async function ensureFunding(ctx, payer) {
  if (!payer?.card_payment_method) return null;
  if (payer.card_funding) return payer.card_funding;
  if (!ctx.payments.getPaymentMethod) return null;
  let pm;
  try { pm = await ctx.payments.getPaymentMethod(payer.card_payment_method); } catch { return null; }
  const funding = FUNDINGS.includes(pm?.funding) ? pm.funding : 'unknown';
  ctx.db.run(`UPDATE ${payer.table} SET card_funding = ? WHERE id = ? AND card_payment_method = ?`, funding, payer.id, payer.card_payment_method);
  payer.card_funding = funding;
  return funding;
}
// Hourly job: look up the funding of cards saved before the app knew to ask (up to 100 a run), so every card on file is
// known before its next charge and the counter and the portal show the right amount ahead of it.
export async function lookupFundings(ctx) {
  if (!ctx.payments.getPaymentMethod) return { looked_up: 0, skipped: 'the payment provider has no card lookup' };
  let n = 0;
  for (const table of ['families', 'clients']) {
    for (const row of ctx.db.all(`SELECT id, card_payment_method FROM ${table} WHERE card_payment_method IS NOT NULL AND card_funding IS NULL LIMIT 100`)) {
      if (await ensureFunding(ctx, { table, id: row.id, card_payment_method: row.card_payment_method, card_funding: null })) n++;
      if (n >= 100) return { looked_up: n, more: true };
    }
  }
  return { looked_up: n };
}
