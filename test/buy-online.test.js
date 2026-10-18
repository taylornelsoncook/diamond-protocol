import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { handleStripeEvent } from '../src/services/commerce.js';
import { resetRateLimits } from '../src/services/security.js';

// The online sales page (owner's ask: "a sales page where people can buy their package or membership online; when they
// purchase it, it prompts them to create their profile"; schema 89, services/buyonline.js, public/js/buy.js).
let app, base, owner, pack, plan, trialPlan;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const pub = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] ?? null };
};
const mailTo = (email) => app.ctx.db.all('SELECT subject, body FROM outbox WHERE to_email = ? ORDER BY rowid', email);
const buyer = (email, extra = {}) => ({ item: `product:${pack.id}`, athlete: { first_name: 'Ava', last_name: 'Lopez' }, buyer: { name: 'Maria Lopez', email, phone: '555-0100' }, accept_terms: true, helped_by: 'none', ...extra });
// Start, confirm the code, and finish with a test card.
async function buyAll(body, card = {}) {
  const started = await pub('POST', '/portal/api/buy', body);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const verified = await pub('POST', '/portal/api/buy/verify', { order_id: started.body.order_id, code: started.body.dev_code });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.test, true, 'test mode has no card page');
  const done = await pub('POST', `/portal/api/buy/${started.body.order_id}/simulate`, card);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { ...done, order_id: started.body.order_id };
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('billing_cycle', 'anniversary')");   // a month from today: the first charge is the full price
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev');
  pack = (await owner('POST', '/v1/products', { name: '10 privates', kind: 'pack', sessions: 10, price_cents: 70000, credit_type: 'private' })).body;
  await owner('POST', '/v1/products', { name: 'Single private', kind: 'session', sessions: 1, price_cents: 8000, credit_type: 'private' });
  await owner('POST', '/v1/products', { name: 'Team hoodie', kind: 'gear', price_cents: 4500 });
  plan = (await owner('POST', '/v1/plans', { name: 'Eight a month', price_cents: 14900, trial_days: 0, sessions_per_month: 8 })).body;
  trialPlan = (await owner('POST', '/v1/plans', { name: 'Unlimited', price_cents: 24900, trial_days: 7 })).body;
  await owner('PATCH', '/v1/settings', { terms_text: 'Our terms.', privacy_text: 'Our privacy policy.' });
});
after(() => app.server.close());
beforeEach(() => resetRateLimits());   // every call here comes from one address

test('the page lists every active plan with today\'s charge and the session packs, never gear', async () => {
  const d = (await pub('GET', '/portal/api/public/buy')).body;
  assert.equal(d.open, true);
  assert.deepEqual(d.plans.map((p) => p.name).sort(), ['Eight a month', 'Unlimited']);
  const eight = d.plans.find((p) => p.id === plan.id);
  assert.deepEqual([eight.sessions_per_month, eight.quote.charge_now_cents, eight.quote_paid], [8, 14900, null]);
  const unl = d.plans.find((p) => p.id === trialPlan.id);
  assert.deepEqual([unl.quote.trial_days, unl.quote.charge_now_cents, unl.quote_paid.charge_now_cents], [7, 0, 24900], 'a trial plan also quotes paying now');
  assert.deepEqual(d.products.map((p) => p.name), ['Single private', '10 privates']);
  assert.deepEqual([d.products[1].per_session_cents, d.products[1].saves_cents], [7000, 10000]);
});

