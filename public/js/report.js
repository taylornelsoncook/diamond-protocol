import { h, fill, btn, busy, toast } from './ui.js';
import { sparkline, fmtResult, fmtDate } from './charts.js';

// One page for three readers: parents (?athlete=, signed in to the portal), staff (?client=, signed in to the dashboard;
// &parent_view=true previews the family view) and anyone with a share link (#share=<secret>, no sign-in). The link's
// secret stays in the address fragment and goes to the server in a header, so it never lands in an address or a log.
const q = new URLSearchParams(location.search);
const root = document.getElementById('root');
const share = new URLSearchParams(location.hash.slice(1)).get('share');
const mode = share ? 'link' : q.get('athlete') ? 'parent' : 'staff';
const familyPreview = mode === 'staff' && q.get('parent_view') === 'true';
const id = encodeURIComponent(q.get('athlete') ?? q.get('client') ?? '');
const base = mode === 'parent' ? `/portal/api/athletes/${id}` : `/v1/clients/${id}`;
// The parent portal's Progress tab opens the printable report on the period it was showing (?from=YYYY-MM-DD).
const startFrom = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') ?? '') ? q.get('from') : '';
const period = { from: startFrom, to: '', key: startFrom ? `day:${startFrom}` : 'all' };
let since = 'first';
try { since = localStorage.getItem('dp-report-since') === 'last' ? 'last' : 'first'; } catch { /* private window: keep the default */ }
let opened = false;
window.addEventListener('hashchange', () => location.reload());     // another share link pasted into the same tab

async function call(method, path, body) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(share ? { 'x-report-link': share } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error?.message || 'Something went wrong. Try again.'); e.status = res.status; throw e; }
  return data;
}
const notice = (title, text, link) => fill(root, h('div', { class: 'dp-panel stack' }, h('h1', { class: 'dp-panel-title' }, title), h('p', { class: 'muted', style: 'margin:0' }, text), link ?? null));

async function load() {
  const qs = new URLSearchParams({ ...(period.from ? { from: period.from } : {}), ...(period.to ? { to: period.to } : {}), ...(familyPreview ? { parent_view: 'true' } : {}), ...(share && !opened ? { open: '1' } : {}) }).toString();
  try {
    const r = await call('GET', `${share ? '/portal/api/public/report' : `${base}/report`}${qs ? `?${qs}` : ''}`);
    opened = true;                     // changing the period isn't another open
    render(r);
  } catch (e) {
    if (e.status === 410 || (share && e.status === 404)) return notice('This link no longer works', e.message);
    if (e.status === 401) return notice('Please sign in first', 'Open this report from the parent portal or the coach dashboard.', h('a', { class: 'dp-btn dp-btn--secondary', href: '/parent' }, 'Go to the parent portal'));
    notice('Report not found', e.status === 404 ? 'Check the link.' : e.message);
  }
}

const sideText = (s) => (s ? ` (${s === 'L' ? 'left' : 'right'})` : '');
function periodPicker(r) {
  const days = r.all_sessions ?? [];
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const opts = [['all', 'All time'], ['12m', 'Last 12 months'], ...days.map((d) => [`day:${d.date}`, `Since ${d.name} (${fmtDate(d.date)})`])];
  const sel = h('select', { class: 'select', 'aria-label': 'Period', onChange: () => {
    const v = sel.value;
    period.key = v; period.to = '';
    period.from = v === '12m' ? yearAgo : v.startsWith('day:') ? v.slice(4) : '';
    load();
  } }, opts.map(([v, label]) => h('option', { value: v, selected: period.key === v }, label)));
  const sinceSel = h('select', { class: 'select', 'aria-label': 'Change since', onChange: () => { since = sinceSel.value; try { localStorage.setItem('dp-report-since', since); } catch { /* not saved */ } render(r); } },
    [['first', 'Change since the first test'], ['last', 'Change since the last test']].map(([v, label]) => h('option', { value: v, selected: since === v }, label)));
  return h('div', { class: 'rp-tools rp-filters' }, h('label', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Period'), sel), h('label', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Change'), sinceSel));
}

