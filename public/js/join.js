import { h, fill, busy, btn, field, input, select } from './ui.js';

// Public sign-up for new families: parent, athletes, agreement, then an emailed code.
const root = document.getElementById('root');
const state = { athletes: [blankAthlete()] };
function blankAthlete() { return { name: '', birth_date: '', sex: '', sport: '', school: '', medical_notes: '', emergency_name: '', emergency_phone: '' }; }

async function boot() {
  const info = await (await fetch('/portal/api/public/info')).json();
  state.info = info;
  document.title = `Join ${info.business_name}`;
  if (!info.open) return fill(root, h('main', { class: 'p-wrap', style: 'min-height:100vh;justify-content:center' }, logoBlock(), h('div', { class: 'dp-panel stack' },
    h('h1', { class: 'p-title' }, 'Sign-up is closed'), h('p', { class: 'muted' }, `Contact ${info.business_name} to join. Already have an account?`), h('a', { class: 'dp-btn dp-btn--primary dp-btn--block', href: '/parent' }, 'Sign in'))));
  renderForm();
}
const logoBlock = () => h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.', style: 'width:160px;align-self:center' });

function renderForm(error) {
  const p = state.parent ?? { name: '', email: '', phone: '' };
  const pName = input({ autocomplete: 'name', value: p.name, required: true }), pEmail = input({ type: 'email', autocomplete: 'email', inputmode: 'email', value: p.email, required: true }), pPhone = input({ type: 'tel', autocomplete: 'tel', value: p.phone });
  const trap = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', style: 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0' });
  const agree = h('input', { type: 'checkbox', id: 'agree', required: true });
  const err = h('div', { class: 'dp-error', role: 'alert' }, error ?? '');
  const cards = state.athletes.map((a, i) => athleteCard(a, i));
  const submit = btn('Continue', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  const save = () => { state.parent = { name: pName.value, email: pEmail.value, phone: pPhone.value }; };
  fill(root, h('main', { class: 'p-wrap' },
    logoBlock(),
    h('h1', { class: 'p-title', style: 'text-align:center' }, `Join ${state.info.business_name}`),
    h('p', { class: 'muted', style: 'text-align:center;margin:0' }, 'Create your family account in a couple of minutes. You\'ll book sessions, pay and see progress in one place.'),
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); save(); busy(submit, () => start(trap.value, agree.checked, err)); } },
      h('section', { class: 'dp-panel stack' }, h('h2', { class: 'dp-panel-title' }, 'You'), h('p', { class: 'small muted', style: 'margin:0' }, 'The parent or guardian who manages the account.'),
        field('Full name', pName), field('Email', pEmail, 'You\'ll sign in with this email. No password.'), field('Mobile phone', pPhone), trap),
      ...cards,
      btn('+ Add another athlete', () => { save(); readCards(); state.athletes.push(blankAthlete()); renderForm(); }, 'secondary'),
      h('label', { class: 'row small', style: 'gap:10px;align-items:flex-start;min-height:44px' }, agree,
        h('span', null, 'I agree to the ', h('a', { href: '/terms', target: '_blank' }, 'terms of service'), ' and ', h('a', { href: '/privacy', target: '_blank' }, 'privacy policy'), ', and I\'m the parent or legal guardian of the athletes I\'m adding.')),
      err, submit,
      h('p', { class: 'small muted', style: 'text-align:center' }, 'Already have an account? ', h('a', { href: '/parent' }, 'Sign in')))));
  function readCards() { root.querySelectorAll('[data-athlete]').forEach((el) => { const i = Number(el.dataset.athlete); for (const k of Object.keys(state.athletes[i])) { const f = el.querySelector(`[name="${k}"]`); if (f) state.athletes[i][k] = f.value; } }); }
  state.readCards = readCards;
}

function athleteCard(a, i) {
  const f = (k, attrs = {}) => input({ name: k, value: a[k] ?? '', ...attrs });
  const med = h('textarea', { class: 'dp-input', name: 'medical_notes', placeholder: 'Allergies, injuries, medications, anything a coach should know' }); med.value = a.medical_notes ?? '';
  const sex = select([['', 'Prefer not to say'], ['M', 'Male'], ['F', 'Female']], { name: 'sex', value: a.sex ?? '' });
  return h('section', { class: 'dp-panel stack', 'data-athlete': String(i) },
    h('div', { class: 'row' }, h('h2', { class: 'dp-panel-title grow' }, state.athletes.length > 1 ? `Athlete ${i + 1}` : 'Your athlete'),
      state.athletes.length > 1 ? btn('Remove', () => { state.readCards(); state.athletes.splice(i, 1); renderForm(); }, 'ghost') : null),
    field('Athlete\'s full name', f('name', { required: true, autocomplete: 'off' })),
    h('div', { class: 'form-grid' }, field('Birthday', f('birth_date', { type: 'date', required: true, max: new Date().toISOString().slice(0, 10) }), 'Used for age groups.'), field('Sport', f('sport'))),
    h('div', { class: 'form-grid' }, field('School', f('school')), field('Sex', sex, 'Only used for growth estimates.')),
    field('Medical notes (optional)', med),
    h('div', { class: 'form-grid' }, field('Emergency contact', f('emergency_name')), field('Their phone', f('emergency_phone', { type: 'tel' }))));
}

async function start(trap, agreed, errEl) {
  state.readCards();
  errEl.textContent = '';
  if (!agreed) { errEl.textContent = 'Please agree to the terms and privacy policy.'; return; }
  const res = await fetch('/portal/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent: state.parent, athletes: state.athletes, accept_terms: true, website: trap }) });
  const data = await res.json();
  if (!res.ok) { errEl.textContent = data.error?.message ?? 'Something went wrong. Try again.'; return; }
  renderCode(data);
}

function renderCode(started) {
  const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', class: 'dp-input p-code', 'aria-label': 'Six-digit code' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const go = btn('Create my account', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  fill(root, h('main', { class: 'p-wrap', style: 'min-height:100vh;justify-content:center' }, h('form', { class: 'dp-panel stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(go, async () => {
    const res = await fetch('/portal/api/signup/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ signup_id: started.signup_id, code: code.value }) });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error?.message ?? 'That didn\'t work. Try again.'; return; }
    const buy = new URLSearchParams(location.search).get('buy');     // from the store page: land on what they came to buy
    location.href = `/parent?welcome=1${buy && /^(program|course):[\w-]+$/.test(buy) ? `&buy=${encodeURIComponent(buy)}` : ''}`;
  }); } },
    h('h1', { class: 'p-title' }, 'Check your email'),
    h('p', { class: 'muted' }, `We sent a 6-digit code to ${state.parent.email}. It expires in 30 minutes. If you already have an account, we emailed you a sign-in link instead.`),
    started.dev_code ? h('p', { class: 'test-banner' }, `Test mode: your code is ${started.dev_code}`) : null,
    code, err, go, btn('Change my details', () => renderForm(), 'ghost'))));
  code.focus();
}
boot();
