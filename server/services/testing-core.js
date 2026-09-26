// Testing & results: units, formatting, saving results with PR detection, device/API ingest,
// pending-result linking, progress (with Mirwald growth estimate) and name matching.
'use strict';
const { all, get, run, insert, tx } = require('../db');
const { sha256, emit, log } = require('../lib');

// ---- units ----------------------------------------------------------------
const FACTORS = { // to a base unit per dimension
  in: ['len', 2.54], cm: ['len', 1], m: ['len', 100], ft: ['len', 30.48],
  lb: ['mass', 0.45359237], kg: ['mass', 1],
};
const UNIT_CHOICES = { in: ['in', 'cm'], cm: ['cm', 'in'], ft: ['ft', 'm'], m: ['m', 'ft'], lb: ['lb', 'kg'], kg: ['kg', 'lb'] };
function unitsFor(unit) { return UNIT_CHOICES[unit] || [unit]; }
function normUnit(u) {
  const s = String(u || '').trim().toLowerCase().replace(/\.$/, '');
  const map = { inch: 'in', inches: 'in', '"': 'in', centimeters: 'cm', centimetres: 'cm', meters: 'm', metres: 'm', feet: 'ft', foot: 'ft', "'": 'ft',
    lbs: 'lb', pounds: 'lb', pound: 'lb', kgs: 'kg', kilograms: 'kg', sec: 's', secs: 's', seconds: 's', second: 's' };
  return map[s] || s;
}
// Convert value from one unit to another; returns null when the units don't convert.
function convert(v, from, to) {
  from = normUnit(from); to = normUnit(to);
  if (!from || !to || from === to) return v;
  const a = FACTORS[from], b = FACTORS[to];
  if (!a || !b || a[0] !== b[0]) return null;
  return (v * a[1]) / b[1];
}
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// Parse what someone typed: "5.94", "6'5\"", "6' 5", "6-5" (feet-inches for inch tests), "1:05.3" (min:sec).
function parseEntry(raw, unit) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const s = String(raw).trim().replace(/[′’]/g, "'").replace(/[″”]/g, '"').replace(/,/g, '');
  if (s === '') return null;
  if (unit === 'in') {
    const m = s.match(/^(\d+)\s*(?:'|ft)\s*(\d+(?:\.\d+)?)?\s*(?:"|in)?$/i) || s.match(/^(\d+)-(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 12 + Number(m[2] || 0);
  }
  if (unit === 's') {
    const m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

// ---- formatting (server copy of public/js/testing-format.js) ---------------
function trim(n, d) { return String(Number(n.toFixed(d))); }
function fmtValue(v, unit) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  v = Number(v);
  if (unit === 'in' && v >= 48) {
    const ft = Math.floor(v / 12); let inch = round(v - ft * 12, 1);
    return `${ft}′ ${Number.isInteger(inch) ? inch : inch.toFixed(1)}″`;
  }
  if (unit === 's') return v.toFixed(2) + ' s';
  if (unit === 'in' || unit === 'cm') return v.toFixed(1) + ' ' + unit;
  if (unit === 'ratio') return v.toFixed(2);
  if (unit === '%') return trim(v, 1) + '%';
  if (unit === 'level' || unit === 'reps') return trim(v, 1) + ' ' + unit;
  return trim(v, 2) + ' ' + unit;
}
function fmtRange(t) {
  const u = t.unit === 's' ? ' s' : ' ' + t.unit;
  return `${trim(t.min_value, 2)}–${trim(t.max_value, 2)}${u}`;
}

// ---- tests ------------------------------------------------------------------
const ALIASES = {
  '40': '40-yard dash', '40 yard': '40-yard dash', '40yd': '40-yard dash', 'dash_40yd': '40-yard dash', '40 yard dash': '40-yard dash', '40 time': '40-yard dash',
  '10 yard': '10-yard sprint', '10yd': '10-yard sprint', '20 yard': '20-yard sprint', '20yd': '20-yard sprint', '60 yard': '60-yard dash', '60yd': '60-yard dash',
  'vertical': 'Vertical jump', 'vert': 'Vertical jump', 'vertical jump (standing)': 'Vertical jump', 'standing vertical': 'Vertical jump', 'jump height': 'Vertical jump',
  'broad': 'Standing broad jump', 'broad jump': 'Standing broad jump', 'pro agility': 'Pro agility (5-10-5)', '5-10-5': 'Pro agility (5-10-5)', '5-10-5 pro agility': 'Pro agility (5-10-5)',
  'cmj': 'CMJ jump height', 'cmj height': 'CMJ jump height', 'rsi': 'RSI-modified', 'rsi mod': 'RSI-modified', 'rsimod': 'RSI-modified',
  'body weight': 'Weight', 'bodyweight': 'Weight', 'seated': 'Seated height', 'sitting height': 'Seated height', 'exit velo': 'Exit velocity', 'ev': 'Exit velocity',
  'bat speed': 'Bat speed', 'pitch velo': 'Pitch velocity', 'l-drill': '3-cone drill', '3 cone': '3-cone drill', 'mile': '1-mile run',
};
const key = (s) => String(s || '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
function findTest(nameOrId) {
  if (nameOrId == null || nameOrId === '') return null;
  if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId))) {
    const t = get('SELECT * FROM tests WHERE id=?', Number(nameOrId));
    if (t) return t;
  }
  const k = key(nameOrId);
  let t = get('SELECT * FROM tests WHERE lower(name)=?', k);
  if (!t && ALIASES[k]) t = get('SELECT * FROM tests WHERE name=?', ALIASES[k]);
  if (!t) t = get('SELECT * FROM tests WHERE lower(replace(name,\'-\',\' \'))=?', k.replace(/-/g, ' '));
  return t || null;
}
const inRange = (t, v) => (t.min_value == null || v >= t.min_value) && (t.max_value == null || v <= t.max_value);
const better = (t, a, b) => (t.lower_better ? a < b : a > b); // is a better than b
const bestOf = (t, vals) => vals.reduce((m, v) => (m == null || better(t, v, m) ? v : m), null);

