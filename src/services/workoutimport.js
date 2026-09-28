// Building a program from a PDF (or a photo of one). Claude reads the file the way a coach would and fills in a draft
// in the program builder's format: weeks, days, exercises, sets and reps, and a weight as a percent of a tested max
// where the file says so. Nothing is saved from the draft: the coach checks and edits it, chooses a library exercise
// for every line (or adds a new one), and only then saves it, all at once, as a new program or as weeks added to one.
// Exercise names are never matched silently: an exact library name is picked for the coach to see, a close one is
// marked "check it", anything else is offered as a new exercise.
// Needs ANTHROPIC_API_KEY (the owner adds it in Render). The file goes to Anthropic to be read and nothing else.
import { newId, v, badRequest, notFound, HttpError } from '../util.js';
import { CATEGORIES, LOAD_TESTS, getProgram, loadInput } from './programs.js';
import { rateLimit } from './security.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;      // Anthropic takes up to 32 MB a request; base64 adds a third
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_WORKOUTS = 7 * 52, MAX_EXERCISES = 30, MAX_LINES = 1500;
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'All levels'];
const MODEL = () => process.env.DP_WORKOUT_MODEL || 'claude-opus-5';
const API = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

export const aiReady = (ctx) => !!(ctx.readWorkoutFile || process.env.ANTHROPIC_API_KEY);
export function importStatus(ctx) {
  return { ready: aiReady(ctx), categories: CATEGORIES, levels: LEVELS, load_tests: LOAD_TESTS, max_mb: MAX_FILE_BYTES / 1024 / 1024 };
}

// ---------- The file ----------
const KINDS = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
function fileBlock(body) {
  const f = body?.file;
  if (!f || typeof f !== 'object') throw badRequest('Choose a PDF of the program, or a photo of it.');
  const name = v.str(f.name, 'file name', { max: 200 });
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  const type = KINDS[ext];
  if (!type) throw badRequest('Choose a PDF, or a photo (PNG, JPG or WebP). For Word or Pages, save it as a PDF first.');
  const b64 = String(f.data_base64 ?? '').replace(/\s/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) throw badRequest('That file came through empty. Choose it again.');
  const buf = Buffer.from(b64, 'base64');
  const max = type === 'application/pdf' ? MAX_FILE_BYTES : MAX_IMAGE_BYTES;
  if (buf.length > max) throw badRequest(`That file is ${(buf.length / 1024 / 1024).toFixed(1)} MB. The limit is ${max / 1024 / 1024} MB: split the PDF, or take a smaller photo.`);
  if (type === 'application/pdf' && !buf.subarray(0, 1024).toString('latin1').includes('%PDF')) throw badRequest('That file isn\'t a PDF. Choose the PDF again, or save the program as a PDF first.');
  if (type === 'application/pdf' && /\/Encrypt\b/.test(buf.toString('latin1'))) throw badRequest('This PDF is password-protected. Save a copy without a password and choose that.');
  return { name, block: type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: type, data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: type, data: b64 } } };
}

