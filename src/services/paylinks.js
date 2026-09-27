import { newId, token, v, notFound, badRequest, conflict, addDays } from '../util.js';
import { getSetting, payerFor } from './families.js';
import { sendEmail } from './mail.js';
import { sendText, familyPhones } from './sms.js';
import { emit } from './events.js';
import { markInvoicePaid } from './billing.js';
import { recordOnlineSale } from './commerce.js';

// Pay links: a page (/pay/<token>) a parent opens from an email or text to pay one thing by card without signing in:
// a membership payment that didn't go through, an unpaid session, a pack, or a set amount. With Stripe the parent pays on
// Stripe's secure page; in test mode the page offers "Simulate payment" instead. A link stops working once it's paid,
// once the thing it's for was paid some other way, when the owner cancels it, or after 30 days.
// If money arrives for something that was already paid (a parent paid by link while the card retry went through), it is
// refunded automatically and the owners are told.

const DAYS_OPEN = 30;
const biz = (ctx) => getSetting(ctx, 'business_name');
const base = (ctx) => ctx.publicUrl ?? '';
const first = (name) => String(name ?? '').split(' ')[0];
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const month = (ctx, iso) => new Date(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: getSetting(ctx, 'timezone') });
const when = (ctx, iso) => new Intl.DateTimeFormat('en-US', { timeZone: getSetting(ctx, 'timezone'), weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
export const payUrl = (ctx, l) => `${base(ctx)}/pay/${l.token}`;

// ---------- What a client owes ----------
function invoiceTarget(ctx, id) {
  const i = ctx.db.get(`SELECT i.*, p.name AS plan_name, c.name AS client_name FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = i.client_id WHERE i.id = ?`, id);
  if (!i) throw notFound('Invoice');
  return { clientId: i.client_id, invoiceId: i.id, amount: i.amount_cents, owed: ['failed', 'open'].includes(i.status), description: `${i.plan_name} for ${first(i.client_name)}, ${month(ctx, i.period_start)}` };
}
function bookingTarget(ctx, id) {
  const b = ctx.db.get(`SELECT b.*, s.name AS session_name, s.starts_at, s.series_id, s.drop_in_cents, cs.registration_cents, c.name AS client_name FROM bookings b JOIN class_sessions s ON s.id = b.session_id LEFT JOIN class_series cs ON cs.id = s.series_id JOIN clients c ON c.id = b.client_id WHERE b.id = ?`, id);
  if (!b) throw notFound('Booking');
  const reg = b.series_id && ctx.db.get(`SELECT id FROM enrollments WHERE series_id = ? AND client_id = ? AND kind = 'registration' AND status = 'active'`, b.series_id, b.client_id);
  return { clientId: b.client_id, bookingId: b.id, amount: (reg ? b.registration_cents : b.drop_in_cents) ?? 0, owed: b.coverage === 'unpaid' && b.status !== 'canceled',
    description: `${b.session_name}${reg ? ' (registration)' : ''} for ${first(b.client_name)}, ${when(ctx, b.starts_at)}` };
}
export function owedBy(ctx, clientId) {
  const invoices = ctx.db.all(`SELECT id FROM invoices WHERE client_id = ? AND status IN ('failed','open') ORDER BY created_at`, clientId).map((r) => invoiceTarget(ctx, r.id));
  const bookings = ctx.db.all(`SELECT b.id FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.coverage = 'unpaid' AND b.status != 'canceled' ORDER BY s.starts_at`, clientId)
    .map((r) => bookingTarget(ctx, r.id)).filter((t) => t.amount > 0);
  return {
    data: [...invoices.map((t) => ({ kind: 'invoice', invoice_id: t.invoiceId, description: t.description, amount_cents: t.amount })),
      ...bookings.map((t) => ({ kind: 'booking', booking_id: t.bookingId, description: t.description, amount_cents: t.amount }))],
    open_links: listPayLinks(ctx, { clientId, status: 'open' }).data
  };
}

// ---------- Owner creates, sends and cancels links ----------
function targetFor(ctx, body) {
  const kind = v.oneOf(body.kind, 'kind', ['invoice', 'booking', 'product', 'custom']);
  if (kind === 'invoice') { const t = invoiceTarget(ctx, v.str(body.invoice_id, 'invoice_id')); if (!t.owed) throw conflict('That membership payment isn\'t owed any more.'); return { kind, ...t }; }
  if (kind === 'booking') {
    const t = bookingTarget(ctx, v.str(body.booking_id, 'booking_id'));
    if (!t.owed) throw conflict('That session is already paid for.');
    if (!t.amount) throw conflict('That session has no price. Send a link for a set amount instead.');
    return { kind, ...t };
  }
  const clientId = v.str(body.client_id, 'client_id');
  if (!ctx.db.get('SELECT id FROM clients WHERE id = ?', clientId)) throw notFound('Client');
  const name = first(ctx.db.get('SELECT name FROM clients WHERE id = ?', clientId).name);
  if (kind === 'product') {
    const p = ctx.db.get('SELECT * FROM products WHERE id = ?', v.str(body.product_id, 'product_id'));
    if (!p || !p.active) throw notFound('Product');
    return { kind, clientId, productId: p.id, amount: p.price_cents, description: `${p.name} for ${name}` };
  }
  const description = String(body.description ?? '').trim();
  if (!description) throw badRequest('Say what the payment is for, like "Summer camp deposit".');
  if (description.length > 80) throw badRequest('Keep what it\'s for under 80 characters.');
  const amount = Number(body.amount_cents);
  if (!Number.isInteger(amount) || amount < 100 || amount > 1000000) throw badRequest('Enter an amount between $1 and $10,000.');
  return { kind, clientId, amount, description };
}
export async function createPayLink(ctx, body, actor) {
  const t = targetFor(ctx, body);
  const same = t.invoiceId ? ctx.db.get(`SELECT id FROM pay_links WHERE invoice_id = ? AND status = 'open' AND expires_at > ?`, t.invoiceId, ctx.now())
    : t.bookingId ? ctx.db.get(`SELECT id FROM pay_links WHERE booking_id = ? AND status = 'open' AND expires_at > ?`, t.bookingId, ctx.now()) : null;
  const id = same?.id ?? newId('pl');
  if (!same) {
    ctx.db.run(`INSERT INTO pay_links (id, token, client_id, kind, invoice_id, booking_id, product_id, description, amount_cents, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, token(18), t.clientId, t.kind, t.invoiceId ?? null, t.bookingId ?? null, t.productId ?? null, t.description, t.amount, addDays(ctx.now(), DAYS_OPEN), actor ?? null, ctx.now());
    emit(ctx, 'pay_link.created', { pay_link_id: id, client_id: t.clientId, kind: t.kind, amount_cents: t.amount });
  }
  return body.send === true ? sendPayLink(ctx, id) : getPayLink(ctx, id);
}
// The link for a failed membership payment, made on the spot for the "payment didn't go through" email and text.
export function invoicePayLink(ctx, invoiceId) {
  const open = ctx.db.get(`SELECT * FROM pay_links WHERE invoice_id = ? AND status = 'open' AND expires_at > ?`, invoiceId, ctx.now());
  if (open) return payUrl(ctx, open);
  const t = invoiceTarget(ctx, invoiceId);
  if (!t.owed) return null;
  const id = newId('pl'), tok = token(18);
  ctx.db.run(`INSERT INTO pay_links (id, token, client_id, kind, invoice_id, description, amount_cents, expires_at, created_by, created_at) VALUES (?, ?, ?, 'invoice', ?, ?, ?, ?, 'Automatic', ?)`,
    id, tok, t.clientId, invoiceId, t.description, t.amount, addDays(ctx.now(), DAYS_OPEN), ctx.now());
  return payUrl(ctx, { token: tok });
}

export function getPayLink(ctx, id) {
  const l = ctx.db.get('SELECT p.*, c.name AS client_name, c.family_id FROM pay_links p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = ?', id);
  if (!l) throw notFound('Pay link');
  return present(ctx, refresh(ctx, l));
}
function present(ctx, l) {
  const { token: tok, checkout_ref, ...rest } = l;
  void checkout_ref;
  return { ...rest, status: l.status === 'open' && l.expires_at <= ctx.now() ? 'expired' : l.status, url: payUrl(ctx, { token: tok }) };
}
export function listPayLinks(ctx, { status, clientId, limit = 100 } = {}) {
  const where = [], args = [];
  if (clientId) { where.push('p.client_id = ?'); args.push(clientId); }
  if (status) { where.push('p.status = ?'); args.push(status); }
  const rows = ctx.db.all(`SELECT p.*, c.name AS client_name, c.family_id FROM pay_links p LEFT JOIN clients c ON c.id = p.client_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC LIMIT ?`, ...args, limit);
  return { data: rows.map((l) => present(ctx, refresh(ctx, l))).filter((l) => !status || l.status === status) };
}
// Email every parent (or the adult client) and text parents who turned texts on.
export async function sendPayLink(ctx, id) {
  const l = getPayLink(ctx, id);
  if (l.status !== 'open') throw conflict(`This link is ${l.status === 'expired' ? 'expired. Make a new one' : l.status}.`);
  if (!l.client_id) throw conflict('This link has no client to send it to.');
  const payer = payerFor(ctx, l.client_id);
  const emails = l.family_id ? ctx.db.all('SELECT email FROM guardians WHERE family_id = ? AND email IS NOT NULL', l.family_id).map((g) => g.email) : [payer.email].filter(Boolean);
  const phones = l.family_id ? familyPhones(ctx, l.family_id) : [];
  if (!emails.length && !phones.length) throw conflict('There\'s no email or texting number for this family. Copy the link and send it yourself.');
  for (const to of emails) await sendEmail(ctx, { to, subject: `Pay ${money(l.amount_cents)} to ${biz(ctx)}`,
    text: `Hi ${first(payer.name)},\n\nHere's a secure link to pay ${money(l.amount_cents)} for ${l.description}:\n\n${l.url}\n\nNo sign-in needed. The link works for ${DAYS_OPEN} days.\n\n${biz(ctx)}` });
  for (const to of phones) await sendText(ctx, { to, kind: 'pay_link', familyId: l.family_id, body: `${biz(ctx)}: Pay ${money(l.amount_cents)} for ${l.description}: ${l.url}` }).catch((e) => console.error('text', e.message));
  const sentTo = [...emails, ...phones].join(', ');
  ctx.db.run('UPDATE pay_links SET sent_to = ?, sent_at = ? WHERE id = ?', sentTo.slice(0, 500), ctx.now(), id);
  return { ...getPayLink(ctx, id), emailed: emails.length, texted: phones.length };
}
export function cancelPayLink(ctx, id) {
  const l = getPayLink(ctx, id);
  if (l.status === 'paid') throw conflict('This link was already paid. Refund the sale instead.');
  ctx.db.run(`UPDATE pay_links SET status = 'canceled' WHERE id = ? AND status = 'open'`, id);
  return getPayLink(ctx, id);
}

// An open link whose invoice or session got paid some other way is closed.
function stillOwed(ctx, l) {
  if (l.kind === 'invoice') return !!l.invoice_id && invoiceTarget(ctx, l.invoice_id).owed;
  if (l.kind === 'booking') return !!l.booking_id && !!ctx.db.get('SELECT id FROM bookings WHERE id = ?', l.booking_id) && bookingTarget(ctx, l.booking_id).owed;
  return true;
}
function refresh(ctx, l) {
  if (l.status === 'open' && !stillOwed(ctx, l)) {
    ctx.db.run(`UPDATE pay_links SET status = 'settled' WHERE id = ? AND status = 'open'`, l.id);
    return { ...l, status: 'settled' };
  }
  return l;
}

// ---------- The parent's page ----------
function byToken(ctx, tok) {
  const l = ctx.db.get('SELECT p.*, c.name AS client_name FROM pay_links p LEFT JOIN clients c ON c.id = p.client_id WHERE p.token = ?', String(tok ?? ''));
  if (!l) throw notFound('Pay link');
  return refresh(ctx, l);
}
export function publicPayLink(ctx, tok) {
  const l = byToken(ctx, tok);
  const status = l.status === 'open' && l.expires_at <= ctx.now() ? 'expired' : l.status;
  const open = status === 'open';
  return {
    business_name: biz(ctx), description: l.description, amount_cents: l.amount_cents, status, paid_at: l.paid_at, athlete: first(l.client_name),
    can_pay_online: open && ctx.payments.name === 'stripe' && typeof ctx.payments.checkoutPayment === 'function',
    can_simulate: open && !!ctx.payments.simulate
  };
}
export async function checkoutPayLink(ctx, tok) {
  const l = byToken(ctx, tok);
  if (l.status !== 'open' || l.expires_at <= ctx.now()) throw conflict('This link can\'t be paid any more. Ask us for a new one.');
  if (ctx.payments.name !== 'stripe') throw conflict('Paying online needs Stripe. In test mode, use "Simulate payment".');
  const email = l.client_id ? payerFor(ctx, l.client_id).email : null;
  const url = payUrl(ctx, l);
  const s = await ctx.payments.checkoutPayment({ amountCents: l.amount_cents, description: `${biz(ctx)}: ${l.description}`, email, cardOnly: true,
    metadata: { pay_link_id: l.id }, successUrl: `${url}?paid=1`, cancelUrl: url, idempotencyKey: `pay-link-${l.id}-${Date.now().toString(36)}` });
  ctx.db.run('UPDATE pay_links SET checkout_ref = ?, checkout_started_at = ? WHERE id = ?', s.id, ctx.now(), l.id);
  return { url: s.url };
}
// Back from Stripe: ask Stripe whether it's paid rather than waiting for the webhook.
export async function confirmPayLink(ctx, tok) {
  const l = byToken(ctx, tok);
  if (l.status === 'open' && l.checkout_ref && ctx.payments.getCheckoutSession) {
    const s = await ctx.payments.getCheckoutSession(l.checkout_ref);
    if (s.paid) await completePayLink(ctx, l.id, s.ref);
  }
  return publicPayLink(ctx, tok);
}
export async function simulatePayLink(ctx, tok) {
  if (!ctx.payments.simulate) throw conflict('Only available in test mode.');
  const l = byToken(ctx, tok);
  if (l.status !== 'open' || l.expires_at <= ctx.now()) throw conflict('This link can\'t be paid any more. Ask us for a new one.');
  await completePayLink(ctx, l.id, newId('pi_test'));
  return publicPayLink(ctx, tok);
}

// Money arrived. Fulfil what the link was for, once; if it was already paid another way, refund.
export async function completePayLink(ctx, id, ref) {
  const l = ctx.db.get('SELECT * FROM pay_links WHERE id = ?', id);
  if (!l || l.status === 'paid' || (l.payment_ref && l.payment_ref === ref)) return;
  if (!stillOwed(ctx, l) || l.status === 'canceled') {
    const r = await ctx.payments.refund({ paymentRef: ref, amountCents: l.amount_cents, idempotencyKey: `pay-link-refund-${l.id}` });
    ctx.db.run(`UPDATE pay_links SET status = CASE WHEN status = 'canceled' THEN 'canceled' ELSE 'settled' END, payment_ref = ? WHERE id = ?`, ref, l.id);
    for (const o of ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`)) {
      sendEmail(ctx, { to: o.email, subject: r.ok ? `Refunded a double payment: ${money(l.amount_cents)}` : `Refund needed: ${money(l.amount_cents)} paid twice`,
        text: `${l.description} was paid by pay link after it had already been paid${l.status === 'canceled' ? ' (or after you canceled the link)' : ''}.\n\n${r.ok ? `The ${money(l.amount_cents)} was refunded automatically.` : `The automatic refund didn't work (${r.error}). Refund payment ${ref} in Stripe.`}` }).catch(() => {});
    }
    return;
  }
  const claimed = ctx.db.run(`UPDATE pay_links SET status = 'paid', paid_at = ?, payment_ref = ? WHERE id = ? AND status = 'open'`, ctx.now(), ref, l.id);
  if (!claimed.changes) return;                                  // the webhook and the return page raced; the other one did it
  let saleId = null;                                             // sale lines don't carry the athlete's name
  if (l.kind === 'invoice') await markInvoicePaid(ctx, l.invoice_id, ref, { how: 'card online' });
  else saleId = recordOnlineSale(ctx, { clientId: l.client_id, productId: l.product_id, description: l.kind === 'custom' ? l.description : l.description.replace(/ for [^,]+/, ''), amountCents: l.amount_cents, note: l.booking_id ? `booking:${l.booking_id}` : `Pay link ${l.id}`, paymentRef: ref });
  if (saleId) ctx.db.run('UPDATE pay_links SET sale_id = ? WHERE id = ?', saleId, l.id);
  emit(ctx, 'pay_link.paid', { pay_link_id: l.id, client_id: l.client_id, kind: l.kind, amount_cents: l.amount_cents, sale_id: saleId, invoice_id: l.invoice_id });
}
// Stripe webhook for a pay link's checkout. Returns false when the session isn't a pay link's.
export async function handlePayLinkCheckout(ctx, type, obj) {
  const id = obj.metadata?.pay_link_id;
  if (!id || !ctx.db.get('SELECT id FROM pay_links WHERE id = ?', id)) return false;
  if (type === 'checkout.session.completed' && obj.payment_status === 'paid') await completePayLink(ctx, id, obj.payment_intent ?? obj.id);
  return true;
}
