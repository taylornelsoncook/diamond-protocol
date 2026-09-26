// Programs: program list, exercise library (cues + demo videos) and the week-by-week program builder.
import { html, raw, mount, api, icon, toast, toastError, modal, confirmDialog, formData, options, debounce, fmtDate, plural, fullName } from '/js/ui.js';

const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Ages 10–14', 'Ages 15–18'];
const canEdit = (ctx) => ctx.me.role === 'owner' || ctx.me.role === 'coach';

const STYLE = html`<style>
.dpo-layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:var(--space-6);align-items:start}
@media (max-width:1100px){.dpo-layout{grid-template-columns:1fr}}
.dpo-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:var(--space-4)}
.dpo-card{text-decoration:none;color:inherit;gap:6px;padding:var(--space-4) var(--space-6) var(--space-6)}
.dpo-card:hover{border-color:var(--control-border);background:var(--surface-raised);color:inherit}
.dpo-card-title{font:700 20px/1.1 var(--font-display);letter-spacing:.06em;text-transform:uppercase;color:var(--steel);margin-top:6px}
.dpo-meta{font-size:13px;line-height:18px;color:var(--steel-muted)}
.dpo-thumb{width:44px;height:44px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;background:var(--black);border:1px solid var(--line-subtle);border-radius:var(--radius-sm);color:var(--steel);cursor:pointer;padding:0}
.dpo-thumb:hover{border-color:var(--green-mid)}
.dpo-thumb.has{color:var(--green-bright)}
.dpo-lib .list-row{padding:8px 0}
.dpo-name{font-weight:600;color:var(--steel);overflow-wrap:anywhere}
.dpo-week-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap;margin-top:var(--space-2)}
.dpo-week-title{font:700 22px/1 var(--font-display);letter-spacing:.06em;text-transform:uppercase}
.dpo-days{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:var(--space-4)}
.dpo-day{padding:var(--space-4);gap:var(--space-2)}
.dpo-day-label{font-size:12px;color:var(--steel-muted);line-height:16px}
.dpo-day-title{font-weight:600;font-size:15px;background:none;border:0;padding:0;text-align:left;color:var(--steel);cursor:default}
.dpo-day-title.edit{cursor:pointer}.dpo-day-title.edit:hover{text-decoration:underline;text-decoration-color:var(--steel-muted)}
.dpo-item{display:flex;align-items:center;gap:10px;padding:6px 0}
.dpo-item .grow{flex:1;min-width:0}
.dpo-item-name{background:none;border:0;padding:0;text-align:left;font-size:15px;color:var(--steel);cursor:default;line-height:20px}
.dpo-item-name.edit{cursor:pointer}.dpo-item-name.edit:hover{text-decoration:underline;text-decoration-color:var(--steel-muted)}
.dpo-item-tools{display:flex;align-items:center}
.dpo-item-tools .btn{min-height:32px;padding:0 6px}
.dpo-add{border-top:1px solid var(--line);padding-top:var(--space-3);display:flex;flex-direction:column;gap:var(--space-2)}
.dpo-add-row{display:grid;grid-template-columns:1fr auto 1fr;gap:6px;align-items:center}
.dpo-x{color:var(--steel-muted)}
.dpo-picker{position:relative;min-width:240px}
.dpo-results{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:20;background:var(--surface);border:1px solid var(--control-border);border-radius:var(--radius-sm);max-height:280px;overflow:auto}
.dpo-results button{display:block;width:100%;text-align:left;background:none;border:0;padding:10px 12px;cursor:pointer;min-height:44px}
.dpo-results button:hover,.dpo-results button:focus{background:var(--surface-raised)}
.dpo-video{position:relative;aspect-ratio:16/9;background:var(--black);border-radius:var(--radius-sm);overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--steel-muted);text-align:center;padding:0}
.dpo-video iframe,.dpo-video video{position:absolute;inset:0;width:100%;height:100%;border:0}
.dpo-np{grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)}.dpo-aw{grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,2fr)}
@media (max-width:600px){.dpo-np,.dpo-aw{grid-template-columns:1fr 1fr}.dpo-np>:first-child,.dpo-aw>:last-child{grid-column:1/-1}.dpo-picker{min-width:0;flex:1}}
.dpo-foot{display:flex;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}
</style>`;

