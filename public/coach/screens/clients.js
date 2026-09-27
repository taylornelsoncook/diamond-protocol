// Clients: the list, New client, and the client profile.
import { html, raw, mount, api, money, fmtDate, fmtTime, fmtDateTime, relTime, badge, toast, toastError, modal, confirmDialog, formData, debounce, options, age, fullName, icon, sparkline, plural, localISO } from '/js/ui.js';
import { parseEntry, fmtValue } from '/js/testing-format.js';
import { assignDialog } from './education.js';

const STYLE = html`<style>
.cl-list .cl-tools{display:flex;gap:var(--space-3);flex-wrap:wrap}
.cl-list .cl-tools .input{flex:1 1 260px}
.cl-list .cl-tools select.input{flex:0 0 190px}
.cl-list .table td{padding:12px 20px}.cl-list .table th{padding:10px 20px}
.cl-list .cl-name{font-weight:600;color:var(--steel);text-decoration:none}
.cl-list .cl-sub{font-size:13px;color:var(--steel-muted)}
.cl-list .cl-sub .mono{font-size:12px}
.cl-list .table-wrap{border:0;border-top:1px solid var(--line);border-radius:0;margin:0 calc(-1 * var(--space-6)) calc(-1 * var(--space-6))}
.cl-list .cl-planline{display:none}
@media (max-width:700px){.cl-list .col-prog,.cl-list .col-last,.cl-list .col-plan{display:none}.cl-list .cl-planline{display:block}.cl-list .table td,.cl-list .table th{padding:10px 12px}.cl-list .cl-tools select.input{flex:1 1 100%}}
.cl-new{max-width:640px}
.cl-new .cl-section{font:500 14px/20px var(--font-sans);color:var(--steel-muted);margin:4px 0 -4px}
.cl-pro .cl-code{font:600 12px/1 var(--font-mono);padding:6px 10px;border-radius:var(--radius-pill);background:var(--surface-raised);color:var(--steel);vertical-align:middle;letter-spacing:.02em}
.cl-pro .cl-title{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.cl-pro .cl-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);align-items:start}
@media (max-width:1000px){.cl-pro .cl-cols{grid-template-columns:1fr}}
.cl-pro .cl-col{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}
.cl-pro .kv4{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
.cl-pro .kv4 .k{font-size:13px;color:var(--steel-muted);margin-bottom:2px}
.cl-pro .list-row{padding:10px 0}
.cl-pro details summary{cursor:pointer;font-size:14px;color:var(--steel);min-height:32px;display:flex;align-items:center;gap:8px;list-style:none}.cl-pro details summary::-webkit-details-marker{display:none}.cl-pro details summary::before{content:'';width:0;height:0;border:5px solid transparent;border-left:7px solid currentColor;border-right:0;transition:transform .15s}.cl-pro details[open] summary::before{transform:rotate(90deg)}
.cl-pro .test-row .val{font:600 14px/1 var(--font-sans);text-align:right;white-space:nowrap}
.cl-pro .test-row .chg{font-size:13px;width:72px;text-align:right;white-space:nowrap}
.cl-pro .inline{display:flex;gap:var(--space-2);flex-wrap:wrap}.cl-pro .inline>select,.cl-pro .inline>.input{flex:1 1 200px;width:auto;min-width:0}
.cl-pro .banner.medical{justify-content:flex-start;gap:6px 20px}
.cl-pro .banner.medical b{font-weight:600}
.cl-eng .cl-eng-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden}
.cl-eng .cl-eng-stats>div{padding:10px 12px;display:flex;flex-direction:column;gap:2px;min-width:0;background:var(--surface)}
.cl-eng .cl-eng-k{font-size:12px;line-height:16px;color:var(--steel-muted)}
.cl-eng .cl-eng-v{font:600 24px/1.1 var(--font-display);color:var(--steel)}
.cl-eng .cl-eng-v small{font:400 12px/1 var(--font-sans);color:var(--steel-muted);margin-left:4px}
@media (max-width:1300px) and (min-width:1001px),(max-width:560px){.cl-eng .cl-eng-stats{grid-template-columns:repeat(6,minmax(0,1fr))}.cl-eng .cl-eng-stats>div{grid-column:span 2}.cl-eng .cl-eng-stats>div:nth-child(-n+2){grid-column:span 3}}
.cl-eng .cl-eng-h{font:500 14px/20px var(--font-sans);color:var(--steel-muted);margin:4px 0 -4px}
.cl-eng .cl-avg{display:grid;grid-template-columns:minmax(0,1fr) auto 96px;align-items:center;gap:4px 12px;padding:6px 0;border-top:1px solid var(--line-subtle)}
.cl-eng .cl-avg:first-of-type{border-top:0}
.cl-eng .cl-avg .val{font-weight:600;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.cl-eng .cl-flag{border-left:2px solid var(--amber);padding:4px 0 4px 10px}
.cl-eng .cl-bar{width:100%;max-width:220px;margin-top:6px}
.cl-eng .cl-msg{white-space:pre-line;overflow-wrap:anywhere}
.cl-eng .cl-add{border-top:1px solid var(--line-subtle);padding-top:var(--space-3);display:flex;flex-direction:column;gap:var(--space-2)}
.cl-eng .cl-add-row{display:grid;grid-template-columns:minmax(0,1.4fr) 88px;gap:var(--space-2)}
.cl-eng .cl-rank{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
</style>`;

const statusBadge = (s) => (s === 'none' ? badge('draft', 'No plan') : s === 'team' ? badge('team') : badge(s));
const isOwner = (ctx) => ctx.me.role === 'owner';

async function copy(text, what = 'Link') {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); }
  catch { modal({ title: 'Copy link', body: html`<input class="input mono" value="${text}" readonly onfocus="this.select()">` }); }
}
function planLabel(ctx, p) {
  const bits = [p.name];
  if (isOwner(ctx) && p.price_cents != null) bits.push(`${money(p.price_cents)}/mo`);
  if (p.trial_days) bits.push(`${p.trial_days}-day free trial`);
  return bits.join(' · ');
}

