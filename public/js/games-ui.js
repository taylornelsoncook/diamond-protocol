// The game-week helper's screen, shared by the athlete app, the family portal and the client page: the athlete's games
// (add one, bring in the team's schedule from an .ics or CSV file or pasted lines, remove one), where today sits
// against them with the day's advice, the next week day by day, and the suggestions (a workout heavier than its day
// allows, with Move it). api: plan(), add(body), remove(id), preview(body), import(body), move(body).
import { h, fill, toast, busy, btn, input, select, field } from './ui.js';

const fmtDay = (d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts }) : '');
const fmtTime = (t) => { if (!t) return ''; const [hh, mm] = t.split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };
const KINDS = [['game', 'Game'], ['tournament', 'Tournament day'], ['scrimmage', 'Scrimmage']];
const LOAD_WORD = { light: 'light day', moderate: 'moderate day', heavy: 'full training' };
const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
const textarea = (attrs = {}) => h('textarea', { class: 'dp-input', ...attrs });

export function gamesBlock({ first, who = 'athlete', api, canEdit = true, onMoved = null }) {
  const el = h('div', { class: 'stack' });
  const you = who === 'athlete' ? 'you' : first;
  const your = who === 'athlete' ? 'your' : `${first}'s`;
  let plan = null;
  async function load() {
    try { plan = await api.plan(); } catch (e) { fill(el, h('p', { class: 'small warn-text' }, e.message)); return; }
    draw();
  }
  function draw() {
    const next = plan.next_game;
    const daysTo = next ? Math.round((Date.parse(`${next.date}T12:00:00Z`) - Date.parse(`${plan.today}T12:00:00Z`)) / 86400000) : null;
    const nowLine = !plan.games.length ? null
      : next ? h('div', { class: 'stack-tight' },
        h('span', { class: 'strong' }, daysTo === 0 ? `Game day: ${next.title ?? next.kind_label}${next.time ? ` at ${fmtTime(next.time)}` : ''}` : `Next game: ${fmtDay(next.date)}${next.time ? ` ${fmtTime(next.time)}` : ''}${next.title ? ` · ${next.title}` : ''} · ${daysTo === 1 ? 'tomorrow' : `in ${daysTo} days`}`),
        plan.now.advice ? h('p', { class: 'small', style: 'margin:0' }, h('span', { class: 'strong' }, `${plan.now.label}: `), plan.now.advice) : h('p', { class: 'small muted', style: 'margin:0' }, 'No game within three days: train as planned.'))
      : h('p', { class: 'small muted', style: 'margin:0' }, plan.now.advice ? [h('span', { class: 'strong' }, `${plan.now.label}: `), plan.now.advice] : 'No games coming up. Add the next ones below.');
    const week = plan.games.length ? h('div', { class: 'gw-week', role: 'list', 'aria-label': 'The next week' }, plan.days.slice(0, 7).map((d) => h('div', { class: `gw-day${d.games.length ? ' gw-day--game' : ''}${d.conflict ? ' gw-day--conflict' : ''}`, role: 'listitem', title: d.advice ?? '' },
      h('span', { class: 'gw-day-name' }, d.date === plan.today ? 'Today' : fmtDay(d.date, { weekday: 'short' })),
      h('span', { class: 'gw-day-what' }, d.games.length ? (d.games[0].title ?? d.games[0].kind_label) : d.label !== 'Clear' ? d.label : LOAD_WORD[d.allow]),
      d.workouts.length ? h('span', { class: `gw-day-wo small${d.conflict ? ' warn-text' : ' muted'}` }, d.workouts.map((w) => `${w.title} (${w.load})`).join(', ')) : null))) : null;
    const sugg = plan.suggestions.length ? h('div', { class: 'stack-tight' }, h('span', { class: 'dp-label' }, 'Suggestions'),
      plan.suggestions.map((s) => h('div', { class: 'list-item', style: 'flex-wrap:wrap;align-items:flex-start' },
        h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', { class: 'strong' }, `${fmtDay(s.date)}: ${s.title}`), h('span', { class: 'small' }, s.text)),
        s.kind === 'move' && canEdit ? btn(`Move it to ${fmtDay(s.to_date, { weekday: 'short', day: 'numeric' })}`, (e) => busy(e.currentTarget, async () => { await api.move({ workout_id: s.workout_id, date: s.to_date }); toast(`${s.title} moved to ${fmtDay(s.to_date)}.`); await load(); if (onMoved) onMoved(); }), 'primary') : null)))
      : plan.games.length && plan.has_program ? h('p', { class: 'small muted', style: 'margin:0' }, `${plan.suggestions.length ? '' : 'Every workout in the next three weeks lands on a day that allows it.'}`) : null;
    const list = plan.upcoming_games.length ? h('div', { class: 'stack-tight' }, h('span', { class: 'dp-label' }, `${who === 'athlete' ? 'Your' : `${first}'s`} games`),
      plan.upcoming_games.map((g) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, h('span', { class: 'strong' }, fmtDay(g.date)), h('span', { class: 'small muted' }, `${g.time ? ` ${fmtTime(g.time)}` : ''}${g.title ? ` · ${g.title}` : ''} · ${g.kind_label}`)),
        canEdit ? btn('Remove', (e) => busy(e.currentTarget, async () => { await api.remove(g.id); toast('Removed.'); load(); }), 'ghost', { 'aria-label': `Remove the game on ${fmtDay(g.date)}` }) : null)),
      plan.games.length > plan.upcoming_games.length ? h('span', { class: 'small muted' }, `${plural(plan.games.length - plan.upcoming_games.length, 'more game')} on file.`) : null) : null;
    fill(el, nowLine, week, sugg, list, canEdit ? addForms() : null);
  }
  // Add one game, or bring in the team's schedule.
  function addForms() {
    const date = input({ type: 'date', 'aria-label': 'Game date', style: 'min-height:40px' });
    const time = input({ type: 'time', 'aria-label': 'Game time (optional)', style: 'min-height:40px' });
    const title = input({ placeholder: 'vs Westlake', maxlength: '80', 'aria-label': 'Who it\'s against (optional)' });
    const kind = select(KINDS, { 'aria-label': 'Kind' });
    const addBtn = btn('Add game', (e) => busy(e.currentTarget, async () => {
      if (!date.value) throw new Error('Pick the date.');
      await api.add({ date: date.value, time: time.value || null, title: title.value.trim() || null, kind: kind.value });
      toast('Game added.'); load();
    }), 'secondary');
    const file = h('input', { type: 'file', class: 'dp-input', accept: '.ics,.csv,text/calendar,text/csv', 'aria-label': 'The team\'s schedule file' });
    const pasted = textarea({ rows: '3', placeholder: 'Oct 18 10:00 vs Westlake\nOct 25 @ Hill Country\nNov 1 Tournament', 'aria-label': 'Games, one per line' });
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
      fill(previewBox, h('span', { class: 'small' }, `${plural(p.counts.found, 'event')} found: ${p.counts.games} look like games${p.counts.practices ? `, ${p.counts.practices} like practices (unticked)` : ''}${p.counts.skipped ? `, ${p.counts.skipped} skipped` : ''}. Tick the games to add.`),
        h('div', { class: 'stack-tight', style: 'max-height:320px;overflow:auto' }, p.items.map((it, i) => h('label', { class: 'row', style: 'gap:8px;align-items:center;min-height:36px' }, ticks[i],
          h('span', { class: `grow small${it.skip ? ' muted' : ''}` }, h('span', { class: 'strong' }, fmtDay(it.date)), `${it.time ? ` ${fmtTime(it.time)}` : ''}${it.title ? ` · ${it.title}` : ''}${it.location ? ` · ${it.location}` : ''}${it.skip ? ` · ${it.skip}` : it.practice ? ' · looks like a practice' : ''}`),
          h('span', { style: 'width:140px' }, kinds[i])))),
        h('div', { class: 'row wrap' }, btn('Add the ticked games', (e) => busy(e.currentTarget, async () => {
          const items = p.items.map((it, i) => (ticks[i].checked && !it.skip ? { date: it.date, time: it.time, title: it.title, kind: kinds[i].value, import_key: it.import_key } : null)).filter(Boolean);
          if (!items.length) throw new Error('Tick at least one game.');
          const r = await api.import({ items });
          toast(`${plural(r.added, 'game')} added${r.skipped ? `, ${r.skipped} already on file` : ''}.`);
          file.value = ''; pasted.value = ''; fill(previewBox); load();
        }), 'primary'), btn('Cancel', () => fill(previewBox), 'ghost')));
    }
    return h('details', { class: 'gw-add' }, h('summary', { class: 'strong', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, plan.games.length ? 'Add games' : `Add ${your} games`),
      h('div', { class: 'stack', style: 'padding-top:8px' },
        h('div', { class: 'row wrap', style: 'gap:8px;align-items:flex-end' }, field('Date', date), field('Time', time), h('div', { class: 'grow', style: 'min-width:160px' }, field('Against', title)), field('Kind', kind), addBtn),
        h('div', { class: 'stack-tight' }, h('span', { class: 'dp-label' }, 'Or bring in the team\'s schedule'),
          h('p', { class: 'small muted', style: 'margin:0' }, 'TeamSnap, SportsEngine, GameChanger and most team apps export the season as a calendar file (.ics): choose it here. A spreadsheet (.csv) with date, time and opponent columns works too, or type the games one per line.'),
          file, pasted, h('div', null, previewBtn), previewBox)));
  }
  load();
  return { el, reload: load };
}
