// The CRM screens (version 45): the leads list and pipeline board, a lead's page, follow-up tasks, reports, import and
// export, lead settings (the website form, templates, the Book now page, review requests), the Today task list and a
// family's contact history on the client profile. The server checks every rule (who sees which lead, consent, opt-outs);
// these screens only follow. Owner decision: owners and front desk work every lead; a coach sees only the leads the
// owner gave them. Reports, import, export, templates and group messages are the owner's.
import { h, fill, toast, date, ago, btn, busy, field, input, select, panel } from './ui.js';

let api, render, header, pulseTile, download, me;
export function initCrm(deps) { ({ api, render, header, pulseTile, download, me } = deps); }
const get = (p) => api('GET', p), post = (p, b = {}) => api('POST', p, b), patch = (p, b) => api('PATCH', p, b), del = (p, b) => api('DELETE', p, b);
const role = () => me()?.role;
const isOwner = () => role() === 'owner';
const isCoach = () => role() === 'coach';
const phoneText = (p) => (/^\+1\d{10}$/.test(p ?? '') ? `(${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}` : p);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const first = (n) => String(n ?? '').split(' ')[0];
const query = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
const textarea = (value = '', attrs = {}) => { const t = h('textarea', { class: 'dp-input', style: 'min-height:96px', ...attrs }); t.value = value ?? ''; return t; };
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const shortDay = (ymd) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const localToday = () => new Date().toLocaleDateString('en-CA');

export const STAGES = [['new', 'New'], ['contacted', 'Contacted'], ['signed_up', 'Signed up'], ['evaluation', 'Evaluation booked'], ['trial', 'Trial'], ['member', 'Member'], ['lost', 'Lost']];
const OPEN = ['new', 'contacted', 'signed_up', 'evaluation', 'trial'];
const stageLabel = (k) => STAGES.find(([x]) => x === k)?.[1] ?? k;
const STAGE_TONE = { new: 'warn', contacted: 'neutral', signed_up: 'good', evaluation: 'good', trial: 'good', member: 'good', lost: 'muted' };
const stageBadge = (k) => h('span', { class: `dp-badge dp-badge--${STAGE_TONE[k] ?? 'muted'}` }, stageLabel(k));
const LOST_REASONS = [['price', 'Price'], ['schedule', 'Schedule'], ['distance', 'Too far'], ['elsewhere', 'Went elsewhere'], ['no_response', 'No response'], ['not_ready', 'Not ready yet'], ['other', 'Other']];
const STAFF_SOURCES = [['phone', 'Phone call'], ['walk_in', 'Walk-in'], ['event', 'Event'], ['referral', 'Referral'], ['social', 'Social media'], ['camp', 'Camp'], ['team', 'Team or school'], ['manual', 'Other']];
const CALL_OUTCOMES = [['reached', 'Reached them'], ['voicemail', 'Left a voicemail'], ['no_answer', 'No answer']];
const inStage = (l) => (l.days_in_stage === 0 ? `${l.stage_label} since today` : `${plural(l.days_in_stage, 'day')} in ${l.stage_label}`);
const staleBadge = (l) => (l.stale ? h('span', { class: 'dp-badge dp-badge--warn', title: `Nobody has worked this lead for ${plural(l.idle_days, 'day')}` }, `Stale · ${plural(l.idle_days, 'day')}`) : null);

// A dialog: a title, a body and buttons. An action's onClick returns false to keep it open; errors show in the dialog.
function dialog(title, body, actions) {
  const d = document.getElementById('dialog');
  const err = h('div', { class: 'dp-error', role: 'alert' });
  fill(d, h('div', { class: 'stack' }, h('h2', { class: 'week-title', style: 'color:var(--steel)' }, title), body, err,
    h('div', { class: 'row wrap' }, actions.map((a) => btn(a.label, async (e) => {
      if (!a.onClick) return d.close();
      err.textContent = '';
      const b = e.currentTarget; b.disabled = true;
      try { if ((await a.onClick(d, err)) !== false) d.close(); } catch (x) { err.textContent = x.message; } finally { b.disabled = false; }
    }, a.variant ?? 'secondary')))));
  if (!d.open) { d.addEventListener('close', () => fill(d), { once: true }); d.showModal(); }
  return d;
}

// The sub-pages under Leads, as a row of links (the current one marked).
function leadNav(current) {
  const items = [['', 'Leads'], ['tasks', 'Tasks'], ...(isOwner() ? [['campaigns', 'Group messages'], ['reports', 'Reports'], ['import', 'Import & export']] : []), ...(isCoach() ? [] : [['settings', 'Settings']])];
  return h('nav', { class: 'row wrap tm-views', 'aria-label': 'Leads sections' }, items.map(([k, label]) => h('a', { class: 'tm-view', href: `#/leads${k ? `/${k}` : ''}`, 'aria-current': current === k ? 'page' : null, style: 'text-decoration:none' }, label)));
}

// ---------- Moving a lead ----------
// The Move menu: every stage as a big button (works with the keyboard and on a phone). Lost asks why.
export function moveDialog(l, done) {
  const reason = select([['', 'Pick a reason'], ...LOST_REASONS], { 'aria-label': 'Why they didn\'t join' });
  const note = input({ maxlength: '500', placeholder: 'Anything to remember (optional)', 'aria-label': 'Note about why' });
  const lostBox = h('div', { class: 'stack', hidden: true }, field('Why didn\'t they join?', reason), field('Note', note));
  const move = async (to) => {
    const body = { status: to };
    if (to === 'lost') {
      if (lostBox.hidden) { lostBox.hidden = false; reason.focus(); return false; }
      if (!reason.value) { reason.focus(); throw new Error('Pick why they didn\'t join.'); }
      Object.assign(body, { lost_reason: reason.value, lost_note: note.value || undefined });
    }
    await patch(`/v1/leads/${l.id}`, body);
    toast(`${l.parent_name} moved to ${stageLabel(to)}.`);
    done();
  };
  const list = h('div', { class: 'stack', role: 'group', 'aria-label': `Move ${l.parent_name} to` }, STAGES.map(([k, label]) => btn(k === l.status ? `${label} (now)` : label, (e) => busy(e.currentTarget, async () => {
    try { if ((await move(k)) !== false) document.getElementById('dialog').close(); } catch (x) { toast(x.message, 'warn'); }
  }), k === l.status ? 'ghost' : 'secondary', { disabled: k === l.status && k !== 'lost', style: 'justify-content:flex-start' })));
  dialog(`Move ${l.parent_name}`, h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, `${inStage(l)}. Leads also move on their own when the family signs up, books an evaluation, starts a trial or joins.`), list, lostBox),
    [{ label: 'Close', variant: 'ghost' }]);
  list.querySelector('button:not([disabled])')?.focus();
}