// ---------------------------------------------------------------- list
async function renderList(ctx) {
  const q = ctx.query.q || '', status = ctx.query.status || '';
  mount(ctx.el, html`${STYLE}<div class="stack cl-list">
    <div class="page-header"><div><h1 class="page-title">Clients</h1><p class="page-sub" id="cl-count">Everyone you train.</p></div>
      <a class="btn btn-primary" href="/app/clients/new">Add client</a></div>
    <div class="panel">
      <div class="cl-tools">
        <label class="sr-only" for="cl-q">Search clients</label>
        <input class="input" id="cl-q" type="search" placeholder="Name, athlete ID, email or family" value="${q}" autocomplete="off">
        <label class="sr-only" for="cl-status">Status</label>
        <select class="input" id="cl-status">${options([
          { id: '', name: 'All statuses' }, { id: 'active', name: 'Active' }, { id: 'trial', name: 'Trial' }, { id: 'past_due', name: 'Past due' },
          { id: 'paused', name: 'Paused' }, { id: 'none', name: 'No plan' }, { id: 'team', name: 'Team only' }], status)}</select>
      </div>
      <div id="cl-table"><div class="muted">Loading…</div></div>
    </div></div>`);
  const qEl = ctx.el.querySelector('#cl-q'), sEl = ctx.el.querySelector('#cl-status');
  let seq = 0;
  async function load() {
    const my = ++seq;
    const params = new URLSearchParams();
    if (qEl.value.trim()) params.set('q', qEl.value.trim());
    if (sEl.value) params.set('status', sEl.value);
    history.replaceState({}, '', '/app/clients' + (params.toString() ? '?' + params : ''));
    const data = await api.get('/clients?' + params);
    if (my !== seq || !ctx.isCurrent()) return;
    const box = ctx.el.querySelector('#cl-table');
    const n = data.total;
    ctx.el.querySelector('#cl-count').textContent = `${n} ${n === 1 ? 'account' : 'accounts'}, their plans and programs.`;
    if (!data.clients.length) {
      mount(box, html`<div class="empty">${qEl.value || sEl.value ? 'No clients match. Try a different name, Athlete ID or status.' : html`No clients yet. <a href="/app/clients/new">Add your first client</a>.`}</div>`);
      return;
    }
    mount(box, html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Client</th><th class="col-plan">Plan</th><th>Status</th><th class="col-prog">Program</th><th class="col-last">Last workout</th></tr></thead>
      <tbody>${data.clients.map((c) => html`<tr class="clickable" data-id="${c.id}">
        <td><a class="cl-name" href="/app/clients/${c.id}">${c.first_name} ${c.last_name}</a>
          <div class="cl-sub"><span class="mono">${c.code}</span> · ${c.email || c.family || (c.team_name ? c.team_name : '') || c.parent_email || ''}</div>
          ${c.plan_name ? html`<div class="cl-sub cl-planline">${c.plan_name}</div>` : ''}</td>
        <td class="col-plan">${c.plan_name || (c.team_name && c.status === 'team' ? c.team_name : '—')}</td>
        <td>${statusBadge(c.status)}</td>
        <td class="col-prog ${c.program_name ? '' : 'muted'}">${c.program_name || 'None'}</td>
        <td class="col-last ${c.last_workout ? '' : 'muted'}">${c.last_workout ? relTime(c.last_workout) : 'Never'}</td></tr>`)}</tbody></table></div>`);
  }
  qEl.addEventListener('input', debounce(() => load().catch(toastError), 200));
  sEl.addEventListener('change', () => load().catch(toastError));
  ctx.el.querySelector('#cl-table').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) ctx.go(`/app/clients/${tr.dataset.id}`);
  });
  await load();
  if (!q) qEl.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- new client
async function renderNew(ctx) {
  const [plans, lookups] = await Promise.all([api.get('/plans'), api.get('/lookups')]);
  if (!ctx.isCurrent()) return;
  mount(ctx.el, html`${STYLE}<div class="stack">
    <div class="page-header"><div><h1 class="page-title">New client</h1><p class="page-sub">Creates the account, the parent login, the plan and the program in one step.</p></div>
      <a class="btn" href="/app/clients">Cancel</a></div>
    <form class="panel cl-new stack" id="nc" novalidate>
      <label class="check"><input type="checkbox" name="with_parent" id="nc-wp" checked> <span>Athlete with a parent who pays</span></label>
      <div class="field"><label class="label" for="nc-name">Full name</label><input class="input" id="nc-name" name="name" autocomplete="off" required style="max-width:300px"></div>
      <div class="form-grid">
        <div class="field"><label class="label" for="nc-bd">Birthday</label><input class="input" id="nc-bd" name="birthday" type="date"></div>
        <div class="field"><label class="label" for="nc-sport">Sport</label><input class="input" id="nc-sport" name="sport"></div>
        <div class="field"><label class="label" for="nc-school">School</label><input class="input" id="nc-school" name="school"></div>
      </div>
      <div id="nc-parent" class="stack">
        <div class="cl-section">Parent or guardian (pays and signs in to the parent portal)</div>
        <div class="form-grid">
          <div class="field"><label class="label" for="nc-pn">Parent name</label><input class="input" id="nc-pn" name="parent_name" autocomplete="off"></div>
          <div class="field"><label class="label" for="nc-pe">Parent email</label><input class="input" id="nc-pe" name="parent_email" type="email" autocomplete="off"></div>
          <div class="field"><label class="label" for="nc-pp">Parent phone</label><input class="input" id="nc-pp" name="parent_phone" type="tel" autocomplete="off"></div>
        </div>
      </div>
      <div id="nc-self" class="stack" hidden>
        <div class="cl-section">They pay for themselves and sign in to the portal with this email.</div>
        <div class="form-grid">
          <div class="field"><label class="label" for="nc-e">Email</label><input class="input" id="nc-e" name="email" type="email" autocomplete="off"></div>
          <div class="field"><label class="label" for="nc-ph">Phone</label><input class="input" id="nc-ph" name="phone" type="tel" autocomplete="off"></div>
        </div>
      </div>
      <div class="form-grid">
        <div class="field"><label class="label" for="nc-plan">Subscription plan</label>
          <select class="input" id="nc-plan" name="plan_id">${options(plans.filter((p) => p.active), '', { blank: 'No subscription yet', label: (p) => planLabel(ctx, p) })}</select></div>
        <div class="field"><label class="label" for="nc-prog">Starting program</label>
          <select class="input" id="nc-prog" name="program_id">${options(lookups.programs, '', { blank: 'Assign later' })}</select></div>
      </div>
      <p class="hint" style="margin:-8px 0 0">With a trial, the first charge happens when it ends. Without one, the card on file is charged today; until the parent adds a card, the membership shows as past due.</p>
      <p class="hint" style="margin:0">Adding a sibling? Open the brother or sister and use "Add sibling" instead, so the family shares one login and card.</p>
      <div class="error" id="nc-err" role="alert"></div>
      <div><button class="btn btn-primary" type="submit">Create account</button></div>
    </form></div>`);
  const f = ctx.el.querySelector('#nc');
  const wp = f.querySelector('#nc-wp');
  const sync = () => { f.querySelector('#nc-parent').hidden = !wp.checked; f.querySelector('#nc-self').hidden = wp.checked; };
  wp.addEventListener('change', sync);
  f.querySelector('#nc-name').focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f);
    const err = f.querySelector('#nc-err'); err.textContent = '';
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const r = await api.post('/clients', { ...d, with_parent: !!d.with_parent });
      if (r.membership && !r.membership.ok) toast(`Account created as ${r.code}. The first charge didn't go through (${r.membership.error || 'declined'}); the membership is past due until a card is added.`, 'warn');
      else toast(`Account created. Athlete ID ${r.code}. The welcome email is on its way.`);
      ctx.go(`/app/clients/${r.id}`);
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  });
}

