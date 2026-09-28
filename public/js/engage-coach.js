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
      x.done ? tag('Done', 'good') : x.overdue ? tag('Overdue', 'warn') : x.opened ? tag('Opened') : tag('Not started', 'muted')))) : h('p', { class: 'muted small' }, 'Nothing assigned.'));
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

// ---------- Education: refresh in place ----------
// The Education screen redraws itself after a change (keeping the scroll position and the tab); anywhere else a change
// re-renders the page as before.
let eduRedraw = null;
const refresh = () => (eduRedraw ? eduRedraw() : deps.render());
// Close the dialog, then open the next thing once the dialog has cleared itself.
function thenOpen(fn) {
  const d = document.getElementById('dialog');
  if (!d.open) return fn();
  d.addEventListener('close', () => setTimeout(fn), { once: true });
  d.close();
}
// Escape runs fn instead of closing the dialog, until the dialog closes.
function onCancel(d, fn) {
  const handler = (e) => { e.preventDefault(); fn(); };
  d.addEventListener('cancel', handler);
  d.addEventListener('close', () => d.removeEventListener('cancel', handler), { once: true });
}
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const STATUS_TEXT = { not_started: 'Not started', opened: 'Opened', started: 'Started', finished: 'Finished' };
// A moment (not a calendar day) shown as this device's local day.
const onDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const personText = (p) => (p.status === 'finished' ? `Finished ${onDay(p.completed_at)}` : p.status === 'started' ? `Started, ${p.done} of ${p.of}` : STATUS_TEXT[p.status]);
const personTone = (p) => ({ finished: 'good', started: 'neutral', opened: 'neutral', not_started: 'muted' }[p.status]);

