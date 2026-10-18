// The online sales page (owner's ask: "a sales page where people can buy their package or membership online; when they
// purchase it, it prompts them to create their profile"). Public at /buy, for people without an account; families who
// already have one buy the same things in the portal (Programs tab).
//
// The order of things, so nobody buys into someone else's email and nothing new handles money:
//   1. start: who's training, the buyer's name, email and phone, the agreements. A 6-digit code goes to the email. The
//      answer is the same when the email already has an account (that person is emailed a sign-in link instead), so the
//      page can't be used to find out who trains here.
//   2. verify: the code proves the email. The card is then saved on Stripe's own page (setup mode: the card number never
//      touches this server, and we learn whether it's credit or debit before anything is charged).
//   3. complete (Stripe's return, or its webhook): the account is made (a family with the buyer as account holder, the
//      athlete in it), the card saved on it, and the item charged the usual way: a pack through the counter's sale
//      (credits, card fee by card type, receipt) and a membership through billing (prorated to the 1st, trials, invoice,
//      receipt). The buyer is signed in and lands on their profile with the waiver as the one thing needed.
//   A declined card leaves the account and nothing owing; the page offers another card.
import { newId, sha256, v, badRequest, conflict, notFound, HttpError, safeEqual, withLock, addDays } from '../util.js';
import { getSetting, startPortalSession, payerFor } from './families.js';
import { createClient } from './clients.js';
import { recordConsent, published } from './legal.js';
import { sendEmail } from './mail.js';
import { feeSettings, cardFee } from './fees.js';
import * as billing from './billing.js';
import * as commerce from './commerce.js';
import { randomInt } from 'node:crypto';

const CODE_MINUTES = 30, CARD_HOURS = 24, MAX_ATTEMPTS = 5, KEEP_DAYS = 7, SESSION_DAYS = 30;
const biz = (ctx) => getSetting(ctx, 'business_name');
const base = (ctx) => ctx.publicUrl ?? '';
// A plan's name as a membership, without saying "membership" twice ("Group membership" stays as it is).
const asMembership = (name) => (/membership/i.test(name ?? '') ? name : `${name ?? ''} membership`);
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
export const isOpen = (ctx) => getSetting(ctx, 'buy_online') !== 'off';
function mustBeOpen(ctx) { if (!isOpen(ctx)) throw new HttpError(403, 'buy_closed', 'Online buying is closed right now. Contact us to join.'); }

// What the page sells: every active membership plan (with what starting today charges) and every active session and pack.
const sellable = (p) => ['session', 'pack'].includes(p.kind);
export function catalog(ctx) {
  const fee = feeSettings(ctx);
  const products = commerce.listProducts(ctx).filter(sellable);
  const single = (type) => products.filter((p) => p.kind === 'session' && (p.credit_type ?? 'private') === (type ?? 'private')).map((p) => p.price_cents).sort((a, b) => a - b)[0] ?? null;
  return {
    business_name: biz(ctx), open: isOpen(ctx), terms_published: published(ctx, 'terms'), privacy_published: published(ctx, 'privacy'),
    late_cancel_hours: Number(getSetting(ctx, 'late_cancel_hours')) || 12,
    fee: { label: fee.label, pct: fee.pct, flat_cents: fee.flat_cents, memberships: fee.on.includes('memberships'), store: fee.on.includes('store') },
    plans: billing.listPlans(ctx).map((p) => ({ id: p.id, name: p.name, price_cents: p.price_cents, trial_days: p.trial_days, sessions_per_month: p.sessions_per_month ?? null, quote: billing.quote(ctx, p.id), quote_paid: p.trial_days > 0 ? billing.quote(ctx, p.id, ctx.now(), { skipTrial: true }) : null })),
    products: products.map((p) => {
      const one = p.kind === 'pack' ? single(p.credit_type) : null;
      return { id: p.id, name: p.name, kind: p.kind, credit_type: p.credit_type ?? 'private', sessions: p.sessions, price_cents: p.price_cents, fee_cents: cardFee(ctx, p.price_cents, 'store').cents,
        per_session_cents: p.kind === 'pack' && p.sessions ? Math.round(p.price_cents / p.sessions) : null,
        saves_cents: one && p.sessions && one * p.sessions > p.price_cents ? one * p.sessions - p.price_cents : null };
    })
  };
}

