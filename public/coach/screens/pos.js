// Point of sale: sell products or a custom amount anywhere, and set up locations, products and readers.
import { html, raw, mount, api, money, toCents, relTime, badge, toast, toastError, modal, confirmDialog, formData, options, debounce, plural } from '/js/ui.js';

const KIND_LABEL = { session: 'Single group session', group_pack: 'Group class pack', private_pack: 'Private session pack', gear: 'Gear', other: 'Other' };
const LOC_KIND = { facility: 'Facility', mobile: 'Mobile (clients\' homes)', park: 'Park', school: 'School' };
const credit = (p) => (p.kind === 'group_pack' || p.kind === 'session' ? plural(p.credits || 1, 'group session') : p.kind === 'private_pack' ? plural(p.credits || 1, 'private session') : '');
const STATUS = { paid: 'paid', refunded: ['Refunded', 'muted'], partial_refund: ['Part refunded', 'neutral'], failed: 'failed' };
const saleBadge = (s) => (Array.isArray(STATUS[s]) ? html`<span class="badge badge-${STATUS[s][1]}">${STATUS[s][0]}</span>` : badge(STATUS[s] || s));

const STYLE = html`<style>
  .pos-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:var(--space-4);align-items:start}
  .pos-side{position:sticky;top:16px}
  .pos-products{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:var(--space-3)}
  .pos-tile{display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;padding:12px;min-height:96px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);color:var(--steel);cursor:pointer;font:inherit}
  .pos-tile:hover{background:var(--surface-raised);border-color:var(--control-border)}
  .pos-tile:active{border-color:var(--green-mid)}
  .pos-tile .n{font-weight:600;line-height:20px}
  .pos-tile .p{font:600 20px/1.1 var(--font-display);color:var(--green-bright)}
  .pos-total{display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid var(--line);padding-top:12px}
  .pos-total .v{font:700 36px/1 var(--font-display)}
  .pos-line{display:flex;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--line-subtle)}
  .pos-line:first-child{border-top:0}
  .pos-qty{display:inline-flex;align-items:center;border:1px solid var(--control-border);border-radius:var(--radius-sm)}
  .pos-qty button{width:32px;height:32px;background:transparent;border:0;color:var(--steel);cursor:pointer;font-size:16px}
  .pos-qty span{min-width:20px;text-align:center;font-size:14px}
  .pay-opt{display:flex;gap:12px;align-items:flex-start;padding:8px 0;cursor:pointer}
  .pay-opt input{margin-top:3px;accent-color:var(--green-mid);width:18px;height:18px;flex-shrink:0}
  .pay-opt:has(input:disabled){opacity:.45;cursor:not-allowed}
  .pos-results{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-raised);margin-top:6px}
  .pos-results button{display:flex;width:100%;justify-content:space-between;gap:12px;padding:10px 12px;min-height:44px;background:transparent;border:0;border-top:1px solid var(--line);color:var(--steel);cursor:pointer;text-align:left}
  .pos-results button:first-child{border-top:0}
  .pos-results button:hover{background:var(--surface)}
  .pos-who{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;padding:0 4px 0 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm)}
  @media (max-width:1100px){.pos-grid{grid-template-columns:1fr}.pos-side{position:static}}
</style>`;

