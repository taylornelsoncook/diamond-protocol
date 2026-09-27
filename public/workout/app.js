// Athlete workout app (/w/:token). No sign-in: the private link is the key.
import { html, raw, mount, api, icon, toast, toastError, debounce, fmtDate, plural } from '/js/ui.js';
import { createEngage, engageDots, parseVideo, tabIcon, ENGAGE_TABS } from '/js/engage-view.js';

const root = document.getElementById('root');
const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/w/${encodeURIComponent(token)}`;
let s = null;          // state from the server
let selected = null;   // item id shown in the video frame
let finished = null;   // result of the last Finish workout, for the done screen

// ---- demo videos: YouTube / Vimeo embeds, or a video file (parseVideo is shared with the lesson reader) ----
function video(item) {
  const v = parseVideo(item?.video_url);
  const t = `Demo: ${item?.name || 'exercise'}`;
  if (!v) return html`<div class="wo-video">Demo video coming soon. Follow the cues below.</div>`;
  if (v.kind === 'youtube') return html`<div class="wo-video"><iframe src="https://www.youtube-nocookie.com/embed/${v.id}?rel=0&playsinline=1&modestbranding=1" title="${t}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
  if (v.kind === 'vimeo') return html`<div class="wo-video"><iframe src="https://player.vimeo.com/video/${v.id}?dnt=1&playsinline=1" title="${t}" allow="fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;
  return html`<div class="wo-video"><video src="${v.url}" controls playsinline preload="metadata" aria-label="${t}"></video></div>`;
}

const setsReps = (i) => [i.sets, i.reps].filter(Boolean).join(' × ');
const header = () => html`<img class="wo-mark" src="/img/mark-192.png" alt="Diamond Protocol">`;
const foot = html`<div class="wo-foot">Built under pressure</div>`;

function history() {
  if (!s.history?.length) return '';
  return html`<h2 class="wo-h2">Finished workouts</h2>
    <div class="wo-hist">${s.history.map((h) => html`<div>
      <span><span class="strong">${h.title}</span> <span class="muted">· week ${h.week}, day ${h.day}</span></span>
      <span class="muted" style="white-space:nowrap">${fmtDate(h.finished_at, { year: false })} · ${h.done}/${h.total}</span></div>`)}</div>`;
}

function progress() {
  const p = s.program;
  const pct = p.total_days ? Math.round((p.finished_days / p.total_days) * 100) : 0;
  return html`<div class="wo-prog"><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total_days}" aria-valuenow="${p.finished_days}" aria-label="Program progress"><span style="width:${pct}%"></span></div>
    <span class="muted">${p.finished_days} of ${plural(p.total_days, 'workout')} done</span></div>`;
}

function render() {
  if (!s.program) {
    mount(root, html`${header()}<h1 class="wo-title">No program yet</h1>
      <p class="wo-hi">Hi ${s.athlete.first_name}. Your coach hasn't assigned a program yet. When they do, it shows up here straight away.</p>${history()}${foot}`);
    return;
  }
  const first = s.athlete.first_name;
  if (finished) {
    const n = finished.next_up;
    mount(root, html`${header()}
      <p class="wo-hi">Week ${finished.finished.week}, day ${finished.finished.day} of ${s.program.name}</p>
      <h1 class="wo-title">${finished.finished.title}</h1>
      ${progress()}
      <div class="wo-done" role="status">
        <div class="icon">${icon('check', 26)}</div>
        <p><span class="strong">Workout logged.</span> Your coach can see it now.</p>
        <p class="muted">${finished.finished.done} of ${plural(finished.finished.total, 'exercise')} done.
          ${n ? html`Next up: <span class="strong" style="color:var(--steel)">${n.title}</span> on ${n.weekday}.` : 'That was the last workout in this program. Your coach will set up what comes next.'}</p>
        ${n ? html`<div><button class="btn" id="next">See next workout</button></div>` : ''}
      </div>
      ${history()}${foot}`);
    root.querySelector('#next')?.addEventListener('click', () => { finished = null; selected = null; render(); window.scrollTo(0, 0); });
    return;
  }
  if (!s.current) {
    mount(root, html`${header()}<p class="wo-hi">Hi ${first}. ${s.program.name}</p><h1 class="wo-title">Program complete</h1>${progress()}
      <p class="muted" style="margin:0">You finished every workout in ${s.program.name}. Your coach can see all of it and will set up what comes next.</p>${history()}${foot}`);
    return;
  }
  const c = s.current;
  const done = new Set(c.log.done);
  if (!c.items.some((i) => i.id === selected)) selected = (c.items.find((i) => !done.has(i.id)) || c.items[0])?.id ?? null;
  const sel = c.items.find((i) => i.id === selected);
  const cues = sel ? [sel.cues, sel.cue].filter(Boolean).join(' ') : '';
  mount(root, html`${header()}
    <div><p class="wo-hi">Hi ${first}. Week ${c.week}, day ${c.day} of ${s.program.name}</p>
    <h1 class="wo-title">${c.title}</h1></div>
    ${progress()}
    ${c.items.length ? html`
      ${video(sel)}
      ${sel ? html`<p class="wo-cue"><b>${sel.name}.</b> ${cues || 'Move with control and good posture.'}</p>` : ''}
      <p class="muted" style="margin:0" id="count">${done.size} of ${plural(c.items.length, 'exercise')} logged</p>
      <div class="wo-list">${c.items.map((i) => html`<div class="wo-ex ${done.has(i.id) ? 'done' : ''}" data-item="${i.id}" aria-current="${i.id === selected ? 'true' : 'false'}">
        <div class="wo-thumb" aria-hidden="true">${icon(done.has(i.id) ? 'check' : 'play', 18)}</div>
        <button type="button" class="grow" data-show="${i.id}" aria-label="Show demo and cues for ${i.name}"><span class="wo-name">${i.name}</span><span class="wo-sr">${setsReps(i)}</span></button>
        <button type="button" class="wo-log" data-log="${i.id}" aria-pressed="${done.has(i.id) ? 'true' : 'false'}" aria-label="${done.has(i.id) ? `${i.name} logged. Tap to undo` : `Log ${i.name}`}">${done.has(i.id) ? html`${icon('check', 16)}Done` : 'Log'}</button>
      </div>`)}</div>
      <div class="field"><label class="label" for="note">Notes for your coach (optional)</label>
        <textarea class="input" id="note" rows="3" maxlength="2000" placeholder="How did it feel? Anything your coach should know?">${c.log.note}</textarea></div>
      <button class="btn btn-primary btn-block wo-finish" id="finish">Finish workout</button>`
      : html`<p class="muted">Your coach is still adding exercises to this workout. Check back soon.</p>`}
    ${history()}${foot}`);

  root.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => { selected = Number(b.dataset.show); render(); }));
  root.querySelectorAll('[data-log]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = Number(b.dataset.log);
    const now = !done.has(id);
    const nv = root.querySelector('#note')?.value;
    if (nv != null) c.log.note = nv; // keep what's typed across the re-render
    // Optimistic: flip it straight away, then save.
    c.log.done = now ? [...c.log.done, id] : c.log.done.filter((x) => x !== id);
    if (now && id === selected) selected = (c.items.find((i) => !c.log.done.includes(i.id)) || {}).id ?? selected;
    render();
    try {
      const r = await api.post(`${base}/log`, { day_id: c.day_id, item_id: id, done: now, note: root.querySelector('#note')?.value });
      c.log.done = r.done;
      render();
    } catch (err) { await handle(err); }
  }));
  const note = root.querySelector('#note');
  note?.addEventListener('input', debounce(async () => {
    c.log.note = note.value;
    try { await api.post(`${base}/log`, { day_id: c.day_id, note: note.value }); } catch (err) { await handle(err); }
  }, 700));
  root.querySelector('#finish')?.addEventListener('click', async (e) => {
    if (!c.log.done.length) { toast('Tap Log on each exercise as you finish it, then Finish workout.', 'warn'); return; }
    e.target.disabled = true;
    try {
      finished = await api.post(`${base}/finish`, { day_id: c.day_id, note: note?.value ?? '' });
      s = finished.state;
      render();
      window.scrollTo(0, 0);
    } catch (err) { e.target.disabled = false; await handle(err); }
  });
}

