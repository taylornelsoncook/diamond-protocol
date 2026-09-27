// Public invoice page (/invoice/:token): what a school's athletic director or treasurer sees.
import { html, mount, api, money, toast, toastError, modal } from '/js/ui.js';

const root = document.getElementById('root');
const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const long = (d) => (d ? new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '');
const METHOD = { check: 'check', ach: 'bank transfer', card: 'card', cash: 'cash', other: 'payment' };
// "This invoice is 16 days past due" (due dates are calendar days in the business's time zone).
function pastDue(due) {
  const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const days = Math.max(1, Math.round((today - new Date(due + 'T12:00:00')) / 86400000));
  return `This invoice is ${days} day${days === 1 ? '' : 's'} past due`;
}

async function load() {
  let inv;
  try { inv = await api.get(`/public/invoices/${encodeURIComponent(token)}`); }
  catch (e) {
    mount(root, html`<div class="panel"><h1 class="page-title" style="font-size:24px">Invoice not found</h1>
      <p class="muted" style="margin:0">${e.status === 404 ? 'This link doesn\'t match an invoice. Check the link in your email, or reply to it and we\'ll send a new one.' : e.message}</p></div>`);
    return;
  }
  document.title = `Invoice ${inv.number} · ${inv.from.name}`;
  const b = inv.bill_to || {};
  const paid = inv.status === 'paid', voided = inv.status === 'void';
  mount(root, html`
    <article class="iv" aria-label="Invoice ${inv.number}">
      ${paid ? html`<div class="iv-stamp" aria-label="Paid">PAID<small>${long(inv.paid_at)}${inv.pay_method ? ` · ${METHOD[inv.pay_method] || inv.pay_method}${inv.check_number ? ` #${inv.check_number}` : ''}` : ''}</small></div>` : ''}
      ${voided ? html`<div class="iv-stamp void" aria-label="Void">VOID<small>Nothing is owed</small></div>` : ''}
      <div class="iv-top">
        <img class="iv-logo" src="/img/logo-320.png" alt="${inv.from.name}, built under pressure">
        <div><h1 class="iv-title">Invoice</h1>
          <dl class="iv-meta"><dt>Number</dt><dd>${inv.number}</dd><dt>Issued</dt><dd>${long(inv.issued_at)}</dd>
            ${inv.due_date ? html`<dt>Due</dt><dd>${long(inv.due_date)}</dd>` : ''}${inv.po_number ? html`<dt>PO</dt><dd>${inv.po_number}</dd>` : ''}
            ${b.team ? html`<dt>Team</dt><dd class="iv-team">${b.team}</dd>` : ''}</dl></div>
      </div>
      <div class="iv-parties">
        <div><div class="k">Bill to</div><div class="name">${b.name || ''}</div>${b.attn ? html`<div>Attn: ${b.attn}</div>` : ''}${b.address ? html`<div class="addr">${b.address}</div>` : ''}</div>
        <div><div class="k">From</div><div class="name">${inv.from.name}</div>${inv.from.address ? html`<div class="addr">${inv.from.address.replace(/,\s*(?=[^,]+,\s*[A-Z]{2}\s)/, '\n')}</div>` : ''}</div>
      </div>
      <table class="iv-lines"><thead><tr><th scope="col">Description</th><th scope="col" style="text-align:right">Amount</th></tr></thead>
        <tbody><tr><td>${inv.description || 'Training services'}</td><td class="amt">${money(inv.amount_cents)}</td></tr></tbody></table>
      <div class="iv-due"><span class="k">${paid ? 'Amount paid' : voided ? 'Amount due' : 'Amount due'}</span><span class="v">${voided ? money(0) : money(inv.amount_cents)}</span></div>
      ${paid || voided ? '' : html`<div class="iv-how"><div class="k">How to pay</div>
        ${inv.can_pay_online ? html`<p><span class="iv-how-k">Online:</span> card or bank transfer with the Pay online button below this invoice.</p>` : ''}
        ${inv.pay_instructions ? html`<p><span class="iv-how-k">${inv.can_pay_online ? 'By check:' : 'To pay:'}</span> ${inv.pay_instructions}</p>` : ''}
        <p>Write ${inv.number} on the check memo or payment note so we can match it.</p>
        ${inv.overdue ? html`<p class="warn-text" style="margin-top:8px">${pastDue(inv.due_date)}. Please pay it as soon as you can, or reply to the invoice email if something is holding it up.</p>` : ''}</div>`}
      <p class="iv-note">Questions about this invoice? Reply to the email it came with and we'll help.</p>
    </article>
    <div class="iv-actions no-print">
      ${inv.can_pay_online ? html`<button class="btn btn-primary" id="pay">${inv.payments_mode === 'test' ? 'Simulate online payment (test mode)' : 'Pay online'}</button>` : ''}
      <button class="btn btn-ghost" id="print">Print or save as PDF</button>
    </div>
    ${paid ? html`<p class="iv-note no-print">Paid in full. Thank you. Keep this page or save it as a PDF for your records.</p>` : ''}`);

  document.getElementById('print').onclick = () => window.print();
  const payBtn = document.getElementById('pay');
  if (payBtn) payBtn.onclick = async () => {
    const r = await modal({
      title: 'Pay online',
      body: html`<p style="margin:0">${inv.number} · <span class="strong">${money(inv.amount_cents)}</span></p>
        <div class="field"><span class="label">Pay by</span>
          <label class="check"><input type="radio" name="m" value="card" checked> Card</label>
          <label class="check"><input type="radio" name="m" value="ach"> Bank transfer (ACH)</label></div>
        ${inv.payments_mode === 'test' ? html`<p class="hint" style="margin:0">Test mode: no money moves. The invoice is marked paid so you can see what happens.</p>` : ''}`,
      actions: [{ label: 'Cancel', value: null }, { label: `Pay ${money(inv.amount_cents)}`, kind: 'primary', onClick: async (body) => {
        const method = body.querySelector('input[name=m]:checked').value;
        return api.post(`/public/invoices/${encodeURIComponent(token)}/pay`, { method });
      } }],
    });
    if (!r) return;
    toast('Payment received. Thank you.');
    load().catch(toastError);
  };
}

load().catch(toastError);
