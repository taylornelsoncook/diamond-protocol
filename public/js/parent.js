import { h, fill, toast, money, busy, btn, field, input, select, panel } from './ui.js';
import { sparkline, fmtResult, fmtDate as fmtDay } from './charts.js';
import { createEngage, ENGAGE_TABS, tabIcon, engageDots } from './engage-view.js';

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(`/portal/api/${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !['login', 'verify'].includes(path)) { state.me = null; render(); }
  if (!res.ok) { const e = new Error(data.error?.message || 'Something went wrong. Try again.'); e.status = res.status; throw e; }
  return data;
}
const get = (p) => api('GET', p), post = (p, b = {}) => api('POST', p, b);

const state = { me: null, tab: 'home', athleteId: null, homeTab: 'overview' };
const root = document.getElementById('root');
const athlete = () => state.me.athletes.find((a) => a.id === state.athleteId) ?? state.me.athletes[0];
const fmt = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: state.me?.timezone, ...opts }).format(new Date(iso));
const dayLabel = (iso) => fmt(iso, { weekday: 'long', month: 'short', day: 'numeric' });
const timeLabel = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KIND = { group: 'Group class', clinic: 'Clinic', camp: 'Camp', private: 'Private session', evaluation: 'Evaluation', team: 'Team session' };

async function boot() {
  try { state.me = await get('me'); state.athleteId ??= state.me.athletes[0]?.id; } catch { state.me = null; }
  // Just signed up: go straight to the waiver and card.
  if (state.me && new URLSearchParams(location.search).has('welcome')) { state.tab = 'family'; history.replaceState(null, '', '/parent'); setTimeout(() => toast('Welcome! Sign the waiver and add a card, then you can book.'), 300); }
  render();
}
async function refresh() { state.me = await get('me'); render(); }

function render() {
  if (!state.me) return renderSignIn();
  const views = { home: viewHome, book: viewBook, progress: viewProgress, programs: viewPrograms, family: viewFamily };
  const main = h('main', { class: 'p-wrap' });
  fill(root, main, tabBar());
  views[state.tab](main).catch((e) => fill(main, h('p', { class: 'warn-text' }, e.message)));
  window.scrollTo(0, 0);
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
  return h('div', { class: 'p-chips', role: 'group', 'aria-label': 'Athlete' }, state.me.athletes.map((a) => h('button', { type: 'button', class: 'p-chip', 'aria-pressed': String(a.id === athlete().id), onClick: () => { state.athleteId = a.id; onChange(); } }, a.first_name)));
}

// Setup nudges shown until done: waiver and card.
function banners() {
  const out = [];
  if (!state.me.agreements?.ok) out.push(h('div', { class: 'p-banner' }, h('span', { class: 'grow' }, 'Please review and accept our updated terms.'), btn('Review', () => { state.tab = 'family'; render(); }, 'outline')));
  if (!state.me.family.waiver.signed) out.push(h('div', { class: 'p-banner' }, h('span', { class: 'grow' }, 'Sign the waiver to start booking.'), btn('Sign', () => { state.tab = 'family'; render(); }, 'outline')));
  if (!state.me.family.card.on_file) out.push(h('div', { class: 'p-banner' }, h('span', { class: 'grow' }, 'Add a card to pay for sessions, packs and camps.'), btn('Add card', () => { state.tab = 'family'; render(); }, 'outline')));
  return out;
}

// ---------- Sign in ----------
function renderSignIn() {
  const main = h('main', { class: 'p-wrap', style: 'min-height:100vh;justify-content:center' });
  const email = input({ type: 'email', autocomplete: 'email', inputmode: 'email', required: true });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const send = btn('Email me a sign-in code', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  const stepOne = h('form', { class: 'dp-panel stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(send, async () => {
    try { const r = await post('login', { email: email.value }); stepTwo(email.value, r.dev_code); } catch (x) { err.textContent = x.message; }
  }); } },
    h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.', style: 'width:180px;align-self:center' }),
    h('h1', { class: 'p-title', style: 'text-align:center' }, 'Parent sign-in'),
    h('p', { class: 'muted', style: 'text-align:center' }, 'Use the email your coach has on file. No password needed.'),
    field('Email', email), err, send,
    h('p', { class: 'small muted', style: 'text-align:center;margin:0' }, 'New here? ', h('a', { href: '/join' }, 'Create a family account')));
  fill(root, fill(main, stepOne));
  email.focus();

  function stepTwo(address, devCode) {
    const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', class: 'dp-input p-code', 'aria-label': 'Six-digit code' });
    const err2 = h('div', { class: 'dp-error', role: 'alert' });
    const go = btn('Sign in', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
    fill(main, h('form', { class: 'dp-panel stack', onSubmit: (e) => { e.preventDefault(); err2.textContent = ''; busy(go, async () => {
      try { await post('verify', { email: address, code: code.value }); await boot(); } catch (x) { err2.textContent = x.message; }
    }); } },
      h('h1', { class: 'p-title' }, 'Check your email'),
      h('p', { class: 'muted' }, `We sent a 6-digit code to ${address}. It expires in 10 minutes.`),
      devCode ? h('p', { class: 'test-banner' }, `Test mode: your code is ${devCode}`) : null,
      code, err2, go,
      btn('Use a different email', () => renderSignIn(), 'ghost')));
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
  fill(subtabs, [['overview', 'Overview'], ...ENGAGE_TABS].map(([k, label]) => h('button', { type: 'button', class: 'p-subtab', 'aria-current': state.homeTab === k ? 'page' : null, onClick: () => { state.homeTab = k; render(); } },
    label, dots[k] ? [h('span', { class: 'eg-tab-dot', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, k === 'education' ? ' (new reading)' : ' (new message)')] : null)));
}
async function viewHome(main) {
  subtabs = h('nav', { class: 'p-subtabs', 'aria-label': 'Home sections' });
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
async function viewOverview(main) {
  const cards = state.me.athletes.map((a) => {
    const m = a.membership;
    return panel(null, {},
      h('div', { class: 'row' }, h('div', { class: 'grow stack-tight' }, h('div', { class: 'p-athlete-name' }, a.name), h('span', { class: 'small muted' }, [a.age != null ? `Age ${a.age}` : null, a.sport, a.position].filter(Boolean).join(' · ') || 'Add sport and birthday on the Family tab'),
        a.athlete_id ? h('span', { class: 'small muted' }, 'Athlete ID ', h('span', { style: 'font-family:var(--font-mono);color:var(--steel)' }, a.athlete_id)) : null)),
      h('div', { class: 'p-stats' },
        h('div', { class: 'p-stat' }, h('b', null, m ? (m.status === 'past_due' ? 'Due' : 'Active') : '—'), h('span', null, m ? m.plan_name : 'No membership')),
        h('div', { class: 'p-stat' }, h('b', null, a.credits.group), h('span', null, 'Group classes left')),
        h('div', { class: 'p-stat' }, h('b', null, a.credits.private), h('span', null, 'Privates left'))),
      m?.status === 'past_due' ? h('p', { class: 'small warn-text' }, 'The last membership payment didn\'t go through. Update your card on the Family tab.') : null,
      h('div', { class: 'dp-label' }, 'Coming up'),
      a.upcoming.length ? h('div', null, a.upcoming.slice(0, 6).map((u) => h('div', { class: 'p-row' },
        h('div', { class: 'p-time' }, fmt(u.starts_at, { weekday: 'short' }), h('br'), h('span', { class: 'small muted', style: 'font-family:var(--font-sans)' }, timeLabel(u.starts_at))),
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, u.session_name), h('span', { class: 'small muted' }, `${fmt(u.starts_at, { month: 'short', day: 'numeric' })} · ${u.location_name}${u.status === 'waitlisted' ? ' · Waitlist' : ''}`)),
        u.kind === 'camp' ? null : btn('Cancel', (e) => cancelBooking(e.currentTarget, u), 'ghost'))))
        : h('p', { class: 'muted small' }, 'Nothing booked yet.'),
      a.engagement ? h('div', { class: 'row wrap small' },
        h('span', { class: 'grow muted' }, [a.engagement.checked_in_today ? 'Checked in today' : 'No check-in yet today', a.engagement.unread ? `${a.engagement.unread} new ${a.engagement.unread === 1 ? 'message' : 'messages'}` : null, a.engagement.open_assignments ? `${a.engagement.open_assignments} to read` : null].filter(Boolean).join(' · ')),
        btn(a.engagement.checked_in_today ? 'Accountability' : 'Check in', () => { state.athleteId = a.id; state.homeTab = 'accountability'; render(); }, 'outline')) : null,
      h('div', { class: 'row wrap' }, btn('Book a session', () => { state.athleteId = a.id; state.tab = 'book'; render(); }, 'secondary'),
        a.app_link ? h('a', { class: 'dp-btn dp-btn--ghost', href: a.app_link }, 'Open workouts') : null));
  });
  fill(main, top('Home'), state.me.athletes.length ? subtabs : null, banners(), state.me.athletes.length ? cards : h('div', { class: 'empty' }, 'No athletes yet. Add one on the Family tab.'));
  drawSubtabs();
}

async function cancelBooking(button, u) {
  const hours = state.me.late_cancel_hours;
  const late = Date.parse(u.starts_at) - Date.now() < hours * 3600000;
  if (!confirm(late ? `It's less than ${hours} hours before ${u.session_name}, so the session will still be used. Cancel anyway?` : `Cancel ${u.session_name} on ${dayLabel(u.starts_at)}?`)) return;
  await busy(button, async () => { const r = await post(`bookings/${u.id}/cancel`); toast(r.late ? 'Canceled. The session was still used.' : 'Canceled. Your session was returned.'); await refresh(); });
}

