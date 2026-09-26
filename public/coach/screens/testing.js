// Testing: testing days, running a day (stopwatch + typed entry), uploads, results waiting to be linked,
// devices & imports, and the test library.
import { html, raw, mount, api, icon, toast, toastError, modal, confirmDialog, formData, options, fmtDate, relTime, localISO, debounce, plural, badge } from '/js/ui.js';
import { fmtValue, fmtNumber, unitsFor, convert, parseEntry, bestOf, scoring } from '/js/testing-format.js';

const OC = ['owner', 'coach'];
const canRun = (ctx) => OC.includes(ctx.me.role);
const CAT_ORDER = ['Speed', 'Agility', 'Power', 'Strength', 'Endurance', 'Mobility', 'Body', 'Force plate', 'Baseball', 'Basketball', 'Hockey', 'Soccer'];
const catSort = (a, b) => ((CAT_ORDER.indexOf(a) + 1 || 99) - (CAT_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b);
const name = (a) => `${a.first_name} ${a.last_name}`;
const rangeText = (t) => (t.min_value != null && t.max_value != null ? `${fmtNumber(t.min_value, '')}–${fmtNumber(t.max_value, '')} ${t.unit}` : '');

const STYLE = raw(`<style>
.tst-days .list-row{padding:14px 0}
.tst-days a.strong{color:var(--steel);text-decoration:none}.tst-days a.strong:hover{color:var(--green-soft)}
.tst-checks{display:flex;flex-wrap:wrap;gap:4px 18px}
.tst-checks .check{font-size:14px;min-height:30px;align-items:center}
.tst-checks .check input{margin:0}
.tst-presets{display:flex;flex-wrap:wrap;gap:8px}
.tst-presets .btn[aria-pressed="true"]{border-color:var(--green-mid);color:var(--green-soft);background:var(--green-deep)}
.tst-cat>summary{cursor:pointer;font-weight:600;padding:8px 0;list-style-position:inside}
.tst-cat .tst-checks{padding:6px 0 10px}
.tst-tabs{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin}
.tst-tabs .btn{flex-shrink:0}
.tst-tabs .btn[aria-selected="true"]{background:var(--green);border-color:var(--green);color:var(--on-green)}
.tst-tabs .btn .tst-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green-bright);margin-left:2px}
.tst-tabs .btn[aria-selected="true"] .tst-dot{background:var(--on-green)}
.tst-watch{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.tst-clock{font:600 44px/1 var(--font-mono);letter-spacing:.04em;min-width:170px;font-variant-numeric:tabular-nums}
.tst-clock.running{color:var(--green-bright)}
.tst-watch .btn-lg{min-width:130px;min-height:60px;font-size:20px}
.tst-rows{display:flex;flex-direction:column}
.tst-row{display:grid;grid-template-columns:64px minmax(0,1fr) auto 88px;align-items:center;gap:12px;padding:10px 12px;border-top:1px solid var(--line-subtle)}
.tst-row:first-child{border-top:0}
.tst-row.up{border:1px solid var(--green-mid);border-radius:var(--radius-sm);background:rgba(47,107,52,.08)}
.tst-row.no-watch{grid-template-columns:minmax(0,1fr) auto 88px}
.tst-up{min-height:40px;padding:0 10px}
.tst-up[aria-pressed="true"]{background:var(--green);border-color:var(--green);color:var(--on-green)}
.tst-atts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.tst-att{width:84px;text-align:center;font-variant-numeric:tabular-nums}
.tst-best{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.tst-rowmsg{grid-column:1/-1;margin-top:-4px}
.tst-tag{font-size:12px;color:var(--steel-muted)}
.tst-kit{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.tst-kit .input{width:auto;min-width:88px}
.tst-note{margin:0;color:var(--steel-muted);font-size:13px}
.tst-rej{border-color:var(--amber)}
.tst-rej .panel-title{color:var(--amber)}
.tst-confirm{border:1px solid var(--amber);border-radius:var(--radius-md);padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.tst-confirm .panel-title{color:var(--amber);font-size:16px}
.tst-ath{border:1px solid var(--line);border-radius:var(--radius-md);padding:14px 20px}
.tst-ath .list-row{padding:8px 0;font-size:14px}
.tst-code{font:500 12px/1 var(--font-mono);background:var(--surface-raised);padding:5px 8px;border-radius:var(--radius-sm)}
.tst-pre{background:var(--black);border:1px solid var(--line-subtle);border-radius:var(--radius-sm);padding:14px 16px;overflow-x:auto;font:400 13px/20px var(--font-mono);color:var(--silver);margin:0;white-space:pre}
.tst-q .table td,.tst-q .table th{padding:10px 12px}
.tst-picker{position:relative}
.tst-sugg{position:absolute;left:0;right:0;top:100%;z-index:20;background:var(--surface-raised);border:1px solid var(--control-border);border-radius:var(--radius-sm);margin-top:4px;max-height:260px;overflow:auto}
.tst-sugg button{display:flex;width:100%;justify-content:space-between;gap:12px;padding:10px 12px;background:none;border:0;border-top:1px solid var(--line);cursor:pointer;text-align:left;min-height:44px}
.tst-sugg button:first-child{border-top:0}
.tst-sugg button:hover,.tst-sugg button:focus{background:var(--green-deep)}
.tst-lib .list-row{padding:14px 0}
.tst-lib .hidden-test .strong{color:var(--steel-muted)}
@media (max-width:700px){
  .tst-row{grid-template-columns:56px minmax(0,1fr) 72px;gap:8px;padding:10px 8px}
  .tst-row.no-watch{grid-template-columns:minmax(0,1fr) 72px}
  .tst-row .tst-atts{grid-column:1/-1;justify-content:flex-start;order:5}
  .tst-row.no-watch .tst-atts{grid-column:1/-1}
  .tst-att{width:76px}
  .tst-clock{font-size:38px;min-width:0}
  .tst-watch{gap:16px}
  .tst-hide-sm{display:none}
  .tst-ath{padding:12px 14px}
}
</style>`);

function header(title, sub, actions = '') {
  return html`<div class="page-header"><div><h1 class="page-title">${title}</h1>${sub ? html`<p class="page-sub">${sub}</p>` : ''}</div>${actions ? html`<div class="btn-row">${actions}</div>` : ''}</div>`;
}
const back = () => html`<a class="btn" href="/app/testing">Testing</a>`;
function pendingBanner(ctx, p) {
  if (!p || !p.count) return '';
  return html`<div class="banner"><span>${p.count === 1 ? '1 result is' : `${p.count} results are`} waiting to be linked to a profile.</span>
    ${canRun(ctx) ? html`<a class="btn btn-outline btn-sm" href="/app/testing/queue">Link them</a>` : ''}</div>`;
}

// ============ Testing (list) ============
async function renderList(ctx) {
  const d = await api.get('/testing');
  if (!ctx.isCurrent()) return;
  const oc = canRun(ctx);
  mount(ctx.el, html`${STYLE}
    ${pendingBanner(ctx, d.pending)}
    ${header('Testing', 'Combines, evaluations and team testing. Enter results by hand or stopwatch, import files, or connect your devices.', html`
      <a class="btn" href="/app/testing/library">Test library</a>
      ${oc ? html`<a class="btn" href="/app/testing/devices">Devices</a><a class="btn" href="/app/testing/upload">Upload results</a>
      <a class="btn btn-primary" href="/app/testing/new">${icon('plus')}New testing day</a>` : ''}`)}
    <section class="panel tst-days">
      <h2 class="panel-title">Testing days</h2>
      ${d.days.length ? html`<div class="list">${d.days.map((x) => html`<div class="list-row">
        <div class="grow"><a class="strong" href="/app/testing/day/${x.id}">${x.name}</a>
          <div class="small muted">${fmtDate(x.date)} · ${plural(x.athletes, 'athlete')} · ${plural(x.tests, 'test')}${x.team_name ? ` · ${x.team_name}` : ''}</div></div>
        ${x.status === 'shared' ? badge('active', 'Shared') : badge('open', 'Open')}
        <span class="badge ${x.results ? 'badge-good' : 'badge-muted'}">${plural(x.results, 'result')}</span>
      </div>`)}</div>`
    : html`<div class="empty">No testing days yet. ${oc ? html`Start one with <a href="/app/testing/new">New testing day</a>.` : 'A coach will start one.'}</div>`}
    </section>`);
}

// ============ New testing day ============
async function renderNew(ctx) {
  const o = await api.get('/testing/options');
  if (!ctx.isCurrent()) return;
  const cats = [...new Set(o.tests.map((t) => t.category))].sort(catSort);
  const presetNames = Object.keys(o.presets || {});
  const selected = new Set();
  const firstPreset = presetNames[0];
  const idByName = Object.fromEntries(o.tests.map((t) => [t.name, t.id]));
  (o.presets[firstPreset] || []).forEach((n) => idByName[n] && selected.add(idByName[n]));
  mount(ctx.el, html`${STYLE}
    ${header('New testing day', 'Pick the athletes and tests. Results can be entered by hand, by stopwatch, or pulled from devices.', html`<a class="btn" href="/app/testing">Cancel</a>`)}
    <form class="panel" id="f" style="max-width:980px" novalidate>
      <div class="form-grid">
        <div class="field"><label class="label" for="n">Name</label><input class="input" id="n" name="name" value="Testing day" required></div>
        <div class="field"><label class="label" for="dt">Date</label><input class="input" id="dt" name="date" type="date" value="${localISO()}" required></div>
        <div class="field"><label class="label" for="tm">Team</label><select class="input" id="tm" name="team_id">
          <option value="">Individual athletes</option>${o.teams.map((t) => html`<option value="${t.id}">${t.team_name} (${plural(t.athletes, 'athlete')})</option>`)}</select></div>
      </div>
      <div class="field"><span class="label" id="ath-label">Athletes (you can add walk-ups on the day)</span>
        <p class="hint" id="team-hint" hidden></p>
        <div class="tst-checks" role="group" aria-labelledby="ath-label">${o.athletes.map((a) => html`<label class="check"><input type="checkbox" name="athlete_ids" data-multi value="${a.id}" data-team="${a.team_id || ''}"> ${name(a)}</label>`)}</div></div>
      <div class="field"><span class="label">Tests</span><span class="hint">Start from a preset, then adjust.</span>
        <div class="tst-presets" role="group" aria-label="Presets">${presetNames.map((p) => html`<button type="button" class="btn" data-preset="${p}" aria-pressed="${p === firstPreset}">${p}</button>`)}</div></div>
      <div id="cats">${cats.map((c) => html`<details class="tst-cat" data-cat="${c}"><summary>${c}</summary><div class="tst-checks">
        ${o.tests.filter((t) => t.category === c).map((t) => html`<label class="check"><input type="checkbox" name="test_ids" data-multi value="${t.id}"> ${t.name}</label>`)}</div></details>`)}</div>
      <p class="small muted" id="count" style="margin:0"></p>
      <div class="error" id="err" role="alert"></div>
      <div><button class="btn btn-primary">Start testing day</button></div>
    </form>`);
  const f = ctx.el.querySelector('#f');
  let preset = firstPreset;
  const syncTests = () => {
    f.querySelectorAll('input[name=test_ids]').forEach((c) => { c.checked = selected.has(Number(c.value)); });
    f.querySelectorAll('.tst-cat').forEach((d) => { if ([...d.querySelectorAll('input')].some((c) => c.checked)) d.open = true; });
    f.querySelector('#count').textContent = `${plural(selected.size, 'test')} selected.`;
  };
  syncTests();
  f.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    preset = b.dataset.preset; selected.clear();
    (o.presets[preset] || []).forEach((n) => idByName[n] && selected.add(idByName[n]));
    f.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    f.querySelectorAll('.tst-cat').forEach((d) => { d.open = false; });
    syncTests();
  }));
  f.addEventListener('change', (e) => {
    if (e.target.name === 'test_ids') { e.target.checked ? selected.add(Number(e.target.value)) : selected.delete(Number(e.target.value)); f.querySelector('#count').textContent = `${plural(selected.size, 'test')} selected.`; }
    if (e.target.name === 'team_id') {
      const team = e.target.value;
      let n = 0;
      f.querySelectorAll('input[name=athlete_ids]').forEach((c) => {
        const onTeam = team && c.dataset.team === team;
        if (onTeam) n++;
        c.disabled = !!onTeam; if (onTeam) c.checked = true; else if (c.dataset.auto) c.checked = false;
        c.dataset.auto = onTeam ? '1' : '';
      });
      const hint = f.querySelector('#team-hint');
      hint.hidden = !team;
      hint.textContent = team ? `All ${plural(n, 'athlete')} on the team are in. Tick anyone else who's testing with them.` : '';
    }
  });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    const athleteIds = [...f.querySelectorAll('input[name=athlete_ids]:checked')].map((c) => c.value);
    const btn = f.querySelector('button.btn-primary'); btn.disabled = true;
    try {
      const r = await api.post('/testing/days', { name: d.name, date: d.date, team_id: d.team_id || null, athlete_ids: athleteIds, test_ids: [...selected], preset });
      toast('Testing day started.');
      ctx.go(`/app/testing/day/${r.id}`);
    } catch (err) { f.querySelector('#err').textContent = err.message; btn.disabled = false; }
  };
}

