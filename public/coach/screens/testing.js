// Testing: testing days, running a day (stopwatch + typed entry), uploads, results waiting to be linked,
// devices & imports, and the test library.
import { html, raw, mount, api, icon, toast, toastError, modal, confirmDialog, formData, options, fmtDate, relTime, localISO, debounce, plural, badge } from '/js/ui.js';
import { fmtValue, fmtNumber, fmtChange, unitsFor, convert, parseEntry, bestOf, better, scoring, outOfRange } from '/js/testing-format.js';

const OC = ['owner', 'coach'];
const canRun = (ctx) => OC.includes(ctx.me.role);
const CAT_ORDER = ['Speed', 'Agility', 'Power', 'Strength', 'Endurance', 'Mobility', 'Body', 'Force plate', 'Baseball', 'Basketball', 'Hockey', 'Soccer'];
const catSort = (a, b) => ((CAT_ORDER.indexOf(a) + 1 || 99) - (CAT_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b);
const name = (a) => `${a.first_name} ${a.last_name}`;
const rangeText = (t) => (t.min_value != null && t.max_value != null ? `${fmtNumber(t.min_value, '')}–${fmtNumber(t.max_value, '')} ${t.unit}`
  : t.min_value != null ? `at least ${fmtNumber(t.min_value, '')} ${t.unit}` : t.max_value != null ? `at most ${fmtNumber(t.max_value, '')} ${t.unit}` : '');
const MAX_ATTEMPTS = 20;

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
.tst-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tst-filters .input{width:240px;min-height:40px}
.tst-days .list-row{flex-wrap:wrap}
.tst-prog{display:flex;align-items:center;gap:8px;min-width:150px}
.tst-prog .bar{width:90px}
.tst-badges{display:flex;gap:8px;align-items:center}
.tst-new .tst-checks .check{min-height:44px}
.tst-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tst-tools .input{max-width:320px;flex:1;min-width:180px}
.tst-chips{display:flex;flex-wrap:wrap;gap:6px}
.tst-chip{display:inline-flex;align-items:center;gap:6px;padding:0 0 0 12px;min-height:40px;border:1px solid var(--control-border);border-radius:var(--radius-sm);background:var(--surface-raised);font-size:14px}
.tst-chip button{display:inline-flex;align-items:center;justify-content:center;min-width:40px;min-height:40px;background:none;border:0;color:var(--steel-muted);cursor:pointer}
.tst-chip button:hover,.tst-chip button:focus-visible{color:var(--amber)}
.tst-tabbar{display:flex;gap:8px;align-items:flex-start}
.tst-tabbar .tst-tabs{flex:1;min-width:0}
.tst-addtest{flex-shrink:0}
.tst-count{font-size:12px;font-weight:600;color:var(--steel-muted);display:inline-flex;align-items:center}
.tst-count.done{color:var(--green-bright)}
.tst-tabs .btn[aria-selected="true"] .tst-count{color:var(--on-green)}
.tst-last{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:14px}
.tst-row.can-rm{grid-template-columns:64px minmax(0,1fr) auto 88px 44px}
.tst-row.no-watch.can-rm{grid-template-columns:minmax(0,1fr) auto 88px 44px}
.tst-more,.tst-rm{min-width:44px;padding:0;color:var(--steel-muted)}
.tst-rm:hover{color:var(--amber)}
.tst-best .badge{margin-top:2px}
.tst-handchk{align-items:center;min-height:44px}
.tst-rank{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.tst-rankrow{display:grid;grid-template-columns:44px minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:10px 4px;border-top:1px solid var(--line-subtle)}
.tst-rankrow:first-child{border-top:0}
.tst-rankno{font:600 22px/1 var(--font-display);color:var(--steel-muted);text-align:center}
.tst-rankrow:nth-child(-n+3) .tst-rankno{color:var(--green-bright)}
.tst-edfoot{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line-subtle);padding-top:12px}
.tst-edtests .list-row{padding:6px 0}
/* 44px touch targets on the testing screens */
.tst-tools .btn,.tst-kit .seg button,.tst-filters .seg button,.tst-up,.tst-last .btn,.tst-filters .input,.tst-banner .btn{min-height:44px}
.tst-chip{min-height:44px}.tst-chip button{min-width:44px;min-height:44px}
.tst-cat>summary{min-height:44px;display:flex;align-items:center;gap:6px}
.tst-cat>summary::before{content:'▸';color:var(--steel-muted)}.tst-cat[open]>summary::before{content:'▾'}
.tst-cat>summary::-webkit-details-marker{display:none}.tst-cat>summary{list-style:none}
@media (max-width:700px){
  .tst-row.can-rm{grid-template-columns:56px minmax(0,1fr) 80px}
  .tst-row.no-watch.can-rm{grid-template-columns:minmax(0,1fr) 80px}
  .tst-row.can-rm .tst-atts{grid-column:1/-2}
  .tst-row.can-rm .tst-rm{order:6;justify-self:end}
  .tst-rowmsg{order:7}
  .tst-row.can-rm .tst-att{width:70px}
  .tst-row.can-rm .tst-atts{gap:6px}
  .tst-filters,.tst-filters .input{width:100%}
  .tst-prog{order:5;width:100%}
  .tst-dayhead .btn-row .btn{padding:0 12px;font-size:14px}
  .tst-dayhead .btn-row .btn svg{display:none}
  .tst-watchp{position:sticky;top:57px;z-index:30;padding:12px 14px;gap:8px;box-shadow:0 8px 16px rgba(0,0,0,.45)}
  .tst-watchp .panel-title{display:none}
  .tst-watch .btn-lg{min-width:110px;min-height:56px}
  .tst-rankrow{grid-template-columns:36px minmax(0,1fr) auto}
  .tst-addtest{padding:0 12px}
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
  return html`<div class="banner tst-banner"><span>${p.count === 1 ? '1 result is' : `${p.count} results are`} waiting to be linked to a profile.${canRun(ctx) ? '' : ' A coach can link them.'}</span>
    ${canRun(ctx) ? html`<a class="btn btn-outline btn-sm" href="/app/testing/queue">Link them</a>` : ''}</div>`;
}
const dayWhen = (date) => (date === localISO() ? 'Today' : fmtDate(date, { weekday: true }));
const progressBar = (done, total, label) => html`<div class="tst-prog" title="${label}"><div class="bar" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></div><span class="small muted">${done} of ${total}</span></div>`;

// ============ Testing (list) ============
async function renderList(ctx) {
  const d = await api.get('/testing');
  if (!ctx.isCurrent()) return;
  const oc = canRun(ctx);
  const q = { show: ['open', 'shared'].includes(ctx.query.show) ? ctx.query.show : 'all', term: ctx.query.q || '' };
  const counts = { all: d.days.length, open: d.days.filter((x) => x.status !== 'shared').length, shared: d.days.filter((x) => x.status === 'shared').length };
  mount(ctx.el, html`${STYLE}
    ${pendingBanner(ctx, d.pending)}
    ${header('Testing', 'Combines, evaluations and team testing. Enter results by hand or stopwatch, import files, or connect your devices.', html`
      <a class="btn" href="/app/testing/library">Test library</a>
      ${oc ? html`<a class="btn" href="/app/testing/devices">Devices</a><a class="btn" href="/app/testing/upload">Upload results</a>
      <a class="btn btn-primary" href="/app/testing/new">${icon('plus')}New testing day</a>` : ''}`)}
    <section class="panel tst-days">
      <div class="panel-head"><h2 class="panel-title">Testing days</h2>
        ${d.days.length > 1 ? html`<div class="tst-filters">
          <div class="seg" role="group" aria-label="Show">${[['all', 'All'], ['open', 'Open'], ['shared', 'Shared']].map(([k, l]) => html`<button type="button" data-show="${k}" aria-pressed="${q.show === k}">${l} (${counts[k]})</button>`)}</div>
          <label class="sr-only" for="dq">Find a testing day</label><input class="input" id="dq" type="search" placeholder="Find by name or team" value="${q.term}" autocomplete="off">
        </div>` : ''}</div>
      <div id="days"></div>
    </section>`);
  const listEl = ctx.el.querySelector('#days');
  const draw = () => {
    const term = q.term.trim().toLowerCase();
    const rows = d.days.filter((x) => (q.show === 'all' || (q.show === 'shared' ? x.status === 'shared' : x.status !== 'shared'))
      && (!term || `${x.name} ${x.team_name || ''}`.toLowerCase().includes(term)));
    if (!d.days.length) {
      mount(listEl, html`<div class="empty">No testing days yet. ${oc ? html`Start one with <a href="/app/testing/new">New testing day</a>, or upload a sheet you already have.` : 'A coach will start one, and you can enter results here.'}</div>`);
      return;
    }
    if (!rows.length) { mount(listEl, html`<div class="empty">No testing days match. <button class="btn btn-ghost btn-sm" id="clr">Show all</button></div>`); listEl.querySelector('#clr').onclick = () => { q.show = 'all'; q.term = ''; const i = ctx.el.querySelector('#dq'); if (i) i.value = ''; sync(); }; return; }
    mount(listEl, html`<div class="list">${rows.map((x) => {
      const slots = x.athletes * x.tests;
      return html`<div class="list-row">
        <div class="grow"><a class="strong" href="/app/testing/day/${x.id}">${x.name}</a>
          <div class="small muted">${dayWhen(x.date)} · ${plural(x.athletes, 'athlete')} · ${plural(x.tests, 'test')}${x.team_name ? ` · ${x.team_name}` : ''}</div></div>
        ${x.status !== 'shared' && slots ? progressBar(Math.min(x.done, slots), slots, `${x.done} of ${slots} athlete-tests have a result`) : ''}
        <span class="tst-badges">${x.status === 'shared' ? badge('active', 'Shared') : badge('open', 'Open')}
        <span class="badge ${x.results ? 'badge-good' : 'badge-muted'}">${plural(x.results, 'result')}</span></span>
      </div>`;
    })}</div>`);
  };
  const sync = () => {
    ctx.el.querySelectorAll('[data-show]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.show === q.show)));
    const p = new URLSearchParams(); if (q.show !== 'all') p.set('show', q.show); if (q.term) p.set('q', q.term);
    history.replaceState(history.state, '', `${location.pathname}${p.toString() ? `?${p}` : ''}`);
    draw();
  };
  ctx.el.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => { q.show = b.dataset.show; sync(); }));
  ctx.el.querySelector('#dq')?.addEventListener('input', debounce((e) => { q.term = e.target.value; sync(); }, 150));
  draw();
}

