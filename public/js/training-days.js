// The training calendar on the coach's screens (version 62): the weekdays an athlete trains and the start date of their
// program (the assign dialogs on the client page and the program page), and the client page's calendar panel: every
// workout on its date, done, missed or coming up, with Move and Change schedule for owners and coaches.
import { h, fill, btn, busy, toast, input, field, panel } from './ui.js';

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The usual spread for a program with n days a week (the same table as services/training-calendar.js).
export const DEFAULT_DAYS = { 1: [1], 2: [2, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5], 5: [1, 2, 3, 4, 5], 6: [1, 2, 3, 4, 5, 6], 7: [0, 1, 2, 3, 4, 5, 6] };
export const defaultDays = (n) => DEFAULT_DAYS[Math.min(7, Math.max(1, n || 1))];
export const dayText = (days) => (days ?? []).map((d) => DAY_NAMES[d]).join(', ');
// A calendar date (2026-10-05) as words, never shifted by the browser's time zone.
export const fmtDay = (d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts }) : '');
export const todayStr = () => new Date().toLocaleDateString('en-CA');
const STATUS = { done: ['Done', 'dp-badge--good'], today: ['Today', 'dp-badge--neutral'], missed: ['Missed', 'dp-badge--warn'], upcoming: ['Coming up', 'dp-badge--muted'] };
export const statusBadge = (st) => h('span', { class: `dp-badge ${STATUS[st]?.[1] ?? 'dp-badge--muted'}` }, STATUS[st]?.[0] ?? st);

