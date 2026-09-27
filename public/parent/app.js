// Parent portal: emailed-code sign-in, bottom tab bar and a small path router under /parent.
import { html, raw, mount, api, icon, toast, toastError, setUnauthorizedHandler } from '/js/ui.js';
import * as home from './screens/home.js';
import * as book from './screens/book.js';
import * as progress from './screens/progress.js';
import * as programs from './screens/programs.js';
import * as family from './screens/family.js';
import * as card from './screens/card.js';

const root = document.getElementById('root');
let me = null;
let athleteId = null;
try { athleteId = Number(sessionStorage.getItem('dp_parent_athlete')) || null; } catch { /* storage blocked */ }

const TABS = [
  { id: 'home', label: 'Home', path: '/parent', icon: 'home', screen: home },
  { id: 'book', label: 'Book', path: '/parent/book', icon: 'book', screen: book },
  { id: 'progress', label: 'Progress', path: '/parent/progress', icon: 'progress', screen: progress },
  { id: 'programs', label: 'Programs', path: '/parent/programs', icon: 'programs', screen: programs },
  { id: 'family', label: 'Family', path: '/parent/family', icon: 'family', screen: family },
];
const PAGES = [...TABS, { id: 'card', path: '/parent/card', screen: card, bare: true }];

export function go(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  render();
}
window.addEventListener('popstate', () => render());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !(url.pathname === '/parent' || url.pathname.startsWith('/parent/'))) return;
  e.preventDefault();
  go(url.pathname + url.search + url.hash);
});
setUnauthorizedHandler(() => { me = null; renderSignIn(); });

function tabbar(current) {
  return html`<nav class="tabbar" aria-label="Main"><div class="tabbar-in">${TABS.map((t) => html`<a class="tab" href="${t.path}" ${t.id === current ? raw('aria-current="page"') : ''}>${icon(t.icon, 22)}<span>${t.label}</span></a>`)}</div></nav>`;
}

function setAthlete(id) {
  athleteId = id;
  try { sessionStorage.setItem('dp_parent_athlete', String(id)); } catch { /* storage blocked */ }
}

// ---- install to home screen: Chrome and Edge offer a prompt; Safari on iPhone needs Share, Add to Home Screen ----
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (location.pathname.replace(/\/+$/, '') === '/parent') document.dispatchEvent(new Event('dp-install')); });
window.addEventListener('appinstalled', () => { installEvent = null; toast('Added to your home screen.'); });
const install = {
  standalone: () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true,
  ios: () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  canPrompt: () => !!installEvent,
  async prompt() { if (!installEvent) return false; const e = installEvent; installEvent = null; e.prompt(); const r = await e.userChoice.catch(() => null); return r?.outcome === 'accepted'; },
};

// Back on the phone after a while (an installed app stays open for days): show fresh data.
let renderedAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !me || Date.now() - renderedAt < 5 * 6e4) return;
  if (document.querySelector('.modal-back') || document.activeElement?.matches?.('input, textarea, select')) return;
  render();
});
function offlineBar() {
  let bar = document.getElementById('offline');
  if (navigator.onLine) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'offline'; bar.className = 'p-offline'; bar.setAttribute('role', 'status'); document.body.append(bar); }
  bar.textContent = 'No connection. What you see may be out of date.';
}
window.addEventListener('online', () => { offlineBar(); if (me) render(); });
window.addEventListener('offline', offlineBar);

let seq = 0;
async function render() {
  const mySeq = ++seq;
  renderedAt = Date.now();
  const path = location.pathname.replace(/\/+$/, '') || '/parent';
  const page = PAGES.find((p) => p.path === path) || null;
  if (!page) { history.replaceState({}, '', '/parent'); return render(); }
  try { me = await api.get('/parent/me', { noRedirect: true }); }
  catch (e) { if (e.status === 401) { me = null; return renderSignIn(); } mount(root, html`<div class="p-app"><div class="banner">${e.message}</div></div>`); return; }
  if (mySeq !== seq) return;
  const query = Object.fromEntries(new URLSearchParams(location.search));
  if (query.athlete && me.athletes.some((a) => a.id === +query.athlete)) setAthlete(+query.athlete);
  if (!me.athletes.some((a) => a.id === athleteId)) athleteId = me.athletes[0]?.id || null;
  document.title = page.label ? `${page.label} · Diamond Protocol` : 'Add a card · Diamond Protocol';
  mount(root, html`<main class="${page.bare ? '' : 'p-app'}" id="main"></main>${page.bare ? '' : tabbar(page.id)}`);
  const el = document.getElementById('main');
  const ctx = {
    el, me, query, go, setAthlete,
    athlete: me.athletes.find((a) => a.id === athleteId) || null,
    reload: () => render(), isCurrent: () => mySeq === seq,
    familyName: me.family.name, signOut, install,
  };
  mount(el, html`<div class="muted" aria-busy="true" style="padding:24px 0">Loading…</div>`);
  try { await page.screen.render(ctx); }
  catch (e) {
    if (mySeq !== seq || e.status === 401) return;
    mount(el, html`<div class="banner">${e.message || 'Something went wrong. Try again.'}</div>`);
    console.error(e);
  }
  if (mySeq === seq && !location.hash) window.scrollTo(0, 0);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

// ---- sign in: email, then the 6-digit code ----
const EMAIL_KEY = 'dp_parent_email';
const rememberedEmail = () => { try { return localStorage.getItem(EMAIL_KEY) || ''; } catch { return ''; } };
const rememberEmail = (v) => { try { localStorage.setItem(EMAIL_KEY, v); } catch { /* storage blocked */ } };

function renderSignIn(prefill = rememberedEmail()) {
  document.title = 'Parent sign-in · Diamond Protocol';
  mount(root, html`<main class="p-auth" id="main"><form class="auth-card panel" id="f" novalidate>
    <img class="auth-logo" src="/img/logo-320.png" alt="Diamond Protocol, built under pressure">
    <h1 class="page-title" style="font-size:30px;text-align:center">Parent sign-in</h1>
    <p class="muted" style="margin:0;text-align:center">Use the email your coach has on file. We'll email you a code. No password needed.</p>
    <div class="field"><label class="label" for="email">Email</label>
      <input class="input" id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required value="${prefill}" aria-describedby="err"></div>
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg" id="send">Email me a sign-in code</button>
    <p class="hint" style="margin:0;text-align:center">New here? Your coach sets up the family account first. Ask at the front desk.</p>
  </form></main>`);
  const f = document.getElementById('f');
  const err = document.getElementById('err');
  if (!prefill) f.email.focus();
  f.email.addEventListener('input', () => { err.textContent = ''; f.email.removeAttribute('aria-invalid'); });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const email = f.email.value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter the email address your coach has on file.'; f.email.setAttribute('aria-invalid', 'true'); f.email.focus(); return; }
    const btn = document.getElementById('send'); btn.disabled = true; btn.textContent = 'Sending…';
    try { const r = await api.post('/auth/parent/code', { email }, { noRedirect: true }); rememberEmail(email); renderCode(email, r); }
    catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Email me a sign-in code'; }
  };
}

