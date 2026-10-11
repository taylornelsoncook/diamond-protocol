import { h, toast, busy, btn, field, input, select, money } from './ui.js';

// Owners: sell a program or athlete course online (the parent portal's Programs tab and the public /shop page).
// `put` is the dashboard's API helper; `info` is the item from GET /v1/shop.
// `get` (optional) fetches the staff list for the coach menu on a program's sales page.
export function saleForm(put, kind, info, onSaved, { get } = {}) {
  const on = h('input', { type: 'checkbox', checked: info.for_sale });
  const price = input({ type: 'number', min: '1', max: '1000', step: '1', inputmode: 'decimal', value: info.price_cents ? String(info.price_cents / 100) : '', placeholder: 'e.g. 49', 'aria-label': 'Price in dollars', style: 'width:120px' });
  const status = !info.for_sale ? 'Not for sale yet.'
    : info.listed ? `In the store at ${money(info.price_cents)}.` : `Not in the store yet: ${info.not_listed_because}`;
  // The sales page (/shop/<id>): a longer pitch, the coach shown with their bio, and a free trial before the charge.
  const program = kind === 'program';
  const pitch = program ? h('textarea', { class: 'dp-input', rows: '5', maxlength: '3000', placeholder: 'Who it\'s for, what changes in 6 weeks, how the weeks build. Blank lines start a new paragraph.', 'aria-label': 'Sales page text' }, info.pitch ?? '') : null;
  const trial = program ? input({ type: 'number', min: '0', max: '30', step: '1', inputmode: 'numeric', value: String(info.trial_days ?? 0), 'aria-label': 'Free trial days', style: 'width:100px' }) : null;
  const coach = program ? select([['', 'Nobody (just the business)']], { 'aria-label': 'Coach shown on the page', value: '' }) : null;
  if (program && get) get('/v1/staff').then((r) => {
    for (const u of r.data.filter((u) => u.active && u.role !== 'front_desk')) coach.append(h('option', { value: u.id }, `${u.name}${u.title ? ` (${u.title})` : ''}${u.bio ? '' : ' · no bio yet'}`));
    coach.value = info.coach_id ?? '';
  }).catch(() => {});
  return h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const cents = price.value ? Math.round(Number(price.value) * 100) : null;
    const extra = program ? { pitch: pitch.value, trial_days: Number(trial.value) || 0, coach_id: coach.value || null } : {};
    const r = await put(`/v1/shop/${kind}s/${info.id}`, { for_sale: on.checked, price_cents: cents, ...extra });
    toast(r.for_sale ? (r.listed ? `${r.title} is in the store.` : `Saved. ${r.not_listed_because}`) : 'Saved. It\'s not for sale.');
    onSaved?.(r);
  }); } },
    h('p', { class: `small ${info.for_sale && !info.listed ? 'warn-text' : 'muted'}`, style: 'margin:0' }, status),
    h('div', { class: 'row wrap', style: 'gap:12px;align-items:flex-end' },
      field('Price ($)', price),
      h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, on, h('span', null, 'Sell online'))),
    program ? field('Sales page text', pitch, 'Shown on the program\'s own page, under the price.') : null,
    program ? h('div', { class: 'row wrap', style: 'gap:12px;align-items:flex-end' },
      field('Free trial (days)', trial, '0 = pay up front. With a trial, the card is charged when it ends unless the family ends it first.'),
      field('Coach on the page', coach, 'Their title, bio and photo come from Settings → Staff.')) : null,
    program && info.listed ? h('p', { class: 'small', style: 'margin:0' }, h('a', { href: `/shop/${encodeURIComponent(info.id)}`, target: '_blank', rel: 'noopener' }, 'See the sales page'), ' · put that link on the website and Instagram.') : null,
    info.sold ? h('p', { class: 'small muted', style: 'margin:0' }, `${info.sold} sold, ${money(info.sold_cents)} in all (refunds taken out).`) : null,
    h('p', { class: 'small muted', style: 'margin:0' }, kind === 'program'
      ? 'Families buy it once with their card and it goes straight into the athlete\'s app, even without a membership. It replaces their current program.'
      : 'Athletes see the course locked until a parent buys it. Athletes you assign it to, and anyone who had started it, keep it open.'),
    h('div', null, btn('Save', null, 'secondary', { type: 'submit' })));
}
