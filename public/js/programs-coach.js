// Coach side of Programs: the Programs page (what athletes logged, who needs a check-in), the exercise library (shown in
// Settings) and the
// program builder (one week at a time). Owners and coaches build and assign; front desk sees everything read-only and
// can email an athlete their workout app link. The server enforces the same rules.
import { h, fill, toast, busy, btn, field, input, select, panel, ago, money, videoEmbed, playIcon } from './ui.js';
import { saleForm } from './shop-admin.js';
import { importView } from './program-import.js';

let deps = null;     // { api, render, header, role, pulseTile }
export function initPrograms(d) { deps = d; }
// Programs → Build from a PDF (program-import.js).
export const viewProgramImport = (main) => importView(main, deps);
const get = (p) => deps.api('GET', p), post = (p, b = {}) => deps.api('POST', p, b), patch = (p, b) => deps.api('PATCH', p, b), put = (p, b) => deps.api('PUT', p, b), del = (p, b) => deps.api('DELETE', p, b);
const canEdit = () => ['owner', 'coach'].includes(deps.role());
const isOwner = () => deps.role() === 'owner';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const first = (name) => name.split(' ')[0];
const LOAD_LIFT = { squat_1rm: 'back squat', bench_1rm: 'bench press', power_clean_1rm: 'power clean' };
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'All levels'];
const loadText = (x) => (x.load_test ? `${x.load_pct}% of ${LOAD_LIFT[x.load_test]} max` : null);
const textarea = (value = '', attrs = {}) => { const t = h('textarea', { class: 'dp-input', ...attrs }); t.value = value ?? ''; return t; };
const bar = (pct, label) => h('div', { class: 'eg-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': label }, h('span', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));

// A dialog with a title, a body and buttons. An action's onClick returns false to keep the dialog open; errors show in it.
function dialog(title, body, actions) {
  const d = document.getElementById('dialog');
  const err = h('div', { class: 'dp-error', role: 'alert' });
  fill(d, h('div', { class: 'stack' }, h('h2', { class: 'week-title', style: 'color:var(--steel)' }, title), body, err,
    h('div', { class: 'row wrap' }, actions.map((a) => btn(a.label, async (e) => {
      if (!a.onClick) return d.close();
      err.textContent = '';
      const b = e.currentTarget; b.disabled = true;
      try { if ((await a.onClick(d)) !== false) d.close(); } catch (x) { err.textContent = x.message; } finally { b.disabled = false; }
    }, a.variant ?? 'secondary')))));
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
  return d;
}
// Only the latest removal can be undone: undoing older ones first would put exercises back in the wrong order.
function undoToast(msg, onUndo) {
  document.querySelectorAll('#toasts .dp-toast--undo').forEach((x) => x.remove());
  const t = h('div', { class: 'dp-toast dp-toast--undo', role: 'status' }, msg, ' ', h('button', { type: 'button', class: 'dp-btn dp-btn--ghost', style: 'min-height:32px;padding:0 8px;color:inherit;text-decoration:underline', onClick: () => { t.remove(); onUndo(); } }, 'Undo'));
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 10000);
}
function showVideo(x) {
  const d = document.getElementById('dialog');
  fill(d, h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('h2', { class: 'week-title grow', style: 'color:var(--steel)' }, x.name), btn('Close', () => d.close(), 'ghost')),
    videoEmbed(x.video_url, x.name, undefined, x.poster_url), x.instructions ? h('p', { class: 'muted' }, x.instructions) : null));
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
}
const playBtn = (x) => {
  const b = h('button', { type: 'button', class: `dp-ex-play${x.poster_url ? ' dp-ex-play--poster' : ''}`, 'aria-label': `Watch ${x.name} demo`, onClick: () => showVideo(x) }, playIcon());
  if (x.poster_url) b.style.backgroundImage = `url("${x.poster_url.replace(/["\\\n\r]/g, encodeURIComponent)}")`;   // already a checked https link; only quotes need escaping
  return b;
};
async function sendLink(c) {
  const r = await post(`/v1/clients/${c.id}/app-link/email`);
  toast(`Workout app link sent to ${r.sent_to.join(', ')}.`);
}

// ---------- Programs page ----------
const pageState = { q: '', level: '', exQ: '', exCat: '', exFilter: '' };

