// Home: tabs for Overview (each athlete at a glance, what's coming up, a way to cancel) and the
// Accountability, Performance and Education views shared with the athlete app (public/js/engage-view.js).
import { html, raw, mount, api, toast, toastError, modal, money, plural } from '/js/ui.js';
import { createEngage, engageDots, tabIcon, ENGAGE_TABS } from '/js/engage-view.js';
import { header, weekday, clock, dayShort, dayLong } from '../common.js';

const TABS = [{ id: 'overview', label: 'Overview', icon: 'home' }, ...ENGAGE_TABS];
// One engage view per athlete while Home is open, so switching athletes back and forth is instant.
const views = new Map();

const STATUS = { active: 'Active', trial: 'Trial', past_due: 'Past due', paused: 'Paused' };
const SHOWN = 4; // sessions listed per athlete before "Show all"
const INSTALL_KEY = 'dp_parent_install_hidden';
const svg = (d, size = 18) => raw(`<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true"><path d="${d}"/></svg>`);
const CAL_ADD = 'M3 4h14v13H3zM3 8h14M7 2v4M13 2v4M10 10v5M7.5 12.5h5';
const SHARE = 'M10 12V2M6 6l4-4 4 4M5 9H3v9h14V9h-2';

// ---- dates: local wall-clock strings like "2026-09-28T16:30" ----
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plusDays = (day, n) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
function dayWord(s) {
  const d = s.slice(0, 10), t = ymd(new Date());
  return d === t ? 'Today' : d === plusDays(t, 1) ? 'Tomorrow' : weekday(s);
}
function endClock(b) { const d = new Date(b.starts_at + ':00'); d.setMinutes(d.getMinutes() + (b.duration_min || 60)); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
const timeRange = (b) => `${clock(b.starts_at)} to ${endClock(b)}`;
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
function renewText(m) {
  if (!m?.next_charge) return '';
  const d = dayShort(m.next_charge);
  return m.status === 'trial' ? `Trial ends ${d}` : m.status === 'active' ? `Renews ${d}` : '';
}

// "MM/YY" (also "M/YY" or "MM/YYYY", as a card reader may store it) -> 'expired' | 'soon' (this month or next) | null
export function cardState(exp, now = new Date()) {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/.exec(exp || '');
  if (!m || +m[1] < 1 || +m[1] > 12) return null;
  const year = +m[2] < 100 ? 2000 + +m[2] : +m[2];
  const end = year * 12 + (+m[1] - 1);
  const cur = now.getFullYear() * 12 + now.getMonth();
  return end < cur ? 'expired' : end - cur <= 1 ? 'soon' : null;
}

function coverageText(b) {
  if (b.status === 'waitlist') return 'Nothing is charged unless a spot opens.';
  switch (b.coverage) {
    case 'member': return 'Covered by the membership.';
    case 'credit': return 'Uses a session from a pack.';
    case 'paid': return b.paid_cents ? `Drop-in, ${money(b.paid_cents)} paid with the card on file.` : 'Drop-in.';
    case 'registered': return 'Part of the camp registration.';
    case 'team': return 'Covered by the team.';
    case 'unpaid': return 'Not paid yet. Pay at the front desk.';
    default: return '';
  }
}
function mapLink(b) {
  const q = encodeURIComponent([b.location, b.address].filter(Boolean).join(', '));
  if (!q) return null;
  return /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent) ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function stats(a) {
  const m = a.membership;
  const unlimited = a.member_left === 'unlimited';
  const memberLeft = Number(a.member_left) || 0;
  const groupLeft = unlimited ? null : memberLeft + (a.group_credits || 0);
  const groupNote = !unlimited && memberLeft > 0 && a.group_credits > 0 ? `${memberLeft} this month, ${a.group_credits} from packs` : null;
  const groupLabel = unlimited ? 'Group classes' : memberLeft > 0 && !a.group_credits ? 'Group classes left this month' : 'Group classes left';
  const renew = renewText(m);
  return html`<div class="stats">
    <div class="stat"><div class="stat-v word ${m?.status === 'past_due' ? 'warn' : ''}">${m ? STATUS[m.status] || m.status : 'None'}</div>
      <div class="stat-l">${m ? m.plan_name : 'No membership'}${renew ? html`<br>${renew}` : ''}</div></div>
    <div class="stat"><div class="stat-v ${unlimited ? 'word' : ''}">${unlimited ? 'Unlimited' : groupLeft}</div>
      <div class="stat-l">${groupLabel}${groupNote ? html`<br>${groupNote}` : ''}</div></div>
    <div class="stat"><div class="stat-v">${a.private_credits || 0}</div><div class="stat-l">Privates left</div></div>
  </div>`;
}

function attendanceLine(a) {
  const at = a.attendance;
  if (!at) return '';
  if (!at.last_at) return html`<p class="a-meta">No sessions attended yet.</p>`;
  return html`<p class="a-meta">${plural(at.last_30, 'session')} in the last 30 days · last on ${weekday(at.last_at)}, ${dayShort(at.last_at)}</p>`;
}

function sessionRow(b, hidden) {
  const tags = [
    b.started ? html`<span class="badge badge-good">${b.checked_in ? 'Checked in' : 'On now'}</span>` : '',
    b.status === 'waitlist' ? html`<span class="badge badge-neutral">Waitlist${b.waitlist_pos ? ` · ${ordinal(b.waitlist_pos)} in line` : ''}</span>` : '',
    b.late && !b.started ? html`<span class="s-late">Inside the late-cancel window</span>` : '',
  ].filter(Boolean);
  return html`<div class="s-row" ${hidden ? raw('hidden data-more') : ''}>
    <div class="s-when">${dayWord(b.starts_at)}<span>${clock(b.starts_at)}</span></div>
    <div class="s-main"><button type="button" class="s-open" data-open="${b.id}" aria-label="${b.name}, ${dayLong(b.starts_at)} at ${clock(b.starts_at)}. Details">
      <span class="s-name">${b.name}</span>
      <span class="s-meta">${dayShort(b.starts_at)}${b.location ? ` · ${b.location}` : ''}${b.coach ? ` · ${b.coach}` : ''}</span></button>
      ${tags.length ? html`<div class="s-tags">${tags}</div>` : ''}</div>
    <div class="s-act">${b.started ? '' : html`<button class="btn btn-ghost btn-sm" data-cancel="${b.id}" aria-label="${b.status === 'waitlist' ? 'Leave the waitlist for' : 'Cancel'} ${b.name} on ${dayShort(b.starts_at)}">${b.status === 'waitlist' ? 'Leave' : 'Cancel'}</button>`}</div>
  </div>`;
}

export async function render(ctx) {
  const { me } = ctx;
  let tab = TABS.some((t) => t.id === ctx.query.tab) ? ctx.query.tab : 'overview';
  let selected = ctx.athlete?.id ?? me.athletes[0]?.id ?? null;
  const viewFor = (id) => {
    if (!views.has(id)) views.set(id, createEngage({ base: `/parent/athletes/${id}`, audience: 'parent', onData: () => paint() }));
    return views.get(id);
  };
  views.clear(); // fresh data each time Home opens

  mount(ctx.el, html`${header('Home', ctx.familyName)}
    <nav class="tabs eg-tabs" id="home-tabs" aria-label="Home sections"></nav>
    <div class="stack" id="home-body"></div>`);
  const tabsEl = ctx.el.querySelector('#home-tabs');
  const body = ctx.el.querySelector('#home-body');

  function anyDot(which) { return me.athletes.some((a) => engageDots(views.get(a.id)?.data)[which]); }
  function paint() {
    if (!ctx.isCurrent() || !tabsEl.isConnected) return;
    mount(tabsEl, TABS.map((t) => html`<button type="button" data-tab="${t.id}" ${t.id === tab ? raw('aria-current="page"') : ''}>
      ${tabIcon(t.icon, 20)}<span>${t.label}${anyDot(t.id) ? html`<span class="eg-dot" aria-hidden="true"></span><span class="sr-only">${t.id === 'education' ? ', something assigned' : ', new message'}</span>` : ''}</span></button>`));
    const sw = body.querySelector('#eg-switch');
    if (sw) paintSwitch(sw);
    body.querySelectorAll('[data-notes]').forEach(paintNotes);
  }
  function paintSwitch(sw) {
    mount(sw, html`<span class="label" id="eg-switch-l">Athlete</span>
      <div class="seg" role="group" aria-labelledby="eg-switch-l">${me.athletes.map((a) => {
        const d = engageDots(views.get(a.id)?.data);
        const dotOn = tab === 'accountability' ? d.accountability : tab === 'education' ? d.education : false;
        return html`<button type="button" data-athlete-sw="${a.id}" aria-pressed="${String(a.id === selected)}">${a.first_name}${dotOn ? html`<span class="eg-dot" aria-hidden="true"></span><span class="sr-only"> (new)</span>` : ''}</button>`;
      })}</div>`);
  }
  // What needs a look for one athlete on the Overview: new coach messages, work assigned, today's check-in.
  function paintNotes(box) {
    const id = Number(box.dataset.notes);
    const d = views.get(id)?.data;
    if (!d) return;
    const a = me.athletes.find((x) => x.id === id);
    const unread = d.accountability?.unread || 0;
    const todo = (d.education?.assigned || []).filter((x) => !x.done);
    const overdue = todo.filter((x) => x.overdue).length;
    const rows = [
      unread ? html`<div class="note-row"><span>${unread === 1 ? 'A new message' : `${unread} new messages`} from ${a.first_name}'s coach</span><button type="button" class="btn btn-sm" data-go="accountability" data-for="${id}">Read</button></div>` : '',
      todo.length ? html`<div class="note-row ${overdue ? 'warn' : ''}"><span>${plural(todo.length, 'lesson')} to do${overdue ? `, ${overdue} overdue` : ''}</span><button type="button" class="btn btn-sm" data-go="education" data-for="${id}">Open</button></div>` : '',
      d.accountability && !d.accountability.checkin_today ? html`<div class="note-row quiet"><span>No check-in yet today</span><button type="button" class="btn btn-ghost btn-sm" data-go="accountability" data-for="${id}">Check in</button></div>` : '',
    ].filter(Boolean);
    mount(box, rows);
    box.hidden = !rows.length;
  }
  function open(which, athleteId) {
    tab = which;
    if (athleteId) { selected = athleteId; ctx.setAthlete(athleteId); }
    history.replaceState({}, '', tab === 'overview' ? '/parent' : `/parent?tab=${tab}`);
    paint();
    show();
    if (athleteId) window.scrollTo(0, 0);
  }
  async function show() {
    if (tab === 'overview') { await overview(ctx, body); paint(); return; }
    if (!selected) { mount(body, html`<div class="empty">No athletes on this account yet. <a href="/parent/family#add-athlete">Add an athlete</a>.</div>`); return; }
    const v = viewFor(selected);
    mount(body, html`${me.athletes.length > 1 ? html`<div class="eg-switch" id="eg-switch"></div>` : ''}
      <div class="eg-view" id="eg-body"></div>`);
    const sw = body.querySelector('#eg-switch');
    if (sw) paintSwitch(sw);
    const target = body.querySelector('#eg-body');
    if (!v.data) {
      v.render(target, tab); // loading state
      try { await v.load(); } catch (e) { if (ctx.isCurrent()) mount(target, html`<div class="banner">${e.message || 'Could not load this. Try again.'}</div>`); return; }
      if (!ctx.isCurrent() || !target.isConnected || v !== viewFor(selected)) return;
    }
    v.render(target, tab);
  }

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    if (b.dataset.tab === tab) { views.get(selected)?.closeReader(); }
    open(b.dataset.tab);
  });
  body.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { views.get(Number(g.dataset.for))?.closeReader(); open(g.dataset.go, Number(g.dataset.for)); return; }
    const b = e.target.closest('[data-athlete-sw]');
    if (!b) return;
    selected = Number(b.dataset.athleteSw);
    ctx.setAthlete(selected);
    views.get(selected)?.closeReader();
    show();
  });

  paint();
  await show();
  // Load everyone's data in the background so the tabs can show dots for new messages and assignments.
  for (const a of me.athletes) { const v = viewFor(a.id); if (!v.data) v.load().catch(() => {}); }
}

