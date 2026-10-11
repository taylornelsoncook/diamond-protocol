// Set details for one exercise in a workout, as the coach fills them in (the builder, Build from a PDF) and as every
// screen draws them: sets, reps, distance, tempo, rest, a target RPE, a load typed as text and a cue. Which block an
// exercise sits in (Warm up, Strength, a superset or circuit...) is the block's business (version 74), not a field here.
import { h, input, select } from './ui.js';

export const GROUP_KINDS = { superset: 'Superset', circuit: 'Circuit', block: 'Block' };
// What a block's kind means for the athlete, shown under the block's name.
export const KIND_WORDS = { block: 'one after another', superset: 'one set of each, then rest', circuit: 'one set of each in turn, then rest' };

export function setFields(x = null, { hint = true } = {}) {
  const num = (i) => (i.value === '' ? null : Number(i.value));
  const txt = (i) => i.value.trim() || null;
  const sets = input({ type: 'number', min: '1', max: '12', inputmode: 'numeric', placeholder: '3', value: x?.sets ? String(x.sets) : '', 'aria-label': 'Sets' });
  const reps = input({ maxlength: '80', placeholder: '8, 8-10, 5/side, 40 sec', value: x?.reps ?? '', 'aria-label': 'Reps' });
  const distance = input({ maxlength: '20', placeholder: '20 yd, 40 m', value: x?.distance ?? '', 'aria-label': 'Distance' });
  const loadT = input({ maxlength: '40', placeholder: '135 lb, BW', value: x?.load_text ?? '', 'aria-label': 'Load' });
  const tempo = input({ maxlength: '20', placeholder: '3-1-1-0', value: x?.tempo ?? '', 'aria-label': 'Tempo, four counts: down, pause, up, pause' });
  const rest = input({ type: 'number', min: '0', max: '1800', step: '5', inputmode: 'numeric', placeholder: 'sec', value: x?.rest_seconds != null ? String(x.rest_seconds) : '', 'aria-label': 'Rest in seconds' });
  const rpe = input({ type: 'number', min: '1', max: '10', step: '0.5', inputmode: 'decimal', placeholder: '1 to 10', value: x?.target_rpe != null ? String(x.target_rpe) : '', 'aria-label': 'Target RPE' });
  const note = input({ maxlength: '200', placeholder: 'A cue, like "pause at the bottom"', value: x?.note ?? '', 'aria-label': 'Note for the athlete' });
  // Ask for a form check on this exercise (version 61): the app shows the ask and the Send button up front on the card.
  const ask = h('input', { type: 'checkbox', checked: !!x?.form_check });
  const askNote = input({ maxlength: '200', placeholder: 'What to film, like "side view, your heaviest set"', value: x?.form_check_note ?? '', 'aria-label': 'What to film' });
  const askRow = h('div', { class: 'stack-tight' },
    h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, ask, h('span', null, h('span', { class: 'strong' }, 'Ask for a form check'), h('span', { class: 'muted' }, ' · the athlete is asked to film a set of this one and send it to you'))),
    askNote);
  const sync = () => { askNote.hidden = !ask.checked; };
  ask.addEventListener('change', sync); sync();
  const lab = (text, el, w) => h('label', { class: 'sf-field', style: w ? `flex:0 0 ${w}` : 'flex:1 1 120px' }, h('span', { class: 'small muted' }, text), el);
  const el = h('div', { class: 'stack-tight sf' },
    h('div', { class: 'row wrap sf-row' }, lab('Sets', sets, '4.5rem'), lab('Reps', reps), lab('Distance', distance, '7rem'), lab('Load', loadT)),
    h('div', { class: 'row wrap sf-row' }, lab('Tempo (0-0-0-0)', tempo, '7rem'), lab('Rest (sec)', rest, '5.5rem'), lab('RPE', rpe, '5rem')),
    lab('Note', note),
    askRow,
    hint ? h('span', { class: 'small muted' }, 'Sets and reps are what the athlete logs; reps can be a time, like 40 sec, and a distance has its own box. Tempo is four counts, down-pause-up-pause, like 3-1-1-0 (X = as fast as possible).') : null);
  return { el, sets, reps, focus: () => sets.focus(), body: () => ({
    sets: num(sets), reps: txt(reps), distance: txt(distance), load_text: txt(loadT), tempo: txt(tempo), rest_seconds: num(rest), target_rpe: num(rpe),
    note: txt(note), form_check: ask.checked, form_check_note: ask.checked ? txt(askNote) : null }) };
}

