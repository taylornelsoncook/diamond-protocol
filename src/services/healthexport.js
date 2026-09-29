// Archives from Apple Health and Fitbit, read without holding the whole thing in memory. Both come as a zip with many
// files inside; Apple's export.xml can be gigabytes, so it's inflated as a stream and read a line at a time, adding up
// each day as it goes. Everything comes out as one daily table (a Day column and a column per metric key, values as
// numbers) plus a list of workouts, which dataimport.js saves like any other file. Days are the local days written in
// the file. Nothing is guessed: a record type we don't know is skipped and counted.
import { createInflateRaw } from 'node:zlib';
import { badRequest, HttpError } from '../util.js';

export const MAX_ARCHIVE_BYTES = 60 * 1024 * 1024;       // the upload
const MAX_INFLATED = 1.5 * 1024 * 1024 * 1024;            // what export.xml may unpack to (read as a stream, never held)
const MAX_FITBIT_TOTAL = 256 * 1024 * 1024;               // everything read out of a Fitbit zip, in all
const MAX_LINES = 40_000_000, MAX_DAYS = 4000, MAX_WORKOUTS = 20000, MAX_LINE_BYTES = 1024 * 1024;   // a real export line is a few hundred bytes
// One archive unpacks at a time per server: two 60 MB zips inflating side by side could run a small instance out of memory.
let inflating = Promise.resolve();
export function oneAtATime(fn) { const run = inflating.then(fn, fn); inflating = run.catch(() => {}); return run; }

// ---------- Zip entries (central directory), inflated on demand ----------
export function zipEntries(buf) {
  const notZip = () => badRequest('That isn\'t a zip file we can open. Upload the export exactly as the app gave it to you.');
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw notZip();
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const out = [];
    for (let i = 0; i < count && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), rawSize = buf.readUInt32LE(p + 24), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
      if (p + 46 + nameLen > buf.length) break;
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (!name.endsWith('/') && local + 30 <= buf.length) {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        if (start + size <= buf.length) out.push({ name, method, size, rawSize, start });   // an entry pointing past the file is a broken zip: left out
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } catch (e) { if (e instanceof HttpError) throw e; throw notZip(); }   // a truncated or made-up file: a plain answer, never a crash
}
// Feed an entry to onLine(line) as text, a line at a time, inflating as it goes.
async function streamLines(buf, entry, onLine, { maxBytes = MAX_INFLATED } = {}) {
  const data = buf.subarray(entry.start, entry.start + entry.size);
  // Only the unfinished line is carried between chunks, and a "line" longer than MAX_LINE_BYTES (no newline for a
  // megabyte: not an export, or a file made to stall us) is refused, so the work stays linear and memory flat.
  let carry = [], carryBytes = 0, total = 0, lines = 0;
  const take = (chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, 'too_large', 'That export unpacks to more than we can read. Export a shorter range from the app.');
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(10, from);
      if (nl < 0) break;
      const piece = chunk.subarray(from, nl);
      if (carryBytes + piece.length > MAX_LINE_BYTES) throw badRequest('That file has lines far longer than an export\'s. Upload the export exactly as the app made it.');
      const line = carry.length ? Buffer.concat([...carry, piece]).toString('utf8') : piece.toString('utf8');
      carry = []; carryBytes = 0;
      if (++lines > MAX_LINES) throw new HttpError(413, 'too_large', 'That export has more records than we can read.');
      onLine(line);
      from = nl + 1;
    }
    if (from < chunk.length) {
      const rest = chunk.subarray(from);
      carryBytes += rest.length;
      if (carryBytes > MAX_LINE_BYTES) throw badRequest('That file has lines far longer than an export\'s. Upload the export exactly as the app made it.');
      carry.push(Buffer.from(rest));
    }
  };
  if (entry.method === 0) { take(data); }
  else if (entry.method === 8) {
    await new Promise((resolve, reject) => {
      const inf = createInflateRaw();
      inf.on('data', (chunk) => { try { take(chunk); } catch (e) { inf.destroy(); reject(e); } });
      inf.on('end', resolve); inf.on('error', (e) => reject(badRequest(`That file inside the zip couldn't be unpacked (${e.message}).`)));
      inf.end(data);
    });
  } else throw badRequest('That zip uses a compression we can\'t read. Re-zip it with the usual settings.');
  if (carry.length) onLine(Buffer.concat(carry).toString('utf8'));
}
const readEntry = async (buf, entry, max = 64 * 1024 * 1024) => { const parts = []; let n = 0; await streamLines(buf, entry, (l) => { n += l.length + 1; if (n > max) throw new HttpError(413, 'too_large', 'A file inside that export is too large to read.'); parts.push(l); }, { maxBytes: max }); return parts.join('\n'); };

