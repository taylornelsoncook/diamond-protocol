// Athlete workout app (/w/:token). No sign-in: the private link is the key.
import { html, raw, mount, api, icon, toast, toastError, debounce, fmtDate, plural, confirmDialog } from '/js/ui.js';
import { createEngage, engageDots, parseVideo, tabIcon, ENGAGE_TABS } from '/js/engage-view.js';

const root = document.getElementById('root');
const live = document.getElementById('wo-live');
const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/w/${encodeURIComponent(token)}`;
let s = null;             // state from the server
let openId = null;        // the exercise card that's open (demo, cues, sets)
let userClosed = false;   // the athlete closed every card on purpose: don't auto-open one
let finished = null;      // result of the last Finish workout, for the done screen
let rpe = null;           // how hard it was, picked before Finish
let noteDirty = false;    // a typed note that hasn't reached the server yet
let finishing = false;    // Finish workout is on its way: the note goes with it, not separately
const drafts = new Map(); // "item:set" → { weight, reps } typed but not logged yet
const extraSets = new Map(); // item id → sets added beyond the plan
const hist = new Map();   // finished workout id → detail (or 'loading') when opened

// Short spoken updates. Several in one tap ("Set 2 logged." then "Rest 1:30.") are read together, not the last one only.
let spoken = [];
let speakTimer = null;
const announce = (msg) => {
  if (!live) return;
  spoken.push(msg);
  live.textContent = '';
  clearTimeout(speakTimer);
  speakTimer = setTimeout(() => { live.textContent = spoken.join(' '); spoken = []; }, 30);
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: fine without it */ } },
};

// ---- demo videos: YouTube / Vimeo embeds, or a video file (parseVideo is shared with the lesson reader) ----
function video(item) {
  const v = parseVideo(item?.video_url);
  const t = `Demo: ${item?.name || 'exercise'}`;
  if (!v) return '';
  if (v.kind === 'youtube') return html`<div class="wo-video"><iframe src="https://www.youtube-nocookie.com/embed/${v.id}?rel=0&playsinline=1&modestbranding=1" title="${t}" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
  if (v.kind === 'vimeo') return html`<div class="wo-video"><iframe src="https://player.vimeo.com/video/${v.id}?dnt=1&playsinline=1" title="${t}" loading="lazy" allow="fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;
  return html`<div class="wo-video"><video src="${v.url}" controls playsinline preload="metadata" aria-label="${t}"></video></div>`;
}

const setsReps = (i) => [i.sets, i.reps].filter(Boolean).join(' × ');
const num = (v) => (v == null || v === '' ? '' : String(Number.isInteger(Number(v)) ? Number(v) : Number(v).toFixed(1)));
// "35 × 8", "35 lb", "8 reps" or "done" for one logged set.
function fmtSet(x) {
  if (x.weight != null && x.reps != null) return `${num(x.weight)} × ${x.reps}`;
  if (x.weight != null) return `${num(x.weight)} lb`;
  if (x.reps != null) return `${x.reps} reps`;
  return 'done';
}
// A list of sets, short: "3 sets of 30 × 10" when they're all the same, "3 sets" when nothing was counted.
function fmtSets(list) {
  const f = list.map(fmtSet);
  if (f.every((x) => x === 'done')) return plural(f.length, 'set');
  if (f.length > 1 && f.every((x) => x === f[0])) return `${f.length} sets of ${f[0]}`;
  return f.join(', ');
}
const header = () => html`<img class="wo-mark" src="/img/mark-192.png" alt="Diamond Protocol" width="56" height="56">`;
const foot = html`<div class="wo-foot">Built under pressure</div>`;

// Paint the workout screen without losing the athlete's place: focus goes back to the same control.
function paint(content) {
  const f = document.activeElement?.dataset?.focus;
  mount(root, content);
  if (f) root.querySelector(`[data-focus="${CSS.escape(f)}"]`)?.focus({ preventScroll: true });
}

// ---- saving: logs queue up and retry, so a gym with bad signal never loses a set ----
const QKEY = `dp-wo-queue:${token}`;
let queue = ls.get(QKEY, []);
if (!Array.isArray(queue)) queue = [];
let flushing = null;      // the send in progress, so Finish workout can wait for it
let offline = false;
let retryTimer = null;
function enqueue(path, body, key) {
  queue = queue.filter((j) => j.key !== key);
  queue.push({ path, body, key });
  ls.set(QKEY, queue);
  flush();
}
function setOffline(v) {
  if (offline === v) return;
  offline = v;
  const b = root.querySelector('#offline');
  if (b) b.hidden = !v;
  if (v) announce('No connection. Your logs are saved on this phone.');
}
function flush() {
  if (!flushing) flushing = sendQueue().finally(() => { flushing = null; });
  return flushing;
}
async function sendQueue() {
  clearTimeout(retryTimer);
  while (queue.length) {
    const job = queue[0];
    let r;
    try { r = await api.post(job.path, job.body, { noRedirect: true }); }
    catch (err) {
      if (!err.status) { setOffline(true); retryTimer = setTimeout(flush, 8000); return; }
      // The server is having a moment: keep it and try again shortly.
      if (err.status >= 500 || err.status === 429) { retryTimer = setTimeout(flush, 8000); return; }
      // The server said no (the program changed, the link was reset): drop it, and anything else for that day.
      queue = err.status === 409 ? queue.filter((j) => j.body.day_id !== job.body.day_id) : queue.slice(1);
      ls.set(QKEY, queue);
      setOffline(false);
      await handle(err);
      continue;
    }
    queue.shift(); ls.set(QKEY, queue);
    setOffline(false);
    if (job.key === 'note' && !queue.some((j) => j.key === 'note')) noteDirty = false;
    // Only trust the server's copy once nothing newer is waiting to be sent.
    if (!queue.length && r && s?.current && job.body.day_id === s.current.day_id && Array.isArray(r.done)) {
      const c = s.current;
      const changed = JSON.stringify([r.done, r.sets]) !== JSON.stringify([c.log.done, c.log.sets]);
      c.log.done = r.done; c.log.sets = r.sets || [];
      if (changed && !finished) render();
    }
  }
}
window.addEventListener('online', () => flush());

// ---- rest timer between sets ----
const restEl = document.getElementById('rest');
const REST_KEY = 'dp-rest-seconds';
let restLen = Number(ls.get(REST_KEY, 90)) || 0;
let restEnd = 0;
let restTick = null;
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const restLabel = () => (restLen ? `Rest timer ${mmss(restLen)}` : 'Rest timer off');
function buildRest() {
  mount(restEl, html`<div class="wo-rest-in">
    <div class="wo-rest-l"><span class="wo-rest-k">Rest</span><span class="wo-rest-t" id="rest-t">0:00</span></div>
    <button type="button" class="wo-rest-b" data-rest="-15" aria-label="15 seconds less rest">−15 s</button>
    <button type="button" class="wo-rest-b" data-rest="15" aria-label="15 seconds more rest">+15 s</button>
    <button type="button" class="wo-rest-b" data-rest="skip">Skip</button></div>`);
}
function paintRest() {
  const left = Math.max(0, Math.ceil((restEnd - Date.now()) / 1000));
  const t = restEl.querySelector('#rest-t');
  if (t) t.textContent = mmss(left);
  restEl.hidden = root.hidden;
  if (left <= 0) stopRest(true);
}
function startRest() {
  if (!restLen) return;
  restEnd = Date.now() + restLen * 1000;
  if (!restEl.querySelector('#rest-t')) buildRest();
  restEl.classList.remove('done');
  document.body.classList.add('wo-resting');
  clearInterval(restTick);
  restTick = setInterval(paintRest, 250);
  paintRest();
  announce(`Rest ${mmss(restLen)}.`);
}
function stopRest(ended = false) {
  clearInterval(restTick); restTick = null; restEnd = 0;
  if (ended) {
    try { navigator.vibrate?.([180, 90, 180]); } catch { /* not supported */ }
    announce('Rest done. Next set.');
    const t = restEl.querySelector('#rest-t');
    if (t) t.textContent = 'Go';
    restEl.classList.add('done');
    setTimeout(() => { if (!restEnd) { restEl.hidden = true; document.body.classList.remove('wo-resting'); } }, 2500);
  } else { restEl.hidden = true; document.body.classList.remove('wo-resting'); }
}
restEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-rest]');
  if (!b) return;
  if (b.dataset.rest === 'skip') { stopRest(false); return; }
  const d = Number(b.dataset.rest);
  restLen = Math.max(15, Math.min(600, (restLen || 90) + d));
  ls.set(REST_KEY, restLen);
  if (restEnd) { restEnd = Math.max(Date.now() + 1000, restEnd + d * 1000); paintRest(); }
  const r = root.querySelector('[data-resttoggle]');
  if (r) { r.textContent = restLabel(); r.setAttribute('aria-pressed', 'true'); }
});

// ---- sections ----
function history() {
  if (!s.history?.length) return '';
  return html`<h2 class="wo-h2">Finished workouts</h2>
    <div class="wo-hist">${s.history.map((h) => {
      const d = hist.get(h.id);
      const open = !!d;
      return html`<div class="wo-hist-row">
        <button type="button" class="wo-hist-b" data-hist="${h.id}" data-focus="hist-${h.id}" aria-expanded="${String(open)}" aria-controls="hist-${h.id}">
          <span class="wo-hist-t"><span class="strong">${h.title}</span> <span class="muted">· week ${h.week}, day ${h.day}</span></span>
          <span class="muted wo-hist-m">${fmtDate(h.finished_at, { year: false })} · ${h.done}/${h.total}${h.rpe ? ` · effort ${h.rpe}` : ''}</span>
          <span class="wo-chev" aria-hidden="true">${icon('chevron', 16)}</span>
        </button>
        ${open ? html`<div class="wo-hist-d" id="hist-${h.id}">${d === 'loading' ? html`<p class="muted small" style="margin:0">Loading…</p>` : histDetail(d)}</div>` : ''}
      </div>`;
    })}</div>`;
}
function histDetail(d) {
  const facts = [fmtDate(d.finished_at, { weekday: true }), d.minutes ? `${d.minutes} min` : '', d.rpe ? `effort ${d.rpe} of 10` : ''].filter(Boolean).join(' · ');
  return html`<p class="muted small" style="margin:0">${d.program} · ${facts}</p>
    <ul class="wo-hist-items">${d.items.map((i) => html`<li>
      <span class="wo-hist-i">${i.done ? icon('check', 14) : html`<span class="wo-skip" aria-hidden="true">–</span>`}<span>${i.name}${i.done ? '' : html` <span class="muted">(skipped)</span>`}</span></span>
      <span class="muted">${i.logged.length ? fmtSets(i.logged) : setsReps(i)}</span></li>`)}</ul>
    ${d.note ? html`<p class="wo-hist-note">“${d.note}”</p>` : ''}
    ${s.reopen_id === d.id && !finished ? html`<p class="muted small wo-reopen">Finished by mistake or missed something? <button type="button" class="wo-link wo-inline" data-reopen="${d.id}" data-focus="reopen-${d.id}">Reopen this workout</button></p>` : ''}`;
}

function progress() {
  const p = s.program;
  const pct = p.total_days ? Math.round((p.finished_days / p.total_days) * 100) : 0;
  return html`<div class="wo-prog"><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total_days}" aria-valuenow="${p.finished_days}" aria-label="Program progress"><span style="width:${pct}%"></span></div>
    <span class="muted">${p.finished_days} of ${plural(p.total_days, 'workout')} done</span></div>`;
}

function upcoming() {
  if (!s.upcoming?.length) return '';
  return html`<h2 class="wo-h2">Coming up</h2>
    <div class="wo-up">${s.upcoming.map((u) => html`<div><span class="strong">${u.title}</span> <span class="muted">· week ${u.week}, day ${u.day}</span>
      <div class="muted small">${u.exercises.length ? u.exercises.join(', ') : 'Exercises coming soon'}</div></div>`)}</div>`;
}

const offlineBanner = () => html`<div class="banner wo-offline" id="offline" role="status" ${offline ? '' : raw('hidden')}>No connection. Your logs are saved on this phone and send when you're back online.</div>`;