function itemOf(ctx, ref) {
  const m = /^(plan|product):([\w-]{1,64})$/.exec(String(ref ?? ''));
  if (!m) throw badRequest('Choose a membership or a pack to buy.');
  if (m[1] === 'plan') {
    const p = ctx.db.get('SELECT * FROM plans WHERE id = ? AND active = 1', m[2]);
    if (!p) throw badRequest('That membership is no longer offered. Pick another.');
    return { kind: 'plan', id: p.id, name: asMembership(p.name), plan: p };
  }
  const p = ctx.db.get('SELECT * FROM products WHERE id = ? AND active = 1', m[2]);
  if (!p || !sellable(p)) throw badRequest('That pack is no longer sold. Pick another.');
  return { kind: 'product', id: p.id, name: p.name, product: p };
}
const taken = (ctx, email) => !!(ctx.db.get('SELECT id FROM guardians WHERE email = ? COLLATE NOCASE', email) || ctx.db.get('SELECT id FROM clients WHERE email = ? COLLATE NOCASE', email));

// Step 1: the details and the agreements; a code goes to the email.
export async function startOrder(ctx, body = {}, ip) {
  mustBeOpen(ctx);
  ctx.db.run(`DELETE FROM web_orders WHERE status != 'paid' AND created_at < ?`, addDays(ctx.now(), -KEEP_DAYS));
  const item = itemOf(ctx, body.item);
  const out = { order_id: newId('wo'), message: 'Check your email for a 6-digit code to continue.' };
  if (body.website) return out;                                             // a hidden field only bots fill in
  const self = body.self === true;
  const first = v.str(body.athlete?.first_name, 'athlete\'s first name', { max: 60 }), last = v.str(body.athlete?.last_name, 'athlete\'s last name', { max: 60 });
  const athlete = `${first.trim()} ${last.trim()}`;
  const buyer = { name: self ? athlete : v.str(body.buyer?.name, 'your name', { max: 120 }), email: v.email(body.buyer?.email, 'your email').toLowerCase(), phone: v.str(body.buyer?.phone, 'your phone', { max: 40, optional: true }) ?? null };
  if (body.accept_terms !== true) throw badRequest('Please agree to the terms of service and privacy policy.');
  if (item.kind === 'plan' && body.accept_renewal !== true) throw badRequest('Please agree to the monthly renewal: the membership renews every month until you cancel.');
  const skipTrial = item.kind === 'plan' && item.plan.trial_days > 0 && body.skip_trial === true;
  if (taken(ctx, buyer.email)) {
    await sendEmail(ctx, { to: buyer.email, subject: `You already have a ${biz(ctx)} account`,
      text: `Someone (probably you) started buying ${item.name} with this email, but you already have an account.\n\nSign in and buy it from the Programs tab: ${base(ctx)}/client?tab=programs\n\nIf this wasn't you, you can ignore this email.` });
    return out;
  }
  const recent = ctx.db.get('SELECT COUNT(*) AS n FROM web_orders WHERE email = ? AND created_at > ?', buyer.email, new Date(Date.parse(ctx.now()) - 3600000).toISOString()).n;
  if (recent >= 5) return out;
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  ctx.db.run(`INSERT INTO web_orders (id, item_kind, item_id, email, payload, code_hash, ip, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    out.order_id, item.kind, item.id, buyer.email, JSON.stringify({ buyer, athlete, self, skip_trial: skipTrial }), sha256(`${out.order_id}:${code}`), ip ?? null,
    new Date(Date.parse(ctx.now()) + CODE_MINUTES * 60000).toISOString(), ctx.now());
  await sendEmail(ctx, { to: buyer.email, subject: `Your ${biz(ctx)} code: ${code}`, sensitive: true,
    text: `Your code to finish buying ${item.name} is ${code}. It expires in ${CODE_MINUTES} minutes.\n\nIf you didn't ask for this, you can ignore this email.` });
  if (ctx.testMode && !ctx.mail?.resendKey) out.dev_code = code;
  return out;
}

const rowOf = (ctx, id) => {
  const o = ctx.db.get('SELECT * FROM web_orders WHERE id = ?', v.str(id, 'order', { max: 60 }));
  if (!o) throw notFound('Order');
  return o;
};
// Stripe's card page for the order (setup mode: saves the card, charges nothing). Test mode has no page: { test: true }.
async function cardPage(ctx, o) {
  const p = JSON.parse(o.payload);
  let customer = o.customer_ref;
  try {
    if (!customer) {
      customer = await ctx.payments.ensureCustomer({ id: o.id, name: p.buyer.name, email: o.email, metadataKey: 'web_order_id' });
      ctx.db.run('UPDATE web_orders SET customer_ref = ? WHERE id = ?', customer, o.id);
    }
    const back = `${base(ctx)}/buy?order=${encodeURIComponent(o.id)}`;
    const s = await ctx.payments.cardSetupSession({ customerId: customer, ownerKey: 'web_order_id', ownerId: o.id, successUrl: `${back}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${back}&canceled=1` });
    if (!s.url) return { test: true };
    ctx.db.run('UPDATE web_orders SET checkout_ref = ? WHERE id = ?', s.id, o.id);
    return { url: s.url };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'payment_provider_error', `The card page didn't open: ${e.message}. Try again in a minute.`);
  }
}

