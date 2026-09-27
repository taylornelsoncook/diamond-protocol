import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { normalizePhone, sendReminders, sendText, smsMode } from '../src/services/sms.js';
import { localDate, addDaysToDate } from '../src/util.js';

// Text messages: simulated until Twilio settings exist, parent opt-in, STOP replies, reminders.
const TZ = 'America/Chicago';
let sim, live, fake;
const received = [];

async function start(opts) {
  const app = createApp({ testMode: true, jobs: false, publicUrl: 'https://staging.example.org', ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const req = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null), res };
  };
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery', role: 'coach' });
  const cookie = async (email) => (await req('POST', '/auth/login', { email, password: 'correct-horse-battery' })).res.headers.get('set-cookie').split(';')[0];
  const owner = await cookie('owner@test.dev'), coach = await cookie('coach@test.dev');
  const as = (c) => (m, p, b) => req(m, p, b, { cookie: c });
  await as(owner)('PATCH', '/v1/settings', { timezone: TZ });
  const facility = (await as(owner)('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  const ava = (await as(owner)('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2012-03-10', parent: { name: 'Maria Lopez', email: 'maria@example.com', phone: '512-555-0100' } })).body;
  const parentCookie = async (email) => {
    const code = (await req('POST', '/portal/api/login', { email })).body.dev_code;
    return (await req('POST', '/portal/api/verify', { email, code })).res.headers.get('set-cookie').split(';')[0];
  };
  return { app, base, req, owner: as(owner), coach: as(coach), facility, ava, parent: as(await parentCookie('maria@example.com')) };
}
const texts = (app) => app.ctx.db.all('SELECT * FROM texts ORDER BY rowid');
const tick = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { received.push({ url: req.url, auth: req.headers.authorization, form: Object.fromEntries(new URLSearchParams(b)) }); res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"sid":"SM123"}'); });
  });
  await new Promise((r) => fake.listen(0, r));
  sim = await start({});
  live = await start({ sms: { accountSid: 'AC_test', authToken: 'tw_secret', from: '(512) 555-0199', onlyTo: '512-555-0100, +15125550142', twilioUrl: `http://127.0.0.1:${fake.address().port}` } });
});
after(() => { sim.app.server.close(); live.app.server.close(); fake.close(); });

test('phone numbers are cleaned up to +1 format, and nonsense is refused', () => {
  assert.equal(normalizePhone('(512) 555-0100'), '+15125550100');
  assert.equal(normalizePhone('1-512-555-0100'), '+15125550100');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('555-0100'), null);
  assert.equal(normalizePhone(''), null);
});

test('without Twilio settings texts are only logged, and only for parents who turned them on', async () => {
  const { app, owner, parent, facility, ava } = sim;
  assert.equal(smsMode(app.ctx), 'test');
  const tomorrow = addDaysToDate(localDate(new Date().toISOString(), TZ), 2);
  const s1 = (await owner('POST', '/v1/sessions', { name: 'Speed', kind: 'group', location_id: facility.id, date: tomorrow, start_time: '17:30', capacity: 5 })).body;
  await owner('POST', `/v1/sessions/${s1.id}/bookings`, { client_id: ava.id });
  await owner('POST', `/v1/sessions/${s1.id}/cancel`, { reason: 'Field is flooded.' });
  await tick();
  assert.equal(texts(app).length, 0, 'Maria never turned texts on');

  assert.equal((await parent('PATCH', '/portal/api/texts', { texts: true, phone: '555-0100' })).status, 400, 'needs an area code');
  const on = await parent('PATCH', '/portal/api/texts', { texts: true, phone: '(512) 555-0100' });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, { phone: '+15125550100', texts: 'on' });
  assert.equal((await parent('GET', '/portal/api/me')).body.guardian.texts, 'on');
  const confirm = texts(app).at(-1);
  assert.equal(confirm.kind, 'opt_in');
  assert.match(confirm.body, /Reply HELP for help, STOP to stop/);

  const s2 = (await owner('POST', '/v1/sessions', { name: 'Agility', kind: 'group', location_id: facility.id, date: tomorrow, start_time: '18:30', capacity: 5 })).body;
  await owner('POST', `/v1/sessions/${s2.id}/bookings`, { client_id: ava.id });
  await owner('POST', `/v1/sessions/${s2.id}/cancel`, { reason: 'Field is flooded.' });
  await tick();
  const t = texts(app).at(-1);
  assert.equal(t.kind, 'canceled');
  assert.equal(t.status, 'logged');
  assert.equal(t.phone, '+15125550100');
  assert.match(t.body, /^Diamond Protocol: Agility on .* is canceled\. Field is flooded\./);

  await owner('PATCH', '/v1/settings', { texts_off: ['canceled'] });
  const before = texts(app).length;
  const s3 = (await owner('POST', '/v1/sessions', { name: 'Power', kind: 'group', location_id: facility.id, date: tomorrow, start_time: '19:30', capacity: 5 })).body;
  await owner('POST', `/v1/sessions/${s3.id}/bookings`, { client_id: ava.id });
  await owner('POST', `/v1/sessions/${s3.id}/cancel`, {});
  await tick();
  assert.equal(texts(app).length, before, 'cancellation texts turned off');
  await owner('PATCH', '/v1/settings', { texts_off: [] });

  const fam = (await owner('GET', `/v1/clients/${ava.id}`)).body.family;
  assert.equal(fam.guardians[0].texts, 'on', 'coaches see who gets texts');
});

