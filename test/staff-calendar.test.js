// A coach's own calendar feed (schema 84, services/staffcal.js): a private address per staff member for Apple, Google
// or Outlook with the sessions they lead (the owner: every session); the address is shown once, a reset kills the old
// one, turning it off kills it too; front desk has none; a version 83 database gains the columns.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { openDb } from '../src/db.js';

let app, base, owner, coach, desk, riley, facility;
const PW = 'correct-horse-battery';
async function req(method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text, res: r };
}
async function staff(email) {
  const r = await req('POST', '/auth/login', { email, password: PW });
  const cookie = r.res.headers.get('set-cookie').split(';')[0];
  return (m, p, b) => req(m, p, b, { cookie });
}
const dayFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@x.test', name: 'Owner', password: PW, role: 'owner' });
  riley = createUser(app.ctx, { email: 'riley@x.test', name: 'Riley Brooks', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@x.test', name: 'Desk', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@x.test'); coach = await staff('riley@x.test'); desk = await staff('desk@x.test');
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  assert.equal((await owner('POST', '/v1/sessions', { name: 'Speed class', kind: 'group', location_id: facility.id, date: dayFromNow(2), start_time: '17:00', duration_min: 60, capacity: 12, coach_id: riley.id })).status, 201);
  assert.equal((await owner('POST', '/v1/sessions', { name: 'Evaluation day', kind: 'evaluation', location_id: facility.id, date: dayFromNow(3), start_time: '09:00', duration_min: 90, capacity: 8 })).status, 201);
});
after(() => app.server.close());

