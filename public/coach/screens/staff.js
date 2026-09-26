// Staff & security: staff accounts and roles, backups, the activity log; plus /app/account to change your own password.
import { html, raw, mount, api, toast, toastError, confirmDialog, formData, relTime, fmtDateTime, badge, debounce } from '/js/ui.js';

const ROLE_LABEL = { owner: 'Owner', coach: 'Coach', frontdesk: 'Front desk' };
const ROLE_HINT = {
  owner: 'Owner: everything, including billing, school contracts, API keys, staff and backups.',
  coach: 'Coach: clients, schedule, testing, programs and point of sale. No billing, school contracts, refunds, API keys or staff.',
  frontdesk: 'Front desk: check-ins, sales, bookings and entering results. Can view the schedule, programs and tests but not change them.',
};

const STYLE = html`<style>
.dps-row{display:flex;align-items:center;gap:var(--space-3);padding:14px 0;border-top:1px solid var(--line-subtle);flex-wrap:wrap}
.dps-row .grow{flex:1;min-width:220px}
.dps-row select.input{width:auto;min-width:140px}
.dps-you{font-size:13px;color:var(--steel-muted);font-weight:500}
.dps-bk{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:4px 16px;align-items:center;font-size:14px}
.dps-bk>div{padding:6px 0;border-top:1px solid var(--line-subtle)}
.dps-filters{display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:center}
.dps-log td{font-size:14px;line-height:20px}
.dps-log td.when{white-space:nowrap;color:var(--steel-muted)}
.dps-log td.ip{font:400 12px/18px var(--font-mono);color:var(--steel-muted);white-space:nowrap}
.dps-pager{display:flex;align-items:center;gap:var(--space-3);justify-content:flex-end}
.dps-add{grid-template-columns:minmax(0,1.3fr) minmax(0,1.3fr) minmax(0,.8fr)}
.dps-log .show-sm{display:none}
@media (max-width:700px){.dps-log .hide-sm{display:none}.dps-log .show-sm{display:block}.dps-add{grid-template-columns:1fr}.dps-row select.input{flex:1}}
</style>`;

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function result(a) {
  if (a.kind === 'refused') return badge('failed', 'Refused');
  if (/fail/i.test(a.action)) return badge('failed', 'Failed');
  if (a.kind === 'signin') return badge('neutral', 'Sign-in');
  return badge('active', 'OK');
}