// Step 2: the code. Answers Stripe's card page (or, in test mode, { test: true }).
export async function verifyOrder(ctx, body = {}) {
  mustBeOpen(ctx);
  const wrong = new HttpError(401, 'invalid_code', 'That code is wrong or has expired. Check the latest email, or start again.');
  const code = v.str(body.code, 'code', { max: 12 }).replace(/\s/g, '');
  const o = ctx.db.get('SELECT * FROM web_orders WHERE id = ?', v.str(body.order_id, 'order_id', { max: 60 }));
  if (!o || o.status !== 'code_sent' || o.expires_at < ctx.now() || o.attempts >= MAX_ATTEMPTS) throw wrong;
  if (!safeEqual(o.code_hash, sha256(`${o.id}:${code}`))) { ctx.db.run('UPDATE web_orders SET attempts = attempts + 1 WHERE id = ?', o.id); throw wrong; }
  if (taken(ctx, o.email)) throw conflict('This email already has an account. Sign in and buy it from the Programs tab.');
  ctx.db.run(`UPDATE web_orders SET status = 'verified', verified_at = ?, expires_at = ? WHERE id = ?`, ctx.now(), addDays(ctx.now(), CARD_HOURS / 24), o.id);
  return { order_id: o.id, ...(await cardPage(ctx, { ...o, status: 'verified' })) };
}

// Another card after a decline, or after leaving Stripe's page without saving one.
export async function newCardPage(ctx, id) {
  mustBeOpen(ctx);
  const o = rowOf(ctx, id);
  if (o.status === 'paid') throw conflict('This order is already paid.');
  if (!['verified', 'declined'].includes(o.status) || o.expires_at < ctx.now()) throw conflict('This order has expired. Start again from the sales page.');
  return { order_id: o.id, ...(await cardPage(ctx, o)) };
}

