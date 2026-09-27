import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { writeXlsx } from '../src/services/xlsx.js';
import { resetRateLimits } from '../src/services/security.js';

let app, base, owner;
const year = String(new Date().getFullYear());
const call = async (method, path, body, cookie) => {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), cookie: res.headers.get('set-cookie')?.split(';')[0], headers: res.headers };
};
const outbox = async () => (await call('GET', '/v1/outbox', null, owner)).body.data;
const mailTo = async (email, re) => (await outbox()).find((m) => m.to_email === email && re.test(m.subject));

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.com' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'owner-password-1' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = (await call('POST', '/auth/login', { email: 'owner@test.dev', password: 'owner-password-1' })).cookie;
});
after(() => app.server.close());

const family = { parent: { name: 'Kim Reyes', email: 'kim@example.com', phone: '555-0144' }, athletes: [
  { name: 'Leo Reyes', birth_date: '2012-05-04', sex: 'M', sport: 'Football', medical_notes: 'Peanut allergy', emergency_name: 'Tia Reyes', emergency_phone: '555-0150' },
  { name: 'Mila Reyes', birth_date: '2015-11-20', sport: 'Soccer' }], accept_terms: true };
let kim, kimCookie;

test('families sign themselves up: details, agree, confirm email, signed in', async () => {
  assert.equal((await call('POST', '/portal/api/signup', { ...family, accept_terms: false })).status, 400);
  assert.match((await call('POST', '/portal/api/signup', { ...family, athletes: [{ name: 'X', birth_date: '2099-01-01' }] })).body.error.message, /real birthday/);
  const start = (await call('POST', '/portal/api/signup', family)).body;
  assert.match(start.dev_code, /^\d{6}$/);
  assert.ok((await mailTo('kim@example.com', /sign-up code/)).body.includes(start.dev_code));
  assert.equal((await call('POST', '/portal/api/signup/verify', { signup_id: start.signup_id, code: '000000' === start.dev_code ? '111111' : '000000' })).status, 401);
  const done = await call('POST', '/portal/api/signup/verify', { signup_id: start.signup_id, code: start.dev_code });
  assert.equal(done.status, 200);
  kimCookie = done.cookie;
  assert.ok(kimCookie.startsWith('dp_family='), 'signed straight in');
  assert.equal((await call('POST', '/portal/api/signup/verify', { signup_id: start.signup_id, code: start.dev_code })).status, 401, 'a code works once');
  const me = (await call('GET', '/portal/api/me', null, kimCookie)).body;
  assert.deepEqual(me.athletes.map((a) => [a.name, a.athlete_id]).sort(), [['Leo Reyes', `LEOREY${year}`], ['Mila Reyes', `MILREY${year}`]]);
  assert.equal(me.athletes.find((a) => a.name === 'Leo Reyes').medical_notes, 'Peanut allergy');
  assert.equal(me.family.waiver.signed, false, 'the waiver is still signed in the portal');
  kim = me;
  const welcome = await mailTo('kim@example.com', /^Welcome to/);
  assert.ok(welcome.body.includes('Your family account is ready') && welcome.body.includes('https://app.example.com/parent') && welcome.body.includes(`LEOREY${year}`));
  const events = (await call('GET', '/v1/events?limit=20', null, owner)).body.data;
  assert.ok(events.some((e) => e.type === 'family.signed_up'));
});

test('sign-up never reveals who already has an account, and can be closed', async () => {
  const again = await call('POST', '/portal/api/signup', family);
  assert.equal(again.status, 200);
  assert.equal(again.body.dev_code, undefined);
  assert.equal(again.body.message, 'Check your email for a 6-digit code to finish signing up.');
  assert.ok(await mailTo('kim@example.com', /already have/), 'the real owner of the email is told instead');
  const bot = (await call('POST', '/portal/api/signup', { ...family, parent: { ...family.parent, email: 'bot@example.com' }, website: 'http://spam' })).body;
  assert.equal(bot.dev_code, undefined, 'the hidden field catches bots');
  await call('PATCH', '/v1/settings', { public_signup: 'off' }, owner);
  const closed = await call('POST', '/portal/api/signup', { ...family, parent: { ...family.parent, email: 'new@example.com' } });
  assert.deepEqual([closed.status, closed.body.error.code], [403, 'signup_closed']);
  assert.equal((await call('GET', '/portal/api/public/info')).body.open, false);
  await call('PATCH', '/v1/settings', { public_signup: 'on' }, owner);
  resetRateLimits();
});

