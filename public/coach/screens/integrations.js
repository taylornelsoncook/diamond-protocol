// API & integrations: a health strip, then tabs for API keys (access levels, request log, quick start), webhooks
// (edit, test any event, delivery detail, resend, rotate secret), the email outbox (filters, send again, copy) and
// exercise demo video coverage (paste missing links in place).
import { html, mount, api, toast, toastError, modal, confirmDialog, formData, relTime, fmtDateTime, badge, plural, debounce } from '/js/ui.js';

const STYLE = html`<style>
.dpi{display:flex;flex-direction:column;gap:var(--space-6)}
.dpi-code{margin:0;background:var(--black);border:1px solid var(--line);border-radius:var(--radius-sm);padding:var(--space-3) var(--space-4);font:400 13px/20px var(--font-mono);color:var(--steel);overflow-x:auto;white-space:pre}
.dpi-code.wrap{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow-y:auto}
.dpi-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:var(--space-4)}
.dpi-tile{text-align:left;cursor:pointer;font:inherit;color:inherit;min-height:44px}
.dpi-tile:hover{background:var(--surface-raised)}
.dpi-tile[aria-current="true"]{border-color:var(--green-mid)}
.dpi-tile .metric-value{font-size:28px}
.dpi-tile .metric-note.warn{color:var(--amber)}
.dpi-events{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:4px var(--space-4)}
.dpi-events .check{align-items:flex-start;padding:4px 0}
.dpi-events .ev{font:400 13px/20px var(--font-mono);color:var(--steel)}
.dpi-events .about{display:block;font-size:13px;line-height:18px;color:var(--steel-muted)}
.dpi-hook{border:1px solid var(--line);border-radius:var(--radius-sm);padding:var(--space-3) var(--space-4);display:flex;flex-direction:column;gap:var(--space-2)}
.dpi-hook.failing{border-color:var(--amber)}
.dpi-url{font:400 14px/20px var(--font-mono);overflow-wrap:anywhere}
.dpi-dels{display:flex;flex-direction:column}
.dpi-drow{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:4px 12px;align-items:center;min-height:44px;padding:0 8px;margin:0 -8px;background:none;border:0;border-top:1px solid var(--line-subtle);color:var(--steel);font:400 13px/18px var(--font-sans);text-align:left;cursor:pointer;width:calc(100% + 16px)}
.dpi-drow:hover,.dpi-drow:focus-visible{background:var(--surface-raised)}
.dpi-drow .mono{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpi-status{font:600 12px/1 var(--font-mono);padding:4px 8px;border-radius:var(--radius-pill);background:var(--surface-raised);color:var(--steel-muted);white-space:nowrap}
.dpi-status.ok{background:var(--green-deep);color:var(--green-soft)}.dpi-status.bad{background:var(--amber-deep);color:var(--amber)}
.dpi-key{display:flex;align-items:center;gap:var(--space-3);padding:12px 0;border-top:1px solid var(--line-subtle);flex-wrap:wrap}
.dpi-key .grow{flex:1;min-width:220px}
.dpi-secret{font:400 14px/20px var(--font-mono);background:var(--black);border:1px solid var(--green-mid);border-radius:var(--radius-sm);padding:12px;overflow-wrap:anywhere;user-select:all}
.dpi-mail{border-top:1px solid var(--line-subtle)}
.dpi-mail summary{cursor:pointer;padding:12px 0;font-size:14px;line-height:20px;list-style-position:outside;margin-left:16px;min-height:44px}
.dpi-mail summary::marker{color:var(--steel-muted)}
.dpi-mail .body{margin:0 0 12px 16px;display:flex;flex-direction:column;gap:8px}
.dpi-mail pre{margin:0;white-space:pre-wrap;font:400 14px/21px var(--font-sans);color:var(--steel);background:var(--ground);border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px 16px}
.dpi-filters{display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:center;justify-content:space-between}
.dpi-vrow{display:grid;grid-template-columns:minmax(160px,1fr) minmax(220px,1.4fr);gap:8px var(--space-4);align-items:center;padding:12px 0;border-top:1px solid var(--line-subtle)}
.dpi-vrow form{display:flex;gap:8px}
.dpi-vrow .input{min-width:0}
.dpi-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;font-size:14px;margin:0}
.dpi-kv dt{color:var(--steel-muted)}.dpi-kv dd{margin:0;overflow-wrap:anywhere}
.dpi-req{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 12px;align-items:center;font-size:13px;padding:8px 0;border-top:1px solid var(--line-subtle)}
.dpi-req .mono{font-size:12px;overflow-wrap:anywhere}
@media (max-width:900px){
  .dpi .btn-sm,.modal .btn-sm{min-height:44px}
  .dpi .seg button,.modal .seg button{min-height:44px}
  .dpi-vrow{grid-template-columns:1fr}
  .dpi-tiles{grid-template-columns:1fr 1fr;gap:var(--space-3)}
  .dpi-tile{padding:var(--space-3)}
  .dpi-tile .metric-value{font-size:22px}
}
</style>`;

const TABS = [['keys', 'API keys'], ['webhooks', 'Webhooks'], ['email', 'Email outbox'], ['video', 'Exercise video']];
const MAIL = { sent: ['Sent', 'good'], queued: ['Sending', 'neutral'], failed: ['Failed', 'warn'], held: ['Held', 'muted'], logged: ['Not sent', 'muted'] };
const PROVIDER = (p) => (p === 'resend' ? 'Resend' : 'your relay');
const EMAIL_RE = /^\S+@\S+\.\S+$/;

const isOk = (s) => s >= 200 && s < 300;
const statusChip = (s) => (s == null ? html`<span class="dpi-status">sending</span>`
  : html`<span class="dpi-status ${isOk(s) ? 'ok' : 'bad'}">${s === 0 ? 'no answer' : s}</span>`);