// Validate + convert one value into the test's unit. Returns { value } or { error }.
function checkValue(t, raw, unitEntered) {
  const n = parseEntry(raw, normUnit(unitEntered) || t.unit);
  if (n == null) return { empty: true };
  if (Number.isNaN(n)) return { error: `"${String(raw).trim()}" isn't a number.` };
  const u = normUnit(unitEntered) || t.unit;
  const v = convert(n, u, t.unit);
  if (v == null) return { error: `${t.name} is measured in ${t.unit}, not ${u}.` };
  if (!inRange(t, v)) return { error: `${trim(n, 2)} ${u} isn't possible for ${t.name} (${fmtRange(t)}). Is it in the wrong column?`, value: round(v) };
  return { value: round(v), unit: u };
}

// ---- saving results -------------------------------------------------------
function athleteName(a) { return `${a.first_name} ${a.last_name}`; }

// Previous best for this athlete and test, leaving out one slot (the one being written).
function previousBest(t, athleteId, exclude = {}) {
  const rows = all(`SELECT value FROM results WHERE athlete_id=? AND test_id=?
    AND NOT (day_id IS ? AND attempt IS ? AND ? IS NOT NULL) AND (source_ref IS NULL OR source_ref IS NOT ?)`,
  athleteId, t.id, exclude.day_id ?? null, exclude.attempt ?? null, exclude.day_id ?? null, exclude.source_ref ?? null);
  return bestOf(t, rows.map((r) => r.value));
}