export async function viewPrograms(main) {
  const [progs, exs, act, shop] = await Promise.all([get('/v1/programs'), get('/v1/exercises'), get('/v1/programs/activity'), isOwner() ? get('/v1/shop') : null]);
  const noVideo = exs.data.filter((x) => !x.video_url).length;
  const edit = canEdit();

  // Programs: search and level filter.
  const cards = h('div', { class: 'workouts' });
  const search = input({ type: 'search', placeholder: 'Search programs', 'aria-label': 'Search programs', value: pageState.q });
  const levels = [...new Set([...LEVELS, ...progs.data.map((p) => p.level).filter(Boolean)])];
  const levelSel = select([['', 'Every level'], ...levels.map((l) => [l, l])], { value: pageState.level, 'aria-label': 'Level' });
  const drawCards = () => {
    const q = pageState.q.trim().toLowerCase();
    const shown = progs.data.filter((p) => (!q || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q)) && (!pageState.level || p.level === pageState.level));
    fill(cards, shown.length ? shown.map((p) => h('a', { href: `#/programs/${p.id}`, class: 'dp-panel pg-card' },
      h('div', { class: 'week-title', style: 'color:var(--steel)' }, p.name),
      h('div', { class: 'small muted' }, [`${plural(p.weeks, 'week')}`, p.level ?? 'Any level', p.days_per_week ? `${p.days_per_week} ${p.days_per_week === 1 ? 'day' : 'days'} a week` : null, plural(p.workout_count, 'workout')].filter(Boolean).join(' · ')),
      h('div', { class: 'small' }, `${plural(p.client_count, 'client')} · `, h('span', { class: p.logged_7d ? 'good-text' : 'muted' }, `${plural(p.logged_7d, 'workout')} logged in the last 7 days`))))
      : h('div', { class: 'empty', style: 'grid-column:1/-1' }, progs.data.length ? 'No programs match. Clear the search or level.' : edit ? 'No programs yet. Use New program to build your first one.' : 'No programs yet.'));
  };
  search.addEventListener('input', () => { pageState.q = search.value; drawCards(); });
  levelSel.addEventListener('change', () => { pageState.level = levelSel.value; drawCards(); });
  drawCards();

  const pulse = h('div', { class: 'pulse' },
    deps.pulseTile('Workouts logged', act.logged_7d, 'Last 7 days', { tone: act.logged_7d ? 'good' : null }),
    deps.pulseTile('On a program', act.on_programs, 'Current clients'),
    deps.pulseTile('Need a check-in', act.quiet.length, 'No workout in 7 days or more', { tone: act.quiet.length ? 'warn' : null }),
    deps.pulseTile('Finished', act.complete.length, 'Every workout done'));

  const personRow = (c, detail) => h('div', { class: 'list-item' },
    h('div', { class: 'grow stack-tight' }, h('a', { href: `#/clients/${c.id}`, class: 'strong', style: 'color:inherit' }, c.name), h('span', { class: 'small muted' }, detail)),
    btn('Send link', (e) => busy(e.currentTarget, () => sendLink(c)), 'ghost', { 'aria-label': `Email ${first(c.name)} the workout app link` }));
  const checkOn = act.quiet.length || act.complete.length ? panel('Athletes to check on', { subtitle: 'No workout in a week, or every workout done and ready for the next block.' },
    act.quiet.map((c) => personRow(c, `${c.program_name} · ${c.last_workout_at ? `last workout ${ago(c.last_workout_at).toLowerCase()}` : `no workouts in ${plural(c.days_idle, 'day')}`}${c.next ? ` · next: week ${c.next.week}, day ${c.next.day}` : ''}`)),
    act.complete.map((c) => personRow(c, `Finished ${c.program_name}. Give ${first(c.name)} the next block.`))) : null;

  const feed = panel('Recent workouts', { subtitle: 'The last 14 days. Effort and notes come from the athletes.' },
    act.recent.length ? act.recent.map(workoutRow) : h('p', { class: 'muted small' }, 'Workouts show up here as athletes log them in the app or on the weight-room screen.'));

  fill(main,
    deps.header('Programs', 'Build training, attach demo videos and assign to clients.', edit ? h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/programs/import' }, 'Build from a PDF'), btn('New program', () => newProgramDialog(progs.data))) : null),
    pulse,
    h('div', { class: 'split' },
      h('div', { class: 'stack', style: 'gap:24px' },
        h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: 'min-width:200px' }, search), h('div', { style: 'width:180px' }, levelSel)),
        cards, checkOn, feed, shop ? storePanel(shop) : null),
      panel('Exercise library', { subtitle: `${plural(exs.data.length, 'exercise')}${noVideo ? ` · ${noVideo} without a demo video` : ''}. It lives in Settings.` },
        h('div', null, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/settings' }, 'Open the exercise library')))));
}

// One logged workout in a feed.
export function workoutRow(l) {
  const bits = [`${l.program_name} · week ${l.week}, day ${l.day}`, l.program_deleted ? 'deleted from the program since (the log stays)' : null, `${l.exercises_logged} of ${l.exercises_total} exercises`, l.sets ? plural(l.sets, 'set') : null,
    l.rpe ? `effort ${l.rpe}/10` : null, l.minutes ? `${l.minutes} min` : null, l.source === 'screen' ? 'weight-room screen' : null].filter(Boolean);
  return h('div', { class: 'list-item', style: 'align-items:flex-start' },
    h('div', { class: 'grow stack-tight' },
      h('span', null, h('a', { href: `#/clients/${l.client_id}`, class: 'strong', style: 'color:inherit' }, l.client_name), ` finished ${l.workout_title}`),
      h('span', { class: 'small muted' }, bits.join(' · ')),
      l.bests?.length ? h('span', { class: 'small good-text' }, `New best: ${l.bests.map((b) => `${b.name} ${b.weight} lb (was ${b.previous})`).join(', ')}`) : null,
      l.notes ? h('span', { class: 'small pg-note' }, `“${l.notes}”`) : null),
    h('span', { class: 'small muted', style: 'white-space:nowrap' }, ago(l.completed_at)));
}

function newProgramDialog(list) {
  const name = input({ required: true }), weeks = input({ type: 'number', min: '1', max: '52', value: '8', inputmode: 'numeric' });
  const level = select(LEVELS.map((l) => [l, l]));
  const from = select([['', 'An empty program'], ...list.map((p) => [p.id, `A copy of ${p.name}`])]);
  from.addEventListener('change', () => { const src = list.find((p) => p.id === from.value); if (src) { weeks.value = String(src.weeks); if (src.level && LEVELS.includes(src.level)) level.value = src.level; } });
  dialog('New program', h('div', { class: 'stack' }, field('Program name', name), h('div', { class: 'form-grid' }, field('Weeks', weeks), field('Level', level)),
    field('Start from', from, 'A copy brings the workouts in the weeks you keep.')), [
    { label: 'Create program', variant: 'primary', onClick: async () => {
      const p = await post('/v1/programs', { name: name.value, weeks: Number(weeks.value), level: level.value, copy_from: from.value || undefined });
      toast(from.value ? 'Program created from the copy.' : 'Program created. Add its first workout.'); location.hash = `#/programs/${p.id}`;
    } },
    { label: 'Cancel', variant: 'ghost' }]);
  name.focus();
}

// Owners: what's in the online store and the link to share.
function storePanel(shop) {
  const listed = [...shop.programs, ...shop.courses].filter((x) => x.listed);
  const link = `${location.origin}/shop`;
  return panel('Online store', { subtitle: listed.length ? `${listed.length} for sale · ${shop.last_30_days.sold} sold in the last 30 days (${money(shop.last_30_days.cents)})` : 'Nothing for sale yet. Open a program and use Sell online, or a course on the Education tab.' },
    listed.map((x) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.title), h('span', { class: 'small muted' }, `${x.kind === 'program' ? 'Program' : 'Course'} · ${money(x.price_cents)} · ${x.sold} sold`)),
      x.kind === 'program' ? h('a', { class: 'dp-btn dp-btn--ghost', href: `#/programs/${x.id}` }, 'Open') : null)),
    h('div', { class: 'row wrap' }, h('code', { class: 'small', style: 'word-break:break-all' }, link),
      btn('Copy link', () => navigator.clipboard.writeText(link).then(() => toast('Link copied. Put it on your website and Instagram.')), 'ghost'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: '/shop', target: '_blank', rel: 'noopener' }, 'View')));
}