// Share links: make one (7 days to a year), see how often each was opened, turn it off.
function sharePanel(r) {
  const box = h('div', { class: 'stack-tight' });
  const days = h('select', { class: 'select', 'aria-label': 'How long the link works' }, [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']].map(([v, label]) => h('option', { value: v, selected: v === 30 }, label)));
  const label = h('input', { class: 'dp-input', maxlength: '60', placeholder: 'Who it\'s for, like Grandma or a recruiter', 'aria-label': 'Who the link is for (optional)' });
  const made = h('div', { 'aria-live': 'polite' });
  async function refresh() {
    const links = (await call('GET', `${base}/report-links`)).data;
    fill(box, links.length ? links.map((l) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('span', { class: 'strong' }, l.label || 'Link'),
        h('span', { class: 'small muted' }, `Made by ${l.created_by_name ?? 'staff'} on ${fmtDate(l.created_at)} · works until ${fmtDate(l.expires_at)} · opened ${l.views} ${l.views === 1 ? 'time' : 'times'}${l.last_viewed_at ? `, last on ${fmtDate(l.last_viewed_at)}` : ''}`)),
      btn('Turn off', (e) => { if (confirm('Turn off this link? Anyone who has it will no longer see the report.')) busy(e.currentTarget, async () => { await call('DELETE', `${base}/report-links/${encodeURIComponent(l.id)}`); toast('Link turned off.'); refresh(); }); }, 'ghost', { style: 'min-height:44px', 'aria-label': `Turn off ${l.label || 'link'}` })))
      : h('p', { class: 'small muted', style: 'margin:0' }, 'No working links.'));
  }
  const makeBtn = btn('Make a link', (e) => busy(e.currentTarget, async () => {
    const l = await call('POST', `${base}/report-links`, { days: Number(days.value), label: label.value });
    label.value = '';
    const field = h('input', { class: 'dp-input', readonly: true, value: l.url, 'aria-label': 'The new link', onFocus: (ev) => ev.target.select() });
    fill(made, h('div', { class: 'rp-note stack-tight' }, h('span', { class: 'small' }, `Copy this link now: it's only shown once. It works until ${fmtDate(l.expires_at)} and never shows the date of birth.`),
      h('div', { class: 'row', style: 'gap:8px' }, field, btn('Copy', (ev) => busy(ev.currentTarget, async () => { await navigator.clipboard.writeText(l.url); toast('Link copied.'); }), 'secondary', { style: 'min-height:44px' }))));
    field.focus();
    refresh();
  }), 'secondary', { style: 'min-height:44px' });
  refresh().catch((e) => fill(box, h('p', { class: 'small muted' }, e.message)));
  return h('section', { class: 'dp-panel rp-tools stack' }, h('h2', { class: 'dp-panel-title' }, 'Share a link'),
    h('p', { class: 'small muted', style: 'margin:0' }, `Anyone with the link sees ${r.athlete.name.split(' ')[0]}'s report as the family does, without signing in, until it expires or you turn it off. Share it only with people you trust.`),
    h('div', { class: 'rp-share-form' }, label, days, makeBtn), made, box);
}