// ---------- Adding a lead ----------
function addLeadDialog(done) {
  const f = { parent_name: input({ autocomplete: 'off', maxlength: '120' }), email: input({ type: 'email', autocomplete: 'off' }), phone: input({ type: 'tel', autocomplete: 'off' }),
    athlete_name: input({ maxlength: '120' }), athlete_age: input({ type: 'number', inputmode: 'numeric', min: '3', max: '99' }), sport: input({ maxlength: '60' }), message: textarea('', { maxlength: '2000' }) };
  const source = select(STAFF_SOURCES, { value: 'phone' });
  const followUp = h('input', { type: 'checkbox', checked: true });
  const textsOk = h('input', { type: 'checkbox' });
  const warn = h('div', { class: 'small', role: 'status', 'aria-live': 'polite' });
  let t, anyway = false;
  const check = () => { clearTimeout(t); anyway = false; t = setTimeout(async () => {
    const q = new URLSearchParams({ ...(f.email.value.trim() ? { email: f.email.value.trim() } : {}), ...(f.phone.value.replace(/\D/g, '').length >= 7 ? { phone: f.phone.value } : {}) });
    if (!q.size) return fill(warn);
    try { fill(warn, dupList(await get(`/v1/leads/duplicates?${q}`))); } catch { fill(warn); }
  }, 350); };
  f.email.addEventListener('input', check); f.phone.addEventListener('input', check);
  dialog('Add a lead', h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() },
    h('div', { class: 'form-grid' }, field('Parent name', f.parent_name), field('How they found you', source)),
    h('div', { class: 'form-grid' }, field('Email', f.email), field('Phone', f.phone)), warn,
    h('div', { class: 'form-grid' }, field('Athlete name', f.athlete_name), field('Athlete age', f.athlete_age)),
    field('Sport', f.sport), field('What they\'re looking for', f.message),
    h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, textsOk, h('span', null, 'They said texts are OK (US mobile)')),
    h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, followUp, h('span', null, 'Send the automatic follow-up emails'))),
  [{ label: 'Add lead', variant: 'primary', onClick: async (d, err) => {
    const body = { ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim() || undefined])), athlete_age: f.athlete_age.value ? Number(f.athlete_age.value) : undefined,
      source: source.value, follow_up: followUp.checked, texts_ok: textsOk.checked, texts_ok_source: textsOk.checked ? `Told ${me().name}` : undefined, check_duplicates: !anyway };
    try {
      const l = await post('/v1/leads', body);
      toast('Lead added.'); done(l);
    } catch (x) {
      if (x.code === 'possible_duplicate') { anyway = true; fill(warn, dupList(x.details.duplicates), h('p', { class: 'small warn-text', style: 'margin:4px 0 0' }, 'Press Add lead again to add it anyway.')); return false; }
      if (x.code === 'conflict' && x.details?.lead_id) { fill(warn, h('p', { class: 'small warn-text', style: 'margin:0' }, x.message, ' ', h('a', { href: `#/leads/${x.details.lead_id}`, onClick: () => document.getElementById('dialog').close() }, 'Open that lead'))); return false; }
      throw x;
    }
  } }, { label: 'Cancel', variant: 'ghost' }]);
  f.parent_name.focus();
}
function dupList(d) {
  if (!d?.count) return null;
  const close = () => document.getElementById('dialog')?.close();
  const what = (m) => (m === 'email' ? 'same email' : 'same phone');
  return h('div', { class: 'stack-tight', style: 'border-left:3px solid var(--amber);padding-left:10px' },
    h('span', { class: 'small warn-text' }, 'Someone you may already have:'),
    ...d.leads.map((l) => h('a', { class: 'small', href: `#/leads/${l.id}`, onClick: close }, `${l.parent_name} · lead, ${l.stage} (${what(l.match)})`)),
    ...d.families.map((f) => (f.client_id ? h('a', { class: 'small', href: `#/clients/${f.client_id}`, onClick: close }, `${f.name} · ${f.parent_name} has an account (${what(f.match)})`) : h('span', { class: 'small' }, `${f.name} (${what(f.match)})`))),
    ...d.clients.map((c) => h('a', { class: 'small', href: `#/clients/${c.id}`, onClick: close }, `${c.name}${c.athlete_id ? ` · ${c.athlete_id}` : ''}${c.archived ? ' (archived)' : ''} (${what(c.match)})`)));
}

// ---------- Leads: list and pipeline board ----------
const leadsUi = { view: 'list', q: '', status: 'open', source: '', stale: false, sort: 'newest' };
export async function viewLeads(main) {
  const qs = query();
  if (qs.get('view')) leadsUi.view = qs.get('view') === 'board' ? 'board' : 'list';
  if (qs.has('status')) leadsUi.status = qs.get('status') || 'open';
  const coachView = isCoach();
  const box = h('div', { class: 'stack' });
  const search = input({ type: 'search', placeholder: 'Name, email, phone or sport', 'aria-label': 'Search leads', value: leadsUi.q, style: 'flex:1 1 220px' });
  const stageSel = select([['open', 'All open'], ...STAGES, ['all', 'Every stage']], { value: leadsUi.status, 'aria-label': 'Stage', style: 'width:auto' });
  const sortSel = select([['newest', 'Newest'], ['oldest', 'Oldest'], ['stale', 'Longest untouched'], ['stage_age', 'Longest in stage'], ['next_task', 'Next task'], ['name', 'Name']], { value: leadsUi.sort, 'aria-label': 'Sort', style: 'width:auto' });
  const staleBox = h('input', { type: 'checkbox', checked: leadsUi.stale });
  let sourceSel = null, res = null, t;
  const load = async () => {
    const q = new URLSearchParams({ sort: leadsUi.sort });
    if (leadsUi.view === 'list') { if (leadsUi.status === 'open') q.set('open', 'true'); else if (leadsUi.status !== 'all') q.set('status', leadsUi.status); }
    if (leadsUi.q) q.set('q', leadsUi.q);
    if (leadsUi.source) q.set('source', leadsUi.source);
    if (leadsUi.stale) q.set('stale', 'true');
    res = await get(`/v1/leads?${q}`);
    if (!sourceSel) {
      sourceSel = select([['', 'Every source'], ...Object.entries(res.sources)], { value: leadsUi.source, 'aria-label': 'How they found you', style: 'width:auto' });
      sourceSel.addEventListener('change', () => { leadsUi.source = sourceSel.value; load(); });
      toolbar.insertBefore(sourceSel, staleLabel);
    }
    draw();
  };
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { leadsUi.q = search.value.trim(); load(); }, 300); });
  stageSel.addEventListener('change', () => { leadsUi.status = stageSel.value; load(); });
  sortSel.addEventListener('change', () => { leadsUi.sort = sortSel.value; load(); });
  staleBox.addEventListener('change', () => { leadsUi.stale = staleBox.checked; load(); });
  const staleLabel = h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, staleBox, h('span', null, 'Stale only'));
  const viewBtns = h('div', { class: 'row tm-views', role: 'group', 'aria-label': 'Show leads as' }, [['list', 'List'], ['board', 'Board']].map(([k, label]) =>
    h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(leadsUi.view === k), onClick: (e) => { leadsUi.view = k; for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); history.replaceState(null, '', `#/leads${k === 'board' ? '?view=board' : ''}`); load(); } }, label)));
  const toolbar = h('div', { class: 'row wrap bl-tools', style: 'gap:8px' }, viewBtns, search, stageSel, sortSel, staleLabel);
  const refresh = () => load();
  const row = (l) => h('div', { class: 'list-item', style: 'flex-wrap:wrap;align-items:flex-start' },
    h('div', { class: 'grow stack-tight', style: 'min-width:220px' },
      h('a', { href: `#/leads/${l.id}`, class: 'strong', style: 'color:var(--steel)' }, l.parent_name, l.athlete_name ? h('span', { class: 'muted' }, ` for ${l.athlete_name}${l.athlete_age ? `, ${l.athlete_age}` : ''}`) : null),
      h('span', { class: 'small muted', style: 'overflow-wrap:anywhere' }, [l.source_label, l.sport, `asked ${ago(l.created_at).toLowerCase()}`, !coachView && l.coach_name ? `with ${l.coach_name}` : null].filter(Boolean).join(' · ')),
      h('span', { class: 'small' }, inStage(l), l.next_task_due ? h('span', { class: `${l.next_task_due < localToday() ? 'warn-text' : 'muted'}` }, ` · next task ${shortDay(l.next_task_due)}`) : null)),
    h('div', { class: 'row wrap', style: 'gap:6px' }, staleBadge(l), stageBadge(l.status), btn('Move', () => moveDialog(l, refresh), 'ghost', { 'aria-label': `Move ${l.parent_name} to another stage` })));
  const card = (l) => h('div', { class: 'crm-card' },
    h('a', { href: `#/leads/${l.id}`, class: 'strong', style: 'color:var(--steel)' }, l.parent_name),
    l.athlete_name ? h('span', { class: 'small muted' }, `for ${l.athlete_name}${l.athlete_age ? `, ${l.athlete_age}` : ''}`) : null,
    h('span', { class: 'small muted' }, l.days_in_stage ? `${plural(l.days_in_stage, 'day')} here` : 'Here since today'),
    h('div', { class: 'row wrap', style: 'gap:6px;justify-content:space-between' }, staleBadge(l) ?? h('span'), btn('Move', () => moveDialog(l, refresh), 'ghost', { 'aria-label': `Move ${l.parent_name} to another stage` })));
  const draw = () => {
    stageSel.hidden = sortSel.hidden = leadsUi.view === 'board';     // the board shows every stage
    if (leadsUi.view === 'board') {
      const cols = STAGES.filter(([k]) => OPEN.includes(k) || k === 'member' || k === 'lost');
      fill(box, h('div', { class: 'crm-board', role: 'list', 'aria-label': 'Pipeline' }, cols.map(([k, label]) => {
        const list = res.data.filter((l) => l.status === k);
        const shown = ['member', 'lost'].includes(k) ? list.slice(0, 8) : list;
        return h('section', { class: 'crm-col', role: 'listitem', 'aria-label': `${label}: ${list.length}` },
          h('h2', { class: 'crm-col-title' }, label, h('span', { class: 'muted' }, ` ${list.length}`)),
          shown.length ? shown.map(card) : h('p', { class: 'small muted', style: 'margin:0' }, 'Nobody here.'),
          list.length > shown.length ? h('a', { class: 'small', href: `#/leads?status=${k}`, onClick: () => { leadsUi.view = 'list'; } }, `See all ${list.length}`) : null);
      })));
      return;
    }
    fill(box, panel(null, {}, res.data.length ? res.data.map(row) : h('p', { class: 'muted', style: 'margin:0' }, leadsUi.q || leadsUi.source || leadsUi.stale ? 'No leads match.' : coachView ? 'No leads for you right now. When the owner gives you one, it shows here and you get an email.' : 'No open leads. Share your inquiry form link (Settings) to start collecting them.')));
  };
  await load();
  const summary = coachView ? 'Families the owner asked you to follow up with. Only you, the owner and the front desk see them.'
    : `${plural(res.last_30_days.leads, 'family', 'families')} asked about training in the last 30 days; ${res.last_30_days.signed_up} signed up.${res.stale ? ` ${plural(res.stale, 'lead')} nobody has worked for a week.` : ''}`;
  fill(main, header('Leads', summary, coachView ? null : btn('Add lead', () => addLeadDialog((l) => { location.hash = `#/leads/${l.id}`; }), 'primary')),
    leadNav(''), toolbar, box);
}

