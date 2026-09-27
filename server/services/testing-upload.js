// Upload results: read a sheet, check every cell (all or nothing), flag unusual values, then save in one transaction.
'use strict';
const { db, all, get, run, insert, tx } = require('../db');
const { sha256, today, log } = require('../lib');
const core = require('./testing-core');

// Every saved upload is a batch, so it can be listed and undone. Items remember what each result was before.
// day_id and result_id are plain integers (no foreign keys) so deleting a testing day never trips over a batch.
db.exec(`
CREATE TABLE IF NOT EXISTS upload_batches (
  id INTEGER PRIMARY KEY, filename TEXT, source TEXT, format TEXT, day_id INTEGER, day_name TEXT,
  saved INTEGER DEFAULT 0, created_count INTEGER DEFAULT 0, replaced_count INTEGER DEFAULT 0, pending INTEGER DEFAULT 0, prs INTEGER DEFAULT 0, athletes INTEGER DEFAULT 0,
  added_athletes TEXT DEFAULT '[]', added_tests TEXT DEFAULT '[]',
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), undone_at TEXT, undone_by INTEGER, undo_summary TEXT);
CREATE TABLE IF NOT EXISTS upload_batch_items (
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  result_id INTEGER, pending_id INTEGER, athlete_id INTEGER, test_id INTEGER, value REAL, created INTEGER DEFAULT 1,
  prev_value REAL, prev_unit_entered TEXT, prev_hand_timed INTEGER, prev_source TEXT, prev_recorded_at TEXT, prev_created_by INTEGER);
CREATE INDEX IF NOT EXISTS upload_batch_items_batch ON upload_batch_items(batch_id);
`);
const SOURCES = ['OVR', 'VALD', 'Swift', 'Freelap', 'Hawkin', 'Brower', 'Dashr', 'Rapsodo', 'Import'];

