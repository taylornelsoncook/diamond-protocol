// Progress notes for parents: drafted from a testing day's results, approved by a coach, shown once the day is shared.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { draftFromFacts } from '../src/services/notes.js';

let app, base, coach, desk, maria, ava, ben, fall, spring;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const as = (cookie) => (method, path, body) => req(method, path, body, { cookie });
const signIn = async (email) => as((await req('POST', '/auth/login', { email, password: 'correct-horse-battery' })).cookie);

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Desk', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2013-03-10', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  spring = (await coach('POST', '/v1/testing-sessions', { name: 'Spring testing', date: '2026-04-10', tests: ['dash_10yd', 'vertical_standing', 'broad_jump'] })).body;
  await coach('POST', '/v1/results', { session_id: spring.id, results: [
    { client_id: ava.id, test: 'dash_10yd', value: 1.95, recorded_at: '2026-04-10T15:00:00.000Z' },
    { client_id: ava.id, test: 'vertical_standing', value: 18, recorded_at: '2026-04-10T15:00:00.000Z' },
    { client_id: ava.id, test: 'broad_jump', value: 80, recorded_at: '2026-04-10T15:00:00.000Z' }] });
  fall = (await coach('POST', '/v1/testing-sessions', { name: 'Fall testing', date: '2026-09-20', tests: ['dash_10yd', 'vertical_standing', 'broad_jump', 'pro_agility'] })).body;
  await coach('POST', '/v1/results', { session_id: fall.id, results: [
    { client_id: ava.id, test: 'dash_10yd', value: 1.82, recorded_at: '2026-09-20T15:00:00.000Z' },
    { client_id: ava.id, test: 'vertical_standing', value: 20, recorded_at: '2026-09-20T15:00:00.000Z' },
    { client_id: ava.id, test: 'broad_jump', value: 76, recorded_at: '2026-09-20T15:00:00.000Z' },
    { client_id: ava.id, test: 'pro_agility', value: 5.1, recorded_at: '2026-09-20T15:00:00.000Z' },
    { client_id: ben.id, test: 'dash_10yd', value: 1.7, recorded_at: '2026-09-20T15:00:00.000Z' }] });
  const { body } = await req('POST', '/portal/api/login', { email: 'maria@example.com' });
  maria = as((await req('POST', '/portal/api/verify', { email: 'maria@example.com', code: body.dev_code })).cookie);
});
after(() => app.server.close());

test('drafts say what improved, what dipped and what is next, with the right numbers and no pronouns', async () => {
  const r = (await coach('POST', `/v1/testing-sessions/${fall.id}/notes/draft`)).body;
  assert.equal(r.drafted, 2);
  const a = r.data.find((x) => x.client_id === ava.id).note;
  assert.equal(a.approved, false);
  assert.match(a.body, /^Ava tested 4 events at Fall testing\./);
  assert.match(a.body, /biggest step forward was the vertical jump: 18\.0 in to 20\.0 in, 11\.1% better than last time and a new personal best\./);
  assert.match(a.body, /The 10-yard sprint improved too \(1\.95 s to 1\.82 s, another best\)\./);
  assert.match(a.body, /first 5-10-5 pro agility \(5\.10 s\)/);
  assert.match(a.body, /The broad jump came in a little under last time \(6 ft 8 in to 6 ft 4 in\)/);
  assert.match(a.body, /Next, the focus is jumping and explosive power\./);
  assert.doesNotMatch(a.body, /\b(he|she|him|her|his|hers)\b/i);
  const b = r.data.find((x) => x.client_id === ben.id).note;
  assert.match(b.body, /first 10-yard sprint \(1\.70 s\)/);
  // Nothing new to draft; approved notes are never redone.
  assert.equal((await coach('POST', `/v1/testing-sessions/${fall.id}/notes/draft`)).body.drafted, 0);
});

