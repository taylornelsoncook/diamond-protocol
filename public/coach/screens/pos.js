// Point of sale: sell products, packs, memberships or a custom amount anywhere, and set up locations, products and readers.
import { html, raw, mount, api, money, toCents, relTime, fmtDateTime, badge, toast, toastError, modal, confirmDialog, formData, options, debounce, plural } from '/js/ui.js';

const KIND_LABEL = { session: 'Single group session', group_pack: 'Group class pack', private_pack: 'Private session pack', gear: 'Gear', other: 'Other' };
const LOC_KIND = { facility: 'Facility', mobile: 'Mobile (clients\' homes)', park: 'Park', school: 'School' };
const credit = (p) => (p.kind === 'group_pack' || p.kind === 'session' ? plural(p.credits || 1, 'group session') : p.kind === 'private_pack' ? plural(p.credits || 1, 'private session') : '');
const planInfo = (p) => [p.group_per_month == null ? 'Unlimited group sessions' : plural(p.group_per_month, 'group session') + ' a month',
  p.private_per_month ? plural(p.private_per_month, 'private session') + ' a month' : '', p.trial_days ? `${p.trial_days}-day free trial` : ''].filter(Boolean).join(' · ');
const STATUS = { paid: 'paid', refunded: ['Refunded', 'muted'], partial_refund: ['Part refunded', 'neutral'], failed: 'failed' };
const saleBadge = (s) => (Array.isArray(STATUS[s]) ? html`<span class="badge badge-${STATUS[s][1]}">${STATUS[s][0]}</span>` : badge(STATUS[s] || s));
const itemText = (items) => items.filter((i) => i.kind !== 'discount').map((i) => (i.qty > 1 ? `${i.qty} × ${i.name}` : i.name)).join(', ');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The sale in progress survives leaving the screen (this tab only); a few conveniences are remembered per device.
const store = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const pref = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

const STYLE = html`<style>
  .pos-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:var(--space-4);align-items:start}
  .pos-side{position:sticky;top:16px;scroll-margin-top:72px}
  .pos-products{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:var(--space-3)}
  .pos-tile{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;padding:12px;min-height:96px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);color:var(--steel);cursor:pointer;font:inherit}
  .pos-tile:hover{background:var(--surface-raised);border-color:var(--control-border)}
  .pos-tile:active{border-color:var(--green-mid)}
  .pos-tile:focus-visible{outline:2px solid var(--green-mid);outline-offset:2px}
  .pos-tile[aria-disabled="true"]{opacity:.5}
  .pos-tile .n{font-weight:600;line-height:20px;padding-right:28px}
  .pos-tile .p{font:600 20px/1.1 var(--font-display);color:var(--green-bright)}
  .pos-tile .in{position:absolute;top:8px;right:8px;min-width:24px;height:24px;padding:0 6px;border-radius:var(--radius-pill);background:var(--green-deep);color:var(--green-soft);font:600 13px/24px var(--font-sans);text-align:center}
  .pos-sum{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .pos-total{display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid var(--line);padding-top:12px}
  .pos-total .v{font:700 36px/1 var(--font-display)}
  .pos-line{display:flex;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--line-subtle)}
  .pos-line:first-child{border-top:0}
  .pos-qty{display:inline-flex;align-items:center;border:1px solid var(--control-border);border-radius:var(--radius-sm)}
  .pos-qty button{width:44px;height:44px;background:transparent;border:0;color:var(--steel);cursor:pointer;font-size:18px}
  .pos-qty span{min-width:22px;text-align:center;font-size:15px}
  .pay-opt{display:flex;gap:12px;align-items:flex-start;padding:8px 0;min-height:44px;cursor:pointer}
  .pay-opt input{margin-top:3px;accent-color:var(--green-mid);width:20px;height:20px;flex-shrink:0}
  .pay-opt:has(input:disabled){opacity:.45;cursor:not-allowed}
  .pos-results{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-raised);margin-top:6px;max-height:320px;overflow:auto}
  .pos-results button{display:flex;width:100%;justify-content:space-between;gap:12px;padding:10px 12px;min-height:44px;background:transparent;border:0;border-top:1px solid var(--line);color:var(--steel);cursor:pointer;text-align:left;font:inherit}
  .pos-results button:first-child{border-top:0}
  .pos-results button:hover,.pos-results button:focus{background:var(--surface);outline:none}
  .pos-who{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;padding:4px 4px 4px 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm)}
  .pos-who .facts{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:2px}
  .pos-done{border:1px solid var(--green-mid);background:var(--green-deep);color:var(--green-soft);border-radius:var(--radius-sm);padding:12px}
  .pos-row{cursor:pointer}
  .pos-row:hover .strong{text-decoration:underline}
  .pos-row:focus-visible{outline:2px solid var(--green-mid);outline-offset:2px}
  .pos-filters{display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:center}
  .pos-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--space-3)}
  .pos-metric{border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px}
  .pos-metric .v{font:600 26px/1.1 var(--font-display)}
  .pos-bar{display:none}
  .pos-page .btn-sm,.pos-page .seg button{min-height:44px}
  .pos-set .list-row{flex-wrap:wrap}
  .pos-set .list-row .acts{display:flex;gap:4px;margin-left:auto}
  @media (max-width:1100px){.pos-grid{grid-template-columns:1fr}.pos-side{position:static}
    .pos-bar{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:var(--surface);border-top:1px solid var(--line)}
    .pos-bar[hidden]{display:none}
    .pos-page.has-bar{padding-bottom:76px}}
  @media (max-width:600px){.pos-set .list-row .grow{flex-basis:100%}.pos-set .list-row .acts{margin-left:0}}
</style>`;

