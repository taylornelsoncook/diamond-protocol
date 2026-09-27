// Accountability, Performance and Education tabs, shared by the athlete app (/w/:token) and the parent portal.
// One data object from GET {base}/engage ({ athlete, accountability, performance, education }) drives all three;
// actions post back to the same base (athlete app: /w/<token>, parent: /parent/athletes/<id>).
import { html, raw, mount, api, icon, toast, toastError, fmtDate, relTime, plural } from '/js/ui.js';
import { fmtValue, fmtChange, trendSvg } from '/js/testing-format.js';

export const ENGAGE_TABS = [
  { id: 'accountability', label: 'Accountability', icon: 'accountability' },
  { id: 'performance', label: 'Performance', icon: 'performance' },
  { id: 'education', label: 'Education', icon: 'education' },
];

// Icons for the tab bars (same 1.6px stroke as ui.js icons).
const PATHS = {
  workout: 'M2 8v4M5 6v8M15 6v8M18 8v4M5 10h10',
  accountability: 'M3 4h14v13H3zM3 8h14M7 2v4M13 2v4M7 12l2 2 4-4',
  performance: 'M3 17l5-6 4 3 5-8M13 6h4v4',
  education: 'M10 5C8 3.6 5.5 3.2 3 3.6V16c2.5-.4 5 0 7 1.4 2-1.4 4.5-1.8 7-1.4V3.6C14.5 3.2 12 3.6 10 5zM10 5v12.4',
};
export function tabIcon(name, size = 22) {
  if (!PATHS[name]) return icon(name, size);
  return raw(`<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`);
}

// Which tabs need a dot: unread coach messages, or an assignment not done yet.
export function engageDots(d) {
  return {
    accountability: (d?.accountability?.unread || 0) > 0,
    education: (d?.education?.assigned || []).some((x) => !x.done),
  };
}

// ---- videos: YouTube / Vimeo embeds, or a video file (https only) ----
export function parseVideo(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/); if (m) id = m[1]; }
    return id && /^[\w-]{6,20}$/.test(id) ? { kind: 'youtube', id } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') { const m = u.pathname.match(/(?:^|\/)(\d{5,12})(?:\/|$)/); return m ? { kind: 'vimeo', id: m[1] } : null; }
  if (/\.(mp4|m4v|webm|mov|ogv)$/i.test(u.pathname)) return { kind: 'file', url: s };
  return null;
}
function lessonVideo(url, title) {
  const v = parseVideo(url);
  if (!v) return url && /^https:\/\//i.test(url) ? html`<p class="muted" style="margin:0"><a href="${url}" target="_blank" rel="noopener">Watch the video</a></p>` : '';
  const t = `Video: ${title}`;
  if (v.kind === 'youtube') return html`<div class="eg-video"><iframe src="https://www.youtube-nocookie.com/embed/${v.id}?rel=0&playsinline=1&modestbranding=1" title="${t}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
  if (v.kind === 'vimeo') return html`<div class="eg-video"><iframe src="https://player.vimeo.com/video/${v.id}?dnt=1&playsinline=1" title="${t}" allow="fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;
  if (!/^https:/i.test(v.url)) return '';
  return html`<div class="eg-video"><video src="${v.url}" controls playsinline preload="metadata" aria-label="${t}"></video></div>`;
}
// Plain text with blank-line paragraphs; escaped by html``.
const paragraphs = (text) => String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => html`<p>${p}</p>`);

// ---- check-in scales ----
const SCALES = [
  { key: 'hydration', label: 'Hydration', q: 'Water yesterday', words: ['Very little', 'Not much', 'Some', 'Plenty', 'Lots'] },
  { key: 'soreness', label: 'Soreness', q: 'Right now', words: ['None', 'A little', 'Some', 'Sore', 'Very sore'] },
  { key: 'energy', label: 'Energy', q: 'Right now', words: ['Drained', 'Low', 'OK', 'Good', 'Full'] },
  { key: 'mood', label: 'Mood', q: 'Today', words: ['Rough', 'Low', 'OK', 'Good', 'Great'] },
];
// Plain advice for anything that needs attention. Computed from the answers so the wording stays calm.
function advice(c) {
  if (!c) return [];
  const out = [];
  if (c.sleep_hours != null && c.sleep_hours < 6) out.push('Short on sleep: tell your coach if it keeps happening.');
  if (c.soreness != null && c.soreness >= 4) out.push('Quite sore: go easy today and tell your coach before training. Sharp or joint pain means stop.');
  if (c.energy != null && c.energy <= 2) out.push('Low energy: eat, drink and rest. Tell your coach if it lasts.');
  if (c.mood != null && c.mood <= 2) out.push('Rough day: talk to someone you trust, like a parent or your coach.');
  if (c.hydration != null && c.hydration <= 2) out.push('Low on water: drink a full bottle before training.');
  return out.length ? out : (c.flags || []);
}
const sleepText = (h) => (h == null ? '—' : `${Number(h) % 1 ? Number(h).toFixed(1) : Number(h)} h`);

// ---- small bits ----
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
function rankText(r, unit) {
  if (r.rank === 1) return html`Best result in ${r.group}`;
  if (r.percentile >= 25) return html`${unit === 's' ? 'Faster than' : 'Ahead of'} ${r.percentile}% of ${r.group}`;
  return html`${ordinal(r.rank)} of ${r.of} in ${r.group}`;
}
const bar = (pct, label) => html`<div class="bar eg-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${label}"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`;
const dot = (label) => html`<span class="eg-dot" aria-hidden="true"></span><span class="sr-only">${label}</span>`;
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dayIdx = (d) => (new Date(d + 'T12:00:00').getDay() + 6) % 7;
// YYYY-MM-DD plus n days (dates only, no time zone drift).
const addDay = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const MSG_SHOWN = 5; // messages shown before "Show older"
const SEARCH_AT = 6; // lessons before the Education tab offers search

