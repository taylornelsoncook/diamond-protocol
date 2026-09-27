// Schedule: any two weeks (filter by type, coach, place or name), classes and camps (add, edit, archive),
// one-off sessions, session rosters (check-in, collect, waitlist, edit, email families, print) and hours & settings
// (bookable hours on several days at once, time off, policies, rankings).
import { html, raw, mount, api, money, toCents, fmtTime, badge, toast, toastError, modal, confirmDialog, formData, options, debounce, plural, localISO } from '/js/ui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TYPE_BADGE = { class: ['Group', 'good'], camp: ['Camp', 'neutral'], clinic: ['Clinic', 'neutral'], team: ['Team', 'muted'], private: ['Private', 'neutral'], evaluation: ['Evaluation', 'neutral'] };
const TYPE_FILTERS = [['', 'All types'], ['class', 'Group classes'], ['camp', 'Camps & clinics'], ['team', 'Team sessions'], ['private', 'Privates & evaluations']];
const typeMatch = (f, t) => !f || f === t || (f === 'camp' && t === 'clinic') || (f === 'private' && t === 'evaluation');
const typeBadge = (t) => html`<span class="badge badge-${(TYPE_BADGE[t] || [t, 'muted'])[1]}">${(TYPE_BADGE[t] || [t])[0]}</span>`;
const dayLabel = (d, o = { weekday: 'long', month: 'short', day: 'numeric' }) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', o);
const canManage = (me) => me.role === 'owner' || me.role === 'coach';
const ages = (c) => (c?.min_age && c?.max_age ? `ages ${c.min_age}–${c.max_age}` : c?.min_age ? `ages ${c.min_age}+` : c?.max_age ? `up to age ${c.max_age}` : '');
const hhmm = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const dollars = (c) => (c ? (c / 100).toFixed(2).replace(/\.00$/, '') : '');