// What every screen shows under an exercise's name: "3 × 8 @ 135 lb · Tempo 3-1-1-0 · Rest 90 sec · RPE 8".
export const detailsOf = (x) => [x.prescription, x.details].filter(Boolean).join(' · ');
// The set details as a table the athlete reads at a glance (the app, version 73): Sets · Reps · Distance · Weight ·
// % of max · Tempo, then Rest and RPE where the coach set them. x is an exercise as the app gets it (target_sets,
// target_reps, load) or as the builder has it (sets, reps, load_pct).
const LIFTS = { squat_1rm: 'squat', bench_1rm: 'bench', power_clean_1rm: 'clean' };
export function rxTable(x, { compact = false } = {}) {
  const sets = x.target_sets ?? x.sets ?? null;
  const reps = x.target_reps != null && x.reps && /^\d/.test(String(x.reps)) ? String(x.reps) : x.reps ?? null;
  const weight = x.load?.lb != null ? `${x.load.lb} lb` : x.load_text ?? (x.load?.missing ? 'Set your max' : null);
  const pct = x.load_pct != null ? `${x.load_pct}%${LIFTS[x.load_test] ? ` ${LIFTS[x.load_test]}` : ''}` : null;
  const cells = [['Sets', sets], ['Reps', reps], ['Distance', x.distance ?? null], ['Weight', weight], ['% max', pct], ['Tempo', x.tempo ?? null]];
  const extra = [x.rest_seconds === 0 ? ['Rest', 'none'] : x.rest_seconds != null ? ['Rest', restText(x.rest_seconds)] : null, x.target_rpe != null ? ['RPE', String(x.target_rpe)] : null].filter(Boolean);
  return h('div', { class: `c-rx${compact ? ' c-rx--compact' : ''}`, role: 'table', 'aria-label': 'What to do' },
    ...[...cells, ...extra].map(([k, val]) => h('div', { class: `c-rx-cell${val == null || val === '' ? ' c-rx-cell--empty' : ''}`, role: 'row' },
      h('b', { role: 'rowheader' }, k), h('span', { role: 'cell' }, val == null || val === '' ? '–' : String(val)))));
}
function restText(s) { if (s < 60) return `${s} sec`; const m = Math.floor(s / 60), r = s % 60; return r ? `${m}:${String(r).padStart(2, '0')}` : `${m} min`; }
// The block's heading: its name (older rows without one: "Superset A"), with how it runs for a superset or circuit.
export const groupTitle = (x) => x.block_name ?? `${GROUP_KINDS[x.group_kind] ?? 'Group'} ${x.group_label}`;
export const blockWords = (x) => (x.group_kind && x.group_kind !== 'block' ? KIND_WORDS[x.group_kind] : null);
// The number beside an exercise in its block (1, 2, 3...; the API's group_tag is A1, A2... for integrations).
export const groupTag = (x) => (x.group_tag ? h('span', { class: 'sf-tag', 'aria-label': `${groupTitle(x)}, exercise ${x.group_tag.replace(/^[A-Z]/, '')}` }, x.group_tag.replace(/^[A-Z]/, '')) : null);
// Rows with a heading where a block starts ("Acceleration Primer · one set of each, then rest").
export function withGroups(list, row, heading = (x) => h('div', { class: 'sf-group' }, groupTitle(x), blockWords(x) ? h('span', { class: 'sf-group-how' }, ` · ${blockWords(x)}`) : null)) {
  const out = [];
  list.forEach((x, i) => {
    const key = (e) => e?.block_id ?? e?.group_label ?? null;
    if (key(x) && key(list[i - 1]) !== key(x)) out.push(heading(x));
    out.push(row(x, i));
  });
  return out;
}
