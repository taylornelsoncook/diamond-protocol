// Printable progress report (/report/:code). Staff get the coach view (includes unshared results) and can preview
// the family view; the athlete's family gets the family view; anyone with a share link (?link=) gets the family view
// without signing in. Owners, coaches and the family can make share links; owners and coaches can email the report.
import { html, raw, mount, api, fmtDate, age, modal, toast, toastError, plural } from '/js/ui.js';
import { fmtValue, fmtChange, fmtPct, scoring, trendSvg } from '/js/testing-format.js';

const root = document.getElementById('root');
const code = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const GROWTH_TESTS = ['Height', 'Seated height', 'Weight'];
const CAT_ORDER = ['Speed', 'Agility', 'Power', 'Strength', 'Endurance', 'Mobility', 'Force plate', 'Baseball', 'Basketball', 'Hockey', 'Soccer', 'Body'];
const params = new URLSearchParams(location.search);
const state = { link: params.get('link') || '', view: params.get('view') === 'family' ? 'family' : '', from: params.get('from') || '', to: params.get('to') || '', since: 'first' };
try { if (localStorage.getItem('dp-report-since') === 'last') state.since = 'last'; } catch { /* storage blocked */ }

function signIn() {
  document.title = 'Sign in · Diamond Protocol';
  mount(root, html`<div class="rp-auth panel">
    <img src="/img/logo-320.png" alt="Diamond Protocol, built under pressure" style="width:150px;margin:0 auto">
    <h1 class="page-title" style="font-size:24px">Sign in to see this report</h1>
    <p class="muted" style="margin:0">Progress reports are private to the athlete's family and coaches. If someone shared a link with you, open the full link they sent.</p>
    <a class="btn btn-primary" href="/parent">Parents: sign in</a>
    <a class="btn btn-ghost" href="/">Staff: sign in</a>
  </div>`);
}
function problem(title, text, action = html`<a class="btn" href="/parent">Go to the parent portal</a>`) {
  document.title = `${title} · Diamond Protocol`;
  mount(root, html`<div class="rp-auth panel"><h1 class="page-title" style="font-size:24px">${title}</h1><p class="muted" style="margin:0">${text}</p>${action}</div>`);
}

function growthText(g) {
  const yrs = Math.abs(g.maturity_offset).toFixed(1);
  if (g.maturity_offset > 1) return `About ${yrs} years past the fastest growth. Strength gains usually come more easily from here.`;
  if (g.maturity_offset > 0) return `About ${yrs} years past the fastest growth. Growth is slowing; keep building strength and landing mechanics.`;
  if (g.maturity_offset >= -1) return `About ${yrs} years before the fastest growth is expected. Coordination can dip for a while; keep sprint and landing mechanics sharp.`;
  return `About ${yrs} years before the fastest growth is expected. A great time to build movement skills and speed.`;
}
const statusWord = (s) => (/before/i.test(s) ? 'Before' : /after/i.test(s) ? 'After' : 'In');
const catIdx = (c) => { const i = CAT_ORDER.indexOf(c); return i < 0 ? 99 : i; };
const trendLabel = (t) => `Trend: ${t.history.map((h) => `${fmtValue(h.value, t.unit)} on ${fmtDate(h.date)}`).join(', ')}`;

// Change since the first test (default) or since the test before the latest.
function changeOf(t) {
  if (t.count < 2) return null;
  if (state.since === 'first') return { change: t.change, pct: t.pct };
  const prev = t.history[t.history.length - 2].value, latest = t.latest;
  const change = Math.round((latest - prev) * 1e4) / 1e4;
  const pct = prev ? Math.round(((t.lower_better ? prev - latest : latest - prev) / Math.abs(prev)) * 1000) / 10 : 0;
  return { change, pct };
}

