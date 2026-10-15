// The sales page for a program sold online (version 72): the owner's pitch, coach and free trial; the public page; a trial
// that is charged when it ends (or closed after three declines); the app asking a bought athlete about their gear.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';

const PW = 'correct-horse-battery';
const NOW = '2026-10-12T15:00:00.000Z';
let app, base, owner, coach, desk, maria, dana, ava, ben, kai, remote, coachUser;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const staff = async (email) => as((await req('POST', '/auth/login', { email, password: PW })).cookie);
const parent = async (email) => { const { body } = await req('POST', '/portal/api/login', { email }); return as((await req('POST', '/portal/api/verify', { email, code: body.dev_code })).cookie); };
const appOf = (c) => (method, path, body) => req(method, path, body, { 'x-client-token': c.app_link.split('token=')[1] });
const mails = (to, like) => app.ctx.db.all('SELECT subject, body FROM outbox WHERE to_email = ? AND subject LIKE ? ORDER BY created_at', to, like);
const runTrials = () => app.ctx.jobs.runJob(app.ctx.jobs.byName('program-trials'), { force: true });

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  app.ctx.now = () => NOW;
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: PW });
  coachUser = createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley Coach', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana Desk', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  for (const c of [ava, ben]) c.family_id = app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', c.id).family_id;
  kai = (await owner('POST', '/v1/clients', { name: 'Kai Park', family_id: ben.family_id })).body;
  remote = (await coach('POST', '/v1/programs', { name: 'Remote speed', weeks: 2, level: 'All levels', description: 'Speed from anywhere.' })).body;
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', video_url: 'https://videos.example.org/back-squat.mp4', equipment: ['barbell'] })).body;
  const jump = (await coach('POST', '/v1/exercises', { name: 'Broad jump' })).body;
  for (const [week, day, title] of [[1, 1, 'Acceleration'], [1, 3, 'Top speed'], [2, 1, 'Acceleration 2'], [2, 3, 'Top speed 2']]) {
    const w = (await coach('POST', `/v1/programs/${remote.id}/workouts`, { week, day, title })).body;
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: squat.id, sets: 3, reps: '5' });
    await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: jump.id, sets: 3, reps: '3' });
  }
  await coach('POST', `/v1/programs/${remote.id}/phases`, { kind: 'base', start_week: 1, end_week: 2 });
  maria = await parent('maria@example.com'); dana = await parent('dana@example.com');
});
after(() => app.server.close());

