// Teams: school and club contracts, one contract's invoices/terms/roster/sessions, and New team contract. Owner only.
import { html, raw, mount, api, money, fmtDate, relTime, badge, toast, toastError, modal, confirmDialog, formData, options, localISO, plural } from '/js/ui.js';

const STYLE = html`<style>
.tm .tm-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md)}
.tm .tm-metrics .metric{border:0;border-radius:0;background:transparent;padding:var(--space-4) var(--space-6)}
.tm .tm-metrics .metric+.metric{border-left:1px solid var(--line)}
@media (max-width:900px){.tm .tm-metrics{grid-template-columns:1fr 1fr}.tm .tm-metrics .metric:nth-child(3){border-left:0}.tm .tm-metrics .metric:nth-child(n+3){border-top:1px solid var(--line)}}
.tm .list-row{padding:14px 0;flex-wrap:wrap}
.tm .row-title{font-weight:600;color:var(--steel);text-decoration:none}
a.row-title:hover{color:var(--green-soft)}
.tm .row-sub{font-size:13px;color:var(--steel-muted)}
.tm .inv-actions{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end}
.tm .inv-amt{font-weight:600;min-width:64px;text-align:right}
.tm .cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);align-items:start}
@media (max-width:1000px){.tm .cols{grid-template-columns:1fr}}
.tm .col{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}
.tm .grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3)}
.tm .grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3)}
@media (max-width:600px){.tm .grid4,.tm .grid3{grid-template-columns:1fr 1fr}}
.tm .days{display:flex;gap:6px 14px;flex-wrap:wrap}
.tm .days .check{min-height:28px;align-items:center;font-size:14px}
.tm details summary{cursor:pointer;font-size:14px;min-height:32px;display:flex;align-items:center;gap:8px;list-style:none}.tm details summary::-webkit-details-marker{display:none}.tm details summary::before{content:'';width:0;height:0;border:5px solid transparent;border-left:7px solid currentColor;border-right:0}.tm details[open] summary::before{transform:rotate(90deg)}
.tm .tm-new{max-width:680px}
@media (max-width:600px){.tm .inv-actions{justify-content:flex-start;width:100%}}
</style>`;

const TERMS = [{ id: 0, name: 'Due on receipt' }, { id: 15, name: 'Net 15' }, { id: 30, name: 'Net 30' }, { id: 45, name: 'Net 45' }, { id: 60, name: 'Net 60' }];
const termsName = (d) => (d === 0 ? 'Due on receipt' : `Net ${d}`);
const METHOD = { check: 'check', ach: 'bank transfer', card: 'card', cash: 'cash', other: 'other' };
const dollars = (c) => (c / 100).toFixed(2);

function invoiceSub(i) {
  if (i.status === 'paid') return `Paid ${fmtDate(i.paid_at)} by ${METHOD[i.pay_method] || i.pay_method || 'payment'}${i.check_number ? ` #${i.check_number}` : ''}`;
  if (i.status === 'void') return `Voided · ${i.description || ''}`;
  const bits = [i.period ? `${fmtDate(i.period)} – ${fmtDate(i.period_end)}` : i.description, i.due_date ? `due ${fmtDate(i.due_date)}` : null, i.emailed_at ? `emailed ${relTime(i.emailed_at)}` : 'not emailed yet'];
  return bits.filter(Boolean).join(' · ');
}
function invoiceRow(i, title) {
  const open = i.status === 'open';
  return html`<div class="list-row">
    <div class="grow"><div class="row-title">${title}</div><div class="row-sub">${invoiceSub(i)}</div></div>
    <div class="inv-actions"><span class="inv-amt">${money(i.amount_cents)}</span>${i.overdue ? badge('overdue') : badge(i.status)}
      <a class="btn btn-ghost btn-sm" href="/invoice/${i.view_token}" target="_blank" rel="noopener">View</a>
      ${open ? html`<button class="btn btn-outline btn-sm" data-inv="pay" data-id="${i.id}" data-num="${i.number}" data-amt="${i.amount_cents}">Record payment</button>
        <button class="btn btn-ghost btn-sm" data-inv="email" data-id="${i.id}">Email</button>
        <button class="btn btn-ghost btn-sm" data-inv="void" data-id="${i.id}" data-num="${i.number}">Void</button>` : ''}</div></div>`;
}

