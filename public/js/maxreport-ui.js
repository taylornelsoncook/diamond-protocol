import { h, fill, toast, btn, busy, select, panel } from './ui.js';

// Testing → Max report (#/testing/maxes; the builder redesign, step 4, from the owner's screenshot): athletes down,
// lifts across, each athlete's max on file (or the estimate from logged sets, in grey), a total per athlete and an
// average per lift. Filter by team or program, sort by any column, print it or download the CSV, and type a max
// straight into a cell. Owners and coaches; front desk has no part in it.
const when = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const filters = { contract_id: '', program_id: '', estimates: true, sort: 'name', dir: 1 };

export function queryOf(f = filters) {
  const q = new URLSearchParams();
  if (f.contract_id) q.set('contract_id', f.contract_id);
  if (f.program_id) q.set('program_id', f.program_id);
  if (f.estimates === false) q.set('estimates', 'false');
  const s = q.toString();
  return s ? `?${s}` : '';
}
export function sortRows(rows, sort, dir) {
  const val = (a) => (sort === 'name' ? a.name.toLowerCase() : sort === 'total' ? a.total : a.maxes[sort]?.value ?? null);
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1;                                                   // empty cells sink whatever the direction
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name);
  });
}
export const cellTitle = (cell, lift) => (!cell ? `No ${lift.name.toLowerCase()} max on file. Click to type one.`
  : cell.estimated ? `Estimated from logged sets${cell.from ? ` (${cell.from.weight} lb × ${cell.from.reps} on ${when(cell.from.date)})` : ''}. Click to type a tested max.`
  : `${lift.name} max on file, ${when(cell.date)}. Click to type a new one.`);

