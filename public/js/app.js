import { h, fill, toast, money, date, ago, badge, btn, busy, field, input, select, panel, videoEmbed, playIcon } from './ui.js';
import { saleForm } from './shop-admin.js';
import { initEngage, clientPanels, flagsPanel, rankingsPanel, readinessPanel, teamPanel, viewEducation } from './engage-coach.js';

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
const NAV_FOR = { owner: null, coach: ['today', 'schedule', 'sell', 'clients', 'leads', 'testing', 'programs', 'education'], front_desk: ['today', 'schedule', 'sell', 'clients', 'leads', 'testing', 'education'] };
let NAV = ALL_NAV;
const isOwner = () => state.user?.role === 'owner';
initEngage({ api, render, header, role: () => state.user?.role });

// ---------- Shell ----------
async function boot() {
  try { const me = await get('/auth/me'); state.user = me.user; state.roles = me.roles; state.testMode = me.test_mode; state.payments = me.payments || {}; } catch { state.user = null; }
  NAV = state.user ? ALL_NAV.filter(([k]) => !NAV_FOR[state.user.role] || NAV_FOR[state.user.role].includes(k)) : ALL_NAV;
  render();
}
window.addEventListener('hashchange', render);

function render() {
  if (!state.user) return renderLogin();
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
  'subscription.created': (d) => `${d.client_name} started ${d.plan_name}${d.status === 'trialing' ? ' (free trial)' : ''}`,
  'subscription.updated': (d) => d.previous_plan_name ? `${d.client_name} moved to ${d.plan_name}` : `${d.client_name}'s membership is now ${d.status.replace('_', ' ')}`,
  'invoice.paid': (d) => `Payment of ${money(d.amount_cents)} received from ${d.client_name}`,
  'invoice.payment_failed': (d) => `Payment of ${money(d.amount_cents)} failed for ${d.client_name}${d.final ? '. Membership canceled.' : ''}`,
  'program.assigned': (d) => `${d.client_name} started ${d.program_name}`,
  'workout.completed': (d) => `${d.client_name} finished ${d.workout_title} (${d.exercises_logged} of ${d.exercises_total} exercises)`,
  'sale.completed': (d) => `${d.client_name} paid ${money(d.amount_cents)} at ${d.location_name} (${METHOD_LABEL[d.method]})${d.sessions_added ? `, ${d.sessions_added} sessions added` : ''}`,
  'sale.failed': (d) => `${METHOD_LABEL[d.method]} payment of ${money(d.amount_cents)} from ${d.client_name} didn't go through`,
  'sale.refunded': (d) => `Refunded ${money(d.amount_cents)} to ${d.client_name}`,
  'stock.changed': (d) => `${d.product_name}${d.size ? ` (${d.size})` : ''}: ${{ received: `${d.delta} arrived`, count: 'counted', adjust: `${d.delta > 0 ? '+' : ''}${d.delta} adjusted` }[d.reason]}, ${d.on_hand} on hand`,
  'session.checked_in': (d) => `${d.client_name} checked in${d.location_name ? ` at ${d.location_name}` : ''}${d.covered_by === 'credit' ? ' (used a session)' : ''}`,
  'purchase.completed': (d) => `${d.client_name} got ${d.title} from the online store`,
  'spots.offered': (d) => `Open spots in ${d.session_name} offered to ${d.families} ${d.families === 1 ? 'family' : 'families'}`,
  'booking.created': (d) => `${d.client_name} booked ${d.session_name}${d.from_waitlist ? ' from the waitlist' : ''}${d.coverage === 'unpaid' ? ' (unpaid)' : ''}`,
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
  'results.recorded': (d) => `${d.count} test ${d.count === 1 ? 'result' : 'results'} recorded for ${d.athletes} ${d.athletes === 1 ? 'athlete' : 'athletes'}${d.source && d.source !== 'manual' ? ` (${d.source.replace(/^(csv|api):/, '')})` : ''}`,
  'performance.pr': (d) => `New PR: ${d.athlete_name}, ${d.test_name} ${fmtResult(d.value, d.unit, 2)}${d.side ? ` (${d.side === 'L' ? 'left' : 'right'})` : ''}`,
  'testing.shared': (d) => `${d.name} shared with families${d.families_notified ? ` (${d.families_notified} emailed)` : ''}`,
  'family.signed_up': (d) => `New family signed up: ${d.parent_name} with ${d.athletes.map((a) => a.name).join(', ')}`,
  'family.deletion_requested': (d) => `${d.requested_by} asked for the ${d.family_name}'s data to be deleted`,
  'family.deleted': (d) => `A family's data was deleted (${d.athletes} ${d.athletes === 1 ? 'athlete' : 'athletes'})`,
  'clients.imported': (d) => `${d.athletes} clients imported${d.filename ? ` from ${d.filename}` : ''}`,
  'queue.linked': (d) => `${d.count} waiting ${d.count === 1 ? 'result' : 'results'} linked to ${d.athlete_name} (${d.athlete_id})${d.remembered ? ', device remembered' : ''}`,
  'integration.synced': (d) => `${d.results} results synced from ${d.provider === 'hawkin' ? 'Hawkin Dynamics' : d.provider}`,
  'client.card_updated': (d) => d.card_last4 ? `${d.client_name} saved a card ending ${d.card_last4}` : `${d.client_name}'s saved card was removed`
};
const METHOD_LABEL = { tap_to_pay: 'Tap to Pay', reader: 'Front-desk reader', card_on_file: 'Card on file', cash: 'Cash', online: 'Pay link' };

async function viewToday(main) {
  const staff = state.user.role !== 'front_desk';
  const [d, rev, ag, flags, risk, spots] = await Promise.all([get('/v1/dashboard'), isOwner() ? get('/v1/reports/revenue') : null, get('/v1/agenda'), flagsPanel().catch(() => null), staff ? get('/v1/at-risk').catch(() => null) : null, staff ? get('/v1/open-spots').catch(() => null) : null]);
  tzName = ag.timezone;
  const agendaPanel = panel('Today\'s sessions', { subtitle: ag.sessions.length ? `${ag.sessions.reduce((t, x) => t + x.booked_count, 0)} athletes booked` : null, action: h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule' }, 'Full schedule') },
    ag.sessions.length ? ag.sessions.map(sessionRow) : h('p', { class: 'muted' }, 'Nothing on the schedule today.'));
  const m = d.metrics;
  const revPanel = !rev ? null : panel('Revenue by location', { subtitle: `This month. In-person sales plus ${money(rev.memberships_cents)} from ${rev.membership_payments} membership ${rev.membership_payments === 1 ? 'payment' : 'payments'}.`, action: h('a', { class: 'dp-btn dp-btn--primary', href: '#/sell' }, 'New sale') },
    rev.locations.length ? rev.locations.map((l) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, l.name), h('span', { class: 'small muted' }, `${l.sales} ${l.sales === 1 ? 'sale' : 'sales'}`), h('span', { style: 'font:600 22px/1 var(--font-display);min-width:96px;text-align:right' }, money(l.cents))))
      : h('p', { class: 'muted' }, 'Add your facility, parks and mobile location in Point of sale setup to track where you earn.'));
  const attention = d.attention.map((a) => {
    const link = h('a', { href: `#/clients/${a.client_id}`, class: 'strong', style: 'color:var(--steel)' }, a.name);
    if (a.kind === 'payment_failed') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, link, h('span', { class: 'small muted' }, `${money(a.amount_cents)} for ${a.plan_name} declined ${a.attempts}×. ${a.next_retry_at ? 'Auto-retry ' + date(a.next_retry_at) + '.' : ''}`)),
      btn('Retry charge', (e) => busy(e.currentTarget, async () => {
        const inv = await post(`/v1/invoices/${a.invoice_id}/retry`);
        inv.status === 'paid' ? toast(`Charge retried. ${a.name.split(' ')[0]} is paid up.`) : toast(`Charge declined again. Send ${a.name.split(' ')[0]} a billing link.`, 'warn');
        render();
      }), 'outline'));
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
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.count === 1 ? `${a.items[0].author ?? a.items[0].name} wrote back about ${a.items[0].name.split(' ')[0]}` : `${a.count} athletes have new replies`), h('span', { class: 'small muted' }, a.items.map((x) => `${x.name} (${x.count})`).join(' · '))),
      h('a', { class: 'dp-btn dp-btn--outline', href: `#/clients/${a.items[0].client_id}` }, 'Read'));
    if (a.kind === 'low_stock') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.count === 1 ? `${a.items[0].name} is running low` : `${a.count} items are running low`), h('span', { class: 'small muted' }, a.items.map((x) => `${x.name}: ${x.on_hand <= 0 ? 'out' : `${x.on_hand} left`}`).join(' · '))),
      h('a', { class: 'dp-btn dp-btn--outline', href: '#/sell/inventory' }, 'Inventory'));
    if (a.kind === 'results_waiting') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, `${a.count} test ${a.count === 1 ? 'result is' : 'results are'} waiting to be linked`), h('span', { class: 'small muted' }, `From ${a.groups} unrecognized ${a.groups === 1 ? 'athlete' : 'athletes'}. They stay out of every profile until you link them.`)),
      h('a', { class: 'dp-btn dp-btn--outline', href: '#/testing/queue' }, 'Link them'));
    if (a.kind === 'trial_ending') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, link, h('span', { class: 'small muted' }, `Free trial ends ${date(a.trial_ends_at)}. First charge ${money(a.amount_cents)}.`)),
      h('a', { class: 'dp-btn dp-btn--outline', href: `#/clients/${a.client_id}` }, 'View client'));
    if (a.kind === 'sale_pending') return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.name), h('span', { class: 'small muted' }, `${money(a.amount_cents)} ${METHOD_LABEL[a.method]} payment at ${a.location_name} is still waiting.`)),
      h('a', { class: 'dp-btn dp-btn--outline', href: '#/sell' }, 'Review'));
    return h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, link, h('span', { class: 'small muted' }, `No workout logged since ${date(a.last_workout_at)}.`)),
      h('a', { class: 'dp-btn dp-btn--outline', href: `#/clients/${a.client_id}` }, 'Check in'));
  });
  fill(main, 
    header('Today', isOwner() ? `Revenue, clients and anything that needs a decision. ${money(d.today_sales.cents)} in person today.` : `Hi ${state.user.name.split(' ')[0]}. Today's sessions and anything that needs you.`, addClientBtn()),
    !isOwner() ? h('div', { class: 'metrics' },
      metric('Active clients', m.paying_clients + m.trialing_clients, `${m.trialing_clients} on free trial`),
      metric('Sessions today', ag.sessions.length, `${ag.sessions.reduce((t, x) => t + x.booked_count, 0)} athletes booked`),
      metric('Workouts logged', m.workouts_last_7_days, 'Last 7 days', m.workouts_last_7_days ? 'good' : null)) :
    h('div', { class: 'metrics' },
      metric('Monthly recurring revenue', money(m.mrr_cents + d.teams.monthly_cents), d.teams.active_contracts ? `${money(m.mrr_cents)} memberships · ${money(d.teams.monthly_cents)} teams` : `${m.paying_clients} paying ${m.paying_clients === 1 ? 'client' : 'clients'}`),
      metric('Active clients', m.paying_clients + m.trialing_clients, `${m.trialing_clients} on free trial`),
      metric('Payments failed', m.past_due_clients, `${money(m.at_risk_cents)} at risk this month`, m.past_due_clients ? 'warn' : null),
      metric('Workouts logged', m.workouts_last_7_days, 'Last 7 days', m.workouts_last_7_days ? 'good' : null)),
    agendaPanel,
    spots?.data.length ? spotsPanel(spots) : null,
    flags,
    risk?.data.length ? panel('Athletes to check on', { subtitle: 'Coming less, nothing booked, or other signs they may be drifting away. A quick message usually brings them back.' },
      risk.data.slice(0, 6).map((r) => h('div', { class: 'list-item' },
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, r.name, r.family_name ? h('span', { class: 'small muted' }, ` · ${r.family_name}`) : null), h('span', { class: 'small muted' }, r.reasons.join(' · '))),
        h('a', { class: 'dp-btn dp-btn--outline', href: `#/clients/${r.client_id}` }, 'Check in')))) : null,
    h('div', { class: 'grid grid-2' },
      panel('Needs your attention', {}, attention.length ? attention : h('p', { class: 'muted' }, 'Nothing waiting. Every client is paid up and training.')),
      panel('Recent activity', {}, d.activity.length ? d.activity.map((ev) => h('div', { class: 'list-item' },
        h('div', { class: 'small muted', style: 'width:92px;flex-shrink:0' }, ago(ev.created_at)),
        h('div', { class: 'grow' }, (EVENT_TEXT[ev.type] || (() => ev.type))(ev.data)))) : h('p', { class: 'muted' }, 'Activity shows up here as clients join, pay and train.'))),
    revPanel);
}

// Classes in the next 2 days with open spots and nobody waiting. One tap offers the spots to families who fit.
function spotsPanel(spots) {
  const auto = spots.mode === 'auto';
  const mode = isOwner() ? select([['suggest', 'Send offers when I tap'], ['auto', 'Send offers automatically'], ['off', 'Don\'t show this']], { value: spots.mode, 'aria-label': 'Open spot offers', style: 'width:auto' }) : null;
  if (mode) mode.addEventListener('change', () => busy(mode, async () => { await patch('/v1/settings', { open_spot_offers: mode.value }); toast(mode.value === 'auto' ? 'Offers go out on their own between 10 am and 7 pm.' : 'Saved.'); render(); }));
  return panel('Classes with open spots', { subtitle: auto ? 'Offers go out on their own between 10 am and 7 pm, a day ahead. First family to tap the link gets the spot.' : 'Offer the spots to families who fit: regulars of the class first, then members and recent athletes. First to tap the link gets it.', action: mode },
    spots.data.map((x) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('a', { href: `#/schedule/${x.id}`, class: 'strong', style: 'color:var(--steel)' }, x.name),
        h('span', { class: 'small muted' }, `${new Intl.DateTimeFormat('en-US', { timeZone: tzName, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(x.starts_at))} · ${x.location_name} · ${x.spots_left} of ${x.capacity} open`),
        h('span', { class: 'small muted' }, [x.offers.sent ? `${x.offers.sent} offered, ${x.offers.opened} opened, ${x.offers.booked} booked` : null, x.families_who_fit ? `${x.families_who_fit} more ${x.families_who_fit === 1 ? 'family fits' : 'families fit'}` : 'No more families who fit'].filter(Boolean).join(' · '))),
      x.families_who_fit ? btn(`Offer to ${Math.min(x.families_who_fit, x.spots_left * 4, 30)} ${Math.min(x.families_who_fit, x.spots_left * 4, 30) === 1 ? 'family' : 'families'}`, (e) => busy(e.currentTarget, async () => {
        const r = await post(`/v1/sessions/${x.id}/offer-spots`); toast(`Offered to ${r.sent} ${r.sent === 1 ? 'family' : 'families'}. First to tap gets it.`); render();
      }), 'outline') : null)));
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

const LOAD_LIFT = { squat_1rm: 'back squat', bench_1rm: 'bench press', power_clean_1rm: 'power clean' };
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
async function viewClients(main) {
  const { data } = await get('/v1/clients');
  const q = input({ type: 'search', placeholder: 'Name, athlete ID, email or family', id: 'client-search', 'aria-label': 'Search clients' });
  const status = select([['', 'All statuses'], ['active', 'Active'], ['trialing', 'Trial'], ['past_due', 'Past due'], ['paused', 'Paused'], ['canceled', 'Canceled'], ['none', 'No plan']], { 'aria-label': 'Filter by status', style: 'width:180px' });
  const body = h('tbody');
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const rows = data.filter((c) => (!s || c.name.toLowerCase().includes(s) || (c.email ?? '').includes(s) || (c.family?.name ?? '').toLowerCase().includes(s)) && (!status.value || c.status === status.value));
    fill(body, ...(rows.length ? rows.map((c) => h('tr', { class: 'link', tabindex: '0', onClick: () => (location.hash = `#/clients/${c.id}`), onKeydown: (e) => { if (e.key === 'Enter') location.hash = `#/clients/${c.id}`; } },
      h('td', null, h('div', { class: 'stack-tight' }, h('span', { class: 'strong' }, c.name), h('span', { class: 'small muted' }, h('span', { style: 'font-family:var(--font-mono)' }, c.athlete_id ?? ''), ` · ${c.family ? c.family.name : c.email ?? ''}`))),
      h('td', null, c.subscription?.plan_name ?? '—'),
      h('td', null, badge(c.status)),
      h('td', null, c.program?.name ?? h('span', { class: 'muted' }, 'None')),
      h('td', { class: 'muted' }, ago(c.last_workout_at))))
      : [h('tr', null, h('td', { colspan: '5', class: 'muted' }, data.length ? 'No clients match. Clear the search or filter.' : 'No clients yet. Add your first one.'))]));
  };
  q.addEventListener('input', draw); status.addEventListener('change', draw); draw();
  fill(main, 
    header('Clients', `${data.length} accounts, their plans and programs.`, h('div', { class: 'row' }, state.user.role !== 'front_desk' ? h('a', { class: 'dp-btn dp-btn--secondary', href: '#/clients/import' }, 'Import from a spreadsheet') : null, addClientBtn())),
    panel(null, {}, h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: 'min-width:200px' }, q), status),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Client', 'Plan', 'Status', 'Program', 'Last workout'].map((t) => h('th', null, t)))), body))));
}

