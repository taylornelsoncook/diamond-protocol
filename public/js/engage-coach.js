// Coach side of Accountability, Performance and Education: panels on the client profile and team page,
// check-in flags on Today, the rankings switch in Hours & settings, and the Education screen.
// Owners and coaches manage; front desk sees everything read-only (the server enforces the same).
import { h, fill, toast, busy, btn, field, input, select, panel, ago, videoEmbed } from './ui.js';
import { sparkline, fmtResult } from './charts.js';
import { saleForm } from './shop-admin.js';

let deps = null;     // { api, render, header, role }
export function initEngage(d) { deps = d; }
const get = (p) => deps.api('GET', p), post = (p, b = {}) => deps.api('POST', p, b), patch = (p, b) => deps.api('PATCH', p, b), put = (p, b) => deps.api('PUT', p, b), del = (p) => deps.api('DELETE', p);
const canManage = () => ['owner', 'coach'].includes(deps.role());
const day = (d, opts = {}) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...opts }) : '');
const todayIso = () => new Date().toLocaleDateString('en-CA');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const bar = (pct, label) => h('div', { class: 'eg-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': label }, h('span', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));
const tag = (text, tone = 'neutral') => h('span', { class: `dp-badge dp-badge--${tone}` }, text);
const textarea = (value = '', attrs = {}) => { const t = h('textarea', { class: 'dp-input', ...attrs }); t.value = value ?? ''; return t; };
export const BADGE_CATEGORIES = ['Speed', 'Strength', 'Power', 'Mobility', 'Skill', 'Mindset'];
export const GOAL_KINDS = [['workouts', 'Workouts'], ['sessions', 'Sessions attended'], ['checkins', 'Daily check-ins'], ['custom', 'Custom (athlete ticks it off)']];
const MEASURES = [['sleep_hours', 'Sleep', (x) => `${x} h`, 'higher'], ['hydration', 'Hydration', (x) => `${x} of 5`, 'higher'], ['soreness', 'Soreness', (x) => `${x} of 5`, 'lower'], ['energy', 'Energy', (x) => `${x} of 5`, 'higher'], ['mood', 'Mood', (x) => `${x} of 5`, 'higher']];
const valueHint = (unit) => (unit === 'in' ? 'Inches, or feet and inches like 6\'8"' : unit === 's' ? 'Seconds, like 5.75' : unit ? `In ${unit}` : 'Choose a test first');
function openDialog(...kids) {
  const d = document.getElementById('dialog');
  fill(d, ...kids);
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
  return d;
}

