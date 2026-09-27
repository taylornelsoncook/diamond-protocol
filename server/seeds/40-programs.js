// Demo data for programs and integrations: exercise categories, a throwers' arm-care program, finished workouts over the
// last week, API keys with a request log, one paused webhook.
'use strict';
const crypto = require('crypto');
const { get, all, run, insert, tx } = require('../db');
require('../routes/40-programs'); // adds exercises.category on older databases
const { sha256, localDate, addDays } = require('../lib');
require('../services/ops-webhooks'); // webhook label and delivery details on older databases
require('../services/ops-api'); // API key access levels and the request log

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

    // API keys: the website's booking form (reads sessions), a read-only analytics sheet, and an old key that was revoked.
    // The keys themselves are never shown again, so they aren't printed.
    const newKey = () => { const k = 'dp_live_' + crypto.randomBytes(24).toString('base64url'); return { key_hash: sha256(k), last4: k.slice(-4) }; };
    const site = insert('api_keys', { label: 'Website booking', ...newKey(), scope: 'full', created_at: ago(41, 16), last_used: ago(0, 15) });
    const sheet = insert('api_keys', { label: 'Team analytics sheet', ...newKey(), scope: 'read', created_at: ago(12, 20), last_used: ago(1, 13) });
    insert('api_keys', { label: 'Old website plugin', ...newKey(), scope: 'full', created_at: ago(90, 16), last_used: ago(45, 10), revoked_at: ago(41, 16) });
    const T0 = localDate(new Date());
    for (let d = 6; d >= 0; d--) {
      for (let i = 0; i < 4; i++) insert('api_requests', { key_id: site, method: 'GET', path: `/api/v1/events?from=${addDays(T0, -d)}`, status: 200, duration_ms: 9 + i * 3, ip: '34.102.18.7', created_at: ago(d, 14 + i) });
    }
    insert('api_requests', { key_id: site, method: 'GET', path: `/api/v1/events?from=${T0}&to=${addDays(T0, 180)}`, status: 400, duration_ms: 3, ip: '34.102.18.7', error: 'Ask for 92 days or fewer at a time.', created_at: ago(2, 19) });
    for (const [d, path] of [[5, '/api/v1/athletes?limit=500'], [5, '/api/v1/tests'], [1, '/api/v1/athletes?limit=500']]) insert('api_requests', { key_id: sheet, method: 'GET', path, status: 200, duration_ms: 21, ip: '142.250.72.14', created_at: ago(d, 13) });
    insert('api_requests', { key_id: sheet, method: 'POST', path: '/api/v1/results', status: 403, duration_ms: 2, ip: '142.250.72.14', error: 'This API key is read-only. Create a key with "Read and send results" to send data.', created_at: ago(1, 13) });

    // A paused webhook with a few past deliveries, one of which kept failing.
    const hook = insert('webhooks', {
      url: 'https://example.com/hooks/dp', label: 'Mailing list sync', active: 0, secret: 'whsec_' + crypto.randomBytes(24).toString('hex'), created_at: ago(20, 17),
      events: JSON.stringify(['client.created', 'booking.created', 'booking.cancelled', 'payment.succeeded', 'workout.completed']),
    });
    [['booking.created', 200, 3, 1, '{"ok":true}'], ['workout.completed', 200, 2, 1, '{"ok":true}'], ['payment.succeeded', 500, 2, 4, '{"error":"Mailing list service unavailable"}'], ['booking.cancelled', 200, 1, 1, '{"ok":true}']].forEach(([event, status, d, attempts, response]) => {
      const created_at = ago(d, 17);
      insert('webhook_deliveries', { webhook_id: hook, event, status, created_at, attempts, last_attempt_at: created_at, duration_ms: 180 + d * 40, response,
        payload: JSON.stringify({ event, created_at: created_at.replace(' ', 'T') + 'Z', data: { demo: true } }) });
    });

    // One exercise still carries a link from before links were checked; the video tab flags it.
    run("UPDATE exercises SET video_url='https://example.com/videos/sled-push' WHERE name='Sled push'");
  });
}

module.exports = { seed };