// Step 3: the card is saved; make the account, charge, sign in. Once per order: the return page and Stripe's webhook may
// both arrive, and the second finds it done. signIn: the return page (the payer's own browser) gets the portal cookie.
export function completeOrder(ctx, id, opts = {}) { return withLock(`web-order:${id}`, () => completeNow(ctx, id, opts)); }
async function completeNow(ctx, id, { sessionId = null, test = null, ip = null, userAgent = null, signIn = true } = {}) {
  const o = rowOf(ctx, id);
  // Done already (the webhook got there first, or a refresh): sign in again only with the same card page or a test order.
  if (o.status === 'paid') {
    const same = test ? !ctx.payments.live && !!ctx.payments.testCard : !!sessionId && sessionId === o.checkout_ref;
    return done(ctx, o, { signIn: signIn && same, userAgent });
  }
  if (!['verified', 'declined'].includes(o.status)) throw conflict('Confirm your email with the code first.');
  if (o.expires_at < ctx.now()) throw conflict('This order has expired. Start again from the sales page.');
  const p = JSON.parse(o.payload);
  const item = itemOf(ctx, `${o.item_kind}:${o.item_id}`);
  let card;
  if (test) {
    if (ctx.payments.live || !ctx.payments.testCard) throw conflict('Test cards are only available in test mode.');
    card = ctx.payments.testCard({ funding: ['credit', 'debit', 'prepaid'].includes(test.funding) ? test.funding : 'credit' });
  } else {
    const sid = v.str(sessionId, 'session_id', { max: 200 });
    if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw badRequest('session_id is not a Stripe card page.');
    try { card = await ctx.payments.getSetupSession(sid); } catch (e) { throw new HttpError(502, 'payment_provider_error', `Stripe didn't answer: ${e.message}. Refresh the page in a minute.`); }
    if (card.webOrderId !== o.id) throw conflict('That card page was for a different order.');
    ctx.db.run('UPDATE web_orders SET checkout_ref = ? WHERE id = ?', sid, o.id);
    o.checkout_ref = sid;
    if (!card.paymentMethod) throw conflict('No card was saved on Stripe\'s page. Try again.');
  }
  // The account: the buyer is the account holder (or the athlete themselves, 18 or older); made once per order.
  let { family_id: familyId, client_id: clientId, guardian_id: guardianId } = o;
  if (!clientId) {
    if (taken(ctx, o.email)) throw conflict('This email already has an account. Sign in and buy it from the Programs tab.');
    const c = await createClient(ctx, { name: p.athlete, phone: p.self ? p.buyer.phone : undefined, parent: { name: p.buyer.name, email: o.email, phone: p.buyer.phone ?? undefined, relationship: p.self ? 'self' : null }, send_welcome: false });
    clientId = c.id;
    familyId = ctx.db.get('SELECT family_id FROM clients WHERE id = ?', clientId).family_id;
    const g = ctx.db.get('SELECT * FROM guardians WHERE family_id = ? ORDER BY created_at LIMIT 1', familyId);
    guardianId = g.id;
    ctx.db.run('UPDATE web_orders SET family_id = ?, client_id = ?, guardian_id = ? WHERE id = ?', familyId, clientId, guardianId, o.id);
    recordConsent(ctx, g, { ip: ip ?? o.ip });
  }
  // The card goes on the family, with the Stripe customer the card page used.
  ctx.db.run(`UPDATE families SET stripe_customer_id = COALESCE(?, stripe_customer_id), card_status = ? WHERE id = ?`, o.customer_ref, test?.decline ? 'declining' : 'ok', familyId);
  commerce.saveCardOn(ctx, payerFor(ctx, clientId), card);
  // The charge, the usual way.
  let paid = false, error = null, saleId = null, subId = null, charged = 0;
  if (item.kind === 'product') {
    const sale = await commerce.createSale(ctx, { location_id: commerce.onlineLocation(ctx), method: 'card_on_file', client_id: clientId, items: [{ product_id: item.id }], email_receipt: true, note: 'Online sales page' }, null, { online: true }).catch((e) => ({ status: 'failed', failure_reason: e.message }));
    saleId = sale.id ?? null; paid = sale.status === 'succeeded'; error = paid ? null : sale.failure_reason ?? 'The card was declined.'; charged = sale.amount_cents ?? 0;
  } else {
    const sub = await billing.subscribe(ctx, clientId, item.id, ctx.now(), { skipTrial: !!p.skip_trial, quiet: true });
    subId = sub.id;
    const fc = sub.first_charge;
    paid = !fc || fc.status === 'paid';                                   // a free trial charges nothing now
    charged = fc?.status === 'paid' ? fc.amount_cents : 0;
    if (!paid) { error = fc.error ?? 'The card was declined.'; billing.cancel(ctx, sub.id); subId = null; }   // nothing left owing on a decline
  }
  if (!paid) {
    ctx.db.run(`UPDATE web_orders SET status = 'declined', error = ?, sale_id = NULL, subscription_id = NULL WHERE id = ?`, String(error).slice(0, 300), o.id);
    return { order_id: o.id, status: 'declined', error: `The card didn't go through: ${error} Try another card.` };
  }
  ctx.db.run(`UPDATE web_orders SET status = 'paid', paid_at = ?, error = NULL, sale_id = ?, subscription_id = ? WHERE id = ?`, ctx.now(), saleId, subId, o.id);
  const after = rowOf(ctx, o.id);
  await tellEveryone(ctx, after, item, p, charged);
  return done(ctx, after, { signIn, userAgent });
}