// ---------- Assign a lesson or course ----------
// preset: { client: {id, name} } or { team: {id, name} } fixes who; { lesson_id } or { course_id } preselects what.
// Without a fixed athlete or team, the coach picks several athletes (by hand, everyone on a team or a program, members
// or team-only athletes) or a whole team (which includes athletes who join later).
export async function assignDialog(preset = {}) {
  const fixed = preset.client || preset.team;
  const [edu, picker] = await Promise.all([get('/v1/education'), fixed ? null : get('/v1/education/athletes')]);
  const courses = edu.courses.filter((c) => c.published && c.audience !== 'parents' && c.lessons.some((l) => l.published));
  const parentCourse = new Set(edu.courses.filter((c) => c.audience === 'parents').map((c) => c.id));
  const lessons = [...edu.lessons, ...edu.courses.flatMap((c) => c.lessons)].filter((l) => l.published && !parentCourse.has(l.course_id));
  if (!lessons.length) return toast('Publish a lesson first.', 'warn');
  const pre = preset.course_id ? `c:${preset.course_id}` : preset.lesson_id ? `l:${preset.lesson_id}` : '';
  const what = h('select', { class: 'select' }, h('option', { value: '' }, 'Choose one'),
    courses.length ? h('optgroup', { label: 'Courses' }, courses.map((c) => h('option', { value: `c:${c.id}`, selected: pre === `c:${c.id}` }, `${c.title} (${plural(c.lessons.filter((l) => l.published).length, 'lesson')})`))) : null,
    h('optgroup', { label: 'Lessons' }, lessons.map((l) => h('option', { value: `l:${l.id}`, selected: pre === `l:${l.id}` }, l.title))));

  // Who: several athletes, or a whole team.
  let mode = 'athletes';
  const chosen = new Set();
  const teamsList = picker?.teams ?? [];
  const modeBtns = [['athletes', 'Athletes'], ['team', 'A whole team']].map(([k, label]) => btn(label, () => { mode = k; drawWho(); }, 'ghost', { 'aria-pressed': 'false', 'data-mode': k }));
  const teamSel = select([['', 'Choose a team'], ...teamsList.map((t) => [t.id, `${t.label} (${plural(t.roster_count, 'athlete')})`])], { 'aria-label': 'Team' });
  const search = input({ type: 'search', placeholder: 'Search by name or Athlete ID', 'aria-label': 'Search athletes', autocomplete: 'off' });
  const show = select([['all', 'Everyone'], ['member', 'Members'], ['team_only', 'Team only']], { value: 'all', 'aria-label': 'Which athletes' });
  const byTeam = select([['', 'Add a team…'], ...teamsList.map((t) => [t.id, t.label])], { 'aria-label': 'Add everyone on a team' });
  const byProgram = select([['', 'Add a program…'], ...(picker?.programs ?? []).map((p) => [p.id, p.name])], { 'aria-label': 'Add everyone following a program' });
  const list = h('div', { class: 'edu-pick', role: 'group', 'aria-label': 'Athletes' });
  const count = h('span', { class: 'small muted grow', 'aria-live': 'polite' });
  const teamNames = new Map(teamsList.map((t) => [t.id, t.label]));
  const shown = () => {
    const q = search.value.trim().toLowerCase();
    return (picker?.athletes ?? []).filter((a) => (show.value === 'all' || (show.value === 'member' ? a.member : !a.member && a.team_ids.length))
      && (!q || a.name.toLowerCase().includes(q) || String(a.athlete_id ?? '').toLowerCase().includes(q)));
  };
  const drawCount = () => { count.textContent = chosen.size ? `${plural(chosen.size, 'athlete')} chosen` : 'Nobody chosen yet'; };
  function drawList() {
    const rows = shown();
    fill(list, rows.length ? rows.slice(0, 300).map((a) => h('label', { class: 'edu-pick-row' },
      h('input', { type: 'checkbox', checked: chosen.has(a.id), onChange: (e) => { e.target.checked ? chosen.add(a.id) : chosen.delete(a.id); drawCount(); } }),
      h('span', { class: 'grow stack-tight' }, h('span', null, a.name), h('span', { class: 'small muted' }, [a.athlete_id, ...a.team_ids.map((id) => teamNames.get(id)).filter(Boolean), a.member ? null : a.team_ids.length ? 'Team only' : null].filter(Boolean).join(' · ') || ' ')))) : h('p', { class: 'small muted' }, 'No athletes match.'));
    drawCount();
  }
  const addWhere = (test, label) => {
    const ids = (picker?.athletes ?? []).filter(test).map((a) => a.id);
    ids.forEach((id) => chosen.add(id));
    drawList();
    toast(ids.length ? `Added ${plural(ids.length, 'athlete')} from ${label}.` : `Nobody from ${label} to add.`, ids.length ? 'good' : 'warn');
  };
  byTeam.addEventListener('change', () => { if (byTeam.value) addWhere((a) => a.team_ids.includes(byTeam.value), teamNames.get(byTeam.value)); byTeam.value = ''; });
  byProgram.addEventListener('change', () => { const p = picker.programs.find((x) => x.id === byProgram.value); if (p) addWhere((a) => a.program_ids.includes(p.id), p.name); byProgram.value = ''; });
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(drawList, 120); });
  show.addEventListener('change', drawList);
  const athletesBox = h('div', { class: 'stack' },
    h('div', { class: 'form-grid' }, field('Add everyone on', byTeam), field('Or following', byProgram)),
    h('div', { class: 'form-grid' }, field('Search', search), field('Show', show)),
    list,
    h('div', { class: 'row wrap' }, count,
      btn('Choose all shown', () => { shown().forEach((a) => chosen.add(a.id)); drawList(); }, 'ghost'),
      btn('Clear', () => { chosen.clear(); drawList(); }, 'ghost')));
  const teamBox = field('Team', teamSel, 'Everyone on the roster gets it, including athletes added later.');
  function drawWho() {
    modeBtns.forEach((b) => { const on = b.dataset.mode === mode; b.setAttribute('aria-pressed', String(on)); b.className = `dp-btn dp-btn--${on ? 'secondary' : 'ghost'}`; });
    athletesBox.hidden = mode !== 'athletes'; teamBox.hidden = mode !== 'team';
  }

  // When: quick due dates or a date.
  const today = edu.today;
  const due = input({ type: 'date', min: today, max: addDays(today, 366) });
  const quick = h('div', { class: 'row wrap', style: 'gap:6px' }, [['In 3 days', 3], ['In a week', 7], ['In 2 weeks', 14], ['No due date', null]].map(([label, n]) =>
    btn(label, () => { due.value = n == null ? '' : addDays(today, n); }, 'ghost', { style: 'min-height:44px' })));
  const note = textarea('', { rows: '2', maxlength: '500', placeholder: 'Why it matters, or where to start', style: 'min-height:64px' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const d = openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try {
      if (!what.value) throw new Error('Choose a lesson or a course.');
      const [k, itemId] = [what.value.slice(0, 1), what.value.slice(2)];
      const body = { [k === 'c' ? 'course_id' : 'lesson_id']: itemId, due_date: due.value || null, note: note.value.trim() || null };
      if (preset.client) body.client_id = preset.client.id;
      else if (preset.team) body.contract_id = preset.team.id;
      else if (mode === 'team') { if (!teamSel.value) throw new Error('Choose a team.'); body.contract_id = teamSel.value; }
      else { if (!chosen.size) throw new Error('Choose at least one athlete.'); body.client_ids = [...chosen]; }
      const r = await post('/v1/lesson-assignments', body);
      d.close();
      if (r.assigned) {
        const skipped = r.skipped.length ? ` Skipped ${r.skipped.map((s) => s.name).join(', ')}: ${r.skipped.length === 1 ? r.skipped[0].reason : 'they already have it'}.` : '';
        toast(`Assigned "${r.title}" to ${plural(r.assigned.length, 'athlete')}. They and their parents are emailed.${skipped}`, r.skipped.length ? 'warn' : 'good');
      } else toast(`Assigned "${r.title}"${r.recipients > 1 ? ` to ${plural(r.recipients, 'athlete')}` : ''}. They and their parents are emailed.`);
      refresh();
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel)' }, 'Assign lesson'),
    field('Lesson or course', what),
    fixed ? h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'For'), h('div', null, fixed.name, preset.team ? h('span', { class: 'small muted' }, ' (everyone on the roster, including athletes added later)') : null))
      : [h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'For'), h('div', { class: 'row wrap', style: 'gap:6px', role: 'group', 'aria-label': 'Who it\'s for' }, modeBtns)), athletesBox, teamBox],
    h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: due.id || (due.id = 'asg-due') }, 'Due date (optional)'), quick, due),
    field('Note (optional)', note, 'The athlete and their parents are emailed a link.'),
    err, h('div', { class: 'row' }, btn('Assign', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  if (!fixed) { drawWho(); drawList(); }
}
// Change an assignment's due date or note. Nobody is emailed.
function changeAssignmentDialog(x, today) {
  const due = input({ type: 'date', value: x.due_date ?? '', min: x.due_date && x.due_date < today ? x.due_date : today, max: addDays(today, 366) });
  const note = textarea(x.note ?? '', { rows: '2', maxlength: '500', style: 'min-height:64px' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const d = openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try { await patch(`/v1/lesson-assignments/${x.id}`, { due_date: due.value || null, note: note.value.trim() || null }); d.close(); toast('Assignment changed. Nobody was emailed.'); refresh(); }
    catch (y) { err.textContent = y.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel)' }, 'Change assignment'),
    h('p', { class: 'small muted', style: 'margin:0' }, `${x.title} for ${x.assigned_to}`),
    field('Due date', due, 'Leave empty for no due date.'), field('Note', note),
    err, h('div', { class: 'row' }, btn('Save', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  due.focus();
}
const remindToast = (r) => {
  const sent = r.reminded.length ? `Reminded ${plural(r.reminded.length, 'athlete')} and their parents.` : 'Nobody was reminded.';
  const why = r.skipped.length ? ` Skipped ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}.` : '';
  toast(`${sent}${why}`, r.reminded.length && !r.skipped.length ? 'good' : 'warn');
};

// ---------- Lesson and course editors ----------
// The editor asks before throwing away typed text (Escape or Cancel); a click outside it does nothing.
async function lessonDialog(lesson, courses, preset = {}) {
  const l = lesson ? await get(`/v1/lessons/${lesson.id}`) : { published: true, course_id: preset.course_id ?? null };
  const f = { title: input({ value: l.title ?? '', maxlength: '160' }), summary: input({ value: l.summary ?? '', maxlength: '300' }), body: textarea(l.body ?? '', { style: 'min-height:200px' }),
    video_url: input({ type: 'url', value: l.video_url ?? '', placeholder: 'https://www.youtube.com/watch?v=…' }), minutes: input({ type: 'number', min: '1', max: '240', inputmode: 'numeric', value: l.minutes ?? '' }),
    course_id: select([['', 'Stand-alone lesson'], ...courses.map((c) => [c.id, `${c.title}${c.published ? '' : ' (draft)'}`])], { value: l.course_id ?? '' }), published: h('input', { type: 'checkbox', checked: !!l.published }),
    quiz: textarea(l.quiz_text ?? '', { style: 'min-height:140px;font-family:var(--font-mono);font-size:14px', placeholder: 'What should your knees do when you land?\n- Cave inward\n* Track over your toes\n- Lock straight' }) };
  const snapshot = () => JSON.stringify(Object.values(f).map((x) => (x.type === 'checkbox' ? x.checked : x.value)));
  const start = snapshot();
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const leave = () => { if (snapshot() === start || confirm('Throw away your changes to this lesson?')) d.close(); };
  const d = openDialog(h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try {
      const body = { title: f.title.value, summary: f.summary.value || null, body: f.body.value || null, video_url: f.video_url.value || null, minutes: f.minutes.value ? Number(f.minutes.value) : null, course_id: f.course_id.value || null, published: f.published.checked, quiz_text: f.quiz.value };
      if (lesson) await patch(`/v1/lessons/${lesson.id}`, body); else await post('/v1/lessons', body);
      const course = courses.find((c) => c.id === body.course_id);
      d.close();
      toast(!f.published.checked ? 'Draft saved. Athletes won\'t see it until you publish it.' : course && !course.published ? `Saved. Athletes see it once you publish the course "${course.title}".` : lesson ? 'Lesson saved.' : 'Lesson posted. Athletes can read it now.');
      refresh();
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel)' }, lesson ? 'Edit lesson' : 'New lesson'),
    field('Title', f.title), field('Summary', f.summary, 'One line under the title.'),
    field('Lesson text', f.body, 'Plain text. Leave a blank line between paragraphs.'),
    h('div', { class: 'form-grid' }, field('Video link (optional)', f.video_url, 'YouTube, Vimeo or a direct .mp4 link, starting with https://'), field('Minutes to read or watch', f.minutes)),
    field('Course', f.course_id, 'Moving a lesson into a course puts it last.'),
    field('Quiz (optional)', f.quiz, 'A question on one line, then its choices below, each starting with - and the right one with *. A blank line between questions. Up to 10. Athletes need 80% to finish the lesson.'),
    h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, f.published, h('span', null, 'Published: athletes and parents can see it')),
    err, h('div', { class: 'row' }, btn(lesson ? 'Save lesson' : 'Post lesson', null, 'primary', { type: 'submit' }), btn('Cancel', leave, 'ghost'))));
  onCancel(d, leave);
  f.title.focus();
}
// Owners: price a course and put it in the online store.
async function saleDialog(courseId) {
  const info = (await get('/v1/shop')).courses.find((x) => x.id === courseId);
  const d = openDialog(h('div', { class: 'stack' }, h('h2', { class: 'dp-panel-title' }, `Sell ${info.title} online`),
    saleForm(put, 'course', info, () => { d.close(); refresh(); }), h('div', null, btn('Close', () => d.close(), 'ghost'))));
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
      d.close(); toast(course ? 'Course saved.' : 'Course created. Add lessons to it.'); refresh();
    } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel)' }, course ? 'Edit course' : 'New course'),
    field('Title', title), field('Description', desc), field('Who it\'s for', audience), ages,
    h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, pub, h('span', null, 'Published')),
    err, h('div', { class: 'row' }, btn(course ? 'Save course' : 'Create course', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  title.focus();
}
// back: what Close goes back to (the lesson's details), if anything.
async function previewLesson(id, back = null) {
  const l = await get(`/v1/lessons/${id}`);
  const d = openDialog(h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, l.published ? 'What athletes and parents see' : 'Draft: athletes see this once you publish it'), btn(back ? '‹ Back' : 'Close', () => (back ? thenOpen(back) : d.close()), 'ghost')),
    h('h2', { class: 'eg-reader-t' }, l.title), l.summary ? h('p', { class: 'muted' }, l.summary) : null,
    l.video_url ? videoEmbed(l.video_url, l.title) : null,
    h('div', { class: 'eg-body' }, String(l.body ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => h('p', null, p)))));
  if (back) onCancel(d, () => thenOpen(back));
}
// One lesson's details: who finished it and when, who opened it but hasn't finished, where it's assigned, and its actions.
async function lessonDetail(id, courses) {
  const p = await get(`/v1/lessons/${id}/progress`);
  const manage = canManage(), again = () => lessonDetail(id, courses);
  const person = (x, when) => h('li', null, h('a', { href: `#/clients/${x.id}`, onClick: () => document.getElementById('dialog').close() }, x.name), h('span', { class: 'muted' }, ` · ${when}`));
  const forParents = p.course?.audience === 'parents';
  const d = openDialog(h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('h2', { class: 'week-title grow', style: 'color:var(--steel)' }, p.title), btn('Close', () => d.close(), 'ghost')),
    h('p', { class: 'small muted', style: 'margin:0' }, [p.course ? `In ${p.course.title}${p.course.published ? '' : ' (draft course)'}` : 'Stand-alone lesson', p.published ? 'Published' : 'Draft'].join(' · ')),
    forParents ? h('p', { class: 'small muted' }, 'A lesson for parents: they read it in the parent portal.') : [
      h('div', { class: 'dp-label' }, `Finished (${p.finished.length})`),
      p.finished.length ? h('ul', { class: 'small edu-people' }, p.finished.map((x) => person(x, onDay(x.completed_at)))) : h('p', { class: 'small muted' }, 'Nobody yet.'),
      h('div', { class: 'dp-label' }, `Opened, not finished (${p.opened.length})`),
      p.opened.length ? h('ul', { class: 'small edu-people' }, p.opened.map((x) => person(x, `opened ${ago(x.opened_at).toLowerCase()}`))) : h('p', { class: 'small muted' }, 'Nobody.'),
      h('div', { class: 'dp-label' }, 'Assigned to'),
      p.assignments.length ? h('ul', { class: 'small edu-people' }, p.assignments.map((x) => h('li', null, x.assigned_to, h('span', { class: 'muted' }, ` · ${x.type === 'course' ? 'with the course · ' : ''}${x.total ? `${x.finished} of ${x.total} finished` : x.archived ? 'archived' : 'nobody on the roster'}${x.due_date ? ` · due ${day(x.due_date)}` : ''}`))))
        : h('p', { class: 'small muted' }, 'Not assigned.')],
    h('div', { class: 'row wrap', style: 'gap:6px' },
      btn('Preview', () => thenOpen(() => previewLesson(id, again)), 'secondary'),
      manage ? btn('Edit', () => thenOpen(() => lessonDialog({ id }, courses)), 'secondary') : null,
      manage && p.published && !forParents ? btn('Assign', () => thenOpen(() => assignDialog({ lesson_id: id })), 'secondary') : null,
      manage ? btn('Duplicate', (e) => busy(e.currentTarget, async () => { const c = await post(`/v1/lessons/${id}/duplicate`); d.close(); toast(`Copied as a draft: ${c.title}.`); refresh(); }), 'ghost') : null,
      manage ? btn('Delete', (e) => { if (confirm(`Delete "${p.title}"? Completions are removed too.`)) busy(e.currentTarget, async () => { await del(`/v1/lessons/${id}`); d.close(); toast('Lesson deleted.'); refresh(); }); }, 'ghost') : null)));
}

