import { h, fill, toast, busy, videoEmbed, playIcon, btn } from './ui.js';
import { createEngage, ENGAGE_TABS, tabIcon, engageDots } from './engage-view.js';
import { detailsOf, groupTag, withGroups } from './set-fields.js';

// The private link looks like /app?token=… . Keep the token for this device, then drop it from the address bar.
const params = new URLSearchParams(location.search);
let tokenValue = params.get('token');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: memory only */ } }
};
try {
  if (tokenValue) localStorage.setItem('dp_client_token', tokenValue);
  else tokenValue = localStorage.getItem('dp_client_token');
} catch { /* storage blocked: keep the token in memory */ }
if (params.has('token')) history.replaceState(null, '', `/app${location.hash}`);   // keep #education and the like

const root = document.getElementById('root');
class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
const call = async (token, method, path, body) => {
  const res = await fetch(path, { method, headers: { 'x-client-token': token || '', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error?.message || 'Something went wrong. Try again.', res.status);
  return data;
};
const api = (method, path, body) => call(tokenValue, method, path, body);

// Screen-reader updates made in one tap are read together ("Set 1 logged. Rest 1:30."), not one over the other.
const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
let spoken = [];
const say = (msg) => { spoken.push(msg); if (spoken.length === 1) queueMicrotask(() => { live.textContent = spoken.join(' '); spoken = []; }); };

// A link like /app?token=…#education opens that tab, and changing the # while the app is open switches tabs.
const TAB_KEYS = ['workout', 'accountability', 'performance', 'education'];
const hashTab = () => { const k = location.hash.replace(/^#\/?/, '').toLowerCase(); return TAB_KEYS.includes(k) ? k : null; };
const state = { tab: hashTab() ?? 'workout', home: null, open: null, done: null, historyOpen: new Set(), details: new Map() };
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
  if ((hashTab() ?? 'workout') !== tab) history.replaceState(null, '', `${location.pathname}${location.search}${tab === 'workout' ? '' : `#${tab}`}`);
  drawTabs();
  window.scrollTo(0, 0);
  if (tab === 'workout') {
    if (!state.home) return load();
    render();
    // A check-in saved on another tab can change today's weights, so fetch again quietly.
    refresh();
    return;
  }
  stopRest();
  const where = h('div', { class: 'eg-view' });
  fill(view, h('div', { class: 'row' }, h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), h('h1', { class: 'c-title grow', style: 'font-size:30px' }, ENGAGE_TABS.find(([k]) => k === tab)[1])), where);
  engage.render(where, tab);
}
window.addEventListener('hashchange', () => { const k = hashTab() ?? 'workout'; if (k !== state.tab && root.contains(tabs)) show(k); });
async function refresh() {
  try { const home = await api('GET', '/app/api/home'); state.home = home; if (state.tab === 'workout' && !state.done && !editing()) render(); }
  catch { /* offline: keep what's on screen */ }
}

async function load() {
  if (!tokenValue) return message('Open the link your coach sent you to see your workouts.');
  let home;
  try { home = await api('GET', '/app/api/home'); }
  catch (e) {
    const cached = store.get(`dp_wo_home_${String(tokenValue).slice(0, 16)}`);
    if (e.status || !cached || cached.token !== tokenValue) return message(e.status ? e.message : 'You\'re offline. Open the app again when you have a signal.');
    home = cached.home;                           // offline: the last workout this phone saw
  }
  fill(root, view, tabs, live);
  state.home = home;
  drawTabs();
  if (state.tab === 'workout') render(); else show(state.tab);
  engage.load().then(() => { if (state.tab !== 'workout') show(state.tab); }).catch(() => {});
  flush();
}

function message(text, extra) {
  fill(root, h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), h('div', { class: 'dp-panel' }, h('p', null, text), extra || null));
}

// ---------- The workout being logged, kept on this phone ----------
// A draft holds every set as it's logged, so a reload, a dead battery or no signal loses nothing. One draft per link:
// { token, workout_id, log_id (a reopened workout), title, request_id, started_at, sets: { [exercise]: [{ weight, reps, done }] }, notes, rpe }.
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
let draft = null;
// One draft per athlete link, so siblings sharing a phone never overwrite each other's sets.
const DRAFT_KEY = () => `dp_wo_draft_${String(tokenValue).slice(0, 16)}`;
const saveDraft = () => store.set(DRAFT_KEY(), draft);
const editing = () => !!draft?.log_id;
function draftFor(workout) {
  const kept = store.get(DRAFT_KEY());
  if (kept && kept.token === tokenValue && !kept.log_id && kept.workout_id === workout.id) return (draft = kept);
  return (draft = { token: tokenValue, workout_id: workout.id, log_id: null, title: workout.title, request_id: newId(), started_at: null, sets: {}, notes: '', rpe: null });
}
const hasSets = (d) => !!d && Object.values(d.sets).some((rows) => rows.some((r) => r.done));
// A draft for another workout (the coach changed the program, or it was logged on the weight-room screen).
const strayDraft = () => { const d = store.get(DRAFT_KEY()); return d && d.token === tokenValue && !d.log_id && d.workout_id !== state.home?.workout?.id && hasSets(d) ? d : null; };

// ---------- Sending, with retries when there's no signal ----------
// Finished workouts wait in an outbox on the phone until the server has them. Each Finish carries a request id, so a
// resend never logs the same workout twice. Server errors and "too many requests" are retried; a refusal (the workout
// can't be saved) is shown and dropped.
const outbox = () => (store.get('dp_wo_outbox') ?? []).filter((x) => x && x.token);
const setOutbox = (list) => store.set('dp_wo_outbox', list.length ? list : null);
const results = new Map();          // request id → the server's answer
let flushing = null, retryTimer = null, retryDelay = 5000;
function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    for (;;) {
      const next = outbox()[0];
      if (!next) break;
      try {
        const out = next.kind === 'edit' ? await call(next.token, 'PUT', `/app/api/logs/${next.log_id}`, next.body)
          : await call(next.token, 'POST', `/app/api/workouts/${next.workout_id}/complete`, next.body);
        results.set(next.request_id, out);
        sent++;
      } catch (e) {
        if (!e.status || e.status >= 500 || e.status === 429) { scheduleRetry(); break; }
        results.set(next.request_id, { error: e.message });
        if (next.token === tokenValue) toast(`${next.title} couldn't be saved: ${e.message}`, 'warn');   // never another athlete's workout
      }
      setOutbox(outbox().filter((x) => x.request_id !== next.request_id));
      retryDelay = 5000;
    }
    return sent;
  })().finally(() => { flushing = null; drawPending(); });
  return flushing;
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => flush().then((n) => { if (n) refresh(); }), retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60000);
}
window.addEventListener('online', () => { drawPending(); flush().then((n) => { if (n) refresh(); }); });
window.addEventListener('offline', () => drawPending());

