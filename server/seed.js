// Base data every install needs (test library, presets, settings) plus optional demo data.
// `npm run demo` resets the database and loads the demo. Area-specific demo data lives in server/seeds/*.js.
'use strict';
const fs = require('fs');
const path = require('path');
const { db, get, all, run, insert, tx, setSetting, setting } = require('./db');
const { makeAthleteCode, randomToken, today, addDays, addMonths, localDate } = require('./lib');
const { hashPassword } = require('./auth');

// name, category, unit, lower_better, attempts, min, max, timed
const TESTS = [
  ['10-yard sprint', 'Speed', 's', 1, 2, 1.2, 3.5, 1], ['20-yard sprint', 'Speed', 's', 1, 2, 2.2, 5.5, 1], ['30-yard sprint', 'Speed', 's', 1, 2, 3.2, 7, 1],
  ['40-yard dash', 'Speed', 's', 1, 2, 4.0, 9, 1], ['60-yard dash', 'Speed', 's', 1, 2, 6.0, 12, 1], ['10m sprint', 'Speed', 's', 1, 2, 1.4, 3.5, 1],
  ['20m sprint', 'Speed', 's', 1, 2, 2.6, 5.5, 1], ['30m sprint', 'Speed', 's', 1, 2, 3.6, 7.5, 1], ['Flying 10-yard', 'Speed', 's', 1, 2, 0.8, 2.5, 1],
  ['Pro agility (5-10-5)', 'Agility', 's', 1, 2, 3.8, 8, 1], ['3-cone drill', 'Agility', 's', 1, 2, 6.2, 12, 1], ['T-test', 'Agility', 's', 1, 2, 8, 16, 1],
  ['Illinois agility', 'Agility', 's', 1, 2, 13, 25, 1], ['505 agility', 'Agility', 's', 1, 2, 2, 4, 1], ['Reactive agility', 'Agility', 's', 1, 2, 1.5, 5, 1],
  ['Vertical jump', 'Power', 'in', 0, 3, 4, 48, 0], ['Approach vertical', 'Power', 'in', 0, 3, 6, 50, 0], ['Standing broad jump', 'Power', 'in', 0, 3, 24, 140, 0],
  ['Triple broad jump', 'Power', 'in', 0, 2, 90, 400, 0], ['Seated chest pass', 'Power', 'ft', 0, 2, 5, 45, 0], ['Rotational med ball throw', 'Power', 'ft', 0, 2, 8, 70, 0],
  ['Overhead backward throw', 'Power', 'ft', 0, 2, 8, 70, 0], ['Single-leg broad jump (left)', 'Power', 'in', 0, 2, 12, 110, 0], ['Single-leg broad jump (right)', 'Power', 'in', 0, 2, 12, 110, 0],
  ['Back squat 1RM', 'Strength', 'lb', 0, 1, 20, 800, 0], ['Bench press 1RM', 'Strength', 'lb', 0, 1, 20, 600, 0], ['Trap bar deadlift 1RM', 'Strength', 'lb', 0, 1, 40, 900, 0],
  ['Front squat 1RM', 'Strength', 'lb', 0, 1, 20, 700, 0], ['Power clean 1RM', 'Strength', 'lb', 0, 1, 20, 450, 0], ['Pull-ups', 'Strength', 'reps', 0, 1, 0, 60, 0],
  ['Push-ups', 'Strength', 'reps', 0, 1, 0, 120, 0], ['Bench press reps at 185', 'Strength', 'reps', 0, 1, 0, 60, 0], ['Grip strength (left)', 'Strength', 'kg', 0, 2, 5, 90, 0],
  ['Grip strength (right)', 'Strength', 'kg', 0, 2, 5, 90, 0], ['Plank hold', 'Strength', 's', 0, 1, 5, 900, 1],
  ['1-mile run', 'Endurance', 's', 1, 1, 240, 1200, 1], ['1.5-mile run', 'Endurance', 's', 1, 1, 400, 1800, 1], ['300-yard shuttle', 'Endurance', 's', 1, 1, 50, 110, 1],
  ['Beep test', 'Endurance', 'level', 0, 1, 1, 21, 0], ['Yo-Yo IR1', 'Endurance', 'm', 0, 1, 40, 3600, 0], ['2 km row', 'Endurance', 's', 1, 1, 330, 900, 1],
  ['Sit and reach', 'Mobility', 'in', 0, 2, -10, 25, 0], ['Ankle dorsiflexion (left)', 'Mobility', 'cm', 0, 2, 0, 25, 0], ['Ankle dorsiflexion (right)', 'Mobility', 'cm', 0, 2, 0, 25, 0],
  ['Hip internal rotation (left)', 'Mobility', 'deg', 0, 1, 0, 70, 0], ['Hip internal rotation (right)', 'Mobility', 'deg', 0, 1, 0, 70, 0],
  ['Shoulder external rotation (left)', 'Mobility', 'deg', 0, 1, 40, 160, 0], ['Shoulder external rotation (right)', 'Mobility', 'deg', 0, 1, 40, 160, 0],
  ['Height', 'Body', 'in', 0, 1, 36, 90, 0], ['Seated height', 'Body', 'in', 0, 1, 18, 50, 0], ['Weight', 'Body', 'lb', 0, 1, 40, 400, 0],
  ['Wingspan', 'Body', 'in', 0, 1, 36, 96, 0], ['Standing reach', 'Body', 'in', 0, 1, 48, 120, 0], ['Body fat', 'Body', '%', 1, 1, 3, 50, 0],
  ['CMJ jump height', 'Force plate', 'cm', 0, 3, 5, 110, 0], ['CMJ peak power', 'Force plate', 'W', 0, 3, 300, 9000, 0], ['CMJ relative power', 'Force plate', 'W/kg', 0, 3, 10, 90, 0],
  ['RSI-modified', 'Force plate', 'ratio', 0, 3, 0.1, 1.5, 0], ['Squat jump height', 'Force plate', 'cm', 0, 3, 5, 100, 0], ['Drop jump RSI', 'Force plate', 'ratio', 0, 3, 0.3, 4.5, 0],
  ['IMTP peak force', 'Force plate', 'N', 0, 2, 500, 7000, 0], ['Landing asymmetry', 'Force plate', '%', 1, 3, 0, 60, 0],
  ['Exit velocity', 'Baseball', 'mph', 0, 5, 30, 125, 0], ['Bat speed', 'Baseball', 'mph', 0, 5, 30, 95, 0], ['Pitch velocity', 'Baseball', 'mph', 0, 5, 30, 105, 0],
  ['Infield velocity', 'Baseball', 'mph', 0, 3, 30, 100, 0], ['Outfield velocity', 'Baseball', 'mph', 0, 3, 30, 105, 0], ['Pop time', 'Baseball', 's', 1, 3, 1.6, 3.5, 1],
  ['Home to first', 'Baseball', 's', 1, 2, 3.5, 6.5, 1],
  ['Lane agility', 'Basketball', 's', 1, 2, 9.5, 16, 1], ['3/4 court sprint', 'Basketball', 's', 1, 2, 2.9, 5, 1], ['Shuttle run', 'Basketball', 's', 1, 2, 2.5, 5, 1],
  ['On-ice 30m sprint', 'Hockey', 's', 1, 2, 3.8, 7, 1], ['Weave agility', 'Hockey', 's', 1, 2, 11, 20, 1], ['Transition agility', 'Hockey', 's', 1, 2, 5, 10, 1],
  ['Arrowhead agility', 'Soccer', 's', 1, 2, 7.5, 12, 1], ['30-15 IFT', 'Soccer', 'km/h', 0, 1, 12, 24, 0], ['Repeated sprint average', 'Soccer', 's', 1, 1, 3.5, 7, 0],
];

