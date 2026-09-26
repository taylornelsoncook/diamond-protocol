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

let seq = 0;
async function render() {
  const mySeq = ++seq;
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
    familyName: me.family.name, signOut,
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
function renderSignIn(prefill = '') {
  document.title = 'Parent sign-in · Diamond Protocol';
  mount(root, html`<div class="p-auth"><form class="auth-card panel" id="f" novalidate>
    <img class="auth-logo" src="/img/logo-320.png" alt="Diamond Protocol, built under pressure">
    <h1 class="page-title" style="font-size:30px;text-align:center">Parent sign-in</h1>
    <p class="muted" style="margin:0;text-align:center">Use the email your coach has on file. No password needed.</p>
    <div class="field"><label class="label" for="email">Email</label>
      <input class="input" id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required value="${prefill}"></div>
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg">Email me a sign-in code</button>
  </form></div>`);
  const f = document.getElementById('f');
  f.email.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const email = f.email.value.trim();
    const err = document.getElementById('err');
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter the email address your coach has on file.'; f.email.setAttribute('aria-invalid', 'true'); return; }
    const btn = f.querySelector('button'); btn.disabled = true;
    try { const r = await api.post('/auth/parent/code', { email }, { noRedirect: true }); renderCode(email, r.test_code); }
    catch (x) { err.textContent = x.message; }
    finally { btn.disabled = false; }
  };
}

function renderCode(email, testCode) {
  mount(root, html`<div class="p-auth"><form class="auth-card panel" id="f" novalidate>
    <h1 class="page-title" style="font-size:30px">Check your email</h1>
    <p class="muted" style="margin:0">We sent a 6-digit code to ${email}. It expires in 10 minutes.</p>
    ${testCode ? html`<div class="test-code" role="note">Test mode: your code is <span class="mono" style="font-size:15px">${testCode}</span></div>
      <p class="hint" style="margin:-8px 0 0">In test mode the code shows on screen. Once email is connected it only goes to your inbox.</p>` : ''}
    <div class="field"><label class="label" for="code">Sign-in code</label>
      <input class="input code-input" id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required></div>
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg" id="go">Sign in</button>
    <button class="btn btn-ghost" type="button" id="resend">Send a new code</button>
    <button class="btn btn-ghost" type="button" id="other">Use a different email</button>
  </form></div>`);
  const f = document.getElementById('f');
  const err = document.getElementById('err');
  f.code.focus();
  f.code.addEventListener('input', () => {
    f.code.value = f.code.value.replace(/\D/g, '').slice(0, 6);
    if (f.code.value.length === 6) f.requestSubmit();
  });
  document.getElementById('other').onclick = () => renderSignIn(email);
  document.getElementById('resend').onclick = async () => {
    try { const r = await api.post('/auth/parent/code', { email }, { noRedirect: true }); renderCode(email, r.test_code); toast('New code sent. The old one no longer works.'); }
    catch (x) { err.textContent = x.message; }
  };
  let busy = false;
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const code = f.code.value.replace(/\D/g, '');
    if (code.length !== 6) { err.textContent = 'Enter all 6 digits.'; return; }
    busy = true; document.getElementById('go').disabled = true;
    try {
      await api.post('/auth/parent/verify', { email, code }, { noRedirect: true });
      if (location.pathname === '/parent/card') history.replaceState({}, '', '/parent');
      render();
    } catch (x) { err.textContent = x.message; f.code.select(); }
    finally { busy = false; const b = document.getElementById('go'); if (b) b.disabled = false; }
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
render();
