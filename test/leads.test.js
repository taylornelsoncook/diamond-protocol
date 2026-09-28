import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { runFollowUps } from '../src/services/leads.js';
import { handleInbound } from '../src/services/sms.js';
import { newId } from '../src/util.js';

// Families who ask about training: the public form, automatic follow-up, and leads moving forward on their own.
let app, base, owner, coach, frontDesk, facility;
const DAY = 86400000;
const later = (days) => new Date(Date.now() + days * DAY + 60000).toISOString();

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const ask = async (body) => {
  const r = await fetch(base + '/portal/api/public/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const mailTo = (email) => app.ctx.db.all('SELECT subject, body FROM outbox WHERE to_email = ? ORDER BY rowid', email);
const lead = (email) => app.ctx.db.get('SELECT * FROM leads WHERE email = ?', email);

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); frontDesk = await signIn('desk@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

test('the public form creates a lead, thanks the parent, tells the owner, and texts only if they asked', async () => {
  const page = await fetch(base + '/start');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/js\/start\.js/);
  const r = await ask({ parent_name: 'Kim Reyes', email: 'kim@example.com', phone: '512 555 0177', athlete_name: 'Leo Reyes', athlete_age: '12', sport: 'Baseball', message: 'Wants to throw harder', texts_ok: true });
  assert.equal(r.status, 200);
  assert.match(r.body.message, /Thanks/);
  const l = lead('kim@example.com');
  assert.equal(l.source, 'inquiry');
  assert.equal(l.status, 'contacted', 'the thank-you went out, so the lead is contacted');
  assert.equal(l.follow_up_step, 1);
  assert.equal(Date.parse(l.next_follow_up_at), Date.parse(l.created_at) + 2 * DAY);
  const thanks = mailTo('kim@example.com');
  assert.equal(thanks.length, 1);
  assert.equal(thanks[0].subject, 'Thanks for reaching out to Diamond Protocol');
  assert.match(thanks[0].body, /training for Leo\. The next step is a free evaluation\. Create your family account at https:\/\/app\.example\.org\/join/);
  assert.match(mailTo('owner@test.dev').at(-1).subject, /^New inquiry: Kim Reyes for Leo Reyes$/);
  const text = app.ctx.db.get(`SELECT * FROM texts WHERE kind = 'lead' AND phone = '+15125550177'`);
  assert.match(text.body, /^Diamond Protocol: Thanks for reaching out about training for Leo!/);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'lead.created'`).n, 1);

  await ask({ parent_name: 'Sam Ortiz', email: 'sam@example.com', phone: '512 555 0188' });
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM texts WHERE phone = '+15125550188'`).n, 0, 'no text without the box ticked');
});

test('asking twice keeps one lead, bots are ignored, and mistakes say what to fix', async () => {
  await ask({ parent_name: 'Kim Reyes', email: 'KIM@example.com', message: 'Also my daughter' });
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM leads WHERE email = 'kim@example.com'`).n, 1);
  assert.match(lead('kim@example.com').message, /Wants to throw harder\n\nAlso my daughter/);
  assert.equal(mailTo('kim@example.com').length, 1, 'no second thank-you');
  const bot = await ask({ parent_name: 'Bot', email: 'bot@example.com', website: 'http://spam' });
  assert.equal(bot.status, 200);
  assert.equal(lead('bot@example.com'), undefined);
  const bad = await ask({ parent_name: 'No Email' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /email/i);
  assert.match((await ask({ parent_name: 'X', email: 'x@example.com', phone: '555' })).body.error.message, /area code/);
});

test('follow-ups go out after 2 and 7 days, then stop; stopping by hand works', async () => {
  const sam = lead('sam@example.com');
  const stopped = await owner('PATCH', `/v1/leads/${sam.id}`, { follow_up: false, notes: 'Called, coming Saturday' });
  assert.equal(stopped.body.next_follow_up_at, null);
  assert.equal(stopped.body.notes, 'Called, coming Saturday');
  
  assert.equal(await runFollowUps(app.ctx, { asOf: later(1) }), 0, 'nothing due on day 1');
  await runFollowUps(app.ctx, { asOf: later(2) });
  assert.equal(mailTo('kim@example.com').at(-1).subject, 'Still thinking about training for Leo?');
  assert.equal(lead('kim@example.com').follow_up_step, 2);
  await runFollowUps(app.ctx, { asOf: later(7) });
  assert.equal(mailTo('kim@example.com').at(-1).subject, 'One last note from Diamond Protocol');
  assert.equal(lead('kim@example.com').next_follow_up_at, null);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM texts WHERE kind = 'lead' AND phone = '+15125550177'`).n, 2, 'the last note is email only');
  assert.equal(await runFollowUps(app.ctx, { asOf: later(30) }), 0);
  assert.equal(mailTo('kim@example.com').length, 3);
  assert.equal(mailTo('sam@example.com').length, 1, 'no follow-up after a coach stopped it');

  await owner('PATCH', '/v1/settings', { lead_follow_up: 'off' });
  await ask({ parent_name: 'Quiet Parent', email: 'quiet@example.com' });
  assert.equal(mailTo('quiet@example.com').length, 0, 'with follow-up off, no emails go out');
  await owner('PATCH', '/v1/settings', { lead_follow_up: 'on' });
});

