import { h, fill, toast, busy, videoEmbed, playIcon, btn } from './ui.js';
import { createEngage, ENGAGE_TABS, tabIcon, engageDots } from './engage-view.js';
import { athleteSprint } from './sprint-ui.js';
import { detailsOf, groupTag, groupTitle, withGroups } from './set-fields.js';
import { formChecksBlock, clipPicker, sendClip } from './formchecks-ui.js';
import { startupForm, summaryText } from './startup-ui.js';

// The private link looks like /app?token=… . Keep the token for this device, then drop it from the address bar.
// An athlete who signed in at /portal with their own email has no token: the portal cookie opens the app, and
// tokenValue becomes "session:<athlete id>" so drafts and caches stay theirs (the header is left empty for it).
// The family portal's Workout tab opens /app?athlete=<id>&embed=1 for one of the parent's athletes: the portal cookie
// signs the requests and x-athlete-id says which athlete, tokenValue is "family:<id>", and the app hides its own tab
// bar (the portal's tabs stand in) and tells the portal how tall it is.
const params = new URLSearchParams(location.search);
const familyAthlete = params.get('athlete');
const embedded = params.get('embed') === '1';
let tokenValue = params.get('token') ?? (familyAthlete ? `family:${familyAthlete}` : null);
const viaCookie = (t) => /^(session|family):/.test(String(t ?? ''));
const athleteHeader = (t) => (String(t ?? '').startsWith('family:') ? { 'x-athlete-id': String(t).slice(7) } : {});
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: memory only */ } }
};
try {
  if (tokenValue && !viaCookie(tokenValue)) localStorage.setItem('dp_client_token', tokenValue);
  else if (!tokenValue) tokenValue = localStorage.getItem('dp_client_token');
} catch { /* storage blocked: keep the token in memory */ }
if (params.has('token')) history.replaceState(null, '', `/app${location.hash}`);   // keep #education and the like
// Inside the portal: report the page's height so the frame fits, whenever it changes.
if (embedded && window.parent !== window) {
  const tell = () => window.parent.postMessage({ dpAppHeight: document.documentElement.scrollHeight, athlete: familyAthlete }, location.origin);
  new ResizeObserver(tell).observe(document.body);
  window.addEventListener('load', tell);
}