// ---------- A lead's page ----------
export async function viewLead(main, id) {
  let l;
  try { l = await get(`/v1/leads/${id}`); }
  catch (e) { return fill(main, header('Lead not found', 'It may have been deleted, or it isn\'t one of yours.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/leads' }, 'All leads')), h('div', { class: 'empty' }, e.message)); }
  const [tl, tasks, templates, coaches, staff] = await Promise.all([get(`/v1/leads/${id}/timeline`), get(`/v1/tasks?lead_id=${id}&status=all`), get('/v1/message-templates'), isOwner() ? get('/v1/coaches') : null,
    isOwner() ? get('/v1/staff').catch(() => null) : null]);
  const again = () => viewLead(main, id);
  const owner = isOwner(), coachView = isCoach();

  // Stage
  const stagePanel = panel('Stage', { subtitle: `${inStage(l)}.${l.stale ? ` Nobody has worked this lead for ${plural(l.idle_days, 'day')}.` : ''}`, action: btn('Move', () => moveDialog(l, again), 'secondary', { 'aria-label': 'Move to another stage' }) },
    h('div', { class: 'row wrap', style: 'gap:8px' }, stageBadge(l.status), staleBadge(l), l.status === 'lost' && l.lost_reason_label ? h('span', { class: 'small muted' }, `Why: ${l.lost_reason_label}${l.lost_note ? `. ${l.lost_note}` : ''}`) : null),
    h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Stage history (${l.history.length})`),
      h('ol', { class: 'small', style: 'margin:0;padding-left:20px' }, l.history.map((x) => h('li', null, `${x.to_label} · ${when(x.at)}${x.auto ? ' · on its own' : x.by_name ? ` · ${x.by_name}` : ''}${x.reason ? ` · ${x.reason}` : ''}`)))));

  // Contact: call, email, text, log a call, note; contact preferences.
  const blocked = (why) => (why ? h('p', { class: 'small muted', style: 'margin:0' }, why) : null);
  const tplOf = (ch) => templates.data.filter((t) => t.channel === ch);
  const contactPanel = panel('Contact', { subtitle: [l.email, phoneText(l.phone)].filter(Boolean).join(' · ') || 'No email or phone yet. Add one under Details.' },
    h('div', { class: 'row wrap', style: 'gap:8px' },
      l.phone ? h('a', { class: 'dp-btn dp-btn--secondary', href: `tel:${l.phone}` }, 'Call') : null,
      btn('Log a call', () => logDialog({ path: `/v1/leads/${id}/activity`, call: true, name: l.parent_name, done: again }), 'secondary'),
      btn('Add a note', () => logDialog({ path: `/v1/leads/${id}/activity`, call: false, name: l.parent_name, done: again }), 'secondary'),
      btn('Email', () => emailDialog({ path: `/v1/leads/${id}/email`, to: l.email, templates: tplOf('email'), vars: { parent: l.parent_name, athlete: l.athlete_name }, done: again }), 'secondary', { disabled: !!l.email_block }),
      btn('Text', () => textDialog({ path: `/v1/leads/${id}/text`, to: phoneText(l.phone), templates: tplOf('text'), vars: { parent: l.parent_name, athlete: l.athlete_name }, done: again }), 'secondary', { disabled: !!l.text_block })),
    blocked(l.email ? l.email_block : null), blocked(l.phone || l.texts_ok ? l.text_block : null),
    prefsBlock(l, again));

  // Tasks
  const taskPanel = tasksBlock({ tasks: tasks.data, leadId: id, staff, lead: l, done: again });

  // Convert or book an evaluation
  const convertPanel = l.client_id ? await convertedPanel(l) : convertBlock(l, again);

  // Details and assignment
  const d = { parent_name: input({ value: l.parent_name, maxlength: '120' }), email: input({ type: 'email', value: l.email ?? '' }), phone: input({ type: 'tel', value: phoneText(l.phone) ?? '' }),
    athlete_name: input({ value: l.athlete_name ?? '', maxlength: '120' }), athlete_age: input({ type: 'number', inputmode: 'numeric', value: l.athlete_age ?? '' }), sport: input({ value: l.sport ?? '', maxlength: '60' }), notes: textarea(l.notes ?? '', { maxlength: '4000', placeholder: 'What they need, best times, who to talk to' }) };
  const detailsPanel = panel('Details', { subtitle: `${l.source_label}${l.created_by ? ` · added by ${l.created_by}` : ''} · ${date(l.created_at)}` },
    l.message ? h('p', { class: 'small muted', style: 'white-space:pre-wrap;margin:0' }, `"${l.message}"`) : null,
    h('div', { class: 'form-grid' }, field('Parent name', d.parent_name), field('Sport', d.sport)),
    h('div', { class: 'form-grid' }, field('Email', d.email), field('Phone', d.phone, 'A new number turns "OK to text" off.')),
    h('div', { class: 'form-grid' }, field('Athlete name', d.athlete_name), field('Athlete age', d.athlete_age)),
    field('Notes', d.notes),
    h('div', { class: 'row wrap', style: 'gap:8px' }, btn('Save details', (e) => busy(e.currentTarget, async () => {
      await patch(`/v1/leads/${id}`, { parent_name: d.parent_name.value, email: d.email.value.trim() || null, phone: d.phone.value.trim() || null, athlete_name: d.athlete_name.value.trim() || null,
        athlete_age: d.athlete_age.value ? Number(d.athlete_age.value) : null, sport: d.sport.value.trim() || null, notes: d.notes.value });
      toast('Saved.'); again();
    }), 'secondary'),
    l.follow_up === 'on' ? btn('Stop automatic follow-up', (e) => busy(e.currentTarget, async () => { await patch(`/v1/leads/${id}`, { follow_up: false }); toast('Automatic follow-up stopped.'); again(); }), 'ghost') : null),
    owner ? (() => {
      const giveTo = select([['', 'Nobody (you and the front desk)'], ...(coaches?.data ?? []).filter((c) => c.role === 'coach').map((c) => [c.id, c.name]),
        ...(l.coach_id && !(coaches?.data ?? []).some((c) => c.id === l.coach_id && c.role === 'coach') ? [[l.coach_id, l.coach_name ?? 'Former coach']] : [])], { value: l.coach_id ?? '', 'aria-label': 'Give this lead to a coach', style: 'width:auto;min-width:200px' });
      giveTo.addEventListener('change', () => busy(giveTo, async () => { await patch(`/v1/leads/${id}`, { coach_id: giveTo.value || null }); toast(giveTo.value ? `${giveTo.selectedOptions[0].textContent} can see and work this lead now. They were emailed.` : 'Taken back: only you and the front desk see it.'); again(); }));
      return h('div', { class: 'row wrap', style: 'gap:8px;border-top:1px solid var(--line-subtle);padding-top:12px' }, h('span', { class: 'small muted' }, 'Give to a coach:'), giveTo,
        h('span', { class: 'grow' }), btn('Delete lead', (e) => { if (confirm(`Delete ${l.parent_name}'s lead and everything logged on it?`)) busy(e.currentTarget, async () => { await del(`/v1/leads/${id}`); toast('Deleted.'); location.hash = '#/leads'; }); }, 'ghost'));
    })() : !coachView && l.coach_name ? h('p', { class: 'small muted', style: 'margin:0' }, `The owner gave this lead to ${l.coach_name}.`) : null);

  const dups = l.duplicates?.count ? h('div', { class: 'dp-panel', role: 'note' }, dupList(l.duplicates)) : null;
  fill(main,
    header(l.parent_name, [l.athlete_name ? `For ${l.athlete_name}${l.athlete_age ? `, ${l.athlete_age}` : ''}` : null, l.sport, l.stage_label].filter(Boolean).join(' · '), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/leads' }, 'All leads')),
    dups,
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'stack', style: 'gap:24px' }, stagePanel, contactPanel, convertPanel, taskPanel),
      h('div', { class: 'stack', style: 'gap:24px' }, timelinePanel(tl.data, 'Timeline'), detailsPanel)));
}
function prefsBlock(l, done) {
  const wrap = h('div', { class: 'stack-tight', style: 'border-top:1px solid var(--line-subtle);padding-top:12px' });
  const textsLine = l.texts_ok ? `OK to text: ${l.texts_ok_source ?? 'yes'}${l.texts_ok_at ? ` (${date(l.texts_ok_at)})` : ''}.` : l.texts_stopped ? 'They texted STOP: no texts until they text START.' : 'Not OK to text yet.';
  fill(wrap, h('span', { class: 'dp-label', style: 'margin:0' }, 'Contact preferences'),
    h('span', { class: 'small' }, textsLine),
    h('span', { class: 'small' }, l.email_opted_out ? `Asked us to stop emailing (${date(l.email_opted_out_at)}). Only they can undo that.` : l.email ? 'Emails OK.' : 'No email.'),
    h('div', { class: 'row wrap', style: 'gap:8px;margin-top:6px' },
      !l.texts_ok && !l.texts_stopped && l.phone ? btn('They said texts are OK', () => {
        const how = input({ maxlength: '120', placeholder: 'Said yes on the phone', 'aria-label': 'How they said yes' });
        dialog('Texts are OK?', h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, `Only turn this on if ${first(l.parent_name)} said yes to texts at ${phoneText(l.phone)}. Every text says how to stop.`), field('How did they say yes?', how)),
          [{ label: 'Turn on texts', variant: 'primary', onClick: async () => { await patch(`/v1/leads/${l.id}`, { texts_ok: true, texts_ok_source: how.value.trim() || `Told ${me().name}` }); toast('Texts are on for this lead.'); done(); } }, { label: 'Cancel', variant: 'ghost' }]);
        how.focus();
      }, 'ghost') : null,
      l.texts_ok ? btn('Stop texts', (e) => busy(e.currentTarget, async () => { await patch(`/v1/leads/${l.id}`, { texts_ok: false }); toast('No more texts to this lead.'); done(); }), 'ghost') : null,
      l.email && !l.email_opted_out ? btn('Don\'t email', (e) => { if (confirm(`Stop every email to ${l.email}? Only they can turn emails back on.`)) busy(e.currentTarget, async () => { await patch(`/v1/leads/${l.id}`, { email_ok: false }); toast('No more emails to that address.'); done(); }); }, 'ghost') : null));
  return wrap;
}
function convertBlock(l, done) {
  const name = input({ value: l.athlete_name ?? '', maxlength: '120' }), birth = input({ type: 'date' }), email = input({ type: 'email', value: l.email ?? '' });
  const aid = input({ placeholder: 'AVALOP2026', autocomplete: 'off', style: 'text-transform:uppercase', 'aria-label': 'Athlete ID' });
  const out = h('div', { class: 'small', role: 'status' });
  let anyway = false, familyId = null;
  const send = async (button, body) => busy(button, async () => {
    try {
      const r = await post(`/v1/leads/${l.id}/convert`, body);
      toast(`${r.client.name} is a client now${r.client.athlete_id ? ` (${r.client.athlete_id})` : ''}.`);
      done();
    } catch (x) {
      if (x.code === 'possible_duplicate') { anyway = true; fill(out, h('span', { class: 'warn-text' }, x.message), ' ', ...(x.details?.duplicates ?? []).map((c) => h('a', { href: `#/clients/${c.id}`, style: 'margin-right:8px' }, `${c.name} (${c.athlete_id})`)), h('div', null, 'Press Make client again to make a new profile anyway.')); return; }
      if (x.code === 'parent_exists') { familyId = x.details.family.id; fill(out, h('span', { class: 'warn-text' }, x.message), ' ', h('div', null, `Press Make client again to add ${name.value || 'the athlete'} to the ${x.details.family.name}.`)); return; }
      fill(out, h('span', { class: 'warn-text' }, x.message));
    }
  });
  return panel('Make them a client', { subtitle: 'Creates the athlete\'s profile and the family\'s login (they get a welcome email), links this lead and copies its notes. Nothing is retyped.' },
    h('div', { class: 'form-grid' }, field('Athlete name', name), field('Birthday', birth, 'Needed for age groups.')),
    field('Parent email (they sign in with it)', email),
    out,
    h('div', null, btn('Make client', (e) => send(e.currentTarget, { name: name.value, birth_date: birth.value || undefined, check_duplicates: !anyway,
      ...(familyId ? { family_id: familyId } : { parent: { name: l.parent_name, email: email.value.trim(), phone: l.phone ?? undefined } }) }), 'primary')),
    h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Already a client, or on a team roster? Link by Athlete ID'),
      h('div', { class: 'row wrap', style: 'gap:8px' }, aid, btn('Link profile', (e) => send(e.currentTarget, { athlete_id: aid.value.trim() }), 'secondary')),
      h('p', { class: 'small muted', style: 'margin:4px 0 0' }, 'One profile per athlete: linking keeps their results and history together. A profile without a family goes into one for this parent.')));
}
async function convertedPanel(l) {
  const c = l.client;
  const slots = await get('/v1/slots?kind=evaluation').catch(() => ({ data: [] }));
  const next = (slots.data ?? []).slice(0, 6);
  const book = async (s, button) => busy(button, async () => {
    await post('/v1/slots/book', { kind: 'evaluation', starts_at: s.starts_at, availability_id: s.availability_id, client_id: c.id });
    toast(`Evaluation booked for ${when(s.starts_at)}.`); render();
  });
  return panel('Client', { subtitle: `${c.name}${c.athlete_id ? ` · ${c.athlete_id}` : ''}${c.archived ? ' · archived' : ''}`, action: h('a', { class: 'dp-btn dp-btn--secondary', href: `#/clients/${c.id}` }, 'Open profile') },
    ['signed_up', 'contacted', 'new'].includes(l.status) ? h('div', { class: 'stack-tight' },
      h('span', { class: 'dp-label', style: 'margin:0' }, 'Book an evaluation'),
      next.length ? h('div', { class: 'row wrap', style: 'gap:6px' }, next.map((s) => btn(`${when(s.starts_at)}${s.location_name ? ` · ${s.location_name}` : ''}`, (e) => book(s, e.currentTarget), 'outline'))) : h('p', { class: 'small muted', style: 'margin:0' }, 'No evaluation times open. Add hours in Schedule → Hours & settings.')) : null);
}

