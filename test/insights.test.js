import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { atRisk, buildDigest, weeklyDigest } from '../src/services/insights.js';
import { newId } from '../src/util.js';

// Athletes drifting away, and the owner's Monday summary.
const TZ = 'America/Chicago';
let app, owner, coach, frontDesk, facility, ava, ben;
const DAY = 86400000;

async function signIn(base, email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
// A past session the athlete attended (or didn't), `daysAgo` days back.
function visit(clientId, daysAgo, status = 'attended') {
  const id = newId('cls'), at = new Date(Date.now() - daysAgo * DAY).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Speed', 'group', ?, ?, ?, 10, 'scheduled', ?)`, id, facility.id, at, at, at);
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, ?, 'membership', ?, ?)`, newId('bkg'), id, clientId, status, at, at);
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  owner = await signIn(base, 'owner@test.dev'); coach = await signIn(base, 'coach@test.dev'); frontDesk = await signIn(base, 'desk@test.dev');
  await owner('PATCH', '/v1/settings', { timezone: TZ });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  // Ava came twice a week for six weeks, then stopped. Ben keeps coming.
  for (let d = 15; d <= 55; d += 3.5) visit(ava.id, d);
  for (let d = 2; d <= 55; d += 3.5) visit(ben.id, d);
  for (const d of [20, 21, 22]) app.ctx.db.run('INSERT INTO daily_checkins (id, client_id, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', newId('dc'), ava.id, new Date(Date.now() - d * DAY).toISOString().slice(0, 10), app.ctx.now(), app.ctx.now());
});
after(() => app.server.close());

test('an athlete who stopped coming is flagged with plain reasons; a regular is not', () => {
  const list = atRisk(app.ctx);
  assert.equal(list.length, 1);
  const a = list[0];
  assert.equal(a.name, 'Ava Lopez');
  assert.equal(a.family_name, 'Lopez family');
  assert.ok(a.score >= 65, `score ${a.score}`);
  assert.match(a.reasons[0], /^No sessions in 2 weeks \(was coming about 2 a week\)$/);
  assert.ok(a.reasons.includes('Nothing booked for the next 2 weeks'));
  assert.ok(a.reasons.includes('Stopped doing daily check-ins'));
});

test('payment problems count for the owner but coaches never see them; front desk sees nothing', async () => {
  const plan = (await owner('POST', '/v1/plans', { name: 'Membership', price_cents: 15000, trial_days: 0 })).body;
  await owner('POST', `/v1/clients/${ben.id}/subscription`, { plan_id: plan.id });
  app.ctx.db.run(`UPDATE subscriptions SET status = 'past_due' WHERE client_id = ?`, ben.id);
  for (let i = 0; i < 2; i++) visit(ben.id, 5 + i, 'no_show');
  const o = (await owner('GET', '/v1/at-risk')).body.data.find((r) => r.name === 'Ben Park');
  assert.ok(o, 'failed payment + no-shows + nothing booked puts Ben on the owner\'s list');
  assert.ok(o.reasons.includes('Membership payment failed'));
  const c = (await coach('GET', '/v1/at-risk')).body.data;
  assert.equal(c.find((r) => r.name === 'Ben Park'), undefined, 'without the payment signal Ben is under the line for coaches');
  assert.ok(c.every((r) => !r.reasons.some((x) => /payment/i.test(x)) && r.membership === undefined));
  assert.equal((await frontDesk('GET', '/v1/at-risk')).status, 403);
});

test('the weekly summary shows money, members, athletes to check on and up to three actions', async () => {
  app.ctx.db.run(`INSERT INTO sales (id, location_id, client_id, method, status, amount_cents, refunded_cents, created_at, completed_at) VALUES (?, ?, ?, 'cash', 'succeeded', 5000, 0, ?, ?)`,
    newId('sale'), facility.id, ava.id, new Date(Date.now() - 2 * DAY).toISOString(), new Date(Date.now() - 2 * DAY).toISOString());
  const d = buildDigest(app.ctx);
  assert.equal(d.takings.sales, 5000);
  assert.ok(d.at_risk.some((r) => r.name === 'Ava Lopez'));
  assert.ok(d.actions.length >= 1 && d.actions.length <= 3);
  assert.match(d.actions.join(' '), /Check in with Ava/);
  const r = await owner('GET', '/v1/digest');
  assert.equal(r.status, 200);
  assert.match(r.body.text, /Money in: \$50/);
  assert.match(r.body.text, /Athletes who may be drifting away:\n- Ava Lopez: No sessions in 2 weeks/);
  assert.match(r.body.text, /https:\/\/app\.example\.org\//);
  assert.equal((await coach('GET', '/v1/digest')).status, 403, 'the summary includes money, so owners only');
  const sent = await owner('POST', '/v1/digest/send');
  assert.equal(sent.body.sent_to, 1);
  const mail = app.ctx.db.get(`SELECT * FROM outbox WHERE to_email = 'owner@test.dev' ORDER BY rowid DESC LIMIT 1`);
  assert.match(mail.subject, /^Your week at Diamond Protocol: \$50 in, \d+ athletes? to check on$/);
});

test('the summary goes out once, on Monday after 7 am business time, unless turned off', async () => {
  const monday8 = '2026-10-05T13:00:00.000Z';   // 8 am in Chicago (CDT)
  const monday6 = '2026-10-05T11:00:00.000Z';   // 6 am
  const sunday = '2026-10-04T15:00:00.000Z';
  app.ctx.db.run(`DELETE FROM settings WHERE key = 'digest_sent_on'`);
  assert.equal(await weeklyDigest(app.ctx, sunday), null);
  assert.equal(await weeklyDigest(app.ctx, monday6), null);
  assert.ok(await weeklyDigest(app.ctx, monday8));
  assert.equal(await weeklyDigest(app.ctx, '2026-10-05T16:00:00.000Z'), null, 'only once that Monday');
  await owner('PATCH', '/v1/settings', { weekly_digest: 'off' });
  assert.equal(await weeklyDigest(app.ctx, '2026-10-12T13:00:00.000Z'), null);
  assert.equal((await owner('GET', '/v1/settings')).body.weekly_digest, 'off');
});
