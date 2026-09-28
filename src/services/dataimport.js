// Outside data (Settings → Data import, the parent portal): an athlete's own numbers from a wearable or another app,
// brought in by hand from a CSV, an Excel file, a Google Sheets link or a text-based PDF. Staff (owner and coaches) and
// the athlete's parents upload; staff, the athlete and their parents see it. For now it's shown, not used for training.
//
// The athlete is always chosen (a staff member picks the profile; a parent picks one of their own athletes): nothing is
// matched by a name inside the file. WHOOP exports are recognized by their columns (daily cycles, sleeps, workouts);
// any other table is mapped by hand (a date column and the columns to keep, each with a name and unit).
// Like every import: the whole file is checked first and every problem is listed by row and column; nothing is saved until
// it's clean; it's checked again at save time and saved in one transaction. A day already on file for a metric is
// replaced by the new file (a newer export is the better one). Undo removes what that import saved.
import { newId, v, badRequest, notFound, conflict, HttpError } from '../util.js';
import { readXlsx } from './xlsx.js';
import { parseCsv } from './perf-import.js';
import { pdfTable } from './pdftext.js';

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_ROWS = 20000, MAX_CUSTOM_METRICS = 20;

// ---------- The metrics we know ----------
// better: which way is good, for trend arrows. min/max: impossible values are refused.
export const METRICS = {
  recovery_pct: { label: 'Recovery', unit: '%', min: 0, max: 100, better: 'higher' },
  hrv_ms: { label: 'Heart rate variability', unit: 'ms', min: 1, max: 400, better: 'higher' },
  rhr_bpm: { label: 'Resting heart rate', unit: 'bpm', min: 20, max: 200, better: 'lower' },
  day_strain: { label: 'Day strain', unit: '', min: 0, max: 21.5, better: null },
  calories_kcal: { label: 'Energy burned', unit: 'cal', min: 0, max: 30000, better: null },
  max_hr_bpm: { label: 'Max heart rate', unit: 'bpm', min: 30, max: 250, better: null },
  avg_hr_bpm: { label: 'Average heart rate', unit: 'bpm', min: 20, max: 250, better: null },
  spo2_pct: { label: 'Blood oxygen', unit: '%', min: 50, max: 100, better: 'higher' },
  skin_temp_c: { label: 'Skin temperature', unit: '°C', min: 20, max: 45, better: null },
  resp_rate: { label: 'Respiratory rate', unit: 'rpm', min: 4, max: 60, better: null },
  sleep_min: { label: 'Sleep', unit: 'min', min: 0, max: 1440, better: 'higher' },
  in_bed_min: { label: 'In bed', unit: 'min', min: 0, max: 1440, better: null },
  light_min: { label: 'Light sleep', unit: 'min', min: 0, max: 1440, better: null },
  deep_min: { label: 'Deep sleep', unit: 'min', min: 0, max: 1440, better: 'higher' },
  rem_min: { label: 'REM sleep', unit: 'min', min: 0, max: 1440, better: 'higher' },
  awake_min: { label: 'Awake in bed', unit: 'min', min: 0, max: 1440, better: 'lower' },
  sleep_need_min: { label: 'Sleep need', unit: 'min', min: 0, max: 1440, better: null },
  sleep_debt_min: { label: 'Sleep debt', unit: 'min', min: 0, max: 1440, better: 'lower' },
  sleep_performance_pct: { label: 'Sleep performance', unit: '%', min: 0, max: 100, better: 'higher' },
  sleep_efficiency_pct: { label: 'Sleep efficiency', unit: '%', min: 0, max: 100, better: 'higher' },
  sleep_consistency_pct: { label: 'Sleep consistency', unit: '%', min: 0, max: 100, better: 'higher' }
};
// The ones a family and a coach look at first.
export const HEADLINE = ['recovery_pct', 'hrv_ms', 'rhr_bpm', 'sleep_min', 'day_strain'];

