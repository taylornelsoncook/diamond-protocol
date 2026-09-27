// The iPhone app can't be compiled here, so this test pins the API contract it depends on:
// every field the Swift models decode must exist with the right type (non-optional fields never null).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';

let app, base, token;
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
// shape: { field: 'string' | 'number' | 'boolean' | 'array' | 'object', optional fields end with '?' }
function conforms(obj, shape, where) {
  for (const [k, type] of Object.entries(shape)) {
    const optional = k.endsWith('?'), key = k.replace('?', '');
    const v = obj[key];
    if (v === null || v === undefined) { assert.ok(optional, `${where}.${key} is required by the app but was ${v}`); continue; }
    const actual = Array.isArray(v) ? 'array' : typeof v;
    assert.equal(actual, type, `${where}.${key} should be ${type}`);
  }
}

before(async () => {
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Coach', password: 'correct-horse-battery' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const t = await (await fetch(`${base}/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'coach@test.dev', password: 'correct-horse-battery' }) })).json();
  token = t.token;
  conforms(t, { token: 'string', user: 'object' }, 'TokenResponse');
  conforms(t.user, { id: 'string', email: 'string', name: 'string', 'role?': 'string', 'must_change_password?': 'boolean' }, 'User');
});
after(() => app.server.close());

test('Today and rosters', async () => {
  const loc = (await call('POST', '/v1/locations', { name: 'Facility', kind: 'facility', address_line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701' })).body;
  const kid = (await call('POST', '/v1/clients', { name: 'Ava Lopez', birth_date: '2013-03-10', medical_notes: 'Asthma', parent: { name: 'Maria Lopez', email: 'maria@example.com', phone: '555-0101' } })).body;
  const now = new Date(Date.now() + 2 * 3600000);
  const date = now.toISOString().slice(0, 10), time = now.toISOString().slice(11, 16);
  await call('PATCH', '/v1/settings', { timezone: 'UTC' });
  const s = (await call('POST', '/v1/sessions', { name: 'Speed', kind: 'group', location_id: loc.id, date, start_time: time, capacity: 10, drop_in_cents: 2500 })).body;
  const b = (await call('POST', `/v1/sessions/${s.id}/bookings`, { client_id: kid.id })).body;
  const contract = (await call('POST', '/v1/team-contracts', { organization: { name: 'Westlake HS' }, name: 'Varsity', monthly_cents: 1000 })).body;
  const roster = (await call('POST', `/v1/team-contracts/${contract.id}/roster`, { names: 'Jalen Brooks, QB' })).body.data;
  await call('POST', `/v1/team-contracts/${contract.id}/sessions`, { location_id: loc.id, weekdays: [now.getUTCDay()], start_time: time, duration_min: 60, start_date: date });

  const agenda = (await call('GET', `/v1/agenda?date=${date}`)).body;
  conforms(agenda, { date: 'string', timezone: 'string', sessions: 'array' }, 'Agenda');
  assert.ok(agenda.sessions.length >= 2);
  for (const x of agenda.sessions) {
    conforms(x, { id: 'string', name: 'string', kind: 'string', starts_at: 'string', ends_at: 'string', location_name: 'string', capacity: 'number', booked_count: 'number', attended_count: 'number', unpaid_count: 'number', status: 'string', 'drop_in_cents?': 'number', 'coach_name?': 'string', roster: 'array', 'team?': 'object' }, 'SessionDetail');
    for (const r of x.roster) conforms(r, { id: 'string', status: 'string', coverage: 'string', client_id: 'string', name: 'string', 'age?': 'number', has_medical_notes: 'boolean', 'parent_phone?': 'string' }, 'RosterEntry');
    if (x.team) {
      conforms(x.team, { contract_id: 'string', team_name: 'string', org_name: 'string', athletes: 'array' }, 'TeamRoster');
      for (const a of x.team.athletes) conforms(a, { id: 'string', name: 'string', 'athlete_id?': 'string', 'position?': 'string', present: 'boolean' }, 'TeamAthlete');
    }
  }
  const one = (await call('GET', `/v1/sessions/${s.id}`)).body;
  assert.equal(one.roster[0].has_medical_notes, true);
  conforms((await call('POST', `/v1/bookings/${b.id}/attendance`, { status: 'attended' })).body, { id: 'string' }, 'attendance');
  const teamSession = agenda.sessions.find((x) => x.team);
  conforms((await call('POST', `/v1/sessions/${teamSession.id}/team-attendance`, { roster_id: roster[0].id, present: true })).body, { contract_id: 'string', team_name: 'string', org_name: 'string', athletes: 'array' }, 'TeamRoster');
  const pay = (await call('POST', `/v1/bookings/${b.id}/pay`, { method: 'tap_to_pay' })).body;
  conforms(pay.sale, { id: 'string', status: 'string', method: 'string', amount_cents: 'number', 'card_brand?': 'string', 'card_last4?': 'string', 'failure_reason?': 'string', 'tap_to_pay?': 'object' }, 'Sale');
  conforms(pay.sale.tap_to_pay, { client_secret: 'string', 'location_ref?': 'string' }, 'TapToPayInfo');
  const clients = (await call('GET', '/v1/clients')).body.data;
  for (const c of clients) conforms(c, { id: 'string', name: 'string', 'email?': 'string', 'athlete_id?': 'string', status: 'string', session_credits: 'number', has_card: 'boolean' }, 'ClientSummary');
  assert.equal(clients[0].email, null, 'athletes under a parent have no email: the app must treat it as optional');
});

test('Testing days, stopwatch saves and undo', async () => {
  const kid = (await call('GET', '/v1/clients')).body.data[0];
  const day = (await call('POST', '/v1/testing-sessions', { name: 'Combine', date: '2026-09-20', tests: ['dash_40yd', 'pro_agility', 'vertical_standing'], athletes: [{ client_id: kid.id }] })).body;
  for (const d of (await call('GET', '/v1/testing-sessions')).body.data) conforms(d, { id: 'string', name: 'string', date: 'string', tests: 'array', athletes_count: 'number', results_count: 'number' }, 'TestingDaySummary');
  const saved = (await call('POST', '/v1/results', { session_id: day.id, results: [{ client_id: kid.id, test: 'dash_40yd', metric: 'time', value: 5.31, attempt: 1, timing: 'hand', recorded_at: '2026-09-20T15:00:00.000Z' }] })).body;
  conforms(saved, { created: 'number', errors: 'array', prs: 'array', results: 'array' }, 'RecordResponse');
  conforms(saved.results[0], { id: 'string' }, 'RecordResponse.Saved');
  await call('POST', '/v1/results', { session_id: day.id, results: [{ client_id: kid.id, test: 'pro_agility', value: 4.9, side: 'L', attempt: 1 }] });
  const full = (await call('GET', `/v1/testing-sessions/${day.id}`)).body;
  conforms(full, { id: 'string', name: 'string', date: 'string', tests: 'array', athletes: 'array' }, 'TestingDay');
  for (const t of full.tests) {
    conforms(t, { id: 'string', key: 'string', name: 'string', category: 'string', sides: 'string', attempts: 'number', timed: 'boolean', metrics: 'array' }, 'TestDef');
    for (const m of t.metrics) conforms(m, { key: 'string', name: 'string', unit: 'string', better: 'string', decimals: 'number' }, 'TestDef.Metric');
  }
  for (const a of full.athletes) {
    conforms(a, { 'client_id?': 'string', 'roster_id?': 'string', name: 'string', 'athlete_id?': 'string', results: 'array' }, 'DayAthlete');
    for (const r of a.results) conforms(r, { id: 'string', test_id: 'string', metric: 'string', 'side?': 'string', 'attempt?': 'number', value: 'number', 'timing?': 'string' }, 'DayResult');
  }
  assert.equal(full.athletes[0].results.find((r) => r.side === 'L').side, 'L');
  const undo = (await call('DELETE', `/v1/results/${saved.results[0].id}`)).body;
  conforms(undo, { voided: 'boolean' }, 'undo');
  assert.equal((await call('GET', `/v1/testing-sessions/${day.id}`)).body.athletes[0].results.length, 1);
});

test('first sign-in password change from the app', async () => {
  const owner = await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'coach@test.dev', password: 'correct-horse-battery' }) }));
  const cookie = owner.headers.get('set-cookie').split(';')[0];
  const staff = await (await fetch(`${base}/v1/staff`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Dana Desk', email: 'dana@test.dev', role: 'front_desk' }) })).json();
  const t = await (await fetch(`${base}/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dana@test.dev', password: staff.temporary_password }) })).json();
  assert.equal(t.user.must_change_password, true);
  token = t.token;
  const blocked = await call('GET', '/v1/agenda');
  assert.equal(blocked.status, 403);
  assert.ok(blocked.body.error.message.startsWith('Choose a new password'), 'the app watches for this exact wording');
  conforms((await call('POST', '/auth/password', { current_password: staff.temporary_password, new_password: 'dana-password-1' })).body, { ok: 'boolean' }, 'password');
  const me = (await call('GET', '/auth/me')).body;
  conforms(me, { user: 'object', payments: 'object' }, 'Me');
  conforms(me.payments, { provider: 'string', live: 'boolean', can_simulate: 'boolean' }, 'Me.Payments');
  assert.equal(me.user.must_change_password, false);
  assert.equal((await call('GET', '/v1/agenda')).status, 200, 'front desk can run Today');
  assert.equal((await call('GET', '/v1/testing-sessions')).status, 200, 'and Testing');
});
