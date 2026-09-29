// Owner screens: API & integrations and Settings (exercise library for all staff; staff, security, backups, data
// requests and the activity report for owners). Also everyone's own Account page, the "forgot password" form
// on the sign-in page and the page an emailed reset link opens. The server checks every rule; these screens only follow.
import { h, fill, toast, date, ago, btn, busy, field, input, select, panel } from './ui.js';
import { exerciseLibrary } from './programs-coach.js';
import { importForm, importsList } from './dataimport-ui.js';

let api, render, header, pulseTile, download, me, saveAnyway;
export function initAdmin(deps) { ({ api, render, header, pulseTile, download, me, saveAnyway } = deps); }
const get = (p) => api('GET', p), post = (p, b = {}) => api('POST', p, b), patch = (p, b) => api('PATCH', p, b), del = (p, b) => api('DELETE', p, b);
const dialog = () => document.getElementById('dialog');
function openDialog(...kids) {
  const d = dialog();
  fill(d, ...kids);
  if (!d.open) { d.addEventListener('close', () => fill(d), { once: true }); d.showModal(); }
  return d;
}
const tag = (tone, text) => h('span', { class: `dp-badge dp-badge--${tone}` }, text);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const copy = async (text, what = 'Copied.') => { try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Copy did not work here. Select the text and copy it instead.', 'warn'); } };
const phoneText = (p) => (/^\+1\d{10}$/.test(p ?? '') ? `(${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}` : p);
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const kb = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const codeBlock = (text) => h('pre', { class: 'secret mono', style: 'border-color:var(--line);white-space:pre-wrap;word-break:break-all;margin:0' }, text);
const queryOf = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
function setQuery(section, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  history.replaceState(null, '', `#/${section}${q.size ? `?${q}` : ''}`);
}
// Tabs that switch in place (the address keeps the tab), with arrow keys moving between them.
function tabs(list, current, onPick) {
  const buttons = list.map(([key, label]) => h('button', { type: 'button', role: 'tab', class: 'ts-tab', id: `tab-${key}`, 'aria-selected': String(key === current), 'aria-controls': 'tab-panel', tabindex: key === current ? '0' : '-1',
    onClick: () => pick(key) }, label));
  function pick(key, focus = false) {
    for (const b of buttons) { const on = b.id === `tab-${key}`; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); }
    onPick(key);
  }
  const bar = h('div', { class: 'ts-tabs', role: 'tablist', 'aria-label': 'Sections', onKeydown: (e) => {
    const i = buttons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const next = e.key === 'ArrowRight' ? (i + 1) % buttons.length : e.key === 'ArrowLeft' ? (i - 1 + buttons.length) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (next != null) { e.preventDefault(); pick(list[next][0], true); }
  } }, buttons);
  return { bar, pick };
}
// A password field with Show and a Caps Lock warning.
function passwordField(label, attrs = {}, hint) {
  const box = input({ type: 'password', ...attrs });
  const caps = h('div', { class: 'small warn-text', role: 'status', style: 'display:none' }, 'Caps Lock is on.');
  const show = btn('Show', () => { const on = box.type === 'password'; box.type = on ? 'text' : 'password'; show.textContent = on ? 'Hide' : 'Show'; show.setAttribute('aria-pressed', String(on)); box.focus(); }, 'ghost', { 'aria-pressed': 'false', 'aria-label': `Show ${label.toLowerCase()}` });
  const check = (e) => { if (e.getModifierState) caps.style.display = e.getModifierState('CapsLock') ? '' : 'none'; };
  box.addEventListener('keydown', check); box.addEventListener('keyup', check); box.addEventListener('blur', () => { caps.style.display = 'none'; });
  const f = field(label, h('div', { class: 'row', style: 'gap:8px' }, box, show), hint);
  f.querySelector('label').setAttribute('for', box.id || (box.id = `pw${Math.random().toString(36).slice(2, 8)}`));
  f.append(caps);
  return { el: f, input: box };
}

// =====================================================================================================================
// API & integrations
// =====================================================================================================================
const SCOPE_HELP = {
  read: 'Read only: looks up clients, the schedule, results and more, but can\'t change anything. Best for dashboards and reports.',
  results: 'Read and send results: also sends test results and device files (timing gates, jump mats, force plates). It can\'t change anything else.',
  full: 'Full access: everything the open API can do, including adding clients and bookings. Give it only to systems you trust.'
};
const SCOPE_TONE = { read: 'muted', results: 'neutral', full: 'warn' };
const INT_TABS = [['keys', 'API keys'], ['webhooks', 'Webhooks'], ['email', 'Email outbox'], ['texts', 'Texts'], ['video', 'Exercise video']];
const DELIVERY_BADGE = { succeeded: ['good', 'Delivered'], failed: ['warn', 'Failed'], pending: ['neutral', 'Waiting to retry'], sending: ['neutral', 'Sending'] };

export async function viewIntegrations(main) {
  let current = INT_TABS.some(([k]) => k === queryOf().get('tab')) ? queryOf().get('tab') : 'keys';
  const strip = h('div', { class: 'pulse', style: 'margin-bottom:16px' });
  const body = h('div', { id: 'tab-panel', role: 'tabpanel', class: 'stack', style: 'margin-top:16px' });
  const ctx = { refresh: () => Promise.all([loadStrip(), loadTab()]), refreshStrip: () => loadStrip() };
  async function loadStrip() {
    const s = await get('/v1/api-status');
    const mode = { test: 'Not connected', restricted: 'Test addresses only', live: 'Sending' };
    const tile = (key, label, value, detail, tone) => { const t = pulseTile(label, value, detail, { tone, href: `#/integrations?tab=${key}` }); t.addEventListener('click', (e) => { e.preventDefault(); t$.pick(key, true); }); return t; };
    fill(strip,
      tile('keys', 'API keys', String(s.keys.active), s.keys.active ? `${plural(s.keys.requests_30d, 'request')} in 30 days${s.keys.errors_30d ? `, ${plural(s.keys.errors_30d, 'error')}` : ''}` : 'None yet', s.keys.errors_30d ? 'warn' : null),
      tile('webhooks', 'Webhooks', s.webhooks.failing ? `${s.webhooks.failing} failing` : String(s.webhooks.total), s.webhooks.total ? `${s.webhooks.active} on${s.webhooks.total > s.webhooks.active ? `, ${s.webhooks.total - s.webhooks.active} paused` : ''}${s.webhooks.failed_7d ? `, ${s.webhooks.failed_7d} failed this week` : ''}${s.webhooks.waiting ? `, ${s.webhooks.waiting} waiting` : ''}` : 'None yet', s.webhooks.failing || s.webhooks.failed_7d ? 'warn' : null),
      tile('email', 'Email', mode[s.email.mode], s.email.failed_7d ? `${plural(s.email.failed_7d, 'email')} failed this week` : `${s.email.counts.sent} sent`, s.email.mode === 'test' || s.email.failed_7d ? 'warn' : 'good'),
      tile('texts', 'Texts', mode[s.texts.mode], s.texts.failed_7d ? `${plural(s.texts.failed_7d, 'text')} failed this week` : `${s.texts.counts.sent} sent`, s.texts.failed_7d ? 'warn' : null),
      tile('video', 'Exercise video', s.video.total ? `${s.video.pct}%` : '—', s.video.in_use_missing ? `${plural(s.video.in_use_missing, 'exercise')} in programs need one` : s.video.unplayable ? `${s.video.unplayable} won't play` : 'Every exercise in a program has one', s.video.in_use_missing || s.video.unplayable ? 'warn' : 'good'));
  }
  const loaders = { keys: keysTab, webhooks: webhooksTab, email: emailTab, texts: textsTab, video: videoTab };
  let loading = 0;
  async function loadTab() {
    const n = ++loading;
    const box = h('div', { class: 'stack' });
    try { await loaders[current](box, ctx); } catch (e) { fill(box, h('p', { class: 'dp-error' }, e.message)); }
    if (n === loading) fill(body, box);
  }
  const t$ = tabs(INT_TABS, current, (key) => { current = key; setQuery('integrations', { tab: key === 'keys' ? '' : key }); loadTab(); });
  fill(main, header('API & integrations', 'Connect Diamond Protocol to your other systems, and see every email and text it sends.'), strip, t$.bar, body);
  await Promise.all([loadStrip().catch((e) => fill(strip, h('p', { class: 'dp-error', style: 'padding:12px' }, e.message))), loadTab()]);
}