// ---------- Book ----------
async function viewBook(main) {
  const a = athlete();
  if (!a) return fill(main, top('Book'), h('div', { class: 'empty' }, 'Add an athlete on the Family tab first.'));
  const mode = { value: 'classes' };
  const body = h('div', { class: 'stack' });
  const modes = h('div', { class: 'p-chips' }, [['classes', 'Classes'], ['private', 'Private'], ['evaluation', 'Evaluation']].map(([k, label]) =>
    h('button', { type: 'button', class: 'p-chip', 'aria-pressed': String(mode.value === k), onClick: (e) => { mode.value = k; [...modes.children].forEach((c) => c.setAttribute('aria-pressed', String(c === e.currentTarget))); load(); } }, label)));
  fill(main, top('Book'), banners(), athleteChips(() => render()), modes, body);
  load();

  async function load() {
    fill(body, h('p', { class: 'muted' }, 'Loading…'));
    if (mode.value === 'classes') {
      const { data } = await get('schedule');
      const mine = data.filter((s) => { const me = s.athletes.find((x) => x.id === a.id); return me?.eligible || me?.status; });
      if (!mine.length) return fill(body, h('div', { class: 'empty' }, `No open classes for ${a.first_name}'s age in the next 3 weeks.`));
      let lastDay = '';
      fill(body, panel(null, {}, mine.map((s) => {
        const me = s.athletes.find((x) => x.id === a.id);
        const day = dayLabel(s.starts_at);
        const header = day !== lastDay ? h('div', { class: 'p-day' }, (lastDay = day)) : null;
        let action;
        if (me.status === 'booked' || me.status === 'attended') action = h('span', { class: 'dp-badge dp-badge--good' }, 'Booked');
        else if (me.status === 'waitlisted') action = h('span', { class: 'dp-badge dp-badge--neutral' }, 'Waitlist');
        else if (s.registration_only) action = btn('Register', () => { state.tab = 'programs'; render(); }, 'outline');
        else action = btn(s.spots_left ? 'Book' : 'Waitlist', (e) => bookClass(e.currentTarget, s), s.spots_left ? 'primary' : 'secondary');
        return [header, h('div', { class: 'p-row' },
          h('div', { class: 'p-time' }, timeLabel(s.starts_at)),
          h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, s.name), h('span', { class: 'small muted' }, `${s.location_name} · ${s.spots_left ? `${s.spots_left} ${s.spots_left === 1 ? 'spot' : 'spots'} left` : 'Full'}`)),
          action)];
      })));
    } else {
      const { data } = await get(`slots?kind=${mode.value}`);
      if (!data.length) return fill(body, h('div', { class: 'empty' }, `No open ${mode.value === 'private' ? 'private' : 'evaluation'} times in the next 3 weeks. Message your coach.`));
      const byDay = {};
      for (const s of data) (byDay[dayLabel(s.starts_at)] ??= []).push(s);
      fill(body, h('p', { class: 'small muted' }, mode.value === 'private' ? `Uses one private session from ${a.first_name}'s pack.` : `Evaluations${data[0].price_cents ? ` are ${money(data[0].price_cents)}, charged to your card` : ''}. We'll test speed, power and movement and build a plan.`),
        ...Object.entries(byDay).map(([day, slots]) => panel(day, {}, h('div', { class: 'row wrap' }, slots.map((s) => btn(`${timeLabel(s.starts_at)} · ${s.location_name}`, (e) => bookSlot(e.currentTarget, s), 'secondary'))))));
    }
  }

  async function bookClass(button, s) {
    await busy(button, async () => {
      try { const b = await post('bookings', { session_id: s.id, athlete_id: a.id }); toast(b.status === 'waitlisted' ? `${a.first_name} is on the waitlist. We'll email you if a spot opens.` : `${a.first_name} is booked.`); }
      catch (e) { if (e.status !== 402) throw e; if (!(await offerCard(s.drop_in_cents, e.message))) return; const b = await post('bookings', { session_id: s.id, athlete_id: a.id, pay: 'card_on_file' }); toast(`${a.first_name} is booked and paid.`); void b; }
      await refresh();
    });
  }
  async function bookSlot(button, s) {
    if (!confirm(`Book ${a.first_name} for ${dayLabel(s.starts_at)} at ${timeLabel(s.starts_at)}?`)) return;
    await busy(button, async () => {
      const body = { kind: s.kind, starts_at: s.starts_at, availability_id: s.availability_id, athlete_id: a.id };
      try { await post('slots/book', s.kind === 'evaluation' ? { ...body, pay: 'card_on_file' } : body); toast(`${a.first_name} is booked.`); }
      catch (e) { if (e.status !== 402) throw e; if (!(await offerCard(s.price_cents, e.message))) return; await post('slots/book', { ...body, pay: 'card_on_file' }); toast(`${a.first_name} is booked and paid.`); }
      await refresh();
    });
  }
}

