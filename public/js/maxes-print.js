// The printable max report (owners and coaches signed in to the dashboard): athletes down, lifts across, totals and
// averages, the same filters as the screen (?contract_id=, ?program_id=, ?estimates=false). Print, or save as a PDF,
// from the browser's print dialog.
import { h, fill, btn } from './ui.js';

const q = new URLSearchParams(location.search);
const root = document.getElementById('root');
const search = q.toString() ? `?${q.toString()}` : '';
async function get(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Couldn't load (${res.status}).`);
  return data;
}
const when = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

async function main() {
  let r, settings, scope = null;
  try {
    [r, settings] = await Promise.all([get(`/v1/testing/max-report${search}`), get('/v1/settings')]);
    if (q.get('contract_id')) { const t = (await get('/v1/teams')).data.find((x) => x.id === q.get('contract_id')); scope = t ? `${t.org_name} ${t.name}` : 'One team'; }
    else if (q.get('program_id')) { const p = (await get('/v1/programs')).data.find((x) => x.id === q.get('program_id')); scope = p ? `On ${p.name}` : 'One program'; }
  } catch (e) { return fill(root, h('div', { class: 'rp-sheet' }, h('p', null, e.message), h('p', null, h('a', { href: '/' }, 'Sign in to the dashboard'), ' and open Testing → Max report.'))); }
  const business = settings.business_name ?? 'Diamond Protocol';
  document.title = `Max report · ${business}`;
  const num = (x, est) => (x == null ? h('span', { class: 'muted' }, '—') : h('span', { class: est ? 'mr-est' : 'mr-val' }, String(x)));
  const table = h('table', { class: 'rp-table mr-table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Athlete'), ...r.lifts.map((l) => h('th', { scope: 'col', class: 'num' }, `${l.name} (lb)`)), h('th', { scope: 'col', class: 'num' }, 'Total'))),
    h('tbody', null, r.athletes.map((a) => h('tr', null, h('td', null, h('span', { class: 'strong' }, a.name), a.athlete_id ? h('span', { class: 'small muted', style: 'margin-left:8px;font-family:var(--font-mono)' }, a.athlete_id) : null),
      ...r.lifts.map((l) => { const c = a.maxes[l.key]; return h('td', { class: 'num', title: c ? `${c.estimated ? 'Estimated' : 'On file'}, ${when(c.date)}` : '' }, num(c?.value, c?.estimated), c?.estimated ? h('span', { class: 'small muted' }, '*') : null); }),
      h('td', { class: 'num' }, num(a.total, a.estimated))))),
    h('tfoot', null, h('tr', null, h('td', { class: 'strong' }, 'Average'), ...r.lifts.map((l) => h('td', { class: 'num' }, num(r.averages[l.key]))), h('td', { class: 'num strong' }, num(r.average_total)))));
  const n = r.athletes.length;
  fill(root,
    h('div', { class: 'rp-actions rp-tools' }, btn('Print or save as PDF', () => window.print(), 'primary'), h('a', { class: 'dp-btn dp-btn--secondary', href: `/v1/testing/max-report.csv${search}` }, 'Download CSV'), h('a', { class: 'dp-btn dp-btn--ghost', href: '/#/testing/maxes' }, 'Back to Testing')),
    h('article', { class: 'rp-sheet' },
      h('header', { class: 'rp-head' }, h('div', null, h('div', { class: 'rp-name' }, 'Max report'), h('div', { class: 'rp-sub' }, [business, scope ?? 'Current athletes', `${n} ${n === 1 ? 'athlete' : 'athletes'}`].join(' · '))), h('img', { src: '/brand/mark.png', alt: '' })),
      n ? table : h('p', { class: 'muted' }, 'Nobody to show.'),
      r.with_estimates ? h('p', { class: 'small muted' }, '* Estimated from logged sets (no tested max on file).') : null,
      h('p', { class: 'rp-foot' }, `${business} · printed ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`)));
}
main();
