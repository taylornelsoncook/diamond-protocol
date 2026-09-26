// Billing: membership plans, every invoice (retry declined charges), and the test-mode billing clock. Owner only.
import { html, mount, api, money, fmtDate, badge, toast, toastError, modal, confirmDialog, formData, options, localISO, debounce, plural } from '/js/ui.js';

const STYLE = html`<style>
.bl .table-wrap{position:relative;border:0;border-radius:0;border-top:1px solid var(--line);margin:0 calc(-1 * var(--space-6));background:transparent}
.bl .table td,.bl .table th{padding-left:20px;padding-right:20px}
.bl .plan-name{font-weight:600}
.bl .rev{font:600 20px/1 var(--font-display)}
.bl .retired td{color:var(--steel-muted)}
.bl .who{font-weight:600;color:var(--steel)}
.bl .inv-tools{display:flex;gap:var(--space-2);flex-wrap:wrap}
.bl .inv-tools .input{width:auto}
.bl .plan-form{display:grid;grid-template-columns:2fr 1fr 1fr;gap:var(--space-3)}
.bl .plan-form .more{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3)}
@media (max-width:700px){.bl .plan-form{grid-template-columns:1fr 1fr}.bl .plan-form .f-name{grid-column:1/-1}.bl .col-what,.bl .col-date{display:none}.bl .table td,.bl .table th{padding-left:12px;padding-right:12px}}
.bl .clock{display:flex;gap:var(--space-2);align-items:flex-end;flex-wrap:wrap}
</style>`;

const FILTERS = [
  { id: '', name: 'All invoices' }, { id: 'status=failed', name: 'Failed' }, { id: 'status=open', name: 'Open' }, { id: 'status=overdue', name: 'Overdue' },
  { id: 'status=paid', name: 'Paid' }, { id: 'status=void', name: 'Void' }, { id: 'kind=membership', name: 'Memberships' }, { id: 'kind=school', name: 'School invoices' }, { id: 'kind=charge', name: 'Sales and drop-ins' },
];
const allowance = (p) => [p.group_per_month == null ? 'Unlimited group classes' : `${p.group_per_month} group sessions a month`, p.private_per_month ? `${p.private_per_month} privates a month` : null].filter(Boolean).join(' + ');

function planFields(p = {}, x = 'pl') {
  return html`<div class="field f-name"><label class="label" for="${x}-n">Plan name</label><input class="input" id="${x}-n" name="name" value="${p.name || ''}"></div>
    <div class="field"><label class="label" for="${x}-p">Monthly price ($)</label><input class="input" id="${x}-p" name="price" inputmode="decimal" value="${p.price_cents != null ? (p.price_cents / 100).toFixed(2) : ''}"></div>
    <div class="field"><label class="label" for="${x}-t">Trial days</label><input class="input" id="${x}-t" name="trial_days" type="number" min="0" value="${p.trial_days ?? 7}"></div>
    <div class="more"><div class="field"><label class="label" for="${x}-g">Group sessions a month</label><input class="input" id="${x}-g" name="group_per_month" type="number" min="0" placeholder="Unlimited" value="${p.group_per_month ?? ''}"><span class="hint">Leave blank for unlimited.</span></div>
    <div class="field"><label class="label" for="${x}-v">Private sessions a month</label><input class="input" id="${x}-v" name="private_per_month" type="number" min="0" value="${p.private_per_month ?? 0}"></div></div>`;
}

