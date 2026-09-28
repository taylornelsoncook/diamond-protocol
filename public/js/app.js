import { h, fill, toast, money, date, ago, badge, btn, busy, field, input, select, panel } from './ui.js';
import { initEngage, clientPanels, rankingsPanel, readinessPanel, teamPanel, viewEducation } from './engage-coach.js';
import { initPrograms, viewPrograms, viewProgram, workoutRow } from './programs-coach.js';

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/login')) { state.user = null; render(); }
  if (!res.ok) { const e = new Error(data.error?.message || 'Something went wrong. Try again.'); e.code = data.error?.code; e.details = data.error?.details; throw e; }
  return data;
}
const metric = (label, value, note, tone) => h('div', { class: 'dp-metric' }, h('div', { class: 'dp-metric-label' }, label), h('div', { class: `dp-metric-value${tone ? ' dp-metric-value--' + tone : ''}` }, value), h('div', { class: 'dp-metric-note' }, note));
const get = (p) => api('GET', p), post = (p, b = {}) => api('POST', p, b), patch = (p, b) => api('PATCH', p, b), del = (p, b) => api('DELETE', p, b), put = (p, b) => api('PUT', p, b);

const phoneText = (p) => (/^\+1\d{10}$/.test(p ?? '') ? `(${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}` : p);
const state = { user: null, testMode: false, payments: {} };
const root = document.getElementById('root');
const ALL_NAV = [['today', 'Today'], ['schedule', 'Schedule'], ['sell', 'Point of sale'], ['clients', 'Clients'], ['leads', 'Leads'], ['teams', 'Teams'], ['testing', 'Testing'], ['billing', 'Billing'], ['programs', 'Programs'], ['education', 'Education'], ['integrations', 'API & integrations'], ['staff', 'Staff & security']];
// Menus follow the role; the server enforces the same rules on every request.
const NAV_FOR = { owner: null, coach: ['today', 'schedule', 'sell', 'clients', 'leads', 'testing', 'programs', 'education'], front_desk: ['today', 'schedule', 'sell', 'clients', 'leads', 'testing', 'programs', 'education'] };   // front desk: programs read-only
let NAV = ALL_NAV;
const isOwner = () => state.user?.role === 'owner';
initEngage({ api, render, header, role: () => state.user?.role });
initPrograms({ api, render, header, role: () => state.user?.role, pulseTile: (...a) => pulseTile(...a) });

// ---------- Shell ----------
async function boot() {
  try { const me = await get('/auth/me'); state.user = me.user; state.roles = me.roles; state.testMode = me.test_mode; state.payments = me.payments || {}; } catch { state.user = null; }
  NAV = state.user ? ALL_NAV.filter(([k]) => !NAV_FOR[state.user.role] || NAV_FOR[state.user.role].includes(k)) : ALL_NAV;
  render();
}
// A page with unsaved changes (a client's profile) sets leaveGuard; moving to another page asks first.
let leaveGuard = null, lastHash = location.hash, returning = false;
window.addEventListener('hashchange', () => {
  if (returning) { returning = false; return; }
  const msg = leaveGuard?.check(location.hash);
  if (msg) {
    if (!confirm(msg)) { returning = true; location.hash = lastHash; return; }
    leaveGuard.discard();
  }
  lastHash = location.hash;
  render();
});
window.addEventListener('beforeunload', (e) => { if (leaveGuard?.check(null)) { e.preventDefault(); e.returnValue = ''; } });

function render() {
  clearInterval(todayTimer);                          // Today sets its one-minute refresh again when it's open
  leaveGuard = null;                                  // the view sets it again if it has unsaved changes
  if (!state.user) { profileDrafts.clear(); forgetSale(); return renderLogin(); }   // signed out: the next person never sees these edits or the open sale
  if (state.user.must_change_password) return renderPasswordChange(true);
  const [section, id] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  const current = NAV.some(([k]) => k === section) ? section : 'today';
  const main = h('main', { class: 'main', id: 'main' });
  const shell = h('div', { class: 'shell' },
    h('nav', { class: 'dp-nav', 'aria-label': 'Main' },
      h('div', { class: 'dp-nav-brand' },
        h('img', { class: 'dp-nav-mark', src: '/brand/mark.png', alt: '' }),
        h('div', { class: 'dp-nav-word' }, 'DIAMOND', h('span', null, 'PROTOCOL')),
        h('div', { class: 'dp-nav-tag' }, 'Built under pressure')),
      h('div', { class: 'dp-nav-list' }, NAV.map(([k, label]) => h('a', { href: `#/${k}`, class: 'dp-nav-item', style: 'text-decoration:none', 'aria-current': k === current ? 'page' : null, onClick: () => shell.classList.remove('nav-open') }, label))),
      h('div', { style: 'margin-top:auto' }, state.payments.live ? null : h('div', { class: 'test-banner' }, state.payments.provider === 'stripe' ? 'Stripe test mode. No real money moves.' : 'Test mode. No real cards are charged.'),
        h('div', { class: 'small muted', style: 'margin-top:12px;padding:0 4px' }, `${state.user.name} · ${{ owner: 'Owner', coach: 'Coach', front_desk: 'Front desk' }[state.user.role] ?? ''}`),
        h('div', { class: 'row small muted', style: 'padding:0 4px' }, h('span', { class: 'grow' }),
          btn('Password', () => renderPasswordChange(false), 'ghost'),
          btn('Sign out', async (e) => busy(e.currentTarget, async () => { await post('/auth/logout'); state.user = null; location.hash = ''; render(); }), 'ghost')))),
    main);
  fill(root, shell);
  const views = { staff: viewStaff, today: viewToday, schedule: id === 'setup' ? viewScheduleSetup : id ? viewSession : viewSchedule, sell: id === 'setup' ? viewSetup : id === 'inventory' ? viewInventory : viewSell, clients: id ? viewClient : viewClients, leads: id === 'campaigns' ? viewCampaigns : viewLeads, teams: id === 'new' ? viewNewTeam : id ? viewTeam : viewTeams, testing: id === 'new' ? viewNewTesting : id === 'upload' ? viewUpload : id === 'queue' ? viewQueue : id === 'library' ? viewLibrary : id === 'connections' ? viewConnections : id ? viewTestingDay : viewTesting, billing: viewBilling, programs: id ? viewProgram : viewPrograms, education: viewEducation, integrations: viewIntegrations };
  main.append(h('p', { class: 'muted' }, 'Loading…'));
  views[current](main, id).catch((e) => fill(main, header('Something went wrong', e.message)));
}

function header(title, subtitle, action) {
  const menu = h('button', { type: 'button', class: 'dp-btn dp-btn--secondary menu-btn', 'aria-label': 'Open menu', onClick: () => document.querySelector('.shell').classList.toggle('nav-open') }, 'Menu');
  return h('header', { class: 'dp-header' },
    h('div', null, h('h1', { class: 'dp-header-title' }, title), subtitle ? h('p', { class: 'dp-header-sub' }, subtitle) : null),
    h('div', { class: 'row' }, menu, action || null));
}
const addClientBtn = () => btn('Add client', () => { location.hash = '#/clients/new'; });

function renderLogin() {
  const email = input({ type: 'email', autocomplete: 'username', required: true });
  const pw = input({ type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const submit = btn('Sign in', null, 'primary', { type: 'submit', class: 'dp-btn dp-btn--primary dp-btn--block' });
  const form = h('form', { class: 'dp-panel login-card', onSubmit: (e) => {
    e.preventDefault(); err.textContent = '';
    busy(submit, async () => {
      try { const r = await post('/auth/login', { email: email.value, password: pw.value }); state.user = r.user; await boot(); }
      catch (x) { err.textContent = x.message; }
    });
  } },
    h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.' }),
    field('Email', email), field('Password', pw), err, submit);
  fill(root, h('div', { class: 'login' }, form));
  email.focus();
}

// ---------- Today ----------
const EVENT_TEXT = {
  'client.created': (d) => `${d.client_name} joined`,
  'client.updated': (d) => `${d.client_name}'s details were updated`,
  'client.archived': (d) => `${d.client_name} was archived${d.by ? ` by ${d.by}` : ''}${d.bookings_canceled ? ` (${d.bookings_canceled} ${d.bookings_canceled === 1 ? 'booking' : 'bookings'} canceled)` : ''}`,
  'client.restored': (d) => `${d.client_name} was brought back from the archive`,
  'subscription.created': (d) => `${d.client_name} started ${d.plan_name}${d.status === 'trialing' ? ' (free trial)' : ''}`,
  'subscription.updated': (d) => d.previous_plan_name ? `${d.client_name} moved to ${d.plan_name}` : `${d.client_name}'s membership is now ${d.status.replace('_', ' ')}`,
  'invoice.paid': (d) => `Payment of ${money(d.amount_cents)} received from ${d.client_name}`,
  'invoice.payment_failed': (d) => `Payment of ${money(d.amount_cents)} failed for ${d.client_name}${d.final ? '. Membership canceled.' : ''}`,
  'program.assigned': (d) => `${d.client_name} started ${d.program_name}`,
  'workout.completed': (d) => `${d.client_name} finished ${d.workout_title} (${d.exercises_logged} of ${d.exercises_total} exercises${d.sets ? `, ${d.sets} ${d.sets === 1 ? 'set' : 'sets'}` : ''}${d.effort ? `, effort ${d.effort}/10` : ''})${d.bests?.length ? `. New best: ${d.bests.map((b) => `${b.name} ${b.weight} lb`).join(', ')}` : ''}`,
  'sale.completed': (d) => `${d.client_name} paid${d.amount_cents == null ? '' : ` ${money(d.amount_cents)}`} at ${d.location_name} (${METHOD_LABEL[d.method]})${d.sessions_added ? `, ${d.sessions_added} sessions added` : ''}`,
  'sale.failed': (d) => `${METHOD_LABEL[d.method]} payment${d.amount_cents == null ? '' : ` of ${money(d.amount_cents)}`} from ${d.client_name} didn't go through`,
  'sale.refunded': (d) => `Refunded ${money(d.amount_cents)} to ${d.client_name}`,
  'stock.changed': (d) => `${d.product_name}${d.size ? ` (${d.size})` : ''}: ${{ received: `${d.delta} arrived`, count: 'counted', adjust: `${d.delta > 0 ? '+' : ''}${d.delta} adjusted` }[d.reason]}, ${d.on_hand} on hand`,
  'session.checked_in': (d) => `${d.client_name} checked in${d.location_name ? ` at ${d.location_name}` : ''}${d.covered_by === 'credit' ? ' (used a session)' : ''}`,
  'purchase.completed': (d) => `${d.client_name} got ${d.title} from the online store`,
  'spots.offered': (d) => d.trial ? `Trial offer for ${d.session_name}${d.price_cents != null ? ` at ${d.price_cents === 0 ? 'no charge' : money(d.price_cents)}` : ''} sent to ${d.families} ${d.families === 1 ? 'family' : 'families'}` : `Open spots in ${d.session_name} offered to ${d.families} ${d.families === 1 ? 'family' : 'families'}`,
  'booking.created': (d) => `${d.client_name} booked ${d.session_name}${d.from_waitlist ? ' from the waitlist' : ''}${d.trial_offer ? ` from a trial offer${d.price_cents != null ? ` (${d.price_cents === 0 ? 'free' : money(d.price_cents)})` : ''}` : ''}${d.coverage === 'unpaid' ? ' (unpaid)' : ''}`,
  'booking.waitlisted': (d) => `${d.client_name} joined the waitlist for ${d.session_name}`,
  'booking.canceled': (d) => `${d.client_name} canceled ${d.session_name}${d.late ? ' (late)' : ''}`,
  'session.canceled': (d) => `${d.name} canceled${d.reason ? `: ${d.reason}` : ''}`,
  'enrollment.created': (d) => `${d.client_name} ${d.registration ? 'registered for' : 'took a standing spot in'} ${d.series_name}`,
  'family.waiver_signed': (d) => `${d.guardian_name} signed the waiver`,
  'team_contract.created': (d) => `New team contract: ${d.org_name} ${d.team_name}, ${money(d.monthly_cents)}/month`,
  'team_invoice.created': (d) => `Invoice ${d.number} to ${d.org_name}: ${money(d.amount_cents)}, due ${date(d.due_on)}`,
  'team_invoice.paid': (d) => `${d.org_name} paid invoice ${d.number} (${money(d.amount_cents)}, ${d.method})`,
  'team_invoice.overdue': (d) => `Invoice ${d.number} to ${d.org_name} is past due`,
  'team_invoice.voided': (d) => `Invoice ${d.number} voided`,
  'team_invoice.paid_twice': (d) => `Invoice ${d.number} was paid online after it was already ${d.status === 'void' ? 'voided' : 'paid'}: ${money(d.amount_cents)} to refund or credit`,
  'results.recorded': (d) => `${d.count} test ${d.count === 1 ? 'result' : 'results'} recorded for ${d.athletes} ${d.athletes === 1 ? 'athlete' : 'athletes'}${d.source && d.source !== 'manual' ? ` (${d.source.replace(/^(csv|api):/, '')})` : ''}`,
  'performance.pr': (d) => `New PR: ${d.athlete_name}, ${d.test_name} ${fmtResult(d.value, d.unit, 2)}${d.side ? ` (${d.side === 'L' ? 'left' : 'right'})` : ''}`,
  'testing.shared': (d) => `${d.name} shared with families${d.families_notified ? ` (${d.families_notified} emailed)` : ''}`,
  'family.signed_up': (d) => `New family signed up: ${d.parent_name} with ${d.athletes.map((a) => a.name).join(', ')}`,
  'family.deletion_requested': (d) => `${d.requested_by} asked for the ${d.family_name}'s data to be deleted`,
  'family.deleted': (d) => `A family's data was deleted (${d.athletes} ${d.athletes === 1 ? 'athlete' : 'athletes'})`,
  'clients.imported': (d) => `${d.athletes} clients imported${d.filename ? ` from ${d.filename}` : ''}`,
  'queue.linked': (d) => `${d.count} waiting ${d.count === 1 ? 'result' : 'results'} linked to ${d.athlete_name} (${d.athlete_id})${d.remembered ? ', device remembered' : ''}`,
  'integration.synced': (d) => `${d.results} results synced from ${d.provider === 'hawkin' ? 'Hawkin Dynamics' : d.provider}`,
  'badge.awarded': (d) => `${d.client_name} earned the ${d.badge_name} badge`,
  'course.completed': (d) => `${d.client_name} finished the course ${d.course_title}`,
  'lead.created': (d) => `${d.parent_name ?? 'A family'} asked about training${d.athlete_name ? ` for ${d.athlete_name}` : ''}`,
  'lead.updated': (d) => `A lead moved to ${String(d.status ?? '').replace('_', ' ')}`,
  'pay_link.created': (d) => `Pay link made${d.amount_cents == null ? '' : ` for ${money(d.amount_cents)}`}`,
  'pay_link.paid': (d) => `Pay link paid${d.amount_cents == null ? '' : `: ${money(d.amount_cents)}`}`,
  'progress_note.approved': () => 'A progress note for parents was approved',
  'session.messaged': (d) => `${d.by} emailed ${d.families} ${d.families === 1 ? 'family' : 'families'} about ${d.session_name}`,
  'client.card_updated': (d) => d.card_last4 ? `${d.client_name} saved a card ending ${d.card_last4}` : `${d.client_name}'s saved card was removed`
};
const METHOD_LABEL = { tap_to_pay: 'Tap to Pay', reader: 'Front-desk reader', card_on_file: 'Card on file', cash: 'Cash', online: 'Pay link' };

// Today keeps a little state between its one-minute refreshes: the check-in search, the activity filter and how much of
// the feed is showing. A refresh asked for while one is running runs once more afterwards, so two quick check-ins in a
// row both show.
const todayUi = { q: '', filter: '', shown: 20, running: null, queued: false };
let todayTimer = null;
function refreshToday(main) {
  if (todayUi.running) { todayUi.queued = true; return todayUi.running; }
  todayUi.running = keepPlace(() => viewToday(main)).catch(() => {}).finally(() => {
    todayUi.running = null;
    if (todayUi.queued) { todayUi.queued = false; refreshToday(main); }
  });
  return todayUi.running;
}
const ACTIVITY_FILTERS = { '': 'Everything', checkins: 'Check-ins', bookings: 'Bookings', training: 'Training', testing: 'Testing', clients: 'Clients', money: 'Money' };

async function viewToday(main) {
  const staff = state.user.role !== 'front_desk';
  const mineSpots = state.user.role === 'coach' && hashQuery().get('mine') === '1';     // coaches: "My classes only" on the open-spots list
  const [d, rev, board, spots, team, feed] = await Promise.all([get('/v1/dashboard'), isOwner() ? get('/v1/reports/revenue') : null, get('/v1/today'),
    staff ? get(`/v1/open-spots${mineSpots ? '?coach_id=me' : ''}`).catch(() => null) : null, isOwner() ? get('/v1/coach-summary').catch(() => null) : null,
    get(`/v1/activity?limit=${todayUi.shown}${todayUi.filter ? `&filter=${todayUi.filter}` : ''}`).catch(() => ({ data: [], next: null, filters: [] }))]);
  tzName = board.timezone;
  const refresh = () => refreshToday(main);
  const first = (n) => n.split(' ')[0];

  // Today's sessions: On now / Next / Done, coach, how many are checked in; tomorrow in one line.
  const tm = board.tomorrow;
  const agendaPanel = panel('Today\'s sessions', { subtitle: board.sessions.length ? `${board.sessions.reduce((t, x) => t + x.booked_count, 0)} athletes booked · ${board.sessions.reduce((t, x) => t + x.attended_count, 0)} checked in` : null, action: h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule' }, 'Full schedule') },
    board.sessions.length ? board.sessions.map((x) => sessionRow(x, { showState: true, state: x.state })) : h('p', { class: 'muted' }, 'Nothing on the schedule today.'),
    h('p', { class: 'small muted', style: 'margin:12px 0 0' }, tm.sessions ? `Tomorrow: ${nplural(tm.sessions, 'session')}, first at ${timeOf(tm.first_at)}, ${tm.booked} booked.` : 'Tomorrow: nothing scheduled.'));

  // Check in: everyone booked today, still to arrive first. Search by name or Athlete ID; Enter checks in the only match.
  const search = input({ type: 'search', placeholder: 'Name or Athlete ID', 'aria-label': 'Find someone to check in', value: todayUi.q, 'data-focus': 'checkin-search', autocomplete: 'off' });
  const rows = h('div', { class: 'stack-tight' });
  const flagBadge = (text, tone = 'warn', title) => h('span', { class: `dp-badge dp-badge--${tone}`, title }, text);
  const checkIn = async (a, button) => {
    await busy(button, async () => {
      await post(`/v1/bookings/${a.booking_id}/attendance`, { status: 'attended' });
      todayUi.q = '';
      undoToast(`${a.name} checked in for ${a.session_name}.`, async () => { try { await post(`/v1/bookings/${a.booking_id}/attendance`, { status: a.status === 'no_show' ? 'no_show' : 'booked' }); toast(`${first(a.name)} is no longer checked in.`); } catch (e) { toast(e.message, 'warn'); } refresh(); });
      await refresh();
      document.querySelector('[data-focus="checkin-search"]')?.focus({ preventScroll: true });
    });
  };
  const arrivalRow = (a) => {
    const here = a.status === 'attended', over = !here && a.state === 'done';
    return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('button', { type: 'button', class: 'dp-ex-log', style: 'min-width:92px', 'data-focus': `ck-${a.booking_id}`, 'aria-pressed': String(here), 'aria-label': `${here ? 'Undo check-in for' : 'Check in'} ${a.name}`,
        onClick: (e) => here ? busy(e.currentTarget, async () => { await post(`/v1/bookings/${a.booking_id}/attendance`, { status: 'booked' }); toast(`${first(a.name)} is no longer checked in.`); await refresh(); }) : checkIn(a, e.currentTarget) }, here ? 'Here' : 'Check in'),
      h('div', { class: 'grow stack-tight', style: 'min-width:180px' },
        h('a', { href: `#/clients/${a.client_id}`, class: 'strong', style: 'color:var(--steel)' }, a.name),
        h('span', { class: 'small muted' }, `${timeOf(a.starts_at)} ${a.session_name}${a.athlete_id ? ` · ${a.athlete_id}` : ''}`),
        over ? h('span', { class: 'small muted' }, a.status === 'no_show' ? 'Marked no-show.' : 'Session over, not checked in.') : null,
        a.medical ? h('span', { class: 'small warn-text' }, `Medical: ${a.medical}`) : null),
      h('div', { class: 'row wrap', style: 'gap:6px' },
        a.birthday ? flagBadge('Birthday', 'good') : null, a.no_waiver ? flagBadge('No waiver') : null, a.unpaid ? flagBadge('Unpaid') : null,
        a.flags.length ? flagBadge('Rough check-in', 'warn', a.flags.join(', ')) : null));
  };
  const drawArrivals = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = board.arrivals.filter((a) => words.every((w) => `${a.name} ${a.athlete_id ?? ''}`.toLowerCase().includes(w)));
    fill(rows, list.length ? list.slice(0, words.length ? 50 : 40).map(arrivalRow) : h('p', { class: 'muted', style: 'margin:0' }, words.length ? `Nobody booked today matches "${search.value.trim()}".` : 'Nobody is booked today.'),
      list.length > 40 && !words.length ? h('p', { class: 'small muted', style: 'margin:0' }, `${list.length - 40} more. Search to find them.`) : null);
  };
  search.addEventListener('input', () => { todayUi.q = search.value; drawArrivals(); });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const list = board.arrivals.filter((a) => a.status !== 'attended' && words.every((w) => `${a.name} ${a.athlete_id ?? ''}`.toLowerCase().includes(w)));
    if (list.length === 1) return checkIn(list[0], null);
    toast(list.length ? `${list.length} people match. Tap the right one.` : board.arrivals.some((a) => words.every((w) => `${a.name} ${a.athlete_id ?? ''}`.toLowerCase().includes(w))) ? 'Already checked in.' : `Nobody booked today matches "${search.value.trim()}".`, 'warn');
  });
  drawArrivals();
  const hereCount = board.arrivals.filter((a) => a.status === 'attended').length;
  const checkinPanelEl = board.arrivals.length ? panel(`Check in · ${hereCount} of ${board.arrivals.length} here`, { subtitle: 'Still to arrive first. Tap Check in, or type a name and press Enter. Tap Here to undo.' }, search, rows) : null;

  // Needs your attention: money items (owner), unpaid bookings to collect at the door, rough check-ins, and the rest.
  const attention = d.attention.map((a) => {
    const link = h('a', { href: `#/clients/${a.client_id}`, class: 'strong', style: 'color:var(--steel)' }, a.name);
    if (a.kind === 'payment_failed') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, link, h('span', { class: 'small muted' }, `${money(a.amount_cents)} for ${a.plan_name} declined ${a.attempts}×. ${a.next_retry_at ? 'Auto-retry ' + date(a.next_retry_at) + '.' : 'No more automatic retries: ask the family to update their card.'}`)),
      btn('Retry charge', (e) => {
        if (!confirm(`Charge ${money(a.amount_cents)} for ${a.plan_name} to ${first(a.name)}'s card on file now?`)) return;
        busy(e.currentTarget, async () => {
          const inv = await post(`/v1/invoices/${a.invoice_id}/retry`);
          inv.status === 'paid' ? toast(`Charged ${money(a.amount_cents)}. ${first(a.name)} is paid up.`) : toast(`Declined again. Send ${first(a.name)}'s family a pay link from their client page so they can add a new card.`, 'warn');
          refresh();
        });
      }, 'outline'));
    if (a.kind === 'team_invoice_overdue') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('a', { href: `#/teams/${a.contract_id}`, class: 'strong', style: 'color:var(--steel)' }, `${a.name} · ${a.team_name}`), h('span', { class: 'small muted' }, `Invoice ${a.number} for ${money(a.amount_cents)} was due ${date(a.due_on)}. Reminders go out weekly.`)),
      h('a', { class: 'dp-btn dp-btn--outline', href: `#/teams/${a.contract_id}` }, 'Open team'));
    if (a.kind === 'deletion_request') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, `${a.family_name} asked for their data to be deleted`), h('span', { class: 'small muted' }, `Requested by ${a.requested_by.split(' <')[0]} ${ago(a.created_at)}.`)),
      h('a', { class: 'dp-btn dp-btn--outline', href: '#/staff' }, 'Review'));
    if (a.kind === 'new_leads') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.count === 1 ? `${a.name} asked about training` : `${a.count} families asked about training this week`), h('span', { class: 'small muted' }, 'They got an automatic thank-you with the sign-up link. A personal call or text wins most of them.')),
      h('a', { class: 'dp-btn dp-btn--outline', href: '#/leads' }, 'See leads'));
    if (a.kind === 'replies') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.count === 1 ? `${a.items[0].author ?? a.items[0].name} wrote back about ${first(a.items[0].name)}` : `${a.count} athletes have new replies`), h('span', { class: 'small muted' }, a.items.map((x) => `${x.name} (${x.count})`).join(' · '))),
      h('a', { class: 'dp-btn dp-btn--outline', href: `#/clients/${a.items[0].client_id}` }, 'Read'));
    if (a.kind === 'low_stock') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.count === 1 ? `${a.items[0].name} is running low` : `${a.count} items are running low`), h('span', { class: 'small muted' }, a.items.map((x) => `${x.name}: ${x.on_hand <= 0 ? 'out' : `${x.on_hand} left`}`).join(' · '))),
      h('a', { class: 'dp-btn dp-btn--outline', href: '#/sell/inventory' }, 'Inventory'));
    if (a.kind === 'results_waiting') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, `${a.count} test ${a.count === 1 ? 'result is' : 'results are'} waiting to be linked`), h('span', { class: 'small muted' }, `From ${a.groups} unrecognized ${a.groups === 1 ? 'athlete' : 'athletes'}. They stay out of every profile until ${a.can_link === false ? 'a coach links' : 'you link'} them.`)),
      a.can_link === false ? null : h('a', { class: 'dp-btn dp-btn--outline', href: '#/testing/queue' }, 'Link them'));
    if (a.kind === 'trial_ending') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, link, h('span', { class: 'small muted' }, `Free trial ends ${date(a.trial_ends_at)}. First charge ${money(a.amount_cents)}.`)),
      h('a', { class: 'dp-btn dp-btn--outline', href: `#/clients/${a.client_id}` }, 'View client'));
    if (a.kind === 'sale_pending') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.name), h('span', { class: 'small muted' }, `${a.amount_cents == null ? '' : `${money(a.amount_cents)} `}${METHOD_LABEL[a.method]} payment at ${a.location_name} is still waiting.`)),
      h('a', { class: 'dp-btn dp-btn--outline', href: '#/sell' }, 'Review'));
    return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, link, h('span', { class: 'small muted' }, `No workout logged since ${date(a.last_workout_at)}.`)),
      h('a', { class: 'dp-btn dp-btn--outline', href: `#/clients/${a.client_id}` }, 'Check in'));
  });
  const unpaid = board.sessions.filter((x) => x.unpaid_count && x.state !== 'done').map((x) => h('div', { class: 'list-item' },
    h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, `${nplural(x.unpaid_count, 'unpaid booking')} in ${x.name}`), h('span', { class: 'small muted' }, `${timeOf(x.starts_at)} today. Collect at check-in: card on file, cash or Tap to Pay.`)),
    h('a', { class: 'dp-btn dp-btn--outline', href: `#/schedule/${x.id}` }, 'Open roster')));
  const reviewed = async (f, button) => busy(button, async () => {
    const r = await post('/v1/today/follow-ups', { key: f.key, action: 'reviewed' });
    undoToast(r.message, async () => { await del(`/v1/today/follow-ups/${r.id}`).catch((e) => toast(e.message, 'warn')); refresh(); });
    refresh();
  });
  const flagItems = board.flags.map((f) => h('div', { class: 'list-item', style: 'align-items:flex-start;flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('a', { href: `#/clients/${f.client_id}`, class: 'strong', style: 'color:var(--steel)' }, `${f.name}: rough check-in ${f.today ? 'today' : 'yesterday'}`),
      h('span', { class: 'small warn-text' }, f.flags.join(' · ')),
      h('span', { class: 'small muted' }, f.session ? `Trains today at ${timeOf(f.session.starts_at)} (${f.session.name}).` : 'Not training here today.'),
      f.note ? h('span', { class: 'small muted' }, `"${f.note}"`) : null),
    staff ? btn('Mark reviewed', (e) => reviewed(f, e.currentTarget), 'ghost', { 'aria-label': `Mark ${f.name}'s check-in as reviewed` }) : h('a', { class: 'dp-btn dp-btn--ghost', href: `#/clients/${f.client_id}` }, 'Open')));
  const allAttention = [...unpaid, ...flagItems, ...attention];

  // Follow-ups (owners and coaches): athletes to check on, with a note, a call or "Reached out" that hides them for a week.
  const followPanel = !board.follow_ups ? null : (() => {
    const snooze = async (r, action, button, note) => busy(button, async () => {
      const out = await post('/v1/today/follow-ups', { key: r.key, action, note });
      undoToast(out.message, async () => { await del(`/v1/today/follow-ups/${out.id}`).catch((e) => toast(e.message, 'warn')); refresh(); });
      refresh();
    });
    const noteDialog = (r) => {
      const msg = textarea(`Hi ${first(r.name)}, we've missed you at training. Everything OK? Book your next session in the app, or reply and let us know how you're doing.`, { maxlength: '2000', style: 'min-height:120px' });
      let sent = false;     // the note went out; a failed "hide" retried from here never sends it twice
      teamDialog(`Send ${first(r.name)} a note`, h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, `It shows in ${first(r.name)}'s app and their parents get an email. They come off Today for a week.`), field('Note', msg)),
        [{ label: 'Send note', variant: 'primary', onClick: async () => {
          if (!sent) { await post(`/v1/clients/${r.client_id}/messages`, { body: msg.value }); sent = true; }
          await post('/v1/today/follow-ups', { key: r.key, action: 'noted', note: 'Sent a note' });
          toast(`Note sent to ${first(r.name)}.`); refresh();
        } }, { label: 'Cancel', variant: 'ghost' }]);
      msg.focus();
    };
    const row = (r) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('a', { href: `#/clients/${r.client_id}`, class: 'strong', style: 'color:var(--steel)' }, r.name, r.family_name ? h('span', { class: 'small muted' }, ` · ${r.family_name}`) : null), h('span', { class: 'small muted' }, r.reasons.join(' · '))),
      h('div', { class: 'row wrap', style: 'gap:6px' },
        btn('Send a note', () => noteDialog(r), 'outline', { 'aria-label': `Send ${r.name} a note` }),
        r.phone ? h('a', { class: 'dp-btn dp-btn--ghost', href: `tel:${r.phone}`, 'aria-label': `Call ${r.name}'s family` }, 'Call') : null,
        btn('Reached out', (e) => snooze(r, 'reached_out', e.currentTarget), 'ghost', { 'aria-label': `Mark ${r.name} as reached out` })));
    const done = board.followed_up.filter((z) => z.kind === 'risk');
    const doneList = done.length ? h('details', { style: 'margin-top:8px' }, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `Followed up lately (${done.length})`),
      done.map((z) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('span', null, z.name), h('span', { class: 'small muted' }, `${z.label} by ${z.created_by} ${ago(z.created_at).toLowerCase()}${z.note && z.note !== 'Sent a note' ? `: "${z.note}"` : ''}. Back on Today after ${ymd(z.until)}.`)),
        btn('Bring back', (e) => busy(e.currentTarget, async () => { const r = await del(`/v1/today/follow-ups/${z.id}`); toast(r.message); refresh(); }), 'ghost', { 'aria-label': `Bring ${z.name} back to Today` })))) : null;
    if (!board.follow_ups.length && !done.length) return null;
    return panel(`Athletes to check on${board.follow_ups.length ? ` (${board.follow_ups.length})` : ''}`, { subtitle: 'Coming less, nothing booked, or other signs they may be drifting away. A quick note or call usually brings them back.' },
      board.follow_ups.length ? board.follow_ups.map(row) : h('p', { class: 'muted', style: 'margin:0' }, 'Everyone is followed up.'), doneList);
  })();

  const bdays = board.birthdays.length ? panel('Birthdays this week', {}, board.birthdays.map((b) => h('div', { class: 'list-item' },
    h('a', { class: 'grow strong', href: `#/clients/${b.client_id}`, style: 'color:var(--steel)' }, b.name),
    h('span', { class: `small ${b.today ? 'good-text' : 'muted'}` }, `${b.today ? 'Today' : shortDate(b.date)} · turns ${b.turning}`)))) : null;

  // Recent activity: newest first, filters, Show more; the exact time on hover.
  const act = h('div');
  const filters = ['', ...(feed.filters ?? [])];
  const drawActivity = (data, next) => fill(act,
    h('div', { class: 'row wrap tm-views', role: 'group', 'aria-label': 'Show activity', style: 'margin-bottom:8px' }, filters.map((k) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(todayUi.filter === k),
      onClick: async (e) => busy(e.currentTarget, async () => { todayUi.filter = k; todayUi.shown = 20; const f = await get(`/v1/activity?limit=20${k ? `&filter=${k}` : ''}`); drawActivity(f.data, f.next); }) }, ACTIVITY_FILTERS[k] ?? k))),
    data.length ? data.map((ev) => h('div', { class: 'list-item' },
      h('div', { class: 'small muted', style: 'width:92px;flex-shrink:0', title: tzFmt(ev.created_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }, ago(ev.created_at)),
      h('div', { class: 'grow' }, (EVENT_TEXT[ev.type] || (() => ev.type))(ev.data)))) : h('p', { class: 'muted' }, todayUi.filter ? 'Nothing like that yet.' : 'Activity shows up here as clients join, pay and train.'),
    next ? btn('Show more', (e) => busy(e.currentTarget, async () => { const f = await get(`/v1/activity?limit=20&before=${encodeURIComponent(next)}${todayUi.filter ? `&filter=${todayUi.filter}` : ''}`); todayUi.shown = data.length + f.data.length; drawActivity([...data, ...f.data], f.next); }), 'ghost') : null);
  drawActivity(feed.data, feed.next);

  const revPanel = !rev ? null : panel('Revenue by location', { subtitle: `This month. In-person sales plus ${money(rev.memberships_cents)} from ${rev.membership_payments} membership ${rev.membership_payments === 1 ? 'payment' : 'payments'}.`, action: h('a', { class: 'dp-btn dp-btn--secondary', href: '#/sell' }, 'New sale') },
    rev.locations.length ? rev.locations.map((l) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, l.name), h('span', { class: 'small muted' }, `${l.sales} ${l.sales === 1 ? 'sale' : 'sales'}`), h('span', { style: 'font:600 22px/1 var(--font-display);min-width:96px;text-align:right' }, money(l.cents))))
      : h('p', { class: 'muted' }, 'Add your facility, parks and mobile location in Point of sale setup to track where you earn.'));
  const dateLine = tzFmt(board.now, { weekday: 'long', month: 'long', day: 'numeric' });
  const parentSlot = h('div');
  if (isOwner()) parentRequestsPanel().then((p) => fill(parentSlot, p)).catch(() => {});
  fill(main,
    header('Today', `${dateLine}. ${isOwner() ? 'How the business is doing, and anything that needs a decision.' : `Hi ${first(state.user.name)}. Today's sessions and anything that needs you.`}`, addClientBtn()),
    pulseBlock(d.pulse),
    parentSlot,
    agendaPanel,
    checkinPanelEl,
    h('div', { class: 'grid grid-2' },
      panel(`Needs your attention${allAttention.length ? ` (${allAttention.length})` : ''}`, {}, allAttention.length ? allAttention : h('p', { class: 'muted' }, 'Nothing waiting. Every client is paid up and training.')),
      h('div', { class: 'stack', style: 'gap:24px' }, followPanel, bdays, followPanel || bdays ? null : panel('Birthdays this week', {}, h('p', { class: 'muted', style: 'margin:0' }, 'No birthdays this week.')))),
    team ? coachesPanel(team) : null,
    spots ? spotsPanel(spots, { mine: mineSpots }) : null,
    panel('Recent activity', {}, act),
    revPanel);
  // Refresh every minute while Today is open, unless someone is typing or a dialog is open.
  clearInterval(todayTimer);
  todayTimer = setInterval(() => {
    const onToday = !location.hash || /^#\/?today/.test(location.hash);
    if (!onToday) { clearInterval(todayTimer); return; }
    const el = document.activeElement;
    if (document.hidden || document.querySelector('dialog[open]') || (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && el.dataset.focus !== 'checkin-search')) return;
    refreshToday(main);
  }, 60000);
}

// The small-print summary under Today's header: many numbers, each with one line of detail. Tiles open the screen behind them.
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
function pulseTile(label, value, detail, { tone, href } = {}) {
  const body = [h('div', { class: 'pulse-label' }, label), h('div', { class: `pulse-value${tone ? ' pulse-value--' + tone : ''}` }, value), detail ? h('div', { class: 'pulse-detail' }, detail) : null];
  return href ? h('a', { class: 'pulse-tile', href }, ...body) : h('div', { class: 'pulse-tile' }, ...body);
}
function pulseBlock(p) {
  if (!p) return null;
  const c = p.clients, att = p.attendance.came + p.attendance.missed, tiles = [];
  if (p.money) {
    const mo = p.money, diff = mo.month.total - mo.same_point_last_month;
    tiles.push(
      pulseTile('Collected this month', money(mo.month.total), mo.same_point_last_month || mo.month.total ? `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))} vs this point last month` : 'Nothing collected yet', { href: '#/billing' }),
      pulseTile('In person today', money(mo.today_cents), `${mo.today_sales} ${mo.today_sales === 1 ? 'sale' : 'sales'}`, { href: '#/sell' }),
      ...mo.locations.slice(0, 4).map((l) => pulseTile(`At ${l.name}`, money(l.cents), `This month · ${l.sales} ${l.sales === 1 ? 'sale' : 'sales'} in person`, { href: '#/sell' })),
      pulseTile('Monthly recurring', money(mo.mrr_cents), `${money(mo.member_mrr_cents)} members · ${money(mo.team_mrr_cents)} teams`, { href: '#/billing' }),
      pulseTile('Average per member', mo.paying_members ? money(Math.round(mo.member_mrr_cents / mo.paying_members)) : '–', `${mo.paying_members} paying ${mo.paying_members === 1 ? 'member' : 'members'}`, { href: '#/clients?status=current' }),
      pulseTile('Average spend per client', money(mo.avg_spend_cents), `This month · ${mo.paying_clients_this_month} ${mo.paying_clients_this_month === 1 ? 'client' : 'clients'} paid`, { href: '#/billing' }));
  }
  tiles.push(
    pulseTile('Active clients', c.active, `${c.trialing} on trial · ${c.new_this_month} added this month`, { href: '#/clients?status=current' }),
    pulseTile('New members', p.new_members.this_month, p.new_members.this_month ? `This month${p.new_members.trialing ? ` · ${p.new_members.trialing} on trial` : ''}` : 'None yet this month', { tone: p.new_members.this_month ? 'good' : null, href: '#/clients?status=current' }),
    pulseTile('Cancellations', c.canceled_this_month, c.canceled_this_month ? `This month · ${pct(c.canceled_this_month, c.active + c.canceled_this_month)} of members` : 'None this month', { tone: c.canceled_this_month ? 'warn' : null, href: '#/clients' }));
  if (p.money) {
    const mo = p.money;
    tiles.push(
      pulseTile('Failed payments', money(mo.failed_cents), mo.failed_invoices ? `${mo.failed_invoices} ${mo.failed_invoices === 1 ? 'charge' : 'charges'} to retry` : 'Everyone is paid up', { tone: mo.failed_invoices ? 'warn' : null, href: '#/billing' }),
      pulseTile('Team invoices open', money(mo.team_open_cents), mo.team_overdue ? `${money(mo.team_overdue_cents)} overdue on ${mo.team_overdue}` : 'Nothing overdue', { tone: mo.team_overdue ? 'warn' : null, href: '#/teams' }));
  }
  tiles.push(
    pulseTile('Sessions today', p.today.sessions, p.today.capacity ? `${p.today.booked} of ${p.today.capacity} spots filled (${pct(p.today.booked, p.today.capacity)})` : 'Nothing scheduled', { href: '#/schedule' }),
    pulseTile('Attendance, 7 days', pct(p.attendance.came, att), att ? `${p.attendance.came} came · ${p.attendance.missed} no-shows` : 'No sessions checked in yet', { tone: att && p.attendance.came / att < 0.8 ? 'warn' : null }),
    pulseTile('Booked, next 7 days', p.bookings_next_7_days, 'Spots booked on the schedule', { href: '#/schedule' }),
    pulseTile('Workouts logged', p.workouts.last_7_days, `Last 7 days · ${p.workouts.athletes} ${p.workouts.athletes === 1 ? 'athlete' : 'athletes'}`, { tone: p.workouts.last_7_days ? 'good' : null, href: '#/programs' }),
    pulseTile('Most active members', p.most_active.length ? p.most_active[0].name.split(' ')[0] : '–', p.most_active.length ? `30 days · ${p.most_active.map((a) => `${a.name.split(' ')[0]} ${a.sessions + a.workouts}`).join(' · ')}` : 'No sessions or workouts in 30 days', { href: p.most_active.length ? `#/clients/${p.most_active[0].client_id}` : '#/clients' }),
    pulseTile('Leads this month', p.leads.this_month, `${p.leads.won} signed up · ${p.leads.open} still open`, { href: '#/leads' }));
  return h('section', { class: 'pulse', 'aria-label': 'How the business is doing' }, ...tiles);
}


// Every class families book single spots in (group classes, clinics, camp days) with a spot left in the next 7 days,
// whoever leads it. One tap offers the spots to families who fit; owners can also send a "try it for $X" trial offer.
const offerLine = (o) => [
  o.sent - o.trial_sent > 0 ? `${o.sent - o.trial_sent} offered` : null,
  o.trial_sent ? `Trial offer sent${o.trial_price_cents != null ? ` at ${o.trial_price_cents === 0 ? 'no charge' : money(o.trial_price_cents)}` : ''} to ${o.trial_sent} ${o.trial_sent === 1 ? 'family' : 'families'}` : null,
  o.sent ? `${o.opened} opened, ${o.booked} booked` : null].filter(Boolean).join(' · ');
function spotsPanel(spots, { mine = false } = {}) {
  const auto = spots.mode === 'auto';
  let action = null;
  if (isOwner()) {
    action = select([['suggest', 'Send offers when I tap'], ['auto', 'Send offers automatically'], ['off', 'Don\'t send offers']], { value: spots.mode, 'aria-label': 'Open spot offers', style: 'width:auto' });
    action.addEventListener('change', () => busy(action, async () => { await patch('/v1/settings', { open_spot_offers: action.value }); toast(action.value === 'auto' ? 'Offers go out on their own between 10 am and 7 pm.' : action.value === 'off' ? 'Offers are off. Classes with open spots still show here.' : 'Saved.'); render(); }));
  } else if (state.user.role === 'coach') {
    const box = h('input', { type: 'checkbox', checked: mine });
    box.addEventListener('change', () => { location.hash = box.checked ? '#/today?mine=1' : '#/today'; });
    action = h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, box, h('span', null, 'My classes only'));
  }
  const subtitle = `Every class with a spot left in the next ${spots.days} days, soonest first. ${auto ? 'Offers go out on their own between 10 am and 7 pm for classes and clinics starting within 30 hours; send the rest by hand.' : spots.mode === 'off' ? 'Offers are off, so nothing goes out.' : 'Offer spots to families who fit: regulars first, then members and recent athletes. First to tap the link gets it.'}`;
  const row = (x) => {
    const n = x.offer_count;
    return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('div', { style: 'width:76px;flex-shrink:0;font:600 17px/1.1 var(--font-display)' }, timeOf(x.starts_at)),
      h('div', { class: 'grow stack-tight', style: 'min-width:200px' },
        h('a', { href: `#/schedule/${x.id}`, class: 'strong', style: 'color:var(--steel)' }, x.name),
        h('span', { class: 'small muted' }, `${x.location_name} · ${x.coach_name ?? 'No coach set'}`),
        h('span', { class: 'small' }, `${x.booked} of ${x.capacity} booked · `, h('span', { class: x.spots_left <= 2 ? 'warn-text' : '' }, `${x.spots_left} ${x.spots_left === 1 ? 'spot' : 'spots'} left`), ` · ${x.families_who_fit} ${x.families_who_fit === 1 ? 'family fits' : 'families fit'}`),
        x.offers.sent ? h('span', { class: 'small muted' }, offerLine(x.offers)) : null,
        x.can_offer ? null : h('span', { class: 'small muted' }, x.offer_note)),
      h('div', { class: 'row wrap', style: 'gap:8px;margin-left:auto;justify-content:flex-end' },
        kindBadge(x.kind),
        x.can_offer ? btn(`Offer to ${n} ${n === 1 ? 'family' : 'families'}`, (e) => busy(e.currentTarget, async () => {
          const r = await post(`/v1/sessions/${x.id}/offer-spots`); toast(`Offered to ${r.sent} ${r.sent === 1 ? 'family' : 'families'}. First to tap gets it.`); render();
        }), 'outline') : null,
        isOwner() && x.can_trial ? btn('Trial offer', () => trialOfferDialog(x), 'ghost', { title: 'Send "try this session for $X"' }) : null));
  };
  const byDay = new Map();
  for (const x of spots.data) { const k = dayOf(x.starts_at); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(x); }
  const body = !spots.data.length ? [h('p', { class: 'muted' }, mine ? 'Your classes are full for the next week, or you don\'t lead any. Untick My classes only to see everyone\'s.' : 'Every class in the next week is full.')]
    : spots.data.length <= 5 ? spots.data.map(row)
      : [...byDay].map(([day, xs]) => h('div', null, h('div', { class: 'dp-label', style: 'margin-top:12px' }, `${day} · ${xs.reduce((t, x) => t + x.spots_left, 0)} open`), ...xs.map(row)));
  return panel(`Classes with open spots${spots.data.length ? ` (${spots.data.length})` : ''}`, { subtitle, action }, ...body);
}

// Owner only: "try this session for $X". Price (the drop-in by default, $0 = free), how many families, and the message.
async function trialOfferDialog(x) {
  const d = document.getElementById('dialog');
  let p;
  try { p = await get(`/v1/sessions/${x.id}/trial-offer`); } catch (e) { return toast(e.message, 'warn'); }
  const dollars = (c) => (c / 100).toFixed(c % 100 ? 2 : 0);
  const price = input({ type: 'number', inputmode: 'decimal', min: '0', max: dollars(p.max_price_cents), step: '0.01', value: dollars(p.default_price_cents) });
  const count = input({ type: 'number', inputmode: 'numeric', min: '1', max: String(Math.min(p.max_families, Math.max(p.families, 1))), value: String(Math.min(p.families, p.max_families)) });
  const msg = h('textarea', { class: 'dp-input', style: 'min-height:96px', maxlength: '1000' }); msg.value = p.message;
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const preview = h('div', { class: 'small', style: 'white-space:pre-wrap;background:var(--bg);border:1px solid var(--line-subtle);border-radius:8px;padding:12px' });
  const cents = () => (price.value === '' ? NaN : Math.round(Number(price.value) * 100));
  const priceWords = (c) => (c === 0 ? 'free' : money(c));
  const ends = tzFmt(p.expires_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const update = () => {
    const c = cents(), ok = Number.isInteger(c) && c >= 0 && c <= p.max_price_cents;
    err.textContent = ok ? '' : `Set a price from $0 (free) to ${money(p.max_price_cents)}.`;
    const pr = ok ? priceWords(c) : '…';
    fill(preview, h('div', { class: 'strong' }, `Subject: Try ${p.session.name} ${c === 0 ? 'free' : `for ${pr}`}: ${ends}`), '\n',
      `Hi Maria,\n\n${(msg.value.trim() || p.message).replaceAll('{athlete}', 'Ava').replaceAll('{price}', pr)}\n\n${p.session.spots_left === 1 ? 'There\'s one spot' : `There are ${p.session.spots_left} spots`}, and the first to book gets ${p.session.spots_left === 1 ? 'it' : 'them'}. The offer ends when the session starts. Book in one tap, no sign-in needed:\n[booking link]`);
  };
  for (const el of [price, msg]) el.addEventListener('input', update);
  update();
  const who = `${p.families} ${p.families === 1 ? 'family fits' : 'families fit'}: the right age, and a regular, a member or here in the last 45 days${p.offered_before ? `. ${p.offered_before} of them already had an open-spot offer for this class and haven't booked; their link switches to this price` : ''}. At most 2 offers a family a day.`;
  fill(d, h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try {
      const r = await post(`/v1/sessions/${x.id}/trial-offer`, { price_cents: cents(), max_families: Number(count.value), message: msg.value });
      d.close(); toast(`Trial offer sent to ${r.sent} ${r.sent === 1 ? 'family' : 'families'} at ${r.price_cents === 0 ? 'no charge' : money(r.price_cents)}. First to book gets it.`); render();
    } catch (x2) { err.textContent = x2.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel);margin:0' }, 'Trial offer'),
    h('p', { class: 'muted', style: 'margin:0' }, `${p.session.name} · ${ends} · ${p.session.location_name}${p.session.coach_name ? ` · ${p.session.coach_name}` : ''} · ${p.session.spots_left} ${p.session.spots_left === 1 ? 'spot' : 'spots'} left`),
    h('div', { class: 'form-grid' },
      field('Price ($)', price, `${p.session.drop_in_cents != null ? `Drop-in is ${money(p.session.drop_in_cents)}.` : `No drop-in price; up to ${money(p.max_price_cents)}.`} 0 makes it free. Charged to the family's card when they book; members whose membership covers the class aren't charged.`),
      field('Send to up to', count, who)),
    p.open_leads_with_email ? h('p', { class: 'small muted', style: 'margin:0' }, `${p.open_leads_with_email} open ${p.open_leads_with_email === 1 ? 'lead' : 'leads'} with an email ${p.open_leads_with_email === 1 ? 'isn\'t' : 'aren\'t'} included: booking from a link needs a family account and a signed waiver. Send them your sign-up link from Leads.`) : null,
    field('Message', msg, '{athlete} becomes the athlete\'s first name and {price} the price. The booking link is added below it. Families who turned on texts also get a short text.'),
    h('div', { class: 'dp-label' }, 'Preview, for a sample family'), preview,
    h('p', { class: 'small muted', style: 'margin:0' }, `Valid until the session starts (${ends}). First to book gets each spot; after that the link says it's full.`),
    err,
    h('div', { class: 'row wrap' }, btn('Send trial offer', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
}

// Owner only: every active coach at a glance (today, the next 7 days, attendance, days off). Tap a coach for their schedule.
function coachesPanel(t) {
  const shortDay = (iso) => tzFmt(iso, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const offText = (x) => { const f = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); return `Off ${f(x.start_date)}${x.end_date !== x.start_date ? `–${f(x.end_date)}` : ''}${x.note ? ` (${x.note})` : ''}`; };
  const row = (c) => {
    const w = c.week, a = c.attendance_7_days, seen = a.came + a.missed, n = c.next_session;
    return h('div', { class: 'list-item', style: 'flex-wrap:wrap;align-items:flex-start' },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' },
        h('a', { href: `#/schedule?coach=${c.id}`, class: 'strong', style: 'color:var(--steel)' }, c.name, c.role === 'owner' ? h('span', { class: 'small muted' }, ' · Owner') : null),
        h('span', { class: 'small' }, c.today.sessions ? `Today: ${c.today.sessions} ${c.today.sessions === 1 ? 'session' : 'sessions'}, ${c.today.booked} booked` : 'Nothing today',
          n ? h('span', { class: 'muted' }, ` · next ${n.starts_at < new Date(Date.now() + 86400000).toISOString() && dayOf(n.starts_at) === dayOf(new Date().toISOString()) ? timeOf(n.starts_at) : shortDay(n.starts_at)} ${n.name} (${n.booked}/${n.capacity})`) : null),
        h('span', { class: 'small muted' }, [`Next 7 days: ${w.sessions} ${w.sessions === 1 ? 'session' : 'sessions'}`, w.classes ? `classes ${w.fill_pct}% full (${w.class_booked} of ${w.class_spots})` : null,
          `${w.privates_booked} ${w.privates_booked === 1 ? 'private' : 'privates'} booked`, w.evaluations_booked ? `${w.evaluations_booked} ${w.evaluations_booked === 1 ? 'evaluation' : 'evaluations'}` : null].filter(Boolean).join(' · ')),
        h('span', { class: 'small muted' }, seen ? `Last 7 days: ${a.came} came, ${a.missed} no-show${a.missed === 1 ? '' : 's'} (${Math.round((a.came / seen) * 100)}%)` : 'Last 7 days: no check-ins yet')),
      h('div', { class: 'row wrap', style: 'gap:6px' }, ...c.time_off.slice(0, 2).map((x) => h('span', { class: 'dp-badge dp-badge--neutral' }, offText(x))),
        h('a', { class: 'dp-btn dp-btn--ghost', href: `#/schedule?coach=${c.id}` }, 'Schedule')));
  };
  return panel('Coaches', { subtitle: 'Who is leading what. Fill rate counts group classes, clinics and camp days.' },
    t.coaches.map(row),
    t.no_coach.sessions ? h('div', { class: 'list-item' }, h('span', { class: 'grow small warn-text' }, `${t.no_coach.sessions} ${t.no_coach.sessions === 1 ? 'session' : 'sessions'} in the next 7 days ${t.no_coach.sessions === 1 ? 'has' : 'have'} no coach${t.no_coach.next ? `, starting with ${t.no_coach.next.name} ${shortDay(t.no_coach.next.starts_at)}` : ''}.`),
      h('a', { class: 'dp-btn dp-btn--ghost', href: '#/schedule' }, 'Assign')) : null,
    t.facility_time_off.length ? h('p', { class: 'small muted', style: 'margin:8px 0 0' }, `Facility closed: ${t.facility_time_off.map(offText).map((s) => s.replace(/^Off /, '')).join(' · ')}`) : null);
}

// ---------- Leads ----------
const LEAD_STAGES = [['new', 'New'], ['contacted', 'Contacted'], ['signed_up', 'Signed up'], ['evaluation', 'Evaluation booked'], ['member', 'Member'], ['lost', 'Not now']];
const LEAD_SOURCE = { inquiry: 'Website form', signup_unfinished: 'Unfinished sign-up', manual: 'Added by staff', phone: 'Phone call', walk_in: 'Walk-in', event: 'Event', referral: 'Referral' };
async function viewLeads(main) {
  const filter = new URLSearchParams(location.hash.split('?')[1] ?? '').get('status') ?? '';
  const [res, settings, reviews] = await Promise.all([get(`/v1/leads${filter ? `?status=${filter}` : ''}`), get('/v1/settings'), get('/v1/review-requests')]);
  const chips = h('div', { class: 'row wrap', style: 'gap:8px' }, [['', 'All open'], ...LEAD_STAGES].map(([k, label]) => h('a', { class: `dp-btn dp-btn--${filter === k ? 'secondary' : 'ghost'}`, href: `#/leads${k ? `?status=${k}` : ''}` }, k ? `${label} (${res.counts[k] ?? 0})` : label)));
  const rows = (filter ? res.data : res.data.filter((l) => !['member', 'lost'].includes(l.status))).map((l) => {
    const stage = select(LEAD_STAGES, { value: l.status, 'aria-label': 'Stage' });
    const notes = h('textarea', { class: 'dp-input', placeholder: 'Notes: when you called, what they need, best times' }); notes.value = l.notes ?? '';
    const save = (body, msg) => (e) => busy(e.currentTarget, async () => { await patch(`/v1/leads/${l.id}`, body); toast(msg); render(); });
    return h('details', { class: 'list-item', style: 'display:block' },
      h('summary', { style: 'cursor:pointer;list-style:none' }, h('div', { class: 'row wrap', style: 'gap:12px' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, l.parent_name, l.athlete_name ? h('span', { class: 'muted' }, ` for ${l.athlete_name}${l.athlete_age ? `, ${l.athlete_age}` : ''}`) : null),
          h('span', { class: 'small muted' }, [LEAD_SOURCE[l.source], l.sport, ago(l.created_at), l.follow_up === 'on' ? `next follow-up ${date(l.next_follow_up_at)}` : null].filter(Boolean).join(' · '))),
        h('span', { class: `dp-badge dp-badge--${{ new: 'warn', contacted: 'neutral', signed_up: 'good', evaluation: 'good', member: 'good', lost: 'muted' }[l.status]}` }, LEAD_STAGES.find(([k]) => k === l.status)?.[1] ?? l.status))),
      h('div', { class: 'stack', style: 'margin-top:12px' },
        h('p', { class: 'small', style: 'margin:0' }, [l.email, phoneText(l.phone), l.texts_ok ? 'OK to text' : null].filter(Boolean).join(' · ')),
        l.message ? h('p', { class: 'small muted', style: 'white-space:pre-wrap;margin:0' }, `"${l.message}"`) : null,
        l.family_id ? h('p', { class: 'small', style: 'margin:0' }, `Signed up as the ${l.family_name ?? 'family'}.`) : null,
        field('Notes', notes),
        h('div', { class: 'row wrap', style: 'gap:8px' }, stage,
          btn('Save', save({ status: stage.value, notes: notes.value }, 'Saved.'), 'primary'),
          ['new', 'contacted'].includes(l.status) ? btn('I reached out', save({ contacted: true, notes: notes.value }, 'Marked as contacted.'), 'outline') : null,
          l.follow_up === 'on' ? btn('Stop automatic follow-up', save({ follow_up: false }, 'Automatic follow-up stopped.'), 'ghost') : null,
          isOwner() ? btn('Delete', (e) => { if (confirm(`Delete ${l.parent_name}'s details?`)) busy(e.currentTarget, async () => { await api('DELETE', `/v1/leads/${l.id}`); toast('Deleted.'); render(); }); }, 'ghost') : null)));
  });
  const f = { parent_name: input(), email: input({ type: 'email' }), phone: input({ type: 'tel' }), athlete_name: input(), athlete_age: input({ type: 'number', inputmode: 'numeric' }), sport: input(), message: h('textarea', { class: 'dp-input' }) };
  const source = select([['phone', 'Phone call'], ['walk_in', 'Walk-in'], ['event', 'Event'], ['referral', 'Referral'], ['manual', 'Other']]);
  const followUp = h('input', { type: 'checkbox', checked: true });
  const addPanel = h('details', { class: 'dp-panel' }, h('summary', { class: 'strong', style: 'cursor:pointer;min-height:32px' }, '+ Add a lead'),
    h('form', { class: 'stack', style: 'margin-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      await post('/v1/leads', { ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value || undefined])), athlete_age: f.athlete_age.value ? Number(f.athlete_age.value) : undefined, source: source.value, follow_up: followUp.checked });
      toast('Lead added.'); render();
    }); } },
      h('div', { class: 'form-grid' }, field('Parent name', f.parent_name), field('How they found you', source)),
      h('div', { class: 'form-grid' }, field('Email', f.email), field('Phone', f.phone)),
      h('div', { class: 'form-grid' }, field('Athlete name', f.athlete_name), field('Athlete age', f.athlete_age)),
      field('Sport', f.sport), field('What they\'re looking for', f.message),
      h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, followUp, h('span', null, 'Send the automatic follow-up emails')),
      h('div', null, btn('Add lead', null, 'primary', { type: 'submit' }))));
  const followToggle = h('input', { type: 'checkbox', checked: settings.lead_follow_up !== 'off' });
  const howPanel = panel('How follow-up works', { subtitle: 'Every lead with an email gets a thank-you with your sign-up link right away, a nudge after 2 days and a last note after 7. It stops as soon as they sign up, you mark them, or they reply STOP to a text.' },
    h('div', { class: 'row wrap', style: 'gap:12px' }, h('code', { style: 'font-size:15px' }, `${location.origin}/start`),
      btn('Copy inquiry form link', async () => { await navigator.clipboard?.writeText(`${location.origin}/start`).catch(() => {}); toast('Link copied. Put it on your website and Instagram.'); }, 'secondary')),
    isOwner() ? h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, followToggle, h('span', null, 'Send automatic follow-up'), btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { lead_follow_up: followToggle.checked ? 'on' : 'off' }); toast('Saved.'); }), 'ghost')) : null);
  // The public Book now page, for the website and Instagram bio.
  const embedCode = `<script src="${location.origin}/embed.js" async></script>`;
  const copy = (text, msg) => async () => { await navigator.clipboard?.writeText(text).catch(() => {}); toast(msg); };
  const schedToggle = h('input', { type: 'checkbox', checked: settings.public_schedule !== 'off' });
  const bookPanel = panel('Book now page', { subtitle: 'Your upcoming classes with open spots and the next evaluation times, for your website, Instagram bio and Google profile. Families sign in (or sign up) to book. No names are shown.' },
    h('div', { class: 'row wrap', style: 'gap:12px' }, h('code', { style: 'font-size:15px' }, `${location.origin}/book`),
      btn('Copy link', copy(`${location.origin}/book`, 'Link copied. Put it in your Instagram bio and on Google.'), 'secondary'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: '/book', target: '_blank', rel: 'noopener' }, 'Open it')),
    h('div', { class: 'dp-label', style: 'margin-top:8px' }, 'Show the schedule on your website'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Paste this where the schedule should appear (in Squarespace or Wix, use a Code or Embed block). For a single "Book now" button instead, add data-button="Book now" inside the tag.'),
    h('div', { class: 'row wrap', style: 'gap:12px' }, h('code', { class: 'small', style: 'word-break:break-all' }, embedCode), btn('Copy code', copy(embedCode, 'Code copied. Paste it into your website.'), 'secondary')),
    isOwner() ? h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, schedToggle, h('span', null, 'Show the Book now page'), btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { public_schedule: schedToggle.checked ? 'on' : 'off' }); toast('Saved.'); }), 'ghost')) : null);
  // Google review requests: one friendly email after a 10th session or a personal best.
  const reviewUrl = input({ type: 'url', placeholder: 'https://g.page/r/.../review', value: reviews.review_url, 'aria-label': 'Google review link' });
  const reviewOn = h('input', { type: 'checkbox', checked: reviews.on });
  const r90 = reviews.last_90_days;
  const REVIEW_WHY = { milestone: (x) => `${x.detail}`, pr: (x) => `personal best${x.detail ? ` (${x.detail})` : ''}` };
  const reviewPanel = panel('Google review requests', { subtitle: 'After an athlete\'s 10th session, or a personal best on a testing day the family can see, we email the parent once asking for a Google review. At most once every 6 months per family, never to a family behind on a payment, and only between 10 am and 7 pm.' },
    !reviews.review_url ? h('p', { class: 'warn-text', style: 'margin:0' }, 'Off until you add your Google review link. Find it in your Google Business Profile under "Ask for reviews".') :
      h('p', { style: 'margin:0' }, `Last 90 days: ${r90.sent} asked, ${r90.clicked} opened the review page${r90.stopped ? `, ${r90.stopped} asked us to stop` : ''}.`),
    isOwner() ? h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      try { await patch('/v1/settings', { review_url: reviewUrl.value, review_requests: reviewOn.checked ? 'on' : 'off' }); toast('Saved.'); render(); } catch (err) { toast(err.message, 'warn'); }
    }); } },
      field('Google review link', reviewUrl),
      h('div', { class: 'row wrap', style: 'gap:12px' }, h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, reviewOn, h('span', null, 'Send review requests')), btn('Save', null, 'secondary', { type: 'submit' }))) : null,
    reviews.recent.length ? h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'Recent'), ...reviews.recent.map((x) => h('div', { class: 'row small', style: 'gap:10px' },
      h('span', { class: 'grow' }, `${x.family_name ?? 'Deleted family'} · ${x.athlete_name ?? ''}: ${REVIEW_WHY[x.reason](x)}`), h('span', { class: 'muted' }, ago(x.sent_at)),
      x.opted_out_at ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Stop asking') : x.clicked_at ? h('span', { class: 'dp-badge dp-badge--good' }, 'Opened') : h('span', { class: 'dp-badge dp-badge--neutral' }, 'Sent')))) : null,
    h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:32px' }, 'See the email'),
      h('p', { class: 'strong small', style: 'margin:8px 0 4px' }, reviews.sample.subject), h('p', { class: 'small muted', style: 'white-space:pre-wrap;margin:0' }, reviews.sample.text)));
  fill(main, header('Leads', `${res.last_30_days.leads} ${res.last_30_days.leads === 1 ? 'family' : 'families'} asked about training in the last 30 days; ${res.last_30_days.signed_up} signed up.`, isOwner() ? h('a', { class: 'dp-btn dp-btn--secondary', href: '#/leads/campaigns' }, 'Email a group') : null),
    chips, panel(null, {}, rows.length ? rows : h('p', { class: 'muted' }, filter ? 'No leads at this stage.' : 'No open leads. Share your inquiry form link to start collecting them.')), addPanel, howPanel, bookPanel, reviewPanel);
}

// ---------- Announcement emails ----------
const GROUPS = [['everyone', 'All families'], ['members', 'Members'], ['lapsed', 'Lapsed members (canceled in the last year)'], ['no_membership', 'Families without a membership'], ['leads', 'Families who asked about training']];
async function viewCampaigns(main) {
  const [{ data }, settings] = await Promise.all([get('/v1/campaigns'), get('/v1/settings')]);
  let editing = null, reach = null;
  const f = { subject: input({ maxlength: '120', placeholder: 'Summer camp registration is open' }), body: h('textarea', { class: 'dp-input', rows: '10', placeholder: 'Hi {first_name},\n\nSummer camp runs June 9 to 13...' }),
    group: select(GROUPS, { 'aria-label': 'Who it goes to' }), age_min: input({ type: 'number', min: '3', max: '99', inputmode: 'numeric', placeholder: 'Any', style: 'width:90px' }), age_max: input({ type: 'number', min: '3', max: '99', inputmode: 'numeric', placeholder: 'Any', style: 'width:90px' }), sport: input({ placeholder: 'Any sport' }) };
  const audience = () => ({ group: f.group.value, age_min: f.age_min.value || null, age_max: f.age_max.value || null, sport: f.sport.value || undefined });
  const body = () => ({ subject: f.subject.value, body: f.body.value, audience: audience() });
  const reachBox = h('p', { class: 'small', style: 'margin:0' }), err = h('div', { class: 'dp-error', role: 'alert' });
  const sendBtn = btn('Send', (e) => send(e.currentTarget), 'primary');
  let t;
  const refreshReach = () => { clearTimeout(t); t = setTimeout(async () => {
    try { reach = await post('/v1/campaigns/preview', { audience: audience() }); reachBox.className = 'small'; fill(reachBox, h('span', { class: 'strong' }, `Goes to ${reach.count} ${reach.count === 1 ? 'person' : 'people'}`), reach.sample.length ? `: ${reach.sample.join(', ')}${reach.count > reach.sample.length ? ' and more' : ''}.` : '.'); sendBtn.textContent = `Send to ${reach.count}`; sendBtn.disabled = !reach.count; }
    catch (e) { reach = null; reachBox.className = 'small warn-text'; reachBox.textContent = e.message; sendBtn.disabled = true; }
  }, 250); };
  for (const el of [f.group, f.age_min, f.age_max, f.sport]) { el.addEventListener('input', refreshReach); el.addEventListener('change', refreshReach); }
  const save = async () => { editing = editing ? await patch(`/v1/campaigns/${editing.id}`, body()) : await post('/v1/campaigns', body()); return editing; };
  async function send(button) {
    err.textContent = '';
    if (!reach?.count) return;
    if (!confirm(`Send "${f.subject.value}" to ${reach.count} ${reach.count === 1 ? 'person' : 'people'} now? This can't be undone.`)) return;
    await busy(button, async () => {
      try { const c = await save(); const r = await post(`/v1/campaigns/${c.id}/send`, { confirm_count: reach.count }); toast(`Sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.`); editing = null; render(); }
      catch (e) { err.textContent = e.message; }
    });
  }
  const load = (c) => { editing = c.status === 'draft' ? c : null; f.subject.value = c.subject; f.body.value = c.body; f.group.value = c.audience.group; f.age_min.value = c.audience.age_min ?? ''; f.age_max.value = c.audience.age_max ?? ''; f.sport.value = c.audience.sport ?? ''; refreshReach(); main.scrollIntoView({ behavior: 'smooth' }); };
  const compose = panel('New email', { subtitle: 'For news every family should hear: camp registration, a closure, a new class. Receipts and booking emails go out on their own. Write {first_name} for the parent\'s first name. Links are counted when clicked, and every email ends with your address and a "stop these emails" link.' },
    settings.business_address ? null : h('p', { class: 'warn-text', style: 'margin:0' }, 'Add your mailing address in Schedule → Hours & settings first. US law (CAN-SPAM) requires it at the bottom of announcement emails.'),
    field('Subject', f.subject), field('Message', f.body),
    h('div', { class: 'form-grid' }, field('Who it goes to', f.group), field('Sport (optional)', f.sport)),
    h('div', { class: 'row wrap', style: 'gap:12px' }, field('Athlete age from', f.age_min), field('to', f.age_max)),
    reachBox, err,
    h('div', { class: 'row wrap', style: 'gap:8px' }, sendBtn,
      btn('Send me a test', (e) => busy(e.currentTarget, async () => { err.textContent = ''; try { const c = await save(); const r = await post(`/v1/campaigns/${c.id}/test`); toast(`Test sent to ${r.sent_to}.`); } catch (x) { err.textContent = x.message; } }), 'secondary'),
      btn('Save draft', (e) => busy(e.currentTarget, async () => { err.textContent = ''; try { await save(); toast('Draft saved.'); render(); } catch (x) { err.textContent = x.message; } }), 'ghost')));
  const rows = data.map((c) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('span', { class: 'strong' }, c.subject), h('span', { class: 'small muted' }, `${c.audience_text} · ${c.status === 'draft' ? `draft, ${ago(c.created_at)}` : `sent ${date(c.sent_at)}`}`)),
    c.status === 'draft' ? h('span', { class: 'dp-badge dp-badge--neutral' }, 'Draft') : h('span', { class: 'small' }, `${c.sent} sent · ${c.clicked} clicked${c.stopped ? ` · ${c.stopped} stopped` : ''}`),
    c.status === 'draft' ? btn('Edit', () => load(c), 'ghost') : btn('Copy', (e) => busy(e.currentTarget, async () => load(await post(`/v1/campaigns/${c.id}/copy`))), 'ghost'),
    c.status === 'draft' ? btn('Delete', (e) => { if (confirm('Delete this draft?')) busy(e.currentTarget, async () => { await api('DELETE', `/v1/campaigns/${c.id}`); render(); }); }, 'ghost') : null));
  fill(main, header('Email a group', 'Announcements to families, narrowed by membership, age and sport.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/leads' }, 'Back to leads')),
    compose, panel('Sent and drafts', {}, rows.length ? rows : h('p', { class: 'muted' }, 'Nothing sent yet.')));
  refreshReach();
}

// ---------- Clients ----------
// "Active" means the same as the Today tile: not archived, paid up or on a free trial. Archived clients only show
// under the Archived filter (or as a hint when a search only finds archived ones).
// Views over the client list, the same as the server's ?status= (clients.js#inView). Archived clients are their own view.
const CLIENT_VIEWS = [['', 'All'], ['current', 'Active'], ['active', 'Paying'], ['trialing', 'Trial'], ['past_due', 'Past due'], ['paused', 'Paused'], ['canceled', 'Canceled'], ['none', 'No plan'], ['team', 'Team only'], ['no_waiver', 'No waiver'], ['archived', 'Archived']];
const inClientView = (c, view) => (view === 'archived' ? !!c.archived_at : !c.archived_at && (!view || (view === 'current' ? ['active', 'trialing'].includes(c.status)
  : view === 'team' ? c.teams?.length > 0 && ['none', 'canceled'].includes(c.status) : view === 'no_waiver' ? !!c.flags?.no_waiver : c.status === view)));
// Search: name, Athlete ID, email, family, school, parents; phone numbers on their digits too (clients.js#matches).
const digitsOf = (x) => String(x ?? '').replace(/\D/g, '');
const clientMatches = (c, q) => {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  if ([c.name, c.email, c.athlete_id, c.family?.name, c.school, c.phone, ...(c.parents ?? []).flatMap((p) => [p.name, p.email, p.phone])].filter(Boolean).join(' ').toLowerCase().includes(s)) return true;
  const d = digitsOf(s);
  return /^[\d\s().+-]+$/.test(s) && d.length >= 4 && [c.phone, ...(c.parents ?? []).map((p) => p.phone)].some((p) => digitsOf(p).includes(d));
};
const CLIENT_SORTS = [['name', 'Name'], ['last_seen', 'Longest since seen'], ['newest', 'Newest']];
const clientsUi = { q: '', view: null, sort: 'name', shown: 100 };
const clientFlags = (c) => [
  c.flags?.medical ? h('span', { class: 'dp-badge dp-badge--warn' }, 'Medical') : null,
  c.flags?.no_waiver ? h('span', { class: 'dp-badge dp-badge--neutral' }, 'No waiver') : null,
  c.flags?.no_card && c.family ? h('span', { class: 'dp-badge dp-badge--muted' }, 'No card') : null,
  c.pinned_notes ? h('span', { class: 'dp-badge dp-badge--good' }, c.pinned_notes === 1 ? 'Pinned note' : `${c.pinned_notes} pinned notes`) : null];

async function viewClients(main) {
  let data;
  try { ({ data } = await get('/v1/clients?archived=all')); }
  catch (e) {
    return fill(main, header('Clients', null, addClientBtn()),
      panel('The client list didn\'t load', { subtitle: e.message }, h('div', { class: 'row' }, btn('Try again', (ev) => busy(ev.currentTarget, () => viewClients(main)), 'secondary'))));
  }
  const start = hashQuery().get('status');
  if (start != null && CLIENT_VIEWS.some(([k]) => k === start)) clientsUi.view = start;
  if (clientsUi.view == null) clientsUi.view = '';
  const count = (k) => data.filter((c) => inClientView(c, k)).length;
  const q = input({ type: 'search', placeholder: 'Name, athlete ID, email, family or phone', id: 'client-search', 'aria-label': 'Search clients', value: clientsUi.q, autocomplete: 'off' });
  const sort = select(CLIENT_SORTS, { 'aria-label': 'Sort clients', style: 'width:auto;min-width:170px', value: clientsUi.sort });
  const views = h('div', { class: 'row wrap tm-views', role: 'group', 'aria-label': 'Which clients' });
  const body = h('tbody');
  const hint = h('p', { class: 'small muted', style: 'margin:0' });
  const more = h('div', { class: 'row' });
  const shownRows = () => {
    const rows = data.filter((c) => clientMatches(c, clientsUi.q) && inClientView(c, clientsUi.view));
    if (clientsUi.sort === 'last_seen') rows.sort((a, b) => (a.last_seen_at ?? '').localeCompare(b.last_seen_at ?? '') || a.name.localeCompare(b.name));
    else if (clientsUi.sort === 'newest') rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return rows;
  };
  const open = (c) => { location.hash = `#/clients/${c.id}`; };
  const draw = () => {
    const rows = shownRows(), s = clientsUi.q.trim();
    // Always offer All, Active and Archived; the other views only when someone is in them.
    fill(views, CLIENT_VIEWS.filter(([k]) => ['', 'current', 'archived'].includes(k) || count(k) || clientsUi.view === k).map(([k, label]) =>
      h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(clientsUi.view === k), onClick: () => { clientsUi.view = k; clientsUi.shown = 100; draw(); } }, label, h('span', { class: 'muted' }, String(count(k))))));
    const hidden = clientsUi.view === 'archived' ? 0 : data.filter((c) => c.archived_at && clientMatches(c, s)).length;
    fill(hint, s && hidden ? [`${hidden} archived ${hidden === 1 ? 'client matches' : 'clients match'} too. `, h('a', { href: '#/clients?status=archived', onClick: (e) => { e.preventDefault(); clientsUi.view = 'archived'; draw(); } }, 'Show archived')] : null);
    fill(body, ...(rows.length ? rows.slice(0, clientsUi.shown).map((c) => h('tr', { class: 'link', tabindex: '0', onClick: () => open(c), onKeydown: (e) => { if (e.key === 'Enter') open(c); } },
      h('td', null, h('div', { class: 'stack-tight' },
        h('span', { class: 'row wrap', style: 'gap:6px' }, h('span', { class: 'strong' }, c.name), ...clientFlags(c)),
        h('span', { class: 'small muted' }, h('span', { style: 'font-family:var(--font-mono)' }, c.athlete_id ?? ''), [c.family ? c.family.name : c.email, c.grad_year ? `Class of ${c.grad_year}` : null, c.teams?.length ? c.teams.map((t) => t.name).join(', ') : null].filter(Boolean).map((x) => ` · ${x}`).join('')))),
      h('td', null, h('div', { class: 'stack-tight', style: 'align-items:flex-start' }, c.archived_at ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Archived') : badge(c.status), c.subscription?.plan_name ? h('span', { class: 'small muted' }, c.subscription.plan_name) : null)),
      h('td', { class: 'cl-program' }, c.program?.name ?? h('span', { class: 'muted' }, 'None')),
      h('td', { class: 'muted' }, ago(c.last_seen_at))))
      : [h('tr', null, h('td', { colspan: '4', class: 'muted' }, data.length ? (clientsUi.view === 'archived' && !s ? 'No archived clients.' : s ? `No clients match "${s}". Check the spelling, or clear the search.` : 'Nobody in this view.') : 'No clients yet. Add your first one.'))]));
    fill(more, rows.length > clientsUi.shown ? [h('span', { class: 'small muted grow' }, `Showing ${clientsUi.shown} of ${rows.length}.`), btn('Show 100 more', () => { clientsUi.shown += 100; draw(); }, 'secondary')] : null);
  };
  q.addEventListener('input', () => { clientsUi.q = q.value; clientsUi.shown = 100; draw(); });
  // Enter opens the only match of what's typed; Escape clears the search.
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) { e.preventDefault(); q.value = clientsUi.q = ''; draw(); }
    if (e.key === 'Enter') { const rows = shownRows(); if (rows.length === 1) open(rows[0]); else if (rows.length) toast(`${rows.length} clients match. Keep typing, or pick one.`, 'warn'); }
  });
  sort.addEventListener('change', () => { clientsUi.sort = sort.value; draw(); });
  draw();
  const current = count('current'), archived = count('archived');
  const csv = isOwner() ? btn('Download CSV', (e) => busy(e.currentTarget, async () => {
    const p = new URLSearchParams({ sort: clientsUi.sort });
    if (clientsUi.q.trim()) p.set('q', clientsUi.q.trim());
    if (clientsUi.view === 'archived') p.set('archived', 'true'); else if (clientsUi.view) p.set('status', clientsUi.view);
    await download(`/v1/client-export?${p}`);
  }), 'secondary', { title: 'The clients in this view, with contact details. No amounts.' }) : null;
  fill(main,
    header('Clients', `${current} active · ${data.length - archived} on the list${archived ? ` · ${archived} archived` : ''}.`, h('div', { class: 'row wrap' }, state.user.role !== 'front_desk' ? h('a', { class: 'dp-btn dp-btn--secondary', href: '#/clients/import' }, 'Import') : null, csv, addClientBtn())),
    panel(null, {}, views, h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: 'min-width:200px' }, q), sort), hint,
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Client', 'Membership', 'Program', 'Last seen'].map((t) => h('th', { class: t === 'Program' ? 'cl-program' : null }, t)))), body)), more));
  if (clientsUi.q) q.focus();
}

// Unsaved profile edits, kept per client while other actions on the page redraw it, and asked about before leaving.
const profileDrafts = new Map();
const telHref = (p) => `tel:${String(p ?? '').replace(/[^\d+]/g, '')}`;
const smsHref = (p) => `sms:${String(p ?? '').replace(/[^\d+]/g, '')}`;
const OUTCOME = { attended: ['Came', 'good'], walk_in: ['Walk-in', 'good'], no_show: ['No-show', 'warn'], late_cancel: ['Late cancel', 'neutral'], in_progress: ['Happening now', 'muted'] };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function viewClient(main, id) {
  if (id === 'new') return viewNewClient(main);
  if (id === 'import') return viewImport(main);
  const [c, plans, progs, inv, logs, locs, sales, visits, upcoming, settings, perfData, devLinks] = await Promise.all([get(`/v1/clients/${id}`), get('/v1/plans'), get('/v1/programs'), get(`/v1/clients/${id}/invoices`), get(`/v1/clients/${id}/workouts`), get('/v1/locations'), get(`/v1/sales?client_id=${id}`), get(`/v1/check-ins?client_id=${id}`), get(`/v1/clients/${id}/bookings`), get('/v1/settings'), get(`/v1/clients/${id}/performance`), state.user?.role === 'front_desk' ? { data: [] } : get(`/v1/athlete-links?client_id=${id}`)]);   // front desk doesn't link devices
  const [en, testLib, owed, products, badgeLib, notesList, att, famList] = await Promise.all([get(`/v1/clients/${id}/engagement`), get('/v1/tests'), isOwner() ? get(`/v1/clients/${id}/owed`) : null, isOwner() ? get('/v1/products') : null, get('/v1/skill-badges'), get(`/v1/clients/${id}/notes`), get(`/v1/clients/${id}/attendance`), !c.family && state.user.role !== 'front_desk' ? get('/v1/families').catch(() => null) : null]);
  const eng = clientPanels(c, en, testLib.data, badgeLib.data);
  const [reqList, claimList] = isOwner() ? await Promise.all([get(`/v1/membership-requests?client_id=${id}&status=all`).catch(() => ({ data: [] })), get('/v1/profile-claims').catch(() => ({ data: [] }))]) : [{ data: [] }, { data: [] }];
  const [requestsPanel, mergePanel] = isOwner() ? profilePanels(c, reqList.data, claimList.data) : [null, null];
  tzName = settings.timezone;
  const fam = c.family;
  const sub = c.subscription;
  const first = c.name.split(' ')[0];
  const role = state.user.role;
  const act = (path, msg, body) => (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/subscription/${path}`, body); toast(msg); render(); });
  const sectionId = (el, key) => { if (el) el.id = `cl-${key}`; return el; };

  const planSel = select(plans.data.map((p) => [p.id, `${p.name}${p.price_cents == null ? '' : `, ${money(p.price_cents)}/mo`}`]), { value: sub?.plan_id, 'aria-label': 'Plan' });
  const membership = panel('Membership', { subtitle: sub ? null : 'No active plan.' },
    sub ? h('dl', { class: 'dl' },
      h('div', null, h('dt', null, 'Status'), h('dd', null, badge(sub.status))),
      h('div', null, h('dt', null, 'Plan'), h('dd', null, sub.plan_name)),
      sub.price_cents == null ? null : h('div', null, h('dt', null, 'Monthly'), h('dd', null, money(sub.price_cents))),
      h('div', null, h('dt', null, sub.status === 'trialing' ? 'Trial ends' : 'Next charge'), h('dd', null, ['canceled', 'paused'].includes(sub.status) ? '—' : date(sub.current_period_end)))) : null,
    sub && sub.status !== 'canceled' ? h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, planSel), btn('Change plan', (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/subscription/plan`, { plan_id: planSel.value }); toast('Plan changed. New price applies from the next charge.'); render(); }), 'secondary')),
      h('div', { class: 'row wrap' },
        sub.status === 'paused' ? btn('Resume subscription', act('resume', 'Subscription resumed and charged.'), 'secondary') : btn('Pause subscription', act('pause', 'Subscription paused. No charges and no app access until resumed.'), 'secondary'),
        btn('Cancel subscription', (e) => { if (confirm(`Cancel ${first}'s subscription now? Open invoices will be voided.`)) act('cancel', 'Subscription canceled.')(e); }, 'ghost')))
      : c.archived_at ? null : h('div', { class: 'row' }, h('div', { class: 'grow' }, planSel), btn('Start subscription', (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/subscription`, { plan_id: planSel.value }); toast('Subscription started.'); render(); }), 'secondary')));

  const payments = panel('Payments', {}, inv.data.length ? inv.data.map((i) => h('div', { class: 'list-item' },
    h('div', { class: 'grow stack-tight' }, h('span', null, `${i.amount_cents == null ? '' : `${money(i.amount_cents)} · `}${date(i.period_start)} to ${date(i.period_end)}`), i.last_error && i.status === 'failed' ? h('span', { class: 'small warn-text' }, `${i.last_error} Tried ${i.attempts}×.`) : null),
    badge(i.status),
    i.status === 'failed' ? btn('Retry charge', (e) => busy(e.currentTarget, async () => { const r = await post(`/v1/invoices/${i.id}/retry`); r.status === 'paid' ? toast('Charge retried. Payment succeeded.') : toast('Charge declined again.', 'warn'); render(); }), 'outline') : null))
    : h('p', { class: 'muted' }, sub?.status === 'trialing' ? `No charges yet. The first charge happens when the trial ends on ${date(sub.trial_ends_at)}.` : 'No invoices yet.'));

  const payLinks = owed ? payLinksPanel(id, first, owed, products.data, render) : null;

  const progSel = select([['', 'Choose a program'], ...progs.data.map((p) => [p.id, p.name])], { value: c.program?.id ?? '', 'aria-label': 'Program' });
  const appUrl = location.origin + c.app_link;
  const appTo = [c.email, ...(fam?.guardians ?? []).map((g) => g.email)].filter(Boolean);
  const training = panel('Training', { subtitle: c.program ? `On ${c.program.name}. ${plural(c.workouts_completed, 'workout')} logged.` : 'No program assigned yet.' },
    role === 'front_desk' ? null : h('div', { class: 'row' }, h('div', { class: 'grow' }, progSel), btn(c.program ? 'Switch program' : 'Assign program', (e) => busy(e.currentTarget, async () => {
      if (!progSel.value) throw new Error('Choose a program first.');
      if (c.program && c.program.id !== progSel.value && !confirm(`Move ${first} off ${c.program.name} and onto ${progSel.selectedOptions[0].textContent}? Their logged workouts stay.`)) return;
      await post(`/v1/programs/${progSel.value}/assign`, { client_id: id }); toast(`Program assigned to ${first}.`); render();
    }), 'secondary')),
    h('div', { class: 'stack-tight' }, h('span', { class: 'dp-label' }, 'Private app link'), h('span', { class: 'small muted' }, `${first}'s workouts, check-ins and progress. Anyone with the link can open it.`)),
    h('div', { class: 'row wrap' },
      !c.archived_at && appTo.length ? btn('Email app link', (e) => busy(e.currentTarget, async () => { const r = await post(`/v1/clients/${id}/app-link/email`); toast(`App link emailed to ${r.sent_to.join(' and ')}.`); }), 'secondary', { title: `Sends it to ${appTo.join(', ')}` }) : null,
      btn('Copy app link', async () => { await navigator.clipboard.writeText(appUrl); toast('App link copied.'); }, 'outline'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: c.app_link, target: '_blank', rel: 'noopener' }, 'Open app'),
      role === 'front_desk' ? null : btn('Reset link', (e) => { if (confirm('Issue a new link? The current one stops working.')) busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/app-link`); toast('New app link issued.'); render(); }); }, 'ghost')),
    logs.data.length ? h('div', null, logs.data.slice(0, 5).map(workoutRow)) : null);

  // Profile form. Edits are kept in profileDrafts, so a redraw (a note saved, a check-in) doesn't lose them, and
  // leaving the page asks first.
  const draft = profileDrafts.get(id) ?? {};
  const orig = { name: c.name, email: c.email ?? '', phone: c.phone ?? '', sex: c.sex ?? '', athlete_id: c.athlete_id ?? '', birth_date: c.birth_date ?? '', sport: c.sport ?? '', position: c.position ?? '', school: c.school ?? '', grad_year: c.grad_year == null ? '' : String(c.grad_year),
    emergency_name: c.emergency_name ?? '', emergency_phone: c.emergency_phone ?? '', medical_notes: c.medical_notes ?? '', notes: c.notes ?? '' };
  const val = (k) => draft[k] ?? orig[k];
  const f = {
    name: input({ value: val('name'), autocomplete: 'off' }), email: input({ type: 'email', value: val('email'), autocomplete: 'off' }), phone: input({ type: 'tel', value: val('phone'), autocomplete: 'off' }),
    sex: select([['', 'Not set'], ['M', 'Male'], ['F', 'Female']], { value: val('sex') }), athlete_id: input({ value: val('athlete_id'), style: 'font-family:var(--font-mono);text-transform:uppercase', autocomplete: 'off' }),
    birth_date: input({ type: 'date', value: val('birth_date'), max: bizDate() }), sport: input({ value: val('sport') }), position: input({ value: val('position') }), school: input({ value: val('school') }),
    grad_year: input({ type: 'number', inputmode: 'numeric', min: '2000', max: '2060', value: val('grad_year') }),
    emergency_name: input({ value: val('emergency_name') }), emergency_phone: input({ type: 'tel', value: val('emergency_phone') }),
    medical_notes: h('textarea', { class: 'dp-input' }), notes: h('textarea', { class: 'dp-input' })
  };
  f.medical_notes.value = val('medical_notes'); f.notes.value = val('notes');
  const unsaved = h('span', { class: 'dp-badge dp-badge--warn', role: 'status', style: 'display:none' }, 'Unsaved changes');
  const saveBtn = btn('Save changes', null, 'secondary');
  const discardBtn = btn('Discard changes', () => { profileDrafts.delete(id); render(); }, 'ghost', { style: 'display:none' });
  const guard = { check: (next) => (profileDrafts.has(id) && !String(next ?? '').startsWith(`#/clients/${id}`) ? `You have unsaved changes to ${first}'s profile. Leave without saving?` : null), discard: () => profileDrafts.delete(id) };
  leaveGuard = guard;
  const isDirty = () => Object.entries(f).some(([k, el]) => el.value !== orig[k]);
  const syncDirty = () => {
    if (leaveGuard !== guard) return;                 // a late change event from a page that was just left
    const d = Object.fromEntries(Object.entries(f).filter(([k, el]) => el.value !== orig[k]).map(([k, el]) => [k, el.value]));
    if (Object.keys(d).length) profileDrafts.set(id, d); else profileDrafts.delete(id);
    const dirty = !!Object.keys(d).length;
    unsaved.style.display = discardBtn.style.display = dirty ? '' : 'none';
    saveBtn.className = `dp-btn dp-btn--${dirty ? 'primary' : 'secondary'}`;
  };
  for (const el of Object.values(f)) { el.addEventListener('input', syncDirty); el.addEventListener('change', syncDirty); }
  saveBtn.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    if (!isDirty()) return toast('Nothing to save. Change a field first.', 'warn');
    const body = {};
    for (const [k, el] of Object.entries(f)) {
      if (el.value === orig[k]) continue;
      body[k] = k === 'grad_year' ? (el.value ? Number(el.value) : null) : k === 'name' ? el.value : el.value.trim() === '' ? null : el.value;
    }
    await patch(`/v1/clients/${id}`, body);
    profileDrafts.delete(id);
    toast('Changes saved.'); render();
  }));
  const account = panel('Profile', {},
    h('div', { class: 'form-grid' }, field('Full name', f.name), field(fam ? 'Athlete email (optional)' : 'Email', f.email), field(fam ? 'Athlete phone (optional)' : 'Phone', f.phone), field('Birthday', f.birth_date)),
    h('div', { class: 'form-grid' }, field('Athlete ID', f.athlete_id, 'Connects every result, file and device to this athlete.'), field('Sex', f.sex, 'Only used for growth-spurt estimates.')),
    h('div', { class: 'form-grid' }, field('Sport', f.sport), field('Position', f.position), field('School', f.school), field('Grad year', f.grad_year)),
    field('Medical notes', f.medical_notes, 'Allergies, injuries, conditions. Parents can update these in the portal.'),
    h('div', { class: 'form-grid' }, field('Emergency contact', f.emergency_name), field('Emergency phone', f.emergency_phone)),
    field('Profile note', f.notes, 'One short note every staff member sees here. For dated notes, use Staff notes.'),
    h('div', { class: 'row wrap' }, saveBtn, discardBtn, unsaved),
    state.testMode ? h('div', { class: 'row wrap small' }, h('span', { class: 'grow muted' }, `Test card: ${c.card_status === 'declining' ? 'declines every charge' : 'charges succeed'}.`),
      btn(c.card_status === 'declining' ? 'Make card succeed' : 'Make card decline', (e) => busy(e.currentTarget, async () => { await patch(`/v1/clients/${id}`, { card_status: c.card_status === 'declining' ? 'ok' : 'declining' }); render(); }), 'ghost')) : null);
  syncDirty();

  const card = c.card.on_file
    ? h('div', { class: 'row wrap' }, h('span', { class: 'grow' }, `${(c.card.brand || 'Card').replace(/^./, (x) => x.toUpperCase())} ending ${c.card.last4 ?? '••••'}`),
        role === 'front_desk' ? null : btn('Remove card', (e) => { if (confirm('Remove the saved card? Membership renewals will fail until a new card is added.')) busy(e.currentTarget, async () => { await del(`/v1/clients/${id}/card`); toast('Card removed.'); render(); }); }, 'ghost'))
    : h('p', { class: 'muted' }, `No card saved. Save one when ${first} taps to pay, or send a secure link.`);
  const cardActions = h('div', { class: 'row wrap' },
    state.payments.provider === 'stripe' ? btn(c.card.on_file ? 'Send link to update card' : 'Copy card link for client', (e) => busy(e.currentTarget, async () => {
      const { url } = await post(`/v1/clients/${id}/card/setup-link`);
      await navigator.clipboard.writeText(url).catch(() => {});
      toast(`Secure card link copied. Send it to ${first}.`);
    }), 'outline') : null,
    state.payments.can_simulate && !c.card.on_file ? btn('Add test card', (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/card/test`); toast('Test card added.'); render(); }), 'ghost') : null);
  const locSel = select(locs.data.map((l) => [l.id, l.name]), { 'aria-label': 'Check-in location', value: (() => { try { return localStorage.getItem('dp_location'); } catch { return null; } })() || locs.data[0]?.id });
  const member = ['active', 'trialing', 'past_due'].includes(c.status);
  const sessionsPanel = panel('Card & sessions', { subtitle: `${member ? `${first} is a member (group classes included). ` : ''}${c.credits.group} group and ${plural(c.credits.private, 'private session')} left.${c.card.owner === 'family' ? ' Card belongs to the family.' : ''}` },
    card, cardActions,
    c.archived_at ? null : locs.data.length ? h('div', { class: 'row' }, h('div', { class: 'grow' }, locSel), btn('Walk-in check-in', (e) => busy(e.currentTarget, async () => {
      // Members and athletes with group credits use a group session; otherwise a private credit.
      const r = await post(`/v1/clients/${id}/check-ins`, { location_id: locSel.value, credit_type: member || c.credits.group > 0 ? 'group' : 'private' });
      toast(r.covered_by === 'membership' ? `${first} checked in.` : `${first} checked in. ${r.credits_left} ${r.credit_type} ${r.credits_left === 1 ? 'session' : 'sessions'} left.`); render();
    }), 'secondary')) : h('p', { class: 'small muted' }, 'Add a location in Point of sale setup to check clients in.'),
    h('div', { class: 'row wrap' }, h('a', { class: `dp-btn dp-btn--${c.archived_at ? 'secondary' : 'primary'}`, href: `#/sell?client=${id}` }, 'Sell to ' + first),
      role === 'front_desk' ? null : btn('Adjust sessions', (e) => {
        const t = prompt('Which kind? Type "group" or "private".', 'group'); if (!t) return;
        const type = t.trim().toLowerCase(); if (!['group', 'private'].includes(type)) return toast('Type group or private.', 'warn');
        const a = prompt(`Add or remove ${type} sessions (e.g. 2 or -1):`, '1'); if (!a) return;
        busy(e.currentTarget, async () => { const r = await post(`/v1/clients/${id}/credits`, { delta: Number(a), credit_type: type, note: 'Coach adjustment' }); toast(`${r.balance} ${type} sessions left.`); render(); });
      }, 'ghost')),
    sales.data.length || visits.data.length ? h('div', null,
      ...sales.data.slice(0, 4).map((x) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, `${x.description ?? 'Sale'} · ${x.location_name}`), badge(x.status), x.amount_cents == null ? null : h('span', { class: 'muted' }, money(x.amount_cents)))),
      ...visits.data.slice(0, 4).map((k) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, `Checked in at ${k.location_name}`), h('span', { class: 'muted' }, ago(k.created_at))))) : null);

  // Family: parents with call, text and email, fix their details, re-send the sign-in email, remove a second parent,
  // record a paper waiver, add a sibling or a parent.
  const guardianRow = (g) => {
    const wrap = h('div', { class: 'list-item', style: 'align-items:flex-start;flex-wrap:wrap' });
    const view = () => fill(wrap,
      h('div', { class: 'grow stack-tight', style: 'min-width:200px' },
        h('span', { class: 'strong' }, g.name, g.is_primary ? h('span', { class: 'small muted' }, ' (primary)') : null, g.relationship ? h('span', { class: 'small muted' }, ` · ${g.relationship}`) : null),
        h('span', { class: 'small muted' }, [g.email, g.phone ? phoneText(g.phone) : null, { on: 'Gets texts', stopped: 'Replied STOP to texts' }[g.texts]].filter(Boolean).join(' · '))),
      h('div', { class: 'row wrap', style: 'gap:4px' },
        g.phone ? h('a', { class: 'dp-btn dp-btn--ghost', href: telHref(g.phone) }, 'Call') : null,
        g.phone ? h('a', { class: 'dp-btn dp-btn--ghost', href: smsHref(g.phone) }, 'Text') : null,
        h('a', { class: 'dp-btn dp-btn--ghost', href: `mailto:${g.email}` }, 'Email'),
        btn('Edit', edit, 'ghost'),
        btn('Send sign-in email', (e) => busy(e.currentTarget, async () => { const r = await post(`/v1/families/${fam.id}/guardians/${g.id}/welcome`); toast(`Sign-in email sent to ${r.sent_to}.`); }), 'ghost'),
        role !== 'front_desk' && fam.guardians.length > 1 ? btn('Remove', (e) => { if (confirm(`Remove ${g.name} from the ${fam.name}? Their portal sign-in stops working now.`)) busy(e.currentTarget, async () => { await del(`/v1/families/${fam.id}/guardians/${g.id}`); toast(`${g.name} removed.`); render(); }); }, 'ghost') : null));
    const edit = () => {
      const ef = { name: input({ value: g.name, autocomplete: 'off' }), email: input({ type: 'email', value: g.email, autocomplete: 'off' }), phone: input({ type: 'tel', value: g.phone ? phoneText(g.phone) : '', autocomplete: 'off' }) };
      const err = h('div', { class: 'dp-error', role: 'alert' });
      fill(wrap, h('form', { class: 'grow stack', style: 'min-width:200px', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
        const body = {};
        if (ef.name.value.trim() !== g.name) body.name = ef.name.value;
        if (ef.email.value.trim().toLowerCase() !== g.email.toLowerCase()) body.email = ef.email.value;
        if (ef.phone.value.replace(/\D/g, '').slice(-10) !== String(g.phone ?? '').replace(/\D/g, '').slice(-10)) body.phone = ef.phone.value.trim() || null;
        if (!Object.keys(body).length) return view();
        try {
          const r = await patch(`/v1/families/${fam.id}/guardians/${g.id}`, body);
          toast(`${ef.name.value.trim().split(' ')[0]}'s details saved.${body.email ? ' Send the sign-in email so they know the new address.' : ''}${r.texts_turned_off ? ' Texts are off for the new number until they turn them on in the portal.' : ''}`);
          render();
        } catch (x) { err.textContent = x.message; }
      }); } },
        h('div', { class: 'form-grid cols-3' }, field('Name', ef.name), field('Email (they sign in with it)', ef.email), field('Phone', ef.phone)), err,
        h('div', { class: 'row' }, btn('Save parent', null, 'secondary', { type: 'submit' }), btn('Cancel', view, 'ghost'))));
      ef.name.focus();
    };
    view();
    return wrap;
  };
  const gName = input({ autocomplete: 'off' }), gEmail = input({ type: 'email', autocomplete: 'off' }), gPhone = input({ type: 'tel', autocomplete: 'off' });
  const sibName = input({ autocomplete: 'off' }), sibBirth = input({ type: 'date', max: bizDate() });
  const addSibling = async (checked = true) => {
    try {
      const x = await post(`/v1/families/${fam.id}/athletes`, { name: sibName.value, birth_date: sibBirth.value || undefined, check_duplicates: checked });
      toast(`${x.name} added to ${fam.name}.`); location.hash = `#/clients/${x.id}`;
    } catch (err) {
      if (err.code !== 'possible_duplicate') throw err;
      const d = err.details.duplicates;
      if (confirm(`${err.message}\n\n${d.map((x) => `${x.name} (${x.athlete_id}${x.archived ? ', archived' : ''})`).join('\n')}\n\nAdd ${sibName.value.trim()} as a new athlete anyway?`)) await addSibling(false);
    }
  };
  const paperBy = input({ autocomplete: 'off', value: fam?.guardians[0]?.name ?? '', 'aria-label': 'Parent who signed' });
  const famData = fam && isOwner() ? h('div', { class: 'row wrap small', style: 'gap:8px' },
    btn('Download family data', (e) => busy(e.currentTarget, () => download(`/v1/families/${fam.id}/export`)), 'ghost'),
    btn('Delete family data', (e) => {
      const typed = prompt(`This deletes the ${fam.name}'s personal information: parents, athletes' profiles, medical notes, test results and cards. Payment records stay for your accounts, with no names. It can't be undone.\n\nType the family name to confirm: ${fam.name}`);
      if (!typed) return;
      busy(e.currentTarget, async () => { await del(`/v1/families/${fam.id}`, { confirm: typed }); toast('Family data deleted.'); location.hash = '#/clients'; });
    }, 'ghost')) : null;
  const openAdd = hashQuery().get('add') === 'sibling';
  const familyPanel = fam ? panel(fam.name, { subtitle: fam.waiver.signed ? `Waiver signed ${date(fam.waiver.signed_at)} by ${fam.waiver.signed_by?.split(' <')[0]}` : 'Waiver not signed yet. Parents sign it in the portal before booking.' },
      ...fam.guardians.map(guardianRow),
      fam.waiver.signed ? null : h('form', { class: 'row wrap', style: 'align-items:flex-end', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        if (!paperBy.value.trim()) throw new Error('Enter the name of the parent who signed.');
        if (!confirm(`Record that ${paperBy.value.trim()} signed the current waiver on paper today? Keep the paper copy.`)) return;
        await post(`/v1/families/${fam.id}/waiver`, { signed_by: paperBy.value }); toast('Paper waiver recorded.'); render();
      }); } }, h('div', { class: 'grow', style: 'min-width:200px' }, field('Signed on paper at the desk by', paperBy)), btn('Record paper waiver', null, 'secondary', { type: 'submit' })),
      fam.siblings.length ? h('p', { class: 'small' }, 'Siblings: ', ...fam.siblings.map((x, i) => [i ? ', ' : '', h('a', { href: `#/clients/${x.id}` }, x.name)])) : null,
      famData,
      h('details', { open: openAdd }, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Add sibling or parent'),
        h('form', { class: 'row wrap', style: 'margin-top:8px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { if (!sibName.value.trim()) throw new Error('Enter the sibling\'s full name.'); await addSibling(); }); } },
          h('div', { class: 'grow' }, field('Sibling name', sibName)), field('Birthday', sibBirth), h('div', { style: 'align-self:flex-end' }, btn('Add sibling', null, 'secondary', { type: 'submit' }))),
        h('form', { class: 'row wrap', style: 'margin-top:8px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { await post(`/v1/families/${fam.id}/guardians`, { name: gName.value, email: gEmail.value, phone: gPhone.value || undefined }); toast(`Parent added. ${gName.value.trim().split(' ')[0]} signs in with ${gEmail.value.trim()}.`); render(); }); } },
          h('div', { class: 'grow' }, field('Parent name', gName)), field('Email', gEmail), field('Phone', gPhone), h('div', { style: 'align-self:flex-end' }, btn('Add parent', null, 'secondary', { type: 'submit' })))))
    : null;

  // No family yet (a team roster athlete, or an adult): add a parent, or put them in a family you already have, so the
  // parents see them in the portal. Owners and coaches only.
  const noFamilyPanel = !fam && famList && !c.archived_at ? (() => {
    const np = { name: input({ autocomplete: 'off' }), email: input({ type: 'email', autocomplete: 'off' }), phone: input({ type: 'tel', autocomplete: 'off' }) };
    const pick = famList.data.length ? select([['', 'Choose a family'], ...famList.data.map((x) => [x.id, `${x.name}${x.guardians ? ` (${x.guardians})` : ''}`])], { 'aria-label': 'Family' }) : null;
    return panel('Family', { subtitle: `${first} isn't in a family yet. Add a parent so they can sign in to the parent portal and see ${first}'s results and team news.` },
      h('form', { class: 'row wrap', style: 'align-items:flex-end', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        if (!np.name.value.trim() || !np.email.value.trim()) throw new Error('Enter the parent\'s name and email.');
        await post(`/v1/clients/${id}/family`, { parent: { name: np.name.value, email: np.email.value, phone: np.phone.value || undefined } });
        toast(`Parent added. ${np.name.value.trim().split(' ')[0]} signs in at ${location.origin}/parent with ${np.email.value.trim()}.`); render();
      }); } }, h('div', { class: 'grow', style: 'min-width:160px' }, field('Parent name', np.name)), field('Email', np.email), field('Phone', np.phone), btn('Add parent', null, 'secondary', { type: 'submit' })),
      pick ? h('form', { class: 'row wrap', style: 'align-items:flex-end', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        if (!pick.value) throw new Error('Choose the family first.');
        const name = pick.selectedOptions[0].textContent;
        if (!confirm(`Put ${first} in ${name}? Its parents will see ${first}'s profile, results and messages in the portal.`)) return;
        await post(`/v1/clients/${id}/family`, { family_id: pick.value }); toast(`${first} is in the family now.`); render();
      }); } }, h('div', { class: 'grow', style: 'min-width:200px' }, field('Or a family you already have', pick)), btn('Put in this family', null, 'ghost', { type: 'submit' })) : null);
  })() : null;

  // Upcoming sessions: book one from here (next two weeks) and cancel (credits back, card payments refunded, waitlist moves up).
  const lateHours = Number(settings.late_cancel_hours ?? 12);
  const cancelBooking = (b) => {
    const late = b.status === 'booked' && Date.parse(b.starts_at) - Date.now() < lateHours * 3600000;
    const done = (r) => { toast(r.late ? r.message : `Canceled.${b.coverage === 'credit' ? ` ${first}'s session credit is back.` : b.coverage === 'paid' ? ' The card payment is refunded.' : ''}`); render(); };
    teamDialog(`Cancel ${first}'s ${b.status === 'waitlisted' ? 'waitlist spot' : 'booking'}?`,
      h('p', null, `${b.session_name}, ${tzFmt(b.starts_at, { weekday: 'long', month: 'short', day: 'numeric' })} at ${timeOf(b.starts_at)}.`,
        late ? ` It starts in less than ${lateHours} hours: a late cancel keeps the session used (credit or payment). You can give it back instead.` : b.coverage === 'credit' ? ' The session credit goes back.' : b.coverage === 'paid' ? ' The card payment is refunded.' : ''),
      late ? [{ label: 'Give the session back', variant: 'secondary', onClick: async () => done(await post(`/v1/bookings/${b.id}/cancel`, { waive: true })) },
        { label: 'Late cancel', variant: 'ghost', onClick: async () => done(await post(`/v1/bookings/${b.id}/cancel`, { waive: false })) }, { label: 'Keep it', variant: 'ghost' }]
        : [{ label: `Cancel ${b.status === 'waitlisted' ? 'waitlist spot' : 'booking'}`, variant: 'secondary', onClick: async () => done(await post(`/v1/bookings/${b.id}/cancel`, { waive: false })) }, { label: 'Keep it', variant: 'ghost' }]);
  };
  const bookDialog = async () => {
    const sched = (await get('/v1/schedule')).data;
    const mine = new Set(upcoming.data.map((b) => b.session_id));
    const options = sched.filter((s) => ['group', 'clinic', 'camp', 'evaluation'].includes(s.kind) && !mine.has(s.id) && Date.parse(s.starts_at) > Date.now());
    const search = input({ type: 'search', placeholder: 'Class, coach or place', 'aria-label': 'Find a session', autocomplete: 'off' });
    const pay = select([['', member || c.credits.group || c.credits.private ? 'Use the membership or a session left, otherwise pay at the session' : 'Pay at the session'], ...(c.card.on_file ? [['card_on_file', 'Charge the card on file for the drop-in']] : [])], { 'aria-label': 'How it\'s paid for' });
    const box = h('div', { class: 'stack-tight', style: 'max-height:50vh;overflow:auto' });
    const book = async (s, e, overrideAge = false) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const r = await post(`/v1/sessions/${s.id}/bookings`, { client_id: id, pay: pay.value || undefined, override_age: overrideAge || undefined });
        document.getElementById('dialog').close();
        toast(r.status === 'waitlisted' ? `${first} is on the waitlist for ${s.name}. The family is emailed if a spot opens.` : `${first} is booked for ${s.name}.${r.coverage === 'unpaid' ? ' Payment is due at the session.' : ''}`);
        render();
      } catch (x) {
        if (/This session is for ages/.test(x.message) && !overrideAge && confirm(`${x.message}\n\nBook anyway?`)) { b.disabled = false; return book(s, { currentTarget: b }, true); }
        toast(x.message, 'warn');
      } finally { b.disabled = false; }
    };
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const rows = options.filter((s) => !q || `${s.name} ${s.coach_name ?? ''} ${s.location_name}`.toLowerCase().includes(q));
      fill(box, rows.length ? rows.slice(0, 60).map((s) => {
        const full = s.booked_count >= s.capacity;
        return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
          h('div', { class: 'grow stack-tight', style: 'min-width:180px' }, h('span', { class: 'strong' }, s.name),
            h('span', { class: 'small muted' }, `${tzFmt(s.starts_at, { weekday: 'short', month: 'short', day: 'numeric' })} ${timeOf(s.starts_at)} · ${s.location_name}${s.coach_name ? ` · ${s.coach_name}` : ''} · ${full ? `full${s.waitlist_count ? `, ${s.waitlist_count} waiting` : ''}` : `${s.capacity - s.booked_count} ${s.capacity - s.booked_count === 1 ? 'spot' : 'spots'} left`}`)),
          btn(full ? 'Join waitlist' : 'Book', (e) => book(s, e), 'secondary'));
      }) : h('p', { class: 'muted' }, options.length ? `No sessions match "${search.value.trim()}".` : 'No classes, clinics, camps or evaluations with room in the next two weeks. Privates are booked from open hours in Schedule.'));
    };
    search.addEventListener('input', draw); draw();
    teamDialog(`Book a session for ${first}`, h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, 'The next two weeks. When a session is full, the booking joins the waitlist.'), search, field('How it\'s paid for', pay), box), [{ label: 'Close', variant: 'ghost' }]);
    search.focus();
  };
  const bookingsPanel = panel('Upcoming sessions', { action: c.archived_at ? null : btn('Book a session', (e) => busy(e.currentTarget, bookDialog), 'secondary') },
    upcoming.data.length ? upcoming.data.slice(0, 10).map((b) => h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
      h('a', { class: 'grow', href: `#/schedule/${b.session_id}`, style: 'color:inherit;min-width:180px' }, `${tzFmt(b.starts_at, { weekday: 'short', month: 'short', day: 'numeric' })} ${timeOf(b.starts_at)} · ${b.session_name}`),
      b.status === 'waitlisted' ? h('span', { class: 'dp-badge dp-badge--neutral' }, 'Waitlist') : coverBadge(b.coverage),
      btn('Cancel', () => cancelBooking(b), 'ghost', { 'aria-label': `Cancel ${b.session_name}` })))
      : h('p', { class: 'muted small' }, 'Nothing booked.'),
    upcoming.data.length > 10 ? h('p', { class: 'small muted' }, `And ${upcoming.data.length - 10} more. See Schedule.`) : null);

  const sum = att.summary;
  const attendancePanel = panel('Attendance', { subtitle: sum.last_visit_at ? `Last here ${ago(sum.last_visit_at).toLowerCase()}.` : 'Not checked in yet.' },
    h('div', { class: 'pulse' },
      pulseTile('Visits', sum.visits_30, 'Last 30 days'), pulseTile('No-shows', sum.no_shows_30, 'Last 30 days', { tone: sum.no_shows_30 ? 'warn' : null }),
      pulseTile('Late cancels', sum.late_cancels_30, 'Last 30 days'), pulseTile('Visits', sum.visits_90, 'Last 90 days')),
    att.recent.length ? h('div', null, att.recent.slice(0, 8).map((r) => h('div', { class: 'list-item small' },
      h('span', { class: 'grow' }, `${tzFmt(r.at, { weekday: 'short', month: 'short', day: 'numeric' })} · ${r.session_name ?? `Checked in at ${r.location_name}`}`),
      h('span', { class: `dp-badge dp-badge--${OUTCOME[r.outcome][1]}` }, OUTCOME[r.outcome][0])))) : null);

  const headline = perfData.data.filter((p) => p.headline && p.better !== 'none');
  const perfPanel = panel('Testing', { subtitle: headline.length ? 'Best result and change since the first test.' : null, action: headline.length ? h('a', { class: 'dp-btn dp-btn--secondary', href: `/report.html?client=${id}`, target: '_blank' }, 'Progress report') : h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing days') },
    headline.length ? headline.slice(0, 12).map((p) => h('div', { class: 'list-item small' },
      h('span', { class: 'grow' }, `${p.test_name}${p.side ? ` (${p.side})` : ''}`),
      h('span', { class: 'strong' }, fmtResult(p.best, p.unit, p.decimals)),
      p.tests_count > 1 ? h('span', { class: p.improved ? 'good-text' : 'muted', style: 'min-width:84px;text-align:right' }, `${p.change > 0 ? '+' : ''}${fmtResult(p.change, p.unit, p.decimals, { delta: true })}`) : h('span', { class: 'muted', style: 'min-width:84px;text-align:right' }, 'first test')))
      : h('p', { class: 'muted small' }, 'No test results yet.'),
    devLinks.data.length ? h('p', { class: 'small muted' }, 'Linked devices: ', devLinks.data.map((l) => `${l.provider} ${l.external_id.replace(/^name:/, 'name ')}`).join(', ')) : null);
  const age = c.birth_date ? Math.floor((Date.now() - Date.parse(c.birth_date)) / (365.25 * 86400000)) : null;

  // Archive: owners and coaches. Refused with a membership; upcoming bookings are canceled only after a second yes.
  const canArchive = role !== 'front_desk';
  const archive = (e) => {
    if (!confirm(`Archive ${first}? They leave the client list, search and pickers, and get no automatic emails or texts. Nothing is deleted and you can bring them back any time.`)) return;
    busy(e.currentTarget, async () => {
      try { await post(`/v1/clients/${id}/archive`); }
      catch (err) { if (err.code !== 'confirm_required' || !confirm(`${err.message}\n\nArchive and cancel them?`)) throw err; await post(`/v1/clients/${id}/archive`, { confirm: true }); }
      toast(`${first} is archived. Find them under Clients → Archived.`); render();
    });
  };
  const restore = (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/restore`); toast(`${first} is back on the client list.`); render(); });
  const pinned = notesList.data.filter((n) => n.pinned);
  // Who to call: the primary parent, or the client themselves.
  const contact = fam?.guardians[0] ?? (c.phone || c.email ? { name: c.name, phone: c.phone, email: c.email } : null);
  const contactRow = contact ? h('div', { class: 'row wrap', style: 'gap:8px' },
    h('span', { class: 'small muted' }, fam ? `${contact.name.split(' ')[0]} (parent):` : 'Contact:'),
    contact.phone ? h('a', { class: 'dp-btn dp-btn--secondary', href: telHref(contact.phone) }, 'Call') : null,
    contact.phone ? h('a', { class: 'dp-btn dp-btn--secondary', href: smsHref(contact.phone) }, 'Text') : null,
    contact.email ? h('a', { class: 'dp-btn dp-btn--secondary', href: `mailto:${contact.email}` }, 'Email') : null,
    c.emergency_phone && !c.medical_notes ? h('a', { class: 'dp-btn dp-btn--ghost', href: telHref(c.emergency_phone) }, `Emergency: ${c.emergency_name ?? 'call'}`) : null) : null;
  const teamsLine = c.teams?.length ? h('p', { class: 'small', style: 'margin:0' }, 'Team: ', ...c.teams.map((t, i) => [i ? ', ' : '', isOwner() ? h('a', { href: `#/teams/${t.id}` }, t.name) : t.name])) : null;
  const left = [[sectionId(familyPanel ?? noFamilyPanel, 'family'), 'Family'], [eng.accountability], [eng.goals], [sectionId(membership, 'membership'), 'Membership'], [sectionId(requestsPanel, 'requests'), 'Requests'], [sectionId(sessionsPanel, 'sessions'), 'Sessions'], [payments], [payLinks], [mergePanel]];
  const right = [[sectionId(staffNotesPanel(id, notesList.data), 'notes'), 'Notes'], [sectionId(bookingsPanel, 'upcoming'), 'Upcoming'], [sectionId(attendancePanel, 'attendance'), 'Attendance'], [eng.messages], [sectionId(perfPanel, 'testing'), 'Testing'], [eng.targets], [eng.badges], [eng.education], [sectionId(training, 'training'), 'Training'], [sectionId(account, 'profile'), 'Profile']];
  const jumps = [...left, ...right].filter(([el, label]) => el && label);
  fill(main,
    header(h('span', { class: 'row wrap', style: 'gap:12px;align-items:center' }, c.name, idChip(c.athlete_id), c.archived_at ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Archived') : null), [age != null ? `Age ${age}` : null, c.grad_year ? `Class of ${c.grad_year}` : null, c.sport, c.position, c.email, `client since ${date(c.created_at)}`].filter(Boolean).join(' · '),
      h('div', { class: 'row' }, canArchive && !c.archived_at ? btn('Archive', archive, 'ghost') : null, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/clients' }, 'All clients'))),
    c.archived_at ? h('div', { class: 'dp-panel row wrap', role: 'note', style: 'gap:12px;align-items:center' }, h('span', { class: 'grow' }, `Archived ${date(c.archived_at)}${c.archived_by ? ` by ${c.archived_by}` : ''}. ${first} is hidden from lists and pickers and gets no automatic emails or texts.`), canArchive ? btn(`Bring ${first} back`, restore, 'primary') : null) : null,
    c.medical_notes ? h('div', { class: 'test-banner', role: 'note' }, `Medical: ${c.medical_notes}`, c.emergency_name || c.emergency_phone ? [' · Emergency: ', c.emergency_name ?? '', ' ', c.emergency_phone ? h('a', { href: telHref(c.emergency_phone), style: 'color:inherit;text-decoration:underline' }, c.emergency_phone) : null] : null) : null,
    pinned.length ? h('div', { class: 'dp-panel stack-tight', role: 'note', style: 'border-left:3px solid var(--green-bright, #7DBA70)' }, pinned.map((n) => h('div', null, h('span', { class: 'dp-label', style: 'margin:0' }, `Pinned · ${n.author_name} · ${date(n.created_at)}${n.coach_only ? ' · Coach only' : ''}`), h('div', { style: 'white-space:pre-wrap' }, n.body)))) : null,
    contactRow || teamsLine ? h('div', { class: 'stack-tight' }, contactRow, teamsLine) : null,
    h('nav', { class: 'tm-jump', 'aria-label': 'Sections' }, jumps.map(([el, label]) => h('button', { type: 'button', onClick: () => el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, label))),
    h('div', { class: 'grid grid-2' }, h('div', { class: 'stack', style: 'gap:24px' }, left.map(([el]) => el)), h('div', { class: 'stack', style: 'gap:24px' }, right.map(([el]) => el))));
  if (openAdd) sibName.focus();
}

// Staff notes: dated, with the author. Anyone on staff adds; authors change their own; owners delete any and pin any.
// Coach-only notes never reach front desk (the server leaves them out), and front desk can't write them.
function staffNotesPanel(clientId, notes) {
  const role = state.user.role, me = state.user.id;
  const body = h('textarea', { class: 'dp-input', style: 'min-height:72px', 'aria-label': 'New note', placeholder: 'What happened, what to watch for, who to call' });
  const pin = h('input', { type: 'checkbox' }), coachOnly = h('input', { type: 'checkbox' });
  const noteRow = (n) => {
    const mine = n.author_id === me, wrap = h('div', { class: 'list-item', style: 'align-items:flex-start;flex-wrap:wrap' });
    const view = () => fill(wrap,
      h('div', { class: 'grow stack-tight', style: 'min-width:200px' },
        h('span', { class: 'small muted' }, [n.author_name, date(n.created_at), n.updated_at ? 'edited' : null].filter(Boolean).join(' · '), n.pinned ? h('span', { class: 'dp-badge dp-badge--good', style: 'margin-left:8px' }, 'Pinned') : null, n.coach_only ? h('span', { class: 'dp-badge dp-badge--neutral', style: 'margin-left:8px' }, 'Coach only') : null),
        h('div', { style: 'white-space:pre-wrap' }, n.body)),
      h('div', { class: 'row', style: 'gap:4px' },
        mine || role === 'owner' ? btn(n.pinned ? 'Unpin' : 'Pin', (e) => busy(e.currentTarget, async () => { await patch(`/v1/client-notes/${n.id}`, { pinned: !n.pinned }); render(); }), 'ghost') : null,
        mine ? btn('Edit', edit, 'ghost') : null,
        mine || role === 'owner' ? btn('Delete', (e) => { if (confirm('Delete this note?')) busy(e.currentTarget, async () => { await del(`/v1/client-notes/${n.id}`); toast('Note deleted.'); render(); }); }, 'ghost') : null));
    const edit = () => {
      const t = h('textarea', { class: 'dp-input', style: 'min-height:72px', 'aria-label': 'Edit note' }); t.value = n.body;
      const co = h('input', { type: 'checkbox', checked: n.coach_only });
      fill(wrap, h('div', { class: 'grow stack', style: 'min-width:200px' }, t,
        role === 'front_desk' ? null : h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, co, h('span', null, 'Coach only (front desk won\'t see it)')),
        h('div', { class: 'row' }, btn('Save note', (e) => busy(e.currentTarget, async () => { await patch(`/v1/client-notes/${n.id}`, { body: t.value, ...(role === 'front_desk' ? {} : { coach_only: co.checked }) }); toast('Note saved.'); render(); }), 'primary'), btn('Cancel', view, 'ghost'))));
      t.focus();
    };
    view();
    return wrap;
  };
  return panel('Staff notes', { subtitle: role === 'front_desk' ? 'Notes for everyone on staff. Coaches may also keep notes only they see.' : 'Dated notes for the team. Pinned ones show at the top of this page. Coach-only notes are hidden from front desk.' },
    notes.length ? notes.map(noteRow) : h('p', { class: 'muted small', style: 'margin:0' }, 'No notes yet.'),
    h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      if (!body.value.trim()) throw new Error('Write the note first.');
      await post(`/v1/clients/${clientId}/notes`, { body: body.value, pinned: pin.checked, ...(role === 'front_desk' ? {} : { coach_only: coachOnly.checked }) });
      toast('Note added.'); render();
    }); } }, body,
      h('div', { class: 'row wrap', style: 'gap:16px' }, h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, pin, h('span', null, 'Pin to the top')),
        role === 'front_desk' ? null : h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, coachOnly, h('span', null, 'Coach only'))),
      h('div', null, btn('Add note', null, 'secondary', { type: 'submit' }))));
}

async function viewNewClient(main) {
  const [plans, progs] = await Promise.all([get('/v1/plans'), get('/v1/programs')]);
  const canProgram = state.user.role !== 'front_desk';         // assigning programs is for coaches
  const isAthlete = h('input', { type: 'checkbox', checked: true, id: 'is-athlete' });
  const f = {
    name: input({ autocomplete: 'off', required: true }), email: input({ type: 'email', autocomplete: 'off' }), phone: input({ type: 'tel', autocomplete: 'off' }),
    birth_date: input({ type: 'date', max: bizDate(), min: '1900-01-01' }), sport: input(), position: input(), school: input(), grad_year: input({ type: 'number', inputmode: 'numeric', min: '2000', max: '2060', placeholder: 'e.g. 2030' }),
    athlete_phone: input({ type: 'tel', autocomplete: 'off' }),
    medical_notes: h('textarea', { class: 'dp-input', style: 'min-height:64px', placeholder: 'Allergies, injuries, conditions' }), emergency_name: input({ autocomplete: 'off' }), emergency_phone: input({ type: 'tel', autocomplete: 'off' }),
    pName: input({ autocomplete: 'off' }), pEmail: input({ type: 'email', autocomplete: 'off' }), pPhone: input({ type: 'tel', autocomplete: 'off' })
  };
  const plan = select([['', 'No subscription yet'], ...plans.data.map((p) => [p.id, `${p.name}${p.price_cents == null ? '' : `, ${money(p.price_cents)}/mo`}${p.trial_days ? `, ${p.trial_days}-day trial` : ''}`])], { value: '' });
  const prog = select([['', 'Assign later'], ...progs.data.map((p) => [p.id, p.name])], { value: '' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const dupBox = h('div', { 'aria-live': 'polite' });
  const submit = btn('Create account', null, 'primary', { type: 'submit' });
  const parentBox = h('div', { class: 'stack' }, h('div', { class: 'dp-label' }, 'Parent or guardian (pays and signs in to the parent portal)'),
    h('div', { class: 'form-grid cols-3' }, field('Parent name', f.pName), field('Parent email', f.pEmail), field('Parent phone', f.pPhone)));
  const athleteBox = h('div', { class: 'stack' },
    h('div', { class: 'form-grid cols-4' }, field('Birthday', f.birth_date), field('Sport', f.sport), field('Position (optional)', f.position), field('Grad year (optional)', f.grad_year)),
    h('div', { class: 'form-grid cols-3' }, field('School', f.school), field('Athlete phone (optional)', f.athlete_phone)));
  const emailField = field('Email', f.email), phoneField = field('Phone (optional)', f.phone);
  const health = h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Medical notes and emergency contact (optional)'),
    h('div', { class: 'stack', style: 'margin-top:8px' }, field('Medical notes', f.medical_notes, 'Shown to coaches at the top of the profile and on rosters.'),
      h('div', { class: 'form-grid cols-3' }, field('Emergency contact', f.emergency_name), field('Emergency phone', f.emergency_phone))));
  const sync = () => { parentBox.style.display = athleteBox.style.display = isAthlete.checked ? '' : 'none'; emailField.style.display = phoneField.style.display = isAthlete.checked ? 'none' : ''; };
  isAthlete.addEventListener('change', () => { sync(); fill(dupBox); });
  const val = (el) => el.value.trim() || undefined;
  // Only the fields on screen are sent: switching between athlete and adult never leaks the hidden ones.
  const athleteBody = () => ({ name: f.name.value, birth_date: val(f.birth_date), sport: val(f.sport), position: val(f.position), school: val(f.school), grad_year: f.grad_year.value ? Number(f.grad_year.value) : undefined, phone: val(f.athlete_phone) });
  const common = () => ({ plan_id: plan.value || undefined, program_id: canProgram ? prog.value || undefined : undefined, medical_notes: val(f.medical_notes), emergency_name: val(f.emergency_name), emergency_phone: val(f.emergency_phone) });
  const body = () => (isAthlete.checked ? { ...athleteBody(), ...common(), parent: { name: f.pName.value, email: f.pEmail.value, phone: val(f.pPhone) } } : { name: f.name.value, email: f.email.value, phone: val(f.phone), ...common() });
  const done = (c) => {
    toast(c.family && isAthlete.checked ? `${c.name.split(' ')[0]} added. ${f.pName.value.split(' ')[0] || 'The parent'} can sign in at ${location.origin}/parent with ${f.pEmail.value.trim()}.` : `Account created for ${c.name.split(' ')[0]}.`);
    location.hash = `#/clients/${c.id}`;
  };
  const dupLink = (d) => h('a', { href: `#/clients/${d.id}` }, `${d.name} (${d.athlete_id}${d.archived ? ', archived' : ''}${d.family_name ? `, ${d.family_name}` : ''}${d.birth_date ? `, born ${date(`${d.birth_date}T12:00:00`)}` : ''})`);
  const create = async (checked) => {
    err.textContent = ''; fill(dupBox);
    try { done(await post('/v1/clients', { ...body(), check_duplicates: checked })); }
    catch (x) {
      const d = x.details?.duplicates ?? [];
      if (x.code === 'possible_duplicate') {
        const anyway = btn('Create a new account anyway', (e) => busy(e.currentTarget, () => create(false)), 'ghost');
        fill(dupBox, h('div', { class: 'dp-panel stack-tight', role: 'alert', style: 'border-left:3px solid var(--amber)' }, h('span', { class: 'strong' }, x.message), ...d.map((y) => h('div', null, dupLink(y), y.reason === 'phone' ? h('span', { class: 'small muted' }, ' · same phone number') : null)), h('div', { class: 'row' }, anyway)));
      } else if (x.code === 'parent_exists') {
        const fam = x.details.family, kid = d[0];
        const addHere = btn(`Add ${f.name.value.trim().split(' ')[0] || 'the athlete'} to the ${fam.name}`, (e) => busy(e.currentTarget, async () => {
          done(await post(`/v1/families/${fam.id}/athletes`, { ...athleteBody(), ...common(), check_duplicates: true }));
        }), 'secondary');
        fill(dupBox, h('div', { class: 'dp-panel stack-tight', role: 'alert', style: 'border-left:3px solid var(--amber)' }, h('span', { class: 'strong' }, x.message),
          kid ? h('div', null, 'Open ', h('a', { href: `#/clients/${kid.id}?add=sibling` }, `${kid.name} (${kid.athlete_id})`), ' and use Add sibling, or add them here.') : null, h('div', { class: 'row' }, isAthlete.checked ? addHere : null)));
      } else if (x.code === 'duplicate_email') {
        fill(dupBox, h('div', { class: 'dp-panel stack-tight', role: 'alert', style: 'border-left:3px solid var(--amber)' }, h('span', { class: 'strong' }, x.message), ...d.map((y) => h('div', null, 'Open ', dupLink(y)))));
      } else err.textContent = x.message;
    }
  };
  fill(main,
    header('New client', 'Creates the account, the parent login, the plan and the program in one step.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/clients' }, 'Cancel')),
    h('form', { class: 'dp-panel stack', style: 'max-width:820px', onSubmit: (e) => { e.preventDefault(); busy(submit, () => create(true)); } },
      h('label', { class: 'row', style: 'gap:10px;min-height:44px' }, isAthlete, h('span', null, 'Athlete with a parent who pays')),
      h('div', { class: 'form-grid' }, field('Full name', f.name), emailField, phoneField),
      athleteBox, parentBox, health,
      h('div', { class: 'form-grid' }, field('Subscription plan', plan, 'With a trial, the first charge happens when it ends.'), canProgram ? field('Starting program', prog) : null),
      h('p', { class: 'small muted' }, 'Adding a sibling? Open the brother or sister and use "Add sibling" instead, so the family shares one login and card.'),
      dupBox, err, h('div', { class: 'row' }, submit)));
  sync(); f.name.focus();
}

// ---------- Billing ----------
// ---------- Pay links ----------
const sentText = (l) => (l.emailed || l.texted ? `Pay link sent${l.emailed ? ` by email${l.texted ? ' and text' : ''}` : ' by text'}.` : 'Pay link ready.');
const copyLink = async (url) => { await navigator.clipboard?.writeText(url).catch(() => {}); toast('Pay link copied. Paste it into a text or email.'); };
function payLinkActions(l, render) {
  return h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
    btn('Copy', () => copyLink(l.url), 'outline'),
    btn('Send again', (e) => busy(e.currentTarget, async () => { toast(sentText(await post(`/v1/pay-links/${l.id}/send`))); render(); }), 'ghost'),
    btn('Cancel', (e) => busy(e.currentTarget, async () => { await post(`/v1/pay-links/${l.id}/cancel`); toast('Link canceled. It can\'t be paid now.'); render(); }), 'ghost'));
}
function payLinksPanel(clientId, first, owed, products, render) {
  const make = (body, send) => (e) => busy(e.currentTarget, async () => {
    const l = await post('/v1/pay-links', { ...body, send });
    if (send) toast(sentText(l)); else await copyLink(l.url);
    render();
  });
  const kind = select([['custom', 'A set amount'], ...products.filter((p) => p.active !== false).map((p) => [p.id, `${p.name} (${money(p.price_cents)})`])], { 'aria-label': 'What to charge for' });
  const desc = input({ placeholder: 'What it\'s for, e.g. Summer camp deposit', maxlength: '80' }), amount = input({ type: 'number', min: '1', step: '0.01', inputmode: 'decimal', placeholder: 'Amount ($)' });
  const custom = h('div', { class: 'form-grid', style: 'grid-template-columns:2fr 1fr' }, desc, amount);
  kind.addEventListener('change', () => { custom.hidden = kind.value !== 'custom'; });
  const body = () => (kind.value === 'custom' ? { kind: 'custom', client_id: clientId, description: desc.value, amount_cents: Math.round(Number(amount.value) * 100) } : { kind: 'product', client_id: clientId, product_id: kind.value });
  const openFor = (o) => owed.open_links.find((l) => (o.invoice_id && l.invoice_id === o.invoice_id) || (o.booking_id && l.booking_id === o.booking_id));
  return panel('Pay links', { subtitle: `Send ${first}'s family a link to pay by card, no sign-in needed. Emails go to every parent; texts go to parents who turned them on.` },
    owed.data.length ? h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'Owed now'), owed.data.map((o) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', null, o.description), h('span', { class: 'small muted' }, `${money(o.amount_cents)}${openFor(o)?.sent_at ? ` · link sent ${ago(openFor(o).sent_at)}` : ''}`)),
      btn('Send pay link', make(o, true), 'outline'), btn('Copy link', make(o, false), 'ghost')))) : h('p', { class: 'muted', style: 'margin:0' }, 'Nothing owed right now.'),
    owed.open_links.filter((l) => l.kind === 'product' || l.kind === 'custom').map((l) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', null, l.description), h('span', { class: 'small muted' }, `${money(l.amount_cents)} · ${l.sent_at ? `sent ${ago(l.sent_at)}` : 'not sent yet'}`)), payLinkActions(l, render))),
    h('details', null, h('summary', { class: 'small', style: 'cursor:pointer' }, 'Ask for something else'),
      h('div', { class: 'stack', style: 'margin-top:12px' }, kind, custom,
        h('div', { class: 'row wrap' }, btn('Send pay link', (e) => make(body(), true)(e), 'secondary'), btn('Copy link', (e) => make(body(), false)(e), 'ghost')))));
}

// Daily money checks: what the morning check found, newest day first.
function moneyChecksPanel(checks, render) {
  const tone = { ok: ['All clear', 'good'], problems: ['To look at', 'warn'], error: ['Couldn\'t reach Stripe', 'warn'] };
  const pick = input({ type: 'date', 'aria-label': 'Day to check', value: bizDate(-1), style: 'width:170px' });
  const run = (day) => (e) => busy(e.currentTarget, async () => {
    const c = await post('/v1/money-checks/run', { date: day });
    toast(c.status === 'ok' ? `Nothing unusual on ${ymd(c.date)}.` : c.status === 'error' ? c.error : `${c.problems} ${c.problems === 1 ? 'thing' : 'things'} to look at on ${ymd(c.date)}.`, c.status === 'ok' ? 'good' : 'warn'); render();
  });
  const row = (c) => h('div', { class: 'list-item', style: 'align-items:flex-start;flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight' },
      h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'strong' }, ymd(c.date)), c.reviewed_at ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Looked at') : h('span', { class: `dp-badge dp-badge--${tone[c.status][1]}` }, tone[c.status][0])),
      h('span', { class: 'small muted' }, `${c.totals.card_payments} card ${c.totals.card_payments === 1 ? 'payment' : 'payments'}, ${money(c.totals.recorded_cents)}${c.stripe_checked ? `. Stripe: ${money(c.totals.stripe_cents)}` : ''}`),
      c.error ? h('span', { class: 'small' }, `${c.error} Tried ${c.attempts} ${c.attempts === 1 ? 'time' : 'times'}.`) : null,
      c.findings.map((f) => h('div', { class: 'stack-tight', style: 'margin-top:6px' }, h('span', null, f.title), h('span', { class: 'small muted' }, f.detail))),
      c.reviewed_at ? h('span', { class: 'small muted' }, `Marked as looked at by ${c.reviewed_by}, ${ago(c.reviewed_at).toLowerCase()}.`) : null),
    c.status !== 'ok' ? h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
      c.reviewed_at ? null : btn('Mark as looked at', (e) => busy(e.currentTarget, async () => { await patch(`/v1/money-checks/${c.id}`, { reviewed: true }); toast('Marked as looked at.'); render(); }), 'outline'),
      btn('Check again', run(c.date), 'ghost')) : null);
  return panel('Daily money checks', {
    subtitle: `Each morning the app checks the day before for double charges, refund spikes and payments stuck waiting${checks.stripe_connected ? ', and matches every card payment with Stripe' : '. Matching every card payment with Stripe starts once Stripe is connected'}. Anything it finds is emailed to you.` },
    checks.data.length ? checks.data.map(row) : h('p', { class: 'muted', style: 'margin:0' }, 'The first check runs tomorrow morning.'),
    h('div', { class: 'row wrap', style: 'gap:8px;margin-top:12px' }, pick, btn('Check a day', (e) => run(pick.value)(e), 'ghost')));
}

// ---------- Billing (owner only) ----------
// The money summary, failed payments to chase, every invoice (details, refunds, write-offs, export), memberships, plans,
// pay links, money checks and the test-mode billing clock. Filters survive a refresh of the screen after an action.
const billingUi = { view: 'all', kind: '', period: '', q: '', limit: 50, mview: 'live', mplan: '', mq: '' };
const BL_STATE = { failed: ['Failed', 'warn'], open: ['Open', 'neutral'], overdue: ['Overdue', 'warn'], paid: ['Paid', 'good'], partially_refunded: ['Part refunded', 'neutral'], refunded: ['Refunded', 'muted'], void: ['Void', 'muted'] };
const blBadge = (st) => h('span', { class: `dp-badge dp-badge--${BL_STATE[st]?.[1] ?? 'muted'}` }, BL_STATE[st]?.[0] ?? st);
const BL_VIEWS = [['all', 'All'], ['failed', 'Failed'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['refunds', 'Refunds'], ['void', 'Void']];
const BL_PERIODS = [['', 'Any time'], ['month', 'This month'], ['last', 'Last month'], ['90', 'Last 90 days'], ['year', 'This year']];
const MEM_VIEWS = [['live', 'All members'], ['renewing', 'Renewing this week'], ['trialing', 'Free trial'], ['past_due', 'Past due'], ['paused', 'Paused'], ['canceled', 'Canceled lately']];
const HAND_PAY = [['check', 'Check'], ['cash', 'Cash'], ['other', 'Other']];
const cardText = (r) => (r.card_last4 ? `${r.card_brand ? r.card_brand[0].toUpperCase() + r.card_brand.slice(1) : 'Card'} ending ${r.card_last4}` : 'No card on file');
function blPeriod(id) {
  const today = bizDate(), [y, m] = today.split('-').map(Number), pad = (n) => String(n).padStart(2, '0');
  if (id === 'month') return { from: `${y}-${pad(m)}-01`, to: today };
  if (id === 'last') { const ly = m === 1 ? y - 1 : y, lm = m === 1 ? 12 : m - 1; return { from: `${ly}-${pad(lm)}-01`, to: new Date(Date.UTC(ly, lm, 0)).toISOString().slice(0, 10) }; }
  if (id === '90') return { from: bizDate(-90), to: today };
  if (id === 'year') return { from: `${y}-01-01`, to: today };
  return {};
}
function blQuery(extra = {}) {
  const p = new URLSearchParams(), r = blPeriod(billingUi.period);
  if (billingUi.view !== 'all') p.set('view', billingUi.view);
  if (billingUi.kind) p.set('kind', billingUi.kind);
  if (r.from) { p.set('from', r.from); p.set('to', r.to); }
  if (billingUi.q.trim()) p.set('q', billingUi.q.trim());
  for (const [k, val] of Object.entries(extra)) p.set(k, val);
  return p.toString();
}
// What a declined charge is waiting on: tries, card, the next automatic retry, the last reminder.
function declineText(i) {
  const last = i.retries_left <= 1;
  return [`Declined ${plural(i.attempts, 'time')}`, cardText(i), i.next_retry_at ? `next automatic retry ${date(i.next_retry_at)}${last ? ' (the last one)' : ''}` : 'no more automatic retries',
    i.reminded_at ? `card reminder sent ${i.reminded_today ? 'today' : ago(i.reminded_at).toLowerCase()}` : null].filter(Boolean).join(' · ');
}
function retryConfirm(i) {
  return confirm(`Charge ${money(i.amount_cents)} to ${cardText(i).toLowerCase().replace(/^([a-z])/, (c) => c.toUpperCase())} for ${i.client_name} now?${i.retries_left <= 1 ? '\n\nIf it declines, the membership stays past due (a retry you start never cancels it).' : ''}`);
}
async function retryNow(i) {
  if (!retryConfirm(i)) return;
  const r = await post(`/v1/invoices/${i.id}/retry`);
  if (r.status === 'paid') toast(`Charged ${money(r.amount_cents)}.${r.membership_reactivated ? ' The membership is active again.' : ''}`);
  else toast(`The card declined again${r.last_error ? ` (${r.last_error})` : ''}. It retries on its own, or ask the family to update their card.`, 'warn');
  render();
}
async function remindNow(i) {
  const r = await post(`/v1/invoices/${i.id}/remind`);
  toast(`Card reminder emailed to ${r.reminder_to.join(', ')}${r.invoices_in_reminder > 1 ? ` (${r.invoices_in_reminder} charges)` : ''}.`);
  render();
}
function recordHandDialog(i) {
  const method = select(HAND_PAY, { value: 'check' }), ref = input({ autocomplete: 'off', maxlength: '40', inputmode: 'numeric' });
  const refField = field('Check number (optional)', ref);
  method.addEventListener('change', () => { refField.querySelector('label').textContent = method.value === 'check' ? 'Check number (optional)' : 'Reference (optional)'; ref.inputMode = method.value === 'check' ? 'numeric' : 'text'; });
  teamDialog('Record payment', h('div', { class: 'stack' }, h('p', { class: 'muted', style: 'margin:0' }, `${i.client_name} · ${i.description} · ${money(i.amount_cents)}. Mark it paid because it came in another way.`),
    h('div', { class: 'form-grid' }, field('How they paid', method), refField)),
  [{ label: 'Record payment', variant: 'primary', onClick: async () => {
    const r = await post(`/v1/invoices/${i.id}/payments`, { method: method.value, reference: ref.value.trim() || undefined });
    toast(`Marked paid by ${method.value}.${r.membership_reactivated ? ' The membership is active again.' : ''}`); render();
  } }, { label: 'Cancel', variant: 'ghost' }]);
}
function refundDialog(d) {
  const amount = dollarsIn(d.refundable_cents, { min: '0.01', max: (d.refundable_cents / 100).toFixed(2) }), reason = input({ maxlength: '120', placeholder: 'Like Moved away mid-month' });
  const email = h('input', { type: 'checkbox', checked: !!d.email });
  const byCard = !d.paid_method;
  teamDialog('Refund', h('div', { class: 'stack' },
    h('p', { class: 'muted', style: 'margin:0' }, `${d.client_name} · ${d.description} · paid ${money(d.amount_cents)}${d.refunded_cents ? `, ${money(d.refunded_cents)} already refunded` : ''}. ${byCard ? 'It goes back to the card they paid with.' : `They paid by ${d.paid_by.toLowerCase()}, so hand it back yourself; this records it.`} The membership carries on; cancel it separately if they're leaving.`),
    h('div', { class: 'form-grid' }, field('Amount to refund ($)', amount, `Up to ${money(d.refundable_cents)}.`), field('Reason', reason, 'Goes on the receipt.')),
    d.email ? h('label', { class: 'row', style: 'gap:8px' }, email, `Email a receipt to ${d.email}`) : h('p', { class: 'small muted', style: 'margin:0' }, 'There\'s no email on file, so no receipt goes out.')),
  [{ label: 'Refund', variant: 'primary', onClick: async () => {
    const cents = toCents(amount);
    if (!(cents > 0)) throw new Error('Enter the amount to refund.');
    if (cents > d.refundable_cents) throw new Error(`You can refund up to ${money(d.refundable_cents)}.`);
    if (!reason.value.trim()) throw new Error('Say why you\'re refunding. It goes on the receipt.');
    if (!confirm(`Refund ${money(cents)} to ${d.client_name}${byCard ? '\'s card' : ''}? This can't be undone.`)) return false;
    const r = await post(`/v1/invoices/${d.id}/refund`, { amount_cents: cents, reason: reason.value.trim(), email: email.checked });
    toast(`Refunded ${money(r.refunded_now_cents)}.${byCard ? ' It goes back to the card.' : ' Hand it back to the family.'}${r.emailed_to?.length ? ` Receipt emailed to ${r.emailed_to[0]}.` : ''}`); render();
  } }, { label: 'Cancel', variant: 'ghost' }]);
}
function voidDialog(d) {
  const reason = input({ maxlength: '120', placeholder: 'Like Comped the month' });
  teamDialog(d.status === 'failed' ? 'Write off this charge' : 'Void this invoice', h('div', { class: 'stack' },
    h('p', { class: 'muted', style: 'margin:0' }, `${d.client_name} · ${d.description} · ${money(d.amount_cents)}. Nothing more is charged or retried and its pay link stops working.${d.subscription_status === 'past_due' ? ' If this is the only declined charge, the membership is active again.' : ''}`),
    field('Reason (optional)', reason)),
  [{ label: d.status === 'failed' ? 'Write it off' : 'Void invoice', variant: 'primary', onClick: async () => {
    const r = await post(`/v1/invoices/${d.id}/void`, { reason: reason.value.trim() || undefined });
    toast(`${d.status === 'failed' ? 'Written off' : 'Voided'}.${r.membership_reactivated ? ' The membership is active again.' : ''}`); render();
  } }, { label: 'Cancel', variant: 'ghost' }]);
}
// Open another dialog once this one has closed (and been emptied).
const thenOpen = (fn) => () => { document.getElementById('dialog').addEventListener('close', () => setTimeout(fn), { once: true }); };
// One membership payment: what happened and what can be done now.
async function invoiceDialog(id) {
  const d = await get(`/v1/invoices/${id}`);
  const kv = (k, val) => (val ? [h('dt', null, k), h('dd', null, val)] : null);
  const period = `${date(d.period_start)} – ${date(d.period_end)}`;
  const acts = [
    d.can.retry ? { label: 'Retry charge', variant: 'secondary', onClick: async () => { await retryNow(d); } } : null,
    d.can.record_payment ? { label: 'Record payment', variant: 'ghost', onClick: thenOpen(() => recordHandDialog(d)) } : null,
    d.can.remind ? { label: 'Card reminder', variant: 'ghost', onClick: async () => { await remindNow(d); } } : null,
    d.can.pay_link ? { label: 'Send pay link', variant: 'ghost', onClick: async () => { const l = await post('/v1/pay-links', { kind: 'invoice', invoice_id: d.id, send: true }); toast(sentText(l)); render(); } } : null,
    d.can.refund ? { label: 'Refund', variant: 'secondary', onClick: thenOpen(() => refundDialog(d)) } : null,
    d.can.void ? { label: d.status === 'failed' ? 'Write off' : 'Void', variant: 'ghost', onClick: thenOpen(() => voidDialog(d)) } : null,
    { label: 'Close', variant: 'ghost' }
  ].filter(Boolean);
  teamDialog(`${d.description} · ${d.client_name}`, h('div', { class: 'stack' },
    h('div', { class: 'row wrap', style: 'gap:12px' }, h('span', { style: 'font:600 32px/1.1 var(--font-display)' }, money(d.amount_cents)), blBadge(d.state)),
    h('dl', { class: 'dl' },
      kv('Client', h('a', { href: `#/clients/${d.client_id}`, onClick: () => document.getElementById('dialog').close() }, d.client_name)), kv('Period', period), kv('Made', date(d.issued_at)),
      kv('Card', d.card ? `${cardText({ card_brand: d.card.brand, card_last4: d.card.last4 })}${d.card.declining ? ' (declining)' : ''}` : 'No card on file'),
      d.status === 'failed' ? kv('Declines', declineText({ ...d, reminded_today: d.reminded_today })) : null,
      d.last_error && d.status === 'failed' ? kv('Bank said', d.last_error) : null,
      d.paid_at ? kv('Paid', `${date(d.paid_at)} by ${(d.paid_by ?? 'card').toLowerCase()}${d.paid_reference ? ` (${d.paid_reference})` : ''}`) : null,
      d.voided_at ? kv(d.attempts ? 'Written off' : 'Voided', `${date(d.voided_at)}${d.void_reason ? ` · ${d.void_reason}` : ''}`) : null,
      d.refunded_cents ? kv('Refunded', `${money(d.refunded_cents)}${d.refundable_cents ? ` · ${money(d.refundable_cents)} left to refund` : ''}`) : null,
      kv('Email', d.email)),
    d.refunds.length ? h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'Refunds'), d.refunds.map((r) => h('div', { class: 'small' },
      `${money(r.amount_cents)} on ${date(r.created_at)}${r.source === 'stripe' ? ' in the Stripe dashboard' : r.by_name ? ` by ${r.by_name}` : ''}${r.reason ? ` · ${r.reason}` : ''}`))) : null,
    d.pay_links.length ? h('p', { class: 'small muted', style: 'margin:0' }, `Pay link: ${{ open: 'open', paid: 'paid', settled: 'paid another way', canceled: 'canceled', expired: 'expired' }[d.pay_links[0].status] ?? d.pay_links[0].status}${d.pay_links[0].sent_at ? `, sent ${ago(d.pay_links[0].sent_at).toLowerCase()}` : ''}.`) : null), acts);
}

async function viewBilling(main) {
  const mp = new URLSearchParams();
  if (billingUi.mview !== 'live') mp.set('view', billingUi.mview);
  if (billingUi.mplan) mp.set('plan_id', billingUi.mplan);
  if (billingUi.mq.trim()) mp.set('q', billingUi.mq.trim());
  const [settings, s, att, inv, mem, plans, links, checks] = await Promise.all([get('/v1/settings'), get('/v1/billing/summary'), get('/v1/billing/attention'), get(`/v1/billing/invoices?${blQuery({ limit: billingUi.limit })}`),
    get(`/v1/billing/memberships?${mp}`), get('/v1/plans?include_inactive=true'), get('/v1/pay-links'), get('/v1/money-checks')]);
  if (settings.timezone) tzName = settings.timezone;
  const jumpTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // ---- the four numbers ----
  const tile = (label, value, note, tone, onClick) => h('button', { type: 'button', class: 'dp-metric bl-metric', onClick }, h('span', { class: 'dp-metric-label' }, label),
    h('span', { class: `dp-metric-value${tone ? ` dp-metric-value--${tone}` : ''}` }, value), h('span', { class: 'dp-metric-note' }, note));
  const showInvoices = (patchUi) => { Object.assign(billingUi, { view: 'all', kind: '', period: '', q: '', limit: 50 }, patchUi); render(); setTimeout(() => jumpTo('bl-inv'), 50); };
  const numbers = h('section', { class: 'metrics bl-metrics', 'aria-label': 'Money summary' },
    tile('Monthly recurring', money(s.mrr.total_cents), `${plural(s.mrr.paying_members, 'paying member')}${s.mrr.teams_cents ? ` · ${money(s.mrr.teams_cents)} teams` : ''}`, null, () => jumpTo('bl-mem')),
    tile('Collected this month', money(s.month.collected_cents), `${plural(s.month.payments, 'payment')}${s.month.refunded_cents ? ` · ${money(s.month.refunded_cents)} refunded` : ''}`, 'good', () => showInvoices({ view: 'paid', period: 'month' })),
    tile('Failed payments', String(s.failed.count), s.failed.count ? `${money(s.failed.cents)} at risk${s.failed.no_card ? ` · ${s.failed.no_card} with no card` : ''}` : 'Nothing at risk', s.failed.count ? 'warn' : null, () => jumpTo('bl-att')),
    tile('School invoices open', money(s.school.open_cents), s.school.open_count ? `${plural(s.school.open_count, 'invoice')}${s.school.overdue_count ? ` · ${money(s.school.overdue_cents)} overdue` : ' · none overdue'}` : 'Nothing owed', s.school.overdue_count ? 'warn' : null, () => showInvoices({ view: 'unpaid', kind: 'school' })));
  const monthNote = h('p', { class: 'small muted', style: 'margin:0' }, `Collected this month is the same number as on Today: ${money(s.month.sales_cents)} at the counter and online, ${money(s.month.members_cents)} memberships and ${money(s.month.teams_cents)} schools, after refunds (a refund counts on the day it was made). ${s.upcoming.renewals ? `In the next 7 days, ${plural(s.upcoming.renewals, 'renewal')} for ${money(s.upcoming.cents)}${s.upcoming.trials_ending ? ` (${plural(s.upcoming.trials_ending, 'trial')} ending)` : ''}.` : 'No renewals in the next 7 days.'}`);

  // ---- needs attention ----
  const attN = att.failed.length + att.overdue.length;
  const withCard = att.failed.filter((i) => i.has_card).length;
  const attTools = att.failed.length ? h('div', { class: 'row wrap', style: 'gap:8px' },
    withCard ? btn(withCard === 1 ? 'Retry the declined charge' : `Retry all ${withCard}`, (e) => {
      if (!confirm(`Charge ${withCard === 1 ? 'the declined charge' : `all ${withCard} declined charges`} with a card on file now? A decline here never cancels a membership.`)) return;
      busy(e.currentTarget, async () => {
        const r = await post('/v1/billing/retry-declined');
        toast(r.tried === 1 ? (r.paid ? `Charged ${money(r.paid_cents)}.` : 'The charge declined again.') : r.paid ? `${r.paid} of ${r.tried} went through (${money(r.paid_cents)}).${r.declined ? ` ${r.declined} declined again.` : ''}` : `All ${r.tried} declined again.`, r.declined ? 'warn' : 'good');
        render();
      });
    }, 'outline') : null,
    btn('Email card reminders', (e) => busy(e.currentTarget, async () => {
      const r = await post('/v1/billing/remind-declined');
      toast(r.sent ? `Card reminders emailed to ${plural(r.sent, 'family', 'families')}.${r.skipped_today ? ` ${r.skipped_today} already had one today.` : ''}${r.no_email ? ` ${r.no_email} with no email.` : ''}` : r.skipped_today ? 'Every family already had a reminder today.' : 'No family has an email address to remind.', r.sent ? 'good' : 'warn');
      render();
    }), 'ghost')) : null;
  const attRow = (i) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', null, h('a', { class: 'strong', href: `#/clients/${i.client_id}`, style: 'color:var(--steel)' }, i.client_name), h('span', { class: 'muted' }, ` · ${i.description}`)),
      h('span', { class: `small ${i.has_card ? 'muted' : 'warn-text'}` }, declineText(i))),
    h('span', { class: 'strong' }, money(i.amount_cents)), blBadge('failed'),
    h('div', { class: 'row wrap', style: 'gap:4px' },
      i.has_card ? btn('Retry', (e) => busy(e.currentTarget, () => retryNow(i)), 'outline', { 'aria-label': `Retry ${i.client_name}'s charge` }) : null,
      i.reminded_today ? null : btn('Remind', (e) => busy(e.currentTarget, () => remindNow(i)), 'ghost', { 'aria-label': `Email ${i.client_name}'s family a card reminder` }),
      btn('Details', (e) => busy(e.currentTarget, () => invoiceDialog(i.id)), 'ghost', { 'aria-label': `Details for ${i.client_name}'s charge` })));
  const overdueRow = (i) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', null, h('a', { class: 'strong', href: `#/teams/${i.contract_id}`, style: 'color:var(--steel)' }, i.org_name), h('span', { class: 'muted' }, ` · ${i.description}`)),
      h('span', { class: 'small warn-text' }, `${i.number} · ${plural(i.days_past_due, 'day')} past due (due ${ymd(i.due_on)})`)),
    h('span', { class: 'strong' }, money(i.amount_cents)), blBadge('overdue'),
    h('div', { class: 'row wrap', style: 'gap:4px' }, btn('Record payment', () => recordPaymentDialog(i), 'outline', { 'aria-label': `Record payment for ${i.number}` }),
      h('a', { class: 'dp-btn dp-btn--ghost', href: `#/teams/${i.contract_id}` }, 'Team')));
  const attPanel = h('div', { id: 'bl-att' }, panel('Needs attention', {
    subtitle: attN ? [att.failed.length ? `${plural(att.failed.length, 'declined charge')} (${money(att.failed_cents)})` : null, att.overdue.length ? `${plural(att.overdue.length, 'overdue school invoice')} (${money(att.overdue_cents)})` : null].filter(Boolean).join(' and ') + `. Declined charges retry on their own every ${att.retry_every_days} days, up to ${att.max_attempts} tries; a failed-payment email with a pay link goes out each time.` : null,
    action: attTools },
  attN ? h('div', null, att.failed.map(attRow), att.overdue.map(overdueRow)) : h('p', { class: 'muted', style: 'margin:0' }, 'Nothing needs attention. Every charge went through and no school invoice is overdue.')));

  // ---- invoices ----
  const search = input({ type: 'search', placeholder: 'Name, plan, school or invoice number', 'aria-label': 'Search invoices', value: billingUi.q });
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { billingUi.q = search.value; billingUi.limit = 50; render(); }, 350); });
  const kind = select([['', 'Every kind'], ['membership', 'Memberships'], ['school', 'School invoices']], { 'aria-label': 'Kind of invoice', value: billingUi.kind });
  kind.addEventListener('change', () => { billingUi.kind = kind.value; billingUi.limit = 50; render(); });
  const period = select(BL_PERIODS, { 'aria-label': 'When', value: billingUi.period });
  period.addEventListener('change', () => { billingUi.period = period.value; billingUi.limit = 50; render(); });
  const views = h('div', { class: 'row wrap tm-views', role: 'group', 'aria-label': 'Show invoices' }, BL_VIEWS.map(([k, label]) =>
    h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(billingUi.view === k), onClick: () => { billingUi.view = k; billingUi.limit = 50; render(); } }, label,
      h('span', { class: ['failed', 'overdue'].includes(k) && inv.counts[k] ? 'warn-text' : 'muted' }, String(inv.counts[k] ?? 0)))));
  const openRow = (i) => (i.kind === 'school' ? () => { location.hash = `#/teams/${i.contract_id}`; } : () => invoiceDialog(i.id).catch((e) => toast(e.message, 'warn')));
  const rows = inv.data.map((i) => h('tr', { class: 'link', tabindex: '0', onClick: openRow(i), onKeydown: (e) => { if (e.key === 'Enter') openRow(i)(); } },
    h('td', { class: 'bl-wide muted' }, i.kind === 'school' ? ymd(i.issued_at) : date(i.issued_at)),
    h('td', null, h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, i.kind === 'school' ? i.org_name : i.client_name),
      h('span', { class: 'small muted' }, i.kind === 'school' ? `${i.number} · ${i.description}` : i.description))),
    h('td', { class: 'bl-wide muted' }, i.kind === 'school' ? 'School invoice' : 'Membership'),
    h('td', { style: 'white-space:nowrap' }, money(i.amount_cents), i.refunded_cents ? h('div', { class: 'small muted' }, `${money(i.refunded_cents)} refunded`) : null),
    h('td', null, blBadge(i.state))));
  const exportHref = `/v1/billing/invoices/export?${blQuery()}`;
  const invPanel = h('div', { id: 'bl-inv' }, panel('Invoices', { subtitle: 'Membership payments and school invoices, newest first. Counter sales are in Point of sale.', action: h('a', { class: 'dp-btn dp-btn--ghost', href: exportHref, download: '' }, 'Export CSV') },
    views,
    h('div', { class: 'row wrap bl-tools' }, search, kind, period),
    h('p', { class: 'small muted', style: 'margin:0' }, inv.total ? `${plural(inv.total, 'invoice')} · ${money(inv.total_cents)}${inv.refunded_cents ? ` · ${money(inv.refunded_cents)} refunded` : ''}` : ''),
    inv.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { class: 'bl-wide' }, 'Date'), h('th', null, 'Who'), h('th', { class: 'bl-wide' }, 'Kind'), h('th', null, 'Amount'), h('th', null, 'Status'))), h('tbody', null, rows)))
      : h('p', { class: 'muted' }, billingUi.q || billingUi.kind || billingUi.period || billingUi.view !== 'all' ? 'Nothing matches. Try another view or clear the search.' : 'No invoices yet. They appear when trials end, memberships renew and schools are billed.'),
    inv.total > inv.data.length ? h('div', { class: 'row', style: 'justify-content:center' }, btn(`Show more (${inv.total - inv.data.length} more)`, () => { billingUi.limit = Math.min(500, billingUi.limit + 100); render(); }, 'ghost')) : null));

  // ---- memberships ----
  const mq = input({ type: 'search', placeholder: 'Athlete, family or Athlete ID', 'aria-label': 'Search memberships', value: billingUi.mq });
  let mt = null;
  mq.addEventListener('input', () => { clearTimeout(mt); mt = setTimeout(() => { billingUi.mq = mq.value; render(); }, 350); });
  const mplan = select([['', 'Every plan'], ...plans.data.map((p) => [p.id, `${p.name}${p.active ? '' : ' (retired)'}`])], { 'aria-label': 'Plan', value: billingUi.mplan });
  mplan.addEventListener('change', () => { billingUi.mplan = mplan.value; render(); });
  const mviews = h('div', { class: 'row wrap tm-views', role: 'group', 'aria-label': 'Show memberships' }, MEM_VIEWS.map(([k, label]) =>
    h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(billingUi.mview === k), onClick: () => { billingUi.mview = k; render(); } }, label,
      h('span', { class: k === 'past_due' && mem.counts[k] ? 'warn-text' : 'muted' }, String(mem.counts[k] ?? 0)))));
  const livePlans = plans.data.filter((p) => p.active);
  const memAction = (m) => {
    const act = (path, msg, ask) => (e) => { if (ask && !confirm(ask)) return; busy(e.currentTarget, async () => { await post(`/v1/clients/${m.client_id}/subscription/${path}`); toast(msg); render(); }); };
    const change = select([['', 'Change plan…'], ...livePlans.filter((p) => p.id !== m.plan_id).map((p) => [p.id, `${p.name} (${money(p.price_cents)}/mo)`])], { 'aria-label': `Change ${m.client_name}'s plan`, style: 'width:150px' });
    change.addEventListener('change', () => { const p = livePlans.find((x) => x.id === change.value); if (!p) return; if (!confirm(`Move ${m.client_name} to ${p.name}? The new price (${money(p.price_cents)}) applies from the next renewal.`)) { change.value = ''; return; } busy(change, async () => { await post(`/v1/clients/${m.client_id}/subscription/plan`, { plan_id: p.id }); toast(`${m.client_name.split(' ')[0]} is on ${p.name} now.`); render(); }); });
    if (m.status === 'canceled') return null;
    return h('div', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' },
      livePlans.length > 1 ? change : null,
      ['active', 'trialing'].includes(m.status) ? btn('Pause', act('pause', 'Paused. Nothing is charged until you resume.'), 'ghost', { 'aria-label': `Pause ${m.client_name}'s membership` }) : null,
      m.status === 'paused' ? btn('Resume', act('resume', 'Resumed. A new month started today.', `Resume ${m.client_name}'s membership? A new month starts today and ${money(m.price_cents)} is charged now.`), 'ghost') : null,
      btn('Cancel', act('cancel', 'Membership canceled.', `Cancel ${m.client_name}'s membership now? Anything unpaid on it is voided.`), 'ghost', { 'aria-label': `Cancel ${m.client_name}'s membership` }));
  };
  const nextText = (m) => (m.status === 'trialing' ? `Trial ends ${date(m.trial_ends_at ?? m.next_charge_at)}` : m.status === 'active' ? `Next charge ${date(m.next_charge_at)}` : m.status === 'past_due' ? `${money(m.failed_cents)} declined` : m.status === 'paused' ? 'Paused' : `Canceled ${date(m.canceled_at)}`);
  const memPanel = h('div', { id: 'bl-mem' }, panel('Memberships', { subtitle: mem.upcoming.count ? `${plural(mem.upcoming.count, 'renewal')} in the next 7 days: ${money(mem.upcoming.cents)}.` : 'No renewals in the next 7 days.' },
    mviews, h('div', { class: 'row wrap bl-tools' }, mq, mplan),
    mem.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table bl-cards' }, h('thead', null, h('tr', null, h('th', null, 'Athlete'), h('th', { class: 'bl-wide' }, 'Plan'), h('th', null, 'Next'), h('th', { class: 'bl-wide' }, 'Card'), h('th', null, ''))),
      h('tbody', null, mem.data.map((m) => h('tr', null,
        h('td', null, h('div', { class: 'stack-tight' }, h('a', { class: 'strong', href: `#/clients/${m.client_id}`, style: 'color:var(--steel)' }, m.client_name), h('span', { class: 'small muted bl-narrow' }, `${m.plan_name} · ${money(m.price_cents)}/mo`), h('span', null, badge(m.status)))),
        h('td', { class: 'bl-wide' }, m.plan_name, m.plan_active ? null : h('span', { class: 'small muted' }, ' (retired)'), h('div', { class: 'small muted' }, `${money(m.price_cents)}/mo`)),
        h('td', { class: m.status === 'past_due' ? 'warn-text' : null }, nextText(m)),
        h('td', { class: `bl-wide ${m.card_last4 ? '' : 'warn-text'}` }, cardText(m)),
        h('td', { class: 'bl-acts' }, memAction(m)))))))
      : h('p', { class: 'muted' }, billingUi.mq || billingUi.mplan ? 'Nobody matches. Clear the search or choose another plan.' : 'Nobody here.')));

  // ---- plans ----
  const pname = input({ maxlength: '80' }), price = dollarsIn(null, { min: '0' }), trial = input({ type: 'number', min: '0', max: '90', value: '7', inputmode: 'numeric' });
  const addPlan = h('details', { class: 'bl-add' }, h('summary', { class: 'strong', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Add a plan'),
    h('form', { class: 'stack', style: 'margin-top:8px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const cents = toCents(price);
      if (!pname.value.trim()) throw new Error('Name the plan.');
      if (!(cents >= 0)) throw new Error('Enter a monthly price.');
      await post('/v1/plans', { name: pname.value.trim(), price_cents: cents, trial_days: Number(trial.value) || 0 }); toast('Plan created.'); render();
    }); } }, h('div', { class: 'form-grid cols-3' }, field('Plan name', pname), field('Monthly price ($)', price), field('Free trial (days)', trial, 'Up to 90. 0 charges the first month right away.')), h('div', null, btn('Create plan', null, 'secondary', { type: 'submit' }))));
  const editPlan = (p) => {
    const f = { name: input({ maxlength: '80', value: p.name }), price: dollarsIn(p.price_cents, { min: '0' }), trial: input({ type: 'number', min: '0', max: '90', value: String(p.trial_days), inputmode: 'numeric' }) };
    setupDialog(`Change ${p.name}`, [h('div', { class: 'form-grid cols-3' }, field('Plan name', f.name), field('Monthly price ($)', f.price), field('Free trial (days)', f.trial))], 'Save', async () => {
      const cents = toCents(f.price);
      if (!f.name.value.trim() || !(cents >= 0)) throw new Error('Enter a name and a monthly price.');
      await patch(`/v1/plans/${p.id}`, { name: f.name.value.trim(), price_cents: cents, trial_days: Number(f.trial.value) || 0 });
      return cents !== p.price_cents ? `Saved. ${plural(p.subscribers, 'member')} pay the new price from their next charge.` : 'Saved.';
    }, 'A new price applies from each member\'s next charge. Nobody is charged when you save.');
  };
  const planPanel = h('div', { id: 'bl-plans' }, panel('Plans', { subtitle: 'Price changes apply from each member\'s next charge. Nobody is charged when you save.' },
    h('div', { class: 'table-wrap' }, h('table', { class: 'table bl-cards' }, h('thead', null, h('tr', null, h('th', null, 'Plan'), h('th', null, 'Price'), h('th', { class: 'bl-wide' }, 'Trial'), h('th', null, 'Members'), h('th', { class: 'bl-wide' }, 'Monthly'), h('th', null, ''))),
      h('tbody', null, plans.data.map((p) => h('tr', null,
        h('td', { class: 'strong' }, p.name, p.active ? null : h('span', { class: 'small muted' }, ' (retired)')),
        h('td', { style: 'white-space:nowrap' }, `${money(p.price_cents)}/mo`), h('td', { class: 'bl-wide' }, p.trial_days ? `${p.trial_days} days` : 'None'),
        h('td', null, p.subscribers ? h('button', { type: 'button', class: 'dp-btn dp-btn--ghost', 'aria-label': `Show the ${plural(p.subscribers, 'member')} on ${p.name}`, onClick: () => { Object.assign(billingUi, { mview: 'live', mplan: p.id, mq: '' }); render(); setTimeout(() => jumpTo('bl-mem'), 50); } }, String(p.subscribers)) : '0'),
        h('td', { class: 'bl-wide', style: 'font:600 20px/1 var(--font-display)' }, money(p.subscribers * p.price_cents)),
        h('td', { class: 'bl-acts' }, h('div', { class: 'row', style: 'gap:4px;flex-wrap:nowrap;justify-content:flex-end' },
          btn('Change', () => editPlan(p), 'ghost', { 'aria-label': `Change ${p.name}` }),
          btn(p.active ? 'Retire' : 'Offer again', (e) => busy(e.currentTarget, async () => { await patch(`/v1/plans/${p.id}`, { active: !p.active }); toast(p.active ? 'Plan retired. Current members keep it.' : 'Plan offered again.'); render(); }), 'ghost')))))))),
    addPlan));

  // ---- pay links, money checks, test clock ----
  const linksPanel = h('div', { id: 'bl-links' }, panel('Pay links', { subtitle: 'Links a family taps to pay by card without signing in. Make one from a client\'s page; failed membership payments get one automatically.' },
    links.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table bl-cards' }, h('thead', null, h('tr', null, ['For', 'Client', 'Amount', 'Sent', 'Status', ''].map((x) => h('th', null, x)))),
      h('tbody', null, links.data.slice(0, 25).map((l) => h('tr', null, h('td', null, l.description), h('td', null, l.client_id ? h('a', { href: `#/clients/${l.client_id}`, style: 'color:var(--steel)' }, l.client_name) : '—'),
        h('td', null, money(l.amount_cents)), h('td', { class: 'muted small' }, l.sent_at ? ago(l.sent_at) : l.created_by === 'Automatic' ? 'With the failed-payment email' : 'Not sent'),
        h('td', null, badge(l.paid_at ? 'paid' : l.status)), h('td', { class: 'bl-acts' }, l.status === 'open' ? payLinkActions(l, render) : null)))))) : h('p', { class: 'muted' }, 'No pay links yet.')));
  const asOf = input({ type: 'date', value: bizDate(8), min: bizDate() });
  const testPanel = state.testMode ? h('div', { id: 'bl-clock' }, panel('Billing clock (test mode)', { subtitle: 'Billing runs hourly on its own. Run it for a future date to see trials convert, renewals charge and retries happen.' },
    h('div', { class: 'row wrap' }, h('div', { style: 'width:200px' }, field('Run as of', asOf)),
      h('div', { style: 'align-self:flex-end' }, btn('Run billing', (e) => busy(e.currentTarget, async () => {
        const r = await post('/v1/billing/run', { as_of: asOf.value });
        toast(`Billing run: ${r.renewed} renewed, ${r.paid} paid, ${r.failed} failed, ${r.retried} retried.`, r.failed ? 'warn' : 'good'); render();
      }), 'secondary'))))) : null;
  const checksPanel = h('div', { id: 'bl-checks' }, moneyChecksPanel(checks, render));

  const jumps = [['bl-att', 'Needs attention', attN], ['bl-inv', 'Invoices'], ['bl-mem', 'Memberships'], ['bl-plans', 'Plans'], ['bl-links', 'Pay links'], ['bl-checks', 'Money checks'], state.testMode ? ['bl-clock', 'Billing clock'] : null].filter(Boolean);
  fill(main,
    header('Billing', 'Money in, money owed, and who is on which plan.'),
    numbers, monthNote,
    h('nav', { class: 'tm-jump', 'aria-label': 'Billing sections' }, jumps.map(([id, label, n]) => h('button', { type: 'button', onClick: () => jumpTo(id) }, label, n ? h('span', { class: 'warn-text', style: 'margin-left:6px' }, String(n)) : null))),
    checks.needs_look ? checksPanel : null,
    attPanel, invPanel, memPanel, planPanel, linksPanel,
    checks.needs_look ? null : checksPanel,
    testPanel);
}

// ---------- Programs ----------
// The Programs page and the program builder live in programs-coach.js.

// ---------- Integrations ----------
async function viewIntegrations(main) {
  const [keys, hooks, types] = await Promise.all([get('/v1/api-keys'), get('/v1/webhooks'), get('/v1/event-types')]);
  const label = input({ placeholder: 'e.g. Website booking form' });
  const revealed = h('div');
  const keysPanel = panel('API keys', { subtitle: 'Let your other systems read and update clients, billing and programs.' },
    h('form', { class: 'row', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const k = await post('/v1/api-keys', { label: label.value });
      fill(revealed, h('div', { class: 'stack', style: 'margin-top:4px' },
        h('span', { class: 'strong' }, `Copy your key for ${k.label} now. You won't see it again.`),
        h('div', { class: 'secret mono' }, k.secret),
        h('div', null, btn('Copy key', async () => { await navigator.clipboard.writeText(k.secret); toast('Key copied.'); }, 'outline'))));
      label.value = ''; await refreshKeys();
    }); } }, h('div', { class: 'grow' }, field('Key label', label)), h('div', { style: 'align-self:flex-end' }, btn('Create key', null, 'primary', { type: 'submit' }))),
    revealed);
  const keyList = h('div');
  async function refreshKeys() {
    const { data } = await get('/v1/api-keys');
    fill(keyList, ...(data.length ? data.map((k) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, k.label), h('span', { class: 'mono muted' }, `${k.prefix}…`), h('span', { class: 'small muted' }, k.revoked_at ? `Revoked ${date(k.revoked_at)}` : `Last used: ${ago(k.last_used_at)}`)),
      k.revoked_at ? badge('revoked') : btn('Revoke', (e) => { if (confirm(`Revoke ${k.label}? Systems using it lose access immediately.`)) busy(e.currentTarget, async () => { await post(`/v1/api-keys/${k.id}/revoke`); toast('Key revoked.'); refreshKeys(); }); }, 'secondary')))
      : [h('p', { class: 'muted' }, 'No keys yet. Create one to connect your first system.')]));
  }
  keysPanel.append(keyList); refreshKeys();

  const url = input({ type: 'url', placeholder: 'https://your-system.example.com/hooks' });
  const checks = types.data.map((t) => h('label', { class: 'row small', style: 'gap:8px;min-height:32px' }, h('input', { type: 'checkbox', value: t, checked: true }), h('span', { class: 'mono' }, t)));
  const hooksPanel = panel('Webhooks', { subtitle: 'We send a signed event to your URL the moment something happens here.' },
    ...hooks.data.map((w) => {
      const log = h('div');
      return h('div', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px' },
        h('div', { class: 'row wrap' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'mono' }, w.url), h('span', { class: 'small muted' }, w.events.includes('*') ? 'All events' : w.events.join(', '))),
          h('button', { type: 'button', class: 'dp-toggle', 'aria-pressed': String(w.active), 'aria-label': `Webhook to ${w.url}`, onClick: (e) => busy(e.currentTarget, async () => { await patch(`/v1/webhooks/${w.id}`, { active: !w.active }); render(); }) }, w.active ? 'On' : 'Off'),
          btn('Deliveries', async (e) => busy(e.currentTarget, async () => {
            const { data } = await get(`/v1/webhooks/${w.id}/deliveries`);
            fill(log, ...(data.length ? data.map((d) => h('div', { class: 'list-item small' }, h('span', { class: 'mono grow' }, d.event_type), h('span', { class: 'muted' }, d.last_error ?? (d.response_code ? `HTTP ${d.response_code}` : '')), badge(d.status === 'succeeded' ? 'delivered' : d.status === 'pending' ? 'retrying' : d.status), h('span', { class: 'muted' }, ago(d.created_at)))) : [h('p', { class: 'small muted' }, 'No deliveries yet.')]));
          }), 'ghost'),
          btn('Delete', (e) => { if (confirm('Delete this webhook?')) busy(e.currentTarget, async () => { await del(`/v1/webhooks/${w.id}`); toast('Webhook deleted.'); render(); }); }, 'ghost')),
        h('div', { class: 'small muted' }, 'Signing secret: ', h('span', { class: 'mono' }, w.secret)), log);
    }),
    h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const events = checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
      await post('/v1/webhooks', { url: url.value, events: events.length === types.data.length ? ['*'] : events }); toast('Webhook added.'); render();
    }); } }, field('Destination URL', url), h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'dp-label' }, 'Events to send'), h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0 16px' }, checks)),
      h('div', null, btn('Add webhook', null, 'secondary', { type: 'submit' }))));

  const docs = panel('API reference', { subtitle: 'Send your key as a header: Authorization: Bearer dp_live_…' },
    h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--outline', href: '/v1/openapi.json', target: '_blank', rel: 'noopener' }, 'Open API spec (OpenAPI 3.1)')),
    h('pre', { class: 'secret mono', style: 'border-color:var(--line);white-space:pre-wrap;margin:0' },
      `curl ${location.origin}/v1/clients \\\n  -H "Authorization: Bearer dp_live_…"\n\ncurl -X POST ${location.origin}/v1/clients \\\n  -H "Authorization: Bearer dp_live_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"Jordan Lee","email":"jordan@example.com","plan_id":"plan_…"}'`));

  const outbox = await get('/v1/outbox');
  const modeText = { test: 'No email service is connected, so messages stay here and are not sent. Add RESEND_API_KEY on the server to start sending.',
    restricted: `Sending through Resend, but only to ${outbox.only_to}. Everything else is held here.`, live: `Sending through Resend${outbox.from ? ` as ${outbox.from}` : ''}.` };
  const statusText = { logged: ' (not sent)', failed: ' (failed)', held: ' (held)', sent: '' };
  const testTo = input({ type: 'email', value: state.user?.email || '', 'aria-label': 'Send a test email to' });
  const outPanel = panel('Email outbox', { subtitle: 'Every email the platform sends: sign-in codes, welcome emails, booking changes, invoices and receipts.' },
    h('p', { class: 'small', style: `margin:0;color:${outbox.mode === 'test' ? 'var(--amber)' : 'var(--green-bright)'}` }, modeText[outbox.mode] || ''),
    h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, testTo, btn('Send test email', async (e) => {
      e.target.disabled = true;
      try { await post('/v1/outbox/test', { to: testTo.value }); toast('Test email sent. Check the inbox.'); render(); }
      catch (err) { toast(err.message, 'warn'); } finally { e.target.disabled = false; }
    }, 'outline')),
    outbox.data.length ? outbox.data.slice(0, 15).map((m) => h('details', { class: 'list-item', style: 'display:block' }, h('summary', { class: 'small', style: 'cursor:pointer' }, `${ago(m.created_at)} · ${m.to_email} · ${m.subject}${statusText[m.status] ?? ` (${m.status})`}`), m.error ? h('p', { class: 'small', style: 'color:var(--amber);margin:8px 0 0' }, m.error) : null, h('pre', { class: 'small muted', style: 'white-space:pre-wrap;margin:8px 0 0' }, m.body))) : h('p', { class: 'muted' }, 'No emails yet.'));
  const texts = await get('/v1/texts');
  const textMode = { test: 'No text service is connected, so texts stay here and are not sent. Add your Twilio settings on the server to start sending.',
    restricted: `Sending through Twilio, but only to ${texts.only_to}. Everything else is held here.`, live: 'Sending through Twilio.' };
  const textStatus = { logged: ' (not sent)', failed: ' (failed)', held: ' (held)', sent: '', received: '' };
  const testPhone = input({ type: 'tel', placeholder: '(512) 555-0100', 'aria-label': 'Send a test text to' });
  const textPanel = panel('Texts', { subtitle: 'Every text sent to parents, and their replies. Parents turn texts on in the parent portal and can reply STOP at any time.' },
    h('p', { class: 'small', style: `margin:0;color:${texts.mode === 'test' ? 'var(--amber)' : 'var(--green-bright)'}` }, textMode[texts.mode] || ''),
    texts.mode === 'test' ? null : h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, testPhone, btn('Send test text', (e) => busy(e.currentTarget, async () => {
      try { await post('/v1/texts/test', { to: testPhone.value }); toast('Test text sent.'); render(); } catch (err) { toast(err.message, 'warn'); }
    }), 'outline')),
    texts.data.length ? texts.data.slice(0, 15).map((m) => h('details', { class: 'list-item', style: 'display:block' }, h('summary', { class: 'small', style: 'cursor:pointer' }, `${ago(m.created_at)} · ${m.direction === 'in' ? 'From' : 'To'} ${phoneText(m.phone)}${textStatus[m.status] ?? ` (${m.status})`}`), m.error ? h('p', { class: 'small', style: 'color:var(--amber);margin:8px 0 0' }, m.error) : null, h('p', { class: 'small muted', style: 'white-space:pre-wrap;margin:8px 0 0' }, m.body))) : h('p', { class: 'muted' }, 'No texts yet.'));
  fill(main, header('API & integrations', 'Connect Diamond Protocol to your other systems.'), h('div', { class: 'grid grid-2' }, keysPanel, hooksPanel), docs, outPanel, textPanel);
}

// ---------- Point of sale ----------
const remember = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };
const setupLink = () => h('a', { class: 'dp-btn dp-btn--secondary', href: '#/sell/setup' }, 'Locations, products & readers');

// The sale in progress lives here and in this tab's session storage, so it survives leaving the screen or a reload.
// requestId goes with the charge: pressing Charge twice (or a retry after a dropped connection) can't charge twice.
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const emptySale = () => ({ clientId: '', cart: [], custom: null, discount: null, requestId: newRequestId() });
let saleDraft = null;
function loadSale() {
  if (saleDraft) return saleDraft;
  try { saleDraft = JSON.parse(sessionStorage.getItem('dp_sale')); } catch { saleDraft = null; }
  if (!saleDraft || !Array.isArray(saleDraft.cart)) saleDraft = emptySale();
  return saleDraft;
}
const storeSale = () => { try { sessionStorage.setItem('dp_sale', JSON.stringify(saleDraft)); } catch { /* ignore */ } };
const resetSale = (clientId = '') => { saleDraft = { ...emptySale(), clientId }; storeSale(); return saleDraft; };
const forgetSale = () => { saleDraft = null; try { sessionStorage.removeItem('dp_sale'); } catch { /* ignore */ } };
const signedMoney = (c) => (c < 0 ? `-${money(-c)}` : money(c));
const MEMBER_WORD = { active: 'Member', trialing: 'Free trial', past_due: 'Member, payment past due', paused: 'Membership paused' };
// Where a receipt goes by default: the family's primary parent, or the client's own email.
const receiptAddress = (c) => (c ? (c.family ? c.parents?.[0]?.email : c.email) ?? null : null);

async function viewSell(main) {
  const role = state.user.role, seesTakings = role !== 'coach';
  const [locs, prods, clients, readers, plans, settings] = await Promise.all([get('/v1/locations'), get('/v1/products'), get('/v1/clients'), get('/v1/readers'), get('/v1/plans'), get('/v1/settings').catch(() => ({}))]);
  if (!locs.data.length || !prods.data.length) {
    fill(main, header('Point of sale', 'Take payments at the facility, in the park and at clients\' homes.', setupLink()),
      h('div', { class: 'empty' }, h('p', null, `Add ${!locs.data.length ? 'the places you train' : ''}${!locs.data.length && !prods.data.length ? ' and ' : ''}${!prods.data.length ? 'what you sell (sessions, packs, gear)' : ''} to start taking payments.`),
        h('p', { style: 'margin-top:12px' }, h('a', { class: 'dp-btn dp-btn--primary', href: '#/sell/setup' }, 'Set up point of sale'))));
    return;
  }
  const discountMax = role === 'owner' ? 100 : Number(settings.staff_discount_max_pct ?? 0);
  if (settings.timezone) tzName = settings.timezone;
  const cartItem = (key) => { const [pid, vid] = key.split(':'); const p = prods.data.find((x) => x.id === pid); if (!p) return null; const size = vid && (p.variants ?? []).find((x) => x.id === vid && x.active); if (vid && !size) return null; return { p, vid, name: size ? `${p.name} (${size.name})` : p.name }; };
  const sale = loadSale();
  sale.cart = sale.cart.filter(([key]) => cartItem(key));        // anything no longer sold drops off
  if (sale.clientId && !clients.data.some((c) => c.id === sale.clientId)) sale.clientId = '';
  // "Sell to" from a client profile: if someone else's sale is still open, say so before it could be charged to the wrong person.
  const preClient = hashQuery().get('client');
  let clash = null;
  if (preClient && preClient !== sale.clientId && clients.data.some((c) => c.id === preClient)) {
    if (sale.cart.length || sale.custom) clash = preClient; else sale.clientId = preClient;
  }
  storeSale();
  const client = () => clients.data.find((c) => c.id === sale.clientId);
  const firstName = (c) => c.name.split(' ')[0];

  // ----- Where and who -----
  const locSel = select(locs.data.map((l) => [l.id, l.name]), { value: locs.data.some((l) => l.id === remember.get('dp_location')) ? remember.get('dp_location') : locs.data[0].id, 'aria-label': 'Location' });
  locSel.addEventListener('change', () => { remember.set('dp_location', locSel.value); drawSale(); drawTakings(); });
  const clashBox = h('div');
  const clientBox = h('div', { class: 'stack-tight' });
  const search = input({ type: 'search', placeholder: 'Name, parent, email or phone', 'aria-label': 'Find a client', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'pos-hits', 'aria-autocomplete': 'list' });
  const hitsBox = h('div', { id: 'pos-hits', role: 'listbox', class: 'pos-hits' });
  let hits = [], active = 0;
  const digits = (x) => String(x ?? '').replace(/\D/g, '');
  const matchClient = (c, q) => {
    const d = digits(q);
    return [c.name, c.email, c.athlete_id, c.family?.name, ...(c.parents ?? []).flatMap((p) => [p.name, p.email])].some((x) => x && x.toLowerCase().includes(q))
      || (d.length >= 4 && [c.phone, ...(c.parents ?? []).map((p) => p.phone)].some((x) => digits(x).includes(d)));
  };
  function drawHits() {
    const q = search.value.trim().toLowerCase();
    hits = q ? clients.data.filter((c) => matchClient(c, q)).slice(0, 8) : [];
    active = Math.min(active, Math.max(hits.length - 1, 0));
    search.setAttribute('aria-expanded', hits.length ? 'true' : 'false');
    fill(hitsBox, q && !hits.length ? h('p', { class: 'small muted', style: 'margin:0' }, 'No client matches. Check the spelling, or sell to a walk-in.')
      : hits.map((c, i) => h('button', { type: 'button', role: 'option', id: `pos-hit-${i}`, 'aria-selected': i === active ? 'true' : 'false', class: 'pos-hit', onClick: () => pickClient(c) },
        h('span', { class: 'strong' }, c.name), h('span', { class: 'small muted' }, [c.family?.name, c.parents?.[0]?.name].filter(Boolean).join(' · ') || c.email || ''))));
    if (hits.length) search.setAttribute('aria-activedescendant', `pos-hit-${active}`); else search.removeAttribute('aria-activedescendant');
  }
  search.addEventListener('input', () => { active = 0; drawHits(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && hits.length) { active = (active + 1) % hits.length; drawHits(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && hits.length) { active = (active - 1 + hits.length) % hits.length; drawHits(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); pickClient(hits[active]); }
    else if (e.key === 'Escape') { search.value = ''; drawHits(); }
  });
  function pickClient(c) { sale.clientId = c?.id ?? ''; search.value = ''; hits = []; receipt.to = null; receipt.on = null; editingReceipt = false; receiptTo.value = ''; changed(); }   // a typed receipt address never carries over to someone else
  function drawClient() {
    const c = client();
    if (!c) return fill(clientBox, search, hitsBox, h('span', { class: 'small muted' }, 'Walk-in unless you choose someone. Packs and memberships need a client.'));
    const sub = c.subscription && c.subscription.status !== 'canceled' ? c.subscription : null;
    fill(clientBox, h('div', { class: 'pos-client' },
      h('div', { class: 'grow stack-tight' },
        h('span', { class: 'strong' }, c.name),
        h('span', { class: 'small muted' }, sub ? `${MEMBER_WORD[sub.status] ?? 'Member'}: ${sub.plan_name}` : 'No membership'),
        h('span', { class: 'small muted' }, `${c.credits.group} group · ${c.credits.private} private ${c.credits.group + c.credits.private === 1 ? 'session' : 'sessions'} left · ${c.has_card ? 'Card on file' : 'No card on file'}`)),
      btn('Walk-in instead', () => pickClient(null), 'ghost')));
  }
  function drawClash() {
    if (!clash) return fill(clashBox);
    const other = client(), next = clients.data.find((c) => c.id === clash);
    fill(clashBox, h('div', { class: 'dp-panel', style: 'border-color:var(--amber);gap:8px' },
      h('p', { class: 'warn-text', style: 'margin:0' }, `A sale for ${other ? other.name : 'a walk-in'} is still open. Clear it before selling to ${next.name}, or keep it.`),
      h('div', { class: 'row wrap' },
        btn(`Clear sale and sell to ${firstName(next)}`, () => { resetSale(clash); Object.assign(sale, saleDraft); clash = null; changed(); }, 'secondary'),
        btn(`Keep ${other ? `${firstName(other)}'s` : 'this'} sale`, () => { clash = null; drawClash(); }, 'ghost'))));
  }

  // ----- Products -----
  const inCart = (pid) => sale.cart.reduce((n, [key, q]) => n + (key.split(':')[0] === pid ? q : 0), 0);
  const sizeBox = h('div');
  const addToCart = (key) => { const line = sale.cart.find(([k]) => k === key); if (line) line[1]++; else sale.cart.push([key, 1]); fill(sizeBox); changed(); };
  const left = (n) => (n <= 0 ? h('span', { class: 'small warn-text' }, 'Out of stock') : h('span', { class: `small ${n <= 3 ? 'warn-text' : 'muted'}` }, `${n} left`));
  const pickSize = (p, sizes) => fill(sizeBox, h('div', { class: 'dp-panel', style: 'gap:10px' },
    h('div', { class: 'row' }, h('span', { class: 'grow strong' }, `Which size of ${p.name}?`), btn('Cancel', () => fill(sizeBox), 'ghost')),
    h('div', { class: 'row wrap', style: 'gap:8px' }, sizes.map((x) => h('button', { type: 'button', class: 'dp-btn dp-btn--secondary', style: 'min-height:52px;min-width:72px;flex-direction:column;gap:2px', onClick: () => addToCart(`${p.id}:${x.id}`) },
      h('span', { class: 'strong' }, x.name), p.track_stock ? left(x.on_hand) : null)))));
  const prodSearch = input({ type: 'search', placeholder: 'Find a product', 'aria-label': 'Find a product' });
  prodSearch.addEventListener('input', () => drawProducts());
  const productGrid = h('div', { class: 'pos-tiles' });
  function drawProducts() {
    const q = prodSearch.value.trim().toLowerCase();
    const shown = prods.data.filter((p) => !q || p.name.toLowerCase().includes(q));
    fill(productGrid, shown.length ? shown.map((p) => {
      const sizes = (p.variants ?? []).filter((x) => x.active), n = inCart(p.id);
      return h('button', { type: 'button', class: 'dp-panel pos-tile', 'aria-label': `${p.name}, ${money(p.price_cents)}${n ? `, ${n} in the sale` : ''}`, onClick: () => (sizes.length > 1 ? pickSize(p, sizes) : addToCart(sizes.length ? `${p.id}:${sizes[0].id}` : p.id)) },
        n ? h('span', { class: 'pos-count', 'aria-hidden': 'true' }, n) : null,
        h('span', { class: 'strong' }, p.name), h('span', { class: 'pos-price' }, money(p.price_cents)),
        p.kind === 'pack' ? h('span', { class: 'small muted' }, `${p.sessions} ${p.credit_type} sessions`) : null,
        sizes.length > 1 ? h('span', { class: 'small muted' }, sizes.map((x) => x.name).join(' · ')) : null,
        p.track_stock ? left(p.on_hand) : null);
    }) : h('p', { class: 'muted' }, 'No product matches.'));
  }
  async function refreshStock() { if (!prods.data.some((p) => p.track_stock)) return; prods.data = (await get('/v1/products')).data; drawProducts(); }
  const customDesc = input({ placeholder: 'Description', 'aria-label': 'Custom item description', maxlength: '80' }), customAmt = input({ type: 'number', min: '0.01', step: '0.01', inputmode: 'decimal', placeholder: '$', 'aria-label': 'Custom amount in dollars', style: 'width:110px' });
  const customForm = h('form', { class: 'row wrap', onSubmit: (e) => { e.preventDefault(); const cents = Math.round(Number(customAmt.value) * 100); if (!customDesc.value.trim() || !(cents > 0)) return toast('Enter a description and an amount above $0.', 'warn'); sale.custom = { description: customDesc.value.trim(), amount_cents: cents }; customDesc.value = ''; customAmt.value = ''; changed(); } },
    h('div', { class: 'grow', style: 'min-width:160px' }, customDesc), customAmt, btn('Add', null, 'secondary', { type: 'submit' }));

  // ----- Monthly memberships (renew on the saved card) -----
  const memberBox = h('div');
  const planList = plans.data.filter((p) => p.active !== false && p.price_cents != null);
  const planGrid = h('div', { class: 'pos-tiles' });
  function drawPlans() {
    const c = client(), sub = c?.subscription && c.subscription.status !== 'canceled' ? c.subscription : null;
    fill(planGrid, planList.map((p) => h('button', { type: 'button', class: 'dp-panel pos-tile', disabled: !!sub, title: sub ? `${firstName(c)} already has ${sub.plan_name}` : null, onClick: () => startMembership(p) },
      h('span', { class: 'strong' }, p.name), h('span', { class: 'pos-price' }, money(p.price_cents), h('span', { class: 'small muted', style: 'font:400 13px var(--font-sans)' }, ' /month')),
      h('span', { class: 'small muted' }, sub ? `${firstName(c)} already has ${sub.plan_name}` : p.trial_days ? `${p.trial_days}-day free trial` : 'Billed monthly'))));
  }
  function startMembership(p) {
    const c = client();
    if (!c) { toast('Choose who the membership is for first.', 'warn'); search.focus(); return; }
    const first = firstName(c);
    const when = p.trial_days ? `Free for ${p.trial_days} day${p.trial_days === 1 ? '' : 's'}, then ${money(p.price_cents)} every month.` : `${money(p.price_cents)} today, then every month.`;
    const done = (sub) => { toast(sub.status === 'trialing' ? `${first} is on ${p.name}. The trial ends ${date(sub.trial_ends_at)}.` : `${first} is on ${p.name}. Renews ${date(sub.current_period_end)}.`); c.subscription = { status: sub.status, plan_name: p.name }; fill(memberBox); drawClient(); drawPlans(); };
    const start = btn(p.trial_days ? 'Start free trial' : `Charge ${money(p.price_cents)} and start`, (e) => busy(e.currentTarget, async () => {
      try { done(await post(`/v1/clients/${c.id}/subscription`, { plan_id: p.id })); } catch (err) { toast(err.message, 'warn'); }
    }), 'secondary');
    const needCard = h('div', { class: 'stack' },
      h('p', { class: 'warn-text', style: 'margin:0' }, `${first} has no card on file. Monthly memberships renew on a saved card.`),
      h('div', { class: 'row wrap' },
        btn('Get a secure card link', (e) => busy(e.currentTarget, async () => {
          try {
            const { url } = await post(`/v1/clients/${c.id}/card/setup-link`);
            fill(needCard, h('p', { style: 'margin:0' }, 'Send this link to the client or parent. They add their card on Stripe\'s secure page, then you start the membership here.'), h('input', { class: 'dp-input mono', readonly: true, value: url, onFocus: (ev) => ev.target.select() }));
          } catch (err) { toast(err.message, 'warn'); }
        }), 'outline'),
        state.payments.can_simulate ? btn('Add test card', (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${c.id}/card/test`); c.has_card = true; drawClient(); startMembership(p); }), 'ghost') : null),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Or charge a first sale by Tap to Pay with "Save this card" ticked, then start the membership.'));
    fill(memberBox, panel(`Start ${p.name}`, { subtitle: `${c.name} · ${when}` },
      c.has_card ? h('div', { class: 'stack' }, h('p', { style: 'margin:0' }, 'Bills the card on file every month.'), h('div', { class: 'row wrap' }, start, btn('Cancel', () => fill(memberBox), 'ghost'))) : needCard));
    memberBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ----- The sale -----
  const subtotal = () => sale.cart.reduce((t, [key, q]) => t + cartItem(key).p.price_cents * q, 0) + (sale.custom?.amount_cents || 0);
  const discountCents = () => { const d = sale.discount; if (!d || !(d.value > 0)) return 0; return d.type === 'percent' ? Math.round(subtotal() * d.value / 100) : d.value; };
  const total = () => Math.max(subtotal() - discountCents(), 0);
  const itemCount = () => sale.cart.reduce((n, [, q]) => n + q, 0) + (sale.custom ? 1 : 0);
  const method = { value: remember.get('dp_method') || 'tap_to_pay' };
  const saveCard = h('input', { type: 'checkbox', checked: true });
  const receipt = { on: null, to: null };           // on: null = the default for this client; to: an address typed at the counter
  const receiptBox = h('input', { type: 'checkbox', onChange: (e) => { receipt.on = e.target.checked; drawSale(); } });
  const receiptTo = input({ type: 'email', placeholder: 'Email for the receipt', 'aria-label': 'Email for the receipt', autocomplete: 'off', onInput: (e) => { receipt.to = e.target.value.trim() || null; } });
  let editingReceipt = false;
  const cashIn = input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: '$', 'aria-label': 'Cash received in dollars', style: 'width:120px' });
  const changeBox = h('span', { class: 'strong' });
  cashIn.addEventListener('input', () => drawChange());
  const readerSel = select([], { 'aria-label': 'Reader' });
  const cartBox = h('div', { class: 'stack-tight' }), totalsBox = h('div', { class: 'stack-tight' }), methodBox = h('div', { class: 'stack' }), discountBox = h('div'), err = h('div', { class: 'dp-error', role: 'alert' });
  const charge = btn('Charge', () => startSale(), 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:56px;font-size:17px' });
  const progress = h('div'), lastBox = h('div');
  let cleared = null, clearedTimer;
  const salePanel = panel('Sale', {}, cartBox, discountBox, totalsBox, methodBox, err, charge);
  salePanel.id = 'pos-sale';

  function drawCart() {
    fill(cartBox, sale.cart.map(([key, q], i) => {
      const { p, name } = cartItem(key);
      return h('div', { class: 'row pos-line' }, h('span', { class: 'grow' }, name),
        h('button', { type: 'button', class: 'dp-btn dp-btn--ghost pos-qty', 'aria-label': `One fewer ${name}`, onClick: () => { if (q > 1) sale.cart[i][1]--; else sale.cart.splice(i, 1); changed(); } }, '−'),
        h('span', { style: 'min-width:24px;text-align:center', 'aria-label': `${q} of ${name}` }, q),
        h('button', { type: 'button', class: 'dp-btn dp-btn--ghost pos-qty', 'aria-label': `One more ${name}`, onClick: () => { sale.cart[i][1] = Math.min(q + 1, 99); changed(); } }, '+'),
        h('span', { style: 'min-width:72px;text-align:right' }, money(p.price_cents * q)));
    }),
    sale.custom ? h('div', { class: 'row pos-line' }, h('span', { class: 'grow' }, sale.custom.description), btn('Remove', () => { sale.custom = null; changed(); }, 'ghost'), h('span', { style: 'min-width:72px;text-align:right' }, money(sale.custom.amount_cents))) : null,
    !itemCount() ? h('p', { class: 'muted', style: 'margin:0' }, cleared ? '' : 'Tap a product to add it.') : null,
    cleared ? h('div', { class: 'row small', style: 'gap:8px' }, h('span', { class: 'grow muted' }, 'Sale cleared.'), btn('Undo', () => { Object.assign(sale, cleared); cleared = null; clearTimeout(clearedTimer); changed(); }, 'ghost')) : null,
    itemCount() ? h('div', { class: 'row' }, h('span', { class: 'grow' }), btn('Clear sale', () => {
      cleared = JSON.parse(JSON.stringify({ cart: sale.cart, custom: sale.custom, discount: sale.discount }));
      Object.assign(sale, { cart: [], custom: null, discount: null }); clearTimeout(clearedTimer); clearedTimer = setTimeout(() => { cleared = null; drawCart(); }, 10000); changed();
    }, 'ghost')) : null);
  }
  function drawDiscount() {
    if (!itemCount() || !(discountMax > 0)) return fill(discountBox);
    const d = sale.discount;
    if (!d) return fill(discountBox, h('div', { class: 'row' }, btn('Add discount', () => { sale.discount = { type: 'percent', value: 0, reason: '' }; changed(); setTimeout(() => discountBox.querySelector('input')?.focus(), 0); }, 'ghost')));
    const typeBtn = (t, label) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': d.type === t ? 'true' : 'false', onClick: () => { if (d.type !== t) { d.type = t; d.value = 0; changed(); } } }, label);
    const val = input({ type: 'number', inputmode: 'decimal', min: d.type === 'percent' ? '1' : '0.01', max: d.type === 'percent' ? String(Math.min(discountMax, 99)) : null, step: d.type === 'percent' ? '1' : '0.01',
      value: d.value ? (d.type === 'percent' ? String(d.value) : (d.value / 100).toFixed(2)) : '', 'aria-label': d.type === 'percent' ? 'Discount percent' : 'Discount in dollars', style: 'width:100px' });
    val.addEventListener('input', () => { const n = Number(val.value); d.value = d.type === 'percent' ? Math.floor(n) || 0 : Math.round(n * 100) || 0; storeSale(); drawTotals(); drawDiscountNote(); });
    const why = input({ value: d.reason ?? '', placeholder: 'Why? Like "Sibling discount"', 'aria-label': 'Reason for the discount', maxlength: '80' });
    why.addEventListener('input', () => { d.reason = why.value; storeSale(); drawDiscountNote(); });
    const note = h('p', { class: 'small', style: 'margin:0' });
    function drawDiscountNote() {
      const cents = discountCents(), sub = subtotal();
      const msg = cents >= sub ? `A discount has to leave something to pay (the sale is ${money(sub)}).`
        : role !== 'owner' && (d.type === 'percent' ? d.value > discountMax : cents * 100 > sub * discountMax) ? `You can give up to ${discountMax}% off (${money(Math.floor(sub * discountMax / 100))} here). Ask the owner for more.`
          : cents && !d.reason?.trim() ? 'Add a reason. It shows on the receipt and in the sales list.' : '';
      note.textContent = msg || (role !== 'owner' ? `You can give up to ${discountMax}% off.` : '');
      note.className = `small ${msg ? 'warn-text' : 'muted'}`;
    }
    drawDiscountNote();
    fill(discountBox, h('div', { class: 'stack-tight', style: 'border-top:1px solid var(--line-subtle);padding-top:10px' },
      h('div', { class: 'row wrap', style: 'gap:8px' }, h('span', { class: 'dp-label grow' }, 'Discount'), typeBtn('percent', '% off'), typeBtn('amount', '$ off'), btn('Remove', () => { sale.discount = null; changed(); }, 'ghost')),
      h('div', { class: 'row wrap', style: 'gap:8px' }, val, h('div', { class: 'grow', style: 'min-width:180px' }, why)), note));
  }
  function drawTotals() {
    const cents = discountCents();
    fill(totalsBox, h('div', { class: 'stack-tight', style: 'border-top:1px solid var(--line-subtle);padding-top:12px' },
      cents ? h('div', { class: 'row small muted' }, h('span', { class: 'grow' }, 'Subtotal'), h('span', null, money(subtotal()))) : null,
      cents ? h('div', { class: 'row small muted' }, h('span', { class: 'grow' }, `Discount${sale.discount.type === 'percent' ? ` ${sale.discount.value}%` : ''}`), h('span', null, signedMoney(-cents))) : null,
      h('div', { class: 'row' }, h('span', { class: 'grow muted' }, 'Total'), h('span', { style: 'font:600 44px/1 var(--font-display)' }, money(total())))));
    charge.textContent = !total() ? 'Charge' : method.value === 'cash' ? `Record ${money(total())} cash` : `Charge ${money(total())}`;
    charge.disabled = !total() || !!clash;
    drawChange(); drawBar();
  }
  function drawChange() {
    const got = Math.round(Number(cashIn.value) * 100);
    changeBox.textContent = !cashIn.value ? '' : got < total() ? `${money(total() - got)} short` : `Change: ${money(got - total())}`;
    changeBox.className = got < total() && cashIn.value ? 'strong warn-text' : 'strong';
  }
  function drawMethods() {
    const c = client(), loc = locs.data.find((l) => l.id === locSel.value);
    const here = readers.data.filter((r) => r.location_id === loc?.id);
    const keep = readerSel.value;
    fill(readerSel, here.map((r) => h('option', { value: r.id, selected: r.id === keep }, r.label)));
    const options = [
      ['tap_to_pay', 'Tap to Pay on iPhone', loc?.card_ready ? 'Client taps their card or phone on your iPhone.' : `Add an address to ${loc?.name} in setup first.`, !loc?.card_ready],
      ['reader', 'Front-desk reader', here.length ? (here.length === 1 ? `Sends the charge to ${here[0].label}.` : 'Sends the charge to the reader you choose.') : `No reader at ${loc?.name}. Register one in setup.`, !here.length],
      ['card_on_file', 'Card on file', c?.has_card ? 'Charges their saved card now.' : c ? 'No saved card for this client.' : 'Choose a client with a saved card.', !c?.has_card],
      ['cash', 'Cash', 'Record a cash payment.', false]
    ];
    if (options.find(([k]) => k === method.value)?.[3]) method.value = options.find((o) => !o[3])[0];
    const addr = receipt.to ?? receiptAddress(c);
    const receiptOn = receipt.on ?? !!receiptAddress(c);
    receiptBox.checked = receiptOn;
    if (receipt.to && receiptTo.value !== receipt.to) receiptTo.value = receipt.to;
    fill(methodBox, h('div', { class: 'dp-label' }, 'Payment'), ...options.map(([k, label, hint, disabled]) => h('label', { class: 'row', style: `gap:10px;min-height:44px;${disabled ? 'opacity:.5' : 'cursor:pointer'}` },
      h('input', { type: 'radio', name: 'method', value: k, checked: method.value === k, disabled, onChange: () => { method.value = k; remember.set('dp_method', k); drawSale(); } }),
      h('span', { class: 'stack-tight' }, h('span', { class: 'strong' }, label), h('span', { class: 'small muted' }, hint)))),
      method.value === 'reader' && here.length > 1 ? h('div', { style: 'padding-left:28px' }, readerSel) : null,
      method.value === 'cash' ? h('div', { class: 'row wrap', style: 'gap:8px;padding-left:28px' }, h('span', { class: 'small muted' }, 'Cash received'), cashIn, changeBox) : null,
      ['tap_to_pay', 'reader'].includes(method.value) && c ? h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, saveCard, h('span', null, `Save this card for ${firstName(c)}'s future payments (with their OK)`)) : null,
      h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, receiptBox, h('span', { class: 'grow' }, receiptOn && addr && !editingReceipt ? `Email a receipt to ${addr}` : 'Email a receipt'),
        receiptOn && addr && !editingReceipt ? btn('Change', (e) => { e.preventDefault(); editingReceipt = true; receiptTo.value = addr; drawSale(); setTimeout(() => receiptTo.focus(), 0); }, 'ghost') : null),
      receiptOn && (!addr || editingReceipt) ? h('div', { style: 'padding-left:28px' }, receiptTo) : null);
  }
  function drawBar() {
    const n = itemCount();
    bar.hidden = !n;
    fill(bar, h('span', { class: 'grow strong' }, `${n} ${n === 1 ? 'item' : 'items'} · ${money(total())}`),
      h('a', { class: 'dp-btn dp-btn--outline', href: '#pos-sale', onClick: (e) => { e.preventDefault(); salePanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 'Go to sale'));
  }
  const bar = h('div', { class: 'pos-bar', role: 'region', 'aria-label': 'Sale total' });
  function drawSale() { drawCart(); drawDiscount(); drawMethods(); drawTotals(); }
  function changed() { storeSale(); err.textContent = ''; drawClash(); drawClient(); drawProducts(); drawPlans(); drawSale(); }

  async function startSale() {
    err.textContent = '';
    const c = client(), d = sale.discount && discountCents() ? sale.discount : null;
    if (d && !d.reason?.trim()) { err.textContent = 'Add a reason for the discount, or remove it.'; return; }
    const receiptOn = receipt.on ?? !!receiptAddress(c);
    const body = { location_id: locSel.value, method: method.value, client_id: sale.clientId || undefined, request_id: sale.requestId,
      items: sale.cart.map(([key, quantity]) => { const [product_id, variant_id] = key.split(':'); return { product_id, variant_id, quantity }; }), custom: sale.custom || undefined,
      discount: d ? { type: d.type, value: d.value, reason: d.reason.trim() } : undefined,
      email_receipt: receiptOn, receipt_email: receiptOn && (editingReceipt || !receiptAddress(c)) ? (receipt.to || undefined) : undefined,
      save_card: saveCard.checked && !!sale.clientId, reader_id: method.value === 'reader' ? readerSel.value : undefined };
    await busy(charge, async () => {
      try { follow(await post('/v1/sales', body), body); }
      catch (e) {
        if (e.code) sale.requestId = newRequestId();      // the server answered: nothing was charged, so the next press is a new sale
        storeSale();
        err.textContent = e.code ? e.message : 'The connection dropped. Press Charge again: it won\'t charge twice.';
      }
    });
  }

  let timer;
  function follow(s, body) {
    clearTimeout(timer);
    if (s.status === 'succeeded' || s.status === 'refunded' || s.status === 'partially_refunded') {
      const cashBack = s.method === 'cash' && cashIn.value ? Math.round(Number(cashIn.value) * 100) - s.amount_cents : null;
      toast(`${money(s.amount_cents)} ${s.method === 'cash' ? 'cash recorded' : 'paid'}${s.card_last4 ? ` with card ending ${s.card_last4}` : ''}.${cashBack > 0 ? ` Give ${money(cashBack)} change.` : ''}`);
      const keepClient = sale.clientId;
      resetSale(keepClient); Object.assign(sale, saleDraft);
      receipt.on = null; receipt.to = null; editingReceipt = false; receiptTo.value = ''; cashIn.value = '';
      fill(progress); showLast(s, body); changed(); refreshRecent(); refreshStock(); drawTakings(); return;
    }
    if (s.status !== 'pending') {
      sale.requestId = newRequestId(); storeSale();
      fill(progress, h('div', { class: 'dp-panel', style: 'border-color:var(--amber)' }, h('p', { class: 'warn-text strong' }, s.status === 'canceled' ? 'Payment canceled.' : `Payment didn't go through. ${s.failure_reason ?? ''}`), h('p', { class: 'small muted' }, 'Nothing was charged. Fix the issue and charge again.')));
      refreshRecent(); return;
    }
    const simulate = state.payments.can_simulate ? h('div', { class: 'row wrap' },
      btn('Simulate approved tap', (e) => busy(e.currentTarget, async () => follow(await post(`/v1/sales/${s.id}/simulate`, { outcome: 'approved' }), body)), 'outline'),
      btn('Simulate decline', (e) => busy(e.currentTarget, async () => follow(await post(`/v1/sales/${s.id}/simulate`, { outcome: 'declined' }), body)), 'ghost')) : null;
    fill(progress, h('div', { class: 'dp-panel', style: 'border-color:var(--green-mid)' },
      h('div', { class: 'week-title', style: 'color:var(--steel)' }, `Waiting for ${money(s.amount_cents)}`),
      h('p', { class: 'muted' }, s.method === 'reader' ? `Ask the client to tap, insert or swipe on ${s.reader_label}.` : 'Open the Diamond Protocol coach app on your iPhone. The payment is waiting there for the client to tap.'),
      simulate,
      h('div', { class: 'row' }, btn('Cancel payment', (e) => busy(e.currentTarget, async () => follow(await post(`/v1/sales/${s.id}/cancel`), body)), 'secondary'))));
    progress.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    timer = setTimeout(async () => { if (!document.body.contains(progress)) return; try { follow(await post(`/v1/sales/${s.id}/sync`), body); } catch { timer = setTimeout(() => follow(s, body), 4000); } }, 3000);
  }

  // The sale just taken: undo it (for 10 minutes, the server decides), email or print the receipt.
  let lastTimer;
  function showLast(s) {
    clearTimeout(lastTimer);
    const until = s.can_undo ? Date.now() + s.undo_seconds_left * 1000 : 0;
    const draw = () => {
      const secs = Math.max(0, Math.round((until - Date.now()) / 1000));
      fill(lastBox, h('div', { class: 'dp-panel', style: 'gap:8px' },
        h('div', { class: 'row wrap' }, h('span', { class: 'grow strong' }, `Last sale: ${s.client_name ?? 'Walk-in'} · ${money(s.amount_cents)}`), badge(s.status)),
        h('p', { class: 'small muted', style: 'margin:0' }, s.receipt_sent_at ? `Receipt emailed to ${s.receipt_email}.` : 'No receipt emailed.'),
        h('div', { class: 'row wrap' },
          secs > 0 ? btn(`Undo sale (${Math.ceil(secs / 60)} min left)`, (e) => undo(s, e.currentTarget), 'outline') : null,
          btn(s.receipt_sent_at ? 'Email receipt again' : 'Email receipt', () => saleDetails(s.id), 'ghost'),
          s.receipt_url ? h('a', { class: 'dp-btn dp-btn--ghost', href: s.receipt_url, target: '_blank', rel: 'noopener' }, 'Print receipt') : null,
          btn('Close', () => { clearTimeout(lastTimer); fill(lastBox); }, 'ghost'))));
      if (secs > 0) lastTimer = setTimeout(() => { if (document.body.contains(lastBox)) draw(); }, Math.min(secs * 1000, 30000));
    };
    // The receipt goes out a moment after the sale; show the address once it has.
    draw();
    if (!s.receipt_sent_at) setTimeout(async () => { try { const fresh = await get(`/v1/sales/${s.id}`); if (fresh.receipt_sent_at && document.body.contains(lastBox) && lastBox.childElementCount) { Object.assign(s, { receipt_sent_at: fresh.receipt_sent_at, receipt_email: fresh.receipt_email }); draw(); } } catch { /* ignore */ } }, 1200);
  }
  async function undo(s, button) {
    if (!confirm(`Undo this sale? ${money(s.amount_cents)} ${s.method === 'cash' ? 'is handed back in cash' : 'goes back to the card'}, and any sessions and stock go back.`)) return;
    await busy(button, async () => {
      await post(`/v1/sales/${s.id}/undo`);
      toast(s.method === 'cash' ? `Sale undone. Hand back ${money(s.amount_cents)} in cash.` : `Sale undone. ${money(s.amount_cents)} goes back to the card.`);
      clearTimeout(lastTimer); fill(lastBox); document.getElementById('dialog')?.open && document.getElementById('dialog').close();
      refreshRecent(); refreshStock(); drawTakings(); clients.data = (await get('/v1/clients')).data; changed();
    });
  }

  // A sale's details: items, discount, refunds, receipt; undo, email or print the receipt, and (owners) refund.
  async function saleDetails(id) {
    const d = document.getElementById('dialog');
    let s;
    try { s = await get(`/v1/sales/${id}`); } catch (e) { return toast(e.message, 'warn'); }
    const when = new Date(s.completed_at ?? s.created_at).toLocaleString('en-US', { timeZone: tzName, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const row = (label, cents, cls = '') => h('div', { class: `row ${cls}` }, h('span', { class: 'grow' }, label), h('span', null, signedMoney(cents)));
    const email = input({ type: 'email', value: s.receipt_email ?? receiptAddress(clients.data.find((c) => c.id === s.client_id)) ?? '', placeholder: 'Email address', 'aria-label': 'Email the receipt to' });
    const paid = ['succeeded', 'partially_refunded', 'refunded'].includes(s.status);
    const left = s.amount_cents - s.refunded_cents;
    const refundAmt = input({ type: 'number', min: '0.01', max: (left / 100).toFixed(2), step: '0.01', inputmode: 'decimal', value: (left / 100).toFixed(2), 'aria-label': 'Refund amount in dollars', style: 'width:120px' });
    const refundWhy = input({ placeholder: 'Reason (optional)', 'aria-label': 'Reason for the refund', maxlength: '120' });
    fill(d, h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('h2', { class: 'week-title grow', style: 'color:var(--steel);margin:0' }, `${s.client_name ?? 'Walk-in'} · ${money(s.amount_cents)}`), badge(s.status)),
      h('p', { class: 'small muted', style: 'margin:0' }, [when, s.location_name, `${s.method_label}${s.card_last4 ? ` ••${s.card_last4}` : ''}`, s.created_by_name ? `Taken by ${s.created_by_name}` : null].filter(Boolean).join(' · ')),
      h('div', { class: 'stack-tight' },
        s.items.map((i) => row(`${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`, i.unit_price_cents * i.quantity)),
        s.discount_cents ? [row('Subtotal', s.subtotal_cents, 'small muted'), row(`Discount (${s.discount_reason})`, -s.discount_cents, 'small muted')] : null,
        h('div', { class: 'row strong', style: 'border-top:1px solid var(--line-subtle);padding-top:8px' }, h('span', { class: 'grow' }, 'Paid'), h('span', null, money(s.amount_cents))),
        s.refunds.map((r) => row(`${r.kind === 'undo' ? 'Undone' : 'Refunded'} ${new Date(r.created_at).toLocaleDateString('en-US', { timeZone: tzName, month: 'short', day: 'numeric' })}${r.by_name ? ` by ${r.by_name}` : ''}${r.reason && r.kind !== 'undo' ? ` · ${r.reason}` : ''}`, -r.amount_cents, 'small muted'))),
      s.status === 'failed' && s.failure_reason ? h('p', { class: 'warn-text', style: 'margin:0' }, s.failure_reason) : null,
      paid ? h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'Receipt'),
        h('p', { class: 'small muted', style: 'margin:0' }, s.receipt_sent_at ? `Emailed to ${s.receipt_email} ${ago(s.receipt_sent_at).toLowerCase()}.` : 'Not emailed yet.'),
        h('form', { class: 'row wrap', style: 'gap:8px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { const r = await post(`/v1/sales/${s.id}/receipt`, { email: email.value.trim() || undefined }); toast(`Receipt sent to ${r.receipt_to}.`); d.close(); refreshRecent(); }); } },
          h('div', { class: 'grow', style: 'min-width:200px' }, email), btn(s.receipt_sent_at ? 'Email again' : 'Email receipt', null, 'secondary', { type: 'submit' }),
          s.receipt_url ? h('a', { class: 'dp-btn dp-btn--ghost', href: s.receipt_url, target: '_blank', rel: 'noopener' }, 'Print') : null)) : null,
      s.can_undo ? h('div', { class: 'row wrap' }, btn('Undo sale', (e) => undo(s, e.currentTarget), 'outline'), h('span', { class: 'small muted' }, `For ${Math.ceil(s.undo_seconds_left / 60)} more min, because you took it.`)) : null,
      isOwner() && ['succeeded', 'partially_refunded'].includes(s.status) ? h('form', { class: 'stack-tight', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault();
        const cents = Math.round(Number(refundAmt.value) * 100);
        if (!(cents > 0) || cents > left) return toast(`Enter an amount from $0.01 to ${money(left)}.`, 'warn');
        if (!confirm(`Refund ${money(cents)}${s.method === 'cash' ? ' in cash' : ' to the card'}?${cents === left ? ' Unused sessions from a pack come off, and gear goes back on the shelf.' : ''}`)) return;
        busy(e.submitter, async () => { await post(`/v1/sales/${s.id}/refund`, { amount_cents: cents, reason: refundWhy.value.trim() || undefined }); toast(`${money(cents)} refunded.${s.method === 'cash' ? ' Hand back the cash.' : ''}`); d.close(); refreshRecent(); refreshStock(); drawTakings(); });
      } }, h('div', { class: 'dp-label' }, 'Refund'),
        h('div', { class: 'row wrap', style: 'gap:8px' }, refundAmt, h('div', { class: 'grow', style: 'min-width:180px' }, refundWhy), btn('Refund', null, 'secondary', { type: 'submit' })),
        h('span', { class: 'small muted' }, `Up to ${money(left)}.`)) : null,
      s.status === 'pending' ? h('div', { class: 'row' }, btn('Check payment', (e) => busy(e.currentTarget, async () => { const x = await post(`/v1/sales/${s.id}/sync`); d.close(); toast(`Status: ${x.status === 'pending' ? 'still waiting' : x.status}.`); refreshRecent(); }), 'secondary')) : null,
      h('div', { class: 'row' }, btn('Close', () => d.close(), 'ghost'))));
    d.addEventListener('close', () => fill(d), { once: true });
    d.showModal();
  }

  // ----- Today's takings (owners and front desk) -----
  const takingsBox = h('div');
  const takingsScope = { value: remember.get('dp_takings_scope') || 'here' };
  async function drawTakings() {
    if (!seesTakings) return;
    let t;
    try { t = await get(`/v1/sales/takings${takingsScope.value === 'here' ? `?location_id=${encodeURIComponent(locSel.value)}` : ''}`); } catch (e) { return fill(takingsBox, panel('Today', {}, h('p', { class: 'warn-text' }, e.message))); }
    const scopeBtn = (v, label) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': takingsScope.value === v ? 'true' : 'false', onClick: () => { takingsScope.value = v; remember.set('dp_takings_scope', v); drawTakings(); } }, label);
    const tile = (label, cents, detail) => h('div', { class: 'pulse-tile' }, h('span', { class: 'pulse-label' }, label), h('span', { class: 'pulse-value' }, signedMoney(cents || 0)), detail ? h('span', { class: 'pulse-detail' }, detail) : null);
    const cash = t.by_method.find((m) => m.method === 'cash');
    fill(takingsBox, panel('Today', { subtitle: `${t.location_name ?? 'All locations'} · since midnight · refunds count on the day they're made`, action: h('div', { class: 'row', style: 'gap:6px' }, scopeBtn('here', 'This location'), scopeBtn('all', 'All locations')) },
      h('div', { class: 'pulse' },
        tile('Net', t.net_cents, `${t.sales} ${t.sales === 1 ? 'sale' : 'sales'}`),
        tile('Cash to count', t.cash_cents, cash.refunds ? `${money(cash.taken_cents)} in, ${money(cash.refunded_cents)} handed back` : `${cash.sales} cash ${cash.sales === 1 ? 'sale' : 'sales'}`),
        tile('Cards', t.card_cents),
        tile('Refunds', -t.refunded_cents, `${t.refunds} ${t.refunds === 1 ? 'refund' : 'refunds'}`),
        tile('Discounts', -t.discount_cents, `${t.discounted_sales} ${t.discounted_sales === 1 ? 'sale' : 'sales'}`),
        t.online_cents ? tile('Online', t.online_cents, 'Pay links and the store') : null),
      h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:32px' }, 'By payment method'),
        h('div', { class: 'stack-tight' }, t.by_method.map((m) => h('div', { class: 'row small' }, h('span', { class: 'grow' }, `${m.label} · ${m.sales} ${m.sales === 1 ? 'sale' : 'sales'}${m.refunds ? `, ${m.refunds} ${m.refunds === 1 ? 'refund' : 'refunds'}` : ''}`), h('span', { class: 'strong' }, signedMoney(m.net_cents))))))));
  }

  // ----- Recent sales -----
  const recent = h('div', { class: 'stack-tight' });
  const recentQ = { days: 1, q: '', location: '' };
  const recentSearch = input({ type: 'search', placeholder: 'Client or item', 'aria-label': 'Search sales', style: 'max-width:240px' });
  let searchTimer;
  recentSearch.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { recentQ.q = recentSearch.value.trim(); refreshRecent(); }, 250); });
  const recentLoc = select([['', 'All locations'], ...locs.data.map((l) => [l.id, l.name])], { 'aria-label': 'Location of sales' });
  recentLoc.addEventListener('change', () => { recentQ.location = recentLoc.value; refreshRecent(); });
  const dayChips = h('div', { class: 'row tm-views' });
  const drawChips = () => fill(dayChips, [[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([n, label]) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': recentQ.days === n ? 'true' : 'false', onClick: () => { recentQ.days = n; drawChips(); refreshRecent(); } }, label)));
  async function refreshRecent() {
    try {
      const qs = new URLSearchParams({ days: String(recentQ.days), ...(recentQ.q ? { q: recentQ.q } : {}), ...(recentQ.location ? { location_id: recentQ.location } : {}) });
      drawRecent((await get(`/v1/sales?${qs}`)).data);
    } catch (e) { fill(recent, h('p', { class: 'warn-text' }, e.message), btn('Try again', () => refreshRecent(), 'ghost')); }
  }
  function drawRecent(data) {
    const span = recentQ.days === 1 ? 'today' : `in the last ${recentQ.days} days`;
    fill(recent, data.length ? data.map((x) => h('div', { class: 'list-item pos-sale-row' },
      h('button', { type: 'button', class: 'grow stack-tight pos-sale-open', onClick: () => saleDetails(x.id) },
        h('span', { class: 'strong' }, `${x.client_name ?? 'Walk-in'} · ${money(x.amount_cents)}`),
        h('span', { class: 'small muted' }, `${x.description ?? ''}${x.discount_cents ? ` · ${money(x.discount_cents)} off` : ''} · ${x.location_name} · ${x.method_label}${x.card_last4 ? ` ••${x.card_last4}` : ''} · ${ago(x.created_at)}${role !== 'coach' && x.created_by_name ? ` · ${x.created_by_name}` : ''}`),
        x.status === 'failed' && x.failure_reason ? h('span', { class: 'small warn-text' }, x.failure_reason) : null,
        x.refunded_cents && x.status === 'partially_refunded' ? h('span', { class: 'small muted' }, `${money(x.refunded_cents)} refunded`) : null),
      badge(x.status),
      x.can_undo ? btn('Undo', (e) => undo(x, e.currentTarget), 'ghost') : null))
      : h('p', { class: 'muted' }, recentQ.q ? `No sales ${span} match "${recentQ.q}".` : `No sales ${span}${role === 'coach' ? ' that you took' : ''}.`));
  }

  fill(main,
    header('Point of sale', 'Take payments at the facility, in the park and at clients\' homes.', h('div', { class: 'row wrap' }, prods.data.some((p) => p.track_stock) ? h('a', { class: 'dp-btn dp-btn--ghost', href: '#/sell/inventory' }, 'Inventory') : null, setupLink())),
    clashBox,
    h('div', { class: 'split' },
      h('div', { class: 'stack', style: 'gap:24px' },
        panel(null, {}, h('div', { class: 'form-grid' }, field('Where', locSel), h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Who'), clientBox))),
        panel('Products', { action: prods.data.length > 8 ? prodSearch : null }, productGrid, sizeBox, h('div', { class: 'dp-label', style: 'margin-top:8px' }, 'Custom amount'), customForm),
        planList.length ? panel('Monthly memberships', { subtitle: 'Choose who it\'s for above, then tap a membership. It renews on their saved card.' }, planGrid) : null,
        memberBox),
      h('div', { class: 'stack pos-side', style: 'gap:24px' }, progress, lastBox, salePanel)),
    seesTakings ? takingsBox : null,
    panel('Recent sales', { subtitle: role === 'coach' ? 'Sales you took. Tap one for details and the receipt.' : 'Tap a sale for details, the receipt and refunds.', action: h('div', { class: 'row wrap', style: 'gap:8px' }, dayChips, recentSearch, recentLoc) }, recent),
    bar);
  drawChips(); changed(); refreshRecent(); drawTakings();
}

// ---------- Inventory ----------
const MOVE_TEXT = { sale: 'Sold', refund: 'Refunded, back on the shelf', received: 'Delivery', count: 'Shelf count', adjust: 'Adjusted' };
async function viewInventory(main) {
  const [inv, prods] = await Promise.all([get('/v1/inventory'), get('/v1/products')]);
  const manage = state.user.role !== 'front_desk';
  const ask = (text, fallback = '') => { const a = prompt(text, fallback); if (a === null || a.trim() === '') return null; return a.trim(); };
  const move = (p, x, reason) => (e) => {
    const label = x ? `${p.name} (${x.name})` : p.name;
    const a = ask({ received: `How many ${label} arrived?`, count: `How many ${label} are on the shelf right now?`, adjust: `Add or take off how many ${label}? Use a minus for fewer, like -1.` }[reason]);
    if (a === null) return;
    const note = reason === 'adjust' ? prompt('Why? (Optional, like "Damaged" or "Gave to a coach")') ?? '' : '';
    busy(e.currentTarget, async () => {
      try { const r = await post(`/v1/products/${p.id}/stock`, { reason, variant_id: x?.id, quantity: Number(a), note: note || undefined }); toast(`${label}: ${r.on_hand} on hand.`); render(); }
      catch (err) { toast(err.message, 'warn'); }
    });
  };
  const count = (n, low) => h('span', { class: `dp-badge dp-badge--${n <= 0 || low ? 'warn' : 'good'}`, style: 'min-width:56px;text-align:center' }, n <= 0 ? (n < 0 ? `${n} (recount)` : 'Out') : `${n}`);
  const history = (p) => {
    const box = h('div', { class: 'stack-tight' });
    return h('details', { onToggle: async (e) => { if (!e.target.open || box.childElementCount) return; const { data } = await get(`/v1/products/${p.id}/stock`);
      fill(box, ...(data.length ? data.map((m) => h('div', { class: 'row small', style: 'gap:10px' }, h('span', { class: 'muted', style: 'width:92px;flex-shrink:0' }, ago(m.created_at)), h('span', { class: 'grow' }, `${MOVE_TEXT[m.reason]}${m.size ? ` · ${m.size}` : ''}${m.note ? ` · ${m.note}` : ''}${m.created_by ? ` · ${m.created_by}` : ''}`), h('span', { class: 'strong', style: 'min-width:40px;text-align:right' }, m.delta > 0 ? `+${m.delta}` : `${m.delta}`)))
        : [h('p', { class: 'small muted' }, 'No changes yet.')])); } },
    h('summary', { class: 'small', style: 'cursor:pointer;min-height:32px' }, 'Recent changes'), box);
  };
  const cards = inv.data.map((p) => {
    const sizes = p.variants.filter((x) => x.active);
    const rows = sizes.length ? sizes.map((x) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' }, h('span', { class: 'grow strong', style: 'flex:1 1 110px' }, x.name, x.sku ? h('span', { class: 'small muted' }, ` · ${x.sku}`) : null), count(x.on_hand, x.low),
      btn('Delivery', move(p, x, 'received'), 'outline'), btn('Count', move(p, x, 'count'), 'ghost'), btn('Adjust', move(p, x, 'adjust'), 'ghost'),
      manage ? btn('Stop selling', (e) => { if (confirm(`Stop selling ${p.name} in ${x.name}?`)) busy(e.currentTarget, async () => { await patch(`/v1/products/${p.id}/variants/${x.id}`, { active: false }); render(); }); }, 'ghost') : null))
      : [h('div', { class: 'list-item', style: 'flex-wrap:wrap' }, h('span', { class: 'grow strong' }, 'On hand'), count(p.on_hand, p.low), btn('Delivery', move(p, null, 'received'), 'outline'), btn('Count', move(p, null, 'count'), 'ghost'), btn('Adjust', move(p, null, 'adjust'), 'ghost'))];
    const sizeName = input({ placeholder: 'Like M or Youth L', 'aria-label': `New size for ${p.name}`, style: 'max-width:180px' });
    return panel(p.name, { subtitle: `${p.on_hand} on hand${sizes.length ? ` across ${sizes.length} sizes` : ''} · ${p.low_stock_at == null ? 'No low-stock warning' : `Warns at ${p.low_stock_at} or fewer${sizes.length ? ' in a size' : ''}`}` },
      ...rows,
      p.unsized_on_hand ? h('p', { class: 'small muted' }, `${p.unsized_on_hand} counted before sizes were added. Count each size to set the real numbers.`) : null,
      manage ? h('form', { class: 'row wrap', style: 'gap:8px;border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        try { await post(`/v1/products/${p.id}/variants`, { name: sizeName.value }); toast(`${sizeName.value} added. Record a delivery or count to set how many you have.`); render(); } catch (err) { toast(err.message, 'warn'); }
      }); } }, sizeName, btn('Add size', null, 'secondary', { type: 'submit' }),
        h('span', { class: 'grow' }),
        btn('Low-stock warning', (e) => { const a = prompt(`Warn on Today when ${p.name}${sizes.length ? ' in any size' : ''} is down to how many? Leave blank to turn it off.`, p.low_stock_at ?? ''); if (a === null) return; busy(e.currentTarget, async () => { try { await patch(`/v1/products/${p.id}`, { low_stock_at: a.trim() === '' ? null : Number(a) }); render(); } catch (err) { toast(err.message, 'warn'); } }); }, 'ghost'),
        btn('Stop counting', (e) => { if (confirm(`Stop counting stock for ${p.name}? Its history is kept.`)) busy(e.currentTarget, async () => { await patch(`/v1/products/${p.id}`, { track_stock: false }); render(); }); }, 'ghost')) : null,
      history(p));
  });
  const untracked = prods.data.filter((p) => !p.track_stock && ['gear', 'other'].includes(p.kind));
  const pick = select(untracked.map((p) => [p.id, p.name]), { 'aria-label': 'Product to count' });
  const startPanel = manage && untracked.length ? panel('Count another product', { subtitle: 'For gear you keep on a shelf. Sessions and packs don\'t need counting.' },
    h('div', { class: 'row wrap', style: 'gap:8px' }, pick, btn('Start counting', (e) => busy(e.currentTarget, async () => { await patch(`/v1/products/${pick.value}`, { track_stock: true, low_stock_at: 2 }); toast('Now add its sizes (if any) and record what\'s on the shelf.'); render(); }), 'secondary'))) : null;
  fill(main, header('Inventory', inv.low.length ? `${inv.low.length} running low: ${inv.low.map((x) => x.name).join(', ')}.` : 'What\'s on the shelf. Sales take stock out and full refunds put it back.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/sell' }, 'Back to point of sale')),
    ...(cards.length ? cards : [h('div', { class: 'empty' }, h('p', null, manage ? 'Nothing is counted yet. Choose a product below to start.' : 'Nothing is counted yet. Ask the owner to turn on stock counting for gear.'))]),
    startPanel);
}

// Setup forms open in the shared dialog. onSave returns a toast message; errors stay in the dialog to fix.
function setupDialog(title, fields, saveLabel, onSave, note) {
  const d = document.getElementById('dialog');
  const err = h('div', { class: 'dp-error', role: 'alert' });
  fill(d, h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    try { const msg = await onSave(); d.close(); if (msg) toast(msg); render(); } catch (x) { err.textContent = x.message; }
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel);margin:0' }, title), note ? h('p', { class: 'small muted', style: 'margin:0' }, note) : null,
    ...fields, err,
    h('div', { class: 'row wrap' }, btn(saveLabel, null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
  setTimeout(() => d.querySelector('input,select')?.focus(), 0);
}
const dollarsIn = (cents, attrs = {}) => input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: cents == null ? '' : (cents / 100).toFixed(2), ...attrs });
const toCents = (el) => (el.value.trim() === '' ? NaN : Math.round(Number(el.value) * 100));
const LOCATION_KIND = { facility: 'Facility', mobile: 'Mobile (clients\' homes)', park: 'Park', client_home: 'Client home', other: 'Other' };
const PRODUCT_KIND = [['session', 'Single session'], ['pack', 'Session pack'], ['gear', 'Gear'], ['other', 'Other']];

function locationForm(l) {
  const f = { name: input({ value: l?.name ?? '', maxlength: '80' }), kind: select(Object.entries(LOCATION_KIND), { value: l?.kind ?? 'facility' }), line1: input({ autocomplete: 'address-line1', value: l?.address_line1 ?? '' }), city: input({ autocomplete: 'address-level2', value: l?.city ?? '' }), state: input({ autocomplete: 'address-level1', maxlength: '2', placeholder: 'TX', value: l?.state ?? '' }), zip: input({ autocomplete: 'postal-code', inputmode: 'numeric', value: l?.postal_code ?? '' }) };
  setupDialog(l ? `Edit ${l.name}` : 'Add a location', [
    h('div', { class: 'form-grid' }, field('Location name', f.name), field('Type', f.kind)),
    field('Street address', f.line1),
    h('div', { class: 'form-grid cols-3' }, field('City', f.city), field('State', f.state), field('ZIP', f.zip))
  ], l ? 'Save location' : 'Add location', async () => {
    const body = { name: f.name.value, kind: f.kind.value, address_line1: f.line1.value.trim() || undefined, city: f.city.value.trim() || undefined, state: f.state.value.trim() || undefined, postal_code: f.zip.value.trim() || undefined };
    const x = l ? await patch(`/v1/locations/${l.id}`, body) : await post('/v1/locations', body);
    return x.card_ready ? `${x.name} ${l ? 'saved' : 'added'} and ready for card payments.` : `${x.name} ${l ? 'saved' : 'added'}. Add its full address to take cards there.`;
  }, 'Card payments need a street address, city, state and ZIP. For client homes, use one "Mobile" location with your business address.');
}
function productForm(p) {
  const f = { name: input({ value: p?.name ?? '', maxlength: '80' }), kind: select([['', 'Choose a type'], ...PRODUCT_KIND], { value: p?.kind ?? '' }), price: dollarsIn(p?.price_cents), sessions: input({ type: 'number', min: '2', max: '500', value: String(p?.kind === 'pack' ? p.sessions : 10) }), type: select([['private', 'Private sessions'], ['group', 'Group classes']], { value: p?.credit_type ?? 'private' }), stock: h('input', { type: 'checkbox', checked: p ? !!p.track_stock : true }) };
  const sessionsField = field('Sessions in pack', f.sessions), typeField = field('Counts as', f.type);
  const stockField = h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, f.stock, h('span', null, 'Count stock (sizes and deliveries in Inventory)'));
  const sync = () => { sessionsField.style.display = f.kind.value === 'pack' ? '' : 'none'; typeField.style.display = ['pack', 'session'].includes(f.kind.value) ? '' : 'none'; stockField.style.display = f.kind.value === 'gear' && !p ? '' : 'none'; };
  f.kind.addEventListener('change', sync); sync();
  setupDialog(p ? `Edit ${p.name}` : 'Add a product', [
    h('div', { class: 'form-grid' }, field('Product name', f.name), field('Type', f.kind)),
    h('div', { class: 'form-grid cols-3' }, field('Price ($)', f.price), sessionsField, typeField), stockField
  ], p ? 'Save product' : 'Add product', async () => {
    if (!f.kind.value) throw new Error('Choose the type of product: a single session, a session pack, gear or other.');
    const cents = toCents(f.price);
    if (!Number.isInteger(cents) || cents < 0) throw new Error('Enter a price like 25.00 (0 for free).');
    const gearStock = !p && f.kind.value === 'gear' && f.stock.checked;
    const body = { name: f.name.value, kind: f.kind.value, price_cents: cents, sessions: f.kind.value === 'pack' ? Number(f.sessions.value) : undefined, credit_type: f.type.value, ...(!p ? { track_stock: gearStock, low_stock_at: gearStock ? 2 : undefined } : {}) };
    if (p) await patch(`/v1/products/${p.id}`, body); else await post('/v1/products', body);
    return p ? `${f.name.value.trim()} saved. New sales use the new details; past sales keep theirs.` : gearStock ? 'Product added. Add sizes and what\'s on the shelf in Inventory.' : 'Product added.';
  }, p ? 'Changing a price or pack size only affects new sales.' : null);
}
function planForm() {
  const f = { name: input({ placeholder: 'Like Unlimited group training', maxlength: '80' }), price: dollarsIn(null, { min: '1' }), trial: input({ type: 'number', min: '0', max: '90', value: '0' }) };
  setupDialog('Add a monthly membership', [h('div', { class: 'form-grid cols-3' }, field('Membership name', f.name), field('Monthly price ($)', f.price), field('Free trial (days)', f.trial, '0 charges the first month right away.'))], 'Add membership', async () => {
    const cents = toCents(f.price);
    if (!f.name.value.trim() || !(cents > 0)) throw new Error('Enter a name and a monthly price.');
    await post('/v1/plans', { name: f.name.value.trim(), price_cents: cents, trial_days: Number(f.trial.value) || 0 });
    return 'Membership added.';
  }, 'Billed to the saved card every month. It shows on the sale screen and in the parent portal. Change prices in Billing.');
}
function readerForm(locs) {
  const f = { code: input({ placeholder: 'three-words-code', autocapitalize: 'none' }), label: input({ placeholder: 'Front desk', maxlength: '60' }), loc: select(locs.filter((l) => l.active).map((l) => [l.id, l.name])) };
  setupDialog('Register a reader', [h('div', { class: 'form-grid cols-3' }, field('Registration code', f.code, state.payments.can_simulate ? 'Test mode: use simulated-wpe' : null), field('Label', f.label), field('Location', f.loc))], 'Register reader', async () => {
    await post('/v1/readers', { registration_code: f.code.value, label: f.label.value, location_id: f.loc.value });
    return 'Reader registered. It takes payments at its location only.';
  }, 'For a Stripe smart reader (like the S710). Turn it on, connect it to Wi-Fi, and enter the code it shows.');
}

async function viewSetup(main) {
  const owner = isOwner(), manage = state.user.role !== 'front_desk';       // front desk sells from what's set up here, and can't change it
  const [locs, prods, readers, plans, settings] = await Promise.all([get('/v1/locations?include_inactive=true'), get('/v1/products?include_inactive=true'), get('/v1/readers'), owner ? get('/v1/plans?include_inactive=true') : null, owner ? get('/v1/settings') : null]);
  const shown = (list, active) => list.filter((x) => !!x.active === active);
  const retired = (label, rows) => (rows.length ? h('details', { style: 'border-top:1px solid var(--line-subtle);padding-top:8px' }, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, `${label} (${rows.length})`), ...rows) : null);

  const locRow = (l) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'flex:1 1 200px' }, h('span', { class: 'strong' }, l.name), h('span', { class: 'small muted' }, `${LOCATION_KIND[l.kind] ?? l.kind}${l.address_line1 ? ` · ${l.address_line1}, ${l.city}` : ' · No address yet'}`)),
    l.active ? (l.card_ready ? h('span', { class: 'dp-badge dp-badge--good' }, 'Cards ready') : h('span', { class: 'dp-badge dp-badge--warn' }, 'Needs address')) : null,
    l.active && manage ? btn('Edit', () => locationForm(l), 'ghost') : null,
    !manage ? null : btn(l.active ? 'Archive' : 'Restore', (e) => { if (!l.active || confirm(`Archive ${l.name}? It stops showing on the sale screen. Past sales keep it.`)) busy(e.currentTarget, async () => { await patch(`/v1/locations/${l.id}`, { active: !l.active }); toast(l.active ? `${l.name} archived.` : `${l.name} is back.`); render(); }); }, 'ghost'));
  const places = locs.data.filter((l) => !(l.name === 'Online' && l.kind === 'other' && !l.active));      // the store's own "Online" location isn't a place to manage
  const locPanel = panel('Locations', { subtitle: 'Where you train and take payments.', action: manage ? btn('Add location', () => locationForm(null), 'secondary') : null },
    ...(shown(places, true).length ? shown(places, true).map(locRow) : [h('p', { class: 'muted' }, 'No locations yet. Add the places you train.')]),
    retired('Archived locations', shown(places, false).map(locRow)));

  const prodRow = (p) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'flex:1 1 200px' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'small muted' }, `${money(p.price_cents)}${p.kind === 'pack' ? ` · ${p.sessions} ${p.credit_type} sessions` : p.kind === 'session' ? ` · 1 ${p.credit_type} session` : p.kind === 'gear' ? ' · Gear' : ''}${p.track_stock ? ` · ${p.on_hand} on hand` : ''}`)),
    p.active && p.track_stock ? h('a', { class: 'dp-btn dp-btn--ghost', href: '#/sell/inventory' }, 'Stock') : null,
    p.active && manage ? btn('Edit', () => productForm(p), 'ghost') : null,
    !manage ? null : btn(p.active ? 'Stop selling' : 'Sell again', (e) => busy(e.currentTarget, async () => { await patch(`/v1/products/${p.id}`, { active: !p.active }); toast(p.active ? `${p.name} is off the sale screen. Past sales keep it.` : `${p.name} is back on the sale screen.`); render(); }), 'ghost'));
  const prodPanel = panel('Products', { subtitle: 'Sessions and packs add session credits to the client. Members check in on their membership.', action: manage ? btn('Add product', () => productForm(null), 'secondary') : null },
    ...(shown(prods.data, true).length ? shown(prods.data, true).map(prodRow) : [h('p', { class: 'muted' }, 'Nothing for sale yet. Add sessions, packs or gear.')]),
    retired('No longer sold', shown(prods.data, false).map(prodRow)));

  const readerPanel = panel('Front-desk readers', { subtitle: 'Each reader takes payments at its own location.', action: manage ? btn('Register reader', () => readerForm(locs.data), 'secondary') : null },
    ...(readers.data.length ? readers.data.map((r) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, r.label), h('span', { class: 'small muted' }, `${r.location_name} · ${r.device_type ?? 'reader'}`)),
      !manage ? null : btn('Remove', (e) => { if (confirm(`Remove ${r.label}?`)) busy(e.currentTarget, async () => { await del(`/v1/readers/${r.id}`); render(); }); }, 'ghost')))
      : [h('p', { class: 'muted' }, 'No readers. Tap to Pay on iPhone, card on file and cash work without one.')]));

  let planPanel = null, discountPanel = null;
  if (owner) {
    const planRow = (p) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'small muted' }, `${money(p.price_cents)} a month${p.trial_days ? ` · ${p.trial_days}-day free trial` : ''}`)),
      p.active === false ? btn('Offer again', (e) => busy(e.currentTarget, async () => { await patch(`/v1/plans/${p.id}`, { active: true }); toast(`${p.name} is offered again.`); render(); }), 'ghost') : null);
    planPanel = panel('Monthly memberships', { subtitle: 'Billed to the saved card every month. Change prices or retire them in Billing.', action: btn('Add membership', () => planForm(), 'secondary') },
      ...(plans.data.filter((p) => p.active !== false).map(planRow)), retired('Retired memberships', plans.data.filter((p) => p.active === false).map(planRow)));
    const pct = input({ type: 'number', min: '0', max: '100', step: '1', inputmode: 'numeric', value: settings.staff_discount_max_pct ?? '20', style: 'width:100px', 'aria-label': 'Largest discount for staff, in percent' });
    discountPanel = panel('Discounts', { subtitle: 'You can give any discount. Every discount needs a reason, shows on the receipt, and is in the activity log.' },
      h('form', { class: 'row wrap', style: 'gap:8px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { const s = await patch('/v1/settings', { staff_discount_max_pct: Number(pct.value) }); toast(Number(s.staff_discount_max_pct) ? `Coaches and front desk can give up to ${s.staff_discount_max_pct}% off.` : 'Only you can give discounts now.'); }); } },
        h('span', null, 'Coaches and front desk can give up to'), pct, h('span', null, '% off a sale'), btn('Save', null, 'secondary', { type: 'submit' })),
      h('p', { class: 'small muted', style: 'margin:0' }, '0 means only you can give discounts.'));
  }
  fill(main, header('Point of sale setup', manage ? 'Where you train, what you sell and your card readers.' : 'Where you train, what you sell and your card readers. Ask the owner to change them.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/sell' }, 'Back to sales')),
    h('div', { class: 'grid grid-2' }, h('div', { class: 'stack', style: 'gap:24px' }, locPanel, readerPanel, discountPanel), h('div', { class: 'stack', style: 'gap:24px' }, prodPanel, planPanel)));
}

// ---------- Schedule ----------
const KIND_LABEL = { group: 'Group', camp: 'Camp', clinic: 'Clinic', team: 'Team', evaluation: 'Evaluation', private: 'Private' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let tzName;
// Today's date in the business's time zone (the browser's own zone until the settings have loaded), not UTC.
const bizDate = (days = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: tzName, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86400000));
const tzFmt = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: tzName, ...opts }).format(new Date(iso));
const dayOf = (iso) => tzFmt(iso, { weekday: 'long', month: 'short', day: 'numeric' });
const timeOf = (iso) => tzFmt(iso, { hour: 'numeric', minute: '2-digit' });
const kindBadge = (k) => h('span', { class: `dp-badge dp-badge--${k === 'group' ? 'good' : k === 'camp' || k === 'clinic' ? 'neutral' : 'muted'}` }, KIND_LABEL[k] ?? k);
const COVER = { membership: ['Member', 'good'], credit: ['Credit', 'good'], paid: ['Paid', 'good'], registration: ['Registered', 'good'], unpaid: ['Unpaid', 'warn'], none: ['—', 'muted'] };
const coverBadge = (c) => h('span', { class: `dp-badge dp-badge--${COVER[c]?.[1] ?? 'muted'}` }, COVER[c]?.[0] ?? c);

// Coach pickers: everyone who can lead a session, plus whoever is set now if their account was turned off since.
const coachOptions = (coaches, current, currentName) => [['', 'No coach set'], ...coaches.map((c) => [c.id, c.name]), ...(current && !coaches.some((c) => c.id === current) ? [[current, `${currentName ?? 'Former coach'} (account off)`]] : [])];
const coachPicker = (coaches, current, currentName, attrs = {}) => select(coachOptions(coaches, current, currentName), { value: current ?? '', ...attrs });
const leads = () => state.user?.role !== 'front_desk';          // owners and coaches lead sessions and assign coaches
const hashQuery = () => new URLSearchParams(location.hash.split('?')[1] ?? '');

// Schedule helpers shared with Today. Dates are business days (YYYY-MM-DD in the business time zone).
const addDaysStr = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
// Midnight (or any wall-clock time) on a business day, as a UTC ISO string: the same daylight-saving-safe method as the server.
function bizIso(dateStr, timeStr = '00:00') {
  const [y, m, d] = dateStr.split('-').map(Number), [hh, mm] = timeStr.split(':').map(Number);
  const off = (ts) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tzName, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts; };
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - off(guess);
  const second = guess - off(utc);
  if (second !== utc) utc = second;
  return new Date(utc).toISOString();
}
const bizDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tzName, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const bizTime = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: tzName, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
// A session's state against the clock: live (On now), done, or upcoming.
const sessionState = (x, now = new Date().toISOString()) => (x.status === 'canceled' ? 'canceled' : x.ends_at <= now ? 'done' : x.starts_at <= now ? 'live' : 'later');
const stateBadge = (st) => (st === 'live' ? h('span', { class: 'dp-badge dp-badge--good' }, 'On now') : st === 'next' ? h('span', { class: 'dp-badge dp-badge--neutral' }, 'Next') : st === 'done' ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Done') : null);
// How many are checked in, as a thin bar and words, once a session has started (or is today).
const checkinBar = (x) => {
  const n = x.booked_count, done = x.attended_count ?? 0;
  if (!n) return null;
  return h('span', { class: 'ck', title: `${done} of ${n} checked in` }, h('span', { class: 'ck-bar', 'aria-hidden': 'true' }, h('span', { class: 'ck-fill', style: `width:${Math.round((done / n) * 100)}%` })), h('span', { class: 'small muted' }, `${done}/${n} here`));
};
// Keep the page where it was after an action redraws it: same scroll position, keyboard focus back on the same control.
async function keepPlace(run) {
  const key = document.activeElement?.dataset?.focus, y = window.scrollY;
  await run();
  window.scrollTo(0, y);
  if (key) document.querySelector(`[data-focus="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}
let lastScheduleHash = '#/schedule';     // the week and filters the Schedule button on a session goes back to

function sessionRow(x, { showState = false, state } = {}) {
  const st = state ?? sessionState(x);
  const full = x.booked_count >= x.capacity;
  return h('a', { class: 'list-item', href: `#/schedule/${x.id}`, style: 'text-decoration:none;color:inherit;flex-wrap:wrap' },
    h('div', { style: 'width:84px;flex-shrink:0;font:600 18px/1.1 var(--font-display)' }, timeOf(x.starts_at)),
    h('div', { class: 'grow stack-tight', style: 'min-width:180px' }, h('span', { class: 'strong' }, x.name),
      h('span', { class: 'small muted' }, `${x.location_name} · ${x.coach_name ?? 'No coach set'} · ${x.booked_count}/${x.capacity} booked${x.waitlist_count ? ` · ${x.waitlist_count} waitlisted` : ''}`),
      showState && st !== 'later' ? checkinBar(x) : null),
    h('div', { class: 'row wrap', style: 'gap:6px;justify-content:flex-end' },
      showState ? stateBadge(st) : null,
      full && st !== 'done' ? h('span', { class: 'dp-badge dp-badge--neutral' }, 'Full') : null,
      x.unpaid_count ? h('span', { class: 'dp-badge dp-badge--warn' }, `${x.unpaid_count} unpaid`) : null,
      kindBadge(x.kind)));
}

// Edit a class, camp or clinic: every upcoming session follows. Prices are the owner's (coaches never see them).
function editSeriesDialog(x, locs, coaches) {
  const owner = isOwner();
  const f = { name: input({ value: x.name, maxlength: '80' }), time: input({ type: 'time', value: x.start_time }), dur: input({ type: 'number', min: '10', max: '600', value: String(x.duration_min) }),
    cap: input({ type: 'number', min: '1', max: '500', value: String(x.capacity) }), ageMin: input({ type: 'number', placeholder: 'Any', value: x.age_min ?? '' }), ageMax: input({ type: 'number', placeholder: 'Any', value: x.age_max ?? '' }),
    loc: select(locs.map((l) => [l.id, l.name]), { value: x.location_id }), coach: coachPicker(coaches, x.coach_id, x.coach_name),
    start: input({ type: 'date', value: x.start_date }), end: input({ type: 'date', value: x.end_date ?? '' }), desc: input({ value: x.description ?? '', maxlength: '2000' }),
    dropIn: input({ type: 'number', step: '0.01', min: '0', value: x.drop_in_cents != null ? (x.drop_in_cents / 100).toFixed(2) : '', placeholder: 'Not sold singly' }),
    reg: input({ type: 'number', step: '0.01', min: '0', value: x.registration_cents != null ? (x.registration_cents / 100).toFixed(2) : '', placeholder: 'Camps and clinics' }) };
  const days = DAY_NAMES.map((d, i) => h('label', { class: 'row small', style: 'gap:6px;min-height:44px' }, h('input', { type: 'checkbox', value: String(i), checked: x.weekdays.includes(i) }), d));
  const cents = (el) => (el.value === '' ? null : Math.round(Number(el.value) * 100));
  const num = (el) => (el.value === '' ? null : Number(el.value));
  const body = h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, 'Every upcoming session follows, except what you changed on a single session (a sub, a moved time, more spots). Families booked on a session that moves get one email. Sessions on days you take off are canceled: credits come back, drop-ins are refunded and families are emailed.'),
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(160px,1fr))' }, field('Name', f.name), field('Where', f.loc), field('Coach', f.coach)),
    h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'dp-label' }, 'Days'), h('div', { class: 'row wrap', style: 'gap:12px' }, days)),
    h('div', { class: 'form-grid cols-3' }, field('Starts', f.time), field('Minutes', f.dur), field('Spots', f.cap, `${x.enrolled?.length ?? x.enrolled_count ?? 0} standing or registered`)),
    h('div', { class: 'form-grid cols-4' }, field('Min age', f.ageMin), field('Max age', f.ageMax), owner ? field('Drop-in ($)', f.dropIn) : null, owner ? field('Registration ($)', f.reg) : null),
    h('div', { class: 'form-grid' }, field('First day', f.start), field('Last day', f.end, ['camp', 'clinic'].includes(x.kind) ? 'Camps and clinics need a last day.' : 'Leave empty for weekly classes that keep going.')),
    field('Description (parents see this)', f.desc));
  teamDialog(`Edit ${x.name}`, body, [{ label: 'Save changes', variant: 'primary', onClick: async () => {
    const weekdays = days.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
    const next = { name: f.name.value.trim(), location_id: f.loc.value, coach_id: f.coach.value || null, weekdays, start_time: f.time.value, duration_min: num(f.dur), capacity: num(f.cap),
      age_min: num(f.ageMin), age_max: num(f.ageMax), start_date: f.start.value, end_date: f.end.value || null, description: f.desc.value.trim() || null,
      ...(owner ? { drop_in_cents: cents(f.dropIn), registration_cents: cents(f.reg) } : {}) };
    const cur = { ...x, coach_id: x.coach_id ?? null, end_date: x.end_date ?? null, description: x.description ?? null, age_min: x.age_min ?? null, age_max: x.age_max ?? null, drop_in_cents: x.drop_in_cents ?? null, registration_cents: x.registration_cents ?? null };
    const changed = Object.fromEntries(Object.entries(next).filter(([k, val]) => JSON.stringify(val) !== JSON.stringify(k === 'weekdays' ? [...cur.weekdays].sort() : cur[k])));
    if (changed.weekdays) changed.weekdays = [...changed.weekdays].sort();
    if (!Object.keys(changed).length) throw new Error('Nothing to change.');
    const removed = x.weekdays.filter((d) => !weekdays.includes(d));
    if (removed.length && !confirm(`Sessions on ${removed.map((d) => DAY_NAMES[d]).join(', ')} will be canceled. Credits come back, drop-ins are refunded and families are emailed. Continue?`)) return false;
    const r = (await patch(`/v1/class-series/${x.id}`, changed)).changes;
    const bits = [r.updated ? nplural(r.updated, 'session') + ' updated' : null, r.moved ? `${r.moved} moved` : null, r.canceled ? `${r.canceled} canceled` : null, r.added ? `${r.added} added` : null, r.promoted ? `${r.promoted} moved up from the waitlist` : null, r.families_emailed ? `${nplural(r.families_emailed, 'family', 'families')} emailed` : null].filter(Boolean);
    toast(`Saved.${bits.length ? ` ${bits.join(', ')}.` : ''}`); render();
  } }, { label: 'Cancel', variant: 'ghost' }]);
}

async function viewSchedule(main) {
  const q = hashQuery();
  const settings = await get('/v1/settings');
  tzName = settings.timezone;
  const today = bizDate();
  const week = /^\d{4}-\d{2}-\d{2}$/.test(q.get('week') ?? '') ? q.get('week') : today;     // seven days from this date (today by default)
  const mine = leads() && q.get('mine') === '1', onlyCoach = q.get('coach'), kind = q.get('kind') ?? '', loc = q.get('loc') ?? '';
  const params = new URLSearchParams({ from: bizIso(week), to: bizIso(addDaysStr(week, 7)) });
  if (onlyCoach) params.set('coach_id', onlyCoach); else if (mine) params.set('coach_id', 'me');
  if (kind) params.set('kind', kind);
  if (loc) params.set('location_id', loc);
  const [sched, series, locs, coachList] = await Promise.all([get(`/v1/schedule?${params}`), get('/v1/class-series'), get('/v1/locations'), get('/v1/coaches')]);
  const coaches = coachList.data;
  lastScheduleHash = location.hash || '#/schedule';
  // Filters live in the address, so Back, refresh and a session's Schedule button keep them.
  const go = (changes) => {
    const p = hashQuery();
    for (const [k, val] of Object.entries(changes)) { if (val === '' || val == null) p.delete(k); else p.set(k, val); }
    const s = p.toString();
    location.hash = `#/schedule${s ? `?${s}` : ''}`;
  };

  // Search (name, place, coach) filters as you type without redrawing, and is kept in the address too.
  const search = input({ type: 'search', placeholder: 'Find a session, place or coach', value: q.get('q') ?? '', 'aria-label': 'Find a session', style: 'max-width:320px' });
  const list = h('div', { class: 'stack', style: 'gap:24px' });
  const totals = h('p', { class: 'small muted', style: 'margin:0', 'aria-live': 'polite' });
  const draw = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = sched.data.filter((x) => words.every((w) => `${x.name} ${x.location_name} ${x.coach_name ?? 'no coach set'}`.toLowerCase().includes(w)));
    const booked = rows.reduce((t, x) => t + x.booked_count, 0), unpaid = rows.reduce((t, x) => t + x.unpaid_count, 0), wait = rows.reduce((t, x) => t + x.waitlist_count, 0);
    totals.textContent = [nplural(rows.length, 'session'), `${booked} booked`, unpaid ? `${unpaid} unpaid` : null, wait ? `${wait} waitlisted` : null].filter(Boolean).join(' · ');
    const byDay = new Map();
    for (const x of rows) { const d = bizDay(x.starts_at); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(x); }
    const now = new Date().toISOString();
    fill(list, byDay.size ? [...byDay].map(([d, xs]) => panel(`${dayOf(bizIso(d, '12:00'))}${d === today ? ' · Today' : ''}`, {}, xs.map((x) => sessionRow(x, { showState: d <= today, state: sessionState(x, now) }))))
      : h('div', { class: 'empty' }, words.length ? `Nothing in these 7 days matches "${search.value.trim()}".` : onlyCoach ? `${coaches.find((c) => c.id === onlyCoach)?.name ?? 'This coach'} doesn't lead anything in these 7 days.` : mine ? 'You don\'t lead anything in these 7 days. Untick My sessions to see everything.' : 'Nothing scheduled in these 7 days.'));
  };
  let t = null;
  search.addEventListener('input', () => {
    draw();
    clearTimeout(t);
    t = setTimeout(() => { const p = hashQuery(); if (search.value.trim()) p.set('q', search.value.trim()); else p.delete('q'); const s = p.toString(); history.replaceState(null, '', `#/schedule${s ? `?${s}` : ''}`); lastScheduleHash = location.hash; }, 300);
  });
  draw();

  const weekLabel = `${shortDate(week)} – ${shortDate(addDaysStr(week, 6))}`;
  const weekNav = h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' },
    btn('Previous week', () => go({ week: addDaysStr(week, -7) }), 'secondary', { 'aria-label': 'Previous week' }),
    h('span', { class: 'strong', style: 'min-width:170px;text-align:center' }, weekLabel),
    btn('Next week', () => go({ week: addDaysStr(week, 7) }), 'secondary', { 'aria-label': 'Next week' }),
    week !== today ? btn('From today', () => go({ week: null }), 'ghost') : null);
  const types = h('div', { class: 'row wrap tm-views', role: 'group', 'aria-label': 'Type of session' },
    [['', 'All'], ['group', 'Group'], ['camp', 'Camps'], ['clinic', 'Clinics'], ['team', 'Team'], ['private', 'Privates'], ['evaluation', 'Evaluations']].map(([k, label]) =>
      h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(kind === k), onClick: () => go({ kind: k }) }, label)));
  const placeSel = select([['', 'Every place'], ...locs.data.map((l) => [l.id, l.name])], { value: loc, 'aria-label': 'Place', style: 'width:auto' });
  placeSel.addEventListener('change', () => go({ loc: placeSel.value }));
  let whoCtl = null;
  if (isOwner()) {
    whoCtl = select([['', 'Every coach'], ...coaches.map((c) => [c.id, c.name])], { value: onlyCoach ?? '', 'aria-label': 'Show sessions led by', style: 'width:auto' });
    whoCtl.addEventListener('change', () => go({ coach: whoCtl.value, mine: null }));
  } else if (onlyCoach) {
    whoCtl = h('span', { class: 'small' }, `${coaches.find((c) => c.id === onlyCoach)?.name ?? 'This coach'}'s sessions · `, h('a', { href: '#/schedule' }, 'Show everyone'));
  } else if (leads()) {
    const box = h('input', { type: 'checkbox', checked: mine });
    box.addEventListener('change', () => go({ mine: box.checked ? '1' : null }));
    whoCtl = h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, box, h('span', null, 'My sessions only'));
  }
  const filterBar = h('div', { class: 'stack', style: 'gap:12px' },
    h('div', { class: 'row wrap', style: 'gap:12px;justify-content:space-between' }, weekNav, h('div', { class: 'row wrap', style: 'gap:8px' }, search, placeSel, whoCtl)),
    types, totals);

  // Add a class, camp or clinic (owners and coaches).
  const f = { name: input({ maxlength: '80' }), kind: select([['group', 'Weekly group class'], ['camp', 'Camp'], ['clinic', 'Clinic'], ['team', 'Team session'], ['evaluation', 'Evaluation day']]), loc: select(locs.data.map((l) => [l.id, l.name])),
    time: input({ type: 'time', value: '17:00' }), dur: input({ type: 'number', value: '60', min: '10' }), cap: input({ type: 'number', value: '12', min: '1' }), ageMin: input({ type: 'number', placeholder: 'Any' }), ageMax: input({ type: 'number', placeholder: 'Any' }),
    dropIn: input({ type: 'number', step: '0.01', placeholder: 'Not sold singly' }), reg: input({ type: 'number', step: '0.01', placeholder: 'Camps and clinics' }),
    start: input({ type: 'date', value: today }), end: input({ type: 'date' }), desc: input({ placeholder: 'What athletes will work on' }),
    coach: coachPicker(coaches, state.user.role === 'coach' ? state.user.id : '', null) };
  const days = DAY_NAMES.map((d, i) => h('label', { class: 'row small', style: 'gap:6px;min-height:44px' }, h('input', { type: 'checkbox', value: String(i) }), d));
  const dollars = (el) => (el.value === '' ? undefined : Math.round(Number(el.value) * 100));
  const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const weekdays = days.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
    const x = await post('/v1/class-series', { name: f.name.value, kind: f.kind.value, location_id: f.loc.value, weekdays, start_time: f.time.value, duration_min: Number(f.dur.value), capacity: Number(f.cap.value),
      age_min: f.ageMin.value ? Number(f.ageMin.value) : undefined, age_max: f.ageMax.value ? Number(f.ageMax.value) : undefined, drop_in_cents: dollars(f.dropIn), registration_cents: dollars(f.reg),
      start_date: f.start.value, end_date: f.end.value || undefined, description: f.desc.value || undefined, coach_id: f.coach.value || null });
    toast(`${x.name} added: ${x.upcoming_sessions} sessions on the schedule.`); render();
  }); } },
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(180px,1fr))' }, field('Name', f.name), field('Type', f.kind), field('Coach', f.coach, 'Leads every session. Swap in a sub on a single session.')),
    h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'dp-label' }, 'Days'), h('div', { class: 'row wrap', style: 'gap:12px' }, days)),
    h('div', { class: 'form-grid cols-3' }, field('Starts', f.time), field('Minutes', f.dur), field('Spots', f.cap)),
    h('div', { class: 'form-grid cols-4' }, field('Min age', f.ageMin), field('Max age', f.ageMax), field('Drop-in ($)', f.dropIn), field('Registration ($)', f.reg)),
    h('div', { class: 'form-grid' }, field('Where', f.loc), field('First day', f.start), field('Last day', f.end, 'Leave empty for weekly classes that keep going.')),
    field('Description (parents see this)', f.desc),
    h('div', null, btn('Add to schedule', null, 'primary', { type: 'submit' })));
  const addPanel = panel('Add a class, camp or clinic', { subtitle: 'Sessions are created automatically. Weekly classes are always scheduled 8 weeks ahead.' }, form);

  // One session that isn't part of a class: a makeup, a one-time clinic. The staff note is for staff only.
  const o = { name: input({ maxlength: '80', placeholder: 'Like Makeup speed session' }), kind: select([['group', 'Group'], ['clinic', 'Clinic'], ['private', 'Private'], ['evaluation', 'Evaluation'], ['team', 'Team']]),
    loc: select(locs.data.map((l) => [l.id, l.name])), date: input({ type: 'date', value: today, min: today }), time: input({ type: 'time', value: '17:00' }), dur: input({ type: 'number', value: '60', min: '10' }), cap: input({ type: 'number', value: '12', min: '1' }),
    dropIn: input({ type: 'number', step: '0.01', placeholder: 'Leave empty if not sold' }), note: input({ maxlength: '500', placeholder: 'Only staff see this' }), coach: coachPicker(coaches, state.user.role === 'coach' ? state.user.id : '', null) };
  const oneForm = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    if (o.date.value && o.date.value < bizDate()) throw new Error('Pick today or a later date.');
    const x = await post('/v1/sessions', { name: o.name.value, kind: o.kind.value, location_id: o.loc.value, date: o.date.value, start_time: o.time.value, duration_min: Number(o.dur.value), capacity: Number(o.cap.value),
      coach_id: o.coach.value || null, staff_note: o.note.value || undefined, ...(isOwner() ? { drop_in_cents: dollars(o.dropIn) } : {}) });
    toast(`${x.name} added for ${tzFmt(x.starts_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`); location.hash = `#/schedule/${x.id}`;
  }); } },
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(160px,1fr))' }, field('Name', o.name), field('Type', o.kind), field('Coach', o.coach), field('Where', o.loc)),
    h('div', { class: 'form-grid cols-4' }, field('Date', o.date), field('Starts', o.time), field('Minutes', o.dur), field('Spots', o.cap)),
    h('div', { class: 'form-grid' }, isOwner() ? field('Drop-in ($)', o.dropIn) : null, field('Staff note', o.note, 'Why it\'s on, who it\'s for. Families don\'t see it.')),
    h('div', null, btn('Add session', null, 'primary', { type: 'submit' })));
  const onePanel = panel('Add one session', { subtitle: 'A makeup or one-time session that isn\'t part of a weekly class.' }, oneForm);
  addPanel.hidden = true; onePanel.hidden = true;
  // One green button on the page: opening a form hands it to that form's Save.
  const addBtn = btn('Add class or camp', () => open(addPanel, f.name), 'primary');
  const oneBtn = btn('Add one session', () => open(onePanel, o.name), 'secondary');
  function open(p, focusEl) {
    addPanel.hidden = p !== addPanel; onePanel.hidden = p !== onePanel;
    addBtn.className = 'dp-btn dp-btn--secondary';
    p.scrollIntoView({ behavior: 'smooth' }); focusEl.focus({ preventScroll: true });
  }

  const seriesCoach = (x) => {
    if (!leads()) return h('span', { class: 'small muted' }, x.coach_name ?? 'No coach set');
    const sel = coachPicker(coaches, x.coach_id, x.coach_name, { 'aria-label': `Coach for ${x.name}`, style: 'width:auto;max-width:180px' });
    sel.addEventListener('change', () => busy(sel, async () => {
      await patch(`/v1/class-series/${x.id}`, { coach_id: sel.value || null });
      toast(sel.value ? `${sel.selectedOptions[0].textContent} now leads ${x.name}. Sessions with a sub keep their sub.` : `${x.name} has no coach set.`); render();
    }));
    return sel;
  };
  const seriesList = series.data.length ? series.data.map((x) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, `${x.weekdays.map((d) => DAY_NAMES[d]).join(', ')} ${hm12(x.start_time)} · ${x.duration_min} min · ${x.location_name} · ${x.capacity} spots${x.age_min || x.age_max ? ` · ages ${x.age_min ?? ''}–${x.age_max ?? ''}` : ''}${x.enrolled_count ? ` · ${x.enrolled_count} ${x.kind === 'group' ? 'standing' : 'registered'}` : ''}${x.end_date ? ` · until ${ymd(x.end_date)}` : ''}`)),
    seriesCoach(x), kindBadge(x.kind),
    leads() ? btn('Edit', () => editSeriesDialog(x, locs.data, coaches), 'outline', { 'aria-label': `Edit ${x.name}` }) : null,
    leads() ? btn('Archive', (e) => { if (confirm(`Archive ${x.name}? Future sessions are canceled, credits returned and families emailed.`)) busy(e.currentTarget, async () => { await patch(`/v1/class-series/${x.id}`, { active: false }); toast('Archived.'); render(); }); }, 'ghost', { 'aria-label': `Archive ${x.name}` }) : null))
    : [h('p', { class: 'muted' }, 'No classes yet.')];

  fill(main,
    header('Schedule', 'Classes, camps, clinics, privates and evaluations, seven days at a time.', h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule/setup' }, 'Hours & settings'),
      leads() && locs.data.length ? oneBtn : null, leads() && locs.data.length ? addBtn : null)),
    locs.data.length ? null : h('div', { class: 'empty' }, 'Add a location in Point of sale setup before scheduling.'),
    filterBar, list,
    panel('Classes & camps', { subtitle: leads() ? 'Edit a class and every upcoming session follows.' : null }, ...seriesList),
    leads() && locs.data.length ? [onePanel, addPanel] : null);
}

// Edit one session: a sub, a new time or place (families can be emailed), spots, the staff note.
function editSessionDialog(x, locs, coaches, again) {
  const f = { name: input({ value: x.name, maxlength: '80' }), date: input({ type: 'date', value: bizDay(x.starts_at), min: bizDate() }), time: input({ type: 'time', value: bizTime(x.starts_at) }),
    dur: input({ type: 'number', min: '10', max: '600', value: String(Math.round((Date.parse(x.ends_at) - Date.parse(x.starts_at)) / 60000)) }), cap: input({ type: 'number', min: String(Math.max(1, x.booked_count)), max: '500', value: String(x.capacity) }),
    loc: select(locs.map((l) => [l.id, l.name]), { value: x.location_id }), coach: coachPicker(coaches, x.coach_id, x.coach_name), note: textarea(x.staff_note ?? '', { maxlength: '500', placeholder: 'Only staff see this' }) };
  const notify = h('input', { type: 'checkbox', checked: true });
  const body = h('div', { class: 'stack' },
    x.series_id ? h('p', { class: 'small muted', style: 'margin:0' }, 'Changes this session only. Edit the class on the Schedule page to change every session.') : null,
    h('div', { class: 'form-grid' }, field('Name', f.name), field('Coach', f.coach, x.series_id ? 'A sub for this session.' : null)),
    h('div', { class: 'form-grid cols-4' }, field('Date', f.date), field('Starts', f.time), field('Minutes', f.dur), field('Spots', f.cap, x.waitlist_count ? 'More spots move the waitlist up.' : x.booked_count ? `${x.booked_count} booked` : null)),
    field('Where', f.loc), field('Staff note', f.note, 'Families don\'t see it.'),
    x.booked_count ? h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, notify, h('span', null, 'Email booked families if the time or place changes')) : null);
  teamDialog('Edit session', body, [{ label: 'Save changes', variant: 'primary', onClick: async () => {
    const r = await patch(`/v1/sessions/${x.id}`, { name: f.name.value, date: f.date.value, start_time: f.time.value, duration_min: Number(f.dur.value), capacity: Number(f.cap.value), location_id: f.loc.value, coach_id: f.coach.value || null, staff_note: f.note.value, notify: notify.checked });
    toast([`Saved: ${r.changed.join(', ')}.`, r.promoted ? `${nplural(r.promoted, 'athlete')} moved up from the waitlist.` : null, r.families_emailed ? `${nplural(r.families_emailed, 'family', 'families')} emailed.` : null].filter(Boolean).join(' '));
    again();
  } }, { label: 'Cancel', variant: 'ghost' }]);
}

// Email everyone booked: "Running 10 minutes late", "Bring your cleats".
function messageDialog(x) {
  const msg = textarea('', { maxlength: '1000', style: 'min-height:120px', placeholder: 'Running 10 minutes late. See you soon!' });
  const wl = h('input', { type: 'checkbox' });
  let sent = false;
  teamDialog(`Email families · ${x.name}`, h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, `${x.team ? 'Everyone booked and every family on the team roster' : 'Everyone booked'} gets one email per family, signed with your name.`),
    field('Message', msg),
    x.waitlist_count ? h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, wl, h('span', null, `Also the waitlist (${x.waitlist_count})`)) : null),
  [{ label: 'Send email', variant: 'primary', onClick: async () => {
    if (sent) return;
    if (!msg.value.trim()) throw new Error('Write a message first.');
    const r = await post(`/v1/sessions/${x.id}/message`, { message: msg.value, include_waitlist: wl.checked });
    sent = true;
    toast(`Sent to ${nplural(r.sent, 'family', 'families')}.`);
  } }, { label: 'Cancel', variant: 'ghost' }]);
  msg.focus();
}

async function viewSession(main, id) {
  const [x, settings, progs, coachList, locs] = await Promise.all([get(`/v1/sessions/${id}`), get('/v1/settings'), get('/v1/programs'), get('/v1/coaches'), get('/v1/locations')]);
  tzName = settings.timezone;
  const again = () => keepPlace(() => viewSession(main, id));
  const now = new Date().toISOString(), st = sessionState(x, now);
  // Who leads this session. Changing it here only changes this one (a sub); the class keeps its coach.
  const coachSel = leads() && x.status === 'scheduled' ? coachPicker(coachList.data, x.coach_id, x.coach_name, { 'aria-label': 'Coach for this session', style: 'width:auto;min-width:200px' }) : null;
  coachSel?.addEventListener('change', () => busy(coachSel, async () => {
    await patch(`/v1/sessions/${id}`, { coach_id: coachSel.value || null });
    toast(coachSel.value ? `${coachSel.selectedOptions[0].textContent} leads this session.${x.series_id ? ' The rest of the class keeps its coach.' : ''}` : 'No coach set for this session.'); again();
  }));
  const coachLine = h('div', { class: 'row wrap', style: 'gap:12px;align-items:center' }, h('span', { class: 'dp-label', style: 'margin:0' }, 'Coach'), coachSel ?? h('span', { class: 'strong' }, x.coach_name ?? 'No coach set'),
    x.series_id && coachSel ? h('span', { class: 'small muted' }, 'Changes this session only. Change the whole class on the Schedule page.') : null);
  const active = x.roster.filter((r) => ['booked', 'attended', 'no_show'].includes(r.status));
  const waiting = x.roster.filter((r) => r.status === 'waitlisted');
  const done = x.roster.filter((r) => ['canceled', 'late_canceled'].includes(r.status));
  const collect = (r) => btn('Collect', (e) => {
    const m = prompt(`Collect for ${r.name}: type "card" (card on file), "cash", or "tap" (Tap to Pay on your iPhone).`, 'cash');
    if (!m) return;
    const method = { card: 'card_on_file', cash: 'cash', tap: 'tap_to_pay' }[m.trim().toLowerCase()];
    if (!method) return toast('Type card, cash or tap.', 'warn');
    busy(e.currentTarget, async () => {
      const out = await post(`/v1/bookings/${r.id}/pay`, { method });
      if (out.sale.status === 'succeeded') toast(`${money(out.sale.amount_cents)} collected.`);
      else if (out.sale.status === 'pending') toast('Waiting for the tap on your iPhone. The booking updates when it\'s paid.');
      else toast(`Didn't go through: ${out.sale.failure_reason}`, 'warn');
      again();
    });
  }, 'outline', { 'data-focus': `collect-${r.id}` });
  const flag = (text, tone = 'warn') => h('span', { class: `dp-badge dp-badge--${tone}` }, text);
  const row = (r) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('button', { type: 'button', class: 'dp-ex-log', style: 'min-width:92px', 'data-focus': `att-${r.id}`, 'aria-pressed': String(r.status === 'attended'), 'aria-label': `${r.status === 'attended' ? 'Checked in' : 'Check in'} ${r.name}`,
      onClick: (e) => busy(e.currentTarget, async () => { await post(`/v1/bookings/${r.id}/attendance`, { status: r.status === 'attended' ? 'booked' : 'attended' }); await again(); }) }, r.status === 'attended' ? 'Here' : r.status === 'no_show' ? 'No-show' : 'Check in'),
    h('div', { class: 'grow stack-tight', style: 'min-width:180px' }, h('a', { href: `#/clients/${r.client_id}`, class: 'strong', style: 'color:var(--steel)' }, r.name),
      h('span', { class: 'small muted' }, [r.age != null ? `Age ${r.age}` : null, r.family_name, r.parent_phone ? phoneText(r.parent_phone) : null].filter(Boolean).join(' · ')),
      r.has_medical_notes ? h('span', { class: 'small warn-text' }, `Medical: ${r.medical_notes}`) : null),
    h('div', { class: 'row wrap', style: 'gap:6px' },
      r.birthday ? flag('Birthday', 'good') : null, r.no_waiver ? flag('No waiver') : null, r.status === 'no_show' ? flag('No-show', 'muted') : null, coverBadge(r.coverage)),
    r.coverage === 'unpaid' && r.status !== 'no_show' ? collect(r) : null,
    r.status === 'booked' && x.starts_at < now ? btn('No-show', (e) => busy(e.currentTarget, async () => { await post(`/v1/bookings/${r.id}/attendance`, { status: 'no_show' }); await again(); }), 'ghost', { 'data-focus': `ns-${r.id}` }) : null,
    btn('Remove', (e) => { if (confirm(`Remove ${r.name} from this session? A credit comes back and a paid drop-in is refunded.`)) busy(e.currentTarget, async () => { const out = await post(`/v1/bookings/${r.id}/cancel`, { waive: true }); toast(out.message); again(); }); }, 'ghost', { 'aria-label': `Remove ${r.name}` }));

  // Add an athlete: search by name or Athlete ID; Enter adds the only match (searching for what's typed now).
  const booked = new Set(x.roster.filter((r) => ['booked', 'attended', 'no_show', 'waitlisted'].includes(r.status)).map((r) => r.client_id));
  const find = input({ type: 'search', placeholder: 'Add an athlete: name or Athlete ID', 'aria-label': 'Find an athlete to add', autocomplete: 'off', 'data-focus': 'add-athlete' });
  const results = h('div', { class: 'stack-tight', 'aria-live': 'polite' });
  const add = async (c, button) => busy(button, async () => {
    let b;
    try { b = await post(`/v1/sessions/${id}/bookings`, { client_id: c.id }); }
    catch (err) { if (!/is \d+\. This session/.test(err.message) || !confirm(`${err.message}\n\nAdd anyway?`)) throw err; b = await post(`/v1/sessions/${id}/bookings`, { client_id: c.id, override_age: true }); }
    toast(`${b.status === 'waitlisted' ? `The session is full. ${c.name.split(' ')[0]} is on the waitlist.` : `${c.name.split(' ')[0]} is booked (${(COVER[b.coverage]?.[0] ?? b.coverage).toLowerCase()}).`}${b.clash ? ` ${c.name.split(' ')[0]} is also booked for ${b.clash.name} then (${tzFmt(b.clash.starts_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}).` : ''}`, b.clash ? 'warn' : 'good');
    find.value = '';
    await again();
    document.querySelector('[data-focus="add-athlete"]')?.focus({ preventScroll: true });
  });
  let seq = 0;
  const lookup = async () => { const term = find.value.trim(); const mySeq = ++seq; if (term.length < 2) return { term, list: null }; const r = await get(`/v1/clients?q=${encodeURIComponent(term)}`); return mySeq === seq ? { term, list: r.data } : null; };
  const show = (res) => {
    if (!res) return;
    if (!res.list) return fill(results);
    if (!res.list.length) return fill(results, h('p', { class: 'small muted', style: 'margin:0' }, `Nobody matches "${res.term}". Check the spelling, or add them in Clients first.`));
    fill(results, res.list.slice(0, 8).map((c) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, c.name), h('span', { class: 'small muted' }, [c.athlete_id, c.family_name].filter(Boolean).join(' · '))),
      booked.has(c.id) ? h('span', { class: 'small muted' }, 'Already booked') : btn('Add', (e) => add(c, e.currentTarget), 'secondary', { 'aria-label': `Add ${c.name}` }))),
    res.list.length > 8 ? h('p', { class: 'small muted', style: 'margin:0' }, `${res.list.length - 8} more. Keep typing to narrow it down.`) : null);
  };
  let tt = null;
  find.addEventListener('input', () => { clearTimeout(tt); tt = setTimeout(async () => show(await lookup().catch(() => null)), 200); });
  find.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); clearTimeout(tt);
    const res = await lookup().catch((err) => { toast(err.message, 'warn'); return null; });
    if (!res?.list) return;
    show(res);
    const open = res.list.filter((c) => !booked.has(c.id));
    if (res.list.length === 1 && !open.length) return toast(`${res.list[0].name} is already booked for this session.`, 'warn');
    if (open.length === 1 && res.list.length === 1) return add(open[0], null);
    if (res.list.length > 1) toast(`${res.list.length} athletes match. Pick one below.`, 'warn');
  });
  const addForm = h('div', { class: 'stack-tight' }, find, results);

  // The workout on the weight-room screen (/tv) during this session.
  const canPick = state.user?.role !== 'front_desk';
  const progSel = select([['', 'Choose a program'], ...progs.data.map((p) => [p.id, p.name])], { 'aria-label': 'Program' });
  const wkSel = select([['', 'Choose a workout']], { 'aria-label': 'Workout', disabled: true });
  progSel.addEventListener('change', async () => {
    wkSel.disabled = true;
    if (!progSel.value) return fill(wkSel, h('option', { value: '' }, 'Choose a workout'));
    const p = await get(`/v1/programs/${progSel.value}`);
    fill(wkSel, h('option', { value: '' }, 'Choose a workout'), p.workouts.map((w) => h('option', { value: w.id }, `Week ${w.week} day ${w.day}: ${w.title}`)));
    wkSel.disabled = false;
  });
  const screenPanel = panel('Weight-room screen', { subtitle: x.workout ? `Showing ${x.workout.title} (${x.workout.program_name}, week ${x.workout.week} day ${x.workout.day}) from 30 minutes before the start. Athletes tap their name to see their weights and log it.` : 'Pick a workout to show on the weight-room TV during this session. Athletes tap their name there to see their weights and log it. Set up the screen from Schedule → Hours & settings.' },
    x.workout ? h('ol', { class: 'small', style: 'margin:0;padding-left:20px' }, x.workout.exercises.map((e) => h('li', null, `${e.name} · ${e.prescription || ''}${e.load ? ` · ${e.load}` : ''}`))) : null,
    canPick && x.status === 'scheduled' ? h('form', { class: 'row wrap', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      if (!wkSel.value) throw new Error('Choose a program, then a workout.');
      await put(`/v1/sessions/${id}/workout`, { workout_id: wkSel.value }); toast('The screen shows it now.'); again();
    }); } }, h('div', { class: 'grow' }, progSel), h('div', { class: 'grow' }, wkSel), btn(x.workout ? 'Change workout' : 'Show on screen', null, 'secondary', { type: 'submit' }),
      x.workout ? btn('Clear', (e) => busy(e.currentTarget, async () => { await put(`/v1/sessions/${id}/workout`, { workout_id: null }); toast('Cleared.'); again(); }), 'ghost') : null) : null);

  const full = x.booked_count >= x.capacity;
  const tools = h('div', { class: 'row wrap', style: 'gap:8px' },
    leads() && x.status === 'scheduled' ? btn('Edit session', () => editSessionDialog(x, locs.data, coachList.data, again), 'secondary') : null,
    x.status === 'scheduled' ? btn('Email families', () => messageDialog(x), 'secondary') : null,
    h('a', { class: 'dp-btn dp-btn--ghost', href: `/signin-sheet.html#${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener' }, 'Print sign-in sheet'));
  const rosterPanel = panel(`${x.team ? 'Guests' : 'Roster'} · ${x.booked_count}/${x.capacity}${full ? ' · Full' : ''}`, { subtitle: x.team ? 'Athletes booked who aren\'t on this team, like a tryout or a sibling.' : `${x.attended_count} checked in${x.unpaid_count ? ` · ${x.unpaid_count} unpaid` : ''}${x.age_min || x.age_max ? ` · ages ${x.age_min ?? ''}–${x.age_max ?? ''}` : ''}` },
    active.length ? active.map(row) : h('p', { class: 'muted' }, x.team ? 'No guests.' : 'Nobody booked yet.'), x.status === 'scheduled' ? addForm : null);
  const promote = (r) => btn('Move up', (e) => {
    if (full && !confirm(`${x.name} is full. Move ${r.name} up anyway? The session goes over its ${x.capacity} spots.`)) return;
    busy(e.currentTarget, async () => { const out = await post(`/v1/bookings/${r.id}/promote`); toast(out.message, out.over_spots ? 'warn' : 'good'); again(); });
  }, 'outline', { 'aria-label': `Move ${r.name} up from the waitlist` });

  fill(main,
    header(x.name, `${dayOf(x.starts_at)} · ${timeOf(x.starts_at)}–${timeOf(x.ends_at)} · ${x.location_name}${x.coach_name ? ` · ${x.coach_name}` : ''}${x.status === 'canceled' ? ' · CANCELED' : ''}`, h('a', { class: 'dp-btn dp-btn--secondary', href: lastScheduleHash }, 'Schedule')),
    panel(null, {}, h('div', { class: 'stack', style: 'gap:12px' }, h('div', { class: 'row wrap', style: 'gap:8px' }, stateBadge(st), kindBadge(x.kind), full && st !== 'done' ? h('span', { class: 'dp-badge dp-badge--neutral' }, 'Full') : null, st !== 'later' ? checkinBar(x) : null),
      coachLine, x.staff_note ? h('p', { class: 'small', style: 'margin:0' }, h('span', { class: 'dp-label', style: 'margin:0 8px 0 0' }, 'Staff note'), x.staff_note) : null, tools)),
    x.team ? panel(`${x.team.org_name} ${x.team.team_name}`, { subtitle: `${x.team.athletes.filter((a) => a.present).length} of ${x.team.athletes.length} here · billed through the team contract`, action: h('div', { class: 'row' },
        x.team.athletes.some((a) => !a.present) ? btn('Everyone\'s here', (e) => busy(e.currentTarget, async () => {
          for (const a of x.team.athletes.filter((t) => !t.present)) await post(`/v1/sessions/${id}/team-attendance`, { client_id: a.client_id, present: true });
          toast('Everyone checked in. Tap anyone who\'s missing.'); again();
        }), 'secondary') : null,
        h('a', { class: 'dp-btn dp-btn--secondary', href: `#/teams/${x.team.contract_id}` }, 'Team')) },
      x.team.athletes.length ? x.team.athletes.map((a) => h('div', { class: 'list-item' },
        h('button', { type: 'button', class: 'dp-ex-log', style: 'min-width:92px', 'data-focus': `team-${a.client_id}`, 'aria-pressed': String(a.present), 'aria-label': `${a.present ? 'Here' : 'Mark here'}: ${a.name}`,
          onClick: (e) => busy(e.currentTarget, async () => { await post(`/v1/sessions/${id}/team-attendance`, { client_id: a.client_id, present: !a.present }); await again(); }) }, a.present ? 'Here' : 'Check in'),
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.name), h('span', { class: 'small muted' }, [a.position, a.grad_year ? `Class of ${a.grad_year}` : null].filter(Boolean).join(' · '))))) : h('p', { class: 'muted' }, 'No roster yet. Add athletes on the team page.')) : null,
    rosterPanel,
    waiting.length ? panel(`Waitlist · ${waiting.length}`, { subtitle: 'Moves up on its own, in order, when a spot opens. Move someone up now to go over the spots.' }, waiting.map((r, i) => h('div', { class: 'list-item' }, h('span', { class: 'small muted', style: 'width:24px' }, `${i + 1}.`), h('span', { class: 'grow' }, r.name),
      x.status === 'scheduled' ? promote(r) : null,
      btn('Remove', (e) => busy(e.currentTarget, async () => { await post(`/v1/bookings/${r.id}/cancel`, { waive: true }); again(); }), 'ghost', { 'aria-label': `Remove ${r.name} from the waitlist` })))) : null,
    screenPanel,
    done.length ? panel('Canceled', {}, done.map((r) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, r.name), h('span', { class: 'muted' }, r.status === 'late_canceled' ? 'Late cancel (session used)' : 'Canceled')))) : null,
    x.status === 'scheduled' && leads() ? h('div', { class: 'row' }, h('span', { class: 'grow' }), btn('Cancel this session', (e) => {
      const reason = prompt(`Tell families why (they'll get an email${x.team ? ', and so will the school or club contact' : ''}). Credits come back and drop-ins are refunded.`, 'Weather');
      if (reason === null) return;
      busy(e.currentTarget, async () => { const r = await post(`/v1/sessions/${id}/cancel`, { reason }); toast(`Session canceled.${r.families_emailed ? ` ${nplural(r.families_emailed, 'family', 'families')} emailed.` : ''}${r.team_contact_emailed ? ' The team contact was emailed.' : ''}`); again(); });
    }, 'ghost')) : null);
}

// Self check-in: a QR poster for the door and check-in tablets for the front desk.
function checkinPanel(locations, kiosks) {
  const places = locations.filter((l) => l.active && ['facility', 'park', 'other'].includes(l.kind) && l.name !== 'Online');   // places with a door
  const shown = h('div');
  const canManage = state.user?.role !== 'front_desk';
  const poster = (l) => async (e) => busy(e.currentTarget, async () => { const c = await get(`/v1/locations/${l.id}/check-in-code`); window.open(c.poster_url || `/poster.html?code=${c.code}`, '_blank'); });
  const tablet = (l) => async (e) => busy(e.currentTarget, async () => {
    const k = await post('/v1/kiosks', { location_id: l.id });
    if (!k.link.startsWith('http')) k.link = location.origin + k.link;
    if (k.screen_link && !k.screen_link.startsWith('http')) k.screen_link = location.origin + k.screen_link;
    fill(shown, h('div', { class: 'dp-panel stack', style: 'background:var(--surface-2, transparent)' },
      h('div', { class: 'strong' }, `Tablet link for ${l.name}`),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Open this link once in the tablet\'s browser, then add it to the home screen. Anyone with the link can check athletes in here, so don\'t share it. It\'s only shown now.'),
      h('code', { style: 'word-break:break-all' }, k.link),
      h('div', null, btn('Copy tablet link', async () => { await navigator.clipboard?.writeText(k.link).catch(() => {}); toast('Tablet link copied.'); }, 'secondary')),
      k.screen_link ? [h('div', { class: 'strong', style: 'margin-top:8px' }, 'Weight-room screen link'),
        h('p', { class: 'small muted', style: 'margin:0' }, 'The same key for a TV or shared tablet in the weight room: it shows the workout picked on the session page, and athletes tap their name to log it. Remove the tablet above to turn both off.'),
        h('code', { style: 'word-break:break-all' }, k.screen_link),
        h('div', null, btn('Copy screen link', async () => { await navigator.clipboard?.writeText(k.screen_link).catch(() => {}); toast('Screen link copied.'); }, 'secondary'))] : null));
  });
  return panel('Self check-in', { subtitle: 'Athletes check themselves in for sessions they\'re booked on, from 30 minutes before the start. The roster updates as they do.' },
    places.length ? places.map((l) => h('div', { class: 'list-item' }, h('span', { class: 'grow strong' }, l.name),
      btn('Door poster', poster(l), 'outline'), btn('Set up a tablet', tablet(l), 'ghost'),
      canManage ? btn('New door code', (e) => { if (confirm(`Make a new code for ${l.name}? Printed posters there stop working.`)) busy(e.currentTarget, async () => { await post(`/v1/locations/${l.id}/check-in-code/reset`); toast('New code made. Print the poster again.'); }); }, 'ghost') : null))
      : h('p', { class: 'muted', style: 'margin:0' }, 'Add a location in Point of sale first.'),
    shown,
    kiosks.length ? h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label' }, 'Tablets in use'), kiosks.map((k) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', null, k.name), h('span', { class: 'small muted' }, k.last_seen_at ? `Last used ${ago(k.last_seen_at)}` : 'Not opened yet')),
      canManage ? btn('Remove', (e) => busy(e.currentTarget, async () => { await del(`/v1/kiosks/${k.id}`); toast('That tablet can\'t check anyone in now.'); render(); }), 'ghost') : null))) : null);
}

// Days off: a coach's hide that coach's private and evaluation times; the whole facility's hide everyone's.
function timeOffPanel(rows, coaches) {
  const owner = isOwner();
  const who = owner ? select([['', 'Whole facility'], ...coaches.map((c) => [c.id, c.name])], { value: '' }) : null;
  const from = input({ type: 'date', value: bizDate(1) }), to = input({ type: 'date', value: bizDate(1) }), note = input({ placeholder: 'Optional, like Tournament weekend' });
  const range = (t) => (t.start_date === t.end_date ? ymd(t.start_date) : `${ymd(t.start_date)} – ${ymd(t.end_date)}`);
  const mayRemove = (t) => owner || t.user_id === state.user.id;
  return panel('Time off', { subtitle: 'Private and evaluation times aren\'t offered on these days. Classes stay on the schedule: give them a sub on the session page.' },
    rows.length ? rows.map((t) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, t.user_id ? t.coach_name : 'Whole facility'), h('span', { class: 'small muted' }, [range(t), t.note].filter(Boolean).join(' · '))),
      leads() && mayRemove(t) ? btn('Remove', (e) => busy(e.currentTarget, async () => { await del(`/v1/time-off/${t.id}`); toast('Removed. Those times are offered again.'); render(); }), 'ghost') : null))
      : h('p', { class: 'muted', style: 'margin:0' }, 'No time off coming up.'),
    !leads() ? null : h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const r = await post('/v1/time-off', { user_id: owner ? who.value || null : state.user.id, start_date: from.value, end_date: to.value || from.value, note: note.value || undefined });
      const n = r.sessions_to_cover.length;
      if (n) toast(`Saved. ${n} ${n === 1 ? 'session' : 'sessions'} on those days still ${n === 1 ? 'needs' : 'need'} a sub: ${r.sessions_to_cover.slice(0, 3).map((x) => `${tzFmt(x.starts_at, { weekday: 'short', month: 'short', day: 'numeric' })} ${x.name}`).join(', ')}${n > 3 ? '…' : ''}.`, 'warn');
      else toast('Time off saved.');
      await render();
    }); } },
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(150px,1fr))' }, who ? field('Who', who) : null, field('First day', from), field('Last day', to), field('Note', note)),
      h('div', null, btn(owner ? 'Add time off' : 'Add my time off', null, 'secondary', { type: 'submit' }))));
}

async function viewScheduleSetup(main) {
  const [av, locs, settings, kiosks, coachList, timeOff, privSlots, evalSlots] = await Promise.all([get('/v1/availability'), get('/v1/locations'), get('/v1/settings'), get('/v1/kiosks'), get('/v1/coaches'), get('/v1/time-off'),
    get('/v1/slots?kind=private&days=7').catch(() => null), get('/v1/slots?kind=evaluation&days=7').catch(() => null)]);
  const slots = { private: privSlots, evaluation: evalSlots };
  tzName = settings.timezone;
  const coaches = coachList.data;
  const a = { kind: select([['private', 'Private training'], ['evaluation', 'Evaluations']]), loc: select(locs.data.map((l) => [l.id, l.name])), from: input({ type: 'time', value: '15:00' }), to: input({ type: 'time', value: '19:00' }), len: input({ type: 'number', value: '60', min: '15', step: '15' }), price: input({ type: 'number', step: '0.01', placeholder: 'Evaluations' }),
    coach: coachPicker(coaches, state.user.role === 'coach' ? state.user.id : '', null) };
  const hoursCoach = (x) => {
    if (!leads()) return h('span', { class: 'small muted' }, x.coach_name ?? 'No coach set');
    const sel = coachPicker(coaches, x.coach_id, x.coach_name, { 'aria-label': `Coach for ${DAY_NAMES[x.weekday]} ${x.start_time} hours`, style: 'width:auto;max-width:180px' });
    sel.addEventListener('change', () => busy(sel, async () => { await patch(`/v1/availability/${x.id}`, { coach_id: sel.value || null }); toast(sel.value ? `These hours are ${sel.selectedOptions[0].textContent}'s now.` : 'These hours have no coach set.'); render(); }));
    return sel;
  };
  // Hours, grouped by what they're for, with what parents can book in the next 7 days so you can see them working.
  const hourRow = (x) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' }, h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('span', null, `${DAY_NAMES[x.weekday]} ${hm12(x.start_time)}–${hm12(x.end_time)} · ${x.slot_minutes} min · ${x.location_name}${x.price_cents ? ` · ${money(x.price_cents)}` : ''}`),
      x.coach_active === false ? h('span', { class: 'small warn-text' }, `${x.coach_name} can't lead sessions now (account turned off or moved to front desk), so these hours aren't offered. Pick another coach or remove them.`) : null),
    hoursCoach(x),
    leads() ? btn('Remove', (e) => { if (confirm(`Remove ${DAY_NAMES[x.weekday]} ${hm12(x.start_time)}–${hm12(x.end_time)} ${x.kind === 'private' ? 'private' : 'evaluation'} hours? Times already booked stay booked.`)) busy(e.currentTarget, async () => { await del(`/v1/availability/${x.id}`); toast('Hours removed.'); render(); }); }, 'ghost', { 'aria-label': `Remove ${DAY_NAMES[x.weekday]} ${x.start_time} hours` }) : null);
  const preview = (kind) => {
    const s = slots[kind]?.data ?? [];
    return h('p', { class: 'small muted', style: 'margin:0 0 4px' }, s.length ? `Next 7 days: ${nplural(s.length, 'open time')}, the first ${tzFmt(s[0].starts_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : 'Next 7 days: no open times. Add hours, or check time off and what\'s on the schedule then.');
  };
  const group = (kind, label) => { const rows = av.data.filter((x) => x.kind === kind); return h('div', { class: 'stack-tight' }, h('div', { class: 'dp-label', style: 'margin-top:8px' }, `${label} (${rows.length})`), preview(kind), rows.length ? rows.map(hourRow) : h('p', { class: 'muted', style: 'margin:0' }, 'No hours yet.')); };
  const dayBoxes = DAY_NAMES.map((d, i) => h('label', { class: 'row small', style: 'gap:6px;min-height:44px' }, h('input', { type: 'checkbox', value: String(i) }), d));
  const hours = panel('Hours for privates and evaluations', { subtitle: 'Parents book open times in the portal. Hours with a coach are blocked by anything that coach leads, anywhere, and by sessions at that place with no coach. Hours with no coach are blocked by anything at that place.' },
    group('private', 'Private training'), group('evaluation', 'Evaluations'),
    !leads() ? null : h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px;margin-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const weekdays = dayBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
      if (!weekdays.length) throw new Error('Tick at least one day.');
      const r = await post('/v1/availability', { kind: a.kind.value, location_id: a.loc.value, weekdays, start_time: a.from.value, end_time: a.to.value, slot_minutes: Number(a.len.value), price_cents: a.price.value ? Math.round(Number(a.price.value) * 100) : undefined, coach_id: a.coach.value || null });
      toast(`Hours added on ${r.added.map((x) => DAY_NAMES[x.weekday]).join(', ')}.`); render();
    }); } }, h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(150px,1fr))' }, field('For', a.kind), field('Where', a.loc), field('Coach', a.coach)),
      h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'dp-label' }, 'Days (tick several to add them all at once)'), h('div', { class: 'row wrap', style: 'gap:12px' }, dayBoxes)),
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(120px,1fr))' }, field('From', a.from), field('To', a.to), field('Minutes each', a.len), field('Price ($)', a.price)),
      h('div', null, btn('Add hours', null, 'primary', { type: 'submit' }))));

  const shareSel = select([['reviewed', 'After I share a testing day (recommended)'], ['all', 'As soon as results are saved']], { value: settings.share_results ?? 'reviewed' });
  const st = { tz: input({ value: settings.timezone }), late: input({ type: 'number', min: '0', value: settings.late_cancel_hours }), name: input({ value: settings.business_name }), addr: textarea(settings.business_address), payInst: textarea(settings.payment_instructions) };
  const waiver = h('textarea', { class: 'dp-input', style: 'min-height:220px' }); waiver.value = settings.waiver_text;
  const setPanel = panel('Policies', {},
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const changedWaiver = waiver.value !== settings.waiver_text;
      if (changedWaiver && !confirm('Changing the waiver asks every family to sign again before their next booking. Continue?')) return;
      await patch('/v1/settings', { share_results: shareSel.value, timezone: st.tz.value, late_cancel_hours: Number(st.late.value), business_name: st.name.value, business_address: st.addr.value, payment_instructions: st.payInst.value, waiver_text: waiver.value });
      toast('Settings saved.'); render();
    }); } },
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('Business name', st.name), field('Time zone', st.tz, 'Like America/Chicago'), field('Late-cancel window (hours)', st.late, 'Cancels inside this still use the session.')),
      h('div', { class: 'form-grid' }, field('Business address (on invoices)', st.addr), field('How schools can pay (on invoices)', st.payInst, 'For example who to make checks payable to.')),
      field('Parents see test results', shareSel),
      field('Waiver (have a lawyer write this)', waiver, `Version ${settings.waiver_version}`),
      h('div', null, btn('Save settings', null, 'secondary', { type: 'submit' }))));
  // Owners: public sign-up, terms and privacy, automatic emails.
  const joinUrl = `${location.origin}/join`;
  const signupToggle = h('input', { type: 'checkbox', checked: settings.public_signup === 'on' });
  const signupPanel = panel('Family sign-up', { subtitle: 'New families can create their own account, add athletes, agree to your terms and confirm their email. They sign the waiver and add a card in the portal.' },
    h('div', { class: 'row wrap', style: 'gap:12px' }, h('code', { style: 'font-size:15px' }, joinUrl),
      btn('Copy link', async () => { await navigator.clipboard?.writeText(joinUrl).catch(() => {}); toast('Sign-up link copied. Put it on your website, Instagram and a QR code at the facility.'); }, 'secondary'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: '/join', target: '_blank' }, 'Open')),
    h('label', { class: 'row small', style: 'gap:8px;min-height:40px' }, signupToggle, h('span', null, 'Sign-up is open')),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Not ready to sign up? The "Ask about training" form collects their details as a lead and follows up automatically (Leads).'),
    h('div', { class: 'row wrap', style: 'gap:12px' }, h('code', { style: 'font-size:15px' }, `${location.origin}/start`),
      btn('Copy link', async () => { await navigator.clipboard?.writeText(`${location.origin}/start`).catch(() => {}); toast('Inquiry form link copied.'); }, 'secondary'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: '/start', target: '_blank' }, 'Open')),
    h('div', null, btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { public_signup: signupToggle.checked ? 'on' : 'off' }); toast(signupToggle.checked ? 'Sign-up is open.' : 'Sign-up is closed.'); render(); }), 'secondary')));
  const terms = h('textarea', { class: 'dp-input', style: 'min-height:200px' }); terms.value = settings.terms_text;
  const privacy = h('textarea', { class: 'dp-input', style: 'min-height:200px' }); privacy.value = settings.privacy_text;
  const legalPanel = panel('Terms of service and privacy policy', { subtitle: 'Paste your lawyer\'s wording. Parents agree when they sign up; changing either asks every parent to accept again before their next booking or purchase. Blank lines start new paragraphs.' },
    field(`Terms of service (version ${settings.terms_version}${settings.terms_text.trim().startsWith('[') ? ', not published yet' : ''})`, terms),
    h('a', { class: 'small', href: '/terms', target: '_blank' }, 'See the public page'),
    field(`Privacy policy (version ${settings.privacy_version}${settings.privacy_text.trim().startsWith('[') ? ', not published yet' : ''})`, privacy),
    h('a', { class: 'small', href: '/privacy', target: '_blank' }, 'See the public page'),
    h('div', null, btn('Save', (e) => {
      const changed = terms.value !== settings.terms_text || privacy.value !== settings.privacy_text;
      if (changed && !confirm('Every parent will be asked to accept the new version before their next booking or purchase. Continue?')) return;
      busy(e.currentTarget, async () => { await patch('/v1/settings', { terms_text: terms.value, privacy_text: privacy.value }); toast('Saved.'); render(); });
    }, 'secondary')));
  const EMAILS = { welcome: 'Welcome, when a family signs up or you add them', receipts: 'Receipts for sales and membership payments', trial_ending: 'Reminder 3 days before a free trial ends', payment_failed: 'When a membership payment doesn\'t go through' };
  const off = new Set((settings.emails_off ?? '').split(',').filter(Boolean));
  const emailBoxes = Object.entries(EMAILS).map(([k, label]) => [k, h('input', { type: 'checkbox', checked: !off.has(k) }), label]);
  const emailPanel = panel('Automatic emails', { subtitle: 'Sent from your email address once email is connected. Every email also appears in the outbox under API & integrations.' },
    emailBoxes.map(([, cb, label]) => h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, cb, h('span', null, label))),
    h('div', null, btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { emails_off: emailBoxes.filter(([, cb]) => !cb.checked).map(([k]) => k) }); toast('Saved.'); }), 'secondary')));
  const TEXTS = { reminder: 'Reminder the day before a booked session', waitlist: 'When an athlete moves off the waitlist', canceled: 'When you cancel a session', payment_failed: 'When a membership payment doesn\'t go through' };
  const textsOff = new Set((settings.texts_off ?? '').split(',').filter(Boolean));
  const textBoxes = Object.entries(TEXTS).map(([k, label]) => [k, h('input', { type: 'checkbox', checked: !textsOff.has(k) }), label]);
  const textPanel = panel('Automatic texts', { subtitle: 'Only sent to parents who turn texts on in the parent portal. Every text also appears under API & integrations → Texts.' },
    textBoxes.map(([, cb, label]) => h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, cb, h('span', null, label))),
    h('div', null, btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { texts_off: textBoxes.filter(([, cb]) => !cb.checked).map(([k]) => k) }); toast('Saved.'); }), 'secondary')));
  const digestOn = h('input', { type: 'checkbox', checked: settings.weekly_digest !== 'off' });
  const digestOut = h('pre', { class: 'small muted', style: 'white-space:pre-wrap;margin:0' });
  const digestPanel = panel('Weekly summary email', { subtitle: 'Every Monday at 7 am: money in, members, athletes to check on, open spots and three things worth doing this week. Sent to every owner.' },
    h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, digestOn, h('span', null, 'Send me the weekly summary')),
    h('div', { class: 'row wrap' },
      btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { weekly_digest: digestOn.checked ? 'on' : 'off' }); toast('Saved.'); }), 'secondary'),
      btn('Preview this week', (e) => busy(e.currentTarget, async () => { digestOut.textContent = (await get('/v1/digest')).text; }), 'outline'),
      btn('Email it to me now', (e) => busy(e.currentTarget, async () => { await post('/v1/digest/send'); toast('Sent. It\'s also in the email outbox.'); }), 'ghost')),
    digestOut);
  fill(main, header('Hours & settings', 'Hours, policies, sign-up, terms, emails and texts.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule' }, 'Schedule')), hours, timeOffPanel(timeOff.data, coaches), checkinPanel(locs.data, kiosks.data), setPanel, rankingsPanel(settings), readinessPanel(settings),
    isOwner() ? [signupPanel, legalPanel, digestPanel, emailPanel, textPanel] : null);
}

// ---------- Teams (school and club contracts) ----------
const INV_BADGE = { open: ['Open', 'neutral'], overdue: ['Overdue', 'warn'], paid: ['Paid', 'good'], void: ['Void', 'muted'] };
const invBadge = (st) => h('span', { class: `dp-badge dp-badge--${INV_BADGE[st]?.[1] ?? 'muted'}` }, INV_BADGE[st]?.[0] ?? st);
const ymd = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const nplural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pctText = (r) => `${Math.round(r * 100)}%`;
const TERMS = [['30', 'Net 30'], ['15', 'Net 15'], ['45', 'Net 45'], ['60', 'Net 60'], ['0', 'Due on receipt']];
const termsName = (d) => (d === 0 ? 'Due on receipt' : `Net ${d}`);
const termsOptions = (d) => (TERMS.some(([k]) => k === String(d)) ? TERMS : [...TERMS, [String(d), `Net ${d}`]]);
const ORG_KIND = [['school', 'School'], ['club', 'Club'], ['other', 'Other']];
const PAY_METHOD = [['check', 'Check'], ['ach', 'Bank transfer'], ['card', 'Card'], ['cash', 'Cash'], ['other', 'Other']];
const METHOD_WORD = { check: 'check', ach: 'bank transfer', card: 'card', cash: 'cash', online: 'online payment', other: 'payment' };
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`;
// "15:30" -> "3:30 PM"
const hm12 = (t) => { const [hh, mm] = String(t ?? '').split(':').map(Number); return Number.isFinite(hh) ? `${((hh + 11) % 12) + 1}:${String(mm || 0).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}` : t; };
// Same month arithmetic as the server: the billing day is the start day, clamped to the end of shorter months.
const periodOf = (start, k) => { const [y, m, d] = start.split('-').map(Number); const f = new Date(Date.UTC(y, m - 1 + k, 1)); f.setUTCDate(Math.min(d, new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)).getUTCDate())); return f.toISOString().slice(0, 10); };
const dollarsToCents = (s) => { const t = String(s ?? '').replace(/[$,\s]/g, ''); return t === '' ? NaN : Math.round(Number(t) * 100); };
const textarea = (value = '', attrs = {}) => { const t = h('textarea', { class: 'dp-input', style: 'min-height:72px', ...attrs }); t.value = value ?? ''; return t; };

// A dialog with a title, a body and buttons. Each action's onClick returns false to keep the dialog open.
function teamDialog(title, body, actions) {
  const d = document.getElementById('dialog');
  const err = h('div', { class: 'dp-error', role: 'alert' });
  fill(d, h('div', { class: 'stack' }, h('h2', { class: 'week-title', style: 'color:var(--steel)' }, title), body, err,
    h('div', { class: 'row wrap' }, actions.map((a) => btn(a.label, async (e) => {
      if (!a.onClick) return d.close();
      err.textContent = '';
      const b = e.currentTarget; b.disabled = true;
      try { if ((await a.onClick(d)) !== false) d.close(); } catch (x) { err.textContent = x.message; } finally { b.disabled = false; }
    }, a.variant ?? 'secondary')))));
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
  return d;
}
// A toast with an Undo button for a few seconds.
function undoToast(msg, onUndo) {
  const t = h('div', { class: 'dp-toast', role: 'status' }, msg, ' ', h('button', { type: 'button', class: 'dp-btn dp-btn--ghost', style: 'min-height:32px;padding:0 8px;color:inherit;text-decoration:underline', onClick: () => { t.remove(); onUndo(); } }, 'Undo'));
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 8000);
}
// Point at the field a server error names (error.details.field), and show the message.
function fieldErr(fields, err, box) {
  for (const el of Object.values(fields)) el?.removeAttribute?.('aria-invalid');
  const el = fields[err.details?.field];
  if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
  if (box) box.textContent = err.message; else toast(err.message, 'warn');
}
// Cells a spreadsheet would run as a formula get a leading apostrophe.
const csvCell = (x) => { let s = String(x ?? ''); if (/^[=@\t\r+-]/.test(s) && !/^-?\d+(\.\d+)?%?$/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function downloadCsv(name, rows) {
  const a = h('a', { href: URL.createObjectURL(new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' })), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// How they paid / Check number / Received, shared by one invoice and several.
function payFields() {
  const method = select(PAY_METHOD, { value: 'check' }), ref = input({ autocomplete: 'off', maxlength: '120', inputmode: 'numeric' }), on = input({ type: 'date', value: bizDate(), max: bizDate() });
  const refField = field('Check number (optional)', ref);
  method.addEventListener('change', () => { refField.querySelector('label').textContent = method.value === 'check' ? 'Check number (optional)' : 'Reference (optional)'; ref.inputMode = method.value === 'check' ? 'numeric' : 'text'; });
  return { el: h('div', { class: 'form-grid cols-3' }, field('How they paid', method), refField, field('Received', on)), values: () => ({ method: method.value, reference: ref.value.trim() || undefined, paid_on: on.value || undefined }), fields: { method, reference: ref, paid_on: on } };
}
function recordPaymentDialog(i) {
  const pf = payFields();
  teamDialog('Record payment', h('div', { class: 'stack' }, h('p', { class: 'muted', style: 'margin:0' }, `${i.number} · ${money(i.amount_cents)}${i.org_name ? ` · ${i.org_name}` : ''}`), pf.el),
    [{ label: 'Record payment', variant: 'primary', onClick: async () => { await post(`/v1/team-invoices/${i.id}/payments`, pf.values()); toast(`${i.number} marked paid.`); render(); } }, { label: 'Cancel', variant: 'ghost' }]);
}
function payManyDialog(c) {
  const open = c.invoices.filter((i) => ['open', 'overdue'].includes(i.status)).slice().reverse();
  const total = h('span', { class: 'strong' });
  const boxes = open.map((i) => h('input', { type: 'checkbox', value: i.id, checked: true, 'data-amt': String(i.amount_cents) }));
  const sum = () => boxes.filter((b) => b.checked).reduce((t, b) => t + Number(b.dataset.amt), 0);
  const redraw = () => { total.textContent = money(sum()); };
  const pf = payFields();
  const list = h('div', { class: 'stack-tight', role: 'group', 'aria-label': 'Invoices this payment covers', style: 'max-height:40vh;overflow:auto' }, open.map((i, n) => h('label', { class: 'list-item', style: 'cursor:pointer;min-height:44px' }, boxes[n],
    h('span', { class: 'grow stack-tight' }, h('span', null, i.number), h('span', { class: 'small muted' }, `${i.period_start ? `${ymd(i.period_start)} – ${ymd(i.period_end)}` : i.lines[0]?.description ?? ''}${i.days_past_due ? ` · ${nplural(i.days_past_due, 'day')} past due` : ` · due ${ymd(i.due_on)}`}`)),
    h('span', { class: 'strong' }, money(i.amount_cents)))));
  list.addEventListener('change', redraw); redraw();
  teamDialog('Record one payment', h('div', { class: 'stack' }, h('p', { class: 'muted', style: 'margin:0' }, 'Tick the invoices this payment covers, like one check for several months.'), list, h('p', { style: 'margin:0' }, 'Total ', total), pf.el),
    [{ label: 'Record payment', variant: 'primary', onClick: async () => {
      const ids = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!ids.length) throw new Error('Tick at least one invoice.');
      const r = await post(`/v1/team-contracts/${c.id}/payments`, { invoice_ids: ids, total_cents: sum(), ...pf.values() });
      toast(`${nplural(r.count, 'invoice')} marked paid, ${money(r.total_cents)} in all.`); render();
    } }, { label: 'Cancel', variant: 'ghost' }]);
}

function invoiceRow(i, { showTeam = false } = {}) {
  const unpaid = ['open', 'overdue'].includes(i.status);
  const title = showTeam ? h('a', { class: 'strong', href: `#/teams/${i.contract_id}`, style: 'color:inherit' }, `${i.org_name} · ${i.team_name}`) : h('span', { class: 'strong' }, i.number);
  const sub = i.status === 'paid' ? `Paid ${ymd(i.paid_on)} by ${METHOD_WORD[i.paid_method] ?? i.paid_method}${i.paid_reference ? ` ${i.paid_reference}` : ''}`
    : i.status === 'void' ? `Voided · ${i.lines[0]?.description ?? ''}`
      : [i.period_start ? `${ymd(i.period_start)} – ${ymd(i.period_end)}` : i.lines[0]?.description ?? '', i.days_past_due ? `${nplural(i.days_past_due, 'day')} past due` : `due ${ymd(i.due_on)}`, i.sent_at ? `emailed ${ago(i.sent_at).toLowerCase()}` : 'not emailed'].filter(Boolean).join(' · ');
  return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, title, h('span', { class: `small ${i.days_past_due ? 'warn-text' : 'muted'}` }, `${showTeam ? `${i.number} · ` : ''}${sub}`)),
    h('span', { class: 'strong' }, money(i.amount_cents)), invBadge(i.status),
    h('div', { class: 'row wrap', style: 'gap:4px' }, h('a', { class: 'dp-btn dp-btn--ghost', href: i.link, target: '_blank', rel: 'noopener', 'aria-label': `View ${i.number} as the school sees it` }, 'View'),
      unpaid ? btn('Record payment', () => recordPaymentDialog(i), 'outline') : null,
      unpaid ? btn('Email', (e) => busy(e.currentTarget, async () => { await post(`/v1/team-invoices/${i.id}/send`); toast(`${i.number} emailed.`); render(); }), 'ghost', { 'aria-label': `Email ${i.number} again` }) : null,
      unpaid ? btn('Void', (e) => { if (confirm(`Void ${i.number}? The school can no longer pay it and it stops counting as unpaid. To bill a corrected amount, use Bill something extra.`)) busy(e.currentTarget, async () => { await post(`/v1/team-invoices/${i.id}/void`); toast(`${i.number} voided.`); render(); }); }, 'ghost', { 'aria-label': `Void ${i.number}` }) : null));
}

const teamsUi = { view: null, q: '' };
async function viewTeams(main) {
  const [contracts, unpaid, sum] = await Promise.all([get('/v1/team-contracts'), get('/v1/team-invoices?status=unpaid'), get('/v1/team-billing/summary')]);
  const all = contracts.data;
  const count = (v) => all.filter((c) => v === 'all' || c.status === v).length;
  if (!teamsUi.view) teamsUi.view = count('active') || !all.length ? 'active' : 'all';
  const overdue = unpaid.data.filter((i) => i.status === 'overdue');
  const box = h('div', { 'aria-live': 'polite' });
  const views = h('div', { class: 'row wrap tm-views', role: 'group', 'aria-label': 'Show' });
  const drawList = () => {
    const q = teamsUi.q.trim().toLowerCase();
    const shown = all.filter((c) => (teamsUi.view === 'all' || c.status === teamsUi.view) && (!q || `${c.org_name} ${c.name} ${c.po_number ?? ''}`.toLowerCase().includes(q)));
    fill(views, [['active', 'Active'], ['ended', 'Ended'], ['all', 'All']].map(([v, label]) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(teamsUi.view === v), onClick: () => { teamsUi.view = v; drawList(); } }, label, h('span', { class: 'muted' }, String(count(v))))));
    fill(box, !all.length ? h('div', { class: 'empty' }, 'No team contracts yet. Schools and clubs pay a flat monthly fee, and invoices go out on their own.')
      : !shown.length ? h('p', { class: 'muted' }, q ? `No ${teamsUi.view === 'all' ? '' : `${teamsUi.view} `}contracts match "${teamsUi.q.trim()}".` : `No ${teamsUi.view} contracts.`)
        : shown.map((c) => h('a', { class: 'list-item', href: `#/teams/${c.id}`, style: 'text-decoration:none;color:inherit;flex-wrap:wrap' },
          h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', { class: 'strong' }, `${c.org_name} · ${c.name}`),
            h('span', { class: 'small muted' }, [`${money(c.monthly_cents)}/month`, termsName(c.terms_days), nplural(c.roster_count, 'athlete'), c.attendance_rate != null ? `${pctText(c.attendance_rate)} attendance` : null,
              c.status === 'ended' ? `ended ${ymd(c.end_date)}` : c.next_invoice_on ? `next invoice ${ymd(c.next_invoice_on)}` : 'no more invoices'].filter(Boolean).join(' · '),
            c.contact_email ? null : h('span', { class: 'warn-text' }, ' · add a billing email'))),
          c.overdue_cents ? h('span', { class: 'dp-badge dp-badge--warn' }, `${money(c.overdue_cents)} overdue`) : c.balance_cents ? h('span', { class: 'dp-badge dp-badge--neutral' }, `${money(c.balance_cents)} open`) : null,
          c.status === 'ended' ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Ended') : null)));
  };
  const search = all.length > 4 ? input({ type: 'search', placeholder: 'School, team or PO number', 'aria-label': 'Search contracts', value: teamsUi.q, autocomplete: 'off' }) : null;
  search?.addEventListener('input', () => { teamsUi.q = search.value; drawList(); });
  drawList();
  const remind = overdue.length ? btn(`Email overdue reminders (${overdue.length})`, (e) => {
    if (!confirm(`Email a reminder for each overdue invoice now? ${nplural(overdue.length, 'invoice is', 'invoices are')} overdue. The weekly reminder then waits another week.`)) return;
    busy(e.currentTarget, async () => { const r = await post('/v1/team-billing/remind-overdue'); toast(`${nplural(r.sent, 'reminder')} emailed.${r.skipped ? ` ${r.skipped} had no billing email: ${r.schools_without_email.join(', ')}.` : ''}`, r.skipped ? 'warn' : 'good'); render(); });
  }, 'secondary') : null;
  fill(main,
    header('Teams', 'School and club contracts, billed a flat monthly fee.', h('a', { class: 'dp-btn dp-btn--primary', href: '#/teams/new' }, 'New team contract')),
    h('div', { class: 'metrics' },
      metric('Monthly contract revenue', money(sum.monthly_cents), nplural(sum.active_contracts, 'active team')),
      metric('Waiting on payment', money(sum.open_cents), nplural(sum.open_count, 'open invoice')),
      metric('Overdue', money(overdue.reduce((t, i) => t + i.amount_cents, 0)), `${overdue.length} past due`, overdue.length ? 'warn' : null),
      metric('Collected', money(sum.collected_30_cents), 'Last 30 days')),
    panel('Contracts', { subtitle: `${nplural(sum.athletes, 'athlete')} on active rosters.`, action: all.length > 1 ? views : null }, search, box),
    panel('Unpaid invoices', { subtitle: 'Invoices email the school\'s billing contact with a link to view, print or pay online. Overdue ones get a reminder each week.', action: remind },
      unpaid.data.length ? unpaid.data.map((i) => invoiceRow(i, { showTeam: true })) : h('p', { class: 'muted' }, 'Nothing unpaid. Every school invoice is settled.')));
}

async function viewNewTeam(main) {
  const [orgs, settings] = await Promise.all([get('/v1/organizations'), get('/v1/settings')]);
  tzName = settings.timezone;
  const orgSel = select([['', 'A new school or club…'], ...orgs.data.map((o) => [o.id, o.name])], { value: '' });
  const o = { name: input({ maxlength: '120', autocomplete: 'off' }), kind: select(ORG_KIND), contact: input({ autocomplete: 'off' }), email: input({ type: 'email', autocomplete: 'off' }), phone: input({ type: 'tel', autocomplete: 'off' }), address: textarea() };
  const t = { name: input({ placeholder: 'Varsity Football', maxlength: '120' }), fee: input({ inputmode: 'decimal', placeholder: '1,200' }), start: input({ type: 'date', value: bizDate() }), end: input({ type: 'date' }),
    terms: select(TERMS, { value: '30' }), po: input({ maxlength: '60' }), past: select([]), notes: textarea('', { maxlength: '2000', placeholder: 'Only staff see this, like Invoices need the AD\'s signature' }) };
  const pastField = field('Months that have already started', t.past);
  const summary = h('div', { class: 'tm-summary', 'aria-live': 'polite' });
  const orgBox = h('div', { class: 'stack' },
    h('div', { class: 'form-grid' }, field('School or club name', o.name), field('Type', o.kind)),
    h('div', { class: 'form-grid cols-3' }, field('Billing contact', o.contact, 'Athletic director or treasurer'), field('Billing email', o.email, 'Invoices go here.'), field('Phone', o.phone)),
    field('Billing address', o.address));
  orgSel.addEventListener('change', () => { orgBox.style.display = orgSel.value ? 'none' : ''; });
  // What happens when you save: how many invoices go out now, and when the rest follow.
  const drawSummary = () => {
    const start = t.start.value, end = t.end.value, fee = dollarsToCents(t.fee.value), T = bizDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) { summary.textContent = 'Choose a start date.'; pastField.hidden = true; return; }
    if (end && end < start) { summary.textContent = 'The end date is before the start date.'; pastField.hidden = true; return; }
    const started = [];
    for (let k = 0; k < 240; k++) { const p = periodOf(start, k); if (p > T || (end && p > end)) break; started.push(p); }
    pastField.hidden = !started.length || start >= T;
    if (!pastField.hidden) {
      const keep = t.past.value || 'all';
      fill(t.past, [['all', started.length > 1 ? `Invoice all ${started.length} now` : 'Invoice it now'], ...(started.length > 1 ? [['current', `Invoice only the current month (from ${ymd(started[started.length - 1])})`]] : []), ['none', 'Don\'t invoice them, they were billed another way']]
        .map(([v, label]) => h('option', { value: v, selected: v === keep }, label)));
    }
    const mode = pastField.hidden ? 'all' : t.past.value;
    const now = mode === 'all' ? started.length : mode === 'current' ? Math.min(1, started.length) : 0;
    let next = null;
    for (let k = 0; k < 240; k++) { const p = periodOf(start, k); if (end && p > end) break; if (p > T) { next = p; break; } }
    const feeTxt = fee > 0 ? money(fee) : 'the monthly fee', day = ordinal(Number(start.slice(8, 10)));
    const parts = [];
    if (now) parts.push(now === 1 ? `One invoice for ${feeTxt} goes out as soon as you save.` : `${now} invoices of ${feeTxt}${fee > 0 ? ` (${money(fee * now)} in all)` : ''} go out as soon as you save.`);
    else if (start > T) parts.push(`The first invoice for ${feeTxt} goes out ${ymd(start)}.`);
    if (next && start <= T) parts.push(`Then one on the ${day} of each month, next ${ymd(next)}${end ? `, until ${ymd(end)}` : ''}.`);
    else if (start > T) parts.push(`Then one on the ${day} of each month${end ? ` until ${ymd(end)}` : ''}.`);
    summary.textContent = parts.join(' ') || 'No invoices go out for this contract.';
  };
  for (const el of [t.start, t.end, t.fee, t.past]) { el.addEventListener('input', drawSummary); el.addEventListener('change', drawSummary); }
  drawSummary();
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const fields = { org_name: o.name, contact_email: o.email, contact_phone: o.phone, name: t.name, monthly_cents: t.fee, start_date: t.start, end_date: t.end, terms_days: t.terms, past: t.past };
  fill(main,
    header('New team contract', 'A flat monthly fee, invoiced to the school or club at the start of each month of the contract.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/teams' }, 'Cancel')),
    h('form', { class: 'dp-panel stack', style: 'max-width:820px', novalidate: true, onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
      try {
        const fee = dollarsToCents(t.fee.value);
        if (!(fee > 0)) throw Object.assign(new Error('Enter the monthly fee, like 1200.'), { details: { field: 'monthly_cents' } });
        const c = await post('/v1/team-contracts', { org_id: orgSel.value || undefined, organization: orgSel.value ? undefined : { name: o.name.value, kind: o.kind.value, contact_name: o.contact.value || undefined, contact_email: o.email.value || undefined, contact_phone: o.phone.value || undefined, billing_address: o.address.value || undefined },
          name: t.name.value, monthly_cents: fee, start_date: t.start.value, end_date: t.end.value || undefined, terms_days: Number(t.terms.value), po_number: t.po.value || undefined, notes: t.notes.value || undefined, past: pastField.hidden ? undefined : t.past.value });
        const sent = c.invoices.filter((i) => i.sent_at).length;
        toast(c.invoices.length ? `Contract created. ${nplural(c.invoices.length, 'invoice')} ${sent ? `emailed to ${c.org.contact_email}` : 'created (add a billing email to send them)'}.` : `Contract created. The first invoice goes out ${ymd(c.next_invoice_on)}.`);
        location.hash = `#/teams/${c.id}`;
      } catch (x) { fieldErr(fields, x, err); }
    }); } },
      field('School or club', orgSel), orgBox,
      h('div', { class: 'form-grid' }, field('Team', t.name), field('Monthly fee ($)', t.fee)),
      h('div', { class: 'form-grid cols-4' }, field('Start', t.start, 'Billing day each month'), field('End (optional)', t.end), field('Payment terms', t.terms), field('PO number', t.po)),
      pastField, summary, field('Notes (staff only)', t.notes),
      err, h('div', null, btn('Create contract', null, 'primary', { type: 'submit' }))));
  o.name.focus();
}

// Unsaved edits to the contract form survive a redraw after recording a payment, adding a session and so on.
const teamUi = { id: null, draft: null, allInvoices: false, q: '', sort: 'name', pasteOpen: false };
async function viewTeam(main, id) {
  if (teamUi.id !== id) Object.assign(teamUi, { id, draft: null, allInvoices: false, q: '', sort: 'name', pasteOpen: false });
  let c;
  try { c = await get(`/v1/team-contracts/${id}`); } catch (e) {
    if (!/not found/i.test(e.message)) throw e;
    return fill(main, header('Contract not found', 'It may have been removed.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/teams' }, 'All teams')), h('div', { class: 'empty' }, 'That team contract wasn\'t found. Open it from the Teams list.'));
  }
  const [locs, settings, coachList, engPanel] = await Promise.all([get('/v1/locations'), get('/v1/settings'), get('/v1/coaches'), teamPanel(id)]);
  tzName = settings.timezone;
  const ended = c.status === 'ended';
  const openInv = c.invoices.filter((i) => ['open', 'overdue'].includes(i.status));

  // Invoices
  const shown = teamUi.allInvoices ? c.invoices : c.invoices.slice(0, 6);
  const extraDesc = input({ placeholder: 'Testing day, Oct 3', maxlength: '200' }), extraAmt = input({ inputmode: 'decimal', placeholder: '0.00' });
  const invoicesPanel = h('div', { id: 'tm-inv' }, panel('Invoices', { subtitle: [c.balance_cents ? `${money(c.balance_cents)} unpaid` : 'Nothing unpaid', c.paid_cents ? `${money(c.paid_cents)} paid to date` : null, c.next_invoice_on ? `next invoice ${ymd(c.next_invoice_on)}` : null].filter(Boolean).join(' · '),
    action: openInv.length ? h('div', { class: 'row wrap', style: 'gap:8px' }, openInv.length > 1 ? btn('Record one payment', () => payManyDialog(c), 'secondary') : null,
      btn('Email statement', (e) => {
        if (!c.org.contact_email) return toast(`Add a billing email for ${c.org.name} first.`, 'warn');
        if (confirm(`Email ${c.org.contact_email} one statement listing ${nplural(openInv.length, 'open invoice')} (${money(c.balance_cents)}), each with its link to view or pay?`)) busy(e.currentTarget, async () => { const r = await post(`/v1/team-contracts/${id}/statement`); toast(`Statement emailed to ${r.to}.`); });
      }, 'secondary')) : null },
    c.invoices.length ? shown.map((i) => invoiceRow(i)) : h('p', { class: 'muted' }, `No invoices yet. The first goes out ${ymd(c.next_invoice_on ?? c.start_date)}.`),
    c.invoices.length > 6 ? btn(teamUi.allInvoices ? 'Show the latest 6' : `Show all ${c.invoices.length} invoices`, () => { teamUi.allInvoices = !teamUi.allInvoices; render(); }, 'ghost') : null,
    h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Bill something extra'),
      h('form', { class: 'row wrap', style: 'margin-top:8px', novalidate: true, onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        const amount = dollarsToCents(extraAmt.value);
        if (!extraDesc.value.trim()) throw new Error('Say what the invoice is for.');
        if (!(amount > 0)) throw new Error('Enter an amount above zero.');
        const i = await post(`/v1/team-contracts/${id}/invoices`, { description: extraDesc.value, amount_cents: amount });
        toast(`${i.number} ${i.sent_at ? `emailed to ${c.org.contact_email}` : 'created. Add a billing email to send it'}.`); render();
      }); } }, h('div', { class: 'grow', style: 'min-width:200px' }, field('What for', extraDesc)), h('div', { style: 'width:140px' }, field('Amount ($)', extraAmt)), h('div', { style: 'align-self:flex-end' }, btn('Create invoice', null, 'secondary', { type: 'submit' }))),
      h('p', { class: 'small muted' }, `It goes on its own invoice with the contract's terms (${termsName(c.terms_days).toLowerCase()})${c.org.contact_email ? `, emailed to ${c.org.contact_email}` : ''}.`))));

  // Contract terms
  const f = { name: input({ value: c.name, maxlength: '120' }), kind: select(ORG_KIND, { value: c.org.kind }), fee: input({ inputmode: 'decimal', value: (c.monthly_cents / 100).toFixed(2) }), end: input({ type: 'date', value: c.end_date ?? '', min: c.start_date }),
    terms: select(termsOptions(c.terms_days), { value: String(c.terms_days) }), po: input({ value: c.po_number ?? '', maxlength: '60' }),
    contact: input({ value: c.org.contact_name ?? '', autocomplete: 'off' }), email: input({ type: 'email', value: c.org.contact_email ?? '', autocomplete: 'off' }), phone: input({ type: 'tel', value: c.org.contact_phone ?? '', autocomplete: 'off' }),
    addr: textarea(c.org.billing_address), notes: textarea(c.notes, { maxlength: '2000', placeholder: 'Only staff see this, like Invoices need the AD\'s signature' }) };
  const dirty = h('span', { class: 'small warn-text', 'aria-live': 'polite' });
  const snapshot = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
  if (teamUi.draft) { for (const [k, val] of Object.entries(teamUi.draft)) if (f[k]) f[k].value = val; dirty.textContent = 'Unsaved changes'; }
  const cErr = h('div', { class: 'dp-error', role: 'alert' });
  const cFields = { name: f.name, monthly_cents: f.fee, end_date: f.end, terms_days: f.terms, contact_email: f.email, contact_phone: f.phone, notes: f.notes };
  const form = h('form', { class: 'stack', novalidate: true, onInput: () => { teamUi.draft = snapshot(); dirty.textContent = 'Unsaved changes'; }, onChange: () => { teamUi.draft = snapshot(); dirty.textContent = 'Unsaved changes'; }, onSubmit: (e) => { e.preventDefault(); cErr.textContent = ''; busy(e.submitter, async () => {
    try {
      const fee = dollarsToCents(f.fee.value);
      if (!(fee > 0)) throw Object.assign(new Error('Enter the monthly fee.'), { details: { field: 'monthly_cents' } });
      await patch(`/v1/organizations/${c.org.id}`, { kind: f.kind.value, contact_name: f.contact.value || null, contact_email: f.email.value || null, contact_phone: f.phone.value || null, billing_address: f.addr.value || null });
      const r = await patch(`/v1/team-contracts/${id}`, { name: f.name.value, monthly_cents: fee, end_date: f.end.value || null, terms_days: Number(f.terms.value), po_number: f.po.value || null, notes: f.notes.value || null });
      teamUi.draft = null;
      const bits = [r.restarted ? `Contract restarted. The next invoice goes out ${ymd(r.next_invoice_on)}.` : 'Contract saved.',
        r.sessions_removed ? `${nplural(r.sessions_removed, 'team session')} after the end date came off the schedule.` : null, r.sessions_added ? `${nplural(r.sessions_added, 'team session')} added up to the new end date.` : null];
      toast(bits.filter(Boolean).join(' ')); render();
    } catch (x) { fieldErr(cFields, x, cErr); }
  }); } },
    h('div', { class: 'form-grid' }, field('Team', f.name), field('Type', f.kind)),
    h('div', { class: 'form-grid' }, field('Monthly fee ($)', f.fee), field('End date', f.end), field('Terms', f.terms), field('PO number', f.po)),
    h('p', { class: 'small muted', style: 'margin:0' }, `A new fee applies from the next invoice. Team sessions follow the end date.${ended ? ' To restart, clear the end date or move it to today or later and save. Billing picks up on the next billing day; months it was ended aren\'t billed.' : ''}`),
    h('div', { class: 'dp-label' }, `Billing contact at ${c.org.name}`),
    h('div', { class: 'form-grid' }, field('Name', f.contact), field('Email', f.email, 'Invoices, statements and reminders go here.'),
      h('div', { class: 'stack-tight' }, field('Phone', f.phone), c.org.contact_phone ? h('a', { class: 'small', href: `tel:${c.org.contact_phone.replace(/[^\d+]/g, '')}` }, `Call ${c.org.contact_phone}`) : null)),
    field('Billing address', f.addr), field('Notes (staff only)', f.notes), cErr,
    h('div', { class: 'row wrap' }, btn('Save contract', null, 'primary', { type: 'submit' }), dirty, h('span', { class: 'grow' }),
      ended ? null : btn('End contract', (e) => {
        if (confirm(`End ${c.org.name} ${c.name}? No more invoices go out and future team sessions come off the schedule. Unpaid invoices stay open and the roster is kept.`)) busy(e.currentTarget, async () => {
          const r = await patch(`/v1/team-contracts/${id}`, { status: 'ended' }); teamUi.draft = null;
          toast(`Contract ended.${r.sessions_removed ? ` ${nplural(r.sessions_removed, 'future team session')} came off the schedule.` : ''}`); render();
        });
      }, 'ghost')));
  const contractPanel = h('div', { id: 'tm-contract' }, panel('Contract', { subtitle: ended ? `Ended ${ymd(c.end_date)}` : `${money(c.monthly_cents)}/month since ${ymd(c.start_date)}, billed on the ${ordinal(Number(c.start_date.slice(8, 10)))}${c.next_invoice_on ? ` · next invoice ${ymd(c.next_invoice_on)}` : ''}` }, form));

  // Team sessions
  const activeSeries = c.series.filter((x) => x.active);
  const sd = { loc: select(locs.data.map((l) => [l.id, l.name])), time: input({ type: 'time', value: '15:30' }), dur: input({ type: 'number', value: '90', min: '10', max: '600', inputmode: 'numeric' }),
    start: input({ type: 'date', value: bizDate() > c.start_date ? bizDate() : c.start_date, max: c.end_date ?? undefined }), coach: coachPicker(coachList.data, null) };
  const days = DAY_NAMES.map((d, i) => h('label', { class: 'row small', style: 'gap:6px;min-height:44px' }, h('input', { type: 'checkbox', value: String(i) }), d));
  const schedPanel = h('div', { id: 'tm-sessions' }, panel('Team sessions', { subtitle: activeSeries.length ? activeSeries.map((x) => `${x.weekdays.map((d) => DAY_NAMES[d]).join(', ')} at ${hm12(x.start_time)}`).join('; ') : 'Not on the schedule yet.', action: h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule' }, 'Schedule') },
    activeSeries.map((x) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' }, h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('span', null, `${x.weekdays.map((d) => DAY_NAMES[d]).join(', ')} at ${hm12(x.start_time)} · ${x.duration_min} min`),
      h('span', { class: 'small muted' }, [x.location_name, x.coach_name ?? 'no coach set', x.next_starts_at ? `next ${tzFmt(x.next_starts_at, { weekday: 'short', month: 'short', day: 'numeric' })}` : 'no more sessions scheduled', x.end_date ? `until ${ymd(x.end_date)}` : null].filter(Boolean).join(' · '))),
      btn('Remove', (e) => { if (confirm('Take these team sessions off the schedule? Future sessions are canceled. Past attendance is kept.')) busy(e.currentTarget, async () => { const r = await del(`/v1/team-contracts/${id}/sessions/${x.id}`); toast(`${nplural(r.sessions_removed, 'future session')} came off the schedule.`); render(); }); }, 'ghost', { 'aria-label': `Remove ${x.weekdays.map((d) => DAY_NAMES[d]).join(', ')} at ${hm12(x.start_time)}` }))),
    ended ? h('p', { class: 'muted small' }, 'This contract has ended. Restart it to schedule team sessions.') : !locs.data.length ? h('p', { class: 'muted small' }, 'Add a location first (Point of sale, Locations).') : h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const weekdays = days.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
      if (!weekdays.length) throw new Error('Choose at least one day.');
      const x = await post(`/v1/team-contracts/${id}/sessions`, { location_id: sd.loc.value, weekdays, start_time: sd.time.value, duration_min: Number(sd.dur.value), start_date: sd.start.value, coach_id: sd.coach.value || null });
      toast(`${nplural(x.upcoming_sessions, 'team session')} added to your schedule${c.end_date ? `, until ${ymd(c.end_date)}` : ' for the next 8 weeks (more are added as time goes on)'}.`); render();
    }); } },
      h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'dp-label' }, 'Days'), h('div', { class: 'row wrap', style: 'gap:4px 14px' }, days)),
      h('div', { class: 'form-grid cols-3' }, field('Where', sd.loc), field('Starts', sd.time), field('Minutes', sd.dur)),
      h('div', { class: 'form-grid' }, field('First day', sd.start), field('Coach', sd.coach)),
      h('div', null, btn('Add team sessions', null, 'secondary', { type: 'submit' })))));

  // Roster
  const last = c.recent_sessions[0];
  const listBox = h('div', { 'aria-live': 'polite' });
  const drawRoster = () => {
    const q = teamUi.q.trim().toLowerCase();
    let rows = c.roster.filter((a) => !q || `${a.name} ${a.athlete_id ?? ''} ${a.position ?? ''}`.toLowerCase().includes(q));
    if (teamUi.sort === 'attendance') rows = [...rows].sort((x, y) => (x.attendance_rate ?? 2) - (y.attendance_rate ?? 2));
    if (teamUi.sort === 'grad') rows = [...rows].sort((x, y) => (x.grad_year ?? 9999) - (y.grad_year ?? 9999) || x.name.localeCompare(y.name));
    fill(listBox, !c.roster.length ? h('p', { class: 'muted' }, 'No athletes yet. Paste the team list below, or add a client you already have.')
      : !rows.length ? h('p', { class: 'muted' }, `Nobody on the roster matches "${teamUi.q.trim()}".`)
        : rows.map((a) => {
          const low = a.attendance_rate != null && a.attendance_rate < 0.6;
          return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
            h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, a.client_id ? h('a', { class: 'strong', href: `#/clients/${a.client_id}`, style: 'color:inherit' }, a.name) : h('span', { class: 'strong' }, a.name),
              h('span', { class: 'small muted' }, [a.athlete_id, a.position, a.grad_year ? `Class of ${a.grad_year}` : null].filter(Boolean).join(' · '), ' · ',
                h('span', { class: low ? 'warn-text' : '' }, a.sessions_held ? `attendance ${pctText(a.attendance_rate)} (${a.sessions_attended} of ${a.sessions_held})` : 'no sessions yet'),
                a.last_seen ? ` · last here ${tzFmt(a.last_seen, { month: 'short', day: 'numeric' })}` : '')),
            btn('Remove', (e) => { if (confirm(`Take ${a.name} off this roster? Their profile and results are kept.`)) busy(e.currentTarget, async () => {
              await del(`/v1/team-contracts/${id}/roster/${a.id}`); render();
              undoToast(`${a.name} removed from the roster.`, () => busy(null, async () => { await post(`/v1/team-contracts/${id}/roster/${a.id}/restore`); toast(`${a.name} is back on the roster.`); render(); }));
            }); }, 'ghost', { 'aria-label': `Remove ${a.name} from the roster` }));
        }));
  };
  drawRoster();
  const find = c.roster.length > 5 ? input({ type: 'search', placeholder: 'Find a player', 'aria-label': 'Find on the roster', value: teamUi.q, autocomplete: 'off' }) : null;
  find?.addEventListener('input', () => { teamUi.q = find.value; drawRoster(); });
  const sort = c.roster.length > 5 ? select([['name', 'Name, A to Z'], ['attendance', 'Lowest attendance first'], ['grad', 'Grad year']], { value: teamUi.sort, 'aria-label': 'Sort roster' }) : null;
  sort?.addEventListener('change', () => { teamUi.sort = sort.value; drawRoster(); });
  const bars = c.recent_sessions.length > 1 && c.roster.length ? h('div', { class: 'tm-bars', role: 'img', 'aria-label': `Check-ins at the last ${c.recent_sessions.length} team sessions, oldest first: ${c.recent_sessions.slice().reverse().map((s) => `${s.here} of ${Math.max(s.here, s.roster)}`).join(', ')}` },
    c.recent_sessions.slice().reverse().map((s) => { const r = s.here / Math.max(1, s.here, s.roster); return h('span', { class: r < 0.6 ? 'low' : '', style: `height:${Math.max(2, Math.round(28 * r))}px`, title: `${tzFmt(s.starts_at, { month: 'short', day: 'numeric' })}: ${s.here} of ${Math.max(s.here, s.roster)} here` }); })) : null;
  const names = textarea('', { rows: '4', placeholder: 'One athlete per line: Name, position, grad year\nJalen Brooks, QB, 2027\nMarcus Hill, WR, 2028', 'aria-label': 'Team list' });
  const paste = h('details', { open: !c.roster.length || teamUi.pasteOpen, onToggle: (e) => { teamUi.pasteOpen = e.currentTarget.open; } },
    h('summary', { class: 'small', style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Paste a team list'),
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, () => pasteRoster(c, names)); } },
      names, h('div', null, btn('Check the list', null, 'secondary', { type: 'submit' })),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Nothing is saved until the whole list checks out. Each new player gets a client profile and an Athlete ID (a team-only client: no membership). An Athlete ID on a line puts that client on the team. Names already on the roster are skipped, and names that match a client you already have can be linked instead. Rows copied from a spreadsheet work too.')));
  const rosterPanel = h('div', { id: 'tm-roster' }, panel(`Roster · ${c.roster.length}`, { subtitle: [c.team_rate != null ? `Team attendance ${pctText(c.team_rate)}` : 'Check athletes in from each team session. Attendance counts from the day each athlete joins.', last ? `last session ${tzFmt(last.starts_at, { weekday: 'short', month: 'short', day: 'numeric' })}: ${last.here} of ${Math.max(last.here, last.roster)} here` : null].filter(Boolean).join(' · '), action: bars },
    h('div', { class: 'row wrap', style: 'gap:8px' }, find ? h('div', { class: 'grow', style: 'min-width:160px' }, find) : null, sort ? h('div', { style: 'min-width:180px' }, sort) : null,
      btn('Add existing client', () => addExistingDialog(c), 'secondary'),
      c.roster.length ? btn('Export CSV', () => {
        downloadCsv(`${`${c.org.name} ${c.name}`.replace(/[^\w]+/g, '-').toLowerCase()}-roster-${bizDate()}.csv`, [['Name', 'Athlete ID', 'Position', 'Grad year', 'Attendance', 'Sessions attended', 'Team sessions', 'Last here'],
          ...c.roster.map((a) => [a.name, a.athlete_id ?? '', a.position ?? '', a.grad_year ?? '', a.attendance_rate == null ? '' : pctText(a.attendance_rate), a.sessions_attended, a.sessions_held, a.last_seen ? tzFmt(a.last_seen, { year: 'numeric', month: '2-digit', day: '2-digit' }) : ''])]);
        toast(`Exported ${nplural(c.roster.length, 'athlete')}.`);
      }, 'ghost') : null),
    listBox, paste));

  const jumps = [['tm-inv', 'Invoices'], ['tm-roster', 'Roster'], ['tm-sessions', 'Team sessions'], ['tm-contract', 'Contract'], ['tm-eng', 'Goals & messages']];
  fill(main,
    header(c.org.name, `${c.name} · ${money(c.monthly_cents)}/month${c.org.kind === 'club' ? ' · club' : ''}${ended ? ` · ended ${ymd(c.end_date)}` : ''}`, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/teams' }, 'All teams')),
    h('nav', { class: 'tm-jump', 'aria-label': 'Sections' }, jumps.map(([t, label]) => h('button', { type: 'button', onClick: () => document.getElementById(t)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, label))),
    c.org.contact_email ? null : h('div', { class: 'test-banner', role: 'note' }, `Add a billing email for ${c.org.name} so invoices, statements and reminders can be emailed.`),
    ended ? h('div', { class: 'test-banner', role: 'note' }, `This contract ended ${ymd(c.end_date)}. No invoices go out. To restart it, clear the end date or move it later and save.`) : null,
    invoicesPanel,
    h('div', { class: 'grid grid-2' }, h('div', { class: 'stack', style: 'gap:24px;min-width:0' }, rosterPanel, h('div', { id: 'tm-eng' }, engPanel)), h('div', { class: 'stack', style: 'gap:24px;min-width:0' }, schedPanel, contractPanel)));
}

// Paste: check the whole list first. Problem lines are listed and nothing is saved; names that match a client you
// already have need a choice (link them, or add a new athlete) before anything is added.
async function pasteRoster(c, names) {
  const text = names.value;
  if (!text.trim()) { names.focus(); throw new Error('Paste at least one name, one per line.'); }
  const plan = await post(`/v1/team-contracts/${c.id}/roster/check`, { names: text });
  const save = async (links = {}) => {
    const r = await post(`/v1/team-contracts/${c.id}/roster`, { names: text, links });
    const bits = [r.added ? `${nplural(r.added, 'new athlete')} added` : null, r.linked ? `${r.linked} existing ${r.linked === 1 ? 'client' : 'clients'} linked` : null, r.skipped ? `${r.skipped} already on the roster` : null].filter(Boolean);
    teamUi.pasteOpen = false;
    toast(bits.length ? `${bits.join(', ')}.` : 'Nothing new to add.'); render();
  };
  const errors = plan.rows.filter((r) => r.status === 'error'), matches = plan.rows.filter((r) => r.status === 'match');
  if (errors.length) {
    teamDialog(`Fix ${nplural(errors.length, 'line')} first`, h('div', { class: 'stack' }, h('p', { style: 'margin:0' }, 'Nothing was added. Each line needs a first and last name; the position and grad year are optional.'),
      h('ul', { style: 'margin:0;padding-left:18px' }, errors.map((r) => h('li', null, r.error)))), [{ label: 'Edit the list', variant: 'primary', onClick: () => { setTimeout(() => names.focus(), 0); } }]);
    return;
  }
  if (!matches.length) return save();
  const picks = matches.map((m) => select([['', 'Choose…'], ...m.matches.map((x) => [x.id, `Link to ${x.name} (${[x.athlete_id, x.birth_date ? `born ${ymd(x.birth_date)}` : null, x.teams ? `on ${x.teams}` : null].filter(Boolean).join(', ')})`]), ['new', 'Add as a new athlete']], { value: '', 'aria-label': `What to do with ${m.name}` }));
  teamDialog('Link clients you already have?', h('div', { class: 'stack' },
    h('p', { style: 'margin:0' }, `${matches.length === 1 ? 'One name matches' : `${matches.length} names match`} a client you already have. Link to put that client on this team (their app gets team goals and messages), or add a new athlete if it's someone else with the same name.`),
    matches.map((m, n) => h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, `Line ${m.line}: ${m.name}`, m.position ? h('span', { class: 'muted small' }, ` · ${m.position}`) : null, m.grad_year ? h('span', { class: 'muted small' }, ` · ${m.grad_year}`) : null), picks[n])),
    h('p', { class: 'small muted', style: 'margin:0' }, `${nplural(plan.counts.new, 'other new name')}${plan.counts.skip ? `, ${plan.counts.skip} already on the roster` : ''}.`)),
  [{ label: 'Add to roster', variant: 'primary', onClick: async () => {
    const undecided = matches.filter((m, n) => !picks[n].value);
    if (undecided.length) throw new Error(`Choose what to do with ${undecided.map((m) => m.name).join(', ')}.`);
    await save(Object.fromEntries(matches.map((m, n) => [m.line, picks[n].value]).filter(([, val]) => val && val !== 'new')));
  } }, { label: 'Cancel', variant: 'ghost' }]);
}

// Search every client and put one on this roster. Someone on another team is asked about first.
function addExistingDialog(c) {
  const q = input({ type: 'search', autocomplete: 'off', placeholder: 'Like Ava Lopez or AVALOP2026' });
  const out = h('div', { 'aria-live': 'polite' }, h('p', { class: 'small muted', style: 'margin:0' }, 'Type at least two letters.'));
  let timer;
  const add = async (b, x, extra = {}) => {
    b.disabled = true;
    try {
      const r = await post(`/v1/team-contracts/${c.id}/roster/existing`, { client_id: x.id, ...extra });
      document.getElementById('dialog').close();
      toast(`${x.name} added to the roster${r.moved_from.length ? ` and taken off ${r.moved_from.join(', ')}` : ''}.`); render();
    } catch (e) {
      b.disabled = false;
      if (e.code !== 'confirm_required') return toast(e.message, 'warn');
      fill(out, h('div', { class: 'stack' }, h('p', { style: 'margin:0' }, e.message), h('div', { class: 'row wrap' },
        btn('Move them here', (ev) => add(ev.currentTarget, x, { move: true }), 'secondary'), btn('Keep them on both', (ev) => add(ev.currentTarget, x, { keep: true }), 'secondary'), btn('Back', () => search(), 'ghost'))));
    }
  };
  const search = async () => {
    const val = q.value.trim();
    if (val.length < 2) return fill(out, h('p', { class: 'small muted', style: 'margin:0' }, 'Type at least two letters.'));
    let rows;
    try { rows = (await get(`/v1/team-contracts/${c.id}/client-search?q=${encodeURIComponent(val)}`)).data; } catch (e) { return fill(out, h('p', { class: 'dp-error' }, e.message)); }
    fill(out, rows.length ? rows.map((x) => h('div', { class: 'list-item', style: 'min-height:52px' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, [x.athlete_id, x.teams ? `on ${x.teams}` : null].filter(Boolean).join(' · '))),
      x.on_roster ? h('span', { class: 'small muted' }, 'On this roster') : btn(x.teams ? 'Add or move' : 'Add', (e) => add(e.currentTarget, x), 'secondary', { 'aria-label': `Add ${x.name}` })))
      : h('p', { class: 'small muted', style: 'margin:0' }, 'No clients match. Paste their name into the team list instead to add them as a new athlete.'));
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
  teamDialog('Add an existing client', h('div', { class: 'stack' }, field('Name or Athlete ID', q), out), [{ label: 'Done', variant: 'ghost' }]);
  q.focus();
}

// ---------- Athlete ID ----------
const idChip = (id) => (id ? h('button', { type: 'button', class: 'dp-badge dp-badge--neutral', style: 'font-family:var(--font-mono);cursor:pointer;border:0', title: 'Copy athlete ID',
  onClick: async (e) => { e.stopPropagation(); await navigator.clipboard?.writeText(id).catch(() => {}); toast(`${id} copied.`); } }, id) : null);

// ---------- Testing ----------
const UNIT_LABEL = { s: 's', ms: 'ms', in: 'in', ft: 'ft', cm: 'cm', m: 'm', lb: 'lb', kg: 'kg', mph: 'mph', 'km/h': 'km/h', 'm/s': 'm/s', 'ft/s': 'ft/s', N: 'N', W: 'W', 'W/kg': 'W/kg', 'N/kg': 'N/kg', 'N/s': 'N/s', '%': '%', reps: 'reps', ratio: '', level: '', rpm: 'rpm', deg: '°', points: 'pts', shuttles: 'shuttles', 'ml/kg/min': 'ml/kg/min' };
// Broad jumps read as feet and inches; everything else as number + unit.
function fmtResult(v, unit, decimals = 2, { delta = false } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'in' && Math.abs(v) >= 48 && !delta) { const ft = Math.floor(v / 12), inch = v - ft * 12; return `${ft}′ ${inch.toFixed(inch % 1 ? 1 : 0)}″`; }
  const n = Number(v).toFixed(decimals ?? 2);
  return `${n}${UNIT_LABEL[unit] === '' ? '' : ` ${UNIT_LABEL[unit] ?? unit}`}`;
}
// Values as typed on a testing day: 4.71, "4,71", 8'5" for feet and inches, 1:32 for minutes and seconds.
function parseTyped(raw, unit) {
  const t = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const fi = t.match(/^(\d+)\s*(?:'|′|ft)\s*(\d+(?:\.\d+)?)?\s*(?:"|″|in)?$/);
  if (fi && unit === 'in') return Number(fi[1]) * 12 + Number(fi[2] ?? 0);
  const ms = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (ms && unit === 's') return Number(ms[1]) * 60 + Number(ms[2]);
  const n = /^-?\d+,\d+$/.test(t) ? Number(t.replace(',', '.')) : Number(t);
  return Number.isFinite(n) ? n : NaN;
}
// A metric's possible range is [lowest, highest] (the coach's own from the Test library, or the built-in one); a built-in
// range can be one-sided (null for the open end), like the server's.
const outOfRange = (v, r) => !!r && ((r[0] != null && v < r[0]) || (r[1] != null && v > r[1]));
const rangeWords = (r, unit) => { const u = UNIT_LABEL[unit] ? ` ${UNIT_LABEL[unit]}` : ''; return r[0] != null && r[1] != null ? `${r[0]}–${r[1]}${u}` : r[0] != null ? `at least ${r[0]}${u}` : `at most ${r[1]}${u}`; };
const typedHint = (metric) => (metric.unit === 'in' && (metric.range?.[1] ?? 0) >= 60 ? 'Feet and inches work: 8\'5"' : metric.unit === 's' && (metric.range?.[1] ?? 0) >= 90 ? 'Minutes work: 1:32' : null);
const better = (metric, a, b) => (metric.better === 'lower' ? a < b : a > b);
const shortTest = (t) => t.name.replace(/ \(.*\)$/, '');
// Answers a 409 confirmation_required by asking, then sends the same request again with the confirmation.
async function withConfirm(send, ask) {
  try { return await send(false); }
  catch (e) { if (e.code !== 'confirmation_required') throw e; if (!confirm(ask(e))) return null; return send(true); }
}

// Front desk enters results and adds walk-ups; planning days, uploads, devices and linking are for owners and coaches.
const deskStop = (main, title) => (state.user?.role === 'front_desk' ? (fill(main, header(title, null, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing')), h('div', { class: 'empty' }, 'Owners and coaches do this. You can enter results and add walk-ups on a testing day.')), true) : false);
let testingFilter = { status: 'all', q: '' };
async function viewTesting(main) {
  const desk = state.user?.role === 'front_desk';          // front desk can't open devices, uploads or the results queue
  const [days, integrations] = await Promise.all([get('/v1/testing-sessions'), desk ? { data: [] } : get('/v1/integrations')]);
  const connected = integrations.data.filter((i) => i.connected);
  const list = h('div', { class: 'stack-tight' });
  const toggles = [['all', 'All'], ['open', 'Open'], ['shared', 'Shared']].map(([k, label]) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(testingFilter.status === k), onClick: () => { testingFilter.status = k; toggles.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === k))); draw(); }, 'data-k': k }, label));
  const find = input({ type: 'search', placeholder: 'Find a day by name or team', value: testingFilter.q, 'aria-label': 'Find a testing day', style: 'max-width:320px' });
  find.addEventListener('input', () => { testingFilter.q = find.value; draw(); });
  function draw() {
    const q = testingFilter.q.trim().toLowerCase();
    const shown = days.data.filter((d) => (testingFilter.status === 'all' || d.status === testingFilter.status) && (!q || `${d.name} ${d.team_name ?? ''}`.toLowerCase().includes(q)));
    fill(list, shown.length ? shown.map((d) => {
      const pct = d.progress.planned ? Math.round((d.progress.done / d.progress.planned) * 100) : 0;
      return h('a', { class: 'list-item', href: `#/testing/${d.id}`, style: 'text-decoration:none;color:inherit;flex-wrap:wrap' },
        h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('span', { class: 'strong' }, d.name),
          h('span', { class: 'small muted' }, [ymd(d.date), d.team_name, `${d.athletes_count} ${d.athletes_count === 1 ? 'athlete' : 'athletes'}`, `${d.tests.length} ${d.tests.length === 1 ? 'test' : 'tests'}`].filter(Boolean).join(' · '))),
        d.status === 'shared' ? h('span', { class: 'dp-badge dp-badge--good' }, 'Shared')
          : h('span', { class: `dp-badge dp-badge--${d.progress.done ? 'neutral' : 'muted'}`, title: 'Athlete-and-test pairs with a result' }, d.progress.planned ? `${d.progress.done}/${d.progress.planned} done (${pct}%)` : 'No tests'));
    }) : h('div', { class: 'empty' }, days.data.length ? 'No testing days match. Clear the search or pick All.' : desk ? 'No testing days yet. An owner or coach starts one.' : 'No testing days yet. Start one, or upload results from a device.'));
  }
  draw();
  fill(main,
    days.waiting ? h('div', { class: 'test-banner row wrap', style: 'gap:12px' }, h('span', { class: 'grow' }, `${days.waiting} ${days.waiting === 1 ? 'result is' : 'results are'} waiting to be linked to a profile.${desk ? ' An owner or coach links them.' : ''}`), desk ? null : h('a', { class: 'dp-btn dp-btn--outline', href: '#/testing/queue' }, 'Link them')) : null,
    header('Testing', 'Combines, evaluations and team testing. Enter results by hand or stopwatch, upload sheets, or connect your devices.', h('div', { class: 'row wrap' },
      h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing/library' }, 'Test library'),
      desk ? null : h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing/connections' }, 'Devices'),
      desk ? null : h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing/upload' }, 'Upload results'),
      desk ? null : h('a', { class: 'dp-btn dp-btn--primary', href: '#/testing/new' }, 'New testing day'))),
    connected.length ? h('p', { class: 'small muted' }, `Connected: ${connected.map((i) => i.name.split(' (')[0]).join(', ')}.`) : null,
    panel('Testing days', { action: h('div', { class: 'row wrap tm-views' }, toggles) }, h('div', null, find), list));
}

async function viewNewTesting(main) {
  if (deskStop(main, 'New testing day')) return;
  const qs = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const [lib, clientsList, teamList, days, presetList] = await Promise.all([get('/v1/tests'), get('/v1/clients'), get('/v1/teams'), get('/v1/testing-sessions'), get('/v1/test-presets')]);
  const name = input({ value: 'Testing day', 'aria-label': 'Name' }), date = input({ type: 'date', value: bizDate() });
  let nameTouched = false;
  name.addEventListener('input', () => { nameTouched = true; });
  const setName = (text) => { if (!nameTouched) name.value = text; };
  const teams = teamList.data;                              // active teams, names only (coaches can't see contracts)
  const team = select([['', 'Individual athletes'], ...teams.map((c) => [c.id, `${c.org_name} ${c.name} (${c.roster_count})`])], { value: '' });
  const retest = select([['', 'No, pick athletes and tests'], ...days.data.map((d) => [d.id, `${d.name} (${ymd(d.date)}, ${d.athletes_count} athletes, ${d.tests.length} tests)`])], { value: qs.get('retest') ?? '' });

  // Athletes: find, tick all shown, clear.
  const picked = new Set();
  const athletes = clientsList.data.map((c) => ({ ...c, cb: h('input', { type: 'checkbox', 'aria-label': c.name, onChange: (e) => { e.target.checked ? picked.add(c.id) : picked.delete(c.id); countA(); } }) }));
  const athleteRows = athletes.map((a) => { const row = h('label', { class: 'row small ts-pick' }, a.cb, h('span', null, a.name), h('span', { class: 'muted', style: 'font-family:var(--font-mono);font-size:12px' }, a.athlete_id)); a.row = row; return row; });
  const findA = input({ type: 'search', placeholder: 'Find an athlete by name or ID', 'aria-label': 'Find an athlete' });
  const aCount = h('span', { class: 'small muted' });
  const countA = () => { aCount.textContent = `${picked.size} picked`; };
  const shownA = () => athletes.filter((a) => a.row.style.display !== 'none');
  findA.addEventListener('input', () => { const q = findA.value.trim().toLowerCase(); athletes.forEach((a) => { a.row.style.display = !q || `${a.name} ${a.athlete_id}`.toLowerCase().includes(q) ? '' : 'none'; }); });
  const athleteBox = h('div', { class: 'stack' }, h('div', { class: 'dp-label' }, 'Athletes (walk-ups can be added on the day)'),
    h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: 'min-width:220px' }, findA),
      btn('Tick all shown', () => { shownA().forEach((a) => { a.cb.checked = true; picked.add(a.id); }); countA(); }, 'secondary'),
      btn('Clear', () => { athletes.forEach((a) => { a.cb.checked = false; }); picked.clear(); countA(); }, 'ghost'), aCount),
    h('div', { class: 'ts-picklist' }, athleteRows.length ? athleteRows : h('p', { class: 'muted small' }, 'No clients yet. Add clients first, or pick a team.')));
  countA();

  // Tests: find, presets, and the running order with remove buttons.
  const order = [];
  const testBoxes = new Map();
  const orderList = h('ol', { class: 'ts-order' });
  const drawOrder = () => fill(orderList, order.length ? order.map((k, i) => { const t = lib.data.find((x) => x.key === k);
    return h('li', { class: 'row', style: 'gap:8px' }, h('span', { class: 'muted small', style: 'min-width:20px' }, `${i + 1}.`), h('span', { class: 'grow' }, t.name), btn('×', () => toggleTest(k, false), 'ghost', { 'aria-label': `Remove ${t.name}`, class: 'dp-btn dp-btn--ghost ts-x' })); })
    : h('li', { class: 'muted small', style: 'list-style:none' }, 'No tests yet. Tick tests below or start from a preset.'));
  const toggleTest = (k, on) => { const cb = testBoxes.get(k); if (cb) cb.checked = on; const i = order.indexOf(k); if (on && i < 0) order.push(k); if (!on && i >= 0) order.splice(i, 1); drawOrder(); };
  const byCat = lib.categories.map((cat) => [cat, lib.data.filter((t) => t.category === cat.key)]).filter(([, ts]) => ts.length);
  const catBlocks = byCat.map(([cat, ts]) => {
    const labels = ts.map((t) => { const cb = h('input', { type: 'checkbox', value: t.key, onChange: (e) => toggleTest(t.key, e.target.checked) }); testBoxes.set(t.key, cb); const l = h('label', { class: 'row small ts-pick' }, cb, t.name); l.dataset.search = `${t.name} ${t.key} ${(t.aliases ?? []).join(' ')}`.toLowerCase(); return l; });
    const d = h('details', null, h('summary', { class: 'strong ts-summary' }, cat.name), h('div', { class: 'row wrap', style: 'gap:0 16px;margin:4px 0 8px' }, labels));
    return { d, labels };
  });
  const findT = input({ type: 'search', placeholder: 'Find a test', 'aria-label': 'Find a test' });
  findT.addEventListener('input', () => { const q = findT.value.trim().toLowerCase(); catBlocks.forEach(({ d, labels }) => { let any = false; labels.forEach((l) => { const hit = !q || l.dataset.search.includes(q); l.style.display = hit ? '' : 'none'; any ||= hit; }); d.style.display = any ? '' : 'none'; d.open = !!q && any; }); });
  // Presets are kept in the Test library; a preset adds its tests in its own order.
  const usePreset = (p) => { p.tests.forEach((t) => { if (testBoxes.has(t.key)) toggleTest(t.key, true); }); setName(team.value ? name.value : p.name); };
  const usable = presetList.data.filter((p) => p.tests.length);
  const presets = usable.length ? h('div', { class: 'row wrap' }, usable.map((p) => btn(p.name, () => usePreset(p), 'secondary', { title: p.tests.map((t) => t.name).join(', ') })))
    : h('p', { class: 'small muted', style: 'margin:0' }, 'No presets yet. ', h('a', { href: '#/testing/library?tab=presets' }, 'Make one in the Test library'), ' to start faster next time.');
  const testsBox = h('div', { class: 'stack' }, h('div', { class: 'dp-label' }, 'Tests, in running order'), orderList,
    h('div', { class: 'small muted' }, 'Start from a preset, then adjust.'), presets, h('div', { style: 'max-width:320px' }, findT), catBlocks.map((c) => c.d));
  drawOrder();

  const retestNote = h('p', { class: 'small muted' });
  const sync = () => {
    const past = days.data.find((d) => d.id === retest.value);
    athleteBox.style.display = past || team.value ? 'none' : '';
    testsBox.style.display = past ? 'none' : '';
    team.disabled = !!past;
    retestNote.textContent = past ? `Same ${past.athletes_count} athletes and ${past.tests.length} tests as ${past.name}. Archived athletes are left out.` : '';
    if (past) setName(`${past.name} retest`);
    else if (team.value) { const c = teams.find((x) => x.id === team.value); setName(`${c.org_name} ${c.name} testing`); }
  };
  team.addEventListener('change', sync); retest.addEventListener('change', sync);
  sync();
  fill(main, header('New testing day', 'Pick the athletes and tests. Results can be entered by hand, by stopwatch, or uploaded from a sheet or device.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Cancel')),
    h('form', { class: 'dp-panel stack', style: 'max-width:900px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      if (!date.value) throw new Error('Pick the date.');
      let d;
      if (retest.value) d = await post('/v1/testing-sessions', { retest_of: retest.value, name: name.value, date: date.value });
      else {
        if (!order.length) throw new Error('Choose at least one test.');
        if (!team.value && !picked.size) throw new Error('Pick at least one athlete, or a team. Walk-ups can be added on the day.');
        d = await post('/v1/testing-sessions', { name: name.value, date: date.value, tests: order, contract_id: team.value || undefined, athletes: team.value ? undefined : [...picked].map((client_id) => ({ client_id })) });
      }
      toast(`${d.name} is ready: ${d.athletes.length} ${d.athletes.length === 1 ? 'athlete' : 'athletes'}${d.left_out ? `, ${d.left_out} archived ${d.left_out === 1 ? 'athlete' : 'athletes'} left out` : ''}.`);
      location.hash = `#/testing/${d.id}`;
    }); } },
      h('div', { class: 'form-grid cols-3' }, field('Name', name), field('Date', date), field('Team', team)),
      field('Retest a past day?', retest), retestNote,
      athleteBox, testsBox,
      h('div', null, btn('Start testing day', null, 'primary', { type: 'submit' }))));
  const start = usable.find((p) => p.id === qs.get('preset'));
  if (start) usePreset(start);        // "Plan a day" from a preset in the Test library
}

// Entry screen: one test at a time, every athlete's attempts, a stopwatch for hand timing, and live rankings.
let testingState = { dayId: null, testKey: null, athleteIdx: 0, view: 'entry', find: '', extra: {}, focus: null };
let stopwatchRunning = false;
// Stopwatch memory across redraws: a time that couldn't be saved (pending) and the last saved time (for Undo).
let swState = { pending: null, last: null };
let swEscape = null;
async function viewTestingDay(main, id) {
  const manage = state.user?.role !== 'front_desk';
  const [day, clientsList, notes, lib] = await Promise.all([get(`/v1/testing-sessions/${id}`), get('/v1/clients'), get(`/v1/testing-sessions/${id}/notes`).catch(() => null), manage ? get('/v1/tests') : { data: [] }]);
  if (testingState.dayId !== id) { testingState = { dayId: id, testKey: null, athleteIdx: 0, view: 'entry', find: '', extra: {}, focus: null }; swState = { pending: null, last: null }; }
  stopwatchRunning = false;                                // a fresh screen has no clock running
  // Redraw keeping the scroll position; while the clock runs, stopping it redraws instead (so the run isn't lost).
  const redraw = () => { if (stopwatchRunning) return; const y = window.scrollY; render(); setTimeout(() => window.scrollTo(0, y), 250); };
  const athletes = day.athletes;
  const who = (a) => (a.client_id ? { client_id: a.client_id } : { roster_id: a.roster_id });
  const akey = (a) => a.client_id ?? a.roster_id;

  // Share: preview who it reaches first.
  async function share() {
    const pv = await get(`/v1/testing-sessions/${id}/share-preview`);
    if (!pv.with_results) return toast('Enter some results before sharing this day.', 'warn');
    const note = textarea(day.parent_note ?? '', { rows: '3', 'aria-label': 'Note for families', placeholder: 'Optional. It appears on their report and in the email.' });
    const list = (label, names) => (names.length ? h('p', { class: 'small', style: 'margin:0' }, h('span', { class: 'muted' }, `${label} (${names.length}): `), names.join(', ')) : null);
    teamDialog('Share with parents', h('div', { class: 'stack' },
      h('p', { style: 'margin:0' }, `${pv.with_results} of ${pv.athletes} ${pv.athletes === 1 ? 'athlete' : 'athletes'} ${pv.with_results === 1 ? 'has' : 'have'} results. They appear in the parent portal, and ${pv.families ? `${pv.families} ${pv.families === 1 ? 'family is' : 'families are'} emailed` : 'no family is emailed'}.`),
      list('No results yet, not shared', pv.without_results), list('No parent email, not emailed', pv.no_email),
      field('A note for families', note)),
      [{ label: pv.families ? `Share and email ${pv.families} ${pv.families === 1 ? 'family' : 'families'}` : 'Share without emails', variant: 'primary', onClick: async () => {
        const r = await post(`/v1/testing-sessions/${id}/share`, { parent_note: note.value });
        toast(r.families_notified ? `Shared. ${r.families_notified} ${r.families_notified === 1 ? 'family' : 'families'} emailed.` : 'Shared. No emails were sent.'); redraw(); } },
      { label: 'Cancel', variant: 'ghost' }]);
  }
  // After sharing: late results can be sent to just the families who have something new.
  let banner = null;
  if (manage && day.shared_at && day.new_since_share) {
    const pv = await get(`/v1/testing-sessions/${id}/share-preview`);
    banner = h('div', { class: 'test-banner row wrap', style: 'gap:12px' },
      h('span', { class: 'grow' }, `${pv.new_since_share.length} ${pv.new_since_share.length === 1 ? 'athlete has' : 'athletes have'} results added since families were emailed (${pv.new_since_share.slice(0, 4).join(', ')}${pv.new_since_share.length > 4 ? '…' : ''}).${pv.new_families ? '' : ' None of them has a parent email.'}`),
      pv.new_families ? btn(`Email ${pv.new_families} ${pv.new_families === 1 ? 'family' : 'families'}`, (e) => busy(e.currentTarget, async () => { const r = await post(`/v1/testing-sessions/${id}/share`, { only_new: true }); toast(`${r.families_notified} ${r.families_notified === 1 ? 'family' : 'families'} emailed.`); redraw(); }), 'outline')
        : btn('Save and mark as shared', (e) => busy(e.currentTarget, async () => { await post(`/v1/testing-sessions/${id}/share`, { only_new: true, notify: false }); toast('Marked as shared. No emails were sent.'); redraw(); }), 'outline'));
  }

  // Edit day: rename, re-date, remove tests, retest these athletes, delete.
  function editDay() {
    const nm = input({ value: day.name, 'aria-label': 'Name' }), dt = input({ type: 'date', value: day.date, 'aria-label': 'Date' });
    const testsList = h('div', { class: 'stack-tight' }, day.tests.map((t) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, t.name),
      day.tests.length > 1 ? btn('Remove', async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try {
          const r = await withConfirm((ok) => patch(`/v1/testing-sessions/${id}`, { tests: day.tests.filter((x) => x.key !== t.key).map((x) => x.key), ...(ok ? { confirm: true } : {}) }),
            (err) => `${t.name} has ${err.details.results} ${err.details.results === 1 ? 'result' : 'results'} on this day. Removing the test deletes ${err.details.results === 1 ? 'it' : 'them'} from every profile. Remove it?`);
          if (r) { document.getElementById('dialog').close(); toast(`${t.name} removed${r.deleted_results ? ` with ${r.deleted_results} ${r.deleted_results === 1 ? 'result' : 'results'}` : ''}.`); redraw(); }
        } catch (x) { toast(x.message, 'warn'); } finally { b.disabled = false; }
      }, 'ghost') : null)));
    const canDelete = !day.shared_at || isOwner();
    teamDialog('Edit testing day', h('div', { class: 'stack' },
      h('div', { class: 'form-grid' }, field('Name', nm), field('Date', dt)),
      h('div', { class: 'dp-label' }, 'Tests'), testsList,
      h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--secondary', href: `#/testing/new?retest=${id}`, onClick: () => document.getElementById('dialog').close() }, 'Retest these athletes'),
        canDelete ? btn('Delete this day', async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try {
            const r = await withConfirm((ok) => del(`/v1/testing-sessions/${id}${ok ? '?confirm=true' : ''}`), (err) => `${day.name} has ${err.details.results} ${err.details.results === 1 ? 'result' : 'results'}. Deleting the day deletes ${err.details.results === 1 ? 'it' : 'them'} from every profile. This can't be undone. Delete it?`);
            if (r) { document.getElementById('dialog').close(); toast(`${day.name} deleted.`); location.hash = '#/testing'; }
          } catch (x) { toast(x.message, 'warn'); } finally { b.disabled = false; }
        }, 'ghost', { style: 'color:var(--amber)' }) : h('span', { class: 'small muted' }, 'Families have these results. Only the owner can delete a shared day.'))),
      [{ label: 'Save', variant: 'primary', onClick: async () => { await patch(`/v1/testing-sessions/${id}`, { name: nm.value, date: dt.value }); toast('Saved.'); redraw(); } }, { label: 'Cancel', variant: 'ghost' }]);
  }

  const addTest = manage ? select([['', 'Add a test…'], ...lib.data.filter((t) => !day.tests.some((x) => x.key === t.key)).map((t) => [t.key, t.name])], { 'aria-label': 'Add a test to this day', style: 'max-width:240px' }) : null;
  addTest?.addEventListener('change', () => busy(addTest, async () => { if (!addTest.value) return; await patch(`/v1/testing-sessions/${id}`, { tests: [...day.tests.map((t) => t.key), addTest.value] }); testingState.testKey = addTest.value; toast('Test added.'); redraw(); }));
  const walkUp = select([['', 'Add a walk-up athlete…'], ...clientsList.data.filter((c) => !athletes.some((a) => a.client_id === c.id)).map((c) => [c.id, `${c.name} (${c.athlete_id})`])], { 'aria-label': 'Add a walk-up athlete' });
  walkUp.addEventListener('change', () => busy(walkUp, async () => { if (!walkUp.value) return; await post(`/v1/testing-sessions/${id}/athletes`, { client_id: walkUp.value }); toast('Added.'); redraw(); }));
  const headerActions = h('div', { class: 'row wrap' },
    manage ? (day.shared_at ? btn('Shared with parents ✓', (e) => { if (confirm('Hide these results from families again?')) busy(e.currentTarget, async () => { await del(`/v1/testing-sessions/${id}/share`); toast('Hidden from families.'); redraw(); }); }, 'outline')
      : btn('Share with parents', (e) => busy(e.currentTarget, share), day.tests.some((t) => t.timed) ? 'secondary' : 'primary')) : null,
    manage ? btn('Edit day', editDay, 'secondary') : null,
    btn('Download sheet', (e) => busy(e.currentTarget, () => download(`/v1/uploads/template?session_id=${id}`)), 'secondary'),
    manage ? h('a', { class: 'dp-btn dp-btn--secondary', href: `#/testing/upload?session=${id}` }, 'Upload results') : null,
    h('a', { class: 'dp-btn dp-btn--ghost', href: '#/testing' }, 'All testing days'));
  const subtitle = `${ymd(day.date)} · ${athletes.length} ${athletes.length === 1 ? 'athlete' : 'athletes'} · ${day.shared_at ? 'Shared with families' : 'Not shared yet'}`;
  if (!day.tests.length) return fill(main, header(day.name, subtitle, headerActions), h('div', { class: 'empty' }, 'No tests on this day.', manage ? h('div', { style: 'margin-top:12px;display:flex;justify-content:center' }, addTest) : null));
  if (!day.tests.some((t) => t.key === testingState.testKey)) { testingState.testKey = day.tests[0].key; testingState.athleteIdx = 0; }
  const test = day.tests.find((t) => t.key === testingState.testKey);
  const metric = test.metrics[0];
  const unitSel = select(metric.units.map((u) => [u, UNIT_LABEL[u] || u]), { value: metric.unit, 'aria-label': 'Unit' });
  const sides = test.sides === 'lr' ? ['L', 'R'] : [null];
  const hand = h('input', { type: 'checkbox', checked: !!test.timed });
  const resultsOf = (a, side, t = test, m = metric) => a.results.filter((r) => r.test_id === t.id && r.metric === m.key && (r.side ?? null) === side).sort((x, y) => (x.attempt ?? 99) - (y.attempt ?? 99));
  const bestOf = (rs, m = metric) => (rs.length && m.better !== 'none' ? (m.better === 'lower' ? Math.min(...rs.map((r) => r.value)) : Math.max(...rs.map((r) => r.value))) : rs.length ? rs[rs.length - 1].value : null);
  const prevOf = (a, side, t = test, m = metric) => a.previous_best?.[`${t.key}|${m.key}|${side ?? ''}`] ?? null;
  const doneFor = (t) => athletes.filter((a) => (t.sides === 'lr' ? ['L', 'R'] : [null]).every((sd) => resultsOf(a, sd, t, t.metrics[0]).length)).length;

  async function save(a, side, value, attempt, timing, source) {
    const r = await post('/v1/results', { session_id: id, results: [{ ...who(a), test: test.key, metric: metric.key, value, unit: unitSel.value, side, attempt, timing, source, recorded_at: `${day.date}T${new Date().toISOString().slice(11)}` }] });
    if (r.errors.length) throw new Error(r.errors[0].message);
    if (r.prs.length) toast(`New PR for ${a.name.split(' ')[0]}: ${fmtResult(r.prs[0].value, metric.unit, metric.decimals)}`);
    return r;
  }
  const checkValue = (v) => {
    if (!Number.isFinite(v)) return 'Type a number.';
    if (unitSel.value === metric.unit && outOfRange(v, metric.range)) return `${+v.toFixed(3)} ${UNIT_LABEL[metric.unit] ?? metric.unit} isn't possible for ${shortTest(test)} (${rangeWords(metric.range, metric.unit)}).`;
    return null;
  };

  // Rows: one per athlete (and side). Typed entry: Enter or the arrow keys move down the column.
  const q = testingState.find.trim().toLowerCase();
  const visible = athletes.map((a, idx) => ({ a, idx })).filter(({ a }) => !q || `${a.name} ${a.athlete_id ?? ''}`.toLowerCase().includes(q));
  const hint = typedHint(metric);
  const focusCell = (athleteIdx, side, attempt) => main.querySelector(`input[data-cell="${athleteIdx}|${side ?? ''}|${attempt}"]`)?.focus();
  const move = (pos, dir, attempt) => { const i = pos + dir; const next = rowsOrder[i]; if (next) focusCell(next.idx, next.side, attempt); };
  const rowsOrder = visible.flatMap(({ idx }) => sides.map((side) => ({ idx, side })));
  const rows = visible.map(({ a, idx }) => sides.map((side) => {
    const rs = resultsOf(a, side);
    const extraKey = `${test.key}|${akey(a)}|${side ?? ''}`;
    const slots = Math.min(20, Math.max(test.attempts, (rs.at(-1)?.attempt ?? rs.length)) + (testingState.extra[extraKey] ?? 0));
    const pos = rowsOrder.findIndex((x) => x.idx === idx && x.side === side);
    const inputs = [];
    for (let n = 1; n <= slots; n++) {
      const existing = rs.find((r) => (r.attempt ?? rs.indexOf(r) + 1) === n);
      const inp = input({ type: 'text', inputmode: 'decimal', autocomplete: 'off', value: existing ? String(+existing.value.toFixed(metric.decimals + 1)) : '', disabled: !!existing, class: 'dp-input ts-cell',
        'data-cell': `${idx}|${side ?? ''}|${n}`, 'aria-label': `${a.name}${side ? ` ${side === 'L' ? 'left' : 'right'}` : ''} attempt ${n}` });
      if (!existing) {
        // Enter and leaving the box both save; the first one wins, so a value is never saved twice.
        const commit = () => { if (inp.dataset.saving || inp.value.trim() === '') return; inp.dataset.saving = '1'; return busy(inp, async () => {
          const v = parseTyped(inp.value, unitSel.value), problem = checkValue(v);
          if (problem) { inp.classList.add('ts-bad'); throw new Error(problem); }
          await save(a, side, v, n, test.timed && hand.checked ? 'hand' : test.timed ? 'electronic' : undefined, 'manual');
          const next = rowsOrder[pos + 1];
          testingState.focus = next ? `${next.idx}|${next.side ?? ''}|${n}` : null;
          redraw();
        }).finally(() => { delete inp.dataset.saving; }); };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (inp.value.trim()) commit(); else move(pos, 1, n); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); move(pos, 1, n); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); move(pos, -1, n); }
        });
        inp.addEventListener('change', commit);
        inp.addEventListener('input', () => inp.classList.remove('ts-bad'));
        inputs.push(inp);
      } else if (!manage) inputs.push(inp);                // front desk can't delete results; an owner or coach fixes mistakes
      else inputs.push(h('span', { class: 'row', style: 'gap:0' }, inp, btn('×', (e) => { if (confirm(`Delete ${a.name.split(' ')[0]}'s attempt ${n} (${fmtResult(existing.value, metric.unit, metric.decimals)})?`)) busy(e.currentTarget, async () => { await del(`/v1/results/${existing.id}`); redraw(); }); }, 'ghost', { 'aria-label': `Delete attempt ${n}`, class: 'dp-btn dp-btn--ghost ts-x' })));
    }
    if (slots < 20) inputs.push(btn('+', () => { testingState.extra[extraKey] = (testingState.extra[extraKey] ?? 0) + 1; redraw(); }, 'ghost', { 'aria-label': `Add another attempt for ${a.name}`, title: 'Another attempt', class: 'dp-btn dp-btn--ghost ts-x' }));
    const best = bestOf(rs), prev = prevOf(a, side);
    const pr = best != null && prev != null && metric.better !== 'none' && better(metric, best, prev);
    const up = test.timed && testingState.athleteIdx === idx;
    return h('div', { class: `list-item ts-row${up ? ' ts-up' : ''}` },
      test.timed && side === sides[0] ? btn(up ? 'Up' : 'Time', () => { if (stopwatchRunning) return toast('Stop the clock first.', 'warn'); testingState.athleteIdx = idx; redraw(); }, up ? 'outline' : 'ghost', { 'aria-label': `Time ${a.name} next`, style: 'min-width:64px' }) : test.timed ? h('span', { style: 'min-width:64px' }) : null,
      h('div', { class: 'grow stack-tight', style: 'min-width:150px' }, h('span', { class: 'strong' }, a.name, a.archived ? h('span', { class: 'dp-badge dp-badge--muted', style: 'margin-left:6px' }, 'Archived') : null),
        h('span', { class: 'small muted' }, [a.athlete_id, side ? (side === 'L' ? 'Left' : 'Right') : null, prev != null ? `Best before ${fmtResult(prev, metric.unit, metric.decimals)}` : metric.better !== 'none' ? 'First time' : null].filter(Boolean).join(' · '))),
      h('div', { class: 'row wrap', style: 'gap:6px' }, inputs),
      h('span', { class: 'strong', style: 'min-width:92px;text-align:right' }, best == null ? '' : fmtResult(best, metric.unit, metric.decimals), pr ? h('span', { class: 'dp-badge dp-badge--good', style: 'margin-left:6px' }, 'PR') : null),
      manage && side === sides[0] ? btn('Remove', async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try {
          const r = await withConfirm((ok) => del(`/v1/testing-sessions/${id}/athletes/${akey(a)}${ok ? '?confirm=true' : ''}`), (err) => `${a.name} has ${err.details.results} ${err.details.results === 1 ? 'result' : 'results'} on this day. Removing ${a.name.split(' ')[0]} deletes ${err.details.results === 1 ? 'it' : 'them'}. Remove?`);
          if (r) { toast(`${a.name} removed.`); redraw(); }
        } catch (x) { toast(x.message, 'warn'); } finally { b.disabled = false; }
      }, 'ghost', { 'aria-label': `Remove ${a.name} from this day`, class: 'dp-btn dp-btn--ghost ts-remove' }) : null);
  }));

  // Stopwatch: Start, then Stop saves the time to the athlete who's up and moves on. Cancel run (or Esc) for a false start.
  let stopwatch = null;
  if (test.timed && testingState.view === 'entry') {
    const display = h('div', { class: 'ts-clock', 'aria-live': 'off' }, '0.00');
    let t0 = null, raf = null;
    const cur = athletes[testingState.athleteIdx];
    // Leaving the screen with the clock running stops it (nothing is saved).
    const tick = () => { if (!display.isConnected) { t0 = null; stopwatchRunning = false; return; } display.textContent = ((performance.now() - t0) / 1000).toFixed(2); raf = requestAnimationFrame(tick); };
    const cancelBtn = btn('Cancel run', () => cancel(), 'ghost', { style: 'display:none' });
    const cancel = () => { if (t0 == null) return; cancelAnimationFrame(raf); t0 = null; stopwatchRunning = false; go.textContent = 'Start'; display.textContent = '0.00'; cancelBtn.style.display = 'none'; toast('Run cancelled. Nothing was saved.'); };
    // Esc cancels a run only on this screen, and never while a dialog is open (Esc closes the dialog).
    swEscape = (e) => { if (e.key === 'Escape' && stopwatchRunning && display.isConnected && !document.querySelector('dialog[open]')) { e.preventDefault(); cancel(); } };
    const saveTime = async (p) => {
      const a = athletes.find((x) => akey(x) === p.key);
      const problem = checkValue(p.secs);
      if (problem) throw new Error(problem);
      const r = await save(a, p.side, p.secs, p.attempt, 'hand', 'stopwatch');
      // A retry of a time that did save is a repeat (nothing new to undo).
      swState = { pending: null, last: r.results[0] ? { id: r.results[0].id, idx: athletes.indexOf(a), label: `${a.name.split(' ')[0]} ${p.secs.toFixed(2)} s` } : swState.last };
      const done = sides.every((sd) => resultsOf(a, sd).length + (sd === p.side ? 1 : 0) >= test.attempts);
      if (done && athletes.indexOf(a) === testingState.athleteIdx) testingState.athleteIdx = Math.min(athletes.length - 1, testingState.athleteIdx + 1);
    };
    const go = btn('Start', async () => {
      if (!cur) return toast('Add an athlete first.', 'warn');
      if (swState.pending) return toast('Save or discard the last time first.', 'warn');
      if (t0 == null) { t0 = performance.now(); stopwatchRunning = true; go.textContent = 'Stop'; cancelBtn.style.display = ''; tick(); return; }
      cancelAnimationFrame(raf); stopwatchRunning = false; cancelBtn.style.display = 'none';
      const secs = Number(((performance.now() - t0) / 1000).toFixed(2));
      t0 = null; go.textContent = 'Start'; display.textContent = secs.toFixed(2);
      const side = sides.find((sd) => resultsOf(cur, sd).length < test.attempts) ?? sides[0];
      const p = { key: akey(cur), name: cur.name, side, attempt: (resultsOf(cur, side).at(-1)?.attempt ?? resultsOf(cur, side).length) + 1, secs };
      if (p.attempt > 20) { display.textContent = '0.00'; return toast(`${cur.name.split(' ')[0]} has 20 attempts, the most a day holds. Delete one to time another.`, 'warn'); }
      try { await saveTime(p); redraw(); }
      catch (e) { swState = { ...swState, pending: { ...p, error: e.message } }; redraw(); }
    }, 'primary', { style: 'min-width:140px;min-height:64px;font-size:22px' });
    const pending = swState.pending;
    const pendingBox = pending ? h('div', { class: 'ts-pending row wrap', role: 'alert' },
      h('span', { class: 'grow' }, `${pending.name}: ${pending.secs.toFixed(2)} s wasn't saved. ${pending.error}`),
      btn('Save again', (e) => busy(e.currentTarget, async () => { await saveTime(pending); redraw(); }), 'secondary'),
      btn('Discard', () => { swState = { ...swState, pending: null }; redraw(); }, 'ghost')) : null;
    const last = swState.last;
    const undoBtn = last && !pending && manage ? btn(`Undo ${last.label}`, (e) => busy(e.currentTarget, async () => { await del(`/v1/results/${last.id}`); testingState.athleteIdx = last.idx; swState = { pending: null, last: null }; toast('Time removed.'); redraw(); }), 'ghost') : null;
    stopwatch = h('section', { class: 'dp-panel stack ts-sticky' },
      h('div', { class: 'row wrap', style: 'gap:12px;align-items:center' }, display, go, cancelBtn, undoBtn,
        h('span', { class: 'small muted grow', style: 'min-width:200px' }, cur ? `Up: ${cur.name}. Stopping the clock saves the time and moves on. Esc cancels a false start.` : 'Add an athlete to start timing.')),
      pendingBox);
  } else swEscape = null;

  // Rankings: today's best per athlete, best first, with the change from their previous best.
  const rankings = () => sides.map((side) => {
    const ranked = athletes.map((a) => ({ a, best: bestOf(resultsOf(a, side)), prev: prevOf(a, side) })).filter((x) => x.best != null)
      .sort((x, y) => (metric.better === 'lower' ? x.best - y.best : y.best - x.best));
    const missing = athletes.filter((a) => !resultsOf(a, side).length);
    return h('div', { class: 'stack-tight' }, side ? h('div', { class: 'dp-label' }, side === 'L' ? 'Left' : 'Right') : null,
      ranked.length ? ranked.map((x, i) => {
        const change = x.prev != null ? x.best - x.prev : null;
        const improved = change != null && better(metric, x.best, x.prev);
        return h('div', { class: 'list-item' }, h('span', { class: 'strong', style: 'min-width:32px' }, metric.better === 'none' ? '' : `${i + 1}.`),
          h('span', { class: 'grow' }, x.a.name), h('span', { class: 'strong' }, fmtResult(x.best, metric.unit, metric.decimals)),
          h('span', { class: `small ${improved ? 'good-text' : 'muted'}`, style: 'min-width:120px;text-align:right' }, change == null ? 'First time' : change === 0 ? 'Same as best' : `${change > 0 ? '+' : '−'}${fmtResult(Math.abs(change), metric.unit, metric.decimals, { delta: true })} vs best`),
          improved ? h('span', { class: 'dp-badge dp-badge--good' }, 'PR') : null);
      }) : h('p', { class: 'muted small' }, 'No results yet.'),
      missing.length && ranked.length ? h('p', { class: 'small muted' }, `Not tested yet: ${missing.map((a) => a.name).join(', ')}.`) : null);
  });

  // Test tabs with progress; arrow keys move between them.
  const tabs = h('div', { class: 'ts-tabs', role: 'tablist', 'aria-label': 'Tests on this day' }, day.tests.map((t, i) => {
    const done = doneFor(t), all = athletes.length && done === athletes.length;
    return h('button', { type: 'button', role: 'tab', class: 'ts-tab', 'aria-selected': String(t.key === test.key), tabindex: t.key === test.key ? '0' : '-1',
      onClick: () => { if (stopwatchRunning) return toast('Stop the clock first.', 'warn'); testingState.testKey = t.key; testingState.athleteIdx = 0; swState = { pending: null, last: null }; redraw(); },
      onKeydown: (e) => { if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return; e.preventDefault(); const next = day.tests[(i + (e.key === 'ArrowRight' ? 1 : -1) + day.tests.length) % day.tests.length]; if (stopwatchRunning) return; testingState.testKey = next.key; testingState.athleteIdx = 0; testingState.focus = `tab|${next.key}`; redraw(); },
      'data-tab': t.key }, shortTest(t), h('span', { class: `ts-tab-count${all ? ' ts-done' : ''}` }, all ? '✓' : `${done}/${athletes.length}`));
  }), addTest);
  const views = h('div', { class: 'row wrap tm-views' }, [['entry', 'Enter results'], ['rankings', 'Rankings']].map(([k, label]) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(testingState.view === k), onClick: () => { if (stopwatchRunning) return toast('Stop the clock first.', 'warn'); testingState.view = k; redraw(); } }, label)));
  const find = athletes.length > 8 ? input({ type: 'search', placeholder: 'Find an athlete', value: testingState.find, 'aria-label': 'Find an athlete', style: 'max-width:260px' }) : null;
  find?.addEventListener('input', () => { testingState.find = find.value; testingState.focus = 'find'; render(); });

  fill(main, banner, header(day.name, subtitle, headerActions), tabs, stopwatch,
    panel(test.name, { subtitle: testingState.view === 'rankings' ? `Today's best per athlete, ${metric.better === 'lower' ? 'fastest' : metric.better === 'higher' ? 'best' : 'latest'} first, with the change from each athlete's previous best.`
      : `${metric.name}${metric.better !== 'none' ? ` · ${metric.better} is better` : ''} · ${test.attempts} ${test.attempts === 1 ? 'attempt' : 'attempts'}${test.sides === 'lr' ? ' per side' : ''}${metric.range ? ` · possible: ${rangeWords(metric.range, metric.unit)}` : ''}. Values save as you type; Enter moves down.${hint ? ` ${hint}.` : ''}`,
    action: h('div', { class: 'row wrap' }, views, testingState.view === 'entry' && test.timed ? h('label', { class: 'row small', style: 'gap:6px;min-height:44px' }, hand, 'Hand-timed') : null, testingState.view === 'entry' ? h('div', { style: 'width:110px' }, unitSel) : null) },
      test.description && testingState.view === 'entry' ? h('p', { class: 'small muted' }, test.description) : null,
      find,
      testingState.view === 'rankings' ? rankings() : athletes.length ? (rows.flat().length ? rows : h('p', { class: 'muted small' }, 'No athletes match. Clear the search.')) : h('p', { class: 'muted' }, 'No athletes yet. Add a walk-up below.'),
      h('div', { style: 'max-width:360px;margin-top:8px' }, walkUp)),
    notes?.data.length ? notesPanel(id, notes) : null);
  // Put the cursor back where the coach was typing.
  const f = testingState.focus; testingState.focus = null;
  if (f === 'find') { find?.focus(); find?.setSelectionRange(find.value.length, find.value.length); }
  else if (f?.startsWith('tab|')) main.querySelector(`[data-tab="${f.slice(4)}"]`)?.focus();
  else if (f) main.querySelector(`input[data-cell="${f}"]`)?.focus();
}
document.addEventListener('keydown', (e) => { if (location.hash.startsWith('#/testing/')) swEscape?.(e); });

// A short note per athlete for parents: drafted from the results, read and approved by a coach.
function notesPanel(id, notes) {
  const manage = state.user.role !== 'front_desk';
  const missing = notes.data.filter((x) => !x.note).length, drafts = notes.data.filter((x) => x.note && !x.note.approved).length;
  const redraw = () => { const y = window.scrollY; render(); setTimeout(() => window.scrollTo(0, y), 300); };
  const edit = (x) => {
    const d = document.getElementById('dialog'), text = textarea(x.note.body, { rows: '8', style: 'min-height:180px', 'aria-label': `Note for ${x.name}` });
    const save = (approved) => (e) => busy(e.currentTarget, async () => { await patch(`/v1/progress-notes/${x.note.id}`, { body: text.value, ...(approved ? { approved: true } : {}) }); d.close(); toast(approved ? 'Approved.' : 'Saved.'); redraw(); });
    fill(d, h('div', { class: 'stack' }, h('h2', { class: 'dp-panel-title' }, `Note for ${x.name.split(' ')[0]}'s parents`),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Check every number against the results, and add anything only you know.'), text,
      h('div', { class: 'row wrap' }, x.note.approved ? null : btn('Save and approve', save(true), 'primary'), btn('Save', save(false), x.note.approved ? 'primary' : 'secondary'), btn('Cancel', () => d.close(), 'ghost'))));
    d.addEventListener('close', () => fill(d), { once: true });
    d.showModal();
  };
  return panel('Notes for parents', { subtitle: `A few sentences per athlete on what improved and what's next, drafted from the results${notes.ai ? ' and worded by Claude' : ''}. Read and approve each one; parents see approved notes ${notes.shared ? 'on their report now' : 'once you share this day'}.`,
    action: manage ? h('div', { class: 'row wrap' },
      missing ? btn(`Draft ${missing === notes.data.length ? 'notes' : `${missing} more`}`, (e) => busy(e.currentTarget, async () => { const r = await post(`/v1/testing-sessions/${id}/notes/draft`); toast(`Drafted ${r.drafted} ${r.drafted === 1 ? 'note' : 'notes'}. Read each one before approving.`); redraw(); }), 'secondary') : null,
      drafts ? btn(drafts === 1 ? 'Approve draft' : 'Approve all', (e) => { if (confirm(`Approve ${drafts} ${drafts === 1 ? 'note' : 'notes'}? Only do this after reading them.`)) busy(e.currentTarget, async () => { await post(`/v1/testing-sessions/${id}/notes/approve`); toast('Approved.'); redraw(); }); }, 'outline') : null) : null },
    notes.data.map((x) => h('div', { class: 'list-item', style: 'align-items:flex-start' },
      h('div', { class: 'grow stack-tight' },
        h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'strong' }, x.name), x.note ? h('span', { class: `dp-badge dp-badge--${x.note.approved ? 'good' : 'warn'}` }, x.note.approved ? 'Approved' : 'Draft') : h('span', { class: 'small muted' }, 'No note yet')),
        x.note ? h('p', { class: 'small', style: 'margin:0;white-space:pre-wrap' }, x.note.body) : null),
      manage && x.note ? h('div', { class: 'row' }, btn('Edit', () => edit(x), 'ghost'),
        !x.note.approved ? btn('Redo', (e) => busy(e.currentTarget, async () => { await post(`/v1/testing-sessions/${id}/notes/draft`, { client_ids: [x.client_id] }); redraw(); }), 'ghost') : null,
        !x.note.approved ? btn('Approve', (e) => busy(e.currentTarget, async () => { await patch(`/v1/progress-notes/${x.note.id}`, { approved: true }); redraw(); }), 'secondary') : null) : null)));
}

// ---------- Test library: search and filter every test, one test's details and record board, and presets ----------
const canEditLibrary = () => state.user.role !== 'front_desk';
const metricText = (m) => `${m.name} (${UNIT_LABEL[m.unit] || m.unit || 'score'}${m.better === 'none' ? ', a measurement' : m.better === 'lower' ? ', lower is better' : ', higher is better'})`;
const usageText = (u) => (u.results ? `${u.results} ${u.results === 1 ? 'result' : 'results'} · ${u.athletes} ${u.athletes === 1 ? 'athlete' : 'athletes'} · last used ${ymd(u.last_used)}` : 'Not used yet');
const libTabs = (tab) => h('div', { class: 'row', role: 'tablist', 'aria-label': 'Test library', style: 'gap:8px' },
  [['tests', 'Tests', '#/testing/library'], ['presets', 'Presets', '#/testing/library?tab=presets']].map(([k, label, href]) =>
    h('a', { class: `dp-btn dp-btn--${tab === k ? 'secondary' : 'ghost'}`, href, role: 'tab', 'aria-selected': tab === k ? 'true' : 'false', 'aria-current': tab === k ? 'page' : null, style: 'min-height:44px' }, label)));

async function viewLibrary(main) {
  const q = hashQuery();
  if (q.get('test')) return viewTestDetails(main, q.get('test'));
  if (q.get('tab') === 'presets') return viewPresets(main);
  const lib = await get('/v1/tests?usage=true');
  const cats = new Map(lib.categories.map((c) => [c.key, c.name]));
  const edit = canEditLibrary();
  const search = input({ type: 'search', placeholder: 'Name, unit or protocol', value: q.get('q') ?? '', 'aria-label': 'Find a test' });
  const cat = select([['', 'All categories'], ...lib.categories.map((c) => [c.key, c.name])], { value: cats.has(q.get('cat')) ? q.get('cat') : '', 'aria-label': 'Category' });
  const SHOW = [['all', 'All tests'], ['active', 'In menus'], ['hidden', 'Hidden'], ['custom', 'Your own']];
  const show = select(SHOW, { value: SHOW.some(([k]) => k === q.get('show')) ? q.get('show') : 'all', 'aria-label': 'Show' });
  const SORT = [['category', 'By category'], ['used', 'Most used'], ['name', 'A to Z']];
  const sort = select(SORT, { value: SORT.some(([k]) => k === q.get('sort')) ? q.get('sort') : 'category', 'aria-label': 'Sort' });
  const box = h('div', { class: 'stack' });
  const words = (t) => [t.name, t.key, t.description, t.protocol, cats.get(t.category), ...t.metrics.flatMap((m) => [m.name, m.unit, UNIT_LABEL[m.unit]])].filter(Boolean).join(' ').toLowerCase();
  // Hide or show in place: the row updates, keyboard focus stays on its button.
  const toggle = async (t, b, row) => {
    await patch(`/v1/tests/${encodeURIComponent(t.key)}`, { active: !t.active });
    t.active = !t.active;
    b.textContent = t.active ? 'Hide' : 'Show';
    b.setAttribute('aria-label', `${t.active ? 'Hide' : 'Show'} ${t.name}`);
    row.style.opacity = t.active ? '' : '.6';
    row.querySelector('.lib-hidden').hidden = t.active;
    toast(t.active ? `${t.name} is back in your menus.` : `${t.name} is hidden from your menus. Its results stay.`);
    if (show.value === 'active' || show.value === 'hidden') renderList();
  };
  const row = (t) => {
    const hideBtn = edit ? btn(t.active ? 'Hide' : 'Show', null, 'ghost', { 'aria-label': `${t.active ? 'Hide' : 'Show'} ${t.name}`, style: 'min-height:44px' }) : null;
    const el = h('div', { class: 'list-item', style: `align-items:flex-start;${t.active ? '' : 'opacity:.6'}` },
      h('div', { class: 'grow stack-tight', style: 'min-width:0' },
        h('div', { class: 'row wrap', style: 'gap:8px' }, h('a', { class: 'strong', href: `#/testing/library?test=${encodeURIComponent(t.key)}`, style: 'min-height:44px;display:inline-flex;align-items:center' }, t.name),
          t.builtin ? null : h('span', { class: 'dp-badge dp-badge--neutral' }, 'Yours'), h('span', { class: 'dp-badge dp-badge--muted lib-hidden', hidden: t.active }, 'Hidden')),
        h('span', { class: 'small muted' }, `${cats.get(t.category) ?? t.category} · ${t.metrics.map(metricText).join(' · ')}`),
        h('span', { class: 'small muted' }, usageText(t.usage), t.presets.length ? ` · In ${t.presets.map((p) => p.name).join(', ')}` : '')),
      hideBtn);
    if (hideBtn) hideBtn.addEventListener('click', () => busy(hideBtn, () => toggle(t, hideBtn, el)).then(() => { if (hideBtn.isConnected) hideBtn.focus(); }));
    return el;
  };
  function renderList() {
    const s = search.value.trim().toLowerCase();
    const next = new URLSearchParams({ ...(s ? { q: search.value.trim() } : {}), ...(cat.value ? { cat: cat.value } : {}), ...(show.value !== 'all' ? { show: show.value } : {}), ...(sort.value !== 'category' ? { sort: sort.value } : {}) }).toString();
    history.replaceState(null, '', `#/testing/library${next ? `?${next}` : ''}`);
    const list = lib.data.filter((t) => (!s || s.split(/\s+/).every((w) => words(t).includes(w))) && (!cat.value || t.category === cat.value)
      && (show.value === 'all' || (show.value === 'active' && t.active) || (show.value === 'hidden' && !t.active) || (show.value === 'custom' && !t.builtin)));
    const byName = (a, b) => a.name.localeCompare(b.name);
    if (!list.length) {
      return fill(box, h('div', { class: 'empty stack', style: 'align-items:center' }, h('span', null, s ? `No tests match "${search.value.trim()}".` : 'No tests here.'),
        h('div', { class: 'row wrap', style: 'justify-content:center' },
          s || cat.value || show.value !== 'all' ? btn('Clear the search', () => { search.value = ''; cat.value = ''; show.value = 'all'; renderList(); search.focus(); }, 'secondary') : null,
          edit && s ? btn(`Add "${search.value.trim()}" as a new test`, () => testDialog(null, lib.categories, search.value.trim()), 'ghost') : null)));
    }
    if (sort.value === 'category') {
      return fill(box, lib.categories.map((c) => { const ts = list.filter((t) => t.category === c.key); return ts.length ? panel(c.name, { subtitle: `${ts.length} ${ts.length === 1 ? 'test' : 'tests'}` }, ts.map(row)) : null; }));
    }
    const sorted = [...list].sort(sort.value === 'used' ? (a, b) => b.usage.results - a.usage.results || byName(a, b) : byName);
    fill(box, panel(null, {}, sorted.map(row)));
  }
  search.addEventListener('input', renderList);
  for (const el of [cat, show, sort]) el.addEventListener('change', renderList);
  const ready = lib.data.filter((t) => t.active).length;
  fill(main, header('Test library', `${ready} tests in your menus, ${lib.data.length - ready} hidden. Every built-in test says how to run it.`,
    h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing'), edit ? btn('Add test', () => testDialog(null, lib.categories), 'primary') : null)),
    libTabs('tests'),
    h('div', { class: 'lib-toolbar' }, field('Find a test', search), field('Category', cat), field('Show', show), field('Sort', sort)),
    box);
  renderList();
}

// Add or edit a test in a dialog. Built-in tests keep their numbers, units and scoring; your own can change them until they have results.
function testDialog(t, categories, prefillName = '') {
  const d = document.getElementById('dialog');
  const isNew = !t, locked = t && (t.builtin || t.has_results);
  const name = input({ value: t?.name ?? prefillName, required: true, maxlength: '80' });
  const cat = select(categories.map((c) => [c.key, c.name]), { value: t?.category ?? 'sport' });
  const attempts = input({ type: 'number', min: '1', max: '10', step: '1', value: String(t?.attempts ?? 2), inputmode: 'numeric' });
  const protocol = textarea(t ? t.protocol : '', { rows: '5', maxlength: '2000' });
  const description = textarea(t?.description ?? '', { rows: '2', maxlength: '1000' });
  const sides = h('input', { type: 'checkbox', checked: t ? t.sides === 'lr' : false, disabled: !!locked });
  const timed = h('input', { type: 'checkbox', checked: !!t?.timed });
  const metrics = (t?.metrics ?? [{ key: 'value', name: 'Result', unit: '', better: 'higher', range: null, range_custom: false }]).map((m) => ({
    m, name: input({ value: m.name, disabled: !!locked, maxlength: '60' }), unit: input({ value: m.unit, disabled: !!locked, placeholder: 's, in, lb, mph…', maxlength: '20' }),
    better: select([['lower', 'Lower is better'], ['higher', 'Higher is better'], ['none', 'A measurement']], { value: m.better, disabled: !!locked }),
    min: input({ type: 'number', step: 'any', value: m.range?.[0] != null ? String(m.range[0]) : '', 'aria-label': `${m.name}: lowest possible` }),
    max: input({ type: 'number', step: 'any', value: m.range?.[1] != null ? String(m.range[1]) : '', 'aria-label': `${m.name}: highest possible` })
  }));
  for (const x of metrics) { x.min0 = x.min.value; x.max0 = x.max.value; }
  const metricRows = metrics.map((x) => h('div', { class: 'lib-metric' },
    h('div', { class: 'form-grid lib-grid-metric' }, field(metrics.length > 1 ? `Number ${metrics.indexOf(x) + 1}` : 'What you record', x.name), field('Unit', x.unit), field('Scoring', x.better)),
    h('div', { class: 'form-grid lib-grid-2' }, field('Lowest possible', x.min), field('Highest possible', x.max))));
  const save = (e) => { e.preventDefault(); busy(e.submitter, async () => {
    // The range is sent only when it was changed, so saving doesn't turn the built-in range into your own.
    const ms = metrics.map((x) => ({ key: x.m.key, ...(locked ? {} : { name: x.name.value, unit: x.unit.value, better: x.better.value }),
      ...(x.min.value !== x.min0 || x.max.value !== x.max0 ? { min_value: x.min.value, max_value: x.max.value } : {}) }));
    if (isNew) {
      const out = await post('/v1/tests', { name: name.value, category: cat.value, attempts: attempts.value, protocol: protocol.value, description: description.value, sides: sides.checked ? 'lr' : 'none', timed: timed.checked, metrics: ms.map(({ key, ...m }) => ({ ...m, key: 'value' })) });
      d.close(); toast(`${out.name} added.`); location.hash = `#/testing/library?test=${encodeURIComponent(out.key)}`; return;
    }
    const out = await patch(`/v1/tests/${encodeURIComponent(t.key)}`, { name: name.value, category: cat.value, attempts: attempts.value, protocol: protocol.value, description: description.value, ...(locked ? {} : { sides: sides.checked ? 'lr' : 'none' }), timed: timed.checked, metrics: ms });
    d.close(); toast(out.changes.length ? 'Saved.' : 'Nothing changed.'); render();
  }); };
  fill(d, h('form', { class: 'stack', onSubmit: save, style: 'max-width:640px' },
    h('h2', { class: 'dp-panel-title' }, isNew ? 'Add your own test' : `Edit ${t.name}`),
    t?.builtin ? h('p', { class: 'small muted', style: 'margin:0' }, 'Built-in tests keep their numbers, units and scoring, because device imports and past results rely on them. Add your own test if you need a different one.')
      : t?.has_results ? h('p', { class: 'small muted', style: 'margin:0' }, 'This test has results, so its numbers, units, scoring and sides are fixed. Add a new test for a different unit.') : null,
    h('div', { class: 'form-grid lib-grid-name' }, field('Name', name), field('Category', cat), field('Attempts', attempts)),
    metricRows,
    h('div', { class: 'row wrap', style: 'gap:8px 20px' }, h('label', { class: 'row small', style: 'gap:6px;min-height:44px' }, sides, 'Test left and right'), h('label', { class: 'row small', style: 'gap:6px;min-height:44px' }, timed, 'Can be hand-timed with the stopwatch (seconds only)')),
    field('How to run it', protocol, t?.builtin ? 'Leave it as it is, or write your own. Empty the box to go back to the built-in text.' : 'So every coach runs it the same way and retests compare.'),
    field('What it measures (optional)', description),
    h('p', { class: 'dp-hint', style: 'margin:0' }, 'The possible range catches numbers typed into the wrong column on uploads. Leave both empty to use the built-in range.'),
    h('div', { class: 'row wrap' }, btn(isNew ? 'Add test' : 'Save', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
  name.focus();
}

async function viewTestDetails(main, key) {
  const q = hashQuery();
  const params = new URLSearchParams(Object.fromEntries(['metric', 'side', 'sex', 'age'].map((k) => [k, q.get(k) ?? '']).filter(([, val]) => val))).toString();
  const [t, lib] = await Promise.all([get(`/v1/tests/${encodeURIComponent(key)}/details${params ? `?${params}` : ''}`), get('/v1/tests')]);
  const edit = canEditLibrary();
  const rec = t.records;
  const go = (changes) => { const next = new URLSearchParams({ test: key, ...Object.fromEntries(['metric', 'side', 'sex', 'age'].map((k) => [k, q.get(k) ?? ''])), ...changes }); for (const [k, val] of [...next]) if (!val) next.delete(k); location.hash = `#/testing/library?${next}`; };
  const scored = t.metrics.filter((m) => m.better !== 'none');
  const filters = h('div', { class: 'lib-toolbar' },
    scored.length > 1 ? field('Number', select(scored.map((m) => [m.key, m.name]), { value: rec.metric, onChange: (e) => go({ metric: e.target.value }) })) : null,
    t.sides === 'lr' ? field('Side', select([['', 'Either side'], ['L', 'Left'], ['R', 'Right']], { value: q.get('side') ?? '', onChange: (e) => go({ side: e.target.value }) })) : null,
    field('Sex', select([['', 'Everyone'], ['F', 'Girls and women'], ['M', 'Boys and men']], { value: q.get('sex') ?? '', onChange: (e) => go({ sex: e.target.value }) })),
    field('Age when set', select([['', 'All ages'], ...t.age_groups.map((a) => [a.key, a.label])], { value: q.get('age') ?? '', onChange: (e) => go({ age: e.target.value }) })));
  const board = rec.board.length ? h('ol', { class: 'lib-board' }, rec.board.map((r) => h('li', { class: 'list-item' },
    h('span', { class: 'lib-rank', 'aria-hidden': 'true' }, String(r.rank)),
    h('div', { class: 'grow stack-tight' },
      r.client_id ? h('a', { class: 'strong', href: `#/clients/${r.client_id}`, style: 'min-height:44px;display:inline-flex;align-items:center' }, r.name) : h('span', { class: 'strong', style: 'min-height:44px;display:inline-flex;align-items:center' }, r.name),
      h('span', { class: 'small muted' }, [r.athlete_id, r.side ? (r.side === 'L' ? 'Left' : 'Right') : null].filter(Boolean).join(' · ')),
      h('span', { class: 'small muted' }, ymd(r.date))),
    h('span', { class: 'strong', style: 'text-align:right' }, fmtResult(r.value, rec.unit, rec.decimals), r.hand_timed ? h('div', { class: 'small muted' }, 'hand-timed') : null))))
    : h('div', { class: 'empty' }, rec.note ?? (params ? 'No results match these filters.' : 'No results yet. The best result for each athlete shows here.'));
  const remove = () => { if (confirm(`Delete ${t.name}? This can't be undone.`)) busy(null, async () => { await api('DELETE', `/v1/tests/${encodeURIComponent(t.key)}`); toast(`${t.name} deleted.`); location.hash = '#/testing/library'; }); };
  fill(main, header(t.name, `${lib.categories.find((c) => c.key === t.category)?.name ?? t.category} · ${t.builtin ? 'Built-in test' : 'Your own test'}${t.active ? '' : ' · Hidden from your menus'}`,
    h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing/library' }, 'All tests'),
      edit ? btn('Edit test', () => testDialog(t, lib.categories), 'primary') : null)),
    panel('How to run it', { subtitle: t.protocol_custom ? 'Written by your team.' : t.builtin ? 'The standard protocol. Edit the test to write your own.' : null },
      t.protocol ? h('p', { style: 'margin:0;white-space:pre-wrap' }, t.protocol) : h('p', { class: 'muted', style: 'margin:0' }, edit ? 'No protocol yet. Edit the test to write how to run it.' : 'No protocol yet.'),
      t.description ? h('p', { class: 'small muted' }, t.description) : null),
    panel('Details', {},
      h('div', { class: 'stack-tight small' },
        t.metrics.map((m) => h('div', null, h('span', { class: 'strong' }, metricText(m)), m.range ? h('span', { class: 'muted' }, ` · possible ${rangeWords(m.range, m.unit)}${m.range_custom ? ' (your range)' : ''}`) : null)),
        h('div', null, `${t.attempts} ${t.attempts === 1 ? 'attempt' : 'attempts'}${t.sides === 'lr' ? ' per side' : ''}${t.timed ? ' · can be hand-timed' : ''}`),
        h('div', null, usageText(t.usage), t.usage.days ? ` · ${t.usage.days} testing ${t.usage.days === 1 ? 'day' : 'days'}` : ''),
        h('div', null, t.presets.length ? ['In presets: ', t.presets.map((p, i) => [i ? ', ' : '', h('a', { href: '#/testing/library?tab=presets' }, p.name)])] : 'Not in any preset.'))),
    panel('Record board', { subtitle: rec.better === 'none' ? null : `Each athlete's best ${rec.metric_name.toLowerCase()}, top 10. ${rec.better === 'lower' ? 'Lower' : 'Higher'} is better.` }, filters, board),
    edit ? panel(null, {}, h('div', { class: 'row wrap' },
      btn(t.active ? 'Hide from menus' : 'Show in menus', (e) => busy(e.currentTarget, async () => { await patch(`/v1/tests/${encodeURIComponent(t.key)}`, { active: !t.active }); toast(t.active ? `${t.name} is hidden. Its results stay.` : `${t.name} is back in your menus.`); render(); }), 'secondary'),
      t.deletable ? btn('Delete test', remove, 'ghost') : h('span', { class: 'small muted' }, t.not_deletable_because))) : null);
}

// Presets: named sets of tests in running order, to start a testing day in one tap.
async function viewPresets(main) {
  const [list, lib] = await Promise.all([get('/v1/test-presets'), get('/v1/tests')]);
  const edit = canEditLibrary(), plan = state.user.role !== 'front_desk';
  const redraw = () => render();
  fill(main, header('Test library', 'Presets are the tests you run together, in order. Start a testing day from one in a tap.',
    h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing'), edit ? btn('New preset', () => presetDialog(null, lib, redraw), 'primary') : null)),
    libTabs('presets'),
    panel(null, {}, list.data.length ? list.data.map((p) => h('div', { class: 'list-item', style: 'align-items:flex-start;flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', { class: 'strong' }, p.name),
        h('span', { class: 'small muted' }, p.tests.length ? `${p.tests.length} ${p.tests.length === 1 ? 'test' : 'tests'}: ${p.tests.map((t) => t.name).join(', ')}` : 'No tests. Edit it to add some.'),
        p.hidden ? h('span', { class: 'small', style: 'color:var(--amber)' }, `${p.hidden} of these ${p.hidden === 1 ? 'is' : 'are'} hidden from your menus.`) : null),
      h('div', { class: 'row wrap' },
        plan && p.tests.length ? h('a', { class: 'dp-btn dp-btn--secondary', href: `#/testing/new?preset=${encodeURIComponent(p.id)}`, style: 'min-height:44px' }, 'Plan a day') : null,
        edit ? btn('Edit', () => presetDialog(p, lib, redraw), 'ghost', { 'aria-label': `Edit ${p.name}`, style: 'min-height:44px' }) : null,
        edit ? btn('Copy', (e) => busy(e.currentTarget, async () => { const c = await post(`/v1/test-presets/${p.id}/copy`); toast(`Copied as ${c.name}.`); redraw(); }), 'ghost', { 'aria-label': `Copy ${p.name}`, style: 'min-height:44px' }) : null,
        edit ? btn('Delete', (e) => { if (confirm(`Delete the ${p.name} preset? Testing days made from it keep their tests.`)) busy(e.currentTarget, async () => { await del(`/v1/test-presets/${p.id}`); toast(`${p.name} deleted.`); redraw(); }); }, 'ghost', { 'aria-label': `Delete ${p.name}`, style: 'min-height:44px' }) : null)))
      : h('div', { class: 'empty' }, edit ? 'No presets yet. Add one for the tests you run together, like a combine or a preseason battery.' : 'No presets yet.')));
}

function presetDialog(p, lib, done) {
  const d = document.getElementById('dialog');
  const name = input({ value: p?.name ?? '', required: true, maxlength: '40' });
  const chosen = (p?.tests ?? []).map((t) => t.key);
  const byKey = new Map(lib.data.map((t) => [t.key, t]));
  for (const t of p?.tests ?? []) if (!byKey.has(t.key)) byKey.set(t.key, t);          // a hidden test already in the preset
  const listBox = h('ol', { class: 'stack-tight', style: 'padding:0;margin:0;list-style:none' });
  const find = input({ type: 'search', placeholder: 'Find a test to add', 'aria-label': 'Find a test to add' });
  const pick = select([], { 'aria-label': 'Test to add' });
  const fillPick = () => {
    const s = find.value.trim().toLowerCase();
    const opts = lib.data.filter((t) => !chosen.includes(t.key) && (!s || t.name.toLowerCase().includes(s)));
    fill(pick, opts.length ? opts.map((t) => h('option', { value: t.key }, t.name)) : h('option', { value: '' }, s ? 'No tests match' : 'Every test is in the preset'));
  };
  const draw = () => {
    fill(listBox, chosen.length ? chosen.map((k, i) => h('li', { class: 'list-item', style: 'padding:6px 0' },
      h('span', { class: 'small muted', style: 'min-width:24px' }, `${i + 1}.`), h('span', { class: 'grow' }, byKey.get(k)?.name ?? k),
      btn('↑', () => { [chosen[i - 1], chosen[i]] = [chosen[i], chosen[i - 1]]; draw(); listBox.querySelectorAll('li')[i - 1]?.querySelector('button')?.focus(); }, 'ghost', { 'aria-label': `Move ${byKey.get(k)?.name} up`, disabled: i === 0, style: 'min-width:44px;min-height:44px' }),
      btn('↓', () => { [chosen[i + 1], chosen[i]] = [chosen[i], chosen[i + 1]]; draw(); listBox.querySelectorAll('li')[i + 1]?.querySelectorAll('button')[1]?.focus(); }, 'ghost', { 'aria-label': `Move ${byKey.get(k)?.name} down`, disabled: i === chosen.length - 1, style: 'min-width:44px;min-height:44px' }),
      btn('Remove', () => { chosen.splice(i, 1); draw(); fillPick(); find.focus(); }, 'ghost', { 'aria-label': `Remove ${byKey.get(k)?.name}`, style: 'min-height:44px' })))
      : h('li', { class: 'small muted' }, 'No tests yet. Add them below in the order you run them.'));
  };
  const add = () => { if (!pick.value) return; chosen.push(pick.value); draw(); fillPick(); find.focus(); };
  find.addEventListener('input', fillPick);
  find.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  draw(); fillPick();
  const save = (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const out = p ? await patch(`/v1/test-presets/${p.id}`, { name: name.value, tests: chosen }) : await post('/v1/test-presets', { name: name.value, tests: chosen });
    d.close(); toast(`${out.name} saved with ${out.tests.length} ${out.tests.length === 1 ? 'test' : 'tests'}.`); done();
  }); };
  fill(d, h('form', { class: 'stack', onSubmit: save, style: 'max-width:560px' },
    h('h2', { class: 'dp-panel-title' }, p ? `Edit ${p.name}` : 'New preset'),
    field('Name', name, 'Like Combine, Preseason or U12 battery.'),
    h('div', { class: 'dp-label' }, 'Tests, in running order'), listBox,
    h('div', { class: 'form-grid lib-grid-add' }, field('Find', find), field('Test', pick), btn('Add', add, 'secondary', { style: 'min-height:44px' })),
    h('div', { class: 'row wrap' }, btn('Save preset', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
  name.focus();
}

// ---------- Import clients from a spreadsheet ----------
let importState = null;
async function viewImport(main) {
  const file = h('input', { type: 'file', accept: '.xlsx,.csv,text/csv', class: 'dp-input' });
  const st = importState;
  let body;
  if (st?.done) {
    body = panel('Imported', { subtitle: `${st.done.imported} ${st.done.imported === 1 ? 'client' : 'clients'} added${st.done.invited ? `, ${st.done.invited} welcome ${st.done.invited === 1 ? 'email' : 'emails'} sent` : ''}.` },
      st.done.athletes.map((a) => h('a', { class: 'list-item', href: `#/clients/${a.client_id}`, style: 'text-decoration:none;color:inherit' }, h('span', { class: 'grow strong' }, a.name), idChip(a.athlete_id), h('span', { class: 'small muted' }, a.adult ? 'Adult' : st.done.families.find((f) => f.family_id === a.family_id)?.name ?? ''))),
      h('div', { class: 'row' }, btn('Import another file', () => { importState = null; render(); }, 'secondary'), h('a', { class: 'dp-btn dp-btn--ghost', href: '#/clients' }, 'All clients')));
  } else if (st && !st.ok) {
    body = h('section', { class: 'dp-panel stack', style: 'border-color:var(--amber)' }, h('h2', { class: 'dp-panel-title', style: 'color:var(--amber)' }, 'This sheet can\'t be imported yet'),
      h('p', null, `Nothing was imported. ${st.error_count} ${st.error_count === 1 ? 'problem needs' : 'problems need'} fixing. Fix ${st.error_count === 1 ? 'it' : 'them'}, save, and upload again.`),
      h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Row'), h('th', null, 'Column'), h('th', null, 'What to fix'))),
        h('tbody', null, st.errors.map((e) => h('tr', null, h('td', null, e.row ?? '—'), h('td', null, e.column ?? '—'), h('td', null, e.message)))))),
      h('div', null, btn('Upload the fixed sheet', () => { importState = null; render(); }, 'primary')));
  } else if (st) {
    const welcome = h('input', { type: 'checkbox', checked: true });
    body = panel('Ready to import', { subtitle: `${st.summary.athletes} ${st.summary.athletes === 1 ? 'client' : 'clients'}: ${st.summary.new_families} new ${st.summary.new_families === 1 ? 'family' : 'families'}, ${st.summary.existing_families} added to existing ${st.summary.existing_families === 1 ? 'family' : 'families'}, ${st.summary.adults} ${st.summary.adults === 1 ? 'adult' : 'adults'}. These are the exact Athlete IDs they'll get.` },
      st.families.map((f) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
        h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', { class: 'strong' }, f.name), h('span', { class: 'small muted' }, f.parents.map((p) => `${p.name} (${p.email})`).join(', '))),
        h('span', { class: `dp-badge dp-badge--${f.status === 'new' ? 'good' : 'neutral'}` }, f.status === 'new' ? 'New family' : 'Existing family'),
        h('div', { class: 'row wrap', style: 'gap:6px' }, f.athletes.map((a) => h('span', { class: 'small' }, `${a.name} `, idChip(a.athlete_id)))))),
      st.athletes.filter((a) => a.adult).map((a) => h('div', { class: 'list-item' }, h('span', { class: 'grow strong' }, a.name), h('span', { class: 'dp-badge dp-badge--muted' }, 'Adult'), idChip(a.athlete_id))),
      h('label', { class: 'row small', style: 'gap:8px;min-height:40px' }, welcome, h('span', null, 'Email new families and adults their sign-in details')),
      h('div', { class: 'row' }, btn(`Import ${st.summary.athletes} ${st.summary.athletes === 1 ? 'client' : 'clients'}`, (e) => busy(e.currentTarget, async () => {
        try { importState = { ...st, done: await post('/v1/client-import/commit', { preview_id: st.preview_id, send_welcome: welcome.checked }) }; }
        catch (err) { if (!err.details) throw err; importState = { ok: false, errors: err.details, error_count: err.details.length }; }
        render();
      }), 'primary'), btn('Start over', () => { importState = null; render(); }, 'ghost')));
  } else {
    body = h('div', { class: 'grid grid-2' },
      panel('1. Get the template', { subtitle: 'One row per athlete. Kids get a parent email (siblings share one, and become one family); adults paying for themselves get their own email.' },
        h('div', { class: 'row wrap' }, btn('Download Excel', (e) => busy(e.currentTarget, () => download('/v1/client-import/template')), 'primary'), btn('Download CSV', (e) => busy(e.currentTarget, () => download('/v1/client-import/template?format=csv')), 'ghost')),
        h('p', { class: 'small muted' }, 'Memberships and cards aren\'t imported: families add their own card in the parent portal, and you can start memberships from each profile.')),
      panel('2. Upload it', { subtitle: 'The whole sheet is checked first. If anything is wrong, nothing is imported and you\'ll see what to fix.' },
        field('File (Excel or CSV)', file),
        h('div', null, btn('Check the sheet', (e) => busy(e.currentTarget, async () => {
          if (!file.files[0]) throw new Error('Choose a file.');
          const b = { filename: file.files[0].name };
          if (/\.xlsx$/i.test(file.files[0].name)) b.xlsx_base64 = toBase64(await file.files[0].arrayBuffer()); else b.csv = await file.files[0].text();
          importState = await post('/v1/client-import/preview', b); render();
        }), 'primary'))));
  }
  fill(main, header('Import clients', 'Bring your current families and athletes in from a spreadsheet. Every athlete gets an Athlete ID.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/clients' }, 'Clients')), body);
}

// ---------- Staff & security (owner) ----------
function renderPasswordChange(forced) {
  const cur = input({ type: 'password', autocomplete: 'current-password' }), next = input({ type: 'password', autocomplete: 'new-password' }), again = input({ type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const root = document.getElementById('root');
  fill(root, h('main', { class: 'login' }, h('form', { class: 'dp-panel stack', style: 'max-width:420px;width:100%', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
    if (next.value !== again.value) { err.textContent = 'The new passwords don\'t match.'; return; }
    try { await post('/auth/password', { current_password: cur.value, new_password: next.value }); toast('Password changed.'); state.user.must_change_password = false; await boot(); }
    catch (x) { err.textContent = x.message; }
  }); } },
    h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol', style: 'width:160px;align-self:center' }),
    h('h1', { class: 'dp-panel-title' }, forced ? 'Choose your password' : 'Change your password'),
    forced ? h('p', { class: 'muted small' }, 'You signed in with a one-time password. Choose one only you know (10 or more characters).') : null,
    field(forced ? 'One-time password' : 'Current password', cur), field('New password', next, 'At least 10 characters.'), field('New password again', again), err,
    h('div', { class: 'row' }, btn('Save password', null, 'primary', { type: 'submit' }), forced ? btn('Sign out', async () => { await post('/auth/logout'); state.user = null; render(); }, 'ghost') : btn('Cancel', () => render(), 'ghost')))));
  cur.focus();
}

async function viewStaff(main) {
  if (!isOwner()) return fill(main, header('Staff & security', 'Only owners can manage staff.'));
  const [staff, audit, bk, jobs] = await Promise.all([get('/v1/staff'), get('/v1/audit?limit=100'), get('/v1/backups'), get('/v1/jobs')]);
  const ROLE = { owner: 'Owner', coach: 'Coach', front_desk: 'Front desk' };
  const n = input(), e = input({ type: 'email' }), role = select(Object.keys(staff.roles).map((k) => [k, ROLE[k]]), { value: 'coach' });
  const roleHelp = h('p', { class: 'small muted' }, staff.roles.coach);
  role.addEventListener('change', () => { roleHelp.textContent = staff.roles[role.value]; });
  const showPw = (who, pw) => alert(`One-time password for ${who}:\n\n${pw}\n\nIt was also emailed to them. They'll choose their own when they sign in.`);
  const staffPanel = panel('Staff', { subtitle: 'Each person gets their own sign-in. Roles decide what they can see and do.' },
    staff.data.map((u) => h('div', { class: 'list-item', style: `flex-wrap:wrap;${u.active ? '' : 'opacity:.55'}` },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', { class: 'strong' }, u.name, u.id === state.user.id ? h('span', { class: 'small muted' }, ' (you)') : null),
        h('span', { class: 'small muted' }, `${u.email} · ${u.last_login_at ? `last signed in ${ago(u.last_login_at)}` : 'never signed in'}${u.must_change_password ? ' · needs to set a password' : ''}`)),
      u.locked ? h('span', { class: 'dp-badge dp-badge--warn' }, 'Locked') : null,
      !u.active ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Off') : null,
      (() => { const sel = select(Object.keys(staff.roles).map((k) => [k, ROLE[k]]), { value: u.role, 'aria-label': `Role for ${u.name}`, style: 'width:140px' });
        sel.addEventListener('change', () => busy(sel, async () => { try { await patch(`/v1/staff/${u.id}`, { role: sel.value }); toast(`${u.name} is now ${ROLE[sel.value]}. They'll sign in again.`); } catch (x) { sel.value = u.role; throw x; } render(); })); return sel; })(),
      u.locked ? btn('Unlock', (ev) => busy(ev.currentTarget, async () => { await patch(`/v1/staff/${u.id}`, { unlock: true }); render(); }), 'outline') : null,
      btn('Reset password', (ev) => { if (confirm(`Give ${u.name} a new one-time password? They'll be signed out.`)) busy(ev.currentTarget, async () => { const r = await post(`/v1/staff/${u.id}/reset-password`); showPw(u.name, r.temporary_password); render(); }); }, 'ghost'),
      u.id === state.user.id ? null : btn(u.active ? 'Turn off' : 'Turn on', (ev) => { if (!u.active || confirm(`Turn off ${u.name}'s account? They're signed out everywhere right away.`)) busy(ev.currentTarget, async () => { await patch(`/v1/staff/${u.id}`, { active: !u.active }); render(); }); }, 'ghost'))),
    h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (ev) => { ev.preventDefault(); busy(ev.submitter, async () => { const u = await post('/v1/staff', { name: n.value, email: e.value, role: role.value }); showPw(u.name, u.temporary_password); render(); }); } },
      h('div', { class: 'form-grid', style: 'grid-template-columns:2fr 2fr 1fr' }, field('Name', n), field('Email', e), field('Role', role)), roleHelp,
      h('div', null, btn('Add staff member', null, 'primary', { type: 'submit' }))));
  const ACT = (a) => (a.action === 'sign-in' ? (a.status === 200 ? 'Signed in' : a.status === 429 ? 'Sign-in blocked (locked or too many tries)' : 'Failed sign-in') : a.action.replace(/^(POST|PATCH|PUT|DELETE|GET) /, (m) => ({ 'POST ': 'Created/ran ', 'PATCH ': 'Changed ', 'PUT ': 'Set ', 'DELETE ': 'Removed ', 'GET ': 'Opened ' }[m])));
  const auditPanel = panel('Activity log', { subtitle: 'Every change, refused attempt and sign-in by staff, API keys and parents. Request contents are never stored.' },
    h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'), h('th', null, 'Record'), h('th', null, 'Result'))),
      h('tbody', null, audit.data.map((a) => h('tr', null, h('td', { class: 'small muted', style: 'white-space:nowrap' }, ago(a.at)),
        h('td', { class: 'small' }, `${a.actor_name ?? '—'}${a.role ? ` (${ROLE[a.role] ?? a.role})` : a.actor_type !== 'staff' ? ` (${a.actor_type.replace('_', ' ')})` : ''}`),
        h('td', { class: 'small' }, a.action === 'sign-in' ? ACT(a) : a.description ?? ACT(a)), h('td', { class: 'small muted', style: 'font-family:var(--font-mono)' }, a.target ?? ''),
        h('td', null, h('span', { class: `dp-badge dp-badge--${a.status < 300 ? 'good' : a.status === 403 || a.status === 429 || a.status === 401 ? 'warn' : 'muted'}` }, a.status < 300 ? 'OK' : a.status === 403 ? 'Refused' : a.status === 401 ? 'Denied' : a.status === 429 ? 'Blocked' : String(a.status)))))))));
  const kb = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
  const off = bk.offsite;
  const offFailing = off.last_error && (!off.last_ok_at || off.last_error_at > off.last_ok_at);
  const offLine = h('p', { class: 'small' + (offFailing ? '' : ' muted'), role: offFailing ? 'status' : null },
    h('span', { class: `dp-badge dp-badge--${!off.configured || (!off.last_ok_at && !offFailing) ? 'muted' : offFailing ? 'warn' : 'good'}` },
      !off.configured ? 'Off-site: not set up' : offFailing ? 'Off-site: failing' : off.last_ok_at ? 'Off-site: OK' : 'Off-site: waiting'), ' ',
    !off.configured ? 'Copies stay on this server\'s disk only. Setup steps are in DEPLOY.md under Backups.'
      : offFailing ? `${off.last_error} Last try: ${ago(off.last_error_at)}. It retries every hour.`
      : off.last_ok_at ? `Newest encrypted copy sent and restore-checked. Last sent: ${ago(off.last_ok_at)}.` : 'The first encrypted copy goes out within the hour.');
  const backupPanel = panel('Backups', { subtitle: `A full copy of everything is saved every day, and the last 30 are kept. ${off.configured ? 'Each day\'s copy is also encrypted, sent to off-site storage, and read back to check it restores.' : 'Download one now and then and keep it somewhere safe, off this server.'}` },
    offLine,
    bk.data.length ? bk.data.slice(0, 7).map((b) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, new Date(b.created_at).toLocaleString()), h('span', { class: 'muted' }, kb(b.bytes)),
      btn('Download', (ev) => busy(ev.currentTarget, () => download(`/v1/backups/${b.name}`)), 'ghost'))) : h('p', { class: 'muted small' }, 'No backups yet.'),
    h('div', null, btn('Back up now', (ev) => busy(ev.currentTarget, async () => {
      const r = await post('/v1/backups');
      if (r.offsite && !r.offsite.ok) toast(`Backup saved, but the off-site copy failed: ${r.offsite.error}`, 'warn');
      else toast(r.offsite ? 'Backup saved and sent off-site.' : 'Backup saved.');
      render();
    }), 'secondary')),
    h('p', { class: 'small muted' }, 'Backup files contain client, family and medical information. Store them like you would paper records.'));
  const every = (sec) => (sec < 60 ? `every ${sec} seconds` : sec < 3600 ? `every ${sec / 60} min` : sec === 3600 ? 'hourly' : `every ${sec / 3600} hours`);
  const jobBadge = (j) => (j.running ? ['muted', 'Running'] : j.health === 'failing' ? ['warn', j.fail_streak > 1 ? `Failed ${j.fail_streak}×` : 'Failed'] : j.health === 'waiting' ? ['muted', 'Not run yet'] : j.recent[0]?.status === 'skipped' && j.recent[0].started_at === j.last_run_at ? ['muted', 'Nothing to do'] : ['good', 'OK']);
  const jobsPanel = panel('Background jobs', { subtitle: 'The work the server does on its own: billing, school invoices, the schedule, reminders, follow-ups, money checks, webhooks, device syncs and backups. Owners get an email when a job fails and when it recovers.' },
    jobs.data.map((j) => { const [tone, label] = jobBadge(j); return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', { class: 'strong' }, j.name),
        h('span', { class: 'small muted' }, `${every(j.every_seconds)}${j.last_run_at ? ` · last ran ${ago(j.last_run_at)}` : ''}${j.health === 'failing' ? (j.last_ok_at ? ` · last worked ${ago(j.last_ok_at)}` : ' · has not worked yet') : ''}`),
        j.last_error ? h('span', { class: 'small', style: 'font-family:var(--font-mono);word-break:break-word' }, j.last_error) : null),
      h('span', { class: `dp-badge dp-badge--${tone}` }, label),
      btn('Run now', (ev) => busy(ev.currentTarget, async () => {
        const r = await post(`/v1/jobs/${encodeURIComponent(j.name)}/run`);
        toast(r.status === 'failed' ? `${j.name} failed. The error is shown below.` : r.status === 'skipped' ? `${j.name} had nothing to do.` : `${j.name} ran.`, r.status === 'failed' ? 'warn' : 'good');
        render();
      }), 'ghost', j.running ? { disabled: true } : {})); }));
  const requests = await get('/v1/data-requests');
  const openReqs = requests.data.filter((r) => r.status === 'open');
  const reqPanel = panel('Data requests', { subtitle: openReqs.length ? 'Parents asking for their family\'s data to be deleted. Check with your accountant what payment records you must keep; the app keeps them without names.' : 'Parents can download their own data from the portal. Deletion requests appear here.' },
    requests.data.length ? requests.data.slice(0, 20).map((r) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:240px' }, h('span', { class: 'strong' }, `${r.family_name ?? 'Family'}: ${r.kind === 'delete' ? 'delete account' : 'copy of data'}`),
        h('span', { class: 'small muted' }, `${r.requested_by.split(' <')[0]} · ${ago(r.created_at)}${r.note ? ` · "${r.note}"` : ''}${r.resolution ? ` · ${r.resolution}` : ''}`)),
      h('span', { class: `dp-badge dp-badge--${r.status === 'open' ? 'warn' : r.status === 'done' ? 'good' : 'muted'}` }, { open: 'Open', done: 'Done', declined: 'Declined' }[r.status]),
      r.status === 'open' && r.family_id ? btn('Download their data', (e) => busy(e.currentTarget, () => download(`/v1/families/${r.family_id}/export`)), 'ghost') : null,
      r.status === 'open' && r.family_id ? btn('Delete', (e) => {
        const typed = prompt(`Delete the ${r.family_name}'s personal information? Payment records stay without names. This can't be undone.\n\nType the family name to confirm: ${r.family_name}`);
        if (!typed) return;
        busy(e.currentTarget, async () => { await del(`/v1/families/${r.family_id}`, { confirm: typed, request_id: r.id }); toast('Deleted. The family has been emailed.'); render(); });
      }, 'outline') : null,
      r.status === 'open' ? btn('Decline', (e) => { const reason = prompt('Why? (kept with the request)'); if (reason) busy(e.currentTarget, async () => { await post(`/v1/data-requests/${r.id}/decline`, { reason }); render(); }); }, 'ghost') : null))
      : h('p', { class: 'muted small' }, 'No requests yet.'));
  // Connection check: what the hosting proxy sent and which address the app picked, to confirm TRUST_PROXY.
  const connOut = h('div', { class: 'stack-tight' });
  const connPanel = panel('Connection check', { subtitle: 'Sign-in limits and the activity log go by the visitor\'s internet address. This shows which one the app sees for you, so you can confirm the TRUST_PROXY setting on each server.' },
    connOut, h('div', null, btn('Check my connection', (ev) => busy(ev.currentTarget, async () => {
      const c = await get('/v1/staff/connection');
      const row = (label, value) => h('div', { class: 'list-item small', style: 'flex-wrap:wrap' }, h('span', { class: 'grow muted', style: 'min-width:180px' }, label), h('code', { style: 'word-break:break-all' }, value ?? 'none'));
      const KIND = { private: 'hosting network', cloudflare: 'Cloudflare proxy', public: 'public' };
      fill(connOut, row('X-Forwarded-For header', c.forwarded_for), row('Connection address', c.connection_address), row('Address the app decided on', c.decided_address), row('TRUST_PROXY', c.trust_proxy ?? 'not set'),
        h('p', { class: 'strong', style: 'margin:8px 0 0' }, c.guidance),
        ...(c.previews ?? []).map((p) => h('div', { class: 'small', style: `padding:2px 0${p.trust_proxy === c.proxies_trusted ? ';font-weight:600' : ''}` }, `With TRUST_PROXY=${p.trust_proxy} the app would pick: `, h('code', null, p.address), h('span', { class: 'muted' }, ` (${KIND[p.kind] ?? p.kind})${p.trust_proxy === c.proxies_trusted ? ' · now' : ''}`))));
    }), 'secondary')));
  fill(main, header('Staff & security', 'Who can sign in, what they can do, what happened, your backups, background jobs and data requests.'), staffPanel, openReqs.length ? reqPanel : null, h('div', { class: 'grid grid-2' }, backupPanel, openReqs.length ? connPanel : reqPanel), openReqs.length ? null : connPanel, jobsPanel, auditPanel);
}

// Waiting results: arrived without an Athlete ID or a device link. The coach links them by hand.
// Everyone results can be linked to: clients (not archived) and active team roster players.
const linkableAthletes = async () => (await get('/v1/athletes')).data;
// Pick an athlete by typing a name or Athlete ID: arrow keys move through matches, Enter picks. Editing the text
// after a pick clears the pick, so a result never goes to someone who wasn't chosen on purpose.
function athletePicker(everyone, { label, onChange }) {
  let chosen = null, active = -1, matches = [];
  const box = input({ type: 'text', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', autocomplete: 'off', placeholder: 'Type a name or Athlete ID', 'aria-label': label });
  const list = h('ul', { class: 'ts-combo-list', role: 'listbox', style: 'display:none' });
  const status = h('span', { class: 'small' });
  const set = (a) => { chosen = a; status.textContent = a ? `✓ ${a.name} (${a.athlete_id})${a.team ? `, ${a.team}` : ''}` : box.value.trim() ? 'Pick an athlete from the list.' : ''; status.className = a ? 'small good-text' : 'small warn-text'; onChange?.(a); };
  const close = () => { list.style.display = 'none'; box.setAttribute('aria-expanded', 'false'); active = -1; };
  const draw = () => {
    const q = box.value.trim().toLowerCase();
    matches = q ? everyone.filter((a) => `${a.name} ${a.athlete_id}`.toLowerCase().includes(q)).slice(0, 8) : [];
    fill(list, matches.map((a, i) => h('li', { role: 'option', class: 'ts-combo-opt', 'aria-selected': String(i === active), onMousedown: (e) => { e.preventDefault(); pick(a); } },
      h('span', null, a.name), h('span', { class: 'muted small', style: 'font-family:var(--font-mono)' }, a.athlete_id), a.team ? h('span', { class: 'muted small' }, a.team) : null)));
    list.style.display = matches.length ? '' : 'none'; box.setAttribute('aria-expanded', String(!!matches.length));
  };
  const pick = (a) => { box.value = `${a.name} · ${a.athlete_id}`; close(); set(a); };
  box.addEventListener('input', () => { active = -1; draw(); set(null); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && matches.length) { e.preventDefault(); active = (active + 1) % matches.length; draw(); }
    else if (e.key === 'ArrowUp' && matches.length) { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; draw(); }
    else if (e.key === 'Enter' && matches.length && list.style.display !== 'none') { e.preventDefault(); pick(matches[Math.max(active, 0)]); }
    else if (e.key === 'Escape') close();
  });
  box.addEventListener('blur', () => setTimeout(close, 150));
  return { el: h('div', { class: 'stack-tight' }, h('div', { class: 'ts-combo' }, box, list), status), get: () => chosen, pick, focus: () => box.focus() };
}

let queueFilter = { source: '', q: '' };
async function viewQueue(main) {
  if (deskStop(main, 'Waiting to be linked')) return;
  const [q, everyone] = await Promise.all([get('/v1/queue'), linkableAthletes()]);
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const intro = h('p', { class: 'small muted' });
  const totalLeft = () => q.data.reduce((n, g) => n + g.items.length, 0);
  const syncIntro = () => { const n = totalLeft(); intro.textContent = n ? `${n} ${n === 1 ? 'result' : 'results'} from ${q.data.filter((g) => g.items.length).length} unrecognized ${q.data.filter((g) => g.items.length).length === 1 ? 'athlete' : 'athletes'}. Pick who each set belongs to and link it. Linking is all or nothing, and nothing is ever matched by name on its own. Tip: enter Athlete IDs as names on your devices and results skip this step.` : 'Nothing is waiting. Every result has been linked to a profile.'; };

  const cards = q.data.map((g) => {
    const picker = athletePicker(everyone, { label: `Athlete for ${g.label}`, onChange: () => sync() });
    const remember = h('input', { type: 'checkbox', checked: true });
    const rows = g.items.map((it) => {
      const cb = h('input', { type: 'checkbox', checked: true, 'aria-label': `Include ${it.test_name} ${fmtResult(it.value, it.unit, it.decimals)}` });
      const row = h('label', { class: 'list-item small ts-qrow' }, cb,
        h('span', { class: 'grow stack-tight', style: 'min-width:140px' }, h('span', null, `${it.test_name}${it.metric_name && it.metric !== 'time' && it.metric !== 'value' ? ` – ${it.metric_name}` : ''}${it.side ? ` (${it.side === 'L' ? 'left' : 'right'})` : ''}`),
          h('span', { class: 'muted' }, [fmtDay(it.recorded_at), it.device].filter(Boolean).join(' · '))),
        h('span', { class: 'strong' }, fmtResult(it.value, it.unit, it.decimals)));
      cb.addEventListener('change', () => sync());
      return { it, cb, row };
    });
    const tickAll = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Tick all' });
    tickAll.addEventListener('change', () => { live().forEach((r) => { r.cb.checked = tickAll.checked; }); sync(); });
    const linkBtn = btn('Link', null, 'primary');
    const live = () => rows.filter((r) => !r.gone);
    const sync = () => {
      const left = live(), n = left.filter((r) => r.cb.checked).length, all = n === left.length;
      remember.disabled = !all; if (!all) remember.checked = false;
      tickAll.checked = all && n > 0;
      linkBtn.textContent = `Link ${n} ${n === 1 ? 'result' : 'results'}`;
      linkBtn.disabled = !picker.get() || n === 0;
      countEl.textContent = `${left.length} ${left.length === 1 ? 'result' : 'results'}`;
    };
    const countEl = h('span');
    // After linking or discarding, the rows (or the whole card) clear in place.
    const clear = (done) => { done.forEach((r) => { r.gone = true; r.row.remove(); }); g.items = live().map((r) => r.it); if (!g.items.length) { card.dataset.gone = '1'; card.remove(); } else sync(); syncIntro(); if (!totalLeft()) render(); };
    linkBtn.addEventListener('click', () => busy(linkBtn, async () => {
      const a = picker.get();
      if (!a) throw new Error('Pick the athlete from the list.');
      const left = live(), sel = left.filter((r) => r.cb.checked), all = sel.length === left.length && left.length === g.count;
      if (!confirm(`Link ${sel.length} ${sel.length === 1 ? 'result' : 'results'} from "${g.label}" (${g.source_name}) to ${a.name} (${a.athlete_id})?${all && remember.checked ? `\n\nFuture results from ${g.device_id ? `device ID ${g.device_id}` : `"${g.label}"`} will go straight to ${a.name}.` : ''}`)) return;
      const body = { athlete_id: a.athlete_id, ...(all ? { provider: g.provider, identity: g.identity, expect_count: g.count, remember: remember.checked } : { ids: sel.map((r) => r.it.id) }) };
      const r = await post('/v1/queue/link', body);
      toast(`${r.saved} ${r.saved === 1 ? 'result' : 'results'} added to ${r.athlete.name}${r.prs ? `, ${r.prs} new PR${r.prs === 1 ? '' : 's'}` : ''}${r.remembered ? '. Future results will go straight there.' : '.'}`);
      g.count -= sel.length; clear(sel);
    }));
    const discardBtn = btn('Discard selected', (e) => {
      const sel = live().filter((r) => r.cb.checked);
      if (!sel.length) return toast('Tick the results to discard.', 'warn');
      if (confirm(`Discard ${sel.length} ${sel.length === 1 ? 'result' : 'results'} from "${g.label}"? They won't be added to any profile.`)) busy(e.currentTarget, async () => { const r = await post('/v1/queue/discard', { ids: sel.map((x) => x.it.id) }); toast(`${r.discarded} discarded.`); g.count -= sel.length; clear(sel); });
    }, 'ghost');
    const card = panel(g.label, { subtitle: h('span', null, `${g.source_name}${g.device_id && g.device_id !== g.label ? ` · device ID ${g.device_id}` : ''} · `, countEl, ` · received ${ago(g.first_received).toLowerCase()}`) },
      g.suggestions.length ? h('div', { class: 'row wrap small', style: 'gap:8px' }, h('span', { class: 'muted' }, 'Could be:'), g.suggestions.map((sug) => btn(`${sug.name} (${sug.athlete_id})`, () => picker.pick(everyone.find((a) => a.athlete_id === sug.athlete_id) ?? sug), 'secondary'))) : null,
      h('div', { style: 'max-width:480px' }, picker.el),
      h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, tickAll, h('span', null, 'Tick all')),
      h('div', { class: 'stack-tight' }, rows.map((r) => r.row)),
      h('label', { class: 'row small', style: 'gap:8px;min-height:44px' }, remember, h('span', null, `Remember: send future results from ${g.device_id ? `device ID ${g.device_id}` : `"${g.label}"`} (${g.source_name}) straight to this athlete`)),
      h('div', { class: 'row wrap' }, linkBtn, discardBtn));
    card.dataset.source = g.source_name;
    card.dataset.search = `${g.label} ${g.device_id ?? ''} ${g.items.map((it) => it.test_name).join(' ')}`.toLowerCase();
    sync();
    return card;
  });
  const sources = [...new Set(q.data.map((g) => g.source_name))].sort();
  const sourceSel = select([['', 'All sources'], ...sources.map((x) => [x, x])], { value: queueFilter.source, 'aria-label': 'Source' });
  const find = input({ type: 'search', placeholder: 'Find a name, device ID or test', value: queueFilter.q, 'aria-label': 'Find waiting results' });
  const none = h('p', { class: 'muted small', style: 'display:none' }, 'Nothing matches. Clear the search or pick All sources.');
  const apply = () => { queueFilter = { source: sourceSel.value, q: find.value }; const s = find.value.trim().toLowerCase(); let n = 0; cards.forEach((c) => { const ok = (!sourceSel.value || c.dataset.source === sourceSel.value) && (!s || c.dataset.search.includes(s)); c.style.display = ok ? '' : 'none'; n += ok && !c.dataset.gone; }); none.style.display = n || !cards.length ? 'none' : ''; };
  sourceSel.addEventListener('change', apply); find.addEventListener('input', apply);
  syncIntro();
  fill(main, header('Waiting to be linked', 'These results arrived without an Athlete ID or a device you\'ve linked. None of them are in a profile yet.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing')),
    intro,
    q.data.length > 1 ? h('div', { class: 'row wrap' }, sources.length > 1 ? h('div', { style: 'width:220px' }, sourceSel) : null, h('div', { class: 'grow', style: 'min-width:220px;max-width:360px' }, find)) : null,
    none, ...(q.data.length ? cards : [h('div', { class: 'empty' }, 'Nothing is waiting. Every result has been linked to a profile.')]));
  apply();
}

async function viewConnections(main) {
  if (deskStop(main, 'Devices & imports')) return;
  const owner = isOwner();
  const [integ, links, everyone, waitingQ] = await Promise.all([get('/v1/integrations'), get('/v1/athlete-links'), linkableAthletes(), get('/v1/queue')]);
  const sysName = (p) => (p === 'api' ? 'Open API' : integ.data.find((i) => i.provider === p)?.name.split(' (')[0] ?? p);

  // Hawkin: a failed sync shows Needs attention, and the owner can paste a new token right there.
  const hawkin = integ.data.find((i) => i.provider === 'hawkin');
  const token = input({ type: 'password', autocomplete: 'off', placeholder: 'Integration token from Hawkin' }), region = select([['americas', 'Americas'], ['europe', 'Europe'], ['apac', 'Asia-Pacific']], { value: hawkin.region ?? 'americas' });
  const tokenForm = h('form', { class: 'row wrap', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { const r = await api('PUT', '/v1/integrations/hawkin', { refresh_token: token.value, region: region.value }); toast(`Connected. ${r.sync.results} results pulled from the last 90 days.`); render(); }); } },
    h('div', { class: 'grow', style: 'min-width:220px' }, field(hawkin.last_error ? 'Paste a new token' : 'Integration token', token)), field('Region', region), h('div', { style: 'align-self:flex-end' }, btn('Connect', null, 'secondary', { type: 'submit' })));
  const needsAttention = hawkin.connected && hawkin.last_error;
  const hawkinPanel = panel('Hawkin Dynamics force plates', { subtitle: hawkin.connected ? `Connected (${hawkin.token_hint}). ${hawkin.last_sync_at ? `Last sync ${ago(hawkin.last_sync_at).toLowerCase()}.` : ''} New tests sync every 15 minutes.` : hawkin.note,
    action: needsAttention ? h('span', { class: 'dp-badge dp-badge--warn' }, 'Needs attention') : hawkin.connected ? h('span', { class: 'dp-badge dp-badge--good' }, 'Connected') : null },
    needsAttention ? h('p', { class: 'small warn-text' }, `The last sync failed: ${hawkin.last_error} ${owner ? 'If Hawkin gave you a new integration token, paste it below.' : 'Ask the owner to paste a new token from Hawkin.'}`) : null,
    owner && hawkin.connected ? h('div', { class: 'row wrap' },
      btn('Sync now', (e) => busy(e.currentTarget, async () => { const r = await post('/v1/integrations/hawkin/sync'); toast(`${r.results} new results${r.waiting_for_match ? `, ${r.waiting_for_match} waiting for an athlete match` : ''}.`); render(); }), 'secondary'),
      btn('Disconnect', (e) => { if (confirm('Disconnect Hawkin? Results already saved stay.')) busy(e.currentTarget, async () => { await del('/v1/integrations/hawkin'); render(); }); }, 'ghost')) : null,
    owner && (!hawkin.connected || needsAttention) ? tokenForm : null,
    !owner && !hawkin.connected ? h('p', { class: 'small muted' }, 'The owner connects Hawkin.') : null);

  // Link a device ahead of time.
  const providers = [...new Set(['api', ...integ.data.map((i) => i.provider).filter((p) => p !== 'generic'), ...waitingQ.data.map((g) => g.provider)])];
  const sys = select(providers.map((p) => [p, sysName(p)]), { value: 'freelap', 'aria-label': 'System' });
  const kind = select([['id', 'A device ID'], ['name', 'A name the device uses']], { value: 'id', 'aria-label': 'What you\'re typing' });
  const ext = input({ placeholder: 'Like 1047 or A-17', 'aria-label': 'Device ID or name' });
  kind.addEventListener('change', () => { ext.placeholder = kind.value === 'name' ? 'Like Tyler G, as the device spells it' : 'Like 1047 or A-17'; });
  const picker = athletePicker(everyone, { label: 'Athlete this device belongs to' });
  const linkPanel = panel('Link a device', { subtitle: 'Results from this device ID (or the name it uses) go straight to the athlete from now on. Anything already waiting from it is linked too.' },
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const a = picker.get();
      if (!ext.value.trim()) throw new Error('Enter the device ID or the name the device uses.');
      if (!a) throw new Error('Pick the athlete from the list.');
      const idText = kind.value === 'name' ? `name:${ext.value.trim().toLowerCase()}` : ext.value.trim();
      const had = links.data.find((l) => l.provider === sys.value && l.external_id.toLowerCase() === idText.toLowerCase());
      if (had && had.athlete_id !== a.athlete_id && !confirm(`${ext.value.trim()} is linked to ${had.athlete_name} now. Linking it again moves it to ${a.name}. Continue?`)) return;
      const r = await post('/v1/athlete-links', { provider: sys.value, external_id: ext.value.trim(), kind: kind.value, athlete_id: a.athlete_id });
      toast(`${r.moved_from ? `Moved from ${r.moved_from.name} to ${a.name}` : r.already_linked ? `Already linked to ${a.name}` : `Linked to ${a.name}`}${r.linked ? `. ${r.linked} waiting ${r.linked === 1 ? 'result' : 'results'} added` : ''}.`);
      render();
    }); } },
      h('div', { class: 'form-grid cols-3' }, field('System', sys), field('What you\'re typing', kind), field('Device ID or name', ext)),
      h('div', { class: 'dp-field' }, h('span', { class: 'dp-label' }, 'Athlete'), picker.el),
      h('div', null, btn('Link device', null, 'primary', { type: 'submit' }))));

  // Linked devices: find, change the athlete, unlink with Undo.
  const listBox = h('div', { class: 'stack-tight' });
  const findL = input({ type: 'search', placeholder: 'Find a device or athlete', 'aria-label': 'Find a linked device', style: 'max-width:320px' });
  const linkLabel = (l) => (l.external_id.startsWith('name:') ? `name "${l.external_name ?? l.external_id.slice(5)}"` : `ID ${l.external_id}${l.external_name && l.external_name !== l.external_id ? ` (${l.external_name})` : ''}`);
  const rowFor = (l) => {
    const row = h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
      h('span', { class: 'grow', style: 'min-width:200px' }, `${sysName(l.provider)}: ${linkLabel(l)}`),
      h('span', null, '→ ', l.athlete_name ?? 'Removed athlete'), idChip(l.athlete_id), l.athlete_archived_at ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Archived') : null,
      btn('Change', () => {
        const p = athletePicker(everyone, { label: `New athlete for ${linkLabel(l)}` });
        const save = btn('Move link', (e) => busy(e.currentTarget, async () => {
          const a = p.get(); if (!a) throw new Error('Pick the athlete from the list.');
          const r = await post('/v1/athlete-links', { provider: l.provider, external_id: l.external_id, athlete_id: a.athlete_id });
          toast(`Moved to ${a.name}${r.linked ? `. ${r.linked} waiting ${r.linked === 1 ? 'result' : 'results'} added` : ''}.`); render();
        }), 'primary');
        fill(row, h('div', { class: 'stack', style: 'width:100%' }, h('span', null, `${sysName(l.provider)}: ${linkLabel(l)} → who instead?`), p.el, h('div', { class: 'row wrap' }, save, btn('Cancel', () => render(), 'ghost'))));
        p.focus();
      }, 'ghost'),
      btn('Unlink', (e) => busy(e.currentTarget, async () => {
        const r = await del(`/v1/athlete-links/${l.provider}/${encodeURIComponent(l.external_id)}`);
        row.remove(); links.data = links.data.filter((x) => x !== l);
        undoToast(`Unlinked ${linkLabel(l)}. Its results will wait to be linked.`, () => busy(null, async () => { await post('/v1/athlete-links', r.link); toast('Link put back.'); render(); }));
      }), 'ghost'));
    row.dataset.search = `${sysName(l.provider)} ${l.external_id} ${l.external_name ?? ''} ${l.athlete_name ?? ''} ${l.athlete_id ?? ''}`.toLowerCase();
    return row;
  };
  const linkRows = links.data.map(rowFor);
  findL.addEventListener('input', () => { const s = findL.value.trim().toLowerCase(); linkRows.forEach((r) => { r.style.display = !s || r.dataset.search.includes(s) ? '' : 'none'; }); });
  fill(listBox, linkRows.length ? linkRows : h('p', { class: 'muted small' }, 'None yet. Link a device above, or link waiting results and choose to remember them.'));
  const linksPanel = panel('Linked devices', { subtitle: 'Results from these device IDs and names go straight to the athlete. Everything else needs an Athlete ID or waits for you.' },
    links.data.length > 6 ? findL : null, listBox);

  const example = `curl -X POST ${location.origin}/v1/results \\
  -H "Authorization: Bearer dp_live_..." -H "Content-Type: application/json" \\
  -d '{"provider":"gates","results":[{"athlete":{"athlete_id":"AVALOP2026"},
       "test":"dash_40yd","value":4.71,"timing":"electronic","external_id":"run-8812"}]}'`;
  const apiPanel = panel('Send results from any system', { subtitle: 'Any timing system, app or script can post results to the open API with an API key. Values in other units are converted, results with an Athlete ID (or from a linked device) land right away, and resending the same result is ignored.' },
    h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Copy', async () => { await navigator.clipboard?.writeText(example).catch(() => {}); toast('Example copied.'); }, 'ghost', { 'aria-label': 'Copy the API example' })),
    h('pre', { class: 'small', style: 'white-space:pre-wrap;overflow-x:auto;background:var(--ground);padding:12px;border-radius:6px;margin:0' }, example),
    h('div', { class: 'row wrap' }, owner ? h('a', { class: 'dp-btn dp-btn--secondary', href: '#/integrations' }, 'API keys') : null, h('a', { class: 'dp-btn dp-btn--ghost', href: '/v1/openapi.json', target: '_blank' }, 'Full API reference')));

  fill(main, header('Devices & imports', 'Get results in from anywhere: live connections, file imports, the open API, or by hand.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing')),
    waitingQ.n ? h('div', { class: 'test-banner row wrap', style: 'gap:12px' }, h('span', { class: 'grow' }, `${waitingQ.n} ${waitingQ.n === 1 ? 'result is' : 'results are'} waiting from ${waitingQ.groups} unrecognized ${waitingQ.groups === 1 ? 'athlete' : 'athletes'}. Nothing lands in a profile until you link it.`), h('a', { class: 'dp-btn dp-btn--outline', href: '#/testing/queue' }, 'Link them')) : null,
    linkPanel, linksPanel, hawkinPanel,
    panel('Import a file', { subtitle: 'OVR, VALD, Swift, Freelap, Brower, Dashr, Rapsodo, radar guns, our template or any spreadsheet.' }, h('p', { class: 'small muted' }, integ.data.find((i) => i.provider === 'ovr').note), h('div', null, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing/upload' }, 'Upload results'))),
    apiPanel);
}

// Download a file from the API with the coach's session.
async function download(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message ?? 'Download failed.'); }
  const name = (res.headers.get('content-disposition') ?? '').match(/filename="([^"]+)"/)?.[1] ?? 'download';
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const toBase64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

// Upload results: 1 get a sheet with everyone's athlete ID, 2 upload it (or any export), 3 review sorted by athlete, then save.
// The form's choices are kept while a sheet is fixed and checked again.
let uploadState = null;
let uploadForm = { session: null, date: null, test: '', source: '', paste: '', fileName: null };
const UPLOAD_SOURCES = ['Our sheet', 'Freelap', 'Swift', 'Brower', 'Dashr', 'OVR', 'VALD', 'Jump mat', 'Rapsodo', 'Radar gun', 'Paper sheet', 'Other'];
const MAX_UPLOAD_MB = 10;
async function viewUpload(main) {
  if (deskStop(main, 'Upload results')) return;
  const qs = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (qs.get('session')) uploadForm.session = qs.get('session');
  const [days, lib, teamList, clientsList, recent, presetList] = await Promise.all([get('/v1/testing-sessions'), get('/v1/tests'), get('/v1/teams'), get('/v1/clients'), get('/v1/uploads'), get('/v1/test-presets')]);
  const presets = presetList.data.filter((p) => p.tests.length);

  // Step 1: template
  const daySel = select([['', 'No testing day'], ...days.data.map((d) => [d.id, `${d.name} (${ymd(d.date)})`])], { value: uploadForm.session ?? '' });
  const teamSel = select([['', 'Choose athletes later'], ...teamList.data.map((c) => [c.id, c.label])]);
  const presetSel = select(presets.length ? presets.map((p) => [p.id, p.name]) : [['', 'No presets yet']], { disabled: !presets.length });
  const tplOpts = h('div', { class: 'form-grid' }, field('Team', teamSel), field('Tests', presetSel, presets.length ? 'From your presets in the Test library.' : 'Add a preset in the Test library, or pick a testing day.'));
  const syncTpl = () => { tplOpts.style.display = daySel.value ? 'none' : ''; };
  daySel.addEventListener('change', syncTpl); syncTpl();
  const tplQuery = () => {
    if (daySel.value) return `session_id=${daySel.value}`;
    const preset = presets.find((p) => p.id === presetSel.value);
    if (!preset) throw new Error('There are no presets yet. Add one in the Test library, or pick a testing day.');
    return `tests=${preset.tests.map((t) => t.key).join(',')}${teamSel.value ? `&contract_id=${teamSel.value}` : `&client_ids=${clientsList.data.filter((c) => c.status !== 'canceled').map((c) => c.id).join(',')}`}`;
  };
  const step1 = panel('1. Get the sheet', { subtitle: 'Every athlete\'s ID is filled in, with a column for each test and attempt. Fill it in on paper, a laptop, or a phone.' },
    field('Testing day', daySel), tplOpts,
    h('div', { class: 'row wrap' }, btn('Download Excel', (e) => busy(e.currentTarget, () => download(`/v1/uploads/template?${tplQuery()}`)), 'secondary'), btn('Download CSV (Google Sheets)', (e) => busy(e.currentTarget, () => download(`/v1/uploads/template?${tplQuery()}&format=csv`)), 'ghost')));

  // Step 2: upload (drag and drop, or choose, or paste)
  const file = h('input', { type: 'file', accept: '.xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'dp-input', 'aria-label': 'Choose a file' });
  const fileNote = h('span', { class: 'small muted' }, 'Excel (.xlsx) or CSV, up to 10 MB.');
  const pickFile = (f) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD_MB * 1024 * 1024) { file.value = ''; fileNote.textContent = `${f.name} is over ${MAX_UPLOAD_MB} MB. Split it into smaller sheets.`; fileNote.className = 'small warn-text'; return; }
    fileNote.textContent = `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB) is ready to check.`; fileNote.className = 'small good-text';
  };
  file.addEventListener('change', () => pickFile(file.files[0]));
  const drop = h('div', { class: 'ts-drop', onDragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, onDragleave: () => drop.classList.remove('over'),
    onDrop: (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) { file.files = e.dataTransfer.files; pickFile(file.files[0]); } } },
    h('span', { class: 'strong' }, 'Drop the file here, or choose it'), file, fileNote);
  const paste = h('textarea', { class: 'dp-input', placeholder: 'Or paste rows straight from Excel or Google Sheets, header row included.', style: 'min-height:90px', 'aria-label': 'Pasted rows' });
  paste.value = uploadForm.paste;
  const source = select([['', 'Where it\'s from…'], ...UPLOAD_SOURCES.map((x) => [x, x])], { value: uploadForm.source, 'aria-label': 'Where it\'s from' });
  const oneTest = select([['', 'It\'s our sheet or has test columns'], ...lib.data.map((t) => [t.key, t.name])], { value: uploadForm.test });
  const upDay = select([['', 'No testing day'], ...days.data.map((d) => [d.id, `${d.name} (${ymd(d.date)})`])], { value: uploadForm.session ?? '' });
  const upDate = input({ type: 'date', value: uploadForm.date ?? bizDate(), max: bizDate() });
  const dateNote = h('span', { class: 'small muted' });
  const syncDate = () => { const d = days.data.find((x) => x.id === upDay.value); upDate.disabled = !!d; if (d) upDate.value = d.date; dateNote.textContent = d ? 'The testing day sets the date.' : ''; };
  upDay.addEventListener('change', syncDate); syncDate();
  const remember = () => { uploadForm = { session: upDay.value || null, date: upDate.disabled ? uploadForm.date : upDate.value, test: oneTest.value, source: source.value, paste: paste.value, fileName: file.files[0]?.name ?? null }; };
  async function doPreview(fromFile = file, fromPaste = paste) {
    remember();
    const body = { session_id: upDay.value || undefined, test: oneTest.value || undefined, date: upDay.value ? undefined : upDate.value || undefined, source: source.value || undefined };
    const f = fromFile?.files?.[0];
    if (f) {
      if (f.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`${f.name} is over ${MAX_UPLOAD_MB} MB. Split it into smaller sheets and upload them one at a time.`);
      body.filename = f.name;
      if (/\.xlsx$/i.test(f.name)) body.xlsx_base64 = toBase64(await f.arrayBuffer());
      else if (/\.xls$/i.test(f.name)) throw new Error('That\'s an old .xls file. In Excel, choose File → Save As → Excel Workbook (.xlsx), then upload it.');
      else body.csv = await f.text();
    } else if (fromPaste?.value.trim()) { body.csv = fromPaste.value; body.filename = 'Pasted rows'; uploadForm.paste = fromPaste.value; }
    else throw new Error('Choose a file or paste your rows.');
    uploadState = { ...(await post('/v1/uploads/preview', body)), filename: body.filename, pasted: !f, confirmed: new Set(), saved: null, filter: 'all', q: '' };
    render();
  }
  const step2 = panel('2. Upload it', { subtitle: 'Every row needs a real Athlete ID and every value has to fit its test. If anything is off, nothing is saved and you\'ll see exactly what to fix.' },
    drop, paste,
    h('div', { class: 'form-grid' }, field('Add to testing day', upDay), h('div', { class: 'stack-tight' }, field('Date for rows without one', upDate), dateNote), field('Where it\'s from', source), field('Device export with one test?', oneTest)),
    h('div', null, btn('Check the sheet', (e) => busy(e.currentTarget, () => doPreview()), 'primary')));

  // Recent uploads, each with Undo.
  let undoing = false;
  const undoUpload = async (b, button) => {
    if (undoing) return;
    const what = [b.created && `${b.created} new ${b.created === 1 ? 'result comes' : 'results come'} out`, b.replaced && `${b.replaced} replaced ${b.replaced === 1 ? 'value goes' : 'values go'} back`, b.waiting && `${b.waiting} waiting ${b.waiting === 1 ? 'result is' : 'results are'} dropped`].filter(Boolean);
    if (!confirm(`Undo ${b.filename ?? 'this upload'}? ${what.length ? `${what.join(', ')}.` : ''} Anything changed or linked since is left alone.`)) return;
    undoing = true; button.disabled = true;
    try { const r = await post(`/v1/uploads/${b.id}/undo`); toast(`Undone: ${r.summary}.`); if (uploadState?.saved?.batch_id === b.id) uploadState = null; render(); }
    catch (e) { toast(e.message, 'warn'); button.disabled = false; }
    finally { undoing = false; }
  };
  const recentPanel = recent.data.length ? panel('Recent uploads', { subtitle: 'Undo takes an upload back out: new results are removed, replaced values go back, and results sent to waiting are dropped.' },
    recent.data.map((b) => h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
      h('div', { class: 'grow stack-tight', style: 'min-width:220px' }, h('span', { class: 'strong' }, b.filename ?? 'Upload'),
        h('span', { class: 'muted' }, [b.source, b.session_name, b.by_name && `by ${b.by_name}`, ago(b.created_at)].filter(Boolean).join(' · '))),
      h('span', null, [`${b.saved} saved`, b.replaced && `${b.replaced} replaced`, b.unchanged && `${b.unchanged} already saved`, b.waiting && `${b.waiting} to link`, b.prs && `${b.prs} PR${b.prs === 1 ? '' : 's'}`].filter(Boolean).join(' · ')),
      b.undone_at ? h('span', { class: 'dp-badge dp-badge--muted', title: b.undo_summary ?? '' }, `Undone ${ago(b.undone_at).toLowerCase()}`) : btn('Undo', (e) => undoUpload(b, e.currentTarget), 'ghost')))) : null;

  // Step 3: results of the check
  let step3 = null;
  const st = uploadState;
  const problemsCsv = (list) => { const cell = (x) => (/[",\n]/.test(String(x ?? '')) ? `"${String(x).replace(/"/g, '""')}"` : x ?? ''); return ['Row,Column,Athlete ID,What to fix', ...list.map((e) => [e.row, e.column, e.athlete_id, e.message].map(cell).join(','))].join('\r\n'); };
  const saveCsv = (text, name) => { const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' })); const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); };
  const problemList = (list) => h('div', null,
    h('div', { class: 'ts-problems-table', style: 'overflow-x:auto' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Row'), h('th', null, 'Column'), h('th', null, 'Athlete'), h('th', null, 'What to fix'))),
      h('tbody', null, list.map((e) => h('tr', null, h('td', null, e.row ?? '—'), h('td', null, e.column ?? '—'), h('td', { style: 'font-family:var(--font-mono)' }, e.athlete_id ?? ''), h('td', null, e.message)))))),
    h('div', { class: 'ts-problems-cards stack-tight' }, list.map((e) => h('div', { class: 'list-item small', style: 'flex-direction:column;align-items:flex-start' },
      h('span', { class: 'muted' }, [e.row ? `Row ${e.row}` : null, e.column, e.athlete_id].filter(Boolean).join(' · ') || 'Whole sheet'), h('span', null, e.message)))));
  if (st?.saved) {
    const s = st.saved;
    step3 = panel('Saved', { subtitle: `${s.saved} ${s.saved === 1 ? 'result' : 'results'} saved for ${s.athletes.length} ${s.athletes.length === 1 ? 'athlete' : 'athletes'}${s.replaced ? ` (${s.replaced} replaced an earlier value)` : ''}${s.prs ? `, ${s.prs} new PR${s.prs === 1 ? '' : 's'}` : ''}.${s.already_saved ? ` ${s.already_saved} ${s.already_saved === 1 ? 'was' : 'were'} already saved and left as ${s.already_saved === 1 ? 'it was' : 'they were'}.` : ''}` },
      s.athletes.map((a) => h('a', { class: 'list-item', href: a.client_id ? `#/clients/${a.client_id}` : `#/teams/${a.contract_id}`, style: 'text-decoration:none;color:inherit' },
        h('span', { class: 'grow strong' }, a.name), idChip(a.athlete_id), h('span', { class: 'small muted' }, `${a.results} ${a.results === 1 ? 'result' : 'results'}`), a.prs ? h('span', { class: 'dp-badge dp-badge--good' }, `${a.prs} PR${a.prs === 1 ? '' : 's'}`) : null)),
      h('div', { class: 'row wrap' }, btn('Upload another', () => { uploadState = null; uploadForm.paste = ''; render(); }, 'primary'),
        recent.data.some((b) => b.id === s.batch_id && !b.undone_at) ? btn('Undo this upload', (e) => undoUpload(recent.data.find((b) => b.id === s.batch_id), e.currentTarget), 'ghost') : null,
        st.session?.id ? h('a', { class: 'dp-btn dp-btn--secondary', href: `#/testing/${st.session.id}` }, 'Back to the testing day') : null));
  } else if (st && !st.ok) {
    // Fix in place: pasted rows edit right here; a file is chosen again. The options above are kept.
    const fixPaste = st.pasted ? h('textarea', { class: 'dp-input', wrap: 'off', style: 'min-height:160px;font-family:var(--font-mono);font-size:13px;white-space:pre', 'aria-label': 'Your rows, to fix' }) : null;
    if (fixPaste) fixPaste.value = uploadForm.paste;
    const fixFile = st.pasted ? null : h('input', { type: 'file', accept: '.xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'dp-input', 'aria-label': 'Choose the fixed file' });
    step3 = h('section', { class: 'dp-panel stack', style: 'border-color:var(--amber)' },
      h('h2', { class: 'dp-panel-title', style: 'color:var(--amber)' }, 'This sheet can\'t be saved'),
      h('p', null, `Nothing was saved. ${st.error_count} ${st.error_count === 1 ? 'problem needs' : 'problems need'} fixing in ${st.filename ?? 'the sheet'}.`),
      problemList(st.errors), st.error_count > st.errors.length ? h('p', { class: 'small muted' }, `Showing the first ${st.errors.length}.`) : null,
      h('div', { class: 'row wrap' }, btn('Download the problems (CSV)', () => saveCsv(problemsCsv(st.errors), 'problems-to-fix.csv'), 'ghost')),
      h('div', { class: 'dp-label' }, st.pasted ? 'Fix the rows here' : `Fix ${st.filename ?? 'the file'}, save it, and choose it again`),
      fixPaste ?? fixFile,
      h('div', { class: 'row wrap' }, btn('Check again', (e) => busy(e.currentTarget, () => (st.pasted ? doPreview(null, fixPaste) : doPreview(fixFile, null))), 'primary'),
        btn('Start over', () => { uploadState = null; render(); }, 'ghost')));
  } else if (st) {
    const s = st.summary;
    const saveBtn = btn(`Save ${s.results} results`, (e) => busy(e.currentTarget, async () => {
      try { const saved = await post('/v1/uploads/commit', { preview_id: st.preview_id, confirm: [...st.confirmed] }); uploadState = { ...st, saved }; uploadForm.paste = ''; toast(`${saved.saved} ${saved.saved === 1 ? 'result' : 'results'} saved.`); render(); }
      catch (err) { if (!err.details) throw err; uploadState = { ...st, ok: err.code !== 'upload_rejected', errors: err.details, error_count: err.details.length }; if (err.code === 'upload_rejected') render(); else throw err; }
    }), 'primary');
    const write = s.new + s.replaced;
    const syncSave = () => { const left = st.warnings.length - st.confirmed.size; saveBtn.disabled = left > 0 || !write; saveBtn.textContent = left ? `Confirm ${left} more to save` : write ? `Save ${write} ${write === 1 ? 'result' : 'results'} for ${s.athletes} ${s.athletes === 1 ? 'athlete' : 'athletes'}` : 'Nothing new to save'; };
    const confirmPanel = st.warnings.length ? h('div', { class: 'stack', style: 'border:1px solid var(--amber);border-radius:8px;padding:12px' },
      h('strong', { style: 'color:var(--amber)' }, `Confirm ${st.warnings.length === 1 ? 'this value' : `these ${st.warnings.length} values`}`),
      h('p', { class: 'small muted', style: 'margin:0' }, 'They\'re possible but unusual. Tick each one that\'s right. If one is a mistake, fix the sheet and upload it again.'),
      st.warnings.map((w) => { const cb = h('input', { type: 'checkbox', checked: st.confirmed.has(w.key) }); cb.addEventListener('change', () => { cb.checked ? st.confirmed.add(w.key) : st.confirmed.delete(w.key); syncSave(); });
        return h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, cb, h('span', null, h('span', { class: 'muted' }, `Row ${w.row}, ${w.column}: `), w.message)); })) : null;
    const statusBadge = (r) => (r.status === 'unchanged' ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Already saved')
      : r.status === 'replace' ? h('span', { class: 'dp-badge dp-badge--neutral' }, `Was ${r.was.map((x) => fmtResult(x, r.unit, r.decimals)).join(', ')}`) : h('span', { class: 'dp-badge dp-badge--good' }, 'New'));
    const cards = st.athletes.map((g) => {
      const card = h('details', { class: 'dp-panel', open: g.results.some((r) => r.warning) || st.athletes.length <= 3 },
        h('summary', { class: 'row wrap', style: 'cursor:pointer;gap:12px;min-height:44px;list-style:none' }, h('span', { class: 'strong grow' }, g.name), idChip(g.athlete_id), h('span', { class: 'small muted' }, `${g.results.length} ${g.results.length === 1 ? 'result' : 'results'}`),
          g.results.some((r) => r.pr) ? h('span', { class: 'dp-badge dp-badge--good' }, 'PR') : null, g.results.some((r) => r.warning) ? h('span', { class: 'dp-badge dp-badge--warn' }, 'Confirm') : null),
        g.results.map((r) => h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
          h('span', { class: 'grow', style: 'min-width:160px' }, `${r.test_name}${r.side ? ` – ${r.side === 'L' ? 'Left' : 'Right'}` : ''}${r.attempt ? ` #${r.attempt}` : ''}`),
          h('span', { class: 'muted' }, ymd(r.date)),
          h('span', { class: 'strong' }, fmtResult(r.value, r.unit, r.decimals)),
          r.entered_unit !== r.unit ? h('span', { class: 'muted' }, `from ${r.entered} ${r.entered_unit}`) : null,
          statusBadge(r),
          r.previous_best != null ? h('span', { class: 'muted' }, `Best before ${fmtResult(r.previous_best, r.unit, r.decimals)}`) : null,
          r.pr ? h('span', { class: 'dp-badge dp-badge--good' }, 'PR') : null,
          r.warning ? h('span', { class: 'dp-badge dp-badge--warn' }, 'Unusual') : null)));
      card.dataset.search = `${g.name} ${g.athlete_id}`.toLowerCase();
      card.dataset.look = String(g.results.some((r) => r.warning || r.status === 'replace'));
      card.dataset.pr = String(g.results.some((r) => r.pr));
      return card;
    });
    // Big sheets: filter to what needs a look, or the PRs, and find an athlete.
    const applyFilter = () => { const q = st.q.trim().toLowerCase(); let shown = 0; cards.forEach((c) => { const ok = (st.filter === 'all' || (st.filter === 'look' && c.dataset.look === 'true') || (st.filter === 'prs' && c.dataset.pr === 'true')) && (!q || c.dataset.search.includes(q)); c.style.display = ok ? '' : 'none'; shown += ok; }); none.style.display = shown ? 'none' : ''; };
    const none = h('p', { class: 'muted small', style: 'display:none' }, 'No athletes match.');
    const filterBtns = [['all', 'All'], ['look', 'Needs a look'], ['prs', 'PRs']].map(([k, label]) => h('button', { type: 'button', class: 'tm-view', 'aria-pressed': String(st.filter === k), onClick: () => { st.filter = k; filterBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['all', 'look', 'prs'][i] === k))); applyFilter(); } }, label));
    const findA = input({ type: 'search', placeholder: 'Find an athlete', 'aria-label': 'Find an athlete in this sheet', style: 'max-width:260px' });
    findA.addEventListener('input', () => { st.q = findA.value; applyFilter(); });
    const r = st.read;
    const how = r ? h('details', { class: 'small' }, h('summary', { style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'How the file was read'),
      h('ul', { class: 'stack-tight', style: 'margin:0;padding-left:18px' },
        h('li', null, `${st.pasted ? 'Pasted rows' : st.format === 'xlsx' ? `Excel file ${st.filename ?? ''}` : `CSV file ${st.filename ?? ''}`}, ${st.rows} ${st.rows === 1 ? 'row' : 'rows'}${st.source ? `, from ${st.source}` : ''}.`),
        h('li', null, `Athletes found by the "${r.id_column ?? r.name_column}" column${r.id_column && r.name_column ? `, checked against "${r.name_column}"` : ''}.`),
        h('li', null, r.date_column ? `Dates from "${r.date_column}"${st.session ? `; rows without one use the testing day (${ymd(st.session.date)})` : ''}.` : st.session ? `Every result is dated ${ymd(st.session.date)}, the testing day.` : 'No date column: every result uses the date you chose.'),
        h('li', null, `Test columns: ${r.columns.map((c) => c.header).join(', ')}.`),
        r.ignored.length ? h('li', null, `Left out (empty or not a test): ${r.ignored.join(', ')}.`) : null)) : null;
    const summaryLine = [`${s.results} ${s.results === 1 ? 'result' : 'results'} for ${s.athletes} ${s.athletes === 1 ? 'athlete' : 'athletes'}`, s.new && `${s.new} new`, s.replaced && `${s.replaced} replace an earlier value`, s.unchanged && `${s.unchanged} already saved (left as ${s.unchanged === 1 ? 'it is' : 'they are'})`, s.prs && `${s.prs} PR${s.prs === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    step3 = panel('3. Every row checks out', { subtitle: `${summaryLine}. Each result is matched by Athlete ID, and saving adds them all at once.${st.session ? ` Added to ${st.session.name}.` : ''}` },
      how, confirmPanel,
      st.athletes.length > 6 ? h('div', { class: 'row wrap', style: 'gap:8px' }, h('div', { class: 'row wrap tm-views' }, filterBtns), findA) : null,
      cards, none, h('div', { class: 'row wrap' }, saveBtn, btn('Start over', () => { uploadState = null; render(); }, 'ghost')));
    syncSave(); applyFilter();
  }

  fill(main, header('Upload results', 'All or nothing: a sheet is saved only when every row matches a real Athlete ID and every value fits its test.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing')),
    step3 ?? h('div', { class: 'grid grid-2' }, step1, step2), recentPanel);
}

boot();

// ---------- Parent requests and one profile per athlete (owner) ----------
// Membership requests from the parent portal: the owner makes the change on the client page, then marks it done (or
// declines), and the parent is emailed. Nothing about billing changes by itself.
const REQUEST_WORDS = { switch: 'Switch plans', pause: 'Pause', cancel: 'Cancel' };
function requestLine(r) {
  return `${REQUEST_WORDS[r.kind] ?? r.kind}${r.kind === 'switch' && r.plan_name ? ` to ${r.plan_name}` : ''} · asked by ${r.guardian_name ?? 'a parent'} ${date(r.created_at)}`;
}
function resolveRequest(r, done) {
  const note = prompt(done ? 'Mark done. A note for the parent (optional):' : 'Decline. A note for the parent (optional):', '');
  if (note === null) return;
  return post(`/v1/membership-requests/${r.id}/resolve`, { status: done ? 'done' : 'declined', note: note || undefined }).then(() => { toast(done ? 'Marked done. The parent was emailed.' : 'Declined. The parent was emailed.'); render(); }).catch((e) => toast(e.message, 'warn'));
}
// Merge `fromId` into `keepId` after showing what happens.
async function mergeDialog(keepId, fromId) {
  const p = await get(`/v1/clients/${keepId}/merge-preview?from=${encodeURIComponent(fromId)}`);
  const d = document.getElementById('dialog');
  const side = (x, label) => h('div', { class: 'dp-panel stack-tight' }, h('span', { class: 'dp-label', style: 'margin:0' }, label), h('strong', null, x.name), h('span', { class: 'small muted' }, [x.athlete_id, x.birth_date ? `born ${x.birth_date}` : 'no birthday', x.family_name ?? 'no family', x.membership ?? 'no membership'].join(' · ')),
    h('span', { class: 'small muted' }, `${x.results} results · ${x.bookings} bookings · ${x.teams} teams · ${x.notes} notes`));
  fill(d, h('div', { class: 'stack' }, h('h2', { class: 'dp-panel-title' }, 'Merge two profiles'),
    h('div', { class: 'grid grid-2' }, side(p.keep, 'Keep this profile'), side(p.from, 'Move everything from this one')),
    p.problems.length ? h('div', { class: 'test-banner' }, p.problems.join(' ')) : h('p', { class: 'small' }, `Results, bookings, attendance, payments, notes, teams and device links move to ${p.keep.name} (${p.keep.athlete_id}). ${p.from.athlete_id} keeps finding them. The other profile is removed. This can't be undone and is written to the activity log.`),
    h('div', { class: 'row wrap', style: 'justify-content:flex-end' },
      p.problems.length ? null : btn('Merge', (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${keepId}/merge`, { from: fromId, confirm: true }); d.close(); toast('Merged into one profile.'); location.hash = `#/clients/${keepId}`; render(); }), 'primary'),
      btn('Close', () => d.close(), 'ghost'))));
  d.showModal();
}
function profilePanels(c, reqs, claims) {
  const open = reqs.filter((r) => r.status === 'open'), past = reqs.filter((r) => r.status !== 'open').slice(0, 3);
  const reqPanel = reqs.length ? panel('Requests from parents', { subtitle: 'Make the change above, then mark it done. The parent is emailed either way.' },
    open.map((r) => h('div', { class: 'list-item', style: 'flex-wrap:wrap' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, requestLine(r)), r.note ? h('span', { class: 'small muted', style: 'white-space:pre-wrap' }, `"${r.note}"`) : null),
      btn('Mark done', () => resolveRequest(r, true), 'outline'), btn('Decline', () => resolveRequest(r, false), 'ghost'))),
    past.map((r) => h('div', { class: 'list-item' }, h('span', { class: 'grow small muted' }, `${requestLine(r)} · ${r.status}${r.resolved_by ? ` by ${r.resolved_by}` : ''}${r.resolution_note ? `: ${r.resolution_note}` : ''}`)))) : null;
  const mine = claims.filter((k) => k.claimed_client_id === c.id || k.new_client_id === c.id);
  const search = h('input', { class: 'dp-input', placeholder: 'Name or Athlete ID of the other profile', 'aria-label': 'Find the other profile' });
  const results = h('div');
  search.addEventListener('input', debounce(async () => {
    const q = search.value.trim();
    if (q.length < 2) return fill(results);
    const { data } = await get(`/v1/clients?q=${encodeURIComponent(q)}&archived=all`);
    fill(results, data.filter((x) => x.id !== c.id).slice(0, 6).map((x) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, `${x.name} · ${x.athlete_id}${x.family?.name ? ` · ${x.family.name}` : ''}`), btn('Check', () => mergeDialog(c.id, x.id).catch((e) => toast(e.message, 'warn')), 'outline'))));
  }, 250));
  const mergePanel = panel('Same athlete, two profiles?', { subtitle: `Merge the other profile into ${c.name.split(' ')[0]}'s. Everything moves here, and the other Athlete ID keeps working.` },
    mine.map((k) => {
      const other = k.claimed_client_id === c.id ? { id: k.new_client_id, name: k.new_name, athlete_id: k.new_athlete_id } : { id: k.claimed_client_id, name: k.claimed_name, athlete_id: k.claimed_athlete_id };
      return h('div', { class: 'test-banner stack-tight' }, h('span', null, `${k.guardian_name ?? 'A parent'} gave ${k.athlete_id} when adding ${k.new_name ?? 'an athlete'} (${{ birthday: 'different birthday, same year', name: 'different name', no_birthday: 'no birthday on file to check', birth_year: 'different birth year', in_family: 'profile already in a family', archived: 'profile archived' }[k.reason] ?? 'no match'}).`),
        h('div', { class: 'row wrap' }, other.id ? btn(`Check merging ${other.name}`, () => mergeDialog(k.claimed_client_id, k.new_client_id).catch((e) => toast(e.message, 'warn')), 'outline') : null,
          btn('Not the same athlete', () => post(`/v1/profile-claims/${k.id}/dismiss`).then(() => { toast('Dismissed.'); render(); }), 'ghost')));
    }), search, results);
  return [reqPanel, mergePanel];
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
// Today (owner): open parent requests and profile checks, each linking to the client page.
async function parentRequestsPanel() {
  const [reqs, claims] = await Promise.all([get('/v1/membership-requests').catch(() => ({ data: [] })), get('/v1/profile-claims').catch(() => ({ data: [] }))]);
  if (!reqs.data.length && !claims.data.length) return null;
  return panel(`From parents (${reqs.data.length + claims.data.length})`, { subtitle: 'Membership requests to answer, and athletes who may have two profiles.' },
    reqs.data.map((r) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('a', { href: `#/clients/${r.client_id}`, class: 'strong', style: 'color:var(--steel)' }, r.client_name), h('span', { class: 'small muted' }, requestLine(r))))),
    claims.data.map((k) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('a', { href: `#/clients/${k.claimed_client_id}`, class: 'strong', style: 'color:var(--steel)' }, `${k.claimed_name} (${k.claimed_athlete_id})`),
      h('span', { class: 'small muted' }, `${k.guardian_name ?? 'A parent'} gave this Athlete ID when adding ${k.new_name ?? 'an athlete'}. Check and merge.`)))));
}
