// Staff & security: a security summary, staff accounts (add, edit, roles, devices, hand-over when someone leaves),
// what each role can do, backups and the activity log (filters, CSV); plus /app/account for your own password and devices.
import { html, raw, mount, api, toast, toastError, modal, confirmDialog, formData, relTime, fmtDate, fmtDateTime, badge, debounce, plural, localISO, passwordField, bindPasswordFields } from '/js/ui.js';

const ROLE_LABEL = { owner: 'Owner', coach: 'Coach', frontdesk: 'Front desk' };
const ROLE_HINT = {
  owner: 'Everything, including billing, school contracts, API keys, staff and backups.',
  coach: 'Clients, schedule, testing, programs and point of sale. Never sees money: no billing, contracts, refunds, API keys or staff.',
  frontdesk: 'Check-ins, sales, bookings and entering results. Can view the schedule, programs and tests but not change them.',
};
// What each role can do, for the table under the staff list. Mirrors the server's role checks.
const CAN = [
  ['Check in, book and sell at the front desk', 1, 1, 1],
  ['Enter test results', 1, 1, 1],
  ['Add and edit clients and families', 1, 1, 1],
  ['Change classes, sessions and private hours', 1, 1, 0],
  ['Build and assign programs, edit the test library', 1, 1, 0],
  ['See revenue, invoices and membership prices', 1, 0, 0],
  ['Refunds, school contracts and billing', 1, 0, 0],
  ['API keys, webhooks and the email outbox', 1, 0, 0],
  ['Staff, the activity log and backups', 1, 0, 0],
];
const WHO = [['', 'Everyone'], ['staff', 'Staff'], ['parent', 'Parents'], ['athlete', 'Athletes'], ['api', 'API keys'], ['system', 'System']];
const KINDS = [['', 'All'], ['change', 'Changes'], ['refused', 'Refused'], ['signin', 'Sign-ins']];
const EMPTY = { kind: '', who: '', staff: '', from: '', to: '', q: '' };

const STYLE = html`<style>
.dps{display:flex;flex-direction:column;gap:var(--space-6)}
.dps-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--space-4)}
.dps-tile{text-align:left;cursor:pointer;font:inherit;color:inherit;min-height:44px}
.dps-tile:hover{background:var(--surface-raised)}
.dps-tile .metric-value{font-size:28px}
.dps-tile.warn{border-color:var(--amber)}
.dps-row{display:flex;align-items:center;gap:var(--space-3);padding:14px 0;border-top:1px solid var(--line-subtle);flex-wrap:wrap}
.dps-row .grow{flex:1;min-width:220px}
.dps-row .role{min-width:96px;color:var(--steel-muted);font-size:14px}
.dps-you{font-size:13px;color:var(--steel-muted);font-weight:500}
.dps-work{font-size:13px}
.dps-can{width:100%;border-collapse:collapse;font-size:14px}
.dps-can th,.dps-can td{padding:8px 10px;border-top:1px solid var(--line-subtle);text-align:center}
.dps-can th:first-child,.dps-can td:first-child{text-align:left}
.dps-can thead th{border-top:0;color:var(--steel-muted);font-weight:500;font-size:13px}
.dps-can .yes{color:var(--green-bright)} .dps-can .no{color:var(--steel-muted)}
details.dps-more>summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600;color:var(--steel-muted)}
details.dps-more>summary:hover{color:var(--steel)}
.dps-bk{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:4px 16px;align-items:center;font-size:14px}
.dps-bk>div{padding:6px 0;border-top:1px solid var(--line-subtle)}
.dps .seg{align-self:flex-start}
.dps-filters{display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:flex-end}
.dps-filters .field{min-width:150px;flex:1 1 150px;max-width:220px}
.dps-filters .field.q{max-width:320px;flex-basis:220px}
.dps-log td{font-size:14px;line-height:20px}
.dps-log td.when{white-space:nowrap;color:var(--steel-muted)}
.dps-log td.ip{font:400 12px/18px var(--font-mono);color:var(--steel-muted);white-space:nowrap}
.dps-pager{display:flex;align-items:center;gap:var(--space-3);justify-content:flex-end;flex-wrap:wrap}
.dps-roles{display:flex;flex-direction:column;gap:var(--space-2)}
.dps-roles label{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm);cursor:pointer;min-height:44px}
.dps-roles label:has(input:checked){border-color:var(--green-mid);background:var(--green-deep)}
.dps-roles input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--green-mid);flex-shrink:0}
.dps-roles .about{display:block;font-size:13px;line-height:18px;color:var(--steel-muted)}
.dps-dev{display:flex;align-items:center;gap:var(--space-3);padding:10px 0;border-top:1px solid var(--line-subtle);flex-wrap:wrap}
.dps-dev .grow{flex:1;min-width:180px}
.dps-recent{display:flex;flex-direction:column;font-size:14px}
.dps-recent>div{display:flex;gap:var(--space-3);justify-content:space-between;padding:6px 0;border-top:1px solid var(--line-subtle)}
.dps-hand{border:1px solid var(--amber);background:var(--amber-deep);border-radius:var(--radius-sm);padding:var(--space-3) var(--space-4);display:flex;flex-direction:column;gap:var(--space-2)}
.dps-hand p{margin:0;color:var(--amber)}
@media (max-width:900px){
  .dps .btn-sm,.modal .btn-sm{min-height:44px}
  .dps .seg button{min-height:44px}
  .dps-tiles{grid-template-columns:1fr 1fr;gap:var(--space-3)}
  .dps-tile{padding:var(--space-3)}
  .dps-tile .metric-value{font-size:22px}
}
@media (max-width:700px){
  .dps-log thead{display:none}
  .dps-log,.dps-log tbody{display:block}
  .dps-log tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:10px 14px;border-bottom:1px solid var(--line-subtle)}
  .dps-log tr:last-child{border-bottom:0}
  .dps-log td{padding:0;border:0}
  .dps-log td.what{grid-column:1;grid-row:1;font-weight:600}
  .dps-log td.res{grid-column:2;grid-row:1;text-align:right}
  .dps-log td.who,.dps-log td.detail,.dps-log td.when,.dps-log td.ip{grid-column:1/-1;font-size:13px;line-height:18px}
  .dps-log td:empty{display:none}
  .dps-filters{display:grid;grid-template-columns:1fr 1fr}
  .dps-filters .field{max-width:none;min-width:0}
  .dps-filters .field.q,.dps-filters #lclear{grid-column:1/-1}
  .dps .seg{display:flex;flex-wrap:nowrap;align-self:stretch}
  .dps .seg button{flex:1 1 auto;padding:0 6px;font-size:13px;white-space:nowrap}
  .dps-row .grow{min-width:100%}
  .dps-row .role{flex:1}
}
</style>`;

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const DAY = 864e5;
// Recent entries read best as "2 hr ago"; anything older needs the actual day and time for an audit trail.
const when = (t) => (t && Date.now() - new Date(t).getTime() < DAY ? relTime(t) : fmtDateTime(t));
const workText = (w) => [w.sessions && plural(w.sessions, 'upcoming session'), w.classes && plural(w.classes, 'weekly class', 'weekly classes'),
  w.hours && `${plural(w.hours, 'block')} of private hours`].filter(Boolean).join(', ');
