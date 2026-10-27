// Coach side of Programs: the Programs page (what athletes logged, who needs a check-in), the exercise library (shown in
// Settings) and the
// program builder (one week at a time). Owners and coaches build and assign; front desk sees everything read-only and
// can email an athlete their workout app link. The server enforces the same rules.
import { h, fill, toast, copyText, busy, btn, field, input, select, panel, ago, money, videoEmbed, playIcon } from './ui.js';
import { saleForm } from './shop-admin.js';
import { importView } from './program-import.js';
import { boardView } from './board-import.js';
import { setFields, detailsOf, groupTag, withGroups, GROUP_KINDS, KIND_WORDS } from './set-fields.js';
import { scheduleFields, fmtDay, statusBadge } from './training-days.js';
import { choices, ALL_WORD } from './startup-ui.js';
import { sendClip } from './formchecks-ui.js';

let deps = null;     // { api, render, header, role, pulseTile }
export function initPrograms(d) { deps = d; }
// Programs → Build from a PDF and Programs → Dictate a workout (program-import.js).
export const viewProgramImport = (main) => importView(main, deps);
export const viewProgramDictate = (main) => importView(main, deps, 'dictate');
// Programs → Build from a picture (board-import.js): a photo of the whiteboard becomes one workout with its blocks.
export const viewProgramBoard = (main) => boardView(main, deps);
const get = (p) => deps.api('GET', p), post = (p, b = {}) => deps.api('POST', p, b), patch = (p, b) => deps.api('PATCH', p, b), put = (p, b) => deps.api('PUT', p, b), del = (p, b) => deps.api('DELETE', p, b);
const canEdit = () => ['owner', 'coach'].includes(deps.role());
const isOwner = () => deps.role() === 'owner';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const first = (name) => name.split(' ')[0];
const LOAD_LIFT = { squat_1rm: 'back squat', bench_1rm: 'bench press', power_clean_1rm: 'power clean' };
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'All levels'];
const SETTINGS = { facility: 'In the facility', remote: 'Out of the facility', both: 'Both' };
const sportInput = (value = '') => input({ value: value ?? '', maxlength: '40', list: 'dp-sport-list', placeholder: 'Baseball, Football, Any', autocomplete: 'off', 'aria-label': 'Sport' });
const sportList = (progs) => h('datalist', { id: 'dp-sport-list' }, [...new Set(['Baseball', 'Softball', 'Football', 'Basketball', 'Soccer', 'Volleyball', 'Track', 'Any sport', ...progs.map((p) => p.sport).filter(Boolean)])].map((x) => h('option', { value: x })));
const loadText = (x) => (x.load_test ? `${x.load_pct}% of ${LOAD_LIFT[x.load_test]} max` : null);
const textarea = (value = '', attrs = {}) => { const t = h('textarea', { class: 'dp-input', ...attrs }); t.value = value ?? ''; return t; };
const bar = (pct, label) => h('div', { class: 'eg-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': label }, h('span', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));

// A dialog with a title, a body and buttons. An action's onClick returns false to keep the dialog open; errors show in it.
function dialog(title, body, actions) {
  const main = document.getElementById('dialog');
  // A dialog opened from inside another (the complex editor's exercise picker) gets its own element on top.
  const d = main.open ? document.body.appendChild(h('dialog', { class: 'dp-dialog-stacked' })) : main;
  if (d !== main) d.addEventListener('close', () => d.remove(), { once: true });
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
const pageState = { q: '', level: '', sport: '', setting: '', author: '', exQ: '', exCat: '', exFilter: '', exMove: '', exEquip: '', tags: null };

export async function viewPrograms(main) {
  const [progs, exs, act, shop, blocks, tmpl, wtmpl, rules, notes, gameRules] = await Promise.all([get('/v1/programs'), get('/v1/exercises'), get('/v1/programs/activity'), isOwner() ? get('/v1/shop') : null, get('/v1/routines').catch(() => ({ data: [] })),
    get('/v1/programs?kind=template').catch(() => ({ data: [] })), get('/v1/workout-templates').catch(() => ({ data: [] })), get('/v1/program-rules').catch(() => null), canEdit() ? get('/v1/weekly-notes').catch(() => null) : null, get('/v1/game-rules').catch(() => null)]);
  const edit = canEdit();

  // Programs (version 74, owner's ask): one line per program, filtered by sport, setting, who wrote it and level.
  const cards = h('div', { class: 'pg-list' });
  const search = input({ type: 'search', placeholder: 'Search programs', 'aria-label': 'Search programs', value: pageState.q });
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const levels = uniq([...LEVELS, ...progs.data.map((p) => p.level)]);
  const levelSel = select([['', 'Every level'], ...levels.map((l) => [l, l])], { value: pageState.level, 'aria-label': 'Level' });
  const sportSel = select([['', 'Every sport'], ...uniq(progs.data.map((p) => p.sport)).map((x) => [x, x]), ['unset', 'No sport set']], { value: pageState.sport ?? '', 'aria-label': 'Sport' });
  const settingSel = select([['', 'Anywhere'], ...Object.entries(SETTINGS), ['unset', 'Not set']], { value: pageState.setting ?? '', 'aria-label': 'Where' });
  const authors = uniq(progs.data.map((p) => p.author_name));
  const authorSel = select([['', 'Anyone'], ...authors.map((a) => [a, a]), ['unset', 'No author']], { value: pageState.author ?? '', 'aria-label': 'Written by' });
  const drawCards = () => {
    const q = pageState.q.trim().toLowerCase();
    const is = (val, want) => !want || (want === 'unset' ? !val : (val ?? '').toLowerCase() === want.toLowerCase());
    const shown = progs.data.filter((p) => (!q || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q))
      && is(p.level, pageState.level) && is(p.sport, pageState.sport) && is(p.setting, pageState.setting) && is(p.author_name, pageState.author));
    fill(cards, shown.length ? shown.map((p) => h('a', { href: `#/programs/${p.id}`, class: 'pg-row' },
      h('span', { class: 'pg-row-name' }, p.name),
      h('span', { class: 'small muted pg-row-meta' }, [p.sport, p.setting ? SETTINGS[p.setting] : null, p.level, p.author_name ? `by ${p.author_name}` : null, plural(p.weeks, 'week'), p.client_count ? plural(p.client_count, 'client') : null].filter(Boolean).join(' · '))))
      : h('div', { class: 'empty' }, progs.data.length ? 'No programs match. Clear the search or filters.' : edit ? 'No programs yet. Use New program to build your first one.' : 'No programs yet.'));
  };
  search.addEventListener('input', () => { pageState.q = search.value; drawCards(); });
  const bind = (sel, key) => sel.addEventListener('change', () => { pageState[key] = sel.value; drawCards(); });
  bind(levelSel, 'level'); bind(sportSel, 'sport'); bind(settingSel, 'setting'); bind(authorSel, 'author');
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
    deps.header('Programs', 'Build training, attach demo videos and assign to clients.', edit ? h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--ghost', href: '#/programs/monthly' }, 'Monthly reports'), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/programs/dictate' }, 'Dictate a workout'), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/programs/board' }, 'Build from a picture'), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/programs/import' }, 'Build from a PDF'), btn('New program', () => newProgramDialog(progs.data, tmpl.data))) : null),
    pulse,
    // One column (owner's ask: the exercise library lives in Settings only), so the calendar has the page's width.
    h('div', { class: 'stack', style: 'gap:24px' },
      h('div', { class: 'stack', style: 'gap:8px' }, search, h('div', { class: 'form-grid cols-4', style: 'gap:8px' }, sportSel, settingSel, authorSel, levelSel)),
      cards, calendarPanel(progs.data, edit), weekPanel, notes ? weeklyNotesPanel(notes) : null, rules ? rulesPanel(rules, progs.data, edit) : null, gameRules ? gameRulesPanel(gameRules, isOwner()) : null, templatesPanel(tmpl.data, wtmpl.data, progs.data, edit), routinesPanel(blocks.data, exs.data, edit), checkOn, feed, shop ? storePanel(shop) : null));
}