test('only the owner sees the texts log', async () => {
  const { owner, coach } = sim;
  const r = await owner('GET', '/v1/texts');
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'test');
  assert.ok(r.body.data.length >= 2);
  assert.equal((await coach('GET', '/v1/texts')).status, 403);
  assert.equal((await owner('POST', '/v1/texts/test', { to: '5125550100' })).status, 400, 'nothing to test without Twilio');
});

test('the day-before reminder goes once per family and session, and skips last-minute bookings', async () => {
  const { app, owner, facility, ava } = sim;
  const sib = (await owner('POST', `/v1/families/${(await owner('GET', `/v1/clients/${ava.id}`)).body.family.id}/athletes`, { name: 'Ben Lopez', birth_date: '2013-06-01' })).body;
  const day = addDaysToDate(localDate(new Date().toISOString(), TZ), 3);
  const s = (await owner('POST', '/v1/sessions', { name: 'Speed Lab', kind: 'group', location_id: facility.id, date: day, start_time: '17:00', capacity: 5 })).body;
  await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: ava.id });
  await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: sib.id });
  const asOf = new Date(Date.parse(s.starts_at) - 20 * 3600000).toISOString();
  const before = texts(app).length;
  assert.equal(await sendReminders(app.ctx, asOf), 1);
  await tick();
  const t = texts(app).at(-1);
  assert.equal(texts(app).length, before + 1, 'one text for both siblings');
  assert.equal(t.kind, 'reminder');
  assert.match(t.body, /Reminder: Ava and Ben have Speed Lab .* at Facility\. Can't make it\? Cancel in the parent portal: https:\/\/staging\.example\.org\/parent/);
  assert.equal(await sendReminders(app.ctx, asOf), 0, 'never twice');

  // Booked 10 hours before start: they just got a confirmation, so no reminder.
  const s2 = (await owner('POST', '/v1/sessions', { name: 'Late add', kind: 'group', location_id: facility.id, date: day, start_time: '18:00', capacity: 5 })).body;
  const b = (await owner('POST', `/v1/sessions/${s2.id}/bookings`, { client_id: ava.id })).body;
  app.ctx.db.run('UPDATE bookings SET created_at = ? WHERE id = ?', new Date(Date.parse(s2.starts_at) - 10 * 3600000).toISOString(), b.id);
  assert.equal(await sendReminders(app.ctx, new Date(Date.parse(s2.starts_at) - 5 * 3600000).toISOString()), 0);
  assert.ok(app.ctx.db.get('SELECT reminded_at FROM bookings WHERE id = ?', b.id).reminded_at);
});

test('a waitlist spot opening is texted', async () => {
  const { app, owner, facility, ava } = sim;
  const ben = app.ctx.db.get(`SELECT id FROM clients WHERE name = 'Ben Lopez'`);
  const day = addDaysToDate(localDate(new Date().toISOString(), TZ), 4);
  const s = (await owner('POST', '/v1/sessions', { name: 'Small group', kind: 'group', location_id: facility.id, date: day, start_time: '16:00', capacity: 1 })).body;
  const first = (await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: ben.id })).body;
  assert.equal((await owner('POST', `/v1/sessions/${s.id}/bookings`, { client_id: ava.id })).body.status, 'waitlisted');
  await owner('POST', `/v1/bookings/${first.id}/cancel`, {});
  await tick();
  const t = texts(app).at(-1);
  assert.equal(t.kind, 'waitlist');
  assert.match(t.body, /A spot opened\. Ava is now booked for Small group/);
});

