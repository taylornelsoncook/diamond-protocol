// Programs → Build from a picture (owner's ask: "build workout from picture ... decipher the picture into a usable
// workout plan, straight lines signify a new block, dash lines signify new complex inside of the block").
// A photo of the whiteboard goes to Claude with those drawing rules; the draft comes back as the board's sections
// (solid lines) and the complexes inside each (dashed lines), every line matched to the exercise library and to the
// complex library the way Build from a PDF matches exercises. The coach checks it, then it's saved as one workout:
// each complex becomes a named block of that workout (a block is what a loaded complex is), named after the section
// and its place in it, with the option to save it to the complex library so the next board matches it by name.
// Nothing is saved on its own; saving is all or nothing with every problem listed.
import { newId, v, badRequest, notFound } from '../util.js';
import { CATEGORIES, LOAD_TESTS, GROUP_KINDS, MAX_BLOCKS, MAX_BLOCK_NAME, getProgram, loadInput, slotFields, insertSlot, syncBlocks, rxText } from './programs.js';
import { MAX_COMPLEX_EXERCISES, MAX_COMPLEX_NAME } from './complexes.js';
import { SET_FIELDS } from './rx.js';
import { askClaude, fileBlock, matchExercise, closest, normName, clean, draftFields, DAILY_READS } from './workoutimport.js';
import { rateLimit } from './security.js';

const MAX_SECTIONS = 12, MAX_GROUPS = 12, MAX_LINES = 30;
const MAX_LIBRARY_NAMES = 1500;

