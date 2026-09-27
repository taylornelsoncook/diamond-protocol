// Clients: list views, sorting and flags; new-client duplicate and existing-family checks; grad year and phone;
// staff notes (pinned, coach-only); visit history; parent edits, removal and portal email; paper waivers;
// archiving cancels upcoming bookings; front desk can't assign programs; coaches never see a walk-in price.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-clients-test-'));
process.env.DP_DATA_DIR = tmp;
process.env.DP_DB = path.join(tmp, 'test.db');
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const { seed } = require('../server/seed');
seed({ withDemo: true });
const { app } = require('../server/index');
const { get, insert } = require('../server/db');
const booking = require('../server/services/booking');
const { addDays } = require('../server/lib');

let server, base, owner, coach, desk;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await as('owner@demo.test', 'demo-owner-2026');
  coach = await as('coach@demo.test', 'demo-coach-2026');
  desk = await as('desk@demo.test', 'demo-desk-2026');
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + '/api' + p, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), put: (p, b = {}) => req('PUT', p, b), del: (p) => req('DELETE', p),
    login: (email, password) => req('POST', '/auth/staff/login', { email, password }) };
}
async function as(email, pw) { const c = client(); const r = await c.login(email, pw); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }
const athleteId = (first, last) => get('SELECT id FROM athletes WHERE first_name=? AND last_name=?', first, last).id;
const hasMoney = (obj) => /price_cents|_cents"|\$\d/.test(JSON.stringify(obj));

test('list: counts for every view, flags, archived view, sorting, search by phone', async () => {
  const r = await desk.get('/clients');
  assert.equal(r.status, 200);
  const { counts, clients } = r.data;
  assert.equal(counts.past_due, 2);
  assert.ok(counts.team >= 9);
  assert.equal(counts.archived, 1, 'the demo has one archived client');
  assert.ok(counts.no_waiver >= 1, 'the Silva family has no waiver');
  const isa = clients.find((c) => c.first_name === 'Isabela');
  assert.equal(isa.waiver_missing, true);
  assert.equal(isa.no_card, true);
  const ava = clients.find((c) => c.first_name === 'Ava');
  assert.equal(ava.medical, true, 'Ava has an allergy on file');
  assert.equal(ava.pinned_notes, 1);
  assert.equal(ava.grad_year, 2030);
  assert.ok(ava.last_seen && ava.last_visit, 'last visit and last seen');
  assert.ok(clients.every((c) => !('card_last4' in c) && !('waiver_version' in c)), 'raw family fields stay on the server');
  const team = clients.find((c) => c.status === 'team');
  assert.equal(team.waiver_missing, false, 'team-only athletes have no family waiver to chase');

  const noWaiver = (await desk.get('/clients?status=no_waiver')).data.clients;
  assert.ok(noWaiver.length >= 1 && noWaiver.every((c) => c.waiver_missing));
  const archived = (await desk.get('/clients?status=archived')).data;
  assert.deepEqual(archived.clients.map((c) => c.first_name), ['Ryan']);
  assert.equal((await desk.get('/clients?q=Ryan')).data.clients.length, 0, 'archived clients stay out of the main list');
  assert.equal((await desk.get('/clients?q=Ryan')).data.counts.archived, 1, 'but the search says one is archived');

  const quiet = (await owner.get('/clients?sort=last_seen')).data.clients;
  const firstSeen = quiet.findIndex((c) => c.last_seen);
  assert.ok(firstSeen > 0 && quiet.slice(0, firstSeen).every((c) => !c.last_seen), 'never seen first');
  const seen = quiet.slice(firstSeen).map((c) => c.last_seen);
  assert.deepEqual(seen, [...seen].sort(), 'then longest ago first');
  const newest = (await owner.get('/clients?sort=newest')).data.clients;
  assert.ok(newest[0].created_at >= newest[newest.length - 1].created_at);

  assert.deepEqual((await owner.get('/clients?q=555-0288')).data.clients.map((c) => c.first_name), ['Daniel'], 'athlete phone');
  assert.ok((await owner.get('/clients?q=555-0142')).data.clients.some((c) => c.first_name === 'Ava'), 'parent phone');
  for (const who of [coach, desk]) assert.equal(hasMoney((await who.get('/clients')).data), false);
});

