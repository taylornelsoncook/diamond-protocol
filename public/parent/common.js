// Shared pieces for parent portal screens: header, athlete picker, date labels.
import { html, raw, esc } from '/js/ui.js';

export function header(title, sub) {
  return html`<header class="p-head">
    <img src="/img/mark-192.png" alt="Diamond Protocol">
    <div><h1 class="p-title">${title}</h1>${sub ? html`<p class="p-sub">${sub}</p>` : ''}</div>
  </header>`;
}

// Pills to pick the athlete. Only shown when the family has more than one.
export function athletePills(ctx) {
  const list = ctx.me.athletes;
  if (list.length < 2) return '';
  return html`<div class="pills" role="group" aria-label="Athlete">${list.map((a) => html`<button class="pill" data-athlete="${a.id}" aria-pressed="${String(a.id === ctx.athlete?.id)}">${a.first_name}</button>`)}</div>`;
}
export function bindAthletePills(ctx) {
  ctx.el.querySelectorAll('[data-athlete]').forEach((b) => { b.onclick = () => {
    ctx.setAthlete(+b.dataset.athlete);
    const u = new URL(location.href); u.searchParams.delete('athlete');
    ctx.go(u.pathname + u.search + u.hash, { replace: true });
  }; });
}

// Event times are local wall-clock strings: "2026-09-28T16:30".
const D = (s) => new Date(s.length === 10 ? s + 'T12:00:00' : s);
export const weekday = (s) => D(s).toLocaleDateString('en-US', { weekday: 'short' });
export const dayLong = (s) => D(s).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
export const dayShort = (s) => D(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const clock = (s) => D(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const clockHM = (hm) => clock(`2000-01-01T${hm}`);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const weekdays = (csv) => String(csv || '').split(',').filter((x) => x !== '').map((d) => WD[+d]).join(' & ').replace(/ & (?=.* & )/g, ', ');

export function groupByDay(list, key = 'starts_at') {
  const out = [];
  for (const x of list) {
    const d = x[key].slice(0, 10);
    if (!out.length || out[out.length - 1].day !== d) out.push({ day: d, items: [] });
    out[out.length - 1].items.push(x);
  }
  return out;
}

export const lockIcon = raw('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true"><path d="M4 9h12v9H4zM7 9V6a3 3 0 0 1 6 0v3M10 13v2"/></svg>');
export { esc };
