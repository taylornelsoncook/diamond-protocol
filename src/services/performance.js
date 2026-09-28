import { newId, v, notFound, badRequest, conflict, isDate, sha256, localDate, HttpError } from '../util.js';
import { getSetting } from './families.js';
import { emit } from './events.js';
import { TESTS, CATEGORIES, PROTOCOLS, RANGES } from './test-library.js';
import { convert, normalizeUnit, compatibleUnits } from './units.js';
import { findByAthleteId, clientOfRoster } from './athlete-ids.js';

export { CATEGORIES };
const MAX_BATCH = 1000;

// ---------- Possible values ----------
// A metric's possible range as [lowest, highest]: the coach's own (both ends, set in the test library) when there is
// one, otherwise the built-in one, which can be one-sided (null for the open end). null when there is none.
// `metric` is a perf_metrics row or a metric from getTest/listTests (which already carries its `range`).
export function rangeOf(test, metric) {
  if (metric.range !== undefined) return metric.range;
  if (metric.min_value != null && metric.max_value != null) return [metric.min_value, metric.max_value];
  const r = RANGES[`${typeof test === 'string' ? test : test.key}.${metric.key}`];
  if (!r || (r[0] == null && r[1] == null)) return null;
  return [r[0] ?? null, r[1] ?? null];
}
export const outOfRange = (value, range) => !!range && ((range[0] != null && value < range[0]) || (range[1] != null && value > range[1]));
export const rangeText = (range, unit) => {
  const u = unit && !['ratio', 'level', 'reps', 'points'].includes(unit) ? ` ${unit}` : '';
  return range[0] != null && range[1] != null ? `${range[0]}–${range[1]}${u}` : range[0] != null ? `at least ${range[0]}${u}` : `at most ${range[1]}${u}`;
};

// ---------- Test library ----------
// Adds any built-in tests that are missing and refreshes their definitions. Coach choices (shown or hidden, and
// anything a coach edited on a built-in test, listed in `edited`), coach-written protocols and ranges, and custom
// tests are left alone.
const keep = (field) => `CASE WHEN instr(edited, '"${field}"') > 0 THEN ${field} ELSE ? END`;
export function syncLibrary(ctx) {
  const now = new Date().toISOString();
  ctx.db.tx(() => {
    TESTS.forEach((t, i) => {
      const row = ctx.db.get('SELECT id FROM perf_tests WHERE key = ?', t.key);
      const id = row?.id ?? newId('pt');
      if (row) ctx.db.run(`UPDATE perf_tests SET name = ${keep('name')}, category = ${keep('category')}, description = ${keep('description')}, sides = ?, attempts = ${keep('attempts')}, timed = ${keep('timed')}, sports = ?, aliases = ?, sort = ? WHERE id = ? AND builtin = 1`,
        t.name, t.category, t.desc ?? null, t.sides, t.attempts, t.timed ? 1 : 0, JSON.stringify(t.sports), JSON.stringify(t.aliases), i, id);
      else ctx.db.run('INSERT INTO perf_tests (id, key, name, category, description, sides, attempts, timed, sports, aliases, builtin, active, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
        id, t.key, t.name, t.category, t.desc ?? null, t.sides, t.attempts, t.timed ? 1 : 0, JSON.stringify(t.sports), JSON.stringify(t.aliases), i, now);
      t.metrics.forEach(([key, name, unit, better, decimals, aliases = []], j) => {
        ctx.db.run(`INSERT INTO perf_metrics (test_id, key, name, unit, better, decimals, aliases, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(test_id, key) DO UPDATE SET name = excluded.name, unit = excluded.unit, better = excluded.better, decimals = excluded.decimals, aliases = excluded.aliases, sort = excluded.sort`,
          id, key, name, unit, better, decimals, JSON.stringify(aliases), j);
      });
    });
  });
}

