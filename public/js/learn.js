import { h, fill, videoEmbed } from './ui.js';

// Coach's education, public (/learn): the stand-alone coach's education lessons the owner published, for anyone. A lesson
// opens on the same page (/learn#<lesson id>), so a link to one can be shared.
const root = document.getElementById('root');
let list = null;

async function load(path) {
  const res = await fetch(path);
  const d = await res.json().catch(() => null);
  return res.ok && d ? d : null;
}
const page = (...kids) => fill(root, h('main', { class: 'p-wrap' }, h('a', { href: '/learn', style: 'align-self:center' }, h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.', style: 'width:160px' })), ...kids,
  h('p', { class: 'small muted', style: 'text-align:center' }, 'Want to train with us? ', h('a', { href: '/start' }, 'Ask about training'), '.')));

async function showList() {
  list ??= await load('/portal/api/public/learn');
  if (!list) return page(h('p', { class: 'warn-text' }, 'This page couldn\'t load. Refresh to try again.'));
  document.title = `Coach's education · ${list.business_name}`;
  page(h('h1', { class: 'p-title', style: 'text-align:center' }, 'Coach\'s education'),
    h('p', { class: 'muted', style: 'text-align:center;margin-top:0' }, `What our coaches read, watch and teach, from ${list.business_name}.`),
    list.data.length ? list.data.map((l) => h('a', { class: 'dp-panel stack-tight', href: `#${l.id}`, style: 'text-decoration:none;color:inherit' },
      h('h2', { class: 'dp-panel-title', style: 'margin:0' }, l.title), l.summary ? h('span', { class: 'muted' }, l.summary) : null,
      h('span', { class: 'small muted' }, [l.minutes ? `${l.minutes} min` : null, l.has_video ? 'Video' : null, new Date(l.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })].filter(Boolean).join(' · '))))
      : h('p', { class: 'muted', style: 'text-align:center' }, 'Nothing here yet. Check back soon.'));
}
async function showLesson(id) {
  const l = await load(`/portal/api/public/learn/${encodeURIComponent(id)}`);
  if (!l) return page(h('p', { class: 'warn-text' }, 'That lesson isn\'t available. ', h('a', { href: '#' }, 'See everything')));
  document.title = `${l.title} · ${l.business_name}`;
  page(h('section', { class: 'dp-panel stack' },
    h('a', { href: '#', class: 'small' }, '‹ Coach\'s education'),
    h('h1', { class: 'p-title', style: 'margin:0' }, l.title), l.summary ? h('p', { class: 'muted', style: 'margin:0' }, l.summary) : null,
    l.video_url ? videoEmbed(l.video_url, l.title) : null,
    h('div', { class: 'eg-body' }, String(l.body ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => h('p', { style: 'margin:0 0 14px;line-height:1.55' }, p)))));
  window.scrollTo(0, 0);
}
const route = () => { const id = location.hash.slice(1); return id ? showLesson(id) : showList(); };
addEventListener('hashchange', route);
route();
