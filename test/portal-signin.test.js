// One portal for parents and athletes (schema 60): an email on file signs in as the parent it belongs to, the athlete
// whose own address it is, or both; an emailed code always works and a password is optional.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { resetSignInLocks, LOCK_WRONG_CODES } from '../src/services/families.js';
import { resetRateLimits } from '../src/services/security.js';
import { sha256 } from '../src/util.js';

let app, base, ownerCookie;
const req = async (method, path, body, headers = {}) => {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})), res };
};
const owner = (m, p, b) => req(m, p, b, { cookie: ownerCookie });
const as = (cookie) => (m, p, b, extra = {}) => req(m, p, b, { cookie, ...extra });
const cookieOf = (r) => r.res.headers.get('set-cookie').split(';')[0];
const outbox = () => app.ctx.db.all('SELECT * FROM outbox ORDER BY created_at DESC, rowid DESC');
const signIn = async (email) => {
  app.ctx.db.run('DELETE FROM login_codes');                      // the 3-codes-in-10-minutes limit is tested in families.test.js
  const code = (await req('POST', '/portal/api/login', { email })).body.dev_code;
  assert.ok(code, `${email} gets a code`);
  const v = await req('POST', '/portal/api/verify', { email, code });
  assert.equal(v.status, 200);
  return { cookie: cookieOf(v), body: v.body };
};

let ava, sam, maria;

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  ownerCookie = cookieOf(await req('POST', '/auth/login', { email: 'owner@test.dev', password: 'correct-horse-battery' }));
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2012-03-10', parent: { name: 'Maria Lopez', email: 'maria@example.com', phone: '555-0100' } })).body;
  maria = ava.family.guardians[0];
  sam = (await owner('POST', '/v1/clients', { name: 'Sam Adult', email: 'sam@example.com', birth_date: '1995-01-01' })).body;
  assert.ok(sam.id, 'an adult athlete with their own email');
});
after(() => app.server.close());

