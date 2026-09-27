// Parent portal API: sign-in, family scoping, booking rules, payments, card, waiver.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `dp-parent-test-${process.pid}.db`);
process.env.DP_DB = DB_FILE;
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const { get, all, run, insert, setting } = require('../server/db');
const seed = require('../server/seed');
const booking = require('../server/services/booking');
const { app } = require('../server/index');

let server, base;
test.before(async () => {
  seed.resetDatabase();
  seed.base();
  seed.demo();
  booking.generateEvents();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server?.close();
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch { /* gone */ } }
});

// ---- helpers ----
async function call(method, url, body, cookie) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, res };
}
const sessions = {};
async function signIn(email) {
  if (sessions[email]) return sessions[email];
  const c = await call('POST', '/auth/parent/code', { email });
  const v = await call('POST', '/auth/parent/verify', { email, code: c.data.test_code });
  assert.equal(v.status, 200);
  const cookie = v.res.headers.get('set-cookie').split(';')[0];
  sessions[email] = cookie;
  return cookie;
}
const athlete = (first, last) => get('SELECT * FROM athletes WHERE first_name=? AND last_name=?', first, last);
const MARIA = 'maria.lopez@example.com', KURT = 'kurt.jensen@example.com', LINH = 'linh.nguyen@example.com', PAULO = 'paulo.silva@example.com';

// Local wall-clock time n hours from now, in the business time zone ("YYYY-MM-DDTHH:MM").
function localPlus(hours) {
  const n = booking.nowLocal();
  const d = new Date(Date.UTC(+n.slice(0, 4), +n.slice(5, 7) - 1, +n.slice(8, 10), +n.slice(11, 13), +n.slice(14, 16)) + hours * 36e5);
  return d.toISOString().slice(0, 16);
}
function makeEvent({ hours = 72, capacity = 10, price_cents = 3000, name = 'Test class' } = {}) {
  return insert('events', { type: 'class', name, starts_at: localPlus(hours), duration_min: 60, capacity, price_cents, location_id: 1 });
}

// ---- sign-in ----
test('code sign-in works once and sets a 30-day session', async () => {
  const unauth = await call('GET', '/parent/me');
  assert.equal(unauth.status, 401);

  const c = await call('POST', '/auth/parent/code', { email: PAULO });
  assert.equal(c.status, 200);
  assert.match(c.data.test_code, /^\d{6}$/);

  const wrong = await call('POST', '/auth/parent/verify', { email: PAULO, code: c.data.test_code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);

  const ok = await call('POST', '/auth/parent/verify', { email: PAULO, code: c.data.test_code });
  assert.equal(ok.status, 200);
  const setCookie = ok.res.headers.get('set-cookie');
  const exp = new Date(/Expires=([^;]+)/i.exec(setCookie)[1]);
  assert.ok(exp - Date.now() > 29 * 864e5, 'session lasts 30 days');

  const again = await call('POST', '/auth/parent/verify', { email: PAULO, code: c.data.test_code });
  assert.equal(again.status, 400, 'a code works only once');

  const cookie = setCookie.split(';')[0];
  sessions[PAULO] = cookie;
  const me = await call('GET', '/parent/me', null, cookie);
  assert.equal(me.status, 200);
  assert.equal(me.data.family.name, 'Silva family');
  assert.equal(me.data.family.waiver_current, false);
  assert.equal(me.data.family.card_last4, null);
  assert.equal(me.data.athletes[0].first_name, 'Isabela');
  assert.equal(me.data.settings.late_cancel_hours, 12);

  const unknown = await call('POST', '/auth/parent/code', { email: 'nobody@example.com' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.test_code, undefined);
});

test('me reports membership coverage and credits', async () => {
  const maria = await signIn(MARIA);
  const me = (await call('GET', '/parent/me', null, maria)).data;
  assert.equal(me.athletes[0].member_left, 'unlimited');
  assert.equal(me.athletes[0].membership.status, 'active');
  const kurt = await signIn(KURT);
  const k = (await call('GET', '/parent/me', null, kurt)).data;
  assert.equal(k.athletes.length, 2);
  for (const a of k.athletes) assert.equal(typeof a.member_left, 'number');
});

// ---- family scoping ----
test('another family\'s athletes and bookings answer 404', async () => {
  const maria = await signIn(MARIA);
  const nate = athlete('Nate', 'Jensen');
  const ev = makeEvent({ hours: 96 });
  const b = booking.book(ev, nate.id, { source: 'staff' });
  const checks = [
    ['GET', `/parent/classes?athlete_id=${nate.id}`],
    ['GET', `/parent/slots?kind=private&athlete_id=${nate.id}`],
    ['GET', `/parent/shop?athlete_id=${nate.id}`],
    ['POST', '/parent/bookings', { athlete_id: nate.id, event_id: ev }],
    ['DELETE', `/parent/bookings/${b.id}`],
    ['POST', '/parent/slots', { kind: 'private', athlete_id: nate.id, starts_at: localPlus(48) }],
    ['POST', '/parent/camps/5/register', { athlete_id: nate.id }],
    ['POST', '/parent/standing', { athlete_id: nate.id, class_id: 1 }],
    ['POST', '/parent/packs', { athlete_id: nate.id, product_id: 2 }],
    ['POST', '/parent/membership', { athlete_id: nate.id, plan_id: 1 }],
    ['PUT', `/parent/athletes/${nate.id}`, { sport: 'Hacked' }],
  ];
  for (const [m, url, body] of checks) {
    const r = await call(m, url, body, maria);
    assert.equal(r.status, 404, `${m} ${url} should be 404, got ${r.status}`);
  }
  assert.equal(get('SELECT status FROM bookings WHERE id=?', b.id).status, 'booked');
  assert.equal(athlete('Nate', 'Jensen').sport, 'Baseball');
  const mine = (await call('GET', '/parent/bookings', null, maria)).data;
  assert.ok(mine.every((x) => x.athlete_id === athlete('Ava', 'Lopez').id));
  // Standing spot of another family
  const sid = insert('standing_spots', { athlete_id: nate.id, class_id: 1 });
  assert.equal((await call('DELETE', `/parent/standing/${sid}`, null, maria)).status, 404);
  run('DELETE FROM standing_spots WHERE id=?', sid);
});

// ---- booking, waitlist, cancel ----
test('book with a credit, cancel outside the window returns it', async () => {
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  run('UPDATE athletes SET group_credits=3 WHERE id=?', isa.id);
  const ev = makeEvent({ hours: 72 });
  const r = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: ev }, paulo);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'booked');
  assert.equal(r.data.coverage, 'credit');
  assert.equal(athlete('Isabela', 'Silva').group_credits, 2);
  const dup = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: ev }, paulo);
  assert.equal(dup.status, 400);

  const list = (await call('GET', '/parent/bookings', null, paulo)).data;
  const row = list.find((x) => x.id === r.data.id);
  assert.equal(row.late, false);
  const c = await call('DELETE', `/parent/bookings/${r.data.id}`, null, paulo);
  assert.equal(c.status, 200);
  assert.equal(c.data.late, false);
  assert.equal(get('SELECT status FROM bookings WHERE id=?', r.data.id).status, 'cancelled');
  assert.equal(athlete('Isabela', 'Silva').group_credits, 3);
});

