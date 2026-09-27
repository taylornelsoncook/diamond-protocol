import { newId, v, badRequest, notFound, localDate } from '../util.js';
import { getSetting } from './families.js';
import { findByAthleteId } from './athlete-ids.js';
import { unitFromHeader } from './units.js';
import { listTests, getTest, getSession, recordResults, resultExternalId } from './performance.js';
import { parseCsv, guessMapping } from './perf-import.js';
import { convert, normalizeUnit } from './units.js';
import { readXlsx, writeXlsx } from './xlsx.js';

// ---------- Templates ----------
// One column per test (per side, per attempt), named so the upload reads it back exactly:
// "40-yard dash #1 (s)", "5-10-5 pro agility – Left #2 (s)", "Vertical jump (in)".
const shortName = (t) => t.name.replace(/\s*\(.*\)$/, '');
const UNIT = (u) => ({ ratio: 'ratio', level: 'level', reps: 'reps', points: 'points' }[u] ?? u);
function columnsFor(test, maxAttempts = 3) {
  const m = test.metrics[0];
  const sides = test.sides === 'lr' ? [['L', 'Left'], ['R', 'Right']] : [[null, null]];
  const n = Math.min(test.attempts, maxAttempts);
  const out = [];
  for (const [side, label] of sides) for (let a = 1; a <= n; a++) {
    out.push({ header: `${shortName(test)}${label ? ` – ${label}` : ''}${n > 1 ? ` #${a}` : ''} (${UNIT(m.unit)})`, test: test.key, metric: m.key, side: side ?? undefined, attempt: n > 1 ? a : undefined, unit: m.unit });
  }
  return out;
}
function templateIndex(ctx) {
  const map = new Map();
  for (const t of listTests(ctx, { includeInactive: true })) {
    for (const c of columnsFor(t, 10)) map.set(c.header.toLowerCase(), c);
    for (const c of columnsFor({ ...t, attempts: 1 })) map.set(c.header.toLowerCase(), c);   // single-attempt spelling too
  }
  return map;
}

function athletesFor(ctx, { session_id, contract_id, client_ids }) {
  if (session_id) return getSession(ctx, session_id).athletes.map((a) => ({ athlete_id: a.athlete_id, name: a.name }));
  if (contract_id) return ctx.db.all('SELECT athlete_id, name FROM team_roster WHERE contract_id = ? AND active = 1 ORDER BY name', contract_id);
  const ids = String(client_ids ?? '').split(',').filter(Boolean);
  if (ids.length) return ids.map((id) => ctx.db.get('SELECT athlete_id, name FROM clients WHERE id = ?', id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return [];
}

export function buildTemplate(ctx, q) {
  const session = q.session_id ? getSession(ctx, q.session_id) : null;
  const keys = q.tests ? String(q.tests).split(',').filter(Boolean) : session?.tests.map((t) => t.key) ?? [];
  if (!keys.length) throw badRequest('Choose at least one test for the template.');
  const tests = keys.map((k) => getTest(ctx, k));
  const cols = tests.flatMap((t) => columnsFor(t));
  const athletes = athletesFor(ctx, q);
  const header = ['Athlete ID', 'Name', 'Date', ...cols.map((c) => c.header), 'Notes'];
  const date = session?.date ?? q.date ?? '';
  const rows = [header, ...athletes.map((a) => [a.athlete_id, a.name, date, ...cols.map(() => ''), '']), ...Array.from({ length: athletes.length ? 5 : 25 }, () => ['', '', date])];
  const base = (session?.name ?? 'Testing').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'testing';
  if (q.format === 'csv') {
    const csv = rows.map((r) => r.map((x) => (/[",\n]/.test(String(x ?? '')) ? `"${String(x).replace(/"/g, '""')}"` : x ?? '')).join(',')).join('\r\n');
    return { filename: `${base}-template.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from('\uFEFF' + csv, 'utf8') };
  }
  const how = [['How to fill in this sheet'], [''],
    ['1. Keep the Athlete ID column. It\'s how each result finds the right athlete (Name is just for you).'],
    ['2. New athlete? Leave Athlete ID empty and type their full name. You\'ll match them on upload.'],
    ['3. Enter each attempt in its own column. Leave a cell empty if the athlete didn\'t do that test.'],
    ['4. Use the unit shown in brackets. Times in seconds (4.71), jumps in inches (28.5), broad jump in total inches (101).'],
    ['5. Dates look like 2026-10-05. Leave the Date empty to use the testing day\'s date.'],
    ['6. Save and upload it in Testing → Upload results. You\'ll review everything before it\'s saved.'],
    [''], ['Tests in this sheet'], ...tests.map((t) => [`${t.name}: ${t.description ?? ''}`.trim()])];
  return { filename: `${base}-template.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: writeXlsx([{ name: 'Results', rows, widths: [14, 22, 12, ...cols.map((c) => Math.max(12, Math.min(34, c.header.length + 2))), 24] }, { name: 'How to fill in', rows: how, widths: [110] }]) };
}

// ---------- Reading an upload ----------
export function readUpload(body) {
  if (body.xlsx_base64) {
    let rows;
    try { rows = readXlsx(Buffer.from(String(body.xlsx_base64), 'base64')); } catch (e) { throw badRequest(e.message); }
    rows = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
    if (rows.length < 2) throw badRequest('The sheet needs a header row and at least one row of results.');
    const headers = rows[0].map((h, i) => String(h).trim() || `Column ${i + 1}`);
    return { headers, rows: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()]))) };
  }
  return parseCsv(v.str(body.csv, 'file', { max: 20_000_000 }));
}

// Excel stores dates as day numbers (46300 = 2026-10-05).
export const excelDate = (x) => (/^\d{5}(\.\d+)?$/.test(String(x)) ? new Date(Date.UTC(1899, 11, 30) + Number(x) * 86400000).toISOString().slice(0, 10) : x);
const normName = (s) => { let n = String(s ?? '').trim(); if (n.includes(',')) { const [last, first] = n.split(',', 2); n = `${first} ${last}`; } return n.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); };
// A typed name matches the profile if it's the same name, or the same first and last name (middle names ignored).
function sameName(typed, profile) {
  const a = normName(typed), b = normName(profile);
  if (!a || a === b) return true;
  const x = a.split(' '), y = b.split(' ');
  return x.length > 1 && x[0] === y[0] && x[x.length - 1] === y[y.length - 1];
}
// Numbers as typed in a sheet: 4.71, "4,71", 8'5" for feet and inches.
function parseNumber(raw, unit) {
  const t = String(raw).trim().replace(/\s+/g, ' ');
  const fi = t.match(/^(\d+)\s*(?:'|′|ft)\s*(\d+(?:\.\d+)?)?\s*(?:"|″|in)?$/);
  if (fi && unit === 'in') return Number(fi[1]) * 12 + Number(fi[2] ?? 0);
  const n = /^-?\d+,\d+$/.test(t) ? Number(t.replace(',', '.')) : Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
const fmt = (v, unit, d = 2) => `${+Number(v).toFixed(d)}${unit && !['ratio', 'level', 'reps', 'points'].includes(unit) ? ` ${unit}` : ''}`;

// ---------- The checks ----------
// Every row must name a real athlete by ID, every column must be a known test, every value must be
// possible for that test. Any error blocks the whole upload. Unusual-but-possible values are warnings
// the coach must confirm one by one.
function checkUpload(ctx, { headers, rows, options }) {
  const errors = [], warnings = [];
  const err = (row, column, message, athlete) => errors.push({ row, column: column ?? null, athlete_id: athlete ?? null, message });
  const session = options.session_id ? getSession(ctx, options.session_id) : null;
  const tindex = templateIndex(ctx);
  const lower = headers.map((h) => h.trim().toLowerCase());
  lower.forEach((h, i) => { if (lower.indexOf(h) !== i) err(1, headers[i], `Two columns are named "${headers[i]}". Rename or remove one.`); });
  const find = (re) => headers.find((h) => re.test(h.trim().toLowerCase()));
  const roles = { id: find(/^(athlete id|dp id|athlete code)$/), name: find(/^(name|athlete|athlete name|full name|player)$/), date: find(/^(date|test date)$/), notes: find(/^(notes?|comments?)$/) };
  const idCol = roles.id ?? roles.name;                 // devices: the Athlete ID can be typed in as the name
  const fixedTest = options.test ? getTest(ctx, options.test) : null;
  const guessed = guessMapping(ctx, headers, rows.slice(0, 50), { test: options.test });
  const columns = {};
  for (const h of headers) {
    if (Object.values(roles).includes(h)) continue;
    const t = tindex.get(h.trim().toLowerCase());
    const g = guessed.columns[h];
    columns[h] = t ? { test: t.test, metric: t.metric, side: t.side, attempt: t.attempt, unit: t.unit }
      : g && !g.metric_name ? { test: g.test ?? fixedTest?.key, metric: g.metric, side: g.side, unit: unitFromHeader(h) ?? g.unit } : null;
    if (!columns[h] && rows.some((r) => String(r[h] ?? '').trim() !== '')) err(1, h, `"${h}" isn't a test column. Use the column names from the downloaded sheet, or delete this column.`);
  }
  if (!idCol) err(1, null, 'The sheet needs an "Athlete ID" column. Download the sheet from Upload results to get one with every ID filled in.');
  if (errors.length) return { errors, warnings, items: [], groups: [], session };

  const tests = new Map(), seen = new Map(), athleteCache = new Map(), bests = new Map();
  const today = localDate(ctx.now(), getSetting(ctx, 'timezone'));
  const items = [];
  rows.forEach((row, i) => {
    const rowNo = i + 2;
    const filled = Object.keys(columns).filter((h) => columns[h] && String(row[h] ?? '').trim() !== '');
    const rawId = String(row[idCol] ?? '').trim();
    if (!filled.length) return;                           // empty rows and rows with no results are fine
    if (!rawId) return err(rowNo, idCol, 'This row has results but no Athlete ID.');
    const who = findByAthleteId(ctx, rawId);
    if (!who) return err(rowNo, idCol, /^[A-Za-z]{6}\d{4}(-\d{1,3})?$/.test(rawId) ? `No athlete has the ID ${rawId.toUpperCase()}.` : `"${rawId}" isn't an Athlete ID (they look like AVALOP2026).`);
    const key = who.client_id ?? who.roster_id;
    if (!athleteCache.has(key)) athleteCache.set(key, who.client_id ? ctx.db.get('SELECT name, athlete_id FROM clients WHERE id = ?', key) : ctx.db.get('SELECT name, athlete_id FROM team_roster WHERE id = ?', key));
    const profile = athleteCache.get(key);
    if (roles.id && roles.name && row[roles.name] && !sameName(row[roles.name], profile.name)) return err(rowNo, roles.name, `${profile.athlete_id} is ${profile.name}, but this row says "${row[roles.name]}". Check the ID or the name.`, profile.athlete_id);
    let date = roles.date && row[roles.date] ? String(excelDate(row[roles.date])).trim() : null;
    if (date) {
      const us = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (us) date = `${us[3].length === 2 ? '20' + us[3] : us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return err(rowNo, roles.date, `"${row[roles.date]}" isn't a date. Use 2026-10-05.`, profile.athlete_id);
      if (date > today) return err(rowNo, roles.date, `${date} is in the future.`, profile.athlete_id);
      if (date < '2000-01-01') return err(rowNo, roles.date, `${date} is too far back.`, profile.athlete_id);
    }
    date = date ?? session?.date ?? options.date ?? today;
    const rowValues = [];
    for (const h of filled) {
      const col = columns[h];
      if (!col.test) { err(rowNo, h, `Choose which test "${h}" is.`, profile.athlete_id); continue; }
      const test = tests.get(col.test) ?? getTest(ctx, col.test); tests.set(col.test, test);
      const metric = test.metrics.find((m) => m.key === (col.metric ?? test.metrics[0].key));
      const unit = normalizeUnit(col.unit) ?? metric.unit;
      const num = parseNumber(row[h], unit);
      if (num == null) { err(rowNo, h, `"${row[h]}" isn't a number.`, profile.athlete_id); continue; }
      let value;
      try { value = convert(num, unit, metric.unit); } catch { err(rowNo, h, `${unit} can't be converted to ${metric.unit}.`, profile.athlete_id); continue; }
      const range = metric.range;                              // the coach's own range when set, otherwise the built-in one
      if (range && (value < range[0] || value > range[1])) { err(rowNo, h, `${fmt(num, unit, 3)} isn't possible for ${test.name} (${range[0]}–${range[1]} ${metric.unit}). Is it in the wrong column?`, profile.athlete_id); continue; }
      if (!range && metric.better !== 'none' && value <= 0) { err(rowNo, h, 'Must be more than zero.', profile.athlete_id); continue; }
      if (col.side && test.sides !== 'lr') { err(rowNo, h, `${test.name} isn't tested by side.`, profile.athlete_id); continue; }
      const dupKey = `${key}|${test.key}|${metric.key}|${col.side ?? ''}|${col.attempt ?? ''}|${date}`;
      if (seen.has(dupKey)) { err(rowNo, h, `Entered twice for ${profile.name} on ${date} (also row ${seen.get(dupKey)}).`, profile.athlete_id); continue; }
      seen.set(dupKey, rowNo);
      const item = { key: `${rowNo}|${h}`, row: rowNo, column: h, who, athlete: profile, test, metric, side: col.side ?? null, attempt: col.attempt ?? null, value, entered: String(row[h]).trim(), unit, date, notes: roles.notes ? row[roles.notes] || null : null };
      rowValues.push(item);
      items.push(item);
    }
    // Unusual values: far off this athlete's record, or attempts that don't agree with each other.
    for (const it of rowValues) {
      const { test, metric } = it;
      const bk = `${key}|${test.id}|${metric.key}|${it.side ?? ''}`;
      if (!bests.has(bk)) {
        const agg = metric.better === 'lower' ? 'MIN(value)' : metric.better === 'higher' ? 'MAX(value)' : '(SELECT value FROM perf_results x WHERE x.id = MAX(r.id))';
        bests.set(bk, ctx.db.get(`SELECT ${metric.better === 'none' ? 'value AS b FROM perf_results r' : `${agg} AS b FROM perf_results r`} WHERE ${who.client_id ? 'client_id' : 'roster_id'} = ? AND test_id = ? AND metric = ? AND voided = 0 AND COALESCE(side, '') = ?${metric.better === 'none' ? ' ORDER BY recorded_at DESC LIMIT 1' : ''}`, key, test.id, metric.key, it.side ?? '')?.b ?? null);
      }
      const ref = bests.get(bk);
      if (ref != null) {
        if (metric.better === 'none') { if (Math.abs(it.value - ref) / ref > 0.25) warnings.push({ key: it.key, row: it.row, column: it.column, athlete_id: profile.athlete_id, message: `${profile.name}'s ${test.name.toLowerCase()} was ${fmt(ref, metric.unit, metric.decimals)} last time; this says ${fmt(it.value, metric.unit, metric.decimals)}.` }); }
        else {
          const gain = metric.better === 'lower' ? (ref - it.value) / ref : (it.value - ref) / ref;
          if (gain > 0.15) warnings.push({ key: it.key, row: it.row, column: it.column, athlete_id: profile.athlete_id, message: `${fmt(it.value, metric.unit, metric.decimals)} is far better than ${profile.name}'s best ${test.name} (${fmt(ref, metric.unit, metric.decimals)}).` });
          else if (gain < -0.3) warnings.push({ key: it.key, row: it.row, column: it.column, athlete_id: profile.athlete_id, message: `${fmt(it.value, metric.unit, metric.decimals)} is far worse than ${profile.name}'s best ${test.name} (${fmt(ref, metric.unit, metric.decimals)}).` });
        }
      }
      const siblings = rowValues.filter((o) => o !== it && o.test === test && o.metric === metric && o.side === it.side && (o.attempt ?? 0) < (it.attempt ?? 0));
      const prev = siblings[siblings.length - 1];
      if (prev && metric.better !== 'none' && Math.abs(it.value - prev.value) / Math.min(it.value, prev.value) > 0.2 && !warnings.some((w) => w.key === it.key)) {
        warnings.push({ key: it.key, row: it.row, column: it.column, athlete_id: profile.athlete_id, message: `${profile.name}'s attempts don't agree: ${fmt(prev.value, metric.unit, metric.decimals)} then ${fmt(it.value, metric.unit, metric.decimals)}.` });
      }
    }
  });
  if (!errors.length && !items.length) err(null, null, 'There are no results in this sheet.');
  return { errors, warnings, items, session };
}

function summarize(ctx, check) {
  const groups = new Map();
  for (const it of check.items) {
    const k = it.who.client_id ?? it.who.roster_id;
    if (!groups.has(k)) groups.set(k, { ...it.who, name: it.athlete.name, athlete_id: it.athlete.athlete_id, results: [] });
    const w = check.warnings.find((x) => x.key === it.key);
    groups.get(k).results.push({ key: it.key, row: it.row, test: it.test.key, test_name: it.test.name, metric_name: it.metric.name, side: it.side, attempt: it.attempt,
      value: it.value, unit: it.metric.unit, decimals: it.metric.decimals, entered: it.entered, entered_unit: it.unit, date: it.date, warning: w?.message ?? null });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function previewUpload(ctx, body) {
  const { headers, rows } = readUpload(body);
  if (rows.length > 20000) throw badRequest('Upload up to 20,000 rows at a time.');
  const options = { session_id: body.session_id || null, date: body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null, test: body.test || null };
  if (options.session_id) getSession(ctx, options.session_id);
  const check = checkUpload(ctx, { headers, rows, options });
  ctx.db.run(`DELETE FROM upload_previews WHERE expires_at < ?`, ctx.now());
  const id = newId('upl');
  ctx.db.run('INSERT INTO upload_previews (id, filename, options, headers, rows, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, body.filename ? String(body.filename).slice(0, 200) : null, JSON.stringify(options), JSON.stringify(headers), JSON.stringify(rows), new Date(Date.now() + 24 * 3600000).toISOString(), ctx.now());
  return {
    preview_id: id, ok: check.errors.length === 0, format: body.xlsx_base64 ? 'xlsx' : 'csv', rows: rows.length,
    errors: check.errors.slice(0, 200), error_count: check.errors.length, warnings: check.warnings,
    summary: { results: check.items.length, athletes: new Set(check.items.map((i) => i.who.client_id ?? i.who.roster_id)).size, to_confirm: check.warnings.length },
    athletes: check.errors.length ? [] : summarize(ctx, check)
  };
}

// Saves a checked upload: all of it, or none of it.
export function commitUpload(ctx, body) {
  const p = ctx.db.get('SELECT * FROM upload_previews WHERE id = ?', v.str(body.preview_id, 'preview_id'));
  if (!p || p.expires_at < ctx.now()) throw notFound('Upload (it may have expired; upload the file again)');
  const options = JSON.parse(p.options);
  const check = checkUpload(ctx, { headers: JSON.parse(p.headers), rows: JSON.parse(p.rows), options });     // checked again, against today's data
  if (check.errors.length) {
    const e = badRequest(`Nothing was saved. ${check.errors.length} ${check.errors.length === 1 ? 'problem needs' : 'problems need'} fixing in the sheet.`);
    e.status = 409; e.code = 'upload_rejected'; e.details = check.errors.slice(0, 200);
    throw e;
  }
  const confirmed = new Set(Array.isArray(body.confirm) ? body.confirm : []);
  const open = check.warnings.filter((w) => !confirmed.has(w.key));
  if (open.length) {
    const e = badRequest(`Nothing was saved. Confirm the ${open.length} unusual ${open.length === 1 ? 'value' : 'values'} first, or fix the sheet.`);
    e.status = 409; e.code = 'confirmation_required'; e.details = open;
    throw e;
  }
  const items = check.items.map((it) => ({ ...it.who, test: it.test.key, metric: it.metric.key, side: it.side ?? undefined, attempt: it.attempt ?? undefined, value: it.value, unit: it.metric.unit,
    recorded_at: `${it.date}T12:00:00.000Z`, notes: it.notes ?? undefined, external_id: resultExternalId('upload', it.who.client_id ?? it.who.roster_id, it.test.key, it.metric.key, it.side, it.attempt, it.date, it.value) }));
  const out = ctx.db.tx(() => {
    const total = { created: 0, duplicates: 0, prs: [] };
    for (let i = 0; i < items.length; i += 1000) {
      const r = recordResults(ctx, items.slice(i, i + 1000), { source: 'upload', sessionId: options.session_id });
      if (r.errors.length || r.unmatched.length) {          // should never happen after the checks; if it does, undo everything
        const e = badRequest('Nothing was saved. A result could not be stored; upload the file again.');
        e.status = 409; e.code = 'upload_rejected'; e.details = r.errors;
        throw e;
      }
      total.created += r.created; total.duplicates += r.duplicates; total.prs.push(...r.prs);
    }
    ctx.db.run('INSERT INTO import_batches (id, provider, filename, total_rows, imported, duplicates, pending, errors, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('imp'), 'upload', p.filename ?? 'Upload', items.length, total.created, total.duplicates, '[]', '[]', ctx.now());
    ctx.db.run('DELETE FROM upload_previews WHERE id = ?', p.id);
    return total;
  });
  const athletes = summarize(ctx, check).map((g) => ({ client_id: g.client_id ?? null, roster_id: g.roster_id ?? null, name: g.name, athlete_id: g.athlete_id,
    contract_id: g.roster_id ? ctx.db.get('SELECT contract_id FROM team_roster WHERE id = ?', g.roster_id).contract_id : null,
    results: g.results.length, prs: out.prs.filter((x) => (x.client_id ?? x.roster_id) === (g.client_id ?? g.roster_id)).length }));
  return { saved: out.created, already_saved: out.duplicates, prs: out.prs.length, athletes };
}