// ---------- File formats we recognize ----------
const SLEEP_COLS = {
  'Sleep performance %': 'sleep_performance_pct', 'Respiratory rate (rpm)': 'resp_rate', 'Asleep duration (min)': 'sleep_min', 'In bed duration (min)': 'in_bed_min',
  'Light sleep duration (min)': 'light_min', 'Deep (SWS) duration (min)': 'deep_min', 'REM duration (min)': 'rem_min', 'Awake duration (min)': 'awake_min',
  'Sleep need (min)': 'sleep_need_min', 'Sleep debt (min)': 'sleep_debt_min', 'Sleep efficiency %': 'sleep_efficiency_pct', 'Sleep consistency %': 'sleep_consistency_pct'
};
export const FORMATS = {
  whoop_cycles: { label: 'WHOOP daily cycles (physiological_cycles.csv)', needs: ['Cycle start time', 'Recovery score %', 'Heart rate variability (ms)'],
    cols: { 'Recovery score %': 'recovery_pct', 'Resting heart rate (bpm)': 'rhr_bpm', 'Heart rate variability (ms)': 'hrv_ms', 'Skin temp (celsius)': 'skin_temp_c', 'Blood oxygen %': 'spo2_pct',
      'Day Strain': 'day_strain', 'Energy burned (cal)': 'calories_kcal', 'Max HR (bpm)': 'max_hr_bpm', 'Average HR (bpm)': 'avg_hr_bpm', ...SLEEP_COLS } },
  whoop_sleeps: { label: 'WHOOP sleeps (sleeps.csv)', needs: ['Sleep onset', 'Wake onset', 'Asleep duration (min)', 'Nap'], cols: SLEEP_COLS },
  whoop_workouts: { label: 'WHOOP workouts (workouts.csv)', needs: ['Workout start time', 'Activity name', 'Activity Strain'], workouts: true },
  custom: { label: 'Another app or spreadsheet', custom: true }
};
export function detectFormat(headers) {
  const has = new Set(headers.map((h) => String(h).trim()));
  for (const [key, f] of Object.entries(FORMATS)) if (f.needs?.every((c) => has.has(c))) return key;
  return 'custom';
}

// ---------- Reading the file ----------
// body.file: { name, csv } for CSV text, { name, xlsx_base64 } for Excel, { name, pdf_base64 } for a PDF; or body.sheet_url.
const b64 = (s, what) => {
  const buf = Buffer.from(v.str(s, what, { max: Math.ceil(MAX_FILE_BYTES * 1.4) }), 'base64');
  if (buf.length > MAX_FILE_BYTES) throw new HttpError(413, 'too_large', 'That file is bigger than 15 MB. Export a shorter date range.');
  return buf;
};
function tableFromRows(rows) {
  rows = rows.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (rows.length < 2) throw badRequest('The file needs a header row and at least one row of data.');
  const headers = rows[0].map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
  return { headers, rows: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()]))) };
}
// A Google Sheets link: only docs.google.com spreadsheets, read as CSV through Google's own export address. The sheet
// has to be shared as "Anyone with the link can view".
export function sheetCsvUrl(link) {
  let u;
  try { u = new URL(String(link ?? '').trim()); } catch { throw badRequest('Paste the Google Sheets link (it starts with https://docs.google.com/spreadsheets/).'); }
  const id = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/)?.[1];
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || !id) throw badRequest('Paste the Google Sheets link (it starts with https://docs.google.com/spreadsheets/).');
  const gid = (u.hash.match(/gid=(\d+)/) ?? u.search.match(/gid=(\d+)/))?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}
