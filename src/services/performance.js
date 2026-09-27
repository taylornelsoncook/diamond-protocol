import { newId, v, notFound, badRequest, conflict, isDate, sha256 } from '../util.js';
import { emit } from './events.js';
import { TESTS, CATEGORIES } from './test-library.js';
import { convert, normalizeUnit, compatibleUnits } from './units.js';
import { findByAthleteId } from './athlete-ids.js';

export { CATEGORIES };
const MAX_BATCH = 1000;

// ---------- Test library ----------
// Adds any built-in tests that are missing and refreshes their definitions. Coach choices
// (active/inactive) and custom tests are left alone.
export function syncLibrary(ctx) {
  const now = new Date().toISOString();
  ctx.db.tx(() => {
    TESTS.forEach((t, i) => {
      const row = ctx.db.get('SELECT id FROM perf_tests WHERE key = ?', t.key);
      const id = row?.id ?? newId('pt');
      if (row) ctx.db.run('UPDATE perf_tests SET name = ?, category = ?, description = ?, sides = ?, attempts = ?, timed = ?, sports = ?, aliases = ?, sort = ? WHERE id = ? AND builtin = 1',
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
    metrics: metrics.map((m) => ({ key: m.key, name: m.name, unit: m.unit, better: m.better, decimals: m.decimals, aliases: JSON.parse(m.aliases), units: compatibleUnits(m.unit) })) };
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
// Your own tests: a sport-specific drill, a different distance, anything.
export function createTest(ctx, body) {
  const name = v.str(body.name, 'name', { max: 80 });
  const key = (body.key ? v.str(body.key, 'key', { max: 40 }) : name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!key) throw badRequest('Give the test a name.');
  if (ctx.db.get('SELECT id FROM perf_tests WHERE key = ?', key)) throw conflict(`A test with key "${key}" already exists.`);
  const metrics = Array.isArray(body.metrics) && body.metrics.length ? body.metrics : [{ key: 'value', name: body.metric_name ?? 'Result', unit: body.unit, better: body.better }];
  const cat = v.oneOf(body.category ?? 'sport', 'category', CATEGORIES.map((c) => c[0]));
  const id = newId('pt');
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO perf_tests (id, key, name, category, description, sides, attempts, timed, sports, aliases, builtin, active, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1000, ?)',
      id, key, name, cat, v.str(body.description, 'description', { max: 1000, optional: true }), v.oneOf(body.sides ?? 'none', 'sides', ['none', 'lr']),
      v.int(body.attempts ?? 2, 'attempts', { min: 1, max: 10 }), body.timed ? 1 : 0, JSON.stringify(body.sports ?? []), JSON.stringify(body.aliases ?? []), ctx.now());
    metrics.forEach((m, j) => {
      const mk = String(m.key ?? m.name ?? 'value').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `m${j}`;
      ctx.db.run('INSERT INTO perf_metrics (test_id, key, name, unit, better, decimals, aliases, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, mk, v.str(m.name ?? 'Result', 'metric name', { max: 60 }),
        normalizeUnit(v.str(m.unit, 'unit', { max: 20 })), v.oneOf(m.better ?? 'higher', 'better', ['lower', 'higher', 'none']), v.int(m.decimals ?? 2, 'decimals', { min: 0, max: 4 }), JSON.stringify(m.aliases ?? []), j);
    });
  });
  return getTest(ctx, id);
}
export function updateTest(ctx, keyOrId, body) {
  const t = getTest(ctx, keyOrId);
  ctx.db.run('UPDATE perf_tests SET name = ?, description = ?, attempts = ?, active = ? WHERE id = ?',
    body.name !== undefined ? v.str(body.name, 'name', { max: 80 }) : t.name, body.description !== undefined ? v.str(body.description, 'description', { max: 1000, optional: true }) : t.description,
    body.attempts !== undefined ? v.int(body.attempts, 'attempts', { min: 1, max: 10 }) : t.attempts, body.active !== undefined ? (body.active ? 1 : 0) : (t.active ? 1 : 0), t.id);
  return getTest(ctx, t.id);
}

// ---------- Athletes: clients and team roster players ----------
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
function athleteIdOf(ctx, a) {
  return a.client_id ? ctx.db.get('SELECT athlete_id FROM clients WHERE id = ?', a.client_id)?.athlete_id : ctx.db.get('SELECT athlete_id FROM team_roster WHERE id = ?', a.roster_id)?.athlete_id;
}
function athleteName(ctx, a) {
  return a.client_id ? ctx.db.get('SELECT name FROM clients WHERE id = ?', a.client_id)?.name : ctx.db.get('SELECT name FROM team_roster WHERE id = ?', a.roster_id)?.name;
}
// Finds who a result belongs to. Only certain identifiers count: our Athlete ID (in any field),
// our internal IDs, or a device ID the coach linked by hand. Names are never guessed; anything
// else waits in the queue for the coach.
export const identityOf = (ref = {}) => (ref.external_id != null && ref.external_id !== '' ? `id:${String(ref.external_id)}` : ref.name ? `name:${norm(ref.name)}` : ref.email ? `email:${String(ref.email).toLowerCase()}` : 'unknown');
export function resolveAthlete(ctx, ref = {}, provider) {
  const byId = findByAthleteId(ctx, ref.athlete_id) ?? findByAthleteId(ctx, ref.external_id) ?? findByAthleteId(ctx, ref.name);
  if (byId) return byId;
  if (ref.athlete_id) return null;
  if (ref.client_id) return ctx.db.get('SELECT id FROM clients WHERE id = ?', ref.client_id) ? { client_id: ref.client_id } : null;
  if (ref.roster_id) return ctx.db.get('SELECT id FROM team_roster WHERE id = ?', ref.roster_id) ? { roster_id: ref.roster_id } : null;
  if (provider) {
    const l = ctx.db.get('SELECT client_id, roster_id FROM athlete_links WHERE provider = ? AND external_id = ?', provider, identityOf(ref).replace(/^id:/, ''));
    if (l) return l.client_id ? { client_id: l.client_id } : { roster_id: l.roster_id };
  }
  return null;
}
// Puts a result in the waiting queue. A retry of the same device result doesn't add a second copy.
export function enqueue(ctx, { provider, source, ref, item, sessionId }) {
  if (item.external_id) {
    const dup = ctx.db.get(`SELECT id FROM results_queue WHERE source = ? AND json_extract(item, '$.external_id') = ? AND status != 'discarded'`, source, item.external_id);
    if (dup) return dup.id;
  }
  const id = newId('q');
  const clean = Object.fromEntries(Object.entries({ external_id: ref.external_id ?? null, name: ref.name ?? null, email: ref.email ?? null, athlete_id: ref.athlete_id ?? null }).filter(([, x]) => x != null && x !== ''));
  ctx.db.run('INSERT INTO results_queue (id, provider, source, identity, athlete_ref, item, session_id, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, provider, source, identityOf(ref), JSON.stringify(clean), JSON.stringify(item), sessionId ?? null, 'pending', ctx.now());
  return id;
}

export function linkAthlete(ctx, body) {
  const provider = v.str(body.provider, 'provider', { max: 40 }).toLowerCase(), ext = v.str(String(body.external_id ?? ''), 'external_id', { max: 200 });
  const target = body.client_id ? { client_id: body.client_id } : body.roster_id ? { roster_id: body.roster_id } : null;
  if (!target || !resolveAthlete(ctx, target)) throw badRequest('Choose a client or roster athlete to link.');
  ctx.db.run(`INSERT INTO athlete_links (provider, external_id, external_name, client_id, roster_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(provider, external_id) DO UPDATE SET client_id = excluded.client_id, roster_id = excluded.roster_id, external_name = COALESCE(excluded.external_name, athlete_links.external_name)`,
    provider, ext, body.external_name ?? null, target.client_id ?? null, target.roster_id ?? null, ctx.now());
  return { provider, external_id: ext, ...target, name: athleteName(ctx, target) };
}
export function listLinks(ctx, { provider, client_id, roster_id } = {}) {
  const where = [], p = [];
  if (provider) { where.push('l.provider = ?'); p.push(provider); }
  if (client_id) { where.push('l.client_id = ?'); p.push(client_id); }
  if (roster_id) { where.push('l.roster_id = ?'); p.push(roster_id); }
  return ctx.db.all(`SELECT l.*, COALESCE(c.name, r.name) AS athlete_name, COALESCE(c.athlete_id, r.athlete_id) AS athlete_id FROM athlete_links l LEFT JOIN clients c ON c.id = l.client_id LEFT JOIN team_roster r ON r.id = l.roster_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.provider, l.external_name`, ...p);
}
export function unlinkAthlete(ctx, provider, externalId) {
  const r = ctx.db.run('DELETE FROM athlete_links WHERE provider = ? AND external_id = ?', provider, externalId);
  if (!r.changes) throw notFound('Link');
  return { deleted: true };
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

// Record one or many results. Each item: athlete (client_id, roster_id, email, external_id or name),
// test (key), metric (defaults to the headline metric), value, unit, side, attempt, recorded_at,
// timing, device, external_id. Partial success: bad items are reported, good ones are saved.
export function recordResults(ctx, items, { source = 'api', provider = null, sessionId = null, defaultWhen, queue = true } = {}) {
  if (!Array.isArray(items) || !items.length) throw badRequest('Send at least one result.');
  if (items.length > MAX_BATCH) throw badRequest(`Send up to ${MAX_BATCH} results at a time.`);
  if (sessionId) getSession(ctx, sessionId);
  const out = { created: [], duplicates: 0, unmatched: [], errors: [], prs: [] };
  const tests = new Map();
  const touched = new Set();
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
            item: { test: test.key, metric: metric.key, value, unit: metric.unit, side, attempt: raw.attempt ?? null, timing, recorded_at: when, device: raw.device ?? null, external_id: externalId, notes: raw.notes ?? null } }) : null;
          out.unmatched.push({ index, athlete: athleteRef, queue_id: queueId });
          return;
        }
        if (externalId && ctx.db.get('SELECT id FROM perf_results WHERE source = ? AND external_id = ?', src, externalId)) { out.duplicates++; return; }
        const prev = metric.better === 'none' ? null : ctx.db.get(
          `SELECT ${metric.better === 'lower' ? 'MIN' : 'MAX'}(value) AS best FROM perf_results WHERE ${who.client_id ? 'client_id' : 'roster_id'} = ? AND test_id = ? AND metric = ? AND voided = 0 AND COALESCE(side, '') = ?`,
          who.client_id ?? who.roster_id, test.id, metric.key, side ?? '').best;
        const id = newId('res');
        ctx.db.run(`INSERT INTO perf_results (id, session_id, client_id, roster_id, test_id, metric, side, attempt, value, entered_value, entered_unit, timing, source, device, external_id, notes, recorded_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, raw.session_id ?? sessionId, who.client_id ?? null, who.roster_id ?? null, test.id, metric.key, side, raw.attempt != null ? v.int(raw.attempt, 'attempt', { min: 1, max: 50 }) : null,
          value, num, enteredUnit, timing, src, raw.device ? String(raw.device).slice(0, 80) : null, externalId, raw.notes ? String(raw.notes).slice(0, 500) : null, when, ctx.now());
        const isPr = prev != null && (metric.better === 'lower' ? value < prev : value > prev);
        const result = { id, index, ...who, test: test.key, metric: metric.key, side, value, unit: metric.unit, recorded_at: when, pr: isPr, first: prev == null && metric.better !== 'none' };
        out.created.push(result);
        touched.add(who.client_id ?? who.roster_id);
        if (isPr) out.prs.push(result);
      } catch (e) {
        out.errors.push({ index, message: e.message });
      }
    });
    // Several improving attempts in one batch are one PR: keep the best per athlete, test, metric and side.
    const bestPr = new Map();
    for (const p of out.prs) {
      const k = `${p.client_id ?? p.roster_id}|${p.test}|${p.metric}|${p.side ?? ''}`, cur = bestPr.get(k);
      const lower = tests.get(p.test).metrics.find((m) => m.key === p.metric).better === 'lower';
      if (!cur || (lower ? p.value < cur.value : p.value > cur.value)) bestPr.set(k, p);
    }
    for (const p of out.prs) if (bestPr.get(`${p.client_id ?? p.roster_id}|${p.test}|${p.metric}|${p.side ?? ''}`) !== p) p.pr = false;
    out.prs = [...bestPr.values()];
    if (out.created.length) emit(ctx, 'results.recorded', { count: out.created.length, athletes: touched.size, source, session_id: sessionId });
    for (const pr of out.prs) emit(ctx, 'performance.pr', { client_id: pr.client_id ?? null, roster_id: pr.roster_id ?? null, athlete_name: athleteName(ctx, pr), test: pr.test, test_name: tests.get(pr.test)?.name ?? pr.test, metric: pr.metric, value: pr.value, unit: pr.unit, side: pr.side });
  });
  return { created: out.created.length, duplicates: out.duplicates, queued: out.unmatched.filter((u) => u.queue_id).length, unmatched: out.unmatched, errors: out.errors, prs: out.prs, results: out.created };
}

export function voidResult(ctx, id) {
  const r = ctx.db.run('UPDATE perf_results SET voided = 1 WHERE id = ?', id);
  if (!r.changes) throw notFound('Result');
  return { id, voided: true };
}

export function listResults(ctx, q = {}) {
  const where = ['r.voided = 0'], p = [];
  if (q.client_id) { where.push('r.client_id = ?'); p.push(q.client_id); }
  if (q.roster_id) { where.push('r.roster_id = ?'); p.push(q.roster_id); }
  if (q.session_id) { where.push('r.session_id = ?'); p.push(q.session_id); }
  if (q.test) { where.push('(t.key = ? OR t.id = ?)'); p.push(q.test, q.test); }
  if (q.source) { where.push('r.source = ?'); p.push(q.source); }
  if (q.from) { where.push('r.recorded_at >= ?'); p.push(q.from); }
  if (q.to) { where.push('r.recorded_at < ?'); p.push(q.to); }
  return ctx.db.all(`SELECT r.id, r.session_id, r.client_id, r.roster_id, COALESCE(c.athlete_id, tr.athlete_id) AS athlete_id, COALESCE(c.name, tr.name) AS athlete_name, t.key AS test, t.name AS test_name, r.metric, m.name AS metric_name, m.unit,
      r.side, r.attempt, r.value, r.entered_value, r.entered_unit, r.timing, r.source, r.device, r.external_id, r.notes, r.recorded_at
    FROM perf_results r JOIN perf_tests t ON t.id = r.test_id JOIN perf_metrics m ON m.test_id = r.test_id AND m.key = r.metric
    LEFT JOIN clients c ON c.id = r.client_id LEFT JOIN team_roster tr ON tr.id = r.roster_id
    WHERE ${where.join(' AND ')} ORDER BY r.recorded_at DESC, r.created_at DESC LIMIT ?`, ...p, Math.min(Number(q.limit) || 500, 5000));
}

// Everything an athlete has been tested on: headline metric per test with best, first, latest and history.
export function athleteProfile(ctx, who, { parentView = false } = {}) {
  const col = who.client_id ? 'client_id' : 'roster_id', id = who.client_id ?? who.roster_id;
  if (!resolveAthlete(ctx, who)) throw notFound('Athlete');
  const rows = ctx.db.all(`SELECT r.*, t.key AS test_key, t.name AS test_name, t.category, m.name AS metric_name, m.unit, m.better, m.decimals, m.sort AS msort
    FROM perf_results r JOIN perf_tests t ON t.id = r.test_id JOIN perf_metrics m ON m.test_id = r.test_id AND m.key = r.metric
    WHERE r.${col} = ? AND r.voided = 0 ${parentView ? parentFilter(ctx) : ''} ORDER BY r.recorded_at`, id);
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
export function createSession(ctx, body) {
  const date = body.date ?? ctx.now().slice(0, 10);
  if (!isDate(date)) throw badRequest('date must look like 2026-10-05.');
  const tests = (body.tests ?? []).map((k) => getTest(ctx, k).key);
  let athletes = (body.athletes ?? []).map((a) => resolveAthlete(ctx, a)).filter(Boolean);
  if (body.contract_id) {
    if (!ctx.db.get('SELECT id FROM team_contracts WHERE id = ?', body.contract_id)) throw notFound('Team contract');
    if (!athletes.length) athletes = ctx.db.all('SELECT id FROM team_roster WHERE contract_id = ? AND active = 1 ORDER BY name', body.contract_id).map((r) => ({ roster_id: r.id }));
  }
  const id = newId('tsn');
  ctx.db.run('INSERT INTO perf_sessions (id, name, date, location_id, contract_id, test_keys, athletes, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, v.str(body.name ?? 'Testing day', 'name', { max: 120 }), date, body.location_id ?? null, body.contract_id ?? null, JSON.stringify(tests), JSON.stringify(athletes), v.str(body.notes, 'notes', { max: 2000, optional: true }), ctx.now());
  return getSession(ctx, id);
}
export function updateSession(ctx, id, body) {
  const s = getSession(ctx, id);
  const tests = body.tests !== undefined ? body.tests.map((k) => getTest(ctx, k).key) : s.tests.map((t) => t.key);
  const athletes = body.athletes !== undefined ? body.athletes.map((a) => resolveAthlete(ctx, a)).filter(Boolean) : s.athletes.map(({ client_id, roster_id }) => (client_id ? { client_id } : { roster_id }));
  ctx.db.run('UPDATE perf_sessions SET name = ?, date = ?, notes = ?, test_keys = ?, athletes = ? WHERE id = ?',
    body.name !== undefined ? v.str(body.name, 'name', { max: 120 }) : s.name, body.date !== undefined && isDate(body.date) ? body.date : s.date,
    body.notes !== undefined ? v.str(body.notes, 'notes', { max: 2000, optional: true }) : s.notes, JSON.stringify(tests), JSON.stringify(athletes), id);
  return getSession(ctx, id);
}
export function listSessions(ctx) {
  return ctx.db.all(`SELECT s.*, (SELECT COUNT(*) FROM perf_results r WHERE r.session_id = s.id AND r.voided = 0) AS results_count FROM perf_sessions s ORDER BY s.date DESC, s.created_at DESC LIMIT 200`)
    .map((s) => ({ ...s, tests: JSON.parse(s.test_keys), athletes_count: JSON.parse(s.athletes).length, test_keys: undefined, athletes: undefined }));
}
export function getSession(ctx, id) {
  const s = ctx.db.get('SELECT * FROM perf_sessions WHERE id = ?', id);
  if (!s) throw notFound('Testing day');
  const results = ctx.db.all('SELECT * FROM perf_results WHERE session_id = ? AND voided = 0 ORDER BY recorded_at, created_at', id);
  const expected = JSON.parse(s.athletes);
  // Anyone with results today is on the sheet, even if they weren't planned.
  for (const r of results) {
    const key = r.client_id ? { client_id: r.client_id } : { roster_id: r.roster_id };
    if (!expected.some((a) => (a.client_id && a.client_id === key.client_id) || (a.roster_id && a.roster_id === key.roster_id))) expected.push(key);
  }
  const athletes = expected.map((a) => ({ ...a, name: athleteName(ctx, a) ?? 'Removed athlete', athlete_id: athleteIdOf(ctx, a),
    results: results.filter((r) => (a.client_id ? r.client_id === a.client_id : r.roster_id === a.roster_id)).map((r) => ({ id: r.id, test_id: r.test_id, metric: r.metric, side: r.side, attempt: r.attempt, value: r.value, timing: r.timing, source: r.source })) }))
    .sort((x, y) => x.name.localeCompare(y.name));
  const tests = JSON.parse(s.test_keys).map((k) => getTest(ctx, k));
  return { id: s.id, name: s.name, date: s.date, location_id: s.location_id, contract_id: s.contract_id, notes: s.notes, shared_at: s.shared_at, parent_note: s.parent_note, created_at: s.created_at, tests, athletes };
}
export const resultExternalId = (...parts) => sha256(parts.map((p) => String(p ?? '')).join('|')).slice(0, 40);