// ---- demo video links (mirrors server/services/ops-video.js) ----
export function parseVideo(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/); if (m) id = m[1]; }
    return id && /^[\w-]{6,20}$/.test(id) ? { kind: 'youtube', id } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') { const m = u.pathname.match(/(?:^|\/)(\d{5,12})(?:\/|$)/); return m ? { kind: 'vimeo', id: m[1] } : null; }
  if (/\.(mp4|m4v|webm|mov|ogv)$/i.test(u.pathname)) return { kind: 'file', url: s };
  return null;
}
const VIDEO_LABEL = { youtube: 'YouTube video', vimeo: 'Vimeo video', file: 'Video file' };
const videoLabel = (url) => { const v = parseVideo(url); return v ? VIDEO_LABEL[v.kind] : 'No video yet'; };
export function videoFrame(url, title = 'Demo video') {
  const v = parseVideo(url);
  if (!v) return html`<div class="dpo-video"><span>No demo video yet. Follow the cues.</span></div>`;
  if (v.kind === 'youtube') return html`<div class="dpo-video"><iframe src="https://www.youtube-nocookie.com/embed/${v.id}?rel=0&playsinline=1" title="${title}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  if (v.kind === 'vimeo') return html`<div class="dpo-video"><iframe src="https://player.vimeo.com/video/${v.id}?dnt=1" title="${title}" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
  return html`<div class="dpo-video"><video src="${v.url}" controls playsinline preload="metadata" aria-label="${title}"></video></div>`;
}
const thumb = (ex, attrs = '') => html`<button type="button" class="dpo-thumb ${parseVideo(ex.video_url) ? 'has' : ''}" data-preview="${ex.exercise_id || ex.id}" aria-label="Play demo: ${ex.name}" ${raw(attrs)}>${icon('play', 16)}</button>`;
const setsReps = (i) => [i.sets, i.reps].filter(Boolean).join(' × ');

function previewExercise(ex) {
  return modal({
    title: ex.name, wide: true,
    body: html`${videoFrame(ex.video_url, ex.name)}${ex.cues ? html`<p style="margin:0"><span class="strong">Cues.</span> <span class="muted">${ex.cues}</span></p>` : ''}`,
  });
}

function exerciseForm(ex = {}) {
  return html`<form class="stack" id="exf" novalidate>
    <div class="field"><label class="label" for="exn">Exercise name</label><input class="input" id="exn" name="name" value="${ex.name || ''}" required maxlength="80"></div>
    <div class="field"><label class="label" for="exv">Demo video link</label><input class="input" id="exv" name="video_url" value="${ex.video_url || ''}" placeholder="https://youtube.com/watch?v=…" inputmode="url">
      <span class="hint">YouTube, Vimeo or a direct link to a video file (.mp4, .webm, .mov).</span></div>
    <div class="field"><label class="label" for="exc">Coaching cues</label><textarea class="input" id="exc" name="cues" rows="3" maxlength="500" placeholder="One or two coaching cues">${ex.cues || ''}</textarea></div>
  </form>`;
}

async function editExercise(ex, ctx) {
  const actions = [{ label: 'Cancel', value: null }];
  if (!ex.uses) actions.unshift({ label: 'Delete', kind: 'ghost', onClick: async () => {
    if (!(await confirmDialog('Delete exercise', `Delete ${ex.name} from the library?`, 'Delete exercise', 'warn'))) return false;
    await api.del(`/exercises/${ex.id}`); toast(`${ex.name} deleted.`); return 'deleted';
  } });
  actions.push({ label: 'Save exercise', kind: 'primary', onClick: async (body) => {
    await api.put(`/exercises/${ex.id}`, formData(body.querySelector('form'))); toast('Exercise saved.'); return 'saved';
  } });
  const r = await modal({ title: 'Edit exercise', body: exerciseForm(ex), actions });
  if (r) ctx.reload();
}

