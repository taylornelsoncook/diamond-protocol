// API & integrations: API keys, webhooks with deliveries, the API reference link and the email outbox.
import { html, mount, api, toast, toastError, modal, confirmDialog, formData, relTime, fmtDateTime, badge, plural, debounce } from '/js/ui.js';

const STYLE = html`<style>
.dpi-code{margin:0;background:var(--black);border:1px solid var(--line);border-radius:var(--radius-sm);padding:var(--space-3) var(--space-4);font:400 13px/20px var(--font-mono);color:var(--steel);overflow-x:auto;white-space:pre}
.dpi-events{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:2px var(--space-3)}
.dpi-events .check{font:400 13px/20px var(--font-mono);align-items:center}
.dpi-hook{border:1px solid var(--line);border-radius:var(--radius-sm);padding:var(--space-3) var(--space-4);display:flex;flex-direction:column;gap:var(--space-2)}
.dpi-url{font:400 14px/20px var(--font-mono);overflow-wrap:anywhere}
.dpi-del{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:4px 12px;font-size:13px;line-height:18px;align-items:center}
.dpi-del .mono{font-size:12px}
.dpi-status{font:600 12px/1 var(--font-mono);padding:3px 8px;border-radius:var(--radius-pill);background:var(--surface-raised);color:var(--steel-muted)}
.dpi-status.ok{background:var(--green-deep);color:var(--green-soft)}.dpi-status.bad{background:var(--amber-deep);color:var(--amber)}
.dpi-key{display:flex;align-items:center;gap:var(--space-3);padding:10px 0;border-top:1px solid var(--line-subtle)}
.dpi-key .grow{flex:1;min-width:0}
.dpi-secret{font:400 14px/20px var(--font-mono);background:var(--black);border:1px solid var(--green-mid);border-radius:var(--radius-sm);padding:12px;overflow-wrap:anywhere;user-select:all}
.dpi-mail{border-top:1px solid var(--line-subtle)}
.dpi-mail summary{cursor:pointer;padding:12px 0;font-size:14px;line-height:20px;list-style-position:outside;margin-left:16px}
.dpi-mail summary::marker{color:var(--steel-muted)}
.dpi-mail pre{margin:0 0 12px 16px;white-space:pre-wrap;font:400 14px/21px var(--font-sans);color:var(--steel);background:var(--ground);border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px 16px}
</style>`;

const statusChip = (s) => (s == null ? html`<span class="dpi-status">sending</span>`
  : html`<span class="dpi-status ${s >= 200 && s < 300 ? 'ok' : 'bad'}">${s === 0 ? 'no reply' : s}</span>`);

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Select the text and copy it.', 'warn'); }
}

function showOnce(title, intro, value, extra) {
  return modal({
    title,
    body: html`<p style="margin:0">${intro}</p><div class="dpi-secret" id="once">${value}</div>${extra || ''}`,
    actions: [{ label: 'Copy', onClick: async () => { await copy(value); return false; } }, { label: "I've saved it", kind: 'primary', value: true }],
  });
}

