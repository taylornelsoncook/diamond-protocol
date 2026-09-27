import { getSetting, payerFor } from './families.js';
import { sendEmail } from './mail.js';
import { textFamily } from './sms.js';
import { invoicePayLink } from './paylinks.js';

// Automatic emails. Each kind can be turned off in Hours & settings; everything lands in the outbox either way.
export const EMAIL_KINDS = {
  welcome: 'Welcome, when a family signs up or you add them',
  receipts: 'Receipts for sales and membership payments',
  trial_ending: 'Reminder 3 days before a free trial ends',
  payment_failed: 'When a membership payment doesn\'t go through'
};
const on = (ctx, kind) => !getSetting(ctx, 'emails_off').split(',').includes(kind);
const biz = (ctx) => getSetting(ctx, 'business_name');
const base = (ctx) => ctx.publicUrl ?? '';
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const day = (ctx, iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: getSetting(ctx, 'timezone') }) : '');
const first = (name) => String(name ?? '').split(' ')[0];
const send = (ctx, to, subject, text) => (to ? sendEmail(ctx, { to, subject, text }).catch((e) => console.error('email', e.message)) : Promise.resolve());
const familyEmails = (ctx, familyId) => ctx.db.all('SELECT name, email FROM guardians WHERE family_id = ? ORDER BY is_primary DESC', familyId);

// ---------- Welcome ----------
export async function welcomeFamily(ctx, familyId, { selfSignup = false } = {}) {
  if (!on(ctx, 'welcome')) return;
  const kids = ctx.db.all('SELECT name, athlete_id FROM clients WHERE family_id = ? ORDER BY name', familyId);
  for (const g of familyEmails(ctx, familyId)) {
    await send(ctx, g.email, `Welcome to ${biz(ctx)}`,
      `Hi ${first(g.name)},\n\n${selfSignup ? 'Your family account is ready.' : `${biz(ctx)} set up your family account.`}${kids.length ? ` Athletes: ${kids.map((k) => `${k.name} (${k.athlete_id})`).join(', ')}.` : ''}\n\n` +
      `Sign in at ${base(ctx)}/parent with this email address. We'll send you a code each time, so there's no password to remember.\n\n` +
      `Before the first session:\n1. Sign the waiver (Family tab)\n2. Add a card for memberships, packs and camps (Family tab)\n3. Book a class, private session or evaluation (Book tab)\n\nSee you soon,\n${biz(ctx)}`);
  }
}
export async function welcomeClient(ctx, clientId) {
  if (!on(ctx, 'welcome')) return;
  const c = ctx.db.get('SELECT name, email, access_token, family_id FROM clients WHERE id = ?', clientId);
  if (!c?.email || c.family_id) return;
  await send(ctx, c.email, `Welcome to ${biz(ctx)}`,
    `Hi ${first(c.name)},\n\nYour account is ready. Your workouts are here (this link is just for you, so keep it private):\n${base(ctx)}/app?token=${c.access_token}\n\nSee you soon,\n${biz(ctx)}`);
}

// ---------- Receipts ----------
export async function saleReceipt(ctx, saleId) {
  if (!on(ctx, 'receipts')) return;
  const s = ctx.db.get(`SELECT s.*, l.name AS location_name FROM sales s JOIN locations l ON l.id = s.location_id WHERE s.id = ?`, saleId);
  if (!s?.client_id || s.status !== 'succeeded') return;
  const payer = payerFor(ctx, s.client_id);
  const athlete = ctx.db.get('SELECT name FROM clients WHERE id = ?', s.client_id);
  const items = ctx.db.all('SELECT name, quantity, unit_price_cents FROM sale_items WHERE sale_id = ?', saleId);
  const how = { card_on_file: `card ending ${s.card_last4 ?? payer.card_last4 ?? ''}`, tap_to_pay: `card ending ${s.card_last4 ?? ''}`, reader: `card ending ${s.card_last4 ?? ''}`, cash: 'cash', online: 'card online' }[s.method];
  await send(ctx, payer.email, `Receipt from ${biz(ctx)}: ${money(s.amount_cents)}`,
    `Thanks! Here's your receipt.\n\n${items.map((i) => `${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}  ${money(i.unit_price_cents * i.quantity)}`).join('\n')}\n\nTotal: ${money(s.amount_cents)}\nPaid by ${how.trim()} on ${day(ctx, s.completed_at ?? s.created_at)}\nFor ${athlete?.name ?? ''} at ${s.location_name}\nReceipt ${s.id}\n\n${biz(ctx)}${getSetting(ctx, 'business_address') ? `\n${getSetting(ctx, 'business_address')}` : ''}`);
}
export async function membershipReceipt(ctx, invoiceId, { how } = {}) {
  if (!on(ctx, 'receipts')) return;
  const inv = ctx.db.get(`SELECT i.*, p.name AS plan_name, c.name AS client_name FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = i.client_id WHERE i.id = ?`, invoiceId);
  if (!inv || inv.status !== 'paid' || !inv.amount_cents) return;
  const payer = payerFor(ctx, inv.client_id);
  await send(ctx, payer.email, `Receipt from ${biz(ctx)}: ${money(inv.amount_cents)} membership`,
    `Thanks! ${inv.client_name}'s ${inv.plan_name} is paid through ${day(ctx, inv.period_end)}.\n\nAmount: ${money(inv.amount_cents)}\nPaid by ${how ?? `card ending ${payer.card_last4 ?? ''}`} on ${day(ctx, inv.paid_at)}\nReceipt ${inv.id}\n\n${biz(ctx)}`);
}

