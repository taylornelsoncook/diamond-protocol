// Memberships renew on the 1st (owner decision): a start mid-month is charged for the days left in that month, renewals
// land on the 1st at the full price, a trial or a resume mid-month is prorated the same way, and the anniversary setting
// keeps a month from the start day. Business time zone America/Chicago (the default).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { addTestCard } from '../src/services/commerce.js';
import { runBilling, periodFor, quote } from '../src/services/billing.js';
import { updateSettings } from '../src/services/families.js';

let app, base, token, plan, trialPlan;
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const setNow = (iso) => { app.ctx.now = () => iso; };
const client = async (name) => { const c = (await call('POST', '/v1/clients', { name, email: `${name.toLowerCase().replace(' ', '.')}@example.com` })).body; await addTestCard(app.ctx, c.id); return c; };
const invoices = (clientId) => app.ctx.db.all('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at, rowid', clientId);
const sub = (clientId) => app.ctx.db.get('SELECT * FROM subscriptions WHERE client_id = ?', clientId);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.test' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  token = (await (await fetch(base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.dev', password: 'owner-password-1' }) })).json()).token;
  plan = (await call('POST', '/v1/plans', { name: 'Hybrid Coaching', price_cents: 24900, trial_days: 0 })).body;
  trialPlan = (await call('POST', '/v1/plans', { name: 'Try it', price_cents: 24900, trial_days: 7 })).body;
});
after(() => app.server.close());

test('the period runs to the 1st and costs the days left', () => {
  setNow('2026-10-16T15:00:00.000Z');                         // Oct 16, 10 am in Chicago
  const p = periodFor(app.ctx, app.ctx.now(), 24900);
  assert.equal(p.end, '2026-11-01T05:00:00.000Z');            // Nov 1 midnight Chicago (CDT)
  assert.deepEqual([p.days, p.days_in_month, p.prorated, p.amount_cents], [16, 31, true, 12852]);   // 24900 × 16 / 31
  const first = periodFor(app.ctx, '2026-11-01T06:00:00.000Z', 24900);   // Nov 1 midnight Chicago (CST)
  assert.deepEqual([first.end, first.amount_cents, first.prorated], ['2026-12-01T06:00:00.000Z', 24900, false]);
  const lastDay = periodFor(app.ctx, '2026-10-31T20:00:00.000Z', 100);  // the 31st on a $1 plan: 3 cents is under Stripe's smallest, so nothing
  assert.deepEqual([lastDay.days, lastDay.amount_cents], [1, 0]);
  const ann = periodFor(app.ctx, '2026-10-16T15:00:00.000Z', 24900, 'anniversary');
  assert.deepEqual([ann.end, ann.amount_cents, ann.prorated], ['2026-11-16T15:00:00.000Z', 24900, false]);
  const q = quote(app.ctx, plan.id, '2026-10-16T15:00:00.000Z');
  assert.deepEqual({ ...q, plan_id: undefined }, { plan_id: undefined, plan_name: 'Hybrid Coaching', monthly_cents: 24900, monthly_fee_cents: 0, trial_days: 0, plan_trial_days: 0, skip_trial: false, sessions_per_month: null, cycle: 'first', charge_now_cents: 12852, fee_cents: 0, prorated: true, days: 16, days_in_month: 31, period_start: '2026-10-16', period_end: '2026-11-01', next_charge_on: '2026-11-01' });
  const t = quote(app.ctx, trialPlan.id, '2026-10-16T15:00:00.000Z');
  assert.deepEqual([t.charge_now_cents, t.trial_days, t.next_charge_on], [0, 7, '2026-10-23']);
});

