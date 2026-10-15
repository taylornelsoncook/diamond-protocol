// The game-week helper's screen, shared by the athlete app, the family portal and the client page: the athlete's games,
// races and competitions (add one, bring in the team's schedule from an .ics or CSV file or pasted lines, change a
// date, remove one), today's colour, and the next week day by day in its colour: green = the full workout, yellow =
// one set fewer on every exercise, red = half the sets. Nothing to confirm: a changed date moves the colours and the
// sets at once. api: plan(), add(body), update(id, body), remove(id), preview(body), import(body).
import { h, fill, toast, busy, btn, input, select, field } from './ui.js';

const fmtDay = (d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts }) : '');
const fmtTime = (t) => { if (!t) return ''; const [hh, mm] = t.split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };
export const KINDS = [['game', 'Game'], ['tournament', 'Tournament day'], ['scrimmage', 'Scrimmage'], ['race', 'Race'], ['meet', 'Meet'], ['competition', 'Competition']];
const CUT_SHORT = { minus_one: '−1 set', half: '½ sets' };
const TONE_WORD = { green: 'Green', yellow: 'Yellow', red: 'Red' };
const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
const textarea = (attrs = {}) => h('textarea', { class: 'dp-input', ...attrs });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// "Game in 3 days · vs Westlake · 2:00 pm"
export const nextText = (next, daysTo) => (!next ? null : `${cap(next.kind_word ?? 'game')} ${daysTo === 0 ? 'day' : daysTo === 1 ? 'tomorrow' : `in ${daysTo} days`}${next.title ? ` · ${next.title}` : ''}${next.time ? ` · ${fmtTime(next.time)}` : ''}`);
// A small coloured chip: "Yellow: one set fewer on every exercise".
export const toneChip = (tone, text) => h('span', { class: `gw-chip gw-chip--${tone}` }, text ?? `${TONE_WORD[tone]}: ${tone === 'green' ? 'the full workout' : tone === 'yellow' ? 'one set fewer on every exercise' : 'half the sets on every exercise'}`);

