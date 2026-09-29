import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { resetRateLimits } from '../src/services/security.js';
import { readAppleHealth, readFitbit, zipEntries } from '../src/services/healthexport.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

// Outside data from any system: the source menu, exports recognized by their columns (Oura, Garmin, Strava, TrainingPeaks),
// Apple Health and Fitbit archives read as streams, and any spreadsheet's columns saved as the measures we track.
let app, base, owner, desk, parent, ava, leo;
const PW = 'correct-horse-battery';
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => { const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
}
async function parentSignIn(email) {
  const login = await fetch(base + '/portal/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) }).then((r) => r.json());
  const v = await fetch(base + '/portal/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: login.dev_code }) });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => { const r = await fetch(base + '/portal/api/' + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
}
const csv = (name, text) => ({ file: { name, csv: text } });
// A zip like the apps make (deflated entries, a central directory), from { path: text }.
function zipOf(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), nameB = Buffer.from(name), crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameB.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, nameB, data); central.push(cd, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cdBuf = Buffer.concat(central), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
const metricsOf = (clientId) => Object.fromEntries(app.ctx.db.all('SELECT metric, day, value, source FROM athlete_metrics WHERE client_id = ? ORDER BY day, metric', clientId).map((r) => [`${r.metric}|${r.day}`, r.value]));

before(async () => {
  resetRateLimits();
  app = createApp({ testMode: true, jobs: false });
  createUser(app.ctx, { email: 'owner@test.dev', name: 'Olivia', password: PW });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Jess', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  owner = await staff('owner@test.dev'); desk = await staff('desk@test.dev');
  ava = (await owner('POST', '/v1/clients', { name: 'Ava Lopez', parent: { name: 'Maria Lopez', email: 'maria@example.com' } })).body;
  leo = (await owner('POST', '/v1/clients', { name: 'Leo Marchetti', parent: { name: 'Gina Marchetti', email: 'gina@example.com' } })).body;
  parent = await parentSignIn('maria@example.com');
});
after(() => app.server.close());

test('the source menu lists every system with where to find its export; parents get the same list', async () => {
  const s = (await owner('GET', '/v1/data-imports/sources')).body.data;
  assert.deepEqual(s.map((x) => x.key), ['auto', 'whoop', 'oura', 'garmin', 'apple_health', 'fitbit', 'strava', 'trainingpeaks', 'other']);
  assert.ok(s.every((x) => x.label && x.help.length > 20 && Array.isArray(x.accepts)));
  assert.deepEqual(s.find((x) => x.key === 'whoop').formats.map((f) => f.key), ['whoop_cycles', 'whoop_sleeps', 'whoop_workouts']);
  assert.match(s.find((x) => x.key === 'apple_health').help, /Export All Health Data/);
  assert.equal((await desk('GET', '/v1/data-imports/sources')).status, 200, 'front desk can read the menu');
  assert.equal((await parent('GET', 'data-imports/sources')).body.data.length, 9);
});

test('an Oura daily export is recognized by its columns; durations in seconds become minutes', async () => {
  const text = 'date,Sleep Score,Readiness Score,Total Sleep Duration,Deep Sleep Duration,REM Sleep Duration,Average HRV,Lowest Resting Heart Rate,Steps,Total Burn,Respiratory Rate\n'
    + '2026-09-27,84,78,25200,5400,6000,61,49,8210,2350,14.8\n2026-09-28,71,66,21600,4200,4800,48,52,11004,2610,15.1\n';
  const p = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('oura_2026-09-28_trends.csv', text) });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.format, p.body.source, p.body.source_label, p.body.ready, p.body.problem_count, p.body.days], ['oura_daily', 'oura', 'Oura', true, 0, 2]);
  assert.ok(p.body.metrics.some((m) => m.metric === 'sleep_score_pct') && p.body.metrics.some((m) => m.metric === 'hrv_ms'));
  assert.match(p.body.notes.join(' '), /Recognized columns: .*Total Sleep Duration → Sleep/);
  const c = await owner('POST', '/v1/data-imports', { client_id: ava.id, ...csv('oura.csv', text) });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const m = metricsOf(ava.id);
  assert.deepEqual([m['sleep_min|2026-09-27'], m['deep_min|2026-09-27'], m['hrv_ms|2026-09-28'], m['steps|2026-09-28'], m['readiness_pct|2026-09-27'], m['calories_kcal|2026-09-28']], [420, 90, 48, 11004, 78, 2610]);
  // Choosing the source in the menu with a file from another system says so.
  const wrong = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, source: 'whoop', ...csv('oura.csv', text) });
  assert.equal(wrong.status, 400); assert.match(wrong.body.error.message, /doesn't look like a WHOOP export \(it looks like Oura daily export\)/);
  assert.equal((await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, source: 'oura', ...csv('oura.csv', text) })).body.format, 'oura_daily');
  // Durations written in hours (7, 8) become minutes too; and a coach's own wellness sheet is never claimed as Oura or Garmin.
  const hours = (await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('oura2.csv', 'date,Readiness Score,Average HRV,Total Sleep Duration,Lowest Resting Heart Rate\n2026-09-29,80,50,7,48\n2026-09-30,75,47,8,50\n') })).body;
  assert.equal(hours.format, 'oura_daily');
  await owner('POST', '/v1/data-imports', { client_id: ava.id, ...csv('oura2.csv', 'date,Readiness Score,Average HRV,Total Sleep Duration,Lowest Resting Heart Rate\n2026-09-29,80,50,7,48\n2026-09-30,75,47,8,50\n') });
  assert.equal(metricsOf(ava.id)['sleep_min|2026-09-29'], 420);
  for (const sheet of ['Date,Sleep,Stress\n2026-09-01,7,3\n', 'Date,Sleep,Stress,Soreness,Energy\n2026-09-01,7,3,2,4\n', 'Date,Steps,Sleep Score\n2026-09-01,8000,80\n', 'Date,Resting,Weight\n2026-09-01,55,140\n']) {
    assert.equal((await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('wellness.csv', sheet) })).body.format, 'custom', sheet.split('\n')[0]);
  }
});

