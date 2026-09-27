// Programs and courses sold online: owner pricing, the public store, buying with the family card, access in the app,
// locked courses, and a refund ending access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';

let app, base, owner, coach, maria, ava, speed, mind, lessonIds;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email) => as((await req('POST', '/auth/login', { email, password: 'correct-horse-battery' })).cookie);
const athlete = (method, path, body) => req(method, path, body, { 'x-client-token': ava.app_link.split('token=')[1] });

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Owner', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery', role: 'coach' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev');
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  speed = (await coach('POST', '/v1/programs', { name: 'Summer speed', weeks: 6, level: 'All levels', description: 'Six weeks of sprint work.' })).body;
  const ex = (await coach('POST', '/v1/exercises', { name: 'Wall drill' })).body;
  for (const [day, title] of [[1, 'Acceleration'], [2, 'Top speed']]) {
    const w = (await coach('POST', `/v1/programs/${speed.id}/workouts`, { week: 1, day, title })).body;
    await coach('POST', `/v1/workouts/${w.id ?? w.workouts?.at(-1)?.id}/exercises`, { exercise_id: ex.id, prescription: '3 × 20 yd' });
  }
  mind = (await coach('POST', '/v1/courses', { title: 'Mental game', description: 'Four short lessons.' })).body;
  lessonIds = [];
  for (const title of ['Pressure is a privilege', 'Next pitch']) lessonIds.push((await coach('POST', '/v1/lessons', { title, body: 'Read this.', course_id: mind.id, minutes: 5 })).body.id);
  const { body } = await req('POST', '/portal/api/login', { email: 'maria@example.com' });
  maria = as((await req('POST', '/portal/api/verify', { email: 'maria@example.com', code: body.dev_code })).cookie);
});
after(() => app.server.close());

test('only owners set prices; the store lists what is priced, on and has something inside', async () => {
  assert.equal((await coach('PUT', `/v1/shop/programs/${speed.id}`, { for_sale: true, price_cents: 4900 })).status, 403);
  assert.equal((await coach('GET', '/v1/shop')).status, 403);
  assert.equal((await owner('PUT', `/v1/shop/programs/${speed.id}`, { for_sale: true })).status, 400, 'needs a price');
  assert.equal((await owner('PUT', `/v1/shop/programs/${speed.id}`, { for_sale: true, price_cents: 50 })).status, 400, 'at least $1');
  const p = (await owner('PUT', `/v1/shop/programs/${speed.id}`, { for_sale: true, price_cents: 4900 })).body;
  assert.deepEqual([p.listed, p.workouts, p.per_week, p.outline], [true, 2, 2, ['Acceleration', 'Top speed']]);
  const c = (await owner('PUT', `/v1/shop/courses/${mind.id}`, { for_sale: true, price_cents: 1900 })).body;
  assert.deepEqual([c.listed, c.lessons, c.minutes], [true, 2, 10]);
  const empty = (await coach('POST', '/v1/programs', { name: 'Empty' })).body;
  const e = (await owner('PUT', `/v1/shop/programs/${empty.id}`, { for_sale: true, price_cents: 1000 })).body;
  assert.equal(e.listed, false);
  assert.match(e.not_listed_because, /workout/);
  const pub = (await req('GET', '/portal/api/public/shop')).body;
  assert.deepEqual(pub.items.map((x) => [x.kind, x.title, x.price_cents]), [['program', 'Summer speed', 4900], ['course', 'Mental game', 1900]]);
  assert.equal(JSON.stringify(pub).includes('Ava'), false);
  const parentCourse = (await coach('POST', '/v1/courses', { title: 'For parents', audience: 'parents' })).body;
  assert.equal((await owner('PUT', `/v1/shop/courses/${parentCourse.id}`, { for_sale: true, price_cents: 1000 })).status, 409);
});

test('a course for sale is locked until bought', async () => {
  const edu = (await athlete('GET', '/app/api/engage')).body.education;
  const course = edu.courses.find((x) => x.id === mind.id);
  assert.deepEqual([course.locked, course.price_cents, course.lessons[0].locked], [true, 1900, true]);
  const open = await athlete('GET', `/app/api/lessons/${lessonIds[0]}`);
  assert.equal(open.status, 409);
  assert.match(open.body.error.message, /Programs tab/);
  assert.equal((await athlete('POST', `/app/api/lessons/${lessonIds[0]}/complete`, {})).status, 409);
});

