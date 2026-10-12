// Bar speed (velocity-based training), shared by the athlete app and the parent portal (Performance), the client page
// (Testing), Testing → Devices & imports (the file import and the waiting list) and API & integrations (the device guide).
import { h, fill, btn, busy, toast, input, select, field, panel, copyText } from './ui.js';

const day = (d, opts = { month: 'short', day: 'numeric' }) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts }) : '');
const ms = (x, d = 2) => (x == null ? '—' : `${Number(x).toFixed(d)} m/s`);
const lb = (x) => (x == null ? '—' : `${Math.round(x)} lb`);
const pct = (x) => (x == null ? '—' : `${Math.round(x)}%`);

// ---------- The athlete's bar speed ----------
// data: the answer to GET …/vbt. who: 'athlete' | 'parent' | 'coach' (wording). Owner's ask: one line per exercise
// they have ever done: the heaviest weight with the fastest bar speed at that weight, and the estimated one-rep max.
export function vbtBlock(data, { who = 'athlete', first = null } = {}) {
  if (!data?.has_data) return h('p', { class: 'small muted', style: 'margin:0' }, `No bar-speed sets yet. Sets from a velocity device (Output, GymAware, Vitruve, Enode, Perch and others) land here once ${who === 'coach' ? 'the device is connected or its export is imported' : 'your coach connects the device'}.`);
  const rows = data.exercises.map((ex) => {
    const p = ex.profile;
    const why = p?.e1rm ? `From ${p.loads} loads at ${ms(ex.mvt.value)} (r² ${p.r2})` : ex.mvt.kind === 'ballistic' ? 'A ballistic lift: no max is estimated' : `${ex.profile_points.length < 3 ? 'Three different loads' : 'Loads further apart'} are needed (${ex.profile_points.length} so far)`;
    return h('tr', null,
      h('td', null, h('span', { class: 'strong' }, ex.name), h('span', { class: 'small muted', style: 'display:block' }, `${ex.sets} ${ex.sets === 1 ? 'set' : 'sets'} · last ${day(ex.last_day)}`)),
      h('td', null, ex.heaviest ? h('b', null, lb(ex.heaviest.load_lb)) : '—', ex.heaviest?.day ? h('span', { class: 'small muted', style: 'display:block' }, day(ex.heaviest.day)) : null),
      h('td', null, ex.heaviest?.velocity != null ? h('b', null, ms(ex.heaviest.velocity)) : '—'),
      h('td', { title: why }, p?.e1rm ? h('b', null, lb(p.e1rm)) : h('span', { class: 'muted' }, '—'), h('span', { class: 'small muted', style: 'display:block' }, p?.e1rm ? `at ${ms(ex.mvt.value)}` : why)));
  });
  return h('div', { class: 'stack-tight vb' },
    h('table', { class: 'vb-table vb-summary' },
      h('thead', null, h('tr', null, ['Exercise', 'Heaviest', 'Fastest at that weight', 'Estimated 1 rep max'].map((t) => h('th', null, t)))),
      h('tbody', null, rows)),
    h('p', { class: 'small muted', style: 'margin:0' }, `Every set ${who === 'athlete' ? 'you have' : `${first ?? 'the athlete'} has`} ever done on ${data.systems.map((s) => s.label.split(' (')[0]).join(', ')}. The estimated max is where the line through the fastest rep at each load reaches the minimum velocity threshold${who === 'coach' ? ' (the owner\'s setting on API & integrations → Bar speed devices)' : ''}; it is an estimate, not a tested max.`));
}

// ---------- Files: read in the browser ----------
export function readVbtFile(file) {
  return new Promise((resolve, reject) => {
    const name = file.name, lower = name.toLowerCase(), r = new FileReader();
    r.onerror = () => reject(new Error('That file couldn\'t be read.'));
    if (/\.(csv|tsv|txt)$/.test(lower)) { r.onload = () => resolve({ name, csv: r.result }); r.readAsText(file); return; }
    if (/\.xlsx$/.test(lower)) { r.onload = () => resolve({ name, xlsx_base64: String(r.result).split(',')[1] }); r.readAsDataURL(file); return; }
    reject(new Error('Upload the CSV or Excel (.xlsx) export.'));
  });
}
const ROLE_LABELS = { athlete: 'Athlete name', athlete_id: 'Athlete ID (the device\'s)', first_name: 'First name', last_name: 'Last name', email: 'Email', date: 'Date', datetime: 'Date and time', exercise: 'Exercise', set: 'Set number', rep: 'Rep number (one row per rep)', reps: 'Reps in the set',
  load: 'Load', mean_velocity: 'Mean velocity', peak_velocity: 'Peak velocity', best_velocity: 'Best rep velocity', last_velocity: 'Last rep velocity', velocity_loss_pct: 'Velocity loss', mean_power: 'Mean power', peak_power: 'Peak power', rom: 'Range of motion', duration: 'Duration', external_id: 'The system\'s set id', velocity_zone: 'Velocity zone' };

