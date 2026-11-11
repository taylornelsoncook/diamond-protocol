import { h, fill, toast, busy, videoEmbed, playIcon, btn } from './ui.js';
import { createEngage, ENGAGE_TABS, tabIcon, engageDots } from './engage-view.js';
import { athleteSprint } from './sprint-ui.js';
import { athleteGroups } from './groups-ui.js';
import { groupTag, groupTitle, withGroups, rxTable, timeText } from './set-fields.js';
import { formChecksBlock, clipPicker, sendClip } from './formchecks-ui.js';
import { startupForm, summaryText } from './startup-ui.js';
import { timelineBlock } from './timeline-ui.js';
import { feedBlock } from './feed-ui.js';
import { maxesBlock } from './maxes-ui.js';
import { gamesBlock, nextText, toneChip } from './games-ui.js';

// The private link looks like /app?token=… . Keep the token for this device, then drop it from the address bar.
// An athlete who signed in at /client with their own email has no token: the portal cookie opens the app, and
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
// html and body are 100% of the frame, so the document's height would follow the frame and the frame the document, for
// ever (the page grew by a few pixels a tick and the bottom never held still); the content's own box is measured instead.
if (embedded && window.parent !== window) {
  document.documentElement.style.height = 'auto'; document.body.style.height = 'auto';
  let last = 0;
  const tell = () => {
    const el = document.getElementById('root'); if (!el) return;
    const height = Math.ceil(el.getBoundingClientRect().height + el.offsetTop);
    if (Math.abs(height - last) < 2) return;
    last = height; window.parent.postMessage({ dpAppHeight: height, athlete: familyAthlete ?? 'me' }, location.origin);
  };
  new ResizeObserver(tell).observe(document.getElementById('root'));
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
const TAB_KEYS = ['workout', 'team', 'sprint', 'accountability', 'performance', 'education', 'profile'];
const hashTab = () => { const k = location.hash.replace(/^#\/?/, '').toLowerCase(); return TAB_KEYS.includes(k) ? k : null; };
const state = { tab: hashTab() ?? 'workout', home: null, open: null, done: null, historyOpen: new Set(), details: new Map(),
  pick: null, pickWorkout: null,                       // a workout opened from the calendar instead of the one the app opens on
  calWeek: null, calDay: null };                       // the week the calendar strip shows (its Monday) and the day tapped
// The workout on screen: the one picked on the calendar, else what the server opens on.
const currentWorkout = () => state.pickWorkout ?? state.home?.workout ?? null;
const view = h('div', { class: 'c-view' });
const engage = createEngage({ api: { get: (p) => api('GET', `/app/api/${p}`), post: (p, b) => api('POST', `/app/api/${p}`, b ?? {}), del: (p) => api('DELETE', `/app/api/${p}`) }, onData: () => drawTabs() });
const tabs = h('nav', { class: 'eg-tabs c-tabs', 'aria-label': 'Sections' });
function drawTabs() {
  const dots = engageDots(engage.data);
  fill(tabs, [['workout', 'Workout'], ['team', 'Team'], ['sprint', 'Sprint'], ...ENGAGE_TABS, ['profile', 'Profile']].map(([k, label]) => h('button', { type: 'button', class: 'eg-tab', 'aria-current': state.tab === k ? 'page' : null, onClick: () => show(k) },
    tabIcon(k), h('span', { class: 'eg-tab-l' }, label), dots[k] ? [h('span', { class: 'eg-tab-dot', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, k === 'education' ? ' (new reading)' : ' (new message)')] : null)));
}
function show(tab, anchor = null) {
  state.tab = tab;
  if (anchor) setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  if ((hashTab() ?? 'workout') !== tab) history.replaceState(null, '', `${location.pathname}${location.search}${tab === 'workout' ? '' : `#${tab}`}`);
  drawTabs();
  document.body.classList.remove('c-focus');
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
  if (tab === 'profile') {  // one place for everything: the timeline, maxes, streaks and the account pages
    fill(view, h('div', { class: 'row' }, h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), h('h1', { class: 'c-title grow', style: 'font-size:30px' }, 'Profile')), where);
    renderProfile(where);
    return;
  }
  if (tab === 'team') {   // the groups the athlete is in: attendance, sprint bests and the team board (groups-ui.js)
    fill(view, h('div', { class: 'row' }, h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), h('h1', { class: 'c-title grow', style: 'font-size:30px' }, 'Team')), where);
    athleteGroups(where, { api });
    return;
  }
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

// The team feed (the builder redesign, step 6): the coaches' posts to everyone, your teams and your program, with a
// fist bump and comments. One card, kept between renders so the feed isn't fetched again every minute.
let feedEl = null;
function feedCard() {
  if (!feedEl) feedEl = h('section', { class: 'dp-panel stack-tight' }, h('h2', { class: 'dp-panel-title' }, 'Team feed'),
    feedBlock({ get: (q) => api('GET', `/app/api/feed${q}`), post: (p, b) => api('POST', `/app/api/feed${p}`, b), del: (p) => api('DELETE', `/app/api/feed${p}`) }, { compact: true, limit: 5, empty: 'Nothing from your coaches yet.' }));
  return feedEl;
}
// The Profile tab (the builder redesign, step 5; owner's ask: "everything under one link"): who they are, their
// streaks, their maxes, everything they did as a timeline, and the account pages in the portal (family, payments,
// sign-in), so one link reaches everything. Inside the family portal's frame the portal's own tabs hold the account.
function renderProfile(where) {
  const home = state.home, c = home?.client ?? {};
  const s = engage.data?.accountability?.streaks;
  const streaks = s ? h('div', { class: 'eg-streaks' },
    s.plan_weeks != null ? h('div', { class: 'eg-streak' }, h('b', { class: s.plan_weeks ? 'good-text' : '' }, s.plan_weeks), h('span', { class: 'strong' }, `Clean ${s.plan_weeks === 1 ? 'week' : 'weeks'} in a row`), h('span', { class: 'small muted' }, 'Every planned workout done')) : null,
    h('div', { class: 'eg-streak' }, h('b', { class: s.checkin_days ? 'good-text' : '' }, s.checkin_days), h('span', { class: 'strong' }, `Check-in ${s.checkin_days === 1 ? 'day' : 'days'} in a row`), s.best_checkin_days ? h('span', { class: 'small muted' }, `Best ${s.best_checkin_days}`) : null)) : null;
  const maxes = h('div');
  api('GET', '/app/api/maxes').then((d) => { if (d?.lifts?.length) fill(maxes, h('section', { class: 'dp-panel' }, h('h2', { class: 'dp-panel-title' }, 'Your maxes'), maxesBlock(d, { who: 'athlete', canEdit: true, save: (b) => api('POST', '/app/api/maxes', b), remove: (id) => api('DELETE', `/app/api/maxes/${id}`), reload: () => show('profile') }))); }).catch(() => {});
  const links = embedded ? null : h('section', { class: 'dp-panel stack-tight' }, h('h2', { class: 'dp-panel-title' }, 'Your account'),
    h('p', { class: 'small muted' }, 'Family, payments, bookings, programs and your sign-in live in the portal. Sign in with your email if it asks.'),
    h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '/client?tab=family' }, 'Family & payments'), h('a', { class: 'dp-btn dp-btn--secondary', href: '/client?tab=book' }, 'Book a session'), h('a', { class: 'dp-btn dp-btn--secondary', href: '/client?tab=progress' }, 'Progress & reports'), h('a', { class: 'dp-btn dp-btn--secondary', href: '/client?tab=programs' }, 'Programs & store')));
  fill(where,
    h('section', { class: 'dp-panel stack-tight' }, h('div', { class: 'c-title', style: 'font-size:24px' }, c.name ?? 'You'), c.athlete_id ? h('div', { class: 'small muted' }, 'Athlete ID ', h('span', { style: 'font-family:var(--font-mono)' }, c.athlete_id)) : null, streaks),
    comingUp(home?.upcoming),
    maxes,
    gamesSection(),
    formChecksSection(),
    workoutSettingsPanel(),
    reminderPanel(),
    signInPanel(),
    devicesPanel(),
    h('section', { class: 'dp-panel' }, h('h2', { class: 'dp-panel-title' }, 'Everything you did'), h('p', { class: 'dp-panel-sub' }, 'Workouts, results, maxes, sprint reps, form checks, check-ins, sessions, badges and reading, newest first.'),
      timelineBlock((p) => api('GET', p), '/app/api/timeline', { empty: 'Nothing here yet. Log a workout or check in and it lands here.' })),
    links);
}

// The workout reminder's time (owner's ask: "a setting that allows them to change the time they get a reminder
// notification on their phone"): the athlete's own hour, the business's usual one, or off. A parent inside the family
// frame sets it for the athlete they're looking at.
const hourText = (hr) => (hr === 0 ? '12 am' : hr < 12 ? `${hr} am` : hr === 12 ? '12 pm' : `${hr - 12} pm`);
function reminderPanel() {
  const box = h('section', { class: 'dp-panel stack-tight' }, h('h2', { class: 'dp-panel-title' }, 'Workout reminder'));
  const draw = async () => {
    let s;
    try { s = await api('GET', '/app/api/push'); } catch { return fill(box); }
    const notifOn = (s.subscriptions ?? []).length > 0;
    const opts = [['', `The usual time (${hourText(s.reminder_default)})`], ['0', 'No reminder']];
    for (let hr = 5; hr <= 20; hr++) opts.push([String(hr), hourText(hr)]);
    const sel = h('select', { class: 'select', 'aria-label': 'Reminder time', onChange: (e) => busy(e.target, async () => {
      const val = e.target.value;
      try { await api('PATCH', '/app/api/push/reminder', { hour: val === '' ? null : Number(val) }); toast(val === '0' ? 'Reminder off.' : `Reminder set for ${hourText(val === '' ? s.reminder_default : Number(val))}.`); draw(); }
      catch (x) { toast(x.message, 'bad'); draw(); }
    }) }, opts.map(([value, label]) => h('option', { value, selected: value === (s.reminder_own == null ? '' : String(s.reminder_own)) }, label)));
    fill(box, h('h2', { class: 'dp-panel-title' }, 'Workout reminder'),
      h('p', { class: 'small muted', style: 'margin:0' }, 'On a day with a workout on your plan that you haven\'t logged yet, your phone gets a nudge at this time.'),
      h('label', { class: 'stack-tight' }, h('span', { class: 'small strong' }, 'Remind me at'), sel),
      notifOn ? null : h('p', { class: 'small muted', style: 'margin:0' }, embedded ? 'Reminders reach a phone with notifications turned on in the app.' : 'Turn notifications on from the Workout tab\'s card so the reminder reaches this phone.'));
  };
  draw();
  return box;
}
// Your sign-in (owner's ask): set, change or remove the password for the athlete's own email, right here on the Profile
// tab; a parent inside the family portal's frame does it on the portal's Family tab instead, so the panel is left out there.
function signInPanel() {
  const box = h('section', { class: 'dp-panel stack-tight' }, h('h2', { class: 'dp-panel-title' }, 'Your sign-in'));
  const draw = async () => {
    let s;
    try { s = await api('GET', '/app/api/password'); } catch { return fill(box); }
    if (!s.email) return fill(box, h('h2', { class: 'dp-panel-title' }, 'Your sign-in'), h('p', { class: 'small muted', style: 'margin:0' }, 'Your profile has no email of its own yet. Ask your coach to add one; then you can sign in at /client with a code or a password.'));
    const pw = h('input', { class: 'dp-input', type: 'password', autocomplete: 'new-password', minlength: '10', placeholder: 'At least 10 characters' });
    const err = h('p', { class: 'dp-error', role: 'alert', style: 'margin:0' });
    const form = h('form', { class: 'stack-tight', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
      try { await api('POST', '/app/api/password', { password: pw.value }); pw.value = ''; toast('Password saved. Emailed codes still work too.'); draw(); }
      catch (x) { err.textContent = x.message; }
    }); } },
      h('p', { class: 'small muted', style: 'margin:0' }, s.has_password ? `A password is set for ${s.email}. Emailed codes still work too.` : `You sign in at /client with a code we email to ${s.email}. Set a password if you'd rather not wait for a code.`),
      h('label', { class: 'stack-tight' }, h('span', { class: 'small strong' }, s.has_password ? 'New password' : 'Password'), pw), err,
      h('div', { class: 'row wrap' }, btn(s.has_password ? 'Change password' : 'Set a password', null, 'secondary', { type: 'submit' }),
        s.has_password ? btn('Remove it', (e) => { if (confirm('Remove your password? You\'ll sign in with emailed codes.')) busy(e.currentTarget, async () => { await api('DELETE', '/app/api/password'); toast('Password removed.'); draw(); }); }, 'ghost') : null));
    fill(box, h('h2', { class: 'dp-panel-title' }, 'Your sign-in'), form);
  };
  draw();
  return box;
}
// Signed in: the phones and computers signed in with the email (the same list as the portal's Family tab).
function devicesPanel() {
  const list = h('div', { class: 'stack-tight' }, h('p', { class: 'small muted', style: 'margin:0' }, 'Loading…'));
  const day = (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const draw = (r) => fill(list,
    r.link ? h('p', { class: 'small muted', style: 'margin:0' }, 'You opened the app from your private link, so nothing is signed in here. Phones and computers signed in with your email at /client show in this list.') : !(r.data ?? []).length ? h('p', { class: 'small muted', style: 'margin:0' }, 'Nothing is signed in with your email right now.') : null,
    (r.data ?? []).map((d) => h('div', { class: 'list-item', style: 'align-items:flex-start' }, h('div', { class: 'grow stack-tight' }, h('span', null, d.device, d.current ? h('span', { class: 'small good-text' }, ' · this device') : null),
      h('span', { class: 'small muted' }, `Signed in ${day(d.signed_in_at ?? d.last_seen_at ?? Date.now())}${d.last_seen_at ? ` · last used ${day(d.last_seen_at)}` : ''}`)))),
    (r.data ?? []).length > 1 ? btn('Sign out everywhere else', (e) => { if (confirm('Sign out every other phone and computer?')) busy(e.currentTarget, async () => { const o = await api('POST', '/app/api/devices/sign-out-others', {}); toast(`Signed out ${o.signed_out} ${o.signed_out === 1 ? 'device' : 'devices'}.`); draw(o); }); }, 'secondary') : null);
  api('GET', '/app/api/devices').then(draw).catch(() => fill(list));
  return h('section', { class: 'dp-panel stack-tight' }, h('h2', { class: 'dp-panel-title' }, 'Signed in'), h('p', { class: 'dp-panel-sub' }, 'Phones and computers signed in with your email.'), list);
}
const signInLink = () => h('p', { style: 'margin:0' }, h('a', { class: 'dp-btn dp-btn--primary', href: '/client' }, 'Sign in with your email'));
async function load() {
  let home;
  if (!tokenValue || viaCookie(tokenValue)) {                   // no private link on this phone: the portal cookie, if they signed in there
    try { home = await api('GET', `/app/api/home${atQ()}`); if (!String(tokenValue ?? '').startsWith('family:')) tokenValue = `session:${home.client?.id ?? 'me'}`; }
    catch (e) {
      const cached = tokenValue ? store.get(`dp_wo_home_${String(tokenValue).slice(0, 16)}`) : null;
      if (e.status === 401 || !tokenValue) { if (!embedded) { location.replace('/client'); return; } return message('Sign in with your email to see your workouts.', signInLink()); }
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
const prefs = Object.assign({ rest: true, rest_sec: 90, at_home: false, voice: true, track_rpe: false, track_note: false, log_view: 'focus' }, store.get('dp_wo_prefs') ?? {});
const savePrefs = () => store.set('dp_wo_prefs', prefs);
const WEIGHT_STEP = 2.5;   // pounds a tap of − or + moves a set's weight (owner's choice)
// What the athlete records on a set beyond weight and reps: their workout settings, kept on the profile
// (`home.log_settings`, PATCH /app/api/log-settings) so they follow the account; the phone keeps a copy for offline.
const tracking = () => ({ effort: state.home?.log_settings?.effort ?? prefs.track_rpe, notes: state.home?.log_settings?.notes ?? prefs.track_note });
async function setTracking(key, on) {
  const was = tracking();
  const next = { ...was, [key]: on };
  if (state.home) state.home.log_settings = next;
  prefs.track_rpe = next.effort; prefs.track_note = next.notes; savePrefs();
  try { await api('PATCH', '/app/api/log-settings', { [key]: on }); }
  catch (e) { if (state.home) state.home.log_settings = was; prefs.track_rpe = was.effort; prefs.track_note = was.notes; savePrefs(); throw new Error('That didn\'t save. Check your connection and try again.'); }
}
// Workout settings (owner's ask: "a settings feature for them to toggle the effort and notes on"): the two things an
// athlete may record on each set, and the rest timer. On the Profile tab, and a tap away from the session bar.
function workoutSettings(onChange = () => {}) {
  const now = tracking();
  const toggle = (key, title, hint) => {
    const box = h('input', { type: 'checkbox', checked: now[key], onChange: async (e) => {
      const el = e.target, on = el.checked;
      el.disabled = true;
      try { await setTracking(key, on); toast(on ? `${title}: on.` : `${title}: off.`); onChange(); }
      catch (x) { el.checked = !on; toast(x.message, 'bad'); }
      finally { el.disabled = false; }
    } });
    return h('label', { class: 'c-setting' }, h('span', { class: 'stack-tight' }, h('span', { class: 'strong' }, title), h('span', { class: 'small muted' }, hint)), box);
  };
  const restLen = h('select', { class: 'select', style: 'width:auto;min-width:96px', 'aria-label': 'Rest length', onChange: (e) => { prefs.rest_sec = Number(e.target.value); savePrefs(); onChange(); } },
    [45, 60, 90, 120, 150, 180].map((s) => h('option', { value: String(s), selected: s === prefs.rest_sec }, clock(s))));
  const restBox = h('input', { type: 'checkbox', checked: prefs.rest, onChange: (e) => { prefs.rest = e.target.checked; savePrefs(); if (!prefs.rest) stopRest(); onChange(); } });
  return h('div', { class: 'stack-tight' },
    toggle('effort', 'Effort on each set', 'After you log a set, rate how hard it was from 1 to 10.'),
    toggle('notes', 'A note on each set', 'A few words on any set: how it moved, what to fix.'),
    h('label', { class: 'c-setting' }, h('span', { class: 'stack-tight' }, h('span', { class: 'strong' }, 'Rest timer after each set'), h('span', { class: 'small muted' }, 'Where your coach set a rest, that one is used. This phone only.')), restBox),
    h('div', { class: 'c-setting', style: 'cursor:default' }, h('span', { class: 'strong' }, 'Rest length'), restLen));
}
function workoutSettingsPanel() {
  return h('section', { class: 'dp-panel stack-tight', id: 'c-wo-settings' }, h('h2', { class: 'dp-panel-title' }, 'Workout settings'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'What you record on each set. Weight and reps are always there.'), workoutSettings());
}
function openWorkoutSettings(after) {
  const d = h('dialog', { class: 'c-notices-dlg', 'aria-label': 'Workout settings' },
    h('div', { class: 'stack' }, h('div', { class: 'row', style: 'align-items:center;justify-content:space-between' }, h('h2', { class: 'dp-panel-title', style: 'margin:0' }, 'Workout settings'), btn('Done', () => d.close(), 'primary')),
      workoutSettings()));
  d.addEventListener('close', () => { d.remove(); after?.(); });
  document.body.append(d);
  d.showModal();
}
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
  drawRest();
}
// ---------- The coach's voice (cues.js) ----------
// Owner decision: no computer-generated voice. The phone never reads words aloud and the rest timer is silent (it
// buzzes and shows the count). Only the coach's own recording plays, and only once the workout is started.
const cueAudio = new Map();   // exercise id → object URL of the recording, fetched once with the app's own headers
let cuePlaying = null;
function stopCue() { if (cuePlaying) { cuePlaying.pause(); cuePlaying = null; } }
async function cueUrl(x) {
  if (cueAudio.has(x.exercise_id)) return cueAudio.get(x.exercise_id);
  const res = await fetch(`/app/api/exercises/${x.exercise_id}/cue/audio`, { headers: { 'x-client-token': viaCookie(tokenValue) ? '' : tokenValue || '', ...athleteHeader(tokenValue) }, credentials: 'same-origin' });
  if (!res.ok) throw new ApiError('The cue couldn\'t be loaded.', res.status);
  const url = URL.createObjectURL(await res.blob());
  cueAudio.set(x.exercise_id, url);
  return url;
}
// Play the coach's recorded cue for an open exercise (nothing where the coach recorded none).
async function playCue(x, { auto = false } = {}) {
  if ((auto && !prefs.voice) || !x.cue?.audio) return;
  stopCue();
  try { const a = new Audio(await cueUrl(x)); cuePlaying = a; a.onended = () => { if (cuePlaying === a) cuePlaying = null; }; await a.play(); }
  catch { /* blocked or offline */ }
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
// ---------- On the home screen, and notifications (sw.js, push.js) ----------
// The app installs like a native one (the manifest and the service worker); a push taps the athlete when the coach writes,
// the first program is ready, or a workout is on today. Shown until both are done, then folded away (Settings keeps it).
let installPrompt = null, swReg = null, pushState = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (state.home && state.tab === 'workout' && !editing()) render(); });
if ('serviceWorker' in navigator && !embedded) navigator.serviceWorker.register('/sw.js', { scope: '/app' }).then((r) => { swReg = r; }).catch(() => {});
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
const pushSupported = () => 'PushManager' in window && 'Notification' in window && 'serviceWorker' in navigator;
const keyBytes = (b64) => { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
async function pushStatus() {
  if (pushState) return pushState;
  const d = await api('GET', '/app/api/push');
  const reg = swReg ?? (await navigator.serviceWorker?.ready?.catch?.(() => null));
  const sub = await reg?.pushManager?.getSubscription?.().catch(() => null);
  pushState = { ...d, on: !!sub && d.subscriptions.some((x) => sub.endpoint.includes(x.endpoint_host)), sub };
  return pushState;
}
async function pushOn() {
  if (!pushSupported()) throw new Error(isIOS() && !standalone() ? 'On iPhone, add the app to your home screen first (Share, then Add to Home Screen), then turn notifications on from there.' : 'This browser can\'t show notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were blocked. Allow them in the browser\'s settings for this site and try again.');
  const reg = swReg ?? await navigator.serviceWorker.ready;
  const { public_key } = await api('GET', '/app/api/push');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) });
  await api('POST', '/app/api/push/subscribe', { subscription: sub.toJSON() });
  pushState = null;
}
async function pushOff() {
  const reg = swReg ?? await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('POST', '/app/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  pushState = null;
}
function installCard(home) {
  if (embedded || !home?.client) return null;
  const hide = store.get('dp_install_hidden') === true;
  const box = h('div', { class: 'dp-panel stack-tight su-install', hidden: true });
  (async () => {
    const st = pushSupported() ? await pushStatus().catch(() => null) : null;
    const installed = standalone(), notifOn = !!st?.on;
    if (hide && (installed || !installPrompt) && (notifOn || !pushSupported())) return;   // nothing left to do, or folded away
    const rows = [];
    if (!installed) {
      rows.push(h('div', { class: 'row wrap', style: 'align-items:center;gap:8px' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, 'Put the app on your home screen'),
        h('span', { class: 'small muted' }, installPrompt ? 'Opens full screen, like any app, and works with no signal.' : isIOS() ? 'In Safari: tap Share, then Add to Home Screen. It opens full screen and works with no signal.' : 'In your browser\'s menu, choose Install app or Add to Home screen.')),
        installPrompt ? btn('Add', async (e) => { const p = installPrompt; installPrompt = null; await busy(e.currentTarget, async () => { p.prompt(); await p.userChoice; render(); }); }, 'secondary') : null));
    }
    if (pushSupported() || isIOS()) {
      rows.push(h('div', { class: 'row wrap', style: 'align-items:center;gap:8px' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, notifOn ? 'Notifications are on' : 'Notifications'),
        h('span', { class: 'small muted' }, notifOn ? `A tap when your coach writes${st.reminder_hour ? `, and a nudge at ${hourText(st.reminder_hour)} on a day with a workout` : ''}. Change the reminder time on Profile.` : 'Hear from your coach, and get a nudge on the days you train.')),
        notifOn ? btn('Test', (e) => busy(e.currentTarget, async () => { await api('POST', '/app/api/push/test'); toast('Sent. It shows in a moment.'); }), 'ghost') : null,
        notifOn ? btn('Turn off', (e) => busy(e.currentTarget, async () => { await pushOff(); toast('Notifications are off.'); render(); }), 'ghost')
          : btn('Turn on', (e) => busy(e.currentTarget, async () => { await pushOn(); toast('Notifications are on.'); render(); }), 'secondary')));
    }
    if (!rows.length) return;
    fill(box, ...rows, installed && notifOn ? null : h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Not now', () => { store.set('dp_install_hidden', true); box.hidden = true; }, 'ghost', { class: 'dp-btn dp-btn--ghost small' })));
    box.hidden = false;
  })().catch(() => {});
  return box;
}
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
  if (!st || st.needed) return null;
  if (gearOpen) return startupPanel(home, { change: true });
  // A program bought online comes with no answers yet (the sales page): ask where they train and what gear they have.
  if (st.ask_gear && !st.profile) return h('div', { class: 'dp-panel stack-tight su-gear' },
    h('span', { class: 'dp-label' }, 'Make it fit'),
    h('span', { class: 'small' }, 'Tell us where you train and what gear you have, and exercises that need gear you don\'t have are swapped for ones you can do.'),
    h('div', null, btn('Answer a few questions', () => { gearOpen = true; render(); }, 'secondary')));
  if (!st.profile) return null;
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
// The coach's note for the week (weekly.js), once a coach sent it.
function weeklyNoteCard(home) {
  const n = home.weekly_note;
  if (!n) return null;
  return h('div', { class: 'dp-panel stack-tight su-note', role: 'note' }, h('span', { class: 'dp-label' }, `This week, from ${n.by ? `Coach ${n.by.split(' ')[0]}` : 'your coach'}`), h('p', { style: 'margin:0' }, n.body), h('span', { class: 'small muted' }, `About ${n.week_label}.`));
}
// The adaptive plan (adapt.js): a minimum week in force, and why the calendar moved this week.
function adjustmentsCard(home) {
  const a = home.adjustments;
  if (!a || (!a.minimum && !a.recent?.length)) return null;
  return h('div', { class: 'stack-tight' },
    a.minimum ? h('div', { class: 'c-ready c-ready--yellow', role: 'status' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, 'Minimum week'),
      h('span', { class: 'small' }, `Half the sets on every exercise through ${dayName(a.minimum.until, { weekday: 'long' })}. Just get the work in; the full plan is back next week.`))) : null,
    ...(a.recent ?? []).map((r) => h('div', { class: 'c-note' }, r.text)));
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
// What an athlete chose to record on a set beyond weight and reps (version 99): how hard it was, and a note.
const setExtras = (s) => [s.rpe != null && s.rpe !== '' ? `RPE ${s.rpe}` : null, s.note ? `“${s.note}”` : null].filter(Boolean).join(' · ');
const setFull = (s) => [setText(s), setExtras(s)].filter(Boolean).join(' · ');
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const RPE_WORDS = ['', 'Very easy', 'Easy', 'Moderate', 'Somewhat hard', 'Hard', 'Hard', 'Very hard', 'Very hard', 'Near max', 'Max effort'];
// The top of the Workout tab: the mark (the portal's own header stands in when embedded) and the notifications bell
// (owner's ask: "a notifications icon at the top of the today page for badges and they have to click through the
// notifications to clear it"): the badge counts the notices not yet tapped; tapping one in the list clears that one.
const top = () => h('div', { class: 'c-top' }, embedded ? h('span') : h('img', { class: 'c-mark', src: '/brand/mark.png', alt: 'Diamond Protocol' }), bell());
let bellBadge = null;
function bell() {
  const n = state.home?.notices_unseen ?? 0;
  bellBadge = h('span', { class: 'c-bell-n', hidden: !n }, n > 99 ? '99+' : String(n));
  return h('button', { type: 'button', class: 'c-bell', 'aria-label': n ? `Notifications, ${n} new` : 'Notifications', onClick: openNotices }, tabIcon('bell'), bellBadge);
}
function setUnseen(n) {
  if (state.home) state.home.notices_unseen = n;
  if (bellBadge) { bellBadge.textContent = n > 99 ? '99+' : String(n); bellBadge.hidden = !n; bellBadge.parentElement?.setAttribute('aria-label', n ? `Notifications, ${n} new` : 'Notifications'); }
}
const whenShort = (iso) => { const d = new Date(iso), days = Math.floor((Date.now() - d) / 86400000); return days <= 0 ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : days === 1 ? 'Yesterday' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
async function openNotices() {
  const list = h('div', { class: 'c-notices' }, h('p', { class: 'small muted', style: 'margin:0' }, 'Loading…'));
  const d = h('dialog', { class: 'c-notices-dlg', 'aria-label': 'Notifications' }, h('div', { class: 'row', style: 'align-items:center;justify-content:space-between' }, h('h2', { class: 'dp-panel-title', style: 'margin:0' }, 'Notifications'), btn('Close', () => d.close(), 'ghost')), list);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  const go = (url) => {
    d.close();
    if (!url) return;
    if (url.startsWith('/app')) { const m = url.match(/#(\w+)/); show(m ? m[1] : 'workout'); return; }
    location.assign(url);
  };
  const draw = (r) => fill(list,
    !r.data.length ? h('p', { class: 'small muted', style: 'margin:0' }, 'Nothing yet. Messages from your coach, workout reminders and team posts land here.') : null,
    r.data.length ? h('p', { class: 'small muted', style: 'margin:0' }, r.unseen ? `${r.unseen} new. Tap each one to clear it.` : 'All caught up.') : null,
    r.data.map((n) => h('button', { type: 'button', class: `c-notice${n.seen_at ? '' : ' is-new'}`, onClick: (e) => busy(e.currentTarget, async () => {
      let out = { url: n.url };
      if (!n.seen_at) { try { out = await api('POST', `/app/api/notices/${n.id}/seen`, {}); n.seen_at = new Date().toISOString(); setUnseen(out.unseen); } catch {} }
      go(out.url ?? n.url);
    }) },
      h('span', { class: 'c-notice-dot', 'aria-hidden': 'true' }), h('span', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, n.title), n.body ? h('span', { class: 'small' }, n.body) : null, h('span', { class: 'small muted' }, whenShort(n.created_at))))));
  try { const r = await api('GET', '/app/api/notices'); setUnseen(r.unseen); draw(r); }
  catch { fill(list, h('p', { class: 'small muted', style: 'margin:0' }, 'Couldn\'t load your notifications. Try again when you have a signal.')); }
}

function render() {
  const home = state.home;
  document.body.classList.remove('c-focus');   // the focus screen (renderLogger) puts it back when it's the one showing
  store.set(`dp_wo_home_${String(tokenValue).slice(0, 16)}`, { token: tokenValue, home });
  drawPending();
  if (state.done) return renderDone(state.done);
  const kept = store.get(DRAFT_KEY());
  if (kept?.token === tokenValue && kept.log_id && kept.workout) { draft = kept; return renderLogger(kept.workout); }
  const w = home.locked ? null : currentWorkout();
  if (!w) {
    stopRest();
    fill(view, top(), home.locked ? null : calendarStrip(home), home.locked ? null : gameCard(home), h('div', { class: 'c-title' }, `Hi ${home.client.first_name}`), pendingBox,
      !home.locked && home.startup?.needed ? startupPanel(home) : h('div', { class: 'dp-panel' }, h('p', null, home.message)), home.locked ? null : gearCard(home), home.locked ? null : installCard(home),
      home.locked ? null : feedCard(), strayPanel(), historyPanel(home), h('p', { class: 'small muted' }, `Check in, see your goals, results and lessons with the tabs ${embedded ? 'above' : 'below'}.`));
    return;
  }
  // Finished offline and not sent yet: don't show the same workout again.
  if (outbox().some((x) => x.token === tokenValue && x.kind === 'finish' && x.workout_id === w.id)) {
    fill(view, top(), calendarStrip(home), h('div', { class: 'c-title' }, `Hi ${home.client.first_name}`), pendingBox,
      h('div', { class: 'dp-panel stack' }, h('p', null, `${w.title} is finished and saved on this phone. It sends when you're back online, then your next workout shows here.`)),
      historyPanel(home));
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
const STATUS_WORD = { done: 'Done', today: 'Today', missed: 'Missed', upcoming: 'Coming up', skipped: 'Skipped', unpublished: 'Not open yet' };
// The line under the title: when this workout is (or was) planned.
const whenText = (w) => (!w.date ? null : w.status === 'today' ? 'Today' : w.status === 'missed' ? `Missed · was ${dayName(w.date)}` : `Up next · ${dayName(w.date)}`);
function calendarStrip(home) {
  const cal = home.calendar;
  if (!cal?.workouts?.length) return null;
  const byDate = new Map();
  for (const w of cal.workouts) byDate.set(w.date, [...(byDate.get(w.date) ?? []), w]);
  const gameDates = new Set(home.games?.game_dates ?? []), gameDay = (d) => home.games?.by_date?.[d] ?? null;   // the game-week helper (gameweek.js)
  state.calWeek ??= mondayOf(cal.today);
  const box = h('section', { class: 'dp-panel stack-tight c-cal', 'aria-label': 'Your training calendar' });
  let showPlan = false;
  const draw = () => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(state.calWeek, i));
    const cells = days.map((d) => {
      const ws = byDate.get(d) ?? [];
      const st = !ws.length ? 'rest' : ws.every((w) => w.status === 'done') ? 'done' : ws.some((w) => w.status === 'missed') ? 'missed' : d === cal.today ? 'today' : 'planned';
      const game = gameDates.has(d), gd = gameDay(d);
      return h('button', { type: 'button', class: `c-day c-day--${st}${d === cal.today ? ' c-day--now' : ''}${game ? ' c-day--game' : ''}${gd?.tone ? ` c-day--${gd.tone}` : ''}`, 'aria-pressed': String(state.calDay === d),
        'aria-label': `${dayName(d, { weekday: 'long', month: 'long', day: 'numeric' })}${d === cal.today ? ', today' : ''}${game ? `, ${gd?.game?.kind_word ?? 'game'} day` : ''}${gd?.tone ? `, ${gd.tone} day` : ''}: ${ws.length ? ws.map((w) => `${w.title} (${STATUS_WORD[w.status].toLowerCase()})`).join(', ') : 'rest day'}`,
        onClick: () => { state.calDay = state.calDay === d ? null : d; draw(); } },
        h('span', { class: 'c-day-wd' }, dayName(d, { weekday: 'short' })), h('span', { class: 'c-day-n' }, String(Number(d.slice(8)))),
        h('span', { class: 'c-day-dot', 'aria-hidden': 'true' }, game ? 'G' : st === 'done' ? '✓' : st === 'missed' ? '!' : ws.length ? '•' : ''));
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
        gameDay(state.calDay)?.game ? h('span', { class: 'small strong' }, `${gameDay(state.calDay).game.kind_label}${gameDay(state.calDay).game.title ? `: ${gameDay(state.calDay).game.title}` : ''}${gameDay(state.calDay).game.time ? ` at ${gameDay(state.calDay).game.time}` : ''}`) : gameDates.has(state.calDay) ? h('span', { class: 'small strong' }, 'Game day') : null,
        gameDay(state.calDay)?.tone ? h('div', { class: 'row wrap', style: 'gap:6px;align-items:center' }, toneChip(gameDay(state.calDay).tone), h('span', { class: 'small muted' }, gameDay(state.calDay).label)) : null,
        gameDay(state.calDay)?.advice ? h('span', { class: 'small muted' }, gameDay(state.calDay).advice) : null,
        picked.length ? picked.map(line) : h('span', { class: 'small muted' }, 'Rest day. Nothing planned.')) : null,
      h('div', { class: 'row wrap small muted', style: 'align-items:center' }, h('span', { class: 'grow', style: 'flex-basis:100%' }, `${cal.counts.done} done · ${cal.counts.missed} missed · ${cal.counts.upcoming} to go · ${cal.days_text}`),
        home.week ? h('span', { class: home.week.streak ? 'good-text strong' : 'muted' }, home.week.streak ? `${home.week.streak} clean ${home.week.streak === 1 ? 'week' : 'weeks'} in a row` : home.week.planned ? `${home.week.done} of ${home.week.planned} this week · ${home.week.sets} sets` : '') : null,
        btn(showPlan ? 'Hide the plan' : 'Whole plan', () => { showPlan = !showPlan; draw(); }, 'ghost')),
      showPlan ? h('div', { class: 'c-plan stack-tight' }, [...new Set(cal.workouts.map((w) => w.week))].map((week) => [h('span', { class: 'small strong' }, `Week ${week}`),
        ...cal.workouts.filter((w) => w.week === week).map((w) => h('div', { class: 'c-plan-row' }, h('span', { class: 'small muted', style: 'min-width:92px' }, dayName(w.date)), h('span', { class: 'grow small' }, h('span', { class: w.status === 'done' ? 'muted' : 'strong' }, w.title), w.moved ? ' · moved' : ''),
          h('span', { class: `small ${w.status === 'missed' ? 'warn-text' : w.status === 'done' ? 'good-text' : 'muted'}` }, STATUS_WORD[w.status])))])) : null);
  };
  draw();
  return box;
}
// The game-week helper (gameweek.js): the next game, today's colour and what it does to the sets. The workout below
// already has the sets cut; nothing to tap.
function gameCard(home) {
  const g = home.games;
  if (!g) return null;
  // Owner decision: no games box on the Workout tab. One line at the top asks for the games until some are on file; it
  // comes back when nothing is scheduled in the next 90 days, and Not now hides it until a game is added. The games
  // themselves live on the Profile tab.
  const soon = g.days_to_next != null && g.days_to_next <= 90;
  if (soon || prefs.games_prompt_off) return null;
  return h('div', { class: 'c-note row', style: 'align-items:center;gap:4px 8px;flex-wrap:wrap' },
    h('span', { class: 'small', style: 'flex:1 1 220px' }, g.games_on_file ? 'Nothing on your calendar for the next 90 days. Add your next games, races and competitions and the calendar colours itself around them.' : 'Add your games, races and competitions and the calendar colours itself: green is the full workout, yellow one set fewer, red half the sets.'),
    h('div', { class: 'row', style: 'gap:6px' }, btn('Add games', () => show('profile', 'c-games'), 'ghost'), btn('Not now', () => { prefs.games_prompt_off = true; savePrefs(); render(); }, 'ghost')));
}
// The banner on a workout that falls on a yellow or red day: the same exercises, fewer sets.
function gameDayBanner(w) {
  const g = w.game_day;
  if (!g || !g.cut) return null;
  const when = g.offset === 0 ? `${g.game.kind_word} day` : g.offset < 0 ? `${g.game.kind_word} ${-g.offset === 1 ? 'tomorrow' : `in ${-g.offset} days`}` : `${g.offset} ${g.offset === 1 ? 'day' : 'days'} after your ${g.game.kind_word}`;
  return h('div', { class: `c-ready c-ready--${g.tone}`, role: 'status' }, h('div', { class: 'grow stack-tight' },
    h('span', { class: 'strong' }, `${g.tone === 'red' ? 'Red' : 'Yellow'} day: ${g.cut_text}`),
    h('span', { class: 'small' }, `${when[0].toUpperCase()}${when.slice(1)}${g.game.title ? ` (${g.game.title})` : ''}. The exercises, reps and weights stay the same; the sets below are already cut.`)));
}
function gamesSection() {
  const block = gamesBlock({ first: state.home?.client?.first_name ?? 'you', who: 'athlete', canEdit: true, onChanged: async () => { prefs.games_prompt_off = false; savePrefs(); await refresh(); },
    api: { plan: () => api('GET', '/app/api/games'), add: (b) => api('POST', '/app/api/games', b), update: (id, b) => api('PATCH', `/app/api/games/${id}`, b), remove: (id) => api('DELETE', `/app/api/games/${id}`),
      preview: (b) => api('POST', '/app/api/games/preview', b), import: (b) => api('POST', '/app/api/games/import', b) } });
  return h('section', { class: 'dp-panel stack', id: 'c-games' }, h('h2', { class: 'dp-panel-title' }, 'Games'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Keep your games, races and competitions here. Every day of your calendar takes a colour from them: green is the full workout, yellow one set fewer on every exercise, red half the sets. A date changes? Change it here and everything follows.'), block.el);
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
  return Array.from({ length: Math.min(n, 99) }, (_, i) => rows[i] ?? { weight: '', reps: '', done: false });
}
// Blank weight uses the weight of the set before it today, else today's weight from a tested max, else the load the
// coach typed when it is a plain number of pounds ("35 lb"), else last time's weight for that set; blank reps use the target.
const typedLoad = (x) => { const m = /^\s*(\d{1,4}(?:\.\d+)?)\s*(?:lb|lbs|pounds|#)?\s*$/i.exec(x.load_text ?? ''); return m ? Number(m[1]) : null; };
const defaultWeight = (x, i) => {
  const before = (draft?.sets[x.id] ?? []).slice(0, i).reverse().find((r) => r.done && r.weight != null && r.weight !== '');
  if (before) return Number(before.weight);
  if (x.load?.lb != null) return x.load.lb;                                  // a step is already in the weight from the max
  const typed = typedLoad(x);
  if (typed != null) return typed;
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

let sessionTick = null;   // the session bar's clock
let cueFor = null;        // the exercise whose cue the focus screen last played on its own
// One exercise over time (GET /app/api/exercises/:id/history): the bests, a bar per session for its best estimated max
// (or its heaviest set), then every session set by set with whatever the athlete recorded on each.
async function openHistory(x) {
  const hist = await api('GET', `/app/api/exercises/${x.exercise_id}/history`);
  const b = hist.best;
  const points = [...hist.sessions].reverse().map((s) => ({ v: s.e1rm ?? s.top_weight, date: s.date })).filter((p) => p.v);
  const hi = Math.max(1, ...points.map((p) => p.v)), lo = Math.min(...points.map((p) => p.v));
  const est = points.length && hist.sessions.some((s) => s.e1rm);
  // Avg: the average weight of every set on the sheet (OVR shows Best and Avg over the graph).
  const weights = hist.sessions.flatMap((s) => s.sets.map((r) => r.weight)).filter((v) => v > 0);
  const avg = weights.length ? Math.round((weights.reduce((n, v) => n + v, 0) / weights.length) * 10) / 10 : null;
  const graph = points.length >= 3 ? h('div', { class: 'c-hgraph stack-tight' },
    h('div', { class: 'c-hbars', role: 'img', 'aria-label': `${est ? 'Estimated max' : 'Heaviest set'} by day, oldest first: ${points.map((p) => `${shortDate(p.date)} ${p.v} lb`).join(', ')}` },
      points.map((p) => h('span', { class: 'c-hbar', style: `height:${Math.round(28 + 72 * (hi === lo ? 1 : (p.v - lo) / (hi - lo)))}%`, title: `${shortDate(p.date)}: ${p.v} lb` }))),
    h('div', { class: 'row small muted', style: 'justify-content:space-between' }, h('span', null, shortDate(points[0].date)), h('span', null, est ? 'Estimated max by day' : 'Heaviest set by day'), h('span', null, shortDate(points.at(-1).date))))
    : h('div', { class: 'c-hgraph c-hgraph-empty' }, h('span', { class: 'strong muted' }, 'More data required'), h('span', { class: 'small muted' }, 'The graph appears once you have 3 dates'));
  const day = (s, k) => {
    const at = new Date(s.date), top = s.sets.reduce((best, r) => (r.weight > (best?.weight ?? -1) ? r : best), null) ?? s.sets[0];
    return h('details', { class: 'c-hday', open: k === 0 ? '' : null },
      h('summary', null, h('span', { class: 'c-hday-date' }, h('span', { class: 'c-hday-d' }, String(at.getDate())), h('span', { class: 'c-hday-m' }, at.toLocaleDateString('en-US', { month: 'short' }))),
        h('span', { class: 'stack-tight grow' }, h('span', { class: 'c-hday-n' }, `${s.sets.length} ${s.sets.length === 1 ? 'set' : 'sets'}`), h('span', { class: 'small muted' }, top ? setText(top) : '')),
        h('span', { class: 'c-hday-go', 'aria-hidden': 'true' }, playIcon())),
      h('div', { class: 'c-hday-body stack-tight small' }, s.sets.map((r) => h('span', null, h('span', { class: 'muted' }, `Set ${r.set_no}: `), setFull(r))),
        h('span', { class: 'muted' }, [s.workout, s.volume_lb ? `${s.volume_lb.toLocaleString()} lb moved` : null, s.e1rm ? `est. max ${s.e1rm} lb` : null].filter(Boolean).join(' · '))));
  };
  const d = h('dialog', { class: 'c-notices-dlg', 'aria-label': `${hist.name} history` },
    h('div', { class: 'stack' },
      h('div', { class: 'row', style: 'align-items:center;justify-content:space-between;gap:12px' }, h('h2', { class: 'dp-panel-title', style: 'margin:0' }, hist.name), btn('Close', () => d.close(), 'ghost')),
      hist.sessions.length ? [
        h('div', { class: 'c-hstats' }, h('span', { class: 'c-hstat' }, 'Best: ', h('b', null, b.weight ? String(b.weight.value) : '--'), b.weight ? ' lb' : ''), h('span', { class: 'c-hstat' }, 'Avg: ', h('b', null, avg != null ? String(avg) : '--'), avg != null ? ' lb' : '')),
        graph,
        h('div', null, h('div', { class: 'row', style: 'align-items:baseline;justify-content:space-between' }, h('h3', { class: 'dp-panel-title', style: 'margin:0 0 4px' }, 'Data'), h('span', { class: 'small muted' }, [b.e1rm ? `est. max ${b.e1rm.value} lb` : null, `${hist.times} ${hist.times === 1 ? 'time' : 'times'}`].filter(Boolean).join(' · '))),
          hist.sessions.map(day))
      ] : h('p', { class: 'muted', style: 'margin:0' }, 'Nothing logged for this one yet. Your sets show here after your first workout with it.')));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

function renderLogger(w) {
  const home = state.home;
  const reopened = !!draft.log_id;
  // Opening a workout shows what to do (every exercise with its sets, reps, distance, weight, percent of max and tempo);
  // Start workout turns the set rows on. A draft with sets already logged is in the middle of it.
  const logging = reopened || !!draft.started || hasSets(draft);
  // The session view (owner's ask: "as efficient as possible for the user"): once the workout is started the page is
  // only the workout. The calendar, prompts and cards step aside and a bar at the top keeps the clock, the sets logged
  // and the pounds moved in sight; "Show everything" brings the rest of the page back.
  const session = logging && !reopened && !state.fullView;
  // The focus screen (owner's OVR screenshots: one thing in focus, a big number in a dial, Best and Avg under it, the
  // reps logged below, END and NEXT fixed at the foot): one exercise at a time. "List" on the bar brings every card back.
  const focusMode = session && prefs.log_view !== 'list';
  document.body.classList.toggle('c-focus', focusMode);
  const startBtn = () => btn('Start workout', () => { draft.started = true; draft.started_at ??= new Date().toISOString(); saveDraft(); state.open = (w.exercises.find((x) => !exDone(x)) ?? w.exercises[0])?.id ?? null; render(); window.scrollTo(0, 0); say('Workout started. Log each set as you go.'); }, 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:52px' });
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
        rxTable(x, { compact: !isOpen }), h('span', { class: 'dp-ex-sets' }, [x.planned_sets ? `${x.target_sets} ${x.target_sets === 1 ? 'set' : 'sets'} today (${x.planned_sets} planned)` : null, logged ? `${logged} of ${rowsFor(x).length} sets logged` : null].filter(Boolean).join(' · ')),
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
      // Once the workout is started, the coach's recorded cue plays as the card opens (owner decision: never before
      // Start workout, and never a computer voice); Why this matters plays their clip.
      const clipHolder = h('div');
      const cueRow = logging && (x.cue?.audio || x.cue?.clip) ? h('div', { class: 'row wrap small', style: 'gap:8px;align-items:center' },
        x.cue?.audio ? btn('🔊 Coach\'s cue', (e) => busy(e.currentTarget, () => playCue(x)), 'ghost') : null,
        x.cue?.clip ? btn('Why this matters', (e) => busy(e.currentTarget, () => cueClip(x, clipHolder)), 'ghost') : null,
        x.cue?.audio ? h('label', { class: 'row muted', style: 'gap:6px;min-height:44px' }, h('input', { type: 'checkbox', checked: prefs.voice, onChange: (e) => { prefs.voice = e.target.checked; savePrefs(); if (!prefs.voice) stopCue(); } }), 'Play the cue when a card opens') : null) : null;
      if (logging && x.cue?.audio && !draft?.log_id && !exStarted(x)) playCue(x, { auto: true }).catch(() => {});
      box.append(h('div', { class: 'stack c-ex-media' },
        x.video_url !== undefined && (x.video_url || !logging) ? demoVideo(x) : null,   // while logging, an exercise with no demo yet shows no empty box
        cueRow, clipHolder,
        formCheckSend(x),
        x.note ? h('p', { class: 'c-cue strong' }, `Coach's note: ${x.note}`) : null,
        x.instructions ? h('p', { class: 'c-cue' }, x.instructions) : null,
        x.last?.sets?.length || x.best_weight || (logging && x.exercise_id) ? h('div', { class: 'row c-last', style: 'gap:8px;align-items:center' },
          h('div', { class: 'grow stack-tight small muted' },
            // While logging, each set row says what that set was last time, so this line is only the day and the best.
            x.last?.sets?.length ? h('span', null, logging && x.target_reps != null ? `Last done ${shortDate(x.last.date)}` : `Last time (${shortDate(x.last.date)}): ${x.last.sets.map(setText).join(', ')}`) : h('span', null, 'Your first time logging this one.'),
            x.best_weight ? h('span', null, `Your best: ${lb(x.best_weight)}`) : null),
          x.exercise_id && (x.last?.sets?.length || x.best_weight) ? btn('History', (e) => busy(e.currentTarget, () => openHistory(x)), 'ghost', { 'aria-label': `${x.name} history` }) : null) : null,
        altBlock(x)));
      if (logging) {
        const setsBox = h('div', { class: 'c-sets' });
        box.append(setsBox);
        drawSets(x, setsBox);
      }
    }
    return box;
  }
  // One line per set: − weight + · − reps + · Log, so a set is one tap when the numbers are right and never needs the
  // keyboard when they aren't (the steps are 2.5 lb, the owner's choice, and 1 rep; the boxes still take typing). Under it, what that set was
  // last time. A logged set opens its extras where the athlete tracks them: how hard it was, and a note.
  const patchSet = (x, i, more) => { const all = rowsFor(x); all[i] = { ...all[i], ...more }; draft.sets[x.id] = all; saveDraft(); };
  // What the athlete tracks on a logged set (workout settings): effort chips and a note, open on the set just logged,
  // a line to tap on the earlier ones.
  function extrasFor(x, i, r, lastDone, redraw) {
    const track = tracking();
    if (!(track.effort || track.notes) || !r.done) return null;
    if (i !== lastDone && state.extrasOpen !== `${x.id}:${i}`) return h('button', { type: 'button', class: 'c-set-more small muted', onClick: () => { state.extrasOpen = `${x.id}:${i}`; redraw(); } }, setExtras(r) || 'Add effort or a note');
    const chips = track.effort ? h('div', { class: 'c-effort c-effort--set', role: 'radiogroup', 'aria-label': `How hard was set ${i + 1}? 1 is very easy, 10 is all out` },
      Array.from({ length: 10 }, (_, k) => k + 1).map((n) => h('button', { type: 'button', role: 'radio', class: 'c-effort-n', 'aria-checked': String(Number(r.rpe) === n), 'aria-label': `${n}: ${RPE_WORDS[n]}`,
        onClick: () => { patchSet(x, i, { rpe: Number(r.rpe) === n ? null : n }); say(Number(r.rpe) === n ? 'Effort cleared.' : `Set ${i + 1} effort ${n}.`); redraw(); } }, String(n)))) : null;
    const noteIn = track.notes ? h('input', { class: 'dp-input', maxlength: '200', value: r.note ?? '', placeholder: 'A note on this set', 'aria-label': `Note on ${x.name} set ${i + 1}`, onInput: (e) => patchSet(x, i, { note: e.target.value }) }) : null;
    return h('div', { class: 'c-set-extras stack-tight' }, chips ? h('span', { class: 'small muted' }, 'How hard was that set?') : null, chips, noteIn);
  }
  function drawSets(x, setsBox, focus) {
    if (focusMode) return redrawCards();
    const rows = rowsFor(x);
    const counted = x.target_reps != null;
    const lastDone = rows.reduce((at, r, i) => (r.done ? i : at), -1);
    fill(setsBox, rows.map((r, i) => {
      const dw = defaultWeight(x, i);
      const wIn = h('input', { class: 'dp-input c-num', type: 'number', inputmode: 'decimal', min: '0', max: '2000', step: '0.5', value: r.weight === '' || r.weight == null ? '' : String(r.weight), placeholder: dw != null ? String(dw) : '0', 'aria-label': `${x.name} set ${i + 1} weight in pounds` });
      const rIn = h('input', { class: 'dp-input c-num', type: 'number', inputmode: 'numeric', min: '0', max: '500', step: '1', value: r.reps === '' || r.reps == null ? '' : String(r.reps), placeholder: x.target_reps != null ? String(x.target_reps) : 'reps', 'aria-label': `${x.name} set ${i + 1} reps` });
      const keep = () => patchSet(x, i, { weight: wIn.value, reps: rIn.value });
      wIn.addEventListener('input', keep); rIn.addEventListener('input', keep);
      // A step starts from what the box shows: the typed number, else the suggested one.
      const step = (el, by, start, max, what) => h('button', { type: 'button', class: 'c-step', 'aria-label': `${by > 0 ? 'More' : 'Less'} ${what}, ${x.name} set ${i + 1}`, onClick: () => {
        const cur = el.value !== '' ? Number(el.value) : start;
        const next = Math.min(max, Math.max(0, (Number.isFinite(cur) ? cur : 0) + by));
        el.value = String(Number.isInteger(next) ? next : Math.round(next * 10) / 10);
        keep();
      } }, by > 0 ? '+' : '−');
      const tick = h('button', { type: 'button', class: 'dp-ex-log c-tick', 'aria-pressed': String(!!r.done), 'data-set': String(i), 'aria-label': `${r.done ? 'Logged' : 'Log'} ${x.name} set ${i + 1}`, onClick: () => toggleSet(x, i, setsBox, wIn.value, rIn.value) }, r.done ? '✓' : 'Log');
      const was = x.last?.sets?.[i];
      const extras = extrasFor(x, i, r, lastDone, () => drawSets(x, setsBox));
      return h('div', { class: `c-set-wrap${r.done ? ' c-set--done' : ''}` },
        h('div', { class: 'c-set' }, h('span', { class: 'c-set-no', 'aria-hidden': 'true' }, String(i + 1)),
          counted ? [h('span', { class: 'c-stepper' }, step(wIn, -WEIGHT_STEP, dw ?? 0, 2000, 'weight'), wIn, step(wIn, WEIGHT_STEP, dw ?? 0, 2000, 'weight'), h('span', { class: 'c-unit' }, 'lb')),
            h('span', { class: 'c-stepper c-stepper--reps' }, step(rIn, -1, x.target_reps ?? 0, 500, 'reps'), rIn, step(rIn, 1, x.target_reps ?? 0, 500, 'reps'), h('span', { class: 'c-unit' }, 'reps'))]
            : h('span', { class: 'grow small muted' }, i === 0 ? x.prescription : ''),
          tick),
        counted && was && !r.done ? h('div', { class: 'c-set-was small muted' }, `Last time: ${setText(was)}`) : null,
        extras);
    }), h('div', { class: 'row' }, rows.length < 99 ? btn('Add a set', () => { const all = rowsFor(x); all.push({ weight: '', reps: '', done: false }); draft.sets[x.id] = all; saveDraft(); drawSets(x, setsBox, rows.length); }, 'ghost') : null));
    if (focus != null) setsBox.querySelector(`[data-set="${focus}"]`)?.focus();
    drawSession();
  }
  function toggleSet(x, i, setsBox, weight, reps) {
    const all = rowsFor(x);
    const r = all[i];
    if (r.done) {                                   // untick: the set is cleared
      all[i] = { ...r, done: false };
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
    all[i] = { ...r, weight: counted ? wv : null, reps: counted ? rv : null, done: true };
    state.extrasOpen = null;
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
  // ---- The focus screen ----
  // The exercise in focus: the one picked, else the first with a set left, else the last.
  const inFocus = () => w.exercises.find((e) => e.id === state.open) ?? w.exercises.find((e) => !exDone(e)) ?? w.exercises.at(-1);
  let focusNow = null;   // { x, i, wIn, rIn } for the set the foot's main button logs
  // The set dial: a segment per set (green once logged, bright for the one up now), and in the middle what the next
  // tap logs. With more than 16 sets the ring is one arc that fills.
  function setDial(rows, i) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200'); svg.setAttribute('class', 'c-dial-ring'); svg.setAttribute('aria-hidden', 'true');
    const arc = (cls, len, at) => { const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', '100'); c.setAttribute('cy', '100'); c.setAttribute('r', '88'); c.setAttribute('pathLength', '100'); c.setAttribute('class', cls);
      c.setAttribute('stroke-dasharray', `${len} ${100 - len}`); c.setAttribute('stroke-dashoffset', String(-at)); c.setAttribute('transform', 'rotate(-90 100 100)'); svg.append(c); };
    const n = rows.length, done = rows.filter((r) => r.done).length;
    if (n > 16) { arc('c-dial-seg', 100, 0); if (done) arc('c-dial-seg c-dial-seg--done', (done / n) * 100, 0); }
    else { const gap = n === 1 ? 0 : 2.4, len = 100 / n - gap; rows.forEach((r, k) => arc(`c-dial-seg${r.done ? ' c-dial-seg--done' : k === i ? ' c-dial-seg--now' : ''}`, len, k * (100 / n) + gap / 2)); }
    return svg;
  }
  function focusCard(x) {
    const rows = rowsFor(x), i = rows.findIndex((r) => !r.done), r = i >= 0 ? rows[i] : null;
    const counted = x.target_reps != null, n = w.exercises.indexOf(x) + 1;
    const dw = r ? defaultWeight(x, i) : null;
    const big = h('span', { class: 'c-dial-n' }), unit = h('span', { class: 'c-dial-u' }), sub = h('span', { class: 'c-dial-sub' });
    let steppers = null;
    focusNow = { x, i, wIn: null, rIn: null };
    if (r && counted) {
      const wIn = h('input', { class: 'dp-input c-num c-num--big', type: 'number', inputmode: 'decimal', min: '0', max: '2000', step: '0.5', value: r.weight === '' || r.weight == null ? '' : String(r.weight), placeholder: dw != null ? String(dw) : '0', 'aria-label': `${x.name} set ${i + 1} weight in pounds` });
      const rIn = h('input', { class: 'dp-input c-num c-num--big', type: 'number', inputmode: 'numeric', min: '0', max: '500', step: '1', value: r.reps === '' || r.reps == null ? '' : String(r.reps), placeholder: String(x.target_reps), 'aria-label': `${x.name} set ${i + 1} reps` });
      focusNow.wIn = wIn; focusNow.rIn = rIn;
      // The middle of the dial says what the main button will log: the weight, or the reps when there's no weight.
      const show = () => {
        const wv = wIn.value !== '' ? Number(wIn.value) : dw, rv = rIn.value !== '' ? Number(rIn.value) : x.target_reps;
        const weighted = wv != null && Number.isFinite(wv) && wv > 0;
        big.textContent = weighted ? String(Number.isInteger(wv) ? wv : Math.round(wv * 10) / 10) : String(rv ?? '–');
        unit.textContent = weighted ? 'lb' : rv === 1 ? 'rep' : 'reps';
        sub.textContent = weighted ? `× ${rv ?? '–'} ${rv === 1 ? 'rep' : 'reps'}` : 'No weight';
      };
      const keep = () => { patchSet(x, i, { weight: wIn.value, reps: rIn.value }); show(); };
      wIn.addEventListener('input', keep); rIn.addEventListener('input', keep);
      const step = (el, by, start, max, what) => h('button', { type: 'button', class: 'c-step c-step--big', 'aria-label': `${by > 0 ? 'More' : 'Less'} ${what}`, onClick: () => {
        const cur = el.value !== '' ? Number(el.value) : start;
        const next = Math.min(max, Math.max(0, (Number.isFinite(cur) ? cur : 0) + by));
        el.value = String(Number.isInteger(next) ? next : Math.round(next * 10) / 10);
        keep();
      } }, by > 0 ? '+' : '−');
      const line = (label, el, by, start, max, what, u) => h('div', { class: 'c-fstep' }, h('span', { class: 'c-fstep-l' }, label), step(el, -by, start, max, what), el, step(el, by, start, max, what), h('span', { class: 'c-fstep-u' }, u));
      steppers = h('div', { class: 'c-fsteps' }, line('Weight', wIn, WEIGHT_STEP, dw ?? 0, 2000, 'weight', 'lb'), line('Reps', rIn, 1, x.target_reps ?? 0, 500, 'reps', ''));
      show();
    } else if (r) {                                   // a time, a distance or a max: nothing to count, the set is ticked
      const what = x.distance || timeText(x.time_seconds) || (x.reps && !/^\d+$/.test(String(x.reps)) ? String(x.reps) : '');
      if (what && what.length <= 10) { big.textContent = what; big.classList.add('c-dial-n--text'); sub.textContent = 'Log it when done'; }
      else { big.textContent = String(i + 1); unit.textContent = `of ${rows.length}`; sub.textContent = what || x.prescription || ''; }
    } else {
      big.textContent = '✓'; unit.textContent = ''; sub.textContent = 'Every set logged';
    }
    if (logging && x.cue?.audio && !draft?.log_id && !exStarted(x) && cueFor !== x.id) { cueFor = x.id; playCue(x, { auto: true }).catch(() => {}); }
    const was = r ? x.last?.sets?.[i] ?? null : null;
    const hasHistory = !!(x.exercise_id && (x.last?.sets?.length || x.best_weight));
    const tile = (label, value, mark) => h(hasHistory ? 'button' : 'div', { class: 'c-ftile', ...(hasHistory ? { type: 'button', 'aria-label': `${label} ${value}. Open ${x.name} history`, onClick: (e) => busy(e.currentTarget, () => openHistory(x)) } : {}) },
      h('span', { class: 'c-ftile-l' }, mark ? h('span', { 'aria-hidden': 'true' }, `${mark} `) : null, label), h('span', { class: 'c-ftile-v' }, value));
    const lines = [
      x.planned_sets ? `${x.target_sets} ${x.target_sets === 1 ? 'set' : 'sets'} today (${x.planned_sets} planned)` : null,
      x.swapped ? (x.swapped.by_kind === 'athlete' ? `Your pick instead of ${x.swapped.from}` : x.swapped.by_kind === 'equipment' ? `For your gear instead of ${x.swapped.from}` : `Swapped in by ${x.swapped.by ? `Coach ${x.swapped.by.split(' ')[0]}` : 'your coach'} instead of ${x.swapped.from}`) : null,
      x.progression?.text ? `Your progression: ${x.progression.text} on the plan` : null,
      x.load && !x.load.missing ? x.load.text : null].filter(Boolean);
    const demo = !!x.video_url && !exStarted(x);
    return h('section', { class: 'c-focus-card', 'aria-label': `${x.name}, exercise ${n} of ${w.exercises.length}` },
      h('div', { class: 'c-focus-head' }, h('span', { class: 'c-focus-count' }, `${n} of ${w.exercises.length}`), h('h2', { class: 'c-focus-title' }, x.name)),
      x.group_label ? (flowOf(x) ? groupHeading(x) : h('div', { class: 'sf-group' }, groupTitle(x))) : null,
      // The demo still plays as the exercise comes up (owner's rule), then steps aside once the first set is logged.
      demo ? demoVideo(x) : null,
      x.note ? h('p', { class: 'c-cue strong', style: 'margin:0' }, `Coach's note: ${x.note}`) : null,
      rxTable(x, { compact: true }),
      lines.length ? h('div', { class: 'stack-tight small muted' }, lines.map((l) => h('span', null, l))) : null,
      x.form_check ? h('span', { class: 'small strong', style: x.form_check_sent ? 'color:var(--green-bright)' : 'color:var(--amber)' }, x.form_check_sent ? '✓ Form check sent' : 'Form check asked: film a set from Demo & more') : null,
      h('div', { class: `c-dial${demo ? ' c-dial--sm' : ''}`, role: 'img', 'aria-label': r ? `Set ${i + 1} of ${rows.length}` : 'Every set logged' }, setDial(rows, i),
        h('div', { class: 'c-dial-mid' }, r ? h('span', { class: 'c-dial-set' }, `Set ${i + 1} of ${rows.length}`) : null, h('span', { class: 'c-dial-big' }, big, unit), sub)),
      steppers,
      h('div', { class: 'c-ftiles' }, tile('Best', x.best_weight ? lb(x.best_weight) : '--', '🏆'), tile('Last time', was ? setText(was).replace(' reps', '') : x.last?.sets?.length ? setText(x.last.sets.at(-1)).replace(' reps', '') : '--')),
      rows.length < 99 ? h('div', { class: 'row', style: 'justify-content:center' }, btn('Add a set', () => { const all = rowsFor(x); all.push({ weight: '', reps: '', done: false }); draft.sets[x.id] = all; saveDraft(); redrawCards(); }, 'ghost')) : null);
  }
  // Under the card, the sets logged so far (OVR's list of reps): tap the tick to take one back; effort and a note
  // open under the latest where the athlete tracks them.
  function focusLog(x) {
    const rows = rowsFor(x), lastDone = rows.reduce((at, r, i) => (r.done ? i : at), -1);
    const done = rows.map((r, i) => (r.done ? [r, i] : null)).filter(Boolean);
    return h('section', { class: 'c-focus-log', 'aria-label': 'Sets logged' },
      done.length ? done.map(([r, i]) => h('div', { class: 'c-flog' },
        h('div', { class: 'c-flog-row' }, h('span', { class: 'c-set-no c-flog-no', 'aria-hidden': 'true' }, String(i + 1)), h('span', { class: 'c-flog-v grow' }, x.target_reps != null ? setText(r) : 'Done'),
          h('button', { type: 'button', class: 'c-flog-undo', 'aria-label': `Take back ${x.name} set ${i + 1}`, onClick: () => toggleSet(x, i, null, r.weight ?? '', r.reps ?? '') }, 'Undo')),
        extrasFor(x, i, r, lastDone, redrawCards)))
        : h('p', { class: 'small muted', style: 'margin:0;text-align:center' }, 'Your sets show here as you log them.'));
  }
  // The exercises as chips across the top (OVR's group chips): tap one to go to it; a tick once it's done.
  const focusChips = (x) => h('div', { class: 'c-fchips', role: 'tablist', 'aria-label': 'Exercises' }, w.exercises.map((e, k) => h('button', { type: 'button', role: 'tab', class: 'c-fchip', 'aria-selected': String(!state.ending && e.id === x.id),
    onClick: () => { state.ending = false; state.open = e.id; redrawCards(); window.scrollTo(0, 0); } }, exDone(e) ? '✓ ' : `${k + 1} · `, e.name)));
  // Demo & more: what the cards hold beside the sets (the demo, the coach's cue, a form check, the cue text, a swap).
  function openMore(x) {
    const clipHolder = h('div');
    const d = h('dialog', { class: 'c-notices-dlg', 'aria-label': `${x.name}: demo and more` },
      h('div', { class: 'stack' }, h('div', { class: 'row', style: 'align-items:center;justify-content:space-between;gap:12px' }, h('h2', { class: 'dp-panel-title', style: 'margin:0' }, x.name), btn('Close', () => d.close(), 'ghost')),
        x.video_url !== undefined ? demoVideo(x) : null,
        x.cue?.audio || x.cue?.clip ? h('div', { class: 'row wrap small', style: 'gap:8px;align-items:center' },
          x.cue?.audio ? btn('🔊 Coach\'s cue', (e) => busy(e.currentTarget, () => playCue(x)), 'ghost') : null,
          x.cue?.clip ? btn('Why this matters', (e) => busy(e.currentTarget, () => cueClip(x, clipHolder)), 'ghost') : null,
          x.cue?.audio ? h('label', { class: 'row muted', style: 'gap:6px;min-height:44px' }, h('input', { type: 'checkbox', checked: prefs.voice, onChange: (e) => { prefs.voice = e.target.checked; savePrefs(); if (!prefs.voice) stopCue(); } }), 'Play the cue when an exercise comes up') : null) : null,
        clipHolder, formCheckSend(x),
        x.note ? h('p', { class: 'c-cue strong' }, `Coach's note: ${x.note}`) : null,
        x.instructions ? h('p', { class: 'c-cue' }, x.instructions) : null,
        x.exercise_id && (x.last?.sets?.length || x.best_weight) ? h('div', { class: 'row' }, btn('History', (e) => busy(e.currentTarget, async () => { d.close(); await openHistory(x); }), 'secondary')) : null,
        altBlock(x)));
    d.addEventListener('close', () => { d.remove(); stopCue(); });
    document.body.append(d);
    d.showModal();
  }
  // The foot (OVR's END and NEXT): Demo & more, End, and the one button that logs the set up now, moves on when the
  // exercise is done, and finishes when everything is. The button itself stays put, so the thumb never moves.
  const mainBtn = h('button', { type: 'button', class: 'dp-btn dp-btn--primary c-fbar-main', onClick: () => {
    const f = focusNow; if (!f) return;
    const rows = rowsFor(f.x), i = rows.findIndex((r) => !r.done);
    if (i >= 0) return toggleSet(f.x, i, null, f.wIn?.value ?? '', f.rIn?.value ?? '');
    const next = w.exercises.find((e) => !exDone(e));
    if (next) { state.open = next.id; redrawCards(); window.scrollTo(0, 0); return; }
    state.ending = true; redrawCards(); window.scrollTo(0, 0);
  } });
  const focusBar = focusMode ? h('div', { class: 'c-fbar', role: 'group', 'aria-label': 'This exercise' },
    h('button', { type: 'button', class: 'dp-btn dp-btn--secondary c-fbar-more', 'aria-label': 'Demo, cue and more for this exercise', onClick: () => { if (focusNow) openMore(focusNow.x); } }, playIcon(), h('span', null, 'Demo')),
    h('button', { type: 'button', class: 'dp-btn dp-btn--secondary c-fbar-end', onClick: () => { state.ending = true; redrawCards(); window.scrollTo(0, 0); } }, 'End'),
    mainBtn) : null;
  function redrawFocus() {
    stopCue();
    if (!state.open && w.exercises.every(exDone)) state.ending = true;   // the last set of the last exercise: straight to the finish
    const x = inFocus();
    if (state.ending) {
      fill(list, focusChips(x), h('div', { class: 'stack' }, routineBlock(w.cooldown, 'Cool-down'), finishPanel, finishBtn,
        h('div', { class: 'row', style: 'justify-content:center' }, btn('Back to the workout', () => { state.ending = false; state.open = x.id; redrawCards(); window.scrollTo(0, 0); }, 'ghost'))));
      focusBar.hidden = true; document.body.classList.remove('c-focus-bar');
    } else {
      state.open = x.id;
      fill(list, focusChips(x), focusCard(x), focusLog(x));
      const rows = rowsFor(x), i = rows.findIndex((r) => !r.done), next = w.exercises.find((e) => !exDone(e));
      mainBtn.textContent = i >= 0 ? `Log set ${i + 1}` : next ? 'Next' : 'Finish';
      focusBar.hidden = false; document.body.classList.add('c-focus-bar');
      list.querySelector('.c-fchip[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    drawCount(); drawSession();
  }
  // The session bar: the clock since Start workout, sets logged of the sets planned, and the pounds moved so far.
  const sClock = h('span', { class: 'c-sess-n' }), sSets = h('span', { class: 'c-sess-n' }), sLb = h('span', { class: 'c-sess-n' });
  const num = (v) => (v === '' || v == null ? null : Number(v));
  function drawSession() {
    if (!session) return;
    const done = Object.values(draft.sets).flat().filter((r) => r.done);
    sSets.textContent = `${done.length}/${w.exercises.reduce((n, x) => n + rowsFor(x).length, 0)}`;
    sLb.textContent = Math.round(done.reduce((n, r) => n + (num(r.weight) != null && num(r.reps) != null ? num(r.weight) * num(r.reps) : 0), 0)).toLocaleString();
  }
  const drawClock = () => { const s = draft?.started_at ? Math.max(0, Math.floor((Date.now() - Date.parse(draft.started_at)) / 1000)) : 0; sClock.textContent = s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : clock(s); };
  clearInterval(sessionTick);
  if (session) { drawClock(); sessionTick = setInterval(() => { if (!sClock.isConnected) return clearInterval(sessionTick); drawClock(); }, 1000); }
  const cell = (n, label) => h('div', { class: 'c-sess-cell' }, n, h('span', { class: 'c-sess-l' }, label));
  const sessionBar = session ? h('div', { class: 'c-sess', role: 'group', 'aria-label': 'This workout so far' },
    h('div', { class: 'c-sess-title' }, h('span', { class: 'c-sess-name' }, w.title),
      h('button', { type: 'button', class: 'c-sess-link', 'aria-label': focusMode ? 'Show every exercise as a list' : 'Show one exercise at a time', onClick: () => { prefs.log_view = focusMode ? 'list' : 'focus'; savePrefs(); state.ending = false; render(); window.scrollTo(0, 0); } }, focusMode ? 'List' : 'Focus'),
      h('button', { type: 'button', class: 'c-sess-link', onClick: () => openWorkoutSettings(() => render()) }, 'Settings'),
      focusMode ? null : h('button', { type: 'button', class: 'c-sess-link', onClick: () => { state.fullView = true; render(); } }, 'Show everything')),
    h('div', { class: 'c-sess-cells' }, cell(sClock, 'time'), cell(sSets, 'sets'), cell(sLb, 'lb moved'))) : null;
  const list = h('div', { class: `stack${logging ? '' : ' c-plan'}`, style: logging ? 'gap:8px' : 'gap:6px' });   // before Start workout the plan reads as a compact list (owner's ask)
  const redrawCards = () => { if (focusMode) return redrawFocus(); stopCue(); cards.clear(); fill(list, withGroups(w.exercises, (x) => { const c = card(x); cards.set(x.id, c); return c; }, groupHeading)); drawCount(); drawSession(); };
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
  const finishBtn = btn(reopened ? 'Save changes' : 'Finish workout', (e) => busy(e.currentTarget, async () => {
    const left = w.exercises.filter((x) => !exDone(x) && !exStarted(x));
    if (!reopened && left.length === w.exercises.length) throw new Error('Log at least one set before you finish.');
    if (!reopened && left.length && !confirm(`You haven't logged ${left.length === 1 ? left[0].name : `${left.length} exercises`}. Finish anyway?`)) return;
    const unsent = reopened ? [] : w.exercises.filter((x) => x.form_check && !x.form_check_sent && formChecksReady !== false);
    if (unsent.length && !confirm(`Your coach asked for a form check on ${unsent.map((x) => x.name).join(' and ')}. Finish without sending it?`)) return;
    await finish(draft, w);
  }), 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:52px' });

  const finishPanel = logging ? h('div', { class: 'dp-panel stack' },
    h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'How hard was it?'), effortBox, effortWord),
    h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: 'notes' }, 'Notes for your coach (optional)'), notes),
    h('button', { type: 'button', class: 'c-sess-link', style: 'align-self:flex-start', onClick: () => openWorkoutSettings(() => render()) }, 'Workout settings: rest timer, effort and notes on each set')) : null;
  redrawCards();
  const blocked = reopened ? null : strayPanel();
  const early = !focusMode || !hasSets(draft);   // on the focus screen the day's notes and the warm-up step aside once a set is logged
  const chrome = !reopened && !session;   // the calendar, the prompts and the cards around the workout
  fill(view, session ? null : top(),
    sessionBar,
    chrome ? calendarStrip(home) : null,
    chrome ? gameCard(home) : null,
    session ? null : h('div', { class: 'stack-tight' },
      h('div', { class: 'small muted' }, reopened ? `Reopened: ${w.program_name ?? home.program?.name ?? ''}` : `Hi ${home.client.first_name}. Week ${w.week}, day ${w.day} of ${home.program.name}`),
      h('h1', { class: 'c-title' }, w.title),
      !reopened && whenText(w) ? h('div', { class: `small strong${w.status === 'missed' ? ' warn-text' : ''}` }, whenText(w)) : null),
    reopened || !early ? null : gameDayBanner(w),   // a yellow or red day (gameweek.js): the sets below are already cut
    // The coach's instructions for the day (version 75): read first, before anything else.
    w.instructions && early ? h('div', { class: 'c-note', style: 'white-space:pre-line' }, h('div', { class: 'small strong', style: 'margin-bottom:4px' }, 'From your coach'), w.instructions) : null,
    pendingBox,
    !reopened && state.pickWorkout && home.workout ? h('div', { class: 'c-note row', style: 'align-items:center' }, h('span', { class: 'grow' }, `You opened this one from your calendar. ${home.workout.title} is what's up ${home.workout.status === 'today' ? 'today' : 'next'}.`),
      btn(`Back to ${home.workout.title}`, () => openPick(home.workout.id), 'ghost')) : null,
    reopened ? h('div', { class: 'c-note row' }, h('span', { class: 'grow' }, 'Fix what you logged, then save. Your coach sees the changes.'), btn('Cancel', () => { store.set(DRAFT_KEY(), null); draft = null; render(); }, 'ghost')) : null,
    chrome ? h('div', { class: 'stack-tight' }, h('div', { class: 'c-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Program progress' }, h('div', { style: `width:${pct}%` })),
      h('div', { class: 'small muted' }, `${home.progress.completed} of ${home.progress.total} workouts done`)) : null,
    blocked,
    chrome ? readinessCard(home.readiness) : null,
    logging ? null : h('div', { class: 'stack-tight' }, startBtn(), h('p', { class: 'small muted', style: 'margin:0;text-align:center' }, `${w.exercises.length} ${w.exercises.length === 1 ? 'exercise' : 'exercises'} · tap one to see the demo and your last numbers`)),
    reopened || !early ? null : routineBlock(w.warmup, 'Warm-up'),
    logging && !session ? count : null, list,
    reopened || focusMode ? null : routineBlock(w.cooldown, 'Cool-down'),
    focusMode ? null : finishPanel,
    focusMode ? null : logging ? finishBtn : startBtn(),
    focusBar,
    state.fullView && !reopened && logging ? h('div', { class: 'row' }, h('span', { class: 'grow' }), btn('Back to just the workout', () => { state.fullView = false; render(); window.scrollTo(0, 0); }, 'ghost')) : null,
    chrome ? weeklyNoteCard(home) : null,
    chrome ? adjustmentsCard(home) : null,
    chrome ? gearCard(home) : null,
    chrome ? installCard(home) : null,
    chrome ? feedCard() : null,
    chrome ? historyPanel(home) : null,
    restBar);
}

// Finish (or save a reopened workout): into the outbox, then send. With no signal it's kept and sent later.
async function finish(d, w) {
  // Only exercises still in the workout (the coach may have changed it since the sets were logged).
  if (w) d = { ...d, sets: Object.fromEntries(Object.entries(d.sets).filter(([id]) => w.exercises.some((x) => x.id === id))) };
  const body = { request_id: d.request_id, notes: d.notes || undefined, rpe: d.rpe ?? undefined, started_at: d.started_at ?? undefined, finished_at: new Date().toISOString(),
    exercise_ids: Object.entries(d.sets).filter(([, rows]) => rows.some((r) => r.done)).map(([id]) => id),
    sets: Object.entries(d.sets).flatMap(([id, rows]) => rows.map((r, i) => (r.done ? { workout_exercise_id: id, set_no: i + 1, weight: r.weight ?? null, reps: r.reps ?? null, ...(r.rpe != null && r.rpe !== '' ? { rpe: Number(r.rpe) } : {}), ...(r.note && String(r.note).trim() ? { note: String(r.note).trim() } : {}) } : null)).filter(Boolean)) };
  if (d.log_id) delete body.finished_at;
  const entry = { token: d.token, kind: d.log_id ? 'edit' : 'finish', workout_id: d.workout_id, log_id: d.log_id, request_id: d.request_id, title: d.title, body };
  setOutbox([...outbox().filter((x) => x.request_id !== entry.request_id), entry]);
  store.set(DRAFT_KEY(), null);
  draft = null; state.open = null; state.details.clear(); state.fullView = false; state.extrasOpen = null; state.ending = false; cueFor = null;
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
    // The summary from what the phone has: each exercise of the workout with the sets ticked.
    const exercises = (w?.exercises ?? []).map((x) => { const rows = d.sets[x.id] ?? []; const logged = rows.map((r, i) => (r.done ? { set_no: i + 1, weight: r.weight === '' || r.weight == null ? null : Number(r.weight), reps: r.reps === '' || r.reps == null ? null : Number(r.reps), ...(r.rpe != null && r.rpe !== '' ? { rpe: Number(r.rpe) } : {}), ...(r.note ? { note: r.note } : {}) } : null)).filter(Boolean); return { id: x.id, name: x.name, prescription: x.prescription, done: logged.length > 0, sets: logged }; });
    const all = exercises.flatMap((x) => x.sets);
    const totals = { exercises_done: exercises.filter((x) => x.done).length, exercises_total: exercises.length, sets: all.length, reps: all.reduce((t, s) => t + (s.reps || 0), 0), tonnage_lb: Math.round(all.reduce((t, s) => t + (s.weight != null && s.reps != null ? s.weight * s.reps : 0), 0)) };
    state.done = { offline: true, title: d.title, sets, rpe: body.rpe ?? null, notes: body.notes ?? null, minutes: d.started_at ? Math.round((Date.now() - Date.parse(d.started_at)) / 60000) : null, bests: [], next: null, upcoming: state.home?.upcoming ?? [], exercises, totals };
  }
  engage.load().catch(() => {});
  render();
  window.scrollTo(0, 0);
}

// The summary after Finish (owner's ask: "a summary page of everything they did from that workout"): the totals as tiles,
// then every exercise with the sets logged (weight × reps), the ones skipped marked, bests, maxes, steps up and the note.
function renderDone(f) {
  const t = f.totals ?? null;
  const facts = [f.minutes && f.minutes >= 1 && f.minutes <= 240 ? `${f.minutes} min` : null, f.rpe ? `effort ${f.rpe}/10 (${RPE_WORDS[f.rpe].toLowerCase()})` : null].filter(Boolean);
  const tile = (n, label) => h('div', { class: 'c-sum-tile' }, h('span', { class: 'c-sum-n' }, n), h('span', { class: 'c-sum-l' }, label));
  const tiles = t ? h('div', { class: 'c-sum-tiles', role: 'list' },
    tile(`${t.exercises_done}${t.exercises_total ? `/${t.exercises_total}` : ''}`, 'exercises'), tile(String(t.sets), t.sets === 1 ? 'set' : 'sets'), t.reps ? tile(t.reps.toLocaleString(), 'reps') : null, t.tonnage_lb ? tile(`${t.tonnage_lb.toLocaleString()} lb`, 'lifted') : null,
    f.minutes && f.minutes >= 1 && f.minutes <= 240 ? tile(`${f.minutes}`, 'min') : null) : null;
  const exLine = (x) => h('div', { class: `c-sum-ex${x.done ? '' : ' c-sum-ex--skipped'}` },
    h('div', { class: 'row', style: 'gap:8px;align-items:baseline' }, h('span', { class: 'strong grow' }, x.name, x.swapped_from ? h('span', { class: 'small muted' }, ` (instead of ${x.swapped_from})`) : null, x.removed ? h('span', { class: 'small muted' }, ' (no longer in the workout)') : null), x.prescription ? h('span', { class: 'small muted' }, x.prescription) : null),
    x.done ? h('div', { class: 'small c-sum-sets' }, x.sets.map((s) => h('span', { class: 'c-sum-set' }, `${s.set_no}`, h('span', { class: 'muted' }, ' · '), setFull(s)))) : h('div', { class: 'small muted' }, 'Not logged'));
  const nextUp = f.next ?? null;
  fill(view, top(), pendingBox,
    h('div', { class: 'dp-panel stack' }, h('h1', { class: 'c-done', tabindex: '-1' }, f.edited ? 'Changes saved' : 'Workout logged'),
      h('p', { class: 'muted' }, `${f.title ? `${f.title}${f.week ? ` · week ${f.week} day ${f.day}` : ''}. ` : ''}${f.offline ? 'Saved on this phone. It sends when you\'re back online, and your coach sees it then.' : f.merged ? 'Added to the workout you logged on the weight-room screen. Your coach can see it now.' : 'Your coach can see it now.'}`),
      tiles,
      facts.length ? h('p', { class: 'strong', style: 'margin:0' }, facts.join(' · ')) : null,
      f.exercises?.length ? h('section', { class: 'stack-tight', 'aria-label': 'What you did' }, h('h2', { class: 'dp-panel-title' }, 'What you did'), f.exercises.map(exLine)) : null,
      f.progressions?.length ? h('div', { class: 'c-bests stack-tight', role: 'note' }, h('div', { class: 'strong' }, 'Steps up'), f.progressions.map((p) => h('div', null, `${p.exercise_name}: ${p.text}${p.status === 'approved' ? '' : ' (your coach will confirm it)'}`))) : null,
      f.notes ? h('p', { class: 'small' }, h('span', { class: 'muted' }, 'Your note: '), f.notes) : null,
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
    sets: Object.fromEntries(exercises.map((x) => [x.id, x.sets.map((s) => ({ weight: s.weight, reps: s.reps, done: true, rpe: s.rpe ?? null, note: s.note ?? '' }))])) };
  saveDraft();
  draft.workout = { id: log.workout_id, title: log.title, week: log.week, day: log.day, program_name: log.program_name, exercises: exercises.map((x) => ({ id: x.id, exercise_id: x.exercise_id, name: x.name, prescription: x.prescription, details: x.details, note: x.note, rest_seconds: x.rest_seconds, group_label: x.group_label, group_kind: x.group_kind, group_tag: x.group_tag, target_sets: Math.max(x.target_sets, x.sets.at(-1)?.set_no ?? 0), target_reps: x.target_reps })) };
  // Fill gaps: a set logged as number 3 with no 1 and 2 still shows in its place.
  for (const x of exercises) { const rows = []; for (const s of x.sets) rows[s.set_no - 1] = { weight: s.weight, reps: s.reps, done: true, rpe: s.rpe ?? null, note: s.note ?? '' }; draft.sets[x.id] = Array.from(rows, (r) => r ?? { weight: '', reps: '', done: false }); }
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
