// The "are you a person" check on the public forms: Cloudflare Turnstile, shown only when the owner has set it up
// (GET /portal/api/public/captcha says so and gives the site key). Nothing loads from Cloudflare until a form that
// needs it is on the screen. The form sends token() as captcha_token; after a refused send, reset() asks for a new one.
import { h } from './ui.js';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading = null;
const loadScript = () => {
  loading ??= new Promise((ok, fail) => {
    if (window.turnstile) return ok();
    const s = document.createElement('script');
    s.src = SCRIPT; s.async = true; s.defer = true;
    s.onload = () => ok(); s.onerror = () => fail(new Error('load'));
    document.head.appendChild(s);
  });
  return loading;
};

export async function captchaBox() {
  const info = await fetch('/portal/api/public/captcha').then((r) => r.json()).catch(() => ({ enabled: false }));
  if (!info.enabled) return { el: null, token: () => null, reset: () => {} };
  const el = h('div', { class: 'dp-captcha', 'aria-label': 'Confirm you are a person' });
  let id = null;
  try {
    await loadScript();
    id = window.turnstile.render(el, { sitekey: info.site_key, theme: 'dark', appearance: 'always' });
  } catch {
    el.textContent = 'The "are you a person" check couldn\'t load. Reload the page and try again.';
  }
  return {
    el,
    token: () => (id != null ? window.turnstile.getResponse(id) || null : null),
    reset: () => { if (id != null) window.turnstile.reset(id); },
  };
}