async function viewClient(main, id) {
  if (id === 'new') return viewNewClient(main);
  if (id === 'import') return viewImport(main);
  const [c, plans, progs, inv, logs, locs, sales, visits, upcoming, settings, perfData, devLinks] = await Promise.all([get(`/v1/clients/${id}`), get('/v1/plans'), get('/v1/programs'), get(`/v1/clients/${id}/invoices`), get(`/v1/clients/${id}/workouts`), get('/v1/locations'), get(`/v1/sales?client_id=${id}`), get(`/v1/check-ins?client_id=${id}`), get(`/v1/clients/${id}/bookings`), get('/v1/settings'), get(`/v1/clients/${id}/performance`), get(`/v1/athlete-links?client_id=${id}`)]);
  const [en, testLib, owed, products, badgeLib] = await Promise.all([get(`/v1/clients/${id}/engagement`), get('/v1/tests'), isOwner() ? get(`/v1/clients/${id}/owed`) : null, isOwner() ? get('/v1/products') : null, get('/v1/skill-badges')]);
  const eng = clientPanels(c, en, testLib.data, badgeLib.data);
  tzName = settings.timezone;
  const fam = c.family;
  const sub = c.subscription;
  const first = c.name.split(' ')[0];
  const act = (path, msg, body) => (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/subscription/${path}`, body); toast(msg); render(); });

  const planSel = select(plans.data.map((p) => [p.id, `${p.name}, ${money(p.price_cents)}/mo`]), { value: sub?.plan_id, 'aria-label': 'Plan' });
  const membership = panel('Membership', { subtitle: sub ? null : 'No active plan.' },
    sub ? h('dl', { class: 'dl' },
      h('div', null, h('dt', null, 'Status'), h('dd', null, badge(sub.status))),
      h('div', null, h('dt', null, 'Plan'), h('dd', null, sub.plan_name)),
      h('div', null, h('dt', null, 'Monthly'), h('dd', null, money(sub.price_cents))),
      h('div', null, h('dt', null, sub.status === 'trialing' ? 'Trial ends' : 'Next charge'), h('dd', null, ['canceled', 'paused'].includes(sub.status) ? '—' : date(sub.current_period_end)))) : null,
    sub && sub.status !== 'canceled' ? h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, planSel), btn('Change plan', (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/subscription/plan`, { plan_id: planSel.value }); toast('Plan changed. New price applies from the next charge.'); render(); }), 'secondary')),
      h('div', { class: 'row wrap' },
        sub.status === 'paused' ? btn('Resume subscription', act('resume', 'Subscription resumed and charged.')) : btn('Pause subscription', act('pause', 'Subscription paused. No charges and no app access until resumed.'), 'secondary'),
        btn('Cancel subscription', (e) => { if (confirm(`Cancel ${first}'s subscription now? Open invoices will be voided.`)) act('cancel', 'Subscription canceled.')(e); }, 'ghost')))
      : h('div', { class: 'row' }, h('div', { class: 'grow' }, planSel), btn('Start subscription', (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/subscription`, { plan_id: planSel.value }); toast('Subscription started.'); render(); }))));

  const payments = panel('Payments', {}, inv.data.length ? inv.data.map((i) => h('div', { class: 'list-item' },
    h('div', { class: 'grow stack-tight' }, h('span', null, `${money(i.amount_cents)} · ${date(i.period_start)} to ${date(i.period_end)}`), i.last_error && i.status === 'failed' ? h('span', { class: 'small warn-text' }, `${i.last_error} Tried ${i.attempts}×.`) : null),
    badge(i.status),
    i.status === 'failed' ? btn('Retry charge', (e) => busy(e.currentTarget, async () => { const r = await post(`/v1/invoices/${i.id}/retry`); r.status === 'paid' ? toast('Charge retried. Payment succeeded.') : toast('Charge declined again.', 'warn'); render(); }), 'outline') : null))
    : h('p', { class: 'muted' }, sub?.status === 'trialing' ? `No charges yet. The first charge happens when the trial ends on ${date(sub.trial_ends_at)}.` : 'No invoices yet.'));

  const payLinks = owed ? payLinksPanel(id, first, owed, products.data, render) : null;

  const progSel = select([['', 'Choose a program'], ...progs.data.map((p) => [p.id, p.name])], { value: c.program?.id ?? '', 'aria-label': 'Program' });
  const appUrl = location.origin + c.app_link;
  const training = panel('Training', { subtitle: c.program ? `On ${c.program.name}. ${c.workouts_completed} ${c.workouts_completed === 1 ? 'workout' : 'workouts'} logged.` : 'No program assigned yet.' },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, progSel), btn(c.program ? 'Switch program' : 'Assign program', (e) => busy(e.currentTarget, async () => {
      if (!progSel.value) throw new Error('Choose a program first.');
      await post(`/v1/programs/${progSel.value}/assign`, { client_id: id }); toast(`Program assigned to ${first}.`); render();
    }), 'secondary')),
    h('div', { class: 'stack-tight' }, h('span', { class: 'dp-label' }, 'Private app link'), h('span', { class: 'small muted' }, `Send this to ${first}. Anyone with the link can see their workouts.`)),
    h('div', { class: 'row wrap' },
      btn('Copy app link', async () => { await navigator.clipboard.writeText(appUrl); toast('App link copied.'); }, 'outline'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: c.app_link, target: '_blank', rel: 'noopener' }, 'Open app'),
      btn('Reset link', (e) => { if (confirm('Issue a new link? The current one stops working.')) busy(e.currentTarget, async () => { await post(`/v1/clients/${id}/app-link`); toast('New app link issued.'); render(); }); }, 'ghost')),
    logs.data.length ? h('div', null, logs.data.slice(0, 5).map((l) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, `${l.workout_title} · week ${l.week}, day ${l.day}`), h('span', { class: 'muted' }, ago(l.completed_at))))) : null);

  const name = input({ value: c.name }), email = input({ type: 'email', value: c.email ?? '' }), phone = input({ value: c.phone ?? '' });
  const pf = { sex: select([['', 'Not set'], ['M', 'Male'], ['F', 'Female']], { value: c.sex ?? '' }), athlete_id: input({ value: c.athlete_id ?? '', style: 'font-family:var(--font-mono);text-transform:uppercase' }), birth_date: input({ type: 'date', value: c.birth_date ?? '' }), sport: input({ value: c.sport ?? '' }), position: input({ value: c.position ?? '' }), school: input({ value: c.school ?? '' }), grad_year: input({ type: 'number', value: c.grad_year ?? '' }),
    emergency_name: input({ value: c.emergency_name ?? '' }), emergency_phone: input({ value: c.emergency_phone ?? '' }) };
  const medical = h('textarea', { class: 'dp-input' }); medical.value = c.medical_notes ?? '';
  const notes = h('textarea', { class: 'dp-input' }); notes.value = c.notes ?? '';
  const account = panel('Profile', {},
    h('div', { class: 'form-grid' }, field('Full name', name), field(fam ? 'Athlete email (optional)' : 'Email', email), field('Phone', phone), field('Birthday', pf.birth_date)),
    h('div', { class: 'form-grid' }, field('Athlete ID', pf.athlete_id, 'Connects every result, file and device to this athlete.'), field('Sex', pf.sex, 'Only used for growth-spurt estimates.')),
    h('div', { class: 'form-grid' }, field('Sport', pf.sport), field('Position', pf.position), field('School', pf.school), field('Grad year', pf.grad_year)),
    field('Medical notes', medical, 'Parents can update these in the portal.'),
    h('div', { class: 'form-grid' }, field('Emergency contact', pf.emergency_name), field('Emergency phone', pf.emergency_phone)),
    field('Coach notes', notes, 'Only coaches see these.'),
    h('div', { class: 'row' }, btn('Save changes', (e) => busy(e.currentTarget, async () => {
      await patch(`/v1/clients/${id}`, { name: name.value, email: email.value || null, phone: phone.value, notes: notes.value, medical_notes: medical.value, ...Object.fromEntries(Object.entries(pf).filter(([k, el]) => k !== 'athlete_id' || el.value.toUpperCase() !== c.athlete_id).map(([k, el]) => [k, k === 'grad_year' ? (el.value ? Number(el.value) : null) : el.value || null])) });
      toast('Changes saved.'); render();
    }))),
    state.testMode ? h('div', { class: 'row wrap small' }, h('span', { class: 'grow muted' }, `Test card: ${c.card_status === 'declining' ? 'declines every charge' : 'charges succeed'}.`),
      btn(c.card_status === 'declining' ? 'Make card succeed' : 'Make card decline', (e) => busy(e.currentTarget, async () => { await patch(`/v1/clients/${id}`, { card_status: c.card_status === 'declining' ? 'ok' : 'declining' }); render(); }), 'ghost')) : null);

  const card = c.card.on_file
    ? h('div', { class: 'row wrap' }, h('span', { class: 'grow' }, `${(c.card.brand || 'Card').replace(/^./, (x) => x.toUpperCase())} ending ${c.card.last4 ?? '••••'}`),
        btn('Remove card', (e) => { if (confirm('Remove the saved card? Membership renewals will fail until a new card is added.')) busy(e.currentTarget, async () => { await del(`/v1/clients/${id}/card`); toast('Card removed.'); render(); }); }, 'ghost'))
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
  const sessionsPanel = panel('Card & sessions', { subtitle: `${member ? `${first} is a member (group classes included). ` : ''}${c.credits.group} group and ${c.credits.private} private ${c.credits.private === 1 ? 'session' : 'sessions'} left.${c.card.owner === 'family' ? ' Card belongs to the family.' : ''}` },
    card, cardActions,
    locs.data.length ? h('div', { class: 'row' }, h('div', { class: 'grow' }, locSel), btn('Walk-in check-in', (e) => busy(e.currentTarget, async () => {
      // Members and athletes with group credits use a group session; otherwise a private credit.
      const r = await post(`/v1/clients/${id}/check-ins`, { location_id: locSel.value, credit_type: member || c.credits.group > 0 ? 'group' : 'private' });
      toast(r.covered_by === 'membership' ? `${first} checked in.` : `${first} checked in. ${r.credits_left} ${r.credit_type} ${r.credits_left === 1 ? 'session' : 'sessions'} left.`); render();
    }), 'secondary')) : h('p', { class: 'small muted' }, 'Add a location in Point of sale setup to check clients in.'),
    h('div', { class: 'row wrap' }, h('a', { class: 'dp-btn dp-btn--primary', href: `#/sell?client=${id}` }, 'Sell to ' + first),
      btn('Adjust sessions', (e) => {
        const t = prompt('Which kind? Type "group" or "private".', 'group'); if (!t) return;
        const type = t.trim().toLowerCase(); if (!['group', 'private'].includes(type)) return toast('Type group or private.', 'warn');
        const a = prompt(`Add or remove ${type} sessions (e.g. 2 or -1):`, '1'); if (!a) return;
        busy(e.currentTarget, async () => { const r = await post(`/v1/clients/${id}/credits`, { delta: Number(a), credit_type: type, note: 'Coach adjustment' }); toast(`${r.balance} ${type} sessions left.`); render(); });
      }, 'ghost')),
    sales.data.length || visits.data.length ? h('div', null,
      ...sales.data.slice(0, 4).map((x) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, `${x.description ?? 'Sale'} · ${x.location_name}`), badge(x.status), h('span', { class: 'muted' }, money(x.amount_cents)))),
      ...visits.data.slice(0, 4).map((k) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, `Checked in at ${k.location_name}`), h('span', { class: 'muted' }, ago(k.created_at))))) : null);

  const gName = input(), gEmail = input({ type: 'email' }), gPhone = input({ type: 'tel' });
  const sibName = input(), sibBirth = input({ type: 'date' });
  const famData = fam && isOwner() ? h('div', { class: 'row wrap small', style: 'gap:8px' },
    btn('Download family data', (e) => busy(e.currentTarget, () => download(`/v1/families/${fam.id}/export`)), 'ghost'),
    btn('Delete family data', (e) => {
      const typed = prompt(`This deletes the ${fam.name}'s personal information: parents, athletes' profiles, medical notes, test results and cards. Payment records stay for your accounts, with no names. It can't be undone.\n\nType the family name to confirm: ${fam.name}`);
      if (!typed) return;
      busy(e.currentTarget, async () => { await del(`/v1/families/${fam.id}`, { confirm: typed }); toast('Family data deleted.'); location.hash = '#/clients'; });
    }, 'ghost')) : null;
  const familyPanel = fam ? panel(fam.name, { subtitle: fam.waiver.signed ? `Waiver signed ${date(fam.waiver.signed_at)} by ${fam.waiver.signed_by?.split(' <')[0]}` : 'Waiver not signed yet. Parents sign it in the portal before booking.' },
      ...fam.guardians.map((g) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, g.name, g.is_primary ? h('span', { class: 'small muted' }, ' (primary)') : null), h('span', { class: 'small muted' }, [g.email, g.phone, { on: 'Gets texts', stopped: 'Replied STOP to texts' }[g.texts]].filter(Boolean).join(' · '))),
        btn('Copy portal link', async () => { await navigator.clipboard.writeText(`${location.origin}/parent`).catch(() => {}); toast(`Portal link copied. ${g.name.split(' ')[0]} signs in with ${g.email}.`); }, 'ghost'))),
      fam.siblings.length ? h('p', { class: 'small' }, 'Siblings: ', ...fam.siblings.map((x, i) => [i ? ', ' : '', h('a', { href: `#/clients/${x.id}` }, x.name)])) : null,
      famData,
      h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:32px' }, 'Add sibling or parent'),
        h('form', { class: 'row wrap', style: 'margin-top:8px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { const x = await post(`/v1/families/${fam.id}/athletes`, { name: sibName.value, birth_date: sibBirth.value || undefined }); toast(`${x.name} added to ${fam.name}.`); location.hash = `#/clients/${x.id}`; }); } },
          h('div', { class: 'grow' }, field('Sibling name', sibName)), field('Birthday', sibBirth), h('div', { style: 'align-self:flex-end' }, btn('Add sibling', null, 'secondary', { type: 'submit' }))),
        h('form', { class: 'row wrap', style: 'margin-top:8px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { await post(`/v1/families/${fam.id}/guardians`, { name: gName.value, email: gEmail.value, phone: gPhone.value || undefined }); toast('Parent added.'); render(); }); } },
          h('div', { class: 'grow' }, field('Parent name', gName)), field('Email', gEmail), field('Phone', gPhone), h('div', { style: 'align-self:flex-end' }, btn('Add parent', null, 'secondary', { type: 'submit' })))))
    : null;
  const bookingsPanel = panel('Upcoming sessions', { action: h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule' }, 'Schedule') },
    upcoming.data.length ? upcoming.data.slice(0, 8).map((b) => h('a', { class: 'list-item small', href: `#/schedule/${b.session_id}`, style: 'text-decoration:none;color:inherit' },
      h('span', { class: 'grow' }, `${tzFmt(b.starts_at, { weekday: 'short', month: 'short', day: 'numeric' })} ${timeOf(b.starts_at)} · ${b.session_name}`), b.status === 'waitlisted' ? h('span', { class: 'dp-badge dp-badge--neutral' }, 'Waitlist') : coverBadge(b.coverage)))
      : h('p', { class: 'muted small' }, 'Nothing booked.'));
  const headline = perfData.data.filter((p) => p.headline && p.better !== 'none');
  const perfPanel = panel('Testing', { subtitle: headline.length ? 'Best result and change since the first test.' : null, action: headline.length ? h('a', { class: 'dp-btn dp-btn--secondary', href: `/report.html?client=${id}`, target: '_blank' }, 'Progress report') : h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing days') },
    headline.length ? headline.slice(0, 12).map((p) => h('div', { class: 'list-item small' },
      h('span', { class: 'grow' }, `${p.test_name}${p.side ? ` (${p.side})` : ''}`),
      h('span', { class: 'strong' }, fmtResult(p.best, p.unit, p.decimals)),
      p.tests_count > 1 ? h('span', { class: p.improved ? 'good-text' : 'muted', style: 'min-width:84px;text-align:right' }, `${p.change > 0 ? '+' : ''}${fmtResult(p.change, p.unit, p.decimals, { delta: true })}`) : h('span', { class: 'muted', style: 'min-width:84px;text-align:right' }, 'first test')))
      : h('p', { class: 'muted small' }, 'No test results yet.'),
    devLinks.data.length ? h('p', { class: 'small muted' }, 'Linked devices: ', devLinks.data.map((l) => `${l.provider} ${l.external_id.replace(/^name:/, 'name ')}`).join(', ')) : null);
  const age = c.birth_date ? Math.floor((Date.now() - Date.parse(c.birth_date)) / (365.25 * 86400000)) : null;

  fill(main,
    header(h('span', { class: 'row', style: 'gap:12px;align-items:center' }, c.name, idChip(c.athlete_id)), [age != null ? `Age ${age}` : null, c.sport, c.position, c.email, `client since ${date(c.created_at)}`].filter(Boolean).join(' · '), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/clients' }, 'All clients')),
    c.medical_notes ? h('div', { class: 'test-banner', role: 'note' }, `Medical: ${c.medical_notes}${c.emergency_name ? ` · Emergency: ${c.emergency_name} ${c.emergency_phone ?? ''}` : ''}`) : null,
    h('div', { class: 'grid grid-2' }, h('div', { class: 'stack', style: 'gap:24px' }, familyPanel, eng.accountability, eng.goals, membership, sessionsPanel, payments, payLinks), h('div', { class: 'stack', style: 'gap:24px' }, bookingsPanel, eng.messages, perfPanel, eng.targets, eng.badges, eng.education, training, account)));
}

async function viewNewClient(main) {
  const [plans, progs] = await Promise.all([get('/v1/plans'), get('/v1/programs')]);
  const isAthlete = h('input', { type: 'checkbox', checked: true, id: 'is-athlete' });
  const name = input({ autocomplete: 'off', required: true }), email = input({ type: 'email', autocomplete: 'off' }), phone = input();
  const birth = input({ type: 'date' }), sport = input(), school = input();
  const pName = input(), pEmail = input({ type: 'email' }), pPhone = input({ type: 'tel' });
  const plan = select([['', 'No subscription yet'], ...plans.data.map((p) => [p.id, `${p.name}, ${money(p.price_cents)}/mo${p.trial_days ? `, ${p.trial_days}-day trial` : ''}`])], { value: '' });
  const prog = select([['', 'Assign later'], ...progs.data.map((p) => [p.id, p.name])], { value: '' });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  const submit = btn('Create account', null, 'primary', { type: 'submit' });
  const parentBox = h('div', { class: 'stack' }, h('div', { class: 'dp-label' }, 'Parent or guardian (pays and signs in to the parent portal)'),
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('Parent name', pName), field('Parent email', pEmail), field('Parent phone', pPhone)));
  const athleteBox = h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('Birthday', birth), field('Sport', sport), field('School', school));
  const emailField = field('Email', email), phoneField = field('Phone (optional)', phone);
  const sync = () => { parentBox.style.display = athleteBox.style.display = isAthlete.checked ? '' : 'none'; emailField.style.display = phoneField.style.display = isAthlete.checked ? 'none' : ''; };
  isAthlete.addEventListener('change', sync);
  fill(main,
    header('New client', 'Creates the account, the parent login, the plan and the program in one step.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/clients' }, 'Cancel')),
    h('form', { class: 'dp-panel', style: 'max-width:760px', onSubmit: (e) => {
      e.preventDefault(); err.textContent = '';
      busy(submit, async () => {
        try {
          const body = { name: name.value, plan_id: plan.value || undefined, program_id: prog.value || undefined };
          if (isAthlete.checked) Object.assign(body, { birth_date: birth.value || undefined, sport: sport.value || undefined, school: school.value || undefined, parent: { name: pName.value, email: pEmail.value, phone: pPhone.value || undefined } });
          else Object.assign(body, { email: email.value, phone: phone.value || undefined });
          const c = await post('/v1/clients', body);
          toast(isAthlete.checked ? `${c.name.split(' ')[0]} added. ${pName.value.split(' ')[0]} can sign in at ${location.origin}/parent with ${pEmail.value}.` : `Account created for ${c.name.split(' ')[0]}.`);
          location.hash = `#/clients/${c.id}`;
        } catch (x) { err.textContent = x.message; }
      });
    } },
      h('label', { class: 'row', style: 'gap:10px;min-height:44px' }, isAthlete, h('span', null, 'Athlete with a parent who pays')),
      h('div', { class: 'form-grid' }, field('Full name', name), emailField, phoneField),
      athleteBox, parentBox,
      h('div', { class: 'form-grid' }, field('Subscription plan', plan, 'With a trial, the first charge happens when it ends.'), field('Starting program', prog)),
      h('p', { class: 'small muted' }, 'Adding a sibling? Open the brother or sister and use "Add sibling" instead, so the family shares one login and card.'),
      err, h('div', { class: 'row' }, submit)));
  sync(); name.focus();
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
  const pick = input({ type: 'date', 'aria-label': 'Day to check', value: new Date(Date.now() - 86400000).toISOString().slice(0, 10), style: 'width:170px' });
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