function renderCode(email, sent) {
  const testCode = sent?.test_code;
  mount(root, html`<main class="p-auth" id="main"><form class="auth-card panel" id="f" novalidate>
    <h1 class="page-title" style="font-size:30px">Check your email</h1>
    <p class="muted" style="margin:0">If <strong class="p-email">${email}</strong> is on file, a 6-digit code is on its way. It works once, for 10 minutes.</p>
    ${testCode ? html`<div class="test-code" role="note">Test mode: your code is <span class="mono" style="font-size:15px">${testCode}</span></div>
      <p class="hint" style="margin:-8px 0 0">In test mode the code shows on screen. Once email is connected it only goes to your inbox.</p>` : ''}
    <div class="field"><label class="label" for="code">Sign-in code</label>
      <input class="input code-input" id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required aria-describedby="err code-help">
      <p class="hint" id="code-help" style="margin:0">Phones can fill it in from the email.</p></div>
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg" id="go">Sign in</button>
    <button class="btn btn-ghost" type="button" id="resend"></button>
    <button class="btn btn-ghost" type="button" id="other">Use a different email</button>
    <details class="p-help"><summary>No email?</summary>
      <p>Check spam or promotions, and search for "sign-in code". It can take a minute.</p>
      <p>Still nothing? The front desk can tell you which email is on your account.</p></details>
  </form></main>`);
  const f = document.getElementById('f');
  const err = document.getElementById('err');
  const resend = document.getElementById('resend');
  f.code.focus();
  f.code.addEventListener('input', () => {
    f.code.value = f.code.value.replace(/\D/g, '').slice(0, 6);
    err.textContent = ''; f.code.removeAttribute('aria-invalid');
    if (f.code.value.length === 6) f.requestSubmit();
  });
  // Pasting the whole email line ("Your sign-in code is 123456.") keeps just the code.
  f.code.addEventListener('paste', (e) => {
    const m = (e.clipboardData?.getData('text') || '').match(/\d{3}\s?\d{3}/);
    if (!m) return;
    e.preventDefault(); f.code.value = m[0].replace(/\s/g, ''); f.requestSubmit();
  });
  // Send a new code: waits a moment so a slow email isn't replaced by the next one.
  let wait = Number(sent?.resend_in) || 30, timer = null;
  const tick = () => {
    if (!resend.isConnected) return clearInterval(timer);
    resend.disabled = wait > 0;
    resend.textContent = wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code';
    if (wait-- <= 0) clearInterval(timer);
  };
  tick(); timer = setInterval(tick, 1000);
  document.getElementById('other').onclick = () => { clearInterval(timer); renderSignIn(email); };
  resend.onclick = async () => {
    resend.disabled = true;
    try { const r = await api.post('/auth/parent/code', { email }, { noRedirect: true }); clearInterval(timer); renderCode(email, r); toast('New code sent. The old one no longer works.'); }
    catch (x) { err.textContent = x.message; resend.disabled = false; }
  };
  let busy = false;
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const code = f.code.value.replace(/\D/g, '');
    if (code.length !== 6) { err.textContent = 'Enter all 6 digits.'; f.code.setAttribute('aria-invalid', 'true'); return; }
    busy = true; const go = document.getElementById('go'); go.disabled = true; go.textContent = 'Signing in…';
    try {
      await api.post('/auth/parent/verify', { email, code }, { noRedirect: true });
      clearInterval(timer);
      if (location.pathname === '/parent/card') history.replaceState({}, '', '/parent');
      render();
    } catch (x) {
      err.textContent = x.message; f.code.setAttribute('aria-invalid', 'true'); f.code.select();
      busy = false; const b = document.getElementById('go'); if (b) { b.disabled = false; b.textContent = 'Sign in'; }
    }
  };
}

export async function signOut() {
  await api.post('/auth/parent/logout').catch(() => {});
  me = null;
  try { sessionStorage.removeItem('dp_parent_athlete'); } catch { /* storage blocked */ }
  history.replaceState({}, '', '/parent');
  renderSignIn();
}

window.addEventListener('unhandledrejection', (e) => { if (e.reason?.status && e.reason.status !== 401) toastError(e.reason); });
offlineBar();
// Ask whether there's a session first (always 200), so opening the portal signed out logs no failed request.
api.get('/auth/parent/session', { noRedirect: true })
  .then((r) => (r.signed_in ? render() : renderSignIn()))
  .catch(() => render());