// ---------- Asking Claude ----------
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_workout', 'title', 'sections', 'unclear'],
  properties: {
    is_workout: { type: 'boolean', description: 'False when the picture is not a workout written out at all.' },
    title: { type: 'string', description: 'A short title for the workout, from a heading on the board or from what is on it ("Lower body", "Speed day").' },
    sections: { type: 'array', description: 'The parts of the board between solid lines, top to bottom.', items: { type: 'object', additionalProperties: false, required: ['name', 'groups'], properties: {
      name: { type: 'string', description: 'The section\'s heading if one is written, else a short name for what it holds (Warm up, Mobility, Strength, Finisher).' },
      groups: { type: 'array', description: 'The parts of the section between dashed lines, top to bottom; one group when the section has no dashed line.', items: { type: 'object', additionalProperties: false, required: ['name', 'kind', 'complex_match', 'lines'], properties: {
        name: { type: 'string', description: 'A heading written for the group, else "".' },
        kind: { type: 'string', enum: [...Object.keys(GROUP_KINDS), ''], description: 'How the group runs when the board says so (superset, circuit), else "".' },
        complex_match: { type: 'string', description: 'The exact name of a complex from the coach\'s complex library when the whole group is that complex (its name written as a line, or the same exercises), else "".' },
        lines: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['name', 'library_match', 'complex_match', 'sets', 'reps', 'distance', 'time_seconds', 'tempo', 'rest_seconds', 'rpe', 'load_text', 'load_lift', 'load_pct', 'note'], properties: {
            name: { type: 'string' }, library_match: { type: 'string' }, complex_match: { type: 'string' },
            sets: { type: 'integer' }, reps: { type: 'string' }, distance: { type: 'string' }, time_seconds: { type: 'integer' }, tempo: { type: 'string' }, rest_seconds: { type: 'integer' }, rpe: { type: 'number' }, load_text: { type: 'string' },
            load_lift: { type: 'string', enum: [...Object.keys(LOAD_TESTS), ''] }, load_pct: { type: 'integer' }, note: { type: 'string' } } } } } } } } } },
    unclear: { type: 'array', items: { type: 'string' } }
  }
};
function instructions(library, complexes) {
  const names = (list, what) => (list.length > MAX_LIBRARY_NAMES ? `The coach's ${what} is too big to list here, so leave that match as "".` : `The coach's ${what} (one per line):\n${list.length ? list.map((e) => e.name).join('\n') : '(empty)'}`);
  return `You read a workout a coach wrote on a whiteboard (a photo) into a draft for a youth sports-performance coaching app. The coach checks every line before anything is saved, so copy what the board says and never invent exercises, sets, reps or weights. Handwriting can be rough: read it as a coach would ("Fwd" = forward, "OH" = overhead, "DB" = dumbbell, "BB" = barbell, "T-spine" = thoracic spine).

How the board is laid out:
- A solid horizontal line drawn across the board starts a new section. Sections are the parts between solid lines, top to bottom; the part above the first line is a section too.
- A dashed or dotted horizontal line (- - - -) inside a section starts a new group within that section. The coach calls these groups complexes. A section with no dashed line is one group.
- Each written line is one exercise, drill or movement, with its sets and reps when they are written (usually to the right: "x6" means 6 reps, "x10, 8, 6, 4" means 4 sets of 10, 8, 6 and 4 reps, "3x8" means 3 sets of 8). A line with nothing after it has sets 0 and reps "".
- A line can be the name of a whole routine rather than one exercise (for example a warm-up the coach has written out before). When it is the same as a name in the coach's complex library below, put that name in the line's complex_match; and when a whole group is that complex, put it in the group's complex_match too. Otherwise both are "".
- Keep lines in the order they are written. Don't drop a line because it has no numbers; the coach decides what it is.

The app's fields for each line: sets (a whole number, 1 to 99; 0 when none is written), reps as short text exactly as the board means it ("8", "8-10", "5/side", "max", "10, 8, 6, 4"; "" when none), distance per rep or set when it's run or carried over a distance ("20 yd", "40 m"; "" when none; never put a distance in reps), time_seconds (how long each set runs, in seconds, when it's held or done for a time: "30 sec" is 30, "2 min" is 120; 0 when none; never put a time in reps), tempo as four counts down-pause-up-pause ("3-1-1-0"; "" when none), rest_seconds (the rest after each set in seconds, 0 when none), rpe (1 to 10, 0 when none), load_text (a load written as text, like "135 lb", "BW", "heavy"; "" when none). When a weight is a percent of a tested max of the back squat, bench press or power clean, set load_lift to squat_1rm, bench_1rm or power_clean_1rm and load_pct to the whole-number percent (30 to 110); otherwise load_lift is "" and load_pct is 0. Coaching cues go in note (short).
name is the line exactly as written (abbreviations spelled out are fine). library_match is the exact name of the same exercise from the coach's exercise library below, only when it is clearly the same movement; otherwise "".
A section's name is its heading when one is written, else a short name for what it holds (Warm up, Mobility, Strength, Finisher). A group's name is a heading written for it, else "". A group's kind is superset or circuit only when the board says so (brackets, "SS", "circuit"), else "".
Anything you can't read clearly goes in unclear as one short sentence each, in plain English, saying where it is on the board.
If the picture isn't a workout written out at all, set is_workout to false and leave sections empty.

${names(library, 'exercise library')}

${names(complexes, 'complex library')}`;
}

// ---------- Matching a line or a group to the complex library ----------
function matchComplex(name, claudeMatch, complexes) {
  if (!name) return null;
  const exact = complexes.find((c) => normName(c.name) === normName(name));
  if (exact) return { complex_id: exact.id, complex_name: exact.name, how: 'exact' };
  const said = claudeMatch ? complexes.find((c) => c.name.toLowerCase() === String(claudeMatch).trim().toLowerCase()) : null;
  const guess = said ?? closest(name, complexes);
  return guess ? { complex_id: guess.id, complex_name: guess.name, how: 'suggested' } : null;
}

