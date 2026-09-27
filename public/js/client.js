import { h, fill, toast, busy, videoEmbed, playIcon, btn } from './ui.js';

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

const state = { done: new Set(), playing: null, notes: '' };

async function load() {
  if (!tokenValue) return message('Open the link your coach sent you to see your workouts.');
  try { render(await api('GET', '/app/api/home')); }
  catch (e) { message(e.message); }
}

function message(text, extra) {
  fill(root, h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), h('div', { class: 'dp-panel' }, h('p', null, text), extra || null));
}

function render(home) {
  const top = [h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' })];
  if (home.locked || !home.workout) {
    fill(root, ...top, h('div', { class: 'c-title' }, `Hi ${home.client.first_name}`), h('div', { class: 'dp-panel' }, h('p', null, home.message)));
    return;
  }
  const w = home.workout;
  if (!state.playing || !w.exercises.some((x) => x.id === state.playing)) state.playing = w.exercises[0]?.id ?? null;
  const current = w.exercises.find((x) => x.id === state.playing);
  const pct = home.progress.total ? Math.round((home.progress.completed / home.progress.total) * 100) : 0;

  const rows = w.exercises.map((x) => h('div', { class: `dp-ex${x.id === state.playing ? ' dp-ex--current' : ''}` },
    h('button', { type: 'button', class: 'dp-ex-play', 'aria-label': `Watch ${x.name} demo`, onClick: () => { state.playing = x.id; render(home); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, playIcon()),
    h('div', { class: 'dp-ex-body' }, h('div', { class: 'dp-ex-name' }, x.name), h('div', { class: 'dp-ex-sets' }, x.prescription)),
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
    fill(root, ...top,
      h('div', { class: 'dp-panel stack' }, h('div', { class: 'c-done' }, 'Workout logged'),
        h('p', { class: 'muted' }, 'Your coach can see it now.'),
        r.next.workout ? h('p', null, `Next up: ${r.next.workout.title}, week ${r.next.workout.week} day ${r.next.workout.day}.`) : h('p', null, r.next.message ?? ''),
        r.next.workout ? btn('See next workout', () => render(r.next), 'secondary') : null));
  }), 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:52px' });

  fill(root, ...top,
    h('div', { class: 'stack-tight' },
      h('div', { class: 'small muted' }, `Hi ${home.client.first_name}. Week ${w.week}, day ${w.day} of ${home.program.name}`),
      h('h1', { class: 'c-title' }, w.title)),
    h('div', { class: 'stack-tight' }, h('div', { class: 'c-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Program progress' }, h('div', { style: `width:${pct}%` })),
      h('div', { class: 'small muted' }, `${home.progress.completed} of ${home.progress.total} workouts done`)),
    current ? h('div', { class: 'stack' }, videoEmbed(current.video_url, current.name, 'Demo video coming soon. Follow the cues below.'), current.instructions ? h('p', { class: 'c-cue' }, h('span', { class: 'strong', style: 'color:var(--steel)' }, current.name + '. '), current.instructions) : null) : null,
    count,
    h('div', { class: 'stack', style: 'gap:8px' }, rows),
    h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: 'notes' }, 'Notes for your coach (optional)'), notes),
    finish);
}

load();
