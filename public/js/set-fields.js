// Set details for one exercise in a workout, as the coach fills them in (the builder, Build from a PDF) and as every
// screen draws them: sets, reps, tempo, rest, a target RPE, a load typed as text, a cue, and the group the exercise
// belongs to (superset, circuit or block: exercises sharing a letter are drawn together as A1, A2...).
import { h, input, select } from './ui.js';

export const GROUP_KINDS = { superset: 'Superset', circuit: 'Circuit', block: 'Block' };
const LETTERS = 'ABCDEFGH'.split('');

export function setFields(x = null, { hint = true } = {}) {
  const num = (i) => (i.value === '' ? null : Number(i.value));
  const txt = (i) => i.value.trim() || null;
  const sets = input({ type: 'number', min: '1', max: '12', inputmode: 'numeric', placeholder: '3', value: x?.sets ? String(x.sets) : '', 'aria-label': 'Sets' });
  const reps = input({ maxlength: '80', placeholder: '8, 8-10, 5/side, 40 sec', value: x?.reps ?? '', 'aria-label': 'Reps' });
  const loadT = input({ maxlength: '40', placeholder: '135 lb, BW', value: x?.load_text ?? '', 'aria-label': 'Load' });
  const tempo = input({ maxlength: '20', placeholder: '3-1-1', value: x?.tempo ?? '', 'aria-label': 'Tempo' });
  const rest = input({ type: 'number', min: '0', max: '1800', step: '5', inputmode: 'numeric', placeholder: 'sec', value: x?.rest_seconds != null ? String(x.rest_seconds) : '', 'aria-label': 'Rest in seconds' });
  const rpe = input({ type: 'number', min: '1', max: '10', step: '0.5', inputmode: 'decimal', placeholder: '1 to 10', value: x?.target_rpe != null ? String(x.target_rpe) : '', 'aria-label': 'Target RPE' });
  const kind = select([['', 'On its own'], ...Object.entries(GROUP_KINDS)], { value: x?.group_kind ?? '', 'aria-label': 'Group' });
  const letter = select(LETTERS.map((l) => [l, `Group ${l}`]), { value: x?.group_label ?? 'A', 'aria-label': 'Group letter' });
  const note = input({ maxlength: '200', placeholder: 'A cue, like "pause at the bottom"', value: x?.note ?? '', 'aria-label': 'Note for the athlete' });
  // Ask for a form check on this exercise (version 61): the app shows the ask and the Send button up front on the card.
  const ask = h('input', { type: 'checkbox', checked: !!x?.form_check });
  const askNote = input({ maxlength: '200', placeholder: 'What to film, like "side view, your heaviest set"', value: x?.form_check_note ?? '', 'aria-label': 'What to film' });
  const askRow = h('div', { class: 'stack-tight' },
    h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, ask, h('span', null, h('span', { class: 'strong' }, 'Ask for a form check'), h('span', { class: 'muted' }, ' · the athlete is asked to film a set of this one and send it to you'))),
    askNote);
  const sync = () => { letter.disabled = !kind.value; askNote.hidden = !ask.checked; };
  kind.addEventListener('change', sync); ask.addEventListener('change', sync); sync();
  const lab = (text, el, w) => h('label', { class: 'sf-field', style: w ? `flex:0 0 ${w}` : 'flex:1 1 120px' }, h('span', { class: 'small muted' }, text), el);
  const el = h('div', { class: 'stack-tight sf' },
    h('div', { class: 'row wrap sf-row' }, lab('Sets', sets, '4.5rem'), lab('Reps', reps), lab('Load', loadT)),
    h('div', { class: 'row wrap sf-row' }, lab('Tempo', tempo, '5.5rem'), lab('Rest (sec)', rest, '5.5rem'), lab('RPE', rpe, '5rem'), lab('Group', kind), lab('Letter', letter, '7rem')),
    lab('Note', note),
    askRow,
    hint ? h('span', { class: 'small muted' }, 'Sets and reps are what the athlete logs; reps can be a time or distance, like 40 sec. Give exercises the same group letter to show them together as a superset, circuit or block (A1, A2...).') : null);
  return { el, sets, reps, focus: () => sets.focus(), body: () => ({
    sets: num(sets), reps: txt(reps), load_text: txt(loadT), tempo: txt(tempo), rest_seconds: num(rest), target_rpe: num(rpe),
    group_label: kind.value ? letter.value : null, group_kind: kind.value || null, note: txt(note), form_check: ask.checked, form_check_note: ask.checked ? txt(askNote) : null }) };
}

// What every screen shows under an exercise's name: "3 × 8 @ 135 lb · Tempo 3-1-1 · Rest 90 sec · RPE 8".
export const detailsOf = (x) => [x.prescription, x.details].filter(Boolean).join(' · ');
export const groupTitle = (x) => `${GROUP_KINDS[x.group_kind] ?? 'Group'} ${x.group_label}`;
// The A1/A2 tag beside a grouped exercise.
export const groupTag = (x) => (x.group_tag ? h('span', { class: 'sf-tag', 'aria-label': `${groupTitle(x)}, exercise ${x.group_tag}` }, x.group_tag) : null);
// Rows with a heading where a group starts ("Superset A").
export function withGroups(list, row, heading = (x) => h('div', { class: 'sf-group' }, groupTitle(x))) {
  const out = [];
  list.forEach((x, i) => {
    if (x.group_label && list[i - 1]?.group_label !== x.group_label) out.push(heading(x));
    out.push(row(x, i));
  });
  return out;
}
