import { h, fill, busy, btn, field, input } from './ui.js';

// Public "Ask about training" form. Link it from the website. Each inquiry becomes a lead on the Leads tab and gets
// a thank-you email with the sign-up link; follow-up emails go out after 2 and 7 days unless the family signs up.
const root = document.getElementById('root');
const logoBlock = () => h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.', style: 'width:160px;align-self:center' });
let info = { business_name: 'Diamond Protocol' };

async function boot() {
  info = await (await fetch('/portal/api/public/info')).json().catch(() => info);
  document.title = `Ask about training · ${info.business_name}`;
  renderForm();
}

function renderForm() {
  const name = input({ autocomplete: 'name', required: true }), email = input({ type: 'email', autocomplete: 'email', inputmode: 'email', required: true }), phone = input({ type: 'tel', autocomplete: 'tel' });
  const athlete = input({ autocomplete: 'off' }), age = input({ inputmode: 'numeric', maxlength: '3' }), sport = input();
  const message = h('textarea', { class: 'dp-input', placeholder: 'Goals, questions, days and times that work for you' });
  const textsOk = h('input', { type: 'checkbox', id: 'texts_ok' });
  const trap = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', style: 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const submit = btn('Send', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  const send = async () => {
    err.textContent = '';
    if (textsOk.checked && !phone.value.trim()) { err.textContent = 'Add your mobile number to get texts, or untick the box.'; return; }
    const res = await fetch('/portal/api/public/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      parent_name: name.value, email: email.value, phone: phone.value, athlete_name: athlete.value, athlete_age: age.value, sport: sport.value, message: message.value, texts_ok: textsOk.checked, website: trap.value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { err.textContent = data.error?.message ?? 'Something went wrong. Try again.'; return; }
    renderThanks(email.value);
  };
  fill(root, h('main', { class: 'p-wrap' },
    logoBlock(),
    h('h1', { class: 'p-title', style: 'text-align:center' }, 'Ask about training'),
    h('p', { class: 'muted', style: 'text-align:center;margin:0' }, `Tell us about your athlete and ${info.business_name} will get back to you with the best way to start.`),
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(submit, send); } },
      h('section', { class: 'dp-panel stack' }, h('h2', { class: 'dp-panel-title' }, 'You'),
        field('Your name', name), field('Email', email), field('Mobile phone (optional)', phone), trap,
        h('label', { class: 'row small', style: 'gap:10px;align-items:flex-start;min-height:44px' }, textsOk,
          h('span', null, `Text me about my question. ${info.business_name} may send up to 2 texts. Msg & data rates may apply. Reply STOP to stop.`))),
      h('section', { class: 'dp-panel stack' }, h('h2', { class: 'dp-panel-title' }, 'Your athlete'),
        field('Athlete\'s name (optional)', athlete),
        h('div', { class: 'form-grid' }, field('Age', age), field('Sport', sport)),
        field('Anything we should know? (optional)', message)),
      err, submit,
      h('p', { class: 'small muted', style: 'text-align:center' }, 'Ready to sign up now? ', h('a', { href: '/join' }, 'Create a family account'), '. Already a member? ', h('a', { href: '/parent' }, 'Sign in')))));
}

function renderThanks(email) {
  fill(root, h('main', { class: 'p-wrap', style: 'min-height:100vh;justify-content:center' }, logoBlock(), h('div', { class: 'dp-panel stack' },
    h('h1', { class: 'p-title' }, 'Thanks! We got your message'),
    h('p', { class: 'muted' }, `We'll be in touch soon. We also emailed ${email} with next steps, including how to book a first evaluation.`),
    h('a', { class: 'dp-btn dp-btn--primary dp-btn--block', href: '/join' }, 'Sign up now'))));
}

boot();