// ============ New testing day ============
async function renderNew(ctx) {
  const o = await api.get('/testing/options');
  if (!ctx.isCurrent()) return;
  const cats = [...new Set(o.tests.map((t) => t.category))].sort(catSort);
  const presetNames = Object.keys(o.presets || {});
  const testById = new Map(o.tests.map((t) => [t.id, t]));
  const idByName = Object.fromEntries(o.tests.map((t) => [t.name, t.id]));
  const selected = new Set(); // insertion order = order on the day
  const pastDays = o.days || [];
  const today = localISO();
  let preset = presetNames.includes(ctx.query.preset) ? ctx.query.preset : presetNames[0]; // ?preset= from the Test library
  (o.presets[preset] || []).forEach((n) => idByName[n] && selected.add(idByName[n]));
  mount(ctx.el, html`${STYLE}
    ${header('New testing day', 'Pick the athletes and tests. Results can be entered by hand, by stopwatch, or pulled from devices.', html`<a class="btn" href="/app/testing">Cancel</a>`)}
    <form class="panel tst-new" id="f" style="max-width:980px" novalidate>
      <div class="form-grid">
        <div class="field"><label class="label" for="n">Name</label><input class="input" id="n" name="name" value="${preset || 'Testing day'}" maxlength="120" required></div>
        <div class="field"><label class="label" for="dt">Date</label><input class="input" id="dt" name="date" type="date" value="${today}" required></div>
        <div class="field"><label class="label" for="tm">Team</label><select class="input" id="tm" name="team_id">
          <option value="">Individual athletes</option>${o.teams.map((t) => html`<option value="${t.id}">${t.team_name} (${plural(t.athletes, 'athlete')})</option>`)}</select></div>
      </div>
      ${pastDays.length ? html`<div class="field"><label class="label" for="from">Retest a past day <span class="muted">(optional)</span></label>
        <select class="input" id="from" style="max-width:460px"><option value="">Start fresh</option>${pastDays.map((x) => html`<option value="${x.id}">${x.name} (${fmtDate(x.date)})</option>`)}</select>
        <span class="hint">Brings in the same athletes and tests so you can compare like for like.</span></div>` : ''}
      <div class="field"><div class="spread"><span class="label" id="ath-label">Athletes <span class="muted">(you can add walk-ups on the day)</span></span><span class="small muted" id="ath-count" aria-live="polite"></span></div>
        <p class="hint" id="team-hint" hidden></p>
        <div class="tst-tools"><label class="sr-only" for="aq">Find athletes</label><input class="input" id="aq" type="search" placeholder="Find athletes by name or ID" autocomplete="off">
          <button type="button" class="btn btn-sm" id="a-all">Tick all shown</button><button type="button" class="btn btn-ghost btn-sm" id="a-none">Clear</button></div>
        <div class="tst-checks" role="group" aria-labelledby="ath-label">${o.athletes.map((a) => html`<label class="check" data-find="${`${name(a)} ${a.code}`.toLowerCase()}"><input type="checkbox" name="athlete_ids" data-multi value="${a.id}" data-team="${a.team_id || ''}"> ${name(a)}</label>`)}</div>
        <p class="small muted" id="ath-none" hidden style="margin:0">No athlete matches.</p></div>
      <div class="field"><span class="label">Tests</span><span class="hint">Start from a preset, then adjust. Tests run in the order shown below.</span>
        <div class="tst-presets" role="group" aria-label="Presets">${presetNames.map((p) => html`<button type="button" class="btn" data-preset="${p}" aria-pressed="${p === preset}">${p}</button>`)}</div></div>
      <div class="field"><span class="label" id="sel-label">Selected tests <span class="muted" id="count"></span></span>
        <div class="tst-chips" id="chips" role="list" aria-labelledby="sel-label"></div></div>
      <div class="field"><label class="sr-only" for="tq">Find a test</label><input class="input" id="tq" type="search" placeholder="Find a test to add, like broad jump or exit velocity" autocomplete="off" style="max-width:460px"></div>
      <div id="cats">${cats.map((c) => html`<details class="tst-cat" data-cat="${c}"><summary>${c}</summary><div class="tst-checks">
        ${o.tests.filter((t) => t.category === c).map((t) => html`<label class="check" data-find="${t.name.toLowerCase()}"><input type="checkbox" name="test_ids" data-multi value="${t.id}"> ${t.name}</label>`)}</div></details>`)}</div>
      <div class="error" id="err" role="alert"></div>
      <div><button class="btn btn-primary">Start testing day</button></div>
    </form>`);
  const f = ctx.el.querySelector('#f');
  const nameEl = f.querySelector('#n');
  let nameTouched = false, fromDay = null;
  nameEl.addEventListener('input', () => { nameTouched = true; });
  const teamName = () => { const s = f.querySelector('#tm'); return s.value ? o.teams.find((t) => String(t.id) === s.value)?.team_name : ''; };
  const suggestName = () => {
    if (nameTouched) return;
    nameEl.value = fromDay ? `${fromDay.name.replace(/ retest$/i, '')} retest` : [teamName(), preset].filter(Boolean).join(' ') || 'Testing day';
  };
  const athleteBoxes = () => [...f.querySelectorAll('input[name=athlete_ids]')];
  const countAthletes = () => { const n = athleteBoxes().filter((c) => c.checked).length; f.querySelector('#ath-count').textContent = `${plural(n, 'athlete')} selected`; };
  const syncTests = () => {
    f.querySelectorAll('input[name=test_ids]').forEach((c) => { c.checked = selected.has(Number(c.value)); });
    f.querySelectorAll('.tst-cat').forEach((d) => { if ([...d.querySelectorAll('input')].some((c) => c.checked)) d.open = true; });
    f.querySelector('#count').textContent = `(${selected.size})`;
    const chips = f.querySelector('#chips');
    mount(chips, selected.size ? [...selected].map((id, i) => html`<span class="tst-chip" role="listitem"><span class="muted">${i + 1}.</span> ${testById.get(id)?.name || 'Test'}
      <button type="button" data-unpick="${id}" aria-label="Remove ${testById.get(id)?.name || 'test'}">${icon('close', 16)}</button></span>`)
      : html`<span class="small muted">No tests yet. Pick a preset or tick tests below.</span>`);
  };
  syncTests(); countAthletes();
  const setPreset = (p) => {
    preset = p; fromDay = null; selected.clear();
    (o.presets[p] || []).forEach((n) => idByName[n] && selected.add(idByName[n]));
    f.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.preset === p)));
    f.querySelectorAll('.tst-cat').forEach((d) => { d.open = false; });
    const fr = f.querySelector('#from'); if (fr) fr.value = '';
    syncTests(); suggestName();
  };
  f.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
  f.querySelector('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-unpick]'); if (!b) return; selected.delete(Number(b.dataset.unpick)); syncTests(); });
  const applyTeam = (team) => {
    let n = 0;
    athleteBoxes().forEach((c) => {
      const onTeam = team && c.dataset.team === team;
      if (onTeam) n++;
      c.disabled = !!onTeam; if (onTeam) c.checked = true; else if (c.dataset.auto) c.checked = false;
      c.dataset.auto = onTeam ? '1' : '';
    });
    const hint = f.querySelector('#team-hint');
    hint.hidden = !team;
    hint.textContent = team ? `All ${plural(n, 'athlete')} on the team are in. Tick anyone else who's testing with them.` : '';
    countAthletes();
  };
  f.addEventListener('change', (e) => {
    if (e.target.name === 'test_ids') { e.target.checked ? selected.add(Number(e.target.value)) : selected.delete(Number(e.target.value)); syncTests(); }
    if (e.target.name === 'athlete_ids') countAthletes();
    if (e.target.name === 'team_id') { applyTeam(e.target.value); suggestName(); }
  });
  // Filter athletes and tests as you type.
  const filterChecks = (root, term) => { let shown = 0; root.querySelectorAll('[data-find]').forEach((l) => { const hit = !term || l.dataset.find.includes(term); l.hidden = !hit; if (hit) shown++; }); return shown; };
  f.querySelector('#aq').addEventListener('input', (e) => {
    const shown = filterChecks(f.querySelector('[aria-labelledby=ath-label]'), e.target.value.trim().toLowerCase());
    f.querySelector('#ath-none').hidden = shown > 0;
  });
  f.querySelector('#aq').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  f.querySelector('#tq').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  f.querySelector('#a-all').onclick = () => { athleteBoxes().forEach((c) => { if (!c.closest('label').hidden && !c.disabled) c.checked = true; }); countAthletes(); };
  f.querySelector('#a-none').onclick = () => { athleteBoxes().forEach((c) => { if (!c.disabled) c.checked = false; }); countAthletes(); };
  f.querySelector('#tq').addEventListener('input', (e) => {
    const term = e.target.value.trim().toLowerCase();
    f.querySelectorAll('.tst-cat').forEach((d) => {
      const shown = filterChecks(d, term);
      d.hidden = !!term && !shown;
      if (term) d.open = shown > 0; else d.open = [...d.querySelectorAll('input')].some((c) => c.checked);
    });
  });
  // Retest: copy a past day's athletes and tests.
  const loadFrom = async (id) => {
    if (!id) { fromDay = null; suggestName(); return; }
    try {
      const d = await api.get(`/testing/days/${id}`);
      fromDay = d.day; preset = d.day.preset || preset;
      selected.clear(); d.tests.forEach((t) => testById.has(t.id) && selected.add(t.id));
      f.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      const tm = f.querySelector('#tm');
      tm.value = d.day.team_id && o.teams.some((t) => t.id === d.day.team_id) ? String(d.day.team_id) : '';
      const ids = new Set(d.athletes.map((a) => String(a.id)));
      athleteBoxes().forEach((c) => { c.dataset.auto = ''; c.disabled = false; c.checked = ids.has(c.value); });
      applyTeam(tm.value);
      athleteBoxes().forEach((c) => { if (ids.has(c.value)) c.checked = true; });
      countAthletes(); syncTests(); suggestName();
      const skipped = d.tests.length - d.tests.filter((t) => testById.has(t.id)).length;
      const copied = athleteBoxes().filter((c) => ids.has(c.value)).length, archived = ids.size - copied;
      toast(`Copied ${plural(copied, 'athlete')}${archived ? ` (${plural(archived, 'archived athlete')} left out)` : ''} and ${plural(selected.size, 'test')} from ${d.day.name}.${skipped ? ` ${plural(skipped, 'hidden test')} left out.` : ''}`);
    } catch (err) { toastError(err); }
  };
  const fromSel = f.querySelector('#from');
  if (fromSel) {
    fromSel.addEventListener('change', () => loadFrom(fromSel.value));
    if (ctx.query.from && pastDays.some((x) => String(x.id) === String(ctx.query.from))) { fromSel.value = String(ctx.query.from); loadFrom(fromSel.value); }
  }
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('#err'); err.textContent = '';
    const d = formData(f);
    if (!selected.size) { err.textContent = 'Pick at least one test.'; return; }
    if (!d.date) { err.textContent = 'Pick the date.'; return; }
    const athleteIds = athleteBoxes().filter((c) => c.checked).map((c) => c.value);
    const btn = f.querySelector('button.btn-primary'); btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const r = await api.post('/testing/days', { name: d.name, date: d.date, team_id: d.team_id || null, athlete_ids: athleteIds, test_ids: [...selected], preset: fromDay ? fromDay.preset : preset });
      toast('Testing day started.');
      ctx.go(`/app/testing/day/${r.id}`);
    } catch (e2) { err.textContent = e2.message; btn.disabled = false; btn.textContent = 'Start testing day'; }
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
  const prev = new Map(); // `${athlete}|${test}` → best before this day
  const addPrev = (list) => (list || []).forEach((p) => prev.set(`${p.athlete_id}|${p.test_id}`, p.best));
  addPrev(d.prev);
  let current = tests.find((t) => String(t.id) === ctx.query.test) || tests[0];
  let view = ctx.query.view === 'rank' ? 'rank' : 'enter';
  let filter = '';
  const unitSel = {}; const handSel = {}; const extra = {};
  let upId = null;
  let clock = { running: false, start: 0, raf: 0 };
  let last = null; // { aid, tid, attempt, secs } — the last stopwatch time, for Undo
  let unsaved = null; // a stopped time that failed to save, for Save again

  const slots = (t, aid) => {
    let max = Math.max(t.attempts || 1, extra[`${aid}|${t.id}`] || 0);
    for (const k of results.keys()) { const [a, tt, n] = k.split('|').map(Number); if (a === aid && tt === t.id && n > max) max = n; }
    return max;
  };
  const nextEmpty = (t, aid) => { const n = slots(t, aid); for (let i = 1; i <= n; i++) if (!results.has(rk(aid, t.id, i))) return i; return n + 1; };
  const hasEmpty = (t, aid) => nextEmpty(t, aid) <= (t.attempts || 1);
  const valuesFor = (t, aid) => [...results.values()].filter((r) => r.athlete_id === aid && r.test_id === t.id);
  const bestFor = (t, aid) => bestOf(t, valuesFor(t, aid).map((r) => r.value));
  const isPR = (t, aid) => { const b = bestFor(t, aid), p = prev.get(`${aid}|${t.id}`); return b != null && p != null && better(t, b, p); };
  const doneFor = (t) => athletes.filter((a) => valuesFor(t, a.id).length).length;
  const pickUp = (t) => { const a = athletes.find((x) => hasEmpty(t, x.id)) || athletes[0]; upId = a?.id ?? null; };
  const advanceUp = (t) => {
    if (!athletes.length) return;
    const i = athletes.findIndex((a) => a.id === upId);
    for (let k = 1; k <= athletes.length; k++) { const a = athletes[(i + k) % athletes.length]; if (hasEmpty(t, a.id)) { upId = a.id; return; } }
    upId = athletes[(i + 1) % athletes.length].id;
  };

  const shared = day.status === 'shared';
  const onDay = new Set(athletes.map((a) => a.id));
  const subText = () => {
    const total = athletes.length * tests.length;
    const done = tests.reduce((n, t) => n + doneFor(t), 0);
    return `${dayWhen(day.date)} · ${plural(athletes.length, 'athlete')}${day.team_name ? ` · ${day.team_name}` : ''}${total ? ` · ${done} of ${total} results in` : ''}${shared ? ` · shared ${relTime(day.shared_at)}` : ''}`;
  };
  mount(ctx.el, html`${STYLE}
    ${pendingBanner(ctx, d.pending)}
    <div class="page-header tst-dayhead"><div><h1 class="page-title">${day.name}</h1>
      <p class="page-sub" id="sub">${subText()}</p></div>
      <div class="btn-row">
        ${oc ? html`<button class="btn" id="share">${shared ? html`${icon('check')}Shared with parents` : 'Share with parents'}</button>` : ''}
        <a class="btn" href="/api/testing/sheet?day_id=${day.id}&format=xlsx" download>${icon('download')}<span>Download sheet</span></a>
        ${oc ? html`<a class="btn" href="/app/testing/upload?day=${day.id}">${icon('upload')}<span>Upload results</span></a><button class="btn" id="edit">Edit day</button>` : ''}
        <a class="btn btn-ghost" href="/app/testing">All testing days</a>
      </div></div>
    ${shared && oc && day.new_since_share ? html`<div class="banner tst-banner"><span>${day.new_since_share === 1 ? '1 athlete has' : `${day.new_since_share} athletes have`} results added since you shared. Their families haven't been emailed about them.</span><button class="btn btn-outline btn-sm" id="share-new">Email their families</button></div>` : ''}
    ${tests.length ? html`<div class="tst-tabbar"><div class="tst-tabs" role="tablist" aria-label="Tests" id="tabs"></div>
        ${oc ? html`<button class="btn btn-ghost tst-addtest" id="addtest" aria-label="Add a test to this day">${icon('plus')}<span class="tst-hide-sm">Add test</span></button>` : ''}</div>
      <section class="panel tst-watchp" id="watch" hidden aria-label="Stopwatch"></section>
      <section class="panel" id="sheet" role="tabpanel"></section>`
    : html`<div class="empty">This testing day has no tests. ${oc ? html`<button class="btn" id="addtest">${icon('plus')}Add test</button>` : ''}</div>`}
  `);
  const shareBtn = ctx.el.querySelector('#share');
  if (shareBtn) shareBtn.onclick = () => shareModal(ctx, day);
  ctx.el.querySelector('#share-new')?.addEventListener('click', () => shareModal(ctx, day));
  ctx.el.querySelector('#edit')?.addEventListener('click', () => { if (clock.running) { toast('Stop the clock first.', 'warn'); return; } editDayModal(ctx, day, tests, results.size); });
  ctx.el.querySelector('#addtest')?.addEventListener('click', addTest);
  async function addTest() {
    if (clock.running) { toast('Stop the clock first.', 'warn'); return; }
    const onDayTests = new Set(tests.map((t) => t.id));
    const avail = opts.tests.filter((t) => !onDayTests.has(t.id));
    const cats = [...new Set(avail.map((t) => t.category))].sort(catSort);
    const r = await modal({
      title: 'Add a test to this day',
      body: html`<div class="field"><label class="label" for="at">Test</label><select class="input" id="at"><option value="">Choose a test…</option>
        ${cats.map((c) => html`<optgroup label="${c}">${avail.filter((t) => t.category === c).map((t) => html`<option value="${t.id}">${t.name} (${t.unit})</option>`)}</optgroup>`)}</select>
        <span class="hint">It goes at the end of the tabs. Hidden tests don't show here; show them in the Test library first.</span></div>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Add test', kind: 'primary', onClick: async (body) => {
        const id = body.querySelector('#at').value;
        if (!id) { toast('Choose a test to add.', 'warn'); return false; }
        return api.post(`/testing/days/${day.id}/tests`, { test_id: Number(id) });
      } }],
    });
    if (!r) return;
    toast(`${r.test.name} added.`);
    if (!tests.length) { ctx.go(`/app/testing/day/${day.id}?test=${r.test.id}`); return; }
    tests.push(r.test); addPrev(r.prev);
    current = r.test; syncUrl(); pickUp(current); drawAll();
  }
  if (!tests.length) return;

  const tabsEl = ctx.el.querySelector('#tabs'), watchEl = ctx.el.querySelector('#watch'), sheetEl = ctx.el.querySelector('#sheet');
  const syncUrl = () => history.replaceState(history.state, '', `${location.pathname}?test=${current.id}${view === 'rank' ? '&view=rank' : ''}`);
  function drawHead() {
    ctx.el.querySelector('#sub').textContent = subText();
    // One green button per view: Start owns it on timed tests; otherwise Share does, until the day is shared.
    if (shareBtn) shareBtn.classList.toggle('btn-primary', !shared && !current.timed);
  }
  function drawTabs() {
    mount(tabsEl, tests.map((t) => {
      const n = doneFor(t), all = athletes.length && n === athletes.length;
      return html`<button class="btn" role="tab" id="tab-${t.id}" aria-controls="sheet" data-test="${t.id}" aria-selected="${t.id === current.id}" tabindex="${t.id === current.id ? 0 : -1}">${t.name}
        <span class="tst-count ${all ? 'done' : ''}" aria-label="${n} of ${athletes.length} done">${all ? icon('check', 14) : `${n}/${athletes.length}`}</span></button>`;
    }));
    sheetEl.setAttribute('aria-labelledby', `tab-${current.id}`);
  }
  const switchTo = (id, focus) => {
    if (clock.running) { toast('Stop the clock before switching tests.', 'warn'); return; }
    current = tests.find((t) => t.id === id) || current;
    syncUrl(); pickUp(current); drawAll();
    if (focus) tabsEl.querySelector(`[data-test="${current.id}"]`)?.focus();
  };
  tabsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-test]'); if (b) switchTo(Number(b.dataset.test)); });
  tabsEl.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = tests.findIndex((t) => t.id === current.id);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? tests.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tests.length) % tests.length;
    switchTo(tests[j].id, true);
  });

  function drawWatch() {
    const t = current;
    watchEl.hidden = !t.timed;
    if (!t.timed) return;
    const up = athletes.find((a) => a.id === upId);
    const lastA = last && athletes.find((a) => a.id === last.aid);
    mount(watchEl, html`<div class="tst-watchhead"><h2 class="panel-title">Stopwatch</h2>
      <p class="panel-sub" id="up-line">${up ? html`Up: <strong>${name(up)}</strong>, attempt ${nextEmpty(t, up.id)}.<span class="tst-hide-sm"> Tap Time next to anyone to switch. Stopping the clock saves the time and moves to the next athlete.</span>` : 'Add an athlete to start timing.'}</p></div>
      <div class="tst-watch">
        <div class="tst-clock" id="clock" aria-live="off">0.00</div>
        <button class="btn btn-primary btn-lg" id="sw" ${up ? '' : raw('disabled')}>Start</button>
        <button class="btn btn-ghost" id="sw-cancel" hidden>Cancel run</button>
        <p class="tst-note tst-hide-sm" style="flex:1;min-width:220px">Hand times usually read faster than electronic gates, so the app keeps them labeled. Space bar starts and stops; Esc cancels a false start.</p>
      </div>
      ${unsaved ? html`<div class="tst-last warn-text"><span>${unsaved.secs.toFixed(2)} s for ${name(athletes.find((a) => a.id === unsaved.aid) || { first_name: 'this', last_name: 'athlete' })} didn't save.${unsaved.error ? ` ${unsaved.error}` : ''}</span>${unsaved.impossible ? '' : html`<button class="btn btn-sm" id="sw-retry">Save again</button>`}<button class="btn btn-ghost btn-sm" id="sw-drop">Discard</button></div>`
      : lastA && last.tid === t.id ? html`<div class="tst-last"><span class="muted">Last: ${name(lastA)}, attempt ${last.attempt}, ${last.secs.toFixed(2)} s</span><button class="btn btn-ghost btn-sm" id="sw-undo">Undo</button></div>` : ''}`);
    watchEl.querySelector('#sw').onclick = toggleClock;
    watchEl.querySelector('#sw-cancel').onclick = cancelClock;
    watchEl.querySelector('#sw-undo')?.addEventListener('click', undoLast);
    watchEl.querySelector('#sw-retry')?.addEventListener('click', async () => { const u = unsaved; unsaved = null; await saveTime(u.tid, u.aid, u.secs); });
    watchEl.querySelector('#sw-drop')?.addEventListener('click', () => { unsaved = null; drawWatch(); });
  }
  function tick() {
    const el = watchEl.querySelector('#clock');
    if (!clock.running || !el || !document.body.contains(watchEl)) return;
    el.textContent = ((performance.now() - clock.start) / 1000).toFixed(2);
    clock.raf = requestAnimationFrame(tick);
  }
  const setRunning = (on) => {
    const btn = watchEl.querySelector('#sw'), el = watchEl.querySelector('#clock');
    btn.textContent = on ? 'Stop' : 'Start';
    btn.classList.toggle('btn-primary', !on); btn.classList.toggle('btn-warn', on);
    el.classList.toggle('running', on);
    watchEl.querySelector('#sw-cancel').hidden = !on;
  };
  function cancelClock() {
    if (!clock.running) return;
    cancelAnimationFrame(clock.raf); clock.running = false;
    setRunning(false); watchEl.querySelector('#clock').textContent = '0.00';
    toast('Run canceled. Nothing was saved.');
  }
  async function toggleClock() {
    if (!clock.running) {
      if (!upId) return;
      unsaved = null;
      clock = { running: true, start: performance.now(), raf: 0 };
      setRunning(true); tick();
      return;
    }
    const secs = Math.round(((performance.now() - clock.start) / 1000) * 100) / 100;
    cancelAnimationFrame(clock.raf); clock.running = false;
    setRunning(false); watchEl.querySelector('#clock').textContent = secs.toFixed(2);
    await saveTime(current.id, upId, secs);
  }
  async function saveTime(tid, aid, secs) {
    const t = tests.find((x) => x.id === tid), attempt = nextEmpty(t, aid);
    if (outOfRange(t, secs)) {
      // A slip of the thumb: don't send an impossible time, just offer to discard it.
      unsaved = { aid, tid, secs, error: `That's outside what's possible for ${t.name} (${rangeText(t)}).`, impossible: true };
      drawWatch(); const c = watchEl.querySelector('#clock'); if (c) c.textContent = secs.toFixed(2);
      return;
    }
    const ok = await save(t, aid, attempt, secs, { source: 'stopwatch', unit: 's' });
    if (ok) { last = { aid, tid, attempt, secs }; if (current.id === tid) advanceUp(t); }
    else unsaved = { aid, tid, secs, error: saveError };
    drawWatch(); if (ok || unsaved) { const c = watchEl.querySelector('#clock'); if (c) c.textContent = secs.toFixed(2); }
    drawSheet(); drawTabs(); drawHead();
  }
  async function undoLast() {
    if (!last || clock.running) return;
    const t = tests.find((x) => x.id === last.tid), a = athletes.find((x) => x.id === last.aid);
    const key = rk(last.aid, last.tid, last.attempt);
    try {
      await api.put(`/testing/days/${day.id}/results`, { athlete_id: last.aid, test_id: last.tid, attempt: last.attempt, value: '' });
      results.delete(key); lastSent.delete(key);
      upId = last.aid;
      toast(`Removed ${last.secs.toFixed(2)} s for ${name(a)}. ${a.first_name} is up again.`);
      last = null;
      if (current.id === t.id) { drawWatch(); drawSheet(); } drawTabs(); drawHead();
    } catch (err) { toastError(err); }
  }
  const onKey = (e) => {
    if (!document.body.contains(watchEl)) { document.removeEventListener('keydown', onKey); return; }
    if (!current.timed || document.querySelector('.modal-back')) return;
    if (e.key === 'Escape' && clock.running) { e.preventDefault(); cancelClock(); return; }
    if (e.code !== 'Space' || e.target.closest('input,textarea,select,button,a')) return;
    e.preventDefault(); toggleClock();
  };
  document.addEventListener('keydown', onKey);

  const rowBest = (t, aid) => {
    const best = bestFor(t, aid);
    const anyHand = t.unit === 's' && valuesFor(t, aid).some((x) => x.hand_timed);
    return html`${best != null ? html`<div>${fmtValue(best, t.unit)}</div>` : ''}${isPR(t, aid) ? html`<span class="badge badge-good">PR</span>` : ''}${anyHand ? html`<div class="tst-tag">hand-timed</div>` : ''}`;
  };
  const prevLine = (t, aid) => { const p = prev.get(`${aid}|${t.id}`); return p != null ? `Previous best ${fmtValue(p, t.unit)}` : 'No previous result'; };
  const matches = (a) => !filter || `${name(a)} ${a.code}`.toLowerCase().includes(filter);

  function drawSheet() {
    const t = current;
    const unit = unitSel[t.id] || t.unit;
    if (handSel[t.id] == null) handSel[t.id] = !!t.timed;
    const units = unitsFor(t.unit);
    const walkups = opts.athletes.filter((a) => !onDay.has(a.id));
    const show = (v) => { if (v == null) return ''; const x = convert(v, t.unit, unit); return unit === 's' ? fmtNumber(x, 's') : String(Number(x.toFixed(2))); };
    const entryHint = unit === 'in' ? ' Feet and inches work too, like 6\'5".' : unit === 's' && !t.timed ? ' Minutes work too, like 1:05.3.' : '';
    const shownAthletes = athletes.filter(matches);
    mount(sheetEl, html`<div class="panel-head"><div><h2 class="panel-title">${t.name}</h2>
        <p class="panel-sub">${t.unit} · ${scoring(t)} · ${plural(t.attempts || 1, 'attempt')}. ${view === 'enter' ? `Values save as you type; Enter moves down.${entryHint}` : 'Best result today, fastest or furthest first.'}${rangeText(t) ? ` Possible range ${rangeText(t)}.` : ''}</p></div>
      <div class="tst-kit">
        <div class="seg" role="group" aria-label="View"><button type="button" data-view="enter" aria-pressed="${view === 'enter'}">Enter results</button><button type="button" data-view="rank" aria-pressed="${view === 'rank'}">Rankings</button></div>
        ${view === 'enter' && t.unit === 's' ? html`<label class="check tst-handchk"><input type="checkbox" id="hand" ${handSel[t.id] ? raw('checked') : ''}> Hand-timed</label>` : ''}
        ${view === 'enter' && units.length > 1 ? html`<label class="sr-only" for="unit">Unit</label><select class="input" id="unit">${units.map((u) => html`<option ${u === unit ? raw('selected') : ''}>${u}</option>`)}</select>` : ''}
      </div></div>
      ${athletes.length > 8 ? html`<div><label class="sr-only" for="afind">Find an athlete</label><input class="input" id="afind" type="search" placeholder="Find an athlete by name or ID" value="${filter}" autocomplete="off" style="max-width:360px"></div>` : ''}
      ${view === 'rank' ? rankings(t) : html`<div class="tst-rows">${shownAthletes.map((a) => {
        const n = slots(t, a.id);
        return html`<div class="tst-row ${t.timed ? '' : 'no-watch'} ${oc ? 'can-rm' : ''} ${t.timed && a.id === upId ? 'up' : ''}" data-a="${a.id}">
          ${t.timed ? html`<button class="btn tst-up" data-up="${a.id}" aria-pressed="${a.id === upId}" aria-label="${a.id === upId ? `${name(a)} is up` : `Time ${name(a)} next`}">${a.id === upId ? 'Up' : 'Time'}</button>` : ''}
          <div style="min-width:0"><div class="strong">${name(a)}</div><div class="small muted"><span class="mono">${a.code}</span> · ${prevLine(t, a.id)}</div></div>
          <div class="tst-atts">${Array.from({ length: n }, (_, i) => html`<input class="input tst-att" inputmode="decimal" enterkeyhint="next" autocomplete="off" data-att="${i + 1}"
            aria-label="${name(a)}, ${t.name}, attempt ${i + 1}" placeholder="#${i + 1}" value="${show(results.get(rk(a.id, t.id, i + 1))?.value)}">`)}
            ${n < MAX_ATTEMPTS ? html`<button type="button" class="btn btn-ghost tst-more" data-more="${a.id}" aria-label="Add another attempt for ${name(a)}" title="Add another attempt">${icon('plus', 16)}</button>` : ''}</div>
          <div class="tst-best">${rowBest(t, a.id)}</div>
          ${oc ? html`<button type="button" class="btn btn-ghost tst-rm" data-rm="${a.id}" aria-label="Remove ${name(a)} from this day" title="Remove from this day">${icon('close', 16)}</button>` : ''}
          <div class="tst-rowmsg small warn-text" hidden></div>
        </div>`;
      })}</div>
      ${athletes.length && !shownAthletes.length ? html`<div class="empty">No athlete on this day matches "${filter}".</div>` : ''}`}
      ${athletes.length ? '' : html`<div class="empty">No athletes yet. Add a walk-up below.</div>`}
      <div class="row"><label class="sr-only" for="walk">Add a walk-up athlete</label>
        <select class="input" id="walk" style="max-width:320px"><option value="">${walkups.length ? 'Add a walk-up athlete…' : 'Every athlete is already on this day'}</option>${walkups.map((a) => html`<option value="${a.id}">${name(a)} (${a.code})</option>`)}</select></div>`);
    sheetEl.querySelector('#unit')?.addEventListener('change', (e) => { unitSel[t.id] = e.target.value; drawSheet(); });
    sheetEl.querySelector('#hand')?.addEventListener('change', (e) => { handSel[t.id] = e.target.checked; });
    sheetEl.querySelector('#afind')?.addEventListener('input', debounce((e) => {
      filter = e.target.value.trim().toLowerCase();
      const pos = e.target.selectionStart; drawSheet();
      const i = sheetEl.querySelector('#afind'); if (i) { i.focus(); i.setSelectionRange(pos, pos); }
    }, 150));
    sheetEl.querySelector('#walk').addEventListener('change', async (e) => {
      const id = Number(e.target.value); if (!id) return;
      try {
        const a = await api.post(`/testing/days/${day.id}/athletes`, { athlete_id: id });
        if (!onDay.has(a.id)) { athletes.push({ id: a.id, code: a.code, first_name: a.first_name, last_name: a.last_name }); onDay.add(a.id); }
        addPrev(a.prev);
        if (!upId) upId = a.id;
        toast(`${name(a)} added.`);
        drawWatch(); drawSheet(); drawTabs(); drawHead();
      } catch (err) { toastError(err); }
    });
  }

  function rankings(t) {
    const ranked = athletes.map((a) => ({ a, best: bestFor(t, a.id), prev: prev.get(`${a.id}|${t.id}`) })).filter((x) => x.best != null && matches(x.a))
      .sort((x, y) => (better(t, x.best, y.best) ? -1 : better(t, y.best, x.best) ? 1 : name(x.a).localeCompare(name(y.a))));
    const missing = athletes.filter((a) => bestFor(t, a.id) == null && matches(a));
    let rank = 0, lastVal = null;
    return html`${ranked.length ? html`<ol class="tst-rank">${ranked.map((x, i) => {
      if (x.best !== lastVal) { rank = i + 1; lastVal = x.best; }
      const change = x.prev != null ? x.best - x.prev : null;
      const improved = x.prev != null && better(t, x.best, x.prev);
      return html`<li class="tst-rankrow"><span class="tst-rankno">${rank}</span>
        <div style="min-width:0"><div class="strong">${name(x.a)}</div><div class="small muted">${x.prev != null ? `Previous best ${fmtValue(x.prev, t.unit)}` : 'No previous result'}</div></div>
        <span class="small ${improved ? 'good-text' : 'muted'} tst-hide-sm">${change != null && change !== 0 ? fmtChange(Math.round(change * 100) / 100, t.unit) : ''}</span>
        <span class="tst-best">${fmtValue(x.best, t.unit)}${improved ? html` <span class="badge badge-good">PR</span>` : ''}</span></li>`;
    })}</ol>` : html`<div class="empty">No results for ${t.name} yet.</div>`}
    ${missing.length ? html`<p class="small muted" style="margin:0">No result yet: ${missing.map(name).join(', ')}.</p>` : ''}`;
  }

  sheetEl.addEventListener('click', async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { view = v.dataset.view; syncUrl(); drawSheet(); return; }
    const b = e.target.closest('[data-up]');
    if (b) { if (clock.running) { toast('Stop the clock before switching athletes.', 'warn'); return; } upId = Number(b.dataset.up); unsaved = null; drawWatch(); drawSheet(); return; }
    const m = e.target.closest('[data-more]');
    if (m) {
      const aid = Number(m.dataset.more), k = `${aid}|${current.id}`;
      extra[k] = Math.min(MAX_ATTEMPTS, slots(current, aid) + 1); drawSheet();
      sheetEl.querySelector(`[data-a="${aid}"] [data-att="${extra[k]}"]`)?.focus();
      return;
    }
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const aid = Number(rm.dataset.rm), a = athletes.find((x) => x.id === aid);
      const n = [...results.values()].filter((r) => r.athlete_id === aid).length;
      if (clock.running && upId === aid) { toast('Stop the clock first.', 'warn'); return; }
      const ok = await confirmDialog(`Remove ${name(a)}`, n ? `${a.first_name} has ${plural(n, 'result')} on this day. Removing ${a.first_name} deletes them from this day and their profile.` : `Take ${a.first_name} off this day? You can add them back as a walk-up.`, n ? `Remove and delete ${plural(n, 'result')}` : 'Remove', 'warn');
      if (!ok) return;
      try {
        await api.del(`/testing/days/${day.id}/athletes/${aid}${n ? '?confirm=1' : ''}`);
        athletes.splice(athletes.indexOf(a), 1); onDay.delete(aid);
        for (const k of [...results.keys()]) if (k.startsWith(`${aid}|`)) results.delete(k);
        if (last?.aid === aid) last = null;
        if (upId === aid) pickUp(current);
        toast(`${name(a)} removed from ${day.name}.`);
        drawAll();
      } catch (err) { toastError(err); }
    }
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
      if (outOfRange(t, base)) warn = `${inp.value} ${unit} is outside what's possible for ${t.name} (${rangeText(t)}). It won't be saved.`;
    }
    inp.setAttribute('aria-invalid', warn ? 'true' : 'false');
    msg.hidden = !warn; msg.textContent = warn;
    const k = `${aid}|${att}`;
    clearTimeout(timers.get(k));
    if (warn) return;
    timers.set(k, setTimeout(() => { timers.delete(k); save(t, aid, att, inp.value, { unit, input: inp }); }, 700));
  });
  // Enter or arrow keys move down or up the same attempt column, like a spreadsheet.
  sheetEl.addEventListener('keydown', (e) => {
    const inp = e.target.closest('.tst-att'); if (!inp) return;
    if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const rows = [...sheetEl.querySelectorAll('.tst-row')];
    const i = rows.indexOf(inp.closest('.tst-row'));
    const next = rows[i + (e.key === 'ArrowUp' ? -1 : 1)];
    const target = next?.querySelector(`[data-att="${inp.dataset.att}"]`) || next?.querySelector('.tst-att');
    if (target) { target.focus(); target.select(); } else inp.blur();
  });
  sheetEl.addEventListener('focusout', (e) => {
    const inp = e.target.closest('.tst-att'); if (!inp) return;
    const row = inp.closest('[data-a]');
    const k = `${row.dataset.a}|${inp.dataset.att}`;
    if (timers.has(k)) { clearTimeout(timers.get(k)); timers.delete(k); if (inp.getAttribute('aria-invalid') !== 'true') save(current, Number(row.dataset.a), Number(inp.dataset.att), inp.value, { unit: unitSel[current.id] || current.unit, input: inp }); }
  });

  const lastSent = new Map();
  let saveError = '';
  async function save(t, aid, attempt, value, { source, unit, input } = {}) {
    const key = rk(aid, t.id, attempt), sig = `${value}|${unit}`;
    if (source !== 'stopwatch' && lastSent.get(key) === sig) return true;
    if (source === 'stopwatch') lastSent.delete(key); else lastSent.set(key, sig);
    try {
      const r = await api.put(`/testing/days/${day.id}/results`, { athlete_id: aid, test_id: t.id, attempt, value, unit, source, hand_timed: source === 'stopwatch' || !!handSel[t.id] });
      if (r.cleared) results.delete(key); else results.set(key, r.result);
      const a = athletes.find((x) => x.id === aid);
      if (r.pr) toast(`New PR: ${name(a)}, ${t.name} ${r.display}. Previous best ${fmtValue(r.prev_best, t.unit)}.`);
      else if (source === 'stopwatch') toast(`${name(a)}: ${r.display}, hand-timed.`);
      if (input) {
        const row = input.closest('[data-a]');
        const bestEl = row?.querySelector('.tst-best');
        if (bestEl) mount(bestEl, rowBest(t, aid));
        const m = row?.querySelector('.tst-rowmsg'); if (m && input.getAttribute('aria-invalid') === 'true') { m.hidden = true; input.setAttribute('aria-invalid', 'false'); }
        drawTabs(); drawHead();
        if (current.timed && !clock.running) drawWatchLine();
      }
      return true;
    } catch (err) {
      lastSent.delete(key);
      if (input) { input.setAttribute('aria-invalid', 'true'); const m = input.closest('[data-a]')?.querySelector('.tst-rowmsg'); if (m) { m.hidden = false; m.textContent = err.message; } }
      else { saveError = err.message; toastError(err); }
      return false;
    }
  }
  // Keep the "Up: … attempt N" line honest after typed entries without redrawing the clock.
  function drawWatchLine() {
    const up = athletes.find((a) => a.id === upId), el = watchEl.querySelector('#up-line');
    if (up && el) { const s = el.querySelector('strong'); if (s && s.nextSibling) s.nextSibling.textContent = `, attempt ${nextEmpty(current, up.id)}.`; }
  }
  function drawAll() { drawTabs(); drawWatch(); drawSheet(); drawHead(); }

  pickUp(current); drawAll();
}

async function editDayModal(ctx, day, tests, resultCount) {
  const owner = ctx.me.role === 'owner';
  const canDelete = day.status !== 'shared' || owner;
  const r = await modal({
    title: 'Edit testing day',
    body: html`<form class="stack" id="ed" novalidate>
      <div class="form-grid">
        <div class="field"><label class="label" for="ed-n">Name</label><input class="input" id="ed-n" name="name" value="${day.name}" maxlength="120" required></div>
        <div class="field"><label class="label" for="ed-d">Date</label><input class="input" id="ed-d" name="date" type="date" value="${day.date}" required></div>
      </div></form>
      <details class="tst-cat"><summary>Tests on this day (${tests.length})</summary>
        <div class="list tst-edtests">${tests.map((t) => html`<div class="list-row"><span class="grow">${t.name}</span>
          ${tests.length > 1 ? html`<button type="button" class="btn btn-ghost btn-sm" data-rmtest="${t.id}">Remove</button>` : ''}</div>`)}</div>
        <span class="hint">Removing a test also deletes its results from this day.</span></details>
      <div class="tst-edfoot">
        <a class="btn btn-ghost" href="/app/testing/new?from=${day.id}">Retest these athletes</a>
        ${canDelete ? html`<button type="button" class="btn btn-ghost warn-text" id="ed-del">Delete testing day</button>`
          : html`<span class="small muted">Only the owner can delete a shared testing day.</span>`}
      </div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Save changes', kind: 'primary', onClick: async (body) => api.patch(`/testing/days/${day.id}`, formData(body.querySelector('#ed'))) }],
    onMount: (body, close) => {
      body.querySelector('a[href^="/app/testing/new"]').addEventListener('click', () => close(null));
      body.querySelectorAll('[data-rmtest]').forEach((b) => b.addEventListener('click', async () => {
        const t = tests.find((x) => x.id === Number(b.dataset.rmtest));
        close(null);
        try {
          await api.del(`/testing/days/${day.id}/tests/${t.id}`);
          toast(`${t.name} removed from ${day.name}.`); ctx.reload();
        } catch (err) {
          if (!err.data?.results) { toastError(err); return; }
          if (!(await confirmDialog(`Remove ${t.name}`, err.message, `Remove and delete ${plural(err.data.results, 'result')}`, 'warn'))) return;
          try { await api.del(`/testing/days/${day.id}/tests/${t.id}?confirm=1`); toast(`${t.name} removed from ${day.name}.`); ctx.reload(); } catch (e2) { toastError(e2); }
        }
      }));
      body.querySelector('#ed-del')?.addEventListener('click', async () => {
        close(null);
        const ok = await confirmDialog('Delete testing day', resultCount
          ? `Delete ${day.name} and its ${plural(resultCount, 'result')}? They come out of every athlete's profile${day.status === 'shared' ? ' and the parent portal' : ''}. This can't be undone.`
          : `Delete ${day.name}? It has no results yet.`, resultCount ? `Delete day and ${plural(resultCount, 'result')}` : 'Delete testing day', 'warn');
        if (!ok) return;
        try { await api.del(`/testing/days/${day.id}${resultCount ? '?confirm=1' : ''}`); toast(`${day.name} deleted.`); ctx.go('/app/testing'); } catch (err) { toastError(err); }
      });
    },
  });
  if (r) { toast('Testing day saved.'); ctx.reload(); }
}