// ---------------------------------------------------------------- profile
function fmtVal(v, unit) {
  if (v == null) return '—';
  const n = Number(v);
  const s = Math.abs(n) >= 100 ? n.toFixed(0) : Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '');
  return `${s} ${unit || ''}`.trim();
}
function changeText(t) {
  if (t.change == null || t.change === 0) return html`<span class="muted">—</span>`;
  const better = t.lower_better ? t.change < 0 : t.change > 0;
  const n = Number(t.change);
  return html`<span class="${better ? 'good-text' : 'warn-text'}">${n > 0 ? '+' : ''}${fmtVal(Math.round(n * 100) / 100, t.unit)}</span>`;
}

// ---------------------------------------------------------------- accountability, targets, education
const GOAL_KINDS = [{ id: 'workouts', name: 'Workouts' }, { id: 'sessions', name: 'Sessions attended' }, { id: 'checkins', name: 'Daily check-ins' }, { id: 'custom', name: 'Custom' }];
const MEASURES = [['sleep_hours', 'Sleep', (v) => `${v} h`], ['hydration', 'Hydration', (v) => `${v} of 5`], ['soreness', 'Soreness', (v) => `${v} of 5`], ['energy', 'Energy', (v) => `${v} of 5`], ['mood', 'Mood', (v) => `${v} of 5`]];
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const valueHint = (unit) => (unit === 'in' ? 'Inches, or feet and inches like 6\'8"' : unit === 's' ? 'Seconds, like 3.35' : unit ? `In ${unit}` : 'Choose a test first');

