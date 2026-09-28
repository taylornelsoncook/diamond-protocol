// Creates the owner account plus sample plans, exercises, programs and clients.
// Safe to run once on an empty database; it refuses to run twice.
import { openDb } from './db.js';
import { createTestProvider } from './payments/test-provider.js';
import * as commerce from './services/commerce.js';
import * as schedule from './services/schedule.js';
import * as teams from './services/teams.js';
import * as perf from './services/performance.js';
import * as reports from './services/reports.js';
import * as uploads from './services/uploads.js';
import * as queue from './services/queue.js';
import { updateSettings } from './services/families.js';
import { localDate, addDaysToDate } from './util.js';
const weekStart = (d) => addDaysToDate(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7));
import * as billing from './services/billing.js';
import * as clients from './services/clients.js';
import * as programs from './services/programs.js';
import { createUser } from './services/access.js';
import * as engage from './services/engage.js';
import * as inventory from './services/inventory.js';
import * as shop from './services/shop.js';
import * as leads from './services/leads.js';
import * as contact from './services/contact.js';
import * as tasks from './services/tasks.js';
import * as profiles from './services/profiles.js';
import * as portal from './services/portal.js';
import { addDays, newId } from './util.js';

const ctx = { db: openDb(process.env.DB_FILE || 'data/diamond.db'), testMode: true, payments: createTestProvider(), mail: {}, now: () => new Date().toISOString() };
if (ctx.db.get('SELECT COUNT(*) AS n FROM users').n) { console.log('Database already has an account. Delete the data folder to start fresh.'); process.exit(0); }

const email = process.env.ADMIN_EMAIL || 'coach@diamondprotocol.local';
const password = process.env.ADMIN_PASSWORD || 'change-me-now';
const headCoach = createUser(ctx, { email, name: 'Head Coach', password });
// Sample staff (same sample password): a coach who leads classes and privates, and front desk.
const riley = createUser(ctx, { email: 'riley@diamondprotocol.local', name: 'Riley Brooks', password, role: 'coach' });
const desk = createUser(ctx, { email: 'desk@diamondprotocol.local', name: 'Jess Moreno', password, role: 'front_desk' });
const jordan = createUser(ctx, { email: 'jordan@diamondprotocol.local', name: 'Jordan Ellis', password, role: 'coach' });   // a third coach, for the owner's Coaches panel

const plans = {
  coach: billing.createPlan(ctx, { name: '1:1 Online Coaching', price_cents: 14900, trial_days: 7 }),
  hybrid: billing.createPlan(ctx, { name: 'Hybrid Coaching', price_cents: 24900, trial_days: 7 }),
  program: billing.createPlan(ctx, { name: 'Program Only', price_cents: 3900, trial_days: 7 })
};

// Sample demo videos are placeholders: replace video_url with your own recordings.
const ex = {};
for (const [key, name, cue] of [
  ['goblet', 'Goblet squat', 'Hold the bell at your chest. Sit between your heels, chest tall, knees track over toes.'],
  ['rdl', 'Romanian deadlift', 'Soft knees, push hips back until you feel the hamstrings, then drive hips forward.'],
  ['lunge', 'Walking lunge', 'Long step, back knee kisses the floor, push through the front heel.'],
  ['plank', 'Front plank', 'Elbows under shoulders, squeeze glutes, ribs down. Breathe.'],
  ['pushup', 'Push-up', 'Hands under shoulders, body in one line, chest to the floor.'],
  ['row', 'One-arm dumbbell row', 'Flat back, pull the elbow to your hip, pause at the top.'],
  ['press', 'Half-kneeling press', 'Squeeze the down-side glute, press straight up without leaning back.'],
  ['swing', 'Kettlebell swing', 'Hinge, hike the bell back, snap the hips. Arms are ropes.'],
  ['bike', 'Bike intervals', 'Hard means you can\'t hold a conversation. Easy means you could.'],
  ['incline', 'Incline dumbbell press', 'Bench at 30 degrees, lower to the upper chest, press up and slightly in.'],
  ['pulldown', 'Lat pulldown', 'Lead with the elbows, bar to the collarbone, control the way up.'],
  ['squat', 'Back squat', 'Brace before you descend. Hit depth, drive up through the whole foot.']
]) ex[key] = programs.createExercise(ctx, { name, instructions: cue });

function build(name, weeks, level, description, days) {
  const p = programs.createProgram(ctx, { name, weeks, level, description });
  for (let week = 1; week <= Math.min(weeks, 2); week++) {
    days.forEach(([title, items], i) => {
      const w = programs.addWorkout(ctx, p.id, { week, day: i + 1, title });
      for (const [k, rx] of items) programs.addWorkoutExercise(ctx, w.id, { exercise_id: ex[k].id, prescription: rx });
    });
  }
  return p;
}
const strength = build('Foundations of Strength', 8, 'Beginner', 'Learn the big patterns and build a base.', [
  ['Lower body', [['goblet', '3 × 10'], ['rdl', '3 × 8'], ['lunge', '3 × 12 each side'], ['plank', '3 × 40 sec']]],
  ['Upper body', [['pushup', '4 × 8'], ['row', '3 × 10 each side'], ['press', '3 × 8 each side']]],
  ['Conditioning', [['swing', '5 × 15'], ['bike', '8 × 30 sec hard, 60 sec easy']]]
]);
const hyper = build('Hypertrophy Block A', 6, 'Intermediate', 'Moderate loads, higher volume, steady progression.', [
  ['Push', [['incline', '4 × 10'], ['press', '3 × 12 each side'], ['pushup', '3 × max']]],
  ['Pull', [['pulldown', '4 × 10'], ['row', '3 × 12 each side']]],
  ['Legs', [['squat', '4 × 8'], ['rdl', '3 × 10'], ['lunge', '3 × 12 each side']]]
]);

const people = [
  ['Maya Okafor', 'coach', strength], ['Daniel Reyes', 'hybrid', hyper], ['Priya Nair', 'program', strength],
  ['Tom Becker', 'coach', strength], ['Aisha Rahman', 'hybrid', hyper], ['Leo Marchetti', 'coach', strength],
  ['Grace Kim', 'program', hyper], ['Sam Whitfield', 'coach', strength]
];
const made = {};
for (const [name, plan, prog] of people) {
  made[name] = await clients.createClient(ctx, { name, email: name.toLowerCase().replace(/\s+/g, '.') + '@example.com', plan_id: plans[plan].id, program_id: prog.id });
  if (name !== 'Tom Becker') await commerce.addTestCard(ctx, made[name].id);         // members pay with a saved card; Tom's trial has none yet
}
// Move everyone except Tom past their trial so they have a paid invoice; Daniel and Sam's cards decline.
ctx.db.run(`UPDATE clients SET card_status = 'declining' WHERE name IN ('Daniel Reyes', 'Sam Whitfield')`);
ctx.db.run(`UPDATE subscriptions SET current_period_end = ?, trial_ends_at = ? WHERE client_id != ?`, addDays(ctx.now(), -1), addDays(ctx.now(), -1), made['Tom Becker'].id);
ctx.db.run(`UPDATE subscriptions SET trial_ends_at = ?, current_period_end = ? WHERE client_id = ?`, addDays(ctx.now(), 2), addDays(ctx.now(), 2), made['Tom Becker'].id);
await billing.runBilling(ctx);
billing.pause(ctx, billing.currentSubscription(ctx, made['Leo Marchetti'].id).id);
// Billing samples: part of Grace's payment refunded, and Daniel's family already reminded to update the card.
const graceInv = ctx.db.get(`SELECT id FROM invoices WHERE client_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1`, made['Grace Kim'].id);
if (graceInv) await billing.refundInvoice(ctx, graceInv.id, { amount_cents: 2500, reason: 'Missed a week (travel)', email: false });
const danielInv = ctx.db.get(`SELECT id FROM invoices WHERE client_id = ? AND status = 'failed' LIMIT 1`, made['Daniel Reyes'].id);
if (danielInv) await billing.remindInvoice(ctx, danielInv.id);