// Seven toggles. value() answers the picked weekdays, Sunday 0 to Saturday 6.
export function daysPicker(initial = [], { min = 1, onChange } = {}) {
  const picked = new Set(initial);
  const el = h('div', { class: 'td-days', role: 'group', 'aria-label': 'Training days' });
  const value = () => [...picked].sort((a, b) => a - b);
  const draw = () => fill(el, DAY_NAMES.map((n, d) => h('button', { type: 'button', class: 'td-day', 'aria-pressed': String(picked.has(d)), 'aria-label': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d],
    onClick: () => { if (picked.has(d)) picked.delete(d); else picked.add(d); draw(); onChange?.(value()); } }, n)));
  draw();
  return { el, value, set: (days) => { picked.clear(); for (const d of days ?? []) picked.add(d); draw(); }, problem: () => (value().length < min ? `Pick at least ${min} ${min === 1 ? 'day' : 'days'}: the program has ${min} a week.` : null) };
}
// Start date and training days together. body() is what the API takes.
export function scheduleFields({ start = todayStr(), days = null, need = 1 } = {}) {
  const startIn = input({ type: 'date', value: start, 'aria-label': 'Starts on' });
  const hint = h('div', { class: 'small muted' });
  const picker = daysPicker(days ?? defaultDays(need), { min: need, onChange: () => draw() });
  const draw = () => { hint.textContent = picker.problem() ?? (startIn.value ? `Week 1 starts ${fmtDay(startIn.value)}. Day 1 lands on the first training day from then, day 2 on the next.` : 'Pick the day week 1 starts.'); };
  startIn.addEventListener('change', draw);
  draw();
  return { el: h('div', { class: 'stack-tight' }, field('Starts on', startIn), h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Training days'), picker.el, hint)),
    body: () => ({ start_date: startIn.value || undefined, training_days: picker.value() }) };
}

// The client page's calendar panel. deps: { get, post, patch }, reload re-renders the page.
export function calendarPanel(cal, { first, canEdit, deps, reload }) {
  if (!cal?.program) return null;
  const { counts } = cal;
  const editBox = h('div');
  const summary = `Starts ${fmtDay(cal.start_date)} · ${dayText(cal.training_days)}${cal.days_default ? ' (the program\'s usual days)' : ''} · ${counts.done} done · ${counts.missed} missed · ${counts.upcoming} to go`;
  const changeForm = () => {
    const sched = scheduleFields({ start: cal.start_date, days: cal.training_days, need: cal.days_needed });
    fill(editBox, h('div', { class: 'dp-panel stack' }, sched.el,
      h('div', { class: 'row wrap' }, btn('Save schedule', (e) => busy(e.currentTarget, async () => {
        const r = await deps.patch(`/v1/clients/${cal.client_id}/training-calendar`, sched.body());
        toast(r.moves_cleared ? `Schedule saved. ${r.moves_cleared === 1 ? 'A moved workout is' : `${r.moves_cleared} moved workouts are`} back on the plan's days.` : 'Schedule saved.'); reload();
      }), 'primary'), btn('Cancel', () => fill(editBox), 'ghost'))));
  };
  const byWeek = new Map();
  for (const w of cal.workouts) byWeek.set(w.week, [...(byWeek.get(w.week) ?? []), w]);
  const nextId = cal.next?.id;
  const row = (w) => {
    const moveBox = h('span', { class: 'row', style: 'gap:6px;align-items:center' });
    const actions = canEdit && w.status !== 'done' ? h('div', { class: 'row wrap', style: 'gap:6px;justify-content:flex-end' },
      btn('Move', () => {
        const date = input({ type: 'date', value: w.date, 'aria-label': `New date for ${w.title}`, style: 'min-height:36px' });
        fill(moveBox, date, btn('Save', (e) => busy(e.currentTarget, async () => { if (!date.value) throw new Error('Pick a date.'); await deps.post(`/v1/clients/${cal.client_id}/training-calendar/moves`, { workout_id: w.id, date: date.value }); toast(`${w.title} moved to ${fmtDay(date.value)}.`); reload(); }), 'secondary'), btn('Cancel', () => fill(moveBox), 'ghost'));
        date.focus();
      }, 'ghost', { 'aria-label': `Move ${w.title}` }),
      w.moved ? btn('Back to plan', (e) => busy(e.currentTarget, async () => { await deps.post(`/v1/clients/${cal.client_id}/training-calendar/moves`, { workout_id: w.id, date: null }); toast(`${w.title} is back on its day.`); reload(); }), 'ghost') : null) : null;
    return h('div', { class: `tc-row${w.status === 'today' ? ' tc-row--today' : ''}` },
      h('span', { class: 'tc-date small' }, fmtDay(w.date)),
      h('span', { class: 'grow' }, h('span', { class: 'strong' }, w.title), h('span', { class: 'small muted' }, ` · day ${w.day}${w.moved ? ' · moved' : ''}${w.id === nextId ? ' · opens in the app' : ''}`)),
      statusBadge(w.status), moveBox, actions);
  };
  const weeks = [...byWeek.entries()].sort((a, b) => a[0] - b[0]).map(([week, list]) => {
    const open = list.some((w) => w.status === 'today' || w.id === nextId);
    const done = list.filter((w) => w.status === 'done').length;
    return h('details', { class: 'tc-week', open: open ? '' : null }, h('summary', null, `Week ${week}`, h('span', { class: 'small muted' }, ` · ${fmtDay(list[0].date, { month: 'short', day: 'numeric' })} to ${fmtDay(list.at(-1).date, { month: 'short', day: 'numeric' })} · ${done} of ${list.length} done`)), list.map(row));
  });
  return panel('Training calendar', { subtitle: summary, action: canEdit ? btn('Change schedule', changeForm, 'ghost') : null },
    cal.next ? h('p', { class: 'small muted', style: 'margin:0' }, `The app opens on ${cal.next.title} (${cal.next.status === 'today' ? 'today' : cal.next.status === 'missed' ? `missed ${fmtDay(cal.next.date)}` : fmtDay(cal.next.date)}). ${first} can open any other workout from the calendar in the app.`)
      : h('p', { class: 'small muted', style: 'margin:0' }, `${first} has finished every workout in ${cal.program.name}.`),
    editBox, ...weeks);
}
