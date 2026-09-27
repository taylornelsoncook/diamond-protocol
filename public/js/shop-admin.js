import { h, toast, busy, btn, field, input, money } from './ui.js';

// Owners: sell a program or athlete course online (the parent portal's Programs tab and the public /shop page).
// `put` is the dashboard's API helper; `info` is the item from GET /v1/shop.
export function saleForm(put, kind, info, onSaved) {
  const on = h('input', { type: 'checkbox', checked: info.for_sale });
  const price = input({ type: 'number', min: '1', max: '1000', step: '1', inputmode: 'decimal', value: info.price_cents ? String(info.price_cents / 100) : '', placeholder: 'e.g. 49', 'aria-label': 'Price in dollars', style: 'width:120px' });
  const status = !info.for_sale ? 'Not for sale yet.'
    : info.listed ? `In the store at ${money(info.price_cents)}.` : `Not in the store yet: ${info.not_listed_because}`;
  return h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const cents = price.value ? Math.round(Number(price.value) * 100) : null;
    const r = await put(`/v1/shop/${kind}s/${info.id}`, { for_sale: on.checked, price_cents: cents });
    toast(r.for_sale ? (r.listed ? `${r.title} is in the store.` : `Saved. ${r.not_listed_because}`) : 'Saved. It\'s not for sale.');
    onSaved?.(r);
  }); } },
    h('p', { class: `small ${info.for_sale && !info.listed ? 'warn-text' : 'muted'}`, style: 'margin:0' }, status),
    h('div', { class: 'row wrap', style: 'gap:12px;align-items:flex-end' },
      field('Price ($)', price),
      h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, on, h('span', null, 'Sell online'))),
    info.sold ? h('p', { class: 'small muted', style: 'margin:0' }, `${info.sold} sold, ${money(info.sold_cents)} in all (refunds taken out).`) : null,
    h('p', { class: 'small muted', style: 'margin:0' }, kind === 'program'
      ? 'Families buy it once with their card and it goes straight into the athlete\'s app, even without a membership. It replaces their current program.'
      : 'Athletes see the course locked until a parent buys it. Athletes you assign it to, and anyone who had started it, keep it open.'),
    h('div', null, btn('Save', null, 'secondary', { type: 'submit' })));
}
