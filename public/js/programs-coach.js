// Coach side of Programs: the Programs page (what athletes logged, who needs a check-in), the exercise library (shown in
// Settings) and the
// program builder (one week at a time). Owners and coaches build and assign; front desk sees everything read-only and
// can email an athlete their workout app link. The server enforces the same rules.
import { h, fill, toast, copyText, busy, btn, field, input, select, panel, ago, money, videoEmbed, playIcon } from './ui.js';
import { saleForm } from './shop-admin.js';
import { importView } from './program-import.js';
import { setFields, detailsOf, groupTag, withGroups } from './set-fields.js';
import { scheduleFields, fmtDay, statusBadge } from './training-days.js';

let deps = null;     // { api, render, header, role, pulseTile }
export function initPrograms(d) { deps = d; }
// Programs → Build from a PDF and Programs → Dictate a workout (program-import.js).
export const viewProgramImport = (main) => importView(main, deps);
export const viewProgramDictate = (main) => importView(main, deps, 'dictate');
const get = (p) => deps.api('GET', p), post = (p, b = {}) => deps.api('POST', p, b), patch = (p, b) => deps.api('PATCH', p, b), put = (p, b) => deps.api('PUT', p, b), del = (p, b) => deps.api('DELETE', p, b);
const canEdit = () => ['owner', 'coach'].includes(deps.role());
const isOwner = () => deps.role() === 'owner';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const first = (name) => name.split(' ')[0];
const LOAD_LIFT = { squat_1rm: 'back squat', bench_1rm: 'bench press', power_clean_1rm: 'power clean' };
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'All levels'];
const loadText = (x) => (x.load_test ? `${x.load_pct}% of ${LOAD_LIFT[x.load_test]} max` : null);
const textarea = (value = '', attrs = {}) => { const t = h('textarea', { class: 'dp-input', ...attrs }); t.value = value ?? ''; return t; };
const bar = (pct, label) => h('div', { class: 'eg-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': label }, h('span', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));

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
const pageState = { q: '', level: '', exQ: '', exCat: '', exFilter: '', exMove: '', exEquip: '', tags: null };

