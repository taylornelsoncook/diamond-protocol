// Outside data on screen, shared by staff (Settings → Data import, the client page) and the parent portal:
// the import form (a file or a Google Sheets link, the check, mapping a table we don't recognize, save) and the
// summary of an athlete's numbers. The server checks and saves; this only shows what it says.
import { h, fill, toast, btn, busy, field, input, select, panel, ago } from './ui.js';
import { sparkline } from './charts.js';

const MAX_BYTES = 15 * 1024 * 1024, MAX_ARCHIVE = 60 * 1024 * 1024;
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const day = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const hm = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
export function fmtMetric(m, value) {
  if (value == null) return '—';
  if (m.unit === 'min' && /sleep|bed|rem|deep|light|awake|need|debt/i.test(m.key ?? m.label)) return hm(value);
  const n = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${n.toLocaleString()}${m.unit ? (m.unit === '%' ? '%' : ` ${m.unit}`) : ''}`;
}
// Read a chosen file the way the server wants it: CSV as text, Excel and PDF as base64.
function readFile(file) {
  return new Promise((resolve, reject) => {
    const name = file.name, lower = name.toLowerCase();
    const archive = /\.(zip|xml)$/.test(lower);
    if (file.size > (archive ? MAX_ARCHIVE : MAX_BYTES)) return reject(new Error(archive ? 'That export is bigger than 60 MB. Ask us about bringing it in another way.' : 'That file is bigger than 15 MB. Export a shorter date range.'));
    const r = new FileReader();
    r.onerror = () => reject(new Error('That file couldn\'t be read. Choose it again.'));
    if (/\.(csv|tsv|txt)$/.test(lower)) { r.onload = () => resolve({ name, csv: r.result }); r.readAsText(file); return; }
    if (/\.(xlsx|pdf|zip|xml)$/.test(lower)) { const key = lower.endsWith('.pdf') ? 'pdf_base64' : lower.endsWith('.zip') ? 'zip_base64' : lower.endsWith('.xml') ? 'xml_base64' : 'xlsx_base64'; r.onload = () => resolve({ name, [key]: String(r.result).split(',')[1] }); r.readAsDataURL(file); return; }
    if (/\.xls$/.test(lower)) return reject(new Error('That\'s an old Excel file (.xls). Open it in Excel and save it as .xlsx, or export a CSV.'));
    reject(new Error('Choose a CSV, Excel (.xlsx) or PDF file, or an Apple Health or Fitbit export zip.'));
  });
}
// The metrics a spreadsheet column can be saved as (for the mapping form), from the server's list when it gives one.
const KNOWN = [['', 'Keep under its own name'], ['hrv_ms', 'Heart rate variability (ms)'], ['rhr_bpm', 'Resting heart rate (bpm)'], ['recovery_pct', 'Recovery (%)'], ['readiness_pct', 'Readiness (%)'], ['sleep_score_pct', 'Sleep score (%)'],
  ['sleep_min', 'Sleep'], ['in_bed_min', 'In bed'], ['deep_min', 'Deep sleep'], ['rem_min', 'REM sleep'], ['light_min', 'Light sleep'], ['awake_min', 'Awake in bed'], ['sleep_efficiency_pct', 'Sleep efficiency (%)'],
  ['day_strain', 'Day strain'], ['steps', 'Steps'], ['calories_kcal', 'Energy burned (cal)'], ['active_cal_kcal', 'Active burn (cal)'], ['avg_hr_bpm', 'Average heart rate (bpm)'], ['max_hr_bpm', 'Max heart rate (bpm)'],
  ['spo2_pct', 'Blood oxygen (%)'], ['resp_rate', 'Respiratory rate'], ['skin_temp_c', 'Skin temperature (°C)'], ['vo2max', 'VO2 max'], ['body_battery', 'Body battery'], ['stress_score', 'Stress'], ['training_load', 'Training load'], ['distance_km', 'Distance (km)'], ['weight_kg', 'Body weight (kg)']];
const TIME_KEYS = new Set(['sleep_min', 'in_bed_min', 'deep_min', 'rem_min', 'light_min', 'awake_min']);

// The import form. opts: { preview(body), commit(body), athlete: () => ({ id, name }) | null, onSaved(result), sources?: () => api GET { data } }.
// The athlete is chosen outside the form (a picker for staff, the athlete being viewed for a parent). The source menu
// says where the file comes from and how to get it from that app; "Work it out from the file" recognizes it by its columns.
export function importForm(opts) {
  const fileIn = h('input', { type: 'file', accept: '.csv,.tsv,.xlsx,.pdf,.zip,.xml,text/csv,application/pdf,application/zip,text/xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'dp-input', 'aria-label': 'File to bring in' });
  const link = input({ type: 'url', placeholder: 'https://docs.google.com/spreadsheets/d/…', 'aria-label': 'Google Sheets link' });
  const out = h('div', { class: 'stack', 'aria-live': 'polite' });
  const sourceSel = select([['auto', 'Work it out from the file']], { value: 'auto', 'aria-label': 'Where the file comes from' });
  const sourceHelp = h('p', { class: 'small muted', style: 'margin:0' });
  let sourcesList = [];
  const showHelp = () => { const s = sourcesList.find((x) => x.key === sourceSel.value); sourceHelp.textContent = s?.help ?? ''; link.disabled = !!s && !s.accepts.includes('sheet'); if (link.disabled) link.value = ''; };
  sourceSel.addEventListener('change', () => { showHelp(); fill(out); body = null; mapping = null; });
  (opts.sources ? opts.sources() : Promise.resolve({ data: [] })).then((r) => { sourcesList = r.data ?? []; if (sourcesList.length) fill(sourceSel, sourcesList.map((s) => h('option', { value: s.key, selected: s.key === 'auto' }, s.label))); showHelp(); }).catch(() => {});
  let body = null, mapping = null;
  const source = async () => {
    if (link.value.trim()) return { sheet_url: link.value.trim() };
    const f = fileIn.files?.[0];
    if (!f) throw new Error('Choose a file, or paste a Google Sheets link.');
    return { file: await readFile(f) };
  };
  fileIn.addEventListener('change', () => { if (fileIn.files?.length) link.value = ''; fill(out); body = null; mapping = null; });
  link.addEventListener('input', () => { if (link.value.trim()) fileIn.value = ''; fill(out); body = null; mapping = null; });
  async function check(e) {
    const who = opts.athlete();
    if (!who) throw new Error('Choose the athlete first.');
    body = { ...(await source()), client_id: who.id, source: sourceSel.value || 'auto' };
    if (mapping) body.mapping = mapping;
    const p = await opts.preview(body);
    draw(p, who);
  }
  function draw(p, who) {
    const facts = [p.source_label && p.source_label !== p.format_label ? `${p.source_label}: ${p.format_label}` : p.format_label, `${plural(p.rows, 'row')}`, p.days ? `${plural(p.days, 'day')} (${day(p.from)} to ${day(p.to)})` : null, p.workouts ? plural(p.workouts, 'workout') : null].filter(Boolean).join(' · ');
    const saveBtn = btn(`Save for ${who.name.split(' ')[0]}`, (e) => busy(e.currentTarget, async () => {
      try { const r = await opts.commit(body); toast(`Saved: ${[r.days ? plural(r.days, 'day') : null, r.workouts ? plural(r.workouts, 'workout') : null].filter(Boolean).join(' and ')} for ${who.name.split(' ')[0]}.`); fileIn.value = ''; link.value = ''; mapping = null; body = null; fill(out); opts.onSaved?.(r); }
      catch (x) { toast(x.message, 'warn'); if (x.details?.problems) draw({ ...p, problems: x.details.problems, problem_count: x.details.problem_count, ready: false }, who); }
    }), 'primary');
    fill(out, h('div', { class: 'dp-panel stack', style: 'background:transparent' },
      h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, `${p.filename ?? 'File'} for ${who.name}`), h('span', { class: 'small muted' }, facts)),
      p.needs_mapping ? mappingForm(p) : null,
      p.metrics?.length ? h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Brings in: '), p.metrics.map((m) => `${m.label}${m.unit ? ` (${m.unit})` : ''}`).join(', ')) : null,
      p.values ? h('p', { class: 'small', style: 'margin:0' }, `${plural(p.values, 'value')}${p.replaced ? `; ${plural(p.replaced, 'day')} already on file will be replaced` : ''}${p.unchanged ? `; ${plural(p.unchanged, 'value')} already on file are the same` : ''}.`) : null,
      p.workouts ? h('p', { class: 'small', style: 'margin:0' }, `${plural(p.new_workouts, 'new workout')}${p.workouts - p.new_workouts ? `, ${plural(p.workouts - p.new_workouts, 'workout')} already on file updated` : ''}.`) : null,
      ...(p.notes ?? []).map((n) => h('p', { class: 'small muted', style: 'margin:0' }, n)),
      p.problem_count ? h('div', { class: 'stack-tight', role: 'alert' },
        h('span', { class: 'warn-text strong' }, `${plural(p.problem_count, 'problem')} to fix before anything is saved${p.problem_count > p.problems.length ? ` (the first ${p.problems.length} are listed)` : ''}:`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Row'), h('th', null, 'Column'), h('th', null, 'What to fix'))),
          h('tbody', null, p.problems.map((x) => h('tr', null, h('td', { class: 'small' }, x.row ?? '—'), h('td', { class: 'small' }, x.column ?? '—'), h('td', { class: 'small' }, x.message))))))) : null,
      p.sample?.length && (p.needs_mapping || p.problem_count) ? h('details', null, h('summary', { class: 'small muted', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'The first rows of the file'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, p.headers.map((c) => h('th', { class: 'small' }, c)))),
          h('tbody', null, p.sample.map((r) => h('tr', null, p.headers.map((c) => h('td', { class: 'small' }, r[c] ?? '')))))))) : null,
      p.ready ? h('div', { class: 'row wrap' }, saveBtn, btn('Cancel', () => { fill(out); body = null; mapping = null; }, 'ghost')) : null));
  }
  // A table we don't recognize: pick the date column and the columns to keep, each with a name and unit.
  function mappingForm(p) {
    const s = p.suggestion ?? { date_column: null, metrics: [] };
    const dateSel = select([['', 'Choose the date column'], ...p.headers.map((c) => [c, c])], { value: s.date_column ?? '', 'aria-label': 'Date column' });
    const rows = p.headers.map((c) => {
      const guess = s.metrics.find((m) => m.column === c);
      const tick = h('input', { type: 'checkbox', checked: !!guess, 'aria-label': `Bring in ${c}` });
      const label = input({ value: guess?.label ?? c, maxlength: '40', 'aria-label': `Name for ${c}`, style: 'flex:1 1 150px;width:auto;min-width:0' });
      const unit = input({ value: guess?.unit ?? '', maxlength: '12', placeholder: 'unit', 'aria-label': `Unit for ${c}`, style: 'flex:0 0 5.5rem;width:5.5rem;min-width:0' });
      // Save as one of the metrics we know (the trends and the athlete app then treat it like a wearable's), or under its own name.
      const asSel = select(KNOWN, { value: guess?.metric ?? '', 'aria-label': `Save ${c} as`, style: 'flex:1 1 170px;width:auto;min-width:0' });
      const timeSel = select([['', 'in minutes'], ['seconds', 'in seconds'], ['hours', 'in hours']], { value: /hour|hrs?\b/i.test(c) ? 'hours' : /sec/i.test(c) ? 'seconds' : '', 'aria-label': `How ${c} is written`, style: 'flex:0 0 8rem;width:8rem;min-width:0' });   // the column's name says how it's written
      const pctSel = select([['', 'as a percent'], ['fraction', 'as 0 to 1']], { value: '', 'aria-label': `How ${c} is written`, style: 'flex:0 0 8rem;width:8rem;min-width:0' });
      const syncRow = () => { const known = !!asSel.value; label.hidden = known; unit.hidden = known; timeSel.hidden = !TIME_KEYS.has(asSel.value); pctSel.hidden = !/_pct$/.test(asSel.value); };
      asSel.addEventListener('change', syncRow); syncRow();
      return { c, tick, label, unit, asSel, timeSel, pctSel, el: h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center' }, h('label', { class: 'small', style: 'flex:1 1 100%;display:flex;gap:6px;align-items:center;min-height:44px;overflow-wrap:anywhere' }, tick, c), asSel, timeSel, pctSel, label, unit) };
    });
    const sync = () => rows.forEach((r) => { r.el.style.display = r.c === dateSel.value ? 'none' : 'flex'; });
    dateSel.addEventListener('change', sync); sync();
    return h('div', { class: 'stack' },
      h('p', { class: 'small', style: 'margin:0' }, 'We don\'t recognize this file\'s layout. Choose the column with the date, tick the columns of numbers to bring in, and say what each one is: one of the measures we track (so it shows with the same trends as a wearable\'s), or its own name.'),
      field('Date column', dateSel),
      h('div', { class: 'stack-tight' }, rows.map((r) => r.el)),
      h('div', null, btn('Check again', (e) => busy(e.currentTarget, async () => {
        mapping = { date_column: dateSel.value, metrics: rows.filter((r) => r.tick.checked && r.c !== dateSel.value).map((r) => (r.asSel.value
          ? { column: r.c, metric: r.asSel.value, from: (TIME_KEYS.has(r.asSel.value) ? r.timeSel.value : /_pct$/.test(r.asSel.value) ? r.pctSel.value : '') || undefined }
          : { column: r.c, label: r.label.value.trim(), unit: r.unit.value.trim() })) };
        try { await check(); } catch (x) { toast(x.message, 'warn'); }
      }), 'secondary')));
  }
  const checkBtn = btn('Check the file', (e) => busy(e.currentTarget, async () => { mapping = null; try { await check(); } catch (x) { toast(x.message, 'warn'); } }), 'secondary');
  return h('div', { class: 'stack' },
    field('Where the file comes from', sourceSel), sourceHelp,
    h('div', { class: 'form-grid' }, field('File', fileIn, 'CSV, Excel (.xlsx), a PDF with a table in it, or an Apple Health or Fitbit export zip.'), field('Or a Google Sheets link', link, 'In the sheet, press Share and set it to "Anyone with the link".')),
    h('div', null, checkBtn), out);
}

// Recent imports with Undo. undo(id) → promise.
export function importsList(list, { undo, showAthlete = false, canUndo = () => true } = {}) {
  if (!list.length) return h('p', { class: 'muted small' }, 'Nothing brought in yet.');
  return h('div', null, list.map((d) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'min-width:220px' },
      h('span', { class: 'strong' }, `${showAthlete ? `${d.client_name}: ` : ''}${d.source_label && d.source_label !== d.format_label ? `${d.source_label}: ` : ''}${d.format_label}`),
      h('span', { class: 'small muted' }, [d.filename, d.days ? `${plural(d.days, 'day')} (${day(d.from_day)} to ${day(d.to_day)})` : null, d.workouts ? plural(d.workouts, 'workout') : null,
        `${d.created_by ?? 'Someone'}${d.created_by_kind === 'parent' ? ' (parent)' : ''}, ${ago(d.created_at).toLowerCase()}`].filter(Boolean).join(' · '))),
    d.undone_at ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Undone') : undo && canUndo(d) ? btn('Undo', (e) => {
      if (confirm(`Remove what this import saved (${[d.days ? plural(d.days, 'day') : null, d.workouts ? plural(d.workouts, 'workout') : null].filter(Boolean).join(' and ')})? Values a later import replaced stay.`)) busy(e.currentTarget, () => undo(d.id));
    }, 'ghost', { 'aria-label': `Undo the ${d.format_label} import` }) : null)));
}

// The summary of an athlete's numbers: the headline metrics with a trend, the rest in a pulldown, and recent workouts.
export function dataSummary(d, { title = 'Outside data', action = null, empty = 'Nothing brought in yet. A WHOOP export, another app\'s export or a spreadsheet goes in with Import.' } = {}) {
  if (!d?.has_data) return panel(title, { subtitle: empty, action });
  const card = (m) => {
    const diff = m.avg_30 != null && m.avg_prev_30 != null ? m.avg_30 - m.avg_prev_30 : null;
    const good = diff == null || !m.better || Math.abs(diff) < 0.01 ? null : (diff > 0) === (m.better === 'higher');
    return h('div', { class: 'dp-panel stack-tight', style: 'padding:12px;min-width:170px;flex:1 1 170px' },
      h('span', { class: 'small muted' }, m.label),
      h('span', { class: 'strong', style: 'font-size:22px' }, fmtMetric(m, m.latest.value)),
      h('span', { class: 'small muted' }, `${day(m.latest.day)}${m.avg_7 != null ? ` · 7 days ${fmtMetric(m, m.avg_7)}` : ''}`),
      m.avg_30 != null ? h('span', { class: `small ${good == null ? 'muted' : good ? 'good-text' : 'warn-text'}` }, `30 days ${fmtMetric(m, m.avg_30)}${diff != null && Math.abs(diff) >= 0.05 ? ` (${diff > 0 ? '+' : '−'}${fmtMetric({ ...m, unit: m.unit === '%' ? '%' : m.unit }, Math.abs(diff))} vs the 30 before)` : ''}`) : null,
      m.series.length > 1 ? h('span', { style: 'color:var(--green-bright, #7DBA70)' }, sparkline(m.series.map((x) => ({ value: x.value })), { better: m.better === 'lower' ? 'lower' : 'higher', width: 150, height: 36, label: `${m.label} over ${m.series.length} days` })) : null);
  };
  const head = d.metrics.filter((m) => m.headline), rest = d.metrics.filter((m) => !m.headline);
  return panel(title, { subtitle: `${d.first_day ? `${day(d.first_day)} to ${day(d.last_day)}` : ''}. Averages count back from the newest day.`, action },
    head.length ? h('div', { class: 'row wrap', style: 'gap:10px;align-items:stretch' }, head.map(card)) : null,
    rest.length ? h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Everything else (${rest.length})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Measure', 'Latest', '7 days', '30 days', 'Since'].map((x) => h('th', { class: 'small' }, x)))),
        h('tbody', null, rest.map((m) => h('tr', null, h('td', { class: 'small' }, m.label), h('td', { class: 'small' }, `${fmtMetric(m, m.latest.value)} (${day(m.latest.day)})`), h('td', { class: 'small' }, fmtMetric(m, m.avg_7)), h('td', { class: 'small' }, fmtMetric(m, m.avg_30)), h('td', { class: 'small muted' }, day(m.from)))))))) : null,
    d.workouts.length ? h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Recent wearable workouts (${d.workouts.length})`),
      d.workouts.map((w) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, `${w.activity} · ${new Date(w.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`),
        h('span', { class: 'muted' }, [w.minutes != null ? `${Math.round(w.minutes)} min` : null, w.strain != null ? `strain ${w.strain}` : null, w.avg_hr != null ? `avg ${Math.round(w.avg_hr)} bpm` : null].filter(Boolean).join(' · '))))) : null);
}