const PRESETS = {
  Combine: ['40-yard dash', 'Pro agility (5-10-5)', 'Vertical jump', 'Standing broad jump', 'Bench press reps at 185', 'Height', 'Weight', 'Wingspan'],
  'Force plate': ['CMJ jump height', 'CMJ peak power', 'CMJ relative power', 'RSI-modified', 'Squat jump height', 'Drop jump RSI', 'IMTP peak force'],
  Baseball: ['60-yard dash', 'Home to first', 'Exit velocity', 'Bat speed', 'Pitch velocity', 'Infield velocity', 'Outfield velocity', 'Pop time'],
  Basketball: ['Lane agility', '3/4 court sprint', 'Approach vertical', 'Vertical jump', 'Standing reach', 'Wingspan', 'Height', 'Weight'],
  Hockey: ['On-ice 30m sprint', 'Weave agility', 'Transition agility', 'Vertical jump', 'Standing broad jump', 'Pull-ups'],
  Soccer: ['10m sprint', '30m sprint', 'Arrowhead agility', 'Yo-Yo IR1', '30-15 IFT', 'Vertical jump'],
  Youth: ['20-yard sprint', 'Pro agility (5-10-5)', 'Standing broad jump', 'Vertical jump', 'Seated chest pass', 'Height', 'Seated height', 'Weight'],
};