// ---- one exercise: header (tap to open), and when open: demo, cues, last time, sets ----
const setsFor = (c, id) => c.log.sets.filter((x) => x.item_id === id);
const rowCount = (i, logged) => Math.min(12, Math.max(i.target_sets + (extraSets.get(i.id) || 0), ...logged.map((x) => x.set_no)));
function setRows(i, c) {
  const logged = setsFor(c, i.id);
  const counted = i.target_reps != null;
  const total = rowCount(i, logged);
  const rows = [];
  for (let n = 1; n <= total; n++) {
    const L = logged.find((x) => x.set_no === n);
    const d = drafts.get(`${i.id}:${n}`) || {};
    const prev = i.last?.sets?.find((x) => x.set_no === n) || i.last?.sets?.at(-1);
    const wv = d.weight ?? (L ? num(L.weight) : '');
    const rv = d.reps ?? (L ? num(L.reps) : '');
    rows.push(html`<div class="wo-set ${L ? 'logged' : ''}" data-item="${i.id}" data-set="${n}">
      <span class="wo-set-n" aria-hidden="true">${n}</span>
      <input class="input wo-in" data-f="weight" data-focus="w-${i.id}-${n}" type="text" inputmode="decimal" enterkeyhint="${counted ? 'next' : 'done'}" autocomplete="off"
        value="${wv}" placeholder="${prev?.weight != null ? num(prev.weight) : '–'}" aria-label="Set ${n} weight in pounds${prev?.weight != null ? `, last time ${num(prev.weight)}` : ''}">
      ${counted ? html`<input class="input wo-in" data-f="reps" data-focus="r-${i.id}-${n}" type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off"
        value="${rv}" placeholder="${i.target_reps}" aria-label="Set ${n} reps, target ${i.target_reps}">`
        : html`<span class="wo-set-target">${i.reps || 'Done'}</span>`}
      <button type="button" class="wo-set-ok" data-setlog data-focus="ok-${i.id}-${n}" aria-pressed="${String(!!L)}" aria-label="${L ? `Set ${n} logged. Tap to clear it` : `Log set ${n}`}">${icon('check', 20)}</button>
    </div>`);
  }
  return html`<div class="wo-sets" role="group" aria-label="Sets for ${i.name}">
    <div class="wo-set wo-set-head" aria-hidden="true"><span>Set</span><span>lb</span><span>${counted ? 'Reps' : 'Target'}</span><span></span></div>
    ${rows}</div>
    ${total < 12 ? html`<button type="button" class="wo-link" data-addset="${i.id}" data-focus="add-${i.id}">${icon('plus', 16)}Add a set</button>` : ''}`;
}
function lastLine(i) {
  const bits = [];
  if (i.last?.sets?.length) bits.push(html`Last time (${fmtDate(i.last.date, { year: false })}): <span class="wo-last-v">${fmtSets(i.last.sets)}</span>`);
  if (i.best_weight) bits.push(html`Best ${num(i.best_weight)} lb`);
  return bits.length ? html`<p class="wo-last">${bits.map((b, k) => html`${k ? ' · ' : ''}${b}`)}</p>` : '';
}
function exercise(i, idx, c, done) {
  const open = i.id === openId;
  const isDone = done.has(i.id);
  const n = setsFor(c, i.id).length;
  const cues = [i.cues, i.cue].filter(Boolean).join(' ');
  const sub = [setsReps(i), n ? `${n} of ${plural(i.target_sets, 'set')} logged` : ''].filter(Boolean).join(' · ');
  return html`<section class="wo-ex ${isDone ? 'done' : ''} ${open ? 'open' : ''}" data-item="${i.id}" aria-label="${i.name}">
    <div class="wo-ex-head">
      <button type="button" class="wo-ex-toggle" data-open="${i.id}" data-focus="open-${i.id}" aria-expanded="${String(open)}" aria-controls="ex-${i.id}">
        <span class="wo-thumb" aria-hidden="true">${isDone ? icon('check', 18) : idx + 1}</span>
        <span class="wo-ex-txt"><span class="wo-name">${i.name}</span><span class="wo-sr">${sub}</span></span>
      </button>
      <button type="button" class="wo-log" data-log="${i.id}" data-focus="log-${i.id}" aria-pressed="${String(isDone)}" aria-label="${isDone ? `${i.name} done. Tap to undo` : `Mark ${i.name} done`}">${isDone ? html`${icon('check', 16)}Done` : 'Log'}</button>
    </div>
    ${open ? html`<div class="wo-ex-body" id="ex-${i.id}">
      ${video(i)}
      <p class="wo-cue">${cues || 'Move with control and good posture.'}</p>
      ${lastLine(i)}
      ${setRows(i, c)}
    </div>` : ''}
  </section>`;
}

