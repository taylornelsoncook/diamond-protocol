import { h, fill } from './ui.js';

// /terms and /privacy: the business's own wording, as written in Hours & settings.
const kind = location.pathname.startsWith('/privacy') ? 'privacy' : 'terms';
const root = document.getElementById('root');
const TITLE = { terms: 'Terms of service', privacy: 'Privacy policy' };

async function load() {
  const d = await (await fetch('/portal/api/public/legal')).json();
  const doc = d[kind];
  document.title = `${TITLE[kind]} · ${d.business_name}`;
  fill(root, h('main', { class: 'p-wrap' },
    h('div', { class: 'p-top' }, h('img', { src: '/brand/mark.png', alt: '' }), h('div', { class: 'stack-tight grow' }, h('div', { class: 'p-title' }, TITLE[kind]), h('div', { class: 'small muted' }, d.business_name))),
    h('article', { class: 'dp-panel stack' },
      doc.published ? h('p', { class: 'small muted' }, `Version ${doc.version}${doc.updated ? `, updated ${new Date(`${doc.updated}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}` : ''}`) : h('p', { class: 'warn-text' }, `The ${TITLE[kind].toLowerCase()} hasn't been published yet.`),
      ...String(doc.published ? doc.text : '').split(/\n{2,}/).map((para) => h('p', { style: 'white-space:pre-wrap;margin:0' }, para))),
    h('p', { class: 'small' }, h('a', { href: kind === 'terms' ? '/privacy' : '/terms' }, kind === 'terms' ? 'Privacy policy' : 'Terms of service'), ' · ', h('a', { href: '/parent' }, 'Parent sign-in')),
    d.business_address ? h('p', { class: 'small muted', style: 'white-space:pre-line' }, `${d.business_name}\n${d.business_address}`) : null));
}
load();
