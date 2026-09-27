// Texting groundwork: E.164 phone numbers (leads, parents and the migration of numbers already on file), the SMS outbox
// in test mode, consent before any text (one-to-one and group), STOP / START / HELP on the inbound webhook, the
// provider adapter (Twilio behind DP_SMS_PROVIDER, signature checked), message length, and who can do what.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-sms-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.RESEND_API_KEY;
delete process.env.DP_SMS_PROVIDER;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const { get, all, run, insert } = require('../server/db');
const messaging = require('../server/messaging');

let server, base, owner, coach, desk;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await as('owner@demo.test', 'demo-owner-2026');
  coach = await as('coach@demo.test', 'demo-coach-2026');
  desk = await as('desk@demo.test', 'demo-desk-2026');
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const form = headers['content-type'] === 'application/x-www-form-urlencoded';
    const res = await fetch(base + '/api' + p, {
      method, headers: { ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: (p) => req('GET', p), post: (p, b = {}, h) => req('POST', p, b, h), put: (p, b = {}) => req('PUT', p, b), login: (email, password) => req('POST', '/auth/staff/login', { email, password }) };
}
async function as(email, pw) { const c = client(); const r = await c.login(email, pw); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }
const lastSms = () => get('SELECT * FROM sms_messages ORDER BY id DESC LIMIT 1');
let n = 0;
async function lead(extra = {}) {
  n++;
  const r = await desk.post('/crm/leads', { parent_name: `Tex Person${n}`, email: `tex${n}@example.com`, phone: `(385) 555-${String(7000 + n)}`, source: 'phone', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.lead;
}

test('phone numbers: E.164 for US numbers by default, international with +, junk refused; formatting', () => {
  const ok = { '801-555-0142': '+18015550142', '(801) 555-0142': '+18015550142', '801.555.0142': '+18015550142', '1 801 555 0142': '+18015550142', '+1 (801) 555-0142': '+18015550142',
    '801-555-0142 ext 12': '+18015550142', '+44 20 7946 0958': '+442079460958' };
  for (const [v, e] of Object.entries(ok)) assert.equal(messaging.toE164(v), e, v);
  for (const v of ['', '555-0142', '123-555-0142', '801-155-0142', 'call me', '+1 234', '8015550142999']) assert.equal(messaging.toE164(v), null, v);
  assert.equal(messaging.formatPhone('+18015550142'), '(801) 555-0142');
  assert.equal(messaging.formatPhone('+442079460958'), '+442079460958');
});

test('parents: typed phones stay as typed, with an E.164 copy kept in step (migration and every save)', async () => {
  const maria = get("SELECT * FROM parents WHERE email='maria.lopez@example.com'");
  assert.equal(maria.phone, '801-555-0142', 'shown as typed'); assert.equal(maria.phone_e164, '+18015550142', 'numbers already on file were normalized');
  assert.equal((await desk.put(`/parents/${maria.id}`, { phone: '(385) 555-0199' })).status, 200);
  assert.equal(get('SELECT phone_e164 FROM parents WHERE id=?', maria.id).phone_e164, '+13855550199', 'kept in step on update');
  const fam = insert('families', { name: 'Trigger family' });
  const pid = insert('parents', { family_id: fam, name: 'New Parent', email: 'trigger.parent@example.com', phone: '801 555 0101' });
  assert.equal(get('SELECT phone_e164 FROM parents WHERE id=?', pid).phone_e164, '+18015550101', 'and on insert');
  run("UPDATE parents SET phone='not a phone' WHERE id=?", pid);
  assert.equal(get('SELECT phone_e164 FROM parents WHERE id=?', pid).phone_e164, null);
  await desk.put(`/parents/${maria.id}`, { phone: '801-555-0142' });
  // The SQL rule matches the JS rule
  for (const v of ['801-555-0142', '(801) 555-0142', '1-801-555-0142', '+1 801 555 0142', '+44 20 7946 0958', '555-0142', '123-555-0142', 'call me']) {
    const sql = messaging.SQL_E164('?');
    assert.equal(get(`SELECT ${sql} AS e`, ...Array(sql.split('?').length - 1).fill(v))?.e ?? null, messaging.toE164(v), v);
  }
});

test('consent: no text without an OK to text on file; recorded consent says how; the outbox keeps it (test mode)', async () => {
  const l = await lead();
  let r = await desk.post(`/crm/leads/${l.id}/text`, { body: 'Hi, this is Diamond Protocol.' });
  assert.equal(r.status, 400); assert.match(r.data.error, /no OK to text/i);
  assert.equal((await desk.post(`/crm/leads/${l.id}/consent`, { sms_opt_in: true })).status, 400, 'how they agreed is required');
  r = await desk.post(`/crm/leads/${l.id}/consent`, { sms_opt_in: true, source: 'Asked on the phone' });
  assert.equal(r.status, 200); assert.equal(r.data.lead.sms_opt_in, true); assert.match(r.data.lead.sms_opt_in_source, /Asked on the phone \(recorded by /);
  assert.equal((await desk.post(`/crm/leads/${l.id}/text`, { body: '' })).status, 400);
  assert.equal((await desk.post(`/crm/leads/${l.id}/text`, { body: 'x'.repeat(153 * 6 + 1) })).status, 400, 'too long');
  r = await desk.post(`/crm/leads/${l.id}/text`, { body: 'Hi Tex, evaluation times this week: Tue 11:00 or Thu 11:30.' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.status, 'logged'); assert.match(r.data.message, /outbox/);
  const m = lastSms();
  assert.deepEqual([m.direction, m.to_phone, m.status, m.lead_id, m.kind, m.sent_by], ['out', l.phone, 'logged', l.id, 'one', get("SELECT name FROM staff WHERE role='frontdesk'").name]);
  assert.equal(r.data.lead.stage, 'contacted', 'a text is a first contact');
  const d = (await desk.get(`/crm/leads/${l.id}`)).data;
  assert.ok(d.timeline.some((x) => x.kind === 'text' && /evaluation times/.test(x.body)), 'on the timeline');
  assert.equal(d.sms_mode, 'test');
  // A new number drops the OK to text
  const e = await desk.put(`/crm/leads/${l.id}`, { phone: '385-555-7999' });
  assert.equal(e.data.lead.sms_opt_in, false);
  // Settings and the test-mode line know
  assert.equal((await desk.get('/settings')).data.sms_mode, 'test');
});

test('inbound: STOP opts out everywhere and is confirmed, START opts back in, HELP answers; only signed or owner-simulated', async () => {
  const l = await lead();
  await desk.post(`/crm/leads/${l.id}/consent`, { sms_opt_in: true, source: 'Asked at the desk' });
  const from = l.phone;
  // Who can post: in test mode only a signed-in owner (the SMS outbox's Simulate a reply)
  assert.equal((await client().post('/sms/inbound', { from, body: 'STOP' })).status, 403);
  assert.equal((await desk.post('/sms/inbound', { from, body: 'STOP' })).status, 403);
  assert.equal((await coach.post('/sms/inbound', { from, body: 'STOP' })).status, 403);
  assert.equal((await owner.post('/sms/inbound', { from: 'nobody', body: 'STOP' })).status, 400);
  let r = await owner.post('/sms/inbound', { from: messaging.formatPhone(from), body: '  Stop ' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.action, 'stop'); assert.equal(r.data.lead_id, l.id);
  const row = get('SELECT sms_opt_out, sms_opt_in FROM crm_leads WHERE id=?', l.id);
  assert.deepEqual([row.sms_opt_out, row.sms_opt_in], [1, 0]);
  const reply = lastSms();
  assert.equal(reply.to_phone, from); assert.match(reply.body, /unsubscribed.*Reply START/); assert.equal(reply.kind, 'auto');
  assert.ok(get("SELECT 1 FROM sms_messages WHERE direction='in' AND from_phone=? AND body LIKE '%Stop%' AND lead_id=?", from, l.id), 'inbound recorded');
  r = await desk.post(`/crm/leads/${l.id}/text`, { body: 'Still there?' });
  assert.equal(r.status, 400); assert.match(r.data.error, /replied STOP/);
  assert.equal((await desk.post(`/crm/leads/${l.id}/consent`, { sms_opt_in: true, source: 'Asked again' })).status, 400, 'staff can’t override STOP');
  assert.throws(() => messaging.sendSms(from, 'Direct send'), /replied STOP/, 'the outbox itself refuses a stopped number');
  const tl = (await desk.get(`/crm/leads/${l.id}`)).data.timeline;
  assert.ok(tl.some((x) => x.kind === 'text_in') && tl.some((x) => x.kind === 'consent' && /STOP/.test(x.body)));
  // START turns texts back on; HELP gets the business line; anything else is just recorded
  r = await owner.post('/sms/inbound', { from, body: 'START' });
  assert.equal(r.data.action, 'start'); assert.equal(get('SELECT sms_opt_out FROM crm_leads WHERE id=?', l.id).sms_opt_out, 0);
  assert.equal((await desk.post(`/crm/leads/${l.id}/text`, { body: 'Welcome back.' })).status, 200);
  r = await owner.post('/sms/inbound', { from, body: 'help' });
  assert.equal(r.data.action, 'help'); assert.match(lastSms().body, /Reply STOP to unsubscribe/);
  r = await owner.post('/sms/inbound', { from, body: 'Thursday works for us' });
  assert.equal(r.data.action, null); assert.equal(lastSms().direction, 'in');
  // A parent's STOP works on the family side too
  const maria = get("SELECT * FROM parents WHERE email='maria.lopez@example.com'");
  await owner.post('/sms/inbound', { from: maria.phone, body: 'STOP' });
  assert.equal(get('SELECT sms_opt_out FROM parents WHERE id=?', maria.id).sms_opt_out, 1);
  const t = await desk.post(`/crm/families/${maria.family_id}/text`, { body: 'Hi Maria' });
  assert.equal(t.status, 400); assert.match(t.data.error, /replied STOP/);
  await owner.post('/sms/inbound', { from: maria.phone, body: 'START' });
  assert.equal((await desk.post(`/crm/families/${maria.family_id}/text`, { body: 'Hi Maria' })).status, 200);
});

test('group texts: only people with an OK to text, and never a STOP; preview shows who is left out and why', async () => {
  const yes = await lead({ interest: 'camp' }), no = await lead({ interest: 'camp' }), stopped = await lead({ interest: 'camp' });
  await desk.post(`/crm/leads/${yes.id}/consent`, { sms_opt_in: true, source: 'Asked on the phone' });
  await desk.post(`/crm/leads/${stopped.id}/consent`, { sms_opt_in: true, source: 'Asked on the phone' });
  await owner.post('/sms/inbound', { from: stopped.phone, body: 'STOP' });
  const seg = { audience: 'leads', interest: 'camp' };
  const p = (await owner.post('/crm/group/preview', { segment: seg, channel: 'text' })).data;
  assert.ok(p.recipients.some((r) => r.id === yes.id));
  assert.equal(p.excluded.find((r) => r.id === no.id).reason, 'no OK to text on file');
  assert.equal(p.excluded.find((r) => r.id === stopped.id).reason, 'replied STOP');
  const before = get("SELECT COUNT(*) n FROM sms_messages WHERE kind='group'").n;
  const r = await owner.post('/crm/group/send', { segment: seg, channel: 'text', body: 'Hi {first_name}, camp sign-ups open Monday.', expected_count: p.count });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.sent, p.count);
  assert.equal(get("SELECT COUNT(*) n FROM sms_messages WHERE kind='group'").n, before + p.count);
  assert.equal(get("SELECT body FROM sms_messages WHERE kind='group' AND lead_id=?", yes.id).body, `Hi Tex, camp sign-ups open Monday.`);
  assert.ok(!get("SELECT 1 FROM sms_messages WHERE kind='group' AND lead_id IN (?,?)", no.id, stopped.id));
  assert.equal((await owner.post('/crm/group/send', { segment: seg, channel: 'text', body: 'x'.repeat(1000), expected_count: p.count })).status, 400, 'too long for a text');
  assert.equal((await desk.post('/crm/group/preview', { segment: seg, channel: 'text' })).status, 403);
  // Parents with an OK to text, in the trials-ended group (Paulo agreed during the trial)
  const t = (await owner.post('/crm/group/preview', { segment: { audience: 'trials_ended' }, channel: 'text' })).data;
  assert.ok(t.recipients.some((x) => x.name === 'Paulo Silva'));
});

test('SMS outbox: owners only, filters, counts; message length', async () => {
  assert.equal((await desk.get('/sms/outbox')).status, 403);
  assert.equal((await coach.get('/sms/outbox')).status, 403);
  const all_ = (await owner.get('/sms/outbox')).data;
  assert.equal(all_.mode, 'test'); assert.equal(all_.provider, null);
  assert.ok(all_.items.length && all_.items[0].to_display !== undefined);
  assert.ok((await owner.get('/sms/outbox?direction=in')).data.items.every((m) => m.direction === 'in'));
  assert.ok((await owner.get('/sms/outbox?status=logged')).data.items.every((m) => m.status === 'logged'));
  assert.ok(all_.counts.logged >= 1 && all_.counts.received >= 1);
  assert.deepEqual(messaging.segments('Hi'), { chars: 2, encoding: 'gsm', segments: 1, per: 160 });
  assert.equal(messaging.segments('x'.repeat(160)).segments, 1);
  assert.equal(messaging.segments('x'.repeat(161)).segments, 2);
  assert.equal(messaging.segments('€'.repeat(80)).chars, 160, 'extension characters count twice');
  assert.equal(messaging.segments('Great session 💪').encoding, 'unicode');
  assert.equal(messaging.segments('x'.repeat(71) + '’').segments, 2);
});

test('provider adapter: Twilio sends through its API and inbound requests must carry its signature', async () => {
  const http = require('http');
  const got = [];
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push({ url: req.url, auth: req.headers.authorization, body: new URLSearchParams(b) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: 'SM123' })); }); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { DP_SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'tok_secret', TWILIO_FROM: '+18015550000', TWILIO_API_URL: `http://127.0.0.1:${fake.address().port}`, DP_APP_URL: base });
  try {
    assert.equal(messaging.mode(), 'live');
    const l = await lead();
    await desk.post(`/crm/leads/${l.id}/consent`, { sms_opt_in: true, source: 'Asked on the phone' });
    const r = await desk.post(`/crm/leads/${l.id}/text`, { body: 'Live text' });
    assert.equal(r.data.status, 'queued');
    for (let i = 0; i < 50 && get('SELECT status FROM sms_messages WHERE id=(SELECT MAX(id) FROM sms_messages)').status !== 'sent'; i++) await new Promise((x) => setTimeout(x, 20));
    const m = lastSms();
    assert.deepEqual([m.status, m.provider, m.provider_id, m.from_phone], ['sent', 'twilio', 'SM123', '+18015550000']);
    assert.match(got[0].url, /\/Accounts\/AC_test\/Messages\.json$/); assert.equal(got[0].body.get('To'), l.phone); assert.equal(got[0].body.get('Body'), 'Live text');
    assert.equal(got[0].auth, 'Basic ' + Buffer.from('AC_test:tok_secret').toString('base64'));
    // Inbound: unsigned or badly signed is refused, even for an owner; a real signature works (form-encoded, like Twilio)
    const params = { From: l.phone, To: '+18015550000', Body: 'STOP', MessageSid: 'SM999' };
    const sign = (p) => crypto.createHmac('sha1', 'tok_secret').update(base + '/api/sms/inbound' + Object.keys(p).sort().map((k) => k + p[k]).join('')).digest('base64');
    assert.equal((await owner.post('/sms/inbound', params, { 'content-type': 'application/x-www-form-urlencoded' })).status, 403);
    assert.equal((await client().post('/sms/inbound', params, { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bogus' })).status, 403);
    const ok = await client().post('/sms/inbound', params, { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign(params) });
    assert.equal(ok.status, 200); assert.match(ok.data, /<Response>/);
    assert.equal(get('SELECT sms_opt_out FROM crm_leads WHERE id=?', l.id).sms_opt_out, 1);
    assert.equal(get("SELECT provider_id FROM sms_messages WHERE direction='in' ORDER BY id DESC LIMIT 1").provider_id, 'SM999');
    // DP_SMS_ONLY_TO holds anything else on staging
    process.env.DP_SMS_ONLY_TO = '801-555-0001';
    assert.equal(messaging.mode(), 'restricted');
    assert.equal(messaging.sendSms('385-555-0102', 'Held').status, 'held');
  } finally {
    for (const k of ['DP_SMS_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_API_URL', 'DP_APP_URL', 'DP_SMS_ONLY_TO']) delete process.env[k];
    fake.close();
  }
  assert.equal(messaging.mode(), 'test');
});
