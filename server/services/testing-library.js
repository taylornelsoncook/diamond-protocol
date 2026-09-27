// Test library and progress report: test protocols, usage and record boards, editing and deleting tests,
// presets (kept in settings as { name: [test names] }), and private share links for the progress report.
'use strict';
const { db, all, get, run, insert, update, tx, setting, setSetting } = require('../db');
const { bad, notFound, randomToken, ageOn } = require('../lib');

// Schema upgrade: a written protocol per test (null = use the built-in text below).
if (!all('PRAGMA table_info(tests)').some((c) => c.name === 'description')) run('ALTER TABLE tests ADD COLUMN description TEXT');

// Private links to a progress report: anyone with the link sees the family view, until it expires or is turned off.
db.exec(`
CREATE TABLE IF NOT EXISTS report_links (
  id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, label TEXT,
  created_by TEXT, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT, revoked_at TEXT, views INTEGER DEFAULT 0, last_viewed_at TEXT);
CREATE INDEX IF NOT EXISTS report_links_athlete ON report_links(athlete_id);
`);

// How each built-in test is run, so every coach runs it the same way.
const PROTOCOLS = {
  '10-yard sprint': 'Acceleration. Same start every time: two-point stance, timing starts on first movement.',
  '20-yard sprint': 'Two-point start. Record the 10-yard split in the 10-yard sprint if you have gates.',
  '30-yard sprint': 'MLB Draft Combine distance. Side-on or two-point start; keep it the same for retests.',
  '40-yard dash': 'NFL Combine standard. Three-point stance; electronic timing starts on first movement. Hand times read faster.',
  '60-yard dash': 'Baseball showcase standard (Perfect Game). Two-point start, run through the line.',
  '10m sprint': 'Most-used sprint distance in soccer testing. Start 0.5 m behind the first gate.',
  '20m sprint': 'Start 0.5 m behind the first gate. Record a 10 m split with the 10m sprint if you have gates.',
  '30m sprint': 'Start 0.5 m behind the first gate. Rest at least two minutes between attempts.',
  'Flying 10-yard': 'Top speed. 20-yard build-up, then time the 10 yards between gates.',
  'Pro agility (5-10-5)': 'Start straddling the middle line, run 5 yards, touch, 10 yards back, touch, 5 yards through the middle. Record the fastest; test both directions if you can.',
  '3-cone drill': 'L-drill. Cones 5 yards apart in an L; hand touches the line at each turn.',
  'T-test': 'Forward 10 yards, shuffle 5 left, 10 right, 5 left, backpedal 10. No crossing the feet.',
  'Illinois agility': '10 m by 5 m course with four weaving cones down the middle. Start lying face down.',
  '505 agility': 'Build up over 10 m, time the 5 m in and 5 m out around a 180 degree turn. Test both turning feet.',
  'Reactive agility': 'Athlete reacts to a light or coach cue and cuts to the signalled side. Time from cue to the finish line.',
  'Vertical jump': 'Standing, no step. Reach height taken first; record jump height (touch minus reach). Best of three.',
  'Approach vertical': 'Free approach of up to three steps, jump off either foot. Record touch minus standing reach.',
  'Standing broad jump': 'Toes behind the line, two-foot take-off and landing. Measure to the back of the nearest heel; a fall back is a redo.',
  'Triple broad jump': 'Three continuous two-foot jumps with no pause. Measure to the back of the nearest heel.',
  'Seated chest pass': 'Back flat against a wall, legs out. Two-hand chest pass; measure to where the ball first lands. Note the ball weight and keep it the same.',
  'Rotational med ball throw': 'Side-on to the throw, scoop toss from the back hip. Test both sides and keep the ball weight the same.',
  'Overhead backward throw': 'Back to the throwing area, swing the ball between the legs and throw it back over the head. Measure the first bounce.',
  'Single-leg broad jump (left)': 'Take off and land on the left foot and hold the landing for two seconds.',
  'Single-leg broad jump (right)': 'Take off and land on the right foot and hold the landing for two seconds.',
  'Back squat 1RM': 'Thighs to parallel or below. Warm up in sets of 5, 3, 2, 1, then no more than five max attempts. Only with trained lifters.',
  'Bench press 1RM': 'Touch the chest, no bounce, hips on the bench. A spotter on every attempt.',
  'Trap bar deadlift 1RM': 'High or low handles: note which and keep it the same for retests.',
  'Front squat 1RM': 'Thighs to parallel or below, elbows stay up.',
  'Power clean 1RM': 'Catch above parallel with the bar racked on the shoulders. Technique first; stop when form breaks.',
  'Pull-ups': 'Dead hang start, chin over the bar, full extension at the bottom. No kipping.',
  'Push-ups': 'Body in one line, chest to a fist-height target, full lockout. Stop at the first form break.',
  'Bench press reps at 185': 'NFL Combine test. Reps to failure with a full lockout each rep.',
  'Grip strength (left)': 'Hand dynamometer, elbow at 90 degrees by the side. Best of two squeezes.',
  'Grip strength (right)': 'Hand dynamometer, elbow at 90 degrees by the side. Best of two squeezes.',
  'Plank hold': 'Forearms and toes, body in one line. Stop the clock when the hips sag or pike.',
  '1-mile run': 'Track or measured course. Record total time; type minutes and seconds like 6:42.',
  '1.5-mile run': 'Track or measured course. Type minutes and seconds like 11:05.',
  '300-yard shuttle': 'Six round trips of 25 yards. Record total time.',
  'Beep test': 'Multistage 20 m shuttle to the audio. Record the last level completed.',
  'Yo-Yo IR1': 'Intermittent recovery test level 1. Record total distance covered.',
  '2 km row': 'Record total time on the rower; type minutes and seconds like 7:30.',
  'Sit and reach': 'Standard box, shoes off, knees straight. Hold the reach for two seconds.',
  'Ankle dorsiflexion (left)': 'Knee-to-wall test. Distance from big toe to wall with the knee touching and the heel down.',
  'Ankle dorsiflexion (right)': 'Knee-to-wall test. Distance from big toe to wall with the knee touching and the heel down.',
  'Hip internal rotation (left)': 'Seated, hips and knees at 90 degrees. Goniometer at the knee.',
  'Hip internal rotation (right)': 'Seated, hips and knees at 90 degrees. Goniometer at the knee.',
  'Shoulder external rotation (left)': 'Lying on the back, arm out at 90 degrees. Goniometer at the elbow.',
  'Shoulder external rotation (right)': 'Lying on the back, arm out at 90 degrees. Goniometer at the elbow.',
  Height: 'Shoes off, heels together against the wall, looking straight ahead. Needed for the growth-spurt estimate.',
  'Seated height': 'Sitting on a box against the wall; subtract the box height. Needed for the growth-spurt estimate.',
  Weight: 'Shoes off, light clothing, same time of day when you can. Needed for the growth-spurt estimate.',
  Wingspan: 'Arms out at shoulder height against a wall, fingertip to fingertip.',
  'Standing reach': 'Flat-footed, one arm straight up. Take it before the vertical jump.',
  'Body fat': 'Use the same method (calipers or scale) for every retest and note which.',
  'CMJ jump height': 'Countermovement jump on the force plate, hands on hips. From impulse-momentum.',
  'CMJ peak power': 'From the countermovement jump on the force plate.',
  'CMJ relative power': 'Peak power divided by body mass, from the countermovement jump.',
  'RSI-modified': 'Jump height divided by time to take-off, from the countermovement jump.',
  'Squat jump height': 'Hold the bottom for three seconds, then jump with no dip. Hands on hips.',
  'Drop jump RSI': 'Step off a 30 cm box, spend as little time on the ground as possible and jump high. Jump height over contact time.',
  'IMTP peak force': 'Isometric mid-thigh pull. Pull as hard and fast as you can for three to five seconds.',
  'Landing asymmetry': 'Left and right difference in landing force from the force plate. Under 10% is typical.',
  'Exit velocity': 'Off a tee or front toss, measured with Rapsodo, HitTrax or a radar. Record the best of five.',
  'Bat speed': 'Sensor on the knob (Blast or similar). Record the best of five swings.',
  'Pitch velocity': 'Radar from behind the catcher. Fastball, full effort, after a full warm-up.',
  'Infield velocity': 'Crow hop allowed, throw across the diamond, radar from behind the target.',
  'Outfield velocity': 'Crow hop allowed, throw to the cut-off or home, radar from behind the target.',
  'Pop time': 'From the ball hitting the mitt to the fielder\'s glove at second base.',
  'Home to first': 'From contact (or the swing on a dry run) to the foot on first base.',
  'Lane agility': 'NBA Combine lane drill around the key: sprint, slide, backpedal, slide.',
  '3/4 court sprint': 'Baseline to the far free-throw line.',
  'Shuttle run': 'Basketball shuttle. Keep the distance and turns the same for retests.',
  'On-ice 30m sprint': 'Standing start on the ice, full gear.',
  'Weave agility': 'On-ice weave around the pylons, forwards and back.',
  'Transition agility': 'On-ice forward skate, pivot to backward, pivot to forward.',
  'Arrowhead agility': 'Soccer agility course; test both left and right and record the fastest.',
  '30-15 IFT': '30-15 Intermittent Fitness Test. Record the final running speed reached.',
  'Repeated sprint average': 'Average of six 30 m sprints with 20 seconds of recovery.',
};
const protocolFor = (t) => (t.description != null ? t.description : t.custom ? '' : PROTOCOLS[t.name] || '');