const hasWork = (w) => !!(w && (w.sessions || w.classes || w.hours));

function result(a) {
  if (a.kind === 'refused') return badge('failed', 'Refused');
  if (/fail/i.test(a.action)) return badge('failed', 'Failed');
  if (a.kind === 'signin') return badge('neutral', 'Sign-in');
  return badge('active', 'OK');
}
// A failed sign-in or reset request has no signed-in person; show the email that was typed instead of "System".
const typedEmail = (a) => a.kind === 'signin' && (!a.actor || a.actor === 'System') && a.detail;
const whoOf = (a) => (typedEmail(a) ? a.detail : a.actor || 'System');
function status(s) {
  if (!s.active) return badge('off', 'Turned off');
  if (s.locked) return badge('locked');
  if (s.must_change) return badge('neutral', s.last_signed_in ? 'Must choose a new password' : 'Invited, not signed in yet');
  return '';
}

// A hand-over picker for a coach's future sessions: another active coach or owner, nobody, or leave as is.
function handPicker(s, staff, { keepLabel } = {}) {
  if (!hasWork(s.work)) return '';
  // Coaches first, so the default choice is another coach rather than the owner.
  const others = staff.filter((x) => x.active && x.id !== s.id && ['owner', 'coach'].includes(x.role))
    .sort((a, b) => (a.role === 'coach' ? 0 : 1) - (b.role === 'coach' ? 0 : 1));
  return html`<div class="dps-hand"><p>${s.name} leads ${workText(s.work)}.</p>
    <div class="field"><label class="label" for="hand">Hand them to</label>
    <select class="input" id="hand" name="hand_to">
      ${others.map((x) => html`<option value="${x.id}">${x.name} (${ROLE_LABEL[x.role]})</option>`)}
      <option value="">No coach (unassigned)</option>
      <option value="keep">${keepLabel || `Leave them with ${s.name}`}</option>
    </select><span class="hint">Past sessions keep their coach. You can change any session later in Schedule.</span></div></div>`;
}
const handValue = (el) => { const v = el.querySelector('#hand')?.value; return v === undefined || v === 'keep' ? undefined : v; };