// The month calendar (the redesign, step 3): a pick (everyone on a program, one program, a team or one athlete), a month
// of day cells with a card per workout the picked people have that day, a day view beside it, and Publish / Release
// from / Unpublish for a program pick.
const calUi = { month: null, pick: '', day: null };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ymd = (d) => d.toISOString().slice(0, 10);
const monthOf = (s) => { const [y, m] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)); };
const shiftMonth = (s, n) => { const d = monthOf(s); d.setUTCMonth(d.getUTCMonth() + n); return ymd(d).slice(0, 7); };
function calendarPanel(progs, edit) {
  const box = h('div', { class: 'stack', style: 'gap:10px' });
  const pick = select([['', 'Everyone on a program']], { 'aria-label': 'Whose calendar', value: calUi.pick });
  const title = h('h3', { class: 'week-title', style: 'margin:0' });
  const grid = h('div', { class: 'cal-grid', role: 'grid', 'aria-label': 'Month' });
  const side = h('div', { class: 'cal-day' });
  const pubBox = h('div', { class: 'row wrap', style: 'gap:6px;align-items:center' });
  let data = null;
  const query = () => { const [kind, id] = calUi.pick.split(':'); return kind === 'program' ? `program_id=${id}` : kind === 'team' ? `contract_id=${id}` : kind === 'client' ? `client_id=${id}` : ''; };
  const load = async () => {
    fill(grid, h('p', { class: 'small muted' }, 'Loading…'));
    data = await get(`/v1/calendar?month=${calUi.month}&${query()}`);
    draw();
  };
  const draw = () => {
    title.textContent = `${MONTHS[Number(calUi.month.split('-')[1]) - 1]} ${calUi.month.split('-')[0]}`;
    const byDate = new Map(data.days.map((d) => [d.date, d]));
    const firstDay = monthOf(calUi.month), startPad = (firstDay.getUTCDay() + 6) % 7;   // Monday first
    const cells = [['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('div', { class: 'cal-head', role: 'columnheader' }, d))];
    const n = new Date(Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth() + 1, 0)).getUTCDate();
    const items = [];
    for (let i = 0; i < startPad; i++) items.push(h('div', { class: 'cal-cell cal-cell--pad' }));
    for (let d = 1; d <= n; d++) {
      const date = `${calUi.month}-${String(d).padStart(2, '0')}`, day = byDate.get(date);
      items.push(h('button', { type: 'button', role: 'gridcell', class: `cal-cell${date === data.today ? ' cal-cell--today' : ''}${calUi.day === date ? ' cal-cell--picked' : ''}${day ? ' cal-cell--has' : ''}`, 'aria-label': `${date}${day ? `, ${plural(day.workouts.length, 'workout')}` : ''}`,
        onClick: () => { calUi.day = date; draw(); } },
        h('span', { class: 'cal-n' }, String(d)),
        day ? day.workouts.slice(0, 3).map((w) => h('span', { class: `cal-card${w.done === w.athletes.length ? ' cal-card--done' : w.missed ? ' cal-card--missed' : w.unpublished ? ' cal-card--hidden' : ''}` }, w.title, h('span', { class: 'cal-card-n' }, `${w.done}/${w.athletes.length}`))) : null,
        day && day.workouts.length > 3 ? h('span', { class: 'small muted' }, `+${day.workouts.length - 3}`) : null));
    }
    fill(grid, ...cells, ...items);
    // The day view: every workout that day, who has it, and the numbers.
    const day = calUi.day ? byDate.get(calUi.day) : null;
    fill(side, h('div', { class: 'strong' }, calUi.day ? fmtDay(calUi.day) : 'Pick a day'),
      !calUi.day ? h('p', { class: 'small muted', style: 'margin:0' }, 'Click a day to see its workouts and who has them.')
        : !day ? h('p', { class: 'small muted', style: 'margin:0' }, 'Nothing on this day for these athletes.')
          : day.workouts.map((w) => h('div', { class: 'cal-wo' },
            h('a', { class: 'strong', href: `#/programs/${w.program_id}?week=${w.week}`, style: 'color:inherit' }, w.title),
            h('div', { class: 'small muted' }, `${w.program_name} · week ${w.week} day ${w.day} · ${plural(w.exercises, 'exercise')}${w.blocks.length ? ` · ${w.blocks.join(', ')}` : ''}`),
            h('div', { class: 'small' }, `${w.done} of ${w.athletes.length} logged${w.missed ? ` · ${w.missed} missed` : ''}${w.unpublished ? ` · ${w.unpublished} can't see it yet` : ''}${w.effort_avg != null ? ` · effort ${w.effort_avg}` : ''}`),
            h('div', { class: 'row wrap', style: 'gap:4px' }, w.athletes.map((a) => h('a', { class: `dp-badge ${a.status === 'done' ? 'dp-badge--good' : a.status === 'missed' ? 'dp-badge--warn' : 'dp-badge--muted'}`, href: `#/clients/${a.id}?tab=training`, style: 'text-decoration:none' }, first(a.name)))))));
    // Publish controls for a program pick.
    const [kind, id] = calUi.pick.split(':');
    const states = data.assignments.reduce((m, a) => { m[a.state] = (m[a.state] ?? 0) + 1; return m; }, {});
    const summary = data.people ? Object.entries(states).map(([k, c]) => `${c} ${k}`).join(' · ') : 'nobody on a program';
    const doPub = (body, msg) => busy(null, async () => { const r = await post(`/v1/programs/${id}/publish`, body); toast(`${msg} for ${plural(r.athletes.length, 'athlete')}.`); await load(); });
    fill(pubBox, h('span', { class: 'small muted' }, `${plural(data.people, 'athlete')} · ${summary}`),
      edit && kind === 'program' ? [btn('Publish now', () => doPub({ published_from: null }, 'Published'), 'secondary'),
        btn('Release from a date', () => { const d = prompt('Athletes see the program from (YYYY-MM-DD):', data.today); if (d) doPub({ published_from: d }, `Released from ${d}`); }, 'ghost'),
        btn('Unpublish', () => { if (confirm('Hide this program from its athletes until you publish it again? Nothing counts as missed meanwhile.')) doPub({ published_from: 'unpublished' }, 'Unpublished'); }, 'ghost')] : null);
  };
  pick.addEventListener('change', () => { calUi.pick = pick.value; calUi.day = null; load().catch((e) => toast(e.message, 'warn')); });
  const nav = (n) => { calUi.month = shiftMonth(calUi.month, n); calUi.day = null; load().catch((e) => toast(e.message, 'warn')); };
  calUi.month ??= new Date().toISOString().slice(0, 7);
  fill(box, h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, btn('◀', () => nav(-1), 'ghost', { 'aria-label': 'Previous month' }), title, btn('▶', () => nav(1), 'ghost', { 'aria-label': 'Next month' }), btn('Today', () => { calUi.month = new Date().toISOString().slice(0, 7); calUi.day = null; load(); }, 'ghost'), h('span', { class: 'grow' }), h('div', { style: 'min-width:220px' }, pick)),
    pubBox, h('div', { class: 'cal-wrap' }, grid, side));
  Promise.all([get('/v1/teams').catch(() => ({ data: [] })), get('/v1/clients?status=current').catch(() => ({ data: [] }))]).then(([teams, clients]) => {
    for (const p of progs) pick.append(h('option', { value: `program:${p.id}` }, `Program: ${p.name}`));
    for (const t of teams.data) pick.append(h('option', { value: `team:${t.id}` }, `Team: ${t.label}`));
    for (const c of clients.data.filter((c) => c.program)) pick.append(h('option', { value: `client:${c.id}` }, c.name));
    pick.value = calUi.pick;
  }).catch(() => {});
  load().catch((e) => fill(grid, h('p', { class: 'dp-error' }, e.message)));
  return panel('Calendar', { subtitle: 'What each athlete has on each day. Pick a program, a team or one athlete; click a day for the details; publish a program when it\'s ready.' }, box);
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
  const sport = sportInput(''), setting = select([['', 'Not set'], ...Object.entries(SETTINGS)], { 'aria-label': 'Where' });
  dialog('New program', h('div', { class: 'stack' }, sportList(list), field('Program name', name), h('div', { class: 'form-grid' }, field('Weeks', weeks), field('Level', level), field('Sport', sport), field('In or out of the facility', setting)),
    field('Start from', from, templates.length ? 'A template or a copy brings its workouts and phases in the weeks you keep.' : 'A copy brings the workouts in the weeks you keep.')), [
    { label: 'Create program', variant: 'primary', onClick: async () => {
      const p = await post('/v1/programs', { name: name.value, weeks: Number(weeks.value), level: level.value, sport: sport.value || null, setting: setting.value || null, copy_from: from.value || undefined });
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
export async function exerciseLibrary() {
  const [exs, cx] = await Promise.all([get('/v1/exercises'), get('/v1/complexes').catch(() => ({ data: [] }))]);
  return h('div', { class: 'stack', style: 'gap:24px' }, libraryPanel(exs, canEdit()), complexesPanel(cx.data, exs, canEdit()));
}
// Complexes (version 74, owner's ask): a named group of exercises written once ("Acceleration Primer") and loaded into any
// workout as a block with Load a complex. Edited here; workouts already built from one keep what they have.
function complexesPanel(list, exs, edit) {
  const row = (c) => h('div', { class: 'list-item' },
    h('div', { class: 'grow stack-tight' }, h('span', null, h('span', { class: 'strong' }, c.name), c.kind !== 'block' ? h('span', { class: 'small muted' }, ` · ${c.kind_label.toLowerCase()}`) : null),
      h('span', { class: 'small muted' }, `${c.exercises.map((x) => `${x.name} ${x.prescription}`).join(' · ')}${c.used_in ? ` · loaded into ${plural(c.used_in, 'workout')}` : ''}`),
      c.note ? h('span', { class: 'small pg-note' }, c.note) : null),
    edit ? btn('Edit', () => complexDialog(c, exs), 'ghost', { 'aria-label': `Edit ${c.name}` }) : null);
  return panel('Complexes', { subtitle: 'A named group of exercises, like Acceleration Primer, loaded into any workout in one click (the builder\'s Load a complex). Changes here don\'t touch workouts already built from it.',
    action: edit ? btn('New complex', () => complexDialog(null, exs), 'secondary') : null },
    list.length ? list.map(row) : h('p', { class: 'small muted' }, 'No complexes yet. Build a block in a workout and Save as complex, or start one here.'));
}
function complexDialog(c, exs) {
  const name = input({ value: c?.name ?? '', maxlength: '60', required: true, placeholder: 'Acceleration Primer' });
  const kind = select(Object.keys(GROUP_KINDS).map((k) => [k, `${GROUP_KINDS[k]} · ${KIND_WORDS[k]}`]), { value: c?.kind ?? 'block', 'aria-label': 'How it runs' });
  const note = input({ value: c?.note ?? '', maxlength: '500', placeholder: 'What it\'s for (optional)' });
  const rows = (c?.exercises ?? []).map((x) => ({ ...x }));
  const rowsBox = h('div', { class: 'stack-tight' });
  const line = (x) => [detailsOf(x), loadText(x)].filter(Boolean).join(' · ');
  const editRow = (x, i) => {
    const sf = setFields(x, { hint: false }), load = loadFields(x);
    dialog(x.name, h('div', { class: 'stack' }, sf.el, load.el), [
      { label: 'Done', variant: 'primary', onClick: () => { Object.assign(rows[i], sf.body(), load.body(), { prescription: rxLine(sf.body()) }); draw(); } },
      { label: 'Cancel', variant: 'ghost' }]);
    sf.focus();
  };
  const draw = () => fill(rowsBox, rows.length ? rows.map((x, i) => h('div', { class: 'row pg-ex sf-in-group' },
    h('span', { class: 'sf-tag', 'aria-hidden': 'true' }, String(i + 1)),
    h('button', { type: 'button', class: 'grow pg-ex-body', 'aria-label': `${x.name}: change sets and reps`, onClick: () => editRow(x, i) },
      h('span', { class: 'stack-tight grow' }, h('span', null, x.name), h('span', { class: 'small muted' }, line(x) || 'Set the sets and reps')), h('span', { class: 'small muted', 'aria-hidden': 'true' }, 'Edit')),
    i > 0 ? btn('↑', () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); }, 'ghost', { 'aria-label': `Move ${x.name} up` }) : null,
    i < rows.length - 1 ? btn('↓', () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); }, 'ghost', { 'aria-label': `Move ${x.name} down` }) : null,
    btn('Remove', () => { rows.splice(i, 1); draw(); }, 'ghost', { 'aria-label': `Remove ${x.name}` })))
    : h('p', { class: 'small muted', style: 'margin:0' }, 'No exercises yet.'));
  draw();
  const addEx = () => pickExercise({ title: `Add to ${name.value.trim() || 'the complex'}`, exs, program: { workouts: [] }, onPick: async (ex) => {
    rows.push({ exercise_id: ex.id, name: ex.name, sets: 3, reps: '8', prescription: '3 × 8' }); draw();
  } });
  const body = () => ({ name: name.value.trim(), kind: kind.value, note: note.value.trim() || null, exercises: rows.map((x) => {
    const { name: _n, prescription: _p, id: _i, position: _pos, video_url: _v, poster_url: _po, category: _c, details: _d, group_tag: _g, ...f } = x;
    return f;
  }) });
  const actions = [{ label: c ? 'Save complex' : 'Add complex', variant: 'primary', onClick: async () => {
    if (!name.value.trim()) throw new Error('Name the complex.');
    if (!rows.length) throw new Error('Add at least one exercise.');
    if (c) await patch(`/v1/complexes/${c.id}`, body()); else await post('/v1/complexes', body());
    toast(c ? 'Complex saved. Workouts already built from it keep what they have.' : 'Complex added. Load it into a workout from the builder.'); deps.render();
  } }, { label: 'Add exercise', onClick: () => { addEx(); return false; } }, { label: 'Cancel', variant: 'ghost' }];
  if (c) actions.push({ label: 'Delete', variant: 'ghost', onClick: async () => {
    if (!confirm(`Delete ${c.name}?${c.used_in ? ` The ${plural(c.used_in, 'workout')} built from it stay as they are.` : ''}`)) return false;
    await del(`/v1/complexes/${c.id}`); toast(`${c.name} deleted.`); deps.render();
  } });
  dialog(c ? `Edit ${c.name}` : 'New complex', h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('Name', name), field('How the athlete runs it', kind)), field('Note', note),
    h('div', { class: 'dp-label' }, 'Exercises, in order'), rowsBox), actions);
  name.focus();
}
// The short text for a row edited in a dialog, the way the server builds it (rx.js rxText).
const rxLine = (f) => {
  const time = f.time_seconds != null && f.time_seconds !== '' ? String(f.time_seconds).trim() : '';   // typed as "40 sec" or "2 min"; the server keeps the seconds
  const what = f.reps || f.distance ? [f.reps, f.distance].filter(Boolean).join(' × ') : time;
  let core = f.sets && what ? `${f.sets} × ${what}` : f.sets ? `${f.sets} sets` : what;
  if (time && (f.reps || f.distance)) core = `${core} · ${time}`;
  return [core, f.load_text ? `@ ${f.load_text}` : null].filter(Boolean).join(' ');
};
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
      x.cue?.audio ? h('span', { class: 'dp-badge dp-badge--good', title: 'A recorded cue plays in the app' }, '🔊 Cue') : null,
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
// The coach's cue (cues.js): record a few words once here (the phone's or laptop's microphone), and the app plays them
// when the exercise opens; the words typed below are read aloud where there's no recording. A short "why this matters"
// clip goes to the private clips bucket the same way a form check does.
function cueBlock(x) {
  const box = h('div', { class: 'stack-tight', style: 'border-top:1px solid var(--line);padding-top:12px' }, h('div', { class: 'dp-label' }, 'Coach\'s cue in the app'), h('p', { class: 'small muted', style: 'margin:0' }, 'Loading…'));
  let rec = null, chunks = [], blob = null, startedAt = 0, timer = null;
  const mimeFor = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) ?? '';
  const draw = async () => {
    const c = await get(`/v1/exercises/${x.id}/cue`);
    const status = h('span', { class: 'small muted', 'aria-live': 'polite' });
    const preview = h('div', { class: 'stack-tight' });
    const words = textarea(c.transcript ?? '', { placeholder: c.words ? `Reads aloud: "${c.words}"` : 'What you say in the recording (read aloud where the phone can\'t play it)', style: 'min-height:56px' });
    const recBtn = btn('Record', null, 'secondary'), stopBtn = btn('Stop', null, 'primary', { hidden: true }), saveBtn = btn('Save recording', null, 'primary', { hidden: true });
    const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    recBtn.addEventListener('click', async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = []; blob = null; preview.replaceChildren();
        rec = new MediaRecorder(stream, mimeFor() ? { mimeType: mimeFor() } : undefined);
        rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop()); clearInterval(timer);
          blob = new Blob(chunks, { type: rec.mimeType || mimeFor() || 'audio/webm' });
          const secs = Math.round((Date.now() - startedAt) / 1000);
          status.textContent = `${secs} second${secs === 1 ? '' : 's'} recorded. Listen, then save.`;
          fill(preview, h('audio', { controls: true, src: URL.createObjectURL(blob), style: 'width:100%' }));
          recBtn.hidden = false; recBtn.textContent = 'Record again'; stopBtn.hidden = true; saveBtn.hidden = false;
        };
        startedAt = Date.now(); rec.start();
        recBtn.hidden = true; stopBtn.hidden = false; saveBtn.hidden = true;
        timer = setInterval(() => { const secs = Math.round((Date.now() - startedAt) / 1000); status.textContent = `Recording… ${secs} s (up to ${c.max_audio_seconds}).`; if (secs >= c.max_audio_seconds) rec.stop(); }, 500);
      } catch (e) { status.textContent = e.name === 'NotAllowedError' ? 'The microphone was blocked. Allow it in the browser and try again.' : e.message; }
    });
    stopBtn.addEventListener('click', () => rec?.state === 'recording' && rec.stop());
    saveBtn.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      if (!blob) throw new Error('Record first.');
      if (blob.size > c.max_audio_bytes) throw new Error(`That recording is ${(blob.size / 1024 / 1024).toFixed(1)} MB; the limit is ${c.max_audio_bytes / 1024 / 1024} MB. Keep it to a few sentences.`);
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
      await put(`/v1/exercises/${x.id}/cue/audio`, { audio_base64: b64, content_type: blob.type.split(';')[0], duration_s: Math.round((Date.now() - startedAt) / 1000), transcript: words.value.trim() || undefined });
      toast('Cue saved. Athletes hear it when the exercise opens.'); draw();
    }));
    const onFile = (file, progress) => sendClip({ file, onProgress: progress, start: (b) => post(`/v1/exercises/${x.id}/cue/clip`, b), finish: () => post(`/v1/exercises/${x.id}/cue/clip/done`) }).then(() => { toast('Clip saved.'); draw(); });
    const clipIn = h('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/webm', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
    const clipBtn = btn(c.clip ? 'Replace the clip' : 'Add a clip', () => clipIn.click(), 'ghost');
    clipIn.addEventListener('change', () => { const file = clipIn.files?.[0]; clipIn.value = ''; if (file) busy(clipBtn, () => onFile(file, () => {})); });
    fill(box, h('div', { class: 'dp-label' }, 'Coach\'s cue in the app'),
      h('span', { class: 'small muted' }, 'Say the one thing that matters, once. The app plays it the moment an athlete opens this exercise; where it can\'t, the phone reads the words.'),
      c.audio ? h('div', { class: 'row wrap small', style: 'align-items:center;gap:8px' }, h('audio', { controls: true, src: `/v1/exercises/${x.id}/cue/audio?v=${encodeURIComponent(c.audio_at ?? '')}`, style: 'max-width:260px' }),
        h('span', { class: 'muted grow' }, `${c.audio_seconds ? `${Math.round(c.audio_seconds)} s · ` : ''}${c.audio_by ?? 'a coach'}, ${ago(c.audio_at).toLowerCase()}`),
        btn('Remove', (e) => { if (!confirm('Remove the recording? The words stay.')) return; busy(e.currentTarget, async () => { await del(`/v1/exercises/${x.id}/cue/audio`); draw(); }); }, 'ghost')) : null,
      canRecord ? h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, recBtn, stopBtn, saveBtn, status) : h('span', { class: 'small muted' }, 'This browser can\'t record. Use the phone or a laptop with a microphone.'),
      preview,
      h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'The words'), words, h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' },
        btn('Save words', (e) => busy(e.currentTarget, async () => { await patch(`/v1/exercises/${x.id}/cue`, { transcript: words.value.trim() }); toast('Saved.'); }), 'ghost'),
        h('span', { class: 'small muted' }, 'Empty = the coaching cues above are read.'))),
      h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, h('span', { class: 'small strong' }, 'Why this matters (a clip up to 20 seconds)'),
        c.clip ? h('span', { class: 'small muted' }, `${c.clip_seconds ? `${Math.round(c.clip_seconds)} s · ` : ''}${c.clip_by ?? 'a coach'}, ${ago(c.clip_at).toLowerCase()}`) : null,
        c.clip ? btn('Play', (e) => busy(e.currentTarget, async () => { const r = await get(`/v1/exercises/${x.id}/cue/video`); fill(preview, h('video', { controls: true, autoplay: true, playsinline: true, src: r.url, style: 'width:100%;max-height:320px;background:#000' })); }), 'ghost') : null,
        c.clips_ready ? clipBtn : h('span', { class: 'small muted' }, 'Clips need the private clips bucket (Settings → Backups & jobs).'),
        c.clip ? btn('Remove clip', (e) => { if (!confirm('Remove the clip?')) return; busy(e.currentTarget, async () => { await del(`/v1/exercises/${x.id}/cue/clip`); draw(); }); }, 'ghost') : null, clipIn));
  };
  draw().catch((e) => fill(box, h('p', { class: 'small muted' }, e.message)));
  return box;
}
function exerciseDialog(x, cats, tags = null) {
  const f = exerciseFields(x, cats, tags);
  if (x) f.el.append(cueBlock(x), alternativesBlock(x));
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
const builder = { focusTab: false, selected: new Set(), clientsOpen: false, sendOpen: false, sellOpen: false };   // selected: the ticked days (workout ids) on the week grid; the *Open flags: the top bar's drop-down and toggles, kept across redraws
const drag = { kind: null, id: null, days: [] };            // what is being dragged: an exercise line, or a day (with the ticked days)

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

  // The week grid (the redesign, step 1): the seven days across, each a column of blocks with one line per exercise;
  // ticks on days raise an action bar (copy, move, repeat, save to library, delete); arrows step the weeks.
  const selected = builder.selected;
  const barBox = h('div', { class: 'pg-bar', hidden: true, role: 'region', 'aria-label': 'Selected days' });
  const drawBar = () => {
    const ids = [...selected].filter((id) => p.workouts.some((w) => w.id === id));
    for (const id of selected) if (!ids.includes(id)) selected.delete(id);
    barBox.hidden = !ids.length;
    if (!ids.length) return;
    const after = (r) => { selected.clear(); reload(r?.days?.[0]?.week ?? week); };
    fill(barBox, h('span', { class: 'strong' }, `${plural(ids.length, 'day')} selected`),
      btn('Copy to', () => bulkDialog(p, ids, 'copy', after), 'secondary'), btn('Move', () => bulkDialog(p, ids, 'move', after), 'ghost'), btn('Repeat', () => bulkDialog(p, ids, 'repeat', after), 'ghost'),
      btn('Save to library', (e) => busy(e.currentTarget, async () => { for (const id of ids) { const w = p.workouts.find((x) => x.id === id); await post(`/v1/workouts/${id}/save-template`, { name: w.title }); } toast(`${plural(ids.length, 'workout template')} saved. Start a day from them with Add day.`); selected.clear(); drawBar(); drawWeek(); }), 'ghost'),
      btn('Delete', (e) => { const logged = ids.reduce((n, id) => n + (p.workouts.find((x) => x.id === id)?.logs ?? 0), 0); if (!confirm(`Delete ${plural(ids.length, 'day')}?${logged ? ` Athletes logged them ${plural(logged, 'time')}; those logs stay in their history.` : ''}`)) return;
        busy(e.currentTarget, async () => { const r = await post(`/v1/programs/${id}/days/delete`, { workouts: ids, confirm: true }); toast(`${plural(r.deleted, 'day')} deleted.`); after(); }); }, 'ghost'),
      btn('Send to athletes', () => sendDialog(p, ids, [], () => { selected.clear(); drawBar(); }), 'secondary'),
      btn('Clear', () => { selected.clear(); drawBar(); drawWeek(); }, 'ghost'));
  };
  const drawWeek = () => {
    weekBox.setAttribute('aria-labelledby', `pg-week-${week}`);
    const days = daysIn(week);
    const isLast = week === p.weeks;
    const logged = days.reduce((n, w) => n + w.logs, 0);
    const weekReps = days.reduce((n, w) => n + repsOf(w), 0);
    const step = (d) => { const n = week + d; if (n < 1 || n > p.weeks) return; week = n; go(n); draw(); };
    const weekActions = edit ? h('div', { class: 'row wrap' },
      days.length < 7 ? btn('Add day', () => dayDialog(p, week, reload), 'secondary') : null,
      days.length ? btn('Copy week', () => copyWeekDialog(p, week, reload), 'ghost') : null,
      days.length || (isLast && p.weeks > 1) ? btn('Delete week', (e) => {
        const msg = days.length ? `Delete week ${week}'s ${plural(days.length, 'workout')}?${logged ? ` Athletes logged them ${plural(logged, 'time')}; those logs stay in the athletes' history.` : ''}${isLast && p.weeks > 1 ? ' The program becomes shorter.' : ''}` : `Remove week ${week}? The program becomes shorter.`;
        if (!confirm(msg)) return;
        busy(e.currentTarget, async () => { await del(`/v1/programs/${id}/weeks/${week}`, { confirm: true }); toast(`Week ${week} deleted.`); reload(Math.min(week, isLast && p.weeks > 1 ? p.weeks - 1 : p.weeks)); });
      }, 'ghost') : null) : null;
    const columns = [1, 2, 3, 4, 5, 6, 7].map((d) => { const w = days.find((x) => x.day === d); return w ? dayColumn(p, w, exs, edit, reload, { selected, onSelect: drawBar }) : emptyDay(p, week, d, edit, reload); });
    fill(weekBox,
      h('div', { class: 'row wrap', style: 'align-items:center' },
        h('div', { class: 'row', style: 'gap:4px;align-items:center' },
          btn('◀', () => step(-1), 'ghost', { 'aria-label': 'Previous week', disabled: week <= 1 }), h('h2', { class: 'week-title', style: 'margin:0' }, `Week ${week} of ${p.weeks}`), btn('▶', () => step(1), 'ghost', { 'aria-label': 'Next week', disabled: week >= p.weeks })),
        h('span', { class: 'small muted grow' }, days.length ? `${plural(days.length, 'day')} · ${weekReps.toLocaleString()} reps planned${logged ? ` · logged ${plural(logged, 'time')}` : ''}` : ''),
        weekActions),
      h('div', { class: 'pg-grid-wrap' }, h('div', { class: 'pg-days', role: 'group', 'aria-label': `Week ${week}, days across` }, columns)));
    drawBar();
  };
  const isTemplate = p.kind === 'template';
  // The top bar (owner's ask): who is on the program as a drop-down with a search bar to add more, and Send to and Sell
  // online as toggles that open above the grid, so the seven day columns get the whole width of the page.
  const sendBox = h('div', { id: 'pg-send-box', hidden: !builder.sendOpen }, edit && !isTemplate ? sendPanel(p, { selected, onSend: () => { selected.clear(); drawBar(); drawWeek(); }, top: true }) : null);
  const sellBox = h('div', { id: 'pg-sell-box', hidden: !builder.sellOpen }, shop && !isTemplate ? panel('Sell online', { subtitle: 'Out-of-town athletes and families buy it from the store page.' }, saleForm(put, 'program', shop.programs.find((x) => x.id === id), () => deps.render(), { get })) : null);
  const toggle = (label, key, box) => {
    const b = btn(label, () => { builder[key] = !builder[key]; box.hidden = !builder[key]; b.setAttribute('aria-pressed', String(builder[key])); b.setAttribute('aria-expanded', String(builder[key])); }, builder[key] ? 'secondary' : 'ghost', { 'aria-pressed': String(builder[key]), 'aria-expanded': String(builder[key]), 'aria-controls': box.id });
    return b;
  };
  const topBar = isTemplate ? null : h('div', { class: 'pg-top' },
    clientsDrop(p, edit),
    edit ? toggle('Send to', 'sendOpen', sendBox) : null,
    shop ? toggle('Sell online', 'sellOpen', sellBox) : null);
  const header = deps.header(isTemplate ? `${p.name} (template)` : p.name, isTemplate ? `Template · ${plural(p.weeks, 'week')} · ${p.level ?? 'Any level'} · nobody is assigned to a template: start a program from it` : `${plural(p.weeks, 'week')} · ${p.level ?? 'Any level'} · ${plural(p.clients.length, 'client')} · ${plural(p.logged_7d, 'workout')} logged in the last 7 days`,
    edit ? isTemplate ? btn('Start a program from it', () => get('/v1/programs?kind=template').then((t) => newProgramDialog([], t.data, p.id))) : btn('Assign to a client', () => assignDialog(p)) : null);
  fill(main, header,
    p.description ? h('p', { class: 'muted', style: 'margin-top:-12px' }, p.description) : null,
    edit ? h('div', { class: 'row wrap' }, btn('Edit details', () => detailsDialog(p), 'ghost'), btn('Duplicate program', () => duplicateDialog(p), 'ghost'),
      btn(isTemplate ? 'Copy as a new template' : 'Save as template', () => saveTemplateDialog(p), 'ghost'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: `/program.html?id=${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener' }, 'Print or PDF'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: `/v1/programs/${encodeURIComponent(id)}/export.xlsx` }, 'Excel')) : null,
    topBar, sendBox, sellBox,
    modeBar, tabsBox, weekBox, barBox, planBox,
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

// Who is on the program, as a drop-down at the top of the page (owner's ask), with a search bar to add a client or a
// team: typing a name and pressing Enter (or Add) opens the Assign dialog on that name.
function clientsDrop(p, edit) {
  const n = p.clients.length;
  const q = edit ? input({ type: 'search', placeholder: 'Add a client or team: type a name', 'aria-label': 'Add a client or team to this program', style: 'min-width:220px' }) : null;
  const open = () => assignDialog(p, q.value.trim());
  if (q) q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } });
  const box = h('details', { class: 'pg-drop', open: builder.clientsOpen },
    h('summary', { class: 'dp-btn dp-btn--ghost pg-drop-sum' }, `Clients on this program · ${n}`),
    h('div', { class: 'pg-drop-body stack' },
      edit ? h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, h('div', { class: 'grow', style: 'min-width:220px' }, q), btn('Add', open, 'secondary')) : null,
      n ? h('p', { class: 'small muted dp-help', style: 'margin:0' }, 'Workouts done, what\'s next and when they last trained. Amber means no workout in a week.') : null,
      clientRows(p, edit)));
  box.addEventListener('toggle', () => { builder.clientsOpen = box.open; });
  return box;
}
function clientRows(p, edit) {
  return p.clients.length ? p.clients.map((c) => {
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
    }) : h('p', { class: 'muted small', style: 'margin:0' }, edit ? 'Nobody is on this program yet. Type a name above to add someone.' : 'Nobody is on this program yet.');
}

// Assign the program: one athlete found by name or Athlete ID (the list shows only once something is typed, so a big
// client list stays a search bar), or a whole team.
function assignDialog(p, query = '') {
  const need = Math.max(1, ...p.workouts.map((w) => w.day));
  const sched = scheduleFields({ need });        // the day week 1 starts and the weekdays they train, the same for everyone assigned here
  const q = input({ type: 'search', placeholder: 'Name or Athlete ID', 'aria-label': 'Find a client', value: query });
  const out = h('div', { class: 'stack', style: 'gap:0;max-height:50vh;overflow:auto' });
  let clients = null;
  const draw = () => {
    if (!clients) return fill(out, h('p', { class: 'small muted' }, 'Loading clients…'));
    const needle = q.value.trim().toLowerCase();
    if (!needle) return fill(out, h('p', { class: 'small muted' }, `Type a name or Athlete ID to find someone (${plural(clients.length, 'client')}).`));
    const shown = clients.filter((c) => c.name.toLowerCase().includes(needle) || (c.athlete_id ?? '').toLowerCase().includes(needle)).slice(0, 30);
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
  const sport = sportInput(p.sport), setting = select([['', 'Not set'], ...Object.entries(SETTINGS)], { value: p.setting ?? '', 'aria-label': 'Where' });
  dialog('Edit details', h('div', { class: 'stack' }, sportList([]), field('Program name', name), h('div', { class: 'form-grid' }, field('Weeks', weeks, p.last_week ? `At least ${p.last_week}: week ${p.last_week} has workouts.` : null), field('Level', level), field('Sport', sport), field('In or out of the facility', setting)), field('Description', desc),
    p.author_name ? h('p', { class: 'small muted', style: 'margin:0' }, `Written by ${p.author_name}.`) : null), [
    { label: 'Save details', variant: 'primary', onClick: async () => { await patch(`/v1/programs/${p.id}`, { name: name.value, weeks: Number(weeks.value), level: level.value || null, description: desc.value || null, sport: sport.value || null, setting: setting.value || null }); toast('Program saved.'); deps.render(); } },
    { label: 'Cancel', variant: 'ghost' }]);
}
function duplicateDialog(p) {
  const name = input({ value: `${p.name} (copy)` });
  dialog('Duplicate program', h('div', { class: 'stack' }, h('p', { class: 'muted', style: 'margin:0' }, 'Every week and workout is copied. Nobody is assigned to the copy and it isn\'t for sale.'), field('Name of the copy', name)), [
    { label: 'Duplicate', variant: 'primary', onClick: async () => { const c = await post(`/v1/programs/${p.id}/duplicate`, { name: name.value }); toast('Program copied.'); location.hash = `#/programs/${c.id}`; } },
    { label: 'Cancel', variant: 'ghost' }]);
  name.select();
}
function dayDialog(p, week, reload, preset = null) {
  const used = new Set(p.workouts.filter((w) => w.week === week).map((w) => w.day));
  const free = [1, 2, 3, 4, 5, 6, 7].filter((d) => !used.has(d));
  const day = select(free.map((d) => [String(d), `Day ${d}`]), { value: preset && free.includes(preset) ? String(preset) : String(free[0]) });
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
// The weekly coach's note (schema 71, services/weekly.js): a line per athlete drafted from last week's facts; the coach
// changes the words and sends. It shows on the athlete's Workout tab and taps their phone.
function weeklyNotesPanel(notes) {
  const drafts = notes.data.filter((n) => n.status === 'draft'), sent = notes.data.filter((n) => n.status === 'sent');
  const week = drafts[0]?.week_label ?? notes.weeks[0]?.label ?? 'last week';
  const row = (n) => {
    const text = textarea(n.body, { rows: '2', 'aria-label': `Note for ${first(n.client_name)}`, style: 'min-height:56px' });
    let saved = n.body;
    const save = async () => { const val = text.value.trim(); if (val === saved) return; saved = val; await patch(`/v1/weekly-notes/${n.id}`, { body: val }); };
    text.addEventListener('blur', () => save().catch((e) => toast(e.message, 'warn')));
    const f = n.facts ?? {};
    return h('div', { class: 'list-item', style: 'flex-wrap:wrap;align-items:flex-start' },
      h('div', { class: 'grow stack-tight', style: 'min-width:260px' }, h('a', { href: `#/clients/${n.client_id}?tab=training`, class: 'strong', style: 'color:inherit' }, n.client_name),
        h('span', { class: 'small muted' }, [f.planned != null ? `${f.done} of ${f.planned} workouts` : null, f.sets ? plural(f.sets, 'set') : null, f.checkins ? plural(f.checkins, 'check-in') : null, f.streak ? `${f.streak} clean ${f.streak === 1 ? 'week' : 'weeks'}` : null, f.top_lift ? `${f.top_lift.name} ~${f.top_lift.e1rm} lb${f.top_lift.change ? ` (${f.top_lift.change > 0 ? '+' : ''}${f.top_lift.change})` : ''}` : null].filter(Boolean).join(' · ')),
        text),
      h('div', { class: 'row wrap', style: 'gap:6px' },
        btn('Send', (e) => busy(e.currentTarget, async () => { await save(); await post(`/v1/weekly-notes/${n.id}/send`); toast(`Sent to ${first(n.client_name)}.`); deps.render(); }), 'primary'),
        btn('Skip', (e) => busy(e.currentTarget, async () => { await post(`/v1/weekly-notes/${n.id}/skip`); deps.render(); }), 'ghost')));
  };
  return panel('Weekly notes', { subtitle: `A line for each athlete about ${week}, drafted from what they did. Change the words, then send: it shows in their app and taps their phone. ${notes.mode === 'auto' ? 'Drafts go out on their own on Monday.' : notes.mode === 'off' ? 'Off right now.' : 'Drafted every Monday.'}`,
    action: h('div', { class: 'row wrap', style: 'gap:6px' }, drafts.length > 1 ? btn('Send all', (e) => { if (!confirm(`Send ${drafts.length} notes as they read now?`)) return; busy(e.currentTarget, async () => { const r = await post('/v1/weekly-notes/send-all', { week: drafts[0].week_start }); toast(`Sent ${r.sent}.`); deps.render(); }); }, 'secondary') : null,
      btn('Draft last week', (e) => busy(e.currentTarget, async () => { const r = await post('/v1/weekly-notes/generate'); toast(r.written ? `${plural(r.written, 'note')} drafted.` : r.kept ? 'Already drafted.' : 'Nothing to say: a quiet week for everyone.'); deps.render(); }), 'ghost')) },
    drafts.length ? drafts.map(row) : h('p', { class: 'muted small' }, sent.length ? `All sent for ${week}. ${plural(sent.length, 'note')} went out.` : 'No drafts right now. They\'re written on Monday morning, or press Draft last week.'));
}
// The game-week rules (gameweek.js, docs/game-week.md): for each day from three before a game to three after, its
// colour (green = the workout as written, yellow = one set fewer on every exercise, red = half the sets) and the
// advice athletes read. The owner changes them; coaches read them.
function gameRulesPanel(r, owner) {
  const rows = r.rules.map((d) => {
    const allow = select(r.loads.map((l) => [l.key, l.label]), { value: d.allow, 'aria-label': `Colour ${d.label.toLowerCase()}`, disabled: owner ? null : '' });
    const advice = textarea(d.advice, { rows: '3', maxlength: '600', 'aria-label': `Advice ${d.label.toLowerCase()}`, disabled: owner ? null : '' });
    return { d, allow, advice, el: h('div', { class: 'list-item', style: 'flex-wrap:wrap;align-items:flex-start' },
      h('div', { style: 'width:140px' }, h('div', { class: 'strong' }, d.label), h('div', { class: 'small muted' }, d.offset === 0 ? 'the game' : d.offset < 0 ? `${-d.offset} ${-d.offset === 1 ? 'day' : 'days'} before` : `${d.offset} ${d.offset === 1 ? 'day' : 'days'} after`)),
      h('div', { style: 'width:280px' }, allow), h('div', { class: 'grow', style: 'min-width:240px' }, advice)) };
  });
  const actions = owner ? h('div', { class: 'row wrap' },
    btn('Save rules', (e) => busy(e.currentTarget, async () => { await patch('/v1/game-rules', { rules: Object.fromEntries(rows.map((x) => [x.d.key, { allow: x.allow.value, advice: x.advice.value.trim() }])) }); toast('Game-week rules saved. Every athlete\'s plan reads them from now on.'); }), 'primary'),
    r.customized ? btn('Back to the starting values', (e) => { if (!confirm('Put every day back to the research brief\'s rules and words?')) return; busy(e.currentTarget, async () => { await patch('/v1/game-rules', { reset: true }); toast('Reset.'); deps.render(); }); }, 'ghost') : null) : null;
  return panel('Game week', { subtitle: 'Athletes and families keep their games, races and competitions in the app; each day around one takes a colour on the athlete\'s calendar and the sets follow on their own: green is the workout as written, yellow one set fewer on every exercise, red half the sets (rounded up, never below one). The exercises, reps and weights never change, so programs are written as usual. The starting values come from the research in docs/game-week.md: the hardest work three days out, soreness and lost force for 48 to 72 hours after a game, nothing new or heavy the day before.' },
    h('div', { class: 'stack-tight' }, rows.map((x) => x.el)), actions);
}
// Start-up rules (schema 67, services/startup.js): which program an athlete's answers to the start-up questions put them
// on. The highest priority matching rule wins; the owner picks whether it happens at once, waits for a coach, or is off.
const MODE_TEXT = { auto: 'Athletes who answer the questions start the matching program at once; you\'re told on Today and by email.', review: 'A match waits on Today for a coach to approve.', off: 'The rules do nothing; coaches assign every program.' };
function rulesPanel(rules, programs, edit) {
  const q = rules.questions;
  const label = (list, all) => (list.length ? list.join(', ') : all);
  const modeSel = select([['auto', 'Start them at once'], ['review', 'A coach approves first'], ['off', 'Off']], { value: rules.mode, 'aria-label': 'What happens when an athlete answers' });
  modeSel.addEventListener('change', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { auto_program: modeSel.value }); toast('Saved.'); deps.render(); }));
  const ruleRow = (r) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'min-width:220px' },
      h('span', { class: 'strong' }, r.name ?? r.program_name, r.active ? null : h('span', { class: 'dp-badge dp-badge--muted', style: 'margin-left:8px' }, 'Off')),
      h('span', { class: 'small muted' }, `→ ${r.program_name} · ${label(r.goal_labels, ALL_WORD.goals)} · ${label(r.experience_labels, ALL_WORD.experience)} · ${r.days_min === r.days_max ? `${r.days_min} days a week` : `${r.days_min} to ${r.days_max} days a week`} · ${r.equipment_labels.length ? `needs ${r.equipment_labels.join(', ')} at home` : ALL_WORD.equipment}${r.priority ? ` · priority ${r.priority}` : ''} · placed ${r.placed}`)),
    edit ? h('div', { class: 'row wrap', style: 'gap:6px' },
      btn('Edit', () => ruleDialog(q, programs, r), 'ghost', { 'aria-label': `Edit the rule ${r.name ?? r.program_name}` }),
      btn(r.active ? 'Turn off' : 'Turn on', (e) => busy(e.currentTarget, async () => { await patch(`/v1/program-rules/${r.id}`, { active: !r.active }); deps.render(); }), 'ghost'),
      btn('Delete', (e) => { if (!confirm(`Delete the rule ${r.name ?? r.program_name}? Athletes it placed stay on their program.`)) return; busy(e.currentTarget, async () => { await del(`/v1/program-rules/${r.id}`); toast('Rule deleted.'); deps.render(); }); }, 'ghost', { 'aria-label': `Delete the rule ${r.name ?? r.program_name}` })) : null);
  // Try it: where a set of answers would land.
  const tryBox = h('div', { class: 'small muted' });
  const tGoal = select([['', 'Goal'], ...q.goals.map((g) => [g.key, g.label])]), tExp = select([['', 'Experience'], ...q.experience.map((g) => [g.key, g.label])]), tDays = select([['', 'Days'], ...[1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), `${n} days`])]), tWhere = select([['', 'Where'], ...q.trains_at.map((g) => [g.key, g.label])]);
  const tryIt = async () => {
    if (!tGoal.value || !tExp.value || !tDays.value) { tryBox.textContent = 'Pick a goal, experience and days to try.'; return; }
    const r = await post('/v1/program-rules/try', { goal: tGoal.value, experience: tExp.value, days_per_week: Number(tDays.value), trains_at: tWhere.value || null, equipment: tWhere.value === 'home' ? [] : undefined });
    tryBox.textContent = r.program ? `→ ${r.program.name} (${r.rule.name ?? 'rule'})${tWhere.value === 'home' ? ', with bodyweight only at home' : ''}` : r.reason === 'no_rules' ? 'No rules yet.' : 'No rule fits these answers: the athlete would wait for a coach.';
  };
  for (const el of [tGoal, tExp, tDays, tWhere]) el.addEventListener('change', () => tryIt().catch((e) => { tryBox.textContent = e.message; }));
  return panel('Start-up rules', { subtitle: 'An athlete (or a parent) answers a few questions in the app: goal, experience, days a week, where they train, the gear at home. These rules say which program the answers lead to. The highest priority match wins; a program\'s days a week must fit.',
    action: edit ? btn('Add rule', () => ruleDialog(q, programs), 'secondary') : null },
    isOwner() ? h('div', { class: 'row wrap', style: 'align-items:center;gap:8px' }, h('span', { class: 'small strong' }, 'When an athlete answers:'), modeSel, h('span', { class: 'small muted' }, MODE_TEXT[rules.mode] ?? '')) : h('p', { class: 'small muted', style: 'margin:0' }, MODE_TEXT[rules.mode] ?? ''),
    rules.data.length ? rules.data.map(ruleRow) : h('p', { class: 'muted small' }, edit ? 'No rules yet. Add one per program: who it\'s for and how many days it needs. Until then, athletes who answer wait for a coach on Today.' : 'No rules yet.'),
    h('div', { class: 'stack-tight', style: 'border-top:1px solid var(--line-subtle);padding-top:8px' }, h('span', { class: 'small strong' }, 'Try it'), h('div', { class: 'row wrap', style: 'gap:6px' }, tGoal, tExp, tDays, tWhere), tryBox));
}
function ruleDialog(q, programs, rule = null) {
  const prog = select(programs.map((p) => [p.id, `${p.name}${p.days_per_week ? ` (${p.days_per_week} days a week)` : ''}`]), { value: rule?.program_id ?? programs[0]?.id });
  const name = input({ value: rule?.name ?? '', placeholder: 'New to speed, 3 days' });
  const goals = choices(q.goals, rule?.goals ?? [], { label: 'Goals' }), exp = choices(q.experience, rule?.experience ?? [], { label: 'Experience' }), gear = choices(q.gear, rule?.equipment ?? [], { label: 'Gear the program needs at home' });
  const dmin = input({ type: 'number', min: '1', max: '7', value: String(rule?.days_min ?? programs.find((p) => p.id === prog.value)?.days_per_week ?? 3), inputmode: 'numeric' });
  const dmax = input({ type: 'number', min: '1', max: '7', value: String(rule?.days_max ?? 7), inputmode: 'numeric' });
  prog.addEventListener('change', () => { if (!rule) { const p = programs.find((x) => x.id === prog.value); if (p?.days_per_week) dmin.value = String(p.days_per_week); } });
  const prio = input({ type: 'number', min: '-100', max: '100', value: String(rule?.priority ?? 0), inputmode: 'numeric' });
  dialog(rule ? 'Edit the rule' : 'Add a start-up rule', h('div', { class: 'stack' },
    field('Program', prog, 'A program, not a template. Its days a week set the fewest days this rule can take.'),
    field('Name', name),
    h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Goals it fits'), goals.el, h('span', { class: 'small muted' }, 'None picked = any goal.')),
    h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Experience it fits'), exp.el, h('span', { class: 'small muted' }, 'None picked = any experience.')),
    h('div', { class: 'form-grid' }, field('Fewest days a week', dmin), field('Most days a week', dmax), field('Priority', prio, 'Higher wins when two rules fit.')),
    h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Gear the program needs at home'), gear.el, h('span', { class: 'small muted' }, 'An athlete training at home without it gets another rule, or waits for a coach. At the facility everyone has everything.'))), [
    { label: rule ? 'Save' : 'Add rule', variant: 'primary', onClick: async () => {
      const body = { program_id: prog.value, name: name.value.trim() || null, goals: goals.value(), experience: exp.value(), days_min: Number(dmin.value), days_max: Number(dmax.value), equipment: gear.value(), priority: Number(prio.value) };
      if (rule) await patch(`/v1/program-rules/${rule.id}`, body); else await post('/v1/program-rules', body);
      toast(rule ? 'Rule saved.' : 'Rule added.'); deps.render();
    } },
    { label: 'Cancel', variant: 'ghost' }]);
}
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