// ---------------------------------------------------------------- sale screen
async function renderPos(ctx) {
  const role = ctx.me.role, owner = role === 'owner', coach = role === 'coach', setup = role !== 'frontdesk';
  const [locations, products, readers, plans] = await Promise.all([api.get('/locations'), api.get('/products'), api.get('/readers'), api.get('/pos/memberships')]);
  if (!ctx.isCurrent()) return;
  const mode = ctx.settings?.payments_mode || 'test';
  const saved = store.get('dp-pos-sale');
  const remembered = pref.get('dp-pos-location');
  const state = {
    location: locations.find((l) => String(l.id) === remembered)?.id || locations[0]?.id, who: null,
    cart: Array.isArray(saved?.cart) ? saved.cart : [], method: 'tap', seq: saved?.seq || 0,
    discount: saved?.discount || null, receipt: null, receiptEmail: '', tendered: '', last: null,
    period: 1, q: '', histLoc: '',
  };
  let barHidden = false;
  const tileCount = products.length + plans.length;

  mount(ctx.el, html`${STYLE}<div class="pos-page">
    <header class="page-header">
      <div><h1 class="page-title">Point of sale</h1><p class="page-sub">Take payments at the facility, in the park and at clients' homes.</p></div>
      ${setup ? html`<a class="btn" href="/app/pos/setup">Locations, products & readers</a>` : ''}
    </header>
    ${!locations.length ? html`<div class="banner">Add a location in Point of sale setup before you take a payment.${setup ? html` <a href="/app/pos/setup">Open setup</a>.` : ' Ask the owner to add one.'}</div>` : ''}
    <div class="pos-grid">
      <div class="stack">
        <section class="panel"><div class="form-grid">
          <div class="field"><label class="label" for="pos-loc">Where</label><select class="input" id="pos-loc">${options(locations, state.location)}</select>
            <span class="hint" id="loc-hint"></span></div>
          <div class="field"><span class="label" id="who-l">Who</span><div id="who-box"></div></div>
        </div></section>
        <section class="panel">
          <div class="spread"><h2 class="panel-title">Products</h2>
            ${tileCount > 8 ? html`<input class="input" id="pos-find" type="search" placeholder="Find a product" aria-label="Find a product" style="max-width:220px">` : ''}</div>
          ${products.length ? html`<div class="pos-products" id="pos-tiles">${products.map((p) => html`<button type="button" class="pos-tile" data-p="${p.id}" data-name="${p.name.toLowerCase()}">
            <span class="n">${p.name}</span><span class="p">${money(p.price_cents)}</span>${credit(p) ? html`<span class="small muted">${credit(p)}</span>` : ''}<span class="in" hidden></span></button>`)}</div>`
            : html`<p class="muted" style="margin:0">No products yet.${setup ? html` <a href="/app/pos/setup">Add products</a>.` : ' Ask the owner to add some. You can still take a custom amount.'}</p>`}
          ${plans.length ? html`<div class="stack-sm"><span class="label">Monthly memberships</span><div class="pos-products" id="pos-plans"></div></div>` : ''}
          <p class="muted small" id="pos-nomatch" hidden style="margin:0">Nothing matches. Clear the search or add a custom amount.</p>
          <form id="custom" class="stack-sm" novalidate><span class="label">Custom amount</span>
            <div class="row" style="flex-wrap:nowrap"><input class="input" name="name" placeholder="Description" aria-label="Description" maxlength="80" style="flex:2;min-width:0">
              <input class="input" name="amount" inputmode="decimal" placeholder="$" aria-label="Amount in dollars" style="flex:1;min-width:72px">
              <button class="btn">Add</button></div></form>
        </section>
      </div>
      <aside class="panel pos-side" id="sale" aria-label="Sale"></aside>
    </div>
    ${coach ? '' : html`<section class="panel" id="today" aria-live="polite"></section>`}
    <section class="panel" id="recent">
      <div><h2 class="panel-title">${coach ? 'Your sales' : 'Recent sales'}</h2><p class="panel-sub" id="rs-sub"></p></div>
      <div class="pos-filters">
        <div class="seg" role="group" aria-label="Period">${[[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([d, t]) => html`<button type="button" data-days="${d}" aria-pressed="${d === state.period ? 'true' : 'false'}">${t}</button>`)}</div>
        <input class="input" id="rs-q" type="search" placeholder="Search client or item" aria-label="Search sales" style="flex:1;min-width:160px;max-width:280px">
        ${locations.length > 1 ? html`<select class="input" id="rs-loc" aria-label="Location" style="width:auto"><option value="">All locations</option>${options(locations, '')}</select>` : ''}
      </div>
      <div id="rs-list"><p class="muted" style="margin:0">Loading sales…</p></div>
    </section>
    <div class="pos-bar" id="pos-bar" hidden><span><span class="strong" id="bar-n"></span> <span class="muted" id="bar-t"></span></span>
      <button class="btn btn-primary" id="bar-go">Review sale</button></div>
  </div>`);

  const $ = (s) => ctx.el.querySelector(s);
  const loc = () => locations.find((l) => l.id === +state.location);
  const locReaders = () => readers.filter((r) => r.location_id === +state.location);
  const subtotal = () => state.cart.reduce((n, l) => n + l.price_cents * l.qty, 0);
  const discountCents = () => {
    const d = state.discount, sub = subtotal();
    if (!d || !(Number(d.value) > 0)) return 0;
    const v = d.type === 'pct' ? Math.round(sub * Math.min(99, Math.floor(Number(d.value))) / 100) : toCents(d.value);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  };
  const total = () => subtotal() - discountCents();
  const persist = () => store.set('dp-pos-sale', state.cart.length || state.who ? { cart: state.cart, seq: state.seq, discount: state.discount, who: state.who?.id || null } : null);

  function renderLocHint() {
    const l = loc(), hint = $('#loc-hint');
    hint.textContent = l && !l.cards_ready ? 'No address for this location, so only cash works here. Add one in setup.' : '';
    hint.className = l && !l.cards_ready ? 'hint warn-text' : 'hint';
  }

  function renderWho() {
    const box = $('#who-box'), w = state.who;
    mount(box, w
      ? html`<div class="pos-who"><div style="min-width:0"><a class="strong" href="/app/clients/${w.id}">${w.first_name} ${w.last_name}</a>
          <div class="facts small muted"><span>${w.card ? `${w.card.brand} ••${w.card.last4}` : 'No card on file'}</span>
            ${w.membership ? html`<span>${w.membership.plan_name}${w.membership.status !== 'active' ? ` (${w.membership.status.replace('_', ' ')})` : ''}</span>` : ''}
            <span>${plural(w.group_credits || 0, 'group credit')}${w.private_credits ? ` · ${plural(w.private_credits, 'private credit')}` : ''}</span></div></div>
          <button class="btn btn-ghost btn-sm" id="who-clear" aria-label="Change client or make it a walk-in">Change</button></div>`
      : html`<input class="input" id="who-q" type="search" placeholder="Walk-in (no account). Search clients" autocomplete="off" aria-labelledby="who-l" aria-controls="who-res" aria-expanded="false">
          <div class="pos-results" id="who-res" role="listbox" aria-label="Matching clients" hidden></div>`);
    box.querySelector('#who-clear')?.addEventListener('click', () => {
      state.who = null; state.receipt = null; if (state.method === 'card') state.method = 'tap'; persist(); renderWho(); renderPlans(); renderSale(); $('#who-q')?.focus();
    });
    const q = box.querySelector('#who-q'), res = box.querySelector('#who-res');
    if (!q) return;
    const close = () => { res.hidden = true; q.setAttribute('aria-expanded', 'false'); };
    let seq = 0;
    q.addEventListener('input', debounce(async () => {
      const term = q.value.trim();
      if (term.length < 2) { close(); return; }
      const mine = ++seq;
      const list = await api.get(`/athletes/search?q=${encodeURIComponent(term)}`).catch(() => []);
      if (mine !== seq || !q.isConnected) return;
      mount(res, list.length ? list.map((a) => html`<button type="button" role="option" data-a="${a.id}"><span><span class="strong">${a.first_name} ${a.last_name}</span>
        <span class="small muted"> ${a.code}${a.family ? ` · ${a.family}` : ''}</span></span></button>`) : html`<div class="small muted" style="padding:10px 12px">No clients match. Keep it as a walk-in.</div>`);
      res.hidden = false; q.setAttribute('aria-expanded', 'true');
    }, 200));
    q.addEventListener('keydown', (e) => {
      const first = res.querySelector('[data-a]');
      if (e.key === 'ArrowDown' && first && !res.hidden) { e.preventDefault(); first.focus(); }
      if (e.key === 'Enter' && first && !res.hidden) { e.preventDefault(); first.click(); }
      if (e.key === 'Escape') close();
    });
    res.addEventListener('keydown', (e) => {
      const btns = [...res.querySelectorAll('[data-a]')], i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[Math.min(i + 1, btns.length - 1)]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) q.focus(); else btns[i - 1].focus(); }
      if (e.key === 'Escape') { close(); q.focus(); }
    });
    res.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) pickClient(b.dataset.a); });
    box.addEventListener('focusout', () => setTimeout(() => { if (!box.contains(document.activeElement)) close(); }, 150));
  }

  async function pickClient(id, { quiet = false } = {}) {
    try {
      state.who = await api.get(`/pos/client/${id}`);
      state.receiptEmail = ''; state.receipt = null;
    } catch (err) { if (!quiet) toastError(err); state.who = null; }
    if (!ctx.isCurrent()) return;
    persist(); renderWho(); renderPlans(); renderSale();
  }

  function renderPlans() {
    const box = $('#pos-plans');
    if (!box) return;
    const has = state.who?.membership;
    mount(box, plans.map((p) => html`<button type="button" class="pos-tile" data-plan="${p.id}" data-name="${p.name.toLowerCase()}" ${has ? raw('aria-disabled="true"') : ''}>
      <span class="n">${p.name}</span><span class="p">${money(p.price_cents)}<span class="small muted" style="font:400 13px var(--font-sans)"> /month</span></span>
      <span class="small muted">${has ? `${state.who.first_name} already has ${has.plan_name}` : planInfo(p)}</span></button>`));
    applyFind();
  }

  function applyFind() {
    const term = ($('#pos-find')?.value || '').trim().toLowerCase();
    let shown = 0;
    ctx.el.querySelectorAll('.pos-tile[data-name]').forEach((t) => { t.hidden = !!term && !t.dataset.name.includes(term); if (!t.hidden) shown++; });
    $('#pos-nomatch').hidden = !term || shown > 0;
  }

  function renderBadges() {
    ctx.el.querySelectorAll('#pos-tiles [data-p]').forEach((t) => {
      const n = state.cart.filter((c) => c.product_id === +t.dataset.p).reduce((a, c) => a + c.qty, 0);
      const b = t.querySelector('.in'); b.hidden = !n; b.textContent = n ? String(n) : '';
      t.setAttribute('aria-label', `${t.querySelector('.n').textContent}, ${t.querySelector('.p').textContent}${n ? `, ${n} in the sale` : ''}`);
    });
  }

  function renderBar() {
    const n = state.cart.reduce((a, c) => a + c.qty, 0);
    $('#pos-bar').hidden = !n || barHidden;
    $('.pos-page').classList.toggle('has-bar', !!n);
    $('#bar-n').textContent = plural(n, 'item');
    $('#bar-t').textContent = money(total());
  }

  function renderSale() {
    const l = loc(), who = state.who, cardsOk = !!l?.cards_ready, rd = locReaders();
    const opts = [
      { v: 'tap', t: 'Tap to Pay on iPhone', s: mode === 'test' ? 'Client taps their card or phone. Simulated in test mode.' : 'Client taps their card or phone on your iPhone.', ok: cardsOk },
      { v: 'reader', t: 'Front-desk reader', s: rd.length ? `Sends the charge to ${rd[0].label}.` : `No reader at ${l?.name || 'this location'}.`, ok: cardsOk && rd.length > 0 },
      { v: 'card', t: 'Card on file', s: who?.card ? `${who.card.brand} ••${who.card.last4}` : who ? 'No saved card for this family.' : 'Choose a client with a saved card.', ok: cardsOk && !!who?.card },
      { v: 'cash', t: 'Cash', s: 'Record a cash payment.', ok: true },
    ];
    if (!opts.find((o) => o.v === state.method)?.ok) state.method = opts.find((o) => o.ok).v;
    const canSave = (state.method === 'tap' || state.method === 'reader') && who?.family_id;
    const sub = subtotal(), off = discountCents(), tot = total(), d = state.discount;
    const offBad = off > 0 && off >= sub;
    const tendered = state.tendered ? toCents(state.tendered) : NaN, change = tendered - tot;
    const email = state.receiptEmail || who?.email || '';
    // Receipts go out by default when there's an email to send to (unless turned off on this device); walk-ins opt in.
    const receiptOn = state.receipt ?? (!!who?.email && pref.get('dp-pos-receipt') !== '0');
    mount($('#sale'), html`<div class="spread"><h2 class="panel-title">Sale</h2>
        ${state.cart.length ? html`<button type="button" class="btn btn-ghost btn-sm" id="clear">Clear sale</button>` : ''}</div>
      ${state.last ? html`<div class="pos-done stack-sm" role="status"><div><span class="strong">${money(state.last.total_cents)} paid</span> · ${state.last.who}${state.last.receipt_to ? html`<br><span class="small">Receipt sent to ${state.last.receipt_to}</span>` : ''}</div>
        <div class="btn-row">${state.last.receipt_to ? '' : html`<button type="button" class="btn btn-sm" id="last-receipt">Email receipt</button>`}
          ${state.last.can_undo ? html`<button type="button" class="btn btn-sm" id="last-undo">Undo sale</button>` : ''}</div></div>` : ''}
      ${state.cart.length ? html`<div>${state.cart.map((c, i) => html`<div class="pos-line">
        <div style="flex:1;min-width:0"><div>${c.name}</div><div class="small muted">${money(c.price_cents)} each</div></div>
        <div class="pos-qty"><button type="button" data-dec="${i}" aria-label="${c.qty === 1 ? `Remove ${c.name}` : `One fewer ${c.name}`}">−</button><span>${c.qty}</span><button type="button" data-inc="${i}" aria-label="One more ${c.name}">+</button></div>
        <div style="min-width:64px;text-align:right" class="strong">${money(c.price_cents * c.qty)}</div></div>`)}</div>
        ${d ? html`<div class="stack-sm" style="border-top:1px solid var(--line-subtle);padding-top:12px">
          <div class="spread"><span class="label" id="disc-l">Discount</span><button type="button" class="btn btn-ghost btn-sm" id="disc-rm">Remove discount</button></div>
          <div class="row" style="flex-wrap:nowrap;gap:8px">
            <div class="seg" role="group" aria-labelledby="disc-l"><button type="button" data-dt="pct" aria-pressed="${d.type === 'pct' ? 'true' : 'false'}" aria-label="Percent off">%</button><button type="button" data-dt="amount" aria-pressed="${d.type === 'amount' ? 'true' : 'false'}" aria-label="Dollars off">$</button></div>
            <input class="input" id="disc-v" inputmode="decimal" value="${d.value ?? ''}" placeholder="${d.type === 'pct' ? '10' : '5.00'}" aria-label="${d.type === 'pct' ? 'Percent off' : 'Dollars off'}" style="width:84px">
            <input class="input" id="disc-r" value="${d.reason || ''}" placeholder="Reason (optional)" aria-label="Reason for the discount" maxlength="60" style="flex:1;min-width:0"></div>
          ${offBad ? html`<span class="hint warn-text">A discount has to leave something to pay.</span>` : ''}</div>`
        : html`<div><button type="button" class="btn btn-ghost btn-sm" id="disc-add">Add discount</button></div>`}`
        : html`<p class="muted" style="margin:0">Tap a product to add it.</p>`}
      ${off > 0 ? html`<div class="stack-sm"><div class="pos-sum small"><span class="muted">Subtotal</span><span>${money(sub)}</span></div>
        <div class="pos-sum small"><span class="muted">Discount</span><span>−${money(Math.min(off, sub))}</span></div></div>` : ''}
      <div class="pos-total"><span class="muted">Total</span><span class="v" id="sale-total">${money(Math.max(0, tot))}</span></div>
      <div class="stack-sm" role="radiogroup" aria-label="Payment"><span class="label">Payment</span>
        ${opts.map((o) => html`<label class="pay-opt"><input type="radio" name="pm" value="${o.v}" ${o.v === state.method ? raw('checked') : ''} ${o.ok ? '' : raw('disabled')}>
          <span><span class="strong">${o.t}</span><br><span class="small muted">${o.s}</span></span></label>`)}
      </div>
      ${state.method === 'cash' && state.cart.length ? html`<div class="field"><label class="label" for="tendered">Cash received ($)</label>
        <input class="input" id="tendered" inputmode="decimal" value="${state.tendered}" placeholder="${(Math.max(0, tot) / 100).toFixed(2)}">
        <span class="hint ${change < 0 ? 'warn-text' : ''}" id="change" aria-live="polite">${Number.isFinite(change) ? (change >= 0 ? `Change due: ${money(change, { always2: true })}` : `${money(-change, { always2: true })} short`) : 'Optional. Shows the change to hand back.'}</span></div>` : ''}
      ${canSave ? html`<label class="check"><input type="checkbox" id="save-card"><span>Save card to the ${who.family || 'family'} account for their membership</span></label>` : ''}
      ${state.cart.length ? html`<div class="stack-sm"><label class="check"><input type="checkbox" id="rc-on" ${receiptOn ? raw('checked') : ''}><span>Email a receipt</span></label>
        ${receiptOn ? html`<input class="input" id="rc-email" type="email" value="${email}" placeholder="${who ? 'No email on file. Type one' : 'Email address'}" aria-label="Receipt email" autocomplete="off">` : ''}</div>` : ''}
      <button class="btn btn-primary btn-lg btn-block" id="charge" ${state.cart.length && l && !offBad && tot > 0 ? '' : raw('disabled')}>${state.method === 'cash' ? `Record ${money(Math.max(0, tot))} cash` : `Charge ${money(Math.max(0, tot))}`}</button>`);
    renderBadges(); renderBar();
  }

  // ---- today's takings (owners and front desk) ----
  async function renderToday() {
    const box = $('#today');
    if (!box) return;
    const scope = pref.get('dp-pos-today-scope') === 'all' ? 'all' : 'here';
    const l = loc();
    const qs = scope === 'here' && l ? `?location_id=${l.id}` : '';
    let d;
    try { d = await api.get('/sales/summary' + qs); } catch (err) { mount(box, html`<p class="warn-text" style="margin:0">Couldn't load today's takings. ${err.message}</p>`); return; }
    if (!ctx.isCurrent()) return;
    const cardRows = d.by_method.filter((m) => m.method !== 'cash');
    const cards = cardRows.reduce((n, m) => n + m.net_cents, 0), cardCount = cardRows.reduce((n, m) => n + m.count, 0);
    const cash = d.by_method.find((m) => m.method === 'cash');
    mount(box, html`<div class="spread"><div><h2 class="panel-title">Today${scope === 'here' && l ? ` at ${l.name}` : ' at all locations'}</h2>
        <p class="panel-sub">${d.count ? `${plural(d.count, 'sale')}, net of refunds. Count the cash drawer against Cash.` : 'No sales yet today.'}</p></div>
        ${locations.length > 1 ? html`<div class="seg" role="group" aria-label="Takings for"><button type="button" data-scope="here" aria-pressed="${scope === 'here' ? 'true' : 'false'}">This location</button><button type="button" data-scope="all" aria-pressed="${scope === 'all' ? 'true' : 'false'}">All locations</button></div>` : ''}</div>
      <div class="pos-metrics">
        <div class="pos-metric"><div class="small muted">Net taken</div><div class="v">${money(d.net_cents)}</div></div>
        <div class="pos-metric"><div class="small muted">Cash</div><div class="v">${money(cash.net_cents)}</div><div class="small muted">${plural(cash.count, 'sale')}</div></div>
        <div class="pos-metric"><div class="small muted">Cards</div><div class="v">${money(cards)}</div><div class="small muted">${plural(cardCount, 'sale')}</div></div>
        <div class="pos-metric"><div class="small muted">Refunds</div><div class="v ${d.refunded_cents ? 'warn-text' : ''}">${money(d.refunded_cents)}</div>${d.discount_cents ? html`<div class="small muted">${money(d.discount_cents)} in discounts</div>` : ''}</div>
      </div>`);
    box.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => { pref.set('dp-pos-today-scope', b.dataset.scope); renderToday(); }));
  }

  // ---- recent sales with filters ----
  let recent = [];
  async function renderRecent() {
    const qs = new URLSearchParams({ days: state.period });
    if (state.q) qs.set('q', state.q);
    if (state.histLoc) qs.set('location_id', state.histLoc);
    const box = $('#rs-list');
    try { recent = await api.get('/sales?' + qs); } catch (err) { mount(box, html`<p class="warn-text" style="margin:0">Couldn't load sales. ${err.message}</p>`); return; }
    if (!ctx.isCurrent()) return;
    const period = state.period === 1 ? 'Today' : `Last ${state.period} days`;
    $('#rs-sub').textContent = `${period}${coach ? ', sales you took' : ''}. Tap a sale for details${owner ? ', receipts and refunds' : ' and receipts'}.`;
    ctx.el.querySelectorAll('[data-days]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.days === state.period)));
    mount(box, recent.length ? html`<div class="list">${recent.map((s) => html`<div class="list-row pos-row" data-sale="${s.id}" tabindex="0" role="button" aria-label="${s.who}, ${money(s.total_cents)}, ${s.status.replace('_', ' ')}. Open details">
        <div class="grow"><div class="strong">${s.who} · ${money(s.total_cents)}${s.refunded_cents ? html` <span class="muted small">(${money(s.refunded_cents)} refunded)</span>` : ''}</div>
          <div class="small muted">${itemText(s.items)}${s.discount_cents ? ` · ${money(s.discount_cents)} off` : ''} · ${s.location || 'No location'} · ${s.method_label}${s.card_last4 ? ` ••${s.card_last4}` : ''} · ${relTime(s.created_at)}${s.staff && !coach ? ` · ${s.staff}` : ''}</div></div>
        ${saleBadge(s.status)}
      </div>`)}</div>`
      : html`<p class="muted" style="margin:0">${state.q ? `No sales match "${state.q}".` : `No sales ${state.period === 1 ? 'yet today' : `in the last ${state.period} days`}${state.histLoc ? ' at this location' : ''}.`}</p>`);
  }
  const openSale = (id) => saleModal(recent.find((s) => s.id === +id), { owner, coach, after: () => { renderRecent(); renderToday(); } });
  $('#rs-list').addEventListener('click', (e) => { const r = e.target.closest('[data-sale]'); if (r) openSale(r.dataset.sale); });
  $('#rs-list').addEventListener('keydown', (e) => { const r = e.target.closest('[data-sale]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSale(r.dataset.sale); } });
  ctx.el.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => { state.period = +b.dataset.days; renderRecent(); }));
  $('#rs-q').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); renderRecent(); }, 250));
  $('#rs-loc')?.addEventListener('change', (e) => { state.histLoc = e.target.value; renderRecent(); });

  function add(line) {
    const i = state.cart.findIndex((c) => (line.product_id ? c.product_id === line.product_id : false));
    if (i >= 0) state.cart[i].qty = Math.min(99, state.cart[i].qty + 1); else state.cart.push({ ...line, qty: 1 });
    state.last = null;
    persist(); renderSale();
  }

  $('#pos-loc').addEventListener('change', (e) => { state.location = +e.target.value; pref.set('dp-pos-location', e.target.value); renderLocHint(); renderSale(); renderToday(); });
  $('#pos-find')?.addEventListener('input', applyFind);
  ctx.el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
    const p = products.find((x) => x.id === +b.dataset.p);
    add({ product_id: p.id, name: p.name, price_cents: p.price_cents, kind: p.kind });
  }));
  $('#pos-plans')?.addEventListener('click', (e) => { const b = e.target.closest('[data-plan]'); if (b) sellMembership(plans.find((x) => x.id === +b.dataset.plan)); });

  // Memberships are sold on their own: they need a client, and the card is saved to bill every month.
  async function sellMembership(plan) {
    const who = state.who, l = loc(), rd = locReaders();
    if (!who) { toast('Choose who the membership is for first.', 'warn'); $('#who-q')?.focus(); return; }
    if (who.membership) { toast(`${who.first_name} already has ${who.membership.plan_name}. Change it on their client profile.`, 'warn'); return; }
    if (!who.family_id) { toast(`${who.first_name} has no family account to bill. Add them as a client with a parent first.`, 'warn'); return; }
    if (!l?.cards_ready) { toast(`Card payments need an address for ${l?.name || 'this location'}. Add one in setup.`, 'warn'); return; }
    const methods = [
      who.card ? { v: 'card', t: `Card on file (${who.card.brand} ••${who.card.last4})` } : null,
      { v: 'tap', t: 'Tap to Pay on iPhone' },
      rd.length ? { v: 'reader', t: `Front-desk reader (${rd[0].label})` } : null,
    ].filter(Boolean);
    const first = plan.trial_days ? `Free for ${plural(plan.trial_days, 'day')}, then ${money(plan.price_cents)} every month.` : `${money(plan.price_cents)} today, then every month.`;
    const r = await modal({
      title: `Start ${plan.name}`,
      body: html`<p style="margin:0"><span class="strong">${who.first_name} ${who.last_name}</span> · ${planInfo(plan)}</p>
        <p class="display" style="font-size:32px;margin:0">${money(plan.price_cents)}<span class="muted" style="font-size:16px"> /month</span></p>
        <p style="margin:0">${first}</p>
        <fieldset><legend>Card to bill each month</legend>
          ${methods.map((m, i) => html`<label class="pay-opt"><input type="radio" name="mm" value="${m.v}" ${i === 0 ? raw('checked') : ''}><span>${m.t}</span></label>`)}
        </fieldset>
        <p class="hint" style="margin:0">A tapped card is saved to the ${who.family || 'family'} account for the monthly charge.${mode === 'test' ? ' Test mode: the card is simulated as Visa ••4242.' : ''}</p>
        <div class="error" id="mm-err" role="alert"></div>`,
      actions: [{ label: 'Cancel', value: null }, { label: plan.trial_days ? 'Start free trial' : `Charge ${money(plan.price_cents)}`, kind: 'primary', onClick: async (body) => {
        const method = body.querySelector('input[name=mm]:checked').value;
        try { return await api.post('/sales/membership', { location_id: state.location, athlete_id: who.id, plan_id: plan.id, method }); }
        catch (e) { body.querySelector('#mm-err').textContent = e.message; return false; }
      } }],
    });
    if (!r) return;
    toast(r.message);
    await pickClient(who.id, { quiet: true });
  }

  $('#custom').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, cents = toCents(f.amount.value);
    if (!(cents > 0)) { toast('Enter an amount above $0.', 'warn'); f.amount.focus(); return; }
    if (cents > 1000000) { toast('Custom amounts go up to $10,000.', 'warn'); f.amount.focus(); return; }
    add({ name: f.name.value.trim() || 'Custom amount', price_cents: cents, custom: ++state.seq });
    f.reset(); f.name.focus();
  });

  const sale = $('#sale');
  sale.addEventListener('click', async (e) => {
    const t = e.target;
    const inc = t.closest('[data-inc]'), dec = t.closest('[data-dec]');
    if (inc) { const c = state.cart[+inc.dataset.inc]; c.qty = Math.min(99, c.qty + 1); persist(); renderSale(); sale.querySelector(`[data-inc="${inc.dataset.inc}"]`)?.focus(); return; }
    if (dec) {
      const i = +dec.dataset.dec, c = state.cart[i];
      if (--c.qty <= 0) state.cart.splice(i, 1);
      if (!state.cart.length) state.discount = null;
      persist(); renderSale();
      (sale.querySelector(`[data-dec="${Math.min(i, state.cart.length - 1)}"]`) || sale.querySelector('#charge'))?.focus();
      return;
    }
    if (t.closest('#clear')) {
      const keep = { cart: state.cart, discount: state.discount };
      state.cart = []; state.discount = null; state.tendered = ''; persist(); renderSale();
      undoToast('Sale cleared.', () => { Object.assign(state, keep); persist(); renderSale(); });
      return;
    }
    if (t.closest('#disc-add')) { state.discount = { type: 'pct', value: '', reason: '' }; renderSale(); sale.querySelector('#disc-v')?.focus(); return; }
    if (t.closest('#disc-rm')) { state.discount = null; persist(); renderSale(); return; }
    const dt = t.closest('[data-dt]');
    if (dt) { state.discount.type = dt.dataset.dt; state.discount.value = ''; persist(); renderSale(); sale.querySelector('#disc-v')?.focus(); return; }
    if (t.closest('#last-receipt')) return lastReceipt();
    if (t.closest('#last-undo')) return undoLast();
    if (t.closest('#charge')) charge(t.closest('#charge'));
  });
  // Typing in the discount, cash or email fields updates the totals without losing your place.
  sale.addEventListener('input', (e) => {
    if (e.target.id === 'disc-v' || e.target.id === 'disc-r') {
      state.discount[e.target.id === 'disc-v' ? 'value' : 'reason'] = e.target.value; persist();
      if (e.target.id === 'disc-v') refreshTotals();
    }
    if (e.target.id === 'tendered') { state.tendered = e.target.value; refreshTotals(); }
    if (e.target.id === 'rc-email') state.receiptEmail = e.target.value;
  });
  sale.addEventListener('change', (e) => {
    if (e.target.name === 'pm') { state.method = e.target.value; renderSale(); }
    if (e.target.id === 'rc-on') { state.receipt = e.target.checked; if (state.who?.email) pref.set('dp-pos-receipt', state.receipt ? '1' : '0'); renderSale(); if (state.receipt) sale.querySelector('#rc-email')?.focus(); }
  });
  function refreshTotals() {
    const id = document.activeElement?.id, pos = document.activeElement?.selectionStart;
    renderSale();
    const el = id && sale.querySelector('#' + id);
    if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* not a text field */ } }
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
    setTimeout(() => t.remove(), 6000);
  }

  async function charge(btn) {
    const tot = total(), amount = money(tot);
    const saveCard = !!$('#save-card')?.checked;
    const emailReceipt = !!sale.querySelector('#rc-on')?.checked && state.cart.length > 0;
    const to = (sale.querySelector('#rc-email')?.value || '').trim();
    if (emailReceipt && !EMAIL_RE.test(to)) { toast(to ? 'That email address doesn\'t look right.' : 'Type an email for the receipt, or untick Email a receipt.', 'warn'); sale.querySelector('#rc-email')?.focus(); return; }
    if (state.method === 'cash' && state.tendered && toCents(state.tendered) < tot) { toast(`Cash received is short of ${amount}.`, 'warn'); sale.querySelector('#tendered')?.focus(); return; }
    if (state.method === 'tap' || state.method === 'reader') {
      const rd = locReaders()[0];
      const ok = await modal({
        title: state.method === 'tap' ? 'Tap to Pay' : 'Front-desk reader',
        body: html`<p class="display" style="font-size:40px;margin:0;text-align:center">${amount}</p>
          <p style="margin:0;text-align:center">${state.method === 'tap' ? 'Hand over the iPhone. The client taps their card or phone near the top.' : `The charge is on ${rd?.label || 'the reader'}. The client taps or inserts their card.`}</p>
          ${mode === 'test' ? html`<p class="small muted" style="margin:0;text-align:center">Test mode: the card is simulated as Visa ••4242.</p>` : ''}`,
        actions: [{ label: 'Cancel', value: false }, { label: mode === 'test' ? 'Simulate card tap' : 'Card presented', value: true, kind: 'primary' }],
      });
      if (!ok) return;
    }
    btn.disabled = true;
    btn.textContent = state.method === 'cash' ? 'Recording…' : 'Charging…';
    try {
      const d = state.discount && Number(state.discount.value) > 0
        ? { type: state.discount.type, value: state.discount.type === 'pct' ? Number(state.discount.value) : toCents(state.discount.value), reason: state.discount.reason } : null;
      const r = await api.post('/sales', {
        location_id: state.location, athlete_id: state.who?.id || null, method: state.method, save_card: saveCard, discount: d,
        email_receipt: emailReceipt, receipt_email: emailReceipt ? to : undefined,
        items: state.cart.map((c) => (c.product_id ? { product_id: c.product_id, qty: c.qty } : { name: c.name, price_cents: c.price_cents, qty: c.qty })),
      });
      toast(r.message);
      const change = state.method === 'cash' && state.tendered ? toCents(state.tendered) - tot : 0;
      if (change > 0) toast(`Hand back ${money(change, { always2: true })} change.`);
      state.cart = []; state.discount = null; state.tendered = ''; state.receipt = null;
      state.last = { ...r.sale, receipt_to: r.receipt_to };
      if (state.who) await pickClient(state.who.id, { quiet: true }); else { persist(); renderSale(); }
      renderRecent(); renderToday();
    } catch (err) { toastError(err); renderSale(); }
  }

  async function lastReceipt() {
    const s = state.last;
    const r = await receiptModal(s, s.receipt_email || state.who?.email || '');
    if (r) { state.last = { ...s, receipt_to: r.email }; renderSale(); renderRecent(); }
  }
  async function undoLast() {
    const s = state.last;
    if (!(await confirmDialog('Undo this sale?', `${money(s.total_cents)} for ${itemText(s.items) || 'this sale'} is refunded in full${s.method === 'cash' ? '. Hand the cash back' : ' to the card'}. Any pack sessions it added are taken back.`, 'Undo sale', 'warn'))) return;
    try {
      const r = await api.post(`/sales/${s.id}/undo`);
      toast(r.message); state.last = null;
      if (state.who) await pickClient(state.who.id, { quiet: true }); else renderSale();
      renderRecent(); renderToday();
    } catch (err) { toastError(err); }
  }

  // Phone: a bar with the running total that jumps to the sale; it hides while the sale panel is on screen.
  $('#bar-go').addEventListener('click', () => { $('#sale').scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => $('#charge')?.focus({ preventScroll: true }), 450); });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([en]) => { if (!ctx.isCurrent()) return io.disconnect(); barHidden = en.isIntersecting; renderBar(); }, { threshold: 0.2 });
    io.observe($('#sale'));
  }

  renderLocHint(); renderPlans(); renderWho(); renderSale(); renderRecent(); renderToday();
  // Sell to a client from their profile (?athlete=ID), or pick the sale back up after leaving the screen.
  if (ctx.query?.athlete) await pickClient(ctx.query.athlete);
  else if (saved?.who) await pickClient(saved.who, { quiet: true });
}