test('Garmin: the Health Stats daily export and Activities.csv (clock times, average and max heart rate)', async () => {
  const daily = 'Date,Resting Heart Rate,Body Battery,Stress,Sleep Score,Pulse Ox\n2026-09-27,54,78,31,82,97\n2026-09-28,57,64,44,71,96\n';
  const d = (await owner('POST', '/v1/data-imports/preview', { client_id: leo.id, ...csv('Sleep.csv', daily) })).body;
  assert.deepEqual([d.format, d.source_label, d.ready, d.values], ['garmin_daily', 'Garmin Connect', true, 10]);
  await owner('POST', '/v1/data-imports', { client_id: leo.id, ...csv('Sleep.csv', daily) });
  const m = metricsOf(leo.id);
  assert.deepEqual([m['rhr_bpm|2026-09-27'], m['body_battery|2026-09-28'], m['stress_score|2026-09-28'], m['sleep_score_pct|2026-09-27'], m['spo2_pct|2026-09-28']], [54, 64, 44, 82, 96]);
  const acts = 'Activity Type,Date,Favorite,Title,Distance,Calories,Time,Avg HR,Max HR,Aerobic TE\n'
    + 'Strength Training,2026-09-28 18:02:11,false,Lower body,0,"412","01:02:30",128,171,2.1\nRunning,2026-09-27 07:15:00,false,Morning run,5.02,"388","00:26:40",156,182,3.4\n';
  const a = await owner('POST', '/v1/data-imports/preview', { client_id: leo.id, ...csv('Activities.csv', acts) });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([a.body.format, a.body.workouts, a.body.new_workouts, a.body.ready], ['garmin_activities', 2, 2, true]);
  await owner('POST', '/v1/data-imports', { client_id: leo.id, ...csv('Activities.csv', acts) });
  const w = app.ctx.db.all('SELECT activity, minutes, calories, avg_hr, max_hr, day FROM athlete_workouts WHERE client_id = ? ORDER BY started_at', leo.id);
  assert.deepEqual(w, [{ activity: 'Running: Morning run', minutes: 27, calories: 388, avg_hr: 156, max_hr: 182, day: '2026-09-27' }, { activity: 'Strength Training: Lower body', minutes: 63, calories: 412, avg_hr: 128, max_hr: 171, day: '2026-09-28' }]);
});