// Shared invoice actions (Record payment, Email, Void) for the Teams list and a contract.
async function invoiceAction(btn, redraw) {
  const id = btn.dataset.id;
  try {
    if (btn.dataset.inv === 'email') {
      btn.disabled = true;
      const r = await api.post(`/invoices/${id}/email`);
      toast(`Invoice emailed to ${r.to}.`);
    } else if (btn.dataset.inv === 'void') {
      if (!(await confirmDialog(`Void ${btn.dataset.num}?`, 'The school can no longer pay it, and it stops counting as unpaid. It is not sent again for that month.', 'Void invoice', 'warn'))) return;
      await api.post(`/invoices/${id}/void`);
      toast('Invoice voided.');
    } else if (btn.dataset.inv === 'pay') {
      const r = await modal({
        title: 'Record payment',
        body: html`<p class="muted" style="margin:0">${btn.dataset.num} · ${money(Number(btn.dataset.amt))}</p>
          <div class="form-grid">
            <div class="field"><label class="label" for="rp-m">How they paid</label><select class="input" id="rp-m">${options([{ id: 'check', name: 'Check' }, { id: 'ach', name: 'Bank transfer' }, { id: 'card', name: 'Card' }, { id: 'cash', name: 'Cash' }, { id: 'other', name: 'Other' }], 'check')}</select></div>
            <div class="field" id="rp-cf"><label class="label" for="rp-c">Check number</label><input class="input" id="rp-c" inputmode="numeric" autocomplete="off"></div>
            <div class="field"><label class="label" for="rp-d">Received</label><input class="input" id="rp-d" type="date" value="${localISO()}"></div>
          </div>`,
        onMount: (body) => { const s = body.querySelector('#rp-m'); s.onchange = () => { body.querySelector('#rp-cf').hidden = s.value !== 'check'; }; body.querySelector('#rp-c').focus(); },
        actions: [{ label: 'Cancel', value: null }, { label: 'Record payment', kind: 'primary', onClick: async (body) => {
          await api.post(`/invoices/${id}/record-payment`, { method: body.querySelector('#rp-m').value, check_number: body.querySelector('#rp-c').value, paid_on: body.querySelector('#rp-d').value });
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
  async function draw() {
    const d = await api.get('/teams');
    if (!ctx.isCurrent()) return;
    const m = d.metrics;
    mount(ctx.el, html`${STYLE}<div class="stack tm">
      <div class="page-header"><div><h1 class="page-title">Teams</h1><p class="page-sub">School and club contracts, billed a flat monthly fee.</p></div>
        <a class="btn btn-primary" href="/app/teams/new">New team contract</a></div>
      <div class="tm-metrics">
        <div class="metric"><span class="metric-label">Monthly contract revenue</span><span class="metric-value">${money(m.monthly_cents)}</span><span class="metric-note">${plural(m.active_teams, 'active team')}</span></div>
        <div class="metric"><span class="metric-label">Waiting on payment</span><span class="metric-value">${money(m.waiting_cents)}</span><span class="metric-note">${plural(m.waiting_count, 'open invoice')}</span></div>
        <div class="metric"><span class="metric-label">Overdue</span><span class="metric-value ${m.overdue_cents ? 'warn' : ''}">${money(m.overdue_cents)}</span><span class="metric-note">${m.overdue_count} past due</span></div>
        <div class="metric"><span class="metric-label">Athletes on rosters</span><span class="metric-value">${m.athletes}</span><span class="metric-note">Across active teams</span></div>
      </div>
      <section class="panel"><h2 class="panel-title">Contracts</h2>
        ${d.contracts.length ? html`<div class="list">${d.contracts.map((c) => html`<div class="list-row">
          <div class="grow"><a class="row-title" href="/app/teams/${c.id}">${c.school_name} · ${c.team_name}</a>
            <div class="row-sub">${money(c.monthly_cents)}/month · ${termsName(c.terms_days)} · ${plural(c.athletes, 'athlete')} · ${c.status === 'ended' ? `ended ${fmtDate(c.end_date)}` : c.next_invoice ? `next invoice ${fmtDate(c.next_invoice)}` : 'no more invoices'}${c.has_billing_email ? '' : raw(' · <span class="warn-text">add a billing email</span>')}</div></div>
          ${c.status === 'ended' ? badge('ended') : c.overdue_cents ? badge('overdue', `${money(c.overdue_cents)} overdue`) : c.open_cents ? badge('open', `${money(c.open_cents)} open`) : ''}</div>`)}</div>`
          : html`<div class="empty">No contracts yet. <a href="/app/teams/new">Add a school or club</a>.</div>`}
      </section>
      <section class="panel"><div><h2 class="panel-title">Unpaid invoices</h2>
        <p class="panel-sub">Invoices email the school's billing contact with a link to view, print or pay online. Overdue ones get a reminder each week.</p></div>
        ${d.unpaid.length ? html`<div class="list">${d.unpaid.map((i) => invoiceRow(i, `${i.number} · ${i.school_name} ${i.team_name}`))}</div>` : html`<p class="panel-sub">Nothing unpaid. Every school invoice is settled.</p>`}
      </section></div>`);
    ctx.el.querySelector('.tm').addEventListener('click', (e) => { const b = e.target.closest('[data-inv]'); if (b) invoiceAction(b, draw); });
  }
  await draw();
}

// ---------------------------------------------------------------- contract
async function renderTeam(ctx) {
  const id = ctx.params.id;
  async function draw() {
    const d = await api.get(`/teams/${id}`);
    if (!ctx.isCurrent()) return;
    const c = d.contract;
    const ended = c.status === 'ended';
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    mount(ctx.el, html`${STYLE}<div class="stack tm">
      <div class="page-header"><div><h1 class="page-title">${c.school_name}</h1><p class="page-sub">${c.team_name} · ${money(c.monthly_cents)}/month${ended ? ` · ended ${fmtDate(c.end_date)}` : ''}</p></div>
        <a class="btn" href="/app/teams">All teams</a></div>
      <section class="panel"><div><h2 class="panel-title">Invoices</h2><p class="panel-sub">${d.unpaid_cents ? `${money(d.unpaid_cents)} unpaid` : 'Nothing unpaid'}</p></div>
        ${d.invoices.length ? html`<div class="list">${d.invoices.map((i) => invoiceRow(i, i.number))}</div>` : html`<p class="panel-sub">No invoices yet. The first goes out on ${fmtDate(c.start_date)}.</p>`}
        <details><summary>Bill something extra</summary>
          <form class="inline" id="extra" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
            <input class="input" name="description" placeholder="What it's for, like Testing day, Oct 3" style="flex:2 1 260px;width:auto" aria-label="Description">
            <input class="input" name="amount" inputmode="decimal" placeholder="Amount ($)" style="flex:1 1 120px;width:auto" aria-label="Amount in dollars">
            <button class="btn">Send invoice</button></form>
          <p class="hint">It goes on its own invoice, emailed to ${c.billing_email || 'the billing contact'} with the contract's payment terms.</p></details>
      </section>
      <div class="cols">
        <div class="col">
          <section class="panel"><div><h2 class="panel-title">Contract</h2>
            <p class="panel-sub">${money(c.monthly_cents)}/month since ${fmtDate(c.start_date)}${c.next_invoice ? ` · next invoice ${fmtDate(c.next_invoice)}` : ''}</p></div>
            <form class="stack" id="ct" novalidate>
              <div class="grid4">
                <div class="field"><label class="label" for="ct-f">Monthly fee ($)</label><input class="input" id="ct-f" name="monthly_fee" inputmode="decimal" value="${dollars(c.monthly_cents)}"></div>
                <div class="field"><label class="label" for="ct-e">End date</label><input class="input" id="ct-e" name="end_date" type="date" value="${c.end_date || ''}"></div>
                <div class="field"><label class="label" for="ct-t">Terms</label><select class="input" id="ct-t" name="terms_days">${options(TERMS.some((t) => t.id === c.terms_days) ? TERMS : [...TERMS, { id: c.terms_days, name: `Net ${c.terms_days}` }], c.terms_days)}</select></div>
                <div class="field"><label class="label" for="ct-po">PO number</label><input class="input" id="ct-po" name="po_number" value="${c.po_number || ''}"></div>
              </div>
              <p class="hint" style="margin:-8px 0 0">A new fee applies from the next invoice.</p>
              <div class="label">Billing contact at ${c.school_name}</div>
              <div class="form-grid">
                <div class="field"><label class="label" for="ct-bn">Name</label><input class="input" id="ct-bn" name="billing_name" value="${c.billing_name || ''}"></div>
                <div class="field"><label class="label" for="ct-be">Email</label><input class="input" id="ct-be" name="billing_email" type="email" value="${c.billing_email || ''}"><span class="hint">Invoices go here.</span></div>
              </div>
              <div class="field"><label class="label" for="ct-a">Billing address</label><textarea class="input" id="ct-a" name="address" rows="2" style="min-height:72px">${c.school_address || ''}</textarea></div>
              <div class="spread"><button class="btn btn-primary" type="submit">Save</button>${ended ? '' : html`<button class="btn btn-ghost" type="button" data-act="end">End contract</button>`}</div>
            </form></section>
          <section class="panel">
            <div class="panel-head"><div><h2 class="panel-title">Team sessions</h2><p class="panel-sub">${d.sessions.length ? d.sessions.map((s) => `${s.days} at ${s.start_time}`).join('; ') : 'Not on the schedule yet.'}</p></div>
              <a class="btn btn-sm" href="/app/schedule">Schedule</a></div>
            ${d.sessions.length ? html`<div class="list">${d.sessions.map((s) => html`<div class="list-row"><div class="grow"><div>${s.days} at ${s.start_time} · ${s.duration_min} min</div>
              <div class="row-sub">${s.location || 'No location'}${s.next ? ` · next ${fmtDate(s.next.slice(0, 10), { weekday: true, year: false })}` : ''}</div></div>
              <button class="btn btn-ghost btn-sm" data-act="rm-session" data-id="${s.id}">Remove</button></div>`)}</div>` : ''}
            ${ended ? '' : html`<form class="stack" id="ss" novalidate>
              <fieldset style="border:0;padding:0"><legend class="sr-only">Days</legend><div class="days">${WD.map((w, i) => html`<label class="check"><input type="checkbox" name="weekdays" value="${i}" data-multi> ${w}</label>`)}</div></fieldset>
              <div class="grid4">
                <div class="field"><label class="label" for="ss-l">Where</label><select class="input" id="ss-l" name="location_id">${options(d.locations, d.locations[0]?.id)}</select></div>
                <div class="field"><label class="label" for="ss-t">Starts</label><input class="input" id="ss-t" name="start_time" type="time" value="15:30"></div>
                <div class="field"><label class="label" for="ss-m">Minutes</label><input class="input" id="ss-m" name="duration_min" type="number" min="15" max="300" value="60"></div>
                <div class="field"><label class="label" for="ss-d">First day</label><input class="input" id="ss-d" name="start_date" type="date" value="${localISO()}"></div>
              </div>
              <div><button class="btn">Add team sessions</button></div></form>`}
          </section>
        </div>
        <div class="col">
          <section class="panel"><div><h2 class="panel-title">Roster · ${d.roster.length}</h2><p class="panel-sub">Check athletes in from each team session. Attendance builds up here.</p></div>
            ${d.roster.length ? html`<div class="list">${d.roster.map((a) => html`<div class="list-row">
              <div class="grow"><a class="row-title" href="/app/clients/${a.id}">${a.first_name} ${a.last_name}</a>
                <div class="row-sub"><span class="mono" style="font-size:12px">${a.code}</span>${a.position ? ` · ${a.position}` : ''} · ${a.attendance_rate == null ? 'no sessions yet' : `attendance ${Math.round(a.attendance_rate * 100)}% (${a.attended} of ${a.sessions})`}</div></div>
              <button class="btn btn-ghost btn-sm" data-act="rm-athlete" data-id="${a.id}" data-name="${a.first_name} ${a.last_name}">Remove</button></div>`)}</div>` : html`<p class="panel-sub">No athletes yet. Paste the team list below.</p>`}
            <form class="stack-sm" id="ro">
              <label class="sr-only" for="ro-t">Team list</label>
              <textarea class="input" id="ro-t" name="text" rows="3" placeholder="${'One athlete per line: Name, position, grad year\nJalen Brooks, QB, 2027\nMarcus Hill, WR, 2028'}"></textarea>
              <div><button class="btn">Add to roster</button></div>
              <p class="hint" style="margin:0">Each player gets an Athlete ID. Names already on the roster are skipped.</p></form>
          </section>
        </div>
      </div></div>`);
    bind(c);
  }

  function bind(c) {
    const root = ctx.el.querySelector('.tm');
    root.addEventListener('click', async (e) => {
      const inv = e.target.closest('[data-inv]');
      if (inv) return invoiceAction(inv, draw);
      const b = e.target.closest('[data-act]');
      if (!b) return;
      try {
        if (b.dataset.act === 'end') {
          if (!(await confirmDialog('End this contract?', 'No more invoices go out, and future team sessions come off the schedule. Unpaid invoices stay open.', 'End contract', 'warn'))) return;
          await api.post(`/teams/${c.id}/end`); toast('Contract ended.');
        } else if (b.dataset.act === 'rm-session') {
          if (!(await confirmDialog('Remove these team sessions?', 'Future sessions come off the schedule. Past attendance is kept.', 'Remove sessions', 'warn'))) return;
          await api.post(`/teams/${c.id}/sessions/${b.dataset.id}/remove`); toast('Team sessions removed.');
        } else if (b.dataset.act === 'rm-athlete') {
          if (!(await confirmDialog(`Remove ${b.dataset.name}?`, 'They come off this roster. Their profile and results are kept.', 'Remove', 'warn'))) return;
          await api.post(`/teams/${c.id}/roster/${b.dataset.id}/remove`); toast('Removed from the roster.');
        }
        await draw();
      } catch (err) { toastError(err); }
    });
    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button[type=submit], button:not([type])');
      if (btn) btn.disabled = true;
      try {
        const d = formData(f);
        if (f.id === 'ct') { await api.put(`/teams/${c.id}`, d); toast('Contract saved.'); }
        else if (f.id === 'ss') { const r = await api.post(`/teams/${c.id}/sessions`, d); toast(`Team sessions added to the schedule (${plural(r.sessions_created, 'session')} over the next 8 weeks).`); }
        else if (f.id === 'ro') { const r = await api.post(`/teams/${c.id}/roster`, d); toast(`${plural(r.added, 'athlete')} added${r.skipped ? `, ${r.skipped} already on the roster` : ''}.`); }
        else if (f.id === 'extra') { const r = await api.post(`/teams/${c.id}/invoices`, d); toast(`${r.number} ${r.emailed ? 'sent' : 'created. Add a billing email to send it'}.`); }
        await draw();
      } catch (err) { toastError(err); }
      finally { if (btn?.isConnected) btn.disabled = false; }
    });
  }
  await draw();
}

// ---------------------------------------------------------------- new contract
async function renderNew(ctx) {
  const schools = await api.get('/schools');
  if (!ctx.isCurrent()) return;
  mount(ctx.el, html`${STYLE}<div class="stack tm">
    <div class="page-header"><div><h1 class="page-title">New team contract</h1><p class="page-sub">A flat monthly fee, invoiced to the school or club at the start of each month of the contract.</p></div>
      <a class="btn" href="/app/teams">Cancel</a></div>
    <form class="panel tm-new stack" id="nt" novalidate>
      <div class="field"><label class="label" for="nt-s">School or club</label>
        <select class="input" id="nt-s" name="school_id"><option value="new">A new school or club…</option>${options(schools, '')}</select></div>
      <div class="field" id="nt-newname"><label class="label" for="nt-sn">School or club name</label><input class="input" id="nt-sn" name="school_name" autocomplete="off"></div>
      <div class="form-grid">
        <div class="field"><label class="label" for="nt-bn">Billing contact</label><input class="input" id="nt-bn" name="billing_name" autocomplete="off"><span class="hint">Athletic director or treasurer</span></div>
        <div class="field"><label class="label" for="nt-be">Billing email</label><input class="input" id="nt-be" name="billing_email" type="email" autocomplete="off"><span class="hint">Invoices go here.</span></div>
      </div>
      <div class="field"><label class="label" for="nt-a">Billing address</label><textarea class="input" id="nt-a" name="address" rows="2" style="min-height:72px"></textarea></div>
      <div class="form-grid">
        <div class="field"><label class="label" for="nt-t">Team</label><input class="input" id="nt-t" name="team_name" placeholder="Varsity Football"></div>
        <div class="field"><label class="label" for="nt-f">Monthly fee ($)</label><input class="input" id="nt-f" name="monthly_fee" inputmode="decimal"></div>
      </div>
      <div class="grid4">
        <div class="field"><label class="label" for="nt-sd">Start</label><input class="input" id="nt-sd" name="start_date" type="date" value="${localISO()}"><span class="hint">Billing day each month</span></div>
        <div class="field"><label class="label" for="nt-ed">End (optional)</label><input class="input" id="nt-ed" name="end_date" type="date"></div>
        <div class="field"><label class="label" for="nt-tm">Payment terms</label><select class="input" id="nt-tm" name="terms_days">${options(TERMS, 30)}</select></div>
        <div class="field"><label class="label" for="nt-po">PO number</label><input class="input" id="nt-po" name="po_number"></div>
      </div>
      <p class="hint" style="margin:0">If the start date is today or earlier, the first month is invoiced as soon as you save. Months already past are invoiced too.</p>
      <div class="error" id="nt-err" role="alert"></div>
      <div><button class="btn btn-primary" type="submit">Create contract</button></div>
    </form></div>`);
  const f = ctx.el.querySelector('#nt');
  const sel = f.querySelector('#nt-s');
  sel.addEventListener('change', () => {
    const s = schools.find((x) => String(x.id) === sel.value);
    f.querySelector('#nt-newname').hidden = !!s;
    f.billing_name.value = s?.contact_name || '';
    f.billing_email.value = s?.contact_email || '';
    f.address.value = s?.address || '';
  });
  f.school_name.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = f.querySelector('#nt-err'); err.textContent = '';
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const r = await api.post('/teams', formData(f));
      toast(r.invoices ? `Contract created. ${plural(r.invoices, 'invoice')} emailed.` : 'Contract created. The first invoice goes out on the start date.');
      ctx.go(`/app/teams/${r.id}`);
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  });
}

export const routes = [
  { path: '/teams', nav: 'teams', title: 'Teams', roles: ['owner'], render: renderList },
  { path: '/teams/new', nav: 'teams', title: 'New team contract', roles: ['owner'], render: renderNew },
  { path: '/teams/:id', nav: 'teams', title: 'Team contract', roles: ['owner'], render: renderTeam },
];
