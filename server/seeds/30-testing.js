// Demo data for Testing & results: three testing days over about three months (two shared with coach notes,
// one still open), realistic improving results for the family athletes (incl. height, seated height and weight
// for the growth estimate), and five results from two unknown senders waiting to be linked.
'use strict';
const { all, get, insert, tx } = require('../db');
const { addDays, today } = require('../lib');
const core = require('../services/testing-core');

const DAY_TESTS = ['40-yard dash', '20-yard sprint', 'Pro agility (5-10-5)', 'Standing broad jump', 'Vertical jump', 'Seated chest pass', 'Height', 'Seated height', 'Weight'];

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;

// Baseline for an athlete of this age and sex, then how each session moves it.
function baseline(age, sex) {
  const f = sex === 'F';
  const k = Math.max(-3, Math.min(5, age - 12));
  const hBoy = [55, 57, 59, 61.5, 64, 66.5, 68, 69, 69.5], hGirl = [55.5, 58, 60, 62, 62.8, 63.4, 63.8, 64, 64];
  const idx = Math.max(0, Math.min(8, Math.round(age) - 9));
  const height = f ? hGirl[idx] : hBoy[idx];
  return {
    '40-yard dash': 6.25 - k * 0.16 + (f ? 0.22 : 0), '20-yard sprint': 3.62 - k * 0.09 + (f ? 0.12 : 0), 'Pro agility (5-10-5)': 5.55 - k * 0.1 + (f ? 0.15 : 0),
    'Standing broad jump': 68 + k * 3.4 - (f ? 4 : 0), 'Vertical jump': 15 + k * 1.3 - (f ? 1.5 : 0), 'Seated chest pass': 14 + k * 1.8 - (f ? 2 : 0),
    Height: height, 'Seated height': r1(height * 0.522), Weight: Math.round(height * (f ? 1.72 : 1.78) + k * 3),
  };
}

