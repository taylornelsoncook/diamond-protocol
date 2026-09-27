// Billing: the money summary, failed payments to chase, every invoice (details, refunds, write-offs, export),
// memberships, plans, and the test-mode billing clock. Owner only.
import { html, mount, api, money, fmtDate, relTime, badge, icon, toast, toastError, modal, confirmDialog, formData, options, localISO, debounce, plural } from '/js/ui.js';

const STYLE = html`<style>
.bl .table-wrap{position:relative;border:0;border-radius:0;border-top:1px solid var(--line);margin:0 calc(-1 * var(--space-6));background:transparent}
.bl .table td,.bl .table th{padding-left:20px;padding-right:20px}
.bl .plan-name{font-weight:600}
.bl .rev{font:600 20px/1 var(--font-display)}
.bl .retired td{color:var(--steel-muted)}
.bl .who{font-weight:600;color:var(--steel)}
.bl .plan-form{display:grid;grid-template-columns:2fr 1fr 1fr;gap:var(--space-3)}
.bl .plan-form .more{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3)}
.bl .clock{display:flex;gap:var(--space-2);align-items:flex-end;flex-wrap:wrap}
.bl .bl-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md)}
.bl .bl-metrics .metric{border:0;border-radius:0;background:transparent;padding:var(--space-4) var(--space-6);text-align:left;font:inherit;color:inherit;cursor:pointer;min-width:0}
.bl .bl-metrics .metric:hover{background:var(--surface-raised)}
.bl .bl-metrics .metric+.metric{border-left:1px solid var(--line)}
.bl .bl-metrics .metric-value{font-size:32px}
@media (max-width:900px){.bl .bl-metrics{grid-template-columns:1fr 1fr}.bl .bl-metrics .metric:nth-child(3){border-left:0}.bl .bl-metrics .metric:nth-child(n+3){border-top:1px solid var(--line)}}
@media (max-width:420px){.bl .bl-metrics .metric{padding:var(--space-3) var(--space-4)}.bl .bl-metrics .metric-value{font-size:26px}}
.bl .bl-jump{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;position:sticky;top:0;z-index:5;background:var(--ground);border-bottom:1px solid var(--line);margin-top:calc(-1 * var(--space-2))}
.bl .bl-jump button{flex:0 0 auto;min-height:44px;padding:0 14px;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--steel-muted);font:600 14px/1 var(--font-sans);cursor:pointer;white-space:nowrap}
.bl .bl-jump button:hover{color:var(--steel);border-bottom-color:var(--line)}
.bl .bl-jump .n{color:var(--amber);font-weight:600;margin-left:4px}
.bl section[id]{scroll-margin-top:60px}
@media (max-width:900px){.bl .bl-jump{top:57px;margin-left:-16px;margin-right:-16px;padding:0 8px}.bl section[id]{scroll-margin-top:112px}}
.bl .views{display:flex;gap:6px;flex-wrap:wrap}
.bl .view{min-height:44px;padding:0 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm);background:var(--surface);color:var(--steel-muted);font:600 14px/1 var(--font-sans);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.bl .view:hover{color:var(--steel);background:var(--surface-raised)}
.bl .view[aria-pressed="true"]{background:var(--surface-raised);border-color:var(--green-mid);color:var(--steel)}
.bl .view .n{font-weight:500;color:var(--steel-muted)}
.bl .view.warn .n{color:var(--amber)}
@media (max-width:700px){.bl .views{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 calc(-1 * var(--space-6));padding:0 var(--space-6)}.bl .view{flex:0 0 auto}}
.bl .tools{display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center}
.bl .tools .input{width:auto;flex:1 1 200px}
.bl .tools select.input{flex:0 1 180px}
.bl .row-title{font-weight:600;color:var(--steel);text-decoration:none}
.bl a.row-title:hover{color:var(--green-soft)}
.bl .row-sub{font-size:13px;color:var(--steel-muted)}
.bl .att .list-row{flex-wrap:wrap;padding:14px 0}
.bl .acts{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end}
.bl .amt{font-weight:600;min-width:64px;text-align:right;font-variant-numeric:tabular-nums}
@media (max-width:600px){.bl .acts{justify-content:flex-start;width:100%}.bl .amt{min-width:0;text-align:left}}
.bl tr.click{cursor:pointer}
.bl tr.click:hover td{background:var(--surface-raised)}
.bl .table .num{white-space:nowrap}
.bl .sub-amt{font-size:13px;color:var(--steel-muted);font-weight:400}
.bl .m-only{display:none}
.bl .plan-acts{justify-content:flex-end;flex-wrap:nowrap}
.bl .more-row{display:flex;justify-content:center;padding-top:var(--space-2)}
.bl .clock-result{font-size:14px;padding:var(--space-3) var(--space-4);border:1px solid var(--line);border-left:3px solid var(--green-mid);border-radius:var(--radius-md);background:var(--surface-raised)}
.bl details.add summary{cursor:pointer;font-weight:600;min-height:44px;display:flex;align-items:center;gap:8px;list-style:none;color:var(--steel)}
.bl details.add summary::-webkit-details-marker{display:none}
.bl details.add summary::before{content:'';width:0;height:0;border:5px solid transparent;border-left:7px solid currentColor;border-right:0}
.bl details.add[open] summary::before{transform:rotate(90deg)}
.bl details.add[open] summary{margin-bottom:var(--space-3)}
.bl .plan-subs{background:none;border:0;padding:0 4px;min-height:32px;color:var(--steel);font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
@media (max-width:700px){
  .bl .plan-form{grid-template-columns:1fr 1fr}.bl .plan-form .f-name{grid-column:1/-1}
  .bl .col-what,.bl .col-date,.bl .col-trial,.bl .col-card,.bl .col-plan,.bl .col-status,.bl .col-go,.bl .col-price{display:none}
  .bl .plan-acts{flex-direction:column;align-items:flex-end}.bl .m-only{display:block}
  .bl .table td,.bl .table th{padding-left:12px;padding-right:12px}
  .bl .tools .input,.bl .tools select.input{flex:1 1 100%}
}
@media (pointer:coarse){.bl .btn-sm,.bl-modal .btn-sm{min-height:44px}.bl .plan-subs{min-height:44px}}
.bl-modal .kv{font-size:14px}
.bl-modal .kv dd{overflow-wrap:anywhere}
.bl-modal .big{font:600 32px/1.1 var(--font-display);color:var(--steel)}
.bl-modal .acts{display:flex;gap:var(--space-2);flex-wrap:wrap;padding-top:var(--space-3);border-top:1px solid var(--line-subtle)}
.bl-modal .refunds{font-size:14px}
.bl-modal .acts[hidden]{display:none}
.bl-modal .linkish{background:none;border:0;padding:0;font:inherit;color:var(--green-bright);text-decoration:underline;text-underline-offset:3px;cursor:pointer;min-height:24px}
</style>`;