const ID_RE = /^(athlete\s*id|athlete_id|athleteid|id|athlete\s*code|code|dp\s*id)$/i;
const NAME_RE = /^(name|athlete|athlete\s*name|full\s*name|player|player\s*name)$/i;
const FIRST_RE = /^(first|first\s*name|given\s*name)$/i;
const LAST_RE = /^(last|last\s*name|surname|family\s*name)$/i;
const DATE_RE = /^(date|test\s*date|tested|recorded|recorded\s*at|timestamp|date\s*time|session\s*date)$/i;
const TEST_RE = /^(test|test\s*name|metric|exercise|drill)$/i;
const VALUE_RE = /^(value|result|score|measurement)$/i;
const UNIT_RE = /^(unit|units)$/i;
const DEVICE_RE = /^(device|device\s*id|device_id|device\s*name|sensor|mat\s*id)$/i;
const ATTEMPT_RE = /^(attempt|trial|rep|#)$/i;
const IGNORE_RE = /^(notes?|comments?|team|sport|school|position|group|email|birthday|sex|gender|age)$/i;

function guessSource(filename, header) {
  const s = `${filename || ''} ${header.join(' ')}`;
  if (/ovr/i.test(s)) return 'OVR';
  if (/vald|forcedecks/i.test(s)) return 'VALD';
  if (/swift/i.test(s)) return 'Swift';
  if (/freelap/i.test(s)) return 'Freelap';
  if (/hawkin/i.test(s)) return 'Hawkin';
  if (/brower/i.test(s)) return 'Brower';
  if (/dashr/i.test(s)) return 'Dashr';
  if (/rapsodo/i.test(s)) return 'Rapsodo';
  return 'Import';
}
function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 864e5); return d.toISOString().slice(0, 10); }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}
const toks = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
// Does the name on the sheet plausibly describe this athlete? Every word has to match a name (or its initial).
function nameMatches(sheetName, a) {
  const t = toks(sheetName);
  if (!t.length) return true;
  const names = [...toks(a.first_name), ...toks(a.last_name)];
  return t.every((w) => names.some((n) => n === w || (w.length === 1 && n[0] === w) || (w.length >= 3 && n.startsWith(w))));
}
function parseHeader(h) {
  const m = String(h).trim().match(/^(.*?)\s*(?:\(([^)]*)\))?\s*(?:#\s*(\d+))?\s*$/);
  return { name: (m?.[1] || '').trim(), unit: m?.[2] ? m[2].trim() : null, attempt: m?.[3] ? Number(m[3]) : null };
}
const fmtNum = (v) => String(Number(Number(v).toFixed(2)));

// rows: array of arrays (row 0 = header). opts: { day_id, date, test_id (single-test device export), filename, source }
function checkSheet(rows, opts = {}) {
  const problems = [];
  const P = (row, column, athlete, problem) => problems.push({ row, column, athlete: athlete || '', problem });
  rows = rows.map((r) => (r || []).map((c) => String(c ?? '').trim()));
  while (rows.length && rows[0].every((c) => !c)) rows.shift();
  if (!rows.length) return { ok: false, problems: [{ row: 1, column: '', athlete: '', problem: 'The sheet is empty. Paste the header row and your results.' }] };
  const header = rows[0];
  const day = opts.day_id ? get('SELECT * FROM testing_days WHERE id=?', Number(opts.day_id)) : null;
  if (opts.day_id && !day) return { ok: false, problems: [{ row: '', column: '', athlete: '', problem: 'That testing day no longer exists. Choose another.' }] };
  const fallbackDate = day ? day.date : (parseDate(opts.date) || today());
  const source = opts.source || guessSource(opts.filename, header);
  const col = (re) => header.findIndex((h) => re.test(h));
  const idCol = col(ID_RE), nameCol = col(NAME_RE), firstCol = col(FIRST_RE), lastCol = col(LAST_RE), dateCol = col(DATE_RE);
  const testCol = col(TEST_RE), valueCol = col(VALUE_RE), unitCol = col(UNIT_RE), deviceCol = col(DEVICE_RE), attemptCol = col(ATTEMPT_RE);
  const single = opts.test_id ? core.findTest(Number(opts.test_id)) : null;
  const format = single ? 'single' : testCol >= 0 && valueCol >= 0 ? 'long' : 'wide';
  const items = [], pending = [];
  const cellName = (r) => (nameCol >= 0 ? r[nameCol] : [r[firstCol] || '', r[lastCol] || ''].join(' ').trim()) || '';
  const athleteByCode = (code) => get('SELECT id, code, first_name, last_name FROM athletes WHERE code=? COLLATE NOCASE', code);
  const rowDate = (r, rn) => {
    if (day) return day.date;
    if (dateCol < 0 || !r[dateCol]) return fallbackDate;
    const d = parseDate(r[dateCol]);
    if (!d) { P(rn, header[dateCol], r[idCol] || '', `"${r[dateCol]}" isn't a date. Use YYYY-MM-DD.`); return fallbackDate; }
    return d;
  };
  const seen = new Map();

  if (format === 'wide') {
    if (idCol < 0) P(1, 'Athlete ID', '', 'The sheet needs an Athlete ID column. Download the sheet to get one with every ID filled in.');
    const cols = [];
    header.forEach((h, ci) => {
      if (ci === idCol || ci === nameCol || ci === firstCol || ci === lastCol || ci === dateCol || !h) return;
      const hasValues = rows.slice(1).some((r) => r[ci]);
      if (IGNORE_RE.test(h)) return;
      const ph = parseHeader(h);
      const t = core.findTest(ph.name);
      if (!t) { if (hasValues) P(1, h, '', `"${h}" doesn't match a test in your library. Use the column names from the downloaded sheet.`); return; }
      if (ph.unit && core.convert(1, ph.unit, t.unit) == null && core.normUnit(ph.unit) !== t.unit) { P(1, h, '', `${t.name} is measured in ${t.unit}, so this column can't be in ${ph.unit}.`); return; }
      cols.push({ ci, h, t, unit: ph.unit || t.unit, attempt: ph.attempt || 1 });
    });
    if (!problems.length && !cols.length) P(1, '', '', 'No columns match a test. Use the column names from the downloaded sheet.');
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i], rn = i + 1;
      const filled = cols.filter((c) => r[c.ci]);
      if (!filled.length) continue;
      const code = idCol >= 0 ? r[idCol] : '';
      if (!code) { P(rn, 'Athlete ID', '', 'This row has results but no Athlete ID.'); continue; }
      const a = athleteByCode(code);
      if (!a) { P(rn, 'Athlete ID', code, `No athlete has the ID ${code}. Check it against the downloaded sheet.`); continue; }
      const nm = cellName(r);
      if (nm && !nameMatches(nm, a)) { P(rn, nameCol >= 0 ? header[nameCol] : 'Name', a.code, `${a.code} is ${core.athleteName(a)}, but this row says "${nm}". Check the ID or the name.`); continue; }
      const date = rowDate(r, rn);
      for (const c of filled) {
        const chk = core.checkValue(c.t, r[c.ci], c.unit);
        if (chk.error) { P(rn, c.h, a.code, chk.error); continue; }
        const k = `${a.id}|${c.t.id}|${c.attempt}|${date}`;
        if (seen.has(k)) { P(rn, c.h, a.code, `${a.code} already has ${c.t.name} #${c.attempt} on row ${seen.get(k)}. Keep one.`); continue; }
        seen.set(k, rn);
        items.push({ key: `${rn}:${c.ci}`, row: rn, column: c.h, athlete: a, test: c.t, attempt: c.attempt, value: chk.value, unit_entered: chk.unit || c.t.unit, date });
      }
    }
  } else {
    // Long (one result per row: test + value) or a device export for one test.
    let vCol = valueCol;
    if (format === 'single' && vCol < 0) {
      vCol = header.findIndex((h, ci) => ![idCol, nameCol, firstCol, lastCol, dateCol, unitCol, deviceCol, attemptCol, testCol].includes(ci) && h && !IGNORE_RE.test(h) && rows.slice(1).some((r) => /^[-+]?[\d.]+/.test(r[ci] || '')));
      if (vCol < 0) P(1, '', '', `No column holds ${single.name} values. Name it "Value".`);
    }
    if (idCol < 0 && nameCol < 0 && firstCol < 0 && deviceCol < 0) P(1, '', '', 'The sheet needs an Athlete ID, name or device column so each result can find its athlete.');
    const occ = new Map();
    for (let i = 1; i < rows.length && vCol >= 0; i++) {
      const r = rows[i], rn = i + 1;
      if (!r[vCol] && (format === 'single' || !r[testCol])) continue;
      const t = single || core.findTest(r[testCol]);
      const code = idCol >= 0 ? r[idCol] : '';
      if (!t) { P(rn, header[testCol], code, `"${r[testCol]}" doesn't match a test in your library.`); continue; }
      const headUnit = parseHeader(header[vCol]).unit;
      const chk = core.checkValue(t, r[vCol], (unitCol >= 0 && r[unitCol]) || headUnit || t.unit);
      if (chk.empty) { P(rn, header[vCol], code, 'This row has no value.'); continue; }
      if (chk.error) { P(rn, header[vCol], code, chk.error); continue; }
      const date = rowDate(r, rn);
      const nm = cellName(r);
      let a = code ? athleteByCode(code) : null;
      if (a && nm && !toks(nm).some((w) => toks(core.athleteName(a)).some((n) => n.startsWith(w) || w.startsWith(n)))) {
        P(rn, nameCol >= 0 ? header[nameCol] : 'Name', a.code, `${a.code} is ${core.athleteName(a)}, but this row says "${nm}". Check the ID or the name.`); continue;
      }
      const senderKey = (deviceCol >= 0 && r[deviceCol]) || code || nm;
      if (!a && senderKey) {
        const link = get('SELECT athlete_id FROM device_links WHERE source=? COLLATE NOCASE AND sender_key=?', source, senderKey);
        if (link) a = get('SELECT id, code, first_name, last_name FROM athletes WHERE id=?', link.athlete_id);
      }
      if (!a && !senderKey) { P(rn, 'Athlete ID', '', 'This row has a result but no Athlete ID, name or device.'); continue; }
      const who = a ? `a${a.id}` : `s${senderKey}`;
      const ok = `${who}|${t.id}|${date}`;
      const n = (occ.get(ok) || 0) + 1; occ.set(ok, n);
      if (a) {
        const attempt = attemptCol >= 0 && /^\d+$/.test(r[attemptCol]) ? Number(r[attemptCol]) : n;
        const k = `${a.id}|${t.id}|${attempt}|${date}`;
        if (seen.has(k)) { P(rn, header[vCol], a.code, `${a.code} already has ${t.name} #${attempt} on row ${seen.get(k)}. Keep one.`); continue; }
        seen.set(k, rn);
        items.push({ key: `${rn}:${vCol}`, row: rn, column: header[vCol], athlete: a, test: t, attempt, value: chk.value, unit_entered: chk.unit || t.unit, date,
          ref: day ? null : `upload:${sha256([source, a.id, t.id, date, attempt].join('|')).slice(0, 32)}` });
      } else {
        pending.push({ row: rn, source, sender_key: senderKey, sender_label: nm || senderKey, test: t, value: chk.value, date,
          ref: `upload:${sha256([source, senderKey, t.id, date, chk.value, n].join('|')).slice(0, 32)}` });
      }
    }
  }
  if (!problems.length && !items.length && !pending.length) P('', '', '', 'This sheet has no results in it yet.');
  if (problems.length) return { ok: false, problems: problems.sort((x, y) => (Number(x.row) || 0) - (Number(y.row) || 0)), format, source };

  // Wide sheets without a day still need a stable reference so re-uploading doesn't double-count.
  for (const it of items) if (!day && !it.ref) it.ref = `upload:${sha256(['sheet', it.athlete.id, it.test.id, it.date, it.attempt].join('|')).slice(0, 32)}`;

  // What each result would do: new, replace a different value, or change nothing. Plus PR context.
  // Unusual values: much better than the athlete's best, or at the edge of what's possible.
  const unusual = [];
  for (const it of items) {
    const t = it.test;
    const existing = day ? get('SELECT id, value FROM results WHERE athlete_id=? AND test_id=? AND day_id=? AND attempt=?', it.athlete.id, t.id, day.id, it.attempt)
      : get('SELECT id, value FROM results WHERE source_ref=?', it.ref);
    it.existing = existing || null;
    it.same = !!existing && Math.abs(existing.value - it.value) < 1e-9;
    const prev = core.previousBest(t, it.athlete.id, { day_id: day ? day.id : null, attempt: it.attempt, source_ref: it.ref });
    it.prev_best = prev;
    it.pr = prev != null && core.better(t, it.value, prev);
    let msg = null;
    if (prev != null && prev !== 0) {
      const imp = (t.lower_better ? prev - it.value : it.value - prev) / Math.abs(prev);
      if (imp > 0.15) msg = `${core.fmtValue(it.value, t.unit)} is far better than ${core.athleteName(it.athlete)}'s best ${t.name} (${core.fmtValue(prev, t.unit)}).`;
    }
    if (!msg && t.min_value != null && t.max_value != null) {
      const span = t.max_value - t.min_value;
      if (it.value < t.min_value + span * 0.05 || it.value > t.max_value - span * 0.05) msg = `${core.fmtValue(it.value, t.unit)} is at the edge of what's possible for ${t.name} (${core.fmtRange(t)}).`;
    }
    if (msg && !it.same) { it.unusual = msg; unusual.push({ key: it.key, row: it.row, column: it.column, athlete: it.athlete.code, message: msg }); }
  }
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.athlete.id)) groups.set(it.athlete.id, { id: it.athlete.id, code: it.athlete.code, name: core.athleteName(it.athlete), results: [] });
    groups.get(it.athlete.id).results.push({ key: it.key, row: it.row, column: it.column, test: it.test.name, unit: it.test.unit, lower_better: !!it.test.lower_better, attempt: it.attempt, value: it.value, date: it.date,
      unusual: it.unusual || null, replaces: it.existing && !it.same ? it.existing.value : null, same: it.same, prev_best: it.prev_best, pr: it.pr && !it.same });
  }
  const summary = {
    created: items.filter((it) => !it.existing).length,
    replacing: items.filter((it) => it.existing && !it.same).length,
    unchanged: items.filter((it) => it.same).length,
    prs: items.filter((it) => it.pr && !it.same).length,
  };
  return {
    ok: true, format, source, day: day ? { id: day.id, name: day.name, date: day.date } : null,
    count: items.length, athletes: [...groups.values()], unusual, summary,
    pending: pending.map((p) => ({ row: p.row, sender: p.sender_label, test: p.test.name, unit: p.test.unit, value: p.value, date: p.date })),
    _items: items, _pending: pending,
  };
}