async function renderStaff(ctx) {
  const [staff, backups] = await Promise.all([api.get('/staff'), api.get('/backups')]);
  if (!ctx.isCurrent()) return;
  mount(ctx.el, html`${STYLE}
  <div class="page-header"><div><h1 class="page-title">Staff & security</h1><p class="page-sub">Who can sign in, what they can do, what happened, and your backups.</p></div></div>

  <section class="panel" aria-labelledby="st-t">
    <div><h2 class="panel-title" id="st-t">Staff</h2><p class="panel-sub">Each person gets their own sign-in. Roles decide what they can see and do.</p></div>
    <div>${staff.map((s) => html`<div class="dps-row" data-sid="${s.id}">
      <div class="grow">
        <div class="row" style="gap:8px"><span class="strong">${s.name}</span>${s.id === ctx.me.id ? html`<span class="dps-you">(you)</span>` : ''}
          ${!s.active ? badge('off') : s.locked ? badge('locked') : s.must_change ? badge('neutral', 'Waiting for first sign-in') : ''}</div>
        <div class="small muted">${s.email} · ${s.last_signed_in ? `last signed in ${relTime(s.last_signed_in)}` : 'never signed in'}${s.locked ? ` · locked until ${fmtDateTime(s.locked_until)}` : ''}</div>
      </div>
      ${s.active ? html`<label class="sr-only" for="role-${s.id}">Role for ${s.name}</label>
        <select class="input" id="role-${s.id}" data-role="${s.id}">${Object.entries(ROLE_LABEL).map(([v, l]) => html`<option value="${v}" ${v === s.role ? raw('selected') : ''}>${l}</option>`)}</select>`
        : html`<span class="muted small" style="min-width:140px">${ROLE_LABEL[s.role]}</span>`}
      <div class="btn-row">
        ${s.locked ? html`<button class="btn btn-sm btn-warn" data-unlock="${s.id}">Unlock</button>` : ''}
        ${s.active ? html`<button class="btn btn-ghost btn-sm" data-reset="${s.id}">Reset password</button>` : ''}
        ${s.id !== ctx.me.id ? (s.active ? html`<button class="btn btn-ghost btn-sm" data-off="${s.id}">Turn off</button>` : html`<button class="btn btn-sm" data-on="${s.id}">Turn on</button>`) : ''}
      </div>
    </div>`)}</div>
    <form class="stack-sm" id="adds" novalidate style="border-top:1px solid var(--line);padding-top:var(--space-4);gap:var(--space-3)">
      <div class="form-grid dps-add">
        <div class="field"><label class="label" for="sn">Name</label><input class="input" id="sn" name="name" autocomplete="off" maxlength="80"></div>
        <div class="field"><label class="label" for="se">Email</label><input class="input" id="se" name="email" type="email" autocomplete="off"></div>
        <div class="field"><label class="label" for="sr">Role</label><select class="input" id="sr" name="role">
          <option value="coach">Coach</option><option value="frontdesk">Front desk</option><option value="owner">Owner</option></select></div>
      </div>
      <p class="hint" id="rhint" style="margin:0">${ROLE_HINT.coach}</p>
      <div><button class="btn btn-primary">Add staff member</button></div>
    </form>
  </section>

  <section class="panel" aria-labelledby="bk-t" style="max-width:640px">
    <div><h2 class="panel-title" id="bk-t">Backups</h2><p class="panel-sub">A full copy of everything is saved every day, and the last ${backups.keep} are kept. Download one now and then and keep it somewhere safe, off this server.</p></div>
    ${backups.items.length ? html`<div class="dps-bk">${backups.items.map((b) => html`
      <div>${fmtDateTime(b.created_at)}</div><div class="muted small" style="text-align:right">${kb(b.size)}</div>
      <div><a class="btn btn-ghost btn-sm" href="/api/backups/${b.name}" download="${b.name}">Download</a></div>`)}</div>`
      : html`<p class="muted" style="margin:0">No backups yet. The first one runs within the hour, or back up now.</p>`}
    <div><button class="btn" id="bknow">Back up now</button></div>
    <p class="hint" style="margin:0">Backup files contain client, family and medical information. Store them like you would paper records.</p>
  </section>

  <section class="panel" aria-labelledby="log-t">
    <div class="panel-head"><div><h2 class="panel-title" id="log-t">Activity log</h2><p class="panel-sub">Every change, refused attempt and sign-in by staff, API keys, parents and athletes, with where it came from.</p></div></div>
    <div class="dps-filters">
      <div class="seg" role="group" aria-label="Show">${[['', 'All'], ['change', 'Changes'], ['refused', 'Refused'], ['signin', 'Sign-ins']].map(([k, l]) => html`<button type="button" data-kind="${k}" aria-pressed="${k === '' ? 'true' : 'false'}">${l}</button>`)}</div>
      <input class="input" type="search" id="lq" placeholder="Search who, what or IP" aria-label="Search the activity log" style="max-width:300px">
    </div>
    <div id="log"></div>
  </section>`);

  const el = ctx.el;
  const byId = Object.fromEntries(staff.map((s) => [s.id, s]));
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); ctx.reload(); } catch (err) { toastError(err); ctx.reload(); } };

  const f = el.querySelector('#adds');
  f.role.addEventListener('change', () => { el.querySelector('#rhint').textContent = ROLE_HINT[f.role.value]; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f);
    try { await api.post('/staff', d); toast(`${d.name} added. Their one-time password is on its way to ${d.email}.`); ctx.reload(); }
    catch (err) { toastError(err); }
  });
  el.querySelectorAll('[data-role]').forEach((sel) => sel.addEventListener('change', async () => {
    const s = byId[sel.dataset.role];
    const self = s.id === ctx.me.id && sel.value !== 'owner';
    if (self && !(await confirmDialog('Change your own role', `You'll lose owner access, including this page. Make yourself ${ROLE_LABEL[sel.value]}?`, 'Change my role', 'warn'))) { sel.value = s.role; return; }
    try {
      await api.put(`/staff/${s.id}`, { role: sel.value });
      toast(`${s.name} is now ${ROLE_LABEL[sel.value]}.`);
      if (self) location.href = '/app/today'; else ctx.reload();
    } catch (err) { toastError(err); sel.value = s.role; }
  }));
  el.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
    const s = byId[b.dataset.reset];
    if (!(await confirmDialog('Reset password', `Email ${s.name} a new one-time password at ${s.email}? ${s.id === ctx.me.id ? 'You' : 'They'}'ll be signed out everywhere and choose a new password at the next sign-in.`, 'Reset password'))) return;
    act(() => api.post(`/staff/${s.id}/reset-password`), `New one-time password emailed to ${s.email}.`);
  }));
  el.querySelectorAll('[data-unlock]').forEach((b) => b.addEventListener('click', () => act(() => api.post(`/staff/${b.dataset.unlock}/unlock`), `${byId[b.dataset.unlock].name} can sign in again.`)));
  el.querySelectorAll('[data-off]').forEach((b) => b.addEventListener('click', async () => {
    const s = byId[b.dataset.off];
    if (!(await confirmDialog('Turn off account', `Turn off ${s.name}'s account? They're signed out everywhere at once and can't sign in until an owner turns it back on.`, 'Turn off', 'warn'))) return;
    act(() => api.post(`/staff/${s.id}/turn-off`), `${s.name} is signed out and turned off.`);
  }));
  el.querySelectorAll('[data-on]').forEach((b) => b.addEventListener('click', () => act(() => api.post(`/staff/${b.dataset.on}/turn-on`), `${byId[b.dataset.on].name} can sign in again.`)));
  el.querySelector('#bknow').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Backing up…';
    act(async () => { const r = await api.post('/backups'); toast(`Backup saved (${kb(r.size)}).`); });
  });

  // activity log
  const box = el.querySelector('#log');
  let kind = '', page = 1;
  const load = async () => {
    const q = el.querySelector('#lq').value.trim();
    const r = await api.get(`/staff/activity?page=${page}&per=25${kind ? '&kind=' + kind : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`);
    if (!ctx.isCurrent()) return;
    mount(box, r.items.length ? html`<div class="table-wrap"><table class="table dps-log">
      <thead><tr><th>When</th><th class="hide-sm">Who</th><th>What</th><th class="hide-sm">Detail</th><th class="hide-sm">From</th><th>Result</th></tr></thead>
      <tbody>${r.items.map((a) => html`<tr>
        <td class="when" title="${fmtDateTime(a.created_at)}">${relTime(a.created_at)}</td><td class="hide-sm">${a.actor || 'System'}</td><td>${a.action}<div class="show-sm small muted">${a.actor || 'System'}</div></td>
        <td class="hide-sm muted">${a.detail || ''}</td><td class="hide-sm ip">${a.ip ? a.ip.replace(/^::ffff:/, '') : ''}</td><td>${result(a)}</td></tr>`)}</tbody></table></div>
      <div class="dps-pager"><span class="small muted">Page ${r.page} of ${r.pages} · ${r.total} entries</span>
        <button class="btn btn-sm" data-page="-1" ${r.page <= 1 ? raw('disabled') : ''}>Newer</button>
        <button class="btn btn-sm" data-page="1" ${r.page >= r.pages ? raw('disabled') : ''}>Older</button></div>`
      : html`<p class="muted" style="margin:0">Nothing matches.</p>`);
    box.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { page += Number(b.dataset.page); load().catch(toastError); }));
  };
  el.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.kind; page = 1;
    el.querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    load().catch(toastError);
  }));
  el.querySelector('#lq').addEventListener('input', debounce(() => { page = 1; load().catch(toastError); }, 250));
  await load();
}