test('a lead moves to signed up, evaluation and member on its own, and follow-up stops', async () => {
  await ask({ parent_name: 'Jo Hart', email: 'jo@example.com', athlete_name: 'Mia Hart' });
  const started = await (await fetch(base + '/portal/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parent: { name: 'Jo Hart', email: 'jo@example.com' }, athletes: [{ name: 'Mia Hart', birth_date: '2013-04-02' }], accept_terms: true }) })).json();
  const done = await fetch(base + '/portal/api/signup/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signup_id: started.signup_id, code: started.dev_code }) });
  assert.equal(done.status, 200);
  await runFollowUps(app.ctx, { asOf: later(2) });
  let l = lead('jo@example.com');
  assert.equal(l.status, 'signed_up');
  assert.equal(l.next_follow_up_at, null);
  assert.ok(l.family_id && l.converted_at);
  assert.ok(!mailTo('jo@example.com').some((m) => /Still thinking/.test(m.subject)), 'no nudge after they signed up');

  const mia = app.ctx.db.get(`SELECT id FROM clients WHERE family_id = ?`, l.family_id);
  const at = later(3), id = newId('cls');
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Evaluation', 'evaluation', ?, ?, ?, 1, 'scheduled', ?)`, id, facility.id, at, at, at);
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'none', ?, ?)`, newId('bkg'), id, mia.id, at, at);
  await runFollowUps(app.ctx);
  assert.equal(lead('jo@example.com').status, 'evaluation');

  const plan = (await owner('POST', '/v1/plans', { name: 'Membership', price_cents: 15000, trial_days: 0 })).body;
  await owner('POST', `/v1/clients/${mia.id}/subscription`, { plan_id: plan.id });
  await runFollowUps(app.ctx);
  assert.equal(lead('jo@example.com').status, 'member');
  const list = (await owner('GET', '/v1/leads')).body;
  assert.equal(list.counts.member, 1);
  assert.ok(list.last_30_days.signed_up >= 1);
});

test('a sign-up started but not finished becomes a lead after an hour', async () => {
  const r = await (await fetch(base + '/portal/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parent: { name: 'Pat Lee', email: 'pat@example.com', phone: '5125550166' }, athletes: [{ name: 'Rio Lee', birth_date: '2012-01-01', sport: 'Soccer' }], accept_terms: true }) })).json();
  assert.ok(r.signup_id);
  await runFollowUps(app.ctx, { asOf: new Date(Date.now() + 30 * 60000).toISOString() });
  assert.equal(lead('pat@example.com'), undefined, 'not after 30 minutes');
  await runFollowUps(app.ctx, { asOf: new Date(Date.now() + 2 * 3600000).toISOString() });
  const l = lead('pat@example.com');
  assert.equal(l.source, 'signup_unfinished');
  assert.equal(l.athlete_name, 'Rio Lee');
  assert.equal(l.sport, 'Soccer');
  assert.equal(mailTo('pat@example.com').at(-1).subject, 'Finish signing up with Diamond Protocol');
  assert.equal(l.texts_ok, 0, 'no texts: they never agreed to them');
});

test('replying STOP to a follow-up text stops texts to that lead', async () => {
  await ask({ parent_name: 'Lou Fox', email: 'lou@example.com', phone: '(512) 555-0155', texts_ok: true });
  assert.equal(lead('lou@example.com').texts_ok, 1);
  await handleInbound(app.ctx, { From: '+15125550155', Body: 'Stop' });
  assert.equal(lead('lou@example.com').texts_ok, 0);
  await runFollowUps(app.ctx, { asOf: later(2) });
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM texts WHERE direction = 'out' AND phone = '+15125550155'`).n, 1, 'only the thank-you, sent before STOP');
});