// ---------- Exercise library (the first tab of Settings) ----------
export async function exerciseLibrary() { return libraryPanel(await get('/v1/exercises'), canEdit()); }
function libraryPanel(exs, edit) {
  const cats = exs.categories ?? [];
  const q = input({ type: 'search', placeholder: 'Search exercises', 'aria-label': 'Search exercises', value: pageState.exQ });
  const cat = select([['', 'Every category'], ...cats.map((c) => [c, c])], { value: pageState.exCat, 'aria-label': 'Category' });
  const flt = select([['', 'All exercises'], ['no_video', 'Missing a video'], ['unused', 'Not in a program']], { value: pageState.exFilter, 'aria-label': 'Show' });
  const listBox = h('div');
  const count = h('span');
  const PAGE = 60;
  let showing = PAGE;           // a big library shows 60 at a time; search narrows it
  const draw = () => {
    const needle = pageState.exQ.trim().toLowerCase();
    const shown = exs.data.filter((x) => (!needle || x.name.toLowerCase().includes(needle) || (x.instructions ?? '').toLowerCase().includes(needle))
      && (!pageState.exCat || x.category === pageState.exCat) && (pageState.exFilter !== 'no_video' || !x.video_url) && (pageState.exFilter !== 'unused' || !x.uses));
    count.textContent = shown.length === exs.data.length ? plural(exs.data.length, 'exercise') : `${shown.length} of ${exs.data.length} exercises`;
    fill(listBox, shown.length ? [...shown.slice(0, showing).map((x) => h('div', { class: 'list-item' },
      playBtn(x),
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.name),
        h('span', { class: 'small muted' }, [x.category ?? 'No category', x.uses ? `in ${plural(x.uses, 'workout')}` : 'not in a program', x.video_url ? null : 'no video yet'].filter(Boolean).join(' · ')),
        x.programs.length ? h('span', { class: 'small muted' }, `Used in ${x.programs.map((p) => p.name).join(', ')}`) : null),
      edit ? btn('Edit', () => exerciseDialog(x, cats), 'ghost', { 'aria-label': `Edit ${x.name}` }) : null)),
      shown.length > showing ? h('div', { class: 'row', style: 'justify-content:center;padding-top:8px' }, btn(`Show ${Math.min(PAGE, shown.length - showing)} more (${(shown.length - showing).toLocaleString()} left)`, () => { showing += PAGE; draw(); }, 'ghost')) : null]
      : h('p', { class: 'small muted' }, exs.data.length ? 'No exercises match. Clear the search or filters.' : 'No exercises yet.'));
  };
  q.addEventListener('input', () => { pageState.exQ = q.value; showing = PAGE; draw(); });
  cat.addEventListener('change', () => { pageState.exCat = cat.value; showing = PAGE; draw(); });
  flt.addEventListener('change', () => { pageState.exFilter = flt.value; showing = PAGE; draw(); });
  draw();
  return panel('Exercise library', { subtitle: count, action: edit ? h('div', { class: 'row wrap' }, isOwner() ? btn('Import a list', () => importListDialog(), 'ghost') : null, btn('Add exercise', () => exerciseDialog(null, cats), 'secondary')) : null },
    h('div', { class: 'stack', style: 'gap:8px' }, q, h('div', { class: 'form-grid', style: 'gap:8px' }, cat, flt)), listBox);
}
// Owner: bring in a list of exercises (the video upload tool's video-library.csv, or any CSV with a Name column).
// Checked first, every problem listed by row and column; nothing is saved until Bring them in.
function importListDialog() {
  const file = h('input', { type: 'file', class: 'dp-input', accept: '.csv,text/csv', 'aria-label': 'The exercise list' });
  const existing = select([['skip', 'Leave them as they are'], ['add_video', 'Add the video if they have none'], ['replace_video', 'Replace their video with the list\'s']], { 'aria-label': 'Exercises already in the library' });
  const out = h('div', { class: 'stack' });
  let csv = null;
  const check = async () => {
    if (!file.files[0]) throw new Error('Choose the CSV file first.');
    csv = await file.files[0].text();
    const p = await post('/v1/exercises/import/preview', { csv, existing: existing.value });
    fill(out,
      h('p', { class: 'small' }, `${p.rows.toLocaleString()} rows: ${plural(p.new, 'new exercise')} (${p.new_with_video.toLocaleString()} with a video)${p.updated ? `, ${plural(p.updated, 'video')} added or replaced` : ''}${p.skipped ? `, ${p.skipped.toLocaleString()} already in the library and left as they are` : ''}.`),
      p.sample.length ? h('p', { class: 'small muted' }, `For example: ${p.sample.map((x) => x.name).join(', ')}.`) : null,
      p.notes.map((n) => h('p', { class: 'small warn-text' }, n)),
      p.problem_count ? h('div', { class: 'stack-tight' }, h('strong', { class: 'small warn-text' }, `${plural(p.problem_count, 'problem')} to fix in the file first:`),
        h('ul', null, p.problems.map((x) => h('li', { class: 'small' }, `Row ${x.row}, ${x.column}: ${x.message}`))),
        p.problem_count > p.problems.length ? h('p', { class: 'small' }, `And ${p.problem_count - p.problems.length} more.`) : null) : null);
    return p;
  };
  file.addEventListener('change', () => { csv = null; fill(out); });
  existing.addEventListener('change', () => { if (csv) check().catch((e) => fill(out, h('div', { class: 'dp-error' }, e.message))); });
  dialog('Import a list of exercises', h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, 'A CSV with a Name column, and optionally Category, Video URL, Poster URL and Instructions. The video upload tool (see CHECKLIST.md) writes this file for you.'),
    field('File', file), field('Exercises already in the library', existing), out), [
    { label: 'Check the list', onClick: async () => { await check(); return false; } },
    { label: 'Bring them in', variant: 'primary', onClick: async () => {
      const p = csv ? await check() : null;
      if (!p) throw new Error('Check the list first.');
      if (!p.ready) throw new Error(p.problem_count ? 'Fix the problems in the file, then check it again.' : 'There\'s nothing new to bring in.');
      const r = await post('/v1/exercises/import', { csv, existing: existing.value });
      toast(`${plural(r.new, 'exercise')} added${r.updated ? `, ${plural(r.updated, 'video')} updated` : ''}.`);
      deps.render();
    } },
    { label: 'Cancel', variant: 'ghost' }]);
}
function exerciseFields(x, cats) {
  const name = input({ value: x?.name ?? '', required: true }), url = input({ type: 'url', value: x?.video_url ?? '', placeholder: 'https://youtube.com/watch?v=…' });
  const cat = select([['', 'No category'], ...cats.map((c) => [c, c])], { value: x?.category ?? '' });
  const cue = textarea(x?.instructions ?? '', { placeholder: 'One or two coaching cues' });
  return { name, url, cat, cue, body: () => ({ name: name.value, video_url: url.value || null, instructions: cue.value || null, category: cat.value || null }),
    el: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('Name', name), field('Category', cat)), field('Demo video link', url, 'YouTube, Vimeo or a direct .mp4 link.'), field('Coaching cues', cue)) };
}
function exerciseDialog(x, cats) {
  const f = exerciseFields(x, cats);
  const actions = [{ label: x ? 'Save exercise' : 'Add exercise', variant: 'primary', onClick: async () => {
    if (x) await patch(`/v1/exercises/${x.id}`, f.body()); else await post('/v1/exercises', { ...f.body(), video_url: f.url.value || undefined });
    toast(x ? 'Exercise saved.' : 'Exercise added to the library.'); deps.render();
  } }, { label: 'Cancel', variant: 'ghost' }];
  if (x) actions.push({ label: 'Delete exercise', variant: 'ghost', onClick: async () => {
    if (!confirm(`Delete ${x.name} from the library?`)) return false;
    await del(`/v1/exercises/${x.id}`); toast(`${x.name} deleted.`); deps.render();
  } });
  dialog(x ? 'Edit exercise' : 'Add exercise', f.el, actions);
  f.name.focus();
}