test('publishing terms or privacy asks every parent to accept before booking or buying', async () => {
  const legal0 = (await call('GET', '/portal/api/public/legal')).body;
  assert.equal(legal0.terms.published, false, 'placeholders are not published');
  await call('PATCH', '/v1/settings', { terms_text: 'Terms of service\n\nReal wording from the lawyer.', privacy_text: 'Privacy policy\n\nWhat we collect and why.' }, owner);
  const legal1 = (await call('GET', '/portal/api/public/legal')).body;
  assert.deepEqual([legal1.terms.published, legal1.terms.version, legal1.privacy.version], [true, 2, 2]);
  const me = (await call('GET', '/portal/api/me', null, kimCookie)).body;
  assert.deepEqual(me.agreements.needs, ['terms', 'privacy']);
  const blocked = await call('POST', '/portal/api/purchase', { product_id: 'x', athlete_id: kim.athletes[0].id }, kimCookie);
  assert.deepEqual([blocked.status, blocked.body.error.code], [409, 'agreements_required']);
  assert.equal((await call('POST', '/portal/api/agreements', { accept: false }, kimCookie)).status, 400);
  const ok = (await call('POST', '/portal/api/agreements', { accept: true }, kimCookie)).body;
  assert.equal(ok.ok, true);
  const record = (await call('GET', `/v1/families/${kim.family.id}/agreements`, null, owner)).body.data;
  assert.ok(record.some((c) => c.kind === 'terms' && c.version === 2 && c.accepted_by === 'Kim Reyes <kim@example.com>'));
  // New sign-ups accept the current versions as part of signing up.
  const s = (await call('POST', '/portal/api/signup', { parent: { name: 'Ana Cruz', email: 'ana@example.com' }, athletes: [{ name: 'Nico Cruz', birth_date: '2011-01-01' }], accept_terms: true })).body;
  const c = (await call('POST', '/portal/api/signup/verify', { signup_id: s.signup_id, code: s.dev_code })).cookie;
  assert.equal((await call('GET', '/portal/api/me', null, c)).body.agreements.ok, true);
});

test('parents download their data and can ask for it to be deleted; the owner decides', async () => {
  const file = await call('GET', '/portal/api/export', null, kimCookie);
  assert.match(file.headers.get('content-disposition'), /family-data-\d{4}-\d{2}-\d{2}\.json/);
  const data = file.body;
  assert.equal(data.parents[0].email, 'kim@example.com');
  assert.deepEqual(data.athletes.map((a) => a.name).sort(), ['Leo Reyes', 'Mila Reyes']);
  assert.ok(data.agreements.length >= 2 && Array.isArray(data.athletes[0].test_results) && Array.isArray(data.athletes[0].purchases));
  const req = (await call('POST', '/portal/api/deletion-request', { note: 'Moving away' }, kimCookie)).body;
  assert.equal(req.status, 'open');
  assert.equal((await call('POST', '/portal/api/deletion-request', {}, kimCookie)).status, 409);
  assert.ok(await mailTo('owner@test.dev', /Deletion request/));
  assert.ok((await call('GET', '/v1/dashboard', null, owner)).body.attention.some((a) => a.kind === 'deletion_request' && a.family_name === 'Reyes family'));
  assert.equal((await call('DELETE', `/v1/families/${kim.family.id}`, { confirm: 'wrong' }, owner)).status, 400);
  const del = (await call('DELETE', `/v1/families/${kim.family.id}`, { confirm: 'reyes family', request_id: req.id }, owner)).body;
  assert.deepEqual([del.deleted, del.athletes, del.parents], [true, 2, 1]);
  assert.equal((await call('GET', '/portal/api/me', null, kimCookie)).status, 401, 'signed out: the parent account is gone');
  const leo = (await call('GET', `/v1/clients/${kim.athletes.find((a) => a.name === 'Leo Reyes').id}`, null, owner)).body;
  assert.deepEqual([leo.name, leo.athlete_id, leo.medical_notes, leo.birth_date], ['Deleted athlete', null, null, null]);
  assert.equal((await call('GET', '/v1/data-requests?status=open', null, owner)).body.data.length, 0);
  assert.ok(await mailTo('kim@example.com', /has been deleted/));
});

