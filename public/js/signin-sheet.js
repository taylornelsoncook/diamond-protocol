// Printable sign-in sheet for one session (/signin-sheet.html#<session id>), opened from the roster. Staff only: it reads
// the session with the staff sign-in. Everyone booked (and a team session's roster), a box to tick, a line to sign, and
// what the coach should know (medical notes, no waiver). A few blank rows for walk-ins.
import { h, fill } from './ui.js';

const root = document.getElementById('root');
const id = decodeURIComponent(location.hash.slice(1));

async function load() {
  const [sRes, setRes] = await Promise.all([fetch(`/v1/sessions/${encodeURIComponent(id)}`, { credentials: 'same-origin' }), fetch('/v1/settings', { credentials: 'same-origin' })]);
  if (sRes.status === 401) return fill(root, h('p', null, 'Sign in to the dashboard first, then open the sign-in sheet again from the session.'));
  if (!sRes.ok) return fill(root, h('p', null, 'That session wasn\'t found. Open the sign-in sheet again from the session page.'));
  const s = await sRes.json(), settings = setRes.ok ? await setRes.json() : {};
  const zone = settings.timezone;
  const fmt = (iso, o) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...o }).format(new Date(iso));
  const when = `${fmt(s.starts_at, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · ${fmt(s.starts_at, { hour: 'numeric', minute: '2-digit' })}–${fmt(s.ends_at, { hour: 'numeric', minute: '2-digit' })}`;
  const people = s.roster.filter((r) => ['booked', 'attended', 'no_show'].includes(r.status)).map((r) => ({ client_id: r.client_id, name: r.name, id: r.athlete_id, age: r.age, phone: r.parent_phone, medical: r.medical_notes, noWaiver: r.no_waiver, here: r.status === 'attended' }));
  if (s.team) for (const a of s.team.athletes) if (!people.some((p) => p.client_id === a.client_id)) people.push({ name: a.name, id: a.athlete_id, team: true, here: a.present });
  people.sort((a, b) => a.name.localeCompare(b.name));
  const waiting = s.roster.filter((r) => r.status === 'waitlisted');
  document.title = `Sign-in sheet · ${s.name}`;
  fill(root,
    h('h1', null, s.name),
    h('p', { class: 'sub' }, when),
    h('p', { class: 'sub' }, `${s.location_name}${s.coach_name ? ` · Coach: ${s.coach_name}` : ''} · ${people.length} ${people.length === 1 ? 'athlete' : 'athletes'}${s.team ? ` · ${s.team.org_name} ${s.team.team_name}` : ''}`),
    s.status === 'canceled' ? h('p', { class: 'note' }, 'This session is canceled.') : null,
    s.staff_note ? h('p', { class: 'note' }, `Staff note: ${s.staff_note}`) : null,
    h('div', { class: 'bar' }, h('button', { type: 'button', onClick: () => window.print() }, 'Print')),
    h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Here'), h('th', null, 'Athlete'), h('th', { class: 'hide-narrow' }, 'Parent phone'), h('th', null, 'Notes'), h('th', null, 'Signature'))),
      h('tbody', null,
        people.map((p) => h('tr', null,
          h('td', { class: 'box' }, p.here ? '✓' : ''),
          h('td', null, h('div', null, p.name), h('div', { class: 'small' }, [p.id, p.age != null ? `Age ${p.age}` : null].filter(Boolean).join(' · '))),
          h('td', { class: 'hide-narrow' }, p.phone ?? ''),
          h('td', { class: 'flags' }, [p.medical ? `Medical: ${p.medical}` : null, p.noWaiver ? 'No waiver on file' : null].filter(Boolean).join(' · ')),
          h('td', { class: 'sign' }, ''))),
        Array.from({ length: 5 }, () => h('tr', { class: 'blank' }, h('td', { class: 'box' }), h('td'), h('td', { class: 'hide-narrow' }), h('td'), h('td', { class: 'sign' }))))),
    waiting.length ? h('p', { class: 'small' }, `Waitlist, in order: ${waiting.map((r) => r.name).join(', ')}`) : null);
}
load().catch(() => fill(root, h('p', null, 'The sign-in sheet didn\'t load. Check your connection and refresh.')));