const pendingBox = h('div', { role: 'status' });
function drawPending() {
  const mine = outbox().filter((x) => x.token === tokenValue);
  fill(pendingBox, !navigator.onLine ? h('div', { class: 'c-note' }, 'You\'re offline. Keep logging: everything is saved on this phone and sent when you\'re back online.') : null,
    mine.length ? h('div', { class: 'c-note row' }, h('span', { class: 'grow' }, `${mine.length === 1 ? `${mine[0].title} is` : `${mine.length} workouts are`} waiting to send.`),
      navigator.onLine ? btn('Send now', (e) => busy(e.currentTarget, async () => { const n = await flush(); if (n) { toast('Sent. Your coach can see it now.'); refresh(); } else if (outbox().some((x) => x.token === tokenValue)) toast('Still can\'t reach the server. It will keep trying.', 'warn'); }), 'secondary') : null) : null);
}

// ---------- Rest timer ----------
const prefs = Object.assign({ rest: true, rest_sec: 90 }, store.get('dp_wo_prefs') ?? {});
const savePrefs = () => store.set('dp_wo_prefs', prefs);
const restBar = h('div', { class: 'c-rest', hidden: true, role: 'timer', 'aria-label': 'Rest timer' });
let rest = null;
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
// The coach's rest for the exercise wins over the athlete's own setting; a rest of 0 (a circuit) means no timer.
function startRest(x = null) {
  if (!prefs.rest) return;
  stopRest();
  const secs = x?.rest_seconds != null ? x.rest_seconds : prefs.rest_sec;
  if (!secs) return;
  rest = { ends: Date.now() + secs * 1000, tick: setInterval(drawRest, 250) };
  say(`Rest ${clock(secs)}.`);
  drawRest();
}
function stopRest() { if (rest) clearInterval(rest.tick); rest = null; restBar.hidden = true; document.body.classList.remove('c-resting'); }
function drawRest() {
  if (!rest) return;
  const left = Math.max(0, Math.round((rest.ends - Date.now()) / 1000));
  if (!left) { stopRest(); try { navigator.vibrate?.([300, 120, 300]); } catch { /* no buzz */ } say('Rest over. Next set.'); toast('Rest over. Next set.'); return; }
  restBar.hidden = false; document.body.classList.add('c-resting');   // room to scroll the page above the timer
  const bump = (s) => { rest.ends += s * 1000; drawRest(); };
  if (!restBar.firstChild) {
    fill(restBar, h('span', { class: 'c-rest-label' }, 'Rest'), h('span', { class: 'c-rest-time' }),
      btn('−15 s', () => bump(-15), 'secondary', { 'aria-label': 'Take 15 seconds off' }), btn('+15 s', () => bump(15), 'secondary', { 'aria-label': 'Add 15 seconds' }), btn('Skip', () => { stopRest(); say('Rest skipped.'); }, 'ghost'));
  }
  restBar.querySelector('.c-rest-time').textContent = clock(left);
}