function seed() {
  const T = today();
  const kids = all("SELECT * FROM athletes WHERE family_id IS NOT NULL AND birthday > '2005-01-01' ORDER BY id");
  if (!kids.length || get('SELECT 1 FROM testing_days LIMIT 1')) return;
  const coach = get("SELECT id FROM staff WHERE role='coach' LIMIT 1") || get('SELECT id FROM staff LIMIT 1');
  const tests = Object.fromEntries(DAY_TESTS.map((n) => [n, get('SELECT * FROM tests WHERE name=?', n)]));
  const byName = (first) => kids.find((k) => k.first_name === first);

  const days = [
    { name: 'Summer baseline', date: addDays(T, -93), status: 'shared', preset: 'Youth',
      note: "Good starting point. This summer we'll work on first-step speed and landing mechanics, then retest in August.", athletes: kids },
    { name: 'Fall combine', date: addDays(T, -30), status: 'shared', preset: 'Combine',
      note: "Big summer. Speed is trending the right way. Keep up the two sprint days a week, and we'll retest in December.", athletes: kids },
    { name: 'October youth testing', date: addDays(T, -2), status: 'open', preset: 'Youth', note: null,
      athletes: ['Nate', 'Isabela', 'Emma', 'Olivia'].map(byName).filter(Boolean) },
  ];

  tx(() => {
    days.forEach((d, di) => {
      d.id = insert('testing_days', { name: d.name, date: d.date, preset: d.preset, status: d.status, note: d.note, created_by: coach?.id,
        shared_at: d.status === 'shared' ? `${addDays(d.date, 1)} 15:00:00` : null, created_at: `${d.date} 15:00:00` });
      DAY_TESTS.forEach((n, i) => insert('testing_day_tests', { day_id: d.id, test_id: tests[n].id, ord: i + 1 }));
      for (const a of d.athletes) {
        insert('testing_day_athletes', { day_id: d.id, athlete_id: a.id });
        const rand = rng(a.id * 97 + di * 13);
        const age = core.decimalAge(a.birthday, d.date);
        const base = baseline(core.decimalAge(a.birthday, days[0].date), a.sex);
        const effort = 0.8 + rand() * 0.5; // how much this athlete improved
        for (const n of DAY_TESTS) {
          const t = tests[n];
          if (di === 2 && ['Height', 'Seated height', 'Weight'].includes(n) === false && rand() < 0.2) continue; // day still in progress
          let v;
          if (n === 'Height') v = r1(base.Height + (age - core.decimalAge(a.birthday, days[0].date)) * (a.sex === 'F' ? 1.2 : 2.6));
          else if (n === 'Seated height') v = r1(base['Seated height'] + (age - core.decimalAge(a.birthday, days[0].date)) * (a.sex === 'F' ? 0.6 : 1.3));
          else if (n === 'Weight') v = Math.round(base.Weight + di * (2 + rand() * 2));
          else if (t.lower_better) v = base[n] * (1 - 0.022 * di * effort);
          else v = base[n] * (1 + 0.045 * di * effort);
          // Ava's story for the demo: broad jump 6' 0" to 6' 5".
          if (a.first_name === 'Ava' && n === 'Standing broad jump') v = di === 0 ? 72 : 77;
          const attempts = ['Height', 'Seated height', 'Weight', 'Seated chest pass'].includes(n) ? 1 : 2;
          for (let at = 1; at <= attempts; at++) {
            let val = v;
            if (at === 2) val = t.lower_better ? v + 0.02 + rand() * 0.1 : v - (1 + rand() * 2) * (n === 'Vertical jump' ? 0.3 : 1);
            else if (!['Height', 'Seated height', 'Weight'].includes(n) && !(a.first_name === 'Ava' && n === 'Standing broad jump')) val = t.lower_better ? v + (rand() - 0.5) * 0.06 : v + (rand() - 0.5) * 1.2;
            val = t.unit === 's' ? r2(val) : n === 'Standing broad jump' || n === 'Weight' ? Math.round(val) : r1(val);
            val = Math.min(t.max_value, Math.max(t.min_value, val));
            insert('results', { athlete_id: a.id, test_id: t.id, day_id: d.id, attempt: at, value: val, unit_entered: t.unit,
              hand_timed: t.unit === 's' ? 1 : 0, source: di === 2 && t.timed ? 'stopwatch' : 'manual', recorded_at: `${d.date} 17:${String(10 + at).padStart(2, '0')}:00`, created_by: coach?.id });
          }
        }
      }
    });

    const act = (action, detail, at) => insert('activity', { actor: 'Chris Maddox (coach)', action, detail, kind: 'change', created_at: at });
    act('Started testing day', `Summer baseline (${kids.length} athletes, ${DAY_TESTS.length} tests)`, `${days[0].date} 15:00:00`);
    act('Shared testing day', `Summer baseline: ${kids.length} athletes`, `${addDays(days[0].date, 1)} 15:00:00`);
    act('Started testing day', `Fall combine (${kids.length} athletes, ${DAY_TESTS.length} tests)`, `${days[1].date} 15:00:00`);
    act('New PR', 'Ava Lopez, Standing broad jump 6′ 5″', `${days[1].date} 17:12:00`);
    const chidi = byName('Chidi');
    if (chidi) {
      const best = get("SELECT MIN(value) AS v FROM results r JOIN tests t ON t.id=r.test_id WHERE r.athlete_id=? AND r.day_id=? AND t.name='40-yard dash'", chidi.id, days[1].id);
      if (best?.v) act('New PR', `Chidi Okafor, 40-yard dash ${core.fmtValue(best.v, 's')}`, `${days[1].date} 17:14:00`);
    }
    act('Shared testing day', `Fall combine: ${kids.length} athletes`, `${addDays(days[1].date, 1)} 15:00:00`);
    act('Started testing day', `October youth testing (${days[2].athletes.length} athletes, ${DAY_TESTS.length} tests)`, `${days[2].date} 15:00:00`);

    // Results from senders nobody has linked yet.
    const at = new Date(Date.now() - 55 * 60e3).toISOString().replace('T', ' ').slice(0, 19);
    const tested = `${addDays(T, -1)} 16:40:00`;
    const pend = (source, key, label, name, value, ref) => {
      const t = get('SELECT * FROM tests WHERE name=?', name);
      insert('pending_results', { source, sender_key: key, sender_label: label, test_id: t.id, test_name: t.name, value, unit: t.unit, recorded_at: tested, source_ref: `demo:${ref}`, created_at: at });
    };
    pend('OVR', 'Olivia P', 'Olivia P', 'Vertical jump', 19.5, 'ovr-1');
    pend('OVR', 'Olivia P', 'Olivia P', 'Standing broad jump', 71, 'ovr-2');
    pend('OVR', 'Olivia P', 'Olivia P', '10-yard sprint', 1.98, 'ovr-3');
    pend('Jump mat', 'JM-2291', 'Jump mat JM-2291', 'Vertical jump', 17.5, 'jm-1');
    pend('Jump mat', 'JM-2291', 'Jump mat JM-2291', 'Vertical jump', 18, 'jm-2');
  });
}

module.exports = { seed };