// Insert or replace one result. value must already be in the test's unit.
// Returns { id, pr, prev_best, created }.
function saveResult(o, { req, emitNow = true } = {}) {
  const t = o.test || get('SELECT * FROM tests WHERE id=?', o.test_id);
  const a = get('SELECT id, code, first_name, last_name, family_id FROM athletes WHERE id=?', o.athlete_id);
  const prev = previousBest(t, a.id, { day_id: o.day_id, attempt: o.attempt, source_ref: o.source_ref });
  const pr = prev != null && better(t, o.value, prev);
  const row = {
    athlete_id: a.id, test_id: t.id, day_id: o.day_id ?? null, attempt: o.attempt || 1, value: o.value,
    unit_entered: o.unit_entered || t.unit, hand_timed: o.hand_timed ? 1 : 0, source: o.source || 'manual',
    source_ref: o.source_ref ?? null, recorded_at: o.recorded_at || new Date().toISOString().replace('T', ' ').slice(0, 19), created_by: o.created_by ?? null,
  };
  let existing = null;
  if (row.day_id != null) existing = get('SELECT id, value FROM results WHERE athlete_id=? AND test_id=? AND day_id=? AND attempt=?', a.id, t.id, row.day_id, row.attempt);
  else if (row.source_ref) existing = get('SELECT id, value FROM results WHERE source_ref=?', row.source_ref);
  let id;
  if (existing) {
    run('UPDATE results SET value=?, unit_entered=?, hand_timed=?, source=?, recorded_at=COALESCE(?, recorded_at), created_by=COALESCE(?, created_by) WHERE id=?',
      row.value, row.unit_entered, row.hand_timed, row.source, o.recorded_at || null, row.created_by, existing.id);
    id = existing.id;
  } else id = insert('results', row);
  const changed = !existing || existing.value !== row.value;
  if (pr && changed) log(req || null, 'New PR', `${athleteName(a)}, ${t.name} ${fmtValue(row.value, t.unit)}`);
  // Day results reach webhooks when the day is shared; everything else right away.
  const day = row.day_id ? get('SELECT status FROM testing_days WHERE id=?', row.day_id) : null;
  if (emitNow && changed && (!day || day.status === 'shared')) emitResult(a, t, { ...row, id }, pr);
  return { id, pr: pr && changed, prev_best: prev, created: !existing };
}
function emitResult(a, t, r, pr) {
  const data = { id: r.id, athlete: { id: a.id, code: a.code, name: athleteName(a) }, test: t.name, unit: t.unit, value: r.value, attempt: r.attempt, day_id: r.day_id, source: r.source, hand_timed: !!r.hand_timed };
  emit('result.created', data);
  if (pr) emit('pr.set', data);
}

// ---- device / API ingest ----------------------------------------------------
// item: { athlete_id?, athlete_code?, device_id?, device_name?, source, test, value, unit?, recorded_at?, ref? }
// Validates everything first; returns { errors } or saves all and returns counts.
function ingest(items, { req, resultSource = 'api', refPrefix = 'api' } = {}) {
  const errors = [], prepared = [];
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object') { errors.push({ index: i, error: 'Each result must be an object.' }); return; }
    const source = String(it.source || '').trim() || 'api';
    const t = findTest(it.test ?? it.test_id);
    if (!t) { errors.push({ index: i, error: `"${it.test ?? ''}" doesn't match a test in the library.` }); return; }
    const c = checkValue(t, it.value, it.unit);
    if (c.empty) { errors.push({ index: i, error: 'value is missing.' }); return; }
    if (c.error) { errors.push({ index: i, error: c.error }); return; }
    let athlete = null;
    if (it.athlete_id != null && it.athlete_id !== '') athlete = get('SELECT id FROM athletes WHERE id=?', Number(it.athlete_id));
    if (!athlete && it.athlete_code) athlete = get('SELECT id FROM athletes WHERE code=? COLLATE NOCASE', String(it.athlete_code).trim());
    const senderKey = String(it.device_id || it.device_name || it.athlete_code || it.athlete_name || (it.athlete_id != null ? `athlete ${it.athlete_id}` : '') || 'unknown').trim();
    const senderLabel = String(it.device_name || it.athlete_name || it.device_id || senderKey);
    if (!athlete) {
      const link = get('SELECT athlete_id FROM device_links WHERE source=? COLLATE NOCASE AND sender_key=?', source, senderKey);
      if (link) athlete = { id: link.athlete_id };
    }
    let recorded = it.recorded_at ? new Date(it.recorded_at) : new Date();
    if (Number.isNaN(recorded.getTime())) { errors.push({ index: i, error: 'recorded_at isn\'t a date.' }); return; }
    recorded = recorded.toISOString().replace('T', ' ').slice(0, 19);
    const ref = it.ref ? `${refPrefix}:${source}:${it.ref}` : `${refPrefix}:${sha256([source, athlete?.id ?? senderKey, t.id, c.value, recorded].join('|')).slice(0, 32)}`;
    prepared.push({ i, t, value: c.value, unit: c.unit || t.unit, athlete, source, senderKey, senderLabel, recorded, ref });
  });
  if (errors.length) return { errors };
  const out = { saved: 0, pending: 0, duplicates: 0, prs: 0, results: [] };
  tx(() => {
    for (const p of prepared) {
      if (get('SELECT 1 FROM results WHERE source_ref=?', p.ref) || get('SELECT 1 FROM pending_results WHERE source_ref=?', p.ref)) {
        out.duplicates++; out.results.push({ index: p.i, status: 'duplicate' }); continue;
      }
      if (p.athlete) {
        const r = saveResult({ athlete_id: p.athlete.id, test: p.t, value: p.value, unit_entered: p.unit, source: resultSource, source_ref: p.ref, recorded_at: p.recorded }, { req });
        out.saved++; if (r.pr) out.prs++;
        out.results.push({ index: p.i, status: 'saved', id: r.id, pr: r.pr });
      } else {
        const id = insert('pending_results', { source: p.source, sender_key: p.senderKey, sender_label: p.senderLabel, test_id: p.t.id, test_name: p.t.name, value: p.value, unit: p.t.unit, recorded_at: p.recorded, source_ref: p.ref });
        out.pending++; out.results.push({ index: p.i, status: 'pending', id });
      }
    }
  });
  return out;
}

