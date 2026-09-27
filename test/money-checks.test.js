// Daily money checks: double charges, refund spikes, stuck payments, matching with Stripe, alerts and retries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { getSetting } from '../src/services/families.js';
import { runMoneyChecks } from '../src/services/moneychecks.js';
import { newId, zonedToUtc } from '../src/util.js';

let app, base, owner, coach, loc, ava, ben, tz;
const DAY = '2026-09-20', QUIET = '2026-09-18';
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (method, path, body) => req(method, path, body, { cookie });
}
const at = (date, time) => zonedToUtc(date, time, tz);
function sale(clientId, cents, completedAt, { status = 'succeeded', ref = newId('pi_test'), method = 'card_on_file' } = {}) {
  const id = newId('sale');
  app.ctx.db.run(`INSERT INTO sales (id, client_id, location_id, method, status, amount_cents, payment_ref, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, clientId, loc.id, method, status, cents, ref, completedAt, status === 'pending' ? null : completedAt);
  return id;
}
const refundEvent = (cents, when) => app.ctx.db.run(`INSERT INTO events (id, type, data, created_at) VALUES (?, 'sale.refunded', ?, ?)`, newId('evt'), JSON.stringify({ amount_cents: cents }), when);
const mails = (subject) => app.ctx.db.all(`SELECT * FROM outbox WHERE to_email = 'owner@test.dev' AND subject LIKE ?`, `${subject}%`);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  tz = getSetting(app.ctx, 'timezone');
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olive Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'correct-horse-battery', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev');
  loc = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
});
after(() => app.server.close());

test('a quiet day is all clear and emails nobody; coaches can\'t see money checks', async () => {
  sale(ava.id, 4500, at(QUIET, '10:00'));
  sale(ben.id, 4500, at(QUIET, '10:03'));                       // same amount, different athlete: fine
  sale(ava.id, 4500, at(QUIET, '16:00'));                       // same athlete, hours later: fine
  sale(ava.id, 2000, at(QUIET, '10:01'), { method: 'cash', ref: null });
  const c = (await owner('POST', '/v1/money-checks/run', { date: QUIET })).body;
  assert.deepEqual([c.status, c.problems, c.totals.card_payments, c.totals.recorded_cents, c.stripe_checked], ['ok', 0, 3, 13500, false]);
  assert.equal(mails('Money check').length, 0);
  assert.equal((await coach('GET', '/v1/money-checks')).status, 403);
  assert.equal((await coach('POST', '/v1/money-checks/run', {})).status, 403);
  assert.equal((await owner('POST', '/v1/money-checks/run', { date: '2999-01-01' })).status, 400);
});

test('double charges, a refund spike and a stuck payment are found, named and emailed to the owner', async () => {
  sale(ava.id, 12000, at(DAY, '09:00'));
  sale(ava.id, 12000, at(DAY, '09:04'));
  sale(ben.id, 3000, at(DAY, '11:00'));
  sale(ben.id, 3000, at(DAY, '11:02'), { status: 'refunded' });  // the second one was already refunded: fine
  for (let i = 0; i < 30; i++) refundEvent(1000, at('2026-08-25', '12:00'));  // usual: $10 a day
  refundEvent(20000, at(DAY, '13:00')); refundEvent(15000, at(DAY, '14:00'));
  const stuck = new Date(Date.now() - 2 * 3600000).toISOString();
  sale(ben.id, 9900, stuck, { status: 'pending', method: 'reader' });
  sale(ava.id, 9900, new Date(Date.now() - 10 * 60000).toISOString(), { status: 'pending', method: 'reader' });  // only 10 minutes: still normal

  const c = (await owner('POST', '/v1/money-checks/run', { date: DAY })).body;
  assert.equal(c.status, 'problems');
  assert.deepEqual(c.findings.map((f) => f.type).sort(), ['double_charge', 'refund_spike', 'stuck_payment']);
  const dbl = c.findings.find((f) => f.type === 'double_charge');
  assert.equal(dbl.title, 'Possible double charge: Ava Lopez');
  assert.match(dbl.detail, /\$120 twice, 4 minutes apart/);
  assert.match(c.findings.find((f) => f.type === 'refund_spike').title, /\$350/);
  assert.match(c.findings.find((f) => f.type === 'stuck_payment').title, /Ben Park/);
  // Names are looked up when shown, never stored.
  assert.equal(app.ctx.db.get('SELECT findings FROM money_checks WHERE id = ?', c.id).findings.includes('Ava'), false);
  const [mail] = mails('Money check for Sunday, September 20: 3 things');
  assert.ok(mail);
  assert.match(mail.body, /Possible double charge: Ava Lopez/);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'money_check.problems'`).n, 1);

  const list = (await owner('GET', '/v1/money-checks')).body;
  assert.deepEqual([list.data[0].date, list.needs_look, list.stripe_connected], [DAY, 1, false]);
  const seen = (await owner('PATCH', `/v1/money-checks/${c.id}`, { reviewed: true })).body;
  assert.equal(seen.reviewed_by, 'Olive Owner');
  // Checking again with nothing new keeps the mark and sends no second email.
  const again = (await owner('POST', '/v1/money-checks/run', { date: DAY })).body;
  assert.ok(again.reviewed_at);
  assert.equal(mails('Money check for Sunday, September 20').length, 1);
  assert.equal((await owner('GET', '/v1/money-checks')).body.needs_look, 0);
  app.ctx.db.run(`UPDATE sales SET status = 'canceled' WHERE status = 'pending'`);
});

