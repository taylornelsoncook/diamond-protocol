import { h, fill, toast, money, busy, btn, field, input, select, panel, videoEmbed } from './ui.js';
import { sparkline, fmtResult, fmtDate as fmtDay } from './charts.js';
import { createEngage, ENGAGE_TABS, tabIcon, engageDots } from './engage-view.js';
import { importForm, importsList, dataSummary } from './dataimport-ui.js';
import { wearablesBlock, wearableReturnNotice } from './wearables-ui.js';
import { formChecksBlock } from './formchecks-ui.js';
wearableReturnNotice();

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(`/portal/api/${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !['login', 'verify'].includes(path)) { state.me = null; render(); }
  if (!res.ok) { const e = new Error(data.error?.message || 'Something went wrong. Try again.'); e.status = res.status; e.code = data.error?.code; e.details = data.error?.details; throw e; }
  return data;
}
const get = (p) => api('GET', p), post = (p, b = {}) => api('POST', p, b);

const state = { me: null, tab: 'home', athleteId: null, homeTab: 'overview' };
const root = document.getElementById('root');
const athlete = () => state.me.athletes.find((a) => a.id === state.athleteId) ?? state.me.athletes[0];
const fmt = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: state.me?.timezone, ...opts }).format(new Date(iso));
const dayLabel = (iso) => fmt(iso, { weekday: 'long', month: 'short', day: 'numeric' });
const timeLabel = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
const localDay = (iso) => fmt(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });
// "Today", "Tomorrow" or "Wed", in the business time zone.
function relDay(iso) {
  const d = localDay(iso), t = localDay(new Date().toISOString()), tm = localDay(new Date(Date.now() + 86400000).toISOString());
  return d === t ? 'Today' : d === tm ? 'Tomorrow' : fmt(iso, { weekday: 'short' });
}
const range = (a, b) => `${fmt(a, { weekday: 'short', month: 'short', day: 'numeric' })} · ${timeLabel(a)}–${timeLabel(b)}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KIND = { group: 'Group class', clinic: 'Clinic', camp: 'Camp', private: 'Private session', evaluation: 'Evaluation', team: 'Team session' };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } } };
const cardName = (c) => `${(c.brand || 'Card').replace(/^./, (x) => x.toUpperCase())} ending ${c.last4}`;
const expText = (exp) => (exp ? `${exp.slice(5)}/${exp.slice(2, 4)}` : null);
const go = (tab, opts = {}) => { Object.assign(state, opts, { tab }); render(); };
const copy = async (text, what = 'Copied.') => { try { await navigator.clipboard.writeText(text); toast(what); } catch { prompt('Copy this:', text); } };

async function boot() {
  try { state.me = await get('me'); state.athleteId ??= state.me.athletes[0]?.id; } catch { state.me = null; }
  const q = new URLSearchParams(location.search);
  // Signed in from the check-in QR code on the door: go back to it.
  const back = q.get('checkin');
  if (state.me && back && /^[\w-]+$/.test(back)) { location.replace(`/here/${back}`); return; }
  // From the public Book now page: open the Book tab on classes or evaluations.
  const book = q.get('book');
  if (state.me && ['classes', 'private', 'evaluation'].includes(book)) { state.tab = 'book'; state.bookMode = book; history.replaceState(null, '', '/parent'); }
  // Home-screen shortcuts (parent.webmanifest) open a tab.
  const tab = q.get('tab');
  if (state.me && ['home', 'book', 'progress', 'programs', 'family'].includes(tab)) { state.tab = tab; history.replaceState(null, '', '/parent'); }
  // From the store page (/shop): open Programs on what they came to buy. New families add a card first.
  const buy = q.get('buy');
  const buying = state.me && /^(program|course):[\w-]+$/.test(buy ?? '');
  if (buying) state.buy = buy;
  if (state.me && q.has('welcome')) {
    state.tab = 'family'; history.replaceState(null, '', '/parent');
    const claim = q.has('claim') ? ' We\'ll check the Athlete ID you gave with your coach.' : '';
    setTimeout(() => toast(buying ? `Welcome! Add a card here, then buy it on the Programs tab.${claim}` : `Welcome! Sign the waiver and add a card, then you can book.${claim}`), 300);
  } else if (buying) { state.tab = 'programs'; history.replaceState(null, '', '/parent'); }
  render();
}
async function refresh({ keepScroll = true } = {}) { state.me = await get('me'); render({ keepScroll }); }

// ---------- Shell: tabs, offline bar, fresh data after time away ----------
const offline = h('div', { class: 'p-offline', role: 'status', hidden: navigator.onLine }, 'No connection. Showing what was last loaded.');
document.body.append(offline);
addEventListener('online', () => { offline.hidden = true; if (state.me) refresh().catch(() => {}); });
addEventListener('offline', () => { offline.hidden = false; });
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (state.me && hiddenAt && Date.now() - hiddenAt > 5 * 60000 && !document.getElementById('dialog').open) refresh().catch(() => {});   // back after 5 minutes: fresh data
});
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; document.getElementById('p-install-slot')?.replaceChildren(installCard()); });

function render({ keepScroll = false } = {}) {
  if (!state.me) return renderSignIn();
  const y = window.scrollY;
  const views = { home: viewHome, book: viewBook, progress: viewProgress, programs: viewPrograms, family: viewFamily };
  const main = h('main', { class: 'p-wrap' });
  fill(root, main, tabBar());
  // Locked out over a declined membership payment: only the Family tab (card and payments) works until it's paid.
  if (state.me.payment_lock && state.tab !== 'family') {
    fill(main, top('Payment needed'), h('section', { class: 'dp-panel stack', role: 'alert' },
      h('p', { class: 'warn-text', style: 'margin:0' }, state.me.payment_lock.message),
      h('div', { class: 'row wrap' }, btn('Update card or pay', () => go('family', { focus: 'card' }), 'primary'))));
    if (!keepScroll) window.scrollTo(0, 0);
    return;
  }
  views[state.tab](main).then(() => { if (keepScroll) window.scrollTo(0, y); }).catch((e) => fill(main, h('p', { class: 'warn-text' }, e.message)));
  if (!keepScroll) window.scrollTo(0, 0);
}

function top(title) {
  return h('div', { class: 'p-top' }, h('img', { src: '/brand/mark.png', alt: '' }), h('div', { class: 'stack-tight grow' }, h('div', { class: 'p-title' }, title), h('div', { class: 'small muted' }, state.me.family.name)));
}