function saveSheet(check, confirmed, req, meta = {}) {
  const need = check.unusual.filter((u) => !confirmed.includes(u.key));
  if (need.length) return { error: `Confirm ${need.length} unusual ${need.length === 1 ? 'value' : 'values'} before saving, or fix the sheet.`, need: need.map((u) => u.key) };
  const dayId = check.day?.id ?? null;
  let saved = 0, prs = 0, pendingAdded = 0, skipped = 0, unchanged = 0, created = 0, replaced = 0;
  const batchItems = [], addedAthletes = [], addedTests = [];
  let batchId = null;
  tx(() => {
    for (const it of check._items) {
      if (dayId && run('INSERT OR IGNORE INTO testing_day_athletes (day_id, athlete_id) VALUES (?,?)', dayId, it.athlete.id).changes) addedAthletes.push(it.athlete.id);
      if (dayId && run('INSERT OR IGNORE INTO testing_day_tests (day_id, test_id, ord) VALUES (?,?,(SELECT COALESCE(MAX(ord),0)+1 FROM testing_day_tests WHERE day_id=?))', dayId, it.test.id, dayId).changes) addedTests.push(it.test.id);
      const before = dayId ? get('SELECT * FROM results WHERE athlete_id=? AND test_id=? AND day_id=? AND attempt=?', it.athlete.id, it.test.id, dayId, it.attempt)
        : get('SELECT * FROM results WHERE source_ref=?', it.ref);
      // The same value is already saved: leave it alone, so a stopwatch time keeps its source and hand-timed label.
      if (before && Math.abs(before.value - it.value) < 1e-9) { unchanged++; saved++; continue; }
      const r = core.saveResult({ athlete_id: it.athlete.id, test: it.test, day_id: dayId, attempt: it.attempt, value: it.value, unit_entered: it.unit_entered,
        source: 'upload', source_ref: dayId ? null : it.ref, recorded_at: `${it.date} 12:00:00`, created_by: req?.staff?.id }, { req });
      saved++; if (r.pr) prs++;
      if (before) replaced++; else created++;
      batchItems.push({ result_id: r.id, athlete_id: it.athlete.id, test_id: it.test.id, value: it.value, created: before ? 0 : 1,
        prev_value: before?.value ?? null, prev_unit_entered: before?.unit_entered ?? null, prev_hand_timed: before?.hand_timed ?? null,
        prev_source: before?.source ?? null, prev_recorded_at: before?.recorded_at ?? null, prev_created_by: before?.created_by ?? null });
    }
    for (const p of check._pending) {
      if (get('SELECT 1 FROM results WHERE source_ref=?', p.ref) || get('SELECT 1 FROM pending_results WHERE source_ref=?', p.ref)) { skipped++; continue; }
      const pid = insert('pending_results', { source: p.source, sender_key: p.sender_key, sender_label: p.sender_label, test_id: p.test.id, test_name: p.test.name, value: p.value, unit: p.test.unit, recorded_at: `${p.date} 12:00:00`, source_ref: p.ref });
      batchItems.push({ pending_id: pid, test_id: p.test.id, value: p.value });
      pendingAdded++;
    }
    if (batchItems.length) {
      batchId = insert('upload_batches', { filename: String(meta.filename || '').slice(0, 200) || null, source: check.source, format: check.format, day_id: dayId, day_name: check.day?.name ?? null,
        saved, created_count: created, replaced_count: replaced, pending: pendingAdded, prs, athletes: check.athletes.length,
        added_athletes: JSON.stringify(addedAthletes), added_tests: JSON.stringify(addedTests), created_by: req?.staff?.id ?? null });
      for (const b of batchItems) insert('upload_batch_items', { batch_id: batchId, ...b });
    }
  });
  const changed = created + replaced;
  log(req, 'Uploaded results', `${saved} result${saved === 1 ? '' : 's'}${check.day ? ' to ' + check.day.name : ''}${unchanged && changed ? ` (${unchanged} already saved)` : !changed && saved ? ' (all already saved)' : ''}${pendingAdded ? `, ${pendingAdded} waiting to be linked` : ''}`);
  return { saved, created, replaced, unchanged, prs, pending: pendingAdded, skipped, athletes: check.athletes.length, batch_id: batchId };
}