// ---- pending results --------------------------------------------------------
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Score how likely a sender label ("Coley P", "OKAFOR, Chidi") names an athlete. 0..1
function nameScore(label, a) {
  const l = norm(label);
  if (!l) return 0;
  if (l.replace(/ /g, '') === a.code.toLowerCase()) return 1;
  const toks = l.split(' ');
  const f = norm(a.first_name), la = norm(a.last_name);
  if (toks.join(' ') === `${f} ${la}` || toks.join(' ') === `${la} ${f}`) return 1;
  const firstLike = (tok) => tok === f ? 0.55 : (tok.length >= 3 && (f.startsWith(tok) || tok.startsWith(f))) ? 0.45 : (tok.length >= 3 && lev(tok, f) <= Math.max(1, Math.floor(f.length / 4))) ? 0.4 : 0;
  const lastLike = (tok) => tok === la ? 0.45 : tok.length === 1 && la[0] === tok ? 0.3 : (tok.length >= 3 && la.startsWith(tok)) ? 0.35 : (tok.length >= 4 && lev(tok, la) <= 1) ? 0.35 : 0;
  let best = 0;
  toks.forEach((ti, i) => toks.forEach((tj, j) => { if (i !== j) best = Math.max(best, firstLike(ti) + lastLike(tj)); }));
  if (toks.length === 1) best = Math.max(firstLike(toks[0]) * 0.8, lastLike(toks[0]) * 0.8);
  return Math.min(1, best);
}
function suggest(label, limit = 3) {
  const athletes = all('SELECT id, code, first_name, last_name FROM athletes WHERE archived=0');
  return athletes.map((a) => ({ ...a, score: nameScore(label, a) })).filter((a) => a.score >= 0.6)
    .sort((x, y) => y.score - x.score).slice(0, limit).map(({ id, code, first_name, last_name }) => ({ id, code, first_name, last_name }));
}
function pendingGroups() {
  const rows = all('SELECT * FROM pending_results ORDER BY created_at, id');
  const groups = new Map();
  for (const r of rows) {
    const k = r.source + '\u0000' + r.sender_key;
    if (!groups.has(k)) groups.set(k, { source: r.source, sender_key: r.sender_key, sender_label: r.sender_label || r.sender_key, received_at: r.created_at, results: [] });
    const g = groups.get(k);
    g.results.push({ id: r.id, test_id: r.test_id, test: r.test_name, value: r.value, unit: r.unit, recorded_at: r.recorded_at });
    if (r.created_at > g.received_at) g.received_at = r.created_at;
  }
  return [...groups.values()].map((g) => ({ ...g, suggestions: suggest(g.sender_label).concat(g.sender_label !== g.sender_key ? suggest(g.sender_key) : []).filter((a, i, arr) => arr.findIndex((b) => b.id === a.id) === i).slice(0, 3) }));
}
function linkPending(ids, athleteId, remember, req) {
  const a = get('SELECT * FROM athletes WHERE id=?', athleteId);
  if (!a) return { error: 'Pick an athlete to link these results to.' };
  const rows = ids.map((id) => get('SELECT * FROM pending_results WHERE id=?', id)).filter(Boolean);
  if (!rows.length) return { error: 'Those results were already linked or discarded.' };
  let prs = 0;
  tx(() => {
    for (const p of rows) {
      const t = get('SELECT * FROM tests WHERE id=?', p.test_id) || findTest(p.test_name);
      if (!t) continue;
      const r = saveResult({ athlete_id: a.id, test: t, value: p.value, unit_entered: p.unit, source: 'device', source_ref: p.source_ref || `pending:${p.id}`, recorded_at: p.recorded_at }, { req });
      if (r.pr) prs++;
      run('DELETE FROM pending_results WHERE id=?', p.id);
    }
    if (remember) {
      const senders = new Map(rows.map((p) => [p.source + '\u0000' + p.sender_key, p]));
      for (const p of senders.values()) {
        run(`INSERT INTO device_links (source, sender_key, sender_label, athlete_id) VALUES (?,?,?,?)
          ON CONFLICT(source, sender_key) DO UPDATE SET athlete_id=excluded.athlete_id, sender_label=excluded.sender_label`, p.source, p.sender_key, p.sender_label, a.id);
      }
    }
  });
  log(req, 'Linked results', `${rows.length} from ${rows[0].sender_label || rows[0].sender_key} (${rows[0].source}) to ${athleteName(a)}${remember ? ', remembered' : ''}`);
  return { linked: rows.length, prs };
}

