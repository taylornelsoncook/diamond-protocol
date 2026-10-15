// Programs → Build from a picture: a photo of the whiteboard (the phone's camera opens straight from the page) goes to
// Claude, which reads it with the owner's drawing rules: a solid line across the board starts a new block, a dashed
// line a new complex inside the block. The draft comes back as the board's sections, each with its blocks, every line
// matched to the exercise library and, where it names one, to the complex library. The coach checks it beside the
// photo, fixes what's off, and saves it as one workout in a program (every block of the board a named block of the
// workout, with a tick to save any of them to the complex library). Nothing is saved until Save.
import { h, fill, toast, busy, btn, field, input, select, panel } from './ui.js';
import { exerciseRow, waitForRead, pendingRead } from './program-import.js';
import { GROUP_KINDS } from './set-fields.js';

const MAX_PHOTO_MB = 3.7;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const textarea = (value = '', attrs = {}) => { const t = h('textarea', { class: 'dp-input', ...attrs }); t.value = value ?? ''; return t; };

function readPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!/\.(png|jpe?g|webp)$/.test(file.name.toLowerCase()) && !/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Choose a photo (PNG, JPG or WebP). A PDF goes through Build from a PDF.'));
    if (file.size > MAX_PHOTO_MB * 1024 * 1024) return reject(new Error(`That photo is bigger than ${MAX_PHOTO_MB} MB. Take a screenshot of it, or send a smaller size.`));
    const r = new FileReader();
    r.onerror = () => reject(new Error('That photo couldn\'t be read. Choose it again.'));
    r.onload = () => resolve({ name: /\.(png|jpe?g|webp)$/.test(file.name.toLowerCase()) ? file.name : `${file.name || 'board'}.${file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'}`, data_base64: String(r.result).split(',')[1] ?? '' });
    r.readAsDataURL(file);
  });
}