async function renderAccount(ctx) {
  mount(ctx.el, html`
  <div class="page-header"><div><h1 class="page-title">Password</h1><p class="page-sub">Signed in as ${ctx.me.name} (${ctx.me.email}).</p></div></div>
  <form class="panel" id="pwf" novalidate style="max-width:480px">
    <h2 class="panel-title">Change your password</h2>
    <div class="field"><label class="label" for="p1">New password</label><input class="input" id="p1" name="password" type="password" minlength="10" autocomplete="new-password" required><span class="hint">At least 10 characters. A short sentence works well.</span></div>
    <div class="field"><label class="label" for="p2">Type it again</label><input class="input" id="p2" name="again" type="password" autocomplete="new-password" required></div>
    <div class="error" id="err" role="alert"></div>
    <div><button class="btn btn-primary">Save password</button></div>
  </form>`);
  const f = ctx.el.querySelector('#pwf');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f), err = ctx.el.querySelector('#err');
    err.textContent = '';
    if (d.password.length < 10) { err.textContent = 'Use at least 10 characters.'; return; }
    if (d.password !== d.again) { err.textContent = "Those passwords don't match."; return; }
    try { await api.post('/auth/staff/password', { password: d.password }); f.reset(); toast('Password changed. Use it next time you sign in.'); }
    catch (x) { err.textContent = x.message; }
  });
}

export const routes = [
  { path: '/staff', nav: 'staff', title: 'Staff & security', roles: ['owner'], render: renderStaff },
  { path: '/account', nav: 'account', title: 'Password', render: renderAccount },
];
