// Coach dashboard: sign-in, role-aware navigation and a small path router under /app.
import { html, raw, mount, api, icon, toast, toastError, formData, setUnauthorizedHandler, passwordField, bindPasswordFields } from '/js/ui.js';
import { screens } from './screens/index.js';

const root = document.getElementById('root');
let me = null, settings = null;

// Menu: who sees what. Owner sees everything; coach never sees money; front desk runs the floor.
const NAV = [
  { id: 'today', label: 'Today', path: '/app/today', roles: ['owner', 'coach', 'frontdesk'] },
  { id: 'schedule', label: 'Schedule', path: '/app/schedule', roles: ['owner', 'coach', 'frontdesk'] },
  { id: 'pos', label: 'Point of sale', path: '/app/pos', roles: ['owner', 'coach', 'frontdesk'] },
  { id: 'clients', label: 'Clients', path: '/app/clients', roles: ['owner', 'coach', 'frontdesk'] },
  { id: 'teams', label: 'Teams', path: '/app/teams', roles: ['owner'] },
  { id: 'testing', label: 'Testing', path: '/app/testing', roles: ['owner', 'coach', 'frontdesk'] },
  { id: 'billing', label: 'Billing', path: '/app/billing', roles: ['owner'] },
  { id: 'programs', label: 'Programs', path: '/app/programs', roles: ['owner', 'coach', 'frontdesk'] },
  { id: 'education', label: 'Education', path: '/app/education', roles: ['owner', 'coach', 'frontdesk'] },
  { id: 'api', label: 'API & integrations', path: '/app/integrations', roles: ['owner'] },
  { id: 'staff', label: 'Staff & security', path: '/app/staff', roles: ['owner'] },
];
const ICON = { today: 'today', schedule: 'schedule', pos: 'pos', clients: 'clients', teams: 'teams', testing: 'testing', billing: 'billing', programs: 'programs', education: 'lesson', api: 'api', staff: 'staff' };
const ROLE_LABEL = { owner: 'Owner', coach: 'Coach', frontdesk: 'Front desk' };