const INV_VIEWS = [
  { id: '', name: 'All', count: 'all' }, { id: 'failed', name: 'Failed', count: 'failed', warn: true }, { id: 'unpaid', name: 'Unpaid', count: 'unpaid' },
  { id: 'overdue', name: 'Overdue', count: 'overdue', warn: true }, { id: 'paid', name: 'Paid', count: 'paid' }, { id: 'refund', name: 'Refunds', count: 'refund' },
  { id: 'void', name: 'Void', count: 'void' },
];
const KINDS = [{ id: '', name: 'Every kind' }, { id: 'membership', name: 'Memberships' }, { id: 'school', name: 'School invoices' }, { id: 'charge', name: 'Sales and drop-ins' }];
const PERIODS = [{ id: '', name: 'Any time' }, { id: 'month', name: 'This month' }, { id: 'last', name: 'Last month' }, { id: '90', name: 'Last 90 days' }, { id: 'year', name: 'This year' }];
const MEM_VIEWS = [
  { id: 'live', name: 'All members' }, { id: 'renewing', name: 'Renewing this week' }, { id: 'trial', name: 'Free trial' },
  { id: 'past_due', name: 'Past due', warn: true }, { id: 'paused', name: 'Paused' }, { id: 'cancelled', name: 'Cancelled lately' },
];
const PAY_METHODS = [{ id: 'check', name: 'Check' }, { id: 'cash', name: 'Cash' }, { id: 'card', name: 'Card in person' }, { id: 'ach', name: 'Bank transfer' }, { id: 'other', name: 'Other' }];
const allowance = (p) => [p.group_per_month == null ? 'Unlimited group classes' : `${p.group_per_month} group sessions a month`, p.private_per_month ? `${p.private_per_month} privates a month` : null].filter(Boolean).join(' + ');
const signed = (c) => (c < 0 ? `−${money(-c)}` : money(c));
const cardLabel = (r) => (r.card_last4 ? `${r.card_brand || 'Card'} ending ${r.card_last4}` : 'No card on file');
const daysLate = (due) => Math.round((new Date(localISO() + 'T12:00:00') - new Date(due + 'T12:00:00')) / 864e5);
const whoName = (i) => (i.first_name ? `${i.first_name} ${i.last_name}` : i.contract_id ? i.school || i.team_name || 'School' : i.family || 'Walk-in');
const whatText = (i) => i.plan_name || (i.contract_id ? i.team_name : i.description) || '';

function periodRange(id) {
  const now = new Date();
  const d = (y, m, day) => localISO(new Date(y, m, day));
  if (id === 'month') return { from: d(now.getFullYear(), now.getMonth(), 1), to: localISO(now) };
  if (id === 'last') return { from: d(now.getFullYear(), now.getMonth() - 1, 1), to: d(now.getFullYear(), now.getMonth(), 0) };
  if (id === '90') return { from: localISO(new Date(Date.now() - 90 * 864e5)), to: localISO(now) };
  if (id === 'year') return { from: d(now.getFullYear(), 0, 1), to: localISO(now) };
  return {};
}

function statusBadge(i) {
  if (i.amount_cents < 0) return badge('credit', 'Refund');
  if (i.status === 'paid' && i.refunded_cents > 0) return i.refunded_cents >= i.amount_cents ? badge('void', 'Refunded') : badge('open', 'Part refunded');
  if (i.overdue || (i.status === 'open' && i.due_date && i.due_date < localISO())) return badge('overdue');
  return badge(i.status);
}

function retryText(i) {
  if (i.status !== 'failed') return '';
  const bits = [`Declined ${plural(i.attempts, 'time')}`, cardLabel(i),
    i.retries_done ? 'no more automatic retries' : i.next_retry ? `next automatic retry ${fmtDate(i.next_retry, { year: false })}` : null,
    i.last_reminder ? `card reminder sent ${i.last_reminder === localISO() ? 'today' : fmtDate(i.last_reminder, { year: false })}` : null];
  return bits.filter(Boolean).join(' · ');
}

function planFields(p = {}, x = 'pl') {
  return html`<div class="field f-name"><label class="label" for="${x}-n">Plan name</label><input class="input" id="${x}-n" name="name" maxlength="60" value="${p.name || ''}"></div>
    <div class="field"><label class="label" for="${x}-p">Monthly price ($)</label><input class="input" id="${x}-p" name="price" inputmode="decimal" value="${p.price_cents != null ? (p.price_cents / 100).toFixed(2) : ''}"></div>
    <div class="field"><label class="label" for="${x}-t">Trial days</label><input class="input" id="${x}-t" name="trial_days" type="number" min="0" max="90" inputmode="numeric" value="${p.trial_days ?? 7}"></div>
    <div class="more"><div class="field"><label class="label" for="${x}-g">Group sessions a month</label><input class="input" id="${x}-g" name="group_per_month" type="number" min="0" max="100" inputmode="numeric" placeholder="Unlimited" value="${p.group_per_month ?? ''}"><span class="hint">Leave blank for unlimited.</span></div>
    <div class="field"><label class="label" for="${x}-v">Private sessions a month</label><input class="input" id="${x}-v" name="private_per_month" type="number" min="0" max="100" inputmode="numeric" value="${p.private_per_month ?? 0}"></div></div>`;
}

// Record payment fields: how they paid, the check number, the day it arrived.
const payFields = (amount) => html`<p class="muted" style="margin:0">Mark ${money(amount)} as collected outside the card on file.</p><div class="form-grid">
  <div class="field"><label class="label" for="rp-m">How they paid</label><select class="input" id="rp-m">${options(PAY_METHODS, 'check')}</select></div>
  <div class="field" id="rp-cf"><label class="label" for="rp-c">Check number</label><input class="input" id="rp-c" inputmode="numeric" autocomplete="off" maxlength="30"></div>
  <div class="field"><label class="label" for="rp-d">Received</label><input class="input" id="rp-d" type="date" value="${localISO()}" max="${localISO()}"></div></div>`;