// Reps planned in a day: sets × the number to count from the reps text (a time, distance or max counts nothing).
const repNum = (reps) => { const m = /^(\d{1,3})/.exec(String(reps ?? '').trim()); return m && !/\d\s*(s|sec|min|yd|m|ft|km|mi)\b|:\d/i.test(reps) ? Number(m[1]) : 0; };
const repsOf = (w) => w.exercises.reduce((n, x) => n + (x.sets || 1) * repNum(x.reps), 0);
// A block's letter circle takes a colour from its name: warm-ups amber, speed and conditioning green, cool-downs blue, lifts steel.
const blockTone = (name = '') => (/warm|activ|mobil|prep/i.test(name) ? 'warm' : /sprint|accel|speed|condition|plyo|agil|jump|tempo run/i.test(name) ? 'speed' : /cool|stretch|recover|breath/i.test(name) ? 'cool' : 'lift');
const letterOf = (i) => String.fromCharCode(65 + Math.min(i, 25));

// One day of the week grid: the tick, the title, the day's instructions, each block with its letter and its exercises
// one line each, and the adds at the foot.
function dayColumn(p, w, exs, edit, reload, { selected, onSelect }) {
  const line = (x) => [x.prescription, x.rest_seconds != null ? (x.rest_seconds === 0 ? 'no rest' : `${restWord(x.rest_seconds)} rest`) : null, x.tempo ? `tempo ${x.tempo}` : null, x.target_rpe != null ? `RPE ${x.target_rpe}` : null, loadText(x)].filter(Boolean).join(' · ');
  // Drag and drop (step 2): a line is dragged within the day, into a block, or onto another day; the drop lands it
  // ahead of the line it is dropped on, at the end of a block dropped on its heading, or at the end of a day.
  const drop = async (payload) => { try { await post(`/v1/workout-exercises/${drag.id}/move`, { workout_id: w.id, ...payload }); reload(); } catch (e) { toast(e.message, 'warn'); } };
  const dragProps = (x) => (edit ? { draggable: 'true',
    onDragstart: (e) => { drag.id = x.id; drag.kind = 'exercise'; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', x.id); e.currentTarget.classList.add('pg-dragging'); e.currentTarget.closest('.pg-days')?.classList.add('pg-days--dragging'); },
    onDragend: (e) => { e.currentTarget.classList.remove('pg-dragging'); drag.id = null; e.currentTarget.closest('.pg-days')?.classList.remove('pg-days--dragging'); } } : {});
  const target = (payloadOf) => (edit ? {
    onDragover: (e) => { if (drag.kind !== 'exercise') return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('pg-over'); },
    onDragleave: (e) => e.currentTarget.classList.remove('pg-over'),
    onDrop: (e) => { if (drag.kind !== 'exercise') return; e.preventDefault(); e.currentTarget.classList.remove('pg-over'); const pl = payloadOf(); if (pl.before_id === drag.id) return; drop(pl); } } : {});
  // Ticked exercises on this day (owner's ask: link exercises together into a complex, or remove them): the bar under
  // the lines offers Make a complex, Group as a block and Remove for the ticked ones.
  const picked = new Set();
  const pickBar = h('div', { class: 'pg-pickbar', hidden: true, role: 'region', 'aria-label': 'Ticked exercises' });
  const removeOne = async (x) => {
    const r = await del(`/v1/workout-exercises/${x.id}`);
    reload();
    undoToast(`${x.name} removed.`, () => busy(null, async () => { const { workout_id, ...back } = r.restore; await post(`/v1/workouts/${workout_id}/exercises`, back); toast(`${x.name} is back.`); reload(); }));
  };
  const drawPick = () => {
    const ids = w.exercises.filter((x) => picked.has(x.id)).map((x) => x.id);   // in the day's order
    pickBar.hidden = !ids.length;
    if (!ids.length) return;
    fill(pickBar, h('span', { class: 'small strong' }, `${ids.length} ticked`),
      btn('Make a complex', () => linkDialog(w, ids, 'complex', reload), 'secondary', { disabled: ids.length < 2, title: ids.length < 2 ? 'Tick at least two' : 'Link them into a complex in the library' }),
      btn('Group as a block', () => linkDialog(w, ids, 'block', reload), 'ghost', { title: 'Put them together in a named block on this day' }),
      btn('Remove', (e) => { if (!confirm(`Remove ${plural(ids.length, 'exercise')} from ${w.title}?`)) return; busy(e.currentTarget, async () => { for (const id of ids) await del(`/v1/workout-exercises/${id}`); toast(`${plural(ids.length, 'exercise')} removed.`); reload(); }); }, 'ghost'),
      btn('Clear', () => { picked.clear(); drawPick(); for (const el of pickBar.parentElement?.querySelectorAll('.pg-line-tick') ?? []) el.checked = false; }, 'ghost'));
  };
  const row = (x, n) => h('div', { class: 'pg-line', ...dragProps(x), ...target(() => ({ before_id: x.id, block_id: x.block_id ?? null })) },
    edit ? h('input', { type: 'checkbox', class: 'pg-line-tick', 'aria-label': `Tick ${x.name}`, onChange: (e) => { if (e.target.checked) picked.add(x.id); else picked.delete(x.id); drawPick(); } }) : null,
    n != null ? h('span', { class: 'pg-line-n' }, String(n)) : null,
    edit ? h('button', { type: 'button', class: 'pg-line-body', 'aria-label': `${x.name}, ${line(x)}: change, move or remove`, onClick: () => slotDialog(x, { p, w, exs, reload }) },
      h('span', { class: 'pg-line-name' }, x.name, x.form_check ? h('span', { class: 'pg-flag', title: x.form_check_note || 'The athlete is asked to send a clip' }, 'FC') : null), h('span', { class: 'pg-line-rx' }, line(x)), x.note ? h('span', { class: 'pg-line-note' }, x.note) : null)
      : h('div', { class: 'pg-line-body' }, h('span', { class: 'pg-line-name' }, x.name), h('span', { class: 'pg-line-rx' }, line(x)), x.note ? h('span', { class: 'pg-line-note' }, x.note) : null),
    x.video_url ? playBtn(x) : null,
    edit ? btn('×', (e) => busy(e.currentTarget, () => removeOne(x)), 'ghost', { class: 'dp-btn dp-btn--ghost pg-line-x', 'aria-label': `Remove ${x.name} from ${w.title}`, title: 'Remove (Undo for a moment after)' }) : null);
  const blocks = w.blocks ?? [];
  const byId = new Map(blocks.map((b, i) => [b.id, { b, i }]));
  const blockHead = (b, i) => h('div', { class: 'pg-bhead', ...target(() => ({ block_id: b.id })) },
    h('span', { class: `pg-letter pg-letter--${blockTone(b.name)}`, 'aria-hidden': 'true' }, letterOf(i)),
    edit ? h('button', { type: 'button', class: 'pg-bname', 'aria-label': `${b.name}: rename, change or remove`, onClick: () => blockDialog(w, b, reload) }, b.name, b.kind !== 'block' ? h('span', { class: 'pg-bkind' }, ` · ${KIND_WORDS[b.kind]}`) : null)
      : h('span', { class: 'pg-bname' }, b.name, b.kind !== 'block' ? h('span', { class: 'pg-bkind' }, ` · ${KIND_WORDS[b.kind]}`) : null),
    edit ? h('div', { class: 'pg-bacts' },
      btn('+', () => pickExercise({ title: `Add to ${b.name}`, exs, program: p, workout: w, block: b, onAdd: () => reload() }), 'ghost', { 'aria-label': `Add an exercise to ${b.name}`, title: 'Add an exercise' }),
      b.count && i > 0 && blocks[i - 1].count ? btn('↑', (e) => busy(e.currentTarget, async () => { await patch(`/v1/workout-blocks/${b.id}`, { position: i }); reload(); }), 'ghost', { 'aria-label': `Move ${b.name} up` }) : null,
      b.count && i < blocks.length - 1 && blocks[i + 1].count ? btn('↓', (e) => busy(e.currentTarget, async () => { await patch(`/v1/workout-blocks/${b.id}`, { position: i + 2 }); reload(); }), 'ghost', { 'aria-label': `Move ${b.name} down` }) : null,
      b.count ? btn('Save', () => saveComplexDialog(b), 'ghost', { 'aria-label': `Save ${b.name} as a complex`, title: 'Save as a complex' }) : null,
      btn('×', (e) => { if (b.count && !confirm(`Remove the block ${b.name} and its ${plural(b.count, 'exercise')}?`)) return; busy(e.currentTarget, async () => { await del(`/v1/workout-blocks/${b.id}`); toast(`${b.name} removed.`); reload(); }); }, 'ghost', { 'aria-label': `Remove ${b.name}` })) : null);
  const rows = [];
  let n = 0;
  w.exercises.forEach((x, i) => {
    if (x.block_id && w.exercises[i - 1]?.block_id !== x.block_id && byId.has(x.block_id)) { const { b, i: bi } = byId.get(x.block_id); rows.push(blockHead(b, bi)); n = 0; }
    rows.push(row(x, x.block_id ? ++n : null));
  });
  for (const b of blocks.filter((b) => !b.count)) rows.push(blockHead(b, byId.get(b.id).i), h('p', { class: 'small muted', style: 'margin:0 0 0 30px' }, edit ? 'Empty. Press + to add an exercise.' : 'Empty.'));
  const tick = edit ? h('input', { type: 'checkbox', class: 'pg-tick', checked: selected.has(w.id), 'aria-label': `Select day ${w.day}, ${w.title}`, onChange: (e) => { if (e.target.checked) selected.add(w.id); else selected.delete(w.id); onSelect(); } }) : null;
  const menu = edit ? h('details', { class: 'pg-menu' }, h('summary', { 'aria-label': `More for ${w.title}` }, '⋮'),
    h('div', { class: 'pg-menu-list' },
      btn('Rename', () => renameDialog(w, reload), 'ghost'), btn(w.instructions ? 'Edit instructions' : 'Add instructions', () => instructionsDialog(w, reload), 'ghost'),
      btn('Warm-up and cool-down', (e) => busy(e.currentTarget, () => blocksDialog(w, reload)), 'ghost'),
      btn('Copy', () => copyWorkoutDialog(p, w, reload), 'ghost'),
      btn('Save as template', () => { const name = prompt(`Save ${w.title} as a workout template. Name it:`, w.title); if (name === null) return; post(`/v1/workouts/${w.id}/save-template`, { name: name.trim() || w.title }).then(() => toast('Template saved. Start a day from it with Add day.')).catch((e) => toast(e.message, 'warn')); }, 'ghost'),
      btn('Delete', (e) => { if (confirm(`Delete ${w.title}?${w.logs ? ` Athletes logged it ${plural(w.logs, 'time')}; those logs stay in the athletes' history.` : ''}`)) busy(e.currentTarget, async () => { await del(`/v1/workouts/${w.id}`, { confirm: true }); toast('Workout deleted.'); reload(); }); }, 'ghost'))) : null;
  const reps = repsOf(w);
  const dayDrag = edit ? { draggable: 'true',
    onDragstart: (e) => { drag.kind = 'day'; drag.days = selected.has(w.id) ? [...selected] : [w.id]; e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', drag.days.join(',')); e.currentTarget.classList.add('pg-dragging'); },
    onDragend: (e) => { e.currentTarget.classList.remove('pg-dragging'); drag.kind = null; } } : {};
  return h('div', { class: `pg-day${selected.has(w.id) ? ' pg-day--selected' : ''}`, 'data-day': String(w.day) },
    h('div', { class: 'pg-day-head', ...dayDrag, title: edit ? 'Drag onto an athlete, a team or a school in Send to' : null }, tick, h('div', { class: 'grow stack-tight', style: 'gap:0;min-width:0' },
      h('span', { class: 'small muted' }, `Day ${w.day}${w.logs ? ` · logged ${w.logs}×` : ''}${reps ? ` · ${reps} reps` : ''}`),
      edit ? h('button', { type: 'button', class: 'pg-title strong', 'aria-label': `Rename ${w.title}`, onClick: () => renameDialog(w, reload) }, w.title) : h('span', { class: 'strong' }, w.title)), menu),
    w.instructions ? h('div', { class: 'pg-instr' }, h('span', { class: 'pg-instr-k' }, 'Instructions'), h('span', { class: 'small' }, w.instructions)) : null,
    w.warmup || w.cooldown ? h('div', { class: 'small muted' }, [w.warmup ? `Warm-up: ${w.warmup.name}` : null, w.cooldown ? `Cool-down: ${w.cooldown.name}` : null].filter(Boolean).join(' · ')) : null,
    rows.length ? h('div', { class: 'pg-day-body' }, rows) : h('p', { class: 'small muted', style: 'margin:0' }, edit ? 'Empty. Add a block or load a complex.' : 'Empty.'),
    pickBar,
    // The drop target for the end of the day (an exercise dragged here lands last, in no block); it shows only while a
    // line is being dragged (owner's ask: the standing "Drop here" line was puzzling).
    edit ? h('div', { class: 'pg-dropzone', ...target(() => ({ block_id: null })) }, 'Drop here to put it last on this day') : null,
    edit ? h('div', { class: 'pg-day-foot' },
      btn('+ Block', () => blockDialog(w, null, reload), 'ghost'), btn('Load a complex', () => loadComplexDialog(w, reload), 'ghost'),
      btn('+ Exercise', () => pickExercise({ title: `Add to ${w.title}`, exs, program: p, workout: w, onAdd: () => reload() }), 'ghost', { title: 'Outside any block' })) : null);
}
const restWord = (secs) => (secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
// Send to (step 2): a panel of schools, teams and athletes beside the grid that takes dragged days, and the dialog that
// sends the days (a short program of their own) from a date.
async function sendTargets() {
  const [orgs, teams, clients] = await Promise.all([get('/v1/organizations').catch(() => ({ data: [] })), get('/v1/teams').catch(() => ({ data: [] })), get('/v1/clients')]);
  const activeOrg = new Set(teams.data.map((t) => t.org_id));
  return { schools: orgs.data.filter((o) => activeOrg.has(o.id)).map((o) => ({ kind: 'org', id: o.id, label: o.name, sub: `${plural(teams.data.filter((t) => t.org_id === o.id).length, 'team')} · the whole school` })),
    teams: teams.data.map((t) => ({ kind: 'team', id: t.id, label: t.label, sub: plural(t.roster_count, 'athlete') })),
    athletes: clients.data.filter((c) => !c.archived_at).map((c) => ({ kind: 'client', id: c.id, label: c.name, sub: c.program ? `On ${c.program.name}` : 'No program' })) };
}
function sendPanel(p, { selected, onSend, top = false }) {
  const box = h('aside', { class: `pg-send${top ? ' pg-send--top' : ''}`, 'aria-label': 'Send to' });
  const q = input({ type: 'search', placeholder: 'Find a school, team or athlete', 'aria-label': 'Find a school, team or athlete' });
  const list = h('div', { class: 'pg-send-list' });
  let targets = null;
  const item = (t) => h('div', { class: 'pg-send-item', role: 'button', tabindex: '0', 'aria-label': `Send the ticked days to ${t.label}`,
    onClick: () => { const days = [...selected]; if (!days.length) return toast('Tick the days to send first, or drag a day here.', 'warn'); sendDialog(p, days, [t], onSend); },
    onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } },
    onDragover: (e) => { if (drag.kind !== 'day') return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; e.currentTarget.classList.add('pg-over'); },
    onDragleave: (e) => e.currentTarget.classList.remove('pg-over'),
    onDrop: (e) => { if (drag.kind !== 'day') return; e.preventDefault(); e.currentTarget.classList.remove('pg-over'); sendDialog(p, [...drag.days], [t], onSend); } },
    h('span', { class: `pg-send-k pg-send-k--${t.kind}` }, { org: 'School', team: 'Team', client: '' }[t.kind]), h('span', { class: 'grow stack-tight', style: 'gap:0;min-width:0' }, h('span', { class: 'strong small' }, t.label), h('span', { class: 'small muted' }, t.sub)));
  const draw = () => {
    if (!targets) return fill(list, h('p', { class: 'small muted' }, 'Loading…'));
    const needle = q.value.trim().toLowerCase();
    const hit = (t) => !needle || t.label.toLowerCase().includes(needle);
    const groups = [['Schools', targets.schools.filter(hit)], ['Teams', targets.teams.filter(hit)], ['Athletes', targets.athletes.filter(hit).slice(0, 40)]].filter(([, xs]) => xs.length);
    fill(list, groups.length ? groups.flatMap(([title, xs]) => [h('div', { class: 'pg-send-group' }, title), ...xs.map(item)]) : h('p', { class: 'small muted' }, 'Nobody matches.'));
  };
  q.addEventListener('input', draw);
  fill(box, h('div', { class: 'strong' }, 'Send to'), h('p', { class: 'small muted', style: 'margin:0' }, 'Drag a day (or the ticked days) onto a school, a team or an athlete, or tick days and click one.'), q, list);
  draw();
  sendTargets().then((t) => { targets = t; draw(); }).catch((e) => fill(list, h('p', { class: 'dp-error' }, e.message)));
  return box;
}
function sendDialog(p, dayIds, picked, onSend) {
  const days = dayIds.map((id) => p.workouts.find((w) => w.id === id)).filter(Boolean);
  if (!days.length) return toast('Tick the days to send first.', 'warn');
  const need = Math.max(1, ...days.map((w) => w.day));
  const sched = scheduleFields({ need });
  const name = input({ maxlength: '120', value: `${p.name} · ${days.length === 1 ? days[0].title : plural(days.length, 'day')}`, 'aria-label': 'Name for these days' });
  const replace = h('input', { type: 'checkbox' });
  const chosen = new Map(picked.map((t) => [`${t.kind}:${t.id}`, t]));
  const chosenBox = h('div', { class: 'row wrap', style: 'gap:6px' });
  const q = input({ type: 'search', placeholder: 'Add a school, team or athlete', 'aria-label': 'Add a school, team or athlete' });
  const found = h('div', { class: 'pg-send-list', style: 'max-height:28vh' });
  let targets = null;
  const drawChosen = () => fill(chosenBox, chosen.size ? [...chosen.values()].map((t) => h('span', { class: 'dp-badge dp-badge--good', style: 'gap:6px' }, t.label, h('button', { type: 'button', class: 'pg-x', 'aria-label': `Remove ${t.label}`, onClick: () => { chosen.delete(`${t.kind}:${t.id}`); drawChosen(); } }, '×'))) : h('span', { class: 'small muted' }, 'Nobody chosen yet.'));
  const drawFound = () => {
    const needle = q.value.trim().toLowerCase();
    if (!targets || !needle) return fill(found);
    const all = [...targets.schools, ...targets.teams, ...targets.athletes].filter((t) => t.label.toLowerCase().includes(needle) && !chosen.has(`${t.kind}:${t.id}`)).slice(0, 12);
    fill(found, all.map((t) => h('button', { type: 'button', class: 'pg-send-item', onClick: () => { chosen.set(`${t.kind}:${t.id}`, t); q.value = ''; drawChosen(); drawFound(); } },
      h('span', { class: `pg-send-k pg-send-k--${t.kind}` }, { org: 'School', team: 'Team', client: '' }[t.kind]), h('span', { class: 'grow small strong' }, t.label), h('span', { class: 'small muted' }, t.sub))));
  };
  q.addEventListener('input', drawFound);
  sendTargets().then((t) => { targets = t; drawFound(); }).catch(() => {});
  drawChosen();
  dialog(`Send ${plural(days.length, 'day')}`, h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, `${days.map((w) => `wk ${w.week} d${w.day} ${w.title}`).join(', ')}. They go out as a short program of their own, so logging, progression and the calendar work as usual.`),
    field('To', chosenBox), q, found,
    field('Name on their app', name),
    sched.el,
    h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, replace, h('span', null, 'Move athletes who are on another program onto these days ', h('span', { class: 'muted' }, '(otherwise they are skipped and named)')))), [
    { label: 'Send', variant: 'primary', onClick: async () => {
      if (!chosen.size) throw new Error('Choose at least one school, team or athlete.');
      const ids = (k) => [...chosen.values()].filter((t) => t.kind === k).map((t) => t.id);
      const r = await post(`/v1/programs/${p.id}/days/send`, { workouts: dayIds, client_ids: ids('client'), contract_ids: ids('team'), org_ids: ids('org'), name: name.value.trim() || undefined, replace: replace.checked, ...sched.body() });
      toast(`${plural(r.assigned.length, 'athlete')} got ${r.program.name}.${r.skipped.length ? ` Skipped: ${r.skipped.map((x) => `${first(x.name)} (${x.reason})`).join(', ')}.` : ''}`, r.skipped.length ? 'warn' : 'good');
      onSend?.(r);
    } },
    { label: 'Cancel', variant: 'ghost' }]);
}
// A day of the week with no workout yet.
function emptyDay(p, week, day, edit, reload) {
  return h('div', { class: 'pg-day pg-day--empty', 'data-day': String(day) },
    h('div', { class: 'pg-day-head' }, h('span', { class: 'small muted' }, `Day ${day}`)),
    edit ? btn('+ Add day', () => dayDialog(p, week, reload, day), 'ghost', { 'aria-label': `Add a workout on day ${day} of week ${week}` }) : h('p', { class: 'small muted', style: 'margin:0' }, 'Rest'));
}
// The day's instructions (version 75): what the coach wants the athlete to read first.
function instructionsDialog(w, reload) {
  const t = textarea(w.instructions ?? '', { rows: '6', maxlength: '2000', placeholder: 'Start with the dynamic warm-up, then the speed work before the lifts. Rest 2 minutes between the heavy sets.' });
  dialog(`Instructions for ${w.title}`, h('div', { class: 'stack' }, field('What the athlete reads first', t, 'Shows at the top of the day in the app and on the weight-room screen.')), [
    { label: 'Save', variant: 'primary', onClick: async () => { await patch(`/v1/workouts/${w.id}`, { instructions: t.value.trim() || null }); toast('Instructions saved.'); reload(); } },
    { label: 'Cancel', variant: 'ghost' }]);
  t.focus();
}
// The ticked days at once: copy to a week (here, another program or a template), move to a week, or repeat for N weeks.
function bulkDialog(p, ids, action, after) {
  const days = ids.map((id) => p.workouts.find((w) => w.id === id)).filter(Boolean);
  const weeks = [...new Set(days.map((w) => w.week))].sort((a, b) => a - b);
  const weekSel = select(Array.from({ length: 52 }, (_, i) => [String(i + 1), `Week ${i + 1}${i + 1 > p.weeks ? ' (new)' : ''}`]), { value: String(Math.min(weeks.at(-1) + 1, 52)), 'aria-label': 'To week' });
  const times = input({ type: 'number', min: '1', max: '26', value: '4', inputmode: 'numeric', 'aria-label': 'How many times' });
  const target = select([[p.id, `This program (${p.name})`]], { 'aria-label': 'Which program' });
  if (action === 'copy') Promise.all([get('/v1/programs'), get('/v1/programs?kind=template')]).then(([a, b]) => {
    for (const x of [...a.data, ...b.data]) if (x.id !== p.id) target.append(h('option', { value: x.id }, `${x.kind === 'template' ? 'Template: ' : ''}${x.name}`));
  }).catch(() => {});
  const what = `${plural(days.length, 'day')} (${days.map((w) => `wk ${w.week} d${w.day}`).join(', ')})`;
  const body = action === 'copy' ? h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, `Copy ${what}. Each keeps its weekday; days from several weeks land in consecutive weeks.`), h('div', { class: 'form-grid' }, field('To week', weekSel), field('In', target)))
    : action === 'move' ? h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, `Move ${what}. Each keeps its weekday.`), field('To week', weekSel))
    : h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, `Repeat ${what} into the weeks after week ${weeks.at(-1)}.`), field('How many times', times, 'Each repeat is the same run of days again; the program grows as needed.'));
  const send = async (extra = {}) => {
    const payload = { workouts: ids, ...(action === 'repeat' ? { times: Number(times.value) } : { to_week: Number(weekSel.value) }), ...(action === 'copy' && target.value !== p.id ? { to_program_id: target.value } : {}), ...extra };
    try { return await post(`/v1/programs/${p.id}/days/${action}`, payload); }
    catch (e) {
      if (e.code === 'replace_needed') { if (!confirm(`${e.message}`)) return null; return send({ ...extra, replace: true }); }
      if (e.code === 'confirm_needed') { if (!confirm(`${e.message} Go on?`)) return null; return send({ ...extra, confirm: true }); }
      throw e;
    }
  };
  dialog({ copy: 'Copy days', move: 'Move days', repeat: 'Repeat days' }[action], body, [
    { label: { copy: 'Copy', move: 'Move', repeat: 'Repeat' }[action], variant: 'primary', onClick: async () => { const r = await send(); if (!r) return false; toast(`${plural(r.days.length, 'day')} ${action === 'copy' ? 'copied' : action === 'move' ? 'moved' : 'repeated'}${r.replaced ? `, ${r.replaced} replaced` : ''}.`); after(r.to_program_id && r.to_program_id !== p.id ? null : r); } },
    { label: 'Cancel', variant: 'ghost' }]);
}
// A block's name and how it runs (version 74): new, or renaming one. Any name goes; the usual ones are offered.
const BLOCK_NAMES = ['Warm up', 'Activation', 'Acceleration', 'Speed', 'Plyometrics', 'Power', 'Strength', 'Accessory', 'Conditioning', 'Core', 'Cool down'];
function blockFields(b = null) {
  const datalist = h('datalist', { id: 'dp-block-names' }, BLOCK_NAMES.map((n) => h('option', { value: n })));
  const name = input({ value: b?.name ?? '', maxlength: '40', list: 'dp-block-names', placeholder: 'Warm up, Speed, Strength, Acceleration Primer…', autocomplete: 'off', required: true, 'aria-label': 'Block name' });
  const kind = select(Object.keys(GROUP_KINDS).map((k) => [k, `${GROUP_KINDS[k]} · ${KIND_WORDS[k]}`]), { value: b?.kind ?? 'block', 'aria-label': 'How it runs' });
  return { name, kind, el: h('div', { class: 'stack' }, datalist, field('Name', name), field('How the athlete runs it', kind, 'A block runs one exercise after another. A superset or circuit runs one set of each exercise, then the rest.')) };
}
function blockDialog(w, b, reload) {
  const f = blockFields(b);
  dialog(b ? `Change ${b.name}` : `Add a block to ${w.title}`, f.el, [
    { label: b ? 'Save' : 'Add block', variant: 'primary', onClick: async () => {
      if (!f.name.value.trim()) throw new Error('Name the block, like Warm up or Strength.');
      if (b) { await patch(`/v1/workout-blocks/${b.id}`, { name: f.name.value, kind: f.kind.value }); toast('Block saved.'); }
      else { await post(`/v1/workouts/${w.id}/blocks`, { name: f.name.value, kind: f.kind.value }); toast(`${f.name.value.trim()} added. Now add its exercises.`); }
      reload();
    } },
    { label: 'Cancel', variant: 'ghost' }]);
  f.name.focus();
}
// Link the ticked exercises (owner's ask): into a complex in the library (a block on this day pointing at it) or just
// into a named block on this day. They keep their order and sit together where the first of them was.
function linkDialog(w, ids, mode, reload) {
  const names = ids.map((id) => w.exercises.find((x) => x.id === id)?.name).filter(Boolean);
  const f = blockFields(null);
  if (mode === 'complex' && !f.name.value) f.name.value = '';
  dialog(mode === 'complex' ? `Make a complex from ${plural(ids.length, 'exercise')}` : `Group ${plural(ids.length, 'exercise')} as a block`, h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, names.join(' · ')),
    f.el,
    mode === 'complex' ? h('p', { class: 'small muted dp-help', style: 'margin:0' }, 'The complex goes into the library under this name, so you can load it into any workout, in any program, with Load a complex. On this day it becomes a block with these exercises.') : null), [
    { label: mode === 'complex' ? 'Make the complex' : 'Group them', variant: 'primary', onClick: async () => {
      const name = f.name.value.trim();
      if (!name) throw new Error(mode === 'complex' ? 'Name the complex, like Acceleration Primer.' : 'Name the block, like Strength.');
      if (mode === 'complex') { const c = await post(`/v1/workouts/${w.id}/complex`, { exercise_ids: ids, name, kind: f.kind.value }); toast(`${c.name} is in the library (${plural(c.exercises.length, 'exercise')}) and is a block on ${w.title}.`); }
      else { await post(`/v1/workouts/${w.id}/blocks`, { name, kind: f.kind.value, exercise_ids: ids }); toast(`${name}: ${plural(ids.length, 'exercise')} grouped.`); }
      reload();
    } },
    { label: 'Cancel', variant: 'ghost' }]);
  f.name.focus();
}
// Load a complex from the library into this workout as a block with every exercise in it, in one go.
async function loadComplexDialog(w, reload) {
  const all = (await get('/v1/complexes')).data;
  if (!all.length) return toast('No complexes yet. Build a block, then Save as complex, or write one under Settings → Exercise library → Complexes.', 'warn');
  const pick = select(all.map((c) => [c.id, `${c.name} (${plural(c.exercises.length, 'exercise')}${c.kind !== 'block' ? `, ${GROUP_KINDS[c.kind].toLowerCase()}` : ''})`]), { 'aria-label': 'Complex' });
  const preview = h('p', { class: 'small muted', style: 'margin:0' });
  const draw = () => { const c = all.find((x) => x.id === pick.value); preview.textContent = c ? c.exercises.map((x) => `${x.name} ${x.prescription}`).join(' · ') : ''; };
  pick.addEventListener('change', draw); draw();
  dialog(`Load a complex into ${w.title}`, h('div', { class: 'stack' }, field('Complex', pick), preview, h('p', { class: 'small muted', style: 'margin:0' }, 'It comes in as a block with its name and every exercise. Changes you make here stay in this workout; the complex itself is edited under Settings → Exercise library → Complexes.')), [
    { label: 'Load it', variant: 'primary', onClick: async () => { const c = all.find((x) => x.id === pick.value); await post(`/v1/workouts/${w.id}/blocks`, { complex_id: pick.value }); toast(`${c.name} loaded: ${plural(c.exercises.length, 'exercise')}.`); reload(); } },
    { label: 'Cancel', variant: 'ghost' }]);
}
function saveComplexDialog(b) {
  const name = input({ value: b.name, maxlength: '60', required: true, 'aria-label': 'Complex name' });
  dialog(`Save ${b.name} as a complex`, h('div', { class: 'stack' }, field('Name', name, 'Load it into any workout, in any program, with Load a complex. Edit it later under Settings → Exercise library → Complexes.')), [
    { label: 'Save complex', variant: 'primary', onClick: async () => { const c = await post(`/v1/workout-blocks/${b.id}/save-complex`, { name: name.value }); toast(`${c.name} is in the library (${plural(c.exercises.length, 'exercise')}).`); } },
    { label: 'Cancel', variant: 'ghost' }]);
  name.select();
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
function slotDialog(x, { p, w, exs, reload }) {
  const sf = setFields(x);
  const load = loadFields(x);
  const blocks = w?.blocks ?? [];
  const blockSel = blocks.length ? select([['', 'Not in a block'], ...blocks.map((b) => [b.id, b.name])], { value: x.block_id ?? '', 'aria-label': 'Block' }) : null;
  dialog(x.name, h('div', { class: 'stack' }, sf.el, load.el, blockSel ? field('Block', blockSel, 'Moving it to another block puts it last in that block.') : null), [
    { label: 'Save', variant: 'primary', onClick: async () => { await patch(`/v1/workout-exercises/${x.id}`, { ...sf.body(), ...load.body(), ...(blockSel && blockSel.value !== (x.block_id ?? '') ? { block_id: blockSel.value || null } : {}) }); toast('Saved.'); reload(); } },
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
function pickExercise({ title, exs, program, workout, block = null, onAdd, onPick }) {
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
    sf = setFields(prev ?? null);
    load = loadFields(prev);
    const from = prev && program.workouts.find((w) => w.exercises.includes(prev));
    fill(chosen, h('div', { class: 'stack pg-inline' }, h('div', { class: 'strong' }, x.name),
      from ? h('span', { class: 'small muted' }, `Filled in from week ${from.week}.`) : null, sf.el, load.el));
    sf.focus();
  };
  const add = async (again) => {
    if (!picked) throw new Error('Choose an exercise from the list first.');
    await post(`/v1/workouts/${workout.id}/exercises`, { exercise_id: picked.id, ...sf.body(), ...(load.body().load_test ? load.body() : {}), ...(block ? { block_id: block.id } : {}) });
    added++;
    toast(`${picked.name} added to ${block ? block.name : workout.title}.`);
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
