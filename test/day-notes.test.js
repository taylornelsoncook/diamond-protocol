// The day's note (owner's ask, schema 92: "one line that is copied across every session, and another line that is
// specific to that day"): a class's description is the same on every session; day_notes gives each weekday its own line
// ("Mon/Tue Acceleration, Wed/Thu Agility, Friday Max velocity"), and one session can carry its own line over it.
// Families see both in the portal and on Book now.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { openDb } from '../src/db.js';
import { weekdayOf } from '../src/util.js';

let app, base, owner, facility;
const PW = 'correct-horse-battery';
async function req(method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text, cookie: r.headers.get('set-cookie')?.split(';')[0] ?? null };
}
const dayFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const range = (from, to) => `from=${new Date(Date.now() + from * 86400000).toISOString()}&to=${new Date(Date.now() + to * 86400000).toISOString()}`;
before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@x.test', name: 'Owner', password: PW, role: 'owner' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const cookie = (await req('POST', '/auth/login', { email: 'owner@x.test', password: PW })).cookie;
  owner = (m, p, b) => req(m, p, b, { cookie });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

test('a class has one description for every session and a note per weekday; each session shows the note for its day', async () => {
  const c = (await owner('POST', '/v1/class-series', { name: 'Elite Lacrosse', kind: 'group', location_id: facility.id, weekdays: [1, 2, 3, 4, 5], start_time: '16:00', duration_min: 80, capacity: 20, start_date: dayFromNow(1),
    description: 'Speed and agility for the elite player.', day_notes: { 1: 'Acceleration', 2: ' Acceleration ', 3: 'Agility', 4: 'Agility', 5: 'Max velocity', 0: '' } })).body;
  assert.deepEqual(c.day_notes, { 1: 'Acceleration', 2: 'Acceleration', 3: 'Agility', 4: 'Agility', 5: 'Max velocity' }, 'trimmed, empty days dropped');
  assert.deepEqual((await owner('GET', '/v1/class-series')).body.data.find((x) => x.id === c.id).day_notes, c.day_notes);
  const sched = (await owner('GET', `/v1/schedule?${range(0, 14)}`)).body.data.filter((x) => x.series_id === c.id);
  assert.ok(sched.length >= 5);
  for (const s of sched) {
    assert.equal(s.description, 'Speed and agility for the elite player.', 'the same line on every session');
    assert.equal(s.day_note, c.day_notes[String(weekdayOf(s.starts_at.slice(0, 10)))] ?? s.day_note, 'the weekday\'s line');
  }
  assert.ok(sched.some((s) => s.day_note === 'Acceleration') && sched.some((s) => s.day_note === 'Agility') && sched.some((s) => s.day_note === 'Max velocity'));
  // Projected classes past the horizon carry the weekday's note too.
  const far = (await owner('GET', `/v1/schedule?${range(60, 70)}&project=true`)).body.projected.filter((x) => x.series_id === c.id);
  assert.ok(far.length && far.every((p) => p.day_note === c.day_notes[String(weekdayOf(p.date))]));
  // Changing the class's notes changes every session at once; null clears them.
  const upd = (await owner('PATCH', `/v1/class-series/${c.id}`, { day_notes: { 1: 'Starts', 3: 'Cuts' } })).body;
  assert.deepEqual(upd.day_notes, { 1: 'Starts', 3: 'Cuts' });
  const again = (await owner('GET', `/v1/schedule?${range(0, 14)}`)).body.data.filter((x) => x.series_id === c.id);
  const monday = again.find((s) => weekdayOf(s.starts_at.slice(0, 10)) === 1), friday = again.find((s) => weekdayOf(s.starts_at.slice(0, 10)) === 5);
  assert.equal(monday.day_note, 'Starts'); assert.equal(friday.day_note, null, 'a day with no note has none');
  // Other edits leave the notes alone.
  assert.deepEqual((await owner('PATCH', `/v1/class-series/${c.id}`, { capacity: 22 })).body.day_notes, { 1: 'Starts', 3: 'Cuts' });
  assert.deepEqual((await owner('PATCH', `/v1/class-series/${c.id}`, { day_notes: null })).body.day_notes, {});
  assert.equal((await owner('GET', `/v1/sessions/${monday.id}`)).body.day_note, null);
  // Checks.
  assert.equal((await owner('PATCH', `/v1/class-series/${c.id}`, { day_notes: ['Monday'] })).status, 400);
  assert.equal((await owner('PATCH', `/v1/class-series/${c.id}`, { day_notes: { 7: 'x' } })).status, 400);
  assert.equal((await owner('PATCH', `/v1/class-series/${c.id}`, { day_notes: { 1: 'x'.repeat(301) } })).status, 400);
  await owner('PATCH', `/v1/class-series/${c.id}`, { day_notes: { 1: 'Acceleration', 2: 'Acceleration', 3: 'Agility', 4: 'Agility', 5: 'Max velocity' } });
});