async function render(ctx) {
  const legacy = new URLSearchParams(ctx.query.filter || '');
  const inv = { view: ctx.query.view ?? legacy.get('status') ?? '', kind: ctx.query.kind ?? legacy.get('kind') ?? '', period: ctx.query.period || '', q: '', limit: 50 };
  if (!INV_VIEWS.some((v) => v.id === inv.view)) inv.view = '';
  if (!KINDS.some((k) => k.id === inv.kind)) inv.kind = '';
  if (!PERIODS.some((k) => k.id === inv.period)) inv.period = '';
  const mem = { view: 'live', plan: '', q: '' };
  let summary = null, plans = [];
  const testMode = ctx.settings?.payments_mode === 'test';

  mount(ctx.el, html`${STYLE}<div class="stack bl">
    <div class="page-header"><div><h1 class="page-title">Billing</h1><p class="page-sub">Money in, money owed, and who is on which plan.</p></div></div>
    <div class="bl-metrics" id="bl-sum" aria-live="polite"><div class="metric"><span class="metric-label">Loading…</span></div></div>
    <nav class="bl-jump" aria-label="Billing sections">
      <button type="button" data-jump="bl-att">Needs attention<span class="n" id="bl-att-n"></span></button><button type="button" data-jump="bl-inv">Invoices</button>
      <button type="button" data-jump="bl-mem">Memberships</button><button type="button" data-jump="bl-plans">Plans</button>
      ${testMode ? html`<button type="button" data-jump="bl-clock">Billing clock</button>` : ''}</nav>
    <section class="panel att" id="bl-att"><div class="panel-head"><div><h2 class="panel-title">Needs attention</h2><p class="panel-sub" id="bl-att-sub">Declined charges and overdue invoices.</p></div>
      <div class="btn-row" id="bl-att-tools"></div></div><div id="bl-att-list"><div class="muted">Loading…</div></div></section>
    <section class="panel" id="bl-inv"><div class="panel-head"><div><h2 class="panel-title">Invoices</h2><p class="panel-sub" id="bl-inv-sub">Every charge, newest first.</p></div>
      <a class="btn btn-ghost btn-sm" id="bl-export" href="/api/invoices/export.csv" download>${icon('download', 16)} Export CSV</a></div>
      <div class="views" id="bl-views" role="group" aria-label="Show invoices"></div>
      <div class="tools"><input class="input" id="bl-q" type="search" placeholder="Name, invoice number, school or item" aria-label="Search invoices">
        <select class="input" id="bl-kind" aria-label="Kind of invoice">${options(KINDS, inv.kind)}</select>
        <select class="input" id="bl-period" aria-label="Issued">${options(PERIODS, inv.period)}</select></div>
      <div id="bl-invoices"><div class="muted">Loading…</div></div></section>
    <section class="panel" id="bl-mem"><div class="panel-head"><div><h2 class="panel-title">Memberships</h2><p class="panel-sub" id="bl-mem-sub">Everyone on a plan and when they pay next.</p></div></div>
      <div class="views" id="bl-mviews" role="group" aria-label="Show memberships"></div>
      <div class="tools"><input class="input" id="bl-mq" type="search" placeholder="Athlete, family or Athlete ID" aria-label="Search memberships">
        <select class="input" id="bl-mplan" aria-label="Plan"></select></div>
      <div id="bl-members"><div class="muted">Loading…</div></div></section>
    <section class="panel" id="bl-plans"><div><h2 class="panel-title">Plans</h2><p class="panel-sub">Price changes apply from each member's next charge. Nobody is charged when you save.</p></div>
      <div id="bl-plan-list"><div class="muted">Loading…</div></div>
      <details class="add" id="bl-add"><summary>Add a plan</summary><form class="plan-form" id="pl-new" novalidate>${planFields()}<div><button class="btn">Create plan</button></div></form></details>
    </section>
    ${testMode ? html`<section class="panel" id="bl-clock"><div><h2 class="panel-title">Billing clock (test mode)</h2>
      <p class="panel-sub">Billing runs hourly on its own. Run it for a future date to see trials convert, renewals charge, retries happen and school invoices go out.</p></div>
      <form class="clock" id="clock"><div class="field"><label class="label" for="ck-d">Run as of</label><input class="input" id="ck-d" name="as_of" type="date" value="${localISO(new Date(Date.now() + 8 * 864e5))}" min="${localISO()}"></div>
        <button class="btn">Run billing</button></form><div id="bl-clock-out" aria-live="polite"></div></section>` : ''}
  </div>`);
  const root = ctx.el.querySelector('.bl');
  const $ = (s) => root.querySelector(s);
  const failSoft = (el, what, fn) => (err) => { if (!ctx.isCurrent()) return; mount(el, html`<div class="empty">Couldn't load ${what}: ${err.message} <button class="btn btn-ghost btn-sm" data-act="reload-${fn}">Try again</button></div>`); };

  // ---------------------------------------------------------------- summary
  async function drawSummary() {
    summary = await api.get('/billing/summary');
    if (!ctx.isCurrent()) return;
    const s = summary;
    mount($('#bl-sum'), html`
      <button type="button" class="metric" data-jump="bl-mem"><span class="metric-label">Monthly recurring</span><span class="metric-value">${money(s.mrr.total_cents)}</span>
        <span class="metric-note">${plural(s.mrr.members, 'paying member')}${s.mrr.teams ? ` · ${money(s.mrr.teams_cents)} teams` : ''}</span></button>
      <button type="button" class="metric" data-metric="collected"><span class="metric-label">Collected this month</span><span class="metric-value good">${money(s.month.collected_cents)}</span>
        <span class="metric-note">${plural(s.month.payments, 'payment')}${s.month.refunded_cents ? ` · ${money(s.month.refunded_cents)} refunded` : ''}</span></button>
      <button type="button" class="metric" data-jump="bl-att"><span class="metric-label">Failed payments</span><span class="metric-value ${s.failed.count ? 'warn' : ''}">${s.failed.count}</span>
        <span class="metric-note">${s.failed.count ? `${money(s.failed.cents)} at risk${s.failed.no_card ? ` · ${s.failed.no_card} with no card` : ''}` : 'Nothing at risk'}</span></button>
      <button type="button" class="metric" data-metric="open"><span class="metric-label">Invoices open</span><span class="metric-value ${s.unpaid.overdue_count ? 'warn' : ''}">${money(s.unpaid.cents)}</span>
        <span class="metric-note">${s.unpaid.count ? `${plural(s.unpaid.count, 'invoice')}${s.unpaid.overdue_count ? ` · ${money(s.unpaid.overdue_cents)} overdue` : ' · none overdue'}` : 'Nothing owed'}</span></button>`);
    const n = s.failed.count + s.unpaid.overdue_count;
    $('#bl-att-n').textContent = n ? String(n) : '';
    drawViews();
  }

  function drawViews() {
    const c = summary?.counts || {};
    mount($('#bl-views'), INV_VIEWS.map((v) => html`<button type="button" class="view ${v.warn && c[v.count] ? 'warn' : ''}" data-view="${v.id}" aria-pressed="${inv.view === v.id}">${v.name}${c[v.count] != null ? html` <span class="n">${c[v.count]}</span>` : ''}</button>`));
  }

  // ---------------------------------------------------------------- needs attention
  async function drawAttention() {
    const [failed, overdue] = await Promise.all([api.get('/invoices?status=failed&limit=100'), api.get('/invoices?status=overdue&limit=100')]);
    if (!ctx.isCurrent()) return;
    const withCard = failed.filter((i) => i.card_last4 && i.kind !== 'school').length;
    $('#bl-att-sub').textContent = failed.length || overdue.length
      ? [failed.length ? `${plural(failed.length, 'declined charge')} (${money(failed.reduce((n, i) => n + i.amount_cents, 0))})` : null,
        overdue.length ? `${plural(overdue.length, 'overdue invoice')} (${money(overdue.reduce((n, i) => n + i.amount_cents, 0))})` : null].filter(Boolean).join(' and ') + '. Declines retry on their own every 3 days, up to 4 tries.'
      : 'Declined charges and overdue invoices show here.';
    mount($('#bl-att-tools'), failed.length ? html`
      ${withCard ? html`<button class="btn btn-outline btn-sm" data-act="retry-all">Retry ${withCard === 1 ? 'the declined charge' : `all ${withCard} charges`}</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="remind-all">Email card reminders</button>` : '');
    if (!failed.length && !overdue.length) {
      mount($('#bl-att-list'), html`<p class="panel-sub" style="margin:0">Nothing needs attention. Every charge went through and no invoice is overdue.</p>`);
      return;
    }
    mount($('#bl-att-list'), html`<div class="list">
      ${failed.map((i) => html`<div class="list-row">
        <div class="grow">${i.athlete_id ? html`<a class="row-title" href="/app/clients/${i.athlete_id}">${whoName(i)}</a>` : html`<span class="row-title">${whoName(i)}</span>`}
          <span class="muted"> · ${whatText(i)}</span>
          <div class="row-sub ${i.card_last4 ? '' : 'warn-text'}">${i.number} · ${retryText(i)}</div></div>
        <div class="acts"><span class="amt">${money(i.amount_cents)}</span>${badge('failed')}
          ${i.card_last4 ? html`<button class="btn btn-outline btn-sm" data-act="retry" data-id="${i.id}" data-amt="${i.amount_cents}" data-card="${cardLabel(i)}" data-who="${whoName(i)}">Retry charge</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-act="remind" data-id="${i.id}" aria-label="Email ${whoName(i)}'s family a card reminder">Remind</button>
          <button class="btn btn-ghost btn-sm" data-act="open" data-id="${i.id}" aria-label="Details for ${i.number}">Details</button></div></div>`)}
      ${overdue.map((i) => html`<div class="list-row">
        <div class="grow">${i.contract_id ? html`<a class="row-title" href="/app/teams/${i.contract_id}">${whoName(i)}</a>` : html`<span class="row-title">${whoName(i)}</span>`}
          <span class="muted"> · ${whatText(i)}</span>
          <div class="row-sub warn-text">${i.number} · ${plural(daysLate(i.due_date), 'day')} past due (due ${fmtDate(i.due_date, { year: false })})</div></div>
        <div class="acts"><span class="amt">${money(i.amount_cents)}</span>${badge('overdue')}
          <button class="btn btn-outline btn-sm" data-act="pay" data-id="${i.id}" data-amt="${i.amount_cents}" data-num="${i.number}">Record payment</button>
          <button class="btn btn-ghost btn-sm" data-act="open" data-id="${i.id}" aria-label="Details for ${i.number}">Details</button></div></div>`)}
    </div>`);
  }

  // ---------------------------------------------------------------- invoices
  function invParams(extra = {}) {
    const p = new URLSearchParams();
    if (inv.view) p.set('status', inv.view);
    if (inv.kind) p.set('kind', inv.kind);
    const r = periodRange(inv.period);
    if (r.from) p.set('from', r.from);
    if (r.to) p.set('to', r.to);
    if (inv.q) p.set('q', inv.q);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }
  function syncUrl() {
    const p = new URLSearchParams();
    if (inv.view) p.set('view', inv.view);
    if (inv.kind) p.set('kind', inv.kind);
    if (inv.period) p.set('period', inv.period);
    history.replaceState(history.state, '', '/app/billing' + (p.toString() ? `?${p}` : ''));
  }
  async function drawInvoices() {
    const d = await api.get('/invoices?' + invParams({ paged: '1', limit: String(inv.limit) }));
    if (!ctx.isCurrent()) return;
    $('#bl-export').href = '/api/invoices/export.csv?' + invParams();
    const label = [INV_VIEWS.find((v) => v.id === inv.view)?.id ? INV_VIEWS.find((v) => v.id === inv.view).name.toLowerCase() : null, inv.kind ? KINDS.find((k) => k.id === inv.kind).name.toLowerCase() : null].filter(Boolean).join(' ');
    $('#bl-inv-sub').textContent = d.total
      ? `${plural(d.total, 'invoice')}${label ? ` (${label})` : ''} · ${signed(d.total_cents)} ${inv.view === 'refund' ? 'refunded' : 'in total'}. Tap one for details, refunds and write-offs.`
      : 'Every charge, newest first.';
    const filtered = inv.view || inv.kind || inv.period || inv.q;
    if (!d.invoices.length) {
      mount($('#bl-invoices'), html`<div class="empty">${filtered ? 'No invoices match. Try another filter or clear the search.' : 'No invoices yet. Memberships, sales and school contracts all show here once they charge.'}</div>`);
      return;
    }
    mount($('#bl-invoices'), html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Client</th><th class="col-what">Plan or item</th><th class="col-date">Issued</th><th class="num">Amount</th><th class="col-status">Status</th><th class="col-go"><span class="sr-only">Details</span></th></tr></thead>
      <tbody>${d.invoices.map((i) => html`<tr class="click" data-open="${i.id}">
        <td><span class="who">${whoName(i)}</span><div class="small muted mono">${i.number}</div>
          <div class="m-only small muted">${whatText(i)} · ${fmtDate(i.issued_at)}</div>
          ${i.status === 'failed' ? html`<div class="small warn-text">${plural(i.attempts, 'attempt')}${i.retries_done ? ' · no more retries' : i.next_retry ? ` · retry ${fmtDate(i.next_retry, { year: false })}` : ''}</div>` : ''}</td>
        <td class="col-what">${whatText(i)}${i.refund_of_number ? html`<div class="small muted">Refund of ${i.refund_of_number}</div>` : ''}</td>
        <td class="col-date">${fmtDate(i.issued_at)}</td>
        <td class="num">${signed(i.amount_cents)}${i.refunded_cents > 0 ? html`<div class="sub-amt">${signed(-i.refunded_cents)} refunded</div>` : ''}<div class="m-only">${statusBadge(i)}</div></td>
        <td class="col-status">${statusBadge(i)}</td>
        <td class="num col-go"><button class="btn btn-ghost btn-sm" data-act="open" data-id="${i.id}" aria-label="Details for ${i.number}">${icon('chevron', 16)}</button></td></tr>`)}</tbody></table></div>
      ${d.invoices.length < d.total ? html`<div class="more-row"><button class="btn btn-ghost" data-act="more">Show more (${d.total - d.invoices.length} left)</button></div>` : ''}`);
  }

  // ---------------------------------------------------------------- memberships
  function memNext(m) {
    if (m.status === 'trial') return `Trial ends ${fmtDate(m.next_charge, { year: false })}`;
    if (m.status === 'active') return `Renews ${fmtDate(m.next_charge, { year: false })}`;
    if (m.status === 'past_due') return `${m.failed_cents ? `${money(m.failed_cents)} unpaid` : 'Payment failed'} · next charge ${fmtDate(m.next_charge, { year: false })}`;
    if (m.status === 'paused') return 'Paused, not charged';
    return `Cancelled ${fmtDate(m.cancelled_at)}`;
  }
  async function drawMembers() {
    const p = new URLSearchParams({ view: mem.view });
    if (mem.plan) p.set('plan_id', mem.plan);
    if (mem.q) p.set('q', mem.q);
    const d = await api.get('/memberships?' + p);
    if (!ctx.isCurrent()) return;
    mount($('#bl-mviews'), MEM_VIEWS.map((v) => html`<button type="button" class="view ${v.warn && d.counts[v.id] ? 'warn' : ''}" data-mview="${v.id}" aria-pressed="${mem.view === v.id}">${v.name} <span class="n">${d.counts[v.id]}</span></button>`));
    $('#bl-mem-sub').textContent = d.upcoming.count
      ? `Next 7 days: ${plural(d.upcoming.count, 'renewal')}, ${money(d.upcoming.cents)} expected. Trials convert on their end date.`
      : 'No renewals in the next 7 days.';
    if (!d.memberships.length) {
      mount($('#bl-members'), html`<div class="empty">${mem.q || mem.plan ? 'No memberships match.' : mem.view === 'live' ? 'No one is on a plan yet. Start a membership from New client or a client profile.' : 'None right now.'}</div>`);
      return;
    }
    mount($('#bl-members'), html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Athlete</th><th class="col-plan">Plan</th><th>Status</th><th class="col-date">Next</th><th class="col-card">Card</th><th><span class="sr-only">Manage</span></th></tr></thead>
      <tbody>${d.memberships.map((m) => html`<tr>
        <td><a class="who" href="/app/clients/${m.athlete_id}">${m.first_name} ${m.last_name}</a>
          <div class="small muted">${m.family || ''}</div><div class="m-only small muted">${m.plan_name} · ${money(m.price_cents)}/mo</div>
          <div class="m-only small ${m.status === 'past_due' ? 'warn-text' : 'muted'}">${memNext(m)}</div></td>
        <td class="col-plan">${m.plan_name}<div class="small muted">${money(m.price_cents)} / mo${m.plan_active ? '' : ' · retired plan'}</div></td>
        <td>${badge(m.status)}</td>
        <td class="col-date ${m.status === 'past_due' ? 'warn-text' : ''}">${memNext(m)}</td>
        <td class="col-card small ${m.card_last4 ? 'muted' : 'warn-text'}">${cardLabel(m)}${m.card_exp ? html`<div>Expires ${m.card_exp}</div>` : ''}</td>
        <td class="num">${m.status === 'cancelled' ? '' : html`<button class="btn btn-ghost btn-sm" data-act="manage" data-id="${m.id}" aria-label="Manage ${m.first_name} ${m.last_name}'s membership">Manage</button>`}</td></tr>`)}</tbody></table></div>`);
    $('#bl-members')._rows = d.memberships;
  }

  // ---------------------------------------------------------------- plans
  async function drawPlans() {
    plans = await api.get('/plans');
    if (!ctx.isCurrent()) return;
    mount($('#bl-mplan'), html`<option value="">Every plan</option>${plans.map((p) => html`<option value="${p.id}" ${String(p.id) === mem.plan ? 'selected' : ''}>${p.name}${p.active ? '' : ' (retired)'}</option>`)}`);
    $('#bl-add').open = !plans.length;
    mount($('#bl-plan-list'), plans.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Plan</th><th class="col-price">Price</th><th class="col-trial">Trial</th><th>Members</th><th class="col-date">Monthly revenue</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${plans.map((p) => html`<tr class="${p.active ? '' : 'retired'}">
        <td><div class="plan-name">${p.name}</div><div class="small muted">${p.active ? allowance(p) : 'Retired: current members keep it, no one new can join'}</div>
          <div class="m-only small muted">${money(p.price_cents)} / mo · ${p.trial_days ? `${p.trial_days}-day trial` : 'no trial'} · ${money(p.monthly_revenue_cents)} a month now</div></td>
        <td class="col-price" style="white-space:nowrap">${money(p.price_cents)} / mo</td><td class="col-trial">${p.trial_days ? `${p.trial_days} days` : 'None'}</td>
        <td>${p.subscribers ? html`<button class="plan-subs" data-act="plan-members" data-id="${p.id}" aria-label="Show the ${p.subscribers} members on ${p.name}">${p.subscribers}</button>` : '0'}</td>
        <td class="col-date"><span class="rev">${money(p.monthly_revenue_cents)}</span></td>
        <td class="num"><div class="btn-row plan-acts"><button class="btn btn-ghost btn-sm" data-act="edit" data-id="${p.id}" aria-label="Edit ${p.name}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-act="${p.active ? 'retire' : 'restore'}" data-id="${p.id}" aria-label="${p.active ? 'Retire' : 'Bring back'} ${p.name}">${p.active ? 'Retire' : 'Bring back'}</button></div></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">No plans yet. Add your first one below; it shows in New client and the parent portal.</div>`);
  }

  const drawMoney = () => Promise.all([
    drawSummary().catch(failSoft($('#bl-sum'), 'the summary', 'sum')),
    drawAttention().catch(failSoft($('#bl-att-list'), 'failed payments', 'att')),
    drawInvoices().catch(failSoft($('#bl-invoices'), 'invoices', 'inv')),
    drawMembers().catch(failSoft($('#bl-members'), 'memberships', 'mem')),
  ]);
  const drawAll = () => Promise.all([drawMoney(), drawPlans().catch(failSoft($('#bl-plan-list'), 'plans', 'plans'))]);

  // ---------------------------------------------------------------- actions
  async function retry(id, { amt, card, who } = {}) {
    if (amt && !(await confirmDialog('Retry this charge?', `Charge ${money(Number(amt))} to ${card} for ${who} now.`, `Charge ${money(Number(amt))}`))) return false;
    try { const r = await api.post(`/invoices/${id}/retry`); toast(r.message || 'Charge went through.'); }
    catch (err) { toastError(err); }
    return true;
  }
  async function remind(id) {
    const r = await api.post(`/invoices/${id}/remind`);
    toast(`Card reminder emailed to ${r.to}${r.invoices > 1 ? ` for ${plural(r.invoices, 'declined charge')}` : ''}.`);
  }
  async function recordPayment(id, amount) {
    const r = await modal({
      title: 'Record payment', body: payFields(amount),
      onMount: (body) => { const s = body.querySelector('#rp-m'); s.onchange = () => { body.querySelector('#rp-cf').hidden = s.value !== 'check'; }; body.querySelector('#rp-c').focus(); },
      actions: [{ label: 'Cancel', value: null }, { label: 'Record payment', kind: 'primary', onClick: async (body) => {
        await api.post(`/invoices/${id}/record-payment`, { method: body.querySelector('#rp-m').value, check_number: body.querySelector('#rp-c').value, paid_on: body.querySelector('#rp-d').value });
        return true;
      } }],
    });
    if (r) toast('Payment recorded. The invoice is marked paid.');
    return !!r;
  }
  async function voidInvoice(d) {
    const failed = d.status === 'failed';
    const ok = await confirmDialog(failed ? `Write off ${d.number}?` : `Void ${d.number}?`,
      failed ? `${money(d.amount_cents)} is forgiven: no more retries, and it stops counting as a failed payment.${d.membership?.status === 'past_due' ? ' If nothing else is unpaid, the membership becomes active again.' : ''}`
        : `It can no longer be paid and stops counting as unpaid.${d.kind === 'school' ? ' It is not sent again for that month. To bill a corrected amount, use Bill something extra on the contract.' : ''}`,
      failed ? 'Write off charge' : 'Void invoice', 'warn');
    if (!ok) return false;
    const r = await api.post(`/invoices/${d.id}/void`);
    toast(failed ? `Charge written off.${r.membership_reactivated ? ' The membership is active again.' : ''}` : 'Invoice voided.');
    return true;
  }
  async function refund(d) {
    const how = d.pay_method === 'cash' ? 'Paid in cash: hand the money back after you record the refund.'
      : d.pay_method === 'check' ? 'Paid by check: send the money back by check after you record the refund.'
        : `It goes back to the ${d.pay_method === 'ach' ? 'bank account' : 'card'} they paid with.`;
    const r = await modal({
      title: `Refund ${d.number}`,
      body: html`<p class="muted" style="margin:0">${whoName(d)} · ${whatText(d)} · paid ${money(d.amount_cents)}${d.refunded_cents ? `, ${money(d.refunded_cents)} already refunded` : ''}</p>
        <div class="form-grid"><div class="field"><label class="label" for="rf-a">Amount to refund ($)</label><input class="input" id="rf-a" inputmode="decimal" value="${(d.refundable_cents / 100).toFixed(2)}"><span class="hint">Up to ${money(d.refundable_cents)}.</span></div>
        <div class="field"><label class="label" for="rf-r">Reason (optional)</label><input class="input" id="rf-r" maxlength="120" placeholder="Moved away, charged twice…"></div></div>
        ${d.email ? html`<label class="check"><input type="checkbox" id="rf-e" checked> Email a refund receipt to ${d.email}</label>` : ''}
        <p class="hint" style="margin:0">${how}${d.sale ? ' This came from a counter sale: a full refund also takes back unused session credits.' : ''}${d.membership && d.membership.status !== 'cancelled' ? ' The membership keeps going; cancel it under Memberships to stop future charges.' : ''}</p>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Refund', kind: 'primary', onClick: async (body) => {
        const e = body.querySelector('#rf-e');
        return api.post(`/invoices/${d.id}/refund`, { amount: body.querySelector('#rf-a').value, reason: body.querySelector('#rf-r').value, email: e ? e.checked : false });
      } }],
    });
    if (r) toast(r.message);
    return !!r;
  }
  async function emailInvoice(d) {
    const r = await api.post(`/invoices/${d.id}/email`);
    toast(`Invoice emailed to ${r.to}.`);
  }

  async function openInvoice(id) {
    let d;
    try { d = await api.get(`/invoices/${id}`); } catch (err) { toastError(err); return; }
    const who = d.athlete_id ? html`<a href="/app/clients/${d.athlete_id}">${whoName(d)}</a>` : d.contract_id ? html`<a href="/app/teams/${d.contract_id}">${whoName(d)}</a>` : whoName(d);
    const paidLine = d.status === 'paid' ? `${fmtDate(d.paid_at)}${d.pay_label ? ` by ${d.pay_label}` : ''}${d.check_number ? ` #${d.check_number}` : ''}` : null;
    const primary = d.can.retry && d.card_last4 ? 'retry' : d.can.record_payment ? 'pay' : null;
    const btn = (act, label, isPrimary) => html`<button class="btn ${isPrimary ? 'btn-primary' : 'btn-ghost'} btn-sm" data-m="${act}">${label}</button>`;
    const act = await modal({
      title: `${d.amount_cents < 0 ? 'Refund' : 'Invoice'} ${d.number}`,
      body: html`<div class="bl-modal stack">
        <div class="spread"><span class="big">${signed(d.amount_cents)}</span>${statusBadge(d)}</div>
        <dl class="kv">
          <dt>${d.contract_id ? 'School' : 'Client'}</dt><dd>${who}${d.family && d.athlete_id ? html` <span class="muted">· ${d.family}</span>` : ''}</dd>
          <dt>For</dt><dd>${whatText(d) || '—'}${d.plan_name && d.description ? html`<div class="small muted">${d.description}</div>` : ''}</dd>
          <dt>Issued</dt><dd>${fmtDate(d.issued_at)}</dd>
          ${d.due_date ? html`<dt>Due</dt><dd class="${d.overdue ? 'warn-text' : ''}">${fmtDate(d.due_date)}${d.overdue ? ` · ${plural(daysLate(d.due_date), 'day')} late` : ''}</dd>` : ''}
          ${paidLine ? html`<dt>${d.amount_cents < 0 ? 'Refunded' : 'Paid'}</dt><dd>${paidLine}</dd>` : ''}
          ${d.status === 'failed' ? html`<dt>Card</dt><dd class="${d.card_last4 ? '' : 'warn-text'}">${cardLabel(d)}${d.card_exp ? ` · expires ${d.card_exp}` : ''}</dd>
            <dt>Retries</dt><dd>${plural(d.attempts, 'attempt')}${d.retries_done ? ' · no more automatic retries' : d.next_retry ? ` · next ${fmtDate(d.next_retry)}` : ''}</dd>
            ${d.last_reminder ? html`<dt>Reminder</dt><dd>Card reminder sent ${d.last_reminder === localISO() ? 'today' : fmtDate(d.last_reminder)}</dd>` : ''}` : ''}
          ${d.membership ? html`<dt>Membership</dt><dd>${d.membership.plan_name} · ${badge(d.membership.status)}</dd>` : ''}
          ${d.refund_of ? html`<dt>Refund of</dt><dd><button class="linkish" data-m="goto" data-id="${d.refund_of}">${d.refund_of_number}</button></dd>` : ''}
          ${d.email ? html`<dt>Billing email</dt><dd>${d.email}</dd>` : ''}
        </dl>
        ${d.refunds.length ? html`<div class="refunds"><div class="label">Refunds</div>${d.refunds.map((r) => html`<div class="spread"><span>${r.number} · ${fmtDate(r.paid_at)}</span><span>${signed(r.amount_cents)}</span></div>`)}</div>` : ''}
        <div class="acts" ${Object.values(d.can).some(Boolean) || (d.view_token && d.amount_cents > 0) ? '' : 'hidden'}>
          ${d.can.retry && d.card_last4 ? btn('retry', `Retry ${money(d.amount_cents)}`, primary === 'retry') : ''}
          ${d.can.record_payment ? btn('pay', 'Record payment', primary === 'pay') : ''}
          ${d.can.remind ? btn('remind', 'Email card reminder') : ''}
          ${d.can.refund ? btn('refund', d.refunded_cents ? 'Refund more' : 'Refund') : ''}
          ${d.can.email ? btn('email', d.status === 'paid' ? 'Email a copy' : 'Email invoice') : ''}
          ${d.view_token && d.amount_cents > 0 ? html`<a class="btn btn-ghost btn-sm" href="/invoice/${d.view_token}" target="_blank" rel="noopener">View or print</a>` : ''}
          ${d.can.void ? btn('void', d.status === 'failed' ? 'Write off' : 'Void') : ''}
        </div></div>`,
      onMount: (body, close) => body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-m]');
        if (b) close({ act: b.dataset.m, id: b.dataset.id });
      }),
    });
    if (!act) return;
    let changed = false;
    try {
      if (act.act === 'goto') return openInvoice(act.id);
      if (act.act === 'retry') changed = await retry(d.id);
      else if (act.act === 'pay') changed = await recordPayment(d.id, d.amount_cents);
      else if (act.act === 'remind') { await remind(d.id); changed = true; }
      else if (act.act === 'refund') changed = await refund(d);
      else if (act.act === 'email') await emailInvoice(d);
      else if (act.act === 'void') changed = await voidInvoice(d);
    } catch (err) { toastError(err); }
    if (changed) await drawMoney();
  }

  async function manageMembership(m) {
    const choices = plans.filter((p) => p.active && p.id !== m.plan_id);
    const act = await modal({
      title: `${m.first_name} ${m.last_name}`,
      body: html`<div class="bl-modal stack">
        <dl class="kv"><dt>Plan</dt><dd>${m.plan_name} · ${money(m.price_cents)} / mo</dd><dt>Status</dt><dd>${badge(m.status)}</dd>
          <dt>Next</dt><dd>${memNext(m)}</dd><dt>Card</dt><dd class="${m.card_last4 ? '' : 'warn-text'}">${cardLabel(m)}</dd><dt>Member since</dt><dd>${fmtDate(m.started_at)}</dd></dl>
        ${choices.length ? html`<div class="field"><label class="label" for="mm-p">Move to another plan</label>
          <div class="row" style="display:flex;gap:var(--space-2);flex-wrap:wrap"><select class="input" id="mm-p" style="flex:1 1 200px">${choices.map((p) => html`<option value="${p.id}">${p.name} · ${money(p.price_cents)} / mo</option>`)}</select>
          <button class="btn btn-sm" data-m="change">Change plan</button></div><span class="hint">The new price applies from the next charge. Nobody is charged now.</span></div>` : ''}
        <div class="acts">
          ${['active', 'trial'].includes(m.status) ? html`<button class="btn btn-ghost btn-sm" data-m="pause">Pause</button>` : ''}
          ${m.status === 'paused' ? html`<button class="btn btn-outline btn-sm" data-m="resume">Resume</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-m="cancel">Cancel membership</button>
          <a class="btn btn-ghost btn-sm" href="/app/clients/${m.athlete_id}">Open profile</a></div></div>`,
      onMount: (body, close) => body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-m]');
        if (b) close({ act: b.dataset.m, plan_id: body.querySelector('#mm-p')?.value });
      }),
    });
    if (!act) return;
    const who = `${m.first_name}'s`;
    try {
      if (act.act === 'cancel') {
        if (!(await confirmDialog(`Cancel ${who} membership?`, `No more charges for ${m.plan_name}.${m.status === 'past_due' ? ' Declined charges stop retrying; write them off or collect them in Invoices.' : ''} You can start a new membership later.`, 'Cancel membership', 'warn'))) return;
        await api.post(`/memberships/${m.id}/cancel`); toast(`${who} membership is cancelled.`);
      } else if (act.act === 'pause') {
        if (!(await confirmDialog(`Pause ${who} membership?`, 'No charges while paused. When you resume, billing picks up from the next charge date, or today if that has passed.', 'Pause membership'))) return;
        await api.post(`/memberships/${m.id}/pause`); toast(`${who} membership is paused.`);
      } else if (act.act === 'resume') {
        await api.post(`/memberships/${m.id}/resume`); toast(`${who} membership is active again.`);
      } else if (act.act === 'change') {
        await api.post(`/memberships/${m.id}/change`, { plan_id: Number(act.plan_id) });
        toast(`${who} plan changes from the next charge.`);
      }
      await Promise.all([drawMoney(), drawPlans()]);
    } catch (err) { toastError(err); }
  }

  // ---------------------------------------------------------------- events
  $('#bl-q').addEventListener('input', debounce((e) => { inv.q = e.target.value.trim(); inv.limit = 50; drawInvoices().catch(toastError); }, 250));
  $('#bl-kind').addEventListener('change', (e) => { inv.kind = e.target.value; inv.limit = 50; syncUrl(); drawInvoices().catch(toastError); });
  $('#bl-period').addEventListener('change', (e) => { inv.period = e.target.value; inv.limit = 50; syncUrl(); drawInvoices().catch(toastError); });
  $('#bl-mq').addEventListener('input', debounce((e) => { mem.q = e.target.value.trim(); drawMembers().catch(toastError); }, 250));
  $('#bl-mplan').addEventListener('change', (e) => { mem.plan = e.target.value; drawMembers().catch(toastError); });

  root.addEventListener('click', async (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) { ctx.el.querySelector('#' + jump.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const metric = e.target.closest('[data-metric]');
    if (metric) {
      if (metric.dataset.metric === 'collected') { inv.view = 'paid'; inv.period = 'month'; } else { inv.view = 'unpaid'; inv.period = ''; }
      inv.kind = ''; inv.limit = 50; $('#bl-kind').value = ''; $('#bl-period').value = inv.period;
      syncUrl(); drawViews(); drawInvoices().catch(toastError);
      $('#bl-inv').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const view = e.target.closest('[data-view]');
    if (view) { inv.view = view.dataset.view; inv.limit = 50; syncUrl(); drawViews(); drawInvoices().catch(toastError); return; }
    const mview = e.target.closest('[data-mview]');
    if (mview) { mem.view = mview.dataset.mview; drawMembers().catch(toastError); return; }
    const b = e.target.closest('[data-act]');
    const row = !b && !e.target.closest('a') && e.target.closest('tr[data-open]');
    if (row) { openInvoice(row.dataset.open); return; }
    if (!b) return;
    const act = b.dataset.act;
    if (act.startsWith('reload-')) { drawAll(); return; }
    if (act === 'open') { openInvoice(b.dataset.id); return; }
    if (act === 'more') { inv.limit += 200; b.disabled = true; drawInvoices().catch(toastError); return; }
    if (act === 'manage') { const m = ($('#bl-members')._rows || []).find((x) => String(x.id) === b.dataset.id); if (m) manageMembership(m); return; }
    if (act === 'plan-members') {
      mem.plan = b.dataset.id; mem.view = 'live'; $('#bl-mplan').value = mem.plan;
      await drawMembers().catch(toastError);
      $('#bl-mem').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const p = plans.find((x) => String(x.id) === b.dataset.id);
    b.disabled = true;
    try {
      if (act === 'retry') { if (await retry(b.dataset.id, { amt: b.dataset.amt, card: b.dataset.card, who: b.dataset.who })) await drawMoney(); }
      else if (act === 'remind') { await remind(b.dataset.id); await drawAttention(); }
      else if (act === 'pay') { if (await recordPayment(b.dataset.id, Number(b.dataset.amt))) await drawMoney(); }
      else if (act === 'retry-all') {
        const n = (await api.get('/invoices?status=failed&limit=100')).filter((i) => i.card_last4).length;
        if (!(await confirmDialog('Retry declined charges?', `Charge the card on file again for ${plural(n, 'declined charge')} now. Families without a card are skipped.`, 'Retry charges'))) return;
        const r = await api.post('/billing/retry-declined');
        toast(r.paid ? `${plural(r.paid, 'charge')} went through (${money(r.paid_cents)}).${r.declined ? ` ${r.declined} declined again.` : ''}` : `All ${plural(r.tried, 'charge')} declined again. Send card reminders.`, r.paid ? 'good' : 'warn');
        await drawMoney();
      } else if (act === 'remind-all') {
        if (!(await confirmDialog('Email card reminders?', 'Each family with a declined charge gets one email listing what is due, with a link to update their card. Families already reminded today are skipped.', 'Email families'))) return;
        const r = await api.post('/billing/remind-declined');
        toast(r.sent ? `Card reminders emailed to ${plural(r.sent, 'family', 'families')}.${r.skipped ? ` ${r.skipped} already reminded today.` : ''}${r.no_email ? ` ${r.no_email} with no email address.` : ''}`
          : r.skipped ? 'Every family was already reminded today.' : 'No family has an email address to remind.', r.sent ? 'good' : 'warn');
        await drawAttention();
      } else if (act === 'retire') {
        if (!(await confirmDialog(`Retire ${p.name}?`, `No one new can join it. ${plural(p.subscribers, 'current member')} keep${p.subscribers === 1 ? 's' : ''} it until you change their plan.`, 'Retire plan', 'warn'))) return;
        await api.put(`/plans/${p.id}`, { active: false }); toast('Plan retired.'); await drawPlans();
      } else if (act === 'restore') {
        await api.put(`/plans/${p.id}`, { active: true }); toast('Plan is available again.'); await drawPlans();
      } else if (act === 'edit') {
        const r = await modal({
          title: `Edit ${p.name}`,
          body: html`<form class="plan-form" id="pl-edit" onsubmit="return false">${planFields(p, 'pe')}</form>
            <p class="hint" style="margin:0">${p.subscribers ? `A new price applies to all ${plural(p.subscribers, 'member')} from their next charge. Nobody is charged now.` : 'No one is on this plan yet.'}</p>`,
          actions: [{ label: 'Cancel', value: null }, { label: 'Save plan', kind: 'primary', onClick: async (body) => api.put(`/plans/${p.id}`, formData(body.querySelector('#pl-edit'))) }],
        });
        if (!r) return;
        toast(r.members_repriced ? `Plan saved. ${plural(r.members_repriced, 'member')} move${r.members_repriced === 1 ? 's' : ''} to the new price at their next charge.` : 'Plan saved.');
        await Promise.all([drawPlans(), drawMoney()]);
      }
    } catch (err) { toastError(err); }
    finally { if (b.isConnected) b.disabled = false; }
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      if (f.id === 'pl-new') {
        await api.post('/plans', formData(f));
        f.reset(); toast('Plan created. It shows in New client and the parent portal.'); await drawPlans();
      } else if (f.id === 'clock') {
        const r = await api.post('/billing/run', formData(f));
        const line = `Billing ran as of ${fmtDate(f.as_of.value)}: ${r.charged} charged, ${r.declined} declined, ${r.recovered} recovered on retry, ${plural(r.school_invoices, 'school invoice')}, ${plural(r.reminders, 'reminder')}.`;
        mount($('#bl-clock-out'), html`<div class="clock-result">${line}</div>`);
        toast(line);
        await drawMoney();
      }
    } catch (err) { toastError(err); }
    finally { btn.disabled = false; }
  });

  await drawAll();
}

export const routes = [{ path: '/billing', nav: 'billing', title: 'Billing', roles: ['owner'], render }];