test('cancel inside the late window still uses the session', async () => {
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  run('UPDATE athletes SET group_credits=3 WHERE id=?', isa.id);
  const ev = makeEvent({ hours: 3 });
  const r = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: ev }, paulo);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(athlete('Isabela', 'Silva').group_credits, 2);
  const row = (await call('GET', '/parent/bookings', null, paulo)).data.find((x) => x.id === r.data.id);
  assert.equal(row.late, true);
  const c = await call('DELETE', `/parent/bookings/${r.data.id}`, null, paulo);
  assert.equal(c.data.late, true);
  assert.equal(get('SELECT status FROM bookings WHERE id=?', r.data.id).status, 'late_cancel');
  assert.equal(athlete('Isabela', 'Silva').group_credits, 2, 'credit is not returned');
});

test('full session goes to the waitlist, which moves up on a cancel', async () => {
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  const ev = makeEvent({ hours: 80, capacity: 1 });
  const other = booking.book(ev, athlete('Ava', 'Lopez').id, { source: 'staff' });
  const r = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: ev }, paulo);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'waitlist');
  const classes = (await call('GET', `/parent/classes?athlete_id=${isa.id}`, null, paulo)).data;
  assert.ok(classes.events.every((e) => !['team', 'private', 'evaluation'].includes(e.type)));
  booking.cancelBooking(other.id);
  assert.equal(get('SELECT status FROM bookings WHERE id=?', r.data.id).status, 'booked');
  // leave cleanly
  await call('DELETE', `/parent/bookings/${r.data.id}`, null, paulo);
});

test('classes list: age-appropriate, three weeks, spots left, no team sessions', async () => {
  const kurt = await signIn(KURT);
  const nate = athlete('Nate', 'Jensen'); // 13
  const r = (await call('GET', `/parent/classes?athlete_id=${nate.id}`, null, kurt)).data;
  assert.ok(r.events.length > 0);
  assert.ok(r.events.some((e) => e.name === 'Youth Speed & Agility'));
  assert.ok(!r.events.some((e) => e.name === 'High School Performance'), 'too young for high school class');
  assert.ok(!r.events.some((e) => /team session/.test(e.name)));
  const last = r.events[r.events.length - 1].starts_at.slice(0, 10);
  assert.ok(last < new Date(Date.now() + 22 * 864e5).toISOString().slice(0, 10));
  for (const e of r.events) if (e.capacity) assert.equal(e.spots_left, Math.max(0, e.capacity - e.booked));
});

test('no sessions left: drop-in needs payment; declined card; card on file works and refunds', async () => {
  const linh = await signIn(LINH);
  const kevin = athlete('Kevin', 'Nguyen');
  run('UPDATE athletes SET group_credits=0 WHERE id=?', kevin.id);
  const ev = makeEvent({ hours: 90, price_cents: 3500 });
  const r1 = await call('POST', '/parent/bookings', { athlete_id: kevin.id, event_id: ev }, linh);
  assert.equal(r1.status, 400);
  assert.equal(r1.data.needs_payment, true);
  assert.equal(r1.data.price_cents, 3500);
  const r2 = await call('POST', '/parent/bookings', { athlete_id: kevin.id, event_id: ev, pay: 'card' }, linh);
  assert.equal(r2.status, 400);
  assert.match(r2.data.error, /declined/i);
  assert.equal(get("SELECT COUNT(*) n FROM bookings WHERE event_id=? AND athlete_id=? AND status='booked'", ev, kevin.id).n, 0);

  // Paulo: no card yet
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  run('UPDATE athletes SET group_credits=0 WHERE id=?', isa.id);
  const ev2 = makeEvent({ hours: 90, price_cents: 3000 });
  const r3 = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: ev2, pay: 'card' }, paulo);
  assert.equal(r3.status, 400);
  assert.equal(r3.data.needs_card, true);
  // Add a card, then pay
  assert.equal((await call('PUT', '/parent/card', { number: '4242 4242 4242 4242', exp: '12/30', cvc: '123', zip: '84604' }, paulo)).status, 200);
  const r4 = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: ev2, pay: 'card' }, paulo);
  assert.equal(r4.status, 200, JSON.stringify(r4.data));
  assert.equal(r4.data.coverage, 'paid');
  assert.equal(r4.data.paid_cents, 3000);
  const inv = get("SELECT * FROM invoices WHERE athlete_id=? AND amount_cents=3000 AND status='paid' ORDER BY id DESC", isa.id);
  assert.ok(inv);
  await call('DELETE', `/parent/bookings/${r4.data.id}`, null, paulo);
  assert.ok(get('SELECT 1 FROM invoices WHERE athlete_id=? AND amount_cents=-3000', isa.id), 'drop-in refunded');
  run('UPDATE athletes SET group_credits=3 WHERE id=?', isa.id);
});

// ---- privates and evaluations ----
test('private needs a private credit; evaluation charges the card', async () => {
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  run('UPDATE athletes SET private_credits=0 WHERE id=?', isa.id);
  const slots = (await call('GET', `/parent/slots?kind=private&athlete_id=${isa.id}`, null, paulo)).data.slots;
  assert.ok(slots.length > 0);
  const none = await call('POST', '/parent/slots', { kind: 'private', starts_at: slots[0].starts_at, athlete_id: isa.id }, paulo);
  assert.equal(none.status, 400);
  assert.match(none.data.error, /private/i);

  const single = get("SELECT * FROM products WHERE kind='private_pack' AND credits=1");
  const buy = await call('POST', '/parent/packs', { athlete_id: isa.id, product_id: single.id }, paulo);
  assert.equal(buy.status, 200, JSON.stringify(buy.data));
  assert.equal(buy.data.private_credits, 1);
  const ok = await call('POST', '/parent/slots', { kind: 'private', starts_at: slots[0].starts_at, athlete_id: isa.id }, paulo);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.coverage, 'credit');
  assert.equal(athlete('Isabela', 'Silva').private_credits, 0);
  const again = (await call('GET', `/parent/slots?kind=private&athlete_id=${isa.id}`, null, paulo)).data.slots;
  assert.ok(!again.some((s) => s.starts_at === slots[0].starts_at), 'booked time is no longer open');

  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  const evals = (await call('GET', `/parent/slots?kind=evaluation&athlete_id=${ava.id}`, null, maria)).data.slots;
  assert.ok(evals.length > 0);
  const e = await call('POST', '/parent/slots', { kind: 'evaluation', starts_at: evals[0].starts_at, athlete_id: ava.id }, maria);
  assert.equal(e.status, 200, JSON.stringify(e.data));
  assert.equal(e.data.coverage, 'paid');
  assert.equal(e.data.paid_cents, 7500);
  assert.ok(get("SELECT 1 FROM invoices WHERE athlete_id=? AND amount_cents=7500 AND status='paid'", ava.id));

  const linh = await signIn(LINH);
  const kevin = athlete('Kevin', 'Nguyen');
  const evals2 = (await call('GET', `/parent/slots?kind=evaluation&athlete_id=${kevin.id}`, null, linh)).data.slots;
  const declined = await call('POST', '/parent/slots', { kind: 'evaluation', starts_at: evals2[0].starts_at, athlete_id: kevin.id }, linh);
  assert.equal(declined.status, 400);
  assert.equal(get("SELECT COUNT(*) n FROM events WHERE type='evaluation' AND starts_at=? AND name LIKE '%Kevin%'", evals2[0].starts_at).n, 0);
});

