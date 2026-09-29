import { h, fill, money, btn } from './ui.js';

// The printable receipt behind the link in a receipt email. The link itself is the key; there's nothing to sign in to.
const tok = location.pathname.split('/receipt/')[1];
const root = document.getElementById('root');
const signed = (c) => (c < 0 ? `-${money(-c)}` : money(c));

async function load() {
  const res = await fetch(`/receipt-api/${encodeURIComponent(tok ?? '')}`);
  if (!res.ok) return fill(root, h('div', { class: 'dp-panel' }, h('h1', { class: 'p-title' }, 'Receipt not found'), h('p', { class: 'muted' }, 'Check the link in your receipt email, or ask us to send it again.')));
  render(await res.json());
}

function render(r) {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: r.timezone, month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(r.paid_at));
  document.title = `Receipt · ${r.business_name}`;
  const row = (label, cents) => h('tr', null, h('td', { class: 'muted' }, label), h('td', { class: 'amt' }, signed(cents)));
  const paidBy = r.method_label === 'Cash' ? 'cash' : r.card_last4 ? `card ending ${r.card_last4}` : r.method_label.toLowerCase();
  fill(root,
    h('article', { class: 'inv-sheet' },
      h('div', { class: 'inv-head' },
        h('img', { src: '/brand/logo.png', alt: r.business_name }),
        h('div', null, h('div', { class: 'inv-title' }, 'Receipt'),
          h('dl', { class: 'inv-meta' }, h('dt', null, 'Paid'), h('dd', null, when), h('dt', null, 'Receipt'), h('dd', null, r.id),
            h('dt', null, 'Where'), h('dd', { class: 'inv-team' }, r.location_name),
            r.client_name ? [h('dt', null, 'For'), h('dd', { class: 'inv-team' }, r.client_name)] : null))),
      r.status === 'refunded' ? h('div', { class: 'inv-stamp', style: 'color:var(--steel-muted)' }, 'Refunded') : null,
      h('table', { class: 'inv-table' },
        h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', { class: 'amt' }, 'Amount'))),
        h('tbody', null,
          r.items.map((i) => h('tr', null, h('td', null, `${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`), h('td', { class: 'amt' }, money(i.unit_price_cents * i.quantity)))),
          r.discount_cents ? [row('Subtotal', r.subtotal_cents), row(`Discount${r.discount_reason ? ` (${r.discount_reason})` : ''}`, -r.discount_cents)] : null,
          r.fee_cents ? row(r.fee_label || 'Card processing fee', r.fee_cents) : null,
          r.refunded_cents ? row('Refunded', -r.refunded_cents) : null)),
      h('div', { class: 'inv-total' }, h('span', { class: 'muted' }, `Paid by ${paidBy}`), h('b', null, money(r.amount_cents))),
      h('p', { class: 'inv-note' }, `${r.business_name}${r.business_address ? ` · ${r.business_address}` : ''}. Questions about this receipt? Reply to the email it came with.`)),
    h('div', { class: 'inv-actions' }, btn('Print or save as PDF', () => window.print(), 'primary')));
}

load();