async function viewBilling(main) {
  const [plans, inv, links, checks] = await Promise.all([get('/v1/plans?include_inactive=true'), get('/v1/invoices'), get('/v1/pay-links'), get('/v1/money-checks')]);
  const pname = input(), price = input({ type: 'number', min: '0', step: '1', inputmode: 'decimal' }), trial = input({ type: 'number', min: '0', max: '90', value: '7' });
  const addPlan = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    await post('/v1/plans', { name: pname.value, price_cents: Math.round(Number(price.value) * 100), trial_days: Number(trial.value) }); toast('Plan created.'); render();
  }); } }, h('div', { class: 'form-grid', style: 'grid-template-columns:2fr 1fr 1fr' }, field('Plan name', pname), field('Monthly price ($)', price), field('Trial days', trial)), h('div', null, btn('Create plan', null, 'secondary', { type: 'submit' })));

  const plansPanel = panel('Plans', { subtitle: 'Price changes apply from each client\'s next charge.' },
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Plan', 'Price', 'Trial', 'Clients', 'Monthly revenue', ''].map((t) => h('th', null, t)))),
      h('tbody', null, plans.data.map((p) => h('tr', null,
        h('td', { class: 'strong' }, p.name, p.active ? null : h('span', { class: 'small muted' }, ' (retired)')),
        h('td', null, `${money(p.price_cents)} / mo`), h('td', null, p.trial_days ? `${p.trial_days} days` : 'None'), h('td', null, p.subscribers),
        h('td', { style: 'font:600 22px/1 var(--font-display)' }, money(p.subscribers * p.price_cents)),
        h('td', null, btn(p.active ? 'Retire' : 'Offer again', (e) => busy(e.currentTarget, async () => { await patch(`/v1/plans/${p.id}`, { active: !p.active }); toast(p.active ? 'Plan retired. Current clients keep it.' : 'Plan offered again.'); render(); }), 'ghost'))))))),
    addPlan);

  const filter = select([['', 'All invoices'], ['failed', 'Failed'], ['paid', 'Paid'], ['open', 'Open'], ['void', 'Void']], { 'aria-label': 'Filter invoices', style: 'width:160px' });
  const tbody = h('tbody');
  const draw = () => fill(tbody, ...inv.data.filter((i) => !filter.value || i.status === filter.value).map((i) => h('tr', null,
    h('td', null, h('a', { href: `#/clients/${i.client_id}`, style: 'color:var(--steel)', class: 'strong' }, i.client_name)), h('td', null, i.plan_name), h('td', null, money(i.amount_cents)),
    h('td', { class: 'muted' }, date(i.created_at)), h('td', null, badge(i.status)),
    h('td', null, i.status === 'failed' ? h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
      btn('Retry charge', (e) => busy(e.currentTarget, async () => { const r = await post(`/v1/invoices/${i.id}/retry`); r.status === 'paid' ? toast('Payment succeeded.') : toast('Declined again.', 'warn'); render(); }), 'outline'),
      btn('Send pay link', (e) => busy(e.currentTarget, async () => { const l = await post('/v1/pay-links', { kind: 'invoice', invoice_id: i.id, send: true }); toast(sentText(l)); render(); }), 'ghost')) : null))));
  filter.addEventListener('change', draw); draw();

  const asOf = input({ type: 'date', value: new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10) });
  const testPanel = state.testMode ? panel('Billing clock (test mode)', { subtitle: 'Billing runs hourly on its own. Run it for a future date to see trials convert, renewals charge and retries happen.' },
    h('div', { class: 'row wrap' }, h('div', { style: 'width:200px' }, field('Run as of', asOf)),
      h('div', { style: 'align-self:flex-end' }, btn('Run billing', (e) => busy(e.currentTarget, async () => {
        const r = await post('/v1/billing/run', { as_of: asOf.value });
        toast(`Billing run: ${r.renewed} renewed, ${r.paid} paid, ${r.failed} failed, ${r.retried} retried.`, r.failed ? 'warn' : 'good'); render();
      }), 'secondary')))) : null;

  fill(main, 
    header('Billing', 'Plans, invoices and failed payments.'),
    checks.needs_look ? moneyChecksPanel(checks, render) : null,
    plansPanel,
    panel('Pay links', { subtitle: 'Links a family taps to pay by card without signing in. Make one from a client\'s page; failed membership payments get one automatically.' },
      links.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['For', 'Client', 'Amount', 'Sent', 'Status', ''].map((t) => h('th', null, t)))),
        h('tbody', null, links.data.slice(0, 25).map((l) => h('tr', null, h('td', null, l.description), h('td', null, l.client_id ? h('a', { href: `#/clients/${l.client_id}`, style: 'color:var(--steel)' }, l.client_name) : '—'),
          h('td', null, money(l.amount_cents)), h('td', { class: 'muted small' }, l.sent_at ? ago(l.sent_at) : l.created_by === 'Automatic' ? 'With the failed-payment email' : 'Not sent'),
          h('td', null, badge(l.paid_at ? 'paid' : l.status)), h('td', null, l.status === 'open' ? payLinkActions(l, render) : null)))))) : h('p', { class: 'muted' }, 'No pay links yet.')),
    panel('Invoices', { action: filter }, inv.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Client', 'Plan', 'Amount', 'Date', 'Status', ''].map((t) => h('th', null, t)))), tbody)) : h('p', { class: 'muted' }, 'No invoices yet. They appear when trials end and memberships renew.')),
    checks.needs_look ? null : moneyChecksPanel(checks, render),
    testPanel);
}

// ---------- Programs ----------
async function viewPrograms(main) {
  const [progs, exs, shop] = await Promise.all([get('/v1/programs'), get('/v1/exercises'), isOwner() ? get('/v1/shop') : null]);
  const name = input(), weeks = input({ type: 'number', min: '1', max: '52', value: '8' }), level = select([['Beginner', 'Beginner'], ['Intermediate', 'Intermediate'], ['Advanced', 'Advanced'], ['All levels', 'All levels']]);
  const create = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const p = await post('/v1/programs', { name: name.value, weeks: Number(weeks.value), level: level.value }); toast('Program created. Add its first workout.'); location.hash = `#/programs/${p.id}`;
  }); } }, h('div', { class: 'form-grid', style: 'grid-template-columns:2fr 1fr 1fr' }, field('Program name', name), field('Weeks', weeks), field('Level', level)), h('div', null, btn('Create program', null, 'primary', { type: 'submit' })));

  const exName = input(), exUrl = input({ type: 'url', placeholder: 'https://youtube.com/watch?v=…' }), exCue = input({ placeholder: 'One or two coaching cues' });
  const addEx = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    await post('/v1/exercises', { name: exName.value, video_url: exUrl.value || undefined, instructions: exCue.value || undefined }); toast('Exercise added to the library.'); render();
  }); } }, h('div', { class: 'form-grid' }, field('Exercise name', exName), field('Demo video link', exUrl, 'YouTube, Vimeo or a direct .mp4 link.')), field('Coaching cues', exCue), h('div', null, btn('Add exercise', null, 'secondary', { type: 'submit' })));

  fill(main, 
    header('Programs', 'Build training, attach demo videos and assign to clients.'),
    h('div', { class: 'split' },
      h('div', { class: 'stack', style: 'gap:24px' },
        progs.data.length ? h('div', { class: 'workouts' }, progs.data.map((p) => h('a', { href: `#/programs/${p.id}`, class: 'dp-panel', style: 'text-decoration:none;color:inherit' },
          h('div', { class: 'week-title', style: 'color:var(--steel)' }, p.name),
          h('div', { class: 'small muted' }, `${p.weeks} weeks · ${p.level ?? 'Any level'} · ${p.workout_count} ${p.workout_count === 1 ? 'workout' : 'workouts'} · ${p.client_count} ${p.client_count === 1 ? 'client' : 'clients'}`)))) : h('div', { class: 'empty' }, 'No programs yet. Create your first one below.'),
        panel('New program', {}, create),
        shop ? storePanel(shop) : null),
      panel('Exercise library', { subtitle: `${exs.data.length} exercises` },
        h('div', null, exs.data.map((x) => h('div', { class: 'list-item' },
          h('button', { type: 'button', class: 'dp-ex-play', 'aria-label': `Watch ${x.name} demo`, onClick: () => showVideo(x) }, playIcon()),
          h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, x.video_url ? 'Has demo video' : 'No video yet')),
          btn('Edit', () => editExercise(x), 'ghost')))),
        addEx)));
}

// Owners: what's in the online store and the link to share.
function storePanel(shop) {
  const listed = [...shop.programs, ...shop.courses].filter((x) => x.listed);
  const link = `${location.origin}/shop`;
  return panel('Online store', { subtitle: listed.length ? `${listed.length} for sale · ${shop.last_30_days.sold} sold in the last 30 days (${money(shop.last_30_days.cents)})` : 'Nothing for sale yet. Open a program and use Sell online, or a course on the Education tab.' },
    listed.map((x) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.title), h('span', { class: 'small muted' }, `${x.kind === 'program' ? 'Program' : 'Course'} · ${money(x.price_cents)} · ${x.sold} sold`)),
      x.kind === 'program' ? h('a', { class: 'dp-btn dp-btn--ghost', href: `#/programs/${x.id}` }, 'Open') : null)),
    h('div', { class: 'row wrap' }, h('code', { class: 'small', style: 'word-break:break-all' }, link),
      btn('Copy link', () => navigator.clipboard.writeText(link).then(() => toast('Link copied. Put it on your website and Instagram.')), 'ghost'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: '/shop', target: '_blank', rel: 'noopener' }, 'View')));
}

function showVideo(x) {
  const d = document.getElementById('dialog');
  fill(d, h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('h2', { class: 'week-title grow', style: 'color:var(--steel)' }, x.name), btn('Close', () => d.close(), 'ghost')),
    videoEmbed(x.video_url, x.name), x.instructions ? h('p', { class: 'muted' }, x.instructions) : null));
  d.addEventListener('close', () => fill(d), { once: true });
  d.showModal();
}
function editExercise(x) {
  const d = document.getElementById('dialog');
  const name = input({ value: x.name }), url = input({ type: 'url', value: x.video_url ?? '' }), cue = h('textarea', { class: 'dp-input' }); cue.value = x.instructions ?? '';
  fill(d, h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    await patch(`/v1/exercises/${x.id}`, { name: name.value, video_url: url.value || null, instructions: cue.value || null }); d.close(); toast('Exercise saved.'); render();
  }); } },
    h('h2', { class: 'week-title', style: 'color:var(--steel)' }, 'Edit exercise'), field('Name', name), field('Demo video link', url, 'YouTube, Vimeo or a direct .mp4 link.'), field('Coaching cues', cue),
    h('div', { class: 'row' }, btn('Save exercise', null, 'primary', { type: 'submit' }), btn('Cancel', () => d.close(), 'ghost'))));
  d.showModal();
}

async function viewProgram(main, id) {
  const [p, exs, clients, shop] = await Promise.all([get(`/v1/programs/${id}`), get('/v1/exercises'), get('/v1/clients'), isOwner() ? get('/v1/shop') : null]);
  const who = select([['', 'Choose a client'], ...clients.data.filter((c) => !['canceled'].includes(c.status)).map((c) => [c.id, c.name])], { 'aria-label': 'Client to assign' });
  const assign = h('div', { class: 'row' }, h('div', { style: 'width:220px' }, who), btn('Assign program', (e) => busy(e.currentTarget, async () => {
    if (!who.value) throw new Error('Choose a client first.');
    await post(`/v1/programs/${id}/assign`, { client_id: who.value }); toast(`${p.name} assigned.`); render();
  })));

  const weeks = [...new Set(p.workouts.map((w) => w.week))];
  const workoutCard = (w) => {
    const exSel = select([['', 'Choose exercise'], ...exs.data.map((x) => [x.id, x.name])], { 'aria-label': `Exercise for ${w.title}` });
    const rx = input({ placeholder: 'Sets × reps, e.g. 3 × 10', 'aria-label': 'Sets and reps' });
    const lt = select([['', 'Weight: coach sets it'], ['squat_1rm', '% of back squat max'], ['bench_1rm', '% of bench press max'], ['power_clean_1rm', '% of power clean max']], { 'aria-label': 'Weight from a tested max' });
    const lp = input({ type: 'number', min: '30', max: '110', inputmode: 'numeric', placeholder: '%', 'aria-label': 'Percent of max', style: 'width:80px' });
    return h('div', { class: 'workout' },
      h('div', { class: 'row' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'small muted' }, `Day ${w.day}`), h('span', { class: 'strong' }, w.title)),
        btn('Delete', (e) => { if (confirm(`Delete ${w.title}?`)) busy(e.currentTarget, async () => { await del(`/v1/workouts/${w.id}`); toast('Workout deleted.'); render(); }); }, 'ghost')),
      w.exercises.length ? w.exercises.map((x) => h('div', { class: 'row' },
        h('button', { type: 'button', class: 'dp-ex-play', 'aria-label': `Watch ${x.name} demo`, onClick: () => showVideo(x) }, playIcon()),
        h('div', { class: 'grow stack-tight' }, h('span', null, x.name), h('span', { class: 'small muted' }, `${x.prescription}${x.load_test ? ` · ${x.load_pct}% of ${LOAD_LIFT[x.load_test]} max` : ''}`)),
        h('button', { type: 'button', class: 'dp-btn dp-btn--ghost', 'aria-label': `Remove ${x.name}`, onClick: (e) => busy(e.currentTarget, async () => { await del(`/v1/workout-exercises/${x.id}`); render(); }) }, 'Remove')))
        : h('p', { class: 'small muted' }, 'No exercises yet.'),
      h('form', { class: 'row wrap', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        if (!exSel.value) throw new Error('Choose an exercise to add.');
        await post(`/v1/workouts/${w.id}/exercises`, { exercise_id: exSel.value, prescription: rx.value, load_test: lt.value || undefined, load_pct: lt.value ? Number(lp.value) : undefined }); render();
      }); } }, h('div', { style: 'flex:1 1 100%' }, exSel), h('div', { class: 'grow' }, rx), lt, lp, btn('Add exercise', null, 'secondary', { type: 'submit' })),
      h('p', { class: 'small muted', style: 'margin:0' }, 'A weight from a max updates itself each time the athlete tests again, rounded to 5 lb.'));
  };

  const wk = input({ type: 'number', min: '1', max: String(p.weeks), value: String(weeks.length ? Math.max(...weeks) : 1) }), dy = input({ type: 'number', min: '1', max: '7', value: '1' }), title = input({ placeholder: 'Lower body' });
  const addWorkout = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    await post(`/v1/programs/${id}/workouts`, { week: Number(wk.value), day: Number(dy.value), title: title.value }); toast('Workout added.'); render();
  }); } }, h('div', { class: 'form-grid', style: 'grid-template-columns:1fr 1fr 2fr' }, field('Week', wk), field('Day', dy), field('Workout title', title)), h('div', null, btn('Add workout', null, 'secondary', { type: 'submit' })));

  fill(main, 
    header(p.name, `${p.weeks} weeks · ${p.level ?? 'Any level'} · ${p.clients.length ? 'On it: ' + p.clients.map((c) => c.name.split(' ')[0]).join(', ') : 'Nobody assigned yet'}`, assign),
    ...weeks.map((n) => h('section', { class: 'stack' }, h('h2', { class: 'week-title' }, `Week ${n}`), h('div', { class: 'workouts' }, p.workouts.filter((w) => w.week === n).map(workoutCard)))),
    weeks.length ? null : h('div', { class: 'empty' }, 'No workouts yet. Add the first one below.'),
    panel('Add a workout', {}, addWorkout),
    shop ? panel('Sell online', { subtitle: 'Out-of-town athletes and families buy it from the store page.' }, saleForm(put, 'program', shop.programs.find((x) => x.id === id), () => render())) : null,
    h('div', { class: 'row' }, h('a', { class: 'dp-btn dp-btn--ghost', href: '#/programs' }, 'All programs'), h('span', { class: 'grow' }),
      btn('Delete program', (e) => { if (confirm(`Delete ${p.name}? This can't be undone.`)) busy(e.currentTarget, async () => { await del(`/v1/programs/${id}`); toast('Program deleted.'); location.hash = '#/programs'; }); }, 'ghost')));
}

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

