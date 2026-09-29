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
// The fee on a card payment of cents at a place, in whole cents: 0 when the fee is off there or there's nothing to pay.
export function cardFee(ctx, cents, place) {
  const f = feeSettings(ctx);
  if (!(cents > 0) || !f.on.includes(place) || (!f.pct && !f.flat_cents)) return { cents: 0, label: f.label };
  return { cents: Math.round((cents * f.pct) / 100) + f.flat_cents, label: f.label };
}