// Session effort, the 1–10 scale coaches use (words on the anchor points only).
const RPE = ['Very easy', 'Easy', 'Moderate', 'Somewhat hard', 'Hard', '', 'Very hard', '', '', 'Max'];

function render() {
  if (!s) return;
  if (!s.program) {
    paint(html`${header()}<h1 class="wo-title">No program yet</h1>
      <p class="wo-hi">Hi ${s.athlete.first_name}. Your coach hasn't assigned a program yet. When they do, it shows up here straight away.</p>${history()}${foot}`);
    return;
  }
  const first = s.athlete.first_name;
  if (finished) { renderDone(); return; }
  if (!s.current) {
    paint(html`${header()}<p class="wo-hi">Hi ${first}. ${s.program.name}</p><h1 class="wo-title">Program complete</h1>${progress()}
      <p class="muted" style="margin:0">You finished every workout in ${s.program.name}. Your coach can see all of it and will set up what comes next.</p>${history()}${foot}`);
    return;
  }
  const c = s.current;
  const done = new Set(c.log.done);
  if (!c.items.some((i) => i.id === openId) && !userClosed) openId = (c.items.find((i) => !done.has(i.id)) || {}).id ?? null;
  const setsLogged = c.log.sets.length;
  paint(html`${header()}
    ${offlineBanner()}
    <div><p class="wo-hi">Hi ${first}. Week ${c.week}, day ${c.day} of ${s.program.name}</p>
    <h1 class="wo-title">${c.title}</h1></div>
    ${progress()}
    ${c.items.length ? html`
      <div class="wo-bar">
        <p class="muted" style="margin:0" id="count">${done.size} of ${plural(c.items.length, 'exercise')} done${setsLogged ? ` · ${plural(setsLogged, 'set')} logged` : ''}</p>
        <button type="button" class="wo-link" data-resttoggle data-focus="resttoggle" aria-pressed="${String(!!restLen)}">${restLabel()}</button>
      </div>
      <p class="muted small wo-help">Tap an exercise for the demo and cues. Log each set with its weight and reps, or tap Log when the whole exercise is done.</p>
      <div class="wo-list">${c.items.map((i, idx) => exercise(i, idx, c, done))}</div>
      <fieldset class="wo-rpe"><legend class="label">How hard was today? <span class="muted" style="font-weight:400">(optional)</span></legend>
        <div class="eg-scale wo-rpe-grid">${RPE.map((w, k) => html`<button type="button" data-rpe="${k + 1}" data-focus="rpe-${k + 1}" aria-pressed="${String(rpe === k + 1)}" aria-label="${k + 1}${w ? `, ${w}` : ''}"><b>${k + 1}</b><span>${w || raw('&nbsp;')}</span></button>`)}</div>
      </fieldset>
      <div class="field"><label class="label" for="note">Notes for your coach <span class="muted" style="font-weight:400">(optional)</span></label>
        <textarea class="input" id="note" rows="3" maxlength="2000" placeholder="How did it feel? Anything your coach should know?">${c.log.note}</textarea></div>
      <button class="btn btn-primary btn-block wo-finish" id="finish" data-focus="finish">Finish workout</button>`
      : html`<p class="muted">Your coach is still adding exercises to this workout. Check back soon.</p>`}
    ${upcoming()}
    ${history()}${foot}`);
}