async function viewSell(main) {
  const [locs, prods, clients, readers, sales, plans] = await Promise.all([get('/v1/locations'), get('/v1/products'), get('/v1/clients'), get('/v1/readers'), get('/v1/sales?since=' + encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString())), get('/v1/plans')]);
  if (!locs.data.length || !prods.data.length) {
    fill(main, header('Point of sale', 'Take payments at the facility, in the park and at clients\' homes.', setupLink()),
      h('div', { class: 'empty' }, h('p', null, `Add ${!locs.data.length ? 'the places you train' : ''}${!locs.data.length && !prods.data.length ? ' and ' : ''}${!prods.data.length ? 'what you sell (sessions, packs, gear)' : ''} to start taking payments.`),
        h('p', { style: 'margin-top:12px' }, h('a', { class: 'dp-btn dp-btn--primary', href: '#/sell/setup' }, 'Set up point of sale'))));
    return;
  }
  const preClient = new URLSearchParams(location.hash.split('?')[1] || '').get('client');
  const cart = new Map();                                       // "product_id" or "product_id:size_id" -> quantity
  const cartItem = (key) => { const [pid, vid] = key.split(':'); const p = prods.data.find((x) => x.id === pid); const size = vid && p.variants.find((x) => x.id === vid); return { p, vid, name: size ? `${p.name} (${size.name})` : p.name }; };
  let custom = null;
  const locSel = select(locs.data.map((l) => [l.id, l.name]), { value: remember.get('dp_location') || locs.data[0].id, 'aria-label': 'Location' });
  locSel.addEventListener('change', () => { remember.set('dp_location', locSel.value); draw(); });
  const cliSel = select([['', 'Walk-in (no account)'], ...clients.data.map((c) => [c.id, `${c.name}${c.credits.group ? ` · ${c.credits.group} group` : ''}${c.credits.private ? ` · ${c.credits.private} private` : ''}`])], { value: preClient || '', 'aria-label': 'Client' });
  cliSel.addEventListener('change', draw);
  const method = { value: remember.get('dp_method') || 'tap_to_pay' };
  const saveCard = h('input', { type: 'checkbox', id: 'save-card', checked: true });
  const readerSel = select(readers.data.map((r) => [r.id, `${r.label} (${r.location_name})`]), { 'aria-label': 'Reader' });
  const customDesc = input({ placeholder: 'Description', 'aria-label': 'Custom item description' }), customAmt = input({ type: 'number', min: '1', step: '0.01', inputmode: 'decimal', placeholder: '$', 'aria-label': 'Custom amount in dollars', style: 'width:110px' });
  const cartBox = h('div', { class: 'stack' }), totalBox = h('div', { style: 'font:600 44px/1 var(--font-display)' }), methodBox = h('div', { class: 'stack' }), err = h('div', { class: 'dp-error', role: 'alert' });
  const charge = btn('Charge', () => startSale(), 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block', style: 'min-height:56px;font-size:17px' });
  const progress = h('div');

  const client = () => clients.data.find((c) => c.id === cliSel.value);
  const total = () => [...cart].reduce((t, [key, q]) => t + cartItem(key).p.price_cents * q, 0) + (custom?.amount_cents || 0);

  function draw() {
    const c = client();
    fill(cartBox, ...[...cart].map(([id, q]) => {
      const { p, name } = cartItem(id);
      return h('div', { class: 'row' }, h('span', { class: 'grow' }, name), 
        h('button', { type: 'button', class: 'dp-btn dp-btn--ghost', 'aria-label': `One fewer ${name}`, onClick: () => { q > 1 ? cart.set(id, q - 1) : cart.delete(id); draw(); } }, '−'),
        h('span', { style: 'min-width:24px;text-align:center' }, q),
        h('button', { type: 'button', class: 'dp-btn dp-btn--ghost', 'aria-label': `One more ${name}`, onClick: () => { cart.set(id, q + 1); draw(); } }, '+'),
        h('span', { style: 'min-width:80px;text-align:right' }, money(p.price_cents * q)));
    }), custom ? h('div', { class: 'row' }, h('span', { class: 'grow' }, custom.description), btn('Remove', () => { custom = null; draw(); }, 'ghost'), h('span', { style: 'min-width:80px;text-align:right' }, money(custom.amount_cents))) : null);
    if (!cart.size && !custom) cartBox.append(h('p', { class: 'muted' }, 'Tap a product to add it.'));
    totalBox.textContent = money(total());
    const loc = locs.data.find((l) => l.id === locSel.value);
    const options = [
      ['tap_to_pay', 'Tap to Pay on iPhone', loc?.card_ready ? 'Client taps their card or phone on your iPhone.' : `Add an address to ${loc?.name} in setup first.`, !loc?.card_ready],
      ['reader', 'Front-desk reader', readers.data.length ? 'Sends the charge to the reader.' : 'Register a reader in setup first.', !readers.data.length],
      ['card_on_file', 'Card on file', c?.has_card ? 'Charges their saved card now.' : c ? 'No saved card for this client.' : 'Choose a client with a saved card.', !c?.has_card],
      ['cash', 'Cash', 'Record a cash payment.', false]
    ];
    if (options.find(([k]) => k === method.value)?.[3]) method.value = options.find((o) => !o[3])[0];
    fill(methodBox, h('div', { class: 'dp-label' }, 'Payment'), ...options.map(([k, label, hint, disabled]) => h('label', { class: 'row', style: `gap:10px;min-height:44px;${disabled ? 'opacity:.5' : 'cursor:pointer'}` },
      h('input', { type: 'radio', name: 'method', value: k, checked: method.value === k, disabled, onChange: () => { method.value = k; remember.set('dp_method', k); draw(); } }),
      h('span', { class: 'stack-tight' }, h('span', { class: 'strong' }, label), h('span', { class: 'small muted' }, hint)))),
      method.value === 'reader' ? h('div', { style: 'padding-left:28px' }, readerSel) : null,
      ['tap_to_pay', 'reader'].includes(method.value) && c ? h('label', { class: 'row small', style: 'gap:10px;min-height:44px' }, saveCard, h('span', null, `Save this card for ${c.name.split(' ')[0]}'s future payments (with their OK)`)) : null);
    charge.textContent = total() ? `Charge ${money(total())}` : 'Charge';
    charge.disabled = !total();
  }

  async function startSale() {
    err.textContent = '';
    const body = { location_id: locSel.value, method: method.value, client_id: cliSel.value || undefined, items: [...cart].map(([key, quantity]) => { const [product_id, variant_id] = key.split(':'); return { product_id, variant_id, quantity }; }), custom: custom || undefined,
      save_card: saveCard.checked && !!cliSel.value, reader_id: method.value === 'reader' ? readerSel.value : undefined };
    await busy(charge, async () => {
      try { const sale = await post('/v1/sales', body); follow(sale); }
      catch (e) { err.textContent = e.message; }
    });
  }

  let timer;
  function follow(sale) {
    clearTimeout(timer);
    if (sale.status === 'succeeded') {
      toast(`${money(sale.amount_cents)} paid${sale.card_last4 ? ` with card ending ${sale.card_last4}` : ''}.`);
      cart.clear(); custom = null; fill(progress); draw(); refreshRecent(); refreshStock(); return;
    }
    if (sale.status !== 'pending') {
      fill(progress, h('div', { class: 'dp-panel', style: 'border-color:var(--amber)' }, h('p', { class: 'warn-text strong' }, sale.status === 'canceled' ? 'Payment canceled.' : `Payment didn't go through. ${sale.failure_reason ?? ''}`), h('p', { class: 'small muted' }, 'Nothing was charged. Fix the issue and charge again.')));
      refreshRecent(); return;
    }
    const simulate = state.payments.can_simulate ? h('div', { class: 'row wrap' },
      btn('Simulate approved tap', (e) => busy(e.currentTarget, async () => follow(await post(`/v1/sales/${sale.id}/simulate`, { outcome: 'approved' }))), 'outline'),
      btn('Simulate decline', (e) => busy(e.currentTarget, async () => follow(await post(`/v1/sales/${sale.id}/simulate`, { outcome: 'declined' }))), 'ghost')) : null;
    fill(progress, h('div', { class: 'dp-panel', style: 'border-color:var(--green-mid)' },
      h('div', { class: 'week-title', style: 'color:var(--steel)' }, `Waiting for ${money(sale.amount_cents)}`),
      h('p', { class: 'muted' }, sale.method === 'reader' ? `Ask the client to tap, insert or swipe on ${sale.reader_label}.` : 'Open the Diamond Protocol coach app on your iPhone. The payment is waiting there for the client to tap.'),
      simulate,
      h('div', { class: 'row' }, btn('Cancel payment', (e) => busy(e.currentTarget, async () => follow(await post(`/v1/sales/${sale.id}/cancel`))), 'secondary'))));
    progress.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    timer = setTimeout(async () => { if (!document.body.contains(progress)) return; try { follow(await post(`/v1/sales/${sale.id}/sync`)); } catch { timer = setTimeout(() => follow(sale), 4000); } }, 3000);
  }

  const recent = h('div');
  async function refreshRecent() {
    const { data } = await get('/v1/sales?since=' + encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString()));
    drawRecent(data);
  }
  function drawRecent(data) {
    fill(recent, ...(data.length ? data.slice(0, 25).map((x) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, `${x.client_name ?? 'Walk-in'} · ${money(x.amount_cents)}`),
        h('span', { class: 'small muted' }, `${x.description ?? ''} · ${x.location_name} · ${METHOD_LABEL[x.method]}${x.card_last4 ? ` ••${x.card_last4}` : ''} · ${ago(x.created_at)}`),
        x.status === 'failed' && x.failure_reason ? h('span', { class: 'small warn-text' }, x.failure_reason) : null,
        x.refunded_cents && x.status === 'partially_refunded' ? h('span', { class: 'small muted' }, `${money(x.refunded_cents)} refunded`) : null),
      badge(x.status),
      ['succeeded', 'partially_refunded'].includes(x.status) ? btn('Refund', (e) => {
        const left = x.amount_cents - x.refunded_cents;
        const answer = prompt(`Refund how much? Up to ${money(left)}.`, (left / 100).toFixed(2));
        if (answer === null) return;
        const cents = Math.round(Number(answer) * 100);
        if (!cents || cents < 0) return toast('Enter an amount like 25.00.', 'warn');
        busy(e.currentTarget, async () => { await post(`/v1/sales/${x.id}/refund`, { amount_cents: cents }); toast(`${money(cents)} refunded.`); refreshRecent(); });
      }, 'ghost') : null,
      x.status === 'pending' ? btn('Check', (e) => busy(e.currentTarget, async () => { follow(await post(`/v1/sales/${x.id}/sync`)); })) : null))
      : [h('p', { class: 'muted' }, 'No sales in the last 7 days.')]));
  }

  // Gear with sizes asks which size; stock left shows on the tile (selling past zero is allowed: the shelf is the truth).
  const sizeBox = h('div');
  const addToCart = (key) => { cart.set(key, (cart.get(key) || 0) + 1); fill(sizeBox); draw(); };
  const left = (n) => (n <= 0 ? h('span', { class: 'small warn-text' }, 'Out of stock') : h('span', { class: `small ${n <= 3 ? 'warn-text' : 'muted'}` }, `${n} left`));
  const pickSize = (p, sizes) => fill(sizeBox, h('div', { class: 'dp-panel', style: 'gap:10px' },
    h('div', { class: 'row' }, h('span', { class: 'grow strong' }, `Which size of ${p.name}?`), btn('Cancel', () => fill(sizeBox), 'ghost')),
    h('div', { class: 'row wrap', style: 'gap:8px' }, sizes.map((x) => h('button', { type: 'button', class: 'dp-btn dp-btn--secondary', style: 'min-height:52px;min-width:72px;flex-direction:column;gap:2px', onClick: () => addToCart(`${p.id}:${x.id}`) },
      h('span', { class: 'strong' }, x.name), p.track_stock ? left(x.on_hand) : null)))));
  const productGrid = h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px' });
  function drawProducts() {
    fill(productGrid, ...prods.data.map((p) => {
      const sizes = (p.variants ?? []).filter((x) => x.active);
      return h('button', { type: 'button', class: 'dp-panel', style: 'text-align:left;cursor:pointer;padding:14px;gap:4px', onClick: () => (sizes.length > 1 ? pickSize(p, sizes) : addToCart(sizes.length ? `${p.id}:${sizes[0].id}` : p.id)) },
        h('span', { class: 'strong' }, p.name), h('span', { style: 'font:600 22px/1 var(--font-display);color:var(--green-bright)' }, money(p.price_cents)),
        p.kind === 'pack' ? h('span', { class: 'small muted' }, `${p.sessions} ${p.credit_type} sessions`) : null,
        sizes.length > 1 ? h('span', { class: 'small muted' }, sizes.map((x) => x.name).join(' · ')) : null,
        p.track_stock ? left(p.on_hand) : null);
    }));
  }
  async function refreshStock() { if (!prods.data.some((p) => p.track_stock)) return; prods.data = (await get('/v1/products')).data; drawProducts(); }
  drawProducts();
  // Monthly memberships renew on the card saved for the client (or their family), so starting one needs that card.
  const memberBox = h('div');
  function startMembership(p) {
    const c = client();
    if (!c) { toast('Choose who the membership is for first.', 'warn'); cliSel.focus(); return; }
    const first = c.name.split(' ')[0];
    const when = p.trial_days ? `Free for ${p.trial_days} day${p.trial_days === 1 ? '' : 's'}, then ${money(p.price_cents)} every month.` : `${money(p.price_cents)} today, then every month.`;
    const done = (sub) => { toast(sub.status === 'trialing' ? `${first} is on ${p.name}. The trial ends ${date(sub.trial_ends_at)}.` : `${first} is on ${p.name}. Renews ${date(sub.current_period_end)}.`); fill(memberBox); };
    const start = btn(p.trial_days ? 'Start free trial' : `Charge ${money(p.price_cents)} and start`, (e) => busy(e.currentTarget, async () => {
      try { done(await post(`/v1/clients/${c.id}/subscription`, { plan_id: p.id })); } catch (err) { toast(err.message, 'warn'); }
    }));
    const needCard = h('div', { class: 'stack' },
      h('p', { class: 'warn-text', style: 'margin:0' }, `${first} has no card on file. Monthly memberships renew on a saved card.`),
      h('div', { class: 'row wrap' },
        btn('Get a secure card link', (e) => busy(e.currentTarget, async () => {
          try {
            const { url } = await post(`/v1/clients/${c.id}/card/setup-link`);
            fill(needCard, h('p', { style: 'margin:0' }, 'Send this link to the client or parent. They add their card on Stripe\'s secure page, then you start the membership here.'), h('input', { class: 'dp-input mono', readonly: true, value: url, onFocus: (ev) => ev.target.select() }));
          } catch (err) { toast(err.message, 'warn'); }
        }), 'outline'),
        state.payments.can_simulate ? btn('Add test card', (e) => busy(e.currentTarget, async () => { await post(`/v1/clients/${c.id}/card/test`); c.has_card = 1; startMembership(p); }), 'ghost') : null),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Or charge a first sale by Tap to Pay with "Save this card" ticked, then start the membership.'));
    fill(memberBox, panel(`Start ${p.name}`, { subtitle: `${c.name} · ${when}` },
      c.subscription?.status && c.subscription.status !== 'canceled' ? h('p', { class: 'warn-text', style: 'margin:0' }, `${first} already has a membership (${c.subscription.plan_name}). Change it on their client page.`)
        : c.has_card ? h('div', { class: 'stack' }, h('p', { style: 'margin:0' }, 'Bills the card on file every month.'), h('div', { class: 'row wrap' }, start, btn('Cancel', () => fill(memberBox), 'ghost')))
        : needCard));
    memberBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const planGrid = plans.data.filter((p) => p.active !== false && p.price_cents != null).length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px' }, plans.data.filter((p) => p.active !== false && p.price_cents != null).map((p) => h('button', { type: 'button', class: 'dp-panel', style: 'text-align:left;cursor:pointer;padding:14px;gap:4px', onClick: () => startMembership(p) },
    h('span', { class: 'strong' }, p.name), h('span', { style: 'font:600 22px/1 var(--font-display);color:var(--green-bright)' }, money(p.price_cents), h('span', { class: 'small muted', style: 'font:400 13px var(--font-sans)' }, ' /month')),
    h('span', { class: 'small muted' }, p.trial_days ? `${p.trial_days}-day free trial` : 'Billed monthly')))) : null;
  const customForm = h('form', { class: 'row', onSubmit: (e) => { e.preventDefault(); const cents = Math.round(Number(customAmt.value) * 100); if (!customDesc.value.trim() || !cents) return toast('Enter a description and an amount.', 'warn'); custom = { description: customDesc.value.trim(), amount_cents: cents }; customDesc.value = ''; customAmt.value = ''; draw(); } },
    h('div', { class: 'grow' }, customDesc), customAmt, btn('Add', null, 'secondary', { type: 'submit' }));

  fill(main, 
    header('Point of sale', 'Take payments at the facility, in the park and at clients\' homes.', h('div', { class: 'row wrap' }, prods.data.some((p) => p.track_stock) ? h('a', { class: 'dp-btn dp-btn--ghost', href: '#/sell/inventory' }, 'Inventory') : null, setupLink())),
    h('div', { class: 'split' },
      h('div', { class: 'stack', style: 'gap:24px' },
        panel(null, {}, h('div', { class: 'form-grid' }, field('Where', locSel), field('Who', cliSel))),
        panel('Products', {}, productGrid, sizeBox, h('div', { class: 'dp-label', style: 'margin-top:8px' }, 'Custom amount'), customForm),
        planGrid ? panel('Monthly memberships', { subtitle: 'Choose who it\'s for above, then tap a membership. It renews on their saved card.' }, planGrid) : null,
        memberBox),
      h('div', { class: 'stack', style: 'gap:24px' },
        progress,
        panel('Sale', {}, cartBox, h('div', { class: 'row', style: 'border-top:1px solid var(--line-subtle);padding-top:12px' }, h('span', { class: 'grow muted' }, 'Total'), totalBox), methodBox, err, charge))),
    panel('Recent sales', { subtitle: 'Last 7 days' }, recent));
  draw(); drawRecent(sales.data);
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

async function viewSetup(main) {
  const [locs, prods, readers] = await Promise.all([get('/v1/locations?include_inactive=true'), get('/v1/products?include_inactive=true'), get('/v1/readers')]);
  const KIND = { facility: 'Facility', mobile: 'Mobile (clients\' homes)', park: 'Park', client_home: 'Client home', other: 'Other' };

  const f = { name: input(), kind: select(Object.entries(KIND), { value: 'facility' }), line1: input({ autocomplete: 'address-line1' }), city: input({ autocomplete: 'address-level2' }), state: input({ autocomplete: 'address-level1', maxlength: '2', placeholder: 'TX' }), zip: input({ autocomplete: 'postal-code', inputmode: 'numeric' }) };
  const locPanel = panel('Locations', { subtitle: 'Card payments need a street address for each place. For client homes, use one "Mobile" location with your business address.' },
    ...locs.data.map((l) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, l.name, l.active ? null : h('span', { class: 'small muted' }, ' (archived)')), h('span', { class: 'small muted' }, `${KIND[l.kind]}${l.address_line1 ? ` · ${l.address_line1}, ${l.city}` : ' · No address yet'}`)),
      l.card_ready ? h('span', { class: 'dp-badge dp-badge--good' }, 'Cards ready') : h('span', { class: 'dp-badge dp-badge--warn' }, 'Needs address'),
      btn(l.active ? 'Archive' : 'Restore', (e) => busy(e.currentTarget, async () => { await patch(`/v1/locations/${l.id}`, { active: !l.active }); render(); }), 'ghost'))),
    h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const l = await post('/v1/locations', { name: f.name.value, kind: f.kind.value, address_line1: f.line1.value || undefined, city: f.city.value || undefined, state: f.state.value || undefined, postal_code: f.zip.value || undefined });
      toast(l.card_ready ? `${l.name} added and ready for card payments.` : `${l.name} added. Add its address to take cards there.`); render();
    }); } },
      h('div', { class: 'form-grid' }, field('Location name', f.name), field('Type', f.kind)),
      field('Street address', f.line1),
      h('div', { class: 'form-grid', style: 'grid-template-columns:2fr 1fr 1fr' }, field('City', f.city), field('State', f.state), field('ZIP', f.zip)),
      h('div', null, btn('Add location', null, 'primary', { type: 'submit' }))));

  const pf = { name: input(), kind: select([['session', 'Single session'], ['pack', 'Session pack'], ['gear', 'Gear'], ['other', 'Other']]), price: input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }), sessions: input({ type: 'number', min: '2', value: '10' }), type: select([['private', 'Private sessions'], ['group', 'Group classes']]), stock: h('input', { type: 'checkbox', checked: true }) };
  const sessionsField = field('Sessions in pack', pf.sessions), typeField = field('Counts as', pf.type);
  const stockField = h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, pf.stock, h('span', null, 'Count stock (sizes and deliveries in Inventory)'));
  const syncKind = () => { sessionsField.style.display = pf.kind.value === 'pack' ? '' : 'none'; typeField.style.display = ['pack', 'session'].includes(pf.kind.value) ? '' : 'none'; stockField.style.display = pf.kind.value === 'gear' ? '' : 'none'; };
  pf.kind.addEventListener('change', syncKind); syncKind();
  const prodPanel = panel('Products', { subtitle: 'Sessions and packs add session credits to the client. Members check in on their membership.' },
    ...prods.data.map((p) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, p.name, p.active ? null : h('span', { class: 'small muted' }, ' (not sold)')), h('span', { class: 'small muted' }, `${money(p.price_cents)}${p.kind === 'pack' ? ` · ${p.sessions} ${p.credit_type} sessions` : p.kind === 'session' ? ` · 1 ${p.credit_type} session` : ''}${p.track_stock ? ` · ${p.on_hand} on hand` : ''}`)),
      p.track_stock ? h('a', { class: 'dp-btn dp-btn--ghost', href: '#/sell/inventory' }, 'Stock') : null,
      btn('Price', (e) => { const a = prompt(`New price for ${p.name}?`, (p.price_cents / 100).toFixed(2)); if (a === null) return; busy(e.currentTarget, async () => { await patch(`/v1/products/${p.id}`, { price_cents: Math.round(Number(a) * 100) }); toast('Price updated.'); render(); }); }, 'ghost'),
      btn(p.active ? 'Stop selling' : 'Sell again', (e) => busy(e.currentTarget, async () => { await patch(`/v1/products/${p.id}`, { active: !p.active }); render(); }), 'ghost'))),
    h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      await post('/v1/products', { name: pf.name.value, kind: pf.kind.value, price_cents: Math.round(Number(pf.price.value) * 100), sessions: pf.kind.value === 'pack' ? Number(pf.sessions.value) : undefined, credit_type: pf.type.value, track_stock: pf.kind.value === 'gear' && pf.stock.checked, low_stock_at: pf.kind.value === 'gear' && pf.stock.checked ? 2 : undefined });
      toast(pf.kind.value === 'gear' && pf.stock.checked ? 'Product added. Add sizes and what\'s on the shelf in Inventory.' : 'Product added.'); render();
    }); } },
      h('div', { class: 'form-grid' }, field('Product name', pf.name), field('Type', pf.kind)),
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('Price ($)', pf.price), sessionsField, typeField),
      stockField,
      h('div', null, btn('Add product', null, 'primary', { type: 'submit' }))));

  const rf = { code: input({ placeholder: 'three-words-code', autocapitalize: 'none' }), label: input({ placeholder: 'Front desk' }), loc: select(locs.data.filter((l) => l.active).map((l) => [l.id, l.name])) };
  const readerPanel = panel('Front-desk readers', { subtitle: 'For a Stripe smart reader (like the S710). Turn it on, connect it to Wi-Fi, and enter the code it shows.' },
    ...readers.data.map((r) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, r.label), h('span', { class: 'small muted' }, `${r.location_name} · ${r.device_type ?? 'reader'}`)),
      btn('Remove', (e) => { if (confirm(`Remove ${r.label}?`)) busy(e.currentTarget, async () => { await del(`/v1/readers/${r.id}`); render(); }); }, 'ghost'))),
    h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      await post('/v1/readers', { registration_code: rf.code.value, label: rf.label.value, location_id: rf.loc.value }); toast('Reader registered.'); render();
    }); } },
      h('div', { class: 'form-grid', style: 'grid-template-columns:1fr 1fr 1fr' }, field('Registration code', rf.code, state.payments.can_simulate ? 'Test mode: use simulated-wpe' : null), field('Label', rf.label), field('Location', rf.loc)),
      h('div', null, btn('Register reader', null, 'secondary', { type: 'submit' }))));

  let planPanel = null;
  if (isOwner()) {
    const plans = await get('/v1/plans');
    const pf = { name: input({ placeholder: 'e.g. Unlimited group training' }), price: input({ type: 'number', min: '1', step: '0.01', inputmode: 'decimal' }), trial: input({ type: 'number', min: '0', max: '90', value: '0' }) };
    planPanel = panel('Monthly memberships', { subtitle: 'Billed to the saved card every month. They show on the sale screen and in the parent portal. Change prices or retire them in Billing.' },
      ...plans.data.filter((p) => p.active !== false).map((p) => h('div', { class: 'list-item' }, h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'small muted' }, `${money(p.price_cents)} a month${p.trial_days ? ` · ${p.trial_days}-day free trial` : ''}`)))),
      h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        const cents = Math.round(Number(pf.price.value) * 100);
        if (!pf.name.value.trim() || !cents) return toast('Enter a name and a monthly price.', 'warn');
        try { await post('/v1/plans', { name: pf.name.value.trim(), price_cents: cents, trial_days: Number(pf.trial.value) || 0 }); toast('Membership added.'); render(); } catch (err) { toast(err.message, 'warn'); }
      }); } },
        h('div', { class: 'form-grid', style: 'grid-template-columns:2fr 1fr 1fr' }, field('Membership name', pf.name), field('Monthly price ($)', pf.price), field('Free trial (days)', pf.trial, '0 charges the first month right away.')),
        h('div', null, btn('Add membership', null, 'secondary', { type: 'submit' }))));
  }
  fill(main, header('Point of sale setup', 'Where you train, what you sell and your card readers.', h('a', { class: 'dp-btn dp-btn--primary', href: '#/sell' }, 'Back to sales')),
    h('div', { class: 'grid grid-2' }, locPanel, h('div', { class: 'stack', style: 'gap:24px' }, prodPanel, planPanel, readerPanel)));
}