// Testing → Devices & imports: import a bar-speed export. post(path, body); systems from GET /v1/vbt/systems; everyone and
// athletePicker from the page (the athlete when a file names none); onDone() reloads the page.
export function vbtImportPanel({ post, systems, everyone, athletePicker, onDone }) {
  const sys = select(systems.map((s) => [s.key, s.label]), { value: 'output', 'aria-label': 'System' });
  const file = input({ type: 'file', accept: '.csv,.tsv,.txt,.xlsx', 'aria-label': 'Export file' });
  const help = h('p', { class: 'small muted', style: 'margin:0' });
  const showHelp = () => { const s = systems.find((x) => x.key === sys.value); help.textContent = s ? s.export : ''; };
  sys.addEventListener('change', showHelp); showHelp();
  const picker = athletePicker(everyone, { label: 'Whose sets are these? (only when the file names no athlete)' });
  const result = h('div', { class: 'stack' });
  let loaded = null, mapping = null;
  const preview = async (e) => {
    const f = file.files?.[0];
    if (!f) throw new Error('Choose the export file first.');
    if (f.size > 30 * 1024 * 1024) throw new Error('Files up to 30 MB.');
    loaded = await readVbtFile(f);
    const a = picker.get();
    const r = await post('/v1/vbt/import/preview', { provider: sys.value, file: loaded, mapping, client_id: a?.client_id ?? a?.id ?? null });
    mapping = r.mapping;
    drawPreview(r, a);
  };
  function drawPreview(r, a) {
    const cols = ['', ...r.headers];
    const mapRow = (role) => h('div', { class: 'vb-map-row' }, h('span', { class: 'small' }, ROLE_LABELS[role] ?? role),
      select(cols.map((c) => [c, c || '—']), { value: r.mapping[role] ?? '', 'aria-label': ROLE_LABELS[role] ?? role, onChange: (e) => { mapping = { ...mapping, [role]: e.target.value || null }; } }));
    const mapBox = h('details', { class: 'vb-map' }, h('summary', null, `Columns matched (${Object.keys(r.roles).length ? r.roles.filter((k) => r.mapping[k]).length : 0} of ${r.headers.length}) · change by hand`),
      h('div', { class: 'vb-map-grid' }, r.roles.map(mapRow)),
      h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, h('span', { class: 'small' }, 'Load unit'), select([['lb', 'lb'], ['kg', 'kg']], { value: r.mapping.load_unit ?? 'lb', 'aria-label': 'Load unit', onChange: (e) => { mapping = { ...mapping, load_unit: e.target.value }; } }),
        btn('Check again', (e) => busy(e.currentTarget, () => preview()), 'outline')));
    const problems = r.problem_count ? h('div', { class: 'vb-problems' }, h('span', { class: 'strong warn-text' }, `${r.problem_count} ${r.problem_count === 1 ? 'problem' : 'problems'} to fix before saving`),
      h('ul', { class: 'small' }, r.problems.slice(0, 30).map((p) => h('li', null, `Row ${p.row}${p.column ? `, ${p.column}` : ''}: ${p.message}`))), r.problem_count > 30 ? h('span', { class: 'small muted' }, `…and ${r.problem_count - 30} more`) : null) : null;
    const unmatched = r.unmatched_athletes.length ? h('div', { class: 'stack-tight' }, h('span', { class: 'small strong' }, `${r.unmatched_athletes.length} ${r.unmatched_athletes.length === 1 ? 'athlete we don\'t recognize' : 'athletes we don\'t recognize'}`),
      h('span', { class: 'small muted' }, 'Their sets will wait after saving; link each name or ID to an athlete once below and the sets go to them (and the next export lands straight away).'),
      h('div', { class: 'row wrap small' }, r.unmatched_athletes.slice(0, 40).map((u) => h('span', { class: 'dp-badge dp-badge--muted' }, `${u.name ?? u.external_id ?? u.email} · ${u.sets}`)))) : null;
    const sample = r.preview.length ? h('table', { class: 'vb-table' }, h('thead', null, h('tr', null, ['Athlete', 'When', 'Exercise', 'Set', 'Load', 'Reps', 'Mean', 'Peak', 'Loss'].map((t) => h('th', null, t)))),
      h('tbody', null, r.preview.map((s) => h('tr', null, h('td', null, a ? a.name : s.athlete.name ?? s.athlete.external_id ?? '—'), h('td', null, day(s.performed_at)), h('td', null, s.exercise_name), h('td', null, s.set_no ?? '·'), h('td', null, lb(s.load_lb)), h('td', null, s.reps ?? '—'), h('td', null, ms(s.mean_velocity)), h('td', null, ms(s.peak_velocity)), h('td', null, pct(s.velocity_loss_pct)))))) : null;
    fill(result,
      h('p', { class: 'small', style: 'margin:0' }, `${r.rows} rows → ${r.sets_found} ${r.sets_found === 1 ? 'set' : 'sets'}${r.per_rep ? ' (one row per rep, folded into sets)' : ''}${r.mapping.load_unit ? ` · loads in ${r.mapping.load_unit}` : ''}.`),
      mapBox, problems, unmatched, sample,
      h('div', { class: 'row wrap' }, btn(r.problem_count ? 'Fix the problems, then check again' : `Save ${r.sets_found} ${r.sets_found === 1 ? 'set' : 'sets'}`, (e) => busy(e.currentTarget, async () => {
        const saved = await post('/v1/vbt/import', { provider: sys.value, file: loaded, mapping, client_id: a?.client_id ?? a?.id ?? null });
        toast(`${saved.saved} ${saved.saved === 1 ? 'set' : 'sets'} saved${saved.waiting ? `, ${saved.waiting} waiting to be linked` : ''}${saved.duplicates ? `, ${saved.duplicates} already there` : ''}.`);
        onDone?.();
      }), 'primary', { disabled: !!r.problem_count })));
  }
  return panel('Import a bar-speed export', { subtitle: 'Output Hub, GymAware Cloud, FLEX, Vitruve, Enode, Perch, RepOne, Metric or any spreadsheet with an exercise, a load and a velocity per set (or per rep). Athletes land by Athlete ID or a linked device name; the rest wait for you to link them once.' },
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, () => preview()); } },
      h('div', { class: 'form-grid cols-2' }, field('System', sys), field('Export file', file)), help,
      h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Athlete'), picker.el),
      h('div', null, btn('Check the file', null, 'primary', { type: 'submit' }))),
    result);
}
// Sets waiting under a device name or ID: link to an athlete (remembered), or throw away.
export function vbtWaitingPanel({ waiting, imports, everyone, athletePicker, post, onDone }) {
  const rows = waiting.map((w) => {
    const row = h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
      h('span', { class: 'grow', style: 'min-width:220px' }, `${w.system.split(' (')[0]}: ${w.identity.startsWith('name:') ? `"${w.athlete.name ?? w.identity.slice(5)}"` : `ID ${w.athlete.external_id ?? w.identity.slice(3)}${w.athlete.name ? ` (${w.athlete.name})` : ''}`}`),
      h('span', { class: 'muted' }, `${w.sets} ${w.sets === 1 ? 'set' : 'sets'} · ${w.exercises.join(', ')} · ${day(w.first_at)}${w.last_at.slice(0, 10) !== w.first_at.slice(0, 10) ? ` to ${day(w.last_at)}` : ''}`),
      btn('Link', () => {
        const p = athletePicker(everyone, { label: `Who is ${w.athlete.name ?? w.athlete.external_id ?? 'this'}?` });
        fill(row, h('div', { class: 'stack', style: 'width:100%' }, p.el, h('div', { class: 'row wrap' },
          btn('Link and remember', (e) => busy(e.currentTarget, async () => { const a = p.get(); if (!a) throw new Error('Pick the athlete from the list.'); const r = await post('/v1/vbt/waiting/link', { provider: w.provider, identity: w.identity, athlete_id: a.athlete_id }); toast(`${r.linked} ${r.linked === 1 ? 'set' : 'sets'} linked to ${a.name}.`); onDone?.(); }), 'primary'),
          btn('Cancel', () => onDone?.(), 'ghost'))));
        p.focus();
      }, 'outline'),
      btn('Discard', (e) => { if (confirm(`Throw away ${w.sets} waiting ${w.sets === 1 ? 'set' : 'sets'}?`)) busy(e.currentTarget, async () => { await post('/v1/vbt/waiting/discard', { provider: w.provider, identity: w.identity }); onDone?.(); }); }, 'ghost'));
    return row;
  });
  const importRows = imports.slice(0, 8).map((b) => h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
    h('span', { class: 'grow' }, `${b.system.split(' (')[0]} · ${b.filename ?? 'file'} · ${day(b.created_at)}${b.created_by ? ` by ${b.created_by}` : ''}`),
    h('span', { class: 'muted' }, b.undone_at ? 'Undone' : `${b.saved} saved${b.waiting ? `, ${b.waiting} waiting` : ''}${b.duplicates ? `, ${b.duplicates} already there` : ''}`),
    b.undone_at ? null : btn('Undo', (e) => { if (confirm('Undo this import? The sets it brought in are removed.')) busy(e.currentTarget, async () => { const r = await post(`/v1/vbt/imports/${b.id}/undo`); toast(`${r.removed} ${r.removed === 1 ? 'set' : 'sets'} removed.`); onDone?.(); }); }, 'ghost')));
  return panel('Bar speed waiting and recent imports', { subtitle: 'Sets from a device name or ID we don\'t know yet. Link each once; its next sets go straight to the athlete.' },
    rows.length ? rows : h('p', { class: 'muted small' }, 'Nothing waiting.'),
    importRows.length ? h('div', { class: 'stack-tight', style: 'margin-top:8px' }, h('span', { class: 'small strong' }, 'Recent imports'), importRows) : null);
}