// ---- growth: Mirwald et al. (2002) maturity offset ---------------------------
function growthEstimate({ sex, age, height_cm, seated_cm, weight_kg }) {
  const leg = height_cm - seated_cm;
  let mo;
  if (sex === 'M') mo = -9.236 + 0.0002708 * (leg * seated_cm) - 0.001663 * (age * leg) + 0.007216 * (age * seated_cm) + 0.02292 * ((weight_kg / height_cm) * 100);
  else mo = -9.376 + 0.0001882 * (leg * seated_cm) + 0.0022 * (age * leg) + 0.005841 * (age * seated_cm) - 0.002658 * (age * weight_kg) + 0.07693 * ((weight_kg / height_cm) * 100);
  const status = mo < -1 ? 'Before growth spurt' : mo > 1 ? 'After growth spurt' : 'In growth spurt';
  return { maturity_offset: round(mo, 2), phv_age: round(age - mo, 1), status };
}
function decimalAge(birthday, on) {
  return (new Date(on + 'T12:00:00') - new Date(birthday + 'T12:00:00')) / (365.2425 * 864e5);
}

// ---- progress -----------------------------------------------------------------
// view: 'staff' (every result, flags unshared) or 'parent' (honours results_visibility).
function progress(athleteId, { view = 'staff', visibility = 'shared' } = {}) {
  const a = get('SELECT id, code, first_name, last_name, birthday, sex, sport, position, school FROM athletes WHERE id=?', athleteId);
  if (!a) return null;
  const onlyShared = view === 'parent' && visibility !== 'immediate';
  const rows = all(`SELECT r.value, r.test_id, r.day_id, r.hand_timed, COALESCE(d.date, substr(r.recorded_at,1,10)) AS date, d.status AS day_status, d.name AS day_name,
      t.name, t.category, t.unit, t.lower_better
    FROM results r JOIN tests t ON t.id=r.test_id LEFT JOIN testing_days d ON d.id=r.day_id
    WHERE r.athlete_id=? ${onlyShared ? "AND (r.day_id IS NULL OR d.status='shared')" : ''}
    ORDER BY date, r.id`, a.id);
  const unshared = view === 'staff' && rows.some((r) => r.day_id && r.day_status !== 'shared');
  const byTest = new Map();
  for (const r of rows) {
    if (!byTest.has(r.test_id)) byTest.set(r.test_id, { t: { id: r.test_id, name: r.name, category: r.category, unit: r.unit, lower_better: r.lower_better }, byDate: new Map(), hand: false });
    const g = byTest.get(r.test_id);
    if (r.hand_timed) g.hand = true;
    const cur = g.byDate.get(r.date);
    if (cur == null || better(g.t, r.value, cur)) g.byDate.set(r.date, r.value);
  }
  const lastDate = rows.length ? rows[rows.length - 1].date : null;
  const tests = [], improvements = [], prs = [];
  const pctOf = (t, first, latest) => (first ? round(((t.lower_better ? first - latest : latest - first) / Math.abs(first)) * 100, 1) : 0);
  for (const { t, byDate, hand } of byTest.values()) {
    const history = [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([date, value]) => ({ date, value }));
    const first = history[0].value, latest = history[history.length - 1].value;
    const best = bestOf(t, history.map((h) => h.value));
    const change = round(latest - first);
    tests.push({ test_id: t.id, name: t.name, category: t.category, unit: t.unit, lower_better: !!t.lower_better, best, first, latest, change,
      pct: history.length > 1 ? pctOf(t, first, latest) : null, count: history.length, hand_timed: hand, history });
    if (t.category === 'Body' || history.length < 2) continue;
    const pct = pctOf(t, first, latest);
    if (pct > 0) improvements.push({ test: t.name, unit: t.unit, first, latest, change, pct });
    const last = history[history.length - 1];
    const prior = bestOf(t, history.slice(0, -1).map((h) => h.value));
    const recent = lastDate && (new Date(lastDate) - new Date(last.date)) / 864e5 <= 30;
    if (recent && better(t, last.value, prior)) prs.push({ test: t.name, unit: t.unit, value: last.value, date: last.date });
  }
  const catOrder = ['Speed', 'Agility', 'Power', 'Strength', 'Endurance', 'Mobility', 'Force plate', 'Baseball', 'Basketball', 'Hockey', 'Soccer', 'Body'];
  tests.sort((x, y) => (catOrder.indexOf(x.category) - catOrder.indexOf(y.category)) || x.name.localeCompare(y.name));
  improvements.sort((x, y) => y.pct - x.pct);

  // Coach's note: latest testing day with a note that this athlete took part in.
  const note = get(`SELECT d.note AS text, d.name AS day_name, d.date FROM testing_days d
    WHERE d.note IS NOT NULL AND d.note != '' ${onlyShared || view === 'parent' ? "AND d.status='shared'" : ''}
      AND (EXISTS (SELECT 1 FROM testing_day_athletes x WHERE x.day_id=d.id AND x.athlete_id=?) OR EXISTS (SELECT 1 FROM results r WHERE r.day_id=d.id AND r.athlete_id=?))
    ORDER BY d.date DESC, d.id DESC LIMIT 1`, a.id, a.id) || null;

  // Growth
  let growth = null;
  const latestOf = (name) => { const x = tests.find((t) => t.name === name); return x ? x.history[x.history.length - 1] : null; };
  const H = latestOf('Height'), S = latestOf('Seated height'), W = latestOf('Weight');
  if (a.birthday && a.sex && H && S && W) {
    const on = H.date;
    const age = decimalAge(a.birthday, on);
    const est = growthEstimate({ sex: a.sex, age, height_cm: convert(H.value, 'in', 'cm'), seated_cm: convert(S.value, 'in', 'cm'), weight_kg: convert(W.value, 'lb', 'kg') });
    growth = { height: H.value, seated_height: S.value, weight: W.value, date: on, age: round(age, 1), ...est };
  }
  const days = all(`SELECT DISTINCT d.id, d.name, d.date, d.status FROM testing_days d JOIN results r ON r.day_id=d.id
    WHERE r.athlete_id=? ${onlyShared ? "AND d.status='shared'" : ''} ORDER BY d.date DESC`, a.id);
  return {
    athlete: { id: a.id, code: a.code, first_name: a.first_name, last_name: a.last_name, birthday: a.birthday, sex: a.sex, sport: a.sport, position: a.position, school: a.school },
    note, improvements: improvements.slice(0, 3), prs, tests, growth, unshared, days,
    first_date: rows[0]?.date || null, last_date: lastDate,
  };
}

module.exports = {
  unitsFor, normUnit, convert, parseEntry, fmtValue, fmtRange, round, findTest, inRange, better, bestOf, checkValue,
  previousBest, saveResult, emitResult, ingest, suggest, nameScore, pendingGroups, linkPending, growthEstimate, decimalAge, progress, athleteName,
};
