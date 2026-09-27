import { newId, v, badRequest, notFound, conflict } from '../util.js';
import { emit } from './events.js';
import { listTests, getTest, recordResults, resultExternalId, resolveAthlete, enqueue } from './performance.js';
import { unitFromHeader, normalizeUnit } from './units.js';

// Systems we know by name. Any other system works too: pick "Other" and match the columns once.
export const PROVIDERS = {
  ovr: { name: 'OVR Performance (Jump, Sprint, Velocity)', how: 'file', note: 'In OVR Connect, tap the profile tab and export your history, then upload the file here.' },
  hawkin: { name: 'Hawkin Dynamics force plates', how: 'live', note: 'Connect once with an integration token from Hawkin (Settings → Integrations). New tests sync every 15 minutes.' },
  vald: { name: 'VALD (ForceDecks, SmartSpeed, NordBord)', how: 'file', note: 'Export results from VALD Hub and upload them here. For a live connection, VALD issues API credentials on request to support@vald.com.' },
  swift: { name: 'Swift Performance timing gates', how: 'file' },
  freelap: { name: 'Freelap timing', how: 'file' },
  brower: { name: 'Brower timing gates', how: 'file' },
  dashr: { name: 'Dashr timing', how: 'file' },
  just_jump: { name: 'Just Jump / jump mats', how: 'file' },
  rapsodo: { name: 'Rapsodo', how: 'file' },
  pocket_radar: { name: 'Pocket Radar / radar guns', how: 'file' },
  generic: { name: 'Other system or spreadsheet', how: 'file' }
};