// ---- routing ----
const routes = screens.flatMap((m) => m.routes).map((r) => {
  const keys = [];
  const re = new RegExp('^/app' + r.path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { ...r, re, keys };
});
function match(pathname) {
  for (const r of routes) {
    const m = pathname.match(r.re);
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
export function go(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  render();
}
window.addEventListener('popstate', () => render());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/app')) return;
  e.preventDefault();
  go(url.pathname + url.search);
});

setUnauthorizedHandler(() => { me = null; renderSignIn(); });

// ---- shell ----
function shell(current) {
  const items = NAV.filter((n) => n.roles.includes(me.role));
  return html`<div class="shell" id="shell">
    <header class="topbar no-print">
      <button class="btn btn-ghost btn-sm" id="menu-btn" aria-label="Open menu" aria-expanded="false">${icon('menu')}</button>
      <img src="/img/mark-64.png" alt=""><div class="nav-word">DIAMOND <span style="display:inline;letter-spacing:.12em">PROTOCOL</span></div>
    </header>
    <nav class="nav no-print" aria-label="Main">
      <a class="nav-brand" href="/app/today"><img src="/img/logo-320.png" alt="Diamond Protocol, built under pressure"></a>
      <div class="nav-list">${items.map((n) => html`<a class="nav-item" href="${n.path}" ${n.id === current ? raw('aria-current="page"') : ''}>${icon(ICON[n.id])}${n.label}</a>`)}</div>
      <div class="nav-foot">
        ${settings?.payments_mode === 'test' || settings?.email_mode === 'test' ? html`<div class="test-mode">Test mode: ${[settings.payments_mode === 'test' && 'cards are simulated', settings.email_mode === 'test' && 'emails go to the outbox'].filter(Boolean).join(' and ')}.</div>` : ''}
        <div><span class="strong" style="color:var(--steel)">${me.name}</span><br>${ROLE_LABEL[me.role]}</div>
        <div class="btn-row"><a class="btn btn-sm" href="/app/account">Account</a><button class="btn btn-sm" id="signout">Sign out</button></div>
      </div>
    </nav>
    <main class="main" id="main" tabindex="-1"></main>
  </div>`;
}

let renderSeq = 0;
async function render() {
  const resetToken = location.pathname === '/' && new URLSearchParams(location.search).get('reset');
  if (resetToken) return renderResetLink(resetToken); // a reset link works even on a device that's signed in
  if (!me) return renderSignIn();
  if (me.must_change) return renderChangePassword();
  let path = location.pathname;
  if (path === '/' || path === '/app' || path === '/app/') { history.replaceState({}, '', '/app/today'); path = '/app/today'; }
  const m = match(path);
  const current = m?.route.nav;
  if (!document.getElementById('shell') || root.dataset.nav !== current) {
    mount(root, shell(current));
    root.dataset.nav = current || '';
    document.getElementById('signout').onclick = async () => { await api.post('/auth/staff/logout'); me = null; location.href = '/'; };
    const sh = document.getElementById('shell'), btn = document.getElementById('menu-btn');
    btn.onclick = () => { const open = sh.classList.toggle('nav-open'); btn.setAttribute('aria-expanded', String(open)); };
    sh.querySelector('.nav').addEventListener('click', (e) => { if (e.target.closest('a')) sh.classList.remove('nav-open'); });
  }
  const main = document.getElementById('main');
  const seq = ++renderSeq;
  if (!m) { mount(main, html`<div class="empty">That page doesn't exist. <a href="/app/today">Go to Today</a>.</div>`); return; }
  if (m.route.roles && !m.route.roles.includes(me.role)) {
    mount(main, html`<div class="empty">Your role can't open this page. Ask an owner if you need it.</div>`); return;
  }
  document.title = `${m.route.title || 'Diamond Protocol'} · Diamond Protocol`;
  const ctx = {
    el: main, params: m.params, query: Object.fromEntries(new URLSearchParams(location.search)), me, settings, go,
    reload: () => render(), isCurrent: () => seq === renderSeq,
  };
  mount(main, html`<div class="muted" aria-busy="true">Loading…</div>`);
  try { await m.route.render(ctx); }
  catch (e) {
    if (seq !== renderSeq) return;
    if (e.status === 401) return;
    mount(main, html`<div class="banner">${e.message || 'Something went wrong.'}</div>`);
    console.error(e);
  }
  if (seq === renderSeq && !m.route.keepScroll) window.scrollTo(0, 0);
}

// ---- sign in, forgot password, reset link, first-run setup, forced password change ----
const LOGO = html`<img class="auth-logo" src="/img/logo-320.png" alt="Diamond Protocol, built under pressure">`;
const authCard = (body) => html`<div class="auth"><form class="auth-card panel" id="f" novalidate>${LOGO}${body}</form></div>`;
const setErr = (msg) => { const e = document.getElementById('err'); if (e) e.textContent = msg || ''; };
// Disable the submit button and show what's happening; returns a function that puts it back.
function busy(f, label) {
  const btn = f.querySelector('button.btn-primary'), was = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  return () => { btn.disabled = false; btn.textContent = was; };
}

async function renderSignIn({ email = '', notice = '' } = {}) {
  root.dataset.nav = '';
  const reset = new URLSearchParams(location.search).get('reset');
  if (reset) return renderResetLink(reset);
  const setup = await api.get('/setup').catch(() => ({}));
  if (setup.needs_setup) return renderSetup();
  mount(root, authCard(html`
    <h1 class="page-title" style="font-size:26px;text-align:center">Staff sign in</h1>
    ${notice ? html`<div class="banner info" role="status">${notice}</div>` : ''}
    <div class="field"><label class="label" for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="username" required value="${email}"></div>
    ${passwordField({ id: 'pw', name: 'password', label: 'Password', hint: 'New here? Use the one-time password from your welcome email.' })}
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg">Sign in</button>
    <div class="spread" style="justify-content:center;gap:4px 16px">
      <button type="button" class="link-btn small" id="forgot">Forgot your password?</button>
      <span class="small muted">Parents: <a href="/parent">parent portal</a></span>
    </div>`));
  const f = document.getElementById('f');
  bindPasswordFields(f);
  (email ? f.password : f.email).focus();
  document.getElementById('forgot').onclick = () => renderForgot(f.email.value.trim(), setup);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    if (!d.email.trim() || !d.password) { setErr(!d.email.trim() ? 'Enter your email.' : 'Enter your password.'); (d.email.trim() ? f.password : f.email).focus(); return; }
    setErr('');
    const done = busy(f, 'Signing in…');
    try {
      await api.post('/auth/staff/login', d, { noRedirect: true });
      await boot();
    } catch (err) { done(); setErr(err.message); f.password.select(); }
  };
}