// ---------- Schedule ----------
const KIND_LABEL = { group: 'Group', camp: 'Camp', clinic: 'Clinic', team: 'Team', evaluation: 'Evaluation', private: 'Private' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let tzName;
const tzFmt = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: tzName, ...opts }).format(new Date(iso));
const dayOf = (iso) => tzFmt(iso, { weekday: 'long', month: 'short', day: 'numeric' });
const timeOf = (iso) => tzFmt(iso, { hour: 'numeric', minute: '2-digit' });
const kindBadge = (k) => h('span', { class: `dp-badge dp-badge--${k === 'group' ? 'good' : k === 'camp' || k === 'clinic' ? 'neutral' : 'muted'}` }, KIND_LABEL[k] ?? k);
const COVER = { membership: ['Member', 'good'], credit: ['Credit', 'good'], paid: ['Paid', 'good'], registration: ['Registered', 'good'], unpaid: ['Unpaid', 'warn'], none: ['—', 'muted'] };
const coverBadge = (c) => h('span', { class: `dp-badge dp-badge--${COVER[c]?.[1] ?? 'muted'}` }, COVER[c]?.[0] ?? c);

function sessionRow(x) {
  return h('a', { class: 'list-item', href: `#/schedule/${x.id}`, style: 'text-decoration:none;color:inherit' },
    h('div', { style: 'width:84px;flex-shrink:0;font:600 18px/1.1 var(--font-display)' }, timeOf(x.starts_at)),
    h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, `${x.location_name} · ${x.booked_count}/${x.capacity} booked${x.waitlist_count ? ` · ${x.waitlist_count} waitlisted` : ''}`)),
    x.unpaid_count ? h('span', { class: 'dp-badge dp-badge--warn' }, `${x.unpaid_count} unpaid`) : null,
    kindBadge(x.kind));
}

async function viewSchedule(main) {
  const [sched, series, locs, settings] = await Promise.all([get('/v1/schedule'), get('/v1/class-series'), get('/v1/locations'), get('/v1/settings')]);
  tzName = settings.timezone;
  const byDay = {};
  for (const x of sched.data) (byDay[dayOf(x.starts_at)] ??= []).push(x);

  const f = { name: input(), kind: select([['group', 'Weekly group class'], ['camp', 'Camp'], ['clinic', 'Clinic'], ['team', 'Team session'], ['evaluation', 'Evaluation day']]), loc: select(locs.data.map((l) => [l.id, l.name])),
    time: input({ type: 'time', value: '17:00' }), dur: input({ type: 'number', value: '60', min: '10' }), cap: input({ type: 'number', value: '12', min: '1' }), ageMin: input({ type: 'number', placeholder: 'Any' }), ageMax: input({ type: 'number', placeholder: 'Any' }),
    dropIn: input({ type: 'number', step: '0.01', placeholder: 'Not sold singly' }), reg: input({ type: 'number', step: '0.01', placeholder: 'Camps and clinics' }),
    start: input({ type: 'date', value: new Date().toISOString().slice(0, 10) }), end: input({ type: 'date' }), desc: input({ placeholder: 'What athletes will work on' }) };
  const days = DAY_NAMES.map((d, i) => h('label', { class: 'row small', style: 'gap:6px;min-height:36px' }, h('input', { type: 'checkbox', value: String(i) }), d));
  const dollars = (el) => (el.value === '' ? undefined : Math.round(Number(el.value) * 100));
  const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const weekdays = days.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
    const x = await post('/v1/class-series', { name: f.name.value, kind: f.kind.value, location_id: f.loc.value, weekdays, start_time: f.time.value, duration_min: Number(f.dur.value), capacity: Number(f.cap.value),
      age_min: f.ageMin.value ? Number(f.ageMin.value) : undefined, age_max: f.ageMax.value ? Number(f.ageMax.value) : undefined, drop_in_cents: dollars(f.dropIn), registration_cents: dollars(f.reg),
      start_date: f.start.value, end_date: f.end.value || undefined, description: f.desc.value || undefined });
    toast(`${x.name} added: ${x.upcoming_sessions} sessions on the schedule.`); render();
  }); } },
    h('div', { class: 'form-grid' }, field('Name', f.name), field('Type', f.kind)),
    h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'dp-label' }, 'Days'), h('div', { class: 'row wrap', style: 'gap:12px' }, days)),
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('Starts', f.time), field('Minutes', f.dur), field('Spots', f.cap)),
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' }, field('Min age', f.ageMin), field('Max age', f.ageMax), field('Drop-in ($)', f.dropIn), field('Registration ($)', f.reg)),
    h('div', { class: 'form-grid' }, field('First day', f.start), field('Last day', f.end, 'Leave empty for weekly classes that keep going.')),
    field('Description (parents see this)', f.desc),
    h('div', null, btn('Add to schedule', null, 'primary', { type: 'submit' })));

  const addPanel = panel('Add a class, camp or clinic', { subtitle: 'Sessions are created automatically. Weekly classes are always scheduled 8 weeks ahead.' }, form);
  const seriesList = series.data.length ? series.data.map((x) => h('div', { class: 'list-item' },
    h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, `${x.weekdays.map((d) => DAY_NAMES[d]).join(', ')} ${x.start_time} · ${x.location_name} · ${x.capacity} spots${x.age_min || x.age_max ? ` · ages ${x.age_min ?? ''}–${x.age_max ?? ''}` : ''}${x.enrolled_count ? ` · ${x.enrolled_count} ${x.kind === 'group' ? 'standing' : 'registered'}` : ''}`)),
    kindBadge(x.kind),
    btn('Archive', (e) => { if (confirm(`Archive ${x.name}? Future sessions are canceled, credits returned and families emailed.`)) busy(e.currentTarget, async () => { await patch(`/v1/class-series/${x.id}`, { active: false }); toast('Archived.'); render(); }); }, 'ghost')))
    : [h('p', { class: 'muted' }, 'No classes yet. Add your first one below.')];

  fill(main, 
    header('Schedule', 'Classes, camps, clinics, privates and evaluations for the next two weeks.', h('div', { class: 'row' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule/setup' }, 'Hours & settings'),
      locs.data.length ? btn('Add class or camp', () => { addPanel.scrollIntoView({ behavior: 'smooth' }); f.name.focus({ preventScroll: true }); }) : null)),
    locs.data.length ? null : h('div', { class: 'empty' }, 'Add a location in Point of sale setup before scheduling.'),
    ...(Object.keys(byDay).length ? Object.entries(byDay).map(([d, xs]) => panel(d, {}, xs.map(sessionRow))) : [h('div', { class: 'empty' }, 'Nothing scheduled in the next two weeks.')]),
    panel('Classes & camps', {}, ...seriesList),
    locs.data.length ? addPanel : null);
}

async function viewSession(main, id) {
  const [x, clientsList, settings, progs] = await Promise.all([get(`/v1/sessions/${id}`), get('/v1/clients'), get('/v1/settings'), get('/v1/programs')]);
  tzName = settings.timezone;
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
      render();
    });
  }, 'outline');
  const row = (r) => h('div', { class: 'list-item' },
    h('button', { type: 'button', class: 'dp-ex-log', style: 'min-width:92px', 'aria-pressed': String(r.status === 'attended'), 'aria-label': `${r.status === 'attended' ? 'Checked in' : 'Check in'} ${r.name}`,
      onClick: (e) => busy(e.currentTarget, async () => { await post(`/v1/bookings/${r.id}/attendance`, { status: r.status === 'attended' ? 'booked' : 'attended' }); render(); }) }, r.status === 'attended' ? 'Here' : r.status === 'no_show' ? 'No-show' : 'Check in'),
    h('div', { class: 'grow stack-tight' }, h('a', { href: `#/clients/${r.client_id}`, class: 'strong', style: 'color:var(--steel)' }, r.name),
      h('span', { class: 'small muted' }, [r.age != null ? `Age ${r.age}` : null, r.family_name, r.parent_phone].filter(Boolean).join(' · ')),
      r.has_medical_notes ? h('span', { class: 'small warn-text' }, 'Has medical notes. Open profile.') : null),
    coverBadge(r.coverage),
    r.coverage === 'unpaid' ? collect(r) : null,
    r.status === 'booked' && x.starts_at < new Date().toISOString() ? btn('No-show', (e) => busy(e.currentTarget, async () => { await post(`/v1/bookings/${r.id}/attendance`, { status: 'no_show' }); render(); }), 'ghost') : null,
    btn('Remove', (e) => { if (confirm(`Remove ${r.name} from this session?`)) busy(e.currentTarget, async () => { const out = await post(`/v1/bookings/${r.id}/cancel`, { waive: true }); toast(out.message); render(); }); }, 'ghost'));

  const who = select([['', 'Add an athlete…'], ...clientsList.data.filter((c) => c.status !== 'canceled').map((c) => [c.id, c.name])], { 'aria-label': 'Athlete to add' });
  const addForm = h('div', { class: 'row' }, h('div', { class: 'grow' }, who), btn('Add', (e) => busy(e.currentTarget, async () => {
    if (!who.value) throw new Error('Choose an athlete.');
    try { const b = await post(`/v1/sessions/${id}/bookings`, { client_id: who.value }); toast(b.status === 'waitlisted' ? 'Session is full. Added to the waitlist.' : `Added (${COVER[b.coverage][0].toLowerCase()}).`); }
    catch (err) { if (!/is \d+\. This session/.test(err.message) || !confirm(`${err.message}\n\nAdd anyway?`)) throw err; await post(`/v1/sessions/${id}/bookings`, { client_id: who.value, override_age: true }); toast('Added.'); }
    render();
  }), 'secondary'));

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
      await put(`/v1/sessions/${id}/workout`, { workout_id: wkSel.value }); toast('The screen shows it now.'); render();
    }); } }, h('div', { class: 'grow' }, progSel), h('div', { class: 'grow' }, wkSel), btn(x.workout ? 'Change workout' : 'Show on screen', null, 'secondary', { type: 'submit' }),
      x.workout ? btn('Clear', (e) => busy(e.currentTarget, async () => { await put(`/v1/sessions/${id}/workout`, { workout_id: null }); toast('Cleared.'); render(); }), 'ghost') : null) : null);

  fill(main, 
    header(x.name, `${dayOf(x.starts_at)} · ${timeOf(x.starts_at)}–${timeOf(x.ends_at)} · ${x.location_name}${x.status === 'canceled' ? ' · CANCELED' : ''}`, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule' }, 'Schedule')),
    x.team ? panel(`${x.team.org_name} ${x.team.team_name}`, { subtitle: `${x.team.athletes.filter((a) => a.present).length} of ${x.team.athletes.length} here · billed through the team contract`, action: h('div', { class: 'row' },
        x.team.athletes.some((a) => !a.present) ? btn('Everyone\'s here', (e) => busy(e.currentTarget, async () => {
          for (const a of x.team.athletes.filter((t) => !t.present)) await post(`/v1/sessions/${id}/team-attendance`, { roster_id: a.id, present: true });
          toast('Everyone checked in. Tap anyone who\'s missing.'); render();
        }), 'secondary') : null,
        h('a', { class: 'dp-btn dp-btn--secondary', href: `#/teams/${x.team.contract_id}` }, 'Team')) },
      x.team.athletes.length ? x.team.athletes.map((a) => h('div', { class: 'list-item' },
        h('button', { type: 'button', class: 'dp-ex-log', style: 'min-width:92px', 'aria-pressed': String(a.present), 'aria-label': `${a.present ? 'Here' : 'Mark here'}: ${a.name}`,
          onClick: (e) => busy(e.currentTarget, async () => { await post(`/v1/sessions/${id}/team-attendance`, { roster_id: a.id, present: !a.present }); render(); }) }, a.present ? 'Here' : 'Check in'),
        h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, a.name), h('span', { class: 'small muted' }, [a.position, a.grad_year ? `Class of ${a.grad_year}` : null].filter(Boolean).join(' · '))))) : h('p', { class: 'muted' }, 'No roster yet. Add athletes on the team page.')) : null,
    x.team && !x.roster.length ? null : panel(`Roster · ${x.booked_count}/${x.capacity}`, { subtitle: `${x.attended_count} checked in${x.unpaid_count ? ` · ${x.unpaid_count} unpaid` : ''}${x.age_min || x.age_max ? ` · ages ${x.age_min ?? ''}–${x.age_max ?? ''}` : ''}` },
      active.length ? active.map(row) : h('p', { class: 'muted' }, 'Nobody booked yet.'), x.status === 'scheduled' ? addForm : null),
    screenPanel,
    waiting.length ? panel(`Waitlist · ${waiting.length}`, { subtitle: 'Moves up automatically when a spot opens.' }, waiting.map((r) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, r.name), btn('Remove', (e) => busy(e.currentTarget, async () => { await post(`/v1/bookings/${r.id}/cancel`, { waive: true }); render(); }), 'ghost')))) : null,
    done.length ? panel('Canceled', {}, done.map((r) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, r.name), h('span', { class: 'muted' }, r.status === 'late_canceled' ? 'Late cancel (session used)' : 'Canceled')))) : null,
    x.status === 'scheduled' ? h('div', { class: 'row' }, h('span', { class: 'grow' }), btn('Cancel this session', (e) => {
      const reason = prompt('Tell families why (they\'ll get an email). Credits come back and drop-ins are refunded.', 'Weather');
      if (reason === null) return;
      busy(e.currentTarget, async () => { await post(`/v1/sessions/${id}/cancel`, { reason }); toast('Session canceled and families emailed.'); render(); });
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

async function viewScheduleSetup(main) {
  const [av, locs, settings, kiosks] = await Promise.all([get('/v1/availability'), get('/v1/locations'), get('/v1/settings'), get('/v1/kiosks')]);
  const a = { kind: select([['private', 'Private training'], ['evaluation', 'Evaluations']]), loc: select(locs.data.map((l) => [l.id, l.name])), day: select(DAY_NAMES.map((d, i) => [String(i), d])), from: input({ type: 'time', value: '15:00' }), to: input({ type: 'time', value: '19:00' }), len: input({ type: 'number', value: '60', min: '15', step: '15' }), price: input({ type: 'number', step: '0.01', placeholder: 'Evaluations' }) };
  const hours = panel('Your hours for privates and evaluations', { subtitle: 'Parents book open times in the portal. Anything else on your schedule blocks the time.' },
    ...(av.data.length ? av.data.map((x) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, `${DAY_NAMES[x.weekday]} ${x.start_time}–${x.end_time} · ${x.kind === 'private' ? 'Privates' : 'Evaluations'} · ${x.slot_minutes} min · ${x.location_name}${x.price_cents ? ` · ${money(x.price_cents)}` : ''}`),
      btn('Remove', (e) => busy(e.currentTarget, async () => { await del(`/v1/availability/${x.id}`); render(); }), 'ghost'))) : [h('p', { class: 'muted' }, 'No hours yet.')]),
    h('form', { class: 'stack', style: 'border-top:1px solid var(--line-subtle);padding-top:12px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      await post('/v1/availability', { kind: a.kind.value, location_id: a.loc.value, weekday: Number(a.day.value), start_time: a.from.value, end_time: a.to.value, slot_minutes: Number(a.len.value), price_cents: a.price.value ? Math.round(Number(a.price.value) * 100) : undefined });
      toast('Hours added.'); render();
    }); } }, h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('For', a.kind), field('Where', a.loc), field('Day', a.day)),
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' }, field('From', a.from), field('To', a.to), field('Minutes each', a.len), field('Price ($)', a.price)),
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
      h('div', null, btn('Save settings', null, 'primary', { type: 'submit' }))));
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
    h('div', null, btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { public_signup: signupToggle.checked ? 'on' : 'off' }); toast(signupToggle.checked ? 'Sign-up is open.' : 'Sign-up is closed.'); render(); }), 'primary')));
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
    }, 'primary')));
  const EMAILS = { welcome: 'Welcome, when a family signs up or you add them', receipts: 'Receipts for sales and membership payments', trial_ending: 'Reminder 3 days before a free trial ends', payment_failed: 'When a membership payment doesn\'t go through' };
  const off = new Set((settings.emails_off ?? '').split(',').filter(Boolean));
  const emailBoxes = Object.entries(EMAILS).map(([k, label]) => [k, h('input', { type: 'checkbox', checked: !off.has(k) }), label]);
  const emailPanel = panel('Automatic emails', { subtitle: 'Sent from your email address once email is connected. Every email also appears in the outbox under API & integrations.' },
    emailBoxes.map(([, cb, label]) => h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, cb, h('span', null, label))),
    h('div', null, btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { emails_off: emailBoxes.filter(([, cb]) => !cb.checked).map(([k]) => k) }); toast('Saved.'); }), 'primary')));
  const TEXTS = { reminder: 'Reminder the day before a booked session', waitlist: 'When an athlete moves off the waitlist', canceled: 'When you cancel a session', payment_failed: 'When a membership payment doesn\'t go through' };
  const textsOff = new Set((settings.texts_off ?? '').split(',').filter(Boolean));
  const textBoxes = Object.entries(TEXTS).map(([k, label]) => [k, h('input', { type: 'checkbox', checked: !textsOff.has(k) }), label]);
  const textPanel = panel('Automatic texts', { subtitle: 'Only sent to parents who turn texts on in the parent portal. Every text also appears under API & integrations → Texts.' },
    textBoxes.map(([, cb, label]) => h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, cb, h('span', null, label))),
    h('div', null, btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { texts_off: textBoxes.filter(([, cb]) => !cb.checked).map(([k]) => k) }); toast('Saved.'); }), 'primary')));
  const digestOn = h('input', { type: 'checkbox', checked: settings.weekly_digest !== 'off' });
  const digestOut = h('pre', { class: 'small muted', style: 'white-space:pre-wrap;margin:0' });
  const digestPanel = panel('Weekly summary email', { subtitle: 'Every Monday at 7 am: money in, members, athletes to check on, open spots and three things worth doing this week. Sent to every owner.' },
    h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, digestOn, h('span', null, 'Send me the weekly summary')),
    h('div', { class: 'row wrap' },
      btn('Save', (e) => busy(e.currentTarget, async () => { await patch('/v1/settings', { weekly_digest: digestOn.checked ? 'on' : 'off' }); toast('Saved.'); }), 'primary'),
      btn('Preview this week', (e) => busy(e.currentTarget, async () => { digestOut.textContent = (await get('/v1/digest')).text; }), 'outline'),
      btn('Email it to me now', (e) => busy(e.currentTarget, async () => { await post('/v1/digest/send'); toast('Sent. It\'s also in the email outbox.'); }), 'ghost')),
    digestOut);
  fill(main, header('Hours & settings', 'Hours, policies, sign-up, terms, emails and texts.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule' }, 'Schedule')), hours, checkinPanel(locs.data, kiosks.data), setPanel, rankingsPanel(settings), readinessPanel(settings),
    isOwner() ? [signupPanel, legalPanel, digestPanel, emailPanel, textPanel] : null);
}

// ---------- Teams (school and club contracts) ----------
const INV_BADGE = { open: ['Open', 'neutral'], overdue: ['Overdue', 'warn'], paid: ['Paid', 'good'], void: ['Void', 'muted'] };
const invBadge = (st) => h('span', { class: `dp-badge dp-badge--${INV_BADGE[st]?.[1] ?? 'muted'}` }, INV_BADGE[st]?.[0] ?? st);
const ymd = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');

