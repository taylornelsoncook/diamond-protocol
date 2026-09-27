// Programs: program list with workout activity, exercise library (categories, cues, demo videos) and the
// week-by-week program builder with client progress.
import { html, raw, mount, api, icon, toast, toastError, modal, confirmDialog, formData, debounce, fmtDate, relTime, plural, fullName } from '/js/ui.js';

const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Ages 10–14', 'Ages 15–18'];
const canEdit = (ctx) => ctx.me.role === 'owner' || ctx.me.role === 'coach';

const STYLE = html`<style>
.dpo-layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:var(--space-6);align-items:start}
@media (max-width:1100px){.dpo-layout{grid-template-columns:minmax(0,1fr)}}
.dpo-layout>*{min-width:0}
.dpo-layout .btn-sm{min-height:44px}
.dpo-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:var(--space-4)}
.dpo-card{text-decoration:none;color:inherit;gap:6px;padding:var(--space-4) var(--space-6) var(--space-6)}
.dpo-card:hover{border-color:var(--control-border);background:var(--surface-raised);color:inherit}
.dpo-card[hidden]{display:none}
.dpo-card-title{font:700 20px/1.1 var(--font-display);letter-spacing:.06em;text-transform:uppercase;color:var(--steel);margin-top:6px}
.dpo-meta{font-size:13px;line-height:18px;color:var(--steel-muted)}
.dpo-meta.good{color:var(--green-bright)}.dpo-meta.warn{color:var(--amber)}
.dpo-thumb{width:44px;height:44px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;background:var(--black);border:1px solid var(--line-subtle);border-radius:var(--radius-sm);color:var(--steel);cursor:pointer;padding:0}
.dpo-thumb:hover{border-color:var(--green-mid)}
.dpo-thumb.has{color:var(--green-bright)}
.dpo-lib .list-row{padding:8px 0}
.dpo-lib-list{max-height:min(70vh,720px);overflow:auto;padding-right:var(--space-2)}
@media (max-width:1100px){.dpo-lib-list{max-height:none;overflow:visible;padding-right:0}}
.dpo-name{font-weight:600;color:var(--steel);overflow-wrap:anywhere}
.dpo-tools{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-2)}
.dpo-tools select.input{width:auto;max-width:190px}
.dpo-lib .dpo-tools{grid-template-columns:minmax(0,3fr) minmax(0,2fr)}.dpo-lib .dpo-tools select.input{width:100%;max-width:none}
.dpo-weeks{display:flex;gap:4px;overflow-x:auto;scrollbar-width:thin;border-bottom:1px solid var(--line)}
.dpo-weeks{position:relative}.dpo-weeks [role=tablist]{display:flex;gap:4px;flex-shrink:0}.dpo-weeks button{position:relative;min-height:44px;min-width:44px;padding:0 14px;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--steel-muted);font-weight:600;font-size:15px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;flex-shrink:0}
.dpo-weeks button:hover{color:var(--steel)}
.dpo-weeks [aria-selected="true"]{color:var(--steel);border-bottom-color:var(--green-mid)}
.dpo-weeks .n{font-size:12px;font-weight:500;color:var(--steel-muted)}
.dpo-weeks .empty-wk .n{color:var(--amber)}
.dpo-week-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}
.dpo-week-title{font:700 22px/1 var(--font-display);letter-spacing:.06em;text-transform:uppercase;display:flex;align-items:center;gap:var(--space-1,4px);margin:0}
.dpo-days{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:var(--space-4)}
.dpo-day{padding:var(--space-4);gap:var(--space-2)}
.dpo-day-label{font-size:12px;color:var(--steel-muted);line-height:16px}
.dpo-day-title{display:block;font-weight:600;font-size:15px;line-height:22px;background:none;border:0;padding:0;text-align:left;color:var(--steel);min-height:24px}
button.dpo-day-title{cursor:pointer;min-height:44px;width:100%}button.dpo-day-title:hover{text-decoration:underline;text-decoration-color:var(--steel-muted)}
.dpo-item{display:flex;align-items:center;gap:10px;padding:4px 0}
.dpo-item .grow{flex:1;min-width:0}
.dpo-item-name{display:block;background:none;border:0;padding:0;text-align:left;font-size:15px;color:var(--steel);line-height:20px;overflow-wrap:anywhere}
.dpo-item-btn{display:flex;flex-direction:column;justify-content:center;width:100%;min-height:44px;background:none;border:0;padding:2px 0;text-align:left;cursor:pointer;font:inherit;color:inherit}
.dpo-item-btn:hover .dpo-item-name{text-decoration:underline;text-decoration-color:var(--steel-muted)}
.dpo-item-tools{display:flex;align-items:center;flex-shrink:0}
.dpo-icon{min-height:44px;min-width:44px;padding:0;font-size:17px}
.dpo-day-foot{border-top:1px solid var(--line);padding-top:var(--space-3);display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center}
.dpo-day-foot .btn{min-height:44px}.dpo-day-foot .btn-ghost,.dpo-client .btn-ghost{padding:0 8px}
.dpo-day-foot .push{margin-left:auto}
.dpo-video{position:relative;aspect-ratio:16/9;background:var(--black);border-radius:var(--radius-sm);overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--steel-muted);text-align:center;padding:0}
.dpo-video iframe,.dpo-video video{position:absolute;inset:0;width:100%;height:100%;border:0}
.dpo-2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.dpo-pick-list{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-sm)}
.dpo-pick-list:empty{display:none}
.dpo-pick-list button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--line-subtle);padding:10px 12px;cursor:pointer;min-height:44px;color:var(--steel);font:inherit}
.dpo-pick-list button:first-child{border-top:0}
.dpo-pick-list button:hover,.dpo-pick-list button:focus-visible{background:var(--surface-raised)}
.dpo-pick-list button[aria-selected="true"]{background:var(--green-deep);color:var(--green-soft)}
.dpo-pick-list button[disabled]{opacity:.55;cursor:not-allowed}
.dpo-chosen{padding:10px 12px;border:1px solid var(--green-mid);border-radius:var(--radius-sm);background:var(--green-deep);color:var(--green-soft);display:flex;justify-content:space-between;align-items:center;gap:var(--space-2)}
.dpo-note{margin:4px 0 0;font-size:14px;line-height:20px;color:var(--steel);border-left:2px solid var(--line);padding-left:10px;overflow-wrap:anywhere}
.dpo-bar{height:4px;background:var(--surface-raised);border-radius:2px;overflow:hidden;margin-top:6px}
.dpo-bar span{display:block;height:100%;background:var(--green-mid)}
.dpo-client{flex-direction:column;align-items:stretch;gap:6px}
.dpo-client .btn-row{gap:4px}
.dpo-client .btn{min-height:44px}
.dpo-link{color:var(--steel);text-decoration:none;font-weight:600}
.dpo-link:hover{text-decoration:underline}
.dpo-metrics{grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))}
@media (max-width:600px){.dpo-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3)}.dpo-metrics .metric{padding:var(--space-3) var(--space-4)}}
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
// Play button: data-preview is the exercise; data-item (in a workout) adds that workout's sets, reps and cue.
const thumb = (ex, itemId = '') => html`<button type="button" class="dpo-thumb ${parseVideo(ex.video_url) ? 'has' : ''}" data-preview="${ex.exercise_id || ex.id}" data-item="${itemId}" aria-label="Demo and cues: ${ex.name}">${icon('play', 16)}</button>`;
const setsReps = (i) => [i.sets, i.reps].filter(Boolean).join(' × ');
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
const idleText = (a) => (a.last_workout_at ? `Last workout ${relTime(a.last_workout_at)}` : `No workouts yet · started ${fmtDate(a.program_started, { year: false })}`);
const daysAWeek = (n) => `${n} day${n === 1 ? '' : 's'} a week`;

// A toast with an Undo button (screen-local; the shared toast has no actions).
function undoToast(msg, onUndo) {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.cssText = 'display:flex;align-items:center;gap:16px';
  mount(t, html`<span>${msg}</span><button type="button" class="btn btn-sm" style="background:transparent;color:inherit;border-color:currentColor;min-height:44px">Undo</button>`);
  const timer = setTimeout(() => t.remove(), 8000);
  t.querySelector('button').addEventListener('click', async () => { clearTimeout(timer); t.remove(); try { await onUndo(); } catch (err) { toastError(err); } });
  box.append(t);
}

function previewExercise(ex, item) {
  if (!ex) return;
  return modal({
    title: ex.name, wide: true,
    body: html`${videoFrame(ex.video_url, ex.name)}
      ${item ? html`<p style="margin:0"><span class="strong">This workout.</span> <span class="muted">${setsReps(item)}${item.cue ? ` · ${item.cue}` : ''}</span></p>` : ''}
      ${ex.cues ? html`<p style="margin:0"><span class="strong">Cues.</span> <span class="muted">${ex.cues}</span></p>` : ''}`,
  });
}

// ======================= Exercise library =======================
function exerciseForm(ex = {}, categories = []) {
  return html`<form class="stack" novalidate>
    <div class="field"><label class="label" for="exn">Exercise name</label><input class="input" id="exn" name="name" value="${ex.name || ''}" required maxlength="80" autofocus></div>
    <div class="field"><label class="label" for="exk">Category</label><select class="input" id="exk" name="category">
      <option value="">No category</option>${categories.map((c) => html`<option ${c === ex.category ? raw('selected') : ''}>${c}</option>`)}</select></div>
    <div class="field"><label class="label" for="exv">Demo video link</label><input class="input" id="exv" name="video_url" value="${ex.video_url || ''}" placeholder="https://youtube.com/watch?v=…" inputmode="url">
      <span class="hint">YouTube, Vimeo or a direct link to a video file (.mp4, .webm, .mov).</span></div>
    <div class="field"><label class="label" for="exc">Coaching cues</label><textarea class="input" id="exc" name="cues" rows="3" maxlength="500" placeholder="One or two coaching cues">${ex.cues || ''}</textarea></div>
    ${ex.id ? html`<p class="hint" style="margin:0">${ex.uses ? `In ${plural(ex.uses, 'workout')}: ${ex.used_in}. Changes show in every one of them.` : 'Not in any program yet.'}</p>` : ''}
  </form>`;
}

// Resolves to the new exercise, or null.
function addExercise(categories, preset = {}) {
  return modal({
    title: 'Add exercise', body: exerciseForm(preset, categories),
    actions: [{ label: 'Cancel', value: null }, { label: 'Add exercise', kind: 'primary', onClick: async (body) => {
      const r = await api.post('/exercises', formData(body.querySelector('form'))); toast(`${r.name} added to the library.`); return r;
    } }],
  });
}

function editExercise(ex, categories) {
  const actions = [{ label: 'Cancel', value: null }];
  if (!ex.uses) actions.unshift({ label: 'Delete exercise', kind: 'ghost', onClick: async () => {
    if (!(await confirmDialog('Delete exercise', `Delete ${ex.name} from the library?`, 'Delete exercise', 'warn'))) return false;
    await api.del(`/exercises/${ex.id}`); toast(`${ex.name} deleted.`); return 'deleted';
  } });
  actions.push({ label: 'Save exercise', kind: 'primary', onClick: async (body) => {
    await api.put(`/exercises/${ex.id}`, formData(body.querySelector('form'))); toast('Exercise saved.'); return 'saved';
  } });
  return modal({ title: 'Edit exercise', body: exerciseForm(ex, categories), actions });
}

function libraryPanel(exercises, categories, edit) {
  return html`<section class="panel dpo-lib" aria-labelledby="libt">
    <div class="spread"><div><h2 class="panel-title" id="libt">Exercise library</h2><p class="panel-sub" id="lib-count" aria-live="polite">${plural(exercises.length, 'exercise')}</p></div>
      ${edit ? html`<button class="btn" id="addex">${icon('plus', 16)} Add exercise</button>` : ''}</div>
    <div class="dpo-tools">
      <div><label class="sr-only" for="lib-q">Search exercises</label><input class="input" id="lib-q" type="search" placeholder="Search exercises or cues" autocomplete="off"></div>
      <div><label class="sr-only" for="lib-f">Show</label><select class="input" id="lib-f">
        <option value="">All</option>${categories.map((c) => html`<option value="c:${c}">${c}</option>`)}
        <option value="novideo">Missing a video</option><option value="unused">Not in a program</option></select></div>
    </div>
    <div class="list dpo-lib-list" id="lib-list"></div>
  </section>`;
}
function libraryRows(list, edit) {
  if (!list.length) return html`<p class="muted" style="margin:0;padding:12px 0">No exercises match. Clear the search to see them all.</p>`;
  return list.map((e) => html`<div class="list-row">
    ${thumb(e)}
    <div class="grow"><div class="dpo-name">${e.name}</div>
      <div class="dpo-meta">${[e.category, e.uses ? `In ${plural(e.uses, 'workout')}` : 'Not in a program', videoLabel(e.video_url)].filter(Boolean).join(' · ')}</div></div>
    ${edit ? html`<button class="btn btn-ghost btn-sm dpo-icon" style="padding:0 12px" data-edit="${e.id}" aria-label="Edit ${e.name}">Edit</button>` : ''}
  </div>`);
}
function bindLibrary(el, exercises, categories, edit, onChange) {
  const byId = Object.fromEntries(exercises.map((e) => [e.id, e]));
  const q = el.querySelector('#lib-q'), f = el.querySelector('#lib-f'), list = el.querySelector('#lib-list'), count = el.querySelector('#lib-count');
  const draw = () => {
    const words = norm(q.value).split(/\s+/).filter(Boolean), fv = f.value;
    const rows = exercises.filter((e) => {
      if (fv.startsWith('c:') && e.category !== fv.slice(2)) return false;
      if (fv === 'novideo' && parseVideo(e.video_url)) return false;
      if (fv === 'unused' && e.uses) return false;
      const hay = norm(`${e.name} ${e.cues || ''} ${e.category || ''}`);
      return words.every((w) => hay.includes(w));
    });
    mount(list, libraryRows(rows, edit));
    count.textContent = rows.length === exercises.length ? plural(exercises.length, 'exercise') : `${rows.length} of ${plural(exercises.length, 'exercise')}`;
  };
  q.addEventListener('input', debounce(draw, 120));
  f.addEventListener('change', draw);
  list.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-preview]'); if (p) return previewExercise(byId[p.dataset.preview]);
    const b = e.target.closest('[data-edit]'); if (b && (await editExercise(byId[b.dataset.edit], categories))) onChange();
  });
  el.querySelector('#addex')?.addEventListener('click', async () => { if (await addExercise(categories, { name: q.value.trim() })) onChange(); });
  draw();
}

// ======================= Programs list =======================
function newProgramModal(programs, ctx) {
  return modal({
    title: 'New program',
    body: html`<form class="stack" novalidate>
      <div class="field"><label class="label" for="pn">Program name</label><input class="input" id="pn" name="name" maxlength="80" required autofocus placeholder="Pitchers off-season"></div>
      <div class="field"><label class="label" for="pc">Start from</label><select class="input" id="pc" name="copy_from">
        <option value="">A blank program</option>${programs.map((p) => html`<option value="${p.id}">A copy of ${p.name}</option>`)}</select>
        <span class="hint" id="pc-hint">Add workouts week by week after you create it.</span></div>
      <div class="form-grid dpo-2">
        <div class="field"><label class="label" for="pw">Weeks</label><input class="input" id="pw" name="weeks" type="number" min="1" max="52" value="8" inputmode="numeric"></div>
        <div class="field"><label class="label" for="pl">Level</label><input class="input" id="pl" name="level" value="Beginner" list="pl-list" maxlength="40">
          <datalist id="pl-list">${LEVELS.map((l) => html`<option value="${l}">`)}</datalist></div>
      </div>
      <div class="field"><label class="label" for="pd">Description <span class="muted">(optional)</span></label><textarea class="input" id="pd" name="description" rows="2" maxlength="500" placeholder="Who it's for and what it builds"></textarea></div>
    </form>`,
    onMount: (body) => {
      const sel = body.querySelector('#pc'), hint = body.querySelector('#pc-hint');
      sel.addEventListener('change', () => {
        const src = programs.find((p) => String(p.id) === sel.value);
        if (src) { body.querySelector('#pw').value = src.weeks; body.querySelector('#pl').value = src.level || ''; }
        hint.textContent = src ? `Copies every workout in the weeks you keep. ${src.name} stays as it is.` : 'Add workouts week by week after you create it.';
      });
    },
    actions: [{ label: 'Cancel', value: null }, { label: 'Create program', kind: 'primary', onClick: async (body) => {
      const f = formData(body.querySelector('form'));
      const r = await api.post('/programs', f);
      toast(f.copy_from ? 'Program copied. Make it your own.' : 'Program created. Add its first workout.');
      return r;
    } }],
  }).then((r) => { if (r) ctx.go(`/app/programs/${r.id}`); });
}

function activityRows(recent, { showProgram = true } = {}) {
  return recent.map((r) => html`<div class="list-row" style="align-items:flex-start">
    <div class="grow">
      <div class="spread" style="gap:var(--space-2)"><a href="/app/clients/${r.athlete_id}" class="dpo-link">${fullName(r)}</a>
        <span class="dpo-meta">${relTime(r.finished_at)}</span></div>
      <div class="dpo-meta">${showProgram ? html`<a href="/app/programs/${r.program_id}?week=${r.week}" style="color:inherit">${r.program}</a> · ` : ''}Week ${r.week}, day ${r.day}: ${r.title || `Day ${r.day}`}</div>
      <div class="dpo-meta ${r.done < r.total ? 'warn' : 'good'}">${r.done} of ${plural(r.total, 'exercise')} done${r.sets ? ` · ${plural(r.sets, 'set')} logged` : ''}${r.rpe ? ` · effort ${r.rpe} of 10` : ''}</div>
      ${r.note ? html`<p class="dpo-note">${r.note}</p>` : ''}
    </div></div>`);
}

async function renderList(ctx) {
  const [programs, exercises, activity, categories] = await Promise.all([api.get('/programs'), api.get('/exercises'), api.get('/programs/activity'), api.get('/exercise-categories')]);
  if (!ctx.isCurrent()) return;
  const edit = canEdit(ctx);
  const levels = [...new Set(programs.map((p) => p.level).filter(Boolean))];
  const { quiet, complete } = activity;
  const RECENT_SHOWN = 6;

  mount(ctx.el, html`${STYLE}
  <div class="page-header"><div><h1 class="page-title">Programs</h1><p class="page-sub">Build training, attach demo videos and assign to clients.</p></div>
    ${edit ? html`<button class="btn btn-primary" id="newp">${icon('plus', 18)} New program</button>` : ''}</div>
  ${!edit ? html`<div class="banner info">Front desk can view programs and resend workout links. An owner or coach makes changes.</div>` : ''}
  <div class="metrics dpo-metrics">
    <div class="metric"><span class="metric-label">Workouts logged</span><span class="metric-value good">${activity.logged_7d}</span><span class="metric-note">Last 7 days</span></div>
    <div class="metric"><span class="metric-label">Clients on a program</span><span class="metric-value">${activity.on_programs}</span><span class="metric-note">Across ${plural(programs.length, 'program')}</span></div>
    <div class="metric"><span class="metric-label">Need a check-in</span><span class="metric-value ${quiet.length ? 'warn' : ''}">${quiet.length}</span><span class="metric-note">No workout in 7 days or more</span></div>
    <div class="metric"><span class="metric-label">Finished their program</span><span class="metric-value">${complete.length}</span><span class="metric-note">Ready for what's next</span></div>
  </div>
  <div class="dpo-layout">
    <div class="stack">
      ${programs.length > 1 ? html`<div class="dpo-tools">
        <div><label class="sr-only" for="pq">Search programs</label><input class="input" id="pq" type="search" placeholder="Search programs" autocomplete="off"></div>
        ${levels.length > 1 ? html`<div><label class="sr-only" for="plv">Level</label><select class="input" id="plv"><option value="">All levels</option>${levels.map((l) => html`<option>${l}</option>`)}</select></div>` : ''}
      </div>` : ''}
      ${programs.length ? html`<div class="dpo-cards" id="pcards">${programs.map((p) => html`<a class="panel dpo-card" href="/app/programs/${p.id}" data-name="${norm(`${p.name} ${p.description || ''} ${p.level || ''}`)}" data-level="${p.level || ''}">
        <span class="dpo-card-title">${p.name}</span>
        <span class="dpo-meta">${[plural(p.weeks, 'week'), p.level, p.days_per_week ? daysAWeek(p.days_per_week) : 'No workouts yet'].filter(Boolean).join(' · ')}</span>
        <span class="dpo-meta ${p.logged_7d ? 'good' : ''}">${p.clients ? plural(p.clients, 'client') : 'No clients yet'}${p.logged_7d ? ` · ${plural(p.logged_7d, 'workout')} logged in the last 7 days` : ''}</span></a>`)}</div>
        <div class="empty" id="pnone" hidden>No programs match. Clear the search to see them all.</div>`
        : html`<div class="empty">No programs yet.${edit ? html` <button class="btn btn-sm" id="newp2" style="margin-left:8px">Create your first program</button>` : ''}</div>`}
      ${quiet.length ? html`<section class="panel" aria-labelledby="qt">
        <div><h2 class="panel-title" id="qt">Need a check-in</h2><p class="panel-sub">On a program with no workout logged in 7 days or more.</p></div>
        <div class="list">${quiet.map((a) => html`<div class="list-row">
          <div class="grow"><a href="/app/clients/${a.id}" class="dpo-link">${fullName(a)}</a>
            <div class="dpo-meta"><a href="/app/programs/${a.program_id}" style="color:inherit">${a.program}</a> · ${a.finished_days} of ${a.total_days} done${a.next ? ` · next: week ${a.next.week}, ${a.next.title}` : ''}</div>
            <div class="dpo-meta warn">${idleText(a)}</div></div>
          <span class="badge badge-warn">${plural(a.days_idle, 'day')}</span></div>`)}</div>
      </section>` : ''}
      ${complete.length ? html`<section class="panel" aria-labelledby="ct">
        <div><h2 class="panel-title" id="ct">Finished their program</h2><p class="panel-sub">Every workout logged. Set up what comes next.</p></div>
        <div class="list">${complete.map((a) => html`<div class="list-row">
          <div class="grow"><a href="/app/clients/${a.id}" class="dpo-link">${fullName(a)}</a>
            <div class="dpo-meta">${a.program} · all ${a.total_days} done · ${idleText(a)}</div></div></div>`)}</div>
      </section>` : ''}
      <section class="panel" aria-labelledby="rt">
        <div><h2 class="panel-title" id="rt">Recent workouts</h2><p class="panel-sub">What athletes logged in the workout app in the last 14 days, with their notes.</p></div>
        ${activity.recent.length ? html`<div class="list" id="recent">${activityRows(activity.recent.slice(0, RECENT_SHOWN))}</div>
          ${activity.recent.length > RECENT_SHOWN ? html`<div><button class="btn btn-ghost btn-sm" id="more">Show all ${activity.recent.length}</button></div>` : ''}`
        : html`<p class="muted" style="margin:0">No workouts logged yet. They show here as athletes finish them in the workout app.</p>`}
      </section>
    </div>
    ${libraryPanel(exercises, categories, edit)}
  </div>`);

  const el = ctx.el;
  el.querySelector('#newp')?.addEventListener('click', () => newProgramModal(programs, ctx));
  el.querySelector('#newp2')?.addEventListener('click', () => newProgramModal(programs, ctx));
  el.querySelector('#more')?.addEventListener('click', (e) => { mount(el.querySelector('#recent'), activityRows(activity.recent)); e.currentTarget.remove(); });
  const pq = el.querySelector('#pq'), plv = el.querySelector('#plv');
  const filter = () => {
    const words = norm(pq?.value).split(/\s+/).filter(Boolean), lv = plv?.value || '';
    let shown = 0;
    el.querySelectorAll('#pcards > a').forEach((a) => {
      const ok = words.every((w) => a.dataset.name.includes(w)) && (!lv || a.dataset.level === lv);
      a.hidden = !ok; if (ok) shown++;
    });
    const none = el.querySelector('#pnone'); if (none) none.hidden = shown > 0;
  };
  pq?.addEventListener('input', filter); plv?.addEventListener('change', filter);
  bindLibrary(el, exercises, categories, edit, () => ctx.reload());
}

// ======================= Program builder =======================
// Search the library, pick one (or add a new one), set sets × reps. Resolves to the number of exercises added.
function addItemModal(day, p, exercises, categories) {
  let chosen = null, added = 0;
  // Last sets and reps used for an exercise in this program: a good starting point.
  const lastUse = {};
  for (const d of p.days) for (const it of d.items) lastUse[it.exercise_id] = it;
  const pickHtml = (q) => {
    const words = norm(q).split(/\s+/).filter(Boolean);
    const rows = exercises.filter((e) => words.every((w) => norm(`${e.name} ${e.category || ''}`).includes(w))).slice(0, 40);
    const exact = exercises.some((e) => norm(e.name) === norm(q.trim()));
    return html`${rows.map((e) => html`<button type="button" role="option" aria-selected="false" data-ex="${e.id}"><span>${e.name}</span>
      <span class="dpo-meta">${[e.category, lastUse[e.id] ? `Used here: ${setsReps(lastUse[e.id])}` : '', parseVideo(e.video_url) ? 'Video' : ''].filter(Boolean).join(' · ') || 'In the library'}</span></button>`)}
      ${q.trim() && !exact ? html`<button type="button" data-new="1"><span>Add “${q.trim()}” to the library</span><span class="dpo-meta">Then set it up here</span></button>` : ''}`;
  };
  async function save(body) {
    if (!chosen) throw new Error('Choose an exercise first.');
    await api.post(`/program-days/${day.id}/items`, { exercise_id: chosen.id, ...formData(body.querySelector('form')) });
  }
  return modal({
    title: 'Add exercise',
    body: html`<form class="stack" novalidate>
      <p class="muted" style="margin:0">Week ${day.week}, day ${day.day}: ${day.title || `Day ${day.day}`}</p>
      <div class="field" id="ai-find"><label class="label" for="ai-q">Exercise</label>
        <input class="input" id="ai-q" type="search" placeholder="Search the library" autocomplete="off" autofocus aria-controls="ai-list">
        <div class="dpo-pick-list" id="ai-list" role="listbox" aria-label="Exercises"></div></div>
      <div id="ai-chosen" hidden></div>
      <div class="form-grid dpo-2">
        <div class="field"><label class="label" for="ai-s">Sets</label><input class="input" id="ai-s" name="sets" placeholder="3" maxlength="20"></div>
        <div class="field"><label class="label" for="ai-r">Reps</label><input class="input" id="ai-r" name="reps" placeholder="10 or 30 sec" maxlength="40"></div>
      </div>
      <div class="field"><label class="label" for="ai-c">Cue for this workout <span class="muted">(optional)</span></label><input class="input" id="ai-c" name="cue" maxlength="300" placeholder="Adds to the library cues"></div>
    </form>`,
    onMount: (body) => {
      const q = body.querySelector('#ai-q'), list = body.querySelector('#ai-list'), box = body.querySelector('#ai-chosen'), find = body.querySelector('#ai-find');
      const sets = body.querySelector('#ai-s'), reps = body.querySelector('#ai-r');
      const draw = () => mount(list, pickHtml(q.value));
      const choose = (ex) => {
        chosen = ex;
        const last = lastUse[ex.id];
        if (last && !sets.value && !reps.value) { sets.value = last.sets || ''; reps.value = last.reps || ''; }
        mount(box, html`<div class="dpo-chosen"><div><div class="strong">${ex.name}</div>${ex.cues ? html`<div class="small">${ex.cues}</div>` : ''}</div>
          <button type="button" class="btn btn-ghost btn-sm" id="ai-change">Change</button></div>`);
        box.hidden = false; find.hidden = true;
        box.querySelector('#ai-change').addEventListener('click', () => { chosen = null; box.hidden = true; find.hidden = false; q.focus(); });
        sets.focus(); sets.select();
      };
      body._reset = () => { body.querySelector('form').reset(); chosen = null; box.hidden = true; find.hidden = false; draw(); q.focus(); };
      q.addEventListener('input', debounce(draw, 80));
      q.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('button')?.focus(); }
        if (e.key === 'Enter') { e.preventDefault(); list.querySelector('button')?.click(); }
      });
      list.addEventListener('keydown', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); (b.nextElementSibling || b).focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); (b.previousElementSibling || q).focus(); }
      });
      list.addEventListener('click', async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.new) {
          const ex = await addExercise(categories, { name: q.value.trim() });
          if (ex) { exercises.push({ ...ex, uses: 0 }); exercises.sort((a, c) => a.name.localeCompare(c.name)); choose(ex); }
          return;
        }
        choose(exercises.find((x) => x.id === Number(b.dataset.ex)));
      });
      // Enter in sets/reps/cue saves (the primary action).
      body.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
      body.querySelector('form').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('#ai-s,#ai-r,#ai-c')) { e.preventDefault(); body.closest('.modal').querySelector('.modal-actions .btn-primary')?.click(); }
      });
      draw();
    },
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Add and add another', onClick: async (body) => { await save(body); added++; toast('Exercise added. Add the next one.'); body._reset(); return false; } },
      { label: 'Add exercise', kind: 'primary', onClick: async (body) => { await save(body); added++; return true; } },
    ],
  }).then(() => added);
}

function assignModal(p) {
  let chosen = null;
  return modal({
    title: `Assign ${p.name}`,
    body: html`<div class="stack">
      <div class="field"><label class="label" for="as-q">Client</label>
        <input class="input" id="as-q" type="search" placeholder="Name, Athlete ID or family" autocomplete="off" autofocus aria-controls="as-list">
        <span class="hint">It shows in their workout app straight away, and the link is emailed to them or their parents.</span></div>
      <div class="dpo-pick-list" id="as-list" role="listbox" aria-label="Clients"></div>
      <div id="as-msg" class="small" aria-live="polite"></div>
    </div>`,
    onMount: (body) => {
      const q = body.querySelector('#as-q'), list = body.querySelector('#as-list'), msg = body.querySelector('#as-msg');
      let rows = [];
      const search = debounce(async () => {
        const s = q.value.trim(); chosen = null; mount(msg, '');
        if (s.length < 2) return mount(list, '');
        try {
          rows = await api.get(`/programs/${p.id}/candidates?q=${encodeURIComponent(s)}`);
          mount(list, rows.length ? rows.map((a) => html`<button type="button" role="option" aria-selected="false" data-aid="${a.id}" ${a.program_id === p.id ? raw('disabled') : ''}>
            <span>${fullName(a)}</span><span class="dpo-meta">${[a.code, a.sport, a.program_id === p.id ? 'Already on this program' : a.program ? `On ${a.program}` : 'No program'].filter(Boolean).join(' · ')}</span></button>`)
            : html`<p class="muted small" style="margin:0;padding:10px 12px">No clients match.</p>`);
        } catch (err) { toastError(err); }
      }, 200);
      q.addEventListener('input', search);
      q.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('button:not([disabled])')?.focus(); } });
      list.addEventListener('keydown', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); (b.nextElementSibling || b).focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); (b.previousElementSibling || q).focus(); }
      });
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-aid]'); if (!b || b.disabled) return;
        chosen = rows.find((a) => a.id === Number(b.dataset.aid));
        list.querySelectorAll('[data-aid]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        mount(msg, chosen.program
          ? html`<span style="color:var(--amber)">${chosen.first_name} is on ${chosen.program}. Assigning moves them to ${p.name}. Their finished workouts stay in their history.</span>`
          : html`<span class="muted">${fullName(chosen)} starts ${p.name} today.</span>`);
      });
    },
    actions: [{ label: 'Cancel', value: null }, { label: 'Assign program', kind: 'primary', onClick: async () => {
      if (!chosen) throw new Error('Find and choose a client first.');
      await api.post(`/programs/${p.id}/assign`, { athlete_id: chosen.id });
      return chosen;
    } }],
  });
}

const weekOptions = (max, selected, skip) => range(1, max).filter((w) => w !== skip).map((w) => html`<option value="${w}" ${w === selected ? raw('selected') : ''}>Week ${w}</option>`);

// The week you were on, per program, for this browser tab. Storage can be blocked; that's fine.
function rememberedWeek(pid) { try { return Number(sessionStorage.getItem(`dpo-week-${pid}`)) || 0; } catch { return 0; } }
function rememberWeek(pid, w) { try { sessionStorage.setItem(`dpo-week-${pid}`, String(w)); } catch { /* storage blocked */ } }

async function renderBuilder(ctx) {
  const id = ctx.params.id;
  const [p, exercises, categories, activity] = await Promise.all([
    api.get(`/programs/${id}`), api.get('/exercises'), api.get('/exercise-categories'), api.get(`/programs/activity?program_id=${encodeURIComponent(id)}`)]);
  if (!ctx.isCurrent()) return;
  const edit = canEdit(ctx);
  const el = ctx.el;
  const weeksN = p.weeks_shown;
  const byWeek = (w) => p.days.filter((d) => d.week === w);
  const perWeek = Math.max(0, ...range(1, weeksN).map((w) => byWeek(w).length));
  let week = Math.min(Math.max(Number(ctx.query.week) || rememberedWeek(p.id) || 1, 1), weeksN);
  const exById = Object.fromEntries(exercises.map((e) => [e.id, e]));
  const items = Object.fromEntries(p.days.flatMap((d) => d.items.map((i) => [i.id, i])));
  const syncUrl = () => { const url = new URL(location.href); if (url.searchParams.get('week') !== String(week)) { url.searchParams.set('week', week); history.replaceState(history.state, '', url); } ctx.query.week = String(week); rememberWeek(p.id, week); };

  // Re-render in place without jumping to the top.
  const refresh = async () => { const y = window.scrollY; ctx.query.week = String(week); await renderBuilder(ctx); window.scrollTo(0, y); };
  const act = async (fn, msg) => { try { const r = await fn(); if (msg) toast(msg); await refresh(); return r; } catch (err) { toastError(err); } };

  const dayPanel = (d) => {
    const title = d.title || `Day ${d.day}`;
    return html`<section class="panel dpo-day" data-day="${d.id}" aria-label="Day ${d.day}: ${title}">
    <div><div class="dpo-day-label">Day ${d.day}${d.logs ? ` · logged ${plural(d.logs, 'time')}` : ''}</div>
      ${edit ? html`<button type="button" class="dpo-day-title" data-rename="${d.id}" title="Rename workout">${title}</button>` : html`<span class="dpo-day-title">${title}</span>`}</div>
    ${d.items.length ? html`<div class="list">${d.items.map((it, n) => html`<div class="dpo-item">
      ${thumb(it, it.id)}
      <div class="grow">
        ${edit ? html`<button type="button" class="dpo-item-btn" data-edititem="${it.id}" title="Edit sets, reps and cue"><span class="dpo-item-name">${it.name}</span>
          <span class="dpo-meta">${setsReps(it)}${it.cue ? html` · ${it.cue}` : ''}</span></button>`
        : html`<span class="dpo-item-name">${it.name}</span><div class="dpo-meta">${setsReps(it)}${it.cue ? html` · ${it.cue}` : ''}</div>`}
      </div>
      ${edit ? html`<div class="dpo-item-tools">
        <button class="btn btn-ghost dpo-icon" data-move="${it.id}" data-dir="-1" aria-label="Move ${it.name} up" ${n === 0 ? raw('disabled') : ''}>↑</button>
        <button class="btn btn-ghost dpo-icon" data-move="${it.id}" data-dir="1" aria-label="Move ${it.name} down" ${n === d.items.length - 1 ? raw('disabled') : ''}>↓</button>
        <button class="btn btn-ghost dpo-icon" data-rmitem="${it.id}" aria-label="Remove ${it.name}">${icon('close', 16)}</button></div>` : ''}
    </div>`)}</div>` : html`<p class="muted small" style="margin:0">No exercises yet.</p>`}
    ${edit ? html`<div class="dpo-day-foot">
      <button class="btn btn-sm" data-additem="${d.id}">${icon('plus', 16)} Add exercise</button>
      <button class="btn btn-ghost btn-sm push" data-copyday="${d.id}">Copy</button>
      <button class="btn btn-ghost btn-sm" data-delday="${d.id}">Delete</button></div>` : ''}
  </section>`;
  };

  const weekBody = () => {
    const days = byWeek(week);
    return html`<div class="dpo-week-head">
      <h2 class="dpo-week-title">
        <button class="btn btn-ghost dpo-icon" data-go="${week - 1}" aria-label="Previous week" ${week === 1 ? raw('disabled') : ''}>${icon('back', 18)}</button>
        <span id="wk-name">Week ${week}</span>
        <button class="btn btn-ghost dpo-icon" data-go="${week + 1}" aria-label="Next week" ${week === weeksN ? raw('disabled') : ''}>${icon('chevron', 18)}</button></h2>
      ${edit ? html`<div class="btn-row">
        ${days.length ? html`<button class="btn btn-sm" data-addday="${week}" ${days.length >= 7 ? raw('disabled') : ''}>${icon('plus', 16)} Add day</button>
          <button class="btn btn-ghost btn-sm" data-copyweek="${week}">Copy week</button>` : ''}
        ${days.length || (week === weeksN && weeksN > 1) ? html`<button class="btn btn-ghost btn-sm" data-delweek="${week}">Delete week</button>` : ''}</div>` : ''}</div>
    ${days.length ? html`<div class="dpo-days">${days.map(dayPanel)}</div>`
      : html`<div class="empty">No workouts in week ${week} yet.${edit ? html`<div class="btn-row" style="justify-content:center;margin-top:var(--space-3)">
          ${week > 1 && byWeek(week - 1).length ? html`<button class="btn btn-sm" data-copyinto="${week - 1}">Copy week ${week - 1} here</button>` : ''}
          <button class="btn btn-sm" data-addday="${week}">Add day</button></div>` : ''}</div>`}`;
  };

  const clientsPanel = () => html`<section class="panel" aria-labelledby="ct">
    <div><h2 class="panel-title" id="ct">Clients on this program</h2>
      <p class="panel-sub">${p.athletes.length ? `${plural(p.athletes.length, 'client')} · ${plural(p.logged_7d, 'workout')} logged in the last 7 days` : 'Nobody yet.'}</p></div>
    ${p.athletes.length ? html`<div class="list">${p.athletes.map((a) => html`<div class="list-row dpo-client">
      <div><a href="/app/clients/${a.id}" class="dpo-link">${fullName(a)}</a>
        <div class="dpo-meta">${a.code} · ${a.finished_days} of ${plural(a.total_days, 'workout')} done${a.complete ? ' · finished' : a.next ? ` · next: week ${a.next.week}, ${a.next.title}` : ''}</div>
        <div class="dpo-meta ${a.quiet ? 'warn' : ''}">${a.quiet ? `No workout in ${plural(a.days_idle, 'day')} · ` : ''}${idleText(a)}</div>
        <div class="dpo-bar" role="progressbar" aria-label="${fullName(a)}: workouts done" aria-valuemin="0" aria-valuemax="${a.total_days}" aria-valuenow="${a.finished_days}"><span style="width:${a.total_days ? Math.round((a.finished_days / a.total_days) * 100) : 0}%"></span></div></div>
      <div class="btn-row">
        ${a.workout_token ? html`<a class="btn btn-ghost btn-sm" href="/w/${a.workout_token}" target="_blank" rel="noopener">Workout app</a>` : ''}
        <button class="btn btn-ghost btn-sm" data-sendlink="${a.id}">Send link</button>
        ${edit ? html`<button class="btn btn-ghost btn-sm" data-unassign="${a.id}" data-name="${fullName(a)}">Remove</button>` : ''}
      </div></div>`)}</div>`
      : html`<p class="muted" style="margin:0">${edit ? 'Use Assign program at the top. It shows in their workout app straight away.' : 'An owner or coach assigns programs.'}</p>`}
  </section>`;

  mount(el, html`${STYLE}
  <div class="page-header">
    <div><a class="crumb" href="/app/programs">Programs</a><h1 class="page-title">${p.name}</h1>
      <p class="page-sub">${[plural(weeksN, 'week'), p.level, perWeek ? daysAWeek(perWeek) : null, plural(p.athletes.length, 'client')].filter(Boolean).join(' · ')}</p>
      ${p.description ? html`<p class="page-sub small">${p.description}</p>` : ''}</div>
    ${edit ? html`<button class="btn btn-primary" id="assign">Assign program</button>` : ''}
  </div>
  ${!edit ? html`<div class="banner info">Front desk can view this program and resend workout links. An owner or coach makes changes.</div>` : ''}
  <div class="dpo-layout">
    <div class="stack" style="gap:var(--space-4)">
      <div class="dpo-weeks"><div role="tablist" aria-label="Weeks">
        ${range(1, weeksN).map((w) => { const n = byWeek(w).length; return html`<button type="button" role="tab" data-week="${w}" aria-selected="${String(w === week)}" tabindex="${w === week ? 0 : -1}" aria-controls="week-body" class="${n ? '' : 'empty-wk'}">Week ${w} <span class="n">${n}<span class="sr-only"> ${n === 1 ? 'day' : 'days'}</span></span></button>`; })}</div>
        ${edit && weeksN < 52 ? html`<button type="button" id="addweek">${icon('plus', 16)} Add week</button>` : ''}
      </div>
      <div id="week-body" role="tabpanel" aria-labelledby="wk-name" class="stack" style="gap:var(--space-3)">${weekBody()}</div>
    </div>
    <div class="stack">
      ${clientsPanel()}
      <section class="panel" aria-labelledby="rw">
        <div><h2 class="panel-title" id="rw">Recent workouts</h2><p class="panel-sub">Last 14 days on this program.</p></div>
        ${activity.recent.length ? html`<div class="list">${activityRows(activity.recent.slice(0, 8), { showProgram: false })}</div>`
          : html`<p class="muted" style="margin:0">Nothing logged yet.</p>`}
      </section>
      ${edit ? html`<section class="panel" aria-label="Program settings">
        <div class="btn-row"><button class="btn btn-ghost" id="editp">Edit details</button><button class="btn btn-ghost" id="dupp">Duplicate program</button>
        <button class="btn btn-ghost" id="delp">Delete program</button></div></section>` : ''}
    </div>
  </div>
  <div class="dpo-foot"><a class="btn btn-ghost" href="/app/programs">All programs</a></div>`);
  syncUrl();

  const layout = el.querySelector('.dpo-layout');
  const setWeek = (w, focus) => {
    week = Math.min(Math.max(w, 1), weeksN); syncUrl();
    mount(el.querySelector('#week-body'), weekBody());
    el.querySelectorAll('.dpo-weeks [role=tab]').forEach((t) => { const on = Number(t.dataset.week) === week; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    const tab = el.querySelector(`.dpo-weeks [data-week="${week}"]`);
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) tab?.focus();
  };
  const tabs = el.querySelector('.dpo-weeks');
  tabs.addEventListener('click', (e) => { const t = e.target.closest('[data-week]'); if (t) setWeek(Number(t.dataset.week)); });
  tabs.addEventListener('keydown', (e) => {
    if (!e.target.closest('[role=tab]')) return;
    const keys = { ArrowRight: week + 1, ArrowLeft: week - 1, Home: 1, End: weeksN };
    if (e.key in keys) { e.preventDefault(); setWeek(keys[e.key], true); }
  });
  el.querySelector('.dpo-weeks [aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // One delegated handler for the week body and side panels (they are re-rendered on every change).
  layout.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t || t.disabled) return;
    const ds = t.dataset;
    if (ds.preview) return previewExercise(exById[ds.preview], ds.item ? items[ds.item] : null);
    if (ds.go) return setWeek(Number(ds.go));
    if (ds.sendlink) {
      t.disabled = true;
      try { const r = await api.post(`/programs/${p.id}/send-link`, { athlete_id: Number(ds.sendlink) }); toast(`Workout link emailed to ${r.sent_to.join(', ')}.`); } catch (err) { toastError(err); }
      t.disabled = false;
      return;
    }
    if (edit) await onEdit(ds);
  });
  if (!edit) return;

  const addDay = (w, title, day) => api.post(`/programs/${p.id}/days`, { week: w, title, day });
  el.querySelector('#assign').addEventListener('click', async () => {
    const a = await assignModal(p);
    if (a) { toast(`${p.name} assigned to ${fullName(a)}. The workout link is on its way by email.`); refresh(); }
  });
  el.querySelector('#addweek')?.addEventListener('click', () => act(async () => {
    await api.put(`/programs/${p.id}`, { weeks: weeksN + 1 }); week = weeksN + 1;
  }, `Week ${weeksN + 1} added. Copy a week into it or add a day.`));
  el.querySelector('#editp').addEventListener('click', async () => {
    const r = await modal({
      title: 'Program details',
      body: html`<form class="stack" novalidate>
        <div class="field"><label class="label" for="dn">Program name</label><input class="input" id="dn" name="name" value="${p.name}" maxlength="80"></div>
        <div class="form-grid dpo-2">
          <div class="field"><label class="label" for="dw">Weeks</label><input class="input" id="dw" name="weeks" type="number" min="1" max="52" value="${p.weeks}" inputmode="numeric"></div>
          <div class="field"><label class="label" for="dl">Level</label><input class="input" id="dl" name="level" value="${p.level || ''}" list="dl-list" maxlength="40">
            <datalist id="dl-list">${LEVELS.map((l) => html`<option value="${l}">`)}</datalist></div>
        </div>
        <div class="field"><label class="label" for="dd">Description</label><textarea class="input" id="dd" name="description" rows="3" maxlength="500">${p.description || ''}</textarea></div>
      </form>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save details', kind: 'primary', onClick: async (body) => { await api.put(`/programs/${p.id}`, formData(body.querySelector('form'))); return true; } }],
    });
    if (r) { toast('Program saved.'); refresh(); }
  });
  el.querySelector('#dupp').addEventListener('click', async () => {
    const r = await modal({
      title: 'Duplicate program',
      body: html`<form class="stack" novalidate><div class="field"><label class="label" for="dupn">Name of the copy</label><input class="input" id="dupn" name="name" value="${`${p.name} (copy)`.slice(0, 80)}" maxlength="80"></div>
        <p class="hint" style="margin:0">Copies every week and workout. Clients stay on ${p.name}.</p></form>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Duplicate program', kind: 'primary', onClick: async (body) => api.post(`/programs/${p.id}/duplicate`, formData(body.querySelector('form'))) }],
    });
    if (r) { toast("Program copied. You're editing the copy."); ctx.go(`/app/programs/${r.id}`); }
  });
  el.querySelector('#delp').addEventListener('click', async () => {
    if (p.athletes.length) return toastError(new Error(`${plural(p.athletes.length, 'client')} ${p.athletes.length === 1 ? 'is' : 'are'} on this program. Move them to another program or remove them first.`));
    if (!(await confirmDialog('Delete program', `Delete ${p.name}? Clients' finished workouts stay in their history.`, 'Delete program', 'warn'))) return;
    try { await api.del(`/programs/${p.id}`); toast(`${p.name} deleted.`); ctx.go('/app/programs'); } catch (err) { toastError(err); }
  });

  async function onEdit(ds) {
    if (ds.unassign) {
      if (!(await confirmDialog('Remove from program', `Take ${ds.name} off ${p.name}? Their finished workouts stay in their history.`, 'Remove from program', 'warn'))) return;
      return act(() => api.post(`/programs/${p.id}/unassign`, { athlete_id: Number(ds.unassign) }), `${ds.name} removed from ${p.name}.`);
    }
    if (ds.additem) {
      const d = p.days.find((x) => x.id === Number(ds.additem));
      const n = await addItemModal(d, p, exercises, categories);
      if (n) { toast(n > 1 ? `${plural(n, 'exercise')} added.` : 'Exercise added.'); refresh(); }
      return;
    }
    if (ds.rmitem) {
      const it = items[ds.rmitem];
      try {
        const r = await api.del(`/program-items/${it.id}`);
        await refresh();
        undoToast(`${it.name} removed.`, async () => { await api.post(`/program-days/${r.removed.day_id}/items`, r.removed); toast(`${it.name} is back.`); await refresh(); });
      } catch (err) { toastError(err); }
      return;
    }
    if (ds.move) return act(() => api.post(`/program-items/${ds.move}/move`, { dir: Number(ds.dir) }));
    if (ds.edititem) {
      const it = items[ds.edititem];
      const r = await modal({
        title: it.name,
        body: html`<form class="stack" novalidate>
          <div class="form-grid dpo-2">
            <div class="field"><label class="label" for="is">Sets</label><input class="input" id="is" name="sets" value="${it.sets || ''}" maxlength="20" autofocus></div>
            <div class="field"><label class="label" for="ir">Reps</label><input class="input" id="ir" name="reps" value="${it.reps || ''}" maxlength="40"></div>
          </div>
          <div class="field"><label class="label" for="ic">Cue for this workout</label><input class="input" id="ic" name="cue" value="${it.cue || ''}" maxlength="300" placeholder="Optional. Adds to the library cues."></div>
          ${it.cues ? html`<p class="hint" style="margin:0">Library cues: ${it.cues}</p>` : ''}
          <div class="field"><label class="label" for="ie">Exercise</label><select class="input" id="ie" name="exercise_id">
            ${exercises.map((e) => html`<option value="${e.id}" ${e.id === it.exercise_id ? raw('selected') : ''}>${e.name}</option>`)}</select>
            <span class="hint">Swap in a different exercise. Sets, reps and its place stay the same.</span></div>
        </form>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Save exercise', kind: 'primary', onClick: async (body) => { await api.put(`/program-items/${it.id}`, formData(body.querySelector('form'))); return true; } }],
      });
      if (r) { toast('Exercise saved.'); refresh(); }
      return;
    }
    if (ds.rename) {
      const d = p.days.find((x) => x.id === Number(ds.rename));
      const r = await modal({
        title: 'Rename workout',
        body: html`<form novalidate><div class="field"><label class="label" for="rt">Workout title</label><input class="input" id="rt" name="title" value="${d.title || ''}" maxlength="60"></div></form>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Save title', kind: 'primary', onClick: async (body) => { await api.put(`/program-days/${d.id}`, formData(body.querySelector('form'))); return true; } }],
      });
      if (r) { toast('Workout renamed.'); refresh(); }
      return;
    }
    if (ds.delday) {
      const d = p.days.find((x) => x.id === Number(ds.delday));
      const extra = d.logs ? ` ${plural(d.logs, 'athlete log')} of it will be removed too.` : '';
      if (!(await confirmDialog('Delete workout', `Delete week ${d.week}, day ${d.day} (${d.title || 'untitled'})?${extra}`, 'Delete workout', 'warn'))) return;
      return act(() => api.del(`/program-days/${d.id}`), 'Workout deleted.');
    }
    if (ds.addday) {
      const w = Number(ds.addday);
      const taken = new Set(byWeek(w).map((d) => d.day));
      const r = await modal({
        title: `Add a day to week ${w}`,
        body: html`<form class="stack" novalidate>
          <div class="field"><label class="label" for="nd">Workout title</label><input class="input" id="nd" name="title" placeholder="Lower body" maxlength="60" autofocus></div>
          <div class="field"><label class="label" for="ndd">Day</label><select class="input" id="ndd" name="day"><option value="">Next free day</option>
            ${range(1, 7).filter((n) => !taken.has(n)).map((n) => html`<option value="${n}">Day ${n}</option>`)}</select></div>
        </form>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Add day', kind: 'primary', onClick: async (body) => { const f = formData(body.querySelector('form')); await addDay(w, f.title, f.day); return true; } }],
      });
      if (r) { toast('Day added. Now add its exercises.'); refresh(); }
      return;
    }
    if (ds.copyday) {
      const d = p.days.find((x) => x.id === Number(ds.copyday));
      const r = await modal({
        title: `Copy ${d.title || `day ${d.day}`}`,
        body: html`<form class="stack" novalidate>
          <div class="form-grid dpo-2">
            <div class="field"><label class="label" for="cdw">To week</label><select class="input" id="cdw" name="week">${weekOptions(Math.min(52, weeksN + 1), Math.min(d.week + 1, weeksN + 1, 52))}</select></div>
            <div class="field"><label class="label" for="cdd">Day</label><select class="input" id="cdd" name="day"><option value="">Next free day</option>${range(1, 7).map((n) => html`<option value="${n}">Day ${n}</option>`)}</select></div>
          </div>
          <div class="field"><label class="label" for="cdt">Workout title</label><input class="input" id="cdt" name="title" value="${d.title || ''}" maxlength="60"></div>
          <p class="hint" style="margin:0">Copies ${plural(d.items.length, 'exercise')} with their sets, reps and cues.</p>
        </form>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Copy workout', kind: 'primary', onClick: async (body) => api.post(`/program-days/${d.id}/copy`, formData(body.querySelector('form'))) }],
      });
      if (r) { toast(`Copied to week ${r.week}, day ${r.day}.`); week = r.week; refresh(); }
      return;
    }
    if (ds.copyinto) return copyWeek(Number(ds.copyinto), week, week);
    if (ds.copyweek) {
      const w = Number(ds.copyweek);
      const top = Math.min(52, Math.max(weeksN, w) + 1);
      const first = Math.min(w + 1, top);
      const r = await modal({
        title: `Copy week ${w}`,
        body: html`<form class="stack" novalidate>
          <div class="form-grid dpo-2">
            <div class="field"><label class="label" for="cwf">To week</label><select class="input" id="cwf" name="to">${weekOptions(top, first, w)}</select></div>
            <div class="field"><label class="label" for="cwt">Through week</label><select class="input" id="cwt" name="through">${weekOptions(top, first, w)}</select></div>
          </div>
          <p class="hint" style="margin:0">Copies ${plural(byWeek(w).length, 'workout')} into each week. Change sets and reps afterwards to progress the load.</p>
        </form>`,
        onMount: (body) => {
          const f = body.querySelector('#cwf'), t = body.querySelector('#cwt');
          f.addEventListener('change', () => { if (Number(t.value) < Number(f.value)) t.value = f.value; });
          t.addEventListener('change', () => { if (Number(t.value) < Number(f.value)) f.value = t.value; });
        },
        actions: [{ label: 'Cancel', value: null }, { label: 'Copy week', kind: 'primary', onClick: async (body) => formData(body.querySelector('form')) }],
      });
      if (r) copyWeek(w, Number(r.to), Number(r.through));
      return;
    }
    if (ds.delweek) {
      const w = Number(ds.delweek);
      const days = byWeek(w), logs = days.reduce((s, d) => s + d.logs, 0);
      const ask = days.length ? `Delete all ${plural(days.length, 'workout')} in week ${w}?${logs ? ` ${plural(logs, 'athlete log')} of them will be removed too.` : ''}`
        : `Week ${w} has no workouts. Take it off the end of ${p.name}?`;
      if (!(await confirmDialog(`Delete week ${w}`, ask, `Delete week ${w}`, 'warn'))) return;
      return act(async () => { await api.del(`/programs/${p.id}/weeks/${w}`); if (w === weeksN) week = Math.max(1, w - 1); }, `Week ${w} deleted.`);
    }
  }

  async function copyWeek(from, to, through, replace = false) {
    const label = to === through ? `week ${to}` : `weeks ${to} to ${through}`;
    try {
      await api.post(`/programs/${p.id}/weeks/${from}/copy`, { to, through, replace });
      toast(`Week ${from} copied to ${label}.`); week = to; await refresh();
    } catch (err) {
      if (!err.data?.needs_replace) return toastError(err);
      const ws = err.data.weeks || [to];
      const logs = p.days.filter((d) => ws.includes(d.week)).reduce((s, d) => s + d.logs, 0);
      const ok = await confirmDialog(`Copy week ${from}`, `${ws.length === 1 ? `Week ${ws[0]} already has` : `Weeks ${ws.join(', ')} already have`} workouts. Replace them with a copy of week ${from}?${logs ? ` ${plural(logs, 'athlete log')} of those workouts will be removed.` : ''}`, 'Replace and copy', 'warn');
      if (ok) return copyWeek(from, to, through, true);
    }
  }
}

export const routes = [
  { path: '/programs', nav: 'programs', title: 'Programs', roles: ['owner', 'coach', 'frontdesk'], render: renderList },
  { path: '/programs/:id', nav: 'programs', title: 'Program builder', roles: ['owner', 'coach', 'frontdesk'], render: renderBuilder },
];