function shapeTest(t, metrics) {
  return { id: t.id, key: t.key, name: t.name, category: t.category, description: t.description, sides: t.sides, attempts: t.attempts, timed: !!t.timed,
    sports: JSON.parse(t.sports), aliases: JSON.parse(t.aliases), builtin: !!t.builtin, active: !!t.active,
    protocol: t.protocol ?? (t.builtin ? PROTOCOLS[t.key] ?? '' : ''), protocol_custom: t.protocol != null, edited: JSON.parse(t.edited ?? '[]'),
    metrics: metrics.map((m) => ({ key: m.key, name: m.name, unit: m.unit, better: m.better, decimals: m.decimals, aliases: JSON.parse(m.aliases), units: compatibleUnits(m.unit),
      range: rangeOf(t, m), range_custom: m.min_value != null && m.max_value != null })) };
}
export function listTests(ctx, { includeInactive = false } = {}) {
  const metrics = ctx.db.all('SELECT * FROM perf_metrics ORDER BY sort');
  return ctx.db.all(`SELECT * FROM perf_tests ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, name`)
    .map((t) => shapeTest(t, metrics.filter((m) => m.test_id === t.id)));
}
export function getTest(ctx, keyOrId) {
  const t = ctx.db.get('SELECT * FROM perf_tests WHERE key = ? OR id = ?', keyOrId, keyOrId);
  if (!t) throw notFound(`Test "${keyOrId}"`);
  return shapeTest(t, ctx.db.all('SELECT * FROM perf_metrics WHERE test_id = ? ORDER BY sort', t.id));
}
const nameTaken = (ctx, name, exceptId = null) => ctx.db.get('SELECT id FROM perf_tests WHERE name = ? COLLATE NOCASE AND id IS NOT ?', name, exceptId);
// A written protocol: empty means none (or, on a built-in test, the built-in text).
function protocolText(val) {
  if (val == null) return null;
  if (typeof val !== 'string') throw badRequest('protocol must be text.');
  return val.trim() ? v.str(val, 'protocol', { max: 2000 }) : null;
}
// The possible range for a metric: both ends or neither (neither = the built-in range, or none).
function rangeInput(m) {
  const blank = (x) => x === undefined || x === null || x === '';
  if (blank(m.min_value) && blank(m.max_value)) return [null, null];
  if (blank(m.min_value) || blank(m.max_value)) throw badRequest('Give both the lowest and the highest possible value, or leave both empty.');
  const min = Number(m.min_value), max = Number(m.max_value);
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw badRequest('The possible range has to be numbers.');
  if (min >= max) throw badRequest('The lowest possible value has to be below the highest.');
  return [min, max];
}
// Your own tests: a sport-specific drill, a different distance, anything.
export function createTest(ctx, body) {
  const name = v.str(body.name, 'name', { max: 80 });
  const key = (body.key ? v.str(body.key, 'key', { max: 40 }) : name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!key) throw badRequest('Give the test a name.');
  if (ctx.db.get('SELECT id FROM perf_tests WHERE key = ?', key)) throw conflict(`A test with key "${key}" already exists.`);
  if (nameTaken(ctx, name)) throw conflict(`There's already a test called ${name}. Pick a different name.`);
  const metrics = Array.isArray(body.metrics) && body.metrics.length ? body.metrics : [{ key: 'value', name: body.metric_name ?? 'Result', unit: body.unit, better: body.better, min_value: body.min_value, max_value: body.max_value }];
  if (metrics.length > 12) throw badRequest('A test can have up to 12 numbers.');
  const cat = v.oneOf(body.category ?? 'sport', 'category', CATEGORIES.map((c) => c[0]));
  const units = metrics.map((m) => normalizeUnit(v.str(m.unit, 'unit', { max: 20 })));
  if (body.timed && units[0] !== 's') throw badRequest('Only tests measured in seconds can use the stopwatch.');
  const id = newId('pt');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO perf_tests (id, key, name, category, description, sides, attempts, timed, sports, aliases, builtin, active, sort, created_at, protocol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1000, ?, ?)',
      id, key, name, cat, v.str(body.description, 'description', { max: 1000, optional: true }), v.oneOf(body.sides ?? 'none', 'sides', ['none', 'lr']),
      v.int(body.attempts === '' || body.attempts == null ? 2 : body.attempts, 'attempts', { min: 1, max: 10 }), body.timed ? 1 : 0, JSON.stringify(body.sports ?? []), JSON.stringify(body.aliases ?? []), ctx.now(), protocolText(body.protocol));
    const seen = new Set();
    metrics.forEach((m, j) => {
      const mk = String(m.key ?? m.name ?? 'value').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `m${j}`;
      if (seen.has(mk)) throw badRequest(`Two numbers on this test are both called "${mk}". Give each a different name.`);
      seen.add(mk);
      const [min, max] = rangeInput(m);
      ctx.db.run('INSERT INTO perf_metrics (test_id, key, name, unit, better, decimals, aliases, sort, min_value, max_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, mk, v.str(m.name ?? 'Result', 'metric name', { max: 60 }),
        units[j], v.oneOf(m.better ?? 'higher', 'better', ['lower', 'higher', 'none']), v.int(m.decimals ?? 2, 'decimals', { min: 0, max: 4 }), JSON.stringify(m.aliases ?? []), j, min, max);
    });
  });
  return getTest(ctx, id);
}
// Does this test have results (saved, removed or waiting to be linked)? Its units and scoring are then fixed.
export function testHasResults(ctx, t) {
  return !!(ctx.db.get('SELECT 1 FROM perf_results WHERE test_id = ? LIMIT 1', t.id)
    || ctx.db.get(`SELECT 1 FROM results_queue WHERE status = 'pending' AND json_extract(item, '$.test') = ? LIMIT 1`, t.key));
}
// Edit a test. Built-in tests: name, category, attempts, stopwatch, description, protocol and ranges (their numbers,
// units and scoring stay, since device imports and history rely on them). Your own tests: everything, but units,
// scoring and sides lock once the test has results. Returns the test with `changes`, the fields that really changed.
export function updateTest(ctx, keyOrId, body) {
  const t = getTest(ctx, keyOrId);
  const row = ctx.db.get('SELECT * FROM perf_tests WHERE id = ?', t.id);
  const set = {}, changes = [];
  const change = (field, value) => { if (value !== row[field]) { set[field] = value; changes.push(field); } };
  if (body.name !== undefined) {
    const name = v.str(body.name, 'name', { max: 80 });
    if (nameTaken(ctx, name, t.id)) throw conflict(`There's already a test called ${name}. Pick a different name.`);
    change('name', name);
  }
  if (body.category !== undefined) change('category', v.oneOf(body.category, 'category', CATEGORIES.map((c) => c[0])));
  if (body.attempts !== undefined) change('attempts', v.int(body.attempts, 'attempts', { min: 1, max: 10 }));
  if (body.description !== undefined) change('description', v.str(body.description, 'description', { max: 1000, optional: true }));
  if (body.active !== undefined) change('active', body.active ? 1 : 0);
  if (body.protocol !== undefined) {
    let p = protocolText(body.protocol);
    if (p != null && t.builtin && p === (PROTOCOLS[t.key] ?? '')) p = null;       // the built-in text again
    change('protocol', p);
  }
  const used = testHasResults(ctx, t);
  if (body.sides !== undefined) {
    const sides = v.oneOf(body.sides, 'sides', ['none', 'lr']);
    if (sides !== row.sides && (t.builtin || used)) throw badRequest(t.builtin ? 'Built-in tests keep their sides. Add your own test if you need a different one.' : `${t.name} already has results, so left and right can't change. Add a new test instead.`);
    change('sides', sides);
  }
  const metricSets = [];
  if (body.metrics !== undefined) {
    if (!Array.isArray(body.metrics)) throw badRequest('metrics must be a list.');
    for (const m of body.metrics) {
      const cur = ctx.db.get('SELECT * FROM perf_metrics WHERE test_id = ? AND key = ?', t.id, String(m?.key ?? ''));
      if (!cur) throw badRequest(`${t.name} has no number called "${m?.key}". Its numbers: ${t.metrics.map((x) => x.key).join(', ')}.`);
      const ms = {};
      if (m.name !== undefined) ms.name = v.str(m.name, 'metric name', { max: 60 });
      if (m.unit !== undefined) ms.unit = normalizeUnit(v.str(m.unit, 'unit', { max: 20 }));
      if (m.better !== undefined) ms.better = v.oneOf(m.better, 'better', ['lower', 'higher', 'none']);
      if (m.min_value !== undefined || m.max_value !== undefined) [ms.min_value, ms.max_value] = rangeInput({ min_value: m.min_value !== undefined ? m.min_value : cur.min_value, max_value: m.max_value !== undefined ? m.max_value : cur.max_value });
      for (const k of Object.keys(ms)) if (ms[k] === cur[k]) delete ms[k];
      if (t.builtin && ('name' in ms || 'unit' in ms || 'better' in ms)) throw badRequest('Built-in tests keep their numbers, units and scoring. Add your own test if you need a different one.');
      if (used && ('unit' in ms || 'better' in ms)) throw badRequest(`${t.name} already has results in ${cur.unit}, so its unit and scoring can't change. Add a new test instead.`);
      // A range that saved results fall outside would make uploads reject real numbers like them.
      const lo = 'min_value' in ms ? ms.min_value : cur.min_value, hi = 'max_value' in ms ? ms.max_value : cur.max_value;
      if (('min_value' in ms || 'max_value' in ms) && lo != null && hi != null) {
        const out = ctx.db.get('SELECT COUNT(*) AS n, MIN(value) AS lo, MAX(value) AS hi FROM perf_results WHERE test_id = ? AND metric = ? AND voided = 0 AND (value < ? OR value > ?)', t.id, cur.key, lo, hi);
        if (out.n) throw badRequest(`${out.n} saved ${out.n === 1 ? 'result is' : 'results are'} outside ${lo}–${hi} ${cur.unit} for ${cur.name} (${out.lo === out.hi ? out.lo : `${out.lo} to ${out.hi}`}). Widen the range, or remove those results if they're mistakes.`);
      }
      if (Object.keys(ms).length) { metricSets.push([cur.key, ms]); changes.push(...Object.keys(ms).map((k) => (k.endsWith('_value') ? 'range' : `metric ${k}`))); }
    }
  }
  if (body.timed !== undefined) {
    const headUnit = metricSets.find(([k]) => k === t.metrics[0].key)?.[1].unit ?? t.metrics[0].unit;
    if (body.timed && headUnit !== 's') throw badRequest('Only tests measured in seconds can use the stopwatch.');
    change('timed', body.timed ? 1 : 0);
  }
  const uniq = [...new Set(changes)];
  if (!uniq.length) return { ...t, changes: [] };
  // On a built-in test, a field set back to the library's own value follows future library updates again.
  const lib = t.builtin ? TESTS.find((x) => x.key === t.key) : null;
  const libValue = lib ? { name: lib.name, category: lib.category, attempts: lib.attempts, description: lib.desc ?? null, timed: lib.timed ? 1 : 0 } : {};
  const edited = [...new Set([...JSON.parse(row.edited ?? '[]'), ...(t.builtin ? Object.keys(set).filter((k) => k in libValue) : [])])].filter((k) => !(k in set) || set[k] !== libValue[k]);
  ctx.db.tx(() => {
    const cols = Object.keys(set);
    if (cols.length) ctx.db.run(`UPDATE perf_tests SET ${cols.map((c) => `${c} = ?`).join(', ')}, edited = ? WHERE id = ?`, ...cols.map((c) => set[c]), JSON.stringify(edited), t.id);
    for (const [key, ms] of metricSets) ctx.db.run(`UPDATE perf_metrics SET ${Object.keys(ms).map((c) => `${c} = ?`).join(', ')} WHERE test_id = ? AND key = ?`, ...Object.values(ms), t.id, key);
  });
  return { ...getTest(ctx, t.id), changes: uniq };
}