// ============ Testing day ============
async function renderDay(ctx) {
  const [d, opts] = await Promise.all([api.get(`/testing/days/${ctx.params.id}`), api.get('/testing/options')]);
  if (!ctx.isCurrent()) return;
  const oc = canRun(ctx);
  const day = d.day;
  const tests = d.tests;
  const athletes = d.athletes;
  const results = new Map(); // `${athlete}|${test}|${attempt}` → result
  const rk = (a, t, n) => `${a}|${t}|${n}`;
  for (const r of d.results) results.set(rk(r.athlete_id, r.test_id, r.attempt), r);
  let current = tests.find((t) => String(t.id) === ctx.query.test) || tests[0];
  const unitSel = {}; const handSel = {};
  let upId = null;
  let clock = { running: false, start: 0, raf: 0 };

  const slots = (t, aid) => {
    let max = t.attempts || 1;
    for (const k of results.keys()) { const [a, tt, n] = k.split('|').map(Number); if (a === aid && tt === t.id && n > max) max = n; }
    return max;
  };
  const nextEmpty = (t, aid) => { const n = slots(t, aid); for (let i = 1; i <= n; i++) if (!results.has(rk(aid, t.id, i))) return i; return n + 1; };
  const hasEmpty = (t, aid) => nextEmpty(t, aid) <= (t.attempts || 1);
  const bestFor = (t, aid) => bestOf(t, [...results.values()].filter((r) => r.athlete_id === aid && r.test_id === t.id).map((r) => r.value));
  const pickUp = (t) => { const a = athletes.find((x) => hasEmpty(t, x.id)) || athletes[0]; upId = a?.id ?? null; };
  const advanceUp = (t) => {
    if (!athletes.length) return;
    const i = athletes.findIndex((a) => a.id === upId);
    for (let k = 1; k <= athletes.length; k++) { const a = athletes[(i + k) % athletes.length]; if (hasEmpty(t, a.id)) { upId = a.id; return; } }
    upId = athletes[(i + 1) % athletes.length].id;
  };

  const shared = day.status === 'shared';
  const onDay = new Set(athletes.map((a) => a.id));
  mount(ctx.el, html`${STYLE}
    ${pendingBanner(ctx, d.pending)}
    <div class="page-header"><div><h1 class="page-title">${day.name}</h1>
      <p class="page-sub">${fmtDate(day.date)} · ${plural(athletes.length, 'athlete')}${day.team_name ? ` · ${day.team_name}` : ''}</p></div>
      <div class="btn-row">
        ${oc ? html`<button class="btn ${shared ? 'btn-outline' : 'btn-primary'}" id="share">${shared ? 'Shared with parents ✓' : 'Share with parents'}</button>` : ''}
        <a class="btn" href="/api/testing/sheet?day_id=${day.id}&format=xlsx" download>${icon('download')}Download sheet</a>
        ${oc ? html`<a class="btn" href="/app/testing/upload?day=${day.id}">${icon('upload')}Upload results</a>` : ''}
        <a class="btn btn-ghost" href="/app/testing">All testing days</a>
      </div></div>
    ${tests.length ? html`<div class="tst-tabs" role="tablist" aria-label="Tests" id="tabs"></div>
      <section class="panel" id="watch" hidden></section>
      <section class="panel" id="sheet"></section>`
    : html`<div class="empty">This testing day has no tests.</div>`}
  `);
  if (oc) ctx.el.querySelector('#share').onclick = () => shareModal(ctx, day);
  if (!tests.length) return;

  const tabsEl = ctx.el.querySelector('#tabs'), watchEl = ctx.el.querySelector('#watch'), sheetEl = ctx.el.querySelector('#sheet');
  function drawTabs() {
    mount(tabsEl, tests.map((t) => {
      const done = athletes.length && athletes.every((a) => results.has(rk(a.id, t.id, 1)));
      return html`<button class="btn" role="tab" data-test="${t.id}" aria-selected="${t.id === current.id}">${t.name}${done ? html` <span class="tst-dot" title="Everyone has a result"></span>` : ''}</button>`;
    }));
  }
  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-test]'); if (!b) return;
    if (clock.running) { toast('Stop the clock before switching tests.', 'warn'); return; }
    current = tests.find((t) => t.id === Number(b.dataset.test));
    history.replaceState({}, '', `${location.pathname}?test=${current.id}`);
    pickUp(current); drawTabs(); drawWatch(); drawSheet();
  });

  function drawWatch() {
    const t = current;
    watchEl.hidden = !t.timed;
    if (!t.timed) return;
    const up = athletes.find((a) => a.id === upId);
    mount(watchEl, html`<div><h2 class="panel-title">Stopwatch</h2>
      <p class="panel-sub" id="up-line">${up ? `Up: ${name(up)}. Tap Time next to anyone to switch. Stopping the clock saves the time and moves to the next athlete.` : 'Add an athlete to start timing.'}</p></div>
      <div class="tst-watch">
        <div class="tst-clock" id="clock" aria-live="off">0.00</div>
        <button class="btn btn-primary btn-lg" id="sw" ${up ? '' : raw('disabled')}>Start</button>
        <p class="tst-note" style="flex:1;min-width:220px">Hand times usually read faster than electronic gates, so the app keeps them labeled. Space bar starts and stops.</p>
      </div>`);
    watchEl.querySelector('#sw').onclick = toggleClock;
  }
  function tick() {
    const el = watchEl.querySelector('#clock');
    if (!clock.running || !el) return;
    el.textContent = ((performance.now() - clock.start) / 1000).toFixed(2);
    clock.raf = requestAnimationFrame(tick);
  }
  async function toggleClock() {
    const btn = watchEl.querySelector('#sw'), el = watchEl.querySelector('#clock');
    if (!clock.running) {
      if (!upId) return;
      clock = { running: true, start: performance.now(), raf: 0 };
      btn.textContent = 'Stop'; btn.classList.remove('btn-primary'); btn.classList.add('btn-warn'); el.classList.add('running');
      tick();
      return;
    }
    const secs = Math.round(((performance.now() - clock.start) / 1000) * 100) / 100;
    cancelAnimationFrame(clock.raf); clock.running = false;
    el.textContent = secs.toFixed(2); el.classList.remove('running');
    btn.textContent = 'Start'; btn.classList.add('btn-primary'); btn.classList.remove('btn-warn');
    const t = current, aid = upId, attempt = nextEmpty(t, aid);
    const ok = await save(t, aid, attempt, secs, { source: 'stopwatch', unit: 's' });
    if (ok) { advanceUp(t); drawWatch(); watchEl.querySelector('#clock').textContent = secs.toFixed(2); drawSheet(); drawTabs(); }
  }
  const onKey = (e) => {
    if (!document.body.contains(watchEl)) { document.removeEventListener('keydown', onKey); return; }
    if (e.code !== 'Space' || !current.timed || e.target.closest('input,textarea,select,button,a')) return;
    e.preventDefault(); toggleClock();
  };
  document.addEventListener('keydown', onKey);

  function drawSheet() {
    const t = current;
    const unit = unitSel[t.id] || t.unit;
    if (handSel[t.id] == null) handSel[t.id] = !!t.timed;
    const units = unitsFor(t.unit);
    const walkups = opts.athletes.filter((a) => !onDay.has(a.id));
    const show = (v) => { if (v == null) return ''; const x = convert(v, t.unit, unit); return unit === 's' ? fmtNumber(x, 's') : String(Number(x.toFixed(2))); };
    mount(sheetEl, html`<div class="panel-head"><div><h2 class="panel-title">${t.name}</h2>
        <p class="panel-sub">${t.unit} · ${scoring(t)} · ${plural(t.attempts || 1, 'attempt')}. Values save as you type.${rangeText(t) ? ` Expected range ${rangeText(t)}.` : ''}</p></div>
      <div class="tst-kit">
        ${t.unit === 's' ? html`<label class="check" style="align-items:center"><input type="checkbox" id="hand" ${handSel[t.id] ? raw('checked') : ''}> Hand-timed</label>` : ''}
        ${units.length > 1 ? html`<label class="sr-only" for="unit">Unit</label><select class="input" id="unit">${units.map((u) => html`<option ${u === unit ? raw('selected') : ''}>${u}</option>`)}</select>` : ''}
      </div></div>
      <div class="tst-rows">${athletes.map((a) => {
        const n = slots(t, a.id), best = bestFor(t, a.id);
        const anyHand = [...results.values()].some((r) => r.athlete_id === a.id && r.test_id === t.id && r.hand_timed);
        return html`<div class="tst-row ${t.timed ? '' : 'no-watch'} ${t.timed && a.id === upId ? 'up' : ''}" data-a="${a.id}">
          ${t.timed ? html`<button class="btn tst-up" data-up="${a.id}" aria-pressed="${a.id === upId}">${a.id === upId ? 'Up' : 'Time'}</button>` : ''}
          <div style="min-width:0"><div class="strong">${name(a)}</div><div class="small muted mono">${a.code}</div></div>
          <div class="tst-atts">${Array.from({ length: n }, (_, i) => html`<input class="input tst-att" inputmode="decimal" autocomplete="off" data-att="${i + 1}"
            aria-label="${name(a)}, ${t.name}, attempt ${i + 1}" placeholder="#${i + 1}" value="${show(results.get(rk(a.id, t.id, i + 1))?.value)}">`)}</div>
          <div class="tst-best">${best != null ? fmtValue(best, t.unit) : ''}${anyHand && t.unit === 's' ? html`<div class="tst-tag">hand-timed</div>` : ''}</div>
          <div class="tst-rowmsg small warn-text" hidden></div>
        </div>`;
      })}</div>
      ${athletes.length ? '' : html`<div class="empty">No athletes yet. Add a walk-up below.</div>`}
      <div class="row"><label class="sr-only" for="walk">Add a walk-up athlete</label>
        <select class="input" id="walk" style="max-width:320px"><option value="">Add a walk-up athlete…</option>${walkups.map((a) => html`<option value="${a.id}">${name(a)} (${a.code})</option>`)}</select></div>`);
    sheetEl.querySelector('#unit')?.addEventListener('change', (e) => { unitSel[t.id] = e.target.value; drawSheet(); });
    sheetEl.querySelector('#hand')?.addEventListener('change', (e) => { handSel[t.id] = e.target.checked; });
    sheetEl.querySelector('#walk').addEventListener('change', async (e) => {
      const id = Number(e.target.value); if (!id) return;
      try {
        const a = await api.post(`/testing/days/${day.id}/athletes`, { athlete_id: id });
        athletes.push(a); onDay.add(a.id);
        if (!upId) upId = a.id;
        toast(`${name(a)} added.`);
        drawWatch(); drawSheet();
      } catch (err) { toastError(err); }
    });
  }
  sheetEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-up]'); if (!b) return;
    upId = Number(b.dataset.up); drawWatch(); drawSheet();
  });
  const timers = new Map();
  sheetEl.addEventListener('input', (e) => {
    const inp = e.target.closest('.tst-att'); if (!inp) return;
    const row = inp.closest('[data-a]'), aid = Number(row.dataset.a), att = Number(inp.dataset.att), t = current;
    const unit = unitSel[t.id] || t.unit;
    const msg = row.querySelector('.tst-rowmsg');
    const v = parseEntry(inp.value, unit);
    let warn = '';
    if (Number.isNaN(v)) warn = `"${inp.value}" isn't a number.`;
    else if (v != null) {
      const base = convert(v, unit, t.unit);
      if (t.min_value != null && (base < t.min_value || base > t.max_value)) warn = `${inp.value} ${unit} is outside what's possible for ${t.name} (${rangeText(t)}). It won't be saved.`;
    }
    inp.setAttribute('aria-invalid', warn ? 'true' : 'false');
    msg.hidden = !warn; msg.textContent = warn;
    const k = `${aid}|${att}`;
    clearTimeout(timers.get(k));
    if (warn) return;
    timers.set(k, setTimeout(() => save(t, aid, att, inp.value, { unit, input: inp }), 700));
  });
  sheetEl.addEventListener('focusout', (e) => {
    const inp = e.target.closest('.tst-att'); if (!inp) return;
    const row = inp.closest('[data-a]');
    const k = `${row.dataset.a}|${inp.dataset.att}`;
    if (timers.has(k)) { clearTimeout(timers.get(k)); timers.delete(k); if (inp.getAttribute('aria-invalid') !== 'true') save(current, Number(row.dataset.a), Number(inp.dataset.att), inp.value, { unit: unitSel[current.id] || current.unit, input: inp }); }
  });

  const lastSent = new Map();
  async function save(t, aid, attempt, value, { source, unit, input } = {}) {
    const key = rk(aid, t.id, attempt), sig = `${value}|${unit}`;
    if (source !== 'stopwatch' && lastSent.get(key) === sig) return true;
    lastSent.set(key, sig);
    try {
      const r = await api.put(`/testing/days/${day.id}/results`, { athlete_id: aid, test_id: t.id, attempt, value, unit, source, hand_timed: source === 'stopwatch' || !!handSel[t.id] });
      if (r.cleared) results.delete(key); else results.set(key, r.result);
      const a = athletes.find((x) => x.id === aid);
      if (r.pr) toast(`New PR: ${name(a)}, ${t.name} ${r.display}. Previous best ${fmtValue(r.prev_best, t.unit)}.`);
      else if (source === 'stopwatch') toast(`${name(a)}: ${r.display}, hand-timed.`);
      if (input) {
        const row = input.closest('[data-a]');
        const best = bestFor(t, aid);
        const anyHand = [...results.values()].some((x) => x.athlete_id === aid && x.test_id === t.id && x.hand_timed);
        const bestEl = row?.querySelector('.tst-best');
        if (bestEl) mount(bestEl, html`${best != null ? fmtValue(best, t.unit) : ''}${anyHand && t.unit === 's' ? html`<div class="tst-tag">hand-timed</div>` : ''}`);
        drawTabs();
      }
      return true;
    } catch (err) {
      lastSent.delete(key);
      if (input) { input.setAttribute('aria-invalid', 'true'); const m = input.closest('[data-a]')?.querySelector('.tst-rowmsg'); if (m) { m.hidden = false; m.textContent = err.message; } }
      else toastError(err);
      return false;
    }
  }

  pickUp(current); drawTabs(); drawWatch(); drawSheet();
}

