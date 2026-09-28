// The test library screen: how much each test is used, one test's details and record board, deleting unused custom
// tests, and presets (named sets of tests to start a testing day from).
import { newId, v, notFound, badRequest, conflict, ageOn } from '../util.js';
import { listTests, getTest, testHasResults } from './performance.js';
import { DEFAULT_PRESETS } from './test-library.js';

// ---------- Usage ----------
// Per test: saved results, athletes, testing days and the last date it was used (removed results don't count).
function usageByTest(ctx, testId = null) {
  return new Map(ctx.db.all(`SELECT r.test_id, COUNT(*) AS results, COUNT(DISTINCT r.client_id) AS athletes, COUNT(DISTINCT r.session_id) AS days,
      MAX(substr(r.recorded_at, 1, 10)) AS last_used FROM perf_results r
    WHERE r.voided = 0 ${testId ? 'AND r.test_id = ?' : ''} GROUP BY r.test_id`, ...(testId ? [testId] : []))
    .map((u) => [u.test_id, { results: u.results, athletes: u.athletes, days: u.days, last_used: u.last_used }]));
}
const NO_USE = { results: 0, athletes: 0, days: 0, last_used: null };
const presetRows = (ctx) => ctx.db.all('SELECT * FROM test_presets ORDER BY sort, name').map((p) => ({ ...p, test_keys: JSON.parse(p.test_keys) }));

// Every test (hidden ones too) with its usage and the presets it's in.
export function libraryList(ctx) {
  const usage = usageByTest(ctx), presets = presetRows(ctx);
  return listTests(ctx, { includeInactive: true }).map((t) => ({ ...t, usage: usage.get(t.id) ?? NO_USE,
    presets: presets.filter((p) => p.test_keys.includes(t.key)).map((p) => ({ id: p.id, name: p.name })) }));
}

// ---------- One test: details and record board ----------
export const AGE_GROUPS = { u12: [0, 12, '12 and under'], '13-14': [13, 14, '13–14'], '15-16': [15, 16, '15–16'], '17-18': [17, 18, '17–18'], adult: [19, 200, '19 and over'] };
// What stops a custom test from being deleted, in words; null when nothing does.
function inUse(ctx, t) {
  if (ctx.db.get('SELECT 1 FROM perf_results WHERE test_id = ? LIMIT 1', t.id)) return 'it has results';
  if (ctx.db.get(`SELECT 1 FROM results_queue WHERE status = 'pending' AND json_extract(item, '$.test') = ? LIMIT 1`, t.key)) return 'results waiting to be linked use it';
  if (ctx.db.get('SELECT 1 FROM perf_sessions s, json_each(s.test_keys) k WHERE k.value = ? LIMIT 1', t.key)) return 'a testing day uses it';
  if (ctx.db.get('SELECT 1 FROM test_targets WHERE test_id = ? LIMIT 1', t.id)) return 'athletes have targets for it';
  if (ctx.db.get('SELECT 1 FROM workout_exercises WHERE load_test = ? LIMIT 1', t.key)) return 'a program sets weights from it';
  return null;
}