export async function boardView(main, deps) {
  const get = (p) => deps.api('GET', p), post = (p, b) => deps.api('POST', p, b);
  const [status, progs, exs, cpx] = await Promise.all([get('/v1/programs/import/status'), get('/v1/programs'), get('/v1/exercises'), get('/v1/complexes')]);
  const box = h('div', { class: 'stack', style: 'gap:24px' });
  fill(main, deps.header('Build from a picture', 'Take a photo of the whiteboard and it comes back as a workout: solid lines start a block, dashed lines a complex inside it.',
    h('a', { class: 'dp-btn dp-btn--ghost', href: '#/programs' }, 'Back to programs')), box);

  if (!status.ready) {
    fill(box, panel('Almost ready', { subtitle: 'Reading a photo uses Claude, from Anthropic, and needs a key.' },
      h('p', { class: 'small' }, deps.role() === 'owner'
        ? 'Get a key at console.anthropic.com (API keys), then in Render open diamond-protocol, Environment, and add ANTHROPIC_API_KEY with the key as its value. Save, and this page works after the restart. A photo costs a few cents to read.'
        : 'Ask the owner to add the Anthropic key in Render. Then this page works.')));
    return;
  }

  // Step 1: the photo and where it goes. capture opens the camera on a phone; on a computer it's a file picker.
  const photo = h('input', { type: 'file', class: 'dp-input', accept: 'image/png,image/jpeg,image/webp', capture: 'environment', 'aria-label': 'A photo of the whiteboard' });
  const where = select([['', 'A new program'], ...progs.data.map((p) => [p.id, `Add to ${p.name}`])], { 'aria-label': 'Where it goes' });
  // The preview is the photo as a data: address (the page's rules allow those, not blob: ones), read once and sent as it is.
  const preview = h('img', { alt: 'The photo you chose', style: 'max-width:100%;max-height:60vh;border-radius:8px;display:none' });
  let chosen = null;
  photo.addEventListener('change', async () => {
    chosen = null; preview.style.display = 'none';
    const f = photo.files[0];
    if (!f) return;
    try { chosen = await readPhoto(f); preview.src = `data:${f.type || 'image/jpeg'};base64,${chosen.data_base64}`; preview.style.display = ''; }
    catch (x) { toast(x.message, 'warn'); photo.value = ''; }
  });
  const draftBox = h('div', { class: 'stack' });
  const readBtn = btn('Read the board', (e) => busy(e.currentTarget, async () => {
    if (!chosen) throw new Error('Take or choose the photo first.');
    const status = h('p', { class: 'small muted', role: 'status' }, 'Reading the board…');
    fill(draftBox, status);
    try {
      const job = await post('/v1/programs/board/jobs', { file: chosen });
      editor(await waitForRead(get, job, { status, what: 'Reading the board' }));
    } catch (x) { fill(draftBox, h('div', { class: 'dp-error', role: 'alert' }, x.message)); }
  }), 'primary');
  const pending = pendingRead('board');   // a read started earlier in this tab: pick it back up
  if (pending) setTimeout(async () => {
    const status = h('p', { class: 'small muted', role: 'status' }, 'Picking the read back up…');
    fill(draftBox, status);
    try { editor(await waitForRead(get, { id: pending.id, kind: 'board', status: 'running', seconds: Math.round((Date.now() - pending.started) / 1000) }, { status, what: 'Reading the board' })); }
    catch (x) { fill(draftBox, h('div', { class: 'dp-error', role: 'alert' }, x.message)); }
  }, 0);
  const lock = (on) => { where.disabled = on; photo.disabled = on; readBtn.disabled = on; };
  fill(box, panel('The whiteboard', { subtitle: 'Stand square to the board with all of it in the frame, in good light. Draw a solid line across the board between blocks and a dashed line between the complexes inside a block; sets and reps to the right of each line.' },
    h('div', { class: 'form-grid' }, field('Photo', photo, `Up to ${MAX_PHOTO_MB} MB. On a phone this opens the camera.`), field('Save it in', where)),
    preview,
    h('p', { class: 'small muted' }, 'The photo is sent to Anthropic (Claude) to be read. Keep athletes\' names off the board.'),
    h('div', null, readBtn)), draftBox);

  // Step 2: the draft, section by section, beside the photo.
  function editor(d) {
    const target = progs.data.find((p) => p.id === where.value) ?? null;
    lock(true);
    const byName = new Map(exs.data.map((e) => [e.name.toLowerCase(), e]));
    const listId = 'bi-library';
    const datalist = h('datalist', { id: listId }, exs.data.map((e) => h('option', { value: e.name })));
    const complexById = new Map(cpx.data.map((c) => [c.id, c]));
    const complexOptions = [['', 'Not a complex'], ...cpx.data.map((c) => [c.id, `${c.name} (${plural(c.exercises.length, 'exercise')})`])];
    const name = input({ value: d.title, maxlength: '120', 'aria-label': 'Program name' });
    const level = select([['', 'Any level'], ...status.levels.map((l) => [l, l])], { 'aria-label': 'Level' });
    const desc = textarea('', { rows: '2', maxlength: '2000', 'aria-label': 'Description' });
    const title = input({ value: d.title, maxlength: '120', 'aria-label': 'Workout title' });
    const week = input({ type: 'number', min: '1', max: '52', inputmode: 'numeric', value: String(target ? Math.min(52, target.weeks + 1) : 1), 'aria-label': 'Week', style: 'width:5rem' });
    const day = input({ type: 'number', min: '1', max: '7', inputmode: 'numeric', value: '1', 'aria-label': 'Day', style: 'width:5rem' });
    const blocks = [];
    const list = h('div', { class: 'stack' });

    // One block of the board (a part between dashed lines): its name, how it runs, the whole thing as a library
    // complex, or its lines (each a library exercise, a new one, or a complex whose exercises come in there), and
    // the tick to save it to the complex library.
    function blockFor(b, sectionName, remove) {
      const bname = input({ value: b.name, maxlength: '40', 'aria-label': 'Block name' });
      const kind = select(Object.entries(GROUP_KINDS).map(([k, l]) => [k, l]), { value: b.kind, 'aria-label': 'How the block runs' });
      const whole = select(complexOptions, { value: b.complex?.how === 'exact' ? b.complex.complex_id : '', 'aria-label': 'Load the whole block as a library complex' });
      const saveTick = h('input', { type: 'checkbox', 'aria-label': 'Save this block to the complex library' });
      const saveName = input({ value: b.name, maxlength: '60', 'aria-label': 'Complex name', disabled: true });
      saveTick.addEventListener('change', () => { saveName.disabled = !saveTick.checked; });
      const rows = [];
      const rowsBox = h('div');
      const entry = { b, rows };
      const drawRows = () => fill(rowsBox, rows.length ? rows.map((r) => r.el) : h('p', { class: 'small warn-text' }, 'No lines left. Remove this block, or load a complex into it.'));
      for (const x of b.exercises) { const r = lineFor(x, () => { rows.splice(rows.indexOf(r), 1); drawRows(); }); rows.push(r); }
      drawRows();
      const linesBox = h('div', { class: 'stack' }, rowsBox);
      const syncWhole = () => { linesBox.style.display = whole.value ? 'none' : ''; saveTick.disabled = !!whole.value; if (whole.value) { saveTick.checked = false; saveName.disabled = true; } };
      whole.addEventListener('change', syncWhole); syncWhole();
      const wholeNote = b.complex?.how === 'suggested' ? h('p', { class: 'small warn-text' }, `This looks like your complex ${b.complex.complex_name}. Choose it above to load it as it is in the library, or keep the lines as read.`) : null;
      entry.el = h('div', { class: 'dp-panel stack' },
        h('div', { class: 'row wrap', style: 'gap:8px;align-items:flex-end' },
          h('div', { class: 'grow', style: 'min-width:160px' }, field('Block', bname)), field('Runs as', kind),
          h('div', { style: 'min-width:220px' }, field('Load a complex instead', whole)),
          btn('Remove block', () => remove(), 'ghost', { 'aria-label': `Remove ${b.name}` })),
        h('p', { class: 'small muted' }, `From ${sectionName}, part ${b.part}.`), wholeNote,
        linesBox,
        h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, h('label', { class: 'row', style: 'gap:6px;align-items:center' }, saveTick, h('span', { class: 'small' }, 'Save it to the complex library as')), h('div', { style: 'width:220px' }, saveName)));
      entry.value = () => ({ name: bname.value.trim(), kind: kind.value, complex_id: whole.value || null, save_as_complex: saveTick.checked ? saveName.value.trim() : null, exercises: whole.value ? [] : rows.map((r) => r.value()) });
      return entry;
    }
    // A line that names a library complex loads that complex's exercises in its place; the coach can make it an exercise instead.
    function lineFor(x, remove) {
      if (x.complex) {
        let asComplex = x.complex.how === 'exact';
        const row = exerciseRow(x, { byName, listId, status, remove, where: 'On the board' });
        const cx = complexById.get(x.complex.complex_id);
        const cxBox = h('div', { class: 'list-item', style: 'align-items:flex-start' },
          h('div', { class: 'grow stack-tight' },
            h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, h('span', { class: 'small muted' }, 'On the board: ', h('strong', null, x.name)), h('span', { class: 'small good-text' }, `Your complex ${x.complex.complex_name}${cx ? ` (${plural(cx.exercises.length, 'exercise')})` : ''} goes in here`)),
            cx ? h('p', { class: 'small muted' }, cx.exercises.map((e) => `${e.name} ${e.prescription}`).join(' · ')) : null,
            h('div', { class: 'row wrap', style: 'gap:8px' }, btn('Treat it as one exercise instead', () => { asComplex = false; sync(); }, 'ghost'), btn('Remove', () => remove(), 'ghost', { 'aria-label': `Remove ${x.name}` }))),
        );
        const offer = x.complex.how === 'suggested' ? btn(`It's my complex ${x.complex.complex_name}`, () => { asComplex = true; sync(); }, 'ghost') : null;
        const el = h('div', null, cxBox, row.el, offer);
        const sync = () => { cxBox.style.display = asComplex ? '' : 'none'; row.el.style.display = asComplex ? 'none' : ''; if (offer) offer.style.display = asComplex ? 'none' : ''; };
        sync();
        return { el, useSuggestion: () => (asComplex ? 0 : row.useSuggestion()), value: () => (asComplex ? { complex_id: x.complex.complex_id } : row.value()) };
      }
      return exerciseRow(x, { byName, listId, status, remove, where: 'On the board' });
    }
    const drawBlocks = () => fill(list, blocks.length ? blocks.map((x) => x.el) : h('p', { class: 'muted small' }, 'Every block was removed. Read the board again to start over.'));
    for (const s of d.sections) for (const b of s.blocks) { const e = blockFor(b, s.name, () => { blocks.splice(blocks.indexOf(e), 1); drawBlocks(); }); blocks.push(e); }
    drawBlocks();

    const c = d.counts;
    const problems = h('div');
    const useAll = c.suggested ? btn(`Use all ${c.suggested} closest matches`, () => {
      const n = blocks.reduce((t, x) => t + x.rows.reduce((k, r) => k + r.useSuggestion(), 0), 0);
      toast(n ? `${plural(n, 'closest match', 'closest matches')} chosen. Check them before saving.` : 'Nothing left to fill in.');
    }, 'secondary') : null;
    const save = btn(target ? `Add to ${target.name}` : 'Save the workout', (e) => busy(e.currentTarget, async () => {
      fill(problems);
      const body = { title: title.value.trim(), week: Number(week.value), day: Number(day.value), blocks: blocks.map((x) => x.value()),
        ...(target ? { program_id: target.id } : { program: { name: name.value.trim(), level: level.value, description: desc.value.trim() } }) };
      try {
        const out = await post('/v1/programs/board-import', body);
        toast(`${out.added_to_existing ? `Added to ${out.name}` : `${out.name} created`}: ${plural(out.blocks, 'block')}, ${plural(out.exercises, 'exercise')}${out.new_exercises ? `, ${plural(out.new_exercises, 'new exercise')} in the library` : ''}${out.complexes_saved.length ? `, ${plural(out.complexes_saved.length, 'complex', 'complexes')} saved` : ''}.`);
        location.hash = `#/programs/${out.program_id}`;
      } catch (x) {
        fill(problems, h('div', { class: 'dp-error', role: 'alert' }, h('p', null, x.message),
          x.details?.problems?.length ? h('ul', null, x.details.problems.map((p) => h('li', { class: 'small' }, p))) : null,
          x.details?.problem_count > (x.details?.problems?.length ?? 0) ? h('p', { class: 'small' }, `And ${x.details.problem_count - x.details.problems.length} more.`) : null));
        problems.scrollIntoView({ block: 'center' });
      }
    }), 'primary');

    fill(draftBox,
      panel('Check the draft', { subtitle: `${plural(c.sections, 'section')} between solid lines, ${plural(c.blocks, 'block')} in all · ${plural(c.exercises, 'line')}: ${c.exact} matched to your library, ${c.suggested} to check, ${c.new} new${c.complexes ? `, ${plural(c.complexes, 'complex', 'complexes')} from your library` : ''}.` },
        target ? h('div', { class: 'row wrap', style: 'gap:8px;align-items:flex-end' }, h('div', { class: 'grow', style: 'min-width:180px' }, field('Workout title', title)), field('Week', week), field('Day', day))
          : h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('Program name', name), field('Level', level)), field('Description', desc),
            h('div', { class: 'row wrap', style: 'gap:8px;align-items:flex-end' }, h('div', { class: 'grow', style: 'min-width:180px' }, field('Workout title', title)), field('Week', week), field('Day', day))),
        d.notes.length ? h('div', { class: 'stack-tight' }, h('strong', { class: 'small warn-text' }, 'Claude wasn\'t sure about these. Check them against the photo:'), h('ul', null, d.notes.map((n) => h('li', { class: 'small' }, n)))) : null,
        h('p', { class: 'small muted' }, 'Each part of the board between lines is a block of the workout. Check each line: "Matched" is the same name as in your library; a closest match is only offered. A line with no numbers on the board is 1 set. Tick "Save it to the complex library" on a block you\'ll write again, and the next board matches it by name.'),
        useAll ? h('div', null, useAll) : null, datalist),
      list, problems,
      h('div', { class: 'row wrap' }, save, btn('Start over', () => { fill(draftBox); photo.value = ''; chosen = null; preview.style.display = 'none'; lock(false); }, 'ghost')));
    draftBox.scrollIntoView({ block: 'start' });
  }
}