export async function viewMaxReport(main, { api, header }) {
  const get = (p) => api('GET', p), post = (p, b = {}) => api('POST', p, b);
  const qs = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (qs.has('contract_id')) filters.contract_id = qs.get('contract_id');
  if (qs.has('program_id')) filters.program_id = qs.get('program_id');
  const [teams, programs] = await Promise.all([get('/v1/teams'), get('/v1/programs')]);
  const body = h('div', { class: 'table-wrap' });
  const note = h('p', { class: 'small muted' });
  const team = select([['', 'Everyone current'], ...teams.data.map((t) => [t.id, `${t.org_name} ${t.name}`])], { value: filters.contract_id, 'aria-label': 'Team', onChange: (e) => { filters.contract_id = e.target.value; if (filters.contract_id) { filters.program_id = ''; program.value = ''; } load(); } });
  const program = select([['', 'Any program'], ...programs.data.map((p) => [p.id, p.name])], { value: filters.program_id, 'aria-label': 'Program', onChange: (e) => { filters.program_id = e.target.value; if (filters.program_id) { filters.contract_id = ''; team.value = ''; } load(); } });
  const est = h('input', { type: 'checkbox', checked: filters.estimates, onChange: (e) => { filters.estimates = e.target.checked; load(); } });
  const print = h('a', { class: 'dp-btn dp-btn--secondary', target: '_blank', rel: 'noopener' }, 'Print or PDF');
  const csv = h('a', { class: 'dp-btn dp-btn--secondary' }, 'Download CSV');
  const links = () => { print.href = `/maxes.html${queryOf()}`; csv.href = `/v1/testing/max-report.csv${queryOf()}`; };

  async function load() {
    links();
    let r;
    try { r = await get(`/v1/testing/max-report${queryOf()}`); } catch (e) { return fill(body, h('div', { class: 'empty' }, e.message)); }
    draw(r);
  }
  function draw(r) {
    const sortBtn = (key, label, extra) => h('button', { type: 'button', class: `mr-sort${filters.sort === key ? ' is-on' : ''}`, 'aria-sort': filters.sort === key ? (filters.dir === 1 ? 'ascending' : 'descending') : undefined,
      onClick: () => { if (filters.sort === key) filters.dir = -filters.dir; else { filters.sort = key; filters.dir = key === 'name' ? 1 : -1; } draw(r); } }, label, extra ?? null, filters.sort === key ? h('span', { 'aria-hidden': 'true' }, filters.dir === 1 ? ' ↑' : ' ↓') : null);
    const rows = sortRows(r.athletes, filters.sort, filters.dir);
    const cell = (a, l) => {
      const c = a.maxes[l.key];
      const text = c ? h('span', { class: c.estimated ? 'mr-est' : 'mr-val' }, String(c.value)) : h('span', { class: 'muted' }, '—');
      if (!l.lift) return h('td', { class: 'num', title: c ? `${l.name}, ${when(c.date)}` : `No ${l.name.toLowerCase()} result on file. It comes from a testing day.` }, text);
      return h('td', { class: 'num mr-cell' }, h('button', { type: 'button', class: 'mr-edit', title: cellTitle(c, l), 'aria-label': `${a.name}, ${l.name}: ${c ? `${c.value} lb${c.estimated ? ', estimated' : ''}` : 'nothing on file'}. Type a max.`, onClick: (e) => edit(e.currentTarget, a, l, c) }, text));
    };
    const edit = (button, a, l, c) => {
      const td = button.parentElement;
      const inp = h('input', { type: 'number', class: 'dp-input mr-input', min: '1', step: '5', value: c && !c.estimated ? String(c.value) : '', 'aria-label': `${a.name}'s ${l.name.toLowerCase()} max in pounds`, placeholder: 'lb' });
      let done = false;
      const back = () => { if (done) return; done = true; fill(td, button); };
      const save = async () => {
        if (done) return;
        const value = Number(inp.value);
        if (!inp.value.trim()) return back();
        if (!Number.isFinite(value) || value <= 0) { toast('Type the max as a number of pounds, like 185.', 'warn'); inp.focus(); return; }
        done = true; inp.disabled = true;
        try { await post(`/v1/clients/${a.id}/maxes`, { test: l.key, value, note: 'Typed on the max report' }); toast(`${a.name}: ${l.name.toLowerCase()} max saved, ${value} lb.`); await load(); }
        catch (e) { toast(e.message, 'warn'); done = false; inp.disabled = false; inp.focus(); }
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') back(); });
      inp.addEventListener('blur', () => { if (inp.value.trim()) save(); else back(); });
      fill(td, inp); inp.focus(); inp.select();
    };
    fill(body, rows.length ? h('table', { class: 'table mr-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, sortBtn('name', 'Athlete')), ...r.lifts.map((l) => h('th', { scope: 'col', class: 'num' }, sortBtn(l.key, l.name, h('span', { class: 'small muted' }, ' lb')))), h('th', { scope: 'col', class: 'num' }, sortBtn('total', 'Total')))),
      h('tbody', null, rows.map((a) => h('tr', null, h('td', null, h('a', { href: `#/clients/${a.id}?tab=testing`, class: 'strong', style: 'color:inherit' }, a.name), a.athlete_id ? h('span', { class: 'small muted', style: 'margin-left:8px;font-family:var(--font-mono)' }, a.athlete_id) : null), ...r.lifts.map((l) => cell(a, l)), h('td', { class: 'num' }, a.total != null ? h('span', { class: a.estimated ? 'mr-est' : 'mr-val strong' }, String(a.total)) : h('span', { class: 'muted' }, '—'))))),
      h('tfoot', null, h('tr', null, h('td', { class: 'strong' }, 'Average'), ...r.lifts.map((l) => h('td', { class: 'num' }, r.averages[l.key] != null ? String(r.averages[l.key]) : h('span', { class: 'muted' }, '—'))), h('td', { class: 'num strong' }, r.average_total != null ? String(r.average_total) : h('span', { class: 'muted' }, '—')))))
      : h('div', { class: 'empty' }, filters.contract_id || filters.program_id ? 'Nobody is on that team or program.' : 'No current athletes yet.'));
    const n = rows.length, withEst = rows.filter((a) => a.estimated).length;
    fill(note, r.lifts.length ? `${n} ${n === 1 ? 'athlete' : 'athletes'}. ${r.with_estimates ? `Grey numbers are estimated from logged sets (${withEst} ${withEst === 1 ? 'athlete has' : 'athletes have'} one); the rest are tested or typed maxes. ` : 'Estimates are left out. '}Click a cell to type a tested max; it lands on the athlete's profile like any result.` : 'No lift tests are active in the Test library. Turn the 1RM tests on to see them here.');
  }
  fill(main,
    header('Max report', 'Every athlete\'s maxes side by side, with totals and the team\'s averages.', h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--ghost', href: '#/testing' }, 'Testing'), csv, print)),
    panel('Maxes', { action: h('div', { class: 'row wrap mr-filters', style: 'gap:8px;align-items:center' }, team, program, h('label', { class: 'row small', style: 'gap:6px;white-space:nowrap' }, est, 'Show estimates')) }, body, note));
  await load();
}