async function fetchSheet(ctx, link) {
  const url = sheetCsvUrl(link);
  const get = ctx.fetchSheet ?? ((u) => fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20000) }));
  let res;
  try { res = await get(url); } catch { throw new HttpError(502, 'sheet_unreachable', 'Google Sheets didn\'t answer. Try again in a minute, or download the sheet as CSV and upload that.'); }
  const type = res.headers?.get?.('content-type') ?? '';
  if (!res.ok || /text\/html/.test(type)) throw badRequest('We couldn\'t open that sheet. In Google Sheets, press Share and set General access to "Anyone with the link" (Viewer), then paste the link again. Or download it as CSV (File → Download) and upload that.');
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new HttpError(413, 'too_large', 'That sheet is bigger than 15 MB. Share a shorter date range.');
  return text;
}
export async function readTable(ctx, body) {
  if (body.sheet_url) { const t = parseCsv(await fetchSheet(ctx, body.sheet_url)); return { ...t, kind: 'sheet', filename: 'Google Sheet' }; }
  const f = body.file ?? {};
  const name = v.str(f.name ?? 'upload', 'file name', { max: 200 });
  if (f.pdf_base64) {
    let t;
    try { t = pdfTable(b64(f.pdf_base64, 'file')); } catch (e) { if (e instanceof HttpError) throw e; throw badRequest(e.message); }
    return { headers: t.headers, rows: t.rows, kind: 'pdf', filename: name, note: t.ignored_lines ? `${t.ignored_lines} lines of the PDF outside the table (titles, page numbers) were left out.` : null };
  }
  if (f.xlsx_base64) {
    let rows;
    try { rows = readXlsx(b64(f.xlsx_base64, 'file')); } catch (e) { if (e instanceof HttpError) throw e; throw badRequest(`That Excel file couldn't be read (${e.message}). Save it as .xlsx and try again, or export a CSV.`); }
    return { ...tableFromRows(rows), kind: 'xlsx', filename: name };
  }
  if (f.csv != null) {
    const text = v.str(f.csv, 'file', { max: MAX_FILE_BYTES });
    const t = parseCsv(text);
    if (!t.headers?.length || !t.rows.length) throw badRequest('The file needs a header row and at least one row of data.');
    return { ...t, kind: 'csv', filename: name };
  }
  throw badRequest('Choose a file (CSV, Excel or PDF) or paste a Google Sheets link.');
}

