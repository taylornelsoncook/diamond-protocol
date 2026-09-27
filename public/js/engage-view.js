// Accountability, Performance and Education tabs, shared by the athlete app (/app) and the parent portal.
// One object from GET engage ({ athlete, accountability, performance, education }) drives all three tabs;
// actions post back through the same api (athlete app: /app/api/…, parent: /portal/api/athletes/:id/…).
import { h, fill, toast, busy, btn, ago, videoEmbed } from './ui.js';
import { sparkline, fmtResult } from './charts.js';

export const ENGAGE_TABS = [['accountability', 'Accountability'], ['performance', 'Performance'], ['education', 'Education']];

// Tab bar icons, drawn like the parent portal's (1.6px stroke, 24px box).
const PATHS = {
  workout: ['M3 10v4', 'M6 7v10', 'M18 7v10', 'M21 10v4', 'M6 12h12'],
  overview: ['M3 11l9-7 9 7', 'M5 10v10h14V10'],
  accountability: ['M4 5h16v15H4z', 'M4 9h16', 'M8 3v4', 'M16 3v4', 'M8.5 14.5l2.5 2.5 4.5-4.5'],
  performance: ['M4 19l5-6 4 3 7-9', 'M15 7h5v5'],
  education: ['M12 6C9.5 4.3 6.5 3.8 3.5 4.3v14c3-.5 6 0 8.5 1.7 2.5-1.7 5.5-2.2 8.5-1.7v-14c-3-.5-6 0-8.5 1.7z', 'M12 6v14']
};
export function tabIcon(name) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] ?? []) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
// Which tabs need a dot: unread coach messages, or assigned reading not done yet.
export function engageDots(d) {
  return { accountability: (d?.accountability?.unread ?? d?.unread ?? 0) > 0, education: d?.education ? d.education.assigned.some((x) => !x.done) : (d?.open_assignments ?? 0) > 0 };
}

const SCALES = [
  { key: 'hydration', label: 'Hydration', q: 'Water yesterday', words: ['Very little', 'Not much', 'Some', 'Plenty', 'Lots'] },
  { key: 'soreness', label: 'Soreness', q: 'Right now', words: ['None', 'A little', 'Some', 'Sore', 'Very sore'] },
  { key: 'energy', label: 'Energy', q: 'Right now', words: ['Drained', 'Low', 'OK', 'Good', 'Full'] },
  { key: 'mood', label: 'Mood', q: 'Today', words: ['Rough', 'Low', 'OK', 'Good', 'Great'] }
];
// Calm, plain advice for anything that needs a look.
function advice(c, parent) {
  const out = [];
  if (c.sleep_hours != null && c.sleep_hours < 6) out.push('Short on sleep. Tell your coach if it keeps happening.');
  if (c.soreness != null && c.soreness >= 4) out.push('Quite sore. Go easy today and tell your coach before training. Sharp or joint pain means stop.');
  if (c.energy != null && c.energy <= 2) out.push('Low energy. Eat, drink and rest. Tell your coach if it lasts.');
  if (c.mood != null && c.mood <= 2) out.push(parent ? 'Rough day. A good moment to check in with them.' : 'Rough day. Talk to someone you trust, like a parent or your coach.');
  if (c.hydration != null && c.hydration <= 2) out.push('Low on water. Drink a full bottle before training.');
  return out;
}
const day = (d, opts = {}) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...opts });
const sleepText = (x) => (x == null ? '—' : `${x} h`);
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const bar = (pct, label) => h('div', { class: 'eg-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': label }, h('span', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));
const paragraphs = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => h('p', null, p));
const section = (title, sub, ...kids) => h('section', { class: 'dp-panel' }, h('div', { class: 'stack-tight' }, h('h2', { class: 'dp-panel-title' }, title), sub ? h('p', { class: 'dp-panel-sub' }, sub) : null), ...kids);
const check = () => h('span', { class: 'eg-tick', 'aria-hidden': 'true' }, '✓');