const tag = (text, tone = 'muted') => html`<span class="badge badge-${tone}">${text}</span>`;
const mailBadge = (status) => { const [t, tone] = MAIL[status] || [status, 'muted']; return tag(t, tone); };
const utc = (s) => Date.parse(String(s).replace(' ', 'T') + (/[zZ]$/.test(s) ? '' : 'Z'));

async function copy(text, what = 'Copied.') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Select the text and copy it.', 'warn'); }
}
function showOnce(title, intro, value, extra) {
  return modal({
    title,
    body: html`<p style="margin:0">${intro}</p><div class="dpi-secret">${value}</div>${extra || ''}`,
    actions: [{ label: 'Copy', onClick: async () => { await copy(value); return false; } }, { label: "I've saved it", kind: 'primary', value: true }],
  });
}
// When a failed delivery will be tried again automatically, or null.
function nextRetry(d, retryAfter) {
  if (d.status == null || isOk(d.status) || d.event === 'test.ping') return null;
  const n = d.attempts || 1;
  if (n > retryAfter.length || Date.now() - utc(d.created_at) > 864e5) return null;
  return new Date(utc(d.last_attempt_at || d.created_at) + retryAfter[n - 1] * 60e3);
}
const inMinutes = (d) => { const m = Math.max(Math.round((d - Date.now()) / 60e3), 0); return m < 1 ? 'in under a minute' : m < 60 ? `in about ${m} min` : `in about ${Math.round(m / 60)} hr`; };