const root = document.getElementById('root');
class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
const call = async (token, method, path, body) => {
  const res = await fetch(path, { method, headers: { 'x-client-token': viaCookie(token) ? '' : token || '', ...athleteHeader(token), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
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
const TAB_KEYS = ['workout', 'sprint', 'accountability', 'performance', 'education'];
const hashTab = () => { const k = location.hash.replace(/^#\/?/, '').toLowerCase(); return TAB_KEYS.includes(k) ? k : null; };
const state = { tab: hashTab() ?? 'workout', home: null, open: null, done: null, historyOpen: new Set(), details: new Map(),
  pick: null, pickWorkout: null,                       // a workout opened from the calendar instead of the one the app opens on
  calWeek: null, calDay: null };                       // the week the calendar strip shows (its Monday) and the day tapped
// The workout on screen: the one picked on the calendar, else what the server opens on.
const currentWorkout = () => state.pickWorkout ?? state.home?.workout ?? null;
const view = h('div', { class: 'c-view' });
const engage = createEngage({ api: { get: (p) => api('GET', `/app/api/${p}`), post: (p, b) => api('POST', `/app/api/${p}`, b ?? {}), del: (p) => api('DELETE', `/app/api/${p}`) }, onData: () => drawTabs() });
const tabs = h('nav', { class: 'eg-tabs', 'aria-label': 'Sections' });
function drawTabs() {
  const dots = engageDots(engage.data);
  fill(tabs, [['workout', 'Workout'], ['sprint', 'Sprint'], ...ENGAGE_TABS].map(([k, label]) => h('button', { type: 'button', class: 'eg-tab', 'aria-current': state.tab === k ? 'page' : null, onClick: () => show(k) },
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
  if (tab === 'sprint') {   // sprint reps sent to the coach and the analysis they send back (sprint-ui.js)
    fill(view, h('div', { class: 'row' }, h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), h('h1', { class: 'c-title grow', style: 'font-size:30px' }, 'Sprint')), where);
    athleteSprint(where, { api });
    return;
  }
  fill(view, h('div', { class: 'row' }, h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), h('h1', { class: 'c-title grow', style: 'font-size:30px' }, ENGAGE_TABS.find(([k]) => k === tab)[1])), where);
  engage.render(where, tab);
}
window.addEventListener('hashchange', () => { const k = hashTab() ?? 'workout'; if (k !== state.tab && root.contains(tabs)) show(k); });
async function refresh() {
  try {
    const home = await api('GET', `/app/api/home${atQ()}`); state.home = home;
    if (state.pick) { try { state.pickWorkout = await api('GET', `/app/api/workouts/${state.pick}${atQ()}`); } catch (e) { if (e.status) { state.pick = null; state.pickWorkout = null; } } }   // logged since, or gone
    if (state.tab === 'workout' && !state.done && !editing()) render();
  } catch { /* offline: keep what's on screen */ }
}

const signInLink = () => h('p', { style: 'margin:0' }, h('a', { class: 'dp-btn dp-btn--primary', href: '/portal' }, 'Sign in with your email'));
async function load() {
  let home;
  if (!tokenValue || viaCookie(tokenValue)) {                   // no private link on this phone: the portal cookie, if they signed in there
    try { home = await api('GET', `/app/api/home${atQ()}`); if (!String(tokenValue ?? '').startsWith('family:')) tokenValue = `session:${home.client?.id ?? 'me'}`; }
    catch (e) {
      const cached = tokenValue ? store.get(`dp_wo_home_${String(tokenValue).slice(0, 16)}`) : null;
      if (e.status === 401 || !tokenValue) return message('Sign in with your email to see your workouts, or open the link your coach sent you.', signInLink());
      if (e.status || !cached || cached.token !== tokenValue) return message(e.status ? e.message : 'You\'re offline. Open the app again when you have a signal.');
      home = cached.home;
    }
  } else {
    try { home = await api('GET', `/app/api/home${atQ()}`); }
    catch (e) {
      const cached = store.get(`dp_wo_home_${String(tokenValue).slice(0, 16)}`);
      if (e.status || !cached || cached.token !== tokenValue) return message(e.status ? e.message : 'You\'re offline. Open the app again when you have a signal.');
      home = cached.home;                           // offline: the last workout this phone saw
    }
  }
  fill(root, view, embedded ? null : tabs, live);         // in the portal, the portal's own tabs stand in
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
const strayDraft = () => { const d = store.get(DRAFT_KEY()); return d && d.token === tokenValue && !d.log_id && d.workout_id !== currentWorkout()?.id && hasSets(d) ? d : null; };

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
const prefs = Object.assign({ rest: true, rest_sec: 90, at_home: false, voice: true }, store.get('dp_wo_prefs') ?? {});
const savePrefs = () => store.set('dp_wo_prefs', prefs);
// An athlete who trains both places says where they are today; at home, the gear swaps apply (startup.js).
const atQ = () => (prefs.at_home && state.home?.startup?.gear?.trains_at === 'both' ? '?at=home' : '');
const restBar = h('div', { class: 'c-rest', hidden: true, role: 'timer', 'aria-label': 'Rest timer' });
let rest = null;
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
// The coach's rest for the exercise wins over the athlete's own setting; a rest of 0 (a circuit) means no timer.
function startRest(x = null) {
  if (!prefs.rest) return;
  stopRest();
  const secs = x?.rest_seconds != null ? x.rest_seconds : prefs.rest_sec;
  if (!secs) return;
  rest = { ends: Date.now() + secs * 1000, tick: setInterval(drawRest, 250), spoken: new Set() };
  say(`Rest ${clock(secs)}.`);
  speak(secs >= 60 ? `Rest. ${Math.floor(secs / 60)} ${secs >= 120 ? 'minutes' : 'minute'}${secs % 60 ? ` ${secs % 60}` : ''}.` : `Rest. ${secs} seconds.`);
  drawRest();
}
// ---------- The coach's voice (cues.js) ----------
// The phone talks when Voice is on: the rest timer's start, 30 and 10 seconds out and the end, and an exercise's cue
// where the coach left none recorded (speechSynthesis reads the words). A recorded cue plays as it is.
const canSpeak = () => prefs.voice && typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
function speak(text) {
  if (!canSpeak() || !text) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 1.05; speechSynthesis.speak(u); } catch { /* no voice on this device */ }
}
const cueAudio = new Map();   // exercise id → object URL of the recording, fetched once with the app's own headers
let cuePlaying = null;
function stopCue() { if (cuePlaying) { cuePlaying.pause(); cuePlaying = null; } if (canSpeak()) { try { speechSynthesis.cancel(); } catch { /* fine */ } } }
async function cueUrl(x) {
  if (cueAudio.has(x.exercise_id)) return cueAudio.get(x.exercise_id);
  const res = await fetch(`/app/api/exercises/${x.exercise_id}/cue/audio`, { headers: { 'x-client-token': viaCookie(tokenValue) ? '' : tokenValue || '', ...athleteHeader(tokenValue) }, credentials: 'same-origin' });
  if (!res.ok) throw new ApiError('The cue couldn\'t be loaded.', res.status);
  const url = URL.createObjectURL(await res.blob());
  cueAudio.set(x.exercise_id, url);
  return url;
}
// Play the coach's cue for an open exercise: the recording where there is one, else the words read aloud.
async function playCue(x, { auto = false } = {}) {
  if (!prefs.voice && auto) return;
  stopCue();
  if (x.cue?.audio) {
    try { const a = new Audio(await cueUrl(x)); cuePlaying = a; a.onended = () => { if (cuePlaying === a) cuePlaying = null; }; await a.play(); return; }
    catch { /* blocked or offline: fall back to the words */ }
  }
  const words = x.cue?.transcript ?? x.instructions;
  if (words) speak(auto ? words : `${x.name}. ${words}`);
}
// "Why this matters": the coach's short clip, from a short-lived link.
async function cueClip(x, holder) {
  const r = await api('GET', `/app/api/exercises/${x.exercise_id}/cue/video`);
  stopCue();
  fill(holder, h('div', { class: 'video-frame c-demo' }, h('video', { src: r.url, controls: true, autoplay: true, playsinline: true, 'aria-label': `${x.name}: why this matters` }), h('span', { class: 'c-demo-tag' }, 'Your coach')));
}
function stopRest() { if (rest) clearInterval(rest.tick); rest = null; restBar.hidden = true; document.body.classList.remove('c-resting'); }
function drawRest() {
  if (!rest) return;
  const left = Math.max(0, Math.round((rest.ends - Date.now()) / 1000));
  if (!left) { stopRest(); try { navigator.vibrate?.([300, 120, 300]); } catch { /* no buzz */ } say('Rest over. Next set.'); speak('Rest over. Next set.'); toast('Rest over. Next set.'); return; }
  for (const mark of [30, 10]) if (left === mark && !rest.spoken.has(mark)) { rest.spoken.add(mark); speak(`${mark} seconds.`); }
  restBar.hidden = false; document.body.classList.add('c-resting');   // room to scroll the page above the timer
  const bump = (s) => { rest.ends += s * 1000; drawRest(); };
  if (!restBar.firstChild) {
    fill(restBar, h('span', { class: 'c-rest-label' }, 'Rest'), h('span', { class: 'c-rest-time' }),
      btn('−15 s', () => bump(-15), 'secondary', { 'aria-label': 'Take 15 seconds off' }), btn('+15 s', () => bump(15), 'secondary', { 'aria-label': 'Add 15 seconds' }), btn('Skip', () => { stopRest(); say('Rest skipped.'); }, 'ghost'));
  }
  restBar.querySelector('.c-rest-time').textContent = clock(left);
}

// ---------- How ready the athlete is today ----------
// ---------- The start-up questions and the athlete's gear (startup.js) ----------
// First open with no program: a few questions, and the first program is ready (or the coach is told). Later, the same
// form changes the gear on file; the program stays.
let startupQuestions = null, gearOpen = false;
const whoAnswers = () => (familyAthlete ? 'parent' : 'athlete');
function startupPanel(home, { change = false } = {}) {
  const box = h('div', { class: 'dp-panel stack' }, h('p', { class: 'muted small', style: 'margin:0' }, 'Loading the questions…'));
  (async () => {
    try {
      startupQuestions ??= (await api('GET', '/app/api/startup')).questions;
      const profile = home.startup?.profile ? { ...home.startup.profile, equipment_answered: !!home.startup.gear } : null;
      const form = startupForm(startupQuestions, profile, { who: whoAnswers(), name: home.client.first_name });
      const err = h('div', { class: 'dp-error', role: 'alert' });
      fill(box, change ? null : h('div', { class: 'stack-tight' }, h('h2', { class: 'c-title', style: 'font-size:26px' }, 'Let\'s set up your training'),
          h('p', { class: 'muted', style: 'margin:0' }, `A few questions and ${whoAnswers() === 'parent' ? `${home.client.first_name}'s` : 'your'} first program is ready, built for the days and gear ${whoAnswers() === 'parent' ? 'they have' : 'you have'}. Your coach sees the answers and can change anything.`)),
        form.el, err,
        h('div', { class: 'row wrap' }, btn(change ? 'Save' : 'Start my training', (e) => { const p = form.problem(); if (p) { err.textContent = p; return; } err.textContent = ''; busy(e.currentTarget, async () => {
          const r = await api('PUT', '/app/api/startup', form.body());
          gearOpen = false;
          const placed = r.placed;
          if (placed?.outcome === 'assigned') toast(`You're on ${placed.program.name}. Your first workout is ready.`);
          else if (placed?.outcome === 'suggested' || placed?.outcome === 'no_match') toast('Saved. Your coach is picking your program.');
          else toast('Saved.');
          await refresh(); render();
        }); }, 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:52px' }),
          change ? btn('Cancel', () => { gearOpen = false; render(); }, 'ghost') : null));
    } catch (e) { fill(box, h('p', { class: 'warn-text' }, e.message)); }
  })();
  return box;
}
// "Your gear": what's on file, Change, and for an athlete who trains both places, where they are today.
function gearCard(home) {
  const st = home.startup;
  if (!st || st.needed || !st.profile) return null;
  if (gearOpen) return startupPanel(home, { change: true });
  const gear = st.gear;
  const both = gear?.trains_at === 'both';
  return h('div', { class: 'dp-panel stack-tight su-gear' },
    h('div', { class: 'row wrap', style: 'align-items:center' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'dp-label' }, gear ? 'Your gear' : 'Your answers'),
        h('span', { class: 'small' }, gear ? `${gear.labels.length ? gear.labels.join(', ') : 'Bodyweight only'} · ${gear.trains_at === 'home' ? 'training at home' : both ? 'home and the facility' : ''}`.replace(/ · $/, '') : summaryText({ ...st.profile, goal_label: st.profile.goal_label, equipment_answered: false })),
        gear && gear.trains_at !== 'facility' ? h('span', { class: 'small muted' }, 'Exercises that need gear you don\'t have are swapped for ones you can do. Tap Back to the plan on any you\'d rather keep.') : null),
      btn('Change', () => { gearOpen = true; render(); }, 'ghost')),
    both ? h('label', { class: 'row', style: 'gap:8px;min-height:44px' }, h('input', { type: 'checkbox', checked: prefs.at_home, onChange: async (e) => { prefs.at_home = e.target.checked; savePrefs(); await refresh(); render(); } }), 'Training at home today') : null);
}
function readinessCard(r) {
  if (!r) return null;
  if (!r.level) return h('div', { class: 'c-ready' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, r.headline), h('span', { class: 'small muted' }, r.advice)), btn('Check in', () => show('accountability'), 'secondary'));
  return h('div', { class: `c-ready c-ready--${r.level}`, role: 'status' },
    h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, r.headline),
      r.reasons.length ? h('span', { class: 'small' }, `From ${r.from ?? 'your check-in'}: ${r.reasons.map((x) => x.charAt(0).toLowerCase() + x.slice(1)).join(', ')}.`) : null,
      h('span', { class: 'small muted' }, r.advice)),
    r.checkin_missing ? btn('Check in', () => show('accountability'), 'ghost') : null);
}

// ---------- Workout tab ----------
const lb = (w) => (w == null ? '' : `${Number.isInteger(w) ? w : w.toFixed(1)} lb`);
const setText = (s) => [s.weight != null ? lb(s.weight) : null, s.reps != null ? `${s.reps} reps` : null].filter(Boolean).join(' × ') || 'done';
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const RPE_WORDS = ['', 'Very easy', 'Easy', 'Moderate', 'Somewhat hard', 'Hard', 'Hard', 'Very hard', 'Very hard', 'Near max', 'Max effort'];
const top = () => (embedded ? null : h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }));

function render() {
  const home = state.home;
  store.set(`dp_wo_home_${String(tokenValue).slice(0, 16)}`, { token: tokenValue, home });
  drawPending();
  if (state.done) return renderDone(state.done);
  const kept = store.get(DRAFT_KEY());
  if (kept?.token === tokenValue && kept.log_id && kept.workout) { draft = kept; return renderLogger(kept.workout); }
  const w = home.locked ? null : currentWorkout();
  if (!w) {
    stopRest();
    fill(view, top(), home.locked ? null : calendarStrip(home), h('div', { class: 'c-title' }, `Hi ${home.client.first_name}`), pendingBox,
      !home.locked && home.startup?.needed ? startupPanel(home) : h('div', { class: 'dp-panel' }, h('p', null, home.message)), home.locked ? null : gearCard(home),
      strayPanel(), formChecksSection(), historyPanel(home), h('p', { class: 'small muted' }, `Check in, see your goals, results and lessons with the tabs ${embedded ? 'above' : 'below'}.`));
    return;
  }
  // Finished offline and not sent yet: don't show the same workout again.
  if (outbox().some((x) => x.token === tokenValue && x.kind === 'finish' && x.workout_id === w.id)) {
    fill(view, top(), calendarStrip(home), h('div', { class: 'c-title' }, `Hi ${home.client.first_name}`), pendingBox,
      h('div', { class: 'dp-panel stack' }, h('p', null, `${w.title} is finished and saved on this phone. It sends when you're back online, then your next workout shows here.`)),
      comingUp(home.upcoming), historyPanel(home));
    return;
  }
  draftFor(w);
  renderLogger(w);
}

// ---------- The training calendar ----------
// Every workout of the program has a date (the coach set the start and the training days). The strip shows one week;
// tap a day to see what's planned and open it (a missed workout, or one a day ahead).
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (d) => addDays(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7));
const dayName = (d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
const STATUS_WORD = { done: 'Done', today: 'Today', missed: 'Missed', upcoming: 'Coming up' };
// The line under the title: when this workout is (or was) planned.
const whenText = (w) => (!w.date ? null : w.status === 'today' ? 'Today' : w.status === 'missed' ? `Missed · was ${dayName(w.date)}` : `Up next · ${dayName(w.date)}`);
function calendarStrip(home) {
  const cal = home.calendar;
  if (!cal?.workouts?.length) return null;
  const byDate = new Map();
  for (const w of cal.workouts) byDate.set(w.date, [...(byDate.get(w.date) ?? []), w]);
  state.calWeek ??= mondayOf(cal.today);
  const box = h('section', { class: 'dp-panel stack-tight c-cal', 'aria-label': 'Your training calendar' });
  let showPlan = false;
  const draw = () => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(state.calWeek, i));
    const cells = days.map((d) => {
      const ws = byDate.get(d) ?? [];
      const st = !ws.length ? 'rest' : ws.every((w) => w.status === 'done') ? 'done' : ws.some((w) => w.status === 'missed') ? 'missed' : d === cal.today ? 'today' : 'planned';
      return h('button', { type: 'button', class: `c-day c-day--${st}${d === cal.today ? ' c-day--now' : ''}`, 'aria-pressed': String(state.calDay === d),
        'aria-label': `${dayName(d, { weekday: 'long', month: 'long', day: 'numeric' })}${d === cal.today ? ', today' : ''}: ${ws.length ? ws.map((w) => `${w.title} (${STATUS_WORD[w.status].toLowerCase()})`).join(', ') : 'rest day'}`,
        onClick: () => { state.calDay = state.calDay === d ? null : d; draw(); } },
        h('span', { class: 'c-day-wd' }, dayName(d, { weekday: 'short' })), h('span', { class: 'c-day-n' }, String(Number(d.slice(8)))),
        h('span', { class: 'c-day-dot', 'aria-hidden': 'true' }, st === 'done' ? '✓' : st === 'missed' ? '!' : ws.length ? '•' : ''));
    });
    const picked = state.calDay ? byDate.get(state.calDay) ?? [] : null;
    const line = (w) => h('div', { class: 'c-plan-row' },
      h('span', { class: 'grow small' }, h('span', { class: 'strong' }, w.title), ` · week ${w.week} day ${w.day}${w.moved ? ' · moved by your coach' : ''} · ${STATUS_WORD[w.status].toLowerCase()}`),
      w.status === 'done' ? null : currentWorkout()?.id === w.id ? h('span', { class: 'small muted' }, 'Open below') : btn('Open', (e) => busy(e.currentTarget, () => openPick(w.id)), 'secondary', { 'aria-label': `Open ${w.title}` }));
    const weekOfToday = state.calWeek === mondayOf(cal.today);
    const label = `${dayName(days[0], { month: 'short', day: 'numeric' })} – ${dayName(days[6], { month: 'short', day: 'numeric' })}`;
    fill(box,
      h('div', { class: 'row', style: 'align-items:center;gap:6px' },
        btn('‹', () => { state.calWeek = addDays(state.calWeek, -7); state.calDay = null; draw(); }, 'ghost', { 'aria-label': 'Previous week' }),
        h('span', { class: 'grow small strong', style: 'text-align:center' }, label),
        weekOfToday ? null : btn('Today', () => { state.calWeek = mondayOf(cal.today); state.calDay = null; draw(); }, 'ghost'),
        btn('›', () => { state.calWeek = addDays(state.calWeek, 7); state.calDay = null; draw(); }, 'ghost', { 'aria-label': 'Next week' })),
      h('div', { class: 'c-week', role: 'group', 'aria-label': `Training days, ${label}` }, cells),
      picked ? h('div', { class: 'c-day-info stack-tight' }, h('span', { class: 'small strong' }, dayName(state.calDay, { weekday: 'long', month: 'long', day: 'numeric' })),
        picked.length ? picked.map(line) : h('span', { class: 'small muted' }, 'Rest day. Nothing planned.')) : null,
      h('div', { class: 'row wrap small muted', style: 'align-items:center' }, h('span', { class: 'grow' }, `${cal.counts.done} done · ${cal.counts.missed} missed · ${cal.counts.upcoming} to go · ${cal.days_text}`),
        btn(showPlan ? 'Hide the plan' : 'Whole plan', () => { showPlan = !showPlan; draw(); }, 'ghost')),
      showPlan ? h('div', { class: 'c-plan stack-tight' }, [...new Set(cal.workouts.map((w) => w.week))].map((week) => [h('span', { class: 'small strong' }, `Week ${week}`),
        ...cal.workouts.filter((w) => w.week === week).map((w) => h('div', { class: 'c-plan-row' }, h('span', { class: 'small muted', style: 'min-width:92px' }, dayName(w.date)), h('span', { class: 'grow small' }, h('span', { class: w.status === 'done' ? 'muted' : 'strong' }, w.title), w.moved ? ' · moved' : ''),
          h('span', { class: `small ${w.status === 'missed' ? 'warn-text' : w.status === 'done' ? 'good-text' : 'muted'}` }, STATUS_WORD[w.status])))])) : null);
  };
  draw();
  return box;
}
// Open a workout from the calendar. Sets already logged in another workout stay where they are: finish or discard them first.
async function openPick(id) {
  if (id === state.home?.workout?.id) { state.pick = null; state.pickWorkout = null; state.open = null; render(); window.scrollTo(0, 0); return; }
  const d = store.get(DRAFT_KEY());
  if (d && d.token === tokenValue && !d.log_id && d.workout_id !== id && hasSets(d)) throw new Error(`You've logged sets in ${d.title}. Finish it or discard those sets first.`);
  try { state.pickWorkout = await api('GET', `/app/api/workouts/${id}${atQ()}`); }
  catch (e) { if (e.status === 409) { await refresh(); } throw e; }
  state.pick = id; state.open = null;
  render();
  window.scrollTo(0, 0);
}

// The exercise's demo. A video file of ours plays muted and looping as soon as the card opens, with the still first, so
// the athlete sees the movement without a tap; the controls unmute it. YouTube and Vimeo links keep their own player.
const isVideoFile = (url) => /\.(mp4|m4v|mov|webm)(\?|$)/i.test(String(url ?? ''));
function demoVideo(x) {
  if (!x.video_url || !isVideoFile(x.video_url)) return videoEmbed(x.video_url, x.name, 'Demo video coming soon. Follow the cues below.', x.poster_url);
  const video = h('video', { src: x.video_url, controls: true, playsinline: true, muted: true, loop: true, autoplay: true, preload: 'metadata', ...(x.poster_url ? { poster: x.poster_url } : {}), 'aria-label': `${x.name} demo video` });
  video.muted = true;   // the attribute alone isn't enough for autoplay in every browser
  video.play?.().catch(() => {});
  return h('div', { class: 'video-frame c-demo' }, video, h('span', { class: 'c-demo-tag' }, 'Demo · tap for sound'));
}
// Send a clip of a set to the coach (formchecks-ui.js). Hidden until the owner has set the private bucket up.
let formChecksReady = null, formChecksAsk = null;   // null = not asked yet; one request is shared by every card
const askFormChecks = () => (formChecksAsk ??= api('GET', '/app/api/form-checks').then((d) => { formChecksReady = !!d.ready; return d; }).catch((e) => { formChecksAsk = null; throw e; }));
function formCheckSend(x) {
  // The coach asked for a clip of this one in the plan: say so even before the bucket is set up, and make the button the main one.
  const asked = !!x.form_check;
  const askBox = asked ? h('div', { class: 'c-note stack-tight', role: 'note' },
    h('span', { class: 'strong' }, x.form_check_sent ? '✓ Form check sent. Your coach will answer in the app.' : 'Your coach asked for a form check on this one.'),
    x.form_check_note ? h('span', { class: 'small' }, x.form_check_note) : null) : null;
  if (formChecksReady === false) return askBox;
  const holder = h('div', { class: 'stack-tight' }, askBox);
  const draw = () => fill(holder, askBox, clipPicker(asked && !x.form_check_sent ? 'Send the form check' : 'Send a form check', async (file, progress) => {
    const fc = await sendClip({ file, start: (b) => api('POST', '/app/api/form-checks', b), finish: (id) => api('POST', `/app/api/form-checks/${id}/done`), extra: { workout_exercise_id: x.id }, onProgress: progress });
    say(`Form check sent for ${fc.exercise_name}.`); toast(`Sent. Your coach will answer in the app; you'll see it under Form checks.`);
    if (asked) { x.form_check_sent = true; render(); }        // the card and the Finish check see the clip went up
    formChecksPanel.draw?.();
  }, { variant: asked && !x.form_check_sent ? 'primary' : 'ghost' }), h('span', { class: 'small muted' }, 'Film one set (up to 60 seconds) and your coach will answer with what to change.'));
  if (formChecksReady === true) draw();
  else askFormChecks().then((d) => { if (d.ready) draw(); }).catch(() => {});
  return holder;
}
// The clips sent and the coach's answers, under the workout.
const formChecksPanel = { el: null, draw: null };
function formChecksSection() {
  if (formChecksReady === false) return null;
  const block = formChecksBlock({ who: 'athlete', first: state.home?.client?.first_name, list: async () => { const d = await (formChecksAsk ? askFormChecks() : api('GET', '/app/api/form-checks')); formChecksAsk = null; formChecksReady = !!d.ready; if (!d.ready) section.hidden = true; else if (d.data.length) section.hidden = false; return d; },
    play: (id, which) => api('GET', `/app/api/form-checks/${id}/video?which=${which}`), seen: (id) => api('POST', `/app/api/form-checks/${id}/seen`), empty: '' });
  const section = h('section', { class: 'dp-panel stack', hidden: true }, h('h2', { class: 'dp-panel-title' }, 'Form checks'), h('p', { class: 'small muted', style: 'margin:0' }, 'Clips you sent and what your coach said. Clips are kept for a while, then removed.'), block.el);
  formChecksPanel.el = section; formChecksPanel.draw = block.draw;
  return section;
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
  if (before) return Number(before.weight);
  if (x.load?.lb != null) return x.load.lb;                                  // a step is already in the weight from the max
  const last = x.last?.sets?.[i]?.weight ?? x.last?.sets?.at(-1)?.weight ?? null;
  return last != null && x.progression?.weight_lb ? Math.max(0, last + x.progression.weight_lb) : last;   // last time's weight plus the coach-approved step
};
const exDone = (x) => { const rows = rowsFor(x); return rows.length > 0 && rows.every((r) => r.done); };
const exStarted = (x) => (draft.sets[x.id] ?? []).some((r) => r.done);

// "Can't do this today?": the swaps the coach listed for this exercise. A pick is for this workout only and can be
// undone until the workout is logged; a coach's own swap is left alone.
function altBlock(x) {
  if (draft?.log_id) return null;                                    // a reopened workout is history, not a plan to change
  if (x.swapped?.by_kind === 'athlete' || x.swapped?.by_kind === 'equipment') {
    return h('div', { class: 'stack-tight small' }, h('span', { class: 'muted' }, x.swapped.by_kind === 'equipment' ? `${x.name} fits your gear (${x.swapped.reason.toLowerCase()}). Back to the plan if you have what ${x.swapped.from} needs today.` : `You picked ${x.name} instead of ${x.swapped.from}.`),
      exStarted(x) ? null : btn(`Back to ${x.swapped.from}`, (e) => busy(e.currentTarget, async () => { await api('DELETE', `/app/api/swaps/${x.swapped.id}`); say(`Back to ${x.swapped.from}.`); await refresh(); }), 'ghost'));
  }
  if (x.swapped || !x.alternatives?.length || exStarted(x)) return null;
  const box = h('details', { class: 'c-alts' }, h('summary', { class: 'small strong', style: 'cursor:pointer' }, 'Can\'t do this today? Pick a swap'),
    h('div', { class: 'stack-tight', style: 'padding-top:6px' }, h('span', { class: 'small muted' }, `Your coach's swaps for ${x.name}. This workout only; your coach sees it.`),
      x.alternatives.map((a) => btn(`${a.name} · ${a.tag_label}${a.note ? ` · ${a.note}` : ''}`, (e) => busy(e.currentTarget, async () => {
        const r = await api('POST', '/app/api/swaps', { workout_exercise_id: x.id, alternative_id: a.id });
        say(`${r.exercise_name} instead of ${r.instead_of}.`); toast(`${r.exercise_name} today instead of ${r.instead_of}. Your coach sees the swap.`);
        await refresh();
      }), 'secondary', { style: 'text-align:left;justify-content:flex-start' }))));
  return box;
}

// A warm-up or cool-down block the coach attached to the workout: what to do, with a demo a tap away. Not logged.
function routineBlock(r, label) {
  if (!r?.exercises?.length) return null;
  const rows = r.exercises.map((x) => {
    const media = h('div');
    let open = false;
    const row = h('div', { class: 'c-rtn-row' },
      x.video_url ? h('button', { type: 'button', class: 'c-ex-mark', 'aria-label': `${open ? 'Hide' : 'Watch'} ${x.name} demo`, 'aria-expanded': 'false', onClick: (e) => { open = !open; e.currentTarget.setAttribute('aria-expanded', String(open)); fill(media, open ? videoEmbed(x.video_url, x.name, undefined, x.poster_url) : null); } }, playIcon()) : h('span', { class: 'c-ex-mark c-ex-mark--dot', 'aria-hidden': 'true' }, '·'),
      h('span', { class: 'stack-tight grow' }, h('span', { class: 'dp-ex-name' }, x.name), h('span', { class: 'dp-ex-sets' }, [x.prescription, x.note].filter(Boolean).join(' · '))));
    return h('div', null, row, media);
  });
  return h('details', { class: 'c-rtn', open: label === 'Warm-up' ? '' : null },
    h('summary', { class: 'c-rtn-sum' }, h('span', { class: 'dp-label', style: 'margin:0' }, label), h('span', { class: 'strong' }, r.name), h('span', { class: 'small muted' }, `${r.exercises.length} ${r.exercises.length === 1 ? 'move' : 'moves'}`)),
    r.note ? h('p', { class: 'c-cue', style: 'margin:0 0 6px' }, r.note) : null, rows);
}

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
      h('span', { class: `c-ex-mark${x.poster_url && !exDone(x) ? ' c-ex-mark--still' : ''}`, 'aria-hidden': 'true' }, exDone(x) ? '✓' : x.poster_url ? [h('img', { src: x.poster_url, alt: '', loading: 'lazy' }), h('span', { class: 'c-ex-mark-play' }, playIcon())] : playIcon()),
      h('span', { class: 'dp-ex-body' }, h('span', { class: 'dp-ex-name' }, groupTag(x), x.group_tag ? ' ' : null, x.name),
        h('span', { class: 'dp-ex-sets' }, [detailsOf(x), x.planned_sets ? `${x.target_sets} ${x.target_sets === 1 ? 'set' : 'sets'} today (${x.planned_sets} planned)` : null, logged ? `${logged} of ${rowsFor(x).length} sets logged` : null].filter(Boolean).join(' · ')),
        x.swapped ? h('span', { class: 'small', style: 'color:var(--amber)' }, x.swapped.by_kind === 'athlete' ? `Your pick instead of ${x.swapped.from}${x.swapped.reason ? ` (${x.swapped.reason.toLowerCase()})` : ''}` : x.swapped.by_kind === 'equipment' ? `For your gear instead of ${x.swapped.from} (${x.swapped.reason.toLowerCase()})` : `Swapped in by ${x.swapped.by ? `Coach ${x.swapped.by.split(' ')[0]}` : 'your coach'} instead of ${x.swapped.from}${x.swapped.reason ? ` (${x.swapped.reason})` : ''}`) : null,
        x.form_check ? h('span', { class: 'small strong', style: x.form_check_sent ? 'color:var(--green-bright)' : 'color:var(--amber)' }, x.form_check_sent ? '✓ Form check sent' : 'Form check asked') : null,
        x.progression?.text ? h('span', { class: 'small strong', style: 'color:var(--green-bright)' }, `Your progression: ${x.progression.text} on the plan`) : null,
        x.load ? h('span', { class: `small ${x.load.missing ? 'muted' : 'strong'}`, style: x.load.missing ? null : `color:var(${x.load.planned_pct ? '--amber' : '--green-bright'})` }, x.load.text) : null),
      h('span', { class: 'sr-only' }, exDone(x) ? ' (done)' : ''));
  }
  function card(x) {
    const box = h('div', { class: `c-ex${x.id === state.open ? ' c-ex--open' : ''}${exDone(x) ? ' c-ex--done' : ''}${x.group_label ? ' sf-in-group' : ''}` });
    const isOpen = x.id === state.open;
    box.append(headOf(x));
    if (isOpen) {
      // The demo plays on its own, muted and looping, the moment the card opens (tap it for sound); Send a form check sits right under it.
      // The coach's cue plays as the card opens (the recording, or the words read aloud); Why this matters plays their clip.
      const clipHolder = h('div');
      const cueRow = x.cue?.audio || x.cue?.clip || x.cue?.transcript || x.instructions ? h('div', { class: 'row wrap small', style: 'gap:8px;align-items:center' },
        x.cue?.audio || x.cue?.transcript || x.instructions ? btn(x.cue?.audio ? '🔊 Coach\'s cue' : '🔊 Read the cue', (e) => busy(e.currentTarget, () => playCue(x)), 'ghost') : null,
        x.cue?.clip ? btn('Why this matters', (e) => busy(e.currentTarget, () => cueClip(x, clipHolder)), 'ghost') : null,
        h('label', { class: 'row muted', style: 'gap:6px;min-height:44px' }, h('input', { type: 'checkbox', checked: prefs.voice, onChange: (e) => { prefs.voice = e.target.checked; savePrefs(); if (!prefs.voice) stopCue(); } }), 'Voice')) : null;
      if (!draft?.log_id && !exStarted(x)) playCue(x, { auto: true }).catch(() => {});
      box.append(h('div', { class: 'stack c-ex-media' },
        x.video_url !== undefined ? demoVideo(x) : null,
        cueRow, clipHolder,
        formCheckSend(x),
        x.note ? h('p', { class: 'c-cue strong' }, `Coach's note: ${x.note}`) : null,
        x.instructions ? h('p', { class: 'c-cue' }, x.instructions) : null,
        x.last?.sets?.length ? h('p', { class: 'small muted' }, `Last time (${shortDate(x.last.date)}): ${x.last.sets.map(setText).join(', ')}`) : null,
        x.best_weight ? h('p', { class: 'small muted' }, `Your best: ${lb(x.best_weight)}`) : null,
        altBlock(x)));
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
    // A superset or circuit flows: straight on to the partner exercise, and rest only when the round is over.
    const flow = nextInFlow(x);
    if (flow?.next) {
      const next = flow.next;
      if (next.id !== x.id) { state.open = next.id; redrawCards(); }
      else { drawSets(x, setsBox, all.findIndex((s) => !s.done)); redrawHead(x); }
      say(flow.round_over ? `Round done. Rest, then ${next.name}.` : `Now ${next.name}.`);
      if (flow.round_over) startRest(restOfGroup(flowOf(x)));
      const target = cards.get(next.id)?.querySelector('.c-tick[aria-pressed="false"]') ?? cards.get(next.id)?.querySelector('.c-tick');
      if (next.id !== x.id) { target?.focus(); cards.get(next.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      drawCount();
      return;
    }
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
  // The exercises that run together with x as one flow (a superset or circuit; a block is only a heading), in order.
  function flowOf(x) {
    if (!x.group_label || (x.group_kind !== 'superset' && x.group_kind !== 'circuit')) return null;
    const g = w.exercises.filter((e) => e.group_label === x.group_label);
    return g.length > 1 ? g : null;
  }
  // After a set of x: the next partner with a set left (round and round), and whether reaching it ends a round. Null
  // when x isn't in a flow; next null when the whole group is done.
  function nextInFlow(x) {
    const g = flowOf(x);
    if (!g) return null;
    const i = g.indexOf(x), order = [...g.slice(i + 1), ...g.slice(0, i + 1)];   // the partners after x, then round to x itself
    const next = order.find((e) => !exDone(e)) ?? null;
    return { next, round_over: !next || order.indexOf(next) >= g.length - 1 - i };
  }
  // The rest between rounds: the longest rest a coach set on the group (0 = none, a circuit), else the athlete's own.
  const restOfGroup = (g) => { const secs = g.map((e) => e.rest_seconds).filter((s) => s != null); return secs.length ? { rest_seconds: Math.max(...secs) } : null; };
  const groupHeading = (x) => h('div', { class: 'sf-group' }, groupTitle(x),
    flowOf(x) ? h('span', { style: 'text-transform:none;letter-spacing:0;font-weight:400;color:var(--steel-muted)' }, ` · one set of each${x.group_kind === 'circuit' ? ' in turn' : ''}, then rest`) : null);
  const list = h('div', { class: 'stack', style: 'gap:8px' });
  const redrawCards = () => { stopCue(); cards.clear(); fill(list, withGroups(w.exercises, (x) => { const c = card(x); cards.set(x.id, c); return c; }, groupHeading)); drawCount(); };
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
    const unsent = reopened ? [] : w.exercises.filter((x) => x.form_check && !x.form_check_sent && formChecksReady !== false);
    if (unsent.length && !confirm(`Your coach asked for a form check on ${unsent.map((x) => x.name).join(' and ')}. Finish without sending it?`)) return;
    await finish(draft, w);
  }), 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:52px' });

  redrawCards();
  const blocked = reopened ? null : strayPanel();
  fill(view, top(),
    reopened ? null : calendarStrip(home),
    h('div', { class: 'stack-tight' },
      h('div', { class: 'small muted' }, reopened ? `Reopened: ${w.program_name ?? home.program?.name ?? ''}` : `Hi ${home.client.first_name}. Week ${w.week}, day ${w.day} of ${home.program.name}`),
      h('h1', { class: 'c-title' }, w.title),
      !reopened && whenText(w) ? h('div', { class: `small strong${w.status === 'missed' ? ' warn-text' : ''}` }, whenText(w)) : null),
    pendingBox,
    !reopened && state.pickWorkout && home.workout ? h('div', { class: 'c-note row', style: 'align-items:center' }, h('span', { class: 'grow' }, `You opened this one from your calendar. ${home.workout.title} is what's up ${home.workout.status === 'today' ? 'today' : 'next'}.`),
      btn(`Back to ${home.workout.title}`, () => openPick(home.workout.id), 'ghost')) : null,
    reopened ? h('div', { class: 'c-note row' }, h('span', { class: 'grow' }, 'Fix what you logged, then save. Your coach sees the changes.'), btn('Cancel', () => { store.set(DRAFT_KEY(), null); draft = null; render(); }, 'ghost')) : null,
    reopened ? null : h('div', { class: 'stack-tight' }, h('div', { class: 'c-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Program progress' }, h('div', { style: `width:${pct}%` })),
      h('div', { class: 'small muted' }, `${home.progress.completed} of ${home.progress.total} workouts done`)),
    blocked,
    reopened ? null : readinessCard(home.readiness),
    reopened ? null : gearCard(home),
    reopened ? null : routineBlock(w.warmup, 'Warm-up'),
    count, list,
    reopened ? null : routineBlock(w.cooldown, 'Cool-down'),
    h('div', { class: 'dp-panel stack' },
      h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'How hard was it?'), effortBox, effortWord),
      h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: 'notes' }, 'Notes for your coach (optional)'), notes),
      h('div', { class: 'row wrap small' }, h('label', { class: 'row', style: 'gap:8px;min-height:44px' }, restToggle, 'Rest timer after each set'), restLen,
        w.exercises.some((x) => x.rest_seconds != null) ? h('span', { class: 'muted' }, 'Where your coach set a rest, that one is used.') : null)),
    finishBtn,
    reopened ? null : comingUp(home.upcoming),
    reopened ? null : formChecksSection(),
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
  state.pick = null; state.pickWorkout = null; state.calDay = null;
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
      f.new_maxes?.length ? h('div', { class: 'c-bests stack-tight', role: 'note' }, h('div', { class: 'strong' }, 'Your maxes'), f.new_maxes.map((m) => {
        const line = h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, h('span', { class: 'grow' }, `${m.lift.charAt(0).toUpperCase() + m.lift.slice(1)}: your sets put your max around ${m.value} lb${m.on_file ? ` (on file: ${m.on_file} lb)` : ''}.`),
          btn(`Save ${m.value} lb`, (e) => busy(e.currentTarget, async () => { await api('POST', '/app/api/maxes', { test: m.test, value: m.value, note: 'From logged sets' }); fill(line, h('span', null, `${m.lift.charAt(0).toUpperCase() + m.lift.slice(1)} max saved: ${m.value} lb. Your weights use it from now on.`)); engage.load().catch(() => {}); }), 'secondary'));
        return line;
      })) : null,
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
