// Printable progress report (/report/:code). Staff get the coach view (includes unshared results);
// the athlete's family gets the parent view; anyone else is asked to sign in.
import { html, raw, mount, api, fmtDate, age } from '/js/ui.js';
import { fmtValue, fmtChange, fmtPct, scoring, trendSvg } from '/js/testing-format.js';

const root = document.getElementById('root');
const code = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const GROWTH_TESTS = ['Height', 'Seated height', 'Weight'];

function signIn() {
  document.title = 'Sign in · Diamond Protocol';
  mount(root, html`<div class="rp-auth panel">
    <img src="/img/logo-320.png" alt="Diamond Protocol, built under pressure" style="width:150px;margin:0 auto">
    <h1 class="page-title" style="font-size:24px">Sign in to see this report</h1>
    <p class="muted" style="margin:0">Progress reports are private to the athlete's family and coaches.</p>
    <a class="btn btn-primary" href="/parent">Parents: sign in</a>
    <a class="btn btn-ghost" href="/">Staff: sign in</a>
  </div>`);
}

function growthText(g) {
  const yrs = Math.abs(g.maturity_offset).toFixed(1);
  if (g.maturity_offset > 1) return `About ${yrs} years past the fastest growth. Strength gains usually come more easily from here.`;
  if (g.maturity_offset > 0) return `About ${yrs} years past the fastest growth. Growth is slowing; keep building strength and landing mechanics.`;
  if (g.maturity_offset >= -1) return `About ${yrs} years before the fastest growth is expected. Coordination can dip for a while; keep sprint and landing mechanics sharp.`;
  return `About ${yrs} years before the fastest growth is expected. A great time to build movement skills and speed.`;
}
const statusWord = (s) => (/before/i.test(s) ? 'Before' : /after/i.test(s) ? 'After' : 'In');