function query(extra = {}) {
  const q = new URLSearchParams();
  const o = { link: state.link, view: state.view, from: state.from, to: state.to, ...extra };
  for (const [k, v] of Object.entries(o)) if (v) q.set(k, v);
  return q.toString();
}
function syncUrl() {
  const q = query();
  history.replaceState(null, '', `${location.pathname}${q ? '?' + q : ''}`);
}

function periodOptions(p) {
  const days = [...(p.all_days || [])].sort((a, b) => a.date.localeCompare(b.date));
  const opts = [['', 'All results']];
  const yearAgo = new Date(); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  opts.push([yearAgo.toISOString().slice(0, 10), 'Last 12 months']);
  days.slice(1).forEach((d) => opts.push([d.date, `Since ${d.name} (${fmtDate(d.date)})`]));
  if (state.from && !opts.some(([v]) => v === state.from)) opts.push([state.from, `Since ${fmtDate(state.from)}`]);
  return opts;
}

function render(p) {
  const a = p.athlete;
  const coach = p.view === 'coach';
  const staff = coach || p.preview;
  const fullName = `${a.first_name} ${a.last_name}`;
  document.title = `${fullName} progress report · ${p.business || 'Diamond Protocol'}`;
  const tests = p.tests.filter((t) => !GROWTH_TESTS.includes(t.name)).sort((x, y) => (catIdx(x.category) - catIdx(y.category)) || x.name.localeCompare(y.name));
  const cats = [...new Set(tests.map((t) => t.category))];
  const anyHand = p.tests.some((t) => t.hand_timed && t.unit === 's');
  const years = a.birthday ? age(a.birthday) : a.age ?? null; // a share link sends the age, not the date of birth
  const meta = [a.code, years != null ? `Age ${years}` : '', a.sport, a.position, a.school].filter(Boolean).join(' · ');
  const range = p.first_date ? (p.first_date === p.last_date ? fmtDate(p.first_date) : `${fmtDate(p.first_date)} to ${fmtDate(p.last_date)}`) : '';
  const g = p.growth;
  const periods = periodOptions(p);
  const backLink = staff ? html`<a class="btn btn-ghost" href="/app/clients/${a.id}">Back to the athlete</a>` : p.view === 'parent' ? html`<a class="btn btn-ghost" href="/parent/progress">Back to Progress</a>` : '';
  const multi = tests.some((t) => t.count > 1);
  mount(root, html`
    <div class="rp-bar no-print">
      <div class="btn-row"><button class="btn btn-primary" id="print">Print or save as PDF</button>
        ${p.can_share ? html`<button class="btn" id="share">Share a link</button>` : ''}
        ${staff && p.can_share ? html`<button class="btn" id="email">Email to family</button>` : ''}
        ${backLink}</div>
      <div class="rp-controls">
        ${staff ? html`<div class="seg" role="group" aria-label="Whose view">
          <button type="button" data-view="" aria-pressed="${!p.preview}">Coach view</button><button type="button" data-view="family" aria-pressed="${!!p.preview}">Family view</button></div>` : ''}
        ${(p.all_days || []).length || state.from ? html`<label class="rp-ctl"><span class="sr-only">Period</span><select class="input" id="period">
          ${periods.map(([v, l]) => html`<option value="${v}" ${v === state.from ? raw('selected') : ''}>${l}</option>`)}</select></label>` : ''}
        ${multi ? html`<div class="seg" role="group" aria-label="Change since">
          <button type="button" data-since="first" aria-pressed="${state.since === 'first'}">Since first test</button><button type="button" data-since="last" aria-pressed="${state.since === 'last'}">Since last test</button></div>` : ''}
      </div>
    </div>
    ${coach && p.unshared ? html`<div class="banner rp-coach small">Coach view: includes results that haven't been shared with the family yet. They're marked Not shared yet.</div>`
    : coach ? html`<div class="banner info small no-print">Coach view. Every result here has been shared with the family.</div>`
    : p.preview ? html`<div class="banner info small no-print">Family view: this is what ${a.first_name}'s family sees${p.can_share ? ' and what a share link shows' : ''}. Results from days that haven't been shared are left out.</div>`
    : p.view === 'link' ? html`<div class="banner info small no-print">Shared with you by ${a.first_name}'s family or coach. This link works for a limited time.</div>` : ''}
    <article class="rp-card">
      <header class="rp-head"><div><h1 class="rp-name">${fullName}</h1><p class="rp-meta">${meta}</p>
        <p class="rp-meta">Progress report${range ? ` · ${range}` : ''}${state.from ? ` · ${periods.find(([v]) => v === state.from)?.[1] || ''}` : ''}</p></div>
        <div class="rp-logo"><img src="/img/logo-320.png" alt="Diamond Protocol, built under pressure"></div></header>
      ${!p.tests.length ? html`<p class="muted" style="margin:0">${state.from ? 'No results in this period. Pick All results to see everything.' : `No results ${coach ? 'yet' : 'have been shared yet'}. After the next testing day, results show up here.`}</p>` : ''}
      ${p.note ? html`<section><h2 class="rp-h">From your coach · ${p.note.day_name}</h2><p class="rp-note">${p.note.text}</p></section>` : ''}
      ${p.improvements.length ? html`<section><h2 class="rp-h">Biggest improvements</h2><div class="rp-tiles">${p.improvements.map((i) => html`<div class="rp-tile">
        <span class="rp-big">${fmtPct(i.pct)}</span><span class="t">${i.test}</span><span class="s">${fmtValue(i.first, i.unit)} → ${fmtValue(i.latest, i.unit)}</span></div>`)}</div></section>` : ''}
      ${p.prs.length ? html`<p style="margin:0"><strong>New personal records:</strong> ${p.prs.map((x) => `${x.test} (${fmtValue(x.value, x.unit)})`).join(', ')}.</p>` : ''}
      ${tests.length ? html`<section><h2 class="rp-h">Every test</h2><table class="rp-table"><thead><tr><th>Test</th><th class="hide-sm">First</th><th>Latest</th><th>Best</th>
          <th>${state.since === 'first' ? 'Since first' : 'Since last'}</th><th class="hide-sm">Trend</th></tr></thead>
        <tbody>${cats.map((c) => html`${cats.length > 1 ? html`<tr class="rp-cat"><th colspan="6" scope="colgroup">${c}</th></tr>` : ''}${tests.filter((t) => t.category === c).map((t) => {
          const ch = changeOf(t);
          const good = ch && ch.pct > 0, badc = ch && ch.pct < 0;
          return html`<tr><td><div class="strong">${t.name}</div><div class="sub">${t.count === 1 ? '1 test' : `${t.count} tests`} · ${scoring(t)}${t.hand_timed && t.unit === 's' ? ' · hand-timed' : ''}${coach && t.unshared ? html` · <span class="rp-unshared">Not shared yet</span>` : ''}</div></td>
            <td class="n hide-sm">${fmtValue(t.first, t.unit)}</td><td class="n">${fmtValue(t.latest, t.unit)}</td><td class="n strong">${fmtValue(t.best, t.unit)}</td>
            <td class="n ${good ? 'good' : badc ? 'bad' : 'muted'}">${ch ? html`${fmtChange(ch.change, t.unit)}<br>(${fmtPct(ch.pct)})` : 'First test'}</td>
            <td class="hide-sm">${t.history.length > 1 ? html`<span role="img" aria-label="${trendLabel(t)}" title="${trendLabel(t)}">${raw(trendSvg(t.history, t.lower_better))}</span>` : ''}</td></tr>`;
        })}`)}</tbody></table></section>` : ''}
      ${g ? html`<section><h2 class="rp-h">Growth</h2><div class="rp-tiles">
          <div class="rp-tile"><span class="rp-big">${fmtValue(g.height, 'in')}</span><span class="s">Height on ${fmtDate(g.date)}</span></div>
          <div class="rp-tile"><span class="rp-big">${statusWord(g.status)}</span><span class="s">the growth spurt (estimated peak around age ${g.phv_age.toFixed(1)})</span></div>
          <div class="rp-tile"><span class="rp-big">${fmtValue(g.weight, 'lb')}</span><span class="s">Weight · seated height ${fmtValue(g.seated_height, 'in')}</span></div></div>
        <p style="margin:12px 0 0;font-size:14px">${growthText(g)}</p>
        <p class="rp-foot" style="margin-top:4px">The growth-spurt estimate uses a standard formula (Mirwald, 2002) from height, seated height, weight, age and sex. It can be off by about a year either way, so treat it as a guide.</p></section>`
      : p.tests.length && p.view !== 'link' ? html`<p class="rp-foot">Growth estimate: needs birthday, sex, height, seated height and weight on file.</p>` : ''}
      ${p.days?.length ? html`<section><h2 class="rp-h">Testing days</h2><p style="margin:0;font-size:14px">${p.days.map((d) => `${d.name} (${fmtDate(d.date)})${coach && d.status !== 'shared' ? ', not shared yet' : ''}`).join(' · ')}</p></section>` : ''}
      <p class="rp-foot">${p.business || 'Diamond Protocol'} · Prepared ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.${multi ? ` Change is since the ${state.since === 'first' ? 'first' : 'previous'} test.` : ''}${anyHand ? ' Hand-timed sprints usually read a little faster than electronic timing.' : ''}</p>
    </article>`);
  document.getElementById('print').onclick = () => window.print();
  root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { if (b.getAttribute('aria-pressed') === 'true') return; state.view = b.dataset.view; load({ focus: `[data-view="${b.dataset.view}"]` }); }));
  root.querySelectorAll('[data-since]').forEach((b) => b.addEventListener('click', () => {
    state.since = b.dataset.since;
    try { localStorage.setItem('dp-report-since', state.since); } catch { /* storage blocked */ }
    render(p); root.querySelector(`[data-since="${state.since}"]`)?.focus();
  }));
  document.getElementById('period')?.addEventListener('change', (e) => { state.from = e.target.value; state.to = ''; load({ focus: '#period' }); });
  document.getElementById('share')?.addEventListener('click', () => shareDialog(p));
  document.getElementById('email')?.addEventListener('click', () => emailDialog(p));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied.'); }
  catch { toast('Select the link and copy it.', 'warn'); }
}

async function shareDialog(p) {
  const a = p.athlete;
  const base = `/report/${encodeURIComponent(a.code)}/links`;
  let links = [];
  try { links = await api.get(base); } catch (err) { return toastError(err); }
  const until = (l) => fmtDate(l.expires_at.slice(0, 10));
  const listHtml = () => (links.length ? html`<ul class="rp-links">${links.map((l) => html`<li>
      <div class="grow"><div class="strong">${l.label || 'Link'}</div><div class="small muted">Works until ${until(l)} · ${l.views ? `opened ${plural(l.views, 'time')}` : 'not opened yet'}${l.created_by ? ` · made by ${l.created_by}` : ''}</div></div>
      <button type="button" class="btn btn-sm" data-copy="${l.id}">Copy</button><button type="button" class="btn btn-ghost btn-sm" data-off="${l.id}" aria-label="Turn off ${l.label || 'this link'}">Turn off</button></li>`)}</ul>`
    : html`<p class="small muted" style="margin:0">No working links. Anyone you send a link to can see this report without signing in, until it expires or you turn it off.</p>`);
  await modal({
    title: 'Share a link',
    body: html`<p style="margin:0">Send ${a.first_name}'s report to a college coach, a school or family who don't have a sign-in. The link shows the family view: only results that have been shared, and no date of birth.</p>
      <form class="stack" id="nl" novalidate>
        <div class="form-grid"><div class="field"><label class="label" for="nl-l">Who's it for <span class="muted">(optional)</span></label><input class="input" id="nl-l" name="label" maxlength="60" placeholder="Like BYU recruiting"></div>
          <div class="field"><label class="label" for="nl-d">Works for</label><select class="input" id="nl-d" name="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></div></div>
        <div><button class="btn btn-outline" id="nl-go">Make a link</button></div>
        <div id="nl-new" aria-live="polite"></div>
      </form>
      <div><h3 class="rp-h" style="margin-top:4px">Working links</h3><div id="nl-list">${listHtml()}</div></div>`,
    onMount: (body) => {
      const f = body.querySelector('#nl');
      const paint = () => mount(body.querySelector('#nl-list'), listHtml());
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = f.querySelector('#nl-go'); btn.disabled = true;
        try {
          const l = await api.post(base, { label: f.label.value, days: Number(f.days.value) });
          links.unshift(l); paint();
          mount(body.querySelector('#nl-new'), html`<div class="field"><label class="label" for="nl-url">Your new link</label>
            <div class="rp-copyrow"><input class="input" id="nl-url" readonly value="${l.url}"><button type="button" class="btn btn-primary" id="nl-copy">Copy link</button></div></div>`);
          const u = body.querySelector('#nl-url'); u.focus(); u.select();
          body.querySelector('#nl-copy').onclick = () => copy(l.url);
          f.label.value = '';
        } catch (err) { toastError(err); } finally { btn.disabled = false; }
      });
      body.querySelector('#nl-list').addEventListener('click', async (e) => {
        const c = e.target.closest('[data-copy]');
        if (c) return copy(links.find((l) => String(l.id) === c.dataset.copy)?.url || '');
        const off = e.target.closest('[data-off]');
        if (!off) return;
        off.disabled = true;
        try {
          await api.del(`${base}/${off.dataset.off}`);
          links = links.filter((l) => String(l.id) !== off.dataset.off); paint();
          toast('Link turned off. It no longer opens the report.');
        } catch (err) { toastError(err); off.disabled = false; }
      });
    },
  });
}

async function emailDialog(p) {
  const a = p.athlete;
  const r = await modal({
    title: 'Email to family',
    body: html`<p style="margin:0">Sends ${a.first_name}'s family a summary with a link to this report. They see only results that have been shared.</p>
      <form class="stack" id="em" novalidate>
        <div class="field"><label class="label" for="em-n">Note from you <span class="muted">(optional)</span></label><textarea class="input" id="em-n" name="note" maxlength="2000" rows="4" placeholder="What stood out and what to work on next"></textarea></div>
        <label class="check"><input type="checkbox" name="include_link"> Include a link that opens without signing in (works for 90 days)</label>
        <span class="hint">Without it, parents sign in with their email address to open the report.</span></form>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Send email', kind: 'primary', onClick: async (body) => {
      const f = body.querySelector('#em');
      return api.post(`/report/${encodeURIComponent(a.code)}/email`, { note: f.note.value, include_link: f.include_link.checked });
    } }],
  });
  if (r) toast(`Report emailed to ${r.to.join(', ')}.`);
}

async function load({ focus } = {}) {
  syncUrl();
  try {
    const q = query();
    const p = await api.get(`/report/${encodeURIComponent(code)}${q ? '?' + q : ''}`, { noRedirect: true });
    render(p);
    if (focus) root.querySelector(focus)?.focus();
  } catch (e) {
    if (e.status === 401 || e.status === 403) return signIn();
    if (e.status === 410) return problem('Link no longer works', e.message, html`<a class="btn" href="/parent">Parents: sign in</a>`);
    if (e.status === 400 && (state.from || state.to)) { state.from = ''; state.to = ''; return load(); }
    problem('Report not found', e.status === 404 ? "There's no report for that Athlete ID on your account." : e.message);
  }
}

if (!code) signIn(); else load();