// Log a call or a note.
function logDialog({ path, call, name, done }) {
  const outcome = select(CALL_OUTCOMES, { 'aria-label': 'How it went' });
  const body = textarea('', { maxlength: '4000', placeholder: call ? 'What you talked about (optional)' : 'The note' });
  dialog(call ? `Log a call with ${first(name)}` : 'Add a note', h('div', { class: 'stack' }, call ? field('How it went', outcome) : null, field(call ? 'Notes' : 'Note', body)),
    [{ label: call ? 'Log call' : 'Add note', variant: 'primary', onClick: async () => { await post(path, { kind: call ? 'call' : 'note', outcome: call ? outcome.value : undefined, body: body.value.trim() || undefined }); toast(call ? 'Call logged.' : 'Note added.'); done(); } },
      { label: 'Cancel', variant: 'ghost' }]);
  (call ? outcome : body).focus();
}
// Fill a template's placeholders for the preview (the server fills them again when it sends).
const preview = (text, vars) => String(text ?? '').replace(/\{first_name\}/g, first(vars.parent) || 'there').replace(/\{athlete\}/g, vars.athlete ? first(vars.athlete) : 'your athlete')
  .replace(/\{my_name\}/g, first(me().name)).replace(/\{business\}/g, 'Diamond Protocol').replace(/\{book_link\}/g, `${location.origin}/book`).replace(/\{join_link\}/g, `${location.origin}/join`);