// ======================= Programs list + exercise library =======================
async function renderList(ctx) {
  const [programs, exercises] = await Promise.all([api.get('/programs'), api.get('/exercises')]);
  if (!ctx.isCurrent()) return;
  const edit = canEdit(ctx);
  mount(ctx.el, html`${STYLE}
  <div class="page-header"><div><h1 class="page-title">Programs</h1><p class="page-sub">Build training, attach demo videos and assign to clients.</p></div></div>
  ${!edit ? html`<div class="banner info">Front desk can view programs. An owner or coach makes changes.</div>` : ''}
  <div class="dpo-layout">
    <div class="stack">
      ${programs.length ? html`<div class="dpo-cards">${programs.map((p) => html`<a class="panel dpo-card" href="/app/programs/${p.id}">
        <span class="dpo-card-title">${p.name}</span>
        <span class="dpo-meta">${[plural(p.weeks, 'week'), p.level, plural(p.workouts, 'workout'), plural(p.clients, 'client')].filter(Boolean).join(' · ')}</span></a>`)}</div>`
        : html`<div class="empty">No programs yet.${edit ? ' Create your first one below.' : ''}</div>`}
      ${edit ? html`<form class="panel" id="newp" novalidate>
        <h2 class="panel-title">New program</h2>
        <div class="form-grid dpo-np">
          <div class="field"><label class="label" for="pn">Program name</label><input class="input" id="pn" name="name" maxlength="80" required></div>
          <div class="field"><label class="label" for="pw">Weeks</label><input class="input" id="pw" name="weeks" type="number" min="1" max="52" value="8"></div>
          <div class="field"><label class="label" for="pl">Level</label><select class="input" id="pl" name="level">${LEVELS.map((l) => html`<option>${l}</option>`)}</select></div>
        </div>
        <div><button class="btn btn-primary">Create program</button></div>
      </form>` : ''}
    </div>
    <section class="panel dpo-lib" aria-labelledby="libt">
      <div><h2 class="panel-title" id="libt">Exercise library</h2><p class="panel-sub">${plural(exercises.length, 'exercise')}</p></div>
      <div class="list">${exercises.map((e) => html`<div class="list-row">
        ${thumb(e)}
        <div class="grow"><div class="dpo-name">${e.name}</div><div class="dpo-meta">${videoLabel(e.video_url)}</div></div>
        ${edit ? html`<button class="btn btn-ghost btn-sm" data-edit="${e.id}" aria-label="Edit ${e.name}">Edit</button>` : ''}
      </div>`)}</div>
      ${edit ? html`<form class="stack" id="newex" novalidate style="border-top:1px solid var(--line);padding-top:var(--space-4);gap:var(--space-3)">
        <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:var(--space-3)">
          <div class="field"><label class="label" for="en">Exercise name</label><input class="input" id="en" name="name" maxlength="80" required></div>
          <div class="field"><label class="label" for="ev">Demo video link</label><input class="input" id="ev" name="video_url" placeholder="https://youtube.com/…" inputmode="url"></div>
          <span class="hint span-2">YouTube, Vimeo or a direct .mp4 link.</span>
        </div>
        <div class="field"><label class="label" for="ec">Coaching cues</label><input class="input" id="ec" name="cues" maxlength="500" placeholder="One or two coaching cues"></div>
        <div><button class="btn">Add exercise</button></div>
      </form>` : ''}
    </section>
  </div>`);

  const byId = Object.fromEntries(exercises.map((e) => [e.id, e]));
  ctx.el.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', () => previewExercise(byId[b.dataset.preview])));
  ctx.el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editExercise(byId[b.dataset.edit], ctx)));
  const np = ctx.el.querySelector('#newp');
  if (np) np.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api.post('/programs', formData(np)); toast('Program created. Add its first workout.'); ctx.go(`/app/programs/${r.id}`); }
    catch (err) { toastError(err); }
  });
  const nx = ctx.el.querySelector('#newex');
  if (nx) nx.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api.post('/exercises', formData(nx)); toast(`${r.name} added to the library.`); ctx.reload(); }
    catch (err) { toastError(err); }
  });
}