// createEngage({ api, audience }) where api = { get(path), post(path, body) } relative to the athlete's base.
export function createEngage({ api, audience = 'athlete', onData = () => {} }) {
  const parent = audience === 'parent';
  let data = null, el = null, tab = 'accountability';
  let reader = null, editing = false, draft = null, readPosted = false;
  const fresh = new Set(), openCourses = new Set();
  const name = () => data?.athlete?.first_name ?? 'your athlete';

  async function load() { data = await api.get('engage'); readPosted = false; onData(data); return data; }
  const rerender = () => { if (el?.isConnected) render(el, tab); };
  function render(target, which = tab) {
    el = target;
    if (which !== tab) { reader = null; editing = false; draft = null; }
    tab = which;
    if (!data) return fill(el, h('p', { class: 'muted' }, 'Loading…'));
    if (reader) return renderReader();
    ({ accountability: renderAccountability, performance: renderPerformance, education: renderEducation })[tab]();
  }

  // ======== Accountability ========
  function streaks(a) {
    const s = a.streaks;
    return h('div', { class: 'eg-streaks', role: 'group', 'aria-label': 'Streaks' },
      h('div', { class: 'eg-streak' }, h('b', { class: s.active_weeks ? 'good-text' : '' }, s.active_weeks), h('span', { class: 'strong' }, `${s.active_weeks === 1 ? 'Active week' : 'Active weeks'} in a row`), h('span', { class: 'small muted' }, '2 or more training days a week')),
      h('div', { class: 'eg-streak' }, h('b', { class: s.checkin_days ? 'good-text' : '' }, s.checkin_days), h('span', { class: 'strong' }, `${s.checkin_days === 1 ? 'Check-in day' : 'Check-in days'} in a row`), h('span', { class: 'small muted' }, a.checkin_today ? 'Checked in today' : 'Check in today to keep it going')));
  }
  function checkinSummary(c) {
    const tips = advice(c, parent);
    return section('Today\'s check-in', `Saved${parent ? ` for ${name()}` : ''}. Your coach can see it.`,
      h('dl', { class: 'eg-ci-sum' },
        h('div', null, h('dt', null, 'Sleep'), h('dd', null, sleepText(c.sleep_hours))),
        SCALES.map((s) => h('div', null, h('dt', null, s.label), h('dd', null, c[s.key] != null ? [String(c[s.key]), ' ', h('span', { class: 'small muted' }, s.words[c[s.key] - 1])] : '—')))),
      c.note ? h('p', { class: 'eg-note' }, c.note) : null,
      tips.length ? h('div', { class: 'eg-flags', role: 'note' }, tips.map((t) => h('p', null, t))) : null,
      h('div', null, btn('Edit check-in', () => { editing = true; draft = null; rerender(); el.querySelector('#eg-sleep')?.focus(); }, 'secondary')));
  }
  function checkinForm(a) {
    draft ??= { ...(a.checkin_today ?? {}) };
    const sleep = h('input', { class: 'dp-input', id: 'eg-sleep', type: 'number', inputmode: 'decimal', min: '0', max: '16', step: '0.5', placeholder: '8', value: draft.sleep_hours ?? '', onInput: (e) => { draft.sleep_hours = e.target.value === '' ? null : Number(e.target.value); } });
    const step = (d, label) => h('button', { type: 'button', class: 'dp-btn dp-btn--secondary eg-step', 'aria-label': label, onClick: () => {
      const cur = sleep.value === '' ? (d > 0 ? 7.5 : 8.5) : Number(sleep.value);
      sleep.value = Math.max(0, Math.min(16, Math.round((cur + d) * 2) / 2)); draft.sleep_hours = Number(sleep.value);
    } }, d > 0 ? '+' : '−');
    const note = h('textarea', { class: 'dp-input', id: 'eg-note', rows: '2', maxlength: '500', placeholder: parent ? 'Anything the coach should know?' : 'Anything your coach should know?', onInput: (e) => { draft.note = e.target.value; } });
    note.value = draft.note ?? '';
    const err = h('div', { class: 'dp-error', role: 'alert' });
    const scale = (s) => {
      const buttons = s.words.map((w, i) => h('button', { type: 'button', class: 'eg-opt', 'aria-pressed': String(draft[s.key] === i + 1), onClick: () => {
        draft[s.key] = draft[s.key] === i + 1 ? null : i + 1;
        buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(draft[s.key] === j + 1)));
      } }, h('b', null, i + 1), h('span', null, w)));
      return h('div', { class: 'dp-field', role: 'group', 'aria-labelledby': `eg-l-${s.key}` }, h('span', { class: 'dp-label', id: `eg-l-${s.key}` }, s.label, h('span', { class: 'muted', style: 'font-weight:400' }, ` · ${s.q}`)), h('div', { class: 'eg-scale' }, buttons));
    };
    const save = btn('Save check-in', null, 'primary', { type: 'submit' });
    return h('form', { class: 'dp-panel', id: 'eg-checkin', novalidate: true, onSubmit: (e) => {
      e.preventDefault(); err.textContent = '';
      const body = { sleep_hours: sleep.value === '' ? null : Number(sleep.value), note: note.value };
      for (const s of SCALES) body[s.key] = draft[s.key] ?? null;
      if (body.sleep_hours != null && !(body.sleep_hours >= 0 && body.sleep_hours <= 16)) { err.textContent = 'Enter hours of sleep between 0 and 16.'; sleep.setAttribute('aria-invalid', 'true'); sleep.focus(); return; }
      if (body.sleep_hours == null && SCALES.every((s) => body[s.key] == null)) { err.textContent = 'Fill in at least one answer.'; return; }
      busy(save, async () => {
        try {
          data.accountability.checkin_today = await api.post('daily-check-in', body);
          editing = false; draft = null;
          toast(parent ? `Check-in saved for ${name()}.` : 'Check-in saved. Your coach can see it.');
          await load().catch(() => {});
          rerender();
        } catch (x) { err.textContent = x.message; }
      });
    } },
      h('div', { class: 'stack-tight' }, h('h2', { class: 'dp-panel-title' }, 'Today\'s check-in'), h('p', { class: 'dp-panel-sub' }, parent ? `Filling it in for ${name()}? Ask how they feel and enter the answers.` : 'Takes 20 seconds. Answer what you can.')),
      h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: 'eg-sleep' }, 'Hours of sleep last night'), h('div', { class: 'eg-stepper' }, step(-0.5, 'Half an hour less'), sleep, step(0.5, 'Half an hour more'))),
      SCALES.map(scale),
      h('div', { class: 'dp-field' }, h('label', { class: 'dp-label', for: 'eg-note' }, 'Note for the coach ', h('span', { class: 'muted', style: 'font-weight:400' }, '(optional)')), note),
      err,
      h('div', { class: 'row wrap' }, save, a.checkin_today ? btn('Cancel', () => { editing = false; draft = null; rerender(); }, 'ghost') : null));
  }
  function goals(a) {
    const list = a.goals;
    return section('This week\'s goals', `Monday to Sunday.${list.length ? ` ${list.filter((g) => g.done).length} of ${list.length} met.` : ''}`,
      list.length ? h('div', { class: 'eg-list' }, list.map((g) => {
        const pct = Math.round(Math.min(1, g.progress / g.target) * 100);
        const toggle = g.kind === 'custom' ? h('button', { type: 'button', class: 'dp-toggle', 'aria-pressed': String(!!g.checked_today), onClick: (e) => busy(e.currentTarget, async () => {
          const r = await api.post(`goals/${g.id}/check`, { done: !g.checked_today });
          Object.assign(g, r); rerender();
          el.querySelector(`[data-goal="${g.id}"]`)?.focus();
          if (r.checked_today && r.done) toast(`${r.title}: met for this week.`);
        }), 'data-goal': g.id }, g.checked_today ? '✓ Done today' : 'Done today') : null;
        return h('div', { class: 'eg-item' },
          h('div', { class: 'row' }, h('span', { class: 'strong grow' }, g.title), h('span', { class: g.done ? 'good-text strong' : 'muted' }, `${g.done ? '✓ ' : ''}${g.progress} of ${g.target}`)),
          bar(pct, `${g.title}: ${g.progress} of ${g.target}`),
          h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, `${g.team ? 'Team goal. ' : ''}${g.kind === 'custom' ? 'Tick it off each day you do it.' : `Counts itself from ${g.kind === 'checkins' ? 'daily check-ins' : g.kind === 'sessions' ? 'sessions attended' : 'finished workouts'}.`}`), toggle));
      })) : h('p', { class: 'muted' }, 'No goals this week. Your coach can add some.'));
  }
  // Messages both ways: the coach's notes, and replies from the athlete or a parent (only the coaches see those).
  function messages(a) {
    const box = h('textarea', { class: 'dp-input', rows: '3', maxlength: '2000', placeholder: parent ? `Write to ${name()}'s coach` : 'Write to your coach', 'aria-label': 'Message to the coach' });
    const err = h('div', { class: 'dp-error', role: 'alert' });
    const send = h('button', { type: 'submit', class: 'dp-btn dp-btn--secondary' }, 'Send');
    const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(send, async () => {
      try { await api.post('messages', { body: box.value }); box.value = ''; toast('Sent. Your coach gets an email.'); await load(); rerender(); } catch (x) { err.textContent = x.message; }
    }); } }, box, err, h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, 'Only the coaches see this.'), send));
    const who = (m) => (m.from === 'coach' ? m.coach || 'Your coach' : m.from === 'athlete' && !parent ? 'You' : m.author ?? 'You');
    return section('Messages with your coach', null, a.messages.length ? h('div', { class: 'eg-list' }, a.messages.map((m) => {
      const isNew = m.from === 'coach' && (fresh.has(m.id) || !m.read);
      return h('article', { class: `eg-msg${isNew ? ' eg-msg--new' : ''}${m.from !== 'coach' ? ' eg-msg--mine' : ''}` },
        h('div', { class: 'row' }, h('span', { class: 'strong grow' }, who(m), m.team ? h('span', { class: 'muted', style: 'font-weight:400' }, ' · to the team') : null),
          isNew ? h('span', { class: 'dp-badge dp-badge--good' }, 'New') : null, m.from !== 'coach' && m.seen_by_coach ? h('span', { class: 'small muted' }, 'Seen') : null, h('span', { class: 'small muted' }, ago(m.created_at))),
        h('p', { class: 'eg-note' }, m.body));
    })) : h('p', { class: 'muted' }, 'No messages yet.'), form);
  }
  function calendar(a) {
    const pad = (new Date(`${a.calendar[0].date}T12:00:00Z`).getUTCDay() + 6) % 7;
    const cell = (d) => {
      const what = [d.trained ? 'trained' : null, d.checked_in ? 'checked in' : null].filter(Boolean).join(', ') || 'no activity';
      return h('div', { class: `eg-day${d.trained ? ' eg-day--trained' : ''}${d.date === a.today ? ' eg-day--today' : ''}`, role: 'listitem', 'aria-label': `${day(d.date, { weekday: 'long' })}${d.date === a.today ? ' (today)' : ''}: ${what}` },
        h('span', { class: 'eg-day-n', 'aria-hidden': 'true' }, Number(d.date.slice(8))), d.checked_in ? h('span', { class: 'eg-dot', 'aria-hidden': 'true' }) : null);
    };
    return section('Last 4 weeks', `${day(a.calendar[0].date)} to today`,
      h('div', { class: 'eg-cal eg-cal-head', 'aria-hidden': 'true' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => h('span', null, x))),
      h('div', { class: 'eg-cal', role: 'list', 'aria-label': 'Training and check-ins, last 28 days' }, Array.from({ length: pad }, () => h('div', { class: 'eg-day eg-day--empty', 'aria-hidden': 'true' })), a.calendar.map(cell)),
      h('div', { class: 'eg-legend small muted' }, h('span', null, h('span', { class: 'eg-key eg-day--trained' }), 'Trained'), h('span', null, h('span', { class: 'eg-key' }, h('span', { class: 'eg-dot' })), 'Checked in')));
  }
  function countsTable(a) {
    const month = new Date(`${a.today}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
    return section('Counts', null, h('table', { class: 'table eg-counts' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Activity')), h('th', { scope: 'col' }, 'This week'), h('th', { scope: 'col' }, month))),
      h('tbody', null, [['Workouts', 'workouts'], ['Sessions', 'sessions'], ['Check-ins', 'checkins']].map(([l, k]) => h('tr', null, h('th', { scope: 'row' }, l), h('td', null, a.this_week[k]), h('td', null, a.this_month[k]))))));
  }
  function renderAccountability() {
    const a = data.accountability;
    fill(el, streaks(a), !a.checkin_today || editing ? checkinForm(a) : checkinSummary(a.checkin_today), goals(a), messages(a), calendar(a), countsTable(a));
    // Opening the tab marks messages read; they keep their "New" label until the next visit.
    if (!readPosted && a.unread) {
      readPosted = true;
      a.messages.filter((m) => !m.read).forEach((m) => fresh.add(m.id));
      api.post('messages/read', {}).then(() => { a.messages.forEach((m) => { m.read = true; }); a.unread = 0; onData(data); }).catch(() => { readPosted = false; });
    }
  }

  // ======== Performance ========
  function rankText(r, unit) {
    if (r.rank === 1) return `Best result in ${r.group}`;
    if (r.percentile >= 25) return `${unit === 's' ? 'Faster than' : 'Ahead of'} ${r.percentile}% of ${r.group}`;
    return `${ordinal(r.rank)} of ${r.of} in ${r.group}`;
  }
  function renderPerformance() {
    const p = data.performance;
    const tests = p.tests;
    const ranks = p.rankings?.length ? p.rankings : null;
    fill(el,
      tests.length ? h('div', { class: 'eg-summary' },
        h('div', null, h('b', null, tests.length), h('span', null, tests.length === 1 ? 'test' : 'tests')),
        h('div', null, h('b', { class: p.prs.length ? 'good-text' : '' }, p.prs.length), h('span', null, `new ${p.prs.length === 1 ? 'PR' : 'PRs'}`)),
        h('div', null, h('b', { class: 'eg-word' }, p.last_tested ? day(p.last_tested) : '—'), h('span', null, 'last tested'))) : null,
      p.skill_badges?.length ? section('Skill badges', `Earned from ${parent ? `${name()}'s` : 'your'} coaches.`, h('div', { class: 'eg-badges' }, p.skill_badges.map((b) => h('div', { class: 'eg-badge' },
        h('span', { class: 'eg-badge-icon', 'aria-hidden': 'true' }, '◆'),
        h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, b.name), b.description ? h('span', { class: 'small' }, b.description) : null,
          h('span', { class: 'small muted' }, `${[b.category, day(b.awarded_at.slice(0, 10))].filter(Boolean).join(' · ')}${b.note ? ` · "${b.note}"` : ''}`)))))) : null,
      p.targets.length ? section('Targets', 'Set by your coach. Best result so far, then the target.', h('div', { class: 'eg-list' }, p.targets.map((t) => h('div', { class: 'eg-item' },
        h('div', { class: 'row' }, h('span', { class: 'strong grow' }, t.test_name), t.reached ? h('span', { class: 'dp-badge dp-badge--good' }, '✓ Reached') : h('span', { class: 'muted' }, `${t.pct}%`)),
        h('div', { class: 'eg-tg' }, h('span', null, t.best_text ?? 'Not tested yet'), h('span', { class: 'muted', 'aria-label': 'target' }, '→'), h('span', { class: 'strong' }, t.target_text),
          t.due_date && !t.reached ? h('span', { class: 'small muted' }, `by ${day(t.due_date)}`) : null),
        bar(t.pct, `${t.test_name}: ${t.pct}% of the way to the target`))))) : null,
      ranks ? section(`How ${parent ? name() : 'you'} compare${parent ? 's' : ''}`, 'Best results only. No names are shown to anyone.', h('div', { class: 'eg-list' }, ranks.map((r) => h('div', { class: 'eg-item' },
        h('div', { class: 'row' }, h('span', { class: 'strong grow' }, r.test_name.replace(/\s*\(.*\)$/, '')), h('span', { class: 'muted' }, `Best ${r.best_text}`)),
        h('ul', { class: 'eg-ranks' }, r.ranks.map((x) => h('li', null, rankText(x, r.unit)))))))) : null,
      p.prs.length ? section('New PRs', p.last_tested ? `From ${day(p.last_tested)}` : null, h('div', { class: 'eg-prs' }, p.prs.map((x) => h('div', { class: 'eg-pr' }, h('b', null, x.text), h('span', null, x.test_name.replace(/\s*\(.*\)$/, '')))))) : null,
      tests.length ? section('Every test', 'Best result and change since the first test.', h('div', { class: 'eg-list' }, tests.map((t) => h('div', { class: 'eg-trow' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, t.test_name.replace(/\s*\(.*\)$/, '')),
          h('span', { class: 'small muted' }, t.tests_count > 1 ? `${fmtResult(t.first.value, t.unit, t.decimals)} → ${fmtResult(t.latest.value, t.unit, t.decimals)}` : `Tested once, ${day(t.first.date)}`)),
        h('span', { style: 'color:var(--green-bright)' }, sparkline(t.history, { better: t.better, width: 72, height: 28, label: `${t.test_name} trend` })),
        h('div', { class: 'eg-best' }, h('span', { class: 'strong' }, fmtResult(t.best, t.unit, t.decimals)),
          t.tests_count > 1 ? h('span', { class: `small ${t.improved ? 'good-text' : 'muted'}` }, fmtResult(t.change, t.unit, t.decimals, { delta: true })) : null)))))
        : h('div', { class: 'empty' }, `No test results yet. After ${parent ? `${name()}'s` : 'your'} next testing day, results show up here.`),
      parent && tests.length ? h('a', { class: 'dp-btn dp-btn--secondary', href: `/report.html?athlete=${data.athlete.id}` }, 'Printable report') : null);
  }

  // ======== Education ========
  function lessonRow(l) {
    return h('button', { type: 'button', class: 'eg-lesson', 'data-lesson': l.id, onClick: () => openLesson(l.id) },
      h('span', { class: `eg-lesson-i${l.done ? ' eg-lesson-i--done' : ''}`, 'aria-hidden': 'true' }, l.done ? '✓' : l.has_video ? '▶' : '›'),
      h('span', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, l.title),
        h('span', { class: 'small muted' }, [l.minutes ? `${l.minutes} min` : null, l.has_video ? 'Video' : null, l.done ? 'Done' : null].filter(Boolean).join(' · ') || 'Lesson'),
        l.summary ? h('span', { class: 'small muted' }, l.summary) : null));
  }
  function renderEducation() {
    const e = data.education;
    const courseById = (id) => e.courses.find((c) => c.id === id);
    for (const x of e.assigned) if (x.type === 'course' && !x.done && !openCourses.has(`seen:${x.course_id}`)) { openCourses.add(x.course_id); openCourses.add(`seen:${x.course_id}`); }
    const openAssigned = (x) => {
      if (x.type === 'lesson') return openLesson(x.lesson_id);
      const c = courseById(x.course_id), next = c?.lessons.find((l) => !l.done) ?? c?.lessons[0];
      if (next) openLesson(next.id);
    };
    fill(el,
      e.assigned.length ? section('Assigned', `From your coach. ${e.assigned.filter((x) => x.done).length} of ${e.assigned.length} done.`, h('div', { class: 'eg-list' }, e.assigned.map((x) => {
        const c = x.type === 'course' ? courseById(x.course_id) : null;
        return h('div', { class: `eg-item${x.overdue ? ' eg-item--overdue' : ''}` },
          h('div', { class: 'row' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.title),
            h('span', { class: `small ${x.overdue ? 'warn-text' : 'muted'}` }, [x.type === 'course' ? `Course · ${x.progress} lessons` : 'Lesson', x.team ? 'Team' : null, x.due_date ? (x.overdue ? `Overdue, was due ${day(x.due_date)}` : `Due ${day(x.due_date, { weekday: 'short' })}`) : null].filter(Boolean).join(' · '))),
            x.done ? h('span', { class: 'dp-badge dp-badge--good' }, '✓ Done') : null),
          x.note ? h('p', { class: 'small muted' }, x.note) : null,
          c ? bar(c.total ? Math.round((c.done / c.total) * 100) : 0, `${x.title}: ${x.progress} lessons done`) : null,
          x.done ? null : h('div', null, btn(x.type === 'course' ? (c?.done ? 'Continue' : 'Start') : 'Read', () => openAssigned(x), x.overdue ? 'primary' : 'outline')));
      }))) : null,
      e.courses.length ? h('div', { class: 'stack' }, h('h2', { class: 'eg-h2' }, 'Courses'), e.courses.map((c) => {
        const open = openCourses.has(c.id);
        const body = h('div', { id: `eg-c-${c.id}`, hidden: !open }, c.description ? h('p', { class: 'small muted', style: 'margin-bottom:8px' }, c.description) : null, h('div', { class: 'eg-list' }, c.lessons.map(lessonRow)));
        return h('div', { class: 'dp-panel eg-course' },
          h('button', { type: 'button', class: 'eg-course-h', 'aria-expanded': String(open), 'aria-controls': `eg-c-${c.id}`, onClick: (ev) => {
            const now = !openCourses.has(c.id); now ? openCourses.add(c.id) : openCourses.delete(c.id);
            ev.currentTarget.setAttribute('aria-expanded', String(now)); body.hidden = !now;
          } }, h('span', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, c.title), h('span', { class: 'small muted' }, `${c.done} of ${plural(c.total, 'lesson')} done${c.complete ? ' · Complete' : ''}`)), h('span', { class: 'eg-chev', 'aria-hidden': 'true' }, '›')),
          bar(c.total ? Math.round((c.done / c.total) * 100) : 0, `${c.title}: ${c.done} of ${c.total} done`), body);
      })) : null,
      e.lessons.length ? section('Lesson library', null, h('div', { class: 'eg-list' }, e.lessons.map(lessonRow))) : null,
      !e.assigned.length && !e.courses.length && !e.lessons.length ? h('div', { class: 'empty' }, 'No lessons yet. When your coach posts one, it shows up here.') : null);
  }
  async function openLesson(id) {
    try { reader = await api.get(`lessons/${id}`); rerender(); window.scrollTo(0, 0); el.querySelector('#eg-reader-h')?.focus(); }
    catch (x) { toast(x.message, 'warn'); }
  }
  function renderReader() {
    const l = reader;
    const done = btn(l.done ? '✓ Done' : 'Mark as done', (e) => busy(e.currentTarget, async () => {
      reader = await api.post(`lessons/${l.id}/complete`, { done: !l.done });
      if (reader.done) toast(parent ? `Marked done for ${name()}.` : 'Lesson done. Your coach can see it.');
      await load().catch(() => {});
      rerender();
      el.querySelector('[data-done]')?.focus();
    }), l.done ? 'outline' : 'primary', { 'aria-pressed': String(!!l.done), 'data-done': '' });
    fill(el, h('article', { class: 'eg-reader', 'aria-labelledby': 'eg-reader-h' },
      h('div', null, btn('‹ Back to Education', () => { const id = l.id; reader = null; rerender(); el.querySelector(`[data-lesson="${id}"]`)?.focus(); }, 'ghost')),
      l.course ? h('p', { class: 'small muted' }, `${l.course.title}${l.position ? ` · Lesson ${l.position.n} of ${l.position.of}` : ''}`) : null,
      h('h2', { class: 'eg-reader-t', id: 'eg-reader-h', tabindex: '-1' }, l.title),
      l.minutes || l.done ? h('p', { class: 'small muted' }, [l.minutes ? `${l.minutes} min` : null, l.done ? 'Done' : null].filter(Boolean).join(' · ')) : null,
      l.video_url ? videoEmbed(l.video_url, l.title) : null,
      h('div', { class: 'eg-body' }, l.body ? paragraphs(l.body) : l.summary ? h('p', null, l.summary) : h('p', { class: 'muted' }, 'This lesson has no text yet.')),
      h('div', { class: 'row wrap' }, done, l.next ? btn('Next lesson ›', () => openLesson(l.next.id), l.done ? 'primary' : 'secondary') : null),
      l.next ? h('p', { class: 'small muted' }, `Up next: ${l.next.title}`) : l.course ? h('p', { class: 'small muted' }, `That's the last lesson in ${l.course.title}.`) : null));
  }

  return { load, render, rerender, get data() { return data; }, get tab() { return tab; }, closeReader() { reader = null; } };
}