const COLS = 'id, name, category, unit, lower_better, attempts, min_value, max_value, timed, hidden, custom, description';
const shape = (t) => (t ? { ...t, description: protocolFor(t) } : t);

// ---- the library ------------------------------------------------------------
// Every test with how much it's used, so owners can see what to hide.
function list({ includeHidden = true } = {}) {
  const usage = new Map(all(`SELECT test_id, COUNT(*) AS results, COUNT(DISTINCT athlete_id) AS athletes, MAX(substr(COALESCE(d.date, r.recorded_at),1,10)) AS last_used
    FROM results r LEFT JOIN testing_days d ON d.id=r.day_id GROUP BY test_id`).map((u) => [u.test_id, u]));
  const presets = setting('presets', {}) || {};
  return all(`SELECT ${COLS} FROM tests ${includeHidden ? '' : 'WHERE hidden=0'} ORDER BY id`).map((t) => {
    const u = usage.get(t.id);
    return { ...shape(t), results: u?.results || 0, athletes: u?.athletes || 0, last_used: u?.last_used || null,
      presets: Object.keys(presets).filter((p) => (presets[p] || []).includes(t.name)) };
  });
}

const AGE_BANDS = { u12: [0, 12], '13-14': [13, 14], '15-16': [15, 16], '17-18': [17, 18], adult: [19, 200] };
// One test in full: protocol, usage, presets and the record board (each athlete's best, top 10).
function detail(id, { sex = '', age = '' } = {}) {
  const t = get(`SELECT ${COLS} FROM tests WHERE id=?`, Number(id));
  if (!t) throw notFound('That test');
  const u = get(`SELECT COUNT(*) AS results, COUNT(DISTINCT r.athlete_id) AS athletes, COUNT(DISTINCT r.day_id) AS days,
      MAX(substr(COALESCE(d.date, r.recorded_at),1,10)) AS last_used FROM results r LEFT JOIN testing_days d ON d.id=r.day_id WHERE r.test_id=?`, t.id);
  const presets = setting('presets', {}) || {};
  const rows = all(`SELECT r.athlete_id, r.value, r.hand_timed, substr(COALESCE(d.date, r.recorded_at),1,10) AS date, a.code, a.first_name, a.last_name, a.sex, a.birthday
    FROM results r JOIN athletes a ON a.id=r.athlete_id LEFT JOIN testing_days d ON d.id=r.day_id
    WHERE r.test_id=? AND a.archived=0 ORDER BY r.id`, t.id);
  const band = AGE_BANDS[age];
  const best = new Map();
  for (const r of rows) {
    if (sex && r.sex !== sex) continue;
    if (band) { // the athlete's age when the result was set, like any age-group record board
      const y = r.birthday ? ageOn(r.birthday, r.date) : null;
      if (y == null || y < band[0] || y > band[1]) continue;
    }
    const cur = best.get(r.athlete_id);
    if (!cur || (t.lower_better ? r.value < cur.value : r.value > cur.value)) best.set(r.athlete_id, r);
  }
  const board = [...best.values()].sort((a, b) => (t.lower_better ? a.value - b.value : b.value - a.value) || a.date.localeCompare(b.date)).slice(0, 10)
    .map((r) => ({ athlete_id: r.athlete_id, code: r.code, first_name: r.first_name, last_name: r.last_name, value: r.value, date: r.date, hand_timed: !!r.hand_timed }));
  return { ...shape(t), usage: { results: u.results, athletes: u.athletes, days: u.days, last_used: u.last_used },
    presets: Object.keys(presets).filter((p) => (presets[p] || []).includes(t.name)), board, deletable: !!t.custom && !inUse(t.id) };
}

