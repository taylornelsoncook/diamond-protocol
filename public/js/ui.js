// Small DOM helpers shared by the coach dashboard and the client app.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, val] of Object.entries(props || {})) {
    if (val == null || val === false) continue;
    if (k.startsWith('on') && typeof val === 'function') el.addEventListener(k.slice(2).toLowerCase(), val);
    else if (k === 'class') el.className = val;
    else if (k === 'style') el.style.cssText = val;   // CSSOM, allowed by the page's content security policy
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = val;
    else el.setAttribute(k, val === true ? '' : val);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// Like el.replaceChildren, but skips null/false so conditional pieces can be passed inline.
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

export function toast(msg, tone = 'good') {
  const host = document.getElementById('toasts');
  const t = h('div', { class: `dp-toast${tone === 'warn' ? ' dp-toast--warn' : ''}`, role: 'status' }, msg);
  host.append(t);
  setTimeout(() => t.remove(), tone === 'warn' ? 6000 : 3500);
}

export const money = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 });
export const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export function ago(iso) {
  if (!iso) return 'Never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const d = Math.round(hrs / 24);
  return d === 1 ? 'Yesterday' : d < 30 ? `${d} days ago` : date(iso);
}

const STATUS = { active: ['Active', 'good'], trialing: ['Trial', 'neutral'], past_due: ['Past due', 'warn'], paused: ['Paused', 'muted'], canceled: ['Canceled', 'muted'], none: ['No plan', 'muted'],
  paid: ['Paid', 'good'], failed: ['Failed', 'warn'], open: ['Open', 'neutral'], void: ['Void', 'muted'], succeeded: ['Paid', 'good'], pending: ['Waiting', 'neutral'], revoked: ['Revoked', 'muted'], delivered: ['Delivered', 'good'], retrying: ['Retrying', 'neutral'],
  refunded: ['Refunded', 'muted'], partially_refunded: ['Part refunded', 'neutral'], settled: ['Paid another way', 'muted'], expired: ['Expired', 'muted'] };
export function badge(status) {
  const [label, tone] = STATUS[status] || [status, 'muted'];
  return h('span', { class: `dp-badge dp-badge--${tone}` }, label);
}

export const btn = (label, onClick, variant = 'primary', attrs = {}) => h('button', { type: 'button', class: `dp-btn dp-btn--${variant}`, onClick, ...attrs }, label);

// Runs an async action with the button disabled; shows the API's error message on failure.
export async function busy(button, fn) {
  const was = button?.disabled;
  if (button) button.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message, 'warn'); }
  finally { if (button) button.disabled = was; }
}

let fieldSeq = 0;
export function field(label, input, hint) {
  const id = input.id || (input.id = `f${++fieldSeq}`);
  return h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: id }, label), input, hint ? h('div', { class: 'dp-hint' }, hint) : null);
}
export const input = (attrs = {}) => h('input', { class: 'dp-input', ...attrs });
export const select = (options, attrs = {}) => h('select', { class: 'select', ...attrs }, options.map(([value, label]) => h('option', { value, selected: attrs.value === value }, label)));

export function panel(title, { subtitle, action } = {}, ...children) {
  return h('section', { class: 'dp-panel' },
    title || action ? h('div', { class: 'dp-panel-head' }, h('div', null, title ? h('h2', { class: 'dp-panel-title' }, title) : null, subtitle ? h('p', { class: 'dp-panel-sub' }, subtitle) : null), action || null) : null,
    ...children);
}

// YouTube and Vimeo links play in their embedded players; anything else is treated as a direct video file.
export function videoEmbed(url, title, emptyText = 'No demo video yet. Edit the exercise to add a video link.') {
  if (!url) return h('div', { class: 'video-frame row', style: 'justify-content:center;text-align:center;padding:24px' }, h('span', { class: 'muted' }, emptyText));
  let u; try { u = new URL(url); } catch { return h('div', { class: 'muted' }, 'This video link is not valid.'); }
  const yt = u.hostname.includes('youtu') ? (u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || u.pathname.split('/').pop()) : null;
  const vimeo = u.hostname.includes('vimeo.com') ? u.pathname.split('/').filter(Boolean).pop() : null;
  const src = yt ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?rel=0` : vimeo ? `https://player.vimeo.com/video/${encodeURIComponent(vimeo)}` : null;
  return h('div', { class: 'video-frame' }, src
    ? h('iframe', { src, title: `${title} demo video`, allow: 'autoplay; fullscreen; picture-in-picture', allowfullscreen: true })
    : h('video', { src: url, controls: true, playsinline: true, preload: 'metadata' }));
}

export function playIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M5 3.5v9l7-4.5z'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.6');
  svg.append(p); svg.style.color = 'var(--steel)';
  return svg;
}