function icon(d) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('aria-hidden', 'true');
  for (const path of d) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', path); svg.append(p); }
  return svg;
}
function tabBar() {
  const tabs = [['home', 'Home', ['M3 11l9-7 9 7', 'M5 10v10h14V10']], ['book', 'Book', ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4']], ['progress', 'Progress', ['M4 19l5-6 4 3 7-9', 'M4 19h16']], ['programs', 'Programs', ['M4 5h16', 'M4 12h16', 'M4 19h10']], ['family', 'Family', ['M8 11a3 3 0 100-6 3 3 0 000 6z', 'M16 11a3 3 0 100-6 3 3 0 000 6z', 'M2 20c0-3 3-5 6-5s6 2 6 5', 'M14 15c3 0 8 1 8 5']]];
  return h('nav', { class: 'p-tabs', 'aria-label': 'Sections' }, tabs.map(([k, label, d]) => h('button', { type: 'button', class: 'p-tab', 'aria-current': state.tab === k ? 'page' : null, onClick: () => { state.tab = k; render(); } }, icon(d), label)));
}

function athleteChips(onChange) {
  if (state.me.athletes.length < 2) return null;
  const wrap = h('div', { class: 'p-chips', role: 'group', 'aria-label': 'Athlete' });
  const draw = () => fill(wrap, state.me.athletes.map((a) => h('button', { type: 'button', class: 'p-chip', 'aria-pressed': String(a.id === athlete().id), onClick: () => { state.athleteId = a.id; draw(); onChange(); } }, a.first_name)));
  draw();
  return wrap;
}

// One dialog at a time (the page's <dialog>). Focus starts on Close, so a stray tap never cancels anything.
function openDialog(title, body, actions = []) {
  const d = document.getElementById('dialog');
  const close = btn('Close', () => d.close(), 'ghost');
  fill(d, h('div', { class: 'p-dialog stack' }, h('h2', { class: 'p-dialog-title' }, title), ...[body].flat().filter(Boolean), h('div', { class: 'row wrap p-dialog-actions' }, ...actions.filter(Boolean), close)));
  d.addEventListener('close', () => fill(d), { once: true });
  if (!d.open) d.showModal();
  close.focus();
  return d;
}
const closeDialog = () => { const d = document.getElementById('dialog'); if (d.open) d.close(); };

// Setup nudges shown until done: terms, waiver, card (missing, expired, expiring) and a declined payment.
function banners({ card = true } = {}) {
  const out = [], f = state.me.family, fin = state.me.to_finish ?? [];
  const b = (text, label, fn) => h('div', { class: 'p-banner' }, h('span', { class: 'grow' }, text), btn(label, fn, 'outline'));
  if (!state.me.agreements?.ok) out.push(b('Please review and accept our updated terms.', 'Review', () => go('family')));
  if (!f.waiver.signed) out.push(b('Sign the waiver to start booking.', 'Sign', () => go('family', { focus: 'waiver' })));
  if (card && !f.card.on_file) out.push(b('Add a card to pay for sessions, packs and camps.', 'Add card', () => go('family', { focus: 'card' })));
  if (card && f.card.expired) out.push(b(`Your ${cardName(f.card)} expired${f.card.exp ? ` (${expText(f.card.exp)})` : ''}. Replace it so payments keep working.`, 'Update card', () => go('family', { focus: 'card' })));
  else if (card && f.card.expiring) out.push(b(`Your ${cardName(f.card)} expires at the end of ${expText(f.card.exp)}. Replace it before then.`, 'Update card', () => go('family', { focus: 'card' })));
  const declined = fin.find((x) => x.key === 'declined');
  if (declined) out.push(b(`${declined.text}. Try again or update your card.`, 'Fix it', () => go('family', { focus: 'card' })));
  return out;
}

// Missing or declined card while paying: say what happened, nothing was charged, and go fix it (then come back).
function cardProblem(message, back) {
  const f = state.me.family;
  openDialog(f.card.on_file ? 'The card didn\'t go through' : 'Add a card first', [
    h('p', null, message),
    f.card.on_file ? h('p', { class: 'small muted' }, 'Nothing was charged. Update the card on the Family tab and try again.') : h('p', { class: 'small muted' }, 'Your card is saved securely by Stripe and used for this family\'s sessions, packs and camps.')
  ], [btn(f.card.on_file ? 'Update card' : 'Add a card', () => { closeDialog(); state.returnTo = back; go('family', { focus: 'card' }); }, 'primary')]);
}

// When sessions aren't covered, offer to pay once with the saved card, or point to packs.
async function offerCard(cents, reason, back = 'book') {
  const card = state.me.family.card;
  if (!card.on_file || card.expired) { cardProblem(reason, back); return false; }
  if (!cents) { toast(`${reason} Buy a pack under Programs.`, 'warn'); return false; }
  return confirm(`${reason}\n\nPay ${money(cents)} with the ${cardName(card)} instead?`);
}

// ---------- Sign in ----------
function renderSignIn() {
  const main = h('main', { class: 'p-wrap', style: 'min-height:100vh;justify-content:center' });
  const email = input({ type: 'email', autocomplete: 'email', inputmode: 'email', required: true, value: store.get('dp_parent_email') ?? '' });
  const remember = h('input', { type: 'checkbox', checked: store.get('dp_parent_email') != null });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const send = btn('Email me a sign-in code', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  const stepOne = h('form', { class: 'dp-panel stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(send, async () => {
    try {
      const r = await post('login', { email: email.value });
      store.set('dp_parent_email', remember.checked ? email.value.trim() : null);
      stepTwo(email.value.trim(), r.dev_code);
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.', style: 'width:180px;align-self:center' }),
    h('h1', { class: 'p-title', style: 'text-align:center' }, 'Parent sign-in'),
    h('p', { class: 'muted', style: 'text-align:center' }, 'Use the email your coach has on file. No password needed.'),
    field('Email', email),
    h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, remember, h('span', null, 'Remember my email on this phone')),
    err, send,
    h('details', { class: 'small' }, h('summary', { style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'No email from us?'),
      h('p', { class: 'muted' }, 'Check spam, and that the address matches the one your coach has. Your coach can fix a typo or add your email to your family, then send you a sign-in email.')),
    h('p', { class: 'small muted', style: 'text-align:center;margin:0' }, 'New here? ', h('a', { href: '/join' }, 'Create a family account')));
  fill(root, fill(main, stepOne));
  if (!email.value) email.focus();

  function stepTwo(address, devCode) {
    const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '40', class: 'dp-input p-code', 'aria-label': 'Six-digit code' });
    // Pasting the whole email line ("Your code is 123456") keeps just the code.
    code.addEventListener('input', () => { const m = code.value.match(/\d{6}/) ?? [code.value.replace(/\D/g, '').slice(0, 6)]; if (code.value !== m[0]) code.value = m[0]; });
    const err2 = h('div', { class: 'dp-error', role: 'alert' });
    const goBtn = btn('Sign in', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
    const resend = btn('Send a new code', (e) => busy(e.currentTarget, async () => { try { const r = await post('login', { email: address }); toast('If this email is on file, a new code is on its way.'); if (r.dev_code) stepTwo(address, r.dev_code); else wait(); } catch (x) { err2.textContent = x.message; } }), 'secondary', { disabled: true });
    let timer = null;
    const wait = () => {
      let left = 30; resend.disabled = true; clearInterval(timer);
      const tick = () => { resend.textContent = left > 0 ? `Send a new code (${left}s)` : 'Send a new code'; if (left-- <= 0) { resend.disabled = false; clearInterval(timer); } };
      tick(); timer = setInterval(tick, 1000);
    };
    fill(main, h('form', { class: 'dp-panel stack', onSubmit: (e) => { e.preventDefault(); err2.textContent = ''; busy(goBtn, async () => {
      try { await post('verify', { email: address, code: code.value }); clearInterval(timer); await boot(); } catch (x) { err2.textContent = x.message; }
    }); } },
      h('h1', { class: 'p-title' }, 'Check your email'),
      h('p', { class: 'muted' }, `If ${address} is on file, we sent it a 6-digit code. It expires in 10 minutes.`),
      devCode ? h('p', { class: 'test-banner' }, `Test mode: your code is ${devCode}`) : null,
      code, err2, goBtn, resend,
      btn('Use a different email', () => { clearInterval(timer); renderSignIn(); }, 'ghost')));
    wait();
    code.focus();
  }
}

// ---------- Home: overview, plus each athlete's Accountability, Performance and Education ----------
const engages = new Map();
function engageFor(a) {
  if (!engages.has(a.id)) engages.set(a.id, createEngage({ audience: 'parent',
    api: { get: (p) => get(`athletes/${a.id}/${p}`), post: (p, b) => post(`athletes/${a.id}/${p}`, b ?? {}) },
    onData: (d) => { a.engagement = { ...a.engagement, unread: d.accountability.unread, open_assignments: d.education.assigned.filter((x) => !x.done).length }; drawSubtabs(); } }));
  return engages.get(a.id);
}
let subtabs = null;
function drawSubtabs() {
  if (!subtabs?.isConnected) return;
  const a = athlete(), dots = a ? engageDots(a.engagement) : {};
  fill(subtabs, [['overview', 'Overview'], ...ENGAGE_TABS, ['parents', 'For parents']].map(([k, label]) => h('button', { type: 'button', class: 'p-subtab', 'aria-current': state.homeTab === k ? 'page' : null, onClick: () => { state.homeTab = k; if (k === 'parents') parentReader = null; render(); } },
    label, dots[k] ? [h('span', { class: 'eg-tab-dot', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, k === 'education' ? ' (new reading)' : ' (new message)')] : null)));
  const cur = subtabs.querySelector('[aria-current]');
  if (cur) subtabs.scrollLeft = cur.offsetLeft + cur.offsetWidth - subtabs.clientWidth > 0 ? cur.offsetLeft - 16 : 0;   // keep the chosen tab in view on narrow phones
}
async function viewHome(main) {
  subtabs = h('nav', { class: 'p-subtabs', 'aria-label': 'Home sections' });
  if (state.homeTab === 'parents') return viewParentEd(main);
  if (state.homeTab === 'overview' || !state.me.athletes.length) return viewOverview(main);
  const a = athlete(), eng = engageFor(a);
  const where = h('div', { class: 'eg-view' });
  fill(main, top(ENGAGE_TABS.find(([k]) => k === state.homeTab)[1]), subtabs, athleteChips(() => render()), where);
  drawSubtabs();
  const had = !!eng.data;
  if (!had) { fill(where, h('p', { class: 'muted' }, 'Loading…')); await eng.load(); }
  eng.render(where, state.homeTab);
  if (had) eng.load().then(() => eng.rerender()).catch(() => {});      // show what we have, then refresh
}
// ---------- For parents: short courses the coaches wrote for parents, by athlete age ----------
let parentReader = null;
const openCourse = new Set();
async function viewParentEd(main) {
  const where = h('div', { class: 'eg-view' });
  fill(main, top('For parents'), subtabs, where);
  drawSubtabs();
  if (parentReader) return renderParentReader(where);
  const [{ data }, articles] = await Promise.all([get('parent-courses'), get('parent-articles').then((r) => r.data).catch(() => [])]);
  if (data.length === 1) openCourse.add(data[0].id);
  // Stand-alone reading: parent education, blogs and research, newest first.
  const KIND = { parent: 'For parents', blog: 'Blog', research: 'Research' };
  const reading = articles.length ? h('div', { class: 'dp-panel stack-tight' }, h('span', { class: 'strong' }, 'Latest reading'),
    articles.map((l) => h('button', { type: 'button', class: 'eg-lesson', onClick: () => openParentLesson(l.id) },
      h('span', { class: `eg-lesson-i${l.done ? ' eg-lesson-i--done' : ''}`, 'aria-hidden': 'true' }, l.done ? '✓' : l.has_video ? '▶' : '›'),
      h('span', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, l.title), h('span', { class: 'small muted' }, [KIND[l.category], l.minutes ? `${l.minutes} min` : null, l.done ? 'Read' : null].filter(Boolean).join(' · ')))))) : null;
  fill(where, data.length || articles.length ? [reading, h('p', { class: 'small muted', style: 'margin:0' }, 'Short reads from our coaches for parents, picked for your athletes\' ages.'), data.map((c) => {
    const open = openCourse.has(c.id);
    const list = h('div', { class: 'eg-list', hidden: !open }, c.description ? h('p', { class: 'small muted' }, c.description) : null, c.lessons.map((l) => h('button', { type: 'button', class: 'eg-lesson', onClick: () => openParentLesson(l.id) },
      h('span', { class: `eg-lesson-i${l.done ? ' eg-lesson-i--done' : ''}`, 'aria-hidden': 'true' }, l.done ? '✓' : l.has_video ? '▶' : '›'),
      h('span', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, l.title), h('span', { class: 'small muted' }, [l.minutes ? `${l.minutes} min` : null, l.done ? 'Read' : null].filter(Boolean).join(' · ') || 'Lesson')))));
    return h('div', { class: 'dp-panel eg-course' },
      h('button', { type: 'button', class: 'eg-course-h', 'aria-expanded': String(open), onClick: (ev) => { const now = !openCourse.has(c.id); now ? openCourse.add(c.id) : openCourse.delete(c.id); ev.currentTarget.setAttribute('aria-expanded', String(now)); list.hidden = !now; } },
        h('span', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, c.title), h('span', { class: 'small muted' }, `${c.done} of ${c.total} read${c.complete ? ' · Finished' : ''}`)), h('span', { class: 'eg-chev', 'aria-hidden': 'true' }, '›')),
      list);
  })] : h('div', { class: 'empty' }, 'Nothing here yet. When our coaches post reading for parents, it shows up here.'));
}
async function openParentLesson(id) {
  try { parentReader = await get(`parent-lessons/${id}`); render(); }
  catch (e) { toast(e.message, 'warn'); }
}
function renderParentReader(where) {
  const l = parentReader;
  fill(where, h('article', { class: 'eg-reader' },
    h('div', null, btn('‹ Back to For parents', () => { parentReader = null; render(); }, 'ghost')),
    h('p', { class: 'small muted' }, l.course ? `${l.course.title} · Lesson ${l.position.n} of ${l.position.of}` : ({ blog: 'Blog', research: 'Research' }[l.category] ?? 'For parents')),
    h('h2', { class: 'eg-reader-t' }, l.title),
    l.video_url ? videoEmbed(l.video_url, l.title) : null,
    h('div', { class: 'eg-body' }, String(l.body ?? l.summary ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => h('p', null, p))),
    h('div', { class: 'row wrap' },
      btn(l.done ? '✓ Read' : 'Mark as read', (e) => busy(e.currentTarget, async () => { parentReader = await post(`parent-lessons/${l.id}/complete`, { done: !l.done }); render(); }), l.done ? 'outline' : 'primary', { 'aria-pressed': String(!!l.done) }),
      l.next ? btn('Next ›', () => openParentLesson(l.next.id), l.done ? 'primary' : 'secondary') : null)));
}

// ---------- Home overview ----------
const PAID = { membership: 'Membership', credit: (b) => `1 ${b.credit_type ?? ''} session from your pack`.replace('  ', ' '), paid: (b) => (b.paid_cents != null ? `Paid ${money(b.paid_cents)} by card` : 'Paid by card'),
  registration: 'Camp registration', unpaid: 'Pay at the session', waitlist: 'Nothing is charged while on the waitlist', team: 'Team session (billed to the team)', free: 'No charge' };
const paidText = (b) => { const x = PAID[b.how_paid]; return typeof x === 'function' ? x(b) : x ?? ''; };
const STATUS = { active: 'Active', trialing: 'Free trial', past_due: 'Payment due', paused: 'Paused' };

function installCard() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone || store.get('dp_install_hidden')) return null;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  if (!installPrompt && !ios) return null;
  const hide = () => { store.set('dp_install_hidden', '1'); document.getElementById('p-install-slot')?.replaceChildren(); };
  return h('div', { class: 'dp-panel row wrap', style: 'gap:12px' },
    h('span', { class: 'grow small' }, ios ? 'Add this to your home screen: tap Share, then "Add to Home Screen".' : 'Add this to your home screen for one-tap booking.'),
    installPrompt ? btn('Add to home screen', async () => { installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; hide(); }, 'secondary') : null,
    btn('Not now', hide, 'ghost'));
}

async function viewOverview(main) {
  const cards = state.me.athletes.map((a) => {
    const m = a.membership, e = a.engagement ?? {};
    const needs = [
      e.unread ? h('button', { type: 'button', class: 'p-need', onClick: () => { state.athleteId = a.id; state.homeTab = 'accountability'; render(); } }, `${e.unread} new ${e.unread === 1 ? 'message' : 'messages'} from the coach`) : null,
      e.open_assignments ? h('button', { type: 'button', class: `p-need${e.overdue ? ' p-need--warn' : ''}`, onClick: () => { state.athleteId = a.id; state.homeTab = 'education'; render(); } }, e.overdue ? `${e.overdue} ${e.overdue === 1 ? 'lesson' : 'lessons'} overdue` : `${e.open_assignments} ${e.open_assignments === 1 ? 'lesson' : 'lessons'} to do`) : null,
      !e.checked_in_today ? h('button', { type: 'button', class: 'p-need', onClick: () => { state.athleteId = a.id; state.homeTab = 'accountability'; render(); } }, 'No check-in yet today') : null
    ].filter(Boolean);
    const rows = a.upcoming, list = h('div');
    const draw = (all) => fill(list, (all ? rows : rows.slice(0, 4)).map((u) => sessionRow(u)), rows.length > 4 && !all ? btn(`Show all ${rows.length}`, () => draw(true), 'ghost') : null);
    draw(false);
    return panel(null, {},
      h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { class: 'grow stack-tight' }, h('div', { class: 'p-athlete-name' }, a.name),
        h('span', { class: 'small muted' }, [a.age != null ? `Age ${a.age}` : null, a.sport, a.position].filter(Boolean).join(' · ') || 'Add sport and birthday on the Family tab'),
        a.athlete_id ? h('span', { class: 'small muted' }, 'Athlete ID ', h('button', { type: 'button', class: 'p-id', title: 'Copy', onClick: () => copy(a.athlete_id, 'Athlete ID copied.') }, a.athlete_id)) : null)),
      h('div', { class: 'p-stats' },
        h('div', { class: 'p-stat' }, h('b', { class: m?.status === 'past_due' ? 'warn-text' : null }, m ? STATUS[m.status] ?? m.status : 'None'),
          h('span', null, m ? (m.status === 'trialing' && m.trial_ends_at ? `Trial ends ${fmt(m.trial_ends_at, { month: 'short', day: 'numeric' })}` : m.next_charge_at ? `Renews ${fmt(m.next_charge_at, { month: 'short', day: 'numeric' })}` : m.plan_name) : 'No membership')),
        h('div', { class: 'p-stat' }, h('b', null, a.credits.group + a.credits.private), h('span', null, a.credits.private && a.credits.group ? `${a.credits.group} group, ${a.credits.private} private left` : a.credits.private ? 'Privates left' : 'Group classes left')),
        h('div', { class: 'p-stat' }, h('b', null, a.attended_30 ?? 0), h('span', null, 'Sessions in 30 days'))),
      m?.status === 'past_due' ? h('p', { class: 'small warn-text' }, 'The last membership payment didn\'t go through. Try again or update your card on the Family tab.') : null,
      needs.length ? h('div', { class: 'p-needs', 'aria-label': 'Needs a look' }, needs) : null,
      a.next_testing_day ? h('p', { class: 'small', style: 'margin:0' }, a.next_testing_day.today ? `Testing day today: ${a.next_testing_day.name}.` : `Next testing day: ${a.next_testing_day.name}, ${fmtDay(a.next_testing_day.date)}.`) : null,
      h('div', { class: 'dp-label' }, 'Coming up'),
      rows.length ? list : h('p', { class: 'muted small' }, 'Nothing booked yet.'),
      h('div', { class: 'row wrap' }, btn('Book a session', () => { state.athleteId = a.id; go('book'); }, 'secondary'),
        a.app_link ? h('a', { class: 'dp-btn dp-btn--ghost', href: a.app_link }, 'Open workouts') : null));
  });
  fill(main, top('Home'), state.me.athletes.length ? subtabs : null, banners(), h('div', { id: 'p-install-slot' }, installCard()),
    state.me.athletes.length ? [cards, calendarPanel()] : h('div', { class: 'empty' }, 'No athletes yet. Add one on the Family tab.'));
  drawSubtabs();
}

