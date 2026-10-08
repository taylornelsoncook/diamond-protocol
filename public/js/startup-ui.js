// The start-up questions (schema 67, services/startup.js) as one form for every screen: the athlete app (first open with
// no program, and "Your gear"), the family's Workout tab (the same app in a frame), the client page's Training tab (a
// coach answers for an athlete) and the Programs page's rules (the same choices pick which answers a rule covers).
import { h, fill, btn, input, field } from './ui.js';
import { daysPicker, defaultDays, dayText } from './training-days.js';

// A row of toggles. single: one at a time (a radio group); otherwise any number. value() answers the key or the keys.
export function choices(options, initial, { single = false, label = 'Choices', onChange } = {}) {
  const picked = new Set(single ? (initial ? [initial] : []) : (initial ?? []));
  const el = h('div', { class: 'su-choices', role: single ? 'radiogroup' : 'group', 'aria-label': label });
  const value = () => (single ? [...picked][0] ?? null : options.map((o) => o.key).filter((k) => picked.has(k)));
  const draw = () => fill(el, options.map((o) => h('button', { type: 'button', class: 'su-choice', role: single ? 'radio' : 'checkbox', 'aria-checked': String(picked.has(o.key)),
    onClick: () => { if (single) { picked.clear(); picked.add(o.key); } else if (picked.has(o.key)) picked.delete(o.key); else picked.add(o.key); draw(); onChange?.(value()); } }, o.label)));
  draw();
  return { el, value, set: (keys) => { picked.clear(); for (const k of [].concat(keys ?? [])) picked.add(k); draw(); } };
}
const DAYS = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ key: n, label: String(n) }));

// The questions, prefilled from the profile on file. body() is what PUT /app/api/startup and PUT /v1/clients/:id/training-profile take.
// who: 'athlete' (you), 'parent' (your athlete's name) or 'coach' (the athlete's first name), for the wording.
export function startupForm(questions, profile = null, { who = 'athlete', name = '' } = {}) {
  const you = who === 'athlete' ? 'you' : name || 'they', your = who === 'athlete' ? 'your' : `${name || 'their'}'s`;
  const goal = choices(questions.goals, profile?.goal, { single: true, label: 'Goal' });
  const sport = input({ value: profile?.sport ?? '', placeholder: 'Soccer, basketball, track…', autocomplete: 'off', 'aria-label': 'Sport' });
  const experience = choices(questions.experience, profile?.experience, { single: true, label: 'Experience' });
  let days = profile?.days_per_week ?? null;
  const dayHint = h('div', { class: 'small muted' });
  const picker = daysPicker(profile?.training_days ?? (days ? defaultDays(days) : []), { min: 1, onChange: (v) => { if (v.length && v.length !== days) { days = v.length; perWeek.set(days); } drawHint(); } });
  const perWeek = choices(DAYS, days, { single: true, label: 'Days a week', onChange: (n) => { days = n; picker.set(defaultDays(n)); drawHint(); } });
  const drawHint = () => { dayHint.textContent = picker.value().length ? `${dayText(picker.value())}: day 1 of each week lands on the first of these.` : 'Tap the days.'; };
  drawHint();
  const trainsAt = choices(questions.trains_at, profile?.trains_at, { single: true, label: 'Where' });
  const gear = choices(questions.gear, profile?.equipment ?? [], { label: 'Gear' });
  const gearBox = h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, `What ${who === 'athlete' ? 'do you have' : `does ${name || 'the athlete'} have`} at home?`), gear.el,
    h('span', { class: 'small muted' }, 'Tap everything on hand. Nothing picked means bodyweight only: exercises that need gear are swapped for ones that don\'t.'));
  const showGear = () => { gearBox.hidden = trainsAt.value() === 'facility'; };
  trainsAt.el.addEventListener('click', showGear); showGear();
  const note = h('textarea', { class: 'dp-input', style: 'min-height:56px', placeholder: who === 'athlete' ? 'Anything your coach should know? Tryouts, an injury, a goal…' : 'Anything to know' });
  note.value = profile?.note ?? '';
  const el = h('div', { class: 'stack su-form' },
    h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, `What ${who === 'athlete' ? 'do you want' : `does ${name || 'the athlete'} want`} most?`), goal.el),
    field('Sport', sport),
    h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, `How long ${who === 'athlete' ? 'have you' : `has ${name || 'the athlete'}`} been training?`), experience.el),
    h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, `How many days a week can ${you} train?`), perWeek.el),
    h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Which days?'), picker.el, dayHint),
    h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, `Where ${who === 'athlete' ? 'do you' : `does ${name || 'the athlete'}`} train on ${your} own days?`), trainsAt.el),
    gearBox,
    field('Notes', note));
  const body = () => {
    const picked = picker.value();
    return { goal: goal.value(), sport: sport.value.trim() || null, experience: experience.value(), days_per_week: days, training_days: picked.length ? picked : null, trains_at: trainsAt.value(),
      equipment: trainsAt.value() === 'facility' ? null : gear.value(), note: note.value.trim() || null };
  };
  const problem = () => {
    const b = body();
    if (!b.goal) return 'Pick a goal.';
    if (!b.experience) return 'Say how long the training has been going.';
    if (!b.days_per_week) return 'Pick how many days a week.';
    if (b.training_days && b.training_days.length !== b.days_per_week) return `You picked ${b.training_days.length} days but said ${b.days_per_week} a week.`;
    if (!b.trains_at) return 'Say where the training happens.';
    return null;
  };
  return { el, body, problem };
}
// The answers in one line: "Get faster · New to training · 3 days a week (Mon, Wed, Fri) · At home · Dumbbells, Bands".
export function summaryText(p) {
  if (!p) return '';
  return [p.goal_label, p.experience_label, p.days_per_week ? `${p.days_per_week} ${p.days_per_week === 1 ? 'day' : 'days'} a week${p.training_days?.length ? ` (${dayText(p.training_days)})` : ''}` : null, p.trains_at_label,
    p.equipment_answered ? (p.equipment_labels?.length ? p.equipment_labels.join(', ') : 'Bodyweight only') : null].filter(Boolean).join(' · ');
}
// What came of the answers, in words for a coach.
export const OUTCOME_TEXT = { assigned: 'Placed on a program by the start-up rules', suggested: 'A program is suggested; approve it or assign another', no_match: 'No rule fits the answers; assign a program by hand', coach: 'A coach places them' };
export const ALL_WORD = { goals: 'Any goal', experience: 'Any experience', equipment: 'No gear needed' };
export { btn };
