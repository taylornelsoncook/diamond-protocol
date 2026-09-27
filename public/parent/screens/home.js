// Home: tabs for Overview (each athlete at a glance, what's coming up, a way to cancel) and the
// Accountability, Performance and Education views shared with the athlete app (public/js/engage-view.js).
import { html, raw, mount, api, toast, toastError, modal } from '/js/ui.js';
import { createEngage, engageDots, tabIcon, ENGAGE_TABS } from '/js/engage-view.js';
import { header, weekday, clock, dayShort, dayLong } from '../common.js';

const TABS = [{ id: 'overview', label: 'Overview', icon: 'home' }, ...ENGAGE_TABS];
// One engage view per athlete while Home is open, so switching athletes back and forth is instant.
const views = new Map();

const STATUS = { active: 'Active', trial: 'Trial', past_due: 'Past due', paused: 'Paused' };

function stats(a) {
  const m = a.membership;
  const unlimited = a.member_left === 'unlimited';
  const groupLeft = unlimited ? null : (Number(a.member_left) || 0) + (a.group_credits || 0);
  const groupNote = !unlimited && a.member_left > 0 && a.group_credits > 0 ? `${a.member_left} from membership, ${a.group_credits} from packs` : null;
  return html`<div class="stats">
    <div class="stat"><div class="stat-v word ${m?.status === 'past_due' ? 'warn' : ''}">${m ? STATUS[m.status] || m.status : '—'}</div>
      <div class="stat-l">${m ? m.plan_name : 'No membership'}</div></div>
    <div class="stat"><div class="stat-v ${unlimited ? 'word' : ''}">${unlimited ? 'Unlimited' : groupLeft}</div>
      <div class="stat-l">${unlimited ? 'Group classes' : 'Group classes left'}${groupNote ? html`<br>${groupNote}` : ''}</div></div>
    <div class="stat"><div class="stat-v">${a.private_credits || 0}</div><div class="stat-l">Privates left</div></div>
  </div>`;
}

function sessionRow(b) {
  return html`<div class="s-row">
    <div class="s-when">${weekday(b.starts_at)}<span>${clock(b.starts_at)}</span></div>
    <div><div class="s-name">${b.name}</div><div class="s-meta">${dayShort(b.starts_at)}${b.location ? ` · ${b.location}` : ''}${b.status === 'waitlist' ? ' · On the waitlist' : ''}</div></div>
    <div class="s-act"><button class="btn btn-ghost btn-sm" data-cancel="${b.id}">${b.status === 'waitlist' ? 'Leave' : 'Cancel'}</button></div>
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
  }
  function paintSwitch(sw) {
    mount(sw, html`<span class="label" id="eg-switch-l">Athlete</span>
      <div class="seg" role="group" aria-labelledby="eg-switch-l">${me.athletes.map((a) => {
        const d = engageDots(views.get(a.id)?.data);
        const dotOn = tab === 'accountability' ? d.accountability : tab === 'education' ? d.education : false;
        return html`<button type="button" data-athlete-sw="${a.id}" aria-pressed="${String(a.id === selected)}">${a.first_name}${dotOn ? html`<span class="eg-dot" aria-hidden="true"></span><span class="sr-only"> (new)</span>` : ''}</button>`;
      })}</div>`);
  }
  async function show() {
    if (tab === 'overview') return overview(ctx, body);
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
    tab = b.dataset.tab;
    history.replaceState({}, '', tab === 'overview' ? '/parent' : `/parent?tab=${tab}`);
    paint();
    show();
  });
  body.addEventListener('click', (e) => {
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
  const banners = [
    !f.waiver_current ? html`<div class="banner"><span>${f.waiver_version ? 'The waiver has changed. Sign the new one before the next session.' : 'Sign the waiver before the first session.'}</span><a class="btn btn-warn btn-sm" href="/parent/family#waiver">Sign waiver</a></div>` : '',
    !f.card_last4 ? html`<div class="banner"><span>Add a card for drop-ins, packs, camps and memberships.</span><a class="btn btn-warn btn-sm" href="/parent/card">Add card</a></div>` : '',
    pastDue.length && f.card_last4 ? html`<div class="banner"><span>${pastDue.map((a) => a.first_name).join(' and ')}'s membership payment was declined. Update the card to keep booking.</span><a class="btn btn-warn btn-sm" href="/parent/card">Update card</a></div>` : '',
  ];
  mount(el, html`${banners}
    ${me.athletes.length ? '' : html`<div class="empty">No athletes on this account yet. <a href="/parent/family#add-athlete">Add an athlete</a>.</div>`}
    ${me.athletes.map((a) => {
      const mine = bookings.filter((b) => b.athlete_id === a.id);
      return html`<section class="panel" aria-label="${a.first_name} ${a.last_name}">
        <div><h2 class="a-name">${a.first_name} ${a.last_name}</h2>
          <p class="a-meta">${[a.age != null ? `Age ${a.age}` : null, a.sport, a.position].filter(Boolean).join(' · ')}</p>
          <p class="a-meta">Athlete ID <span class="mono">${a.code}</span></p></div>
        ${stats(a)}
        <h3 class="sec-label">Coming up</h3>
        ${mine.length ? html`<div class="list">${mine.map(sessionRow)}</div>` : html`<p class="muted" style="margin:0">Nothing booked yet.</p>`}
        <div class="btn-row">
          <a class="btn" href="/parent/book?athlete=${a.id}">Book a session</a>
          ${a.workout_token && a.has_program ? html`<a class="btn btn-ghost" href="/w/${a.workout_token}">Open workouts</a>` : ''}
        </div>
      </section>`;
    })}`);

  el.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.onclick = async () => {
      const b = bookings.find((x) => x.id === +btn.dataset.cancel);
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
        toast(r.late ? 'Cancelled. The session still counts as used.' : b.status === 'waitlist' ? 'Off the waitlist.' : 'Cancelled.');
        ctx.reload();
      } catch (e) { toastError(e); }
    };
  });
}