function renderDone() {
  const f = finished.finished;
  const n = finished.next_up;
  const facts = [`${f.done} of ${plural(f.total, 'exercise')}`, f.sets ? plural(f.sets, 'set') : '', f.minutes ? `${f.minutes} min` : '', f.rpe ? `effort ${f.rpe} of 10` : ''].filter(Boolean);
  paint(html`${header()}
    <p class="wo-hi">Week ${f.week}, day ${f.day} of ${s.program.name}</p>
    <h1 class="wo-title">${f.title}</h1>
    ${progress()}
    <div class="wo-done" role="status">
      <div class="icon">${icon('check', 26)}</div>
      <p><span class="strong">Workout logged.</span> Your coach can see it now.</p>
      <p class="muted">${facts.join(' · ')}</p>
      ${f.bests?.length ? html`<ul class="wo-bests">${f.bests.map((b) => html`<li>New best: <span class="strong">${b.name}</span>, ${num(b.weight)} lb <span class="muted">(was ${num(b.previous)} lb)</span></li>`)}</ul>` : ''}
      <p class="muted">${n ? html`Next up: <span class="strong" style="color:var(--steel)">${n.title}</span> on ${n.weekday}.` : 'That was the last workout in this program. Your coach will set up what comes next.'}</p>
      ${n ? html`<div><button class="btn" id="next" data-focus="next">See next workout</button></div>` : ''}
    </div>
    ${s.reopen_id === f.log_id ? html`<p class="muted small wo-reopen">Finished by mistake or missed something? <button type="button" class="wo-link wo-inline" data-reopen="${f.log_id}" data-focus="reopen">Reopen this workout</button></p>` : ''}
    ${history()}${foot}`);
}