// A few completed workouts
for (const name of ['Maya Okafor', 'Grace Kim', 'Aisha Rahman']) {
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ?', made[name].id);
  const home = programs.clientHome(ctx, c);
  if (home.workout) programs.completeWorkout(ctx, c, home.workout.id, { exercise_ids: home.workout.exercises.map((e) => e.id) });
}

// Point of sale: sample places, products and a simulated front-desk reader. Replace with your real ones.
const facility = await commerce.createLocation(ctx, { name: 'DP Facility', kind: 'facility', address_line1: '100 Sample St', city: 'Austin', state: 'TX', postal_code: '78701' });
const mobile = await commerce.createLocation(ctx, { name: 'Mobile (client homes)', kind: 'mobile', address_line1: '100 Sample St', city: 'Austin', state: 'TX', postal_code: '78701' });
const park = await commerce.createLocation(ctx, { name: 'Sample Park', kind: 'park', address_line1: '2100 Park Rd', city: 'Austin', state: 'TX', postal_code: '78746' });
const single = commerce.createProduct(ctx, { name: 'Single session', kind: 'session', price_cents: 8000 });
const five = commerce.createProduct(ctx, { name: '5-session pack', kind: 'pack', price_cents: 37500, sessions: 5 });
commerce.createProduct(ctx, { name: '10-session pack', kind: 'pack', price_cents: 70000, sessions: 10 });
const shirt = commerce.createProduct(ctx, { name: 'DP T-shirt', kind: 'gear', price_cents: 3000, track_stock: true, low_stock_at: 2 });
for (const [size, n] of [['Youth M', 6], ['S', 5], ['M', 8], ['L', 2]]) inventory.recordStock(ctx, shirt.id, { reason: 'received', variant_id: inventory.addVariant(ctx, shirt.id, { name: size }).id, quantity: n }, 'Sample data');
await commerce.registerReader(ctx, { registration_code: 'simulated-wpe', label: 'Front desk', location_id: facility.id });
const walkIn = await clients.createClient(ctx, { name: 'Jordan Lee', email: 'jordan.lee@example.com', program_id: strength.id });
async function sell(body, outcome = 'approved') {
  const s = await commerce.createSale(ctx, body);
  if (s.status === 'pending') await commerce.simulateTap(ctx, s.id, outcome);
}
await sell({ location_id: park.id, method: 'tap_to_pay', client_id: walkIn.id, items: [{ product_id: five.id }], save_card: true });
await sell({ location_id: mobile.id, method: 'tap_to_pay', client_id: made['Priya Nair'].id, items: [{ product_id: single.id }] });
await sell({ location_id: facility.id, method: 'cash', items: [{ product_id: shirt.id, variant_id: inventory.activeVariants(ctx, shirt.id).find((x) => x.name === 'M').id }] });
await sell({ location_id: facility.id, method: 'cash', client_id: walkIn.id, items: [{ product_id: shirt.id, variant_id: inventory.activeVariants(ctx, shirt.id).find((x) => x.name === 'L').id }], discount: { type: 'amount', value: 500, reason: 'Returning client' }, email_receipt: true });
commerce.checkIn(ctx, walkIn.id, { location_id: park.id, credit_type: 'private' });
commerce.checkIn(ctx, made['Maya Okafor'].id, { location_id: facility.id });

// Families, classes, a camp, and hours for privates and evaluations (sample data; replace with yours).
updateSettings(ctx, { timezone: process.env.BUSINESS_TZ || 'America/Chicago', late_cancel_hours: 12 });
const groupPack = commerce.createProduct(ctx, { name: '10 group classes', kind: 'pack', price_cents: 22000, sessions: 10, credit_type: 'group' });
const groupPlan = billing.createPlan(ctx, { name: 'Group membership (unlimited classes)', price_cents: 14900, trial_days: 0 });
const lopez = await clients.createClient(ctx, { name: 'Ava Lopez', birth_date: '2013-03-10', sex: 'F', sport: 'Soccer', position: 'Winger', school: 'Lincoln Middle', parent: { name: 'Maria Lopez', email: 'maria.lopez@example.com', phone: '555-0101' } });
await clients.createClient(ctx, { name: 'Ben Lopez', birth_date: '2016-06-01', sport: 'Baseball', family_id: lopez.family.id });
const cole = await clients.createClient(ctx, { name: 'Cole Park', birth_date: '2011-09-22', sex: 'M', sport: 'Football', position: 'WR', parent: { name: 'Dana Park', email: 'dana.park@example.com', phone: '555-0102' } });
const nguyen = await clients.createClient(ctx, { name: 'Mia Nguyen', birth_date: '2009-01-15', sport: 'Volleyball', medical_notes: 'Recovering from ankle sprain; no max-effort jumps until cleared.', emergency_name: 'Tran Nguyen', emergency_phone: '555-0199', parent: { name: 'Linh Nguyen', email: 'linh.nguyen@example.com' } });
for (const c of [lopez, cole, nguyen]) await commerce.addTestCard(ctx, c.id);
ctx.db.run(`UPDATE families SET waiver_version = 1, waiver_signed_by = 'Sample', waiver_signed_at = ? WHERE id IN (?, ?)`, ctx.now(), lopez.family.id, cole.family.id);
await billing.subscribe(ctx, lopez.id, groupPlan.id);
await sell({ location_id: facility.id, method: 'card_on_file', client_id: cole.id, items: [{ product_id: groupPack.id }] });