async function shareModal(ctx, day) {
  let p;
  try { p = await api.get(`/testing/days/${day.id}/share-preview`); } catch (err) { toastError(err); return; }
  const shared = p.status === 'shared';
  const fresh = shared ? p.new_since_share : [];
  const names = (list) => (list.length > 6 ? `${list.slice(0, 6).join(', ')} and ${list.length - 6} more` : list.join(', '));
  const actions = [{ label: 'Cancel', value: null }];
  if (shared) {
    actions.push({ label: 'Save note', kind: fresh.length ? '' : 'primary', onClick: async (body) => api.post(`/testing/days/${day.id}/share`, { note: body.querySelector('#note').value }) });
    if (fresh.length) actions.push({ label: p.new_families ? `Save and email ${plural(p.new_families, 'family', 'families')}` : 'Save and mark as shared', kind: 'primary', onClick: async (body) => api.post(`/testing/days/${day.id}/share`, { note: body.querySelector('#note').value, only_new: true }) });
  } else if (!p.with_results) {
    await modal({ title: 'Share with parents', body: html`<p style="margin:0">Nobody on ${day.name} has a result yet. Enter some results first, then share them with families.</p>` });
    return;
  } else {
    actions.push({ label: p.emails ? `Share and email ${plural(p.families, 'family', 'families')}` : 'Share', kind: 'primary', onClick: async (body) => api.post(`/testing/days/${day.id}/share`, { note: body.querySelector('#note').value }) });
  }
  const r = await modal({
    title: shared ? 'Shared with parents' : 'Share with parents',
    body: html`${shared ? html`<p style="margin:0" class="muted">Families have had these results since ${fmtDate(p.shared_at)}. Changing the note updates their Progress tab and report without a new email.</p>
        ${fresh.length ? html`<div class="banner"><span>New since you shared: ${names(fresh)}. ${p.new_families ? `Email ${p.new_families === 1 ? 'that family' : 'those families'} their results.` : 'No parent email is on file, so nobody is emailed. Their results still show in the portal.'}</span></div>` : ''}`
      : html`<p style="margin:0">${p.with_results} of ${plural(p.athletes, 'athlete')} have results. ${p.emails ? `${plural(p.emails, 'parent')} in ${plural(p.families, 'family', 'families')} get an email with their athlete's results and a link to the parent portal.` : 'No parent emails are on file for these athletes, so nobody is emailed.'} Results show on each family's Progress tab.</p>
        ${p.without_results.length ? html`<p class="small warn-text" style="margin:0">No results yet for ${names(p.without_results)}. They're left out of the email.</p>` : ''}
        ${p.no_email.length ? html`<p class="small warn-text" style="margin:0">No parent email on file for ${names(p.no_email)}. Their results still show in the portal.</p>` : ''}`}
      <div class="field"><label class="label" for="note">Note to families (optional)</label>
      <textarea class="input" id="note" maxlength="2000" rows="4" placeholder="What stood out, and what to work on before the next test.">${day.note || ''}</textarea></div>`,
    actions,
  });
  if (!r) return;
  toast(r.updated ? 'Note saved.' : r.again ? (r.emails ? `${plural(r.emails, 'family email')} sent about the new results.` : 'Marked as shared. No family emails were sent.') : `Shared. ${plural(r.emails, 'family email')} sent.`);
  ctx.reload();
}

