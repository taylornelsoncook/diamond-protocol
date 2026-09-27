import { h, fill, toast, money, busy, btn } from './ui.js';

const tok = location.pathname.split('/invoice/')[1];
const root = document.getElementById('root');
const fmt = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

async function load() {
  const res = await fetch(`/invoice-api/${tok}`);
  if (!res.ok) return fill(root, h('div', { class: 'dp-panel' }, h('h1', { class: 'p-title' }, 'Invoice not found'), h('p', { class: 'muted' }, 'Check the link in your email, or contact your coach.')));
  render(await res.json());
}

function render(i) {
  document.title = `Invoice ${i.number} · ${i.from.name}`;
  const paid = i.status === 'paid', voided = i.status === 'void', overdue = i.status === 'overdue';
  const justPaid = new URLSearchParams(location.search).has('paid') && !paid;
  const actions = h('div', { class: 'inv-actions' },
    i.can_pay_online ? btn(`Pay ${money(i.amount_cents)} online`, (e) => busy(e.currentTarget, async () => {
      const r = await fetch(`/invoice-api/${tok}/checkout`, { method: 'POST' }).then((x) => x.json());
      if (r.url) location.href = r.url; else toast(r.error?.message ?? 'Online payment isn\'t available right now.', 'warn');
    }), 'primary') : null,
    i.can_simulate ? btn('Simulate online payment (test mode)', (e) => busy(e.currentTarget, async () => {
      const r = await fetch(`/invoice-api/${tok}/simulate`, { method: 'POST' }).then((x) => x.json()); render(r); toast('Payment recorded.');
    }), 'secondary') : null,
    btn('Print or save as PDF', () => window.print(), 'ghost'));

  fill(root,
    justPaid ? h('div', { class: 'test-banner', role: 'status' }, 'Thanks! Your payment is processing. Bank payments can take a few business days to show as paid.') : null,
    h('article', { class: 'inv-sheet' },
      h('div', { class: 'inv-head' },
        h('img', { src: '/brand/logo.png', alt: i.from.name }),
        h('div', null, h('div', { class: 'inv-title' }, 'Invoice'),
          h('dl', { class: 'inv-meta' }, h('dt', null, 'Number'), h('dd', null, i.number), h('dt', null, 'Issued'), h('dd', null, fmt(i.issued_on)), h('dt', null, 'Due'), h('dd', null, fmt(i.due_on)),
            i.po_number ? [h('dt', null, 'PO'), h('dd', null, i.po_number)] : null))),
      paid ? h('div', { class: 'inv-stamp', style: 'color:var(--green-bright)' }, `Paid ${fmt(i.paid_on)}`) : voided ? h('div', { class: 'inv-stamp', style: 'color:var(--steel-muted)' }, 'Void') : overdue ? h('div', { class: 'inv-stamp', style: 'color:var(--amber)' }, 'Past due') : null,
      h('div', { class: 'inv-parties' },
        h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'Bill to'), h('p', { class: 'strong' }, i.bill_to.name), i.bill_to.contact ? h('p', null, `Attn: ${i.bill_to.contact}`) : null, i.bill_to.address ? h('p', { class: 'muted' }, i.bill_to.address) : null),
        h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'From'), h('p', { class: 'strong' }, i.from.name), i.from.address ? h('p', { class: 'muted' }, i.from.address) : null)),
      h('table', { class: 'inv-table' },
        h('thead', null, h('tr', null, h('th', null, 'Description'), h('th', { class: 'amt' }, 'Amount'))),
        h('tbody', null, i.lines.map((l) => h('tr', null, h('td', null, l.description), h('td', { class: 'amt' }, money(l.amount_cents)))))),
      h('div', { class: 'inv-total' }, h('span', { class: 'muted' }, paid ? 'Paid' : 'Amount due'), h('b', null, money(i.amount_cents))),
      !paid && !voided && i.from.payment_instructions ? h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'How to pay'), h('p', { class: 'muted', style: 'margin:0;white-space:pre-line' }, i.from.payment_instructions)) : null),
    actions);
}

load();
