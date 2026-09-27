// Schedule: the next two weeks, classes and camps, session rosters, and hours & settings.
import { html, raw, mount, api, money, toCents, fmtTime, badge, toast, toastError, modal, confirmDialog, formData, options, debounce, plural, localISO } from '/js/ui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TYPE_BADGE = { class: ['Group', 'good'], camp: ['Camp', 'neutral'], clinic: ['Clinic', 'neutral'], team: ['Team', 'muted'], private: ['Private', 'neutral'], evaluation: ['Evaluation', 'neutral'] };
const typeBadge = (t) => html`<span class="badge badge-${(TYPE_BADGE[t] || [t, 'muted'])[1]}">${(TYPE_BADGE[t] || [t])[0]}</span>`;
const dayLabel = (d, o = { weekday: 'long', month: 'short', day: 'numeric' }) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', o);
const endOf = (e) => new Date(new Date(e.starts_at).getTime() + e.duration_min * 6e4);
const canManage = (me) => me.role === 'owner' || me.role === 'coach';
const ages = (c) => (c?.min_age && c?.max_age ? `ages ${c.min_age}–${c.max_age}` : c?.min_age ? `ages ${c.min_age}+` : c?.max_age ? `up to age ${c.max_age}` : '');
const hhmm = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

const STYLE = html`<style>
  .sc-day{gap:0}
  .sc-day h2{font:600 17px/24px var(--font-sans);padding-bottom:10px}
  .sc-row{display:flex;align-items:center;gap:var(--space-4);padding:12px 0;border-top:1px solid var(--line-subtle);text-decoration:none;color:inherit}
  a.sc-row:hover .sc-name{text-decoration:underline}
  .sc-time{font:600 16px/1.2 var(--font-display);min-width:80px;color:var(--steel)}
  .sc-name{font-weight:600;color:var(--steel)}
  .sc-grow{flex:1;min-width:0}
  .sc-badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .sc-row.cancelled .sc-name{text-decoration:line-through;color:var(--steel-muted)}
  .ro-row{display:flex;align-items:center;gap:var(--space-3);padding:12px 0;border-top:1px solid var(--line-subtle)}
  .ro-row:first-child{border-top:0}
  .ro-check{min-width:112px}
  .ro-check[aria-pressed="true"]{background:var(--green-deep);color:var(--green-soft);border-color:var(--green-mid)}
  .ro-name{font-weight:600;color:var(--steel)}
  .ro-med{color:var(--amber);font-size:13px;line-height:18px}
  .ro-right{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;justify-content:flex-end}
  .ro-results{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-raised)}
  .ro-results button{display:flex;width:100%;justify-content:space-between;gap:12px;padding:10px 12px;min-height:44px;background:transparent;border:0;border-top:1px solid var(--line);color:var(--steel);cursor:pointer;text-align:left}
  .ro-results button:first-child{border-top:0}
  .ro-results button:hover{background:var(--surface)}
  .days-pick{display:flex;flex-wrap:wrap;gap:6px}
  .days-pick label{display:inline-flex}
  .days-pick input{position:absolute;opacity:0;pointer-events:none}
  .days-pick span{min-width:52px;min-height:40px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--control-border);border-radius:var(--radius-sm);cursor:pointer;font-weight:600;font-size:14px;color:var(--steel-muted)}
  .days-pick input:checked+span{background:var(--green);color:var(--on-green);border-color:var(--green-mid)}
  .days-pick input:focus-visible+span{outline:2px solid var(--green-bright);outline-offset:2px}
  .pay-opt{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm);cursor:pointer}
  .pay-opt:has(input:checked){border-color:var(--green-mid);background:var(--green-deep)}
  .pay-opt:has(input:disabled){opacity:.5;cursor:not-allowed}
  .pay-opt input{margin-top:3px;accent-color:var(--green-mid);width:18px;height:18px}
  @media (max-width:640px){
    .sc-row{flex-wrap:wrap;gap:4px 12px}.sc-time{min-width:64px}.sc-badges{width:100%;justify-content:flex-start;padding-left:76px}
    .ro-row{flex-wrap:wrap}.ro-right{width:100%;justify-content:flex-start;padding-left:124px}
  }
  @media (max-width:480px){.ro-right{padding-left:0;flex-wrap:nowrap}}
  .ro-tel{white-space:nowrap}
</style>`;