function invoiceRow(i, { showTeam = false } = {}) {
  const pay = btn('Record payment', (e) => {
    const how = prompt(`Record payment of ${money(i.amount_cents)} for ${i.number}. How was it paid? check, ach, card, cash or other`, 'check');
    if (!how) return;
    const method = how.trim().toLowerCase();
    const ref = method === 'check' ? prompt('Check number (optional):', '') : '';
    busy(e.currentTarget, async () => { await post(`/v1/team-invoices/${i.id}/payments`, { method, reference: ref || undefined }); toast(`${i.number} marked paid.`); render(); });
  }, 'outline');
  const unpaid = ['open', 'overdue'].includes(i.status);
  return h('div', { class: 'list-item', style: 'flex-wrap:wrap' },
    h('div', { class: 'grow stack-tight', style: 'min-width:240px' },
      h('span', { class: 'strong' }, `${i.number}${showTeam ? ` · ${i.org_name} ${i.team_name}` : ''}`),
      h('span', { class: 'small muted' }, i.status === 'paid' ? `Paid ${ymd(i.paid_on)} by ${i.paid_method}${i.paid_reference ? ` ${i.paid_reference}` : ''}`
        : `${i.period_start ? `${ymd(i.period_start)} – ${ymd(i.period_end)}` : i.lines[0]?.description ?? ''} · due ${ymd(i.due_on)}${unpaid ? (i.sent_at ? ` · emailed ${ago(i.sent_at)}` : ' · not emailed') : ''}`)),
    h('span', { class: 'strong' }, money(i.amount_cents)), invBadge(i.status),
    h('div', { class: 'row', style: 'gap:4px' }, h('a', { class: 'dp-btn dp-btn--ghost', href: i.link, target: '_blank', rel: 'noopener' }, 'View'),
    unpaid ? pay : null,
    unpaid ? btn('Email', (e) => busy(e.currentTarget, async () => { await post(`/v1/team-invoices/${i.id}/send`); toast(`${i.number} emailed.`); render(); }), 'ghost') : null,
    unpaid ? btn('Void', (e) => { if (confirm(`Void ${i.number}? It won't be collected.`)) busy(e.currentTarget, async () => { await post(`/v1/team-invoices/${i.id}/void`); toast('Voided.'); render(); }); }, 'ghost') : null));
}
const textarea = (value = '', attrs = {}) => { const t = h('textarea', { class: 'dp-input', style: 'min-height:72px', ...attrs }); t.value = value ?? ''; return t; };

async function viewTeams(main) {
  const [contracts, unpaid] = await Promise.all([get('/v1/team-contracts'), get('/v1/team-invoices?status=unpaid')]);
  const active = contracts.data.filter((c) => c.status === 'active');
  const monthly = active.reduce((t, c) => t + c.monthly_cents, 0);
  const open = unpaid.data.reduce((t, i) => t + i.amount_cents, 0), overdue = unpaid.data.filter((i) => i.status === 'overdue');
  fill(main,
    header('Teams', 'School and club contracts, billed a flat monthly fee.', h('a', { class: 'dp-btn dp-btn--primary', href: '#/teams/new' }, 'New team contract')),
    h('div', { class: 'metrics' },
      metric('Monthly contract revenue', money(monthly), `${active.length} active ${active.length === 1 ? 'team' : 'teams'}`),
      metric('Waiting on payment', money(open), `${unpaid.data.length} open ${unpaid.data.length === 1 ? 'invoice' : 'invoices'}`),
      metric('Overdue', money(overdue.reduce((t, i) => t + i.amount_cents, 0)), `${overdue.length} past due`, overdue.length ? 'warn' : null),
      metric('Athletes on rosters', active.reduce((t, c) => t + c.roster_count, 0), 'Across active teams')),
    panel('Contracts', {}, contracts.data.length ? contracts.data.map((c) => h('a', { class: 'list-item', href: `#/teams/${c.id}`, style: 'text-decoration:none;color:inherit' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, `${c.org_name} · ${c.name}`),
        h('span', { class: 'small muted' }, c.status === 'ended' ? `Ended ${ymd(c.end_date)}` : `${money(c.monthly_cents)}/month · Net ${c.terms_days} · ${c.roster_count} athletes${c.next_invoice_on ? ` · next invoice ${ymd(c.next_invoice_on)}` : ''}${c.contact_email ? '' : ' · add a billing email'}`)),
      c.overdue_cents ? h('span', { class: 'dp-badge dp-badge--warn' }, `${money(c.overdue_cents)} overdue`) : c.balance_cents ? h('span', { class: 'dp-badge dp-badge--neutral' }, `${money(c.balance_cents)} open`) : null,
      c.status === 'ended' ? h('span', { class: 'dp-badge dp-badge--muted' }, 'Ended') : null)) : h('div', { class: 'empty' }, 'No team contracts yet.')),
    unpaid.data.length ? panel('Unpaid invoices', { subtitle: 'Invoices email the school\'s billing contact with a link to view, print or pay online. Overdue ones get a reminder each week.' }, unpaid.data.map((i) => invoiceRow(i, { showTeam: true }))) : null);
}

async function viewNewTeam(main) {
  const orgs = await get('/v1/organizations');
  const orgSel = select([['', 'A new school or club…'], ...orgs.data.map((o) => [o.id, o.name])], { value: '' });
  const o = { name: input(), kind: select([['school', 'School'], ['club', 'Club'], ['other', 'Other']]), contact: input(), email: input({ type: 'email' }), phone: input({ type: 'tel' }), address: textarea() };
  const t = { name: input({ placeholder: 'Varsity Football' }), fee: input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }), start: input({ type: 'date', value: new Date().toISOString().slice(0, 10) }), end: input({ type: 'date' }),
    terms: select([['30', 'Net 30'], ['15', 'Net 15'], ['45', 'Net 45'], ['0', 'Due on receipt']]), po: input() };
  const orgBox = h('div', { class: 'stack' },
    h('div', { class: 'form-grid' }, field('School or club name', o.name), field('Type', o.kind)),
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('Billing contact', o.contact, 'Athletic director or treasurer'), field('Billing email', o.email, 'Invoices go here.'), field('Phone', o.phone)),
    field('Billing address', o.address));
  orgSel.addEventListener('change', () => { orgBox.style.display = orgSel.value ? 'none' : ''; });
  const err = h('div', { class: 'dp-error', role: 'alert' });
  fill(main,
    header('New team contract', 'A flat monthly fee, invoiced to the school or club at the start of each month of the contract.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/teams' }, 'Cancel')),
    h('form', { class: 'dp-panel stack', style: 'max-width:820px', onSubmit: (e) => { e.preventDefault(); err.textContent = ''; busy(e.submitter, async () => {
      try {
        const c = await post('/v1/team-contracts', { org_id: orgSel.value || undefined, organization: orgSel.value ? undefined : { name: o.name.value, kind: o.kind.value, contact_name: o.contact.value || undefined, contact_email: o.email.value || undefined, contact_phone: o.phone.value || undefined, billing_address: o.address.value || undefined },
          name: t.name.value, monthly_cents: Math.round(Number(t.fee.value) * 100), start_date: t.start.value, end_date: t.end.value || undefined, terms_days: Number(t.terms.value), po_number: t.po.value || undefined });
        toast(c.invoices.length ? `Contract created. ${c.invoices.length === 1 ? 'The first invoice' : `${c.invoices.length} invoices`} ${c.org.contact_email ? `emailed to ${c.org.contact_email}` : 'created (add a billing email to send)'}.` : `Contract created. First invoice goes out ${ymd(c.next_invoice_on)}.`);
        location.hash = `#/teams/${c.id}`;
      } catch (x) { err.textContent = x.message; }
    }); } },
      field('School or club', orgSel), orgBox,
      h('div', { class: 'form-grid' }, field('Team', t.name), field('Monthly fee ($)', t.fee)),
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' }, field('Start', t.start, 'Billing day each month'), field('End (optional)', t.end), field('Payment terms', t.terms), field('PO number', t.po)),
      h('p', { class: 'small muted' }, 'If the start date is today or earlier, the first month is invoiced as soon as you save. Months already past are invoiced too.'),
      err, h('div', null, btn('Create contract', null, 'primary', { type: 'submit' }))));
  o.name.focus();
}

async function viewTeam(main, id) {
  const [c, locs, settings, engPanel] = await Promise.all([get(`/v1/team-contracts/${id}`), get('/v1/locations'), get('/v1/settings'), teamPanel(id)]);
  tzName = settings.timezone;
  const ended = c.status === 'ended';
  const fee = input({ type: 'number', step: '0.01', value: (c.monthly_cents / 100).toFixed(2) }), end = input({ type: 'date', value: c.end_date ?? '' }), po = input({ value: c.po_number ?? '' });
  const terms = select([['30', 'Net 30'], ['15', 'Net 15'], ['45', 'Net 45'], ['0', 'Due on receipt']], { value: String(c.terms_days) });
  const ce = { name: input({ value: c.org.contact_name ?? '' }), email: input({ type: 'email', value: c.org.contact_email ?? '' }), phone: input({ value: c.org.contact_phone ?? '' }), addr: textarea(c.org.billing_address) };
  const contractPanel = panel('Contract', { subtitle: ended ? `Ended ${ymd(c.end_date)}` : `${money(c.monthly_cents)}/month since ${ymd(c.start_date)}${c.next_invoice_on ? ` · next invoice ${ymd(c.next_invoice_on)}` : ''}` },
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' }, field('Monthly fee ($)', fee, 'Applies from the next invoice.'), field('End date', end), field('Terms', terms), field('PO number', po)),
    h('div', { class: 'dp-label' }, `Billing contact at ${c.org.name}`),
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('Name', ce.name), field('Email', ce.email), field('Phone', ce.phone)), field('Billing address', ce.addr),
    h('div', { class: 'row wrap' }, btn('Save', (e) => busy(e.currentTarget, async () => {
      await patch(`/v1/organizations/${c.org.id}`, { contact_name: ce.name.value || null, contact_email: ce.email.value || null, contact_phone: ce.phone.value || null, billing_address: ce.addr.value || null });
      await patch(`/v1/team-contracts/${id}`, { monthly_cents: Math.round(Number(fee.value) * 100), end_date: end.value || null, terms_days: Number(terms.value), po_number: po.value || null });
      toast('Saved.'); render();
    })), h('span', { class: 'grow' }),
      ended ? btn('Reactivate', (e) => busy(e.currentTarget, async () => { await patch(`/v1/team-contracts/${id}`, { status: 'active', end_date: null }); render(); }), 'ghost')
        : btn('End contract', (e) => { if (confirm(`End ${c.org.name} ${c.name}? Invoicing stops and future team sessions are canceled. Unpaid invoices stay open.`)) busy(e.currentTarget, async () => { await patch(`/v1/team-contracts/${id}`, { status: 'ended' }); toast('Contract ended.'); render(); }); }, 'ghost')));

  const extraDesc = input({ placeholder: 'Saturday combine prep' }), extraAmt = input({ type: 'number', step: '0.01', placeholder: '0.00' });
  const invoicesPanel = panel('Invoices', { subtitle: c.balance_cents ? `${money(c.balance_cents)} unpaid` : 'All paid up.' },
    c.invoices.length ? c.invoices.map((i) => invoiceRow(i)) : h('p', { class: 'muted' }, `No invoices yet. The first goes out ${ymd(c.next_invoice_on)}.`),
    h('details', null, h('summary', { class: 'small', style: 'cursor:pointer;min-height:32px' }, 'Bill something extra'),
      h('form', { class: 'row wrap', style: 'margin-top:8px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
        const i = await post(`/v1/team-contracts/${id}/invoices`, { description: extraDesc.value, amount_cents: Math.round(Number(extraAmt.value) * 100) });
        toast(`${i.number} ${i.sent_at ? 'emailed' : 'created'}.`); render();
      }); } }, h('div', { class: 'grow' }, field('What for', extraDesc)), field('Amount ($)', extraAmt), h('div', { style: 'align-self:flex-end' }, btn('Create invoice', null, 'secondary', { type: 'submit' })))));

  const names = h('textarea', { class: 'dp-input', placeholder: 'One athlete per line: Name, position, grad year\nJalen Brooks, QB, 2027\nMarcus Hill, WR, 2028' });
  const rosterPanel = panel(`Roster · ${c.roster.length}`, { subtitle: c.sessions_held ? `Attendance across ${c.sessions_held} ${c.sessions_held === 1 ? 'session' : 'sessions'} so far` : 'Check athletes in from each team session.' },
    c.roster.length ? c.roster.map((r) => h('div', { class: 'list-item' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, r.name), h('span', { class: 'small muted' }, [r.athlete_id, r.position, r.grad_year ? `Class of ${r.grad_year}` : null].filter(Boolean).join(' · '))),
      c.sessions_held ? h('span', { class: 'small muted' }, `${r.sessions_attended}/${c.sessions_held} · ${Math.round((r.sessions_attended / c.sessions_held) * 100)}%`) : null,
      btn('Remove', (e) => busy(e.currentTarget, async () => { await del(`/v1/team-contracts/${id}/roster/${r.id}`); render(); }), 'ghost'))) : h('p', { class: 'muted' }, 'No athletes yet. Paste the team list below.'),
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { const r = await post(`/v1/team-contracts/${id}/roster`, { names: names.value }); toast(`Roster now has ${r.data.length} athletes.`); render(); }); } },
      names, h('div', null, btn('Add to roster', null, 'secondary', { type: 'submit' }))));

  const sd = { loc: select(locs.data.map((l) => [l.id, l.name])), time: input({ type: 'time', value: '15:30' }), dur: input({ type: 'number', value: '90', min: '10' }), start: input({ type: 'date', value: new Date().toISOString().slice(0, 10) }) };
  const days = DAY_NAMES.map((d, i) => h('label', { class: 'row small', style: 'gap:6px;min-height:36px' }, h('input', { type: 'checkbox', value: String(i) }), d));
  const schedPanel = panel('Team sessions', { subtitle: c.series.filter((x) => x.active).map((x) => `${x.weekdays.map((d) => DAY_NAMES[d]).join(', ')} at ${x.start_time}`).join(' · ') || 'Not on the schedule yet.', action: h('a', { class: 'dp-btn dp-btn--secondary', href: '#/schedule' }, 'Schedule') },
    ended || !locs.data.length ? null : h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const weekdays = days.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
      const x = await post(`/v1/team-contracts/${id}/sessions`, { location_id: sd.loc.value, weekdays, start_time: sd.time.value, duration_min: Number(sd.dur.value), start_date: sd.start.value });
      toast(`${x.upcoming_sessions} team sessions added to your schedule.`); render();
    }); } },
      h('div', { class: 'row wrap', style: 'gap:12px' }, days),
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' }, field('Where', sd.loc), field('Starts', sd.time), field('Minutes', sd.dur), field('First day', sd.start)),
      h('div', null, btn('Add team sessions', null, 'secondary', { type: 'submit' }))));

  fill(main,
    header(`${c.org.name}`, `${c.name} · ${money(c.monthly_cents)}/month${ended ? ' · ended' : ''}`, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/teams' }, 'All teams')),
    c.org.contact_email ? null : h('div', { class: 'test-banner', role: 'note' }, `Add a billing email for ${c.org.name} so invoices and reminders can be emailed.`),
    invoicesPanel,
    h('div', { class: 'grid grid-2' }, h('div', { class: 'stack', style: 'gap:24px' }, contractPanel, schedPanel), h('div', { class: 'stack', style: 'gap:24px' }, engPanel, rosterPanel)));
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
const PRESETS = [
  ['Combine', ['height', 'weight', 'dash_40yd', 'pro_agility', 'three_cone', 'vertical_standing', 'broad_jump']],
  ['Force plate', ['cmj', 'squat_jump', 'drop_jump', 'imtp']],
  ['Baseball showcase', ['height', 'weight', 'dash_60yd', 'dash_30yd', 'pitch_velocity', 'exit_velocity', 'infield_velocity', 'outfield_velocity', 'pop_time']],
  ['Basketball', ['height', 'wingspan', 'standing_reach', 'vertical_standing', 'vertical_max', 'lane_agility', 'nba_shuttle', 'three_quarter_court']],
  ['Hockey', ['grip', 'broad_jump', 'cmj', 'pro_agility', 'bench_reps_load', 'pull_ups', 'y_balance', 'wingate']],
  ['Soccer', ['sprint_10m', 'sprint_30m', 'cmj', 'five_oh_five', 'ift_30_15', 'yoyo_ir1']],
  ['Youth', ['height', 'seated_height', 'weight', 'sprint_5m', 'sprint_10m', 'vertical_standing', 'broad_jump', 'five_oh_five', 'plank', 'beep_test']]
];

async function viewTesting(main) {
  const [days, integrations, waiting] = await Promise.all([get('/v1/testing-sessions'), get('/v1/integrations'), get('/v1/queue')]);
  const connected = integrations.data.filter((i) => i.connected);
  fill(main,
    waiting.n ? h('div', { class: 'test-banner row', style: 'gap:12px' }, h('span', { class: 'grow' }, `${waiting.n} ${waiting.n === 1 ? 'result is' : 'results are'} waiting to be linked to a profile.`), h('a', { class: 'dp-btn dp-btn--outline', href: '#/testing/queue' }, 'Link them')) : null,
    header('Testing', 'Combines, evaluations and team testing. Enter results by hand or stopwatch, import files, or connect your devices.', h('div', { class: 'row' },
      h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing/library' }, 'Test library'), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing/connections' }, 'Devices'), h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing/upload' }, 'Upload results'), h('a', { class: 'dp-btn dp-btn--primary', href: '#/testing/new' }, 'New testing day'))),
    connected.length ? h('p', { class: 'small muted' }, `Connected: ${connected.map((i) => i.name.split(' (')[0]).join(', ')}.`) : null,
    panel('Testing days', {}, days.data.length ? days.data.map((d) => h('a', { class: 'list-item', href: `#/testing/${d.id}`, style: 'text-decoration:none;color:inherit' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, d.name), h('span', { class: 'small muted' }, `${ymd(d.date)} · ${d.athletes_count} athletes · ${d.tests.length} tests`)),
      h('span', { class: `dp-badge dp-badge--${d.results_count ? 'good' : 'muted'}` }, `${d.results_count} results`))) : h('div', { class: 'empty' }, 'No testing days yet. Start one, or import results from a device.')));
}

async function viewNewTesting(main) {
  const [lib, clientsList, contracts] = await Promise.all([get('/v1/tests'), get('/v1/clients'), get('/v1/team-contracts')]);
  const name = input({ value: 'Testing day' }), date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
  const team = select([['', 'Individual athletes'], ...contracts.data.filter((c) => c.status === 'active').map((c) => [c.id, `${c.org_name} ${c.name} (${c.roster_count})`])], { value: '' });
  const picked = new Set();
  const testBoxes = new Map();
  const byCat = lib.categories.map((cat) => [cat, lib.data.filter((t) => t.category === cat.key)]).filter(([, ts]) => ts.length);
  const testPicker = h('div', { class: 'stack' }, byCat.map(([cat, ts]) => h('details', null, h('summary', { class: 'strong', style: 'cursor:pointer;min-height:36px' }, cat.name),
    h('div', { class: 'row wrap', style: 'gap:4px 16px;margin:8px 0' }, ts.map((t) => { const cb = h('input', { type: 'checkbox', value: t.key }); testBoxes.set(t.key, cb); return h('label', { class: 'row small', style: 'gap:6px;min-height:32px' }, cb, t.name); })))));
  const presets = h('div', { class: 'row wrap' }, PRESETS.map(([label, keys]) => btn(label, () => { keys.forEach((k) => { const cb = testBoxes.get(k); if (cb) { cb.checked = true; cb.closest('details').open = true; } }); }, 'secondary')));
  const athleteList = h('div', { class: 'row wrap', style: 'gap:4px 16px' }, clientsList.data.filter((c) => c.status !== 'canceled').map((c) => {
    const cb = h('input', { type: 'checkbox', onChange: (e) => (e.target.checked ? picked.add(c.id) : picked.delete(c.id)) });
    return h('label', { class: 'row small', style: 'gap:6px;min-height:32px' }, cb, c.name);
  }));
  const athleteBox = h('div', { class: 'stack' }, h('div', { class: 'dp-label' }, 'Athletes (you can add walk-ups on the day)'), athleteList);
  team.addEventListener('change', () => { athleteBox.style.display = team.value ? 'none' : ''; });
  fill(main, header('New testing day', 'Pick the athletes and tests. Results can be entered by hand, by stopwatch, or pulled from devices.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Cancel')),
    h('form', { class: 'dp-panel stack', style: 'max-width:900px', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const tests = [...testBoxes.entries()].filter(([, cb]) => cb.checked).map(([k]) => k);
      if (!tests.length) throw new Error('Choose at least one test.');
      const d = await post('/v1/testing-sessions', { name: name.value, date: date.value, tests, contract_id: team.value || undefined, athletes: team.value ? undefined : [...picked].map((client_id) => ({ client_id })) });
      location.hash = `#/testing/${d.id}`;
    }); } },
      h('div', { class: 'form-grid', style: 'grid-template-columns:2fr 1fr 2fr' }, field('Name', name), field('Date', date), field('Team', team)),
      athleteBox, h('div', { class: 'dp-label' }, 'Tests'), h('div', { class: 'small muted' }, 'Start from a preset, then adjust.'), presets, testPicker,
      h('div', null, btn('Start testing day', null, 'primary', { type: 'submit' }))));
}