function inUse(testId) {
  if (get('SELECT 1 FROM results WHERE test_id=? LIMIT 1', testId)) return 'results';
  if (get('SELECT 1 FROM pending_results WHERE test_id=? LIMIT 1', testId)) return 'waiting results';
  if (get('SELECT 1 FROM testing_day_tests WHERE test_id=? LIMIT 1', testId)) return 'a testing day';
  if (get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_targets'") && get('SELECT 1 FROM test_targets WHERE test_id=? LIMIT 1', testId)) return 'athlete targets';
  return null;
}

const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const num = (v) => (v === '' || v == null ? null : Number(v));
function cleanFields(b, t = {}) {
  const out = {};
  if ('name' in b) {
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw bad('Name the test.');
    if (name.length > 60) throw bad('Keep the name under 60 characters.');
    if (get('SELECT 1 FROM tests WHERE name=? COLLATE NOCASE AND id IS NOT ?', name, t.id ?? null)) throw bad('A test with that name already exists.');
    out.name = name;
  }
  if ('category' in b) {
    const c = String(b.category || '').trim().replace(/\s+/g, ' ') || 'Custom';
    if (c.length > 30) throw bad('Keep the category under 30 characters.');
    out.category = c;
  }
  if ('unit' in b) {
    const unit = String(b.unit || '').trim();
    if (!unit || unit.length > 12) throw bad('Give the unit, like s, in, lb or reps.');
    out.unit = unit;
  }
  if ('lower_better' in b) out.lower_better = bool(b.lower_better) ? 1 : 0;
  if ('attempts' in b && b.attempts !== '' && b.attempts != null) {
    const n = Number(b.attempts);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw bad('Attempts has to be a whole number from 1 to 10.');
    out.attempts = n;
  }
  if ('min_value' in b || 'max_value' in b) {
    const min = 'min_value' in b ? num(b.min_value) : t.min_value ?? null;
    const max = 'max_value' in b ? num(b.max_value) : t.max_value ?? null;
    if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max))) throw bad('The possible range has to be numbers.');
    if (min != null && max != null && min >= max) throw bad('The lowest possible value has to be below the highest.');
    out.min_value = min; out.max_value = max;
  }
  if ('timed' in b) out.timed = bool(b.timed) ? 1 : 0;
  if ('description' in b) {
    const d = String(b.description ?? '').trim();
    if (d.length > 1000) throw bad('Keep the protocol under 1,000 characters.');
    out.description = d;
  }
  const unit = out.unit ?? t.unit;
  if (out.timed && unit !== 's') throw bad('Only tests measured in seconds (s) can use the stopwatch.');
  if ('unit' in out && unit !== 's' && t.timed) out.timed = 0;
  return out;
}