// ---- actions (bound once on the root; the markup is re-painted freely) ----
const cur = () => s?.current;
const findItem = (id) => cur()?.items.find((i) => i.id === id);

function scrollToCard(id) {
  const el = root.querySelector(`.wo-ex[data-item="${id}"]`);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 12;
  window.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
// Close the finished exercise and open the next one still to do.
function openNext(afterId) {
  const c = cur();
  const done = new Set(c.log.done);
  const idx = c.items.findIndex((i) => i.id === afterId);
  const next = c.items.slice(idx + 1).find((i) => !done.has(i.id)) || c.items.find((i) => !done.has(i.id));
  openId = next ? next.id : null;
  userClosed = false;
  render();
  if (next) { scrollToCard(next.id); root.querySelector(`[data-focus="open-${next.id}"]`)?.focus({ preventScroll: true }); }
  else root.querySelector('#finish')?.focus({ preventScroll: true });
}

function toggleDone(id) {
  const c = cur();
  const item = findItem(id);
  if (!item) return;
  const now = !c.log.done.includes(id);
  c.log.done = now ? [...c.log.done, id] : c.log.done.filter((x) => x !== id);
  announce(`${item.name} ${now ? 'done' : 'not done'}. ${c.log.done.length} of ${plural(c.items.length, 'exercise')} done.`);
  enqueue(`${base}/log`, { day_id: c.day_id, item_id: id, done: now }, `item:${id}`);
  if (now && id === openId) openNext(id); else render();
}

// Read a set row: what's typed, or the hint (last time's weight, the target reps) when a new set is left blank.
function readSet(row) {
  const i = findItem(Number(row.dataset.item));
  const n = Number(row.dataset.set);
  const useHints = !row.classList.contains('logged');
  const wIn = row.querySelector('[data-f="weight"]');
  const rIn = row.querySelector('[data-f="reps"]');
  const parse = (el, whole, max) => {
    if (!el) return { v: null };
    const text = el.value.trim() || (useHints ? el.placeholder.replace('–', '').trim() : '');
    if (!text) return { v: null };
    const v = Number(text.replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > max || (whole && !Number.isInteger(v))) return { bad: true };
    return { v };
  };
  const w = parse(wIn, false, 2000);
  const r = parse(rIn, true, 500);
  if (w.bad) { toast('Enter the weight in pounds as a number, like 35 or 37.5.', 'warn'); wIn.focus(); return null; }
  if (r.bad) { toast('Enter reps as a whole number, like 8.', 'warn'); rIn.focus(); return null; }
  return { i, n, weight: w.v == null ? null : Math.round(w.v * 10) / 10, reps: r.v };
}

function logSet(row, { rest = true } = {}) {
  const v = readSet(row);
  if (!v || !v.i) return;
  const c = cur();
  const { i, n } = v;
  const wasDone = c.log.done.includes(i.id);
  c.log.sets = [...c.log.sets.filter((x) => !(x.item_id === i.id && x.set_no === n)), { item_id: i.id, set_no: n, weight: v.weight, reps: v.reps }]
    .sort((a, b) => a.item_id - b.item_id || a.set_no - b.set_no);
  drafts.delete(`${i.id}:${n}`);
  const nowDone = wasDone || setsFor(c, i.id).length >= i.target_sets;
  if (nowDone && !wasDone) c.log.done = [...c.log.done, i.id];
  enqueue(`${base}/set`, { day_id: c.day_id, item_id: i.id, set_no: n, weight: v.weight, reps: v.reps, done: true }, `set:${i.id}:${n}`);
  announce(`Set ${n} of ${i.name} logged${v.weight != null || v.reps != null ? `: ${fmtSet(v)}` : ''}.`);
  if (rest && !c.items.every((x) => c.log.done.includes(x.id))) startRest();
  if (nowDone && !wasDone) { openNext(i.id); return; }
  render();
  // Straight on to the next open set: its tick on a phone (so the keyboard doesn't cover the rest timer), its first box otherwise.
  if (rest) {
    const next = root.querySelector(`.wo-set[data-item="${i.id}"]:not(.logged):not(.wo-set-head)`);
    (matchMedia('(pointer: coarse)').matches ? next?.querySelector('[data-setlog]') : next?.querySelector('[data-f]'))?.focus({ preventScroll: true });
  }
}

function clearSet(row) {
  const c = cur();
  const id = Number(row.dataset.item), n = Number(row.dataset.set);
  c.log.sets = c.log.sets.filter((x) => !(x.item_id === id && x.set_no === n));
  c.log.done = c.log.done.filter((x) => x !== id);
  enqueue(`${base}/set`, { day_id: c.day_id, item_id: id, set_no: n, done: false }, `set:${id}:${n}`);
  announce(`Set ${n} cleared.`);
  render();
}

root.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t || !root.contains(t) || t.id === 'retry') return;
  if (t.dataset.open) {
    const id = Number(t.dataset.open);
    openId = openId === id ? null : id;
    userClosed = openId == null;
    render();
    if (openId) scrollToCard(openId);
  } else if (t.dataset.log) {
    toggleDone(Number(t.dataset.log));
  } else if (t.hasAttribute('data-setlog')) {
    const row = t.closest('.wo-set');
    if (t.getAttribute('aria-pressed') === 'true') clearSet(row); else logSet(row);
  } else if (t.dataset.addset) {
    const id = Number(t.dataset.addset);
    extraSets.set(id, (extraSets.get(id) || 0) + 1);
    render();
    const rows = root.querySelectorAll(`.wo-set[data-item="${id}"]:not(.wo-set-head)`);
    rows[rows.length - 1]?.querySelector('[data-f]')?.focus();
  } else if (t.dataset.rpe) {
    const v = Number(t.dataset.rpe);
    rpe = rpe === v ? null : v;
    root.querySelectorAll('[data-rpe]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rpe) === rpe)));
  } else if (t.hasAttribute('data-resttoggle')) {
    restLen = restLen ? 0 : 90;
    ls.set(REST_KEY, restLen);
    if (!restLen) stopRest(false);
    t.setAttribute('aria-pressed', String(!!restLen));
    t.textContent = restLabel();
    announce(restLen ? `Rest timer on, ${mmss(restLen)} between sets.` : 'Rest timer off.');
  } else if (t.dataset.hist) {
    const id = Number(t.dataset.hist);
    if (hist.has(id)) { hist.delete(id); render(); return; }
    hist.set(id, 'loading'); render();
    try { hist.set(id, await api.get(`${base}/history/${id}`, { noRedirect: true })); }
    catch (err) { hist.delete(id); toastError(err); }
    render();
  } else if (t.id === 'finish') {
    await finishWorkout(t);
  } else if (t.id === 'next') {
    finished = null; openId = null; userClosed = false; render(); window.scrollTo(0, 0);
  } else if (t.dataset.reopen) {
    t.disabled = true;
    const id = Number(t.dataset.reopen);
    try {
      const r = await api.post(`${base}/reopen`, { log_id: id }, { noRedirect: true });
      // Keep the rating they gave, so Finish again is one tap.
      rpe = (finished?.finished.log_id === id ? finished.finished.rpe : s.history?.find((h) => h.id === id)?.rpe) || null;
      s = r.state; finished = null; openId = null; userClosed = false; hist.clear();
      render(); window.scrollTo(0, 0);
      toast("Workout reopened. Finish it again when you're ready.");
    } catch (err) { t.disabled = false; toastError(err); }
  }
});