// A session row (Home, Book "Booked for"): Today/Tomorrow, coach, waitlist place, On now / Checked in. Tap for details.
function sessionRow(u) {
  const tags = [u.on_now && !u.checked_in ? h('span', { class: 'dp-badge dp-badge--good' }, 'On now') : null, u.checked_in ? h('span', { class: 'dp-badge dp-badge--good' }, 'Checked in') : null,
    u.status === 'waitlisted' ? h('span', { class: 'dp-badge dp-badge--neutral' }, `Waitlist #${u.waitlist_place}`) : null].filter(Boolean);
  return h('button', { type: 'button', class: 'p-row p-row--tap', onClick: () => bookingDialog(u) },
    h('div', { class: 'p-time p-time--day' }, h('span', { class: 'p-time-day' }, relDay(u.starts_at)), h('span', { class: 'small muted', style: 'font-family:var(--font-sans)' }, timeLabel(u.starts_at))),
    h('div', { class: 'grow stack-tight', style: 'text-align:left' }, h('span', { class: 'strong p-wrap-text' }, u.session_name),
      h('span', { class: 'small muted' }, [fmt(u.starts_at, { month: 'short', day: 'numeric' }), u.location_name, u.coach_name ? `with ${u.coach_name.split(' ')[0]}` : null].filter(Boolean).join(' · ')),
      u.note ? h('span', { class: 'small muted p-clamp' }, `Note: ${u.note}`) : null),
    tags.length ? h('div', { class: 'stack-tight', style: 'align-items:flex-end' }, tags) : h('span', { class: 'p-chev', 'aria-hidden': 'true' }, '›'));
}
// Add one session to a calendar: Apple Calendar (a file) or Google Calendar (a link).
const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function addToCalendar(ev) {
  const where = [ev.location_name, ev.address].filter(Boolean).join(', ');
  const esc = (s) => String(s ?? '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const apple = () => {
    const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Diamond Protocol//Parent portal//EN', 'BEGIN:VEVENT', `UID:${ev.uid}@diamondprotocol`, `DTSTAMP:${icsTime(new Date().toISOString())}`, `DTSTART:${icsTime(ev.starts_at)}`, `DTEND:${icsTime(ev.ends_at)}`,
      `SUMMARY:${esc(ev.title)}`, `LOCATION:${esc(where)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
    const a = h('a', { href: url, download: 'session.ics' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(ev.title)}&dates=${icsTime(ev.starts_at)}/${icsTime(ev.ends_at)}&location=${encodeURIComponent(where)}`;
  const appleFirst = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  const a = btn('Apple Calendar', apple, appleFirst ? 'secondary' : 'ghost'), g = h('a', { class: `dp-btn dp-btn--${appleFirst ? 'ghost' : 'secondary'}`, href: google, target: '_blank', rel: 'noopener' }, 'Google Calendar');
  return h('div', { class: 'row wrap' }, h('span', { class: 'small muted' }, 'Add to calendar:'), ...(appleFirst ? [a, g] : [g, a]));
}
function lateNote(u) {
  const hours = state.me.late_cancel_hours;
  if (u.status !== 'booked' || !u.late_from) return null;
  return Date.now() >= Date.parse(u.late_from) ? `It's less than ${hours} hours before, so cancelling now still uses the session.` : `Free to cancel until ${fmt(u.late_from, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. After that the session still counts as used.`;
}
function bookingDialog(u) {
  const who = state.me.athletes.find((a) => a.id === u.client_id);
  openDialog(u.session_name, [
    h('p', { class: 'strong', style: 'margin:0' }, range(u.starts_at, u.ends_at)),
    h('dl', { class: 'dl' },
      who ? h('div', null, h('dt', null, 'Athlete'), h('dd', null, who.name)) : null,
      h('div', null, h('dt', null, 'Where'), h('dd', null, u.location_name, u.address ? h('div', { class: 'small muted' }, u.address) : null, u.directions_url ? h('a', { href: u.directions_url, target: '_blank', rel: 'noopener', class: 'small' }, 'Directions') : null)),
      u.coach_name ? h('div', null, h('dt', null, 'Coach'), h('dd', null, u.coach_name)) : null,
      h('div', null, h('dt', null, 'How it\'s paid'), h('dd', null, paidText(u))),
      u.status === 'waitlisted' ? h('div', null, h('dt', null, 'Waitlist'), h('dd', null, `Number ${u.waitlist_place} in line. We'll email you if a spot opens.`)) : null,
      u.note ? h('div', null, h('dt', null, 'Your note'), h('dd', { style: 'white-space:pre-wrap' }, u.note)) : null),
    lateNote(u) ? h('p', { class: `small ${Date.now() >= Date.parse(u.late_from) ? 'warn-text' : 'muted'}` }, lateNote(u)) : null,
    u.camp_registration ? h('p', { class: 'small muted' }, 'Part of a camp registration. To cancel it, message your coach.') : null,
    addToCalendar({ uid: u.id, title: `${who?.first_name ?? ''}: ${u.session_name}`.replace(/^: /, ''), starts_at: u.starts_at, ends_at: u.ends_at, location_name: u.location_name, address: u.address })
  ], [u.can_cancel ? btn(u.status === 'waitlisted' ? 'Leave the waitlist' : 'Cancel booking', (e) => cancelBooking(e.currentTarget, u), 'secondary') : null]);
}
async function cancelBooking(button, u, after) {
  const late = u.status === 'booked' && u.late_from && Date.now() >= Date.parse(u.late_from);
  const what = u.status === 'waitlisted' ? `Leave the waitlist for ${u.session_name}?` : late ? `It's less than ${state.me.late_cancel_hours} hours before ${u.session_name}, so the session will still be used. Cancel anyway?` : `Cancel ${u.session_name} on ${dayLabel(u.starts_at)}?`;
  if (!confirm(what)) return;
  await busy(button, async () => {
    const r = await post(`bookings/${u.id}/cancel`);
    closeDialog();
    toast(u.status === 'waitlisted' ? 'You\'re off the waitlist.' : r.late ? 'Canceled. The session was still used.' : u.how_paid === 'paid' ? 'Canceled. Your payment is refunded.' : u.how_paid === 'credit' ? 'Canceled. Your session is back in your pack.' : 'Canceled.');
    await refresh();
    after?.();
  });
}
// Sessions in the parent's own calendar app: a private address that stays up to date.
function calendarPanel() {
  const c = state.me.calendar ?? {};
  const show = (made) => openDialog('Your calendar link', [
    h('p', null, 'Add this address to Apple, Google or Outlook calendar as a subscription. Booked sessions for your family show up and stay up to date.'),
    h('div', { class: 'p-link mono' }, made.url),
    h('p', { class: 'small muted' }, 'Keep it private: anyone with it can see session times and places (first names only). You won\'t see it again here; reset it to get a new one.')
  ], [h('a', { class: 'dp-btn dp-btn--primary', href: made.webcal }, 'Open in calendar'), btn('Copy', () => copy(made.url, 'Calendar link copied.'), 'secondary'),
    h('a', { class: 'dp-btn dp-btn--ghost', href: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(made.webcal)}`, target: '_blank', rel: 'noopener' }, 'Google Calendar')]);
  const make = (e, again) => { if (again && !confirm('Make a new link? The old one stops working, so calendars using it stop updating.')) return; busy(e.currentTarget, async () => { const made = await post('calendar'); state.me.calendar = { on: true, created_at: made.created_at }; show(made); }); };
  return panel('Sessions in your calendar', { subtitle: c.on ? `Your private calendar link is on (made ${fmt(c.created_at, { month: 'short', day: 'numeric' })}).` : 'See booked sessions in Apple, Google or Outlook calendar.' },
    h('div', { class: 'row wrap' }, c.on ? btn('Get a new link', (e) => make(e, true), 'secondary') : btn('Get my calendar link', (e) => make(e, false), 'secondary'),
      c.on ? btn('Turn off', (e) => { if (confirm('Turn off the calendar link? Calendars using it stop updating.')) busy(e.currentTarget, async () => { await api('DELETE', 'calendar'); await refresh(); toast('Calendar link turned off.'); }); }, 'ghost') : null));
}


// ---------- Book ----------
// Classes (with camps once each), private sessions and evaluations. Switching athlete, kind or class filter redraws the
// list in place; booking and cancelling keep the scroll position.
const book = { mode: 'classes', filter: '', coach: '', days: 21 };
async function viewBook(main) {
  if (!athlete()) return fill(main, top('Book'), h('div', { class: 'empty' }, 'Add an athlete on the Family tab first.'));
  if (state.bookMode) { book.mode = state.bookMode; state.bookMode = null; }
  const body = h('div', { class: 'stack' });
  const modes = h('div', { class: 'p-chips', role: 'group', 'aria-label': 'What to book' });
  const drawModes = () => fill(modes, [['classes', 'Classes'], ['private', 'Private'], ['evaluation', 'Evaluation']].map(([k, label]) =>
    h('button', { type: 'button', class: 'p-chip', 'aria-pressed': String(book.mode === k), onClick: () => { book.mode = k; book.coach = ''; book.days = 21; drawModes(); load(); } }, label)));
  drawModes();
  fill(main, top('Book'), banners(), athleteChips(() => load()), modes, body);
  let cache = null;
  await load();

  async function load({ keep = false } = {}) {
    const a = athlete(), y = window.scrollY;
    if (!keep) fill(body, h('p', { class: 'muted' }, 'Loading…'));
    if (book.mode === 'classes') { cache = (await get('schedule')).data; drawClasses(a); }
    else await drawSlots(a);
    if (keep) window.scrollTo(0, y);
  }
  const reload = () => refresh({ keepScroll: true });

  function drawClasses(a) {
    const mine = cache.filter((s) => { const me = s.athletes.find((x) => x.id === a.id); return me?.eligible || me?.status; });
    if (!mine.length) return fill(body, h('div', { class: 'empty' }, `No open classes for ${a.first_name}'s age in the next 3 weeks.`));
    const names = [...new Set(mine.filter((s) => !s.registration_only).map((s) => s.name))].sort();
    const filterSel = select([['', 'All classes'], ...names.map((n) => [n, n])], { value: book.filter, 'aria-label': 'Show one class' });
    filterSel.addEventListener('change', () => { book.filter = filterSel.value; drawClasses(a); });
    // Camps sold as a whole show once, with their days and price.
    const camps = new Map();
    for (const s of mine.filter((x) => x.registration_only)) (camps.get(s.series_id) ?? camps.set(s.series_id, []).get(s.series_id)).push(s);
    const classes = mine.filter((s) => !s.registration_only && (!book.filter || s.name === book.filter));
    let lastDay = '';
    fill(body,
      names.length > 1 ? field('Show', filterSel) : null,
      camps.size && !book.filter ? panel('Camps', { subtitle: 'One registration covers every day.' }, [...camps.values()].map((days) => campRow(a, days))) : null,
      classes.length ? panel(null, {}, classes.map((s) => {
        const day = dayLabel(s.starts_at);
        const header = day !== lastDay ? h('div', { class: 'p-day' }, (lastDay = day)) : null;
        return [header, classRow(a, s)];
      })) : h('p', { class: 'muted small' }, 'No other classes.'));
  }
  function classAction(a, s, me) {
    if (me.status === 'booked' || me.status === 'attended') return h('span', { class: 'dp-badge dp-badge--good' }, 'Booked');
    if (me.status === 'waitlisted') return h('span', { class: 'dp-badge dp-badge--neutral' }, `Waitlist #${me.waitlist_place ?? '?'}`);
    if (me.clash) return h('span', { class: 'dp-badge dp-badge--muted' }, 'Clashes');
    return btn(s.spots_left ? 'Book' : 'Join waitlist', (e) => { e.stopPropagation(); bookClass(e.currentTarget, a, s); }, s.spots_left ? 'primary' : 'secondary');
  }
  function classRow(a, s) {
    const me = s.athletes.find((x) => x.id === a.id);
    const row = h('div', { class: 'p-row p-row--tap', role: 'button', tabindex: '0', onClick: () => classDialog(a, s), onKeydown: (e) => { if (e.key === 'Enter') classDialog(a, s); } },
      h('div', { class: 'p-time' }, timeLabel(s.starts_at)),
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong p-wrap-text' }, s.name),
        h('span', { class: 'small muted' }, [s.location_name, s.coach_name ? `with ${s.coach_name.split(' ')[0]}` : null, s.spots_left ? `${s.spots_left} ${s.spots_left === 1 ? 'spot' : 'spots'} left` : `Full${s.waiting ? `, ${s.waiting} waiting` : ''}`].filter(Boolean).join(' · ')),
        me.clash ? h('span', { class: 'small warn-text' }, me.clash) : null),
      classAction(a, s, me));
    return row;
  }
  const PAYS = { membership: 'Covered by the membership', credit: 'Uses 1 group class from your pack', drop_in: (s) => `${money(s.drop_in_cents)} drop-in, charged to your card`, registration: 'Part of a camp registration', none: 'No charge' };
  function classDialog(a, s) {
    const me = s.athletes.find((x) => x.id === a.id);
    const pays = typeof PAYS[me.pays_with] === 'function' ? PAYS[me.pays_with](s) : PAYS[me.pays_with];
    const booking = state.me.athletes.find((x) => x.id === a.id)?.upcoming.find((u) => u.session_id === s.id);
    openDialog(s.name, [
      h('p', { class: 'strong', style: 'margin:0' }, range(s.starts_at, s.ends_at)),
      s.description ? h('p', { class: 'small muted' }, s.description) : null,
      h('dl', { class: 'dl' },
        h('div', null, h('dt', null, 'Where'), h('dd', null, s.location_name, s.address ? h('div', { class: 'small muted' }, s.address) : null, s.directions_url ? h('a', { href: s.directions_url, target: '_blank', rel: 'noopener', class: 'small' }, 'Directions') : null)),
        s.coach_name ? h('div', null, h('dt', null, 'Coach'), h('dd', null, s.coach_name)) : null,
        s.age_min != null || s.age_max != null ? h('div', null, h('dt', null, 'Ages'), h('dd', null, `${s.age_min ?? 'Any'}–${s.age_max ?? 'up'}`)) : null,
        h('div', null, h('dt', null, 'Spots'), h('dd', null, s.spots_left ? `${s.spots_left} of ${s.capacity} left` : `Full${s.waiting ? `, ${s.waiting} on the waitlist` : ''}`)),
        h('div', null, h('dt', null, booking ? 'How it\'s paid' : `For ${a.first_name}`), h('dd', null, booking ? paidText(booking) : s.spots_left ? pays : 'Nothing is charged on the waitlist. If a spot opens, it books the usual way.'))),
      me.clash ? h('p', { class: 'small warn-text' }, me.clash) : null,
      !booking ? h('p', { class: 'small muted' }, `Cancel up to ${state.me.late_cancel_hours} hours before for free.`) : lateNote(booking) ? h('p', { class: 'small muted' }, lateNote(booking)) : null,
      addToCalendar({ uid: s.id, title: `${a.first_name}: ${s.name}`, starts_at: s.starts_at, ends_at: s.ends_at, location_name: s.location_name, address: s.address })
    ], [booking?.can_cancel ? btn(booking.status === 'waitlisted' ? 'Leave the waitlist' : 'Cancel booking', (e) => cancelBooking(e.currentTarget, booking, () => load({ keep: true })), 'secondary')
      : !me.status && !me.clash ? btn(s.spots_left ? 'Book' : 'Join waitlist', (e) => bookClass(e.currentTarget, a, s), 'primary') : null]);
  }
  async function bookClass(button, a, s) {
    await busy(button, async () => {
      try { const b = await post('bookings', { session_id: s.id, athlete_id: a.id }); closeDialog(); toast(b.status === 'waitlisted' ? `${a.first_name} is on the waitlist. We'll email you if a spot opens.` : `${a.first_name} is booked.`); }
      catch (e) {
        if (e.status !== 402) { closeDialog(); throw e; }
        closeDialog();
        if (!(await offerCard(s.drop_in_cents, e.message))) return;
        try { await post('bookings', { session_id: s.id, athlete_id: a.id, pay: 'card_on_file' }); toast(`${a.first_name} is booked and paid.`); }
        catch (x) { if (x.status === 402) return cardProblem(x.message, 'book'); throw x; }
      }
      await reload();
    });
  }
  function campRow(a, days) {
    const s = days[0], me = s.athletes.find((x) => x.id === a.id);
    const registered = days.some((d) => d.athletes.find((x) => x.id === a.id)?.status);
    const sibs = state.me.athletes.filter((k) => k.id !== a.id && days.some((d) => d.athletes.find((x) => x.id === k.id)?.status)).map((k) => k.first_name);
    const full = days.some((d) => !d.spots_left), closed = !s.registration_open;
    const when = `${fmt(days[0].starts_at, { month: 'short', day: 'numeric' })}${days.length > 1 ? `–${fmt(days.at(-1).starts_at, { month: 'short', day: 'numeric' })}` : ''} · ${days.length} ${days.length === 1 ? 'day' : 'days'} · ${timeLabel(s.starts_at)}`;
    return h('div', { class: 'p-row' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong p-wrap-text' }, s.name), h('span', { class: 'small muted' }, `${when} · ${s.location_name}`),
        h('span', { class: 'small muted' }, [s.registration_cents ? money(s.registration_cents) : 'Free', full ? 'Full' : `${Math.min(...days.map((d) => d.spots_left))} spots left`].join(' · ')),
        sibs.length ? h('span', { class: 'small good-text' }, `${sibs.join(' and ')} ${sibs.length === 1 ? 'is' : 'are'} registered`) : null,
        me.clash && !registered ? h('span', { class: 'small warn-text' }, me.clash) : null),
      registered ? h('span', { class: 'dp-badge dp-badge--good' }, 'Registered') : closed ? h('span', { class: 'small muted' }, 'Registration closed') : full ? h('span', { class: 'small muted' }, 'Full') :
        btn(s.registration_cents ? `Register · ${money(s.registration_cents)}` : 'Register', (e) => registerCamp(e.currentTarget, a, s), 'primary'));
  }
  async function registerCamp(button, a, s) {
    const card = state.me.family.card;
    if (s.registration_cents && (!card.on_file || card.expired)) return cardProblem(`Registering ${a.first_name} for ${s.name} costs ${money(s.registration_cents)}.`, 'book');
    if (!confirm(`Register ${a.first_name} for ${s.name}${s.registration_cents ? ` and charge ${money(s.registration_cents)} to the ${cardName(card)}` : ''}?`)) return;
    await busy(button, async () => {
      try { await post(`programs/${s.series_id}/enroll`, { athlete_id: a.id }); toast(`${a.first_name} is registered.`); await reload(); }
      catch (e) { if (e.status === 402) return cardProblem(e.message, 'book'); throw e; }
    });
  }
  // Privates and evaluations already booked for this athlete, with cancel in place.
  function bookedFor(a, kinds) {
    const rows = (state.me.athletes.find((x) => x.id === a.id)?.upcoming ?? []).filter((u) => kinds.includes(u.kind));
    if (!rows.length) return null;
    return panel(`Booked for ${a.first_name}`, {}, rows.map((u) => sessionRow(u)));
  }

  async function drawSlots(a) {
    const kind = book.mode;
    const { data, coaches } = await get(`slots?kind=${kind}&days=${book.days}${book.coach ? `&coach_id=${encodeURIComponent(book.coach)}` : ''}`);
    const coachChips = coaches.length > 1 || book.coach ? h('div', { class: 'p-chips', role: 'group', 'aria-label': 'Coach' },
      [['', 'Any coach'], ...coaches.map((c) => [c.id, c.name.split(' ')[0]])].map(([id, label]) => h('button', { type: 'button', class: 'p-chip', 'aria-pressed': String(book.coach === id), onClick: () => { book.coach = id; load(); } }, label))) : null;
    const price = data.find((s) => s.price_cents)?.price_cents;
    const intro = kind === 'private'
      ? (a.credits.private ? `Uses one private session from ${a.first_name}'s pack (${a.credits.private} left).` : `No private sessions left in ${a.first_name}'s pack.${price ? ` Pay ${money(price)} for one when you book, or buy a pack under Programs.` : ' Buy a pack under Programs.'}`)
      : price ? `Evaluations are ${money(price)}, charged to your card. We test speed, power and movement and build a plan.` : 'Evaluations are free. We test speed, power and movement and build a plan.';
    const byDay = {};
    for (const s of data) (byDay[dayLabel(s.starts_at)] ??= []).push(s);
    fill(body, coachChips, h('p', { class: 'small muted' }, intro),
      data.length ? Object.entries(byDay).map(([day, slots]) => panel(day, {}, h('div', { class: 'p-slots' }, slots.map((s) => btn([timeLabel(s.starts_at), h('span', { class: 'small muted' }, [s.coach_name ? s.coach_name.split(' ')[0] : null, s.location_name].filter(Boolean).join(' · '))], () => slotDialog(a, s), 'secondary', { class: 'dp-btn dp-btn--secondary p-slot' })))))
        : h('div', { class: 'empty' }, `No open ${kind === 'private' ? 'private' : 'evaluation'} times in the next ${book.days} days${book.coach ? ' with this coach' : ''}. Message your coach.`),
      book.days < 60 ? btn('Show later dates', () => { book.days = Math.min(60, book.days + 21); load({ keep: true }); }, 'ghost') : null,
      bookedFor(a, [kind]));
  }
  function slotDialog(a, s) {
    const note = h('textarea', { class: 'dp-input', maxlength: '500', rows: '3', placeholder: 'What should the coach know? (optional)' });
    const free = s.kind === 'evaluation' && !s.price_cents;
    const paying = s.kind === 'evaluation' ? !!s.price_cents : !a.credits.private;
    const cost = s.kind === 'evaluation' ? (free ? 'There is no charge.' : `${money(s.price_cents)}, charged to your ${state.me.family.card.on_file ? cardName(state.me.family.card) : 'card'}.`)
      : a.credits.private ? `Uses 1 private session from ${a.first_name}'s pack.` : s.price_cents ? `${money(s.price_cents)}, charged to your card (no private sessions left).` : 'No private sessions left. Buy a pack under Programs first.';
    openDialog(s.kind === 'private' ? 'Book a private session' : 'Book an evaluation', [
      h('p', { class: 'strong', style: 'margin:0' }, range(s.starts_at, s.ends_at)),
      h('dl', { class: 'dl' }, h('div', null, h('dt', null, 'Athlete'), h('dd', null, a.name)), s.coach_name ? h('div', null, h('dt', null, 'Coach'), h('dd', null, s.coach_name)) : null,
        h('div', null, h('dt', null, 'Where'), h('dd', null, s.location_name)), h('div', null, h('dt', null, 'Cost'), h('dd', null, cost))),
      field(`Note for ${s.coach_name ? s.coach_name.split(' ')[0] : 'the coach'}`, note, 'Goals, injuries, anything useful. Your coach gets it by email.')
    ], [s.kind === 'private' && !a.credits.private && !s.price_cents ? btn('Buy a pack', () => { closeDialog(); go('programs'); }, 'primary') : btn(free ? 'Book evaluation' : paying && s.price_cents ? `Book and pay ${money(s.price_cents)}` : 'Book', (e) => bookSlot(e.currentTarget, a, s, note.value.trim(), paying && s.price_cents), 'primary')]);
  }
  async function bookSlot(button, a, s, note, pay) {
    await busy(button, async () => {
      const body = { kind: s.kind, starts_at: s.starts_at, availability_id: s.availability_id, athlete_id: a.id, note: note || undefined };
      if (pay && (!state.me.family.card.on_file || state.me.family.card.expired)) { closeDialog(); return cardProblem(`This costs ${money(s.price_cents)}.`, 'book'); }
      try { await post('slots/book', pay ? { ...body, pay: 'card_on_file' } : body); closeDialog(); toast(`${a.first_name} is booked${pay ? ' and paid' : ''}.`); }
      catch (e) { closeDialog(); if (e.status === 402) return cardProblem(e.message, 'book'); throw e; }
      await reload();
    });
  }
}


// ---------- Progress: shared test results ----------
const short = (n) => n.replace(/\s*\(.*\)$/, '');
const sideName = (t) => (t.side ? ` (${t.side === 'L' ? 'left' : 'right'})` : '');
const minusOneYear = () => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0, 10); };
async function viewProgress(main) {
  const a = athlete();
  if (!a) return fill(main, top('Progress'), h('div', { class: 'empty' }, 'Add an athlete on the Family tab first.'));
  const where = h('div', { class: 'stack' });
  fill(main, top('Progress'), athleteChips(() => load()), where);
  await load();

  async function load() {
    const a = athlete(), y = window.scrollY;
    // Showing and Change since are remembered on this phone.
    const period = store.get('dp_progress_period') ?? 'all', since = store.get('dp-report-since') ?? 'first';
    const from = period === 'year' ? minusOneYear() : period.startsWith('day:') ? period.slice(4) : '';
    const r = await get(`athletes/${a.id}/report${from ? `?from=${from}` : ''}`);
    const outsideBox = h('div', { class: 'stack' }), fcBox = h('div', { class: 'stack' }), monthlyBox = h('div', { class: 'stack' });
    fill(where, drawReport(a, r, { period, since, from }), monthlyBox, fcBox, outsideBox);
    window.scrollTo(0, y);
    drawOutside(a, outsideBox).catch(() => fill(outsideBox));
    drawFormChecks(a, fcBox);
    drawMonthly(a, monthlyBox).catch(() => fill(monthlyBox));
  }
  // Monthly reports the coaches sent: what the athlete did that month and the coach's line.
  async function drawMonthly(a, box) {
    const d = await get(`athletes/${a.id}/monthly-reports`);
    if (!d.data.length) return fill(box);
    fill(box, h('section', { class: 'dp-panel stack-tight' }, h('h2', { class: 'dp-panel-title' }, 'Monthly reports'),
      h('p', { class: 'small muted', style: 'margin:0' }, `A note from the coaches at the end of each month: what ${a.first_name} did and how the numbers are moving.`),
      d.data.map((r, i) => h('details', { class: 'p-month', open: i === 0 ? '' : null },
        h('summary', { class: 'strong', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center;gap:8px' }, r.label, h('span', { class: 'small muted' }, `· ${r.data.workouts} ${r.data.workouts === 1 ? 'workout' : 'workouts'}, ${r.data.attended} ${r.data.attended === 1 ? 'session' : 'sessions'}`)),
        h('div', { class: 'stack-tight small', style: 'padding:0 0 8px' }, r.lines.map((l) => h('p', { style: `margin:0${l.startsWith('- ') ? ';padding-left:12px' : ''}${l.startsWith('From ') ? ';font-weight:600' : ''}` }, l)))))));
  }
  // Form checks: clips the athlete sent their coach from the app, and the answers. Parents can watch and remove them.
  function drawFormChecks(a, box) {
    const block = formChecksBlock({ who: 'parent', first: a.first_name, list: async () => { const d = await get(`athletes/${a.id}/form-checks`); box.hidden = !d.data.length; return d; },
      play: (id, which) => get(`form-checks/${id}/video?which=${which}`), remove: (id) => api('DELETE', `form-checks/${id}`), empty: '' });
    box.hidden = true;
    fill(box, h('section', { class: 'dp-panel stack-tight' }, h('h2', { class: 'dp-panel-title' }, 'Form checks'),
      h('p', { class: 'small muted', style: 'margin:0' }, `Clips ${a.first_name} sent to the coach from the app, with the coach's answer. Only our coaches and your family can watch them, and they're removed after a while. Remove one any time.`), block.el));
  }
  // Recovery and sleep from a wearable or another app: what's on file, bringing in a file, and undoing one.
  async function drawOutside(a, box) {
    const d = await get(`athletes/${a.id}/outside-data`);
    const reload = () => drawOutside(a, box);
    const form = importForm({ athlete: () => ({ id: a.id, name: a.name }), preview: (b) => post(`athletes/${a.id}/data-imports/preview`, b), commit: (b) => post(`athletes/${a.id}/data-imports`, b), sources: () => get('data-imports/sources'), onSaved: reload });
    const linked = await get(`athletes/${a.id}/wearables`).catch(() => ({ data: [] }));
    const active = (linked.data ?? []).filter((w) => w.status === 'active').map((w) => w.label);
    const wear = wearablesBlock({ first: a.first_name, canConnect: true, list: async () => linked, connect: (p) => post(`athletes/${a.id}/wearables/${p}/connect`), disconnect: (id) => api('DELETE', `wearables/${id}`), afterChange: reload });
    fill(box, dataSummary(d, { title: `${a.first_name}'s recovery and sleep`, empty: `Connect ${a.first_name}'s WHOOP or Oura below, or bring in a file, and see recovery, heart rate variability, sleep and strain here. Our coaches see it too.` }),
      h('section', { class: 'dp-panel stack-tight' }, h('h2', { class: 'dp-panel-title' }, 'Linked wearables'), wear.el),
      h('details', { class: 'dp-panel', open: d.has_data || active.length ? null : true },
        h('summary', { class: 'strong', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, active.length ? 'Bring in a file from another app' : `Bring in a file for ${a.first_name}`),
        h('p', { class: 'small muted' }, active.length
          ? `${active.join(' and ')} ${active.length === 1 ? 'is' : 'are'} linked and pull on their own, so there's nothing to upload from ${active.length === 1 ? 'it' : 'them'}. Use this for another app: a CSV, Excel file, Google Sheets link or PDF with a date column.`
          : 'Pick where the file comes from (WHOOP, Oura, Garmin, Apple Health, Fitbit, Strava, TrainingPeaks or any spreadsheet) and the menu says how to get the export from that app.'),
        form,
        d.recent?.length ? h('div', { class: 'stack-tight' }, h('span', { class: 'small strong' }, 'Brought in'), importsList(d.recent, { canUndo: (x) => x.created_by_kind === 'parent', undo: async (id) => { await post(`data-imports/${id}/undo`); toast('Undone.'); reload(); } })) : null));
  }
  function drawReport(a, r, { period, since, from }) {
    const next = r.next_testing_day;
    const nextPanel = next ? h('div', { class: 'p-banner p-banner--info' }, h('span', { class: 'grow' }, next.today ? `Testing day today: ${next.name}.` : `Next testing day: ${next.name}, ${fmtDay(next.date)}.`)) : null;
    if (!r.tests.length && !r.growth?.latest_height) {
      return [nextPanel, h('div', { class: 'empty stack' }, h('p', { style: 'margin:0' }, period !== 'all' ? `No shared results for ${a.first_name} in this period.` : `No results shared for ${a.first_name} yet. Your coach will let you know when testing results are ready.`),
        period !== 'all' ? btn('Show all results', () => { store.set('dp_progress_period', 'all'); load(); }, 'secondary')
          : next ? null : btn('Book an evaluation', () => go('book', { bookMode: 'evaluation', athleteId: a.id }), 'secondary'))];
    }
    const periodSel = select([['all', 'All results'], ['year', 'Last 12 months'], ...r.all_sessions.filter((s) => s.shared).map((s) => [`day:${s.date}`, `Since ${s.name} (${fmtDay(s.date)})`])], { value: period, 'aria-label': 'Showing' });
    periodSel.addEventListener('change', () => { store.set('dp_progress_period', periodSel.value); load(); });
    const sinceSel = select([['first', 'First test'], ['last', 'Last test']], { value: since, 'aria-label': 'Change since' });
    sinceSel.addEventListener('change', () => { store.set('dp-report-since', sinceSel.value); load(); });
    const last = r.sessions[0];
    const prs = r.tests.filter((t) => t.tests_count > 1 && t.best_date && t.best_date === last?.date);
    const change = (t) => (since === 'last' ? { pct: t.improvement_pct_last, from: t.previous, improved: t.improved_last } : { pct: t.improvement_pct, from: t.first, improved: t.improved });
    const best = r.tests.map((t) => ({ t, c: change(t) })).filter((x) => x.c.pct > 0).sort((x, y) => y.c.pct - x.c.pct).slice(0, 3);
    return [
      nextPanel,
      h('div', { class: 'p-stats' },
        h('div', { class: 'p-stat' }, h('b', null, r.tests.length), h('span', null, r.tests.length === 1 ? 'Test' : 'Tests')),
        h('div', { class: 'p-stat' }, h('b', { class: prs.length ? 'good-text' : null }, prs.length), h('span', null, 'New PRs')),
        h('div', { class: 'p-stat' }, h('b', { class: 'p-stat-word' }, last ? fmt(`${last.date}T12:00:00Z`, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—'), h('span', null, 'Last tested'))),
      h('div', { class: 'form-grid' }, field('Showing', periodSel), field('Change since', sinceSel)),
      r.latest_session?.athlete_note || r.latest_session?.parent_note ? panel('From your coach', { subtitle: `${r.latest_session.name} · ${fmtDay(r.latest_session.date)}` },
        [r.latest_session.athlete_note, r.latest_session.parent_note].filter(Boolean).map((t) => h('p', { style: 'white-space:pre-wrap;margin:0' }, t))) : null,
      best.length ? panel('Biggest improvements', { subtitle: since === 'last' ? 'Since the test before.' : 'Since the first test.' }, h('div', { class: 'p-tiles' }, best.map(({ t, c }) => h('button', { type: 'button', class: 'p-tile', onClick: () => testDialog(a, t) },
        h('b', { class: 'good-text' }, `+${c.pct}%`), h('span', { class: 'strong' }, `${short(t.test_name)}${sideName(t)}`),
        h('span', { class: 'small muted' }, `${fmtResult(c.from.value, t.unit, t.decimals)} → ${fmtResult(t.latest.value, t.unit, t.decimals)}`))))) : null,
      prs.length ? panel('New personal bests', { subtitle: `From ${last.name}.` }, h('div', { class: 'p-tiles' }, prs.map((t) => h('button', { type: 'button', class: 'p-tile', onClick: () => testDialog(a, t) },
        h('b', null, fmtResult(t.best, t.unit, t.decimals)), h('span', { class: 'strong' }, `${short(t.test_name)}${sideName(t)}`), h('span', { class: 'small muted' }, fmtDay(t.best_date)))))) : null,
      r.targets?.length ? panel('Targets from the coach', {}, r.targets.map((x) => h('div', { class: 'p-row' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, short(x.test_name)), h('span', { class: `small ${x.reached ? 'good-text' : x.due_date && x.due_date < new Date().toISOString().slice(0, 10) ? 'warn-text' : 'muted'}` },
          x.reached ? `Reached: ${x.best_text}` : `Best ${x.best_text ?? '—'} · target ${x.target_text}${x.due_date ? ` by ${fmtDay(x.due_date)}` : ''}`)),
        h('div', { class: 'p-bar', role: 'img', 'aria-label': `${x.pct}% of the way` }, h('span', { style: `width:${x.pct}%` }))))) : null,
      r.rankings?.length ? panel('How they compare', { subtitle: 'Where the best result ranks. No other athletes are named.' }, r.rankings.map((x) => h('div', { class: 'p-row' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, short(x.test_name)), h('span', { class: 'small muted' }, x.ranks.map((k) => `${k.rank} of ${k.of} in ${k.group}`).join(' · ')))))) : null,
      panel('Every test', { subtitle: `Tap a test for every result. ${since === 'last' ? 'Change since the test before.' : 'Change since the first test.'}` }, r.tests.map((t) => {
        const c = change(t);
        return h('button', { type: 'button', class: 'p-row p-row--tap', onClick: () => testDialog(a, t) },
          h('div', { class: 'grow stack-tight', style: 'text-align:left' }, h('span', { class: 'strong' }, `${short(t.test_name)}${sideName(t)}`),
            h('span', { class: 'small muted' }, t.tests_count > 1 && c.from ? `${fmtResult(c.from.value, t.unit, t.decimals)} → ${fmtResult(t.latest.value, t.unit, t.decimals)}` : `Tested ${fmtDay(t.latest.date)}`)),
          h('span', { style: 'color:var(--green-bright)' }, sparkline(t.history, { better: t.better, width: 72, height: 28, label: `${t.test_name} trend` })),
          h('div', { style: 'text-align:right;min-width:78px' }, h('div', { class: 'strong' }, fmtResult(t.best, t.unit, t.decimals)),
            c.pct != null ? h('div', { class: `small ${c.improved ? 'good-text' : 'muted'}` }, `${c.pct > 0 ? '+' : ''}${c.pct}%`) : null));
      })),
      growthPanel(a, r.growth),
      sharePanel(a, from)
    ];
  }
  async function testDialog(a, t) {
    const info = await get(`tests/${encodeURIComponent(t.test)}`).catch(() => null);
    const rows = [...t.history].reverse();
    openDialog(`${short(t.test_name)}${sideName(t)}`, [
      info?.description ? h('p', null, info.description) : null,
      h('div', { class: 'p-stats' },
        h('div', { class: 'p-stat' }, h('b', null, fmtResult(t.best, t.unit, t.decimals)), h('span', null, `Best (${fmtDay(t.best_date)})`)),
        h('div', { class: 'p-stat' }, h('b', null, fmtResult(t.first.value, t.unit, t.decimals)), h('span', null, 'First')),
        h('div', { class: 'p-stat' }, h('b', null, t.tests_count), h('span', null, t.tests_count === 1 ? 'Test' : 'Tests'))),
      h('div', { class: 'dp-label' }, 'Every result'),
      h('div', null, rows.map((x, i) => {
        const prev = rows[i + 1];
        const better = prev && (t.better === 'lower' ? x.value < prev.value : x.value > prev.value);
        return h('div', { class: 'p-row' }, h('span', { class: 'grow' }, fmtDay(x.date)), x.value === t.best ? h('span', { class: 'dp-badge dp-badge--good' }, 'Best') : null,
          h('span', { class: 'strong' }, fmtResult(x.value, t.unit, t.decimals)), prev ? h('span', { class: `small ${better ? 'good-text' : 'muted'}`, style: 'min-width:64px;text-align:right' }, fmtResult(x.value - prev.value, t.unit, t.decimals, { delta: true })) : h('span', { style: 'min-width:64px' }));
      })),
      info?.protocol ? h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'How it\'s tested'), h('p', { class: 'small muted', style: 'white-space:pre-wrap' }, info.protocol)) : null
    ]);
  }
  // Height and weight are shown as they are, not as better or worse.
  function growthPanel(a, g) {
    if (!g || (!g.latest_height && !g.latest_weight)) return null;
    const PHASE = { before: 'Before the growth spurt', during: 'In the growth spurt', after: 'Past the growth spurt' };
    const since = (list, unit) => (list?.length > 1 ? `${list.at(-1).value - list[0].value >= 0 ? '+' : ''}${fmtResult(list.at(-1).value - list[0].value, unit, 1, { delta: true }).replace(/^\+?/, '')} since ${fmtDay(list[0].date)}` : null);
    return panel('Growth', {},
      h('div', { class: 'p-stats' },
        g.latest_height ? h('div', { class: 'p-stat' }, h('b', null, fmtResult(g.latest_height.value, 'in', 1)), h('span', null, since(g.heights, 'in') ?? 'Height')) : null,
        g.latest_weight ? h('div', { class: 'p-stat' }, h('b', null, fmtResult(g.latest_weight.value, 'lb', 0)), h('span', null, since(g.weights, 'lb') ?? 'Weight')) : null,
        g.estimate ? h('div', { class: 'p-stat' }, h('b', { class: 'p-stat-word' }, PHASE[g.estimate.phase]), h('span', null, `Peak around age ${g.estimate.peak_age}`)) : null),
      g.heights?.length > 1 ? h('div', { class: 'row small muted' }, h('span', null, 'Height'), h('span', { style: 'color:var(--steel)' }, sparkline(g.heights, { better: 'none', width: 160, height: 32, label: 'Height over time' }))) : null,
      g.estimate ? h('p', { class: 'small muted' }, `${g.estimate.text} This is an estimate and can be off by about a year.`) : g.missing?.length ? h('p', { class: 'small muted' }, `Add ${g.missing.filter((m) => ['birthday', 'sex'].includes(m)).join(' and ') || 'more measurements'} on the Family tab to see a growth-spurt estimate.`) : null);
  }
  // Share the report without leaving the tab: make a link, copy or send it, turn it off. The printable report follows the period.
  function sharePanel(a, from) {
    const box = h('div', { class: 'stack' });
    const days = select([['30', '30 days'], ['7', '7 days'], ['90', '90 days'], ['365', '1 year']], { value: '30', 'aria-label': 'Link works for' });
    const label = input({ placeholder: 'Who it\'s for (optional), like Grandma or Coach Smith', maxlength: '60' });
    const fresh = h('div');
    const drawLinks = async () => {
      const { data } = await get(`athletes/${a.id}/report-links`);
      fill(box, data.length ? data.map((l) => h('div', { class: 'p-row' }, h('div', { class: 'grow stack-tight' }, h('span', null, l.label || 'Share link'),
        h('span', { class: 'small muted' }, `Works until ${fmt(l.expires_at, { month: 'short', day: 'numeric', year: 'numeric' })} · opened ${l.views} ${l.views === 1 ? 'time' : 'times'}`)),
        btn('Turn off', (e) => { if (confirm('Turn off this link? It stops working at once.')) busy(e.currentTarget, async () => { await api('DELETE', `athletes/${a.id}/report-links/${l.id}`); if (fresh.dataset.id === l.id) fill(fresh); toast('Link turned off.'); await drawLinks(); }); }, 'ghost'))) : h('p', { class: 'small muted', style: 'margin:0' }, 'No working links.'));
    };
    const p = panel('Share the report', { subtitle: 'A link that works without signing in, for a grandparent or a recruiter. It shows shared results and the age, never the birthday.' },
      h('div', { class: 'form-grid' }, field('Link works for', days), field('Label', label)),
      h('div', { class: 'row wrap' },
        btn('Make a link', (e) => busy(e.currentTarget, async () => {
          const l = await post(`athletes/${a.id}/report-links`, { days: Number(days.value), label: label.value || undefined });
          fresh.dataset.id = l.id;
          fill(fresh, h('div', { class: 'p-link mono' }, l.url), h('div', { class: 'row wrap' }, btn('Copy', () => copy(l.url, 'Link copied.'), 'secondary'),
            navigator.share ? btn('Send', () => navigator.share({ title: `${a.first_name}'s progress report`, url: l.url }).catch(() => {}), 'secondary') : null),
            h('p', { class: 'small muted' }, 'Copy it now: the link isn\'t shown again.'));
          label.value = ''; await drawLinks();
        }), 'primary'),
        h('a', { class: 'dp-btn dp-btn--ghost', href: `/report.html?athlete=${a.id}${from ? `&from=${from}` : ''}` }, 'Printable report')),
      fresh, h('div', { class: 'dp-label' }, 'Working links'), box);
    drawLinks().catch(() => {});
    return p;
  }
}


// ---------- Programs: membership, camps, standing spots, packs, online programs ----------
async function viewPrograms(main) {
  const a = athlete();
  const [{ data: progs }, storeData, shop] = await Promise.all([get('programs'), get('store'), get('shop')]);
  const f = state.me.family;
  if (!a) return fill(main, top('Programs'), banners(), h('div', { class: 'empty' }, 'Add an athlete on the Family tab first.'));
  // Only show what fits this athlete's age (when we know it), and anything the family is already in.
  const fits = (p) => a.age == null || ((p.age_min == null || a.age >= p.age_min) && (p.age_max == null || a.age <= p.age_max));
  const groups = progs.filter((p) => p.kind === 'group' && (fits(p) || p.registered.includes(a.id)));
  const camps = progs.filter((p) => p.kind !== 'group' && (fits(p) || p.registered.length));
  const when = (p) => `${dayList(p.weekdays)} · ${fmtTime(p.start_time)} · ${p.duration_min} min`;
  const ages = (p) => (p.age_min || p.age_max ? ` · Ages ${p.age_min ?? ''}–${p.age_max ?? ''}` : '');
  const reload = () => refresh({ keepScroll: true });
  const m = a.membership, member = m && ['active', 'trialing', 'past_due'].includes(m.status);

  const cardLine = h('div', { class: 'row wrap small', style: 'gap:8px' },
    h('span', { class: `grow ${f.card.expired || f.card.expiring ? 'warn-text' : 'muted'}` }, f.card.on_file ? `Payments go on the ${cardName(f.card)}${f.card.exp ? ` (${f.card.expired ? 'expired' : 'expires'} ${expText(f.card.exp)})` : ''}.` : 'No card on file yet.'),
    btn(f.card.on_file ? 'Update card' : 'Add a card', () => { state.returnTo = 'programs'; go('family', { focus: 'card' }); }, 'ghost'));

  // Membership: status, trial end or next charge, what's left, and asking to switch, pause or cancel.
  const req = a.membership_request, answer = a.membership_answer;
  const KINDS = { switch: 'switch plans', pause: 'pause', cancel: 'cancel' };
  const memPanel = panel(`${a.first_name}'s membership`, {},
    m ? h('dl', { class: 'dl' },
      h('div', null, h('dt', null, 'Plan'), h('dd', null, m.plan_name, m.price_cents != null ? ` · ${money(m.price_cents)} a month${m.fee_cents ? ` plus a ${money(m.fee_cents)} ${(m.fee_label ?? 'card processing fee').toLowerCase()}` : ''}` : '')),
      h('div', null, h('dt', null, 'Status'), h('dd', { class: m.status === 'past_due' ? 'warn-text' : null }, STATUS[m.status] ?? m.status, m.past_due_cents ? ` · ${money(m.past_due_cents)} didn't go through` : '')),
      m.trial_ends_at ? h('div', null, h('dt', null, 'Trial ends'), h('dd', null, fmt(m.trial_ends_at, { month: 'long', day: 'numeric' }))) : null,
      m.next_charge_at && !m.trial_ends_at ? h('div', null, h('dt', null, 'Next charge'), h('dd', null, fmt(m.next_charge_at, { month: 'long', day: 'numeric' }))) : null,
      m.pending_plan_name ? h('div', null, h('dt', null, 'Changing to'), h('dd', null, `${m.pending_plan_name} on ${fmt(m.renews, { month: 'long', day: 'numeric' })}`)) : null,
      h('div', null, h('dt', null, 'Left in packs'), h('dd', null, `${a.credits.group} group, ${a.credits.private} private`))) : h('p', { class: 'muted small' }, `${a.first_name} has no membership. A membership covers every group class and holds a standing spot; see the plans below.`),
    req ? h('div', { class: 'p-banner p-banner--info' }, h('span', { class: 'grow' }, `You asked to ${KINDS[req.kind]}${req.kind === 'switch' && req.plan_name ? ` to ${req.plan_name}` : ''} on ${fmt(req.created_at, { month: 'short', day: 'numeric' })}. We'll be in touch.`),
      btn('Withdraw', (e) => busy(e.currentTarget, async () => { await post(`athletes/${a.id}/membership-request/withdraw`); toast('Request withdrawn.'); await reload(); }), 'ghost')) : null,
    !req && answer ? h('p', { class: 'small muted' }, `${answer.status === 'done' ? 'Done' : 'Answered'}: your request to ${KINDS[answer.kind]} (${fmt(answer.resolved_at, { month: 'short', day: 'numeric' })}).${answer.resolution_note ? ` "${answer.resolution_note}"` : ''}`) : null,
    m && !req ? btn(m.status === 'paused' ? 'Ask to switch or cancel' : 'Ask to change, pause or cancel', () => requestDialog(a, m, storeData.plans), 'secondary') : null);

  const campPanel = panel('Camps & clinics', { subtitle: 'One registration covers every day.' }, camps.length ? camps.map((p) => {
    const mine = p.registered.includes(a.id), sibs = state.me.athletes.filter((k) => k.id !== a.id && p.registered.includes(k.id)).map((k) => k.first_name);
    const daysTo = p.closes_at ? Math.ceil((Date.parse(p.closes_at) - Date.now()) / 86400000) : null;
    const note = !p.registration_open ? 'Registration closed' : p.spots_left === 0 ? 'Full' : [p.spots_left <= 3 ? `Only ${p.spots_left} ${p.spots_left === 1 ? 'spot' : 'spots'} left` : `${p.spots_left} spots left`,
      daysTo != null && daysTo <= 3 ? `registration closes ${daysTo <= 1 ? 'tomorrow' : `in ${daysTo} days`}` : p.closes_at ? `registration closes ${fmt(p.closes_at, { month: 'short', day: 'numeric' })}` : null].filter(Boolean).join(' · ');
    return h('div', { class: 'p-row' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong p-wrap-text' }, p.name), h('span', { class: 'small muted' }, `${fmtDate(p.start_date)}–${fmtDate(p.end_date)} · ${when(p)}${ages(p)}`),
        p.description ? h('span', { class: 'small muted' }, p.description) : null,
        mine ? null : h('span', { class: `small ${p.registration_open && p.spots_left && (p.spots_left <= 3 || (daysTo != null && daysTo <= 3)) ? 'warn-text' : 'muted'}` }, note),
        sibs.length ? h('span', { class: 'small good-text' }, `${sibs.join(' and ')} ${sibs.length === 1 ? 'is' : 'are'} registered`) : null),
      mine ? h('span', { class: 'dp-badge dp-badge--good' }, 'Registered') : !p.registration_open || !p.spots_left || !fits(p) ? null
        : btn(p.registration_cents ? `Register · ${money(p.registration_cents)}` : 'Register', (e) => {
          if (p.registration_cents && (!f.card.on_file || f.card.expired)) return cardProblem(`Registering ${a.first_name} for ${p.name} costs ${money(p.registration_cents)}.`, 'programs');
          if (!confirm(`Register ${a.first_name} for ${p.name}${p.registration_cents ? ` and charge ${money(p.registration_cents)} to the ${cardName(f.card)}` : ''}?`)) return;
          busy(e.currentTarget, async () => {
            try { await post(`programs/${p.id}/enroll`, { athlete_id: a.id }); toast(`${a.first_name} is registered.`); await reload(); }
            catch (x) { if (x.status === 402) return cardProblem(x.message, 'programs'); throw x; }
          });
        }, 'primary'));
  }) : h('p', { class: 'muted small' }, 'No camps or clinics open for this age right now.'));

  const groupPanel = panel('Weekly group classes', { subtitle: member ? 'Hold a standing spot and you\'re booked every week. Cancel any single week on Home.' : 'Standing spots come with a membership. You can still book single classes on the Book tab.' },
    groups.length ? groups.map((p) => {
      const held = p.held?.[a.id];
      return h('div', { class: 'p-row' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong p-wrap-text' }, p.name), h('span', { class: 'small muted' }, `${when(p)} · ${p.location_name}${ages(p)}`),
          held ? h('span', { class: 'small good-text' }, held.next_at ? `Next: ${fmt(held.next_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${held.booked} booked ahead` : 'Standing spot held')
            : p.next_session_at ? h('span', { class: 'small muted' }, `Next class ${fmt(p.next_session_at, { weekday: 'short', month: 'short', day: 'numeric' })}`) : null),
        held ? btn('Leave', (e) => { if (confirm(`Give up ${a.first_name}'s standing spot in ${p.name}? Booked weeks ahead are released.`)) busy(e.currentTarget, async () => { await api('DELETE', `programs/${p.id}/enroll/${a.id}`); toast('Standing spot released.'); await reload(); }); }, 'ghost')
          : member ? btn('Hold a spot', (e) => { if (confirm(`Hold a standing spot for ${a.first_name} in ${p.name}? They'll be booked every week on the membership. Cancel any week you can't make it.`)) busy(e.currentTarget, async () => { await post(`programs/${p.id}/enroll`, { athlete_id: a.id }); toast(`${a.first_name} has a standing spot.`); await reload(); }); }, 'secondary')
          : null);
    }) : h('p', { class: 'muted small' }, 'No weekly classes yet.'),
    !member && groups.length ? btn('See membership plans', () => document.getElementById('p-plans')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 'ghost') : null);

  // fee: the card processing fee the owner turned on, shown and confirmed before the charge.
  const feeWord = (storeData.fee_label ?? 'Card processing fee').toLowerCase();
  const buy = (label, cents, fn, back, fee = 0) => btn(`${label} · ${money(cents + fee)}`, (e) => {
    if (!f.card.on_file || f.card.expired) return cardProblem(`This costs ${money(cents + fee)}.`, back);
    if (!confirm(`Charge ${money(cents + fee)} to the ${cardName(f.card)}?${fee ? ` That's ${money(cents)} plus a ${money(fee)} ${feeWord}.` : ''}`)) return;
    busy(e.currentTarget, async () => { try { await fn(); } catch (x) { if (x.status === 402) return cardProblem(x.message, back); throw x; } });
  }, 'secondary');
  const packLine = (p) => (p.kind === 'pack' ? [`${p.sessions} ${p.credit_type} sessions`, p.per_session_cents ? `${money(p.per_session_cents)} each` : null, p.saves_cents ? `save ${money(p.saves_cents)}` : null].filter(Boolean).join(' · ') : `1 ${p.credit_type} session`);
  const storePanel = h('section', { class: 'dp-panel', id: 'p-plans' }, h('div', { class: 'dp-panel-head' }, h('div', null, h('h2', { class: 'dp-panel-title' }, 'Packs & memberships'), h('p', { class: 'dp-panel-sub' }, `For ${a.first_name}`))),
    ...storeData.plans.map((p) => h('div', { class: 'p-row' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'small muted' }, `${money(p.price_cents)} a month${p.fee_cents ? ` plus a ${money(p.fee_cents)} ${feeWord}` : ''}${p.trial_days ? ` · ${p.trial_days}-day free trial` : ''}`)),
      m ? (m.plan_id === p.id ? h('span', { class: 'dp-badge dp-badge--good' }, 'Current') : null) : buy('Start', p.price_cents, async () => { await post('membership', { plan_id: p.id, athlete_id: a.id }); toast('Membership started.'); await reload(); }, 'programs', p.fee_cents))),
    ...storeData.products.map((p) => h('div', { class: 'p-row' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, p.name), h('span', { class: `small ${p.saves_cents ? 'good-text' : 'muted'}` }, packLine(p))),
      buy('Buy', p.price_cents, async () => { await post('purchase', { product_id: p.id, athlete_id: a.id }); toast('Added to your account.'); await reload(); }, 'programs', p.fee_cents))));

  // Programs and courses sold online: pay once, it shows in the athlete's app.
  const owns = (x) => shop.owned.some((o) => o.client_id === a.id && o.item_kind === x.kind && o.item_id === x.id);
  const onlineRow = (x) => {
    const picked = state.buy === `${x.kind}:${x.id}`;
    return h('div', { class: 'p-row', id: picked ? 'buy-pick' : null, style: picked ? 'outline:2px solid var(--green);outline-offset:4px;border-radius:var(--radius-md)' : null },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.title),
        h('span', { class: 'small muted' }, x.kind === 'program' ? `Training program · ${x.weeks} ${x.weeks === 1 ? 'week' : 'weeks'}${x.level ? ` · ${x.level}` : ''}` : `Course · ${x.lessons} ${x.lessons === 1 ? 'lesson' : 'lessons'}`),
        x.description ? h('span', { class: 'small muted' }, x.description) : null),
      owns(x) ? h('span', { class: 'dp-badge dp-badge--good' }, 'In the app') : buy('Buy', x.price_cents, async () => {
        if (x.kind === 'program' && a.program && !confirm(`${x.title} replaces ${a.first_name}'s current program, ${a.program.name}. Buy it anyway?`)) return;
        await post('shop/buy', { kind: x.kind, item_id: x.id, athlete_id: a.id });
        state.buy = null;
        toast(`${x.title} is in ${a.first_name}'s app now. We emailed you the link.`); await reload();
      }, 'programs', x.fee_cents));
  };
  const onlinePanel = shop.items.length ? panel('Online programs & courses', { subtitle: `Pay once and ${a.first_name} gets it in their app. No membership needed.` }, shop.items.map(onlineRow)) : null;

  fill(main, top('Programs'), banners(), athleteChips(() => render({ keepScroll: true })), cardLine, state.buy ? onlinePanel : null, memPanel, campPanel, groupPanel, storePanel, state.buy ? null : onlinePanel);
  document.getElementById('buy-pick')?.scrollIntoView({ block: 'center' });
}
// Ask to switch plans, pause or cancel: the owner gets it and makes the change.
function requestDialog(a, m, plans) {
  const others = plans.filter((p) => p.id !== m.plan_id);
  const choice = (value, label, disabled) => h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, h('input', { type: 'radio', name: 'mreq', value, disabled }), h('span', null, label));
  const planSel = select(others.map((p) => [p.id, `${p.name}, ${money(p.price_cents)} a month`]), { 'aria-label': 'New plan' });
  const note = h('textarea', { class: 'dp-input', rows: '3', maxlength: '500', placeholder: 'Anything we should know? (optional)' });
  const form = h('div', { class: 'stack' },
    others.length ? choice('switch', 'Switch to another plan') : null, others.length ? planSel : null,
    m.status === 'paused' ? null : choice('pause', 'Pause the membership'),
    choice('cancel', 'Cancel the membership'), field('Note', note));
  openDialog(`Change ${a.first_name}'s membership`, [h('p', { class: 'small muted' }, 'We\'ll get your request by email and reply. Nothing changes until we do.'), form],
    [btn('Send request', (e) => {
      const kind = form.querySelector('input[name="mreq"]:checked')?.value;
      if (!kind) return toast('Choose what you\'d like.', 'warn');
      busy(e.currentTarget, async () => { await post(`athletes/${a.id}/membership-request`, { kind, plan_id: kind === 'switch' ? planSel.value : undefined, note: note.value || undefined }); closeDialog(); toast('Request sent. We\'ll be in touch.'); await refresh({ keepScroll: true }); });
    }, 'primary')]);
  const d = document.getElementById('dialog'), notNow = [...d.querySelectorAll('button')].find((b) => b.textContent === 'Close');
  if (notNow) notNow.textContent = 'Not now';
}
// [1,2,3,4,5] -> "Mon–Fri", [1,3] -> "Mon & Wed"
const dayList = (days) => {
  const d = [...days].sort((x, y) => x - y);
  const run = d.length >= 3 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return run ? `${DAYS[d[0]]}–${DAYS[d[d.length - 1]]}` : d.map((x) => DAYS[x]).join(' & ');
};
const fmtTime = (hhmm) => { const [hh, mm] = hhmm.split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };
const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });


