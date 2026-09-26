// Demo data for programs and integrations: finished workouts over the last week, one API key, one paused webhook.
'use strict';
const crypto = require('crypto');
const { get, all, insert, tx } = require('../db');
const { sha256 } = require('../lib');

function seed() {
  tx(() => {
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