const today = localDate(ctx.now(), process.env.BUSINESS_TZ || 'America/Chicago');
const speed = await schedule.createSeries(ctx, { coach_id: riley.id, name: 'Speed & Agility', kind: 'group', location_id: facility.id, weekdays: [1, 3], start_time: '17:30', duration_min: 60, capacity: 12, age_min: 10, age_max: 15, drop_in_cents: 2500, start_date: today, description: 'Acceleration, change of direction and footwork.' });
await schedule.createSeries(ctx, { coach_id: headCoach.id, name: 'High School Strength', kind: 'group', location_id: facility.id, weekdays: [2, 4], start_time: '18:00', duration_min: 75, capacity: 10, age_min: 14, age_max: 19, drop_in_cents: 3000, start_date: today });
await schedule.createSeries(ctx, { coach_id: riley.id, name: 'Saturday Park Sprints', kind: 'group', location_id: park.id, weekdays: [6], start_time: '09:00', duration_min: 60, capacity: 16, age_min: 9, age_max: 18, drop_in_cents: 2000, start_date: today });
const campStart = addDaysToDate(today, 14 - new Date(`${today}T12:00:00Z`).getUTCDay() + 1);
await schedule.createSeries(ctx, { name: 'Fall Speed Camp', kind: 'camp', location_id: facility.id, weekdays: [1, 2, 3, 4, 5], start_time: '09:00', duration_min: 180, capacity: 16, age_min: 10, age_max: 16, registration_cents: 25000, start_date: campStart, end_date: addDaysToDate(campStart, 4), description: 'Five mornings of sprint mechanics, jumping and testing. Ends with a timed 40.' });
await schedule.createSeries(ctx, { name: 'QB & Receiver Clinic', kind: 'clinic', location_id: park.id, weekdays: [0], start_time: '14:00', duration_min: 120, capacity: 20, age_min: 12, age_max: 18, registration_cents: 12000, drop_in_cents: 6500, start_date: addDaysToDate(today, 3), end_date: addDaysToDate(today, 17) });
// Privates: Riley's at the facility and the park (whatever Riley leads anywhere blocks them), the head coach's on Tue/Thu.
for (const d of [1, 3, 5]) schedule.addAvailability(ctx, { kind: 'private', location_id: facility.id, weekday: d, start_time: '15:00', end_time: '17:00', slot_minutes: 60, coach_id: riley.id });
for (const d of [2, 4]) schedule.addAvailability(ctx, { kind: 'private', location_id: facility.id, weekday: d, start_time: '15:00', end_time: '17:00', slot_minutes: 60, coach_id: headCoach.id });
schedule.addAvailability(ctx, { kind: 'private', location_id: park.id, weekday: 6, start_time: '08:00', end_time: '11:00', slot_minutes: 60, coach_id: riley.id, confirm: true });   // around Riley's 9:00 class there (a coach clash warning, saved anyway)
schedule.addAvailability(ctx, { kind: 'evaluation', location_id: facility.id, weekday: 6, start_time: '11:00', end_time: '13:00', slot_minutes: 60, price_cents: 7500, coach_id: headCoach.id });
// Riley is off one day next week (their privates that day aren't offered), and the facility closes for a holiday.
const nextFriday = addDaysToDate(today, ((5 - new Date(`${today}T12:00:00Z`).getUTCDay() + 7) % 7) + 7);
schedule.addTimeOff(ctx, { user_id: riley.id, start_date: nextFriday, end_date: nextFriday, note: 'Tournament with the club team' }, { role: 'owner', name: 'Head Coach' });
schedule.addTimeOff(ctx, { user_id: null, start_date: addDaysToDate(today, 24), end_date: addDaysToDate(today, 25), note: 'Holiday: facility closed' }, { role: 'owner', name: 'Head Coach' });
await schedule.enroll(ctx, speed.id, lopez.id);
const next = schedule.listSessions(ctx, { from: ctx.now(), to: new Date(Date.now() + 14 * 86400000).toISOString(), kind: 'group' }).find((x) => x.series_id === speed.id);
if (next) { await schedule.book(ctx, { sessionId: next.id, clientId: cole.id, isCoach: true }); await schedule.book(ctx, { sessionId: next.id, clientId: nguyen.id, isCoach: true, overrideAge: true }); }
// The head coach subs for Riley on the second Speed & Agility session.
const second = schedule.listSessions(ctx, { from: ctx.now(), to: new Date(Date.now() + 14 * 86400000).toISOString(), kind: 'group' }).filter((x) => x.series_id === speed.id)[1];
if (second) schedule.updateSession(ctx, second.id, { coach_id: headCoach.id, confirm: true });
// Jordan's younger group (so three coaches have classes this week), a private Riley has booked, and last week's
// sessions with check-ins, so Today's Coaches panel has attendance to show. The days off above can fall on these
// (depending on today's weekday): coach clashes are only warnings, so the sample data saves anyway (confirm).
await schedule.createSeries(ctx, { confirm: true, coach_id: jordan.id, name: 'Youth Foundations', kind: 'group', location_id: facility.id, weekdays: [2, 5], start_time: '16:30', duration_min: 60, capacity: 10, age_min: 7, age_max: 11, drop_in_cents: 2000, start_date: today, description: 'Running form, jumping and landing, and games for younger athletes.' });
const colePrivate = await schedule.createSession(ctx, { confirm: true, name: 'Private: Cole Park', kind: 'private', location_id: facility.id, date: addDaysToDate(today, 2), start_time: '10:00', duration_min: 60, coach_id: riley.id, drop_in_cents: 8000 });
await schedule.book(ctx, { sessionId: colePrivate.id, clientId: cole.id, isCoach: true });
const benLopez = ctx.db.get(`SELECT id FROM clients WHERE name = 'Ben Lopez'`).id;
for (const [name, coachId, daysAgo, who] of [['Speed & Agility', riley.id, 5, [[lopez.id, 'attended'], [cole.id, 'attended'], [nguyen.id, 'no_show']]], ['High School Strength', headCoach.id, 4, [[nguyen.id, 'attended'], [cole.id, 'attended']]],
  ['Saturday Park Sprints', riley.id, 3, [[lopez.id, 'attended'], [cole.id, 'attended'], [benLopez, 'attended']]], ['Youth Foundations', jordan.id, 2, [[benLopez, 'attended'], [lopez.id, 'no_show']]]]) {
  const at = new Date(Date.now() - daysAgo * 86400000), id = `cls_seed_past_${daysAgo}`;
  ctx.db.run(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, coach_id, status, created_at) VALUES (?, ?, 'group', ?, ?, ?, 12, 2500, ?, 'scheduled', ?)`,
    id, name, name === 'Saturday Park Sprints' ? park.id : facility.id, at.toISOString(), new Date(at.getTime() + 3600000).toISOString(), coachId, ctx.now());
  for (const [clientId, status] of who) ctx.db.run(`INSERT INTO bookings (id, session_id, client_id, status, coverage, booked_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'membership', 'seed', ?, ?)`, `bkg_seed_${daysAgo}_${clientId}`, id, clientId, status, ctx.now(), ctx.now());
}

// Team contracts (sample): a high school billed monthly, and a club without a billing email yet.
updateSettings(ctx, { business_address: '1200 Sample Rd, Suite 4\nAustin, TX 78701', payment_instructions: 'Pay online with the button on this invoice (card or bank transfer), or mail a check payable to Diamond Protocol LLC to the address above.' });
const lastMonth = (() => { const d = new Date(`${today}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); })();
const westlake = await teams.createContract(ctx, { organization: { name: 'Westlake High School', kind: 'school', contact_name: 'Pat Alvarez', contact_email: 'athletics@westlake.example', billing_address: '4100 Westbank Dr\nAustin, TX 78746' }, name: 'Varsity Football', monthly_cents: 180000, start_date: lastMonth, po_number: 'PO-26-0412' }, 'http://localhost:3000');
teams.addRoster(ctx, westlake.id, { names: 'Jalen Brooks, QB, 2027\nMarcus Hill, WR, 2027\nTy Ortiz, RB, 2028\nDevin Carter, LB, 2027\nSam Whitaker, DB, 2028\nNoah Pruitt, TE, 2026\nEli Grant, OL, 2027\nChris Mendez, DL, 2028' });
await teams.recordPayment(ctx, westlake.invoices[westlake.invoices.length - 1].id, { method: 'check', reference: '#20431' });
await schedule.createSeries(ctx, { name: 'Westlake Varsity Football', kind: 'team', contract_id: westlake.id, location_id: park.id, weekdays: [2, 4], start_time: '15:30', duration_min: 75, capacity: 60, start_date: today });
await teams.createContract(ctx, { organization: { name: 'Hill Country FC', kind: 'club' }, name: '14U Girls', monthly_cents: 95000, start_date: addDaysToDate(today, 5), terms_days: 15 }, 'http://localhost:3000');