test('buying a pack: a code proves the email, the card is saved, the account is made, the pack is paid and the buyer is signed in', async () => {
  const r = await buyAll(buyer('maria@example.com'));
  assert.equal(r.body.status, 'paid');
  assert.equal(r.body.signed_in, true);
  assert.equal(r.body.redirect, '/client?finish=1&bought=1');
  assert.ok(r.cookie?.startsWith('dp_family='), 'the portal cookie is set');
  assert.equal(r.body.token, undefined, 'the token never goes back in the body');
  assert.deepEqual([r.body.summary.item, r.body.summary.athlete, r.body.summary.charged_cents], ['10 privates', 'Ava Lopez', 70000]);
  // The account: a family with Maria as the holder, Ava in it, the card on file, ten private sessions.
  const c = app.ctx.db.get(`SELECT * FROM clients WHERE name = 'Ava Lopez'`);
  const f = app.ctx.db.get('SELECT * FROM families WHERE id = ?', c.family_id);
  const g = app.ctx.db.get('SELECT * FROM guardians WHERE family_id = ?', f.id);
  assert.deepEqual([g.name, g.email, g.phone], ['Maria Lopez', 'maria@example.com', '555-0100']);
  assert.ok(f.card_payment_method && f.card_last4 === '4242' && f.card_funding === 'credit');
  assert.equal((await owner('GET', `/v1/clients/${c.id}`)).body.credits.private, 10);
  const sale = app.ctx.db.get(`SELECT * FROM sales WHERE client_id = ?`, c.id);
  assert.deepEqual([sale.status, sale.method, sale.amount_cents], ['succeeded', 'card_on_file', 70000]);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM consents WHERE family_id = ?', f.id).n, 2, 'terms and privacy recorded');
  // The signed-in portal opens on the profile with the waiver to sign.
  const me = (await pub('GET', '/portal/api/me', null, { cookie: r.cookie })).body;
  assert.equal(me.family.waiver.signed, false);
  assert.ok(me.to_finish.some((x) => x.key === 'waiver'));
  // Emails: the code (sensitive), the welcome with the Athlete ID and the waiver, a receipt; the owner hears about it.
  const mail = mailTo('maria@example.com').map((m) => m.subject);
  assert.ok(mail.some((s) => /code: \d{6}/.test(s)) && mail.some((s) => /^Welcome to/.test(s)) && mail.some((s) => /^Receipt/.test(s)), JSON.stringify(mail));
  assert.match(mailTo('maria@example.com').find((m) => /^Welcome/.test(m.subject)).body, new RegExp(`Athlete ID is ${c.athlete_id}[\\s\\S]*sign the waiver`));
  assert.match(mailTo('owner@test.dev').at(-1).subject, /New online purchase: Ava Lopez, 10 privates/);
  // Finishing again (a refresh, or Stripe's webhook) changes nothing.
  const again = await pub('POST', `/portal/api/buy/${r.order_id}/simulate`, {});
  assert.equal(again.body.status, 'paid');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM sales WHERE client_id = ?', c.id).n, 1);
});

test('buying a membership: charged the plan, a membership on the account; a trial plan charges nothing now unless they choose to pay now', async () => {
  const r = await buyAll({ item: `plan:${plan.id}`, self: true, athlete: { first_name: 'Cole', last_name: 'Jensen' }, buyer: { email: 'cole@example.com' }, accept_terms: true, helped_by: 'none', accept_renewal: true });
  assert.equal(r.body.status, 'paid');
  const c = app.ctx.db.get(`SELECT * FROM clients WHERE name = 'Cole Jensen'`);
  assert.equal(app.ctx.db.get('SELECT relationship FROM guardians WHERE family_id = ?', c.family_id).relationship, 'self', 'an adult buying for themselves holds their own account');
  const page = (await owner('GET', `/v1/clients/${c.id}`)).body;
  assert.deepEqual([page.subscription.status, page.subscription.plan_name, page.visits.limit], ['active', 'Eight a month', 8]);
  assert.equal(r.body.summary.charged_cents, 14900);
  // A membership needs the renewal agreement.
  const noRenewal = await pub('POST', '/portal/api/buy', { item: `plan:${plan.id}`, athlete: { first_name: 'X', last_name: 'Y' }, buyer: { name: 'Z', email: 'z@example.com' }, accept_terms: true, helped_by: 'none' });
  assert.equal(noRenewal.status, 400);
  assert.match(noRenewal.body.error.message, /renewal/);
  // A trial plan: nothing now.
  const t = await buyAll({ item: `plan:${trialPlan.id}`, athlete: { first_name: 'Ivy', last_name: 'Park' }, buyer: { name: 'Dana Park', email: 'dana@example.com' }, accept_terms: true, helped_by: 'none', accept_renewal: true });
  assert.deepEqual([t.body.status, t.body.summary.charged_cents, !!t.body.summary.trial_ends_at], ['paid', 0, true]);
  // ... unless they tick "charge now instead of the trial".
  const now = await buyAll({ item: `plan:${trialPlan.id}`, skip_trial: true, athlete: { first_name: 'Max', last_name: 'Hale' }, buyer: { name: 'Jo Hale', email: 'jo@example.com' }, accept_terms: true, helped_by: 'none', accept_renewal: true });
  assert.deepEqual([now.body.summary.charged_cents, now.body.summary.trial_ends_at], [24900, null]);
});