test('a version 71 database gains the sales page columns and keeps its purchases', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-sales-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v71.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 71');
    old.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'o@x.dev', 'O', 'x', 'owner', '2026-01-01T00:00:00Z');
      INSERT INTO families (id, name, created_at) VALUES ('fam1', 'Lopez', '2026-01-01T00:00:00Z');
      INSERT INTO clients (id, name, family_id, access_token, created_at) VALUES ('c1', 'Ava Lopez', 'fam1', 'tok1', '2026-01-01T00:00:00Z');
      INSERT INTO programs (id, name, weeks, created_at, for_sale, price_cents) VALUES ('p1', 'Speed', 4, '2026-01-01T00:00:00Z', 1, 4900);
      INSERT INTO purchases (id, client_id, item_kind, item_id, title, amount_cents, status, created_at) VALUES ('b1', 'c1', 'program', 'p1', 'Speed', 4900, 'active', '2026-02-01T00:00:00Z');`);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 82, `round ${round}`);
      const b = d.get('SELECT * FROM purchases WHERE id = ?', 'b1');
      assert.deepEqual([b.status, b.amount_cents, b.charge_tries, b.trial_ends_at], ['active', 4900, 0, null]);
      assert.deepEqual(d.get('SELECT pitch, coach_id, trial_days FROM programs WHERE id = ?', 'p1'), { pitch: null, coach_id: null, trial_days: 0 });
      assert.deepEqual(d.get('SELECT title, bio, photo_url FROM users WHERE id = ?', 'u1'), { title: null, bio: null, photo_url: null });
      d.run(`INSERT INTO purchases (id, client_id, item_kind, item_id, title, amount_cents, status, trial_ends_at, created_at) VALUES ('b2', 'c1', 'program', 'p1', 'Speed', 4900, 'trial', '2026-03-01T00:00:00Z', '2026-02-22T00:00:00Z')`);
      d.run(`DELETE FROM purchases WHERE id = 'b2'`);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('the owner writes the pitch, picks the coach and sets a trial; staff get a title, bio and photo', async () => {
  assert.equal((await coach('PATCH', `/v1/staff/${coachUser.id}`, { bio: 'x' })).status, 403, 'staff edits are the owner\'s');
  const bad = await owner('PATCH', `/v1/staff/${coachUser.id}`, { photo_url: 'http://example.org/riley.gif' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /https/);
  const u = (await owner('PATCH', `/v1/staff/${coachUser.id}`, { title: 'Head speed coach', bio: 'Sprint mechanics first, then strength.\n\nTen years coaching high school athletes.', photo_url: 'https://cdn.example.org/riley.jpg' })).body;
  assert.deepEqual([u.title, u.photo_url, u.bio.startsWith('Sprint')], ['Head speed coach', 'https://cdn.example.org/riley.jpg', true]);
  assert.equal((await owner('PUT', `/v1/shop/programs/${remote.id}`, { for_sale: true, price_cents: 4900, trial_days: 31 })).status, 400, 'a trial is at most 30 days');
  const deskUser = app.ctx.db.get(`SELECT id FROM users WHERE role = 'front_desk'`);
  assert.equal((await owner('PUT', `/v1/shop/programs/${remote.id}`, { for_sale: true, price_cents: 4900, coach_id: deskUser.id })).status, 400, 'front desk is not a coach on the page');
  const r = (await owner('PUT', `/v1/shop/programs/${remote.id}`, { for_sale: true, price_cents: 4900, trial_days: 7, coach_id: coachUser.id, pitch: 'For athletes who train on their own.\n\nTwo weeks that build.' })).body;
  assert.deepEqual([r.listed, r.trial_days, r.coach.name, r.coach.title, r.pitch.includes('build')], [true, 7, 'Riley Coach', 'Head speed coach', true]);
  const course = (await coach('POST', '/v1/courses', { title: 'Mental game' })).body;
  assert.equal((await owner('PUT', `/v1/shop/courses/${course.id}`, { for_sale: false, trial_days: 7 })).status, 400, 'trials are for programs');
  // The coach's account turned off: the page shows nobody rather than a coach who left.
  assert.equal((await owner('PATCH', `/v1/staff/${coachUser.id}`, { active: false })).status, 200);
  assert.equal((await req('GET', `/portal/api/public/shop/${remote.id}`)).body.program.coach, null);
  assert.equal((await owner('PATCH', `/v1/staff/${coachUser.id}`, { active: true })).status, 200);
  coach = await staff('coach@test.dev');   // turning the account off signed them out
});

test('the public page shows the program, the coach and the trial, and nothing private', async () => {
  const page = await fetch(`${base}/shop/${remote.id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /shop-program\.js/);
  const d = (await req('GET', `/portal/api/public/shop/${remote.id}`)).body;
  const p = d.program;
  assert.deepEqual([p.title, p.price_cents, p.trial_days, p.weeks, p.workouts, p.per_week, p.exercises, p.videos], ['Remote speed', 4900, 7, 2, 4, 2, 2, 1]);
  assert.deepEqual(p.weeks_outline.map((w) => [w.week, w.phase, w.workouts.length]), [[1, 'Base', 2], [2, 'Base', 2]]);
  assert.deepEqual(p.coach, { id: coachUser.id, name: 'Riley Coach', title: 'Head speed coach', bio: 'Sprint mechanics first, then strength.\n\nTen years coaching high school athletes.', photo_url: 'https://cdn.example.org/riley.jpg' });
  const text = JSON.stringify(d);
  assert.ok(!text.includes('coach@test.dev') && !text.includes('Ava') && !text.includes('password'), 'no emails, athletes or secrets');
  const store = (await req('GET', '/portal/api/public/shop')).body;
  assert.equal(store.items.find((x) => x.id === remote.id).trial_days, 7);
  const other = (await coach('POST', '/v1/programs', { name: 'Private plan' })).body;
  assert.equal((await req('GET', `/portal/api/public/shop/${other.id}`)).status, 404, 'only programs in the store');
});

