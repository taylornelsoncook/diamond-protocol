import { h, fill, btn, busy, field, input, select, money } from './ui.js';

// The online sales page (owner's ask: "a sales page where people can buy their package or membership online; when they
// purchase it, it prompts them to create their profile"). Pick a membership or a pack, say who's training, confirm the
// email with a code, save the card on Stripe's page, and land signed in on the profile (services/buyonline.js).
// ?item=plan:<id> or product:<id> opens that item; ?coach=<key> picks that coach under "Who helped you?" (a coach's own
// link, from Billing → Online sales by coach); ?order=<id>&session_id=… is Stripe sending the buyer back.
const root = document.getElementById('root');
const q = new URLSearchParams(location.search);
const state = { data: null, item: null, order: null, coach: q.get('coach') };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const classes = (n) => `${n} group class${n === 1 ? '' : 'es'}`;
const longDay = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const logo = () => h('img', { src: '/brand/logo.png', alt: `${state.data?.business_name ?? 'Diamond Protocol'}. Built under pressure.`, style: 'width:160px;align-self:center' });
const page = (...kids) => fill(root, h('main', { class: 'p-wrap' }, logo(), ...kids));
const post = async (path, body) => {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? 'Something went wrong. Try again.');
  return data;
};
const remember = { get: () => { try { return JSON.parse(sessionStorage.getItem('dp_buy') || 'null'); } catch { return null; } }, set: (v) => { try { sessionStorage.setItem('dp_buy', JSON.stringify(v)); } catch { /* private window */ } } };

async function boot() {
  const res = await fetch('/portal/api/public/buy');
  state.data = await res.json().catch(() => null);
  if (!res.ok || !state.data) return page(h('p', { class: 'warn-text' }, 'This page couldn\'t load. Refresh to try again.'));
  document.title = `Memberships and packs · ${state.data.business_name}`;
  if (q.get('order')) return back(q.get('order'));
  if (!state.data.open) return page(h('section', { class: 'dp-panel stack' }, h('h1', { class: 'p-title' }, 'Online buying is closed'),
    h('p', { class: 'muted', style: 'margin:0' }, `Contact ${state.data.business_name} to join, or sign in if you already have an account.`), h('a', { class: 'dp-btn dp-btn--primary dp-btn--block', href: '/client' }, 'Sign in')));
  const pre = q.get('item');
  const found = pre && findItem(pre);
  return found ? checkout(found) : catalog();
}
function findItem(ref) {
  const [kind, id] = String(ref).split(':');
  const x = kind === 'plan' ? state.data.plans.find((p) => p.id === id) : state.data.products.find((p) => p.id === id);
  return x ? { kind, ...x } : null;
}

// What starting a membership today costs, in words (the same quote the counter shows).
function planToday(q) {
  if (q.trial_days) return `Free for ${plural(q.trial_days, 'day')}, then ${money(q.monthly_cents)} a month.`;
  if (!q.charge_now_cents) return `Nothing today; ${money(q.monthly_cents)} on ${longDay(q.next_charge_on)}, then every month.`;
  return q.prorated ? `${money(q.charge_now_cents)} today for the rest of this month, then ${money(q.monthly_cents)} on the 1st of every month.`
    : `${money(q.charge_now_cents)} today, then ${money(q.monthly_cents)} every month.`;
}
function feeLine(place) {
  const f = state.data.fee;
  if (!f[place] || (!f.pct && !f.flat_cents)) return null;
  return `Credit cards add a ${f.pct ? `${f.pct}%` : ''}${f.pct && f.flat_cents ? ' + ' : ''}${f.flat_cents ? money(f.flat_cents) : ''} ${f.label.toLowerCase()}. Debit cards don't.`;
}

