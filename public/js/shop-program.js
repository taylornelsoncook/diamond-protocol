import { h, fill, money } from './ui.js';

// One program's sales page (/shop/<id>): what it is, every week, the coach, the price and the free trial. Buying happens
// in the parent portal with the family card (sign up first), so every buyer has a proven email and an account.
const root = document.getElementById('root');
const id = decodeURIComponent(location.pathname.split('/').pop());
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function boot() {
  const res = await fetch(`/portal/api/public/shop/${encodeURIComponent(id)}`);
  const d = await res.json().catch(() => null);
  if (!res.ok || !d) return fill(root, h('main', { class: 'p-wrap' }, h('p', { class: 'warn-text' }, res.status === 404 ? 'That program isn\'t for sale right now.' : 'The page couldn\'t load. Refresh to try again.'), h('p', null, h('a', { href: '/shop' }, 'All programs and courses'))));
  document.title = `${d.program.title} · ${d.business_name}`;
  render(d);
}

function paragraphs(text) { return String(text ?? '').split(/\n{2,}/).map((t) => t.trim()).filter(Boolean).map((t) => h('p', { style: 'margin:0 0 10px' }, t)); }

function render(d) {
  const p = d.program, trial = p.trial_days > 0;
  const total = p.price_cents + (p.fee_cents ?? 0);
  const buyNow = `/client?buy=program:${encodeURIComponent(p.id)}`;
  const newFamily = d.signup_open ? `/join?buy=program:${encodeURIComponent(p.id)}` : '/start';
  const cta = h('div', { class: 'row wrap', style: 'gap:8px' },
    h('a', { class: 'dp-btn dp-btn--primary', href: newFamily }, d.signup_open ? (trial ? `Start the free ${p.trial_days}-day trial` : 'Sign up and buy') : 'Ask about it'),
    h('a', { class: 'dp-btn dp-btn--secondary', href: buyNow }, trial ? 'I have an account: start' : 'I have an account: buy'));
  const includes = [
    `${plural(p.workouts, 'workout')} over ${plural(p.weeks, 'week')}${p.per_week ? `, ${p.per_week} a week` : ''}`,
    p.videos ? `Demo videos on ${p.videos === p.exercises ? 'every exercise' : `${p.videos} of ${plural(p.exercises, 'exercise')}`}` : null,
    p.cues ? `The coach's voice cue on ${p.cues === p.exercises ? 'every exercise' : plural(p.cues, 'exercise')}` : null,
    'Every set logged in the athlete\'s own app, with a rest timer and the weights worked out from their numbers',
    'Swaps for the gear they have at home, and a plan that moves with them when a week is missed',
    'A note from the coach every week, and form checks answered by a coach',
  ].filter(Boolean);
  const weeks = p.weeks_outline.filter((w) => w.workouts.length);
  const coach = p.coach;
  fill(root, h('main', { class: 'p-wrap' },
    h('a', { href: '/shop', class: 'small muted' }, '← All programs and courses'),
    h('img', { src: '/brand/logo.png', alt: `${d.business_name}. Built under pressure.`, style: 'width:140px;align-self:center' }),
    h('section', { class: 'dp-panel stack' },
      h('span', { class: 'small muted', style: 'text-transform:uppercase;letter-spacing:.04em' }, 'Training program'),
      h('h1', { class: 'p-title', style: 'margin:0' }, p.title),
      h('span', { class: 'small muted' }, [plural(p.weeks, 'week'), p.per_week ? `${p.per_week} ${p.per_week === 1 ? 'workout' : 'workouts'} a week` : null, p.level].filter(Boolean).join(' · ')),
      p.description ? h('p', { style: 'margin:0' }, p.description) : null,
      h('div', { class: 'row wrap', style: 'align-items:baseline;gap:10px' },
        h('span', { class: 'p-title', style: 'margin:0;font-size:32px' }, money(p.price_cents)),
        h('span', { class: 'small muted' }, trial ? `after a free ${p.trial_days}-day trial` : 'once, for the whole program'),
        trial ? h('span', { class: 'dp-badge dp-badge--good' }, `Free for ${p.trial_days} days`) : null),
      p.fee_cents ? h('p', { class: 'small muted', style: 'margin:0' }, `${money(total)} in all with the ${(d.fee_label ?? 'card processing fee').toLowerCase()} (${money(p.fee_cents)}).`) : null,
      cta),
    p.pitch ? h('section', { class: 'dp-panel' }, h('h2', { class: 'dp-panel-title' }, 'About this program'), ...paragraphs(p.pitch)) : null,
    h('section', { class: 'dp-panel' }, h('h2', { class: 'dp-panel-title' }, 'What you get'),
      h('ul', { style: 'margin:8px 0 0;padding-left:20px' }, includes.map((t) => h('li', { style: 'margin-bottom:6px' }, t)))),
    coach ? h('section', { class: 'dp-panel' }, h('h2', { class: 'dp-panel-title' }, `How ${coach.name.split(' ')[0]} trains`),
      h('div', { class: 'row wrap', style: 'align-items:flex-start;gap:14px' },
        coach.photo_url ? h('img', { src: coach.photo_url, alt: coach.name, style: 'width:96px;height:96px;border-radius:50%;object-fit:cover;flex:none' }) : null,
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, coach.name), coach.title ? h('span', { class: 'small muted' }, coach.title) : null,
          coach.bio ? h('div', { style: 'margin-top:6px' }, ...paragraphs(coach.bio)) : null))) : null,
    weeks.length ? h('section', { class: 'dp-panel' }, h('h2', { class: 'dp-panel-title' }, 'Week by week'),
      ...weeks.map((w) => h('details', { open: w.week === 1 ? '' : null }, h('summary', { class: 'small', style: 'cursor:pointer;min-height:40px;display:flex;align-items:center;gap:8px' }, h('span', { class: 'strong' }, `Week ${w.week}`), w.phase ? h('span', { class: 'dp-badge dp-badge--neutral' }, w.phase) : null, h('span', { class: 'muted' }, plural(w.workouts.length, 'workout'))),
        h('ul', { class: 'small', style: 'margin:4px 0 8px;padding-left:20px' }, w.workouts.map((t) => h('li', null, t)))))) : null,
    h('section', { class: 'dp-panel' }, h('h2', { class: 'dp-panel-title' }, 'How it works'),
      h('ol', { style: 'margin:8px 0 0;padding-left:20px' },
        h('li', null, 'A parent (or an adult athlete) signs up with an email, adds the athlete and a card.'),
        trial ? h('li', null, `The program opens in the athlete's app at once, free for ${p.trial_days} days. End the trial any time on the portal's Programs tab and nothing is charged.`) : h('li', null, 'Buy it on the portal\'s Programs tab, and the program opens in the athlete\'s app at once.'),
        trial ? h('li', null, `On day ${p.trial_days + 1} the card is charged ${money(total)} once, and the program is theirs for good.`) : h('li', null, `${money(total)} is charged once. No membership needed.`),
        h('li', null, 'The athlete answers a few questions in the app (where they train, what gear they have) so the first workout already fits.')),
      cta),
    h('p', { class: 'small muted', style: 'text-align:center' }, 'Questions? ', h('a', { href: '/start' }, 'Ask us'), '.')));
}
boot();
