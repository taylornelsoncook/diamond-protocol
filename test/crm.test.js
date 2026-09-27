// CRM: roles (owner everything, front desk works leads, coaches nothing), lead validation, E.164 phones and duplicate
// checks against leads and families, the pipeline (lost needs a reason, days in stage, stale), automatic moves from real
// bookings and memberships, converting a lead with no retyping (notes and evaluation carry over), re-engaging a family
// whose trial ended, tasks (and Today), the timeline, emails with unsubscribe links, segment emails that honor opt-outs,
// the public enquiry form (honeypot, rate limit, owner email), CSV import errors and export, reports, the open API and
// lead webhooks.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-crm-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.RESEND_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.DP_SMS_PROVIDER;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const { get, all, run, insert } = require('../server/db');
const { addDays } = require('../server/lib');
const booking = require('../server/services/booking');
const crm = require('../server/services/crm');

const hooks = [];
const receiver = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('{"ok":true}'); }); });
let server, base, owner, coach, desk;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  owner = await as('owner@demo.test', 'demo-owner-2026');
  coach = await as('coach@demo.test', 'demo-coach-2026');
  desk = await as('desk@demo.test', 'demo-desk-2026');
  const w = await owner.post('/webhooks', { url: `http://127.0.0.1:${receiver.address().port}/crm`, events: ['lead.created', 'lead.stage_changed'] });
  assert.equal(w.status, 200, JSON.stringify(w.data));
});
test.after(() => { server?.close(); receiver.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const isText = typeof body === 'string';
    const res = await fetch(base + '/api' + p, {
      method, headers: { ...(body !== undefined ? { 'content-type': isText ? 'text/csv' : 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? (isText ? body : JSON.stringify(body)) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return { get: (p, h) => req('GET', p, undefined, h), post: (p, b = {}, h) => req('POST', p, b, h), put: (p, b = {}) => req('PUT', p, b), del: (p) => req('DELETE', p),
    login: (email, password) => req('POST', '/auth/staff/login', { email, password }) };
}
async function as(email, pw) { const c = client(); const r = await c.login(email, pw); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }
const anon = () => client();
const T = () => booking.todayLocal();
const lastOutbox = () => get('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
const waitFor = async (fn, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return fn(); };
let seq = 0;
const newLead = (extra = {}) => { seq++; return { parent_name: `Pat Tester${seq}`, email: `pat.tester${seq}@example.com`, phone: `801-555-${String(3000 + seq).padStart(4, '0')}`, athletes: [{ name: `Sam${seq}`, age: 12 }], source: 'phone', interest: 'evaluation', ...extra }; };

test('roles: coaches have no CRM; the front desk works leads but not reports, group emails, import/export or settings', async () => {
  for (const p of ['/crm/meta', '/crm/leads', '/crm/board', '/crm/tasks', '/crm/reengage', '/crm/templates', '/crm/eval-slots']) assert.equal((await coach.get(p)).status, 403, `coach ${p}`);
  assert.equal((await coach.post('/crm/leads', newLead())).status, 403);
  const fam = get("SELECT id FROM families WHERE name LIKE 'Lopez%'").id;
  assert.equal((await coach.get(`/crm/families/${fam}/timeline?compact=1`)).status, 403);
  for (const p of ['/crm/reports', '/crm/export.csv', '/crm/settings', '/sms/outbox']) assert.equal((await desk.get(p)).status, 403, `desk ${p}`);
  assert.equal((await desk.post('/crm/group/preview', { segment: { audience: 'leads' } })).status, 403);
  assert.equal((await desk.post('/crm/group/send', { segment: { audience: 'leads' }, subject: 'x', body: 'y', expected_count: 1 })).status, 403);
  assert.equal((await desk.post('/crm/import', { text: 'Parent name,Email\nA B,a@b.co', preview: true })).status, 403);
  assert.equal((await desk.put('/crm/templates', { reset: true })).status, 403);
  assert.equal((await desk.put('/crm/settings', { notify_email: '' })).status, 403);
  const lead = (await desk.post('/crm/leads', newLead())).data.lead;
  assert.equal((await desk.del(`/crm/leads/${lead.id}`)).status, 403, 'only owners delete leads');
  assert.equal((await desk.get('/crm/leads')).status, 200);
  assert.ok(get("SELECT 1 FROM activity WHERE kind='refused' AND detail LIKE '%/api/crm/reports%'"), 'refusals are logged');
  for (const p of ['/crm/reports', '/crm/export.csv', '/crm/settings', '/sms/outbox']) assert.equal((await owner.get(p)).status, 200, `owner ${p}`);
  // No money for the front desk: evaluation times come without prices
  const slots = (await desk.get('/crm/eval-slots')).data;
  assert.ok(slots.length && slots.every((s) => !('price_cents' in s)));
  assert.ok((await owner.get('/crm/eval-slots')).data.every((s) => 'price_cents' in s));
});

test('new lead: validation, E.164 phone, duplicate check against leads and families, webhook', async () => {
  const bad = async (b, re) => { const r = await desk.post('/crm/leads', b); assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, re); };
  await bad({ ...newLead(), parent_name: ' ' }, /parent’s name/);
  await bad({ ...newLead(), email: '', phone: '' }, /email or a phone/);
  await bad({ ...newLead(), email: 'not-an-email' }, /email doesn’t look right/);
  await bad({ ...newLead(), phone: '555-12' }, /area code/);
  await bad({ ...newLead(), source: 'billboard' }, /where the lead came from/);
  await bad({ ...newLead(), source: 'referral', source_detail: '' }, /who referred/);
  await bad({ ...newLead(), interest: 'yoga' }, /interested in/);
  await bad({ ...newLead(), athletes: [{ name: 'Kid', age: 2 }] }, /age as a whole number/);
  await bad({ ...newLead(), athletes: [{ name: 'Kid', grad_year: 1990 }] }, /grad year/);
  await bad({ ...newLead(), owner_id: get("SELECT id FROM staff WHERE role='coach'").id }, /owner or front desk/);
  await bad({ ...newLead(), first_contact: addDays(T(), 3) }, /today or earlier/);

  hooks.length = 0;
  const r = await desk.post('/crm/leads', newLead({ phone: '(801) 555-7788', source: 'referral', source_detail: 'Maria Lopez', owner_id: get("SELECT id FROM staff WHERE role='frontdesk'").id }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const l = r.data.lead;
  assert.equal(l.phone, '+18015557788'); assert.equal(l.phone_display, '(801) 555-7788');
  assert.equal(l.stage, 'new'); assert.equal(l.days_in_stage, 0); assert.equal(l.stale, false); assert.equal(l.first_contact, T());
  assert.equal(l.source_label, 'Referral'); assert.equal(l.owner_name, get("SELECT name FROM staff WHERE role='frontdesk'").name);
  await waitFor(() => hooks.some((x) => x.event === 'lead.created' && x.data.id === l.id));
  assert.ok(hooks.some((x) => x.event === 'lead.created' && x.data.id === l.id && x.data.source === 'referral'), 'lead.created webhook');

  // Duplicates: same email as that lead, and a phone that belongs to a client family
  let d = await desk.post('/crm/leads', { ...newLead(), email: l.email.toUpperCase() });
  assert.equal(d.status, 409);
  assert.equal(d.data.duplicates[0].kind, 'lead'); assert.equal(d.data.duplicates[0].href, `/app/crm/leads/${l.id}`);
  d = await desk.post('/crm/leads', { ...newLead(), phone: '801.555.0142' });
  assert.equal(d.status, 409);
  const fam = d.data.duplicates.find((x) => x.kind === 'family');
  assert.equal(fam.name, 'Maria Lopez'); assert.match(fam.href, /^\/app\/clients\/\d+$/); assert.equal(fam.match, 'phone');
  d = await desk.post('/crm/leads', { ...newLead(), email: 'maria.lopez@example.com' });
  assert.equal(d.status, 409); assert.ok(d.data.duplicates.some((x) => x.kind === 'family' && x.match === 'email'));
  // The form asks first (a 200 answer) so it can warn before saving
  const pre = (await desk.get('/crm/duplicates?email=&phone=801-555-0142')).data.duplicates;
  assert.ok(pre.some((x) => x.kind === 'family' && x.name === 'Maria Lopez'));
  assert.deepEqual((await desk.get('/crm/duplicates?email=nobody.here@example.com&phone=')).data.duplicates, []);
  assert.equal((await coach.get('/crm/duplicates?email=a@b.co')).status, 403);
  const anyway = await desk.post('/crm/leads', { ...newLead(), phone: '801.555.0142', allow_duplicate: true });
  assert.equal(anyway.status, 201);
  // Edits: a changed phone clears its OK to text, and edits are checked for duplicates too
  assert.equal((await desk.put(`/crm/leads/${anyway.data.lead.id}`, { email: l.email })).status, 409);
  assert.equal((await desk.put(`/crm/leads/${anyway.data.lead.id}`, { notes: 'Prefers texts' })).data.lead.notes, 'Prefers texts');
  assert.equal((await desk.put(`/crm/leads/${anyway.data.lead.id}`, {})).status, 400);
});

test('pipeline: lost needs a reason, stage history and webhook, list filters, sort and stale leads', async () => {
  const l = (await desk.post('/crm/leads', newLead({ source: 'camp', interest: 'camp' }))).data.lead;
  let r = await desk.post(`/crm/leads/${l.id}/stage`, { stage: 'lost' });
  assert.equal(r.status, 400); assert.match(r.data.error, /why the lead was lost/);
  assert.equal((await desk.post(`/crm/leads/${l.id}/stage`, { stage: 'lost', lost_reason: 'other' })).status, 400, 'other needs a note');
  assert.equal((await desk.post(`/crm/leads/${l.id}/stage`, { stage: 'nowhere' })).status, 400);
  assert.equal((await desk.post(`/crm/leads/${l.id}/stage`, { stage: 'new' })).status, 400, 'already there');
  hooks.length = 0;
  r = await desk.post(`/crm/leads/${l.id}/stage`, { stage: 'lost', lost_reason: 'schedule' });
  assert.equal(r.status, 200);
  assert.equal(r.data.lead.stage, 'lost'); assert.equal(r.data.lead.lost_reason_label, 'Schedule');
  await waitFor(() => hooks.some((x) => x.event === 'lead.stage_changed'));
  const hk = hooks.find((x) => x.event === 'lead.stage_changed' && x.data.id === l.id);
  assert.deepEqual([hk.data.from, hk.data.to, hk.data.lost_reason, hk.data.auto], ['new', 'lost', 'schedule', false]);
  assert.ok(get("SELECT 1 FROM crm_stage_changes WHERE lead_id=? AND from_stage='new' AND to_stage='lost'", l.id));

  // Filters and search
  const list = async (q) => (await desk.get(`/crm/leads?${q}`)).data.leads;
  assert.ok((await list('stage=lost&lost_reason=schedule')).some((x) => x.id === l.id));
  assert.ok((await list('source=camp')).every((x) => x.source === 'camp'));
  assert.ok((await list('interest=camp')).some((x) => x.id === l.id));
  assert.ok((await list(`q=${encodeURIComponent(l.parent_name)}`)).some((x) => x.id === l.id));
  assert.ok((await list('q=5550188')).some((x) => x.parent_name === 'Sarah Miller'), 'phone digits');
  assert.ok((await list('stage=open')).every((x) => ['new', 'contacted', 'evaluation', 'trial'].includes(x.stage)));
  const own = get("SELECT id FROM staff WHERE role='owner'").id;
  assert.ok((await list(`owner=${own}`)).every((x) => x.owner_id === own));
  // Stale: no activity in 7 days on an open lead (Derek Owens in the demo)
  const stale = await list('stale=1');
  assert.ok(stale.some((x) => x.parent_name === 'Derek Owens')); assert.ok(stale.every((x) => x.stale && x.days_since_activity >= 7));
  assert.ok((await list('stage=lost')).every((x) => !x.stale), 'closed leads are never stale');
  const byAge = await list('sort=stage_age');
  for (let i = 1; i < byAge.length; i++) assert.ok(byAge[i - 1].days_in_stage >= byAge[i].days_in_stage);
  // Board: columns in pipeline order with counts
  const board = (await desk.get('/crm/board')).data;
  assert.deepEqual(board.columns.map((c) => c.stage), ['new', 'contacted', 'evaluation', 'trial', 'member', 'lost']);
  assert.ok(board.columns.find((c) => c.stage === 'evaluation').leads.some((x) => x.parent_name === 'Heather Lund'));
});

test('calls, notes and emails build the timeline; a first contact moves New to Contacted', async () => {
  const l = (await desk.post('/crm/leads', newLead())).data.lead;
  assert.equal((await desk.post(`/crm/leads/${l.id}/calls`, { outcome: 'maybe' })).status, 400);
  let r = await desk.post(`/crm/leads/${l.id}/calls`, { outcome: 'no_answer' });
  assert.equal(r.data.lead.stage, 'new', 'no answer is not contact');
  r = await desk.post(`/crm/leads/${l.id}/calls`, { outcome: 'reached', body: 'Wants Tuesday evenings.' });
  assert.equal(r.data.lead.stage, 'contacted');
  assert.equal((await desk.post(`/crm/leads/${l.id}/notes`, { body: '' })).status, 400);
  assert.equal((await desk.post(`/crm/leads/${l.id}/notes`, { body: 'Dad coaches 12U.' })).status, 201);
  const tpl = (await desk.get('/crm/templates')).data.find((t) => t.key === 'enquiry');
  const vars = crm.varsFor({ name: l.parent_name, athletes: ['Sam'] }, { name: 'Front Desk' });
  r = await desk.post(`/crm/leads/${l.id}/email`, { subject: crm.fill(tpl.subject, vars), body: crm.fill(tpl.body, vars) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const m = lastOutbox();
  assert.equal(m.to_email, l.email); assert.match(m.body, /Hi Pat,/); assert.match(m.body, /Unsubscribe: http.*\/unsubscribe\/l\d+\./);
  const d = (await desk.get(`/crm/leads/${l.id}`)).data;
  const kinds = d.timeline.map((x) => x.kind);
  for (const k of ['created', 'call', 'note', 'email', 'stage']) assert.ok(kinds.includes(k), k);
  assert.ok(d.timeline.find((x) => x.kind === 'call' && x.outcome === 'reached').body.includes('Tuesday'));
  assert.ok(d.timeline.find((x) => x.kind === 'stage').auto, 'the automatic move says so');
  for (let i = 1; i < d.timeline.length; i++) assert.ok(d.timeline[i - 1].at >= d.timeline[i].at, 'newest first');
});

test('automatic moves: evaluation booked, then converting (no retyping) with a trial, then an active membership', async () => {
  hooks.length = 0;
  const l = (await desk.post('/crm/leads', newLead({ parent_name: 'Rhonda Vance', email: 'rhonda.vance@example.com', phone: '801-555-4411', athletes: [{ name: 'Cole', age: 13, grad_year: 2031 }, { name: 'Mia Vance', age: 10 }], sport: 'Baseball', position: 'Pitcher', notes: 'Heard about us at the fall camp.' }))).data.lead;
  await desk.post(`/crm/leads/${l.id}/notes`, { body: 'Cole has a tight shoulder after the season.' });
  const slot = (await desk.get('/crm/eval-slots')).data[0];
  assert.equal((await desk.post(`/crm/leads/${l.id}/evaluation`, { starts_at: '2020-01-01T11:00' })).status, 400, 'not an open time');
  const invoicesBefore = get('SELECT COUNT(*) n FROM invoices').n;
  let r = await desk.post(`/crm/leads/${l.id}/evaluation`, { starts_at: slot.starts_at });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.lead.stage, 'evaluation');
  const ev = get('SELECT * FROM events WHERE id=?', r.data.event_id);
  assert.equal(ev.lead_id, l.id); assert.equal(ev.type, 'evaluation'); assert.match(ev.name, /Cole & Mia Vance/);
  assert.equal(get('SELECT COUNT(*) n FROM invoices').n, invoicesBefore, 'nothing is charged for a lead');
  assert.ok(!(await desk.get('/crm/eval-slots')).data.some((s) => s.starts_at === slot.starts_at), 'the time is taken');
  assert.equal((await desk.post(`/crm/leads/${l.id}/evaluation`, { starts_at: slot.starts_at })).status, 400, 'double booking refused');
  await waitFor(() => hooks.some((x) => x.event === 'lead.stage_changed' && x.data.to === 'evaluation' && x.data.auto));

  // Convert: the front desk can start a free trial but not a paid plan
  const paid = get('SELECT id FROM plans WHERE trial_days=0 AND active=1').id, trial = get('SELECT id FROM plans WHERE trial_days>0 AND active=1 ORDER BY id').id;
  assert.equal((await desk.post(`/crm/leads/${l.id}/convert`, { plan_id: paid })).status, 403);
  assert.equal((await desk.post(`/crm/leads/${l.id}/convert`, { program_id: get('SELECT id FROM programs LIMIT 1').id })).status, 403, 'front desk never assigns programs');
  const famBefore = get('SELECT COUNT(*) n FROM families').n;
  r = await desk.post(`/crm/leads/${l.id}/convert`, { plan_id: trial, athletes: [{ name: 'Cole', birthday: '2013-05-02', grad_year: 2031 }, { name: 'Mia Vance' }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(get('SELECT COUNT(*) n FROM families').n, famBefore + 1);
  const a = get('SELECT * FROM athletes WHERE id=?', r.data.athlete_id);
  assert.deepEqual([a.first_name, a.last_name, a.birthday, a.grad_year, a.sport, a.position], ['Cole', 'Vance', '2013-05-02', 2031, 'Baseball', 'Pitcher'], 'the parent’s last name fills in');
  assert.equal(r.data.athletes.length, 2); assert.equal(r.data.athletes[1].name, 'Mia Vance');
  const p = get('SELECT * FROM parents WHERE family_id=?', r.data.family_id);
  assert.deepEqual([p.name, p.email, p.phone_e164], ['Rhonda Vance', 'rhonda.vance@example.com', '+18015554411']);
  assert.match(lastOutbox().subject, /account/i, 'the welcome email goes, as with New client');
  const notes = all('SELECT body FROM client_notes WHERE athlete_id=?', a.id).map((n) => n.body);
  assert.ok(notes.some((n) => /fall camp/.test(n)) && notes.some((n) => /tight shoulder/.test(n)), 'notes carry over');
  assert.ok(get("SELECT 1 FROM bookings WHERE event_id=? AND athlete_id=? AND status='booked'", ev.id, a.id), 'the held evaluation now has the athlete booked');
  const lead = get('SELECT * FROM crm_leads WHERE id=?', l.id);
  assert.equal(lead.family_id, r.data.family_id); assert.equal(lead.stage, 'trial', 'a trial membership moves them to Trial');
  assert.equal((await desk.post(`/crm/leads/${l.id}/convert`, {})).status, 400, 'converted once');

  // An active membership (the trial converting) → Member
  run("UPDATE memberships SET status='active' WHERE athlete_id=?", a.id);
  const after = (await desk.get(`/crm/leads/${l.id}`)).data;
  assert.equal(after.lead.stage, 'member');
  assert.ok(after.timeline.some((x) => x.kind === 'membership'), 'membership events on the timeline');
  assert.ok(after.timeline.some((x) => x.kind === 'booking'), 'bookings on the timeline');
  // Only forward: a Member never moves back by itself
  run("UPDATE memberships SET status='trial' WHERE athlete_id=?", a.id);
  assert.equal((await desk.get(`/crm/leads/${l.id}`)).data.lead.stage, 'member');
});

test('automatic moves through the rest of the platform: a membership started on the client profile', async () => {
  const l = (await desk.post('/crm/leads', newLead({ parent_name: 'Omar Haddad', email: 'omar.haddad@example.com' }))).data.lead;
  const r = await desk.post(`/crm/leads/${l.id}/convert`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(get('SELECT stage FROM crm_leads WHERE id=?', l.id).stage, 'new', 'no booking or plan yet');
  const trial = get('SELECT id FROM plans WHERE trial_days>0 AND active=1 ORDER BY id').id;
  assert.equal((await owner.post(`/athletes/${r.data.athlete_id}/membership`, { plan_id: trial })).status, 201);
  assert.equal((await desk.get(`/crm/leads/${l.id}`)).data.lead.stage, 'trial');
  // A lost lead comes back only when they really join
  const l2 = (await desk.post('/crm/leads', newLead())).data.lead;
  const c2 = (await desk.post(`/crm/leads/${l2.id}/convert`, {})).data;
  await desk.post(`/crm/leads/${l2.id}/stage`, { stage: 'lost', lost_reason: 'price' });
  const paid = get('SELECT id FROM plans WHERE trial_days=0 AND active=1').id;
  await owner.post(`/athletes/${c2.athlete_id}/membership`, { plan_id: paid });
  crm.syncStages();
  assert.equal(get('SELECT stage FROM crm_leads WHERE id=?', l2.id).stage, 'member');
});

test('re-engage: a family whose trial ended without joining goes back into the pipeline once', async () => {
  const list = (await desk.get('/crm/reengage')).data;
  const silva = list.find((f) => f.family === 'Silva family');
  assert.ok(silva, 'the demo Silva trial ended without joining');
  assert.ok(!list.some((f) => f.family === 'Lopez family'), 'members are not listed');
  const r = await desk.post('/crm/reengage', { family_id: silva.family_id, note: 'Soccer season is over.' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const l = r.data.lead;
  assert.equal(l.family_id, silva.family_id); assert.equal(l.reengaged, true); assert.equal(l.stage, 'contacted'); assert.equal(l.parent_name, 'Paulo Silva');
  assert.equal(l.athletes[0].name, 'Isabela Silva');
  assert.equal((await desk.post('/crm/reengage', { family_id: silva.family_id })).status, 400, 'already in the pipeline');
  const lopez = get("SELECT id FROM families WHERE name LIKE 'Lopez%'").id;
  assert.equal((await desk.post('/crm/reengage', { family_id: lopez })).status, 400, 'a member family');
  // Booking an evaluation for a family on file books the athlete in, and moves the lead
  const slot = (await desk.get('/crm/eval-slots')).data[0];
  const isa = get("SELECT id FROM athletes WHERE first_name='Isabela'").id;
  const b = await desk.post(`/crm/leads/${l.id}/evaluation`, { starts_at: slot.starts_at, athlete_id: isa });
  assert.equal(b.status, 201, JSON.stringify(b.data));
  assert.ok(get("SELECT 1 FROM bookings WHERE event_id=? AND athlete_id=? AND status='booked'", b.data.event_id, isa));
  assert.equal(b.data.lead.stage, 'evaluation');
  const other = get("SELECT id FROM athletes WHERE first_name='Ava'").id;
  assert.equal((await desk.post(`/crm/leads/${l.id}/evaluation`, { starts_at: (await desk.get('/crm/eval-slots')).data[0].starts_at, athlete_id: other })).status, 400, 'only this family');
  // Cancel it from the CRM
  assert.equal((await desk.post(`/crm/evaluations/${b.data.event_id}/cancel`)).status, 200);
  assert.equal(get('SELECT cancelled FROM events WHERE id=?', b.data.event_id).cancelled, 1);
});

test('tasks: the front desk sees and completes only their own; overdue tasks show on Today with Mark done', async () => {
  const deskId = get("SELECT id FROM staff WHERE role='frontdesk'").id, ownerId = get("SELECT id FROM staff WHERE role='owner'").id;
  const l = (await desk.post('/crm/leads', newLead())).data.lead;
  assert.equal((await desk.post('/crm/tasks', { title: '', due_date: T(), assignee_id: deskId })).status, 400);
  assert.equal((await desk.post('/crm/tasks', { title: 'Call back', due_date: 'soon', assignee_id: deskId })).status, 400);
  assert.equal((await desk.post('/crm/tasks', { title: 'Call back', due_date: T(), assignee_id: get("SELECT id FROM staff WHERE role='coach'").id })).status, 400, 'not coaches');
  assert.equal((await desk.post('/crm/tasks', { title: 'Call back', due_date: T(), assignee_id: deskId, lead_id: 99999 })).status, 404);
  const mine = (await desk.post('/crm/tasks', { title: 'Call Pat back', due_date: addDays(T(), -1), assignee_id: deskId, lead_id: l.id })).data.task;
  const theirs = (await desk.post('/crm/tasks', { title: 'Owner: send quote', due_date: T(), assignee_id: ownerId, lead_id: l.id })).data.task;
  assert.equal(mine.overdue, true); assert.equal(theirs.due_today, true);
  const deskList = (await desk.get('/crm/tasks?scope=all')).data;
  assert.equal(deskList.scope, 'mine'); assert.ok(deskList.tasks.every((t) => t.assignee_id === deskId));
  assert.ok((await owner.get('/crm/tasks?scope=all')).data.tasks.some((t) => t.id === mine.id));
  assert.equal((await desk.post(`/crm/tasks/${theirs.id}/done`)).status, 404, 'not theirs to see');
  assert.ok(!(await desk.get(`/crm/leads/${l.id}`)).data.tasks.some((t) => t.id === theirs.id));
  // Today: overdue and due-today tasks for the assignee only
  const today = (await desk.get('/today')).data.attention.filter((a) => a.kind === 'crm_task');
  const item = today.find((a) => a.title === 'Call Pat back');
  assert.ok(item); assert.match(item.detail, /Overdue/); assert.equal(item.action.post, `/crm/tasks/${mine.id}/done`); assert.equal(item.href, `/app/crm/leads/${l.id}`);
  assert.ok(!today.some((a) => a.title === 'Owner: send quote'));
  assert.ok((await owner.get('/today')).data.attention.some((a) => a.kind === 'crm_task' && a.title === 'Owner: send quote'));
  assert.ok(!(await coach.get('/today')).data.attention.some((a) => a.kind === 'crm_task'));
  // Mark done from Today, then undo
  const done = await desk.post(item.action.post);
  assert.equal(done.status, 200); assert.match(done.data.message, /Done: Call Pat back/);
  assert.ok(!(await desk.get('/today')).data.attention.some((a) => a.title === 'Call Pat back'));
  assert.equal((await desk.post(`/crm/tasks/${mine.id}/done`)).status, 400);
  assert.ok((await desk.get(`/crm/leads/${l.id}`)).data.timeline.some((x) => x.kind === 'task' && x.body === 'Call Pat back'));
  assert.equal((await desk.post(`/crm/tasks/${mine.id}/undo`)).data.task.done, false);
  assert.equal((await desk.put(`/crm/tasks/${mine.id}`, { due_date: addDays(T(), 2) })).data.task.overdue, false);
  assert.equal((await desk.del(`/crm/tasks/${mine.id}`)).status, 200);
});

test('family timeline: compact on the client profile, payments for owners only', async () => {
  const park = get("SELECT id FROM families WHERE name LIKE 'Park%'").id;
  const o = (await owner.get(`/crm/families/${park}/timeline?compact=1`)).data;
  assert.ok(o.timeline.length <= 8);
  assert.ok(o.leads.some((l) => l.parent_name === 'Grace Park' && l.stage === 'member'));
  const full = (await owner.get(`/crm/families/${park}/timeline`)).data.timeline;
  assert.ok(full.some((x) => x.kind === 'payment'), 'owners see payments');
  assert.ok(full.some((x) => x.kind === 'converted'));
  const d = (await desk.get(`/crm/families/${park}/timeline`)).data.timeline;
  assert.ok(!d.some((x) => x.kind === 'payment'), 'no money for the front desk');
  assert.ok(!/\$\d/.test(JSON.stringify(d)));
});

test('segment emails: preview with count, opt-outs left out, send checks the count; unsubscribe link works', async () => {
  const seg = { audience: 'leads', stage: 'lost', lost_reason: 'schedule' };
  let p = (await owner.post('/crm/group/preview', { segment: seg, channel: 'email' })).data;
  assert.match(p.description, /Lost leads, lost for schedule/);
  assert.ok(p.recipients.some((r) => r.name === 'Nina Patel'));
  assert.ok(!p.recipients.some((r) => r.name === 'Amy Fischer'), 'Amy unsubscribed');
  assert.ok(p.excluded.some((r) => r.name === 'Amy Fischer' && r.reason === 'unsubscribed'));
  assert.equal(p.count, p.recipients.length);
  const send = { segment: seg, channel: 'email', subject: 'New morning times for {athlete}', body: 'Hi {first_name}, we added weekday morning sessions.' };
  let r = await owner.post('/crm/group/send', { ...send, expected_count: p.count + 1 });
  assert.equal(r.status, 409, 'the list changed');
  const before = get('SELECT COUNT(*) n FROM outbox').n;
  r = await owner.post('/crm/group/send', { ...send, expected_count: p.count });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.sent, p.count);
  assert.equal(get('SELECT COUNT(*) n FROM outbox').n, before + p.count);
  const nina = get("SELECT * FROM outbox WHERE to_email='nina.patel@example.com' ORDER BY id DESC LIMIT 1");
  assert.equal(nina.subject, 'New morning times for Arjun'); assert.match(nina.body, /^Hi Nina,/);
  assert.ok(!get("SELECT 1 FROM outbox WHERE to_email='amy.fischer@example.com'"), 'never emailed');
  assert.ok(get("SELECT 1 FROM activity WHERE action='Sent a group email'"));
  const ninaId = get("SELECT id FROM crm_leads WHERE parent_name='Nina Patel'").id;
  assert.ok((await owner.get(`/crm/leads/${ninaId}`)).data.timeline.some((x) => x.kind === 'email'), 'on each timeline');

  // Unsubscribe from the link in the email: public, signed, and the next group email leaves them out
  const token = /\/unsubscribe\/([^\s]+)/.exec(nina.body)[1];
  assert.equal((await anon().get('/public/unsubscribe/l1.AAAAAAAAAAAAAAAAAAAAAA')).status, 400, 'a forged token');
  const info = (await anon().get(`/public/unsubscribe/${token}`)).data;
  assert.match(info.email, /^ni•+@example\.com$/); assert.equal(info.already, false);
  assert.equal((await anon().post(`/public/unsubscribe/${token}`)).data.ok, true);
  assert.equal((await anon().post(`/public/unsubscribe/${token}`)).data.already, true);
  p = (await owner.post('/crm/group/preview', { segment: seg, channel: 'email' })).data;
  assert.ok(!p.recipients.some((r) => r.name === 'Nina Patel'));
  const one = await desk.post(`/crm/leads/${ninaId}/email`, { subject: 'Hi', body: 'Checking in' });
  assert.equal(one.status, 400); assert.match(one.data.error, /unsubscribed/);
  // Only an owner can subscribe them again (when they ask)
  assert.equal((await desk.post(`/crm/leads/${ninaId}/consent`, { email_opt_out: false })).status, 403);
  assert.equal((await owner.post(`/crm/leads/${ninaId}/consent`, { email_opt_out: false })).status, 200);

  // Trials that ended without joining: parents, with their own unsubscribe link
  p = (await owner.post('/crm/group/preview', { segment: { audience: 'trials_ended' }, channel: 'email' })).data;
  assert.ok(p.recipients.some((r) => r.kind === 'parent' && r.name === 'Paulo Silva'));
  const paulo = get("SELECT id FROM parents WHERE email='paulo.silva@example.com'").id;
  run('UPDATE parents SET email_opt_out=1 WHERE id=?', paulo);
  p = (await owner.post('/crm/group/preview', { segment: { audience: 'trials_ended' }, channel: 'email' })).data;
  assert.ok(p.excluded.some((r) => r.name === 'Paulo Silva' && r.reason === 'unsubscribed'));
  run('UPDATE parents SET email_opt_out=0 WHERE id=?', paulo);
  // Leads by interest
  p = (await owner.post('/crm/group/preview', { segment: { audience: 'leads', interest: 'privates' }, channel: 'email' })).data;
  assert.ok(p.recipients.length && p.recipients.every((r) => r.kind === 'lead'));
  assert.equal((await owner.post('/crm/group/send', { segment: { audience: 'leads', stage: 'member', interest: 'camp', source: 'social' }, channel: 'email', subject: 'x', body: 'y', expected_count: 0 })).status, 400, 'nobody to send to');
});

test('templates: owners edit and reset; placeholders fill in', async () => {
  const list = (await owner.get('/crm/templates')).data;
  assert.deepEqual(list.map((t) => t.key), ['enquiry', 'evaluation', 'trial_ending', 'winback']);
  const edited = list.map((t) => (t.key === 'winback' ? { ...t, subject: 'We miss {athlete}' } : t));
  assert.equal((await owner.put('/crm/templates', { templates: edited.map((t) => (t.key === 'enquiry' ? { ...t, body: '' } : t)) })).status, 400);
  assert.equal((await owner.put('/crm/templates', { templates: edited })).data.find((t) => t.key === 'winback').subject, 'We miss {athlete}');
  assert.equal((await desk.get('/crm/templates')).data.find((t) => t.key === 'winback').subject, 'We miss {athlete}');
  assert.equal(crm.fill('We miss {athlete}', crm.varsFor({ name: 'Al B', athletes: ['Cy D', 'Ed F'] }, null)), 'We miss Cy and Ed');
  assert.notEqual((await owner.put('/crm/templates', { reset: true })).data.find((t) => t.key === 'winback').subject, 'We miss {athlete}');
});

test('website enquiry form: creates a website lead, emails the owner, honeypot and rate limit', async () => {
  crm._resetEnquiryLimit();
  const form = { parent_name: 'Wendy Form', email: 'wendy.form@example.com', phone: '801 555 6120', athlete_name: 'Zeke', athlete_age: 12, sport: 'Baseball', interest: 'evaluation', message: 'Looking for pitching help.', sms_opt_in: true };
  const ip = { 'x-forwarded-for': '203.0.113.7' };
  const before = get('SELECT COUNT(*) n FROM crm_leads').n;
  // Honeypot: looks like it worked, nothing saved
  let r = await anon().post('/public/enquiry', { ...form, website: 'http://spam.example' }, ip);
  assert.equal(r.status, 200); assert.equal(r.data.ok, true);
  assert.equal(get('SELECT COUNT(*) n FROM crm_leads').n, before);
  assert.equal((await anon().post('/public/enquiry', { ...form, email: '' }, ip)).status, 400);
  r = await anon().post('/public/enquiry', form, ip);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const l = get("SELECT * FROM crm_leads WHERE email='wendy.form@example.com'");
  assert.equal(l.source, 'website'); assert.equal(l.stage, 'new'); assert.equal(l.phone, '+18015556120');
  assert.equal(JSON.parse(l.athletes)[0].name, 'Zeke'); assert.equal(l.sms_opt_in, 1); assert.match(l.sms_opt_in_source, /website form/);
  const note = get("SELECT * FROM outbox WHERE subject='New enquiry: Wendy Form'");
  assert.ok(note, 'owner notified'); assert.equal(note.to_email, 'owner@demo.test'); assert.match(note.body, /pitching help/); assert.match(note.body, new RegExp(`/app/crm/leads/${l.id}`));
  // Writing in again adds to the same lead
  r = await anon().post('/public/enquiry', { ...form, message: 'Any Saturday times?' }, ip);
  assert.equal(r.status, 201);
  assert.equal(get("SELECT COUNT(*) n FROM crm_leads WHERE email='wendy.form@example.com'").n, 1);
  // Rate limit: 5 per 10 minutes from one address (the honeypot hit didn't count)
  for (let i = 0; i < 3; i++) await anon().post('/public/enquiry', { ...form, email: `w${i}@example.com`, phone: '' }, ip);
  r = await anon().post('/public/enquiry', { ...form, email: 'w9@example.com', phone: '' }, ip);
  assert.equal(r.status, 429); assert.match(r.data.error, /already have your enquiry/);
  assert.equal((await anon().post('/public/enquiry', { ...form, email: 'other.ip@example.com', phone: '' }, { 'x-forwarded-for': '203.0.113.99' })).status, 201, 'another address is fine');
  // The page and its embed
  const page = await fetch(base + '/enquire');
  assert.equal(page.status, 200); assert.equal(page.headers.get('x-frame-options'), null); assert.match(page.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal((await fetch(base + '/app')).headers.get('x-frame-options'), 'SAMEORIGIN', 'the dashboard still can’t be framed');
  const s = (await owner.get('/crm/settings')).data;
  assert.match(s.embed, /<iframe src="http.*\/enquire\?embed=1"/);
  assert.equal((await owner.put('/crm/settings', { notify_email: 'nope' })).status, 400);
  assert.equal((await owner.put('/crm/settings', { notify_email: 'leads@example.com' })).status, 200);
  crm._resetEnquiryLimit();
  await anon().post('/public/enquiry', { ...form, email: 'second.notify@example.com', phone: '' }, ip);
  assert.equal(get("SELECT to_email FROM outbox WHERE subject LIKE 'New enquiry:%' ORDER BY id DESC LIMIT 1").to_email, 'leads@example.com');
  await owner.put('/crm/settings', { notify_email: '' });
});

test('CSV import: preview with row errors and duplicates before saving; export', async () => {
  const csv = [
    'Parent name,Email,Phone,Athlete,Age,Grad year,Sport,Source,Referred by,Interest,Notes',
    'Ivy Import,ivy.import@example.com,801-555-9001,Max,11,,Baseball,Website form,,Group training,From the fall fair',
    'Bo Import,bo.import@example.com,,Ty,,2030,Baseball,Referral,Kurt Jensen,Evaluation,',
    ',nameless@example.com,,,,,,,,,',
    'Cy Import,bad-email,,,,,,,,,',
    'Di Import,di.import@example.com,,,,,,Billboard,,,',
    'Maria Lopez,maria.lopez@example.com,,,,,,,,,',
    'Ivy Again,ivy.import@example.com,,,,,,,,,',
  ].join('\n');
  let r = await owner.post('/crm/import', { text: csv, preview: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.counts, { new: 2, duplicate: 2, error: 3 });
  const row = (line) => r.data.rows.find((x) => x.line === line);
  assert.match(row(4).error, /parent’s name/); assert.match(row(5).error, /email/); assert.match(row(6).error, /isn't a source/);
  assert.match(row(7).reason, /Already on file: Maria Lopez/); assert.match(row(8).reason, /earlier in this file/);
  assert.equal(get("SELECT COUNT(*) n FROM crm_leads WHERE email='ivy.import@example.com'").n, 0, 'preview saves nothing');
  r = await owner.post('/crm/import', { text: csv });
  assert.equal(r.status, 400); assert.match(r.data.error, /^Row 4:/); assert.equal(r.data.errors.length, 3);
  r = await owner.post('/crm/import', { text: csv, skip_errors: true });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.deepEqual([r.data.created, r.data.errors], [2, 3]);
  const ivy = get("SELECT * FROM crm_leads WHERE email='ivy.import@example.com'");
  assert.deepEqual([ivy.source, ivy.interest, ivy.phone, JSON.parse(ivy.athletes)[0].age], ['website', 'group', '+18015559001', 11]);
  assert.equal(get("SELECT source_detail FROM crm_leads WHERE email='bo.import@example.com'").source_detail, 'Kurt Jensen');
  assert.equal((await owner.post('/crm/import', { text: 'Name only\nX' , preview: true })).status, 400);
  assert.equal((await owner.post('/crm/import', { text: csv, skip_errors: true })).status, 400, 'nothing new the second time');
  // Export: a CSV of the filtered list, spreadsheet-safe
  run("UPDATE crm_leads SET notes='=HYPERLINK(\"x\")' WHERE id=?", ivy.id);
  const ex = await fetch(base + '/api/crm/export.csv?source=website', { headers: { cookie: (await loginCookie()) } });
  const text = await ex.text();
  assert.match(ex.headers.get('content-type'), /text\/csv/); assert.match(text, /^﻿?Parent name,Email,Phone/);
  assert.match(text, /Ivy Import/); assert.ok(!/Bo Import/.test(text), 'filtered by source'); assert.match(text, /'=HYPERLINK/);
});
async function loginCookie() {
  const r = await fetch(base + '/api/auth/staff/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@demo.test', password: 'demo-owner-2026' }) });
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

test('reports: by source, conversion, time to member, lost reasons and stages for a period', async () => {
  const r = (await owner.get(`/crm/reports?from=${addDays(T(), -120)}&to=${T()}`)).data;
  assert.ok(r.leads > 10);
  assert.equal(r.stages.reduce((n, s) => n + s.count, 0), r.leads);
  assert.equal(r.by_source.reduce((n, s) => n + s.leads, 0), r.leads);
  assert.ok(r.by_source.some((s) => s.source === 'website'));
  const ref = r.by_source.find((s) => s.source === 'referral');
  assert.equal(ref.rate, Math.round((ref.members / ref.leads) * 100));
  assert.equal(r.conversion_rate, Math.round((r.members / r.leads) * 100));
  assert.ok(r.lost_reasons.some((x) => x.reason === 'schedule' && x.count >= 1));
  assert.ok(r.time_to_member.count >= 1 && r.time_to_member.average_days >= 0);
  assert.equal((await owner.get('/crm/reports?from=2026-13-01&to=2026-01-01')).status, 400);
  assert.equal((await owner.get(`/crm/reports?from=${T()}&to=${addDays(T(), -5)}`)).status, 400);
  const empty = (await owner.get('/crm/reports?from=2001-01-01&to=2001-01-31')).data;
  assert.equal(empty.leads, 0); assert.equal(empty.conversion_rate, null);
});

test('open API: list, get and create leads with a key; read-only keys can’t create', async () => {
  const full = (await owner.post('/api-keys', { label: 'Website', scope: 'full' })).data.key;
  const ro = (await owner.post('/api-keys', { label: 'Reports', scope: 'read' })).data.key;
  const auth = (k) => ({ authorization: `Bearer ${k}` });
  assert.equal((await anon().get('/v1/leads')).status, 401);
  let r = await anon().get('/v1/leads?stage=new&limit=5', auth(ro));
  assert.equal(r.status, 200); assert.ok(r.data.data.every((l) => l.stage === 'new')); assert.ok(r.data.total >= r.data.data.length);
  assert.equal((await anon().get('/v1/leads?stage=warm', auth(ro))).status, 400);
  assert.equal((await anon().get(`/v1/leads/${r.data.data[0].id}`, auth(ro))).data.data.id, r.data.data[0].id);
  assert.equal((await anon().post('/v1/leads', { parent_name: 'Api Person', email: 'api.person@example.com' }, auth(ro))).status, 403);
  r = await anon().post('/v1/leads', { parent_name: 'Api Person', email: 'api.person@example.com', source: 'website', athletes: [{ name: 'Kid', age: 9 }] }, auth(full));
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.data.source, 'website');
  assert.equal((await anon().post('/v1/leads', { parent_name: 'Api Person', email: 'api.person@example.com' }, auth(full))).status, 409);
  assert.equal((await anon().post('/v1/leads', { parent_name: '', email: 'x@example.com' }, auth(full))).status, 400);
  assert.ok((await owner.get('/integrations')).data.events.includes('lead.stage_changed'));
});

test('delete a lead (owners): refused while an evaluation is held', async () => {
  const l = (await desk.post('/crm/leads', newLead())).data.lead;
  const slot = (await desk.get('/crm/eval-slots')).data[0];
  const ev = (await desk.post(`/crm/leads/${l.id}/evaluation`, { starts_at: slot.starts_at })).data.event_id;
  assert.equal((await owner.del(`/crm/leads/${l.id}`)).status, 400);
  await desk.post(`/crm/evaluations/${ev}/cancel`);
  assert.equal((await owner.del(`/crm/leads/${l.id}`)).status, 200);
  assert.equal((await owner.get(`/crm/leads/${l.id}`)).status, 404);
});
