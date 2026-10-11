import { h, fill, btn } from './ui.js';

// The athlete's timeline (the builder redesign, step 5): everything they did, newest first, one line each, filtered
// by kind, with Load more. One block for the client page (Timeline tab), the athlete app (Profile tab) and the
// parent portal (the Timeline sub-tab). get(path) fetches `${path}?kind=&before=&limit=`; linkFor(item) may answer
// an href for a line (the client page links logs, results and clips to their tabs).
const when = (iso) => {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
};
const ICONS = { workout: '▣', result: '⏱', max: '▲', sprint: '»', form_check: '▶', checkin: '✓', attendance: '◉', badge: '◆', reading: '▤', step: '↑', purchase: '$' };

export function timelineBlock(get, path, { linkFor = null, pageSize = 30, empty = 'Nothing here yet. Workouts, results, check-ins and more land here as they happen.' } = {}) {
  const state = { kind: '', next: null, items: [] };
  const chips = h('div', { class: 'row wrap tl-chips', role: 'group', 'aria-label': 'Show' });
  const list = h('div', { class: 'tl-list' });
  const foot = h('div', { class: 'row', style: 'justify-content:center' });
  const note = h('p', { class: 'muted small' });
  let kinds = null;
  const q = (before) => `${path}${path.includes('?') ? '&' : '?'}limit=${pageSize}${state.kind ? `&kind=${state.kind}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
  const line = (it) => {
    const href = linkFor?.(it);
    const head = href ? h('a', { href, class: 'strong', style: 'color:inherit' }, it.text) : h('span', { class: 'strong' }, it.text);
    return h('div', { class: `tl-item tl-item--${it.kind}` },
      h('span', { class: 'tl-icon', 'aria-hidden': 'true' }, ICONS[it.kind] ?? '•'),
      h('div', { class: 'grow stack-tight', style: 'gap:2px;min-width:0' }, head, it.detail ? h('span', { class: 'small muted' }, it.detail) : null),
      h('time', { class: 'small muted tl-when', datetime: it.at, title: new Date(it.at).toLocaleString('en-US') }, it.day ? when(`${it.day}T12:00:00`) : when(it.at)));
  };
  const drawChips = () => {
    if (!kinds) return;
    fill(chips, [['', 'Everything'], ...kinds.map((k) => [k.key, k.label])].map(([k, label]) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(state.kind === k), onClick: () => { if (state.kind === k) return; state.kind = k; load(); } }, label)));
  };
  const draw = () => {
    fill(list, state.items.length ? state.items.map(line) : h('p', { class: 'muted small', style: 'margin:8px 0' }, state.kind ? 'Nothing of that kind yet.' : empty));
    fill(foot, state.next ? btn('Load more', (e) => { e.currentTarget.disabled = true; more().finally(() => { e.currentTarget.disabled = false; }); }, 'ghost') : null);
  };
  async function load() {
    drawChips();
    fill(list, h('p', { class: 'muted small' }, 'Loading…')); fill(foot); fill(note);
    try {
      const r = await get(q());
      kinds = r.kinds; state.items = r.data; state.next = r.next;
      drawChips(); draw();
    } catch (e) { fill(list, h('p', { class: 'warn-text small' }, e.message || 'Couldn\'t load the timeline.')); }
  }
  async function more() {
    try { const r = await get(q(state.next)); state.items = state.items.concat(r.data); state.next = r.next; draw(); }
    catch (e) { fill(note, e.message || 'Couldn\'t load more.'); }
  }
  load();
  const el = h('div', { class: 'tl stack', style: 'gap:12px' }, chips, list, foot, note);
  el.reload = load;
  return el;
}