test('a family starts the free trial with a card on file, the app opens, and the trial can be ended before it is charged', async () => {
  const avaApp = appOf(ava);
  assert.equal((await avaApp('GET', '/app/api/home')).body.locked, true);
  assert.equal((await maria('POST', '/portal/api/shop/buy', { kind: 'program', item_id: remote.id, athlete_id: ava.id })).status, 409, 'a card is needed even for a trial');
  await maria('POST', '/portal/api/card/test');
  const r = await maria('POST', '/portal/api/shop/buy', { kind: 'program', item_id: remote.id, athlete_id: ava.id });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.trial, r.body.purchase.status, r.body.purchase.trial_ends_at, r.body.sale_id], [true, 'trial', '2026-10-19T15:00:00.000Z', undefined]);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM sales WHERE client_id = ?', ava.id).n, 0, 'nothing charged');
  const home = (await avaApp('GET', '/app/api/home')).body;
  assert.deepEqual([home.locked, home.program.name, home.workout.title, home.startup.ask_gear, home.startup.needed], [false, 'Remote speed', 'Acceleration', true, false]);
  const mail = mails('maria@example.com', '%free trial%')[0];
  assert.match(mail.body, /October 19/);
  assert.match(mail.body, /\$49/);
  const fam = (await maria('GET', '/portal/api/shop')).body;
  assert.deepEqual(fam.owned.map((o) => [o.item_id, o.status, o.trial_ends_at]), [[remote.id, 'trial', '2026-10-19T15:00:00.000Z']]);
  assert.equal((await maria('POST', '/portal/api/shop/buy', { kind: 'program', item_id: remote.id, athlete_id: ava.id })).status, 409, 'already on the trial');
  // The athlete answers the gear questions: the calendar takes their training days.
  const ans = await avaApp('PUT', '/app/api/startup', { trains_at: 'home', equipment: [], days_per_week: 3, training_days: [1, 4, 6] });
  assert.equal(ans.status, 200);
  assert.equal(ans.body.placed.outcome, 'coach', 'already on a program: never moved');
  assert.deepEqual((await owner('GET', `/v1/clients/${ava.id}/training-calendar`)).body.training_days, [1, 4, 6]);
  const after = (await avaApp('GET', '/app/api/home')).body;
  assert.deepEqual([after.startup.ask_gear, !!after.startup.profile], [false, true]);
  // Ending the trial: the program closes, nothing is owed, and the purchase can't be ended twice.
  const purchase = fam.owned[0];
  assert.equal((await dana('DELETE', `/portal/api/purchases/${purchase.id}`)).status, 404, 'another family can\'t');
  const end = await maria('DELETE', `/portal/api/purchases/${purchase.id}`);
  assert.deepEqual([end.status, end.body.status], [200, 'canceled']);
  assert.equal((await avaApp('GET', '/app/api/home')).body.locked, true);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM assignments WHERE client_id = ? AND active = 1', ava.id).n, 0);
  assert.equal((await maria('DELETE', `/portal/api/purchases/${purchase.id}`)).status, 409);
  // Buying again: no second trial, the card is charged now.
  const again = await maria('POST', '/portal/api/shop/buy', { kind: 'program', item_id: remote.id, athlete_id: ava.id });
  assert.deepEqual([again.status, again.body.purchase.status, !!again.body.sale_id], [201, 'active', true]);
  assert.equal((await avaApp('GET', '/app/api/home')).body.locked, false);
  assert.equal((await maria('DELETE', `/portal/api/purchases/${again.body.purchase.id}`)).status, 409, 'a paid purchase isn\'t ended here');
  const exp = (await owner('GET', `/v1/families/${ava.family_id}/export`)).body;
  assert.ok(JSON.stringify(exp.athletes ?? exp).includes('trial_ends_at'));
});

