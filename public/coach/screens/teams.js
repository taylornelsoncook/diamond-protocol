// Teams: school and club contracts, one contract's invoices/terms/roster/sessions, and New team contract. Owner only.
import { html, raw, mount, api, money, fmtDate, relTime, badge, icon, toast, toastError, modal, confirmDialog, formData, options, localISO, plural, debounce } from '/js/ui.js';
import { assignDialog } from './education.js';

const STYLE = html`<style>
.tm .tm-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md)}
.tm .tm-metrics .metric{border:0;border-radius:0;background:transparent;padding:var(--space-4) var(--space-6)}
.tm .tm-metrics .metric+.metric{border-left:1px solid var(--line)}
@media (max-width:900px){.tm .tm-metrics{grid-template-columns:1fr 1fr}.tm .tm-metrics .metric:nth-child(3){border-left:0}.tm .tm-metrics .metric:nth-child(n+3){border-top:1px solid var(--line)}}
@media (max-width:420px){.tm .tm-metrics .metric{padding:var(--space-3) var(--space-4)}}
.tm .list-row{padding:14px 0;flex-wrap:wrap}
.tm .row-title{font-weight:600;color:var(--steel);text-decoration:none}
.tm a.row-title:hover{color:var(--green-soft)}
.tm .row-sub{font-size:13px;color:var(--steel-muted)}
.tm .inv-actions{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end}
.tm .inv-amt{font-weight:600;min-width:64px;text-align:right}
.tm .cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);align-items:start}
@media (max-width:1000px){.tm .cols{grid-template-columns:1fr}}
.tm .col{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}
.tm .grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3)}
.tm .grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3)}
.tm .grid2{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:var(--space-3)}
@media (max-width:600px){.tm .grid4,.tm .grid3{grid-template-columns:1fr 1fr}.tm .grid3>.field:first-child{grid-column:1/-1}}
.tm .days{display:flex;gap:6px 14px;flex-wrap:wrap}
.tm .days .check{min-height:44px;align-items:center;font-size:14px}
.tm details summary{cursor:pointer;font-size:14px;min-height:44px;display:flex;align-items:center;gap:8px;list-style:none}.tm details summary::-webkit-details-marker{display:none}.tm details summary::before{content:'';width:0;height:0;border:5px solid transparent;border-left:7px solid currentColor;border-right:0}.tm details[open] summary::before{transform:rotate(90deg)}
.tm .tm-new{max-width:760px}
@media (max-width:600px){.tm .inv-actions{justify-content:flex-start;width:100%}.tm .inv-amt{min-width:0;text-align:left}}
.tm .tm-eng-h{font:500 14px/20px var(--font-sans);color:var(--steel-muted);margin:4px 0 -4px}
.tm .tm-add-row{display:grid;grid-template-columns:minmax(0,1.4fr) 88px;gap:var(--space-2)}
.tm .tm-msg{white-space:pre-line;overflow-wrap:anywhere}
.tm .tm-add{border-top:1px solid var(--line-subtle);padding-top:var(--space-3);display:flex;flex-direction:column;gap:var(--space-2)}
.tm .tm-tools{display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center}
.tm .tm-tools .input{width:auto;flex:1 1 180px}
.tm .tm-tools select.input{flex:0 1 190px}
.tm .tm-views{display:flex;gap:6px;flex-wrap:wrap}
.tm .tm-view{min-height:44px;padding:0 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm);background:var(--surface);color:var(--steel-muted);font:600 14px/1 var(--font-sans);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.tm .tm-view:hover{color:var(--steel);background:var(--surface-raised)}
.tm .tm-view[aria-pressed="true"]{background:var(--surface-raised);border-color:var(--green-mid);color:var(--steel)}
.tm .tm-view .n{font-weight:500;color:var(--steel-muted)}
.tm .tm-jump{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;position:sticky;top:0;z-index:5;background:var(--ground);border-bottom:1px solid var(--line);margin-top:calc(-1 * var(--space-2))}
.tm .tm-jump button{flex:0 0 auto;min-height:44px;padding:0 14px;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--steel-muted);font:600 14px/1 var(--font-sans);cursor:pointer;white-space:nowrap}
.tm .tm-jump button:hover{color:var(--steel);border-bottom-color:var(--line)}
.tm section[id]{scroll-margin-top:60px}
@media (max-width:900px){.tm .tm-jump{top:57px;margin-left:-16px;margin-right:-16px;padding:0 8px}.tm section[id]{scroll-margin-top:112px}}
.tm .tm-summary{padding:var(--space-3) var(--space-4);border:1px solid var(--line);border-left:3px solid var(--green-mid);border-radius:var(--radius-md);background:var(--surface-raised);font-size:14px}
.tm .tm-dots{display:flex;gap:4px;align-items:flex-end;height:28px}
.tm .tm-dots span{flex:0 0 10px;background:var(--green-mid);border-radius:2px 2px 0 0;min-height:2px}
.tm .tm-dots span.low{background:var(--amber)}
.tm .unsaved{font-size:13px;color:var(--amber)}
@media (pointer:coarse){.tm .btn-sm,.tm-modal .btn-sm{min-height:44px}}
.tm-modal .tm-pick{display:flex;flex-direction:column;gap:2px;max-height:50vh;overflow:auto}
.tm-modal .tm-pick .check{min-height:44px;align-items:center;justify-content:space-between;gap:12px;padding:0 4px;border-bottom:1px solid var(--line-subtle)}
.tm-modal .tm-pick .check span{flex:1}
.tm-modal .tm-line{padding:10px 0;border-bottom:1px solid var(--line-subtle);display:flex;flex-direction:column;gap:6px}
.tm-modal .tm-res{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;border-bottom:1px solid var(--line-subtle)}
</style>`;

const GOAL_KINDS = [{ id: 'workouts', name: 'Workouts' }, { id: 'sessions', name: 'Sessions attended' }, { id: 'checkins', name: 'Daily check-ins' }, { id: 'custom', name: 'Custom' }];
const KIND_LABEL = Object.fromEntries(GOAL_KINDS.map((k) => [k.id, k.name]));
const SCHOOL_KINDS = [{ id: 'school', name: 'School' }, { id: 'club', name: 'Club' }];