async function receiptModal(s, email) {
  return modal({
    title: s.receipt_sent_at ? 'Email the receipt again' : 'Email a receipt',
    body: html`<p style="margin:0">${s.who} · ${money(s.total_cents)} · ${itemText(s.items)}</p>
      <div class="field"><label class="label" for="rc-to">Email</label><input class="input" id="rc-to" type="email" value="${email || ''}" autocomplete="off" placeholder="name@example.com"></div>
      <div class="error" id="rc-err" role="alert"></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Send receipt', kind: 'primary', onClick: async (body) => {
      try { const r = await api.post(`/sales/${s.id}/receipt`, { email: body.querySelector('#rc-to').value }); toast(r.message); return r; }
      catch (e) { body.querySelector('#rc-err').textContent = e.message; return false; }
    } }],
  });
}

// Everything about one sale, with receipt, undo and refund.
async function saleModal(s, { owner, coach, after }) {
  if (!s) return;
  const refundable = owner && (s.status === 'paid' || s.status === 'partial_refund');
  const choice = await modal({
    title: `${s.who} · ${money(s.total_cents)}`,
    body: html`<div class="spread"><span class="small muted">${fmtDateTime(s.created_at)} · ${s.location || 'No location'}${s.staff && !coach ? ` · ${s.staff}` : ''}</span>${saleBadge(s.status)}</div>
      <div class="list">${s.items.map((l) => html`<div class="list-row"><div class="grow">${l.qty > 1 ? `${l.qty} × ` : ''}${l.name}</div><div class="strong">${money(l.price_cents * (l.qty || 1))}</div></div>`)}</div>
      <div class="pos-total"><span class="muted">Paid by ${s.method_label.toLowerCase()}${s.card_last4 ? ` ••${s.card_last4}` : ''}</span><span class="strong">${money(s.total_cents)}</span></div>
      ${s.refunded_cents ? html`<p class="warn-text" style="margin:0">${money(s.refunded_cents)} refunded.</p>` : ''}
      <p class="small muted" style="margin:0">${s.receipt_sent_at ? `Receipt emailed ${relTime(s.receipt_sent_at)}.` : 'No receipt emailed yet.'}${s.athlete_id ? html` <a href="/app/clients/${s.athlete_id}">Open client</a>` : ''}</p>`,
    actions: [
      { label: 'Close', value: null },
      s.status !== 'failed' ? { label: s.receipt_sent_at ? 'Email again' : 'Email receipt', value: 'receipt' } : null,
      s.can_undo ? { label: 'Undo sale', value: 'undo', kind: 'warn' } : null,
      refundable ? { label: 'Refund', value: 'refund', kind: 'warn' } : null,
    ].filter(Boolean),
  });
  if (choice === 'receipt') { if (await receiptModal(s, s.receipt_email)) after(); }
  if (choice === 'refund') refundModal(s, after);
  if (choice === 'undo') {
    if (!(await confirmDialog('Undo this sale?', `${money(s.total_cents)} is refunded in full${s.method === 'cash' ? '. Hand the cash back' : ' to the card'}. Any pack sessions it added are taken back.`, 'Undo sale', 'warn'))) return;
    try { const r = await api.post(`/sales/${s.id}/undo`); toast(r.message); after(); } catch (e) { toastError(e); }
  }
}

async function refundModal(s, after) {
  const left = s.total_cents - s.refunded_cents;
  const r = await modal({
    title: `Refund ${s.who}`,
    body: html`<p style="margin:0">${itemText(s.items)} · ${money(s.total_cents)} by ${s.method_label.toLowerCase()}${s.refunded_cents ? `, ${money(s.refunded_cents)} already refunded` : ''}.</p>
      <div class="field"><label class="label" for="rf-amt">Amount to refund ($)</label><input class="input" id="rf-amt" inputmode="decimal" value="${(left / 100).toFixed(2)}">
        <span class="hint">Up to ${money(left)}. A full refund also takes back any unused pack sessions.${s.method === 'cash' ? ' Hand the cash back.' : ' It goes back to the card.'}</span></div>
      <div class="field"><label class="label" for="rf-why">Reason (optional)</label><input class="input" id="rf-why" maxlength="120" placeholder="Shows in the activity log"></div>
      <div class="error" id="rf-err" role="alert"></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Refund', kind: 'warn', onClick: async (body) => {
      const amt = toCents(body.querySelector('#rf-amt').value);
      if (!(amt > 0)) { body.querySelector('#rf-err').textContent = 'Enter an amount to refund.'; return false; }
      try { return await api.post(`/sales/${s.id}/refund`, { amount_cents: amt, reason: body.querySelector('#rf-why').value }); }
      catch (e) { body.querySelector('#rf-err').textContent = e.message; return false; }
    } }],
  });
  if (r) { toast(r.message); after(); }
}