// Entry screen: one test at a time, every athlete's attempts, and a stopwatch for hand timing.
let testingState = { testKey: null, athleteIdx: 0 };
let stopwatchRunning = false;
async function viewTestingDay(main, id) {
  const [day, clientsList, notes] = await Promise.all([get(`/v1/testing-sessions/${id}`), get('/v1/clients'), get(`/v1/testing-sessions/${id}/notes`).catch(() => null)]);
  if (!day.tests.length) return fill(main, header(day.name, ymd(day.date)), h('div', { class: 'empty' }, 'No tests on this day.'));
  if (!day.tests.some((t) => t.key === testingState.testKey)) testingState = { testKey: day.tests[0].key, athleteIdx: 0 };
  const test = day.tests.find((t) => t.key === testingState.testKey);
  const metric = test.metrics[0];
  const units = metric.units;
  const unitSel = select(units.map((u) => [u, UNIT_LABEL[u] || u]), { value: metric.unit, 'aria-label': 'Unit' });
  const sides = test.sides === 'lr' ? ['L', 'R'] : [null];
  const hand = h('input', { type: 'checkbox', checked: !!test.timed });
  const athletes = day.athletes;
  const who = (a) => (a.client_id ? { client_id: a.client_id } : { roster_id: a.roster_id });
  const results = (a, side) => a.results.filter((r) => r.test_id === test.id && r.metric === metric.key && (r.side ?? null) === side);
  const bestOf = (rs) => (rs.length ? (metric.better === 'lower' ? Math.min(...rs.map((r) => r.value)) : Math.max(...rs.map((r) => r.value))) : null);

  async function save(a, side, value, attempt, timing) {
    const r = await post('/v1/results', { session_id: id, results: [{ ...who(a), test: test.key, metric: metric.key, value, unit: unitSel.value, side, attempt, timing, recorded_at: `${day.date}T${new Date().toISOString().slice(11)}` }] });
    if (r.errors.length) throw new Error(r.errors[0].message);
    if (r.prs.length) toast(`New PR for ${a.name.split(' ')[0]}: ${fmtResult(r.prs[0].value, metric.unit, metric.decimals)}`);
    return r;
  }
  const rows = athletes.map((a, idx) => sides.map((side) => {
    const rs = results(a, side);
    const inputs = [];
    for (let n = 1; n <= Math.max(test.attempts, rs.length + (rs.length >= test.attempts ? 0 : 0)); n++) {
      const existing = rs[n - 1];
      const inp = input({ type: 'number', step: 'any', inputmode: 'decimal', value: existing ? String(+existing.value.toFixed(metric.decimals + 1)) : '', disabled: !!existing, style: 'width:92px', 'aria-label': `${a.name}${side ? ` ${side}` : ''} attempt ${n}` });
      if (!existing) inp.addEventListener('change', () => busy(inp, async () => { if (inp.value === '') return; await save(a, side, Number(inp.value), n, test.timed && hand.checked ? 'hand' : test.timed ? 'electronic' : undefined); render(); }));
      if (existing) inputs.push(h('span', { class: 'row', style: 'gap:2px' }, inp, btn('×', (e) => { if (confirm('Delete this attempt?')) busy(e.currentTarget, async () => { await del(`/v1/results/${existing.id}`); render(); }); }, 'ghost', { 'aria-label': 'Delete attempt', style: 'min-width:28px;padding:0 6px' })));
      else inputs.push(inp);
    }
    const best = bestOf(rs);
    const up = test.timed && testingState.athleteIdx === idx;
    return h('div', { class: 'list-item', style: `flex-wrap:wrap;${up ? 'outline:2px solid var(--green-mid);outline-offset:-2px;border-radius:6px' : ''}` },
      test.timed && side === sides[0] ? btn(up ? 'Up' : 'Time', () => { if (stopwatchRunning) return toast('Stop the clock first.', 'warn'); testingState.athleteIdx = idx; render(); }, up ? 'primary' : 'ghost', { 'aria-label': `Time ${a.name} next`, style: 'min-width:64px' }) : test.timed ? h('span', { style: 'min-width:64px' }) : null,
      h('div', { class: 'grow stack-tight', style: 'min-width:160px' }, h('span', { class: 'strong' }, a.name), h('span', { class: 'small muted' }, [a.athlete_id, side ? (side === 'L' ? 'Left' : 'Right') : null].filter(Boolean).join(' · '))),
      h('div', { class: 'row wrap', style: 'gap:6px' }, inputs),
      h('span', { class: 'strong', style: 'min-width:90px;text-align:right' }, best == null ? '' : fmtResult(best, metric.unit, metric.decimals)));
  }));

  // Stopwatch: Start, then Stop records the time into the selected athlete's next open attempt and moves to the next athlete.
  let stopwatch = null;
  if (test.timed) {
    const display = h('div', { style: 'font:700 44px/1 var(--font-mono);color:var(--steel);min-width:180px' }, '0.00');
    let t0 = null, raf = null;
    const cur = athletes[testingState.athleteIdx];
    const tick = () => { display.textContent = ((performance.now() - t0) / 1000).toFixed(2); raf = requestAnimationFrame(tick); };
    const go = btn('Start', async () => {
      if (!cur) return toast('Add an athlete first.', 'warn');
      if (t0 == null) { t0 = performance.now(); stopwatchRunning = true; go.textContent = 'Stop'; tick(); return; }
      cancelAnimationFrame(raf); stopwatchRunning = false;
      const secs = Number(((performance.now() - t0) / 1000).toFixed(2));
      t0 = null; go.textContent = 'Start'; display.textContent = secs.toFixed(2);
      const side = sides.find((sd) => results(cur, sd).length < test.attempts) ?? sides[0];
      await save(cur, side, secs, results(cur, side).length + 1, 'hand');
      const done = sides.every((sd) => results(cur, sd).length + (sd === side ? 1 : 0) >= test.attempts);
      if (done) testingState.athleteIdx = Math.min(athletes.length - 1, testingState.athleteIdx + 1);
      render();
    }, 'primary', { style: 'min-width:140px;min-height:64px;font-size:22px' });
    stopwatch = panel('Stopwatch', { subtitle: cur ? `Up: ${cur.name}. Tap Time next to anyone to switch. Stopping the clock saves the time and moves to the next athlete.` : null },
      h('div', { class: 'row wrap', style: 'gap:16px;align-items:center' }, display, go, h('span', { class: 'small muted' }, 'Hand times usually read faster than electronic gates, so the app keeps them labeled.')));
  }
  const add = select([['', 'Add a walk-up athlete…'], ...clientsList.data.filter((c) => !athletes.some((a) => a.client_id === c.id)).map((c) => [c.id, c.name])], { 'aria-label': 'Add athlete' });
  add.addEventListener('change', () => busy(add, async () => {
    await patch(`/v1/testing-sessions/${id}`, { athletes: [...athletes.map(who), { client_id: add.value }] }); render();
  }));
  fill(main,
    header(day.name, `${ymd(day.date)} · ${athletes.length} athletes`, h('div', { class: 'row' },
      day.shared_at ? btn('Shared with parents ✓', (e) => { if (confirm('Hide these results from families again?')) busy(e.currentTarget, async () => { await del(`/v1/testing-sessions/${id}/share`); toast('Hidden from families.'); render(); }); }, 'outline')
        : btn('Share with parents', (e) => { const note = prompt('A note for families (optional). It appears on their report and in the email.', day.parent_note ?? ''); if (note === null) return; busy(e.currentTarget, async () => { const r = await post(`/v1/testing-sessions/${id}/share`, { parent_note: note }); toast(`Shared. ${r.families_notified} ${r.families_notified === 1 ? 'family' : 'families'} emailed.`); render(); }); }, 'primary'),
      btn('Download sheet', (e) => busy(e.currentTarget, () => download(`/v1/uploads/template?session_id=${id}`)), 'secondary'),
      h('a', { class: 'dp-btn dp-btn--secondary', href: `#/testing/upload?session=${id}` }, 'Upload results'),
      h('a', { class: 'dp-btn dp-btn--ghost', href: '#/testing' }, 'All testing days'))),
    h('div', { class: 'p-chips', style: 'display:flex;gap:8px;overflow-x:auto' }, day.tests.map((t) => btn(t.name.replace(/ \(.*\)$/, ''), () => { if (stopwatchRunning) return toast('Stop the clock first.', 'warn'); testingState = { testKey: t.key, athleteIdx: 0 }; render(); }, t.key === test.key ? 'primary' : 'secondary', { style: 'white-space:nowrap;flex-shrink:0' }))),
    stopwatch,
    panel(test.name, { subtitle: `${metric.name}${metric.better !== 'none' ? ` · ${metric.better} is better` : ''} · ${test.attempts} ${test.attempts === 1 ? 'attempt' : 'attempts'}${test.sides === 'lr' ? ' per side' : ''}. Values save as you type.`,
      action: h('div', { class: 'row' }, test.timed ? h('label', { class: 'row small', style: 'gap:6px' }, hand, 'Hand-timed') : null, h('div', { style: 'width:110px' }, unitSel)) },
      test.description ? h('p', { class: 'small muted' }, test.description) : null,
      athletes.length ? rows : h('p', { class: 'muted' }, 'No athletes yet.'),
      h('div', { style: 'max-width:360px;margin-top:8px' }, add)),
    notes?.data.length ? notesPanel(id, notes) : null);
}

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

async function viewLibrary(main) {
  const lib = await get('/v1/tests?include_inactive=true');
  const n = input(), u = input({ placeholder: 's, in, lb, mph…' }), better = select([['lower', 'Lower is better'], ['higher', 'Higher is better']]), cat = select(lib.categories.map((c) => [c.key, c.name]));
  fill(main, header('Test library', `${lib.data.filter((t) => t.active).length} tests ready. Hide the ones you don't use, or add your own.`, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing')),
    ...lib.categories.map((c) => { const ts = lib.data.filter((t) => t.category === c.key); return ts.length ? panel(c.name, {}, ts.map((t) => h('div', { class: 'list-item', style: t.active ? '' : 'opacity:.55' },
      h('div', { class: 'grow stack-tight' }, h('span', { class: 'strong' }, t.name, t.builtin ? null : h('span', { class: 'small muted' }, ' (yours)')),
        h('span', { class: 'small muted' }, t.metrics.map((m) => `${m.name} (${UNIT_LABEL[m.unit] || m.unit || 'score'}${m.better === 'none' ? '' : m.better === 'lower' ? ', lower better' : ', higher better'})`).join(' · ')),
        t.description ? h('span', { class: 'small muted' }, t.description) : null),
      btn(t.active ? 'Hide' : 'Show', (e) => busy(e.currentTarget, async () => { await patch(`/v1/tests/${t.key}`, { active: !t.active }); render(); }), 'ghost')))) : null; }),
    panel('Add your own test', {}, h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { const t = await post('/v1/tests', { name: n.value, unit: u.value, better: better.value, category: cat.value }); toast(`${t.name} added.`); render(); }); } },
      h('div', { class: 'form-grid', style: 'grid-template-columns:2fr 1fr 1fr 1fr' }, field('Name', n), field('Unit', u), field('Scoring', better), field('Category', cat)),
      h('div', null, btn('Add test', null, 'primary', { type: 'submit' })))));
}

async function viewConnections(main) {
  const [integ, imports, lib, clientsList] = await Promise.all([get('/v1/integrations'), get('/v1/imports'), get('/v1/tests'), get('/v1/clients')]);
  const hawkin = integ.data.find((i) => i.provider === 'hawkin');
  const token = input({ type: 'password', autocomplete: 'off', placeholder: 'Integration token from Hawkin' }), region = select([['americas', 'Americas'], ['europe', 'Europe'], ['apac', 'Asia-Pacific']], { value: hawkin.region ?? 'americas' });
  const hawkinPanel = panel('Hawkin Dynamics force plates', { subtitle: hawkin.connected ? `Connected (${hawkin.token_hint}). ${hawkin.last_sync_at ? `Last sync ${ago(hawkin.last_sync_at)}.` : ''} New tests sync every 15 minutes.` : hawkin.note },
    hawkin.last_error ? h('p', { class: 'small warn-text' }, hawkin.last_error) : null,
    hawkin.connected ? h('div', { class: 'row' },
      btn('Sync now', (e) => busy(e.currentTarget, async () => { const r = await post('/v1/integrations/hawkin/sync'); toast(`${r.results} new results${r.waiting_for_match ? `, ${r.waiting_for_match} waiting for an athlete match` : ''}.`); render(); }), 'primary'),
      btn('Disconnect', (e) => { if (confirm('Disconnect Hawkin?')) busy(e.currentTarget, async () => { await del('/v1/integrations/hawkin'); render(); }); }, 'ghost'))
      : h('form', { class: 'row wrap', onSubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => { const r = await api('PUT', '/v1/integrations/hawkin', { refresh_token: token.value, region: region.value }); toast(`Connected. ${r.sync.results} results pulled from the last 90 days.`); render(); }); } },
        h('div', { class: 'grow' }, field('Integration token', token)), field('Region', region), h('div', { style: 'align-self:flex-end' }, btn('Connect', null, 'primary', { type: 'submit' }))));

  // File import: pick system + file, preview how columns match, fix anything, import.
  const provider = select(integ.data.filter((i) => i.how === 'file').map((i) => [i.provider, i.name]), { value: 'ovr' });
  const oneTest = select([['', 'Detect from the file'], ...lib.data.map((t) => [t.key, t.name])], { value: '' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv,.txt', class: 'dp-input' });
  const note = h('p', { class: 'small muted' }, integ.data.find((i) => i.provider === 'ovr').note);
  provider.addEventListener('change', () => { note.textContent = integ.data.find((i) => i.provider === provider.value).note ?? 'Export a CSV from the system and upload it.'; });
  const preview = h('div', { class: 'stack' });
  let csvText = '', fileName = '';
  const testOpts = [['', 'Ignore'], ...lib.data.flatMap((t) => t.metrics.map((m) => [`${t.key}|${m.key}`, `${t.name} – ${m.name}`]))];
  async function runPreview() {
    if (!file.files[0]) throw new Error('Choose a file.');
    csvText = await file.files[0].text(); fileName = file.files[0].name;
    const dry = await post('/v1/imports', { provider: provider.value, csv: csvText, test: oneTest.value || undefined, dry_run: true, filename: fileName });
    const colSelects = {};
    const colRows = Object.entries(dry.mapping.columns).map(([hdr, col]) => {
      const current = col ? (col.metric_name ? '__row__' : `${col.test ?? dry.mapping.test}|${col.metric}`) : '';
      const sel = select(col?.metric_name ? [['__row__', 'Metric for each row\'s test'], ['', 'Ignore']] : testOpts, { value: current, 'aria-label': hdr });
      colSelects[hdr] = { sel, col };
      return h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, hdr), h('div', { style: 'width:340px' }, sel), col?.side ? h('span', { class: 'muted' }, col.side === 'L' ? 'Left' : 'Right') : null);
    });
    const testSelects = Object.entries(dry.mapping.tests ?? {}).map(([name, key]) => { const sel = select([['', 'Skip these rows'], ...lib.data.map((t) => [t.key, t.name])], { value: key ?? '' }); return [name, sel]; });
    fill(preview,
      h('p', null, `${dry.rows} rows, ${dry.results_found} results found. `, dry.saved_mapping ? h('span', { class: 'good-text' }, 'Using your saved column matches for this layout.') : null),
      dry.problems.length ? h('p', { class: 'small warn-text' }, dry.problems.slice(0, 3).map((p) => `Row ${p.row}: ${p.message}`).join(' ')) : null,
      h('div', { class: 'dp-label' }, `Columns → tests (athlete: ${dry.mapping.roles.athlete_name ?? [dry.mapping.roles.first_name, dry.mapping.roles.last_name].filter(Boolean).join(' + ') ?? 'not found'}, date: ${dry.mapping.roles.date ?? 'none, uses today'})`),
      colRows,
      testSelects.length ? [h('div', { class: 'dp-label' }, 'Test names in the file'), ...testSelects.map(([name, sel]) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, name), h('div', { style: 'width:340px' }, sel)))] : null,
      dry.unmatched_athletes.length ? h('p', { class: 'small' }, `${dry.unmatched_athletes.length} ${dry.unmatched_athletes.length === 1 ? 'athlete isn\'t' : 'athletes aren\'t'} matched yet (${dry.unmatched_athletes.slice(0, 5).map((a) => a.name ?? a.external_id).join(', ')}${dry.unmatched_athletes.length > 5 ? '…' : ''}). Their results wait below until you match them.`) : null,
      btn(`Import ${dry.results_found} results`, (e) => busy(e.currentTarget, async () => {
        const mapping = { ...dry.mapping, columns: Object.fromEntries(Object.entries(colSelects).map(([hdr, { sel, col }]) => {
          if (!sel.value) return [hdr, null];
          if (sel.value === '__row__') return [hdr, col];
          const [test, metric] = sel.value.split('|');
          return [hdr, { test, metric, unit: col?.unit, side: col?.side }];
        })), tests: Object.fromEntries(testSelects.map(([name, sel]) => [name, sel.value || null])) };
        const r = await post('/v1/imports', { provider: provider.value, csv: csvText, mapping, filename: fileName });
        toast(`${r.imported} results imported${r.duplicates ? `, ${r.duplicates} already here` : ''}${r.pending_results ? `, ${r.pending_results} waiting for athlete matches` : ''}.`);
        render();
      }), 'primary'));
  }
  const importPanel = panel('Import a file', { subtitle: 'OVR, VALD, Swift, Freelap, Brower, Dashr, Rapsodo, radar guns or any spreadsheet. Column matches are remembered for next time.' },
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('System', provider), field('File', file), field('If the file is one test', oneTest)), note,
    h('div', null, btn('Preview', (e) => busy(e.currentTarget, runPreview), 'secondary')), preview);

  const [waitingQ, links] = await Promise.all([get('/v1/queue'), get('/v1/athlete-links')]);
  const waitingPanel = waitingQ.n ? panel('Waiting to be linked', { subtitle: `${waitingQ.n} results from ${waitingQ.groups} unrecognized ${waitingQ.groups === 1 ? 'athlete' : 'athletes'}. Nothing lands in a profile until you link it.` },
    h('a', { class: 'dp-btn dp-btn--primary', href: '#/testing/queue' }, 'Link them')) : null;
  const linksPanel = panel('Linked device IDs', { subtitle: 'Results from these device IDs and names go straight to the athlete. Everything else needs an Athlete ID or waits for you.' },
    links.data.length ? links.data.map((l) => h('div', { class: 'list-item small' },
      h('span', { class: 'grow' }, `${integ.data.find((i) => i.provider === l.provider)?.name.split(' (')[0] ?? l.provider}: ${l.external_id.startsWith('name:') ? `name "${l.external_name ?? l.external_id.slice(5)}"` : `ID ${l.external_id}`}${l.external_name && !l.external_id.startsWith('name:') ? ` (${l.external_name})` : ''}`),
      h('span', null, '→ ', l.athlete_name), idChip(l.athlete_id),
      btn('Unlink', (e) => { if (confirm(`Stop sending results from ${l.external_id.replace(/^name:/, '')} to ${l.athlete_name}? Future results from it will wait in the queue.`)) busy(e.currentTarget, async () => { await del(`/v1/athlete-links/${l.provider}/${encodeURIComponent(l.external_id)}`); render(); }); }, 'ghost')))
      : h('p', { class: 'muted small' }, 'None yet. Links are created when you link waiting results and choose to remember them.'));
  const example = `curl -X POST ${location.origin}/v1/results \\
  -H "Authorization: Bearer dp_live_..." -H "Content-Type: application/json" \\
  -d '{"provider":"gates","results":[{"athlete":{"external_id":"A-17","name":"Jordan Ellis"},
       "test":"dash_40yd","value":4.71,"timing":"electronic","external_id":"run-8812"}]}'`;
  const apiPanel = panel('Send results from any system', { subtitle: 'Any timing system, app or script can post results to the open API with an API key. Values in other units are converted, athletes are matched by ID or name, and resending the same result is ignored.' },
    h('pre', { class: 'small', style: 'white-space:pre-wrap;overflow-x:auto;background:var(--ground);padding:12px;border-radius:6px' }, example),
    h('div', { class: 'row' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/integrations' }, 'API keys'), h('a', { class: 'dp-btn dp-btn--ghost', href: '/v1/openapi.json', target: '_blank' }, 'Full API reference')));

  fill(main, header('Devices & imports', 'Get results in from anywhere: live connections, file imports, the open API, or by hand.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing')),
    waitingPanel, hawkinPanel,
    panel('Import a file', { subtitle: 'OVR, VALD, Swift, Freelap, Brower, Dashr, Rapsodo, radar guns, our template or any spreadsheet.' }, h('p', { class: 'small muted' }, integ.data.find((i) => i.provider === 'ovr').note), h('div', null, h('a', { class: 'dp-btn dp-btn--primary', href: '#/testing/upload' }, 'Upload results'))),
    apiPanel, linksPanel,
    imports.data.length ? panel('Recent imports', {}, imports.data.slice(0, 10).map((b) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, `${b.provider_name} · ${b.filename ?? 'sync'}`), h('span', null, `${b.imported} imported${b.duplicates ? ` · ${b.duplicates} duplicates` : ''}${b.pending_results ? ` · ${b.pending_results} waiting to link` : ''}`), h('span', { class: 'muted' }, ago(b.created_at))))) : null);
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
  const backupPanel = panel('Backups', { subtitle: `A full copy of everything is saved every day, and the last 30 are kept. Download one now and then and keep it somewhere safe, off this server.` },
    bk.data.length ? bk.data.slice(0, 7).map((b) => h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, new Date(b.created_at).toLocaleString()), h('span', { class: 'muted' }, kb(b.bytes)),
      btn('Download', (ev) => busy(ev.currentTarget, () => download(`/v1/backups/${b.name}`)), 'ghost'))) : h('p', { class: 'muted small' }, 'No backups yet.'),
    h('div', null, btn('Back up now', (ev) => busy(ev.currentTarget, async () => { await post('/v1/backups'); toast('Backup saved.'); render(); }), 'secondary')),
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
  fill(main, header('Staff & security', 'Who can sign in, what they can do, what happened, your backups, background jobs and data requests.'), staffPanel, openReqs.length ? reqPanel : null, h('div', { class: 'grid grid-2' }, backupPanel, openReqs.length ? h('div') : reqPanel), jobsPanel, auditPanel);
}