// ---------- Client profile ----------
// en = GET /v1/clients/:id/engagement; tests = GET /v1/tests (for the target picker).
export function clientPanels(c, en, tests, badgeList = []) {
  const manage = canManage(), first = c.name.split(' ')[0], id = c.id, today = en.today;
  const w = en.this_week, st = en.streaks;
  const stat = (label, value) => h('div', null, h('b', null, value), h('span', null, label));
  const accountability = panel('Accountability', { subtitle: 'Streaks, this week so far, and daily check-ins over the last 30 days.' },
    h('div', { class: 'cl-stats' }, stat(`Check-in ${st.checkin_days === 1 ? 'day' : 'days'} in a row`, st.checkin_days), stat(`Active ${st.active_weeks === 1 ? 'week' : 'weeks'} in a row`, st.active_weeks),
      stat('Workouts this week', w.workouts), stat('Sessions this week', w.sessions), stat('Check-ins this week', w.checkins)),
    en.checkins.length ? [h('div', { class: 'dp-label' }, `30-day averages from ${plural(en.checkins.length, 'check-in')}`),
      h('div', null, MEASURES.map(([k, label, fmt, better]) => {
        const pts = en.checkins.filter((x) => x[k] != null).map((x) => ({ value: x[k] }));
        return h('div', { class: 'cl-avg small' }, h('span', null, label, k === 'soreness' ? h('span', { class: 'muted' }, ' · lower is better') : null),
          h('span', { class: 'strong' }, en.averages[k] == null ? '—' : fmt(en.averages[k])),
          h('span', { style: 'color:var(--green-bright)' }, pts.length > 1 ? sparkline(pts, { better, width: 96, height: 24, label: `${label} trend` }) : null));
      }))] : h('p', { class: 'muted small' }, `No check-ins in the last 30 days. ${first} checks in from the app, or a parent does from the portal.`),
    en.flagged.length ? [h('div', { class: 'dp-label' }, 'Check-ins that need a look'),
      h('div', { class: 'stack', style: 'gap:8px' }, en.flagged.map((x) => h('div', { class: 'cl-flag small' }, h('span', { class: 'strong' }, x.date === today ? 'Today' : day(x.date, { weekday: 'short' })),
        h('span', { class: 'warn-text' }, ` · ${x.flags.join(' · ')}`), x.note ? h('div', { class: 'muted' }, `"${x.note}"`) : null)))] : null);

  const kind = select(GOAL_KINDS, { value: 'workouts', 'aria-label': 'What the goal counts' }), per = input({ type: 'number', min: '1', max: '14', value: '3', inputmode: 'numeric' }), title = input({ maxlength: '120', placeholder: 'Like 3 workouts this week' });
  const goals = panel('Weekly goals', { subtitle: `Progress this week, Monday to Sunday. Workouts, sessions and check-ins count themselves; ${first} ticks off custom goals.` },
    en.goals.length ? h('div', null, en.goals.map((g) => h('div', { class: 'list-item', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack', style: 'gap:6px' }, h('span', { class: 'strong' }, g.title, g.team ? h('span', { class: 'small muted', style: 'font-weight:400' }, ' · team goal') : null),
        h('span', { class: 'small muted' }, `${g.kind_label} · ${g.progress} of ${g.target} this week`), bar(Math.round(Math.min(1, g.progress / g.target) * 100), `${g.title} progress`)),
      g.done ? tag('Done', 'good') : null,
      manage && !g.team ? btn('End', (e) => { if (confirm(`End "${g.title}"? It comes off ${first}'s list. Past weeks aren't affected.`)) busy(e.currentTarget, async () => { await patch(`/v1/goals/${g.id}`, { active: false }); toast('Goal ended.'); deps.render(); }); }, 'ghost') : null)))
      : h('p', { class: 'muted small' }, 'No goals yet.'),
    manage ? h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      await post(`/v1/clients/${id}/goals`, { kind: kind.value, target: Number(per.value), title: title.value || undefined }); toast('Goal added. It shows in the app now.'); deps.render();
    }); } }, h('div', { class: 'form-grid' }, field('What it counts', kind), field('Per week', per)), field('Goal (optional)', title, 'Leave blank to name it from what it counts.'), h('div', null, btn('Add goal', null, 'secondary', { type: 'submit' }))) : null);

  const body = textarea('', { rows: '3', maxlength: '2000', placeholder: `Write to ${first}`, 'aria-label': `Message to ${first}` });
  // Replies from the athlete or a parent count as seen once a coach opens this page.
  const unseen = en.messages.filter((m) => m.from && m.from !== 'coach' && !m.seen_by_coach);
  if (unseen.length && canManage()) post(`/v1/clients/${id}/messages/seen`).catch(() => {});
  const author = (m) => (m.from === 'coach' || !m.from ? `${m.coach ?? 'Coach'}` : m.from === 'parent' ? `${m.author} (parent)` : m.author ?? first);
  const messages = panel('Messages', { subtitle: h('span', null, `Notes between coaches and ${first}${c.family ? ' and their parents' : ''}. They read and reply in the app`, en.unread ? h('span', { class: 'warn-text' }, ` · ${en.unread} unread by ${first}`) : null, '.') },
    manage ? h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      await post(`/v1/clients/${id}/messages`, { body: body.value }); toast(`Sent. ${first} and their parents are emailed a copy.`); deps.render();
    }); } }, body, h('div', { class: 'row wrap' }, h('span', { class: 'small muted grow' }, `${first}${c.family ? ' and their parents' : ''} are emailed a copy.`), btn('Send message', null, 'secondary', { type: 'submit' }))) : null,
    en.messages.length ? h('div', null, en.messages.slice(0, 12).map((m) => h('div', { class: 'list-item', style: `align-items:flex-start${m.from && m.from !== 'coach' ? ';padding-left:16px;border-left:3px solid var(--green-mid)' : ''}` },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'eg-note' }, m.body), h('span', { class: 'small muted' }, `${author(m)} · ${ago(m.created_at)}${m.team ? ' · to the team' : ''}`)),
      m.from && m.from !== 'coach' ? (unseen.includes(m) ? tag('New reply') : null) : m.read ? h('span', { class: 'small muted' }, 'Read') : tag('Unread')))) : h('p', { class: 'muted small' }, 'No messages yet.'));

  const tested = new Set(en.tests.map((t) => t.test));
  const unitOf = new Map(tests.map((t) => [t.key, t.metrics[0]?.unit]));
  const testSel = h('select', { class: 'select', 'aria-label': 'Test' }, h('option', { value: '' }, 'Choose a test'),
    en.tests.length ? h('optgroup', { label: `${first} has done` }, en.tests.map((t) => h('option', { value: t.test }, `${t.test_name}${t.best_text ? ` (best ${t.best_text})` : ''}`))) : null,
    h('optgroup', { label: 'All tests' }, tests.filter((t) => !tested.has(t.key) && t.metrics[0]?.better !== 'none').map((t) => h('option', { value: t.key }, t.name))));
  const target = input({ autocomplete: 'off' }), due = input({ type: 'date', min: todayIso() });
  const hint = h('div', { class: 'dp-hint' }, valueHint(null));
  testSel.addEventListener('change', () => { hint.textContent = valueHint(unitOf.get(testSel.value)); });
  const rankingsBlock = en.rankings ? [h('div', { class: 'dp-label' }, `Where ${first} ranks (best result; athletes and parents see this without names)`),
    en.rankings.length ? h('div', null, en.rankings.map((r) => h('div', { class: 'list-item small', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack-tight' }, h('span', null, h('span', { class: 'strong' }, r.test_name.replace(/\s*\(.*\)$/, '')), h('span', { class: 'muted' }, ` · best ${r.best_text}`)),
        h('div', { class: 'row wrap', style: 'gap:6px;margin-top:4px' }, r.ranks.map((k) => tag(`${ordinal(k.rank)} of ${k.of} · ${k.group}`)))))))
      : h('p', { class: 'muted small' }, 'Not enough athletes have done the same tests to rank yet (4 or more).')]
    : h('p', { class: 'small muted' }, 'Rankings are off. ', manage ? h('a', { href: '#/schedule/setup' }, 'Turn them on in Hours & settings.') : null);
  const targets = panel('Test targets', { subtitle: 'Best result so far against the target. Progress counts from the first test.' },
    en.targets.length ? h('div', null, en.targets.map((t) => h('div', { class: 'list-item', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack', style: 'gap:6px' }, h('span', { class: 'strong' }, t.test_name),
        h('span', { class: 'small muted' }, `${t.best_text ? `Best ${t.best_text}` : 'Not tested yet'} → target ${t.target_text}`, t.due_date ? h('span', { class: !t.reached && t.due_date < today ? 'warn-text' : '' }, ` · by ${day(t.due_date)}`) : null),
        bar(t.pct, `${t.test_name}: ${t.pct}%`)),
      t.reached ? tag('Reached', 'good') : h('span', { class: 'small muted' }, `${t.pct}%`),
      manage ? btn('Remove', (e) => { if (confirm(`Remove the ${t.test_name} target? Results stay.`)) busy(e.currentTarget, async () => { await del(`/v1/targets/${t.id}`); toast('Target removed.'); deps.render(); }); }, 'ghost') : null)))
      : h('p', { class: 'muted small' }, 'No targets yet.'),
    manage ? h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const r = await post(`/v1/clients/${id}/targets`, { test: testSel.value, target: target.value, due_date: due.value || null }); toast(`Target set: ${r.target_text}.`); deps.render();
    }); } }, field('Test', testSel), h('div', { class: 'form-grid' }, h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: target.id || (target.id = 'tg-value') }, 'Target'), target, hint), field('By (optional)', due)),
      h('div', null, btn('Set target', null, 'secondary', { type: 'submit' }))) : null,
    rankingsBlock);

  const as = en.education.assigned;
  const education = panel('Education', { subtitle: `${plural(en.education.completed, 'lesson')} finished. Assigned reading shows first in ${first}'s app.`, action: manage ? btn('Assign lesson', () => assignDialog({ client: { id, name: c.name } }), 'secondary') : null },
    as.length ? h('div', null, as.map((x) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', null, x.title, h('span', { class: 'small muted' }, ` · ${x.type === 'course' ? `Course, ${x.progress}` : 'Lesson'}${x.team ? ' · team' : ''}`)),
        h('span', { class: 'small muted' }, x.due_date ? h('span', { class: x.overdue ? 'warn-text' : '' }, `${x.overdue ? 'Overdue, was due' : 'Due'} ${day(x.due_date)}`) : 'No due date', x.note ? ` · ${x.note}` : '')),
      x.done ? tag('Done', 'good') : x.overdue ? tag('Overdue', 'warn') : tag('Not done', 'muted')))) : h('p', { class: 'muted small' }, 'Nothing assigned.'));
  // Skill badges: earned ones, newest first, and a form to award one (or make a new one on the spot).
  const earned = en.skill_badges ?? [];
  const have = new Set(earned.map((b) => b.badge_id));
  const pick = select([['', 'Choose a badge'], ...badgeList.filter((b) => !have.has(b.id)).map((b) => [b.id, b.category ? `${b.name} (${b.category})` : b.name]), ['new', 'New badge…']], { 'aria-label': 'Badge to award' });
  const newName = input({ maxlength: '60', placeholder: 'Like Sprint start' }), newCat = select([['', 'No category'], ...BADGE_CATEGORIES.map((x) => [x, x])], { 'aria-label': 'Badge category' });
  const newDesc = input({ maxlength: '300', placeholder: 'What it shows, like "Explodes out of a 3-point stance with a clean first step"' });
  const newFields = h('div', { class: 'stack', hidden: true }, h('div', { class: 'form-grid' }, field('Badge name', newName), field('Category', newCat)), field('What it means (optional)', newDesc));
  pick.addEventListener('change', () => { newFields.hidden = pick.value !== 'new'; if (pick.value === 'new') newName.focus(); });
  const note = input({ maxlength: '300', placeholder: `A word for ${first} (optional)`, 'aria-label': 'Note with the badge' });
  const badges = panel('Skill badges', { subtitle: `Earned skills ${first}${c.family ? ' and their parents' : ''} see on the Performance tab. Awarding one emails them.` },
    earned.length ? h('div', { class: 'cl-badges' }, earned.map((b) => h('div', { class: 'cl-badge' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, b.name, b.category ? h('span', { class: 'small muted', style: 'font-weight:400' }, ` · ${b.category}`) : null),
        h('span', { class: 'small muted' }, `${day(b.awarded_at)} by ${b.awarded_by ?? 'a coach'}${b.note ? ` · "${b.note}"` : ''}`)),
      manage ? btn('Take back', (e) => { if (confirm(`Take back "${b.name}" from ${first}? It disappears from their app. No email is sent.`)) busy(e.currentTarget, async () => { await del(`/v1/badge-awards/${b.id}`); toast('Badge taken back.'); deps.render(); }); }, 'ghost') : null)))
      : h('p', { class: 'muted small' }, 'No badges yet.'),
    manage ? h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      if (!pick.value) throw new Error('Choose a badge to award, or pick "New badge…".');
      const badgeId = pick.value === 'new' ? (await post('/v1/skill-badges', { name: newName.value, category: newCat.value || null, description: newDesc.value || undefined })).id : pick.value;
      await post(`/v1/skill-badges/${badgeId}/awards`, { client_id: id, note: note.value || undefined });
      toast(`Badge awarded. ${first}${c.family ? ' and their parents' : ''} got an email.`); deps.render();
    }); } }, field('Badge', pick), newFields, note, h('div', null, btn('Award badge', null, 'secondary', { type: 'submit' }))) : null);
  return { accountability, goals, messages, targets, education, badges };
}

