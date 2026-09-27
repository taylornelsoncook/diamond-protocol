// Today: numbers across the top, today's sessions and one-tap check-in, what needs a decision (with follow-ups),
// birthdays, recent activity, revenue by location (owners). Refreshes itself every minute while it's open.
import { html, raw, mount, api, money, relTime, fmtTime, fmtDate, fmtDateTime, badge, toast, toastError, plural, modal, confirmDialog } from '/js/ui.js';

const REFRESH_MS = 60e3, ACT_PAGE = 12;

const STYLE = html`<style>
  .td{display:flex;flex-direction:column;gap:var(--space-6)}
  .td-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md)}
  .td-metrics .metric{border:0;border-radius:0;background:transparent;padding:var(--space-6);text-decoration:none;color:inherit}
  .td-metrics a.metric:hover{background:var(--surface-raised)}
  .td-metrics a.metric:hover .metric-label{color:var(--steel)}
  .td-metrics .metric+.metric{border-left:1px solid var(--line)}
  .td-row{display:flex;align-items:center;gap:var(--space-4);padding:12px 0;border-top:1px solid var(--line-subtle);text-decoration:none;color:inherit}
  .td-row:first-child{border-top:0}
  a.td-row:hover .td-name{text-decoration:underline}
  a.td-row{min-height:44px}
  .td-row.is-done{opacity:.62}
  .td-time{font:600 16px/1.2 var(--font-display);min-width:78px;color:var(--steel)}
  .td-name{font-weight:600;color:var(--steel)}
  .td-grow{flex:1;min-width:0}
  .td-att .td-row,.td-checkin .td-row{flex-wrap:wrap}
  .td-att .td-row>.td-grow{flex:1 1 240px}
  .td-checkin .td-row>.td-grow{flex:1 1 200px}
  .td-sess-top{display:flex;gap:6px 8px;flex-wrap:wrap;align-items:center;margin-bottom:2px}
  .td-sess .td-row{align-items:flex-start}
  .td-bar{margin-top:6px;max-width:220px}
  .td-att .td-title{font-weight:600;color:var(--steel)}
  .td-att a.td-title,.td-checkin a.td-title{color:var(--steel)}
  .td-acts{display:flex;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end;align-items:center}
  .td-act{display:grid;grid-template-columns:88px minmax(0,1fr);gap:var(--space-3);padding:12px 0;border-top:1px solid var(--line-subtle)}
  .td-act:first-child{border-top:0}
  .td-money{font:600 20px/1 var(--font-display);min-width:80px;text-align:right}
  .td-count{font:600 14px/1 var(--font-sans);color:var(--steel-muted);margin-left:8px}
  .td-foot{margin:var(--space-3) 0 0;padding-top:var(--space-3);border-top:1px solid var(--line-subtle)}
  .td-search{margin:var(--space-3) 0 var(--space-2)}
  .td-scroll{max-height:520px;overflow:auto;overscroll-behavior:contain}
  .td-alert{color:var(--amber);font-size:13px}
  .td-here{color:var(--green-bright);font-size:13px;font-weight:600}
  .td-filters{display:flex;flex-wrap:wrap;gap:6px;margin:var(--space-3) 0 var(--space-2)}
  .td-filters button{min-height:36px;padding:0 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm);background:var(--surface);color:var(--steel-muted);font-weight:600;font-size:14px;cursor:pointer}
  .td-filters button:hover{color:var(--steel)}
  .td-filters button[aria-pressed="true"]{background:var(--surface-raised);color:var(--steel);border-color:var(--green-mid)}
  .td-bday{display:flex;flex-wrap:wrap;gap:var(--space-2)}
  .td-bday a{display:inline-flex;align-items:center;min-height:36px;text-decoration:none;color:var(--steel)}
  .td-bday a:hover{border-color:var(--green-mid)}
  .td-hidden-row{display:flex;gap:var(--space-3);align-items:center;padding:10px 0;border-top:1px solid var(--line-subtle)}
  .td-hidden-row:first-child{border-top:0}
  .td-updated{font-size:13px;color:var(--steel-muted)}
  @media (max-width:900px){.td-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.td-metrics .metric:nth-child(3){border-left:0}.td-metrics .metric:nth-child(n+3){border-top:1px solid var(--line)}.td-metrics .metric{padding:var(--space-4)}}
  @media (max-width:640px),(pointer:coarse){.td .btn-sm,.td-filters button,.td-bday a{min-height:44px}}
  @media (max-width:520px){
    .td-att .td-row,.td-checkin .td-row{flex-wrap:wrap}.td-acts{width:100%;justify-content:stretch}.td-acts>.btn{flex:1 1 auto}
    .td-act{grid-template-columns:1fr;gap:2px}.td-time{min-width:64px;font-size:15px}
  }
</style>`;