// Recent uploads for the Upload screen.
function recentBatches(limit = 10) {
  return all(`SELECT b.id, b.filename, b.source, b.format, b.day_id, COALESCE(d.name, b.day_name) AS day_name, (d.id IS NOT NULL) AS day_exists,
      b.saved, b.created_count AS created, b.replaced_count AS replaced, b.pending, b.prs, b.athletes, b.created_at, b.undone_at, b.undo_summary,
      s.name AS by_name, u.name AS undone_by_name
    FROM upload_batches b LEFT JOIN testing_days d ON d.id=b.day_id LEFT JOIN staff s ON s.id=b.created_by LEFT JOIN staff u ON u.id=b.undone_by
    ORDER BY b.id DESC LIMIT ?`, limit).map((b) => ({ ...b, day_exists: !!b.day_exists }));
}

// Undo one upload: remove the results it added, put back the values it replaced, and drop results still waiting
// to be linked. Anything changed since the upload (retyped, relinked, deleted) is left alone.
function undoBatch(id, req) {
  const b = get('SELECT * FROM upload_batches WHERE id=?', id);
  if (!b) return { notFound: true };
  if (b.undone_at) return { error: 'This upload was already undone.' };
  let removed = 0, restored = 0, kept = 0, pendingRemoved = 0;
  tx(() => {
    for (const it of all('SELECT * FROM upload_batch_items WHERE batch_id=? ORDER BY id DESC', b.id)) {
      if (it.pending_id) {
        if (run('DELETE FROM pending_results WHERE id=?', it.pending_id).changes) pendingRemoved++; else kept++;
        continue;
      }
      const r = get('SELECT id, value FROM results WHERE id=? AND athlete_id=? AND test_id=?', it.result_id, it.athlete_id, it.test_id);
      if (!r) continue; // already gone, e.g. the testing day was deleted
      if (Math.abs(r.value - it.value) > 1e-9) { kept++; continue; }
      if (it.created) { run('DELETE FROM results WHERE id=?', r.id); removed++; }
      else {
        run('UPDATE results SET value=?, unit_entered=?, hand_timed=?, source=?, recorded_at=?, created_by=? WHERE id=?',
          it.prev_value, it.prev_unit_entered, it.prev_hand_timed ?? 0, it.prev_source || 'manual', it.prev_recorded_at, it.prev_created_by, r.id);
        restored++;
      }
    }
    // Athletes and tests the upload put on the testing day come off again if they have no results there now.
    if (b.day_id && get('SELECT 1 FROM testing_days WHERE id=?', b.day_id)) {
      for (const aid of JSON.parse(b.added_athletes || '[]')) {
        if (!get('SELECT 1 FROM results WHERE day_id=? AND athlete_id=?', b.day_id, aid)) run('DELETE FROM testing_day_athletes WHERE day_id=? AND athlete_id=?', b.day_id, aid);
      }
      for (const tid of JSON.parse(b.added_tests || '[]')) {
        if (!get('SELECT 1 FROM results WHERE day_id=? AND test_id=?', b.day_id, tid)) run('DELETE FROM testing_day_tests WHERE day_id=? AND test_id=?', b.day_id, tid);
      }
    }
    const parts = [];
    if (removed) parts.push(`${removed} removed`);
    if (restored) parts.push(`${restored} put back to the earlier value`);
    if (pendingRemoved) parts.push(`${pendingRemoved} waiting result${pendingRemoved === 1 ? '' : 's'} dropped`);
    if (kept) parts.push(`${kept} left alone because ${kept === 1 ? 'it was' : 'they were'} changed or linked since`);
    run("UPDATE upload_batches SET undone_at=datetime('now'), undone_by=?, undo_summary=? WHERE id=?", req?.staff?.id ?? null, parts.join(', ') || 'Nothing to change', b.id);
  });
  log(req, 'Undid upload', `${b.filename || 'Pasted rows'}${b.day_name ? ` (${b.day_name})` : ''}: ${removed} removed, ${restored} restored${pendingRemoved ? `, ${pendingRemoved} waiting dropped` : ''}${kept ? `, ${kept} left alone` : ''}`);
  return { removed, restored, pending_removed: pendingRemoved, kept };
}

module.exports = { checkSheet, saveSheet, recentBatches, undoBatch, SOURCES, parseDate, nameMatches, parseHeader, guessSource, fmtNum };