// ---------- Program builder ----------
const builder = { focusTab: false };

export async function viewProgram(main, id) {
  const [p, exs, shop] = await Promise.all([get(`/v1/programs/${id}`), get('/v1/exercises'), isOwner() ? get('/v1/shop') : null]);
  const edit = canEdit();
  const qs = new URLSearchParams(location.hash.split('?')[1] ?? '');
  let week = Math.min(Math.max(Number(qs.get('week')) || 1, 1), p.weeks);
  const go = (n) => { history.replaceState(null, '', `#/programs/${id}?week=${n}`); };
  const reload = (n = week) => { go(n); deps.render(); };
  const daysIn = (n) => p.workouts.filter((w) => w.week === n);

  // Week tabs: one week at a time; arrow keys move between weeks and the week stays in the address.
  const tabsBox = h('div', { class: 'row wrap', style: 'align-items:center' });
  const weekBox = h('section', { class: 'stack', role: 'tabpanel', id: 'pg-week-panel' });
  const drawTabs = () => {
    const tabs = h('div', { class: 'ts-tabs grow', role: 'tablist', 'aria-label': 'Weeks' }, Array.from({ length: p.weeks }, (_, i) => i + 1).map((n) => h('button', {
      type: 'button', role: 'tab', class: 'ts-tab', id: `pg-week-${n}`, 'aria-selected': String(n === week), 'aria-controls': 'pg-week-panel', tabindex: n === week ? '0' : '-1',
      onClick: () => { week = n; go(n); draw(); },
      onKeydown: (e) => {
        const to = { ArrowRight: week % p.weeks + 1, ArrowLeft: (week + p.weeks - 2) % p.weeks + 1, Home: 1, End: p.weeks }[e.key];
        if (!to) return;
        e.preventDefault(); week = to; go(to); builder.focusTab = true; draw();
      } }, `Week ${n}`, h('span', { class: 'ts-tab-count' }, String(daysIn(n).length)))));
    fill(tabsBox, tabs, edit ? btn('Add week', (e) => busy(e.currentTarget, async () => {
      if (p.weeks >= 52) throw new Error('A program can be up to 52 weeks.');
      await patch(`/v1/programs/${id}`, { weeks: p.weeks + 1 }); toast(`Week ${p.weeks + 1} added.`); reload(p.weeks + 1);
    }), 'ghost') : null);
    if (builder.focusTab) { builder.focusTab = false; tabs.querySelector('[aria-selected="true"]')?.focus(); }
  };
  const draw = () => { drawTabs(); drawWeek(); };

  const drawWeek = () => {
    weekBox.setAttribute('aria-labelledby', `pg-week-${week}`);
    const days = daysIn(week);
    const isLast = week === p.weeks;
    const logged = days.reduce((n, w) => n + w.logs, 0);
    const weekActions = edit ? h('div', { class: 'row wrap' },
      days.length < 7 ? btn('Add day', () => dayDialog(p, week, reload), 'secondary') : null,
      days.length ? btn('Copy week', () => copyWeekDialog(p, week, reload), 'ghost') : null,
      days.length || (isLast && p.weeks > 1) ? btn('Delete week', (e) => {
        const msg = days.length ? `Delete week ${week}'s ${plural(days.length, 'workout')}?${logged ? ` Athletes logged them ${plural(logged, 'time')}; those logs stay in the athletes' history.` : ''}${isLast && p.weeks > 1 ? ' The program becomes shorter.' : ''}` : `Delete the empty week ${week}? The program becomes ${plural(p.weeks - 1, 'week')}.`;
        if (!confirm(msg)) return;
        busy(e.currentTarget, async () => { await del(`/v1/programs/${id}/weeks/${week}`, { confirm: true }); toast(`Week ${week} deleted.`); reload(Math.min(week, isLast && p.weeks > 1 ? p.weeks - 1 : p.weeks)); });
      }, 'ghost') : null) : null;
    fill(weekBox,
      h('div', { class: 'row wrap' }, h('h2', { class: 'week-title grow' }, `Week ${week}`), weekActions),
      days.length ? h('div', { class: 'workouts' }, days.map((w) => workoutCard(p, w, exs, edit, reload)))
        : h('div', { class: 'empty' }, edit ? (isLast && p.weeks > 1 ? `Week ${week} is empty. Add a day, copy another week here, or delete this week.` : `No workouts in week ${week} yet. Add a day, or copy another week here.`) : `No workouts in week ${week} yet.`));
  };

  const header = deps.header(p.name, `${plural(p.weeks, 'week')} · ${p.level ?? 'Any level'} · ${plural(p.clients.length, 'client')} · ${plural(p.logged_7d, 'workout')} logged in the last 7 days`,
    edit ? btn('Assign to a client', () => assignDialog(p)) : null);
  fill(main, header,
    p.description ? h('p', { class: 'muted', style: 'margin-top:-12px' }, p.description) : null,
    edit ? h('div', { class: 'row wrap' }, btn('Edit details', () => detailsDialog(p), 'ghost'), btn('Duplicate program', () => duplicateDialog(p), 'ghost')) : null,
    clientsPanel(p, edit),
    tabsBox, weekBox,
    shop ? panel('Sell online', { subtitle: 'Out-of-town athletes and families buy it from the store page.' }, saleForm(put, 'program', shop.programs.find((x) => x.id === id), () => deps.render())) : null,
    h('div', { class: 'row' }, h('a', { class: 'dp-btn dp-btn--ghost', href: '#/programs' }, 'All programs'), h('span', { class: 'grow' }),
      edit ? btn('Delete program', (e) => { const logged = p.workouts.reduce((n, w) => n + w.logs, 0); if (confirm(`Delete ${p.name}?${logged ? ` Athletes logged its workouts ${plural(logged, 'time')}; those logs stay in the athletes' history.` : ''} This can't be undone.`)) busy(e.currentTarget, async () => { await del(`/v1/programs/${id}`); toast('Program deleted.'); location.hash = '#/programs'; }); }, 'ghost') : null));
  go(week);
  draw();
}

function clientsPanel(p, edit) {
  return panel('Clients on this program', { subtitle: p.clients.length ? 'Workouts done, what\'s next and when they last trained. Amber means no workout in a week.' : null },
    p.clients.length ? p.clients.map((c) => {
      const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
      const stale = !c.complete && c.days_idle >= 7;
      return h('div', { class: 'list-item pg-client' },
        h('div', { class: 'grow stack-tight' },
          h('div', { class: 'row wrap', style: 'gap:8px' }, h('a', { href: `#/clients/${c.id}`, class: 'strong', style: 'color:inherit' }, c.name),
            c.app_open ? null : h('span', { class: 'dp-badge dp-badge--muted' }, c.membership === 'paused' ? 'Paused: app locked' : 'No membership: app locked')),
          h('div', { class: 'row', style: 'gap:8px;max-width:360px' }, h('div', { class: 'grow' }, bar(pct, `${c.name}: ${c.done} of ${c.total} workouts`)), h('span', { class: 'small muted', style: 'white-space:nowrap' }, `${c.done} of ${c.total}`)),
          h('span', { class: 'small muted' }, c.complete ? 'Finished every workout.' : c.next ? `Next: week ${c.next.week}, day ${c.next.day} · ${c.next.title}` : 'No workouts in this program yet.'),
          h('span', { class: `small ${stale ? 'warn-text' : 'muted'}` }, c.last_workout_at ? `Last workout ${ago(c.last_workout_at).toLowerCase()}` : `No workouts yet (${plural(c.days_idle, 'day')} on the program)`)),
        h('div', { class: 'row wrap', style: 'justify-content:flex-end' },
          btn('Send link', (e) => busy(e.currentTarget, () => sendLink(c)), 'ghost', { 'aria-label': `Email ${first(c.name)} the workout app link` }),
          edit ? btn('Remove', (e) => {
            if (!confirm(`Take ${c.name} off ${p.name}? Their logged workouts stay in their history.`)) return;
            busy(e.currentTarget, async () => { await del(`/v1/programs/${p.id}/clients/${c.id}`); toast(`${first(c.name)} is off ${p.name}.`); deps.render(); });
          }, 'ghost', { 'aria-label': `Remove ${c.name} from this program` }) : null));
    }) : h('p', { class: 'muted small' }, edit ? 'Nobody is on this program yet. Use Assign to a client.' : 'Nobody is on this program yet.'));
}