// Each athlete's best on one number of the test, top 10. Filter by sex and by age group (the athlete's age when the
// result was set, like any age-group record board). Archived athletes are left out. Team roster athletes count (each
// athlete has one profile, so someone on a team who also trains privately counts once).
export function recordBoard(ctx, t, { metric, side, sex, age } = {}) {
  const m = metric ? t.metrics.find((x) => x.key === metric) : t.metrics[0];
  if (!m) throw badRequest(`${t.name} has no number called "${metric}".`);
  if (side != null && side !== '' && !['L', 'R'].includes(side)) throw badRequest('side must be L or R.');
  if (sex != null && sex !== '' && !['M', 'F'].includes(sex)) throw badRequest('sex must be M or F.');
  if (age != null && age !== '' && !AGE_GROUPS[age]) throw badRequest(`age must be one of: ${Object.keys(AGE_GROUPS).join(', ')}.`);
  if (m.better === 'none') return { metric: m.key, metric_name: m.name, unit: m.unit, decimals: m.decimals, better: m.better, board: [], note: `${m.name} is a measurement, not a score, so there's no record board.` };
  const rows = ctx.db.all(`SELECT r.client_id, r.value, r.side, r.timing, r.recorded_at, c.name, c.athlete_id, c.sex, c.birth_date, r.client_id AS person
    FROM perf_results r JOIN clients c ON c.id = r.client_id
    WHERE r.test_id = ? AND r.metric = ? AND r.voided = 0 ${side ? 'AND r.side = ?' : ''} AND c.archived_at IS NULL
    ORDER BY r.recorded_at`, t.id, m.key, ...(side ? [side] : []));
  const band = age ? AGE_GROUPS[age] : null;
  const better = (a, b) => (m.better === 'lower' ? a < b : a > b);
  const best = new Map();
  for (const r of rows) {
    if (sex && r.sex !== sex) continue;
    if (band) { const y = ageOn(r.birth_date, r.recorded_at); if (y == null || y < band[0] || y > band[1]) continue; }
    const cur = best.get(r.person);
    if (!cur || better(r.value, cur.value)) best.set(r.person, r);
  }
  // Equal results share a rank (1, 1, 3); the one set first is listed first.
  const sorted = [...best.values()].sort((a, b) => (m.better === 'lower' ? a.value - b.value : b.value - a.value) || a.recorded_at.localeCompare(b.recorded_at));
  const board = sorted.slice(0, 10)
    .map((r, i) => ({ rank: sorted.findIndex((x) => x.value === r.value) + 1, client_id: r.client_id, name: r.name, athlete_id: r.athlete_id, value: r.value, side: r.side, date: r.recorded_at.slice(0, 10), hand_timed: r.timing === 'hand' }));
  return { metric: m.key, metric_name: m.name, unit: m.unit, decimals: m.decimals, better: m.better, board };
}

export function testDetails(ctx, key, q = {}) {
  const t = getTest(ctx, key);
  const blocked = t.builtin ? 'built-in' : inUse(ctx, t);
  return { ...t, usage: usageByTest(ctx, t.id).get(t.id) ?? NO_USE, has_results: testHasResults(ctx, t),
    presets: presetRows(ctx).filter((p) => p.test_keys.includes(t.key)).map((p) => ({ id: p.id, name: p.name })),
    records: recordBoard(ctx, t, q), deletable: !blocked, not_deletable_because: t.builtin ? 'Built-in tests can\'t be deleted. Hide it instead to keep it out of your menus.' : blocked ? `${t.name} can't be deleted because ${blocked}. Hide it instead.` : null,
    age_groups: Object.entries(AGE_GROUPS).map(([k, [, , label]]) => ({ key: k, label })) };
}

// Delete a custom test nobody has used. Presets that include it lose it.
export function deleteTest(ctx, key) {
  const t = getTest(ctx, key);
  if (t.builtin) throw badRequest('Built-in tests can\'t be deleted. Hide it instead to keep it out of your menus.');
  const blocked = inUse(ctx, t);
  if (blocked) throw conflict(`${t.name} can't be deleted because ${blocked}. Hide it instead.`);
  ctx.db.tx(() => {
    for (const p of presetRows(ctx)) if (p.test_keys.includes(t.key)) ctx.db.run('UPDATE test_presets SET test_keys = ?, updated_at = ? WHERE id = ?', JSON.stringify(p.test_keys.filter((k) => k !== t.key)), ctx.now(), p.id);
    ctx.db.run('DELETE FROM perf_tests WHERE id = ?', t.id);
  });
  return { deleted: true, key: t.key, name: t.name };
}