// ======================= Program builder =======================
function athletePicker() {
  return html`<div class="dpo-picker">
    <label class="sr-only" for="apick">Find a client</label>
    <input class="input" id="apick" type="search" placeholder="Find a client by name or ID" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="apick-list">
    <div class="dpo-results" id="apick-list" role="listbox" hidden></div>
  </div>`;
}

function dayPanel(d, ctx, exercises) {
  const edit = canEdit(ctx);
  return html`<section class="panel dpo-day" data-day="${d.id}">
    <div class="spread" style="align-items:flex-start">
      <div><div class="dpo-day-label">Day ${d.day}</div>
        <button type="button" class="dpo-day-title ${edit ? 'edit' : ''}" ${edit ? raw(`data-rename="${d.id}"`) : raw('tabindex="-1"')}>${d.title || `Day ${d.day}`}</button></div>
      ${edit ? html`<button class="btn btn-ghost btn-sm" data-delday="${d.id}">Delete</button>` : ''}
    </div>
    ${d.items.length ? html`<div class="list">${d.items.map((it, n) => html`<div class="dpo-item">
      ${thumb(it)}
      <div class="grow">
        <button type="button" class="dpo-item-name ${edit ? 'edit' : ''}" ${edit ? raw(`data-edititem="${it.id}"`) : raw('tabindex="-1"')}>${it.name}</button>
        <div class="dpo-meta">${setsReps(it)}${it.cue ? html` · ${it.cue}` : ''}</div>
      </div>
      ${edit ? html`<div class="dpo-item-tools">
        <button class="btn btn-ghost btn-sm" data-move="${it.id}" data-dir="-1" aria-label="Move ${it.name} up" ${n === 0 ? raw('disabled') : ''}>↑</button>
        <button class="btn btn-ghost btn-sm" data-move="${it.id}" data-dir="1" aria-label="Move ${it.name} down" ${n === d.items.length - 1 ? raw('disabled') : ''}>↓</button>
        <button class="btn btn-ghost btn-sm" data-rmitem="${it.id}">Remove</button></div>` : ''}
    </div>`)}</div>` : html`<p class="muted small" style="margin:0">No exercises yet.</p>`}
    ${edit ? html`<form class="dpo-add" data-additem="${d.id}" novalidate>
      <label class="sr-only" for="ex-${d.id}">Exercise</label>
      <select class="input" id="ex-${d.id}" name="exercise_id">${options(exercises, '', { blank: 'Choose exercise' })}</select>
      <div class="dpo-add-row">
        <input class="input" name="sets" placeholder="Sets, e.g. 3" aria-label="Sets" maxlength="20">
        <span class="dpo-x" aria-hidden="true">×</span>
        <input class="input" name="reps" placeholder="Reps, e.g. 10" aria-label="Reps" maxlength="40">
      </div>
      <input class="input" name="cue" placeholder="Cue for this workout (optional)" aria-label="Cue" maxlength="300">
      <button class="btn">Add exercise</button>
    </form>` : ''}
  </section>`;
}

