import { h, fill, money } from './ui.js';

// Public "Book now" page. Put the link on the website, Instagram and Google, or embed it with /embed.js.
// It shows what's coming up with open spots; booking happens in the parent portal (or after signing up).
const root = document.getElementById('root');
const embed = new URLSearchParams(location.search).has('embed');
const target = embed ? { target: '_blank', rel: 'noopener' } : {};
const KIND = { group: 'Group class', clinic: 'Clinic', camp: 'Camp' };

async function boot() {
  const res = await fetch('/portal/api/public/schedule');
  const d = await res.json().catch(() => null);
  if (!res.ok || !d) return fill(root, h('main', { class: 'p-wrap' }, h('p', { class: 'warn-text' }, 'The schedule couldn\'t load. Refresh to try again.')));
  document.title = `Book a session · ${d.business_name}`;
  render(d);
}

function render(d) {
  const zone = d.timezone;
  const fmt = (iso, o) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...o }).format(new Date(iso));
  const day = (iso) => fmt(iso, { weekday: 'long', month: 'short', day: 'numeric' });
  const time = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
  const newFamily = d.signup_open ? '/join' : '/start';
  const link = (href, label, variant = 'primary') => h('a', { class: `dp-btn dp-btn--${variant}`, href, ...target }, label);
  const ages = (s) => (s.age_min != null && s.age_max != null ? `Ages ${s.age_min}–${s.age_max}` : s.age_min != null ? `Ages ${s.age_min}+` : s.age_max != null ? `Up to age ${s.age_max}` : null);
  const price = (s) => (s.registration_cents != null && s.drop_in_cents == null ? `${money(s.registration_cents)} to register` : s.drop_in_cents != null ? `${money(s.drop_in_cents)} drop-in` : null);

  const age = h('select', { class: 'select', 'aria-label': 'Athlete\'s age', style: 'width:auto' }, h('option', { value: '' }, 'Any age'), ...Array.from({ length: 15 }, (_, i) => h('option', { value: String(i + 5) }, `Age ${i + 5}`)));
  const list = h('div', { class: 'stack' });
  const drawClasses = () => {
    const a = Number(age.value);
    const rows = d.classes.filter((s) => !a || ((s.age_min == null || a >= s.age_min) && (s.age_max == null || a <= s.age_max)));
    if (!rows.length) return fill(list, h('p', { class: 'muted' }, a ? `Nothing for age ${a} in the next 2 weeks. Ask us about private training.` : 'No classes in the next 2 weeks yet. Ask us about private training.'));
    let last = '';
    fill(list, ...rows.map((s) => {
      const dd = day(s.starts_at), head = dd !== last ? h('div', { class: 'p-day' }, (last = dd)) : null;
      return [head, h('div', { class: 'p-row' },
        h('div', { class: 'p-time' }, time(s.starts_at)),
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, s.name),
          h('span', { class: 'small muted' }, [KIND[s.kind], s.location_name, ages(s), price(s)].filter(Boolean).join(' · ')),
          h('span', { class: `small ${s.spots_left ? (s.spots_left <= 3 ? 'warn-text' : 'muted') : 'warn-text'}` }, s.spots_left ? `${s.spots_left} ${s.spots_left === 1 ? 'spot' : 'spots'} left` : 'Full: join the waitlist')),
        link('/parent?book=classes', s.spots_left ? 'Book' : 'Waitlist', s.spots_left ? 'primary' : 'secondary'))];
    }));
  };
  age.addEventListener('change', () => { drawClasses(); sendHeight(); });

  const evalPanel = d.evaluations.length ? h('section', { class: 'dp-panel stack' },
    h('h2', { class: 'dp-panel-title' }, 'New? Start with an evaluation'),
    h('p', { class: 'muted', style: 'margin:0' }, `We test speed, power and movement, then build a plan for your athlete${d.evaluations[0].price_cents ? `. ${money(d.evaluations[0].price_cents)}` : ''}.`),
    h('div', { class: 'row wrap', style: 'gap:8px' }, d.evaluations.slice(0, 6).map((e) => h('a', { class: 'p-chip', style: 'display:inline-flex;align-items:center;text-decoration:none', href: '/parent?book=evaluation', ...target }, `${fmt(e.starts_at, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time(e.starts_at)}`))),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Pick a time after you sign in.')) : null;

  fill(root, h('main', { class: 'p-wrap', style: embed ? 'padding:12px 12px 16px' : null },
    embed ? null : h('img', { src: '/brand/logo.png', alt: `${d.business_name}. Built under pressure.`, style: 'width:160px;align-self:center' }),
    h('h1', { class: 'p-title', style: 'text-align:center' }, 'Book a session'),
    !d.open ? h('p', { class: 'muted', style: 'text-align:center' }, `Online booking isn't open right now. `, h('a', { href: '/start', ...target }, 'Ask about training'), ' and we\'ll get back to you.') : [
      h('div', { class: 'row wrap', style: 'gap:8px;justify-content:center' }, link('/parent?book=classes', 'I have an account: sign in'), link(newFamily, d.signup_open ? 'New family? Sign up' : 'New? Ask about training', 'secondary')),
      evalPanel,
      h('section', { class: 'dp-panel stack' },
        h('div', { class: 'row wrap' }, h('h2', { class: 'dp-panel-title grow' }, 'Next 2 weeks'), age),
        list),
      h('p', { class: 'small muted', style: 'text-align:center' }, 'Questions? ', h('a', { href: '/start', ...target }, 'Ask about training'), '.')]));
  if (d.open) drawClasses();
  sendHeight();
}

// Inside a website (embed.js), tell the page how tall to make the frame.
function sendHeight() {
  if (!embed || window.parent === window) return;
  requestAnimationFrame(() => window.parent.postMessage({ dpBookHeight: document.documentElement.scrollHeight }, '*'));
}
if (embed) { document.documentElement.style.background = 'transparent'; new ResizeObserver(sendHeight).observe(document.body); }
boot();