function create(b) {
  const f = cleanFields({ category: 'Custom', attempts: 1, lower_better: 0, ...b, name: b.name ?? '', unit: b.unit ?? '' });
  if (f.attempts == null) f.attempts = 1; // a blank attempts box means one attempt
  const id = insert('tests', { name: f.name, category: f.category, unit: f.unit, lower_better: f.lower_better, attempts: f.attempts,
    min_value: f.min_value ?? null, max_value: f.max_value ?? null, timed: f.timed || 0, description: f.description || null, custom: 1 });
  return shape(get(`SELECT ${COLS} FROM tests WHERE id=?`, id));
}

// Built-in tests keep their name, unit and scoring (device imports and history rely on them); a custom test's
// unit and scoring lock once it has results. Returns { test, changes }.
function edit(id, b) {
  const t = get('SELECT * FROM tests WHERE id=?', Number(id));
  if (!t) throw notFound('That test');
  const f = cleanFields(b, t);
  if (!t.custom) {
    for (const k of ['name', 'unit', 'lower_better']) if (k in f && f[k] !== t[k]) throw bad(`Built-in tests keep their ${k === 'lower_better' ? 'scoring' : k}. Add your own test if you need a different one.`);
  } else if (get('SELECT 1 FROM results WHERE test_id=? LIMIT 1', t.id)) {
    if ('unit' in f && f.unit !== t.unit) throw bad(`${t.name} already has results in ${t.unit}. Add a new test for a different unit.`);
    if ('lower_better' in f && f.lower_better !== t.lower_better) throw bad(`${t.name} already has results, so its scoring can't flip. Add a new test instead.`);
  }
  if ('description' in f && !t.custom && f.description === (PROTOCOLS[t.name] || '')) f.description = null; // back to the built-in text
  if ('description' in f && t.custom && !f.description) f.description = null; // an empty box is no protocol, as when it was added
  const changes = Object.keys(f).filter((k) => f[k] !== t[k]);
  if ('hidden' in b) { const hv = bool(b.hidden) ? 1 : 0; if (hv !== t.hidden) { f.hidden = hv; changes.push('hidden'); } }
  if (!changes.length) return { test: shape(get(`SELECT ${COLS} FROM tests WHERE id=?`, t.id)), changes, before: t };
  tx(() => {
    update('tests', t.id, Object.fromEntries(changes.map((k) => [k, f[k]])));
    if (changes.includes('name')) renameInPresets(t.name, f.name);
  });
  return { test: shape(get(`SELECT ${COLS} FROM tests WHERE id=?`, t.id)), changes, before: t };
}