async function renderStaff(ctx) {
  const [staff, backups, sum] = await Promise.all([api.get('/staff'), api.get('/backups'), api.get('/staff/summary')]);
  if (!ctx.isCurrent()) return;
  const on = staff.filter((s) => s.active), off = staff.filter((s) => !s.active);
  const testMail = ctx.settings?.email_mode === 'test';
  const bkRow = (b) => html`<div>${fmtDateTime(b.created_at)}</div><div class="muted small" style="text-align:right">${kb(b.size)}</div>
    <div><a class="btn btn-ghost btn-sm" href="/api/backups/${b.name}" download="${b.name}" aria-label="Download backup from ${fmtDateTime(b.created_at)}">Download</a></div>`;
  const row = (s) => html`<div class="dps-row" data-sid="${s.id}">
    <div class="grow">
      <div class="row" style="gap:8px"><span class="strong">${s.name}</span>${s.id === ctx.me.id ? html`<span class="dps-you">(you)</span>` : ''}${status(s)}</div>
      <div class="small muted">${s.email} · ${s.last_signed_in ? `last signed in ${when(s.last_signed_in)}` : `added ${fmtDate(s.created_at)}, never signed in`}${s.locked ? ` · locked until ${fmtDateTime(s.locked_until)}` : ''}</div>
      ${!s.active && hasWork(s.work) ? html`<div class="dps-work warn-text">Still leads ${workText(s.work)}. Open Manage to hand them over.</div>` : ''}
    </div>
    <span class="role">${ROLE_LABEL[s.role]}</span>
    <div class="btn-row">
      ${s.locked ? html`<button class="btn btn-sm btn-warn" data-unlock="${s.id}">Unlock</button>` : ''}
      ${!s.active ? html`<button class="btn btn-sm" data-on="${s.id}">Turn on</button>` : ''}
      <button class="btn btn-sm" data-manage="${s.id}" aria-label="Manage ${s.name}">Manage</button>
    </div>
  </div>`;

  mount(ctx.el, html`${STYLE}<div class="dps">
  <div class="page-header"><div><h1 class="page-title">Staff & security</h1><p class="page-sub">Who can sign in, what they can do, what happened, and your backups.</p></div>
    <button class="btn btn-primary" id="add">Add staff member</button></div>

  <div class="dps-tiles" role="group" aria-label="Security summary">
    <button class="metric dps-tile" data-go="staff"><span class="metric-label">Staff who can sign in</span><span class="metric-value">${sum.active}</span>
      <span class="metric-note">${sum.waiting ? `${sum.waiting} not signed in yet` : off.length ? `${off.length} turned off` : 'All set up'}</span></button>
    <button class="metric dps-tile ${sum.locked ? 'warn' : ''}" data-go="staff"><span class="metric-label">Locked accounts</span><span class="metric-value ${sum.locked ? 'warn' : ''}">${sum.locked}</span>
      <span class="metric-note">${sum.locked ? 'Unlock them below' : 'None locked'}</span></button>
    <button class="metric dps-tile ${sum.failed_24h >= 10 ? 'warn' : ''}" data-go="failed"><span class="metric-label">Failed sign-ins, 24 hours</span><span class="metric-value ${sum.failed_24h >= 10 ? 'warn' : ''}">${sum.failed_24h}</span>
      <span class="metric-note">${sum.refused_7d ? `${plural(sum.refused_7d, 'refused attempt')} this week` : 'No refused attempts this week'}</span></button>
    <button class="metric dps-tile ${sum.backup_stale ? 'warn' : ''}" data-go="backups"><span class="metric-label">Last backup</span><span class="metric-value ${sum.backup_stale ? 'warn' : 'good'}" style="font-size:22px;line-height:34px">${sum.last_backup_at ? when(sum.last_backup_at) : 'None yet'}</span>
      <span class="metric-note">${sum.backup_stale ? 'Overdue. Back up now.' : 'Daily backups are running'}</span></button>
  </div>

  <section class="panel" aria-labelledby="st-t" id="staff">
    <div><h2 class="panel-title" id="st-t">Staff</h2><p class="panel-sub">Each person gets their own sign-in. Roles decide what they can see and do. Open Manage to edit details, change a role, see devices or turn an account off.</p></div>
    <div>${on.map(row)}</div>
    ${off.length ? html`<details class="dps-more"><summary>${plural(off.length, 'turned-off account')}</summary><div>${off.map(row)}</div></details>` : ''}
    <details class="dps-more"><summary>What each role can do</summary>
      <div class="table-wrap" style="border:0"><table class="dps-can"><thead><tr><th scope="col">Job</th><th scope="col">Owner</th><th scope="col">Coach</th><th scope="col">Front desk</th></tr></thead>
      <tbody>${CAN.map(([job, ...r]) => html`<tr><td>${job}</td>${r.map((y) => html`<td class="${y ? 'yes' : 'no'}">${y ? 'Yes' : 'No'}</td>`)}</tr>`)}</tbody></table></div>
    </details>
  </section>

  <section class="panel" aria-labelledby="bk-t" id="backups" style="max-width:720px">
    <div><h2 class="panel-title" id="bk-t">Backups</h2><p class="panel-sub">A full copy of everything is saved every day, and the last ${backups.keep} are kept. Download one now and then and keep it somewhere safe, off this server.</p></div>
    ${sum.backup_stale ? html`<div class="banner" role="status">${sum.last_backup_at ? `The last backup was ${when(sum.last_backup_at)}. The daily backup should have run since.` : 'No backup has been made yet.'} Back up now to be safe.</div>` : ''}
    ${backups.items.length ? html`<div class="dps-bk">${backups.items.slice(0, 5).map(bkRow)}</div>
      ${backups.items.length > 5 ? html`<details class="dps-more"><summary>Show all ${backups.items.length} backups (${kb(backups.total_size)} in total)</summary><div class="dps-bk">${backups.items.slice(5).map(bkRow)}</div></details>` : ''}`
      : html`<p class="muted" style="margin:0">No backups yet. The first one runs within the hour, or back up now.</p>`}
    <div><button class="btn" id="bknow">Back up now</button></div>
    <p class="hint" style="margin:0">Backup files contain client, family and medical information. Store them like you would paper records. Every download is recorded in the activity log.</p>
  </section>

  <section class="panel" aria-labelledby="log-t" id="activity">
    <div class="panel-head"><div><h2 class="panel-title" id="log-t">Activity log</h2><p class="panel-sub">Every change, refused attempt and sign-in by staff, API keys, parents and athletes, with where it came from.</p></div>
      <a class="btn btn-sm" id="csv" href="/api/staff/activity.csv" download>Download CSV</a></div>
    <div class="seg" role="group" aria-label="Show">${KINDS.map(([k, l]) => html`<button type="button" data-kind="${k}" aria-pressed="${k === '' ? 'true' : 'false'}">${l}</button>`)}</div>
    <div class="dps-filters">
      <div class="field"><label class="label" for="lwho">Who</label><select class="input" id="lwho">${WHO.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>
      <div class="field"><label class="label" for="lstaff">Staff member</label><select class="input" id="lstaff"><option value="">Anyone</option>${staff.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
      <div class="field"><label class="label" for="lfrom">From</label><input class="input" type="date" id="lfrom" max="${localISO()}"></div>
      <div class="field"><label class="label" for="lto">To</label><input class="input" type="date" id="lto" max="${localISO()}"></div>
      <div class="field q"><label class="label" for="lq">Search</label><input class="input" type="search" id="lq" placeholder="Who, what, detail or IP"></div>
      <button type="button" class="btn btn-ghost" id="lclear" hidden>Clear filters</button>
    </div>
    <div id="log" aria-live="polite"></div>
  </section></div>`);

  const el = ctx.el;
  const byId = Object.fromEntries(staff.map((s) => [s.id, s]));
  const act = async (fn, msg) => { try { await fn(); toast(msg); ctx.reload(); } catch (err) { toastError(err); } };

  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.go === 'failed') { setFilters({ kind: 'signin', q: 'Sign-in failed' }); return; }
    el.querySelector('#' + b.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  el.querySelector('#add').addEventListener('click', () => addStaff(ctx, testMail));
  el.querySelectorAll('[data-manage]').forEach((b) => b.addEventListener('click', () => manage(ctx, byId[b.dataset.manage], staff, (id) => setFilters({ staff: String(id) }))));
  el.querySelectorAll('[data-unlock]').forEach((b) => b.addEventListener('click', () => act(() => api.post(`/staff/${b.dataset.unlock}/unlock`), `${byId[b.dataset.unlock].name} can sign in again.`)));
  el.querySelectorAll('[data-on]').forEach((b) => b.addEventListener('click', () => act(() => api.post(`/staff/${b.dataset.on}/turn-on`), `${byId[b.dataset.on].name} can sign in again with their password.`)));
  el.querySelector('#bknow').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Backing up…';
    try { const r = await api.post('/backups'); toast(`Backup saved (${kb(r.size)}).`); ctx.reload(); }
    catch (err) { toastError(err); btn.disabled = false; btn.textContent = 'Back up now'; }
  });

  // ---- activity log ----
  const box = el.querySelector('#log');
  const f = { ...EMPTY };
  let page = 1, seq = 0;
  const inputs = { who: el.querySelector('#lwho'), staff: el.querySelector('#lstaff'), from: el.querySelector('#lfrom'), to: el.querySelector('#lto'), q: el.querySelector('#lq') };
  const filtered = () => Object.keys(EMPTY).some((k) => f[k]);
  const query = () => {
    const p = new URLSearchParams();
    if (f.kind) p.set('kind', f.kind);
    if (f.who) p.set('who', f.who);
    if (f.staff) p.set('staff_id', f.staff);
    // Dates are local days; the server stores and compares UTC.
    if (f.from) p.set('since', new Date(f.from + 'T00:00:00').toISOString());
    if (f.to) p.set('until', new Date(new Date(f.to + 'T00:00:00').getTime() + DAY).toISOString());
    if (f.q) p.set('q', f.q);
    return p;
  };
  const load = async () => {
    const my = ++seq;
    const p = query();
    el.querySelector('#csv').href = '/api/staff/activity.csv' + (p.toString() ? '?' + p : '');
    el.querySelector('#lclear').hidden = !filtered();
    p.set('page', page); p.set('per', 25);
    box.setAttribute('aria-busy', 'true');
    let r;
    try { r = await api.get('/staff/activity?' + p); }
    catch (err) {
      if (my !== seq || !ctx.isCurrent()) return;
      mount(box, html`<div class="banner">${err.message} <button class="btn btn-sm" id="lretry">Try again</button></div>`);
      box.querySelector('#lretry').addEventListener('click', load);
      return;
    } finally { if (my === seq) box.removeAttribute('aria-busy'); }
    if (!ctx.isCurrent() || my !== seq) return;
    mount(box, r.items.length ? html`<div class="table-wrap"><table class="table dps-log">
      <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th><th>From</th><th>Result</th></tr></thead>
      <tbody>${r.items.map((a) => html`<tr>
        <td class="when"><time datetime="${a.created_at}" title="${fmtDateTime(a.created_at)}">${when(a.created_at)}</time></td><td class="who">${whoOf(a)}</td><td class="what">${a.action}</td>
        <td class="detail muted">${typedEmail(a) ? '' : a.detail || ''}</td><td class="ip">${a.ip || ''}</td><td class="res">${result(a)}</td></tr>`)}</tbody></table></div>
      <div class="dps-pager"><span class="small muted">Page ${r.page} of ${r.pages} · ${plural(r.total, 'entry', 'entries')}</span>
        <button class="btn btn-sm" data-page="-1" ${r.page <= 1 ? raw('disabled') : ''}>Newer</button>
        <button class="btn btn-sm" data-page="1" ${r.page >= r.pages ? raw('disabled') : ''}>Older</button></div>`
      : html`<div class="empty">${filtered() ? html`Nothing matches these filters. <button class="link-btn" id="lclear2">Clear filters</button>` : 'Nothing has happened yet.'}</div>`);
    box.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { page += Number(b.dataset.page); load(); }));
    box.querySelector('#lclear2')?.addEventListener('click', () => setFilters({}, false));
  };
  function syncInputs() {
    el.querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.kind === f.kind)));
    for (const k of Object.keys(inputs)) inputs[k].value = f[k];
  }
  function setFilters(next, scroll = true) {
    Object.assign(f, EMPTY, next);
    page = 1; syncInputs(); load();
    if (scroll) el.querySelector('#activity').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  el.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { f.kind = b.dataset.kind; page = 1; syncInputs(); load(); }));
  for (const k of ['who', 'staff', 'from', 'to']) inputs[k].addEventListener('change', () => {
    f[k] = inputs[k].value;
    if (k === 'from' && f.to && f.from > f.to) { f.to = f.from; inputs.to.value = f.to; }
    if (k === 'to' && f.from && f.to && f.to < f.from) { f.from = f.to; inputs.from.value = f.from; }
    page = 1; load();
  });
  inputs.q.addEventListener('input', debounce(() => { f.q = inputs.q.value.trim(); page = 1; load(); }, 250));
  el.querySelector('#lclear').addEventListener('click', () => setFilters({}, false));
  if (ctx.query.person && byId[ctx.query.person]) { f.staff = String(ctx.query.person); syncInputs(); }
  await load();
}