function assignDialog(p) {
  const q = input({ type: 'search', placeholder: 'Name or Athlete ID', 'aria-label': 'Find a client' });
  const out = h('div', { class: 'stack', style: 'gap:0;max-height:50vh;overflow:auto' });
  let clients = null;
  const draw = () => {
    if (!clients) return fill(out, h('p', { class: 'small muted' }, 'Loading clients…'));
    const needle = q.value.trim().toLowerCase();
    const shown = clients.filter((c) => !needle || c.name.toLowerCase().includes(needle) || (c.athlete_id ?? '').toLowerCase().includes(needle)).slice(0, 30);
    fill(out, shown.length ? shown.map((c) => {
      const on = c.program?.id === p.id;
      return h('div', { class: 'list-item' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, c.name), h('span', { class: 'small muted' }, on ? 'Already on this program' : c.program ? `On ${c.program.name}` : 'No program')),
        on ? null : btn('Assign', (e) => {
          if (c.program && !confirm(`Move ${first(c.name)} off ${c.program.name} and onto ${p.name}? Their logged workouts stay.`)) return;
          busy(e.currentTarget, async () => {
            await post(`/v1/programs/${p.id}/assign`, { client_id: c.id });
            document.getElementById('dialog').close();
            toast(`${first(c.name)} is on ${p.name}. Use Send link to email the workout app link.`); deps.render();
          });
        }, 'secondary', { 'aria-label': `Assign ${p.name} to ${c.name}` }));
    }) : h('p', { class: 'small muted' }, 'No clients match.'));
  };
  q.addEventListener('input', draw);
  dialog(`Assign ${p.name}`, h('div', { class: 'stack' }, q, out), [{ label: 'Close', variant: 'ghost' }]);
  draw();
  get('/v1/clients').then((r) => { clients = r.data; draw(); }).catch((e) => fill(out, h('p', { class: 'dp-error' }, e.message)));
  q.focus();
}