// ---------- Values ----------
// Commas: 1,234 or 12,345.6 are thousands; 65,3 is a decimal comma (spreadsheets outside the US); anything else is refused.
const num = (s) => {
  let t = String(s ?? '').trim().replace(/\s/g, '').replace(/%$/, '');
  if (t === '' || t === '-' || t === '--') return null;
  if (t.includes(',')) {
    if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
    else if (/^[-+]?\d+,\d+$/.test(t)) t = t.replace(',', '.');
    else return NaN;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
// A day from a cell: 2026-09-27, 2026-09-27 06:30:37, 2026-09-27T06:30:37Z, 9/27/2026, 27.09.2026 or an Excel day number.
// Times are taken as written (a wearable writes the athlete's own local time).
export function dayOf(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  let y, mo, d;
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) [mo, d, y] = [m[1], m[2], m[3].length === 2 ? `20${m[3]}` : m[3]];
  else if ((m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/))) [d, mo, y] = [m[1], m[2], m[3]];
  else if (/^\d{5}(\.\d+)?$/.test(t)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86400000).toISOString().slice(0, 10);
  else return undefined;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso || Number(y) < 2000 || Number(y) > 2100) return undefined;
  return iso;
}
// "2026-09-27 10:32:00" in "UTC-06:00" → an ISO time.
function isoAt(s, tz) {
  const m = String(s ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const off = String(tz ?? '').match(/UTC([+-])(\d{2}):?(\d{2})/);
  const base = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}Z`);
  if (Number.isNaN(base)) return null;
  const shift = off ? (off[1] === '-' ? 1 : -1) * (Number(off[2]) * 60 + Number(off[3])) * 60000 : 0;
  return new Date(base + shift).toISOString();
}
export const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
// A header like "Resting heart rate (bpm)" or "Recovery %" → name and unit.
export function splitHeader(h) {
  const t = String(h).trim();
  const m = t.match(/^(.*?)\s*\(([^)]{1,12})\)\s*$/) ?? t.match(/^(.*?)\s*(%)\s*$/);
  return m ? { label: m[1].trim() || t, unit: m[2] } : { label: t, unit: '' };
}

// ---------- Turning rows into what gets saved ----------
// Returns { metrics: [{day, metric, value, label, unit}], workouts: [...], problems: [{row, column, message}], notes }.
function build(table, format, mapping) {
  const out = { metrics: [], workouts: [], problems: [], notes: [] };
  const problem = (row, column, message) => { if (out.problems.length < 5000) out.problems.push({ row, column, message }); };
  if (table.rows.length > MAX_ROWS) { problem(null, null, `The file has ${table.rows.length.toLocaleString()} rows; the limit is ${MAX_ROWS.toLocaleString()}. Export a shorter date range.`); return out; }
  const f = FORMATS[format];
  const seen = new Map();          // metric|day → row, to catch the same day twice
  // The same day twice: WHOOP lists the newest first, so its first row counts; in any other file the later row does.
  const keepFirst = !f.custom;
  const put = (rowNo, day, metric, value, label, unit) => {
    const k = `${metric}|${day}`;
    if (seen.has(k)) { out.dupes = (out.dupes ?? 0) + 1; if (!keepFirst) { seen.get(k).value = value; seen.get(k).row = rowNo; } return; }
    const item = { day, metric, value, label, unit, row: rowNo };
    seen.set(k, item); out.metrics.push(item);
  };
  table.rows.forEach((r, i) => {
    const rowNo = i + 2;              // row 1 is the header
    if (f.workouts) {
      const start = isoAt(r['Workout start time'], r['Cycle timezone']);
      if (!start) return problem(rowNo, 'Workout start time', `"${r['Workout start time'] ?? ''}" isn't a date and time.`);
      const n = (col, lo, hi) => { const x = num(r[col]); if (Number.isNaN(x) || (x != null && (x < lo || x > hi))) { problem(rowNo, col, `"${r[col]}" isn't a possible value (${lo} to ${hi}).`); return null; } return x; };
      out.workouts.push({ row: rowNo, started_at: start, ended_at: isoAt(r['Workout end time'], r['Cycle timezone']), day: dayOf(r['Workout start time']),
        minutes: n('Duration (min)', 0, 1440), activity: String(r['Activity name'] ?? '').slice(0, 60) || 'Activity', strain: n('Activity Strain', 0, 21.5),
        calories: n('Energy burned (cal)', 0, 20000), avg_hr: n('Average HR (bpm)', 20, 250), max_hr: n('Max HR (bpm)', 20, 250) });
      return;
    }
    if (f.custom) {
      const day = dayOf(r[mapping.date_column]);
      if (!day) return problem(rowNo, mapping.date_column, `"${r[mapping.date_column] ?? ''}" isn't a date. Use a date like 2026-09-27 or 9/27/2026.`);
      for (const m of mapping.metrics) {
        const x = num(r[m.column]);
        if (x == null) continue;
        if (Number.isNaN(x)) { problem(rowNo, m.column, `"${r[m.column]}" isn't a number.`); continue; }
        if (Math.abs(x) > 1e9) { problem(rowNo, m.column, `"${r[m.column]}" is too big to be a real value.`); continue; }
        put(rowNo, day, m.key, x, m.label, m.unit);
      }
      return;
    }
    // WHOOP cycles and sleeps: the day is the morning they woke up (the day the recovery is for).
    if (format === 'whoop_sleeps' && String(r.Nap ?? '').trim().toLowerCase() === 'true') { out.naps = (out.naps ?? 0) + 1; return; }
    const wake = r['Wake onset'] || r['Cycle end time'] || r['Cycle start time'];
    const day = dayOf(wake);
    if (!day) return problem(rowNo, r['Wake onset'] ? 'Wake onset' : 'Cycle start time', `"${wake ?? ''}" isn't a date.`);
    for (const [col, key] of Object.entries(f.cols)) {
      if (!(col in r)) continue;
      const x = num(r[col]);
      if (x == null) continue;
      const def = METRICS[key];
      // A wearable writes 0 when it didn't measure something (older WHOOP straps and respiratory rate): skip it.
      if (x === 0 && def.min > 0) { out.unmeasured = (out.unmeasured ?? 0) + 1; continue; }
      if (Number.isNaN(x) || x < def.min || x > def.max) { problem(rowNo, col, `"${r[col]}" isn't a possible ${def.label.toLowerCase()} (${def.min} to ${def.max}${def.unit ? ` ${def.unit}` : ''}).`); continue; }
      put(rowNo, day, key, x, null, null);
    }
  });
  if (out.naps) out.notes.push(`${out.naps} ${out.naps === 1 ? 'nap was' : 'naps were'} left out (only the night's sleep counts for the day).`);
  if (out.unmeasured) out.notes.push(`${out.unmeasured} ${out.unmeasured === 1 ? 'value was' : 'values were'} 0, which means the device didn't measure it that day; ${out.unmeasured === 1 ? 'it was' : 'they were'} left out.`);
  if (out.dupes) out.notes.push(`${out.dupes} ${out.dupes === 1 ? 'value was' : 'values were'} for a day already in the file; the ${keepFirst ? 'most recent' : 'later row'} counts.`);
  return out;
}
function customMapping(table, mapping) {
  if (!mapping) return null;
  const date = v.str(mapping.date_column, 'date_column', { max: 200 });
  if (!table.headers.includes(date)) throw badRequest(`There's no column called "${date}" in the file.`);
  const list = Array.isArray(mapping.metrics) ? mapping.metrics : [];
  if (!list.length) throw badRequest('Tick at least one column to bring in.');
  if (list.length > MAX_CUSTOM_METRICS) throw badRequest(`Bring in up to ${MAX_CUSTOM_METRICS} columns at a time.`);
  const keys = new Set();
  return { date_column: date, metrics: list.map((m) => {
    if (!m || typeof m !== 'object') throw badRequest('Each column to bring in needs a column name.');
    const column = v.str(m.column, 'column', { max: 200 });
    if (!table.headers.includes(column)) throw badRequest(`There's no column called "${column}" in the file.`);
    if (column === date) throw badRequest('The date column can\'t also be a number to bring in.');
    const label = v.str(m.label || splitHeader(column).label, 'name', { max: 40 });
    const unit = v.str(m.unit ?? splitHeader(column).unit, 'unit', { max: 12, optional: true }) ?? '';
    const key = `custom:${slug(label)}`;
    if (key === 'custom:') throw badRequest(`Give "${column}" a name with letters or numbers.`);
    if (keys.has(key)) throw badRequest(`Two columns are both called "${label}". Give each its own name.`);
    keys.add(key);
    return { column, label, unit, key };
  }) };
}
// What a custom file looks like, to map it: which column looks like dates, and which look like numbers.
function suggest(table) {
  const sample = table.rows.slice(0, 50);
  const share = (h, test) => sample.filter((r) => String(r[h] ?? '').trim() !== '').length && sample.filter((r) => test(r[h])).length / Math.max(1, sample.filter((r) => String(r[h] ?? '').trim() !== '').length);
  // The column that reads best as dates (at least 60% of it), preferring one that isn't plain numbers (Excel serial days).
  const plain = (h) => /^\d+(\.\d+)?$/.test(String(sample[0]?.[h] ?? '').trim());
  const ranked = table.headers.map((h) => ({ h, s: share(h, (x) => !!dayOf(x)) || 0, p: plain(h) }))
    .filter((c) => c.s >= 0.6).sort((a, b) => (a.p - b.p) || (b.s - a.s));
  const dateCol = ranked[0]?.h ?? null;
  const numeric = table.headers.filter((h) => h !== dateCol && share(h, (x) => { const n = num(x); return n != null && !Number.isNaN(n); }) >= 0.8);
  return { date_column: dateCol, metrics: numeric.map((c) => ({ column: c, ...splitHeader(c) })) };
}