// ---- add a staff member ----
function addStaff(ctx, testMail) {
  return modal({
    title: 'Add staff member',
    body: html`<form class="stack" id="addf" novalidate>
      <div class="field"><label class="label" for="sn">Name</label><input class="input" id="sn" name="name" autocomplete="off" maxlength="80" autofocus></div>
      <div class="field"><label class="label" for="se">Email</label><input class="input" id="se" name="email" type="email" autocomplete="off"><span class="hint">They sign in with this email. Their one-time password goes here.</span></div>
      <fieldset><legend>Role</legend><div class="dps-roles">${['coach', 'frontdesk', 'owner'].map((r, i) => html`
        <label><input type="radio" name="role" value="${r}" ${i === 0 ? raw('checked') : ''}><span><span class="strong">${ROLE_LABEL[r]}</span><span class="about">${ROLE_HINT[r]}</span></span></label>`)}</div></fieldset>
      <div class="error" id="adderr" role="alert"></div>
      ${testMail ? html`<p class="hint" style="margin:0">Test mode: the welcome email goes to the outbox in API & integrations, not their inbox.</p>` : ''}
      <button type="submit" hidden></button>
    </form>`,
    onMount: (body) => {
      body.querySelector('#addf').addEventListener('submit', (e) => { e.preventDefault(); body.closest('.modal').querySelector('.modal-actions .btn-primary').click(); });
    },
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Add and email one-time password', kind: 'primary',
      onClick: async (body) => {
        const form = body.querySelector('#addf'), err = body.querySelector('#adderr');
        const d = formData(form);
        const problem = !d.name.trim() ? ['name', 'Enter their name.'] : !/^\S+@\S+\.\S+$/.test(d.email.trim()) ? ['email', 'Enter a valid email address.'] : null;
        form.querySelectorAll('[aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
        err.textContent = '';
        if (problem) { err.textContent = problem[1]; form[problem[0]].setAttribute('aria-invalid', 'true'); form[problem[0]].focus(); return false; }
        try { await api.post('/staff', d); }
        catch (x) { err.textContent = x.message; return false; }
        toast(`${d.name.trim()} added as ${ROLE_LABEL[d.role]}. Their one-time password is on its way to ${d.email.trim().toLowerCase()}.`);
        ctx.reload();
        return true;
      },
    }],
  });
}