// ---------- Athletes: one profile per athlete ----------
// Team roster athletes are clients too (version 37), so every result, link and testing day athlete is a client.
// A roster_id sent by an older integration means that roster line's client.
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const athleteIdOf = (ctx, a) => (a.client_id ? ctx.db.get('SELECT athlete_id FROM clients WHERE id = ?', a.client_id)?.athlete_id : undefined);
const athleteName = (ctx, a) => (a.client_id ? ctx.db.get('SELECT name FROM clients WHERE id = ?', a.client_id)?.name : undefined);
// Finds who a result belongs to. Only certain identifiers count: our Athlete ID (in any field),
// our internal IDs, or a device ID the coach linked by hand. Names are never guessed; anything
// else waits in the queue for the coach.
export const identityOf = (ref = {}) => (ref.external_id != null && ref.external_id !== '' ? `id:${String(ref.external_id)}` : ref.name ? `name:${norm(ref.name)}` : ref.email ? `email:${String(ref.email).toLowerCase()}` : 'unknown');
export function resolveAthlete(ctx, ref = {}, provider) {
  const byId = findByAthleteId(ctx, ref.athlete_id) ?? findByAthleteId(ctx, ref.external_id) ?? findByAthleteId(ctx, ref.name);
  if (byId) return byId;
  if (ref.athlete_id) return null;
  if (ref.client_id) return ctx.db.get('SELECT id FROM clients WHERE id = ?', ref.client_id) ? { client_id: ref.client_id } : null;
  if (ref.roster_id) { const c = clientOfRoster(ctx, ref.roster_id); return c ? { client_id: c } : null; }
  if (provider) {
    const l = ctx.db.get('SELECT client_id, roster_id FROM athlete_links WHERE provider = ? AND external_id = ?', provider, identityOf(ref).replace(/^id:/, ''));
    const c = l ? l.client_id ?? clientOfRoster(ctx, l.roster_id) : null;
    if (c) return { client_id: c };
  }
  return null;
}
// Puts a result in the waiting queue. A retry of the same device result doesn't add a second copy.
export function enqueue(ctx, { provider, source, ref, item, sessionId }, created = null) {
  if (item.external_id) {
    const dup = ctx.db.get(`SELECT id FROM results_queue WHERE source = ? AND json_extract(item, '$.external_id') = ? AND status != 'discarded'`, source, item.external_id);
    if (dup) return dup.id;
  }
  const id = newId('q');
  const clean = Object.fromEntries(Object.entries({ external_id: ref.external_id ?? null, name: ref.name ?? null, email: ref.email ?? null, athlete_id: ref.athlete_id ?? null }).filter(([, x]) => x != null && x !== ''));
  ctx.db.run('INSERT INTO results_queue (id, provider, source, identity, athlete_ref, item, session_id, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, provider, source, identityOf(ref), JSON.stringify(clean), JSON.stringify(item), sessionId ?? null, 'pending', ctx.now());
  created?.push(id);                   // only the ones this call added (a retry returns the one already waiting)
  return id;
}

export function linkAthlete(ctx, body) {
  const provider = v.str(body.provider, 'provider', { max: 40 }).toLowerCase(), ext = v.str(String(body.external_id ?? ''), 'external_id', { max: 200 });
  const target = body.client_id || body.roster_id ? resolveAthlete(ctx, { client_id: body.client_id, roster_id: body.client_id ? undefined : body.roster_id }) : null;
  if (!target) throw badRequest('Choose the athlete to link.');
  ctx.db.run(`INSERT INTO athlete_links (provider, external_id, external_name, client_id, roster_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)
              ON CONFLICT(provider, external_id) DO UPDATE SET client_id = excluded.client_id, roster_id = NULL, external_name = COALESCE(excluded.external_name, athlete_links.external_name)`,
    provider, ext, body.external_name ?? null, target.client_id, ctx.now());
  return { provider, external_id: ext, ...target, name: athleteName(ctx, target) };
}
// Everyone results can go to: clients who aren't archived (team roster athletes included), with their Athlete ID and
// the active teams they're on. No money.
export function listAthletes(ctx) {
  return ctx.db.all(`SELECT c.id AS client_id, c.name, c.athlete_id, (SELECT group_concat(o.name || ' ' || t.name, '; ') FROM team_roster r JOIN team_contracts t ON t.id = r.contract_id
      JOIN organizations o ON o.id = t.org_id WHERE r.client_id = c.id AND r.active = 1 AND t.status = 'active') AS team
    FROM clients c WHERE c.archived_at IS NULL`)
    .map((a) => Object.fromEntries(Object.entries(a).filter(([, x]) => x != null))).sort((a, b) => a.name.localeCompare(b.name));
}
export function listLinks(ctx, { provider, client_id, roster_id } = {}) {
  const where = [], p = [];
  if (provider) { where.push('l.provider = ?'); p.push(provider); }
  if (client_id) { where.push('l.client_id = ?'); p.push(client_id); }
  if (roster_id) { where.push('l.client_id = ?'); p.push(clientOfRoster(ctx, roster_id)); }
  return ctx.db.all(`SELECT l.*, c.name AS athlete_name, c.athlete_id, c.archived_at AS athlete_archived_at FROM athlete_links l LEFT JOIN clients c ON c.id = l.client_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.provider, l.external_name`, ...p);
}
// Returns what was removed, so the screen can offer Undo (linking it again).
export function unlinkAthlete(ctx, provider, externalId) {
  const l = ctx.db.get('SELECT * FROM athlete_links WHERE provider = ? AND external_id = ?', provider, externalId);
  if (!l) throw notFound('Link');
  ctx.db.run('DELETE FROM athlete_links WHERE provider = ? AND external_id = ?', provider, externalId);
  return { deleted: true, link: { provider: l.provider, external_id: l.external_id, external_name: l.external_name, client_id: l.client_id, roster_id: l.roster_id } };
}

// ---------- Recording results ----------
function parseWhen(x, fallback) {
  if (x == null || x === '') return fallback;
  if (typeof x === 'number' || /^\d{9,13}$/.test(String(x))) { const n = Number(x); return new Date(n < 1e12 ? n * 1000 : n).toISOString(); }
  const s = String(x).trim();
  if (isDate(s)) return `${s}T12:00:00.000Z`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(.*)$/);           // 10/05/2026 or 10/5/26 3:15 PM
  const t = Date.parse(us ? `${us[3].length === 2 ? '20' + us[3] : us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}${us[4] ? ' ' + us[4].trim() : ''}` : s);
  if (Number.isNaN(t)) throw badRequest(`Can't read the date "${s}".`);
  return new Date(t).toISOString();
}

