import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { runFollowUps } from '../src/services/leads.js';
import { resetRateLimits } from '../src/services/security.js';
import { newId, localDate, addDaysToDate } from '../src/util.js';

// The CRM on top of leads (version 45): stage history and stale leads, a trial stage and lost reasons, duplicate checks,
// converting a lead through the new-client rules, tasks on Today, the timeline, one-to-one emails and texts (opt-outs,
// consent and STOP), group texts, import and export, reports, and the owner's rule that a coach sees only their leads.
let app, base, owner, coach, coach2, desk, coachId, coach2Id, ownerId, deskId;
const db = () => app.ctx.db;
const today = () => localDate(new Date().toISOString(), 'America/Chicago');

async function signIn(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body, { raw = false } = {}) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (raw) return { status: r.status, text: await r.text(), headers: r.headers };
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const key = async (secret, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const outboxTo = (email) => db().all('SELECT subject, body FROM outbox WHERE to_email = ? ORDER BY rowid', email);
const addLead = async (who, body) => {
  const r = await who('POST', '/v1/leads', { follow_up: false, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  ownerId = createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia Owner', password: 'correct-horse-battery' }).id;
  coachId = createUser(app.ctx, { email: 'coach@test.dev', name: 'Carl Coach', password: 'correct-horse-battery', role: 'coach' }).id;
  coach2Id = createUser(app.ctx, { email: 'coach2@test.dev', name: 'Cora Coach', password: 'correct-horse-battery', role: 'coach' }).id;
  deskId = createUser(app.ctx, { email: 'desk@test.dev', name: 'Dee Desk', password: 'correct-horse-battery', role: 'front_desk' }).id;
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await signIn('owner@test.dev'); coach = await signIn('coach@test.dev'); coach2 = await signIn('coach2@test.dev'); desk = await signIn('desk@test.dev');
  await owner('PATCH', '/v1/settings', { business_address: '100 Main St, Austin, TX 78701', timezone: 'America/Chicago' });
});
after(() => app.server.close());

test('every stage change is kept with who moved it; days in stage and stale leads; a lost lead needs a reason; lead.stage_changed goes out too', async () => {
  const l = await addLead(desk, { parent_name: 'Sara Stage', email: 'sara@example.com', athlete_name: 'Sam Stage', athlete_age: 12 });
  assert.deepEqual([l.status, l.stage_label, l.days_in_stage, l.stale], ['new', 'New', 0, false]);
  const moved = (await desk('PATCH', `/v1/leads/${l.id}`, { status: 'contacted' })).body;
  assert.equal(moved.status, 'contacted');
  const refused = await desk('PATCH', `/v1/leads/${l.id}`, { status: 'lost' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /Pick why they didn't join/);
  const lost = (await desk('PATCH', `/v1/leads/${l.id}`, { status: 'lost', lost_reason: 'schedule', lost_note: 'Only free Sundays' })).body;
  assert.deepEqual([lost.lost_reason, lost.lost_reason_label, lost.lost_note], ['schedule', 'Schedule', 'Only free Sundays']);
  const back = (await owner('PATCH', `/v1/leads/${l.id}`, { status: 'contacted' })).body;
  assert.equal(back.lost_reason, null, 'the reason goes when it leaves Lost');
  const detail = (await owner('GET', `/v1/leads/${l.id}`)).body;
  assert.deepEqual(detail.history.map((h) => [h.from_stage, h.to_stage, h.by_name]), [[null, 'new', 'Dee Desk'], ['new', 'contacted', 'Dee Desk'], ['contacted', 'lost', 'Dee Desk'], ['lost', 'contacted', 'Olivia Owner']]);
  const events = db().all(`SELECT type, data FROM events WHERE type IN ('lead.updated','lead.stage_changed') AND data LIKE ?`, `%${l.id}%`);
  assert.equal(events.filter((e) => e.type === 'lead.updated').length, 3, 'lead.updated keeps its name');
  assert.deepEqual(JSON.parse(events.find((e) => e.type === 'lead.stage_changed').data), { lead_id: l.id, from: 'new', to: 'contacted', auto: false, reason: null, family_id: null });
  // Ten days in Contacted with nothing done: stale (amber), counted, and first when sorted by stale.
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
  db().run('UPDATE leads SET stage_changed_at = ?, last_activity_at = ?, created_at = ? WHERE id = ?', tenDaysAgo, tenDaysAgo, tenDaysAgo, l.id);
  const list = (await owner('GET', '/v1/leads?open=true&sort=stale')).body;
  assert.equal(list.data[0].id, l.id);
  assert.deepEqual([list.data[0].days_in_stage, list.data[0].stale], [10, true]);
  assert.ok(list.stale >= 1);
  assert.deepEqual((await owner('GET', '/v1/leads?stale=true')).body.data.map((x) => x.id), [l.id]);
  // A note brings it back to life.
  await desk('POST', `/v1/leads/${l.id}/activity`, { kind: 'note', body: 'Asked about Saturday times' });
  assert.equal((await owner('GET', `/v1/leads/${l.id}`)).body.stale, false);
  assert.equal((await owner('GET', `/v1/leads/${l.id}`)).body.days_in_stage, 10, 'still 10 days in the stage');
});

test('leads move to trial and member on their own, with the reason on the timeline', async () => {
  const l = await addLead(owner, { parent_name: 'Tia Trial', email: 'tia@example.com', athlete_name: 'Tom Trial' });
  const conv = await owner('POST', `/v1/leads/${l.id}/convert`, {});
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  const plan = (await owner('POST', '/v1/plans', { name: 'Trial plan', price_cents: 12000, trial_days: 14 })).body;
  await owner('POST', `/v1/clients/${conv.body.client.id}/subscription`, { plan_id: plan.id });
  await runFollowUps(app.ctx);
  const got = (await owner('GET', `/v1/leads/${l.id}`)).body;
  assert.equal(got.status, 'trial');
  assert.deepEqual(got.history.at(-1), { ...got.history.at(-1), to_stage: 'trial', auto: true, reason: 'Started a free trial' });
  const t = (await owner('GET', `/v1/leads/${l.id}/timeline`)).body.data;
  assert.ok(t.some((x) => x.kind === 'stage' && x.title === 'Moved to Trial' && x.by === 'Automatic'));
  assert.ok(t.some((x) => x.kind === 'membership' && /free trial of Trial plan/.test(x.title)));
  db().run(`UPDATE subscriptions SET status = 'active', updated_at = ? WHERE client_id = ?`, app.ctx.now(), conv.body.client.id);
  assert.equal((await owner('GET', `/v1/leads/${l.id}`)).body.status, 'member', 'opening the lead catches up');
});

test('duplicate checks: an open lead with the email is refused; the same phone as a family asks first; the pre-check is for owners and front desk', async () => {
  const fam = (await owner('POST', '/v1/clients', { name: 'Ava Dup', parent: { name: 'Maria Dup', email: 'maria.dup@example.com', phone: '(512) 555-0101' } })).body;
  assert.ok(fam.id);
  await addLead(desk, { parent_name: 'Ed Early', email: 'ed@example.com', phone: '512-555-0102' });
  const again = await desk('POST', '/v1/leads', { parent_name: 'Ed Again', email: 'ED@example.com', follow_up: false });
  assert.equal(again.status, 409);
  assert.ok(again.body.error.details.lead_id);
  const pre = (await desk('GET', `/v1/leads/duplicates?phone=${encodeURIComponent('+1 512 555 0101')}&email=maria.dup@example.com`)).body;
  assert.equal(pre.families.length, 1);
  assert.equal(pre.families[0].name, 'Dup family');
  assert.equal(pre.families[0].client_id, fam.id);
  assert.equal((await coach('GET', '/v1/leads/duplicates?phone=5125550101')).status, 403, 'coaches can\'t search every family');
  const ask = await desk('POST', '/v1/leads', { parent_name: 'Mar Dup', phone: '5125550101', check_duplicates: true, follow_up: false });
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error.code, 'possible_duplicate');
  assert.match(ask.body.error.message, /The Dup family \(Maria Dup\) has the same phone number/);
  const byPhone = await desk('POST', '/v1/leads', { parent_name: 'Eddie', phone: '(512) 555-0102', check_duplicates: true, follow_up: false });
  assert.match(byPhone.body.error.message, /Ed Early \(a lead, New\) has the same phone number/);
  assert.equal((await desk('POST', '/v1/leads', { parent_name: 'Mar Dup', phone: '5125550101', follow_up: false })).status, 201, 'added anyway without the check');
});

test('converting a lead: through the new-client rules, once, in one step, notes carried, never a second profile', async () => {
  const l = await addLead(desk, { parent_name: 'Nina Convert', email: 'nina@example.com', phone: '512-555-0110', athlete_name: 'Nate Convert', sport: 'Baseball', message: 'Wants to pitch', notes: 'Prefers evenings' });
  const [a, b] = await Promise.all([desk('POST', `/v1/leads/${l.id}/convert`, { birth_date: '2013-05-01' }), desk('POST', `/v1/leads/${l.id}/convert`, { birth_date: '2013-05-01' })]);
  const ok = [a, b].filter((x) => x.status === 201), no = [a, b].filter((x) => x.status === 409);
  assert.equal(ok.length, 1, 'one press converts');
  assert.equal(no.length, 1, 'the other is told it is done');
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM clients WHERE name = 'Nate Convert'`).n, 1, 'one profile');
  const { client, lead } = ok[0].body;
  assert.equal(client.family.name, 'Convert family');
  assert.equal(client.sport, 'Baseball');
  assert.ok(client.athlete_id);
  assert.deepEqual([lead.status, lead.client_id, lead.family_id], ['signed_up', client.id, client.family.id]);
  assert.equal(lead.client.name, 'Nate Convert');
  const note = db().get('SELECT body, coach_only FROM client_notes WHERE client_id = ?', client.id);
  assert.match(note.body, /They wrote: "Wants to pitch"/);
  assert.match(note.body, /Lead notes: Prefers evenings/);
  assert.equal(note.coach_only, 0);
  assert.ok(db().get(`SELECT 1 FROM events WHERE type = 'lead.converted' AND data LIKE ?`, `%${l.id}%`));
  assert.ok(outboxTo('nina@example.com').some((m) => /Welcome/.test(m.subject)), 'the family is emailed how to sign in');
  // A parent's email that already signs in: refused with the family, and nothing linked or made.
  const l2 = await addLead(desk, { parent_name: 'Nina Again', email: 'nina@example.com', athlete_name: 'Nora Convert' });
  const refused = await desk('POST', `/v1/leads/${l2.id}/convert`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'parent_exists');
  assert.equal(refused.body.error.details.family.id, client.family.id);
  assert.equal(db().get('SELECT client_id FROM leads WHERE id = ?', l2.id).client_id, null);
  const sib = await desk('POST', `/v1/leads/${l2.id}/convert`, { family_id: client.family.id });
  assert.equal(sib.status, 201);
  assert.equal(sib.body.client.family.id, client.family.id, 'a sibling in the same family');
  // The same name and birthday as a profile we have asks first (like the Clients screen).
  const l3 = await addLead(owner, { parent_name: 'Other Parent', email: 'other.parent@example.com', athlete_name: 'Nate Convert' });
  const soft = await owner('POST', `/v1/leads/${l3.id}/convert`, { birth_date: '2013-05-01', check_duplicates: true });
  assert.equal(soft.body.error.code, 'possible_duplicate');
  assert.equal(db().get('SELECT client_id FROM leads WHERE id = ?', l3.id).client_id, null);
});

test('converting by Athlete ID links the team profile we already have (one profile per athlete) and puts it in a family', async () => {
  const org = (await owner('POST', '/v1/organizations', { name: 'Lakeway HS', kind: 'school' })).body;
  const contract = (await owner('POST', '/v1/team-contracts', { org_id: org.id, name: 'JV', monthly_cents: 40000, start_date: today() })).body;
  assert.equal((await owner('POST', `/v1/team-contracts/${contract.id}/roster`, { name: 'Rory Stone', position: 'LB' })).status, 201);
  const teamClient = db().get(`SELECT c.id, c.athlete_id, c.family_id FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.name = 'Rory Stone'`);
  assert.equal(teamClient.family_id, null);
  const l = await addLead(desk, { parent_name: 'Rita Stone', email: 'rita@example.com', athlete_name: 'Rory Stone' });
  assert.equal((await desk('POST', `/v1/leads/${l.id}/convert`, { athlete_id: 'NOTANID2026' })).status, 400);
  const r = await desk('POST', `/v1/leads/${l.id}/convert`, { athlete_id: teamClient.athlete_id.toLowerCase() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.client.id, teamClient.id, 'the team profile, not a new one');
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM clients WHERE name = 'Rory Stone'`).n, 1);
  assert.ok(r.body.client.family, 'now in a family so the parents see them');
  assert.equal(db().get('SELECT email FROM guardians WHERE family_id = ?', r.body.client.family.id).email, 'rita@example.com');
});

test('tasks: on a lead or a family, for one person, on their Today; front desk can\'t give coaches work; coaches only their own', async () => {
  const l = await addLead(owner, { parent_name: 'Tess Task', email: 'tess@example.com' });
  const due = today();
  const mine = (await desk('POST', '/v1/tasks', { lead_id: l.id, title: 'Call back about camp', due_date: due })).body;
  assert.deepEqual([mine.assignee_id, mine.due_today, mine.about, mine.link], [deskId, true, 'Tess Task', `#/leads/${l.id}`]);
  assert.equal((await desk('POST', '/v1/tasks', { lead_id: l.id, title: 'x', assignee_id: coachId })).status, 403, 'front desk doesn\'t give coaches work');
  assert.equal((await owner('POST', '/v1/tasks', { lead_id: l.id, title: 'x', assignee_id: coachId })).status, 400, 'not a lead the coach can see');
  const forOwner = (await desk('POST', '/v1/tasks', { lead_id: l.id, title: 'Price question', assignee_id: ownerId, due_date: addDaysToDate(due, -2) })).body;
  assert.equal(forOwner.overdue, true);
  // Today: overdue and today's tasks for the person they're for.
  assert.deepEqual((await desk('GET', '/v1/today')).body.tasks.map((t) => t.title), ['Call back about camp']);
  assert.deepEqual((await owner('GET', '/v1/today')).body.tasks.map((t) => t.title), ['Price question']);
  assert.deepEqual((await coach('GET', '/v1/today')).body.tasks, []);
  // Coaches: only leads given to them, only for themselves.
  assert.equal((await coach('POST', '/v1/tasks', { lead_id: l.id, title: 'Sneak' })).status, 404);
  await owner('PATCH', `/v1/leads/${l.id}`, { coach_id: coachId });
  const coachTask = (await coach('POST', '/v1/tasks', { lead_id: l.id, title: 'Text about evaluation', due_date: due })).body;
  assert.equal(coachTask.assignee_id, coachId);
  assert.equal((await coach('POST', '/v1/tasks', { lead_id: l.id, title: 'For desk', assignee_id: deskId })).status, 403);
  assert.deepEqual((await coach('GET', '/v1/tasks')).body.data.map((t) => t.title), ['Text about evaluation'], 'their own list');
  assert.equal((await coach('GET', `/v1/tasks?lead_id=${l.id}`)).body.data.length, 3, 'every task on their lead');
  assert.equal((await coach2('GET', `/v1/tasks?lead_id=${l.id}`)).status, 404);
  assert.equal((await coach('PATCH', `/v1/tasks/${mine.id}`, { done: true })).status, 403, 'someone else\'s task');
  const done = (await coach('PATCH', `/v1/tasks/${coachTask.id}`, { done: true })).body;
  assert.equal(done.done, true);
  assert.equal(done.done_by, 'Carl Coach');
  // Taken back: the coach loses the lead and its tasks.
  await owner('PATCH', `/v1/leads/${l.id}`, { coach_id: null });
  assert.equal((await coach('GET', `/v1/tasks?status=all`)).body.data.length, 0);
  assert.equal((await coach('PATCH', `/v1/tasks/${coachTask.id}`, { done: false })).status, 404);
  // Only the owner or whoever added a task deletes it.
  assert.equal((await desk('DELETE', `/v1/tasks/${forOwner.id}`)).status, 200);
  assert.equal((await owner('DELETE', `/v1/tasks/${mine.id}`)).status, 200);
});

test('one-to-one email: templates filled in, a stop link that sticks, and opted-out addresses refused (follow-ups too)', async () => {
  const l = await addLead(desk, { parent_name: 'Emma Mail', email: 'emma@example.com', athlete_name: 'Eli Mail' });
  const tpl = (await desk('GET', '/v1/message-templates')).body;
  const thanks = tpl.data.find((t) => t.name === 'Thanks for asking');
  assert.equal((await desk('POST', '/v1/message-templates', { channel: 'email', name: 'x', subject: 'x', body: 'x' })).status, 403, 'the owner edits templates');
  const sent = await desk('POST', `/v1/leads/${l.id}/email`, { template_id: thanks.id });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.lead.status, 'contacted', 'emailing a new lead moves it to Contacted');
  const mail = outboxTo('emma@example.com').at(-1);
  assert.equal(mail.subject, 'Training for Eli');
  assert.match(mail.body, /^Hi Emma,\n\nThanks for asking about training for Eli\./);
  assert.match(mail.body, /Dee\nDiamond Protocol/);
  assert.match(mail.body, /100 Main St, Austin, TX 78701\nDon't want these emails\? Stop them: https:\/\/app\.example\.org\/u\/[\w-]+$/);
  const tok = mail.body.match(/\/u\/([\w-]+)$/)[1];
  // The link asks first (so email scanners can't unsubscribe anyone), then stops emails to that address everywhere.
  const page = await fetch(`${base}/u/${tok}`);
  assert.match(await page.text(), /Stop these emails\?/);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM email_optouts WHERE email = 'emma@example.com'`).n, 0);
  await fetch(`${base}/u/${tok}?stop=1`, { method: 'POST' });
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM email_optouts WHERE email = 'emma@example.com'`).n, 1);
  const again = await desk('POST', `/v1/leads/${l.id}/email`, { subject: 'Hi', body: 'Hello' });
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /asked us to stop emailing them/);
  assert.match((await desk('GET', `/v1/leads/${l.id}`)).body.email_block, /asked us to stop/);
  assert.equal((await desk('PATCH', `/v1/leads/${l.id}`, { email_ok: true })).status, 409, 'staff can\'t undo someone\'s opt-out');
  // The automatic follow-up skips an address that asked to stop, and every follow-up has its own stop link.
  const f = await addLead(owner, { parent_name: 'Fay Follow', email: 'fay@example.com', follow_up: true });
  const first = outboxTo('fay@example.com').at(-1);
  assert.match(first.body, /Stop them: https:\/\/app\.example\.org\/u\//);
  await owner('PATCH', `/v1/leads/${f.id}`, { email_ok: false });
  await runFollowUps(app.ctx, { asOf: new Date(Date.now() + 3 * 86400000).toISOString() });
  assert.equal(outboxTo('fay@example.com').length, 1, 'no nudge after the opt-out');
  assert.equal(db().get('SELECT next_follow_up_at FROM leads WHERE id = ?', f.id).next_follow_up_at, null);
});