test('Strava (seconds, "Sep 28, 2026, 6:00:00 PM") and TrainingPeaks (hours, meters) workout exports', async () => {
  const strava = 'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Max Heart Rate,Average Heart Rate,Calories\n'
    + '1,"Sep 28, 2026, 6:00:00 PM",Evening Run,Run,,3600,8.02,181,152,610\n2,"Sep 26, 2026, 7:30:00 AM",Lift,Workout,,2700,0,160,120,300\n';
  const s = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('activities.csv', strava) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual([s.body.format, s.body.source_label, s.body.workouts, s.body.problem_count], ['strava_activities', 'Strava', 2, 0]);
  await owner('POST', '/v1/data-imports', { client_id: ava.id, ...csv('activities.csv', strava) });
  const w = app.ctx.db.all('SELECT activity, minutes, started_at, avg_hr FROM athlete_workouts WHERE client_id = ? AND source = ? ORDER BY started_at', ava.id, 'strava_activities');
  assert.deepEqual(w, [{ activity: 'Workout: Lift', minutes: 45, started_at: '2026-09-26T07:30:00.000Z', avg_hr: 120 }, { activity: 'Run: Evening Run', minutes: 60, started_at: '2026-09-28T18:00:00.000Z', avg_hr: 152 }]);
  const byHand = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('activities.csv', strava), mapping: { date_column: 'Activity Date', metrics: [{ column: 'Calories', metric: 'calories_kcal' }] } });
  assert.equal(byHand.body.format, 'custom', 'columns matched by hand win over the Strava guess');
  const tp = 'Title,WorkoutType,WorkoutDay,PlannedDuration,TimeTotalInHours,DistanceInMeters,CaloriesSpent,HeartRateAverage,HeartRateMax,TSS\nSpeed day,Run,2026-09-25,1,0.75,6000,480,150,185,62\n';
  const t = (await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('workouts.csv', tp) })).body;
  assert.deepEqual([t.format, t.workouts, t.ready], ['trainingpeaks_workouts', 1, true]);
  await owner('POST', '/v1/data-imports', { client_id: ava.id, ...csv('workouts.csv', tp) });
  assert.equal(app.ctx.db.get('SELECT minutes FROM athlete_workouts WHERE client_id = ? AND source = ?', ava.id, 'trainingpeaks_workouts').minutes, 45);
});

test('any spreadsheet: columns are offered as the measures we track and saved under them, with the unit they were written in', async () => {
  const text = 'Day,HRV,Sleep hours,Coach mood\n2026-09-20,55,7.5,4\n2026-09-21,61,6.25,3\n';
  const p = (await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('my sheet.csv', text) })).body;
  assert.deepEqual([p.format, p.needs_mapping], ['custom', true]);
  assert.deepEqual(p.suggestion.metrics.map((m) => [m.column, m.metric]), [['HRV', 'hrv_ms'], ['Sleep hours', 'sleep_min'], ['Coach mood', null]], 'the guesses come from the column names');
  const mapping = { date_column: 'Day', metrics: [{ column: 'HRV', metric: 'hrv_ms' }, { column: 'Sleep hours', metric: 'sleep_min', from: 'hours' }, { column: 'Coach mood', label: 'Coach mood', unit: '/5' }] };
  const c = await owner('POST', '/v1/data-imports', { client_id: ava.id, ...csv('my sheet.csv', text), mapping });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const m = metricsOf(ava.id);
  assert.deepEqual([m['hrv_ms|2026-09-20'], m['sleep_min|2026-09-21'], m['custom:coach_mood|2026-09-20']], [55, 375, 4]);
  const bad = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('my sheet.csv', text), mapping: { date_column: 'Day', metrics: [{ column: 'HRV', metric: 'hrv_ms' }, { column: 'Coach mood', metric: 'hrv_ms' }] } });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /both saved as Heart rate variability/);
  const range = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('s.csv', 'Day,HRV\n2026-09-22,900\n'), mapping: { date_column: 'Day', metrics: [{ column: 'HRV', metric: 'hrv_ms' }] } });
  assert.equal(range.body.problem_count, 1); assert.match(range.body.problems[0].message, /isn't a possible heart rate variability/);
});

