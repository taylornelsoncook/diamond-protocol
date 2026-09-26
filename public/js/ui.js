// Shared browser helpers for every Diamond Protocol app: safe HTML, API calls, formatting, toasts, modals.

// ---- Safe HTML: html`<p>${userText}</p>` escapes values; nest html`` results or arrays freely. ----
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s ?? ''));
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toHtml(v) {
  if (v == null || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += toHtml(v) + strings[i + 1]; });
  return new Safe(out);
}
export function mount(el, content) { el.innerHTML = toHtml(content); return el; }

// ---- API ----
export class ApiError extends Error { constructor(status, data) { super(data?.error || `Request failed (${status})`); this.status = status; this.data = data; } }
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }
export async function api(method, path, body, opts = {}) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData || typeof body === 'string') { init.body = body; if (typeof body === 'string') init.headers['content-type'] = opts.type || 'text/plain'; }
  else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, init);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized && !opts.noRedirect) onUnauthorized();
    throw new ApiError(res.status, typeof data === 'object' ? data : { error: data });
  }
  return data;
}
api.get = (p, o) => api('GET', p, undefined, o);
api.post = (p, b, o) => api('POST', p, b ?? {}, o);
api.put = (p, b, o) => api('PUT', p, b ?? {}, o);
api.patch = (p, b, o) => api('PATCH', p, b ?? {}, o);
api.del = (p, o) => api('DELETE', p, undefined, o);

// ---- formatting ----
export function money(cents, { always2 = false } = {}) {
  const n = Number(cents || 0) / 100;
  const frac = always2 || Math.round(n * 100) % 100 !== 0 ? 2 : 0;
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: 2 });
}
export const toCents = (v) => Math.round(parseFloat(String(v).replace(/[$,\s]/g, '')) * 100);
const asDate = (d) => (d instanceof Date ? d : new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T12:00:00' : String(d).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(d) || /^\d{4}-\d{2}-\d{2}T/.test(d) ? '' : 'Z')));
export const fmtDate = (d, o = {}) => (d ? asDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(o.year !== false ? { year: 'numeric' } : {}), ...(o.weekday ? { weekday: 'short' } : {}) }) : '');
export const fmtTime = (d) => (d ? asDate(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
export const fmtDateTime = (d) => (d ? `${fmtDate(d, { year: false, weekday: true })}, ${fmtTime(d)}` : '');
// Local wall-clock timestamps ("2026-09-26T16:30") are what events use.
export const localISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function relTime(d) {
  if (!d) return '';
  const s = (Date.now() - asDate(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} day${s < 172800 ? '' : 's'} ago`;
  return fmtDate(d);
}
export function age(birthday) {
  if (!birthday) return null;
  const b = new Date(birthday + 'T12:00:00'), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}
export const fullName = (a) => (a ? `${a.first_name} ${a.last_name}` : '');
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ---- status badges ----
const BADGES = {
  active: ['Active', 'good'], paid: ['Paid', 'good'], complete: ['Complete', 'good'], member: ['Member', 'good'], registered: ['Registered', 'good'], signed: ['Signed', 'good'],
  past_due: ['Past due', 'warn'], failed: ['Failed', 'warn'], overdue: ['Overdue', 'warn'], unpaid: ['Unpaid', 'warn'], at_risk: ['At risk', 'warn'], locked: ['Locked', 'warn'],
  trial: ['Trial', 'neutral'], open: ['Open', 'neutral'], credit: ['Credit', 'neutral'], team: ['Team', 'neutral'], waitlist: ['Waitlist', 'neutral'],
  shared: ['Shared', 'good'], warn: ['Check', 'warn'],
  paused: ['Paused', 'muted'], cancelled: ['Cancelled', 'muted'], void: ['Void', 'muted'], draft: ['Draft', 'muted'], ended: ['Ended', 'muted'], off: ['Off', 'muted'],
};
export function badge(status, label) {
  const [text, tone] = BADGES[status] || [status, 'muted'];
  return html`<span class="badge badge-${tone}">${label || text}</span>`;
}

// ---- icons (1.6px stroke, square joins) ----
const P = {
  today: 'M3 4h14v13H3zM3 8h14M7 2v4M13 2v4', schedule: 'M3 4h14v13H3zM3 8h14M7 11h2M11 11h2M7 14h2', pos: 'M3 5h14v10H3zM3 9h14M6 13h3',
  clients: 'M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 17c0-3 2.2-5 5-5s5 2 5 5M13 4a3 3 0 0 1 0 5M15 12c1.8.6 3 2.3 3 5',
  teams: 'M10 2l7 3v5c0 4-3 6.5-7 8-4-1.5-7-4-7-8V5z', testing: 'M10 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 7v4l2.5 1.5M8 2h4',
  billing: 'M4 2h12v16l-3-2-3 2-3-2-3 2zM7 7h6M7 10h6M7 13h4', programs: 'M2 8v4M5 6v8M15 6v8M18 8v4M5 10h10',
  api: 'M7 6l-4 4 4 4M13 6l4 4-4 4M11 4l-2 12', staff: 'M10 2l7 3v5c0 4-3 6.5-7 8-4-1.5-7-4-7-8V5zM7 10l2 2 4-4',
  menu: 'M3 5h14M3 10h14M3 15h14', close: 'M5 5l10 10M15 5L5 15', plus: 'M10 4v12M4 10h12', search: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5L18 18',
  check: 'M4 10l4 4 8-8', play: 'M6 4v12l10-6z', chevron: 'M8 5l5 5-5 5', back: 'M12 5l-5 5 5 5', warn: 'M10 3l8 14H2zM10 8v4M10 14v1',
  print: 'M5 7V2h10v5M5 14H3V7h14v7h-2M5 11h10v7H5z', download: 'M10 3v10M6 9l4 4 4-4M3 17h14', upload: 'M10 13V3M6 7l4-4 4 4M3 17h14',
  home: 'M3 9l7-6 7 6v8H3zM8 17v-5h4v5', book: 'M3 4h14v13H3zM3 8h14M7 2v4M13 2v4M7 12l2 2 4-4', progress: 'M3 17l5-6 4 3 5-8', family: 'M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM14 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 16c0-2.5 1.8-4.5 4-4.5s4 2 4 4.5M10 16c0-2.5 1.8-4.5 4-4.5s4 2 4 4.5',
  card: 'M2 5h16v10H2zM2 8h16', timer: 'M10 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 7v4M8 2h4',
};
export function icon(name, size = 20) {
  return raw(`<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true"><path d="${P[name] || ''}"/></svg>`);
}

// ---- toasts ----
export function toast(msg, tone = 'good') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (tone === 'warn' ? ' warn' : '');
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), tone === 'warn' ? 5000 : 3200);
}
export const toastError = (e) => toast(e?.message || String(e), 'warn');