// ---- manage one person: details, edit, role, devices, password, turn off, hand over ----
async function manage(ctx, s0, staff, onActivity) {
  let s;
  try { s = await api.get(`/staff/${s0.id}`); } catch (err) { toastError(err); return; }
  const self = s.id === ctx.me.id;
  const invite = s.must_change && !s.last_signed_in;
  await modal({
    title: s.name, wide: true,
    body: html`
      <div class="row" style="gap:8px">${badge('neutral', ROLE_LABEL[s.role])}${status(s)}${self ? html`<span class="dps-you">(you)</span>` : ''}</div>
      <dl class="kv small">
        <dt>Last sign-in</dt><dd>${s.last_signed_in ? `${fmtDateTime(s.last_signed_in)}${s.last_signin_ip ? ` from ${s.last_signin_ip}` : ''}` : 'Never'}</dd>
        <dt>Added</dt><dd>${fmtDate(s.created_at)}</dd>
        ${hasWork(s.work) ? html`<dt>Leads</dt><dd>${workText(s.work)} · <a href="/app/schedule?coach=${s.id}">See in Schedule</a></dd>` : ''}
      </dl>

      ${s.active ? html`<form class="stack-sm" id="editf" novalidate>
        <h3 class="panel-title" style="font-size:16px">Details and role</h3>
        <div class="form-grid">
          <div class="field"><label class="label" for="en">Name</label><input class="input" id="en" name="name" value="${s.name}" maxlength="80"></div>
          <div class="field"><label class="label" for="ee">Email</label><input class="input" id="ee" name="email" type="email" value="${s.email}"></div>
          <div class="field"><label class="label" for="er">Role</label><select class="input" id="er" name="role">${Object.entries(ROLE_LABEL).map(([v, l]) => html`<option value="${v}" ${v === s.role ? raw('selected') : ''}>${l}</option>`)}</select></div>
        </div>
        <p class="hint" id="erhint" style="margin:0">${ROLE_LABEL[s.role]}: ${ROLE_HINT[s.role]}</p>
        <div id="erhand"></div>
        <div class="error" id="editerr" role="alert"></div>
        <div><button class="btn" id="save" disabled>Save changes</button></div>
      </form>` : ''}

      <div class="stack-sm">
        <div class="spread"><h3 class="panel-title" style="font-size:16px">Signed in on</h3>
          ${s.sessions.filter((d) => !d.current).length ? html`<button type="button" class="btn btn-sm" id="signout">${self ? 'Sign out my other devices' : 'Sign out everywhere'}</button>` : ''}</div>
        ${s.sessions.length ? s.sessions.map((d) => html`<div class="dps-dev"><div class="grow"><span class="strong">${d.device}</span>${d.current ? html` <span class="dps-you">(this device)</span>` : ''}
          <div class="small muted">Last active ${when(d.last_seen)}${d.ip ? ` · ${d.ip}` : ''} · signed in ${fmtDate(d.signed_in_at)}</div></div></div>`)
          : html`<p class="muted small" style="margin:0">Not signed in anywhere right now.</p>`}
      </div>

      <div class="stack-sm">
        <div class="spread"><h3 class="panel-title" style="font-size:16px">Recent activity</h3><button type="button" class="btn btn-sm btn-ghost" id="allact">See all activity</button></div>
        ${s.recent.length ? html`<div class="dps-recent">${s.recent.map((a) => html`<div><span>${a.action}${a.detail && a.kind !== 'signin' ? html` <span class="muted">· ${a.detail}</span>` : ''}</span><span class="muted small" style="white-space:nowrap">${when(a.created_at)}</span></div>`)}</div>`
          : html`<p class="muted small" style="margin:0">Nothing yet.</p>`}
      </div>

      <div class="btn-row" style="border-top:1px solid var(--line);padding-top:var(--space-4)">
        ${s.locked ? html`<button type="button" class="btn btn-warn" id="unlock">Unlock</button>` : ''}
        ${s.active ? html`<button type="button" class="btn" id="reset">${invite ? 'Resend invite' : 'Reset password'}</button>` : html`<button type="button" class="btn" id="turnon">Turn on</button>`}
        ${s.active && !self ? html`<button type="button" class="btn btn-ghost" id="turnoff">Turn off account</button>` : ''}
        ${!s.active && hasWork(s.work) ? html`<button type="button" class="btn" id="handover">Hand over their sessions</button>` : ''}
      </div>`,
    onMount: (body, close) => {
      const $ = (sel) => body.querySelector(sel);
      const run = async (fn, msg) => { try { const r = await fn(); close(null); toast(typeof msg === 'function' ? msg(r) : msg); ctx.reload(); } catch (err) { toastError(err); } };

      const ef = $('#editf');
      if (ef) {
        const changed = () => { const d = formData(ef); return d.name.trim() !== s.name || d.email.trim().toLowerCase() !== s.email.toLowerCase() || d.role !== s.role; };
        ef.addEventListener('input', () => { $('#save').disabled = !changed(); });
        ef.role.addEventListener('change', () => {
          $('#save').disabled = !changed();
          $('#erhint').textContent = `${ROLE_LABEL[ef.role.value]}: ${ROLE_HINT[ef.role.value]}`;
          mount($('#erhand'), ef.role.value === 'frontdesk' && s.role !== 'frontdesk' ? handPicker(s, staff) : '');
        });
        ef.addEventListener('submit', async (e) => {
          e.preventDefault();
          const d = formData(ef), err = $('#editerr');
          err.textContent = '';
          if (!d.name.trim()) { err.textContent = 'Enter their name.'; ef.name.focus(); return; }
          if (!/^\S+@\S+\.\S+$/.test(d.email.trim())) { err.textContent = 'Enter a valid email address.'; ef.email.focus(); return; }
          if (d.role !== s.role && d.role === 'owner' && !(await confirmDialog('Make owner', `${d.name.trim()} will see everything, including revenue, billing, API keys, staff and backups. Make them an owner?`, 'Make owner'))) return;
          if (self && d.role !== s.role && !(await confirmDialog('Change your own role', `You'll lose owner access, including this page. Make yourself ${ROLE_LABEL[d.role]}?`, 'Change my role', 'warn'))) return;
          const payload = { name: d.name, email: d.email, role: d.role };
          const hand = handValue(ef);
          if (hand !== undefined) payload.hand_to = hand;
          const btn = $('#save');
          btn.disabled = true;
          try {
            await api.put(`/staff/${s.id}`, payload);
            close(null);
            if (self && d.role !== 'owner') { location.href = '/app/today'; return; }
            toast(d.role !== s.role ? `Saved. ${d.name.trim()} is now ${ROLE_LABEL[d.role]}.` : 'Saved.');
            ctx.reload();
          } catch (x) { err.textContent = x.message; btn.disabled = false; }
        });
      }
      $('#signout')?.addEventListener('click', async () => {
        const text = self ? 'Sign out of every device except this one? You stay signed in here.' : `Sign ${s.name} out of every device? Their password stays the same, so they can sign straight back in. Use Reset password if it may be known to someone else.`;
        if (!(await confirmDialog(self ? 'Sign out other devices' : 'Sign out everywhere', text, 'Sign out'))) return;
        run(() => api.post(`/staff/${s.id}/sign-out`), (r) => `Signed out of ${plural(r.signed_out, 'device')}.`);
      });
      $('#allact').addEventListener('click', () => { close(null); onActivity(s.id); });
      $('#unlock')?.addEventListener('click', () => run(() => api.post(`/staff/${s.id}/unlock`), `${s.name} can sign in again.`));
      $('#turnon')?.addEventListener('click', () => run(() => api.post(`/staff/${s.id}/turn-on`), `${s.name} can sign in again with their password.`));
      $('#reset')?.addEventListener('click', async () => {
        const text = invite ? `Email ${s.name} a new one-time password at ${s.email}? The old one stops working.`
          : `Email ${s.name} a new one-time password at ${s.email}? ${self ? "You'll" : "They'll"} be signed out everywhere and choose a new password at the next sign-in.`;
        if (!(await confirmDialog(invite ? 'Resend invite' : 'Reset password', text, invite ? 'Resend invite' : 'Reset password'))) return;
        run(() => api.post(`/staff/${s.id}/reset-password`), `New one-time password emailed to ${s.email}.`);
      });
      $('#turnoff')?.addEventListener('click', async () => {
        const r = await modal({
          title: 'Turn off account',
          body: html`<p style="margin:0">Turn off ${s.name}'s account? They're signed out everywhere at once and can't sign in until an owner turns it back on. Their history stays.</p>${handPicker(s, staff)}`,
          actions: [{ label: 'Cancel', value: null }, { label: 'Turn off', kind: 'warn', onClick: (b) => ({ hand_to: handValue(b) }) }],
        });
        if (!r) return;
        const payload = r.hand_to !== undefined ? { hand_to: r.hand_to } : {};
        run(() => api.post(`/staff/${s.id}/turn-off`, payload), `${s.name} is signed out and turned off.${'hand_to' in payload ? ' Their sessions were handed over.' : ''}`);
      });
      $('#handover')?.addEventListener('click', async () => {
        const r = await modal({
          title: 'Hand over sessions', body: handPicker(s, staff, { keepLabel: 'Keep as is' }),
          actions: [{ label: 'Cancel', value: null }, { label: 'Hand over', kind: 'primary', onClick: (b) => ({ hand_to: handValue(b) }) }],
        });
        if (!r || r.hand_to === undefined) return;
        run(() => api.post(`/staff/${s.id}/hand-over`, { hand_to: r.hand_to }), 'Sessions handed over.');
      });
    },
    actions: [{ label: 'Close', value: null }],
  });
}