// Performance testing (sample): a summer baseline and a fall combine, so progress shows.
perf.syncLibrary(ctx);
const summer = addDaysToDate(today, -60), fall = addDaysToDate(today, -2);
const baseline = perf.createSession(ctx, { name: 'Summer baseline', date: summer, tests: ['height', 'seated_height', 'weight', 'dash_40yd', 'pro_agility', 'vertical_standing', 'broad_jump', 'cmj'], athletes: [{ client_id: lopez.id }, { client_id: cole.id }, { client_id: nguyen.id }] });
const combine = perf.createSession(ctx, { name: 'Fall combine', date: fall, tests: ['height', 'seated_height', 'weight', 'dash_40yd', 'pro_agility', 'vertical_standing', 'broad_jump', 'cmj'], athletes: [{ client_id: lopez.id }, { client_id: cole.id }, { client_id: nguyen.id }] });
const at = (d) => `${d}T15:00:00.000Z`;
const r = (who, test, value, extra = {}) => ({ client_id: who.id, test, value, ...extra });
perf.recordResults(ctx, [
  r(lopez, 'height', 61.5), r(lopez, 'seated_height', 31.8), r(lopez, 'weight', 98), r(lopez, 'dash_40yd', 6.12, { timing: 'hand' }), r(lopez, 'pro_agility', 5.21, { side: 'L' }), r(lopez, 'pro_agility', 5.3, { side: 'R' }), r(lopez, 'vertical_standing', 15.5), r(lopez, 'broad_jump', 72), r(lopez, 'cmj', 12.1),
  r(cole, 'height', 66), r(cole, 'seated_height', 33.9), r(cole, 'weight', 131), r(cole, 'dash_40yd', 5.24, { timing: 'electronic' }), r(cole, 'pro_agility', 4.71, { side: 'L' }), r(cole, 'pro_agility', 4.8, { side: 'R' }), r(cole, 'vertical_standing', 24), r(cole, 'broad_jump', 95), r(cole, 'cmj', 17.4),
  r(nguyen, 'height', 67.5), r(nguyen, 'weight', 138), r(nguyen, 'vertical_standing', 21), r(nguyen, 'broad_jump', 88)
].map((x) => ({ ...x, recorded_at: at(summer) })), { source: 'manual', sessionId: baseline.id });
perf.recordResults(ctx, [
  r(lopez, 'height', 62.25), r(lopez, 'seated_height', 32.3), r(lopez, 'weight', 101), r(lopez, 'dash_40yd', 5.94, { timing: 'hand' }), r(lopez, 'pro_agility', 5.02, { side: 'L' }), r(lopez, 'pro_agility', 5.11, { side: 'R' }), r(lopez, 'vertical_standing', 17), r(lopez, 'broad_jump', 77), r(lopez, 'cmj', 13.2),
  r(cole, 'height', 66.5), r(cole, 'seated_height', 34.2), r(cole, 'weight', 136), r(cole, 'dash_40yd', 5.09, { timing: 'electronic' }), r(cole, 'pro_agility', 4.58, { side: 'L' }), r(cole, 'pro_agility', 4.66, { side: 'R' }), r(cole, 'vertical_standing', 26.5), r(cole, 'broad_jump', 101), r(cole, 'cmj', 18.9),
  r(nguyen, 'height', 67.5), r(nguyen, 'weight', 137), r(nguyen, 'vertical_standing', 22), r(nguyen, 'broad_jump', 90)
].map((x) => ({ ...x, recorded_at: at(fall) })), { source: 'manual', sessionId: combine.id });

reports.shareSession(ctx, baseline.id, { notify: false });
reports.shareSession(ctx, combine.id, { parent_note: 'Big summer. Speed is trending the right way. Keep up the two sprint days a week, and we\'ll retest in December.', notify: false });

// Waiting results (sample): an OVR export with a nickname and a jump mat with a device ID, neither linked yet.
perf.recordResults(ctx, [
  { athlete: { name: 'Coley P' }, test: 'hop_10_5', metric: 'rsi', value: 2.21, recorded_at: at(fall), device: 'OVR Jump', external_id: 'ovr-demo-1' },
  { athlete: { name: 'Coley P' }, test: 'hop_10_5', metric: 'contact_time', value: 176, recorded_at: at(fall), device: 'OVR Jump', external_id: 'ovr-demo-2' },
  { athlete: { name: 'Coley P' }, test: 'vertical_standing', value: 26, recorded_at: at(fall), device: 'OVR Jump', external_id: 'ovr-demo-3' }
], { source: 'csv:ovr', provider: 'ovr' });
perf.recordResults(ctx, [
  { athlete: { external_id: 'MAT-0412', name: 'Athlete 12' }, test: 'vertical_standing', value: 17.5, recorded_at: at(fall), device: 'Jump mat', external_id: 'mat-demo-1' },
  { athlete: { external_id: 'MAT-0412', name: 'Athlete 12' }, test: 'vertical_standing', value: 18, recorded_at: at(fall), device: 'Jump mat', external_id: 'mat-demo-2' }
], { source: 'api:just_jump', provider: 'just_jump' });
// A Freelap chip linked to Cole, and last week's jump-mat sheet as a recent upload (so Undo has something to show).
queue.linkDevice(ctx, { provider: 'freelap', external_id: 'FL-2207', external_name: 'Chip 2207', client_id: cole.id });
const idOf = (c) => ctx.db.get('SELECT athlete_id FROM clients WHERE id = ?', c.id).athlete_id;
const matDay = addDaysToDate(today, -7);
const matSheet = uploads.previewUpload(ctx, { filename: 'jump-mat-week.csv', source: 'Jump mat', date: matDay,
  csv: `Athlete ID,Name,Vertical jump (in)\n${idOf(lopez)},Ava Lopez,17.5\n${idOf(cole)},Cole Park,26\n${idOf(nguyen)},${ctx.db.get('SELECT name FROM clients WHERE id = ?', nguyen.id).name},22.5` });
uploads.commitUpload(ctx, { preview_id: matSheet.preview_id, confirm: matSheet.warnings.map((w) => w.key) }, ctx.db.get(`SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1`));