// ---- API keys ----
async function keysTab(box, ctx) {
  const { data, scopes } = await get('/v1/api-keys');
  const label = input({ placeholder: 'e.g. Website booking form', maxlength: '80' });
  const scope = select(Object.entries(scopes), { value: 'read' });
  const help = h('p', { class: 'small muted', style: 'margin:0' }, SCOPE_HELP.read);
  scope.addEventListener('change', () => { help.textContent = SCOPE_HELP[scope.value]; });
  const revealed = h('div', { role: 'status' });
  const create = panel('Create an API key', { subtitle: 'Each system gets its own key, so you can see what it does and switch it off on its own.' },
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const k = await post('/v1/api-keys', { label: label.value, scope: scope.value });
      fill(revealed, h('div', { class: 'stack', style: 'margin-top:4px' },
        h('span', { class: 'strong' }, `Copy the key for ${k.label} now. You won't see it again.`), codeBlock(k.secret),
        h('div', null, btn('Copy key', () => copy(k.secret, 'Key copied.'), 'outline'))));
      label.value = '';
      await Promise.all([ctx.refreshStrip(), drawList()]);
    }); } },
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr))' }, field('Key label', label), field('What it can do', scope)), help,
      h('div', null, btn('Create key', null, 'primary', { type: 'submit' }))), revealed);
  const listBox = h('div');
  async function drawList(rows) {
    const keys = rows ?? (await get('/v1/api-keys')).data;
    const live = keys.filter((k) => !k.revoked_at), gone = keys.filter((k) => k.revoked_at);
    const row = (k) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' },
        h('span', { class: 'strong' }, k.label),
        h('span', { class: 'small muted' }, h('span', { class: 'mono' }, `${k.prefix}…`), k.revoked_at ? ` · revoked ${date(k.revoked_at)}` : ` · last used ${ago(k.last_used_at).toLowerCase()}`),
        k.revoked_at ? null : h('span', { class: `small${k.errors_30d ? ' warn-text' : ' muted'}` }, `${plural(k.requests_30d, 'request')} in 30 days${k.errors_30d ? `, ${plural(k.errors_30d, 'error')}` : ''}`)),
      tag(k.revoked_at ? 'muted' : SCOPE_TONE[k.scope], k.revoked_at ? 'Revoked' : scopes[k.scope]),
      h('div', { class: 'row wrap', style: 'gap:4px' },
        btn('Requests', () => requestsDialog(k), 'ghost'),
        k.revoked_at ? null : btn('Edit', () => editKeyDialog(k, scopes, async () => { await drawList(); ctx.refreshStrip(); }), 'ghost'),
        k.revoked_at ? null : btn('Revoke', (e) => { if (confirm(`Revoke ${k.label}? Systems using it lose access immediately.`)) busy(e.currentTarget, async () => { await post(`/v1/api-keys/${k.id}/revoke`); toast('Key revoked.'); await drawList(); ctx.refreshStrip(); }); }, 'secondary')));
    fill(listBox, live.length ? live.map(row) : h('p', { class: 'muted' }, 'No keys yet. Create one to connect your first system.'),
      gone.length ? h('details', { style: 'margin-top:8px' }, h('summary', { class: 'small muted', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Revoked keys (${gone.length})`), gone.map(row)) : null);
  }
  await drawList(data);
  const keysPanel = panel('Your keys', { subtitle: 'Send the key as a header: Authorization: Bearer dp_live_… A key without the access level for a request gets 403 (code key_scope).' }, listBox);
  fill(box, create, keysPanel, quickStart());
}
function editKeyDialog(k, scopes, done) {
  const label = input({ value: k.label, maxlength: '80' });
  const scope = select(Object.entries(scopes), { value: k.scope });
  const help = h('p', { class: 'small muted', style: 'margin:0' }, SCOPE_HELP[k.scope]);
  scope.addEventListener('change', () => { help.textContent = SCOPE_HELP[scope.value]; });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try { await patch(`/v1/api-keys/${k.id}`, { label: label.value, scope: scope.value }); dialog().close(); toast('Key saved. It works the same, with the new access level.'); done(); } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'dp-panel-title' }, `Edit ${k.label}`),
    h('p', { class: 'small muted', style: 'margin:0' }, 'The key itself stays the same, so nothing needs to change in the system using it.'),
    field('Key label', label), field('What it can do', scope), help, err,
    h('div', { class: 'row wrap' }, btn('Save', null, 'primary', { type: 'submit' }), btn('Cancel', () => dialog().close(), 'ghost'))));
}
async function requestsDialog(k) {
  let errorsOnly = false;
  const out = h('div', { class: 'stack' });
  async function draw() {
    const r = await get(`/v1/api-keys/${k.id}/requests${errorsOnly ? '?status=errors' : ''}`);
    fill(out, h('p', { class: 'small muted', style: 'margin:0' }, `${plural(r.requests_30d, 'request')} in the last 30 days, ${plural(r.errors_30d, 'error')}. What was sent is never kept.`),
      r.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table bl-cards' },
        h('thead', null, h('tr', null, ['When', 'Request', 'Answer', 'Time', 'From'].map((x) => h('th', null, x)))),
        h('tbody', null, r.data.map((x) => h('tr', null,
          h('td', { class: 'small muted', style: 'white-space:nowrap' }, when(x.at)),
          h('td', { class: 'small' }, h('span', { class: 'mono' }, `${x.method} ${x.path}`), x.error ? h('div', { class: 'small warn-text' }, x.error) : null),
          h('td', null, tag(x.status < 300 ? 'good' : x.status === 403 || x.status === 429 ? 'warn' : 'muted', String(x.status))),
          h('td', { class: 'small muted' }, x.duration_ms != null ? `${x.duration_ms} ms` : ''),
          h('td', { class: 'small muted mono' }, x.ip ?? '')))))) : h('p', { class: 'muted' }, errorsOnly ? 'No errors in the last 30 days.' : 'No requests in the last 30 days.'));
  }
  const toggle = h('label', { class: 'row small', style: 'min-height:44px' }, h('input', { type: 'checkbox', onChange: (e) => { errorsOnly = e.target.checked; draw().catch((x) => toast(x.message, 'warn')); } }), 'Errors only');
  openDialog(h('div', { class: 'stack' }, h('h2', { class: 'dp-panel-title' }, `Requests: ${k.label}`), toggle, out, h('div', null, btn('Close', () => dialog().close(), 'ghost'))));
  await draw().catch((x) => fill(out, h('p', { class: 'dp-error' }, x.message)));
}
function quickStart() {
  const o = location.origin, auth = '-H "Authorization: Bearer dp_live_…"';
  const ex = [
    ['List your clients', `curl ${o}/v1/clients \\\n  ${auth}`],
    ['One athlete\'s results since a date (best marked)', `curl "${o}/v1/athletes/AVALOP2026/results?since=2026-09-01" \\\n  ${auth}`],
    ['The tests you can send results for', `curl ${o}/v1/tests \\\n  ${auth}`],
    ['Send a result (Read and send results, or Full access)', `curl -X POST ${o}/v1/results \\\n  ${auth} \\\n  -H "Content-Type: application/json" \\\n  -d '{"results":[{"athlete":{"athlete_id":"AVALOP2026"},"test":"dash_40yd","value":5.12}]}'`]
  ];
  return panel('Quick start', { subtitle: 'Copy an example, put your key in place of dp_live_…, and run it in a terminal.', action: h('a', { class: 'dp-btn dp-btn--outline', href: '/v1/openapi.json', target: '_blank', rel: 'noopener' }, 'API reference (OpenAPI)') },
    ex.map(([title, cmd]) => h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'row' }, h('span', { class: 'strong small grow' }, title), btn('Copy', () => copy(cmd, 'Example copied.'), 'ghost', { 'aria-label': `Copy: ${title}` })), codeBlock(cmd))),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Results only land on a profile by Athlete ID, a client ID or a device ID you linked. Anything else waits in the Testing queue for you to link by hand. Errors come back as { "error": { "code", "message" } }.'));
}

// ---- Webhooks ----
let eventInfo = null;
const eventTypes = async () => (eventInfo ??= await get('/v1/event-types'));
async function webhooksTab(box, ctx) {
  const [{ data }, types] = await Promise.all([get('/v1/webhooks'), eventTypes()]);
  const cards = data.map((w) => hookCard(w, types, ctx));
  const add = btn('Add webhook', () => hookDialog(null, types, ctx), 'primary');
  const all = h('div');
  const hooksPanel = panel('Webhooks', { subtitle: 'A signed message goes to your URL the moment something happens here. Failed sends are tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours; a webhook whose last 3 tries failed is marked failing.', action: add },
    cards.length ? cards : h('p', { class: 'muted' }, 'No webhooks yet. Add one to send events to Zapier, your website or your own system.'));
  fill(box, hooksPanel, data.length ? panel('All deliveries', { subtitle: 'Every send to every webhook, newest first.' }, all) : null, signingHelp());
  if (data.length) deliveriesList(all, { endpointId: null, types });
}
function hookCard(w, types, ctx) {
  const [tone, state] = !w.active ? ['muted', 'Paused'] : w.failing ? ['warn', 'Failing'] : ['good', 'On'];
  const log = h('div');
  const events = w.events.includes('*') ? ['test.ping', ...types.data] : ['test.ping', ...w.events];
  const which = select(events.map((e) => [e, e === 'test.ping' ? 'test.ping (a simple test)' : e]), { 'aria-label': `Event to send to ${w.label ?? w.url}`, style: 'max-width:240px' });
  let open = false;
  return h('div', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px' },
    h('div', { class: 'row wrap', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' },
        h('span', { class: 'strong' }, w.label ?? w.url), w.label ? h('span', { class: 'mono small', style: 'word-break:break-all' }, w.url) : null,
        h('span', { class: 'small muted' }, w.events.includes('*') ? 'All events' : `${plural(w.events.length, 'event')}: ${w.events.slice(0, 4).join(', ')}${w.events.length > 4 ? '…' : ''}`),
        h('span', { class: `small${w.failed_7d || w.failing ? ' warn-text' : ' muted'}` }, `This week: ${w.delivered_7d} delivered, ${w.failed_7d} failed${w.waiting ? `, ${w.waiting} waiting to retry` : ''}${w.last ? ` · last ${ago(w.last.created_at).toLowerCase()}` : ''}`)),
      tag(tone, state)),
    h('div', { class: 'row wrap', style: 'gap:6px' }, which,
      btn('Send test event', (e) => busy(e.currentTarget, async () => {
        const d = await post(`/v1/webhooks/${w.id}/test`, { event: which.value });
        toast(d.status === 'succeeded' ? `Delivered: your endpoint answered ${d.response_code}.` : `Not delivered: ${d.last_error}`, d.status === 'succeeded' ? 'good' : 'warn');
        ctx.refresh();
      }), 'secondary'),
      btn('Deliveries', (e) => { open = !open; e.currentTarget.setAttribute('aria-expanded', String(open)); if (open) deliveriesList(log, { endpointId: w.id, types }); else fill(log); }, 'ghost', { 'aria-expanded': 'false' }),
      btn('Edit', () => hookDialog(w, types, ctx), 'ghost'),
      btn('Signing secret', () => secretDialog(w), 'ghost'),
      w.failed_7d ? btn('Resend failed', (e) => busy(e.currentTarget, async () => { const r = await post(`/v1/webhooks/${w.id}/resend-failed`); toast(`${r.delivered} of ${r.tried} delivered.`, r.failed ? 'warn' : 'good'); ctx.refresh(); }), 'ghost') : null,
      btn(w.active ? 'Pause' : 'Turn on', (e) => busy(e.currentTarget, async () => { await patch(`/v1/webhooks/${w.id}`, { active: !w.active }); toast(w.active ? 'Paused. Events wait until you turn it on.' : 'Turned on.'); ctx.refresh(); }), 'ghost'),
      btn('Delete', (e) => { if (confirm(`Delete the webhook to ${w.label ?? w.url}? Its delivery history goes too.`)) busy(e.currentTarget, async () => { await del(`/v1/webhooks/${w.id}`); toast('Webhook deleted.'); ctx.refresh(); }); }, 'ghost')),
    log);
}
async function deliveriesList(box, { endpointId, types }) {
  const f = { status: '', event: '', limit: 20 };
  const list = h('div');
  const status = select([['', 'All'], ['failed', 'Failed'], ['delivered', 'Delivered'], ['waiting', 'Waiting']], { 'aria-label': 'Show deliveries', style: 'width:auto' });
  const event = select([['', 'Every event'], ['test.ping', 'test.ping'], ...types.data.map((t) => [t, t])], { 'aria-label': 'Event', style: 'width:auto;max-width:240px' });
  status.addEventListener('change', () => { f.status = status.value; f.limit = 20; draw(); });
  event.addEventListener('change', () => { f.event = event.value; f.limit = 20; draw(); });
  async function draw() {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ''));
    const r = await get(`${endpointId ? `/v1/webhooks/${endpointId}/deliveries` : '/v1/webhook-deliveries'}?${q}`).catch((e) => ({ error: e.message }));
    if (r.error) return fill(list, h('p', { class: 'dp-error' }, r.error));
    fill(list, r.data.length ? r.data.map((d) => { const [tone, word] = DELIVERY_BADGE[d.status]; return h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
      h('span', { class: 'mono grow', style: 'min-width:160px' }, d.event_type, d.test ? h('span', { class: 'muted' }, ' (test)') : null),
      endpointId ? null : h('span', { class: 'muted', style: 'max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, d.endpoint_label ?? d.endpoint_url),
      h('span', { class: 'muted' }, d.last_error ? (d.response_code ? `Answered ${d.response_code}` : 'No answer') : d.response_code ? `Answered ${d.response_code}` : ''),
      tag(tone, word), h('span', { class: 'muted', style: 'white-space:nowrap' }, ago(d.created_at)),
      btn('Details', () => deliveryDialog(d.id, draw), 'ghost', { 'aria-label': `Details of ${d.event_type} ${ago(d.created_at)}` })); })
      : h('p', { class: 'small muted' }, f.status || f.event ? 'No deliveries match.' : 'No deliveries yet.'),
      r.total > r.data.length ? h('div', null, btn(`Show more (${r.total - r.data.length} older)`, () => { f.limit += 20; draw(); }, 'ghost')) : null);
  }
  fill(box, h('div', { class: 'row wrap', style: 'gap:8px;margin:8px 0' }, status, event), list);
  await draw();
}
async function deliveryDialog(id, after) {
  let d;
  try { d = await get(`/v1/webhook-deliveries/${id}`); } catch (e) { return toast(e.message, 'warn'); }
  const [tone, word] = DELIVERY_BADGE[d.status];
  const row = (k, v) => (v == null || v === '' ? null : [h('dt', { class: 'muted small' }, k), h('dd', { style: 'margin:0 0 8px' }, v)]);
  const payload = JSON.stringify(d.payload, null, 2);
  openDialog(h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('h2', { class: 'dp-panel-title grow' }, d.event_type, d.test ? ' (test)' : ''), tag(tone, word)),
    h('dl', { class: 'dl', style: 'margin:0' },
      row('Sent to', h('span', { class: 'mono', style: 'word-break:break-all' }, d.endpoint_url)),
      row('Delivery id (DP-Delivery header)', h('span', { class: 'mono' }, d.id)),
      row('Answer', d.response_code ? String(d.response_code) : d.attempts ? 'No answer' : 'Not sent yet'),
      row('Time taken', d.duration_ms != null ? `${d.duration_ms} ms` : null),
      row('Why it failed', d.last_error),
      row('Tries', `${d.attempts} of ${d.max_attempts}${d.status === 'pending' && d.next_attempt_at ? `; next try ${when(d.next_attempt_at)}` : ''}`),
      row('Last try', d.last_attempt_at ? when(d.last_attempt_at) : null),
      row('Their answer', d.response_body ? codeBlock(d.response_body) : null)),
    h('div', { class: 'dp-label' }, 'What was sent'), codeBlock(payload),
    h('div', { class: 'row wrap' },
      btn('Resend', (e) => busy(e.currentTarget, async () => {
        const r = await post(`/v1/webhook-deliveries/${id}/resend`);
        toast(r.status === 'succeeded' ? `Delivered: your endpoint answered ${r.response_code}.` : `Not delivered: ${r.last_error}`, r.status === 'succeeded' ? 'good' : 'warn');
        after?.(); deliveryDialog(id, after);
      }), 'primary'),
      btn('Copy what was sent', () => copy(payload), 'ghost'), btn('Close', () => dialog().close(), 'ghost'))));
}
function hookDialog(w, types, ctx) {
  const label = input({ value: w?.label ?? '', maxlength: '80', placeholder: 'e.g. Zapier' });
  const url = input({ type: 'url', value: w?.url ?? '', placeholder: 'https://your-system.example.com/hooks' });
  const every = !w || w.events.includes('*');
  const all = h('input', { type: 'checkbox', checked: every });
  const boxes = types.data.map((t) => h('label', { class: 'row small', style: 'gap:8px;min-height:44px;align-items:flex-start;padding-top:6px' },
    h('input', { type: 'checkbox', value: t, checked: every || w.events.includes(t), style: 'margin-top:3px' }),
    h('span', { class: 'stack-tight' }, h('span', { class: 'mono' }, t), h('span', { class: 'muted' }, types.info[t]?.about ?? ''))));
  const inputs = () => boxes.map((b) => b.querySelector('input'));
  const sync = () => { for (const i of inputs()) i.disabled = all.checked; };
  all.addEventListener('change', sync); sync();
  const err = h('div', { class: 'dp-error', role: 'alert' });
  openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    const picked = inputs().filter((i) => i.checked).map((i) => i.value);
    const events = all.checked ? ['*'] : picked;
    if (!events.length) { err.textContent = 'Choose at least one event, or tick All events.'; return; }
    try {
      if (w) { await patch(`/v1/webhooks/${w.id}`, { label: label.value, url: url.value, events }); dialog().close(); toast('Webhook saved.'); return ctx.refresh(); }
      const made = await post('/v1/webhooks', { label: label.value, url: url.value, events });
      ctx.refresh();
      openDialog(h('div', { class: 'stack' }, h('h2', { class: 'dp-panel-title' }, 'Webhook added'),
        h('p', { class: 'small', style: 'margin:0' }, 'Copy the signing secret into your receiving system now. You can show it again later under Signing secret.'), codeBlock(made.secret),
        h('div', { class: 'row wrap' }, btn('Copy secret', () => copy(made.secret, 'Secret copied.'), 'outline'),
          btn('Send a test event now', (ev) => busy(ev.currentTarget, async () => { const d = await post(`/v1/webhooks/${made.id}/test`, {}); toast(d.status === 'succeeded' ? `Delivered: your endpoint answered ${d.response_code}.` : `Not delivered: ${d.last_error}`, d.status === 'succeeded' ? 'good' : 'warn'); ctx.refresh(); }), 'primary'),
          btn('Done', () => dialog().close(), 'ghost'))));
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'dp-panel-title' }, w ? 'Edit webhook' : 'Add a webhook'),
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr))' }, field('Name (optional)', label), field('Send to this URL', url, 'A public https address.')),
    h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'dp-label' }, 'Events to send'),
      h('div', { class: 'row wrap', style: 'gap:8px' }, h('label', { class: 'row small strong', style: 'gap:8px;min-height:44px' }, all, 'All events, including ones added later'),
        btn('Select all', () => { all.checked = false; sync(); for (const i of inputs()) i.checked = true; }, 'ghost'), btn('Clear', () => { all.checked = false; sync(); for (const i of inputs()) i.checked = false; }, 'ghost')),
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0 16px;max-height:44vh;overflow:auto' }, boxes)),
    err, h('div', { class: 'row wrap' }, btn(w ? 'Save' : 'Add webhook', null, 'primary', { type: 'submit' }), btn('Cancel', () => dialog().close(), 'ghost'))));
}
function secretDialog(w) {
  const out = h('div', { class: 'stack' });
  const keep = select([['24', 'Keep the old one working for 24 hours'], ['72', 'Keep the old one working for 72 hours'], ['0', 'Stop the old one now']], { value: '24', 'aria-label': 'The old secret' });
  openDialog(h('div', { class: 'stack' },
    h('h2', { class: 'dp-panel-title' }, `Signing secret: ${w.label ?? w.url}`),
    h('p', { class: 'small muted', style: 'margin:0' }, `Your receiver checks the DP-Signature header with this secret. Now: ${w.secret_hint}${w.secret_rotated_at ? `, made ${date(w.secret_rotated_at)}` : ''}.${w.previous_secret_until ? ` The old secret also signs until ${when(w.previous_secret_until)}.` : ''}`),
    out,
    h('div', { class: 'row wrap' }, btn('Show secret', (e) => busy(e.currentTarget, async () => { const s = await get(`/v1/webhooks/${w.id}/secret`); fill(out, codeBlock(s.secret), h('div', null, btn('Copy secret', () => copy(s.secret, 'Secret copied.'), 'outline'))); }), 'secondary')),
    h('div', { class: 'dp-label', style: 'margin-top:8px' }, 'New signing secret'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Make a new secret if the old one may have been seen by someone else. While the old one keeps working, each message is signed with both, so nothing is dropped while you update your receiver.'),
    keep,
    h('div', { class: 'row wrap' }, btn('Make a new secret', (e) => { if (confirm('Make a new signing secret? Update your receiving system with it.')) busy(e.currentTarget, async () => {
      const r = await post(`/v1/webhooks/${w.id}/rotate-secret`, { keep_old_hours: Number(keep.value) });
      fill(out, h('span', { class: 'strong' }, 'Your new secret. Copy it into your receiving system.'), codeBlock(r.secret), h('div', null, btn('Copy secret', () => copy(r.secret, 'Secret copied.'), 'outline')),
        h('p', { class: 'small muted', style: 'margin:0' }, r.previous_secret_until ? `The old secret keeps signing until ${when(r.previous_secret_until)}.` : 'The old secret no longer signs anything.'));
    }); }, 'outline'), btn('Close', () => dialog().close(), 'ghost'))));
}
function signingHelp() {
  const code = 'DP-Signature: t=1760000000,v1=5d41402a…\n\nsigned = t + "." + raw body\nexpected = HMAC-SHA256(secret, signed), in hex\nAccept if any v1 value matches and t is recent.';
  return h('details', { class: 'dp-panel' }, h('summary', { class: 'strong', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'How to check a webhook is really from us'),
    h('div', { class: 'stack', style: 'margin-top:8px' },
      h('p', { class: 'small', style: 'margin:0' }, 'Every message is a POST with a JSON body: { id, type, created_at, data }. Headers: DP-Event (the event), DP-Delivery (the same id when a message is sent again, so you can skip repeats), DP-Test (true for test events) and DP-Signature.'),
      codeBlock(code),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Answer with any 2xx code within 10 seconds. Redirects aren\'t followed, and webhooks only go to public internet addresses.')));
}

// ---- Email outbox ----
const MAIL_STATUS = { sent: ['good', 'Sent'], failed: ['warn', 'Failed'], held: ['muted', 'Held'], not_sent: ['muted', 'Not sent'], logged: ['muted', 'Not sent'] };
async function emailTab(box, ctx) {
  const f = { status: '', q: '', limit: 30 };
  const list = h('div', { class: 'stack', style: 'gap:0' }), chips = h('div', { class: 'ts-tabs' });
  const search = input({ type: 'search', placeholder: 'Search address, subject or text', 'aria-label': 'Search emails', style: 'max-width:320px' });
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { f.q = search.value.trim(); f.limit = 30; draw(); }, 300); });
  let first = true, head;
  async function draw() {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ''));
    const r = await get(`/v1/outbox?${q}`);
    if (first) {
      first = false;
      const modeText = { test: 'No email service is connected, so emails stay here and are not sent. Add RESEND_API_KEY on the server to start sending.',
        restricted: `Sending through Resend, but only to ${r.only_to}. Everything else is held here.`, live: `Sending through Resend${r.from ? ` as ${r.from}` : ''}.` };
      const to = input({ type: 'email', value: me()?.email ?? '', 'aria-label': 'Send a test email to', style: 'max-width:280px' });
      head = panel('Email outbox', { subtitle: 'Every email the platform sends: sign-in codes, welcome emails, booking changes, invoices and receipts.' },
        h('p', { class: 'small', style: `margin:0;color:${r.mode === 'test' ? 'var(--amber)' : 'var(--green-bright)'}` }, modeText[r.mode] ?? ''),
        r.mode === 'test' ? null : h('div', { class: 'row wrap', style: 'gap:8px' }, to, btn('Send test email', (e) => busy(e.currentTarget, async () => { await post('/v1/outbox/test', { to: to.value }); toast('Test email sent. Check the inbox.'); draw(); ctx.refreshStrip(); }), 'secondary')),
        chips, h('div', { class: 'row wrap' }, search), list);
      fill(box, head);
    }
    const total = r.counts.sent + r.counts.failed + r.counts.held + r.counts.not_sent;
    fill(chips, [['', 'All', total], ['sent', 'Sent', r.counts.sent], ['failed', 'Failed', r.counts.failed], ['held', 'Held', r.counts.held], ['not_sent', 'Not sent', r.counts.not_sent]]
      .map(([k, label, n]) => h('button', { type: 'button', class: 'ts-tab', 'aria-pressed': String(f.status === k), 'aria-selected': String(f.status === k), onClick: () => { f.status = k; f.limit = 30; draw(); } }, label, h('span', { class: 'ts-tab-count' }, String(n)))));
    fill(list, r.data.length ? r.data.map((m) => emailRow(m, r.mode, () => { draw(); ctx.refreshStrip(); })) : h('p', { class: 'muted' }, f.q || f.status ? 'No emails match.' : 'No emails yet.'),
      r.data.length >= f.limit ? h('div', { style: 'margin-top:8px' }, btn('Show more', () => { f.limit += 30; draw(); }, 'ghost')) : null);
  }
  await draw();
}
function emailRow(m, mode, after) {
  const [tone, word] = MAIL_STATUS[m.status] ?? ['muted', m.status];
  const other = input({ type: 'email', placeholder: 'another@example.com', 'aria-label': 'Send to another address', style: 'max-width:260px' });
  const again = (to) => (e) => busy(e.currentTarget, async () => { const r = await post(`/v1/outbox/${m.id}/resend`, to ? { to } : {}); toast(`Sent again to ${r.to}.`); after(); });
  return h('details', { class: 'list-item', style: 'display:block' },
    h('summary', { class: 'row small', style: 'cursor:pointer;min-height:44px;flex-wrap:wrap;gap:6px 10px' },
      h('span', { class: 'muted', style: 'white-space:nowrap' }, ago(m.created_at)), h('span', { class: 'grow', style: 'min-width:180px' }, h('span', { class: 'strong' }, m.subject), h('span', { class: 'muted' }, ` · ${m.to_email}`)), tag(tone, word)),
    m.error ? h('p', { class: 'small', style: 'color:var(--amber);margin:8px 0 0' }, m.error) : null,
    h('pre', { class: 'small muted', style: 'white-space:pre-wrap;margin:8px 0 0;word-break:break-word' }, m.body),
    h('div', { class: 'row wrap', style: 'gap:6px;margin-top:8px' },
      btn('Copy text', () => copy(m.body, 'Email text copied.'), 'ghost'),
      mode === 'test' ? null : btn('Send again', again(null), 'ghost'),
      mode === 'test' || m.sensitive ? null : h('div', { class: 'row', style: 'gap:6px' }, other, btn('Send to this address', (e) => { if (!other.value.trim()) return toast('Type the address to send it to.', 'warn'); again(other.value.trim())(e); }, 'ghost'))),
    m.sensitive ? h('p', { class: 'small muted', style: 'margin:6px 0 0' }, 'This email holds a sign-in code, password or private link, so it only goes to the address it was written for.') : null);
}

// ---- Texts ----
const TEXT_STATUS = { sent: ['good', 'Sent'], failed: ['warn', 'Failed'], held: ['muted', 'Held'], logged: ['muted', 'Not sent'], received: ['neutral', 'Reply'] };
async function textsTab(box, ctx) {
  const f = { status: '', q: '', limit: 30 };
  const list = h('div', { class: 'stack', style: 'gap:0' }), chips = h('div', { class: 'ts-tabs' });
  const search = input({ type: 'search', placeholder: 'Search number or text', 'aria-label': 'Search texts', style: 'max-width:320px' });
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { f.q = search.value.trim(); f.limit = 30; draw(); }, 300); });
  let first = true;
  async function draw() {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ''));
    const r = await get(`/v1/texts?${q}`);
    if (first) {
      first = false;
      const modeText = { test: 'No text service is connected, so texts stay here and are not sent. Add your Twilio settings on the server to start sending.',
        restricted: `Sending through Twilio, but only to ${r.only_to}. Everything else is held here.`, live: 'Sending through Twilio.' };
      const phone = input({ type: 'tel', placeholder: '(512) 555-0100', 'aria-label': 'Send a test text to', style: 'max-width:220px' });
      fill(box, panel('Texts', { subtitle: 'Every text sent to parents, and their replies. Parents turn texts on in the parent portal and can reply STOP at any time.' },
        h('p', { class: 'small', style: `margin:0;color:${r.mode === 'test' ? 'var(--amber)' : 'var(--green-bright)'}` }, modeText[r.mode] ?? ''),
        r.mode === 'test' ? null : h('div', { class: 'row wrap', style: 'gap:8px' }, phone, btn('Send test text', (e) => busy(e.currentTarget, async () => { await post('/v1/texts/test', { to: phone.value }); toast('Test text sent.'); draw(); ctx.refreshStrip(); }), 'secondary')),
        r.mode === 'test' ? pretendReply(() => { draw(); ctx.refreshStrip(); }) : null,
        chips, h('div', { class: 'row wrap' }, search), list));
    }
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    fill(chips, [['', 'All', total], ['sent', 'Sent', r.counts.sent], ['failed', 'Failed', r.counts.failed], ['held', 'Held', r.counts.held], ['logged', 'Not sent', r.counts.logged], ['received', 'Replies', r.counts.received]]
      .map(([k, label, n]) => h('button', { type: 'button', class: 'ts-tab', 'aria-pressed': String(f.status === k), 'aria-selected': String(f.status === k), onClick: () => { f.status = k; f.limit = 30; draw(); } }, label, h('span', { class: 'ts-tab-count' }, String(n)))));
    fill(list, r.data.length ? r.data.map((m) => { const [tone, word] = TEXT_STATUS[m.status] ?? ['muted', m.status]; return h('details', { class: 'list-item', style: 'display:block' },
      h('summary', { class: 'row small', style: 'cursor:pointer;min-height:44px;flex-wrap:wrap;gap:6px 10px' }, h('span', { class: 'muted', style: 'white-space:nowrap' }, ago(m.created_at)),
        h('span', { class: 'grow' }, `${m.direction === 'in' ? 'From' : 'To'} ${phoneText(m.phone)}`, h('span', { class: 'muted' }, ` · ${r.kinds?.[m.kind] ?? m.kind}`)), tag(tone, word)),
      m.error ? h('p', { class: 'small', style: 'color:var(--amber);margin:8px 0 0' }, m.error) : null,
      h('p', { class: 'small muted', style: 'white-space:pre-wrap;margin:8px 0 0' }, m.body),
      h('div', { style: 'margin-top:6px' }, btn('Copy text', () => copy(m.body, 'Text copied.'), 'ghost'))); })
      : h('p', { class: 'muted' }, f.q || f.status ? 'No texts match.' : 'No texts yet.'),
      r.data.length >= f.limit ? h('div', { style: 'margin-top:8px' }, btn('Show more', () => { f.limit += 30; draw(); }, 'ghost')) : null);
  }
  await draw();
}

// Test mode only: pretend a family or lead texted in (a reply, STOP, START or HELP) to see what happens.
function pretendReply(done) {
  const from = input({ type: 'tel', placeholder: '(512) 555-0100', 'aria-label': 'Their phone number', style: 'max-width:200px' });
  const body = input({ placeholder: 'What they texted, like STOP or "Tuesday works"', 'aria-label': 'What they texted', style: 'flex:1 1 220px' });
  return h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Pretend someone texted back (test mode)'),
    h('form', { class: 'row wrap', style: 'gap:8px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const r = await post('/v1/texts/simulate', { from: from.value, body: body.value });
      toast(r.stopped ? `${phoneText(r.from)} is stopped now: no more texts to that number.` : r.reply ? `Answered automatically: "${r.reply}"` : 'Reply saved. It shows on their lead and the owner was emailed.');
      body.value = ''; done();
    }); } }, from, body, btn('Add reply', null, 'secondary', { type: 'submit' })));
}

// ---- Exercise video ----
async function videoTab(box, ctx) {
  const cov = await get('/v1/video-coverage');
  const row = (a) => {
    const url = input({ type: 'url', value: a.video_url ?? '', placeholder: 'YouTube, Vimeo or a video file link', 'aria-label': `Video link for ${a.name}`, style: 'flex:1 1 240px' });
    return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('div', { class: 'stack-tight', style: 'flex:1 1 200px;min-width:0' }, h('span', { class: 'strong' }, a.name),
        h('span', { class: 'small muted' }, a.uses ? `In ${a.programs.slice(0, 3).join(', ')}${a.programs.length > 3 ? '…' : ''} (${plural(a.uses, 'workout')})` : 'Not in a program yet')),
      tag(a.problem === 'missing' ? (a.uses ? 'warn' : 'muted') : 'warn', a.problem === 'missing' ? 'No video' : 'Won\'t play'),
      h('form', { class: 'row', style: 'gap:6px;flex:1 1 320px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        await patch(`/v1/exercises/${a.id}`, { video_url: url.value.trim() || null }); toast(`Saved the video for ${a.name}.`); ctx.refresh();
      }); } }, url, btn('Save', null, 'secondary', { type: 'submit' })));
  };
  const inUse = cov.attention.filter((a) => a.uses), rest = cov.attention.filter((a) => !a.uses);
  fill(box, panel('Exercise demo videos', { subtitle: 'Athletes see these in the workout app and on the weight-room screen. YouTube and Vimeo links play in their players; a direct link to a video file (.mp4, .mov, .webm) plays too. Other pages, like Google Drive or Instagram, won\'t play.' },
    h('div', { class: 'row wrap', style: 'gap:6px 16px' }, h('span', { class: 'strong' }, `${cov.with_video} of ${plural(cov.total, 'exercise')} have a video that plays${cov.pct != null ? ` (${cov.pct}%)` : ''}`),
      h('span', { class: 'small muted' }, `YouTube ${cov.by_kind.youtube} · Vimeo ${cov.by_kind.vimeo} · Video files ${cov.by_kind.file}`)),
    cov.attention.length ? null : h('p', { class: 'muted' }, 'Every exercise has a video that plays.'),
    inUse.length ? [h('div', { class: 'dp-label', style: 'margin-top:8px' }, `In programs (${inUse.length}), most used first`), inUse.map(row)] : null,
    rest.length ? h('details', { style: 'margin-top:8px' }, h('summary', { class: 'small muted', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Not in a program yet (${rest.length})`), rest.map(row)) : null));
}