// ---------- Education screen ----------
// Assigned, Library and Recent tabs. The tab, filters and searches stay in the address (#/education?tab=…), and a change
// redraws in place without jumping to the top.
export async function viewEducation(main) {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const ui = { tab: ['assigned', 'library', 'recent'].includes(q.get('tab')) ? q.get('tab') : 'assigned', q: q.get('q') ?? '', f: ['open', 'overdue', 'finished', 'all'].includes(q.get('f')) ? q.get('f') : 'open',
    lq: q.get('lq') ?? '', lf: ['all', 'published', 'drafts'].includes(q.get('lf')) ? q.get('lf') : 'all' };
  const saveUrl = () => {
    const p = new URLSearchParams();
    if (ui.tab !== 'assigned') p.set('tab', ui.tab);
    if (ui.tab === 'assigned') { if (ui.q) p.set('q', ui.q); if (ui.f !== 'open') p.set('f', ui.f); }
    if (ui.tab === 'library') { if (ui.lq) p.set('lq', ui.lq); if (ui.lf !== 'all') p.set('lf', ui.lf); }
    const s = p.toString();
    history.replaceState(null, '', `#/education${s ? `?${s}` : ''}`);
  };
  let edu = await get('/v1/education');
  const manage = canManage();
  const body = h('div', { class: 'stack' });
  const stat = (label, value, tone, sub) => h('div', null, h('b', { class: tone ?? '' }, value), h('span', null, label), sub ? h('span', { class: 'muted' }, sub) : null);
  function draw() {
    const s = edu.stats;
    const tabs = h('div', { class: 'row wrap', role: 'tablist', 'aria-label': 'Education', style: 'gap:8px' },
      [['assigned', `Assigned (${s.open})`], ['library', 'Library'], ['recent', 'Recent']].map(([k, label]) => btn(label, () => { ui.tab = k; saveUrl(); draw(); }, ui.tab === k ? 'secondary' : 'ghost',
        { role: 'tab', 'aria-selected': String(ui.tab === k), style: 'min-height:44px' })));
    fill(main, deps.header('Education', `Lessons and courses for athletes and parents: sleep, fueling, recovery, mindset. ${manage ? 'Assign reading and see who has read it.' : 'View only.'}`,
      manage ? btn('Assign', () => assignDialog({})) : null),
    h('div', { class: 'cl-stats edu-stats' }, stat('Open assignments', s.open), stat('Overdue', s.overdue, s.overdue ? 'warn-text' : ''), stat('Lessons finished, last 7 days', s.finished_7d),
      stat('Published lessons', s.published, '', s.drafts ? `${plural(s.drafts, 'draft')} not published` : null)),
    tabs, body);
    ({ assigned: drawAssigned, library: drawLibrary, recent: drawRecent })[ui.tab]();
  }
  eduRedraw = async () => {
    if (!main.isConnected) { eduRedraw = null; return deps.render(); }
    const y = window.scrollY;
    edu = await get('/v1/education');
    draw();
    window.scrollTo(0, y);
  };

  // ---- Assigned ----
  function drawAssigned() {
    const search = input({ type: 'search', value: ui.q, placeholder: 'Search by athlete, team or lesson', 'aria-label': 'Search assignments', autocomplete: 'off' });
    const counts = { open: edu.stats.open, overdue: edu.stats.overdue, finished: edu.assignments.filter((x) => x.status === 'finished').length, all: edu.assignments.length };
    const filters = h('div', { class: 'row wrap', role: 'group', 'aria-label': 'Show', style: 'gap:6px' });
    const list = h('div');
    const drawFilters = () => fill(filters, [['open', 'Open'], ['overdue', 'Overdue'], ['finished', 'Finished'], ['all', 'All']].map(([k, label]) =>
      btn(`${label} (${counts[k]})`, () => { ui.f = k; saveUrl(); drawFilters(); drawList(); }, ui.f === k ? 'secondary' : 'ghost', { 'aria-pressed': String(ui.f === k), style: 'min-height:44px' })));
    const drawList = () => {
      const needle = ui.q.trim().toLowerCase();
      const rows = edu.assignments.filter((x) => (ui.f === 'all' || (ui.f === 'open' ? x.status === 'open' || x.status === 'overdue' : x.status === ui.f))
        && (!needle || [x.title, x.assigned_to, ...x.people.map((p) => p.name)].some((t) => String(t ?? '').toLowerCase().includes(needle))));
      fill(list, rows.length ? rows.map(assignmentRow) : h('p', { class: 'muted' }, edu.assignments.length ? 'Nothing matches.' : 'Nothing assigned yet.'));
    };
    let t = null;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { ui.q = search.value; saveUrl(); drawList(); }, 150); });
    drawFilters(); drawList();
    fill(body, panel('Assigned', { subtitle: 'Overdue first, then by due date. Open a row to see where each athlete is.',
      action: manage && edu.stats.overdue ? btn('Remind overdue', (e) => { if (confirm('Email everyone who hasn\'t finished an overdue assignment (and their parents)? Anyone reminded in the last 12 hours is skipped.')) busy(e.currentTarget, async () => {
        const r = await post('/v1/lesson-assignments/remind-overdue');
        if (!r.assignments) toast('Nothing to remind about: overdue assignments were all reminded in the last 12 hours.', 'warn'); else remindToast(r);
        refresh();
      }); }, 'secondary') : null },
    h('div', { class: 'stack' }, search, filters), list));
  }
  function assignmentRow(x) {
    const one = !!x.client_id, p = x.people[0];
    const statusLine = [x.due_date ? `${x.status === 'overdue' ? 'Overdue, was due' : 'Due'} ${day(x.due_date)}` : 'No due date',
      `assigned ${ago(x.created_at).toLowerCase()}${x.assigned_by ? ` by ${x.assigned_by}` : ''}`, x.reminded_at ? `reminded ${ago(x.reminded_at).toLowerCase()}` : null].filter(Boolean).join(' · ');
    return h('div', { class: 'edu-row' },
      h('div', { class: 'edu-grow stack-tight' },
        h('span', null, h('span', { class: 'strong' }, x.title), h('span', { class: 'small muted' }, ` · ${x.type} for `),
          one ? h('a', { href: `#/clients/${x.client_id}` }, x.assigned_to) : h('a', { href: `#/teams/${x.contract_id}` }, x.assigned_to)),
        h('span', { class: `small ${x.status === 'overdue' ? 'warn-text' : 'muted'}` }, statusLine),
        x.note ? h('span', { class: 'small muted' }, `"${x.note}"`) : null,
        x.archived ? h('span', { class: 'small muted' }, `${x.assigned_to} is archived.`) : null,
        !one && x.total ? h('details', null, h('summary', { class: 'small muted', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Where each athlete is (${x.total - x.finished} not finished)`),
          h('ul', { class: 'small edu-people' }, x.people.map((q) => h('li', null, h('a', { href: `#/clients/${q.id}` }, q.name), ' ', tag(personText(q), personTone(q)))))) : null),
      h('div', { class: 'stack-tight edu-bar' },
        one ? (p ? tag(personText(p), personTone(p)) : tag('Archived', 'muted'))
          : [h('span', { class: 'small muted' }, x.total ? `${x.finished} of ${x.total} finished${x.opened ? `, ${x.opened} opened` : ''}` : x.team_ended ? 'Contract ended' : 'Nobody on the roster'),
            bar(x.total ? Math.round((x.finished / x.total) * 100) : 0, `${x.title}: ${x.finished} of ${x.total} finished`)]),
      manage ? h('div', { class: 'edu-acts' },
        x.status !== 'finished' && !x.archived && !x.team_ended && x.total ? btn('Remind', (e) => busy(e.currentTarget, async () => { remindToast(await post(`/v1/lesson-assignments/${x.id}/remind`)); refresh(); }), 'ghost') : null,
        btn('Change', () => changeAssignmentDialog(x, edu.today), 'ghost'),
        btn('Remove', (e) => { if (confirm(`Remove "${x.title}" for ${x.assigned_to}? Lessons already finished stay finished.`)) busy(e.currentTarget, async () => { await del(`/v1/lesson-assignments/${x.id}`); toast('Assignment removed.'); refresh(); }); }, 'ghost')) : null);
  }

  // ---- Library ----
  function drawLibrary() {
    const search = input({ type: 'search', value: ui.lq, placeholder: 'Search lessons and courses', 'aria-label': 'Search the library', autocomplete: 'off' });
    const filters = h('div', { class: 'row wrap', role: 'group', 'aria-label': 'Show', style: 'gap:6px' });
    const list = h('div', { class: 'stack' });
    const drawFilters = () => fill(filters, [['all', 'All'], ['published', 'Published'], ['drafts', 'Drafts']].map(([k, label]) =>
      btn(label, () => { ui.lf = k; saveUrl(); drawFilters(); drawList(); }, ui.lf === k ? 'secondary' : 'ghost', { 'aria-pressed': String(ui.lf === k), style: 'min-height:44px' })));
    const drawList = () => {
      const needle = ui.lq.trim().toLowerCase();
      const hit = (t) => !needle || String(t ?? '').toLowerCase().includes(needle);
      const keep = (l, course) => (ui.lf === 'all' || (ui.lf === 'published' ? l.published && (!course || course.published) : !l.published || (course && !course.published)))
        && (hit(l.title) || hit(l.summary) || (course && hit(course.title)));
      const courses = edu.courses.map((c) => ({ c, lessons: c.lessons.filter((l) => keep(l, c)) }))
        .filter(({ c, lessons }) => lessons.length || ((ui.lf === 'all' || (ui.lf === 'drafts') === !c.published) && hit(c.title)));
      const lone = edu.lessons.filter((l) => keep(l, null));
      const starter = !edu.courses.some((c) => c.audience === 'parents') && manage && !needle ? h('div', { class: 'dp-panel stack', style: 'background:transparent' },
        h('span', { class: 'strong' }, 'Courses for parents'), h('p', { class: 'small muted', style: 'margin:0' }, 'Short courses parents read in the parent portal, shown by their athlete\'s age. Start from three drafts (growth spurts, fueling, recruiting basics), then read, edit and publish them.'),
        h('div', null, btn('Add starter drafts', (e) => busy(e.currentTarget, async () => { toast((await post('/v1/courses/starter-parent')).message); refresh(); }), 'secondary'))) : null;
      fill(list,
        panel('Courses', { subtitle: 'Lessons in order. Athletes see the next lesson when they finish one. Parent courses show in the parent portal.', action: manage ? btn('New course', () => courseDialog(null), 'secondary') : null },
          starter,
          courses.length ? courses.map(({ c, lessons }) => courseBlock(c, lessons)) : h('p', { class: 'muted' }, edu.courses.length ? 'No courses match.' : 'No courses yet. A course is a short series of lessons, like "Recovery basics".')),
        panel('Lesson library', { subtitle: 'Stand-alone lessons.', action: manage ? btn('New lesson', () => lessonDialog(null, edu.courses), 'primary') : null },
          lone.length ? h('div', null, lone.map((l, i, arr) => lessonRow(l, i, arr, null))) : h('p', { class: 'muted' }, edu.lessons.length ? 'No lessons match.' : 'No stand-alone lessons yet.')));
    };
    let t = null;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { ui.lq = search.value; saveUrl(); drawList(); }, 150); });
    drawFilters(); drawList();
    fill(body, h('div', { class: 'stack' }, search, filters), list);
  }
  function courseBlock(c, shown) {
    const athletes = c.audience !== 'parents', live = c.lessons.filter((l) => l.published).length;
    return h('div', { class: 'edu-course' },
      h('div', { class: 'row wrap' }, h('div', { class: 'edu-grow stack-tight' }, h('span', { class: 'edu-course-title' }, c.title),
        h('span', { class: 'small muted' }, [c.audience === 'parents' ? `For parents${c.age_min != null || c.age_max != null ? `, ages ${c.age_min ?? 'any'}–${c.age_max ?? 'any'}` : ''} · ${plural(c.parents_reading ?? 0, 'parent')} reading` : null,
          plural(c.lessons.length, 'lesson'), c.certificates ? `${plural(c.certificates, 'certificate')} earned` : null, c.assigned ? `assigned ${c.assigned === 1 ? 'once' : `${c.assigned} times`}` : null,
          c.published ? null : `draft, hidden from ${athletes ? 'athletes' : 'parents'}`, c.for_sale ? 'for sale online' : null, c.description].filter(Boolean).join(' · '))),
        manage ? h('div', { class: 'edu-acts' },
          !c.published ? btn('Publish', (e) => busy(e.currentTarget, async () => { await patch(`/v1/courses/${c.id}`, { published: true }); toast(live ? `${c.title} is published. ${athletes ? 'Athletes' : 'Parents'} can see its published lessons.` : `${c.title} is published. Publish a lesson in it so it shows.`); refresh(); }), 'secondary') : null,
          btn('Add lesson', () => lessonDialog(null, edu.courses, { course_id: c.id }), 'ghost'),
          athletes && c.published && live ? btn('Assign', () => assignDialog({ course_id: c.id }), 'ghost') : null,
          btn('Edit', () => courseDialog(c), 'ghost'),
          deps.role() === 'owner' && athletes ? btn(c.for_sale ? 'For sale' : 'Sell online', (e) => busy(e.currentTarget, () => saleDialog(c.id)), 'ghost') : null,
          btn('Delete', (e) => { if (confirm(`Delete the course "${c.title}"? Its lessons stay in the library.`)) busy(e.currentTarget, async () => { await del(`/v1/courses/${c.id}`); toast('Course deleted. Its lessons are in the library.'); refresh(); }); }, 'ghost')) : null),
      shown.length ? h('div', null, shown.map((l) => lessonRow(l, c.lessons.indexOf(l), c.lessons, c))) : h('p', { class: 'muted small' }, c.lessons.length ? 'No lessons match.' : 'No lessons yet.'));
  }
  function lessonRow(l, i, all, course) {
    const parents = course?.audience === 'parents';
    return h('div', { class: 'edu-row' },
      course ? h('span', { class: 'edu-n' }, i + 1) : null,
      h('div', { class: 'edu-grow stack-tight' },
        h('button', { type: 'button', class: 'edu-link strong', onClick: () => lessonDetail(l.id, edu.courses) }, l.title, l.published ? null : h('span', { class: 'small muted', style: 'font-weight:400' }, ' · draft')),
        h('span', { class: 'small muted' }, [l.minutes ? `${l.minutes} min` : null, l.has_video ? 'Video' : null, l.has_quiz ? 'Quiz' : null,
          parents ? null : `${l.completions} finished`, parents || !l.opened ? null : `${l.opened} opened`, l.assigned ? `assigned ${l.assigned === 1 ? 'once' : `${l.assigned} times`}` : null].filter(Boolean).join(' · '))),
      h('div', { class: 'edu-acts' },
        course && manage ? [btn('↑', (e) => move(e, course, i, -1), 'ghost', { 'aria-label': `Move ${l.title} up`, disabled: i === 0 }), btn('↓', (e) => move(e, course, i, 1), 'ghost', { 'aria-label': `Move ${l.title} down`, disabled: i === all.length - 1 })] : null,
        manage && !l.published ? btn('Publish', (e) => busy(e.currentTarget, async () => {
          await patch(`/v1/lessons/${l.id}`, { published: true });
          toast(course && !course.published ? `Published. Athletes see it once you publish the course "${course.title}".` : parents ? 'Published. Parents can read it now.' : 'Published. Athletes can read it now.'); refresh();
        }), 'secondary') : null,
        manage && l.published && !parents && (!course || course.published) ? btn('Assign', () => assignDialog({ lesson_id: l.id }), 'ghost') : null,
        manage ? btn('Edit', () => lessonDialog(l, edu.courses), 'ghost') : null));
  }
  async function move(e, course, i, dir) {
    const ids = course.lessons.map((l) => l.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    await busy(e.currentTarget, async () => { await put(`/v1/courses/${course.id}/order`, { lesson_ids: ids }); refresh(); });
  }

  // ---- Recent ----
  function drawRecent() {
    fill(body, panel('Recently finished', { subtitle: 'The latest lessons athletes finished, newest first.' },
      edu.recent.length ? edu.recent.map((r) => h('div', { class: 'edu-row' },
        h('div', { class: 'edu-grow stack-tight' }, h('span', null, h('a', { href: `#/clients/${r.client_id}`, class: 'strong' }, r.name), h('span', { class: 'muted' }, ' finished '),
          h('button', { type: 'button', class: 'edu-link', onClick: () => lessonDetail(r.lesson_id, edu.courses) }, r.title)), r.course ? h('span', { class: 'small muted' }, r.course) : null),
        h('span', { class: 'small muted' }, ago(r.completed_at)))) : h('p', { class: 'muted' }, 'Nobody has finished a lesson yet.')));
  }
  draw();
}
