// Parent Progress tab: shared results for one athlete in plain language, with a period, the coach's targets,
// how they compare, what each test measures, the next testing day and the shared testing days to pick from.
// Only results from shared testing days are included (unless the facility shares results immediately).
'use strict';
const { get, all, setting } = require('../db');
const { bad } = require('../lib');
const core = require('./testing-core');
const lib = require('./testing-library');
const engage = require('./engage');
const { todayLocal } = require('./booking');

// What a category of tests tells a parent, in one sentence.
const MEANS = {
  Speed: 'How fast they cover a short distance from a standing start.',
  Agility: 'How quickly they stop, change direction and go again.',
  Power: 'How explosively they jump or throw. Power carries over to sprinting, hitting and throwing.',
  Strength: 'How much force they can produce in a lift or a hold.',
  Endurance: 'How well they keep going and recover between hard efforts.',
  Mobility: 'How freely their joints move. Good range of motion helps prevent injuries.',
  'Force plate': 'Measured on a force plate, which records how hard and how fast they push into the ground.',
  Baseball: 'Game skills measured with a radar, a bat sensor or a stopwatch.',
  Basketball: 'Court speed and agility, measured the way the combines do.',
  Hockey: 'Skating speed and agility, measured on the ice.',
  Soccer: 'Speed, agility and fitness, measured the way soccer clubs do.',
  Body: 'Body measurements. They change as they grow and are not better or worse.',
};
const PERIODS = ['all', '12m'];

// ?period=all|12m or ?since=<testing day id> (a shared testing day this athlete took part in).
function periodOf(athleteId, q, days) {
  if (q.since != null && q.since !== '') {
    const d = days.find((x) => x.id === Number(q.since));
    if (!d) throw bad('Pick a testing day from the list.');
    return { key: `since:${d.id}`, from: d.date, label: `Since ${d.name}` };
  }
  const p = q.period == null || q.period === '' ? 'all' : String(q.period);
  if (!PERIODS.includes(p)) throw bad('Pick All results, Last 12 months or a testing day.');
  if (p === '12m') {
    const t = new Date(todayLocal() + 'T12:00:00Z');
    t.setUTCFullYear(t.getUTCFullYear() - 1);
    return { key: '12m', from: t.toISOString().slice(0, 10), label: 'Last 12 months' };
  }
  return { key: 'all', from: null, label: 'All results' };
}

// The next testing day the athlete is on (by name or through their team), including one that's today.
function nextTesting(a) {
  return get(`SELECT d.id, d.name, d.date FROM testing_days d
    WHERE d.status='open' AND d.date >= ? AND (EXISTS (SELECT 1 FROM testing_day_athletes x WHERE x.day_id=d.id AND x.athlete_id=?) OR (d.team_id IS NOT NULL AND d.team_id=?))
    ORDER BY d.date, d.id LIMIT 1`, todayLocal(), a.id, a.team_id ?? -1) || null;
}

function forParent(athleteId, q = {}) {
  const a = get('SELECT id, team_id, birthday, sex FROM athletes WHERE id=?', athleteId);
  const visibility = setting('results_visibility', 'shared');
  const onlyShared = visibility !== 'immediate';
  const allDays = all(`SELECT DISTINCT d.id, d.name, d.date FROM testing_days d JOIN results r ON r.day_id=d.id
    WHERE r.athlete_id=? ${onlyShared ? "AND d.status='shared'" : ''} ORDER BY d.date DESC, d.id DESC`, a.id);
  const period = periodOf(a.id, q, allDays);
  const full = core.progress(a.id, { view: 'parent', visibility });
  const p = period.from ? core.progress(a.id, { view: 'parent', visibility, from: period.from }) : full;
  const tests = all(`SELECT id, name, custom, description FROM tests WHERE id IN (${p.tests.map(() => '?').join(',') || 'NULL'})`, ...p.tests.map((t) => t.test_id));
  const how = Object.fromEntries(tests.map((t) => [t.id, lib.protocolFor(t) || null]));
  return {
    ...p,
    tests: p.tests.map((t) => ({ ...t, how: how[t.test_id] || null, means: MEANS[t.category] || null })),
    prs: full.prs, // a PR is a best ever, whatever the period
    // Targets and rankings use every shared result, whatever the period.
    targets: engage.targetsFor(a.id, full.tests),
    rankings: engage.rankings(get('SELECT * FROM athletes WHERE id=?', a.id), full.tests, onlyShared),
    all_days: allDays, period, next_testing: nextTesting(a),
  };
}

module.exports = { forParent, MEANS };