test('starting mid-month charges the days left, then the full price on the 1st', async () => {
  setNow('2026-10-16T15:00:00.000Z');
  const ava = await client('Ava Lopez');
  const q = (await call('GET', `/v1/plans/${plan.id}/quote`)).body;
  assert.equal(q.charge_now_cents, 12852);
  const r = await call('POST', `/v1/clients/${ava.id}/subscription`, { plan_id: plan.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'active');
  assert.equal(r.body.current_period_end, '2026-11-01T05:00:00.000Z');
  assert.deepEqual({ ...r.body.first_charge, invoice_id: undefined }, { invoice_id: undefined, amount_cents: 12852, fee_cents: 0, status: 'paid', error: null, period_end: '2026-11-01T05:00:00.000Z', prorated: true });
  assert.deepEqual(invoices(ava.id).map((i) => [i.amount_cents, i.status, i.period_start, i.period_end]), [[12852, 'paid', '2026-10-16T15:00:00.000Z', '2026-11-01T05:00:00.000Z']]);
  // The renewal on the 1st: the whole of November.
  setNow('2026-11-01T06:30:00.000Z');
  const s1 = await runBilling(app.ctx);
  assert.equal(s1.renewed, 1);
  assert.deepEqual(invoices(ava.id).slice(1).map((i) => [i.amount_cents, i.status, i.period_start, i.period_end]), [[24900, 'paid', '2026-11-01T05:00:00.000Z', '2026-12-01T06:00:00.000Z']]);
  assert.equal(sub(ava.id).current_period_end, '2026-12-01T06:00:00.000Z');
  // Nothing more until December.
  setNow('2026-11-20T15:00:00.000Z');
  assert.equal((await runBilling(app.ctx)).renewed, 0);
  setNow('2026-12-01T06:05:00.000Z');
  assert.equal((await runBilling(app.ctx)).renewed, 1);
  assert.equal(invoices(ava.id).at(-1).amount_cents, 24900);
  assert.equal(sub(ava.id).current_period_end, '2027-01-01T06:00:00.000Z');
});

test('a trial ending mid-month is charged for the days left, then the 1st', async () => {
  setNow('2026-10-10T15:00:00.000Z');
  const ben = await client('Ben Park');
  const r = await call('POST', `/v1/clients/${ben.id}/subscription`, { plan_id: trialPlan.id });
  assert.equal(r.body.status, 'trialing');
  assert.equal(r.body.first_charge, null);
  assert.equal(invoices(ben.id).length, 0, 'nothing charged during the trial');
  setNow('2026-10-17T16:00:00.000Z');                           // the trial ended Oct 17 at 10 am Chicago
  assert.equal((await runBilling(app.ctx)).renewed, 1);
  const inv = invoices(ben.id);
  assert.equal(inv.length, 1);
  assert.deepEqual([inv[0].amount_cents, inv[0].period_end], [Math.round((24900 * 15) / 31), '2026-11-01T05:00:00.000Z']);   // Oct 17 to 31: 15 days
  assert.equal(sub(ben.id).status, 'active');
});

test('resuming a paused membership mid-month is prorated too, and a start on the 1st pays the whole month', async () => {
  setNow('2026-10-01T06:00:00.000Z');                           // Oct 1, 1 am Chicago
  const cole = await client('Cole Jensen');
  const r = await call('POST', `/v1/clients/${cole.id}/subscription`, { plan_id: plan.id });
  assert.deepEqual([r.body.first_charge.amount_cents, r.body.first_charge.prorated, r.body.current_period_end], [24900, false, '2026-11-01T05:00:00.000Z']);
  assert.equal((await call('POST', `/v1/clients/${cole.id}/subscription/pause`, {})).status, 200);
  setNow('2026-11-21T15:00:00.000Z');                           // Nov 21: 10 of 30 days left
  const back = await call('POST', `/v1/clients/${cole.id}/subscription/resume`, {});
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const inv = invoices(cole.id).at(-1);
  assert.deepEqual([inv.amount_cents, inv.period_end], [Math.round((24900 * 10) / 30), '2026-12-01T06:00:00.000Z']);
});

test('the anniversary setting keeps a month from the start day', async () => {
  updateSettings(app.ctx, { billing_cycle: 'anniversary' });
  setNow('2026-10-16T15:00:00.000Z');
  const dee = await client('Dee Nguyen');
  const r = await call('POST', `/v1/clients/${dee.id}/subscription`, { plan_id: plan.id });
  assert.deepEqual([r.body.first_charge.amount_cents, r.body.first_charge.prorated, r.body.current_period_end], [24900, false, '2026-11-16T15:00:00.000Z']);
  assert.equal((await call('GET', `/v1/plans/${plan.id}/quote`)).body.charge_now_cents, 24900);
  assert.equal((await call('PATCH', '/v1/settings', { billing_cycle: 'weekly' })).status, 400);
  assert.equal((await call('PATCH', '/v1/settings', { billing_cycle: 'first' })).status, 200);
  assert.equal((await call('GET', '/v1/settings')).body.billing_cycle, 'first');
});

test('a plan with a free trial can be started paid today, prorated to the 1st (owner\'s ask)', async () => {
  updateSettings(app.ctx, { billing_cycle: 'first' });
  setNow('2026-10-16T15:00:00.000Z');
  const q = (await call('GET', `/v1/plans/${trialPlan.id}/quote?skip_trial=true`)).body;
  assert.deepEqual([q.trial_days, q.plan_trial_days, q.skip_trial, q.charge_now_cents, q.next_charge_on], [0, 7, true, 12852, '2026-11-01']);
  assert.equal((await call('GET', `/v1/plans/${trialPlan.id}/quote`)).body.trial_days, 7, 'without the flag the trial stands');
  const fay = await client('Fay Ortiz');
  const r = await call('POST', `/v1/clients/${fay.id}/subscription`, { plan_id: trialPlan.id, skip_trial: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.trial_ends_at, r.body.first_charge.amount_cents, r.body.first_charge.prorated, r.body.current_period_end], ['active', null, 12852, true, '2026-11-01T05:00:00.000Z']);
  const gus = await client('Gus Reed');
  const t = await call('POST', `/v1/clients/${gus.id}/subscription`, { plan_id: trialPlan.id });
  assert.deepEqual([t.body.status, t.body.first_charge], ['trialing', null], 'left alone, the trial still applies');
});

test('the Stripe description names the plan, the athlete and the month', async () => {
  const seen = [];
  const real = app.ctx.payments.chargeSaved;
  app.ctx.payments.chargeSaved = async (a) => { seen.push(a.description); return real(a); };
  setNow('2026-10-16T15:00:00.000Z');
  const eve = await client('Eve Silva');
  await call('POST', `/v1/clients/${eve.id}/subscription`, { plan_id: plan.id });
  app.ctx.payments.chargeSaved = real;
  assert.deepEqual(seen, ['Hybrid Coaching membership, Eve Silva, 2026-10-16 to 2026-11-01']);
});