// ---------- Today ----------
export async function flagsPanel() {
  const { data } = await get('/v1/daily-check-ins/flags');
  if (!data.length) return null;
  return panel('Check-ins that need a look', { subtitle: 'Latest daily check-in from today or yesterday: short sleep, high soreness, or low energy, mood or water.' },
    data.map((f) => h('div', { class: 'list-item', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack-tight' }, h('a', { href: `#/clients/${f.client_id}`, class: 'strong', style: 'color:var(--steel)' }, f.name),
        h('span', { class: 'small warn-text' }, f.flags.join(' · ')), f.readiness && f.date === todayIso() ? h('span', { class: 'small muted' }, f.readiness === 'red' ? 'Their app suggests an easy day: lower weights and one set less.' : 'Their app suggests slightly lower weights.') : null, f.note ? h('span', { class: 'small muted' }, `"${f.note}"`) : null),
      h('span', { class: 'small muted' }, f.date === todayIso() ? 'Today' : 'Yesterday'),
      h('a', { class: 'dp-btn dp-btn--outline', href: `#/clients/${f.client_id}` }, 'Open'))));
}

// ---------- Hours & settings ----------
export function rankingsPanel(settings) {
  const on = h('input', { type: 'checkbox', checked: settings.rankings === 'on', disabled: !canManage() });
  return panel('Rankings', { subtitle: 'Athletes and parents see where a best result ranks: against the same sex and age group, their team, and everyone here. Only counts and percentages, never anyone else\'s name. Groups need 4 or more athletes tested.' },
    h('label', { class: 'row small', style: 'gap:8px;min-height:40px' }, on, h('span', null, 'Show rankings in the athlete app and parent portal')),
    canManage() ? h('div', null, btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/engagement/settings', { rankings: on.checked ? 'on' : 'off' }); toast(on.checked ? 'Rankings are on.' : 'Rankings are off.'); }), 'secondary')) : null);
}
export function readinessPanel(settings) {
  const on = h('input', { type: 'checkbox', checked: settings.readiness_adjust !== 'off', disabled: !canManage() });
  return panel('Lighter days after a rough check-in', { subtitle: 'When an athlete\'s daily check-in shows short sleep, high soreness, or low energy, mood or water, their app says so above the workout. One problem takes weights set from a tested max down 10 points (75% becomes 65%). Two or more, under 5 hours of sleep, or soreness 5 of 5 makes it an easy day: down 20 points and one set less.' },
    h('label', { class: 'row small', style: 'gap:8px;min-height:40px' }, on, h('span', null, 'Adjust workouts from daily check-ins')),
    canManage() ? h('div', null, btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/engagement/settings', { readiness_adjust: on.checked ? 'on' : 'off' }); toast(on.checked ? 'Workouts adjust to check-ins.' : 'Workouts no longer adjust to check-ins.'); }), 'secondary')) : null);
}

// ---------- Team page ----------
export async function teamPanel(contractId) {
  const t = await get(`/v1/teams/${contractId}/engagement`);
  const manage = canManage();
  const kind = select(GOAL_KINDS.filter(([k]) => k !== 'custom'), { value: 'sessions', 'aria-label': 'What the goal counts' }), per = input({ type: 'number', min: '1', max: '14', value: '2' }), title = input({ placeholder: 'Make 2 team sessions this week' });
  const body = textarea('', { rows: '3', maxlength: '2000', placeholder: 'Write to the whole team', 'aria-label': 'Message to the team' });
  return panel('Goals, messages & reading', { subtitle: t.athletes.length ? `Reaches ${plural(t.athletes.length, 'athlete')} on this roster who ${t.athletes.length === 1 ? 'has' : 'have'} the app.` : 'No one is on this roster yet. Add athletes on the Roster panel to reach them.',
    action: manage ? btn('Assign lesson', () => assignDialog({ team: { id: contractId, name: t.team.name } }), 'secondary') : null },
    h('div', { class: 'dp-label' }, 'Weekly team goals'),
    t.goals.length ? t.goals.map((g) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, `${g.title} · ${g.kind_label}, ${g.target} a week`),
      manage ? btn('End', (e) => busy(e.currentTarget, async () => { await patch(`/v1/goals/${g.id}`, { active: false }); toast('Goal ended.'); deps.render(); }), 'ghost') : null)) : h('p', { class: 'muted small' }, 'No team goals.'),
    manage ? h('form', { class: 'row wrap', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { await post(`/v1/teams/${contractId}/goals`, { kind: kind.value, target: Number(per.value), title: title.value || undefined }); toast('Team goal added.'); deps.render(); }); } },
      h('div', { style: 'min-width:170px' }, field('Counts', kind)), h('div', { style: 'width:90px' }, field('Per week', per)), h('div', { class: 'grow', style: 'min-width:180px' }, field('Goal (optional)', title)), h('div', { style: 'align-self:flex-end' }, btn('Add goal', null, 'secondary', { type: 'submit' }))) : null,
    h('div', { class: 'dp-label' }, 'Messages to the team'),
    manage ? h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { const r = await post(`/v1/teams/${contractId}/messages`, { body: body.value }); toast(`Sent to ${plural(r.recipients, 'athlete')}. Parents are emailed a copy.`); deps.render(); }); } },
      body, h('div', null, btn('Send to the team', null, 'secondary', { type: 'submit' }))) : null,
    t.messages.length ? t.messages.slice(0, 5).map((m) => h('div', { class: 'list-item small', style: 'align-items:flex-start' }, h('span', { class: 'grow eg-note' }, m.body), h('span', { class: 'muted' }, `${m.coach ?? ''} · ${ago(m.created_at)}`))) : h('p', { class: 'muted small' }, 'No team messages yet.'),
    t.assignments.length ? [h('div', { class: 'dp-label' }, 'Assigned reading'), t.assignments.map((x) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, `${x.title}${x.due_date ? ` · due ${day(x.due_date)}` : ''}`), h('span', { class: 'muted' }, `${x.finished} of ${x.total} finished`)))] : null);
}