async function render(ctx) {
  const data = await api.get('/integrations');
  if (!ctx.isCurrent()) return;
  const origin = location.origin;
  const liveKeys = data.keys.filter((k) => !k.revoked_at);

  mount(ctx.el, html`${STYLE}
  <div class="page-header"><div><h1 class="page-title">API & integrations</h1><p class="page-sub">Connect Diamond Protocol to your other systems.</p></div></div>
  <div class="grid-2" style="align-items:start">
    <section class="panel" aria-labelledby="keys-t">
      <div><h2 class="panel-title" id="keys-t">API keys</h2><p class="panel-sub">Let your other systems read athletes, programs and sessions, and send in test results.</p></div>
      <form class="stack-sm" id="newkey" novalidate>
        <label class="label" for="kl">Key label</label>
        <div class="row" style="flex-wrap:nowrap"><input class="input" id="kl" name="label" placeholder="e.g. Website booking form" maxlength="60" style="flex:1">
          <button class="btn btn-primary">Create key</button></div>
      </form>
      ${data.keys.length ? html`<div>${data.keys.map((k) => html`<div class="dpi-key">
        <div class="grow"><div class="strong">${k.label} ${k.revoked_at ? badge('off', 'Revoked') : ''}</div>
          <div class="small muted"><span class="mono" style="font-size:12px">dp_live_…${k.last4}</span> · created ${relTime(k.created_at)} · ${k.revoked_at ? `revoked ${relTime(k.revoked_at)}` : k.last_used ? `last used ${relTime(k.last_used)}` : 'never used'}</div></div>
        ${k.revoked_at ? '' : html`<button class="btn btn-ghost btn-sm" data-revoke="${k.id}" data-label="${k.label}">Revoke</button>`}
      </div>`)}</div>` : html`<p class="muted" style="margin:0">No keys yet. Create one to connect your first system.</p>`}
    </section>

    <section class="panel" aria-labelledby="hooks-t">
      <div><h2 class="panel-title" id="hooks-t">Webhooks</h2><p class="panel-sub">We send a signed event to your URL the moment something happens here.</p></div>
      ${data.webhooks.map((w) => html`<div class="dpi-hook">
        <div class="spread" style="align-items:flex-start"><div class="dpi-url">${w.url}</div>${w.active ? badge('active') : badge('paused')}</div>
        <div class="small muted">${w.events.join(', ')}</div>
        <div class="small muted">Signing secret <span class="mono" style="font-size:12px">${w.secret_hint}</span> · ${plural(w.delivered, 'delivery', 'deliveries')}</div>
        ${w.deliveries.length ? html`<div class="dpi-del" aria-label="Recent deliveries">${w.deliveries.map((d) => html`
          <span class="mono">${d.event}</span><span class="muted" title="${fmtDateTime(d.created_at)}">${relTime(d.created_at)}</span>${statusChip(d.status)}`)}</div>` : html`<div class="small muted">No deliveries yet.</div>`}
        <div class="btn-row">
          <button class="btn btn-sm" data-test="${w.id}">Send test event</button>
          <button class="btn btn-ghost btn-sm" data-toggle="${w.id}" data-active="${w.active ? 1 : 0}">${w.active ? 'Pause' : 'Resume'}</button>
          <button class="btn btn-ghost btn-sm" data-delhook="${w.id}" data-url="${w.url}">Delete</button>
        </div>
      </div>`)}
      <form class="stack-sm" id="newhook" novalidate style="${data.webhooks.length ? 'border-top:1px solid var(--line);padding-top:var(--space-4)' : ''}">
        <label class="label" for="hu">Destination URL</label>
        <input class="input" id="hu" name="url" placeholder="https://your-system.example.com/hooks" inputmode="url">
        <fieldset style="border:0;padding:0;margin-top:var(--space-2)"><legend class="label" style="padding:0;margin-bottom:6px">Events to send</legend>
          <div class="dpi-events">${data.events.map((e) => html`<label class="check"><input type="checkbox" name="events" value="${e}" data-multi checked>${e}</label>`)}</div>
        </fieldset>
        <div style="margin-top:var(--space-2)"><button class="btn">Add webhook</button></div>
      </form>
    </section>
  </div>

  <section class="panel" aria-labelledby="ref-t">
    <div><h2 class="panel-title" id="ref-t">API reference</h2><p class="panel-sub">Send your key as a header: <span class="mono">Authorization: Bearer dp_live_…</span></p></div>
    <div><a class="btn btn-outline" href="/docs/api" target="_blank" rel="noopener">Open the API reference</a></div>
    <pre class="dpi-code">curl ${origin}/api/v1/athletes \\
  -H "Authorization: Bearer dp_live_…"

curl -X POST ${origin}/api/v1/results \\
  -H "Authorization: Bearer dp_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"athlete_code":"AVALOP2026","source":"hawkin","test":"CMJ jump height","value":41.2,"unit":"cm"}'</pre>
    ${!liveKeys.length ? html`<p class="small muted" style="margin:0">Create an API key above to try these.</p>` : ''}
  </section>

  <section class="panel" aria-labelledby="out-t">
    <div class="panel-head"><div><h2 class="panel-title" id="out-t">Email outbox</h2>
      <p class="panel-sub">Sign-in codes, welcome emails, booking confirmations and invoices. Until an email service is connected, messages are logged here instead of sent.</p></div>
      <input class="input" type="search" id="oq" placeholder="Search by email or subject" aria-label="Search the outbox" style="max-width:280px"></div>
    <div id="outbox"></div>
  </section>`);

  const el = ctx.el;
  const act = async (fn, msg) => { try { const r = await fn(); if (msg) toast(msg); ctx.reload(); return r; } catch (err) { toastError(err); } };

  // keys
  const nk = el.querySelector('#newkey');
  nk.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/api-keys', formData(nk));
      await showOnce('Your new API key', html`Copy <span class="strong">${r.label}</span> now and store it in the other system. For your security it won't be shown again.`, r.key);
      ctx.reload();
    } catch (err) { toastError(err); }
  });
  el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Revoke API key', `Revoke ${b.dataset.label}? Anything using it stops working straight away.`, 'Revoke key', 'warn'))) return;
    act(() => api.del(`/api-keys/${b.dataset.revoke}`), 'Key revoked.');
  }));

  // webhooks
  const nh = el.querySelector('#newhook');
  nh.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/webhooks', formData(nh));
      await showOnce('Webhook added', 'Every event is signed with this secret. Save it now; it won\'t be shown again.', r.secret,
        html`<p class="small muted" style="margin:0">Each request carries <span class="mono">x-dp-signature</span>: the hex HMAC-SHA256 of the raw request body using this secret. Compare it before trusting the event. <a href="/docs/api#webhooks" target="_blank" rel="noopener">How to verify</a>.</p>`);
      ctx.reload();
    } catch (err) { toastError(err); }
  });
  el.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Sending…';
    try {
      const r = await api.post(`/webhooks/${b.dataset.test}/test`);
      toast(r.ok ? `Test event delivered (${r.status}).` : r.status ? `Test event not accepted. The URL answered ${r.status}.` : "Test event not delivered. We couldn't reach that URL.", r.ok ? 'good' : 'warn');
    } catch (err) { toastError(err); }
    ctx.reload();
  }));
  el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const on = b.dataset.active !== '1';
    act(() => api.put(`/webhooks/${b.dataset.toggle}`, { active: on }), on ? 'Webhook resumed.' : 'Webhook paused. Events are not sent while paused.');
  }));
  el.querySelectorAll('[data-delhook]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete webhook', `Stop sending events to ${b.dataset.url} and delete its delivery history?`, 'Delete webhook', 'warn'))) return;
    act(() => api.del(`/webhooks/${b.dataset.delhook}`), 'Webhook deleted.');
  }));

  // outbox
  const box = el.querySelector('#outbox');
  let items = [], total = 0;
  const load = async (reset) => {
    const q = el.querySelector('#oq').value.trim();
    const r = await api.get(`/outbox?limit=25&offset=${reset ? 0 : items.length}${q ? '&q=' + encodeURIComponent(q) : ''}`);
    items = reset ? r.items : items.concat(r.items); total = r.total;
    mount(box, items.length ? html`<div>${items.map((m) => html`<details class="dpi-mail">
        <summary><span class="muted">${relTime(m.created_at)}</span> · ${m.to_email} · <span class="strong">${m.subject}</span> <span class="muted">(${m.status})</span></summary>
        <pre>${m.body}</pre></details>`)}</div>
      ${items.length < total ? html`<div><button class="btn btn-sm" id="more">Show more (${total - items.length} older)</button></div>` : ''}`
      : html`<p class="muted" style="margin:0">${q ? 'No emails match.' : 'No emails yet.'}</p>`);
    box.querySelector('#more')?.addEventListener('click', () => load(false).catch(toastError));
  };
  el.querySelector('#oq').addEventListener('input', debounce(() => load(true).catch(toastError), 250));
  await load(true);
}

export const routes = [{ path: '/integrations', nav: 'api', title: 'API & integrations', roles: ['owner'], render }];