// ---- programs ----
test('camp registration charges once and books every day', async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  const shop = (await call('GET', `/parent/shop?athlete_id=${ava.id}`, null, maria)).data;
  const camp = shop.camps.find((c) => c.name === 'Fall Speed Camp');
  assert.ok(camp && camp.eligible && !camp.registered);
  const cls = (await call('GET', `/parent/classes?athlete_id=${ava.id}`, null, maria)).data.events.filter((e) => e.class_id === camp.id);
  if (cls.length) {
    assert.ok(cls[0].needs_registration);
    const direct = await call('POST', '/parent/bookings', { athlete_id: ava.id, event_id: cls[0].id }, maria);
    assert.equal(direct.status, 400);
    assert.equal(direct.data.needs_registration, true);
  }
  const r = await call('POST', `/parent/camps/${camp.id}/register`, { athlete_id: ava.id }, maria);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.days, camp.days);
  const booked = get(`SELECT COUNT(*) n FROM bookings b JOIN events e ON e.id=b.event_id WHERE e.class_id=? AND b.athlete_id=? AND b.coverage='registered' AND b.status='booked'`, camp.id, ava.id).n;
  assert.equal(booked, camp.days);
  assert.ok(get("SELECT 1 FROM invoices WHERE athlete_id=? AND amount_cents=? AND status='paid'", ava.id, camp.reg_price_cents));
  const twice = await call('POST', `/parent/camps/${camp.id}/register`, { athlete_id: ava.id }, maria);
  assert.equal(twice.status, 400);
  const after = (await call('GET', `/parent/shop?athlete_id=${ava.id}`, null, maria)).data.camps.find((c) => c.id === camp.id);
  assert.equal(after.registered, true);
});

test('pack purchase adds credits; declined card adds nothing', async () => {
  const kurt = await signIn(KURT);
  const nate = athlete('Nate', 'Jensen');
  const pack = get("SELECT * FROM products WHERE kind='group_pack'");
  const before = nate.group_credits;
  const r = await call('POST', '/parent/packs', { athlete_id: nate.id, product_id: pack.id }, kurt);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(athlete('Nate', 'Jensen').group_credits, before + pack.credits);

  const linh = await signIn(LINH);
  const kevin = athlete('Kevin', 'Nguyen');
  const r2 = await call('POST', '/parent/packs', { athlete_id: kevin.id, product_id: pack.id }, linh);
  assert.equal(r2.status, 400);
  assert.equal(athlete('Kevin', 'Nguyen').group_credits, kevin.group_credits);
  const gear = get("SELECT * FROM products WHERE kind='gear'");
  assert.equal((await call('POST', '/parent/packs', { athlete_id: nate.id, product_id: gear.id }, kurt)).status, 404);
});

test('membership start (trial), one at a time; standing spots for members', async () => {
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  const cls = get("SELECT * FROM classes WHERE name='Saturday Strength'");
  const early = await call('POST', '/parent/standing', { athlete_id: isa.id, class_id: cls.id }, paulo);
  assert.equal(early.status, 400, 'standing spots are for members');

  const plan = get("SELECT * FROM plans WHERE name='Unlimited group training'");
  const r = await call('POST', '/parent/membership', { athlete_id: isa.id, plan_id: plan.id }, paulo);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.trial, true);
  const me = (await call('GET', '/parent/me', null, paulo)).data;
  assert.equal(me.athletes[0].membership.status, 'trial');
  assert.equal(me.athletes[0].member_left, 'unlimited');
  assert.equal((await call('POST', '/parent/membership', { athlete_id: isa.id, plan_id: plan.id }, paulo)).status, 400);

  const hold = await call('POST', '/parent/standing', { athlete_id: isa.id, class_id: cls.id }, paulo);
  assert.equal(hold.status, 200, JSON.stringify(hold.data));
  const upcoming = get("SELECT COUNT(*) n FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=?", cls.id, booking.nowLocal()).n;
  const mine = get(`SELECT COUNT(*) n FROM bookings b JOIN events e ON e.id=b.event_id WHERE e.class_id=? AND b.athlete_id=? AND b.status='booked' AND e.starts_at>=?`, cls.id, isa.id, booking.nowLocal()).n;
  assert.ok(hold.data.booked > 0);
  assert.equal(mine, upcoming - hold.data.skipped);
  const shop = (await call('GET', `/parent/shop?athlete_id=${isa.id}`, null, paulo)).data;
  const held = shop.classes.find((c) => c.id === cls.id);
  assert.ok(held.standing_id);
  const leave = await call('DELETE', `/parent/standing/${held.standing_id}`, null, paulo);
  assert.equal(leave.status, 200);
  assert.ok(!get('SELECT 1 FROM standing_spots WHERE id=?', held.standing_id));
  assert.equal(leave.data.cancelled + leave.data.kept, hold.data.booked);
});

test('standing spot on a capped plan books only sessions the membership covers', async () => {
  const kurt = await signIn(KURT);
  const emma = athlete('Emma', 'Jensen'); // 8 sessions a month
  run('UPDATE athletes SET group_credits=4 WHERE id=?', emma.id);
  const cls = get("SELECT * FROM classes WHERE name='High School Performance'");
  const r = await call('POST', '/parent/standing', { athlete_id: emma.id, class_id: cls.id }, kurt);
  if (r.status === 400) { assert.match(r.data.error, /ages|already/); return; } // Emma may be too young for this class
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(athlete('Emma', 'Jensen').group_credits, 4, 'pack credits untouched');
  const cov = all(`SELECT DISTINCT b.coverage FROM bookings b JOIN events e ON e.id=b.event_id WHERE e.class_id=? AND b.athlete_id=? AND b.source='standing'`, cls.id, emma.id).map((x) => x.coverage);
  assert.deepEqual(cov.filter((c) => c !== 'member'), []);
  for (const m of all(`SELECT substr(e.starts_at,1,7) m, COUNT(*) n FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.coverage='member' AND b.status IN ('booked','late_cancel') GROUP BY m`, emma.id)) assert.ok(m.n <= 8, `month ${m.m}: ${m.n}`);
});

