import { h, fill, toast, busy, videoEmbed, playIcon, btn } from './ui.js';
import { createEngage, ENGAGE_TABS, tabIcon, engageDots } from './engage-view.js';

// The private link looks like /app?token=… . Keep the token for this device, then drop it from the address bar.
const params = new URLSearchParams(location.search);
let tokenValue = params.get('token');
try {
  if (tokenValue) localStorage.setItem('dp_client_token', tokenValue);
  else tokenValue = localStorage.getItem('dp_client_token');
} catch { /* storage blocked: keep the token in memory */ }
if (params.has('token')) history.replaceState(null, '', '/app');

const root = document.getElementById('root');
const api = async (method, path, body) => {
  const res = await fetch(path, { method, headers: { 'x-client-token': tokenValue || '', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'Something went wrong. Try again.');
  return data;
};

const state = { done: new Set(), playing: null, notes: '', tab: 'workout', home: null };
// The page: the current tab's view, and a tab bar for Workout, Accountability, Performance and Education.
const view = h('div', { class: 'c-view' });
const engage = createEngage({ api: { get: (p) => api('GET', `/app/api/${p}`), post: (p, b) => api('POST', `/app/api/${p}`, b ?? {}) }, onData: () => drawTabs() });
const tabs = h('nav', { class: 'eg-tabs', 'aria-label': 'Sections' });
function drawTabs() {
  const dots = engageDots(engage.data);
  fill(tabs, [['workout', 'Workout'], ...ENGAGE_TABS].map(([k, label]) => h('button', { type: 'button', class: 'eg-tab', 'aria-current': state.tab === k ? 'page' : null, onClick: () => show(k) },
    tabIcon(k), label, dots[k] ? [h('span', { class: 'eg-tab-dot', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, k === 'education' ? ' (new reading)' : ' (new message)')] : null)));
}
function show(tab) {
  state.tab = tab;
  drawTabs();
  window.scrollTo(0, 0);
  if (tab === 'workout') {
    if (!state.home) return load();
    render(state.home);
    // A check-in saved on another tab can change today's weights, so fetch again quietly.
    api('GET', '/app/api/home').then((home) => { if (state.tab === 'workout') render(home); }).catch(() => {});
    return;
  }
  const where = h('div', { class: 'eg-view' });
  fill(view, h('div', { class: 'row' }, h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), h('h1', { class: 'c-title grow', style: 'font-size:30px' }, ENGAGE_TABS.find(([k]) => k === tab)[1])), where);
  engage.render(where, tab);
}

async function load() {
  if (!tokenValue) return message('Open the link your coach sent you to see your workouts.');
  let home;
  try { home = await api('GET', '/app/api/home'); }
  catch (e) { return message(e.message); }
  fill(root, view, tabs);
  state.home = home;
  drawTabs();
  if (state.tab === 'workout') render(home);
  engage.load().then(() => { if (state.tab !== 'workout') show(state.tab); }).catch(() => {});
}

function message(text, extra) {
  fill(root, h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), h('div', { class: 'dp-panel' }, h('p', null, text), extra || null));
}

// How ready the athlete is today, from their daily check-in. Nothing shows when coaches turned it off.
function readinessCard(r) {
  if (!r) return null;
  if (!r.level) return h('div', { class: 'c-ready' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, r.headline), h('span', { class: 'small muted' }, r.advice)), btn('Check in', () => show('accountability'), 'secondary'));
  return h('div', { class: `c-ready c-ready--${r.level}`, role: 'status' },
    h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, r.headline),
      r.reasons.length ? h('span', { class: 'small' }, `From your check-in: ${r.reasons.join(', ').toLowerCase()}.`) : null,
      h('span', { class: 'small muted' }, r.advice)));
}