// ---------------------------------------------------------------- schedule
async function renderSchedule(ctx) {
  const from = localISO();
  const to = localISO(new Date(Date.now() + 13 * 864e5));
  const [events, classes] = await Promise.all([api.get(`/events?from=${from}&to=${to}`), api.get('/classes')]);
  if (!ctx.isCurrent()) return;
  const manage = canManage(ctx.me);
  const byDay = {};
  for (const e of events) (byDay[e.starts_at.slice(0, 10)] ||= []).push(e);

  mount(ctx.el, html`${STYLE}
    <header class="page-header">
      <div><h1 class="page-title">Schedule</h1><p class="page-sub">Classes, camps, clinics, team sessions, privates and evaluations for the next two weeks.</p></div>
      ${manage ? html`<div class="btn-row"><a class="btn" href="/app/schedule/hours">Hours & settings</a><button class="btn btn-primary" id="add-class">Add class or camp</button></div>` : ''}
    </header>
    ${Object.keys(byDay).length ? Object.entries(byDay).map(([d, list]) => html`<section class="panel sc-day">
      <h2>${dayLabel(d)}${d === from ? html` <span class="muted small">· Today</span>` : ''}</h2>
      ${list.map((e) => html`<a class="sc-row ${e.cancelled ? 'cancelled' : ''}" href="/app/schedule/session/${e.id}">
        <div class="sc-time">${fmtTime(e.starts_at)}</div>
        <div class="sc-grow"><div class="sc-name">${e.name}</div>
          <div class="small muted">${e.location || 'No location'} · ${e.type === 'team' ? `${e.team_size} on the team` : `${e.booked}/${e.capacity ?? '∞'} booked`}${e.checked_in ? ` · ${e.checked_in} checked in` : ''}</div></div>
        <div class="sc-badges">${e.cancelled ? badge('cancelled') : html`${e.unpaid ? badge('unpaid', `${e.unpaid} unpaid`) : ''}${e.waitlisted ? badge('waitlist', `${e.waitlisted} waitlist`) : ''}`}${typeBadge(e.type)}</div>
      </a>`)}
    </section>`) : html`<div class="empty">Nothing scheduled in the next two weeks.${manage ? ' Add a class or camp to get started.' : ''}</div>`}

    <section class="panel">
      <h2 class="panel-title">Classes & camps</h2>
      ${classes.length ? html`<div class="list">${classes.map((c) => html`<div class="list-row">
        <div class="grow"><div class="strong">${c.name}</div>
          <div class="small muted">${c.days} ${c.start_time} · ${c.duration_min} min · ${c.location || 'No location'} · ${c.capacity} spots${ages(c) ? ` · ${ages(c)}` : ''}${c.start_date && c.type !== 'class' && c.type !== 'team' ? ` · ${dayLabel(c.start_date, { month: 'short', day: 'numeric' })}–${dayLabel(c.end_date, { month: 'short', day: 'numeric' })}` : ''}${c.price_cents != null && c.price_cents > 0 ? ` · ${money(c.price_cents)} drop-in` : ''}${c.reg_price_cents ? ` · ${money(c.reg_price_cents)} registration` : ''}</div></div>
        ${typeBadge(c.type)}
        ${manage ? html`<button class="btn btn-ghost btn-sm" data-archive="${c.id}">Archive</button>` : ''}
      </div>`)}</div>` : html`<p class="muted" style="margin:0">No weekly classes or camps yet.</p>`}
    </section>`);

  ctx.el.querySelector('#add-class')?.addEventListener('click', () => addClassModal(ctx));
  ctx.el.querySelectorAll('[data-archive]').forEach((b) => b.addEventListener('click', async () => {
    const c = classes.find((x) => x.id === +b.dataset.archive);
    const future = events.filter((e) => e.class_id === c.id && !e.cancelled);
    const ok = await modal({
      title: `Archive ${c.name}`,
      body: html`<p style="margin:0">Every future session of ${c.name} is cancelled. Credits go back, drop-ins are refunded and booked families are emailed.</p>
        <p class="muted small" style="margin:0">${future.length ? `${plural(future.length, 'session')} in the next two weeks, plus any after.` : 'No sessions in the next two weeks.'}</p>
        <div class="field"><label class="label" for="ar-reason">Reason for families (optional)</label><input class="input" id="ar-reason" placeholder="${c.name} is no longer running"></div>`,
      actions: [{ label: 'Keep it', value: null }, { label: 'Archive and cancel sessions', kind: 'warn', onClick: async (body) => {
        const r = await api.post(`/classes/${c.id}/archive`, { reason: body.querySelector('#ar-reason').value });
        return r;
      } }],
    });
    if (ok) { toast(`${c.name} archived. ${plural(ok.cancelled, 'session')} cancelled.`); ctx.reload(); }
  }));
}