test('when a trial ends the job charges the card; three declines close the program and tell the family and the owners', async () => {
  await dana('POST', '/portal/api/card/test');
  const benApp = appOf(ben), kaiApp = appOf(kai);
  const benBuy = await dana('POST', '/portal/api/shop/buy', { kind: 'program', item_id: remote.id, athlete_id: ben.id });
  assert.equal(benBuy.body.trial, true, JSON.stringify(benBuy.body));
  assert.equal((await dana('POST', '/portal/api/shop/buy', { kind: 'program', item_id: remote.id, athlete_id: kai.id })).body.trial, true);
  assert.equal((await runTrials()).status, 'ok');
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM purchases WHERE status = 'trial' AND client_id IN (?, ?)`, ben.id, kai.id).n, 2, 'not due yet');
  // Day 8: Ben's trial is charged. Kai's family card has started declining.
  app.ctx.db.run(`UPDATE purchases SET trial_ends_at = '2026-10-19T15:00:00.000Z' WHERE client_id IN (?, ?)`, ben.id, kai.id);
  app.ctx.now = () => '2026-10-19T16:00:00.000Z';
  const r1 = await runTrials();
  assert.equal(r1.status, 'ok');
  const benRow = app.ctx.db.get('SELECT status, sale_id, charge_tries FROM purchases WHERE client_id = ?', ben.id);
  assert.deepEqual([benRow.status, !!benRow.sale_id, benRow.charge_tries], ['active', true, 1]);
  const sale = (await owner('GET', `/v1/sales/${benRow.sale_id}`)).body;
  assert.deepEqual([sale.status, sale.amount_cents, sale.method], ['succeeded', 4900, 'card_on_file']);
  assert.equal(mails('dana@example.com', '%is paid for%').length, 2, 'Ben and Kai');
  const kaiRow = () => app.ctx.db.get('SELECT status, charge_tries, last_try_at FROM purchases WHERE client_id = ?', kai.id);
  assert.deepEqual([kaiRow().status, kaiRow().charge_tries], ['active', 1], 'same card, same family: Kai paid too');
  // A declining card: a fresh trial for Ben on another program.
  const secondRes = await coach('POST', '/v1/programs', { name: 'Remote strength', weeks: 1 });
  assert.equal(secondRes.status, 201, JSON.stringify(secondRes.body));
  const second = secondRes.body;
  const w = (await coach('POST', `/v1/programs/${second.id}/workouts`, { week: 1, day: 1, title: 'Lift' })).body;
  await coach('POST', `/v1/workouts/${w.id}/exercises`, { exercise_id: app.ctx.db.get(`SELECT id FROM exercises WHERE name = 'Back squat'`).id, sets: 3, reps: '5' });
  await owner('PUT', `/v1/shop/programs/${second.id}`, { for_sale: true, price_cents: 2900, trial_days: 3 });
  const t = await dana('POST', '/portal/api/shop/buy', { kind: 'program', item_id: second.id, athlete_id: ben.id });
  assert.equal(t.body.trial, true, JSON.stringify(t.body));
  assert.equal((await benApp('GET', '/app/api/home')).body.program.name, 'Remote strength');
  app.ctx.db.run(`UPDATE families SET card_status = 'declining' WHERE id = ?`, ben.family_id);
  app.ctx.db.run(`UPDATE clients SET card_status = 'declining' WHERE family_id = ?`, ben.family_id);
  app.ctx.now = () => '2026-10-22T17:00:00.000Z';
  await runTrials();
  const row = () => app.ctx.db.get('SELECT status, charge_tries FROM purchases WHERE id = ?', t.body.purchase.id);
  assert.deepEqual([row().status, row().charge_tries], ['trial', 1]);
  assert.equal(mails('dana@example.com', "%couldn't charge your card%").length, 1);
  await runTrials();
  assert.equal(row().charge_tries, 1, 'once a day, not every hour');
  app.ctx.now = () => '2026-10-23T17:00:00.000Z';
  await runTrials();
  assert.equal(row().charge_tries, 2);
  assert.equal((await benApp('GET', '/app/api/home')).body.program.name, 'Remote strength', 'still open while we retry');
  app.ctx.now = () => '2026-10-24T17:00:00.000Z';
  await runTrials();
  assert.deepEqual([row().status, row().charge_tries], ['canceled', 3]);
  assert.equal((await benApp('GET', '/app/api/home')).body.program ?? null, null, 'the program closed');
  assert.equal(mails('dana@example.com', '%has closed%').length, 1);
  assert.equal(mails('owner@test.dev', '%ended unpaid%').length, 1);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) AS n FROM sales WHERE client_id = ? AND status = ?', ben.id, 'succeeded').n, 1, 'nothing charged for the second program');
  assert.equal((await kaiApp('GET', '/app/api/home')).body.locked, false, 'Kai keeps the paid program');
  assert.equal((await desk('GET', '/v1/shop')).status, 403);
});