async function renderBuilder(ctx) {
  const id = ctx.params.id;
  const [p, exercises] = await Promise.all([api.get(`/programs/${id}`), api.get('/exercises')]);
  if (!ctx.isCurrent()) return;
  const edit = canEdit(ctx);
  const weeks = Array.from({ length: p.weeks_shown }, (_, i) => i + 1);
  const byWeek = (w) => p.days.filter((d) => d.week === w);
  const nextWeek = p.days.reduce((m, d) => Math.max(m, d.week), 0) || 1;
  const on = p.athletes.map((a) => a.first_name);

  mount(ctx.el, html`${STYLE}
  <div class="page-header">
    <div><a class="crumb" href="/app/programs">Programs</a><h1 class="page-title">${p.name}</h1>
      <p class="page-sub">${[plural(p.weeks, 'week'), p.level].filter(Boolean).join(' · ')}${on.length ? ` · On it: ${on.join(', ')}` : ' · No clients on it yet'}</p>
      ${p.description ? html`<p class="page-sub small">${p.description}</p>` : ''}</div>
    ${edit ? html`<div class="row">${athletePicker()}<button class="btn btn-primary" id="assign" disabled>Assign program</button></div>` : ''}
  </div>
  ${weeks.map((w) => {
    const days = byWeek(w);
    return html`<section class="stack" aria-labelledby="wk${w}" style="gap:var(--space-3)">
      <div class="dpo-week-head"><h2 class="dpo-week-title" id="wk${w}">Week ${w}</h2>
        ${edit ? html`<div class="btn-row">
          <button class="btn btn-ghost btn-sm" data-addday="${w}">Add day</button>
          ${days.length ? html`<button class="btn btn-ghost btn-sm" data-copy="${w}">Copy to week ${w + 1}</button>` : ''}</div>` : ''}</div>
      ${days.length ? html`<div class="dpo-days">${days.map((d) => dayPanel(d, ctx, exercises))}</div>`
        : html`<div class="empty">No workouts in week ${w} yet.${edit && w > 1 && byWeek(w - 1).length ? html` <button class="btn btn-sm" data-copy="${w - 1}" style="margin-left:8px">Copy week ${w - 1} here</button>` : ''}</div>`}
    </section>`;
  })}
  <div class="grid-2">
    ${edit ? html`<form class="panel" id="addw" novalidate>
      <h2 class="panel-title">Add a workout</h2>
      <div class="form-grid dpo-aw">
        <div class="field"><label class="label" for="aw-w">Week</label><input class="input" id="aw-w" name="week" type="number" min="1" max="52" value="${nextWeek}"></div>
        <div class="field"><label class="label" for="aw-d">Day</label><input class="input" id="aw-d" name="day" type="number" min="1" max="7" placeholder="Next"></div>
        <div class="field"><label class="label" for="aw-t">Workout title</label><input class="input" id="aw-t" name="title" placeholder="Lower body" maxlength="60"></div>
      </div>
      <div><button class="btn">Add workout</button></div>
    </form>` : ''}
    <section class="panel">
      <h2 class="panel-title">Clients on this program</h2>
      ${p.athletes.length ? html`<div class="list">${p.athletes.map((a) => html`<div class="list-row">
        <div class="grow"><a href="/app/clients/${a.id}" class="strong" style="color:var(--steel);text-decoration:none">${fullName(a)}</a>
          <div class="dpo-meta">${a.code}${a.program_started ? ` · started ${fmtDate(a.program_started)}` : ''}</div></div>
        ${a.workout_token ? html`<a class="btn btn-ghost btn-sm" href="/w/${a.workout_token}" target="_blank" rel="noopener">Workout app</a>` : ''}
        ${edit ? html`<button class="btn btn-ghost btn-sm" data-unassign="${a.id}" data-name="${fullName(a)}">Remove</button>` : ''}
      </div>`)}</div>` : html`<p class="muted" style="margin:0">${edit ? 'Find a client at the top and assign this program. It shows in their workout app straight away.' : 'Nobody is on this program yet.'}</p>`}
    </section>
  </div>
  <div class="dpo-foot"><a class="btn btn-ghost" href="/app/programs">All programs</a>
    ${edit ? html`<div class="btn-row"><button class="btn btn-ghost" id="editp">Edit details</button><button class="btn btn-ghost" id="delp">Delete program</button></div>` : ''}</div>`);

  const el = ctx.el;
  const items = Object.fromEntries(p.days.flatMap((d) => d.items.map((i) => [i.id, { ...i, day: d }])));
  const exById = Object.fromEntries(exercises.map((e) => [e.id, e]));
  // Re-render in place without jumping to the top.
  const refresh = async () => { const y = window.scrollY; await renderBuilder(ctx); window.scrollTo(0, y); };
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); await refresh(); } catch (err) { toastError(err); } };

  el.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', () => previewExercise(exById[b.dataset.preview])));
  if (!edit) return;

  // Assign: search clients, pick one, assign.
  const pick = el.querySelector('#apick'), list = el.querySelector('#apick-list'), assignBtn = el.querySelector('#assign');
  let chosen = null;
  const close = () => { list.hidden = true; pick.setAttribute('aria-expanded', 'false'); };
  const search = debounce(async () => {
    const q = pick.value.trim();
    chosen = null; assignBtn.disabled = true;
    if (q.length < 2) return close();
    try {
      const rows = await api.get('/athletes/search?q=' + encodeURIComponent(q));
      mount(list, rows.length ? rows.map((a) => html`<button type="button" role="option" data-aid="${a.id}" data-label="${fullName(a)}">${fullName(a)} <span class="muted small">${a.code}${a.sport ? ` · ${a.sport}` : ''}</span></button>`)
        : html`<div class="muted small" style="padding:10px 12px">No clients match.</div>`);
      list.hidden = false; pick.setAttribute('aria-expanded', 'true');
    } catch (err) { toastError(err); }
  }, 200);
  pick.addEventListener('input', search);
  pick.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowDown') list.querySelector('button')?.focus(); });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input while choosing
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-aid]'); if (!b) return;
    chosen = { id: Number(b.dataset.aid), name: b.dataset.label };
    pick.value = chosen.name; assignBtn.disabled = false; close(); assignBtn.focus();
  });
  el.querySelector('.dpo-picker').addEventListener('focusout', (e) => { if (!e.relatedTarget || !e.relatedTarget.closest('.dpo-picker')) setTimeout(close, 120); });
  assignBtn.addEventListener('click', () => act(async () => {
    if (!chosen) throw new Error('Find and choose a client first.');
    await api.post(`/programs/${p.id}/assign`, { athlete_id: chosen.id });
  }, chosen ? `${p.name} assigned to ${chosen?.name}. It's in their workout app now.` : null));

  el.querySelectorAll('[data-unassign]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Remove from program', `Take ${b.dataset.name} off ${p.name}? Their finished workouts stay in their history.`, 'Remove'))) return;
    act(() => api.post(`/programs/${p.id}/unassign`, { athlete_id: Number(b.dataset.unassign) }), `${b.dataset.name} removed from ${p.name}.`);
  }));

  // Items
  el.querySelectorAll('form[data-additem]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(f);
    if (!d.exercise_id) return toastError(new Error('Choose an exercise first.'));
    act(() => api.post(`/program-days/${f.dataset.additem}/items`, d), 'Exercise added.');
  }));
  el.querySelectorAll('[data-rmitem]').forEach((b) => b.addEventListener('click', () => act(() => api.del(`/program-items/${b.dataset.rmitem}`), 'Exercise removed.')));
  el.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => act(() => api.post(`/program-items/${b.dataset.move}/move`, { dir: Number(b.dataset.dir) }))));
  el.querySelectorAll('[data-edititem]').forEach((b) => b.addEventListener('click', async () => {
    const it = items[b.dataset.edititem];
    const r = await modal({
      title: it.name,
      body: html`<form class="stack" novalidate>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="field"><label class="label" for="is">Sets</label><input class="input" id="is" name="sets" value="${it.sets || ''}" maxlength="20"></div>
          <div class="field"><label class="label" for="ir">Reps</label><input class="input" id="ir" name="reps" value="${it.reps || ''}" maxlength="40"></div>
        </div>
        <div class="field"><label class="label" for="ic">Cue for this workout</label><input class="input" id="ic" name="cue" value="${it.cue || ''}" maxlength="300" placeholder="Optional. Adds to the library cues."></div>
        ${it.cues ? html`<p class="hint" style="margin:0">Library cues: ${it.cues}</p>` : ''}
      </form>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', onClick: async (body) => { await api.put(`/program-items/${it.id}`, formData(body.querySelector('form'))); return true; } }],
    });
    if (r) { toast('Saved.'); refresh(); }
  }));

  // Days
  el.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', async () => {
    const d = p.days.find((x) => x.id === Number(b.dataset.rename));
    const r = await modal({
      title: 'Rename workout',
      body: html`<form novalidate><div class="field"><label class="label" for="rt">Workout title</label><input class="input" id="rt" name="title" value="${d.title || ''}" maxlength="60"></div></form>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', onClick: async (body) => { await api.put(`/program-days/${d.id}`, formData(body.querySelector('form'))); return true; } }],
    });
    if (r) refresh();
  }));
  el.querySelectorAll('[data-delday]').forEach((b) => b.addEventListener('click', async () => {
    const d = p.days.find((x) => x.id === Number(b.dataset.delday));
    const extra = d.logs ? ` ${plural(d.logs, 'athlete log')} for it will be removed too.` : '';
    if (!(await confirmDialog('Delete workout', `Delete week ${d.week}, day ${d.day} (${d.title || 'untitled'})?${extra}`, 'Delete workout', 'warn'))) return;
    act(() => api.del(`/program-days/${d.id}`), 'Workout deleted.');
  }));
  const addDay = async (week, title, day) => api.post(`/programs/${p.id}/days`, { week, title, day });
  el.querySelectorAll('[data-addday]').forEach((b) => b.addEventListener('click', async () => {
    const w = Number(b.dataset.addday);
    const r = await modal({
      title: `Add a day to week ${w}`,
      body: html`<form novalidate><div class="field"><label class="label" for="nd">Workout title</label><input class="input" id="nd" name="title" placeholder="Lower body" maxlength="60"></div></form>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Add day', kind: 'primary', onClick: async (body) => { await addDay(w, formData(body.querySelector('form')).title); return true; } }],
    });
    if (r) { toast('Day added.'); refresh(); }
  }));
  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const w = Number(b.dataset.copy), to = w + 1;
    let replace = false;
    if (byWeek(to).length) {
      if (!(await confirmDialog(`Copy week ${w}`, `Week ${to} already has workouts. Replace them with a copy of week ${w}? Athlete logs for week ${to} will be removed.`, `Replace week ${to}`, 'warn'))) return;
      replace = true;
    }
    act(() => api.post(`/programs/${p.id}/weeks/${w}/copy`, { to, replace }), `Week ${w} copied to week ${to}.`);
  }));
  const aw = el.querySelector('#addw');
  aw.addEventListener('submit', (e) => { e.preventDefault(); const d = formData(aw); act(() => addDay(d.week, d.title, d.day), 'Workout added.'); });

  // Program
  el.querySelector('#editp').addEventListener('click', async () => {
    const r = await modal({
      title: 'Program details',
      body: html`<form class="stack" novalidate>
        <div class="field"><label class="label" for="dn">Program name</label><input class="input" id="dn" name="name" value="${p.name}" maxlength="80"></div>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="field"><label class="label" for="dw">Weeks</label><input class="input" id="dw" name="weeks" type="number" min="1" max="52" value="${p.weeks}"></div>
          <div class="field"><label class="label" for="dl">Level</label><input class="input" id="dl" name="level" value="${p.level || ''}" list="dl-list" maxlength="40">
            <datalist id="dl-list">${LEVELS.map((l) => html`<option value="${l}">`)}</datalist></div>
        </div>
        <div class="field"><label class="label" for="dd">Description</label><textarea class="input" id="dd" name="description" rows="3" maxlength="500">${p.description || ''}</textarea></div>
      </form>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save details', kind: 'primary', onClick: async (body) => { await api.put(`/programs/${p.id}`, formData(body.querySelector('form'))); return true; } }],
    });
    if (r) { toast('Program saved.'); refresh(); }
  });
  el.querySelector('#delp').addEventListener('click', async () => {
    if (!(await confirmDialog('Delete program', `Delete ${p.name}? Clients' finished workouts stay in their history.`, 'Delete program', 'warn'))) return;
    try { await api.del(`/programs/${p.id}`); toast(`${p.name} deleted.`); ctx.go('/app/programs'); } catch (err) { toastError(err); }
  });
}

export const routes = [
  { path: '/programs', nav: 'programs', title: 'Programs', roles: ['owner', 'coach', 'frontdesk'], render: renderList },
  { path: '/programs/:id', nav: 'programs', title: 'Program builder', roles: ['owner', 'coach', 'frontdesk'], render: renderBuilder },
];