// When sessions aren't covered, offer to pay once with the saved card, or point to packs.
async function offerCard(cents, reason) {
  const card = state.me.family.card;
  if (!cents || !card.on_file) {
    toast(card.on_file ? reason : `${reason} Add a card on the Family tab, or buy a pack under Programs.`, 'warn');
    return false;
  }
  return confirm(`${reason}\n\nPay ${money(cents)} with the card ending ${card.last4} instead?`);
}

// ---------- Progress: shared test results ----------
async function viewProgress(main) {
  const a = athlete();
  if (!a) return fill(main, top('Progress'), h('div', { class: 'empty' }, 'Add an athlete on the Family tab first.'));
  const r = await get(`athletes/${a.id}/report`);
  const PHASE = { before: 'Before the growth spurt', during: 'In the growth spurt', after: 'Past the growth spurt' };
  const g = r.growth;
  fill(main, top('Progress'), athleteChips(() => render()),
    !r.tests.length ? h('div', { class: 'empty' }, `No results shared for ${a.first_name} yet. Your coach will let you know when testing results are ready.`) : [
      r.latest_session?.parent_note ? panel(`From your coach`, { subtitle: `${r.latest_session.name} · ${fmtDay(r.latest_session.date)}` }, h('p', { style: 'white-space:pre-wrap;margin:0' }, r.latest_session.parent_note)) : null,
      r.highlights.length ? panel('Biggest improvements', {}, h('div', { class: 'p-stats' }, r.highlights.map((t) => h('div', { class: 'p-stat' }, h('b', { style: 'color:var(--green-bright)' }, `+${t.improvement_pct}%`), h('span', null, t.test_name.replace(/\s*\(.*\)$/, '')))))) : null,
      r.new_prs.length ? h('p', { class: 'small' }, h('strong', null, 'New PRs: '), r.new_prs.join(', ')) : null,
      panel('Every test', { subtitle: 'Best result and change since the first test.' }, r.tests.map((t) => h('div', { class: 'p-row' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, `${t.test_name.replace(/\s*\(.*\)$/, '')}${t.side ? ` (${t.side === 'L' ? 'L' : 'R'})` : ''}`),
          h('span', { class: 'small muted' }, t.tests_count > 1 ? `${fmtResult(t.first.value, t.unit, t.decimals)} → ${fmtResult(t.latest.value, t.unit, t.decimals)}` : `First test ${fmtDay(t.latest.date)}`)),
        h('span', { style: 'color:var(--green-bright)' }, sparkline(t.history, { better: t.better, width: 72, height: 28, label: `${t.test_name} trend` })),
        h('div', { style: 'text-align:right;min-width:78px' }, h('div', { class: 'strong' }, fmtResult(t.best, t.unit, t.decimals)),
          t.tests_count > 1 ? h('div', { class: `small ${t.improved ? 'good-text' : 'muted'}` }, `${t.improvement_pct > 0 ? '+' : ''}${t.improvement_pct}%`) : null)))),
      g.latest_height || g.estimate ? panel('Growth', {},
        h('div', { class: 'p-stats' },
          g.latest_height ? h('div', { class: 'p-stat' }, h('b', null, fmtResult(g.latest_height.value, 'in', 1)), h('span', null, 'Height')) : null,
          g.growth_per_year ? h('div', { class: 'p-stat' }, h('b', null, `${g.growth_per_year.toFixed(1)}″`), h('span', null, 'Growth per year')) : null,
          g.estimate ? h('div', { class: 'p-stat' }, h('b', { style: 'font-size:18px' }, PHASE[g.estimate.phase]), h('span', null, `Estimated peak around age ${g.estimate.peak_age}`)) : null),
        g.estimate ? h('p', { class: 'small muted' }, `${g.estimate.text} This is an estimate and can be off by about a year.`) : g.missing.length ? h('p', { class: 'small muted' }, `Add ${g.missing.filter((m) => ['birthday', 'sex'].includes(m)).join(' and ') || 'more measurements'} on the Family tab to see a growth-spurt estimate.`) : null) : null,
      h('a', { class: 'dp-btn dp-btn--secondary', href: `/report.html?athlete=${a.id}` }, 'Printable report')
    ]);
}