// ---------------------------------------------------------------- setup
async function renderSetup(ctx) {
  const owner = ctx.me.role === 'owner';
  const [allLocations, allProducts, readers, plans] = await Promise.all([api.get('/locations?all=1'), api.get('/products?all=1'), api.get('/readers'), api.get('/plans')]);
  if (!ctx.isCurrent()) return;
  const mode = ctx.settings?.payments_mode || 'test';
  const locations = allLocations.filter((l) => !l.archived), oldLocations = allLocations.filter((l) => l.archived);
  const products = allProducts.filter((p) => !p.archived), oldProducts = allProducts.filter((p) => p.archived);
  const livePlans = plans.filter((p) => p.active), oldPlans = owner ? plans.filter((p) => !p.active) : [];
  const older = (label, rows) => html`<details><summary class="small muted" style="min-height:44px;display:flex;align-items:center;cursor:pointer">${label}</summary><div class="list">${rows}</div></details>`;
  mount(ctx.el, html`${STYLE}<div class="pos-page pos-set">
    <header class="page-header">
      <div><h1 class="page-title">Point of sale setup</h1><p class="page-sub">Where you train, what you sell and your card readers.</p></div>
      <a class="btn" href="/app/pos">Back to sales</a>
    </header>
    ${!locations.length ? html`<div class="banner">Start with a location. Card payments need its street address.</div>` : ''}
    <div class="grid-2" style="align-items:start">
      <section class="panel">
        <div class="spread"><div><h2 class="panel-title">Locations</h2><p class="panel-sub">Card payments need a street address for each place. For client homes, use one "Mobile" location with your business address.</p></div>
          <button class="btn" id="add-loc">Add location</button></div>
        ${locations.length ? html`<div class="list">${locations.map((l) => html`<div class="list-row"><div class="grow"><div class="strong">${l.name}</div>
          <div class="small muted">${LOC_KIND[l.kind] || l.kind}${l.address ? ` · ${l.address}` : ''}</div></div>
          ${l.cards_ready ? badge('active', 'Cards ready') : badge('at_risk', 'Needs address')}
          <div class="acts"><button class="btn btn-ghost btn-sm" data-edit-loc="${l.id}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-arch-loc="${l.id}">Archive</button></div></div>`)}</div>`
          : html`<p class="muted" style="margin:0">No locations yet.</p>`}
        ${oldLocations.length ? older(`Archived locations (${oldLocations.length})`, oldLocations.map((l) => html`<div class="list-row"><div class="grow"><div>${l.name}</div><div class="small muted">${LOC_KIND[l.kind] || l.kind}${l.address ? ` · ${l.address}` : ''}</div></div>
            <div class="acts"><button class="btn btn-ghost btn-sm" data-restore-loc="${l.id}">Restore</button></div></div>`)) : ''}
      </section>
      <div class="stack">
        <section class="panel">
          <div class="spread"><div><h2 class="panel-title">Products</h2><p class="panel-sub">Sessions and packs add session credits to the client. Monthly memberships bill the family's card every month.</p></div>
            <button class="btn" id="add-prod">Add product</button></div>
          ${livePlans.length ? html`<div class="list">${livePlans.map((p) => html`<div class="list-row"><div class="grow"><div class="strong">${p.name} ${badge('open', 'Monthly')}</div>
            <div class="small muted">${owner ? html`${money(p.price_cents)} a month · ` : ''}${planInfo(p)}${owner ? ` · ${plural(p.subscribers || 0, 'member')}` : ''}</div></div>
            ${owner ? html`<div class="acts"><button class="btn btn-ghost btn-sm" data-plan-edit="${p.id}">Price</button><button class="btn btn-ghost btn-sm" data-plan-stop="${p.id}">Stop selling</button></div>` : ''}</div>`)}</div>` : ''}
          ${products.length ? html`<div class="list">${products.map((p) => html`<div class="list-row"><div class="grow"><div class="strong">${p.name}</div>
            <div class="small muted">${money(p.price_cents)} · ${credit(p) || KIND_LABEL[p.kind]}</div></div>
            <div class="acts"><button class="btn btn-ghost btn-sm" data-edit="${p.id}">Edit</button><button class="btn btn-ghost btn-sm" data-stop="${p.id}">Stop selling</button></div></div>`)}</div>`
            : html`<p class="muted" style="margin:0">No products yet. Add single sessions, packs and gear.</p>`}
          ${oldProducts.length || oldPlans.length ? older(`Stopped selling (${oldProducts.length + oldPlans.length})`, html`${oldPlans.map((p) => html`<div class="list-row"><div class="grow"><div>${p.name} ${badge('open', 'Monthly')}</div><div class="small muted">${money(p.price_cents)} a month · ${planInfo(p)}</div></div>
              <div class="acts"><button class="btn btn-ghost btn-sm" data-plan-restore="${p.id}">Sell again</button></div></div>`)}
            ${oldProducts.map((p) => html`<div class="list-row"><div class="grow"><div>${p.name}</div><div class="small muted">${money(p.price_cents)} · ${credit(p) || KIND_LABEL[p.kind]}</div></div>
              <div class="acts"><button class="btn btn-ghost btn-sm" data-restore="${p.id}">Sell again</button></div></div>`)}`) : ''}
        </section>
        <section class="panel">
          <div class="spread"><div><h2 class="panel-title">Front-desk readers</h2><p class="panel-sub">For a Stripe smart reader (like the S710). Turn it on, connect it to Wi-Fi, and enter the code it shows. A reader takes payments at its own location.</p></div>
            <button class="btn" id="add-reader" ${locations.length ? '' : raw('disabled')}>Register reader</button></div>
          ${readers.length ? html`<div class="list">${readers.map((r) => html`<div class="list-row"><div class="grow"><div class="strong">${r.label}</div>
            <div class="small muted">${r.location || 'No location'} · <span class="mono">${r.serial || ''}</span></div></div>
            <div class="acts"><button class="btn btn-ghost btn-sm" data-del-reader="${r.id}">Remove</button></div></div>`)}</div>` : html`<p class="muted" style="margin:0">No readers yet. Tap to Pay on iPhone works without one.</p>`}
        </section>
      </div>
    </div></div>`);

  const $ = (s) => ctx.el.querySelector(s);
  const on = (sel, fn) => ctx.el.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => fn(b)));
  // A form in a modal: the primary action sends it and shows the server's message inline; Enter submits.
  const formModal = async ({ title, body, label, send, done, onMount }) => {
    const r = await modal({
      title,
      body: html`<form class="stack" novalidate id="fm">${body}<div class="error" id="fm-err" role="alert"></div><button hidden></button></form>`,
      onMount: (el, close) => {
        el.querySelector('#fm').addEventListener('submit', (e) => { e.preventDefault(); el.closest('.modal').querySelector('.btn-primary')?.click(); });
        onMount?.(el, close);
      },
      actions: [{ label: 'Cancel', value: null }, { label, kind: 'primary', onClick: async (el) => {
        try { return await send(formData(el.querySelector('#fm'))); } catch (e) { el.querySelector('#fm-err').textContent = e.message; return false; }
      } }],
    });
    if (r) { toast(done); ctx.reload(); }
  };

  $('#add-loc').addEventListener('click', () => formModal({
    title: 'Add location', label: 'Add location', done: 'Location added.',
    body: html`<div class="form-grid"><div class="field"><label class="label" for="lf-n">Location name</label><input class="input" id="lf-n" name="name" required autofocus></div>
        <div class="field"><label class="label" for="lf-k">Type</label><select class="input" id="lf-k" name="kind"><option value="facility">Facility</option><option value="mobile">Mobile (clients' homes)</option><option value="park">Park</option></select></div></div>
      <div class="field"><label class="label" for="lf-s">Street address</label><input class="input" id="lf-s" name="street" autocomplete="street-address"></div>
      <div class="form-grid" style="grid-template-columns:2fr 1fr 1fr"><div class="field"><label class="label" for="lf-c">City</label><input class="input" id="lf-c" name="city"></div>
        <div class="field"><label class="label" for="lf-st">State</label><input class="input" id="lf-st" name="state" maxlength="2" placeholder="UT"></div>
        <div class="field"><label class="label" for="lf-z">ZIP</label><input class="input" id="lf-z" name="zip" inputmode="numeric" maxlength="10"></div></div>
      <span class="hint">Leave the address blank to take cash only there for now.</span>`,
    send: (d) => api.post('/locations', d),
  }));

  $('#add-prod').addEventListener('click', () => formModal({
    title: 'Add product', label: 'Add product', done: 'Product added.',
    body: html`<div class="form-grid"><div class="field"><label class="label" for="pf-n">Product name</label><input class="input" id="pf-n" name="name" required autofocus maxlength="80"></div>
        <div class="field"><label class="label" for="pf-k">Type</label><select class="input" id="pf-k" name="kind"><option value="">Choose a type</option>${Object.entries(KIND_LABEL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}
          ${owner ? html`<option value="monthly">Monthly membership</option>` : ''}</select></div></div>
      <div class="form-grid"><div class="field"><label class="label" for="pf-p" id="pf-p-l">Price ($)</label><input class="input" id="pf-p" name="price" inputmode="decimal"></div>
        <div class="field" id="pf-cr-f" hidden><label class="label" for="pf-cr">Sessions in the pack</label><input class="input" id="pf-cr" name="credits" type="number" min="1" max="200" value="10"></div></div>
      <div class="form-grid" id="pf-m" hidden>
        <div class="field"><label class="label" for="pf-g">Group sessions a month</label><input class="input" id="pf-g" name="group_per_month" type="number" min="0" placeholder="Unlimited"><span class="hint">Leave blank for unlimited.</span></div>
        <div class="field"><label class="label" for="pf-pr">Private sessions a month</label><input class="input" id="pf-pr" name="private_per_month" type="number" min="0" value="0"></div>
        <div class="field"><label class="label" for="pf-t">Free trial (days)</label><input class="input" id="pf-t" name="trial_days" type="number" min="0" value="0"><span class="hint">0 charges the first month right away.</span></div>
      </div>`,
    onMount: (el) => {
      const kindSel = el.querySelector('#pf-k');
      kindSel.addEventListener('change', () => {
        const monthly = kindSel.value === 'monthly';
        el.querySelector('#pf-cr-f').hidden = !['group_pack', 'private_pack'].includes(kindSel.value);
        el.querySelector('#pf-m').hidden = !monthly;
        el.querySelector('#pf-p-l').textContent = monthly ? 'Monthly price ($)' : 'Price ($)';
      });
    },
    send: (d) => (d.kind === 'monthly'
      ? api.post('/plans', { name: d.name, price_cents: toCents(d.price), group_per_month: d.group_per_month, private_per_month: d.private_per_month, trial_days: d.trial_days })
      : api.post('/products', { name: d.name, kind: d.kind, price_cents: toCents(d.price), credits: Number(d.credits) })),
  }));

  $('#add-reader').addEventListener('click', () => formModal({
    title: 'Register reader', label: 'Register reader', done: 'Reader registered.',
    body: html`<div class="field"><label class="label" for="rf-c">Registration code</label><input class="input" id="rf-c" name="code" placeholder="three-words-code" autocomplete="off" autofocus>
        <span class="hint">${mode === 'test' ? 'Test mode: use simulated-wpe' : 'Shown on the reader after it connects to Wi-Fi.'}</span></div>
      <div class="form-grid"><div class="field"><label class="label" for="rf-l">Label</label><input class="input" id="rf-l" name="label" placeholder="Front desk"></div>
        <div class="field"><label class="label" for="rf-loc">Location</label><select class="input" id="rf-loc" name="location_id">${options(locations, locations[0]?.id)}</select></div></div>`,
    send: (d) => api.post('/readers', d),
  }));

  on('[data-plan-edit]', (b) => {
    const p = plans.find((x) => x.id === +b.dataset.planEdit);
    formModal({
      title: `Price for ${p.name}`, label: 'Save price', done: 'Price saved.',
      body: html`<div class="field"><label class="label" for="mp">Monthly price ($)</label><input class="input" id="mp" name="price" inputmode="decimal" value="${(p.price_cents / 100).toFixed(2)}" autofocus>
        <span class="hint">Current members pay the new price from their next monthly charge.</span></div>`,
      send: (d) => api.put(`/plans/${p.id}`, { price_cents: toCents(d.price) }),
    });
  });
  on('[data-plan-stop]', async (b) => {
    const p = plans.find((x) => x.id === +b.dataset.planStop);
    if (!(await confirmDialog(`Stop selling ${p.name}?`, 'New families can no longer start it. Current members keep it until you change or cancel their membership. You can sell it again later.', 'Stop selling', 'warn'))) return;
    try { await api.put(`/plans/${p.id}`, { active: false }); toast(`${p.name} is no longer for sale.`); ctx.reload(); } catch (e) { toastError(e); }
  });
  on('[data-plan-restore]', async (b) => {
    const p = plans.find((x) => x.id === +b.dataset.planRestore);
    try { await api.put(`/plans/${p.id}`, { active: true }); toast(`${p.name} is for sale again.`); ctx.reload(); } catch (e) { toastError(e); }
  });

  on('[data-arch-loc]', async (b) => {
    const l = locations.find((x) => x.id === +b.dataset.archLoc);
    if (!(await confirmDialog(`Archive ${l.name}?`, 'It stops showing in Point of sale and new classes. Past sales keep it. You can restore it later.', 'Archive', 'warn'))) return;
    try { await api.put(`/locations/${l.id}`, { archived: true }); toast(`${l.name} archived.`); ctx.reload(); } catch (e) { toastError(e); }
  });
  on('[data-restore-loc]', async (b) => {
    const l = oldLocations.find((x) => x.id === +b.dataset.restoreLoc);
    try { await api.put(`/locations/${l.id}`, { archived: false }); toast(`${l.name} restored.`); ctx.reload(); } catch (e) { toastError(e); }
  });
  on('[data-edit-loc]', (b) => {
    const l = locations.find((x) => x.id === +b.dataset.editLoc);
    formModal({
      title: `Edit ${l.name}`, label: 'Save location', done: 'Location saved.',
      body: html`<div class="field"><label class="label" for="el-n">Name</label><input class="input" id="el-n" name="name" value="${l.name}"></div>
        <div class="field"><label class="label" for="el-k">Type</label><select class="input" id="el-k" name="kind">${Object.entries(LOC_KIND).filter(([k]) => k !== 'school' || l.kind === 'school').map(([k, v]) => html`<option value="${k}" ${k === l.kind ? raw('selected') : ''}>${v}</option>`)}</select></div>
        <div class="field"><label class="label" for="el-a">Full address</label><input class="input" id="el-a" name="address" value="${l.address || ''}" placeholder="Street, City, ST ZIP"><span class="hint">Card payments need an address.</span></div>`,
      send: (d) => api.put(`/locations/${l.id}`, d),
    });
  });
  on('[data-edit]', (b) => {
    const p = products.find((x) => x.id === +b.dataset.edit);
    const pack = p.kind === 'group_pack' || p.kind === 'private_pack';
    formModal({
      title: `Edit ${p.name}`, label: 'Save product', done: 'Product saved.',
      body: html`<div class="field"><label class="label" for="pe-n">Name</label><input class="input" id="pe-n" name="name" value="${p.name}" maxlength="80"></div>
        <div class="form-grid"><div class="field"><label class="label" for="pe-p">Price ($)</label><input class="input" id="pe-p" name="price" inputmode="decimal" value="${(p.price_cents / 100).toFixed(2)}" autofocus>
          <span class="hint">Applies to new sales. Past sales keep their price.</span></div>
          ${pack ? html`<div class="field"><label class="label" for="pe-c">Sessions in the pack</label><input class="input" id="pe-c" name="credits" type="number" min="1" max="200" value="${p.credits}"></div>` : ''}</div>
        <p class="small muted" style="margin:0">${KIND_LABEL[p.kind]}. To sell a different kind of product, add a new one.</p>`,
      send: (d) => api.put(`/products/${p.id}`, { name: d.name, price_cents: toCents(d.price), ...(pack ? { credits: Number(d.credits) } : {}) }),
    });
  });
  on('[data-stop]', async (b) => {
    const p = products.find((x) => x.id === +b.dataset.stop);
    if (!(await confirmDialog(`Stop selling ${p.name}?`, 'It comes off the sale screen and the parent portal. Credits already bought still work. You can sell it again later.', 'Stop selling', 'warn'))) return;
    try { await api.put(`/products/${p.id}`, { archived: true }); toast(`${p.name} is no longer for sale.`); ctx.reload(); } catch (e) { toastError(e); }
  });
  on('[data-restore]', async (b) => {
    const p = oldProducts.find((x) => x.id === +b.dataset.restore);
    try { await api.put(`/products/${p.id}`, { archived: false }); toast(`${p.name} is for sale again.`); ctx.reload(); } catch (e) { toastError(e); }
  });
  on('[data-del-reader]', async (b) => {
    const r = readers.find((x) => x.id === +b.dataset.delReader);
    if (!(await confirmDialog(`Remove ${r.label}?`, 'You can register it again with a new code.', 'Remove', 'warn'))) return;
    try { await api.del(`/readers/${r.id}`); toast('Reader removed.'); ctx.reload(); } catch (e) { toastError(e); }
  });
}

export const routes = [
  { path: '/pos', nav: 'pos', title: 'Point of sale', render: renderPos },
  { path: '/pos/setup', nav: 'pos', title: 'Point of sale setup', roles: ['owner', 'coach'], render: renderSetup },
];