// ---------- Daily table helpers ----------
class Days {
  constructor() { this.days = new Map(); this.skipped = new Map(); this.dropped = 0; }
  at(day) { if (!this.days.has(day)) { if (this.days.size >= MAX_DAYS * 2) throw new HttpError(413, 'too_large', `That export covers more than ${(MAX_DAYS * 2).toLocaleString()} days.`); this.days.set(day, {}); } return this.days.get(day); }
  // A total for the day, kept per source (iPhone, Watch, an app all log the same steps): the source with the most counts, once.
  add(day, key, value, source = '') { const d = this.at(day); const per = d[`_src_${key}`] ?? {}; per[source] = (per[source] ?? 0) + value; d[`_src_${key}`] = per; d[key] = Math.max(...Object.values(per)); }
  avg(day, key, value) { const d = this.at(day); const a = d[`_${key}`] ?? { sum: 0, n: 0 }; a.sum += value; a.n++; d[`_${key}`] = a; d[key] = a.sum / a.n; }
  max(day, key, value) { const d = this.at(day); d[key] = d[key] == null ? value : Math.max(d[key], value); }
  skip(type) { this.skipped.set(type, (this.skipped.get(type) ?? 0) + 1); }
  table() {
    let all = [...this.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    if (all.length > MAX_DAYS) { this.dropped = all.length - MAX_DAYS; all = all.slice(-MAX_DAYS); }   // the newest days win; an iPhone can hold a decade of steps
    const rows = all.map(([day, d]) => ({ Day: day, ...Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, Math.round(x * 100) / 100])) }));
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k !== 'Day')))];
    return { headers: ['Day', ...keys], rows };
  }
}
const ATTR_RE = new Map();   // one pattern per attribute name, for tens of millions of lines
const attr = (tag, name) => { let re = ATTR_RE.get(name); if (!re) { re = new RegExp(`\\s${name}="([^"]*)"`); ATTR_RE.set(name, re); } const m = tag.match(re); return m ? m[1] : null; };
const localDay = (s) => (s ? String(s).slice(0, 10) : null);                     // "2026-09-28 06:12:00 -0500" → the day as the phone saw it
const minutesBetween = (a, b) => { const t0 = Date.parse(a), t1 = Date.parse(b); return Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 ? (t1 - t0) / 60000 : 0; };
const words = (type) => String(type).replace(/^HKWorkoutActivityType/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim() || 'Workout';

// ---------- Apple Health: export.zip (or export.xml) ----------
// Records we add up per day. avg: the day's average; sum: the day's total; max: the day's highest.
const APPLE = {
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: ['hrv_ms', 'avg'],
  HKQuantityTypeIdentifierRestingHeartRate: ['rhr_bpm', 'avg'],
  HKQuantityTypeIdentifierRespiratoryRate: ['resp_rate', 'avg'],
  HKQuantityTypeIdentifierOxygenSaturation: ['spo2_pct', 'avg', 100],
  HKQuantityTypeIdentifierStepCount: ['steps', 'sum'],
  HKQuantityTypeIdentifierActiveEnergyBurned: ['active_cal_kcal', 'sum'],
  HKQuantityTypeIdentifierBasalEnergyBurned: ['_basal_kcal', 'sum'],
  HKQuantityTypeIdentifierVO2Max: ['vo2max', 'avg'],
  HKQuantityTypeIdentifierHeartRate: ['max_hr_bpm', 'max'],
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: ['skin_temp_c', 'avg']
};
const SLEEP = { HKCategoryValueSleepAnalysisAsleepCore: 'light_min', HKCategoryValueSleepAnalysisAsleepDeep: 'deep_min', HKCategoryValueSleepAnalysisAsleepREM: 'rem_min',
  HKCategoryValueSleepAnalysisAsleepUnspecified: '_asleep_min', HKCategoryValueSleepAnalysisAsleep: '_asleep_min', HKCategoryValueSleepAnalysisAwake: 'awake_min', HKCategoryValueSleepAnalysisInBed: 'in_bed_min' };
export async function readAppleHealth(buf, filename = 'export.zip') {
  const isXml = /\.xml$/i.test(filename) || buf.subarray(0, 5).toString() === '<?xml';
  let entry;
  if (!isXml) {
    const entries = zipEntries(buf);
    entry = entries.find((e) => /(^|\/)export\.xml$/i.test(e.name)) ?? entries.find((e) => /\.xml$/i.test(e.name) && !/clinical/i.test(e.name));
    if (!entry) throw badRequest('That zip doesn\'t have Apple Health\'s export.xml in it. In the Health app, tap your picture → Export All Health Data, and upload the export.zip it makes.');
  }
  const days = new Days(), workouts = [], sleepBySource = new Map();   // day → source → { key → minutes }
  let records = 0, inWorkout = null;
  const onLine = (line) => {
    const t = line.trimStart();
    if (t.startsWith('<Record ')) {
      records++;
      const type = attr(t, 'type');
      if (type === 'HKCategoryTypeIdentifierSleepAnalysis') {
        const key = SLEEP[attr(t, 'value')];
        if (!key) return days.skip(attr(t, 'value') ?? 'sleep');
        const start = attr(t, 'startDate'), end = attr(t, 'endDate'), mins = minutesBetween(start, end);
        if (!mins) return;
        const endHour = Number(String(end).slice(11, 13));
        const day = endHour >= 18 ? new Date(Date.parse(`${localDay(end)}T12:00:00Z`) + 86400000).toISOString().slice(0, 10) : localDay(end);   // an evening segment belongs to the next morning
        const src = attr(t, 'sourceName') ?? '';
        const perSrc = sleepBySource.get(day) ?? new Map(); sleepBySource.set(day, perSrc);
        const acc = perSrc.get(src) ?? {}; perSrc.set(src, acc); acc[key] = (acc[key] ?? 0) + mins;
        return;
      }
      const def = APPLE[type];
      if (!def) return days.skip(type ?? 'unknown');
      const value = Number(attr(t, 'value')) * (def[2] ?? 1);
      if (!Number.isFinite(value)) return;
      const day = localDay(attr(t, 'startDate'));
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      if (def[1] === 'avg') days.avg(day, def[0], value); else if (def[1] === 'sum') days.add(day, def[0], value, attr(t, 'sourceName') ?? ''); else days.max(day, def[0], value);
      return;
    }
    if (t.startsWith('<Workout ')) {
      const start = attr(t, 'startDate'), end = attr(t, 'endDate');
      inWorkout = { type: attr(t, 'workoutActivityType'), start, end, duration: Number(attr(t, 'duration')), durationUnit: attr(t, 'durationUnit') ?? 'min', calories: Number(attr(t, 'totalEnergyBurned')) || null, avg_hr: null, max_hr: null };
      if (t.endsWith('/>')) { finishWorkout(); }
      return;
    }
    if (inWorkout && t.startsWith('<WorkoutStatistics ')) {
      const type = attr(t, 'type');
      if (type === 'HKQuantityTypeIdentifierActiveEnergyBurned') inWorkout.calories = Number(attr(t, 'sum')) || inWorkout.calories;
      if (type === 'HKQuantityTypeIdentifierHeartRate') { inWorkout.avg_hr = Number(attr(t, 'average')) || null; inWorkout.max_hr = Number(attr(t, 'maximum')) || null; }
      return;
    }
    if (inWorkout && t.startsWith('</Workout>')) finishWorkout();
  };
  function finishWorkout() {
    const w = inWorkout; inWorkout = null;
    if (!w.start || workouts.length >= MAX_WORKOUTS) return;
    const startedAt = Date.parse(w.start), endedAt = Date.parse(w.end);
    if (!Number.isFinite(startedAt)) return;
    const minutes = Number.isFinite(w.duration) ? (w.durationUnit === 's' ? w.duration / 60 : w.durationUnit === 'hr' ? w.duration * 60 : w.duration) : minutesBetween(w.start, w.end);
    workouts.push({ started_at: new Date(startedAt).toISOString(), ended_at: Number.isFinite(endedAt) ? new Date(endedAt).toISOString() : null, day: localDay(w.start), minutes: Math.round(minutes),
      activity: words(w.type), strain: null, calories: w.calories != null ? Math.round(w.calories) : null, avg_hr: w.avg_hr, max_hr: w.max_hr });
  }
  if (isXml) await streamLines(buf, { method: 0, start: 0, size: buf.length }, onLine); else await streamLines(buf, entry, onLine);
  // Sleep: the Watch and the phone both write nights; per day, the source with the most sleep counts, once.
  for (const [day, perSrc] of sleepBySource) {
    const best = [...perSrc.values()].sort((a, b) => sleepMinutes(b) - sleepMinutes(a))[0];
    const asleep = sleepMinutes(best);
    const d = days.at(day);
    if (asleep) d.sleep_min = asleep;
    for (const k of ['light_min', 'deep_min', 'rem_min', 'awake_min', 'in_bed_min']) if (best[k]) d[k] = best[k];
    if (!d.in_bed_min && asleep) d.in_bed_min = asleep + (best.awake_min ?? 0);
  }
  for (const d of days.days.values()) { if (d._basal_kcal != null) d.calories_kcal = d._basal_kcal + (d.active_cal_kcal ?? 0); delete d._basal_kcal; }   // total burn only when the resting burn is there too
  if (!records && !workouts.length) throw badRequest('That file has no Health records in it. In the Health app, tap your picture → Export All Health Data, and upload the export.zip it makes.');
  const table = days.table();
  const notes = [`${records.toLocaleString()} records read.`];
  if (days.dropped) notes.push(`The export goes back ${(table.rows.length + days.dropped).toLocaleString()} days; the newest ${MAX_DAYS.toLocaleString()} are kept.`);
  if (days.skipped.size) notes.push(`Left out: ${[...days.skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k.replace(/^HK(Quantity|Category)TypeIdentifier|^HKCategoryValueSleepAnalysis/, '')} (${n.toLocaleString()})`).join(', ')}${days.skipped.size > 6 ? ' and more' : ''}: kinds of record we don't keep.`);
  return { ...table, workouts, notes, kind: 'apple_health', filename };
}
const sleepMinutes = (acc) => (acc.light_min ?? 0) + (acc.deep_min ?? 0) + (acc.rem_min ?? 0) + (acc._asleep_min ?? 0);