// ---------------------------------------------------------------------------------------------------------------
async function render(ctx) {
  let data = await api.get('/integrations');
  if (!ctx.isCurrent()) return;
  let tab = TABS.some(([k]) => k === ctx.query.tab) ? ctx.query.tab : 'keys';
  const origin = location.origin;

  mount(ctx.el, html`${STYLE}<div class="dpi">
    <div class="page-header"><div><h1 class="page-title">API & integrations</h1><p class="page-sub">Connect Diamond Protocol to your other systems.</p></div>
      <a class="btn btn-outline" href="/docs/api" target="_blank" rel="noopener">Open the API reference</a></div>
    <div class="dpi-tiles" id="dpi-sum" role="group" aria-label="Integration status"></div>
    <div class="tabs" role="tablist" aria-label="Integrations">${TABS.map(([k, label]) => html`<button type="button" role="tab" id="tab-${k}" aria-controls="dpi-pane" data-tab="${k}">${label}</button>`)}</div>
    <div id="dpi-pane" role="tabpanel" class="dpi"></div>
  </div>`);

  const el = ctx.el;
  const pane = el.querySelector('#dpi-pane');
  const sum = el.querySelector('#dpi-sum');

  const refresh = async () => {
    try { data = await api.get('/integrations'); } catch (err) { toastError(err); return; }
    if (!ctx.isCurrent()) return;
    drawSummary(); drawPane();
  };
  const run = async (fn, msg) => { try { const r = await fn(); if (msg) toast(msg); await refresh(); return r; } catch (err) { toastError(err); return null; } };

  // ---- status strip: one tile per tab, amber when something needs the owner ----
  function drawSummary() {
    const live = data.keys.filter((k) => !k.revoked_at);
    const lastUsed = live.map((k) => k.last_used).filter(Boolean).sort().pop();
    const keyErrors = live.reduce((n, k) => n + k.errors_30d, 0);
    const active = data.webhooks.filter((w) => w.active);
    const failing = active.filter((w) => w.health.failing);
    const paused = data.webhooks.length - active.length;
    const em = data.email;
    const v = data.video;
    // warn: 'value' ambers the whole tile (something is broken), 'note' only the line under it (worth a look).
    const tile = (k, label, value, note, warn) => html`<button type="button" class="metric dpi-tile" data-tab="${k}" aria-current="${tab === k}">
      <span class="metric-label">${label}</span><span class="metric-value ${warn === 'value' ? 'warn' : ''}">${value}</span><span class="metric-note ${warn ? 'warn' : ''}">${note}</span></button>`;
    mount(sum, html`
      ${tile('keys', 'API keys', live.length ? `${live.length} active` : 'None', live.length ? (keyErrors ? `${plural(keyErrors, 'error')} in 30 days` : lastUsed ? `Last used ${relTime(lastUsed)}` : 'Not used yet') : 'Create one to connect a system', keyErrors > 0 && 'note')}
      ${tile('webhooks', 'Webhooks', failing.length ? `${failing.length} failing` : data.webhooks.length ? `${active.length} active` : 'None', failing.length ? 'Deliveries are not getting through' : paused ? `${paused} paused` : data.webhooks.length ? 'All delivering' : 'Get events as they happen', failing.length > 0 && 'value')}
      ${tile('email', 'Email', em.mode === 'test' ? 'Not connected' : em.mode === 'restricted' ? 'Restricted' : 'Sending', em.failed_7d ? `${plural(em.failed_7d, 'failed email')} this week` : em.mode === 'test' ? 'Emails stay in the outbox' : `Through ${PROVIDER(em.provider)}`, em.failed_7d > 0 ? 'value' : em.mode === 'test' && 'note')}
      ${tile('video', 'Exercise video', `${v.with_video} of ${v.total}`, v.in_use_missing ? `${plural(v.in_use_missing, 'exercise')} in programs need one` : 'Exercises with a demo video', v.in_use_missing > 0 && 'note')}`);
  }

  // ---- tabs (arrow keys move between them; the tab is kept in the address) ----
  function setTab(k, focus = false) {
    tab = k;
    const url = new URL(location.href);
    url.searchParams.set('tab', k);
    history.replaceState({}, '', url.pathname + url.search);
    drawSummary(); drawPane();
    if (focus) el.querySelector(`#tab-${k}`).focus();
  }
  el.addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) setTab(t.dataset.tab); });
  el.querySelector('[role=tablist]').addEventListener('keydown', (e) => {
    const i = TABS.findIndex(([k]) => k === tab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setTab(TABS[(to + TABS.length) % TABS.length][0], true);
  });

  function drawPane() {
    el.querySelectorAll('[role=tab]').forEach((b) => { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    pane.setAttribute('aria-labelledby', `tab-${tab}`);
    ({ keys: drawKeys, webhooks: drawHooks, email: drawEmail, video: drawVideo })[tab]();
  }

  // ================================================================ API keys
  function drawKeys() {
    const live = data.keys.filter((k) => !k.revoked_at);
    const revoked = data.keys.filter((k) => k.revoked_at);
    const keyRow = (k) => html`<div class="dpi-key">
      <div class="grow"><div class="strong">${k.label} ${k.revoked_at ? badge('off', 'Revoked') : k.scope === 'read' ? tag('Read only') : tag('Read and send results', 'neutral')}</div>
        <div class="small muted"><span class="mono" style="font-size:12px">dp_live_…${k.last4}</span> · created ${relTime(k.created_at)} · ${k.revoked_at ? `revoked ${relTime(k.revoked_at)}` : k.last_used ? `last used ${relTime(k.last_used)}` : 'never used'}</div>
        ${k.requests_30d ? html`<div class="small ${k.errors_30d ? 'error' : 'muted'}" style="font-weight:400">${plural(k.requests_30d, 'request')} in 30 days${k.errors_30d ? ` · ${plural(k.errors_30d, 'error')}` : ''}</div>` : ''}</div>
      <div class="btn-row">
        <button type="button" class="btn btn-sm" data-act="key-log" data-id="${k.id}">Requests</button>
        ${k.revoked_at ? '' : html`<button type="button" class="btn btn-ghost btn-sm" data-act="key-edit" data-id="${k.id}">Edit</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="key-revoke" data-id="${k.id}">Revoke</button>`}
      </div></div>`;
    const K = 'dp_live_…';
    mount(pane, html`<div class="grid-2" style="align-items:start">
      <section class="panel" aria-labelledby="keys-t">
        <div><h2 class="panel-title" id="keys-t">API keys</h2><p class="panel-sub">Let your other systems read athletes, results, programs and sessions, and send in test results.</p></div>
        <form class="stack-sm" id="newkey" novalidate>
          <div class="field"><label class="label" for="kl">Key label</label>
            <input class="input" id="kl" name="label" placeholder="e.g. Website booking form" maxlength="60" autocomplete="off"></div>
          <fieldset style="border:0;padding:0"><legend class="label" style="padding:0;margin-bottom:6px">What it can do</legend>
            <label class="check"><input type="radio" name="scope" value="read" checked><span>Read only <span class="hint" style="display:block">Athletes, results, tests, programs and sessions. Best for spreadsheets and dashboards.</span></span></label>
            <label class="check"><input type="radio" name="scope" value="full"><span>Read and send results <span class="hint" style="display:block">Also lets devices and other systems send test results in.</span></span></label>
          </fieldset>
          <div><button class="btn btn-primary">Create key</button></div>
        </form>
        ${live.length ? html`<div>${live.map(keyRow)}</div>` : html`<p class="muted" style="margin:0">No active keys. Create one to connect your first system.</p>`}
        ${revoked.length ? html`<details><summary class="small muted" style="cursor:pointer;min-height:44px;display:flex;align-items:center">Revoked keys (${revoked.length})</summary>${revoked.map(keyRow)}</details>` : ''}
      </section>
      <section class="panel" aria-labelledby="ref-t">
        <div><h2 class="panel-title" id="ref-t">Quick start</h2><p class="panel-sub">Send your key as a header: <span class="mono">Authorization: Bearer ${K}</span></p></div>
        ${[
          ['List athletes', `curl ${origin}/api/v1/athletes \\\n  -H "Authorization: Bearer ${K}"`],
          ["An athlete's results", `curl ${origin}/api/v1/athletes/AVALOP2026/results \\\n  -H "Authorization: Bearer ${K}"`],
          ['Send a result', `curl -X POST ${origin}/api/v1/results \\\n  -H "Authorization: Bearer ${K}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"athlete_code":"AVALOP2026","source":"hawkin","test":"CMJ jump height","value":41.2,"unit":"cm"}'`],
        ].map(([t, code], i) => html`<div class="stack-sm"><div class="spread"><span class="label">${t}</span><button type="button" class="btn btn-ghost btn-sm" data-act="copy-code" data-i="${i}" aria-label="Copy: ${t}">Copy</button></div><pre class="dpi-code" id="code-${i}">${code}</pre></div>`)}
        <p class="small muted" style="margin:0">Sending results needs a key that can read and send results. <a href="/docs/api" target="_blank" rel="noopener">Every endpoint is in the API reference</a>.</p>
      </section></div>`);

    const nk = pane.querySelector('#newkey');
    nk.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = nk.querySelector('#kl');
      if (!input.value.trim()) { input.setAttribute('aria-invalid', 'true'); input.focus(); toast('Give the key a label, like the system that will use it.', 'warn'); return; }
      const b = nk.querySelector('button'); b.disabled = true;
      try {
        const r = await api.post('/api-keys', formData(nk));
        await showOnce('Your new API key', html`Copy <span class="strong">${r.label}</span> now and store it in the other system. For your security it won't be shown again.`, r.key);
        await refresh();
      } catch (err) { toastError(err); b.disabled = false; }
    });
  }

  async function keyLog(k) {
    const r = await api.get(`/api-keys/${k.id}/requests?limit=100`);
    await modal({
      title: 'Requests', wide: true,
      body: html`<p style="margin:0"><span class="strong">${k.label}</span> <span class="mono small">dp_live_…${k.last4}</span> · ${plural(r.requests_30d, 'request')} in 30 days${r.errors_30d ? `, ${plural(r.errors_30d, 'error')}` : ''}. Requests are kept for 30 days.</p>
        ${r.items.length ? html`<div>${r.items.map((q) => html`<div class="dpi-req">
          ${statusChip(q.status)}<div><span class="mono">${q.method} ${q.path}</span>${q.error ? html`<div class="error" style="font-size:13px;font-weight:400">${q.error}</div>` : ''}</div>
          <span class="muted" title="${fmtDateTime(q.created_at)}${q.ip ? ` from ${q.ip}` : ''}">${relTime(q.created_at)}</span></div>`)}</div>`
          : html`<p class="muted" style="margin:0">No requests in the last 30 days. Once the other system uses this key, each call shows here with its answer.</p>`}`,
    });
  }

  async function keyEdit(k) {
    const ok = await modal({
      title: 'Edit API key',
      body: html`<form class="stack-sm" novalidate><div class="field"><label class="label" for="ek-l">Key label</label><input class="input" id="ek-l" name="label" value="${k.label}" maxlength="60"></div>
        <fieldset style="border:0;padding:0"><legend class="label" style="padding:0;margin-bottom:6px">What it can do</legend>
          ${['read', 'full'].map((v) => html`<label class="check"><input type="radio" name="scope" value="${v}" ${v === k.scope ? 'checked' : ''}>${data.scopes[v]}</label>`)}</fieldset>
        <p class="hint" style="margin:0">Changes apply from the next request. The key itself stays the same.</p></form>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save key', kind: 'primary', onClick: async (body) => { await api.put(`/api-keys/${k.id}`, formData(body.querySelector('form'))); toast('Key saved.'); return true; } }],
    });
    if (ok) refresh();
  }

  // ================================================================ webhooks
  function drawHooks() {
    const retry = data.retry_after_min;
    const hookCard = (w) => {
      const hl = w.health;
      const failing = w.active && hl.failing;
      return html`<article class="dpi-hook ${failing ? 'failing' : ''}" aria-label="${w.label || w.url}">
        <div class="spread" style="align-items:flex-start;gap:12px;flex-wrap:nowrap"><div style="min-width:0">${w.label ? html`<div class="strong">${w.label}</div>` : ''}<div class="dpi-url">${w.url}</div></div>
          ${failing ? badge('failed', 'Failing') : w.active ? badge('active') : badge('paused')}</div>
        ${failing ? html`<div class="banner" style="font-size:14px">The last 3 deliveries failed. Check the receiving system is up, then resend.</div>` : ''}
        <div class="small muted">Sends ${w.events.length === data.events.length ? 'every event' : w.events.join(', ')}</div>
        <div class="small muted">${hl.sent_7d ? `Last 7 days: ${hl.sent_7d} sent, ${hl.failed_7d} failed` : 'Nothing sent in the last 7 days'} · signing secret <span class="mono" style="font-size:12px">${w.secret_hint}</span></div>
        ${w.deliveries.length ? html`<div class="dpi-dels" aria-label="Recent deliveries">${w.deliveries.map((d) => {
          const nr = nextRetry(d, retry);
          return html`<button type="button" class="dpi-drow" data-act="delivery" data-hook="${w.id}" data-id="${d.id}" aria-label="${d.event}, ${d.status == null ? 'sending' : isOk(d.status) ? 'delivered' : 'failed'}, ${relTime(d.created_at)}. Open details.">
            <span class="mono">${d.event}${d.attempts > 1 ? html` <span class="muted">· ${plural(d.attempts, 'try', 'tries')}</span>` : ''}${nr && w.active ? html` <span class="muted">· retry ${inMinutes(nr)}</span>` : ''}</span>
            <span class="muted" title="${fmtDateTime(d.created_at)}">${relTime(d.created_at)}</span>${statusChip(d.status)}</button>`;
        })}</div>` : html`<div class="small muted">No deliveries yet. Send a test event to check the URL.</div>`}
        <div class="btn-row">
          <label class="sr-only" for="tev-${w.id}">Test event for ${w.label || w.url}</label>
          <select class="input" id="tev-${w.id}" style="width:auto;min-width:0;max-width:100%"><option value="test.ping">test.ping</option>${w.events.map((e) => html`<option value="${e}">${e} (sample)</option>`)}</select>
          <button type="button" class="btn btn-sm" data-act="hook-test" data-id="${w.id}">Send test event</button>
          ${hl.failed_7d && w.active ? html`<button type="button" class="btn btn-sm" data-act="hook-resend-failed" data-id="${w.id}">Resend failed (${hl.failed_7d})</button>` : ''}
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-ghost btn-sm" data-act="hook-all" data-id="${w.id}">All ${plural(w.delivered, 'delivery', 'deliveries')}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="hook-edit" data-id="${w.id}">Edit</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="hook-toggle" data-id="${w.id}">${w.active ? 'Pause' : 'Resume'}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="hook-rotate" data-id="${w.id}">New signing secret</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="hook-delete" data-id="${w.id}">Delete</button>
        </div></article>`;
    };
    mount(pane, html`<div class="grid-2" style="align-items:start">
      <section class="panel" aria-labelledby="hooks-t">
        <div><h2 class="panel-title" id="hooks-t">Webhooks</h2><p class="panel-sub">We send a signed event to your URL the moment something happens here. A failed delivery is tried again after ${retry.map((m) => (m < 60 ? `${m} min` : `${m / 60} hr`)).join(', ')}.</p></div>
        ${data.webhooks.length ? data.webhooks.map(hookCard) : html`<div class="empty">No webhooks yet. Add one to tell another system, like Zapier or your mailing list, about new clients, bookings, payments and PRs as they happen.</div>`}
      </section>
      <section class="panel" aria-labelledby="newhook-t">
        <div><h2 class="panel-title" id="newhook-t">Add a webhook</h2><p class="panel-sub">You get a signing secret to check each event came from us.</p></div>
        ${hookForm({}, 'newhook')}
        <div><button class="btn btn-primary" form="newhook">Add webhook</button></div>
      </section></div>`);
    const f = pane.querySelector('#newhook');
    bindEventPicker(f);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(f);
      if (!d.url.trim()) { f.url.setAttribute('aria-invalid', 'true'); f.url.focus(); toast('Enter the URL to send events to, starting with https://', 'warn'); return; }
      if (!d.events.length) { toast('Choose at least one event to send.', 'warn'); return; }
      const b = pane.querySelector('[form=newhook]'); b.disabled = true;
      try {
        const r = await api.post('/webhooks', d);
        await showOnce('Webhook added', "Every event is signed with this secret. Save it now; it won't be shown again.", r.secret,
          html`<p class="small muted" style="margin:0">Each request carries <span class="mono">x-dp-signature</span>: the hex HMAC-SHA256 of the raw request body using this secret. Compare it before trusting the event. <a href="/docs/api#verify" target="_blank" rel="noopener">How to verify</a>.</p>`);
        await refresh();
        if (await confirmDialog('Send a test event', `Send test.ping to ${r.url} now to check it answers?`, 'Send test event')) await testHook(r.id, 'test.ping');
      } catch (err) { toastError(err); b.disabled = false; }
    });
  }

  function hookForm(w, id) {
    const chosen = new Set(w.events || data.events);
    return html`<form class="stack-sm" id="${id}" novalidate>
      <div class="field"><label class="label" for="${id}-l">Name <span class="muted" style="font-weight:400">(optional)</span></label>
        <input class="input" id="${id}-l" name="label" value="${w.label || ''}" placeholder="e.g. Mailing list sync" maxlength="60" autocomplete="off"></div>
      <div class="field"><label class="label" for="${id}-u">Destination URL</label>
        <input class="input" id="${id}-u" name="url" value="${w.url || ''}" placeholder="https://your-system.example.com/hooks" inputmode="url" autocomplete="off" spellcheck="false"></div>
      <fieldset style="border:0;padding:0;margin-top:var(--space-2)"><legend class="label" style="padding:0">Events to send</legend>
        <div class="btn-row" style="margin:4px 0 6px"><button type="button" class="btn btn-ghost btn-sm" data-pick="all">Select all</button><button type="button" class="btn btn-ghost btn-sm" data-pick="none">Clear</button>
          <span class="hint" data-count aria-live="polite"></span></div>
        <div class="dpi-events">${data.events.map((e) => html`<label class="check"><input type="checkbox" name="events" value="${e}" data-multi ${chosen.has(e) ? 'checked' : ''}><span><span class="ev">${e}</span><span class="about">${data.event_info[e]}</span></span></label>`)}</div>
      </fieldset></form>`;
  }
  function bindEventPicker(form) {
    const boxes = [...form.querySelectorAll('input[name=events]')];
    const count = form.querySelector('[data-count]');
    const upd = () => { const n = boxes.filter((b) => b.checked).length; count.textContent = n === boxes.length ? 'Every event' : n ? `${n} of ${boxes.length} events` : 'Choose at least one'; };
    form.addEventListener('change', upd);
    form.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { boxes.forEach((x) => { x.checked = b.dataset.pick === 'all'; }); upd(); }));
    upd();
  }

  async function testHook(id, event) {
    try {
      const r = await api.post(`/webhooks/${id}/test`, { event });
      toast(r.ok ? `Test event delivered (${r.status}).` : r.status ? `Test event not accepted. The URL answered ${r.status}.` : "Test event not delivered. We couldn't reach that URL.", r.ok ? 'good' : 'warn');
    } catch (err) { toastError(err); }
    await refresh();
  }

  async function hookEdit(w) {
    const ok = await modal({
      title: 'Edit webhook', wide: true,
      body: html`${hookForm(w, 'edithook')}<p class="hint" style="margin:0">The signing secret stays the same.</p>`,
      onMount: (body) => bindEventPicker(body.querySelector('form')),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save webhook', kind: 'primary', onClick: async (body) => { await api.put(`/webhooks/${w.id}`, formData(body.querySelector('form'))); toast('Webhook saved.'); return true; } }],
    });
    if (ok) refresh();
  }

  async function deliveryModal(hookId, did) {
    const d = await api.get(`/webhooks/${hookId}/deliveries/${did}`);
    const w = data.webhooks.find((x) => x.id === hookId);
    const nr = nextRetry(d, data.retry_after_min);
    let pretty = d.payload || '';
    try { pretty = JSON.stringify(JSON.parse(d.payload), null, 2); } catch { /* keep as sent */ }
    const r = await modal({
      title: 'Delivery', wide: true,
      body: html`<dl class="dpi-kv">
          <dt>Event</dt><dd class="mono">${d.event}</dd>
          <dt>Answer</dt><dd>${statusChip(d.status)} ${d.duration_ms != null ? html`<span class="muted small">in ${d.duration_ms} ms</span>` : ''}</dd>
          ${d.error ? html`<dt>Problem</dt><dd class="error" style="font-weight:400">${d.error}</dd>` : ''}
          <dt>Sent</dt><dd>${fmtDateTime(d.created_at)}${d.last_attempt_at && d.last_attempt_at !== d.created_at ? `, last tried ${fmtDateTime(d.last_attempt_at)}` : ''}</dd>
          <dt>Tries</dt><dd>${d.attempts || 1} of ${d.max_attempts}${nr && w?.active ? ` · next ${inMinutes(nr)}` : ''}${nr && w && !w.active ? ' · retries wait while the webhook is paused' : ''}</dd>
          <dt>To</dt><dd class="mono" style="font-size:13px">${d.url}</dd>
          <dt>Delivery ID</dt><dd class="mono" style="font-size:13px">${d.id} <span class="muted">(x-dp-delivery header)</span></dd></dl>
        ${d.response ? html`<div class="stack-sm"><span class="label">Their answer</span><pre class="dpi-code wrap">${d.response}</pre></div>` : ''}
        <div class="stack-sm"><div class="spread"><span class="label">What we sent</span><button class="btn btn-ghost btn-sm" type="button" data-copy-payload>Copy</button></div><pre class="dpi-code wrap">${pretty}</pre></div>`,
      onMount: (body) => body.querySelector('[data-copy-payload]').addEventListener('click', () => copy(pretty)),
      actions: [{ label: 'Close', value: null }, { label: 'Resend', value: 'resend' }],
    });
    if (r === 'resend') {
      try {
        const x = await api.post(`/webhooks/${hookId}/deliveries/${did}/resend`);
        toast(x.ok ? `Delivered (${x.status}).` : x.status ? `Not accepted. The URL answered ${x.status}.` : "Not delivered. We couldn't reach that URL.", x.ok ? 'good' : 'warn');
      } catch (err) { toastError(err); }
      await refresh();
    }
  }

  async function allDeliveries(w) {
    let filter = '', event = '', items = [], total = 0;
    await modal({
      title: 'Deliveries', wide: true,
      body: html`<p style="margin:0" class="muted">${w.label || w.url}</p>
        <div class="dpi-filters"><div class="seg" role="group" aria-label="Show">${[['', 'All'], ['failed', 'Failed'], ['ok', 'Delivered']].map(([v, l]) => html`<button type="button" data-f="${v}" aria-pressed="${v === ''}">${l}</button>`)}</div>
          <div><label class="sr-only" for="dl-ev">Event</label><select class="input" id="dl-ev" style="width:auto"><option value="">Every event</option>${[...w.events, 'test.ping'].map((e) => html`<option value="${e}">${e}</option>`)}</select></div></div>
        <div class="dpi-dels" id="dl-list" aria-live="polite"><p class="muted">Loading…</p></div>`,
      onMount: (body, close) => {
        const list = body.querySelector('#dl-list');
        const load = async (reset) => {
          try {
            const r = await api.get(`/webhooks/${w.id}/deliveries?limit=50&offset=${reset ? 0 : items.length}${filter ? '&status=' + filter : ''}${event ? '&event=' + encodeURIComponent(event) : ''}`);
            items = reset ? r.items : items.concat(r.items); total = r.total;
          } catch (err) { toastError(err); return; }
          mount(list, items.length ? html`${items.map((d) => html`<button type="button" class="dpi-drow" data-d="${d.id}"><span class="mono">${d.event}${d.attempts > 1 ? html` <span class="muted">· ${plural(d.attempts, 'try', 'tries')}</span>` : ''}</span><span class="muted" title="${fmtDateTime(d.created_at)}">${relTime(d.created_at)}</span>${statusChip(d.status)}</button>`)}
            ${items.length < total ? html`<div style="padding-top:8px"><button type="button" class="btn btn-sm" data-more>Show more (${total - items.length} older)</button></div>` : ''}`
            : html`<p class="muted" style="margin:0">${filter || event ? 'No deliveries match.' : 'No deliveries yet.'}</p>`);
        };
        body.addEventListener('click', async (e) => {
          const f = e.target.closest('[data-f]');
          if (f) { filter = f.dataset.f; body.querySelectorAll('[data-f]').forEach((b) => b.setAttribute('aria-pressed', String(b === f))); load(true); return; }
          if (e.target.closest('[data-more]')) { load(false); return; }
          const d = e.target.closest('[data-d]');
          if (d) { close(null); deliveryModal(w.id, Number(d.dataset.d)).catch(toastError); }
        });
        body.querySelector('#dl-ev').addEventListener('change', (e) => { event = e.target.value; load(true); });
        load(true);
      },
    });
  }

  // ================================================================ email outbox
  let mailFilter = '', mailQ = '';
  function drawEmail() {
    const em = data.email;
    const c = em.counts;
    const everything = Object.values(c).reduce((a, b) => a + b, 0);
    mount(pane, html`<section class="panel" aria-labelledby="out-t">
      <div><h2 class="panel-title" id="out-t">Email outbox</h2>
        <p class="panel-sub">Every email the platform sends: sign-in codes, welcome emails, booking changes, invoices and receipts.</p></div>
      <div id="mail-mode"></div>
      <form class="row" id="mail-test" style="align-items:flex-end" novalidate>
        <div class="field" style="flex:1;min-width:220px"><label class="label" for="mt-to">Send a test email to</label><input class="input" id="mt-to" name="to" type="email" value="${ctx.me.email}" autocomplete="email"></div>
        <button class="btn ${em.mode === 'test' ? '' : 'btn-primary'}">Send test email</button>
      </form>
      ${em.mode === 'test' ? html`<p class="hint" style="margin:-8px 0 0">A test email can only go out once an email service is connected.</p>` : ''}
      <div class="dpi-filters">
        <div class="seg" role="group" aria-label="Show">${[['', 'All', everything], ['failed', 'Failed', c.failed], ['held', 'Held', c.held], ['logged', 'Not sent', c.logged], ['sent', 'Sent', c.sent]]
          .filter(([v, , n]) => v === '' || n > 0 || v === mailFilter).map(([v, l, n]) => html`<button type="button" data-mf="${v}" aria-pressed="${v === mailFilter}">${l} (${n})</button>`)}</div>
        <div style="flex:1;min-width:200px;max-width:320px"><label class="sr-only" for="oq">Search the outbox</label><input class="input" type="search" id="oq" placeholder="Search address, subject or text" value="${mailQ}" autocomplete="off"></div>
      </div>
      <div id="outbox" aria-live="polite"><p class="muted" style="margin:0">Loading…</p></div>
    </section>`);

    const box = pane.querySelector('#outbox');
    let items = [], total = 0, seq = 0;
    const canSend = em.mode !== 'test';
    const load = async (reset) => {
      const my = ++seq;
      const r = await api.get(`/outbox?limit=25&offset=${reset ? 0 : items.length}${mailQ ? '&q=' + encodeURIComponent(mailQ) : ''}${mailFilter ? '&status=' + mailFilter : ''}`);
      if (my !== seq || !box.isConnected) return;
      items = reset ? r.items : items.concat(r.items); total = r.total;
      const modeText = {
        test: html`<div class="banner">No email service is connected, so messages stay here and are not sent. Parents see their sign-in code on screen. Add RESEND_API_KEY on the server to start sending. Until then, copy a message to send it yourself.</div>`,
        restricted: html`<div class="banner info">Sending through ${PROVIDER(r.provider)}, but only to ${r.only_to}. Everything else is held here.</div>`,
        live: html`<div class="banner info">Sending through ${PROVIDER(r.provider)}${r.from ? html` as ${r.from}` : ''}.</div>`,
      };
      mount(pane.querySelector('#mail-mode'), modeText[r.mode]);
      mount(box, items.length ? html`<div>${items.map((m) => html`<details class="dpi-mail">
          <summary><span class="muted" title="${fmtDateTime(m.created_at)}">${relTime(m.created_at)}</span> · ${m.to_email} · <span class="strong">${m.subject}</span> ${mailBadge(m.status)}</summary>
          <div class="body">
            ${m.error ? html`<p class="error" style="margin:0">${m.error}${m.attempts > 1 ? ` (tried ${m.attempts} times)` : ''}</p>` : ''}
            <pre>${m.body}</pre>
            <div class="btn-row">
              <button type="button" class="btn btn-sm" data-mact="copy" data-id="${m.id}">Copy text</button>
              ${canSend ? html`<button type="button" class="btn btn-sm" data-mact="resend" data-id="${m.id}">Send again</button>
              <button type="button" class="btn btn-ghost btn-sm" data-mact="resend-to" data-id="${m.id}">Send to another address</button>` : ''}
            </div></div></details>`)}</div>
        ${items.length < total ? html`<div><button type="button" class="btn btn-sm" id="more">Show more (${total - items.length} older)</button></div>` : ''}`
        : html`<p class="muted" style="margin:0">${mailQ || mailFilter ? 'No emails match. Clear the search or filter to see them all.' : 'No emails yet.'}</p>`);
      box.querySelector('#more')?.addEventListener('click', () => load(false).catch(toastError));
    };
    const resend = async (m, to) => {
      try { await api.post(`/outbox/${m.id}/resend`, to ? { to } : {}); toast(`Sent again to ${to || m.to_email}.`); }
      catch (err) { toastError(err); }
      await refresh();
    };
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-mact]');
      if (!b) return;
      const m = items.find((x) => x.id === Number(b.dataset.id));
      if (b.dataset.mact === 'copy') { copy(`To: ${m.to_email}\nSubject: ${m.subject}\n\n${m.body}`, 'Email copied.'); return; }
      if (b.dataset.mact === 'resend') {
        if (await confirmDialog('Send again', `Send "${m.subject}" to ${m.to_email} again?`, 'Send email')) resend(m);
        return;
      }
      const to = await modal({
        title: 'Send to another address',
        body: html`<p style="margin:0">Sends "${m.subject}" as a new email. The original stays in the outbox.</p>
          <div class="field"><label class="label" for="rs-to">Email address</label><input class="input" id="rs-to" type="email" autocomplete="email" value="${m.to_email}"></div>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Send email', kind: 'primary', onClick: (body) => {
          const v = body.querySelector('#rs-to').value.trim();
          if (!EMAIL_RE.test(v)) { toast('Enter an email address.', 'warn'); return false; }
          return v;
        } }],
      });
      if (to) resend(m, to);
    });
    pane.querySelector('#mail-test').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const to = f.to.value.trim();
      if (!EMAIL_RE.test(to)) { f.to.setAttribute('aria-invalid', 'true'); f.to.focus(); toast('Enter an email address.', 'warn'); return; }
      f.to.removeAttribute('aria-invalid');
      const b = f.querySelector('button'); b.disabled = true; b.textContent = 'Sending…';
      try { await api.post('/outbox/test', { to }); toast('Test email sent. Check the inbox.'); }
      catch (err) { toastError(err); }
      await refresh();
    });
    pane.querySelectorAll('[data-mf]').forEach((b) => b.addEventListener('click', () => { mailFilter = b.dataset.mf; drawEmail(); }));
    pane.querySelector('#oq').addEventListener('input', debounce((e) => { mailQ = e.target.value.trim(); load(true).catch(toastError); }, 250));
    load(true).catch((err) => { mount(box, html`<p class="error" style="margin:0">${err.message}</p>`); });
  }

  // ================================================================ exercise video
  let onlyInUse = true;
  function drawVideo() {
    const v = data.video;
    const list = v.attention.filter((a) => !onlyInUse || a.uses > 0);
    const pct = v.total ? Math.round((v.with_video / v.total) * 100) : 0;
    mount(pane, html`<section class="panel" aria-labelledby="vid-t">
      <div><h2 class="panel-title" id="vid-t">Exercise demo video</h2>
        <p class="panel-sub">Demo videos play inside the athlete workout app. Use a YouTube or Vimeo link, or a direct link to an .mp4, .webm or .mov file.</p></div>
      <div class="metrics">
        <div class="metric"><span class="metric-label">Exercises with a video</span><span class="metric-value ${pct === 100 ? 'good' : ''}">${pct}%</span><span class="metric-note">${v.with_video} of ${v.total}</span></div>
        <div class="metric"><span class="metric-label">In programs, no video</span><span class="metric-value ${v.in_use_missing ? 'warn' : 'good'}">${v.in_use_missing}</span><span class="metric-note">Athletes see the cues only</span></div>
        <div class="metric"><span class="metric-label">Where they're hosted</span><span class="metric-note" style="font-size:14px;line-height:22px;color:var(--steel)">YouTube ${v.by_kind.youtube} · Vimeo ${v.by_kind.vimeo} · Video file ${v.by_kind.file}</span></div>
      </div>
      <div class="dpi-filters"><label class="check" style="align-items:center;min-height:44px"><input type="checkbox" id="vid-inuse" ${onlyInUse ? 'checked' : ''}>Only exercises in a program</label>
        <a class="btn btn-ghost btn-sm" href="/app/programs">Open the exercise library</a></div>
      ${list.length ? html`<div aria-label="Exercises that need a video">${list.map((a) => html`<div class="dpi-vrow">
          <div><div class="strong">${a.name} ${a.problem === 'unplayable' ? badge('warn', "Can't play") : tag('No video')}</div>
            <div class="small muted">${[a.category, a.uses ? `In ${plural(a.uses, 'workout')}` : 'Not in a program'].filter(Boolean).join(' · ')}</div>
            ${a.problem === 'unplayable' ? html`<div class="small muted mono" style="overflow-wrap:anywhere;font-size:12px">${a.video_url}</div>` : ''}</div>
          <form data-vid="${a.id}" novalidate><label class="sr-only" for="vu-${a.id}">Video link for ${a.name}</label>
            <input class="input" id="vu-${a.id}" name="video_url" type="url" inputmode="url" placeholder="Paste a YouTube or Vimeo link" autocomplete="off" spellcheck="false">
            <button class="btn">Save</button></form></div>`)}</div>`
        : html`<div class="empty">${v.attention.length ? 'Every exercise in a program has a demo video. Untick the box to see the rest of the library.' : 'Every exercise in the library has a demo video.'}</div>`}
    </section>`);
    pane.querySelector('#vid-inuse').addEventListener('change', (e) => { onlyInUse = e.target.checked; drawVideo(); });
    pane.querySelectorAll('form[data-vid]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = f.video_url;
      if (!input.value.trim()) { input.setAttribute('aria-invalid', 'true'); input.focus(); toast('Paste a video link first.', 'warn'); return; }
      const b = f.querySelector('button'); b.disabled = true;
      try {
        const r = await api.put(`/exercises/${f.dataset.vid}`, { video_url: input.value.trim() });
        toast(`Video saved for ${r.name}.`);
        await refresh();
      } catch (err) { input.setAttribute('aria-invalid', 'true'); toastError(err); b.disabled = false; }
    }));
  }

  // ---- actions on keys and webhooks ----
  pane.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    const k = data.keys.find((x) => x.id === id);
    const w = data.webhooks.find((x) => x.id === id);
    switch (b.dataset.act) {
      case 'copy-code': copy(pane.querySelector(`#code-${b.dataset.i}`).textContent); return;
      case 'key-log': keyLog(k).catch(toastError); return;
      case 'key-edit': keyEdit(k); return;
      case 'key-revoke':
        if (await confirmDialog('Revoke API key', `Revoke ${k.label}? Anything using it stops working straight away. This can't be undone.`, 'Revoke key', 'warn')) run(() => api.del(`/api-keys/${id}`), 'Key revoked.');
        return;
      case 'delivery': deliveryModal(Number(b.dataset.hook), id).catch(toastError); return;
      case 'hook-test':
        b.disabled = true; b.textContent = 'Sending…';
        testHook(id, pane.querySelector(`#tev-${id}`).value);
        return;
      case 'hook-resend-failed':
        if (!(await confirmDialog('Resend failed deliveries', `Send the ${plural(w.health.failed_7d, 'failed delivery', 'failed deliveries')} from the last 7 days to ${w.label || w.url} again?`, 'Resend'))) return;
        b.disabled = true; b.textContent = 'Sending…';
        try { const r = await api.post(`/webhooks/${id}/resend-failed`); toast(r.failed ? `${r.ok} of ${r.tried} accepted. ${r.failed} still failing.` : `All ${r.tried} accepted.`, r.failed ? 'warn' : 'good'); }
        catch (err) { toastError(err); }
        refresh();
        return;
      case 'hook-all': allDeliveries(w); return;
      case 'hook-edit': hookEdit(w); return;
      case 'hook-toggle':
        run(() => api.put(`/webhooks/${id}`, { active: !w.active }), w.active ? 'Webhook paused. Events are not sent while paused.' : 'Webhook resumed.');
        return;
      case 'hook-rotate':
        if (!(await confirmDialog('New signing secret', `Make a new signing secret for ${w.label || w.url}? The old one stops working straight away, so update the receiving system at the same time.`, 'Make new secret', 'warn'))) return;
        try { const r = await api.post(`/webhooks/${id}/rotate`); await showOnce('New signing secret', "Put this in the receiving system now. It won't be shown again.", r.secret); }
        catch (err) { toastError(err); }
        refresh();
        return;
      case 'hook-delete':
        if (await confirmDialog('Delete webhook', `Stop sending events to ${w.label || w.url} and delete its delivery history? To stop for a while, pause it instead.`, 'Delete webhook', 'warn')) run(() => api.del(`/webhooks/${id}`), 'Webhook deleted.');
        return;
      default:
    }
  });

  drawSummary(); drawPane();
}

export const routes = [{ path: '/integrations', nav: 'api', title: 'API & integrations', roles: ['owner'], render }];