// ---------------------------------------------------------------- sale screen
async function renderPos(ctx) {
  const owner = ctx.me.role === 'owner', setup = ctx.me.role !== 'frontdesk';
  const [locations, products, readers, sales] = await Promise.all([api.get('/locations'), api.get('/products'), api.get('/readers'), api.get('/sales?days=7')]);
  if (!ctx.isCurrent()) return;
  const mode = ctx.settings?.payments_mode || 'test';
  let remembered = null;
  try { remembered = localStorage.getItem('dp-pos-location'); } catch { /* private window */ }
  const state = { location: locations.find((l) => String(l.id) === remembered)?.id || locations[0]?.id, who: null, cart: [], method: 'tap', seq: 0 };

  mount(ctx.el, html`${STYLE}
    <header class="page-header">
      <div><h1 class="page-title">Point of sale</h1><p class="page-sub">Take payments at the facility, in the park and at clients' homes.</p></div>
      ${setup ? html`<a class="btn" href="/app/pos/setup">Locations, products & readers</a>` : ''}
    </header>
    ${!locations.length ? html`<div class="banner">Add a location in Point of sale setup before you take a payment.</div>` : ''}
    <div class="pos-grid">
      <div class="stack">
        <section class="panel"><div class="form-grid">
          <div class="field"><label class="label" for="pos-loc">Where</label><select class="input" id="pos-loc">${options(locations, state.location)}</select>
            <span class="hint" id="loc-hint"></span></div>
          <div class="field"><span class="label" id="who-l">Who</span><div id="who-box"></div></div>
        </div></section>
        <section class="panel">
          <h2 class="panel-title">Products</h2>
          ${products.length ? html`<div class="pos-products">${products.map((p) => html`<button type="button" class="pos-tile" data-p="${p.id}">
            <span class="n">${p.name}</span><span class="p">${money(p.price_cents)}</span>${credit(p) ? html`<span class="small muted">${credit(p)}</span>` : ''}</button>`)}</div>`
            : html`<p class="muted" style="margin:0">No products yet.${setup ? html` <a href="/app/pos/setup">Add products</a>.` : ''}</p>`}
          <form id="custom" class="stack-sm" novalidate><span class="label">Custom amount</span>
            <div class="row" style="flex-wrap:nowrap"><input class="input" name="name" placeholder="Description" aria-label="Description" style="flex:2">
              <input class="input" name="amount" inputmode="decimal" placeholder="$" aria-label="Amount in dollars" style="flex:1;min-width:80px">
              <button class="btn">Add</button></div></form>
        </section>
      </div>
      <aside class="panel pos-side" id="sale" aria-label="Sale"></aside>
    </div>
    <section class="panel" id="recent"></section>`);

  const $ = (s) => ctx.el.querySelector(s);
  const loc = () => locations.find((l) => l.id === +state.location);
  const total = () => state.cart.reduce((n, l) => n + l.price_cents * l.qty, 0);

  function renderLocHint() {
    const l = loc();
    $('#loc-hint').textContent = l && !l.cards_ready ? 'No address for this location, so only cash works here. Add one in setup.' : '';
    $('#loc-hint').className = l && !l.cards_ready ? 'hint warn-text' : 'hint';
  }

  function renderWho() {
    const box = $('#who-box');
    mount(box, state.who
      ? html`<div class="pos-who"><span><span class="strong">${state.who.first_name} ${state.who.last_name}</span>
          <span class="small muted"> · ${state.who.card ? `${state.who.card.brand} ••${state.who.card.last4}` : 'No card on file'}</span></span>
          <button class="btn btn-ghost btn-sm" id="who-clear">Walk-in</button></div>`
      : html`<input class="input" id="who-q" placeholder="Walk-in (no account). Search clients" autocomplete="off" aria-labelledby="who-l">
          <div class="pos-results" id="who-res" hidden></div>`);
    box.querySelector('#who-clear')?.addEventListener('click', () => { state.who = null; if (state.method === 'card') state.method = 'tap'; renderWho(); renderSale(); });
    const q = box.querySelector('#who-q'), res = box.querySelector('#who-res');
    if (!q) return;
    q.addEventListener('input', debounce(async () => {
      const term = q.value.trim();
      if (term.length < 2) { res.hidden = true; return; }
      const list = await api.get(`/athletes/search?q=${encodeURIComponent(term)}`).catch(() => []);
      mount(res, list.length ? list.map((a) => html`<button type="button" data-a="${a.id}"><span><span class="strong">${a.first_name} ${a.last_name}</span>
        <span class="small muted"> ${a.code}${a.family ? ` · ${a.family}` : ''}</span></span></button>`) : html`<div class="small muted" style="padding:10px 12px">No clients match. Keep it as a walk-in.</div>`);
      res.hidden = false;
    }, 200));
    res.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      try { state.who = await api.get(`/pos/client/${b.dataset.a}`); if (state.who.card && state.method === 'tap' && !state.cart.length) state.method = 'tap'; renderWho(); renderSale(); }
      catch (err) { toastError(err); }
    });
  }

  function renderSale() {
    const l = loc(), who = state.who, cardsOk = !!l?.cards_ready;
    const opts = [
      { v: 'tap', t: 'Tap to Pay on iPhone', s: mode === 'test' ? 'Client taps their card or phone. Simulated in test mode.' : 'Client taps their card or phone on your iPhone.', ok: cardsOk },
      { v: 'reader', t: 'Front-desk reader', s: readers.length ? `Sends the charge to ${readers[0].label}.` : 'No reader registered.', ok: cardsOk && readers.length > 0 },
      { v: 'card', t: 'Card on file', s: who?.card ? `${who.card.brand} ••${who.card.last4}` : who ? 'No saved card for this family.' : 'Choose a client with a saved card.', ok: cardsOk && !!who?.card },
      { v: 'cash', t: 'Cash', s: 'Record a cash payment.', ok: true },
    ];
    if (!opts.find((o) => o.v === state.method)?.ok) state.method = opts.find((o) => o.ok).v;
    const canSave = (state.method === 'tap' || state.method === 'reader') && who?.family_id;
    mount($('#sale'), html`<h2 class="panel-title">Sale</h2>
      ${state.cart.length ? html`<div>${state.cart.map((c, i) => html`<div class="pos-line">
        <div style="flex:1;min-width:0"><div>${c.name}</div><div class="small muted">${money(c.price_cents)} each</div></div>
        <div class="pos-qty"><button type="button" data-dec="${i}" aria-label="One fewer ${c.name}">−</button><span>${c.qty}</span><button type="button" data-inc="${i}" aria-label="One more ${c.name}">+</button></div>
        <div style="min-width:64px;text-align:right" class="strong">${money(c.price_cents * c.qty)}</div></div>`)}</div>`
        : html`<p class="muted" style="margin:0">Tap a product to add it.</p>`}
      <div class="pos-total"><span class="muted">Total</span><span class="v">${money(total())}</span></div>
      <div class="stack-sm" role="radiogroup" aria-label="Payment"><span class="label">Payment</span>
        ${opts.map((o) => html`<label class="pay-opt"><input type="radio" name="pm" value="${o.v}" ${o.v === state.method ? raw('checked') : ''} ${o.ok ? '' : raw('disabled')}>
          <span><span class="strong">${o.t}</span><br><span class="small muted">${o.s}</span></span></label>`)}
      </div>
      ${canSave ? html`<label class="check"><input type="checkbox" id="save-card"><span>Save card to the ${who.family || 'family'} account for their membership</span></label>` : ''}
      <button class="btn btn-primary btn-lg btn-block" id="charge" ${state.cart.length && l ? '' : raw('disabled')}>${state.method === 'cash' ? `Record ${money(total())} cash` : `Charge ${money(total())}`}</button>`);
  }

  async function renderRecent() {
    const list = await api.get('/sales?days=7').catch(() => sales);
    mount($('#recent'), html`<div><h2 class="panel-title">Recent sales</h2><p class="panel-sub">Last 7 days.</p></div>
      ${list.length ? html`<div class="list">${list.map((s) => html`<div class="list-row">
        <div class="grow"><div class="strong">${s.who} · ${money(s.total_cents)}${s.refunded_cents ? html` <span class="muted small">(${money(s.refunded_cents)} refunded)</span>` : ''}</div>
          <div class="small muted">${s.items.map((i) => (i.qty > 1 ? `${i.qty} × ${i.name}` : i.name)).join(', ')} · ${s.location || 'No location'} · ${s.method_label}${s.card_last4 ? ` ••${s.card_last4}` : ''} · ${relTime(s.created_at)}${s.staff ? ` · ${s.staff}` : ''}</div></div>
        ${saleBadge(s.status)}
        ${owner && (s.status === 'paid' || s.status === 'partial_refund') ? html`<button class="btn btn-ghost btn-sm" data-refund="${s.id}">Refund</button>` : ''}
      </div>`)}</div>` : html`<p class="muted" style="margin:0">No sales in the last 7 days.</p>`}`);
    $('#recent').querySelectorAll('[data-refund]').forEach((b) => b.addEventListener('click', () => refundModal(list.find((s) => s.id === +b.dataset.refund), renderRecent)));
  }

  function add(line) {
    const i = state.cart.findIndex((c) => (line.product_id ? c.product_id === line.product_id : false));
    if (i >= 0) state.cart[i].qty++; else state.cart.push({ ...line, qty: 1 });
    renderSale();
  }

  $('#pos-loc').addEventListener('change', (e) => { state.location = +e.target.value; try { localStorage.setItem('dp-pos-location', e.target.value); } catch { /* ignore */ } renderLocHint(); renderSale(); });
  ctx.el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
    const p = products.find((x) => x.id === +b.dataset.p);
    add({ product_id: p.id, name: p.name, price_cents: p.price_cents, kind: p.kind });
  }));
  $('#custom').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, cents = toCents(f.amount.value);
    if (!(cents > 0)) { toast('Enter an amount above $0.', 'warn'); f.amount.focus(); return; }
    add({ name: f.name.value.trim() || 'Custom amount', price_cents: cents, custom: ++state.seq });
    f.reset();
  });
  $('#sale').addEventListener('click', async (e) => {
    const inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]');
    if (inc) { state.cart[+inc.dataset.inc].qty++; return renderSale(); }
    if (dec) { const c = state.cart[+dec.dataset.dec]; if (--c.qty <= 0) state.cart.splice(+dec.dataset.dec, 1); return renderSale(); }
    if (e.target.closest('#charge')) charge(e.target.closest('#charge'));
  });
  $('#sale').addEventListener('change', (e) => { if (e.target.name === 'pm') { state.method = e.target.value; renderSale(); } });

  async function charge(btn) {
    const amount = money(total());
    const saveCard = !!$('#save-card')?.checked;
    if (state.method === 'tap' || state.method === 'reader') {
      const ok = await modal({
        title: state.method === 'tap' ? 'Tap to Pay' : 'Front-desk reader',
        body: html`<p class="display" style="font-size:40px;margin:0;text-align:center">${amount}</p>
          <p style="margin:0;text-align:center">${state.method === 'tap' ? 'Hand over the iPhone. The client taps their card or phone near the top.' : `The charge is on ${readers[0]?.label || 'the reader'}. The client taps or inserts their card.`}</p>
          ${mode === 'test' ? html`<p class="small muted" style="margin:0;text-align:center">Test mode: the card is simulated as Visa ••4242.</p>` : ''}`,
        actions: [{ label: 'Cancel', value: false }, { label: mode === 'test' ? 'Simulate card tap' : 'Card presented', value: true, kind: 'primary' }],
      });
      if (!ok) return;
    }
    btn.disabled = true;
    try {
      const r = await api.post('/sales', {
        location_id: state.location, athlete_id: state.who?.id || null, method: state.method, save_card: saveCard,
        items: state.cart.map((c) => (c.product_id ? { product_id: c.product_id, qty: c.qty } : { name: c.name, price_cents: c.price_cents, qty: c.qty })),
      });
      toast(r.message);
      state.cart = [];
      if (r.saved_card && state.who) state.who = await api.get(`/pos/client/${state.who.id}`);
      renderWho(); renderSale(); renderRecent();
    } catch (err) { toastError(err); btn.disabled = false; }
  }

  renderLocHint(); renderWho(); renderSale(); renderRecent();
}