test('a debit card pays no card fee; a credit card pays it, shown on the page first', async () => {
  await owner('PATCH', '/v1/settings', { card_fee_pct: 2, card_fee_flat: 0, card_fee_on: ['memberships', 'store'] });
  const d = (await pub('GET', '/portal/api/public/buy')).body;
  assert.deepEqual([d.fee.pct, d.fee.store, d.products[1].fee_cents], [2, true, 1400]);
  const credit = await buyAll(buyer('kim@example.com', { athlete: { first_name: 'Kim', last_name: 'Ro' } }), { funding: 'credit' });
  assert.deepEqual([credit.body.summary.charged_cents, credit.body.summary.fee_cents], [71400, 1400]);
  const debit = await buyAll(buyer('lee@example.com', { athlete: { first_name: 'Lee', last_name: 'Ro' } }), { funding: 'debit' });
  assert.deepEqual([debit.body.summary.charged_cents, debit.body.summary.fee_cents], [70000, 0]);
  await owner('PATCH', '/v1/settings', { card_fee_on: [] });
});

test('a declined card: nothing owing, no membership left behind, no "payment failed" email, and another card finishes it', async () => {
  const started = await pub('POST', '/portal/api/buy', { item: `plan:${plan.id}`, athlete: { first_name: 'Nia', last_name: 'Cruz' }, buyer: { name: 'Rosa Cruz', email: 'rosa@example.com' }, accept_terms: true, helped_by: 'none', accept_renewal: true });
  await pub('POST', '/portal/api/buy/verify', { order_id: started.body.order_id, code: started.body.dev_code });
  const no = await pub('POST', `/portal/api/buy/${started.body.order_id}/simulate`, { decline: true });
  assert.equal(no.status, 200, JSON.stringify(no.body));
  assert.deepEqual([no.body.status, no.body.signed_in, no.cookie], ['declined', false, null]);
  assert.match(no.body.error, /didn't go through/);
  const c = app.ctx.db.get(`SELECT * FROM clients WHERE name = 'Nia Cruz'`);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM subscriptions WHERE client_id = ? AND status != 'canceled'`, c.id).n, 0, 'no membership left on a decline');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM invoices WHERE client_id = ? AND status = 'failed'`, c.id).n, 0, 'nothing owing');
  assert.ok(!mailTo('rosa@example.com').some((m) => /didn't go through/.test(m.subject)), 'the page says it; no payment-failed email');
  // Another card: the same account, now paid.
  assert.equal((await pub('POST', `/portal/api/buy/${started.body.order_id}/card`)).body.test, true);
  const yes = await pub('POST', `/portal/api/buy/${started.body.order_id}/simulate`, {});
  assert.deepEqual([yes.body.status, yes.body.signed_in], ['paid', true]);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM clients WHERE name = 'Nia Cruz'`).n, 1, 'one account');
  assert.equal(app.ctx.db.get(`SELECT status FROM subscriptions WHERE client_id = ? AND status != 'canceled'`, c.id).status, 'active');
});

test('an email that already has an account gets a sign-in link instead, and the answer looks the same', async () => {
  const fresh = await pub('POST', '/portal/api/buy', buyer('new@example.com', { athlete: { first_name: 'Bo', last_name: 'New' } }));
  const known = await pub('POST', '/portal/api/buy', buyer('maria@example.com'));
  assert.deepEqual([known.status, Object.keys(known.body).sort().filter((k) => k !== 'dev_code')], [fresh.status, Object.keys(fresh.body).sort().filter((k) => k !== 'dev_code')]);
  assert.match(mailTo('maria@example.com').at(-1).subject, /You already have a/);
  assert.match(mailTo('maria@example.com').at(-1).body, /\/client\?tab=programs/);
  assert.equal((await pub('POST', '/portal/api/buy/verify', { order_id: known.body.order_id, code: '000000' })).status, 401);
});

test('codes: a wrong code counts, five wrong ones end it; an order must be confirmed before its card; the page can be closed', async () => {
  const s = await pub('POST', '/portal/api/buy', buyer('guess@example.com', { athlete: { first_name: 'Gu', last_name: 'Ess' } }));
  assert.equal((await pub('POST', `/portal/api/buy/${s.body.order_id}/simulate`, {})).status, 409, 'not confirmed yet');
  for (let i = 0; i < 5; i++) assert.equal((await pub('POST', '/portal/api/buy/verify', { order_id: s.body.order_id, code: '111111' })).status, 401);
  assert.equal((await pub('POST', '/portal/api/buy/verify', { order_id: s.body.order_id, code: s.body.dev_code })).status, 401, 'locked after five tries');
  assert.equal((await pub('POST', '/portal/api/buy', { ...buyer('a@example.com'), item: 'product:nope' })).status, 400);
  assert.equal((await pub('POST', '/portal/api/buy', { ...buyer('a@example.com'), accept_terms: false })).status, 400);
  await owner('PATCH', '/v1/settings', { buy_online: 'off' });
  assert.equal((await pub('GET', '/portal/api/public/buy')).body.open, false);
  assert.equal((await pub('POST', '/portal/api/buy', buyer('b@example.com'))).status, 403);
  await owner('PATCH', '/v1/settings', { buy_online: 'on' });
  assert.equal((await fetch(`${base}/buy`)).status, 200, 'the page itself');
  // Starting orders and trying codes is limited per address (20 an hour).
  resetRateLimits();
  let last;
  for (let i = 0; i < 21; i++) last = await pub('POST', '/portal/api/buy/verify', { order_id: 'wo_x', code: '123456' });
  assert.equal(last.status, 429);
});

test('Stripe: the card page returns to /buy with the session, the webhook finishes an order whose buyer closed the tab, and a repeat needs the same page', async () => {
  const started = await pub('POST', '/portal/api/buy', buyer('stripe@example.com', { athlete: { first_name: 'Sam', last_name: 'Tripe' } }));
  // Stand in for Stripe: a card page, and what it answers about the finished page.
  const pages = [];
  const real = { ensureCustomer: app.ctx.payments.ensureCustomer, cardSetupSession: app.ctx.payments.cardSetupSession, getSetupSession: app.ctx.payments.getSetupSession };
  app.ctx.payments.ensureCustomer = async () => 'cus_web1';
  app.ctx.payments.cardSetupSession = async (o) => { pages.push(o); return { id: 'cs_web1', url: 'https://checkout.stripe.com/c/cs_web1' }; };
  app.ctx.payments.getSetupSession = async (id) => ({ webOrderId: id === 'cs_web1' ? started.body.order_id : 'wo_other', paymentMethod: 'pm_web1', brand: 'visa', last4: '1111', expMonth: 5, expYear: 2030, funding: 'debit' });
  try {
    const v = await pub('POST', '/portal/api/buy/verify', { order_id: started.body.order_id, code: started.body.dev_code });
    assert.equal(v.body.url, 'https://checkout.stripe.com/c/cs_web1');
    assert.equal(pages[0].successUrl, `https://app.example.org/buy?order=${started.body.order_id}&session_id={CHECKOUT_SESSION_ID}`);
    assert.deepEqual([pages[0].ownerKey, pages[0].ownerId, pages[0].customerId], ['web_order_id', started.body.order_id, 'cus_web1']);
    // The buyer closed the tab: Stripe's webhook finishes the order.
    await handleStripeEvent(app.ctx, { type: 'checkout.session.completed', data: { object: { id: 'cs_web1', mode: 'setup', metadata: { web_order_id: started.body.order_id } } } });
    const c = app.ctx.db.get(`SELECT * FROM clients WHERE name = 'Sam Tripe'`);
    const f = app.ctx.db.get('SELECT * FROM families WHERE id = ?', c.family_id);
    assert.deepEqual([f.stripe_customer_id, f.card_payment_method, f.card_funding], ['cus_web1', 'pm_web1', 'debit']);
    assert.equal((await owner('GET', `/v1/clients/${c.id}`)).body.credits.private, 10);
    // Coming back afterwards signs them in with the same page; anyone else gets no cookie.
    const backed = await pub('POST', `/portal/api/buy/${started.body.order_id}/complete`, { session_id: 'cs_web1' });
    assert.deepEqual([backed.body.status, backed.body.signed_in], ['paid', true]);
    const stranger = await pub('POST', `/portal/api/buy/${started.body.order_id}/complete`, { session_id: 'cs_someone_else' });
    assert.deepEqual([stranger.body.status, stranger.body.signed_in, stranger.cookie], ['paid', false, null]);
    // A card page for another order is refused.
    const other = await pub('POST', '/portal/api/buy', buyer('other@example.com', { athlete: { first_name: 'Oh', last_name: 'Ther' } }));
    await pub('POST', '/portal/api/buy/verify', { order_id: other.body.order_id, code: other.body.dev_code });
    const wrong = await pub('POST', `/portal/api/buy/${other.body.order_id}/complete`, { session_id: 'cs_web1' });
    assert.equal(wrong.status, 409);
  } finally { Object.assign(app.ctx.payments, real); }
});

