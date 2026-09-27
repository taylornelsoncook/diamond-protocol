// Demo data for programs and integrations: exercise categories, a throwers' arm-care program, finished workouts over the
// last week, one API key, one paused webhook.
'use strict';
const crypto = require('crypto');
const { get, all, run, insert, tx } = require('../db');
require('../routes/40-programs'); // adds exercises.category on older databases
const { sha256 } = require('../lib');

const CATEGORY = {
  'A-skip': 'Speed', 'Wall drive march': 'Speed', 'Sled push': 'Speed', 'Box jump': 'Power', 'Broad jump': 'Power', 'Med ball rotational throw': 'Power',
  'Kettlebell swing': 'Power', 'Goblet squat': 'Lower body', 'Romanian deadlift': 'Lower body', 'Walking lunge': 'Lower body', 'Split squat': 'Lower body',
  'Trap bar deadlift': 'Lower body', 'Nordic hamstring curl': 'Lower body', 'Push-up': 'Upper body', 'One-arm dumbbell row': 'Upper body',
  'Half-kneeling press': 'Upper body', 'Front plank': 'Core', 'Copenhagen plank': 'Core',
};
const ARM_CARE = [
  ['Band external rotation', 'Elbow pinned to your side, rotate out slowly, two-second return.'],
  ['Prone Y-T-W raise', 'Thumbs up, squeeze shoulder blades down and back.'],
  ['Sleeper stretch', 'Gentle pressure only. Stop before pain.'],
  ['Scap push-up', 'Arms stay straight; spread and pinch the shoulder blades.'],
  ['Wrist flexion and extension', 'Light weight, full range, slow.'],
];

function seed() {
  tx(() => {
    for (const [name, category] of Object.entries(CATEGORY)) run('UPDATE exercises SET category=? WHERE name=?', category, name);
    const ex = {};
    for (const [name, cues] of ARM_CARE) ex[name] = insert('exercises', { name, cues, video_url: '', category: 'Arm care' });
    const exId = (name) => ex[name] || get('SELECT id FROM exercises WHERE name=?', name).id;
    // A program nobody is on yet, ready to assign to pitchers and position players.
    const arm = insert('programs', { name: 'Throwers Arm Care', weeks: 4, level: 'Ages 15–18', description: 'Two short days a week to keep shoulders and elbows healthy through the season.' });
    const armDays = [
      { title: 'Shoulder care', items: [['Band external rotation', 3, '15'], ['Prone Y-T-W raise', 2, '8 each'], ['Scap push-up', 2, '12'], ['Sleeper stretch', 2, '30 sec each side']] },
      { title: 'Forearm and trunk', items: [['Wrist flexion and extension', 2, '15 each'], ['Med ball rotational throw', 3, '5 each side'], ['Copenhagen plank', 2, '20 sec each side']] },
    ];
    for (let w = 1; w <= 4; w++) armDays.forEach((d, i) => {
      const did = insert('program_days', { program_id: arm, week: w, day: i + 1, title: d.title });
      d.items.forEach(([e, sets, reps], ord) => insert('program_items', { day_id: did, exercise_id: exId(e), sets: String(sets), reps, ord }));
    });

    const athletes = all('SELECT id, first_name, last_name, program_id FROM athletes WHERE program_id IS NOT NULL ORDER BY id');
    const notes = ['Felt strong today.', 'Left knee a little sore on the lunges.', 'Went up a weight on the goblet squats.', '', ''];
    // UTC timestamp n days ago at a given hour, in SQLite's format.
    const ago = (days, hour) => { const d = new Date(Date.now() - days * 864e5); d.setUTCHours(hour, 10 + days * 3, 0, 0); return d.toISOString().slice(0, 19).replace('T', ' '); };
    athletes.forEach((a, idx) => {
      const days = all('SELECT id, week, day, title FROM program_days WHERE program_id=? ORDER BY week, day', a.program_id);
      const finishedCount = [3, 2, 4, 1, 3, 2, 0, 2, 1][idx % 9];
      const gaps = [6, 4, 2, 1];
      for (let n = 0; n < finishedCount && n < days.length; n++) {
        const d = days[n];
        const items = all('SELECT id FROM program_items WHERE day_id=? ORDER BY ord', d.id).map((r) => r.id);
        const done = n === 1 && idx % 3 === 0 ? items.slice(0, -1) : items; // sometimes one exercise skipped
        const when = ago(gaps[(n + 4 - finishedCount) % 4] + (idx % 2), 23);
        const note = n === finishedCount - 1 ? notes[idx % notes.length] : '';
        insert('workout_logs', { athlete_id: a.id, day_id: d.id, done: JSON.stringify(done), note: note || null, finished_at: when, created_at: when });
        const name = `${a.first_name} ${a.last_name}`;
        insert('activity', { actor: `${name} (athlete)`, action: `Workout logged: ${name}, ${d.title}`, detail: `week ${d.week}, day ${d.day} · ${done.length} of ${items.length} exercises`, kind: 'change', created_at: when });
      }
      // One athlete part-way through today's workout.
      if (idx === 1 && days[finishedCount]) {
        const first = get('SELECT id FROM program_items WHERE day_id=? ORDER BY ord LIMIT 1', days[finishedCount].id);
        if (first) insert('workout_logs', { athlete_id: a.id, day_id: days[finishedCount].id, done: JSON.stringify([first.id]) });
      }
    });

    // An API key for the website's booking form. The key itself is never shown again, so it isn't printed.
    const key = 'dp_live_' + crypto.randomBytes(24).toString('base64url');
    insert('api_keys', { label: 'Website booking', key_hash: sha256(key), last4: key.slice(-4), last_used: ago(1, 18) });

    // A paused webhook with a few past deliveries.
    const hook = insert('webhooks', {
      url: 'https://example.com/hooks/dp', active: 0, secret: 'whsec_' + crypto.randomBytes(24).toString('hex'),
      events: JSON.stringify(['client.created', 'booking.created', 'booking.cancelled', 'payment.succeeded', 'workout.completed']),
    });
    [['booking.created', 200, 3], ['workout.completed', 200, 2], ['payment.succeeded', 500, 2], ['booking.cancelled', 200, 1]].forEach(([event, status, d]) => {
      const created_at = ago(d, 17);
      insert('webhook_deliveries', { webhook_id: hook, event, status, created_at, payload: JSON.stringify({ event, created_at: created_at.replace(' ', 'T') + 'Z', data: { demo: true } }) });
    });
  });
}

module.exports = { seed };
