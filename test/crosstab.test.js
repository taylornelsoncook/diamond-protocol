// Cross-tab checks: the same money, attendance, workouts and PRs read the same on every tab that shows them.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-crosstab-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const { get, all, run, setSetting } = require('../server/db');
const booking = require('../server/services/booking');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), put: (p, b = {}) => req('PUT', p, b), del: (p) => req('DELETE', p) };
}
async function staff(email, password) { const c = client(); const r = await c.post('/api/auth/staff/login', { email, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }
const owner = () => staff('owner@demo.test', 'demo-owner-2026');
const coach = () => staff('coach@demo.test', 'demo-coach-2026');
const desk = () => staff('desk@demo.test', 'demo-desk-2026');
async function parent(email) {
  const c = client();
  const code = await c.post('/api/auth/parent/code', { email });
  const v = await c.post('/api/auth/parent/verify', { email, code: code.data.test_code });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return c;
}
const athlete = (first, last) => get('SELECT * FROM athletes WHERE first_name=? AND last_name=?', first, last);

// A future group session with a drop-in price, and a family athlete booked into it with nothing covering it.
async function unpaidBooking(d) {
  const T = booking.todayLocal();
  const events = all("SELECT * FROM events WHERE type='class' AND cancelled=0 AND price_cents>0 AND starts_at>? ORDER BY starts_at", `${T}T23:59`);
  const kids = all('SELECT a.*, p.email AS parent_email FROM athletes a JOIN parents p ON p.family_id=a.family_id WHERE a.archived=0 ORDER BY a.id');
  for (const e of events) {
    for (const a of kids) {
      const r = await d.post(`/api/events/${e.id}/bookings`, { athlete_id: a.id });
      if (r.status !== 200) continue;
      if (r.data.booking.coverage === 'unpaid') return { e, a, b: r.data.booking };
      await d.del(`/api/bookings/${r.data.booking.id}`);
    }
  }
  throw new Error('No unpaid booking could be made from the demo data.');
}

test('a drop-in collected at the door and then cancelled by the family comes off Point of sale as well as Billing', async () => {
  const d = await desk(), o = await owner();
  const { e, a, b } = await unpaidBooking(d);
  const col = await d.post(`/api/bookings/${b.id}/collect`, { method: 'cash' });
  assert.equal(col.status, 200, JSON.stringify(col.data));
  const sale = get('SELECT * FROM sales WHERE booking_id=?', b.id);
  assert.equal(sale.status, 'paid');
  const before = (await o.get(`/api/sales/summary?location_id=${e.location_id}`)).data;

  const p = await parent(a.parent_email);
  const c = await p.del(`/api/parent/bookings/${b.id}`);
  assert.equal(c.status, 200, JSON.stringify(c.data));

  const after = get('SELECT * FROM sales WHERE id=?', sale.id);
  assert.equal(after.status, 'refunded', 'the sale is marked refunded');
  assert.equal(after.refunded_cents, sale.total_cents);
  const inv = get("SELECT * FROM invoices WHERE charge_id=? AND amount_cents>0", sale.charge_id);
  assert.equal(get('SELECT COALESCE(SUM(amount_cents),0) n FROM invoices WHERE refund_of=?', inv.id).n, -sale.total_cents, 'the sale\'s own invoice is refunded once');
  const sum = (await o.get(`/api/sales/summary?location_id=${e.location_id}`)).data;
  assert.equal(sum.net_cents, before.net_cents - sale.total_cents, 'Point of sale takings drop by the refund');
});

test('a drop-in already refunded at Point of sale is not refunded again when the booking is cancelled', async () => {
  const d = await desk(), o = await owner();
  const { b } = await unpaidBooking(d);
  assert.equal((await d.post(`/api/bookings/${b.id}/collect`, { method: 'cash' })).status, 200);
  const sale = get('SELECT * FROM sales WHERE booking_id=?', b.id);
  const r = await o.post(`/api/sales/${sale.id}/refund`, { amount_cents: sale.total_cents });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const inv = get("SELECT * FROM invoices WHERE charge_id=? AND amount_cents>0", sale.charge_id);
  const refundsBefore = all('SELECT id FROM invoices WHERE amount_cents<0').length;
  const c = await d.del(`/api/bookings/${b.id}`);
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(all('SELECT id FROM invoices WHERE amount_cents<0').length, refundsBefore, 'no second refund');
  assert.equal(get('SELECT COALESCE(SUM(amount_cents),0) n FROM invoices WHERE refund_of=?', inv.id).n, -sale.total_cents);
});

test('drop-in invoices and membership charges read as dates people understand, not raw timestamps', async () => {
  const d = await desk();
  const { e, b } = await unpaidBooking(d);
  assert.equal((await d.post(`/api/bookings/${b.id}/collect`, { method: 'cash' })).status, 200);
  const inv = get("SELECT i.description FROM invoices i JOIN sales s ON s.charge_id=i.charge_id WHERE s.booking_id=? AND i.amount_cents>0", b.id);
  assert.doesNotMatch(inv.description, /\d{4}-\d{2}-\d{2}/, inv.description);
  assert.match(inv.description, new RegExp(`^${e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, [A-Z][a-z]{2}, [A-Z][a-z]{2} \\d{1,2} at \\d{1,2}:\\d{2} [AP]M$`));
  for (const r of all("SELECT description FROM invoices WHERE kind='membership'")) assert.doesNotMatch(r.description, /: \d{4}-\d{2}$/, r.description);
});

test('school invoice emails say where to mail a check', async () => {
  const o = await owner();
  setSetting('business_address', '1450 N Industrial Pkwy, Provo, UT 84604');
  const inv = get("SELECT * FROM invoices WHERE kind='school' AND status='open' ORDER BY id LIMIT 1");
  const r = await o.post(`/api/invoices/${inv.id}/email`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mail = get('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  assert.match(mail.body, /Our address: 1450 N Industrial Pkwy, Provo, UT 84604/);
  assert.doesNotMatch(mail.body, /address above/);
});

test('Today and Programs count the same workouts for the last 7 days', async () => {
  const o = await owner();
  const today = (await o.get('/api/today')).data;
  const programs = (await o.get('/api/programs/activity')).data;
  const tile = today.metrics.find((m) => m.key === 'workouts');
  assert.equal(Number(tile.value), programs.logged_7d);
  // An archived athlete's workouts leave both.
  const log = get("SELECT l.athlete_id FROM workout_logs l JOIN athletes a ON a.id=l.athlete_id WHERE a.archived=0 AND l.finished_at >= datetime('now','-7 days') LIMIT 1");
  const n = get("SELECT COUNT(*) n FROM workout_logs WHERE athlete_id=? AND finished_at >= datetime('now','-7 days')", log.athlete_id).n;
  run('UPDATE athletes SET archived=1 WHERE id=?', log.athlete_id);
  try {
    const t2 = (await o.get('/api/today')).data.metrics.find((m) => m.key === 'workouts');
    assert.equal(Number(t2.value), Number(tile.value) - n);
    assert.equal((await o.get('/api/programs/activity')).data.logged_7d, programs.logged_7d - n);
  } finally { run('UPDATE athletes SET archived=0 WHERE id=?', log.athlete_id); }
});

test('Today\'s failed payments tile matches Billing and does not claim a month', async () => {
  const o = await owner();
  const tile = (await o.get('/api/today')).data.metrics.find((m) => m.key === 'failed');
  const b = (await o.get('/api/billing/summary')).data;
  assert.equal(Number(tile.value), b.failed.count);
  assert.doesNotMatch(tile.note, /this month/);
});

test('parent Home and the client profile count attended sessions the same way', async () => {
  const ava = athlete('Ava', 'Lopez');
  const o = await owner();
  const prof = (await o.get(`/api/athletes/${ava.id}`)).data;
  const p = await parent('maria.lopez@example.com');
  const me = (await p.get('/api/parent/me')).data;
  const card = me.athletes.find((x) => x.id === ava.id);
  const attended = card.attendance || card.attended || card.visits;
  assert.ok(attended, 'the parent athlete card carries attendance');
  assert.equal(attended.last_30, prof.visits.summary.visits_30);
});

test('upload review counts PRs the way saving does: two attempts over the old best are one PR', async () => {
  const c = await coach();
  const ava = athlete('Ava', 'Lopez');
  const t = get("SELECT * FROM tests WHERE name='10-yard sprint'");
  const best = get('SELECT MIN(value) v FROM results WHERE athlete_id=? AND test_id=?', ava.id, t.id).v ?? 2.2;
  const faster = (best - 0.05).toFixed(2);
  const day = await c.post('/api/testing/days', { name: 'PR count check', athlete_ids: [ava.id], test_ids: [t.id] });
  const text = `Athlete ID\tName\t10-yard sprint (s) #1\t10-yard sprint (s) #2\n${ava.code}\tAva Lopez\t${faster}\t${faster}\n`;
  const chk = await c.post('/api/testing/upload/check', { text, day_id: day.data.id });
  assert.equal(chk.status, 200, JSON.stringify(chk.data));
  const saved = await c.post('/api/testing/upload/save', { text, day_id: day.data.id, confirmed: chk.data.unusual.map((u) => u.key) });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.prs, 1);
  assert.equal(chk.data.summary.prs, saved.data.prs, 'the review promised what saving did');
  assert.equal(chk.data.athletes[0].results.filter((r) => r.pr).length, 1, 'one PR badge');
});

test('the dashboard can check for a session without a 401 when signed out', async () => {
  const c = client();
  const probe = await c.get('/api/auth/staff/me?probe=1');
  assert.equal(probe.status, 200);
  assert.equal(probe.data, null);
  assert.equal((await c.get('/api/auth/staff/me')).status, 401, 'other callers still get 401');
  const o = await owner();
  assert.equal((await o.get('/api/auth/staff/me?probe=1')).data.email, 'owner@demo.test');
});

test('list screens have the indexes they lean on', () => {
  const names = all("SELECT name FROM sqlite_master WHERE type='index'").map((r) => r.name);
  for (const n of ['bookings_athlete', 'memberships_athlete', 'workout_logs_athlete', 'athletes_family', 'parents_family', 'invoices_family', 'invoices_contract']) assert.ok(names.includes(n), n);
});

test('demo sales and their invoices carry the same day, so Billing and Point of sale agree on the month', () => {
  for (const s of all('SELECT s.created_at, i.paid_at FROM sales s JOIN invoices i ON i.charge_id=s.charge_id WHERE i.amount_cents>0')) {
    assert.equal(s.paid_at.slice(0, 10), s.created_at.slice(0, 10));
  }
});

test('a family\'s membership request from the portal shows on the client profile until the membership reflects it', async () => {
  const ava = athlete('Ava', 'Lopez');
  const m = get("SELECT * FROM memberships WHERE athlete_id=? AND status IN ('active','trial') ORDER BY id DESC LIMIT 1", ava.id);
  assert.ok(m, 'Ava has a live membership in the demo');
  const p = await parent('maria.lopez@example.com');
  const r = await p.post('/api/parent/membership/request', { athlete_id: ava.id, kind: 'pause', note: 'Away for two weeks' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const o = await owner(), d = await desk();
  const prof = (await o.get(`/api/athletes/${ava.id}`)).data;
  assert.equal(prof.membership_request.kind, 'pause');
  assert.equal(prof.membership_request.note, 'Away for two weeks');
  assert.equal(prof.membership_request.parent_email, 'maria.lopez@example.com');
  assert.equal((await d.get(`/api/athletes/${ava.id}`)).data.membership_request.kind, 'pause', 'the front desk sees it too');
  assert.equal((await o.post(`/api/memberships/${m.id}/pause`, {})).status, 200);
  assert.equal((await o.get(`/api/athletes/${ava.id}`)).data.membership_request, null, 'done once the membership is paused');
  await o.post(`/api/memberships/${m.id}/resume`, {});
});

test('Billing and Today agree on what day it is even when the server runs in another time zone', async () => {
  const lib = require('../server/lib');
  const saved = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: a different calendar day from Provo most hours of the day
  try {
    assert.equal(lib.today(), booking.todayLocal());
    const o = await owner();
    const b = (await o.get('/api/billing/summary')).data;
    const t = (await o.get('/api/today')).data;
    assert.equal(b.month.start, t.date.slice(0, 7) + '-01');
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});