// ---- the view ----
// createEngage({ base, audience: 'athlete' | 'parent', name, onData })
export function createEngage({ base, audience = 'athlete', onData = () => {} }) {
  let data = null;
  let el = null, tab = 'accountability';
  let reader = null;          // lesson being read
  let editing = false;        // check-in form open over a saved check-in
  let draft = null;           // unsaved check-in answers
  const openCourses = new Set();
  const fresh = new Set();    // message ids that were unread when this view first showed them
  let readPosted = false;
  let replyTo = null;         // message id with the reply box open
  const replyDrafts = new Map();
  let allMessages = false;    // "Show older" pressed
  let dayOpen = null;         // calendar day with its details showing
  const openTests = new Set();
  let showDone = false;       // finished assignments listed
  let lessonQuery = '';
  const you = () => (audience === 'parent' ? data?.athlete?.first_name || 'your athlete' : 'you');
  const parent = audience === 'parent';
  const first = () => data?.athlete?.first_name || 'your athlete';
  const coachWord = () => (parent ? `${first()}'s coach` : 'your coach');

  async function load() {
    data = await api.get(`${base}/engage`, { noRedirect: audience === 'athlete' });
    readPosted = false;
    onData(data);
    return data;
  }
  async function reload() { await load(); rerender(); }
  function rerender() { if (el && el.isConnected) render(el, tab); }

  function render(target, which = tab) {
    el = target;
    if (which !== tab) { reader = null; editing = false; }
    tab = which;
    if (!data) { mount(el, html`<p class="muted" aria-busy="true">Loading…</p>`); return; }
    if (reader) return renderReader();
    if (tab === 'accountability') renderAccountability();
    else if (tab === 'performance') renderPerformance();
    else renderEducation();
  }

  // ======== Accountability ========
  function streaks(a) {
    const s = a.streaks;
    return html`<section class="eg-streaks" aria-label="Streaks">
      <div class="eg-streak"><div class="eg-big ${s.active_weeks ? 'good' : ''}">${s.active_weeks}</div>
        <div class="eg-big-l">${s.active_weeks === 1 ? 'active week' : 'active weeks'} in a row</div><div class="eg-big-n">2 or more training days a week</div></div>
      <div class="eg-streak"><div class="eg-big ${s.checkin_days ? 'good' : ''}">${s.checkin_days}</div>
        <div class="eg-big-l">${s.checkin_days === 1 ? 'check-in day' : 'check-in days'} in a row</div><div class="eg-big-n">${a.checkin_today ? 'Checked in today' : 'Check in today to keep it going'}${s.checkin_best > s.checkin_days ? html`<br>Best: ${plural(s.checkin_best, 'day')}` : s.checkin_best > 1 ? html`<br>Best yet` : ''}</div></div>
    </section>`;
  }
  function unreadBanner(a) {
    const n = (a.messages || []).filter((m) => !m.read).length;
    if (!n) return '';
    return html`<button type="button" class="eg-newmsg" data-jump-msg>${tabIcon('accountability', 18)}<span>${n === 1 ? `New message from ${coachWord()}` : `${n} new messages from ${coachWord()}`}</span>${icon('chevron', 16)}</button>`;
  }
  function countsTable(a) {
    const rows = [['Workouts', 'workouts'], ['Sessions', 'sessions'], ['Check-ins', 'checkins']];
    const month = new Date(a.today + 'T12:00:00').toLocaleDateString('en-US', { month: 'long' });
    return html`<section class="panel panel-tight"><h2 class="panel-title">Counts</h2>
      <table class="eg-counts"><thead><tr><th scope="col"><span class="sr-only">Activity</span></th><th scope="col">This week</th><th scope="col">${month}</th></tr></thead>
      <tbody>${rows.map(([l, k]) => html`<tr><th scope="row">${l}</th><td>${a.this_week[k]}</td><td>${a.this_month[k]}</td></tr>`)}</tbody></table></section>`;
  }
  function calendar(a) {
    const days = a.calendar || [];
    if (!days.length) return '';
    const pad = dayIdx(days[0].date);
    const cell = (d) => {
      const n = Number(d.date.slice(8));
      const what = [d.trained ? 'trained' : null, d.checked_in ? 'checked in' : null].filter(Boolean).join(', ') || 'no activity';
      const isToday = d.date === a.today;
      return html`<div role="listitem"><button type="button" class="eg-day ${d.trained ? 'trained' : ''} ${isToday ? 'today' : ''}" data-day="${d.date}" aria-pressed="${String(dayOpen === d.date)}" aria-controls="eg-day-info">
        <span class="eg-day-n" aria-hidden="true">${n}</span>
        <span class="eg-day-m" aria-hidden="true">${d.trained ? html`<span class="eg-mark-t">${icon('check', 12)}</span>` : ''}${d.checked_in ? html`<span class="eg-mark-c"></span>` : ''}</span>
        <span class="sr-only">${fmtDate(d.date, { year: false, weekday: true })}${isToday ? ' (today)' : ''}: ${what}</span></button></div>`;
    };
    return html`<section class="panel panel-tight"><div class="spread"><h2 class="panel-title">Last 4 weeks</h2>
      <span class="muted small">${fmtDate(days[0].date, { year: false })} to today</span></div>
      <div class="eg-cal-head" aria-hidden="true">${WD.map((w) => html`<span>${w}</span>`)}</div>
      <div class="eg-cal" role="list" aria-label="Training and check-ins, last 28 days">${Array.from({ length: pad }, () => html`<div class="eg-day empty" aria-hidden="true"></div>`)}${days.map(cell)}</div>
      <div class="eg-legend">
        <span><span class="eg-day trained eg-key" aria-hidden="true"><span class="eg-mark-t">${icon('check', 12)}</span></span>Trained</span>
        <span><span class="eg-day eg-key" aria-hidden="true"><span class="eg-mark-c"></span></span>Checked in</span>
        <span><span class="eg-day eg-key" aria-hidden="true"></span>Neither</span>
      </div>
      <div id="eg-day-info" aria-live="polite">${dayOpen ? dayInfo(days.find((d) => d.date === dayOpen), a.today) : html`<p class="muted small" style="margin:0">Tap a day to see what ${parent ? `${first()} did` : 'you did'}.</p>`}</div></section>`;
  }
  function dayInfo(d, today) {
    if (!d) return '';
    const c = d.checkin;
    const lines = [
      ...(d.workouts || []).map((w) => html`<li>${tabIcon('workout', 16)}<span>Workout: ${w}</span></li>`),
      ...(d.sessions || []).map((x) => html`<li>${icon('check', 16)}<span>Session: ${x}</span></li>`),
      c ? html`<li><span class="eg-mark-c" aria-hidden="true"></span><span>Check-in: ${[c.sleep_hours != null ? `slept ${sleepText(c.sleep_hours)}` : null, ...SCALES.filter((s) => c[s.key] != null).map((s) => `${s.label.toLowerCase()} ${c[s.key]}`)].filter(Boolean).join(', ')}</span></li>` : '',
    ].filter(Boolean);
    return html`<div class="eg-dayinfo"><div class="strong">${d.date === today ? 'Today' : fmtDate(d.date, { year: false, weekday: true })}</div>
      ${lines.length ? html`<ul>${lines}</ul>` : html`<p class="muted small" style="margin:0">No training or check-in that day.</p>`}
      ${c?.flags?.length ? html`<p class="warn-text small" style="margin:0">${c.flags.join(' · ')}</p>` : ''}</div>`;
  }
  // The last week of check-ins, newest first, so a trend is easy to spot.
  function recentCheckins(a) {
    const list = (a.recent_checkins || []).filter((c) => c.date >= addDay(a.today, -6)).slice(0, 7);
    if (list.length < 2) return '';
    const cell = (c, k) => (c[k] == null ? html`<td class="muted">—</td>` : html`<td class="${(k === 'soreness' ? c[k] >= 4 : c[k] <= 2) ? 'warn-text' : ''}">${c[k]}</td>`);
    return html`<section class="panel panel-tight" aria-labelledby="eg-rc-h"><div><h2 class="panel-title" id="eg-rc-h">Recent check-ins</h2>
      <p class="panel-sub">Scores out of 5. Soreness: lower is better. Amber needs a look.</p></div>
      <div class="eg-rc-wrap"><table class="eg-rc"><thead><tr><th scope="col">Day</th><th scope="col">Sleep</th>${SCALES.map((s) => html`<th scope="col">${s.label === 'Hydration' ? html`<abbr title="Hydration">Water</abbr>` : s.label === 'Soreness' ? html`<abbr title="Soreness">Sore</abbr>` : s.label}</th>`)}</tr></thead>
      <tbody>${list.map((c) => html`<tr><th scope="row">${c.date === a.today ? 'Today' : fmtDate(c.date, { year: false, weekday: true }).replace(/,.*/, '')}<span class="muted small eg-rc-d">${c.date === a.today ? '' : fmtDate(c.date, { year: false })}</span></th>
        <td class="${c.sleep_hours != null && c.sleep_hours < 6 ? 'warn-text' : ''}">${sleepText(c.sleep_hours)}</td>${SCALES.map((s) => cell(c, s.key))}</tr>`)}</tbody></table></div>
    </section>`;
  }
  function checkinSummary(c) {
    const tips = advice(c);
    return html`<section class="panel" id="eg-checkin" aria-labelledby="eg-ci-h">
      <div class="spread eg-ci-head"><div><h2 class="panel-title" id="eg-ci-h">Today's check-in</h2><p class="panel-sub">${icon('check', 14)} Saved${parent ? ` for ${data.athlete.first_name}` : ''}. ${parent ? 'The coach' : 'Your coach'} can see it.</p></div>
        <button class="btn btn-sm" data-edit-checkin>Edit</button></div>
      <dl class="eg-ci-sum">
        <div><dt>Sleep</dt><dd>${sleepText(c.sleep_hours)}</dd></div>
        ${SCALES.map((s) => html`<div><dt>${s.label}</dt><dd>${c[s.key] != null ? html`${c[s.key]} <span class="muted small">${s.words[c[s.key] - 1]}</span>` : '—'}</dd></div>`)}
      </dl>
      ${c.note ? html`<p class="eg-note">${c.note}</p>` : ''}
      ${tips.length ? html`<div class="eg-flags" role="note">${tips.map((t) => html`<p>${icon('warn', 16)}<span>${t}</span></p>`)}</div>` : ''}
    </section>`;
  }
  function checkinForm(a) {
    const c = draft || { ...(a.checkin_today || {}) };
    draft = c;
    const who = parent ? data.athlete.first_name : null;
    const y = (a.recent_checkins || []).find((x) => x.date === addDay(a.today, -1));
    const blank = [c.sleep_hours, ...SCALES.map((s) => c[s.key])].every((v) => v == null);
    return html`<form class="panel" id="eg-checkin" aria-labelledby="eg-ci-h" novalidate>
      <div class="spread eg-ci-head"><div><h2 class="panel-title" id="eg-ci-h">Today's check-in</h2>
        <p class="panel-sub">${parent ? `Filling it in for ${who}? Ask how ${who} feels and enter the answers.` : 'Takes 20 seconds. Answer what you can.'}</p></div>
        ${y && blank ? html`<button type="button" class="btn btn-sm" data-same-yesterday>Same as yesterday</button>` : ''}</div>
      <div class="field"><label class="label" for="eg-sleep">Hours of sleep last night</label>
        <div class="eg-stepper">
          <button type="button" class="btn" data-step="-0.5" aria-label="Half an hour less">−</button>
          <input class="input" id="eg-sleep" name="sleep_hours" type="number" inputmode="decimal" min="0" max="16" step="0.5" placeholder="8" value="${c.sleep_hours ?? ''}">
          <button type="button" class="btn" data-step="0.5" aria-label="Half an hour more">+</button>
        </div></div>
      ${SCALES.map((s) => html`<div class="field" role="group" aria-labelledby="eg-l-${s.key}">
        <span class="label" id="eg-l-${s.key}">${s.label} <span class="muted" style="font-weight:400">· ${s.q}</span></span>
        <div class="eg-scale">${s.words.map((w, i) => html`<button type="button" data-scale="${s.key}" data-v="${i + 1}" aria-pressed="${String(c[s.key] === i + 1)}"><b>${i + 1}</b><span>${w}</span></button>`)}</div></div>`)}
      <div class="field"><label class="label" for="eg-note">Note for ${parent ? 'the coach' : 'your coach'} <span class="muted" style="font-weight:400">(optional)</span></label>
        <textarea class="input" id="eg-note" name="note" rows="2" maxlength="500" placeholder="${parent ? `Anything the coach should know about ${who}?` : 'Anything your coach should know?'}">${c.note || ''}</textarea></div>
      <div class="error" id="eg-ci-err" role="alert"></div>
      <div class="btn-row"><button class="btn btn-primary" type="submit">Save check-in</button>
        ${a.checkin_today ? html`<button class="btn btn-ghost" type="button" data-cancel-checkin>Cancel</button>` : ''}</div>
    </form>`;
  }
  function goals(a) {
    const list = a.goals || [];
    return html`<section class="panel" aria-labelledby="eg-goals-h"><div><h2 class="panel-title" id="eg-goals-h">This week's goals</h2>
      <p class="panel-sub">Monday to Sunday. ${list.length ? `${list.filter((g) => g.done).length} of ${list.length} met.` : ''}</p></div>
      ${list.length ? html`<div class="list">${list.map((g) => {
        const pct = Math.round(Math.min(1, g.progress / g.target) * 100);
        return html`<div class="eg-goal">
          <div class="spread"><span class="strong">${g.title}</span>
            <span class="${g.done ? 'good-text strong' : 'muted'}">${g.done ? html`${icon('check', 14)} ` : ''}${g.progress} of ${g.target}</span></div>
          ${bar(pct, `${g.title}: ${g.progress} of ${g.target}`)}
          ${g.kind === 'custom'
            ? html`<div class="spread"><span class="muted small">${g.team ? 'Team goal. ' : ''}Tick it off each day ${parent ? `${first()} does it` : 'you do it'}.</span>
                <button class="toggle" data-goal="${g.id}" aria-pressed="${String(!!g.checked_today)}">${g.checked_today ? html`${icon('check', 14)} Done today` : 'Done today'}</button></div>
              ${weekStrip(g, a.today)}`
            : html`<span class="muted small">${g.team ? 'Team goal. ' : ''}Counts itself from ${g.kind === 'checkins' ? 'daily check-ins' : g.kind === 'sessions' ? 'sessions attended' : 'finished workouts'}.</span>`}
          ${goalHistory(g)}
        </div>`;
      })}</div>` : html`<p class="muted" style="margin:0">No goals set this week. ${parent ? 'The coach' : 'Your coach'} can add some.</p>`}
    </section>`;
  }
  // Monday to Sunday: tap an earlier day this week to tick off a day that was missed.
  function weekStrip(g, today) {
    const done = new Set(g.checked_days || []);
    return html`<div class="eg-week" role="group" aria-label="${g.title}: days this week">${WD.map((w, i) => {
      const d = addDay(g.week_start, i);
      const future = d > today;
      const on = done.has(d);
      return html`<button type="button" class="eg-wd ${d === today ? 'is-today' : ''}" data-goal-day="${g.id}" data-date="${d}" aria-pressed="${String(on)}" ${future ? raw('disabled') : ''}
        aria-label="${fmtDate(d, { year: false, weekday: true })}${d === today ? ' (today)' : ''}${on ? ', done' : ''}"><span aria-hidden="true">${w.slice(0, 1)}</span>${on ? html`<span class="eg-wd-c" aria-hidden="true">${icon('check', 12)}</span>` : ''}</button>`;
    })}</div>`;
  }
  function goalHistory(g) {
    const bits = [];
    if (g.streak > 1) bits.push(html`<span class="good-text">Met ${g.streak} weeks in a row</span>`);
    if (g.last_week) bits.push(html`<span>Last week: ${g.last_week.progress} of ${g.last_week.target}${g.last_week.met ? ', met' : ''}</span>`);
    return bits.length ? html`<div class="small muted eg-ghist">${bits.map((b, i) => html`${i ? ' · ' : ''}${b}`)}</div>` : '';
  }
  function messages(a) {
    const list = a.messages || [];
    const shown = allMessages ? list : list.slice(0, MSG_SHOWN);
    const replyBy = (r) => (r.from === 'parent' ? (r.parent || 'Parent') : parent ? first() : 'You');
    return html`<section class="panel" id="eg-msgs" aria-labelledby="eg-msg-h" tabindex="-1"><div><h2 class="panel-title" id="eg-msg-h">From ${coachWord()}</h2>
      ${list.length ? html`<p class="panel-sub">Reply and ${parent ? 'the coach' : 'your coach'} gets it by email.</p>` : ''}</div>
      ${list.length ? html`<div class="list">${shown.map((m) => {
        const isNew = fresh.has(m.id) || !m.read;
        const open = replyTo === m.id;
        return html`<article class="eg-msg ${isNew ? 'unread' : ''}" aria-label="Message from ${m.coach || 'your coach'}">
          <div class="spread"><span class="strong">${m.coach || 'Your coach'}${m.team ? html` <span class="muted" style="font-weight:400">· to the team</span>` : ''}</span>
            <span class="muted small">${isNew ? html`<span class="badge badge-good">New</span> ` : ''}${relTime(m.created_at)}</span></div>
          <p class="eg-note">${m.body}</p>
          ${(m.replies || []).map((r) => html`<div class="eg-reply"><div class="small"><span class="strong">${replyBy(r)}</span> <span class="muted">· ${relTime(r.created_at)}</span></div><p class="eg-note">${r.body}</p></div>`)}
          ${open ? html`<form class="eg-reply-form" data-reply-form="${m.id}" novalidate>
              <label class="sr-only" for="eg-r-${m.id}">Reply to ${m.coach || 'your coach'}</label>
              <textarea class="input" id="eg-r-${m.id}" rows="3" maxlength="1000" placeholder="${parent ? `Write to ${m.coach ? m.coach.split(' ')[0] : 'the coach'} about ${first()}` : `Write back to ${m.coach ? m.coach.split(' ')[0] : 'your coach'}`}">${replyDrafts.get(m.id) || ''}</textarea>
              <div class="error" role="alert" id="eg-r-err-${m.id}"></div>
              <div class="btn-row"><button class="btn" type="submit">Send reply</button><button class="btn btn-ghost" type="button" data-reply-cancel>Cancel</button></div></form>`
            : html`<div><button type="button" class="btn btn-ghost btn-sm eg-reply-btn" data-reply="${m.id}">${icon('back', 14)} Reply</button></div>`}
        </article>`;
      })}</div>
      ${list.length > MSG_SHOWN && !allMessages ? html`<button type="button" class="btn btn-ghost btn-block" data-older>Show ${plural(list.length - MSG_SHOWN, 'older message')}</button>` : ''}`
      : html`<p class="muted" style="margin:0">No messages yet.</p>`}
    </section>`;
  }
  function renderAccountability() {
    const a = data.accountability;
    const showForm = !a.checkin_today || editing;
    mount(el, html`${unreadBanner(a)}
      ${streaks(a)}
      ${showForm ? checkinForm(a) : checkinSummary(a.checkin_today)}
      ${goals(a)}
      ${messages(a)}
      ${calendar(a)}
      ${recentCheckins(a)}
      ${countsTable(a)}`);
    bindAccountability();
    markRead();
  }
  function bindAccountability() {
    const form = el.querySelector('form#eg-checkin');
    el.querySelector('[data-edit-checkin]')?.addEventListener('click', () => {
      editing = true; draft = null; rerender(); el.querySelector('#eg-sleep')?.focus();
    });
    if (form) {
      const sleep = form.querySelector('#eg-sleep');
      const note = form.querySelector('#eg-note');
      sleep.addEventListener('input', () => { draft.sleep_hours = sleep.value === '' ? null : Number(sleep.value); });
      note.addEventListener('input', () => { draft.note = note.value; });
      form.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
        const cur = sleep.value === '' ? (Number(b.dataset.step) > 0 ? 7.5 : 8.5) : Number(sleep.value);
        const v = Math.max(0, Math.min(16, Math.round((cur + Number(b.dataset.step)) * 2) / 2));
        sleep.value = v; draft.sleep_hours = v;
      }));
      form.querySelectorAll('[data-scale]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.scale, v = Number(b.dataset.v);
        draft[k] = draft[k] === v ? null : v;
        form.querySelectorAll(`[data-scale="${k}"]`).forEach((x) => x.setAttribute('aria-pressed', String(Number(x.dataset.v) === draft[k])));
      }));
      form.querySelector('[data-cancel-checkin]')?.addEventListener('click', () => { editing = false; draft = null; rerender(); });
      form.querySelector('[data-same-yesterday]')?.addEventListener('click', () => {
        const y = (data.accountability.recent_checkins || []).find((x) => x.date === addDay(data.accountability.today, -1));
        if (!y) return;
        draft = { ...draft, sleep_hours: y.sleep_hours };
        for (const k of SCALES) draft[k.key] = y[k.key];
        rerender();
        toast("Yesterday's answers are filled in. Change anything that's different, then save.");
        el.querySelector('#eg-checkin [type=submit]')?.focus();
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = form.querySelector('#eg-ci-err');
        err.textContent = '';
        const body = { sleep_hours: sleep.value === '' ? null : Number(sleep.value), note: note.value };
        for (const s of SCALES) body[s.key] = draft[s.key] ?? null;
        if (body.sleep_hours != null && !(body.sleep_hours >= 0 && body.sleep_hours <= 16)) { err.textContent = 'Enter hours of sleep between 0 and 16.'; sleep.setAttribute('aria-invalid', 'true'); sleep.focus(); return; }
        if (body.sleep_hours == null && SCALES.every((s) => body[s.key] == null)) { err.textContent = 'Fill in at least one answer.'; return; }
        const btn = form.querySelector('[type=submit]'); btn.disabled = true;
        try {
          const saved = await api.post(`${base}/checkin`, body);
          data.accountability.checkin_today = saved;
          editing = false; draft = null;
          toast(parent ? `Check-in saved for ${data.athlete.first_name}.` : 'Check-in saved. Your coach can see it.');
          await load().catch(() => {});
          rerender();
          el.querySelector('#eg-checkin')?.scrollIntoView({ block: 'nearest' });
        } catch (x) { err.textContent = x.message; btn.disabled = false; }
      });
    }
    async function tick(b, id, date, done, focusSel) {
      const g = data.accountability.goals.find((x) => x.id === id);
      const wasDone = g.done;
      b.disabled = true;
      try {
        const r = await api.post(`${base}/goals/${id}/check`, { done, date });
        Object.assign(g, r);
        rerender();
        el.querySelector(focusSel)?.focus();
        if (done && r.done && !wasDone) toast(`${r.title}: met for this week.`);
      } catch (x) { toastError(x); b.disabled = false; }
    }
    el.querySelectorAll('[data-goal]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.goal);
      const g = data.accountability.goals.find((x) => x.id === id);
      tick(b, id, data.accountability.today, !g.checked_today, `[data-goal="${id}"]`);
    }));
    el.querySelectorAll('[data-goal-day]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.goalDay), date = b.dataset.date;
      tick(b, id, date, b.getAttribute('aria-pressed') !== 'true', `[data-goal-day="${id}"][data-date="${date}"]`);
    }));
    el.querySelector('[data-jump-msg]')?.addEventListener('click', () => {
      const m = el.querySelector('#eg-msgs');
      m?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      m?.focus({ preventScroll: true });
    });
    el.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      dayOpen = dayOpen === b.dataset.day ? null : b.dataset.day;
      el.querySelectorAll('[data-day]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.day === dayOpen)));
      const info = el.querySelector('#eg-day-info');
      const days = data.accountability.calendar || [];
      mount(info, dayOpen ? dayInfo(days.find((d) => d.date === dayOpen), data.accountability.today) : html`<p class="muted small" style="margin:0">Tap a day to see what ${parent ? `${first()} did` : 'you did'}.</p>`);
    }));
    el.querySelector('[data-older]')?.addEventListener('click', () => { allMessages = true; rerender(); el.querySelectorAll('.eg-msg')[MSG_SHOWN]?.querySelector('button')?.focus(); });
    el.querySelectorAll('[data-reply]').forEach((b) => b.addEventListener('click', () => {
      replyTo = Number(b.dataset.reply); rerender();
      el.querySelector(`#eg-r-${replyTo}`)?.focus();
    }));
    const rf = el.querySelector('[data-reply-form]');
    if (rf) {
      const id = Number(rf.dataset.replyForm);
      const ta = rf.querySelector('textarea');
      ta.addEventListener('input', () => replyDrafts.set(id, ta.value));
      rf.querySelector('[data-reply-cancel]').addEventListener('click', () => {
        replyTo = null; replyDrafts.delete(id); rerender(); el.querySelector(`[data-reply="${id}"]`)?.focus();
      });
      rf.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = rf.querySelector('.error'); err.textContent = '';
        const text = ta.value.trim();
        if (!text) { err.textContent = 'Write a reply first.'; ta.focus(); return; }
        const btn = rf.querySelector('[type=submit]'); btn.disabled = true;
        try {
          const r = await api.post(`${base}/messages/${id}/reply`, { body: text });
          const keepRead = new Map(data.accountability.messages.map((m) => [m.id, m.read]));
          data.accountability.messages = r.messages.map((m) => ({ ...m, read: keepRead.has(m.id) ? keepRead.get(m.id) : m.read }));
          replyTo = null; replyDrafts.delete(id);
          toast(r.emailed ? `Reply sent. ${r.coach ? r.coach.split(' ')[0] : 'The coach'} gets it by email.` : 'Reply saved.');
          rerender();
          el.querySelector(`[data-reply="${id}"]`)?.focus();
        } catch (x) { err.textContent = x.message; btn.disabled = false; }
      });
    }
  }
  // Opening the tab marks messages read; they keep their "New" label until the next load.
  function markRead() {
    const a = data.accountability;
    if (readPosted || !a.unread) return;
    readPosted = true;
    a.messages.filter((m) => !m.read).forEach((m) => fresh.add(m.id));
    api.post(`${base}/messages/read`).then(() => {
      a.messages.forEach((m) => { m.read = true; });
      a.unread = 0;
      onData(data);
    }).catch(() => { readPosted = false; });
  }

  // ======== Performance ========
  function renderPerformance() {
    const p = data.performance || {};
    const tests = (p.tests || []).filter((t) => t.count > 0);
    const targets = p.targets || [];
    const ranks = Array.isArray(p.rankings) && p.rankings.length ? p.rankings : null;
    const prs = p.prs || [];
    const code = data.athlete?.code || p.athlete?.code;
    const catOrder = [];
    for (const t of tests) if (!catOrder.includes(t.category || 'Other')) catOrder.push(t.category || 'Other');
    const lastDate = p.last_date || tests.reduce((m, t) => { const d = t.history?.[t.history.length - 1]?.date; return d && d > m ? d : m; }, '');

    mount(el, html`
      ${tests.length ? html`<div class="eg-summary">
        <div><div class="eg-sum-v">${tests.length}</div><div class="eg-sum-l">${tests.length === 1 ? 'test' : 'tests'}</div></div>
        <div><div class="eg-sum-v ${prs.length ? 'good' : ''}">${prs.length}</div><div class="eg-sum-l">new ${prs.length === 1 ? 'PR' : 'PRs'}</div></div>
        <div><div class="eg-sum-v word">${lastDate ? fmtDate(lastDate, { year: false }) : '—'}</div><div class="eg-sum-l">last tested</div></div>
      </div>` : ''}
      ${p.note?.text ? html`<section class="panel"><div><h2 class="panel-title">Coach's note</h2>
        <p class="panel-sub">${[p.note.day_name, p.note.date ? fmtDate(p.note.date) : null].filter(Boolean).join(' · ')}</p></div>
        <p class="eg-note">${p.note.text}</p></section>` : ''}
      ${targets.length ? html`<section class="panel" aria-labelledby="eg-tg-h"><div><h2 class="panel-title" id="eg-tg-h">Targets</h2>
        <p class="panel-sub">Set by ${parent ? 'the coach' : 'your coach'}. Best result so far, then the target.</p></div>
        <div class="list">${targets.map((t) => html`<div class="eg-goal">
          <div class="spread"><span class="strong">${t.test}</span>${t.reached ? html`<span class="badge badge-good">${icon('check', 12)} Reached</span>` : html`<span class="muted">${t.pct}%</span>`}</div>
          <div class="eg-tg-vals"><span>${t.best_text || 'Not tested yet'}</span><span class="muted" aria-hidden="true">→</span><span class="sr-only">target</span><span class="strong">${t.target_text}</span>
            ${t.due_date && !t.reached ? html`<span class="${t.overdue ? 'warn-text' : 'muted'} small">${t.overdue ? 'was due' : 'by'} ${fmtDate(t.due_date, { year: false })}</span>` : ''}</div>
          ${bar(t.pct, `${t.test}: ${t.pct}% of the way to the target`)}
          ${t.to_go_text ? html`<span class="muted small">${t.to_go_text}${t.lower_better ? ' · lower is better' : ''}</span>` : t.reached ? '' : html`<span class="muted small">Progress counts from the first test.</span>`}
        </div>`)}</div></section>` : ''}
      ${ranks ? html`<section class="panel" aria-labelledby="eg-rk-h"><div><h2 class="panel-title" id="eg-rk-h">How ${parent ? data.athlete.first_name : 'you'} compare${parent ? 's' : ''}</h2>
        <p class="panel-sub">Rankings only compare best results. No names are shown to anyone.</p></div>
        <div class="list">${ranks.map((r) => {
          return html`<div class="eg-rank"><div class="spread"><span class="strong">${r.test}</span><span class="muted">Best ${fmtValue(r.best, r.unit)}</span></div>
            <ul>${r.ranks.map((x) => html`<li>${rankText(x, r.unit)}</li>`)}</ul></div>`;
        })}</div></section>` : ''}
      ${prs.length ? html`<section class="panel" aria-labelledby="eg-pr-h"><h2 class="panel-title" id="eg-pr-h">New PRs</h2>
        <div class="eg-prs">${prs.map((r) => html`<div class="eg-pr"><span class="eg-pr-v">${fmtValue(r.value, r.unit)}</span><span class="eg-pr-l">${r.test}</span><span class="muted small">${fmtDate(r.date, { year: false })}</span></div>`)}</div></section>` : ''}
      ${tests.length ? html`<section class="panel" aria-labelledby="eg-all-h"><div><h2 class="panel-title" id="eg-all-h">Every test</h2><p class="panel-sub">Best result and change since the first test. Tap a test to see every result.</p></div>
        <div class="list">${catOrder.map((cat) => html`${catOrder.length > 1 ? html`<div class="eg-cat">${cat}</div>` : ''}${tests.filter((t) => (t.category || 'Other') === cat).map((t) => {
          const good = t.category !== 'Body' && t.change != null && t.change !== 0 && (t.lower_better ? t.change < 0 : t.change > 0);
          const open = openTests.has(t.test_id);
          const isPr = prs.some((r) => r.test === t.name);
          return html`<div class="eg-tblock"><button type="button" class="eg-trow" data-test="${t.test_id}" aria-expanded="${String(open)}" aria-controls="eg-th-${t.test_id}">
            <span><span class="strong eg-tname">${t.name}${isPr ? html` <span class="badge badge-good">PR</span>` : ''}</span><span class="muted small">${t.count > 1 ? `${fmtValue(t.first, t.unit)} → ${fmtValue(t.latest, t.unit)}` : `Tested once${t.history?.[0]?.date ? `, ${fmtDate(t.history[0].date)}` : ''}`}${t.lower_better ? ' · lower is better' : ''}</span></span>
            <span>${raw(trendSvg(t.history, t.lower_better, { w: 84, h: 28 }))}</span>
            <span class="eg-tbest">${fmtValue(t.best, t.unit)}${t.count > 1 && t.change != null ? html`<span class="${good ? 'good-text' : 'muted'}">${fmtChange(t.change, t.unit)}</span>` : ''}</span>
          </button>
          <div id="eg-th-${t.test_id}" class="eg-thist" ${open ? '' : raw('hidden')}>${testHistory(t)}</div></div>`;
        })}`)}</div></section>` : html`<div class="empty">No test results yet. After ${parent ? `${data.athlete.first_name}'s` : 'your'} next testing day, results show up here.</div>`}
      ${code && tests.length ? html`<a class="btn btn-block" href="/report/${encodeURIComponent(code)}" target="_blank" rel="noopener">${icon('print', 18)} Printable report</a>` : ''}
    `);
    el.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.test);
      const open = !openTests.has(id);
      if (open) openTests.add(id); else openTests.delete(id);
      b.setAttribute('aria-expanded', String(open));
      el.querySelector(`#eg-th-${id}`).hidden = !open;
    }));
  }

  // Every testing date for one test, newest first, with the best marked.
  function testHistory(t) {
    const h = [...(t.history || [])].reverse();
    return html`<table class="eg-hist"><caption class="sr-only">${t.name}, every result</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Result</th><th scope="col"><span class="sr-only">Change from the one before</span></th></tr></thead>
      <tbody>${h.map((x, i) => {
        const prev = h[i + 1];
        const diff = prev ? Math.round((x.value - prev.value) * 1000) / 1000 : null;
        const better = diff != null && diff !== 0 && (t.lower_better ? diff < 0 : diff > 0);
        return html`<tr><td>${fmtDate(x.date)}</td><td class="strong">${fmtValue(x.value, t.unit)}${x.value === t.best && t.count > 1 ? html` <span class="good-text small">Best</span>` : ''}</td>
          <td class="small ${better && t.category !== 'Body' ? 'good-text' : 'muted'}">${diff != null && diff !== 0 ? fmtChange(diff, t.unit) : diff === 0 ? 'Same' : ''}</td></tr>`;
      })}</tbody></table>`;
  }

  // ======== Education ========
  function lessonRowHtml(l, { showCourse = false } = {}) {
    return html`<button class="eg-lesson" data-lesson="${l.id}">
      <span class="eg-lesson-i ${l.done ? 'done' : ''}" aria-hidden="true">${icon(l.done ? 'check' : l.has_video ? 'play' : 'chevron', 16)}</span>
      <span class="grow"><span class="strong eg-lesson-t">${l.title}</span>
        <span class="muted small">${[l.minutes ? `${l.minutes} min` : null, l.has_video ? 'Video' : null, showCourse && l.course ? l.course : null, l.done ? 'Done' : null].filter(Boolean).join(' · ')}</span>
        ${l.summary ? html`<span class="muted small eg-lesson-s">${l.summary}</span>` : ''}</span>
    </button>`;
  }
  function renderEducation() {
    const e = data.education || { assigned: [], courses: [], lessons: [] };
    const courseById = (id) => e.courses.find((c) => c.id === id);
    const assigned = e.assigned || [];
    for (const x of assigned) if (x.type === 'course' && !x.done && !openCourses.has(`init${x.course_id}`)) { openCourses.add(x.course_id); openCourses.add(`init${x.course_id}`); }
    const empty = !assigned.length && !e.courses.length && !e.lessons.length;
    // Open work first (overdue, then by due date); finished work folds away once there's something still to do.
    const todo = assigned.filter((x) => !x.done), finished = assigned.filter((x) => x.done);
    const listed = todo.length && !showDone ? todo : [...todo, ...finished];
    const lessonCount = e.courses.reduce((n, c) => n + c.total, 0) + e.lessons.length;
    const q = lessonQuery.trim().toLowerCase();
    const hit = (l) => !q || `${l.title} ${l.summary || ''}`.toLowerCase().includes(q);
    const courses = e.courses.map((c) => ({ ...c, shown: q && c.title.toLowerCase().includes(q) ? c.lessons : c.lessons.filter(hit) })).filter((c) => !q || c.shown.length);
    const library = e.lessons.filter(hit);
    mount(el, html`
      ${assigned.length ? html`<section class="panel" aria-labelledby="eg-as-h"><div><h2 class="panel-title" id="eg-as-h">Assigned</h2>
        <p class="panel-sub">From ${coachWord()}. ${todo.length ? `${finished.length} of ${assigned.length} done.` : `${assigned.length === 1 ? 'Done' : `All ${assigned.length} done`}. Nice work.`}</p></div>
        <div class="list">${listed.map((x) => {
          const c = x.type === 'course' ? courseById(x.course_id) : null;
          const pct = c && c.total ? Math.round((c.done / c.total) * 100) : x.done ? 100 : 0;
          return html`<div class="eg-assign ${x.overdue ? 'overdue' : ''}">
            <div class="spread"><div class="grow"><span class="strong">${x.title}</span>
              <div class="small ${x.overdue ? 'warn-text' : 'muted'}">${x.type === 'course' ? `Course · ${x.progress}` : 'Lesson'}${x.due_date ? html` · ${x.overdue ? html`${icon('warn', 13)} Overdue, was due ${fmtDate(x.due_date, { year: false })}` : `Due ${fmtDate(x.due_date, { year: false, weekday: true })}`}` : ''}</div></div>
              ${x.done ? html`<span class="badge badge-good">${icon('check', 12)} Done</span>` : ''}</div>
            ${x.note ? html`<p class="eg-note small muted" style="margin:0">${x.note}</p>` : ''}
            ${c ? bar(pct, `${x.title}: ${x.progress} lessons done`) : ''}
            ${x.done ? '' : html`<div><button class="btn btn-sm ${x.overdue ? 'btn-warn' : 'btn-outline'}" data-open-assign="${x.id}">${x.type === 'course' ? (c && c.done ? `Continue: ${c.lessons.find((l) => !l.done)?.title || 'next lesson'}` : 'Start course') : 'Read lesson'}</button></div>`}
          </div>`;
        })}</div>
        ${todo.length && finished.length ? html`<button type="button" class="btn btn-ghost btn-block" data-show-done aria-expanded="${String(showDone)}">${showDone ? 'Hide finished' : `Show ${finished.length} finished`}</button>` : ''}
      </section>` : ''}
      ${lessonCount >= SEARCH_AT ? html`<div class="field eg-search"><label class="sr-only" for="eg-lq">Search lessons</label>
        <input class="input" id="eg-lq" type="search" placeholder="Search lessons" autocomplete="off" value="${lessonQuery}"></div>` : ''}
      <div id="eg-lessons">${lessonLists(courses, library, q)}</div>
      ${empty ? html`<div class="empty">No lessons yet. When ${parent ? 'the coach' : 'your coach'} posts one, it shows up here.</div>` : ''}
    `);
    bindLessonLists();
    el.querySelector('[data-show-done]')?.addEventListener('click', () => { showDone = !showDone; rerender(); el.querySelector('[data-show-done]')?.focus(); });
    el.querySelector('#eg-lq')?.addEventListener('input', (ev) => {
      lessonQuery = ev.target.value;
      const qq = lessonQuery.trim().toLowerCase();
      const h2 = (l) => !qq || `${l.title} ${l.summary || ''}`.toLowerCase().includes(qq);
      const cs = e.courses.map((c) => ({ ...c, shown: qq && c.title.toLowerCase().includes(qq) ? c.lessons : c.lessons.filter(h2) })).filter((c) => !qq || c.shown.length);
      mount(el.querySelector('#eg-lessons'), lessonLists(cs, e.lessons.filter(h2), qq));
      bindLessonLists();
    });
    el.querySelectorAll('[data-open-assign]').forEach((b) => b.addEventListener('click', () => {
      const x = assigned.find((y) => y.id === Number(b.dataset.openAssign));
      if (x.type === 'lesson') return openLesson(x.lesson_id);
      const c = courseById(x.course_id);
      const next = c?.lessons.find((l) => !l.done) || c?.lessons[0];
      if (next) openLesson(next.id);
    }));
  }
  function lessonLists(courses, library, q) {
    return html`
      ${courses.length ? html`<section class="stack" aria-labelledby="eg-co-h"><h2 class="eg-h2" id="eg-co-h">Courses</h2>
        ${courses.map((c) => {
          const open = q ? true : openCourses.has(c.id);
          return html`<div class="panel panel-tight eg-course">
            <button class="eg-course-h" data-course="${c.id}" aria-expanded="${String(open)}" aria-controls="eg-c-${c.id}">
              <span class="grow"><span class="strong eg-lesson-t">${c.title}</span>
                <span class="muted small">${c.done} of ${plural(c.total, 'lesson')} done${c.complete ? ' · Complete' : ''}</span></span>
              <span class="eg-chev" aria-hidden="true">${icon('chevron', 18)}</span></button>
            ${bar(c.total ? Math.round((c.done / c.total) * 100) : 0, `${c.title}: ${c.done} of ${c.total} done`)}
            <div id="eg-c-${c.id}" ${open ? '' : raw('hidden')}>
              ${c.description ? html`<p class="muted small" style="margin:4px 0 8px">${c.description}</p>` : ''}
              <div class="list">${c.shown.map((l) => lessonRowHtml(l))}</div></div>
          </div>`;
        })}</section>` : ''}
      ${library.length ? html`<section class="panel panel-tight" aria-labelledby="eg-lib-h"><h2 class="panel-title" id="eg-lib-h">Lessons library</h2>
        <div class="list">${library.map((l) => lessonRowHtml(l))}</div></section>` : ''}
      ${q && !courses.length && !library.length ? html`<p class="muted" role="status" style="margin:0">No lessons match "${q}".</p>` : ''}`;
  }
  function bindLessonLists() {
    el.querySelectorAll('[data-course]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.course);
      const open = !openCourses.has(id);
      if (open) openCourses.add(id); else openCourses.delete(id);
      b.setAttribute('aria-expanded', String(open));
      el.querySelector(`#eg-c-${id}`).hidden = !open;
    }));
    el.querySelectorAll('[data-lesson]').forEach((b) => b.addEventListener('click', () => openLesson(Number(b.dataset.lesson))));
  }

  // ---- lesson reader (in-page) ----
  async function openLesson(id) {
    try {
      reader = await api.get(`${base}/lessons/${id}`);
      rerender();
      window.scrollTo(0, 0);
      el.querySelector('#eg-reader-h')?.focus();
    } catch (x) { toastError(x); }
  }
  function renderReader() {
    const l = reader;
    mount(el, html`<article class="eg-reader" aria-labelledby="eg-reader-h">
      <div><button class="btn btn-ghost btn-sm eg-back" data-back>${icon('back', 16)} Back to Education</button></div>
      ${l.course ? html`<p class="eg-crumb">${l.course.title}${l.position ? ` · Lesson ${l.position.n} of ${l.position.of}` : ''}</p>` : ''}
      <h2 class="eg-reader-t" id="eg-reader-h" tabindex="-1">${l.title}</h2>
      <p class="muted" style="margin:0">${[l.minutes ? `${l.minutes} min` : null, l.done ? 'Done' : null].filter(Boolean).join(' · ')}</p>
      ${lessonVideo(l.video_url, l.title)}
      <div class="eg-body">${l.body ? paragraphs(l.body) : l.summary ? html`<p>${l.summary}</p>` : html`<p class="muted">This lesson has no text yet.</p>`}</div>
      <div class="eg-reader-foot">
        <button class="btn ${l.done ? 'btn-outline' : 'btn-primary'}" data-done aria-pressed="${String(!!l.done)}">${l.done ? html`${icon('check', 16)} Done` : 'Mark as done'}</button>
        ${l.next ? html`<button class="btn ${l.done ? 'btn-primary' : ''}" data-next="${l.next.id}">Next lesson ${icon('chevron', 16)}</button>`
          : l.done ? html`<button class="btn btn-primary" data-back-foot>Back to Education</button>` : ''}
      </div>
      ${l.next ? html`<p class="muted small" style="margin:0">Up next: ${l.next.title}</p>` : l.course ? html`<p class="muted small" style="margin:0">That's the last lesson in ${l.course.title}.</p>` : ''}
    </article>`);
    const back = () => {
      const id = l.id;
      reader = null; rerender();
      el.querySelector(`[data-lesson="${id}"]`)?.focus();
    };
    el.querySelector('[data-back]').addEventListener('click', back);
    el.querySelector('[data-back-foot]')?.addEventListener('click', back);
    el.querySelector('[data-done]').addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const r = await api.post(`${base}/lessons/${l.id}/complete`, { done: !l.done });
        reader = r;
        await load().catch(() => {});
        const courseDone = r.done && r.course && data.education?.courses?.find((c) => c.id === r.course.id)?.complete;
        if (r.done) toast(courseDone ? `Lesson done. That finishes ${r.course.title}.` : parent ? `Marked done for ${data.athlete.first_name}.` : 'Lesson done. Your coach can see it.');
        rerender();
        el.querySelector('[data-done]')?.focus();
      } catch (x) { toastError(x); b.disabled = false; }
    });
    el.querySelector('[data-next]')?.addEventListener('click', (e) => openLesson(Number(e.currentTarget.dataset.next)));
  }

  return {
    load, reload, render, rerender,
    get data() { return data; },
    set data(d) { data = d; readPosted = false; onData(d); },
    get tab() { return tab; },
    // True while someone is reading a lesson or has typed into the check-in form.
    busy() {
      if (reader || replyTo != null) return true;
      return !!(draft && Object.values(draft).some((v) => v != null && v !== '')) && (editing || !data?.accountability?.checkin_today);
    },
    closeReader() { reader = null; },
    you,
  };
}