async function overview(ctx, el) {
  const { me } = ctx;
  mount(el, html`<div class="muted" aria-busy="true" style="padding:24px 0">Loading…</div>`);
  const bookings = await api.get('/parent/bookings');
  if (!ctx.isCurrent() || !el.isConnected) return;
  const f = me.family;
  const pastDue = me.athletes.filter((a) => a.membership?.status === 'past_due');
  const card = cardState(f.card_exp);
  const names = (list) => list.map((a) => a.first_name).join(' and ');
  const banners = [
    !f.waiver_current ? html`<div class="banner"><span>${f.waiver_version ? 'The waiver has changed. Sign the new one before the next session.' : 'Sign the waiver before the first session.'}</span><a class="btn btn-warn btn-sm" href="/parent/family#waiver">Sign waiver</a></div>` : '',
    !f.card_last4 ? html`<div class="banner"><span>Add a card for drop-ins, packs, camps and memberships.</span><a class="btn btn-warn btn-sm" href="/parent/card">Add card</a></div>` : '',
    pastDue.length && f.card_last4 ? html`<div class="banner"><span>${names(pastDue)}'s membership payment was declined. Update the card to keep booking.</span><a class="btn btn-warn btn-sm" href="/parent/card">Update card</a></div>` : '',
    f.card_last4 && !pastDue.length && card === 'expired' ? html`<div class="banner"><span>The ${f.card_label} expired (${f.card_exp}). Add a new card so payments keep working.</span><a class="btn btn-warn btn-sm" href="/parent/card">Update card</a></div>` : '',
    f.card_last4 && !pastDue.length && card === 'soon' ? html`<div class="banner"><span>The ${f.card_label} expires at the end of ${f.card_exp}. Update it before then so nothing is missed.</span><a class="btn btn-warn btn-sm" href="/parent/card">Update card</a></div>` : '',
  ];
  const installOk = () => !ctx.install.standalone() && !hiddenInstall() && (ctx.install.canPrompt() || ctx.install.ios());

  mount(el, html`${banners}
    ${me.athletes.length ? '' : html`<div class="empty">No athletes on this account yet. <a href="/parent/family#add-athlete">Add an athlete</a>.</div>`}
    ${me.athletes.map((a) => {
      const mine = bookings.filter((b) => b.athlete_id === a.id);
      return html`<section class="panel" aria-labelledby="a-${a.id}">
        <div><h2 class="a-name" id="a-${a.id}">${a.first_name} ${a.last_name}</h2>
          <p class="a-meta">${[a.age != null ? `Age ${a.age}` : null, a.sport, a.position].filter(Boolean).join(' · ')}</p>
          <p class="a-meta">Athlete ID <span class="mono">${a.code}</span></p>
          ${attendanceLine(a)}</div>
        ${stats(a)}
        <div class="note-rows" data-notes="${a.id}" hidden></div>
        <h3 class="sec-label">Coming up${mine.length ? html` <span class="muted">· ${mine.length}</span>` : ''}</h3>
        ${mine.length ? html`<div class="list" id="up-${a.id}">${mine.map((b, i) => sessionRow(b, i >= SHOWN))}</div>
          ${mine.length > SHOWN ? html`<button type="button" class="btn btn-ghost btn-sm s-more" data-more-for="${a.id}" aria-controls="up-${a.id}" aria-expanded="false">Show all ${mine.length} sessions</button>` : ''}`
          : html`<p class="muted" style="margin:0">Nothing booked yet.</p>`}
        <div class="btn-row">
          <a class="btn" href="/parent/book?athlete=${a.id}">Book a session</a>
          ${a.workout_token && a.has_program ? html`<a class="btn btn-ghost" href="/w/${a.workout_token}">Open workouts</a>` : ''}
        </div>
      </section>`;
    })}
    ${me.athletes.length ? html`<section class="panel p-mini" aria-labelledby="cal-h">
      <div class="grow"><h2 class="panel-title" id="cal-h">Sessions in your calendar</h2>
        <p class="muted" style="margin:0">Every booking shows up in your phone's calendar and stays up to date when plans change.</p></div>
      <button type="button" class="btn" id="cal-open">${svg(CAL_ADD)} Add to calendar</button></section>` : ''}
    <div id="install-slot"></div>`);

  el.querySelectorAll('[data-more-for]').forEach((btn) => {
    btn.onclick = () => {
      const list = el.querySelector(`#up-${btn.dataset.moreFor}`);
      const opening = btn.getAttribute('aria-expanded') !== 'true';
      list.querySelectorAll('[data-more]').forEach((r) => { r.hidden = !opening; });
      btn.setAttribute('aria-expanded', String(opening));
      btn.textContent = opening ? 'Show fewer' : `Show all ${list.children.length} sessions`;
    };
  });

  async function cancel(b) {
    const a = me.athletes.find((x) => x.id === b.athlete_id);
    const when = `${dayLong(b.starts_at)} at ${clock(b.starts_at)}`;
    let body, label = 'Cancel booking', kind = 'primary';
    if (b.status === 'waitlist') { body = html`<p style="margin:0">Take ${a.first_name} off the waitlist for ${b.name} on ${when}?</p>`; label = 'Leave waitlist'; }
    else if (b.late) {
      body = html`<div class="banner" style="display:block">This session starts within ${me.settings.late_cancel_hours} hours, so it still counts as used.</div>
        <p style="margin:0">Cancel ${a.first_name}'s spot in ${b.name} on ${when} anyway? The spot goes to the next athlete on the waitlist.</p>`;
      label = 'Cancel anyway'; kind = 'warn';
    } else {
      const back = b.coverage === 'credit' ? ' The session goes back on your account.' : b.coverage === 'paid' && b.paid_cents ? ' The drop-in is refunded to your card.' : b.coverage === 'member' ? " It won't count against the membership." : '';
      body = html`<p style="margin:0">Cancel ${a.first_name}'s spot in ${b.name} on ${when}?${back}</p>`;
    }
    const ok = await modal({ title: b.status === 'waitlist' ? 'Leave waitlist' : 'Cancel booking', body, actions: [{ label: 'Keep it', value: false }, { label, value: true, kind }] });
    if (!ok) return;
    try {
      const r = await api.del(`/parent/bookings/${b.id}`);
      toast(r.late ? 'Cancelled. The session still counts as used.' : b.status === 'waitlist' ? 'Off the waitlist.' : `Cancelled. ${a.first_name}'s spot is free for someone else.`);
      ctx.reload();
    } catch (e) { toastError(e); }
  }

  async function details(b) {
    const a = me.athletes.find((x) => x.id === b.athlete_id);
    const map = mapLink(b);
    const cov = coverageText(b);
    const act = await modal({
      title: b.name,
      body: html`<dl class="s-detail">
          <dt>Athlete</dt><dd>${a.first_name} ${a.last_name}</dd>
          <dt>When</dt><dd>${dayLong(b.starts_at)}<br>${timeRange(b)}</dd>
          ${b.location ? html`<dt>Where</dt><dd>${b.location}${b.address ? html`<br><span class="muted">${b.address}</span>` : ''}</dd>` : ''}
          ${b.coach ? html`<dt>Coach</dt><dd>${b.coach}</dd>` : ''}
          ${b.status === 'waitlist' ? html`<dt>Status</dt><dd>On the waitlist${b.waitlist_pos ? `, ${ordinal(b.waitlist_pos)} in line` : ''}. If a spot opens, ${a.first_name} is booked automatically and you get an email.</dd>` : ''}
          ${cov ? html`<dt>Payment</dt><dd>${cov}</dd>` : ''}
        </dl>
        ${b.late && !b.started ? html`<p class="hint" style="margin:0">It starts within ${me.settings.late_cancel_hours} hours, so cancelling now still counts as used.</p>` : ''}
        <div class="btn-row">
          <a class="btn btn-sm" href="/api/parent/bookings/${b.id}/ics" download="session.ics">${svg(CAL_ADD)} Add to calendar</a>
          ${map ? html`<a class="btn btn-sm btn-ghost" href="${map}" target="_blank" rel="noopener">Directions</a>` : ''}
        </div>`,
      actions: b.started ? [{ label: 'Close', value: null }] : [{ label: b.status === 'waitlist' ? 'Leave waitlist' : 'Cancel booking', value: 'cancel', kind: 'ghost' }, { label: 'Close', value: null }],
    });
    if (act === 'cancel') cancel(b);
  }

  el.querySelectorAll('[data-cancel]').forEach((btn) => { btn.onclick = () => cancel(bookings.find((x) => x.id === +btn.dataset.cancel)); });
  el.querySelectorAll('[data-open]').forEach((btn) => { btn.onclick = () => details(bookings.find((x) => x.id === +btn.dataset.open)); });
  el.querySelector('#cal-open')?.addEventListener('click', () => calendarDialog());

  // Put this on your home screen. Chrome can offer its install prompt a moment after the page loads,
  // so the card is added in place then, without redrawing the screen.
  const slot = el.querySelector('#install-slot');
  function paintInstall() {
    if (!slot.isConnected || !installOk()) { mount(slot, ''); return; }
    const canPrompt = ctx.install.canPrompt();
    mount(slot, html`<section class="panel p-mini" id="install" aria-labelledby="inst-h">
      <div class="grow"><h2 class="panel-title" id="inst-h">Put this on your home screen</h2>
        <p class="muted" style="margin:0">${canPrompt ? 'It opens like an app, and you stay signed in.'
          : html`On iPhone: tap Share <span class="p-share" role="img" aria-label="(the square with an arrow)">${svg(SHARE, 16)}</span> in Safari, then Add to Home Screen.`}</p></div>
      <div class="btn-row">${canPrompt ? html`<button type="button" class="btn" id="inst-go">Add to home screen</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" id="inst-hide">Not now</button></div></section>`);
    slot.querySelector('#inst-hide').onclick = () => { hideInstall(); mount(slot, ''); };
    slot.querySelector('#inst-go')?.addEventListener('click', async () => { if (await ctx.install.prompt()) mount(slot, ''); else paintInstall(); });
  }
  paintInstall();
  if (!ctx.install.standalone() && !hiddenInstall() && !ctx.install.canPrompt()) {
    document.addEventListener('dp-install', () => { if (ctx.isCurrent() && slot.isConnected) paintInstall(); }, { once: true });
  }
}

function hiddenInstall() { try { return !!localStorage.getItem(INSTALL_KEY); } catch { return false; } }
function hideInstall() { try { localStorage.setItem(INSTALL_KEY, '1'); } catch { /* storage blocked */ } }

// Subscribe a phone calendar to the family's private feed, copy the link, or reset it.
async function calendarDialog() {
  let links;
  try { links = await api.get('/parent/calendar'); } catch (e) { toastError(e); return; }
  const apple = /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent); // Android and Windows: Google first
  const body = () => html`<p style="margin:0">Subscribe once and every booking for your family appears in your calendar. Cancelled sessions drop off on their own; calendars check for changes every hour or so.</p>
    <div class="stack cal-links">
      ${apple ? html`<a class="btn btn-primary" href="${links.webcal}">Add to Apple Calendar</a>
        <a class="btn" href="${links.google}" target="_blank" rel="noopener">Add to Google Calendar</a>`
      : html`<a class="btn btn-primary" href="${links.google}" target="_blank" rel="noopener">Add to Google Calendar</a>
        <a class="btn" href="${links.webcal}">Add to Apple Calendar</a>`}
      <button type="button" class="btn" data-copy>Copy link for Outlook or others</button>
    </div>
    <p class="hint" style="margin:0">The link is private to your family. Shared it by mistake? Reset it and the old link stops working.</p>
    <div class="cal-reset" data-reset-box><button type="button" class="btn btn-ghost btn-sm" data-reset>Reset link</button></div>`;
  function bind(b) {
    b.querySelector('[data-copy]').onclick = async () => {
      try { await navigator.clipboard.writeText(links.url); toast('Link copied. Paste it into your calendar app as a subscription.'); }
      catch { window.prompt('Copy this link:', links.url); }
    };
    b.querySelector('[data-reset]').onclick = () => {
      const box = b.querySelector('[data-reset-box]');
      mount(box, html`<div class="banner" style="display:block">Calendars using the old link stop getting your sessions until you add the new one.</div>
        <div class="btn-row"><button type="button" class="btn btn-warn btn-sm" data-reset-yes>Reset link</button><button type="button" class="btn btn-ghost btn-sm" data-reset-no>Keep it</button></div>`);
      box.querySelector('[data-reset-no]').onclick = () => { mount(b, body()); bind(b); };
      box.querySelector('[data-reset-yes]').onclick = async (e) => {
        e.target.disabled = true;
        try { links = await api.post('/parent/calendar/reset'); mount(b, body()); bind(b); toast('New link made. Add it to your calendar again.'); }
        catch (x) { toastError(x); e.target.disabled = false; }
      };
    };
  }
  await modal({ title: 'Add to calendar', body: body(), actions: [{ label: 'Done', value: null }], onMount: bind });
}