async function finishWorkout(btn) {
  const c = cur();
  const note = root.querySelector('#note');
  if (!c.log.done.length) { toast('Log each exercise as you finish it, then tap Finish workout.', 'warn'); return; }
  const left = c.items.filter((i) => !c.log.done.includes(i.id));
  if (left.length) {
    const names = left.map((i) => i.name);
    const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ').replace(/, ([^,]*)$/, ' and $1');
    const ok = await confirmDialog(`Finish with ${c.log.done.length} of ${plural(c.items.length, 'exercise')} done?`,
      `${list} ${left.length === 1 ? 'shows' : 'show'} as skipped for your coach. Add a note if you want to say why.`, 'Finish workout');
    if (!ok) return;
  }
  btn.disabled = true;
  btn.textContent = 'Saving…';
  finishing = true;
  await flush();
  if (queue.length) {
    finishing = false;
    btn.disabled = false; btn.textContent = 'Finish workout';
    toast(offline ? "You're offline. Everything you logged is saved on this phone. Tap Finish workout again when you have signal."
      : "Some logs haven't been sent yet. They're saved on this phone. Try Finish workout again in a moment.", 'warn');
    return;
  }
  try {
    finished = await api.post(`${base}/finish`, { day_id: c.day_id, note: note?.value ?? '', rpe }, { noRedirect: true });
    s = finished.state;
    rpe = null; noteDirty = false; finishing = false; drafts.clear(); extraSets.clear(); hist.clear();
    stopRest(false);
    render();
    window.scrollTo(0, 0);
    root.querySelector('#next')?.focus({ preventScroll: true });
  } catch (err) {
    finishing = false;
    btn.disabled = false; btn.textContent = 'Finish workout';
    if (!err.status) toast("Couldn't reach the server. Everything you logged is saved. Try Finish workout again in a moment.", 'warn');
    else await handle(err);
  }
}

