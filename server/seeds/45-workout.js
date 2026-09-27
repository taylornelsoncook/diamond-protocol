// Demo data for the athlete workout app: the sets behind each finished workout (so "Last time" and new bests
// show), how hard each one felt, and how long it took.
'use strict';
const { all, run, insert, tx } = require('../db');
const { parseDone, targetSets, targetReps } = require('../services/ops-workout');

// Starting weights in lb for loaded exercises; each later workout goes up a little.
const START = {
  'Goblet squat': 25, 'Romanian deadlift': 45, 'Walking lunge': 15, 'One-arm dumbbell row': 30, 'Half-kneeling press': 20,
  'Kettlebell swing': 35, 'Trap bar deadlift': 135, 'Split squat': 20, 'Sled push': 90, 'Med ball rotational throw': 8,
};

function seed() {
  tx(() => {
    const logs = all(`SELECT l.id, l.athlete_id, l.day_id, l.done, l.finished_at FROM workout_logs l
      WHERE l.finished_at IS NOT NULL ORDER BY l.athlete_id, l.finished_at`);
    const seen = {}; // athlete:exercise → times done so far
    logs.forEach((l, n) => {
      const done = new Set(parseDone(l.done));
      const items = all(`SELECT i.id, i.sets, i.reps, i.exercise_id, e.name FROM program_items i JOIN exercises e ON e.id=i.exercise_id
        WHERE i.day_id=? ORDER BY i.ord, i.id`, l.day_id);
      for (const i of items) {
        if (!done.has(i.id)) continue;
        const k = `${l.athlete_id}:${i.exercise_id}`;
        const times = (seen[k] = (seen[k] || 0) + 1) - 1;
        const base = START[i.name];
        const reps = targetReps(i.reps);
        for (let s = 1; s <= targetSets(i.sets); s++) {
          const weight = base ? base + times * (base >= 90 ? 10 : 5) : null;
          insert('workout_sets', { log_id: l.id, item_id: i.id, exercise_id: i.exercise_id, set_no: s, weight,
            reps: reps == null ? null : (s === targetSets(i.sets) && n % 4 === 0 ? Math.max(1, reps - 2) : reps), created_at: l.finished_at });
        }
      }
      // Started 35 to 55 minutes before finishing, and an honest effort rating.
      run("UPDATE workout_logs SET created_at=datetime(finished_at, ?), rpe=? WHERE id=?", `-${35 + (n * 7) % 21} minutes`, [6, 7, 5, 8, 7][n % 5], l.id);
    });
  });
}

module.exports = { seed };