function catalog() {
  const d = state.data;
  const planCard = (p) => h('section', { class: 'dp-panel stack' },
    h('div', { class: 'row wrap', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack-tight' },
        h('span', { class: 'small muted', style: 'text-transform:uppercase;letter-spacing:.04em' }, 'Monthly membership'),
        h('h2', { class: 'dp-panel-title', style: 'margin:0' }, p.name),
        h('span', { class: 'small muted' }, p.sessions_per_month ? `${classes(p.sessions_per_month)} a month` : 'Unlimited group classes'),
        p.trial_days ? h('span', { class: 'dp-badge dp-badge--good', style: 'align-self:flex-start' }, `Free for ${p.trial_days} days`) : null),
      h('span', { class: 'p-title', style: 'margin:0;font-size:28px' }, money(p.price_cents), h('span', { class: 'small muted' }, ' /month'))),
    h('p', { class: 'small', style: 'margin:0' }, planToday(p.quote)),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Renews on the 1st of every month until you cancel. Cancel any time from your account.'),
    h('a', { class: 'dp-btn dp-btn--primary', href: `?item=plan:${encodeURIComponent(p.id)}`, onClick: (e) => { e.preventDefault(); checkout({ kind: 'plan', ...p }); } }, p.trial_days ? 'Start free trial' : 'Buy membership'));
  const productCard = (p) => h('section', { class: 'dp-panel stack' },
    h('div', { class: 'row wrap', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack-tight' },
        h('span', { class: 'small muted', style: 'text-transform:uppercase;letter-spacing:.04em' }, p.kind === 'pack' ? `${p.credit_type === 'group' ? 'Group' : 'Private'} session pack` : `${p.credit_type === 'group' ? 'Group' : 'Private'} session`),
        h('h2', { class: 'dp-panel-title', style: 'margin:0' }, p.name),
        h('span', { class: 'small muted' }, [p.sessions ? plural(p.sessions, 'session') : null, p.per_session_cents ? `${money(p.per_session_cents)} a session` : null, p.saves_cents ? `saves ${money(p.saves_cents)}` : null].filter(Boolean).join(' · '))),
      h('span', { class: 'p-title', style: 'margin:0;font-size:28px' }, money(p.price_cents))),
    p.kind === 'pack' ? h('p', { class: 'small muted', style: 'margin:0' }, 'Use them within 12 months of buying. Book in your account.') : null,
    h('a', { class: 'dp-btn dp-btn--primary', href: `?item=product:${encodeURIComponent(p.id)}`, onClick: (e) => { e.preventDefault(); checkout({ kind: 'product', ...p }); } }, 'Buy'));
  const packs = d.products.filter((p) => p.kind === 'pack'), singles = d.products.filter((p) => p.kind === 'session');
  const section = (title, note, items, card) => items.length ? h('div', { class: 'stack' }, h('h2', { class: 'p-title', style: 'font-size:22px;margin:8px 0 0' }, title), note ? h('p', { class: 'small muted', style: 'margin:0' }, note) : null, items.map(card)) : null;
  page(
    h('h1', { class: 'p-title', style: 'text-align:center' }, 'Memberships and session packs'),
    h('p', { class: 'muted', style: 'text-align:center;margin-top:0' }, 'Pick one, pay online, and set up your profile in a couple of minutes.'),
    section('Memberships', feeLine('memberships'), d.plans, planCard),
    section('Session packs', feeLine('store'), packs, productCard),
    section('Single sessions', packs.length ? null : feeLine('store'), singles, productCard),
    !d.plans.length && !d.products.length ? h('p', { class: 'muted', style: 'text-align:center' }, 'Nothing for sale online right now. ', h('a', { href: '/start' }, 'Ask about training'), '.') : null,
    h('p', { class: 'small muted', style: 'text-align:center' }, 'Already have an account? ', h('a', { href: '/client?tab=programs' }, 'Sign in and buy there'), '. Programs you follow from home are in the ', h('a', { href: '/shop' }, 'online store'), '.'));
}