export async function viewPrograms(main) {
  const [progs, exs, act, shop, blocks, tmpl, wtmpl] = await Promise.all([get('/v1/programs'), get('/v1/exercises'), get('/v1/programs/activity'), isOwner() ? get('/v1/shop') : null, get('/v1/routines').catch(() => ({ data: [] })),
    get('/v1/programs?kind=template').catch(() => ({ data: [] })), get('/v1/workout-templates').catch(() => ({ data: [] }))]);
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
  const weekPanel = rosterWeekPanel(act);
  const checkOn = act.quiet.length || act.complete.length ? panel('Athletes to check on', { subtitle: 'No workout in a week, or every workout done and ready for the next block.' },
    act.quiet.map((c) => personRow(c, `${c.program_name} · ${c.last_workout_at ? `last workout ${ago(c.last_workout_at).toLowerCase()}` : `no workouts in ${plural(c.days_idle, 'day')}`}${c.next ? ` · next: week ${c.next.week}, day ${c.next.day}` : ''}`)),
    act.complete.map((c) => personRow(c, `Finished ${c.program_name}. Give ${first(c.name)} the next block.`))) : null;

  const feed = panel('Recent workouts', { subtitle: 'The last 14 days. Effort and notes come from the athletes.' },
    act.recent.length ? act.recent.map(workoutRow) : h('p', { class: 'muted small' }, 'Workouts show up here as athletes log them in the app or on the weight-room screen.'));

  fill(main,
    deps.header('Programs', 'Build training, attach demo videos and assign to clients.', edit ? h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--ghost', href: '#/programs/monthly' }, 'Monthly reports'), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/programs/dictate' }, 'Dictate a workout'), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/programs/import' }, 'Build from a PDF'), btn('New program', () => newProgramDialog(progs.data, tmpl.data))) : null),
    pulse,
    h('div', { class: 'split' },
      h('div', { class: 'stack', style: 'gap:24px' },
        h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: 'min-width:200px' }, search), h('div', { style: 'width:180px' }, levelSel)),
        cards, weekPanel, templatesPanel(tmpl.data, wtmpl.data, progs.data, edit), routinesPanel(blocks.data, exs.data, edit), checkOn, feed, shop ? storePanel(shop) : null),
      panel('Exercise library', { subtitle: `${plural(exs.data.length, 'exercise')}${noVideo ? ` · ${noVideo} without a demo video` : ''}. It lives in Settings.` },
        h('div', null, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/settings' }, 'Open the exercise library')))));
}

// The roster this week (the training calendar): every athlete on a program with planned, done and missed, behind first.
// Behind = two planned workouts missed in a row. A team filter narrows it; the coach opens the athlete's Training tab.
const rosterUi = { team: '', only: '' };
function rosterWeekPanel(act) {
  const w = act.week;
  if (!act.athletes?.length) return panel('This week', { subtitle: 'Planned against done for every athlete on a program, from their training calendar.' }, h('p', { class: 'muted small' }, 'Nobody is on a program yet.'));
  const teams = [...new Map(act.athletes.flatMap((a) => a.teams).map((t) => [t.id, t])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const teamSel = select([['', 'Everyone'], ...teams.map((t) => [t.id, t.name])], { value: rosterUi.team, 'aria-label': 'Team' });
  const onlySel = select([['', 'All athletes'], ['behind', 'Behind (missed 2 in a row)'], ['missed', 'Missed one this week'], ['on_pace', 'On pace']], { value: rosterUi.only, 'aria-label': 'Show' });
  const list = h('div');
  const draw = () => {
    const shown = act.athletes.filter((a) => (!rosterUi.team || a.teams.some((t) => t.id === rosterUi.team))
      && (rosterUi.only !== 'behind' || a.behind) && (rosterUi.only !== 'missed' || a.week.missed > 0) && (rosterUi.only !== 'on_pace' || (a.week.planned > 0 && a.week.missed === 0 && !a.behind)));
    fill(list, shown.length ? shown.map((a) => h('div', { class: 'list-item pg-client', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' },
        h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, h('a', { href: `#/clients/${a.id}?tab=training`, class: 'strong', style: 'color:inherit' }, a.name),
          a.behind ? h('span', { class: 'dp-badge dp-badge--warn' }, `Behind · missed ${a.missed_streak} in a row`) : a.week.missed ? h('span', { class: 'dp-badge dp-badge--neutral' }, `Missed ${a.week.missed} this week`) : a.week.planned && a.week.done >= a.week.planned ? h('span', { class: 'dp-badge dp-badge--good' }, 'Week done') : a.complete ? h('span', { class: 'dp-badge dp-badge--good' }, 'Program finished') : null,
          a.app_open ? null : h('span', { class: 'dp-badge dp-badge--muted' }, 'App locked')),
        h('span', { class: 'small muted' }, [a.program_name, a.teams.length ? a.teams.map((t) => t.name).join(', ') : null, a.next ? `next: ${a.next.title} (${a.next.status === 'today' ? 'today' : a.next.status === 'missed' ? `missed ${fmtDay(a.next.date)}` : fmtDay(a.next.date)})` : null].filter(Boolean).join(' · '))),
      h('div', { class: 'row', style: 'gap:8px;align-items:center;min-width:200px' },
        h('div', { class: 'grow' }, bar(a.week.planned ? (a.week.done / a.week.planned) * 100 : 0, `${a.name}: ${a.week.done} of ${a.week.planned} this week`)),
        h('span', { class: 'small', style: 'white-space:nowrap;min-width:110px;text-align:right' }, a.week.planned ? `${a.week.done} of ${a.week.planned} done${a.week.missed ? ` · ${a.week.missed} missed` : ''}` : 'Nothing planned'))))
      : h('p', { class: 'muted small' }, 'Nobody matches.'));
  };
  teamSel.addEventListener('change', () => { rosterUi.team = teamSel.value; draw(); });
  onlySel.addEventListener('change', () => { rosterUi.only = onlySel.value; draw(); });
  draw();
  return panel('This week', { subtitle: `${fmtDay(w.start, { month: 'short', day: 'numeric' })} to ${fmtDay(w.end, { month: 'short', day: 'numeric' })} · ${w.done} of ${w.planned} planned workouts done · ${w.missed} missed · ${w.behind} ${w.behind === 1 ? 'athlete' : 'athletes'} behind (two missed in a row). From each athlete's training calendar.` },
    h('div', { class: 'row wrap' }, h('div', { style: 'min-width:200px' }, teamSel), h('div', { style: 'min-width:200px' }, onlySel)), list);
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

function newProgramDialog(list, templates = [], startFrom = '') {
  const name = input({ required: true }), weeks = input({ type: 'number', min: '1', max: '52', value: '8', inputmode: 'numeric' });
  const level = select(LEVELS.map((l) => [l, l]));
  const all = [...templates, ...list];
  const from = select([['', 'An empty program'], ...templates.map((p) => [p.id, `Template: ${p.name}`]), ...list.map((p) => [p.id, `A copy of ${p.name}`])], { value: startFrom });
  from.addEventListener('change', () => { const src = all.find((p) => p.id === from.value); if (src) { weeks.value = String(src.weeks); if (src.level && LEVELS.includes(src.level)) level.value = src.level; } });
  if (startFrom) from.dispatchEvent(new Event('change'));
  dialog('New program', h('div', { class: 'stack' }, field('Program name', name), h('div', { class: 'form-grid' }, field('Weeks', weeks), field('Level', level)),
    field('Start from', from, templates.length ? 'A template or a copy brings its workouts and phases in the weeks you keep.' : 'A copy brings the workouts in the weeks you keep.')), [
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
      btn('Copy link', () => copyText(link, 'Link copied. Put it on your website and Instagram.'), 'ghost'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: '/shop', target: '_blank', rel: 'noopener' }, 'View')));
}

// ---------- Exercise library (the first tab of Settings) ----------
export async function exerciseLibrary() { return libraryPanel(await get('/v1/exercises'), canEdit()); }
function libraryPanel(exs, edit) {
  const cats = exs.categories ?? [];
  const q = input({ type: 'search', placeholder: 'Search exercises', 'aria-label': 'Search exercises', value: pageState.exQ });
  const cat = select([['', 'Every category'], ...cats.map((c) => [c, c])], { value: pageState.exCat, 'aria-label': 'Category' });
  const flt = select([['', 'All exercises'], ['no_video', 'Missing a video'], ['unused', 'Not in a program']], { value: pageState.exFilter, 'aria-label': 'Show' });
  const tags = exs.tags ?? { movements: [], muscles: [], equipment: [] };
  const mv = select([['', 'Any movement'], ...tags.movements.map((t) => [t, cap(t)])], { value: pageState.exMove ?? '', 'aria-label': 'Movement' });
  const eq = select([['', 'Any equipment'], ...tags.equipment.map((t) => [t, cap(t)])], { value: pageState.exEquip ?? '', 'aria-label': 'Equipment' });
  const listBox = h('div');
  const count = h('span');
  const PAGE = 60;
  let showing = PAGE;           // a big library shows 60 at a time; search narrows it
  const draw = () => {
    const needle = pageState.exQ.trim().toLowerCase();
    const shown = exs.data.filter((x) => (!needle || x.name.toLowerCase().includes(needle) || (x.instructions ?? '').toLowerCase().includes(needle))
      && (!pageState.exCat || x.category === pageState.exCat) && (pageState.exFilter !== 'no_video' || !x.video_url) && (pageState.exFilter !== 'unused' || !x.uses)
      && (!pageState.exMove || x.movement === pageState.exMove) && (!pageState.exEquip || (x.equipment ?? []).includes(pageState.exEquip)));
    count.textContent = shown.length === exs.data.length ? plural(exs.data.length, 'exercise') : `${shown.length} of ${exs.data.length} exercises`;
    fill(listBox, shown.length ? [...shown.slice(0, showing).map((x) => h('div', { class: 'list-item' },
      playBtn(x),
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.name),
        h('span', { class: 'small muted' }, [x.category ?? 'No category', tagText(x), x.uses ? `in ${plural(x.uses, 'workout')}` : 'not in a program', x.video_url ? null : 'no video yet'].filter(Boolean).join(' · ')),
        x.programs.length ? h('span', { class: 'small muted' }, `Used in ${x.programs.map((p) => p.name).join(', ')}`) : null),
      edit ? btn('Edit', () => exerciseDialog(x, cats, tags), 'ghost', { 'aria-label': `Edit ${x.name}` }) : null)),
      shown.length > showing ? h('div', { class: 'row', style: 'justify-content:center;padding-top:8px' }, btn(`Show ${Math.min(PAGE, shown.length - showing)} more (${(shown.length - showing).toLocaleString()} left)`, () => { showing += PAGE; draw(); }, 'ghost')) : null]
      : h('p', { class: 'small muted' }, exs.data.length ? 'No exercises match. Clear the search or filters.' : 'No exercises yet.'));
  };
  q.addEventListener('input', () => { pageState.exQ = q.value; showing = PAGE; draw(); });
  cat.addEventListener('change', () => { pageState.exCat = cat.value; showing = PAGE; draw(); });
  flt.addEventListener('change', () => { pageState.exFilter = flt.value; showing = PAGE; draw(); });
  mv.addEventListener('change', () => { pageState.exMove = mv.value; showing = PAGE; draw(); });
  eq.addEventListener('change', () => { pageState.exEquip = eq.value; showing = PAGE; draw(); });
  draw();
  return panel('Exercise library', { subtitle: count, action: edit ? h('div', { class: 'row wrap' }, isOwner() ? btn('Import a list', () => importListDialog(), 'ghost') : null, btn('Add exercise', () => exerciseDialog(null, cats, tags), 'secondary')) : null },
    h('div', { class: 'stack', style: 'gap:8px' }, q, h('div', { class: 'form-grid cols-4', style: 'gap:8px' }, cat, mv, eq, flt)), listBox);
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
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const tagText = (x) => [x.movement ? cap(x.movement) : null, ...(x.muscles ?? []), ...(x.equipment ?? [])].filter(Boolean).join(', ') || null;
// A row of toggles for a list of tags. value() answers the picked ones in the list's order.
function chipPicker(options, initial = [], label = 'Tags') {
  const picked = new Set(initial);
  const el = h('div', { class: 'td-days', role: 'group', 'aria-label': label });
  const value = () => options.filter((o) => picked.has(o));
  const draw = () => fill(el, options.map((o) => h('button', { type: 'button', class: 'td-day', 'aria-pressed': String(picked.has(o)), onClick: () => { if (picked.has(o)) picked.delete(o); else picked.add(o); draw(); } }, cap(o))));
  draw();
  return { el, value };
}
function exerciseFields(x, cats, tags = null) {
  const name = input({ value: x?.name ?? '', required: true }), url = input({ type: 'url', value: x?.video_url ?? '', placeholder: 'https://youtube.com/watch?v=…' });
  const cat = select([['', 'No category'], ...cats.map((c) => [c, c])], { value: x?.category ?? '' });
  const cue = textarea(x?.instructions ?? '', { placeholder: 'One or two coaching cues' });
  const t = tags ?? pageState.tags ?? { movements: [], muscles: [], equipment: [] };
  const mv = select([['', 'No movement pattern'], ...t.movements.map((m) => [m, cap(m)])], { value: x?.movement ?? '' });
  const mus = chipPicker(t.muscles, x?.muscles ?? [], 'Muscles'), eqp = chipPicker(t.equipment, x?.equipment ?? [], 'Equipment');
  return { name, url, cat, cue, body: () => ({ name: name.value, video_url: url.value || null, instructions: cue.value || null, category: cat.value || null, movement: mv.value || null, muscles: mus.value(), equipment: eqp.value() }),
    el: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('Name', name), field('Category', cat)), field('Demo video link', url, 'YouTube, Vimeo or a direct .mp4 link.'), field('Coaching cues', cue),
      t.movements.length ? h('div', { class: 'stack-tight' }, field('Movement pattern', mv), h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Muscles'), mus.el), h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Equipment'), eqp.el), h('span', { class: 'small muted' }, 'Tags help find the exercise in the library and the builder.')) : null) };
}
// The swaps an athlete may pick on their own for this exercise ("Can't do this today?" in the app).
function alternativesBlock(x) {
  const listBox = h('div', { class: 'stack-tight' });
  const listId = `dp-alt-list-${x.id}`;
  const pick = input({ list: listId, placeholder: 'Type an exercise from the library', 'aria-label': `A swap for ${x.name}`, autocomplete: 'off' });
  const tag = select([], { 'aria-label': 'When' });
  const note = input({ maxlength: '200', placeholder: 'Note (optional)', 'aria-label': 'Note' });
  const datalist = h('datalist', { id: listId });
  let library = null, tags = {};
  const draw = async () => {
    const r = await get(`/v1/exercises/${x.id}/alternatives`);
    tags = r.tags;
    if (!tag.options.length) fill(tag, Object.entries(tags).map(([k, label]) => h('option', { value: k }, label)));
    fill(listBox, r.data.length ? r.data.map((a) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, h('span', { class: 'strong' }, a.name), ` · ${a.tag_label}${a.note ? ` · ${a.note}` : ''}`),
      btn('Remove', (e) => busy(e.currentTarget, async () => { await del(`/v1/exercise-alternatives/${a.id}`); draw(); }), 'ghost', { 'aria-label': `Remove ${a.name}` }))) : h('p', { class: 'small muted', style: 'margin:0' }, 'None yet. Athletes can only do what\'s written until you list a swap.'));
  };
  draw().catch((e) => fill(listBox, h('p', { class: 'small warn-text' }, e.message)));
  get('/v1/exercises').then((r) => { library = r.data; fill(datalist, library.filter((e) => e.id !== x.id).map((e) => h('option', { value: e.name }))); }).catch(() => {});
  const add = h('form', { class: 'row wrap', style: 'gap:6px;align-items:center', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const name = pick.value.trim().toLowerCase();
    const to = (library ?? []).find((e) => e.name.toLowerCase() === name);
    if (!to) throw new Error('Pick an exercise from the list (type a few letters of its name).');
    await post(`/v1/exercises/${x.id}/alternatives`, { exercise_id: to.id, tag: tag.value, note: note.value.trim() });
    pick.value = ''; note.value = ''; toast(`${to.name} listed as a swap for ${x.name}.`); draw();
  }); } }, datalist, h('div', { class: 'grow', style: 'min-width:180px' }, pick), tag, h('div', { class: 'grow', style: 'min-width:140px' }, note), btn('Add swap', null, 'secondary', { type: 'submit' }));
  return h('div', { class: 'stack-tight', style: 'border-top:1px solid var(--line);padding-top:12px' }, h('div', { class: 'dp-label' }, 'Swaps athletes may pick'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'In the app, "Can\'t do this today?" offers these for this exercise. The pick is for that workout only and you see it on the session\'s Live panel.'), listBox, add);
}
function exerciseDialog(x, cats, tags = null) {
  const f = exerciseFields(x, cats, tags);
  if (x) f.el.append(alternativesBlock(x));
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
  let mode = qs.get('view') === 'plan' ? 'plan' : 'week';     // one week at a time, or the whole plan (the planner)
  const go = (n) => { history.replaceState(null, '', `#/programs/${id}?week=${n}${mode === 'plan' ? '&view=plan' : ''}`); };
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
  // The planner: weeks down, days across, phases as bands, each week's volume and intensity.
  const planBox = h('section', { class: 'stack', 'aria-label': 'Whole plan' });
  const modeBar = h('div', { class: 'row wrap', role: 'group', 'aria-label': 'How to see the program' });
  const drawMode = () => fill(modeBar, [['week', 'Week by week'], ['plan', 'Whole plan']].map(([m, label]) => btn(label, () => { if (mode === m) return; mode = m; go(week); draw(); }, mode === m ? 'secondary' : 'ghost', { 'aria-pressed': String(mode === m) })));
  const drawPlan = async () => {
    fill(planBox, h('p', { class: 'muted small' }, 'Loading the plan…'));
    const plan = await get(`/v1/programs/${id}/plan`);
    fill(planBox, planPanel(p, plan, edit, { openWeek: (n) => { mode = 'week'; week = n; go(n); draw(); }, reload }));
  };
  const draw = () => {
    drawMode();
    tabsBox.hidden = weekBox.hidden = mode === 'plan';
    planBox.hidden = mode !== 'plan';
    if (mode === 'plan') drawPlan().catch((e) => fill(planBox, h('div', { class: 'dp-error', role: 'alert' }, e.message)));
    else { drawTabs(); drawWeek(); }
  };

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

  const isTemplate = p.kind === 'template';
  const header = deps.header(isTemplate ? `${p.name} (template)` : p.name, isTemplate ? `Template · ${plural(p.weeks, 'week')} · ${p.level ?? 'Any level'} · nobody is assigned to a template: start a program from it` : `${plural(p.weeks, 'week')} · ${p.level ?? 'Any level'} · ${plural(p.clients.length, 'client')} · ${plural(p.logged_7d, 'workout')} logged in the last 7 days`,
    edit ? isTemplate ? btn('Start a program from it', () => get('/v1/programs?kind=template').then((t) => newProgramDialog([], t.data, p.id))) : btn('Assign to a client', () => assignDialog(p)) : null);
  fill(main, header,
    p.description ? h('p', { class: 'muted', style: 'margin-top:-12px' }, p.description) : null,
    edit ? h('div', { class: 'row wrap' }, btn('Edit details', () => detailsDialog(p), 'ghost'), btn('Duplicate program', () => duplicateDialog(p), 'ghost'),
      btn(isTemplate ? 'Copy as a new template' : 'Save as template', () => saveTemplateDialog(p), 'ghost'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: `/program.html?id=${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener' }, 'Print or PDF'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: `/v1/programs/${encodeURIComponent(id)}/export.xlsx` }, 'Excel')) : null,
    isTemplate ? null : clientsPanel(p, edit),
    modeBar, tabsBox, weekBox, planBox,
    shop && !isTemplate ? panel('Sell online', { subtitle: 'Out-of-town athletes and families buy it from the store page.' }, saleForm(put, 'program', shop.programs.find((x) => x.id === id), () => deps.render())) : null,
    h('div', { class: 'row' }, h('a', { class: 'dp-btn dp-btn--ghost', href: '#/programs' }, 'All programs'), h('span', { class: 'grow' }),
      edit ? btn('Delete program', (e) => { const logged = p.workouts.reduce((n, w) => n + w.logs, 0); if (confirm(`Delete ${p.name}?${logged ? ` Athletes logged its workouts ${plural(logged, 'time')}; those logs stay in the athletes' history.` : ''} This can't be undone.`)) busy(e.currentTarget, async () => { await del(`/v1/programs/${id}`); toast('Program deleted.'); location.hash = '#/programs'; }); }, 'ghost') : null));
  go(week);
  draw();
}

// ---- The planner ----
const PHASE_KINDS = { base: 'Base', build: 'Build', peak: 'Peak', deload: 'Deload', test: 'Testing', other: 'Other' };
const weekRange = (a, b) => (a === b ? `week ${a}` : `weeks ${a} to ${b}`);
const weekSel = (p, value, attrs = {}) => select(Array.from({ length: p.weeks }, (_, i) => [String(i + 1), `Week ${i + 1}`]), { value: String(value), ...attrs });
function planPanel(p, plan, edit, { openWeek, reload }) {
  const days = Array.from({ length: plan.days }, (_, i) => i + 1);
  const grid = h('div', { class: 'pl-grid', role: 'group', 'aria-label': 'The whole plan: weeks down, days across', style: `grid-template-columns:130px 60px repeat(${plan.days}, minmax(120px, 1fr)) 170px` });
  const at = (col, row, el) => { el.style.gridColumn = String(col); el.style.gridRow = String(row); return el; };
  const volCol = plan.days + 3;
  [['Phase'], ['Week'], ...days.map((d) => [`Day ${d}`]), ['Volume · intensity']].forEach(([t], i) => grid.append(at(i + 1, 1, h('div', { class: 'pl-head' }, t))));
  // Phase bands span their weeks; the first week of each gap offers Add phase.
  for (const f of plan.phases) {
    const band = h(edit ? 'button' : 'div', { class: `pl-phase pl-phase--${f.kind}`, ...(edit ? { type: 'button', onClick: () => phaseDialog(p, plan, f, reload) } : {}), 'aria-label': `${f.name}, ${weekRange(f.start_week, f.end_week)}${edit ? ': change or remove' : ''}` },
      h('span', { class: 'strong small' }, f.name), h('span', { class: 'small muted' }, `${PHASE_KINDS[f.kind]} · ${weekRange(f.start_week, f.end_week)}`), f.note ? h('span', { class: 'small pg-note' }, f.note) : null);
    band.style.gridColumn = '1'; band.style.gridRow = `${f.start_week + 1} / ${f.end_week + 2}`;
    grid.append(band);
  }
  let gapStart = null;
  for (const w of plan.weeks) {
    const row = w.week + 1;
    if (!w.phase_id && gapStart === null) gapStart = w.week;
    if (!w.phase_id && (plan.weeks[w.week]?.phase_id || w.week === p.weeks)) {
      const cell = at(1, gapStart + 1, h('div', { class: 'pl-gap' }, edit ? btn('Add phase', () => phaseDialog(p, plan, { start_week: gapStart, end_week: w.week }, reload), 'ghost', { 'aria-label': `Add a phase for ${weekRange(gapStart, w.week)}` }) : h('span', { class: 'small muted' }, 'No phase')));
      cell.style.gridRow = `${gapStart + 1} / ${w.week + 2}`;
      grid.append(cell); gapStart = null;
    }
    grid.append(at(2, row, h('button', { type: 'button', class: 'pl-week', onClick: () => openWeek(w.week), 'aria-label': `Open week ${w.week}` }, String(w.week))));
    for (const d of days) {
      const wo = w.workouts.find((x) => x.day === d);
      grid.append(at(d + 2, row, wo
        ? h('button', { type: 'button', class: 'pl-cell', onClick: () => openWeek(w.week), 'aria-label': `${wo.title}, week ${w.week} day ${d}: open` },
          h('span', { class: 'strong small' }, wo.title),
          h('span', { class: 'small muted' }, [`${wo.exercises} ex · ${wo.sets} sets`, wo.groups ? `${wo.groups} ${wo.groups === 1 ? 'group' : 'groups'}` : null, wo.avg_pct ? `${wo.avg_pct}%` : null, wo.avg_rpe ? `RPE ${wo.avg_rpe}` : null].filter(Boolean).join(' · ')),
          wo.logs ? h('span', { class: 'small', style: 'color:var(--green-bright)' }, `logged ${plural(wo.logs, 'time')}`) : null)
        : h('div', { class: 'pl-empty', 'aria-hidden': 'true' })));
    }
    grid.append(at(volCol, row, h('div', { class: 'pl-vol' },
      bar(w.sets / plan.max_sets * 100, `Week ${w.week}: ${plural(w.sets, 'set')}`),
      h('span', { class: 'small muted' }, [plural(w.sets, 'set'), w.avg_pct ? `${w.avg_pct}% of max` : null, w.avg_rpe ? `RPE ${w.avg_rpe}` : null].filter(Boolean).join(' · ') || 'Nothing planned'))));
  }
  return panel('Whole plan', { subtitle: 'Weeks down, days across. Phases are bands on the left; the bar is each week\'s sets, with its average percent of a tested max and target RPE. Press a week or a workout to open it.',
    action: edit ? h('div', { class: 'row wrap' }, btn('Progress weeks', () => progressDialog(p, plan, reload), 'secondary'), btn('Bulk edit', () => bulkEditDialog(p, reload), 'secondary'), btn('Add phase', () => phaseDialog(p, plan, null, reload), 'ghost')) : null },
    h('div', { class: 'pl-wrap' }, grid));
}
// Add or change a phase: a label across a run of weeks. Phases don't overlap; the server checks too.
function phaseDialog(p, plan, f, reload) {
  const kind = select(Object.entries(PHASE_KINDS), { value: f?.kind ?? 'base' });
  const name = input({ value: f?.name ?? '', maxlength: '60', placeholder: 'Same as the kind' });
  const from = weekSel(p, f?.start_week ?? 1), to = weekSel(p, f?.end_week ?? f?.start_week ?? Math.min(p.weeks, 4));
  const note = input({ value: f?.note ?? '', maxlength: '500', placeholder: 'What this phase is for' });
  const body = () => ({ kind: kind.value, name: name.value.trim() || null, start_week: Number(from.value), end_week: Number(to.value), note: note.value.trim() || null });
  const actions = [
    { label: f?.id ? 'Save' : 'Add phase', variant: 'primary', onClick: async () => { if (Number(to.value) < Number(from.value)) to.value = from.value; if (f?.id) await patch(`/v1/phases/${f.id}`, body()); else await post(`/v1/programs/${p.id}/phases`, body()); toast(f?.id ? 'Phase saved.' : 'Phase added.'); reload(); } }];
  if (f?.id) actions.push({ label: 'Remove', variant: 'ghost', onClick: async () => { await del(`/v1/phases/${f.id}`); toast(`${f.name} removed. The workouts stay.`); reload(); } });
  actions.push({ label: 'Cancel', variant: 'ghost' });
  dialog(f?.id ? f.name : 'Add a phase', h('div', { class: 'stack' },
    h('div', { class: 'form-grid' }, field('Kind', kind), field('Name', name, 'Optional, like "Strength block 1".'), field('First week', from), field('Last week', to)),
    field('Note', note),
    h('p', { class: 'small muted', style: 'margin:0' }, 'A phase is a label for you and other coaches. It never changes the workouts.')), actions);
  from.addEventListener('change', () => { if (Number(to.value) < Number(from.value)) to.value = from.value; });
}
// Progression: copy one week across a run of weeks, changing sets, percent of max or RPE by a step each week.
// Change one exercise across a run of weeks in one go ("every back squat in weeks 3 to 6, plus 5 percent").
function bulkEditDialog(p, reload) {
  const inProgram = [...new Map(p.workouts.flatMap((w) => w.exercises).map((x) => [x.exercise_id, x.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (!inProgram.length) return toast('Add exercises to the program first.', 'warn');
  const ex = select(inProgram.map(([id, name]) => [id, name]), { 'aria-label': 'Exercise' });
  const from = input({ type: 'number', min: '1', max: String(p.weeks), value: '1', inputmode: 'numeric' }), to = input({ type: 'number', min: '1', max: String(p.weeks), value: String(p.weeks), inputmode: 'numeric' });
  const sets = select([-2, -1, 0, 1, 2].map((n) => [String(n), n ? `${n > 0 ? '+' : ''}${n} ${Math.abs(n) === 1 ? 'set' : 'sets'}` : 'Sets: no change']), { value: '0' });
  const pct = select([-10, -5, -3, 0, 3, 5, 10].map((n) => [String(n), n ? `${n > 0 ? '+' : ''}${n}% of max` : 'Percent of max: no change']), { value: '0' });
  const rpe = select([-1, -0.5, 0, 0.5, 1].map((n) => [String(n), n ? `${n > 0 ? '+' : ''}${n} RPE` : 'RPE: no change']), { value: '0' });
  const rest = select([-60, -30, -15, 0, 15, 30, 60].map((n) => [String(n), n ? `${n > 0 ? '+' : ''}${n} s rest` : 'Rest: no change']), { value: '0' });
  const reps = input({ placeholder: 'Leave empty to keep', maxlength: '80' }), tempo = input({ placeholder: 'Leave empty to keep', maxlength: '20' });
  const preview = h('p', { class: 'small muted', style: 'margin:0' });
  const say = () => {
    const f = Number(from.value), t = Number(to.value);
    const n = p.workouts.filter((w) => w.week >= f && w.week <= t).reduce((c, w) => c + w.exercises.filter((x) => x.exercise_id === ex.value).length, 0);
    preview.textContent = `${ex.selectedOptions[0]?.textContent ?? 'It'} appears ${plural(n, 'time')} in weeks ${f}${t !== f ? ` to ${t}` : ''}. Exercises without a field are left as they are; the plan's numbers stay within the builder's limits.`;
  };
  for (const el of [ex, from, to]) el.addEventListener('input', say); say();
  const send = async (extra = {}) => {
    try { return await post(`/v1/programs/${p.id}/bulk-edit`, { exercise_id: ex.value, from_week: Number(from.value), to_week: Number(to.value), sets_step: Number(sets.value), pct_step: Number(pct.value), rpe_step: Number(rpe.value), rest_step: Number(rest.value), ...(reps.value.trim() ? { reps: reps.value.trim() } : {}), ...(tempo.value.trim() ? { tempo: tempo.value.trim() } : {}), ...extra }); }
    catch (e) {
      if (e.code === 'confirm_needed' && confirm(e.message.replace(' Send confirm: true to go ahead.', ' Change them anyway?'))) return send({ ...extra, confirm: true });
      if (e.code === 'confirm_needed') return null;
      throw e;
    }
  };
  dialog('Bulk edit', h('div', { class: 'stack' },
    h('p', { class: 'muted', style: 'margin:0' }, 'Change one exercise everywhere it appears in a run of weeks, in place. Steps move the numbers from where each one is; reps and tempo replace the text.'),
    field('Exercise', ex), h('div', { class: 'form-grid' }, field('From week', from), field('To week', to)),
    h('div', { class: 'form-grid' }, field('Sets', sets), field('Percent of max', pct), field('RPE', rpe), field('Rest', rest)),
    h('div', { class: 'form-grid' }, field('Reps', reps, 'Replaces the reps text, like 8-10 or 5/side.'), field('Tempo', tempo)), preview), [
    { label: 'Apply', variant: 'primary', onClick: async () => { const r = await send(); if (!r) return false; toast(`${plural(r.changed, 'exercise')} changed across weeks ${r.from_week}${r.to_week !== r.from_week ? ` to ${r.to_week}` : ''}.`); reload(); } },
    { label: 'Cancel', variant: 'ghost' }]);
}
function progressDialog(p, plan, reload) {
  const withWork = plan.weeks.filter((w) => w.workouts.length).map((w) => w.week);
  if (!withWork.length) return toast('Build one week first, then progress it across the others.', 'warn');
  const from = select(withWork.map((n) => [String(n), `Week ${n}`]), { value: String(withWork[0]) });
  const to = input({ type: 'number', min: '1', max: '52', value: String(Math.min(withWork[0] + 1, 52)), inputmode: 'numeric' });
  const through = input({ type: 'number', min: '1', max: '52', value: String(Math.min(Math.max(withWork[0] + 3, p.weeks), 52)), inputmode: 'numeric' });
  const sets = select([-2, -1, 0, 1, 2].map((n) => [String(n), n ? `${n > 0 ? '+' : ''}${n} ${Math.abs(n) === 1 ? 'set' : 'sets'} a week` : 'Sets: no change']), { value: '0' });
  const pct = select([-10, -5, -3, 0, 3, 5, 10].map((n) => [String(n), n ? `${n > 0 ? '+' : ''}${n}% of max a week` : 'Percent of max: no change']), { value: '5' });
  const rpe = select([-1, -0.5, 0, 0.5, 1].map((n) => [String(n), n ? `${n > 0 ? '+' : ''}${n} RPE a week` : 'RPE: no change']), { value: '0' });
  const preview = h('p', { class: 'small muted', style: 'margin:0' });
  const say = () => {
    const f = Number(from.value), t = Number(to.value), th = Math.max(Number(through.value), t);
    const parts = [Number(sets.value) ? `${Number(sets.value) > 0 ? '+' : ''}${Number(sets.value) * (th - f)} sets` : null, Number(pct.value) ? `${Number(pct.value) > 0 ? '+' : ''}${Number(pct.value) * (th - f)}% of max` : null, Number(rpe.value) ? `${Number(rpe.value) > 0 ? '+' : ''}${Number(rpe.value) * (th - f)} RPE` : null].filter(Boolean);
    preview.textContent = parts.length ? `Week ${th} ends up at ${parts.join(', ')} over week ${f}; the weeks between step up evenly. Exercises without that field are left as they are.` : 'Choose at least one change a week.';
  };
  for (const el of [from, to, through, sets, pct, rpe]) el.addEventListener('input', say); say();
  // Progression only runs forward: the weeks after the one it builds from.
  const forward = () => { const f = Number(from.value); to.min = String(Math.min(f + 1, 52)); if (Number(to.value) <= f) to.value = String(Math.min(f + 1, 52)); if (Number(through.value) < Number(to.value)) through.value = to.value; say(); };
  from.addEventListener('change', forward); to.addEventListener('change', forward); forward();
  const send = async (extra = {}) => {
    try { return await post(`/v1/programs/${p.id}/progress`, { from: Number(from.value), to: Number(to.value), through: Number(through.value), sets_step: Number(sets.value), pct_step: Number(pct.value), rpe_step: Number(rpe.value), ...extra }); }
    catch (e) {
      if (e.code === 'replace_needed' && confirm(`${e.message.replace(' Replace them to copy.', '')} Replace them with the progression from week ${from.value}?`)) return send({ ...extra, replace: true });
      if (e.code === 'confirm_needed' && confirm(e.message.replace(' Send confirm: true to go ahead.', ' Replace anyway?'))) return send({ ...extra, confirm: true });
      if (['replace_needed', 'confirm_needed'].includes(e.code)) return null;
      throw e;
    }
  };
  dialog('Progress weeks', h('div', { class: 'stack' },
    h('p', { class: 'muted', style: 'margin:0' }, 'Copies one week across a run of weeks, changing the numbers a step each week: the way a block builds up, or drops for a deload.'),
    h('div', { class: 'form-grid' }, field('Build from', from), field('To week', to), field('Through week', through)),
    h('div', { class: 'form-grid' }, field('Sets', sets), field('Percent of max', pct), field('Target RPE', rpe)), preview), [
    { label: 'Progress weeks', variant: 'primary', onClick: async () => {
      if (Number(through.value) < Number(to.value)) through.value = to.value;
      const r = await send();
      if (!r) return false;
      toast(`Weeks ${to.value} to ${through.value} built from week ${from.value}.`); reload();
    } },
    { label: 'Cancel', variant: 'ghost' }]);
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
          h('span', { class: 'small muted' }, c.complete ? 'Finished every workout.' : c.next ? `Next: ${c.next.title} · ${c.next.status === 'today' ? 'today' : c.next.status === 'missed' ? `missed, was ${fmtDay(c.next.date)}` : fmtDay(c.next.date)} (week ${c.next.week}, day ${c.next.day})${c.missed ? ` · ${plural(c.missed, 'workout')} missed` : ''}` : 'No workouts in this program yet.'),
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
  const need = Math.max(1, ...p.workouts.map((w) => w.day));
  const sched = scheduleFields({ need });        // the day week 1 starts and the weekdays they train, the same for everyone assigned here
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
            await post(`/v1/programs/${p.id}/assign`, { client_id: c.id, ...sched.body() });
            document.getElementById('dialog').close();
            toast(`${first(c.name)} is on ${p.name}. Use Send link to email the workout app link.`); deps.render();
          });
        }, 'secondary', { 'aria-label': `Assign ${p.name} to ${c.name}` }));
    }) : h('p', { class: 'small muted' }, 'No clients match.'));
  };
  q.addEventListener('input', draw);
  // A whole team at once: everyone on the roster gets the same start date and training days.
  const teamSel = select([['', 'Choose a team']], { 'aria-label': 'Team' });
  const teamNote = h('span', { class: 'small muted' });
  const teamBox = h('div', { class: 'stack-tight' }, h('span', { class: 'dp-label' }, 'Or a whole team'),
    h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, h('div', { class: 'grow', style: 'min-width:200px' }, teamSel),
      btn('Assign the team', (e) => {
        const t = teams?.find((x) => x.id === teamSel.value);
        if (!t) return toast('Choose a team first.', 'warn');
        if (!confirm(`Put everyone on ${t.label} (${t.roster_count} ${t.roster_count === 1 ? 'athlete' : 'athletes'}) on ${p.name}? Athletes already on another program stay where they are unless you say so next.`)) return;
        busy(e.currentTarget, async () => {
          let r = await post(`/v1/programs/${p.id}/assign-team`, { contract_id: t.id, ...sched.body() });
          const onOther = r.skipped.filter((s) => s.program_name);
          if (onOther.length && confirm(`${onOther.map((s) => `${s.name} (${s.program_name})`).join(', ')} ${onOther.length === 1 ? 'is' : 'are'} on another program. Move ${onOther.length === 1 ? 'them' : 'them all'} onto ${p.name} too? Their logged workouts stay.`)) r = await post(`/v1/programs/${p.id}/assign-team`, { contract_id: t.id, replace: true, ...sched.body() });
          document.getElementById('dialog').close();
          toast(`${plural(r.assigned.length, 'athlete')} from ${r.team.name} ${r.assigned.length === 1 ? 'is' : 'are'} on ${p.name}${r.skipped.length ? ` · ${r.skipped.length} skipped (${r.skipped.map((s) => `${first(s.name)}: ${s.reason}`).join(', ')})` : ''}.`);
          deps.render();
        });
      }, 'secondary')), teamNote);
  let teams = null;
  dialog(`Assign ${p.name}`, h('div', { class: 'stack' }, sched.el, teamBox, h('span', { class: 'dp-label' }, 'One athlete'), q, out), [{ label: 'Close', variant: 'ghost' }]);
  draw();
  get('/v1/clients').then((r) => { clients = r.data; draw(); }).catch((e) => fill(out, h('p', { class: 'dp-error' }, e.message)));
  get('/v1/teams').then((r) => { teams = r.data; if (!teams.length) { teamBox.hidden = true; return; } fill(teamSel, [['', 'Choose a team'], ...teams.map((t) => [t.id, `${t.label} · ${plural(t.roster_count, 'athlete')}`])].map(([value, label]) => h('option', { value }, label))); teamNote.textContent = 'Everyone on the roster (not archived) gets their own calendar with the start date and days above.'; }).catch(() => { teamBox.hidden = true; });
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
  const from = select([['', 'An empty day']], { 'aria-label': 'Start from a template' });
  const fromBox = h('div', { hidden: true }, field('Start from', from, 'A workout template brings its exercises, set details, groups and blocks.'));
  get('/v1/workout-templates').then((t) => { if (!t.data.length) return; fill(from, [['', 'An empty day'], ...t.data.map((x) => [x.id, `${x.name} · ${plural(x.exercises, 'exercise')}`])].map(([value, label]) => h('option', { value }, label))); fromBox.hidden = false; }).catch(() => {});
  from.addEventListener('change', () => { if (from.value && !title.value) title.placeholder = from.selectedOptions[0].textContent.split(' · ')[0]; });
  dialog(`Add a day to week ${week}`, h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('Day', day), field('Workout title', title)), fromBox), [
    { label: 'Add day', variant: 'primary', onClick: async () => { await post(`/v1/programs/${p.id}/workouts`, { week, day: Number(day.value), title: title.value || undefined, template_id: from.value || undefined }); toast(from.value ? 'Day added from the template.' : 'Day added. Add its exercises.'); reload(week); } },
    { label: 'Cancel', variant: 'ghost' }]);
  title.focus();
}
function saveTemplateDialog(p) {
  const name = input({ value: p.kind === 'template' ? `${p.name} (copy)` : p.name, maxlength: '120' });
  dialog('Save as a template', h('div', { class: 'stack' }, h('p', { class: 'muted', style: 'margin:0' }, 'Every week, workout and phase is copied into the template. Templates are never assigned or sold; New program starts from one.'), field('Template name', name)), [
    { label: 'Save template', variant: 'primary', onClick: async () => { const t = await post(`/v1/programs/${p.id}/save-template`, { name: name.value }); toast(`Template saved: ${t.name}.`); location.hash = `#/programs/${t.id}`; } },
    { label: 'Cancel', variant: 'ghost' }]);
  name.focus(); name.select();
}
// The Programs page's templates: program templates (open, start a program, delete) and workout templates (delete).
function templatesPanel(templates, workoutTemplates, programs, edit) {
  if (!templates.length && !workoutTemplates.length) return panel('Templates', { subtitle: 'Save any program with Save as template, or any workout from its card, and start new ones from them here.' }, h('p', { class: 'muted small' }, 'No templates yet.'));
  return panel('Templates', { subtitle: 'Programs and workouts saved to start from. A template is never assigned or sold.' },
    templates.length ? h('div', { class: 'stack-tight' }, h('span', { class: 'small strong' }, 'Program templates'), templates.map((t) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('a', { href: `#/programs/${t.id}`, class: 'strong', style: 'color:inherit' }, t.name), h('span', { class: 'small muted' }, [plural(t.weeks, 'week'), t.level ?? 'Any level', plural(t.workout_count, 'workout')].join(' · '))),
      edit ? btn('Start a program', () => newProgramDialog(programs, templates, t.id), 'secondary', { 'aria-label': `Start a program from ${t.name}` }) : null,
      edit ? btn('Delete', (e) => { if (!confirm(`Delete the template ${t.name}? Programs started from it aren't touched.`)) return; busy(e.currentTarget, async () => { await del(`/v1/programs/${t.id}`); toast('Template deleted.'); deps.render(); }); }, 'ghost', { 'aria-label': `Delete the template ${t.name}` }) : null))) : null,
    workoutTemplates.length ? h('div', { class: 'stack-tight', style: 'margin-top:8px' }, h('span', { class: 'small strong' }, 'Workout templates'), h('span', { class: 'small muted' }, 'In the builder, Add day → Start from.'), workoutTemplates.map((t) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, t.name), h('span', { class: 'small muted' }, [t.exercise_names.join(', ') || 'No exercises', t.warmup ? `warm-up ${t.warmup}` : null, t.cooldown ? `cool-down ${t.cooldown}` : null].filter(Boolean).join(' · '))),
      edit ? btn('Delete', (e) => { if (!confirm(`Delete the workout template ${t.name}?`)) return; busy(e.currentTarget, async () => { await del(`/v1/workout-templates/${t.id}`); toast('Template deleted.'); deps.render(); }); }, 'ghost', { 'aria-label': `Delete the workout template ${t.name}` }) : null))) : null);
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
  const line = (x) => [detailsOf(x), loadText(x)].filter(Boolean).join(' · ');
  const body = (x) => h('span', { class: 'stack-tight grow' }, h('span', null, x.name, x.form_check ? h('span', { class: 'dp-badge dp-badge--neutral', style: 'margin-left:8px', title: x.form_check_note || 'The athlete is asked to send a clip of this one' }, 'Form check') : null),
    h('span', { class: 'small muted' }, line(x)), x.note ? h('span', { class: 'small pg-note' }, x.note) : null);
  const rows = withGroups(w.exercises, (x) => h('div', { class: `row pg-ex${x.group_label ? ' sf-in-group' : ''}` },
    groupTag(x), playBtn(x),
    edit ? h('button', { type: 'button', class: 'grow pg-ex-body', 'aria-label': `${x.name}, ${line(x)}: change, swap or remove`, onClick: () => slotDialog(x, { p, exs, reload }) },
      body(x), h('span', { class: 'small muted', 'aria-hidden': 'true' }, 'Edit'))
      : h('div', { class: 'grow pg-ex-body' }, body(x)),
  ));
  const blocks = h('div', { class: 'row wrap small', style: 'gap:6px;align-items:center' },
    h('span', { class: 'muted' }, `Warm-up: ${w.warmup?.name ?? 'none'} · Cool-down: ${w.cooldown?.name ?? 'none'}`),
    edit ? btn(w.warmup || w.cooldown ? 'Change' : 'Attach blocks', (e) => busy(e.currentTarget, () => blocksDialog(w, reload)), 'ghost', { 'aria-label': `Warm-up and cool-down for ${w.title}` }) : null);
  return h('div', { class: 'workout' },
    h('div', { class: 'row' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'small muted' }, `Day ${w.day}${w.logs ? ` · logged ${plural(w.logs, 'time')}` : ''}`),
      edit ? h('button', { type: 'button', class: 'pg-title strong', 'aria-label': `Rename ${w.title}`, onClick: () => renameDialog(w, reload) }, w.title) : h('span', { class: 'strong' }, w.title))),
    blocks,
    rows.length ? rows : h('p', { class: 'small muted' }, 'No exercises yet.'),
    edit ? h('div', { class: 'row wrap pg-foot' },
      btn('Add exercise', () => pickExercise({ title: `Add to ${w.title}`, exs, program: p, workout: w, onAdd: () => reload() }), 'secondary'),
      h('span', { class: 'grow' }),
      btn('Copy', () => copyWorkoutDialog(p, w, reload), 'ghost', { 'aria-label': `Copy ${w.title}` }),
      btn('Save as template', () => { const name = prompt(`Save ${w.title} as a workout template. Name it:`, w.title); if (name === null) return; post(`/v1/workouts/${w.id}/save-template`, { name: name.trim() || w.title }).then(() => toast('Template saved. Start a day from it with Add day.')).catch((e) => toast(e.message, 'warn')); }, 'ghost', { 'aria-label': `Save ${w.title} as a template` }),
      btn('Delete', (e) => { if (confirm(`Delete ${w.title}?${w.logs ? ` Athletes logged it ${plural(w.logs, 'time')}; those logs stay in the athletes' history.` : ''}`)) busy(e.currentTarget, async () => { await del(`/v1/workouts/${w.id}`, { confirm: true }); toast('Workout deleted.'); reload(); }); }, 'ghost', { 'aria-label': `Delete ${w.title}` })) : null);
}
// Attach a warm-up and a cool-down to a workout, from the blocks written on the Programs page.
async function blocksDialog(w, reload) {
  const all = (await get('/v1/routines')).data;
  const pick = (kind, cur) => select([['', 'None'], ...all.filter((r) => r.kind === kind).map((r) => [r.id, `${r.name} (${plural(r.exercises.length, 'move')})`])], { value: cur ?? '' });
  const warm = pick('warmup', w.warmup?.id), cool = pick('cooldown', w.cooldown?.id);
  dialog(`Warm-up and cool-down for ${w.title}`, h('div', { class: 'stack' },
    all.length ? null : h('p', { class: 'small muted' }, 'No blocks yet. Write one under Warm-ups and cool-downs on the Programs page, then attach it here.'),
    h('div', { class: 'form-grid' }, field('Warm-up', warm), field('Cool-down', cool)),
    h('p', { class: 'small muted', style: 'margin:0' }, 'The block shows with this workout in the app, on the weight-room screen and on the session\'s Live panel. Nothing in it is logged.')), [
    { label: 'Save', variant: 'primary', onClick: async () => { await patch(`/v1/workouts/${w.id}`, { warmup_id: warm.value || null, cooldown_id: cool.value || null }); toast('Saved.'); reload(); } },
    { label: 'Cancel', variant: 'ghost' }]);
}
// Warm-ups and cool-downs, written once. A block is a name and a short list of moves with what to do.
function routinesPanel(list, exs, edit) {
  const row = (r) => h('div', { class: 'list-item' },
    h('div', { class: 'grow stack-tight' }, h('span', null, h('span', { class: 'strong' }, r.name), h('span', { class: 'small muted' }, ` · ${r.kind_label}`)),
      h('span', { class: 'small muted' }, `${r.exercises.map((x) => `${x.name} ${x.prescription}`).join(' · ')}${r.used_in ? ` · on ${plural(r.used_in, 'workout')}` : ' · not on a workout yet'}`)),
    edit ? btn('Edit', () => routineDialog(r, r.kind, exs), 'ghost', { 'aria-label': `Edit ${r.name}` }) : null);
  return panel('Warm-ups and cool-downs', { subtitle: 'Write a block once and attach it to workouts from the builder. It shows with the workout in the app, on the weight-room screen and on the Live panel.',
    action: edit ? h('div', { class: 'row wrap' }, btn('New warm-up', () => routineDialog(null, 'warmup', exs), 'secondary'), btn('New cool-down', () => routineDialog(null, 'cooldown', exs), 'secondary')) : null },
    list.length ? list.map(row) : h('p', { class: 'small muted' }, 'No blocks yet.'));
}
function routineDialog(r, kind, exs) {
  const name = input({ value: r?.name ?? '', placeholder: kind === 'warmup' ? 'Dynamic warm-up' : 'Stretch out', required: true });
  const note = input({ value: r?.note ?? '', maxlength: '500', placeholder: 'A line for the athlete (optional)' });
  const datalist = h('datalist', { id: 'dp-rtn-list' }, exs.map((e) => h('option', { value: e.name })));
  const rowsBox = h('div', { class: 'stack-tight' });
  const rows = (r?.exercises ?? []).map((x) => ({ name: x.name, prescription: x.prescription, note: x.note ?? '' }));
  if (!rows.length) rows.push({ name: '', prescription: '', note: '' });
  const draw = () => fill(rowsBox, rows.map((x, i) => {
    const nm = input({ list: 'dp-rtn-list', value: x.name, placeholder: 'Exercise', 'aria-label': `Move ${i + 1}`, autocomplete: 'off', onInput: (e) => { x.name = e.target.value; } });
    const rx = input({ value: x.prescription, maxlength: '80', placeholder: '2 × 10, 30 sec each side', 'aria-label': `What to do, move ${i + 1}`, onInput: (e) => { x.prescription = e.target.value; } });
    const nt = input({ value: x.note, maxlength: '200', placeholder: 'Cue (optional)', 'aria-label': `Cue, move ${i + 1}`, onInput: (e) => { x.note = e.target.value; } });
    return h('div', { class: 'row wrap', style: 'gap:6px;align-items:center' }, h('span', { class: 'small muted', style: 'width:20px' }, `${i + 1}.`), h('div', { class: 'grow', style: 'min-width:160px' }, nm), h('div', { style: 'flex:0 1 180px' }, rx), h('div', { class: 'grow', style: 'min-width:120px' }, nt),
      rows.length > 1 ? btn('Remove', () => { rows.splice(i, 1); draw(); }, 'ghost', { 'aria-label': `Remove move ${i + 1}` }) : null);
  }), h('div', { class: 'row' }, rows.length < 20 ? btn('Add a move', () => { rows.push({ name: '', prescription: '', note: '' }); draw(); }, 'ghost') : null));
  draw();
  const body = () => ({ name: name.value.trim(), kind, note: note.value.trim() || null, exercises: rows.map((x, i) => {
    const e = exs.find((ex) => ex.name.toLowerCase() === x.name.trim().toLowerCase());
    if (!e) throw new Error(`Move ${i + 1}: pick an exercise from the library (type a few letters of its name).`);
    return { exercise_id: e.id, prescription: x.prescription.trim(), note: x.note.trim() || null };
  }) });
  const actions = [{ label: r ? 'Save block' : `Add ${kind === 'warmup' ? 'warm-up' : 'cool-down'}`, variant: 'primary', onClick: async () => {
    if (r) await patch(`/v1/routines/${r.id}`, body()); else await post('/v1/routines', body());
    toast(r ? 'Block saved. Every workout it\'s on shows the change.' : 'Block added. Attach it to a workout from the builder.'); deps.render();
  } }, { label: 'Cancel', variant: 'ghost' }];
  if (r) actions.push({ label: 'Delete block', variant: 'ghost', onClick: async () => {
    if (!confirm(`Delete ${r.name}?${r.used_in ? ` It comes off ${plural(r.used_in, 'workout')}.` : ''}`)) return false;
    await del(`/v1/routines/${r.id}`, { confirm: true }); toast(`${r.name} deleted.`); deps.render();
  } });
  dialog(r ? `Edit ${r.name}` : kind === 'warmup' ? 'New warm-up' : 'New cool-down', h('div', { class: 'stack' }, datalist, h('div', { class: 'form-grid' }, field('Name', name), field('Note for the athlete', note)),
    h('div', { class: 'dp-label' }, 'Moves, in order'), rowsBox), actions);
  name.focus();
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
  const sf = setFields(x);
  const load = loadFields(x);
  dialog(x.name, h('div', { class: 'stack' }, sf.el, load.el), [
    { label: 'Save', variant: 'primary', onClick: async () => { await patch(`/v1/workout-exercises/${x.id}`, { ...sf.body(), ...load.body() }); toast('Saved.'); reload(); } },
    { label: 'Swap exercise', onClick: (d) => { d.addEventListener('close', () => setTimeout(() => pickExercise({ title: `Swap ${x.name}`, exs, program: p, onPick: async (ex) => { await patch(`/v1/workout-exercises/${x.id}`, { exercise_id: ex.id }); toast(`${x.name} swapped for ${ex.name}. Sets and weight stay.`); reload(); } })), { once: true }); } },
    { label: 'Remove', variant: 'ghost', onClick: async () => {
      const r = await del(`/v1/workout-exercises/${x.id}`);
      reload();
      undoToast(`${x.name} removed.`, () => busy(null, async () => { const { workout_id, ...back } = r.restore; await post(`/v1/workouts/${workout_id}/exercises`, back); toast(`${x.name} is back.`); reload(); }));
    } },
    { label: 'Cancel', variant: 'ghost' }]);
  sf.focus();
}

// Find an exercise in the library: search, category, and add a new one on the spot. For adding (workout) it then asks for
// sets and reps (filled in from the last time the exercise was used in this program) and offers Add and add another.
function pickExercise({ title, exs, program, workout, onAdd, onPick }) {
  const cats = exs.categories ?? [];
  const q = input({ type: 'search', placeholder: 'Search the library', 'aria-label': 'Search the library' });
  const cat = select([['', 'Every category'], ...cats.map((c) => [c, c])], { 'aria-label': 'Category' });
  const tags = exs.tags ?? { movements: [], muscles: [], equipment: [] };
  pageState.tags = tags;
  const mv = select([['', 'Any movement'], ...tags.movements.map((t) => [t, cap(t)])], { 'aria-label': 'Movement' });
  const eq = select([['', 'Any equipment'], ...tags.equipment.map((t) => [t, cap(t)])], { 'aria-label': 'Equipment' });
  const results = h('div', { class: 'stack pg-pick', style: 'gap:0' });
  const chosen = h('div', { class: 'stack' });
  let picked = null, added = 0;
  const lastRx = (exId) => {
    for (const w of [...program.workouts].reverse()) { const hit = [...w.exercises].reverse().find((x) => x.exercise_id === exId); if (hit) return hit; }
    return null;
  };
  const drawResults = () => {
    const needle = q.value.trim().toLowerCase();
    const shown = exs.data.filter((x) => (!needle || x.name.toLowerCase().includes(needle)) && (!cat.value || x.category === cat.value) && (!mv.value || x.movement === mv.value) && (!eq.value || (x.equipment ?? []).includes(eq.value))).slice(0, 40);
    const exact = exs.data.some((x) => x.name.toLowerCase() === needle);
    fill(results, shown.map((x) => h('button', { type: 'button', class: 'pg-pick-item', 'aria-pressed': String(picked?.id === x.id), onClick: () => choose(x) },
      h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, [x.category, tagText(x), x.video_url ? null : 'no video'].filter(Boolean).join(' · ')))),
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
  let sf, load;
  const choose = (x) => {
    picked = x; drawResults();
    if (onPick) return;
    const prev = lastRx(x.id);
    sf = setFields(prev ? { ...prev, group_label: null, group_kind: null } : null);
    load = loadFields(prev);
    const from = prev && program.workouts.find((w) => w.exercises.includes(prev));
    fill(chosen, h('div', { class: 'stack pg-inline' }, h('div', { class: 'strong' }, x.name),
      from ? h('span', { class: 'small muted' }, `Filled in from week ${from.week}.`) : null, sf.el, load.el));
    sf.focus();
  };
  const add = async (again) => {
    if (!picked) throw new Error('Choose an exercise from the list first.');
    await post(`/v1/workouts/${workout.id}/exercises`, { exercise_id: picked.id, ...sf.body(), ...(load.body().load_test ? load.body() : {}) });
    added++;
    toast(`${picked.name} added to ${workout.title}.`);
    workout.exercises.push({ exercise_id: picked.id, name: picked.name, ...sf.body() });
    if (!again) return;                  // closing the dialog reloads the builder
    picked = null; q.value = ''; fill(chosen); drawResults(); q.focus();
    return false;
  };
  const actions = onPick
    ? [{ label: 'Swap', variant: 'primary', onClick: async () => { if (!picked) throw new Error('Choose an exercise from the list first.'); await onPick(picked); } }, { label: 'Cancel', variant: 'ghost' }]
    : [{ label: 'Add exercise', variant: 'primary', onClick: () => add(false) }, { label: 'Add and add another', onClick: () => add(true) }, { label: 'Done', variant: 'ghost' }];
  q.addEventListener('input', drawResults);
  cat.addEventListener('change', drawResults); mv.addEventListener('change', drawResults); eq.addEventListener('change', drawResults);
  const d = dialog(title, h('div', { class: 'stack' }, h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: 'min-width:200px' }, q), h('div', { style: 'width:150px' }, cat), tags.movements.length ? h('div', { style: 'width:150px' }, mv) : null, tags.equipment.length ? h('div', { style: 'width:150px' }, eq) : null), results, chosen), actions);
  if (!onPick) d.addEventListener('close', () => { if (added) onAdd(); }, { once: true });
  drawResults();
  q.focus();
}