// ---------- Asking Claude ----------
// The shape of the draft Claude fills in. Empty text and 0 mean "none" (no nulls to keep the schema simple).
const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_program', 'program', 'workouts', 'unclear'],
  properties: {
    is_program: { type: 'boolean', description: 'False when the file is not a training program at all.' },
    program: { type: 'object', additionalProperties: false, required: ['name', 'description', 'level'], properties: {
      name: { type: 'string' }, description: { type: 'string' }, level: { type: 'string', enum: [...LEVELS, ''] } } },
    workouts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['week', 'day', 'title', 'exercises'], properties: {
      week: { type: 'integer' }, day: { type: 'integer' }, title: { type: 'string' },
      exercises: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['name', 'library_match', 'prescription', 'load_lift', 'load_pct', 'note'], properties: {
          name: { type: 'string' }, library_match: { type: 'string' }, prescription: { type: 'string' },
          load_lift: { type: 'string', enum: [...Object.keys(LOAD_TESTS), ''] }, load_pct: { type: 'integer' }, note: { type: 'string' } } } } } } },
    unclear: { type: 'array', items: { type: 'string' } }
  }
};
function instructions(library) {
  return `You turn a strength and conditioning program (a PDF or a photo) into a draft for a youth sports-performance coaching app. A coach checks every line before anything is saved, so copy what the file says and never invent exercises, sets, reps or weights.

The app's format:
- A program has weeks (1 to 52). Each week has days (1 to 7). Each day is one workout with a short title (for example "Lower body" or "Day 1"). A workout has exercises in order.
- Each exercise has a prescription, at most 80 characters, written like "3 × 8", "4 × 5/side", "3 × 8-10", "3 × 30 sec", "2 × 20 yd" or "3 × max". Use the × sign. Put sets first.
- When the file gives a weight as a percent of a tested max of the back squat, bench press or power clean, set load_lift to squat_1rm, bench_1rm or power_clean_1rm and load_pct to the whole-number percent (30 to 110). Otherwise load_lift is "" and load_pct is 0. Percents of any other lift, RPE, tempo, rest times and coaching cues go in note (short), not in the prescription.
- If the file says a workout repeats (for example "weeks 1-4" or "repeat for 3 weeks"), list it once for every week it covers. If weeks change the sets or percents, use each week's own numbers.
- If the file has no weeks, everything is week 1. Number days in the order they appear (Day 1, Day 2...), or by weekday (Monday = 1).
- Supersets, circuits and warm-ups: list each exercise on its own in order, and say "Superset with the next" or "Warm-up" in note.
- name is the exercise exactly as the file writes it. library_match is the exact name of the same exercise from the coach's library below, only when it is clearly the same movement (abbreviations like RDL = Romanian deadlift, DB = dumbbell, KB = kettlebell count); otherwise "".
- Anything you can't place or read clearly goes in unclear as one short sentence each, in plain English, saying where it is in the file.
- If the file isn't a training program, set is_program to false and leave workouts empty.

The coach's exercise library (one per line):
${library.length ? library.map((e) => e.name).join('\n') : '(empty)'}`;
}