// The buyer's details and the agreements, then the emailed code.
function checkout(item, error) {
  state.item = item;
  history.replaceState(null, '', `?item=${item.kind}:${encodeURIComponent(item.id)}`);
  const d = state.data, plan = item.kind === 'plan';
  const prev = remember.get()?.form ?? {};
  const who = { parent: h('input', { type: 'radio', name: 'who', value: 'parent', checked: prev.self !== true }), self: h('input', { type: 'radio', name: 'who', value: 'self', checked: prev.self === true }) };
  const first = input({ autocomplete: 'off', required: true, value: prev.first_name ?? '' }), last = input({ autocomplete: 'off', required: true, value: prev.last_name ?? '' });
  const name = input({ autocomplete: 'name', value: prev.name ?? '' }), email = input({ type: 'email', autocomplete: 'email', inputmode: 'email', required: true, value: prev.email ?? '' }), phone = input({ type: 'tel', autocomplete: 'tel', value: prev.phone ?? '' });
  const nameField = field('Your full name', name);
  const showName = () => { nameField.hidden = who.self.checked; name.required = !who.self.checked; };
  who.parent.addEventListener('change', showName); who.self.addEventListener('change', showName);
  const trap = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', style: 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0' });
  const skip = plan && item.trial_days ? h('input', { type: 'checkbox' }) : null;
  const terms = h('input', { type: 'checkbox', required: true }), renew = plan ? h('input', { type: 'checkbox', required: true }) : null;
  const today = h('p', { style: 'margin:0' }, plan ? planToday(item.quote) : `${money(item.price_cents)} today.`);
  if (skip) skip.addEventListener('change', () => { today.textContent = planToday(skip.checked && item.quote_paid ? item.quote_paid : item.quote); });
  const fee = feeLine(plan ? 'memberships' : 'store');
  // Who helped you? Every owner and coach, or No one (owner's ask: count the sales coaches make through the page).
  const picked = prev.helped_by ?? (d.coaches.some((c) => c.key === state.coach) ? state.coach : '');
  const helped = select([['', 'Choose one'], ['none', 'No one'], ...d.coaches.map((c) => [c.key, c.name])], { value: picked, required: true });
  const err = h('div', { class: 'dp-error', role: 'alert' }, error ?? '');
  const go = btn('Continue', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  const label = (box, ...text) => h('label', { class: 'row small', style: 'gap:10px;align-items:flex-start;min-height:44px' }, box, h('span', null, ...text));
  page(
    h('a', { href: '/buy', class: 'small', onClick: (e) => { e.preventDefault(); history.replaceState(null, '', '/buy'); catalog(); } }, '‹ Everything for sale'),
    h('section', { class: 'dp-panel stack' },
      h('span', { class: 'small muted', style: 'text-transform:uppercase;letter-spacing:.04em' }, plan ? 'Monthly membership' : item.kind === 'pack' ? 'Session pack' : 'Session'),
      h('h1', { class: 'p-title', style: 'margin:0' }, item.name),
      today,
      plan ? h('p', { class: 'small muted', style: 'margin:0' }, item.sessions_per_month ? `Covers ${classes(item.sessions_per_month)} a month. Sessions left at the end of a month don't carry over.` : 'Covers unlimited group classes.') : null,
      item.kind === 'pack' ? h('p', { class: 'small muted', style: 'margin:0' }, `${plural(item.sessions, 'session')}, to use within 12 months of buying.`) : null,
      fee ? h('p', { class: 'small muted', style: 'margin:0' }, fee) : null,
      skip ? label(skip, `Charge now instead of the ${item.trial_days}-day free trial`) : null),
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(go, () => start()); } },
      h('section', { class: 'dp-panel stack' }, h('h2', { class: 'dp-panel-title' }, 'Who\'s training?'),
        h('div', { class: 'row wrap', style: 'gap:8px 20px' }, label(who.parent, 'My child (I\'m the parent or guardian)'), label(who.self, 'Me (18 or older)')),
        h('div', { class: 'form-grid' }, field('Athlete\'s first name', first), field('Athlete\'s last name', last))),
      h('section', { class: 'dp-panel stack' }, h('h2', { class: 'dp-panel-title' }, 'Your account'),
        nameField, field('Email', email, 'You sign in with this email. We send a code to confirm it.'), field('Mobile phone', phone), trap,
        field('Who helped you?', helped, 'A coach who told you about us or helped you choose. If nobody did, pick No one.')),
      label(terms, 'I agree to the ', h('a', { href: '/terms', target: '_blank' }, 'terms of service'), ' and ', h('a', { href: '/privacy', target: '_blank' }, 'privacy policy'), '.'),
      renew ? label(renew, `I understand this membership renews automatically: ${money(item.price_cents)} is charged to my card on the 1st of every month until I cancel. I can cancel any time from my account; it ends after the month already paid.`) : null,
      err, go,
      h('p', { class: 'small muted', style: 'margin:0;text-align:center' }, 'Your card is saved on Stripe\'s secure page in the next step. We never see the full number.')));
  showName();
  async function start() {
    err.textContent = '';
    const form = { self: who.self.checked, first_name: first.value, last_name: last.value, name: name.value, email: email.value, phone: phone.value, helped_by: helped.value };
    if (!form.helped_by) { err.textContent = 'Tell us who helped you, or choose No one.'; helped.focus(); return; }
    remember.set({ form });
    try {
      const out = await post('/portal/api/buy', { item: `${item.kind}:${item.id}`, self: form.self, athlete: { first_name: form.first_name, last_name: form.last_name },
        buyer: { name: form.self ? undefined : form.name, email: form.email, phone: form.phone }, accept_terms: terms.checked, accept_renewal: renew ? renew.checked : undefined, skip_trial: skip ? skip.checked : undefined, helped_by: form.helped_by, website: trap.value });
      codeStep(out, form.email);
    } catch (e) { err.textContent = e.message; }
  }
}