// =====================================================================================================================
// Settings: staff, security, backups and jobs, data requests, the activity report
// =====================================================================================================================
const ROLE = { owner: 'Owner', coach: 'Coach', front_desk: 'Front desk' };
const workText = (w) => [w.sessions && plural(w.sessions, 'upcoming session'), w.classes && plural(w.classes, 'class', 'classes'), w.hours && `${plural(w.hours, 'block')} of hours`].filter(Boolean).join(', ');
// What each role can do, for the table and the add form.
const CAN = [
  ['Clients, families, check-ins, bookings and rosters', 'yes', 'yes', 'yes'],
  ['Point of sale (take payments)', 'yes', 'yes', 'yes'],
  ['Schedule: classes, hours, subs', 'yes', 'yes', 'view'],
  ['Testing, results and programs', 'yes', 'yes', 'enter results, view programs'],
  ['Refunds', 'yes', 'undo their own sale for 10 minutes', 'no'],
  ['Money: billing, takings, school contracts, prices', 'yes', 'no', 'no'],
  ['Staff, API keys, webhooks, backups, activity log', 'yes', 'no', 'no']
];
function rolesTable() {
  const cell = (v) => h('td', { class: 'small' }, v === 'yes' ? h('span', { class: 'good-text' }, 'Yes') : v === 'no' ? h('span', { class: 'muted' }, 'No') : v === 'view' ? 'View only' : v);
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Owner'), h('th', null, 'Coach'), h('th', null, 'Front desk'))),
    h('tbody', null, CAN.map(([what, ...v]) => h('tr', null, h('td', { class: 'small' }, what), ...v.map(cell))))));
}