// ---------- CSV ----------
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (rows.length < 2) throw badRequest('The file needs a header row and at least one row of results.');
  const headers = rows[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  return { headers, rows: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

// ---------- Column matching ----------
const clean = (h) => String(h).replace(/[([][^()[\]]*[)\]]\s*$/, '').toLowerCase().replace(/[_\-–]+/g, ' ').replace(/[^a-z0-9%/ .]/g, '').replace(/\s+/g, ' ').trim();
const ROLES = [
  ['athlete_id', /^(athlete|profile|player|user|external|hub athlete)\s?id$|^id athlete$/],
  ['first_name', /^first\s?name$|^given name$/], ['last_name', /^last\s?name$|^surname$|^family name$/],
  ['athlete_name', /^(athlete|name|full name|athlete name|player|player name|profile|profile name|user|user name)$/],
  ['email', /^e?mail$/],
  ['date', /^(date|test date|date time|datetime|timestamp|recorded|recorded (utc|at|date)|session date|created|created at|day)$/],
  ['time_of_day', /^(time of day|test time|clock time)$/],
  ['test', /^(test|test type|test name|testtype|exercise|drill|mode|type|protocol)$/],
  ['side', /^(side|limb|leg|direction|start side)$/],
  ['attempt', /^(trial|attempt|rep number|trial number|attempt number|rep #|trial #)$/],
  ['value', /^(value|result|score|measurement)$/], ['unit', /^units?$/],
  ['device', /^(device|device name|serial|system)$/], ['notes', /^(notes?|comments?)$/], ['result_id', /^(test id|trial id|result id|record id|recording id)$/]
];
const SIDE_SUFFIX = /\s(left|right|l|r)$|^(left|right|l|r)\s/;

function testIndex(ctx) {
  return listTests(ctx, { includeInactive: true }).map((t) => ({ t, names: [t.key.replace(/_/g, ' '), clean(t.name), ...t.aliases.map(clean)] }));
}
// Best guess for one metric column. Returns { test?, metric, unit, side? } or null.
function guessColumn(index, header, testKey) {
  const unit = unitFromHeader(header);
  let h = clean(header), side;
  const sm = h.match(SIDE_SUFFIX);
  if (sm) { side = (sm[1] ?? sm[2])[0].toUpperCase(); h = h.replace(SIDE_SUFFIX, '').trim(); }
  const candidates = testKey ? index.filter((x) => x.t.key === testKey) : index;
  for (const { t, names } of candidates) {
    for (const m of t.metrics) {
      const mNames = [m.key.replace(/_/g, ' '), clean(m.name), ...m.aliases.map(clean)];
      if (mNames.includes(h)) return { test: testKey ? undefined : t.key, metric: m.key, unit: unit ?? m.unit, side: t.sides === 'lr' ? side : undefined };
    }
    if (!testKey && names.includes(h)) return { test: t.key, metric: t.metrics[0].key, unit: unit ?? t.metrics[0].unit, side: t.sides === 'lr' ? side : undefined };
  }
  return null;
}
export function guessTest(index, name) {
  const n = clean(name);
  if (!n) return null;
  const exact = index.find((x) => x.names.includes(n));
  if (exact) return exact.t.key;
  // Force plate software names: "Countermovement Jump", "CMJ Rebound", "Isometric Test", "Drop Jump"…
  const rules = [[/rebound/, 'cmrj'], [/single.?leg|\bsl\b/, 'sl_cmj'], [/counter ?movement|\bcmj\b/, 'cmj'], [/squat jump|\bsj\b/, 'squat_jump'], [/drop jump|\bdj\b|depth jump/, 'drop_jump'],
    [/mid.?thigh|imtp/, 'imtp'], [/isometric squat|iso squat/, 'iso_squat'], [/isometric/, 'imtp'], [/10.?5|hop test|multi rebound/, 'hop_10_5'], [/vertical/, 'vertical_standing'],
    [/broad|long jump/, 'broad_jump'], [/5.?10.?5|pro agility|short shuttle/, 'pro_agility'], [/40/, 'dash_40yd'], [/flying/, 'flying_10yd'], [/velocity|vbt|bench/, 'bench_velocity']];
  return rules.find(([re]) => re.test(n))?.[1] ?? null;
}

export function guessMapping(ctx, headers, rows, { test } = {}) {
  const index = testIndex(ctx);
  const m = { roles: {}, columns: {}, tests: {}, test: test ?? null };
  for (const h of headers) {
    const c = clean(h);
    const role = ROLES.find(([, re]) => re.test(c));
    if (role && !m.roles[role[0]]) { m.roles[role[0]] = h; continue; }
  }
  const numeric = (h) => rows.slice(0, 25).some((r) => r[h] !== '' && Number.isFinite(Number(String(r[h]).replace(/,/g, ''))));
  for (const h of headers) {
    if (Object.values(m.roles).includes(h) || !numeric(h)) { if (!Object.values(m.roles).includes(h)) m.columns[h] = null; continue; }
    if (test) m.columns[h] = guessColumn(index, h, test);                        // the whole file is one test
    else if (m.roles.test) {                                                     // each row names its test; match the metric per row
      const g = guessColumn(index, h, null);
      m.columns[h] = g ? { metric_name: h, unit: unitFromHeader(h) ?? undefined, side: g.side } : null;
    } else m.columns[h] = guessColumn(index, h, null);                           // wide sheet: every column is its own test
  }
  if (m.roles.test) for (const name of [...new Set(rows.map((r) => r[m.roles.test]).filter(Boolean))].slice(0, 50)) m.tests[name] = guessTest(index, name);
  return m;
}

// Turns file rows into result items using a mapping. Rows name tests (long format) or columns do (wide format).
export function rowsToItems(ctx, rows, mapping, provider) {
  const index = testIndex(ctx);
  const items = [], problems = [];
  const seen = new Map();
  rows.forEach((row, i) => {
    const r = mapping.roles ?? {};
    const name = r.athlete_name ? row[r.athlete_name] : [row[r.first_name], row[r.last_name]].filter(Boolean).join(' ');
    const athlete = { name: name || undefined, external_id: r.athlete_id && row[r.athlete_id] ? row[r.athlete_id] : undefined, email: r.email ? row[r.email] || undefined : undefined };
    if (!athlete.name && !athlete.external_id && !athlete.email) {
      const hasData = Object.entries(mapping.columns ?? {}).some(([h, c]) => c && row[h] !== '' && row[h] != null);
      if (hasData) problems.push({ row: i + 2, message: 'Results with no athlete ID or name.' });
      return;
    }
    const when = r.date && row[r.date] ? `${row[r.date]}${r.time_of_day && row[r.time_of_day] ? ' ' + row[r.time_of_day] : ''}` : undefined;
    const rowTest = r.test ? (mapping.tests?.[row[r.test]] ?? null) : null;
    if (r.test && row[r.test] && !rowTest) { problems.push({ row: i + 2, message: `No test chosen for "${row[r.test]}".` }); return; }
    const rowSide = r.side && row[r.side] ? row[r.side] : undefined;
    const push = (test, metric, rawValue, unit, side, attempt) => {
      if (rawValue === '' || rawValue == null) return;
      const value = Number(String(rawValue).replace(/,/g, ''));
      if (!Number.isFinite(value)) return;
      const base = [provider, athlete.external_id ?? athlete.email ?? athlete.name, test, metric, side ?? '', when ?? '', value, attempt ?? ''];
      const k = base.join('|'); seen.set(k, (seen.get(k) ?? 0) + 1);
      items.push({ athlete, test, metric, value, unit, side: side ?? rowSide, recorded_at: when, attempt: attempt ?? (r.attempt && row[r.attempt] ? Number(row[r.attempt]) || undefined : undefined), notes: r.notes ? row[r.notes] || undefined : undefined,
        device: r.device ? row[r.device] || undefined : undefined, external_id: r.result_id && row[r.result_id] ? `${row[r.result_id]}:${metric}:${side ?? ''}` : resultExternalId(...base, seen.get(k)), _row: i + 2 });
    };
    if (r.value) {                                              // long format: one value per row
      const test = rowTest ?? mapping.test;
      if (!test) { problems.push({ row: i + 2, message: 'Choose which test this file contains.' }); return; }
      push(test, undefined, row[r.value], r.unit ? row[r.unit] : undefined);
      return;
    }
    for (const [h, col] of Object.entries(mapping.columns ?? {})) {
      if (!col) continue;
      const test = col.test ?? rowTest ?? mapping.test;
      if (!test) continue;
      let metric = col.metric;
      if (!metric && col.metric_name) {                         // metric depends on the row's test
        const g = guessColumn(index, col.metric_name, test);
        if (!g) continue;
        metric = g.metric;
      }
      push(test, metric, row[h], col.unit ?? unitFromHeader(h), col.side, col.attempt);
    }
  });
  return { items, problems };
}

// Import a file. Rows whose athlete we can't identify wait in the batch until the coach matches them.
export function importFile(ctx, body, user = null) {
  const provider = v.oneOf(body.provider ?? 'generic', 'provider', Object.keys(PROVIDERS));
  const { headers, rows } = parseCsv(v.str(body.csv, 'csv', { max: 20_000_000 }));
  if (rows.length > 20000) throw badRequest('Import up to 20,000 rows at a time.');
  const saved = savedMapping(ctx, provider, headers);
  const mapping = body.mapping ?? saved ?? guessMapping(ctx, headers, rows, { test: body.test });
  if (body.test && !mapping.test) mapping.test = getTest(ctx, body.test).key;
  const { items, problems } = rowsToItems(ctx, rows, mapping, provider);
  if (body.dry_run) {
    const unmatched = new Map();
    const preview = items.slice(0, 20).map(({ _row, ...i }) => i);
    for (const it of items) {
      const key = it.athlete.external_id ?? it.athlete.email ?? it.athlete.name;
      if (!unmatched.has(key) && !previewResolve(ctx, it.athlete, provider)) unmatched.set(key, it.athlete);
    }
    return { headers, mapping, rows: rows.length, results_found: items.length, preview, unmatched_athletes: [...unmatched.values()].slice(0, 200), problems: problems.slice(0, 50), saved_mapping: !!saved };
  }
  if (body.remember !== false) saveMapping(ctx, provider, headers, mapping);
  const out = items.length ? chunked(ctx, items, { provider, sessionId: body.session_id }) : { created: 0, duplicates: 0, unmatched: [], errors: [], prs: [], results: [], newQueued: [] };
  const pending = out.unmatched.map((u) => u.queue_id).filter(Boolean);
  const id = newId('imp');
  // Recorded result by result (and waiting result by waiting result) so the import can be undone.
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO import_batches (id, provider, filename, total_rows, imported, duplicates, pending, errors, created_at, kind, result_source, session_id, prs, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)`,
      id, provider, body.filename ? String(body.filename).slice(0, 200) : null, rows.length, out.created, out.duplicates, JSON.stringify(pending),
      JSON.stringify([...problems, ...out.errors.map((e) => ({ row: items[e.index]?._row, message: e.message }))].slice(0, 500)), ctx.now(), sourceFor(provider), body.session_id ?? null, out.prs.length, user?.id ?? null);
    for (const r of out.results) ctx.db.run('INSERT INTO import_batch_items (batch_id, result_id, value) VALUES (?, ?, ?)', id, r.id, r.value);
    for (const q of new Set(out.newQueued)) ctx.db.run('INSERT INTO import_batch_items (batch_id, queue_id) VALUES (?, ?)', id, q);
  });
  return getBatch(ctx, id, { prs: out.prs.length });
}
function previewResolve(ctx, athlete, provider) { return !!resolveAthlete(ctx, athlete, provider); }
const sourceFor = (provider) => (provider === 'hawkin' ? 'hawkin' : `csv:${provider}`);
function chunked(ctx, items, { provider, sessionId, source = sourceFor(provider) }) {
  const total = { created: 0, duplicates: 0, unmatched: [], errors: [], prs: [], results: [], newQueued: [] };
  for (let i = 0; i < items.length; i += 1000) {
    const part = items.slice(i, i + 1000).map(({ _row, ...it }) => it);
    const r = recordResults(ctx, part, { source, provider, sessionId });
    total.created += r.created; total.duplicates += r.duplicates; total.prs.push(...r.prs); total.results.push(...r.results); total.newQueued.push(...r.new_queue_ids);
    total.unmatched.push(...r.unmatched.map((u) => ({ ...u, index: u.index + i })));
    total.errors.push(...r.errors.map((e) => ({ ...e, index: e.index + i })));
  }
  return total;
}

export function getBatch(ctx, id, extra = {}) {
  const b = ctx.db.get('SELECT * FROM import_batches WHERE id = ?', id);
  if (!b) throw notFound('Import');
  const ids = JSON.parse(b.pending).filter((x) => typeof x === 'string');
  const waiting = ids.length ? ctx.db.all(`SELECT athlete_ref FROM results_queue WHERE status = 'pending' AND id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  const athletes = new Map();
  for (const w of waiting) { const a = JSON.parse(w.athlete_ref); const k = a.external_id ?? a.name ?? a.email; if (!athletes.has(k)) athletes.set(k, { ...a, results: 0 }); athletes.get(k).results++; }
  return { id: b.id, provider: b.provider, provider_name: PROVIDERS[b.provider]?.name ?? b.provider, filename: b.filename, total_rows: b.total_rows, imported: b.imported, duplicates: b.duplicates,
    queued: ids.length, pending_results: waiting.length, unmatched_athletes: [...athletes.values()], errors: JSON.parse(b.errors), created_at: b.created_at, ...extra };
}
export function listBatches(ctx) { return ctx.db.all('SELECT id FROM import_batches ORDER BY created_at DESC LIMIT 30').map((b) => getBatch(ctx, b.id)); }

// Earlier versions kept unmatched rows inside the import; move them to the queue.
export function migratePending(ctx) {
  for (const b of ctx.db.all(`SELECT * FROM import_batches WHERE pending != '[]'`)) {
    const pending = JSON.parse(b.pending);
    if (!pending.some((x) => typeof x === 'object')) continue;
    const ids = pending.map((it) => {
      if (typeof it === 'string') return it;
      const m = getTest(ctx, it.test).metrics.find((x) => x.key === it.metric) ?? getTest(ctx, it.test).metrics[0];
      return enqueue(ctx, { provider: b.provider, source: b.provider === 'hawkin' ? 'hawkin' : `csv:${b.provider}`, ref: it.athlete ?? {}, sessionId: null,
        item: { test: it.test, metric: m.key, value: it.value, unit: it.unit ?? m.unit, side: it.side ?? null, attempt: it.attempt ?? null, recorded_at: it.recorded_at ?? b.created_at, device: it.device ?? null, external_id: it.external_id ?? null } });
    });
    ctx.db.run('UPDATE import_batches SET pending = ? WHERE id = ?', JSON.stringify(ids), b.id);
  }
}

// Mappings are remembered per system and header layout, so the next export imports in one step.
const layoutKey = (headers) => headers.map((h) => h.toLowerCase()).sort().join('|');
function savedMapping(ctx, provider, headers) {
  const cfg = JSON.parse(ctx.db.get('SELECT config FROM integrations WHERE provider = ?', provider)?.config ?? '{}');
  return cfg.mappings?.[layoutKey(headers)] ?? null;
}
function saveMapping(ctx, provider, headers, mapping) {
  const row = ctx.db.get('SELECT config FROM integrations WHERE provider = ?', provider);
  const cfg = JSON.parse(row?.config ?? '{}');
  cfg.mappings = { ...(cfg.mappings ?? {}), [layoutKey(headers)]: mapping };
  if (row) ctx.db.run('UPDATE integrations SET config = ? WHERE provider = ?', JSON.stringify(cfg), provider);
  else ctx.db.run(`INSERT INTO integrations (provider, config, status, created_at) VALUES (?, ?, 'file', ?)`, provider, JSON.stringify(cfg), ctx.now());
}

// ---------- Integrations ----------
export function listIntegrations(ctx) {
  const rows = ctx.db.all('SELECT * FROM integrations');
  return Object.entries(PROVIDERS).map(([key, p]) => {
    const r = rows.find((x) => x.provider === key);
    const cfg = JSON.parse(r?.config ?? '{}');
    return { provider: key, ...p, connected: key === 'hawkin' ? !!cfg.refresh_token : !!r, status: r?.status ?? null, region: cfg.region ?? null,
      token_hint: cfg.refresh_token ? `…${cfg.refresh_token.slice(-4)}` : null, saved_layouts: Object.keys(cfg.mappings ?? {}).length,
      last_sync_at: r?.last_sync_at ?? null, last_error: r?.last_error ?? null,
      linked_athletes: ctx.db.get('SELECT COUNT(*) AS n FROM athlete_links WHERE provider = ?', key).n };
  });
}

// ---------- Hawkin Dynamics (live) ----------
const HAWKIN_REGIONS = { americas: 'https://cloud.hawkindynamics.com', europe: 'https://eu.cloud.hawkindynamics.com', apac: 'https://apac.cloud.hawkindynamics.com' };

export async function connectHawkin(ctx, body) {
  const token = v.str(body.refresh_token, 'refresh_token', { max: 4000 });
  const region = v.oneOf(body.region ?? 'americas', 'region', Object.keys(HAWKIN_REGIONS));
  const base = ctx.hawkinBaseUrl ?? HAWKIN_REGIONS[region];
  await hawkinAccessToken(base, token);                                   // fails fast on a bad token
  const days = v.int(body.backfill_days ?? 90, 'backfill_days', { min: 0, max: 3650 });
  const cfg = { ...JSON.parse(ctx.db.get(`SELECT config FROM integrations WHERE provider = 'hawkin'`)?.config ?? '{}'), refresh_token: token, region };
  const cursor = String(Math.floor(Date.now() / 1000) - days * 86400);
  ctx.db.run(`INSERT INTO integrations (provider, config, status, sync_cursor, created_at) VALUES ('hawkin', ?, 'connected', ?, ?)
              ON CONFLICT(provider) DO UPDATE SET config = excluded.config, status = 'connected', sync_cursor = excluded.sync_cursor, last_error = NULL`, JSON.stringify(cfg), cursor, ctx.now());
  const sync = await syncHawkin(ctx);
  return { ...listIntegrations(ctx).find((i) => i.provider === 'hawkin'), sync };
}
export function disconnect(ctx, provider) {
  const row = ctx.db.get('SELECT config FROM integrations WHERE provider = ?', provider);
  if (!row) throw notFound('Integration');
  const cfg = JSON.parse(row.config); delete cfg.refresh_token;
  ctx.db.run(`UPDATE integrations SET config = ?, status = 'disconnected' WHERE provider = ?`, JSON.stringify(cfg), provider);
  ctx.db.run(`UPDATE integrations SET sync_cursor = NULL WHERE provider = ?`, provider);
  return listIntegrations(ctx).find((i) => i.provider === provider);
}
async function hawkinAccessToken(base, refresh) {
  const res = await fetch(`${base}/api/token`, { headers: { authorization: `Bearer ${refresh}` }, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw conflict(`Hawkin didn't accept that token (${res.status}). Create a new integration token in Hawkin under Settings → Integrations.`);
  return data.access_token;
}
// Pulls tests since the last sync. Test types map to our force plate tests; metric fields like
// "Jump Height(m)" map by name and convert units.
export async function syncHawkin(ctx) {
  const row = ctx.db.get(`SELECT * FROM integrations WHERE provider = 'hawkin'`);
  const cfg = JSON.parse(row?.config ?? '{}');
  if (!cfg.refresh_token) return { skipped: true };
  const base = ctx.hawkinBaseUrl ?? HAWKIN_REGIONS[cfg.region ?? 'americas'];
  try {
    const access = await hawkinAccessToken(base, cfg.refresh_token);
    const nowS = Math.floor(Date.now() / 1000);
    const res = await fetch(`${base}/api/v1?syncFrom=${row.sync_cursor ?? nowS - 90 * 86400}&syncTo=${nowS}`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(60000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Hawkin responded ${res.status}.`);
    const tests = Array.isArray(body.data) ? body.data : [];
    const index = testIndex(ctx);
    const items = [];
    const skippedTypes = new Set();
    for (const t of tests) {
      if (t.active === false) continue;
      const typeName = t.testType?.name ?? t.testType ?? '';
      const key = guessTest(index, typeName);
      if (!key || getTest(ctx, key).category !== 'force_plate') { skippedTypes.add(typeName); continue; }
      const athlete = { external_id: t.athlete?.id, name: t.athlete?.name };
      const when = typeof t.timestamp === 'number' ? new Date(t.timestamp * 1000).toISOString() : t.timestamp;
      for (const [field, value] of Object.entries(t)) {
        if (typeof value !== 'number' || ['timestamp'].includes(field)) continue;
        const g = guessColumn(index, field, key);
        if (!g) continue;
        items.push({ athlete, test: key, metric: g.metric, value, unit: g.unit, recorded_at: when, device: 'Hawkin Dynamics', external_id: `${t.id}:${g.metric}` });
      }
    }
    const out = items.length ? chunked(ctx, items, { provider: 'hawkin', sessionId: null }) : { created: 0, duplicates: 0, unmatched: [], errors: [], prs: [] };
    if (out.unmatched.length) {
      ctx.db.run('INSERT INTO import_batches (id, provider, filename, total_rows, imported, duplicates, pending, errors, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId('imp'), 'hawkin', 'Hawkin sync', tests.length, out.created, out.duplicates, JSON.stringify(out.unmatched.map((u) => u.queue_id).filter(Boolean)), '[]', ctx.now());
    }
    ctx.db.run(`UPDATE integrations SET sync_cursor = ?, last_sync_at = ?, last_error = NULL, status = 'connected' WHERE provider = 'hawkin'`, String(body.lastSyncTime ?? nowS), ctx.now());
    if (out.created) emit(ctx, 'integration.synced', { provider: 'hawkin', results: out.created });
    return { tests: tests.length, results: out.created, duplicates: out.duplicates, waiting_for_match: out.unmatched.length, skipped_test_types: [...skippedTypes] };
  } catch (e) {
    ctx.db.run(`UPDATE integrations SET last_error = ?, status = 'error' WHERE provider = 'hawkin'`, e.message);
    throw e;
  }
}
export async function syncAll(ctx) { try { await syncHawkin(ctx); } catch (e) { console.error('hawkin sync', e.message); } }