test('the draft handles a day with nothing to compare', () => {
  assert.match(draftFromFacts({ athlete: 'Cole', session: 'Combine', results: [] }), /Cole didn't have results/);
});

test('coaches edit and approve; front desk can only read', async () => {
  const notes = (await coach('GET', `/v1/testing-sessions/${fall.id}/notes`)).body;
  const a = notes.data.find((x) => x.client_id === ava.id).note;
  assert.equal((await desk('GET', `/v1/testing-sessions/${fall.id}/notes`)).status, 200);
  assert.equal((await desk('PATCH', `/v1/progress-notes/${a.id}`, { approved: true })).status, 403);
  assert.equal((await desk('POST', `/v1/testing-sessions/${fall.id}/notes/draft`)).status, 403);
  const edited = (await coach('PATCH', `/v1/progress-notes/${a.id}`, { body: `${a.body} Great focus all day.`, approved: true })).body;
  assert.deepEqual([edited.approved, edited.approved_by], [true, 'Carl Coach']);
  assert.match(edited.body, /Great focus all day\.$/);
  assert.equal(app.ctx.db.get('SELECT source FROM progress_notes WHERE id = ?', a.id).source, 'edited');
  assert.equal((await coach('POST', `/v1/testing-sessions/${fall.id}/notes/draft`, { client_ids: [ava.id] })).body.drafted, 0, 'approved stays');
  assert.equal((await coach('POST', `/v1/testing-sessions/${fall.id}/notes/approve`)).body.approved, 1, 'Ben\'s draft');
  assert.equal((await coach('POST', `/v1/testing-sessions/${fall.id}/notes/approve`)).status, 409);
});

test('parents see the approved note only after the day is shared, and in the email', async () => {
  const before = (await maria('GET', `/portal/api/athletes/${ava.id}/report`)).body;
  assert.notEqual(before.latest_session?.id, fall.id, 'not shared yet');
  await coach('POST', `/v1/testing-sessions/${fall.id}/share`, { parent_note: 'Thanks for a great day, everyone.' });
  const after = (await maria('GET', `/portal/api/athletes/${ava.id}/report`)).body;
  assert.equal(after.latest_session.id, fall.id);
  assert.match(after.latest_session.athlete_note, /Great focus all day\./);
  assert.equal(after.latest_session.parent_note, 'Thanks for a great day, everyone.');
  const mail = app.ctx.db.get(`SELECT body FROM outbox WHERE to_email = 'maria@example.com' AND subject LIKE 'Ava''s results from Fall testing%'`);
  assert.match(mail.body, /Great focus all day\./);
});

test('with an Anthropic key, Claude rewords the draft; any failure falls back to the plain draft', async () => {
  const day = (await coach('POST', '/v1/testing-sessions', { name: 'Winter testing', date: '2026-12-01', tests: ['dash_10yd'] })).body;
  await coach('POST', '/v1/results', { session_id: day.id, results: [{ client_id: ben.id, test: 'dash_10yd', value: 1.66, recorded_at: '2026-12-01T15:00:00.000Z' }] });
  const real = globalThis.fetch, sent = [];
  process.env.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.anthropic.com')) return real(url, opts);
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Ben sharpened the 10-yard sprint to 1.66 s, a new best.' }] }), { status: 200 });
  };
  try {
    const r = (await coach('POST', `/v1/testing-sessions/${day.id}/notes/draft`)).body;
    assert.equal(r.ai, true);
    assert.deepEqual([r.data[0].note.source, r.data[0].note.body], ['ai', 'Ben sharpened the 10-yard sprint to 1.66 s, a new best.']);
    assert.equal(sent.length, 1);
    assert.equal(JSON.stringify(sent[0]).includes('dana@example.com'), false, 'no contact details go out');
    globalThis.fetch = async (url, opts) => (String(url).startsWith('https://api.anthropic.com') ? new Response('{}', { status: 500 }) : real(url, opts));
    const redo = (await coach('POST', `/v1/testing-sessions/${day.id}/notes/draft`, { client_ids: [ben.id] })).body;
    assert.equal(redo.data[0].note.source, 'draft');
    assert.match(redo.data[0].note.body, /^Ben tested the 10-yard sprint at Winter testing\./);
  } finally { globalThis.fetch = real; delete process.env.ANTHROPIC_API_KEY; }
});
