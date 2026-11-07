// The "are you a person" check on the public forms (Ask about training, the family sign-up, the online sales page):
// Cloudflare Turnstile, free, on once TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set in Render. Without them the
// forms work as before, with the hidden bot-trap field and the rate limits. With them, each form shows the widget and
// sends its token as captcha_token; the server asks Cloudflare whether the token is good before anything is saved or
// emailed, so a bot flood can't spend our email and text budget or fill the Leads page.
import { HttpError } from '../util.js';

export const ORIGIN = 'https://challenges.cloudflare.com';
export const VERIFY_URL = `${ORIGIN}/turnstile/v0/siteverify`;
const MAX_TOKEN = 2048;

const keys = () => {
  const site = String(process.env.TURNSTILE_SITE_KEY ?? '').trim(), secret = String(process.env.TURNSTILE_SECRET_KEY ?? '').trim();
  return site && secret ? { site, secret } : null;
};
export const enabled = () => !!keys();
// What the public pages read: whether to show the widget, and the site key (public by design; the secret never leaves the server).
export const status = () => ({ enabled: enabled(), site_key: keys()?.site ?? null });

// Check a form's token with Cloudflare. Nothing to do while the check is off. A missing token is 400 (the page shows the
// widget again), a token Cloudflare refuses is 400, and Cloudflare unreachable is 503 so the person tries again rather
// than the form quietly letting everything through.
export async function check(ctx, token, ip) {
  const k = keys();
  if (!k) return;
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t || t.length > MAX_TOKEN) throw new HttpError(400, 'captcha_required', 'Please tick the box that says you\'re a person, then send again.');
  const f = ctx.captchaFetch ?? fetch;
  let out;
  try {
    const res = await f(VERIFY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: k.secret, response: t, ...(ip ? { remoteip: ip } : {}) }), signal: AbortSignal.timeout(8000) });
    out = await res.json();
  } catch {
    throw new HttpError(503, 'captcha_unavailable', 'We couldn\'t check that you\'re a person just now. Try again in a minute.');
  }
  if (!out || out.success !== true) throw new HttpError(400, 'captcha_failed', 'That check didn\'t pass. Tick the box again and send again.');
}