// ---- your account: password, devices, recent sign-ins ----
async function renderAccount(ctx) {
  const acc = await api.get('/account');
  if (!ctx.isCurrent()) return;
  const others = acc.sessions.filter((d) => !d.current);
  mount(ctx.el, html`${STYLE}<div class="dps">
  <div class="page-header"><div><h1 class="page-title">Your account</h1><p class="page-sub">${acc.name} · ${acc.email} · ${ROLE_LABEL[acc.role]}</p></div></div>
  <div class="grid-2" style="align-items:start">
    <form class="panel" id="pwf" novalidate>
      <div><h2 class="panel-title">Change your password</h2><p class="panel-sub">Your other devices are signed out when you change it, and you get an email to confirm.</p></div>
      <input type="email" name="username" value="${acc.email}" autocomplete="username" hidden>
      ${passwordField({ id: 'p0', name: 'current_password', label: 'Current password', autocomplete: 'current-password' })}
      ${passwordField({ id: 'p1', name: 'password', label: 'New password', autocomplete: 'new-password', minlength: 10, hint: 'At least 10 characters. A short sentence works well.' })}
      ${passwordField({ id: 'p2', name: 'again', label: 'Type it again', autocomplete: 'new-password' })}
      <div class="error" id="err" role="alert"></div>
      <div><button class="btn btn-primary">Save password</button></div>
    </form>
    <div class="stack">
      <section class="panel" aria-labelledby="dev-t">
        <div><h2 class="panel-title" id="dev-t">Where you're signed in</h2><p class="panel-sub">Sign out anything you don't recognize, or a shared computer you forgot about.</p></div>
        <div>${acc.sessions.map((d) => html`<div class="dps-dev"><div class="grow"><span class="strong">${d.device}</span>${d.current ? html` ${badge('active', 'This device')}` : ''}
          <div class="small muted">Last active ${when(d.last_seen)}${d.ip ? ` · ${d.ip}` : ''} · signed in ${fmtDate(d.signed_in_at)}</div></div>
          ${d.current ? '' : html`<button class="btn btn-sm" data-end="${d.id}" aria-label="Sign out ${d.device}">Sign out</button>`}</div>`)}</div>
        ${others.length > 1 ? html`<div><button class="btn" id="others">Sign out all other devices</button></div>` : ''}
      </section>
      <section class="panel" aria-labelledby="si-t">
        <div><h2 class="panel-title" id="si-t">Recent sign-ins</h2><p class="panel-sub">If one isn't you, change your password and tell an owner.</p></div>
        ${acc.signins.length ? html`<div class="dps-recent">${acc.signins.map((a) => html`<div><span>${/fail/i.test(a.action) ? html`<span class="warn-text">${a.action}</span>` : a.action}${a.ip ? html` <span class="muted mono" style="font-size:12px">${a.ip}</span>` : ''}</span><span class="muted small" style="white-space:nowrap">${when(a.created_at)}</span></div>`)}</div>`
          : html`<p class="muted small" style="margin:0">No sign-ins recorded yet.</p>`}
      </section>
    </div>
  </div></div>`);
  const f = ctx.el.querySelector('#pwf');
  bindPasswordFields(f);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f), err = ctx.el.querySelector('#err');
    err.textContent = '';
    if (!d.current_password) { err.textContent = 'Enter your current password.'; f.current_password.focus(); return; }
    if (d.password.length < 10) { err.textContent = 'Use at least 10 characters.'; f.password.focus(); return; }
    if (d.password !== d.again) { err.textContent = "Those passwords don't match."; f.again.focus(); return; }
    const btn = f.querySelector('button.btn-primary');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api.post('/auth/staff/password', { current_password: d.current_password, password: d.password });
      toast(others.length ? 'Password changed. Your other devices were signed out.' : 'Password changed. Use it next time you sign in.');
      ctx.reload();
    } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Save password'; }
  });
  ctx.el.querySelectorAll('[data-end]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/account/sessions/${b.dataset.end}/sign-out`); toast('That device is signed out.'); ctx.reload(); } catch (err) { toastError(err); }
  }));
  ctx.el.querySelector('#others')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Sign out other devices', `Sign out of ${plural(others.length, 'other device')}? You stay signed in here.`, 'Sign out'))) return;
    try { const r = await api.post('/account/sign-out-others'); toast(`Signed out of ${plural(r.signed_out, 'device')}.`); ctx.reload(); } catch (err) { toastError(err); }
  });
}

export const routes = [
  { path: '/staff', nav: 'staff', title: 'Staff & security', roles: ['owner'], render: renderStaff },
  { path: '/account', nav: 'account', title: 'Your account', render: renderAccount },
];