// ---------- How ready the athlete is today ----------
function readinessCard(r) {
  if (!r) return null;
  if (!r.level) return h('div', { class: 'c-ready' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, r.headline), h('span', { class: 'small muted' }, r.advice)), btn('Check in', () => show('accountability'), 'secondary'));
  return h('div', { class: `c-ready c-ready--${r.level}`, role: 'status' },
    h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, r.headline),
      r.reasons.length ? h('span', { class: 'small' }, `From your check-in: ${r.reasons.join(', ').toLowerCase()}.`) : null,
      h('span', { class: 'small muted' }, r.advice)));
}

// ---------- Workout tab ----------
const lb = (w) => (w == null ? '' : `${Number.isInteger(w) ? w : w.toFixed(1)} lb`);
const setText = (s) => [s.weight != null ? lb(s.weight) : null, s.reps != null ? `${s.reps} reps` : null].filter(Boolean).join(' × ') || 'done';
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const RPE_WORDS = ['', 'Very easy', 'Easy', 'Moderate', 'Somewhat hard', 'Hard', 'Hard', 'Very hard', 'Very hard', 'Near max', 'Max effort'];
const top = () => h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' });

function render() {
  const home = state.home;
  store.set(`dp_wo_home_${String(tokenValue).slice(0, 16)}`, { token: tokenValue, home });
  drawPending();
  if (state.done) return renderDone(state.done);
  const kept = store.get(DRAFT_KEY());
  if (kept?.token === tokenValue && kept.log_id && kept.workout) { draft = kept; return renderLogger(kept.workout); }
  if (home.locked || !home.workout) {
    stopRest();
    fill(view, top(), h('div', { class: 'c-title' }, `Hi ${home.client.first_name}`), pendingBox, h('div', { class: 'dp-panel' }, h('p', null, home.message)),
      strayPanel(), historyPanel(home), h('p', { class: 'small muted' }, 'Check in, see your goals, results and lessons with the tabs below.'));
    return;
  }
  // Finished offline and not sent yet: don't show the same workout again.
  if (outbox().some((x) => x.token === tokenValue && x.kind === 'finish' && x.workout_id === home.workout.id)) {
    fill(view, top(), h('div', { class: 'c-title' }, `Hi ${home.client.first_name}`), pendingBox,
      h('div', { class: 'dp-panel stack' }, h('p', null, `${home.workout.title} is finished and saved on this phone. It sends when you're back online, then your next workout shows here.`)),
      comingUp(home.upcoming), historyPanel(home));
    return;
  }
  draftFor(home.workout);
  renderLogger(home.workout);
}

// A draft left for a workout that isn't next any more.
function strayPanel() {
  const d = strayDraft();
  if (!d) return null;
  return h('div', { class: 'c-note stack' }, h('span', null, `You logged sets in ${d.title} but didn't finish it.`),
    h('div', { class: 'row wrap' }, btn('Finish it now', (e) => busy(e.currentTarget, async () => { await finish(d, null); }), 'secondary'),
      btn('Discard', () => { if (confirm(`Throw away the sets you logged in ${d.title}?`)) { store.set(DRAFT_KEY(), null); draft = null; render(); } }, 'ghost')));
}