const WAIVER = `ASSUMPTION OF RISK, RELEASE AND CONSENT (sample text: replace with your lawyer's waiver in Hours & settings)

I understand that strength, speed and conditioning training involves physical exertion and a risk of injury. I confirm the athlete is fit to take part and that I have shared any medical conditions with the coaching staff. I consent to emergency medical treatment if I cannot be reached. I release the business and its staff from claims arising from ordinary participation, except those caused by gross negligence.`;

// Runs on every start: settings and the test library, never touching existing rows.
function base() {
  const defaults = {
    business_name: 'Diamond Protocol', timezone: 'America/Denver', late_cancel_hours: 12,
    results_visibility: 'shared', business_address: '', pay_instructions: 'Make checks payable to Diamond Protocol.',
    waiver_text: WAIVER, waiver_version: 1, presets: PRESETS, currency: 'usd',
  };
  for (const [k, v] of Object.entries(defaults)) if (setting(k) === null) setSetting(k, v);
  for (const t of TESTS) {
    if (!get('SELECT 1 FROM tests WHERE name=?', t[0])) {
      insert('tests', { name: t[0], category: t[1], unit: t[2], lower_better: t[3], attempts: t[4], min_value: t[5], max_value: t[6], timed: t[7] });
    }
  }
}

function resetDatabase() {
  const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) db.exec(`DELETE FROM ${t}`);
  db.exec('PRAGMA foreign_keys = ON');
}

const DEMO_LOGINS = [
  ['Jordan Avery', 'owner@demo.test', 'owner', 'demo-owner-2026'],
  ['Chris Maddox', 'coach@demo.test', 'coach', 'demo-coach-2026'],
  ['Riley Tran', 'desk@demo.test', 'frontdesk', 'demo-desk-2026'],
];

