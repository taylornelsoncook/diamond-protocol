// Today: session states and arrivals, follow-ups that hide an item (and undo), check-in flags, birthdays,
// retry-charge safeguards, and an activity feed that is newest-first and money-free for coaches and front desk.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-today-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const { get, run, insert } = require('../server/db');
const { addDays } = require('../server/lib');
const booking = require('../server/services/booking');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), del: (p) => req('DELETE', p),
    login: (email, password) => req('POST', '/api/auth/staff/login', { email, password }) };
}
async function as(email, pw) { const c = client(); const r = await c.login(email, pw); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }
const owner = () => as('owner@demo.test', 'demo-owner-2026');
const coach = () => as('coach@demo.test', 'demo-coach-2026');
const desk = () => as('desk@demo.test', 'demo-desk-2026');
const hasMoney = (obj) => /price_cents|_cents"|\$\d/.test(JSON.stringify(obj));
const T = () => booking.todayLocal();

// A member who joined long ago and hasn't been seen since: shows as "gone quiet".
function quietMember(first) {
  const fam = insert('families', { name: `${first} family` });
  insert('parents', { family_id: fam, name: `${first} Parent`, email: `${first.toLowerCase()}.parent@example.com`, phone: '801-555-0199' });
  const id = insert('athletes', { code: `QT${first.toUpperCase()}`, family_id: fam, first_name: first, last_name: 'Quiet', created_at: '2025-01-01 12:00:00' });
  const plan = get('SELECT id FROM plans ORDER BY id LIMIT 1');
  insert('memberships', { athlete_id: id, plan_id: plan.id, status: 'active', started_at: '2025-01-01', next_charge: addDays(T(), 10) });
  return id;
}

