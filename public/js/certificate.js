import { h, fill } from './ui.js';

// A course certificate: /certificate#<token>, from the email or the Education tab. Prints on one landscape page.
const root = document.getElementById('root');
const tok = location.hash.slice(1);
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

async function load() {
  const r = tok ? await fetch(`/portal/api/public/certificates/${encodeURIComponent(tok)}`) : null;
  if (!r?.ok) return fill(root, h('div', { class: 'dp-panel', style: 'margin:48px auto;max-width:480px;text-align:center' }, h('p', { style: 'margin:0' }, 'This certificate link isn\'t right. Open it again from the email or the Education tab.')));
  const c = await r.json();
  document.title = `${c.name}: ${c.course} · ${c.business_name}`;
  fill(root,
    h('article', { class: 'ct' },
      h('img', { class: 'ct-logo', src: '/brand/logo.png', alt: c.business_name }),
      h('p', { class: 'ct-kicker' }, 'Certificate of completion'),
      h('p', { class: 'ct-small' }, 'This certifies that'),
      h('h1', { class: 'ct-name' }, c.name),
      h('p', { class: 'ct-small' }, `finished all ${c.lessons} ${c.lessons === 1 ? 'lesson' : 'lessons'} of`),
      h('h2', { class: 'ct-course' }, c.course),
      c.description ? h('p', { class: 'ct-desc' }, c.description) : null,
      h('div', { class: 'ct-foot' }, h('span', null, longDate(c.issued_on)), h('span', null, c.business_name))),
    h('div', { class: 'ct-actions' }, h('button', { type: 'button', class: 'dp-btn dp-btn--primary', onClick: () => window.print() }, 'Print'),
      navigator.share ? h('button', { type: 'button', class: 'dp-btn dp-btn--secondary', onClick: () => navigator.share({ title: document.title, url: location.href }).catch(() => {}) }, 'Share') : null));
}
load();