function demo() {
  const T = today();
  tx(() => {
    setSetting('business_address', '1450 N Industrial Pkwy, Provo, UT 84604');
    setSetting('pay_instructions', 'Make checks payable to Diamond Protocol and mail to the address above, or pay online.');

    const staff = DEMO_LOGINS.map(([name, email, role, pw]) => insert('staff', { name, email, role, pw_hash: hashPassword(pw), must_change: 0 }));
    const [ownerId, coachId] = staff;

    const loc = {
      facility: insert('locations', { name: 'Provo facility', kind: 'facility', address: '1450 N Industrial Pkwy, Provo, UT 84604' }),
      mobile: insert('locations', { name: 'Mobile training', kind: 'mobile', address: 'Utah County' }),
      park: insert('locations', { name: 'Riverside Park', kind: 'park', address: '2200 N 1050 W, Provo, UT' }),
    };
    insert('readers', { label: 'Front desk reader', location_id: loc.facility, serial: 'WSC-TEST-0001' });

    const plan = {
      unlimited: insert('plans', { name: 'Unlimited group training', price_cents: 18900, trial_days: 7, group_per_month: null, private_per_month: 0 }),
      eight: insert('plans', { name: '8 sessions a month', price_cents: 13900, trial_days: 7, group_per_month: 8, private_per_month: 0 }),
      elite: insert('plans', { name: 'Elite: unlimited + 2 privates', price_cents: 32900, trial_days: 0, group_per_month: null, private_per_month: 2 }),
    };
    [['Drop-in group session', 'session', 3000, 1], ['10-session group pack', 'group_pack', 25000, 10], ['5 private sessions', 'private_pack', 42500, 5],
      ['Private session', 'private_pack', 9500, 1], ['DP training shirt', 'gear', 2800, 0], ['Speed parachute', 'gear', 3500, 0], ['Water bottle', 'gear', 1500, 0]]
      .forEach(([name, kind, price_cents, credits]) => insert('products', { name, kind, price_cents, credits }));

    // Exercises and programs
    const ex = {};
    [['Goblet squat', 'Elbows inside knees. Sit between your heels.'], ['Romanian deadlift', 'Soft knees, push hips back, flat back.'], ['Walking lunge', 'Long step, back knee kisses the floor.'],
      ['Front plank', 'Squeeze glutes, ribs down.'], ['Push-up', 'Body in one line, chest to the floor.'], ['One-arm dumbbell row', 'Pull to the hip, no twist.'],
      ['Half-kneeling press', 'Squeeze the down-side glute.'], ['Kettlebell swing', 'Snap the hips; arms are ropes.'], ['A-skip', 'Tall posture, drive the knee, strike under the hip.'],
      ['Wall drive march', 'Lean 45 degrees, hold a straight line.'], ['Box jump', 'Land soft and quiet, step down.'], ['Broad jump', 'Big arm swing, stick the landing.'],
      ['Med ball rotational throw', 'Load the back hip, throw through the wall.'], ['Nordic hamstring curl', 'Fall slowly; control the whole way.'], ['Copenhagen plank', 'Hips high, straight line.'],
      ['Trap bar deadlift', 'Push the floor away, chest tall.'], ['Split squat', 'Front shin vertical, drop straight down.'], ['Sled push', 'Low angle, drive through the ball of the foot.']]
      .forEach(([name, cues]) => { ex[name] = insert('exercises', { name, cues, video_url: '' }); });
    function program(name, weeks, level, description, days) {
      const pid = insert('programs', { name, weeks, level, description });
      for (let w = 1; w <= weeks; w++) days.forEach((d, i) => {
        const did = insert('program_days', { program_id: pid, week: w, day: i + 1, title: d.title });
        d.items.forEach(([e, sets, reps], ord) => insert('program_items', { day_id: did, exercise_id: ex[e], sets: String(sets), reps: String(reps), ord }));
      });
      return pid;
    }
    const progs = {
      speed: program('Youth Speed Foundations', 6, 'Ages 10–14', 'Sprint mechanics, jumping and landing, and basic strength.', [
        { title: 'Acceleration', items: [['A-skip', 3, '20 yd'], ['Wall drive march', 3, '20 sec'], ['Broad jump', 4, 3], ['Front plank', 3, '30 sec']] },
        { title: 'Strength', items: [['Goblet squat', 3, 10], ['Push-up', 3, 8], ['Split squat', 3, '8 each side'], ['Copenhagen plank', 2, '20 sec each side']] },
      ]),
      hs: program('High School Off-Season', 8, 'Ages 15–18', 'Four-day power and strength block for high school athletes.', [
        { title: 'Lower power', items: [['Box jump', 4, 3], ['Trap bar deadlift', 4, 5], ['Split squat', 3, '8 each side'], ['Nordic hamstring curl', 3, 5]] },
        { title: 'Upper strength', items: [['Push-up', 4, 12], ['One-arm dumbbell row', 4, '10 each side'], ['Half-kneeling press', 3, '8 each side'], ['Front plank', 3, '45 sec']] },
        { title: 'Speed & rotation', items: [['A-skip', 3, '20 yd'], ['Sled push', 5, '20 yd'], ['Med ball rotational throw', 4, '5 each side'], ['Kettlebell swing', 3, 15]] },
      ]),
      adult: program('Foundations of Strength', 8, 'Beginner', 'Three full-body days to build a base.', [
        { title: 'Lower body', items: [['Goblet squat', 3, 10], ['Romanian deadlift', 3, 8], ['Walking lunge', 3, '12 each side'], ['Front plank', 3, '40 sec']] },
        { title: 'Upper body', items: [['Push-up', 4, 8], ['One-arm dumbbell row', 3, '10 each side'], ['Half-kneeling press', 3, '8 each side']] },
        { title: 'Conditioning', items: [['Kettlebell swing', 5, 15], ['Sled push', 6, '20 yd']] },
      ]),
    };

    // Schools and team contracts
    const riverside = insert('schools', { name: 'Riverside High School', contact_name: 'Dana Whitaker', contact_email: 'athletics@riverside.example.org', address: '600 W Center St, Provo, UT 84601' });
    const summit = insert('schools', { name: 'Summit Elite Baseball Club', contact_name: 'Marcus Hale', contact_email: 'treasurer@summitelite.example.org', address: 'PO Box 1182, Orem, UT 84059' });
    const team1 = insert('team_contracts', { school_id: riverside, team_name: 'Riverside Varsity Football', monthly_cents: 240000, start_date: addMonths(T, -3), terms_days: 30, po_number: 'PO-44821', billing_name: 'Dana Whitaker', billing_email: 'athletics@riverside.example.org', billing_day: Number(addMonths(T, -3).slice(8)) });
    const team2 = insert('team_contracts', { school_id: summit, team_name: 'Summit Elite 16U', monthly_cents: 95000, start_date: addMonths(T, -2), terms_days: 15, billing_name: 'Marcus Hale', billing_email: 'treasurer@summitelite.example.org', billing_day: Number(addMonths(T, -2).slice(8)) });

    // Families, parents, athletes
    const fam = [
      ['Lopez', 'Maria Lopez', 'maria.lopez@example.com', '801-555-0142', [['Ava', 'Lopez', '2012-04-18', 'F', 'Soccer', 'Midfield', 'Dixon Middle', 'Peanuts', '']], '4242', 'unlimited'],
      ['Okafor', 'Ngozi Okafor', 'ngozi.okafor@example.com', '801-555-0177', [['Chidi', 'Okafor', '2009-09-02', 'M', 'Football', 'Wide receiver', 'Riverside High', '', 'Left ankle sprain (Aug), cleared']], '4242', 'elite'],
      ['Jensen', 'Kurt Jensen', 'kurt.jensen@example.com', '385-555-0110', [['Emma', 'Jensen', '2011-01-27', 'F', 'Volleyball', 'Outside hitter', 'Centennial Middle', '', ''], ['Nate', 'Jensen', '2013-06-09', 'M', 'Baseball', 'Shortstop', 'Wasatch Elementary', 'Bee stings (carries EpiPen)', '']], '4242', 'eight'],
      ['Nguyen', 'Linh Nguyen', 'linh.nguyen@example.com', '801-555-0133', [['Kevin', 'Nguyen', '2008-11-14', 'M', 'Basketball', 'Guard', 'Riverside High', '', '']], '0002', 'unlimited'],
      ['Harper', 'Beth Harper', 'beth.harper@example.com', '801-555-0198', [['Mason', 'Harper', '2010-03-30', 'M', 'Hockey', 'Defense', 'Riverside High', '', '']], '4242', 'eight'],
      ['Silva', 'Paulo Silva', 'paulo.silva@example.com', '385-555-0161', [['Isabela', 'Silva', '2012-08-21', 'F', 'Soccer', 'Forward', 'Dixon Middle', '', '']], null, null],
      ['Brooks', 'Tanya Brooks', 'tanya.brooks@example.com', '801-555-0120', [['Jaylen', 'Brooks', '2009-05-05', 'M', 'Football', 'Running back', 'Riverside High', '', 'Hamstring tightness']], '4242', 'elite'],
      ['Park', 'Grace Park', 'grace.park@example.com', '385-555-0147', [['Olivia', 'Park', '2011-10-12', 'F', 'Basketball', 'Forward', 'Centennial Middle', 'Asthma (inhaler in bag)', '']], '4242', 'unlimited'],
    ];
    const athletes = [];
    fam.forEach(([fname, pname, email, phone, kids, last4, planKey], fi) => {
      const fid = insert('families', { name: `${fname} family`, card_brand: last4 ? 'Visa' : null, card_last4: last4, card_exp: last4 ? '08/29' : null,
        waiver_version: fi === 5 ? null : 1, waiver_signed_at: fi === 5 ? null : addDays(T, -60), waiver_signed_by: fi === 5 ? null : pname });
      insert('parents', { family_id: fid, name: pname, email, phone });
      kids.forEach(([first, last, bday, sex, sport, position, school, allergies, injuries]) => {
        const aid = insert('athletes', {
          code: makeAthleteCode(first, last), family_id: fid, first_name: first, last_name: last, birthday: bday, sex, sport, position, school,
          allergies, injuries, emergency_name: pname, emergency_phone: phone, group_credits: planKey ? 0 : 3, private_credits: planKey === 'elite' ? 2 : 0,
          program_id: sport === 'Football' || school === 'Riverside High' ? progs.hs : progs.speed, program_started: addDays(T, -12), workout_token: randomToken(12),
          team_id: sport === 'Football' && school === 'Riverside High' ? team1 : null,
        });
        athletes.push({ id: aid, fid, first, last, planKey, sport });
        if (planKey) {
          const status = last4 === '0002' ? 'past_due' : fi === 4 ? 'paused' : 'active';
          insert('memberships', { athlete_id: aid, plan_id: plan[planKey], status, started_at: addMonths(T, -(fi % 4) - 1), next_charge: addDays(T, (fi * 3) % 27 + 1), price_cents: get('SELECT price_cents FROM plans WHERE id=?', plan[planKey]).price_cents });
        }
      });
    });
    // An adult client paying for themselves
    const adultFam = insert('families', { name: 'Reyes', card_brand: 'Mastercard', card_last4: '4444', card_exp: '02/28', waiver_version: 1, waiver_signed_at: addDays(T, -20), waiver_signed_by: 'Daniel Reyes' });
    insert('parents', { family_id: adultFam, name: 'Daniel Reyes', email: 'daniel.reyes@example.com', phone: '801-555-0105', is_self: 1 });
    const adult = insert('athletes', { code: makeAthleteCode('Daniel', 'Reyes'), family_id: adultFam, first_name: 'Daniel', last_name: 'Reyes', email: 'daniel.reyes@example.com', birthday: '1991-02-14', sex: 'M', sport: 'General fitness', program_id: progs.adult, program_started: addDays(T, -20), workout_token: randomToken(12), emergency_name: 'Ana Reyes', emergency_phone: '801-555-0106' });
    insert('memberships', { athlete_id: adult, plan_id: plan.eight, status: 'trial', started_at: addDays(T, -3), next_charge: addDays(T, 4), price_cents: 13900 });

    // Team-only roster players (no family account)
    ['Tyler Jacobs', 'Marcus Bell', 'Diego Ramirez', 'Sione Tupou', 'Caleb Ward', 'Ethan Moss'].forEach((n) => {
      const [first, last] = n.split(' ');
      insert('athletes', { code: makeAthleteCode(first, last), first_name: first, last_name: last, sport: 'Football', school: 'Riverside High', team_id: team1, workout_token: randomToken(12) });
    });
    ['Brady Cole', 'Luis Ortega', 'Hunter Price', 'Kai Mahoe'].forEach((n) => {
      const [first, last] = n.split(' ');
      insert('athletes', { code: makeAthleteCode(first, last), first_name: first, last_name: last, sport: 'Baseball', team_id: team2, workout_token: randomToken(12) });
    });

    // Weekly classes (sessions are generated by the schedule job) and bookable hours
    const cls = (o) => insert('classes', { coach_id: coachId, location_id: loc.facility, start_date: addDays(T, -14), ...o });
    cls({ name: 'Youth Speed & Agility', type: 'class', weekdays: '1,3', start_time: '16:30', duration_min: 60, capacity: 14, min_age: 9, max_age: 13, price_cents: 3000 });
    cls({ name: 'High School Performance', type: 'class', weekdays: '1,2,4', start_time: '18:00', duration_min: 75, capacity: 16, min_age: 14, max_age: 19, price_cents: 3500 });
    cls({ name: 'Saturday Strength', type: 'class', weekdays: '6', start_time: '09:00', duration_min: 60, capacity: 12, min_age: 12, price_cents: 3000 });
    cls({ name: 'Park Sprint Club', type: 'class', weekdays: '5', start_time: '07:00', duration_min: 45, capacity: 10, min_age: 12, price_cents: 2500, location_id: loc.park });
    cls({ name: 'Fall Speed Camp', type: 'camp', weekdays: '1,2,3,4', start_time: '10:00', duration_min: 90, capacity: 20, min_age: 10, max_age: 16, price_cents: 0, reg_price_cents: 19900, reg_deadline: addDays(T, 9), start_date: addDays(T, 14), end_date: addDays(T, 17) });
    cls({ name: 'Riverside Football team session', type: 'team', weekdays: '2,4', start_time: '15:30', duration_min: 60, capacity: 60, team_id: team1 });
    for (const wd of [1, 2, 3, 4, 5]) insert('availability', { kind: 'private', weekday: wd, start_time: '12:00', end_time: '15:00', slot_min: 60, location_id: loc.facility, coach_id: coachId });
    for (const wd of [2, 4]) insert('availability', { kind: 'evaluation', weekday: wd, start_time: '11:00', end_time: '12:00', slot_min: 30, location_id: loc.facility, price_cents: 7500, coach_id: coachId });

    insert('activity', { actor: 'System', action: 'Demo data loaded', detail: `${athletes.length} family athletes, 2 team contracts`, kind: 'change' });
    void ownerId;
  });

  // Area-specific demo data (results, invoices, sales, bookings…)
  const dir = path.join(__dirname, 'seeds');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    try { require(path.join(dir, f)).seed(); } catch (e) { console.error(`[seed] ${f} failed:`, e.message); }
  }
}

function seed({ withDemo = true } = {}) {
  base();
  if (withDemo && !get('SELECT 1 FROM staff LIMIT 1')) demo();
}

if (require.main === module) {
  if (process.argv.includes('--reset')) resetDatabase();
  base();
  if (process.argv.includes('--demo')) { if (get('SELECT 1 FROM staff LIMIT 1')) { console.log('Database already has data. Use --reset --demo.'); } else { demo(); } }
  console.log('Seeded. Demo sign-ins:');
  for (const [, email, role, pw] of DEMO_LOGINS) console.log(`  ${role.padEnd(9)} ${email}  ${pw}`);
}

module.exports = { seed, base, demo, resetDatabase, TESTS, PRESETS, DEMO_LOGINS };
