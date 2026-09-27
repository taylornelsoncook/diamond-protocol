import { h, fill, toast, money, busy, btn } from './ui.js';

// An open-spot offer (/spot/<token>) from an email or text: book one tap, no sign-in. First to book gets the spot.
const tok = location.pathname.split('/spot/')[1];
const root = document.getElementById('root');
const logo = () => h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.', style: 'width:140px;align-self:center' });
const shell = (...kids) => fill(root, h('main', { class: 'p-wrap', style: 'min-height:100vh;justify-content:center' }, logo(), h('div', { class: 'dp-panel stack' }, ...kids)));
const api = async (method, path, body) => {
  const res = await fetch(`/portal/api/public/spot/${tok}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(d.error?.message ?? 'Something went wrong. Try again.'); e.status = res.status; throw e; }
  return d;
};

async function load() {
  try { render(await api('GET', '')); }
  catch { shell(h('h1', { class: 'p-title' }, 'Offer not found'), h('p', { class: 'muted', style: 'margin:0' }, 'Check the link in your email or text.')); }
}

function render(o, note) {
  const fmt = (iso, opt) => new Intl.DateTimeFormat('en-US', { timeZone: o.timezone, ...opt }).format(new Date(iso));
  const s = o.session;
  document.title = `Open spot · ${o.business_name}`;
  const head = [h('p', { class: 'small muted', style: 'margin:0;letter-spacing:.08em;text-transform:uppercase' }, 'Open spot'),
    h('h1', { class: 'p-title', style: 'margin:0' }, s.name),
    h('p', { style: 'margin:0' }, `${fmt(s.starts_at, { weekday: 'long', month: 'long', day: 'numeric' })}, ${fmt(s.starts_at, { hour: 'numeric', minute: '2-digit' })}–${fmt(s.ends_at, { hour: 'numeric', minute: '2-digit' })} · ${s.location_name}`)];
  const booked = o.athletes.filter((a) => a.status === 'booked');
  if (note || booked.length) return shell(...head, h('div', { class: 'dp-panel', style: 'background:var(--green-deep);border-color:var(--green)' }, h('p', { class: 'strong', style: 'margin:0' }, note ?? `${booked.map((a) => a.first_name).join(' and ')} ${booked.length > 1 ? 'are' : 'is'} booked. See you there!`)),
    h('a', { class: 'dp-btn dp-btn--secondary dp-btn--block', href: '/parent' }, 'Open the parent portal'));
  const closed = { full: 'Sorry, that spot was just taken. We\'ll let you know next time one opens.', started: 'This session has already started.', canceled: 'This session was canceled.' }[o.status];
  if (closed) return shell(...head, h('p', { class: 'muted', style: 'margin:0' }, closed), h('a', { class: 'dp-btn dp-btn--secondary dp-btn--block', href: '/book' }, 'See what else is open'));
  if (!o.waiver_signed) return shell(...head, h('p', { style: 'margin:0' }, 'Sign the waiver in the parent portal first (Family tab), then come back to this link.'), h('a', { class: 'dp-btn dp-btn--primary dp-btn--block', href: '/parent' }, 'Open the parent portal'));

  const take = (a, pay) => async () => {
    try {
      const r = await api('POST', '/book', { athlete_id: a.id, ...(pay ? { pay: 'card_on_file' } : {}) });
      render(r, r.message);
    } catch (e) {
      if (e.status === 402 && !pay && s.drop_in_cents && o.card_last4) {
        if (confirm(`${e.message}\n\nPay ${money(s.drop_in_cents)} with the card ending ${o.card_last4}?`)) return take(a, true)();
        return;
      }
      toast(e.message, 'warn');
      load();
    }
  };
  shell(...head,
    h('p', { class: `strong ${s.spots_left <= 1 ? 'warn-text' : ''}`, style: 'margin:0' }, s.spots_left === 1 ? 'One spot left. First to book gets it.' : `${s.spots_left} spots left.`),
    ...o.athletes.map((a) => a.status === 'waitlisted' ? h('p', { class: 'muted', style: 'margin:0' }, `${a.first_name} is on the waitlist.`)
      : btn(`Book ${a.first_name}`, (e) => busy(e.currentTarget, take(a)), 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block' })),
    h('p', { class: 'small muted', style: 'margin:0' }, `Covered by a membership or session pack when ${o.athletes.length > 1 ? 'they have' : 'there\'s'} one${s.drop_in_cents ? `; otherwise ${money(s.drop_in_cents)} drop-in` : ''}. Cancel from the parent portal if plans change.`));
}
load();
