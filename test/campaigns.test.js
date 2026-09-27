import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId } from '../src/util.js';

// Announcement emails to a group.
let app, base, owner, coach, draft;
const mailTo = (email) => app.ctx.db.all(`SELECT subject, body FROM outbox WHERE to_email = ? AND subject NOT LIKE 'Welcome%' ORDER BY rowid`, email);
const born = (age) => `${new Date().getFullYear() - age}-01-15`;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev');
  await owner('PATCH', '/v1/settings', { business_address: '100 Main St, Austin, TX 78701' });
  const kid = async (name, parent, email, age, sport) => (await owner('POST', '/v1/clients', { name, birth_date: born(age), sport, parent: { name: parent, email } })).body;
  const ava = await kid('Ava Lopez', 'Maria Lopez', 'maria@example.com', 11, 'Softball');
  await kid('Ben Park', 'Dana Park', 'dana@example.com', 16, 'Football');
  const cal = await kid('Cal Reyes', 'Kim Reyes', 'kim@example.com', 12, 'Baseball');
  const plan = (await owner('POST', '/v1/plans', { name: 'Monthly', price_cents: 15000 })).body;
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, newId('sub'), ava.id, plan.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, canceled_at, created_at, updated_at) VALUES (?, ?, ?, 'canceled', ?, ?, ?, ?, ?)`, newId('sub'), cal.id, plan.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  await owner('POST', '/v1/leads', { parent_name: 'Lee Tran', email: 'lee@example.com', athlete_age: 10, sport: 'Softball', follow_up: false });
});
after(() => app.server.close());

test('pick a group and see who it reaches', async () => {
  const count = async (audience) => (await owner('POST', '/v1/campaigns/preview', { audience })).body;
  assert.equal((await count({ group: 'everyone' })).count, 3);
  assert.deepEqual((await count({ group: 'members' })).sample, ['Maria Lopez']);
  assert.deepEqual((await count({ group: 'lapsed' })).sample, ['Kim Reyes']);
  assert.deepEqual((await count({ group: 'everyone', age_min: 10, age_max: 12 })).sample.sort(), ['Kim Reyes', 'Maria Lopez']);
  assert.deepEqual((await count({ group: 'everyone', sport: 'foot' })).sample, ['Dana Park']);
  const leads = await count({ group: 'leads', sport: 'softball' });
  assert.deepEqual([leads.count, leads.description], [1, 'Families who asked about training, softball']);
  assert.equal((await owner('POST', '/v1/campaigns/preview', { audience: { age_min: 14, age_max: 9 } })).status, 400);
  // Owners only: coaches never email the whole business.
  assert.equal((await coach('POST', '/v1/campaigns/preview', { audience: {} })).status, 403);
});

test('a draft can be tested, then sent after confirming the number', async () => {
  draft = (await owner('POST', '/v1/campaigns', { subject: 'Summer camp is open, {first_name}', body: 'Hi {first_name},\n\nSummer camp registration is open: https://diamondprotocol.org/camp. Spots go fast.', audience: { group: 'everyone', age_max: 12 } })).body;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.audience_text, 'All families, up to age 12');
  assert.equal((await owner('POST', `/v1/campaigns/${draft.id}/test`)).body.sent_to, 'owner@test.dev');
  assert.match(mailTo('owner@test.dev')[0].subject, /^\[Test\] Summer camp is open, Taylor$/);

  const wrong = await owner('POST', `/v1/campaigns/${draft.id}/send`, { confirm_count: 3 });
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.error.message, /go to 2 people/);
  const sent = (await owner('POST', `/v1/campaigns/${draft.id}/send`, { confirm_count: 2 })).body;
  assert.deepEqual([sent.status, sent.sent], ['sent', 2]);
  const [m] = mailTo('maria@example.com');
  assert.equal(m.subject, 'Summer camp is open, Maria');
  assert.match(m.body, /^Hi Maria,/);
  assert.match(m.body, /open: https:\/\/app\.example\.org\/c\/[\w-]+\/0\. Spots/, 'the link is counted, and the full stop stays outside it');
  assert.match(m.body, /100 Main St, Austin, TX 78701/);
  assert.equal(mailTo('dana@example.com').length, 0, 'Ben is 16');
  assert.equal((await owner('PATCH', `/v1/campaigns/${draft.id}`, { subject: 'x' })).status, 409);
  assert.equal((await owner('POST', `/v1/campaigns/${draft.id}/send`, { confirm_count: 2 })).status, 409, 'never twice');
});

test('clicks are counted and "stop these emails" sticks', async () => {
  const body = mailTo('maria@example.com')[0].body;
  const link = body.match(/https:\/\/app\.example\.org(\/c\/[\w-]+\/0)/)[1];
  const go = await fetch(base + link, { redirect: 'manual' });
  assert.equal(go.headers.get('location'), 'https://diamondprotocol.org/camp');
  const stopPath = body.match(/https:\/\/app\.example\.org(\/c\/[\w-]+)\?stop=1/)[1];
  assert.match(await (await fetch(`${base}${stopPath}?stop=1`)).text(), /Yes, stop them/);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM email_optouts').n, 0, 'opening the link alone changes nothing');
  assert.match(await (await fetch(`${base}${stopPath}?stop=1`, { method: 'POST' })).text(), /won't send you announcement emails/);
  const c = (await owner('GET', `/v1/campaigns/${draft.id}`)).body;
  assert.deepEqual([c.sent, c.clicked, c.stopped], [2, 1, 1]);
  assert.equal((await owner('POST', '/v1/campaigns/preview', { audience: { group: 'everyone' } })).body.count, 2, 'Maria is left out from now on');

  const copy = (await owner('POST', `/v1/campaigns/${draft.id}/copy`)).body;
  assert.deepEqual([copy.status, copy.subject], ['draft', draft.subject]);
  assert.equal((await owner('DELETE', `/v1/campaigns/${copy.id}`)).status, 200);
  assert.equal((await owner('DELETE', `/v1/campaigns/${draft.id}`)).status, 409);
});