function emailDialog({ path, to, templates, vars, done, recipients }) {
  const tpl = select([['', 'Write your own'], ...templates.map((t) => [t.id, t.name])], { 'aria-label': 'Template' });
  const subject = input({ maxlength: '150' }), body = textarea('', { maxlength: '10000', style: 'min-height:200px' });
  const who = recipients?.length > 1 ? select(recipients.map((r) => [r.guardian_id ?? '', `${r.name} · ${r.email}${r.email_block ? ' (asked us to stop)' : ''}`]), { 'aria-label': 'To' }) : null;
  tpl.addEventListener('change', () => { const t = templates.find((x) => x.id === tpl.value); if (t) { subject.value = preview(t.subject, vars); body.value = preview(t.body, vars); } });
  dialog('Email', h('div', { class: 'stack' }, who ? field('To', who) : h('p', { class: 'small muted', style: 'margin:0' }, `To ${to}`), field('Template', tpl), field('Subject', subject), field('Message', body),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Your business address and a "stop these emails" link are added at the end.')),
  [{ label: 'Send email', variant: 'primary', onClick: async () => {
    const r = await post(path, { subject: subject.value, body: body.value, ...(who?.value ? { guardian_id: who.value } : {}) });
    toast(r.note ?? `Emailed ${r.sent_to}.`, r.status === 'failed' ? 'warn' : 'good'); done();
  } }, { label: 'Cancel', variant: 'ghost' }]);
  subject.focus();
}
function textDialog({ path, to, templates, vars, done }) {
  const tpl = select([['', 'Write your own'], ...templates.map((t) => [t.id, t.name])], { 'aria-label': 'Template' });
  const body = textarea('', { maxlength: '480' });
  const count = h('p', { class: 'small muted', role: 'status', style: 'margin:0' });
  const recount = () => { const n = body.value.length + 40; count.textContent = `${body.value.length} of 480 characters · about ${Math.max(1, Math.ceil(n / 153))} text${n > 160 ? 's' : ''}. "Diamond Protocol:" goes first and "Reply STOP to stop." last.`; };
  body.addEventListener('input', recount);
  tpl.addEventListener('change', () => { const t = templates.find((x) => x.id === tpl.value); if (t) { body.value = preview(t.body, vars).slice(0, 480); recount(); } });
  recount();
  dialog('Text', h('div', { class: 'stack' }, to ? h('p', { class: 'small muted', style: 'margin:0' }, `To ${to}`) : null, field('Template', tpl), field('Message', body), count),
    [{ label: 'Send text', variant: 'primary', onClick: async () => { const r = await post(path, { body: body.value }); toast(r.note ?? 'Text sent.', r.status === 'failed' || r.status === 'held' ? 'warn' : 'good'); done(); } }, { label: 'Cancel', variant: 'ghost' }]);
  body.focus();
}

// ---------- Timeline ----------
const KIND_ICON = { created: 'In', stage: 'Stage', note: 'Note', call: 'Call', email: 'Email', text: 'Text', text_in: 'Reply', task: 'Task', task_done: 'Done', booking: 'Booking', membership: 'Membership', payment: 'Paid' };
function timelineItem(x) {
  return h('li', { class: 'crm-tl-item' },
    h('div', { class: 'row wrap', style: 'gap:8px;align-items:baseline' }, h('span', { class: `dp-badge dp-badge--${x.kind === 'text_in' ? 'warn' : x.kind === 'payment' ? 'good' : 'muted'}` }, KIND_ICON[x.kind] ?? x.kind),
      h('span', { class: 'strong grow', style: 'overflow-wrap:anywhere' }, x.title), h('span', { class: 'small muted', title: new Date(x.at).toLocaleString() }, when(x.at))),
    x.body ? h('div', { class: 'small', style: 'white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px' }, x.body.length > 600 ? `${x.body.slice(0, 600)}…` : x.body, x.session_starts_at ? ` · for ${when(x.session_starts_at)}` : '') : null,
    x.by || (x.outcome && ['email', 'text'].includes(x.kind)) ? h('div', { class: 'small muted' }, [x.by, x.kind === 'text' || x.kind === 'email' ? { logged: 'not sent (test mode)', held: 'held', failed: 'failed', sent: null }[x.outcome] ?? null : null].filter(Boolean).join(' · ')) : null);
}
function timelinePanel(items, title, { limit = 40 } = {}) {
  const list = h('ol', { class: 'crm-tl' });
  let shown = limit;
  const draw = () => fill(list, items.slice(0, shown).map(timelineItem), items.length > shown ? h('li', null, btn('Show more', () => { shown += 40; draw(); }, 'ghost')) : null);
  draw();
  return panel(title, { subtitle: items.length ? null : 'Nothing yet.' }, list);
}

// ---------- Tasks ----------
function taskRow(t, { done, showAbout = true, canEdit = true }) {
  const mineOrOwner = isOwner() || t.assignee_id === me().id || t.created_by_id === me().id;
  return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('button', { type: 'button', class: 'dp-ex-log', style: 'min-width:92px', 'aria-pressed': String(t.done), disabled: !mineOrOwner || !canEdit, 'aria-label': `${t.done ? 'Not done' : 'Done'}: ${t.title}`,
      onClick: (e) => busy(e.currentTarget, async () => { await patch(`/v1/tasks/${t.id}`, { done: !t.done }); toast(t.done ? 'Back on the list.' : 'Done.'); done(); }) }, t.done ? 'Done' : 'Mark done'),
    h('div', { class: 'grow stack-tight', style: 'min-width:180px' },
      h('span', { class: 'strong', style: t.done ? 'text-decoration:line-through;color:var(--steel-muted)' : null }, t.title),
      h('span', { class: `small ${t.overdue ? 'warn-text' : 'muted'}` }, [t.overdue ? `Overdue since ${shortDay(t.due_date)}` : t.due_today ? 'Due today' : `Due ${shortDay(t.due_date)}`, t.assignee_name && t.assignee_id !== me().id ? `for ${t.assignee_name}` : null].filter(Boolean).join(' · '), showAbout && t.link ? [' · ', h('a', { href: t.link }, t.about)] : null)),
    (isOwner() || t.created_by_id === me().id) ? btn('Delete', (e) => busy(e.currentTarget, async () => { await del(`/v1/tasks/${t.id}`); toast('Task deleted.'); done(); }), 'ghost', { 'aria-label': `Delete task ${t.title}` }) : null);
}
function assigneeOptions(staffList, lead) {
  const me0 = me();
  if (isCoach() || !staffList) return null;
  const ok = staffList.data.filter((u) => u.active && (u.role !== 'coach' || (isOwner() && (!lead || lead.coach_id === u.id))));
  return [[me0.id, `Me (${me0.name})`], ...ok.filter((u) => u.id !== me0.id).map((u) => [u.id, `${u.name}${u.role === 'front_desk' ? ' (front desk)' : u.role === 'coach' ? ' (coach)' : ''}`])];
}
function tasksBlock({ tasks, leadId, clientId, staff, lead, done, title = 'Tasks', flat = false }) {
  const openTasks = tasks.filter((t) => !t.done), doneTasks = tasks.filter((t) => t.done);
  const what = input({ maxlength: '200', placeholder: 'Call back about camp', 'aria-label': 'What to do' });
  const due = input({ type: 'date', value: localToday(), 'aria-label': 'Due', style: 'width:auto' });
  const opts = assigneeOptions(staff, lead);
  const who = opts ? select(opts, { 'aria-label': 'For', style: 'width:auto;max-width:100%' }) : null;
  const wrap = (...kids) => (flat ? h('div', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px' }, h('h3', { class: 'dp-label', style: 'margin:0' }, title), ...kids)
    : panel(title, { subtitle: openTasks.length ? `${plural(openTasks.length, 'open task')}. Overdue and today's show on Today for the person they're for.` : 'Overdue and today\'s tasks show on Today for the person they\'re for.' }, ...kids));
  return wrap(
    openTasks.map((t) => taskRow(t, { done, showAbout: false })),
    doneTasks.length ? h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Done (${doneTasks.length})`), doneTasks.map((t) => taskRow(t, { done, showAbout: false }))) : null,
    h('form', { class: 'row wrap', style: 'gap:8px;border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      if (!what.value.trim()) throw new Error('Say what to do.');
      await post('/v1/tasks', { title: what.value, due_date: due.value || undefined, ...(leadId ? { lead_id: leadId } : { client_id: clientId }), ...(who ? { assignee_id: who.value } : {}) });
      toast('Task added.'); done();
    }); } }, h('div', { style: 'flex:1 1 200px' }, what), due, who, btn('Add task', null, 'secondary', { type: 'submit' })));
}
const tasksUi = { mine: true, status: 'open' };
export async function viewTasks(main) {
  const q = new URLSearchParams({ status: tasksUi.status, ...(isOwner() && tasksUi.mine ? { mine: 'true' } : {}) });
  const r = await get(`/v1/tasks?${q}`);
  const again = () => viewTasks(main);
  const groups = tasksUi.status === 'done' ? [['Done', r.data]] : [['Overdue', r.data.filter((t) => t.overdue)], ['Today', r.data.filter((t) => t.due_today)], ['Coming up', r.data.filter((t) => !t.overdue && !t.due_today)]];
  const toggles = h('div', { class: 'row wrap tm-views', role: 'group', 'aria-label': 'Show tasks' },
    isOwner() ? [[true, 'Mine'], [false, 'Everyone\'s']].map(([k, label]) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(tasksUi.mine === k), onClick: () => { tasksUi.mine = k; again(); } }, label)) : null,
    [['open', 'To do'], ['done', 'Done']].map(([k, label]) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(tasksUi.status === k), onClick: () => { tasksUi.status = k; again(); } }, label)));
  fill(main, header('Tasks', isOwner() ? 'Follow-ups on leads and families. Add a task from a lead\'s page or a client\'s contact history.' : 'Your follow-ups. Add a task from a lead\'s page or a client\'s contact history.'),
    leadNav('tasks'), toggles,
    ...groups.filter(([, list]) => list.length).map(([title, list]) => panel(`${title} (${list.length})`, {}, list.map((t) => taskRow(t, { done: again })))),
    r.data.length ? null : h('div', { class: 'empty' }, tasksUi.status === 'done' ? 'Nothing done yet.' : 'Nothing to do. Nice.'));
}
// Today: your tasks due today or overdue.
export function todayTasksPanel(tasks, refresh) {
  if (!tasks?.length) return null;
  return panel(`Your tasks (${tasks.length})`, { subtitle: 'Due today or overdue.', action: h('a', { class: 'dp-btn dp-btn--secondary', href: '#/leads/tasks' }, 'All tasks') }, tasks.map((t) => taskRow(t, { done: refresh })));
}

// ---------- Client profile: contact history ----------
// A panel that loads itself: the family's notes, calls, emails, texts, leads and tasks, with Email, Text, Add task and
// Put back in pipeline. Coaches log notes and calls and add their own tasks; owners and front desk also email and text.
export function contactHistoryPanel(clientId, client) {
  const box = panel('Contact history', { subtitle: 'Loading…' });
  (async () => {
    const [tl, tasks, templates, staff] = await Promise.all([get(`/v1/clients/${clientId}/timeline?limit=200`), get(`/v1/tasks?client_id=${clientId}&status=all`), get('/v1/message-templates'), isOwner() ? get('/v1/staff').catch(() => null) : null]);
    const again = () => { const next = contactHistoryPanel(clientId, client); box.replaceWith(next); };
    const works = !isCoach();
    const emailable = tl.recipients.filter((r) => !r.email_block && r.email), textable = tl.recipients.filter((r) => !r.text_block);
    const vars = { parent: tl.recipients[0]?.name, athlete: client.name };
    const actions = h('div', { class: 'row wrap', style: 'gap:8px' },
      btn('Log a call', () => logDialog({ path: `/v1/clients/${clientId}/activity`, call: true, name: tl.recipients[0]?.name ?? client.name, done: again }), 'secondary'),
      btn('Add a note', () => logDialog({ path: `/v1/clients/${clientId}/activity`, call: false, name: client.name, done: again }), 'secondary'),
      works ? btn('Email', () => emailDialog({ path: `/v1/clients/${clientId}/email`, to: emailable[0]?.email, recipients: emailable, templates: templates.data.filter((t) => t.channel === 'email'), vars, done: again }), 'secondary', { disabled: !emailable.length }) : null,
      works ? btn('Text', () => textDialog({ path: `/v1/clients/${clientId}/text`, to: textable.map((r) => r.name).join(', '), templates: templates.data.filter((t) => t.channel === 'text'), vars, done: again }), 'secondary', { disabled: !textable.length }) : null,
      works && !tl.leads.some((x) => OPEN.includes(x.status)) && !client.archived_at ? btn('Put back in pipeline', () => {
        const note = textarea('', { maxlength: '2000', placeholder: 'Why now: trial ended, asked about camp…' });
        dialog(`Put the ${client.family?.name ?? client.name} back in the pipeline`, h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, 'Makes a lead for this family (Contacted) so you can work them like any lead. It moves along only on what they do from now on.'), field('Note', note)),
          [{ label: 'Make lead', variant: 'primary', onClick: async () => { const l = await post(`/v1/clients/${clientId}/lead`, { note: note.value || undefined }); toast('Lead made.'); location.hash = `#/leads/${l.id}`; } }, { label: 'Cancel', variant: 'ghost' }]);
      }, 'ghost') : null);
    const why = works ? [emailable.length ? null : (tl.recipients[0]?.email_block ?? 'No email on file.'), textable.length ? null : (tl.recipients[0]?.text_block ?? null)].filter(Boolean) : [];
    const leadLine = tl.leads.length ? h('p', { class: 'small', style: 'margin:0' }, 'In the pipeline: ', ...tl.leads.map((x, i) => [i ? ', ' : '', h('a', { href: `#/leads/${x.id}` }, `${x.parent_name} (${x.stage_label})`)])) : null;
    const list = h('ol', { class: 'crm-tl' });
    let shown = 6;
    const draw = () => fill(list, tl.data.slice(0, shown).map(timelineItem), tl.data.length > shown ? h('li', null, btn(`Show all ${tl.data.length}`, () => { shown = tl.data.length; draw(); }, 'ghost')) : null);
    draw();
    const openTasks = tasks.data.filter((t) => !t.done);
    const fresh = panel('Contact history', { subtitle: 'Notes, calls, emails and texts with the family, their bookings and memberships.' }, actions,
      why.length ? h('p', { class: 'small muted', style: 'margin:0' }, why.join(' ')) : null, leadLine,
      tl.data.length ? list : h('p', { class: 'small muted', style: 'margin:0' }, 'Nothing logged yet.'),
      tasksBlock({ tasks: tasks.data, clientId, staff, done: again, title: `Tasks${openTasks.length ? ` (${openTasks.length})` : ''}`, flat: true }));
    fresh.id = box.id;
    box.replaceWith(fresh);
  })().catch((e) => fill(box, h('p', { class: 'small warn-text' }, e.message)));
  return box;
}

