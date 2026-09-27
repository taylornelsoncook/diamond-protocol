import { h, fill, busy, btn } from './ui.js';

// Opened from the QR code on the door. Parents check in their own athletes who are booked here right now.
const code = location.pathname.split('/here/')[1];
const root = document.getElementById('root');
const logo = () => h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.', style: 'width:140px;align-self:center' });
const shell = (...kids) => fill(root, h('main', { class: 'p-wrap', style: 'min-height:100vh;justify-content:center' }, logo(), h('div', { class: 'dp-panel stack' }, ...kids)));
const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

async function load() {
  const place = await fetch(`/here-api/${code}`);
  if (!place.ok) return shell(h('h1', { class: 'p-title' }, 'Code not found'), h('p', { class: 'muted', style: 'margin:0' }, 'This check-in code isn\'t in use any more. Ask a coach to check you in.'));
  const { business_name, location_name } = await place.json();
  document.title = `Check in · ${business_name}`;
  const res = await fetch(`/portal/api/check-in?code=${encodeURIComponent(code)}`, { credentials: 'same-origin' });
  if (res.status === 401) return shell(h('h1', { class: 'p-title' }, `Check in at ${location_name}`), h('p', { class: 'muted', style: 'margin:0' }, 'Sign in to the parent portal to check your athlete in. You\'ll come right back here.'),
    h('a', { class: 'dp-btn dp-btn--primary dp-btn--block', href: `/parent?checkin=${encodeURIComponent(code)}` }, 'Sign in'));
  const data = await res.json();
  if (!res.ok) return shell(h('h1', { class: 'p-title' }, 'Something went wrong'), h('p', { class: 'muted', style: 'margin:0' }, data.error?.message ?? 'Try again, or ask a coach to check you in.'));
  render(data);
}

function render(d, note) {
  if (!d.data.length) return shell(h('h1', { class: 'p-title' }, `Check in at ${d.location_name}`),
    h('p', { class: 'muted', style: 'margin:0' }, 'Nobody in your family is booked here right now. Check-in opens 30 minutes before a session starts.'), h('a', { class: 'dp-btn dp-btn--secondary dp-btn--block', href: '/parent' }, 'Open the parent portal'));
  shell(h('h1', { class: 'p-title' }, `Check in at ${d.location_name}`),
    note ? h('div', { class: note.ok ? 'strong' : 'test-banner', role: 'status', style: note.ok ? 'color:var(--green-bright)' : '' }, note.text) : null,
    ...d.data.map((b) => h('div', { class: 'row', style: 'align-items:center;gap:12px' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, b.athlete), h('span', { class: 'small muted' }, `${b.session}, ${time(b.starts_at)}`)),
      b.checked_in ? h('span', { class: 'dp-badge dp-badge--good' }, 'Checked in') : btn('Check in', (e) => busy(e.currentTarget, () => checkIn(b.booking_id)), 'primary'))));
}
async function checkIn(bookingId) {
  const r = await fetch('/portal/api/check-in', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, booking_id: bookingId }) });
  const out = await r.json();
  const list = await (await fetch(`/portal/api/check-in?code=${encodeURIComponent(code)}`, { credentials: 'same-origin' })).json();
  render(list, !r.ok ? { text: out.error?.message } : out.pay_at_desk ? { text: 'Checked in. This session isn\'t paid for yet, so please stop by the front desk.' } : { ok: true, text: `${out.checked_in.map((c) => c.athlete).join(' and ')} checked in. Have a great session!` });
}

load();