test('one-to-one texts: only with their OK on a US mobile, never after STOP, always with the business name and how to stop', async () => {
  const l = await addLead(desk, { parent_name: 'Tara Text', email: 'tara@example.com', phone: '(512) 555-0120', athlete_name: 'Ty Text' });
  const no = await desk('POST', `/v1/leads/${l.id}/text`, { body: 'Hi!' });
  assert.equal(no.status, 409);
  assert.match(no.body.error.message, /haven't said texts are OK/);
  assert.equal((await desk('PATCH', `/v1/leads/${l.id}`, { texts_ok: true })).status, 400, 'staff say how they said yes');
  const ok = (await desk('PATCH', `/v1/leads/${l.id}`, { texts_ok: true, texts_ok_source: 'Said yes on the phone' })).body;
  assert.deepEqual([ok.texts_ok, ok.texts_ok_source], [true, 'Said yes on the phone']);
  const r = await desk('POST', `/v1/leads/${l.id}/text`, { body: 'Hi {first_name}, when can {athlete} come in?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'logged');
  assert.match(r.body.note, /saved in API & integrations → Texts, not sent/);
  assert.equal(r.body.text, 'Diamond Protocol: Hi Tara, when can Ty come in? Reply STOP to stop.');
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM texts WHERE phone = '+15125550120' AND kind = 'crm'`).n, 1);
  assert.equal((await desk('POST', `/v1/leads/${l.id}/text`, { body: 'x'.repeat(481) })).status, 400, 'up to 480 characters');
  // They reply, then text STOP (a pretend reply in test mode, owner only).
  assert.equal((await desk('POST', '/v1/texts/simulate', { from: '5125550120', body: 'Tuesday works' })).status, 403);
  await owner('PATCH', `/v1/leads/${l.id}`, { coach_id: coachId });
  const before = outboxTo('coach@test.dev').length;
  assert.equal((await owner('POST', '/v1/texts/simulate', { from: '5125550120', body: 'Tuesday works' })).status, 200);
  const alert = outboxTo('coach@test.dev').slice(before).find((m) => m.subject === 'Text from Tara Text');
  assert.ok(alert, 'the coach given the lead hears about the reply');
  assert.match(alert.body, new RegExp(`Reply from their lead: https://app.example.org/#/leads/${l.id}`));
  assert.ok(!outboxTo('coach2@test.dev').some((m) => m.subject === 'Text from Tara Text'), 'other coaches don\'t');
  const t = (await coach('GET', `/v1/leads/${l.id}/timeline`)).body.data;
  assert.ok(t.some((x) => x.kind === 'text_in' && x.body === 'Tuesday works'));
  assert.ok(t.some((x) => x.kind === 'text' && x.by === 'Dee Desk'));
  await owner('POST', '/v1/texts/simulate', { from: '(512) 555-0120', body: 'STOP' });
  const stopped = (await desk('GET', `/v1/leads/${l.id}`)).body;
  assert.deepEqual([stopped.texts_ok, stopped.texts_stopped], [false, true]);
  assert.match((await desk('POST', `/v1/leads/${l.id}/text`, { body: 'Hi' })).body.error.message, /They texted STOP/);
  assert.equal((await desk('PATCH', `/v1/leads/${l.id}`, { texts_ok: true, texts_ok_source: 'Asked again' })).status, 409, 'only START turns texts back on');
  // A new phone number turns "OK to text" off: the OK was for the old number.
  const l2 = await addLead(desk, { parent_name: 'Pia Phone', phone: '512-555-0121', texts_ok: true, texts_ok_source: 'At the front desk' });
  assert.equal(l2.texts_ok, true);
  assert.equal((await desk('PATCH', `/v1/leads/${l2.id}`, { phone: '512-555-0122' })).body.texts_ok, false);
  assert.equal((await desk('POST', '/v1/leads', { parent_name: 'Abroad', phone: '+44 20 7946 0000', texts_ok: true, follow_up: false })).status, 400, 'texts only to US numbers');
});

test('family contact history on the client profile: email and text parents (only those who turned texts on), notes, calls; payments for the owner only', async () => {
  const c = (await owner('POST', '/v1/clients', { name: 'Hal History', parent: { name: 'Hope History', email: 'hope@example.com', phone: '512-555-0130' } })).body;
  const g = db().get('SELECT id FROM guardians WHERE family_id = ?', c.family.id);
  const noText = await desk('POST', `/v1/clients/${c.id}/text`, { body: 'Hi' });
  assert.equal(noText.status, 409);
  assert.match(noText.body.error.message, /turned texts on/);
  db().run(`UPDATE guardians SET sms_opt_in_at = ?, phone = '+15125550130' WHERE id = ?`, app.ctx.now(), g.id);
  assert.equal((await desk('POST', `/v1/clients/${c.id}/text`, { body: 'Camp is Friday' })).body.status, 'logged');
  assert.equal((await coach('POST', `/v1/clients/${c.id}/text`, { body: 'x' })).status, 403, 'coaches message families through coach messages');
  assert.equal((await coach('POST', `/v1/clients/${c.id}/email`, { subject: 'x', body: 'x' })).status, 403);
  assert.equal((await desk('POST', `/v1/clients/${c.id}/email`, { subject: 'Camp', body: 'See you Friday' })).status, 200);
  assert.match(outboxTo('hope@example.com').at(-1).body, /Stop them: https:\/\/app\.example\.org\/u\//);
  assert.equal((await coach('POST', `/v1/clients/${c.id}/activity`, { kind: 'call', outcome: 'voicemail', body: 'Left a message about Saturday' })).status, 201);
  db().run(`INSERT INTO plans (id, name, price_cents, active, created_at) VALUES ('plan_h', 'Monthly', 15000, 1, ?)`, app.ctx.now());
  db().run(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_h', ?, 'plan_h', 'active', ?, ?, ?, ?)`, c.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  db().run(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, paid_at, created_at) VALUES ('inv_h', 'sub_h', ?, 15000, 'paid', ?, ?, ?, ?)`, c.id, app.ctx.now(), app.ctx.now(), app.ctx.now(), app.ctx.now());
  const mine = (await owner('GET', `/v1/clients/${c.id}/timeline`)).body;
  assert.ok(mine.data.some((x) => x.kind === 'payment' && x.amount_cents === 15000));
  assert.deepEqual(['email', 'text', 'call'].map((k) => mine.data.some((x) => x.kind === k)), [true, true, true]);
  assert.equal(mine.recipients[0].text_block, null);
  for (const who of [desk, coach]) {
    const t = (await who('GET', `/v1/clients/${c.id}/timeline`)).body;
    assert.ok(!t.data.some((x) => x.kind === 'payment'), 'no payments for staff');
    assert.ok(!JSON.stringify(t).includes('15000'));
  }
  // Put back in the pipeline: a new lead for the family, which doesn't count the old membership.
  const back = await desk('POST', `/v1/clients/${c.id}/lead`, { note: 'Trial ended, try summer camp' });
  assert.equal(back.status, 201);
  assert.deepEqual([back.body.source, back.body.status, back.body.client_id, back.body.family_id], ['client', 'contacted', c.id, c.family.id]);
  await runFollowUps(app.ctx);
  assert.equal(db().get('SELECT status FROM leads WHERE id = ?', back.body.id).status, 'contacted', 'the old membership doesn\'t move it');
  assert.equal((await desk('POST', `/v1/clients/${c.id}/lead`, {})).status, 409, 'one open lead per family');
  // A coach doesn't see the family's lead (not given to them) in the history.
  assert.ok(!(await coach('GET', `/v1/clients/${c.id}/timeline`)).body.data.some((x) => x.lead_id), 'a coach can\'t tell other leads exist');
  assert.deepEqual((await coach('GET', `/v1/clients/${c.id}/leads`)).body.data, []);
  assert.equal((await owner('GET', `/v1/clients/${c.id}/leads`)).body.data.length, 1);
});

test('a coach sees nothing of a lead that isn\'t theirs on any lead route', async () => {
  const l = await addLead(owner, { parent_name: 'Hidden Hana', email: 'hana@example.com', phone: '512-555-0140' });
  const paths = [['GET', `/v1/leads/${l.id}`], ['PATCH', `/v1/leads/${l.id}`, { notes: 'x' }], ['GET', `/v1/leads/${l.id}/timeline`], ['POST', `/v1/leads/${l.id}/activity`, { kind: 'note', body: 'x' }],
    ['POST', `/v1/leads/${l.id}/email`, { subject: 'x', body: 'x' }], ['POST', `/v1/leads/${l.id}/text`, { body: 'x' }], ['POST', `/v1/leads/${l.id}/convert`, {}],
    ['POST', '/v1/tasks', { lead_id: l.id, title: 'x' }], ['GET', `/v1/tasks?lead_id=${l.id}`]];
  for (const [m, p, b] of paths) assert.equal((await coach(m, p, b)).status, 404, `${m} ${p}`);
  for (const [m, p] of [['GET', '/v1/leads/export'], ['GET', '/v1/leads/report'], ['POST', '/v1/leads/import'], ['GET', '/v1/leads/duplicates?email=hana@example.com'], ['DELETE', `/v1/leads/${l.id}`], ['POST', '/v1/campaigns/preview']]) {
    assert.equal((await coach(m, p, m === 'GET' ? undefined : {})).status, 403, `${m} ${p}`);
  }
  assert.ok(!(await coach('GET', '/v1/leads?q=Hana')).body.data.length, 'search finds nothing');
  // Changing their own lead's email to another lead's address is refused without saying whose it is.
  const mine = await addLead(owner, { parent_name: 'Coach Own', email: 'own@example.com' });
  await owner('PATCH', `/v1/leads/${mine.id}`, { coach_id: coachId });
  const clash = await coach('PATCH', `/v1/leads/${mine.id}`, { email: 'hana@example.com' });
  assert.equal(clash.status, 409);
  assert.doesNotMatch(clash.body.error.message, /open lead|Hana/);
  assert.ok(!(await coach('GET', '/v1/activity?limit=100')).body.data.some((e) => e.type.startsWith('lead')));
  // Front desk works the lead, but reports, export, import and group messages are the owner's.
  assert.equal((await desk('POST', `/v1/leads/${l.id}/activity`, { kind: 'call', outcome: 'no_answer' })).status, 201);
  for (const [m, p] of [['GET', '/v1/leads/export'], ['GET', '/v1/leads/report'], ['POST', '/v1/leads/import'], ['POST', '/v1/campaigns/preview'], ['DELETE', `/v1/leads/${l.id}`]]) {
    assert.equal((await desk(m, p, m === 'GET' ? undefined : {})).status, 403, `${m} ${p}`);
  }
  assert.equal((await desk('PATCH', `/v1/leads/${l.id}`, { coach_id: coachId })).status, 403, 'only the owner gives a lead to a coach');
});

test('group messages: text or email, the leads group by stage, and who is left out and why', async () => {
  await addLead(owner, { parent_name: 'Gus Group', phone: '512-555-0150', texts_ok: true, texts_ok_source: 'Asked at camp', athlete_age: 10 });
  await addLead(owner, { parent_name: 'Gil NoText', phone: '512-555-0151', athlete_age: 10 });
  const preview = (await owner('POST', '/v1/campaigns/preview', { channel: 'text', audience: { group: 'leads' } })).body;
  assert.ok(preview.sample.includes('Gus Group'));
  assert.ok(!preview.sample.includes('Gil NoText'));
  assert.ok(preview.left_out.people.some((p) => p.name === 'Gil NoText' && p.reason === 'Hasn\'t said texts are OK'));
  const emails = (await owner('POST', '/v1/campaigns/preview', { channel: 'email', audience: { group: 'leads', stages: ['new', 'contacted', 'signed_up'] } })).body;
  assert.match(emails.description, /Families who asked about training \(new, contacted, signed up\)/);
  assert.ok(emails.left_out.people.some((p) => p.name === 'Emma Mail' && p.reason === 'Asked us to stop emailing'));
  assert.ok(emails.left_out.people.some((p) => p.name === 'Gus Group' && p.reason === 'No email'));
  assert.equal((await owner('POST', '/v1/campaigns/preview', { audience: { group: 'leads', stages: ['nope'] } })).status, 400);
  const draft = (await owner('POST', '/v1/campaigns', { channel: 'text', body: 'Hi {first_name}, open gym Saturday at 10!', audience: { group: 'leads' } })).body;
  assert.equal(draft.channel, 'text');
  assert.equal((await owner('POST', `/v1/campaigns/${draft.id}/test`)).status, 400);
  const sent = await owner('POST', `/v1/campaigns/${draft.id}/send`, { confirm_count: preview.count });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(db().get(`SELECT body FROM texts WHERE phone = '+15125550150' AND kind = 'group'`).body, 'Diamond Protocol: Hi Gus, open gym Saturday at 10! Reply STOP to stop.');
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM texts WHERE phone = '+15125550151'`).n, 0, 'no text without their OK');
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM texts WHERE phone = '+15125550120' AND kind = 'group'`).n, 0, 'never after STOP');
});

test('import: all or nothing with every problem by row and column, formulas refused, possible duplicates confirmed; export is formula-safe', async () => {
  const bad = ['Parent name,Email,Phone,Athlete age,How they found you,Stage,Favorite color',
    'Ann Import,ann@example.com,512-555-0160,12,Event,New,',
    ',bob@example.com,,,,,',
    '=HYPERLINK("http://x"),cat@example.com,,,,,',
    'Dan Import,not-an-email,555,120,Billboard,Member,Blue',
    'Eve Import,ann@example.com,,,,,'].join('\n');
  const r = await owner('POST', '/v1/leads/import', { csv: bad });
  assert.equal(r.status, 400);
  const probs = r.body.error.details.errors.map((e) => `${e.row}|${e.column}`);
  for (const p of ['1|Favorite color', '3|Parent name', '4|Parent name', '5|Email', '5|Phone', '5|Athlete age', '5|How they found you', '5|Stage', '6|Email']) assert.ok(probs.includes(p), `problem at ${p}: ${probs.join(', ')}`);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM leads WHERE source = 'import'`).n, 0, 'nothing saved');
  assert.equal((await desk('POST', '/v1/leads/import', { csv: bad })).status, 403);
  // A clean file with a row that shares a phone with a family: shown, then saved only with confirm.
  const good = ['Parent name,Email,Phone,Athlete name,Athlete age,Sport,How they found you,Stage,Notes',
    'Ann Import,ann@example.com,512-555-0160,Al Import,12,Baseball,Event,New,Met at showcase',
    'Hope Again,,(512) 555-0130,,,,Referral,Contacted,'].join('\n');
  const dry = (await owner('POST', '/v1/leads/import', { csv: good, dry_run: true })).body;
  assert.equal(dry.rows, 2);
  assert.equal(dry.saved, 0);
  assert.match(dry.warnings[0].message, /Same phone as the (lead Hope History|History family)/);
  const needs = await owner('POST', '/v1/leads/import', { csv: good });
  assert.equal(needs.status, 409);
  assert.equal(needs.body.error.code, 'import_confirm');
  const saved = await owner('POST', '/v1/leads/import', { csv: good, confirm: true });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.saved, 2);
  const ann = db().get(`SELECT * FROM leads WHERE email = 'ann@example.com'`);
  assert.deepEqual([ann.source, ann.status, ann.phone, ann.texts_ok, ann.next_follow_up_at, ann.notes], ['event', 'new', '+15125550160', 0, null, 'Met at showcase']);
  assert.equal(outboxTo('ann@example.com').length, 0, 'no automatic emails to imported leads');
  assert.ok(db().get(`SELECT 1 FROM events WHERE type = 'leads.imported'`));
  // Importing the same file again: Ann is an open lead now, so the whole file waits.
  assert.equal((await owner('POST', '/v1/leads/import', { csv: good, confirm: true })).status, 400);
  // Export: a name typed like a formula can't run in a spreadsheet.
  await addLead(owner, { parent_name: '=cmd|\' /C calc\'!A0', email: 'formula@example.com' });
  const csv = await owner('GET', '/v1/leads/export', undefined, { raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /leads-\d{4}-\d{2}-\d{2}\.csv/);
  assert.match(csv.text, /"'=cmd\|' \/C calc'!A0"/);
  assert.match(csv.text, /"\(512\) 555-0160"/);
  assert.equal((await desk('GET', '/v1/leads/export')).status, 403);
});

test('reports: by source, conversion, days to member, lost reasons and stage counts for a period', async () => {
  const from = addDaysToDate(today(), -7);
  const rep = (await owner('GET', `/v1/leads/report?from=${from}&to=${today()}`)).body;
  assert.ok(rep.leads >= 10);
  assert.ok(rep.by_source.find((s) => s.source === 'manual').leads >= 1);
  assert.ok(rep.members >= 1, 'Tia Trial became a member');
  assert.equal(typeof rep.days_to_member.median, 'number');
  assert.ok(rep.lost_reasons.every((x) => x.label));
  assert.equal(rep.stage_counts.length, 7);
  assert.ok(rep.open_now.total >= 1);
  assert.equal((await owner('GET', '/v1/leads/report?from=2026-10-10&to=2026-10-01')).status, 400);
  assert.equal((await desk('GET', '/v1/leads/report')).status, 403);
});

test('API keys: read keys read leads; only full keys work them (and the scope sweep covers the new routes)', async () => {
  const read = (await owner('POST', '/v1/api-keys', { label: 'CRM read' })).body;
  const full = (await owner('POST', '/v1/api-keys', { label: 'CRM full', scope: 'full' })).body;
  assert.equal((await key(read.secret, 'GET', '/v1/leads')).status, 200);
  const l = (await key(full.secret, 'POST', '/v1/leads', { parent_name: 'Api Lead', email: 'api.lead@example.com', follow_up: false })).body;
  assert.equal((await key(read.secret, 'POST', `/v1/leads/${l.id}/activity`, { kind: 'note', body: 'x' })).status, 403);
  assert.equal((await key(full.secret, 'POST', `/v1/leads/${l.id}/activity`, { kind: 'note', body: 'From the website CRM' })).status, 201);
  assert.equal((await key(full.secret, 'POST', '/v1/tasks', { lead_id: l.id, title: 'Follow up', assignee_id: deskId })).status, 201);
  assert.equal((await key(full.secret, 'POST', '/v1/message-templates', { channel: 'text', name: 'x', body: 'x' })).status, 401, 'templates are managed from the dashboard');
  const t = (await owner('GET', `/v1/leads/${l.id}/timeline`)).body.data;
  assert.ok(t.some((x) => x.kind === 'note' && x.by === 'CRM full'));
  resetRateLimits();
});

test('deleting a family removes its contact history, tasks and leads; the family export includes them', async () => {
  const c = (await owner('POST', '/v1/clients', { name: 'Del Gone', parent: { name: 'Dora Gone', email: 'dora@example.com' } })).body;
  await owner('POST', `/v1/clients/${c.id}/activity`, { kind: 'note', body: 'Private family note' });
  await owner('POST', '/v1/tasks', { client_id: c.id, title: 'Call Dora' });
  // With Education and staff notes merged in: lessons opened are in the export, coach-only notes are not.
  await owner('POST', `/v1/clients/${c.id}/notes`, { body: 'Coach eyes only', coach_only: true });
  await owner('POST', `/v1/clients/${c.id}/notes`, { body: 'Shared staff note' });
  const lesson = (await owner('POST', '/v1/lessons', { title: 'Sleep basics', body: 'Sleep more.', published: true })).body;
  db().run('INSERT INTO lesson_views (lesson_id, client_id, opened_at) VALUES (?, ?, ?)', lesson.id, c.id, new Date().toISOString());
  const exp = (await owner('GET', `/v1/families/${c.family.id}/export`)).body;
  assert.equal(exp.contact_history[0].body, 'Private family note');
  assert.equal(exp.follow_up_tasks[0].title, 'Call Dora');
  assert.equal(exp.athletes[0].lessons_opened[0].lesson, 'Sleep basics');
  assert.deepEqual(exp.athletes[0].staff_notes.map((n) => n.note), ['Shared staff note']);
  assert.ok(!JSON.stringify(exp).includes('Coach eyes only'), 'coach-only notes stay out of the export');
  assert.equal((await owner('DELETE', `/v1/families/${c.family.id}`, { confirm: 'Gone family' })).status, 200);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM lead_activity WHERE body = 'Private family note'`).n, 0);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM crm_tasks WHERE title = 'Call Dora'`).n, 0);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM lesson_views WHERE client_id = ?', c.id).n, 0);
});

test('the public inquiry form is unchanged: honeypot, per-address and overall limits, no texts to a number that texted STOP', async () => {
  resetRateLimits();
  const ask = async (body) => (await fetch(base + '/portal/api/public/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
  assert.equal(await ask({ parent_name: 'Bot', email: 'bot@example.com', website: 'spam' }), 200);
  assert.equal(db().get(`SELECT COUNT(*) AS n FROM leads WHERE email = 'bot@example.com'`).n, 0);
  assert.equal(await ask({ parent_name: 'Stopped', email: 'stopped@example.com', phone: '512-555-0120', texts_ok: true }), 200);
  assert.equal(db().get(`SELECT texts_ok FROM leads WHERE email = 'stopped@example.com'`).texts_ok, 0);
  let last = 200;
  for (let i = 0; i < 10; i++) last = await ask({ parent_name: `P${i}`, email: `p${i}@example.com` });
  assert.equal(last, 429, 'ten an hour from one address');
  resetRateLimits();
});

test('a lead\'s phone typed any way is stored one way, and the duplicate check matches it', async () => {
  const id = newId('lead');
  db().run(`INSERT INTO leads (id, parent_name, phone, source, status, created_at, updated_at) VALUES (?, 'Raw Phone', '+15125550199', 'manual', 'new', ?, ?)`, id, app.ctx.now(), app.ctx.now());
  const d = (await owner('GET', '/v1/leads/duplicates?phone=512.555.0199')).body;
  assert.equal(d.leads[0].id, id);
});

test('review fixes: a coach\'s lead page doesn\'t look up families or clients; a bad report date is a 400; a group text\'s link never adds an empty opt-out', async () => {
  // A coach can't search families and clients for duplicates, even by typing someone's phone on their own lead.
  const fam = await owner('POST', '/v1/clients', { name: 'Finn Private', parent: { name: 'Fay Private', email: 'fay.private@example.com', phone: '512-555-0177' } });
  assert.equal(fam.status, 201);
  const l = await addLead(owner, { parent_name: 'Coach Probe', email: 'probe@example.com' });
  await owner('PATCH', `/v1/leads/${l.id}`, { coach_id: coachId });
  assert.equal((await coach('PATCH', `/v1/leads/${l.id}`, { phone: '(512) 555-0177' })).status, 200);
  const seen = (await coach('GET', `/v1/leads/${l.id}`)).body.duplicates;
  assert.deepEqual([seen.families.length, seen.clients.length, seen.count], [0, 0, 0]);
  assert.ok(!JSON.stringify(seen).includes('Private'));
  assert.equal((await owner('GET', `/v1/leads/${l.id}`)).body.duplicates.families[0].parent_name, 'Fay Private', 'the owner still sees it');
  // An end date that isn't a date is refused, not a server error.
  const bad = await owner('GET', '/v1/leads/report?to=someday');
  assert.equal(bad.status, 400);
  // A group text's recipient row has no email: its token can't stop anyone's emails (or break the opt-out list).
  const cid = newId('cmp');
  db().run(`INSERT INTO campaigns (id, channel, subject, body, audience, status, created_at) VALUES (?, 'text', 'x', 'x', '{"group":"everyone"}', 'sent', ?)`, cid, app.ctx.now());
  db().run(`INSERT INTO campaign_recipients (id, campaign_id, email, phone, token, sent_at) VALUES (?, ?, NULL, '+15125550188', 'textrecipient01', ?)`, newId('cr'), cid, app.ctx.now());
  const before = db().get('SELECT COUNT(*) AS n FROM email_optouts').n;
  const r = await fetch(`${base}/c/textrecipient01?stop=1`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM email_optouts').n, before);
  assert.equal((await owner('POST', '/v1/campaigns/preview', { audience: { group: 'everyone' } })).status, 200);
});