let preview;
test('importing clients: every problem listed first, nothing saved until the sheet is clean', async () => {
  const tpl = await call('GET', '/v1/client-import/template', null, owner);
  assert.match(tpl.headers.get('content-disposition'), /client-import-template\.xlsx/);
  const header = ['Athlete first name', 'Athlete last name', 'Birthday (YYYY-MM-DD)', 'Sex (M/F)', 'Sport', 'Athlete email (adults paying for themselves)', 'Parent name', 'Parent email', 'Parent phone', 'Second parent name', 'Second parent email', 'Medical notes'];
  const bad = [header,
    ['Sam', 'Ortiz', '03/14/2012', 'm', 'Baseball', '', 'Rosa Ortiz', 'rosa@example.com', '', '', '', ''],
    ['', '', '', '', '', '', 'Nobody', 'x@example.com', '', '', '', ''],
    ['Tia', 'Ortiz', '2031-01-01', 'X', '', '', 'Rosa Ortiz', 'rosa@example.com', '', '', '', ''],
    ['Jo', 'Park', '', '', '', 'not-an-email', '', '', '', '', '', ''],
    ['Nico', 'Cruz', '2011-01-01', '', '', '', '', 'ana@example.com', '', '', '', '']];
  const b = (await call('POST', '/v1/client-import/preview', { xlsx_base64: writeXlsx([{ name: 'Clients', rows: bad }]).toString('base64') }, owner)).body;
  assert.equal(b.ok, false);
  const m = b.errors.map((e) => `${e.row}|${e.message}`);
  for (const re of [/^3\|Missing the athlete's name/, /^4\|"2031-01-01" isn't a birthday/, /^4\|Sex should be M or F/, /^5\|"not-an-email" isn't an email/, /^6\|Nico Cruz \(born 2011-01-01\) is already a client/]) assert.ok(m.some((x) => re.test(x)), `${re}\n${m.join('\n')}`);
  const before = (await call('GET', '/v1/clients', null, owner)).body.data.length;
  assert.equal((await call('POST', '/v1/client-import/commit', { preview_id: b.preview_id }, owner)).status, 409);
  assert.equal((await call('GET', '/v1/clients', null, owner)).body.data.length, before, 'nothing imported');

  const good = [header,
    ['Sam', 'Ortiz', '03/14/2012', 'm', 'Baseball', '', 'Rosa Ortiz', 'rosa@example.com', '555-0161', 'Luis Ortiz', 'luis@example.com', 'Wears glasses'],
    ['Tia', 'Ortiz', '2015-08-02', 'F', 'Softball', '', 'Rosa Ortiz', 'rosa@example.com', '', '', '', ''],
    ['Pablo', 'Cruz', '2014-02-02', '', '', '', '', 'ana@example.com', '', '', '', ''],
    ['Grace', 'Kim', '1990-07-07', 'F', '', 'grace@example.com', '', '', '', '', '', '']];
  preview = (await call('POST', '/v1/client-import/preview', { xlsx_base64: writeXlsx([{ name: 'Clients', rows: good }]).toString('base64'), filename: 'clients.xlsx' }, owner)).body;
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.deepEqual(preview.summary, { athletes: 4, new_families: 1, existing_families: 1, adults: 1 });
  assert.deepEqual(preview.athletes.map((a) => a.athlete_id), [`SAMORT${year}`, `TIAORT${year}`, `PABCRU${year}`, `GRAKIM${year}`], 'exact IDs, shown before anything is saved');
  const ortiz = preview.families.find((f) => f.status === 'new');
  assert.deepEqual([ortiz.name, ortiz.parents.map((p) => p.email), ortiz.athletes.length], ['Ortiz family', ['rosa@example.com', 'luis@example.com'], 2]);
  assert.equal((await call('GET', '/v1/clients', null, owner)).body.data.length, before, 'the preview saved nothing');
});

test('the import saves everything at once and can email new families their sign-in', async () => {
  const done = (await call('POST', '/v1/client-import/commit', { preview_id: preview.preview_id, send_welcome: true }, owner)).body;
  assert.deepEqual([done.imported, done.invited], [4, 2]);
  assert.deepEqual(done.athletes.map((a) => a.athlete_id), preview.athletes.map((a) => a.athlete_id), 'the IDs in the preview are the IDs you get');
  const sam = (await call('GET', `/v1/clients/${done.athletes[0].client_id}`, null, owner)).body;
  assert.deepEqual([sam.birth_date, sam.sex, sam.medical_notes, sam.family.guardians.length], ['2012-03-14', 'M', 'Wears glasses', 2]);
  const pablo = (await call('GET', `/v1/clients/${done.athletes[2].client_id}`, null, owner)).body;
  assert.equal(pablo.family.name, 'Cruz family', 'added to the existing family');
  assert.ok(await mailTo('rosa@example.com', /^Welcome to/));
  assert.ok((await mailTo('grace@example.com', /^Welcome to/)).body.includes('/app?token='));
  assert.equal(await mailTo('ana@example.com', /^Welcome to .*$/).then((m) => (m?.body.includes('set up your family account') ? 'second welcome' : 'none')), 'none', 'existing families aren\'t welcomed again');
  assert.equal((await call('POST', '/v1/client-import/commit', { preview_id: preview.preview_id }, owner)).status, 404, 'an import saves once');
});

test('receipts, trial reminders and failed-payment emails; each can be turned off', async () => {
  const loc = (await call('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' }, owner)).body;
  const pack = (await call('POST', '/v1/products', { name: '5 privates', kind: 'pack', sessions: 5, price_cents: 40000 }, owner)).body;
  const grace = (await call('GET', '/v1/clients?q=grace', null, owner)).body.data[0];
  await call('POST', `/v1/clients/${grace.id}/card/test`, null, owner);
  await call('POST', '/v1/sales', { location_id: loc.id, method: 'card_on_file', client_id: grace.id, items: [{ product_id: pack.id }] }, owner);
  const receipt = await mailTo('grace@example.com', /^Receipt from .*\$400/);
  assert.ok(receipt.body.includes('5 privates') && receipt.body.includes('card ending 4242') && receipt.body.includes('Facility'));
  // Trial ending in 2 days, no card: a reminder once.
  const plan = (await call('POST', '/v1/plans', { name: 'Monthly', price_cents: 14900, trial_days: 5 }, owner)).body;
  const tia = (await call('GET', '/v1/clients?q=tia', null, owner)).body.data[0];
  await call('POST', `/v1/clients/${tia.id}/subscription`, { plan_id: plan.id }, owner);
  const in3 = new Date(Date.now() + 3 * 86400000).toISOString();
  assert.equal((await call('POST', '/v1/billing/run', { as_of: in3 }, owner)).body.trial_reminders, 1);
  const trial = await mailTo('rosa@example.com', /free trial ends/);
  assert.ok(trial.body.includes('no card on file') && trial.body.includes('/parent'));
  assert.equal((await call('POST', '/v1/billing/run', { as_of: in3 }, owner)).body.trial_reminders, 0, 'only once');
  // The family adds a card, but it declines when the trial ends: both parents hear about it.
  await call('POST', `/v1/clients/${tia.id}/card/test`, null, owner);
  await call('PATCH', `/v1/clients/${tia.id}`, { card_status: 'declining' }, owner);
  await call('POST', '/v1/billing/run', { as_of: new Date(Date.now() + 6 * 86400000).toISOString() }, owner);
  for (const who of ['rosa@example.com', 'luis@example.com']) {
    const failed = await mailTo(who, /Payment didn't go through/);
    assert.ok(failed && /update the card in the parent portal/i.test(failed.body) && failed.body.includes('/pay/') && failed.body.includes('try again on'), who);
  }
  // Turn receipts off.
  await call('PATCH', '/v1/settings', { emails_off: ['receipts'] }, owner);
  const n = (await outbox()).length;
  await call('POST', '/v1/sales', { location_id: loc.id, method: 'cash', client_id: grace.id, custom: { description: 'Water', amount_cents: 200 } }, owner);
  assert.equal((await outbox()).length, n, 'no receipt when turned off');
  assert.equal((await call('PATCH', '/v1/settings', { emails_off: ['nonsense'] }, owner)).status, 400);
});