// Wall-clock helpers. Sessions are stored as local "YYYY-MM-DDTHH:MM" in the business time zone.
const toMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13) || 0, +s.slice(14, 16) || 0);
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 16);
const addDays = (d, n) => fromMs(toMs(d) + n * 864e5).slice(0, 10);
const endAt = (e) => fromMs(toMs(e.starts_at) + e.duration_min * 6e4);
function bizNow(tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  } catch { const d = new Date(); return `${localISO(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
}
const stateOf = (e, now) => (e.cancelled ? 'cancelled' : endAt(e) <= now ? 'done' : e.starts_at <= now ? 'now' : 'next');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

const STYLE = html`<style>
  .sc-day{gap:0}
  .sc-day h2{font:600 17px/24px var(--font-sans);padding-bottom:10px;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
  .sc-off{font:400 13px/18px var(--font-sans);color:var(--amber)}
  .sc-row{display:flex;align-items:center;gap:var(--space-4);padding:12px 0;border-top:1px solid var(--line-subtle);text-decoration:none;color:inherit;min-height:44px}
  a.sc-row:hover .sc-name{text-decoration:underline}
  a.sc-row:focus-visible{outline:2px solid var(--green-bright);outline-offset:2px}
  .sc-row.is-done{opacity:.62}
  .sc-time{font:600 16px/1.2 var(--font-display);min-width:80px;color:var(--steel)}
  .sc-name{font-weight:600;color:var(--steel)}
  .sc-grow{flex:1;min-width:0}
  .sc-badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .sc-row.cancelled .sc-name{text-decoration:line-through;color:var(--steel-muted)}
  .sc-now{color:var(--green-bright);font-weight:600}
  .sc-note{font-size:13px;color:var(--steel-muted);font-style:italic}
  .sc-bar{margin-top:6px;max-width:200px}
  .sc-nav{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;justify-content:space-between}
  .sc-range{font:600 16px/1.2 var(--font-display);color:var(--steel);letter-spacing:.02em}
  .sc-filters{display:grid;grid-template-columns:minmax(180px,2fr) repeat(3,minmax(140px,1fr));gap:var(--space-3);align-items:end}
  .sc-filters .field{margin:0}
  .sc-sum{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px;color:var(--steel-muted)}
  .sc-sum strong{color:var(--steel);font:600 16px/1 var(--font-display)}
  .sc-sum .warn strong{color:var(--amber)}
  .ro-row{display:flex;align-items:center;gap:var(--space-3);padding:12px 0;border-top:1px solid var(--line-subtle)}
  .ro-row:first-child{border-top:0}
  .ro-check{min-width:120px;min-height:44px}
  .ro-check[aria-pressed="true"]{background:var(--green-deep);color:var(--green-soft);border-color:var(--green-mid)}
  .ro-name{font-weight:600;color:var(--steel)}
  .ro-med{color:var(--amber);font-size:13px;line-height:18px}
  .ro-flags{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
  .ro-right{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;justify-content:flex-end}
  .ro-right .btn-sm,.sc-page .btn-sm{min-height:44px}
  .ro-results{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-raised)}
  .ro-results button{display:flex;width:100%;justify-content:space-between;gap:12px;padding:10px 12px;min-height:44px;background:transparent;border:0;border-top:1px solid var(--line);color:var(--steel);cursor:pointer;text-align:left}
  .ro-results button:first-child{border-top:0}
  .ro-results button:hover,.ro-results button:focus-visible{background:var(--surface)}
  .ro-acts{display:flex;flex-wrap:wrap;gap:var(--space-2)}
  .days-pick{display:flex;flex-wrap:wrap;gap:6px}
  .days-pick label{display:inline-flex}
  .days-pick input{position:absolute;opacity:0;pointer-events:none}
  .days-pick span{min-width:52px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--control-border);border-radius:var(--radius-sm);cursor:pointer;font-weight:600;font-size:14px;color:var(--steel-muted)}
  .days-pick input:checked+span{background:var(--green);color:var(--on-green);border-color:var(--green-mid)}
  .days-pick input:focus-visible+span{outline:2px solid var(--green-bright);outline-offset:2px}
  .pay-opt{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm);cursor:pointer}
  .pay-opt:has(input:checked){border-color:var(--green-mid);background:var(--green-deep)}
  .pay-opt:has(input:disabled){opacity:.5;cursor:not-allowed}
  .pay-opt input{margin-top:3px;accent-color:var(--green-mid);width:18px;height:18px}
  .hr-group+.hr-group{margin-top:var(--space-4)}
  .hr-group h3{font:600 14px/20px var(--font-sans);color:var(--steel-muted);margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em}
  .hr-open{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px;color:var(--steel-muted);padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-raised)}
  .hr-open strong{color:var(--steel)}
  @media (max-width:760px){.sc-filters{grid-template-columns:1fr 1fr}.sc-filters .sc-q{grid-column:1/-1}}
  @media (max-width:640px){
    .sc-row{flex-wrap:wrap;gap:4px 12px}.sc-time{min-width:64px}.sc-badges{width:100%;justify-content:flex-start;padding-left:76px}
    .ro-row{flex-wrap:wrap}.ro-right{width:100%;justify-content:flex-start;padding-left:132px}
  }
  @media (max-width:480px){.ro-right{padding-left:0}}
  .ro-tel{white-space:nowrap}
  @media print{
    .nav,.topbar,.test-mode,.btn,.toggle,#add-box,.ro-acts,.no-print{display:none!important}
    body,.main,.panel{background:#fff!important;color:#000!important}
    .panel{border:1px solid #999!important}
    .page-title,.ro-name,.panel-title,.muted,.small,.page-sub,.panel-sub{color:#000!important}
    .ro-row{break-inside:avoid}
    .ro-row::before{content:'';display:inline-block;width:16px;height:16px;border:1px solid #000;margin-right:8px;flex-shrink:0}
  }
</style>`;

// ---------------------------------------------------------------- schedule
async function renderSchedule(ctx) {
  const now = bizNow(ctx.settings?.timezone);
  const today = now.slice(0, 10);
  const from = isDate(ctx.query.from) ? ctx.query.from : today;
  const to = addDays(from, 13);
  const [events, classes, lk, timeOff] = await Promise.all([api.get(`/events?from=${from}&to=${to}`), api.get('/classes'), api.get('/lookups'), api.get('/time-off').catch(() => [])]);
  if (!ctx.isCurrent()) return;
  const manage = canManage(ctx.me);
  const f = { q: ctx.query.q || '', type: ctx.query.type || '', coach: ctx.query.coach || '', loc: ctx.query.loc || '' };
  const coachName = (id) => lk.coaches.find((c) => String(c.id) === String(id))?.name;

  mount(ctx.el, html`${STYLE}<div class="stack sc-page">
    <header class="page-header">
      <div><h1 class="page-title">Schedule</h1><p class="page-sub">Classes, camps, clinics, team sessions, privates and evaluations. Tap a session to run its roster.</p></div>
      ${manage ? html`<div class="btn-row"><a class="btn" href="/app/schedule/hours">Hours & settings</a><button class="btn" id="add-one">Add one session</button><button class="btn btn-primary" id="add-class">Add class or camp</button></div>` : ''}
    </header>

    <section class="panel stack-sm">
      <div class="sc-nav">
        <div class="sc-range" aria-live="polite">${dayLabel(from, { month: 'short', day: 'numeric' })} – ${dayLabel(to, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
        <div class="btn-row">
          <a class="btn btn-sm" data-from="${addDays(from, -7)}" href="/app/schedule?from=${addDays(from, -7)}">Previous week</a>
          ${from !== today ? html`<a class="btn btn-sm" data-from="${today}" href="/app/schedule">Today</a>` : ''}
          <a class="btn btn-sm" data-from="${addDays(from, 7)}" href="/app/schedule?from=${addDays(from, 7)}">Next week</a>
        </div>
      </div>
      <form class="sc-filters" id="sc-f" role="search" onsubmit="return false">
        <div class="field sc-q"><label class="label" for="sc-q">Find a session</label><input class="input" id="sc-q" name="q" value="${f.q}" placeholder="Name, place or coach" autocomplete="off" type="search"></div>
        <div class="field"><label class="label" for="sc-type">Type</label><select class="input" id="sc-type" name="type">${TYPE_FILTERS.map(([v, l]) => html`<option value="${v}" ${v === f.type ? raw('selected') : ''}>${l}</option>`)}</select></div>
        <div class="field"><label class="label" for="sc-coach">Coach</label><select class="input" id="sc-coach" name="coach"><option value="">Every coach</option>${ctx.me.role !== 'frontdesk' ? html`<option value="me" ${f.coach === 'me' ? raw('selected') : ''}>My sessions</option>` : ''}${options(lk.coaches, f.coach)}</select></div>
        <div class="field"><label class="label" for="sc-loc">Where</label><select class="input" id="sc-loc" name="loc"><option value="">Everywhere</option>${options(lk.locations, f.loc)}</select></div>
      </form>
      <div class="sc-sum" id="sc-sum"></div>
    </section>

    <div id="sc-list" class="stack"></div>

    <section class="panel">
      <h2 class="panel-title">Classes & camps</h2>
      ${classes.length ? html`<div class="list">${classes.map((c) => html`<div class="list-row">
        <div class="grow"><div class="strong">${c.name}</div>
          <div class="small muted">${c.days} ${hhmm(c.start_time)} · ${c.duration_min} min · ${c.location || 'No location'}${c.coach_id && coachName(c.coach_id) ? ` · ${coachName(c.coach_id)}` : ''} · ${c.capacity} spots${ages(c) ? ` · ${ages(c)}` : ''}${c.start_date && c.type !== 'class' && c.type !== 'team' ? ` · ${dayLabel(c.start_date, { month: 'short', day: 'numeric' })}–${dayLabel(c.end_date, { month: 'short', day: 'numeric' })}` : ''}${c.price_cents != null && c.price_cents > 0 ? ` · ${money(c.price_cents)} drop-in` : ''}${c.reg_price_cents ? ` · ${money(c.reg_price_cents)} registration` : ''}</div></div>
        ${typeBadge(c.type)}
        ${manage ? html`<button class="btn btn-ghost btn-sm" data-edit="${c.id}" aria-label="Edit ${c.name}">Edit</button><button class="btn btn-ghost btn-sm" data-archive="${c.id}" aria-label="Archive ${c.name}">Archive</button>` : ''}
      </div>`)}</div>` : html`<p class="muted" style="margin:0">No weekly classes or camps yet.${manage ? ' Add a class or camp and its sessions appear on the schedule.' : ''}</p>`}
    </section></div>`);

  // Filtering is instant and kept in the address so a reload or a shared link shows the same view.
  const listEl = ctx.el.querySelector('#sc-list'), sumEl = ctx.el.querySelector('#sc-sum'), form = ctx.el.querySelector('#sc-f');
  const draw = () => {
    const q = f.q.trim().toLowerCase();
    const coachId = f.coach === 'me' ? String(ctx.me.id) : f.coach;
    const shown = events.filter((e) => typeMatch(f.type, e.type) && (!coachId || String(e.coach_id) === coachId) && (!f.loc || String(e.location_id) === f.loc)
      && (!q || [e.name, e.location, e.coach].some((x) => String(x || '').toLowerCase().includes(q))));
    const live = shown.filter((e) => !e.cancelled);
    const sum = { sessions: live.length, booked: live.reduce((n, e) => n + (e.type === 'team' ? 0 : e.booked), 0), unpaid: live.reduce((n, e) => n + e.unpaid, 0), wait: live.reduce((n, e) => n + e.waitlisted, 0) };
    mount(sumEl, html`<span><strong>${sum.sessions}</strong> ${sum.sessions === 1 ? 'session' : 'sessions'}</span><span><strong>${sum.booked}</strong> booked</span>
      <span class="${sum.unpaid ? 'warn' : ''}"><strong>${sum.unpaid}</strong> unpaid</span><span><strong>${sum.wait}</strong> on waitlists</span>`);
    const byDay = {};
    for (const e of shown) (byDay[e.starts_at.slice(0, 10)] ||= []).push(e);
    const offOn = (d) => timeOff.filter((t) => t.start_date <= d && t.end_date >= d);
    const filtered = f.q || f.type || f.coach || f.loc;
    mount(listEl, Object.keys(byDay).length ? Object.entries(byDay).map(([d, list]) => html`<section class="panel sc-day" aria-label="${dayLabel(d)}">
      <h2>${dayLabel(d)}${d === today ? html`<span class="muted small">Today</span>` : ''}${offOn(d).map((t) => html`<span class="sc-off">${t.coach ? `${t.coach} off` : 'Facility closed'}${t.note ? `: ${t.note}` : ''}</span>`)}</h2>
      ${list.map((e) => sessionRow(e, now))}
    </section>`) : html`<div class="empty">${filtered ? html`No sessions match these filters. <button class="btn btn-ghost btn-sm" id="sc-clear">Clear filters</button>`
      : `Nothing scheduled ${from === today ? 'in the next two weeks' : 'these two weeks'}.${manage ? ' Add a class or camp, or one session, to get started.' : ''}`}</div>`);
    listEl.querySelector('#sc-clear')?.addEventListener('click', () => {
      Object.assign(f, { q: '', type: '', coach: '', loc: '' });
      form.querySelectorAll('input,select').forEach((x) => { x.value = ''; });
      sync();
    });
  };
  const href = (start) => {
    const p = new URLSearchParams();
    if (start !== today) p.set('from', start);
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    const qs = p.toString();
    return `/app/schedule${qs ? `?${qs}` : ''}`;
  };
  const sync = () => {
    history.replaceState(history.state, '', href(from));
    ctx.el.querySelectorAll('[data-from]').forEach((a) => { a.href = href(a.dataset.from); });
    draw();
  };
  const onFilter = () => {
    const d = formData(form), next = { q: d.q || '', type: d.type || '', coach: d.coach || '', loc: d.loc || '' };
    if (Object.keys(next).every((k) => next[k] === f[k])) return; // a blur's change event shouldn't redraw mid-click
    Object.assign(f, next); sync();
  };
  form.addEventListener('change', onFilter);
  form.q.addEventListener('input', debounce(onFilter, 150));
  sync();

  ctx.el.querySelector('#add-class')?.addEventListener('click', () => classModal(ctx, lk));
  ctx.el.querySelector('#add-one')?.addEventListener('click', () => oneOffModal(ctx, lk, today));
  ctx.el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => classModal(ctx, lk, classes.find((x) => x.id === +b.dataset.edit))));
  ctx.el.querySelectorAll('[data-archive]').forEach((b) => b.addEventListener('click', async () => {
    const c = classes.find((x) => x.id === +b.dataset.archive);
    const future = events.filter((e) => e.class_id === c.id && !e.cancelled && e.starts_at > now);
    const ok = await modal({
      title: `Archive ${c.name}`,
      body: html`<p style="margin:0">Every future session of ${c.name} is cancelled. Credits go back, drop-ins are refunded and booked families are emailed.</p>
        <p class="muted small" style="margin:0">${future.length ? `${plural(future.length, 'session')} in these two weeks, plus any after.` : 'No sessions in these two weeks.'}</p>
        <div class="field"><label class="label" for="ar-reason">Reason for families (optional)</label><input class="input" id="ar-reason" placeholder="${c.name} is no longer running" maxlength="300"></div>`,
      actions: [{ label: 'Keep it', value: null }, { label: 'Archive and cancel sessions', kind: 'warn', onClick: async (body) => api.post(`/classes/${c.id}/archive`, { reason: body.querySelector('#ar-reason').value }) }],
    });
    if (ok) { toast(`${c.name} archived. ${plural(ok.cancelled, 'session')} cancelled.`); ctx.reload(); }
  }));
}

function sessionRow(e, now) {
  const st = stateOf(e, now);
  const expected = e.type === 'team' ? e.team_size : e.booked;
  const pct = expected ? Math.min(100, Math.round((e.checked_in / expected) * 100)) : 0;
  const count = e.type === 'team' ? `${e.checked_in ? `${e.checked_in} of ` : ''}${e.team_size} on the team${e.checked_in ? ' here' : ''}` : `${e.booked}/${e.capacity ?? '∞'} booked${e.checked_in ? ` · ${e.checked_in} checked in` : ''}`;
  return html`<a class="sc-row ${e.cancelled ? 'cancelled' : ''} ${st === 'done' ? 'is-done' : ''}" href="/app/schedule/session/${e.id}">
    <div class="sc-time">${fmtTime(e.starts_at)}</div>
    <div class="sc-grow"><div class="sc-name">${e.name}${st === 'now' ? html` <span class="small sc-now">· On now</span>` : st === 'done' ? html` <span class="small muted">· Done</span>` : ''}</div>
      <div class="small muted">${e.location || 'No location'}${e.coach ? ` · ${e.coach}` : ''} · ${count}</div>
      ${e.staff_note && !e.cancelled ? html`<div class="sc-note">Note: ${e.staff_note}</div>` : ''}
      ${!e.cancelled && (st === 'now' || st === 'done') && expected ? html`<div class="bar sc-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>` : ''}</div>
    <div class="sc-badges">${e.cancelled ? badge('cancelled') : html`${e.unpaid ? badge('unpaid', `${e.unpaid} unpaid`) : ''}${e.waitlisted ? badge('waitlist', `${e.waitlisted} waitlist`) : ''}${e.capacity && e.booked >= e.capacity && e.type !== 'team' ? badge('off', 'Full') : ''}`}${typeBadge(e.type)}</div>
  </a>`;
}

// Add or edit a class or camp. Editing changes every upcoming session.
async function classModal(ctx, lk, c = null) {
  const edit = !!c;
  const showPrice = !edit || ctx.me.role === 'owner';
  const coachOpts = options(lk.coaches, edit ? c.coach_id : ctx.me.role === 'frontdesk' ? '' : ctx.me.id, { blank: 'No coach set' });
  const days = edit ? String(c.weekdays).split(',').map(Number) : [];
  const camp = edit && (c.type === 'camp' || c.type === 'clinic');
  const r = await modal({
    title: edit ? `Edit ${c.name}` : 'Add class or camp', wide: true,
    body: html`<form id="cf" class="stack" novalidate>
      <div class="form-grid">
        <div class="field span-2"><label class="label" for="cf-name">Name</label><input class="input" id="cf-name" name="name" required maxlength="80" placeholder="Youth Speed & Agility" value="${c?.name || ''}"></div>
        <div class="field"><span class="label" id="cf-type-l">Type</span>
          ${edit ? html`<div>${typeBadge(c.type)}</div>` : html`<div class="seg" role="group" aria-labelledby="cf-type-l">${['class', 'camp', 'clinic'].map((t, i) => html`<button type="button" data-type="${t}" aria-pressed="${String(i === 0)}">${t[0].toUpperCase() + t.slice(1)}</button>`)}</div>`}</div>
        <div class="field"><label class="label" for="cf-loc">Where</label><select class="input" id="cf-loc" name="location_id">${options(lk.locations, c?.location_id ?? lk.locations[0]?.id)}</select></div>
        <div class="field span-2"><span class="label" id="cf-days-l">Days</span>
          <div class="days-pick" role="group" aria-labelledby="cf-days-l">${DAYS.map((d, i) => html`<label><input type="checkbox" name="weekdays" data-multi value="${i}" ${days.includes(i) ? raw('checked') : ''}><span>${d}</span></label>`)}</div></div>
        <div class="field"><label class="label" for="cf-time">Start time</label><input class="input" id="cf-time" name="start_time" type="time" value="${c?.start_time || '16:30'}" required></div>
        <div class="field"><label class="label" for="cf-len">Length (minutes)</label><input class="input" id="cf-len" name="duration_min" type="number" min="15" max="600" step="5" value="${c?.duration_min || 60}"></div>
        <div class="field"><label class="label" for="cf-cap">Spots</label><input class="input" id="cf-cap" name="capacity" type="number" min="1" max="500" value="${c?.capacity || 12}"></div>
        <div class="field"><span class="label">Ages</span><div class="row" style="flex-wrap:nowrap"><input class="input" name="min_age" type="number" min="3" max="99" placeholder="From" aria-label="Youngest age" value="${c?.min_age ?? ''}"><span class="muted">to</span><input class="input" name="max_age" type="number" min="3" max="99" placeholder="To" aria-label="Oldest age" value="${c?.max_age ?? ''}"></div></div>
        ${showPrice ? html`<div class="field"><label class="label" for="cf-price">Drop-in price ($)</label><input class="input" id="cf-price" name="price" inputmode="decimal" placeholder="0" value="${dollars(c?.price_cents)}"><span class="hint">Members and pack credits cover it.</span></div>` : ''}
        <div class="field"><label class="label" for="cf-coach">Coach</label><select class="input" id="cf-coach" name="coach_id">${coachOpts}</select></div>
      </div>
      <fieldset id="cf-camp" ${camp ? '' : raw('hidden')}><legend>Camp or clinic</legend><div class="form-grid">
        <div class="field"><label class="label" for="cf-start">First day</label><input class="input" id="cf-start" name="start_date" type="date" value="${c?.start_date || ''}"></div>
        <div class="field"><label class="label" for="cf-end">Last day</label><input class="input" id="cf-end" name="end_date" type="date" value="${c?.end_date || ''}"></div>
        ${showPrice ? html`<div class="field"><label class="label" for="cf-reg">Registration price ($)</label><input class="input" id="cf-reg" name="reg_price" inputmode="decimal" placeholder="199" value="${dollars(c?.reg_price_cents)}"><span class="hint">Charged once for every day.</span></div>` : ''}
        <div class="field"><label class="label" for="cf-dead">Last day to register</label><input class="input" id="cf-dead" name="reg_deadline" type="date" value="${c?.reg_deadline || ''}"></div>
      </div></fieldset>
      <p class="hint" style="margin:0">${edit ? 'Changes apply to every upcoming session. If the time or place changes, booked families are emailed. Sessions on days you take away are cancelled: credits go back and families are emailed.'
        : 'Sessions are created automatically, eight weeks ahead for weekly classes.'}</p>
      <div class="error" id="cf-err" role="alert"></div>
    </form>`,
    onMount: (body) => {
      body.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => {
        body.querySelectorAll('[data-type]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        body.querySelector('#cf-camp').hidden = b.dataset.type === 'class';
      }));
    },
    actions: [{ label: 'Cancel', value: null }, { label: edit ? 'Save changes' : 'Save class', kind: 'primary', onClick: async (body) => {
      const d = formData(body.querySelector('#cf'));
      const type = edit ? c.type : body.querySelector('[data-type][aria-pressed="true"]').dataset.type;
      const err = body.querySelector('#cf-err');
      err.textContent = '';
      const payload = { ...d };
      delete payload.price; delete payload.reg_price;
      if (showPrice) {
        const price = d.price ? toCents(d.price) : 0, reg = d.reg_price ? toCents(d.reg_price) : null;
        if (Number.isNaN(price) || Number.isNaN(reg)) { err.textContent = 'Enter prices as numbers, like 30 or 30.00.'; return false; }
        payload.price_cents = price;
        if (type !== 'class') payload.reg_price_cents = reg;
      }
      if (!edit) payload.type = type;
      try { return await (edit ? api.put(`/classes/${c.id}`, payload) : api.post('/classes', payload)); }
      catch (e) { err.textContent = e.message; return false; }
    } }],
  });
  if (!r) return;
  if (edit) {
    const bits = [plural(r.updated, 'upcoming session') + ' updated', r.moved && `${r.moved} moved`, r.cancelled && `${r.cancelled} cancelled`, r.added && `${r.added} added`].filter(Boolean);
    toast(`Saved. ${bits.join(', ')}.${r.notified ? ` ${plural(r.notified, 'family', 'families')} emailed.` : ''}`);
  } else toast(`Saved. ${plural(r.sessions, 'session')} on the schedule.`);
  ctx.reload();
}

// One session that isn't part of a weekly class: a makeup, a holiday clinic.
async function oneOffModal(ctx, lk, today) {
  const r = await modal({
    title: 'Add one session', wide: true,
    body: html`<form id="of" class="stack" novalidate>
      <div class="form-grid">
        <div class="field span-2"><label class="label" for="of-name">Name</label><input class="input" id="of-name" name="name" required maxlength="80" placeholder="Makeup: Speed & Agility"></div>
        <div class="field"><span class="label" id="of-type-l">Type</span>
          <div class="seg" role="group" aria-labelledby="of-type-l">${[['class', 'Group'], ['clinic', 'Clinic']].map(([t, l], i) => html`<button type="button" data-type="${t}" aria-pressed="${String(i === 0)}">${l}</button>`)}</div></div>
        <div class="field"><label class="label" for="of-loc">Where</label><select class="input" id="of-loc" name="location_id">${options(lk.locations, lk.locations[0]?.id)}</select></div>
        <div class="field"><label class="label" for="of-date">Date</label><input class="input" id="of-date" name="date" type="date" min="${today}" value="${today}"></div>
        <div class="field"><label class="label" for="of-time">Start time</label><input class="input" id="of-time" name="start_time" type="time" value="16:30"></div>
        <div class="field"><label class="label" for="of-len">Length (minutes)</label><input class="input" id="of-len" name="duration_min" type="number" min="15" max="600" step="5" value="60"></div>
        <div class="field"><label class="label" for="of-cap">Spots</label><input class="input" id="of-cap" name="capacity" type="number" min="1" max="500" value="12"></div>
        <div class="field"><label class="label" for="of-price">Drop-in price ($)</label><input class="input" id="of-price" name="price" inputmode="decimal" placeholder="0"><span class="hint">Members and pack credits cover it.</span></div>
        <div class="field"><label class="label" for="of-coach">Coach</label><select class="input" id="of-coach" name="coach_id">${options(lk.coaches, ctx.me.id, { blank: 'No coach set' })}</select></div>
        <div class="field span-2"><label class="label" for="of-note">Note for staff (optional)</label><input class="input" id="of-note" name="staff_note" maxlength="500" placeholder="Makeup for the rained-out Tuesday session"></div>
      </div>
      <p class="hint" style="margin:0">Parents see it in the portal and can book it like any class.</p>
      <div class="error" id="of-err" role="alert"></div></form>`,
    onMount: (body) => body.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => body.querySelectorAll('[data-type]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))))),
    actions: [{ label: 'Cancel', value: null }, { label: 'Add session', kind: 'primary', onClick: async (body) => {
      const d = formData(body.querySelector('#of'));
      const err = body.querySelector('#of-err'); err.textContent = '';
      const price = d.price ? toCents(d.price) : 0;
      if (Number.isNaN(price)) { err.textContent = 'Enter the price as a number, like 30.'; return false; }
      delete d.price;
      try { return await api.post('/events', { ...d, type: body.querySelector('[data-type][aria-pressed="true"]').dataset.type, price_cents: price }); }
      catch (e) { err.textContent = e.message; return false; }
    } }],
  });
  if (r) { toast('Session added. Open it to add athletes.'); ctx.go(`/app/schedule/session/${r.id}`); }
}

// ---------------------------------------------------------------- roster
function medical(a) {
  const bits = [a.allergies && `Allergy: ${a.allergies}`, a.injuries && `Injury: ${a.injuries}`, a.medical_notes && `Medical: ${a.medical_notes}`].filter(Boolean);
  return bits.length ? html`<div class="ro-med">${bits.join(' · ')}</div>` : '';
}
function who(a) {
  const bits = [a.age != null ? `Age ${a.age}` : null, a.family].filter(Boolean).join(' · ');
  const tel = a.parent_phone ? html`${bits ? ' · ' : ''}<a class="muted ro-tel" href="tel:${a.parent_phone.replace(/[^\d+]/g, '')}">${a.parent_phone}</a>` : '';
  const flags = [a.waiver_missing && badge('warn', 'No waiver'), a.birthday_today && badge('member', 'Birthday')].filter(Boolean);
  return html`<a class="ro-name" href="/app/clients/${a.id}">${a.first_name} ${a.last_name}</a>
    <div class="small muted">${bits}${tel}</div>
    ${medical(a)}${flags.length ? html`<div class="ro-flags">${flags}</div>` : ''}`;
}

async function renderRoster(ctx) {
  let d = await api.get(`/events/${ctx.params.id}`);
  if (!ctx.isCurrent()) return;
  const manage = canManage(ctx.me);
  // Redraw in place after each action, so the page doesn't jump back to the top mid-roster.
  const refresh = async () => {
    const y = window.scrollY;
    d = await api.get(`/events/${ctx.params.id}`);
    if (!ctx.isCurrent()) return;
    draw();
    window.scrollTo(0, y);
  };

  function draw() {
    const e = d.event;
    const now = bizNow(ctx.settings?.timezone);
    const st = stateOf(e, now), past = st === 'done';
    const isTeam = !!d.team;
    const unpaid = d.booked.filter((b) => b.coverage === 'unpaid').length;
    const checked = d.booked.filter((b) => b.checked_in_at).length;
    const full = e.capacity && d.booked.length >= e.capacity;
    const sub = `${dayLabel(e.starts_at.slice(0, 10))} · ${fmtTime(e.starts_at)}–${fmtTime(endAt(e))} · ${e.location || 'No location'}${e.coach ? ` · ${e.coach}` : ''}`;
    const checkBtn = (id, on) => html`<button class="btn btn-sm ro-check" data-check="${id}" aria-pressed="${String(!!on)}" ${e.cancelled ? raw('disabled') : ''}>${on ? 'Checked in' : 'Check in'}</button>`;

    const bookingRow = (b) => html`<div class="ro-row">
      ${checkBtn(b.id, b.checked_in_at)}
      <div class="grow" style="flex:1;min-width:0">${who(b.athlete)}</div>
      <div class="ro-right">${past && !b.checked_in_at && !e.cancelled ? badge('off', 'No-show') : ''}${badge(b.coverage || 'open')}
        ${b.coverage === 'unpaid' && !e.cancelled ? html`<button class="btn btn-outline btn-sm" data-collect="${b.id}">Collect</button>` : ''}
        ${!e.cancelled ? html`<button class="btn btn-ghost btn-sm" data-remove="${b.id}" aria-label="Remove ${b.athlete.first_name} ${b.athlete.last_name}">Remove</button>` : ''}</div>
    </div>`;
    const teamRow = (r) => html`<div class="ro-row">
      ${r.booking ? checkBtn(r.booking.id, r.booking.checked_in_at)
        : html`<button class="btn btn-sm ro-check" data-teamcheck="${r.athlete.id}" aria-pressed="false" ${e.cancelled ? raw('disabled') : ''}>Check in</button>`}
      <div class="grow" style="flex:1;min-width:0">${who(r.athlete)}</div>
      ${past && !r.booking?.checked_in_at && !e.cancelled ? html`<div class="ro-right">${badge('off', 'No-show')}</div>` : ''}
      </div>`;

    const addBox = e.cancelled ? '' : html`<div class="stack-sm" id="add-box">
      <label class="label" for="add-q">${isTeam ? 'Add a guest' : 'Add an athlete'}${full ? ' (the session is full, so they go on the waitlist)' : ''}</label>
      <input class="input" id="add-q" placeholder="Name, Athlete ID or email" autocomplete="off" type="search" aria-controls="add-results">
      <div class="ro-results" id="add-results" hidden></div></div>`;

    const teamHere = isTeam ? d.team.roster.filter((r) => r.booking?.checked_in_at).length : 0;
    const nFam = isTeam ? d.team.roster.length + d.guests.length : d.booked.length;
    mount(ctx.el, html`${STYLE}<div class="stack sc-page">
      <header class="page-header">
        <div><h1 class="page-title">${e.name}</h1><p class="page-sub">${sub}${st === 'now' ? html` · <span class="sc-now">On now</span>` : ''}</p></div>
        <a class="btn" href="/app/schedule">Schedule</a>
      </header>
      <div class="ro-acts no-print">
        ${manage && !e.cancelled ? html`<button class="btn btn-sm" id="edit-session">Edit session</button>` : ''}
        ${!e.cancelled && nFam ? html`<button class="btn btn-sm" id="email-fams">Email families</button>` : ''}
        <button class="btn btn-sm" id="print">Print roster</button>
      </div>
      ${e.cancelled ? html`<div class="banner">This session was cancelled.${e.cancel_reason ? ` Reason: ${e.cancel_reason}.` : ''} Families were emailed and credits went back.</div>` : ''}
      ${e.staff_note && !e.cancelled ? html`<div class="banner info"><span><strong>Note for staff:</strong> ${e.staff_note}</span></div>` : ''}

      ${isTeam ? html`<section class="panel">
        <div class="panel-head"><div><h2 class="panel-title">${d.team.name || 'Team'} · ${teamHere}/${d.team.roster.length} here</h2>
          <p class="panel-sub">${d.team.school || ''}${d.team.school ? ' · ' : ''}Team sessions use the team roster. <a href="/app/teams/${d.team.id}">Open the team</a>.</p></div>
          ${!e.cancelled && teamHere < d.team.roster.length ? html`<button class="btn btn-primary" id="everyone">Everyone's here</button>` : ''}</div>
        ${d.team.roster.length ? html`<div class="list">${d.team.roster.map(teamRow)}</div>` : html`<p class="muted" style="margin:0">No athletes on this team yet. <a href="/app/teams/${d.team.id}">Add players to the team</a>.</p>`}
      </section>
      <section class="panel stack-sm"><h2 class="panel-title">Guests · ${d.guests.length}</h2>${d.guests.length ? html`<div class="list">${d.guests.map(bookingRow)}</div>` : html`<p class="muted small" style="margin:0">Athletes who aren't on the team but are joining this session.</p>`}${addBox}</section>`
      : html`<section class="panel stack-sm">
        <div><h2 class="panel-title">Roster · ${d.booked.length}/${e.capacity ?? '∞'}${full ? ' · Full' : ''}</h2>
          <p class="panel-sub">${checked} of ${d.booked.length} checked in · ${unpaid} unpaid${ages(d.class) ? ` · ${ages(d.class)}` : ''}${e.price_cents && ctx.me.role !== 'coach' ? ` · ${money(e.price_cents)} drop-in` : ''}</p></div>
        ${d.booked.length ? html`<div class="list">${d.booked.map(bookingRow)}</div>` : html`<p class="muted" style="margin:0">Nobody booked yet. Search below to add someone.</p>`}
        ${addBox}
      </section>`}

      ${d.waitlist.length ? html`<section class="panel"><div><h2 class="panel-title">Waitlist · ${d.waitlist.length}</h2>
        <p class="panel-sub">They move up in this order when someone cancels, and the family is emailed. Move someone up now to go over the spots.</p></div>
        <div class="list">${d.waitlist.map((w, i) => html`<div class="ro-row"><span class="muted" style="min-width:24px">${i + 1}.</span>
          <div style="flex:1;min-width:0">${who(w.athlete)}</div>
          <div class="ro-right"><button class="btn btn-outline btn-sm" data-promote="${w.id}">Move up</button><button class="btn btn-ghost btn-sm" data-remove="${w.id}" aria-label="Remove ${w.athlete.first_name} from the waitlist">Remove</button></div></div>`)}</div></section>` : ''}

      ${manage && !e.cancelled ? html`<div class="spread no-print" style="justify-content:flex-end"><button class="btn btn-ghost" id="cancel-session">${past ? 'Cancel this session (already happened)' : 'Cancel this session'}</button></div>` : ''}</div>`);
    bind(e, sub, isTeam);
  }

  function bind(e, sub, isTeam) {
    const act = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (err) { toastError(err); btn.disabled = false; } };
    const all = [...d.booked, ...d.waitlist];

    ctx.el.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      if (on) await api.post(`/bookings/${b.dataset.check}/checkin`); else await api.del(`/bookings/${b.dataset.check}/checkin`);
      const row = all.find((x) => x.id === +b.dataset.check) || d.team?.roster.find((r) => r.booking?.id === +b.dataset.check)?.booking;
      if (!on && row) toast(`Check-in undone.`);
      await refresh();
    })));
    ctx.el.querySelectorAll('[data-teamcheck]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
      await api.post(`/events/${e.id}/team-checkin`, { athlete_id: +b.dataset.teamcheck });
      await refresh();
    })));
    ctx.el.querySelector('#everyone')?.addEventListener('click', (ev) => act(ev.currentTarget, async () => {
      const r = await api.post(`/events/${e.id}/everyone-here`);
      toast(`${plural(r.checked_in, 'athlete')} checked in. Tap anyone who isn't here to undo.`);
      await refresh();
    }));
    ctx.el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      const row = [...all, ...(d.guests || [])].find((x) => x.id === +b.dataset.remove);
      const a = row.athlete;
      const note = row.status === 'waitlist' ? 'They come off the waitlist.' : row.coverage === 'credit' ? 'The session credit goes back to them.' : row.coverage === 'paid' && row.paid_cents ? 'Their drop-in payment is refunded.' : 'The next person on the waitlist moves up.';
      if (!(await confirmDialog(`Remove ${a.first_name}?`, `${a.first_name} ${a.last_name} comes off ${e.name}. ${note}`, 'Remove', 'warn'))) return;
      try { await api.del(`/bookings/${row.id}`); toast(`${a.first_name} removed.`); await refresh(); } catch (err) { toastError(err); }
    }));
    ctx.el.querySelectorAll('[data-promote]').forEach((b) => b.addEventListener('click', async () => {
      const row = d.waitlist.find((x) => x.id === +b.dataset.promote);
      const full = e.capacity && d.booked.length >= e.capacity;
      if (full && !(await confirmDialog(`Move ${row.athlete.first_name} up?`, `The session has ${e.capacity} spots and ${d.booked.length} booked. Moving ${row.athlete.first_name} up puts it at ${d.booked.length + 1}. The family is emailed.`, 'Move up and go over', 'primary'))) return;
      act(b, async () => { const r = await api.post(`/bookings/${row.id}/promote`); toast(r.message); await refresh(); });
    }));
    ctx.el.querySelectorAll('[data-collect]').forEach((b) => b.addEventListener('click', async () => {
      const row = d.booked.find((x) => x.id === +b.dataset.collect);
      if (await collectModal(e, row, d.payments_mode)) await refresh();
    }));
    ctx.el.querySelector('#print')?.addEventListener('click', () => window.print());
    ctx.el.querySelector('#edit-session')?.addEventListener('click', async () => { if (await editSessionModal(e, d.booked.length)) await refresh(); });
    ctx.el.querySelector('#email-fams')?.addEventListener('click', () => emailModal(e, d, isTeam));
    ctx.el.querySelector('#cancel-session')?.addEventListener('click', async () => {
      const booked = d.booked.length;
      const r = await modal({
        title: 'Cancel this session',
        body: html`<p style="margin:0">${e.name}, ${sub}. ${booked ? `${plural(booked, 'booked athlete')}'s ${booked === 1 ? 'family gets' : 'families get'} an email with your reason. Credits go back and drop-ins are refunded.` : 'Nobody is booked.'}${isTeam ? ' The school contact is emailed too.' : ''}</p>
          <div class="field"><label class="label" for="cx-reason">Reason</label><input class="input" id="cx-reason" placeholder="Lightning in the area" maxlength="300" required></div>
          <div class="error" id="cx-err" role="alert"></div>`,
        actions: [{ label: 'Keep the session', value: null }, { label: 'Cancel session and email families', kind: 'warn', onClick: async (body) => {
          const reason = body.querySelector('#cx-reason').value.trim();
          if (!reason) { body.querySelector('#cx-err').textContent = 'Give a reason. Families see it in the email.'; return false; }
          return api.post(`/events/${e.id}/cancel`, { reason });
        } }],
      });
      if (r) { toast(`Session cancelled. ${plural(r.notified, 'booking')} notified${r.team_notified ? ' and the school contact emailed' : ''}.`); await refresh(); }
    });

    // Add an athlete: search, then tap a result, or press Enter when there's one match.
    const q = ctx.el.querySelector('#add-q'), results = ctx.el.querySelector('#add-results');
    if (!q) return;
    let list = [];
    const inIt = new Set([...all, ...(d.guests || [])].map((x) => x.athlete.id));
    const add = async (id, btn) => {
      if (btn) btn.disabled = true;
      try { const r = await api.post(`/events/${e.id}/bookings`, { athlete_id: id }); toast(r.message); await refresh(); ctx.el.querySelector('#add-q')?.focus(); }
      catch (err) { toastError(err); if (btn) btn.disabled = false; }
    };
    const search = debounce(async () => {
      const term = q.value.trim();
      if (term.length < 2) { results.hidden = true; list = []; return; }
      list = await api.get(`/athletes/search?q=${encodeURIComponent(term)}`).catch(() => []);
      if (q.value.trim() !== term) return;
      const full = e.capacity && d.booked.length >= e.capacity;
      mount(results, list.length ? list.map((a) => html`<button type="button" data-add="${a.id}" ${inIt.has(a.id) ? raw('disabled') : ''}>
        <span><span class="strong">${a.first_name} ${a.last_name}</span> <span class="small muted">${a.code}${a.family ? ` · ${a.family}` : ''}</span></span>
        <span class="small ${inIt.has(a.id) ? 'muted' : 'good-text'}">${inIt.has(a.id) ? 'Already here' : full ? 'Add to waitlist' : 'Add'}</span></button>`)
        : html`<div class="small muted" style="padding:10px 12px">No athletes match. <a href="/app/clients/new">Add a new client</a>.</div>`);
      results.hidden = false;
    }, 200);
    q.addEventListener('input', search);
    q.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { q.value = ''; results.hidden = true; }
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const open = list.filter((a) => !inIt.has(a.id));
      if (open.length === 1) add(open[0].id);
      else if (open.length > 1) toast(`${open.length} athletes match. Tap the one you mean.`, 'warn');
    });
    results.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-add]');
      if (b && !b.disabled) add(+b.dataset.add, b);
    });
  }

  draw();
}

async function collectModal(e, row, mode) {
  const a = row.athlete;
  const card = a.card;
  const r = await modal({
    title: `Collect ${money(e.price_cents)}`,
    body: html`<p style="margin:0">${a.first_name} ${a.last_name} · drop-in for ${e.name}. The booking is marked paid when the payment goes through.</p>
      <div class="stack-sm" role="radiogroup" aria-label="How they're paying">
        <label class="pay-opt"><input type="radio" name="m" value="card" ${card ? raw('checked') : raw('disabled')}><span><span class="strong">Card on file</span><br><span class="small muted">${card ? `${card.brand} ••${card.last4}` : 'No card on file for this family.'}</span></span></label>
        <label class="pay-opt"><input type="radio" name="m" value="tap" ${card ? '' : raw('checked')}><span><span class="strong">Tap to Pay on iPhone</span><br><span class="small muted">${mode === 'test' ? 'Test mode: the tap is simulated.' : 'They tap their card or phone on your iPhone.'}</span></span></label>
        <label class="pay-opt"><input type="radio" name="m" value="cash"><span><span class="strong">Cash</span><br><span class="small muted">Record a cash payment.</span></span></label>
      </div>
      <div class="error" id="co-err" role="alert"></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: `Collect ${money(e.price_cents)}`, kind: 'primary', onClick: async (body) => {
      const method = body.querySelector('input[name="m"]:checked')?.value;
      try { return await api.post(`/bookings/${row.id}/collect`, { method }); }
      catch (err) { body.querySelector('#co-err').textContent = err.message; return false; }
    } }],
  });
  if (r) toast(r.message);
  return r;
}

