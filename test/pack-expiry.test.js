import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { creditBalance, creditDetail } from '../src/services/commerce.js';
import { addMonths } from '../src/util.js';

// Session packs expire (owner decision: "private training has a year expiration"): a session bought can be used for
// pack_expiry_months (12 by default; 0 = never) from the day it was bought. Nothing is stored: the ledger stays, and what's
// left is worked out lot by lot (oldest lot used first, a cancelled booking's session goes back where it came from).
let app, base, owner, coach, facility, ava;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const ago = (months) => addMonths(new Date().toISOString(), -months);
let n = 0;
const row = (type, delta, at, reason = delta > 0 ? 'purchase' : 'check_in') => app.ctx.db.run('INSERT INTO session_credits (id, client_id, credit_type, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)', `cr_t${++n}`, ava.id, type, delta, reason, at);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
});
after(() => app.server.close());

test('a pack bought over a year ago is gone; a newer one counts, with its date', async () => {
  assert.equal((await coach('GET', '/v1/settings')).body.pack_expiry_months, '12', 'a year by default');
  row('private', 5, ago(13));                                  // bought 13 months ago: expired
  row('private', 4, ago(2));                                   // bought 2 months ago: good for 10 more
  assert.equal(creditBalance(app.ctx, ava.id, 'private'), 4);
  const d = creditDetail(app.ctx, ava.id);
  assert.deepEqual([d.private, d.group, d.expired.private, d.lots.private.length, d.lots.private[0].sessions], [4, 0, 5, 1, 4]);
  assert.equal(d.lots.private[0].expires_at.slice(0, 7), addMonths(ago(2), 12).slice(0, 7), 'the lot runs out 12 months after it was bought');
  const page = (await owner('GET', `/v1/clients/${ava.id}`)).body;
  assert.deepEqual([page.credits.private, page.session_credits, page.credits.expired.private, page.credits.lots.private[0].sessions], [4, 4, 5, 4], 'the client page reads the same');
  const listed = (await owner('GET', '/v1/clients')).body.data.find((c) => c.id === ava.id);
  assert.equal(listed.credits.private, 4, 'the client list too');
  const bal = (await owner('GET', `/v1/clients/${ava.id}/credits`)).body;
  assert.deepEqual([bal.balance, bal.detail.expiry_months], [4, 12]);
});

test('the oldest good pack is used first, and a cancelled booking\'s session goes back to the pack it came from', async () => {
  row('private', 2, ago(1));                                   // a second, newer pack
  const used = await owner('POST', `/v1/clients/${ava.id}/check-ins`, { location_id: facility.id, credit_type: 'private' });
  assert.equal(used.status, 201, JSON.stringify(used.body));
  assert.deepEqual([used.body.covered_by, used.body.credits_left], ['credit', 5]);
  let lots = creditDetail(app.ctx, ava.id).lots.private;
  assert.deepEqual(lots.map((l) => l.sessions), [3, 2], 'taken from the 2-month-old pack, not the newer one, and never the expired one');
  row('private', 1, new Date().toISOString(), 'cancel');       // a booking cancelled: the session comes back
  lots = creditDetail(app.ctx, ava.id).lots.private;
  assert.deepEqual(lots.map((l) => l.sessions), [4, 2], 'back on the pack it came from, keeping that pack\'s date');
  assert.equal(creditBalance(app.ctx, ava.id, 'private'), 6);
});

test('a client with only expired sessions can\'t check in on them; the owner sets the months, 0 means never', async () => {
  row('group', 3, ago(14));
  const refused = await owner('POST', `/v1/clients/${ava.id}/check-ins`, { location_id: facility.id, credit_type: 'group' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /has no group sessions left/);
  assert.equal((await coach('PATCH', '/v1/settings', { pack_expiry_months: 0 })).status, 403);
  assert.equal((await owner('PATCH', '/v1/settings', { pack_expiry_months: 61 })).status, 400);
  assert.equal((await owner('PATCH', '/v1/settings', { pack_expiry_months: 0 })).status, 200);
  const never = creditDetail(app.ctx, ava.id);
  assert.deepEqual([never.private, never.group, never.expired.private, never.lots.private[0].expires_at], [11, 3, 0, null], 'with no expiry every session counts');
  assert.equal((await owner('POST', `/v1/clients/${ava.id}/check-ins`, { location_id: facility.id, credit_type: 'group' })).status, 201);
  await owner('PATCH', '/v1/settings', { pack_expiry_months: 12 });
  assert.deepEqual([creditBalance(app.ctx, ava.id, 'private'), creditBalance(app.ctx, ava.id, 'group')], [6, 0]);
  // The portal shows the family the same numbers and the date.
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com' }) })).json()).dev_code;
  const ver = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com', code }) });
  const cookie = ver.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${base}/portal/api/me`, { headers: { cookie } })).json();
  const a = me.athletes.find((x) => x.id === ava.id);
  assert.deepEqual([a.credits.private, a.credits.group, a.credits.lots.private.length], [6, 0, 2]);
  assert.ok(a.credits.lots.private[0].expires_at);
});