// The sets to show for an exercise: the target number, or more if the athlete added some.
function rowsFor(x) {
  const rows = draft.sets[x.id] ?? [];
  const n = Math.max(x.target_sets || 1, rows.length);
  return Array.from({ length: Math.min(n, 12) }, (_, i) => rows[i] ?? { weight: '', reps: '', done: false });
}
// Blank weight uses the weight of the set before it today, else today's weight from a tested max, else last time's
// weight for that set; blank reps use the target.
const defaultWeight = (x, i) => {
  const before = (draft?.sets[x.id] ?? []).slice(0, i).reverse().find((r) => r.done && r.weight != null && r.weight !== '');
  return (before ? Number(before.weight) : null) ?? x.load?.lb ?? x.last?.sets?.[i]?.weight ?? x.last?.sets?.at(-1)?.weight ?? null;
};
const exDone = (x) => { const rows = rowsFor(x); return rows.length > 0 && rows.every((r) => r.done); };
const exStarted = (x) => (draft.sets[x.id] ?? []).some((r) => r.done);

function renderLogger(w) {
  const home = state.home;
  const reopened = !!draft.log_id;
  if (!state.open || !w.exercises.some((x) => x.id === state.open)) state.open = (w.exercises.find((x) => !exDone(x)) ?? w.exercises[0])?.id ?? null;
  const pct = home.progress?.total ? Math.round((home.progress.completed / home.progress.total) * 100) : 0;
  const cards = new Map();
  const count = h('div', { class: 'small muted' });
  const drawCount = () => { count.textContent = `${w.exercises.filter(exDone).length} of ${w.exercises.length} exercises done · ${((n) => `${n} ${n === 1 ? 'set' : 'sets'}`)(Object.values(draft.sets).flat().filter((r) => r.done).length)} logged`; };

  function headOf(x) {
    const isOpen = x.id === state.open;
    const logged = (draft.sets[x.id] ?? []).filter((r) => r.done).length;
    return h('button', { type: 'button', class: 'c-ex-head', 'aria-expanded': String(isOpen), onClick: () => { state.open = isOpen ? null : x.id; redrawCards(); if (!isOpen) cards.get(x.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
      h('span', { class: 'c-ex-mark', 'aria-hidden': 'true' }, exDone(x) ? '✓' : playIcon()),
      h('span', { class: 'dp-ex-body' }, h('span', { class: 'dp-ex-name' }, groupTag(x), x.group_tag ? ' ' : null, x.name),
        h('span', { class: 'dp-ex-sets' }, [detailsOf(x), logged ? `${logged} of ${rowsFor(x).length} sets logged` : null].filter(Boolean).join(' · ')),
        x.load ? h('span', { class: `small ${x.load.missing ? 'muted' : 'strong'}`, style: x.load.missing ? null : `color:var(${x.load.planned_pct ? '--amber' : '--green-bright'})` }, x.load.text) : null),
      h('span', { class: 'sr-only' }, exDone(x) ? ' (done)' : ''));
  }
  function card(x) {
    const box = h('div', { class: `c-ex${x.id === state.open ? ' c-ex--open' : ''}${exDone(x) ? ' c-ex--done' : ''}${x.group_label ? ' sf-in-group' : ''}` });
    const isOpen = x.id === state.open;
    box.append(headOf(x));
    if (isOpen) {
      box.append(h('div', { class: 'stack c-ex-media' },
        x.video_url !== undefined ? videoEmbed(x.video_url, x.name, 'Demo video coming soon. Follow the cues below.', x.poster_url) : null,
        x.note ? h('p', { class: 'c-cue strong' }, `Coach's note: ${x.note}`) : null,
        x.instructions ? h('p', { class: 'c-cue' }, x.instructions) : null,
        x.last?.sets?.length ? h('p', { class: 'small muted' }, `Last time (${shortDate(x.last.date)}): ${x.last.sets.map(setText).join(', ')}`) : null,
        x.best_weight ? h('p', { class: 'small muted' }, `Your best: ${lb(x.best_weight)}`) : null));
      const setsBox = h('div', { class: 'c-sets' });
      box.append(setsBox);
      drawSets(x, setsBox);
    }
    return box;
  }
  function drawSets(x, setsBox, focus) {
    const rows = rowsFor(x);
    const counted = x.target_reps != null;
    fill(setsBox, rows.map((r, i) => {
      const wIn = h('input', { class: 'dp-input c-num', type: 'number', inputmode: 'decimal', min: '0', max: '2000', step: '0.5', value: r.weight === '' || r.weight == null ? '' : String(r.weight), placeholder: defaultWeight(x, i) != null ? String(defaultWeight(x, i)) : 'lb', 'aria-label': `${x.name} set ${i + 1} weight in pounds` });
      const rIn = h('input', { class: 'dp-input c-num', type: 'number', inputmode: 'numeric', min: '0', max: '500', step: '1', value: r.reps === '' || r.reps == null ? '' : String(r.reps), placeholder: x.target_reps != null ? String(x.target_reps) : 'reps', 'aria-label': `${x.name} set ${i + 1} reps` });
      const keep = () => { const all = rowsFor(x); all[i] = { ...all[i], weight: wIn.value, reps: rIn.value }; draft.sets[x.id] = all; saveDraft(); };
      wIn.addEventListener('input', keep); rIn.addEventListener('input', keep);
      const tick = h('button', { type: 'button', class: 'dp-ex-log c-tick', 'aria-pressed': String(!!r.done), 'data-set': String(i), 'aria-label': `${r.done ? 'Logged' : 'Log'} ${x.name} set ${i + 1}`, onClick: () => toggleSet(x, i, setsBox, wIn.value, rIn.value) }, r.done ? '✓' : 'Log');
      return h('div', { class: `c-set${r.done ? ' c-set--done' : ''}` }, h('span', { class: 'c-set-no' }, `Set ${i + 1}`),
        counted ? [h('label', { class: 'c-set-field' }, wIn, h('span', { class: 'small muted' }, 'lb')), h('label', { class: 'c-set-field' }, rIn, h('span', { class: 'small muted' }, 'reps'))] : h('span', { class: 'grow small muted' }, i === 0 ? x.prescription : ''),
        tick);
    }), h('div', { class: 'row' }, rows.length < 12 ? btn('Add a set', () => { const all = rowsFor(x); all.push({ weight: '', reps: '', done: false }); draft.sets[x.id] = all; saveDraft(); drawSets(x, setsBox, rows.length); }, 'ghost') : null));
    if (focus != null) setsBox.querySelector(`[data-set="${focus}"]`)?.focus();
  }
  function toggleSet(x, i, setsBox, weight, reps) {
    const all = rowsFor(x);
    const r = all[i];
    if (r.done) {                                   // untick: the set is cleared
      all[i] = { weight: r.weight, reps: r.reps, done: false };
      draft.sets[x.id] = all; saveDraft();
      say(`Set ${i + 1} of ${x.name} cleared.`);
      drawSets(x, setsBox, i); redrawHead(x); drawCount();
      return;
    }
    const wv = weight === '' ? defaultWeight(x, i) : Number(weight);
    const rv = reps === '' ? x.target_reps ?? null : Number(reps);
    if (wv != null && (!Number.isFinite(wv) || wv < 0 || wv > 2000)) return toast('Enter a weight from 0 to 2000 lb, or leave it blank.', 'warn');
    if (rv != null && (!Number.isInteger(rv) || rv < 0 || rv > 500)) return toast('Enter reps as a whole number from 0 to 500, or leave it blank.', 'warn');
    const counted = x.target_reps != null;
    all[i] = { weight: counted ? wv : null, reps: counted ? rv : null, done: true };
    draft.sets[x.id] = all;
    if (!draft.started_at) draft.started_at = new Date().toISOString();
    saveDraft();
    say(`Set ${i + 1} of ${x.name} logged${counted && wv != null ? `: ${lb(wv)}` : ''}${counted && rv != null ? ` for ${rv}` : ''}.`);
    if (exDone(x)) {
      // The last set marks the exercise done and opens the next one.
      const next = w.exercises.find((e) => !exDone(e));
      say(next ? `${x.name} done. Next: ${next.name}.` : `${x.name} done. That's every exercise. Finish when you're ready.`);
      state.open = next?.id ?? null;
      redrawCards();
      if (next) { startRest(x); cards.get(next.id)?.querySelector('.c-tick')?.focus(); cards.get(next.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else finishBtn.focus();
    } else {
      drawSets(x, setsBox, all.findIndex((s) => !s.done));
      redrawHead(x);
      startRest(x);
    }
    drawCount();
  }
  const list = h('div', { class: 'stack', style: 'gap:8px' });
  const redrawCards = () => { cards.clear(); fill(list, withGroups(w.exercises, (x) => { const c = card(x); cards.set(x.id, c); return c; })); drawCount(); };
  // Only the exercise's heading changes after a set, so a playing demo video and the focus are left alone.
  const redrawHead = (x) => { const box = cards.get(x.id); if (!box) return; box.querySelector('.c-ex-head').replaceWith(headOf(x)); box.classList.toggle('c-ex--done', exDone(x)); };

  // Effort (optional), a note, and Finish.
  const effortBox = h('div', { class: 'c-effort', role: 'radiogroup', 'aria-label': 'How hard was it? 1 is very easy, 10 is max effort' });
  const effortWord = h('span', { class: 'small muted' });
  const drawEffort = () => {
    fill(effortBox, Array.from({ length: 10 }, (_, i) => i + 1).map((n) => h('button', { type: 'button', role: 'radio', class: 'c-effort-n', 'aria-checked': String(draft.rpe === n), 'aria-label': `${n}: ${RPE_WORDS[n]}`,
      onClick: () => { draft.rpe = draft.rpe === n ? null : n; saveDraft(); drawEffort(); say(draft.rpe ? `Effort ${n}, ${RPE_WORDS[n].toLowerCase()}.` : 'Effort cleared.'); } }, String(n))));
    effortWord.textContent = draft.rpe ? `${draft.rpe} of 10: ${RPE_WORDS[draft.rpe].toLowerCase()}` : 'Optional. Tap again to clear.';
  };
  drawEffort();
  const notes = h('textarea', { class: 'dp-input', id: 'notes', placeholder: 'How did it feel? Anything your coach should know?', onInput: (e) => { draft.notes = e.target.value; saveDraft(); } });
  notes.value = draft.notes || '';
  const restToggle = h('input', { type: 'checkbox', checked: prefs.rest, onChange: (e) => { prefs.rest = e.target.checked; savePrefs(); if (!prefs.rest) stopRest(); } });
  const restLen = h('select', { class: 'select', style: 'width:auto;min-width:96px', 'aria-label': 'Rest length', onChange: (e) => { prefs.rest_sec = Number(e.target.value); savePrefs(); } },
    [45, 60, 90, 120, 150, 180].map((s) => h('option', { value: String(s), selected: s === prefs.rest_sec }, clock(s))));
  const finishBtn = btn(reopened ? 'Save changes' : 'Finish workout', (e) => busy(e.currentTarget, async () => {
    const left = w.exercises.filter((x) => !exDone(x) && !exStarted(x));
    if (!reopened && left.length === w.exercises.length) throw new Error('Log at least one set before you finish.');
    if (!reopened && left.length && !confirm(`You haven't logged ${left.length === 1 ? left[0].name : `${left.length} exercises`}. Finish anyway?`)) return;
    await finish(draft, w);
  }), 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:52px' });

  redrawCards();
  const blocked = reopened ? null : strayPanel();
  fill(view, top(),
    h('div', { class: 'stack-tight' },
      h('div', { class: 'small muted' }, reopened ? `Reopened: ${w.program_name ?? home.program?.name ?? ''}` : `Hi ${home.client.first_name}. Week ${w.week}, day ${w.day} of ${home.program.name}`),
      h('h1', { class: 'c-title' }, w.title)),
    pendingBox,
    reopened ? h('div', { class: 'c-note row' }, h('span', { class: 'grow' }, 'Fix what you logged, then save. Your coach sees the changes.'), btn('Cancel', () => { store.set(DRAFT_KEY(), null); draft = null; render(); }, 'ghost')) : null,
    reopened ? null : h('div', { class: 'stack-tight' }, h('div', { class: 'c-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Program progress' }, h('div', { style: `width:${pct}%` })),
      h('div', { class: 'small muted' }, `${home.progress.completed} of ${home.progress.total} workouts done`)),
    blocked,
    reopened ? null : readinessCard(home.readiness),
    count, list,
    h('div', { class: 'dp-panel stack' },
      h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'How hard was it?'), effortBox, effortWord),
      h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: 'notes' }, 'Notes for your coach (optional)'), notes),
      h('div', { class: 'row wrap small' }, h('label', { class: 'row', style: 'gap:8px;min-height:44px' }, restToggle, 'Rest timer after each set'), restLen,
        w.exercises.some((x) => x.rest_seconds != null) ? h('span', { class: 'muted' }, 'Where your coach set a rest, that one is used.') : null)),
    finishBtn,
    reopened ? null : comingUp(home.upcoming),
    reopened ? null : historyPanel(home),
    restBar);
}

// Finish (or save a reopened workout): into the outbox, then send. With no signal it's kept and sent later.
async function finish(d, w) {
  // Only exercises still in the workout (the coach may have changed it since the sets were logged).
  if (w) d = { ...d, sets: Object.fromEntries(Object.entries(d.sets).filter(([id]) => w.exercises.some((x) => x.id === id))) };
  const body = { request_id: d.request_id, notes: d.notes || undefined, rpe: d.rpe ?? undefined, started_at: d.started_at ?? undefined, finished_at: new Date().toISOString(),
    exercise_ids: Object.entries(d.sets).filter(([, rows]) => rows.some((r) => r.done)).map(([id]) => id),
    sets: Object.entries(d.sets).flatMap(([id, rows]) => rows.map((r, i) => (r.done ? { workout_exercise_id: id, set_no: i + 1, weight: r.weight ?? null, reps: r.reps ?? null } : null)).filter(Boolean)) };
  if (d.log_id) delete body.finished_at;
  const entry = { token: d.token, kind: d.log_id ? 'edit' : 'finish', workout_id: d.workout_id, log_id: d.log_id, request_id: d.request_id, title: d.title, body };
  setOutbox([...outbox().filter((x) => x.request_id !== entry.request_id), entry]);
  store.set(DRAFT_KEY(), null);
  draft = null; state.open = null; state.details.clear();
  stopRest();
  await flush();
  const out = results.get(entry.request_id);
  if (out?.error) { refresh(); return; }
  if (out) {
    state.home = out.next;
    state.done = { ...out.finished, next: out.next.workout, upcoming: out.next.upcoming, can_reopen: out.next.reopen_id === out.finished.id };
  } else {
    // Not sent yet: say so, with what we know on the phone.
    const sets = body.sets.length;
    state.done = { offline: true, title: d.title, sets, rpe: body.rpe ?? null, minutes: d.started_at ? Math.round((Date.now() - Date.parse(d.started_at)) / 60000) : null, bests: [], next: null, upcoming: state.home?.upcoming ?? [] };
  }
  engage.load().catch(() => {});
  render();
  window.scrollTo(0, 0);
}

function renderDone(f) {
  const facts = [f.sets ? `${f.sets} ${f.sets === 1 ? 'set' : 'sets'}` : null, f.minutes && f.minutes >= 1 && f.minutes <= 240 ? `${f.minutes} min` : null, f.rpe ? `effort ${f.rpe}/10 (${RPE_WORDS[f.rpe].toLowerCase()})` : null].filter(Boolean);
  const nextUp = f.next ?? null;
  fill(view, top(), pendingBox,
    h('div', { class: 'dp-panel stack' }, h('h1', { class: 'c-done', tabindex: '-1' }, f.edited ? 'Changes saved' : 'Workout logged'),
      h('p', { class: 'muted' }, f.offline ? 'Saved on this phone. It sends when you\'re back online, and your coach sees it then.' : f.merged ? 'Added to the workout you logged on the weight-room screen. Your coach can see it now.' : 'Your coach can see it now.'),
      facts.length ? h('p', { class: 'strong' }, facts.join(' · ')) : null,
      f.bests?.length ? h('div', { class: 'c-bests' }, h('div', { class: 'strong' }, 'New best'), f.bests.map((b) => h('div', null, `${b.name}: ${lb(b.weight)} (was ${lb(b.previous)})`))) : null,
      nextUp ? h('p', null, `Next up: ${nextUp.title}, week ${nextUp.week} day ${nextUp.day}.`) : f.upcoming?.[0] && f.offline ? h('p', null, `Next up: ${f.upcoming[0].title}.`) : !f.offline && state.home?.message ? h('p', null, state.home.message) : null,
      h('div', { class: 'row wrap' },
        btn(nextUp ? 'See next workout' : 'Back to my workouts', () => { state.done = null; render(); window.scrollTo(0, 0); }, 'secondary'),
        f.can_reopen ? btn('Reopen this workout', (e) => busy(e.currentTarget, () => reopen(f.id)), 'ghost') : null)));
  view.querySelector('.c-done')?.focus();
}

// Reopen: the latest finished workout, within 2 hours, before the next one is started.
async function reopen(logId) {
  const d = store.get(DRAFT_KEY());
  if (d && d.token === tokenValue && !d.log_id && hasSets(d)) throw new Error('You\'ve started your next workout, so this one can\'t be reopened. Put anything you missed in a note.');
  const log = await api('GET', `/app/api/logs/${logId}`);
  if (!log.can_reopen) throw new Error('This workout can\'t be reopened any more. Put anything you missed in a note next time.');
  const exercises = log.exercises.filter((x) => !x.removed);
  draft = { token: tokenValue, workout_id: log.workout_id, log_id: log.id, title: log.title, request_id: `edit-${log.id}-${newId()}`, started_at: null, notes: log.notes ?? '', rpe: log.rpe ?? null,
    sets: Object.fromEntries(exercises.map((x) => [x.id, x.sets.map((s) => ({ weight: s.weight, reps: s.reps, done: true }))])) };
  saveDraft();
  draft.workout = { id: log.workout_id, title: log.title, week: log.week, day: log.day, program_name: log.program_name, exercises: exercises.map((x) => ({ id: x.id, exercise_id: x.exercise_id, name: x.name, prescription: x.prescription, details: x.details, note: x.note, rest_seconds: x.rest_seconds, group_label: x.group_label, group_kind: x.group_kind, group_tag: x.group_tag, target_sets: Math.max(x.target_sets, x.sets.at(-1)?.set_no ?? 0), target_reps: x.target_reps })) };
  // Fill gaps: a set logged as number 3 with no 1 and 2 still shows in its place.
  for (const x of exercises) { const rows = []; for (const s of x.sets) rows[s.set_no - 1] = { weight: s.weight, reps: s.reps, done: true }; draft.sets[x.id] = Array.from(rows, (r) => r ?? { weight: '', reps: '', done: false }); }
  saveDraft();
  state.done = null; state.open = null;
  render();
  window.scrollTo(0, 0);
}

function comingUp(list) {
  if (!list?.length) return null;
  return h('section', { class: 'dp-panel stack' }, h('h2', { class: 'dp-panel-title' }, 'Coming up'),
    list.map((u) => h('div', { class: 'list-item', style: 'align-items:flex-start' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, u.title), h('span', { class: 'small muted' }, `Week ${u.week}, day ${u.day} · ${u.exercises.join(', ') || 'No exercises yet'}`)))));
}