async function shareModal(ctx, day) {
  const shared = day.status === 'shared';
  const r = await modal({
    title: shared ? 'Coach note' : 'Share with parents',
    body: html`<p style="margin:0" class="muted">${shared ? 'Families already have these results. Changing the note updates their Progress tab and report; no new email goes out.'
      : "Each family gets an email with their athlete's results and a link to the parent portal. Results show on their Progress tab."}</p>
      <div class="field"><label class="label" for="note">Note to families (optional)</label>
      <textarea class="input" id="note" maxlength="2000" placeholder="What stood out, and what to work on before the next test.">${day.note || ''}</textarea></div>`,
    actions: [{ label: 'Cancel', value: null }, {
      label: shared ? 'Save note' : 'Share and email families', kind: 'primary',
      onClick: async (body) => api.post(`/testing/days/${day.id}/share`, { note: body.querySelector('#note').value }),
    }],
  });
  if (!r) return;
  toast(r.updated ? 'Note saved.' : `Shared. ${plural(r.emails, 'family email')} sent.`);
  ctx.reload();
}

// ============ Upload results ============
async function renderUpload(ctx) {
  const o = await api.get('/testing/options');
  if (!ctx.isCurrent()) return;
  const state = { payload: null, filename: '', check: null, confirmed: new Set() };
  const dayOpts = (sel) => html`<option value="">No testing day</option>${o.days.map((d) => html`<option value="${d.id}" ${String(d.id) === String(sel ?? '') ? raw('selected') : ''}>${d.name} (${fmtDate(d.date)})</option>`)}`;
  mount(ctx.el, html`${STYLE}
    ${header('Upload results', 'All or nothing: a sheet is saved only when every row matches a real Athlete ID and every value fits its test.', back())}
    <div id="stage"></div>`);
  const stage = ctx.el.querySelector('#stage');

  function drawForm() {
    mount(stage, html`<div class="grid-2">
      <section class="panel"><div><h2 class="panel-title">1. Get the sheet</h2>
        <p class="panel-sub">Every athlete's ID is filled in, with a column for each test and attempt. Fill it in on paper, a laptop, or a phone.</p></div>
        <div class="field"><label class="label" for="g-day">Testing day</label><select class="input" id="g-day">${dayOpts(ctx.query.day)}</select></div>
        <div class="form-grid" id="g-alt">
          <div class="field"><label class="label" for="g-team">Team</label><select class="input" id="g-team"><option value="">Choose athletes later</option>${o.teams.map((t) => html`<option value="${t.id}">${t.team_name}</option>`)}</select></div>
          <div class="field"><label class="label" for="g-preset">Tests</label><select class="input" id="g-preset">${Object.keys(o.presets).map((p) => html`<option>${p}</option>`)}</select></div>
        </div>
        <div class="btn-row"><a class="btn btn-primary" id="dl-x" download>${icon('download')}Download Excel</a><a class="btn btn-ghost" id="dl-c" download>Download CSV (Google Sheets)</a></div>
      </section>
      <form class="panel" id="up" novalidate><div><h2 class="panel-title">2. Upload it</h2>
        <p class="panel-sub">Every row needs a real Athlete ID and every value has to fit its test. If anything is off, nothing is saved and you'll see exactly what to fix.</p></div>
        <div class="field"><label class="label" for="file">File (Excel or CSV)</label><input class="input" id="file" type="file" accept=".xlsx,.csv,.tsv,.txt,text/csv"></div>
        <div class="field"><label class="sr-only" for="paste">Paste rows</label><textarea class="input" id="paste" rows="3" placeholder="Or paste rows straight from Excel or Google Sheets, header row included."></textarea></div>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
          <div class="field"><label class="label" for="u-day">Add to testing day</label><select class="input" id="u-day">${dayOpts(ctx.query.day)}</select></div>
          <div class="field"><label class="label" for="u-date">Date for rows without one</label><input class="input" id="u-date" type="date" value="${localISO()}"></div>
          <div class="field"><label class="label" for="u-test">Device export with one test?</label><select class="input" id="u-test"><option value="">It's our sheet or has a test column</option>
            ${o.tests.map((t) => html`<option value="${t.id}">${t.name} (${t.unit})</option>`)}</select></div>
        </div>
        <div class="error" id="u-err" role="alert"></div>
        <div><button class="btn btn-primary">Check the sheet</button></div>
      </form></div>`);
    const gDay = stage.querySelector('#g-day'), gTeam = stage.querySelector('#g-team'), gPreset = stage.querySelector('#g-preset');
    const links = () => {
      const q = gDay.value ? `day_id=${gDay.value}` : `preset=${encodeURIComponent(gPreset.value)}${gTeam.value ? `&team_id=${gTeam.value}` : ''}`;
      stage.querySelector('#dl-x').href = `/api/testing/sheet?${q}&format=xlsx`;
      stage.querySelector('#dl-c').href = `/api/testing/sheet?${q}&format=csv`;
      gTeam.disabled = gPreset.disabled = !!gDay.value;
    };
    [gDay, gTeam, gPreset].forEach((s) => s.addEventListener('change', links)); links();
    const f = stage.querySelector('#up');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = stage.querySelector('#u-err'); err.textContent = '';
      const file = stage.querySelector('#file').files[0];
      const paste = stage.querySelector('#paste').value;
      try {
        if (file) {
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          state.payload = { file_base64: btoa(bin) }; state.filename = file.name;
        } else if (paste.trim()) { state.payload = { text: paste }; state.filename = 'the pasted rows'; }
        else { err.textContent = 'Choose a file or paste rows from your spreadsheet.'; return; }
        Object.assign(state.payload, { filename: file?.name || '', day_id: stage.querySelector('#u-day').value || null, date: stage.querySelector('#u-date').value, test_id: stage.querySelector('#u-test').value || null });
        const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking…';
        state.check = await api.post('/testing/upload/check', state.payload);
        state.confirmed = new Set();
        state.check.ok ? drawReview() : drawRejected();
      } catch (e2) { err.textContent = e2.message; const btn = f.querySelector('button'); btn.disabled = false; btn.textContent = 'Check the sheet'; }
    };
  }

  function drawRejected() {
    const c = state.check;
    mount(stage, html`<section class="panel tst-rej"><h2 class="panel-title">This sheet can't be saved</h2>
      <p style="margin:0">Nothing was saved. ${c.problems.length === 1 ? '1 problem needs' : `${c.problems.length} problems need`} fixing in ${state.filename}. Fix ${c.problems.length === 1 ? 'it' : 'them'}, save, and upload the sheet again.</p>
      <div class="table-wrap" style="border:0;background:transparent"><table class="table"><thead><tr><th>Row</th><th>Column</th><th>Athlete</th><th>What to fix</th></tr></thead>
      <tbody>${c.problems.map((p) => html`<tr><td>${p.row}</td><td>${p.column}</td><td class="mono">${p.athlete}</td><td>${p.problem}</td></tr>`)}</tbody></table></div>
      <div><button class="btn btn-primary" id="again">Upload the fixed sheet</button></div></section>`);
    stage.querySelector('#again').onclick = () => { drawForm(); window.scrollTo(0, 0); };
  }

  function drawReview() {
    const c = state.check;
    const need = c.unusual.filter((u) => !state.confirmed.has(u.key)).length;
    const unusualKeys = new Set(c.unusual.map((u) => u.key));
    mount(stage, html`<section class="panel"><div><h2 class="panel-title">3. Every row checks out</h2>
      <p class="panel-sub">${plural(c.count, 'result')} for ${plural(c.athletes.length, 'athlete')}, each matched by Athlete ID${c.day ? `, going to ${c.day.name}` : ''}. Saving adds all of them at once.${c.pending.length ? ` ${c.pending.length === 1 ? '1 result has' : `${c.pending.length} results have`} no Athlete ID and will wait to be linked.` : ''}</p></div>
      ${c.unusual.length ? html`<div class="tst-confirm"><h3 class="panel-title">Confirm ${c.unusual.length === 1 ? 'this value' : 'these values'}</h3>
        <p class="small muted" style="margin:0">They're possible but unusual. Tick each one that's right. If one is a mistake, fix the sheet and upload it again.</p>
        ${c.unusual.map((u) => html`<label class="check small"><input type="checkbox" data-key="${u.key}" ${state.confirmed.has(u.key) ? raw('checked') : ''}>
          <span><span class="muted">Row ${u.row}, ${u.column}:</span> ${u.message}</span></label>`)}</div>` : ''}
      ${c.athletes.map((a) => {
        const open = a.results.filter((r) => unusualKeys.has(r.key) && !state.confirmed.has(r.key)).length;
        return html`<div class="tst-ath"><div class="spread"><span class="strong">${a.name}</span>
          <span class="row" style="gap:10px"><span class="tst-code">${a.code}</span><span class="small muted">${plural(a.results.length, 'result')}</span>${open ? badge('failed', 'Confirm') : ''}</span></div>
          <div class="list" style="margin-top:6px">${a.results.map((r) => html`<div class="list-row"><span class="grow">${r.test} #${r.attempt}</span>
            <span class="muted small tst-hide-sm">${fmtDate(r.date)}</span><span class="strong" style="white-space:nowrap">${fmtValue(r.value, r.unit)}</span>${r.unusual ? badge(state.confirmed.has(r.key) ? 'active' : 'failed', state.confirmed.has(r.key) ? 'Confirmed' : 'Unusual') : ''}</div>`)}</div></div>`;
      })}
      ${c.pending.length ? html`<div class="tst-ath"><div class="spread"><span class="strong">Waiting to be linked</span><span class="small muted">${plural(c.pending.length, 'result')}</span></div>
        <div class="list" style="margin-top:6px">${c.pending.map((p) => html`<div class="list-row"><span class="grow">${p.sender} · ${p.test}</span><span class="muted small">${fmtDate(p.date)}</span><span class="strong">${fmtValue(p.value, p.unit)}</span></div>`)}</div></div>` : ''}
      <div class="btn-row"><button class="btn btn-primary" id="save" ${need ? raw('disabled') : ''}>${need ? `Confirm ${need} more to save` : `Save ${plural(c.count + c.pending.length, 'result')}`}</button>
        <button class="btn btn-ghost" id="over">Start over</button></div></section>`);
    stage.querySelectorAll('[data-key]').forEach((cb) => cb.addEventListener('change', () => { cb.checked ? state.confirmed.add(cb.dataset.key) : state.confirmed.delete(cb.dataset.key); drawReview(); }));
    stage.querySelector('#over').onclick = drawForm;
    stage.querySelector('#save').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Saving…';
      try {
        const r = await api.post('/testing/upload/save', { ...state.payload, confirmed: [...state.confirmed] });
        mount(stage, html`<section class="panel"><h2 class="panel-title">Saved</h2>
          <p style="margin:0">${plural(r.saved, 'result')} ${r.saved === 1 ? 'is' : 'are'} in ${plural(r.athletes, 'profile')}${r.prs ? `, with ${plural(r.prs, 'new PR')}` : ''}.${r.pending ? ` ${plural(r.pending, 'result')} ${r.pending === 1 ? 'is' : 'are'} waiting to be linked.` : ''} Uploading the same sheet again won't double-count.</p>
          <div class="btn-row">${c.day ? html`<a class="btn btn-primary" href="/app/testing/day/${c.day.id}">Open ${c.day.name}</a>` : ''}
          ${r.pending ? html`<a class="btn" href="/app/testing/queue">Link waiting results</a>` : ''}<button class="btn btn-ghost" id="another">Upload another sheet</button></div></section>`);
        stage.querySelector('#another').onclick = drawForm;
        toast(`Saved ${plural(r.saved, 'result')}.`);
      } catch (err) {
        if (err.data?.problems) { state.check = err.data; drawRejected(); } else { toastError(err); drawReview(); }
      }
    };
  }
  drawForm();
}