async function handle(err) {
  toastError(err);
  if (err.status === 409 || err.status === 400) { await load(); }
}

async function load() {
  try {
    s = await api.get(base, { noRedirect: true });
    render();
  } catch (err) {
    mount(root, html`${header()}<h1 class="wo-title">${err.status === 404 ? 'Link not found' : 'Not loaded'}</h1>
      <p class="muted" style="margin:0">${err.status === 404 ? "This workout link doesn't work. Ask your coach to send your link again." : "We couldn't load your workout. Check your connection and try again."}</p>
      ${err.status === 404 ? '' : html`<div><button class="btn" id="retry">Try again</button></div>`}${foot}`);
    root.querySelector('#retry')?.addEventListener('click', load);
  }
}

// ---- tabs: Workout | Accountability | Performance | Education ----
const engageEl = document.getElementById('engage');
const tabbar = document.getElementById('tabbar');
const TABS = [{ id: 'workout', label: 'Workout', icon: 'workout' }, ...ENGAGE_TABS];
const tabFromHash = () => { const h = location.hash.slice(1); return TABS.some((t) => t.id === h) ? h : 'workout'; };
let tab = tabFromHash();
const view = createEngage({ base, audience: 'athlete', onData: () => paintTabbar() });

function paintTabbar() {
  if (!view.data) return;
  const dots = engageDots(view.data);
  tabbar.hidden = false;
  document.body.classList.add('eg-has-tabbar');
  mount(tabbar, html`<div class="eg-tabbar-in">${TABS.map((t) => html`<button type="button" class="eg-tab" data-tab="${t.id}" ${t.id === tab ? raw('aria-current="page"') : ''}>
    ${tabIcon(t.icon)}<span>${t.label}</span>${dots[t.id] ? html`<span class="eg-dot" aria-hidden="true"></span><span class="sr-only">${t.id === 'education' ? ', something assigned' : ', new message'}</span>` : ''}</button>`)}</div>`);
}
function showTab() {
  const onWorkout = tab === 'workout' || !view.data;
  root.hidden = !onWorkout;
  engageEl.hidden = onWorkout;
  if (!onWorkout) {
    const t = TABS.find((x) => x.id === tab);
    mount(engageEl, html`${header()}<div><p class="wo-hi">${view.data.athlete.first_name} ${view.data.athlete.last_name}</p><h1 class="eg-title">${t.label}</h1></div>
      <div class="eg-view" id="eg-body"></div>${foot}`);
    view.render(engageEl.querySelector('#eg-body'), tab);
  }
  paintTabbar();
}
tabbar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  const same = b.dataset.tab === tab;
  tab = b.dataset.tab;
  if (same) view.closeReader();
  window.history.replaceState(null, '', tab === 'workout' ? location.pathname + location.search : `#${tab}`);
  showTab();
  window.scrollTo(0, 0);
  // Pick up anything that changed since (a finished workout, a new message) without losing a half-filled form.
  if (tab !== 'workout') { const t = tab; view.load().then(() => { if (tab === t && !view.busy()) showTab(); }).catch(() => {}); }
});
async function loadEngage() {
  try { await view.load(); showTab(); } catch { /* link not found or offline: the workout screen explains */ }
}

// Come back to the tab later (e.g. the next day) and it shows the latest.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (s && !finished) load();
  if (view.data) view.load().then(() => { if (tab !== 'workout' && !view.busy()) showTab(); }).catch(() => {});
});
load();
loadEngage();