function engagePanels(ctx, a, en, library) {
  const manage = ctx.me.role === 'owner' || ctx.me.role === 'coach';
  const today = localISO();
  if (!en) return { accountability: '', goals: '', messages: '', targets: '', education: '' };
  const w = en.this_week, st = en.streaks;
  const stat = (k, v, unit) => html`<div><span class="cl-eng-k">${k}</span><span class="cl-eng-v">${v}<small>${unit}</small></span></div>`;
  const accountability = html`<section class="panel cl-eng" id="cl-acc">
    <div><h2 class="panel-title">Accountability</h2><p class="panel-sub">Streaks, this week so far, and daily check-ins over the last 30 days.</p></div>
    <div class="cl-eng-stats">
      ${stat('Check-in streak', st.checkin_days, st.checkin_days === 1 ? 'day' : 'days')}
      ${stat('Training streak', st.active_weeks, st.active_weeks === 1 ? 'week' : 'weeks')}
      ${stat('Workouts', w.workouts, 'this wk')}${stat('Sessions', w.sessions, 'this wk')}${stat('Check-ins', w.checkins, 'this wk')}
    </div>
    ${en.checkins.length ? html`<div class="cl-eng-h">30-day averages from ${plural(en.checkins.length, 'check-in')}</div>
      <div>${MEASURES.map(([k, label, fmt]) => {
        const vals = en.checkins.map((c) => c[k]).filter((v) => v != null);
        return html`<div class="cl-avg"><span>${label}${k === 'soreness' ? html` <span class="muted small">lower is better</span>` : ''}</span>
          <span class="val">${en.averages[k] == null ? '—' : fmt(en.averages[k])}</span>${vals.length > 1 ? sparkline(vals, { w: 96, h: 24 }) : html`<span></span>`}</div>`;
      })}</div>`
      : html`<p class="panel-sub">No check-ins in the last 30 days. ${a.first_name} checks in from the athlete app.</p>`}
    ${en.flagged.length ? html`<div class="cl-eng-h">Check-ins that need a look</div>
      <div class="stack-sm">${en.flagged.map((c) => html`<div class="cl-flag small"><span class="strong">${c.date === today ? 'Today' : fmtDate(c.date, { year: false, weekday: true })}</span>
        <span class="warn-text"> · ${c.flags.join(' · ')}</span>${c.note ? html`<div class="muted">"${c.note}"</div>` : ''}</div>`)}</div>` : ''}
  </section>`;

  const goals = html`<section class="panel cl-eng">
    <div><h2 class="panel-title">Weekly goals</h2><p class="panel-sub">Progress this week, Monday to Sunday. Workouts, sessions and check-ins count themselves; ${a.first_name} ticks off custom goals.</p></div>
    ${en.goals.length ? html`<div class="list">${en.goals.map((g) => html`<div class="list-row">
      <div class="grow"><div class="strong">${g.title} ${g.team ? badge('team', 'Team goal') : ''}</div>
        <div class="muted small">${g.kind_label} · ${g.progress} of ${g.target} this week</div>
        <div class="bar cl-bar"><span style="width:${Math.min(100, Math.round((g.progress / g.target) * 100))}%"></span></div></div>
      ${g.done ? badge('complete', 'Done') : ''}
      ${manage && !g.team ? html`<button class="btn btn-ghost btn-sm" data-act="goal-end" data-id="${g.id}" data-title="${g.title}">End</button>` : ''}</div>`)}</div>`
      : html`<p class="panel-sub">No goals yet.</p>`}
    ${manage ? html`<form class="cl-add" data-form="goal" novalidate>
      <div class="cl-add-row"><div class="field"><label class="label small" for="gl-k">What it counts</label><select class="input" id="gl-k" name="kind">${options(GOAL_KINDS, 'workouts')}</select></div>
        <div class="field"><label class="label small" for="gl-t">Per week</label><input class="input" id="gl-t" name="target" type="number" min="1" max="14" value="3" inputmode="numeric"></div></div>
      <div class="field"><label class="label small" for="gl-n">Goal</label><input class="input" id="gl-n" name="title" maxlength="120" placeholder="Like 3 workouts this week"><span class="hint">Leave blank to name it from what it counts.</span></div>
      <div><button class="btn">Add goal</button></div></form>` : ''}
  </section>`;

  const messages = html`<section class="panel cl-eng">
    <div><h2 class="panel-title">Messages</h2><p class="panel-sub">Notes from coaches. ${a.first_name} reads them in the app${en.unread ? html`; <span class="warn-text">${en.unread} unread</span>` : ''}.</p></div>
    ${manage ? html`<form class="stack-sm" data-form="message" novalidate>
      <label class="sr-only" for="msg-b">Message to ${a.first_name}</label>
      <textarea class="input" id="msg-b" name="body" rows="3" maxlength="2000" style="min-height:80px" placeholder="Write to ${a.first_name}"></textarea>
      <div class="spread"><span class="hint">${a.first_name} and their parents are emailed a copy.</span><button class="btn">Send message</button></div></form>` : ''}
    ${en.messages.length ? html`<div class="list">${en.messages.map((m) => html`<div class="list-row" style="align-items:flex-start">
      <div class="grow"><div class="cl-msg">${m.body}</div>
        <div class="muted small">${m.coach || 'Coach'} · ${relTime(m.created_at)}${m.team ? ' · to the team' : ''}</div></div>
      ${m.read ? html`<span class="muted small">Read</span>` : badge('open', 'Unread')}</div>`)}</div>`
      : html`<p class="panel-sub">No messages yet.</p>`}
  </section>`;

  const tested = en.tests || [];
  const testedIds = new Set(tested.map((t) => t.test_id));
  const rest = (library || []).filter((t) => !testedIds.has(t.id));
  const targets = html`<section class="panel cl-eng">
    <div><h2 class="panel-title">Test targets</h2><p class="panel-sub">Best result so far against the target. Progress counts from the first test.</p></div>
    ${en.targets.length ? html`<div class="list">${en.targets.map((t) => html`<div class="list-row">
      <div class="grow"><div class="strong">${t.test}</div>
        <div class="muted small">${t.best_text ? `Best ${t.best_text}` : 'Not tested yet'} → target ${t.target_text}${t.due_date ? html` · <span class="${!t.reached && t.due_date < today ? 'warn-text' : ''}">by ${fmtDate(t.due_date, { year: false })}</span>` : ''}</div>
        <div class="bar cl-bar"><span style="width:${t.pct}%"></span></div></div>
      ${t.reached ? badge('complete', 'Reached') : html`<span class="small muted">${t.pct}%</span>`}
      ${manage ? html`<button class="btn btn-ghost btn-sm" data-act="target-rm" data-id="${t.id}" data-title="${t.test}">Remove</button>` : ''}</div>`)}</div>`
      : html`<p class="panel-sub">No targets yet.</p>`}
    ${manage ? html`<form class="cl-add" data-form="target" novalidate>
      <div class="field"><label class="label small" for="tg-t">Test</label><select class="input" id="tg-t" name="test_id"><option value="">Choose a test</option>
        ${tested.length ? html`<optgroup label="${a.first_name} has done">${tested.map((t) => html`<option value="${t.test_id}" data-unit="${t.unit}">${t.name}${t.best != null ? ` (best ${fmtValue(t.best, t.unit)})` : ''}</option>`)}</optgroup>` : ''}
        <optgroup label="All tests">${rest.map((t) => html`<option value="${t.id}" data-unit="${t.unit}">${t.name}</option>`)}</optgroup></select></div>
      <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-2)">
        <div class="field"><label class="label small" for="tg-v">Target</label><input class="input" id="tg-v" name="target" autocomplete="off"><span class="hint" id="tg-h">${valueHint(null)}</span></div>
        <div class="field"><label class="label small" for="tg-d">By (optional)</label><input class="input" id="tg-d" name="due_date" type="date" min="${today}"></div></div>
      <div><button class="btn">Set target</button></div></form>` : ''}
    ${en.rankings ? html`<div class="cl-eng-h">Where ${a.first_name} ranks (best result; athletes and parents see this without names)</div>
      ${en.rankings.length ? html`<div class="list">${en.rankings.map((r) => html`<div class="list-row small" style="align-items:flex-start">
        <div class="grow"><span class="strong">${r.test}</span> <span class="muted">· best ${fmtValue(r.best, r.unit)}</span>
          <div class="cl-rank">${r.ranks.map((k) => html`<span class="chip">${ordinal(k.rank)} of ${k.of} · ${k.group}</span>`)}</div></div></div>`)}</div>`
        : html`<p class="panel-sub">Not enough athletes have done the same tests to rank yet.</p>`}`
      : html`<p class="hint" style="margin:0">Rankings are off. ${manage ? html`Turn them on in <a href="/app/schedule/hours">Hours & settings</a>.` : ''}</p>`}
  </section>`;

  const as = en.education.assigned;
  const education = html`<section class="panel cl-eng">
    <div class="panel-head"><div><h2 class="panel-title">Education</h2><p class="panel-sub">${plural(en.education.completed, 'lesson')} finished. Assigned reading shows first in ${a.first_name}'s app.</p></div>
      ${manage ? html`<button class="btn btn-sm" data-act="assign-lesson">Assign lesson</button>` : ''}</div>
    ${as.length ? html`<div class="list">${as.map((x) => html`<div class="list-row">
      <div class="grow"><div>${x.title} <span class="muted small">${x.type === 'course' ? `Course · ${x.progress}` : 'Lesson'}</span></div>
        <div class="muted small">${x.due_date ? html`<span class="${x.overdue ? 'warn-text' : ''}">${x.overdue ? 'Overdue, was due' : 'Due'} ${fmtDate(x.due_date, { year: false })}</span>` : 'No due date'}${x.note ? ` · ${x.note}` : ''}</div></div>
      ${x.done ? badge('complete', 'Done') : x.overdue ? badge('overdue') : badge('open', 'Not done')}</div>`)}</div>`
      : html`<p class="panel-sub">Nothing assigned.</p>`}
  </section>`;
  return { accountability, goals, messages, targets, education };
}