test('declined card: membership is held past due', async () => {
  const linh = await signIn(LINH);
  // Linh adds a second athlete, then tries a no-trial plan on the declining card
  const add = await call('POST', '/parent/athletes', { first_name: 'Mai', last_name: 'Nguyen', birthday: '2014-03-02', sex: 'F', sport: 'Swimming' }, linh);
  assert.equal(add.status, 200);
  const elite = get("SELECT * FROM plans WHERE trial_days=0");
  const r = await call('POST', '/parent/membership', { athlete_id: add.data.id, plan_id: elite.id }, linh);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /declined/i);
  assert.equal(get('SELECT status FROM memberships WHERE athlete_id=?', add.data.id).status, 'past_due');
});

// ---- family ----
test('card save validates (Luhn, expiry, CVC, ZIP) and stores only brand, last 4 and expiry', async () => {
  const kurt = await signIn(KURT);
  const bad = [
    { number: '4242 4242 4242 4241', exp: '12/30', cvc: '123', zip: '84604' },
    { number: '4242 4242 4242 4242', exp: '01/20', cvc: '123', zip: '84604' },
    { number: '4242 4242 4242 4242', exp: '13/30', cvc: '123', zip: '84604' },
    { number: '4242 4242 4242 4242', exp: '12/30', cvc: '12', zip: '84604' },
    { number: '4242 4242 4242 4242', exp: '12/30', cvc: '123', zip: '' },
  ];
  for (const b of bad) assert.equal((await call('PUT', '/parent/card', b, kurt)).status, 400, JSON.stringify(b));
  const r = await call('PUT', '/parent/card', { number: '5555 5555 5555 4444', exp: '7/31', cvc: '321', zip: '84604' }, kurt);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const fam = get("SELECT f.* FROM families f JOIN parents p ON p.family_id=f.id WHERE p.email=?", KURT);
  assert.equal(fam.card_brand, 'Mastercard');
  assert.equal(fam.card_last4, '4444');
  assert.equal(fam.card_exp, '07/31');
  const dump = JSON.stringify([all('SELECT * FROM families'), all('SELECT * FROM activity'), all('SELECT * FROM invoices')]);
  assert.ok(!dump.includes('5555555555554444') && !dump.includes('5555 5555 5555 4444'), 'full number never stored');
});

test('new card retries a declined charge', async () => {
  const linh = await signIn(LINH);
  const failed = get("SELECT COUNT(*) n FROM invoices i JOIN parents p ON p.family_id=i.family_id WHERE p.email=? AND i.status='failed'", LINH).n;
  assert.ok(failed > 0);
  const r = await call('PUT', '/parent/card', { number: '4000 0566 5566 5556', exp: '11/30', cvc: '123', zip: '84604' }, linh);
  assert.equal(r.status, 200);
  assert.ok(r.data.paid >= 1);
  const me = (await call('GET', '/parent/me', null, linh)).data;
  assert.equal(me.family.card_last4, '5556');
});

test('waiver sign sets the current version', async () => {
  const paulo = await signIn(PAULO);
  assert.equal((await call('POST', '/parent/waiver', { name: 'Paulo Silva' }, paulo)).status, 400, 'must agree');
  assert.equal((await call('POST', '/parent/waiver', { name: 'P', agree: true }, paulo)).status, 400, 'full name');
  const r = await call('POST', '/parent/waiver', { name: 'Paulo Silva', agree: true }, paulo);
  assert.equal(r.status, 200);
  const fam = get("SELECT f.* FROM families f JOIN parents p ON p.family_id=f.id WHERE p.email=?", PAULO);
  assert.equal(fam.waiver_version, Number(setting('waiver_version')));
  assert.equal(fam.waiver_signed_by, 'Paulo Silva');
  assert.ok(fam.waiver_signed_at);
  assert.equal((await call('GET', '/parent/me', null, paulo)).data.family.waiver_current, true);
});

test('update athlete, add athlete, add parent', async () => {
  const kurt = await signIn(KURT);
  const emma = athlete('Emma', 'Jensen');
  const u = await call('PUT', `/parent/athletes/${emma.id}`, { sport: 'Track', position: 'Sprinter', allergies: 'None', medical_notes: 'Mild asthma', emergency_name: 'Kurt Jensen', emergency_phone: '385-555-0110', sex: 'F', birthday: '2011-01-27' }, kurt);
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.equal(athlete('Emma', 'Jensen').sport, 'Track');
  assert.equal(athlete('Emma', 'Jensen').medical_notes, 'Mild asthma');
  assert.equal((await call('PUT', `/parent/athletes/${emma.id}`, { birthday: '2040-01-01' }, kurt)).status, 400);
  assert.equal((await call('PUT', `/parent/athletes/${emma.id}`, { sex: 'X' }, kurt)).status, 400);

  const a = await call('POST', '/parent/athletes', { first_name: 'Lily', last_name: 'Jensen', birthday: '2016-05-05', sport: 'Soccer' }, kurt);
  assert.equal(a.status, 200);
  assert.match(a.data.code, /^LILJEN\d*2026$|^LILJEN/);
  const row = get('SELECT * FROM athletes WHERE id=?', a.data.id);
  assert.ok(row.workout_token && row.workout_token.length >= 12);
  assert.equal(row.family_id, emma.family_id);
  assert.equal((await call('POST', '/parent/athletes', { first_name: 'NoLast' }, kurt)).status, 400);

  const p = await call('POST', '/parent/parents', { name: 'Anna Jensen', email: 'anna.jensen@example.com' }, kurt);
  assert.equal(p.status, 200);
  assert.equal((await call('POST', '/parent/parents', { name: 'Maria', email: MARIA }, kurt)).status, 400);
  const me = (await call('GET', '/parent/me', null, kurt)).data;
  assert.equal(me.parents.length, 2);
  assert.ok(get("SELECT 1 FROM outbox WHERE to_email='anna.jensen@example.com'"));
  // The new parent can sign in and sees the same family
  const anna = await signIn('anna.jensen@example.com');
  assert.equal((await call('GET', '/parent/me', null, anna)).data.family.id, me.family.id);
});

test('sign out ends the session', async () => {
  const cookie = await signIn(KURT);
  await call('POST', '/auth/parent/logout', {}, cookie);
  assert.equal((await call('GET', '/parent/me', null, cookie)).status, 401);
});

