// Education: lessons, courses and assigned reading. Owners and coaches manage; front desk views.
// Also exports assignDialog() and lessonPreview(), used by the client profile and team contract.
import { html, raw, mount, api, icon, fmtDate, localISO, relTime, toast, toastError, modal, confirmDialog, formData, options, debounce, plural, badge } from '/js/ui.js';
import { videoFrame } from './programs.js';

export const canManage = (ctx) => ctx.me.role === 'owner' || ctx.me.role === 'coach';

const STYLE = html`<style>
.edu .edu-row{display:flex;align-items:center;gap:var(--space-3);padding:12px 0;border-top:1px solid var(--line-subtle);flex-wrap:wrap}
.edu .edu-row:first-child{border-top:0}
.edu .edu-grow{flex:1 1 240px;min-width:0}
.edu .edu-title{font-weight:600;color:var(--steel);overflow-wrap:anywhere}
.edu .edu-sub{font-size:13px;line-height:18px;color:var(--steel-muted)}
.edu .edu-acts{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.edu .edu-mv{padding:0 10px}.edu .edu-mv svg{transform:rotate(-90deg)}.edu .edu-mv.dn svg{transform:rotate(90deg)}
.edu .edu-course{border:1px solid var(--line);border-radius:var(--radius-md);padding:var(--space-4);display:flex;flex-direction:column;gap:var(--space-2)}
.edu .edu-course-title{font:700 18px/1.2 var(--font-display);letter-spacing:.05em;text-transform:uppercase;color:var(--steel)}
.edu .edu-n{font:600 13px/1 var(--font-display);color:var(--steel-muted);min-width:18px}
.edu details.edu-who summary{cursor:pointer;font-size:13px;color:var(--steel-muted);list-style:none;display:inline-flex;align-items:center;gap:6px;min-height:44px}
.edu details.edu-who summary::-webkit-details-marker{display:none}
.edu details.edu-who summary::before{content:'';border:4px solid transparent;border-left:6px solid currentColor;border-right:0}
.edu details.edu-who[open] summary::before{transform:rotate(90deg)}
.edu .edu-bar{width:120px}
.edu-link{background:none;border:0;padding:0;font:inherit;font-weight:600;color:var(--steel);text-align:left;cursor:pointer;overflow-wrap:anywhere;min-height:24px}
.edu-link:hover,.edu-link:focus-visible{color:var(--green-bright);text-decoration:underline}
.edu .edu-tools{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap}
.edu .edu-tools .edu-q{flex:1 1 220px;min-width:0;max-width:360px}
.edu .edu-tools .edu-sp{flex:1 1 0}
.edu .edu-cnt{margin-left:6px;font-weight:400;opacity:.8}
.edu .metrics{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.edu-people{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.edu-people li{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line-subtle);font-size:14px}
.edu-people li:first-child{border-top:0}
.edu-people .grow{flex:1 1 140px;min-width:0}
.edu .edu-arow{align-items:flex-start}.edu .edu-arow .edu-acts{padding-top:2px}
.edu .edu-bar2{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap}
#as-f .seg button{min-height:44px}
@media (max-width:600px){.edu .edu-acts{width:100%}.edu .edu-acts>.stack-sm{flex-basis:100%;margin-bottom:4px}.edu .edu-bar{width:100%}.edu .btn-sm{min-height:44px}
  .edu .edu-tools .seg{flex-wrap:nowrap}.edu .edu-tools .seg button{padding:0 8px;font-size:13px}.edu .tabs button{padding:0 12px}
  .edu .metrics{grid-template-columns:1fr 1fr;gap:var(--space-2)}.edu .metric{padding:var(--space-3)}.edu .metric-value{font-size:28px}
  .edu .edu-tools .edu-q{max-width:none;flex-basis:100%}.edu .edu-tools .seg{width:100%}.edu .edu-tools .seg button{flex:1 1 auto;min-height:44px}
  .edu .edu-acts .btn-sm{padding:0 10px}.edu .edu-mv{min-width:44px}.edu .edu-title .edu-link{display:inline-flex;align-items:center;min-height:44px}}
.edu-prev{display:flex;flex-direction:column;gap:var(--space-3);background:var(--ground);border:1px solid var(--line);border-radius:var(--radius-md);padding:var(--space-4)}
.edu-prev .edu-prev-kicker{font-size:13px;color:var(--steel-muted)}
.edu-prev h3{font:700 24px/1.1 var(--font-display);letter-spacing:.04em;text-transform:uppercase;color:var(--steel)}
.edu-prev p{margin:0}
.edu-prev .dpo-video{position:relative;aspect-ratio:16/9;background:var(--black);border-radius:var(--radius-sm);overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--steel-muted)}
.edu-prev .dpo-video iframe,.edu-prev .dpo-video video{position:absolute;inset:0;width:100%;height:100%;border:0}
.edu-prev .edu-prev-body p+p{margin-top:12px}
.edu-pick{position:relative}
.edu-pick .edu-results{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:20;background:var(--surface);border:1px solid var(--control-border);border-radius:var(--radius-sm);max-height:240px;overflow:auto}
.edu-pick .edu-results button{display:block;width:100%;text-align:left;background:none;border:0;padding:10px 12px;cursor:pointer;min-height:44px;color:var(--steel)}
.edu-pick .edu-results button:hover,.edu-pick .edu-results button:focus{background:var(--surface-raised)}
.edu-chips{display:flex;flex-wrap:wrap;gap:6px}
.edu-chips:empty{display:none}
.edu-chips .chip{padding:0 0 0 12px;min-height:44px;font-size:14px}
.edu-chips .chip button{background:none;border:0;color:var(--steel-muted);cursor:pointer;min-width:40px;min-height:44px;display:inline-flex;align-items:center;justify-content:center}
.edu-chips .chip button:hover,.edu-chips .chip button:focus-visible{color:var(--steel)}
.edu-quick{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.edu-quick .btn-sm{min-height:44px}
.edu-dstats{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-2)}
.edu-dstats div{border:1px solid var(--line);border-radius:var(--radius-sm);padding:var(--space-2) var(--space-3)}
.edu-dstats strong{display:block;font:600 24px/1.1 var(--font-display);color:var(--steel)}
.edu-dstats span{font-size:13px;color:var(--steel-muted)}
.edu-dsec h3{font:600 14px/20px var(--font-sans);color:var(--steel);margin:0 0 4px}
</style>`;

