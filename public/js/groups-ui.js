import { h, fill, btn, busy, toast, field, input, select, panel, ago } from './ui.js';
import { fmtResult } from './charts.js';

// Groups (version 87; owner's ask): a named group of athletes under Teams ("Kings 2031"). The coach renames it, puts
// athletes in, and reads the board. Each athlete sees how many times they attended, their best sprint times and the
// board, where they message the coach and everyone in the group reads it.
// Three screens share this file: the Teams page's Groups panel and the group page (the dashboard), and the athlete
// app's Team tab (also inside the family portal's frame).

const when = (iso) => {
  const d = new Date(iso), now = new Date();
  const hrs = (now - d) / 36e5;
  if (hrs < 1) return 'just now';
  if (hrs < 24) return `${Math.round(hrs)} h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const best = (b) => `${fmtResult(b.value, b.unit, b.decimals)}`;

// A small form dialog (the dashboard's #dialog element): fields, Save, Cancel; onSave returns the toast text.
function formDialog(title, fields, saveLabel, onSave, { note = null, danger = null } = {}) {
  const d = document.getElementById('dialog');
  const err = h('div', { class: 'dp-error', role: 'alert' });
  fill(d, h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try { const msg = await onSave(); d.close(); if (msg) toast(msg); } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel);margin:0' }, title), note ? h('p', { class: 'small muted', style: 'margin:0' }, note) : null,
    ...fields, err,
    h('div', { class: 'row wrap' }, btn(saveLabel, null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'), danger ? h('span', { class: 'grow' }) : null, danger)));
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
  setTimeout(() => d.querySelector('input,select,textarea')?.focus(), 0);
}
// The group's details form: name, note, coach. coaches = GET /v1/coaches.
function groupFields(g, coaches) {
  const name = input({ value: g?.name ?? '', maxlength: '60', placeholder: 'Kings 2031', required: true });
  const note = h('textarea', { class: 'dp-input', maxlength: '500', rows: '2', placeholder: 'Club team, class of 2031 (optional)' }, g?.note ?? '');
  const coach = select([['', 'No coach yet'], ...coaches.map((c) => [c.id, c.name])], { value: g?.coach_id ?? '' });
  return { fields: [field('Name', name, 'The athletes see this name on their Team tab.'), field('Note', note), field('Coach', coach, 'Emailed when an athlete writes on the board.')], read: () => ({ name: name.value.trim(), note: note.value.trim() || null, coach_id: coach.value || null }) };
}

// ---------- The Teams page: the Groups panel ----------
export function groupsPanel({ api, canEdit }) {
  const list = h('div', { 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Loading…'));
  const draw = async () => {
    let groups;
    try { groups = (await api('GET', '/v1/groups')).data; } catch (e) { return fill(list, h('p', { class: 'warn-text' }, e.message)); }
    fill(list, groups.length ? groups.map((g) => h('a', { class: 'list-item', href: `#/teams/groups/${g.id}`, style: 'text-decoration:none;color:inherit;flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', { class: 'strong' }, g.name),
        h('span', { class: 'small muted' }, [plural(g.members, 'athlete'), g.coach_name ? `coach ${g.coach_name}` : 'no coach yet', g.last_message_at ? `last message ${when(g.last_message_at)}` : 'nothing on the board yet'].join(' · '))),
      g.unanswered ? h('span', { class: 'dp-badge dp-badge--warn' }, `${plural(g.unanswered, 'message')} waiting for an answer`) : null))
      : h('p', { class: 'muted' }, canEdit ? 'No groups yet. A group is a set of athletes with a shared board, like "Kings 2031": rename it any time, put athletes in, and they see their attendance, their sprint bests and the board on their Team tab.' : 'No groups yet.'));
  };
  const add = canEdit ? btn('New group', async () => {
    const coaches = (await api('GET', '/v1/coaches')).data;
    const f = groupFields(null, coaches);
    formDialog('New group', f.fields, 'Make the group', async () => {
      const g = await api('POST', '/v1/groups', f.read());
      location.hash = `#/teams/groups/${g.id}`;
      return `${g.name} made. Add athletes to it.`;
    });
  }, 'primary') : null;
  draw();
  return panel('Groups', { subtitle: 'Athletes grouped by team or class year, each with a shared board. Not billed: team contracts are below.', action: add }, list);
}