test('the portal page opens at /portal and /parent', async () => {
  for (const p of ['/portal', '/parent', '/portal/']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  assert.equal((await fetch(base + '/portal/api/session')).status, 401);
});

test('an athlete with their own email signs in with a code and lands in the app; the family routes are for parents', async () => {
  const { cookie, body } = await signIn('sam@example.com');
  assert.equal(body.kind, 'athlete');
  assert.equal(body.athlete.name, 'Sam Adult');
  assert.equal(body.guardian, null);
  const me = as(cookie);
  const s = (await me('GET', '/portal/api/session')).body;
  assert.deepEqual([s.kind, s.first_name, s.has_password, s.athlete.id, s.athlete.app_link, s.parent], ['athlete', 'Sam', false, sam.id, '/app', null]);
  const fam = await me('GET', '/portal/api/me');
  assert.equal(fam.status, 401);
  assert.equal(fam.body.error.code, 'parents_only');
  // The athlete app opens on the same cookie, with no private link.
  const home = await me('GET', '/app/api/home');
  assert.equal(home.status, 200);
  assert.equal(home.body.client.id, sam.id);
  assert.equal((await req('GET', '/app/api/home')).status, 401, 'no cookie, no link: nothing');
  assert.equal((await req('GET', '/app/api/home')).body.error.message.includes('/portal'), true);
  // A write from another site with the cookie is refused; from this site it goes through.
  const foreign = await me('POST', '/app/api/messages', { body: 'hi coach' }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const own = await me('POST', '/app/api/messages', { body: 'hi coach' }, { origin: base });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  // Devices and sign-out work for an athlete too.
  assert.equal((await me('GET', '/portal/api/devices')).body.data.length, 1);
  assert.equal((await me('POST', '/portal/api/logout', {})).status, 200);
  assert.equal((await me('GET', '/app/api/home')).status, 401, 'signed out');
});

test('a password is optional: set inside the portal, checked at sign-in, same answer for every wrong try, removable', async () => {
  const { cookie } = await signIn('sam@example.com');
  const me = as(cookie);
  assert.equal((await me('POST', '/portal/api/password', { password: 'short' })).status, 400);
  assert.equal((await me('POST', '/portal/api/password', { password: 'aaaaaaaaaaaa' })).status, 400, 'too easy');
  const set = await me('POST', '/portal/api/password', { password: 'tall stack of pancakes' });
  assert.equal(set.status, 200);
  assert.equal(set.body.has_password, true);
  const mail = outbox().find((m) => m.to_email === 'sam@example.com' && /password was set/.test(m.subject));
  assert.ok(mail, 'the address is told a password was set');
  assert.equal((await me('GET', '/portal/api/session')).body.has_password, true);
  // Sign in with it.
  const wrong = await req('POST', '/portal/api/login/password', { email: 'sam@example.com', password: 'tall stack of waffles' });
  const nobody = await req('POST', '/portal/api/login/password', { email: 'nobody@example.com', password: 'tall stack of pancakes' });
  const noPw = await req('POST', '/portal/api/login/password', { email: 'maria@example.com', password: 'tall stack of pancakes' });
  for (const r of [wrong, nobody, noPw]) { assert.equal(r.status, 401); assert.equal(r.body.error.message, wrong.body.error.message, 'one answer for a wrong password, no password and no account'); }
  assert.equal((await req('POST', '/portal/api/login/password', { email: 'sam@example.com', password: '' })).status, 401, 'an empty password never matches');
  const ok = await req('POST', '/portal/api/login/password', { email: 'SAM@example.com', password: 'tall stack of pancakes' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.kind, 'athlete');
  const viaPw = as(cookieOf(ok));
  assert.equal((await viaPw('GET', '/app/api/home')).body.client.id, sam.id);
  assert.equal((await viaPw('GET', '/portal/api/devices')).body.data.length, 2, 'both sign-ins are listed');
  // Change it (the email says changed), then remove it: codes keep working throughout.
  const changed = await viaPw('POST', '/portal/api/password', { password: 'a different long phrase' });
  assert.equal(changed.status, 200);
  assert.ok(outbox().find((m) => m.to_email === 'sam@example.com' && /password was changed/.test(m.subject)));
  assert.equal((await req('POST', '/portal/api/login/password', { email: 'sam@example.com', password: 'tall stack of pancakes' })).status, 401);
  assert.equal((await req('POST', '/portal/api/login/password', { email: 'sam@example.com', password: 'a different long phrase' })).status, 200);
  assert.equal((await viaPw('DELETE', '/portal/api/password')).body.has_password, false);
  assert.equal((await req('POST', '/portal/api/login/password', { email: 'sam@example.com', password: 'a different long phrase' })).status, 401);
  assert.ok((await signIn('sam@example.com')).cookie, 'codes still work');
});

test('wrong passwords and wrong codes share the hourly lock for an email', async () => {
  resetSignInLocks();
  for (let i = 0; i < LOCK_WRONG_CODES; i++) assert.equal((await req('POST', '/portal/api/login/password', { email: 'nobody@example.com', password: `guess ${i} is long enough` })).status, 401);
  const locked = await req('POST', '/portal/api/login/password', { email: 'nobody@example.com', password: 'guess again please' });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'signin_locked');
  assert.equal((await req('POST', '/portal/api/verify', { email: 'nobody@example.com', code: '123456' })).status, 429, 'codes are locked too');
  assert.equal((await req('POST', '/portal/api/login/password', { email: 'sam@example.com', password: 'guess again please' })).status, 401, 'other emails are not');
  resetSignInLocks();
  resetRateLimits();
});

test('parents sign in as before, can set a password, and see the family', async () => {
  const { cookie, body } = await signIn('maria@example.com');
  assert.equal(body.kind, 'parent');
  assert.equal(body.guardian.id, maria.id);
  const me = as(cookie);
  const s = (await me('GET', '/portal/api/session')).body;
  assert.deepEqual([s.kind, s.athlete, s.parent.id], ['parent', null, maria.id]);
  assert.equal((await me('GET', '/portal/api/me')).status, 200);
  assert.equal((await me('GET', '/app/api/home')).status, 401, 'a parent alone has no workouts of their own');
  assert.equal((await me('POST', '/portal/api/password', { password: 'maria likes long walks' })).status, 200);
  const pw = await req('POST', '/portal/api/login/password', { email: 'maria@example.com', password: 'maria likes long walks' });
  assert.equal(pw.status, 200);
  assert.equal(pw.body.kind, 'parent');
  assert.equal((await as(cookieOf(pw))('GET', '/portal/api/me')).body.athletes[0].name, 'Ava Lopez');
  const others = await me('POST', '/portal/api/devices/sign-out-others', {});
  assert.equal(others.body.signed_out, 1);
  assert.equal((await as(cookieOf(pw))('GET', '/portal/api/me')).status, 401);
});

test('one email that is both a parent and an athlete gets both: the family portal and the app on one cookie', async () => {
  // Staff never make this through the API (a parent's email is refused for a new client); it comes from older data or
  // an adult who trains here and pays for a child. Set up straight in the database.
  const self = (await owner('POST', '/v1/clients', { name: 'Maria Lopez', email: 'maria.self@example.com', birth_date: '1985-05-05' })).body;
  app.ctx.db.run('UPDATE clients SET email = ? WHERE id = ?', 'maria@example.com', self.id);
  const { cookie, body } = await signIn('maria@example.com');
  assert.equal(body.kind, 'both');
  assert.equal(body.athlete.id, self.id);
  const me = as(cookie);
  assert.equal((await me('GET', '/portal/api/session')).body.kind, 'both');
  assert.equal((await me('GET', '/portal/api/me')).status, 200);
  assert.equal((await me('GET', '/app/api/home')).body.client.id, self.id);
  // One password for the person, checked from either row.
  assert.equal((await me('POST', '/portal/api/password', { password: 'one password for both' })).status, 200);
  assert.equal(app.ctx.db.get('SELECT password_hash FROM clients WHERE id = ?', self.id).password_hash != null, true);
  assert.equal((await req('POST', '/portal/api/login/password', { email: 'maria@example.com', password: 'one password for both' })).body.kind, 'both');
  app.ctx.db.run('UPDATE clients SET email = ? WHERE id = ?', 'maria.self@example.com', self.id);
});

test('an archived athlete can no longer sign in, and a session already open stops working', async () => {
  const { cookie } = await signIn('sam@example.com');
  assert.equal((await owner('POST', `/v1/clients/${sam.id}/archive`, {})).status, 200);
  const r = await req('POST', '/portal/api/login', { email: 'sam@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.dev_code, undefined, 'same answer, no code');
  assert.equal((await req('POST', '/portal/api/verify', { email: 'sam@example.com', code: '123456' })).status, 401);
  assert.equal((await as(cookie)('GET', '/app/api/home')).status, 401);
  assert.equal((await as(cookie)('GET', '/portal/api/session')).status, 401);
  assert.equal((await owner('POST', `/v1/clients/${sam.id}/restore`, {})).status, 200);
});

test('the family export lists devices and passwords by person; deleting the family removes both', async () => {
  const { cookie } = await signIn('maria@example.com');
  assert.equal((await as(cookie)('POST', '/portal/api/password', { password: 'maria likes long walks' })).status, 200);
  const exp = await owner('GET', `/v1/families/${ava.family.id}/export`);
  assert.equal(exp.status, 200);
  const data = JSON.parse(Buffer.from(exp.body.__file?.body ?? '', 'utf8').toString() || await (await fetch(`${base}/v1/families/${ava.family.id}/export`, { headers: { cookie: ownerCookie } })).text());
  assert.ok(data.signed_in_devices.some((d) => d.person === 'Maria Lopez' && d.kind === 'parent'));
  assert.deepEqual(data.sign_in_passwords.map((p) => [p.name, p.kind]), [['Maria Lopez', 'parent']]);
  const del = await owner('DELETE', `/v1/families/${ava.family.id}`, { confirm: 'Lopez family' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM portal_sessions').n, app.ctx.db.get('SELECT COUNT(*) AS n FROM portal_sessions WHERE guardian_id IS NULL').n, 'the parent\'s sessions went with her');
  assert.equal(app.ctx.db.get('SELECT password_hash FROM clients WHERE id = ?', ava.id).password_hash, null);
});

test('a version 59 database is upgraded: a code emailed before the upgrade still signs the parent in', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-portal-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v59.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 59');
    const now = new Date().toISOString(), later = new Date(Date.now() + 9 * 60000).toISOString();
    old.prepare("INSERT INTO families (id, name, created_at) VALUES ('fam_1', 'Old family', ?)").run(now);
    old.prepare("INSERT INTO guardians (id, family_id, name, email, is_primary, created_at) VALUES ('gua_1', 'fam_1', 'Old Parent', 'old@example.com', 1, ?)").run(now);
    old.prepare("INSERT INTO login_codes (id, guardian_id, code_hash, expires_at) VALUES ('lc_1', 'gua_1', ?, ?)").run(sha256('gua_1:424242'), later);
    old.prepare("INSERT INTO portal_sessions (token_hash, guardian_id, expires_at, created_at) VALUES (?, 'gua_1', ?, ?)").run(sha256('dp_fam_oldsession'), later, now);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 67, `round ${round}`);
      assert.ok(d.all('PRAGMA table_info(portal_sessions)').some((c) => c.name === 'client_id'));
      assert.ok(d.all('PRAGMA table_info(login_codes)').some((c) => c.name === 'client_id'));
      for (const t of ['guardians', 'clients']) assert.ok(d.all(`PRAGMA table_info(${t})`).some((c) => c.name === 'password_hash'), t);
      assert.equal(d.get("SELECT guardian_id, client_id FROM login_codes WHERE id = 'lc_1'").guardian_id, 'gua_1', 'rows survive the rebuild');
      assert.equal(d.get('SELECT COUNT(*) AS n FROM portal_sessions').n, 1);
      d.close();
    }
    const upgraded = createApp({ dbFile: file, testMode: true, jobs: false });
    await new Promise((r) => upgraded.server.listen(0, r));
    const b2 = `http://localhost:${upgraded.server.address().port}`;
    try {
      const v = await fetch(`${b2}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'old@example.com', code: '424242' }) });
      assert.equal(v.status, 200, 'the code hashed the old way still works');
      const s = await fetch(`${b2}/portal/api/session`, { headers: { cookie: 'dp_family=dp_fam_oldsession' } });
      assert.equal(s.status, 200, 'a session from before the upgrade is still signed in');
      assert.equal((await s.json()).kind, 'parent');
    } finally { upgraded.server.close(); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