// Finished workouts: tap one to see every exercise, its sets, effort and the note.
function historyPanel(home) {
  if (!home.history?.length) return null;
  return h('section', { class: 'dp-panel stack' }, h('h2', { class: 'dp-panel-title' }, 'Finished workouts'),
    home.history.map(function makeRow(l) {
      const open = state.historyOpen.has(l.id);
      const body = h('div', { class: 'stack c-hist-body' });
      const row = h('div', { class: 'c-hist' },
        h('button', { type: 'button', class: 'c-hist-head', 'aria-expanded': String(open), onClick: async () => {
          if (state.historyOpen.has(l.id)) state.historyOpen.delete(l.id); else state.historyOpen.add(l.id);
          const fresh = makeRow(l);                 // opens in place: the workout above keeps its video and typing
          row.replaceWith(fresh);
          fresh.querySelector('.c-hist-head').focus();
        } }, h('span', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, l.workout_title),
          h('span', { class: 'small muted' }, [shortDate(l.completed_at), l.program_deleted ? `${l.program_name ?? 'Program'} (since removed by your coach)` : null, `${l.exercises_logged} of ${l.exercises_total} exercises`, l.sets ? `${l.sets} sets` : null, l.rpe ? `effort ${l.rpe}/10` : null, l.on_screen ? 'weight-room screen' : null].filter(Boolean).join(' · '))),
        h('span', { 'aria-hidden': 'true', class: 'muted' }, open ? '−' : '+')), open ? body : null);
      if (open) {
        const fillBody = (d) => fill(body,
          d.exercises.map((x) => h('div', { class: 'small' }, h('span', { class: x.done ? 'strong' : 'muted' }, `${x.name}${x.done ? '' : ' (not logged)'}${x.removed ? ' (no longer in the workout)' : ''}`),
            x.sets.length ? h('div', { class: 'muted' }, x.sets.map((s) => `Set ${s.set_no}: ${setText(s)}`).join(' · ')) : null)),
          d.minutes ? h('div', { class: 'small muted' }, `${d.minutes} min`) : null,
          d.bests?.length ? h('div', { class: 'small good-text' }, `New best: ${d.bests.map((b) => `${b.name} ${lb(b.weight)}`).join(', ')}`) : null,
          d.notes ? h('div', { class: 'small' }, `Your note: ${d.notes}`) : null,
          d.can_reopen && home.reopen_id === d.id ? btn('Reopen this workout', (e) => busy(e.currentTarget, () => reopen(d.id)), 'ghost') : null);
        const cached = state.details.get(l.id);
        if (cached) fillBody(cached);
        else {
          fill(body, h('span', { class: 'small muted' }, 'Loading…'));
          api('GET', `/app/api/logs/${l.id}`).then((d) => { state.details.set(l.id, d); fillBody(d); }).catch((e) => fill(body, h('span', { class: 'small muted' }, e.status ? e.message : 'Can\'t load this while offline.')));
        }
      }
      return row;
    }));
}

load();
