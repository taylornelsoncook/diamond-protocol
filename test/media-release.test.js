import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';

// The photo, video and media release (version 97): the owner publishes the wording, a parent ticks per athlete which
// public uses they allow, coaches read the choices on the client page, and a withdrawal takes every public use back.
let app, base, owner, coach, maria, ava, theo;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
async function parentFor(email) {
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json()).dev_code;
  const ver = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
  const cookie = ver.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org', mail: { from: 'Diamond Protocol <hello@example.org>' } });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev');
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  theo = (await owner('POST', '/v1/clients', { name: 'Theo Jensen', parent: { name: 'Kurt Jensen', email: 'kurt@example.com' } })).body;
  maria = await parentFor('maria@example.com');
});
after(() => app.server.close());

test('until the owner publishes the wording there is no release: the portal says so and nothing can be signed', async () => {
  const r = (await maria('GET', '/portal/api/media-release')).body;
  assert.deepEqual([r.published, r.text, r.choices.length, r.athletes.length], [false, null, 8, 1]);
  assert.deepEqual([r.athletes[0].signed, r.athletes[0].choices, r.athletes[0].summary], [false, [], 'Coaching use only']);
  const s = await maria('POST', `/portal/api/athletes/${ava.id}/media-release`, { choices: ['social'], signed_name: 'Maria Lopez', agree: true });
  assert.equal(s.status, 409); assert.equal(s.body.error.code, 'media_release_unpublished');
  assert.equal((await coach('GET', `/v1/clients/${ava.id}`)).body.media.published, false);
  assert.equal((await (await fetch(`${base}/portal/api/public/legal`)).json()).media_release.published, false);
  const d = (await owner('GET', '/v1/legal/drafts')).body;
  assert.match(d.media_release, /^Diamond Protocol PHOTO, VIDEO AND MEDIA RELEASE/);
  assert.match(d.media_release, /hello@example\.org/);
  assert.doesNotMatch(d.media_release, /\{\{/);
});

test('the owner publishes the draft; a parent ticks the uses for one athlete; coaches read them; a withdrawal takes them back', async () => {
  const draft = (await owner('GET', '/v1/legal/drafts')).body.media_release;
  const saved = await owner('PATCH', '/v1/settings', { media_release_text: draft });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.media_release_version, saved.body.media_release_text.startsWith('Diamond Protocol PHOTO')], ['2', true]);
  let r = (await maria('GET', '/portal/api/media-release')).body;
  assert.deepEqual([r.published, r.version, r.text.startsWith('Diamond Protocol PHOTO'), r.choices.map((c) => c.key)], [true, 2, true, ['social', 'first_name', 'full_name', 'school_team', 'advertising', 'testimonials', 'livestream', 'press']]);
  // Refusals: the wrong name, no agreement, a choice that isn't one, another family's athlete.
  const path = `/portal/api/athletes/${ava.id}/media-release`;
  assert.equal((await maria('POST', path, { choices: ['social'], signed_name: 'M Lopez', agree: true })).status, 400);
  assert.equal((await maria('POST', path, { choices: ['social'], signed_name: 'Maria Lopez' })).status, 400);
  assert.equal((await maria('POST', path, { choices: ['billboards'], signed_name: 'Maria Lopez', agree: true })).status, 400);
  assert.equal((await maria('POST', path, { choices: 'social', signed_name: 'Maria Lopez', agree: true })).status, 400);
  assert.equal((await maria('POST', `/portal/api/athletes/${theo.id}/media-release`, { choices: ['social'], signed_name: 'Maria Lopez', agree: true })).status, 404, 'not her athlete');
  // The signature: two uses allowed, in the release's own order whatever order they were sent in.
  const s = await maria('POST', path, { choices: ['first_name', 'social', 'social'], signed_name: 'maria  lopez', agree: true });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual([s.body.choices, s.body.summary, s.body.signed, s.body.current, s.body.version, s.body.signed_by], [['social', 'first_name'], 'Social media and website, First name with posts', true, true, 2, 'Maria Lopez <maria@example.com>']);
  const row = app.ctx.db.get('SELECT * FROM media_releases WHERE client_id = ?', ava.id);
  assert.ok(row.ip, 'the network address is kept as evidence');
  assert.ok(app.ctx.db.get(`SELECT 1 FROM events WHERE type = 'family.media_release_signed'`));
  // Coaches (and the owner) see the choices on the client page; the portal's athlete card carries them too.
  const c = (await coach('GET', `/v1/clients/${ava.id}`)).body;
  assert.deepEqual([c.media.summary, c.media.current], ['Social media and website, First name with posts', true]);
  assert.deepEqual((await maria('GET', '/portal/api/me')).body.athletes[0].media.choices, ['social', 'first_name']);
  // In the family export, as words.
  const ex = (await owner('GET', `/v1/families/${c.family.id}/export`)).body;
  assert.deepEqual(ex.athletes[0].media_release[0].choices, ['Social media and website', 'First name with posts']);
  // A change to the wording bumps the version: the choices stand, marked as signed under earlier wording.
  await owner('PATCH', '/v1/settings', { media_release_text: draft + '\nAmended.' });
  r = (await maria('GET', '/portal/api/media-release')).body;
  assert.deepEqual([r.version, r.athletes[0].choices, r.athletes[0].current], [3, ['social', 'first_name'], false]);
  // Withdraw: coaching use only from now on; the row keeps what was allowed.
  const w = await maria('DELETE', path);
  assert.deepEqual([w.status, w.body.choices, w.body.summary, !!w.body.withdrawn_at], [200, [], 'Coaching use only', true]);
  assert.equal((await coach('GET', `/v1/clients/${ava.id}`)).body.media.summary, 'Coaching use only');
  assert.deepEqual((await maria('DELETE', path)).body.choices, [], 'withdrawing twice changes nothing');
  const ex2 = (await owner('GET', `/v1/families/${c.family.id}/export`)).body;
  assert.ok(ex2.athletes[0].media_release[0].withdrawn_at);
  // Signing with nothing ticked is allowed: it records the decision for coaching use only, under the current wording.
  const none = await maria('POST', path, { choices: [], signed_name: 'Maria Lopez', agree: true });
  assert.deepEqual([none.status, none.body.choices, none.body.signed, none.body.current, none.body.withdrawn_at], [200, [], true, true, null]);
  // Deleting the family removes the rows.
  await owner('DELETE', `/v1/families/${c.family.id}`, { confirm: c.family.name });
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM media_releases WHERE client_id = ?', ava.id).n, 0);
});

test('a version 96 database gains the media release table, opened twice', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-media-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v96.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 96');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 97, `round ${round}`);
      assert.ok(d.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_releases'`));
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