test('Apple Health: export.zip is read as a stream; days add up, the Watch\'s sleep wins over the phone\'s, workouts carry heart rate and energy', async () => {
  const rec = (type, start, end, value, source = 'Apple Watch') => `<Record type="${type}" sourceName="${source}" startDate="${start} -0500" endDate="${end} -0500" value="${value}"/>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n`
    + rec('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', '2026-09-28 06:12:00', '2026-09-28 06:13:00', 44) + '\n' + rec('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', '2026-09-28 22:12:00', '2026-09-28 22:13:00', 52) + '\n'
    + rec('HKQuantityTypeIdentifierRestingHeartRate', '2026-09-28 00:00:00', '2026-09-28 23:59:00', 51) + '\n'
    + rec('HKQuantityTypeIdentifierStepCount', '2026-09-28 08:00:00', '2026-09-28 08:10:00', 500, 'iPhone') + '\n' + rec('HKQuantityTypeIdentifierStepCount', '2026-09-28 09:00:00', '2026-09-28 09:10:00', 700, 'iPhone') + '\n'
    + rec('HKQuantityTypeIdentifierStepCount', '2026-09-28 08:00:00', '2026-09-28 08:10:00', 450, 'Apple Watch') + '\n' + rec('HKQuantityTypeIdentifierStepCount', '2026-09-28 09:00:00', '2026-09-28 09:10:00', 300, 'Apple Watch') + '\n'
    + rec('HKQuantityTypeIdentifierHeartRate', '2026-09-28 16:20:00', '2026-09-28 16:20:00', 999) + '\n'
    + rec('HKQuantityTypeIdentifierOxygenSaturation', '2026-09-28 03:00:00', '2026-09-28 03:00:00', 0.97) + '\n' + rec('HKQuantityTypeIdentifierVO2Max', '2026-09-27 10:00:00', '2026-09-27 10:00:00', 44.2) + '\n'
    + rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-09-27 22:30:00', '2026-09-28 00:30:00', 'HKCategoryValueSleepAnalysisAsleepCore') + '\n' + rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-09-28 00:30:00', '2026-09-28 05:30:00', 'HKCategoryValueSleepAnalysisAsleepDeep') + '\n'
    + rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-09-28 05:30:00', '2026-09-28 06:30:00', 'HKCategoryValueSleepAnalysisAsleepREM') + '\n' + rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-09-28 06:30:00', '2026-09-28 06:40:00', 'HKCategoryValueSleepAnalysisAwake') + '\n'
    + rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-09-27 22:00:00', '2026-09-28 06:45:00', 'HKCategoryValueSleepAnalysisInBed', 'iPhone') + '\n'
    + rec('HKQuantityTypeIdentifierBodyMass', '2026-09-28 08:00:00', '2026-09-28 08:00:00', 60, 'Scale') + '\n'
    + `<Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="45.5" durationUnit="min" sourceName="Apple Watch" startDate="2026-09-28 16:00:00 -0500" endDate="2026-09-28 16:45:30 -0500">\n`
    + ` <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="312.4" unit="Cal"/>\n <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="128" minimum="90" maximum="171" unit="count/min"/>\n</Workout>\n</HealthData>\n`;
  // Hundreds of workout routes come before export.xml in a real export; it's still found.
  const routes = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`apple_health_export/workout-routes/route_${i}.gpx`, '<gpx/>']));
  const zip = zipOf({ ...routes, 'apple_health_export/export.xml': xml, 'apple_health_export/export_cda.xml': '<ClinicalDocument/>' });
  assert.equal(zipEntries(zip).length, 302);
  const t = await readAppleHealth(zip, 'export.zip');
  assert.deepEqual(t.rows, [{ Day: '2026-09-27', vo2max: 44.2 }, { Day: '2026-09-28', hrv_ms: 48, rhr_bpm: 51, steps: 1200, max_hr_bpm: 999, spo2_pct: 97, sleep_min: 480, light_min: 120, deep_min: 300, rem_min: 60, awake_min: 10, in_bed_min: 490 }], 'steps from the phone and the Watch aren\'t added together: the source with the most counts');
  assert.deepEqual(t.workouts[0], { started_at: '2026-09-28T21:00:00.000Z', ended_at: '2026-09-28T21:45:30.000Z', day: '2026-09-28', minutes: 46, activity: 'Traditional Strength Training', strain: null, calories: 312, avg_hr: 128, max_hr: 171 });
  assert.match(t.notes.join(' '), /16 records read.*Left out: BodyMass \(1\)/);
  // Through the API: recognized from the zip without choosing a source, checked, saved, and listed under Apple Health.
  const body = { client_id: leo.id, file: { name: 'export.zip', zip_base64: zip.toString('base64') } };
  const p = await owner('POST', '/v1/data-imports/preview', body);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.format, p.body.source_label, p.body.file_kind, p.body.days, p.body.workouts, p.body.ready, p.body.problem_count], ['apple_health', 'Apple Health (Apple Watch)', 'apple_health', 2, 1, true, 0]);
  assert.match(p.body.notes.join(' '), /1 value outside what's possible .* left out/, 'a 999 heart rate is dropped with a note, never a problem the family can\'t fix');
  const c = await owner('POST', '/v1/data-imports', body);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const m = metricsOf(leo.id);
  assert.deepEqual([m['hrv_ms|2026-09-28'], m['sleep_min|2026-09-28'], m['vo2max|2026-09-27']], [48, 480, 44.2]);
  assert.equal((await owner('GET', `/v1/data-imports?client_id=${leo.id}`)).body.data[0].source_label, 'Apple Health (Apple Watch)');
  // The same zip named as a Fitbit export is refused with the right instructions; a zip with no export.xml too.
  const wrong = await owner('POST', '/v1/data-imports/preview', { ...body, source: 'fitbit' });
  assert.equal(wrong.status, 400); assert.match(wrong.body.error.message, /Fitbit/);
  const empty = await owner('POST', '/v1/data-imports/preview', { client_id: leo.id, source: 'apple_health', file: { name: 'x.zip', zip_base64: zipOf({ 'notes.txt': 'hi' }).toString('base64') } });
  assert.equal(empty.status, 400); assert.match(empty.body.error.message, /export\.xml/);
});