// Team goals, team messages and assigned reading. Every athlete on the roster sees them in their app.
function accountabilityPanel(ctx, eng, manage) {
  if (!eng) return '';
  return html`<section class="panel" id="tm-acc">
    <div class="panel-head"><div><h2 class="panel-title">Team accountability</h2><p class="panel-sub">Goals and messages go to everyone on the roster, in their app. Athletes and parents are emailed messages.</p></div>
      ${manage ? html`<button class="btn btn-sm" data-act="assign-lesson">Assign lesson to team</button>` : ''}</div>
    <div class="tm-eng-h">Team goals</div>
    ${eng.goals.length ? html`<div class="list">${eng.goals.map((g) => html`<div class="list-row">
      <div class="grow"><div class="row-title">${g.title}</div><div class="row-sub">${KIND_LABEL[g.kind] || g.kind} · ${g.target} a week, per athlete</div></div>
      ${manage ? html`<button class="btn btn-ghost btn-sm" data-act="goal-end" data-id="${g.id}" data-title="${g.title}">End</button>` : ''}</div>`)}</div>`
      : html`<p class="panel-sub">No team goals.</p>`}
    ${manage ? html`<form class="tm-add" id="tg" novalidate>
      <div class="tm-add-row"><div class="field"><label class="label small" for="tg-k">What it counts</label><select class="input" id="tg-k" name="kind">${options(GOAL_KINDS, 'sessions')}</select></div>
        <div class="field"><label class="label small" for="tg-t">Per week</label><input class="input" id="tg-t" name="target" type="number" min="1" max="14" value="2" inputmode="numeric"></div></div>
      <div class="field"><label class="label small" for="tg-n">Goal</label><input class="input" id="tg-n" name="title" maxlength="120" placeholder="Like Make 2 team sessions this week"></div>
      <div><button class="btn">Add team goal</button></div></form>` : ''}
    <div class="tm-eng-h" style="margin-top:8px">Team messages</div>
    ${manage ? html`<form class="stack-sm" id="tmsg" novalidate>
      <label class="sr-only" for="tmsg-b">Message to the team</label>
      <textarea class="input" id="tmsg-b" name="body" rows="3" maxlength="2000" style="min-height:80px" placeholder="Write to the whole team"></textarea>
      <div class="spread"><span class="hint">Every athlete on the roster and their parents are emailed a copy.</span><button class="btn">Send to team</button></div></form>` : ''}
    ${eng.messages.length ? html`<div class="list">${eng.messages.map((m) => html`<div class="list-row"><div class="grow"><div class="tm-msg">${m.body}</div>
      <div class="row-sub">${m.coach || 'Coach'} · ${relTime(m.created_at)}</div></div></div>`)}</div>` : html`<p class="panel-sub">No team messages yet.</p>`}
    ${eng.assigned.length ? html`<div class="tm-eng-h" style="margin-top:8px">Assigned reading</div>
      <div class="list">${eng.assigned.map((x) => {
        const late = x.due_date && x.due_date < localISO() && x.finished < x.total;
        return html`<div class="list-row"><div class="grow"><div class="row-title">${x.title}</div>
          <div class="row-sub">${x.type === 'course' ? 'Course' : 'Lesson'} · ${x.due_date ? html`<span class="${late ? 'warn-text' : ''}">${late ? 'overdue, was due' : 'due'} ${fmtDate(x.due_date)}</span>` : 'no due date'}</div></div>
          <span class="small ${late ? 'warn-text' : x.finished === x.total ? 'good-text' : 'muted'}">${x.finished} of ${x.total} finished</span></div>`;
      })}</div><a class="small" href="/app/education">All assignments</a>` : ''}
  </section>`;
}