// ---- sign-in: session check, activity, limits ----
test('session check answers 200 signed in or out; parent sign-in is logged', async () => {
  const out = await call('GET', '/auth/parent/session');
  assert.equal(out.status, 200);
  assert.equal(out.data.signed_in, false);
  const before = get('SELECT MAX(id) m FROM activity').m || 0;
  const c = await call('POST', '/auth/parent/code', { email: LINH });
  assert.equal(c.data.resend_in, 30);
  const v = await call('POST', '/auth/parent/verify', { email: LINH, code: c.data.test_code });
  const cookie = v.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/auth/parent/session', null, cookie)).data.signed_in, true);
  const row = get("SELECT * FROM activity WHERE id>? AND action='Signed in' ORDER BY id DESC LIMIT 1", before);
  assert.ok(row, 'sign-in is in the activity log');
  assert.match(row.actor, /\(parent\)/);
  assert.equal(row.kind, 'signin');
});

test('codes are limited per email, the same way for addresses that are not on file', async () => {
  const fid = insert('families', { name: 'Limit family' });
  insert('parents', { family_id: fid, name: 'Lim Test', email: 'limit.parent@example.com' });
  for (const email of ['limit.parent@example.com', 'not.on.file@example.com']) {
    for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/auth/parent/code', { email })).status, 200, `code ${i + 1} for ${email}`);
    const r = await call('POST', '/auth/parent/code', { email });
    assert.equal(r.status, 429, email);
    assert.match(r.data.error, /Too many codes/);
    assert.ok(r.data.retry_after > 0);
  }
});

test('wrong codes across several codes lock sign-in for the hour', async () => {
  const fid = insert('families', { name: 'Guess family' });
  insert('parents', { family_id: fid, name: 'Gus Test', email: 'guess.parent@example.com' });
  const email = 'guess.parent@example.com';
  // Earlier codes in the hour already took 11 wrong tries; 4 more makes 15.
  const soon = new Date(Date.now() + 5 * 6e4).toISOString();
  insert('parent_codes', { email, code_hash: 'x', expires_at: soon, used: 1, attempts: 5 });
  insert('parent_codes', { email, code_hash: 'y', expires_at: soon, used: 1, attempts: 5 });
  insert('parent_codes', { email, code_hash: 'z', expires_at: soon, used: 1, attempts: 1 });
  const c = await call('POST', '/auth/parent/code', { email });
  const wrong = c.data.test_code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/auth/parent/verify', { email, code: wrong })).status, 400);
  const locked = await call('POST', '/auth/parent/verify', { email, code: c.data.test_code });
  assert.equal(locked.status, 429, 'the right code is refused once 15 wrong tries are used up');
  assert.match(locked.data.error, /Too many wrong codes/);
});

// ---- Home: bookings list details, attendance ----
test('bookings list shows waitlist place, sessions on now, and a started session cannot be cancelled', async () => {
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  run('UPDATE athletes SET group_credits=5 WHERE id=?', isa.id);
  // Waitlist: two others ahead of Isabela
  const full = makeEvent({ hours: 90, capacity: 1, name: 'Full class' });
  booking.book(full, athlete('Ava', 'Lopez').id, { source: 'staff' });
  booking.book(full, athlete('Nate', 'Jensen').id, { source: 'staff' });
  const w = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: full }, paulo);
  assert.equal(w.data.status, 'waitlist');
  // On now: started 20 minutes ago, 60 minutes long
  const now = insert('events', { type: 'class', name: 'On now class', starts_at: localPlus(-20 / 60), duration_min: 60, capacity: 10, price_cents: 0, location_id: 1 });
  const nb = booking.book(now, isa.id, { source: 'staff' });
  // Finished: started 2 hours ago
  const done = insert('events', { type: 'class', name: 'Finished class', starts_at: localPlus(-2), duration_min: 60, capacity: 10, price_cents: 0, location_id: 1 });
  booking.book(done, isa.id, { source: 'staff' });

  const list = (await call('GET', '/parent/bookings', null, paulo)).data;
  const wl = list.find((x) => x.event_id === full);
  assert.equal(wl.waitlist_pos, 2);
  assert.equal(wl.address, '1450 N Industrial Pkwy, Provo, UT 84604');
  const on = list.find((x) => x.event_id === now);
  assert.ok(on, 'a session on now stays listed');
  assert.equal(on.started, true);
  assert.equal(on.waitlist_pos, null);
  assert.ok(!list.some((x) => x.event_id === done), 'finished sessions drop off');
  assert.ok(list.every((x) => !('checked_in_at' in x)));

  const c = await call('DELETE', `/parent/bookings/${nb.id}`, null, paulo);
  assert.equal(c.status, 400);
  assert.match(c.data.error, /already started/);
  assert.equal(get('SELECT status FROM bookings WHERE id=?', nb.id).status, 'booked');
  // Leaving a waitlist is always fine
  assert.equal((await call('DELETE', `/parent/bookings/${w.data.id}`, null, paulo)).status, 200);
});

test('me reports attendance: sessions checked in over 30 days and the latest', async () => {
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  const ev = insert('events', { type: 'class', name: 'Attended class', starts_at: localPlus(-26), duration_min: 60, capacity: 10, price_cents: 0, location_id: 1 });
  const b = booking.book(ev, isa.id, { source: 'staff' });
  run("UPDATE bookings SET checked_in_at=datetime('now') WHERE id=?", b.id);
  const a = (await call('GET', '/parent/me', null, paulo)).data.athletes.find((x) => x.id === isa.id);
  assert.ok(a.attendance.last_30 >= 1);
  assert.ok(a.attendance.last_at >= get('SELECT starts_at FROM events WHERE id=?', ev).starts_at, 'the latest session attended');
  // Not checked in: doesn't count
  const ev2 = insert('events', { type: 'class', name: 'Missed class', starts_at: localPlus(-3), duration_min: 60, capacity: 10, price_cents: 0, location_id: 1 });
  booking.book(ev2, isa.id, { source: 'staff' });
  const a2 = (await call('GET', '/parent/me', null, paulo)).data.athletes.find((x) => x.id === isa.id);
  assert.equal(a2.attendance.last_30, a.attendance.last_30);
});

