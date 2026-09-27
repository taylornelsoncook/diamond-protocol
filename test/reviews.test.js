import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { runReviewRequests } from '../src/services/reviews.js';
import { emit } from '../src/services/events.js';
import { newId, localDate, zonedToUtc } from '../src/util.js';

// Google review requests after a 10th session or a personal best.
let app, base, owner, facility, asOf, ava, ben, cal;
const H = 3600000, DAY = 24 * H;
const at = (ms) => new Date(Date.parse(asOf) + ms).toISOString();
const mailTo = (email) => app.ctx.db.all(`SELECT subject, body FROM outbox WHERE to_email = ? AND body LIKE '%/r/%' ORDER BY rowid`, email);   // review asks only

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
// n attended sessions, the last one `lastAgo` before asOf, a day apart.
function attend(client, n, lastAgo) {
  for (let i = 0; i < n; i++) {
    const s = at(-lastAgo - (n - 1 - i) * DAY), id = newId('cls');
    app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Speed', 'group', ?, ?, ?, 10, 'scheduled', ?)`, id, facility.id, s, at(-lastAgo - (n - 1 - i) * DAY + H), s);
    app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'attended', 'membership', ?, ?)`, newId('bkg'), id, client.id, s, s);
  }
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev');
  asOf = zonedToUtc(localDate(app.ctx.now(), 'America/Chicago'), '15:00', 'America/Chicago');   // mid-afternoon
  facility = (await owner('POST', '/v1/locations', { name: 'Facility', kind: 'facility' })).body;
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  cal = (await owner('POST', '/v1/clients', { name: 'Cal Reyes', parent: { name: 'Kim Reyes', email: 'kim@example.com' } })).body;
});
after(() => app.server.close());

test('nothing goes out until the owner adds their Google review link', async () => {
  attend(ava, 10, 2 * DAY);           // 10th session two days ago
  attend(ben, 12, 1 * DAY);           // 10th session was 3 days before that... still this week
  attend(cal, 10, 20 * DAY);          // hit 10 weeks ago: not asked out of the blue
  assert.equal(await runReviewRequests(app.ctx, { asOf }), 0);
  const bad = await owner('PATCH', '/v1/settings', { review_url: 'g.page/r/abc' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /starts with https/);
  assert.equal((await owner('PATCH', '/v1/settings', { review_url: 'https://g.page/r/example/review' })).status, 200);
});

test('families get one friendly ask after a 10th session, at a decent hour', async () => {
  assert.equal(await runReviewRequests(app.ctx, { asOf: at(-9 * H) }), 0, 'not at 6 am');
  assert.equal(await runReviewRequests(app.ctx, { asOf }), 2);
  const [m] = mailTo('maria@example.com');
  assert.equal(m.subject, 'Ava just finished 10 sessions with us');
  assert.match(m.body, /Hi Maria,/);
  assert.match(m.body, /https:\/\/app\.example\.org\/r\/[\w-]+\n/);
  assert.equal(mailTo('dana@example.com').length, 1);
  assert.equal(mailTo('kim@example.com').length, 0);
  assert.equal(await runReviewRequests(app.ctx, { asOf: at(H) }), 0, 'only once');

  // The link counts the click and goes to Google; ?stop=1 stops for good.
  const tok = m.body.match(/\/r\/([\w-]+)\n/)[1];
  const go = await fetch(`${base}/r/${tok}`, { redirect: 'manual' });
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), 'https://g.page/r/example/review');
  const stop = await fetch(`${base}/r/${tok}?stop=1`);
  assert.match(await stop.text(), /won't ask your family for a review again/);
  const summary = (await owner('GET', '/v1/review-requests')).body;
  assert.deepEqual([summary.last_90_days.sent, summary.last_90_days.clicked, summary.last_90_days.stopped], [2, 1, 1]);
  assert.match(summary.sample.text, /quick Google review/);
});

test('a personal best counts once the family can see it', async () => {
  const kid = (await owner('POST', '/v1/clients', { name: 'Dev Shah', parent: { name: 'Raj Shah', email: 'raj@example.com' } })).body;
  const testId = app.ctx.db.get('SELECT id FROM perf_tests LIMIT 1').id;
  const day = newId('ps');
  app.ctx.db.run(`INSERT INTO perf_sessions (id, name, date, created_at) VALUES (?, 'Fall testing', ?, ?)`, day, asOf.slice(0, 10), asOf);
  app.ctx.db.run(`INSERT INTO perf_results (id, session_id, client_id, test_id, metric, value, source, recorded_at, created_at) VALUES (?, ?, ?, ?, 'time', 4.9, 'manual', ?, ?)`, newId('pr'), day, kid.id, testId, asOf, asOf);
  emit(app.ctx, 'performance.pr', { client_id: kid.id, test_name: '40-yard dash' });
  assert.equal(await runReviewRequests(app.ctx, { asOf }), 0, 'the testing day isn\'t shared yet');
  app.ctx.db.run('UPDATE perf_sessions SET shared_at = ? WHERE id = ?', at(-H), day);
  assert.equal(await runReviewRequests(app.ctx, { asOf }), 1);
  assert.equal(mailTo('raj@example.com')[0].subject, 'Dev just set a new personal best in the 40-yard dash');
});

test('families asking to be deleted are left alone, and owners can turn asks off', async () => {
  const kid = (await owner('POST', '/v1/clients', { name: 'Eli Moss', parent: { name: 'Jo Moss', email: 'jo@example.com' } })).body;
  attend(kid, 10, DAY);
  const fam = app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', kid.id).family_id;
  app.ctx.db.run(`INSERT INTO data_requests (id, family_id, family_name, requested_by, kind, status, created_at) VALUES (?, ?, 'Moss family', 'Jo', 'delete', 'open', ?)`, newId('dr'), fam, asOf);
  assert.equal(await runReviewRequests(app.ctx, { asOf }), 0);
  await owner('PATCH', '/v1/settings', { review_requests: 'off' });
  app.ctx.db.run(`UPDATE data_requests SET status = 'done' WHERE family_id = ?`, fam);
  assert.equal(await runReviewRequests(app.ctx, { asOf }), 0, 'turned off');
  await owner('PATCH', '/v1/settings', { review_requests: 'on' });
  assert.equal(await runReviewRequests(app.ctx, { asOf }), 1);
});

test('front desk can see review requests on the Leads tab but not change the link', async () => {
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  const desk = await signIn('desk@test.dev');
  assert.equal((await desk('GET', '/v1/review-requests')).status, 200);
  assert.equal((await desk('PATCH', '/v1/settings', { review_url: '' })).status, 403);
});
