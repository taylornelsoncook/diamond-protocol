// Today: numbers across the top, today's sessions, what needs a decision, recent activity, revenue by location (owners).
import { html, mount, api, money, relTime, fmtTime, badge, toast, toastError, plural } from '/js/ui.js';

const STYLE = html`<style>
  .td-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md)}
  .td-metrics .metric{border:0;border-radius:0;background:transparent;padding:var(--space-6)}
  .td-metrics .metric+.metric{border-left:1px solid var(--line)}
  .td-row{display:flex;align-items:center;gap:var(--space-4);padding:12px 0;border-top:1px solid var(--line-subtle);text-decoration:none;color:inherit}
  .td-row:first-child{border-top:0}
  a.td-row:hover .td-name{text-decoration:underline}
  .td-time{font:600 16px/1.2 var(--font-display);min-width:78px;color:var(--steel)}
  .td-name{font-weight:600;color:var(--steel)}
  .td-grow{flex:1;min-width:0}
  .td-att .td-title{font-weight:600;color:var(--steel)}
  .td-att a.td-title{color:var(--steel)}
  .td-act{display:grid;grid-template-columns:88px minmax(0,1fr);gap:var(--space-3);padding:12px 0;border-top:1px solid var(--line-subtle)}
  .td-act:first-child{border-top:0}
  .td-money{font:600 20px/1 var(--font-display);min-width:80px;text-align:right}
  @media (max-width:900px){.td-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.td-metrics .metric:nth-child(3){border-left:0}.td-metrics .metric:nth-child(n+3){border-top:1px solid var(--line)}.td-metrics .metric{padding:var(--space-4)}}
  @media (max-width:520px){.td-att .td-row{flex-wrap:wrap}.td-att .td-row .btn{width:100%}.td-act{grid-template-columns:1fr;gap:2px}}
</style>`;

function sessionRow(e) {
  const end = new Date(new Date(e.starts_at).getTime() + e.duration_min * 6e4);
  const team = e.type === 'team';
  const count = team ? `${e.checked_in}/${e.team_size} here` : `${e.booked}/${e.capacity ?? '∞'} booked · ${e.checked_in} checked in`;
  return html`<a class="td-row" href="/app/schedule/session/${e.id}">
    <div class="td-time">${fmtTime(e.starts_at)}</div>
    <div class="td-grow"><div class="td-name">${e.name}</div>
      <div class="small muted">${fmtTime(e.starts_at)}–${fmtTime(end)} · ${e.location || 'No location'} · ${count}</div></div>
    ${e.cancelled ? badge('cancelled') : html`${e.unpaid ? badge('unpaid', `${e.unpaid} unpaid`) : ''}${e.waitlisted ? badge('waitlist', `${e.waitlisted} waitlist`) : ''}`}
  </a>`;
}

function attentionRow(item, i) {
  const btn = item.action?.post
    ? html`<button class="btn btn-outline btn-sm" data-post="${i}">${item.action.label}</button>`
    : item.action ? html`<a class="btn btn-outline btn-sm" href="${item.action.href}">${item.action.label}</a>` : '';
  return html`<div class="td-row">
    <div class="td-grow">${item.href && item.kind !== 'pending_results' ? html`<a class="td-title" href="${item.href}">${item.title}</a>` : html`<div class="td-title">${item.title}</div>`}
      <div class="small muted">${item.detail}</div></div>${btn}</div>`;
}

export const routes = [{
  path: '/today', nav: 'today', title: 'Today',
  render: async (ctx) => {
    const owner = ctx.me.role === 'owner';
    const [d, activity] = await Promise.all([api.get('/today'), api.get('/activity?limit=40').then((l) => l.filter((a) => a.kind !== 'signin' && a.kind !== 'refused').slice(0, 12)).catch(() => [])]);
    if (!ctx.isCurrent()) return;
    const sub = owner
      ? `Revenue, clients and anything that needs a decision. ${money(d.in_person_today_cents)} in person today.`
      : `Today's sessions, your clients and anything that needs a decision.`;
    const rev = d.revenue;
    mount(ctx.el, html`${STYLE}
      <header class="page-header">
        <div><h1 class="page-title">Today</h1><p class="page-sub">${sub}</p></div>
        <a class="btn btn-primary" href="/app/clients/new">Add client</a>
      </header>

      <section class="td-metrics" aria-label="Key numbers">${d.metrics.map((m) => html`<div class="metric">
        <div class="metric-label">${m.label}</div><div class="metric-value ${m.tone || ''}">${m.value}</div><div class="metric-note">${m.note}</div></div>`)}</section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Today's sessions</h2><a class="btn btn-sm" href="/app/schedule">Full schedule</a></div>
        ${d.sessions.length ? html`<div class="list">${d.sessions.map(sessionRow)}</div>` : html`<p class="muted" style="margin:0">Nothing on the schedule today.</p>`}
      </section>

      <div class="grid-2" style="align-items:start">
        <section class="panel td-att">
          <h2 class="panel-title">Needs your attention</h2>
          ${d.attention.length ? html`<div class="list">${d.attention.map(attentionRow)}</div>` : html`<p class="muted" style="margin:0">Nothing needs a decision right now.</p>`}
        </section>
        <section class="panel">
          <h2 class="panel-title">Recent activity</h2>
          ${activity.length ? html`<div>${activity.map((a) => html`<div class="td-act">
            <div class="small muted">${relTime(a.created_at)}</div>
            <div><div>${a.action}${a.detail ? html`<span class="muted">: ${a.detail}</span>` : ''}</div><div class="small muted">${a.actor || ''}</div></div></div>`)}</div>`
            : html`<p class="muted" style="margin:0">Nothing yet. Bookings, payments, check-ins and PRs show here as they happen.</p>`}
        </section>
      </div>

      ${owner && rev ? html`<section class="panel">
        <div class="panel-head"><div><h2 class="panel-title">Revenue by location</h2>
          <p class="panel-sub">This month. ${rev.membership_payments.count ? `In-person sales plus ${money(rev.membership_payments.cents)} from ${plural(rev.membership_payments.count, 'membership payment')}.` : 'In-person sales. No membership payments yet this month.'}</p></div>
          <a class="btn btn-primary btn-sm" href="/app/pos">New sale</a></div>
        ${rev.locations.length ? html`<div class="list">${rev.locations.map((l) => html`<div class="td-row">
          <div class="td-grow">${l.location}</div><div class="small muted">${plural(l.sales, 'sale')}</div><div class="td-money">${money(l.cents)}</div></div>`)}</div>`
          : html`<p class="muted" style="margin:0">No in-person sales yet this month.</p>`}
      </section>` : ''}`);

    ctx.el.querySelectorAll('[data-post]').forEach((b) => b.addEventListener('click', async () => {
      const item = d.attention[+b.dataset.post];
      b.disabled = true;
      try {
        const r = await api.post(item.action.post);
        toast(r.message || 'Done.', r.ok === false ? 'warn' : 'good');
        ctx.reload();
      } catch (e) { toastError(e); b.disabled = false; }
    }));
  },
}];
