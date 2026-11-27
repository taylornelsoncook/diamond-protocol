import { newId, sha256, badRequest, HttpError, zonedToUtc, isDate, isTime } from '../util.js';
import { readXlsx, listSheets } from './xlsx.js';
import { recordResults, linkAthlete, resolveAthlete, identityOf, getTest, rangeOf, outOfRange } from './performance.js';
import { convert } from './units.js';
import { recordSets, rowsToSets, guessMapping as guessVbtMapping } from './vbt.js';
import { createImportedProfile } from './clients.js';
import { getSetting } from './families.js';

// The OVR Connect export (owner's ask: "create profiles every time a person is uploaded using the OVR file"): one Excel
// workbook with a sheet per product (Velocity, Jump, Sprint, Force, Force Jump, Force Landing, Force Reps), one row per
// rep or split, and the athlete only by the name typed in OVR (no ID, no email, no birthday). Results land the usual
// way (an Athlete ID typed as the name, or a name linked to a profile once); a person nobody linked yet gets a new
// profile, unless their name looks like someone already on file, in which case the coach chooses (names are never
// matched on their own). Everything is checked first and saved in one transaction, so nothing is saved until the
// whole workbook is clean; values a device can't really have recorded (a gate tripped early) are listed by sheet and
// row and left out only when the coach says so.
export const PROVIDER = 'ovr';
export const SOURCE = 'csv:ovr';
const SHEETS = ['Velocity', 'Jump', 'Sprint', 'Force', 'Force Jump', 'Force Landing', 'Force Reps'];
const MAX_BYTES = 10 * 1024 * 1024;

// Which of our tests each OVR exercise is. [test, metric, column, unit]. Exercises not listed are counted and left out
// (said in the preview), never guessed.
const DROP = [['drop_jump', 'rsi', 'RSI', 'ratio'], ['drop_jump', 'jump_height', 'Jump Height (in)', 'in'], ['drop_jump', 'contact_time', 'GCT (s)', 's']];
const JUMPS = {
  'countermovement jump (cmj)': [['cmj', 'jump_height', 'Jump Height (in)', 'in']],
  'approach jump': [['vertical_max', 'height', 'Jump Height (in)', 'in']],
  'depth jump': DROP,
  'drop jump': DROP
};
const FORCE_JUMPS = {
  'countermovement jump (cmj)': [['cmj', 'jump_height', 'Jump Height (in)', 'in'], ['cmj', 'rsi_mod', 'mRSI', 'ratio'], ['cmj', 'peak_power', 'Peak Propulsive Power (W)', 'W'],
    ['cmj', 'peak_power_rel', 'Rel. Propulsive Power (W/kg)', 'W/kg'], ['cmj', 'peak_force', 'Peak Propulsive Force (N)', 'N'], ['cmj', 'braking_rfd', 'Braking RFD (N/s)', 'N/s'],
    ['cmj', 'time_to_takeoff', 'Time to Takeoff (s)', 's']]
};
// Sprints are one row per split; a rep is athlete + day + exercise + sprint number.
const SPRINTS = {
  '10yd sprint': (rep) => [['dash_10yd', 'time', rep.total, 's']],
  'flying 10yd': (rep) => [['flying_10yd', 'time', rep.lastSplit, 's'], ['sprint_speed', 'speed', rep.topSpeed, 'mph']],
  '40yd sprint': (rep) => [['dash_40yd', 'time', rep.total, 's'], ['dash_40yd', 'split_10', rep.at(10), 's'], ['dash_40yd', 'split_20', rep.at(20), 's'], ['sprint_speed', 'speed', rep.topSpeed, 'mph']]
};
const DEVICE = { Jump: 'OVR Jump', Sprint: 'OVR Sprint', 'Force Jump': 'OVR Force', Velocity: 'OVR Velocity' };