// =====================================================================================================================
// Settings. Everyone sees the exercise library; the other tabs are the owner's (the server refuses them to staff anyway).
// =====================================================================================================================
const SETTINGS_TABS = [['exercises', 'Exercise library'], ['import', 'Data import'], ['staff', 'Staff'], ['security', 'Security'], ['backups', 'Backups & jobs'], ['requests', 'Data requests'], ['activity', 'Activity report']];
export async function viewSettings(main) {
  const owner = me()?.role === 'owner', coach = me()?.role === 'coach';
  const list = owner ? SETTINGS_TABS : coach ? SETTINGS_TABS.slice(0, 2) : SETTINGS_TABS.slice(0, 1);   // coaches bring in data too; front desk sees the library
  let current = list.some(([k]) => k === queryOf().get('tab')) ? queryOf().get('tab') : 'exercises';
  const body = h('div', { id: 'tab-panel', role: 'tabpanel', class: 'stack', style: 'margin-top:16px' });
  const loaders = { exercises: async (box) => fill(box, await exerciseLibrary()), import: importTab, staff: staffTab, security: securityTab, backups: backupsTab, requests: async (box) => fill(box, requestsPanel(await get('/v1/data-requests'))), activity: activityTab };
  let loading = 0;
  async function loadTab() {
    const n = ++loading;
    const box = h('div', { class: 'stack' });
    try { await loaders[current](box); } catch (e) { fill(box, h('p', { class: 'dp-error' }, e.message)); }
    if (n === loading) fill(body, box);
  }
  const t$ = list.length > 1 ? tabs(list, current, (key) => { current = key; setQuery('settings', { tab: key === 'exercises' ? '' : key }); loadTab(); }) : null;
  fill(main, header('Settings', owner ? 'Your exercise library, data import, staff, security, backups, data requests and the activity report.' : coach ? 'The exercise library, and bringing in athletes\' data from wearables and spreadsheets.' : 'The exercise library: every exercise with its category, coaching cues and demo video.'), t$?.bar, body);
  await loadTab();
}