test('one session has its own line over the class\'s; a one-off session has its own; families and Book now see both lines', async () => {
  const c = (await owner('GET', '/v1/class-series')).body.data.find((x) => x.name === 'Elite Lacrosse');
  const sched = (await owner('GET', `/v1/schedule?${range(0, 14)}`)).body.data.filter((x) => x.series_id === c.id);
  const monday = sched.find((s) => weekdayOf(s.starts_at.slice(0, 10)) === 1);
  const r = await owner('PATCH', `/v1/sessions/${monday.id}`, { day_note: 'Testing day: 10 and 40 yard times' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.changed, ['note for the day']);
  const got = (await owner('GET', `/v1/sessions/${monday.id}`)).body;
  assert.equal(got.day_note, 'Testing day: 10 and 40 yard times'); assert.equal(got.own_day_note, 'Testing day: 10 and 40 yard times');
  assert.equal(got.description, 'Speed and agility for the elite player.', 'the class\'s description stays');
  const other = sched.find((s) => s.id !== monday.id && weekdayOf(s.starts_at.slice(0, 10)) === 1);
  if (other) assert.equal((await owner('GET', `/v1/sessions/${other.id}`)).body.day_note, 'Acceleration', 'the other Mondays keep the class\'s line');
  assert.equal((await owner('PATCH', `/v1/sessions/${monday.id}`, { day_note: 'Testing day: 10 and 40 yard times' })).status, 400, 'nothing to change');
  assert.equal((await owner('PATCH', `/v1/sessions/${monday.id}`, { day_note: 'x'.repeat(301) })).status, 400);
  // A one-off session: its own description and its own line.
  const one = (await owner('POST', '/v1/sessions', { name: 'Makeup clinic', kind: 'clinic', location_id: facility.id, date: dayFromNow(2), start_time: '09:00', duration_min: 60, capacity: 8, drop_in_cents: 2500, description: 'A one-time clinic.', day_note: 'Landing mechanics' })).body;
  assert.equal(one.day_note, 'Landing mechanics');
  // Book now (public) and the portal carry both lines.
  const pub = (await req('GET', '/portal/api/public/schedule')).body;
  assert.equal(pub.classes.find((x) => x.id === monday.id).day_note, 'Testing day: 10 and 40 yard times');
  assert.equal(pub.classes.find((x) => x.id === one.id).day_note, 'Landing mechanics');
  const ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2012-04-03', parent: { name: 'Maria Lopez', email: 'maria@example.com' }, send_welcome: false })).body;
  const code = (await req('POST', '/portal/api/login', { email: 'maria@example.com' })).body.dev_code;
  const cookie = (await req('POST', '/portal/api/verify', { email: 'maria@example.com', code })).cookie;
  const parent = (m, p, b) => req(m, p, b, { cookie });
  const rows = (await parent('GET', '/portal/api/schedule')).body.data;
  const row = rows.find((x) => x.id === monday.id);
  assert.equal(row.description, 'Speed and agility for the elite player.'); assert.equal(row.day_note, 'Testing day: 10 and 40 yard times');
  assert.equal(rows.find((x) => x.id === other?.id)?.day_note ?? 'Acceleration', 'Acceleration');
  // Booked: the family's upcoming row says what that day works on.
  const booked = await owner('POST', `/v1/sessions/${monday.id}/bookings`, { client_id: ava.id });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const me = (await parent('GET', '/portal/api/me')).body;
  assert.equal(me.athletes[0].upcoming.find((u) => u.session_id === monday.id).day_note, 'Testing day: 10 and 40 yard times');
  // Taking the session's own line off puts the class's back.
  assert.deepEqual((await owner('PATCH', `/v1/sessions/${monday.id}`, { day_note: null })).body.changed, ['note for the day']);
  assert.equal((await owner('GET', `/v1/sessions/${monday.id}`)).body.day_note, 'Acceleration');
});

test('the version 91 upgrade adds the day note columns', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v91-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v91.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 91');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 92, `round ${round}`);
      assert.ok(d.all('PRAGMA table_info(class_series)').some((c) => c.name === 'day_notes'));
      assert.ok(d.all('PRAGMA table_info(class_sessions)').some((c) => c.name === 'day_note'));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