const TERMS = [{ id: 0, name: 'Due on receipt' }, { id: 15, name: 'Net 15' }, { id: 30, name: 'Net 30' }, { id: 45, name: 'Net 45' }, { id: 60, name: 'Net 60' }];
const termsName = (d) => (d === 0 ? 'Due on receipt' : `Net ${d}`);
const METHOD = { check: 'check', ach: 'bank transfer', card: 'card', cash: 'cash', other: 'other' };
const METHODS = [{ id: 'check', name: 'Check' }, { id: 'ach', name: 'Bank transfer' }, { id: 'card', name: 'Card' }, { id: 'cash', name: 'Cash' }, { id: 'other', name: 'Other' }];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dollars = (c) => (c / 100).toFixed(2);
const pct = (r) => `${Math.round(r * 100)}%`;
// "15:30" -> "3:30 PM"
function hm12(t) {
  const [h, m] = String(t || '').split(':').map(Number);
  if (!Number.isFinite(h)) return t || '';
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
// Same month arithmetic as the server: billing day = start day, clamped to the end of shorter months.
function addMonths(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(y, m - 1 + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return localISO(new Date(t.getFullYear(), t.getMonth(), Math.min(day, last)));
}
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;

// Cells a spreadsheet would run as a formula get a leading apostrophe.
function csvCell(v) { let s = String(v ?? ''); if (/^[=@\t\r]/.test(s) || /^[+-](?![\d\s().-]*$)/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function downloadCsv(name, rows) {
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// A toast with an Undo button for a few seconds.
function undoToast(msg, fn) {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast';
  mount(t, html`${msg} <button type="button" class="btn btn-ghost btn-sm" style="margin-left:8px;color:inherit;text-decoration:underline">Undo</button>`);
  t.querySelector('button').addEventListener('click', () => { t.remove(); fn(); });
  box.append(t);
  setTimeout(() => t.remove(), 7000);
}
// Point at the field a server error names (err.data.field), or show the message in a toast.
function showFieldError(form, err, box) {
  form.querySelectorAll('[aria-invalid="true"]').forEach((x) => x.removeAttribute('aria-invalid'));
  const el = err?.data?.field && form.querySelector(`[name="${err.data.field}"]`);
  if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
  if (box) box.textContent = err.message; else toastError(err);
}

function invoiceSub(i, withNumber) {
  const num = withNumber ? `${i.number} · ` : '';
  if (i.status === 'paid') return `${num}Paid ${fmtDate(i.paid_at)} by ${METHOD[i.pay_method] || i.pay_method || 'payment'}${i.check_number ? ` #${i.check_number}` : ''}`;
  if (i.status === 'void') return `${num}Voided · ${i.description || ''}`;
  const late = i.overdue ? Math.round((new Date(localISO() + 'T12:00:00') - new Date(i.due_date + 'T12:00:00')) / 86400000) : 0;
  const bits = [i.period ? `${fmtDate(i.period)} – ${fmtDate(i.period_end)}` : i.description,
    i.due_date ? (late ? `${plural(late, 'day')} past due` : `due ${fmtDate(i.due_date)}`) : null, i.emailed_at ? `emailed ${relTime(i.emailed_at)}` : 'not emailed yet'];
  return num + bits.filter(Boolean).join(' · ');
}
function invoiceRow(i, title, { link, withNumber } = {}) {
  const open = i.status === 'open';
  return html`<div class="list-row">
    <div class="grow">${link ? html`<a class="row-title" href="${link}">${title}</a>` : html`<div class="row-title">${title}</div>`}<div class="row-sub ${i.overdue ? 'warn-text' : ''}">${invoiceSub(i, withNumber)}</div></div>
    <div class="inv-actions"><span class="inv-amt">${money(i.amount_cents)}</span>${i.overdue ? badge('overdue') : badge(i.status)}
      <a class="btn btn-ghost btn-sm" href="/invoice/${i.view_token}" target="_blank" rel="noopener" aria-label="View ${i.number} as the school sees it">View</a>
      ${open ? html`<button class="btn btn-outline btn-sm" data-inv="pay" data-id="${i.id}" data-num="${i.number}" data-amt="${i.amount_cents}">Record payment</button>
        <button class="btn btn-ghost btn-sm" data-inv="email" data-id="${i.id}" aria-label="Email ${i.number} again">Email</button>
        <button class="btn btn-ghost btn-sm" data-inv="void" data-id="${i.id}" data-num="${i.number}" aria-label="Void ${i.number}">Void</button>` : ''}</div></div>`;
}

// The How they paid / Check number / Received fields, shared by one invoice and several.
const payFields = () => html`<div class="form-grid">
  <div class="field"><label class="label" for="rp-m">How they paid</label><select class="input" id="rp-m">${options(METHODS, 'check')}</select></div>
  <div class="field" id="rp-cf"><label class="label" for="rp-c">Check number</label><input class="input" id="rp-c" inputmode="numeric" autocomplete="off" maxlength="30"></div>
  <div class="field"><label class="label" for="rp-d">Received</label><input class="input" id="rp-d" type="date" value="${localISO()}" max="${localISO()}"></div></div>`;
function wirePayFields(body) {
  const s = body.querySelector('#rp-m');
  s.onchange = () => { body.querySelector('#rp-cf').hidden = s.value !== 'check'; };
  body.querySelector('#rp-c').focus();
}
const payValues = (body) => ({ method: body.querySelector('#rp-m').value, check_number: body.querySelector('#rp-c').value, paid_on: body.querySelector('#rp-d').value });

// Shared invoice actions (Record payment, Email, Void) for the Teams list and a contract.
async function invoiceAction(btn, redraw) {
  const id = btn.dataset.id;
  try {
    if (btn.dataset.inv === 'email') {
      btn.disabled = true;
      const r = await api.post(`/invoices/${id}/email`);
      toast(`Invoice emailed to ${r.to}.`);
    } else if (btn.dataset.inv === 'void') {
      if (!(await confirmDialog(`Void ${btn.dataset.num}?`, 'The school can no longer pay it, and it stops counting as unpaid. It is not sent again for that month. To bill a corrected amount, use Bill something extra on the contract.', 'Void invoice', 'warn'))) return;
      await api.post(`/invoices/${id}/void`);
      toast('Invoice voided.');
    } else if (btn.dataset.inv === 'pay') {
      const r = await modal({
        title: 'Record payment',
        body: html`<p class="muted" style="margin:0">${btn.dataset.num} · ${money(Number(btn.dataset.amt))}</p>${payFields()}`,
        onMount: wirePayFields,
        actions: [{ label: 'Cancel', value: null }, { label: 'Record payment', kind: 'primary', onClick: async (body) => {
          await api.post(`/invoices/${id}/record-payment`, payValues(body));
          return true;
        } }],
      });
      if (!r) return;
      toast('Payment recorded. The invoice is marked paid.');
    }
    await redraw();
  } catch (e) { toastError(e); }
  finally { if (btn.isConnected) btn.disabled = false; }
}

// ---------------------------------------------------------------- list
async function renderList(ctx) {
  const state = { view: 'active', q: '' };
  let d;
  async function load() { d = await api.get('/teams'); }
  function contractsHtml() {
    const q = state.q.trim().toLowerCase();
    const list = d.contracts.filter((c) => (state.view === 'all' || c.status === state.view) && (!q || `${c.school_name} ${c.team_name} ${c.po_number || ''}`.toLowerCase().includes(q)));
    if (!d.contracts.length) return html`<div class="empty">No contracts yet. Schools and clubs pay a flat monthly fee; invoices go out on their own. <a href="/app/teams/new">Add a school or club</a>.</div>`;
    if (!list.length) return html`<p class="panel-sub">${q ? `No ${state.view === 'all' ? '' : `${state.view} `}contracts match "${state.q.trim()}".` : state.view === 'ended' ? 'No ended contracts.' : 'No active contracts.'}</p>`;
    return html`<div class="list">${list.map((c) => html`<div class="list-row">
      <div class="grow"><a class="row-title" href="/app/teams/${c.id}">${c.school_name} · ${c.team_name}</a>
        <div class="row-sub">${money(c.monthly_cents)}/month · ${termsName(c.terms_days)} · ${plural(c.athletes, 'athlete')}${c.attendance_rate != null ? ` · ${pct(c.attendance_rate)} attendance` : ''} · ${c.status === 'ended' ? `ended ${fmtDate(c.end_date)}` : c.next_invoice ? `next invoice ${fmtDate(c.next_invoice)}` : 'no more invoices'}${c.has_billing_email ? '' : raw(' · <span class="warn-text">add a billing email</span>')}</div></div>
      ${c.overdue_cents ? badge('overdue', `${money(c.overdue_cents)} overdue`) : c.open_cents ? badge('open', `${money(c.open_cents)} open`) : c.status === 'ended' ? badge('ended') : ''}</div>`)}</div>`;
  }
  function drawContracts() {
    const box = ctx.el.querySelector('#tm-contracts');
    if (box) mount(box, contractsHtml());
    ctx.el.querySelectorAll('.tm-view').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  }
  function draw() {
    if (!ctx.isCurrent()) return;
    const m = d.metrics;
    const n = (st) => d.contracts.filter((c) => st === 'all' || c.status === st).length;
    mount(ctx.el, html`${STYLE}<div class="stack tm">
      <div class="page-header"><div><h1 class="page-title">Teams</h1><p class="page-sub">School and club contracts, billed a flat monthly fee.</p></div>
        <a class="btn btn-primary" href="/app/teams/new">New team contract</a></div>
      <div class="tm-metrics">
        <div class="metric"><span class="metric-label">Monthly contract revenue</span><span class="metric-value">${money(m.monthly_cents)}</span><span class="metric-note">${plural(m.active_teams, 'active team')}</span></div>
        <div class="metric"><span class="metric-label">Waiting on payment</span><span class="metric-value">${money(m.waiting_cents)}</span><span class="metric-note">${plural(m.waiting_count, 'open invoice')}</span></div>
        <div class="metric"><span class="metric-label">Overdue</span><span class="metric-value ${m.overdue_cents ? 'warn' : ''}">${money(m.overdue_cents)}</span><span class="metric-note">${m.overdue_count} past due</span></div>
        <div class="metric"><span class="metric-label">Athletes on rosters</span><span class="metric-value">${m.athletes}</span><span class="metric-note">Across active teams</span></div>
      </div>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Contracts</h2>
          ${d.contracts.length > 1 ? html`<div class="tm-views" role="group" aria-label="Show">${[['active', 'Active'], ['ended', 'Ended'], ['all', 'All']].map(([id, label]) =>
            html`<button type="button" class="tm-view" data-view="${id}" aria-pressed="${String(state.view === id)}">${label} <span class="n">${n(id)}</span></button>`)}</div>` : ''}</div>
        ${d.contracts.length > 4 ? html`<div class="tm-tools"><label class="sr-only" for="tm-q">Search contracts</label>
          <input class="input" id="tm-q" type="search" placeholder="School, team or PO number" value="${state.q}" autocomplete="off"></div>` : ''}
        <div id="tm-contracts" aria-live="polite">${contractsHtml()}</div>
      </section>
      <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Unpaid invoices</h2>
        <p class="panel-sub">Invoices email the school's billing contact with a link to view, print or pay online. Overdue ones get a reminder each week.${m.collected_30_cents ? ` ${money(m.collected_30_cents)} collected in the last 30 days.` : ''}</p></div>
        ${m.overdue_count ? html`<button class="btn btn-sm" data-act="remind">Email overdue reminders (${m.overdue_count})</button>` : ''}</div>
        ${d.unpaid.length ? html`<div class="list">${d.unpaid.map((i) => invoiceRow(i, `${i.school_name} · ${i.team_name}`, { link: `/app/teams/${i.contract_id}`, withNumber: true }))}</div>` : html`<p class="panel-sub">Nothing unpaid. Every school invoice is settled.</p>`}
      </section></div>`);
    const root = ctx.el.querySelector('.tm');
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-inv]'); if (b) return invoiceAction(b, refresh);
      const v = e.target.closest('.tm-view'); if (v) { state.view = v.dataset.view; return drawContracts(); }
      const r = e.target.closest('[data-act="remind"]');
      if (r) {
        if (!(await confirmDialog('Email overdue reminders now?', `Each school with an overdue invoice gets a reminder with the link to pay. ${plural(m.overdue_count, 'invoice is', 'invoices are')} overdue. The weekly reminder then waits another week.`, 'Email reminders'))) return;
        r.disabled = true;
        try { const x = await api.post('/teams/remind-overdue'); toast(`${plural(x.sent, 'reminder')} emailed${x.skipped ? `. ${x.skipped} had no billing email` : ''}.`, x.skipped ? 'warn' : 'good'); await refresh(); }
        catch (err) { toastError(err); } finally { if (r.isConnected) r.disabled = false; }
      }
    });
    root.querySelector('#tm-q')?.addEventListener('input', debounce((e) => { state.q = e.target.value; drawContracts(); }, 150));
  }
  async function refresh() { await load(); draw(); }
  await load();
  if (!d.contracts.some((c) => c.status === 'active') && d.contracts.length) state.view = 'all';
  draw();
}

// ---------------------------------------------------------------- contract
async function renderTeam(ctx) {
  const id = ctx.params.id;
  const ui = { allInvoices: false, q: '', sort: 'name', pasteOpen: false, ctDraft: null };
  async function draw() {
    let d, eng, edu;
    try {
      [d, eng, edu] = await Promise.all([api.get(`/teams/${id}`), api.get(`/teams/${id}/engage`, { noRedirect: true }).catch(() => null), api.get('/education', { noRedirect: true }).catch(() => null)]);
    } catch (e) {
      if (e.status !== 404) throw e;
      if (!ctx.isCurrent()) return;
      mount(ctx.el, html`<div class="empty">That contract wasn't found. It may have been removed. <a href="/app/teams">Back to Teams</a>.</div>`);
      return;
    }
    if (eng) eng.assigned = (edu?.assignments || []).filter((x) => x.team_id === Number(id));
    if (!ctx.isCurrent()) return;
    const c = d.contract;
    const manage = ctx.me.role === 'owner' || ctx.me.role === 'coach';
    const ended = c.status === 'ended';
    const open = d.invoices.filter((i) => i.status === 'open');
    const shownInvoices = ui.allInvoices ? d.invoices : d.invoices.slice(0, 6);
    const last = d.recent_sessions[0];
    const jumps = [['tm-inv', 'Invoices'], ['tm-roster', 'Roster'], ['tm-sessions', 'Team sessions'], ['tm-contract', 'Contract'], ...(eng ? [['tm-acc', 'Accountability']] : [])];
    mount(ctx.el, html`${STYLE}<div class="stack tm">
      <div class="page-header"><div><h1 class="page-title">${c.school_name}</h1><p class="page-sub">${c.team_name} · ${money(c.monthly_cents)}/month${c.school_kind === 'club' ? ' · club' : ''}${ended ? ` · ended ${fmtDate(c.end_date)}` : ''}</p></div>
        <a class="btn" href="/app/teams">All teams</a></div>
      ${ended ? html`<div class="banner"><span>This contract ended ${fmtDate(c.end_date)}. No invoices go out. To restart it, clear the end date or move it later and save. Billing picks up on the next billing day; months it was ended aren't billed.</span></div>` : ''}
      <nav class="tm-jump no-print" aria-label="Sections">${jumps.map(([t, label]) => html`<button type="button" data-jump="${t}">${label}</button>`)}</nav>
      <section class="panel" id="tm-inv"><div class="panel-head"><div><h2 class="panel-title">Invoices</h2>
        <p class="panel-sub">${d.unpaid_cents ? `${money(d.unpaid_cents)} unpaid` : 'Nothing unpaid'}${d.paid_cents ? ` · ${money(d.paid_cents)} paid to date` : ''}${c.next_invoice ? ` · next invoice ${fmtDate(c.next_invoice)}` : ''}</p></div>
          <div class="btn-row">${open.length > 1 ? html`<button class="btn btn-sm" data-act="pay-many">Record one payment for several</button>` : ''}
            ${open.length ? html`<button class="btn btn-sm" data-act="statement">Email statement</button>` : ''}</div></div>
        ${d.invoices.length ? html`<div class="list">${shownInvoices.map((i) => invoiceRow(i, i.number))}</div>
          ${d.invoices.length > 6 ? html`<button class="btn btn-ghost btn-sm" data-act="more-inv">${ui.allInvoices ? 'Show the latest 6' : `Show all ${d.invoices.length} invoices`}</button>` : ''}`
          : html`<p class="panel-sub">No invoices yet. The first goes out on ${fmtDate(c.next_invoice || c.start_date)}.</p>`}
        <details><summary>Bill something extra</summary>
          <form id="extra" novalidate style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
            <input class="input" name="description" maxlength="200" placeholder="What it's for, like Testing day, Oct 3" style="flex:2 1 260px;width:auto" aria-label="Description">
            <input class="input" name="amount" inputmode="decimal" placeholder="Amount ($)" style="flex:1 1 120px;width:auto" aria-label="Amount in dollars">
            <button class="btn">Send invoice</button></form>
          <p class="hint">It goes on its own invoice, emailed to ${c.billing_email || c.contact_email || 'the billing contact'} with the contract's payment terms (${termsName(c.terms_days).toLowerCase()}).</p></details>
      </section>
      <div class="cols">
        <div class="col">
          <section class="panel" id="tm-contract"><div><h2 class="panel-title">Contract</h2>
            <p class="panel-sub">${money(c.monthly_cents)}/month since ${fmtDate(c.start_date)}, billed on the ${ordinal(Number(c.start_date.slice(8, 10)))}${c.next_invoice ? ` · next invoice ${fmtDate(c.next_invoice)}` : ''}</p></div>
            <form class="stack" id="ct" novalidate>
              <div class="grid2">
                <div class="field"><label class="label" for="ct-n">Team</label><input class="input" id="ct-n" name="team_name" maxlength="80" value="${c.team_name}"></div>
                <div class="field"><label class="label" for="ct-k">Type</label><select class="input" id="ct-k" name="kind">${options(SCHOOL_KINDS, c.school_kind || 'school')}</select></div>
              </div>
              <div class="grid4">
                <div class="field"><label class="label" for="ct-f">Monthly fee ($)</label><input class="input" id="ct-f" name="monthly_fee" inputmode="decimal" value="${dollars(c.monthly_cents)}"></div>
                <div class="field"><label class="label" for="ct-e">End date</label><input class="input" id="ct-e" name="end_date" type="date" min="${c.start_date}" value="${c.end_date || ''}"></div>
                <div class="field"><label class="label" for="ct-t">Terms</label><select class="input" id="ct-t" name="terms_days">${options(TERMS.some((t) => t.id === c.terms_days) ? TERMS : [...TERMS, { id: c.terms_days, name: `Net ${c.terms_days}` }], c.terms_days)}</select></div>
                <div class="field"><label class="label" for="ct-po">PO number</label><input class="input" id="ct-po" name="po_number" value="${c.po_number || ''}"></div>
              </div>
              <p class="hint" style="margin:-8px 0 0">A new fee applies from the next invoice. Team sessions stop at the end date.</p>
              <div class="label">Billing contact at ${c.school_name}</div>
              <div class="form-grid">
                <div class="field"><label class="label" for="ct-bn">Name</label><input class="input" id="ct-bn" name="billing_name" value="${c.billing_name || ''}" autocomplete="off"></div>
                <div class="field"><label class="label" for="ct-bp">Phone</label><input class="input" id="ct-bp" name="billing_phone" type="tel" value="${c.billing_phone || ''}" autocomplete="off">
                  ${c.billing_phone ? html`<a class="hint" href="tel:${c.billing_phone}">Call ${c.billing_phone}</a>` : ''}</div>
              </div>
              <div class="field"><label class="label" for="ct-be">Email</label><input class="input" id="ct-be" name="billing_email" type="email" value="${c.billing_email || ''}" autocomplete="off"><span class="hint">Invoices, statements and reminders go here.</span></div>
              <div class="field"><label class="label" for="ct-a">Billing address</label><textarea class="input" id="ct-a" name="address" rows="2" style="min-height:72px">${c.school_address || ''}</textarea></div>
              <div class="field"><label class="label" for="ct-no">Notes</label><textarea class="input" id="ct-no" name="notes" rows="2" maxlength="2000" style="min-height:72px" placeholder="Only staff see this, like Invoices need the AD's signature">${c.notes || ''}</textarea></div>
              <div class="spread"><div class="btn-row"><button class="btn btn-primary" type="submit">Save contract</button><span class="unsaved" id="ct-dirty" aria-live="polite"></span></div>
                ${ended ? '' : html`<button class="btn btn-ghost" type="button" data-act="end">End contract</button>`}</div>
            </form></section>
          <section class="panel" id="tm-sessions">
            <div class="panel-head"><div><h2 class="panel-title">Team sessions</h2><p class="panel-sub">${d.sessions.length ? d.sessions.map((s) => `${s.days} at ${hm12(s.start_time)}`).join('; ') : 'Not on the schedule yet.'}</p></div>
              <a class="btn btn-sm" href="/app/schedule">Schedule</a></div>
            ${d.sessions.length ? html`<div class="list">${d.sessions.map((s) => html`<div class="list-row"><div class="grow"><div>${s.days} at ${hm12(s.start_time)} · ${s.duration_min} min</div>
              <div class="row-sub">${s.location || 'No location'}${s.coach ? ` · ${s.coach}` : ''}${s.next ? ` · next ${fmtDate(s.next.slice(0, 10), { weekday: true, year: false })}` : ' · no more sessions scheduled'}${s.end_date ? ` · until ${fmtDate(s.end_date)}` : ''}</div></div>
              <button class="btn btn-ghost btn-sm" data-act="rm-session" data-id="${s.id}" aria-label="Remove ${s.days} at ${hm12(s.start_time)}">Remove</button></div>`)}</div>` : ''}
            ${ended ? '' : html`<form class="stack" id="ss" novalidate>
              <fieldset style="border:0;padding:0;margin:0"><legend class="label">Days</legend><div class="days">${WD.map((w, i) => html`<label class="check"><input type="checkbox" name="weekdays" value="${i}" data-multi> ${w}</label>`)}</div></fieldset>
              <div class="grid3">
                <div class="field"><label class="label" for="ss-l">Where</label><select class="input" id="ss-l" name="location_id">${options(d.locations, d.locations[0]?.id)}</select></div>
                <div class="field"><label class="label" for="ss-t">Starts</label><input class="input" id="ss-t" name="start_time" type="time" value="15:30"></div>
                <div class="field"><label class="label" for="ss-m">Minutes</label><input class="input" id="ss-m" name="duration_min" type="number" min="15" max="300" step="5" value="60" inputmode="numeric"></div>
              </div>
              <div class="form-grid">
                <div class="field"><label class="label" for="ss-d">First day</label><input class="input" id="ss-d" name="start_date" type="date" value="${localISO() > c.start_date ? localISO() : c.start_date}" ${c.end_date ? raw(`max="${c.end_date}"`) : ''}></div>
                <div class="field"><label class="label" for="ss-c">Coach</label><select class="input" id="ss-c" name="coach_id">${options(d.coaches, '', { blank: 'No coach yet' })}</select></div>
              </div>
              <div><button class="btn">Add team sessions</button></div></form>`}
          </section>
        </div>
        <div class="col">
          <section class="panel" id="tm-roster"><div class="panel-head"><div><h2 class="panel-title">Roster · ${d.roster.length}</h2>
            <p class="panel-sub">${d.team_rate != null ? `Team attendance ${pct(d.team_rate)}` : 'Check athletes in from each team session. Attendance builds up here.'}${last ? ` · last session ${fmtDate(last.starts_at.slice(0, 10), { weekday: true, year: false })}: ${last.here} of ${Math.max(last.here, last.roster)} here` : ''}</p></div>
            ${d.recent_sessions.length > 1 && d.roster.length ? html`<div class="tm-dots" role="img" aria-label="Check-ins at the last ${d.recent_sessions.length} team sessions, oldest first: ${d.recent_sessions.slice().reverse().map((s) => `${s.here} of ${Math.max(s.here, s.roster)}`).join(', ')}">
              ${d.recent_sessions.slice().reverse().map((s) => { const r = s.here / Math.max(1, s.here, s.roster); return html`<span class="${r < 0.6 ? 'low' : ''}" style="height:${Math.max(2, Math.round(28 * r))}px" title="${fmtDate(s.starts_at.slice(0, 10), { year: false })}: ${s.here} of ${Math.max(s.here, s.roster)} here"></span>`; })}</div>` : ''}</div>
            <div class="tm-tools">
              ${d.roster.length > 5 ? html`<label class="sr-only" for="ro-q">Find on the roster</label><input class="input" id="ro-q" type="search" placeholder="Find a player" value="${ui.q}" autocomplete="off">
                <label class="sr-only" for="ro-s">Sort roster</label><select class="input" id="ro-s">${options([{ id: 'name', name: 'Name, A to Z' }, { id: 'attendance', name: 'Lowest attendance first' }, { id: 'grad', name: 'Grad year' }], ui.sort)}</select>` : ''}
              <button class="btn btn-sm" type="button" data-act="add-existing">Add existing client</button>
              ${d.roster.length ? html`<button class="btn btn-sm btn-ghost" type="button" data-act="csv">${icon('download', 16)} Export CSV</button>` : ''}
            </div>
            <div id="ro-list" aria-live="polite"></div>
            ${d.roster.some((a) => !a.reachable) ? html`<p class="hint" style="margin:0">${plural(d.roster.filter((a) => !a.reachable).length, 'athlete has', 'athletes have')} no email on file for them or a parent, so team messages reach them only in the app. Add one on their profile.</p>` : ''}
            <details id="ro-paste" ${d.roster.length && !ui.pasteOpen ? '' : raw('open')}><summary>Paste a team list</summary>
              <form class="stack-sm" id="ro">
                <label class="sr-only" for="ro-t">Team list</label>
                <textarea class="input" id="ro-t" name="text" rows="4" placeholder="${'One athlete per line: Name, position, grad year\nJalen Brooks, QB, 2027\nMarcus Hill, WR, 2028'}"></textarea>
                <div><button class="btn">Add to roster</button></div>
                <p class="hint" style="margin:0">Each new player gets an Athlete ID. Names already on the roster are skipped; names that match an existing client can be linked instead. Copying rows from a spreadsheet works too.</p></form></details>
          </section>
          ${accountabilityPanel(ctx, eng, manage)}
        </div>
      </div></div>`);
    // Edits to the contract form that weren't saved survive a redraw (recording a payment, adding a session...).
    const ct = ctx.el.querySelector('#ct');
    if (ui.ctDraft && ct) {
      for (const [k, v] of Object.entries(ui.ctDraft)) if (ct.elements[k] && typeof v === 'string') ct.elements[k].value = v;
      const x = ctx.el.querySelector('#ct-dirty'); if (x) x.textContent = 'Unsaved changes';
    }
    drawRoster(d);
    bind(d);
  }

  function drawRoster(d) {
    const box = ctx.el.querySelector('#ro-list');
    if (!box) return;
    const q = ui.q.trim().toLowerCase();
    let list = d.roster.filter((a) => !q || `${a.first_name} ${a.last_name} ${a.code} ${a.position || ''}`.toLowerCase().includes(q));
    if (ui.sort === 'attendance') list = [...list].sort((x, y) => (x.attendance_rate ?? 2) - (y.attendance_rate ?? 2));
    if (ui.sort === 'grad') list = [...list].sort((x, y) => (x.grad_year || 9999) - (y.grad_year || 9999));
    if (!d.roster.length) return mount(box, html`<p class="panel-sub">No athletes yet. Paste the team list below, or add a client you already have.</p>`);
    if (!list.length) return mount(box, html`<p class="panel-sub">Nobody on the roster matches "${ui.q.trim()}".</p>`);
    mount(box, html`<div class="list">${list.map((a) => {
      const low = a.attendance_rate != null && a.attendance_rate < 0.6;
      return html`<div class="list-row">
        <div class="grow"><a class="row-title" href="/app/clients/${a.id}">${a.first_name} ${a.last_name}</a>
          <div class="row-sub"><span class="mono" style="font-size:12px">${a.code}</span>${a.position ? ` · ${a.position}` : ''}${a.grad_year ? ` · Class of ${a.grad_year}` : ''} ·
            <span class="${low ? 'warn-text' : ''}">${a.attendance_rate == null ? 'no sessions yet' : `attendance ${pct(a.attendance_rate)} (${a.attended} of ${a.sessions})`}</span>${a.last_seen ? ` · last here ${fmtDate(a.last_seen.slice(0, 10), { year: false })}` : ''}</div></div>
        <button class="btn btn-ghost btn-sm" data-act="rm-athlete" data-id="${a.id}" data-name="${a.first_name} ${a.last_name}" aria-label="Remove ${a.first_name} ${a.last_name} from the roster">Remove</button></div>`;
    })}</div>`);
  }

  function rosterCsv(d) {
    const c = d.contract;
    downloadCsv(`${`${c.school_name} ${c.team_name}`.replace(/[^\w]+/g, '-').toLowerCase()}-roster-${localISO()}.csv`, [
      ['Name', 'Athlete ID', 'Position', 'Grad year', 'Attendance', 'Sessions attended', 'Team sessions', 'Last here'],
      ...d.roster.map((a) => [`${a.first_name} ${a.last_name}`, a.code, a.position || '', a.grad_year || '', a.attendance_rate == null ? '' : pct(a.attendance_rate), a.attended, a.sessions, a.last_seen ? a.last_seen.slice(0, 10) : ''])]);
    toast(`Exported ${plural(d.roster.length, 'athlete')}.`);
  }

  // Record one check that pays several open invoices.
  async function payMany(d) {
    const open = d.invoices.filter((i) => i.status === 'open').slice().reverse();
    const r = await modal({
      title: 'Record one payment',
      body: html`<div class="tm-modal stack-sm"><p class="muted" style="margin:0">Tick the invoices this payment covers.</p>
        <div class="tm-pick" role="group" aria-label="Invoices">${open.map((i) => html`<label class="check"><input type="checkbox" value="${i.id}" data-amt="${i.amount_cents}" checked>
          <span>${i.number}<br><span class="small muted">${i.period ? `${fmtDate(i.period)} – ${fmtDate(i.period_end)}` : i.description}</span></span><span class="strong">${money(i.amount_cents)}</span></label>`)}</div>
        <p style="margin:0">Total <span class="strong" id="pm-total"></span></p></div>${payFields()}`,
      onMount: (body) => {
        const total = () => { const t = [...body.querySelectorAll('.tm-pick input:checked')].reduce((s, x) => s + Number(x.dataset.amt), 0); body.querySelector('#pm-total').textContent = money(t); };
        body.querySelector('.tm-pick').addEventListener('change', total); total(); wirePayFields(body);
      },
      actions: [{ label: 'Cancel', value: null }, { label: 'Record payment', kind: 'primary', onClick: async (body) => {
        const ids = [...body.querySelectorAll('.tm-pick input:checked')].map((x) => Number(x.value));
        return api.post(`/teams/${d.contract.id}/record-payment`, { invoice_ids: ids, ...payValues(body) });
      } }],
    });
    if (r) toast(`${plural(r.count, 'invoice')} marked paid, ${money(r.total_cents)} in all.`);
    return !!r;
  }

  // Search every client and put one on this roster.
  async function addExisting(d) {
    let added = false;
    await modal({
      title: 'Add an existing client',
      body: html`<div class="tm-modal stack-sm"><label class="label" for="ax-q">Name or Athlete ID</label>
        <input class="input" id="ax-q" type="search" autocomplete="off" placeholder="Like Ava Lopez or AVALOP2026">
        <div id="ax-r" aria-live="polite"><p class="hint" style="margin:0">Type at least two letters.</p></div></div>`,
      onMount: (body, close) => {
        const q = body.querySelector('#ax-q'), out = body.querySelector('#ax-r');
        let rows = [];
        const search = debounce(async () => {
          const v = q.value.trim();
          if (v.length < 2) return mount(out, html`<p class="hint" style="margin:0">Type at least two letters.</p>`);
          try { rows = await api.get(`/teams/${d.contract.id}/athlete-search?q=${encodeURIComponent(v)}`); }
          catch (e) { return mount(out, html`<p class="error">${e.message}</p>`); }
          mount(out, rows.length ? html`${rows.map((a) => html`<div class="tm-res"><div><div class="strong">${a.first_name} ${a.last_name}</div>
              <div class="small muted"><span class="mono" style="font-size:12px">${a.code}</span>${a.school ? ` · ${a.school}` : ''}${a.grad_year ? ` · Class of ${a.grad_year}` : ''}${a.team_name ? ` · on ${a.team_name}` : ''}</div></div>
              <button type="button" class="btn btn-sm" data-add="${a.id}">${a.team_name ? 'Move here' : 'Add'}</button></div>`)}`
            : html`<p class="hint" style="margin:0">No clients match. Paste their name into the team list instead to create them.</p>`);
        }, 200);
        q.addEventListener('input', search);
        out.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-add]'); if (!b) return;
          const a = rows.find((x) => x.id === Number(b.dataset.add));
          if (a.team_name && !(await confirmDialog(`Move ${a.first_name} to ${d.contract.team_name}?`, `${a.first_name} ${a.last_name} comes off ${a.team_name}. Their profile and results are kept.`, 'Move athlete'))) return;
          b.disabled = true;
          try {
            await api.post(`/teams/${d.contract.id}/roster/add`, { athlete_id: a.id });
            toast(`${a.first_name} ${a.last_name} added to the roster.`);
            added = true; close(true);
          } catch (err) { toastError(err); b.disabled = false; }
        });
      },
      actions: [{ label: 'Done', value: null }],
    });
    return added;
  }

  // Paste: check the list first. Lines that match an existing client or have a problem are shown before saving.
  async function pasteRoster(d, f) {
    const text = f.text.value;
    const plan = await api.post(`/teams/${d.contract.id}/roster`, { text, preview: true });
    const errors = plan.rows.filter((r) => r.status === 'error');
    const matches = plan.rows.filter((r) => r.status === 'match');
    let links = {};
    if (errors.length) {
      await modal({ title: `Fix ${plural(errors.length, 'line')} first`,
        body: html`<p style="margin:0">Nothing was added. Each line needs a first and last name; the position and grad year are optional.</p>
          <ul style="margin:0;padding-left:18px">${errors.map((r) => html`<li>${r.error}</li>`)}</ul>`,
        actions: [{ label: 'Edit the list', value: null, kind: 'primary' }] });
      f.text.focus();
      return false;
    }
    if (matches.length) {
      const r = await modal({
        title: 'Link existing clients?',
        body: html`<div class="tm-modal stack-sm"><p style="margin:0">${plural(matches.length, 'name matches', 'names match')} a client you already have. Link to put that client on this team with their history. Or add a new athlete if it's someone else with the same name.</p>
          ${matches.map((m) => html`<div class="tm-line"><div class="strong">${m.first} ${m.last}${m.position ? html` <span class="muted small">· ${m.position}</span>` : ''}${m.grad_year ? html` <span class="muted small">· ${m.grad_year}</span>` : ''}</div>
            <label class="sr-only" for="lk-${m.n}">What to do with ${m.first} ${m.last}</label>
            <select class="input" id="lk-${m.n}" data-n="${m.n}">${m.matches.map((x, i) => html`<option value="${x.id}" ${i === 0 ? raw('selected') : ''}>Link to ${x.first_name} ${x.last_name} (${x.code}${x.school ? `, ${x.school}` : ''}${x.grad_year ? `, ${x.grad_year}` : ''}${x.team_name ? `, now on ${x.team_name}` : ''})</option>`)}
              <option value="">Add as a new athlete</option></select></div>`)}
          <p class="hint" style="margin:0">${plural(plan.counts.new, 'other new name')}${plan.counts.skip ? `, ${plan.counts.skip} already on the roster` : ''}.</p></div>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Add to roster', kind: 'primary', onClick: (body) => {
          links = Object.fromEntries([...body.querySelectorAll('select[data-n]')].filter((s) => s.value).map((s) => [s.dataset.n, Number(s.value)]));
          return true;
        } }],
      });
      if (!r) return false;
    }
    const res = await api.post(`/teams/${d.contract.id}/roster`, { text, links });
    const bits = [res.added ? `${plural(res.added, 'new athlete')} added` : null, res.linked ? `${res.linked} existing linked` : null, res.skipped ? `${res.skipped} already on the roster` : null].filter(Boolean);
    toast(bits.length ? `${bits.join(', ')}.` : 'Nothing new to add.');
    return true;
  }

  function bind(d) {
    const c = d.contract;
    const root = ctx.el.querySelector('.tm');
    const ct = root.querySelector('#ct');
    ct?.addEventListener('input', () => { ui.ctDraft = formData(ct); const x = root.querySelector('#ct-dirty'); if (x) x.textContent = 'Unsaved changes'; });
    root.querySelector('#ro-q')?.addEventListener('input', debounce((e) => { ui.q = e.target.value; drawRoster(d); }, 120));
    root.querySelector('#ro-s')?.addEventListener('change', (e) => { ui.sort = e.target.value; drawRoster(d); });
    root.querySelector('#ro-paste')?.addEventListener('toggle', (e) => { ui.pasteOpen = e.target.open; });
    root.addEventListener('click', async (e) => {
      const inv = e.target.closest('[data-inv]');
      if (inv) return invoiceAction(inv, draw);
      const j = e.target.closest('[data-jump]');
      if (j) { root.querySelector('#' + j.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      try {
        switch (b.dataset.act) {
          case 'end': {
            if (!(await confirmDialog('End this contract?', 'No more invoices go out, and future team sessions come off the schedule. Unpaid invoices stay open, and the roster is kept.', 'End contract', 'warn'))) return;
            const r = await api.post(`/teams/${c.id}/end`);
            toast(`Contract ended.${r.sessions_cancelled ? ` ${plural(r.sessions_cancelled, 'future session')} taken off the schedule.` : ''}`);
            break;
          }
          case 'rm-session':
            if (!(await confirmDialog('Remove these team sessions?', 'Future sessions come off the schedule. Past attendance is kept.', 'Remove sessions', 'warn'))) return;
            await api.post(`/teams/${c.id}/sessions/${b.dataset.id}/remove`); toast('Team sessions removed.');
            break;
          case 'goal-end':
            if (!(await confirmDialog(`End "${b.dataset.title}"?`, 'It comes off every athlete\'s list. Past weeks aren\'t affected.', 'End goal', 'warn'))) return;
            await api.put(`/goals/${b.dataset.id}`, { active: false }); toast('Team goal ended.');
            break;
          case 'assign-lesson':
            if (!(await assignDialog({ team: { id: c.id, name: `${c.school_name} ${c.team_name}` } }))) return;
            break;
          case 'rm-athlete': {
            if (!(await confirmDialog(`Remove ${b.dataset.name}?`, 'They come off this roster. Their profile and results are kept.', 'Remove', 'warn'))) return;
            const aid = b.dataset.id, name = b.dataset.name;
            await api.post(`/teams/${c.id}/roster/${aid}/remove`);
            undoToast(`${name} removed from the roster.`, async () => {
              try { await api.post(`/teams/${c.id}/roster/add`, { athlete_id: Number(aid), restore: true }); toast(`${name} is back on the roster.`); await draw(); } catch (err) { toastError(err); }
            });
            break;
          }
          case 'statement': {
            if (!(await confirmDialog('Email a statement?', `${c.billing_email || c.contact_email || 'The billing contact'} gets one email listing ${plural(d.invoices.filter((i) => i.status === 'open').length, 'open invoice')} (${money(d.unpaid_cents)}), each with its link to view or pay.`, 'Email statement'))) return;
            b.disabled = true;
            const r = await api.post(`/teams/${c.id}/statement`);
            toast(`Statement emailed to ${r.to}.`);
            return;
          }
          case 'pay-many': if (!(await payMany(d))) return; break;
          case 'add-existing': if (!(await addExisting(d))) return; break;
          case 'csv': rosterCsv(d); return;
          case 'more-inv': ui.allInvoices = !ui.allInvoices; break;
          default: return;
        }
        await draw();
      } catch (err) { toastError(err); }
      finally { if (b.isConnected) b.disabled = false; }
    });
    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button[type=submit], button:not([type])');
      if (btn) btn.disabled = true;
      try {
        const data = formData(f);
        if (f.id === 'ct') {
          const r = await api.put(`/teams/${c.id}`, data);
          ui.ctDraft = null;
          toast(r.restarted ? `Contract restarted. The next invoice goes out ${fmtDate(r.bill_from)}.` : 'Contract saved.');
        } else if (f.id === 'ss') {
          const r = await api.post(`/teams/${c.id}/sessions`, data);
          toast(`Team sessions added to the schedule (${plural(r.sessions_created, 'session')} over the next 8 weeks).`);
        } else if (f.id === 'ro') {
          if (!(await pasteRoster(d, f))) return;
          ui.pasteOpen = false;
        } else if (f.id === 'tg') { await api.post(`/teams/${c.id}/goals`, data); toast('Team goal added. Every athlete on the roster sees it.'); }
        else if (f.id === 'tmsg') {
          if (!data.body.trim()) throw new Error('Write a message first.');
          await api.post(`/teams/${c.id}/messages`, { body: data.body.trim() }); toast('Message sent to the team. Athletes and parents were emailed.');
        } else if (f.id === 'extra') {
          const r = await api.post(`/teams/${c.id}/invoices`, data);
          toast(`${r.number} ${r.emailed ? 'sent' : 'created. Add a billing email to send it'}.`);
        }
        await draw();
      } catch (err) { showFieldError(f, err); }
      finally { if (btn?.isConnected) btn.disabled = false; }
    });
  }
  await draw();
}