// ---------- The group page (#/teams/groups/<id>) ----------
export async function viewGroup(main, id, { api, header, role }) {
  const canEdit = role === 'owner' || role === 'coach';
  let g;
  try { g = await api('GET', `/v1/groups/${id}`); } catch (e) {
    if (!/not found/i.test(e.message)) throw e;
    return fill(main, header('Group not found', 'It may have been removed.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/teams' }, 'All teams')), h('div', { class: 'empty' }, 'That group wasn\'t found. Open it from the Teams page.'));
  }
  const coaches = canEdit ? (await api('GET', '/v1/coaches')).data : [];
  const reload = () => viewGroup(main, id, { api, header, role });

  // Athletes: attendance and the best on each sprint test (a column per test that has one).
  const removeBtn = (m) => btn('Remove', (e) => { if (!confirm(`Take ${m.name} out of ${g.name}? Their profile and results are untouched.`)) return; busy(e.currentTarget, async () => { await api('DELETE', `/v1/groups/${id}/members/${m.client_id}`); toast(`${m.name} taken out.`); reload(); }); }, 'ghost', { 'aria-label': `Remove ${m.name}` });
  const table = g.members.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', null, 'Athlete'), h('th', null, 'Attended'), ...g.tests.map((t) => h('th', { title: t.better === 'lower' ? 'Best (lowest) time' : 'Best' }, t.name)), canEdit ? h('th', null, '') : null)),
    h('tbody', null, g.members.map((m) => h('tr', null,
      h('td', null, h('a', { href: `#/clients/${m.client_id}`, class: 'strong', style: 'color:var(--steel)' }, m.name), m.archived ? h('span', { class: 'small muted' }, ' · archived') : null, h('div', { class: 'small muted' }, [m.athlete_id, m.grad_year ? `Class of ${m.grad_year}` : null, m.sport].filter(Boolean).join(' · '))),
      h('td', { class: 'strong' }, String(m.attended)),
      ...g.tests.map((t) => { const b = m.bests.find((x) => x.test_id === t.test_id); return h('td', { class: b ? '' : 'muted' }, b ? best(b) : '—'); }),
      canEdit ? h('td', { style: 'text-align:right' }, removeBtn(m)) : null)))))
    : h('p', { class: 'muted' }, canEdit ? 'No athletes yet. Add them below; each one then sees this group on their Team tab.' : 'No athletes yet.');

  // Add athletes: a search over every client, tick several, add at once (all or nothing on the server).
  const addAthletes = () => {
    const q = input({ type: 'search', placeholder: 'Name, Athlete ID or school', 'aria-label': 'Find athletes', autocomplete: 'off' });
    const out = h('div', { class: 'stack-tight' }), picked = new Map();
    const count = h('span', { class: 'small muted' });
    let everyone = null, timer;
    const inGroup = new Set(g.members.map((m) => m.client_id));
    const draw = () => {
      const val = q.value.trim().toLowerCase();
      const rows = (everyone ?? []).filter((c) => !inGroup.has(c.id) && (!val || `${c.name} ${c.athlete_id ?? ''} ${c.school ?? ''} ${c.grad_year ?? ''}`.toLowerCase().includes(val))).slice(0, 12);
      fill(out, rows.length ? rows.map((c) => h('label', { class: 'list-item', style: 'min-height:48px;cursor:pointer' },
        h('input', { type: 'checkbox', checked: picked.has(c.id), onChange: (e) => { if (e.target.checked) picked.set(c.id, c); else picked.delete(c.id); count.textContent = picked.size ? `${plural(picked.size, 'athlete')} picked` : ''; } }),
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, c.name), h('span', { class: 'small muted' }, [c.athlete_id, c.school, c.grad_year ? `Class of ${c.grad_year}` : null].filter(Boolean).join(' · ')))))
        : h('p', { class: 'small muted', style: 'margin:0' }, everyone ? 'No athletes match.' : 'Loading…'));
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(draw, 150); });
    api('GET', '/v1/clients').then((r) => { everyone = r.data; draw(); }).catch((e) => fill(out, h('p', { class: 'dp-error' }, e.message)));
    draw();
    formDialog(`Add athletes to ${g.name}`, [field('Find', q), out, count], 'Add the picked athletes', async () => {
      if (!picked.size) throw new Error('Tick at least one athlete.');
      const r = await api('POST', `/v1/groups/${id}/members`, { client_ids: [...picked.keys()] });
      reload();
      return `${plural(r.added.length, 'athlete')} added${r.skipped.length ? `; ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}` : ''}.`;
    }, { note: 'Each athlete sees the group on their Team tab: their attendance, their sprint bests and the board.' });
  };

  // The board.
  const board = h('div', { class: 'stack-tight' });
  let next = g.board.next;
  const messages = [...g.board.data];
  const msgRow = (m) => h('div', { class: `fd-comment${m.hidden ? ' fd-comment--hidden' : ''}` },
    h('div', { class: 'grow', style: 'min-width:0' }, h('span', { class: `strong small${m.author_kind === 'staff' ? ' good-text' : ''}` }, m.author_name), h('span', { class: 'small muted' }, ` · ${when(m.created_at)}${m.hidden ? ` · hidden by ${m.hidden_by}` : ''}`),
      h('div', { class: 'small', style: 'white-space:pre-line' }, m.body)),
    canEdit && m.author_kind !== 'staff' ? btn(m.hidden ? 'Show' : 'Hide', (e) => busy(e.currentTarget, async () => { const r = m.hidden ? await api('POST', `/v1/group-messages/${m.id}/unhide`) : await api('DELETE', `/v1/group-messages/${m.id}`); Object.assign(m, r); drawBoard(); }), 'ghost', { style: 'min-height:32px;padding:0 8px' }) : null);
  const more = btn('Older messages', (e) => busy(e.currentTarget, async () => { const r = await api('GET', `/v1/groups/${id}/messages?before=${encodeURIComponent(next)}`); messages.push(...r.data); next = r.next; drawBoard(); }), 'ghost');
  const drawBoard = () => fill(board, messages.length ? messages.map(msgRow) : h('p', { class: 'muted', style: 'margin:0' }, 'Nothing on the board yet. Athletes write here from their Team tab; what you write reaches every phone in the group.'), next ? h('div', { class: 'row', style: 'justify-content:center' }, more) : null);
  drawBoard();
  const box = h('textarea', { class: 'dp-input', rows: '2', maxlength: '1000', placeholder: `Write to everyone in ${g.name}`, 'aria-label': 'Your message' });
  const send = btn('Send', (e) => { const body = box.value.trim(); if (!body) return; busy(e.currentTarget, async () => { const m = await api('POST', `/v1/groups/${id}/messages`, { body }); box.value = ''; messages.unshift(m); drawBoard(); toast('Sent. Every athlete in the group gets a tap on their phone.'); }); }, 'secondary');

  const rename = canEdit ? btn('Rename or change', () => {
    const f = groupFields(g, coaches);
    formDialog(`Change ${g.name}`, f.fields, 'Save', async () => { await api('PATCH', `/v1/groups/${id}`, f.read()); reload(); return 'Saved.'; },
      { danger: btn('Delete group', async (e) => {
        e.preventDefault();
        if (!confirm(`Delete ${g.name}? The athletes' profiles, attendance and results are untouched; only the group and its board go.`)) return;
        try { await api('DELETE', `/v1/groups/${id}`, { confirm: true }); document.getElementById('dialog').close(); toast(`${g.name} deleted.`); location.hash = '#/teams'; } catch (x) { toast(x.message, 'warn'); }
      }, 'ghost', { style: 'color:var(--amber)' }) });
  }, 'secondary') : null;

  fill(main,
    header(g.name, [plural(g.members.filter((m) => !m.archived).length, 'athlete'), g.coach_name ? `coach ${g.coach_name}` : 'no coach yet', g.note].filter(Boolean).join(' · '),
      h('div', { class: 'row wrap' }, rename, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/teams' }, 'All teams'))),
    panel('Athletes', { subtitle: 'How many times each has attended (classes, team sessions and check-ins) and their best on each sprint test. Each athlete sees only their own numbers.', action: canEdit ? btn('Add athletes', addAthletes, 'primary') : null }, table),
    panel('Board', { subtitle: 'Everyone in the group reads every message. Athletes and parents write from the Team tab; you answer here.' },
      canEdit ? h('div', { class: 'row', style: 'align-items:flex-start' }, box, send) : null, board));
}

// ---------- The athlete app's Team tab ----------
export function athleteGroups(where, { api }) {
  const draw = async () => {
    fill(where, h('p', { class: 'muted' }, 'Loading…'));
    let d;
    try { d = await api('GET', '/app/api/groups'); } catch (e) { fill(where, h('div', { class: 'empty' }, e.message)); return; }
    if (!d.data.length) return fill(where, h('div', { class: 'sp-card stack' }, h('h2', { class: 'dp-panel-title' }, 'Your team'), h('p', { class: 'muted', style: 'margin:0' }, 'You\'re not in a group yet. Your coach adds you, and then your attendance, your sprint bests and the team board show here.')));
    const you = h('div', { class: 'sp-card stack' }, h('h2', { class: 'dp-panel-title' }, 'Your numbers'),
      h('div', { class: 'eg-streaks' },
        h('div', { class: 'eg-streak' }, h('b', { class: d.you.attended ? 'good-text' : '' }, String(d.you.attended)), h('span', { class: 'strong' }, `${d.you.attended === 1 ? 'Time' : 'Times'} attended`), h('span', { class: 'small muted' }, 'Classes, team sessions and check-ins')),
        ...d.you.bests.map((b) => h('div', { class: 'eg-streak' }, h('b', { class: 'good-text' }, best(b)), h('span', { class: 'strong' }, b.name), h('span', { class: 'small muted' }, `Your best · ${when(b.recorded_at)}`)))),
      d.you.bests.length ? null : h('p', { class: 'small muted', style: 'margin:0' }, 'Your best sprint times show here once a testing day is shared.'));
    fill(where, h('div', { class: 'stack' }, you, ...d.data.map((g) => groupCard(g, api, draw))));
  };
  draw();
}
function groupCard(g, api, redraw) {
  const list = h('div', { class: 'stack-tight' });
  let next = g.board.next;
  const messages = [...g.board.data];
  const row = (m) => h('div', { class: 'fd-comment' },
    h('div', { class: 'grow', style: 'min-width:0' }, h('span', { class: `strong small${m.author_kind === 'staff' ? ' good-text' : ''}` }, m.author_name, m.author_kind === 'staff' ? ' (coach)' : ''), h('span', { class: 'small muted' }, ` · ${when(m.created_at)}`),
      h('div', { class: 'small', style: 'white-space:pre-line' }, m.body)),
    m.mine ? btn('Take back', (e) => busy(e.currentTarget, async () => { await api('DELETE', `/app/api/group-messages/${m.id}`); messages.splice(messages.indexOf(m), 1); drawList(); }), 'ghost', { style: 'min-height:32px;padding:0 8px' }) : null);
  const more = btn('Older messages', (e) => busy(e.currentTarget, async () => { const r = await api('GET', `/app/api/groups/${g.id}/messages?before=${encodeURIComponent(next)}`); messages.push(...r.data); next = r.next; drawList(); }), 'ghost');
  const drawList = () => fill(list, messages.length ? messages.map(row) : h('p', { class: 'small muted', style: 'margin:0' }, 'Nothing here yet. Ask your coach something: everyone in the group sees it and the answer.'), next ? h('div', { class: 'row', style: 'justify-content:center' }, more) : null);
  drawList();
  const box = h('textarea', { class: 'dp-input', rows: '2', maxlength: '1000', placeholder: `Message ${g.coach_name ? g.coach_name.split(' ')[0] : 'your coach'} and the group`, 'aria-label': 'Your message' });
  const send = btn('Send', (e) => { const body = box.value.trim(); if (!body) return; busy(e.currentTarget, async () => { try { const m = await api('POST', `/app/api/groups/${g.id}/messages`, { body }); box.value = ''; messages.unshift(m); drawList(); } catch (x) { toast(x.message, 'warn'); } }); }, 'secondary');
  return h('div', { class: 'sp-card stack' },
    h('div', { class: 'stack-tight' }, h('h2', { class: 'dp-panel-title' }, g.name), h('p', { class: 'small muted', style: 'margin:0' }, [g.coach_name ? `Coach ${g.coach_name}` : null, plural(g.members, 'athlete'), g.note].filter(Boolean).join(' · '))),
    g.teammates.length ? h('p', { class: 'small', style: 'margin:0' }, h('span', { class: 'muted' }, 'With you: '), g.teammates.join(', ')) : null,
    h('div', { class: 'stack-tight' }, h('h3', { class: 'small strong', style: 'margin:0' }, 'Team board'), h('p', { class: 'small muted', style: 'margin:0' }, 'Everyone in the group reads what\'s written here, and the coach is told.'),
      h('div', { class: 'row', style: 'align-items:flex-start' }, box, send), list));
}