// ---------- Preview and save ----------
function athlete(ctx, clientId) {
  const c = ctx.db.get('SELECT id, name, athlete_id, archived_at FROM clients WHERE id = ?', v.str(clientId, 'client_id'));
  if (!c) throw notFound('Athlete');
  if (c.archived_at) throw conflict(`${c.name} is archived. Restore them on their client page first.`);
  return c;
}
async function prepare(ctx, clientId, body) {
  const c = athlete(ctx, clientId);
  const table = await readTable(ctx, body);
  const format = typeof body.format === 'string' && Object.hasOwn(FORMATS, body.format) ? body.format : detectFormat(table.headers);
  const f = FORMATS[format];
  if (f.needs && !f.needs.every((col) => table.headers.includes(col))) throw badRequest(`That file doesn't have the columns of a ${f.label}.`);
  const mapping = f.custom ? customMapping(table, body.mapping) : null;
  const built = f.custom && !mapping ? { metrics: [], workouts: [], problems: [], notes: [] } : build(table, format, mapping);
  return { c, table, format, mapping, built };
}
function summary(ctx, p) {
  const { c, table, format, mapping, built } = p;
  const days = [...new Set([...built.metrics.map((m) => m.day), ...built.workouts.map((w) => w.day).filter(Boolean)])].sort();
  const existing = new Map(ctx.db.all('SELECT metric, day, value FROM athlete_metrics WHERE client_id = ?', c.id).map((r) => [`${r.metric}|${r.day}`, r.value]));
  const replaced = built.metrics.filter((m) => existing.has(`${m.metric}|${m.day}`) && existing.get(`${m.metric}|${m.day}`) !== m.value).length;
  const same = built.metrics.filter((m) => existing.get(`${m.metric}|${m.day}`) === m.value).length;
  const haveWorkouts = new Set(ctx.db.all('SELECT started_at FROM athlete_workouts WHERE client_id = ? AND source = ?', c.id, format).map((r) => r.started_at));
  const byMetric = new Map();
  for (const m of built.metrics) { const e = byMetric.get(m.metric) ?? { metric: m.metric, label: m.label ?? METRICS[m.metric]?.label ?? m.metric, unit: m.unit ?? METRICS[m.metric]?.unit ?? '', days: 0 }; e.days++; byMetric.set(m.metric, e); }
  return {
    athlete: { id: c.id, name: c.name, athlete_id: c.athlete_id },
    format, format_label: FORMATS[format].label, file_kind: table.kind, filename: table.filename,
    headers: table.headers, sample: table.rows.slice(0, 5), rows: table.rows.length,
    needs_mapping: FORMATS[format].custom && !mapping, suggestion: FORMATS[format].custom ? suggest(table) : null, mapping,
    days: days.length, from: days[0] ?? null, to: days.at(-1) ?? null,
    metrics: [...byMetric.values()], values: built.metrics.length, replaced, unchanged: same,
    workouts: built.workouts.length, new_workouts: built.workouts.filter((w) => !haveWorkouts.has(w.started_at)).length,
    problems: built.problems.slice(0, 100), problem_count: built.problems.length,
    notes: [table.note, ...built.notes].filter(Boolean),
    ready: !built.problems.length && !(FORMATS[format].custom && !mapping) && (built.metrics.length + built.workouts.length) > 0
  };
}
export async function previewImport(ctx, clientId, body = {}) {
  return summary(ctx, await prepare(ctx, clientId, body));
}
// who: { kind: 'staff' | 'parent', name }
export async function commitImport(ctx, clientId, body = {}, who) {
  const p = await prepare(ctx, clientId, body);          // checked again at save time
  const s = summary(ctx, p);
  if (s.needs_mapping) throw badRequest('Choose the date column and the columns to bring in first.');
  if (s.problem_count) { const e = badRequest(`Nothing was saved: ${s.problem_count} ${s.problem_count === 1 ? 'problem' : 'problems'} to fix first.`); e.details = { problems: s.problems, problem_count: s.problem_count }; throw e; }
  if (!s.ready) throw badRequest('There\'s nothing to bring in from that file.');
  const id = newId('dim'), now = ctx.now(), { c, format, built } = p;
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO data_imports (id, client_id, source, file_kind, filename, rows, days, workouts, from_day, to_day, created_by, created_by_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, c.id, format, p.table.kind, p.table.filename, p.table.rows.length, s.days, built.workouts.length, s.from, s.to, who?.name ?? null, who?.kind ?? 'staff', now);
    // A value already on file stays with the import that brought it when it's the same; a different one is replaced
    // and the old one kept in data_import_replaced, so undoing this import puts it back.
    for (const m of built.metrics) {
      const cur = ctx.db.get('SELECT value, label, unit, source, import_id, updated_at FROM athlete_metrics WHERE client_id = ? AND metric = ? AND day = ?', c.id, m.metric, m.day);
      if (cur && cur.value === m.value && (cur.label ?? null) === (m.label ?? null) && (cur.unit ?? null) === (m.unit ?? null)) continue;
      if (cur) {
        ctx.db.run(`INSERT INTO data_import_replaced (import_id, client_id, metric, day, value, label, unit, source, prior_import_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, c.id, m.metric, m.day, cur.value, cur.label, cur.unit, cur.source, cur.import_id, cur.updated_at);
        ctx.db.run('UPDATE athlete_metrics SET value = ?, label = ?, unit = ?, source = ?, import_id = ?, updated_at = ? WHERE client_id = ? AND metric = ? AND day = ?',
          m.value, m.label, m.unit, format, id, now, c.id, m.metric, m.day);
      } else {
        ctx.db.run('INSERT INTO athlete_metrics (client_id, day, metric, value, label, unit, source, import_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          c.id, m.day, m.metric, m.value, m.label, m.unit, format, id, now);
      }
    }
    // A workout already on file stays with the import that brought it.
    for (const w of built.workouts) {
      ctx.db.run(`INSERT INTO athlete_workouts (id, client_id, source, started_at, ended_at, day, minutes, activity, strain, calories, avg_hr, max_hr, import_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (client_id, source, started_at) DO NOTHING`,
        newId('awk'), c.id, format, w.started_at, w.ended_at, w.day, w.minutes, w.activity, w.strain, w.calories, w.avg_hr, w.max_hr, id);
    }
  });
  return { id, ...s, saved: true };
}
export function listImports(ctx, { clientId, limit = 20 } = {}) {
  const rows = clientId
    ? ctx.db.all('SELECT d.*, c.name AS client_name FROM data_imports d JOIN clients c ON c.id = d.client_id WHERE d.client_id = ? ORDER BY d.created_at DESC LIMIT ?', clientId, limit)
    : ctx.db.all('SELECT d.*, c.name AS client_name FROM data_imports d JOIN clients c ON c.id = d.client_id WHERE c.archived_at IS NULL ORDER BY d.created_at DESC LIMIT ?', limit);
  return rows.map((d) => ({ ...d, format_label: FORMATS[d.source]?.label ?? d.source,
    kept: ctx.db.get('SELECT COUNT(*) AS n FROM athlete_metrics WHERE import_id = ?', d.id).n + ctx.db.get('SELECT COUNT(*) AS n FROM athlete_workouts WHERE import_id = ?', d.id).n }));
}
// Undo takes out what this import saved and puts back any value it replaced; values a later import replaced belong to
// that one now (and undoing it later goes back to what was there before this one). familyId: a parent may undo only an
// import for one of their own athletes, and only one a parent brought in.
export function undoImport(ctx, id, who, { familyId } = {}) {
  const d = ctx.db.get('SELECT d.*, c.family_id FROM data_imports d JOIN clients c ON c.id = d.client_id WHERE d.id = ?', v.str(id, 'id'));
  if (!d || (familyId && d.family_id !== familyId)) throw notFound('Import');
  if (d.undone_at) throw conflict('That import was already undone.');
  if (who?.kind === 'parent' && d.created_by_kind !== 'parent') throw conflict('Your coach brought that file in. Ask them if it needs to come out.');
  let metrics = 0, workouts = 0;
  ctx.db.tx(() => {
    const before = (metric, day) => ctx.db.get('SELECT * FROM data_import_replaced WHERE import_id = ? AND metric = ? AND day = ?', d.id, metric, day);
    for (const r of ctx.db.all('SELECT metric, day FROM athlete_metrics WHERE import_id = ?', d.id)) {
      const b = before(r.metric, r.day);
      if (b) ctx.db.run('UPDATE athlete_metrics SET value = ?, label = ?, unit = ?, source = ?, import_id = ?, updated_at = ? WHERE client_id = ? AND metric = ? AND day = ?',
        b.value, b.label, b.unit, b.source, b.prior_import_id, b.updated_at, d.client_id, r.metric, r.day);
      else ctx.db.run('DELETE FROM athlete_metrics WHERE client_id = ? AND metric = ? AND day = ?', d.client_id, r.metric, r.day);
      metrics++;
    }
    // A later import that replaced this one's value now goes back to what was there before this one, if it's undone.
    for (const r of ctx.db.all('SELECT import_id, metric, day FROM data_import_replaced WHERE prior_import_id = ?', d.id)) {
      const b = before(r.metric, r.day);
      if (b) ctx.db.run('UPDATE data_import_replaced SET value = ?, label = ?, unit = ?, source = ?, prior_import_id = ?, updated_at = ? WHERE import_id = ? AND metric = ? AND day = ?',
        b.value, b.label, b.unit, b.source, b.prior_import_id, b.updated_at, r.import_id, r.metric, r.day);
      else ctx.db.run('DELETE FROM data_import_replaced WHERE import_id = ? AND metric = ? AND day = ?', r.import_id, r.metric, r.day);
    }
    ctx.db.run('DELETE FROM data_import_replaced WHERE import_id = ?', d.id);
    workouts = ctx.db.run('DELETE FROM athlete_workouts WHERE import_id = ?', d.id).changes;
    ctx.db.run('UPDATE data_imports SET undone_at = ?, undone_by = ? WHERE id = ?', ctx.now(), who?.name ?? null, d.id);
  });
  return { id: d.id, undone: true, removed_values: metrics, removed_workouts: workouts };
}

// ---------- What staff, the athlete and parents see ----------
// The headline numbers (latest, 7-day and 30-day averages, the 30 days before for comparison), up to 90 days of each for
// a trend line, every other metric's latest value, and the last 20 workouts. Days are counted back from the newest day on
// file, so an export from last month still shows its own last week.
export function athleteData(ctx, clientId, { days = 90 } = {}) {
  const span = Math.min(Math.max(Number(days) || 90, 7), 400);
  const rows = ctx.db.all('SELECT day, metric, value, label, unit FROM athlete_metrics WHERE client_id = ? ORDER BY day', clientId);
  const workouts = ctx.db.all('SELECT started_at, ended_at, day, minutes, activity, strain, calories, avg_hr, max_hr, source FROM athlete_workouts WHERE client_id = ? ORDER BY started_at DESC LIMIT 20', clientId);
  if (!rows.length && !workouts.length) return { has_data: false, metrics: [], workouts: [], imports: 0 };
  const lastDay = rows.at(-1)?.day ?? workouts[0]?.day;
  const back = (n) => new Date(Date.parse(`${lastDay}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((t, x) => t + x, 0) / xs.length) * 10) / 10 : null);
  const byMetric = new Map();
  for (const r of rows) (byMetric.get(r.metric) ?? byMetric.set(r.metric, []).get(r.metric)).push(r);
  const metrics = [...byMetric].map(([key, list]) => {
    const def = METRICS[key] ?? { label: list.at(-1).label ?? key.replace(/^custom:/, ''), unit: list.at(-1).unit ?? '', better: null };
    const inRange = (from, to) => list.filter((r) => r.day > from && r.day <= to).map((r) => r.value);
    const last = list.at(-1);
    return { key, label: def.label, unit: def.unit, better: def.better, headline: HEADLINE.includes(key), custom: key.startsWith('custom:'),
      latest: { day: last.day, value: last.value }, avg_7: avg(inRange(back(7), lastDay)), avg_30: avg(inRange(back(30), lastDay)), avg_prev_30: avg(inRange(back(60), back(30))),
      series: list.filter((r) => r.day > back(span)).map((r) => ({ day: r.day, value: r.value })), days: list.length, from: list[0].day };
  }).sort((a, b) => (HEADLINE.indexOf(a.key) + 1 || 99) - (HEADLINE.indexOf(b.key) + 1 || 99) || a.label.localeCompare(b.label));
  return { has_data: true, last_day: lastDay, first_day: rows[0]?.day ?? null, metrics, workouts,
    imports: ctx.db.get('SELECT COUNT(*) AS n FROM data_imports WHERE client_id = ? AND undone_at IS NULL', clientId).n };
}