async function render(ctx) {
  let filter = ctx.query.filter || '';
  let q = '';
  async function drawPlans() {
    const plans = await api.get('/plans');
    if (!ctx.isCurrent()) return;
    mount(ctx.el.querySelector('#bl-plans'), plans.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Plan</th><th>Price</th><th>Trial</th><th>Clients</th><th>Monthly revenue</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${plans.map((p) => html`<tr class="${p.active ? '' : 'retired'}">
        <td><div class="plan-name">${p.name}</div><div class="small muted">${p.active ? allowance(p) : 'Retired: existing members keep it, no one new can join'}</div></td>
        <td>${money(p.price_cents)} / mo</td><td>${p.trial_days ? `${p.trial_days} days` : 'None'}</td><td>${p.subscribers}</td>
        <td><span class="rev">${money(p.monthly_revenue_cents)}</span></td>
        <td class="num"><div class="btn-row" style="justify-content:flex-end"><button class="btn btn-ghost btn-sm" data-act="edit" data-id="${p.id}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-act="${p.active ? 'retire' : 'restore'}" data-id="${p.id}">${p.active ? 'Retire' : 'Bring back'}</button></div></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">No plans yet. Create your first one below.</div>`);
    ctx.el.querySelector('#bl-plans')._plans = plans;
  }
  async function drawInvoices() {
    const params = new URLSearchParams(filter);
    if (q) params.set('q', q);
    const list = await api.get('/invoices?' + params);
    if (!ctx.isCurrent()) return;
    const failed = list.filter((i) => i.status === 'failed');
    ctx.el.querySelector('#bl-inv-sub').textContent = failed.length && !filter ? `${plural(failed.length, 'declined charge')} waiting. Declines retry on their own every 3 days.` : 'Every charge, newest first. Declines retry on their own every 3 days.';
    mount(ctx.el.querySelector('#bl-invoices'), list.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Client</th><th class="col-what">Plan or item</th><th>Amount</th><th class="col-date">Date</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${list.map((i) => {
        const overdue = i.status === 'open' && i.due_date && i.due_date < localISO();
        const who = i.athlete_id ? html`<a class="who" href="/app/clients/${i.athlete_id}">${i.first_name} ${i.last_name}</a>`
          : i.contract_id ? html`<a class="who" href="/app/teams/${i.contract_id}">${i.school}</a>` : html`<span class="who">${i.family || 'Walk-in'}</span>`;
        return html`<tr><td>${who}<div class="small muted mono">${i.number}</div></td>
          <td class="col-what">${i.plan_name || (i.contract_id ? i.team_name : i.description) || ''}${i.status === 'failed' ? html`<div class="small muted">${plural(i.attempts, 'attempt')}${i.next_retry ? ` · next retry ${fmtDate(i.next_retry)}` : ''}</div>` : ''}</td>
          <td>${money(i.amount_cents)}</td><td class="col-date">${fmtDate(i.issued_at)}</td>
          <td>${overdue ? badge('overdue') : badge(i.status)}</td>
          <td class="num">${i.status === 'failed' ? html`<button class="btn btn-outline btn-sm" data-act="retry" data-id="${i.id}">Retry charge</button>`
            : i.kind === 'school' ? html`<a class="btn btn-ghost btn-sm" href="/invoice/${i.view_token}" target="_blank" rel="noopener">View</a>` : ''}</td></tr>`;
      })}</tbody></table></div>` : html`<div class="empty">No invoices match.</div>`);
  }

  mount(ctx.el, html`${STYLE}<div class="stack bl">
    <div class="page-header"><div><h1 class="page-title">Billing</h1><p class="page-sub">Plans, invoices and failed payments.</p></div></div>
    <section class="panel"><div><h2 class="panel-title">Plans</h2><p class="panel-sub">Price changes apply from each client's next charge.</p></div>
      <div id="bl-plans"><div class="muted">Loading…</div></div>
      <form class="plan-form" id="pl-new" novalidate>${planFields()}<div><button class="btn">Create plan</button></div></form>
    </section>
    <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Invoices</h2><p class="panel-sub" id="bl-inv-sub"></p></div>
      <div class="inv-tools"><input class="input" id="bl-q" type="search" placeholder="Name, invoice or school" aria-label="Search invoices">
        <select class="input" id="bl-f" aria-label="Filter invoices">${options(FILTERS, filter)}</select></div></div>
      <div id="bl-invoices"><div class="muted">Loading…</div></div>
    </section>
    ${ctx.settings?.payments_mode === 'test' ? html`<section class="panel"><div><h2 class="panel-title">Billing clock (test mode)</h2>
      <p class="panel-sub">Billing runs hourly on its own. Run it for a future date to see trials convert, renewals charge, retries happen and school invoices go out.</p></div>
      <form class="clock" id="clock"><div class="field"><label class="label" for="ck-d">Run as of</label><input class="input" id="ck-d" name="as_of" type="date" value="${localISO(new Date(Date.now() + 8 * 864e5))}" min="${localISO()}"></div>
        <button class="btn">Run billing</button></form></section>` : ''}
  </div>`);
  const root = ctx.el.querySelector('.bl');

  root.querySelector('#bl-f').addEventListener('change', (e) => {
    filter = e.target.value;
    history.replaceState({}, '', '/app/billing' + (filter ? `?filter=${encodeURIComponent(filter)}` : ''));
    drawInvoices().catch(toastError);
  });
  root.querySelector('#bl-q').addEventListener('input', debounce((e) => { q = e.target.value.trim(); drawInvoices().catch(toastError); }, 250));

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const plans = root.querySelector('#bl-plans')._plans || [];
    const p = plans.find((x) => String(x.id) === b.dataset.id);
    try {
      if (b.dataset.act === 'retry') {
        b.disabled = true;
        try { await api.post(`/invoices/${b.dataset.id}/retry`); toast('Charge went through. The membership is active again.'); }
        catch (err) { toastError(err); }
        await drawInvoices(); await drawPlans();
      } else if (b.dataset.act === 'retire') {
        if (!(await confirmDialog(`Retire ${p.name}?`, `No one new can join it. ${plural(p.subscribers, 'current member')} keep${p.subscribers === 1 ? 's' : ''} it until you change their plan.`, 'Retire plan', 'warn'))) return;
        await api.put(`/plans/${p.id}`, { active: false }); toast('Plan retired.'); await drawPlans();
      } else if (b.dataset.act === 'restore') {
        await api.put(`/plans/${p.id}`, { active: true }); toast('Plan is available again.'); await drawPlans();
      } else if (b.dataset.act === 'edit') {
        const r = await modal({
          title: 'Edit plan',
          body: html`<form class="plan-form" id="pl-edit" onsubmit="return false">${planFields(p, 'pe')}</form>
            <p class="hint" style="margin:0">${p.subscribers ? `A new price applies to all ${plural(p.subscribers, 'member')} from their next charge. Nobody is charged now.` : 'No one is on this plan yet.'}</p>`,
          actions: [{ label: 'Cancel', value: null }, { label: 'Save plan', kind: 'primary', onClick: async (body) => api.put(`/plans/${p.id}`, formData(body.querySelector('#pl-edit'))) }],
        });
        if (!r) return;
        toast(r.members_repriced ? `Plan saved. ${plural(r.members_repriced, 'member')} move${r.members_repriced === 1 ? 's' : ''} to the new price at their next charge.` : 'Plan saved.');
        await drawPlans();
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
        toast(`Billing ran: ${r.charged} charged, ${r.declined} declined, ${r.recovered} recovered on retry, ${plural(r.school_invoices, 'school invoice')}, ${plural(r.reminders, 'reminder')}.`);
        await Promise.all([drawInvoices(), drawPlans()]);
      }
    } catch (err) { toastError(err); }
    finally { btn.disabled = false; }
  });

  await Promise.all([drawPlans(), drawInvoices()]);
}

export const routes = [{ path: '/billing', nav: 'billing', title: 'Billing', roles: ['owner'], render }];