// Accountability, performance targets and education (sample). Ava is on the Hill Country FC roster and Cole on Westlake's,
// so team goals, messages and reading reach them in the app and the parent portal.
const coachUser = ctx.db.get(`SELECT id, name FROM users ORDER BY created_at LIMIT 1`);
const realNow = ctx.now;
const at9 = (d) => `${d}T15:00:00.000Z`;
const hillCountry = ctx.db.get(`SELECT id FROM team_contracts WHERE name = '14U Girls'`).id;
teams.addRoster(ctx, hillCountry, { name: 'Ava Lopez', position: 'Winger', grad_year: 2031, client_id: lopez.id });
teams.addRoster(ctx, hillCountry, { names: 'Sofia Ramirez, Midfield, 2031\nEmma Clarke, Defender, 2031\nHannah Brooks, Forward, 2030\nZoe Patel, Goalkeeper, 2031' });
teams.addRoster(ctx, westlake.id, { name: 'Cole Park', position: 'WR', grad_year: 2029, client_id: cole.id });
// Team-only athletes: on the roster with a profile of their own, no family (Ava and Cole train privately too).
const roster = (contractId) => ctx.db.all('SELECT r.id, r.name FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.contract_id = ? AND c.family_id IS NULL AND r.active = 1 ORDER BY r.name', contractId);
const preseason = addDaysToDate(today, -9);
const hcDay = perf.createSession(ctx, { name: 'Hill Country preseason testing', date: preseason, contract_id: hillCountry, tests: ['dash_40yd', 'vertical_standing', 'broad_jump'] });
const hcVals = [[6.05, 16, 74], [5.88, 17.5, 79], [6.21, 15, 70], [5.97, 16.5, 76]];
perf.recordResults(ctx, roster(hillCountry).flatMap((r, i) => [['dash_40yd', hcVals[i][0], { timing: 'hand' }], ['vertical_standing', hcVals[i][1]], ['broad_jump', hcVals[i][2]]]
  .map(([test, value, extra = {}]) => ({ roster_id: r.id, test, value, recorded_at: at9(preseason), ...extra }))), { source: 'manual', sessionId: hcDay.id });
const wlDay = perf.createSession(ctx, { name: 'Westlake summer testing', date: summer, contract_id: westlake.id, tests: ['dash_40yd', 'vertical_standing', 'broad_jump'] });
const wlVals = [[4.92, 29, 108], [5.01, 27.5, 104], [5.18, 25, 98], [5.35, 23.5, 96], [4.88, 30, 110], [5.62, 21, 92]];
perf.recordResults(ctx, roster(westlake.id).slice(0, 6).flatMap((r, i) => [['dash_40yd', wlVals[i][0], { timing: 'electronic' }], ['vertical_standing', wlVals[i][1]], ['broad_jump', wlVals[i][2]]]
  .map(([test, value, extra = {}]) => ({ roster_id: r.id, test, value, recorded_at: at9(summer), ...extra }))), { source: 'manual', sessionId: wlDay.id });
reports.shareSession(ctx, hcDay.id, { notify: false });
reports.shareSession(ctx, wlDay.id, { notify: false });
engage.setRankings(ctx, { rankings: 'on' });

// Training over the last three weeks for Ava: workouts and walk-in check-ins, so streaks and the calendar fill in.
programs.assign(ctx, strength.id, lopez.id);
const avaRow = () => ctx.db.get('SELECT * FROM clients WHERE id = ?', lopez.id);
for (const back of [19, 17, 12, 10, 5, 3]) {
  ctx.now = () => `${addDaysToDate(today, -back)}T23:00:00.000Z`;
  const home = programs.clientHome(ctx, avaRow());
  if (home.workout) programs.completeWorkout(ctx, avaRow(), home.workout.id, { exercise_ids: home.workout.exercises.map((e) => e.id) });
}
for (const back of [15, 8, 1]) { ctx.now = () => `${addDaysToDate(today, -back)}T23:30:00.000Z`; commerce.checkIn(ctx, lopez.id, { location_id: facility.id }); }

// Daily check-ins: Ava every day but today (so the form is ready), Mia a few days, Cole flagged today.
const checkins = [
  [lopez, [[8.5, 4, 2, 4, 4], [8, 4, 3, 4, 5], [9, 5, 2, 5, 4], [7.5, 3, 3, 4, 4], [8, 4, 2, 4, 5], [8.5, 4, 2, 5, 5], [7, 3, 4, 3, 4], [8, 4, 2, 4, 4]], 1],
  [nguyen, [[7, 3, 3, 3, 4], [8, 4, 2, 4, 4], [8.5, 4, 2, 4, 5]], 1],
  [cole, [[7, 3, 3, 3, 4], [6.5, 3, 4, 3, 3], [5.5, 2, 4, 2, 3]], 0]
];
for (const [c, days, endsBack] of checkins) {
  days.forEach(([sleep_hours, hydration, soreness, energy, mood], i) => {
    ctx.now = () => `${addDaysToDate(today, -(days.length - 1 - i) - endsBack)}T13:00:00.000Z`;
    engage.saveCheckin(ctx, c.id, { sleep_hours, hydration, soreness, energy, mood, note: c === cole && i === days.length - 1 ? 'Hamstring is tight from Tuesday.' : undefined });
  });
}
ctx.now = realNow;

// Goals, messages and test targets.
engage.createGoal(ctx, { clientId: lopez.id }, { kind: 'workouts', target: 3, title: '3 workouts this week' }, coachUser);
engage.createGoal(ctx, { clientId: lopez.id }, { kind: 'checkins', target: 5, title: 'Check in 5 days' }, coachUser);
const mobility = engage.createGoal(ctx, { clientId: lopez.id }, { kind: 'custom', target: 4, title: '10 minutes of mobility' }, coachUser);
ctx.db.run('INSERT INTO goal_checks (goal_id, client_id, date) VALUES (?, ?, ?)', mobility.id, lopez.id, weekStart(today) < today ? weekStart(today) : today);
engage.createGoal(ctx, { contractId: hillCountry }, { kind: 'sessions', target: 2, title: 'Make 2 team sessions this week' }, coachUser);
engage.createGoal(ctx, { clientId: cole.id }, { kind: 'checkins', target: 6, title: 'Check in 6 days' }, coachUser);
engage.sendMessage(ctx, { contractId: hillCountry }, { body: 'Great energy at practice. Hydrate before Thursday; it will be hot on the field.' }, coachUser);
engage.sendMessage(ctx, { clientId: lopez.id }, { body: 'Your broad jump is up 5 inches since summer. Keep the landings quiet and we will chase 6 feet 8.' }, coachUser);
engage.sendMessage(ctx, { clientId: cole.id }, { body: 'Saw your check-in: short on sleep and a tight hamstring. Easy warm-up today and tell me how it feels.' }, coachUser);
// Parent courses: the starter drafts, two of them published.
engage.addStarterParentCourses(ctx);
for (const t of ['Growth spurts and training', 'Fueling a young athlete']) engage.updateCourse(ctx, ctx.db.get('SELECT id FROM courses WHERE title = ?', t).id, { published: true });
// Online store: one program for sale at /shop and in the parent portal.
shop.setForSale(ctx, 'program', strength.id, { for_sale: true, price_cents: 4900 });
// Skill badges, with one earned by Ava.
const sprintStart = engage.createBadge(ctx, { name: 'Sprint start', category: 'Speed', description: 'Drives out of a two-point start with a low, powerful first three steps.' });
engage.createBadge(ctx, { name: 'Hinge pattern', category: 'Strength', description: 'Hinges at the hips with a flat back, ready for deadlifts and cleans.' });
engage.createBadge(ctx, { name: 'Quiet landings', category: 'Power', description: 'Lands jumps softly with knees tracking over toes.' });
engage.awardBadge(ctx, sprintStart.id, { client_id: lopez.id, note: 'Your first step is so much quicker than in the summer.' }, coachUser);
engage.setTarget(ctx, lopez.id, { test: 'broad_jump', target: '6\'8"', due_date: addDaysToDate(today, 60) }, coachUser);
engage.setTarget(ctx, lopez.id, { test: 'dash_40yd', target: '5.75', due_date: addDaysToDate(today, 60) }, coachUser);
engage.setTarget(ctx, cole.id, { test: 'vertical_standing', target: '28', due_date: addDaysToDate(today, 90) }, coachUser);