function renderForgot(email, setup = {}) {
  root.dataset.nav = '';
  mount(root, authCard(html`
    <h1 class="page-title" style="font-size:24px;text-align:center">Reset your password</h1>
    <p class="muted" style="margin:0">Enter the email you sign in with. We'll email you a link to choose a new password. It works once, for 30 minutes.</p>
    <div class="field"><label class="label" for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="username" required value="${email}"></div>
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg">Email me a reset link</button>
    <button type="button" class="link-btn small" id="back" style="align-self:center">Back to sign in</button>`));
  const f = document.getElementById('f');
  f.email.focus();
  document.getElementById('back').onclick = () => renderSignIn({ email: f.email.value.trim() });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const addr = f.email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(addr)) { setErr('Enter the email you sign in with.'); return; }
    const done = busy(f, 'Sending…');
    try {
      const r = await api.post('/staff-reset', { email: addr }, { noRedirect: true });
      mount(root, authCard(html`
        <h1 class="page-title" style="font-size:24px;text-align:center">Check your email</h1>
        <p style="margin:0">If ${addr} belongs to a staff account, a reset link is on its way. It works for ${r.minutes} minutes.</p>
        <p class="muted small" style="margin:0">Nothing after a few minutes? Check spam, or ask an owner to reset your password in Staff & security.${setup.email_mode === 'test' ? ' Test mode: emails go to the outbox in API & integrations instead of being sent.' : ''}</p>
        <button type="button" class="btn btn-lg" id="back">Back to sign in</button>`));
      document.getElementById('back').onclick = () => renderSignIn({ email: addr });
    } catch (err) { done(); setErr(err.message); }
  };
}

async function renderResetLink(token) {
  root.dataset.nav = '';
  const clearUrl = () => history.replaceState({}, '', '/');
  let info;
  try { info = await api.get(`/staff-reset/${encodeURIComponent(token)}`, { noRedirect: true }); }
  catch (err) {
    mount(root, authCard(html`
      <h1 class="page-title" style="font-size:24px;text-align:center">Link expired</h1>
      <p style="margin:0">${err.message}</p>
      <button class="btn btn-primary btn-lg">Ask for a new link</button>
      <button type="button" class="link-btn small" id="back" style="align-self:center">Back to sign in</button>`));
    document.getElementById('f').onsubmit = (e) => { e.preventDefault(); clearUrl(); renderForgot(''); };
    document.getElementById('back').onclick = () => { clearUrl(); render(); };
    return;
  }
  mount(root, authCard(html`
    <h1 class="page-title" style="font-size:24px;text-align:center">Choose a new password</h1>
    <p class="muted" style="margin:0">Hi ${info.name}. Choose a new password for ${info.email}. You'll be signed out on every other device.</p>
    ${passwordField({ id: 'p1', name: 'password', label: 'New password', autocomplete: 'new-password', minlength: 10, hint: 'At least 10 characters. A short sentence works well.' })}
    ${passwordField({ id: 'p2', name: 'again', label: 'Type it again', autocomplete: 'new-password' })}
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg">Save password and sign in</button>`));
  const f = document.getElementById('f');
  bindPasswordFields(f);
  f.password.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    if (d.password.length < 10) { setErr('Use at least 10 characters.'); return; }
    if (d.password !== d.again) { setErr("Those passwords don't match."); return; }
    const done = busy(f, 'Saving…');
    try {
      const r = await api.post(`/staff-reset/${encodeURIComponent(token)}`, { password: d.password }, { noRedirect: true });
      clearUrl();
      await api.post('/auth/staff/login', { email: r.email, password: d.password }, { noRedirect: true });
      toast('Password saved. You are signed in.');
      await boot();
    } catch (err) { done(); setErr(err.message); }
  };
}