async function renderProfile(ctx) {
  const id = ctx.params.id;
  let progress = null; // loaded once; testing API may not exist yet
  let progressErr = false;
  const progressP = api.get(`/athletes/${id}/progress`, { noRedirect: true }).then((p) => { progress = p; }).catch(() => { progressErr = true; });
  const lookupsP = api.get('/lookups');
  const plansP = api.get('/plans');
  const libraryP = api.get('/tests').catch(() => []);

  async function draw() {
    const [d, lookups, plans, , en, library] = await Promise.all([api.get(`/athletes/${id}`), lookupsP, plansP, progressP, api.get(`/athletes/${id}/engage`, { noRedirect: true }).catch(() => null), libraryP]);
    if (!ctx.isCurrent()) return;
    const a = d.athlete, fam = d.family, m = d.membership, owner = isOwner(ctx), role = ctx.me.role;
    document.title = `${fullName(a)} · Diamond Protocol`;
    const yrs = age(a.birthday);
    const subBits = [yrs != null ? `Age ${yrs}` : null, a.sport, a.position, d.team ? d.team.team_name : null, `client since ${fmtDate(a.created_at)}`].filter(Boolean);
    const medical = [a.allergies && ['Allergies', a.allergies], a.injuries && ['Injuries', a.injuries], a.medical_notes && ['Medical', a.medical_notes]].filter(Boolean);
    const sl = d.sessions_left;
    const activePlans = plans.filter((p) => p.active);

    const familyPanel = fam ? html`<section class="panel">
      <div><h2 class="panel-title">${fam.name}</h2>
        <p class="panel-sub">${fam.waiver.signed ? `Waiver signed ${fmtDate(fam.waiver.signed_at)} by ${fam.waiver.signed_by || 'the parent'}`
          : raw(`<span class="warn-text">${fam.waiver.signed_version ? 'The waiver changed. They need to sign it again in the portal.' : 'Waiver not signed yet. They sign it in the parent portal.'}</span>`)}</p></div>
      <div class="list">${fam.parents.map((p, i) => html`<div class="list-row">
        <div class="grow"><div><span class="strong">${p.name}</span> <span class="muted small">${p.is_self ? '(self)' : i === 0 ? '(primary)' : ''}</span></div>
        <div class="muted small">${p.email}${p.phone ? ` · ${p.phone}` : ''}</div></div>
        ${i === 0 ? html`<button class="btn btn-ghost btn-sm" data-act="copy-portal">Copy portal link</button>` : ''}</div>`)}</div>
      ${fam.siblings.length ? html`<div class="small">Siblings: ${fam.siblings.map((s, i) => html`${i ? ', ' : ''}<a href="/app/clients/${s.id}">${s.first_name} ${s.last_name}</a>`)}</div>` : ''}
      <details id="cl-add"><summary>Add sibling or parent</summary>
        <div class="stack" style="margin-top:12px">
          <form class="stack-sm" data-form="sibling"><div class="label">New sibling (shares this login and card)</div>
            <div class="form-grid"><div class="field"><label class="label small" for="sb-n">Full name</label><input class="input" id="sb-n" name="name" required></div>
            <div class="field"><label class="label small" for="sb-b">Birthday</label><input class="input" id="sb-b" name="birthday" type="date"></div>
            <div class="field"><label class="label small" for="sb-s">Sport</label><input class="input" id="sb-s" name="sport"></div></div>
            <div><button class="btn btn-sm">Add sibling</button></div></form>
          <form class="stack-sm" data-form="parent"><div class="label">Another parent or guardian (gets their own portal sign-in)</div>
            <div class="form-grid"><div class="field"><label class="label small" for="pa-n">Name</label><input class="input" id="pa-n" name="name" required></div>
            <div class="field"><label class="label small" for="pa-e">Email</label><input class="input" id="pa-e" name="email" type="email" required></div>
            <div class="field"><label class="label small" for="pa-p">Phone</label><input class="input" id="pa-p" name="phone" type="tel"></div></div>
            <div><button class="btn btn-sm">Add parent</button></div></form>
        </div></details>
    </section>` : html`<section class="panel"><h2 class="panel-title">Team roster only</h2>
      <p class="panel-sub">${a.first_name} trains with ${d.team ? html`<a href="${owner ? `/app/teams/${d.team.id}` : '#'}">${d.team.school} ${d.team.team_name}</a>` : 'a team'}. There's no family account, so no card, membership or portal login. The school pays through the team contract.</p></section>`;

    const membershipPanel = fam ? html`<section class="panel">
      <h2 class="panel-title">Membership</h2>
      ${m ? html`<div class="kv4">
          <div><div class="k">Status</div>${badge(m.status)}</div>
          <div><div class="k">Plan</div>${m.plan_name}</div>
          ${owner ? html`<div><div class="k">Monthly</div>${money(m.price_cents)}</div>` : ''}
          <div><div class="k">${m.status === 'trial' ? 'Trial ends, first charge' : m.status === 'paused' ? 'Next charge (after resume)' : 'Next charge'}</div>${fmtDate(m.next_charge)}</div>
        </div>
        ${owner ? html`<div class="inline"><select class="input" id="ms-plan" aria-label="Plan">${options(activePlans, m.plan_id, { label: (p) => planLabel(ctx, p) })}</select>
            <button class="btn" data-act="change-plan">Change plan</button></div>
          <p class="hint" style="margin:0">A new plan's price applies from the next charge.</p>
          <div class="btn-row">${m.status === 'paused' ? html`<button class="btn" data-act="ms-resume">Resume subscription</button>` : ['active', 'trial'].includes(m.status) ? html`<button class="btn" data-act="ms-pause">Pause subscription</button>` : ''}
            <button class="btn btn-ghost" data-act="ms-cancel">Cancel subscription</button></div>`
        : html`<p class="hint" style="margin:0">Only owners can change memberships.</p>`}`
      : html`<p class="panel-sub">No membership. ${a.first_name} pays per session or with a pack.</p>
        ${owner ? html`<div class="inline"><select class="input" id="ms-new" aria-label="Plan">${options(activePlans, '', { blank: 'Choose a plan', label: (p) => planLabel(ctx, p) })}</select>
          <button class="btn" data-act="ms-start">Start membership</button></div>
          <label class="check small"><input type="checkbox" id="ms-skip"> Skip the free trial and charge the card today</label>`
        : html`<p class="hint" style="margin:0">Only owners can start memberships.</p>`}`}
    </section>` : '';

    const memberLine = m && ['active', 'trial'].includes(m.status)
      ? `${a.first_name} is a member (${sl.member_group === 'unlimited' ? 'unlimited group classes' : `${sl.member_group} member group sessions left this month`}). `
      : '';
    const cardPanel = html`<section class="panel">
      <div><h2 class="panel-title">Card & sessions</h2>
      <p class="panel-sub">${memberLine}${sl.group_credits} group and ${sl.private_credits} private session${sl.private_credits === 1 ? '' : 's'} left.${fam ? ' Card belongs to the family.' : ''}</p></div>
      ${fam ? html`<div class="spread"><div>${fam.card_last4 ? html`${fam.card_brand || 'Card'} ending ${fam.card_last4}${fam.card_exp ? html` <span class="muted small">exp ${fam.card_exp}</span>` : ''}` : html`<span class="muted">No card on file. The parent adds one in the portal.</span>`}</div>
        ${owner && fam.card_last4 ? html`<button class="btn btn-ghost btn-sm" data-act="card-remove">Remove card</button>` : ''}</div>` : ''}
      ${(() => {
        const open = d.today_sessions.filter((e) => !e.checked_in_at), done = d.today_sessions.filter((e) => e.checked_in_at);
        return html`${done.length ? html`<p class="small good-text" style="margin:0">Checked in today: ${done.map((e) => `${e.name} (${fmtTime(e.starts_at)})`).join(', ')}.</p>` : ''}
        ${open.length ? html`<div class="inline"><select class="input" id="wi-ev" aria-label="Today's session">${open.map((e) => html`<option value="${e.id}">${fmtTime(e.starts_at)} · ${e.name}${e.location ? ` · ${e.location}` : ''}</option>`)}</select>
          <button class="btn" data-act="walk-in">Walk-in check-in</button></div>`
        : done.length ? '' : html`<p class="hint" style="margin:0">No sessions on the schedule today, so there's nothing to check in to.</p>`}`;
      })()}
      <div class="btn-row"><a class="btn btn-primary" href="/app/pos?athlete=${a.id}">Sell to ${a.first_name}</a>
        ${owner ? html`<button class="btn btn-ghost" data-act="credits">Adjust sessions</button>` : ''}</div>
      ${owner && fam && d.payments_mode === 'test' ? html`<div class="spread small"><span class="muted">${fam.card_last4 === '0002' ? 'Test card: charges decline.' : fam.card_last4 ? 'Test card: charges succeed.' : 'Test mode.'}</span>
        <button class="btn btn-ghost btn-sm" data-act="${fam.card_last4 === '0002' ? 'card-approve' : 'card-decline'}">${fam.card_last4 === '0002' ? 'Make card work' : 'Make card decline'}</button></div>` : ''}
    </section>`;

    const paymentsPanel = owner && d.payments ? html`<section class="panel"><h2 class="panel-title">Payments</h2>
      ${d.payments.length ? html`<div class="list">${d.payments.map((p) => html`<div class="list-row">
        <div class="grow"><div>${money(p.amount_cents)} · ${fmtDate(p.issued_at)}</div><div class="muted small">${p.number} · ${p.description || ''}${p.status === 'failed' ? ` · ${p.attempts} attempt${p.attempts === 1 ? '' : 's'}` : ''}</div></div>
        ${badge(p.status)}${p.status === 'failed' ? html`<button class="btn btn-outline btn-sm" data-act="retry" data-id="${p.id}">Retry charge</button>` : ''}</div>`)}</div>
        <a class="small" href="/app/billing">All invoices</a>` : html`<p class="panel-sub">No payments yet.</p>`}</section>` : '';

    const upcomingPanel = html`<section class="panel">
      <div class="panel-head"><h2 class="panel-title">Upcoming sessions</h2><a class="btn btn-sm" href="/app/schedule">Schedule</a></div>
      ${d.upcoming.length ? html`<div class="list">${d.upcoming.map((b) => html`<div class="list-row small">
        <div class="grow">${fmtDateTime(b.starts_at)} · ${b.name}</div>${b.status === 'waitlist' ? badge('waitlist') : b.coverage ? badge(b.coverage) : ''}</div>`)}</div>`
        : html`<p class="panel-sub">Nothing booked. Book from the schedule, or the family books in the portal.</p>`}</section>`;

    const tests = progress?.tests || [];
    const testingPanel = html`<section class="panel">
      <div class="panel-head"><div><h2 class="panel-title">Testing</h2><p class="panel-sub">Best result and change since the first test.</p></div>
        <a class="btn btn-sm" href="${d.report_url}" target="_blank" rel="noopener">Progress report</a></div>
      ${tests.length ? html`<div class="list">${tests.map((t) => html`<div class="list-row test-row small">
          <div class="grow">${t.name} ${t.is_pr_recent ? badge('active', 'New PR') : ''}</div>
          <div class="val">${fmtVal(t.best, t.unit)}</div><div class="chg">${changeText(t)}</div></div>`)}</div>`
        : html`<p class="panel-sub">${progressErr ? 'Test results aren\'t available right now.' : 'No test results yet.'} Results from testing days and uploads show here.</p>`}
    </section>`;

    const canProgram = role !== 'frontdesk';
    const trainingPanel = html`<section class="panel">
      <div><h2 class="panel-title">Training</h2>
      <p class="panel-sub">${d.program ? html`${d.program.name}${d.program.weeks ? ` · ${d.program.weeks} weeks` : ''}${a.program_started ? ` · started ${fmtDate(a.program_started)}` : ''}${d.last_workout ? ` · last workout ${relTime(d.last_workout)}` : ''}` : 'No program assigned yet.'}</p></div>
      ${canProgram ? html`<div class="inline"><select class="input" id="pg-sel" aria-label="Program">${options(lookups.programs, a.program_id, { blank: d.program ? 'No program' : 'Choose a program' })}</select>
        <button class="btn" data-act="program">${d.program ? 'Change program' : 'Assign program'}</button></div>` : ''}
      ${d.workout_url ? html`<div><div class="label">Private app link</div><p class="hint" style="margin:2px 0 8px">Send this to ${a.first_name}. Anyone with the link can see their workouts.</p>
        <div class="btn-row"><button class="btn btn-outline" data-act="copy-app">Copy app link</button><a class="btn btn-ghost" href="${d.workout_url}" target="_blank" rel="noopener">Open app</a>
        ${canProgram ? html`<button class="btn btn-ghost" data-act="reset-link">Reset link</button>` : ''}</div></div>` : ''}
    </section>`;

    const profilePanel = html`<section class="panel"><h2 class="panel-title">Profile</h2>
      <form class="form-grid" id="pf" novalidate>
        <div class="field"><label class="label" for="pf-n">Full name</label><input class="input" id="pf-n" name="name" value="${fullName(a)}" required></div>
        <div class="field"><label class="label" for="pf-e">Athlete email (optional)</label><input class="input" id="pf-e" name="email" type="email" value="${a.email || ''}"></div>
        <div class="field"><label class="label" for="pf-b">Birthday</label><input class="input" id="pf-b" name="birthday" type="date" value="${a.birthday || ''}"></div>
        <div class="field"><label class="label" for="pf-x">Sex</label><select class="input" id="pf-x" name="sex">${options([{ id: 'F', name: 'Female' }, { id: 'M', name: 'Male' }], a.sex, { blank: 'Not set' })}</select>
          <span class="hint">Only used for growth-spurt estimates.</span></div>
        <div class="field"><label class="label" for="pf-id">Athlete ID</label><input class="input mono" id="pf-id" value="${a.code}" readonly>
          <span class="hint">Connects every result, file and device to this athlete.</span></div>
        <div class="field"><label class="label" for="pf-s">Sport</label><input class="input" id="pf-s" name="sport" value="${a.sport || ''}"></div>
        <div class="field"><label class="label" for="pf-p">Position</label><input class="input" id="pf-p" name="position" value="${a.position || ''}"></div>
        <div class="field"><label class="label" for="pf-sc">School</label><input class="input" id="pf-sc" name="school" value="${a.school || ''}"></div>
        <div class="field"><label class="label" for="pf-al">Allergies</label><input class="input" id="pf-al" name="allergies" value="${a.allergies || ''}"></div>
        <div class="field"><label class="label" for="pf-in">Injuries</label><input class="input" id="pf-in" name="injuries" value="${a.injuries || ''}"></div>
        <div class="field span-2"><label class="label" for="pf-mn">Medical notes</label><textarea class="input" id="pf-mn" name="medical_notes">${a.medical_notes || ''}</textarea>
          <span class="hint">Parents can update these in the portal.</span></div>
        <div class="field"><label class="label" for="pf-en">Emergency contact</label><input class="input" id="pf-en" name="emergency_name" value="${a.emergency_name || ''}"></div>
        <div class="field"><label class="label" for="pf-ep">Emergency phone</label><input class="input" id="pf-ep" name="emergency_phone" type="tel" value="${a.emergency_phone || ''}"></div>
        ${role !== 'frontdesk' ? html`<div class="field span-2"><label class="label" for="pf-cn">Coach notes</label><textarea class="input" id="pf-cn" name="coach_notes">${a.coach_notes || ''}</textarea>
          <span class="hint">Only coaches see these.</span></div>` : ''}
        <div class="span-2 spread"><button class="btn btn-primary" type="submit">Save changes</button>
          ${role !== 'frontdesk' ? html`<button class="btn btn-ghost" type="button" data-act="archive">${a.archived ? 'Restore client' : 'Archive client'}</button>` : ''}</div>
      </form></section>`;

    const eng = engagePanels(ctx, a, en, library);
    mount(ctx.el, html`${STYLE}<div class="stack cl-pro">
      <div class="page-header"><div><div class="cl-title"><h1 class="page-title">${fullName(a)}</h1><span class="cl-code">${a.code}</span>${a.archived ? badge('ended', 'Archived') : ''}</div>
        <p class="page-sub">${subBits.join(' · ')}</p></div>
        <a class="btn" href="/app/clients">All clients</a></div>
      ${medical.length ? html`<div class="banner medical" role="note">${icon('warn')}${medical.map(([k, v]) => html`<span><b>${k}:</b> ${v}</span>`)}
        ${a.emergency_name || a.emergency_phone ? html`<span><b>Emergency contact:</b> ${[a.emergency_name, a.emergency_phone].filter(Boolean).join(', ')}</span>` : ''}</div>` : ''}
      <div class="cl-cols">
        <div class="cl-col">${familyPanel}${membershipPanel}${cardPanel}${eng.accountability}${eng.goals}${paymentsPanel}</div>
        <div class="cl-col">${upcomingPanel}${eng.messages}${testingPanel}${eng.targets}${eng.education}${trainingPanel}${profilePanel}</div>
      </div></div>`);
    bind(d);
  }

  const act = async (fn, msg) => {
    try { const r = await fn(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); await draw(); }
    catch (e) { toastError(e); }
  };

  function bind(d) {
    const root = ctx.el.querySelector('.cl-pro');
    const a = d.athlete, m = d.membership, fam = d.family;
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const q = (s) => root.querySelector(s);
      switch (b.dataset.act) {
        case 'copy-portal': return copy(d.portal_url, 'Portal link');
        case 'copy-app': return copy(d.workout_url, 'App link');
        case 'reset-link':
          if (await confirmDialog('Reset the app link?', `The old link stops working. Send ${a.first_name} the new one.`, 'Reset link')) act(() => api.post(`/athletes/${a.id}/workout-link`), 'New app link ready. Copy it and send it.');
          return;
        case 'program': return act(() => api.put(`/athletes/${a.id}/program`, { program_id: q('#pg-sel').value || null }), q('#pg-sel').value ? 'Program assigned. It shows in the workout app now.' : 'Program removed.');
        case 'change-plan': return act(() => api.post(`/memberships/${m.id}/change`, { plan_id: q('#ms-plan').value }), 'Plan changed. The new price applies from the next charge.');
        case 'ms-pause': if (await confirmDialog('Pause the membership?', 'No charges while paused. Member bookings stop being covered.', 'Pause subscription')) act(() => api.post(`/memberships/${m.id}/pause`), 'Membership paused.'); return;
        case 'ms-resume': return act(() => api.post(`/memberships/${m.id}/resume`), 'Membership resumed.');
        case 'ms-cancel': if (await confirmDialog('Cancel the membership?', `${a.first_name} stops being charged and member bookings stop being covered. This can't be undone; you can start a new one later.`, 'Cancel subscription', 'warn')) act(() => api.post(`/memberships/${m.id}/cancel`), 'Membership cancelled.'); return;
        case 'ms-start': {
          const plan_id = q('#ms-new').value;
          if (!plan_id) return toastError(new Error('Choose a plan.'));
          return act(() => api.post(`/athletes/${a.id}/membership`, { plan_id, skip_trial: q('#ms-skip')?.checked }), (r) => (r.trial ? 'Membership started. The trial is free; the first charge is when it ends.' : r.ok ? 'Membership started and the first month charged.' : `Membership started, but the charge failed: ${r.error}`));
        }
        case 'card-remove': if (await confirmDialog('Remove the card?', 'Membership renewals will fail until the family adds a new card in the portal.', 'Remove card', 'warn')) act(() => api.post(`/families/${fam.id}/card`, { action: 'remove' }), 'Card removed.'); return;
        case 'card-decline': return act(() => api.post(`/families/${fam.id}/card`, { action: 'test_decline' }), 'Test card set to decline (ends 0002).');
        case 'card-approve': return act(() => api.post(`/families/${fam.id}/card`, { action: 'test_approve' }), 'Test card set to succeed (ends 4242).');
        case 'walk-in': return act(() => api.post(`/athletes/${a.id}/walk-in`, { event_id: q('#wi-ev').value }), (r) => (r.coverage === 'unpaid' ? `${a.first_name} is checked in. Not covered: sell a drop-in${r.price_cents ? ` (${money(r.price_cents)})` : ''}.` : `${a.first_name} is checked in.`));
        case 'goal-end': if (await confirmDialog(`End "${b.dataset.title}"?`, `It comes off ${a.first_name}'s list. Past weeks aren't affected.`, 'End goal', 'warn')) act(() => api.put(`/goals/${b.dataset.id}`, { active: false }), 'Goal ended.'); return;
        case 'target-rm': if (await confirmDialog(`Remove the ${b.dataset.title} target?`, 'Results stay. Only the target goes.', 'Remove target', 'warn')) act(() => api.del(`/targets/${b.dataset.id}`), 'Target removed.'); return;
        case 'assign-lesson': if (await assignDialog({ athlete: { id: a.id, name: fullName(a) } })) draw(); return;
        case 'retry': return act(() => api.post(`/invoices/${b.dataset.id}/retry`), 'Charge went through.');
        case 'credits': {
          const r = await modal({ title: 'Adjust sessions', body: html`<p class="muted" style="margin:0">Set how many sessions ${a.first_name} has left. Use this to fix a mistake or give a session back.</p>
            <div class="form-grid"><div class="field"><label class="label" for="cr-g">Group sessions</label><input class="input" id="cr-g" type="number" min="0" value="${a.group_credits}"></div>
            <div class="field"><label class="label" for="cr-p">Private sessions</label><input class="input" id="cr-p" type="number" min="0" value="${a.private_credits}"></div></div>`,
            actions: [{ label: 'Cancel', value: null }, { label: 'Save sessions', kind: 'primary', onClick: async (body) => { await api.post(`/athletes/${a.id}/credits`, { group_credits: Number(body.querySelector('#cr-g').value), private_credits: Number(body.querySelector('#cr-p').value) }); return true; } }] });
          if (r) { toast('Sessions updated.'); draw(); }
          return;
        }
        case 'archive': {
          const restore = !!a.archived;
          if (!restore && m) return toastError(new Error('Cancel the membership before archiving this client.'));
          if (await confirmDialog(restore ? 'Restore this client?' : 'Archive this client?', restore ? `${a.first_name} shows in Clients again.` : `${a.first_name} leaves the client list and search. Results and history are kept.`, restore ? 'Restore client' : 'Archive client', restore ? 'primary' : 'warn')) {
            try { await api.post(`/athletes/${a.id}/archive`, { restore }); toast(restore ? 'Client restored.' : 'Client archived.'); if (restore) draw(); else ctx.go('/app/clients'); } catch (err) { toastError(err); }
          }
          return;
        }
      }
    });
    const tf = root.querySelector('[data-form="target"]');
    if (tf) {
      const hint = () => {
        const unit = tf.test_id.selectedOptions[0]?.dataset.unit, v = parseEntry(tf.target.value, unit);
        const h = tf.querySelector('#tg-h');
        h.classList.toggle('warn-text', !!tf.target.value.trim() && !!unit && !(v > 0));
        h.textContent = unit && tf.target.value.trim() ? (v > 0 ? `Target: ${fmtValue(v, unit)}` : `Enter it in ${unit === 'in' ? 'inches or feet and inches' : unit}.`) : valueHint(unit);
      };
      tf.test_id.addEventListener('change', hint); tf.target.addEventListener('input', hint);
    }
    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button[type=submit], button:not([type])');
      if (btn) btn.disabled = true;
      try {
        if (f.id === 'pf') { await api.put(`/athletes/${a.id}`, formData(f)); toast('Profile saved.'); await draw(); }
        else if (f.dataset.form === 'sibling') { const r = await api.post(`/families/${fam.id}/athletes`, formData(f)); toast(`Sibling added. Athlete ID ${r.code}.`); ctx.go(`/app/clients/${r.id}`); }
        else if (f.dataset.form === 'goal') { await api.post(`/athletes/${a.id}/goals`, formData(f)); toast('Goal added. It shows in the app now.'); await draw(); }
        else if (f.dataset.form === 'message') {
          const body = f.body.value.trim();
          if (!body) throw new Error('Write a message first.');
          await api.post(`/athletes/${a.id}/messages`, { body }); toast(`Message sent. ${a.first_name} and their parents were emailed.`); await draw();
        } else if (f.dataset.form === 'target') {
          const dd = formData(f), opt = f.test_id.selectedOptions[0];
          if (!dd.test_id) throw new Error('Choose a test.');
          const v = parseEntry(dd.target, opt.dataset.unit);
          if (v == null || !Number.isFinite(v) || v <= 0) throw new Error(opt.dataset.unit === 'in' ? 'Enter the target in inches, or feet and inches like 6\'8".' : `Enter the target in ${opt.dataset.unit}.`);
          await api.post(`/athletes/${a.id}/targets`, { test_id: Number(dd.test_id), target: dd.target, due_date: dd.due_date || null });
          toast(`Target set: ${opt.textContent.replace(/ \(best.*$/, '')} ${fmtValue(v, opt.dataset.unit)}.`); await draw();
        }
        else if (f.dataset.form === 'parent') { await api.post(`/families/${fam.id}/parents`, formData(f)); toast('Parent added. They were emailed a portal sign-in link.'); await draw(); }
      } catch (err) { toastError(err); }
      finally { if (btn?.isConnected) btn.disabled = false; }
    });
  }

  await draw();
}

export const routes = [
  { path: '/clients', nav: 'clients', title: 'Clients', render: renderList },
  { path: '/clients/new', nav: 'clients', title: 'New client', render: renderNew },
  { path: '/clients/:id', nav: 'clients', title: 'Client', render: renderProfile },
];
