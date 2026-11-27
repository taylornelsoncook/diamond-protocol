// Testing → Devices & imports → Import an OVR export (version 100): the whole OVR Connect workbook in one go. The
// preview lists every person in it: already linked, new (a profile is made), or a name like someone on file (the coach
// says who it is). Nothing is saved until Import is pressed, and then all of it or none of it.
import { h, fill, btn, busy, toast, panel, select } from './ui.js';

const toBase64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ovrImportPanel({ post, onDone, owner }) {
  const file = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'dp-input', 'aria-label': 'OVR export (.xlsx)' });
  const out = h('div', { class: 'stack' });
  const make = h('input', { type: 'checkbox', checked: true });
  const groupsOn = h('input', { type: 'checkbox', checked: true });
  let body = null, preview = null;
  const choices = new Map();

  const send = async (path) => post(path, { ...body, create_profiles: make.checked, add_to_groups: groupsOn.checked, people: Object.fromEntries(choices), leave_out_impossible: true });
  const check = (e) => busy(e.currentTarget, async () => {
    const f = file.files[0];
    if (!f) throw new Error('Choose the OVR export first.');
    if (!/\.xlsx$/i.test(f.name)) throw new Error('Choose the Excel file (.xlsx) OVR Connect exported.');
    body = { filename: f.name, xlsx_base64: toBase64(await f.arrayBuffer()) };
    choices.clear();
    preview = await send('/v1/imports/ovr/preview');
    draw();
  });

  const personRow = (p) => {
    const tag = p.status === 'linked' ? h('span', { class: 'dp-badge dp-badge--good' }, `→ ${p.client.name} · ${p.client.athlete_id}`)
      : p.status === 'new' ? h('span', { class: `dp-badge dp-badge--${make.checked ? 'neutral' : 'muted'}` }, make.checked ? `New profile${p.client?.athlete_id ? ` · ${p.client.athlete_id}` : ''}` : 'Waits to be linked')
      : null;
    const what = [plural(p.results, 'result'), p.sets ? plural(p.sets, 'bar-speed set') : null, p.groups?.length ? p.groups.join(', ') : null, p.sport].filter(Boolean).join(' · ');
    let pick = null;
    if (p.status === 'check') {
      const opts = [['', 'Who is this?'], ...p.look_alikes.map((a) => [a.client_id, `Same person: ${a.name} (${a.athlete_id})${a.archived ? ', archived' : ''} · ${a.why.toLowerCase()}`]), ['new', 'Someone new: make a profile'], ['wait', 'Not sure: leave the results waiting']];
      pick = select(opts, { 'aria-label': `Who ${p.name} is`, value: choices.get(p.key) ?? '' });
      pick.addEventListener('change', () => { if (pick.value) choices.set(p.key, pick.value); else choices.delete(p.key); syncButton(); });
    }
    return h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'muted' }, what)),
      tag, pick ? h('div', { style: 'min-width:260px;flex:1' }, pick) : null);
  };
  const go = btn('Import', null, 'primary');
  const syncButton = () => {
    const open = (preview?.people ?? []).filter((p) => p.status === 'check' && !choices.has(p.key)).length;
    go.disabled = open > 0 || (preview?.problem_count ?? 0) > 0;
    go.textContent = open ? `Say who ${open === 1 ? '1 person is' : `${open} people are`} first` : 'Import';
  };
  go.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      const r = await send('/v1/imports/ovr');
      const made = r.people.filter((p) => p.made);
      toast(`${plural(r.saved, 'result')} saved${r.bar_speed_sets ? `, ${plural(r.bar_speed_sets, 'bar-speed set')}` : ''}${made.length ? `, ${plural(made.length, 'new profile')}` : ''}.`);
      fill(out, panel('Imported', { subtitle: `${r.filename ?? 'OVR export'}: ${plural(r.saved, 'result')} saved, ${r.already_saved} already on file${r.waiting ? `, ${r.waiting} waiting to be linked` : ''}. Undo it under Recent uploads.` },
        r.groups?.length ? h('p', { class: 'small' }, `Groups: ${r.groups.map((g) => `${g.name} (${g.made ? 'new, ' : ''}${g.added} added)`).join(', ')}.`) : null,
        made.length ? h('p', { class: 'small' }, `${plural(made.length, 'new profile')}, each with only the name from OVR. Add a parent, contact details and the waiver: Clients → To finish.`) : null,
        h(made.length > 8 ? 'details' : 'div', { class: 'stack-tight' }, made.length > 8 ? h('summary', { class: 'small' }, `Show all ${made.length}`) : null, made.map((p) => h('a', { class: 'list-item small', href: `#/clients/${p.client.client_id}`, style: 'text-decoration:none;color:inherit' }, h('span', { class: 'grow' }, p.name), h('span', { class: 'muted' }, p.client.athlete_id)))),
        h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/clients?view=to_finish' }, 'Profiles to finish'), btn('Import another', () => { preview = null; body = null; file.value = ''; fill(out); }, 'ghost'))));
      onDone?.(r);
    } catch (err) {
      if (err.code === 'people_to_check') { toast(err.message, 'warn'); preview = await send('/v1/imports/ovr/preview'); draw(); return; }
      throw err;
    }
  }));

  function draw() {
    const p = preview;
    const groups = { check: p.people.filter((x) => x.status === 'check'), new: p.people.filter((x) => x.status === 'new'), linked: p.people.filter((x) => x.status === 'linked') };
    make.onchange = async () => { preview = await send('/v1/imports/ovr/preview'); draw(); };
    groupsOn.onchange = make.onchange;
    const gs = p.groups ?? [];
    const groupLine = (g) => h('span', { class: 'small' }, `${g.name}: ${g.made ? 'a new group, ' : ''}${plural(g.added, 'athlete')} added${g.skipped?.length ? ` (${g.skipped.map((x) => `${x.name}, ${x.reason}`).join('; ')} left out)` : ''}`);
    fill(out,
      h('p', { class: 'small' }, `${plural(p.counts.people, 'person', 'people')} in the file: ${groups.linked.length} already linked, ${groups.new.length} new, ${groups.check.length} to check. ${plural(p.will_save, 'result')} will be saved${p.already_saved ? `, ${p.already_saved} already on file` : ''}${p.bar_speed_sets ? `, ${plural(p.bar_speed_sets, 'bar-speed set')}` : ''}.`),
      p.problems.length ? h('div', { class: 'dp-panel stack-tight', style: 'border-left:3px solid var(--amber)' }, h('span', { class: 'strong warn-text' }, 'Fix these first'), p.problems.map((x) => h('span', { class: 'small' }, `${x.sheet ? `${x.sheet}, row ${x.row}: ` : ''}${x.message}`))) : null,
      groups.check.length ? h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, 'Names like someone already on file'), h('span', { class: 'small muted' }, 'Names are never matched on their own. Say who each one is; the answer is remembered for the next export.'), groups.check.map(personRow)) : null,
      groups.new.length ? h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, 'New people'),
        h('label', { class: 'row small', style: 'gap:8px;min-height:40px' }, make, h('span', null, 'Make a profile for each new person (name only: no parent, email or login until you finish it)')),
        groups.new.length > 8 ? h('details', null, h('summary', { class: 'small' }, `Show all ${groups.new.length}`), h('div', { class: 'stack-tight' }, groups.new.map(personRow))) : groups.new.map(personRow)) : null,
      groups.linked.length ? h('details', null, h('summary', { class: 'small' }, `Already linked (${groups.linked.length})`), h('div', { class: 'stack-tight' }, groups.linked.map(personRow))) : null,
      gs.length || !groupsOn.checked ? h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, 'Groups'),
        h('label', { class: 'row small', style: 'gap:8px;min-height:40px' }, groupsOn, h('span', null, 'Put each athlete in the app\'s group named in the file (made if it isn\'t there yet: Teams → Groups)')),
        groupsOn.checked ? gs.map(groupLine) : null) : null,
      p.impossible_count ? h('details', null, h('summary', { class: 'small warn-text' }, `${plural(p.impossible_count, 'value')} a device can't have recorded will be left out`),
        h('div', { class: 'stack-tight' }, p.impossible.map((x) => h('span', { class: 'small' }, `${x.sheet}, row ${x.row}: ${x.athlete}, ${x.message}`)))) : null,
      p.left_out.length ? h('p', { class: 'small muted' }, `Not brought in (no matching test yet): ${p.left_out.map((x) => `${x.what} (${x.rows} rows)`).join(', ')}.`) : null,
      p.bar_speed_left_out ? h('p', { class: 'small muted' }, p.bar_speed_left_out) : null,
      h('div', { class: 'row wrap' }, go, btn('Start over', () => { preview = null; body = null; file.value = ''; fill(out); }, 'ghost')));
    syncButton();
  }

  return panel('Import an OVR export', { subtitle: 'In OVR Connect, export your history as Excel and upload the whole file. Every sheet is read: jumps, sprints, force plate jumps' + (owner ? ' and bar speed.' : '. Bar speed is the owner\'s to import.') },
    h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: 'min-width:220px' }, file), btn('Check the file', check, 'secondary')), out);
}
