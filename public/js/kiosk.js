import { h, fill } from './ui.js';

// The front-desk check-in tablet. Opened once with the link from Hours & settings (/kiosk#<key>); the key is kept on
// this tablet. Athletes tap their session, then their name.
const root = document.getElementById('root');
const store = { get: () => { try { return localStorage.getItem('dp-kiosk-key'); } catch { return null; } }, set: (k) => { try { localStorage.setItem('dp-kiosk-key', k); } catch { /* private mode */ } } };
if (location.hash.length > 1) { store.set(location.hash.slice(1)); history.replaceState(null, '', '/kiosk'); }
const key = store.get() ?? '';
const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const big = 'min-height:72px;font-size:22px;justify-content:flex-start;padding:16px 20px;text-align:left';
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
function flash(text, tone) { message = { text, tone }; render(); clearTimeout(timer); timer = setTimeout(() => { message = null; picked = null; load(); }, 4000); }

function render() {
  const s = board.sessions.find((x) => x.id === picked) ?? (board.sessions.length === 1 ? board.sessions[0] : null);
  const head = h('div', { class: 'stack-tight', style: 'text-align:center' }, h('img', { src: '/brand/logo.png', alt: board.business_name, style: 'width:120px;align-self:center' }),
    h('h1', { class: 'p-title' }, s ? s.name : 'Check in'), h('p', { class: 'muted', style: 'margin:0' }, s ? `${time(s.starts_at)} · Tap your name` : board.location_name));
  let body;
  if (message) body = h('div', { class: 'dp-panel', role: 'status', style: `text-align:center;font:600 28px/1.3 var(--font-display);color:${message.tone === 'warn' ? 'var(--amber)' : 'var(--green-bright)'}` }, message.text);
  else if (!board.sessions.length) body = h('div', { class: 'dp-panel', style: 'text-align:center' }, h('p', { class: 'muted', style: 'margin:0;font-size:20px' }, 'No sessions open for check-in right now. Check-in opens 30 minutes before a session starts.'));
  else if (!s) body = h('div', { class: 'stack' }, board.sessions.map((x) => h('button', { type: 'button', class: 'dp-btn dp-btn--secondary dp-btn--block', style: big, onClick: () => { picked = x.id; render(); } }, `${x.name} · ${time(x.starts_at)}`)));
  else body = h('div', { class: 'stack' },
    s.athletes.length ? h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px' }, s.athletes.map((a) => h('button', { type: 'button', class: `dp-btn dp-btn--${a.checked_in ? 'ghost' : 'secondary'} dp-btn--block`, style: big, disabled: a.checked_in, onClick: () => tap(a) }, a.checked_in ? `${a.name} ✓` : a.name)))
      : h('p', { class: 'muted', style: 'text-align:center;font-size:20px' }, 'Nobody is booked yet.'),
    h('p', { class: 'muted', style: 'text-align:center;margin:0' }, 'Not on the list? See a coach.'),
    board.sessions.length > 1 ? h('button', { type: 'button', class: 'dp-btn dp-btn--ghost', onClick: () => { picked = null; render(); } }, 'Back to all sessions') : null);
  fill(root, h('main', { class: 'p-wrap', style: 'max-width:900px;min-height:100vh;justify-content:center' }, head, body));
}
async function tap(a) {
  try {
    const r = await api('POST', '/kiosk-api/check-in', { booking_id: a.booking_id });
    await load();
    flash(r.pay_at_desk ? `Thanks, ${r.name}! Please see the front desk to pay.` : `You're checked in, ${r.name}!`, r.pay_at_desk ? 'warn' : 'good');
  } catch (e) { flash(e.message, 'warn'); }
}

load();
setInterval(() => { if (!message) load(); }, 60000);
