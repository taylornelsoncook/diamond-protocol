import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';

// New athlete at a testing day (owner's ask): first name, last name, email and phone make the profile and the family
// account, add them to the day, and email them to finish the profile; the waiver is the only thing required.
let app, base, owner, coach, desk, day;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const mailTo = (email) => app.ctx.db.all('SELECT subject, body FROM outbox WHERE to_email = ? ORDER BY rowid', email);
before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  day = (await coach('POST', '/v1/testing-sessions', { name: 'Fall combine', date: '2026-10-10', tests: ['dash_40yd'] })).body;
});
after(() => app.server.close());

test('only the names are needed: a profile with no email stands alone (no family, no email sent) and takes a birthday and phone; the email can come later', async () => {
  // On a day in progress.
  const r = await desk('POST', `/v1/testing-sessions/${day.id}/quick-athlete`, { first_name: 'Audrey', last_name: 'Johnson', birth_date: '2011-06-02', phone: '720-555-0101' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.client.athlete_id, /^AUDJOH\d{4}$/); assert.equal(r.body.client.family_id, null); assert.deepEqual(r.body.sent_to, []);
  assert.ok(r.body.session.athletes.some((a) => a.client_id === r.body.client.id), 'on the day');
  const c = (await owner('GET', `/v1/clients/${r.body.client.id}`)).body;
  assert.equal(c.family, null); assert.equal(c.email, null); assert.equal(c.phone, '720-555-0101'); assert.equal(c.birth_date, '2011-06-02');
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM outbox').n, 0, 'nothing emailed with no address');
  // While a day is being set up (no day yet): the same, from /v1/athletes/quick.
  const q = await coach('POST', '/v1/athletes/quick', { first_name: 'Ben', last_name: 'Park' });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  assert.match(q.body.client.athlete_id, /^BENPAR\d{4}$/); assert.deepEqual(q.body.sent_to, []);
  // Then the new profile goes on a new day like any other.
  const made = await coach('POST', '/v1/testing-sessions', { name: 'Spring combine', date: '2026-10-24', tests: ['dash_40yd'], athletes: [{ client_id: q.body.client.id }] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.ok(made.body.athletes.some((a) => a.client_id === q.body.client.id));
  // With an email the account and the finish-profile email come as before; a bad birthday is refused.
  const e = await desk('POST', '/v1/athletes/quick', { first_name: 'Cole', last_name: 'Park', email: 'cole@example.com' });
  assert.equal(e.status, 201); assert.deepEqual(e.body.sent_to, ['cole@example.com']); assert.ok(e.body.client.family_id);
  assert.match(mailTo('cole@example.com')[0].body, /added you to a testing day/);
  assert.equal((await desk('POST', '/v1/athletes/quick', { first_name: 'Dee', last_name: 'Park', birth_date: 'yesterday' })).status, 400);
  assert.equal((await desk('POST', '/v1/athletes/quick', { first_name: 'Dee' })).status, 400);
});

test('front desk adds a new athlete at the door: profile, own account, on the day, emailed to finish the profile', async () => {
  const r = await desk('POST', `/v1/testing-sessions/${day.id}/quick-athlete`, { first_name: 'Nora', last_name: 'Quinn', email: 'nora@example.com', phone: '512-555-0199' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.client.name, 'Nora Quinn');
  assert.match(r.body.client.athlete_id, /^NORQUI\d{4}$/);
  assert.ok(r.body.session.athletes.some((a) => a.client_id === r.body.client.id), 'on the day');
  assert.deepEqual(r.body.sent_to, ['nora@example.com']);
  // Her own account: a family with her as the account holder (relationship self), the phone on it.
  const c = (await owner('GET', `/v1/clients/${r.body.client.id}`)).body;
  assert.equal(c.family.id, r.body.client.family_id);
  const g = app.ctx.db.get('SELECT name, email, phone, relationship, is_primary FROM guardians WHERE family_id = ?', c.family.id);
  assert.deepEqual(g, { name: 'Nora Quinn', email: 'nora@example.com', phone: '512-555-0199', relationship: 'self', is_primary: 1 });
  // The email: sign in at the portal's finish link, the waiver is the one thing needed.
  const mail = mailTo('nora@example.com');
  assert.equal(mail.length, 1, 'one email, the finish-your-profile one (no separate welcome)');
  assert.equal(mail[0].subject, 'Finish your profile at Diamond Protocol');
  assert.match(mail[0].body, /added you to the testing day "Fall combine"/);
  assert.match(mail[0].body, /https:\/\/app\.example\.org\/client\?finish=1/);
  assert.match(mail[0].body, /sign the waiver \(Family tab\)\. Everything else/);
  // The portal's to-finish list starts with the waiver.
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nora@example.com' }) })).json()).dev_code;
  const ver = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nora@example.com', code }) });
  const cookie = ver.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${base}/portal/api/me`, { headers: { cookie } })).json();
  assert.equal(me.to_finish[0].key, 'waiver');
  assert.ok(me.athletes.some((a) => a.name === 'Nora Quinn'));
});

test('with a parent\'s email the parent is the account holder; the same email twice is refused; the fields are checked', async () => {
  const r = await coach('POST', `/v1/testing-sessions/${day.id}/quick-athlete`, { first_name: 'Eli', last_name: 'Grant', email: 'grants@example.com', phone: '512-555-0100', parent_name: 'Hope Grant' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const g = app.ctx.db.get('SELECT name, email, relationship FROM guardians WHERE family_id = ?', r.body.client.family_id);
  assert.deepEqual(g, { name: 'Hope Grant', email: 'grants@example.com', relationship: null });
  const mail = mailTo('grants@example.com');
  assert.equal(mail[0].subject, 'Finish Eli\'s profile at Diamond Protocol');
  assert.match(mail[0].body, /Hi Hope,/);
  assert.match(mail[0].body, /added Eli Grant to the testing day/);
  assert.match(mail[0].body, /before Eli trains: sign the waiver/);
  // The same email again: the account exists (409), nothing added.
  const dup = await desk('POST', `/v1/testing-sessions/${day.id}/quick-athlete`, { first_name: 'Ivy', last_name: 'Grant', email: 'grants@example.com' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error.message, /already/);
  assert.ok(!(await coach('GET', `/v1/testing-sessions/${day.id}`)).body.athletes.some((a) => a.name === 'Ivy Grant'), 'nothing added');
  assert.equal((await desk('POST', `/v1/testing-sessions/${day.id}/quick-athlete`, { first_name: 'No', last_name: '' })).status, 400, 'both names are needed');
  assert.equal((await desk('POST', `/v1/testing-sessions/${day.id}/quick-athlete`, { first_name: 'Bad', last_name: 'Email', email: 'nope' })).status, 400);
  assert.equal((await desk('POST', `/v1/testing-sessions/tsn_nope/quick-athlete`, { first_name: 'A', last_name: 'B', email: 'ab@example.com' })).status, 404);
});