function remove(id) {
  const t = get('SELECT * FROM tests WHERE id=?', Number(id));
  if (!t) throw notFound('That test');
  if (!t.custom) throw bad('Built-in tests can\'t be deleted. Hide it instead to keep it out of your menus.');
  const used = inUse(t.id);
  if (used) throw bad(`${t.name} is used by ${used}, so it can't be deleted. Hide it instead.`);
  tx(() => {
    run('DELETE FROM tests WHERE id=?', t.id);
    const p = presetMap();
    for (const k of Object.keys(p)) p[k] = p[k].filter((n) => n !== t.name);
    setSetting('presets', p);
  });
  return t;
}

// ---- presets ------------------------------------------------------------------
const presetMap = () => ({ ...(setting('presets', {}) || {}) });
function renameInPresets(from, to) {
  const p = presetMap();
  for (const k of Object.keys(p)) p[k] = p[k].map((n) => (n === from ? to : n));
  setSetting('presets', p);
}
function presets() {
  const byName = new Map(all('SELECT id, name, unit, category, hidden FROM tests').map((t) => [t.name, t]));
  return Object.entries(presetMap()).map(([name, names]) => ({ name, tests: (names || []).map((n) => byName.get(n)).filter(Boolean) }));
}
function presetInput(b, current = null) {
  const name = String(b.name ?? current ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw bad('Name the preset.');
  if (name.length > 40) throw bad('Keep the preset name under 40 characters.');
  if (name === '__proto__') throw bad('Pick a different name for the preset.');
  const p = presetMap();
  if (Object.keys(p).some((k) => k.toLowerCase() === name.toLowerCase() && k !== current)) throw bad('A preset with that name already exists.');
  const raw = Array.isArray(b.test_ids) ? b.test_ids : [];
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw bad('Pick tests from the library.');
  if (!ids.length) throw bad('Add at least one test to the preset.');
  if (ids.length > 40) throw bad('A preset can hold up to 40 tests.');
  const names = ids.map((id) => get('SELECT name FROM tests WHERE id=?', id)?.name);
  if (names.some((n) => !n)) throw bad('One of those tests is no longer in the library. Reload and try again.');
  return { name, names };
}
function savePreset(b, current = null) {
  const p = presetMap();
  if (current != null && !Object.hasOwn(p, current)) throw notFound('That preset');
  const { name, names } = presetInput(b, current);
  // Keep the preset's place in the list when it's renamed.
  const next = {};
  if (current == null) { Object.assign(next, p); next[name] = names; }
  else for (const [k, v] of Object.entries(p)) { if (k === current) next[name] = names; else next[k] = v; }
  setSetting('presets', next);
  return { name, tests: names.length };
}
function deletePreset(name) {
  const p = presetMap();
  if (!Object.hasOwn(p, name)) throw notFound('That preset');
  delete p[name];
  setSetting('presets', p);
}

// ---- report links ---------------------------------------------------------------
const LINK_DAYS = [7, 30, 90, 365];
const activeLinks = (athleteId) => all(`SELECT id, token, label, created_by, created_at, expires_at, views, last_viewed_at FROM report_links
  WHERE athlete_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY id DESC`, athleteId);
function createLink(athleteId, { days = 30, label = '' } = {}, by = '') {
  const d = Number(days);
  if (!LINK_DAYS.includes(d)) throw bad('Pick how long the link works: 7, 30, 90 or 365 days.');
  const l = String(label || '').trim().replace(/\s+/g, ' ');
  if (l.length > 60) throw bad('Keep the label under 60 characters.');
  if (activeLinks(athleteId).length >= 10) throw bad('This athlete already has 10 working links. Turn one off first.');
  const token = randomToken(18);
  const id = insert('report_links', { athlete_id: athleteId, token, label: l || null, created_by: by, expires_at: sqlTime(Date.now() + d * 864e5) });
  return get('SELECT id, token, label, created_by, created_at, expires_at, views, last_viewed_at FROM report_links WHERE id=?', id);
}
function revokeLink(athleteId, id) {
  const l = get('SELECT * FROM report_links WHERE id=? AND athlete_id=?', Number(id), athleteId);
  if (!l) throw notFound('That link');
  if (!l.revoked_at) run("UPDATE report_links SET revoked_at=datetime('now') WHERE id=?", l.id);
  return l;
}
// The athlete a working link opens, counting the view; null when it's wrong, expired or turned off.
function openLink(athleteId, token, { count = true } = {}) {
  if (!token || typeof token !== 'string' || token.length > 64) return null;
  const l = get(`SELECT * FROM report_links WHERE token=? AND athlete_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))`, token, athleteId);
  if (!l) return null;
  if (count) run("UPDATE report_links SET views=views+1, last_viewed_at=datetime('now') WHERE id=?", l.id);
  return l;
}
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// Report period: optional YYYY-MM-DD from/to, checked.
function period(q = {}) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T12:00:00Z').getTime()) && new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s;
  const from = q.from ? String(q.from) : null, to = q.to ? String(q.to) : null;
  if ((from && !ok(from)) || (to && !ok(to))) throw bad('Dates need to look like 2026-09-01.');
  if (from && to && from > to) throw bad('The start of the period has to be before the end.');
  return { from, to };
}

module.exports = { PROTOCOLS, protocolFor, list, detail, create, edit, remove, inUse, presets, savePreset, deletePreset,
  activeLinks, createLink, revokeLink, openLink, period, LINK_DAYS, AGE_BANDS };