// ---------- The draft ----------
export async function draftFromPhoto(ctx, body, user) {
  const file = fileBlock(body);
  if (file.block.type !== 'image') throw badRequest('Choose a photo of the whiteboard (PNG, JPG or WebP). A PDF goes through Build from a PDF.');
  if (user?.id) rateLimit(`workout-import:${user.id}`, 20, 60 * 60000);   // the same buckets as Build from a PDF
  rateLimit('workout-import:all', DAILY_READS, 24 * 60 * 60000);
  const library = ctx.db.all('SELECT id, name, category FROM exercises ORDER BY name COLLATE NOCASE');
  const complexes = ctx.db.all('SELECT c.id, c.name, c.kind, (SELECT COUNT(*) FROM complex_exercises x WHERE x.complex_id = c.id) AS count FROM complexes c ORDER BY c.name COLLATE NOCASE');
  const raw = await askClaude(ctx, file, library, { system: instructions(library, complexes), schema: SCHEMA, prompt: 'Read the whiteboard in this picture and fill in the draft.' });
  if (!raw || typeof raw !== 'object') throw badRequest('We couldn\'t read that picture. Try again with a clearer photo.');
  if (raw.is_workout === false || !Array.isArray(raw.sections) || !raw.sections.length) throw badRequest('We didn\'t find a workout in that picture (exercises written out, with lines between the parts). Check it\'s the right photo, or take it again closer and straight on.');
  const notes = (Array.isArray(raw.unclear) ? raw.unclear : []).map((x) => clean(x, 300)).filter(Boolean).slice(0, 50);
  const sections = [];
  let sectionNo = 0;
  for (const s of raw.sections.slice(0, MAX_SECTIONS)) {
    sectionNo++;
    const name = clean(s?.name, MAX_BLOCK_NAME) || `Block ${sectionNo}`;
    const groups = (Array.isArray(s?.groups) ? s.groups : []).slice(0, MAX_GROUPS);
    if (Array.isArray(s?.groups) && s.groups.length > MAX_GROUPS) notes.push(`${name} has more than ${MAX_GROUPS} parts between dashed lines; only the first ${MAX_GROUPS} are in the draft.`);
    const blocks = groups.map((g, gi) => {
      const lines = (Array.isArray(g?.lines) ? g.lines : []).slice(0, MAX_LINES).map((x) => {
        const lineName = clean(x?.name, 120);
        const lift = Object.hasOwn(LOAD_TESTS, x?.load_lift) ? x.load_lift : '';
        const pct = Math.trunc(Number(x?.load_pct));
        const f = draftFields(x, (what) => notes.push(`${name}, ${lineName || 'a line'}: ${what}`));
        const { group_label, group_kind, ...fields } = f;   // the block says how the lines run
        if (fields.sets == null && !fields.reps && !fields.distance) fields.sets = 1;   // a line with nothing written ("Dynamic flex") is done once; the coach changes it
        return { name: lineName, ...matchExercise(lineName, x?.library_match, library), complex: matchComplex(lineName, x?.complex_match, complexes), ...fields, prescription: rxText(fields),
          load_test: lift && pct >= 30 && pct <= 110 ? lift : null, load_pct: lift && pct >= 30 && pct <= 110 ? pct : null, note: clean(x?.note, 200) };
      }).filter((x) => x.name);
      if (Array.isArray(g?.lines) && g.lines.length > MAX_LINES) notes.push(`${name}, part ${gi + 1} has more than ${MAX_LINES} lines; only the first ${MAX_LINES} are in the draft.`);
      // The whole group is one complex from the library when Claude says so, or when its one line is one.
      const whole = matchComplex(clean(g?.complex_match, 120), g?.complex_match, complexes) ?? (lines.length === 1 && lines[0].complex?.how === 'exact' ? lines[0].complex : null);
      const heading = clean(g?.name, MAX_BLOCK_NAME);
      return { section: sectionNo, part: gi + 1, name: heading || (groups.length > 1 ? `${name} ${gi + 1}` : name).slice(0, MAX_BLOCK_NAME),
        kind: Object.hasOwn(GROUP_KINDS, g?.kind) ? g.kind : 'block', complex: whole, exercises: lines };
    }).filter((b) => b.exercises.length || b.complex);
    if (blocks.length) sections.push({ name, blocks });
  }
  if (raw.sections.length > MAX_SECTIONS) notes.push(`The board has more than ${MAX_SECTIONS} sections; only the first ${MAX_SECTIONS} are in the draft.`);
  const blocks = sections.flatMap((s) => s.blocks);
  if (!blocks.length) throw badRequest('We couldn\'t read any exercise lines from that picture. Take it again closer and straight on, with the whole board in the frame.');
  if (blocks.length > MAX_BLOCKS) throw badRequest(`That board has ${blocks.length} parts and a workout holds up to ${MAX_BLOCKS} blocks. Bring it in as two workouts.`);
  const lines = blocks.flatMap((b) => b.exercises);
  return {
    filename: file.name, source: 'photo',
    title: clean(raw.title, 120) || 'From the board',
    sections, notes,
    counts: { sections: sections.length, blocks: blocks.length, exercises: lines.length,
      exact: lines.filter((x) => x.how === 'exact').length, suggested: lines.filter((x) => x.how === 'suggested').length, new: lines.filter((x) => !x.how && !x.complex).length,
      complexes: blocks.filter((b) => b.complex?.how === 'exact').length + lines.filter((x) => x.complex?.how === 'exact').length }
  };
}