// ============ Waiting to be linked ============
async function renderQueue(ctx) {
  const groups = await api.get('/testing/pending');
  if (!ctx.isCurrent()) return;
  mount(ctx.el, html`${STYLE}
    ${header('Waiting to be linked', "These results arrived without an Athlete ID or a device you've linked. None of them are in a profile yet.", back())}
    <p class="small muted" style="margin:0">Pick who each set belongs to and link it. Linking is all or nothing, and nothing is ever matched by name on its own. Tip: enter Athlete IDs as names on your devices and results skip this step.</p>
    <div class="stack" id="cards">${groups.length ? '' : html`<div class="empty">Nothing is waiting. Every result is in a profile.</div>`}</div>`);
  const cards = ctx.el.querySelector('#cards');
  groups.forEach((g, gi) => {
    const el = document.createElement('section');
    el.className = 'panel tst-q';
    cards.append(el);
    const st = { athlete: null, remember: true, ticked: new Set(g.results.map((r) => r.id)) };
    const senderDesc = g.sender_key !== g.sender_label ? `device ID ${g.sender_key}` : `"${g.sender_label}"`;
    function draw() {
      const n = st.ticked.size;
      mount(el, html`<div><h2 class="panel-title">${g.sender_label}</h2>
        <p class="panel-sub">${g.source}${g.sender_key !== g.sender_label ? ` · device ID ${g.sender_key}` : ''} · ${plural(g.results.length, 'result')} · received ${relTime(g.received_at)}</p></div>
        ${st.athlete ? html`<div class="banner info"><span>Linking to <strong>${name(st.athlete)}</strong> (${st.athlete.code})</span><button class="btn btn-ghost btn-sm" data-clear>Change</button></div>`
        : html`${g.suggestions.length ? html`<div class="row"><span class="small muted">Could be:</span>${g.suggestions.map((a) => html`<button class="btn btn-sm" data-pick="${a.id}">${name(a)} (${a.code})</button>`)}</div>` : ''}
          <div class="tst-picker"><label class="sr-only" for="q${gi}">Find athlete</label><input class="input" id="q${gi}" autocomplete="off" placeholder="Type a name or Athlete ID, then pick from the list"><div class="tst-sugg" hidden></div></div>`}
        <div class="table-wrap" style="border:0;background:transparent"><table class="table"><thead><tr><th><span class="sr-only">Include</span></th><th>Test</th><th>Result</th><th>Tested</th><th class="tst-hide-sm">Device</th></tr></thead>
        <tbody>${g.results.map((r) => html`<tr><td style="width:44px"><input type="checkbox" style="width:20px;height:20px;accent-color:var(--green-mid)" data-r="${r.id}" aria-label="Include ${r.test}" ${st.ticked.has(r.id) ? raw('checked') : ''}></td>
          <td>${r.test}</td><td class="strong">${fmtValue(r.value, r.unit)}</td><td>${fmtDate(r.recorded_at)}</td><td class="muted tst-hide-sm">${g.source}</td></tr>`)}</tbody></table></div>
        <label class="check small"><input type="checkbox" data-remember ${st.remember ? raw('checked') : ''}> Remember: send future results from ${senderDesc} (${g.source}) straight to ${st.athlete ? name(st.athlete) : 'this athlete'}</label>
        <div class="btn-row"><button class="btn btn-primary" data-link ${!st.athlete || !n ? raw('disabled') : ''}>Link ${plural(n, 'result')}</button>
          <button class="btn btn-ghost" data-discard ${n ? '' : raw('disabled')}>Discard selected</button></div>`);
      const q = el.querySelector('.tst-picker input');
      if (q) {
        const box = el.querySelector('.tst-sugg');
        q.addEventListener('input', debounce(async () => {
          const term = q.value.trim();
          if (term.length < 2) { box.hidden = true; return; }
          const list = await api.get(`/athletes/search?q=${encodeURIComponent(term)}`).catch(() => []);
          mount(box, list.length ? list.map((a) => html`<button type="button" data-pick="${a.id}" data-json="${JSON.stringify(a)}"><span>${name(a)}</span><span class="mono small muted">${a.code}</span></button>`) : html`<div class="small muted" style="padding:10px 12px">No athlete matches.</div>`);
          box.hidden = false;
        }, 200));
      }
    }
    el.addEventListener('click', async (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick) { st.athlete = pick.dataset.json ? JSON.parse(pick.dataset.json) : g.suggestions.find((a) => a.id === Number(pick.dataset.pick)); draw(); return; }
      if (e.target.closest('[data-clear]')) { st.athlete = null; draw(); return; }
      if (e.target.closest('[data-link]')) {
        try {
          const r = await api.post('/testing/pending/link', { ids: [...st.ticked], athlete_id: st.athlete.id, remember: st.remember });
          toast(`Linked ${plural(r.linked, 'result')} to ${name(st.athlete)}.${r.prs ? ` ${plural(r.prs, 'new PR')}.` : ''}`);
          ctx.reload();
        } catch (err) { toastError(err); }
        return;
      }
      if (e.target.closest('[data-discard]')) {
        if (!(await confirmDialog('Discard results', `Discard ${plural(st.ticked.size, 'result')} from ${g.sender_label}? They won't go into any profile.`, 'Discard', 'warn'))) return;
        try { await api.post('/testing/pending/discard', { ids: [...st.ticked] }); toast('Discarded.'); ctx.reload(); } catch (err) { toastError(err); }
      }
    });
    el.addEventListener('change', (e) => {
      if (e.target.dataset.r) { e.target.checked ? st.ticked.add(Number(e.target.dataset.r)) : st.ticked.delete(Number(e.target.dataset.r)); draw(); }
      if (e.target.hasAttribute('data-remember')) st.remember = e.target.checked;
    });
    draw();
  });
}