// Data import: bring an athlete's numbers in from a wearable or another app (a CSV, an Excel file, a Google Sheets link or
// a PDF). The athlete is always picked here; nothing in the file is matched by name.
async function importTab(box) {
  const clients = (await get('/v1/clients')).data;
  const pre = queryOf().get('client');
  const find = input({ type: 'search', placeholder: 'Find an athlete by name or Athlete ID', 'aria-label': 'Find an athlete', autocomplete: 'off' });
  const pick = select([['', 'Choose the athlete'], ...clients.map((c) => [c.id, `${c.name}${c.athlete_id ? ` · ${c.athlete_id}` : ''}`])], { value: clients.some((c) => c.id === pre) ? pre : '', 'aria-label': 'Athlete' });
  find.addEventListener('input', () => {
    const q = find.value.trim().toLowerCase();
    for (const o of pick.options) if (o.value) o.hidden = !!q && !o.textContent.toLowerCase().includes(q);
    const hits = [...pick.options].filter((o) => o.value && !o.hidden);
    if (hits.length === 1) pick.value = hits[0].value;
  });
  const recentBox = h('div');
  const loadRecent = async () => fill(recentBox, importsList((await get('/v1/data-imports')).data, { showAthlete: true, undo: async (id) => { const r = await post(`/v1/data-imports/${id}/undo`); toast(`Undone: ${plural(r.removed_values, 'value')} and ${plural(r.removed_workouts, 'workout')} removed.`); loadRecent(); } }));
  const form = importForm({
    athlete: () => { const c = clients.find((x) => x.id === pick.value); return c ? { id: c.id, name: c.name } : null; },
    preview: (b) => post('/v1/data-imports/preview', b),
    commit: (b) => post('/v1/data-imports', b),
    sources: () => get('/v1/data-imports/sources'),
    onSaved: () => loadRecent()
  });
  // Wearables that connect on their own (WHOOP, Oura): what's set up, and how the owner sets one up.
  const wear = await get('/v1/wearables/status');
  const wearPanel = panel('Wearables that connect on their own', { subtitle: 'Once a provider is set up, parents see a Connect button on the Progress tab and coaches one on the client page; the athlete\'s numbers then arrive every few hours without files.' },
    h('div', { class: 'stack' }, wear.providers.map((p) => h('div', { class: 'list-item', style: 'flex-wrap:wrap;align-items:flex-start' },
      h('div', { class: 'grow stack-tight', style: 'min-width:240px' }, h('span', { class: 'strong' }, p.label),
        h('span', { class: `small ${p.ready ? 'good-text' : 'muted'}` }, p.ready ? 'Set up. Families can connect.' : 'Not set up yet.'),
        p.ready ? null : h('span', { class: 'small muted' }, p.help),
        h('span', { class: 'small muted' }, 'Redirect address to register with them: ', h('code', { style: 'user-select:all' }, p.redirect_uri))))),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Apple Health and Garmin don\'t offer this kind of link, so their exports still come in as files below.')));
  fill(box, wearPanel, panel('Bring in data', { subtitle: 'An athlete\'s numbers from any system: pick where the file comes from (WHOOP, Oura, Garmin, Apple Health, Fitbit, Strava, TrainingPeaks) and the menu says how to get the export; any other spreadsheet you match up once, saving its columns as the measures we track. It shows on their client page and to the athlete and their parents. Parents can bring in their own athlete\'s files from the parent portal too.' },
    h('div', { class: 'form-grid' }, field('Athlete', h('div', { class: 'stack-tight' }, find, pick))), form),
    panel('Recently brought in', { subtitle: 'Undo removes what that import saved.' }, recentBox));
  await loadRecent();
}

