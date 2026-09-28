// Programs → Build from a PDF. Choose a PDF (or a photo) of a program; Claude reads it into a draft; the coach checks
// every line (which library exercise, sets and reps, weight from a max), fixes what's off and saves it as a new program
// or as weeks added to one. Nothing is saved until Save, and the server checks everything again then.
import { h, fill, toast, busy, btn, field, input, select, panel } from './ui.js';

const MAX_MB = 20, MAX_PHOTO_MB = 5;
const LOAD_OPTIONS = [['', 'Weight: coach sets it'], ['squat_1rm', '% of back squat max'], ['bench_1rm', '% of bench press max'], ['power_clean_1rm', '% of power clean max']];
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const textarea = (value = '', attrs = {}) => { const t = h('textarea', { class: 'dp-input', ...attrs }); t.value = value ?? ''; return t; };

function readFile(file) {
  return new Promise((resolve, reject) => {
    const lower = file.name.toLowerCase();
    const photo = /\.(png|jpe?g|webp)$/.test(lower);
    if (!photo && !lower.endsWith('.pdf')) return reject(new Error('Choose a PDF, or a photo (PNG, JPG or WebP). For Word or Pages, save it as a PDF first.'));
    const max = photo ? MAX_PHOTO_MB : MAX_MB;
    if (file.size > max * 1024 * 1024) return reject(new Error(`That file is bigger than ${max} MB. ${photo ? 'Take a smaller photo.' : 'Split the PDF into parts.'}`));
    const r = new FileReader();
    r.onerror = () => reject(new Error('That file couldn\'t be read. Choose it again.'));
    r.onload = () => resolve({ name: file.name, data_base64: String(r.result).split(',')[1] ?? '' });
    r.readAsDataURL(file);
  });
}