// Education: a four-lesson course and two stand-alone lessons.
const recovery = engage.createCourse(ctx, { title: 'Recovery basics', description: 'Four short lessons on recovering well, so every session counts.' });
const lessons = [
  ['Why sleep is your best supplement', 'Growth, speed and focus all depend on it.', 'Most of your progress happens while you sleep. Athletes your age need 8 to 10 hours a night.\n\nTonight: phone out of the bedroom, lights out at the same time, and a cool, dark room.', 4],
  ['Hydration you can actually follow', 'A simple plan for training days.', 'Drink a full bottle with breakfast, another before training, and sip during.\n\nCheck your color: pale yellow means you are on track.', 3],
  ['Soreness or pain?', 'When to push and when to tell a coach.', 'Soreness is dull, in the muscle, and eases as you warm up. Pain is sharp, in a joint, or gets worse as you move.\n\nIf it is pain, stop and tell your coach.', 3],
  ['The 10-minute cool-down', 'What to do right after a hard session.', 'Walk for 3 minutes, then hips, calves and upper back for 2 minutes each.\n\nThen eat something with protein within an hour.', 5]
].map(([title, summary, body, minutes]) => engage.createLesson(ctx, { title, summary, body, minutes, course_id: recovery.id }));
const fuel = engage.createLesson(ctx, { title: 'Fuel before a game', summary: 'What to eat 3 hours, 1 hour and 15 minutes out.', body: '3 hours out: a real meal with carbs and protein.\n\n1 hour out: something small and easy, like a banana.\n\n15 minutes out: water only.', minutes: 4 , quiz_text: 'What should you eat about 3 hours before a game?\n* A real meal with carbs and protein\n- Nothing at all\n- A big bag of candy\n\nWhat is best 15 minutes before a game?\n- An energy drink\n* Water\n- A burger' });
const mindset = engage.createLesson(ctx, { title: 'Mindset: next play', summary: 'How great athletes reset after a mistake.', body: 'Name it, let it go, and focus on your next job.\n\nTake one breath and pick one cue word you say to yourself.', minutes: 3 });
engage.assign(ctx, { course_id: recovery.id, client_id: lopez.id, due_date: addDaysToDate(today, 7), note: 'Start with sleep. Takes 15 minutes in total.' }, coachUser);
ctx.db.run('INSERT INTO lesson_progress (lesson_id, client_id, completed_at) VALUES (?, ?, ?)', lessons[0].id, lopez.id, ctx.now());
engage.assign(ctx, { lesson_id: fuel.id, contract_id: hillCountry, due_date: addDaysToDate(today, 3) }, coachUser);
engage.assign(ctx, { lesson_id: mindset.id, contract_id: westlake.id, due_date: addDaysToDate(today, 5) }, coachUser);

// Staff notes on Ava (one pinned, one only coaches see), and a client who stopped training, archived.
clients.addNote(ctx, lopez.id, { body: 'Mom (Maria) prefers texts over calls. Ava is picked up at 6:45 on weekdays.', pinned: true }, { id: headCoach.id, name: 'Head Coach', role: 'owner' });
clients.addNote(ctx, lopez.id, { body: 'Lost confidence after a tough club season. Keep the praise specific and the reps short.', coach_only: true }, { id: riley.id, name: 'Riley Brooks', role: 'coach' });
clients.addNote(ctx, lopez.id, { body: 'Asked about the fall camp dates at the desk. Sent the link.' }, { id: desk.id, name: 'Jess Moreno', role: 'front_desk' });
const owen = await clients.createClient(ctx, { name: 'Owen Fischer', birth_date: '2010-04-18', sport: 'Baseball', parent: { name: 'Karen Fischer', email: 'karen.fischer@example.com', phone: '555-0144' }, send_welcome: false });
await clients.archiveClient(ctx, owen.id, {}, { name: 'Head Coach' });