// ---------- Assign a lesson or course ----------
// preset: { client: {id, name} } or { team: {id, name} } fixes who; { lesson_id } or { course_id } preselects what.
export async function assignDialog(preset = {}) {
  const [edu, clientsList, teamsList] = await Promise.all([get('/v1/education'), preset.client || preset.team ? null : get('/v1/clients'), preset.client || preset.team ? null : get('/v1/teams')]);
  const courses = edu.courses.filter((c) => c.published && c.lessons.some((l) => l.published));
  const lessons = [...edu.lessons, ...edu.courses.flatMap((c) => c.lessons)].filter((l) => l.published);
  if (!lessons.length) return toast('Publish a lesson first.', 'warn');
  const pre = preset.course_id ? `c:${preset.course_id}` : preset.lesson_id ? `l:${preset.lesson_id}` : '';
  const what = h('select', { class: 'select' }, h('option', { value: '' }, 'Choose one'),
    courses.length ? h('optgroup', { label: 'Courses' }, courses.map((c) => h('option', { value: `c:${c.id}`, selected: pre === `c:${c.id}` }, `${c.title} (${plural(c.lessons.filter((l) => l.published).length, 'lesson')})`))) : null,
    h('optgroup', { label: 'Lessons' }, lessons.map((l) => h('option', { value: `l:${l.id}`, selected: pre === `l:${l.id}` }, l.title))));
  const fixed = preset.client || preset.team;
  const whoKind = select([['client', 'An athlete'], ['team', 'A team']], { value: 'client' });
  const clientSel = select([['', 'Choose an athlete'], ...(clientsList?.data ?? []).filter((c) => c.status !== 'canceled').map((c) => [c.id, `${c.name}${c.athlete_id ? ` · ${c.athlete_id}` : ''}`])]);
  const teamSel = select([['', 'Choose a team'], ...(teamsList?.data ?? []).map((t) => [t.id, `${t.label} (${plural(t.app_athletes, 'athlete')} with the app)`])]);
  const clientField = field('Athlete', clientSel), teamField = field('Team', teamSel, 'Everyone on the roster with the app gets it, including athletes added later.');
  teamField.hidden = true;
  whoKind.addEventListener('change', () => { clientField.hidden = whoKind.value !== 'client'; teamField.hidden = whoKind.value !== 'team'; });
  const due = input({ type: 'date', min: todayIso() }), note = textarea('', { rows: '2', maxlength: '500', placeholder: 'Why it matters, or where to start', style: 'min-height:64px' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const d = openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try {
      if (!what.value) throw new Error('Choose a lesson or a course.');
      const [k, itemId] = [what.value.slice(0, 1), what.value.slice(2)];
      const body = { [k === 'c' ? 'course_id' : 'lesson_id']: itemId, due_date: due.value || null, note: note.value.trim() || null };
      if (preset.client) body.client_id = preset.client.id;
      else if (preset.team) body.contract_id = preset.team.id;
      else if (whoKind.value === 'client') { if (!clientSel.value) throw new Error('Choose an athlete.'); body.client_id = clientSel.value; }
      else { if (!teamSel.value) throw new Error('Choose a team.'); body.contract_id = teamSel.value; }
      const r = await post('/v1/lesson-assignments', body);
      d.close();
      toast(`Assigned "${r.title}"${r.recipients > 1 ? ` to ${plural(r.recipients, 'athlete')}` : ''}. They and their parents are emailed.`);
      deps.render();
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel)' }, 'Assign lesson'),
    field('Lesson or course', what),
    fixed ? h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'For'), h('div', null, fixed.name, preset.team ? h('span', { class: 'small muted' }, ' (everyone on the roster with the app)') : null))
      : [field('For', whoKind), clientField, teamField],
    field('Due date (optional)', due), field('Note (optional)', note, 'The athlete and their parents are emailed a link.'),
    err, h('div', { class: 'row' }, btn('Assign', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
}

// ---------- Lesson and course editors ----------
async function lessonDialog(lesson, courses, preset = {}) {
  const l = lesson ? await get(`/v1/lessons/${lesson.id}`) : { published: true, course_id: preset.course_id ?? null };
  const f = { title: input({ value: l.title ?? '', maxlength: '160' }), summary: input({ value: l.summary ?? '', maxlength: '300' }), body: textarea(l.body ?? '', { style: 'min-height:200px' }),
    video_url: input({ type: 'url', value: l.video_url ?? '', placeholder: 'https://www.youtube.com/watch?v=…' }), minutes: input({ type: 'number', min: '1', max: '240', value: l.minutes ?? '' }),
    course_id: select([['', 'Stand-alone lesson'], ...courses.map((c) => [c.id, c.title])], { value: l.course_id ?? '' }), published: h('input', { type: 'checkbox', checked: !!l.published }),
    quiz: textarea(l.quiz_text ?? '', { style: 'min-height:140px;font-family:var(--font-mono);font-size:14px', placeholder: 'What should your knees do when you land?\n- Cave inward\n* Track over your toes\n- Lock straight' }) };
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const d = openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try {
      const body = { title: f.title.value, summary: f.summary.value || null, body: f.body.value || null, video_url: f.video_url.value || null, minutes: f.minutes.value ? Number(f.minutes.value) : null, course_id: f.course_id.value || null, published: f.published.checked, quiz_text: f.quiz.value };
      if (lesson) await patch(`/v1/lessons/${lesson.id}`, body); else await post('/v1/lessons', body);
      d.close(); toast(lesson ? 'Lesson saved.' : f.published.checked ? 'Lesson posted. Athletes can read it now.' : 'Draft saved. Athletes won\'t see it until you publish it.'); deps.render();
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel)' }, lesson ? 'Edit lesson' : 'New lesson'),
    field('Title', f.title), field('Summary', f.summary, 'One line under the title.'),
    field('Lesson text', f.body, 'Plain text. Leave a blank line between paragraphs.'),
    h('div', { class: 'form-grid' }, field('Video link (optional)', f.video_url, 'YouTube, Vimeo or a direct .mp4 link, starting with https://'), field('Minutes to read or watch', f.minutes)),
    field('Course', f.course_id),
    field('Quiz (optional)', f.quiz, 'A question on one line, then its choices below, each starting with - and the right one with *. A blank line between questions. Up to 10. Athletes need 80% to finish the lesson.'),
    h('label', { class: 'row small', style: 'gap:8px;min-height:40px' }, f.published, h('span', null, 'Published: athletes and parents can see it')),
    err, h('div', { class: 'row' }, btn(lesson ? 'Save lesson' : 'Post lesson', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  f.title.focus();
}
// Owners: price a course and put it in the online store.
async function saleDialog(courseId) {
  const info = (await get('/v1/shop')).courses.find((x) => x.id === courseId);
  const d = openDialog(h('div', { class: 'stack' }, h('h2', { class: 'dp-panel-title' }, `Sell ${info.title} online`),
    saleForm(put, 'course', info, () => { d.close(); deps.render(); }), h('div', null, btn('Close', () => d.close(), 'ghost'))));
}
function courseDialog(course) {
  const title = input({ value: course?.title ?? '', maxlength: '160' }), desc = textarea(course?.description ?? '', { rows: '3', style: 'min-height:72px' }), pub = h('input', { type: 'checkbox', checked: course ? course.published : true });
  const audience = select([['athletes', 'Athletes (and their parents with them)'], ['parents', 'Parents only: shows under For parents in the parent portal']], { value: course?.audience ?? 'athletes' });
  const ageMin = input({ type: 'number', min: '3', max: '25', inputmode: 'numeric', value: course?.age_min ?? '', placeholder: 'Any' }), ageMax = input({ type: 'number', min: '3', max: '25', inputmode: 'numeric', value: course?.age_max ?? '', placeholder: 'Any' });
  const ages = h('div', { class: 'form-grid', hidden: audience.value !== 'parents' }, field('For parents of athletes aged from', ageMin), field('to', ageMax));
  audience.addEventListener('change', () => { ages.hidden = audience.value !== 'parents'; });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const d = openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try {
      const body = { title: title.value, description: desc.value || null, published: pub.checked, audience: audience.value, age_min: ageMin.value || null, age_max: ageMax.value || null };
      if (course) await patch(`/v1/courses/${course.id}`, body); else await post('/v1/courses', body);
      d.close(); toast(course ? 'Course saved.' : 'Course created. Add lessons to it.'); deps.render();
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel)' }, course ? 'Edit course' : 'New course'),
    field('Title', title), field('Description', desc), field('Who it\'s for', audience), ages,
    h('label', { class: 'row small', style: 'gap:8px;min-height:40px' }, pub, h('span', null, 'Published')),
    err, h('div', { class: 'row' }, btn(course ? 'Save course' : 'Create course', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  title.focus();
}
async function previewLesson(id) {
  const l = await get(`/v1/lessons/${id}`);
  const d = openDialog(h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, l.published ? 'What athletes and parents see' : 'Draft: athletes see this once you publish it'), btn('Close', () => d.close(), 'ghost')),
    h('h2', { class: 'eg-reader-t' }, l.title), l.summary ? h('p', { class: 'muted' }, l.summary) : null,
    l.video_url ? videoEmbed(l.video_url, l.title) : null,
    h('div', { class: 'eg-body' }, String(l.body ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => h('p', null, p)))));
}

// ---------- Education screen ----------
export async function viewEducation(main) {
  const edu = await get('/v1/education');
  const manage = canManage();
  const lessonRow = (l, i, list, course) => h('div', { class: 'edu-row' },
    course ? h('span', { class: 'edu-n' }, i + 1) : null,
    h('div', { class: 'edu-grow stack-tight' }, h('span', { class: 'strong' }, l.title, l.published ? null : h('span', { class: 'small muted', style: 'font-weight:400' }, ' · draft')),
      h('span', { class: 'small muted' }, [l.minutes ? `${l.minutes} min` : null, l.has_video ? 'Video' : null, l.has_quiz ? 'Quiz' : null, course?.audience === 'parents' ? null : `${plural(l.completions, 'athlete')} finished`].filter(Boolean).join(' · '))),
    h('div', { class: 'edu-acts' },
      course && manage ? [btn('↑', (e) => move(e, course, i, -1), 'ghost', { 'aria-label': `Move ${l.title} up`, disabled: i === 0 }), btn('↓', (e) => move(e, course, i, 1), 'ghost', { 'aria-label': `Move ${l.title} down`, disabled: i === list.length - 1 })] : null,
      btn('Preview', () => previewLesson(l.id), 'ghost'),
      manage ? btn('Edit', () => lessonDialog(l, edu.courses), 'ghost') : null,
      manage && l.published && course?.audience !== 'parents' ? btn('Assign', () => assignDialog({ lesson_id: l.id }), 'ghost') : null,
      manage ? btn('Delete', (e) => { if (confirm(`Delete "${l.title}"? Completions are removed too.`)) busy(e.currentTarget, async () => { await del(`/v1/lessons/${l.id}`); toast('Lesson deleted.'); deps.render(); }); }, 'ghost') : null));
  async function move(e, course, i, dir) {
    const ids = course.lessons.map((l) => l.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    await busy(e.currentTarget, async () => { await put(`/v1/courses/${course.id}/order`, { lesson_ids: ids }); deps.render(); });
  }
  const starter = !edu.courses.some((c) => c.audience === 'parents') && manage ? h('div', { class: 'dp-panel stack', style: 'background:transparent' },
    h('span', { class: 'strong' }, 'Courses for parents'), h('p', { class: 'small muted', style: 'margin:0' }, 'Short courses parents read in the parent portal, shown by their athlete\'s age. Start from three drafts (growth spurts, fueling, recruiting basics), then read, edit and publish them.'),
    h('div', null, btn('Add starter drafts', (e) => busy(e.currentTarget, async () => { toast((await post('/v1/courses/starter-parent')).message); deps.render(); }), 'secondary'))) : null;
  const coursesPanel = panel('Courses', { subtitle: 'Lessons in order. Athletes see the next lesson when they finish one. Parent courses show in the parent portal.', action: manage ? btn('New course', () => courseDialog(null), 'secondary') : null },
    starter,
    edu.courses.length ? edu.courses.map((c) => h('div', { class: 'edu-course' },
      h('div', { class: 'row wrap' }, h('div', { class: 'edu-grow stack-tight' }, h('span', { class: 'edu-course-title' }, c.title), h('span', { class: 'small muted' }, `${c.audience === 'parents' ? `For parents${c.age_min != null || c.age_max != null ? `, ages ${c.age_min ?? 'any'}–${c.age_max ?? 'any'}` : ''} · ${plural(c.parents_reading ?? 0, 'parent')} reading · ` : ''}${plural(c.lessons.length, 'lesson')}${c.certificates ? ` · ${plural(c.certificates, 'certificate')} earned` : ''}${c.published ? '' : ' · draft, hidden from athletes'}${c.for_sale ? ' · for sale online' : ''}${c.description ? ` · ${c.description}` : ''}`)),
        manage ? h('div', { class: 'edu-acts' }, btn('Add lesson', () => lessonDialog(null, edu.courses, { course_id: c.id }), 'ghost'), c.audience !== 'parents' && c.published && c.lessons.some((l) => l.published) ? btn('Assign', () => assignDialog({ course_id: c.id }), 'ghost') : null, btn('Edit', () => courseDialog(c), 'ghost'),
          deps.role() === 'owner' && c.audience !== 'parents' ? btn(c.for_sale ? 'For sale' : 'Sell online', (e) => busy(e.currentTarget, () => saleDialog(c.id)), 'ghost') : null,
          btn('Delete', (e) => { if (confirm(`Delete the course "${c.title}"? Its lessons stay in the library.`)) busy(e.currentTarget, async () => { await del(`/v1/courses/${c.id}`); toast('Course deleted. Its lessons are in the library.'); deps.render(); }); }, 'ghost')) : null),
      c.lessons.length ? h('div', null, c.lessons.map((l, i, list) => lessonRow(l, i, list, c))) : h('p', { class: 'muted small' }, 'No lessons yet.')))
      : h('p', { class: 'muted' }, 'No courses yet. A course is a short series of lessons, like "Recovery basics".'));
  const libraryPanel = panel('Lesson library', { subtitle: 'Stand-alone lessons.', action: manage ? btn('New lesson', () => lessonDialog(null, edu.courses), 'primary') : null },
    edu.lessons.length ? h('div', null, edu.lessons.map((l, i, list) => lessonRow(l, i, list, null))) : h('p', { class: 'muted' }, 'No stand-alone lessons yet.'));
  const assignmentsPanel = panel('Assigned', { subtitle: 'Who has finished what you assigned.', action: manage ? btn('Assign lesson', () => assignDialog({}), 'secondary') : null },
    edu.assignments.length ? edu.assignments.map((x) => {
      const overdue = x.due_date && x.due_date < todayIso() && x.finished < x.total;
      return h('div', { class: 'edu-row' },
        h('div', { class: 'edu-grow stack-tight' }, h('span', null, h('span', { class: 'strong' }, x.title), h('span', { class: 'small muted' }, ` · ${x.type === 'course' ? 'course' : 'lesson'} for `),
          x.client_id ? h('a', { href: `#/clients/${x.client_id}` }, x.assigned_to) : h('span', null, x.assigned_to)),
          h('span', { class: `small ${overdue ? 'warn-text' : 'muted'}` }, [x.due_date ? `${overdue ? 'Overdue, was due' : 'Due'} ${day(x.due_date)}` : 'No due date', `assigned ${ago(x.created_at).toLowerCase()}`, x.note].filter(Boolean).join(' · ')),
          x.not_finished.length && x.total > 1 ? h('details', null, h('summary', { class: 'small muted', style: 'cursor:pointer;min-height:28px' }, `${x.not_finished.length} not finished`),
            h('p', { class: 'small' }, x.not_finished.map((c, i) => [i ? ', ' : '', h('a', { href: `#/clients/${c.id}` }, c.name)]))) : null),
        h('div', { class: 'stack-tight edu-bar' }, h('span', { class: 'small muted' }, x.total ? `${x.finished} of ${x.total} finished` : 'No one with the app yet'), bar(x.total ? Math.round((x.finished / x.total) * 100) : 0, `${x.title}: ${x.finished} of ${x.total} finished`)),
        manage ? h('div', { class: 'edu-acts' }, btn('Remove', (e) => { if (confirm(`Remove this assignment? Lessons already finished stay finished.`)) busy(e.currentTarget, async () => { await del(`/v1/lesson-assignments/${x.id}`); toast('Assignment removed.'); deps.render(); }); }, 'ghost')) : null);
    }) : h('p', { class: 'muted' }, 'Nothing assigned yet.'));
  const total = edu.lessons.length + edu.courses.reduce((t, c) => t + c.lessons.length, 0);
  fill(main, deps.header('Education', `${plural(total, 'lesson')} for athletes and parents: sleep, fueling, recovery, mindset. ${manage ? 'Assign reading and see who has finished.' : 'View only.'}`,
    manage ? btn('New lesson', () => lessonDialog(null, edu.courses)) : null),
  assignmentsPanel, h('div', { class: 'grid grid-2', style: 'align-items:start' }, coursesPanel, libraryPanel));
}
