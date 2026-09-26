// Coach dashboard: sign-in, role-aware navigation and a small path router under /app.
import { html, raw, mount, api, icon, toast, toastError, formData, setUnauthorizedHandler } from '/js/ui.js';
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
  { id: 'api', label: 'API & integrations', path: '/app/integrations', roles: ['owner'] },
  { id: 'staff', label: 'Staff & security', path: '/app/staff', roles: ['owner'] },
];
const ICON = { today: 'today', schedule: 'schedule', pos: 'pos', clients: 'clients', teams: 'teams', testing: 'testing', billing: 'billing', programs: 'programs', api: 'api', staff: 'staff' };
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
        <div class="btn-row"><a class="btn btn-sm" href="/app/account">Password</a><button class="btn btn-sm" id="signout">Sign out</button></div>
      </div>
    </nav>
    <main class="main" id="main" tabindex="-1"></main>
  </div>`;
}

let renderSeq = 0;
async function render() {
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

// ---- sign in, first-run setup, forced password change ----
async function renderSignIn() {
  root.dataset.nav = '';
  const setup = await api.get('/setup').catch(() => ({}));
  if (setup.needs_setup) return renderSetup();
  mount(root, html`<div class="auth"><form class="auth-card panel" id="f" novalidate>
    <img class="auth-logo" src="/img/logo-320.png" alt="Diamond Protocol, built under pressure">
    <h1 class="page-title" style="font-size:26px;text-align:center">Staff sign in</h1>
    <div class="field"><label class="label" for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="username" required></div>
    <div class="field"><label class="label" for="pw">Password</label><input class="input" id="pw" name="password" type="password" autocomplete="current-password" required>
    <span class="hint">New here? Use the one-time password from your welcome email.</span></div>
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg">Sign in</button>
    <p class="small muted" style="text-align:center;margin:0">Parents: <a href="/parent">sign in to the parent portal</a>.</p>
  </form></div>`);
  const f = document.getElementById('f');
  f.email.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      await api.post('/auth/staff/login', formData(f), { noRedirect: true });
      await boot();
    } catch (err) { document.getElementById('err').textContent = err.message; }
    finally { btn.disabled = false; }
  };
}
function renderSetup() {
  mount(root, html`<div class="auth"><form class="auth-card panel" id="f">
    <img class="auth-logo" src="/img/logo-320.png" alt="Diamond Protocol">
    <h1 class="page-title" style="font-size:24px">Set up your account</h1>
    <p class="muted" style="margin:0">Create the owner account. You can add coaches and front desk staff after.</p>
    <div class="field"><label class="label" for="bn">Business name</label><input class="input" id="bn" name="business_name" value="Diamond Protocol"></div>
    <div class="field"><label class="label" for="n">Your name</label><input class="input" id="n" name="name" required autocomplete="name"></div>
    <div class="field"><label class="label" for="e">Email</label><input class="input" id="e" name="email" type="email" required autocomplete="username"></div>
    <div class="field"><label class="label" for="p">Password</label><input class="input" id="p" name="password" type="password" minlength="10" required autocomplete="new-password"><span class="hint">At least 10 characters.</span></div>
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg">Create owner account</button></form></div>`);
  const f = document.getElementById('f');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = formData(f);
      await api.post('/setup', d);
      await api.post('/auth/staff/login', { email: d.email, password: d.password });
      await boot();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}
function renderChangePassword() {
  root.dataset.nav = '';
  mount(root, html`<div class="auth"><form class="auth-card panel" id="f">
    <img class="auth-logo" src="/img/logo-320.png" alt="Diamond Protocol">
    <h1 class="page-title" style="font-size:24px">Choose your password</h1>
    <p class="muted" style="margin:0">Welcome, ${me.name.split(' ')[0]}. Replace your one-time password with your own.</p>
    <div class="field"><label class="label" for="p1">New password</label><input class="input" id="p1" name="password" type="password" minlength="10" required autocomplete="new-password"><span class="hint">At least 10 characters.</span></div>
    <div class="field"><label class="label" for="p2">Type it again</label><input class="input" id="p2" name="again" type="password" required autocomplete="new-password"></div>
    <div class="error" id="err" role="alert"></div>
    <button class="btn btn-primary btn-lg">Save password</button></form></div>`);
  const f = document.getElementById('f');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    if (d.password !== d.again) { document.getElementById('err').textContent = "Those passwords don't match."; return; }
    try { await api.post('/auth/staff/password', { password: d.password }); me.must_change = 0; toast('Password saved.'); render(); }
    catch (err) { document.getElementById('err').textContent = err.message; }
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
