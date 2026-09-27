// Education: lessons, courses and assigned reading. Owners and coaches manage; front desk views.
// Also exports assignDialog() and lessonPreview(), used by the client profile and team contract.
import { html, raw, mount, api, icon, fmtDate, localISO, toast, toastError, modal, confirmDialog, formData, options, debounce, plural, badge } from '/js/ui.js';
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
.edu details.edu-who summary{cursor:pointer;font-size:13px;color:var(--steel-muted);list-style:none;display:inline-flex;align-items:center;gap:6px;min-height:28px}
.edu details.edu-who summary::-webkit-details-marker{display:none}
.edu details.edu-who summary::before{content:'';border:4px solid transparent;border-left:6px solid currentColor;border-right:0}
.edu details.edu-who[open] summary::before{transform:rotate(90deg)}
.edu .edu-bar{width:120px}
@media (max-width:600px){.edu .edu-acts{width:100%}.edu .edu-bar{width:100%}}
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
</style>`;

const paragraphs = (body) => String(body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const overdue = (due) => due && due < localISO();

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

// ---- assign a lesson or course to an athlete or a team ----
// preset: { athlete: {id, name} } or { team: {id, name} } fixes who; { lesson_id } or { course_id } preselects what.
export async function assignDialog(preset = {}) {
  const [edu, lookups] = await Promise.all([api.get('/education'), preset.athlete || preset.team ? null : api.get('/lookups')]);
  const courses = edu.courses.filter((c) => c.published);
  const lessons = [...edu.lessons, ...edu.courses.flatMap((c) => c.lessons)].filter((l) => l.published);
  if (!courses.length && !lessons.length) { toastError(new Error('Publish a lesson first. Lessons and courses are on the Education page.')); return null; }
  const pre = preset.course_id ? `c:${preset.course_id}` : preset.lesson_id ? `l:${preset.lesson_id}` : '';
  const fixed = preset.athlete || preset.team;
  let athleteId = preset.athlete?.id || null;
  return modal({
    title: 'Assign lesson',
    body: html`${STYLE}<form class="stack" id="as-f" novalidate>
      <div class="field"><label class="label" for="as-what">Lesson or course</label>
        <select class="input" id="as-what" name="what"><option value="">Choose one</option>
          ${courses.length ? html`<optgroup label="Courses">${courses.map((c) => html`<option value="c:${c.id}" ${pre === `c:${c.id}` ? raw('selected') : ''}>${c.title} (${plural(c.lessons.filter((l) => l.published).length, 'lesson')})</option>`)}</optgroup>` : ''}
          <optgroup label="Lessons">${lessons.map((l) => html`<option value="l:${l.id}" ${pre === `l:${l.id}` ? raw('selected') : ''}>${l.title}</option>`)}</optgroup>
        </select></div>
      ${fixed ? html`<div class="field"><span class="label">For</span><div>${fixed.name}${preset.team ? html` <span class="muted small">(everyone on the roster)</span>` : ''}</div></div>`
        : html`<div class="field"><span class="label" id="as-wl">For</span>
          <div class="seg" role="group" aria-labelledby="as-wl"><button type="button" data-who="athlete" aria-pressed="true">An athlete</button><button type="button" data-who="team" aria-pressed="false">A team</button></div></div>
        <div class="field edu-pick" id="as-ath"><label class="label" for="as-q">Athlete</label>
          <input class="input" id="as-q" type="search" placeholder="Name or Athlete ID" autocomplete="off">
          <div class="edu-results" id="as-res" hidden></div></div>
        <div class="field" id="as-team" hidden><label class="label" for="as-t">Team</label>
          <select class="input" id="as-t">${options(lookups.teams, '', { blank: 'Choose a team', label: (t) => `${t.school} ${t.team_name}` })}</select>
          <span class="hint">Everyone on the roster gets it, including athletes added later.</span></div>`}
      <div class="form-grid">
        <div class="field"><label class="label" for="as-due">Due date (optional)</label><input class="input" id="as-due" name="due_date" type="date" min="${localISO()}"></div>
      </div>
      <div class="field"><label class="label" for="as-note">Note (optional)</label><textarea class="input" id="as-note" name="note" rows="2" maxlength="500" style="min-height:64px" placeholder="Why it matters, or where to start"></textarea>
        <span class="hint">The athlete and their parents are emailed a link.</span></div>
    </form>`,
    onMount: (body) => {
      if (fixed) return;
      const segs = body.querySelectorAll('[data-who]');
      segs.forEach((b) => b.addEventListener('click', () => {
        segs.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        body.querySelector('#as-ath').hidden = b.dataset.who !== 'athlete';
        body.querySelector('#as-team').hidden = b.dataset.who !== 'team';
      }));
      const q = body.querySelector('#as-q'), res = body.querySelector('#as-res');
      let found = [];
      q.addEventListener('input', debounce(async () => {
        athleteId = null;
        const s = q.value.trim();
        if (!s) { res.hidden = true; return; }
        found = await api.get(`/athletes/search?q=${encodeURIComponent(s)}`).catch(() => []);
        mount(res, found.length ? found.map((a, i) => html`<button type="button" data-pick="${i}">${a.first_name} ${a.last_name} <span class="muted small">${a.code}${a.family ? ` · ${a.family}` : ''}</span></button>`) : html`<div class="muted small" style="padding:10px 12px">No athletes match.</div>`);
        res.hidden = false;
      }, 200));
      res.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick]'); if (!b) return;
        const a = found[+b.dataset.pick];
        athleteId = a.id; q.value = `${a.first_name} ${a.last_name}`; res.hidden = true;
      });
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
        if (!athleteId) throw new Error('Search for the athlete and pick them from the list.');
        payload.athlete_id = athleteId;
      }
      await api.post('/assignments', payload);
      toast('Assigned. They were emailed a link.');
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
      <div class="field"><label class="label" for="ls-m">Minutes to read</label><input class="input" id="ls-m" name="minutes" type="number" min="1" max="120" value="${l.minutes ?? ''}"></div>
    </div>
    <div class="form-grid">
      <div class="field"><label class="label" for="ls-c">Course</label><select class="input" id="ls-c" name="course_id">${options(courses, l.course_id, { blank: 'None (stands alone)', label: 'title' })}</select></div>
      <div class="field"><label class="label" for="ls-o">Order in course</label><input class="input" id="ls-o" name="ord" type="number" min="0" max="999" value="${l.ord ?? ''}" placeholder="Last"><span class="hint">Lower numbers come first.</span></div>
    </div>
    <label class="check"><input type="checkbox" name="published" ${l.published === 0 ? '' : raw('checked')}> <span>Published<br><span class="hint">Athletes only see published lessons.</span></span></label>
  </form>`;
}
function readLesson(body, isNew) {
  const d = formData(body.querySelector('#ls-f'));
  const out = { title: d.title.trim(), summary: d.summary, body: d.body, video_url: d.video_url.trim(), minutes: d.minutes || null, course_id: d.course_id || null, published: !!d.published };
  if (d.ord !== '') out.ord = Number(d.ord);
  else if (!isNew) out.ord = 0;
  if (!out.title) throw new Error('Give the lesson a title.');
  if (out.video_url && !/^https:\/\//i.test(out.video_url)) throw new Error('Video links must start with https://');
  return out;
}
async function editLesson(l, courses) {
  const isNew = !l.id;
  const r = await modal({
    title: isNew ? 'New lesson' : 'Edit lesson', wide: true, body: lessonForm(l, courses),
    actions: [
      { label: 'Preview', kind: 'ghost', onClick: async (body) => { const d = formData(body.querySelector('#ls-f')); lessonPreview({ ...d, published: d.published ? 1 : 0 }, courses.find((c) => String(c.id) === d.course_id)?.title); return false; } },
      { label: 'Cancel', value: null },
      { label: isNew ? 'Post lesson' : 'Save lesson', kind: 'primary', onClick: async (body) => {
        const d = readLesson(body, isNew);
        if (isNew) await api.post('/lessons', d); else await api.put(`/lessons/${l.id}`, d);
        toast(isNew ? (d.published ? 'Lesson posted.' : 'Lesson saved as a draft.') : 'Lesson saved.');
        return true;
      } },
    ],
  });
  return r;
}

async function editCourse(c = {}) {
  const isNew = !c.id;
  return modal({
    title: isNew ? 'New course' : 'Edit course',
    body: html`<form class="stack" id="cs-f" novalidate>
      <div class="field"><label class="label" for="cs-t">Title</label><input class="input" id="cs-t" name="title" value="${c.title || ''}" maxlength="120" required></div>
      <div class="field"><label class="label" for="cs-d">Description</label><textarea class="input" id="cs-d" name="description" rows="3">${c.description || ''}</textarea></div>
      <label class="check"><input type="checkbox" name="published" ${c.published === 0 ? '' : raw('checked')}> <span>Published<br><span class="hint">Athletes see a course once it's published and has a published lesson.</span></span></label>
      ${isNew ? html`<p class="hint" style="margin:0">Next, add lessons to it: create a lesson and choose this course.</p>` : ''}
    </form>`,
    actions: [{ label: 'Cancel', value: null }, { label: isNew ? 'Create course' : 'Save course', kind: 'primary', onClick: async (body) => {
      const d = formData(body.querySelector('#cs-f'));
      if (!d.title.trim()) throw new Error('Give the course a title.');
      const payload = { title: d.title.trim(), description: d.description, published: !!d.published };
      if (isNew) await api.post('/courses', payload); else await api.put(`/courses/${c.id}`, payload);
      toast(isNew ? 'Course created.' : 'Course saved.');
      return true;
    } }],
  });
}

// ---- the screen ----
async function renderEducation(ctx) {
  const manage = canManage(ctx);
  const d = await api.get('/education');
  if (!ctx.isCurrent()) return;
  const allLessons = [...d.lessons, ...d.courses.flatMap((c) => c.lessons)];
  const byId = new Map(allLessons.map((l) => [l.id, l]));
  const courseById = new Map(d.courses.map((c) => [c.id, c]));

  const lessonRow = (l, i, list) => html`<div class="edu-row">
    ${list ? html`<span class="edu-n">${i + 1}</span>` : ''}
    <div class="edu-grow"><div class="edu-title">${l.title} ${l.published ? '' : badge('draft')}</div>
      <div class="edu-sub">${[l.summary, l.minutes ? `${l.minutes} min` : null, l.video_url ? 'video' : null, `${plural(l.completions, 'athlete')} finished`].filter(Boolean).join(' · ')}</div></div>
    <div class="edu-acts">${manage && list && list.length > 1 ? html`<button class="btn btn-ghost btn-sm edu-mv" data-act="up" data-id="${l.id}" ${i === 0 ? raw('disabled') : ''} aria-label="Move ${l.title} up">${icon('chevron', 16)}</button><button class="btn btn-ghost btn-sm edu-mv dn" data-act="down" data-id="${l.id}" ${i === list.length - 1 ? raw('disabled') : ''} aria-label="Move ${l.title} down">${icon('chevron', 16)}</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="preview" data-id="${l.id}">Preview</button>
      ${manage ? html`<button class="btn btn-ghost btn-sm" data-act="edit" data-id="${l.id}">Edit</button>
        ${l.published ? html`<button class="btn btn-ghost btn-sm" data-act="assign-lesson" data-id="${l.id}">Assign</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-act="delete" data-id="${l.id}">Delete</button>` : ''}</div></div>`;

  const assignmentRow = (x) => {
    const late = overdue(x.due_date) && x.finished < x.total;
    const pct = x.total ? Math.round((x.finished / x.total) * 100) : 0;
    return html`<div class="edu-row">
      <div class="edu-grow"><div class="edu-title">${x.title} <span class="muted small">${x.type === 'course' ? 'Course' : 'Lesson'}</span></div>
        <div class="edu-sub">For ${x.athlete_id ? html`<a href="/app/clients/${x.athlete_id}">${x.assigned_to}</a>` : x.team_id && ctx.me.role === 'owner' ? html`<a href="/app/teams/${x.team_id}">${x.assigned_to}</a>` : x.assigned_to || 'nobody'}
          · ${x.due_date ? html`<span class="${late ? 'warn-text' : ''}">${late ? 'overdue, was due' : 'due'} ${fmtDate(x.due_date, { year: false })}</span>` : 'no due date'}</div>
        ${x.note ? html`<div class="edu-sub">"${x.note}"</div>` : ''}
        ${x.not_finished.length ? html`<details class="edu-who"><summary>Who hasn't finished (${x.total - x.finished})</summary><div class="small">${x.not_finished.join(', ')}${x.total - x.finished > x.not_finished.length ? ` and ${x.total - x.finished - x.not_finished.length} more` : ''}</div></details>` : ''}</div>
      <div class="edu-acts"><div class="stack-sm" style="gap:4px"><span class="small ${x.finished === x.total && x.total ? 'good-text' : late ? 'warn-text' : ''}">${x.finished} of ${x.total} finished</span><div class="bar edu-bar"><span style="width:${pct}%"></span></div></div>
        ${manage ? html`<button class="btn btn-ghost btn-sm" data-act="unassign" data-id="${x.id}">Remove</button>` : ''}</div></div>`;
  };

  mount(ctx.el, html`${STYLE}<div class="stack edu">
    <header class="page-header"><div><h1 class="page-title">Education</h1><p class="page-sub">Short lessons and courses athletes read in their app. Assign them and see who has finished.</p></div>
      ${manage ? html`<button class="btn btn-primary" data-act="new-lesson">New lesson</button>` : ''}</header>
    ${manage ? '' : html`<div class="banner info">Front desk can view lessons and assignments. An owner or coach makes changes.</div>`}

    <section class="panel">
      <div class="panel-head"><div><h2 class="panel-title">Assigned</h2><p class="panel-sub">${d.assignments.length ? `${plural(d.assignments.length, 'assignment')}. Athletes and parents are emailed when you assign.` : 'Nothing assigned yet.'}</p></div>
        ${manage ? html`<button class="btn btn-outline btn-sm" data-act="assign">Assign lesson</button>` : ''}</div>
      ${d.assignments.length ? html`<div>${d.assignments.map(assignmentRow)}</div>` : html`<div class="empty">Assign a lesson or course to an athlete or a whole team.</div>`}
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2 class="panel-title">Courses</h2><p class="panel-sub">Lessons in order. Deleting a course keeps its lessons in the library.</p></div>
        ${manage ? html`<button class="btn btn-sm" data-act="new-course">New course</button>` : ''}</div>
      ${d.courses.length ? d.courses.map((c) => html`<div class="edu-course">
        <div class="spread"><div><div class="edu-course-title">${c.title} ${c.published ? '' : badge('draft')}</div>
          <div class="edu-sub">${[c.description, plural(c.lessons.length, 'lesson')].filter(Boolean).join(' · ')}</div></div>
          ${manage ? html`<div class="edu-acts"><button class="btn btn-ghost btn-sm" data-act="edit-course" data-id="${c.id}">Edit</button>
            ${c.published && c.lessons.some((l) => l.published) ? html`<button class="btn btn-ghost btn-sm" data-act="assign-course" data-id="${c.id}">Assign</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-act="delete-course" data-id="${c.id}">Delete</button></div>` : ''}</div>
        ${c.lessons.length ? html`<div>${c.lessons.map((l, i, arr) => lessonRow(l, i, arr))}</div>` : html`<p class="edu-sub" style="margin:0">No lessons yet.${manage ? ' Create a lesson and choose this course.' : ''}</p>`}
      </div>`) : html`<div class="empty">No courses yet. A course is a few lessons read in order.</div>`}
    </section>

    <section class="panel">
      <div><h2 class="panel-title">Lesson library</h2><p class="panel-sub">Lessons that stand alone, outside a course.</p></div>
      ${d.lessons.length ? html`<div>${d.lessons.map((l) => lessonRow(l, 0, null))}</div>` : html`<div class="empty">No standalone lessons.</div>`}
    </section>
  </div>`);

  ctx.el.querySelector('.edu').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    const l = byId.get(id);
    try {
      switch (b.dataset.act) {
        case 'preview': return lessonPreview(l, courseById.get(l.course_id)?.title);
        case 'new-lesson': if (await editLesson({ published: 1 }, d.courses)) ctx.reload(); return;
        case 'edit': if (await editLesson(l, d.courses)) ctx.reload(); return;
        case 'delete':
          if (!(await confirmDialog(`Delete "${l.title}"?`, `It comes off every athlete's list, along with any assignments of it. ${l.completions ? `${plural(l.completions, 'athlete')} finished it; that record goes too.` : ''}`, 'Delete lesson', 'warn'))) return;
          await api.del(`/lessons/${id}`); toast('Lesson deleted.'); return ctx.reload();
        case 'new-course': if (await editCourse()) ctx.reload(); return;
        case 'edit-course': if (await editCourse(courseById.get(id))) ctx.reload(); return;
        case 'delete-course': {
          const c = courseById.get(id);
          if (!(await confirmDialog(`Delete "${c.title}"?`, `Its ${plural(c.lessons.length, 'lesson')} stay in the library as standalone lessons. Assignments of the course are removed.`, 'Delete course', 'warn'))) return;
          await api.del(`/courses/${id}`); toast('Course deleted. Its lessons are in the library.'); return ctx.reload();
        }
        case 'up': case 'down': {
          const list = courseById.get(l.course_id).lessons.slice();
          const i = list.findIndex((x) => x.id === id), j = b.dataset.act === 'up' ? i - 1 : i + 1;
          [list[i], list[j]] = [list[j], list[i]];
          b.disabled = true;
          await api.put(`/courses/${l.course_id}/order`, { lesson_ids: list.map((x) => x.id) });
          return ctx.reload();
        }
        case 'assign': if (await assignDialog()) ctx.reload(); return;
        case 'assign-lesson': if (await assignDialog({ lesson_id: id })) ctx.reload(); return;
        case 'assign-course': if (await assignDialog({ course_id: id })) ctx.reload(); return;
        case 'unassign':
          if (!(await confirmDialog('Remove this assignment?', 'It comes off their list. Anything they already finished stays finished.', 'Remove', 'warn'))) return;
          await api.del(`/assignments/${id}`); toast('Assignment removed.'); return ctx.reload();
      }
    } catch (err) { toastError(err); }
  });
}

export const routes = [
  { path: '/education', nav: 'education', title: 'Education', render: renderEducation },
];