export const normName = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const num = (x) => { const t = String(x ?? '').trim(); if (t === '') return null; const n = Number(t.replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const excelDay = (x) => (/^\d{5}(\.\d+)?$/.test(String(x)) ? new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(x)) * 86400000).toISOString().slice(0, 10) : String(x ?? '').trim());
const excelTime = (x) => {
  const t = String(x ?? '').trim();
  if (/^0?\.\d+$|^0$/.test(t)) { const m = Math.round(Number(t) * 1440); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t;
};

// ---------- Reading the workbook ----------
export function readWorkbook(body) {
  const b64 = body?.xlsx_base64 ?? body?.file?.xlsx_base64;
  if (!b64) throw badRequest('Upload the OVR export as an Excel file (.xlsx). In OVR Connect: Profile → Export history.');
  if (String(b64).length > MAX_BYTES * 1.4) throw badRequest('That file is over 10 MB. Export a shorter date range from OVR Connect and upload each part.');
  let buf, names;
  try { buf = Buffer.from(String(b64).replace(/^data:[^,]*,/, ''), 'base64'); names = listSheets(buf).map((s) => (typeof s === 'string' ? s : s.name)); }
  catch (e) { throw badRequest(`That file couldn't be read as Excel (${e.message}). Export it again from OVR Connect as .xlsx.`); }
  const found = SHEETS.filter((n) => names.includes(n));
  if (!found.length || !names.length) throw badRequest(`This doesn't look like an OVR Connect export: it has no ${SHEETS.slice(0, 3).join(', ')} or Force sheet. Use Upload results for other spreadsheets.`);
  const sheets = {};
  for (const n of found) {
    const rows = readXlsx(buf, n).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
    if (!rows.length) continue;
    const headers = rows[0].map((h) => String(h ?? '').trim());
    if (!headers.includes('Athlete')) throw badRequest(`The ${n} sheet has no Athlete column. Export it again from OVR Connect.`);
    sheets[n] = rows.slice(1).map((r, i) => ({ row: i + 2, ...Object.fromEntries(headers.map((h, j) => [h, String(r[j] ?? '').trim()])) }));
  }
  return { sheets, other_sheets: names.filter((n) => !SHEETS.includes(n)) };
}

// ---------- Turning rows into results ----------
// Every result says which person (by normalized name), which sheet and row, and a stable external id so the same
// export (or an overlapping later one) imported again adds nothing.
export function planWorkbook(ctx, { sheets }) {
  const tz = getSetting(ctx, 'timezone');
  const people = new Map(), items = [], sets = [], problems = [], leftOut = new Map();
  const person = (r) => {
    const name = String(r.Athlete ?? '').replace(/\s+/g, ' ').trim();
    if (!name) return null;
    const key = identityOf({ name });
    if (!people.has(key)) people.set(key, { key, name, sport: null, position: null, groups: new Set(), results: 0, sets: 0, sheets: new Set() });
    const p = people.get(key);
    if (!p.sport && r.Sport) p.sport = r.Sport.trim() || null;
    if (!p.position && r.Position) p.position = r.Position.trim() || null;
    for (const g of String(r['Group(s)'] ?? '').split(/[,;|]/)) if (g.trim()) p.groups.add(g.trim());
    return p;
  };
  const when = (sheet, r) => {
    const day = excelDay(r.Date), time = excelTime(r.Time || '12:00');
    if (!isDate(day)) { problems.push({ sheet, row: r.row, column: 'Date', message: `"${r.Date}" isn't a date. OVR writes dates like 2026-11-23.` }); return null; }
    return { day, at: zonedToUtc(day, isTime(time) ? time : '12:00', tz) };
  };
  const leave = (sheet, exercise) => { const k = `${sheet}: ${exercise || '(no exercise)'}`; leftOut.set(k, (leftOut.get(k) ?? 0) + 1); };
  const tests = new Map();
  const add = (sheet, r, p, w, [test, metric, column, unit], raw, extKey) => {
    if (raw == null) return;
    if (!tests.has(test)) tests.set(test, getTest(ctx, test));
    const t = tests.get(test), m = t.metrics.find((x) => x.key === metric);
    const value = convert(raw, unit, m.unit), range = rangeOf(t, m);
    const item = { key: `${sheet}:${r.row}:${metric}`, person: p.key, sheet, row: r.row, column, test, metric, value: +value.toFixed(6), unit: m.unit, day: w.day, recorded_at: w.at,
      device: DEVICE[sheet], timing: sheet === 'Sprint' ? 'electronic' : undefined, external_id: `ovr:${sha256(`${p.key}|${extKey}|${metric}`).slice(0, 32)}`, test_name: t.name, metric_name: m.name };
    if (outOfRange(value, range)) item.impossible = `${+value.toFixed(3)} ${m.unit} isn't possible for ${t.name}${metric === t.metrics[0].key ? '' : ` (${m.name})`}.`;
    items.push(item); p.results++; p.sheets.add(sheet);
  };

  for (const [sheet, table] of [['Jump', JUMPS], ['Force Jump', FORCE_JUMPS]]) {
    for (const r of sheets[sheet] ?? []) {
      const p = person(r); if (!p) { if (Object.values(r).some(Boolean)) problems.push({ sheet, row: r.row, column: 'Athlete', message: 'This row has no athlete name.' }); continue; }
      const map = table[normName(r.Exercise).replace(/ cmj$/, ' (cmj)')] ?? table[String(r.Exercise ?? '').trim().toLowerCase()];
      if (!map) { leave(sheet, r.Exercise); continue; }
      const w = when(sheet, r); if (!w) continue;
      for (const spec of map) add(sheet, r, p, w, spec, num(r[spec[2]]), `${sheet}|${w.day}|${r.Time}|${r.Exercise}|${r['Set #']}|${r['Rep #']}`);
    }
  }
  // Sprints: fold the splits of one rep together.
  const reps = new Map();
  for (const r of sheets.Sprint ?? []) {
    const p = person(r); if (!p) { if (Object.values(r).some(Boolean)) problems.push({ sheet: 'Sprint', row: r.row, column: 'Athlete', message: 'This row has no athlete name.' }); continue; }
    const kind = String(r.Exercise ?? '').trim().toLowerCase();
    if (!SPRINTS[kind]) { leave('Sprint', r.Exercise); continue; }
    const w = when('Sprint', r); if (!w) continue;
    const k = `${p.key}|${w.day}|${kind}|${r['Sprint #']}|${r.Time}`;
    if (!reps.has(k)) reps.set(k, { p, w, kind, first: r, splits: [] });
    reps.get(k).splits.push({ r, no: num(r['Split #']) ?? 0, dist: num(r['Distance (yd)']), total: num(r['Total Time (s)']), split: num(r['Split Time (s)']), speed: num(r['Speed (mph)']) });
  }
  for (const [k, rep] of reps) {
    const s = rep.splits.sort((a, b) => a.no - b.no);
    // Distances per split may be each split's length (10, 10, 20) or the distance so far (10, 20, 40).
    const goal = Number(rep.kind.match(/(\d+)yd/)?.[1] ?? 0), lens = s.map((x) => x.dist ?? 0);
    const cumulative = lens.reduce((a, b) => a + b, 0) !== goal;
    let run = 0;
    const at = s.map((x) => { run = cumulative ? (x.dist ?? 0) : run + (x.dist ?? 0); return { d: run, total: x.total }; });
    const shape = { total: s[s.length - 1].total ?? at.reduce((a, x) => a + (x.total ?? 0), 0), lastSplit: s[s.length - 1].split ?? s[s.length - 1].total,
      topSpeed: s.map((x) => x.speed).filter((x) => x != null).reduce((a, b) => Math.max(a, b), -Infinity), at: (d) => (s.length > 1 ? at.find((x) => x.d === d)?.total ?? null : null) };
    if (!Number.isFinite(shape.topSpeed)) shape.topSpeed = null;
    for (const [test, metric, value, unit] of SPRINTS[rep.kind](shape)) add('Sprint', rep.first, rep.p, rep.w, [test, metric, metric === 'speed' ? 'Speed (mph)' : 'Total Time (s)', unit], value, k);
  }
  // Velocity: bar speed, one row per rep folded into sets by the bar-speed reader.
  if (sheets.Velocity?.length) {
    // The bar-speed reader takes one date-and-time column: OVR's Date and Time become one moment in the business's time zone.
    const rows = sheets.Velocity.map(({ row, Time, ...r }) => {
      const day = excelDay(r.Date), time = excelTime(Time || '12:00');
      return { ...r, Date: isDate(day) ? zonedToUtc(day, isTime(time) ? time : '12:00', tz) : r.Date };
    });
    const out = rowsToSets(ctx, rows, guessVbtMapping(Object.keys(rows[0])), { provider: PROVIDER });
    for (const pr of out.problems) problems.push({ sheet: 'Velocity', row: pr.row, column: pr.column ?? null, message: pr.message });
    for (const s of out.sets) {
      const p = person({ Athlete: s.athlete?.name ?? '', ...rows[(s.row ?? 2) - 2] });
      if (!p) continue;
      p.sets++; p.sheets.add('Velocity');
      sets.push({ person: p.key, row: s.row, set: s.set });
    }
  }
  // Attempt numbers: each athlete's tries at one test and metric on one day, in the order they were done.
  const seq = new Map();
  for (const it of [...items].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.row - b.row)) {
    const k = `${it.person}|${it.test}|${it.metric}|${it.day}`;
    seq.set(k, (seq.get(k) ?? 0) + 1); it.attempt = seq.get(k);
  }
  return { people: [...people.values()].map((p) => ({ ...p, groups: [...p.groups], sheets: [...p.sheets] })), items, sets, problems,
    left_out: [...leftOut].map(([what, rows]) => ({ what, rows })) };
}

