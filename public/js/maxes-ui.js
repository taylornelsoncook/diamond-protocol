// Athlete maxes, shared by the athlete app and the parent portal (the Performance tab) and the client page (Testing).
// Each lift a program can load from: the max on file, the estimate from logged sets, which one the weights use, a
// trend, and Update / Save the estimate. Then strength by exercise from the logged sets.
import { h, fill, btn, busy, toast, input } from './ui.js';
import { sparkline } from './charts.js';

const day = (d, opts = { month: 'short', day: 'numeric' }) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts }) : '');
const todayStr = () => new Date().toLocaleDateString('en-CA');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lb = (v) => (v == null ? '—' : `${Math.round(v)} lb`);

// Training volume (progress.js): this week against last, twelve weeks of sets as bars, the program's phases, and the
// most-logged exercises with their weekly sets. who: 'athlete' | 'parent' | 'coach' (wording only).
const n = (x) => Math.round(x).toLocaleString('en-US');
const PHASE_KINDS = { base: 'Base', build: 'Build', peak: 'Peak', deload: 'Deload', test: 'Testing', other: 'Other' };
// One series of weekly bars (thin marks, a 2px gap, the latest bar brighter); each bar carries its own label for readers.
function weekBars(weeks, { key = 'sets', label = 'Sets per week', height = 56 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const w = 8, gap = 2, width = weeks.length * (w + gap) - gap;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('width', width); svg.setAttribute('height', height);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${label}: ${weeks.map((x) => `${day(x.week_start)} ${n(x[key])}`).join(', ')}`);
  svg.setAttribute('class', 'mx-bars');
  const max = Math.max(1, ...weeks.map((x) => x[key]));
  weeks.forEach((x, i) => {
    const hgt = x[key] ? Math.max(2, Math.round(((height - 2) * x[key]) / max)) : 0;
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', i * (w + gap)); r.setAttribute('y', height - hgt); r.setAttribute('width', w); r.setAttribute('height', hgt); r.setAttribute('rx', 2);
    r.setAttribute('fill', x.current ? 'var(--green-bright)' : 'var(--green-mid)');
    const t = document.createElementNS(ns, 'title'); t.textContent = `Week of ${day(x.week_start)}: ${n(x[key])} ${key}`; r.append(t);
    if (!hgt) { r.setAttribute('height', 1); r.setAttribute('y', height - 1); r.setAttribute('fill', 'var(--line)'); }
    svg.append(r);
  });
  return svg;
}
export function volumeBlock(d, { who = 'athlete', first = null } = {}) {
  const you = who === 'athlete' ? 'your' : `${first ?? 'the athlete'}'s`;
  const cur = d.this_week, last = d.last_week;
  const delta = (k) => (last ? cur[k] - last[k] : null);
  const tile = (label, value, k, unit = '') => h('div', { class: 'mx-tile' }, h('b', null, `${n(value)}${unit}`), h('span', null, label),
    delta(k) != null ? h('span', { class: `small ${delta(k) >= 0 ? 'good-text' : 'muted'}` }, `${delta(k) >= 0 ? '+' : ''}${n(delta(k))} vs last week`) : null);
  if (!d.totals.workouts) return h('p', { class: 'small muted', style: 'margin:0' }, `No workouts logged in the last ${d.weeks.length} weeks. Volume shows up here as ${who === 'athlete' ? 'you log' : `${first ?? 'the athlete'} logs`} sets in the app.`);
  return h('div', { class: 'stack-tight mx' },
    h('div', { class: 'mx-tiles' }, tile('workouts this week', cur.workouts, 'workouts'), tile('sets', cur.sets, 'sets'), tile('lb lifted', cur.tonnage, 'tonnage'), tile('minutes', cur.minutes, 'minutes')),
    h('div', { class: 'row wrap', style: 'gap:12px;align-items:flex-end' }, weekBars(d.weeks), h('span', { class: 'small muted' }, `Sets per week, last ${d.weeks.length} weeks · ${n(d.totals.sets)} sets and ${n(d.totals.tonnage)} lb in ${n(d.totals.workouts)} workouts`)),
    d.phases.length ? h('div', { class: 'stack-tight', style: 'margin-top:8px' }, h('span', { class: 'small strong' }, 'By phase'), h('div', { class: 'eg-list' }, d.phases.map((f) => h('div', { class: 'eg-item', style: 'gap:2px' },
      h('div', { class: 'row', style: 'gap:8px;align-items:center' }, h('span', { class: 'strong grow' }, `${f.name}${f.name.toLowerCase() === (PHASE_KINDS[f.kind] ?? '').toLowerCase() ? '' : ` · ${PHASE_KINDS[f.kind] ?? f.kind}`}`),
        f.state === 'current' ? h('span', { class: 'dp-badge dp-badge--good' }, 'Now') : f.state === 'ahead' ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Ahead') : null),
      h('span', { class: 'small muted' }, `Weeks ${f.start_week}${f.end_week !== f.start_week ? `–${f.end_week}` : ''} · ${day(f.start_date)} to ${day(f.end_date)} · ${f.done} of ${f.planned} workouts${f.missed ? ` (${f.missed} missed)` : ''}${f.sets ? ` · ${n(f.sets)} sets · ${n(f.tonnage)} lb` : ''}`),
      f.note ? h('span', { class: 'small' }, f.note) : null)))) : null,
    d.exercises.length ? h('div', { class: 'stack-tight', style: 'margin-top:8px' }, h('span', { class: 'small strong' }, 'Most logged'), h('div', { class: 'eg-list' }, d.exercises.map((x) => h('div', { class: 'eg-item mx-ex' },
      h('div', { class: 'row', style: 'gap:10px;align-items:center' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, `${n(x.sets)} sets · ${n(x.tonnage)} lb${x.top ? ` · top set ${n(x.top)} lb` : ''}`)),
        h('span', { style: 'color:var(--green-bright)' }, sparkline(x.weekly_sets, { width: 72, height: 28, label: `${x.name} sets per week` }))))))) : null);
}

// data: the answer to GET …/maxes. who: 'athlete' | 'parent' | 'coach' (wording). save(body) and remove(id) post back;
// reload() redraws with fresh data. canEdit false shows only.
export function maxesBlock(data, { who = 'athlete', first = null, canEdit = true, save, remove, reload } = {}) {
  const you = who === 'athlete' ? 'your' : `${first ?? 'the athlete'}'s`;
  const You = cap(you);
  const list = h('div', { class: 'eg-list mx-list' });
  const rows = data.lifts.map((l) => liftRow(l));
  fill(list, rows);
  const strength = data.exercises?.length ? h('div', { class: 'stack-tight', style: 'margin-top:12px' },
    h('span', { class: 'small strong' }, 'Strength by exercise'),
    h('span', { class: 'small muted' }, `Estimated one-rep max from ${who === 'athlete' ? 'your' : 'their'} logged sets, best over the last 6 months, and how it's moving.`),
    h('div', { class: 'eg-list' }, data.exercises.map((x) => h('div', { class: 'eg-item mx-ex' },
      h('div', { class: 'row', style: 'gap:10px;align-items:center' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, `${x.sets} ${x.sets === 1 ? 'set' : 'sets'} logged · top set ${lb(x.top)}`)),
        h('span', { style: 'color:var(--green-bright)' }, sparkline(x.trend, { width: 72, height: 28, label: `${x.name} estimated max trend` })),
        h('div', { class: 'eg-best' }, h('span', { class: 'strong' }, lb(x.best)),
          x.trend.length > 1 && x.first ? h('span', { class: `small ${x.latest >= x.first ? 'good-text' : 'muted'}` }, `${x.latest - x.first >= 0 ? '+' : ''}${x.latest - x.first} lb`) : h('span', { class: 'small muted' }, 'est. max'))))))) : null;
  return h('div', { class: 'stack-tight mx' }, list, strength);

  function liftRow(l) {
    const row = h('div', { class: 'eg-item mx-lift' });
    let editing = false;
    const draw = () => {
      const usingText = l.using === 'recorded' ? `On file: ${lb(l.recorded.value)} · ${day(l.recorded.date)}${l.recorded.source_text ? ` · ${l.recorded.source_text}` : ''}`
        : l.using === 'estimate' ? `Estimated from ${who === 'athlete' ? 'your' : 'their'} sets: ${l.estimate.from.weight} lb × ${l.estimate.from.reps} on ${day(l.estimate.date)}. Nothing on file yet.`
        : `Nothing on file yet${canEdit ? `: enter ${you} max, or log a few sets and it's estimated` : ''}.`;
      const estLine = l.using === 'recorded' && l.estimate ? h('span', { class: 'small muted' }, `Estimate from ${who === 'athlete' ? 'your' : 'their'} sets: ${lb(l.estimate.value)} (${l.estimate.from.weight} lb × ${l.estimate.from.reps}, ${day(l.estimate.date)})`) : null;
      const suggest = canEdit && l.suggest ? btn(`Save ${l.suggest} lb as ${you} max`, (e) => busy(e.currentTarget, async () => { await save({ test: l.test, value: l.suggest, note: 'From logged sets' }); toast(`${cap(l.lift)} max saved: ${l.suggest} lb.`); reload?.(); }), 'secondary') : null;
      const form = () => {
        const val = input({ type: 'number', inputmode: 'decimal', min: '1', max: '1500', step: '5', value: l.value ?? '', placeholder: 'lb', 'aria-label': `${cap(l.lift)} max in pounds`, style: 'max-width:120px' });
        const when = input({ type: 'date', value: todayStr(), max: todayStr(), 'aria-label': 'When' });
        return h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, val, h('span', { class: 'small muted' }, 'lb on'), when,
          btn('Save', (e) => busy(e.currentTarget, async () => {
            if (!val.value) throw new Error('Enter the max in pounds.');
            await save({ test: l.test, value: Number(val.value), date: when.value || undefined });
            toast(`${cap(l.lift)} max saved: ${Math.round(Number(val.value))} lb.`); editing = false; reload?.();
          }), 'primary'), btn('Cancel', () => { editing = false; draw(); }, 'ghost'));
      };
      const removeBtn = canEdit && remove && l.recorded?.own && l.recorded.id ? btn('Remove', (e) => { if (!confirm(`Remove the ${lb(l.recorded.value)} ${l.lift} max entered ${day(l.recorded.date)}?`)) return; busy(e.currentTarget, async () => { await remove(l.recorded.id); toast('Removed.'); reload?.(); }); }, 'ghost', { 'aria-label': `Remove the ${l.lift} max on file` }) : null;
      fill(row,
        h('div', { class: 'row', style: 'gap:10px;align-items:center' },
          h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, cap(l.lift)), h('span', { class: 'small muted' }, usingText), estLine),
          l.trend.length > 1 ? h('span', { style: 'color:var(--green-bright)' }, sparkline(l.trend, { width: 72, height: 28, label: `${l.lift} estimated max trend` })) : null,
          h('div', { class: 'eg-best' }, h('span', { class: 'strong mx-num' }, lb(l.value)), h('span', { class: 'small muted' }, l.using === 'estimate' ? 'estimated' : l.using === 'recorded' ? 'on file' : ''))),
        editing ? form() : canEdit ? h('div', { class: 'row wrap', style: 'gap:8px' }, suggest, btn(l.value ? 'Update' : `Enter ${you} max`, () => { editing = true; draw(); }, l.suggest ? 'ghost' : 'secondary'), removeBtn) : null,
        l.history.length > 1 ? h('span', { class: 'small muted' }, `${l.history.length} on file: ${l.history.slice(-4).map((x) => `${Math.round(x.value)} lb (${day(x.date)})`).join(', ')}`) : null);
    };
    draw();
    return row;
  }
}