// ============ Devices & imports ============
async function renderDevices(ctx) {
  const d = await api.get('/testing/devices');
  if (!ctx.isCurrent()) return;
  const owner = ctx.me.role === 'owner';
  const hk = d.hawkin;
  const origin = location.origin;
  const curl = `curl -X POST ${origin}/api/v1/results \\
  -H "Authorization: Bearer dp_live_..." -H "Content-Type: application/json" \\
  -d '{"source":"gates","device_id":"LANE-3","athlete_code":"AVALOP2026",
       "test":"40-yard dash","value":4.71,"ref":"run-8812"}'`;
  mount(ctx.el, html`${STYLE}
    ${header('Devices & imports', 'Get results in from anywhere: live connections, file imports, the open API, or by hand.', back())}
    ${d.pending.count ? html`<section class="panel"><div><h2 class="panel-title">Waiting to be linked</h2>
      <p class="panel-sub">${plural(d.pending.count, 'result')} from ${plural(d.pending.senders, 'unrecognized sender')}. Nothing lands in a profile until you link it.</p></div>
      <a class="btn btn-primary btn-block" href="/app/testing/queue">Link them</a></section>` : ''}
    <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Hawkin Dynamics force plates</h2>
      <p class="panel-sub">Connect once with an integration token from Hawkin (Settings, then Integrations). New tests sync every 15 minutes.</p></div>
      ${hk.connected ? badge('active', 'Connected') : badge('off', 'Not connected')}</div>
      ${hk.connected ? html`<p class="small ${hk.status && !hk.status.ok ? 'warn-text' : 'muted'}" style="margin:0">${hk.status ? `Last sync ${relTime(hk.status.at)}: ${hk.status.message}` : 'Waiting for the first sync.'}${hk.token_hint ? ` Token ${hk.token_hint}, ${hk.region}.` : ''}</p>
        ${owner ? html`<div class="btn-row"><button class="btn" id="hk-sync">Sync now</button><button class="btn btn-ghost" id="hk-off">Disconnect</button></div>` : ''}`
      : owner ? html`<form class="row" id="hk" style="align-items:flex-end" novalidate>
          <div class="field" style="flex:1;min-width:220px"><label class="label" for="hk-t">Integration token</label><input class="input mono" id="hk-t" name="token" autocomplete="off" placeholder="Integration token from Hawkin"></div>
          <div class="field"><label class="label" for="hk-r">Region</label><select class="input" id="hk-r" name="region"><option>Americas</option><option>Europe</option><option>Asia Pacific</option></select></div>
          <button class="btn btn-primary">Connect</button></form>`
        : html`<p class="small muted" style="margin:0">Not connected. An owner can paste the integration token here.</p>`}
    </section>
    <section class="panel"><div><h2 class="panel-title">Import a file</h2>
      <p class="panel-sub">OVR, VALD, Swift, Freelap, Brower, Dashr, Rapsodo, radar guns, our template or any spreadsheet.</p></div>
      <p class="small muted" style="margin:0">In OVR Connect, open the profile tab and export your history, then upload the file here. Rows with an Athlete ID go straight to that profile; the rest wait to be linked.</p>
      <div><a class="btn btn-primary" href="/app/testing/upload">Upload results</a></div></section>
    <section class="panel"><div><h2 class="panel-title">Send results from any system</h2>
      <p class="panel-sub">Any timing system, app or script can post results to the open API with an API key. Values in other units are converted, athletes are matched by Athlete ID or a linked device, and resending the same result is ignored.</p></div>
      <pre class="tst-pre">${curl}</pre>
      <p class="small muted" style="margin:0">Send one result or an array. Fields: athlete_code or athlete_id, device_id, device_name, source, test, value, unit, recorded_at, ref.</p>
      <div class="btn-row">${owner ? html`<a class="btn" href="/app/integrations">API keys</a>` : ''}<a class="btn btn-ghost" href="/docs/api">Full API reference</a></div></section>
    <section class="panel"><div><h2 class="panel-title">Linked device IDs</h2>
      <p class="panel-sub">Results from these device IDs and names go straight to the athlete. Everything else needs an Athlete ID or waits for you.</p></div>
      ${d.links.length ? html`<div class="list">${d.links.map((l) => html`<div class="list-row"><div class="grow"><div class="strong">${l.sender_label || l.sender_key}</div>
          <div class="small muted">${l.source}${l.sender_label && l.sender_label !== l.sender_key ? ` · ${l.sender_key}` : ''} · linked ${fmtDate(l.created_at)}</div></div>
          <span>${l.first_name} ${l.last_name} <span class="mono small muted">${l.code}</span></span>
          <button class="btn btn-ghost btn-sm" data-unlink="${l.id}">Unlink</button></div>`)}</div>`
      : html`<p class="small muted" style="margin:0">None yet. Links are created when you link waiting results and choose to remember them.</p>`}</section>`);
  const f = ctx.el.querySelector('#hk');
  if (f) f.onsubmit = async (e) => { e.preventDefault(); try { await api.put('/testing/hawkin', formData(f)); toast('Hawkin connected.'); ctx.reload(); } catch (err) { toastError(err); } };
  ctx.el.querySelector('#hk-sync')?.addEventListener('click', async () => { const r = await api.post('/testing/hawkin/sync').catch(toastError); if (r) { toast(r.error ? r.error : 'Sync finished.', r.error ? 'warn' : 'good'); ctx.reload(); } });
  ctx.el.querySelector('#hk-off')?.addEventListener('click', async () => { if (await confirmDialog('Disconnect Hawkin', 'New force plate tests stop syncing. Results already saved stay in profiles.', 'Disconnect', 'warn')) { await api.del('/testing/hawkin'); ctx.reload(); } });
  ctx.el.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Unlink device', 'Future results from this device will wait to be linked again.', 'Unlink', 'warn'))) return;
    try { await api.del(`/testing/links/${b.dataset.unlink}`); toast('Unlinked.'); ctx.reload(); } catch (err) { toastError(err); }
  }));
}