// API & integrations → Bar speed devices: each system, how to get its data in, the push address, the thresholds.
export function vbtDevicesPanel({ systems, thresholds, owner, origin, saveThresholds }) {
  const example = `curl -X POST ${origin}/v1/vbt/sets \\
  -H "Authorization: Bearer dp_live_..." -H "Content-Type: application/json" \\
  -d '{"provider":"output","sets":[{"athlete":{"athlete_id":"AVALOP2026"},"exercise":"Back squat",
       "performed_at":"2026-10-06T17:02:00Z","set_no":1,"reps":3,"load":225,"load_unit":"lb",
       "mean_velocity":0.66,"peak_velocity":1.05,"external_id":"set-8812"}]}'`;
  const api = panel('Send sets from any device', { subtitle: 'A results-scope API key may post sets. Athletes land by Athlete ID (or our client_id, or a device ID or name you linked once under Testing → Devices & imports); anything else waits for you to link it. Loads in lb or kg, velocities in m/s; GymAware\'s summary objects are accepted as they are.' },
    h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Copy', () => copyText(example, 'Example copied.'), 'ghost', { 'aria-label': 'Copy the example' })),
    h('pre', { class: 'small', style: 'white-space:pre-wrap;overflow-x:auto;background:var(--ground);padding:12px;border-radius:6px;margin:0' }, example),
    h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/integrations' }, 'API keys'), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing/connections' }, 'Import a file or link a device'), h('a', { class: 'dp-btn dp-btn--ghost', href: '/v1/openapi.json', target: '_blank' }, 'API reference')));
  const guide = panel('The systems and how their data gets here', { subtitle: 'Every one exports a file you can import; a few offer a live connection.' },
    h('div', { class: 'eg-list' }, systems.filter((s) => s.key !== 'other').map((s) => h('div', { class: 'eg-item stack-tight' },
      h('div', { class: 'row wrap', style: 'gap:8px;align-items:baseline' }, h('span', { class: 'strong' }, s.label), s.kind ? h('span', { class: 'small muted' }, s.kind) : null),
      h('span', { class: 'small' }, h('b', null, 'Export: '), s.export), h('span', { class: 'small' }, h('b', null, 'Live: '), s.api)))));
  const names = { squat: 'Squats and lunges', bench: 'Bench press and presses', deadlift: 'Deadlifts, pulls and rows', other: 'Anything else' };
  const inputs = Object.fromEntries(Object.keys(names).map((k) => [k, input({ type: 'number', step: '0.01', min: '0.05', max: '0.6', value: thresholds[k], inputmode: 'decimal', disabled: !owner, 'aria-label': `${names[k]} threshold in m/s`, style: 'max-width:110px' })]));
  const mvt = panel('Minimum velocity thresholds', { subtitle: 'The mean velocity of a true one-rep max, per kind of lift. The estimated max on each profile is where the athlete\'s load-velocity line reaches it. Research starting values: squat 0.30 m/s (youth studies 0.28 to 0.29), bench 0.17, deadlift 0.15. Cleans, jumps and throws get no estimate.' },
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { await saveThresholds(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [`vbt_mvt_${k}`, el.value]))); toast('Thresholds saved. Every estimate uses them from now on.'); }); } },
      h('div', { class: 'form-grid cols-2' }, Object.entries(names).map(([k, label]) => field(`${label} (m/s)`, inputs[k]))),
      owner ? h('div', null, btn('Save thresholds', null, 'primary', { type: 'submit' })) : h('p', { class: 'small muted' }, 'The owner sets these.')));
  return [api, guide, mvt];
}