test('buying needs a card, charges it once, and opens the program without a membership', async () => {
  const home = (await athlete('GET', '/app/api/home')).body;
  assert.equal(home.locked, true, 'no membership, nothing bought');
  const noCard = await maria('POST', '/portal/api/shop/buy', { kind: 'program', item_id: speed.id, athlete_id: ava.id });
  assert.equal(noCard.status, 409);
  assert.match(noCard.body.error.message, /Add a card/);
  await maria('POST', '/portal/api/card/test');
  const r = await maria('POST', '/portal/api/shop/buy', { kind: 'program', item_id: speed.id, athlete_id: ava.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.athlete.program.name, 'Summer speed');
  const again = await maria('POST', '/portal/api/shop/buy', { kind: 'program', item_id: speed.id, athlete_id: ava.id });
  assert.equal(again.status, 409);
  const now = (await athlete('GET', '/app/api/home')).body;
  assert.deepEqual([now.locked, now.program.name, now.workout.title], [false, 'Summer speed', 'Acceleration']);
  const sale = (await owner('GET', `/v1/sales/${r.body.sale_id}`)).body;
  assert.deepEqual([sale.status, sale.amount_cents, sale.method, sale.items[0].name], ['succeeded', 4900, 'card_on_file', 'Summer speed (online program)']);
  const mail = app.ctx.db.get(`SELECT * FROM outbox WHERE to_email = 'maria@example.com' AND subject LIKE 'Summer speed is ready%'`);
  assert.match(mail.body, /\/app\?token=/);
  const fam = (await maria('GET', '/portal/api/shop')).body;
  assert.deepEqual(fam.owned.map((o) => [o.client_id, o.item_kind, o.title]), [[ava.id, 'program', 'Summer speed']]);
  const admin = (await owner('GET', '/v1/shop')).body;
  assert.deepEqual([admin.programs.find((x) => x.id === speed.id).sold, admin.last_30_days.cents], [1, 4900]);
  // Someone else's athlete can't be bought for.
  const other = (await owner('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  assert.equal((await maria('POST', '/portal/api/shop/buy', { kind: 'course', item_id: mind.id, athlete_id: other.id })).status, 404);
  // A coach assigning the course opens it for that athlete without buying.
  const benApp = (path) => req('GET', path, null, { 'x-client-token': other.app_link.split('token=')[1] });
  assert.equal((await benApp(`/app/api/lessons/${lessonIds[0]}`)).status, 409);
  assert.equal((await coach('POST', '/v1/lesson-assignments', { course_id: mind.id, client_id: other.id })).status, 201);
  assert.equal((await benApp(`/app/api/lessons/${lessonIds[0]}`)).status, 200);
});

test('a bought course opens its lessons', async () => {
  assert.equal((await maria('POST', '/portal/api/shop/buy', { kind: 'course', item_id: mind.id, athlete_id: ava.id })).status, 201);
  const course = (await athlete('GET', '/app/api/engage')).body.education.courses.find((x) => x.id === mind.id);
  assert.equal(course.locked, undefined);
  assert.equal((await athlete('GET', `/app/api/lessons/${lessonIds[0]}`)).status, 200);
});

test('a full refund ends access', async () => {
  const buy = app.ctx.db.get(`SELECT sale_id FROM purchases WHERE item_kind = 'program' AND client_id = ?`, ava.id);
  assert.equal((await owner('POST', `/v1/sales/${buy.sale_id}/refund`, {})).status, 200);
  assert.equal((await athlete('GET', '/app/api/home')).body.locked, true);
  assert.equal(app.ctx.db.get('SELECT status FROM purchases WHERE sale_id = ?', buy.sale_id).status, 'refunded');
  // Bought again after a refund: allowed.
  assert.equal((await maria('POST', '/portal/api/shop/buy', { kind: 'program', item_id: speed.id, athlete_id: ava.id })).status, 201);
});

test('the store page is public and export includes what was bought', async () => {
  const page = await fetch(`${base}/shop`);
  assert.equal(page.status, 200);
  const fam = app.ctx.db.get('SELECT family_id FROM clients WHERE id = ?', ava.id).family_id;
  const exp = (await owner('GET', `/v1/families/${fam}/export`)).body;
  assert.equal(JSON.stringify(exp).includes('bought_online'), true);
});