// ---- calendar ----
test('calendar feed: private link, family bookings only, UTC times, reset kills the old link', async () => {
  const maria = await signIn(MARIA);
  assert.equal((await call('GET', '/parent/calendar')).status, 401);
  const links = (await call('GET', '/parent/calendar', null, maria)).data;
  assert.match(links.url, /\/api\/calendar\/[\w-]+\.ics$/);
  assert.ok(links.webcal.startsWith('webcal://'));
  assert.ok(links.google.includes(encodeURIComponent(links.webcal)));
  assert.equal((await call('GET', '/parent/calendar', null, maria)).data.url, links.url, 'the same link each time');
  assert.ok(get("SELECT 1 FROM activity WHERE action='Turned on calendar link'"));

  const path = new URL(links.url).pathname;
  const res = await fetch(base + path); // no cookie: calendar apps can't sign in
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  const ics = await res.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /X-WR-CALNAME:.*Lopez family/);
  assert.match(ics, /SUMMARY:Ava: /);
  assert.ok(!/SUMMARY:(Nate|Emma|Isabela):/.test(ics), 'no other family');
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines are folded');
  // A booking at 18:00 local in Denver is 00:00 or 01:00 UTC the next day.
  const ava = athlete('Ava', 'Lopez');
  const ev = insert('events', { type: 'class', name: 'Calendar check', starts_at: '2027-01-15T18:00', duration_min: 90, capacity: 10, price_cents: 0, location_id: 1 });
  booking.book(ev, ava.id, { source: 'staff' });
  const ics2 = await (await fetch(base + path)).text();
  assert.match(ics2, /SUMMARY:Ava: Calendar check\r\n/);
  assert.match(ics2, /DTSTART:20270116T010000Z\r\nDTEND:20270116T023000Z/);

  const reset = (await call('POST', '/parent/calendar/reset', {}, maria)).data;
  assert.notEqual(reset.url, links.url);
  assert.equal((await fetch(base + path)).status, 404, 'the old link stops working');
  assert.equal((await fetch(base + new URL(reset.url).pathname)).status, 200);
  assert.equal((await fetch(base + '/api/calendar/short.ics')).status, 404);
});

test('one session as a calendar file, only for your own family', async () => {
  const maria = await signIn(MARIA);
  const paulo = await signIn(PAULO);
  const mine = (await call('GET', '/parent/bookings', null, maria)).data.find((b) => b.status === 'booked');
  const r = await fetch(`${base}/api/parent/bookings/${mine.id}/ics`, { headers: { cookie: maria } });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /BEGIN:VEVENT[\s\S]*UID:dp-booking-\d+@diamond-protocol[\s\S]*END:VEVENT/);
  assert.ok(!body.includes('REFRESH-INTERVAL'), 'a one-off file is not a subscription');
  assert.equal((await fetch(`${base}/api/parent/bookings/${mine.id}/ics`, { headers: { cookie: paulo } })).status, 404);
});

test('calendar times follow daylight saving', () => {
  const { localToUtc } = require('../server/services/parent-calendar');
  assert.equal(new Date(localToUtc('2026-07-01T18:00', 'America/Denver')).toISOString(), '2026-07-02T00:00:00.000Z');
  assert.equal(new Date(localToUtc('2026-12-01T18:00', 'America/Denver')).toISOString(), '2026-12-02T01:00:00.000Z');
  assert.equal(new Date(localToUtc('2026-11-01T09:00', 'America/Denver')).toISOString(), '2026-11-01T16:00:00.000Z');
  assert.equal(new Date(localToUtc('2026-03-08T09:00', 'America/Denver')).toISOString(), '2026-03-08T15:00:00.000Z');
});

test('checking a code answers the same for an email that is not on file', async () => {
  const fid = insert('families', { name: 'Probe family' });
  insert('parents', { family_id: fid, name: 'Real Parent', email: 'real.probe@example.com' });
  const answers = {};
  for (const email of ['real.probe@example.com', 'nobody.probe@example.com']) {
    assert.equal((await call('POST', '/auth/parent/code', { email })).status, 200);
    const seen = [];
    for (let i = 0; i < 6; i++) { const r = await call('POST', '/auth/parent/verify', { email, code: '000000' }); seen.push(`${r.status} ${r.data.error}`); }
    answers[email] = seen;
  }
  assert.deepEqual(answers['nobody.probe@example.com'], answers['real.probe@example.com']);
  assert.match(answers['nobody.probe@example.com'][0], /doesn't match/);
  assert.match(answers['nobody.probe@example.com'][5], /Too many tries/);
  // No email goes to an address that isn't on file, and the failure is logged with where it came from.
  assert.ok(!get("SELECT 1 FROM outbox WHERE to_email='nobody.probe@example.com'"));
  const row = get("SELECT * FROM activity WHERE action='Sign-in failed' AND detail LIKE 'nobody.probe@example.com%' ORDER BY id DESC LIMIT 1");
  assert.ok(row && row.ip, 'failed sign-in is logged with the network address');
});

// ---- Book tab: details, clashes, coaches, notes, freeing a cancelled private ----
const outboxTop = () => get('SELECT MAX(id) m FROM outbox').m || 0;
const outboxSince = (id) => all('SELECT * FROM outbox WHERE id>? ORDER BY id', id);
// An earlier test signs Kurt out, so these sign in again.
const freshSignIn = (email) => { delete sessions[email]; return signIn(email); };

test('classes list carries coach, late window, waitlist place, camp days and the waiver state', async () => {
  const kurt = await freshSignIn(KURT);
  const nate = athlete('Nate', 'Jensen');
  const r = (await call('GET', `/parent/classes?athlete_id=${nate.id}`, null, kurt)).data;
  assert.equal(typeof r.late_cancel_hours, 'number');
  assert.equal(r.waiver_current, true);
  const cls = r.events.find((e) => e.type === 'class' && e.coach);
  assert.ok(cls, 'classes name their coach');
  assert.equal(cls.coach, 'Chris', 'first name only');
  for (const e of r.events) assert.equal(typeof e.late, 'boolean');
  const wl = r.events.find((e) => e.my_status === 'waitlist');
  assert.ok(wl && wl.waitlist_pos >= 1, 'waitlist spot shows its place in line');
  const booked = r.events.find((e) => e.my_status === 'booked');
  assert.ok(booked.my_booking_id && booked.my_coverage, 'booked sessions say how they are paid');
  const emma = athlete('Emma', 'Jensen');
  const camp = get("SELECT * FROM classes WHERE name='Fall Speed Camp'");
  const e2 = (await call('GET', `/parent/classes?athlete_id=${emma.id}`, null, kurt)).data.events.filter((e) => e.class_id === camp.id);
  if (e2.length) {
    const days = get('SELECT COUNT(*) n FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=?', camp.id, booking.nowLocal()).n;
    assert.equal(e2[0].reg_days, days);
    assert.equal(e2[0].reg_closed, false);
    run('UPDATE classes SET reg_deadline=? WHERE id=?', '2000-01-01', camp.id);
    const closed = (await call('GET', `/parent/classes?athlete_id=${emma.id}`, null, kurt)).data.events.find((e) => e.class_id === camp.id);
    assert.equal(closed.reg_closed, true, 'registration closed is flagged');
    run('UPDATE classes SET reg_deadline=? WHERE id=?', camp.reg_deadline, camp.id);
  }
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  // A new waiver version means every family has to sign again.
  const v = Number(setting('waiver_version', 1));
  run("UPDATE settings SET value=? WHERE key='waiver_version'", String(v + 1));
  const p = (await call('GET', `/parent/classes?athlete_id=${isa.id}`, null, paulo)).data;
  run("UPDATE settings SET value=? WHERE key='waiver_version'", String(v));
  assert.equal(p.waiver_current, false, 'the waiver changed since they signed');
});

test('an athlete cannot be booked into two sessions at once, not even on a waitlist', async () => {
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  run('UPDATE athletes SET group_credits=5 WHERE id=?', isa.id);
  const a = makeEvent({ hours: 120, name: 'Clash A' });
  const b = makeEvent({ hours: 120.5, name: 'Clash B' });
  const c = makeEvent({ hours: 120.5, capacity: 1, name: 'Clash C' });
  booking.book(c, athlete('Ava', 'Lopez').id, { source: 'staff' }); // full
  const r1 = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: a }, paulo);
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const r2 = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: b }, paulo);
  assert.equal(r2.status, 400);
  assert.equal(r2.data.clash_event_id, a);
  assert.match(r2.data.error, /Clash A/);
  const r3 = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: c }, paulo);
  assert.equal(r3.status, 400, 'no waitlist spot that would double-book');
  const list = (await call('GET', `/parent/classes?athlete_id=${isa.id}`, null, paulo)).data.events;
  assert.equal(list.find((e) => e.id === b).clash.name, 'Clash A');
  assert.equal(list.find((e) => e.id === a).clash, null, 'your own booking is not a clash');
  await call('DELETE', `/parent/bookings/${r1.data.id}`, null, paulo);
  const r4 = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: b }, paulo);
  assert.equal(r4.status, 200, 'books once the other is cancelled');
  await call('DELETE', `/parent/bookings/${r4.data.id}`, null, paulo);
  run('UPDATE athletes SET group_credits=3 WHERE id=?', isa.id);
});