export function gamesBlock({ first, who = 'athlete', api, canEdit = true, onChanged = null }) {
  const el = h('div', { class: 'stack' });
  const your = who === 'athlete' ? 'your' : `${first}'s`;
  let plan = null, editing = null;
  async function load() {
    try { plan = await api.plan(); } catch (e) { fill(el, h('p', { class: 'small warn-text' }, e.message)); return; }
    draw();
  }
  const changed = async () => { await load(); if (onChanged) onChanged(); };
  function draw() {
    const next = plan.next_game;
    const daysTo = next ? Math.round((Date.parse(`${next.date}T12:00:00Z`) - Date.parse(`${plan.today}T12:00:00Z`)) / 86400000) : null;
    const nowLine = !plan.games.length ? null : h('div', { class: 'stack-tight' },
      h('span', { class: 'strong' }, next ? nextText(next, daysTo) : 'No game coming up'),
      h('div', { class: 'row wrap', style: 'gap:6px;align-items:center' }, h('span', { class: 'small muted' }, 'Today:'), toneChip(plan.now.tone)),
      plan.now.advice ? h('p', { class: 'small', style: 'margin:0' }, plan.now.advice) : h('p', { class: 'small muted', style: 'margin:0' }, 'No game within three days: the full workout.'));
    const week = plan.games.length ? h('div', { class: 'gw-week', role: 'list', 'aria-label': 'The next week' }, plan.days.slice(0, 7).map((d) => h('div', { class: `gw-day gw-day--${d.tone}${d.games.length ? ' gw-day--game' : ''}`, role: 'listitem', title: d.advice ?? '',
      'aria-label': `${fmtDay(d.date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${TONE_WORD[d.tone]}${d.games.length ? `, ${d.games[0].kind_word}` : ''}${d.workouts.length ? `, ${d.workouts.map((w) => `${w.title} ${w.sets_today} of ${w.sets} sets`).join(', ')}` : ''}` },
      h('span', { class: 'gw-day-name' }, d.date === plan.today ? 'Today' : fmtDay(d.date, { weekday: 'short' })),
      h('span', { class: 'gw-day-what' }, d.games.length ? (d.games[0].title ?? d.games[0].kind_label) : d.cut ? CUT_SHORT[d.cut] : 'Full'),
      d.workouts.length ? h('span', { class: 'gw-day-wo small muted' }, d.workouts.map((w) => `${w.title}${w.sets ? ` · ${w.sets_today}${w.sets_today !== w.sets ? ` of ${w.sets}` : ''} sets` : ''}`).join(', ')) : null))) : null;
    const key = plan.games.length ? h('p', { class: 'small muted', style: 'margin:0' }, 'Green: the full workout. Yellow: one set fewer on every exercise. Red: half the sets. The exercises, reps and weights stay the same. Change a date below and the colours follow.') : null;
    const list = plan.upcoming_games.length ? h('div', { class: 'stack-tight' }, h('span', { class: 'dp-label' }, `${who === 'athlete' ? 'Your' : `${first}'s`} games`),
      plan.upcoming_games.map((g) => (editing === g.id ? editRow(g) : h('div', { class: 'list-item' },
        h('span', { class: 'grow' }, h('span', { class: 'strong' }, fmtDay(g.date)), h('span', { class: 'small muted' }, `${g.time ? ` ${fmtTime(g.time)}` : ''}${g.title ? ` · ${g.title}` : ''} · ${g.kind_label}`)),
        canEdit ? h('div', { class: 'row', style: 'gap:4px' }, btn('Change', () => { editing = g.id; draw(); }, 'ghost', { 'aria-label': `Change the ${g.kind_word} on ${fmtDay(g.date)}` }),
          btn('Remove', (e) => busy(e.currentTarget, async () => { await api.remove(g.id); toast('Removed.'); changed(); }), 'ghost', { 'aria-label': `Remove the ${g.kind_word} on ${fmtDay(g.date)}` })) : null))),
      plan.games.length > plan.upcoming_games.length ? h('span', { class: 'small muted' }, `${plural(plan.games.length - plan.upcoming_games.length, 'more game')} on file.`) : null) : null;
    fill(el, nowLine, week, key, list, canEdit ? addForms() : null);
  }
  // A game that moved: the new date (or time, opponent, kind). Save, and every colour and set count follows.
  function editRow(g) {
    const date = input({ type: 'date', value: g.date, 'aria-label': 'New date', style: 'min-height:40px' });
    const time = input({ type: 'time', value: g.time ?? '', 'aria-label': 'Time (optional)', style: 'min-height:40px' });
    const title = input({ value: g.title ?? '', placeholder: 'vs Westlake', maxlength: '80', 'aria-label': 'Against' });
    const kind = select(KINDS, { value: g.kind, 'aria-label': 'Kind' });
    return h('div', { class: 'list-item stack-tight', style: 'align-items:stretch' },
      h('span', { class: 'small strong' }, `Change the ${g.kind_word} on ${fmtDay(g.date)}`),
      h('div', { class: 'row wrap', style: 'gap:8px;align-items:flex-end' }, field('Date', date), field('Time', time), h('div', { class: 'grow', style: 'min-width:140px' }, field('Against', title)), field('Kind', kind)),
      h('div', { class: 'row wrap', style: 'gap:6px' },
        btn('Save', (e) => busy(e.currentTarget, async () => {
          if (!date.value) throw new Error('Pick the date.');
          const r = await api.update(g.id, { date: date.value, time: time.value || null, title: title.value.trim() || null, kind: kind.value });
          editing = null; toast(r.date !== g.date ? `Moved to ${fmtDay(r.date)}. The days around it changed colour.` : 'Saved.'); changed();
        }), 'primary'), btn('Cancel', () => { editing = null; draw(); }, 'ghost')));
  }
  // Add one game, or bring in the team's schedule.
  function addForms() {
    const date = input({ type: 'date', 'aria-label': 'Date', style: 'min-height:40px' });
    const time = input({ type: 'time', 'aria-label': 'Time (optional)', style: 'min-height:40px' });
    const title = input({ placeholder: 'vs Westlake', maxlength: '80', 'aria-label': 'Who it\'s against (optional)' });
    const kind = select(KINDS, { 'aria-label': 'Kind' });
    const addBtn = btn('Add', (e) => busy(e.currentTarget, async () => {
      if (!date.value) throw new Error('Pick the date.');
      await api.add({ date: date.value, time: time.value || null, title: title.value.trim() || null, kind: kind.value });
      toast('Added. The days around it are coloured now.'); date.value = ''; time.value = ''; title.value = ''; changed();
    }), 'secondary');
    const file = h('input', { type: 'file', class: 'dp-input', accept: '.ics,.csv,text/calendar,text/csv', 'aria-label': 'The team\'s schedule file' });
    const pasted = textarea({ rows: '3', placeholder: 'Oct 18 10:00 vs Westlake\nOct 25 @ Hill Country\nNov 1 Tournament\nNov 14 Cross country regional', 'aria-label': 'Games, one per line' });
    const previewBox = h('div', { class: 'stack-tight' });
    const previewBtn = btn('Read the schedule', (e) => busy(e.currentTarget, async () => {
      let text = pasted.value.trim();
      const f = file.files[0];
      if (f) { if (f.size > 2_000_000) throw new Error('That file is too big. Export just this season.'); text = await f.text(); }
      if (!text) throw new Error('Choose the file or paste the dates first.');
      const p = await api.preview({ text });
      drawPreview(p);
    }), 'secondary');
    function drawPreview(p) {
      const ticks = p.items.map((it) => h('input', { type: 'checkbox', checked: !!it.checked, disabled: it.skip ? '' : null, 'aria-label': `${fmtDay(it.date)} ${it.title ?? ''}` }));
      const kinds = p.items.map((it) => select(KINDS, { value: it.kind, 'aria-label': 'Kind', disabled: it.skip ? '' : null }));
      fill(previewBox, h('span', { class: 'small' }, `${plural(p.counts.found, 'event')} found: ${p.counts.games} look like games${p.counts.practices ? `, ${p.counts.practices} like practices (unticked)` : ''}${p.counts.skipped ? `, ${p.counts.skipped} skipped` : ''}. Tick the ones to add.`),
        h('div', { class: 'stack-tight', style: 'max-height:320px;overflow:auto' }, p.items.map((it, i) => h('label', { class: 'row', style: 'gap:8px;align-items:center;min-height:36px' }, ticks[i],
          h('span', { class: `grow small${it.skip ? ' muted' : ''}` }, h('span', { class: 'strong' }, fmtDay(it.date)), `${it.time ? ` ${fmtTime(it.time)}` : ''}${it.title ? ` · ${it.title}` : ''}${it.location ? ` · ${it.location}` : ''}${it.skip ? ` · ${it.skip}` : it.practice ? ' · looks like a practice' : ''}`),
          h('span', { style: 'width:140px' }, kinds[i])))),
        h('div', { class: 'row wrap' }, btn('Add the ticked ones', (e) => busy(e.currentTarget, async () => {
          const items = p.items.map((it, i) => (ticks[i].checked && !it.skip ? { date: it.date, time: it.time, title: it.title, kind: kinds[i].value, import_key: it.import_key } : null)).filter(Boolean);
          if (!items.length) throw new Error('Tick at least one.');
          const r = await api.import({ items });
          toast(`${plural(r.added, 'game')} added${r.skipped ? `, ${r.skipped} already on file` : ''}.`);
          file.value = ''; pasted.value = ''; fill(previewBox); changed();
        }), 'primary'), btn('Cancel', () => fill(previewBox), 'ghost')));
    }
    return h('details', { class: 'gw-add', open: plan.games.length ? null : '' }, h('summary', { class: 'strong', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, plan.games.length ? 'Add a game, race or competition' : `Add ${your} games, races and competitions`),
      h('div', { class: 'stack', style: 'padding-top:8px' },
        h('div', { class: 'row wrap', style: 'gap:8px;align-items:flex-end' }, field('Date', date), field('Time', time), h('div', { class: 'grow', style: 'min-width:160px' }, field('Against', title)), field('Kind', kind), addBtn),
        h('div', { class: 'stack-tight' }, h('span', { class: 'dp-label' }, 'Or bring in the team\'s schedule'),
          h('p', { class: 'small muted', style: 'margin:0' }, 'TeamSnap, SportsEngine, GameChanger and most team apps export the season as a calendar file (.ics): choose it here. A spreadsheet (.csv) with date, time and opponent columns works too, or type them one per line.'),
          file, pasted, h('div', null, previewBtn), previewBox)));
  }
  load();
  return { el, reload: load };
}
