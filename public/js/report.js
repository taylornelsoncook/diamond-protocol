import { h, fill, btn } from './ui.js';
import { sparkline, fmtResult, fmtDate } from './charts.js';

// One page for parents (?athlete=, signed in to the portal) and coaches (?client=, signed in to the dashboard).
const q = new URLSearchParams(location.search);
const root = document.getElementById('root');
const url = q.get('athlete') ? `/portal/api/athletes/${encodeURIComponent(q.get('athlete'))}/report` : `/v1/clients/${encodeURIComponent(q.get('client'))}/report${q.get('parent_view') ? '?parent_view=true' : ''}`;

async function load() {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) return fill(root, h('div', { class: 'dp-panel' }, h('h1', { class: 'dp-panel-title' }, res.status === 401 ? 'Please sign in first' : 'Report not found'), h('p', { class: 'muted' }, res.status === 401 ? 'Open this report from the parent portal or the coach dashboard.' : 'Check the link.')));
  render(await res.json());
}

function render(r) {
  const a = r.athlete;
  document.title = `${a.name} · Progress report`;
  const g = r.growth;
  const growthBits = [];
  if (g.latest_height) growthBits.push(h('div', { class: 'rp-card' }, h('b', null, fmtResult(g.latest_height.value, 'in', 1)), h('span', null, `Height on ${fmtDate(g.latest_height.date)}`)));
  if (g.growth_per_year) growthBits.push(h('div', { class: 'rp-card' }, h('b', null, `${g.growth_per_year.toFixed(1)} in`), h('span', null, 'Growth per year, recently')));
  if (g.estimate) growthBits.push(h('div', { class: 'rp-card' }, h('b', null, { before: 'Before', during: 'During', after: 'After' }[g.estimate.phase]), h('span', null, `the growth spurt (estimated peak around age ${g.estimate.peak_age})`)));
  const tests = r.tests;
  fill(root,
    h('div', { class: 'rp-actions' }, btn('Print or save as PDF', () => window.print(), 'primary'), q.get('athlete') ? h('a', { class: 'dp-btn dp-btn--ghost', href: '/parent' }, 'Back to the portal') : h('a', { class: 'dp-btn dp-btn--ghost', href: `/#/clients/${a.id}` }, 'Back to the athlete')),
    r.visibility === 'coach' ? h('p', { class: 'test-banner' }, 'Coach view: includes results that haven\'t been shared with the family yet.') : null,
    h('article', { class: 'rp-sheet' },
      h('div', { class: 'rp-head' },
        h('div', null, h('div', { class: 'rp-name' }, a.name), h('div', { class: 'rp-sub' }, [a.athlete_id, a.age != null ? `Age ${a.age}` : null, a.sport, a.position, a.school, a.grad_year ? `Class of ${a.grad_year}` : null].filter(Boolean).join(' · ')),
          h('div', { class: 'rp-sub' }, r.period ? `Progress report · ${fmtDate(r.period.from)} to ${fmtDate(r.period.to)}` : 'Progress report')),
        h('img', { src: '/brand/logo.png', alt: r.business.name })),
      !tests.length ? h('p', { class: 'muted' }, r.visibility === 'shared' ? 'No results have been shared yet. Your coach will let you know when testing results are ready.' : 'No test results yet.') : null,
      r.latest_session?.athlete_note || r.latest_session?.parent_note ? h('section', null, h('h2', { class: 'rp-h' }, `From your coach · ${r.latest_session.name}`),
        [r.latest_session.athlete_note, r.latest_session.parent_note].filter(Boolean).map((t) => h('div', { class: 'rp-note' }, t))) : null,
      r.highlights.length ? h('section', null, h('h2', { class: 'rp-h' }, 'Biggest improvements'), h('div', { class: 'rp-cards' }, r.highlights.map((t) => h('div', { class: 'rp-card' },
        h('b', null, `+${t.improvement_pct}%`), h('span', { class: 'strong', style: 'color:var(--steel)' }, `${t.test_name}${t.side ? ` (${t.side === 'L' ? 'left' : 'right'})` : ''}`), h('span', null, `${fmtResult(t.first.value, t.unit, t.decimals)} → ${fmtResult(t.latest.value, t.unit, t.decimals)}`))))) : null,
      r.new_prs.length ? h('p', null, h('strong', null, 'New personal records: '), r.new_prs.join(', '), '.') : null,
      tests.length ? h('section', null, h('h2', { class: 'rp-h' }, 'Every test'), h('div', { style: 'overflow-x:auto' }, h('table', { class: 'rp-table' },
        h('thead', null, h('tr', null, h('th', null, 'Test'), h('th', null, 'First'), h('th', null, 'Latest'), h('th', null, 'Best'), h('th', null, 'Change'), h('th', { class: 'rp-hide-sm' }, 'Trend'))),
        h('tbody', null, tests.map((t) => h('tr', null,
          h('td', null, h('div', { class: 'strong' }, `${t.test_name}${t.side ? ` (${t.side === 'L' ? 'left' : 'right'})` : ''}`), h('div', { class: 'small muted' }, `${t.tests_count} ${t.tests_count === 1 ? 'test' : 'tests'} · ${t.better === 'lower' ? 'lower is better' : 'higher is better'}`)),
          h('td', { class: 'num' }, fmtResult(t.first.value, t.unit, t.decimals)),
          h('td', { class: 'num' }, fmtResult(t.latest.value, t.unit, t.decimals)),
          h('td', { class: 'num strong' }, fmtResult(t.best, t.unit, t.decimals)),
          h('td', { class: `num ${t.improved ? 'rp-up' : t.change ? 'rp-down' : ''}` }, t.tests_count > 1 ? `${fmtResult(t.change, t.unit, t.decimals, { delta: true })}${t.improvement_pct != null ? ` (${t.improvement_pct > 0 ? '+' : ''}${t.improvement_pct}%)` : ''}` : 'First test'),
          h('td', { class: 'rp-spark rp-hide-sm' }, sparkline(t.history, { better: t.better, label: `${t.test_name} trend` })))))))) : null,
      growthBits.length || g.missing.length || g.note ? h('section', null, h('h2', { class: 'rp-h' }, 'Growth'),
        growthBits.length ? h('div', { class: 'rp-cards' }, growthBits) : null,
        g.estimate ? h('p', { class: 'small', style: 'margin-top:12px' }, g.estimate.text) : null,
        g.estimate ? h('p', { class: 'rp-foot' }, 'The growth-spurt estimate uses a standard formula from height, seated height, weight, age and sex. It can be off by about a year either way, so treat it as a guide.') : null,
        g.note ? h('p', { class: 'small muted' }, g.note) : null,
        !g.estimate && g.missing.length && !g.note ? h('p', { class: 'small muted' }, `A growth-spurt estimate needs ${g.missing.join(', ')}.`) : null) : null,
      r.sessions.length ? h('section', null, h('h2', { class: 'rp-h' }, 'Testing days'), h('p', { class: 'small' }, r.sessions.map((s) => `${s.name} (${fmtDate(s.date)})`).join(' · '))) : null,
      h('p', { class: 'rp-foot' }, `${r.business.name} · Prepared ${new Date(r.generated_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. Hand-timed sprints usually read a little faster than electronic timing.`)));
}
load();
