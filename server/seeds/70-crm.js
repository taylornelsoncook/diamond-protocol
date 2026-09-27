// CRM demo data: a dozen-plus leads across every stage and source (some stale, one with an evaluation held, one lost
// for schedule, one unsubscribed), calls, notes and emails on their timelines, tasks for the owner and the front desk,
// two converted leads linked to existing families (Park, member; Reyes, on trial), and a family whose trial ended
// without joining (Silva) to put back in the pipeline. Leaves every existing count (families, athletes, parents) alone.
'use strict';
const { get, all, insert, update } = require('../db');
const { today, addDays } = require('../lib');
const crm = require('../services/crm');

function seed() {
  if (get('SELECT 1 FROM crm_leads LIMIT 1')) return;
  const owner = get("SELECT id, name FROM staff WHERE role='owner' ORDER BY id LIMIT 1");
  const desk = get("SELECT id, name FROM staff WHERE role='frontdesk' ORDER BY id LIMIT 1");
  if (!owner || !desk) return;
  const T = today();
  const utc = (daysAgo, hour = 17) => { const d = new Date(Date.now() - daysAgo * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString().slice(0, 19).replace('T', ' '); };
  const PATH = ['new', 'contacted', 'evaluation', 'trial', 'member'];

  // [parent, email, phone, athletes, sport, position, source, detail, interest, stage, lost, daysAgo (first contact), stageDaysAgo, lastActivityDaysAgo, owner, extra]
  const L = [
    ['Sarah Miller', 'sarah.miller@example.com', '(801) 555-0188', [{ name: 'Jake', age: 13, grad_year: 2031 }], 'Baseball', 'Pitcher', 'website', null, 'evaluation', 'new', null, 0, 0, 0, null, { sms: 'Ticked "OK to text me" on the website form', notes: 'Wants to add velocity before spring tryouts.' }],
    ['Derek Owens', 'derek.owens@example.com', '801-555-0191', [{ name: 'Tyson', age: 15, grad_year: 2029 }], 'Baseball', 'Catcher', 'phone', null, 'privates', 'new', null, 9, 9, 9, desk, { notes: 'Called asking about catcher-specific privates.' }],
    ['Kelly Brandt', 'kelly.brandt@example.com', '385-555-0172', [{ name: 'Owen', age: 11 }, { name: 'Lily', age: 9 }], 'Baseball', null, 'referral', 'Maria Lopez', 'group', 'contacted', null, 6, 4, 2, desk, { sms: 'Asked on the phone' }],
    ['Marcus Webb', 'marcus.webb@example.com', '801-555-0107', [{ name: 'Andre', age: 16, grad_year: 2028 }], 'Baseball', 'Shortstop', 'camp', 'Summer Speed Camp', 'group', 'contacted', null, 21, 14, 12, owner, {}],
    ['Heather Lund', 'heather.lund@example.com', '801-555-0115', [{ name: 'Brooke', age: 14, grad_year: 2030 }], 'Softball', 'Center field', 'social', 'Instagram', 'evaluation', 'evaluation', null, 8, 3, 1, desk, { evaluation: true }],
    ['Ray Castillo', 'ray.castillo@example.com', '385-555-0139', [{ name: 'Mateo', age: 12 }], 'Baseball', null, 'walk_in', null, 'evaluation', 'evaluation', null, 16, 11, 10, owner, {}],
    ['Coach Dana Whitaker', 'dwhitaker@riverside.example.org', '801-555-0126', [], 'Baseball', null, 'team', 'Riverside High School', 'team', 'contacted', null, 12, 10, 3, owner, { notes: 'JV baseball, 22 players. Wants a winter speed block quote.' }],
    ['Nina Patel', 'nina.patel@example.com', '801-555-0150', [{ name: 'Arjun', age: 17, grad_year: 2027 }], 'Baseball', 'Outfield', 'website', null, 'privates', 'lost', 'schedule', 45, 30, 30, desk, { lostNote: 'Only free weekday mornings.' }],
    ['Todd Kimball', 'todd.kimball@example.com', '385-555-0184', [{ name: 'Cade', age: 10 }], 'Baseball', null, 'phone', null, 'group', 'lost', 'price', 60, 40, 40, owner, {}],
    ['Amy Fischer', 'amy.fischer@example.com', '801-555-0163', [{ name: 'Ella', age: 13 }], 'Volleyball', null, 'social', 'Facebook', 'group', 'lost', 'schedule', 38, 25, 25, desk, { optOut: true }],
    ['Brian Soto', 'brian.soto@example.com', '801-555-0174', [{ name: 'Leo', age: 14, grad_year: 2030 }], 'Baseball', 'Pitcher', 'referral', 'Coach Maddox', 'evaluation', 'lost', 'no_response', 50, 35, 35, owner, {}],
    ['Jenna Morales', 'jenna.morales@example.com', '385-555-0158', [{ name: 'Sofia', age: 12 }], 'Softball', null, 'website', null, 'camp', 'new', null, 2, 2, 2, null, {}],
    ['Grace Park', 'grace.park@example.com', '385-555-0147', [{ name: 'Olivia', age: 14 }], 'Basketball', 'Forward', 'referral', 'Jensen family', 'group', 'member', null, 75, 55, 55, owner, { family: 'Park' }],
    ['Daniel Reyes', 'daniel.reyes@example.com', '801-555-0105', [{ name: 'Daniel Reyes', age: 35 }], 'General fitness', null, 'walk_in', null, 'group', 'trial', null, 7, 3, 3, desk, { family: 'Reyes', sms: 'Asked at the front desk' }],
  ];

  const leads = {};
  for (const [parent, email, phone, athletes, sport, position, source, detail, interest, stage, lost, daysAgo, stageAgo, actAgo, own, x] of L) {
    const fam = x.family ? get("SELECT f.id, f.created_at FROM families f WHERE f.name LIKE ? ORDER BY id LIMIT 1", `${x.family}%`) : null;
    const id = insert('crm_leads', {
      parent_name: parent, email, phone: crm.cleanLead({ phone }, { partial: true }).phone, athletes: JSON.stringify(athletes), sport, position, source, source_detail: detail, interest,
      notes: x.notes || null, owner_id: own?.id || null, stage, lost_reason: lost, lost_note: x.lostNote || null,
      stage_changed_at: utc(stageAgo), last_activity_at: utc(actAgo), first_contact: addDays(T, -daysAgo), created_by: own?.name || 'the website form', created_at: utc(daysAgo, 15),
      family_id: fam?.id || null, family_linked_on: fam ? addDays(T, -Math.max(stageAgo, 1) - 2) : null, converted_at: fam ? utc(Math.max(stageAgo, 1) + 2) : null,
      ...(x.sms ? { sms_opt_in: 1, sms_opt_in_at: utc(daysAgo, 15), sms_opt_in_source: x.sms } : {}),
      ...(x.optOut ? { email_opt_out: 1, email_opt_out_at: utc(20) } : {}),
    });
    leads[parent] = id;
    // Stage history: every step up to where they are now, spread between first contact and the current stage.
    const target = stage === 'lost' ? (lost === 'no_response' ? 'contacted' : 'evaluation') : stage;
    const steps = PATH.slice(0, PATH.indexOf(target) + 1);
    steps.forEach((s, i) => {
      const ago = i === steps.length - 1 && stage !== 'lost' ? stageAgo : Math.round(daysAgo - ((daysAgo - stageAgo) * i) / Math.max(1, steps.length - (stage === 'lost' ? 0 : 1)));
      insert('crm_stage_changes', { lead_id: id, from_stage: i ? steps[i - 1] : null, to_stage: s, auto: s === 'trial' || s === 'member' || s === 'evaluation' ? 1 : 0, staff_name: i ? (s === 'contacted' ? own?.name || desk.name : 'System') : own?.name || 'the website form', created_at: utc(ago, 15 + i) });
    });
    if (stage === 'lost') insert('crm_stage_changes', { lead_id: id, from_stage: target, to_stage: 'lost', auto: 0, staff_name: own?.name || desk.name, created_at: utc(stageAgo, 18) });
    insert('crm_activities', { lead_id: id, family_id: fam?.id || null, kind: 'created', body: `Lead added · ${crm.label(crm.SOURCES, source)}${detail ? ` (${detail})` : ''}`, staff_id: own?.id || null, staff_name: source === 'website' ? null : own?.name || null, created_at: utc(daysAgo, 15) });
  }

  const act = (parent, kind, body, daysAgo, by, extra = {}) => insert('crm_activities', { lead_id: leads[parent], kind, body, staff_id: by?.id || null, staff_name: by?.name || null, created_at: utc(daysAgo, 18), ...extra });
  act('Sarah Miller', 'enquiry', 'Jake pitches for his 13U club team. We want him throwing harder by March without hurting his arm. Weekday evenings work best.', 0, null);
  act('Derek Owens', 'note', 'Asked about blocking and pop time work. Prefers Saturday mornings.', 9, desk);
  act('Kelly Brandt', 'call', 'Interested in the youth class for both kids. Sending times.', 4, desk, { outcome: 'reached' });
  act('Kelly Brandt', 'email', 'Hi Kelly,\n\nThanks for reaching out about training for Owen and Lily...', 2, desk, { meta: JSON.stringify({ subject: 'Thanks for getting in touch with Diamond Protocol' }) });
  act('Marcus Webb', 'call', null, 14, owner, { outcome: 'voicemail' });
  act('Marcus Webb', 'call', null, 12, owner, { outcome: 'no_answer' });
  act('Heather Lund', 'call', 'Booked Brooke for an evaluation. Mom will bring her.', 3, desk, { outcome: 'reached' });
  act('Ray Castillo', 'note', 'Walked in during Saturday Strength. Evaluation done; waiting on schedule.', 11, owner);
  act('Coach Dana Whitaker', 'call', 'Needs pricing for Dec–Feb, two sessions a week.', 3, owner, { outcome: 'reached' });
  act('Nina Patel', 'call', 'Only free weekday mornings; our high school slots are evenings.', 30, desk, { outcome: 'reached' });
  act('Todd Kimball', 'call', 'Went with the rec league program. Price was the reason.', 40, owner, { outcome: 'reached' });
  act('Brian Soto', 'call', null, 38, owner, { outcome: 'no_answer' });
  act('Brian Soto', 'call', null, 36, owner, { outcome: 'voicemail' });
  act('Grace Park', 'converted', 'Now a client: Olivia Park', 57, owner, { family_id: get("SELECT id FROM families WHERE name LIKE 'Park%'")?.id || null });
  act('Daniel Reyes', 'converted', 'Now a client: Daniel Reyes', 5, desk, { family_id: get("SELECT id FROM families WHERE name LIKE 'Reyes%'")?.id || null });

  // An evaluation held for Heather Lund's daughter: the next open evaluation time.
  try {
    const slot = crm.evalSlots('owner')[0];
    if (slot) crm.bookEvaluation(crm.leadRow(leads['Heather Lund']), slot.starts_at);
  } catch { /* no evaluation hours */ }

  // Tasks: overdue and due today for the front desk and the owner, and a few later.
  const task = (title, dueIn, who, parent, done = false) => insert('crm_tasks', { title, due_date: addDays(T, dueIn), assignee_id: who.id, lead_id: parent ? leads[parent] : null,
    family_id: parent ? get('SELECT family_id FROM crm_leads WHERE id=?', leads[parent]).family_id : null, created_by: owner.name, created_at: utc(3), ...(done ? { done_at: utc(1), done_by: who.name } : {}) });
  task('Call Derek back about catcher privates', -2, desk, 'Derek Owens');
  task('Send Kelly the youth class times', 0, desk, 'Kelly Brandt');
  task('Reply to Sarah Miller’s enquiry', 0, owner, 'Sarah Miller');
  task('Send Riverside the winter speed quote', -1, owner, 'Coach Dana Whitaker');
  task('Check in with Ray after the evaluation', 2, desk, 'Ray Castillo');
  task('Follow up on Daniel’s trial', 3, desk, 'Daniel Reyes');
  task('Confirm Brooke’s evaluation', -3, desk, 'Heather Lund', true);

  // A family whose free trial ended without joining (Silva): ready to go back into the pipeline.
  const isa = get("SELECT id FROM athletes WHERE first_name='Isabela' AND last_name='Silva'");
  const plan = get("SELECT id, price_cents FROM plans WHERE trial_days>0 ORDER BY id LIMIT 1");
  if (isa && plan && !get('SELECT 1 FROM memberships WHERE athlete_id=?', isa.id)) {
    insert('memberships', { athlete_id: isa.id, plan_id: plan.id, status: 'cancelled', started_at: addDays(T, -34), next_charge: addDays(T, -27), price_cents: plan.price_cents, cancelled_at: addDays(T, -27) });
  }
  // Parents who agreed to texts at sign-up (for group texts), and one who unsubscribed from emails.
  const maria = get("SELECT id FROM parents WHERE email='maria.lopez@example.com'");
  if (maria) update('parents', maria.id, { sms_opt_in: 1, sms_opt_in_at: utc(60), sms_opt_in_source: 'Signed up at the front desk' });
  const paulo = get("SELECT id FROM parents WHERE email='paulo.silva@example.com'");
  if (paulo) update('parents', paulo.id, { sms_opt_in: 1, sms_opt_in_at: utc(34), sms_opt_in_source: 'Asked during the trial' });
  void all;
}

module.exports = { seed };
