// The printable program (owners, coaches and front desk signed in to the dashboard): the plan as a grid of weeks and
// days with the phases, then every workout with its exercises. Print, or save as a PDF, from the browser's print dialog.
import { h, fill, btn } from './ui.js';

const q = new URLSearchParams(location.search);
const id = encodeURIComponent(q.get('id') ?? '');
const root = document.getElementById('root');
const LOAD_TESTS = { squat_1rm: 'back squat', bench_1rm: 'bench press', power_clean_1rm: 'power clean' };
const restText = (s) => (s == null ? '' : s === 0 ? 'no rest' : s >= 60 ? `rest ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `rest ${s} s`);
const loadText = (x) => (x.load_text ? x.load_text : x.load_test ? `${x.load_pct}% of ${LOAD_TESTS[x.load_test] ?? x.load_test} max` : '');
async function get(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Couldn't load (${res.status}).`);
  return data;
}

async function main() {
  if (!id) return fill(root, h('div', { class: 'rp-sheet' }, h('p', null, 'Open this page from a program: Programs → the program → Print or PDF.')));
  let p, plan, settings;
  try { [p, plan, settings] = await Promise.all([get(`/v1/programs/${id}`), get(`/v1/programs/${id}/plan`), get('/v1/settings')]); }
  catch (e) { return fill(root, h('div', { class: 'rp-sheet' }, h('p', null, e.message), h('p', null, h('a', { href: '/' }, 'Sign in to the dashboard'), ' and open the program from Programs.'))); }
  document.title = `${p.name} · ${settings.business_name ?? 'Diamond Protocol'}`;
  const days = Math.max(1, ...p.workouts.map((w) => w.day), plan.days ?? 1);
  const phaseOf = (week) => plan.phases.find((f) => week >= f.start_week && week <= f.end_week);
  const grid = h('table', { class: 'pp-grid' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Week'), ...Array.from({ length: days }, (_, i) => h('th', { scope: 'col' }, `Day ${i + 1}`)), h('th', { scope: 'col' }, 'Sets'))),
    h('tbody', null, plan.weeks.map((wk) => {
      const f = phaseOf(wk.week);
      return h('tr', null, h('td', null, h('div', { class: 'pp-week' }, `Week ${wk.week}`), f ? h('span', { class: 'pp-phase' }, f.name) : null),
        ...Array.from({ length: days }, (_, i) => { const w = p.workouts.find((x) => x.week === wk.week && x.day === i + 1); return h('td', null, w ? [h('div', { class: 'strong' }, w.title), h('div', { class: 'small muted' }, w.exercises.map((x) => x.name).join(', ') || 'No exercises yet')] : h('span', { class: 'muted' }, '—')); }),
        h('td', { class: 'num' }, String(wk.sets)));
    })));
  const workouts = [...p.workouts].sort((a, b) => a.week - b.week || a.day - b.day).map((w) => h('section', { class: 'pp-workout' },
    h('h3', null, `Week ${w.week}, day ${w.day} · ${w.title}`),
    w.warmup ? h('p', { class: 'pp-block' }, `Warm-up: ${w.warmup.name}${w.warmup.exercises?.length ? ` · ${w.warmup.exercises.map((e) => `${e.name} ${e.prescription ?? ''}`.trim()).join(', ')}` : ''}`) : null,
    w.exercises.length ? h('table', { class: 'rp-table' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, ''), h('th', { scope: 'col' }, 'Exercise'), h('th', { scope: 'col' }, 'Sets × reps'), h('th', { scope: 'col' }, 'Load'), h('th', { scope: 'col' }, 'Tempo · rest · RPE'), h('th', { scope: 'col' }, 'Cue'))),
      h('tbody', null, w.exercises.map((x) => h('tr', null, h('td', { class: 'num' }, x.group_tag ?? ''), h('td', null, h('span', { class: 'strong' }, x.name), x.form_check ? h('div', { class: 'small muted' }, `Form check${x.form_check_note ? `: ${x.form_check_note}` : ''}`) : null),
        h('td', { class: 'num' }, x.sets && x.reps ? `${x.sets} × ${x.reps}` : x.prescription ?? ''), h('td', null, loadText(x)),
        h('td', null, [x.tempo ? `tempo ${x.tempo}` : null, restText(x.rest_seconds), x.target_rpe ? `RPE ${x.target_rpe}` : null].filter(Boolean).join(' · ')), h('td', null, x.note ?? ''))))) : h('p', { class: 'muted small' }, 'No exercises yet.'),
    w.cooldown ? h('p', { class: 'pp-block' }, `Cool-down: ${w.cooldown.name}${w.cooldown.exercises?.length ? ` · ${w.cooldown.exercises.map((e) => `${e.name} ${e.prescription ?? ''}`.trim()).join(', ')}` : ''}`) : null));
  fill(root,
    h('div', { class: 'rp-actions rp-tools' }, btn('Print or save as PDF', () => window.print(), 'primary'), h('a', { class: 'dp-btn dp-btn--secondary', href: `/v1/programs/${id}/export.xlsx` }, 'Download Excel'), h('a', { class: 'dp-btn dp-btn--ghost', href: `/#/programs/${id}` }, 'Back to the builder')),
    h('article', { class: 'rp-sheet' },
      h('header', { class: 'rp-head' }, h('div', null, h('div', { class: 'rp-name' }, p.name), h('div', { class: 'rp-sub' }, [settings.business_name ?? 'Diamond Protocol', p.weeks === 1 ? '1 week' : `${p.weeks} weeks`, p.level ?? 'Any level', p.kind === 'template' ? 'Template' : null].filter(Boolean).join(' · '))), h('img', { src: '/brand/mark.png', alt: '' })),
      p.description ? h('p', null, p.description) : null,
      plan.phases.length ? h('section', null, h('h2', { class: 'rp-h' }, 'Phases'), h('div', { class: 'row wrap', style: 'gap:8px' }, plan.phases.map((f) => h('span', { class: 'pp-phase' }, `${f.name} · weeks ${f.start_week}${f.end_week !== f.start_week ? `–${f.end_week}` : ''}${f.note ? ` · ${f.note}` : ''}`)))) : null,
      h('section', null, h('h2', { class: 'rp-h' }, 'The plan'), grid),
      h('section', null, h('h2', { class: 'rp-h' }, 'Every workout'), workouts.length ? workouts : h('p', { class: 'muted' }, 'No workouts yet.')),
      h('p', { class: 'rp-foot' }, `${settings.business_name ?? 'Diamond Protocol'} · printed ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`)));
}
main();