test('Fitbit: the Google Takeout zip (sleep, resting heart rate, steps a minute at a time, HRV, exercise)', async () => {
  const zip = zipOf({
    'Takeout/Fitbit/Global Export Data/sleep-2026-09-01.json': JSON.stringify([{ dateOfSleep: '2026-09-02', minutesAsleep: 431, minutesAwake: 38, timeInBed: 469, efficiency: 92, mainSleep: true, levels: { summary: { deep: { minutes: 77 }, light: { minutes: 260 }, rem: { minutes: 94 }, wake: { minutes: 38 } } } },
      { dateOfSleep: '2026-09-02', minutesAsleep: 40, mainSleep: false, levels: { summary: {} } }]),
    'Takeout/Fitbit/Global Export Data/resting_heart_rate-2026-09-01.json': JSON.stringify([{ dateTime: '09/02/26 00:00:00', value: { date: '09/02/26', value: 56.4, error: 6 } }, { dateTime: '09/03/26 00:00:00', value: { date: '09/03/26', value: 0, error: 0 } }]),
    'Takeout/Fitbit/Global Export Data/steps-2026-09-01.json': JSON.stringify([{ dateTime: '09/02/26 08:00:00', value: '120' }, { dateTime: '09/02/26 08:01:00', value: '95' }, { dateTime: '09/03/26 09:00:00', value: '30' }]),
    'Takeout/Fitbit/Global Export Data/Daily Heart Rate Variability Summary - 2026-09-02.csv': 'timestamp,rmssd,nremhr,entropy\n2026-09-02T00:00:00,63.5,58.2,2.9\n',
    'Takeout/Fitbit/Global Export Data/exercise-100.json': JSON.stringify([{ logId: 1, activityName: 'Weights', startTime: '09/02/26 17:30:00', duration: 2700000, calories: 280, averageHeartRate: 118 }]),
    'Takeout/Fitbit/Global Export Data/heart_rate-2026-09-02.json': '[]'
  });
  const t = await readFitbit(zip, 'takeout.zip');
  assert.deepEqual(t.rows, [{ Day: '2026-09-02', sleep_min: 431, in_bed_min: 469, awake_min: 38, deep_min: 77, light_min: 260, rem_min: 94, sleep_efficiency_pct: 92, rhr_bpm: 56.4, steps: 215, hrv_ms: 63.5 }, { Day: '2026-09-03', steps: 30 }]);
  assert.deepEqual(t.workouts, [{ started_at: '2026-09-02T17:30:00.000Z', ended_at: '2026-09-02T18:15:00.000Z', day: '2026-09-02', minutes: 45, activity: 'Weights', strain: null, calories: 280, avg_hr: 118, max_hr: null }]);
  assert.match(t.notes.join(' '), /5 Fitbit files read.*heart_rate/);
  const body = { client_id: ava.id, source: 'fitbit', file: { name: 'takeout-20260929.zip', zip_base64: zip.toString('base64') } };
  const p = await owner('POST', '/v1/data-imports/preview', body);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.format, p.body.source_label, p.body.days, p.body.workouts, p.body.ready], ['fitbit', 'Fitbit', 2, 1, true]);
  assert.equal((await owner('POST', '/v1/data-imports', body)).status, 201);
  assert.equal(metricsOf(ava.id)['hrv_ms|2026-09-02'], 63.5);
  // The parent brings the same kind of file in for their own athlete.
  const pp = await parent('POST', `athletes/${ava.id}/data-imports/preview`, { source: 'fitbit', file: { name: 'takeout.zip', zip_base64: zip.toString('base64') } });
  assert.equal(pp.status, 200, JSON.stringify(pp.body)); assert.equal(pp.body.format, 'fitbit');
  assert.equal((await parent('POST', `athletes/${leo.id}/data-imports/preview`, { source: 'fitbit', file: { name: 'takeout.zip', zip_base64: zip.toString('base64') } })).status, 404, 'not another family\'s athlete');
});