test('a coach gets a private feed of the sessions they lead; the owner of everything; the address is shown once; reset and off kill it', async () => {
  assert.deepEqual((await coach('GET', '/v1/me/calendar-feed')).body, { on: false, created_at: null });
  const made = (await coach('POST', '/v1/me/calendar-feed')).body;
  assert.match(made.url, /^https:\/\/app\.example\.org\/cal\/staff\/[\w-]{32}\.ics$/);
  assert.match(made.webcal, /^webcal:\/\//);
  const feed = await req('GET', made.url.replace('https://app.example.org', ''));
  assert.equal(feed.status, 200); assert.match(feed.res.headers.get('content-type'), /^text\/calendar/);
  assert.match(feed.text, /SUMMARY:Speed class \(0\/12\)/);
  assert.doesNotMatch(feed.text, /Evaluation day/, 'a coach sees only what they lead');
  assert.match(feed.text, /X-WR-CALNAME:Diamond Protocol: Riley Brooks/);
  assert.match(feed.text, /DESCRIPTION:Coach: Riley Brooks/);
  const status = (await coach('GET', '/v1/me/calendar-feed')).body;
  assert.equal(status.on, true); assert.ok(!status.url, 'the address is shown once');
  // The owner's feed has every session.
  const ownerMade = (await owner('POST', '/v1/me/calendar-feed')).body;
  const all = await req('GET', ownerMade.url.replace('https://app.example.org', ''));
  assert.match(all.text, /Speed class/); assert.match(all.text, /Evaluation day \(0\/8\)/);
  assert.match(all.text, /X-WR-CALNAME:Diamond Protocol schedule/);
  // Reset: the old address stops, the new one works.
  const again = (await coach('POST', '/v1/me/calendar-feed')).body;
  assert.notEqual(again.url, made.url);
  assert.equal((await req('GET', made.url.replace('https://app.example.org', ''))).status, 404);
  assert.equal((await req('GET', again.url.replace('https://app.example.org', ''))).status, 200);
  // Off.
  assert.deepEqual((await coach('DELETE', '/v1/me/calendar-feed')).body, { on: false, created_at: null });
  assert.equal((await req('GET', again.url.replace('https://app.example.org', ''))).status, 404);
  // A made-up secret, and the parent address form, are 404.
  assert.equal((await req('GET', '/cal/staff/not-a-real-secret-at-all-1234.ics')).status, 404);
  assert.equal((await req('GET', `/cal/${again.url.split('/staff/')[1]}`)).status, 404);
  // Front desk doesn't lead sessions and has no feed.
  assert.equal((await desk('POST', '/v1/me/calendar-feed')).status, 403);
});

test('the owner makes a link per coach and hands it over; coaches and front desk can\'t; the feed carries bookable hours with the slots still open', async () => {
  // A link for Riley, made by the owner: Riley's feed, shown once; the owner can see it's on, reset it and turn it off.
  assert.deepEqual((await owner('GET', `/v1/coaches/${riley.id}/calendar-feed`)).body, { on: false, created_at: null, coach_id: riley.id, coach_name: 'Riley Brooks', role: 'coach' });
  const made = (await owner('POST', `/v1/coaches/${riley.id}/calendar-feed`)).body;
  assert.equal(made.coach_name, 'Riley Brooks'); assert.match(made.url, /\/cal\/staff\/[\w-]{32}\.ics$/);
  const feed = await req('GET', made.url.replace('https://app.example.org', ''));
  assert.equal(feed.status, 200); assert.match(feed.text, /X-WR-CALNAME:Diamond Protocol: Riley Brooks/); assert.match(feed.text, /Speed class/); assert.doesNotMatch(feed.text, /Evaluation day/);
  assert.equal((await owner('GET', `/v1/coaches/${riley.id}/calendar-feed`)).body.on, true);
  assert.equal((await coach('GET', '/v1/me/calendar-feed')).body.on, true, 'Riley sees the owner made one');
  // Only the owner: a coach can't make another coach's link, front desk can't look; an unknown or front-desk id is 404.
  const owners = (await owner('GET', '/v1/coaches')).body.data, me = owners.find((c) => c.name === 'Owner');
  assert.equal((await coach('POST', `/v1/coaches/${me.id}/calendar-feed`)).status, 403);
  assert.equal((await desk('GET', `/v1/coaches/${riley.id}/calendar-feed`)).status, 403);
  assert.equal((await owner('POST', '/v1/coaches/usr_nobody/calendar-feed')).status, 404);
  // Bookable hours in the feed: Riley's 3 to 7 pm privates one weekday (four 60-minute slots) show as free time with the open
  // count and the Book now link. The weekday is the one four days out, so it is never the Speed class's (two days out),
  // which would block one of the slots, and never today's, whose earlier slots are already past.
  const hoursDay = new Date(dayFromNow(4) + 'T12:00:00Z').getUTCDay();
  assert.equal((await owner('POST', '/v1/availability', { kind: 'private', location_id: facility.id, weekdays: [hoursDay], start_time: '15:00', end_time: '19:00', slot_minutes: 60, price_cents: 8000, coach_id: riley.id })).status, 201);
  const withHours = (await req('GET', made.url.replace('https://app.example.org', ''))).text;
  assert.match(withHours, /SUMMARY:Open for privates: 4 of 4 slots open/);
  assert.match(withHours, /TRANSP:TRANSPARENT/);
  assert.match(withHours, /Book now page: https:\/\/app\.example\.org\/book/);
  assert.match(withHours, /60-minute privates with Riley Brooks/);
  assert.equal((withHours.match(/Open for privates/g) || []).length, 13, 'one entry per week over the next 92 days (days 4, 11, … 88)');
  // A family books one of the slots: that day says 3 of 4 open, and the booking itself is a session in the feed.
  const ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2012-04-03', parent: { name: 'Maria Lopez', email: 'maria@example.com' }, send_welcome: false })).body;
  const slots = (await owner('GET', '/v1/slots?kind=private&days=14')).body.data.filter((s) => s.coach_id === riley.id);
  assert.ok(slots.length >= 4);
  const booked = await owner('POST', '/v1/slots/book', { client_id: ava.id, kind: 'private', starts_at: slots[0].starts_at, availability_id: slots[0].availability_id, pay: 'cash' });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const after = (await req('GET', made.url.replace('https://app.example.org', ''))).text;
  assert.match(after, /SUMMARY:Open for privates: 3 of 4 slots open/);
  assert.equal((after.match(/Open for privates: 4 of 4/g) || []).length, 12);
  // The owner's feed carries everyone's hours; a day off takes that day's hours out.
  const ownerMade = (await owner('POST', '/v1/me/calendar-feed')).body;
  const all = (await req('GET', ownerMade.url.replace('https://app.example.org', ''))).text;
  assert.equal((all.match(/Open for privates/g) || []).length, 13);
  const firstDay = slots[0].starts_at.slice(0, 10);
  assert.equal((await owner('POST', '/v1/time-off', { user_id: riley.id, start_date: firstDay, end_date: firstDay, note: 'Away' })).status, 201);
  assert.equal(((await req('GET', made.url.replace('https://app.example.org', ''))).text.match(/Open for privates/g) || []).length, 12);
  // Off, by the owner.
  assert.equal((await owner('DELETE', `/v1/coaches/${riley.id}/calendar-feed`)).body.on, false);
  assert.equal((await req('GET', made.url.replace('https://app.example.org', ''))).status, 404);
});

test('a version 83 database gains the calendar columns on users, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v83-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v83.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 83');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 95, `round ${round}`);
      const cols = d.all('PRAGMA table_info(users)').map((c) => c.name);
      assert.ok(cols.includes('calendar_token_hash') && cols.includes('calendar_created_at'));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