function render(home) {
  state.home = home;
  const top = [h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' })];
  if (home.locked || !home.workout) {
    fill(view, ...top, h('div', { class: 'c-title' }, `Hi ${home.client.first_name}`), h('div', { class: 'dp-panel' }, h('p', null, home.message)),
      h('p', { class: 'small muted' }, 'Check in, see your goals, results and lessons with the tabs below.'));
    return;
  }
  const w = home.workout;
  if (!state.playing || !w.exercises.some((x) => x.id === state.playing)) state.playing = w.exercises[0]?.id ?? null;
  const current = w.exercises.find((x) => x.id === state.playing);
  const pct = home.progress.total ? Math.round((home.progress.completed / home.progress.total) * 100) : 0;

  const rows = w.exercises.map((x) => h('div', { class: `dp-ex${x.id === state.playing ? ' dp-ex--current' : ''}` },
    h('button', { type: 'button', class: 'dp-ex-play', 'aria-label': `Watch ${x.name} demo`, onClick: () => { state.playing = x.id; render(home); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, playIcon()),
    h('div', { class: 'dp-ex-body' }, h('div', { class: 'dp-ex-name' }, x.name), h('div', { class: 'dp-ex-sets' }, x.prescription), x.load ? h('div', { class: `small ${x.load.missing ? 'muted' : 'strong'}`, style: x.load.missing ? null : `color:var(${x.load.planned_pct ? '--amber' : '--green-bright'})` }, x.load.text) : null),
    h('button', { type: 'button', class: 'dp-ex-log', 'aria-pressed': String(state.done.has(x.id)), 'aria-label': `${state.done.has(x.id) ? 'Logged' : 'Log'} ${x.name}`, onClick: (e) => {
      // Update in place so a playing video and typed notes are left alone.
      const on = !state.done.has(x.id);
      on ? state.done.add(x.id) : state.done.delete(x.id);
      e.currentTarget.setAttribute('aria-pressed', String(on));
      e.currentTarget.setAttribute('aria-label', `${on ? 'Logged' : 'Log'} ${x.name}`);
      e.currentTarget.textContent = on ? 'Done' : 'Log';
      count.textContent = `${state.done.size} of ${w.exercises.length} exercises logged`;
    } }, state.done.has(x.id) ? 'Done' : 'Log')));
  const count = h('div', { class: 'small muted', 'aria-live': 'polite' }, `${state.done.size} of ${w.exercises.length} exercises logged`);

  const notes = h('textarea', { class: 'dp-input', id: 'notes', placeholder: 'How did it feel? Anything your coach should know?', onInput: (e) => { state.notes = e.target.value; } });
  notes.value = state.notes || '';
  const finish = btn('Finish workout', (e) => busy(e.currentTarget, async () => {
    const r = await api('POST', `/app/api/workouts/${w.id}/complete`, { exercise_ids: [...state.done], notes: notes.value || undefined });
    state.done.clear(); state.playing = null; state.notes = '';
    state.home = r.next;
    engage.load().catch(() => {});
    fill(view, ...top,
      h('div', { class: 'dp-panel stack' }, h('div', { class: 'c-done' }, 'Workout logged'),
        h('p', { class: 'muted' }, 'Your coach can see it now.'),
        r.next.workout ? h('p', null, `Next up: ${r.next.workout.title}, week ${r.next.workout.week} day ${r.next.workout.day}.`) : h('p', null, r.next.message ?? ''),
        r.next.workout ? btn('See next workout', () => render(r.next), 'secondary') : null));
  }), 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:52px' });

  fill(view, ...top,
    h('div', { class: 'stack-tight' },
      h('div', { class: 'small muted' }, `Hi ${home.client.first_name}. Week ${w.week}, day ${w.day} of ${home.program.name}`),
      h('h1', { class: 'c-title' }, w.title)),
    h('div', { class: 'stack-tight' }, h('div', { class: 'c-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Program progress' }, h('div', { style: `width:${pct}%` })),
      h('div', { class: 'small muted' }, `${home.progress.completed} of ${home.progress.total} workouts done`)),
    readinessCard(home.readiness),
    current ? h('div', { class: 'stack' }, videoEmbed(current.video_url, current.name, 'Demo video coming soon. Follow the cues below.'), current.instructions ? h('p', { class: 'c-cue' }, h('span', { class: 'strong', style: 'color:var(--steel)' }, current.name + '. '), current.instructions) : null) : null,
    count,
    h('div', { class: 'stack', style: 'gap:8px' }, rows),
    h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: 'notes' }, 'Notes for your coach (optional)'), notes),
    finish);
}

load();