// ---------- Saving ----------
// body: { program_id (into this program) or program: { name, description, level }, week, day, title,
// blocks: [{ name, kind, complex_id (load the complex as it is in the library), save_as_complex (a name: the block is
// saved to the complex library too), exercises: [{ exercise_id } or { new_exercise: { name, category } } or
// { complex_id } (that complex's exercises, in its place), the set fields, load_test, load_pct] }] }.
// Everything is checked first; any problem and nothing is saved. One transaction: new exercises, the program if new,
// the workout, its blocks and exercises in order, and the complexes saved from it.
export function saveBoard(ctx, body = {}, user = null) {
  const problems = [];
  const text = (x) => (typeof x === 'string' ? x : x == null ? '' : null);
  const target = body.program_id ? getProgram(ctx, v.str(body.program_id, 'program_id')) : null;
  const prog = target ? null : {
    name: v.str(body.program?.name, 'program name', { max: 120 }),
    description: v.str(body.program?.description, 'description', { max: 2000, optional: true }),
    level: v.str(body.program?.level, 'level', { max: 40, optional: true })
  };
  const week = Number(body.week ?? 1), day = Number(body.day ?? 1);
  if (!Number.isInteger(week) || week < 1 || week > 52) problems.push('The week must be 1 to 52.');
  if (!Number.isInteger(day) || day < 1 || day > 7) problems.push('The day must be 1 to 7.');
  if (target && problems.length === 0 && ctx.db.get('SELECT id FROM workouts WHERE program_id = ? AND week = ? AND day = ?', target.id, week, day)) problems.push(`Week ${week}, day ${day} already has a workout in ${target.name}. Choose another day.`);
  if (text(body.title) === null) problems.push('The title must be text.');
  const title = clean(text(body.title), 120) || 'From the board';
  const list = Array.isArray(body.blocks) ? body.blocks : [];
  if (!list.length) problems.push('There are no blocks to save. Keep at least one.');
  if (list.length > MAX_BLOCKS) problems.push(`A workout holds up to ${MAX_BLOCKS} blocks.`);
  const library = new Map(ctx.db.all('SELECT id, name FROM exercises').map((e) => [e.id, e]));
  const libraryNames = new Map([...library.values()].map((e) => [e.name.toLowerCase(), e]));
  const complexNames = new Set(ctx.db.all('SELECT name FROM complexes').map((c) => c.name.toLowerCase()));
  const complexRows = (id) => ctx.db.all('SELECT * FROM complex_exercises WHERE complex_id = ? ORDER BY position', id);
  const newOnes = new Map();   // lower-case name → { name, category }
  const newComplexes = new Set();
  const blocks = [];
  let lines = 0;
  list.forEach((b, bi) => {
    const where = (i) => `Block ${bi + 1}${i != null ? `, line ${i + 1}` : ''}`;
    if (!b || typeof b !== 'object') { problems.push(`${where()} is empty. Remove it.`); return; }
    if (text(b.name) === null) problems.push(`${where()}: the name must be text.`);
    const name = clean(text(b.name), MAX_BLOCK_NAME) || `Block ${bi + 1}`;
    const kind = b.kind == null || b.kind === '' ? 'block' : Object.hasOwn(GROUP_KINDS, b.kind) ? b.kind : (problems.push(`${where()}: how it runs must be block, superset or circuit.`), 'block');
    const out = [];
    const whole = b.complex_id ? ctx.db.get('SELECT * FROM complexes WHERE id = ?', String(b.complex_id)) : null;
    if (b.complex_id && !whole) problems.push(`${where()}: that complex isn't in the library any more. Choose its exercises instead.`);
    if (whole) for (const x of complexRows(whole.id)) { lines++; out.push({ exercise_id: x.exercise_id, rx: slotFields(x), load: { test: x.load_test, pct: x.load_pct } }); }
    const exs = Array.isArray(b.exercises) ? b.exercises : [];
    if (!whole && !exs.length) problems.push(`${where()} has no exercises. Add one or remove the block.`);
    if (exs.length > MAX_LINES) problems.push(`${where()} has more than ${MAX_LINES} lines.`);
    exs.slice(0, MAX_LINES).forEach((x, i) => {
      if (x?.complex_id) {
        const c = ctx.db.get('SELECT * FROM complexes WHERE id = ?', String(x.complex_id));
        if (!c) { problems.push(`${where(i)}: that complex isn't in the library any more. Choose an exercise instead.`); return; }
        for (const r of complexRows(c.id)) { lines++; out.push({ exercise_id: r.exercise_id, rx: slotFields(r), load: { test: r.load_test, pct: r.load_pct } }); }
        return;
      }
      lines++;
      let rx = null;
      const { group_label, group_kind, ...fields } = x && typeof x === 'object' ? x : {};
      try { rx = slotFields(fields); } catch (e) { problems.push(`${where(i)}: ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)}`); }
      let load = { test: null, pct: null };
      try { load = loadInput(fields); } catch (e) { problems.push(`${where(i)}: ${e.message}`); }
      if (x?.exercise_id) {
        if (!library.has(String(x.exercise_id))) problems.push(`${where(i)}: that exercise isn't in the library any more. Choose another.`);
        out.push({ exercise_id: String(x.exercise_id), rx, load });
      } else if (x?.new_exercise && typeof x.new_exercise === 'object') {
        const nm = clean(x.new_exercise.name, 200);
        const cat = x.new_exercise.category || null;
        if (!nm) problems.push(`${where(i)}: give the new exercise a name.`);
        else if (nm.length > 120) problems.push(`${where(i)}: keep the exercise name to 120 characters.`);
        else if (libraryNames.has(nm.toLowerCase())) problems.push(`${where(i)}: ${libraryNames.get(nm.toLowerCase()).name} is already in the library. Choose it instead of adding it again.`);
        if (cat && !CATEGORIES.includes(cat)) problems.push(`${where(i)}: choose a category from the list, or none.`);
        if (nm && !newOnes.has(nm.toLowerCase())) newOnes.set(nm.toLowerCase(), { name: nm, category: CATEGORIES.includes(cat) ? cat : null });
        out.push({ new_name: nm.toLowerCase(), rx, load });
      } else problems.push(`${where(i)}: choose an exercise from the library, add it as a new one, or remove the line.`);
    });
    let saveAs = null;
    if (b.save_as_complex) {
      saveAs = clean(text(b.save_as_complex) ?? '', MAX_COMPLEX_NAME + 1);
      if (!saveAs) problems.push(`${where()}: name the complex to save it to the library.`);
      else if (saveAs.length > MAX_COMPLEX_NAME) problems.push(`${where()}: keep the complex name to ${MAX_COMPLEX_NAME} characters.`);
      else if (complexNames.has(saveAs.toLowerCase())) problems.push(`${where()}: a complex called ${saveAs} is already in the library. Pick another name, or load that one.`);
      else if (newComplexes.has(saveAs.toLowerCase())) problems.push(`${where()}: two blocks would be saved as the complex ${saveAs}. Give one another name.`);
      else if (whole) problems.push(`${where()} is already the complex ${whole.name}; it doesn't need saving again.`);
      else if (out.length > MAX_COMPLEX_EXERCISES) problems.push(`${where()}: a complex holds up to ${MAX_COMPLEX_EXERCISES} exercises.`);
      if (saveAs) newComplexes.add(saveAs.toLowerCase());
    }
    blocks.push({ name, kind, complex_id: whole?.id ?? null, save_as: saveAs, exercises: out });
  });
  if (problems.length) {
    const e = badRequest(`Nothing was saved: ${problems.length} ${problems.length === 1 ? 'thing' : 'things'} to fix first.`);
    e.details = { problems: problems.slice(0, 100), problem_count: problems.length };
    throw e;
  }
  const programId = target?.id ?? newId('prog');
  const now = ctx.now();
  const ids = new Map();
  const wid = newId('wo');
  const saved = [];
  ctx.db.tx(() => {
    for (const [k, e] of newOnes) {
      const id = newId('ex');
      ctx.db.run('INSERT INTO exercises (id, name, video_url, instructions, category, created_at) VALUES (?, ?, NULL, NULL, ?, ?)', id, e.name, e.category, now);
      ids.set(k, id);
    }
    if (target) { if (week > target.weeks) ctx.db.run('UPDATE programs SET weeks = ? WHERE id = ?', week, target.id); }
    else ctx.db.run('INSERT INTO programs (id, name, description, level, weeks, author_id, author_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', programId, prog.name, prog.description, prog.level, week, user?.id ?? null, user?.name ?? null, now);
    ctx.db.run('INSERT INTO workouts (id, program_id, week, day, title) VALUES (?, ?, ?, ?, ?)', wid, programId, week, day, title);
    let at = 0;
    blocks.forEach((b, i) => {
      const bid = newId('wb');
      let complexId = b.complex_id;
      const rows = b.exercises.map((x) => ({ exercise_id: x.exercise_id ?? ids.get(x.new_name), rx: { ...x.rx, load_test: x.load.test, load_pct: x.load.pct } }));
      if (b.save_as) {
        complexId = newId('cpx');
        ctx.db.run('INSERT INTO complexes (id, name, kind, note, created_by, created_at) VALUES (?, ?, ?, NULL, ?, ?)', complexId, b.save_as, b.kind, user?.name ?? null, now);
        const cols = SET_FIELDS.filter((k) => k !== 'group_label' && k !== 'group_kind');
        rows.forEach((x, j) => ctx.db.run(`INSERT INTO complex_exercises (id, complex_id, exercise_id, position, prescription, load_test, load_pct, ${cols.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ${cols.map(() => '?').join(', ')})`,
          newId('cx'), complexId, x.exercise_id, j + 1, x.rx.prescription, x.rx.load_test ?? null, x.rx.load_pct ?? null, ...cols.map((c) => (c === 'form_check' ? (x.rx.form_check ? 1 : 0) : x.rx[c] ?? null))));
        saved.push(b.save_as);
      }
      ctx.db.run('INSERT INTO workout_blocks (id, workout_id, name, kind, position, complex_id) VALUES (?, ?, ?, ?, ?, ?)', bid, wid, b.name, b.kind, i + 1, complexId);
      for (const x of rows) insertSlot(ctx, wid, x.exercise_id, ++at, { ...x.rx, block_id: bid });
    });
    syncBlocks(ctx, wid);
  });
  const p = getProgram(ctx, programId);
  if (!p) throw notFound('Program');
  return { program_id: programId, workout_id: wid, name: p.name, added_to_existing: !!target, week, day, blocks: blocks.length, exercises: lines, new_exercises: newOnes.size, complexes_saved: saved };
}
