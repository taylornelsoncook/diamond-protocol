import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';

// The drafted legal wording (docs/legal) for the owner to fill the Settings boxes from, and "sign once": the waiver
// signature also records acceptance of the published terms and privacy policy.
let app, base, owner, coach, parentCookie, familyId;
const PW = 'correct-horse-battery';
async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const parent = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { cookie: parentCookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org', mail: { from: 'Diamond Protocol <hello@example.org>' } });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Taylor', password: PW, role: 'owner' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev');
  await owner('PATCH', '/v1/settings', { business_name: 'Diamond Protocol', business_address: '123 Main St, Parker, CO 80134', late_cancel_hours: 12 });
  const ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  familyId = app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', ava.id).family_id;
  app.ctx.db.run('DELETE FROM login_codes');
  const code = (await (await fetch(`${base}/portal/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com' }) })).json()).dev_code;
  const ver = await fetch(`${base}/portal/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com', code }) });
  parentCookie = ver.headers.get('set-cookie').split(';')[0];
});
after(() => app.server.close());

test('the owner gets the four drafts with the business filled in; coaches do not', async () => {
  const r = await owner('GET', '/v1/legal/drafts');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const k of ['waiver', 'terms', 'privacy', 'card_consent']) assert.ok(r.body[k].length > 500, k);
  assert.match(r.body.waiver, /^Diamond Protocol PARTICIPATION AGREEMENT/);
  assert.match(r.body.waiver, /C\.R\.S\. § 13-22-107/, 'the Colorado parental release');
  assert.match(r.body.waiver, /Jake Snakenberg/, 'the concussion act');
  assert.match(r.body.waiver, /hello@example\.org/, 'the contact email from the sending address');
  assert.match(r.body.terms, /14 days/);
  assert.match(r.body.terms, /five years/);
  assert.match(r.body.terms, /at least 12 hours before/, 'the late-cancel window from settings');
  assert.match(r.body.terms, /https:\/\/app\.example\.org\/terms/);
  assert.match(r.body.privacy, /never sell/);
  assert.match(r.body.privacy, /123 Main St, Parker, CO 80134/);
  assert.doesNotMatch(r.body.waiver + r.body.terms + r.body.privacy, /\{\{/, 'every placeholder filled');
  assert.equal((await coach('GET', '/v1/legal/drafts')).status, 403);
  // The drafts don't publish anything on their own.
  const docs = await (await fetch(`${base}/portal/api/public/legal`)).json();
  assert.equal(docs.terms.published, false);
});

test('signing the waiver once also accepts the published terms and privacy policy', async () => {
  const drafts = (await owner('GET', '/v1/legal/drafts')).body;
  await owner('PATCH', '/v1/settings', { waiver_text: drafts.waiver, terms_text: drafts.terms, privacy_text: drafts.privacy });
  let me = (await parent('GET', '/portal/api/me')).body;
  assert.deepEqual([me.family.waiver.signed, me.agreements.ok], [false, false]);
  const signed = await parent('POST', '/portal/api/waiver', { signed_name: 'Maria Lopez', agree: true });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.signed, true);
  assert.equal(signed.body.agreements.ok, true);
  me = (await parent('GET', '/portal/api/me')).body;
  assert.deepEqual([me.family.waiver.signed, me.agreements.ok, me.agreements.needs], [true, true, []]);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM consents WHERE family_id = ?', familyId).n, 2, 'terms and privacy recorded');
  // A changed terms text asks again, through the usual Updated terms panel; the waiver stays signed.
  await owner('PATCH', '/v1/settings', { terms_text: drafts.terms + '\n\nAn added line.' });
  me = (await parent('GET', '/portal/api/me')).body;
  assert.deepEqual([me.family.waiver.signed, me.agreements.needs], [true, ['terms']]);
});