// ---------- Family ----------
const openAthletes = new Set();
async function viewFamily(main) {
  const f = state.me.family, me = state.me.guardian;
  const payments = await get('payments').catch(() => null);
  const focus = state.focus; state.focus = null;
  const lockNote = state.me.payment_lock ? h('div', { class: 'p-banner', role: 'alert' }, h('span', { class: 'grow warn-text' }, `${state.me.payment_lock.message} Booking, the athlete app and self check-in are paused until then.`)) : null;
  const back = state.returnTo ? h('div', { class: 'p-banner p-banner--info' }, h('span', { class: 'grow' }, 'When your card is saved, go back to where you were.'),
    btn(`Back to ${state.returnTo === 'book' ? 'Book' : 'Programs'}`, () => { const t = state.returnTo; state.returnTo = null; go(t); }, 'outline')) : null;

  // To finish: everything still missing, each with a button straight to it.
  const scrollTo = (id) => { const el = document.getElementById(id); if (el) { if (el.tagName === 'DETAILS') el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
  const TARGET = { terms: 'fam-terms', waiver: 'fam-waiver', card: 'fam-card', card_expired: 'fam-card', card_expiring: 'fam-card', declined: 'fam-card' };
  const fin = state.me.to_finish ?? [];
  const finish = fin.length ? panel('To finish', { subtitle: `${fin.length} ${fin.length === 1 ? 'thing' : 'things'} left` }, fin.map((x) => h('div', { class: 'p-row' },
    h('span', { class: `grow ${['card_expired', 'declined'].includes(x.key) ? 'warn-text' : ''}` }, x.text),
    btn('Go', () => (x.athlete_id ? (openAthletes.add(x.athlete_id), render({ keepScroll: true }), setTimeout(() => scrollTo(`ath-${x.athlete_id}`), 50)) : scrollTo(TARGET[x.key])), 'outline')))) : null;

  // Card: expiry in amber, declined payments with Try again, replace or remove.
  const exp = f.card.exp ? ` · ${f.card.expired ? 'expired' : 'expires'} ${expText(f.card.exp)}` : '';
  const declined = payments?.declined ?? [];
  const cardPanel = h('section', { class: 'dp-panel', id: 'fam-card' }, h('div', { class: 'dp-panel-head' }, h('div', null, h('h2', { class: 'dp-panel-title' }, 'Card on file'), h('p', { class: 'dp-panel-sub' }, 'Used for memberships, packs, camps and drop-ins for everyone in your family.'))),
    f.card.on_file ? h('p', { class: f.card.expired || f.card.expiring ? 'warn-text' : null }, `${cardName(f.card)}${exp}`) : h('p', { class: 'muted' }, 'No card yet.'),
    declined.map((d) => h('div', { class: 'p-banner' }, h('span', { class: 'grow' }, `${d.athlete_name}'s ${d.plan_name} payment of ${money(d.amount_cents)} didn't go through${d.error ? `: ${d.error.replace(/\.$/, '')}` : ''}.`),
      d.can_retry ? btn('Try again', (e) => busy(e.currentTarget, async () => { const r = await post(`payments/${d.id}/retry`); toast(r.message, r.status === 'paid' ? 'good' : 'warn'); await refresh({ keepScroll: true }); }), 'outline')
        : h('span', { class: 'small' }, f.card.on_file ? 'Message us and we\'ll sort it out.' : 'Add a card and it\'s tried again.'))),
    h('div', { class: 'row wrap' },
      state.me.payments.provider === 'stripe' ? btn(f.card.on_file ? 'Replace card' : 'Add card', (e) => busy(e.currentTarget, async () => { const { url } = await post('card/setup-link'); location.href = url; }), 'primary') : null,
      state.me.payments.can_simulate && !f.card.on_file ? btn('Add test card', (e) => busy(e.currentTarget, async () => { await post('card/test'); toast('Test card added. Any declined payment was tried again.'); await refresh({ keepScroll: true }); }), 'primary') : null,
      f.card.on_file ? btn('Remove card', (e) => { if (confirm(`Remove the ${cardName(f.card)}? You'll need a card again before booking anything that's paid.`)) busy(e.currentTarget, async () => { await api('DELETE', 'card'); toast('Card removed.'); await refresh({ keepScroll: true }); }); }, 'ghost') : null),
    h('p', { class: 'small muted' }, declined.length ? 'Saving a new card tries every declined payment again right away. ' : '', 'Cards are stored by Stripe. Diamond Protocol never sees your full card number.'));

  // Payments and receipts.
  const payRow = (x) => h('div', { class: 'p-row' },
    h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong p-wrap-text' }, x.description), h('span', { class: 'small muted' }, [fmt(x.date, { month: 'short', day: 'numeric', year: 'numeric' }), x.athlete_name, x.method].filter(Boolean).join(' · ')),
      x.fee_cents ? h('span', { class: 'small muted' }, `Includes a ${money(x.fee_cents)} ${x.fee_label.toLowerCase()}`) : null,
      x.refunded_cents ? h('span', { class: 'small good-text' }, `${money(x.refunded_cents)} refunded`) : null),
    h('span', { class: 'strong' }, money(x.amount_cents)),
    x.receipt_url ? h('a', { class: 'dp-btn dp-btn--ghost', href: x.receipt_url, target: '_blank', rel: 'noopener' }, 'Receipt') : x.kind === 'membership' ? btn('Receipt', () => membershipReceipt(x.id), 'ghost') : null);
  const payList = h('div');
  const drawPays = (rows, all) => fill(payList, rows.length ? rows.map(payRow) : h('p', { class: 'muted small' }, 'No payments yet.'),
    !all && payments.total > rows.length ? btn(`Show all ${payments.total}`, (e) => busy(e.currentTarget, async () => drawPays((await get('payments?all=1')).data, true)), 'ghost') : null);
  if (payments) drawPays(payments.data, false);
  const payPanel = payments ? panel('Payments', { subtitle: `Paid in ${payments.year}: ${money(payments.paid_this_year_cents)}` }, payList) : null;

  // Waiver: compact once signed.
  const signed = h('input', { type: 'checkbox', id: 'agree' });
  const sigName = input({ autocomplete: 'name', placeholder: me.name });
  const kids = state.me.athletes.map((a) => a.first_name);
  const waiverPanel = h('section', { class: 'dp-panel stack', id: 'fam-waiver' },
    h('div', null, h('h2', { class: 'dp-panel-title' }, 'Waiver'), h('p', { class: 'dp-panel-sub' }, f.waiver.signed ? `Signed by ${f.waiver.signed_by?.split(' <')[0].replace(/ \(on paper.*$/, ' (on paper)')} on ${fmt(f.waiver.signed_at, { month: 'short', day: 'numeric', year: 'numeric' })}${kids.length ? `. Covers ${kids.join(', ')}.` : '.'}` : 'Required before booking. Covers every athlete in your family.')),
    f.waiver.signed ? [h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Read the waiver'), h('div', { class: 'p-waiver', tabindex: '0' }, state.me.waiver_text)),
      btn('Email me a copy', (e) => busy(e.currentTarget, async () => { const r = await post('waiver/email'); toast(`Sent to ${r.sent_to}.`); }), 'ghost')]
      : [h('div', { class: 'p-waiver', tabindex: '0' }, state.me.waiver_text), h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        await post('waiver', { signed_name: sigName.value, agree: signed.checked }); toast('Waiver signed. You can book now.'); await refresh({ keepScroll: true });
      }); } },
        h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, signed, h('span', null, 'I have read and agree to the waiver for my athletes.')),
        field('Type your full name to sign', sigName), btn('Sign waiver', null, 'primary', { type: 'submit' }))]);

  // Athletes: a summary line, then grouped fields that save in place.
  const athletes = state.me.athletes.map((a) => athleteCard(a));
  const add = addAthleteForm();

  // Texts.
  const phoneText = (p) => (/^\+1\d{10}$/.test(p ?? '') ? `(${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}` : p);
  const phone = input({ type: 'tel', autocomplete: 'tel', inputmode: 'tel', value: phoneText(me.phone) ?? '', placeholder: '(512) 555-0100' });
  const textsPanel = panel('Text messages', { subtitle: me.texts === 'on' ? `On for ${phoneText(me.phone)}. Reminders the day before a session, waitlist spots, cancellations and payment problems.` : 'Get a reminder the day before each session, and a text when a spot opens, a session is canceled or a payment doesn\'t go through.' },
    me.texts === 'stopped' ? h('p', { class: 'small warn-text' }, 'You replied STOP, so texts are off. Turn them on again below, or reply START to our number.') : null,
    me.texts === 'on' ? null : field('Mobile number', phone),
    h('div', { class: 'row wrap' }, me.texts === 'on'
      ? btn('Turn off texts', (e) => busy(e.currentTarget, async () => { await api('PATCH', 'texts', { texts: false }); toast('Texts turned off.'); await refresh({ keepScroll: true }); }), 'secondary')
      : btn('Turn on texts', (e) => busy(e.currentTarget, async () => { await api('PATCH', 'texts', { texts: true, phone: phone.value }); toast('Texts are on. We just sent a confirmation.'); await refresh({ keepScroll: true }); }), 'primary')),
    h('p', { class: 'small muted' }, 'Message and data rates may apply. Message frequency varies. Reply STOP to stop, HELP for help.'));

  const needs = state.me.agreements?.needs ?? [];
  const agreeBox = h('input', { type: 'checkbox' });
  const LABEL = { terms: 'terms of service', privacy: 'privacy policy' };
  const agreementsPanel = needs.length ? h('section', { class: 'dp-panel stack', id: 'fam-terms' }, h('h2', { class: 'dp-panel-title' }, 'Updated terms'), h('p', { class: 'dp-panel-sub' }, 'Please review and accept before your next booking or purchase.'),
    h('label', { class: 'row small', style: 'gap:10px;align-items:flex-start;min-height:44px' }, agreeBox,
      h('span', null, 'I agree to the ', ...needs.flatMap((k, i) => [i ? ' and ' : '', h('a', { href: `/${k}`, target: '_blank' }, LABEL[k])]), '.')),
    btn('Accept', (e) => { if (!agreeBox.checked) return toast('Tick the box first.', 'warn'); busy(e.currentTarget, async () => { await post('agreements', { accept: true }); toast('Thanks.'); await refresh({ keepScroll: true }); }); }, 'primary')) : null;
  const dataPanel = panel('Your data', { subtitle: 'Download everything we hold about your family, or ask us to delete your account.' },
    h('div', { class: 'row wrap' },
      btn('Download my data', (e) => busy(e.currentTarget, async () => {
        const res = await fetch('/portal/api/export', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Download failed. Try again.');
        const url = URL.createObjectURL(await res.blob());
        const a = h('a', { href: url, download: (res.headers.get('content-disposition') ?? '').match(/filename="([^"]+)"/)?.[1] ?? 'family-data.json' }); document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }), 'secondary'),
      state.me.open_deletion_request ? h('span', { class: 'small muted' }, 'Deletion requested. We\'ll email you when it\'s done.')
        : btn('Delete my account', (e) => {
          const note = prompt('We\'ll delete your family\'s account and personal information, and email you when it\'s done. Anything we should know? (optional)', '');
          if (note === null) return;
          busy(e.currentTarget, async () => { await post('deletion-request', { note }); toast('Request sent.'); await refresh({ keepScroll: true }); });
        }, 'ghost')),
    h('p', { class: 'small muted' }, h('a', { href: '/terms', target: '_blank' }, 'Terms of service'), ' · ', h('a', { href: '/privacy', target: '_blank' }, 'Privacy policy')));

  fill(main, top('Family'), lockNote, back, finish, agreementsPanel, cardPanel, payPanel, waiverPanel, h('div', { class: 'dp-label' }, 'Athletes'), athletes, add,
    parentsPanel(), textsPanel, devicesPanel(), dataPanel,
    btn('Sign out', (e) => busy(e.currentTarget, async () => { await post('logout'); state.me = null; render(); }), 'ghost'));
  if (focus) setTimeout(() => scrollTo(focus === 'card' ? 'fam-card' : focus === 'waiver' ? 'fam-waiver' : focus), 50);
}
async function membershipReceipt(id) {
  const r = await get(`payments/membership/${id}`);
  const date = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: r.timezone, month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso));
  openDialog('Receipt', [h('div', { class: 'p-receipt stack-tight' },
    h('strong', null, r.business_name), r.business_address ? h('span', { class: 'small muted', style: 'white-space:pre-wrap' }, r.business_address) : null,
    h('span', null, `${r.description} for ${r.athlete_name}`), h('span', { class: 'small muted' }, `${date(r.period_start)} to ${date(r.period_end)}`),
    h('span', { class: 'strong' }, `Paid ${money(r.amount_cents)} on ${date(r.paid_at)} (${r.method})`),
    r.fee_cents ? h('span', { class: 'small muted' }, `Includes a ${money(r.fee_cents)} ${r.fee_label.toLowerCase()}`) : null,
    r.refunded_cents ? h('span', null, `Refunded ${money(r.refunded_cents)}`) : null, h('span', { class: 'small muted' }, `Receipt ${r.id}`))],
  [btn('Print', () => window.print(), 'secondary')]);
}
// One athlete: age, sport, membership and a Needs badge at a glance; Athlete ID with Copy; grouped fields; Save turns on after a change.
function athleteCard(a) {
  const fields = { name: input({ value: a.name, autocomplete: 'off' }), birth_date: input({ type: 'date', value: a.birth_date ?? '' }), sport: input({ value: a.sport ?? '' }), position: input({ value: a.position ?? '' }), school: input({ value: a.school ?? '' }), grad_year: input({ type: 'number', inputmode: 'numeric', value: a.grad_year ?? '' }),
    medical_notes: h('textarea', { class: 'dp-input', placeholder: 'Allergies, injuries, medications, anything your coach should know' }), emergency_name: input({ value: a.emergency_name ?? '' }), emergency_phone: input({ type: 'tel', inputmode: 'tel', value: a.emergency_phone ?? '' }) };
  fields.medical_notes.value = a.medical_notes ?? '';
  fields.sex = select([['', 'Not set'], ['M', 'Male'], ['F', 'Female']], { value: a.sex ?? '' });
  const needs = !a.emergency_name || !a.emergency_phone || !a.birth_date;
  const save = btn('Save', null, 'primary', { type: 'submit', disabled: true });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const sib = state.me.athletes.find((x) => x.id !== a.id && x.emergency_name && x.emergency_phone);
  const values = () => ({ ...Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim() || null])), name: fields.name.value.trim(), grad_year: fields.grad_year.value ? Number(fields.grad_year.value) : null });
  const start = JSON.stringify(values());
  const form = h('form', { class: 'stack', style: 'margin-top:12px', onInput: () => { save.disabled = JSON.stringify(values()) === start; }, onChange: () => { save.disabled = JSON.stringify(values()) === start; }, onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(save, async () => {
    try { await api('PATCH', `athletes/${a.id}`, values()); openAthletes.add(a.id); toast('Saved.'); await refresh({ keepScroll: true }); }
    catch (x) { err.textContent = x.message; }
  }); } },
    h('div', { class: 'dp-label' }, 'About'), field('Name', fields.name), h('div', { class: 'form-grid' }, field('Birthday', fields.birth_date), field('Sex', fields.sex, 'Only used to estimate growth-spurt timing.')),
    h('div', { class: 'dp-label' }, 'Sport and school'), h('div', { class: 'form-grid' }, field('Sport', fields.sport), field('Position', fields.position)), h('div', { class: 'form-grid' }, field('School', fields.school), field('Grad year', fields.grad_year)),
    h('div', { class: 'dp-label' }, 'Health and emergency'), field('Medical notes', fields.medical_notes),
    h('div', { class: 'form-grid' }, field('Emergency contact', fields.emergency_name), field('Their phone', fields.emergency_phone)),
    sib && (!a.emergency_name || !a.emergency_phone) ? btn(`Copy ${sib.first_name}'s emergency contact`, () => { fields.emergency_name.value = sib.emergency_name; fields.emergency_phone.value = sib.emergency_phone; save.disabled = false; }, 'ghost') : null,
    err, save);
  const m = a.membership;
  return h('details', { class: 'dp-panel p-athlete', id: `ath-${a.id}`, open: openAthletes.has(a.id), onToggle: (e) => { e.currentTarget.open ? openAthletes.add(a.id) : openAthletes.delete(a.id); } },
    h('summary', { class: 'p-athlete-sum' }, h('span', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.name),
      h('span', { class: 'small muted' }, [a.age != null ? `Age ${a.age}` : null, a.sport, m ? `${m.plan_name} (${(STATUS[m.status] ?? m.status).toLowerCase()})` : 'No membership'].filter(Boolean).join(' · '))),
      needs ? h('span', { class: 'dp-badge dp-badge--warn' }, 'Needs info') : null),
    h('div', { class: 'row wrap small', style: 'gap:8px;margin-top:8px' }, a.athlete_id ? ['Athlete ID ', h('button', { type: 'button', class: 'p-id', onClick: () => copy(a.athlete_id, 'Athlete ID copied.') }, a.athlete_id)] : null,
      btn(m ? 'Manage membership' : 'Membership plans', () => { state.athleteId = a.id; go('programs'); }, 'ghost')),
    form);
}
// Add an athlete; if they already have a profile (a team athlete), their Athlete ID links it.
function addAthleteForm() {
  const name = input({ autocomplete: 'off' }), birth = input({ type: 'date' }), sport = input(), code = input({ autocomplete: 'off', autocapitalize: 'characters', placeholder: 'AVALOP2026', maxlength: '14' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  return h('details', { class: 'dp-panel p-athlete' }, h('summary', { class: 'p-athlete-sum strong' }, '+ Add an athlete'),
    h('form', { class: 'stack', style: 'margin-top:12px', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
      try {
        const a = await post('athletes', { name: name.value, birth_date: birth.value || undefined, sport: sport.value || undefined, athlete_code: code.value.trim() || undefined });
        state.athleteId = a.id; openAthletes.add(a.id);
        toast(a.claim === 'attached' ? `${a.first_name} is linked to your family, with their team results.` : a.message ?? `${a.first_name} added.`);
        await refresh({ keepScroll: true });
      } catch (x) { err.textContent = x.message; }
    }); } }, field('Full name', name), h('div', { class: 'form-grid' }, field('Birthday', birth), field('Sport', sport)),
      field('Athlete ID, if they already train with us on a team (optional)', code, 'On their team roster or report. With the same name and birthday, their team results stay on one profile.'),
      err, btn('Add athlete', null, 'secondary', { type: 'submit' })));
}
// Parents: fix your own name and phone; add another parent.
function parentsPanel() {
  const f = state.me.family, me = state.me.guardian;
  const myName = input({ value: me.name, autocomplete: 'name' }), myPhone = input({ type: 'tel', inputmode: 'tel', autocomplete: 'tel', value: me.phone ?? '' });
  const myErr = h('div', { class: 'dp-error', role: 'alert' });
  const mine = h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Edit my name and phone'),
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); myErr.textContent = ''; busy(e.submitter, async () => {
      try { const r = await api('PATCH', 'me', { name: myName.value, phone: myPhone.value || null }); toast(r.texts_turned_off ? 'Saved. Texts are off for the new number until you turn them on.' : 'Saved.'); await refresh({ keepScroll: true }); }
      catch (x) { myErr.textContent = x.message; }
    }); } }, h('div', { class: 'form-grid' }, field('Your name', myName), field('Your phone', myPhone)), h('p', { class: 'small muted', style: 'margin:0' }, 'To change the email you sign in with, ask your coach.'), myErr, btn('Save', null, 'secondary', { type: 'submit' })));
  const n = input({ autocomplete: 'off' }), em = input({ type: 'email', inputmode: 'email', autocomplete: 'off' }), ph = input({ type: 'tel', inputmode: 'tel' }), rel = input({ placeholder: 'Dad, stepmom, grandparent…' });
  const addErr = h('div', { class: 'dp-error', role: 'alert' });
  const adder = f.guardians.length < 6 ? h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, '+ Add another parent'),
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); addErr.textContent = ''; busy(e.submitter, async () => {
      try { await post('guardians', { name: n.value, email: em.value, phone: ph.value || undefined, relationship: rel.value || undefined }); toast(`Added. We emailed ${em.value} how to sign in.`); await refresh({ keepScroll: true }); }
      catch (x) { addErr.textContent = x.message; }
    }); } }, field('Name', n), field('Email', em), h('div', { class: 'form-grid' }, field('Phone (optional)', ph), field('Relationship (optional)', rel)),
      h('p', { class: 'small muted', style: 'margin:0' }, 'They can sign in, book and see progress. The other parents get an email.'), addErr, btn('Add parent', null, 'secondary', { type: 'submit' }))) : h('p', { class: 'small muted' }, 'A family can have up to 6 parents.');
  return panel('Parents', {}, f.guardians.map((g) => h('div', { class: 'p-row' }, h('div', { class: 'grow stack-tight' }, h('span', null, g.name, g.id === me.id ? h('span', { class: 'small muted' }, ' (you)') : null), h('span', { class: 'small muted' }, [g.email, g.phone].filter(Boolean).join(' · '))))), mine, adder);
}
// Devices signed in to this parent's account; sign out everywhere else.
function devicesPanel() {
  const list = h('div', null, h('p', { class: 'muted small' }, 'Loading…'));
  const draw = (rows) => fill(list, rows.map((d) => h('div', { class: 'p-row' }, h('div', { class: 'grow stack-tight' }, h('span', null, d.device, d.current ? h('span', { class: 'small good-text' }, ' · this device') : null),
    h('span', { class: 'small muted' }, `Signed in ${fmt(d.signed_in_at ?? d.last_seen_at ?? new Date().toISOString(), { month: 'short', day: 'numeric' })}${d.last_seen_at ? ` · last used ${fmt(d.last_seen_at, { month: 'short', day: 'numeric' })}` : ''}`)))),
    rows.length > 1 ? btn('Sign out everywhere else', (e) => { if (confirm('Sign out every other phone and computer?')) busy(e.currentTarget, async () => { const r = await post('devices/sign-out-others'); toast(`Signed out ${r.signed_out} ${r.signed_out === 1 ? 'device' : 'devices'}.`); draw(r.devices); }); }, 'secondary') : null);
  get('devices').then((r) => draw(r.data)).catch(() => fill(list));
  return panel('Signed in', { subtitle: 'Phones and computers signed in to your account.' }, list);
}

boot();
