// Progress: shared test results in plain language, from GET /api/parent/athletes/:id/progress.
// Period (all, last 12 months, since a testing day) and "change since first or last test" are remembered while the
// app is open. Tap a test for every result, what it measures and how it's tested. Share a link to the report here.
import { html, raw, mount, api, toast, toastError, modal, fmtDate, icon, plural } from '/js/ui.js';
import { fmtValue, fmtChange, trendSvg } from '/js/testing-format.js';
import { header, athletePills, bindAthletePills } from '../common.js';

const openTests = new Set(); // tests opened while the app is open
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const periodKey = (id) => `dp_pp_period_${id}`;
const COMPARE_KEY = 'dp_pp_compare';
const svg = (d, size = 18) => raw(`<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true"><path d="${d}"/></svg>`);
const CAL = 'M3 4h14v13H3zM3 8h14M7 2v4M13 2v4';
const SHARE = 'M10 12V2M6 6l4-4 4 4M5 9H3v9h14V9h-2';

function growthText(g) {
  const off = g.maturity_offset != null ? Number(g.maturity_offset) : null;
  if (off == null) return { label: g.status || null, note: null };
  const yrs = Math.abs(off).toFixed(1);
  if (off < -0.5) return { label: 'Before the growth spurt', note: `About ${yrs} years before the fastest growth. Keep training focused on skill, speed and movement quality. This is an estimate and can be off by about a year.` };
  if (off <= 0.5) return { label: 'In the growth spurt', note: 'Growing fastest right now. Coordination can dip for a while and knees and heels can get sore; that\'s normal. Tell your coach if anything hurts. This is an estimate and can be off by about a year.' };
  return { label: 'Past the growth spurt', note: `About ${yrs} years past the fastest growth. Strength gains usually come more easily from here. This is an estimate and can be off by about a year.` };
}

// Change for one test: since the first result in the period, or since the result before the latest.
export function changeOf(t, compare) {
  const h = t.history || [];
  if (h.length < 2) return null;
  const base = compare === 'last' ? h[h.length - 2] : h[0];
  const latest = h[h.length - 1];
  const diff = Math.round((latest.value - base.value) * 1000) / 1000;
  const better = t.category !== 'Body' && diff !== 0 && (t.lower_better ? diff < 0 : diff > 0);
  const pct = base.value ? ((t.lower_better ? base.value - latest.value : latest.value - base.value) / Math.abs(base.value)) * 100 : 0;
  return { diff, better, pct: Math.round(pct * 10) / 10, from: base, to: latest };
}
// Biggest improvements in the chosen comparison (Body measurements aren't improvements).
export function improvementsOf(tests, compare) {
  return tests.filter((t) => t.category !== 'Body').map((t) => ({ t, c: changeOf(t, compare) }))
    .filter((x) => x.c && x.c.pct > 0).sort((x, y) => y.c.pct - x.c.pct).slice(0, 3);
}

function rankText(r, unit) {
  const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  if (r.rank === 1) return `Best result in ${r.group}`;
  if (r.percentile >= 25) return `${unit === 's' ? 'Faster than' : 'Ahead of'} ${r.percentile}% of ${r.group}`;
  return `${ord(r.rank)} of ${r.of} in ${r.group}`;
}
const bar = (pct, label) => html`<div class="bar eg-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${label}"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`;
const dayText = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// Every result for one test, newest first, with the change from the one before and the best marked.
function historyTable(t) {
  const h = [...(t.history || [])].reverse();
  return html`<table class="eg-hist"><caption class="sr-only">${t.name}, every result</caption>
    <thead><tr><th scope="col">Date</th><th scope="col">Result</th><th scope="col"><span class="sr-only">Change from the one before</span></th></tr></thead>
    <tbody>${h.map((x, i) => {
      const prev = h[i + 1];
      const diff = prev ? Math.round((x.value - prev.value) * 1000) / 1000 : null;
      const better = diff != null && diff !== 0 && t.category !== 'Body' && (t.lower_better ? diff < 0 : diff > 0);
      return html`<tr><td>${fmtDate(x.date)}</td><td class="strong">${fmtValue(x.value, t.unit)}${x.value === t.best && t.count > 1 && t.category !== 'Body' ? html` <span class="good-text small">Best</span>` : ''}</td>
        <td class="small ${better ? 'good-text' : 'muted'}">${diff != null && diff !== 0 ? fmtChange(diff, t.unit) : diff === 0 ? 'Same' : ''}</td></tr>`;
    })}</tbody></table>`;
}