// Waiting results: arrived without an Athlete ID or a device link. The coach links them by hand.
async function viewQueue(main) {
  const [q, clientsList, contracts] = await Promise.all([get('/v1/queue'), get('/v1/clients'), get('/v1/team-contracts')]);
  const everyone = clientsList.data.map((c) => ({ client_id: c.id, name: c.name, athlete_id: c.athlete_id }));
  for (const c of contracts.data.filter((x) => x.status === 'active')) everyone.push(...(await get(`/v1/team-contracts/${c.id}`)).roster.map((r) => ({ roster_id: r.id, name: r.name, athlete_id: r.athlete_id, team: `${c.org_name} ${c.name}` })));
  everyone.sort((a, b) => a.name.localeCompare(b.name));
  const listId = 'athlete-options';
  const datalist = h('datalist', { id: listId }, everyone.map((a) => h('option', { value: `${a.name} · ${a.athlete_id}${a.team ? ` · ${a.team}` : ''}` })));
  // The picker only accepts a real athlete: the Athlete ID must be in the text.
  const pickFrom = (text) => { const id = String(text).match(/[A-Za-z]{6}\d{4}(-\d{1,3})?/)?.[0]?.toUpperCase(); return id ? everyone.find((a) => a.athlete_id === id) ?? null : null; };
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

  const cards = q.data.map((g) => {
    const who = input({ list: listId, placeholder: 'Type a name or Athlete ID, then pick from the list', autocomplete: 'off', 'aria-label': `Athlete for ${g.label}` });
    const chosen = h('span', { class: 'small' });
    const remember = h('input', { type: 'checkbox', checked: true });
    const checks = g.items.map((it) => { const cb = h('input', { type: 'checkbox', checked: true, 'aria-label': `Include ${it.test_name} ${it.value}` }); return [it, cb]; });
    const linkBtn = btn(`Link ${g.count} results`, null, 'primary');
    const sync = () => {
      const a = pickFrom(who.value);
      chosen.textContent = a ? `✓ ${a.name} (${a.athlete_id})` : who.value ? 'Pick an athlete from the list.' : '';
      chosen.className = a ? 'small good-text' : 'small warn-text';
      const n = checks.filter(([, cb]) => cb.checked).length, all = n === g.items.length;
      remember.disabled = !all; if (!all) remember.checked = false;
      linkBtn.textContent = `Link ${n} ${n === 1 ? 'result' : 'results'}`;
      linkBtn.disabled = !a || n === 0;
    };
    who.addEventListener('input', sync);
    checks.forEach(([, cb]) => cb.addEventListener('change', sync));
    linkBtn.addEventListener('click', () => busy(linkBtn, async () => {
      const a = pickFrom(who.value);
      if (!a) throw new Error('Pick the athlete from the list.');
      const sel = checks.filter(([, cb]) => cb.checked).map(([it]) => it);
      const all = sel.length === g.items.length;
      if (!confirm(`Link ${sel.length} ${sel.length === 1 ? 'result' : 'results'} from "${g.label}" (${g.source_name}) to ${a.name} (${a.athlete_id})?${all && remember.checked ? `\n\nFuture results from ${g.device_id ? `device ID ${g.device_id}` : `"${g.label}"`} will go straight to ${a.name}.` : ''}`)) return;
      const body = { athlete_id: a.athlete_id, ...(all ? { provider: g.provider, identity: g.identity, expect_count: g.count, remember: remember.checked } : { ids: sel.map((it) => it.id) }) };
      const r = await post('/v1/queue/link', body);
      toast(`${r.saved} ${r.saved === 1 ? 'result' : 'results'} added to ${r.athlete.name}${r.prs ? `, ${r.prs} new PR${r.prs === 1 ? '' : 's'}` : ''}${r.remembered ? '. Future results will go straight there.' : '.'}`);
      render();
    }));
    const discardBtn = btn('Discard selected', (e) => {
      const sel = checks.filter(([, cb]) => cb.checked).map(([it]) => it.id);
      if (!sel.length) return toast('Select results to discard.', 'warn');
      if (confirm(`Discard ${sel.length} ${sel.length === 1 ? 'result' : 'results'} from "${g.label}"? They won't be added to any profile.`)) busy(e.currentTarget, async () => { await post('/v1/queue/discard', { ids: sel }); toast('Discarded.'); render(); });
    }, 'ghost');
    const card = panel(g.label, { subtitle: `${g.source_name}${g.device_id && g.device_id !== g.label ? ` · device ID ${g.device_id}` : ''} · ${g.count} ${g.count === 1 ? 'result' : 'results'} · received ${ago(g.first_received)}${ago(g.last_received) !== ago(g.first_received) ? ` to ${ago(g.last_received)}` : ''}` },
      g.suggestions.length ? h('div', { class: 'row wrap small', style: 'gap:8px' }, h('span', { class: 'muted' }, 'Could be:'), g.suggestions.map((sug) => btn(`${sug.name} (${sug.athlete_id})`, () => { who.value = `${sug.name} · ${sug.athlete_id}`; sync(); }, 'secondary'))) : null,
      h('div', { class: 'row wrap', style: 'gap:12px;align-items:center' }, h('div', { class: 'grow', style: 'min-width:280px' }, who), chosen),
      h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Test'), h('th', null, 'Result'), h('th', null, 'Tested'), h('th', null, 'Device'))),
        h('tbody', null, checks.map(([it, cb]) => h('tr', null, h('td', null, cb),
          h('td', null, `${it.test_name}${it.metric_name && it.metric !== 'time' && it.metric !== 'value' ? ` – ${it.metric_name}` : ''}${it.side ? ` (${it.side === 'L' ? 'left' : 'right'})` : ''}`),
          h('td', { class: 'strong' }, fmtResult(it.value, it.unit, it.decimals)), h('td', null, fmtDay(it.recorded_at)), h('td', { class: 'muted' }, it.device ?? '')))))),
      h('label', { class: 'row small', style: 'gap:8px;min-height:36px' }, remember, h('span', null, `Remember: send future results from ${g.device_id ? `device ID ${g.device_id}` : `"${g.label}"`} (${g.source_name}) straight to this athlete`)),
      h('div', { class: 'row wrap' }, linkBtn, discardBtn));
    sync();
    return card;
  });
  fill(main, header('Waiting to be linked', 'These results arrived without an Athlete ID or a device you\'ve linked. None of them are in a profile yet.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing')),
    datalist,
    q.data.length ? h('p', { class: 'small muted' }, 'Pick who each set belongs to and link it. Linking is all or nothing, and nothing is ever matched by name on its own. Tip: enter Athlete IDs as names on your devices and results skip this step.') : null,
    ...(q.data.length ? cards : [h('div', { class: 'empty' }, 'Nothing is waiting. Every result has been linked to a profile.')]));
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
let uploadState = null;
async function viewUpload(main) {
  const qs = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const [days, lib, contracts, clientsList] = await Promise.all([get('/v1/testing-sessions'), get('/v1/tests'), get('/v1/team-contracts'), get('/v1/clients')]);

  // Step 1: template
  const daySel = select([['', 'No testing day'], ...days.data.map((d) => [d.id, `${d.name} (${ymd(d.date)})`])], { value: qs.get('session') ?? '' });
  const teamSel = select([['', 'Choose athletes later'], ...contracts.data.filter((c) => c.status === 'active').map((c) => [c.id, `${c.org_name} ${c.name}`])]);
  const presetSel = select(PRESETS.map(([label], i) => [String(i), label]));
  const tplOpts = h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(2,minmax(0,1fr))' }, field('Team', teamSel), field('Tests', presetSel));
  const sync = () => { tplOpts.style.display = daySel.value ? 'none' : ''; };
  daySel.addEventListener('change', sync); sync();
  const tplQuery = () => (daySel.value ? `session_id=${daySel.value}` : `tests=${PRESETS[Number(presetSel.value)][1].join(',')}${teamSel.value ? `&contract_id=${teamSel.value}` : `&client_ids=${clientsList.data.filter((c) => c.status !== 'canceled').map((c) => c.id).join(',')}`}`);
  const step1 = panel('1. Get the sheet', { subtitle: 'Every athlete\'s ID is filled in, with a column for each test and attempt. Fill it in on paper, a laptop, or a phone.' },
    field('Testing day', daySel), tplOpts,
    h('div', { class: 'row wrap' }, btn('Download Excel', (e) => busy(e.currentTarget, () => download(`/v1/uploads/template?${tplQuery()}`)), 'primary'), btn('Download CSV (Google Sheets)', (e) => busy(e.currentTarget, () => download(`/v1/uploads/template?${tplQuery()}&format=csv`)), 'ghost')));

  // Step 2: upload
  const file = h('input', { type: 'file', accept: '.xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'dp-input' });
  const paste = h('textarea', { class: 'dp-input', placeholder: 'Or paste rows straight from Excel or Google Sheets, header row included.', style: 'min-height:90px' });
  const oneTest = select([['', 'It\'s our sheet or has test columns'], ...lib.data.map((t) => [t.key, t.name])]);
  const upDay = select([['', 'No testing day'], ...days.data.map((d) => [d.id, `${d.name} (${ymd(d.date)})`])], { value: qs.get('session') ?? '' });
  const upDate = input({ type: 'date', value: new Date().toISOString().slice(0, 10), max: new Date().toISOString().slice(0, 10) });
  async function doPreview() {
    const body = { session_id: upDay.value || undefined, test: oneTest.value || undefined, date: upDate.value || undefined };
    if (file.files[0]) {
      body.filename = file.files[0].name;
      if (/\.xlsx$/i.test(file.files[0].name)) body.xlsx_base64 = toBase64(await file.files[0].arrayBuffer());
      else if (/\.xls$/i.test(file.files[0].name)) throw new Error('That\'s an old .xls file. In Excel, choose File → Save As → Excel Workbook (.xlsx), then upload it.');
      else body.csv = await file.files[0].text();
    } else if (paste.value.trim()) { body.csv = paste.value; body.filename = 'Pasted rows'; }
    else throw new Error('Choose a file or paste your rows.');
    uploadState = { ...(await post('/v1/uploads/preview', body)), filename: body.filename, confirmed: new Set(), saved: null };
    render();
  }
  const step2 = panel('2. Upload it', { subtitle: 'Every row needs a real Athlete ID and every value has to fit its test. If anything is off, nothing is saved and you\'ll see exactly what to fix.' },
    field('File (Excel or CSV)', file), paste,
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, field('Add to testing day', upDay), field('Date for rows without one', upDate), field('Device export with one test?', oneTest)),
    h('div', null, btn('Check the sheet', (e) => busy(e.currentTarget, () => doPreview()), 'primary')));

  // Step 3: results of the check
  let step3 = null;
  const st = uploadState;
  const problemTable = (list) => h('div', { style: 'overflow-x:auto' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', null, 'Row'), h('th', null, 'Column'), h('th', null, 'Athlete'), h('th', null, 'What to fix'))),
    h('tbody', null, list.map((e) => h('tr', null, h('td', null, e.row ?? '—'), h('td', null, e.column ?? '—'), h('td', { style: 'font-family:var(--font-mono)' }, e.athlete_id ?? ''), h('td', null, e.message))))));
  const again = h('div', { class: 'row' }, btn('Upload the fixed sheet', () => { uploadState = null; render(); }, 'primary'));
  if (st?.saved) {
    step3 = panel('Saved', { subtitle: `${st.saved.saved} results added to ${st.saved.athletes.length} ${st.saved.athletes.length === 1 ? 'athlete' : 'athletes'}${st.saved.prs ? `, ${st.saved.prs} new PRs` : ''}${st.saved.already_saved ? `. ${st.saved.already_saved} were already saved from an earlier upload.` : '.'}` },
      st.saved.athletes.map((a) => h('a', { class: 'list-item', href: a.client_id ? `#/clients/${a.client_id}` : `#/teams/${a.contract_id}`, style: 'text-decoration:none;color:inherit' },
        h('span', { class: 'grow strong' }, a.name), idChip(a.athlete_id), h('span', { class: 'small muted' }, `${a.results} ${a.results === 1 ? 'result' : 'results'}`), a.prs ? h('span', { class: 'dp-badge dp-badge--good' }, `${a.prs} PR${a.prs === 1 ? '' : 's'}`) : null)),
      h('div', { class: 'row' }, btn('Upload another', () => { uploadState = null; render(); }, 'secondary')));
  } else if (st && !st.ok) {
    step3 = h('section', { class: 'dp-panel stack', style: 'border-color:var(--amber)' },
      h('h2', { class: 'dp-panel-title', style: 'color:var(--amber)' }, 'This sheet can\'t be saved'),
      h('p', null, `Nothing was saved. ${st.error_count} ${st.error_count === 1 ? 'problem needs' : 'problems need'} fixing in ${st.filename ?? 'the sheet'}. Fix ${st.error_count === 1 ? 'it' : 'them'}, save, and upload the sheet again.`),
      problemTable(st.errors), st.error_count > st.errors.length ? h('p', { class: 'small muted' }, `Showing the first ${st.errors.length}.`) : null, again);
  } else if (st) {
    const s = st.summary;
    const saveBtn = btn(`Save ${s.results} results`, (e) => busy(e.currentTarget, async () => {
      try { const saved = await post('/v1/uploads/commit', { preview_id: st.preview_id, confirm: [...st.confirmed] }); uploadState = { ...st, saved }; toast(`${saved.saved} results saved.`); render(); }
      catch (err) { if (!err.details) throw err; uploadState = { ...st, ok: err.code !== 'upload_rejected', errors: err.details, error_count: err.details.length }; if (err.code === 'upload_rejected') render(); else throw err; }
    }), 'primary');
    const syncSave = () => { const left = st.warnings.length - st.confirmed.size; saveBtn.disabled = left > 0; saveBtn.textContent = left ? `Confirm ${left} more to save` : `Save ${s.results} results to ${s.athletes} ${s.athletes === 1 ? 'athlete' : 'athletes'}`; };
    const confirmPanel = st.warnings.length ? h('div', { class: 'stack', style: 'border:1px solid var(--amber);border-radius:8px;padding:12px' },
      h('strong', { style: 'color:var(--amber)' }, `Confirm ${st.warnings.length === 1 ? 'this value' : `these ${st.warnings.length} values`}`),
      h('p', { class: 'small muted', style: 'margin:0' }, 'They\'re possible but unusual. Tick each one that\'s right. If one is a mistake, fix the sheet and upload it again.'),
      st.warnings.map((w) => { const cb = h('input', { type: 'checkbox', checked: st.confirmed.has(w.key) }); cb.addEventListener('change', () => { cb.checked ? st.confirmed.add(w.key) : st.confirmed.delete(w.key); syncSave(); });
        return h('label', { class: 'row small', style: 'gap:10px;min-height:40px' }, cb, h('span', null, h('span', { class: 'muted' }, `Row ${w.row}, ${w.column}: `), w.message)); })) : null;
    const cards = st.athletes.map((g) => h('details', { class: 'dp-panel', open: g.results.some((r) => r.warning) },
      h('summary', { class: 'row', style: 'cursor:pointer;gap:12px;min-height:36px;list-style:none' }, h('span', { class: 'strong grow' }, g.name), idChip(g.athlete_id), h('span', { class: 'small muted' }, `${g.results.length} ${g.results.length === 1 ? 'result' : 'results'}`), g.results.some((r) => r.warning) ? h('span', { class: 'dp-badge dp-badge--warn' }, 'Confirm') : null),
      g.results.map((r) => h('div', { class: 'list-item small', style: 'flex-wrap:wrap' },
        h('span', { class: 'grow' }, `${r.test_name}${r.side ? ` – ${r.side === 'L' ? 'Left' : 'Right'}` : ''}${r.attempt ? ` #${r.attempt}` : ''}`),
        h('span', { class: 'muted' }, ymd(r.date)),
        h('span', { class: 'strong' }, fmtResult(r.value, r.unit, r.decimals)),
        r.entered_unit !== r.unit ? h('span', { class: 'muted' }, `from ${r.entered} ${r.entered_unit}`) : null,
        r.warning ? h('span', { class: 'dp-badge dp-badge--warn' }, 'Unusual') : null))));
    step3 = panel('3. Every row checks out', { subtitle: `${s.results} results for ${s.athletes} ${s.athletes === 1 ? 'athlete' : 'athletes'}, each matched by Athlete ID. Saving adds all of them at once.` },
      confirmPanel, cards, h('div', { class: 'row wrap' }, saveBtn, btn('Start over', () => { uploadState = null; render(); }, 'ghost')));
    syncSave();
  }

  fill(main, header('Upload results', 'All or nothing: a sheet is saved only when every row matches a real Athlete ID and every value fits its test.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/testing' }, 'Testing')),
    step3 ?? h('div', { class: 'grid grid-2' }, step1, step2));
}

boot();