function codeStep(started, email) {
  const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', class: 'dp-input p-code', 'aria-label': 'Six-digit code' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const go = btn('Continue to the card page', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  page(h('form', { class: 'dp-panel stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(go, async () => {
    try { const out = await post('/portal/api/buy/verify', { order_id: started.order_id, code: code.value }); toCard(out); }
    catch (e2) { err.textContent = e2.message; }
  }); } },
  h('h1', { class: 'p-title' }, 'Check your email'),
  h('p', { class: 'muted', style: 'margin:0' }, `We sent a 6-digit code to ${email}. It expires in 30 minutes. If you already have an account, we emailed you a sign-in link instead.`),
  started.dev_code ? h('p', { class: 'test-banner' }, `Test mode: your code is ${started.dev_code}`) : null,
  code, err, go, btn('Change my details', () => checkout(state.item), 'ghost')));
  code.focus();
}

// Stripe's card page, or in test mode a choice of test cards (there's no card page without Stripe).
function toCard(out) {
  if (out.url) { page(h('p', { class: 'muted', style: 'text-align:center' }, 'Taking you to Stripe\'s secure card page…')); location.href = out.url; return; }
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const sim = (label, body) => btn(label, (e) => busy(e.currentTarget, async () => { err.textContent = ''; try { finished(await post(`/portal/api/buy/${encodeURIComponent(out.order_id)}/simulate`, body)); } catch (e2) { err.textContent = e2.message; } }), 'secondary');
  page(h('section', { class: 'dp-panel stack' }, h('h1', { class: 'p-title' }, 'Add a card'),
    h('p', { class: 'test-banner' }, 'Test mode: Stripe isn\'t connected, so pick a test card.'),
    sim('Test credit card', { funding: 'credit' }), sim('Test debit card', { funding: 'debit' }), sim('A card that declines', { decline: true }), err));
}

// Back from Stripe: finish the order (or offer another card).
async function back(orderId) {
  const anotherCard = h('button', { type: 'button', class: 'dp-btn dp-btn--primary dp-btn--block', onClick: (e) => busy(e.currentTarget, async () => toCard(await post(`/portal/api/buy/${encodeURIComponent(orderId)}/card`))) }, 'Try a card again');
  if (q.get('canceled')) return page(h('section', { class: 'dp-panel stack' }, h('h1', { class: 'p-title' }, 'No card saved'), h('p', { class: 'muted', style: 'margin:0' }, 'You left the card page before saving a card, so nothing was charged.'), anotherCard));
  page(h('p', { class: 'muted', style: 'text-align:center' }, 'Finishing your purchase…'));
  try { finished(await post(`/portal/api/buy/${encodeURIComponent(orderId)}/complete`, { session_id: q.get('session_id') }), orderId); }
  catch (e) { page(h('section', { class: 'dp-panel stack' }, h('h1', { class: 'p-title' }, 'That didn\'t finish'), h('p', { class: 'warn-text', style: 'margin:0' }, e.message), anotherCard)); }
}

function finished(out, orderId = out.order_id) {
  if (out.status === 'declined') {
    return page(h('section', { class: 'dp-panel stack' }, h('h1', { class: 'p-title' }, 'The card didn\'t go through'), h('p', { class: 'warn-text', style: 'margin:0' }, out.error),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Nothing was charged.'),
      h('button', { type: 'button', class: 'dp-btn dp-btn--primary dp-btn--block', onClick: (e) => busy(e.currentTarget, async () => toCard(await post(`/portal/api/buy/${encodeURIComponent(orderId)}/card`))) }, 'Try another card')));
  }
  remember.set(null);
  const s = out.summary ?? {};
  const paid = s.charged_cents ? `${money(s.charged_cents)} charged${s.fee_cents ? ` (including a ${money(s.fee_cents)} card fee)` : ''}; a receipt is on its way.` : s.trial_ends_at ? `Your free trial runs to ${new Date(s.trial_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}; nothing was charged today.` : 'Nothing was charged today.';
  const next = out.signed_in ? out.redirect : '/client?finish=1';
  page(h('section', { class: 'dp-panel stack' },
    h('h1', { class: 'p-title' }, 'You\'re in!'),
    h('p', { style: 'margin:0' }, `${s.item}${s.athlete ? ` for ${s.athlete}` : ''}. ${paid}`),
    s.athlete_id ? h('p', { class: 'small muted', style: 'margin:0' }, `Athlete ID: ${s.athlete_id}`) : null,
    h('p', { style: 'margin:0' }, 'Next, create your profile: sign the waiver (the one thing needed before training), then add a birthday, an emergency contact and anything a coach should know.'),
    h('a', { class: 'dp-btn dp-btn--primary dp-btn--block', href: next }, 'Create my profile')));
  if (out.signed_in) setTimeout(() => { location.href = next; }, 2500);
}

boot();