// ---------- Presets ----------
// A new business starts with the standard presets once; after that, the owner's edits and deletions stand.
export function seedPresets(ctx) {
  if (ctx.db.get(`SELECT 1 FROM settings WHERE key = 'presets_seeded'`)) return;
  ctx.db.tx(() => {
    if (!ctx.db.get('SELECT 1 FROM test_presets LIMIT 1')) {
      const known = new Set(ctx.db.all('SELECT key FROM perf_tests').map((t) => t.key));
      DEFAULT_PRESETS.forEach(([name, keys], i) => ctx.db.run('INSERT INTO test_presets (id, name, test_keys, sort, created_at) VALUES (?, ?, ?, ?, ?)',
        newId('tp'), name, JSON.stringify(keys.filter((k) => known.has(k))), i, ctx.now()));
    }
    ctx.db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('presets_seeded', ?)`, ctx.now());
  });
}
function shapePreset(ctx, p, tests) {
  const byKey = tests ?? new Map(listTests(ctx, { includeInactive: true }).map((t) => [t.key, t]));
  const list = p.test_keys.map((k) => byKey.get(k)).filter(Boolean);
  return { id: p.id, name: p.name, sort: p.sort, created_at: p.created_at, updated_at: p.updated_at,
    tests: list.map((t) => ({ key: t.key, name: t.name, category: t.category, active: t.active })), hidden: list.filter((t) => !t.active).length };
}
export function listPresets(ctx) {
  const tests = new Map(listTests(ctx, { includeInactive: true }).map((t) => [t.key, t]));
  return presetRows(ctx).map((p) => shapePreset(ctx, p, tests));
}
export function getPreset(ctx, id) {
  const p = ctx.db.get('SELECT * FROM test_presets WHERE id = ?', id);
  if (!p) throw notFound('Preset');
  return shapePreset(ctx, { ...p, test_keys: JSON.parse(p.test_keys) });
}
function presetName(ctx, val, exceptId = null) {
  const name = v.str(val, 'name', { max: 40 }).replace(/\s+/g, ' ');
  if (ctx.db.get('SELECT id FROM test_presets WHERE name = ? COLLATE NOCASE AND id IS NOT ?', name, exceptId)) throw conflict(`There's already a preset called ${name}. Pick a different name.`);
  return name;
}
function presetTests(ctx, val) {
  if (!Array.isArray(val) || !val.length) throw badRequest('Add at least one test to the preset.');
  const keys = [...new Set(val.map((k) => String(k ?? '')))];
  if (keys.length > 40) throw badRequest('A preset can hold up to 40 tests.');
  return keys.map((k) => getTest(ctx, k).key);
}
export function createPreset(ctx, body) {
  const name = presetName(ctx, body.name), keys = presetTests(ctx, body.tests);
  const id = newId('tp');
  ctx.db.run('INSERT INTO test_presets (id, name, test_keys, sort, created_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM test_presets), ?)', id, name, JSON.stringify(keys), ctx.now());
  return getPreset(ctx, id);
}
export function updatePreset(ctx, id, body) {
  const p = getPreset(ctx, id);
  const name = body.name !== undefined ? presetName(ctx, body.name, p.id) : p.name;
  const keys = body.tests !== undefined ? presetTests(ctx, body.tests) : JSON.parse(ctx.db.get('SELECT test_keys FROM test_presets WHERE id = ?', p.id).test_keys);
  ctx.db.run('UPDATE test_presets SET name = ?, test_keys = ?, updated_at = ? WHERE id = ?', name, JSON.stringify(keys), ctx.now(), p.id);
  return getPreset(ctx, p.id);
}
export function copyPreset(ctx, id) {
  const p = getPreset(ctx, id);
  const base = `${p.name.slice(0, 30).trim()} (copy`;          // room for " (copy 99)" within the 40-character limit
  let name = `${base})`;
  for (let n = 2; ctx.db.get('SELECT 1 FROM test_presets WHERE name = ? COLLATE NOCASE', name); n++) name = `${base} ${n})`;
  return createPreset(ctx, { name, tests: JSON.parse(ctx.db.get('SELECT test_keys FROM test_presets WHERE id = ?', p.id).test_keys) });
}
export function deletePreset(ctx, id) {
  const p = getPreset(ctx, id);
  ctx.db.run('DELETE FROM test_presets WHERE id = ?', p.id);
  return { deleted: true, id: p.id, name: p.name };
}