// Activity categories for the feed filter (by the verb each change is logged with).
const ACT_FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'checkins', label: 'Check-ins', test: (a) => /check-in|checked in/i.test(a.action) },
  { id: 'bookings', label: 'Bookings', test: (a) => /booking|booked|waitlist|standing spot|registered|cancelled session|walk-in/i.test(a.action) },
  { id: 'training', label: 'Training', test: (a) => /workout|program|goal|message|lesson|reading|reached out|followed up/i.test(a.action) },
  { id: 'testing', label: 'Testing', test: (a) => /\bPR\b|result|testing|test target/i.test(a.action) },
  { id: 'money', label: 'Money', owner: true, test: (a) => /payment|sale|refund|invoice|charge|membership|pack|plan|card/i.test(a.action) },
];

const STATE_BADGE = { live: ['good', 'On now'], next: ['neutral', 'Next'], done: ['muted', 'Done'] };
const stateBadge = (s) => (STATE_BADGE[s] ? html`<span class="badge badge-${STATE_BADGE[s][0]}">${STATE_BADGE[s][1]}</span>` : '');
const dayName = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const first = (name) => String(name || '').split(' ')[0];
function nextDay(iso) { const x = new Date(iso + 'T12:00:00'); x.setDate(x.getDate() + 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }

function sessionRow(e) {
  const team = e.type === 'team';
  const expected = team ? Math.max(e.booked, e.team_size) : e.booked;
  const count = team ? `${e.checked_in} of ${e.team_size} here` : `${e.booked}/${e.capacity ?? '∞'} booked · ${e.checked_in} checked in`;
  const pct = expected ? Math.min(100, Math.round((e.checked_in / expected) * 100)) : 0;
  return html`<a class="td-row ${e.state === 'done' || e.cancelled ? 'is-done' : ''}" href="/app/schedule/session/${e.id}">
    <div class="td-time">${fmtTime(e.starts_at)}</div>
    <div class="td-grow"><div class="td-sess-top"><span class="td-name">${e.name}</span>
        ${e.cancelled ? badge('cancelled') : html`${stateBadge(e.state)}${e.unpaid ? badge('unpaid', `${e.unpaid} unpaid`) : ''}${e.waitlisted ? badge('waitlist', `${e.waitlisted} waitlist`) : ''}`}</div>
      <div class="small muted">${fmtTime(e.starts_at)}–${fmtTime(e.ends_at)} · ${e.location || 'No location'}${e.coach ? ` · ${e.coach}` : ''}</div>
      <div class="small muted">${count}</div>
      ${!e.cancelled && expected ? html`<div class="bar td-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>` : ''}</div>
  </a>`;
}

function arrivalRow(r) {
  const here = !!r.checked_in_at;
  return html`<div class="td-row" data-arrival="${r.booking_id}">
    <div class="td-grow">
      <div><a class="td-title td-name" href="/app/clients/${r.athlete_id}">${r.name}</a>
        ${r.birthday ? html` <span class="badge badge-good">Birthday</span>` : ''}${r.unpaid ? html` ${badge('unpaid')}` : ''}${r.waiver_missing ? html` <span class="badge badge-warn">No waiver</span>` : ''}</div>
      <div class="small muted">${r.event_name} · ${fmtTime(r.starts_at)}${r.code ? ` · ${r.code}` : ''}</div>
      ${r.alerts.length ? html`<div class="td-alert">${r.alerts.join(' · ')}</div>` : ''}
      ${r.flags.length ? html`<div class="td-alert">Check-in: ${r.flags.join(' · ')}</div>` : ''}
      ${here ? html`<div class="td-here">Checked in ${fmtTime(r.checked_in_at)}</div>` : r.state === 'done' ? html`<div class="small muted">Session over, not checked in.</div>` : ''}
    </div>
    <div class="td-acts">${here
      ? html`<button class="btn btn-ghost btn-sm" data-undo-checkin="${r.booking_id}" aria-label="Undo check-in for ${r.name}">Undo</button>`
      : html`<button class="btn btn-outline btn-sm" data-checkin="${r.booking_id}" aria-label="Check in ${r.name}">Check in</button>`}</div>
  </div>`;
}

// A daily check-in that needs a look: short sleep, high soreness, low energy, mood or hydration.
function flagRow(f, i, canNote) {
  return html`<div class="td-row">
    <div class="td-grow"><div><a class="td-title" href="/app/clients/${f.athlete_id}">${f.name}</a> checked in: <span class="warn-text">${f.flags.join(' · ')}</span></div>
      <div class="small muted">${f.today ? 'Today' : 'Yesterday'}'s check-in. ${f.session ? `Booked for ${f.session}. Worth a word before they train.` : 'Not booked today.'}</div></div>
    <div class="td-acts">
      ${canNote ? html`<button class="btn btn-outline btn-sm" data-note-flag="${i}">Send a note</button>` : html`<a class="btn btn-outline btn-sm" href="/app/clients/${f.athlete_id}">View client</a>`}
      <button class="btn btn-ghost btn-sm" data-snooze-flag="${i}" aria-label="Mark ${f.name}'s check-in as reviewed">Mark reviewed</button>
    </div></div>`;
}

function attentionRow(item, i, canNote) {
  const acts = [];
  if (item.snooze && canNote) acts.push(html`<button class="btn btn-outline btn-sm" data-note-att="${i}">Send a note</button>`);
  if (item.phone) acts.push(html`<a class="btn btn-ghost btn-sm" href="tel:${item.phone.replace(/[^\d+]/g, '')}" aria-label="Call ${item.title}'s family, ${item.phone}">Call</a>`);
  if (item.snooze) acts.push(html`<button class="btn btn-ghost btn-sm" data-snooze-att="${i}" aria-label="${item.snooze.label}: ${item.title}">${item.snooze.label}</button>`);
  const showMain = item.action && !(item.snooze && item.action.label === 'View client');
  if (showMain) acts.push(item.action.post
    ? html`<button class="btn btn-outline btn-sm" data-post="${i}">${item.action.label}</button>`
    : html`<a class="btn btn-outline btn-sm" href="${item.action.href}">${item.action.label}</a>`);
  const linked = item.href && !['pending_results', 'unpaid_today', 'quiet_more'].includes(item.kind);
  return html`<div class="td-row">
    <div class="td-grow">${linked ? html`<a class="td-title" href="${item.href}">${item.title}</a>` : html`<div class="td-title">${item.title}</div>`}
      <div class="small muted">${item.detail}</div></div>
    ${acts.length ? html`<div class="td-acts">${acts}</div>` : ''}</div>`;
}

// A toast with one action (Undo). Uses the shared toast styles; stays a little longer than a plain toast.
function toastAction(msg, label, onAction) {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.cssText = 'display:flex;align-items:center;gap:16px';
  const span = document.createElement('span'); span.textContent = msg;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = label;
  b.style.cssText = 'min-height:36px;background:transparent;color:var(--on-green);border-color:rgba(255,255,255,.6)';
  b.onclick = async () => { b.disabled = true; t.remove(); try { await onAction(); } catch (e) { toastError(e); } };
  t.append(span, b);
  box.append(t);
  setTimeout(() => t.remove(), 7000);
}

function suggestNote(kind, name, item) {
  const n = first(name);
  if (kind === 'flag') {
    const saw = `Hi ${n}, saw your check-in (${item.flags.join(', ').toLowerCase()}).`;
    return item.session ? `${saw} We'll adjust today's work. Find me before you start.` : `${saw} Take it easy, get some rest and water, and tell us if anything hurts.`;
  }
  if (kind === 'trial_ending') return `Hi ${n}, your free trial wraps up soon. How has training felt so far? Happy to answer any questions about staying on.`;
  return `Hi ${n}, we've missed you at training. Want me to save you a spot this week?`;
}

export const routes = [{
  path: '/today', nav: 'today', title: 'Today',
  render: async (ctx) => {
    const role = ctx.me.role, owner = role === 'owner', canNote = role === 'owner' || role === 'coach';
    const loadActivity = () => api.get('/activity?limit=100&kind=change').catch(() => []);
    let [d, activity] = await Promise.all([api.get('/today'), loadActivity()]);
    if (!ctx.isCurrent()) return;
    let actFilter = 'all', actShown = ACT_PAGE, showHidden = false, query = '', updatedAt = new Date();

    mount(ctx.el, html`${STYLE}<div class="td" id="td-root">
      <header class="page-header">
        <div><h1 class="page-title">Today</h1><p class="page-sub" id="td-sub"></p></div>
        <a class="btn btn-primary" href="/app/clients/new">Add client</a>
      </header>
      <section class="td-metrics" id="td-metrics" aria-label="Key numbers"></section>
      <div class="grid-2" style="align-items:start">
        <section class="panel td-sess" aria-labelledby="td-sess-h">
          <div class="panel-head"><h2 class="panel-title" id="td-sess-h">Today's sessions</h2><a class="btn btn-sm" href="/app/schedule">Full schedule</a></div>
          <div id="td-sessions"></div>
        </section>
        <section class="panel td-checkin" aria-labelledby="td-in-h">
          <div class="panel-head"><h2 class="panel-title" id="td-in-h">Check in<span class="td-count" id="td-in-count"></span></h2></div>
          <div class="td-search"><label class="sr-only" for="td-q">Find someone booked today</label>
            <input class="input" id="td-q" type="search" placeholder="Name or Athlete ID" autocomplete="off" enterkeyhint="go" aria-describedby="td-q-hint">
            <span class="hint" id="td-q-hint">Press Enter to check in the only match.</span></div>
          <div id="td-arrivals" class="td-scroll"></div>
        </section>
      </div>
      <div class="grid-2" style="align-items:start">
        <section class="panel td-att" aria-labelledby="td-att-h">
          <h2 class="panel-title" id="td-att-h">Needs your attention<span class="td-count" id="td-att-count"></span></h2>
          <div id="td-att"></div>
        </section>
        <section class="panel" aria-labelledby="td-act-h">
          <h2 class="panel-title" id="td-act-h">Recent activity</h2>
          <div class="td-filters" role="group" aria-label="Show activity">${ACT_FILTERS.filter((f) => !f.owner || owner).map((f) => html`<button type="button" data-filter="${f.id}" aria-pressed="${f.id === 'all'}">${f.label}</button>`)}</div>
          <div id="td-act"></div>
        </section>
      </div>
      <div id="td-rev"></div>
    </div>`);
    const root = ctx.el.querySelector('#td-root');
    const $ = (sel) => root.querySelector(sel);

    function paintHeader() {
      const sales = d.in_person_today_count ? ` ${money(d.in_person_today_cents)} in person today from ${plural(d.in_person_today_count, 'sale')}.` : ' No in-person sales yet today.';
      $('#td-sub').textContent = `${dayName(d.date)}.${owner ? sales : ' Sessions, check-in and anything that needs a decision.'}`;
      mount($('#td-metrics'), html`${d.metrics.map((m) => html`<a class="metric" href="${m.href || '/app/today'}">
        <div class="metric-label">${m.label}</div><div class="metric-value ${m.tone || ''}">${m.value}</div><div class="metric-note">${m.note}</div></a>`)}`);
    }

    function paintSessions() {
      const t = d.tomorrow;
      const teamToday = d.sessions.some((e) => e.type === 'team' && !e.cancelled);
      mount($('#td-sessions'), html`
        ${d.sessions.length ? html`<div class="list">${d.sessions.map(sessionRow)}</div>` : html`<p class="muted" style="margin:0">Nothing on the schedule today.</p>`}
        <p class="small muted td-foot">${t.count ? `Tomorrow: ${plural(t.count, 'session')}, first at ${fmtTime(t.first_at)} · ${t.booked} booked.` : 'Nothing on the schedule tomorrow.'}${teamToday ? ' Team athletes check in from the session roster.' : ''}
          <span class="td-updated">Updated ${fmtTime(updatedAt)}.</span></p>`);
    }

    function paintArrivals() {
      const list = d.arrivals;
      const here = list.filter((r) => r.checked_in_at).length;
      $('#td-in-count').textContent = list.length ? `${here} of ${list.length} here` : '';
      const q = query.trim().toLowerCase();
      const shown = q ? list.filter((r) => r.name.toLowerCase().includes(q) || String(r.code || '').toLowerCase().includes(q)) : list;
      mount($('#td-arrivals'), list.length
        ? (shown.length ? html`<div class="list">${shown.map(arrivalRow)}</div>` : html`<p class="muted" style="margin:0">No one booked today matches “${query.trim()}”. <a href="/app/clients">Search all clients</a> to book a walk-in.</p>`)
        : html`<p class="muted" style="margin:0">No one is booked into a session today. Walk-ins can be added from a session roster.</p>`);
    }

    function paintAttention() {
      const flags = d.flags, att = d.attention;
      const n = flags.length + att.length;
      $('#td-att-count').textContent = n ? String(n) : '';
      const hidden = d.snoozed;
      const bdays = d.birthdays;
      mount($('#td-att'), html`
        ${n ? html`<div class="list">${flags.map((f, i) => flagRow(f, i, canNote))}${att.map((a, i) => attentionRow(a, i, canNote))}</div>`
          : html`<p class="muted" style="margin:0">Nothing needs a decision right now.</p>`}
        ${hidden.length ? html`<div class="td-foot">
          <button class="btn btn-ghost btn-sm" data-toggle-hidden aria-expanded="${showHidden}">${showHidden ? 'Hide' : 'Show'} ${plural(hidden.length, 'followed-up item')}</button>
          ${showHidden ? html`<div>${hidden.map((s) => html`<div class="td-hidden-row">
            <div class="td-grow"><div><a class="td-title" href="/app/clients/${s.athlete_id}">${s.name}</a> <span class="muted">· ${s.label}</span></div>
              <div class="small muted">${s.by ? `${s.by}, ` : ''}${relTime(s.created_at)}${s.note ? ` · ${s.note}` : ''} ${s.kind === 'flag' ? '' : ` · back on Today ${fmtDate(nextDay(s.until), { year: false })}`}</div></div>
            <button class="btn btn-ghost btn-sm" data-unsnooze="${s.id}" aria-label="Bring ${s.name} back to Today">Bring back</button></div>`)}</div>` : ''}
        </div>` : ''}
        ${bdays.length ? html`<div class="td-foot"><div class="small muted" style="margin-bottom:8px">Birthdays this week</div>
          <div class="td-bday">${bdays.map((b) => html`<a class="chip" href="/app/clients/${b.athlete_id}">${b.name} · ${b.today ? 'today' : fmtDate(b.date, { year: false, weekday: true })}${b.turning ? `, turns ${b.turning}` : ''}</a>`)}</div></div>` : ''}`);
    }

    function paintActivity() {
      const f = ACT_FILTERS.find((x) => x.id === actFilter) || ACT_FILTERS[0];
      const list = activity.filter(f.test);
      root.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === actFilter)));
      mount($('#td-act'), list.length ? html`<div>${list.slice(0, actShown).map((a) => html`<div class="td-act">
          <div class="small muted" title="${fmtDateTime(a.created_at)}">${relTime(a.created_at)}</div>
          <div><div>${a.action}${a.detail ? html`<span class="muted">: ${a.detail}</span>` : ''}</div><div class="small muted">${a.actor || ''}</div></div></div>`)}</div>
          ${list.length > actShown ? html`<button class="btn btn-ghost btn-sm" data-more-act style="margin-top:8px">Show ${Math.min(ACT_PAGE, list.length - actShown)} more</button>` : ''}`
        : html`<p class="muted" style="margin:0">${actFilter === 'all' ? 'Nothing yet. Bookings, payments, check-ins and PRs show here as they happen.' : `No ${f.label.toLowerCase()} in the latest changes.`}</p>`);
    }

    function paintRevenue() {
      const rev = d.revenue;
      mount($('#td-rev'), owner && rev ? html`<section class="panel" aria-labelledby="td-rev-h">
        <div class="panel-head"><div><h2 class="panel-title" id="td-rev-h">Revenue by location</h2>
          <p class="panel-sub">This month. ${rev.membership_payments.count ? `In-person sales plus ${money(rev.membership_payments.cents)} from ${plural(rev.membership_payments.count, 'membership payment')}.` : 'In-person sales. No membership payments yet this month.'}</p></div>
          <a class="btn btn-outline btn-sm" href="/app/pos">New sale</a></div>
        ${rev.locations.length ? html`<div class="list">${rev.locations.map((l) => html`<div class="td-row">
          <div class="td-grow">${l.location}</div><div class="small muted">${plural(l.sales, 'sale')}</div><div class="td-money">${money(l.cents)}</div></div>`)}
          ${rev.locations.length > 1 ? html`<div class="td-row"><div class="td-grow strong">Total</div><div class="td-money">${money(rev.total_cents)}</div></div>` : ''}</div>`
          : html`<p class="muted" style="margin:0">No in-person sales yet this month.</p>`}
      </section>` : '');
    }

    // Repainting replaces the buttons, so keep keyboard focus where it was (or on the search after a check-in).
    const paint = () => {
      const a = document.activeElement, inRoot = a && a !== q && root.contains(a);
      const attr = inRoot ? [...a.attributes].find((x) => x.name.startsWith('data-')) : null;
      const sel = attr ? `[${attr.name}="${CSS.escape(attr.value)}"]` : null, inArrivals = inRoot && !!a.closest('#td-arrivals');
      paintHeader(); paintSessions(); paintArrivals(); paintAttention(); paintActivity(); paintRevenue();
      if (inRoot && !a.isConnected) (sel && root.querySelector(sel) || (inArrivals ? q : null))?.focus();
    };
    const q = $('#td-q');
    paint();

    // One refresh at a time. A refresh asked for mid-flight (a second quick check-in) runs once more right after,
    // so the screen never settles on data fetched before the latest change.
    let inFlight = null, queued = null;
    function refresh() {
      if (inFlight) return (queued ||= inFlight.then(() => { queued = null; return refresh(); }));
      inFlight = (async () => {
        try {
          const [nd, na] = await Promise.all([api.get('/today'), loadActivity()]);
          if (!ctx.isCurrent() || !root.isConnected) return;
          d = nd; activity = na; updatedAt = new Date();
          paint();
        } catch (e) { if (e.status !== 401) toastError(e); }
      })().finally(() => { inFlight = null; });
      return inFlight;
    }

    // ---- check-in ----
    async function checkIn(id, btn) {
      const r = d.arrivals.find((x) => String(x.booking_id) === String(id));
      const hadFocus = btn && document.activeElement === btn; // a disabled button drops focus; put it back on the search
      if (btn) btn.disabled = true;
      try {
        await api.post(`/bookings/${id}/checkin`);
        toastAction(`${r ? r.name : 'Athlete'} checked in.`, 'Undo', async () => { await api.del(`/bookings/${id}/checkin`); toast('Check-in undone.'); await refresh(); });
        await refresh();
        if (hadFocus && !btn.isConnected && (document.activeElement === document.body || !document.activeElement)) q.focus();
        return true;
      } catch (e) { toastError(e); if (btn) btn.disabled = false; return false; }
    }

    // ---- follow-ups ----
    const snooze = (key, body = {}) => api.post('/today/snooze', { key, ...body });
    async function quickSnooze(key, btn) {
      btn.disabled = true;
      try {
        const r = await snooze(key);
        toastAction(r.message, 'Undo', async () => { await api.del(`/today/snooze/${r.id}`); toast('Back on Today.'); await refresh(); });
        await refresh();
      } catch (e) { toastError(e); btn.disabled = false; }
    }
    async function sendNote({ athlete_id, name, key, kind, item }) {
      let posted = false;
      const sent = await modal({
        title: `Send ${first(name)} a note`,
        body: html`<div class="field"><label class="label" for="td-note">Note</label>
            <textarea class="input" id="td-note" rows="4" maxlength="2000">${suggestNote(kind, name, item)}</textarea>
            <span class="hint">Shows in ${first(name)}'s app and is emailed to the family.</span></div>
          ${kind === 'flag' ? '' : html`<div class="field"><label class="label" for="td-days">Take off Today for</label>
            <select class="input" id="td-days">${kind === 'trial_ending' ? html`<option value="" selected>Until the trial ends</option>` : ''}${[3, 7, 14, 30].map((n) => html`<option value="${n}" ${n === 7 && kind !== 'trial_ending' ? raw('selected') : ''}>${n} days</option>`)}</select></div>`}`,
        actions: [{ label: 'Cancel', value: null }, {
          label: 'Send note', kind: 'primary', onClick: async (el) => {
            const text = el.querySelector('#td-note').value.trim();
            if (!text) { toast('Write a note first.', 'warn'); return false; }
            if (!posted) { await api.post(`/athletes/${athlete_id}/messages`, { body: text }); posted = true; }
            const days = el.querySelector('#td-days')?.value;
            await snooze(key, { note: 'Sent a note', ...(days ? { days: Number(days) } : {}) });
            return true;
          },
        }],
      });
      if (sent) { toast(`Note sent to ${first(name)}. It's off Today for now.`); await refresh(); }
      else if (posted) { toast(`Note sent to ${first(name)}. It's still on Today.`); await refresh(); }
    }

    // ---- events (delegated on this screen's root, so they go away with it) ----
    root.addEventListener('click', async (ev) => {
      const t = ev.target.closest('button');
      if (!t || !root.contains(t)) return;
      if (t.dataset.checkin) return checkIn(t.dataset.checkin, t);
      if (t.dataset.undoCheckin) {
        t.disabled = true;
        try { await api.del(`/bookings/${t.dataset.undoCheckin}/checkin`); toast('Check-in undone.'); await refresh(); } catch (e) { toastError(e); t.disabled = false; }
        return;
      }
      if (t.dataset.snoozeFlag) return quickSnooze(d.flags[+t.dataset.snoozeFlag].key, t);
      if (t.dataset.snoozeAtt) return quickSnooze(d.attention[+t.dataset.snoozeAtt].key, t);
      if (t.dataset.noteFlag) { const f = d.flags[+t.dataset.noteFlag]; return sendNote({ athlete_id: f.athlete_id, name: f.name, key: f.key, kind: 'flag', item: f }); }
      if (t.dataset.noteAtt) { const a = d.attention[+t.dataset.noteAtt]; return sendNote({ athlete_id: a.athlete_id, name: a.title, key: a.key, kind: a.kind, item: a }); }
      if (t.dataset.unsnooze) {
        t.disabled = true;
        try { await api.del(`/today/snooze/${t.dataset.unsnooze}`); toast('Back on Today.'); await refresh(); } catch (e) { toastError(e); t.disabled = false; }
        return;
      }
      if (t.hasAttribute('data-toggle-hidden')) { showHidden = !showHidden; paintAttention(); root.querySelector('[data-toggle-hidden]')?.focus(); return; }
      if (t.dataset.filter) { actFilter = t.dataset.filter; actShown = ACT_PAGE; paintActivity(); return; }
      if (t.hasAttribute('data-more-act')) { actShown += ACT_PAGE; paintActivity(); return; }
      if (t.dataset.post) {
        const item = d.attention[+t.dataset.post];
        const c = item.action.confirm;
        if (c && !(await confirmDialog(c.title, c.text, c.label))) return;
        t.disabled = true;
        try {
          const r = await api.post(item.action.post);
          toast(r.message || 'Done.', r.ok === false ? 'warn' : 'good');
          await refresh();
        } catch (e) { toastError(e); t.disabled = false; }
      }
    });

    q.addEventListener('input', () => { query = q.value; paintArrivals(); });
    q.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { q.value = ''; query = ''; paintArrivals(); return; }
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const s = query.trim().toLowerCase();
      if (!s) return;
      const open = d.arrivals.filter((r) => !r.checked_in_at && (r.name.toLowerCase().includes(s) || String(r.code || '').toLowerCase().includes(s)));
      if (open.length === 1) checkIn(open[0].booking_id).then((ok) => { if (ok) { q.value = ''; query = ''; paintArrivals(); } q.focus(); });
      else toast(open.length ? `${open.length} people match. Keep typing or tap Check in.` : 'No one waiting to check in matches that.', 'warn');
    });

    // ---- keep it current while it's open (front desk leaves Today up all day) ----
    const onVis = () => { if (document.visibilityState === 'visible' && Date.now() - updatedAt.getTime() > REFRESH_MS / 2) tick(); };
    const tick = () => {
      if (!ctx.isCurrent() || !root.isConnected) { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); return; }
      if (document.visibilityState !== 'visible' || document.querySelector('.modal-back') || root.contains(document.activeElement) && document.activeElement === q && query) return;
      refresh();
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', onVis);
  },
}];