// ---------- Reports (owner) ----------
export async function viewLeadReports(main) {
  const q = query();
  const to = q.get('to') ?? localToday(), from = q.get('from') ?? new Date(Date.now() - 89 * 86400000).toLocaleDateString('en-CA');
  const r = await get(`/v1/leads/report?from=${from}&to=${to}`);
  const fromI = input({ type: 'date', value: r.from, 'aria-label': 'From' }), toI = input({ type: 'date', value: r.to, 'aria-label': 'To' });
  const go = (f, t) => { location.hash = `#/leads/reports?from=${f}&to=${t}`; };
  const preset = (days, label) => btn(label, () => go(new Date(Date.now() - (days - 1) * 86400000).toLocaleDateString('en-CA'), localToday()), 'ghost');
  const bar = (n, max) => h('div', { class: 'crm-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${max ? Math.max(2, Math.round((n / max) * 100)) : 0}%` }));
  const maxSrc = Math.max(0, ...r.by_source.map((s) => s.leads)), maxLost = Math.max(0, ...r.lost_reasons.map((s) => s.count)), maxStage = Math.max(0, ...r.stage_counts.map((s) => s.count));
  fill(main, header('Lead reports', `Leads that came in ${shortDay(r.from)} to ${shortDay(r.to)}.`),
    leadNav('reports'),
    h('form', { class: 'row wrap', style: 'gap:8px', onSubmit: (e) => { e.preventDefault(); go(fromI.value, toI.value); } }, field('From', fromI), field('To', toI), h('div', { style: 'align-self:flex-end' }, btn('Show', null, 'secondary', { type: 'submit' })),
      h('div', { class: 'row wrap', style: 'align-self:flex-end;gap:4px' }, preset(30, 'Last 30 days'), preset(90, '90 days'), preset(365, 'A year'))),
    h('div', { class: 'pulse' },
      pulseTile('Leads', r.leads, `${r.signed_up} signed up (${r.signed_up_pct}%)`),
      pulseTile('Became members', r.members, `${r.conversion_pct}% of leads`, { tone: r.members ? 'good' : null }),
      pulseTile('Days to member', r.days_to_member.median ?? '–', r.days_to_member.count ? `Median · average ${r.days_to_member.average}` : 'Nobody joined yet'),
      pulseTile('Open now', r.open_now.total, r.open_now.stale ? `${r.open_now.stale} stale` : 'None stale', { tone: r.open_now.stale ? 'warn' : null, href: '#/leads?view=board' })),
    h('div', { class: 'grid grid-2' },
      panel('By source', { subtitle: 'Where leads came from and how many joined.' }, r.by_source.length ? r.by_source.map((s) => h('div', { class: 'crm-report-row' },
        h('div', { class: 'row wrap', style: 'gap:8px' }, h('span', { class: 'grow' }, s.label), h('span', { class: 'small muted' }, `${s.leads} · ${s.members} joined (${s.conversion_pct}%)`)), bar(s.leads, maxSrc))) : h('p', { class: 'muted', style: 'margin:0' }, 'No leads in this period.')),
      panel('Where they are now', { subtitle: 'The stage each lead from this period is in.' }, r.stage_counts.map((s) => h('div', { class: 'crm-report-row' },
        h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'grow' }, s.label), h('span', { class: 'small muted' }, String(s.count))), bar(s.count, maxStage)))),
      panel('Why leads were lost', { subtitle: 'The reason picked when a lead moved to Lost.' }, r.lost_reasons.length ? r.lost_reasons.map((s) => h('div', { class: 'crm-report-row' },
        h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'grow' }, s.label), h('span', { class: 'small muted' }, String(s.count))), bar(s.count, maxLost))) : h('p', { class: 'muted', style: 'margin:0' }, 'No lost leads in this period.')),
      panel('Open leads by stage', { subtitle: 'Every open lead today, whenever it came in.' }, r.open_now.by_stage.map((s) => h('div', { class: 'row', style: 'gap:8px' }, h('a', { class: 'grow', href: `#/leads?status=${s.stage}` }, s.label), h('span', { class: 'small muted' }, String(s.count)))))));
}

