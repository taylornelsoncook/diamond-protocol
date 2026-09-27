import { h, fill } from './ui.js';
import { qrSvg } from './qr.js';

// Printable door poster: parents scan the QR code with their phone camera to check their athlete in.
const code = new URLSearchParams(location.search).get('code') ?? '';
const root = document.getElementById('root');

async function load() {
  const r = await fetch(`/here-api/${encodeURIComponent(code)}`);
  if (!r.ok) return fill(root, h('main', { class: 'p-wrap' }, h('div', { class: 'dp-panel' }, h('h1', { class: 'p-title' }, 'Poster not found'), h('p', { class: 'muted' }, 'Open the poster again from Schedule → Hours & settings.'))));
  const p = await r.json();
  const url = `${location.origin}/here/${code}`;
  const qr = h('div', { style: 'width:min(70vw,420px);align-self:center;background:#fff;padding:8px;border-radius:8px' });
  qr.innerHTML = qrSvg(url, { label: `Check-in code for ${p.location_name}` });
  document.title = `Check-in poster · ${p.location_name}`;
  fill(root, h('main', { class: 'p-wrap poster', style: 'text-align:center;gap:24px' },
    h('img', { src: '/brand/logo.png', alt: p.business_name, style: 'width:180px;align-self:center' }),
    h('h1', { class: 'p-title', style: 'font-size:44px' }, 'Scan to check in'),
    h('p', { style: 'font-size:20px;margin:0' }, `Parents: point your phone camera here, sign in, and tap your athlete. ${p.location_name}.`),
    qr,
    h('p', { class: 'small muted', style: 'margin:0' }, url),
    h('button', { type: 'button', class: 'dp-btn dp-btn--primary no-print', onClick: () => window.print() }, 'Print poster')));
}
load();