function summary(ctx, o) {
  const item = ctx.db.get(o.item_kind === 'plan' ? 'SELECT name FROM plans WHERE id = ?' : 'SELECT name FROM products WHERE id = ?', o.item_id);
  const sub = o.subscription_id ? ctx.db.get('SELECT status, trial_ends_at, current_period_end FROM subscriptions WHERE id = ?', o.subscription_id) : null;
  const sale = o.sale_id ? ctx.db.get('SELECT amount_cents, fee_cents FROM sales WHERE id = ?', o.sale_id) : null;
  const inv = o.subscription_id ? ctx.db.get(`SELECT amount_cents, fee_cents FROM invoices WHERE subscription_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1`, o.subscription_id) : null;
  const athlete = ctx.db.get('SELECT name, athlete_id FROM clients WHERE id = ?', o.client_id);
  return { item: o.item_kind === 'plan' ? asMembership(item?.name) : item?.name ?? '', kind: o.item_kind, athlete: athlete?.name ?? null, athlete_id: athlete?.athlete_id ?? null,
    charged_cents: sale?.amount_cents ?? inv?.amount_cents ?? 0, fee_cents: sale?.fee_cents ?? inv?.fee_cents ?? 0,
    trial_ends_at: sub?.status === 'trialing' ? sub.trial_ends_at : null, next_charge_at: sub && sub.status !== 'trialing' ? sub.current_period_end : null };
}
function done(ctx, o, { signIn, userAgent }) {
  const out = { order_id: o.id, status: 'paid', redirect: '/client?finish=1&bought=1', summary: summary(ctx, o) };
  if (signIn && o.guardian_id && ctx.db.get('SELECT id FROM guardians WHERE id = ?', o.guardian_id)) {
    out.token = startPortalSession(ctx, { guardianId: o.guardian_id }, { userAgent });
    out.maxAge = SESSION_DAYS * 86400;
  }
  return out;
}

// The buyer gets how to sign in later and what's still needed; the owners hear about the new customer.
async function tellEveryone(ctx, o, item, p, charged) {
  const athlete = ctx.db.get('SELECT name, athlete_id FROM clients WHERE id = ?', o.client_id);
  const firstOf = (n) => String(n ?? '').split(' ')[0];
  const self = p.self;
  await sendEmail(ctx, { to: o.email, subject: `Welcome to ${biz(ctx)}`,
    text: `Hi ${firstOf(p.buyer.name)},\n\nThanks for buying ${item.name}${self ? '' : ` for ${athlete.name}`}. ${charged ? `We charged ${money(charged)} to your card; a receipt is on its way.` : 'Nothing was charged today.'}\n\n` +
      `${self ? 'Your' : `${firstOf(athlete.name)}'s`} Athlete ID is ${athlete.athlete_id}. Sign in any time at ${base(ctx)}/client with this email address (we email you a code; you can set a password once you're in).\n\n` +
      `One thing we need before ${self ? 'you train' : `${firstOf(athlete.name)} trains`}: sign the waiver (Family tab). Then book a session and finish ${self ? 'your' : 'the'} profile whenever you're ready.\n\nSee you soon,\n${biz(ctx)}` });
  for (const owner of ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`)) {
    await sendEmail(ctx, { to: owner.email, subject: `New online purchase: ${athlete.name}, ${item.name}`,
      text: `${p.buyer.name}${self ? '' : ` (parent of ${athlete.name})`} bought ${item.name} on the online sales page${charged ? ` and paid ${money(charged)}` : ' (free trial, nothing charged yet)'}.\n\nEmail: ${o.email}${p.buyer.phone ? `\nPhone: ${p.buyer.phone}` : ''}\nAthlete ID: ${athlete.athlete_id}\n\nTheir profile: ${base(ctx)}/#/clients/${o.client_id}\n\nThey still need to sign the waiver before they train.` });
  }
}