// ---------- Import and export (owner) ----------
export async function viewLeadImport(main) {
  const fileIn = h('input', { type: 'file', accept: '.csv,.xlsx,text/csv', class: 'dp-input', 'aria-label': 'Lead file' });
  const out = h('div', { class: 'stack' });
  let body = null;
  const read = async () => {
    const f = fileIn.files[0];
    if (!f) throw new Error('Choose a CSV or Excel file first.');
    if (f.size > 10e6) throw new Error('The file is over 10 MB. Split it up.');
    if (/\.xlsx$/i.test(f.name)) { const buf = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return { xlsx_base64: btoa(s) }; }
    return { csv: await f.text() };
  };
  const problems = (list, title, warn = false) => (list.length ? panel(`${title} (${list.length})`, {},
    h('div', { class: 'stack-tight' }, list.slice(0, 200).map((p) => h('div', { class: 'list-item small', style: 'align-items:flex-start' }, h('span', { class: 'muted', style: 'min-width:120px' }, p.row ? `Row ${p.row}${p.column ? ` · ${p.column}` : ''}` : p.column ?? 'File'), h('span', { class: warn ? 'warn-text grow' : 'grow' }, p.message))))) : null);
  const showPreview = (p, err) => {
    const confirmBox = h('input', { type: 'checkbox' });
    fill(out, err ? h('p', { class: 'warn-text', style: 'margin:0' }, err) : null,
      problems(p.errors ?? [], 'Fix these first'),
      problems(p.warnings ?? [], 'Might be someone you have', true),
      !p.errors?.length && p.rows ? panel(`Ready: ${plural(p.rows, 'lead')}`, { subtitle: `${p.by_stage?.new ?? 0} New, ${p.by_stage?.contacted ?? 0} Contacted. Imported leads get no automatic emails or texts.` },
        h('div', { class: 'stack-tight' }, (p.sample ?? []).map((s) => h('div', { class: 'small' }, `Row ${s.row}: ${s.parent_name}${s.athlete_name ? ` for ${s.athlete_name}` : ''} · ${[s.email, phoneText(s.phone)].filter(Boolean).join(' · ')} · ${s.source} · ${s.stage}`))),
        p.warnings?.length ? h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, confirmBox, h('span', null, 'I checked the rows above: import them anyway')) : null,
        h('div', null, btn(`Import ${plural(p.rows, 'lead')}`, (e) => busy(e.currentTarget, async () => {
          try { const r = await post('/v1/leads/import', { ...body, confirm: confirmBox.checked }); toast(`${plural(r.saved, 'lead')} imported.`); location.hash = '#/leads'; }
          catch (x) { if (x.details) showPreview(x.details, x.message); else throw x; }
        }), 'primary'))) : null);
  };
  fill(main, header('Import & export', 'Bring leads in from a spreadsheet, or take them all out.'),
    leadNav('import'),
    panel('Import leads', { subtitle: 'All or nothing: the whole file is checked and every problem listed by row and column. Nothing is saved until it\'s clean. Columns: Parent name, Email, Phone, Athlete name, Athlete age, Sport, How they found you, Stage (New or Contacted), Notes.' },
      h('div', { class: 'row wrap', style: 'gap:8px' }, fileIn, btn('Check file', (e) => busy(e.currentTarget, async () => {
        body = await read();
        try { showPreview(await post('/v1/leads/import', { ...body, dry_run: true })); } catch (x) { if (x.details) showPreview(x.details, x.message); else throw x; }
      }), 'secondary'), btn('Download a template', (e) => busy(e.currentTarget, () => download('/v1/leads/import/template')), 'ghost')), out),
    panel('Export', { subtitle: 'Every lead as a CSV: stage, days in stage, source, coach and notes. Cells that look like formulas are made safe for spreadsheets.' },
      h('div', null, btn('Download leads CSV', (e) => busy(e.currentTarget, () => download('/v1/leads/export')), 'secondary'))));
}

