import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { newId, localDate, addDaysToDate, weekdayOf } from '../src/util.js';

// The public Book now page and the website widget.
let app, base, owner, facility;
const DAY = 86400000;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
function session(name, kind, inDays, { ageMin = null, ageMax = null, capacity = 8 } = {}) {
  const id = newId('cls'), s = new Date(Date.now() + inDays * DAY).toISOString(), e = new Date(Date.now() + inDays * DAY + 3600000).toISOString();
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, age_min, age_max, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 2500, ?, ?, 'scheduled', ?)`,
    id, name, kind, facility.id, s, e, capacity, ageMin, ageMax, s);
  return id;
}
const pub = async () => (await fetch(base + '/portal/api/public/schedule')).json();

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

test('anyone can see open classes and evaluation times, with no names', async () => {
  const speed = session('Youth speed', 'group', 1, { ageMin: 8, ageMax: 12, capacity: 2 });
  session('Team lift', 'team', 1);
  session('Far away', 'group', 20);
  const ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'booked', 'membership', ?, ?)`, newId('bkg'), speed, ava.id, app.ctx.now(), app.ctx.now());
  const tomorrow = addDaysToDate(localDate(app.ctx.now(), 'America/Chicago'), 1);
  await owner('POST', '/v1/availability', { kind: 'evaluation', location_id: facility.id, weekday: weekdayOf(tomorrow), start_time: '09:00', end_time: '15:00', slot_minutes: 60, price_cents: 7500 });

  const d = await pub();
  assert.equal(d.open, true);
  assert.deepEqual(d.classes.map((s) => [s.name, s.spots_left, s.age_min, s.drop_in_cents]), [['Youth speed', 1, 8, 2500]], 'team sessions and anything past 2 weeks stay off');
  assert.ok(!JSON.stringify(d).includes('Ava'), 'no athlete names');
  assert.ok(d.evaluations.length >= 1 && d.evaluations.length <= 6, 'at most three a day');
  const perDay = {};
  for (const e of d.evaluations) perDay[e.starts_at.slice(0, 10)] = (perDay[e.starts_at.slice(0, 10)] ?? 0) + 1;
  assert.ok(Object.values(perDay).every((n) => n <= 3));
  assert.equal(d.evaluations[0].price_cents, 7500);
});

test('the owner can turn the page off', async () => {
  assert.equal((await owner('PATCH', '/v1/settings', { public_schedule: 'off' })).status, 200);
  const d = await pub();
  assert.deepEqual([d.open, d.classes.length, d.evaluations.length], [false, 0, 0]);
  await owner('PATCH', '/v1/settings', { public_schedule: 'on' });
  assert.equal((await pub()).open, true);
});

test('only the Book now page can sit inside another website', async () => {
  const book = await fetch(base + '/book');
  assert.equal(book.status, 200);
  assert.match(book.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.match(await book.text(), /\/js\/book\.js/);
  for (const path of ['/', '/parent', '/join', '/start']) assert.match((await fetch(base + path)).headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
  const embed = await fetch(base + '/embed.js');
  assert.match(embed.headers.get('content-type'), /javascript/);
  assert.match(await embed.text(), /\/book\?embed=1/);
});