// Record one or many results. Each item: athlete (athlete_id, client_id, roster_id, email, external_id or name),
// test (key), metric (defaults to the headline metric), value, unit, side, attempt, recorded_at,
// timing, device, external_id. Partial success: bad items are reported, good ones are saved.
export function recordResults(ctx, items, { source = 'api', provider = null, sessionId = null, defaultWhen, queue = true, internal = false } = {}) {
  if (!Array.isArray(items) || !items.length) throw badRequest('Send at least one result.');
  if (items.length > MAX_BATCH && !internal) throw badRequest(`Send up to ${MAX_BATCH} results at a time.`);   // internal: an upload saved in one go
  if (provider) provider = String(provider).trim().toLowerCase();   // device links are saved in lower case, so "Swift" and "swift" are one sender
  if (sessionId) getSession(ctx, sessionId);
  const out = { created: [], duplicates: 0, unmatched: [], errors: [], prs: [], newQueued: [] };
  const tests = new Map();
  const touched = new Set();
  const prevBest = new Map();          // each athlete's best from before this batch, so a PR is always measured against what was there
  ctx.db.tx(() => {
    items.forEach((raw, index) => {
      try {
        const test = tests.get(raw.test) ?? getTest(ctx, v.str(raw.test, 'test', { max: 80 }));
        tests.set(raw.test, test);
        const metric = raw.metric ? test.metrics.find((m) => m.key === raw.metric) : test.metrics[0];
        if (!metric) throw badRequest(`${test.name} has no metric "${raw.metric}". Metrics: ${test.metrics.map((m) => m.key).join(', ')}.`);
        const athleteRef = raw.athlete ?? { athlete_id: raw.athlete_id, client_id: raw.client_id, roster_id: raw.roster_id, email: raw.email, external_id: raw.athlete_external_id, name: raw.athlete_name };
        const num = Number(typeof raw.value === 'string' ? raw.value.replace(/,/g, '') : raw.value);
        if (!Number.isFinite(num)) throw badRequest('value must be a number.');
        const enteredUnit = normalizeUnit(raw.unit) ?? metric.unit;
        const value = convert(num, enteredUnit, metric.unit);
        const range = rangeOf(test, metric);
        if (outOfRange(value, range)) throw badRequest(`${+value.toFixed(3)} ${metric.unit} isn't possible for ${test.name} (${rangeText(range, metric.unit)}).`);
        const side = raw.side == null || raw.side === '' ? null : String(raw.side).trim().toUpperCase()[0];
        if (side && !['L', 'R'].includes(side)) throw badRequest('side must be L or R.');
        if (side && test.sides !== 'lr') throw badRequest(`${test.name} isn't tested by side.`);
        const timing = raw.timing ? v.oneOf(raw.timing, 'timing', ['electronic', 'hand']) : null;
        const when = parseWhen(raw.recorded_at, defaultWhen ?? ctx.now());
        const externalId = raw.external_id != null ? String(raw.external_id).slice(0, 200) : null;
        const src = v.str(raw.source ?? source, 'source', { max: 40 });
        const who = resolveAthlete(ctx, athleteRef, provider);
        if (!who) {
          const queueId = queue ? enqueue(ctx, { provider: provider ?? 'api', source: src, ref: athleteRef, sessionId: raw.session_id ?? sessionId,
            item: { test: test.key, metric: metric.key, value, unit: metric.unit, side, attempt: raw.attempt ?? null, timing, recorded_at: when, device: raw.device ?? null, external_id: externalId, notes: raw.notes ?? null } }, out.newQueued) : null;
          out.unmatched.push({ index, athlete: athleteRef, queue_id: queueId });
          return;
        }
        if (externalId && ctx.db.get('SELECT id FROM perf_results WHERE source = ? AND external_id = ?', src, externalId)) { out.duplicates++; return; }
        // One value per attempt on a testing day: the same value again is a repeat (a double tap), a different one is refused.
        const slotSession = raw.session_id ?? sessionId, attemptNo = raw.attempt != null && raw.attempt !== '' ? Number(raw.attempt) : null;
        if (slotSession && attemptNo != null) {
          const taken = ctx.db.get(`SELECT value FROM perf_results WHERE session_id = ? AND client_id = ? AND test_id = ? AND metric = ? AND COALESCE(side, '') = ? AND attempt = ? AND voided = 0`,
            slotSession, who.client_id, test.id, metric.key, side ?? '', attemptNo);
          if (taken && Math.abs(taken.value - value) < 1e-9) { out.duplicates++; return; }
          if (taken) throw badRequest(`Attempt ${attemptNo} already has ${+taken.value.toFixed(metric.decimals + 1)} ${metric.unit}. Delete it first to enter a new value.`);
        }
        const pk = `${who.client_id}|${test.id}|${metric.key}|${side ?? ''}`;
        if (!prevBest.has(pk)) prevBest.set(pk, metric.better === 'none' ? null : ctx.db.get(
          `SELECT ${metric.better === 'lower' ? 'MIN' : 'MAX'}(value) AS best FROM perf_results WHERE client_id = ? AND test_id = ? AND metric = ? AND voided = 0 AND COALESCE(side, '') = ?`,
          who.client_id, test.id, metric.key, side ?? '').best);
        const prev = prevBest.get(pk);
        const id = newId('res');
        ctx.db.run(`INSERT INTO perf_results (id, session_id, client_id, roster_id, test_id, metric, side, attempt, value, entered_value, entered_unit, timing, source, device, external_id, notes, recorded_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, raw.session_id ?? sessionId, who.client_id, null, test.id, metric.key, side, raw.attempt != null ? v.int(raw.attempt, 'attempt', { min: 1, max: 50 }) : null,
          value, num, enteredUnit, timing, src, raw.device ? String(raw.device).slice(0, 80) : null, externalId, raw.notes ? String(raw.notes).slice(0, 500) : null, when, ctx.now());
        const isPr = prev != null && (metric.better === 'lower' ? value < prev : value > prev);
        const result = { id, index, ...who, test: test.key, metric: metric.key, side, value, unit: metric.unit, recorded_at: when, pr: isPr, first: prev == null && metric.better !== 'none' };
        out.created.push(result);
        touched.add(who.client_id);
        if (isPr) out.prs.push(result);
      } catch (e) {
        out.errors.push({ index, message: e.message });
      }
    });
    // Several improving attempts in one batch are one PR: keep the best per athlete, test, metric and side.
    const bestPr = new Map();
    for (const p of out.prs) {
      const k = `${p.client_id}|${p.test}|${p.metric}|${p.side ?? ''}`, cur = bestPr.get(k);
      const lower = tests.get(p.test).metrics.find((m) => m.key === p.metric).better === 'lower';
      if (!cur || (lower ? p.value < cur.value : p.value > cur.value)) bestPr.set(k, p);
    }
    for (const p of out.prs) if (bestPr.get(`${p.client_id}|${p.test}|${p.metric}|${p.side ?? ''}`) !== p) p.pr = false;
    out.prs = [...bestPr.values()];
    if (out.created.length) emit(ctx, 'results.recorded', { count: out.created.length, athletes: touched.size, source, session_id: sessionId });
    for (const pr of out.prs) emit(ctx, 'performance.pr', { client_id: pr.client_id, athlete_id: athleteIdOf(ctx, pr) ?? null, athlete_name: athleteName(ctx, pr), test: pr.test, test_name: tests.get(pr.test)?.name ?? pr.test, metric: pr.metric, value: pr.value, unit: pr.unit, side: pr.side });
  });
  return { created: out.created.length, duplicates: out.duplicates, queued: out.unmatched.filter((u) => u.queue_id).length, unmatched: out.unmatched, errors: out.errors, prs: out.prs, results: out.created, new_queue_ids: out.newQueued };
}

export function voidResult(ctx, id) {
  const r = ctx.db.run('UPDATE perf_results SET voided = 1 WHERE id = ?', id);
  if (!r.changes) throw notFound('Result');
  return { id, voided: true };
}

export function listResults(ctx, q = {}) {
  const where = ['r.voided = 0'], p = [];
  if (q.client_id) { where.push('r.client_id = ?'); p.push(q.client_id); }
  if (q.roster_id) { where.push('r.client_id = ?'); p.push(clientOfRoster(ctx, q.roster_id)); }
  if (q.session_id) { where.push('r.session_id = ?'); p.push(q.session_id); }
  if (q.test) { where.push('(t.key = ? OR t.id = ?)'); p.push(q.test, q.test); }
  if (q.source) { where.push('r.source = ?'); p.push(q.source); }
  if (q.from) { where.push('r.recorded_at >= ?'); p.push(q.from); }
  if (q.to) { where.push('r.recorded_at < ?'); p.push(q.to); }
  return ctx.db.all(`SELECT r.id, r.session_id, r.client_id, r.roster_id, c.athlete_id, c.name AS athlete_name, t.key AS test, t.name AS test_name, r.metric, m.name AS metric_name, m.unit,
      r.side, r.attempt, r.value, r.entered_value, r.entered_unit, r.timing, r.source, r.device, r.external_id, r.notes, r.recorded_at
    FROM perf_results r JOIN perf_tests t ON t.id = r.test_id JOIN perf_metrics m ON m.test_id = r.test_id AND m.key = r.metric
    LEFT JOIN clients c ON c.id = r.client_id
    WHERE ${where.join(' AND ')} ORDER BY r.recorded_at DESC, r.created_at DESC LIMIT ?`, ...p, Math.min(Number(q.limit) || 500, 5000));
}

// Everything an athlete has been tested on: headline metric per test with best, first, latest and history.
// from / to (YYYY-MM-DD, checked by the caller) limit it to a period.
export function athleteProfile(ctx, ref, { parentView = false, from = null, to = null } = {}) {
  const who = resolveAthlete(ctx, { client_id: ref.client_id, roster_id: ref.client_id ? undefined : ref.roster_id });
  if (!who) throw notFound('Athlete');
  const col = 'client_id', id = who.client_id;
  const rows = ctx.db.all(`SELECT r.*, t.key AS test_key, t.name AS test_name, t.category, m.name AS metric_name, m.unit, m.better, m.decimals, m.sort AS msort
    FROM perf_results r JOIN perf_tests t ON t.id = r.test_id JOIN perf_metrics m ON m.test_id = r.test_id AND m.key = r.metric
    WHERE r.${col} = ? AND r.voided = 0 ${parentView ? parentFilter(ctx) : ''} ${from ? 'AND substr(r.recorded_at, 1, 10) >= ?' : ''} ${to ? 'AND substr(r.recorded_at, 1, 10) <= ?' : ''}
    ORDER BY r.recorded_at`, id, ...(from ? [from] : []), ...(to ? [to] : []));
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.test_key}|${r.metric}|${r.side ?? ''}`;
    if (!groups.has(k)) groups.set(k, { test: r.test_key, test_name: r.test_name, category: r.category, metric: r.metric, metric_name: r.metric_name, unit: r.unit, better: r.better, decimals: r.decimals, side: r.side, headline: r.msort === 0, rows: [] });
    groups.get(k).rows.push(r);
  }
  const pick = (g, vals) => (g.better === 'lower' ? Math.min(...vals) : Math.max(...vals));
  return [...groups.values()].map((g) => {
    // One point per day: the day's best attempt (or the last reading for body measures).
    const byDay = new Map();
    for (const r of g.rows) { const d = r.recorded_at.slice(0, 10); byDay.set(d, [...(byDay.get(d) ?? []), r]); }
    const history = [...byDay.entries()].map(([date, rs]) => {
      const value = g.better === 'none' ? rs[rs.length - 1].value : pick(g, rs.map((r) => r.value));
      return { date, value, hand_timed: rs.some((r) => r.timing === 'hand' && r.value === value) };
    });
    const best = g.better === 'none' ? null : pick(g, history.map((h) => h.value));
    const first = history[0], latest = history[history.length - 1];
    return { ...g, rows: undefined, tests_count: history.length, first, latest, best, best_date: best == null ? null : history.find((h) => h.value === best).date,
      change: history.length > 1 ? latest.value - first.value : null,
      improved: history.length > 1 && g.better !== 'none' ? (g.better === 'lower' ? latest.value < first.value : latest.value > first.value) : null, history };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.test_name.localeCompare(b.test_name) || (b.headline - a.headline));
}

// Parents see results from testing days the coach has shared, or everything if the business chose that.
export function parentFilter(ctx) {
  const all = ctx.db.get(`SELECT value FROM settings WHERE key = 'share_results'`)?.value === 'all';
  return all ? '' : 'AND r.session_id IN (SELECT id FROM perf_sessions WHERE shared_at IS NOT NULL)';
}

// ---------- Testing days ----------
const whoKey = (a) => ({ client_id: a.client_id });
const sameAthlete = (a, b) => !!a.client_id && a.client_id === b.client_id;
// A testing day's planned athletes, as profiles (a {roster_id} left from before version 37 is that line's client).
const plannedOf = (ctx, s) => {
  const out = [];
  for (const a of JSON.parse(s.athletes)) {
    const c = a.client_id ?? clientOfRoster(ctx, a.roster_id);
    if (c && !out.some((x) => x.client_id === c)) out.push({ client_id: c });
  }
  return out;
};
const isArchived = (ctx, a) => !!(a.client_id && ctx.db.get('SELECT archived_at FROM clients WHERE id = ?', a.client_id)?.archived_at);
const needsConfirm = (message, details) => { const e = new HttpError(409, 'confirmation_required', message); e.details = details; return e; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A new day: tests and athletes, or a team's roster, or the same athletes and tests as a past day (retest_of).
// Archived clients are left out; left_out says how many.
export function createSession(ctx, body) {
  const date = body.date ?? localDate(ctx.now(), getSetting(ctx, 'timezone'));
  if (!isDate(date)) throw badRequest('Pick a real date, like 2026-10-05.');
  const past = body.retest_of ? getSession(ctx, body.retest_of) : null;
  const tests = (body.tests ?? past?.tests.map((t) => t.key) ?? []).map((k) => getTest(ctx, k).key);
  let athletes = (body.athletes ?? past?.athletes.filter((a) => a.name !== 'Removed athlete').map(whoKey) ?? []).map((a) => resolveAthlete(ctx, a)).filter(Boolean);
  // A retest of a team's day leaves out athletes who have since come off that team.
  if (past?.contract_id && !body.athletes) athletes = athletes.filter((a) => !ctx.db.get('SELECT 1 FROM team_roster WHERE contract_id = ? AND client_id = ? AND active = 0', past.contract_id, a.client_id)
    || ctx.db.get('SELECT 1 FROM team_roster WHERE contract_id = ? AND client_id = ? AND active = 1', past.contract_id, a.client_id));
  const contractId = body.contract_id ?? (past && !body.athletes ? past.contract_id : null);
  if (contractId) {
    if (!ctx.db.get('SELECT id FROM team_contracts WHERE id = ?', contractId)) throw notFound('Team contract');
    if (!athletes.length) athletes = ctx.db.all(`SELECT DISTINCT r.client_id FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.contract_id = ? AND r.active = 1 ORDER BY c.name`, contractId).map((r) => ({ client_id: r.client_id }));
  }
  const unique = [];
  for (const a of athletes) if (!unique.some((x) => sameAthlete(x, a))) unique.push(whoKey(a));
  const kept = unique.filter((a) => !isArchived(ctx, a));
  const id = newId('tsn');
  const name = String(body.name ?? '').trim() || (past ? `${past.name} retest` : 'Testing day');
  ctx.db.run('INSERT INTO perf_sessions (id, name, date, location_id, contract_id, test_keys, athletes, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, v.str(name, 'name', { max: 120 }), date, body.location_id ?? null, contractId ?? null, JSON.stringify([...new Set(tests)]), JSON.stringify(kept), v.str(body.notes, 'notes', { max: 2000, optional: true }), ctx.now());
  return { ...getSession(ctx, id), left_out: unique.length - kept.length };
}

// Rename, re-date, change tests or athletes. Taking off a test or an athlete that has results on this day
// deletes those results, so it needs confirm: true (409 confirmation_required with the count otherwise).
export function updateSession(ctx, id, body) {
  const s = getSession(ctx, id);
  if (body.date !== undefined && !isDate(body.date)) throw badRequest('Pick a real date, like 2026-10-05.');
  if (body.name !== undefined && !String(body.name ?? '').trim()) throw badRequest('Give the testing day a name.');
  if (body.tests !== undefined && !Array.isArray(body.tests)) throw badRequest('tests must be a list of test keys.');
  if (body.athletes !== undefined && !Array.isArray(body.athletes)) throw badRequest('athletes must be a list.');
  const tests = body.tests !== undefined ? [...new Set(body.tests.map((k) => getTest(ctx, k).key))] : s.tests.map((t) => t.key);
  if (body.tests !== undefined && !tests.length) throw badRequest('A testing day needs at least one test. Add another before removing this one.');
  const planned = plannedOf(ctx, ctx.db.get('SELECT athletes FROM perf_sessions WHERE id = ?', id));
  const athletes = body.athletes !== undefined ? body.athletes.map((a) => resolveAthlete(ctx, a)).filter(Boolean).map(whoKey) : planned;
  if (body.athletes !== undefined) {
    const archived = athletes.find((a) => !s.athletes.some((x) => sameAthlete(x, a)) && isArchived(ctx, a));
    if (archived) throw badRequest(`${athleteName(ctx, archived)} is archived. Restore their profile first.`);
  }
  const goneTests = s.tests.filter((t) => !tests.includes(t.key));
  const goneAthletes = body.athletes !== undefined ? s.athletes.filter((a) => !athletes.some((x) => sameAthlete(x, a))) : [];
  const doomed = new Set([
    ...goneTests.flatMap((t) => ctx.db.all('SELECT id FROM perf_results WHERE session_id = ? AND test_id = ? AND voided = 0', id, t.id)),
    ...goneAthletes.flatMap((a) => ctx.db.all('SELECT id FROM perf_results WHERE session_id = ? AND client_id = ? AND voided = 0', id, a.client_id))
  ].map((r) => r.id));
  if (doomed.size && body.confirm !== true) throw needsConfirm(`${plural(doomed.size, 'result')} on this day would be deleted from every profile. Confirm to go ahead.`, { results: doomed.size, tests: goneTests.map((t) => t.name), athletes: goneAthletes.map((a) => a.name) });
  ctx.db.tx(() => {
    // Set-aside (voided) results of what's removed go too, so nothing comes back later.
    for (const t of goneTests) ctx.db.run('DELETE FROM perf_results WHERE session_id = ? AND test_id = ?', id, t.id);
    for (const a of goneAthletes) ctx.db.run('DELETE FROM perf_results WHERE session_id = ? AND client_id = ?', id, a.client_id);
    ctx.db.run('UPDATE perf_sessions SET name = ?, date = ?, notes = ?, test_keys = ?, athletes = ? WHERE id = ?',
      body.name !== undefined ? v.str(String(body.name).trim(), 'name', { max: 120 }) : s.name, body.date ?? s.date,
      body.notes !== undefined ? v.str(body.notes, 'notes', { max: 2000, optional: true }) : s.notes, JSON.stringify(tests), JSON.stringify(athletes), id);
  });
  return { ...getSession(ctx, id), deleted_results: doomed.size };
}

// Walk-ups: anyone can add an athlete on the day (front desk too). Archived clients are refused.
export function addSessionAthlete(ctx, id, body = {}) {
  const s = getSession(ctx, id);
  const who = body.athlete_id ? findByAthleteId(ctx, body.athlete_id) : resolveAthlete(ctx, { client_id: body.client_id, roster_id: body.roster_id });
  if (!who) throw badRequest(body.athlete_id ? `No athlete has the ID ${String(body.athlete_id).toUpperCase()}.` : 'Pick an athlete to add.');
  if (isArchived(ctx, who)) throw badRequest(`${athleteName(ctx, who)} is archived. Restore their profile first.`);
  if (s.athletes.some((a) => sameAthlete(a, who))) return getSession(ctx, id);
  const planned = plannedOf(ctx, ctx.db.get('SELECT athletes FROM perf_sessions WHERE id = ?', id));
  ctx.db.run('UPDATE perf_sessions SET athletes = ? WHERE id = ?', JSON.stringify([...planned, whoKey(who)]), id);
  return getSession(ctx, id);
}
// Take off an athlete added by mistake. Their results on this day go too, so that needs confirm.
export function removeSessionAthlete(ctx, id, athleteRef, { confirm = false } = {}) {
  const s = getSession(ctx, id);
  const ref = clientOfRoster(ctx, athleteRef) ?? athleteRef;   // a client id, or a roster line (that line's client)
  const a = s.athletes.find((x) => x.client_id === ref);
  if (!a) throw notFound('That athlete on this day');
  const n = ctx.db.get('SELECT COUNT(*) AS n FROM perf_results WHERE session_id = ? AND client_id = ? AND voided = 0', id, a.client_id).n;
  if (n && !confirm) throw needsConfirm(`${a.name} has ${plural(n, 'result')} on this day. Removing ${a.name.split(' ')[0]} deletes ${n === 1 ? 'it' : 'them'}.`, { results: n });
  const planned = plannedOf(ctx, ctx.db.get('SELECT athletes FROM perf_sessions WHERE id = ?', id)).filter((x) => !sameAthlete(x, a));
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM perf_results WHERE session_id = ? AND client_id = ?', id, a.client_id);
    ctx.db.run('UPDATE perf_sessions SET athletes = ? WHERE id = ?', JSON.stringify(planned), id);
  });
  return { removed: true, name: a.name, deleted_results: n };
}
// Delete a day made by mistake, with its results. Families already have a shared day's results, so only the owner may.
export function deleteSession(ctx, id, { confirm = false, role = 'owner' } = {}) {
  const s = getSession(ctx, id);
  if (s.shared_at && role !== 'owner') throw new HttpError(403, 'forbidden', 'Families already have these results. Only the owner can delete a shared testing day.');
  const n = ctx.db.get('SELECT COUNT(*) AS n FROM perf_results WHERE session_id = ? AND voided = 0', id).n;
  if (n && !confirm) throw needsConfirm(`${s.name} has ${plural(n, 'result')}. Deleting the day deletes ${n === 1 ? 'it' : 'them'} from every profile.`, { results: n });
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM perf_results WHERE session_id = ?', id);
    ctx.db.run('DELETE FROM perf_sessions WHERE id = ?', id);
  });
  return { deleted: true, name: s.name, deleted_results: n };
}

// Progress of a day: athlete-and-test pairs with a result, out of every pair planned.
function dayProgress(ctx, s, athletesCount) {
  const keys = JSON.parse(s.test_keys);
  if (!keys.length) return { done: 0, planned: 0 };
  const done = ctx.db.get(`SELECT COUNT(DISTINCT r.client_id || '|' || t.key) AS n FROM perf_results r JOIN perf_tests t ON t.id = r.test_id
    WHERE r.session_id = ? AND r.voided = 0 AND t.key IN (${keys.map(() => '?').join(',')})`, s.id, ...keys).n;
  return { done, planned: athletesCount * keys.length };
}
export function listSessions(ctx) {
  return ctx.db.all(`SELECT s.*, (SELECT COUNT(*) FROM perf_results r WHERE r.session_id = s.id AND r.voided = 0) AS results_count
    FROM perf_sessions s ORDER BY s.date DESC, s.created_at DESC LIMIT 200`)
    .map((s) => {
      const planned = plannedOf(ctx, s);
      // Athletes with results who weren't planned are on the day too.
      const extra = ctx.db.all('SELECT DISTINCT client_id FROM perf_results WHERE session_id = ? AND voided = 0 AND client_id IS NOT NULL', s.id).filter((r) => !planned.some((a) => sameAthlete(a, r))).length;
      const athletesCount = planned.length + extra;
      return { id: s.id, name: s.name, date: s.date, location_id: s.location_id, contract_id: s.contract_id, team_name: s.contract_id ? teamName(ctx, s.contract_id) : null, notes: s.notes, shared_at: s.shared_at, created_at: s.created_at,
        results_count: s.results_count, tests: JSON.parse(s.test_keys), athletes_count: athletesCount, progress: dayProgress(ctx, s, athletesCount), status: s.shared_at ? 'shared' : 'open' };
    });
}
const teamName = (ctx, contractId) => {
  const t = ctx.db.get('SELECT * FROM team_contracts WHERE id = ?', contractId);
  if (!t) return null;
  const org = ctx.db.get('SELECT name FROM organizations WHERE id = ?', t.org_id)?.name;
  return [org, t.name].filter(Boolean).join(' ');
};

// Each athlete's best from before this day, per test, metric and side ("dash_40yd|time|" → 5.02).
function previousBests(ctx, s, tests) {
  const keys = tests.map((t) => t.key);
  if (!keys.length) return new Map();
  const rows = ctx.db.all(`SELECT r.client_id, t.key AS test, r.metric, COALESCE(r.side, '') AS side, MIN(r.value) AS lo, MAX(r.value) AS hi
    FROM perf_results r JOIN perf_tests t ON t.id = r.test_id LEFT JOIN perf_sessions os ON os.id = r.session_id
    WHERE r.voided = 0 AND (r.session_id IS NULL OR r.session_id != ?) AND COALESCE(os.date, substr(r.recorded_at, 1, 10)) <= ? AND t.key IN (${keys.map(() => '?').join(',')})
    GROUP BY r.client_id, t.key, r.metric, COALESCE(r.side, '')`, s.id, s.date, ...keys);
  const better = new Map(tests.flatMap((t) => t.metrics.map((m) => [`${t.key}|${m.key}`, m.better])));
  const out = new Map();
  for (const r of rows) {
    const b = better.get(`${r.test}|${r.metric}`);
    if (!b || b === 'none') continue;
    const k = r.client_id;
    if (!out.has(k)) out.set(k, {});
    out.get(k)[`${r.test}|${r.metric}|${r.side}`] = b === 'lower' ? r.lo : r.hi;
  }
  return out;
}
export function getSession(ctx, id) {
  const s = ctx.db.get('SELECT * FROM perf_sessions WHERE id = ?', id);
  if (!s) throw notFound('Testing day');
  const results = ctx.db.all('SELECT * FROM perf_results WHERE session_id = ? AND voided = 0 ORDER BY recorded_at, created_at', id);
  const expected = plannedOf(ctx, s);
  // Anyone with results today is on the sheet, even if they weren't planned.
  for (const r of results) {
    const key = { client_id: r.client_id };
    if (r.client_id && !expected.some((a) => sameAthlete(a, key))) expected.push(key);
  }
  const tests = JSON.parse(s.test_keys).map((k) => getTest(ctx, k));
  const prev = previousBests(ctx, s, tests);
  const since = s.notified_at ?? s.shared_at;
  const athletes = expected.map((a) => ({ ...a, name: athleteName(ctx, a) ?? 'Removed athlete', athlete_id: athleteIdOf(ctx, a), archived: isArchived(ctx, a),
    previous_best: prev.get(a.client_id) ?? {},
    results: results.filter((r) => r.client_id === a.client_id).map((r) => ({ id: r.id, test_id: r.test_id, metric: r.metric, side: r.side, attempt: r.attempt, value: r.value, timing: r.timing, source: r.source, created_at: r.created_at })) }))
    .sort((x, y) => x.name.localeCompare(y.name));
  const newSince = s.shared_at ? athletes.filter((a) => a.results.some((r) => r.created_at > since)).length : 0;
  return { id: s.id, name: s.name, date: s.date, location_id: s.location_id, contract_id: s.contract_id, notes: s.notes, shared_at: s.shared_at, notified_at: s.notified_at ?? null, parent_note: s.parent_note, created_at: s.created_at,
    status: s.shared_at ? 'shared' : 'open', new_since_share: newSince, tests, athletes };
}

// Who sharing reaches: athletes with and without results, the families that will be emailed, and anyone with
// no parent email. After sharing, who has results added since families were last emailed.
export function sharePreview(ctx, id) {
  const s = getSession(ctx, id);
  const since = s.notified_at ?? s.shared_at;
  const rows = s.athletes.map((a) => {
    const c = a.client_id ? ctx.db.get('SELECT family_id, archived_at FROM clients WHERE id = ?', a.client_id) : null;
    const emails = c?.family_id ? ctx.db.get(`SELECT COUNT(*) AS n FROM guardians WHERE family_id = ? AND email IS NOT NULL AND email != ''`, c.family_id).n : 0;
    return { name: a.name, family_id: c?.family_id ?? null, archived: !!c?.archived_at, results: a.results.length, fresh: !!s.shared_at && a.results.some((r) => r.created_at > since), emails };
  });
  const withResults = rows.filter((r) => r.results);
  const reach = withResults.filter((r) => r.emails && !r.archived);
  const fresh = withResults.filter((r) => r.fresh);
  return {
    shared: !!s.shared_at, shared_at: s.shared_at, notified_at: s.notified_at ?? null,
    athletes: rows.length, with_results: withResults.length,
    without_results: rows.filter((r) => !r.results).map((r) => r.name),
    families: new Set(reach.map((r) => r.family_id)).size,
    no_email: withResults.filter((r) => !r.emails || r.archived).map((r) => r.name),
    new_since_share: fresh.map((r) => r.name),
    new_families: new Set(fresh.filter((r) => r.emails && !r.archived).map((r) => r.family_id)).size
  };
}
export const resultExternalId = (...parts) => sha256(parts.map((p) => String(p ?? '')).join('|')).slice(0, 40);