function renderSetup() {
  mount(root, authCard(html`
    <h1 class="page-title" style="font-size:24px">Set up your account</h1>
    <p class="muted" style="margin:0">Create the owner account. You can add coaches and front desk staff after, in Staff & security.</p>
    <div class="field"><label class="label" for="bn">Business name</label><input class="input" id="bn" name="business_name" value="Diamond Protocol" maxlength="80" autocomplete="organization"><span class="hint">Shown on emails, invoices and the parent portal.</span></div>
    <div class="field"><label class="label" for="n">Your name</label><input class="input" id="n" name="name" required autocomplete="name" maxlength="80"></div>
    <div class="field"><label class="label" for="e">Email</label><input class="input" id="e" name="email" type="email" required autocomplete="username"><span class="hint">You'll sign in with this.</span></div>
    ${passwordField({ id: 'p', name: 'password', label: 'Password', autocomplete: 'new-password', minlength: 10, hint: 'At least 10 characters. A short sentence works well.' })}
    ${passwordField({ id: 'p2', name: 'again', label: 'Type it again', autocomplete: 'new-password' })}
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg">Create owner account</button>`));
  const f = document.getElementById('f');
  bindPasswordFields(f);
  f.name.focus();
  const ORDER = ['name', 'email', 'password', 'again'];
  const problemOf = (d) => (!d.name.trim() ? ['name', 'Enter your name.'] : !/^\S+@\S+\.\S+$/.test(d.email.trim()) ? ['email', 'Enter a valid email address.']
    : d.password.length < 10 ? ['password', 'Use a password of at least 10 characters.'] : d.password !== d.again ? ['again', "Those passwords don't match."] : null);
  const mark = (p) => { ORDER.forEach((k) => f[k].removeAttribute('aria-invalid')); if (p) f[p[0]].setAttribute('aria-invalid', 'true'); setErr(p ? p[1] : ''); };
  // Check each field as you leave it (once something is typed there), not while you're still on the way down the form.
  f.addEventListener('focusout', (e) => {
    const k = e.target.name;
    if (!ORDER.includes(k) || e.relatedTarget?.dataset?.pwFor) return; // tapping Show isn't leaving the field
    const d = formData(f), p = problemOf(d);
    mark(p && d[k] && ORDER.indexOf(p[0]) <= ORDER.indexOf(k) ? p : null);
  });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    const problem = problemOf(d);
    mark(problem);
    if (problem) { f[problem[0]].focus(); return; }
    const done = busy(f, 'Creating…');
    try {
      const { again, ...body } = d;
      await api.post('/setup', body, { noRedirect: true });
      await api.post('/auth/staff/login', { email: d.email.trim(), password: d.password }, { noRedirect: true });
      await boot();
    } catch (err) { done(); setErr(err.message); }
  };
}

function renderChangePassword() {
  root.dataset.nav = '';
  mount(root, authCard(html`
    <h1 class="page-title" style="font-size:24px">Choose your password</h1>
    <p class="muted" style="margin:0">Welcome, ${me.name.split(' ')[0]}. Replace your one-time password with your own. Only you will know it.</p>
    ${passwordField({ id: 'p1', name: 'password', label: 'New password', autocomplete: 'new-password', minlength: 10, hint: 'At least 10 characters. A short sentence works well.' })}
    ${passwordField({ id: 'p2', name: 'again', label: 'Type it again', autocomplete: 'new-password' })}
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg">Save password</button>
    <button type="button" class="link-btn small" id="signout" style="align-self:center">Not ${me.name.split(' ')[0]}? Sign out</button>`));
  const f = document.getElementById('f');
  bindPasswordFields(f);
  f.password.focus();
  document.getElementById('signout').onclick = async () => { await api.post('/auth/staff/logout').catch(() => {}); me = null; location.href = '/'; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    if (d.password.length < 10) { setErr('Use at least 10 characters.'); return; }
    if (d.password !== d.again) { setErr("Those passwords don't match."); return; }
    const done = busy(f, 'Saving…');
    try { await api.post('/auth/staff/password', { password: d.password }); me.must_change = 0; toast('Password saved. Use it next time you sign in.'); await boot(); }
    catch (err) { done(); setErr(err.message); }
  };
}

async function boot() {
  try { me = await api.get('/auth/staff/me', { noRedirect: true }); }
  catch { me = null; }
  if (me && !me.must_change) settings = await api.get('/settings').catch(() => null);
  render();
}
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.status && e.reason.status !== 401) toastError(e.reason); });
boot();