async function addClassModal(ctx) {
  const lk = await api.get('/lookups');
  const coachOpts = options(lk.coaches, ctx.me.role === 'frontdesk' ? '' : ctx.me.id, { blank: 'No coach set' });
  const r = await modal({
    title: 'Add class or camp', wide: true,
    body: html`<form id="cf" class="stack" novalidate>
      <div class="form-grid">
        <div class="field span-2"><label class="label" for="cf-name">Name</label><input class="input" id="cf-name" name="name" required placeholder="Youth Speed & Agility"></div>
        <div class="field"><span class="label" id="cf-type-l">Type</span>
          <div class="seg" role="group" aria-labelledby="cf-type-l">${['class', 'camp', 'clinic'].map((t, i) => html`<button type="button" data-type="${t}" aria-pressed="${i === 0}">${t[0].toUpperCase() + t.slice(1)}</button>`)}</div></div>
        <div class="field"><label class="label" for="cf-loc">Where</label><select class="input" id="cf-loc" name="location_id">${options(lk.locations, lk.locations[0]?.id)}</select></div>
        <div class="field span-2"><span class="label" id="cf-days-l">Days</span>
          <div class="days-pick" role="group" aria-labelledby="cf-days-l">${DAYS.map((d, i) => html`<label><input type="checkbox" name="weekdays" data-multi value="${i}"><span>${d}</span></label>`)}</div></div>
        <div class="field"><label class="label" for="cf-time">Start time</label><input class="input" id="cf-time" name="start_time" type="time" value="16:30" required></div>
        <div class="field"><label class="label" for="cf-len">Length (minutes)</label><input class="input" id="cf-len" name="duration_min" type="number" min="15" max="600" step="5" value="60"></div>
        <div class="field"><label class="label" for="cf-cap">Spots</label><input class="input" id="cf-cap" name="capacity" type="number" min="1" max="500" value="12"></div>
        <div class="field"><span class="label">Ages</span><div class="row" style="flex-wrap:nowrap"><input class="input" name="min_age" type="number" min="3" max="99" placeholder="From" aria-label="Youngest age"><span class="muted">to</span><input class="input" name="max_age" type="number" min="3" max="99" placeholder="To" aria-label="Oldest age"></div></div>
        <div class="field"><label class="label" for="cf-price">Drop-in price ($)</label><input class="input" id="cf-price" name="price" inputmode="decimal" placeholder="0"><span class="hint">Members and pack credits cover it.</span></div>
        <div class="field"><label class="label" for="cf-coach">Coach</label><select class="input" id="cf-coach" name="coach_id">${coachOpts}</select></div>
      </div>
      <fieldset id="cf-camp" hidden><legend>Camp or clinic</legend><div class="form-grid">
        <div class="field"><label class="label" for="cf-start">First day</label><input class="input" id="cf-start" name="start_date" type="date"></div>
        <div class="field"><label class="label" for="cf-end">Last day</label><input class="input" id="cf-end" name="end_date" type="date"></div>
        <div class="field"><label class="label" for="cf-reg">Registration price ($)</label><input class="input" id="cf-reg" name="reg_price" inputmode="decimal" placeholder="199"><span class="hint">Charged once for every day.</span></div>
        <div class="field"><label class="label" for="cf-dead">Last day to register</label><input class="input" id="cf-dead" name="reg_deadline" type="date"></div>
      </div></fieldset>
      <p class="hint" style="margin:0">Sessions are created automatically, eight weeks ahead for weekly classes.</p>
      <div class="error" id="cf-err" role="alert"></div>
    </form>`,
    onMount: (body) => {
      body.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => {
        body.querySelectorAll('[data-type]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        body.querySelector('#cf-camp').hidden = b.dataset.type === 'class';
      }));
    },
    actions: [{ label: 'Cancel', value: null }, { label: 'Save class', kind: 'primary', onClick: async (body) => {
      const f = body.querySelector('#cf');
      const d = formData(f);
      const type = body.querySelector('[data-type][aria-pressed="true"]').dataset.type;
      const err = body.querySelector('#cf-err');
      err.textContent = '';
      const payload = { ...d, type, price_cents: d.price ? toCents(d.price) : 0 };
      if (type !== 'class') payload.reg_price_cents = d.reg_price ? toCents(d.reg_price) : null;
      delete payload.price; delete payload.reg_price;
      try { return await api.post('/classes', payload); }
      catch (e) { err.textContent = e.message; return false; }
    } }],
  });
  if (r) { toast(`Saved. ${plural(r.sessions, 'session')} on the schedule.`); ctx.reload(); }
}