// Change one session: a sub coach, a new time or place, more spots, or a note for staff.
async function editSessionModal(e, booked) {
  const lk = await api.get('/lookups');
  const fixedName = e.type === 'private' || e.type === 'evaluation';
  const r = await modal({
    title: 'Edit this session', wide: true,
    body: html`<form id="es" class="stack" novalidate>
      <div class="form-grid">
        ${fixedName ? '' : html`<div class="field span-2"><label class="label" for="es-name">Name</label><input class="input" id="es-name" name="name" maxlength="80" value="${e.name}"></div>`}
        <div class="field"><label class="label" for="es-date">Date</label><input class="input" id="es-date" name="date" type="date" value="${e.starts_at.slice(0, 10)}"></div>
        <div class="field"><label class="label" for="es-time">Start time</label><input class="input" id="es-time" name="start_time" type="time" value="${e.starts_at.slice(11, 16)}"></div>
        <div class="field"><label class="label" for="es-len">Length (minutes)</label><input class="input" id="es-len" name="duration_min" type="number" min="15" max="600" step="5" value="${e.duration_min}"></div>
        <div class="field"><label class="label" for="es-cap">Spots</label><input class="input" id="es-cap" name="capacity" type="number" min="${Math.max(1, booked)}" max="500" value="${e.capacity ?? ''}"><span class="hint">${booked ? `${plural(booked, 'athlete')} booked. Adding spots moves the waitlist up.` : 'Adding spots moves the waitlist up.'}</span></div>
        <div class="field"><label class="label" for="es-loc">Where</label><select class="input" id="es-loc" name="location_id">${options(lk.locations, e.location_id, { blank: 'No location' })}</select></div>
        <div class="field"><label class="label" for="es-coach">Coach</label><select class="input" id="es-coach" name="coach_id">${options(lk.coaches, e.coach_id, { blank: 'No coach set' })}</select></div>
        <div class="field span-2"><label class="label" for="es-note">Note for staff</label><textarea class="input" id="es-note" name="staff_note" rows="2" maxlength="500" style="min-height:64px" placeholder="Sub coach today, bring the sled">${e.staff_note || ''}</textarea><span class="hint">Staff see it on the schedule and roster. Families don't.</span></div>
      </div>
      ${booked ? html`<label class="check"><input type="checkbox" name="notify" checked><span>Email booked families if the day, time or place changes</span></label>` : ''}
      <p class="hint" style="margin:0">This changes only this session.${e.class_id ? ' To change every week, edit the class on the schedule.' : ''}</p>
      <div class="error" id="es-err" role="alert"></div></form>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Save session', kind: 'primary', onClick: async (body) => {
      const d = formData(body.querySelector('#es'));
      const err = body.querySelector('#es-err'); err.textContent = '';
      if (e.capacity == null && d.capacity === '') delete d.capacity;
      try { return await api.put(`/events/${e.id}`, { ...d, notify: booked ? !!d.notify : false }); }
      catch (x) { err.textContent = x.message; return false; }
    } }],
  });
  if (r) toast(`Session saved.${r.notified ? ` ${plural(r.notified, 'family', 'families')} emailed.` : ''}${r.promoted ? ` ${plural(r.promoted, 'athlete')} moved up from the waitlist.` : ''}`);
  return r;
}

async function emailModal(e, d, isTeam) {
  const r = await modal({
    title: 'Email families',
    body: html`<p style="margin:0">${isTeam ? `Goes to the families of everyone on ${d.team?.name || 'the team'}${d.guests.length ? ' and the guests' : ''}.` : `Goes to the ${plural(d.booked.length, 'booked athlete')}'s ${d.booked.length === 1 ? 'family' : 'families'}.`} It's signed with your name and noted in Recent activity.</p>
      <div class="field"><label class="label" for="em-msg">Message</label><textarea class="input" id="em-msg" rows="5" maxlength="1000" style="min-height:120px" placeholder="We're starting 10 minutes late today. Same place."></textarea></div>
      ${d.waitlist.length ? html`<label class="check"><input type="checkbox" id="em-wait"><span>Also email the ${plural(d.waitlist.length, 'family', 'families')} on the waitlist</span></label>` : ''}
      <div class="error" id="em-err" role="alert"></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Send email', kind: 'primary', onClick: async (body) => {
      const message = body.querySelector('#em-msg').value.trim();
      const err = body.querySelector('#em-err');
      if (!message) { err.textContent = 'Write a message first.'; return false; }
      try { return await api.post(`/events/${e.id}/message`, { message, waitlist: !!body.querySelector('#em-wait')?.checked }); }
      catch (x) { err.textContent = x.message; return false; }
    } }],
  });
  if (r) toast(`Sent to ${plural(r.sent, 'family', 'families')}.`);
}