async function staffTab(box) {
  const staff = await get('/v1/staff');
  const addBtn = btn('Add staff member', () => addStaffDialog(staff.roles), 'primary');
  // Turned-off accounts fold away, unless they still lead something that needs handing over.
  const on = staff.data.filter((u) => u.active || u.still_leading), off = staff.data.filter((u) => !u.active && !u.still_leading);
  const row = (u) => h('div', { class: 'list-item', style: `flex-wrap:wrap;${u.active ? '' : 'opacity:.7'}` },
    h('div', { class: 'grow stack-tight', style: 'min-width:220px' },
      h('span', { class: 'strong' }, u.name, u.id === me().id ? h('span', { class: 'small muted' }, ' (you)') : null),
      h('span', { class: 'small muted' }, `${u.email} · ${u.last_login_at ? `last signed in ${ago(u.last_login_at).toLowerCase()}` : 'never signed in'}${u.devices ? ` · ${plural(u.devices, 'device')}` : ''}`),
      u.still_leading ? h('span', { class: 'small warn-text' }, `Still leads ${workText(u.work)}.`) : null),
    tag(u.role === 'owner' ? 'neutral' : 'muted', ROLE[u.role]),
    u.locked ? tag('warn', 'Locked') : null, !u.active ? tag('muted', 'Off') : null, u.active && u.never_signed_in && u.must_change_password ? tag('muted', 'Invited') : null,
    u.still_leading ? btn('Hand over', () => handOverDialog(u), 'secondary') : null,
    btn('Manage', () => manageDialog(u.id, staff.roles), 'ghost', { 'aria-label': `Manage ${u.name}` }));
  fill(box, panel('Staff', { subtitle: 'Each person has their own sign-in. Their role decides what they can see and do.', action: addBtn },
    on.map(row), off.length ? h('details', { style: 'margin-top:8px' }, h('summary', { class: 'small muted', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Turned off (${off.length})`), off.map(row)) : null,
    h('details', { style: 'margin-top:12px' }, h('summary', { class: 'strong small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'What each role can do'), rolesTable())));
}

async function securityTab(box) {
  const s = await get('/v1/staff/summary');
  const leading = s.still_leading;
  fill(box, h('div', { class: 'pulse' },
    pulseTile('Can sign in', String(s.can_sign_in), s.turned_off ? `${s.turned_off} turned off` : 'Everyone is on', { href: '#/settings?tab=staff' }),
    pulseTile('Locked', String(s.locked), s.locked ? 'Too many wrong passwords' : 'None', { tone: s.locked ? 'warn' : null, href: '#/settings?tab=staff' }),
    pulseTile('Not signed in yet', String(s.not_signed_in_yet), s.not_signed_in_yet ? 'Invited, waiting' : 'Everyone has', { href: '#/settings?tab=staff' }),
    pulseTile('Failed sign-ins', String(s.failed_sign_ins_24h), 'Last 24 hours', { tone: s.failed_sign_ins_24h >= 10 ? 'warn' : null, href: '#/settings?tab=activity&log=failures' }),
    pulseTile('Refused', String(s.refused_7d), 'Requests a role can\'t make, 7 days', { href: '#/settings?tab=activity&log=refused' }),
    pulseTile('Last backup', s.backups.last_at ? ago(s.backups.last_at) : 'None', s.backups.overdue ? 'Overdue: check Backups & jobs' : s.backups.count ? `${s.backups.count} kept, ${kb(s.backups.total_bytes)}` : 'Not in this copy', { tone: s.backups.overdue ? 'warn' : null, href: '#/settings?tab=backups' }),
    leading.length ? pulseTile('Still leading', String(leading.length), `${leading.map((u) => u.name).join(', ')}: hand over their sessions`, { tone: 'warn', href: '#/settings?tab=staff' }) : null),
  connectionPanel());
}

async function backupsTab(box) {
  const [s, bk, jobs, fc] = await Promise.all([get('/v1/staff/summary'), get('/v1/backups'), get('/v1/jobs'), get('/v1/form-checks/status')]);
  fill(box, backupsPanel(bk, s), formChecksPanel(fc), jobsPulldown(jobs));
}

function addStaffDialog(roles) {
  const name = input({ autocomplete: 'off', maxlength: '120' }), email = input({ type: 'email', autocomplete: 'off' });
  const role = select(Object.keys(roles).map((k) => [k, ROLE[k]]), { value: 'coach' });
  const help = h('p', { class: 'small muted', style: 'margin:0' }, roles.coach);
  role.addEventListener('change', () => { help.textContent = roles[role.value]; });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try {
      const u = await post('/v1/staff', { name: name.value, email: email.value, role: role.value });
      showOneTime(u.name, u.temporary_password, 'Their sign-in details were emailed to them.');
      render();
    } catch (x) {
      err.textContent = x.message;
      if (x.details?.user_id && x.details.active === false) err.append(' ', btn('Open their account', () => manageDialog(x.details.user_id, roles), 'ghost'));
    }
  }); } },
    h('h2', { class: 'dp-panel-title' }, 'Add a staff member'),
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))' }, field('Name', name), field('Email', email), field('Role', role)), help,
    h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Compare the roles'), rolesTable()),
    h('p', { class: 'small muted', style: 'margin:0' }, 'They get a one-time password by email and choose their own when they first sign in.'),
    err, h('div', { class: 'row wrap' }, btn('Add staff member', null, 'primary', { type: 'submit' }), btn('Cancel', () => dialog().close(), 'ghost'))));
  name.focus();
}
function showOneTime(who, pw, note) {
  openDialog(h('div', { class: 'stack' }, h('h2', { class: 'dp-panel-title' }, `One-time password for ${who}`), codeBlock(pw),
    h('p', { class: 'small muted', style: 'margin:0' }, `${note} They'll choose their own password when they sign in. This is the only time it's shown here.`),
    h('div', { class: 'row wrap' }, btn('Copy', () => copy(pw, 'Password copied.'), 'outline'), btn('Done', () => dialog().close(), 'primary'))));
}

async function manageDialog(id, roles) {
  let u;
  try { u = await get(`/v1/staff/${id}`); } catch (e) { return toast(e.message, 'warn'); }
  const self = u.id === me().id;
  const reopen = () => manageDialog(id, roles);
  const name = input({ value: u.name, maxlength: '120' }), email = input({ type: 'email', value: u.email });
  const role = select(Object.keys(roles).map((k) => [k, ROLE[k]]), { value: u.role, disabled: self });
  const roleHelp = h('p', { class: 'small muted', style: 'margin:0' }, roles[u.role]);
  role.addEventListener('change', () => { roleHelp.textContent = roles[role.value]; });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const section = (title, ...kids) => h('section', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px;gap:8px' }, h('h3', { class: 'dp-label', style: 'margin:0' }, title), ...kids);
  const save = (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    const body = {};
    if (name.value.trim() !== u.name) body.name = name.value;
    if (email.value.trim().toLowerCase() !== u.email.toLowerCase()) body.email = email.value;
    if (role.value !== u.role) {
      if (role.value === 'owner' && !confirm(`Make ${u.name} an owner? Owners see all money, staff and API keys, and can change anyone's account.`)) return;
      if (role.value === 'front_desk' && (u.work.sessions || u.work.classes || u.work.hours) && !confirm(`${u.name} still leads ${workText(u.work)}. Front desk accounts don't lead sessions: hand them over next. Change the role?`)) return;
      body.role = role.value;
    }
    if (!Object.keys(body).length) { err.textContent = 'Nothing changed.'; return; }
    try {
      await patch(`/v1/staff/${u.id}`, body);
      toast(body.role ? `${u.name} is now ${ROLE[body.role]}. They'll sign in again.` : 'Saved.');
      render();
      if (body.role === 'front_desk' && (u.work.sessions || u.work.classes || u.work.hours)) return handOverDialog({ ...u, role: body.role });
      reopen();
    } catch (x) { err.textContent = x.message; }
  }); };
  const devices = u.devices.length ? u.devices.map((d) => h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
    h('span', { class: 'grow' }, h('span', { class: 'strong' }, d.device), d.current ? h('span', { class: 'muted' }, ' (this device)') : null,
      h('span', { class: 'muted' }, ` · ${d.ip ?? 'address not recorded'} · signed in ${d.signed_in_at ? date(d.signed_in_at) : 'before this was recorded'} · last used ${ago(d.last_seen_at).toLowerCase()}`)),
    d.current ? null : btn('Sign out', (e) => busy(e.currentTarget, async () => { await post(`/v1/staff/${u.id}/devices/${d.id}/sign-out`); toast(`Signed out of ${d.device}.`); reopen(); }), 'ghost')))
    : h('p', { class: 'small muted', style: 'margin:0' }, 'Not signed in anywhere.');
  const activity = u.recent.length ? u.recent.map((a) => h('div', { class: 'small', style: 'padding:4px 0;border-bottom:1px solid var(--line-subtle)' },
    h('span', { class: 'muted' }, `${when(a.at)} · `), actionText(a), a.status >= 400 ? h('span', { class: 'warn-text' }, ` (${resultWord(a.status)})`) : null))
    : h('p', { class: 'small muted', style: 'margin:0' }, 'Nothing yet.');
  const invite = u.never_signed_in && u.must_change_password;
  openDialog(h('div', { class: 'stack' },
    h('div', { class: 'row wrap' }, h('h2', { class: 'dp-panel-title grow' }, u.name, self ? ' (you)' : ''), tag(u.role === 'owner' ? 'neutral' : 'muted', ROLE[u.role]), u.locked ? tag('warn', 'Locked') : null, u.active ? null : tag('muted', 'Off')),
    h('form', { class: 'stack', onSubmit: save },
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))' }, field('Name', name), field('Email', email, 'A new email cancels any reset link sent to the old one.'), field('Role', role, self ? 'Another owner can change your role.' : null)),
      roleHelp, err, h('div', null, btn('Save changes', null, 'primary', { type: 'submit' }))),
    section('What they lead', h('p', { class: 'small', style: 'margin:0' }, workText(u.work) ? `${workText(u.work)}${u.work.booked_clients ? `, with ${plural(u.work.booked_clients, 'client')} booked` : ''}.` : 'Nothing from now on.'),
      workText(u.work) ? h('div', null, btn('Hand over their sessions', () => handOverDialog(u), 'secondary')) : null),
    section('Signed in on', devices, u.devices.some((d) => !d.current) ? h('div', null, btn(self ? 'Sign out my other devices' : 'Sign out everywhere', (e) => busy(e.currentTarget, async () => {
      const r = await post(`/v1/staff/${u.id}/sign-out`); toast(`Signed out of ${plural(r.signed_out, 'device')}.`); reopen();
    }), 'secondary')) : null),
    section('Recent activity', activity, h('div', null, btn('See all in the activity report', () => { dialog().close(); filterLogTo(u.id); }, 'ghost'))),
    section('Account',
      h('div', { class: 'row wrap', style: 'gap:6px' },
        u.active ? btn(invite ? 'Resend invite' : 'Reset password', (e) => { if (confirm(invite ? `Email ${u.name} a new one-time password?` : `Give ${u.name} a new one-time password? They're signed out everywhere and any reset link they asked for stops working.`)) busy(e.currentTarget, async () => { const r = await post(`/v1/staff/${u.id}/reset-password`); showOneTime(u.name, r.temporary_password, 'It was emailed to them.'); render(); }); }, 'secondary') : null,
        u.locked ? btn('Unlock', (e) => busy(e.currentTarget, async () => { await patch(`/v1/staff/${u.id}`, { unlock: true }); toast(`${u.name} can sign in again.`); render(); reopen(); }), 'secondary') : null,
        self ? null : btn(u.active ? 'Turn off' : 'Turn on', (e) => {
          if (u.active && !confirm(`Turn off ${u.name}'s account? They're signed out everywhere right away.${workText(u.work) ? ` They still lead ${workText(u.work)}: you'll hand those over next.` : ''}`)) return;
          busy(e.currentTarget, async () => { await patch(`/v1/staff/${u.id}`, { active: !u.active }); toast(u.active ? `${u.name}'s account is off.` : `${u.name}'s account is on.`); render(); if (u.active && workText(u.work)) handOverDialog({ ...u, active: false }); else reopen(); });
        }, 'ghost'))),
    h('div', null, btn('Close', () => dialog().close(), 'ghost'))));
}

async function handOverDialog(u) {
  const coaches = (await get('/v1/staff')).data.filter((x) => x.active && x.id !== u.id && x.role !== 'front_desk')
    .sort((a, b) => (a.role === 'coach' ? 0 : 1) - (b.role === 'coach' ? 0 : 1) || a.name.localeCompare(b.name));   // another coach before an owner
  const to = select([...coaches.map((c) => [c.id, `${c.name} (${ROLE[c.role]})`]), ['none', 'Nobody for now']], { value: coaches[0]?.id ?? 'none' });
  const out = h('div', { class: 'stack', style: 'gap:6px' });
  const leave = h('input', { type: 'checkbox' });
  const leaveRow = h('label', { class: 'row small', style: 'gap:8px;min-height:44px;display:none' }, leave, h('span', null, 'Leave the clashing sessions with ', u.name, ' for now (sort them out on the schedule)'));
  const err = h('div', { class: 'dp-error', role: 'alert' });
  async function preview() {
    err.textContent = '';
    const p = await get(`/v1/staff/${u.id}/hand-over?to=${encodeURIComponent(to.value)}`).catch((e) => { err.textContent = e.message; return null; });
    if (!p) return;
    const nobody = to.value === 'none';
    fill(out, h('p', { class: 'small', style: 'margin:0' }, workText(p.work) ? `Moves ${workText(p.work)}${nobody ? '. With nobody, sessions and classes have no coach and the hours are removed' : ''}.` : 'Nothing left to hand over.'),
      p.upcoming.length ? h('div', { class: 'small muted' }, 'Next: ', p.upcoming.slice(0, 4).map((x) => `${x.name} ${when(x.starts_at)}${x.booked ? ` (${x.booked} booked)` : ''}`).join(' · ')) : null,
      p.conflicts.length ? h('div', { class: 'small warn-text', role: 'status' }, `${p.to.name} is busy for ${p.conflicts.length === 1 ? 'one of these sessions' : `${p.conflicts.length} of these sessions`}: `,
        h('ul', { style: 'margin:4px 0 0;padding-left:20px' }, p.conflicts.slice(0, 6).map((c) => h('li', null, c.message))), p.conflicts.length > 6 ? `And ${p.conflicts.length - 6} more.` : null) : null);
    leaveRow.style.display = p.conflicts.length ? '' : 'none';
    if (!p.conflicts.length) leave.checked = false;
  }
  to.addEventListener('change', preview);
  openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try {
      // Clashes are warnings, as for every coach change: leave them behind, or "Save anyway" hands everything over.
      const r = await saveAnyway((extra) => post(`/v1/staff/${u.id}/hand-over`, { to: to.value === 'none' ? null : to.value, leave_conflicts: leave.checked, ...extra }));
      if (!r) return;
      const moved = [r.sessions && plural(r.sessions, 'session'), r.classes && plural(r.classes, 'class', 'classes'), r.hours && `${plural(r.hours, 'block')} of hours${r.hours_removed ? ' removed' : ''}`].filter(Boolean).join(', ');
      dialog().close(); toast(`${moved || 'Nothing'} ${r.to ? `handed to ${r.to.name}` : 'left without a coach'}.${r.left_with_them ? ` ${plural(r.left_with_them, 'clashing session')} left with ${u.name}.` : ''}`); render();
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'dp-panel-title' }, `Hand over ${u.name}'s sessions`),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Everything they lead from now on moves: upcoming sessions (including ones they sub for), their classes, camps and clinics, and their private hours. Past sessions keep who led them.'),
    field('Who takes over', to), out, leaveRow, err,
    h('div', { class: 'row wrap' }, btn('Hand over', null, 'primary', { type: 'submit' }), btn('Not now', () => dialog().close(), 'ghost'))));
  preview();
}

