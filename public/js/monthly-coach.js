import { h, fill, toast, btn, busy, select, panel } from './ui.js';

// Programs → Monthly reports (#/programs/monthly): the month's reports for parents, written from what each athlete
// logged. A coach reads each one, adds a line, and sends it (or skips it); the owner can let them go on their own from
// Hours & settings. Owners and coaches; front desk has no part in it.
const first = (name) => String(name ?? '').split(' ')[0];
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const monthLabel = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

export async function viewMonthlyReports(main, { api, header }) {
  const get = (p) => api('GET', p), post = (p, b = {}) => api('POST', p, b), patch = (p, b) => api('PATCH', p, b);
  const qs = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const overview = await get('/v1/monthly-reports');
  const month = qs.get('month') || overview.months[0]?.month || overview.last_month;
  const go = (m) => { location.hash = `#/programs/monthly?month=${m}`; };
  const reload = () => viewMonthlyReports(main, { api, header });
  const list = (await get(`/v1/monthly-reports?month=${month}`)).data;
  const drafts = list.filter((r) => r.status === 'draft'), sent = list.filter((r) => r.status === 'sent'), skipped = list.filter((r) => r.status === 'skipped');

  const monthOptions = [...new Set([month, overview.last_month, ...overview.months.map((m) => m.month)])].sort().reverse().map((m) => [m, monthLabel(m)]);
  const pick = select(monthOptions, { value: month, 'aria-label': 'Month', onChange: (e) => go(e.target.value) });
  const summaryOf = (d) => [
    `${plural(d.workouts, 'workout')} logged${d.expected ? ` of about ${d.expected}` : ''}${d.workouts_prev != null && d.workouts !== d.workouts_prev ? ` (${d.workouts > d.workouts_prev ? 'up' : 'down'} from ${d.workouts_prev})` : ''}`,
    `${plural(d.attended, 'session')} attended`, `${d.checkins} of ${d.days} check-ins`,
    d.strength[0] ? `${d.strength[0].name} ${d.strength[0].e1rm} lb${d.strength[0].change != null ? ` (${d.strength[0].change >= 0 ? '+' : ''}${d.strength[0].change})` : ''}` : null,
    d.steps.length ? plural(d.steps.length, 'step up') : null].filter(Boolean).join(' · ');
  const strengthLines = (d) => (d.strength.length ? h('ul', { class: 'small', style: 'margin:0;padding-left:18px' }, d.strength.map((s) => h('li', null, `${s.name}: ${s.e1rm} lb estimated max${s.change != null ? ` (${s.change > 0 ? `up ${s.change}` : s.change < 0 ? `down ${-s.change}` : 'no change'}${s.change ? ' lb' : ''})` : ' (first month on record)'}`))) : null);

  const draftRow = (r) => {
    const note = h('textarea', { class: 'dp-input', rows: '2', placeholder: `A line for ${first(r.client_name)}'s parents (optional): what went well, what's next.`, 'aria-label': `Coach's line for ${r.client_name}` });
    note.value = r.coach_note ?? '';
    let saved = r.coach_note ?? '';
    const save = async () => { const val = note.value.trim(); if (val === saved) return; saved = val; await patch(`/v1/monthly-reports/${r.id}`, { coach_note: val }); toast('Line saved.'); };
    note.addEventListener('blur', () => save().catch((e) => toast(e.message, 'warn')));
    return h('div', { class: 'list-item', style: 'flex-wrap:wrap;align-items:flex-start' },
      h('div', { class: 'grow stack-tight', style: 'min-width:260px' },
        h('a', { href: `#/clients/${r.client_id}`, class: 'strong', style: 'color:var(--steel)' }, r.client_name),
        h('span', { class: 'small muted' }, summaryOf(r.data)), strengthLines(r.data),
        r.data.steps.length ? h('span', { class: 'small muted' }, `Steps approved: ${r.data.steps.map((s) => `${s.text} on ${s.name}`).join(', ')}`) : null,
        note),
      h('div', { class: 'stack-tight' },
        btn('Send to the parents', (e) => busy(e.currentTarget, async () => { await save(); const out = await post(`/v1/monthly-reports/${r.id}/send`); toast(`Sent to ${out.sent_to.join(', ')}.`); reload(); }), 'secondary'),
        btn('Preview', (e) => busy(e.currentTarget, async () => { const full = await get(`/v1/monthly-reports/${r.id}`); alert(full.text); }), 'ghost'),
        btn('Skip', (e) => busy(e.currentTarget, async () => { await post(`/v1/monthly-reports/${r.id}/skip`); reload(); }), 'ghost')));
  };
  const sentRow = (r) => h('div', { class: 'list-item small' }, h('div', { class: 'grow stack-tight' }, h('a', { href: `#/clients/${r.client_id}`, class: 'strong', style: 'color:var(--steel)' }, r.client_name), h('span', { class: 'muted' }, summaryOf(r.data))),
    h('span', { class: 'muted' }, `Sent ${when(r.sent_at)} to ${r.sent_to.join(', ')}${r.sent_by && r.sent_by !== 'automatic' ? ` by ${first(r.sent_by)}` : r.sent_by === 'automatic' ? ' on its own' : ''}`));
  const skippedRow = (r) => h('div', { class: 'list-item small' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, r.client_name), h('span', { class: 'muted' }, r.data.quiet ? 'Nothing logged, attended or checked in this month.' : summaryOf(r.data))),
    btn('Bring back', (e) => busy(e.currentTarget, async () => { await post(`/v1/monthly-reports/${r.id}/unskip`); reload(); }), 'ghost'));

  const tools = h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, pick,
    !list.length && month < overview.current_month ? btn(`Write ${monthLabel(month)}'s reports`, (e) => busy(e.currentTarget, async () => { const g = await post('/v1/monthly-reports/generate', { month }); toast(`${plural(g.drafts, 'report')} written${g.skipped ? `, ${g.skipped} quiet ${g.skipped === 1 ? 'month' : 'months'} skipped` : ''}.`); reload(); }), 'secondary') : null,
    drafts.length > 1 ? btn(`Send all ${drafts.length} drafts`, (e) => { if (!confirm(`Email ${drafts.length} reports to their parents now, as they are?`)) return; busy(e.currentTarget, async () => { const out = await post('/v1/monthly-reports/send-all', { month }); toast(`${plural(out.sent, 'report')} sent${out.no_email.length ? `. No parent email for ${out.no_email.join(', ')}.` : '.'}`); reload(); }); }, 'outline') : null);
  fill(main,
    header('Monthly reports', `Written from what each athlete logged: workouts against the program's pace, sessions, check-ins, the strength trend, steps approved. Add a line, then send. Parents read them in the portal and by email.${overview.mode === 'auto' ? ' Set to send on its own in the first week of each month.' : overview.mode === 'off' ? ' Turned off in Hours & settings.' : ''}`, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/programs' }, 'Programs')),
    tools,
    panel(`Drafts · ${drafts.length}`, { subtitle: drafts.length ? 'Read each one, add your line, send.' : list.length ? 'Every report for this month is sent or skipped.' : month < overview.current_month ? 'Nothing written for this month yet.' : 'This month isn\'t over yet. Reports are written once it ends.' }, drafts.map(draftRow)),
    sent.length ? panel(`Sent · ${sent.length}`, {}, sent.map(sentRow)) : null,
    skipped.length ? panel(`Skipped · ${skipped.length}`, { subtitle: 'Quiet months, or ones you chose not to send.' }, skipped.map(skippedRow)) : null);
}