test('with Stripe connected, every card payment is matched both ways', async () => {
  const date = '2026-09-21';
  sale(ava.id, 5000, at(date, '10:00'), { ref: 'pi_match' });
  sale(ben.id, 7000, at(date, '11:00'), { ref: 'pi_missing' });
  sale(ben.id, 2500, at(date, '12:00'), { ref: 'pi_short' });
  const stripe = [
    { ref: 'pi_match', status: 'succeeded', amount_cents: 5000, created_at: at(date, '09:59') },
    { ref: 'pi_short', status: 'succeeded', amount_cents: 2000, created_at: at(date, '11:59') },
    { ref: 'pi_stranger', status: 'succeeded', amount_cents: 8800, created_at: at(date, '15:00'), description: 'Camp deposit' },
    { ref: 'pi_abandoned', status: 'canceled', amount_cents: 1000, created_at: at(date, '15:30') }
  ];
  let asked;
  app.ctx.payments.listPayments = async (range) => { asked = range; return stripe; };
  try {
    const c = (await owner('POST', '/v1/money-checks/run', { date })).body;
    assert.ok(asked.from < at(date, '00:00'), 'looks back a few days on Stripe\'s side');
    assert.deepEqual([c.stripe_checked, c.totals.stripe_cents, c.totals.recorded_cents], [true, 15800, 14500]);
    const byType = Object.fromEntries(c.findings.map((f) => [f.type, f]));
    assert.deepEqual(Object.keys(byType).sort(), ['amount_mismatch', 'app_only', 'stripe_only']);
    assert.match(byType.stripe_only.title, /Stripe took \$88 the app has no record of/);
    assert.match(byType.stripe_only.detail, /Camp deposit/);
    assert.match(byType.app_only.title, /Ben Park/);
    assert.match(byType.amount_mismatch.title, /\$25 vs \$20/);
  } finally { delete app.ctx.payments.listPayments; }
});

test('the morning job checks yesterday once, retries when Stripe is down and tells the owner if it never works', async () => {
  // 5 am business time: too early.
  assert.equal(await runMoneyChecks(app.ctx, { asOf: at('2026-09-23', '05:00') }), null);
  const first = await runMoneyChecks(app.ctx, { asOf: at('2026-09-23', '07:00') });
  assert.deepEqual([first.date, first.status, first.ran_by], ['2026-09-22', 'ok', 'Automatic']);
  assert.equal(await runMoneyChecks(app.ctx, { asOf: at('2026-09-23', '08:00') }), null, 'once a day');

  app.ctx.payments.listPayments = async () => { throw new Error('connection reset'); };
  try {
    for (let h = 7; h < 12; h++) {
      const r = await runMoneyChecks(app.ctx, { asOf: at('2026-09-24', `${String(h).padStart(2, '0')}:00`) });
      assert.deepEqual([r.status, r.attempts], ['error', h - 6]);
    }
    assert.equal(mails('The money check for Wednesday, September 23').length, 0, 'not yet');
    const sixth = await runMoneyChecks(app.ctx, { asOf: at('2026-09-24', '12:00') });
    assert.equal(sixth.attempts, 6);
    assert.match(sixth.error, /Couldn't reach Stripe: connection reset/);
    const [mail] = mails('The money check for Wednesday, September 23 couldn\'t reach Stripe');
    assert.match(mail.body, /tried 6 times/);
    assert.equal(await runMoneyChecks(app.ctx, { asOf: at('2026-09-24', '13:00') }), null, 'gives up for the day');
    // Stripe is back: pressing Check again clears it.
    app.ctx.payments.listPayments = async () => [];
    const fixed = (await owner('POST', '/v1/money-checks/run', { date: '2026-09-23' })).body;
    assert.deepEqual([fixed.status, fixed.attempts, fixed.error], ['ok', 7, null]);
  } finally { delete app.ctx.payments.listPayments; }
});
