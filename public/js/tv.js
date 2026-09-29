import { h, fill } from './ui.js';
import { withGroups, groupTitle } from './set-fields.js';

// The weight-room screen. Opened once with a check-in tablet's link, ending in /tv#<key> instead of /kiosk#<key>;
// the key is kept on this screen. It shows the workout a coach picked for each session running now, and athletes
// tap their name to see their own weights and log the workout. Refreshes every 30 seconds.
const root = document.getElementById('root');
const store = { get: () => { try { return localStorage.getItem('dp-screen-key'); } catch { return null; } }, set: (k) => { try { localStorage.setItem('dp-screen-key', k); } catch { /* private mode */ } } };
let memoryKey = null;
if (location.hash.length > 1) { memoryKey = location.hash.slice(1); store.set(memoryKey); history.replaceState(null, '', '/tv'); }
const key = store.get() ?? memoryKey ?? '';
const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
let board = null, picked = null, athlete = null, message = null, timer = null;

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'x-kiosk-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message ?? 'Something went wrong.');
  return d;
}
async function load() {
  try { board = await api('GET', '/kiosk-api/screen'); }
  catch (e) { return fill(root, h('main', { class: 'tv-wrap tv-center' }, h('div', { class: 'dp-panel stack' }, h('h1', { class: 'tv-title' }, 'This screen isn\'t set up'), h('p', { class: 'muted', style: 'margin:0' }, key ? e.message : 'Set up a tablet in Schedule → Hours & settings, then open its weight-room screen link here.')))); }
  if (picked && !board.sessions.some((s) => s.id === picked)) picked = null;
  if (!athlete) render();
}
function done(text, tone = 'good') { message = { text, tone }; athlete = null; render(); clearTimeout(timer); timer = setTimeout(() => { message = null; load(); }, 4000); }

async function tapName(s, a) {
  if (a.logged) return done(`${a.name.split(' ')[0]}, you already logged this one.`, 'warn');
  try { athlete = { ...(await api('POST', '/kiosk-api/screen/athlete', { session_id: s.id, ref: a.ref })), ref: a.ref, session: s }; render(); }
  catch (e) { done(e.message, 'warn'); }
  clearTimeout(timer); timer = setTimeout(() => { athlete = null; load(); }, 90000);   // walk away: back to the board
}
async function log() {
  const a = athlete;
  try { await api('POST', '/kiosk-api/screen/log', { session_id: a.session.id, ref: a.ref }); done(`Nice work, ${a.name}. Logged.`); }
  catch (e) { done(e.message, 'warn'); }
}

function workoutList(w) {
  return h('ol', { class: 'tv-ex' }, withGroups(w.exercises, (x) => h('li', { class: x.group_label ? 'tv-ex--grouped' : null },
    h('span', { class: 'tv-ex-name' }, x.group_tag ? `${x.group_tag} · ${x.name}` : x.name), h('span', { class: 'tv-ex-rx' }, x.prescription || ''),
    x.load || x.details ? h('span', { class: 'tv-ex-load' }, [x.load, x.details].filter(Boolean).join(' · ')) : null),
  (x) => h('li', { class: 'tv-ex-group' }, groupTitle(x))));
}
function render() {
  const sessions = board.sessions.filter((s) => s.workout);
  const s = sessions.find((x) => x.id === picked) ?? sessions[0] ?? null;
  const head = h('header', { class: 'tv-head' }, h('img', { src: '/brand/logo.png', alt: board.business_name, class: 'tv-logo' }),
    sessions.length > 1 ? h('nav', { class: 'tv-tabs' }, sessions.map((x) => h('button', { type: 'button', class: 'tv-tab', 'aria-current': x.id === s.id ? 'true' : null, onClick: () => { picked = x.id; render(); } }, x.name))) : h('span', { class: 'grow' }),
    h('span', { class: 'tv-clock' }, time(new Date().toISOString())));
  if (!s) {
    const waiting = board.sessions[0];
    return fill(root, h('main', { class: 'tv-wrap' }, head, h('div', { class: 'tv-center' }, h('p', { class: 'tv-empty' },
      waiting ? `No workout picked for ${waiting.name} yet. Coaches pick one on the session page.` : `Nothing running at ${board.location_name} right now. The workout shows here 30 minutes before a session starts.`))));
  }
  const w = s.workout;
  let side;
  if (message) side = h('div', { class: `tv-msg tv-msg--${message.tone}`, role: 'status' }, message.text);
  else if (athlete) side = h('div', { class: 'tv-me stack' },
    h('h2', { class: 'tv-me-name' }, athlete.name),
    athlete.readiness && athlete.readiness.level !== 'green' ? h('p', { class: 'tv-me-ready' }, `${athlete.readiness.headline}, from today's check-in.`) : null,
    athlete.weights.length ? h('dl', { class: 'tv-me-weights' }, athlete.weights.map((x) => h('div', null, h('dt', null, x.name), h('dd', null, x.text)))) : h('p', { class: 'muted', style: 'margin:0' }, 'No weights to work out for this one. Follow the board.'),
    h('button', { type: 'button', class: 'dp-btn dp-btn--primary dp-btn--block tv-big', onClick: log }, 'Log this workout'),
    h('button', { type: 'button', class: 'dp-btn dp-btn--ghost dp-btn--block', onClick: () => { athlete = null; render(); } }, 'Not me'));
  else side = h('div', { class: 'stack' }, h('p', { class: 'tv-side-title' }, 'Tap your name for your weights and to log it'),
    s.athletes.length ? h('div', { class: 'tv-names' }, s.athletes.map((a) => h('button', { type: 'button', class: `dp-btn dp-btn--${a.logged ? 'ghost' : 'secondary'} tv-name`, onClick: () => tapName(s, a) }, a.logged ? `${a.name} ✓` : a.name)))
      : h('p', { class: 'muted' }, 'Nobody is booked yet.'));
  fill(root, h('main', { class: 'tv-wrap' }, head,
    h('div', { class: 'tv-grid' },
      h('section', { class: 'tv-workout' }, h('p', { class: 'tv-kicker' }, `${s.name} · ${time(s.starts_at)}–${time(s.ends_at)} · ${w.program_name}, week ${w.week} day ${w.day}`), h('h1', { class: 'tv-title' }, w.title), workoutList(w)),
      h('aside', { class: 'tv-side' }, side))));
}

load();
setInterval(() => { if (!athlete && !message) load(); }, 30000);