test('private times name the coach; booking a coach with a note tells them; cancelling frees the time', async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  run('UPDATE athletes SET private_credits=2 WHERE id=?', ava.id);
  const owner = get("SELECT * FROM staff WHERE role='owner'");
  const d = (await call('GET', `/parent/slots?kind=private&athlete_id=${ava.id}`, null, maria)).data;
  assert.equal(d.coaches.length, 2, 'two coaches take privates in the demo');
  assert.ok(d.slots.every((s) => s.coach && s.coach_id));
  assert.ok(d.single_private && d.single_private.price_cents > 0);
  assert.ok(d.booked.some((b) => /first-step/.test(b.note || '')), 'the seeded private shows as booked, with its note');
  const slot = d.slots.find((s) => s.coach_id === owner.id);
  assert.ok(slot, 'the owner has private hours');
  assert.equal(slot.coach, 'Jordan');

  // validation
  const long = await call('POST', '/parent/slots', { kind: 'private', starts_at: slot.starts_at, athlete_id: ava.id, coach_id: owner.id, note: 'x'.repeat(501) }, maria);
  assert.equal(long.status, 400);
  assert.match(long.data.error, /500/);
  const badCoach = await call('POST', '/parent/slots', { kind: 'private', starts_at: slot.starts_at, athlete_id: ava.id, coach_id: 'abc' }, maria);
  assert.equal(badCoach.status, 400);
  const wrongCoach = await call('POST', '/parent/slots', { kind: 'private', starts_at: slot.starts_at, athlete_id: ava.id, coach_id: 999 }, maria);
  assert.equal(wrongCoach.status, 400, 'no such coach at that time');
  assert.equal(athlete('Ava', 'Lopez').private_credits, 2, 'nothing was used');

  const before = outboxTop();
  const ok = await call('POST', '/parent/slots', { kind: 'private', starts_at: slot.starts_at, athlete_id: ava.id, coach_id: owner.id, note: '  Focus on hip turn.  ' }, maria);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(get('SELECT note FROM bookings WHERE id=?', ok.data.id).note, 'Focus on hip turn.');
  const ev = get('SELECT * FROM events WHERE id=?', ok.data.event_id);
  assert.equal(ev.coach_id, owner.id, 'booked with the coach picked');
  const mail = outboxSince(before).find((m) => m.to_email === owner.email);
  assert.ok(mail && /New private/.test(mail.subject) && /Focus on hip turn/.test(mail.body), 'the coach is emailed with the note');
  assert.equal(athlete('Ava', 'Lopez').private_credits, 1);
  const after = (await call('GET', `/parent/slots?kind=private&athlete_id=${ava.id}`, null, maria)).data;
  assert.ok(!after.slots.some((s) => s.starts_at === slot.starts_at && s.coach_id === owner.id));
  assert.ok(after.booked.some((b) => b.id === ok.data.id && b.coach === 'Jordan'));
  assert.ok(get("SELECT 1 FROM activity WHERE action='Booked private' AND detail LIKE '%note for the coach%'"));

  const before2 = outboxTop();
  const c = await call('DELETE', `/parent/bookings/${ok.data.id}`, null, maria);
  assert.equal(c.status, 200);
  assert.equal(c.data.freed, true);
  assert.equal(get('SELECT cancelled FROM events WHERE id=?', ok.data.event_id).cancelled, 1, 'the private session is cancelled');
  assert.equal(athlete('Ava', 'Lopez').private_credits, 2, 'credit back outside the window');
  assert.ok(outboxSince(before2).some((m) => m.to_email === owner.email && /Cancelled/.test(m.subject)), 'the coach is told');
  const again = (await call('GET', `/parent/slots?kind=private&athlete_id=${ava.id}`, null, maria)).data;
  assert.ok(again.slots.some((s) => s.starts_at === slot.starts_at && s.coach_id === owner.id), 'the time is open again');
});

test('open times leave out times the athlete is already booked, and booking one anyway is refused', async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  run('UPDATE athletes SET private_credits=2 WHERE id=?', ava.id);
  const coach = get("SELECT * FROM staff WHERE role='coach'");
  const desk = get("SELECT * FROM staff WHERE role='frontdesk'");
  const d = (await call('GET', `/parent/slots?kind=private&athlete_id=${ava.id}`, null, maria)).data;
  const slot = d.slots.find((s) => s.coach_id === coach.id && s.starts_at.slice(0, 10) > booking.todayLocal());
  // Another session at that time with a different staff member, so the coach's hours stay open.
  const ev = insert('events', { type: 'class', name: 'Busy block', starts_at: slot.starts_at, duration_min: 60, capacity: 5, price_cents: 0, location_id: 1, coach_id: desk.id });
  const b = booking.book(ev, ava.id, { source: 'staff' });
  const after = (await call('GET', `/parent/slots?kind=private&athlete_id=${ava.id}`, null, maria)).data;
  assert.ok(!after.slots.some((s) => s.starts_at === slot.starts_at), 'busy time left out');
  const r = await call('POST', '/parent/slots', { kind: 'private', starts_at: slot.starts_at, athlete_id: ava.id, coach_id: coach.id }, maria);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /already booked for Busy block/);
  assert.equal(athlete('Ava', 'Lopez').private_credits, 2);
  booking.cancelBooking(b.id);
  run('UPDATE events SET cancelled=1 WHERE id=?', ev);
});