// ---------- Lead settings ----------
// The website form and Book now links, automatic follow-up, message templates (the owner edits them) and Google review
// requests. Front desk sees them; only the owner changes them.
export async function viewLeadSettings(main) {
  const [settings, reviews, templates] = await Promise.all([get('/v1/settings'), get('/v1/review-requests'), get('/v1/message-templates')]);
  const owner = isOwner();
  const copy = (text, msg) => async () => { await navigator.clipboard?.writeText(text).catch(() => {}); toast(msg); };
  const followToggle = h('input', { type: 'checkbox', checked: settings.lead_follow_up !== 'off' });
  const howPanel = panel('Website form and follow-up', { subtitle: 'Families fill in the "Ask about training" form; each becomes a lead. Every lead with an email gets a thank-you with your sign-up link right away, a nudge after 2 days and a last note after 7. It stops as soon as they sign up, you mark them, they ask to stop emails or reply STOP to a text.' },
    h('div', { class: 'row wrap', style: 'gap:12px' }, h('code', { style: 'font-size:15px;overflow-wrap:anywhere' }, `${location.origin}/start`),
      btn('Copy inquiry form link', copy(`${location.origin}/start`, 'Link copied. Put it on your website and Instagram.'), 'secondary')),
    owner ? h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, followToggle, h('span', null, 'Send automatic follow-up'), btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { lead_follow_up: followToggle.checked ? 'on' : 'off' }); toast('Saved.'); }), 'ghost')) : null);
  const embedCode = `<script src="${location.origin}/embed.js" async></script>`;
  const schedToggle = h('input', { type: 'checkbox', checked: settings.public_schedule !== 'off' });
  const bookPanel = panel('Book now page', { subtitle: 'Your upcoming classes with open spots and the next evaluation times, for your website, Instagram bio and Google profile. Families sign in (or sign up) to book. No names are shown.' },
    h('div', { class: 'row wrap', style: 'gap:12px' }, h('code', { style: 'font-size:15px' }, `${location.origin}/book`),
      btn('Copy link', copy(`${location.origin}/book`, 'Link copied. Put it in your Instagram bio and on Google.'), 'secondary'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: '/book', target: '_blank', rel: 'noopener' }, 'Open it')),
    h('div', { class: 'dp-label', style: 'margin-top:8px' }, 'Show the schedule on your website'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Paste this where the schedule should appear (in Squarespace or Wix, use a Code or Embed block). For a single "Book now" button instead, add data-button="Book now" inside the tag.'),
    h('div', { class: 'row wrap', style: 'gap:12px' }, h('code', { class: 'small', style: 'word-break:break-all' }, embedCode), btn('Copy code', copy(embedCode, 'Code copied. Paste it into your website.'), 'secondary')),
    owner ? h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, schedToggle, h('span', null, 'Show the Book now page'), btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { public_schedule: schedToggle.checked ? 'on' : 'off' }); toast('Saved.'); }), 'ghost')) : null);
  // Templates
  const tplRow = (t) => {
    const wrap = h('div', { class: 'list-item', style: 'align-items:flex-start;flex-wrap:wrap' });
    const view = () => fill(wrap, h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('span', { class: 'strong' }, `${t.name}`, h('span', { class: 'small muted' }, ` · ${t.channel === 'email' ? 'Email' : 'Text'}`)),
      t.subject ? h('span', { class: 'small' }, t.subject) : null, h('span', { class: 'small muted', style: 'white-space:pre-wrap' }, t.body)),
      owner ? h('div', { class: 'row', style: 'gap:4px' }, btn('Edit', edit, 'ghost', { 'aria-label': `Edit ${t.name}` }), btn('Delete', (e) => { if (confirm(`Delete the template "${t.name}"?`)) busy(e.currentTarget, async () => { await del(`/v1/message-templates/${t.id}`); toast('Template deleted.'); viewLeadSettings(main); }); }, 'ghost', { 'aria-label': `Delete ${t.name}` })) : null);
    const edit = () => {
      const name = input({ value: t.name, maxlength: '80' }), subject = input({ value: t.subject ?? '', maxlength: '150' }), body = textarea(t.body, { maxlength: t.channel === 'text' ? '480' : '10000' });
      fill(wrap, h('div', { class: 'grow stack', style: 'min-width:200px' }, field('Name', name), t.channel === 'email' ? field('Subject', subject) : null, field('Message', body),
        h('div', { class: 'row' }, btn('Save template', (e) => busy(e.currentTarget, async () => { await patch(`/v1/message-templates/${t.id}`, { name: name.value, subject: t.channel === 'email' ? subject.value : undefined, body: body.value }); toast('Saved.'); viewLeadSettings(main); }), 'secondary'), btn('Cancel', view, 'ghost'))));
      name.focus();
    };
    view();
    return wrap;
  };
  const newCh = select([['email', 'Email'], ['text', 'Text']], { 'aria-label': 'Kind' }), newName = input({ maxlength: '80', placeholder: 'Name' }), newSubject = input({ maxlength: '150', placeholder: 'Subject (emails)' }), newBody = textarea('', { placeholder: 'Hi {first_name}, …' });
  const tplPanel = panel('Message templates', { subtitle: `For one-to-one emails and texts from a lead's page and a client's contact history. Placeholders: ${Object.entries(templates.placeholders).map(([k, v]) => `${k} (${v.toLowerCase()})`).join(', ')}.` },
    templates.data.map(tplRow),
    owner ? h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Add a template'),
      h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { await post('/v1/message-templates', { channel: newCh.value, name: newName.value, subject: newCh.value === 'email' ? newSubject.value : undefined, body: newBody.value }); toast('Template added.'); viewLeadSettings(main); }); } },
        h('div', { class: 'form-grid' }, field('Kind', newCh), field('Name', newName)), field('Subject', newSubject), field('Message', newBody), h('div', null, btn('Add template', null, 'secondary', { type: 'submit' })))) : null);
  // Google review requests (moved from the leads page).
  const reviewUrl = input({ type: 'url', placeholder: 'https://g.page/r/.../review', value: reviews.review_url, 'aria-label': 'Google review link' });
  const reviewOn = h('input', { type: 'checkbox', checked: reviews.on });
  const r90 = reviews.last_90_days;
  const REVIEW_WHY = { milestone: (x) => `${x.detail}`, pr: (x) => `personal best${x.detail ? ` (${x.detail})` : ''}` };
  const reviewPanel = panel('Google review requests', { subtitle: 'After an athlete\'s 10th session, or a personal best on a testing day the family can see, we email the parent once asking for a Google review. At most once every 6 months per family, never to a family behind on a payment, and only between 10 am and 7 pm.' },
    !reviews.review_url ? h('p', { class: 'warn-text', style: 'margin:0' }, 'Off until you add your Google review link. Find it in your Google Business Profile under "Ask for reviews".') :
      h('p', { style: 'margin:0' }, `Last 90 days: ${r90.sent} asked, ${r90.clicked} opened the review page${r90.stopped ? `, ${r90.stopped} asked us to stop` : ''}.`),
    owner ? h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      try { await patch('/v1/settings', { review_url: reviewUrl.value, review_requests: reviewOn.checked ? 'on' : 'off' }); toast('Saved.'); viewLeadSettings(main); } catch (err) { toast(err.message, 'warn'); }
    }); } },
      field('Google review link', reviewUrl),
      h('div', { class: 'row wrap', style: 'gap:12px' }, h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, reviewOn, h('span', null, 'Send review requests')), btn('Save', null, 'secondary', { type: 'submit' }))) : null,
    reviews.recent.length ? h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'Recent'), ...reviews.recent.map((x) => h('div', { class: 'row small wrap', style: 'gap:10px' },
      h('span', { class: 'grow' }, `${x.family_name ?? 'Deleted family'} · ${x.athlete_name ?? ''}: ${REVIEW_WHY[x.reason](x)}`), h('span', { class: 'muted' }, ago(x.sent_at)),
      x.opted_out_at ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Stop asking') : x.clicked_at ? h('span', { class: 'dp-badge dp-badge--good' }, 'Opened') : h('span', { class: 'dp-badge dp-badge--neutral' }, 'Sent')))) : null,
    h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px' }, 'See the email'),
      h('p', { class: 'strong small', style: 'margin:8px 0 4px' }, reviews.sample.subject), h('p', { class: 'small muted', style: 'white-space:pre-wrap;margin:0' }, reviews.sample.text)));
  fill(main, header('Lead settings', owner ? 'Your inquiry form, follow-up, templates and review requests.' : 'Your inquiry form, templates and review requests. The owner changes these.'), leadNav('settings'), howPanel, tplPanel, bookPanel, reviewPanel);
}
export { leadNav };