async function refundModal(s, after) {
  const left = s.total_cents - s.refunded_cents;
  const r = await modal({
    title: `Refund ${s.who}`,
    body: html`<p style="margin:0">${s.items.map((i) => i.name).join(', ')} · ${money(s.total_cents)} by ${s.method_label.toLowerCase()}${s.refunded_cents ? `, ${money(s.refunded_cents)} already refunded` : ''}.</p>
      <div class="field"><label class="label" for="rf-amt">Amount to refund ($)</label><input class="input" id="rf-amt" inputmode="decimal" value="${(left / 100).toFixed(2)}">
        <span class="hint">Up to ${money(left)}. A full refund also takes back any unused pack sessions.${s.method === 'cash' ? ' Hand the cash back.' : ' It goes back to the card.'}</span></div>
      <div class="error" id="rf-err" role="alert"></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Refund', kind: 'warn', onClick: async (body) => {
      const amt = toCents(body.querySelector('#rf-amt').value);
      try { return await api.post(`/sales/${s.id}/refund`, { amount_cents: amt }); }
      catch (e) { body.querySelector('#rf-err').textContent = e.message; return false; }
    } }],
  });
  if (r) { toast(r.message); after(); }
}

// ---------------------------------------------------------------- setup
async function renderSetup(ctx) {
  const [locations, products, readers] = await Promise.all([api.get('/locations'), api.get('/products'), api.get('/readers')]);
  if (!ctx.isCurrent()) return;
  const mode = ctx.settings?.payments_mode || 'test';
  mount(ctx.el, html`${STYLE}
    <header class="page-header">
      <div><h1 class="page-title">Point of sale setup</h1><p class="page-sub">Where you train, what you sell and your card readers.</p></div>
      <a class="btn btn-primary" href="/app/pos">Back to sales</a>
    </header>
    <div class="grid-2" style="align-items:start">
      <section class="panel">
        <div><h2 class="panel-title">Locations</h2><p class="panel-sub">Card payments need a street address for each place. For client homes, use one "Mobile" location with your business address.</p></div>
        <div class="list">${locations.map((l) => html`<div class="list-row"><div class="grow"><div class="strong">${l.name}</div>
          <div class="small muted">${LOC_KIND[l.kind] || l.kind}${l.address ? ` · ${l.address}` : ''}</div></div>
          ${l.cards_ready ? badge('active', 'Cards ready') : badge('at_risk', 'Needs address')}
          <button class="btn btn-ghost btn-sm" data-edit-loc="${l.id}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-arch-loc="${l.id}">Archive</button></div>`)}</div>
        <form id="lf" class="stack" novalidate style="border-top:1px solid var(--line-subtle);padding-top:var(--space-4)">
          <div class="form-grid"><div class="field"><label class="label" for="lf-n">Location name</label><input class="input" id="lf-n" name="name" required></div>
            <div class="field"><label class="label" for="lf-k">Type</label><select class="input" id="lf-k" name="kind"><option value="facility">Facility</option><option value="mobile">Mobile (clients' homes)</option><option value="park">Park</option></select></div></div>
          <div class="field"><label class="label" for="lf-s">Street address</label><input class="input" id="lf-s" name="street" autocomplete="street-address"></div>
          <div class="form-grid" style="grid-template-columns:2fr 1fr 1fr"><div class="field"><label class="label" for="lf-c">City</label><input class="input" id="lf-c" name="city"></div>
            <div class="field"><label class="label" for="lf-st">State</label><input class="input" id="lf-st" name="state" maxlength="2" placeholder="UT"></div>
            <div class="field"><label class="label" for="lf-z">ZIP</label><input class="input" id="lf-z" name="zip" inputmode="numeric" maxlength="10"></div></div>
          <div class="error" id="lf-err" role="alert"></div>
          <div><button class="btn btn-primary">Add location</button></div>
        </form>
      </section>
      <div class="stack">
        <section class="panel">
          <div><h2 class="panel-title">Products</h2><p class="panel-sub">Sessions and packs add session credits to the client. Members check in on their membership.</p></div>
          <div class="list">${products.map((p) => html`<div class="list-row"><div class="grow"><div class="strong">${p.name}</div>
            <div class="small muted">${money(p.price_cents)}${credit(p) ? ` · ${credit(p)}` : ` · ${KIND_LABEL[p.kind]}`}</div></div>
            <button class="btn btn-ghost btn-sm" data-price="${p.id}">Price</button><button class="btn btn-ghost btn-sm" data-stop="${p.id}">Stop selling</button></div>`)}</div>
          <form id="pf" class="stack" novalidate style="border-top:1px solid var(--line-subtle);padding-top:var(--space-4)">
            <div class="form-grid"><div class="field"><label class="label" for="pf-n">Product name</label><input class="input" id="pf-n" name="name" required></div>
              <div class="field"><label class="label" for="pf-k">Type</label><select class="input" id="pf-k" name="kind">${Object.entries(KIND_LABEL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div></div>
            <div class="form-grid"><div class="field"><label class="label" for="pf-p">Price ($)</label><input class="input" id="pf-p" name="price" inputmode="decimal"></div>
              <div class="field" id="pf-cr-f" hidden><label class="label" for="pf-cr">Sessions in the pack</label><input class="input" id="pf-cr" name="credits" type="number" min="1" max="200" value="10"></div></div>
            <div class="error" id="pf-err" role="alert"></div>
            <div><button class="btn btn-primary">Add product</button></div>
          </form>
        </section>
        <section class="panel">
          <div><h2 class="panel-title">Front-desk readers</h2><p class="panel-sub">For a Stripe smart reader (like the S710). Turn it on, connect it to Wi-Fi, and enter the code it shows.</p></div>
          ${readers.length ? html`<div class="list">${readers.map((r) => html`<div class="list-row"><div class="grow"><div class="strong">${r.label}</div>
            <div class="small muted">${r.location || 'No location'} · <span class="mono">${r.serial || ''}</span></div></div>
            <button class="btn btn-ghost btn-sm" data-del-reader="${r.id}">Remove</button></div>`)}</div>` : html`<p class="muted" style="margin:0">No readers yet. Tap to Pay on iPhone works without one.</p>`}
          <form id="rf" class="stack" novalidate style="border-top:1px solid var(--line-subtle);padding-top:var(--space-4)">
            <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
              <div class="field"><label class="label" for="rf-c">Registration code</label><input class="input" id="rf-c" name="code" placeholder="three-words-code" autocomplete="off">${mode === 'test' ? html`<span class="hint">Test mode: use simulated-wpe</span>` : ''}</div>
              <div class="field"><label class="label" for="rf-l">Label</label><input class="input" id="rf-l" name="label" placeholder="Front desk"></div>
              <div class="field"><label class="label" for="rf-loc">Location</label><select class="input" id="rf-loc" name="location_id">${options(locations, locations[0]?.id)}</select></div></div>
            <div class="error" id="rf-err" role="alert"></div>
            <div><button class="btn">Register reader</button></div>
          </form>
        </section>
      </div>
    </div>`);

  const $ = (s) => ctx.el.querySelector(s);
  const submit = (formSel, errSel, fn, done) => $(formSel).addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $(errSel); err.textContent = '';
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try { await fn(formData(e.target)); toast(done); ctx.reload(); }
    catch (x) { err.textContent = x.message; btn.disabled = false; }
  });
  submit('#lf', '#lf-err', (d) => api.post('/locations', d), 'Location added.');
  submit('#pf', '#pf-err', (d) => api.post('/products', { name: d.name, kind: d.kind, price_cents: toCents(d.price), credits: Number(d.credits) }), 'Product added.');
  submit('#rf', '#rf-err', (d) => api.post('/readers', d), 'Reader registered.');
  const kindSel = $('#pf-k');
  kindSel.addEventListener('change', () => { $('#pf-cr-f').hidden = !['group_pack', 'private_pack'].includes(kindSel.value); });

  ctx.el.querySelectorAll('[data-arch-loc]').forEach((b) => b.addEventListener('click', async () => {
    const l = locations.find((x) => x.id === +b.dataset.archLoc);
    if (!(await confirmDialog(`Archive ${l.name}?`, 'It stops showing in Point of sale and new classes. Past sales keep it.', 'Archive', 'warn'))) return;
    try { await api.put(`/locations/${l.id}`, { archived: true }); toast(`${l.name} archived.`); ctx.reload(); } catch (e) { toastError(e); }
  }));
  ctx.el.querySelectorAll('[data-edit-loc]').forEach((b) => b.addEventListener('click', async () => {
    const l = locations.find((x) => x.id === +b.dataset.editLoc);
    const r = await modal({
      title: `Edit ${l.name}`,
      body: html`<div class="field"><label class="label" for="el-n">Name</label><input class="input" id="el-n" value="${l.name}"></div>
        <div class="field"><label class="label" for="el-k">Type</label><select class="input" id="el-k">${Object.entries(LOC_KIND).filter(([k]) => k !== 'school' || l.kind === 'school').map(([k, v]) => html`<option value="${k}" ${k === l.kind ? raw('selected') : ''}>${v}</option>`)}</select></div>
        <div class="field"><label class="label" for="el-a">Full address</label><input class="input" id="el-a" value="${l.address || ''}" placeholder="Street, City, ST ZIP"><span class="hint">Card payments need an address.</span></div>
        <div class="error" id="el-err" role="alert"></div>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save location', kind: 'primary', onClick: async (body) => {
        try { return await api.put(`/locations/${l.id}`, { name: body.querySelector('#el-n').value, kind: body.querySelector('#el-k').value, address: body.querySelector('#el-a').value }); }
        catch (e) { body.querySelector('#el-err').textContent = e.message; return false; }
      } }],
    });
    if (r) { toast('Location saved.'); ctx.reload(); }
  }));
  ctx.el.querySelectorAll('[data-price]').forEach((b) => b.addEventListener('click', async () => {
    const p = products.find((x) => x.id === +b.dataset.price);
    const r = await modal({
      title: `Price for ${p.name}`,
      body: html`<div class="field"><label class="label" for="pp">Price ($)</label><input class="input" id="pp" inputmode="decimal" value="${(p.price_cents / 100).toFixed(2)}"><span class="hint">Applies to new sales. Past sales keep their price.</span></div>
        ${p.kind === 'group_pack' || p.kind === 'private_pack' ? html`<div class="field"><label class="label" for="pc">Sessions in the pack</label><input class="input" id="pc" type="number" min="1" value="${p.credits}"></div>` : ''}
        <div class="error" id="pp-err" role="alert"></div>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save price', kind: 'primary', onClick: async (body) => {
        const payload = { price_cents: toCents(body.querySelector('#pp').value) };
        if (body.querySelector('#pc')) payload.credits = Number(body.querySelector('#pc').value);
        try { return await api.put(`/products/${p.id}`, payload); } catch (e) { body.querySelector('#pp-err').textContent = e.message; return false; }
      } }],
    });
    if (r) { toast('Price saved.'); ctx.reload(); }
  }));
  ctx.el.querySelectorAll('[data-stop]').forEach((b) => b.addEventListener('click', async () => {
    const p = products.find((x) => x.id === +b.dataset.stop);
    if (!(await confirmDialog(`Stop selling ${p.name}?`, 'It comes off the sale screen and the parent portal. Credits already bought still work.', 'Stop selling', 'warn'))) return;
    try { await api.put(`/products/${p.id}`, { archived: true }); toast(`${p.name} is no longer for sale.`); ctx.reload(); } catch (e) { toastError(e); }
  }));
  ctx.el.querySelectorAll('[data-del-reader]').forEach((b) => b.addEventListener('click', async () => {
    const r = readers.find((x) => x.id === +b.dataset.delReader);
    if (!(await confirmDialog(`Remove ${r.label}?`, 'You can register it again with a new code.', 'Remove', 'warn'))) return;
    try { await api.del(`/readers/${r.id}`); toast('Reader removed.'); ctx.reload(); } catch (e) { toastError(e); }
  }));
}

export const routes = [
  { path: '/pos', nav: 'pos', title: 'Point of sale', render: renderPos },
  { path: '/pos/setup', nav: 'pos', title: 'Point of sale setup', roles: ['owner', 'coach'], render: renderSetup },
];
