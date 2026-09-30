// Export a program (Relay plan step 8): an Excel workbook with a Plan sheet, a sheet per workout and a Phases sheet, and
// the printable page. Every role that can see programs can download it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { readXlsx, listSheets } from '../src/services/xlsx.js';

let app, base, coach, desk, program;
const PW = 'correct-horse-battery';
async function staff(email) {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  call.raw = (path) => fetch(base + path, { headers: { cookie } });
  return call;
}

before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'coach@test.dev', name: 'Riley', password: PW, role: 'coach' });
  createUser(app.ctx, { email: 'desk@test.dev', name: 'Dana', password: PW, role: 'front_desk' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  coach = await staff('coach@test.dev'); desk = await staff('desk@test.dev');
  const squat = (await coach('POST', '/v1/exercises', { name: 'Back squat' })).body, bench = (await coach('POST', '/v1/exercises', { name: 'Bench press' })).body;
  program = (await coach('POST', '/v1/programs', { name: 'Fall strength: block 1/2', weeks: 2, level: 'Beginner', description: 'The first block.' })).body;
  const lower = (await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 1, title: 'Lower' })).body;
  await coach('POST', `/v1/workouts/${lower.id}/exercises`, { exercise_id: squat.id, sets: 4, reps: '6', tempo: '3-1-1', rest_seconds: 120, target_rpe: 8, load_test: 'squat_1rm', load_pct: 75, group_label: 'A', group_kind: 'superset', note: 'Brace hard', form_check: true, form_check_note: 'Side view' });
  await coach('POST', `/v1/workouts/${lower.id}/exercises`, { exercise_id: bench.id, sets: 4, reps: '8', load_text: '65 lb dumbbells', group_label: 'A' });
  const warm = (await coach('POST', '/v1/routines', { name: 'Hips', kind: 'warmup', exercises: [{ exercise_id: squat.id, prescription: '2 × 10 bodyweight' }] })).body;
  await coach('PATCH', `/v1/workouts/${lower.id}`, { warmup_id: warm.id });
  await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 1, day: 3, title: 'Upper' });
  await coach('POST', `/v1/programs/${program.id}/workouts`, { week: 2, day: 1, title: 'Lower' });   // the same title twice: sheet names stay unique
  await coach('POST', `/v1/programs/${program.id}/phases`, { kind: 'base', start_week: 1, end_week: 1, note: 'Learn the lifts' });
  await coach('POST', `/v1/programs/${program.id}/phases`, { kind: 'build', start_week: 2, end_week: 2 });
});
after(() => app.server.close());

test('the workbook has a plan, a sheet per workout and the phases, with every set detail', async () => {
  const res = await coach.raw(`/v1/programs/${program.id}/export.xlsx`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.match(res.headers.get('content-disposition'), /fall-strength-block-1-2\.xlsx/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(listSheets(buf), ['Plan', 'W1 D1 Lower', 'W1 D3 Upper', 'W2 D1 Lower', 'Phases']);
  const plan = readXlsx(buf);      // the reader answers every cell as text
  assert.match(String(plan[0][0]), /^Fall strength: block 1\/2 · /);
  assert.deepEqual(plan[3], ['Week', 'Phase', 'Day 1', 'Day 2', 'Day 3', 'Sets']);
  assert.deepEqual(plan[4].slice(0, 3), ['1', 'Base', 'Lower (2 exercises)']);
  assert.equal(plan[4][4], 'Upper (0 exercises)');
  assert.deepEqual([plan[5][0], plan[5][1], plan[5][2]], ['2', 'Build', 'Lower (0 exercises)']);
  const lower = readXlsx(buf, 'W1 D1 Lower');
  assert.deepEqual(lower[0], ['#', 'Exercise', 'Sets', 'Reps', 'Load', 'Tempo', 'Rest', 'Target RPE', 'Group', 'Cue', 'Form check']);
  assert.deepEqual(lower[1], ['A1', 'Back squat', '4', '6', '75% of back squat max', '3-1-1', '2:00', '8', 'superset A', 'Brace hard', 'Yes: Side view']);
  assert.deepEqual(lower[2].slice(0, 5), ['A2', 'Bench press', '4', '8', '65 lb dumbbells']);
  assert.ok(lower.some((r) => String(r[0]).startsWith('Warm-up: Hips') && String(r[1]).startsWith('Back squat 2 × 10')), JSON.stringify(lower.slice(3)));
  const phases = readXlsx(buf, 'Phases');
  assert.deepEqual(phases[1], ['Base', 'base', '1', '1', 'Learn the lifts']);
  assert.deepEqual(phases[2].slice(0, 4), ['Build', 'build', '2', '2']);
  assert.throws(() => readXlsx(buf, 'Nope'), /No sheet named/);
  // Front desk may download too; a program that doesn't exist is 404.
  assert.equal((await desk.raw(`/v1/programs/${program.id}/export.xlsx`)).status, 200);
  assert.equal((await coach.raw('/v1/programs/prg_nope/export.xlsx')).status, 404);
});

test('the printable page is served and reads the program with the dashboard sign-in', async () => {
  const page = await fetch(`${base}/program.html?id=${program.id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /program-print\.js/);
  assert.equal((await fetch(`${base}/v1/programs/${program.id}/plan`)).status, 401, 'the page\'s data needs the sign-in');
  assert.equal((await desk('GET', `/v1/programs/${program.id}/plan`)).status, 200);
});