// ============ Test library ============
async function renderLibrary(ctx) {
  const tests = await api.get('/tests?all=1');
  if (!ctx.isCurrent()) return;
  const oc = canRun(ctx);
  const cats = [...new Set(tests.map((t) => t.category))].sort(catSort);
  const visible = tests.filter((t) => !t.hidden).length;
  mount(ctx.el, html`${STYLE}
    ${header('Test library', oc ? `${visible} tests ready. Hide the ones you don't use, or add your own.` : `${visible} tests. Owners and coaches can hide tests or add their own.`, html`${back()}${oc ? html`<button class="btn btn-primary" id="add">${icon('plus')}Add a test</button>` : ''}`)}
    <div class="stack tst-lib">${cats.map((c) => html`<section class="panel"><h2 class="panel-title">${c}</h2><div class="list">
      ${tests.filter((t) => t.category === c).map((t) => html`<div class="list-row ${t.hidden ? 'hidden-test' : ''}"><div class="grow">
        <div class="strong">${t.name} ${t.custom ? html`<span class="badge badge-neutral" style="margin-left:6px">Custom</span>` : ''}${t.hidden ? html`<span class="badge badge-muted" style="margin-left:6px">Hidden</span>` : ''}</div>
        <div class="small muted">${t.unit}, ${scoring(t)} · ${plural(t.attempts || 1, 'attempt')}${rangeText(t) ? ` · possible range ${rangeText(t)}` : ''}${t.timed ? ' · stopwatch' : ''}</div></div>
        ${oc ? html`<button class="btn btn-ghost btn-sm" data-toggle="${t.id}" data-hidden="${t.hidden ? 1 : 0}">${t.hidden ? 'Show' : 'Hide'}</button>` : ''}</div>`)}
    </div></section>`)}</div>`);
  ctx.el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.patch(`/tests/${b.dataset.toggle}`, { hidden: b.dataset.hidden !== '1' }); ctx.reload(); } catch (err) { toastError(err); }
  }));
  ctx.el.querySelector('#add')?.addEventListener('click', async () => {
    const r = await modal({
      title: 'Add a test',
      body: html`<form class="stack" id="nt" novalidate>
        <div class="field"><label class="label" for="nt-n">Name</label><input class="input" id="nt-n" name="name" required autofocus></div>
        <div class="form-grid">
          <div class="field"><label class="label" for="nt-c">Category</label><select class="input" id="nt-c" name="category">${options([...cats.filter((c) => c !== 'Custom'), 'Custom'].map((c) => ({ id: c, name: c })), 'Custom')}</select></div>
          <div class="field"><label class="label" for="nt-u">Unit</label><input class="input" id="nt-u" name="unit" placeholder="s, in, lb, reps…" required></div>
          <div class="field"><label class="label" for="nt-s">Scoring</label><select class="input" id="nt-s" name="lower_better"><option value="0">Higher is better</option><option value="1">Lower is better</option></select></div>
          <div class="field"><label class="label" for="nt-a">Attempts</label><input class="input" id="nt-a" name="attempts" type="number" min="1" max="10" value="2"></div>
          <div class="field"><label class="label" for="nt-min">Lowest possible</label><input class="input" id="nt-min" name="min_value" inputmode="decimal"></div>
          <div class="field"><label class="label" for="nt-max">Highest possible</label><input class="input" id="nt-max" name="max_value" inputmode="decimal"></div>
        </div>
        <label class="check"><input type="checkbox" name="timed"> Timed with the stopwatch (seconds)</label>
        <span class="hint">The possible range catches typos, like a broad jump typed in the 40 column.</span></form>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Add test', kind: 'primary', onClick: async (body) => api.post('/tests', formData(body.querySelector('#nt'))) }],
    });
    if (r) { toast(`${r.name} added.`); ctx.reload(); }
  });
}

export const routes = [
  { path: '/testing', nav: 'testing', title: 'Testing', render: renderList },
  { path: '/testing/new', nav: 'testing', title: 'New testing day', roles: OC, render: renderNew },
  { path: '/testing/day/:id', nav: 'testing', title: 'Testing day', render: renderDay, keepScroll: false },
  { path: '/testing/upload', nav: 'testing', title: 'Upload results', roles: OC, render: renderUpload },
  { path: '/testing/queue', nav: 'testing', title: 'Waiting to be linked', roles: OC, render: renderQueue },
  { path: '/testing/devices', nav: 'testing', title: 'Devices & imports', roles: OC, render: renderDevices },
  { path: '/testing/library', nav: 'testing', title: 'Test library', render: renderLibrary },
];