// ---------- Who each person is ----------
const lev = (a, b) => {
  if (a === b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
};
// Profiles whose name could be this person's: the same name, the same first and last name, a spelling a letter or two
// off, or the same last name with one first name the start of the other (Ben, Benjamin). Only ever offered.
export function lookAlikes(ctx, name, everyone = null) {
  const n = normName(name), w = n.split(' ');
  const first = w[0], last = w[w.length - 1];
  const all = everyone ?? ctx.db.all(`SELECT id, name, athlete_id, archived_at, birth_date, family_id FROM clients WHERE athlete_id IS NOT NULL AND access_token NOT LIKE 'gone_%'`);
  const out = [];
  for (const c of all) {
    const m = normName(c.name), x = m.split(' ');
    const f2 = x[0], l2 = x[x.length - 1];
    let why = null;
    if (m === n) why = 'Same name';
    else if (w.length > 1 && x.length > 1 && f2 === first && l2 === last) why = 'Same first and last name';
    else if (Math.min(n.length, m.length) >= 6 && lev(n, m) <= 2) why = 'Spelled almost the same';
    else if (w.length > 1 && x.length > 1 && l2 === last && first.length >= 2 && f2.length >= 2 && (f2.startsWith(first) || first.startsWith(f2))) why = 'Same last name, a short first name';
    if (why) out.push({ client_id: c.id, name: c.name, athlete_id: c.athlete_id, archived: !!c.archived_at, has_family: !!c.family_id, why });
  }
  const rank = ['Same name', 'Same first and last name', 'Spelled almost the same', 'Same last name, a short first name'];
  return out.sort((a, b) => rank.indexOf(a.why) - rank.indexOf(b.why)).slice(0, 3);
}

// Each person: `linked` (found by an earlier link or an Athlete ID typed as the name), `new` (no profile looks like them:
// a profile is made), or `check` (one or more look alike: the coach says who, or new, or wait). decisions maps a
// person's key to a client id, 'new' or 'wait' (their results wait to be linked by hand, as before).
function decide(ctx, people, decisions = {}, { createProfiles = true } = {}) {
  const everyone = ctx.db.all(`SELECT id, name, athlete_id, archived_at, birth_date, family_id FROM clients WHERE athlete_id IS NOT NULL AND access_token NOT LIKE 'gone_%'`);
  const problems = [], open = [];
  const out = people.map((p) => {
    const found = resolveAthlete(ctx, { name: p.name }, PROVIDER);
    const c = found ? ctx.db.get('SELECT id, name, athlete_id, archived_at FROM clients WHERE id = ?', found.client_id) : null;
    const alike = c ? [] : lookAlikes(ctx, p.name, everyone);
    const base = { key: p.key, name: p.name, sport: p.sport, position: p.position, groups: p.groups, results: p.results, sets: p.sets, sheets: p.sheets };
    if (c) {
      if (c.archived_at) problems.push({ sheet: null, row: null, column: 'Athlete', message: `${p.name} is linked to ${c.name} (${c.athlete_id}), who is archived. Restore the profile first, or unlink the name under Linked devices.` });
      return { ...base, status: 'linked', action: 'link', client: { client_id: c.id, name: c.name, athlete_id: c.athlete_id } };
    }
    const status = alike.length ? 'check' : 'new';
    const d = decisions?.[p.key];
    if (d === 'new' || d === 'wait') return { ...base, status, look_alikes: alike, action: d };
    if (d) {
      const pick = ctx.db.get(`SELECT id, name, athlete_id, archived_at FROM clients WHERE id = ? AND access_token NOT LIKE 'gone_%'`, String(d));
      if (!pick) { problems.push({ sheet: null, row: null, column: 'Athlete', message: `The profile chosen for ${p.name} isn't on file any more. Choose again.` }); return { ...base, status, look_alikes: alike, action: 'wait' }; }
      if (pick.archived_at) { problems.push({ sheet: null, row: null, column: 'Athlete', message: `${pick.name} (${pick.athlete_id}), chosen for ${p.name}, is archived. Restore the profile first, or choose again.` }); return { ...base, status, look_alikes: alike, action: 'wait' }; }
      return { ...base, status, look_alikes: alike, action: 'link', client: { client_id: pick.id, name: pick.name, athlete_id: pick.athlete_id }, chosen: true };
    }
    if (status === 'check') { open.push(p.key); return { ...base, status, look_alikes: alike, action: 'wait', undecided: true }; }
    return { ...base, status, look_alikes: [], action: createProfiles ? 'new' : 'wait' };
  });
  return { people: out, problems, open };
}

// ---------- Preview and import ----------
// body: xlsx_base64, filename, people { key: client_id | 'new' | 'wait' }, create_profiles (default true),
// leave_out_impossible (true once the coach has seen the values a device can't have recorded).
// A preview runs the whole import in a transaction and rolls it back, so it shows exactly what saving would do,
// including the Athlete IDs new profiles would get.
export function importWorkbook(ctx, body = {}, { user = null, dryRun = false } = {}) {
  const wb = readWorkbook(body);
  const plan = planWorkbook(ctx, wb);
  if (!plan.items.length && !plan.sets.length && !plan.problems.length) throw badRequest(`No results we can bring in were found. ${plan.left_out.length ? `Left out: ${plan.left_out.map((x) => x.what).join(', ')}.` : ''}`.trim());
  const owner = user?.role === 'owner';
  const people = decide(ctx, plan.people, body.people, { createProfiles: body.create_profiles !== false });
  const impossible = plan.items.filter((it) => it.impossible);
  const problems = [...plan.problems, ...people.problems];
  const dropImpossible = body.leave_out_impossible === true;
  if (!dryRun) {
    if (problems.length) throw Object.assign(badRequest(`Nothing was saved. ${problems.length} ${problems.length === 1 ? 'problem needs' : 'problems need'} fixing first.`, 'import_problems'), { details: { problems: problems.slice(0, 200) } });
    if (impossible.length && !dropImpossible) {
      const e = new HttpError(409, 'impossible_values', `Nothing was saved. ${impossible.length} ${impossible.length === 1 ? 'value isn\'t' : 'values aren\'t'} possible (a gate or mat misread). Leave ${impossible.length === 1 ? 'it' : 'them'} out to import the rest.`);
      e.details = { values: impossible.slice(0, 200).map(shapeValue) }; throw e;
    }
    if (people.open.length) {
      const e = new HttpError(409, 'people_to_check', `Nothing was saved. ${people.open.length} ${people.open.length === 1 ? 'name looks' : 'names look'} like someone already on file. Say who each one is first.`);
      e.details = { people: people.people.filter((p) => p.undecided) }; throw e;
    }
  }
  const items = plan.items.filter((it) => !(it.impossible && (dropImpossible || dryRun)));
  const ROLLBACK = Symbol('preview');
  let result;
  try {
    ctx.db.tx(() => {
      result = write(ctx, { plan, items, people: people.people, owner, user, filename: body.filename });
      if (dryRun) throw ROLLBACK;
    });
  } catch (e) { if (e !== ROLLBACK) throw e; }
  const summary = {
    filename: body.filename ? String(body.filename).slice(0, 200) : null,
    sheets: Object.fromEntries(Object.entries(wb.sheets).map(([k, rows]) => [k, rows.length])),
    results_found: plan.items.length, sets_found: plan.sets.length,
    people: result.people, counts: countsOf(result.people),
    impossible: impossible.slice(0, 200).map(shapeValue), impossible_count: impossible.length,
    problems: problems.slice(0, 200), problem_count: problems.length, to_check: people.open.length,
    left_out: plan.left_out, bar_speed_left_out: plan.sets.length && !owner ? 'Bar speed (the Velocity sheet) is brought in by the owner.' : null
  };
  if (dryRun) return { preview: true, ...summary, will_save: result.saved, will_wait: result.waiting, already_saved: result.duplicates, bar_speed_sets: result.bar_speed, ready: !problems.length && !people.open.length };
  return { batch_id: result.batch_id, ...summary, saved: result.saved, waiting: result.waiting, already_saved: result.duplicates, bar_speed_sets: result.bar_speed, prs: result.prs };
}
const shapeValue = (it) => ({ sheet: it.sheet, row: it.row, column: it.column, athlete: it.person.replace(/^name:/, ''), test: it.test_name, metric: it.metric_name, value: it.value, unit: it.unit, day: it.day, message: it.impossible });
const countsOf = (people) => ({ people: people.length, linked: people.filter((p) => p.status === 'linked').length, made: people.filter((p) => p.made).length,
  chosen: people.filter((p) => p.chosen).length, waiting: people.filter((p) => p.action === 'wait').length, to_check: people.filter((p) => p.undecided).length });

function write(ctx, { plan, items, people, owner, user, filename }) {
  const batchId = newId('imp');
  const byKey = new Map();
  const shaped = people.map((p) => {
    let client = p.client ?? null, made = false;
    if (p.action === 'new') { client = createImportedProfile(ctx, { name: p.name, sport: p.sport, position: p.position, batchId }); made = true; }
    // The coach chose (or a new profile was made for) this name: OVR results under it go there from now on.
    if (client && (made || p.chosen)) linkAthlete(ctx, { provider: PROVIDER, external_id: p.key, external_name: p.name, client_id: client.client_id });
    byKey.set(p.key, client?.client_id ?? null);
    const { look_alikes, ...rest } = p;
    return { ...rest, ...(look_alikes?.length ? { look_alikes } : {}), client, made };
  });
  let saved = 0, duplicates = 0, waiting = 0, prs = 0;
  const resultIds = [], queued = [];
  for (let i = 0; i < items.length; i += 1000) {
    const part = items.slice(i, i + 1000);
    const r = recordResults(ctx, part.map((it) => ({ ...(byKey.get(it.person) ? { client_id: byKey.get(it.person) } : { athlete: { name: it.person.replace(/^name:/, '') } }),
      test: it.test, metric: it.metric, value: it.value, unit: it.unit, attempt: it.attempt, recorded_at: it.recorded_at, device: it.device, timing: it.timing, external_id: it.external_id })),
    { source: SOURCE, provider: PROVIDER, internal: true });
    if (r.errors.length) {
      const e = badRequest(`Nothing was saved. ${r.errors.length} ${r.errors.length === 1 ? 'result' : 'results'} couldn't be stored.`, 'import_problems');
      e.details = { problems: r.errors.slice(0, 200).map((x) => ({ sheet: part[x.index]?.sheet, row: part[x.index]?.row, column: part[x.index]?.column, message: x.message })) };
      throw e;
    }
    saved += r.created; duplicates += r.duplicates; waiting += r.unmatched.length; prs += r.prs.length;
    resultIds.push(...r.results); queued.push(...r.new_queue_ids);
  }
  let vbtImportId = null, barSpeed = 0;
  if (owner && plan.sets.length) {
    vbtImportId = newId('vimp');
    ctx.db.run(`INSERT INTO vbt_imports (id, provider, filename, rows, problems, created_by, created_at) VALUES (?, ?, ?, ?, '[]', ?, ?)`, vbtImportId, PROVIDER, filename ? String(filename).slice(0, 200) : 'OVR export', plan.sets.length, user?.id ?? null, ctx.now());
    for (let i = 0; i < plan.sets.length; i += 1000) {
      const part = plan.sets.slice(i, i + 1000);
      const r = recordSets(ctx, part.map((s) => ({ ...s.set, athlete: byKey.get(s.person) ? { client_id: byKey.get(s.person) } : { name: s.person.replace(/^name:/, '') } })), { provider: PROVIDER, source: SOURCE, importId: vbtImportId });
      if (r.errors.length) {
        const e = badRequest(`Nothing was saved. ${r.errors.length} bar-speed ${r.errors.length === 1 ? 'set' : 'sets'} couldn't be stored.`, 'import_problems');
        e.details = { problems: r.errors.slice(0, 200).map((x) => ({ sheet: 'Velocity', row: part[x.index]?.row, column: null, message: x.message })) };
        throw e;
      }
      barSpeed += r.saved;
      ctx.db.run('UPDATE vbt_imports SET saved = saved + ?, waiting = waiting + ?, duplicates = duplicates + ? WHERE id = ?', r.saved, r.waiting, r.duplicates, vbtImportId);
    }
  }
  ctx.db.run(`INSERT INTO import_batches (id, provider, filename, total_rows, imported, duplicates, pending, errors, created_at, kind, source_label, result_source, prs, created_by, vbt_import_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 'import', 'OVR Connect', ?, ?, ?, ?)`,
    batchId, PROVIDER, filename ? String(filename).slice(0, 200) : 'OVR export', items.length, saved, duplicates, JSON.stringify(queued), ctx.now(), SOURCE, prs, user?.id ?? null, vbtImportId);
  for (const r of resultIds) ctx.db.run('INSERT INTO import_batch_items (batch_id, result_id, value) VALUES (?, ?, ?)', batchId, r.id, r.value);
  for (const q of new Set(queued)) ctx.db.run('INSERT INTO import_batch_items (batch_id, queue_id) VALUES (?, ?)', batchId, q);
  return { batch_id: batchId, people: shaped, saved, duplicates, waiting, prs, bar_speed: barSpeed };
}

// Undo (from uploads.undoUpload): the bar-speed sets come out with the results, and a profile the import made goes too
// when nothing else points at it yet (no family, contact details, note, booking, membership, result...). A profile
// someone has started finishing stays.
export function undoExtras(ctx, batch, refs) {
  let sets = 0, removedProfiles = 0, keptProfiles = 0;
  if (batch.vbt_import_id) {
    sets = ctx.db.run('DELETE FROM vbt_sets WHERE import_id = ?', batch.vbt_import_id).changes;
    ctx.db.run('UPDATE vbt_imports SET undone_at = ? WHERE id = ? AND undone_at IS NULL', ctx.now(), batch.vbt_import_id);
  }
  for (const c of ctx.db.all('SELECT * FROM clients WHERE created_by_import = ?', batch.id)) {
    const untouched = !c.family_id && !c.email && !c.phone && !c.birth_date && !c.archived_at
      && refs.every(({ table, col }) => table === 'athlete_links' || !ctx.db.get(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`, c.id));
    if (!untouched) { keptProfiles++; continue; }
    ctx.db.run('DELETE FROM athlete_links WHERE client_id = ?', c.id);
    ctx.db.run('DELETE FROM clients WHERE id = ?', c.id);
    removedProfiles++;
  }
  return { sets, removedProfiles, keptProfiles };
}