function detailsDialog(p) {
  const name = input({ value: p.name }), weeks = input({ type: 'number', min: String(Math.max(1, p.last_week)), max: '52', value: String(p.weeks), inputmode: 'numeric' });
  const levels = [...new Set([...LEVELS, ...(p.level ? [p.level] : [])])];
  const level = select([['', 'Any level'], ...levels.map((l) => [l, l])], { value: p.level ?? '' });
  const desc = textarea(p.description ?? '');
  dialog('Edit details', h('div', { class: 'stack' }, field('Program name', name), h('div', { class: 'form-grid' }, field('Weeks', weeks, p.last_week ? `At least ${p.last_week}: week ${p.last_week} has workouts.` : null), field('Level', level)), field('Description', desc)), [
    { label: 'Save details', variant: 'primary', onClick: async () => { await patch(`/v1/programs/${p.id}`, { name: name.value, weeks: Number(weeks.value), level: level.value || null, description: desc.value || null }); toast('Program saved.'); deps.render(); } },
    { label: 'Cancel', variant: 'ghost' }]);
}
function duplicateDialog(p) {
  const name = input({ value: `${p.name} (copy)` });
  dialog('Duplicate program', h('div', { class: 'stack' }, h('p', { class: 'muted', style: 'margin:0' }, 'Every week and workout is copied. Nobody is assigned to the copy and it isn\'t for sale.'), field('Name of the copy', name)), [
    { label: 'Duplicate', variant: 'primary', onClick: async () => { const c = await post(`/v1/programs/${p.id}/duplicate`, { name: name.value }); toast('Program copied.'); location.hash = `#/programs/${c.id}`; } },
    { label: 'Cancel', variant: 'ghost' }]);
  name.select();
}
function dayDialog(p, week, reload) {
  const used = new Set(p.workouts.filter((w) => w.week === week).map((w) => w.day));
  const free = [1, 2, 3, 4, 5, 6, 7].filter((d) => !used.has(d));
  const day = select(free.map((d) => [String(d), `Day ${d}`]));
  const title = input({ placeholder: 'Lower body' });
  dialog(`Add a day to week ${week}`, h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('Day', day), field('Workout title', title))), [
    { label: 'Add day', variant: 'primary', onClick: async () => { await post(`/v1/programs/${p.id}/workouts`, { week, day: Number(day.value), title: title.value || undefined }); toast('Day added. Add its exercises.'); reload(week); } },
    { label: 'Cancel', variant: 'ghost' }]);
  title.focus();
}
function copyWeekDialog(p, week, reload) {
  const to = input({ type: 'number', min: '1', max: '52', value: String(Math.min(week + 1, 52)), inputmode: 'numeric' });
  const through = input({ type: 'number', min: '1', max: '52', value: String(Math.min(week + 1, 52)), inputmode: 'numeric' });
  const send = async (extra = {}) => {
    try { return await post(`/v1/programs/${p.id}/weeks/${week}/copy`, { to: Number(to.value), through: Number(through.value), ...extra }); }
    catch (e) {
      if (e.code === 'replace_needed' && confirm(`${e.message.replace(' Replace them to copy.', '')} Replace them with week ${week}?`)) return send({ ...extra, replace: true });
      if (e.code === 'confirm_needed' && confirm(e.message.replace(' Send confirm: true to go ahead.', ' Replace anyway?'))) return send({ ...extra, confirm: true });
      if (['replace_needed', 'confirm_needed'].includes(e.code)) return null;
      throw e;
    }
  };
  dialog(`Copy week ${week}`, h('div', { class: 'stack' }, h('p', { class: 'muted', style: 'margin:0' }, `Copies week ${week}'s ${plural(p.workouts.filter((w) => w.week === week).length, 'workout')} and their exercises. The program grows if you copy past week ${p.weeks}.`),
    h('div', { class: 'form-grid' }, field('To week', to), field('Through week', through, 'The same as To week copies it once.'))), [
    { label: 'Copy week', variant: 'primary', onClick: async () => {
      if (Number(through.value) < Number(to.value)) through.value = to.value;
      const r = await send();
      if (!r) return false;
      toast(Number(through.value) > Number(to.value) ? `Week ${week} copied to weeks ${to.value} to ${through.value}.` : `Week ${week} copied to week ${to.value}.`); reload(Number(to.value));
    } },
    { label: 'Cancel', variant: 'ghost' }]);
  to.addEventListener('input', () => { if (Number(through.value) < Number(to.value)) through.value = to.value; });
}