test('new client: likely duplicates need a second yes; an existing parent email points to the family', async () => {
  const dup = await desk.post('/clients', { name: 'ava lopez', birthday: '2012-04-18', parent_name: 'Someone Else', parent_email: 'someone.else@example.com' });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /may already be a client/);
  assert.equal(dup.data.duplicates[0].code, 'AVALOP2026');
  assert.equal(get("SELECT COUNT(*) n FROM parents WHERE email='someone.else@example.com'").n, 0, 'nothing was created');
  const diffBirthday = await desk.post('/clients', { name: 'Ava Lopez', birthday: '2015-01-01', parent_name: 'Other Lopez', parent_email: 'other.lopez@example.com' });
  assert.equal(diffBirthday.status, 201, 'same name, different birthday is someone else');
  const archivedDup = await desk.post('/clients', { name: 'Ryan Cho', parent_name: 'Grace Two', parent_email: 'grace.two@example.com' });
  assert.equal(archivedDup.status, 409);
  assert.equal(archivedDup.data.duplicates[0].archived, true, 'archived clients count, so they can be restored instead');
  const anyway = await desk.post('/clients', { name: 'Ryan Cho', parent_name: 'Grace Two', parent_email: 'grace.two@example.com', allow_duplicate: true });
  assert.equal(anyway.status, 201);

  const taken = await desk.post('/clients', { name: 'New Kid', parent_name: 'Maria Lopez', parent_email: 'MARIA.LOPEZ@example.com' });
  assert.equal(taken.status, 400);
  assert.match(taken.data.error, /Add sibling/);
  assert.equal(taken.data.existing.athlete_id, athleteId('Ava', 'Lopez'));
  assert.equal(taken.data.existing.family, 'Lopez family');
});

