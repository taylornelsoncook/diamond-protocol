// Creates the owner account plus sample plans, exercises, programs and clients.
// Safe to run once on an empty database; it refuses to run twice.
import { openDb } from './db.js';
import { createTestProvider } from './payments/test-provider.js';
import * as commerce from './services/commerce.js';
import * as schedule from './services/schedule.js';
import * as teams from './services/teams.js';
import * as perf from './services/performance.js';
import * as reports from './services/reports.js';
import { updateSettings } from './services/families.js';
import { localDate, addDaysToDate } from './util.js';
import * as billing from './services/billing.js';
import * as clients from './services/clients.js';
import * as programs from './services/programs.js';
import { createUser } from './services/access.js';
import { addDays } from './util.js';

const ctx = { db: openDb(process.env.DB_FILE || 'data/diamond.db'), testMode: true, payments: createTestProvider(), mail: {}, now: () => new Date().toISOString() };
if (ctx.db.get('SELECT COUNT(*) AS n FROM users').n) { console.log('Database already has an account. Delete the data folder to start fresh.'); process.exit(0); }

const email = process.env.ADMIN_EMAIL || 'coach@diamondprotocol.local';
const password = process.env.ADMIN_PASSWORD || 'change-me-now';
createUser(ctx, { email, name: 'Head Coach', password });

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
const shirt = commerce.createProduct(ctx, { name: 'DP T-shirt', kind: 'gear', price_cents: 3000 });
await commerce.registerReader(ctx, { registration_code: 'simulated-wpe', label: 'Front desk', location_id: facility.id });
const walkIn = await clients.createClient(ctx, { name: 'Jordan Lee', email: 'jordan.lee@example.com', program_id: strength.id });
async function sell(body, outcome = 'approved') {
  const s = await commerce.createSale(ctx, body);
  if (s.status === 'pending') await commerce.simulateTap(ctx, s.id, outcome);
}
await sell({ location_id: park.id, method: 'tap_to_pay', client_id: walkIn.id, items: [{ product_id: five.id }], save_card: true });
await sell({ location_id: mobile.id, method: 'tap_to_pay', client_id: made['Priya Nair'].id, items: [{ product_id: single.id }] });
await sell({ location_id: facility.id, method: 'cash', items: [{ product_id: shirt.id }] });
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
const speed = await schedule.createSeries(ctx, { name: 'Speed & Agility', kind: 'group', location_id: facility.id, weekdays: [1, 3], start_time: '17:30', duration_min: 60, capacity: 12, age_min: 10, age_max: 15, drop_in_cents: 2500, start_date: today, description: 'Acceleration, change of direction and footwork.' });
await schedule.createSeries(ctx, { name: 'High School Strength', kind: 'group', location_id: facility.id, weekdays: [2, 4], start_time: '18:00', duration_min: 75, capacity: 10, age_min: 14, age_max: 19, drop_in_cents: 3000, start_date: today });
await schedule.createSeries(ctx, { name: 'Saturday Park Sprints', kind: 'group', location_id: park.id, weekdays: [6], start_time: '09:00', duration_min: 60, capacity: 16, age_min: 9, age_max: 18, drop_in_cents: 2000, start_date: today });
const campStart = addDaysToDate(today, 14 - new Date(`${today}T12:00:00Z`).getUTCDay() + 1);
await schedule.createSeries(ctx, { name: 'Fall Speed Camp', kind: 'camp', location_id: facility.id, weekdays: [1, 2, 3, 4, 5], start_time: '09:00', duration_min: 180, capacity: 16, age_min: 10, age_max: 16, registration_cents: 25000, start_date: campStart, end_date: addDaysToDate(campStart, 4), description: 'Five mornings of sprint mechanics, jumping and testing. Ends with a timed 40.' });
await schedule.createSeries(ctx, { name: 'QB & Receiver Clinic', kind: 'clinic', location_id: park.id, weekdays: [0], start_time: '14:00', duration_min: 120, capacity: 20, age_min: 12, age_max: 18, registration_cents: 12000, drop_in_cents: 6500, start_date: addDaysToDate(today, 3), end_date: addDaysToDate(today, 17) });
for (const d of [1, 2, 3, 4, 5]) schedule.addAvailability(ctx, { kind: 'private', location_id: facility.id, weekday: d, start_time: '15:00', end_time: '17:00', slot_minutes: 60 });
schedule.addAvailability(ctx, { kind: 'evaluation', location_id: facility.id, weekday: 6, start_time: '11:00', end_time: '13:00', slot_minutes: 60, price_cents: 7500 });
await schedule.enroll(ctx, speed.id, lopez.id);
const next = schedule.listSessions(ctx, { from: ctx.now(), to: new Date(Date.now() + 14 * 86400000).toISOString(), kind: 'group' }).find((x) => x.series_id === speed.id);
if (next) { await schedule.book(ctx, { sessionId: next.id, clientId: cole.id, isCoach: true }); await schedule.book(ctx, { sessionId: next.id, clientId: nguyen.id, isCoach: true, overrideAge: true }); }

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

console.log(`Seeded. Sign in at http://localhost:${process.env.PORT || 3000} with ${email} / ${password}`);
console.log(`Parent portal: http://localhost:${process.env.PORT || 3000}/parent (sign in as maria.lopez@example.com; in test mode the code is shown on screen)`);
console.log(`Client app example (Maya): http://localhost:${process.env.PORT || 3000}${clients.getClient(ctx, made['Maya Okafor'].id, { withSecrets: true }).app_link}`);
ctx.db.close();