// ---- modal: resolves with the clicked action's value, or null when dismissed ----
// body can be html``; onMount(el, close) wires custom behaviour; action { label, value, kind, submit }
export function modal({ title, body, actions = [{ label: 'Close', value: null }], wide = false, onMount }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const prevFocus = document.activeElement;
    mount(back, html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="spread"><h2 class="modal-title" id="modal-title">${title}</h2>
      <button class="btn btn-ghost btn-sm" data-close aria-label="Close">${icon('close')}</button></div>
      <div class="modal-body stack">${body}</div>
      <div class="btn-row modal-actions">${actions.map((a, i) => html`<button class="btn ${a.kind ? 'btn-' + a.kind : ''}" data-i="${i}">${a.label}</button>`)}</div></div>`);
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', async (e) => {
      if (e.target === back || e.target.closest('[data-close]')) return close(null);
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const a = actions[+b.dataset.i];
      if (a.onClick) {
        b.disabled = true;
        try { const r = await a.onClick(back.querySelector('.modal-body')); if (r !== false) close(r ?? a.value); }
        catch (err) { toastError(err); }
        finally { b.disabled = false; }
      } else close(a.value);
    });
    document.body.append(back);
    onMount?.(back.querySelector('.modal-body'), close);
    (back.querySelector('.modal-body [autofocus]') || back.querySelector('.modal-body input, .modal-body select, .modal-body textarea') || back.querySelector('[data-i]'))?.focus();
  });
}
export async function confirmDialog(title, text, label = 'Confirm', kind = 'primary') {
  return modal({ title, body: html`<p style="margin:0">${text}</p>`, actions: [{ label: 'Cancel', value: false }, { label, value: true, kind }] });
}

// ---- forms ----
export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { if (el.dataset.multi != null) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; }
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else if (el.multiple) o[el.name] = [...el.selectedOptions].map((x) => x.value);
    else o[el.name] = el.value;
  }
  return o;
}
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const options = (list, selected, { value = 'id', label = 'name', blank } = {}) =>
  html`${blank != null ? html`<option value="">${blank}</option>` : ''}${list.map((x) => html`<option value="${x[value]}" ${String(x[value]) === String(selected ?? '') ? raw('selected') : ''}>${typeof label === 'function' ? label(x) : x[label]}</option>`)}`;

// Tiny sparkline for trends (values in order, lowerBetter flips the direction colour).
export function sparkline(values, { w = 120, h = 32 } = {}) {
  if (!values || values.length < 2) return raw('');
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 4) + 2},${h - 2 - ((v - min) / span) * (h - 4)}`).join(' ');
  return raw(`<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--green-mid)" stroke-width="2"/></svg>`);
}