// Programs (batch B8): library categories, and sets, effort and notes on Ava's logged workouts, so the builder, the
// Programs page feed and the athlete app's history have something to show.
for (const [key, category] of [['goblet', 'Lower body'], ['rdl', 'Lower body'], ['lunge', 'Lower body'], ['squat', 'Lower body'], ['plank', 'Core'], ['pushup', 'Upper body'], ['row', 'Upper body'],
  ['press', 'Upper body'], ['incline', 'Upper body'], ['pulldown', 'Upper body'], ['swing', 'Power'], ['bike', 'Conditioning']]) programs.updateExercise(ctx, ex[key].id, { category });
{
  const avaLogs = ctx.db.all('SELECT id, workout_id, completed_at FROM workout_logs WHERE client_id = ? ORDER BY completed_at', lopez.id);
  avaLogs.forEach((l, i) => {
    const items = ctx.db.all('SELECT we.id, we.exercise_id, we.prescription, e.name FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id WHERE we.workout_id = ? ORDER BY we.position', l.workout_id);
    for (const x of items) {
      const rx = programs.parseRx(x.prescription);
      for (let n = 1; n <= rx.sets; n++) {
        const weight = rx.reps == null || ['pushup', 'plank'].some((k) => ex[k].id === x.exercise_id) ? null : 20 + i * 5;
        ctx.db.run('INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          newId('set'), l.id, x.id, x.exercise_id, x.name, n, weight, rx.reps, l.completed_at);
      }
    }
    ctx.db.run('UPDATE workout_logs SET rpe = ?, started_at = ?, notes = ? WHERE id = ?', [6, 7, 5, 8, 7, 6][i % 6], new Date(Date.parse(l.completed_at) - (38 + i * 3) * 60000).toISOString(),
      i === avaLogs.length - 1 ? 'Lunges felt easier today.' : null, l.id);
  });
}

// Families who asked about training (the CRM): one the owner gave to Riley (coaches see only the leads given to them),
// the rest worked by the owner and the front desk, across the pipeline: new, contacted (one stale), an evaluation, a
// trial, a member and a lost lead, with calls, notes, tasks on Today and a text consent.
{
  const quiet = { ...ctx, publicUrl: '' };
  const ownerU = { ...headCoach, role: 'owner' }, deskU = { ...desk, role: 'front_desk' }, rileyU = { ...riley, role: 'coach' };
  const back = (id, days, stage) => {             // set a lead's dates back, as if it came in days ago
    const at = new Date(Date.now() - days * 86400000).toISOString();
    ctx.db.run('UPDATE leads SET created_at = ?, stage_changed_at = ?, last_activity_at = ? WHERE id = ?', at, at, at, id);
    ctx.db.run('UPDATE lead_stage_history SET at = ? WHERE lead_id = ?', at, id);
    if (stage) ctx.db.run('UPDATE lead_stage_history SET at = ? WHERE lead_id = ? AND to_stage = ?', new Date(Date.now() - (days - 1) * 86400000).toISOString(), id, stage);
  };
  const given = await leads.addLead(quiet, { parent_name: 'Tanya Brooks', email: 'tanya.brooks@example.com', phone: '(512) 555-0147', athlete_name: 'Jalen Brooks', athlete_age: 13, sport: 'Football', source: 'event', follow_up: false, message: 'Met you at the spring showcase. Jalen wants to get faster for fall.' }, ownerU);
  ctx.db.run('UPDATE leads SET coach_id = ? WHERE id = ?', riley.id, given.id);
  back(given.id, 3);
  await leads.updateLead(quiet, given.id, { status: 'contacted' }, { user: rileyU });
  contact.logLeadActivity(quiet, given.id, { kind: 'call', outcome: 'voicemail', body: 'Left a message about Saturday speed class.' }, { user: rileyU });
  tasks.createTask(quiet, { lead_id: given.id, title: 'Call Tanya back about the evaluation', due_date: localDate(new Date().toISOString(), 'America/Chicago') }, { user: rileyU });

  const omar = await leads.addLead(quiet, { parent_name: 'Omar Haddad', phone: '(512) 555-0142', athlete_name: 'Sami Haddad', athlete_age: 11, sport: 'Soccer', source: 'phone', follow_up: false, texts_ok: true, texts_ok_source: 'Said yes on the phone' }, deskU);
  back(omar.id, 1);
  tasks.createTask(quiet, { lead_id: omar.id, title: 'Text Omar the Book now link', due_date: localDate(new Date().toISOString(), 'America/Chicago') }, { user: deskU });

  const nora = await leads.addLead(quiet, { parent_name: 'Nora Castillo', email: 'nora.castillo@example.com', athlete_name: 'Diego Castillo', athlete_age: 15, sport: 'Baseball', source: 'referral', follow_up: false, notes: 'Referred by the Lopez family. Wants pitching work.' }, deskU);
  await leads.updateLead(quiet, nora.id, { status: 'contacted' }, { user: deskU });
  tasks.createTask(quiet, { lead_id: nora.id, title: 'Check in with Nora about pitching', due_date: addDaysToDate(localDate(new Date().toISOString(), 'America/Chicago'), -2), assignee_id: headCoach.id }, { user: deskU });
  back(nora.id, 12, 'contacted');                  // 11 days in Contacted with nothing since: stale

  const grace = await leads.addLead(quiet, { parent_name: 'Grace Kim', email: 'grace.kim@example.com', athlete_name: 'Hana Kim', athlete_age: 12, sport: 'Softball', source: 'social', follow_up: false }, ownerU);
  back(grace.id, 20);
  await leads.updateLead(quiet, grace.id, { status: 'lost', lost_reason: 'schedule', lost_note: 'Weekends only this season.' }, { user: ownerU });

  const ben = await leads.addLead(quiet, { parent_name: 'Ben Walker', email: 'ben.walker@example.com', athlete_name: 'Eli Walker', athlete_age: 10, sport: 'Baseball', source: 'walk_in', follow_up: false }, deskU);
  back(ben.id, 6);
  await leads.updateLead(quiet, ben.id, { status: 'contacted' }, { user: deskU });
  contact.logLeadActivity(quiet, ben.id, { kind: 'call', outcome: 'reached', body: 'Eli can do Tuesdays. Booking an evaluation.' }, { user: deskU });
  await leads.updateLead(quiet, ben.id, { status: 'evaluation' }, { user: deskU });
}
// Parent portal (batches B12 and B13). The Jensen family: two kids, card (expiring next month) and waiver on file, booked
// into classes, with a pack bought. Luke Jensen was already on the Westlake roster (team only, no birthday on file), so the
// parent's Athlete ID can't be checked: the owner is asked to merge the two profiles. The Silva family has no card or
// waiver yet. Mia Nguyen's family card declines, so her membership is past due. A Winter retest is planned.
teams.addRoster(ctx, westlake.id, { names: 'Luke Jensen, P, 2030' });
const lukeTeam = ctx.db.get(`SELECT id, athlete_id FROM clients WHERE name = 'Luke Jensen'`);
const jensen = await clients.createClient(ctx, { name: 'Luke Jensen', birth_date: '2012-08-14', sex: 'M', sport: 'Baseball', emergency_name: 'Anna Jensen', emergency_phone: '(512) 555-0161', parent: { name: 'Kurt Jensen', email: 'kurt.jensen@example.com', phone: '(512) 555-0160' }, send_welcome: false });
const lily = await clients.createClient(ctx, { name: 'Lily Jensen', birth_date: '2014-11-02', sex: 'F', sport: 'Soccer', family_id: jensen.family.id, send_welcome: false });
{
  const kurt = ctx.db.get('SELECT * FROM guardians WHERE family_id = ?', jensen.family.id);
  const tried = profiles.tryClaim(ctx, { code: lukeTeam.athlete_id, name: 'Luke Jensen', birthDate: '2012-08-14', familyId: jensen.family.id, guardian: kurt });
  profiles.fileClaim(ctx, { code: lukeTeam.athlete_id, familyId: jensen.family.id, guardian: kurt, claim: tried, newClientId: jensen.id });
}
await commerce.addTestCard(ctx, jensen.id);
{
  const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1);
  ctx.db.run(`UPDATE families SET waiver_version = 1, waiver_signed_by = 'Kurt Jensen <kurt.jensen@example.com>', waiver_signed_at = ?, card_exp = ? WHERE id = ?`, ctx.now(), d.toISOString().slice(0, 7), jensen.family.id);
}
await sell({ location_id: facility.id, method: 'card_on_file', client_id: jensen.id, items: [{ product_id: groupPack.id }] });
{
  const soon = schedule.listSessions(ctx, { from: ctx.now(), to: new Date(Date.now() + 14 * 86400000).toISOString(), kind: 'group' });
  const speedNext = soon.find((x) => x.series_id === speed.id), youth = soon.find((x) => x.name === 'Youth Foundations');
  if (speedNext) await schedule.book(ctx, { sessionId: speedNext.id, clientId: jensen.id, actor: 'seed' });
  if (youth) await schedule.book(ctx, { sessionId: youth.id, clientId: lily.id, isCoach: true });
}
const silva = await clients.createClient(ctx, { name: 'Rafa Silva', birth_date: '2013-05-20', sport: 'Soccer', parent: { name: 'Paulo Silva', email: 'paulo.silva@example.com', phone: '(512) 555-0170' }, send_welcome: false });
void silva;
ctx.db.run(`UPDATE families SET card_status = 'declining' WHERE id = ?`, nguyen.family.id);
await billing.subscribe(ctx, nguyen.id, groupPlan.id);
perf.createSession(ctx, { name: 'Winter retest', date: addDaysToDate(today, 21), tests: ['height', 'weight', 'dash_40yd', 'vertical_standing', 'broad_jump'], athletes: [{ client_id: lopez.id }, { client_id: jensen.id }, { client_id: lily.id }] });
// Maria asked to pause Ava's membership over the holidays (it shows on Ava's client page for the owner).
portal.requestMembershipChange(ctx, ctx.db.get(`SELECT * FROM guardians WHERE email = 'maria.lopez@example.com'`), lopez.id, { kind: 'pause', note: 'We travel for three weeks in December.' });
// ---- API & integrations and Staff & security (batch B14) ----
{
  // A coach who left: turned off but still holding a block of private hours, so Staff & security flags "Hand over".
  const sam = createUser(ctx, { email: 'sam@diamondprotocol.local', name: 'Sam Ortiz', password, role: 'coach' });
  const place = ctx.db.get('SELECT id FROM locations WHERE active = 1 ORDER BY created_at LIMIT 1');
  if (place) ctx.db.run(`INSERT INTO availability (id, kind, location_id, weekday, start_time, end_time, slot_minutes, coach_id, created_at) VALUES (?, 'private', ?, 6, '09:00', '11:00', 60, ?, ?)`, newId('av'), place.id, sam.id, ctx.now());
  ctx.db.run('UPDATE users SET active = 0, last_login_at = ? WHERE id = ?', addDays(ctx.now(), -40), sam.id);
  // Two API keys with a month of requests: timing gates that send results, and a read-only website widget.
  const key = (label, scope) => { const id = newId('key'); ctx.db.run('INSERT INTO api_keys (id, label, prefix, key_hash, created_at, scope, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, label, `dp_live_${id.slice(-4)}`, `demo-${id}`, addDays(ctx.now(), -30), scope, addDays(ctx.now(), -0.1)); return id; };
  const gates = key('Timing gates (Freelap)', 'results'), site = key('Website schedule widget', 'read');
  const reqs = [[gates, 'POST', '/v1/results', 201], [gates, 'GET', '/v1/tests', 200], [site, 'GET', '/v1/schedule', 200], [site, 'GET', '/v1/slots', 200]];
  for (let i = 0; i < 40; i++) {
    const [k, m, p, s] = reqs[i % reqs.length];
    ctx.db.run('INSERT INTO api_requests (id, key_id, at, method, path, status, duration_ms, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('req'), k, addDays(ctx.now(), -i * 0.6), m, p, s, 20 + (i * 7) % 60, '203.0.113.24');
  }
  ctx.db.run('INSERT INTO api_requests (id, key_id, at, method, path, status, duration_ms, ip, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('req'), site, addDays(ctx.now(), -2), 'POST', '/v1/slots/book', 403, 4, '203.0.113.24',
    'This API key is read only. Ask the owner for a key that can send data.');
  // A paused webhook with a delivered and a failed send (paused, so the demo never sends anything out).
  const hook = newId('whe');
  ctx.db.run(`INSERT INTO webhook_endpoints (id, url, secret, events, active, created_at, label, failures) VALUES (?, 'https://hooks.zapier.com/hooks/catch/000000/demo/', ?, '["client.created","booking.created","sale.completed"]', 0, ?, 'Zapier (CRM)', 1)`,
    hook, `whsec_demo${newId('x').slice(-8)}`, addDays(ctx.now(), -20));
  const evs = ctx.db.all(`SELECT id, type, created_at FROM events WHERE type IN ('client.created','booking.created') ORDER BY created_at DESC LIMIT 2`);
  evs.forEach((e, i) => ctx.db.run(`INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, status, attempts, response_code, last_error, created_at, last_attempt_at, duration_ms, response_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('whd'), hook, e.id, e.type, i ? 'failed' : 'succeeded', i ? 6 : 1, i ? 500 : 200, i ? 'The receiver answered 500.' : null, e.created_at, e.created_at, i ? 812 : 143, i ? 'Internal Server Error' : '{"status":"success"}'));
}

// ---- The owner's improvements (version 46): how each client trains, and posts under Coach's education, Blogs and Research.
for (const [name, kind] of [['Daniel Reyes', 'hybrid'], ['Aisha Rahman', 'hybrid'], ['Maya Okafor', 'remote'], ['Priya Nair', 'remote'], ['Grace Kim', 'remote'], ['Tom Becker', 'in_facility']]) {
  if (made[name]) ctx.db.run('UPDATE clients SET training_type = ? WHERE id = ?', kind, made[name].id);
}
ctx.db.run(`UPDATE clients SET training_type = 'in_facility' WHERE id = ?`, lopez.id);
// The Nguyen family's declined payment also declined on its first retry, so their portal shows the payment lockout.
ctx.db.run(`UPDATE invoices SET attempts = max(attempts, 2), auto_attempts = 2 WHERE status = 'failed' AND client_id IN (SELECT c.id FROM clients c JOIN guardians g ON g.family_id = c.family_id WHERE g.email = 'linh.nguyen@example.com')`);
engage.createLesson(ctx, { category: 'coach', title: 'Coaching the hip hinge', summary: 'Three cues that fix most deadlift patterns.', minutes: 5,
  body: 'Start with the hips, not the chest: "push the wall behind you with your hips."\n\nKeep the shins nearly still. If the knees drift forward, it has become a squat.\n\nFilm from the side. Most athletes feel straight when they are not.' });
engage.createLesson(ctx, { category: 'blog', title: 'Summer speed camp recap', summary: 'What 40 athletes worked on this July, and what comes next.', minutes: 3,
  body: 'Forty athletes spent four weeks on acceleration mechanics, landing and change of direction.\n\nAverage 10-yard times dropped by a tenth of a second. Fall group classes pick up where camp left off.' });
engage.createLesson(ctx, { category: 'research', title: 'Sleep and injury risk in teen athletes', summary: 'What the research says about getting 8 hours or more.', minutes: 4,
  body: 'Several studies of high school athletes found that those sleeping fewer than 8 hours a night were injured more often than those who slept more.\n\nThe simplest change most families can make: a consistent bedtime and phones out of the bedroom.' });

console.log(`Seeded. Sign in at http://localhost:${process.env.PORT || 3000} with ${email} / ${password}`);
console.log(`Sample staff (same password): riley@diamondprotocol.local and jordan@diamondprotocol.local (coaches), desk@diamondprotocol.local (front desk)`);
console.log(`Parent portal: http://localhost:${process.env.PORT || 3000}/parent (sign in as maria.lopez@example.com, kurt.jensen@example.com (two kids), linh.nguyen@example.com (card declining, locked out until it's paid) or paulo.silva@example.com (no card or waiver yet); in test mode the code is shown on screen)`);
console.log(`Client app example (Maya): http://localhost:${process.env.PORT || 3000}${clients.getClient(ctx, made['Maya Okafor'].id, { withSecrets: true }).app_link}`);
console.log(`Athlete app with accountability, performance and education (Ava): http://localhost:${process.env.PORT || 3000}${clients.getClient(ctx, lopez.id, { withSecrets: true }).app_link}`);
ctx.db.close();