function sizeTile(t, label) {
  const grew = t.count > 1 ? Math.round((t.latest - t.first) * 10) / 10 : null;
  return html`<div class="imp"><div class="imp-v pp-plain">${fmtValue(t.latest, t.unit)}</div>
    <div class="imp-l">${label}${grew != null ? `, ${grew ? fmtChange(grew, t.unit) : 'no change'} since ${fmtDate(t.history[0].date, { year: false })}` : ''}</div>
    ${t.count > 1 ? raw(trendSvg(t.history, false, { w: 120, h: 28, color: 'var(--steel-muted)' })) : ''}</div>`;
}

export async function render(ctx) {
  const a = ctx.athlete;
  if (!a) { mount(ctx.el, html`${header('Progress', ctx.familyName)}<div class="empty">Add an athlete on the Family tab first.</div>`); return; }
  let periodVal = store.get(periodKey(a.id)) || 'all';
  const compare = store.get(COMPARE_KEY) === 'last' ? 'last' : 'first';
  const q = (v) => (v.startsWith('since:') ? `since=${encodeURIComponent(v.slice(6))}` : `period=${encodeURIComponent(v)}`);
  let p = null;
  try { p = await api.get(`/parent/athletes/${a.id}/progress?${q(periodVal)}`); }
  catch (e) {
    // A remembered testing day that no longer applies: fall back to every result.
    if (e.status === 400 && periodVal !== 'all') { periodVal = 'all'; store.set(periodKey(a.id), 'all'); p = await api.get(`/parent/athletes/${a.id}/progress?period=all`); }
    else if (e.status !== 404) throw e;
  }
  if (!ctx.isCurrent()) return;
  const top = html`${header('Progress', ctx.familyName)}${athletePills(ctx)}`;
  const next = p?.next_testing;
  const nextLine = next ? html`<div class="banner info pp-next"><span class="pp-next-in">${svg(CAL)}<span>Next testing day: <span class="strong">${next.name}</span>, ${dayText(next.date)}.</span></span></div>` : '';
  const tests = (p?.tests || []).filter((t) => t.count > 0 || t.best != null);
  const everShared = (p?.all_days || []).length > 0 || tests.length > 0;
  if (!p || (!everShared && !p.note && !p.growth)) {
    mount(ctx.el, html`${top}${nextLine}
      <section class="panel"><h2 class="panel-title">No shared results yet</h2>
        <p class="muted" style="margin:0">${next ? `After ${a.first_name}'s testing day on ${dayText(next.date)}, your coach shares the results here: every test, what changed and any new PRs.`
          : `After ${a.first_name}'s first testing day, your coach shares the results here: every test, what changed and any new PRs.`}</p>
        ${next ? '' : html`<p class="muted" style="margin:0">An evaluation is the quickest way to get a starting point.</p><div><a class="btn" href="/parent/book?kind=evaluation">Book an evaluation</a></div>`}
      </section>`);
    bindAthletePills(ctx);
    return;
  }

  const prs = p.prs || [];
  const targets = p.targets || [];
  const ranks = Array.isArray(p.rankings) && p.rankings.length ? p.rankings : null;
  const g = p.growth;
  const gt = g ? growthText(g) : null;
  const imps = improvementsOf(tests, compare);
  const days = p.all_days || [];
  const multi = tests.some((t) => t.count > 1) || days.length > 1;
  const cats = [];
  for (const t of tests) { let c = cats.find((x) => x.name === (t.category || 'Other')); if (!c) cats.push(c = { name: t.category || 'Other', items: [] }); c.items.push(t); }
  const code = p.athlete?.code || a.code;
  const reportHref = `/report/${encodeURIComponent(code)}${p.period?.from ? `?from=${p.period.from}` : ''}`;
  const H = tests.find((t) => t.name === 'Height'), W = tests.find((t) => t.name === 'Weight');
  const sinceWord = compare === 'last' ? 'since the last test' : p.period?.from ? 'since the first test in this period' : 'since the first test';

  mount(ctx.el, html`${top}${nextLine}
    ${tests.length ? html`<div class="eg-summary">
      <div><div class="eg-sum-v">${tests.length}</div><div class="eg-sum-l">${tests.length === 1 ? 'test' : 'tests'}</div></div>
      <div><div class="eg-sum-v ${prs.length ? 'good' : ''}">${prs.length}</div><div class="eg-sum-l">new ${prs.length === 1 ? 'PR' : 'PRs'}</div></div>
      <div><div class="eg-sum-v word">${p.last_date ? fmtDate(p.last_date, { year: false }) : '—'}</div><div class="eg-sum-l">last tested</div></div>
    </div>` : ''}
    ${multi ? html`<section class="pp-controls" aria-label="What to show">
      <div class="field"><label class="label" for="pp-period">Showing</label>
        <select class="input" id="pp-period">
          <option value="all" ${periodVal === 'all' ? raw('selected') : ''}>All results</option>
          <option value="12m" ${periodVal === '12m' ? raw('selected') : ''}>Last 12 months</option>
          ${days.filter((d, i) => (i > 0 && i < days.length - 1) || periodVal === `since:${d.id}`).map((d) => html`<option value="since:${d.id}" ${periodVal === `since:${d.id}` ? raw('selected') : ''}>Since ${d.name} (${fmtDate(d.date, { year: false })})</option>`)}
        </select></div>
      <div class="field"><span class="label" id="pp-cmp-l">Change since</span>
        <div class="seg pp-seg" role="group" aria-labelledby="pp-cmp-l">
          <button type="button" data-compare="first" aria-pressed="${String(compare === 'first')}">First test</button>
          <button type="button" data-compare="last" aria-pressed="${String(compare === 'last')}">Last test</button>
        </div></div>
    </section>` : ''}
    ${p.note?.text ? html`<section class="panel">
      <div><h2 class="panel-title">From your coach</h2><p class="panel-sub">${[p.note.day_name, p.note.date ? fmtDate(p.note.date) : null].filter(Boolean).join(' · ')}</p></div>
      <p class="note-text">${p.note.text}</p></section>` : ''}
    ${!tests.length ? html`<section class="panel"><p class="muted" style="margin:0">No results in this period. Pick All results to see everything.</p></section>` : ''}
    ${imps.length ? html`<section class="panel"><div><h2 class="panel-title">Biggest improvements</h2><p class="panel-sub">${sinceWord[0].toUpperCase() + sinceWord.slice(1)}.</p></div>
      <div class="imps ${imps.length === 2 ? 'two' : imps.length === 1 ? 'one' : ''}">${imps.map(({ t, c }) => html`<div class="imp"><div class="imp-v">+${c.pct.toFixed(1)}%</div><div class="imp-l pp-imp-name">${t.name}</div>
        <div class="imp-l">${fmtValue(c.from.value, t.unit)} → ${fmtValue(c.to.value, t.unit)}</div></div>`)}</div></section>`
      : tests.length && multi ? html`<section class="panel"><h2 class="panel-title">Biggest improvements</h2><p class="muted" style="margin:0">${!tests.some((t) => t.count > 1) ? 'Only one result for each test in this period, so there is nothing to compare yet. Pick All results to see the change over time.' : compare === 'last' ? 'No gains since the last test. Results move around from one day to the next; the trend over a season is what counts.' : 'Nothing has improved in this period yet. The next testing day will show the trend.'}</p></section>` : ''}
    ${prs.length ? html`<section class="panel" aria-labelledby="pp-pr-h"><div><h2 class="panel-title" id="pp-pr-h">New PRs</h2><p class="panel-sub">Personal records from the latest testing.</p></div>
      <div class="eg-prs">${prs.map((r) => html`<div class="eg-pr"><span class="eg-pr-v">${fmtValue(r.value, r.unit)}</span><span class="eg-pr-l">${r.test}</span><span class="muted small">${fmtDate(r.date, { year: false })}</span></div>`)}</div></section>` : ''}
    ${targets.length ? html`<section class="panel" aria-labelledby="pp-tg-h"><div><h2 class="panel-title" id="pp-tg-h">Targets</h2>
      <p class="panel-sub">Set by the coach. Best result so far, then the target.</p></div>
      <div class="list">${targets.map((t) => html`<div class="eg-goal">
        <div class="spread"><span class="strong">${t.test}</span>${t.reached ? html`<span class="badge badge-good">${icon('check', 12)} Reached</span>` : html`<span class="muted">${t.pct}%</span>`}</div>
        <div class="eg-tg-vals"><span>${t.best_text || 'Not tested yet'}</span><span class="muted" aria-hidden="true">→</span><span class="sr-only">target</span><span class="strong">${t.target_text}</span>
          ${t.due_date && !t.reached ? html`<span class="${t.overdue ? 'warn-text' : 'muted'} small">${t.overdue ? 'was due' : 'by'} ${fmtDate(t.due_date, { year: false })}</span>` : ''}</div>
        ${bar(t.pct, `${t.test}: ${t.pct}% of the way to the target`)}
        ${t.to_go_text ? html`<span class="muted small">${t.to_go_text}${t.lower_better ? ' · lower is better' : ''}</span>` : ''}
      </div>`)}</div></section>` : ''}
    ${ranks ? html`<section class="panel" aria-labelledby="pp-rk-h"><div><h2 class="panel-title" id="pp-rk-h">How ${a.first_name} compares</h2>
      <p class="panel-sub">Best results only. No names are shown to anyone.</p></div>
      <div class="list">${ranks.map((r) => html`<div class="eg-rank"><div class="spread"><span class="strong">${r.test}</span><span class="muted">Best ${fmtValue(r.best, r.unit)}</span></div>
        <ul>${r.ranks.map((x) => html`<li>${rankText(x, r.unit)}</li>`)}</ul></div>`)}</div></section>` : ''}
    ${tests.length ? html`<section class="panel" aria-labelledby="pp-all-h"><div><h2 class="panel-title" id="pp-all-h">Every test</h2>
      <p class="panel-sub">Best result and change ${sinceWord}. Tap a test for every result and how it's tested.</p></div>
      <div class="list">${cats.map((c) => html`${cats.length > 1 ? html`<div class="eg-cat">${c.name}</div>` : ''}${c.items.map((t) => {
        const ch = changeOf(t, compare);
        const body = t.category === 'Body';
        const open = openTests.has(t.test_id);
        const isPr = prs.some((r) => r.test === t.name);
        return html`<div class="eg-tblock"><button type="button" class="eg-trow" data-test="${t.test_id}" aria-expanded="${String(open)}" aria-controls="pp-th-${t.test_id}">
          <span><span class="strong eg-tname">${t.name}${isPr ? html` <span class="badge badge-good">PR</span>` : ''}</span>
            <span class="muted small">${ch ? `${fmtValue(ch.from.value, t.unit)} → ${fmtValue(ch.to.value, t.unit)}` : `Tested once${t.history?.[0]?.date ? `, ${fmtDate(t.history[0].date)}` : ''}`}${!body && t.lower_better ? ' · lower is better' : ''}</span></span>
          <span>${raw(trendSvg(t.history, t.lower_better && !body, { w: 84, h: 28, ...(body ? { color: 'var(--steel-muted)' } : {}) }))}</span>
          <span class="eg-tbest"><span class="sr-only">${body ? 'Latest' : 'Best'}</span>${fmtValue(body ? t.latest : t.best, t.unit)}${ch ? html`<span class="${ch.better ? 'good-text' : 'muted'}">${ch.diff !== 0 ? fmtChange(ch.diff, t.unit) : 'Same'}</span>` : ''}</span>
        </button>
        <div id="pp-th-${t.test_id}" class="eg-thist pp-thist" ${open ? '' : raw('hidden')}>
          ${t.means ? html`<p class="pp-means">${t.means}${!body ? ` ${t.lower_better ? 'Lower is better.' : 'Higher is better.'}` : ''}</p>` : ''}
          ${historyTable(t)}
          ${t.how ? html`<p class="small muted pp-how"><span class="strong">How it's tested:</span> ${t.how}</p>` : ''}
          ${t.hand_timed && t.unit === 's' ? html`<p class="small muted pp-how">Hand-timed. Hand times read a little faster than electronic timing.</p>` : ''}
        </div></div>`;
      })}`)}</div></section>` : ''}
    ${g || H || W ? html`<section class="panel" aria-labelledby="pp-gr-h"><h2 class="panel-title" id="pp-gr-h">Growth</h2>
      <div class="imps two">
        ${H ? sizeTile(H, 'Height') : ''}
        ${W ? sizeTile(W, 'Weight') : ''}
        ${gt?.label ? html`<div class="imp" style="grid-column:1/-1"><div class="strong" style="font-size:17px;line-height:22px">${gt.label}</div>${g.phv_age ? html`<div class="imp-l">Fastest growth estimated around age ${Number(g.phv_age).toFixed(1)}${g.age ? `. ${a.first_name} was ${Number(g.age).toFixed(1)} when last measured.` : ''}</div>` : ''}</div>` : ''}
      </div>
      ${gt?.note ? html`<p class="muted" style="margin:0">${gt.note}</p>` : html`<p class="muted small" style="margin:0">The growth-spurt estimate shows once birthday, sex, height, seated height and weight are all on file. Birthday and sex are on the Family tab.</p>`}
    </section>` : ''}
    ${tests.length ? html`<div class="pp-actions">
      <a class="btn" href="${reportHref}" target="_blank" rel="noopener">${icon('print', 18)} Printable report</a>
      <button type="button" class="btn" id="pp-share">${svg(SHARE)} Share a link</button>
    </div>` : ''}`);
  bindAthletePills(ctx);

  // Period and comparison
  ctx.el.querySelector('#pp-period')?.addEventListener('change', (e) => { store.set(periodKey(a.id), e.target.value); rerender(ctx, '#pp-period'); });
  ctx.el.querySelectorAll('[data-compare]').forEach((b) => { b.onclick = () => {
    if (b.dataset.compare === compare) return;
    store.set(COMPARE_KEY, b.dataset.compare);
    rerender(ctx, `[data-compare="${b.dataset.compare}"]`);
  }; });
  // Open a test in place
  ctx.el.querySelectorAll('[data-test]').forEach((b) => { b.onclick = () => {
    const id = Number(b.dataset.test);
    const open = !openTests.has(id);
    if (open) openTests.add(id); else openTests.delete(id);
    b.setAttribute('aria-expanded', String(open));
    ctx.el.querySelector(`#pp-th-${id}`).hidden = !open;
  }; });
  ctx.el.querySelector('#pp-share')?.addEventListener('click', () => shareDialog(a, code));
}

// Redraw in place: keeps the scroll position and focus on the control that was used.
async function rerender(ctx, focusSel) {
  const y = window.scrollY;
  try { await render(ctx); } catch (e) { toastError(e); return; }
  window.scrollTo(0, y);
  ctx.el.querySelector(focusSel)?.focus();
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied.'); }
  catch { toast('Select the link and copy it.', 'warn'); }
}

// Share a private link to the report (family view: shared results only, no birthday), and turn old ones off.
async function shareDialog(a, code) {
  const base = `/report/${encodeURIComponent(code)}/links`;
  let links = [];
  try { links = await api.get(base); } catch (err) { return toastError(err); }
  const canSend = typeof navigator.share === 'function';
  const listHtml = () => (links.length ? html`<ul class="pp-links">${links.map((l) => html`<li>
      <div class="grow"><div class="strong">${l.label || 'Link'}</div><div class="small muted">Works until ${fmtDate(l.expires_at.slice(0, 10))} · ${l.views ? `opened ${plural(l.views, 'time')}` : 'not opened yet'}${l.created_by ? ` · made by ${l.created_by}` : ''}</div></div>
      <button type="button" class="btn btn-sm" data-copy="${l.id}" aria-label="Copy the link${l.label ? ` for ${l.label}` : ''}">Copy</button>
      <button type="button" class="btn btn-ghost btn-sm" data-off="${l.id}" aria-label="Turn off ${l.label || 'this link'}">Turn off</button></li>`)}</ul>`
    : html`<p class="small muted" style="margin:0">No working links yet.</p>`);
  await modal({
    title: 'Share a link',
    body: html`<p style="margin:0">Send ${a.first_name}'s report to a college coach, a school or family who don't have a sign-in. They see only shared results and ${a.first_name}'s age, never the birthday.</p>
      <form class="stack" id="nl" novalidate>
        <div class="field"><label class="label" for="nl-l">Who's it for <span class="muted">(optional)</span></label><input class="input" id="nl-l" name="label" maxlength="60" placeholder="Like BYU recruiting" autocomplete="off"></div>
        <div class="field"><label class="label" for="nl-d">Works for</label><select class="input" id="nl-d" name="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></div>
        <div><button class="btn btn-primary" id="nl-go">Make a link</button></div>
        <div id="nl-new" aria-live="polite"></div>
      </form>
      <div class="stack" style="gap:8px"><h3 class="sec-label strong">Working links</h3><div id="nl-list">${listHtml()}</div></div>`,
    actions: [{ label: 'Done', value: null }],
    onMount: (body) => {
      const f = body.querySelector('#nl');
      const paint = () => mount(body.querySelector('#nl-list'), listHtml());
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = f.querySelector('#nl-go'); btn.disabled = true;
        try {
          const l = await api.post(base, { label: f.label.value, days: Number(f.days.value) });
          links.unshift(l); paint();
          mount(body.querySelector('#nl-new'), html`<div class="field"><label class="label" for="nl-url">Your new link</label>
            <input class="input mono pp-url" id="nl-url" readonly value="${l.url}">
            <div class="btn-row">${canSend ? html`<button type="button" class="btn" id="nl-send">Send</button>` : ''}<button type="button" class="btn" id="nl-copy">Copy link</button></div></div>`);
          const u = body.querySelector('#nl-url'); u.focus(); u.select();
          body.querySelector('#nl-copy').onclick = () => copy(l.url);
          body.querySelector('#nl-send')?.addEventListener('click', () => navigator.share({ title: `${a.first_name}'s progress report`, url: l.url }).catch(() => {}));
          f.label.value = '';
        } catch (err) { toastError(err); } finally { btn.disabled = false; }
      });
      body.querySelector('#nl-list').addEventListener('click', async (e) => {
        const c = e.target.closest('[data-copy]');
        if (c) return copy(links.find((l) => String(l.id) === c.dataset.copy)?.url || '');
        const off = e.target.closest('[data-off]');
        if (!off) return;
        off.disabled = true;
        try {
          await api.del(`${base}/${off.dataset.off}`);
          links = links.filter((l) => String(l.id) !== off.dataset.off); paint();
          toast('Link turned off. It no longer opens the report.');
        } catch (err) { toastError(err); off.disabled = false; }
      });
    },
  });
}