// Form-check clips: where they're kept and for how long (services/formchecks.js). The bucket is the owner's, private, and its own.
function formChecksPanel(fc) {
  const keep = input({ type: 'number', min: '30', max: '365', step: '1', value: String(fc.keep_days), inputmode: 'numeric', style: 'max-width:120px', 'aria-label': 'Days to keep clips' });
  const setup = h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, fc.ready ? 'How it\'s set up' : 'How to set it up'),
    h('ol', { class: 'small stack-tight', style: 'margin:0;padding-left:20px' },
      h('li', null, 'In Cloudflare R2, make a new bucket for the clips (like ', h('code', null, 'dp-athlete-videos'), '). Keep it private: no public access, no custom domain. Never the backups bucket, never the public exercise-video bucket.'),
      h('li', null, 'On that bucket\'s Settings → CORS policy, allow ', h('code', null, 'PUT'), ' and ', h('code', null, 'GET'), ' from ', fc.cors_origins.map((o, i) => [i ? ' and ' : '', h('code', { style: 'user-select:all' }, o)]), ', with ', h('code', null, 'content-type'), ' as an allowed header and ', h('code', null, 'etag'), ' exposed.'),
      h('li', null, 'Make an R2 API token with object read and write on that bucket (or widen the backups\' token to it), then add ', h('code', null, 'FORMCHECK_S3_BUCKET'), ' in Render, plus ', h('code', null, 'FORMCHECK_S3_ENDPOINT'), ', ', h('code', null, 'FORMCHECK_S3_KEY_ID'), ' and ', h('code', null, 'FORMCHECK_S3_SECRET'), ' when they differ from the backups\'. DEPLOY.md has the same steps.')));
  return panel('Form-check videos', { subtitle: 'Athletes film a set in the app and send it; coaches watch and answer on the client page and from Today. The clips are videos of minors, so they live only in a private bucket of yours, are played through short-lived links, and are removed after the keep time.' },
    h('p', { class: 'small', style: 'margin:0' }, tag(fc.ready ? 'good' : 'muted', fc.ready ? 'Set up' : 'Not set up'), ' ',
      fc.ready ? `Bucket ${fc.bucket}. ${fc.stored.n} ${fc.stored.n === 1 ? 'clip' : 'clips'} on file (${kb(fc.stored.bytes)}), ${fc.waiting} waiting for an answer. Clips up to ${fc.max_seconds} seconds and ${fc.max_mb} MB, ten a day per athlete.` : 'Athletes don\'t see the Send a form check button until the bucket is set up.'),
    fc.problems.length ? h('ul', { class: 'small warn-text', style: 'margin:0;padding-left:20px' }, fc.problems.map((p) => h('li', null, p))) : null,
    setup,
    h('div', { class: 'row wrap', style: 'gap:8px;align-items:flex-end' }, field('Keep clips for (days)', keep, '30 to 365. Clips already sent keep the time they were given.'),
      btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { form_check_keep_days: keep.value }); toast(`New clips are kept ${keep.value} days.`); }), 'secondary')));
}
function backupsPanel(bk, s) {
  const off = bk.offsite;
  const offFailing = off.last_error && (!off.last_ok_at || off.last_error_at > off.last_ok_at);
  const offLine = h('p', { class: 'small' + (offFailing ? '' : ' muted'), role: offFailing ? 'status' : null },
    tag(!off.configured || (!off.last_ok_at && !offFailing) ? 'muted' : offFailing ? 'warn' : 'good', !off.configured ? 'Off-site: not set up' : offFailing ? 'Off-site: failing' : off.last_ok_at ? 'Off-site: OK' : 'Off-site: waiting'), ' ',
    !off.configured ? 'Copies stay on this server\'s disk only. Setup steps are in DEPLOY.md under Backups.'
      : offFailing ? `${off.last_error} Last try: ${ago(off.last_error_at)}. It retries every hour.`
      : off.last_ok_at ? `Newest encrypted copy sent and restore-checked. Last sent: ${ago(off.last_ok_at)}.` : 'The first encrypted copy goes out within the hour.');
  const line = (b) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, new Date(b.created_at).toLocaleString()), h('span', { class: 'muted' }, kb(b.bytes)),
    btn('Download', (ev) => busy(ev.currentTarget, () => download(`/v1/backups/${b.name}`)), 'ghost', { 'aria-label': `Download the backup from ${new Date(b.created_at).toLocaleString()}` }));
  const newest = bk.data.slice(0, 5), older = bk.data.slice(5);
  return panel('Backups', { subtitle: `A full copy of everything is saved every day, and the last 30 are kept${bk.data.length ? ` (${bk.data.length} now, ${kb(s.backups.total_bytes)} in all)` : ''}. ${off.configured ? 'Each day\'s copy is also encrypted, sent to off-site storage, and read back to check it restores.' : 'Download one now and then and keep it somewhere safe, off this server.'}` },
    s.backups.overdue ? h('p', { class: 'small warn-text', role: 'status', style: 'margin:0' }, `No backup in more than a day${s.backups.last_at ? ` (last: ${ago(s.backups.last_at).toLowerCase()})` : ''}. Check the daily-backup job under Background jobs, or back up now.`) : null,
    offLine,
    newest.length ? newest.map(line) : h('p', { class: 'muted small' }, 'No backups yet.'),
    older.length ? h('details', null, h('summary', { class: 'small muted', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Older backups (${older.length})`), older.map(line)) : null,
    h('div', null, btn('Back up now', (ev) => busy(ev.currentTarget, async () => {
      const r = await post('/v1/backups');
      if (r.offsite && !r.offsite.ok) toast(`Backup saved, but the off-site copy failed: ${r.offsite.error}`, 'warn');
      else toast(r.offsite ? 'Backup saved and sent off-site.' : 'Backup saved.');
      render();
    }), 'secondary')),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Backup files contain client, family and medical information. Store them like you would paper records.'));
}
let jobsOpen = false;     // stays open across a Run now
function jobsPulldown(jobs) {
  const every = (sec) => (sec < 60 ? `every ${sec} seconds` : sec < 3600 ? `every ${sec / 60} min` : sec === 3600 ? 'hourly' : `every ${sec / 3600} hours`);
  const jobBadge = (j) => (j.running ? ['muted', 'Running'] : j.health === 'failing' ? ['warn', j.fail_streak > 1 ? `Failed ${j.fail_streak}×` : 'Failed'] : j.health === 'waiting' ? ['muted', 'Not run yet'] : j.recent[0]?.status === 'skipped' && j.recent[0].started_at === j.last_run_at ? ['muted', 'Nothing to do'] : ['good', 'OK']);
  const failing = jobs.data.filter((j) => j.health === 'failing'), running = jobs.data.filter((j) => j.running).length;
  const d = h('details', { class: 'dp-panel', open: jobsOpen || null, onToggle: () => { jobsOpen = d.open; } },
    h('summary', { style: 'cursor:pointer;min-height:44px;display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
      h('span', { class: 'dp-panel-title', style: 'margin:0' }, 'Background jobs'),
      tag(failing.length ? 'warn' : 'good', failing.length ? `${failing.length} failing` : 'All OK'),
      h('span', { class: 'small muted' }, failing.length ? failing.map((j) => j.name).join(', ') : `${plural(jobs.data.length, 'job')}${running ? `, ${running} running now` : ''}. Open to see each one.`)),
    h('p', { class: 'small muted' }, 'The work the server does on its own: billing, school invoices, the schedule, reminders, follow-ups, money checks, webhooks, device syncs and backups. Owners get an email when a job fails and when it recovers.'),
    jobs.data.map((j) => { const [tone, label] = jobBadge(j); return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', { class: 'strong' }, j.name),
        h('span', { class: 'small muted' }, `${every(j.every_seconds)}${j.last_run_at ? ` · last ran ${ago(j.last_run_at)}` : ''}${j.health === 'failing' ? (j.last_ok_at ? ` · last worked ${ago(j.last_ok_at)}` : ' · has not worked yet') : ''}`),
        j.last_error ? h('span', { class: 'small', style: 'font-family:var(--font-mono);word-break:break-word' }, j.last_error) : null),
      tag(tone, label),
      btn('Run now', (ev) => busy(ev.currentTarget, async () => {
        const r = await post(`/v1/jobs/${encodeURIComponent(j.name)}/run`);
        toast(r.status === 'failed' ? `${j.name} failed. The error is shown below.` : r.status === 'skipped' ? `${j.name} had nothing to do.` : `${j.name} ran.`, r.status === 'failed' ? 'warn' : 'good');
        render();
      }), 'ghost', j.running ? { disabled: true, 'aria-label': `Run ${j.name} now` } : { 'aria-label': `Run ${j.name} now` })); }));
  return d;
}
function requestsPanel(requests) {
  const openReqs = requests.data.filter((r) => r.status === 'open');
  return panel('Data requests', { subtitle: openReqs.length ? 'Parents asking for their family\'s data to be deleted. Check with your accountant what payment records you must keep; the app keeps them without names.' : 'Parents can download their own data from the portal. Deletion requests appear here.' },
    requests.data.length ? requests.data.slice(0, 20).map((r) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:240px' }, h('span', { class: 'strong' }, `${r.family_name ?? 'Family'}: ${r.kind === 'delete' ? 'delete account' : 'copy of data'}`),
        h('span', { class: 'small muted' }, `${r.requested_by.split(' <')[0]} · ${ago(r.created_at)}${r.note ? ` · "${r.note}"` : ''}${r.resolution ? ` · ${r.resolution}` : ''}`)),
      tag(r.status === 'open' ? 'warn' : r.status === 'done' ? 'good' : 'muted', { open: 'Open', done: 'Done', declined: 'Declined' }[r.status]),
      r.status === 'open' && r.family_id ? btn('Download their data', (e) => busy(e.currentTarget, () => download(`/v1/families/${r.family_id}/export`)), 'ghost') : null,
      r.status === 'open' && r.family_id ? btn('Delete', (e) => {
        const typed = prompt(`Delete the ${r.family_name}'s personal information? Payment records stay without names. This can't be undone.\n\nType the family name to confirm: ${r.family_name}`);
        if (!typed) return;
        busy(e.currentTarget, async () => { await del(`/v1/families/${r.family_id}`, { confirm: typed, request_id: r.id }); toast('Deleted. The family has been emailed.'); render(); });
      }, 'outline') : null,
      r.status === 'open' ? btn('Decline', (e) => { const reason = prompt('Why? (kept with the request)'); if (reason) busy(e.currentTarget, async () => { await post(`/v1/data-requests/${r.id}/decline`, { reason }); render(); }); }, 'ghost') : null))
      : h('p', { class: 'muted small' }, 'No requests yet.'));
}
function connectionPanel() {
  const connOut = h('div', { class: 'stack-tight' });
  return panel('Connection check', { subtitle: 'Sign-in limits and the activity log go by the visitor\'s internet address. This shows which one the app sees for you, so you can confirm the TRUST_PROXY setting on each server.' },
    connOut, h('div', null, btn('Check my connection', (ev) => busy(ev.currentTarget, async () => {
      const c = await get('/v1/staff/connection');
      const row = (label, value) => h('div', { class: 'list-item small', style: 'flex-wrap:wrap' }, h('span', { class: 'grow muted', style: 'min-width:180px' }, label), h('code', { style: 'word-break:break-all' }, value ?? 'none'));
      const KIND = { private: 'hosting network', cloudflare: 'Cloudflare proxy', public: 'public' };
      fill(connOut, row('X-Forwarded-For header', c.forwarded_for), row('Connection address', c.connection_address), row('Address the app decided on', c.decided_address), row('TRUST_PROXY', c.trust_proxy ?? 'not set'),
        h('p', { class: 'strong', style: 'margin:8px 0 0' }, c.guidance),
        ...(c.previews ?? []).map((p) => h('div', { class: 'small', style: `padding:2px 0${p.trust_proxy === c.proxies_trusted ? ';font-weight:600' : ''}` }, `With TRUST_PROXY=${p.trust_proxy} the app would pick: `, h('code', null, p.address), h('span', { class: 'muted' }, ` (${KIND[p.kind] ?? p.kind})${p.trust_proxy === c.proxies_trusted ? ' · now' : ''}`))));
    }), 'secondary')));
}

// ---- Activity log ----
const resultWord = (s) => (s < 300 ? 'OK' : s === 403 ? 'Refused' : s === 401 ? 'Denied' : s === 429 ? 'Blocked' : String(s));
const actionText = (a) => (a.action === 'sign-in' ? (a.status === 200 ? 'Signed in' : a.status === 429 ? 'Sign-in blocked (locked or too many tries)' : 'Failed sign-in') : a.description ?? a.action);
const WHO = [['', 'Everyone'], ['staff', 'Staff'], ['api_key', 'API keys'], ['parent', 'Parents'], ['athlete', 'Athletes (app link)'], ['public', 'Sign-in page and public'], ['system', 'System']];
const KIND = [['', 'Everything'], ['sign_ins', 'Sign-ins and resets'], ['refused', 'Refused'], ['failures', 'Anything that failed']];
let logFilter = { who: '', staff_id: '', kind: '', since: '', until: '', q: '' };
let runLogNow = false;       // set when another screen asks for the report (a tile, a staff member's "See all")
// From a staff member's manage panel: the report for just them.
const filterLogTo = (id) => { logFilter = { who: '', staff_id: id, kind: '', since: '', until: '', q: '' }; runLogNow = true; location.hash = '#/settings?tab=activity'; };
// The activity report: nothing loads until the owner picks filters and presses Show report (or arrives from a tile).
async function activityTab(box) {
  const staff = (await get('/v1/staff')).data;
  const fromUrl = queryOf().get('log');
  if (fromUrl === 'failures' || fromUrl === 'refused') { logFilter = { ...logFilter, kind: fromUrl }; runLogNow = true; setQuery('settings', { tab: 'activity' }); }
  const f = logFilter;
  const who = select(WHO, { value: f.who, 'aria-label': 'Who', style: 'width:auto' });
  const person = select([['', 'Any staff member'], ...staff.map((u) => [u.id, u.name])], { value: f.staff_id, 'aria-label': 'Staff member', style: 'width:auto;max-width:200px' });
  const kind = select(KIND, { value: f.kind, 'aria-label': 'What', style: 'width:auto' });
  const since = input({ type: 'date', value: f.since, 'aria-label': 'From', style: 'width:auto' }), until = input({ type: 'date', value: f.until, 'aria-label': 'To', style: 'width:auto' });
  const q = input({ type: 'search', value: f.q, placeholder: 'Search names, records, addresses or what happened', 'aria-label': 'Search the activity log', style: 'flex:1 1 220px' });
  const out = h('div', null, h('p', { class: 'muted small' }, 'Pick who, what and the dates, then press Show report. Leave them blank for everything.')), count = h('span', { class: 'small muted', role: 'status' });
  let limit = 50, shown = false;
  const params = () => new URLSearchParams(Object.entries(logFilter).filter(([, v]) => v));
  async function draw() {
    shown = true;
    const qs = params(); qs.set('limit', String(limit));
    let r;
    try { r = await get(`/v1/audit?${qs}`); } catch (e) { return fill(out, h('p', { class: 'dp-error' }, e.message)); }
    count.textContent = `${r.total.toLocaleString()} ${r.total === 1 ? 'entry' : 'entries'}`;
    fill(out, r.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table bl-cards' },
      h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'), h('th', null, 'Record'), h('th', null, 'From'), h('th', null, 'Result'))),
      h('tbody', null, r.data.map((a) => h('tr', null,
        h('td', { class: 'small muted', style: 'white-space:nowrap', title: new Date(a.at).toLocaleString() }, when(a.at)),
        h('td', { class: 'small' }, `${a.actor_name ?? '—'}${a.role ? ` (${ROLE[a.role] ?? a.role})` : a.actor_type !== 'staff' ? ` (${{ api_key: 'API key', public: a.action === 'sign-in' || a.action.startsWith('POST /auth/') ? 'typed' : 'public', parent: 'parent', athlete: 'athlete', system: 'system' }[a.actor_type] ?? a.actor_type})` : ''}`),
        h('td', { class: 'small' }, actionText(a)),
        h('td', { class: 'small muted', style: 'font-family:var(--font-mono);word-break:break-all' }, a.target ?? ''),
        h('td', { class: 'small muted', style: 'font-family:var(--font-mono)' }, a.ip ?? ''),
        h('td', null, tag(a.status < 300 ? 'good' : [401, 403, 429].includes(a.status) ? 'warn' : 'muted', a.status == null ? 'Done' : resultWord(a.status)))))))) : h('p', { class: 'muted' }, 'Nothing matches these filters.'),
      r.total > r.data.length ? h('div', { style: 'margin-top:8px' }, btn(`Show more (${(r.total - r.data.length).toLocaleString()} older)`, () => { limit += 50; draw(); }, 'ghost')) : null);
  }
  const read = () => { logFilter = { who: who.value, staff_id: person.value, kind: kind.value, since: since.value, until: until.value, q: q.value.trim() }; limit = 50; };
  const apply = () => { read(); if (shown) draw(); };     // once the report is showing, changing a filter updates it
  for (const el of [who, person, kind, since, until]) el.addEventListener('change', apply);
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 300); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); read(); draw(); } });
  const run = btn('Show report', (e) => busy(e.currentTarget, async () => { read(); await draw(); }), 'primary');
  const clear = btn('Clear filters', () => { for (const el of [who, person, kind, since, until, q]) el.value = ''; apply(); }, 'ghost');
  const csv = btn('Download CSV', (e) => busy(e.currentTarget, () => { read(); return download(`/v1/audit/export?${params()}`); }), 'outline');
  const p = panel('Activity report', { subtitle: 'Every change, refused attempt and sign-in by staff, API keys and parents. What was typed or sent is never stored (failed sign-ins show the email typed).' },
    h('div', { class: 'row wrap', style: 'gap:8px' }, who, person, kind, h('label', { class: 'row small', style: 'gap:6px' }, 'From', since), h('label', { class: 'row small', style: 'gap:6px' }, 'To', until)),
    h('div', { class: 'row wrap', style: 'gap:8px' }, q, run, csv, clear, count), out);
  if (runLogNow) { runLogNow = false; await draw(); }
  fill(box, p);
}

// =====================================================================================================================
// Your account (every role)
// =====================================================================================================================
export async function viewAccount(main) {
  const a = await get('/auth/account');
  const cur = passwordField('Current password', { autocomplete: 'current-password' });
  const next = passwordField('New password', { autocomplete: 'new-password', minlength: '10' }, 'At least 10 characters.');
  const again = passwordField('New password again', { autocomplete: 'new-password' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const pwPanel = panel('Change your password', { subtitle: 'Your other devices are signed out, and you get an email saying it changed.' },
    h('form', { class: 'stack', style: 'max-width:420px', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
      if (next.input.value.length < 10) { err.textContent = 'Use at least 10 characters.'; return; }
      if (next.input.value !== again.input.value) { err.textContent = 'The new passwords don\'t match.'; return; }
      try { const r = await post('/auth/password', { current_password: cur.input.value, new_password: next.input.value }); toast(`Password changed.${r.signed_out ? ` Signed out of ${plural(r.signed_out, 'other device')}.` : ''}`); render(); }
      catch (x) { err.textContent = x.message; }
    }); } }, cur.el, next.el, again.el, err, h('div', null, btn('Save password', null, 'primary', { type: 'submit' }))));
  const others = a.devices.filter((d) => !d.current);
  const devPanel = panel('Signed in on', { subtitle: 'Sign out a device you no longer use, like a shared computer or a lost phone.' },
    a.devices.map((d) => h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
      h('span', { class: 'grow' }, h('span', { class: 'strong' }, d.device), d.current ? h('span', { class: 'muted' }, ' (this device)') : null,
        h('span', { class: 'muted' }, ` · ${d.ip ?? 'address not recorded'} · last used ${ago(d.last_seen_at).toLowerCase()}`)),
      d.current ? null : btn('Sign out', (e) => busy(e.currentTarget, async () => { await post(`/auth/devices/${d.id}/sign-out`); toast(`Signed out of ${d.device}.`); render(); }), 'ghost'))),
    others.length > 1 ? h('div', null, btn('Sign out all other devices', (e) => busy(e.currentTarget, async () => { const r = await post('/auth/sign-out-others'); toast(`Signed out of ${plural(r.signed_out, 'device')}.`); render(); }), 'secondary')) : null);
  const signIns = panel('Recent sign-ins', { subtitle: 'If you see one that wasn\'t you, change your password and tell the owner.' },
    a.sign_ins.length ? a.sign_ins.map((s) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, when(s.at), h('span', { class: 'muted' }, ` · ${s.ip ?? ''}`)),
      tag(s.status < 300 ? 'good' : 'warn', s.action === 'sign-in' ? (s.status < 300 ? 'Signed in' : 'Failed') : s.action === 'POST /auth/forgot' ? 'Reset asked' : 'Reset used'))) : h('p', { class: 'muted small' }, 'None yet.'));
  fill(main, header('Your account', `${a.user.name} · ${a.user.email} · ${ROLE[a.user.role]}`), h('div', { class: 'grid grid-2' }, pwPanel, devPanel), signIns);
}

// =====================================================================================================================
// Sign-in page extras: Forgot password, and the page a reset link opens
// =====================================================================================================================
export function forgotForm(root, email, back) {
  const box = input({ type: 'email', autocomplete: 'username', required: true, value: email ?? '' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const done = h('p', { class: 'small', role: 'status', style: 'margin:0' });
  const submit = btn('Email me a reset link', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  fill(root, h('div', { class: 'login' }, h('form', { class: 'dp-panel login-card', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(submit, async () => {
    try { const r = await api('POST', '/auth/forgot', { email: box.value }); done.textContent = r.message; submit.disabled = true; submit.style.display = 'none'; }
    catch (x) { err.textContent = x.message; }
  }); } },
    h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.' }),
    h('h1', { class: 'dp-panel-title', style: 'margin:0' }, 'Forgot your password?'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Type the email you sign in with. We\'ll email you a link to choose a new password.'),
    field('Email', box), err, done, submit, btn('Back to sign in', back, 'ghost'))));
  box.focus();
}
export async function renderReset(root, token, back) {
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const card = h('div', { class: 'dp-panel login-card' }, h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.' }), h('p', { class: 'muted' }, 'Checking your link…'));
  fill(root, h('div', { class: 'login' }, card));
  let who;
  try { who = await api('POST', '/auth/reset/check', { token }); }
  // Filled into the page itself (not the card): signed out, the sign-in page may have been drawn over the card meanwhile.
  catch (x) { fill(card, h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.' }), h('h1', { class: 'dp-panel-title', style: 'margin:0' }, 'This link doesn\'t work'), h('p', { class: 'small' }, x.message), btn('Back to sign in', back, 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block' })); fill(root, h('div', { class: 'login' }, card)); return; }
  const next = passwordField('New password', { autocomplete: 'new-password', minlength: '10' }, 'At least 10 characters.');
  const again = passwordField('New password again', { autocomplete: 'new-password' });
  const submit = btn('Save my new password', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  const form = h('form', { class: 'dp-panel login-card', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(submit, async () => {
    if (next.input.value.length < 10) { err.textContent = 'Use at least 10 characters.'; return; }
    if (next.input.value !== again.input.value) { err.textContent = 'The passwords don\'t match.'; return; }
    try {
      await api('POST', '/auth/reset', { token, password: next.input.value });
      fill(form, h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.' }), h('h1', { class: 'dp-panel-title', style: 'margin:0' }, 'Password saved'),
        h('p', { class: 'small', style: 'margin:0' }, 'You\'re signed out on every device. Sign in with your new password.'), btn('Sign in', back, 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block' }));
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.' }),
    h('h1', { class: 'dp-panel-title', style: 'margin:0' }, `Choose a new password, ${who.first_name}`),
    h('p', { class: 'small muted', style: 'margin:0' }, `For ${who.email}. The link works once.`),
    next.el, again.el, err, submit);
  fill(root, h('div', { class: 'login' }, form));
  next.input.focus();
}
export { passwordField };