// Staff: email the family a summary with the report link.
function emailPanel(r) {
  const note = h('textarea', { class: 'dp-input', rows: '3', maxlength: '2000', placeholder: 'A note from you (optional)', 'aria-label': 'A note for the family (optional)' });
  const withLink = h('input', { type: 'checkbox' });
  return h('section', { class: 'dp-panel rp-tools stack' }, h('h2', { class: 'dp-panel-title' }, 'Email the family'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Sends the biggest improvements and new records from what the family can see, with a link to the full report.'),
    note, h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, withLink, 'Add a 90-day link so they don\'t need to sign in'),
    h('div', null, btn('Send to the family', (e) => busy(e.currentTarget, async () => {
      const out = await call('POST', `${base}/report/email`, { note: note.value, include_link: withLink.checked });
      note.value = ''; withLink.checked = false;
      toast(`Sent to ${out.emailed} ${out.emailed === 1 ? 'parent' : 'parents'}.`);
    }), 'secondary', { style: 'min-height:44px' })));
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
  const coach = r.visibility === 'coach';
  const last = since === 'last';
  const change = (t) => (last ? { value: t.change_last, pct: t.improvement_pct_last, improved: t.improved_last, has: t.previous != null } : { value: t.change, pct: t.improvement_pct, improved: t.improved, has: t.tests_count > 1 });
  const cats = (r.categories ?? []).filter((c) => tests.some((t) => t.category === c.key));
  const row = (t) => {
    const c = change(t);
    const trend = `${t.test_name}${sideText(t.side)}: ${t.history.map((p) => `${fmtResult(p.value, t.unit, t.decimals)} on ${fmtDate(p.date)}`).join(', ')}. ${t.better === 'lower' ? 'Lower' : 'Higher'} is better.`;
    return h('tr', null,
      h('td', null, h('div', { class: 'strong' }, `${t.test_name}${sideText(t.side)}`),
        h('div', { class: 'small muted' }, `${t.tests_count} ${t.tests_count === 1 ? 'test' : 'tests'} · ${t.better === 'lower' ? 'lower is better' : 'higher is better'}`),
        coach && t.unshared_days ? h('span', { class: 'rp-unshared' }, t.unshared_days === t.tests_count ? 'Not shared yet' : `${t.unshared_days} not shared yet`) : null),
      h('td', { class: 'num' }, fmtResult(last ? t.previous?.value : t.first.value, t.unit, t.decimals)),
      h('td', { class: 'num' }, fmtResult(t.latest.value, t.unit, t.decimals)),
      h('td', { class: 'num strong' }, fmtResult(t.best, t.unit, t.decimals)),
      h('td', { class: `num ${c.improved ? 'rp-up' : c.value ? 'rp-down' : ''}` }, c.has ? `${fmtResult(c.value, t.unit, t.decimals, { delta: true })}${c.pct != null ? ` (${c.pct > 0 ? '+' : ''}${c.pct}%)` : ''}` : 'First test'),
      h('td', { class: 'rp-spark rp-hide-sm' }, sparkline(t.history, { better: t.better, label: trend })));
  };
  const head = () => h('thead', null, h('tr', null, h('th', null, 'Test'), h('th', null, last ? 'Previous' : 'First'), h('th', null, 'Latest'), h('th', null, 'Best'), h('th', null, last ? 'Since last' : 'Change'), h('th', { class: 'rp-hide-sm' }, 'Trend')));
  const canShare = r.can_share && mode !== 'link' && !familyPreview;
  fill(root,
    mode === 'link' ? null : h('div', { class: 'rp-actions' }, btn('Print or save as PDF', () => window.print(), 'primary'),
      mode === 'parent' ? h('a', { class: 'dp-btn dp-btn--ghost', href: '/parent?tab=progress' }, 'Back to Progress')
        : [h('a', { class: 'dp-btn dp-btn--secondary', href: familyPreview ? `/report.html?client=${id}` : `/report.html?client=${id}&parent_view=true` }, familyPreview ? 'Coach view' : 'Family view'),
          h('a', { class: 'dp-btn dp-btn--ghost', href: `/#/clients/${a.id}` }, 'Back to the athlete')]),
    mode === 'link' ? h('div', { class: 'rp-actions' }, btn('Print or save as PDF', () => window.print(), 'primary')) : null,
    coach ? h('p', { class: 'test-banner' }, r.unshared_tests ? `Coach view: ${r.unshared_tests} ${r.unshared_tests === 1 ? 'test has' : 'tests have'} results the family can't see yet (marked Not shared yet). Share the testing day to show them.` : 'Coach view: everything here is shared with the family.') : null,
    familyPreview ? h('p', { class: 'test-banner' }, 'Family view: exactly what the family sees.') : null,
    periodPicker(r),
    h('article', { class: 'rp-sheet' },
      h('div', { class: 'rp-head' },
        h('div', null, h('div', { class: 'rp-name' }, a.name), h('div', { class: 'rp-sub' }, [a.athlete_id, a.age != null ? `Age ${a.age}` : null, a.sport, a.position, a.school, a.grad_year ? `Class of ${a.grad_year}` : null].filter(Boolean).join(' · ')),
          h('div', { class: 'rp-sub' }, r.period ? `Progress report · ${fmtDate(r.period.from)} to ${fmtDate(r.period.to)}` : 'Progress report')),
        h('img', { src: '/brand/logo.png', alt: r.business.name })),
      !tests.length ? h('p', { class: 'muted' }, r.filter?.from ? 'No results in this period. Choose All time to see everything.' : r.visibility === 'shared' ? 'No results have been shared yet. Your coach will let you know when testing results are ready.' : 'No test results yet.') : null,
      r.latest_session?.athlete_note || r.latest_session?.parent_note ? h('section', null, h('h2', { class: 'rp-h' }, `From your coach · ${r.latest_session.name}`),
        [r.latest_session.athlete_note, r.latest_session.parent_note].filter(Boolean).map((t) => h('div', { class: 'rp-note' }, t))) : null,
      r.highlights.length ? h('section', null, h('h2', { class: 'rp-h' }, 'Biggest improvements'), h('div', { class: 'rp-cards' }, r.highlights.map((t) => h('div', { class: 'rp-card' },
        h('b', null, `+${t.improvement_pct}%`), h('span', { class: 'strong', style: 'color:var(--steel)' }, `${t.test_name}${sideText(t.side)}`), h('span', null, `${fmtResult(t.first.value, t.unit, t.decimals)} → ${fmtResult(t.latest.value, t.unit, t.decimals)}`))))) : null,
      r.new_prs.length ? h('p', null, h('strong', null, 'New personal records: '), r.new_prs.join(', '), '.') : null,
      tests.length ? h('section', null, h('h2', { class: 'rp-h' }, 'Every test'), cats.map((c) => h('div', { class: 'rp-cat' }, h('h3', { class: 'rp-cat-h' }, c.name),
        h('div', { style: 'overflow-x:auto' }, h('table', { class: 'rp-table' }, h('caption', { class: 'rp-sr' }, `${c.name} results`), head(), h('tbody', null, tests.filter((t) => t.category === c.key).map(row))))))) : null,
      growthBits.length || g.missing.length || g.note ? h('section', null, h('h2', { class: 'rp-h' }, 'Growth'),
        growthBits.length ? h('div', { class: 'rp-cards' }, growthBits) : null,
        g.estimate ? h('p', { class: 'small', style: 'margin-top:12px' }, g.estimate.text) : null,
        g.estimate ? h('p', { class: 'rp-foot' }, 'The growth-spurt estimate uses a standard formula from height, seated height, weight, age and sex. It can be off by about a year either way, so treat it as a guide.') : null,
        g.note ? h('p', { class: 'small muted' }, g.note) : null,
        !g.estimate && g.missing.length && !g.note ? h('p', { class: 'small muted' }, `A growth-spurt estimate needs ${g.missing.join(', ')}.`) : null) : null,
      r.sessions.length ? h('section', null, h('h2', { class: 'rp-h' }, 'Testing days'), h('p', { class: 'small' }, r.sessions.map((s) => `${s.name} (${fmtDate(s.date)})${coach && !s.shared_at ? ' · not shared yet' : ''}`).join(' · '))) : null,
      h('p', { class: 'rp-foot' }, `${r.business.name} · Prepared ${new Date(r.generated_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. Hand-timed sprints usually read a little faster than electronic timing.`)),
    canShare ? sharePanel(r) : null,
    canShare && mode === 'staff' ? emailPanel(r) : null);
}
load();