test('with Twilio settings texts are sent, and a staging copy only texts allowed numbers', async () => {
  const { app, parent } = live;
  assert.equal(smsMode(app.ctx), 'restricted');
  await parent('PATCH', '/portal/api/texts', { texts: true, phone: '512.555.0100' });
  await tick();
  const m = received.at(-1);
  assert.equal(m.url, '/2010-04-01/Accounts/AC_test/Messages.json');
  assert.equal(m.auth, `Basic ${Buffer.from('AC_test:tw_secret').toString('base64')}`);
  assert.equal(m.form.To, '+15125550100');
  assert.equal(m.form.From, '+15125550199');
  assert.equal(texts(app).at(-1).status, 'sent');
  assert.equal(texts(app).at(-1).provider_id, 'SM123');

  const held = await sendText(app.ctx, { to: '(737) 555-0101', body: 'hi' });
  assert.equal(held.status, 'held');
  assert.equal(received.length, 1, 'held texts never reach Twilio');
  assert.equal((await live.owner('POST', '/v1/texts/test', { to: '+1 512 555 0142' })).status, 200);
  assert.equal(received.at(-1).form.To, '+15125550142');
});

test('replies: STOP turns texts off, START back on, HELP answers, anything else goes to the owner', async () => {
  const { app, base, parent } = live;
  const url = 'https://staging.example.org/sms/inbound';
  const sign = (params, token = 'tw_secret') => createHmac('sha1', token).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
  const reply = (params, sig = sign(params)) => fetch(base + '/sms/inbound', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params) });

  const forged = await reply({ From: '+15125550100', Body: 'STOP' }, sign({ From: '+15125550100', Body: 'STOP' }, 'wrong'));
  assert.equal(forged.status, 403);
  assert.equal((await parent('GET', '/portal/api/me')).body.guardian.texts, 'on');

  const stop = await reply({ From: '+15125550100', Body: 'Stop', MessageSid: 'SM9' });
  assert.equal(stop.status, 200);
  assert.match(await stop.text(), /<Response><\/Response>/);
  assert.equal((await parent('GET', '/portal/api/me')).body.guardian.texts, 'stopped');
  const sentBefore = received.length;
  const { textFamily } = await import('../src/services/sms.js');
  textFamily(app.ctx, (await parent('GET', '/portal/api/me')).body.family.id, 'waitlist', 'A spot opened.');
  await tick();
  assert.equal(received.length, sentBefore, 'no texts after STOP');

  await reply({ From: '+15125550100', Body: 'START' });
  assert.equal((await parent('GET', '/portal/api/me')).body.guardian.texts, 'on');

  const help = await reply({ From: '+15125550100', Body: 'help' });
  assert.match(await help.text(), /<Message>Diamond Protocol: texts about bookings.*Reply STOP to stop\.<\/Message>/);

  await reply({ From: '+15125550100', Body: 'Running 10 min late!' });
  await tick();
  const mail = app.ctx.db.get(`SELECT * FROM outbox WHERE to_email = 'owner@test.dev' ORDER BY rowid DESC LIMIT 1`);
  assert.equal(mail.subject, 'Text from Maria Lopez');
  assert.match(mail.body, /Running 10 min late!/);
  assert.equal(texts(app).filter((t) => t.direction === 'in').length, 4);
});

test('turning texts off in the portal, and deleting the family removes the texts', async () => {
  const { app, owner, parent, ava } = live;
  assert.equal((await parent('PATCH', '/portal/api/texts', { texts: false })).body.texts, 'off');
  const fam = (await owner('GET', `/v1/clients/${ava.id}`)).body.family;
  assert.ok(app.ctx.db.get('SELECT COUNT(*) AS n FROM texts WHERE family_id = ?', fam.id).n > 0);
  const ex = (await owner('GET', `/v1/families/${fam.id}/export`)).body;
  assert.ok(ex.texts.some((t) => t.direction === 'in'), 'a family\'s data download includes its texts');
  const del = await owner('DELETE', `/v1/families/${fam.id}`, { confirm: fam.name });
  assert.equal(del.status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM texts WHERE family_id = ?', fam.id).n, 0);
});