// ---------- Trial ending ----------
export async function trialReminders(ctx, asOf = ctx.now()) {
  if (!on(ctx, 'trial_ending')) return 0;
  const soon = new Date(Date.parse(asOf) + 3 * 86400000).toISOString();
  const subs = ctx.db.all(`SELECT s.id, s.client_id, s.trial_ends_at, p.price_cents, p.name AS plan_name, c.name AS client_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = s.client_id
    WHERE s.status = 'trialing' AND s.trial_ends_at > ? AND s.trial_ends_at <= ? AND s.trial_reminded_at IS NULL`, asOf, soon);
  for (const s of subs) {
    const payer = payerFor(ctx, s.client_id);
    const card = payer.card_payment_method ? `We'll charge the card ending ${payer.card_last4}.` : `There's no card on file yet. ${payer.table === 'families' ? `Add one in the parent portal (${base(ctx)}/parent, Family tab)` : 'Reply to this email and we\'ll send you a secure link to add one'} so training isn't interrupted.`;
    await send(ctx, payer.email, `${first(s.client_name)}'s free trial ends ${day(ctx, s.trial_ends_at)}`,
      `Hi ${first(payer.name)},\n\n${s.client_name}'s free trial of ${s.plan_name} ends on ${day(ctx, s.trial_ends_at)}. After that it's ${money(s.price_cents)} a month. ${card}\n\nTo cancel before then, just reply to this email.\n\n${biz(ctx)}`);
    ctx.db.run('UPDATE subscriptions SET trial_reminded_at = ? WHERE id = ?', ctx.now(), s.id);
  }
  return subs.length;
}

// ---------- Failed payments ----------
export async function paymentFailed(ctx, invoiceId) {
  const inv = ctx.db.get(`SELECT i.*, p.name AS plan_name, c.name AS client_name, c.family_id, s.status AS sub_status FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id JOIN clients c ON c.id = i.client_id WHERE i.id = ?`, invoiceId);
  if (!inv || !['failed', 'void'].includes(inv.status)) return;
  const payer = payerFor(ctx, inv.client_id);
  const link = inv.status === 'failed' && inv.sub_status !== 'canceled' ? invoicePayLink(ctx, inv.id) : null;
  const fix = `${link ? `Pay it now by card, no sign-in needed: ${link}\n\nOr ` : ''}${payer.table === 'families' ? `${link ? 'u' : 'U'}pdate the card in the parent portal and we'll charge it right away: ${base(ctx)}/parent (Family tab).` : `${link ? 'r' : 'R'}eply to this email and we'll send you a secure link to update your card.`}`;
  const text = inv.status === 'void' || inv.sub_status === 'canceled'
    ? `Hi ${first(payer.name)},\n\nWe tried several times but couldn't charge ${money(inv.amount_cents)} for ${inv.client_name}'s ${inv.plan_name}, so the membership has been canceled.\n\nTo start again, ${payer.table === 'families' ? `add a working card at ${base(ctx)}/parent and choose a membership under Programs` : 'reply to this email'}.\n\n${biz(ctx)}`
    : `Hi ${first(payer.name)},\n\nThe ${money(inv.amount_cents)} payment for ${inv.client_name}'s ${inv.plan_name} didn't go through${inv.last_error ? ` (${inv.last_error})` : ''}. ${fix}\n\nWe'll try again on ${day(ctx, inv.next_retry_at)}. Training continues in the meantime.\n\n${biz(ctx)}`;
  const recipients = inv.family_id ? familyEmails(ctx, inv.family_id).map((g) => g.email) : [payer.email];
  if (on(ctx, 'payment_failed')) for (const to of recipients) await send(ctx, to, inv.status === 'void' ? `${first(inv.client_name)}'s membership was canceled` : `Payment didn't go through for ${first(inv.client_name)}'s membership`, text);
  if (inv.family_id) textFamily(ctx, inv.family_id, 'payment_failed', inv.status === 'void' || inv.sub_status === 'canceled'
    ? `We couldn't charge ${money(inv.amount_cents)} for ${first(inv.client_name)}'s ${inv.plan_name}, so the membership was canceled. To start again, add a working card in the parent portal: ${base(ctx)}/parent`
    : `The ${money(inv.amount_cents)} payment for ${first(inv.client_name)}'s ${inv.plan_name} didn't go through. ${link ? `Pay now: ${link} (or update your card in the parent portal).` : `Update your card: ${base(ctx)}/parent (Family tab).`} We'll try again ${day(ctx, inv.next_retry_at)}.`);
}