// Typing: keep drafts across re-paints, save the note as they type, and let Enter move along the set row.
const saveNote = debounce(() => {
  const c = cur(); const el = root.querySelector('#note');
  if (!c || !el || finishing) return;
  c.log.note = el.value;
  enqueue(`${base}/log`, { day_id: c.day_id, note: el.value }, 'note');
}, 700);
root.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'note') { noteDirty = true; if (cur()) cur().log.note = el.value; saveNote(); return; }
  const row = el.closest('.wo-set');
  if (!row || !el.dataset.f) return;
  const k = `${row.dataset.item}:${row.dataset.set}`;
  drafts.set(k, { ...(drafts.get(k) || {}), [el.dataset.f]: el.value });
});
root.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.dataset?.f) return;
  e.preventDefault();
  const row = e.target.closest('.wo-set');
  const reps = row.querySelector('[data-f="reps"]');
  if (e.target.dataset.f === 'weight' && reps) { reps.focus(); reps.select?.(); return; }
  if (row.classList.contains('logged')) logSet(row, { rest: false }); else logSet(row);
});
// Changing a set that's already logged saves the new numbers.
root.addEventListener('change', (e) => {
  const row = e.target.closest?.('.wo-set.logged');
  if (row && e.target.dataset.f) logSet(row, { rest: false });
});
// Leaving mid-note: send it on the way out.
window.addEventListener('pagehide', () => {
  const c = cur(); const el = root.querySelector('#note');
  if (!noteDirty || !c || !el || !navigator.sendBeacon) return;
  navigator.sendBeacon(`/api${base}/log`, new Blob([JSON.stringify({ day_id: c.day_id, note: el.value })], { type: 'application/json' }));
});

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
  restEl.hidden = !onWorkout || !restEnd;
  const t = TABS.find((x) => x.id === tab);
  document.title = `${onWorkout ? 'Workout' : t.label} · Diamond Protocol`;
  if (!onWorkout) {
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
// A link to another tab (e.g. /w/<token>#education) while the app is open switches to it.
window.addEventListener('hashchange', () => {
  const t = tabFromHash();
  if (t === tab) return;
  tab = t; view.closeReader(); showTab(); window.scrollTo(0, 0);
});
async function loadEngage() {
  try { await view.load(); showTab(); } catch { /* link not found or offline: the workout screen explains */ }
}

// Come back to the tab later (e.g. the next day) and it shows the latest, unless something is still being typed or sent.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (restEnd) paintRest();
  if (queue.length) flush();
  else if (s && !finished && !noteDirty && !root.contains(document.activeElement)) load();
  if (view.data) view.load().then(() => { if (tab !== 'workout' && !view.busy()) showTab(); }).catch(() => {});
});
// Anything logged while offline last time goes first, so the screen shows it.
(async () => { if (queue.length) await flush(); load(); })();
loadEngage();