// ============ Upload results ============
const UP_STYLE = raw(`<style>
.tst-drop{display:flex;align-items:center;gap:14px;min-height:72px;padding:14px 16px;border:1px dashed var(--control-border);border-radius:var(--radius-md);background:var(--surface);cursor:pointer;color:var(--steel-muted)}
.tst-drop:hover,.tst-drop.over,.tst-drop:focus-within{border-color:var(--green-mid);color:var(--steel)}
.tst-drop.over{background:var(--green-deep)}
.tst-drop strong{color:var(--steel)}
.tst-file{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;padding:8px 8px 8px 16px;border:1px solid var(--green-mid);border-radius:var(--radius-md);background:var(--green-deep);color:var(--green-soft)}
.tst-file .btn{min-height:44px}
.tst-sum{display:flex;flex-wrap:wrap;gap:8px}
.tst-up-tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.tst-up-tools .input{flex:1;min-width:180px}
.tst-up-tools .seg button{min-height:44px}
.tst-was{font-size:13px;color:var(--steel-muted);white-space:nowrap}
.tst-vals{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.tst-recent .list-row{padding:12px 0;align-items:center}
.tst-recent .btn,.tst-q .btn-sm,.tst-links .btn-sm,.tst-rej .btn,.tst-hk .btn{min-height:44px}
.tst-qrows{display:flex;flex-direction:column;border-top:1px solid var(--line)}
.tst-qrow{display:grid;grid-template-columns:44px minmax(0,1fr) auto auto;gap:10px;align-items:center;min-height:52px;padding:4px 0;border-bottom:1px solid var(--line);cursor:pointer}
.tst-qrow input{width:22px;height:22px;justify-self:center;accent-color:var(--green-mid)}
.tst-qrow .strong{white-space:nowrap}
.tst-qhead{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.tst-qhead .btn{min-height:44px}
.tst-lrow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}
.tst-lrow:first-child{border-top:0}
.tst-lrow .btn-row{flex-wrap:nowrap}
.tst-copy{position:relative}
.tst-copy .btn{position:absolute;top:8px;right:8px;min-height:44px}
.tst-copy .tst-pre{padding-top:60px}
@media (max-width:700px){
  .tst-probs thead{display:none}
  .tst-probs tr{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;padding:12px 0;border-bottom:1px solid var(--line)}
  .tst-probs td{border:0;padding:0}
  .tst-probs td.p-fix{grid-column:1/-1}
  .tst-probs td.p-row::before{content:'Row '}
  .tst-probs td.p-ath{grid-column:1/-1;font-size:13px}
  .tst-qrow{grid-template-columns:44px minmax(0,1fr) auto}
  .tst-qrow .q-date{grid-column:2/-1;font-size:13px;margin-top:-6px}
  .tst-lrow{grid-template-columns:minmax(0,1fr) auto}
  .tst-lrow .l-who{grid-column:1/-1;order:3}
  .tst-drop{min-height:64px}
}
</style>`);
const SOURCE_CHOICES = ['OVR', 'VALD', 'Swift', 'Freelap', 'Hawkin', 'Brower', 'Dashr', 'Rapsodo'];
const MAX_UPLOAD = 3.5 * 1024 * 1024;
const shortDate = (d) => fmtDate(d, { year: String(d || '').slice(0, 4) !== String(new Date().getFullYear()) });
function csvDownload(rows, filename) {
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob(['﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
// Type-ahead athlete search: calls onPick(athlete). Enter picks the first match, arrow keys move through the list.
function bindPicker(input, box, onPick) {
  let list = [];
  const draw = () => {
    mount(box, list.length ? list.map((a, i) => html`<button type="button" data-sg="${i}"><span>${name(a)}</span><span class="mono small muted">${a.code}</span></button>`)
      : html`<div class="small muted" style="padding:10px 12px">No athlete matches. Try part of the name or the Athlete ID.</div>`);
    box.hidden = false;
  };
  const search = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 2) { box.hidden = true; list = []; return; }
    list = await api.get(`/athletes/search?q=${encodeURIComponent(term)}`).catch(() => []);
    if (input.value.trim() === term) draw();
  }, 180);
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (list[0] && !box.hidden) onPick(list[0]); }
    else if (e.key === 'ArrowDown' && !box.hidden) { e.preventDefault(); box.querySelector('button')?.focus(); }
    else if (e.key === 'Escape') box.hidden = true;
  });
  box.addEventListener('keydown', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); (b.nextElementSibling || b).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (b.previousElementSibling || input).focus(); }
    else if (e.key === 'Escape') { box.hidden = true; input.focus(); }
  });
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-sg]'); if (b) { e.stopPropagation(); onPick(list[Number(b.dataset.sg)]); } });
}
// A modal to pick an athlete; resolves with the athlete or null.
function pickAthleteModal(title, intro) {
  let picked = null;
  return modal({
    title,
    body: html`${intro ? html`<p style="margin:0">${intro}</p>` : ''}<div class="tst-picker"><label class="label" for="pk-q">Athlete</label><input class="input" id="pk-q" autocomplete="off" placeholder="Type a name or Athlete ID"><div class="tst-sugg" hidden></div></div>`,
    actions: [{ label: 'Cancel', value: null }],
    onMount: (body, close) => bindPicker(body.querySelector('#pk-q'), body.querySelector('.tst-sugg'), (a) => { picked = a; close(picked); }),
  });
}

