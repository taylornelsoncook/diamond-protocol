// Hosted card page (test mode). Live mode sends parents to Stripe Checkout instead.
// Only brand, last 4 and expiry are kept; the full number and CVC never leave this request.
import { html, mount, api, toast, money } from '/js/ui.js';
import { lockIcon } from '../common.js';

export function luhn(num) {
  const s = String(num).replace(/\D/g, '');
  if (s.length < 12 || s.length > 19) return false;
  let sum = 0, dbl = false;
  for (let i = s.length - 1; i >= 0; i--) { let d = +s[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return sum % 10 === 0;
}
const brandOf = (s) => (/^4/.test(s) ? 'Visa' : /^(5[1-5]|2[2-7])/.test(s) ? 'Mastercard' : /^3[47]/.test(s) ? 'Amex' : /^(6011|65)/.test(s) ? 'Discover' : '');

export async function render(ctx) {
  const { me } = ctx;
  const fam = me.family;
  const live = me.settings.payments_mode === 'live';
  // Where to go after saving: back to the screen that asked for a card (only pages inside the portal).
  const back = /^\/parent(\/[a-z]+)?(\?[\w=&%-]*)?$/.test(ctx.query.back || '') ? ctx.query.back : '/parent/family';
  mount(ctx.el, html`<div class="p-auth"><form class="auth-card panel" id="cf" novalidate autocomplete="on">
    <div class="spread"><div class="row" style="gap:10px"><img src="/img/mark-64.png" alt="" width="32" height="32"><span class="strong">${me.settings.business_name}</span></div>
      <span class="secure-head">${lockIcon}Secure card entry</span></div>
    <div><h1 class="page-title" style="font-size:28px">${fam.card_last4 ? 'Replace card' : 'Add a card'}</h1>
      <p class="page-sub">For the ${fam.name}. It pays for every athlete in the family.${fam.card_last4 ? ` Replaces the ${fam.card_label}.` : ''}</p></div>
    ${fam.past_due_cents ? html`<div class="banner" role="note">${money(fam.past_due_cents)} in membership payments is past due. Saving the card tries it again right away.</div>` : ''}
    ${live ? html`<div class="banner">Cards are added on Stripe's secure page. Ask your coach for the link.</div>` : html`
    <div class="card-fields">
      <div class="field span-3"><label class="label" for="cc-num">Card number <span class="muted" id="brand"></span></label>
        <input class="input cc-input" id="cc-num" name="number" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234" maxlength="23" required></div>
      <div class="field"><label class="label" for="cc-exp">Expiry</label><input class="input cc-input" id="cc-exp" name="exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/YY" maxlength="5" required></div>
      <div class="field"><label class="label" for="cc-cvc">CVC</label><input class="input cc-input" id="cc-cvc" name="cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" required></div>
      <div class="field"><label class="label" for="cc-zip">ZIP</label><input class="input cc-input" id="cc-zip" name="zip" inputmode="numeric" autocomplete="postal-code" placeholder="84604" maxlength="10" required></div>
    </div>
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg" id="save">Save card</button>`}
    <a class="btn btn-ghost" href="${back}">Cancel</a>
    <div class="test-code small" role="note">Test mode: no real card is charged. Try 4242 4242 4242 4242; a card ending 0002 is declined. In live mode this page is Stripe Checkout and the card goes straight to Stripe.</div>
    <p class="small muted" style="margin:0">We keep only the card brand, last 4 digits and expiry. The full number and security code are never stored.</p>
  </form></div>`);
  if (live) return;

  const f = document.getElementById('cf');
  const num = f.number, exp = f.exp, err = document.getElementById('err');
  num.focus();
  num.addEventListener('input', () => {
    const d = num.value.replace(/\D/g, '').slice(0, 19);
    num.value = d.replace(/(\d{4})(?=\d)/g, '$1 ');
    document.getElementById('brand').textContent = brandOf(d) ? `· ${brandOf(d)}` : '';
    num.removeAttribute('aria-invalid');
  });
  exp.addEventListener('input', (e) => {
    let d = exp.value.replace(/\D/g, '').slice(0, 4);
    if (d.length === 1 && d > '1') d = '0' + d;
    exp.value = d.length > 2 || (d.length === 2 && e.inputType !== 'deleteContentBackward') ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  });
  f.cvc.addEventListener('input', () => { f.cvc.value = f.cvc.value.replace(/\D/g, '').slice(0, 4); });
  // A fixed field stops showing as wrong as soon as it's edited.
  f.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid')) { e.target.removeAttribute('aria-invalid'); err.textContent = ''; } });

  f.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    f.querySelectorAll('[aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
    const n = num.value.replace(/\D/g, '');
    const fail = (el, msg) => { el.setAttribute('aria-invalid', 'true'); el.focus(); err.textContent = msg; };
    if (!luhn(n)) return fail(num, "That card number isn't valid. Check the digits.");
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(exp.value)) return fail(exp, 'Enter the expiry as MM/YY.');
    const now = new Date(), [mm, yy] = exp.value.split('/').map(Number);
    if (2000 + yy < now.getFullYear() || (2000 + yy === now.getFullYear() && mm < now.getMonth() + 1)) return fail(exp, 'That card has expired. Check the date or use another card.');
    const amex = brandOf(n) === 'Amex';
    if (amex ? !/^\d{4}$/.test(f.cvc.value) : !/^\d{3,4}$/.test(f.cvc.value)) return fail(f.cvc, amex ? 'Amex cards have a 4 digit security code on the front.' : 'Enter the 3 or 4 digit security code.');
    if (!/^\d{5}(-\d{4})?$/.test(f.zip.value.trim())) return fail(f.zip, 'Enter the billing ZIP code.');
    const btn = document.getElementById('save'); btn.disabled = true;
    try {
      const r = await api.put('/parent/card', { number: n, exp: exp.value, cvc: f.cvc.value, zip: f.zip.value.trim() });
      f.reset();
      toast(r.paid ? `${r.card_label} saved. ${r.paid} past-due ${r.paid === 1 ? 'charge was' : 'charges were'} paid.` : r.retried ? `${r.card_label} saved. A past-due charge was declined again.` : `${r.card_label} saved.`, r.retried && !r.paid ? 'warn' : 'good');
      ctx.go(back, { replace: true });
    } catch (x) { err.textContent = x.message; }
    finally { btn.disabled = false; }
  };
}