// ---------- Programs: standing spots, camps, packs, memberships ----------
async function viewPrograms(main) {
  const a = athlete();
  const [{ data: progs }, store] = await Promise.all([get('programs'), get('store')]);
  // Only show what fits this athlete's age (when we know it).
  const fits = (p) => a?.age == null || ((p.age_min == null || a.age >= p.age_min) && (p.age_max == null || a.age <= p.age_max));
  const groups = progs.filter((p) => p.kind === 'group' && fits(p)), camps = progs.filter((p) => p.kind !== 'group' && fits(p));
  const when = (p) => `${dayList(p.weekdays)} · ${fmtTime(p.start_time)} · ${p.duration_min} min`;
  const ages = (p) => (p.age_min || p.age_max ? ` · Ages ${p.age_min ?? ''}–${p.age_max ?? ''}` : '');
  const enrolledIn = (id) => a?.enrollments.some((e) => e.series_id === id);

  const campPanel = panel('Camps & clinics', { subtitle: 'One registration covers every day.' }, camps.length ? camps.map((p) => h('div', { class: 'p-row' },
    h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'small muted' }, `${fmtDate(p.start_date)}–${fmtDate(p.end_date)} · ${when(p)}${ages(p)}`), p.description ? h('span', { class: 'small muted' }, p.description) : null),
    enrolledIn(p.id) ? h('span', { class: 'dp-badge dp-badge--good' }, 'Registered') : btn(p.registration_cents ? `Register · ${money(p.registration_cents)}` : 'Register', (e) => {
      if (!state.me.family.card.on_file && p.registration_cents) return toast('Add a card on the Family tab to register.', 'warn');
      if (!confirm(`Register ${a.first_name} for ${p.name}${p.registration_cents ? ` and charge ${money(p.registration_cents)} to the card ending ${state.me.family.card.last4}` : ''}?`)) return;
      busy(e.currentTarget, async () => { await post(`programs/${p.id}/enroll`, { athlete_id: a.id }); toast(`${a.first_name} is registered.`); await refresh(); });
    }))) : h('p', { class: 'muted small' }, 'No camps or clinics open for this age right now.'));

  const member = a?.membership && a.membership.status !== 'canceled';
  const groupPanel = panel('Weekly group classes', { subtitle: member ? 'Hold a standing spot and you\'re booked every week.' : 'Standing spots come with a membership. Or book single classes on the Book tab.' },
    groups.length ? groups.map((p) => h('div', { class: 'p-row' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'small muted' }, `${when(p)} · ${p.location_name}${ages(p)}`)),
      enrolledIn(p.id) ? btn('Leave', (e) => { if (confirm(`Give up ${a.first_name}'s standing spot in ${p.name}?`)) busy(e.currentTarget, async () => { await api('DELETE', `programs/${p.id}/enroll/${a.id}`); toast('Standing spot released.'); await refresh(); }); }, 'ghost')
        : member ? btn('Hold a spot', (e) => busy(e.currentTarget, async () => { await post(`programs/${p.id}/enroll`, { athlete_id: a.id }); toast(`${a.first_name} has a standing spot.`); await refresh(); }), 'secondary') : null)) : h('p', { class: 'muted small' }, 'No weekly classes yet.'));

  const buy = (label, cents, fn) => btn(`${label} · ${money(cents)}`, (e) => {
    if (!state.me.family.card.on_file) return toast('Add a card on the Family tab first.', 'warn');
    if (!confirm(`Charge ${money(cents)} to the card ending ${state.me.family.card.last4}?`)) return;
    busy(e.currentTarget, fn);
  }, 'secondary');
  const storePanel = panel('Packs & memberships', { subtitle: `For ${a?.first_name ?? 'your athlete'}` },
    ...store.plans.map((p) => h('div', { class: 'p-row' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'small muted' }, `${money(p.price_cents)} a month${p.trial_days ? ` · ${p.trial_days}-day free trial` : ''}`)),
      member ? null : buy('Start', p.price_cents, async () => { await post('membership', { plan_id: p.id, athlete_id: a.id }); toast('Membership started.'); await refresh(); }))),
    ...store.products.map((p) => h('div', { class: 'p-row' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'small muted' }, p.kind === 'pack' ? `${p.sessions} ${p.credit_type} sessions` : `1 ${p.credit_type} session`)),
      buy('Buy', p.price_cents, async () => { await post('purchase', { product_id: p.id, athlete_id: a.id }); toast('Added to your account.'); await refresh(); }))));

  fill(main, top('Programs'), banners(), athleteChips(() => render()), a ? [campPanel, groupPanel, storePanel] : h('div', { class: 'empty' }, 'Add an athlete on the Family tab first.'));
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
async function viewFamily(main) {
  const f = state.me.family;
  const cardPanel = panel('Card on file', { subtitle: 'Used for memberships, packs, camps and drop-ins for everyone in your family.' },
    f.card.on_file ? h('p', null, `${(f.card.brand || 'Card').replace(/^./, (x) => x.toUpperCase())} ending ${f.card.last4}`) : h('p', { class: 'muted' }, 'No card yet.'),
    h('div', { class: 'row wrap' },
      state.me.payments.provider === 'stripe' ? btn(f.card.on_file ? 'Replace card' : 'Add card', (e) => busy(e.currentTarget, async () => { const { url } = await post('card/setup-link'); location.href = url; }), 'primary') : null,
      state.me.payments.can_simulate && !f.card.on_file ? btn('Add test card', (e) => busy(e.currentTarget, async () => { await post('card/test'); toast('Test card added.'); await refresh(); }), 'primary') : null),
    h('p', { class: 'small muted' }, 'Cards are stored by Stripe. Diamond Protocol never sees your full card number.'));

  const signed = h('input', { type: 'checkbox', id: 'agree' });
  const sigName = input({ autocomplete: 'name', placeholder: state.me.guardian.name });
  const waiverPanel = panel('Waiver', { subtitle: f.waiver.signed ? `Signed by ${f.waiver.signed_by?.split(' <')[0]} on ${new Date(f.waiver.signed_at).toLocaleDateString()}` : 'Required before booking. Covers every athlete in your family.' },
    h('div', { class: 'p-waiver', tabindex: '0' }, state.me.waiver_text),
    f.waiver.signed ? null : h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      await post('waiver', { signed_name: sigName.value, agree: signed.checked }); toast('Waiver signed. You can book now.'); await refresh();
    }); } },
      h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, signed, h('span', null, 'I have read and agree to the waiver for my athletes.')),
      field('Type your full name to sign', sigName), btn('Sign waiver', null, 'primary', { type: 'submit' })));

  const athletes = state.me.athletes.map((a) => {
    const fields = { name: input({ value: a.name }), birth_date: input({ type: 'date', value: a.birth_date ?? '' }), sport: input({ value: a.sport ?? '' }), position: input({ value: a.position ?? '' }), school: input({ value: a.school ?? '' }), grad_year: input({ type: 'number', inputmode: 'numeric', value: a.grad_year ?? '' }),
      medical_notes: h('textarea', { class: 'dp-input', placeholder: 'Allergies, injuries, medications, anything your coach should know' }), emergency_name: input({ value: a.emergency_name ?? '' }), emergency_phone: input({ type: 'tel', value: a.emergency_phone ?? '' }) };
    fields.medical_notes.value = a.medical_notes ?? '';
    fields.sex = select([['', 'Not set'], ['M', 'Male'], ['F', 'Female']], { value: a.sex ?? '' });
    return h('details', { class: 'dp-panel' }, h('summary', { class: 'strong', style: 'cursor:pointer;min-height:32px' }, a.name),
      h('form', { class: 'stack', style: 'margin-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        await api('PATCH', `athletes/${a.id}`, { ...Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value || null])), name: fields.name.value, grad_year: fields.grad_year.value ? Number(fields.grad_year.value) : null });
        toast('Saved.'); await refresh();
      }); } },
        field('Name', fields.name), h('div', { class: 'form-grid' }, field('Birthday', fields.birth_date), field('Sport', fields.sport)),
        h('div', { class: 'form-grid' }, field('Position', fields.position), field('Grad year', fields.grad_year)), h('div', { class: 'form-grid' }, field('School', fields.school), field('Sex', fields.sex, 'Only used to estimate growth-spurt timing.')),
        field('Medical notes', fields.medical_notes), h('div', { class: 'form-grid' }, field('Emergency contact', fields.emergency_name), field('Their phone', fields.emergency_phone)),
        btn('Save', null, 'primary', { type: 'submit' })));
  });
  const newName = input(), newBirth = input({ type: 'date' }), newSport = input();
  const addAthlete = h('details', { class: 'dp-panel' }, h('summary', { class: 'strong', style: 'cursor:pointer;min-height:32px' }, '+ Add an athlete'),
    h('form', { class: 'stack', style: 'margin-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const a = await post('athletes', { name: newName.value, birth_date: newBirth.value || undefined, sport: newSport.value || undefined }); state.athleteId = a.id; toast(`${a.first_name} added.`); await refresh();
    }); } }, field('Full name', newName), h('div', { class: 'form-grid' }, field('Birthday', newBirth), field('Sport', newSport)), btn('Add athlete', null, 'secondary', { type: 'submit' })));

  const needs = state.me.agreements?.needs ?? [];
  const agreeBox = h('input', { type: 'checkbox' });
  const LABEL = { terms: 'terms of service', privacy: 'privacy policy' };
  const agreementsPanel = needs.length ? panel('Updated terms', { subtitle: 'Please review and accept before your next booking or purchase.' },
    h('label', { class: 'row small', style: 'gap:10px;align-items:flex-start;min-height:44px' }, agreeBox,
      h('span', null, 'I agree to the ', ...needs.flatMap((k, i) => [i ? ' and ' : '', h('a', { href: `/${k}`, target: '_blank' }, LABEL[k])]), '.')),
    btn('Accept', (e) => { if (!agreeBox.checked) return toast('Tick the box first.', 'warn'); busy(e.currentTarget, async () => { await post('agreements', { accept: true }); toast('Thanks.'); await refresh(); }); }, 'primary')) : null;
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
          busy(e.currentTarget, async () => { await post('deletion-request', { note }); toast('Request sent.'); await refresh(); });
        }, 'ghost')),
    h('p', { class: 'small muted' }, h('a', { href: '/terms', target: '_blank' }, 'Terms of service'), ' · ', h('a', { href: '/privacy', target: '_blank' }, 'Privacy policy')));

  fill(main, top('Family'), agreementsPanel, cardPanel, waiverPanel, h('div', { class: 'dp-label' }, 'Athletes'), athletes, addAthlete,
    panel('Parents', {}, f.guardians.map((g) => h('div', { class: 'p-row' }, h('div', { class: 'grow stack-tight' }, h('span', null, g.name), h('span', { class: 'small muted' }, g.email)))), h('p', { class: 'small muted' }, 'To add another parent, ask your coach.')),
    dataPanel,
    btn('Sign out', (e) => busy(e.currentTarget, async () => { await post('logout'); state.me = null; render(); }), 'ghost'));
}

boot();