// ---------------------------------------------------------------- roster
function medical(a) {
  const bits = [a.allergies && `Allergy: ${a.allergies}`, a.injuries && `Injury: ${a.injuries}`, a.medical_notes && `Medical: ${a.medical_notes}`].filter(Boolean);
  return bits.length ? html`<div class="ro-med">${bits.join(' · ')}</div>` : '';
}
function who(a) {
  const bits = [a.age != null ? `Age ${a.age}` : null, a.family].filter(Boolean).join(' · ');
  const tel = a.parent_phone ? html`${bits ? ' · ' : ''}<a class="muted ro-tel" href="tel:${a.parent_phone.replace(/[^\d+]/g, '')}">${a.parent_phone}</a>` : '';
  return html`<a class="ro-name" href="/app/clients/${a.id}">${a.first_name} ${a.last_name}</a>
    <div class="small muted">${bits}${tel}</div>
    ${medical(a)}`;
}

async function renderRoster(ctx) {
  const d = await api.get(`/events/${ctx.params.id}`);
  if (!ctx.isCurrent()) return;
  const e = d.event, manage = canManage(ctx.me);
  const isTeam = !!d.team;
  const past = endOf(e) < new Date();
  const unpaid = d.booked.filter((b) => b.coverage === 'unpaid').length;
  const checked = d.booked.filter((b) => b.checked_in_at).length;
  const sub = `${dayLabel(e.starts_at.slice(0, 10))} · ${fmtTime(e.starts_at)}–${fmtTime(endOf(e))} · ${e.location || 'No location'}${e.coach ? ` · ${e.coach}` : ''}`;

  const bookingRow = (b) => html`<div class="ro-row">
    <button class="btn btn-sm ro-check" data-check="${b.id}" aria-pressed="${!!b.checked_in_at}" ${e.cancelled ? raw('disabled') : ''}>${b.checked_in_at ? 'Checked in' : 'Check in'}</button>
    <div class="grow" style="flex:1;min-width:0">${who(b.athlete)}</div>
    <div class="ro-right">${badge(b.coverage || 'open')}
      ${b.coverage === 'unpaid' && !e.cancelled ? html`<button class="btn btn-outline btn-sm" data-collect="${b.id}">Collect</button>` : ''}
      ${!e.cancelled ? html`<button class="btn btn-ghost btn-sm" data-remove="${b.id}">Remove</button>` : ''}</div>
  </div>`;
  const teamRow = (r) => html`<div class="ro-row">
    ${r.booking ? html`<button class="btn btn-sm ro-check" data-check="${r.booking.id}" aria-pressed="${!!r.booking.checked_in_at}" ${e.cancelled ? raw('disabled') : ''}>${r.booking.checked_in_at ? 'Checked in' : 'Check in'}</button>`
      : html`<button class="btn btn-sm ro-check" data-teamcheck="${r.athlete.id}" aria-pressed="false" ${e.cancelled ? raw('disabled') : ''}>Check in</button>`}
    <div class="grow" style="flex:1;min-width:0">${who(r.athlete)}</div>
    </div>`;

  const addBox = e.cancelled ? '' : html`<div class="stack-sm" id="add-box">
    <div class="row" style="flex-wrap:nowrap"><label class="sr-only" for="add-q">Add an athlete</label>
      <input class="input" id="add-q" placeholder="Add an athlete: search name, Athlete ID or email" autocomplete="off"></div>
    <div class="ro-results" id="add-results" hidden></div></div>`;

  const teamHere = isTeam ? d.team.roster.filter((r) => r.booking?.checked_in_at).length : 0;
  mount(ctx.el, html`${STYLE}
    <header class="page-header">
      <div><h1 class="page-title">${e.name}</h1><p class="page-sub">${sub}</p></div>
      <a class="btn" href="/app/schedule">Schedule</a>
    </header>
    ${e.cancelled ? html`<div class="banner">This session was cancelled.${e.cancel_reason ? ` Reason: ${e.cancel_reason}.` : ''} Families were emailed and credits went back.</div>` : ''}

    ${isTeam ? html`<section class="panel">
      <div class="panel-head"><div><h2 class="panel-title">${d.team.name || 'Team'} · ${teamHere}/${d.team.roster.length} here</h2>
        <p class="panel-sub">${d.team.school || ''}${d.team.school ? ' · ' : ''}Team sessions use the team roster. <a href="/app/teams/${d.team.id}">Open the team</a>.</p></div>
        ${!e.cancelled && teamHere < d.team.roster.length ? html`<button class="btn btn-primary" id="everyone">Everyone's here</button>` : ''}</div>
      ${d.team.roster.length ? html`<div class="list">${d.team.roster.map(teamRow)}</div>` : html`<p class="muted" style="margin:0">No athletes on this team yet.</p>`}
    </section>
    ${d.guests.length ? html`<section class="panel"><h2 class="panel-title">Guests · ${d.guests.length}</h2><div class="list">${d.guests.map(bookingRow)}</div></section>` : ''}`
    : html`<section class="panel">
      <div><h2 class="panel-title">Roster · ${d.booked.length}/${e.capacity ?? '∞'}</h2>
        <p class="panel-sub">${checked} checked in · ${unpaid} unpaid${ages(d.class) ? ` · ${ages(d.class)}` : ''}${e.price_cents && ctx.me.role !== 'coach' ? ` · ${money(e.price_cents)} drop-in` : ''}</p></div>
      ${d.booked.length ? html`<div class="list">${d.booked.map(bookingRow)}</div>` : html`<p class="muted" style="margin:0">Nobody booked yet.</p>`}
      ${addBox}
    </section>`}

    ${d.waitlist.length ? html`<section class="panel"><div><h2 class="panel-title">Waitlist · ${d.waitlist.length}</h2>
      <p class="panel-sub">They move up in this order when someone cancels, and the family is emailed.</p></div>
      <div class="list">${d.waitlist.map((w, i) => html`<div class="ro-row"><span class="muted" style="min-width:24px">${i + 1}.</span>
        <div style="flex:1;min-width:0">${who(w.athlete)}</div><button class="btn btn-ghost btn-sm" data-remove="${w.id}">Remove</button></div>`)}</div></section>` : ''}

    ${manage && !e.cancelled ? html`<div class="spread" style="justify-content:flex-end"><button class="btn btn-ghost" id="cancel-session">${past ? 'Cancel this session (already happened)' : 'Cancel this session'}</button></div>` : ''}`);

  const act = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (err) { toastError(err); btn.disabled = false; } };

  ctx.el.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    if (on) await api.post(`/bookings/${b.dataset.check}/checkin`); else await api.del(`/bookings/${b.dataset.check}/checkin`);
    ctx.reload();
  })));
  ctx.el.querySelectorAll('[data-teamcheck]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    await api.post(`/events/${e.id}/team-checkin`, { athlete_id: +b.dataset.teamcheck });
    ctx.reload();
  })));
  ctx.el.querySelector('#everyone')?.addEventListener('click', (ev) => act(ev.currentTarget, async () => {
    const r = await api.post(`/events/${e.id}/everyone-here`);
    toast(`${plural(r.checked_in, 'athlete')} checked in.`);
    ctx.reload();
  }));
  ctx.el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    const row = [...d.booked, ...d.waitlist, ...(d.guests || [])].find((x) => x.id === +b.dataset.remove);
    const a = row.athlete;
    const note = row.status === 'waitlist' ? 'They come off the waitlist.' : row.coverage === 'credit' ? 'The session credit goes back to them.' : row.coverage === 'paid' ? 'Their drop-in payment is refunded.' : 'The next person on the waitlist moves up.';
    if (!(await confirmDialog(`Remove ${a.first_name}?`, `${a.first_name} ${a.last_name} comes off ${e.name}. ${note}`, 'Remove', 'warn'))) return;
    try { await api.del(`/bookings/${row.id}`); toast(`${a.first_name} removed.`); ctx.reload(); } catch (err) { toastError(err); }
  }));
  ctx.el.querySelectorAll('[data-collect]').forEach((b) => b.addEventListener('click', () => {
    const row = d.booked.find((x) => x.id === +b.dataset.collect);
    collectModal(ctx, e, row, d.payments_mode);
  }));
  ctx.el.querySelector('#cancel-session')?.addEventListener('click', async () => {
    const booked = d.booked.length + (d.guests?.length || 0);
    const r = await modal({
      title: 'Cancel this session',
      body: html`<p style="margin:0">${e.name}, ${sub}. ${booked ? `${plural(booked, 'booked family', 'booked families')} get an email with your reason. Credits go back and drop-ins are refunded.` : 'Nobody is booked.'}</p>
        <div class="field"><label class="label" for="cx-reason">Reason</label><input class="input" id="cx-reason" placeholder="Lightning in the area" maxlength="300" required></div>
        <div class="error" id="cx-err" role="alert"></div>`,
      actions: [{ label: 'Keep the session', value: null }, { label: 'Cancel session and email families', kind: 'warn', onClick: async (body) => {
        const reason = body.querySelector('#cx-reason').value.trim();
        if (!reason) { body.querySelector('#cx-err').textContent = 'Give a reason. Families see it in the email.'; return false; }
        return api.post(`/events/${e.id}/cancel`, { reason });
      } }],
    });
    if (r) { toast(`Session cancelled. ${plural(r.notified, 'booking')} notified.`); ctx.reload(); }
  });

  // Add an athlete: search, then tap a result.
  const q = ctx.el.querySelector('#add-q'), results = ctx.el.querySelector('#add-results');
  if (q) {
    const search = debounce(async () => {
      const term = q.value.trim();
      if (term.length < 2) { results.hidden = true; return; }
      const list = await api.get(`/athletes/search?q=${encodeURIComponent(term)}`).catch(() => []);
      const inIt = new Set([...d.booked, ...d.waitlist].map((x) => x.athlete.id));
      const full = e.capacity && d.booked.length >= e.capacity;
      mount(results, list.length ? list.map((a) => html`<button type="button" data-add="${a.id}" ${inIt.has(a.id) ? raw('disabled') : ''}>
        <span><span class="strong">${a.first_name} ${a.last_name}</span> <span class="small muted">${a.code}${a.family ? ` · ${a.family}` : ''}</span></span>
        <span class="small ${inIt.has(a.id) ? 'muted' : 'good-text'}">${inIt.has(a.id) ? 'Already here' : full ? 'Add to waitlist' : 'Add'}</span></button>`)
        : html`<div class="small muted" style="padding:10px 12px">No athletes match. <a href="/app/clients/new">Add a new client</a>.</div>`);
      results.hidden = false;
    }, 200);
    q.addEventListener('input', search);
    results.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-add]');
      if (!b || b.disabled) return;
      b.disabled = true;
      try { const r = await api.post(`/events/${e.id}/bookings`, { athlete_id: +b.dataset.add }); toast(r.message); ctx.reload(); }
      catch (err) { toastError(err); b.disabled = false; }
    });
  }
}