// Calls the Messages API with the file and asks for the draft as JSON. Tests and local runs can set ctx.readWorkoutFile.
async function askClaude(ctx, file, library) {
  const system = instructions(library);
  if (ctx.readWorkoutFile) return ctx.readWorkoutFile({ block: file.block, system, schema: DRAFT_SCHEMA });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new HttpError(503, 'ai_not_set_up', 'Reading a PDF needs the Anthropic key. The owner adds ANTHROPIC_API_KEY in Render (see CHECKLIST.md), then this works.');
  const model = MODEL();
  const body = { model, max_tokens: 32000, system,
    thinking: { type: 'adaptive' }, output_config: { effort: 'high', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
    messages: [{ role: 'user', content: [file.block, { type: 'text', text: 'Read this program and fill in the draft.' }] }] };
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (model === 'claude-opus-5') { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }   // a declined read is retried on another model
  let res;
  try { res = await fetch(`${API()}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) }); }
  catch (e) { throw new HttpError(502, 'ai_unavailable', e?.name === 'TimeoutError' ? 'Reading the file took too long. Try again, or split a long PDF into parts.' : 'We couldn\'t reach Anthropic to read the file. Try again in a minute.'); }
  const d = await res.json().catch(() => null);
  if (!res.ok) {
    const why = d?.error?.message ?? `status ${res.status}`;
    console.error('workout import: Anthropic said', why);
    if (res.status === 401 || res.status === 403) throw new HttpError(502, 'ai_key', 'The Anthropic key in Render isn\'t working. The owner checks ANTHROPIC_API_KEY.');
    if (res.status === 429 || res.status === 529 || res.status >= 500) throw new HttpError(502, 'ai_busy', 'Anthropic is busy right now. Try again in a minute.');
    if (/pages?|too (large|long)|exceed/i.test(why)) throw badRequest('That file is too long to read in one go. Split the PDF into parts (a few weeks each) and bring them in one at a time.');
    throw badRequest('We couldn\'t read that file. Check it opens, or save it as a PDF again and try once more.');
  }
  if (d?.stop_reason === 'refusal') throw badRequest('We couldn\'t read that file as a training program. Check it\'s the right file.');
  if (d?.stop_reason === 'max_tokens') throw badRequest('That program is too long to read in one go. Split the PDF into parts (a few weeks each) and bring them in one at a time.');
  const text = d?.content?.find((b) => b.type === 'text')?.text;
  try { return JSON.parse(text); } catch { throw badRequest('We couldn\'t read that file. Try again, or save it as a PDF again first.'); }
}

// ---------- Matching exercise names to the library ----------
const ABBR = { rdl: 'romanian deadlift', sldl: 'single leg deadlift', db: 'dumbbell', dbs: 'dumbbell', kb: 'kettlebell', bb: 'barbell', sl: 'single leg', sa: 'single arm',
  oh: 'overhead', ohp: 'overhead press', bw: 'bodyweight', bss: 'bulgarian split squat', mb: 'medicine ball', med: 'medicine', rfe: 'rear foot elevated', trx: 'suspension' };
export function normName(s) {
  return String(s ?? '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
    .map((w) => ABBR[w] ?? w).join(' ').split(' ')
    .map((w) => (w.length >= 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}
function closest(name, library) {
  const a = new Set(normName(name).split(' '));
  let best = null, score = 0;
  for (const e of library) {
    const b = new Set(normName(e.name).split(' '));
    const both = [...a].filter((w) => b.has(w)).length;
    const s = both / new Set([...a, ...b]).size;
    if (s > score) { score = s; best = e; }
  }
  return score >= 0.6 ? best : null;
}
// exact: the same name (after abbreviations and plurals); suggested: Claude's or our closest match, for the coach to
// check; null: no match, so it's offered as a new exercise.
function matchExercise(name, claudeMatch, library) {
  const byNorm = new Map(library.map((e) => [normName(e.name), e]));
  const exact = byNorm.get(normName(name));
  if (exact) return { exercise_id: exact.id, exercise_name: exact.name, how: 'exact' };
  const said = claudeMatch ? library.find((e) => e.name.toLowerCase() === String(claudeMatch).trim().toLowerCase()) : null;
  const guess = said ?? closest(name, library);
  return guess ? { exercise_id: guess.id, exercise_name: guess.name, how: 'suggested' } : { exercise_id: null, exercise_name: null, how: null };
}

// ---------- The draft ----------
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export async function draftFromFile(ctx, body, user) {
  if (user?.id) rateLimit(`workout-import:${user.id}`, 20, 60 * 60000);   // each read costs a little; 20 an hour is plenty
  const file = fileBlock(body);
  const library = ctx.db.all('SELECT id, name, category FROM exercises ORDER BY name COLLATE NOCASE');
  const raw = await askClaude(ctx, file, library);
  if (!raw || typeof raw !== 'object') throw badRequest('We couldn\'t read that file. Try again.');
  if (raw.is_program === false || !Array.isArray(raw.workouts) || !raw.workouts.length) throw badRequest('We didn\'t find a training program in that file (exercises with sets and reps). Check it\'s the right file.');
  const notes = (Array.isArray(raw.unclear) ? raw.unclear : []).map((x) => clean(x, 300)).filter(Boolean).slice(0, 50);
  const seen = new Set();
  const workouts = [];
  for (const w of raw.workouts.slice(0, MAX_WORKOUTS)) {
    const week = Math.trunc(Number(w?.week)), day = Math.trunc(Number(w?.day));
    if (!(week >= 1 && week <= 52 && day >= 1 && day <= 7)) { notes.push(`Left out "${clean(w?.title, 60) || 'a workout'}": the program's weeks run 1 to 52 and days 1 to 7.`); continue; }
    if (seen.has(`${week}-${day}`)) { notes.push(`Week ${week}, day ${day} came up twice in the file; the first one is kept.`); continue; }
    seen.add(`${week}-${day}`);
    const exercises = (Array.isArray(w.exercises) ? w.exercises : []).slice(0, MAX_EXERCISES).map((x) => {
      const name = clean(x?.name, 120);
      const lift = Object.hasOwn(LOAD_TESTS, x?.load_lift) ? x.load_lift : '';
      const pct = Math.trunc(Number(x?.load_pct));
      return { name, ...matchExercise(name, x?.library_match, library), prescription: clean(x?.prescription, 80),
        load_test: lift && pct >= 30 && pct <= 110 ? lift : null, load_pct: lift && pct >= 30 && pct <= 110 ? pct : null, note: clean(x?.note, 200) };
    }).filter((x) => x.name);
    if ((w.exercises?.length ?? 0) > MAX_EXERCISES) notes.push(`Week ${week}, day ${day} has more than ${MAX_EXERCISES} exercises; only the first ${MAX_EXERCISES} are in the draft.`);
    workouts.push({ week, day, title: clean(w.title, 120) || `Day ${day}`, exercises });
  }
  if (raw.workouts.length > MAX_WORKOUTS) notes.push(`The file has more than ${MAX_WORKOUTS} workouts; only the first ${MAX_WORKOUTS} are in the draft.`);
  workouts.sort((a, b) => a.week - b.week || a.day - b.day);
  const lines = workouts.flatMap((w) => w.exercises);
  return {
    filename: file.name,
    program: { name: clean(raw.program?.name, 120) || file.name.replace(/\.[a-z0-9]+$/i, ''), description: clean(raw.program?.description, 2000), level: LEVELS.includes(raw.program?.level) ? raw.program.level : '' },
    weeks: workouts.reduce((n, w) => Math.max(n, w.week), 1),
    workouts, notes,
    counts: { workouts: workouts.length, exercises: lines.length, exact: lines.filter((x) => x.how === 'exact').length, suggested: lines.filter((x) => x.how === 'suggested').length, new: lines.filter((x) => !x.how).length }
  };
}

// ---------- Saving ----------
// body: { program_id (add to this program) or program: { name, description, level }, workouts: [{ week, day, title,
// exercises: [{ exercise_id } or { new_exercise: { name, category } }, prescription, load_test, load_pct] }] }.
// Every line is checked first; any problem and nothing is saved. New exercises with the same name are added once.
export function saveImport(ctx, body = {}) {
  const problems = [];
  const where = (w, i) => `Week ${w.week ?? '?'}, day ${w.day ?? '?'}${i != null ? `, exercise ${i + 1}` : ''}`;
  const target = body.program_id ? getProgram(ctx, v.str(body.program_id, 'program_id')) : null;
  const prog = target ? null : {
    name: v.str(body.program?.name, 'program name', { max: 120 }),
    description: v.str(body.program?.description, 'description', { max: 2000, optional: true }),
    level: v.str(body.program?.level, 'level', { max: 40, optional: true })
  };
  const list = Array.isArray(body.workouts) ? body.workouts : [];
  if (!list.length) throw badRequest('There are no workouts to save. Keep at least one.');
  if (list.length > MAX_WORKOUTS) throw badRequest(`Save up to ${MAX_WORKOUTS} workouts at a time.`);
  const taken = new Set(target ? ctx.db.all('SELECT week, day FROM workouts WHERE program_id = ?', target.id).map((x) => `${x.week}-${x.day}`) : []);
  const seen = new Set();
  const library = new Map(ctx.db.all('SELECT id, name FROM exercises').map((e) => [e.id, e]));
  const libraryNames = new Map([...library.values()].map((e) => [e.name.toLowerCase(), e]));
  const newOnes = new Map();       // lower-case name → { name, category }
  let lines = 0;
  const workouts = [];
  for (const w of list) {
    const week = Number(w?.week), day = Number(w?.day);
    if (!Number.isInteger(week) || week < 1 || week > 52) { problems.push(`${where(w)}: the week must be 1 to 52.`); continue; }
    if (!Number.isInteger(day) || day < 1 || day > 7) { problems.push(`${where(w)}: the day must be 1 to 7.`); continue; }
    const key = `${week}-${day}`;
    if (seen.has(key)) problems.push(`${where(w)} is in the draft twice. Change one of them.`);
    else if (taken.has(key)) problems.push(`${where(w)} already has a workout in ${target.name}. Change the week or day, or remove it from the draft.`);
    seen.add(key);
    const title = clean(w.title, 120) || `Day ${day}`;
    const exs = Array.isArray(w.exercises) ? w.exercises : [];
    if (!exs.length) problems.push(`${where(w)} has no exercises. Add one or remove the day.`);
    if (exs.length > MAX_EXERCISES) problems.push(`${where(w)} has more than ${MAX_EXERCISES} exercises.`);
    const out = [];
    exs.slice(0, MAX_EXERCISES).forEach((x, i) => {
      lines++;
      const rx = clean(x?.prescription, 200);
      if (!rx) problems.push(`${where(w, i)}: add the sets and reps, like 3 × 8.`);
      else if (rx.length > 80) problems.push(`${where(w, i)}: the sets and reps are ${rx.length} characters; keep them to 80.`);
      let load = { test: null, pct: null };
      try { load = loadInput(x ?? {}); } catch (e) { problems.push(`${where(w, i)}: ${e.message}`); }
      if (x?.exercise_id) {
        if (!library.has(String(x.exercise_id))) problems.push(`${where(w, i)}: that exercise isn't in the library any more. Choose another.`);
        out.push({ exercise_id: String(x.exercise_id), rx, load });
      } else if (x?.new_exercise && typeof x.new_exercise === 'object') {
        const name = clean(x.new_exercise.name, 200);
        const cat = x.new_exercise.category || null;
        if (!name) problems.push(`${where(w, i)}: give the new exercise a name.`);
        else if (name.length > 120) problems.push(`${where(w, i)}: keep the exercise name to 120 characters.`);
        else if (libraryNames.has(name.toLowerCase())) problems.push(`${where(w, i)}: ${libraryNames.get(name.toLowerCase()).name} is already in the library. Choose it instead of adding it again.`);
        if (cat && !CATEGORIES.includes(cat)) problems.push(`${where(w, i)}: choose a category from the list, or none.`);
        if (name && !newOnes.has(name.toLowerCase())) newOnes.set(name.toLowerCase(), { name, category: CATEGORIES.includes(cat) ? cat : null });
        out.push({ new_name: name.toLowerCase(), rx, load });
      } else problems.push(`${where(w, i)}: choose an exercise from the library, or add it as a new one.`);
    });
    workouts.push({ week, day, title, exercises: out });
  }
  if (lines > MAX_LINES) problems.push(`That's ${lines} exercise lines; save up to ${MAX_LINES} at a time.`);
  if (problems.length) {
    const e = badRequest(`Nothing was saved: ${problems.length} ${problems.length === 1 ? 'thing' : 'things'} to fix first.`);
    e.details = { problems: problems.slice(0, 100), problem_count: problems.length };
    throw e;
  }
  const lastWeek = workouts.reduce((n, w) => Math.max(n, w.week), 1);
  const programId = target?.id ?? newId('prog');
  const now = ctx.now();
  const ids = new Map();
  ctx.db.tx(() => {
    for (const [k, e] of newOnes) {
      const id = newId('ex');
      ctx.db.run('INSERT INTO exercises (id, name, video_url, instructions, category, created_at) VALUES (?, ?, NULL, NULL, ?, ?)', id, e.name, e.category, now);
      ids.set(k, id);
    }
    if (target) { if (lastWeek > target.weeks) ctx.db.run('UPDATE programs SET weeks = ? WHERE id = ?', lastWeek, target.id); }
    else ctx.db.run('INSERT INTO programs (id, name, description, level, weeks, created_at) VALUES (?, ?, ?, ?, ?, ?)', programId, prog.name, prog.description, prog.level, lastWeek, now);
    for (const w of workouts) {
      const wid = newId('wo');
      ctx.db.run('INSERT INTO workouts (id, program_id, week, day, title) VALUES (?, ?, ?, ?, ?)', wid, programId, w.week, w.day, w.title);
      w.exercises.forEach((x, i) => ctx.db.run('INSERT INTO workout_exercises (id, workout_id, exercise_id, position, prescription, load_test, load_pct) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId('wex'), wid, x.exercise_id ?? ids.get(x.new_name), i + 1, x.rx, x.load.test, x.load.pct));
    }
  });
  const p = getProgram(ctx, programId);
  if (!p) throw notFound('Program');
  return { program_id: programId, name: p.name, added_to_existing: !!target, workouts: workouts.length, exercises: lines, new_exercises: newOnes.size };
}