// ---------------------------------------------------------------- new contract
async function renderNew(ctx) {
  const schools = await api.get('/schools');
  if (!ctx.isCurrent()) return;
  const preset = schools.find((s) => String(s.id) === String(ctx.query.school || ''));
  mount(ctx.el, html`${STYLE}<div class="stack tm">
    <div class="page-header"><div><h1 class="page-title">New team contract</h1><p class="page-sub">A flat monthly fee, invoiced to the school or club at the start of each month of the contract.</p></div>
      <a class="btn" href="/app/teams">Cancel</a></div>
    <form class="panel tm-new stack" id="nt" novalidate>
      <div class="field"><label class="label" for="nt-s">School or club</label>
        <select class="input" id="nt-s" name="school_id"><option value="new">A new school or club…</option>${options(schools, preset?.id || '')}</select></div>
      <div class="grid2" id="nt-newname">
        <div class="field"><label class="label" for="nt-sn">School or club name</label><input class="input" id="nt-sn" name="school_name" autocomplete="off" maxlength="120"></div>
        <div class="field"><label class="label" for="nt-k">Type</label><select class="input" id="nt-k" name="kind">${options(SCHOOL_KINDS, 'school')}</select></div>
      </div>
      <div class="grid3">
        <div class="field"><label class="label" for="nt-bn">Billing contact</label><input class="input" id="nt-bn" name="billing_name" autocomplete="off"><span class="hint">Athletic director or treasurer</span></div>
        <div class="field"><label class="label" for="nt-be">Billing email</label><input class="input" id="nt-be" name="billing_email" type="email" autocomplete="off"><span class="hint">Invoices go here.</span></div>
        <div class="field"><label class="label" for="nt-bp">Phone</label><input class="input" id="nt-bp" name="billing_phone" type="tel" autocomplete="off"></div>
      </div>
      <div class="field"><label class="label" for="nt-a">Billing address</label><textarea class="input" id="nt-a" name="address" rows="2" style="min-height:72px"></textarea></div>
      <div class="form-grid">
        <div class="field"><label class="label" for="nt-t">Team</label><input class="input" id="nt-t" name="team_name" placeholder="Varsity Baseball" maxlength="80"></div>
        <div class="field"><label class="label" for="nt-f">Monthly fee ($)</label><input class="input" id="nt-f" name="monthly_fee" inputmode="decimal" placeholder="1,200"></div>
      </div>
      <div class="grid4">
        <div class="field"><label class="label" for="nt-sd">Start</label><input class="input" id="nt-sd" name="start_date" type="date" value="${localISO()}"><span class="hint">Billing day each month</span></div>
        <div class="field"><label class="label" for="nt-ed">End (optional)</label><input class="input" id="nt-ed" name="end_date" type="date"></div>
        <div class="field"><label class="label" for="nt-tm">Payment terms</label><select class="input" id="nt-tm" name="terms_days">${options(TERMS, 30)}</select></div>
        <div class="field"><label class="label" for="nt-po">PO number</label><input class="input" id="nt-po" name="po_number"></div>
      </div>
      <div class="field" id="nt-pastf" hidden><label class="label" for="nt-past">Months that have already started</label>
        <select class="input" id="nt-past" name="past"></select></div>
      <div class="tm-summary" id="nt-sum" aria-live="polite"></div>
      <div class="error" id="nt-err" role="alert"></div>
      <div><button class="btn btn-primary" type="submit">Create contract</button></div>
    </form></div>`);
  const f = ctx.el.querySelector('#nt');
  const sel = f.querySelector('#nt-s');
  const T = localISO();
  function pickSchool() {
    const s = schools.find((x) => String(x.id) === sel.value);
    f.querySelector('#nt-newname').hidden = !!s;
    f.billing_name.value = s?.contact_name || '';
    f.billing_email.value = s?.contact_email || '';
    f.billing_phone.value = s?.contact_phone || '';
    f.address.value = s?.address || '';
    if (s) f.kind.value = s.kind || 'school';
  }
  // What happens when you save: how many invoices go out now, and when the rest follow.
  function summary() {
    const start = f.start_date.value, end = f.end_date.value;
    const fee = Math.round(parseFloat(String(f.monthly_fee.value).replace(/[$,\s]/g, '')) * 100);
    const box = f.querySelector('#nt-sum'), pastF = f.querySelector('#nt-pastf'), past = f.past;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) { box.textContent = 'Choose a start date.'; pastF.hidden = true; return; }
    if (end && end < start) { box.textContent = 'The end date is before the start date.'; pastF.hidden = true; return; }
    const started = [];
    for (let k = 0; k < 240; k++) { const p = addMonths(start, k); if (p > T || (end && p > end)) break; started.push(p); }
    pastF.hidden = !started.length || start >= T;
    if (!pastF.hidden) {
      const keep = past.value || 'all';
      mount(past, html`${options([{ id: 'all', name: started.length > 1 ? `Invoice all ${started.length} now` : 'Invoice it now' },
        ...(started.length > 1 ? [{ id: 'current', name: `Invoice only the current month (from ${fmtDate(started[started.length - 1], { year: false })})` }] : []),
        { id: 'none', name: 'Don\'t invoice them, they were billed another way' }], keep)}`);
      if (![...past.options].some((o) => o.value === keep)) past.value = 'all';
    }
    const mode = pastF.hidden ? 'all' : past.value;
    const nowCount = mode === 'all' ? started.length : mode === 'current' ? Math.min(1, started.length) : 0;
    let next = null;
    for (let k = 0; k < 240; k++) { const p = addMonths(start, k); if (end && p > end) break; if (p > T) { next = p; break; } }
    const feeTxt = fee > 0 ? money(fee) : 'the monthly fee';
    const day = ordinal(Number(start.slice(8, 10)));
    const parts = [];
    if (nowCount) parts.push(nowCount === 1 ? `One invoice for ${feeTxt} goes out as soon as you save.` : `${nowCount} invoices of ${feeTxt}${fee > 0 ? ` (${money(fee * nowCount)} in all)` : ''} go out as soon as you save.`);
    else if (start > T) parts.push(`The first invoice for ${feeTxt} goes out ${fmtDate(start)}.`);
    if (next && start <= T) parts.push(`Then one on the ${day} of each month, next ${fmtDate(next)}${end ? `, until ${fmtDate(end)}` : ''}.`);
    else if (start > T) parts.push(`Then one on the ${day} of each month${end ? ` until ${fmtDate(end)}` : ''}.`);
    box.textContent = parts.join(' ') || 'No invoices go out for this contract.';
  }
  sel.addEventListener('change', pickSchool);
  f.addEventListener('input', (e) => { if (['start_date', 'end_date', 'monthly_fee'].includes(e.target.name)) summary(); e.target.removeAttribute('aria-invalid'); });
  f.addEventListener('change', (e) => { if (['start_date', 'end_date', 'past'].includes(e.target.name)) summary(); });
  if (preset) { pickSchool(); f.team_name.focus(); } else f.school_name.focus();
  summary();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = f.querySelector('#nt-err'); err.textContent = '';
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const data = formData(f);
      if (f.querySelector('#nt-pastf').hidden) delete data.past;
      const r = await api.post('/teams', data);
      toast(r.invoices ? `Contract created. ${plural(r.invoices, 'invoice')} ${r.emailed ? 'emailed' : 'created; add a billing email to send them'}.` : 'Contract created. The first invoice goes out on its billing day.');
      ctx.go(`/app/teams/${r.id}`);
    } catch (ex) { showFieldError(f, ex, err); }
    finally { if (btn.isConnected) btn.disabled = false; }
  });
}

export const routes = [
  { path: '/teams', nav: 'teams', title: 'Teams', roles: ['owner'], render: renderList },
  { path: '/teams/new', nav: 'teams', title: 'New team contract', roles: ['owner'], render: renderNew },
  { path: '/teams/:id', nav: 'teams', title: 'Team contract', roles: ['owner'], render: renderTeam },
];