const paragraphs = (body) => String(body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const PERSON = {
  finished: () => badge('complete', 'Finished'),
  started: (p) => badge('open', p.of ? `Started · ${p.done} of ${p.of}` : 'Opened'),
  not_started: () => badge('off', 'Not started'),
};
// SQLite datetime('now') is UTC without a zone.
const utcMs = (s) => (s ? new Date(String(s).replace(' ', 'T') + (/[zZ]$/.test(s) ? '' : 'Z')).getTime() : 0);
const remindedRecently = (x) => x.reminded_at && Date.now() - utcMs(x.reminded_at) < 12 * 3600 * 1000;
const addDaysISO = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localISO(d); };
const matches = (q, ...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));

// Stop a half-written form being lost to a stray click outside the dialog or the Escape key.
// Also makes Escape close only the topmost dialog when a preview is open on top of an editor.
function protect(body, isDirty) {
  const back = body.closest('.modal-back');
  const warn = () => toast('You have unsaved changes. Save them, or press Cancel to discard them.', 'warn');
  back.addEventListener('click', (e) => { if (e.target === back && isDirty()) { e.stopImmediatePropagation(); warn(); } }, true);
  const onKey = (e) => {
    if (e.key !== 'Escape' || !back.isConnected) return;
    const open = document.querySelectorAll('.modal-back'), top = open[open.length - 1];
    if (top !== back) { e.stopImmediatePropagation(); top.querySelector('[data-close]')?.click(); return; }
    if (isDirty()) { e.stopImmediatePropagation(); warn(); }
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
const snapshot = (form) => JSON.stringify(formData(form));

// ---- lesson preview: what the athlete sees ----
export function lessonPreview(l, courseTitle) {
  const body = paragraphs(l.body);
  return modal({
    title: 'Preview', wide: true,
    body: html`${STYLE}<p class="hint" style="margin:0">This is how ${l.published === 0 ? 'athletes will see it once you publish it' : 'athletes see it in their app and the parent portal'}.</p>
      <article class="edu-prev">
        <div class="edu-prev-kicker">${[courseTitle, l.minutes ? `${l.minutes} min read` : null].filter(Boolean).join(' · ') || 'Lesson'}</div>
        <h3>${l.title || 'Untitled lesson'}</h3>
        ${l.summary ? html`<p class="muted">${l.summary}</p>` : ''}
        ${l.video_url ? videoFrame(l.video_url, l.title) : ''}
        <div class="edu-prev-body">${body.length ? body.map((p) => html`<p style="white-space:pre-line">${p}</p>`) : html`<p class="muted">No text yet.</p>`}</div>
        <div><button class="btn btn-primary" type="button" disabled>Mark as done</button></div>
      </article>`,
  });
}

// ---- assign a lesson or course to athletes or a team ----
// preset: { athlete: {id, name} } or { team: {id, name} } fixes who; { lesson_id } or { course_id } preselects what.
export async function assignDialog(preset = {}) {
  const [edu, lookups] = await Promise.all([api.get('/education'), preset.athlete || preset.team ? null : api.get('/lookups')]);
  const courses = edu.courses.filter((c) => c.published && c.lessons.some((l) => l.published));
  const courseTitle = new Map(edu.courses.map((c) => [c.id, c.title]));
  const lessons = [...edu.lessons, ...edu.courses.flatMap((c) => c.lessons)].filter((l) => l.published);
  if (!courses.length && !lessons.length) { toastError(new Error('Publish a lesson first. Lessons and courses are on the Education page.')); return null; }
  const pre = preset.course_id ? `c:${preset.course_id}` : preset.lesson_id ? `l:${preset.lesson_id}` : '';
  const fixed = preset.athlete || preset.team;
  const picked = []; // [{id, name}]
  return modal({
    title: 'Assign lesson',
    body: html`${STYLE}<form class="stack" id="as-f" novalidate>
      <div class="field"><label class="label" for="as-what">Lesson or course</label>
        <select class="input" id="as-what" name="what"><option value="">Choose one</option>
          ${courses.length ? html`<optgroup label="Courses">${courses.map((c) => html`<option value="c:${c.id}" ${pre === `c:${c.id}` ? raw('selected') : ''}>${c.title} (${plural(c.lessons.filter((l) => l.published).length, 'lesson')})</option>`)}</optgroup>` : ''}
          <optgroup label="Lessons">${lessons.map((l) => html`<option value="l:${l.id}" ${pre === `l:${l.id}` ? raw('selected') : ''}>${l.title}${l.course_id && courseTitle.get(l.course_id) ? ` (${courseTitle.get(l.course_id)})` : ''}</option>`)}</optgroup>
        </select></div>
      ${fixed ? html`<div class="field"><span class="label">For</span><div>${fixed.name}${preset.team ? html` <span class="muted small">(everyone on the roster)</span>` : ''}</div></div>`
        : html`<div class="field"><span class="label" id="as-wl">For</span>
          <div class="seg" role="group" aria-labelledby="as-wl"><button type="button" data-who="athlete" aria-pressed="true">Athletes</button><button type="button" data-who="team" aria-pressed="false">A team</button></div></div>
        <div class="field edu-pick" id="as-ath"><label class="label" for="as-q">Athletes</label>
          <div class="edu-chips" id="as-chips" aria-live="polite"></div>
          <input class="input" id="as-q" type="search" placeholder="Name or Athlete ID" autocomplete="off" aria-describedby="as-qh" aria-controls="as-res">
          <div class="edu-results" id="as-res" hidden></div>
          <span class="hint" id="as-qh">Add as many athletes as you like. Enter picks the first match.</span></div>
        <div class="field" id="as-team" hidden><label class="label" for="as-t">Team</label>
          <select class="input" id="as-t">${options(lookups.teams, '', { blank: 'Choose a team', label: (t) => `${t.school} ${t.team_name}` })}</select>
          <span class="hint">Everyone on the roster gets it, including athletes added later.</span></div>`}
      <div class="field"><label class="label" for="as-due">Due date (optional)</label><input class="input" id="as-due" name="due_date" type="date" min="${localISO()}" style="max-width:220px">
        <div class="edu-quick" role="group" aria-label="Quick due dates">
          ${[[3, 'In 3 days'], [7, 'In a week'], [14, 'In 2 weeks']].map(([n, l]) => html`<button type="button" class="btn btn-ghost btn-sm" data-due="${n}">${l}</button>`)}
          <button type="button" class="btn btn-ghost btn-sm" data-due="">No due date</button></div></div>
      <div class="field"><label class="label" for="as-note">Note (optional)</label><textarea class="input" id="as-note" name="note" rows="2" maxlength="500" style="min-height:64px" placeholder="Why it matters, or where to start"></textarea>
        <span class="hint">The athlete and their parents are emailed a link.</span></div>
    </form>`,
    onMount: (body) => {
      const due = body.querySelector('#as-due');
      body.querySelectorAll('[data-due]').forEach((b) => b.addEventListener('click', () => { due.value = b.dataset.due ? addDaysISO(Number(b.dataset.due)) : ''; }));
      if (fixed) return;
      const segs = body.querySelectorAll('[data-who]');
      segs.forEach((b) => b.addEventListener('click', () => {
        segs.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        body.querySelector('#as-ath').hidden = b.dataset.who !== 'athlete';
        body.querySelector('#as-team').hidden = b.dataset.who !== 'team';
      }));
      const q = body.querySelector('#as-q'), res = body.querySelector('#as-res'), chips = body.querySelector('#as-chips');
      let found = [];
      const drawChips = () => mount(chips, picked.map((a, i) => html`<span class="chip">${a.name}<button type="button" data-unpick="${i}" aria-label="Remove ${a.name}">${icon('close', 14)}</button></span>`));
      const pick = (a) => {
        if (!picked.some((x) => x.id === a.id)) picked.push({ id: a.id, name: `${a.first_name} ${a.last_name}` });
        drawChips(); q.value = ''; found = []; res.hidden = true; q.focus();
      };
      chips.addEventListener('click', (e) => { const b = e.target.closest('[data-unpick]'); if (!b) return; picked.splice(+b.dataset.unpick, 1); drawChips(); q.focus(); });
      q.addEventListener('input', debounce(async () => {
        const s = q.value.trim();
        if (!s) { res.hidden = true; found = []; return; }
        const list = (await api.get(`/athletes/search?q=${encodeURIComponent(s)}`).catch(() => [])).filter((a) => !picked.some((x) => x.id === a.id));
        if (q.value.trim() !== s) return;
        found = list;
        mount(res, found.length ? found.map((a, i) => html`<button type="button" data-pick="${i}">${a.first_name} ${a.last_name} <span class="muted small">${a.code}${a.family ? ` · ${a.family}` : ''}</span></button>`) : html`<div class="muted small" style="padding:10px 12px">No athletes match.</div>`);
        res.hidden = false;
      }, 200));
      q.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (found.length && !res.hidden) pick(found[0]); }
        else if (e.key === 'ArrowDown' && !res.hidden) { e.preventDefault(); res.querySelector('button')?.focus(); }
        else if (e.key === 'Escape' && !res.hidden) { e.stopPropagation(); res.hidden = true; }
      });
      res.addEventListener('keydown', (e) => {
        const btns = [...res.querySelectorAll('button')], i = btns.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); btns[Math.min(i + 1, btns.length - 1)]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) q.focus(); else btns[i - 1].focus(); }
        else if (e.key === 'Escape') { e.stopPropagation(); res.hidden = true; q.focus(); }
      });
      res.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) pick(found[+b.dataset.pick]); });
    },
    actions: [{ label: 'Cancel', value: null }, { label: 'Assign', kind: 'primary', onClick: async (body) => {
      const d = formData(body.querySelector('#as-f'));
      if (!d.what) throw new Error('Choose a lesson or a course.');
      const [k, id] = d.what.split(':');
      const payload = { [k === 'c' ? 'course_id' : 'lesson_id']: Number(id), due_date: d.due_date || null, note: d.note.trim() || null };
      if (preset.team) payload.team_id = preset.team.id;
      else if (preset.athlete) payload.athlete_id = preset.athlete.id;
      else if (body.querySelector('[data-who="team"]').getAttribute('aria-pressed') === 'true') {
        payload.team_id = Number(body.querySelector('#as-t').value) || null;
        if (!payload.team_id) throw new Error('Choose a team.');
      } else {
        if (!picked.length) throw new Error('Search for an athlete and pick them from the list.');
        payload.athlete_ids = picked.map((a) => a.id);
      }
      const r = await api.post('/assignments', payload);
      if (r.assigned) {
        const who = r.assigned.length === 1 ? r.assigned[0] : plural(r.assigned.length, 'athlete');
        toast(`Assigned to ${who}. They were emailed a link.${r.skipped.length ? ` Skipped ${r.skipped.join(', ')}: already assigned.` : ''}`);
      } else toast('Assigned. They were emailed a link.');
      return true;
    } }],
  });
}

