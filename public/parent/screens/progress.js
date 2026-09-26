// Progress: shared test results in plain language, from GET /api/parent/athletes/:id/progress.
import { html, mount, api, sparkline, fmtDate } from '/js/ui.js';
import { header, athletePills, bindAthletePills } from '../common.js';

const num = (v, dp = 2) => (v == null || isNaN(v) ? '—' : String(Math.round(Number(v) * 10 ** dp) / 10 ** dp));
function feetIn(inches) {
  const i = Number(inches);
  const ft = Math.floor(i / 12);
  return `${ft}′ ${num(i - ft * 12, 1)}″`;
}
export function fmtVal(v, unit) {
  if (v == null) return '—';
  if (unit === '%') return `${num(v, 1)}%`;
  if (unit === 's' && Number(v) >= 100) { const m = Math.floor(v / 60); return `${m}:${String(num(v - m * 60, 1)).padStart(2, '0')}`; }
  return `${num(v)} ${unit || ''}`.trim();
}
function pctChange(t) {
  if (t.first == null || t.latest == null || !Number(t.first) || t.count < 2) return null;
  const raw = ((t.latest - t.first) / Math.abs(t.first)) * 100;
  const better = t.lower_better ? -raw : raw;
  return { better, text: `${better >= 0 ? '+' : '−'}${num(Math.abs(better), 1)}%` };
}
function growthText(g) {
  const off = g.maturity_offset != null ? Number(g.maturity_offset) : null;
  if (off == null) return { label: g.status || null, note: null };
  const yrs = num(Math.abs(off), 1);
  if (off < -0.5) return { label: 'Before the growth spurt', note: `About ${yrs} years before the fastest growth. Keep training focused on skill, speed and movement quality. This is an estimate and can be off by about a year.` };
  if (off <= 0.5) return { label: 'In the growth spurt', note: 'Growing fastest right now. Coordination can dip for a while and knees and heels can get sore; that\'s normal. This is an estimate and can be off by about a year.' };
  return { label: 'Past the growth spurt', note: `About ${yrs} years past the fastest growth. Strength gains usually come more easily from here. This is an estimate and can be off by about a year.` };
}

export async function render(ctx) {
  const a = ctx.athlete;
  if (!a) { mount(ctx.el, html`${header('Progress', ctx.familyName)}<div class="empty">Add an athlete on the Family tab first.</div>`); return; }
  let p = null;
  try { p = await api.get(`/parent/athletes/${a.id}/progress`); }
  catch (e) { if (e.status !== 404) throw e; }
  if (!ctx.isCurrent()) return;
  const top = html`${header('Progress', ctx.familyName)}${athletePills(ctx)}`;
  const tests = (p?.tests || []).filter((t) => t.count > 0 || t.best != null);
  if (!p || (!tests.length && !p.note && !p.growth)) {
    mount(ctx.el, html`${top}<div class="empty">No shared results yet. After ${a.first_name}'s next testing day, your coach shares the results here.</div>`);
    bindAthletePills(ctx);
    return;
  }
  const imps = (p.improvements || []).slice(0, 3);
  const prs = p.prs || [];
  const g = p.growth;
  const gt = g ? growthText(g) : null;
  // Tests grouped by category, in the order they arrive.
  const cats = [];
  for (const t of tests) { let c = cats.find((x) => x.name === (t.category || 'Other')); if (!c) cats.push(c = { name: t.category || 'Other', items: [] }); c.items.push(t); }

  mount(ctx.el, html`${top}
    ${p.note?.text ? html`<section class="panel">
      <div><h2 class="panel-title">From your coach</h2><p class="panel-sub">${[p.note.day_name, p.note.date ? fmtDate(p.note.date) : null].filter(Boolean).join(' · ')}</p></div>
      <p class="note-text">${p.note.text}</p></section>` : ''}
    ${imps.length ? html`<section class="panel"><h2 class="panel-title">Biggest improvements</h2>
      <div class="imps ${imps.length === 2 ? 'two' : ''}">${imps.map((i) => html`<div class="imp"><div class="imp-v">+${num(Math.abs(i.pct), 1)}%</div><div class="imp-l">${i.test}</div></div>`)}</div></section>` : ''}
    ${prs.length ? html`<p style="margin:0"><span class="strong">New PRs:</span> ${prs.map((r) => `${r.test} (${fmtVal(r.value, r.unit)})`).join(', ')}</p>` : ''}
    ${tests.length ? html`<section class="panel"><div><h2 class="panel-title">Every test</h2><p class="panel-sub">Best result and change since the first test.</p></div>
      <div class="list">${cats.map((c) => html`${cats.length > 1 ? html`<div class="t-cat">${c.name}</div>` : ''}${c.items.map((t) => {
        const ch = pctChange(t);
        const vals = (t.history || []).map((h) => Number(h.value));
        return html`<div class="t-row">
          <div><div class="strong">${t.name}</div><div class="s-meta">${t.count > 1 ? `${fmtVal(t.first, t.unit)} → ${fmtVal(t.latest, t.unit)}` : `Tested once${t.history?.[0]?.date ? `, ${fmtDate(t.history[0].date)}` : ''}`}${t.lower_better ? ' · lower is better' : ''}</div></div>
          <div>${sparkline(t.lower_better ? vals.map((v) => -v) : vals, { w: 84, h: 28 })}</div>
          <div class="t-best">${fmtVal(t.best, t.unit)}${ch ? html`<span class="${ch.better > 0 ? 'good-text' : 'muted'}">${ch.text}</span>` : ''}</div>
        </div>`;
      })}`)}</div></section>` : ''}
    ${g ? html`<section class="panel"><h2 class="panel-title">Growth</h2>
      <div class="imps two">
        ${g.height ? html`<div class="imp"><div class="imp-v" style="color:var(--steel)">${feetIn(g.height)}</div><div class="imp-l">Height</div></div>` : ''}
        ${g.weight ? html`<div class="imp"><div class="imp-v" style="color:var(--steel)">${num(g.weight, 1)} lb</div><div class="imp-l">Weight</div></div>` : ''}
        ${gt?.label ? html`<div class="imp" style="grid-column:1/-1"><div class="strong" style="font-size:17px;line-height:22px">${gt.label}</div>${g.phv_age ? html`<div class="imp-l">Estimated peak around age ${num(g.phv_age, 1)}</div>` : ''}</div>` : ''}
      </div>
      ${gt?.note ? html`<p class="muted" style="margin:0">${gt.note}</p>` : html`<p class="muted small" style="margin:0">The growth-spurt estimate shows once birthday, sex, height, seated height and weight are all on file.</p>`}
    </section>` : ''}
    <a class="btn btn-block" href="/report/${encodeURIComponent(p.athlete?.code || a.code)}" target="_blank" rel="noopener">Printable report</a>`);
  bindAthletePills(ctx);
}
