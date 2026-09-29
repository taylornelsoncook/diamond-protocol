import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { openDb } from '../src/db.js';
import { newId } from '../src/util.js';
import { runMonthly, facts } from '../src/services/monthly.js';

// Monthly progress reports for parents: written from the month's logs, a coach's line, sent by email and shown in the portal.
let app, base, owner, coach, desk, ava, ben, cal, squat, slot, workoutId;

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
async function parentSignIn(email) {
  const login = await fetch(base + '/portal/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) }).then((r) => r.json());
  const v = await fetch(base + '/portal/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: login.dev_code }) });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(base + '/portal/api/' + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const member = (c) => app.ctx.db.run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, 'pln_1', 'active', ?, ?, ?, ?)`, newId('sub'), c.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
// A finished workout with five sets of the squat at one weight, on a day.
function logged(c, at, weight, { started = true, rpe = 7 } = {}) {
  const id = newId('wlog');
  app.ctx.db.run('INSERT INTO workout_logs (id, client_id, workout_id, completed_at, started_at, rpe) VALUES (?, ?, ?, ?, ?, ?)', id, c.id, workoutId, at, started ? new Date(Date.parse(at) - 40 * 60000).toISOString() : null, rpe);
  for (let n = 1; n <= 5; n++) app.ctx.db.run('INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('set'), id, slot.id, squat.id, 'Back squat', n, weight, 5, at);
  return id;
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: 'correct-horse-battery' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: 'correct-horse-battery', role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: 'correct-horse-battery', role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); desk = await signIn('desk@test.dev');
  app.ctx.db.run(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_f', 'Facility', 'facility', 1, ?)`, app.ctx.now());
  app.ctx.db.run(`INSERT INTO plans (id, name, price_cents, interval, active, created_at) VALUES ('pln_1', 'Monthly', 15000, 'month', 1, ?)`, app.ctx.now());
  ava = (await coach('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  ben = (await coach('POST', '/v1/clients', { name: 'Ben Park', parent: { name: 'Dana Park', email: 'dana@example.com' } })).body;
  cal = (await coach('POST', '/v1/clients', { name: 'Cal Reed', parent: { name: 'Sam Reed', email: 'reed@example.com' } })).body;
  app.ctx.db.run('UPDATE clients SET family_id = NULL WHERE id = ?', cal.id);   // no family: nobody to send to
  member(ava); member(ben);
  squat = (await coach('POST', '/v1/exercises', { name: 'Back squat', category: 'Lower body' })).body;
  const program = (await coach('POST', '/v1/programs', { name: 'Strength block', weeks: 4 })).body;
  for (let w = 1; w <= 4; w++) for (const d of [1, 3]) {
    const wo = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: w, day: d, title: `Week ${w} day ${d}` })).body;
    const full = (await coach('POST', `/v1/workouts/${wo.id}/exercises`, { exercise_id: squat.id, sets: 5, reps: '5' })).body;
    if (w === 1 && d === 1) { workoutId = wo.id; slot = full.exercises[0]; }
  }
  await coach('POST', `/v1/programs/${program.id}/assign`, { client_id: ava.id });
  app.ctx.db.run(`UPDATE assignments SET start_date = '2026-07-01T00:00:00Z' WHERE client_id = ?`, ava.id);   // on the program since July
  // July: one workout at 135. August: three at 155 (Epley: 135×5 → 157.5; 155×5 → 180.8).
  logged(ava, '2026-07-20T16:00:00Z', 135);
  for (const d of ['2026-08-03', '2026-08-10', '2026-08-24']) logged(ava, `${d}T16:00:00Z`, 155);
  logged(cal, '2026-08-05T16:00:00Z', 95);
  for (const d of ['2026-08-03', '2026-08-04']) app.ctx.db.run('INSERT INTO daily_checkins (id, client_id, date, sleep_hours, created_at, updated_at) VALUES (?, ?, ?, 8, ?, ?)', newId('chk'), ava.id, d, `${d}T13:00:00Z`, `${d}T13:00:00Z`);
  const sid = newId('cls');
  app.ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES (?, 'Team lift', 'group', 'loc_f', '2026-08-12T22:00:00Z', '2026-08-12T23:00:00Z', 10, 'scheduled', '2026-08-01T00:00:00Z')`, sid);
  app.ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES (?, ?, ?, 'attended', 'membership', ?, ?)`, newId('bkg'), sid, ava.id, app.ctx.now(), app.ctx.now());
});
after(() => app.server.close());

test('the month\'s facts, written once the month ends: members and anyone who did something, never a month still running', async () => {
  assert.equal((await coach('POST', '/v1/monthly-reports/generate', { month: '2026-09' })).status, 400, 'September isn\'t over');
  assert.equal((await coach('POST', '/v1/monthly-reports/generate', { month: '2026-13' })).status, 400);
  const g = await coach('POST', '/v1/monthly-reports/generate', { month: '2026-08' });
  assert.deepEqual([g.status, g.body.drafts, g.body.skipped, g.body.already, g.body.label], [201, 1, 1, 0, 'August 2026'], JSON.stringify(g.body));
  const list = (await coach('GET', '/v1/monthly-reports?month=2026-08')).body;
  assert.deepEqual(list.data.map((r) => [r.client_name, r.status]), [['Ava Lopez', 'draft'], ['Ben Park', 'skipped']], 'Cal has no family, so no report');
  assert.deepEqual([list.months[0].month, list.months[0].drafts, list.mode], ['2026-08', 1, 'review']);
  const d = list.data[0].data;
  assert.deepEqual([d.workouts, d.expected, d.workouts_prev, d.sets, d.minutes, d.effort_avg, d.attended, d.checkins, d.days, d.program], [3, 9, 1, 15, 120, 7, 1, 2, 31, 'Strength block']);
  assert.deepEqual(d.strength, [{ exercise_id: squat.id, name: 'Back squat', e1rm: 181, top: 155, before: 158, change: 23 }]);
  const again = (await coach('POST', '/v1/monthly-reports/generate', { month: '2026-08' })).body;
  assert.deepEqual([again.drafts, again.skipped, again.already], [0, 0, 2], 'running it twice changes nothing');
  assert.equal(facts(app.ctx, ben.id, '2026-08').quiet, true);
  // A program joined mid-month counts only from then; one joined after the month doesn't count at all.
  app.ctx.db.run(`UPDATE assignments SET start_date = '2026-08-17T00:00:00Z' WHERE client_id = ?`, ava.id);
  assert.deepEqual([facts(app.ctx, ava.id, '2026-08').expected, facts(app.ctx, ava.id, '2026-08').program], [4, 'Strength block'], 'about two weeks at two a week');
  app.ctx.db.run(`UPDATE assignments SET start_date = '2026-09-05T00:00:00Z' WHERE client_id = ?`, ava.id);
  assert.deepEqual([facts(app.ctx, ava.id, '2026-08').expected, facts(app.ctx, ava.id, '2026-08').program], [null, null]);
  app.ctx.db.run(`UPDATE assignments SET start_date = '2026-07-01T00:00:00Z' WHERE client_id = ?`, ava.id);
  assert.equal((await desk('GET', '/v1/monthly-reports')).status, 403, 'front desk has no part in it');
  const today = (await coach('GET', '/v1/dashboard')).body.attention.find((a) => a.kind === 'monthly_reports');
  assert.deepEqual([today.count, today.month, today.items[0].name], [1, '2026-08', 'Ava Lopez']);
});

test('a coach adds a line and sends it: the parents get the email, the portal shows it, and it can\'t change after', async () => {
  const r = (await coach('GET', '/v1/monthly-reports?month=2026-08&status=draft')).body.data[0];
  const noted = (await coach('PATCH', `/v1/monthly-reports/${r.id}`, { coach_note: 'Ava\'s squat depth is the best in the group. Keep the check-ins coming.' })).body;
  assert.equal(noted.note_by, 'Riley');
  assert.equal((await coach('PATCH', `/v1/monthly-reports/${r.id}`, { coach_note: 'x'.repeat(1501) })).status, 400);
  const full = (await coach('GET', `/v1/monthly-reports/${r.id}`)).body;
  assert.match(full.text, /^Ava's August 2026 at /);
  assert.match(full.text, /Workouts logged: 3 of about 9 on the program's pace \(2 more than the month before\)\. Program: Strength block\./);
  assert.match(full.text, /Back squat: 181 lb \(up 23 lb\)/);
  assert.match(full.text, /From Coach Riley: Ava's squat depth/);
  assert.doesNotMatch(full.text, /\$/, 'no money in it');
  const before = app.ctx.db.get('SELECT COUNT(*) AS n FROM outbox').n;
  const sent = await coach('POST', `/v1/monthly-reports/${r.id}/send`);
  assert.deepEqual([sent.status, sent.body.status, sent.body.sent_to, sent.body.sent_by], [200, 'sent', ['maria@example.com'], 'Riley']);
  const mail = app.ctx.db.all('SELECT to_email, subject, body FROM outbox ORDER BY rowid DESC LIMIT ?', app.ctx.db.get('SELECT COUNT(*) AS n FROM outbox').n - before);
  assert.deepEqual(mail.map((m) => [m.to_email, m.subject]), [['maria@example.com', 'Ava\'s August 2026 at Diamond Protocol']]);
  assert.match(mail[0].body, /^Hi Maria,/);
  assert.equal((await coach('POST', `/v1/monthly-reports/${r.id}/send`)).status, 409, 'sent once');
  assert.equal((await coach('PATCH', `/v1/monthly-reports/${r.id}`, { coach_note: 'late' })).status, 409);
  assert.equal(app.ctx.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'monthly_report.sent'`).n, 1);
  // The parents' view, and the other family sees nothing about Ava.
  const maria = await parentSignIn('maria@example.com');
  const mine = (await maria('GET', `athletes/${ava.id}/monthly-reports`)).body.data;
  assert.deepEqual([mine.length, mine[0].label, mine[0].note_by, mine[0].lines[0].startsWith('Workouts logged: 3')], [1, 'August 2026', 'Riley', true]);
  const dana = await parentSignIn('dana@example.com');
  assert.equal((await dana('GET', `athletes/${ava.id}/monthly-reports`)).status, 404);
  assert.deepEqual((await dana('GET', `athletes/${ben.id}/monthly-reports`)).body.data, [], 'a skipped month is never shown');
  // Skip and bring back.
  const skipped = (await coach('GET', '/v1/monthly-reports?month=2026-08&status=skipped')).body.data[0];
  assert.equal((await coach('POST', `/v1/monthly-reports/${skipped.id}/unskip`)).body.status, 'draft');
  assert.equal((await coach('POST', `/v1/monthly-reports/${skipped.id}/skip`)).body.status, 'skipped');
  // The family export carries the reports.
  const e = (await owner('GET', `/v1/families/${ava.family.id}/export`)).body;
  assert.deepEqual([e.athletes[0].monthly_reports.length, e.athletes[0].monthly_reports[0].status, e.athletes[0].monthly_reports[0].data.workouts], [1, 'sent', 3]);
});

test('the job: in the first week of a month, from 7 am, last month is written once; auto mode sends it too; off does nothing', async () => {
  const dee = (await coach('POST', '/v1/clients', { name: 'Dee Cruz', parent: { name: 'Sam Cruz', email: 'sam@example.com' } })).body;
  member(dee);
  logged(dee, '2026-08-15T16:00:00Z', 65);
  assert.equal(await runMonthly(app.ctx, '2026-09-02T09:00:00Z'), null, 'before 7 am business time');
  assert.equal(await runMonthly(app.ctx, '2026-09-09T15:00:00Z'), null, 'past the first week');
  const r = await runMonthly(app.ctx, '2026-09-02T15:00:00Z');
  assert.deepEqual([r.month, r.drafts, r.already, r.sent], ['2026-08', 1, 2, undefined], 'review mode writes, never sends');
  assert.equal(await runMonthly(app.ctx, '2026-09-03T15:00:00Z'), null, 'once a month');
  assert.equal((await coach('POST', '/v1/monthly-reports/send-all', { month: '2026-08' })).body.sent, 1, 'Dee\'s goes out; Ava\'s went already');
  // Auto mode for September's run, with an unsubscribed parent left out.
  assert.equal((await owner('PATCH', '/v1/settings', { monthly_reports: 'auto' })).status, 200);
  assert.equal((await owner('PATCH', '/v1/settings', { monthly_reports: 'sometimes' })).status, 400);
  app.ctx.db.run(`INSERT INTO email_optouts (email, created_at) VALUES ('sam@example.com', ?)`, app.ctx.now());
  logged(dee, '2026-09-15T16:00:00Z', 70); logged(ava, '2026-09-16T16:00:00Z', 160);
  const auto = await runMonthly(app.ctx, '2026-10-01T15:00:00Z');
  assert.deepEqual([auto.month, auto.drafts, auto.sent], ['2026-09', 2, 1], 'Dee\'s parent unsubscribed, so hers stays a draft');
  const left = (await coach('GET', '/v1/monthly-reports?month=2026-09&status=draft')).body.data;
  assert.deepEqual(left.map((x) => x.client_name), ['Dee Cruz']);
  assert.equal((await coach('POST', `/v1/monthly-reports/${left[0].id}/send`)).status, 409, 'no one to send to');
  // A mail service that refuses the email leaves the report a draft instead of calling it sent.
  app.ctx.db.run(`DELETE FROM email_optouts WHERE email = 'sam@example.com'`);
  const realMail = app.ctx.mail; app.ctx.mail = { ...realMail, resendKey: 're_test', onlyTo: '' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('resend') ? new Response(JSON.stringify({ message: 'refused' }), { status: 500 }) : realFetch(url, opts));
  try {
    const bad = await coach('POST', `/v1/monthly-reports/${left[0].id}/send`);
    assert.deepEqual([bad.status, bad.body.error.code], [502, 'email_failed']);
    assert.equal((await coach('GET', `/v1/monthly-reports/${left[0].id}`)).body.status, 'draft', 'still a draft');
  } finally { globalThis.fetch = realFetch; app.ctx.mail = realMail; }
  await owner('PATCH', '/v1/settings', { monthly_reports: 'off' });
  assert.equal(await runMonthly(app.ctx, '2026-11-01T15:00:00Z'), null);
});

test('a version 58 database gains the reports table, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v58.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 58');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 59, `round ${round}`);
      assert.equal(d.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'monthly_reports'`).n, 1);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