test('new client: intake details, grad year and future birthdays; front desk cannot assign a program', async () => {
  const program = get('SELECT id FROM programs WHERE archived=0 LIMIT 1');
  const refused = await desk.post('/clients', { name: 'Desk Kid', parent_name: 'Desk Parent', parent_email: 'desk.parent@example.com', program_id: program.id });
  assert.equal(refused.status, 403);
  assert.equal(get("SELECT COUNT(*) n FROM parents WHERE email='desk.parent@example.com'").n, 0);
  assert.equal((await desk.post('/clients', { name: 'Late Kid', birthday: '2099-01-01', parent_name: 'P', parent_email: 'late.kid@example.com' })).status, 400);
  assert.equal((await desk.post('/clients', { name: 'Bad Date', birthday: '2012-02-31', parent_name: 'P', parent_email: 'bad.date@example.com' })).status, 400);
  assert.equal((await desk.post('/clients', { name: 'Grad Kid', grad_year: '29', parent_name: 'P', parent_email: 'grad.kid@example.com' })).status, 400);
  const ok = await desk.post('/clients', { name: 'Grad Kid', grad_year: '2029', position: 'SS', allergies: 'Bees', emergency_name: 'Aunt May', emergency_phone: '801-555-0100',
    athlete_phone: '801-555-0102', parent_name: 'Pat Kid', parent_email: 'grad.kid@example.com', parent_phone: '801-555-0101', phone: 'stale hidden field' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const a = get('SELECT * FROM athletes WHERE id=?', ok.data.id);
  assert.deepEqual([a.grad_year, a.position, a.allergies, a.emergency_name, a.phone], [2029, 'SS', 'Bees', 'Aunt May', '801-555-0102']);
  const adult = await desk.post('/clients', { with_parent: false, name: 'Adult Self', email: 'adult.self@example.com', phone: '801-555-0103' });
  assert.equal(get('SELECT phone FROM athletes WHERE id=?', adult.data.id).phone, '801-555-0103', 'an adult\'s phone is theirs too');
  const coachOk = await coach.post('/clients', { name: 'Coach Kid', parent_name: 'Coach Parent', parent_email: 'coach.parent@example.com', program_id: program.id });
  assert.equal(coachOk.status, 201);
  const fam = get('SELECT family_id FROM athletes WHERE id=?', coachOk.data.id).family_id;
  assert.equal((await desk.post(`/families/${fam}/athletes`, { name: 'Coach Kid2', program_id: program.id })).status, 403, 'sibling too');
  assert.equal((await desk.post(`/families/${fam}/athletes`, { name: 'Coach Kidtwo' })).status, 201);
});

test('profile: grad year and phone save; empty saves are refused', async () => {
  const id = athleteId('Nate', 'Jensen');
  assert.equal((await desk.put(`/athletes/${id}`, { grad_year: '2031', phone: '801-555-0199' })).status, 200);
  assert.deepEqual({ ...get('SELECT grad_year, phone FROM athletes WHERE id=?', id) }, { grad_year: 2031, phone: '801-555-0199' });
  assert.equal((await desk.put(`/athletes/${id}`, { grad_year: 'next year' })).status, 400);
  assert.equal((await desk.put(`/athletes/${id}`, { grad_year: '' })).status, 200);
  assert.equal(get('SELECT grad_year FROM athletes WHERE id=?', id).grad_year, null);
  assert.equal((await desk.put(`/athletes/${id}`, { birthday: '2090-01-01' })).status, 400);
  assert.equal((await desk.put(`/athletes/${id}`, {})).status, 400);
});

test('profile: visit history counts attended, no-shows and late cancels', async () => {
  const id = athleteId('Ava', 'Lopez');
  const d = (await desk.get(`/athletes/${id}`)).data;
  assert.ok(d.visits.summary.visits_30 >= 1);
  assert.ok(d.visits.summary.last_visit);
  assert.ok(d.visits.history.length >= 1);
  assert.ok(d.visits.history.every((h) => ['attended', 'no_show', 'late_cancel'].includes(h.outcome)));
  const now = booking.nowLocal();
  assert.ok(d.visits.history.every((h) => h.starts_at < now), 'only past sessions');
  assert.equal(typeof d.upcoming_total, 'number');
  // A booked session in the past without a check-in is a no-show.
  const ev = insert('events', { name: 'Past clinic', type: 'clinic', starts_at: `${addDays(booking.todayLocal(), -1)}T06:00`, duration_min: 60, capacity: 10 });
  insert('bookings', { event_id: ev, athlete_id: id, status: 'booked', coverage: 'member' });
  const d2 = (await desk.get(`/athletes/${id}`)).data;
  assert.ok(d2.visits.history.some((h) => h.event_id === ev && h.outcome === 'no_show'));
  assert.ok(d2.visits.summary.no_shows_30 >= 1);
});

test('notes: everyone writes, pinned first; coach-only notes are hidden from the front desk; only the author edits', async () => {
  const id = athleteId('Olivia', 'Park');
  assert.equal((await desk.post(`/athletes/${id}/notes`, { body: '  ' })).status, 400);
  assert.equal((await desk.post(`/athletes/${id}/notes`, { body: 'x', coach_only: true })).status, 403);
  const n1 = await desk.post(`/athletes/${id}/notes`, { body: 'Dad asked for a call about the card.' });
  assert.equal(n1.status, 201);
  const n2 = await coach.post(`/athletes/${id}/notes`, { body: 'Hamstring tight; keep sprints submax.', coach_only: true });
  const n3 = await owner.post(`/athletes/${id}/notes`, { body: 'Grandma picks up on Fridays.', pinned: true });
  const coachView = (await coach.get(`/athletes/${id}`)).data.notes;
  assert.equal(coachView[0].id, n3.data.id, 'pinned first');
  assert.ok(coachView.some((n) => n.id === n2.data.id && n.coach_only));
  const deskView = (await desk.get(`/athletes/${id}`)).data.notes;
  assert.equal(deskView.some((n) => n.id === n2.data.id), false, 'front desk never sees coach-only notes');
  assert.equal(deskView.find((n) => n.id === n1.data.id).mine, true);
  assert.equal((await desk.put(`/notes/${n2.data.id}`, { pinned: true })).status, 404);
  assert.equal((await desk.del(`/notes/${n2.data.id}`)).status, 404);
  // Anyone who can see a note can pin it; only the author changes the words; author or owner deletes.
  assert.equal((await desk.put(`/notes/${n3.data.id}`, { pinned: false })).status, 200);
  assert.equal(get('SELECT pinned FROM client_notes WHERE id=?', n3.data.id).pinned, 0);
  assert.equal((await desk.put(`/notes/${n3.data.id}`, { body: 'changed' })).status, 403);
  assert.equal((await desk.put(`/notes/${n1.data.id}`, { body: 'Dad asked for a call about the card. Called back.' })).status, 200);
  assert.equal((await coach.del(`/notes/${n1.data.id}`)).status, 403);
  assert.equal((await owner.del(`/notes/${n1.data.id}`)).status, 200);
  assert.equal((await desk.del(`/notes/${n3.data.id}`)).status, 403);
  assert.ok(get("SELECT 1 FROM activity WHERE action='Added a client note' AND detail LIKE '%Olivia Park (coaches only)%'"));
  assert.equal((await desk.get('/clients?q=Olivia')).data.clients[0].pinned_notes, 0);
});

test('parents: fix contact details, remove a second parent, re-send the portal email', async () => {
  const fam = get("SELECT family_id FROM parents WHERE email='kurt.jensen@example.com'").family_id;
  const kurt = get("SELECT id FROM parents WHERE email='kurt.jensen@example.com'").id;
  assert.equal((await desk.put(`/parents/${kurt}`, { email: 'maria.lopez@example.com' })).status, 400, 'email taken');
  assert.equal((await desk.put(`/parents/${kurt}`, { email: 'not-an-email' })).status, 400);
  assert.equal((await desk.put(`/parents/${kurt}`, { name: '' })).status, 400);
  assert.equal((await desk.put(`/parents/${kurt}`, { phone: '385-555-0110', email: 'Kurt.Jensen@Example.com' })).status, 200, 'same email, other case is fine');
  assert.equal(get('SELECT phone FROM parents WHERE id=?', kurt).phone, '385-555-0110');
  assert.equal((await desk.del(`/parents/${kurt}`)).status, 400, 'the only parent stays');
  const add = await desk.post(`/families/${fam}/parents`, { name: 'Jess Jensen', email: 'jess.jensen@example.com' });
  assert.equal(add.status, 201);
  assert.equal((await desk.put(`/parents/${add.data.id}`, { email: 'jessica.jensen@example.com' })).status, 200);
  assert.ok(get("SELECT 1 FROM activity WHERE action='Updated parent' AND detail LIKE '%jess.jensen@example.com to jessica.jensen@example.com%'"));
  const w = await desk.post(`/parents/${add.data.id}/welcome`);
  assert.equal(w.status, 200);
  assert.ok(get("SELECT 1 FROM outbox WHERE to_email='jessica.jensen@example.com' AND body LIKE '%/parent%'"));
  insert('auth_sessions', { token_hash: 'jess-session', kind: 'parent', user_id: add.data.id, expires_at: '2099-01-01T00:00:00Z' });
  assert.equal((await desk.del(`/parents/${add.data.id}`)).status, 200);
  assert.equal(get('SELECT COUNT(*) n FROM parents WHERE id=?', add.data.id).n, 0);
  assert.equal(get("SELECT COUNT(*) n FROM auth_sessions WHERE token_hash='jess-session'").n, 0, 'their sign-in ends');
  const self = get("SELECT id FROM parents WHERE is_self=1 LIMIT 1");
  if (self) assert.equal((await owner.del(`/parents/${self.id}`)).status, 400, 'an adult keeps their own login');
});

test('paper waiver: recorded by the desk against the current version, once', async () => {
  const fam = get('SELECT family_id FROM athletes WHERE first_name=? AND last_name=?', 'Isabela', 'Silva').family_id;
  assert.equal((await desk.post(`/families/${fam}/waiver`, { signed_by: ' ' })).status, 400);
  assert.equal((await desk.post(`/families/${fam}/waiver`, { signed_by: 'Paulo Silva' })).status, 200);
  const f = get('SELECT * FROM families WHERE id=?', fam);
  assert.equal(f.waiver_version, Number(get("SELECT value FROM settings WHERE key='waiver_version'")?.value || 1));
  assert.match(f.waiver_signed_by, /Paulo Silva \(on paper\)/);
  assert.equal((await desk.post(`/families/${fam}/waiver`, { signed_by: 'Paulo Silva' })).status, 400, 'already signed');
  const d = (await desk.get(`/athletes/${athleteId('Isabela', 'Silva')}`)).data;
  assert.equal(d.family.waiver.signed, true);
  assert.ok(get("SELECT 1 FROM activity WHERE action='Recorded paper waiver'"));
});

test('archive cancels upcoming bookings and gives credits back; archiving twice is refused', async () => {
  const fam = insert('families', { name: 'Archive family' });
  insert('parents', { family_id: fam, name: 'Arch Parent', email: 'arch.parent@example.com' });
  const id = insert('athletes', { code: 'ARCKID2026', family_id: fam, first_name: 'Arch', last_name: 'Kid', group_credits: 2, workout_token: 'arch-kid' });
  const ev = get("SELECT id FROM events WHERE cancelled=0 AND type='class' AND starts_at>? ORDER BY starts_at LIMIT 1", booking.nowLocal());
  const b = booking.book(ev.id, id, { source: 'staff' });
  assert.equal(b.coverage, 'credit');
  assert.equal(get('SELECT group_credits FROM athletes WHERE id=?', id).group_credits, 1);
  const r = await coach.post(`/athletes/${id}/archive`);
  assert.equal(r.status, 200);
  assert.equal(r.data.cancelled, 1);
  assert.equal(get('SELECT status FROM bookings WHERE id=?', b.id).status, 'cancelled');
  assert.equal(get('SELECT group_credits FROM athletes WHERE id=?', id).group_credits, 2, 'credit back');
  assert.equal((await coach.post(`/athletes/${id}/archive`)).status, 400);
  assert.equal((await owner.post(`/athletes/${id}/archive`, { restore: true })).status, 200);
  assert.equal((await owner.post(`/athletes/${id}/archive`, { restore: true })).status, 400);
});

test('walk-in: coaches never see the drop-in price; front desk does', async () => {
  const T = booking.todayLocal();
  const mk = (name) => insert('events', { name, type: 'clinic', starts_at: `${T}T23:00`, duration_min: 30, capacity: 20, price_cents: 3500 });
  const fam = insert('families', { name: 'Walk family' });
  const a1 = insert('athletes', { code: 'WALKAA2026', family_id: fam, first_name: 'Walk', last_name: 'One', workout_token: 'walk-one' });
  const a2 = insert('athletes', { code: 'WALKBB2026', family_id: fam, first_name: 'Walk', last_name: 'Two', workout_token: 'walk-two' });
  const c = await coach.post(`/athletes/${a1}/walk-in`, { event_id: mk('Coach clinic') });
  assert.equal(c.status, 200);
  assert.equal(c.data.coverage, 'unpaid');
  assert.equal('price_cents' in c.data, false);
  const d = await desk.post(`/athletes/${a2}/walk-in`, { event_id: mk('Desk clinic') });
  assert.equal(d.data.price_cents, 3500);
});

test('review fixes: archived view counts current clients, phone digits, old birthdays, sessions in progress, adult email', async () => {
  const main = (await desk.get('/clients')).data;
  const arch = (await desk.get('/clients?status=archived')).data;
  assert.ok(arch.clients.length >= 1 && arch.clients.every((c) => c.archived));
  const { archived: _a, ...mainCounts } = main.counts;
  const { archived: _b, ...archCounts } = arch.counts;
  assert.deepEqual(archCounts, mainCounts, 'the other views still count current clients while Archived is open');
  assert.equal(arch.total, main.total);
  assert.equal(arch.counts.archived, arch.clients.length);
  assert.ok(main.clients.every((c) => !c.archived));

  assert.ok((await owner.get('/clients?q=8015550142')).data.clients.some((c) => c.first_name === 'Ava'), 'parent phone by digits');
  assert.deepEqual((await owner.get('/clients?q=(385) 555-0288')).data.clients.map((c) => c.first_name), ['Daniel'], 'athlete phone, other format');
  assert.equal((await owner.get('/clients?q=0142')).data.clients.some((c) => c.first_name === 'Ava'), true);

  assert.equal((await desk.post('/clients', { name: 'Old Timer', birthday: '0999-01-01', parent_name: 'P', parent_email: 'old.timer@example.com' })).status, 400);

  // Booked into a session that is running right now and not checked in yet: not a no-show (yet).
  const id = athleteId('Emma', 'Jensen');
  const now = booking.nowLocal();
  const T = booking.todayLocal();
  const hm = now.slice(11);
  if (hm > '00:05' && hm < '23:00') {
    const startMin = Math.max(0, +hm.slice(0, 2) * 60 + +hm.slice(3, 5) - 5);
    const start = `${T}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`;
    const running = insert('events', { name: 'Running clinic', type: 'clinic', starts_at: start, duration_min: 60, capacity: 10 });
    insert('bookings', { event_id: running, athlete_id: id, status: 'booked', coverage: 'member' });
    const before = (await desk.get(`/athletes/${id}`)).data.visits;
    assert.equal(before.history.some((h) => h.event_id === running), false, 'in progress, not listed as a no-show');
    const over = insert('events', { name: 'Finished clinic', type: 'clinic', starts_at: `${addDays(T, -2)}T09:00`, duration_min: 60, capacity: 10 });
    insert('bookings', { event_id: over, athlete_id: id, status: 'booked', coverage: 'member' });
    const after = (await desk.get(`/athletes/${id}`)).data.visits;
    assert.ok(after.history.some((h) => h.event_id === over && h.outcome === 'no_show'));
    assert.equal(after.summary.no_shows_30, before.summary.no_shows_30 + 1);
  }

  const adult = await desk.post('/clients', { with_parent: false, name: 'Adult Mover', email: 'adult.mover@example.com' });
  assert.equal(adult.status, 201);
  const self = get('SELECT id FROM parents WHERE email=?', 'adult.mover@example.com');
  assert.equal((await desk.put(`/parents/${self.id}`, { email: 'adult.moved@example.com' })).status, 200);
  assert.equal(get('SELECT email FROM athletes WHERE id=?', adult.data.id).email, 'adult.moved@example.com', 'their own athlete email follows the sign-in');
});