function render(p) {
  const a = p.athlete;
  const coach = p.view === 'coach';
  const fullName = `${a.first_name} ${a.last_name}`;
  document.title = `${fullName} progress report · ${p.business || 'Diamond Protocol'}`;
  const tests = p.tests.filter((t) => !GROWTH_TESTS.includes(t.name));
  const anyHand = p.tests.some((t) => t.hand_timed && t.unit === 's');
  const meta = [a.code, a.birthday ? `Age ${age(a.birthday)}` : '', a.sport, a.position, a.school].filter(Boolean).join(' · ');
  const range = p.first_date ? (p.first_date === p.last_date ? fmtDate(p.first_date) : `${fmtDate(p.first_date)} to ${fmtDate(p.last_date)}`) : '';
  const g = p.growth;
  mount(root, html`
    <div class="btn-row no-print"><button class="btn btn-primary" id="print">Print or save as PDF</button>
      ${coach ? html`<a class="btn btn-ghost" href="/app/clients/${a.id}">Back to the athlete</a>` : html`<a class="btn btn-ghost" href="/parent">Back to Progress</a>`}</div>
    ${coach && p.unshared ? html`<div class="banner rp-coach small">Coach view: includes results that haven't been shared with the family yet.</div>`
    : coach ? html`<div class="banner info small no-print">Coach view. Every result here has been shared with the family.</div>` : ''}
    <article class="rp-card">
      <header class="rp-head"><div><h1 class="rp-name">${fullName}</h1><p class="rp-meta">${meta}</p>
        <p class="rp-meta">Progress report${range ? ` · ${range}` : ''}</p></div>
        <div class="rp-logo"><img src="/img/logo-320.png" alt="Diamond Protocol, built under pressure"></div></header>
      ${!p.tests.length ? html`<p class="muted" style="margin:0">No results ${coach ? 'yet' : 'have been shared yet'}. After the next testing day, results show up here.</p>` : ''}
      ${p.note ? html`<section><h2 class="rp-h">From your coach · ${p.note.day_name}</h2><p class="rp-note">${p.note.text}</p></section>` : ''}
      ${p.improvements.length ? html`<section><h2 class="rp-h">Biggest improvements</h2><div class="rp-tiles">${p.improvements.map((i) => html`<div class="rp-tile">
        <span class="rp-big">${fmtPct(i.pct)}</span><span class="t">${i.test}</span><span class="s">${fmtValue(i.first, i.unit)} → ${fmtValue(i.latest, i.unit)}</span></div>`)}</div></section>` : ''}
      ${p.prs.length ? html`<p style="margin:0"><strong>New personal records:</strong> ${p.prs.map((x) => `${x.test} (${fmtValue(x.value, x.unit)})`).join(', ')}.</p>` : ''}
      ${tests.length ? html`<section><h2 class="rp-h">Every test</h2><table class="rp-table"><thead><tr><th>Test</th><th class="hide-sm">First</th><th>Latest</th><th>Best</th><th>Change</th><th class="hide-sm">Trend</th></tr></thead>
        <tbody>${tests.map((t) => {
          const good = t.pct > 0, badc = t.pct < 0;
          return html`<tr><td><div class="strong">${t.name}</div><div class="sub">${t.count === 1 ? '1 test' : `${t.count} tests`} · ${scoring(t)}${t.hand_timed && t.unit === 's' ? ' · hand-timed' : ''}</div></td>
            <td class="n hide-sm">${fmtValue(t.first, t.unit)}</td><td class="n">${fmtValue(t.latest, t.unit)}</td><td class="n strong">${fmtValue(t.best, t.unit)}</td>
            <td class="n ${good ? 'good' : badc ? 'bad' : 'muted'}">${t.count > 1 ? html`${fmtChange(t.change, t.unit)}<br>(${fmtPct(t.pct)})` : 'First test'}</td>
            <td class="hide-sm">${raw(trendSvg(t.history, t.lower_better))}</td></tr>`;
        })}</tbody></table></section>` : ''}
      ${g ? html`<section><h2 class="rp-h">Growth</h2><div class="rp-tiles">
          <div class="rp-tile"><span class="rp-big">${fmtValue(g.height, 'in')}</span><span class="s">Height on ${fmtDate(g.date)}</span></div>
          <div class="rp-tile"><span class="rp-big">${statusWord(g.status)}</span><span class="s">the growth spurt (estimated peak around age ${g.phv_age.toFixed(1)})</span></div>
          <div class="rp-tile"><span class="rp-big">${fmtValue(g.weight, 'lb')}</span><span class="s">Weight · seated height ${fmtValue(g.seated_height, 'in')}</span></div></div>
        <p style="margin:12px 0 0;font-size:14px">${growthText(g)}</p>
        <p class="rp-foot" style="margin-top:4px">The growth-spurt estimate uses a standard formula (Mirwald, 2002) from height, seated height, weight, age and sex. It can be off by about a year either way, so treat it as a guide.</p></section>`
      : p.tests.length ? html`<p class="rp-foot">Growth estimate: needs birthday, sex, height, seated height and weight on file.</p>` : ''}
      ${p.days?.length ? html`<section><h2 class="rp-h">Testing days</h2><p style="margin:0;font-size:14px">${p.days.map((d) => `${d.name} (${fmtDate(d.date)})${coach && d.status !== 'shared' ? ', not shared yet' : ''}`).join(' · ')}</p></section>` : ''}
      <p class="rp-foot">${p.business || 'Diamond Protocol'} · Prepared ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.${anyHand ? ' Hand-timed sprints usually read a little faster than electronic timing.' : ''}</p>
    </article>`);
  document.getElementById('print').onclick = () => window.print();
}

(async () => {
  if (!code) return signIn();
  try { render(await api.get(`/report/${encodeURIComponent(code)}`)); }
  catch (e) {
    if (e.status === 401 || e.status === 403) return signIn();
    mount(root, html`<div class="rp-auth panel"><h1 class="page-title" style="font-size:24px">Report not found</h1>
      <p class="muted" style="margin:0">${e.status === 404 ? "There's no report for that Athlete ID on your account." : e.message}</p><a class="btn" href="/parent">Go to the parent portal</a></div>`);
  }
})();