test('a version 53 database is upgraded: data_imports takes any file kind and keeps its rows, opened twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(tmp, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v53.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 53');
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_1', 'Ava Lopez', 'AVALOP2026', 'tok1', '2026-01-01T00:00:00Z')`);
    old.exec(`INSERT INTO data_imports (id, client_id, source, file_kind, filename, rows, days, workouts, created_at) VALUES ('dim_1', 'cli_1', 'whoop_cycles', 'csv', 'cycles.csv', 10, 10, 0, '2026-09-01T00:00:00Z')`);
    old.exec(`INSERT INTO data_import_replaced (import_id, client_id, metric, day, value, label, unit, source, prior_import_id, updated_at) VALUES ('dim_1', 'cli_1', 'hrv_ms', '2026-08-30', 60, NULL, NULL, 'custom', NULL, '2026-08-31T00:00:00Z')`);
    assert.throws(() => old.exec(`INSERT INTO data_imports (id, client_id, source, file_kind, rows, days, workouts, created_at) VALUES ('dim_2', 'cli_1', 'fitbit', 'fitbit', 1, 1, 0, '2026-09-02T00:00:00Z')`), /CHECK/);
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 58, `round ${round}`);
      assert.deepEqual(d.get('SELECT source, file_kind, filename, rows FROM data_imports WHERE id = ?', 'dim_1'), { source: 'whoop_cycles', file_kind: 'csv', filename: 'cycles.csv', rows: 10 });
      assert.equal(d.get(`SELECT COUNT(*) AS n FROM data_import_replaced WHERE import_id = 'dim_1'`).n, 1, 'what the import replaced still points at it');
      if (round === 1) d.run(`INSERT INTO data_imports (id, client_id, source, file_kind, rows, days, workouts, created_at) VALUES ('dim_2', 'cli_1', 'fitbit', 'fitbit', 1, 1, 0, '2026-09-02T00:00:00Z')`);
      assert.equal(d.get('SELECT COUNT(*) AS n FROM data_imports').n, 2);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('hostile or broken archives get a plain answer, fast: a truncated zip, a file with no line breaks, a zip with nothing in it', async () => {
  const good = zipOf({ 'apple_health_export/export.xml': '<HealthData/>' });
  assert.throws(() => zipEntries(good.subarray(0, 40)), /isn't a zip file we can open/);
  assert.throws(() => zipEntries(Buffer.alloc(0)), /isn't a zip file we can open/);
  const t0 = Date.now();
  await assert.rejects(readAppleHealth(Buffer.concat([Buffer.from('<?xml'), Buffer.alloc(8 * 1024 * 1024, 0x61)]), 'export.xml'), /lines far longer than an export/);
  assert.ok(Date.now() - t0 < 5000, 'refused without chewing through it');
  await assert.rejects(readAppleHealth(zipOf({ 'apple_health_export/export.xml': 'x'.repeat(2 * 1024 * 1024) }), 'export.zip'), /lines far longer/);
  await assert.rejects(readAppleHealth(zipOf({ 'readme.txt': 'hi' }), 'export.zip'), /export\.xml/);
  await assert.rejects(readFitbit(zipOf({ 'readme.txt': 'hi' }), 'takeout.zip'), /doesn't look like a Fitbit export/);
  const r = await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, file: { name: 'broken.zip', zip_base64: good.subarray(0, 40).toString('base64') } });
  assert.equal(r.status, 400); assert.match(r.body.error.message, /isn't a zip file/);
});

test('archives are paced: a very long export keeps its newest days, and one athlete gets six archive checks an hour', async () => {
  const many = (await owner('POST', '/v1/clients', { name: 'Noor Haddad', parent: { name: 'Sami Haddad', email: 'sami@example.com' } })).body;
  const lines = [];
  for (let i = 0; i < 4010; i++) { const d = new Date(Date.UTC(2015, 0, 1) + i * 86400000).toISOString().slice(0, 10); lines.push(`<Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Apple Watch" startDate="${d} 08:00:00 -0500" endDate="${d} 08:00:00 -0500" value="55"/>`); }
  const t = await readAppleHealth(Buffer.from(`<?xml version="1.0"?>\n<HealthData>\n${lines.join('\n')}\n</HealthData>\n`), 'export.xml');
  assert.equal(t.rows.length, 4000); assert.equal(t.rows[0].Day, '2015-01-11', 'the oldest ten days went'); assert.match(t.notes.join(' '), /goes back 4,010 days; the newest 4,000 are kept/);
  const zip = zipOf({ 'apple_health_export/export.xml': '<HealthData>\n<Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Apple Watch" startDate="2026-09-28 08:00:00 -0500" endDate="2026-09-28 08:00:00 -0500" value="55"/>\n</HealthData>' });
  const body = { client_id: many.id, file: { name: 'export.zip', zip_base64: zip.toString('base64') } };
  for (let i = 0; i < 6; i++) assert.equal((await owner('POST', '/v1/data-imports/preview', body)).status, 200, `check ${i + 1}`);
  assert.equal((await owner('POST', '/v1/data-imports/preview', body)).status, 429, 'the seventh waits');
  assert.equal((await owner('POST', '/v1/data-imports/preview', { client_id: ava.id, ...csv('s.csv', 'Day,HRV\n2026-09-22,50\n'), mapping: { date_column: 'Day', metrics: [{ column: 'HRV', metric: 'hrv_ms' }] } })).status, 200, 'plain files aren\'t paced this way');
});