test('front desk can add and update leads; only the owner can delete; phone leads can skip automatic emails', async () => {
  const added = await frontDesk('POST', '/v1/leads', { parent_name: 'Walk In', phone: '512-555-0144', source: 'walk_in', athlete_name: 'Ty In', follow_up: false });
  assert.equal(added.status, 201);
  assert.equal(added.body.source, 'walk_in');
  assert.equal(added.body.next_follow_up_at, null);
  assert.equal((await frontDesk('POST', '/v1/leads', { parent_name: 'Nobody' })).body.error.message, 'Add an email or a phone number so you can follow up.');
  assert.equal((await owner('POST', '/v1/leads', { parent_name: 'Kim R', email: 'lou@example.com' })).status, 409);
  const upd = await frontDesk('PATCH', `/v1/leads/${added.body.id}`, { contacted: true });
  assert.equal(upd.body.status, 'contacted');
  assert.equal((await coach('GET', '/v1/leads')).status, 200);
  assert.equal((await coach('DELETE', `/v1/leads/${added.body.id}`)).status, 403);
  assert.equal((await frontDesk('DELETE', `/v1/leads/${added.body.id}`)).status, 403);
  assert.equal((await owner('DELETE', `/v1/leads/${added.body.id}`)).status, 200);
  // A lost lead needs a reason. A reason in an integration's own words (from before the CRM) is kept as the note, under "other".
  assert.match((await owner('PATCH', `/v1/leads/${lead('quiet@example.com').id}`, { status: 'lost' })).body.error.message, /Pick why they didn't join/);
  const lost = await owner('PATCH', `/v1/leads/${lead('quiet@example.com').id}`, { status: 'lost', lost_reason: 'Went with a travel team' });
  assert.equal(lost.body.status, 'lost');
  assert.deepEqual([lost.body.lost_reason, lost.body.lost_note, lost.body.lost_reason_label], ['other', 'Went with a travel team', 'Other']);
});

test('the dashboard flags new inquiries, and deleting a family removes their inquiry', async () => {
  const dash = JSON.stringify((await owner('GET', '/v1/dashboard')).body);
  assert.match(dash, /"kind":"new_leads","count":\d+/, 'new inquiries show on Today');
  const jo = lead('jo@example.com');
  const fam = app.ctx.db.get('SELECT name FROM families WHERE id = ?', jo.family_id);
  const exp = await owner('GET', `/v1/families/${jo.family_id}/export`);
  assert.equal(exp.body.inquiries.length, 1, 'a parent\'s data export includes what they sent us');
  assert.equal((await owner('DELETE', `/v1/families/${jo.family_id}`, { confirm: fam.name })).status, 200);
  assert.equal(lead('jo@example.com'), undefined);
});

test('the weekly summary counts inquiries and asks the owner to reach out to ones nobody has contacted', async () => {
  const { buildDigest, digestText } = await import('../src/services/insights.js');
  await frontDesk('POST', '/v1/leads', { parent_name: 'Phone Call', phone: '512-555-0133', source: 'phone', follow_up: false });
  const d = buildDigest(app.ctx, later(2));
  assert.ok(d.inquiries >= 1);
  assert.match(d.actions.join(' '), /Reach out to a family who asked about training \(Leads\)\./);
  assert.match(digestText(app.ctx, buildDigest(app.ctx)), /New inquiries: \d+ \(\d+ signed up so far\)\./);
});