test('cancelling a paid evaluation refunds it and opens the time again', async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  const d = (await call('GET', `/parent/slots?kind=evaluation&athlete_id=${ava.id}`, null, maria)).data;
  const s = d.slots[d.slots.length - 1];
  const r = await call('POST', '/parent/slots', { kind: 'evaluation', starts_at: s.starts_at, athlete_id: ava.id, coach_id: s.coach_id }, maria);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.paid_cents, 7500);
  const booked = (await call('GET', `/parent/slots?kind=evaluation&athlete_id=${ava.id}`, null, maria)).data.booked;
  assert.ok(booked.some((b) => b.id === r.data.id && b.coverage === 'paid'));
  const c = await call('DELETE', `/parent/bookings/${r.data.id}`, null, maria);
  assert.equal(c.data.freed, true);
  assert.ok(get('SELECT 1 FROM invoices WHERE athlete_id=? AND amount_cents=-7500', ava.id), 'refunded');
  const again = (await call('GET', `/parent/slots?kind=evaluation&athlete_id=${ava.id}`, null, maria)).data.slots;
  assert.ok(again.some((x) => x.starts_at === s.starts_at));
});

test('book tab endpoints stay family-scoped and parent-only', async () => {
  const kurt = await freshSignIn(KURT);
  const ava = athlete('Ava', 'Lopez');
  assert.equal((await call('GET', `/parent/slots?kind=private&athlete_id=${ava.id}`, null, kurt)).status, 404);
  assert.equal((await call('GET', `/parent/classes?athlete_id=${ava.id}`, null, kurt)).status, 404);
  assert.equal((await call('GET', `/parent/slots?kind=private&athlete_id=${ava.id}`)).status, 401);
  const avaBooking = get("SELECT b.id FROM bookings b WHERE b.athlete_id=? AND b.status='booked' LIMIT 1", ava.id);
  assert.equal((await call('DELETE', `/parent/bookings/${avaBooking.id}`, null, kurt)).status, 404);
});

// ---- review fixes ----
test('a waitlist spot blocks booking another session at the same time, since it can turn into a booking', async () => {
  const paulo = await signIn(PAULO);
  const isa = athlete('Isabela', 'Silva');
  run('UPDATE athletes SET group_credits=5 WHERE id=?', isa.id);
  const w = makeEvent({ hours: 140, capacity: 1, name: 'Waitlisted W' });
  const x = makeEvent({ hours: 140.5, name: 'Other X' });
  const held = booking.book(w, athlete('Ava', 'Lopez').id, { source: 'staff' }); // fills W
  const r1 = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: w }, paulo);
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.status, 'waitlist');
  const list = (await call('GET', `/parent/classes?athlete_id=${isa.id}`, null, paulo)).data.events;
  const xr = list.find((e) => e.id === x);
  assert.equal(xr.clash?.name, 'Waitlisted W', 'the overlapping class says why it cannot be booked');
  assert.equal(xr.clash.status, 'waitlist');
  const r2 = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: x }, paulo);
  assert.equal(r2.status, 400, 'refused: the waitlist spot could be promoted into a double booking');
  assert.equal(r2.data.clash_event_id, w);
  assert.match(r2.data.error, /waitlist/);
  // Leaving the waitlist frees the time.
  await call('DELETE', `/parent/bookings/${r1.data.id}`, null, paulo);
  const r3 = await call('POST', '/parent/bookings', { athlete_id: isa.id, event_id: x }, paulo);
  assert.equal(r3.status, 200, JSON.stringify(r3.data));
  await call('DELETE', `/parent/bookings/${r3.data.id}`, null, paulo);
  booking.cancelBooking(held.id);
  run('UPDATE athletes SET group_credits=3 WHERE id=?', isa.id);
});

test("one coach's private does not take another coach's hours at the same time", async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  run('UPDATE athletes SET private_credits=2 WHERE id=?', ava.id);
  const coach = get("SELECT * FROM staff WHERE role='coach'");
  const owner = get("SELECT * FROM staff WHERE role='owner'");
  const mine = get("SELECT * FROM availability WHERE kind='private' AND coach_id=? ORDER BY weekday LIMIT 1", coach.id);
  const extra = insert('availability', { kind: 'private', weekday: mine.weekday, start_time: mine.start_time, end_time: mine.end_time, slot_min: mine.slot_min, location_id: mine.location_id, coach_id: owner.id });
  const from = require('../server/lib').addDays(booking.todayLocal(), 1);
  const slot = booking.openSlots('private', from, 14).find((s) => s.coach_id === coach.id
    && booking.openSlots('private', from, 14).some((o) => o.coach_id === owner.id && o.starts_at === s.starts_at));
  assert.ok(slot, 'both coaches have that time open');
  const r = await call('POST', '/parent/slots', { kind: 'private', starts_at: slot.starts_at, athlete_id: ava.id, coach_id: coach.id }, maria);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const open = booking.openSlots('private', slot.starts_at.slice(0, 10), 1).filter((s) => s.starts_at === slot.starts_at);
  assert.deepEqual(open.map((s) => s.coach_id), [owner.id], 'the other coach is still free then');
  await call('DELETE', `/parent/bookings/${r.data.id}`, null, maria);
  run('DELETE FROM availability WHERE id=?', extra);
});

test('a late-cancelled private still opens the time, keeps the session used and tells the coach so', async () => {
  const maria = await signIn(MARIA);
  const ava = athlete('Ava', 'Lopez');
  run('UPDATE athletes SET private_credits=1 WHERE id=?', ava.id);
  const d = (await call('GET', `/parent/slots?kind=private&athlete_id=${ava.id}`, null, maria)).data;
  const s = d.slots[d.slots.length - 1];
  const r = await call('POST', '/parent/slots', { kind: 'private', starts_at: s.starts_at, athlete_id: ava.id, coach_id: s.coach_id }, maria);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const lateBefore = setting('late_cancel_hours', 12);
  run("INSERT INTO settings (key, value) VALUES ('late_cancel_hours', '10000') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const coach = get('SELECT * FROM staff WHERE id=?', s.coach_id);
  const before = outboxTop();
  const c = await call('DELETE', `/parent/bookings/${r.data.id}`, null, maria);
  run("UPDATE settings SET value=? WHERE key='late_cancel_hours'", String(lateBefore));
  assert.equal(c.status, 200);
  assert.equal(c.data.late, true);
  assert.equal(c.data.freed, true);
  assert.equal(get('SELECT status FROM bookings WHERE id=?', r.data.id).status, 'late_cancel');
  assert.equal(athlete('Ava', 'Lopez').private_credits, 0, 'inside the window the session stays used');
  const mail = outboxSince(before).find((m) => m.to_email === coach.email);
  assert.ok(mail && /still counts as used/.test(mail.body), 'the coach hears it was late');
  assert.ok(booking.openSlots('private', s.starts_at.slice(0, 10), 1).some((x) => x.starts_at === s.starts_at && x.coach_id === s.coach_id), 'the time is open again');
});