function workoutCard(p, w, exs, edit, reload) {
  const rows = w.exercises.map((x) => h('div', { class: 'row pg-ex' },
    playBtn(x),
    edit ? h('button', { type: 'button', class: 'grow pg-ex-body', 'aria-label': `${x.name}, ${x.prescription}: change, swap or remove`, onClick: () => slotDialog(x, { p, exs, reload }) },
      h('span', { class: 'stack-tight grow' }, h('span', null, x.name), h('span', { class: 'small muted' }, [x.prescription, loadText(x)].filter(Boolean).join(' · '))),
      h('span', { class: 'small muted', 'aria-hidden': 'true' }, 'Edit'))
      : h('div', { class: 'grow stack-tight pg-ex-body' }, h('span', null, x.name), h('span', { class: 'small muted' }, [x.prescription, loadText(x)].filter(Boolean).join(' · '))),
  ));
  return h('div', { class: 'workout' },
    h('div', { class: 'row' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'small muted' }, `Day ${w.day}${w.logs ? ` · logged ${plural(w.logs, 'time')}` : ''}`),
      edit ? h('button', { type: 'button', class: 'pg-title strong', 'aria-label': `Rename ${w.title}`, onClick: () => renameDialog(w, reload) }, w.title) : h('span', { class: 'strong' }, w.title))),
    rows.length ? rows : h('p', { class: 'small muted' }, 'No exercises yet.'),
    edit ? h('div', { class: 'row wrap pg-foot' },
      btn('Add exercise', () => pickExercise({ title: `Add to ${w.title}`, exs, program: p, workout: w, onAdd: () => reload() }), 'secondary'),
      h('span', { class: 'grow' }),
      btn('Copy', () => copyWorkoutDialog(p, w, reload), 'ghost', { 'aria-label': `Copy ${w.title}` }),
      btn('Delete', (e) => { if (confirm(`Delete ${w.title}?${w.logs ? ` Athletes logged it ${plural(w.logs, 'time')}; those logs stay in the athletes' history.` : ''}`)) busy(e.currentTarget, async () => { await del(`/v1/workouts/${w.id}`, { confirm: true }); toast('Workout deleted.'); reload(); }); }, 'ghost', { 'aria-label': `Delete ${w.title}` })) : null);
}
function renameDialog(w, reload) {
  const title = input({ value: w.title });
  dialog('Rename workout', field('Workout title', title), [
    { label: 'Save', variant: 'primary', onClick: async () => { await patch(`/v1/workouts/${w.id}`, { title: title.value }); reload(); } }, { label: 'Cancel', variant: 'ghost' }]);
  title.select();
}
function copyWorkoutDialog(p, w, reload) {
  const wk = select(Array.from({ length: p.weeks }, (_, i) => [String(i + 1), `Week ${i + 1}`]), { value: String(Math.min(w.week + 1, p.weeks)) });
  const dy = select([['', 'Next free day'], ...[1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), `Day ${d}`])]);
  dialog(`Copy ${w.title}`, h('div', { class: 'form-grid' }, field('To week', wk), field('Day', dy)), [
    { label: 'Copy workout', variant: 'primary', onClick: async () => { const c = await post(`/v1/workouts/${w.id}/copy`, { week: Number(wk.value), day: dy.value ? Number(dy.value) : undefined }); toast(`Copied to week ${c.week}, day ${c.day}.`); reload(c.week); } },
    { label: 'Cancel', variant: 'ghost' }]);
}
// Load inputs: a percent of a tested max, or the coach sets the weight.
function loadFields(x) {
  const lt = select([['', 'Weight: coach sets it'], ['squat_1rm', '% of back squat max'], ['bench_1rm', '% of bench press max'], ['power_clean_1rm', '% of power clean max']], { value: x?.load_test ?? '', 'aria-label': 'Weight from a tested max' });
  const lp = input({ type: 'number', min: '30', max: '110', inputmode: 'numeric', placeholder: '%', 'aria-label': 'Percent of max', value: x?.load_pct ? String(x.load_pct) : '' });
  const sync = () => { lp.disabled = !lt.value; };
  lt.addEventListener('change', sync); sync();
  return { lt, lp, body: () => (lt.value ? { load_test: lt.value, load_pct: Number(lp.value) } : { load_test: null }),
    el: h('div', { class: 'stack-tight' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, lt), h('div', { style: 'width:90px' }, lp)),
      h('span', { class: 'small muted' }, 'A weight from a max updates itself each time the athlete tests again, rounded to 5 lb, and is lighter after a rough check-in.')) };
}
// One exercise in a workout: change its sets and weight, swap it for another exercise in the same slot, or remove it
// (with Undo, which puts it back in the same place).
function slotDialog(x, { p, exs, reload }) {
  const rx = input({ value: x.prescription, 'aria-label': 'Sets and reps' });
  const load = loadFields(x);
  dialog(x.name, h('div', { class: 'stack' }, field('Sets × reps', rx, 'Like 3 × 10, 3 × 8-10, 4 × 5/side or 3 × 40 sec. Athletes log each set.'), load.el), [
    { label: 'Save', variant: 'primary', onClick: async () => { await patch(`/v1/workout-exercises/${x.id}`, { prescription: rx.value, ...load.body() }); toast('Saved.'); reload(); } },
    { label: 'Swap exercise', onClick: (d) => { d.addEventListener('close', () => setTimeout(() => pickExercise({ title: `Swap ${x.name}`, exs, program: p, onPick: async (ex) => { await patch(`/v1/workout-exercises/${x.id}`, { exercise_id: ex.id }); toast(`${x.name} swapped for ${ex.name}. Sets and weight stay.`); reload(); } })), { once: true }); } },
    { label: 'Remove', variant: 'ghost', onClick: async () => {
      const r = await del(`/v1/workout-exercises/${x.id}`);
      reload();
      undoToast(`${x.name} removed.`, () => busy(null, async () => { const { workout_id, ...back } = r.restore; await post(`/v1/workouts/${workout_id}/exercises`, back); toast(`${x.name} is back.`); reload(); }));
    } },
    { label: 'Cancel', variant: 'ghost' }]);
  rx.select();
}

// Find an exercise in the library: search, category, and add a new one on the spot. For adding (workout) it then asks for
// sets and reps (filled in from the last time the exercise was used in this program) and offers Add and add another.
function pickExercise({ title, exs, program, workout, onAdd, onPick }) {
  const cats = exs.categories ?? [];
  const q = input({ type: 'search', placeholder: 'Search the library', 'aria-label': 'Search the library' });
  const cat = select([['', 'Every category'], ...cats.map((c) => [c, c])], { 'aria-label': 'Category' });
  const results = h('div', { class: 'stack pg-pick', style: 'gap:0' });
  const chosen = h('div', { class: 'stack' });
  let picked = null, added = 0;
  const lastRx = (exId) => {
    for (const w of [...program.workouts].reverse()) { const hit = [...w.exercises].reverse().find((x) => x.exercise_id === exId); if (hit) return hit; }
    return null;
  };
  const drawResults = () => {
    const needle = q.value.trim().toLowerCase();
    const shown = exs.data.filter((x) => (!needle || x.name.toLowerCase().includes(needle)) && (!cat.value || x.category === cat.value)).slice(0, 40);
    const exact = exs.data.some((x) => x.name.toLowerCase() === needle);
    fill(results, shown.map((x) => h('button', { type: 'button', class: 'pg-pick-item', 'aria-pressed': String(picked?.id === x.id), onClick: () => choose(x) },
      h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, [x.category, x.video_url ? null : 'no video'].filter(Boolean).join(' · ')))),
    needle && !exact ? h('button', { type: 'button', class: 'pg-pick-item pg-pick-new', onClick: () => newInline(q.value.trim()) }, h('span', { class: 'strong' }, `Add “${q.value.trim()}” to the library`), h('span', { class: 'small muted' }, 'Then pick it here')) : null,
    !shown.length && !needle ? h('p', { class: 'small muted' }, 'The library is empty. Type a name to add the first exercise.') : null);
  };
  const newInline = (name) => {
    const f = exerciseFields({ name }, cats);
    fill(chosen, h('div', { class: 'stack pg-inline' }, h('div', { class: 'strong' }, 'New exercise'), f.el,
      h('div', { class: 'row' }, btn('Add to the library', (e) => busy(e.currentTarget, async () => {
        const ex = await post('/v1/exercises', { ...f.body(), video_url: f.url.value || undefined });
        exs.data.push({ ...ex, uses: 0, programs: [] }); exs.data.sort((a, b) => a.name.localeCompare(b.name));
        toast(`${ex.name} added to the library.`); q.value = ex.name; drawResults(); choose(ex);
      }), 'secondary'), btn('Cancel', () => fill(chosen), 'ghost'))));
    f.name.focus();
  };
  let rx, load;
  const choose = (x) => {
    picked = x; drawResults();
    if (onPick) return;
    const prev = lastRx(x.id);
    rx = input({ value: prev?.prescription ?? '', placeholder: 'Sets × reps, e.g. 3 × 10', 'aria-label': 'Sets and reps' });
    load = loadFields(prev);
    fill(chosen, h('div', { class: 'stack pg-inline' }, h('div', { class: 'strong' }, x.name),
      field('Sets × reps', rx, prev ? `Filled in from week ${program.workouts.find((w) => w.exercises.includes(prev)).week}.` : 'Like 3 × 10, 3 × 8-10, 4 × 5/side or 3 × 40 sec.'), load.el));
    rx.focus();
  };
  const add = async (again) => {
    if (!picked) throw new Error('Choose an exercise from the list first.');
    await post(`/v1/workouts/${workout.id}/exercises`, { exercise_id: picked.id, prescription: rx.value, ...(load.body().load_test ? load.body() : {}) });
    added++;
    toast(`${picked.name} added to ${workout.title}.`);
    workout.exercises.push({ exercise_id: picked.id, prescription: rx.value, name: picked.name });
    if (!again) return;                  // closing the dialog reloads the builder
    picked = null; q.value = ''; fill(chosen); drawResults(); q.focus();
    return false;
  };
  const actions = onPick
    ? [{ label: 'Swap', variant: 'primary', onClick: async () => { if (!picked) throw new Error('Choose an exercise from the list first.'); await onPick(picked); } }, { label: 'Cancel', variant: 'ghost' }]
    : [{ label: 'Add exercise', variant: 'primary', onClick: () => add(false) }, { label: 'Add and add another', onClick: () => add(true) }, { label: 'Done', variant: 'ghost' }];
  q.addEventListener('input', drawResults);
  cat.addEventListener('change', drawResults);
  const d = dialog(title, h('div', { class: 'stack' }, h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: 'min-width:200px' }, q), h('div', { style: 'width:180px' }, cat)), results, chosen), actions);
  if (!onPick) d.addEventListener('close', () => { if (added) onAdd(); }, { once: true });
  drawResults();
  q.focus();
}