// ---------------------------------------------------------------- hours & settings
async function renderHours(ctx) {
  const owner = ctx.me.role === 'owner';
  const [hours, settings, lk, eng, open, timeOff] = await Promise.all([api.get('/availability'), api.get('/settings'), api.get('/lookups'), api.get('/engage/settings').catch(() => null),
    api.get('/availability/open').catch(() => null), api.get('/time-off').catch(() => [])]);
  if (!ctx.isCurrent()) return;
  const dis = owner ? '' : raw('disabled');
  const today = bizNow(settings.timezone).slice(0, 10);
  const hourLabel = (v) => `${DAYS[v.weekday]} ${hhmm(v.start_time)}–${hhmm(v.end_time)} · ${v.slot_min} min · ${v.location || 'No location'}${v.kind === 'evaluation' && v.price_cents ? ` · ${money(v.price_cents)}` : ''}${v.coach ? ` · ${v.coach}` : ''}`;
  const group = (kind, title) => {
    const list = hours.filter((v) => v.kind === kind);
    return list.length ? html`<div class="hr-group"><h3>${title}</h3><div class="list">${list.map((v) => html`<div class="list-row"><div class="grow">${hourLabel(v)}</div>
      <button class="btn btn-ghost btn-sm" data-del="${v.id}" aria-label="Remove ${title} ${hourLabel(v)}">Remove</button></div>`)}</div></div>` : '';
  };
  const openLine = (o, one, many) => (o.count ? html`<span><strong>${o.count}</strong> ${o.count === 1 ? one : many}, next ${dayLabel(o.next.slice(0, 10), { weekday: 'short', month: 'short', day: 'numeric' })} ${hhmm(o.next.slice(11, 16))}</span>` : html`<span>No ${many} open</span>`);
  const offLabel = (t) => `${t.coach || 'Facility closed'} · ${t.start_date === t.end_date ? dayLabel(t.start_date, { weekday: 'short', month: 'short', day: 'numeric' }) : `${dayLabel(t.start_date, { month: 'short', day: 'numeric' })} to ${dayLabel(t.end_date, { month: 'short', day: 'numeric' })}`}${t.note ? ` · ${t.note}` : ''}`;

  mount(ctx.el, html`${STYLE}<div class="stack sc-page">
    <header class="page-header">
      <div><h1 class="page-title">Hours & settings</h1><p class="page-sub">Private and evaluation hours, time off, cancellation policy and your waiver.</p></div>
      <a class="btn" href="/app/schedule">Schedule</a>
    </header>

    <section class="panel stack-sm">
      <div><h2 class="panel-title">Your hours for privates and evaluations</h2>
        <p class="panel-sub">Parents book open times in the portal. Anything else on that coach's schedule, and time off, blocks the time.</p></div>
      ${open ? html`<div class="hr-open" aria-live="polite"><span>Open to book in the next 7 days:</span>${openLine(open.private, 'private time', 'private times')}${openLine(open.evaluation, 'evaluation time', 'evaluation times')}</div>` : ''}
      ${hours.length ? html`<div>${group('private', 'Privates')}${group('evaluation', 'Evaluations')}</div>`
        : html`<p class="muted" style="margin:0">No hours yet. Parents can't book privates or evaluations until you add some.</p>`}
      <form id="hf" class="stack" novalidate style="border-top:1px solid var(--line-subtle);padding-top:var(--space-4)">
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
          <div class="field"><label class="label" for="hf-kind">For</label><select class="input" id="hf-kind" name="kind"><option value="private">Private training</option><option value="evaluation">Evaluations</option></select></div>
          <div class="field"><label class="label" for="hf-loc">Where</label><select class="input" id="hf-loc" name="location_id">${options(lk.locations, lk.locations[0]?.id)}</select></div>
          <div class="field"><label class="label" for="hf-coach">Coach</label><select class="input" id="hf-coach" name="coach_id">${options(lk.coaches, ctx.me.id)}</select></div>
        </div>
        <div class="field"><span class="label" id="hf-days-l">Days</span>
          <div class="days-pick" role="group" aria-labelledby="hf-days-l">${DAYS.map((d, i) => html`<label><input type="checkbox" name="weekdays" data-multi value="${i}" ${i === 1 ? raw('checked') : ''}><span>${d}</span></label>`)}</div>
          <span class="hint">Pick every day these hours repeat, like Monday to Friday.</span></div>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
          <div class="field"><label class="label" for="hf-from">From</label><input class="input" id="hf-from" name="start_time" type="time" value="15:00"></div>
          <div class="field"><label class="label" for="hf-to">To</label><input class="input" id="hf-to" name="end_time" type="time" value="19:00"></div>
          <div class="field"><label class="label" for="hf-slot">Minutes each</label><input class="input" id="hf-slot" name="slot_min" type="number" min="15" max="240" step="5" value="60"></div>
          <div class="field"><label class="label" for="hf-price">Price ($)</label><input class="input" id="hf-price" name="price" inputmode="decimal" placeholder="Evaluations only" disabled></div>
        </div>
        <div class="error" id="hf-err" role="alert"></div>
        <div><button class="btn btn-outline">Add hours</button></div>
      </form>
    </section>

    <section class="panel stack-sm">
      <div><h2 class="panel-title">Time off</h2>
        <p class="panel-sub">A coach away, or the whole facility closed for a holiday. Parents aren't offered private or evaluation times on those days. Classes don't change: cancel those sessions from the schedule.</p></div>
      ${timeOff.length ? html`<div class="list">${timeOff.map((t) => html`<div class="list-row"><div class="grow">${offLabel(t)}</div>
        <button class="btn btn-ghost btn-sm" data-deloff="${t.id}" aria-label="Remove time off ${offLabel(t)}">Remove</button></div>`)}</div>` : html`<p class="muted" style="margin:0">No time off coming up.</p>`}
      <form id="tf" class="stack" novalidate style="border-top:1px solid var(--line-subtle);padding-top:var(--space-4)">
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
          <div class="field"><label class="label" for="tf-who">Who</label><select class="input" id="tf-who" name="coach_id">${options(lk.coaches, ctx.me.id, { blank: 'Facility closed' })}</select></div>
          <div class="field"><label class="label" for="tf-start">First day</label><input class="input" id="tf-start" name="start_date" type="date" min="${today}" value="${today}"></div>
          <div class="field"><label class="label" for="tf-end">Last day</label><input class="input" id="tf-end" name="end_date" type="date" min="${today}" value="${today}"></div>
          <div class="field"><label class="label" for="tf-note">Note (optional)</label><input class="input" id="tf-note" name="note" maxlength="120" placeholder="Thanksgiving"></div>
        </div>
        <div class="error" id="tf-err" role="alert"></div>
        <div><button class="btn btn-outline">Add time off</button></div>
      </form>
    </section>

    ${eng ? html`<section class="panel" id="rk">
      <div class="spread" style="align-items:flex-start;flex-wrap:nowrap">
        <div><h2 class="panel-title" id="rk-t">Rankings</h2>
          <p class="panel-sub">Athletes and parents see where they rank by best result against their age group, team and everyone at the gym. No names are shown.</p></div>
        <button class="toggle" id="rk-b" aria-pressed="${eng.rankings_enabled ? 'true' : 'false'}" aria-label="Show rankings to athletes and parents">${eng.rankings_enabled ? 'On' : 'Off'}</button>
      </div></section>` : ''}

    <section class="panel">
      <div><h2 class="panel-title">Policies</h2>
        ${owner ? '' : html`<p class="panel-sub">Only owners can change these. You can set the time zone.</p>`}</div>
      <form id="pf" class="stack" novalidate>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
          <div class="field"><label class="label" for="pf-bn">Business name</label><input class="input" id="pf-bn" name="business_name" value="${settings.business_name || ''}" ${dis}></div>
          <div class="field"><label class="label" for="pf-tz">Time zone</label><input class="input" id="pf-tz" name="timezone" value="${settings.timezone || ''}" list="tz-list" autocomplete="off"><span class="hint">Like America/Denver</span>
            <datalist id="tz-list">${(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone').filter((z) => z.startsWith('America/') || z.startsWith('Pacific/')) : []).map((z) => html`<option value="${z}">`)}</datalist></div>
          <div class="field"><label class="label" for="pf-lc">Late-cancel window (hours)</label><input class="input" id="pf-lc" name="late_cancel_hours" type="number" min="0" max="72" value="${settings.late_cancel_hours ?? 12}" ${dis}><span class="hint">Cancels inside this still use the session.</span></div>
        </div>
        <div class="grid-2">
          <div class="field"><label class="label" for="pf-addr">Business address (on invoices)</label><textarea class="input" id="pf-addr" name="business_address" rows="2" style="min-height:64px" ${dis}>${settings.business_address || ''}</textarea></div>
          <div class="field"><label class="label" for="pf-pay">How schools can pay (on invoices)</label><textarea class="input" id="pf-pay" name="pay_instructions" rows="2" style="min-height:64px" ${dis}>${settings.pay_instructions || ''}</textarea><span class="hint">For example who to make checks payable to.</span></div>
        </div>
        <div class="field"><label class="label" for="pf-rv">Parents see test results</label><select class="input" id="pf-rv" name="results_visibility" ${dis}>
          <option value="shared" ${settings.results_visibility !== 'immediate' ? raw('selected') : ''}>After I share a testing day (recommended)</option>
          <option value="immediate" ${settings.results_visibility === 'immediate' ? raw('selected') : ''}>As soon as results are saved</option></select></div>
        <div class="field"><label class="label" for="pf-w">Waiver (have a lawyer write this)</label><textarea class="input" id="pf-w" name="waiver_text" rows="10" style="min-height:220px" ${dis}>${settings.waiver_text || ''}</textarea>
          <span class="hint">Version ${settings.waiver_version || 1}. Changing it asks every family to sign again.</span></div>
        <div class="error" id="pf-err" role="alert"></div>
        <div><button class="btn btn-primary">Save settings</button></div>
      </form>
    </section></div>`);

  const hf = ctx.el.querySelector('#hf');
  const price = hf.querySelector('#hf-price');
  hf.kind.addEventListener('change', () => { price.disabled = hf.kind.value !== 'evaluation'; price.placeholder = price.disabled ? 'Evaluations only' : '75'; });
  hf.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = formData(hf);
    const err = hf.querySelector('#hf-err'); err.textContent = '';
    if (!d.weekdays.length) { err.textContent = 'Pick at least one day.'; return; }
    const cents = d.kind === 'evaluation' && d.price ? toCents(d.price) : 0;
    if (Number.isNaN(cents)) { err.textContent = 'Enter the price as a number, like 75.'; return; }
    try {
      const r = await api.post('/availability', { ...d, price_cents: cents });
      toast(`Hours added on ${plural(r.ids.length, 'day')}. Parents can book them now.`);
      ctx.reload();
    } catch (e) { err.textContent = e.message; }
  });
  ctx.el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const v = hours.find((x) => x.id === +b.dataset.del);
    if (!(await confirmDialog('Remove these hours?', `${v.kind === 'private' ? 'Privates' : 'Evaluations'}: ${hourLabel(v)}. Parents stop seeing these times. Anything already booked stays booked.`, 'Remove hours', 'warn'))) return;
    b.disabled = true;
    try { await api.del(`/availability/${v.id}`); toast('Hours removed. Anything already booked stays booked.'); ctx.reload(); }
    catch (e) { toastError(e); b.disabled = false; }
  }));

  const tf = ctx.el.querySelector('#tf');
  tf.start_date.addEventListener('change', () => { if (!tf.end_date.value || tf.end_date.value < tf.start_date.value) tf.end_date.value = tf.start_date.value; tf.end_date.min = tf.start_date.value; });
  tf.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = tf.querySelector('#tf-err'); err.textContent = '';
    try {
      const r = await api.post('/time-off', formData(tf));
      toast(r.already_booked ? `Time off added. ${plural(r.already_booked, 'private or evaluation is', 'privates or evaluations are')} already booked on those days: move or cancel ${r.already_booked === 1 ? 'it' : 'them'} from the schedule.` : 'Time off added. Parents won\'t see times on those days.', r.already_booked ? 'warn' : 'good');
      ctx.reload();
    } catch (e) { err.textContent = e.message; }
  });
  ctx.el.querySelectorAll('[data-deloff]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api.del(`/time-off/${b.dataset.deloff}`); toast('Time off removed. Those days are bookable again.'); ctx.reload(); }
    catch (e) { toastError(e); b.disabled = false; }
  }));

  const rk = ctx.el.querySelector('#rk-b');
  rk?.addEventListener('click', async () => {
    const on = rk.getAttribute('aria-pressed') !== 'true';
    rk.disabled = true;
    try {
      await api.put('/engage/settings', { rankings_enabled: on });
      rk.setAttribute('aria-pressed', String(on)); rk.textContent = on ? 'On' : 'Off';
      toast(on ? 'Rankings on. Athletes and parents see them in the app.' : 'Rankings off. Athletes and parents no longer see them.');
    } catch (e) { toastError(e); }
    finally { rk.disabled = false; }
  });

  const pf = ctx.el.querySelector('#pf');
  pf.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = pf.querySelector('#pf-err'); err.textContent = '';
    const d = formData(pf);
    try { new Intl.DateTimeFormat('en-US', { timeZone: d.timezone }); }
    catch { err.textContent = 'That time zone isn\'t recognized. Use a name like America/Denver.'; return; }
    const body = owner ? d : { timezone: d.timezone };
    const waiverChanged = owner && d.waiver_text !== (settings.waiver_text || '');
    if (waiverChanged && !(await confirmDialog('Change the waiver?', 'Every family will be asked to sign the new version the next time they sign in.', 'Save and ask families to sign', 'primary'))) return;
    try {
      await api.put('/settings', body);
      toast(waiverChanged ? 'Settings saved. Families will sign the new waiver.' : 'Settings saved.');
      ctx.reload();
    } catch (e) { err.textContent = e.message; }
  });
}

export const routes = [
  { path: '/schedule', nav: 'schedule', title: 'Schedule', render: renderSchedule },
  { path: '/schedule/session/:id', nav: 'schedule', title: 'Session roster', render: renderRoster },
  { path: '/schedule/hours', nav: 'schedule', title: 'Hours & settings', roles: ['owner', 'coach'], render: renderHours },
];
