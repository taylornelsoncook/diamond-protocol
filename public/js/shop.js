import { h, fill, money } from './ui.js';

// Public store: programs and courses for sale. Put the link on the website and Instagram for out-of-town athletes.
// Buying happens in the parent portal with the family card, so new families sign up first (/join), then land on it.
const root = document.getElementById('root');

async function boot() {
  const res = await fetch('/portal/api/public/shop');
  const d = await res.json().catch(() => null);
  if (!res.ok || !d) return fill(root, h('main', { class: 'p-wrap' }, h('p', { class: 'warn-text' }, 'The store couldn\'t load. Refresh to try again.')));
  document.title = `Programs and courses · ${d.business_name}`;
  render(d);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function facts(x) {
  if (x.kind === 'program') return [`${plural(x.weeks, 'week')}`, x.per_week ? `${x.per_week} ${x.per_week === 1 ? 'workout' : 'workouts'} a week` : null, x.level].filter(Boolean).join(' · ');
  return [plural(x.lessons, 'lesson'), x.minutes ? `about ${x.minutes} minutes in all` : null, x.quizzes ? `${plural(x.quizzes, 'quiz')}` : null].filter(Boolean).join(' · ');
}

function render(d) {
  const newFamily = (x) => (d.signup_open ? `/join?buy=${x.kind}:${x.id}` : '/start');
  const card = (x) => h('section', { class: 'dp-panel stack' },
    h('div', { class: 'row wrap', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack-tight' },
        h('span', { class: 'small muted', style: 'text-transform:uppercase;letter-spacing:.04em' }, x.kind === 'program' ? 'Training program' : 'Course'),
        h('h2', { class: 'dp-panel-title', style: 'margin:0' }, x.title),
        h('span', { class: 'small muted' }, facts(x))),
      h('span', { class: 'p-title', style: 'margin:0;font-size:28px' }, money(x.price_cents))),
    x.description ? h('p', { style: 'margin:0' }, x.description) : null,
    x.outline.length ? h('details', null, h('summary', { class: 'small', style: 'cursor:pointer' }, x.kind === 'program' ? 'What week 1 looks like' : 'What\'s inside'),
      h('ul', { class: 'small muted', style: 'margin:8px 0 0;padding-left:20px' }, x.outline.map((t) => h('li', null, t)))) : null,
    h('p', { class: 'small muted', style: 'margin:0' }, x.kind === 'program' ? 'Your athlete follows it in their own app, with demo videos for every exercise.' : 'Your athlete reads and watches it in their own app.'),
    h('div', { class: 'row wrap', style: 'gap:8px' },
      h('a', { class: 'dp-btn dp-btn--primary', href: `/parent?buy=${x.kind}:${x.id}` }, 'I have an account: buy'),
      h('a', { class: 'dp-btn dp-btn--secondary', href: newFamily(x) }, d.signup_open ? 'New? Sign up and buy' : 'New? Ask about it')));

  fill(root, h('main', { class: 'p-wrap' },
    h('img', { src: '/brand/logo.png', alt: `${d.business_name}. Built under pressure.`, style: 'width:160px;align-self:center' }),
    h('h1', { class: 'p-title', style: 'text-align:center' }, 'Train with us from anywhere'),
    h('p', { class: 'muted', style: 'text-align:center;margin-top:0' }, 'Programs and courses from our coaches, in your athlete\'s app. Pay once; no membership needed.'),
    d.items.length ? d.items.map(card) : h('p', { class: 'muted', style: 'text-align:center' }, 'Nothing for sale right now. ', h('a', { href: '/start' }, 'Ask about training'), ' and we\'ll get back to you.'),
    h('p', { class: 'small muted', style: 'text-align:center' }, 'Questions? ', h('a', { href: '/start' }, 'Ask us'), '.')));
}
boot();