async function renderUpload(ctx) {
  const [o, recent] = await Promise.all([api.get('/testing/options'), api.get('/testing/uploads').catch(() => [])]);
  if (!ctx.isCurrent()) return;
  const state = { payload: null, filename: '', file: null, text: '', day: ctx.query.day || '', date: localISO(), test: '', source: '', check: null, confirmed: new Set(), show: 'all', term: '', recent };
  const dayOpts = (sel) => html`<option value="">No testing day</option>${o.days.map((d) => html`<option value="${d.id}" ${String(d.id) === String(sel ?? '') ? raw('selected') : ''}>${d.name} (${fmtDate(d.date)})</option>`)}`;
  mount(ctx.el, html`${STYLE}${UP_STYLE}
    ${header('Upload results', 'All or nothing: a sheet is saved only when every row matches a real Athlete ID and every value fits its test.', back())}
    <div id="stage" class="stack"></div>`);
  const stage = ctx.el.querySelector('#stage');
  const top = () => window.scrollTo(0, 0);

  async function readFile(file) {
    if (file.size > MAX_UPLOAD) throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB. Upload files up to 3.5 MB, or split the sheet in two.`);
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  // Check the current file or pasted rows with the current options. Shows the rejected or review stage.
  async function runCheck(btn, errEl) {
    if (errEl) errEl.textContent = '';
    try {
      if (state.file) { state.payload = { file_base64: await readFile(state.file) }; state.filename = state.file.name; }
      else if (state.text.trim()) { state.payload = { text: state.text }; state.filename = 'the pasted rows'; }
      else { if (errEl) errEl.textContent = 'Choose a file or paste rows from your spreadsheet.'; return; }
      Object.assign(state.payload, { filename: state.file?.name || '', day_id: state.day || null, date: state.date, test_id: state.test || null, source: state.source || null });
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Checking…'; }
      state.check = await api.post('/testing/upload/check', state.payload);
      state.confirmed = new Set(); state.show = 'all'; state.term = '';
      state.check.ok ? drawReview() : drawRejected();
      top();
    } catch (e) {
      if (errEl) errEl.textContent = e.message; else toastError(e);
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Check the sheet'; }
    }
  }
  // File chooser with drag and drop. onChange runs after a file is picked or removed.
  const fileBox = () => (state.file
    ? html`<div class="tst-file"><span class="row" style="gap:10px;min-width:0">${icon('check')}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${state.file.name}</span><span class="small">${Math.max(1, Math.round(state.file.size / 1024))} KB</span></span>
        <button type="button" class="btn btn-ghost btn-sm" data-unfile>Remove</button></div>`
    : html`<label class="tst-drop" data-drop>${icon('upload', 24)}<span><strong>Drop the file here</strong> or choose it<br><span class="small">Excel or CSV, up to 3.5 MB</span></span>
        <input class="sr-only" type="file" data-file accept=".xlsx,.csv,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>`);
  function bindFile(root, onChange) {
    const drop = root.querySelector('[data-drop]');
    root.querySelector('[data-file]')?.addEventListener('change', (e) => { if (e.target.files[0]) { state.file = e.target.files[0]; onChange(); } });
    root.querySelector('[data-unfile]')?.addEventListener('click', () => { state.file = null; onChange(); });
    if (!drop) return;
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) { state.file = f; onChange(); } });
  }

  function recentPanel() {
    if (!state.recent.length) return '';
    return html`<section class="panel tst-recent"><div><h2 class="panel-title">Recent uploads</h2>
      <p class="panel-sub">Undo takes an upload back out: new results are removed and replaced values go back to what they were. Anything changed since is left alone.</p></div>
      <div class="list">${state.recent.map((b) => html`<div class="list-row">
        <div class="grow"><div class="strong">${b.filename || 'Pasted rows'}</div>
          <div class="small muted">${relTime(b.created_at)}${b.by_name ? ` by ${b.by_name}` : ''}${b.day_name ? ` · ${b.day_name}` : ''} · ${plural(b.saved, 'result')}${b.replaced ? ` (${b.replaced} replaced)` : ''}${b.pending ? ` · ${b.pending} sent to waiting` : ''}${b.source && b.source !== 'Import' ? ` · ${b.source}` : ''}</div>
          ${b.undone_at ? html`<div class="small muted">Undone ${relTime(b.undone_at)}${b.undone_by_name ? ` by ${b.undone_by_name}` : ''}: ${b.undo_summary}</div>` : ''}</div>
        ${b.undone_at ? badge('off', 'Undone') : html`${b.day_id && b.day_exists ? html`<a class="btn btn-ghost btn-sm" href="/app/testing/day/${b.day_id}">Open day</a>` : ''}<button class="btn btn-sm" data-undo="${b.id}">Undo</button>`}
      </div>`)}</div></section>`;
  }
  let undoing = false;
  async function undo(id, after) {
    if (undoing) return;
    const b = state.recent.find((x) => x.id === id);
    if (b?.undone_at) { toast('This upload was already undone.'); after(); return; }
    const what = b ? `${b.filename || 'the pasted rows'} (${plural((b.created + b.replaced + b.pending) || b.saved, 'result')})` : 'this upload';
    if (!(await confirmDialog('Undo upload', `Take ${what} back out? New results are removed from profiles and any values it replaced go back to what they were. Results changed since the upload are left alone.`, 'Undo upload', 'warn'))) return;
    undoing = true;
    try {
      const r = await api.post(`/testing/uploads/${id}/undo`);
      const parts = [r.removed && `${plural(r.removed, 'result')} removed`, r.restored && `${r.restored} put back`, r.pending_removed && `${r.pending_removed} waiting dropped`].filter(Boolean);
      toast(`Upload undone.${parts.length ? ` ${parts.join(', ')}.` : ''}${r.kept ? ` ${r.kept} changed since, left alone.` : ''}`);
      state.recent = await api.get('/testing/uploads').catch(() => state.recent);
      after();
    } catch (err) { toastError(err); } finally { undoing = false; }
  }
  const bindRecent = (after) => stage.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', () => undo(Number(b.dataset.undo), after)));

  function drawForm() {
    mount(stage, html`<div class="grid-2">
      <section class="panel"><div><h2 class="panel-title">1. Get the sheet</h2>
        <p class="panel-sub">Every athlete's ID is filled in, with a column for each test and attempt. Fill it in on paper, a laptop, or a phone.</p></div>
        <div class="field"><label class="label" for="g-day">Testing day</label><select class="input" id="g-day">${dayOpts(state.day)}</select></div>
        <div class="form-grid" id="g-alt">
          <div class="field"><label class="label" for="g-team">Team</label><select class="input" id="g-team"><option value="">Choose athletes later</option>${o.teams.map((t) => html`<option value="${t.id}">${t.team_name}</option>`)}</select></div>
          <div class="field"><label class="label" for="g-preset">Tests</label><select class="input" id="g-preset">${Object.keys(o.presets).map((p) => html`<option>${p}</option>`)}</select></div>
        </div>
        <p class="small muted" id="g-note" style="margin:0"></p>
        <div class="btn-row"><a class="btn" id="dl-x" download>${icon('download')}Download Excel</a><a class="btn btn-ghost" id="dl-c" download>Download CSV (Google Sheets)</a></div>
      </section>
      <form class="panel" id="up" novalidate><div><h2 class="panel-title">2. Upload it</h2>
        <p class="panel-sub">Every row needs a real Athlete ID and every value has to fit its test. If anything is off, nothing is saved and you'll see exactly what to fix.</p></div>
        <div id="filebox">${fileBox()}</div>
        <div class="field"><label class="sr-only" for="paste">Paste rows</label><textarea class="input" id="paste" rows="4" placeholder="Or paste rows straight from Excel or Google Sheets, header row included." ${state.file ? raw('disabled') : ''}>${state.file ? '' : state.text}</textarea>
          ${state.file ? html`<span class="small muted">Using the file. Remove it to paste rows instead.</span>` : ''}</div>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
          <div class="field"><label class="label" for="u-day">Add to testing day</label><select class="input" id="u-day">${dayOpts(state.day)}</select></div>
          <div class="field"><label class="label" for="u-date">Date for rows without one</label><input class="input" id="u-date" type="date" value="${state.date}" ${state.day ? raw('disabled') : ''}>
            ${state.day ? html`<span class="small muted">Uses the testing day's date.</span>` : ''}</div>
          <div class="field"><label class="label" for="u-src">Where it's from</label><select class="input" id="u-src"><option value="">Work it out from the file</option>
            ${SOURCE_CHOICES.map((x) => html`<option ${state.source === x ? raw('selected') : ''}>${x}</option>`)}</select></div>
          <div class="field"><label class="label" for="u-test">One-test device export</label><select class="input" id="u-test"><option value="">No, it has test columns</option>
            ${o.tests.map((t) => html`<option value="${t.id}" ${String(state.test) === String(t.id) ? raw('selected') : ''}>${t.name} (${t.unit})</option>`)}</select></div>
        </div>
        <div class="error" id="u-err" role="alert"></div>
        <div><button class="btn btn-primary">Check the sheet</button></div>
      </form></div>
      ${recentPanel()}`);
    const gDay = stage.querySelector('#g-day'), gTeam = stage.querySelector('#g-team'), gPreset = stage.querySelector('#g-preset');
    const links = () => {
      const q = gDay.value ? `day_id=${gDay.value}` : `preset=${encodeURIComponent(gPreset.value)}${gTeam.value ? `&team_id=${gTeam.value}` : ''}`;
      stage.querySelector('#dl-x').href = `/api/testing/sheet?${q}&format=xlsx`;
      stage.querySelector('#dl-c').href = `/api/testing/sheet?${q}&format=csv`;
      gTeam.disabled = gPreset.disabled = !!gDay.value;
      stage.querySelector('#g-note').textContent = gDay.value ? 'Results already entered for this day are filled in, so the sheet doubles as a backup.'
        : gTeam.value ? '' : 'No team chosen: the sheet has the test columns and blank rows. Add each athlete\'s ID.';
    };
    [gDay, gTeam, gPreset].forEach((s) => s.addEventListener('change', links)); links();
    // Picking a day to download also points the upload at it, unless one is already chosen.
    gDay.addEventListener('change', () => { if (gDay.value && !state.day) { state.day = gDay.value; state.text = stage.querySelector('#paste').value || state.text; drawForm(); } });
    stage.querySelector('#paste').addEventListener('input', (e) => { state.text = e.target.value; });
    stage.querySelector('#u-day').addEventListener('change', (e) => { state.day = e.target.value; drawForm(); });
    stage.querySelector('#u-date').addEventListener('change', (e) => { state.date = e.target.value || localISO(); });
    stage.querySelector('#u-src').addEventListener('change', (e) => { state.source = e.target.value; });
    stage.querySelector('#u-test').addEventListener('change', (e) => { state.test = e.target.value; });
    bindFile(stage.querySelector('#filebox'), () => {
      state.text = stage.querySelector('#paste')?.value || state.text;
      drawForm();
      if (state.file && state.file.size > MAX_UPLOAD) stage.querySelector('#u-err').textContent = `${state.file.name} is ${(state.file.size / 1048576).toFixed(1)} MB. Upload files up to 3.5 MB, or split the sheet in two.`;
    });
    bindRecent(drawForm);
    const f = stage.querySelector('#up');
    f.onsubmit = (e) => { e.preventDefault(); runCheck(f.querySelector('.btn-primary'), stage.querySelector('#u-err')); };
  }

  function drawRejected() {
    const c = state.check;
    const n = c.problems.length;
    const pasted = !state.file;
    mount(stage, html`<section class="panel tst-rej"><h2 class="panel-title">This sheet can't be saved</h2>
      <p style="margin:0">Nothing was saved. ${n === 1 ? '1 problem needs' : `${n} problems need`} fixing in ${state.filename}${state.check.source && state.check.source !== 'Import' ? ` (read as ${state.check.source})` : ''}. Fix ${n === 1 ? 'it' : 'them'} and check the sheet again.</p>
      <div class="table-wrap" style="border:0;background:transparent"><table class="table tst-probs"><thead><tr><th>Row</th><th>Column</th><th>Athlete</th><th>What to fix</th></tr></thead>
      <tbody>${c.problems.map((p) => html`<tr><td class="p-row strong">${p.row || '—'}</td><td class="p-col">${p.column}</td><td class="mono p-ath">${p.athlete}</td><td class="p-fix">${p.problem}</td></tr>`)}</tbody></table></div>
      <div><button class="btn btn-ghost" id="dl-probs">${icon('download')}Download this list</button></div>
    </section>
    <section class="panel"><div><h2 class="panel-title">Fix and check again</h2>
      <p class="panel-sub">${pasted ? 'Fix the rows here, or in your spreadsheet and paste them again.' : `Fix ${state.file.name} in your spreadsheet, save it, and choose it again.`} The testing day and other options stay as they were.</p></div>
      ${pasted ? html`<div class="field"><label class="sr-only" for="fix-paste">Rows</label><textarea class="input mono" id="fix-paste" wrap="off" rows="${Math.min(14, Math.max(5, state.text.split('\n').length + 1))}" style="font-size:13px">${state.text}</textarea></div>`
        : html`<div id="fix-file">${fileBox()}</div>`}
      <div class="error" id="fix-err" role="alert"></div>
      <div class="btn-row"><button class="btn btn-primary" id="again">Check again</button><button class="btn btn-ghost" id="opts">Change options</button></div>
    </section>`);
    stage.querySelector('#dl-probs').onclick = () => csvDownload([['Row', 'Column', 'Athlete', 'What to fix'], ...c.problems.map((p) => [p.row, p.column, p.athlete, p.problem])], 'sheet-problems.csv');
    stage.querySelector('#fix-paste')?.addEventListener('input', (e) => { state.text = e.target.value; });
    const ff = stage.querySelector('#fix-file');
    if (ff) {
      const hadFile = state.file;
      state.file = null; // the saved file must be chosen again
      mount(ff, fileBox());
      const rebind = () => { mount(ff, fileBox()); bindFile(ff, rebind); };
      bindFile(ff, rebind);
      stage.querySelector('#again').textContent = 'Check the fixed file';
      stage.querySelector('#opts').addEventListener('click', () => { if (!state.file) state.file = hadFile; });
    }
    stage.querySelector('#again').onclick = (e) => {
      if (ff && !state.file) { stage.querySelector('#fix-err').textContent = 'Choose the fixed file first.'; return; }
      runCheck(e.currentTarget, stage.querySelector('#fix-err'));
    };
    stage.querySelector('#opts').onclick = () => { drawForm(); top(); };
  }

  function drawReview() {
    const c = state.check;
    const sum = c.summary || { created: c.count, replacing: 0, unchanged: 0, prs: 0 };
    const need = c.unusual.filter((u) => !state.confirmed.has(u.key)).length;
    const total = c.count + c.pending.length;
    const allSame = sum.unchanged === c.count && !c.pending.length;
    const big = c.count > 12;
    mount(stage, html`<section class="panel"><div><h2 class="panel-title">3. Every row checks out</h2>
      <p class="panel-sub">${plural(c.count, 'result')} for ${plural(c.athletes.length, 'athlete')}, each matched by Athlete ID${c.day ? `, going to ${c.day.name}` : ''}. Saving adds all of them at once.${c.pending.length ? ` ${c.pending.length === 1 ? '1 result has' : `${c.pending.length} results have`} no Athlete ID and will wait to be linked.` : ''}</p></div>
      <div class="tst-sum">
        ${sum.created ? html`<span class="badge badge-good">${sum.created} new</span>` : ''}
        ${sum.replacing ? html`<span class="badge badge-warn">${sum.replacing} ${sum.replacing === 1 ? 'replaces an earlier value' : 'replace earlier values'}</span>` : ''}
        ${sum.unchanged ? html`<span class="badge badge-muted">${sum.unchanged} already saved</span>` : ''}
        ${sum.prs ? html`<span class="badge badge-good">${plural(sum.prs, 'PR')}</span>` : ''}
        ${c.pending.length ? html`<span class="badge badge-muted">${c.pending.length} to link</span>` : ''}
        <span class="badge badge-neutral">Read as ${c.format === 'wide' ? 'our sheet' : c.source === 'Import' ? 'a results export' : `a ${c.source} export`}</span>
      </div>
      ${allSame ? html`<p class="small muted" style="margin:0">Everything on this sheet is already saved. Saving again changes nothing.</p>` : ''}
      ${c.unusual.length ? html`<div class="tst-confirm"><div class="spread"><h3 class="panel-title">Confirm ${c.unusual.length === 1 ? 'this value' : 'these values'}</h3>
          ${c.unusual.length >= 3 && need ? html`<button class="btn btn-ghost btn-sm" id="tick-all" style="min-height:44px">Tick all ${c.unusual.length}</button>` : ''}</div>
        <p class="small muted" style="margin:0">They're possible but unusual. Tick each one that's right. If one is a mistake, fix the sheet and upload it again.</p>
        ${c.unusual.map((u) => html`<label class="check small" style="min-height:44px;align-items:center"><input type="checkbox" data-key="${u.key}" ${state.confirmed.has(u.key) ? raw('checked') : ''}>
          <span><span class="muted">Row ${u.row}, ${u.column}:</span> ${u.message}</span></label>`)}</div>` : ''}
      ${big ? html`<div class="tst-up-tools">
        <div class="seg" role="group" aria-label="Show">${[['all', 'All'], ['look', 'Needs a look'], ['pr', 'PRs']].map(([k, l]) => html`<button type="button" data-show="${k}" aria-pressed="${state.show === k}">${l}</button>`)}</div>
        <label class="sr-only" for="rv-q">Find an athlete</label><input class="input" id="rv-q" type="search" placeholder="Find an athlete by name or ID" value="${state.term}" autocomplete="off"></div>` : ''}
      <div id="ath" class="stack"></div>
      ${c.pending.length ? html`<div class="tst-ath"><div class="spread"><span class="strong">Waiting to be linked</span><span class="small muted">${plural(c.pending.length, 'result')}</span></div>
        <div class="list" style="margin-top:6px">${c.pending.map((p) => html`<div class="list-row"><span class="grow">${p.sender} · ${p.test}</span><span class="muted small">${shortDate(p.date)}</span><span class="strong">${fmtValue(p.value, p.unit)}</span></div>`)}</div></div>` : ''}
      <div class="btn-row"><button class="btn btn-primary" id="save" ${need ? raw('disabled') : ''}>${need ? `Confirm ${need} more to save` : `Save ${plural(total, 'result')}`}</button>
        <button class="btn btn-ghost" id="over">Start over</button></div></section>`);
    drawAthletes();
    stage.querySelectorAll('[data-key]').forEach((cb) => cb.addEventListener('change', () => { cb.checked ? state.confirmed.add(cb.dataset.key) : state.confirmed.delete(cb.dataset.key); drawReview(); }));
    stage.querySelector('#tick-all')?.addEventListener('click', () => { c.unusual.forEach((u) => state.confirmed.add(u.key)); drawReview(); });
    stage.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => { state.show = b.dataset.show; stage.querySelectorAll('[data-show]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawAthletes(); }));
    stage.querySelector('#rv-q')?.addEventListener('input', debounce((e) => { state.term = e.target.value; drawAthletes(); }, 120));
    stage.querySelector('#over').onclick = () => { drawForm(); top(); };
    stage.querySelector('#save').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Saving…';
      try {
        const r = await api.post('/testing/upload/save', { ...state.payload, confirmed: [...state.confirmed] });
        state.recent = await api.get('/testing/uploads').catch(() => state.recent);
        drawSaved(r);
        toast(`Saved ${plural(r.saved, 'result')}.`);
      } catch (err) {
        if (err.data?.problems) { state.check = err.data; drawRejected(); } else { toastError(err); drawReview(); }
      }
    };
  }
  function drawAthletes() {
    const c = state.check;
    const unusualKeys = new Set(c.unusual.map((u) => u.key));
    const term = state.term.trim().toLowerCase();
    const keep = (r) => state.show === 'all' || (state.show === 'pr' ? r.pr : (unusualKeys.has(r.key) || r.replaces != null));
    const groups = c.athletes.filter((a) => !term || `${a.name} ${a.code}`.toLowerCase().includes(term))
      .map((a) => ({ ...a, shown: a.results.filter(keep) })).filter((a) => a.shown.length);
    const el = stage.querySelector('#ath');
    if (!groups.length) { mount(el, html`<div class="empty">Nothing matches. ${state.show === 'look' ? 'No values are unusual or replace an earlier one.' : ''}</div>`); return; }
    mount(el, groups.map((a) => {
      const open = a.results.filter((r) => unusualKeys.has(r.key) && !state.confirmed.has(r.key)).length;
      return html`<div class="tst-ath"><div class="spread"><span class="strong">${a.name}</span>
        <span class="row" style="gap:10px"><span class="tst-code">${a.code}</span><span class="small muted">${plural(a.results.length, 'result')}</span>${open ? badge('failed', 'Confirm') : ''}</span></div>
        <div class="list" style="margin-top:6px">${a.shown.map((r) => html`<div class="list-row"><span class="grow">${r.test} #${r.attempt}${r.prev_best != null && !r.same ? html`<span class="small muted tst-hide-sm"> · best ${fmtValue(r.prev_best, r.unit)}</span>` : ''}</span>
          <span class="muted small tst-hide-sm">${shortDate(r.date)}</span>
          <span class="tst-vals">${r.replaces != null ? html`<span class="tst-was">was ${fmtValue(r.replaces, r.unit)}</span>` : ''}<span class="strong" style="white-space:nowrap">${fmtValue(r.value, r.unit)}</span>
          ${r.pr ? badge('active', 'PR') : ''}${r.same ? badge('off', 'Already saved') : ''}${r.unusual ? badge(state.confirmed.has(r.key) ? 'active' : 'failed', state.confirmed.has(r.key) ? 'Confirmed' : 'Unusual') : ''}</span></div>`)}</div></div>`;
    }));
  }
  function drawSaved(r) {
    const c = state.check;
    const changed = (r.created ?? r.saved) + (r.replaced ?? 0);
    mount(stage, html`<section class="panel"><h2 class="panel-title">Saved</h2>
      <p style="margin:0">${changed || r.pending ? `${plural(r.saved, 'result')} ${r.saved === 1 ? 'is' : 'are'} in ${plural(r.athletes, 'profile')}${r.prs ? `, with ${plural(r.prs, 'new PR')}` : ''}.` : 'Everything on this sheet was already saved, so nothing changed.'}
        ${r.replaced ? ` ${plural(r.replaced, 'earlier value')} replaced.` : ''}${r.unchanged && changed ? ` ${r.unchanged} already saved, left as they were.` : ''}${r.pending ? ` ${plural(r.pending, 'result')} ${r.pending === 1 ? 'is' : 'are'} waiting to be linked.` : ''} Uploading the same sheet again won't double-count.</p>
      <div class="btn-row">${c.day ? html`<a class="btn btn-primary" href="/app/testing/day/${c.day.id}">Open ${c.day.name}</a>` : ''}
        ${r.pending ? html`<a class="btn ${c.day ? '' : 'btn-primary'}" href="/app/testing/queue">Link waiting results</a>` : ''}
        <button class="btn ${c.day || r.pending ? 'btn-ghost' : 'btn-primary'}" id="another">Upload another sheet</button>
        ${r.batch_id && !state.recent.find((b) => b.id === r.batch_id)?.undone_at ? html`<button class="btn btn-ghost" id="undo-this">Undo this upload</button>` : ''}</div></section>
      ${recentPanel()}`);
    stage.querySelector('#another').onclick = () => { state.file = null; state.text = ''; drawForm(); top(); };
    stage.querySelector('#undo-this')?.addEventListener('click', () => undo(r.batch_id, () => { drawForm(); top(); }));
    bindRecent(() => drawSaved(r));
  }
  drawForm();
}

// ============ Waiting to be linked ============
async function renderQueue(ctx) {
  const groups = await api.get('/testing/pending');
  if (!ctx.isCurrent()) return;
  const view = { source: 'all', term: '' };
  const sources = [...new Set(groups.map((g) => g.source))].sort();
  mount(ctx.el, html`${STYLE}${UP_STYLE}
    ${header('Waiting to be linked', "These results arrived without an Athlete ID or a device you've linked. None of them are in a profile yet.", back())}
    <p class="small muted" style="margin:0">Pick who each set belongs to and link it. Linking is all or nothing, and nothing is ever matched by name on its own. Tip: enter Athlete IDs as names on your devices and results skip this step.</p>
    <p class="small" id="q-count" style="margin:0" aria-live="polite"></p>
    ${groups.length > 3 ? html`<div class="tst-up-tools">
      ${sources.length > 1 ? html`<div class="seg" role="group" aria-label="Source">${['all', ...sources].map((s) => html`<button type="button" data-src="${s}" aria-pressed="${s === 'all'}">${s === 'all' ? 'All' : s}</button>`)}</div>` : ''}
      <label class="sr-only" for="q-find">Find a sender</label><input class="input" id="q-find" type="search" placeholder="Find a sender, device ID or test" autocomplete="off"></div>` : ''}
    <div class="stack" id="cards"></div>`);
  const cards = ctx.el.querySelector('#cards');
  const live = new Set(groups);
  const updateCount = () => {
    const n = [...live].reduce((s, g) => s + g.results.length, 0);
    ctx.el.querySelector('#q-count').textContent = live.size ? `${plural(n, 'result')} from ${plural(live.size, 'sender')}.` : '';
    if (!live.size) mount(cards, html`<div class="empty">Nothing is waiting. Every result is in a profile. <a href="/app/testing">Back to Testing</a></div>`);
  };
  const filter = () => {
    const term = view.term.trim().toLowerCase();
    let shown = 0;
    for (const g of live) {
      const ok = (view.source === 'all' || g.source === view.source) && (!term || `${g.sender_label} ${g.sender_key} ${g.source} ${g.results.map((r) => r.test).join(' ')}`.toLowerCase().includes(term));
      g.el.hidden = !ok; if (ok) shown++;
    }
    let none = cards.querySelector('.q-none');
    if (!shown && live.size) { if (!none) { none = document.createElement('div'); none.className = 'empty q-none'; none.textContent = 'No senders match.'; cards.append(none); } }
    else none?.remove();
  };
  const remove = (g) => { live.delete(g); g.el.remove(); updateCount(); filter(); };
  ctx.el.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => { view.source = b.dataset.src; ctx.el.querySelectorAll('[data-src]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); filter(); }));
  ctx.el.querySelector('#q-find')?.addEventListener('input', debounce((e) => { view.term = e.target.value; filter(); }, 120));

  groups.forEach((g, gi) => {
    const el = document.createElement('section');
    el.className = 'panel tst-q';
    g.el = el;
    cards.append(el);
    const st = { athlete: null, remember: true, ticked: new Set(g.results.map((r) => r.id)), busy: false };
    const senderDesc = g.sender_key !== g.sender_label ? `device ID ${g.sender_key}` : `"${g.sender_label}"`;
    function draw() {
      const n = st.ticked.size, all = n === g.results.length;
      mount(el, html`<div><h2 class="panel-title">${g.sender_label}</h2>
        <p class="panel-sub">${g.source}${g.sender_key !== g.sender_label ? ` · device ID ${g.sender_key}` : ''} · ${plural(g.results.length, 'result')} · received ${relTime(g.received_at)}</p></div>
        ${st.athlete ? html`<div class="banner info"><span>Linking to <strong>${name(st.athlete)}</strong> (${st.athlete.code})</span><button class="btn btn-ghost btn-sm" data-clear>Change</button></div>`
        : html`${g.suggestions.length ? html`<div class="row"><span class="small muted">Could be:</span>${g.suggestions.map((a) => html`<button class="btn btn-sm" data-pick="${a.id}">${name(a)} (${a.code})</button>`)}</div>` : ''}
          <div class="tst-picker"><label class="sr-only" for="q${gi}">Find athlete</label><input class="input" id="q${gi}" autocomplete="off" placeholder="Type a name or Athlete ID, then pick from the list"><div class="tst-sugg" hidden></div></div>`}
        <div class="tst-qhead"><span class="small muted">${n === g.results.length ? 'All results included' : `${n} of ${g.results.length} included`}</span>
          ${g.results.length > 1 ? html`<button type="button" class="btn btn-ghost btn-sm" data-all>${all ? 'Untick all' : 'Tick all'}</button>` : ''}</div>
        <div class="tst-qrows">${g.results.map((r) => html`<label class="tst-qrow"><input type="checkbox" data-r="${r.id}" aria-label="Include ${r.test} ${fmtValue(r.value, r.unit)}" ${st.ticked.has(r.id) ? raw('checked') : ''}>
          <span>${r.test}</span><span class="strong">${fmtValue(r.value, r.unit)}</span><span class="muted small q-date">${shortDate(r.recorded_at)}</span></label>`)}</div>
        <label class="check small" style="min-height:44px;align-items:center"><input type="checkbox" data-remember ${st.remember ? raw('checked') : ''}> Remember: send future results from ${senderDesc} (${g.source}) straight to ${st.athlete ? name(st.athlete) : 'this athlete'}</label>
        <div class="btn-row"><button class="btn btn-primary" data-link ${!st.athlete || !n || st.busy ? raw('disabled') : ''}>${st.athlete ? `Link ${plural(n, 'result')} to ${st.athlete.first_name}` : `Link ${plural(n, 'result')}`}</button>
          <button class="btn btn-ghost" data-discard ${n && !st.busy ? '' : raw('disabled')}>${all ? 'Discard all' : 'Discard selected'}</button></div>`);
      const q = el.querySelector('.tst-picker input');
      if (q) bindPicker(q, el.querySelector('.tst-sugg'), (a) => { st.athlete = a; draw(); el.querySelector('[data-link]')?.focus(); });
    }
    el.addEventListener('click', async (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick && !pick.closest('.tst-sugg')) { st.athlete = g.suggestions.find((a) => a.id === Number(pick.dataset.pick)); draw(); el.querySelector('[data-link]')?.focus(); return; }
      if (e.target.closest('[data-clear]')) { st.athlete = null; draw(); el.querySelector('.tst-picker input')?.focus(); return; }
      if (e.target.closest('[data-all]')) { st.ticked = st.ticked.size === g.results.length ? new Set() : new Set(g.results.map((r) => r.id)); draw(); return; }
      if (e.target.closest('[data-link]')) {
        st.busy = true; draw();
        try {
          const r = await api.post('/testing/pending/link', { ids: [...st.ticked], athlete_id: st.athlete.id, remember: st.remember });
          toast(`Linked ${plural(r.linked, 'result')} to ${name(st.athlete)}.${r.prs ? ` ${plural(r.prs, 'new PR')}.` : ''}${st.remember ? ' Future results go straight in.' : ''}`);
          g.results = g.results.filter((x) => !st.ticked.has(x.id));
          if (!g.results.length) remove(g); else { st.ticked = new Set(g.results.map((x) => x.id)); st.busy = false; draw(); updateCount(); }
        } catch (err) { st.busy = false; draw(); toastError(err); }
        return;
      }
      if (e.target.closest('[data-discard]')) {
        if (!(await confirmDialog('Discard results', `Discard ${plural(st.ticked.size, 'result')} from ${g.sender_label}? They won't go into any profile, and this can't be undone.`, 'Discard', 'warn'))) return;
        try {
          const r = await api.post('/testing/pending/discard', { ids: [...st.ticked] });
          toast(`Discarded ${plural(r.discarded, 'result')}.`);
          g.results = g.results.filter((x) => !st.ticked.has(x.id));
          if (!g.results.length) remove(g); else { st.ticked = new Set(g.results.map((x) => x.id)); draw(); updateCount(); }
        } catch (err) { toastError(err); }
      }
    });
    el.addEventListener('change', (e) => {
      if (e.target.dataset.r) { e.target.checked ? st.ticked.add(Number(e.target.dataset.r)) : st.ticked.delete(Number(e.target.dataset.r)); draw(); el.querySelector(`[data-r="${e.target.dataset.r}"]`)?.focus(); }
      if (e.target.hasAttribute('data-remember')) st.remember = e.target.checked;
    });
    draw();
  });
  updateCount();
  document.addEventListener('click', function close(e) {
    if (!ctx.isCurrent()) { document.removeEventListener('click', close); return; }
    if (!e.target.closest('.tst-picker')) ctx.el.querySelectorAll('.tst-sugg').forEach((b) => { b.hidden = true; });
  });
}

// ============ Devices & imports ============
let lastUnlinked = null; // the link just removed, so the next render can offer Undo
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
  // One green button per view: linking waiting results comes first, then connecting Hawkin.
  const primary = d.pending.count ? 'pending' : owner && !hk.connected ? 'hawkin' : null;
  const undoLink = lastUnlinked; lastUnlinked = null;
  mount(ctx.el, html`${STYLE}${UP_STYLE}
    ${header('Devices & imports', 'Get results in from anywhere: live connections, file imports, the open API, or by hand.', back())}
    ${d.pending.count ? html`<section class="panel"><div><h2 class="panel-title">Waiting to be linked</h2>
      <p class="panel-sub">${plural(d.pending.count, 'result')} from ${plural(d.pending.senders, 'unrecognized sender')}. Nothing lands in a profile until you link it.</p></div>
      <a class="btn btn-primary btn-block" href="/app/testing/queue">Link them</a></section>` : ''}
    <section class="panel tst-hk"><div class="panel-head"><div><h2 class="panel-title">Hawkin Dynamics force plates</h2>
      <p class="panel-sub">Connect once with an integration token from Hawkin (Settings, then Integrations). New tests sync every 15 minutes.</p></div>
      ${hk.connected ? (hk.status && !hk.status.ok ? badge('failed', 'Needs attention') : badge('active', 'Connected')) : badge('off', 'Not connected')}</div>
      ${hk.connected ? html`<p class="small ${hk.status && !hk.status.ok ? 'warn-text' : 'muted'}" style="margin:0" id="hk-status">${hk.status ? `Last sync ${relTime(hk.status.at)}: ${hk.status.message}` : 'Waiting for the first sync.'}${hk.token_hint ? ` Token ${hk.token_hint}, ${hk.region}.` : ''}</p>
        ${hk.status && !hk.status.ok && !owner ? html`<p class="small muted" style="margin:0">An owner can paste a new token here.</p>` : ''}
        ${owner ? html`<div class="btn-row"><button class="btn" id="hk-sync">Sync now</button>${hk.status && !hk.status.ok ? html`<button class="btn" id="hk-new">Paste a new token</button>` : ''}<button class="btn btn-ghost" id="hk-off">Disconnect</button></div>` : ''}`
      : owner ? html`<form class="row" id="hk" style="align-items:flex-end" novalidate>
          <div class="field" style="flex:1;min-width:220px"><label class="label" for="hk-t">Integration token</label><input class="input mono" id="hk-t" name="token" autocomplete="off" placeholder="Integration token from Hawkin"></div>
          <div class="field"><label class="label" for="hk-r">Region</label><select class="input" id="hk-r" name="region"><option>Americas</option><option>Europe</option><option>Asia Pacific</option></select></div>
          <button class="btn ${primary === 'hawkin' ? 'btn-primary' : ''}">Connect</button></form>`
        : html`<p class="small muted" style="margin:0">Not connected. An owner can paste the integration token here.</p>`}
      <p class="small muted" style="margin:0">Tip: put each athlete's Athlete ID in their Hawkin profile (External ID) and results go straight in. Otherwise they wait to be linked once.</p>
    </section>
    <section class="panel"><div><h2 class="panel-title">Import a file</h2>
      <p class="panel-sub">OVR, VALD, Swift, Freelap, Brower, Dashr, Rapsodo, radar guns, our template or any spreadsheet.</p></div>
      <p class="small muted" style="margin:0">In OVR Connect, open the profile tab and export your history, then upload the file here. Rows with an Athlete ID go straight to that profile; the rest wait to be linked. Every upload can be undone from Recent uploads.</p>
      <div><a class="btn" href="/app/testing/upload">${icon('upload')}Upload results</a></div></section>
    <section class="panel"><div><h2 class="panel-title">Send results from any system</h2>
      <p class="panel-sub">Any timing system, app or script can post results to the open API with an API key. Values in other units are converted, athletes are matched by Athlete ID or a linked device, and resending the same result is ignored.</p></div>
      <div class="tst-copy"><pre class="tst-pre">${curl}</pre><button class="btn btn-sm" id="copy-curl" type="button">Copy</button></div>
      <p class="small muted" style="margin:0">Send one result or an array. Fields: athlete_code or athlete_id, device_id, device_name, source, test, value, unit, recorded_at, ref.</p>
      <div class="btn-row">${owner ? html`<a class="btn" href="/app/integrations">API keys</a>` : ''}<a class="btn btn-ghost" href="/docs/api">Full API reference</a></div></section>
    <section class="panel tst-links"><div class="panel-head"><div><h2 class="panel-title">Linked device IDs</h2>
      <p class="panel-sub">Results from these device IDs and names go straight to the athlete. Everything else needs an Athlete ID or waits for you.</p></div>
      <button class="btn" id="add-link">${icon('plus')}Link a device</button></div>
      ${undoLink ? html`<div class="banner info" id="undo-bar"><span>Unlinked ${undoLink.sender_label || undoLink.sender_key} (${undoLink.source}).</span><button class="btn btn-ghost btn-sm" id="undo-unlink" style="min-height:44px">Undo</button></div>` : ''}
      ${d.links.length > 6 ? html`<div><label class="sr-only" for="l-find">Find a device</label><input class="input" id="l-find" type="search" placeholder="Find a device, source or athlete" autocomplete="off"></div>` : ''}
      <div id="links">${d.links.length ? d.links.map((l) => html`<div class="tst-lrow" data-row="${l.id}" data-text="${`${l.sender_label} ${l.sender_key} ${l.source} ${l.first_name} ${l.last_name} ${l.code}`.toLowerCase()}">
          <div><div class="strong">${l.sender_label || l.sender_key}</div>
            <div class="small muted">${l.source}${l.sender_label && l.sender_label !== l.sender_key ? ` · ${l.sender_key}` : ''} · linked ${fmtDate(l.created_at)}</div></div>
          <div class="l-who">${l.first_name} ${l.last_name} <span class="mono small muted">${l.code}</span>${l.archived ? html` ${badge('off', 'Archived')}` : ''}</div>
          <div class="btn-row"><button class="btn btn-ghost btn-sm" data-move="${l.id}" aria-label="Change the athlete for ${l.sender_label || l.sender_key}">Change</button><button class="btn btn-ghost btn-sm" data-unlink="${l.id}">Unlink</button></div></div>`)
      : html`<p class="small muted" style="margin:0">None yet. Links are created when you link waiting results and choose to remember them, or with Link a device.</p>`}</div></section>`);
  const f = ctx.el.querySelector('#hk');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try { await api.put('/testing/hawkin', formData(f)); toast('Hawkin connected. The first sync runs within 15 minutes.'); ctx.reload(); } catch (err) { toastError(err); btn.disabled = false; }
  };
  ctx.el.querySelector('#hk-sync')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Syncing…';
    const r = await api.post('/testing/hawkin/sync').catch((err) => { toastError(err); return null; });
    if (r) { toast(r.error ? r.error : `Sync finished. ${r.saved || 0} saved, ${r.pending || 0} waiting to be linked.`, r.error ? 'warn' : 'good'); ctx.reload(); }
    else { b.disabled = false; b.textContent = 'Sync now'; }
  });
  ctx.el.querySelector('#hk-new')?.addEventListener('click', async () => {
    const v = await modal({ title: 'Paste a new Hawkin token', body: html`<div class="field"><label class="label" for="hk-t2">Integration token</label><input class="input mono" id="hk-t2" autocomplete="off"></div>
      <div class="field"><label class="label" for="hk-r2">Region</label><select class="input" id="hk-r2">${['Americas', 'Europe', 'Asia Pacific'].map((x) => html`<option ${x === hk.region ? raw('selected') : ''}>${x}</option>`)}</select></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Save token', kind: 'primary', onClick: async (body) => { await api.put('/testing/hawkin', { token: body.querySelector('#hk-t2').value, region: body.querySelector('#hk-r2').value }); return true; } }] });
    if (v) { toast('Token saved.'); ctx.reload(); }
  });
  ctx.el.querySelector('#hk-off')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Disconnect Hawkin', 'New force plate tests stop syncing. Results already saved stay in profiles.', 'Disconnect', 'warn'))) return;
    try { await api.del('/testing/hawkin'); toast('Hawkin disconnected.'); ctx.reload(); } catch (err) { toastError(err); }
  });
  ctx.el.querySelector('#copy-curl')?.addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(curl); e.currentTarget.textContent = 'Copied'; } catch { toast('Select the example and copy it.', 'warn'); }
  });
  ctx.el.querySelector('#l-find')?.addEventListener('input', debounce((e) => {
    const t = e.target.value.trim().toLowerCase();
    ctx.el.querySelectorAll('[data-row]').forEach((r) => { r.hidden = !!t && !r.dataset.text.includes(t); });
  }, 120));
  ctx.el.querySelector('#add-link').addEventListener('click', async () => {
    let athlete = null;
    const r = await modal({
      title: 'Link a device',
      body: html`<p style="margin:0" class="small muted">Results from this device ID or name will go straight to the athlete. Anything already waiting from it is linked now.</p>
        <div class="field"><label class="label" for="nl-src">Comes from</label><input class="input" id="nl-src" list="nl-srcs" autocomplete="off" placeholder="Hawkin, Freelap, OVR, gates…"><datalist id="nl-srcs">${d.sources.map((s) => html`<option value="${s}">`)}</datalist></div>
        <div class="field"><label class="label" for="nl-key">Device ID or the name it uses</label><input class="input" id="nl-key" autocomplete="off" placeholder="e.g. FL-107 or Coley P"><span class="small muted" id="nl-dup"></span></div>
        <div class="tst-picker"><label class="label" for="nl-q">Athlete</label><input class="input" id="nl-q" autocomplete="off" placeholder="Type a name or Athlete ID"><div class="tst-sugg" hidden></div>
          <p class="small" id="nl-who" style="margin:6px 0 0"></p></div>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Link device', kind: 'primary', onClick: async (body) => {
        if (!athlete) throw new Error('Pick the athlete from the list.');
        return api.post('/testing/links', { source: body.querySelector('#nl-src').value, sender_key: body.querySelector('#nl-key').value, athlete_id: athlete.id });
      } }],
      onMount: (body) => {
        const q = body.querySelector('#nl-q'), who = body.querySelector('#nl-who');
        bindPicker(q, body.querySelector('.tst-sugg'), (a) => {
          athlete = a; body.querySelector('.tst-sugg').hidden = true; q.value = name(a);
          who.textContent = `Linking to ${name(a)} (${a.code}).`;
        });
        // Typing again after a pick means a different athlete: the pick no longer holds.
        q.addEventListener('input', () => { if (athlete) { athlete = null; who.textContent = ''; } });
        // Say so when the device is already linked, since linking it again moves it.
        const dup = () => {
          const src = body.querySelector('#nl-src').value.trim().toLowerCase(), key = body.querySelector('#nl-key').value.trim();
          const l = src && key && d.links.find((x) => x.source.toLowerCase() === src && x.sender_key === key);
          body.querySelector('#nl-dup').textContent = l ? `Already linked to ${l.first_name} ${l.last_name}. Linking it again moves it.` : '';
        };
        body.querySelector('#nl-src').addEventListener('input', dup); body.querySelector('#nl-key').addEventListener('input', dup);
      },
    });
    if (r) { toast(`${r.moved ? 'Link moved' : 'Device linked'}.${r.linked ? ` ${plural(r.linked, 'waiting result')} linked too.` : ''}`); ctx.reload(); }
  });
  ctx.el.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', async () => {
    const l = d.links.find((x) => x.id === Number(b.dataset.move));
    const a = await pickAthleteModal('Change athlete', `Future results from ${l.sender_label || l.sender_key} (${l.source}) will go to the athlete you pick. Results already saved stay where they are.`);
    if (!a) return;
    try { await api.patch(`/testing/links/${l.id}`, { athlete_id: a.id }); toast(`${l.sender_label || l.sender_key} now goes to ${name(a)}.`); ctx.reload(); } catch (err) { toastError(err); }
  }));
  ctx.el.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', async () => {
    const l = d.links.find((x) => x.id === Number(b.dataset.unlink));
    if (!(await confirmDialog('Unlink device', `Future results from ${l.sender_label || l.sender_key} (${l.source}) will wait to be linked again instead of going to ${l.first_name} ${l.last_name}. Results already saved stay in the profile.`, 'Unlink', 'warn'))) return;
    try {
      const r = await api.del(`/testing/links/${l.id}`);
      lastUnlinked = r.link;
      toast('Unlinked.');
      ctx.reload();
    } catch (err) { toastError(err); }
  }));
  ctx.el.querySelector('#undo-unlink')?.addEventListener('click', async () => {
    try {
      await api.post('/testing/links', undoLink);
      toast('Link restored.'); ctx.reload();
    } catch (err) { toastError(err); }
  });
}

// ============ Test library ============
const LIB_STYLE = raw(`<style>
.lib-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.lib-tools .input{min-height:44px}
.lib-tools .lib-q{flex:1;min-width:200px;max-width:380px}
.lib-tools select.input{width:auto;max-width:240px}
.lib-tools .seg button{min-height:44px}
.lib-n{font-weight:400;opacity:.8;margin-left:4px}
.lib-count{margin:0}
.lib-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--line-subtle)}
.lib-row:first-child{border-top:0}
.lib-open{flex:1;min-width:0;text-align:left;background:none;border:0;padding:6px 0;color:inherit;cursor:pointer;font:inherit;min-height:44px;display:flex;flex-direction:column;gap:2px}
.lib-open .strong{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.lib-open:hover .lib-name,.lib-open:focus-visible .lib-name{color:var(--green-soft)}
.lib-desc{font-size:13px;color:var(--steel-muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lib-use{font-size:12px;color:var(--steel-muted)}
.lib-row.is-hidden .lib-name{color:var(--steel-muted)}
.lib-row>.btn,.lib-actions .btn{min-height:44px}
.lib-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.lib-fact{border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px 12px;background:var(--ground)}
.lib-fact .k{font-size:12px;color:var(--steel-muted);display:block}
.lib-fact .v{font-weight:600}
.lib-h{font:600 13px/1 var(--font-sans);letter-spacing:.1em;text-transform:uppercase;color:var(--silver);margin:0 0 8px}
.lib-proto{margin:0;white-space:pre-wrap;border-left:3px solid var(--green-mid);padding:10px 14px;background:var(--ground);border-radius:0 var(--radius-sm) var(--radius-sm) 0}
.lib-board{list-style:none;margin:0;padding:0}
.lib-board li{display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line-subtle)}
.lib-board li:first-child{border-top:0}
.lib-board .no{font:600 18px/1 var(--font-display);color:var(--steel-muted);text-align:center}
.lib-board li:nth-child(-n+3) .no{color:var(--green-bright)}
.lib-board .val{font-variant-numeric:tabular-nums;font-weight:600;text-align:right;white-space:nowrap}
.lib-board a{color:var(--steel);display:flex;align-items:center;min-height:44px;width:fit-content}
.lib-board a+.small{display:block;margin-top:-10px}
.lib-pchips{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.lib-pchip{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);font-size:13px;background:var(--ground)}
.lib-pchip.is-hidden{color:var(--steel-muted);border-style:dashed}
.lib-pedit{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;max-height:320px;overflow:auto}
.lib-pedit li{display:flex;align-items:center;gap:4px;padding:2px 0;border-top:1px solid var(--line-subtle)}
.lib-pedit li:first-child{border-top:0}
.lib-pedit .grow{flex:1;min-width:0}
.lib-pedit button{min-width:44px;min-height:44px;padding:0;justify-content:center}
.lib-found{max-height:232px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-sm)}
.lib-found:empty{display:none}
.lib-found button{display:flex;width:100%;justify-content:space-between;gap:12px;padding:10px 12px;background:none;border:0;border-top:1px solid var(--line-subtle);color:var(--steel);cursor:pointer;text-align:left;min-height:44px;font:inherit}
.lib-found button:first-child{border-top:0}
.lib-found button:hover,.lib-found button:focus-visible{background:var(--green-deep)}
.lib-actions{display:flex;gap:8px;flex-wrap:wrap}
@media (max-width:700px){
  .lib-tools .lib-q{max-width:none;flex-basis:100%}
  .lib-tools select.input{flex:1;max-width:none;min-width:0}
  .lib-tools .seg{width:100%;flex-wrap:nowrap}.lib-tools .seg button{flex:1;padding:0 4px;font-size:13px;white-space:nowrap}
}
</style>`);
const LIB_SHOW = [['all', 'All'], ['active', 'In menus'], ['hidden', 'Hidden'], ['custom', 'Custom']];
const LIB_FILTER = { all: () => true, active: (t) => !t.hidden, hidden: (t) => !!t.hidden, custom: (t) => !!t.custom };
const LIB_AGES = [['', 'All ages'], ['u12', '12 and under'], ['13-14', '13 to 14'], ['15-16', '15 to 16'], ['17-18', '17 to 18'], ['adult', '19 and over']];
const LIB_UNITS = ['s', 'in', 'cm', 'ft', 'm', 'lb', 'kg', 'reps', 'mph', 'km/h', 'W', 'W/kg', 'N', '%', 'deg', 'level', 'ratio'];
const testMeta = (t) => `${t.unit}, ${scoring(t)} · ${plural(t.attempts || 1, 'attempt')}${rangeText(t) ? ` · possible range ${rangeText(t)}` : ''}${t.timed ? ' · stopwatch' : ''}`;
const usageText = (t) => (t.results ? `${plural(t.results, 'result')} from ${plural(t.athletes, 'athlete')} · last ${fmtDate(t.last_used)}` : 'No results yet');

// Add or edit form. Built-in tests keep their name, unit and scoring; a custom test's unit and scoring lock once it has results.
function testForm(t, cats) {
  const builtIn = t.id && !t.custom;
  const hasResults = t.id && t.results > 0;
  const lockName = builtIn, lockKind = builtIn || (t.custom && hasResults);
  const dis = (on) => (on ? raw('disabled') : '');
  return html`<form class="stack" id="nt" novalidate>
    <div class="field"><label class="label" for="nt-n">Name</label><input class="input" id="nt-n" name="name" value="${t.name || ''}" maxlength="60" required ${dis(lockName)} ${lockName ? '' : raw('autofocus')}></div>
    <div class="form-grid">
      <div class="field"><label class="label" for="nt-c">Category</label><input class="input" id="nt-c" name="category" list="nt-cats" value="${t.category || 'Custom'}" maxlength="30">
        <datalist id="nt-cats">${cats.map((c) => html`<option value="${c}"></option>`)}</datalist></div>
      <div class="field"><label class="label" for="nt-u">Unit</label><input class="input" id="nt-u" name="unit" list="nt-units" value="${t.unit || ''}" placeholder="s, in, lb, reps…" maxlength="12" required ${dis(lockKind)}>
        <datalist id="nt-units">${LIB_UNITS.map((u) => html`<option value="${u}"></option>`)}</datalist></div>
      <div class="field"><label class="label" for="nt-s">Scoring</label><select class="input" id="nt-s" name="lower_better" ${dis(lockKind)}>
        <option value="0" ${!t.lower_better ? raw('selected') : ''}>Higher is better</option><option value="1" ${t.lower_better ? raw('selected') : ''}>Lower is better</option></select></div>
      <div class="field"><label class="label" for="nt-a">Attempts</label><input class="input" id="nt-a" name="attempts" type="number" min="1" max="10" value="${t.attempts || 2}"></div>
      <div class="field"><label class="label" for="nt-min">Lowest possible</label><input class="input" id="nt-min" name="min_value" inputmode="decimal" value="${t.min_value ?? ''}"></div>
      <div class="field"><label class="label" for="nt-max">Highest possible</label><input class="input" id="nt-max" name="max_value" inputmode="decimal" value="${t.max_value ?? ''}"></div>
    </div>
    <label class="check tst-handchk"><input type="checkbox" name="timed" ${t.timed ? raw('checked') : ''}> Timed with the stopwatch (tests in seconds)</label>
    <div class="field"><label class="label" for="nt-d">How to run it <span class="muted">(optional)</span></label>
      <textarea class="input" id="nt-d" name="description" rows="3" maxlength="1000" placeholder="Setup, start position, what counts as a good attempt">${t.description || ''}</textarea>
      <span class="hint">Everyone who runs this test sees it in the library.</span></div>
    ${builtIn ? html`<p class="hint" style="margin:0">Built-in tests keep their name, unit and scoring so device imports and past results stay matched.</p>`
    : lockKind ? html`<p class="hint" style="margin:0">Unit and scoring are fixed once a test has results.</p>` : ''}
    <span class="hint">The possible range catches typos, like a broad jump typed in the 40 column.</span></form>`;
}

async function renderLibrary(ctx) {
  let [tests, presets] = await Promise.all([api.get('/tests?all=1'), api.get('/testing/presets')]);
  if (!ctx.isCurrent()) return;
  const oc = canRun(ctx);
  const st = {
    tab: ctx.query.tab === 'presets' ? 'presets' : 'tests', q: ctx.query.q || '', cat: ctx.query.cat || '',
    show: Object.hasOwn(LIB_FILTER, ctx.query.show || '') ? ctx.query.show : 'all', sort: ['used', 'name'].includes(ctx.query.sort) ? ctx.query.sort : '',
  };
  const cats = () => [...new Set(tests.map((t) => t.category))].sort(catSort);
  const setUrl = () => {
    const p = new URLSearchParams();
    if (st.tab !== 'tests') p.set('tab', st.tab);
    if (st.tab === 'tests') { if (st.q) p.set('q', st.q); if (st.cat) p.set('cat', st.cat); if (st.show !== 'all') p.set('show', st.show); if (st.sort) p.set('sort', st.sort); }
    const s = p.toString();
    history.replaceState(history.state, '', `/app/testing/library${s ? '?' + s : ''}`);
  };
  const subText = () => {
    if (st.tab === 'presets') return `${plural(presets.length, 'preset')}. Each one fills in a new testing day's tests in one tap.`;
    const visible = tests.filter((t) => !t.hidden).length;
    return oc ? `${visible} tests ready${visible < tests.length ? `, ${tests.length - visible} hidden` : ''}. Hide the ones you don't use, or add your own.`
      : `${visible} tests. Owners and coaches can change the library.`;
  };
  const refresh = async () => {
    [tests, presets] = await Promise.all([api.get('/tests?all=1'), api.get('/testing/presets')]);
    if (ctx.isCurrent()) paint();
  };

  function paint() {
    const action = !oc ? '' : st.tab === 'presets' ? html`<button class="btn btn-primary" id="new-preset">${icon('plus')}New preset</button>`
      : html`<button class="btn btn-primary" id="add">${icon('plus')}Add a test</button>`;
    mount(ctx.el, html`${STYLE}${LIB_STYLE}${header('Test library', subText(), html`${back()}${action}`)}
      <div class="tabs" role="tablist" aria-label="Test library">
        ${[['tests', 'Tests', tests.length], ['presets', 'Presets', presets.length]].map(([k, l, n]) => html`<button role="tab" id="tab-${k}" data-tab="${k}" aria-controls="lib-panel" aria-selected="${st.tab === k}" tabindex="${st.tab === k ? 0 : -1}">${l}<span class="lib-n">${n}</span></button>`)}
      </div>
      <div id="lib-panel" role="tabpanel" aria-labelledby="tab-${st.tab}" class="stack" style="margin-top:4px"></div>`);
    const tabs = [...ctx.el.querySelectorAll('[data-tab]')];
    const pick = (k) => { if (st.tab === k) return; st.tab = k; setUrl(); paint(); ctx.el.querySelector(`#tab-${k}`)?.focus(); };
    tabs.forEach((b) => {
      b.addEventListener('click', () => pick(b.dataset.tab));
      b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); pick(st.tab === 'tests' ? 'presets' : 'tests'); } });
    });
    ctx.el.querySelector('#add')?.addEventListener('click', () => addTest());
    ctx.el.querySelector('#new-preset')?.addEventListener('click', () => editPreset(null));
    if (st.tab === 'tests') paintTests(); else paintPresets();
  }

  // ---- tests ----
  function paintTests() {
    const panel = ctx.el.querySelector('#lib-panel');
    const counts = Object.fromEntries(LIB_SHOW.map(([k]) => [k, tests.filter(LIB_FILTER[k]).length]));
    mount(panel, html`<div class="lib-tools" role="search">
        <label class="sr-only" for="lq">Find a test</label><input class="input lib-q" id="lq" type="search" placeholder="Find a test" value="${st.q}" autocomplete="off">
        <label class="sr-only" for="lcat">Category</label><select class="input" id="lcat"><option value="">All categories</option>
          ${cats().map((c) => html`<option value="${c}" ${c === st.cat ? raw('selected') : ''}>${c} (${tests.filter((t) => t.category === c).length})</option>`)}</select>
        <label class="sr-only" for="lsort">Sort</label><select class="input" id="lsort">
          ${[['', 'By category'], ['used', 'Most used'], ['name', 'A to Z']].map(([k, l]) => html`<option value="${k}" ${k === st.sort ? raw('selected') : ''}>${l}</option>`)}</select>
        <div class="seg" role="group" aria-label="Show">${LIB_SHOW.map(([k, l]) => html`<button type="button" data-show="${k}" aria-pressed="${st.show === k}">${l}<span class="lib-n">${counts[k]}</span></button>`)}</div>
      </div>
      <p class="small muted lib-count" id="lcount" aria-live="polite"></p>
      <div id="llist" class="stack"></div>`);
    const q = panel.querySelector('#lq');
    q.addEventListener('input', debounce(() => { st.q = q.value; setUrl(); paintList(); }, 120));
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape' && q.value) { e.preventDefault(); q.value = ''; st.q = ''; setUrl(); paintList(); } });
    panel.querySelector('#lcat').addEventListener('change', (e) => { st.cat = e.target.value; setUrl(); paintList(); });
    panel.querySelector('#lsort').addEventListener('change', (e) => { st.sort = e.target.value; setUrl(); paintList(); });
    panel.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => {
      st.show = b.dataset.show; setUrl();
      panel.querySelectorAll('[data-show]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      paintList();
    }));
    panel.querySelector('#llist').addEventListener('click', (e) => {
      const tg = e.target.closest('[data-toggle]');
      if (tg) return toggleHidden(tests.find((t) => t.id === Number(tg.dataset.toggle)));
      const op = e.target.closest('[data-open]');
      if (op) return openTest(Number(op.dataset.open));
      if (e.target.closest('#lclear')) { st.q = ''; st.cat = ''; st.show = 'all'; setUrl(); paintTests(); ctx.el.querySelector('#lq')?.focus(); return; }
      if (e.target.closest('#laddq')) addTest(st.q.trim());
    });
    paintList();
  }

  function paintList() {
    const list = ctx.el.querySelector('#llist');
    if (!list) return;
    const words = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (t) => { const hay = `${t.name} ${t.category} ${t.unit} ${t.description || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); };
    const shown = tests.filter((t) => (!st.cat || t.category === st.cat) && LIB_FILTER[st.show](t) && hit(t));
    ctx.el.querySelector('#lcount').textContent = shown.length === tests.length ? `${plural(tests.length, 'test')}. Select a test to see how it's run and its record board.` : `Showing ${shown.length} of ${plural(tests.length, 'test')}.`;
    if (!shown.length) {
      mount(list, html`<div class="empty stack" style="align-items:center">
        <span>No test matches${st.q.trim() ? html` “${st.q.trim()}”` : ''}${st.cat ? ` in ${st.cat}` : ''}${st.show !== 'all' ? ` (${LIB_SHOW.find(([k]) => k === st.show)[1].toLowerCase()})` : ''}.</span>
        <div class="btn-row" style="justify-content:center"><button type="button" class="btn" id="lclear">Clear the filters</button>
          ${oc && st.q.trim() ? html`<button type="button" class="btn btn-outline" id="laddq">Add “${st.q.trim()}” as a test</button>` : ''}</div></div>`);
      return;
    }
    const row = (t) => html`<div class="lib-row ${t.hidden ? 'is-hidden' : ''}">
      <button type="button" class="lib-open" data-open="${t.id}">
        <span class="strong"><span class="lib-name">${t.name}</span>${t.custom ? html`<span class="badge badge-neutral">Custom</span>` : ''}${t.hidden ? html`<span class="badge badge-muted">Hidden</span>` : ''}</span>
        <span class="small muted">${testMeta(t)}</span>
        ${t.description ? html`<span class="lib-desc">${t.description}</span>` : ''}
        <span class="lib-use">${usageText(t)}${t.presets?.length ? ` · in ${t.presets.join(', ')}` : ''}</span>
      </button>
      ${oc ? html`<button type="button" class="btn btn-ghost btn-sm" data-toggle="${t.id}" aria-label="${t.hidden ? 'Show' : 'Hide'} ${t.name}">${t.hidden ? 'Show' : 'Hide'}</button>` : ''}</div>`;
    if (st.sort) {
      const sorted = [...shown].sort(st.sort === 'used' ? (a, b) => (b.results - a.results) || a.name.localeCompare(b.name) : (a, b) => a.name.localeCompare(b.name));
      mount(list, html`<section class="panel"><h2 class="panel-title">${st.sort === 'used' ? 'Most used' : 'A to Z'}</h2><div>${sorted.map(row)}</div></section>`);
      return;
    }
    const groups = [...new Set(shown.map((t) => t.category))].sort(catSort);
    mount(list, groups.map((c) => {
      const inCat = shown.filter((t) => t.category === c);
      return html`<section class="panel"><h2 class="panel-title">${c} <span class="lib-n small muted">${inCat.length}</span></h2><div>${inCat.map(row)}</div></section>`;
    }));
  }

  async function toggleHidden(t, { focus = true } = {}) {
    if (!t) return;
    try {
      const r = await api.patch(`/tests/${t.id}`, { hidden: !t.hidden });
      t.hidden = r.hidden;
      toast(t.hidden ? `${t.name} hidden. It stays out of your menus until you show it again.` : `${t.name} is back in your menus.`);
      const sub = ctx.el.querySelector('.page-sub'); if (sub) sub.textContent = subText();
      if (st.tab === 'tests') {
        const counts = Object.fromEntries(LIB_SHOW.map(([k]) => [k, tests.filter(LIB_FILTER[k]).length]));
        ctx.el.querySelectorAll('[data-show]').forEach((b) => { const n = b.querySelector('.lib-n'); if (n) n.textContent = counts[b.dataset.show]; });
        paintList();
        if (focus) (ctx.el.querySelector(`[data-toggle="${t.id}"]`) || ctx.el.querySelector('#lq'))?.focus();
      }
    } catch (err) { toastError(err); }
  }

  async function addTest(prefill = '') {
    const r = await modal({
      title: 'Add a test',
      body: testForm({ name: prefill, category: st.cat || 'Custom', attempts: 2 }, cats()),
      actions: [{ label: 'Cancel', value: null }, { label: 'Add test', kind: 'primary', onClick: async (body) => api.post('/tests', formData(body.querySelector('#nt'))) }],
    });
    if (!r) return;
    toast(`${r.name} added. It's in your menus now.`);
    await refresh();
  }

  async function editTest(t) {
    const r = await modal({
      title: `Edit ${t.name}`,
      body: testForm(t, cats()),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save changes', kind: 'primary', onClick: async (body) => api.patch(`/tests/${t.id}`, formData(body.querySelector('#nt'))) }],
    });
    if (!r) return;
    toast(`${r.name} saved.`);
    await refresh();
  }

  async function openTest(id) {
    let d;
    try { d = await api.get(`/tests/${id}`); } catch (err) { return toastError(err); }
    const t = tests.find((x) => x.id === id) || d;
    const filt = { sex: '', age: '' };
    const boardHtml = (b) => (b.board.length ? html`<ol class="lib-board">${b.board.map((r, i) => html`<li><span class="no" aria-label="Rank ${i + 1}">${i + 1}</span>
        <span><a href="/app/clients/${r.athlete_id}">${r.first_name} ${r.last_name}</a><span class="small muted">${fmtDate(r.date)}${r.hand_timed && b.unit === 's' ? ' · hand-timed' : ''}</span></span>
        <span class="val">${fmtValue(r.value, b.unit)}</span></li>`)}</ol>`
      : html`<p class="small muted" style="margin:0">No results yet${filt.sex || filt.age ? ' for this group' : ''}.</p>`);
    const u = d.usage;
    const actions = [{ label: 'Close', value: null }];
    if (oc) {
      if (d.deletable) actions.push({ label: 'Delete test', value: 'delete' });
      actions.push({ label: d.hidden ? 'Show in menus' : 'Hide from menus', value: 'toggle' });
      actions.push({ label: 'Edit test', value: 'edit', kind: 'primary' });
    }
    const v = await modal({
      title: d.name, wide: true, actions,
      body: html`<div class="tst-badges" style="flex-wrap:wrap;outline:none" tabindex="-1" autofocus><span class="badge badge-neutral">${d.category}</span>${d.custom ? html`<span class="badge badge-neutral">Custom</span>` : ''}${d.hidden ? html`<span class="badge badge-muted">Hidden</span>` : ''}</div>
        <section><h3 class="lib-h">How to run it</h3>${d.description ? html`<p class="lib-proto">${d.description}</p>`
          : html`<p class="small muted" style="margin:0">No protocol written yet.${oc ? ' Edit the test to add one, so every coach runs it the same way.' : ''}</p>`}</section>
        <div class="lib-facts">
          <div class="lib-fact"><span class="k">Unit</span><span class="v">${d.unit}</span></div>
          <div class="lib-fact"><span class="k">Scoring</span><span class="v">${d.lower_better ? 'Lower is better' : 'Higher is better'}</span></div>
          <div class="lib-fact"><span class="k">Attempts</span><span class="v">${d.attempts || 1}</span></div>
          <div class="lib-fact"><span class="k">Possible range</span><span class="v">${rangeText(d) || 'Any value'}</span></div>
          <div class="lib-fact"><span class="k">Entry</span><span class="v">${d.timed ? 'Stopwatch or typed' : 'Typed or imported'}</span></div>
        </div>
        <p class="small muted" style="margin:0">${u.results ? `${plural(u.results, 'result')} from ${plural(u.athletes, 'athlete')}${u.days ? ` on ${plural(u.days, 'testing day')}` : ''} · last used ${fmtDate(u.last_used)}.` : 'No results yet.'}
          ${d.presets.length ? ` In the ${d.presets.join(', ')} preset${d.presets.length === 1 ? '' : 's'}.` : ' Not in any preset.'}</p>
        <section class="stack" style="gap:10px"><h3 class="lib-h" style="margin:0">Record board</h3>
          <div class="lib-tools"><div class="seg" role="group" aria-label="Filter the record board">${[['', 'Everyone'], ['M', 'Male'], ['F', 'Female']].map(([k, l]) => html`<button type="button" data-sex="${k}" aria-pressed="${k === ''}">${l}</button>`)}</div>
            <label class="sr-only" for="bage">Age</label><select class="input" id="bage">${LIB_AGES.map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></div>
          <div id="board" aria-live="polite">${boardHtml(d)}</div>
          <span class="hint">Each athlete's best, ${d.lower_better ? 'lowest' : 'highest'} first. Archived athletes are left out.</span></section>`,
      onMount: (body, close) => {
        body.addEventListener('click', (e) => { if (e.target.closest('a[href]')) close(null); });
        const load = async () => {
          const qs = new URLSearchParams(Object.entries(filt).filter(([, x]) => x)).toString();
          try { const b = await api.get(`/tests/${id}${qs ? '?' + qs : ''}`); mount(body.querySelector('#board'), boardHtml(b)); } catch (err) { toastError(err); }
        };
        body.querySelectorAll('[data-sex]').forEach((b) => b.addEventListener('click', () => {
          filt.sex = b.dataset.sex; body.querySelectorAll('[data-sex]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); load();
        }));
        body.querySelector('#bage').addEventListener('change', (e) => { filt.age = e.target.value; load(); });
      },
    });
    if (v === 'edit') return editTest({ ...t, ...d, results: u.results });
    if (v === 'toggle') return toggleHidden(t, { focus: false });
    if (v === 'delete') {
      if (!(await confirmDialog(`Delete ${d.name}?`, 'It comes out of the library and any presets. It has no results, so nothing else changes.', 'Delete test'))) return;
      try { await api.del(`/tests/${d.id}`); toast(`${d.name} deleted.`); await refresh(); } catch (err) { toastError(err); }
    }
  }

  // ---- presets ----
  function paintPresets() {
    const panel = ctx.el.querySelector('#lib-panel');
    if (!presets.length) {
      mount(panel, html`<div class="empty">No presets yet.${oc ? ' New preset groups the tests you run together, like a combine or a team battery.' : ''}</div>`);
      return;
    }
    mount(panel, html`${presets.map((p, i) => {
      const hidden = p.tests.filter((t) => t.hidden).length;
      return html`<section class="panel"><div class="spread"><div><h2 class="panel-title">${p.name}</h2>
          <p class="small muted" style="margin:4px 0 0">${plural(p.tests.length, 'test')}, in the order they run${hidden ? html` · <span style="color:var(--amber)">${hidden} hidden, skipped when you plan a day</span>` : ''}</p></div>
        ${oc ? html`<div class="lib-actions"><a class="btn btn-sm" href="/app/testing/new?preset=${encodeURIComponent(p.name)}">Plan a day with it</a>
          <button type="button" class="btn btn-ghost btn-sm" data-pedit="${i}" aria-label="Edit ${p.name}">Edit</button>
          <button type="button" class="btn btn-ghost btn-sm" data-pcopy="${i}" aria-label="Copy ${p.name}">Copy</button>
          <button type="button" class="btn btn-ghost btn-sm" data-pdel="${i}" aria-label="Delete ${p.name}">Delete</button></div>` : ''}</div>
        <ol class="lib-pchips">${p.tests.map((t, j) => html`<li class="lib-pchip ${t.hidden ? 'is-hidden' : ''}"><span class="muted">${j + 1}.</span> ${t.name}${t.hidden ? ' (hidden)' : ''}</li>`)}</ol></section>`;
    })}`);
    panel.querySelectorAll('[data-pedit]').forEach((b) => b.addEventListener('click', () => editPreset(presets[+b.dataset.pedit])));
    panel.querySelectorAll('[data-pcopy]').forEach((b) => b.addEventListener('click', () => editPreset(presets[+b.dataset.pcopy], { copy: true })));
    panel.querySelectorAll('[data-pdel]').forEach((b) => b.addEventListener('click', async () => {
      const p = presets[+b.dataset.pdel];
      if (!(await confirmDialog(`Delete the ${p.name} preset?`, 'Testing days already planned with it keep their tests.', 'Delete preset'))) return;
      try { await api.del(`/testing/presets/${encodeURIComponent(p.name)}`); toast(`${p.name} preset deleted.`); await refresh(); } catch (err) { toastError(err); }
    }));
  }

  async function editPreset(p, { copy = false } = {}) {
    const editing = p && !copy;
    const sel = p ? p.tests.map((t) => t.id) : [];
    const byId = new Map(tests.map((t) => [t.id, t]));
    const r = await modal({
      title: editing ? `Edit ${p.name}` : copy ? `Copy ${p.name}` : 'New preset', wide: true,
      body: html`<div class="field"><label class="label" for="pe-n">Name</label><input class="input" id="pe-n" value="${p ? (copy ? `${p.name} copy` : p.name) : ''}" maxlength="40" placeholder="Like Spring baseball or U14 soccer" autofocus></div>
        <div class="field"><span class="label" id="pe-l">Tests, in the order they run <span class="muted" id="pe-c"></span></span><ol class="lib-pedit" id="pe-list" aria-labelledby="pe-l"></ol></div>
        <div class="field"><label class="label" for="pe-q">Add a test</label><input class="input" id="pe-q" type="search" placeholder="Find a test, like broad jump or exit velocity" autocomplete="off">
          <span class="hint">Enter adds the first match. Hidden tests aren't offered.</span><div class="lib-found" id="pe-found" role="list"></div></div>`,
      actions: [{ label: 'Cancel', value: null }, {
        label: editing ? 'Save preset' : 'Add preset', kind: 'primary',
        onClick: async (body) => {
          const payload = { name: body.querySelector('#pe-n').value, test_ids: sel };
          return editing ? api.put(`/testing/presets/${encodeURIComponent(p.name)}`, payload) : api.post('/testing/presets', payload);
        },
      }],
      onMount: (body) => {
        const list = body.querySelector('#pe-list'), q = body.querySelector('#pe-q'), found = body.querySelector('#pe-found');
        const matches = () => {
          const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
          if (!words.length) return [];
          return tests.filter((t) => !t.hidden && !sel.includes(t.id) && words.every((w) => `${t.name} ${t.category}`.toLowerCase().includes(w))).slice(0, 8);
        };
        const paintSel = (focusSel) => {
          body.querySelector('#pe-c').textContent = `(${sel.length})`;
          mount(list, sel.length ? sel.map((id, i) => { const t = byId.get(id); return html`<li><span class="grow"><span class="muted">${i + 1}.</span> ${t?.name || 'Test'}${t?.hidden ? html` <span class="badge badge-muted">Hidden</span>` : ''}</span>
            <button type="button" class="btn btn-ghost" data-up="${i}" aria-label="Move ${t?.name} earlier" ${i === 0 ? raw('disabled') : ''}>↑</button>
            <button type="button" class="btn btn-ghost" data-down="${i}" aria-label="Move ${t?.name} later" ${i === sel.length - 1 ? raw('disabled') : ''}>↓</button>
            <button type="button" class="btn btn-ghost tst-rm" data-rm="${i}" aria-label="Remove ${t?.name}">${icon('close', 16)}</button></li>`; })
            : html`<li class="small muted" style="padding:10px 0">No tests yet. Find tests below to add them.</li>`);
          if (focusSel) list.querySelector(focusSel)?.focus();
        };
        const paintFound = () => {
          const m = matches();
          mount(found, q.value.trim() && !m.length ? html`<p class="small muted" style="margin:0;padding:10px 12px">No test matches. Hidden tests and tests already added aren't listed.</p>`
            : m.map((t) => html`<button type="button" role="listitem" data-add="${t.id}"><span>${t.name}</span><span class="small muted">${t.category} · ${t.unit}</span></button>`));
        };
        list.addEventListener('click', (e) => {
          const b = e.target.closest('button'); if (!b) return;
          const focusMoved = (j, dir) => { const pref = list.querySelector(`[data-${dir}="${j}"]:not([disabled])`); (pref || list.querySelector(`[data-${dir === 'up' ? 'down' : 'up'}="${j}"]`))?.focus(); };
          if (b.dataset.up) { const i = +b.dataset.up; [sel[i - 1], sel[i]] = [sel[i], sel[i - 1]]; paintSel(); focusMoved(i - 1, 'up'); }
          else if (b.dataset.down) { const i = +b.dataset.down; [sel[i + 1], sel[i]] = [sel[i], sel[i + 1]]; paintSel(); focusMoved(i + 1, 'down'); }
          else if (b.dataset.rm) { const i = +b.dataset.rm; sel.splice(i, 1); paintSel(`[data-rm="${Math.min(i, sel.length - 1)}"]`); paintFound(); if (!sel.length) q.focus(); }
        });
        const add = (id) => { if (!sel.includes(id)) sel.push(id); paintSel(); q.value = ''; paintFound(); q.focus(); };
        found.addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (b) add(Number(b.dataset.add)); });
        q.addEventListener('input', paintFound);
        q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const m = matches(); if (m[0]) add(m[0].id); } });
        paintSel();
      },
    });
    if (!r) return;
    toast(editing ? `${r.name} saved.` : `${r.name} preset added with ${plural(r.tests, 'test')}.`);
    await refresh();
  }

  paint();
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
