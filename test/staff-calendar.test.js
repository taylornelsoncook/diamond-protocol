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

test('a version 83 database gains the calendar columns on users, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v83-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v83.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 83');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 88, `round ${round}`);
      const cols = d.all('PRAGMA table_info(users)').map((c) => c.name);
      assert.ok(cols.includes('calendar_token_hash') && cols.includes('calendar_created_at'));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