// ---- change an assignment's due date or note ----
function editAssignment(x) {
  return modal({
    title: 'Change assignment',
    body: html`<form class="stack" id="ea-f" novalidate>
      <p style="margin:0"><strong>${x.title}</strong> <span class="muted">for ${x.assigned_to}</span></p>
      <div class="field"><label class="label" for="ea-due">Due date</label><input class="input" id="ea-due" name="due_date" type="date" value="${x.due_date || ''}" style="max-width:220px">
        <span class="hint">Leave it empty for no due date. Nobody is emailed about the change.</span></div>
      <div class="field"><label class="label" for="ea-note">Note</label><textarea class="input" id="ea-note" name="note" rows="2" maxlength="500" style="min-height:64px">${x.note || ''}</textarea></div>
    </form>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Save changes', kind: 'primary', onClick: async (body) => {
      const d = formData(body.querySelector('#ea-f'));
      await api.put(`/assignments/${x.id}`, { due_date: d.due_date || null, note: d.note.trim() || null });
      toast('Assignment changed.');
      return true;
    } }],
  });
}

// ---- lesson and course editors ----
function lessonForm(l, courses) {
  return html`<form class="stack" id="ls-f" novalidate>
    <div class="field"><label class="label" for="ls-t">Title</label><input class="input" id="ls-t" name="title" value="${l.title || ''}" maxlength="120" required></div>
    <div class="field"><label class="label" for="ls-s">Short summary</label><input class="input" id="ls-s" name="summary" value="${l.summary || ''}" maxlength="300" placeholder="One line athletes see in the list"></div>
    <div class="field"><label class="label" for="ls-b">Lesson</label><textarea class="input" id="ls-b" name="body" rows="10" style="min-height:200px">${l.body || ''}</textarea>
      <span class="hint">Plain text. Leave a blank line between paragraphs.</span></div>
    <div class="form-grid">
      <div class="field"><label class="label" for="ls-v">Video link (optional)</label><input class="input" id="ls-v" name="video_url" value="${l.video_url || ''}" inputmode="url" placeholder="https://youtube.com/watch?v=…"><span class="hint">Starts with https://</span></div>
      <div class="field"><label class="label" for="ls-m">Minutes to read</label><input class="input" id="ls-m" name="minutes" type="number" min="1" max="120" step="1" value="${l.minutes ?? ''}"></div>
    </div>
    <div class="field"><label class="label" for="ls-c">Course</label><select class="input" id="ls-c" name="course_id">${options(courses, l.course_id, { blank: 'None (stands alone)', label: 'title' })}</select>
      <span class="hint">${l.id ? 'Reorder lessons with the arrows on the course.' : 'New lessons go at the end of the course.'}</span></div>
    <label class="check"><input type="checkbox" name="published" ${l.published === 0 ? '' : raw('checked')}> <span>Published<br><span class="hint">Athletes only see published lessons.</span></span></label>
  </form>`;
}
function readLesson(body) {
  const d = formData(body.querySelector('#ls-f'));
  const out = { title: d.title.trim(), summary: d.summary, body: d.body, video_url: d.video_url.trim(), minutes: d.minutes || null, course_id: d.course_id || null, published: !!d.published };
  if (!out.title) throw new Error('Give the lesson a title.');
  if (out.minutes != null && !(Number.isInteger(Number(out.minutes)) && out.minutes >= 1 && out.minutes <= 120)) throw new Error('Enter minutes to read as a whole number from 1 to 120.');
  if (out.video_url && !/^https:\/\//i.test(out.video_url)) throw new Error('Video links must start with https://');
  return out;
}
async function editLesson(l, courses) {
  const isNew = !l.id;
  let off, start;
  const r = await modal({
    title: isNew ? 'New lesson' : 'Edit lesson', wide: true, body: lessonForm(l, courses),
    onMount: (body) => { const f = body.querySelector('#ls-f'); start = snapshot(f); off = protect(body, () => snapshot(f) !== start); },
    actions: [
      { label: 'Preview', kind: 'ghost', onClick: async (body) => { const d = formData(body.querySelector('#ls-f')); lessonPreview({ ...d, published: d.published ? 1 : 0 }, courses.find((c) => String(c.id) === d.course_id)?.title); return false; } },
      { label: 'Cancel', value: null },
      { label: isNew ? 'Post lesson' : 'Save lesson', kind: 'primary', onClick: async (body) => {
        const d = readLesson(body);
        if (isNew) await api.post('/lessons', d); else await api.put(`/lessons/${l.id}`, d);
        toast(isNew ? (d.published ? 'Lesson posted.' : 'Lesson saved as a draft.') : 'Lesson saved.');
        return true;
      } },
    ],
  });
  off?.();
  return r;
}

async function editCourse(c = {}) {
  const isNew = !c.id;
  let off, start;
  const r = await modal({
    title: isNew ? 'New course' : 'Edit course',
    body: html`<form class="stack" id="cs-f" novalidate>
      <div class="field"><label class="label" for="cs-t">Title</label><input class="input" id="cs-t" name="title" value="${c.title || ''}" maxlength="120" required></div>
      <div class="field"><label class="label" for="cs-d">Description</label><textarea class="input" id="cs-d" name="description" rows="3">${c.description || ''}</textarea></div>
      <label class="check"><input type="checkbox" name="published" ${c.published === 0 ? '' : raw('checked')}> <span>Published<br><span class="hint">Athletes see a course once it's published and has a published lesson.</span></span></label>
      ${isNew ? html`<p class="hint" style="margin:0">Next, use Add lesson on the course to write its first lesson.</p>` : ''}
    </form>`,
    onMount: (body) => { const f = body.querySelector('#cs-f'); start = snapshot(f); off = protect(body, () => snapshot(f) !== start); },
    actions: [{ label: 'Cancel', value: null }, { label: isNew ? 'Create course' : 'Save course', kind: 'primary', onClick: async (body) => {
      const d = formData(body.querySelector('#cs-f'));
      if (!d.title.trim()) throw new Error('Give the course a title.');
      const payload = { title: d.title.trim(), description: d.description, published: !!d.published };
      if (isNew) await api.post('/courses', payload); else await api.put(`/courses/${c.id}`, payload);
      toast(isNew ? 'Course created.' : 'Course saved.');
      return true;
    } }],
  });
  off?.();
  return r;
}

// ---- one lesson: who read it, and everything you can do with it ----
async function lessonDetail(l, course, manage) {
  const p = await api.get(`/lessons/${l.id}/progress`);
  const pos = course ? course.lessons.findIndex((x) => x.id === l.id) : -1;
  const person = (x, when) => html`<li><span class="grow"><a href="/app/clients/${x.athlete_id}">${x.name}</a></span><span class="small muted">${when}</span></li>`;
  const actions = manage
    ? [{ label: 'Delete', kind: 'ghost', value: 'delete' }, { label: 'Duplicate', value: 'duplicate' }, { label: 'Preview', value: 'preview' }, { label: 'Edit', value: 'edit' },
      l.published ? { label: 'Assign', kind: 'primary', value: 'assign' } : { label: 'Publish', kind: 'primary', value: 'publish' }]
    : [{ label: 'Preview', value: 'preview' }, { label: 'Close', value: null }];
  return modal({
    title: l.title, wide: true,
    body: html`${STYLE}<div class="stack">
      <div class="row small muted">${course ? `${course.title} · Lesson ${pos + 1} of ${course.lessons.length}` : 'Standalone lesson'}
        ${l.published ? badge('active', 'Published') : badge('draft')}${[l.minutes ? `${l.minutes} min` : null, l.video_url ? 'Video' : null].filter(Boolean).map((t) => html`<span>· ${t}</span>`)}</div>
      ${l.summary ? html`<p style="margin:0">${l.summary}</p>` : ''}
      <div class="edu-dstats"><div><strong>${p.finished.length}</strong><span>Finished</span></div><div><strong>${p.opened.length}</strong><span>Opened, not done</span></div><div><strong>${p.assignments.length}</strong><span>Assignments</span></div></div>
      <div class="edu-dsec"><h3>Finished</h3>${p.finished.length ? html`<ul class="edu-people">${p.finished.map((x) => person(x, `Finished ${relTime(x.completed_at)}`))}</ul>` : html`<p class="muted small" style="margin:0">Nobody has finished it yet.</p>`}</div>
      ${p.opened.length ? html`<div class="edu-dsec"><h3>Opened, not finished</h3><ul class="edu-people">${p.opened.map((x) => person(x, `Opened ${relTime(x.opened_at)}`))}</ul></div>` : ''}
      ${p.assignments.length ? html`<div class="edu-dsec"><h3>Assigned to</h3><ul class="edu-people">${p.assignments.map((x) => html`<li><span class="grow">${x.athlete_id ? html`<a href="/app/clients/${x.athlete_id}">${x.assigned_to}</a>` : x.assigned_to}${x.team_id ? html` <span class="muted small">(team)</span>` : ''}</span><span class="small muted">${x.due_date ? `Due ${fmtDate(x.due_date, { year: false })}` : 'No due date'}</span></li>`)}</ul></div>` : ''}
    </div>`,
    onMount: (body, close) => body.addEventListener('click', (e) => { if (e.target.closest('a[href]')) close(null); }),
    actions,
  });
}

// ---- the screen ----
async function renderEducation(ctx) {
  const manage = canManage(ctx);
  const q0 = ctx.query;
  const st = {
    tab: ['assigned', 'library', 'activity'].includes(q0.tab) ? q0.tab : 'assigned',
    show: ['open', 'overdue', 'finished', 'all'].includes(q0.show) ? q0.show : 'open',
    q: q0.q || '', lq: q0.lq || '',
    lshow: ['all', 'published', 'drafts'].includes(q0.lshow) ? q0.lshow : 'all',
  };
  let d = await api.get('/education');
  if (!ctx.isCurrent()) return;
  let byId, courseById;
  const index = () => {
    byId = new Map([...d.lessons, ...d.courses.flatMap((c) => c.lessons)].map((l) => [l.id, l]));
    courseById = new Map(d.courses.map((c) => [c.id, c]));
  };
  index();
  const setUrl = () => {
    const p = new URLSearchParams();
    if (st.tab !== 'assigned') p.set('tab', st.tab);
    if (st.show !== 'open') p.set('show', st.show);
    if (st.q) p.set('q', st.q);
    if (st.lq) p.set('lq', st.lq);
    if (st.lshow !== 'all') p.set('lshow', st.lshow);
    history.replaceState(history.state, '', `/app/education${p.toString() ? `?${p}` : ''}`);
  };
  // Refresh the data in place: keeps the tab, filters and scroll position.
  const refresh = async () => {
    d = await api.get('/education');
    if (!ctx.isCurrent()) return;
    index(); paint();
  };

  // ---- assignments ----
  const SHOW = [['open', 'Open', (x) => x.status !== 'finished'], ['overdue', 'Overdue', (x) => x.status === 'overdue'], ['finished', 'Finished', (x) => x.status === 'finished'], ['all', 'All', () => true]];
  const rank = { overdue: 0, open: 1, finished: 2 };
  const sorted = () => d.assignments.slice().sort((a, b) => rank[a.status] - rank[b.status]
    || (a.status === 'finished' ? b.id - a.id : (a.due_date || '9999').localeCompare(b.due_date || '9999') || b.id - a.id));

  const assignmentRow = (x) => {
    const late = x.status === 'overdue';
    const pct = x.total ? Math.round((x.finished / x.total) * 100) : 0;
    const unfinished = x.total - x.finished;
    const solo = x.athlete_id ? x.people[0] : null;
    const who = x.athlete_id ? html`<a href="/app/clients/${x.athlete_id}">${x.assigned_to || 'an archived athlete'}</a>`
      : x.team_id && ctx.me.role === 'owner' ? html`<a href="/app/teams/${x.team_id}">${x.assigned_to}</a>` : x.assigned_to || 'a removed team';
    const recent = remindedRecently(x);
    return html`<div class="edu-row edu-arow">
      <div class="edu-grow"><div class="edu-title">${x.title} <span class="muted small">${x.type === 'course' ? 'Course' : 'Lesson'}</span> ${late ? badge('overdue') : x.status === 'finished' ? badge('complete', 'Finished') : ''}</div>
        <div class="edu-sub">For ${who}${x.team_id ? ' (team)' : ''}
          · ${x.due_date ? html`<span class="${late ? 'warn-text' : ''}">${late ? 'was due' : 'due'} ${fmtDate(x.due_date, { year: false, weekday: true })}</span>` : 'no due date'}
          · assigned ${fmtDate(x.created_at, { year: false })}${x.assigned_by ? ` by ${x.assigned_by.split(' ')[0]}` : ''}</div>
        ${x.note ? html`<div class="edu-sub">"${x.note}"</div>` : ''}
        ${x.reminded_at ? html`<div class="edu-sub">Reminder sent ${relTime(x.reminded_at)}</div>` : ''}
        ${solo && solo.status !== 'finished' ? html`<div class="edu-sub" style="margin-top:4px">${PERSON[solo.status](solo)}</div>` : ''}
        ${!solo && x.people.length ? html`<details class="edu-who"><summary>Where everyone is (${x.started ? `${x.started} started, ` : ''}${unfinished} not finished)</summary>
          <ul class="edu-people">${x.people.map((p) => html`<li><span class="grow"><a href="/app/clients/${p.id}">${p.name}</a></span>${PERSON[p.status](p)}${p.completed_at ? html`<span class="small muted">${fmtDate(p.completed_at, { year: false })}</span>` : ''}</li>`)}</ul></details>` : ''}
        ${!solo && !x.people.length ? html`<div class="edu-sub">${x.athlete_id ? 'This athlete is archived, so nobody can read it.' : 'Nobody is on this roster yet.'}</div>` : ''}</div>
      <div class="edu-acts"><div class="stack-sm" style="gap:4px"><span class="small ${x.status === 'finished' ? 'good-text' : late ? 'warn-text' : ''}">${x.finished} of ${x.total} finished</span><div class="bar edu-bar" role="progressbar" aria-label="${x.title}: ${x.finished} of ${x.total} finished" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div></div>
        ${manage && unfinished > 0 ? html`<button class="btn btn-ghost btn-sm" data-act="remind" data-id="${x.id}" ${recent ? raw('disabled title="A reminder went out in the last 12 hours"') : ''}>${recent ? 'Reminded' : 'Remind'}</button>` : ''}
        ${manage ? html`<button class="btn btn-ghost btn-sm" data-act="change" data-id="${x.id}">Change</button><button class="btn btn-ghost btn-sm" data-act="unassign" data-id="${x.id}">Remove</button>` : ''}</div></div>`;
  };

  function paintAssigned(panel) {
    const counts = Object.fromEntries(SHOW.map(([k, , f]) => [k, d.assignments.filter(f).length]));
    const canSweep = manage && d.assignments.some((x) => x.status === 'overdue' && !remindedRecently(x));
    mount(panel, html`<div class="edu-tools" role="search">
        <label class="sr-only" for="aq">Find an assignment</label><input class="input edu-q" id="aq" type="search" placeholder="Find an athlete, team or lesson" value="${st.q}" autocomplete="off">
        <div class="seg" role="group" aria-label="Show">${SHOW.map(([k, l]) => html`<button type="button" data-show="${k}" aria-pressed="${st.show === k}">${l}<span class="edu-cnt">${counts[k]}</span></button>`)}</div>
      </div>
      <div class="edu-bar2"><p class="small muted" id="acount" aria-live="polite" style="margin:0"></p>
        ${manage ? html`<div class="btn-row">${canSweep ? html`<button class="btn btn-outline btn-sm" data-act="remind-overdue">Remind overdue</button>` : ''}
          <button class="btn btn-outline btn-sm" data-act="assign">Assign lesson</button></div>` : ''}</div>
      <div id="alist"></div>`);
    const q = panel.querySelector('#aq');
    q.addEventListener('input', debounce(() => { st.q = q.value.trim(); setUrl(); list(); }, 120));
    panel.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => {
      st.show = b.dataset.show; setUrl();
      panel.querySelectorAll('[data-show]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      list();
    }));
    const list = () => {
      const term = st.q.toLowerCase();
      const f = SHOW.find(([k]) => k === st.show)[2];
      const rows = sorted().filter(f).filter((x) => matches(term, x.title, x.assigned_to, ...x.people.map((p) => p.name)));
      panel.querySelector('#acount').textContent = d.assignments.length ? `Showing ${plural(rows.length, 'assignment')}.` : '';
      const empty = !d.assignments.length ? (manage ? 'Nothing assigned yet. Assign a lesson or course to athletes or a whole team, and see who has read it.' : 'Nothing assigned yet.')
        : term ? 'No assignments match that search.' : st.show === 'overdue' ? 'Nothing is overdue.' : st.show === 'finished' ? 'No assignment is finished by everyone yet.' : 'Everything assigned is finished.';
      mount(panel.querySelector('#alist'), rows.length ? html`<div>${rows.map(assignmentRow)}</div>` : html`<div class="empty">${empty}</div>`);
    };
    list();
  }

  // ---- library ----
  const LSHOW = [['all', 'All', () => true], ['published', 'Published', (l) => !!l.published], ['drafts', 'Drafts', (l) => !l.published]];
  const lessonRow = (l, i, list, reorder) => html`<div class="edu-row">
    ${list ? html`<span class="edu-n">${i + 1}</span>` : ''}
    <div class="edu-grow"><div class="edu-title"><button class="edu-link" data-act="open" data-id="${l.id}" aria-label="${l.title}: who has read it and more">${l.title}</button> ${l.published ? '' : badge('draft')}</div>
      <div class="edu-sub">${[l.summary, l.minutes ? `${l.minutes} min` : null, l.video_url ? 'video' : null, `${l.completions} finished`, l.opened ? `${l.opened} opened` : null].filter(Boolean).join(' · ')}</div></div>
    <div class="edu-acts">${manage && reorder && list.length > 1 ? html`<button class="btn btn-ghost btn-sm edu-mv" data-act="up" data-id="${l.id}" ${i === 0 ? raw('disabled') : ''} aria-label="Move ${l.title} up">${icon('chevron', 16)}</button><button class="btn btn-ghost btn-sm edu-mv dn" data-act="down" data-id="${l.id}" ${i === list.length - 1 ? raw('disabled') : ''} aria-label="Move ${l.title} down">${icon('chevron', 16)}</button>` : ''}
      ${manage ? html`${l.published ? html`<button class="btn btn-ghost btn-sm" data-act="assign-lesson" data-id="${l.id}">Assign</button>` : html`<button class="btn btn-ghost btn-sm" data-act="publish" data-id="${l.id}">Publish</button>`}
        <button class="btn btn-ghost btn-sm" data-act="edit" data-id="${l.id}">Edit</button>`
        : html`<button class="btn btn-ghost btn-sm" data-act="preview" data-id="${l.id}">Preview</button>`}</div></div>`;

  function paintLibrary(panel) {
    const every = [...byId.values()];
    const counts = Object.fromEntries(LSHOW.map(([k, , f]) => [k, every.filter(f).length]));
    mount(panel, html`<div class="edu-tools" role="search">
        <label class="sr-only" for="lq">Find a lesson</label><input class="input edu-q" id="lq" type="search" placeholder="Find a lesson or course" value="${st.lq}" autocomplete="off">
        <div class="seg" role="group" aria-label="Show">${LSHOW.map(([k, l]) => html`<button type="button" data-lshow="${k}" aria-pressed="${st.lshow === k}">${l}<span class="edu-cnt">${counts[k]}</span></button>`)}</div>
        <span class="edu-sp"></span>
        ${manage ? html`<button class="btn btn-outline btn-sm" data-act="new-course">New course</button>` : ''}
      </div>
      <div id="llist" class="stack"></div>`);
    const q = panel.querySelector('#lq');
    q.addEventListener('input', debounce(() => { st.lq = q.value.trim(); setUrl(); list(); }, 120));
    panel.querySelectorAll('[data-lshow]').forEach((b) => b.addEventListener('click', () => {
      st.lshow = b.dataset.lshow; setUrl();
      panel.querySelectorAll('[data-lshow]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      list();
    }));
    const list = () => {
      const term = st.lq.toLowerCase();
      const f = LSHOW.find(([k]) => k === st.lshow)[2];
      const filtering = !!term || st.lshow !== 'all';
      const keep = (l, c) => f(l) && matches(term, l.title, l.summary, c?.title);
      const courses = d.courses.map((c) => ({ c, ls: c.lessons.filter((l) => keep(l, c)) }))
        .filter(({ c, ls }) => !filtering || ls.length || (matches(term, c.title, c.description) && (st.lshow === 'all' || (st.lshow === 'drafts' ? !c.published : c.published))));
      const loose = d.lessons.filter((l) => keep(l));
      const courseCard = ({ c, ls }) => {
        const assignable = c.published && c.lessons.some((l) => l.published);
        return html`<div class="edu-course">
          <div class="spread"><div><div class="edu-course-title">${c.title} ${c.published ? '' : badge('draft')}</div>
            <div class="edu-sub">${[c.description, plural(c.lessons.length, 'lesson'), c.finishers ? `${plural(c.finishers, 'athlete')} finished it` : null, c.assigned ? `assigned ${plural(c.assigned, 'time')}` : null].filter(Boolean).join(' · ')}</div></div>
            ${manage ? html`<div class="edu-acts"><button class="btn btn-ghost btn-sm" data-act="add-lesson" data-id="${c.id}">Add lesson</button>
              ${assignable ? html`<button class="btn btn-ghost btn-sm" data-act="assign-course" data-id="${c.id}">Assign</button>` : c.published ? '' : html`<button class="btn btn-ghost btn-sm" data-act="publish-course" data-id="${c.id}">Publish</button>`}
              <button class="btn btn-ghost btn-sm" data-act="edit-course" data-id="${c.id}">Edit</button>
              <button class="btn btn-ghost btn-sm" data-act="delete-course" data-id="${c.id}">Delete</button></div>` : ''}</div>
          ${ls.length ? html`<div>${ls.map((l, i, arr) => lessonRow(l, filtering ? c.lessons.indexOf(l) : i, filtering ? c.lessons : arr, !filtering))}</div>`
            : html`<p class="edu-sub" style="margin:0">${c.lessons.length ? 'No lessons here match.' : `No lessons yet.${manage ? ' Use Add lesson to write the first one.' : ''}`}</p>`}
        </div>`;
      };
      mount(panel.querySelector('#llist'), html`
        <section class="stack-sm" aria-labelledby="edu-co-h"><div><h2 class="panel-title" id="edu-co-h">Courses</h2><p class="panel-sub" style="margin:0">A few lessons read in order. Deleting a course keeps its lessons.</p></div>
          ${courses.length ? courses.map(courseCard) : html`<div class="empty">${filtering ? 'No courses match.' : 'No courses yet. A course is a few lessons read in order.'}</div>`}</section>
        <section class="stack-sm" aria-labelledby="edu-lib-h"><div><h2 class="panel-title" id="edu-lib-h">Standalone lessons</h2><p class="panel-sub" style="margin:0">Lessons outside a course.</p></div>
          ${loose.length ? html`<div>${loose.map((l) => lessonRow(l, 0, null, false))}</div>` : html`<div class="empty">${filtering ? 'No standalone lessons match.' : 'No standalone lessons.'}</div>`}</section>`);
    };
    list();
  }

  // ---- recently finished ----
  function paintActivity(panel) {
    mount(panel, d.recent.length ? html`<p class="small muted" style="margin:0">Lessons athletes marked done, newest first.</p><ul class="edu-people">${d.recent.map((r) => html`<li><span class="grow"><a href="/app/clients/${r.athlete_id}">${r.name}</a> finished
        <button class="edu-link" data-act="open" data-id="${r.lesson_id}">${r.title}</button>${r.course ? html` <span class="muted small">in ${r.course}</span>` : ''}</span>
        <span class="small muted">${relTime(r.completed_at)}</span></li>`)}</ul>`
      : html`<div class="empty">No lessons finished yet. When an athlete marks a lesson done, it shows up here.</div>`);
  }

  function paint() {
    const s = d.stats;
    const TABS = [['assigned', 'Assigned', s.open], ['library', 'Library', byId.size], ['activity', 'Recent', null]];
    mount(ctx.el, html`${STYLE}<div class="stack edu">
      <header class="page-header"><div><h1 class="page-title">Education</h1><p class="page-sub">Short lessons and courses athletes read in their app. Assign them and see who has finished.</p></div>
        ${manage ? html`<button class="btn btn-primary" data-act="new-lesson">${icon('plus')}New lesson</button>` : ''}</header>
      ${manage ? '' : html`<div class="banner info">Front desk can view lessons and assignments. An owner or coach makes changes.</div>`}
      <div class="metrics">
        <div class="metric"><span class="metric-label">Open assignments</span><span class="metric-value">${s.open}</span><span class="metric-note">${s.finished} finished by everyone</span></div>
        <div class="metric"><span class="metric-label">Overdue</span><span class="metric-value ${s.overdue ? 'warn' : ''}">${s.overdue}</span><span class="metric-note">Past due, not finished</span></div>
        <div class="metric"><span class="metric-label">Finished, last 7 days</span><span class="metric-value ${s.finished_week ? 'good' : ''}">${s.finished_week}</span><span class="metric-note">${s.readers_week ? `By ${plural(s.readers_week, 'athlete')}` : 'Lessons marked done'}</span></div>
        <div class="metric"><span class="metric-label">Published lessons</span><span class="metric-value">${s.published}</span><span class="metric-note">${s.drafts ? `${plural(s.drafts, 'draft')}` : 'No drafts'}</span></div>
      </div>
      <section class="panel stack">
        <div class="tabs" role="tablist" aria-label="Education">
          ${TABS.map(([k, l, n]) => html`<button role="tab" id="edu-tab-${k}" data-tab="${k}" aria-controls="edu-panel" aria-selected="${st.tab === k}" tabindex="${st.tab === k ? 0 : -1}">${l}${n != null ? html`<span class="edu-cnt">${n}</span>` : ''}</button>`)}
        </div>
        <div id="edu-panel" role="tabpanel" aria-labelledby="edu-tab-${st.tab}" class="stack"></div>
      </section>
    </div>`);
    const tabs = [...ctx.el.querySelectorAll('[data-tab]')];
    const pick = (k) => { if (st.tab === k) return; st.tab = k; setUrl(); paint(); ctx.el.querySelector(`#edu-tab-${k}`)?.focus(); };
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => pick(b.dataset.tab));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        pick(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].dataset.tab);
      });
    });
    const panel = ctx.el.querySelector('#edu-panel');
    if (st.tab === 'assigned') paintAssigned(panel); else if (st.tab === 'library') paintLibrary(panel); else paintActivity(panel);
    ctx.el.querySelector('.edu').addEventListener('click', onClick);
  }

  async function lessonAction(act, l) {
    const course = courseById.get(l.course_id);
    switch (act) {
      case 'preview': return lessonPreview(l, course?.title);
      case 'edit': if (await editLesson(l, d.courses)) await refresh(); return;
      case 'assign': if (await assignDialog({ lesson_id: l.id })) await refresh(); return;
      case 'publish':
        await api.put(`/lessons/${l.id}`, { published: true });
        toast(course && !course.published ? `Published. Athletes see it once "${course.title}" is published.` : 'Published. Athletes can read it now.');
        return refresh();
      case 'duplicate': {
        const r = await api.post(`/lessons/${l.id}/duplicate`);
        toast(`Saved "${r.title}" as a draft.`);
        await refresh();
        const copy = byId.get(r.id);
        if (copy && (await editLesson(copy, d.courses))) await refresh();
        return;
      }
      case 'delete':
        if (!(await confirmDialog(`Delete "${l.title}"?`, `It comes off every athlete's list, along with any assignments of it. ${l.completions ? `${plural(l.completions, 'athlete')} finished it; that record goes too. To hide it but keep the record, edit it and untick Published.` : ''}`, 'Delete lesson', 'warn'))) return;
        await api.del(`/lessons/${l.id}`); toast('Lesson deleted.'); return refresh();
    }
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    const l = byId.get(id);
    const x = d.assignments.find((y) => y.id === id);
    try {
      switch (b.dataset.act) {
        case 'open': {
          if (!l) return;
          const act = await lessonDetail(l, courseById.get(l.course_id), manage);
          if (act) await lessonAction(act, l);
          return;
        }
        case 'preview': case 'edit': case 'publish': return await lessonAction(b.dataset.act, l);
        case 'assign-lesson': return await lessonAction('assign', l);
        case 'new-lesson': if (await editLesson({ published: 1 }, d.courses)) await refresh(); return;
        case 'add-lesson': if (await editLesson({ published: 1, course_id: id }, d.courses)) await refresh(); return;
        case 'new-course': if (await editCourse()) await refresh(); return;
        case 'edit-course': if (await editCourse(courseById.get(id))) await refresh(); return;
        case 'publish-course': {
          const c = courseById.get(id);
          await api.put(`/courses/${id}`, { published: true });
          toast(c.lessons.some((y) => y.published) ? 'Course published. Athletes can see it now.' : 'Course published. Athletes see it once one of its lessons is published.');
          return await refresh();
        }
        case 'delete-course': {
          const c = courseById.get(id);
          if (!(await confirmDialog(`Delete "${c.title}"?`, `Its ${plural(c.lessons.length, 'lesson')} stay as standalone lessons. Assignments of the course are removed.`, 'Delete course', 'warn'))) return;
          await api.del(`/courses/${id}`); toast('Course deleted. Its lessons are now standalone.'); return await refresh();
        }
        case 'up': case 'down': {
          const list = courseById.get(l.course_id).lessons.slice();
          const i = list.findIndex((y) => y.id === id), j = b.dataset.act === 'up' ? i - 1 : i + 1;
          [list[i], list[j]] = [list[j], list[i]];
          b.disabled = true;
          await api.put(`/courses/${l.course_id}/order`, { lesson_ids: list.map((y) => y.id) });
          await refresh();
          ctx.el.querySelector(`[data-act="${b.dataset.act}"][data-id="${id}"]:not([disabled])`)?.focus();
          return;
        }
        case 'assign': if (await assignDialog()) await refresh(); return;
        case 'assign-course': if (await assignDialog({ course_id: id })) await refresh(); return;
        case 'change': if (await editAssignment(x)) await refresh(); return;
        case 'remind': {
          const names = x.people.filter((p) => p.status !== 'finished').map((p) => p.name);
          const who = names.length <= 3 ? names.join(', ') : plural(names.length, 'athlete');
          if (!(await confirmDialog('Send a reminder?', `${who} and their parents get an email about "${x.title}". Athletes who finished are left out.`, 'Send reminder'))) return;
          b.disabled = true;
          const r = await api.post(`/assignments/${id}/remind`);
          toast(`Reminder sent to ${plural(r.sent, 'athlete')}.`);
          return await refresh();
        }
        case 'remind-overdue': {
          const due = d.assignments.filter((y) => y.status === 'overdue' && !remindedRecently(y));
          const people = due.reduce((n, y) => n + y.total - y.finished, 0);
          if (!(await confirmDialog('Remind everyone overdue?', `${plural(people, 'athlete')} on ${plural(due.length, 'overdue assignment')} and their parents get a reminder email. Assignments reminded in the last 12 hours are skipped.`, 'Send reminders'))) return;
          b.disabled = true;
          const r = await api.post('/assignments/remind-overdue');
          toast(r.assignments ? `Reminders sent to ${plural(r.athletes, 'athlete')} on ${plural(r.assignments, 'assignment')}.` : 'Nothing to send. Every overdue assignment was reminded in the last 12 hours.');
          return await refresh();
        }
        case 'unassign':
          if (!(await confirmDialog('Remove this assignment?', `"${x.title}" comes off the list for ${x.assigned_to || 'them'}. Anything already finished stays finished.`, 'Remove', 'warn'))) return;
          await api.del(`/assignments/${id}`); toast('Assignment removed.'); return await refresh();
      }
    } catch (err) { toastError(err); if (b.isConnected) b.disabled = false; }
  }

  paint();
}

export const routes = [
  { path: '/education', nav: 'education', title: 'Education', render: renderEducation },
];