// ---------- Fitbit: the Google Takeout zip ----------
// Files under Fitbit/Global Export Data: sleep-*.json, resting_heart_rate-*.json, steps-*.json (a value a minute), calories-*.json,
// exercise-*.json, Daily Heart Rate Variability Summary - *.csv, Daily SpO2 - *.csv, Daily Respiratory Rate Summary - *.csv.
const fitbitDay = (s) => { const m = String(s ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; const iso = String(s ?? '').match(/^(\d{4}-\d{2}-\d{2})/); return iso ? iso[1] : null; };
const fitbitTime = (s) => { const m = String(s ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4}) (\d{2}):(\d{2}):(\d{2})/); if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null; } return new Date(Date.UTC(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]))).toISOString(); };
export async function readFitbit(buf, filename = 'takeout.zip') {
  const entries = zipEntries(buf).filter((e) => /fitbit/i.test(e.name) || /(^|\/)(sleep|resting_heart_rate|steps|calories|exercise)-\d{4}-\d{2}-\d{2}\.json$/i.test(e.name) || /Daily (Heart Rate Variability|SpO2|Respiratory Rate)/i.test(e.name));
  if (!entries.length) throw badRequest('That zip doesn\'t look like a Fitbit export. In Google Takeout (takeout.google.com), choose only Fitbit, create the export, and upload the zip it gives you.');
  const days = new Days(), workouts = [], seenStarts = new Set();
  let files = 0, totalBytes = 0;
  const csvRows = (text) => { const lines = text.split(/\r?\n/).filter((l) => l.trim()); if (lines.length < 2) return []; const head = lines[0].split(',').map((s) => s.trim()); return lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((c, i) => [head[i], c.trim()]))); };
  for (const e of entries) {
    if (files >= 3000) break;
    const base = e.name.split('/').pop();
    let kind = null;
    if (/^sleep-.*\.json$/i.test(base)) kind = 'sleep'; else if (/^resting_heart_rate-.*\.json$/i.test(base)) kind = 'rhr'; else if (/^steps-.*\.json$/i.test(base)) kind = 'steps';
    else if (/^calories-.*\.json$/i.test(base)) kind = 'calories'; else if (/^exercise-.*\.json$/i.test(base)) kind = 'exercise';
    else if (/^Daily Heart Rate Variability Summary/i.test(base)) kind = 'hrv'; else if (/^Daily SpO2/i.test(base)) kind = 'spo2'; else if (/^Daily Respiratory Rate Summary/i.test(base)) kind = 'resp';
    if (!kind) { days.skip(base.replace(/[- ]\d{4}-\d{2}-\d{2}.*$/, '')); continue; }
    if (seenStarts.has(e.start)) continue;   // two names pointing at one stream: a made-up zip, read once
    seenStarts.add(e.start);
    totalBytes += e.rawSize;
    if (totalBytes > MAX_FITBIT_TOTAL) throw new HttpError(413, 'too_large', 'That export unpacks to more than we can read at once. In Takeout, export a shorter date range.');
    files++;
    const text = await readEntry(buf, e);
    try {
      if (kind === 'hrv' || kind === 'spo2' || kind === 'resp') {
        for (const r of csvRows(text)) {
          const day = fitbitDay(r.timestamp); if (!day) continue;
          const x = Number(kind === 'hrv' ? r.rmssd : kind === 'spo2' ? r.average_value : r.daily_respiratory_rate);
          if (Number.isFinite(x)) days.avg(day, kind === 'hrv' ? 'hrv_ms' : kind === 'spo2' ? 'spo2_pct' : 'resp_rate', x);
        }
        continue;
      }
      const list = JSON.parse(text);
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (kind === 'sleep') {
          if (item.mainSleep === false) continue;   // naps are left out, like everywhere else
          const day = fitbitDay(item.dateOfSleep); if (!day) continue;
          const sum = item.levels?.summary ?? {};
          const d = days.at(day);
          if (Number.isFinite(item.minutesAsleep)) d.sleep_min = item.minutesAsleep;
          if (Number.isFinite(item.timeInBed)) d.in_bed_min = item.timeInBed;
          if (Number.isFinite(item.minutesAwake)) d.awake_min = item.minutesAwake;
          if (sum.deep?.minutes != null) d.deep_min = sum.deep.minutes; if (sum.light?.minutes != null) d.light_min = sum.light.minutes; if (sum.rem?.minutes != null) d.rem_min = sum.rem.minutes;
          if (Number.isFinite(item.efficiency)) d.sleep_efficiency_pct = item.efficiency;
        } else if (kind === 'rhr') {
          const day = fitbitDay(item.dateTime); const x = Number(item.value?.value ?? item.value); if (day && Number.isFinite(x) && x > 0) days.avg(day, 'rhr_bpm', x);
        } else if (kind === 'steps' || kind === 'calories') {
          const day = fitbitDay(item.dateTime); const x = Number(item.value); if (day && Number.isFinite(x)) days.add(day, kind === 'steps' ? 'steps' : 'calories_kcal', x, 'fitbit');
        } else if (kind === 'exercise') {
          const start = fitbitTime(item.startTime); if (!start || workouts.length >= MAX_WORKOUTS) continue;
          const minutes = Number.isFinite(item.duration) ? Math.round(item.duration / 60000) : null;
          workouts.push({ started_at: start, ended_at: minutes != null ? new Date(Date.parse(start) + minutes * 60000).toISOString() : null, day: fitbitDay(item.startTime), minutes, activity: String(item.activityName ?? 'Workout').slice(0, 60),
            strain: null, calories: Number.isFinite(item.calories) ? Math.round(item.calories) : null, avg_hr: Number.isFinite(item.averageHeartRate) ? item.averageHeartRate : null, max_hr: null });
        }
      }
    } catch (err) { if (err instanceof HttpError) throw err; days.skip(`${base} (couldn't be read)`); }
  }
  if (!files) throw badRequest('That zip has no Fitbit files we read (sleep, resting heart rate, steps, calories, exercise, HRV, SpO2, respiratory rate).');
  const table = days.table();
  const notes = [`${files} Fitbit files read.`];
  if (days.dropped) notes.push(`The export goes back ${(table.rows.length + days.dropped).toLocaleString()} days; the newest ${MAX_DAYS.toLocaleString()} are kept.`);
  if (days.skipped.size) notes.push(`Left out: ${[...days.skipped.entries()].slice(0, 6).map(([k, n]) => `${k} (${n})`).join(', ')}${days.skipped.size > 6 ? ' and more' : ''}: files we don't keep.`);
  return { ...table, workouts, notes, kind: 'fitbit', filename };
}
