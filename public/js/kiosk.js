import { h, fill } from './ui.js';

// The front-desk sign-in page (owner's ask: "list every class or session within a 2 hour window; when they click the
// private, class or session they log in with their ID and it checks them in"). Opened once on the tablet with the link
// from Schedule → Hours & settings (/kiosk#<key>); the key is kept on this tablet. An athlete taps their session, types
// their Athlete ID and is checked in (services/checkin.js kioskCheckInById).
const root = document.getElementById('root');
const store = { get: () => { try { return localStorage.getItem('dp-kiosk-key'); } catch { return null; } }, set: (k) => { try { localStorage.setItem('dp-kiosk-key', k); } catch { /* private mode */ } } };
if (location.hash.length > 1) { store.set(location.hash.slice(1)); history.replaceState(null, '', '/kiosk'); }
const key = store.get() ?? '';
const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const big = 'min-height:84px;font-size:22px;justify-content:flex-start;padding:16px 20px;text-align:left';
let board = null, picked = null, message = null, timer = null;

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'x-kiosk-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error?.message ?? 'Something went wrong.'), { status: r.status });
  return d;
}
async function load() {
  try { board = await api('GET', '/kiosk-api/board'); }
  catch (e) { return fill(root, h('main', { class: 'p-wrap', style: 'min-height:100vh;justify-content:center' }, h('div', { class: 'dp-panel stack' }, h('h1', { class: 'p-title' }, 'Check-in isn\'t set up'), h('p', { class: 'muted', style: 'margin:0' }, key ? e.message : 'Open the check-in link from Schedule → Hours & settings on this tablet.')))); }
  if (picked && !board.sessions.some((s) => s.id === picked)) picked = null;
  render();
}
// A message for a few seconds, then back to the list for the next athlete.
function flash(text, tone) { message = { text, tone }; render(); clearTimeout(timer); timer = setTimeout(() => { message = null; picked = null; load(); }, tone === 'warn' ? 6000 : 4000); }
const when = (s) => {
  const mins = Math.round((Date.parse(s.starts_at) - Date.now()) / 60000);
  return s.started ? `On now · until ${time(s.ends_at)}` : mins <= 1 ? 'Starting now' : mins < 60 ? `Starts in ${mins} min` : `Starts at ${time(s.starts_at)}`;
};

function sessionButton(s) {
  return h('button', { type: 'button', class: 'dp-btn dp-btn--secondary dp-btn--block', style: `${big};flex-direction:column;align-items:flex-start;gap:4px`, onClick: () => { picked = s.id; render(); } },
    h('span', { style: 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap' }, h('span', { style: 'font:700 24px/1.2 var(--font-display)' }, `${time(s.starts_at)}–${time(s.ends_at)}`), h('span', null, s.name)),
    h('span', { class: 'small muted', style: 'font-size:16px' }, [s.kind_label, s.coach_name ? `Coach ${s.coach_name.split(' ')[0]}` : null, when(s), s.expected ? `${s.checked_in} of ${s.expected} checked in` : null].filter(Boolean).join(' · ')));
}

function idForm(s) {
  const id = h('input', { class: 'dp-input', type: 'text', inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '20',
    'aria-label': 'Your Athlete ID', placeholder: 'AVALOP2026', style: 'font:700 34px/1.2 var(--font-mono, monospace);text-align:center;letter-spacing:.08em;min-height:80px;text-transform:uppercase' });
  const go = h('button', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:72px;font-size:24px' }, 'Check in');
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    const value = id.value.trim().toUpperCase().replace(/\s+/g, '');
    if (!value) return id.focus();
    go.disabled = true;
    try {
      const r = await api('POST', '/kiosk-api/check-in', { session_id: s.id, athlete_id: value });
      const extra = [r.pay_at_desk ? 'Please see the front desk to pay.' : null, r.waiver_needed ? 'Your family still needs to sign the waiver at the front desk.' : null].filter(Boolean).join(' ');
      flash(r.already ? `You're already checked in, ${r.name}. ${extra}`.trim() : `You're checked in, ${r.name}!${extra ? ` ${extra}` : ''}`, extra ? 'warn' : 'good');
    } catch (err) {
      go.disabled = false;
      if (err.status === 404) { fill(note, h('span', { class: 'warn-text' }, err.message)); id.select(); return; }
      flash(err.message, 'warn');
    }
  } },
  h('label', { class: 'p-title', style: 'font-size:22px;text-align:center;margin:0' }, 'Type your Athlete ID'), id, go);
  const note = h('p', { class: 'muted', role: 'status', style: 'text-align:center;margin:0;font-size:18px' }, 'It\'s on your profile and the app: first 3 letters of your first and last name and the year you joined.');
  setTimeout(() => id.focus(), 0);
  return h('div', { class: 'stack' }, form, note, h('button', { type: 'button', class: 'dp-btn dp-btn--ghost', style: 'min-height:56px;font-size:18px', onClick: () => { picked = null; render(); } }, 'Back to all sessions'));
}

function render() {
  const s = board.sessions.find((x) => x.id === picked) ?? null;
  const head = h('div', { class: 'stack-tight', style: 'text-align:center' }, h('img', { src: '/brand/logo.png', alt: board.business_name, style: 'width:120px;align-self:center' }),
    h('h1', { class: 'p-title' }, s ? s.name : 'Sign in'), h('p', { class: 'muted', style: 'margin:0;font-size:18px' }, s ? `${time(s.starts_at)}–${time(s.ends_at)}${s.coach_name ? ` · Coach ${s.coach_name.split(' ')[0]}` : ''}` : `${board.location_name} · tap your session`));
  let body;
  if (message) body = h('div', { class: 'dp-panel', role: 'status', style: `text-align:center;font:600 28px/1.3 var(--font-display);color:${message.tone === 'warn' ? 'var(--amber)' : 'var(--green-bright)'}` }, message.text);
  else if (!board.sessions.length) body = h('div', { class: 'dp-panel', style: 'text-align:center' }, h('p', { class: 'muted', style: 'margin:0;font-size:20px' }, 'Nothing on in the next 2 hours. Sessions show here 2 hours before they start.'));
  else if (!s) body = h('div', { class: 'stack' }, board.sessions.map(sessionButton));
  else body = idForm(s);
  fill(root, h('main', { class: 'p-wrap', style: 'max-width:900px;min-height:100vh;justify-content:center' }, head, body));
}

load();
setInterval(() => { if (!message && !picked) load(); }, 60000);   // never while someone is typing their ID