test('who helped you: every owner and coach or No one, a coach\'s own link, and the owner\'s report of sales by coach', async () => {
  createUser(app.ctx, { email: 'riley@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dee', password: PW, role: 'front_desk' });
  const gone = createUser(app.ctx, { email: 'gone@test.dev', name: 'Gus', password: PW, role: 'coach' });
  const d = (await pub('GET', '/portal/api/public/buy')).body;
  const names = d.coaches.map((c) => c.name);
  assert.ok(names.includes('Riley') && names.includes('Olivia') && names.includes('Gus'), 'owners and coaches');
  assert.ok(!names.includes('Dee'), 'never front desk');
  assert.ok(d.coaches.every((c) => !JSON.stringify(c).includes('usr_')), 'staff ids never reach the page');
  const riley = d.coaches.find((c) => c.name === 'Riley').key, gus = d.coaches.find((c) => c.name === 'Gus').key;
  // The answer is required, and only someone on the list.
  assert.equal((await pub('POST', '/portal/api/buy', { ...buyer('h1@example.com'), helped_by: undefined })).status, 400);
  assert.equal((await pub('POST', '/portal/api/buy', { ...buyer('h1@example.com'), helped_by: 'not-a-key' })).status, 400);
  // Riley helped with a pack and a membership; Gus helped with one, then left; nobody helped with another.
  await buyAll({ ...buyer('h1@example.com', { athlete: { first_name: 'Hal', last_name: 'One' } }), helped_by: riley });
  await buyAll({ item: `plan:${plan.id}`, athlete: { first_name: 'Hana', last_name: 'Two' }, buyer: { name: 'Ho Two', email: 'h2@example.com' }, accept_terms: true, accept_renewal: true, helped_by: riley });
  await buyAll({ ...buyer('h3@example.com', { athlete: { first_name: 'Hugo', last_name: 'Three' } }), helped_by: gus });
  app.ctx.db.run('UPDATE users SET active = 0 WHERE id = ?', gone.id);
  assert.ok(!(await pub('GET', '/portal/api/public/buy')).body.coaches.some((c) => c.name === 'Gus'), 'a turned-off account leaves the list');
  assert.equal((await pub('POST', '/portal/api/buy', { ...buyer('h4@example.com'), helped_by: gus })).status, 400);
  const ownerMail = mailTo('owner@test.dev').filter((m) => m.subject.startsWith('New online purchase: Hal One'));
  assert.match(ownerMail[0].body, /Who helped them: Riley/);
  const r = await owner('GET', '/v1/billing/online-sales');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (name) => r.body.by_helper.find((x) => x.name === name);
  assert.deepEqual([row('Riley').orders, row('Riley').packs, row('Riley').memberships, row('Riley').charged_cents], [2, 1, 1, 70000 + 14900]);
  assert.equal(row('Riley').link, `https://app.example.org/buy?coach=${riley}`);
  assert.deepEqual([row('Gus').orders, row('Gus').link], [1, null], 'someone gone still shows with their sales');
  assert.equal(row('Olivia').orders, 0, 'every owner and coach has a row');
  assert.equal(r.body.by_helper.at(-1).name, 'No one');
  assert.ok(row('No one').orders >= 1);
  assert.equal(r.body.totals.helped, 3);
  assert.equal(r.body.orders.find((o) => o.athlete_name === 'Hana Two').helped_by, 'Riley');
  assert.equal(r.body.orders.find((o) => o.athlete_name === 'Hana Two').item, 'Eight a month membership');
  // Dates: nothing paid tomorrow; a bad date names the fix. Coaches never see it.
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  assert.equal((await owner('GET', `/v1/billing/online-sales?from=${tomorrow}`)).body.totals.orders, 0);
  assert.equal((await owner('GET', '/v1/billing/online-sales?from=soon')).status, 400);
  const asCoach = await signIn('riley@test.dev');
  assert.equal((await asCoach('GET', '/v1/billing/online-sales')).status, 403);
});

test('the version 88 upgrade adds the order table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-v88-')), file = join(dir, 'dp.db');
  const raw = new DatabaseSync(file);
  raw.exec(readFileSync('test/fixtures/schema-v88.sql', 'utf8'));
  raw.exec('PRAGMA user_version = 88');
  raw.close();
  const db = openDb(file);
  assert.equal(db.get('PRAGMA user_version').user_version, 91);
  assert.ok(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_orders'"));
  db.close();
});