test('Today: sessions carry a state, arrivals list who is booked, tomorrow and birthdays show; no money for staff', async () => {
  const o = (await (await owner()).get('/api/today')).data;
  assert.ok(o.sessions.length >= 1);
  for (const e of o.sessions) {
    assert.ok(['done', 'live', 'next', 'later', 'cancelled'].includes(e.state), e.state);
    assert.match(e.ends_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  }
  assert.ok(o.sessions.filter((e) => e.state === 'next').length <= 1, 'only one session is next');
  assert.ok(o.arrivals.length >= 4, 'the demo books six into today');
  const a = o.arrivals[0];
  for (const k of ['booking_id', 'event_id', 'athlete_id', 'name', 'checked_in_at', 'unpaid', 'alerts', 'waiver_missing', 'flags']) assert.ok(k in a, k);
  assert.ok(o.arrivals.some((r) => r.checked_in_at) && o.arrivals.some((r) => !r.checked_in_at));
  const firstHere = o.arrivals.findIndex((r) => r.checked_in_at);
  assert.ok(o.arrivals.slice(firstHere).every((r) => r.checked_in_at), 'still-to-arrive first, checked in last');
  assert.ok(o.arrivals.some((r) => r.alerts.some((x) => /Allergy/.test(x))), 'allergies show at the door');
  assert.equal(typeof o.tomorrow.count, 'number');
  assert.ok(o.birthdays.some((b) => b.today), 'the demo seeds a birthday today');
  assert.ok(o.metrics.every((m) => m.href), 'every number opens its screen');
  assert.equal(typeof o.revenue.total_cents, 'number');

  for (const who of [await coach(), await desk()]) {
    const c = (await who.get('/api/today')).data;
    assert.ok(c.arrivals.length >= 4);
    assert.ok(!hasMoney(c), 'no money on a coach or front desk Today');
    assert.ok(c.attention.some((x) => x.kind === 'unpaid_today'), 'unpaid bookings flagged for the door, without amounts');
  }
});

test('Today: front desk checks someone in from the arrivals list and can undo it', async () => {
  const d = await desk();
  const r0 = (await d.get('/api/today')).data.arrivals.find((r) => !r.checked_in_at);
  assert.equal((await d.post(`/api/bookings/${r0.booking_id}/checkin`)).status, 200);
  let r1 = (await d.get('/api/today')).data.arrivals.find((r) => r.booking_id === r0.booking_id);
  assert.ok(r1.checked_in_at);
  assert.equal((await d.del(`/api/bookings/${r0.booking_id}/checkin`)).status, 200);
  r1 = (await d.get('/api/today')).data.arrivals.find((r) => r.booking_id === r0.booking_id);
  assert.equal(r1.checked_in_at, null);
});

test('Today: "Reached out" hides a quiet client for everyone, logs who did it, and can be undone', async () => {
  const id = quietMember('Quinn');
  const c = await coach();
  const item = (await c.get('/api/today')).data.attention.find((x) => x.kind === 'quiet' && x.athlete_id === id);
  assert.ok(item, 'quiet member listed');
  assert.equal(item.key, `quiet:${id}`);
  assert.equal(item.phone, '801-555-0199', 'family phone for a quick call');
  assert.equal(item.snooze.label, 'Reached out');

  const d = await desk();
  const r = await d.post('/api/today/snooze', { key: item.key, note: 'Texted mom' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.until, addDays(T(), 6), 'hidden for a week by default');
  assert.match(r.data.message, /Reached out: Quinn Quiet/);
  const after = (await c.get('/api/today')).data;
  assert.ok(!after.attention.some((x) => x.key === item.key), 'gone from the coach Today too');
  const hid = after.snoozed.find((s) => s.key === item.key);
  assert.ok(hid && hid.by === 'Riley Tran' && hid.note === 'Texted mom' && hid.label === 'Reached out');
  assert.ok(get("SELECT 1 FROM activity WHERE action='Reached out to client' AND detail='Quinn Quiet: Texted mom'"));

  // again with a custom length replaces the first one
  const r2 = await d.post('/api/today/snooze', { key: item.key, days: 14 });
  assert.equal(r2.data.until, addDays(T(), 13));
  assert.equal(get('SELECT COUNT(*) n FROM today_snoozes WHERE key=?', item.key).n, 1);

  assert.equal((await d.del(`/api/today/snooze/${r2.data.id}`)).status, 200);
  assert.ok((await c.get('/api/today')).data.attention.some((x) => x.key === item.key), 'back after undo');
  assert.ok(get("SELECT 1 FROM activity WHERE action='Brought back to Today' AND detail='Quinn Quiet'"));
  assert.equal((await d.del(`/api/today/snooze/${r2.data.id}`)).status, 404);

  // expired follow-ups stop hiding the item
  run("INSERT INTO today_snoozes (key, athlete_id, until) VALUES (?, ?, ?)", item.key, id, addDays(T(), -1));
  assert.ok((await c.get('/api/today')).data.attention.some((x) => x.key === item.key));
});

test('Today: follow-ups are validated and need a staff sign-in', async () => {
  const id = quietMember('Vale');
  const d = await desk();
  for (const body of [{}, { key: 'nope' }, { key: `invoice:${id}` }, { key: `flag:${id}` }, { key: `quiet:${id}:2026-01-01` }]) {
    const r = await d.post('/api/today/snooze', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  for (const days of [0, 61, 1.5, 'x']) assert.equal((await d.post('/api/today/snooze', { key: `quiet:${id}`, days })).status, 400, `days ${days}`);
  assert.equal((await d.post('/api/today/snooze', { key: 'quiet:999999' })).status, 404);
  assert.equal((await client().post('/api/today/snooze', { key: `quiet:${id}` })).status, 401);
  assert.equal((await client().del('/api/today/snooze/1')).status, 401);
  const long = await d.post('/api/today/snooze', { key: `quiet:${id}`, note: 'x'.repeat(500) });
  assert.equal(long.status, 200);
  assert.equal(get('SELECT length(note) n FROM today_snoozes WHERE id=?', long.data.id).n, 300, 'notes are capped');
});

test('Today: trials ending can be followed up until the trial ends; check-in flags can be marked reviewed', async () => {
  const id = quietMember('Tess');
  const end = addDays(T(), 2);
  run("UPDATE memberships SET status='trial', next_charge=? WHERE athlete_id=?", end, id);
  const c = await coach();
  let t = (await c.get('/api/today')).data;
  const trial = t.attention.find((x) => x.kind === 'trial_ending' && x.athlete_id === id);
  assert.ok(trial && trial.key === `trial:${id}`);
  const r = await c.post('/api/today/snooze', { key: trial.key });
  assert.equal(r.status, 200);
  assert.equal(r.data.until, end, 'hidden until the trial ends');
  t = (await c.get('/api/today')).data;
  assert.ok(!t.attention.some((x) => x.key === trial.key));

  insert('checkins', { athlete_id: id, date: T(), sleep_hours: 4, soreness: 5, energy: 3, mood: 3, hydration: 3 });
  const flag = t.flags.find((f) => f.athlete_id === id) || (await c.get('/api/today')).data.flags.find((f) => f.athlete_id === id);
  assert.ok(flag, 'red-flag check-in listed on Today');
  assert.equal(flag.key, `flag:${id}:${T()}`);
  assert.equal(flag.today, true);
  const f = await (await desk()).post('/api/today/snooze', { key: flag.key });
  assert.equal(f.status, 200);
  assert.ok(!(await c.get('/api/today')).data.flags.some((x) => x.athlete_id === id));
  assert.ok(get("SELECT 1 FROM activity WHERE action='Reviewed check-in' AND detail='Tess Quiet'"));
});

test('Today: retry asks to confirm with the card, and a family without a card is sent to add one', async () => {
  const id = quietMember('Nora');
  const fam = get('SELECT family_id FROM athletes WHERE id=?', id).family_id;
  const inv = insert('invoices', { number: 'DP-TODAY-T1', kind: 'charge', family_id: fam, athlete_id: id, description: 'Test charge', amount_cents: 4200, status: 'failed', attempts: 1, next_retry: '2099-01-01' });
  const o = await owner();
  let item = (await o.get('/api/today')).data.attention.find((x) => x.kind === 'failed_payment' && x.title === 'Nora Quiet');
  assert.equal(item.action.label, 'Add a card');
  assert.match(item.detail, /No card on file/);
  const noCard = await o.post(`/api/today/retry/${inv}`);
  assert.equal(noCard.status, 400);
  assert.match(noCard.data.error, /no card on file/i);
  assert.equal(get('SELECT attempts FROM invoices WHERE id=?', inv).attempts, 1, 'nothing was tried');

  run("UPDATE families SET card_brand='Visa', card_last4='0002' WHERE id=?", fam);
  run('UPDATE invoices SET attempts=3 WHERE id=?', inv);
  item = (await o.get('/api/today')).data.attention.find((x) => x.kind === 'failed_payment' && x.title === 'Nora Quiet');
  assert.equal(item.action.post, `/today/retry/${inv}`);
  assert.match(item.action.confirm.text, /\$42 to Visa ending 0002/);
  const r = await o.post(`/api/today/retry/${inv}`);
  assert.equal(r.data.ok, false);
  assert.match(r.data.message, /no more automatic retries/i, 'the last attempt says so');
  assert.equal((await (await desk()).post(`/api/today/retry/${inv}`)).status, 403);
});

test('Activity feed: newest first by time, sign-ins can be left out, and no dollar amounts for coaches or front desk', async () => {
  insert('activity', { actor: 'Old import', action: 'Imported history', kind: 'change', created_at: '2020-01-01 00:00:00' });
  insert('activity', { actor: 'Maria Lopez (parent)', action: 'Bought pack', detail: 'Ava Lopez: 10-session group pack ($250)', kind: 'change' });
  insert('activity', { actor: 'Maria Lopez (parent)', action: 'Registered for camp', detail: 'Ava Lopez: Summer camp ($450, 5 days)', kind: 'change' });
  insert('activity', { actor: 'Jordan Avery (owner)', action: 'Added product', detail: 'Hat · $25', kind: 'change' });
  const o = await owner();
  const all = (await o.get('/api/activity?limit=500')).data;
  const times = all.map((a) => a.created_at);
  assert.deepEqual(times, [...times].sort().reverse(), 'sorted by created_at, newest first');
  assert.equal(all[all.length - 1].action, 'Imported history');
  assert.ok(all.some((a) => /\$250/.test(a.detail || '')), 'owners see amounts');
  assert.ok((await o.get('/api/activity?limit=500&kind=change')).data.every((a) => a.kind === 'change'));

  for (const who of [await coach(), await desk()]) {
    const feed = (await who.get('/api/activity?limit=500')).data;
    assert.deepEqual(feed.filter((a) => /\$\d/.test(`${a.action} ${a.detail || ''}`)), []);
    assert.equal(feed.find((a) => a.action === 'Bought pack').detail, 'Ava Lopez: 10-session group pack');
    assert.equal(feed.find((a) => a.action === 'Registered for camp').detail, 'Ava Lopez: Summer camp (5 days)');
    assert.ok(!feed.some((a) => a.action === 'Added product'));
  }
});