async function collectModal(ctx, e, row, mode) {
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
  if (r) { toast(r.message); ctx.reload(); }
}

// ---------------------------------------------------------------- hours & settings
async function renderHours(ctx) {
  const owner = ctx.me.role === 'owner';
  const [hours, settings, lk, eng] = await Promise.all([api.get('/availability'), api.get('/settings'), api.get('/lookups'), api.get('/engage/settings').catch(() => null)]);
  if (!ctx.isCurrent()) return;
  const dis = owner ? '' : raw('disabled');
  const hourLabel = (v) => `${DAYS[v.weekday]} ${v.start_time}–${v.end_time} · ${v.kind === 'private' ? 'Privates' : 'Evaluations'} · ${v.slot_min} min · ${v.location || 'No location'}${v.kind === 'evaluation' && v.price_cents ? ` · ${money(v.price_cents)}` : ''}${v.coach ? ` · ${v.coach}` : ''}`;

  mount(ctx.el, html`${STYLE}
    <header class="page-header">
      <div><h1 class="page-title">Hours & settings</h1><p class="page-sub">Private and evaluation hours, cancellation policy and your waiver.</p></div>
      <a class="btn" href="/app/schedule">Schedule</a>
    </header>

    <section class="panel">
      <div><h2 class="panel-title">Your hours for privates and evaluations</h2>
        <p class="panel-sub">Parents book open times in the portal. Anything else on your schedule blocks the time.</p></div>
      ${hours.length ? html`<div class="list">${hours.map((v) => html`<div class="list-row"><div class="grow">${hourLabel(v)}</div>
        <button class="btn btn-ghost btn-sm" data-del="${v.id}" aria-label="Remove ${hourLabel(v)}">Remove</button></div>`)}</div>`
        : html`<p class="muted" style="margin:0">No hours yet. Parents can't book privates or evaluations until you add some.</p>`}
      <form id="hf" class="stack" novalidate style="border-top:1px solid var(--line-subtle);padding-top:var(--space-4)">
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
          <div class="field"><label class="label" for="hf-kind">For</label><select class="input" id="hf-kind" name="kind"><option value="private">Private training</option><option value="evaluation">Evaluations</option></select></div>
          <div class="field"><label class="label" for="hf-loc">Where</label><select class="input" id="hf-loc" name="location_id">${options(lk.locations, lk.locations[0]?.id)}</select></div>
          <div class="field"><label class="label" for="hf-day">Day</label><select class="input" id="hf-day" name="weekday">${DAYS.map((d, i) => html`<option value="${i}" ${i === 1 ? raw('selected') : ''}>${d}</option>`)}</select></div>
          <div class="field"><label class="label" for="hf-coach">Coach</label><select class="input" id="hf-coach" name="coach_id">${options(lk.coaches, ctx.me.id)}</select></div>
        </div>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
          <div class="field"><label class="label" for="hf-from">From</label><input class="input" id="hf-from" name="start_time" type="time" value="15:00"></div>
          <div class="field"><label class="label" for="hf-to">To</label><input class="input" id="hf-to" name="end_time" type="time" value="19:00"></div>
          <div class="field"><label class="label" for="hf-slot">Minutes each</label><input class="input" id="hf-slot" name="slot_min" type="number" min="15" max="240" step="5" value="60"></div>
          <div class="field"><label class="label" for="hf-price">Price ($)</label><input class="input" id="hf-price" name="price" inputmode="decimal" placeholder="Evaluations" disabled></div>
        </div>
        <div class="error" id="hf-err" role="alert"></div>
        <div><button class="btn btn-primary">Add hours</button></div>
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
    </section>`);

  const hf = ctx.el.querySelector('#hf');
  const price = hf.querySelector('#hf-price');
  hf.kind.addEventListener('change', () => { price.disabled = hf.kind.value !== 'evaluation'; price.placeholder = price.disabled ? 'Evaluations' : '75'; });
  hf.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = formData(hf);
    const err = hf.querySelector('#hf-err'); err.textContent = '';
    try {
      await api.post('/availability', { ...d, price_cents: d.kind === 'evaluation' && d.price ? toCents(d.price) : 0 });
      toast('Hours added. Parents can book them now.');
      ctx.reload();
    } catch (e) { err.textContent = e.message; }
  });
  ctx.el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api.del(`/availability/${b.dataset.del}`); toast('Hours removed. Anything already booked stays booked.'); ctx.reload(); }
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
