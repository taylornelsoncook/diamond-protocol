// Class colours and descriptions (schema 85): a new class or one-off session is given the least-used colour of the
// palette on its own, the owner can change it, a class's sessions carry its colour and description (the one-off's
// are its own), the portal and Book now carry the description, and a version 84 database colours what it has.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { openDb, CLASS_PALETTE } from '../src/db.js';

let app, base, owner, facility;
const PW = 'correct-horse-battery';
async function req(method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text, res: r };
}
const dayFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@x.test', name: 'Owner', password: PW, role: 'owner' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const cookie = (await req('POST', '/auth/login', { email: 'owner@x.test', password: PW })).res.headers.get('set-cookie').split(';')[0];
  owner = (m, p, b) => req(m, p, b, { cookie });
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
});
after(() => app.server.close());

test('a new class is given the least-used palette colour; the owner can change it; its sessions carry colour and description', async () => {
  const a = (await owner('POST', '/v1/class-series', { name: 'Speed', kind: 'group', location_id: facility.id, weekdays: [1, 3], start_time: '17:00', duration_min: 60, capacity: 12, start_date: dayFromNow(1), description: 'Acceleration and top speed for ages 10 to 14.' })).body;
  assert.equal(a.color, CLASS_PALETTE[0]);
  const b = (await owner('POST', '/v1/class-series', { name: 'Strength', kind: 'group', location_id: facility.id, weekdays: [2], start_time: '18:00', duration_min: 60, capacity: 12, start_date: dayFromNow(1) })).body;
  assert.equal(b.color, CLASS_PALETTE[1], 'the next class takes the next unused colour');
  const list = (await owner('GET', '/v1/class-series')).body;
  assert.deepEqual(list.palette, CLASS_PALETTE);
  assert.equal(list.data.find((x) => x.id === a.id).color, CLASS_PALETTE[0]);
  // Sessions carry the class's colour and description.
  const sched = (await owner('GET', `/v1/schedule?from=${new Date().toISOString()}&to=${new Date(Date.now() + 14 * 86400000).toISOString()}&project=true`)).body;
  const sess = sched.data.find((x) => x.series_id === a.id);
  assert.equal(sess.color, CLASS_PALETTE[0]); assert.equal(sess.description, 'Acceleration and top speed for ages 10 to 14.');
  // A class session can't be given its own colour or description.
  assert.equal((await owner('PATCH', `/v1/sessions/${sess.id}`, { color: '#ff0000' })).status, 400);
  assert.equal((await owner('PATCH', `/v1/sessions/${sess.id}`, { description: 'other' })).status, 400);
  // The owner changes the class's colour; a bad colour is refused; sessions follow.
  assert.equal((await owner('PATCH', `/v1/class-series/${a.id}`, { color: 'blue' })).status, 400);
  assert.equal((await owner('PATCH', `/v1/class-series/${a.id}`, { color: '#AB12CD' })).body.color, '#ab12cd');
  const again = (await owner('GET', `/v1/sessions/${sess.id}`)).body;
  assert.equal(again.color, '#ab12cd');
  // Projected classes past the horizon carry them too.
  const far = (await owner('GET', `/v1/schedule?from=${new Date(Date.now() + 60 * 86400000).toISOString()}&to=${new Date(Date.now() + 70 * 86400000).toISOString()}&project=true`)).body;
  const p = far.projected.find((x) => x.series_id === a.id);
  assert.ok(p); assert.equal(p.color, '#ab12cd'); assert.match(p.description, /Acceleration/);
});

test('a one-off session gets its own colour and description, changeable on the session; the portal and Book now carry the description', async () => {
  const one = (await owner('POST', '/v1/sessions', { name: 'Makeup clinic', kind: 'clinic', location_id: facility.id, date: dayFromNow(2), start_time: '09:00', duration_min: 60, capacity: 8, drop_in_cents: 2500, description: 'A one-time clinic on landing mechanics.' })).body;
  assert.ok(CLASS_PALETTE.includes(one.color), `picked ${one.color}`);
  assert.notEqual(one.color, CLASS_PALETTE[1], 'a colour already in use is passed over while an unused one is left');
  assert.equal(one.description, 'A one-time clinic on landing mechanics.');
  const changed = (await owner('PATCH', `/v1/sessions/${one.id}`, { color: '#123456', description: 'Updated.' })).body;
  assert.deepEqual(changed.changed.sort(), ['color', 'description']);
  const got = (await owner('GET', `/v1/sessions/${one.id}`)).body;
  assert.equal(got.color, '#123456'); assert.equal(got.description, 'Updated.');
  assert.equal((await owner('POST', '/v1/sessions', { name: 'Bad', kind: 'clinic', location_id: facility.id, date: dayFromNow(2), start_time: '10:00', color: 'red' })).status, 400);
  // Book now (public) shows the description and colour.
  const pub = (await req('GET', '/portal/api/public/schedule')).body;
  const row = pub.classes.find((x) => x.id === one.id);
  assert.equal(row.description, 'Updated.'); assert.equal(row.color, '#123456');
  assert.match(pub.classes.find((x) => x.name === 'Speed').description, /Acceleration/);
});

test('a version 84 database colours its classes and upcoming one-off sessions, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v84-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v84.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 84');
    old.exec(`INSERT INTO locations (id, name, kind, created_at) VALUES ('loc_1', 'Gym', 'facility', '2026-01-01T00:00:00.000Z')`);
    const ins = old.prepare(`INSERT INTO class_series (id, name, kind, location_id, weekdays, start_time, duration_min, capacity, start_date, active, created_at) VALUES (?, ?, 'group', 'loc_1', '[1]', '17:00', 60, 12, '2026-01-01', ?, ?)`);
    ins.run('cs_1', 'Speed', 1, '2026-01-01T00:00:00.000Z'); ins.run('cs_2', 'Strength', 1, '2026-01-02T00:00:00.000Z'); ins.run('cs_3', 'Old', 0, '2025-01-01T00:00:00.000Z');
    old.prepare(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES ('cls_1', NULL, 'Clinic', 'clinic', 'loc_1', '2099-01-01T15:00:00.000Z', '2099-01-01T16:00:00.000Z', 8, 'scheduled', '2026-01-01T00:00:00.000Z')`).run();
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 93, `round ${round}`);
      assert.deepEqual(d.all('SELECT id, color FROM class_series ORDER BY id').map((r) => [r.id, r.color]), [['cs_1', CLASS_PALETTE[0]], ['cs_2', CLASS_PALETTE[1]], ['cs_3', CLASS_PALETTE[2]]]);
      assert.equal(d.get(`SELECT color FROM class_sessions WHERE id = 'cls_1'`).color, CLASS_PALETTE[3]);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