export async function importView(main, deps) {
  const get = (p) => deps.api('GET', p), post = (p, b) => deps.api('POST', p, b);
  const [status, progs, exs] = await Promise.all([get('/v1/programs/import/status'), get('/v1/programs'), get('/v1/exercises')]);
  const box = h('div', { class: 'stack', style: 'gap:24px' });
  fill(main, deps.header('Build from a PDF', 'Turn a program you already have into one athletes can follow in the app.', h('a', { class: 'dp-btn dp-btn--ghost', href: '#/programs' }, 'Back to programs')), box);

  if (!status.ready) {
    fill(box, panel('Almost ready', { subtitle: 'Reading a PDF uses Claude, from Anthropic, and needs a key.' },
      h('p', { class: 'small' }, deps.role() === 'owner'
        ? 'Get a key at console.anthropic.com (API keys), then in Render open diamond-protocol, Environment, and add ANTHROPIC_API_KEY with the key as its value. Save, and this page works after the restart. Each file costs a few cents to read.'
        : 'Ask the owner to add the Anthropic key in Render. Then this page works.')));
    return;
  }

  // Step 1: the file and where it goes.
  const file = h('input', { type: 'file', class: 'dp-input', accept: '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*', 'aria-label': 'The program file' });
  const where = select([['', 'A new program'], ...progs.data.map((p) => [p.id, `Add to ${p.name}`])], { 'aria-label': 'Where it goes' });
  const draftBox = h('div', { class: 'stack' });
  const readBtn = btn('Read the file', (e) => busy(e.currentTarget, async () => {
    if (!file.files[0]) throw new Error('Choose the file first.');
    fill(draftBox, h('p', { class: 'small muted', role: 'status' }, 'Reading the file. A long program can take a minute or two…'));
    try {
      const f = await readFile(file.files[0]);
      const d = await post('/v1/programs/import/draft', { file: f });
      editor(d);
    } catch (x) { fill(draftBox, h('div', { class: 'dp-error', role: 'alert' }, x.message)); }
  }), 'primary');
  fill(box, panel('Your program file', { subtitle: 'A PDF of the program, or a clear photo of a printed one. Claude reads it into a draft; you check every line before anything is saved.' },
    h('div', { class: 'form-grid' }, field('File', file, `PDF up to ${MAX_MB} MB, or a photo up to ${MAX_PHOTO_MB} MB.`), field('Save it as', where)),
    h('p', { class: 'small muted' }, 'The file is sent to Anthropic (Claude) to be read. Leave athletes\' personal details out of it.'),
    h('div', null, readBtn)), draftBox);

  // Step 2: the draft to check.
  function editor(d) {
    const target = progs.data.find((p) => p.id === where.value) ?? null;
    const libOptions = exs.data.map((e) => [e.id, e.name]);
    const name = input({ value: d.program.name, maxlength: '120', 'aria-label': 'Program name' });
    const level = select([['', 'Any level'], ...status.levels.map((l) => [l, l])], { value: d.program.level, 'aria-label': 'Level' });
    const desc = textarea(d.program.description, { rows: '3', maxlength: '2000', 'aria-label': 'Description' });
    const days = [];
    const list = h('div', { class: 'stack' });

    function rowFor(x, remove) {
      const choose = select([['', 'Choose an exercise'], ['__new', `Add "${x.name}" as a new exercise`], ...libOptions], { value: x.exercise_id ?? '__new', 'aria-label': `Exercise for ${x.name}` });
      const newName = input({ value: x.name, maxlength: '120', 'aria-label': 'New exercise name' });
      const cat = select([['', 'No category'], ...status.categories.map((c) => [c, c])], { 'aria-label': 'New exercise category' });
      const newBox = h('div', { class: 'row wrap', style: 'gap:8px' }, h('div', { class: 'grow', style: 'min-width:160px' }, newName), h('div', { style: 'width:160px' }, cat));
      const badge = h('span', { class: 'small' });
      const sync = () => {
        newBox.style.display = choose.value === '__new' ? 'flex' : 'none';
        const picked = choose.value;
        if (picked === '__new') { badge.className = 'small muted'; badge.textContent = 'New to your library'; }
        else if (!picked) { badge.className = 'small warn-text'; badge.textContent = 'Choose one'; }
        else if (picked === x.exercise_id && x.how === 'suggested') { badge.className = 'small warn-text'; badge.textContent = 'Closest match: check it'; }
        else { badge.className = 'small good-text'; badge.textContent = picked === x.exercise_id && x.how === 'exact' ? 'Matched' : 'Chosen'; }
      };
      choose.addEventListener('change', sync); sync();
      const rx = input({ value: x.prescription, maxlength: '80', placeholder: '3 × 8', 'aria-label': `Sets and reps for ${x.name}` });
      const lt = select(LOAD_OPTIONS, { value: x.load_test ?? '', 'aria-label': 'Weight from a tested max' });
      const lp = input({ type: 'number', min: '30', max: '110', inputmode: 'numeric', placeholder: '%', value: x.load_pct ? String(x.load_pct) : '', 'aria-label': 'Percent of max' });
      const syncLoad = () => { lp.disabled = !lt.value; };
      lt.addEventListener('change', syncLoad); syncLoad();
      const el = h('div', { class: 'list-item', style: 'align-items:flex-start' },
        h('div', { class: 'grow stack-tight', style: 'min-width:0' },
          h('div', { class: 'row', style: 'gap:8px;align-items:center' },
            h('div', { class: 'grow row wrap', style: 'gap:8px;align-items:center' }, h('span', { class: 'small muted' }, 'In the file: ', h('strong', null, x.name)), badge),
            btn('Remove', () => remove(), 'ghost', { 'aria-label': `Remove ${x.name}` })),
          choose, newBox,
          h('div', { class: 'row wrap', style: 'gap:8px' }, h('div', { style: 'flex:1 1 120px;min-width:0' }, rx), h('div', { style: 'flex:1 1 180px;min-width:0' }, lt), h('div', { style: 'flex:0 0 5.5rem' }, lp)),
          x.note ? h('span', { class: 'small pg-note' }, `Note from the file: ${x.note}`) : null));
      return { el, value: () => ({
        ...(choose.value === '__new' ? { new_exercise: { name: newName.value.trim(), category: cat.value || null } } : { exercise_id: choose.value || null }),
        prescription: rx.value.trim(), ...(lt.value ? { load_test: lt.value, load_pct: Number(lp.value) } : { load_test: null }) }) };
    }

    function dayFor(w) {
      const week = input({ type: 'number', min: '1', max: '52', inputmode: 'numeric', value: String(w.week), 'aria-label': 'Week', style: 'width:5rem' });
      const day = input({ type: 'number', min: '1', max: '7', inputmode: 'numeric', value: String(w.day), 'aria-label': 'Day', style: 'width:5rem' });
      const title = input({ value: w.title, maxlength: '120', 'aria-label': 'Workout title' });
      const rows = [];
      const rowsBox = h('div');
      const entry = { w, rows };
      const drawRows = () => fill(rowsBox, rows.length ? rows.map((r) => r.el) : h('p', { class: 'small warn-text' }, 'No exercises left. Remove this day, or it can\'t be saved.'));
      for (const x of w.exercises) { const r = rowFor(x, () => { rows.splice(rows.indexOf(r), 1); drawRows(); }); rows.push(r); }
      drawRows();
      entry.el = h('div', { class: 'dp-panel stack' },
        h('div', { class: 'row wrap', style: 'gap:8px;align-items:flex-end' },
          field('Week', week), field('Day', day), h('div', { class: 'grow', style: 'min-width:180px' }, field('Title', title)),
          btn('Remove day', () => { days.splice(days.indexOf(entry), 1); drawDays(); }, 'ghost', { 'aria-label': `Remove week ${w.week}, day ${w.day}` })),
        rowsBox);
      entry.value = () => ({ week: Number(week.value), day: Number(day.value), title: title.value.trim(), exercises: rows.map((r) => r.value()) });
      return entry;
    }
    const drawDays = () => fill(list, days.length ? days.map((x) => x.el) : h('p', { class: 'muted small' }, 'Every day was removed. Read the file again to start over.'));
    for (const w of d.workouts) days.push(dayFor(w));
    drawDays();

    const c = d.counts;
    const problems = h('div');
    const save = btn(target ? `Add to ${target.name}` : 'Save the program', (e) => busy(e.currentTarget, async () => {
      fill(problems);
      const body = { workouts: days.map((x) => x.value()), ...(target ? { program_id: target.id } : { program: { name: name.value.trim(), level: level.value, description: desc.value.trim() } }) };
      try {
        const out = await post('/v1/programs/import', body);
        toast(`${out.added_to_existing ? `Added to ${out.name}` : `${out.name} created`}: ${plural(out.workouts, 'workout')}${out.new_exercises ? `, ${plural(out.new_exercises, 'new exercise')} in the library` : ''}.`);
        location.hash = `#/programs/${out.program_id}`;
      } catch (x) {
        fill(problems, h('div', { class: 'dp-error', role: 'alert' }, h('p', null, x.message),
          x.details?.problems?.length ? h('ul', null, x.details.problems.map((p) => h('li', { class: 'small' }, p))) : null,
          x.details?.problem_count > (x.details?.problems?.length ?? 0) ? h('p', { class: 'small' }, `And ${x.details.problem_count - x.details.problems.length} more.`) : null));
        problems.scrollIntoView({ block: 'center' });
      }
    }), 'primary');

    fill(draftBox,
      panel(`Check the draft from ${d.filename}`, { subtitle: `${plural(c.workouts, 'workout')} over ${plural(d.weeks, 'week')} · ${plural(c.exercises, 'exercise')}: ${c.exact} matched to your library, ${c.suggested} to check, ${c.new} new.` },
        target ? h('p', { class: 'small' }, `These workouts are added to ${target.name}. Weeks and days it already has are refused; change them here.`)
          : h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('Program name', name), field('Level', level)), field('Description', desc)),
        d.notes.length ? h('div', { class: 'stack-tight' }, h('strong', { class: 'small warn-text' }, 'Claude wasn\'t sure about these. Check them against the file:'), h('ul', null, d.notes.map((n) => h('li', { class: 'small' }, n)))) : null,
        h('p', { class: 'small muted' }, 'Check each exercise: "Matched" is the same name as in your library, "Closest match" needs a look, and anything not in the library can be added as a new one. Sets and reps read like 3 × 8.')),
      list, problems,
      h('div', { class: 'row wrap' }, save, btn('Start over', () => { fill(draftBox); file.value = ''; }, 'ghost')));
    draftBox.scrollIntoView({ block: 'start' });
  }
}
