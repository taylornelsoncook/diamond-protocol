// Today: the home screen. Metrics by role, today's sessions, what needs a decision, revenue by location (owners).
'use strict';
const { get, all } = require('../db');
const { h, bad, notFound, log, money, addDays } = require('../lib');
const { requireStaff } = require('../auth');
const booking = require('../services/booking');
const billing = require('../services/billing');
const { localDateOf, eventsBetween, fullName } = require('../services/floor-util');

const QUIET_DAYS = 14, TRIAL_WARN_DAYS = 3;
const fmtDay = (d) => (d ? new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// Monthly recurring revenue: active and past-due memberships plus active team contracts.
function recurring() {
  const mem = get("SELECT COALESCE(SUM(COALESCE(m.price_cents,p.price_cents)),0) c FROM memberships m JOIN plans p ON p.id=m.plan_id WHERE m.status IN ('active','past_due')").c;
  const teams = get("SELECT COALESCE(SUM(monthly_cents),0) c FROM team_contracts WHERE status='active'").c;
  return { total: mem + teams, memberships: mem, teams };
}

function activeClients(T) {
  const since = addDays(T, -30);
  const n = get(`SELECT COUNT(*) n FROM athletes a WHERE a.archived=0 AND a.family_id IS NOT NULL AND (
      EXISTS (SELECT 1 FROM memberships m WHERE m.athlete_id=a.id AND m.status IN ('trial','active','past_due'))
      OR EXISTS (SELECT 1 FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=a.id AND b.status='booked' AND e.starts_at>=?))`, since).n;
  const trial = get("SELECT COUNT(DISTINCT athlete_id) n FROM memberships WHERE status='trial'").n;
  return { n, trial };
}

function workoutsLogged() {
  return get("SELECT COUNT(*) n FROM workout_logs WHERE finished_at IS NOT NULL AND substr(finished_at,1,10) >= date('now','-7 days')").n;
}

// Sales net of refunds, by local date.
function salesSince(fromDate) {
  return all(`SELECT s.*, l.name AS location FROM sales s LEFT JOIN locations l ON l.id=s.location_id
    WHERE s.status!='failed' AND s.created_at >= ?`, addDays(fromDate, -1))
    .map((s) => ({ ...s, local_date: localDateOf(s.created_at), net: s.total_cents - (s.refunded_cents || 0) }))
    .filter((s) => s.local_date >= fromDate);
}

function attention(role, T) {
  const owner = role === 'owner';
  const out = [];
  if (owner) {
    for (const inv of all(`SELECT i.*, a.first_name, a.last_name, a.id AS aid, f.name AS family FROM invoices i
        LEFT JOIN athletes a ON a.id=i.athlete_id LEFT JOIN families f ON f.id=i.family_id
        WHERE i.status='failed' AND i.kind IN ('membership','charge') ORDER BY i.id DESC LIMIT 10`)) {
      const retry = inv.attempts >= 4 ? 'No more automatic retries.' : inv.next_retry ? `Auto-retry ${fmtDay(inv.next_retry)}.` : '';
      out.push({
        kind: 'failed_payment', title: inv.first_name ? fullName(inv) : inv.family || 'Unknown client', href: inv.aid ? `/app/clients/${inv.aid}` : '/app/billing',
        detail: `${money(inv.amount_cents)} for ${inv.description || 'a charge'} declined ${inv.attempts}×. ${retry}`.trim(),
        action: { label: 'Retry charge', post: `/today/retry/${inv.id}` },
      });
    }
    for (const inv of all(`SELECT i.*, s.name AS school, t.team_name FROM invoices i LEFT JOIN team_contracts t ON t.id=i.contract_id LEFT JOIN schools s ON s.id=t.school_id
        WHERE i.kind='school' AND i.status='open' AND i.due_date IS NOT NULL AND i.due_date < ? ORDER BY i.due_date LIMIT 10`, T)) {
      const days = Math.round((new Date(T + 'T12:00:00') - new Date(inv.due_date + 'T12:00:00')) / 864e5);
      out.push({
        kind: 'overdue_invoice', title: `${inv.school || inv.team_name || 'School'} invoice ${inv.number}`, href: inv.contract_id ? `/app/teams/${inv.contract_id}` : '/app/billing',
        detail: `${money(inv.amount_cents)} for ${inv.team_name || 'the team contract'}, ${days} day${days === 1 ? '' : 's'} overdue (due ${fmtDay(inv.due_date)}).`,
        action: { label: 'Open invoice', href: inv.contract_id ? `/app/teams/${inv.contract_id}` : '/app/billing' },
      });
    }
  }
  const pend = get('SELECT COUNT(*) n, COUNT(DISTINCT source || sender_key) senders FROM pending_results');
  if (pend.n) {
    out.push({
      kind: 'pending_results', title: `${pend.n} test result${pend.n === 1 ? ' is' : 's are'} waiting to be linked`,
      detail: `From ${pend.senders} unrecognized athlete${pend.senders === 1 ? '' : 's'}. They stay out of every profile until you link them.`,
      action: { label: 'Link them', href: '/app/testing/queue' },
    });
  }
  // Trials ending in the next few days.
  for (const m of all(`SELECT m.*, a.first_name, a.last_name, p.price_cents AS plan_price FROM memberships m JOIN athletes a ON a.id=m.athlete_id JOIN plans p ON p.id=m.plan_id
      WHERE m.status='trial' AND m.next_charge BETWEEN ? AND ? AND a.archived=0 ORDER BY m.next_charge`, T, addDays(T, TRIAL_WARN_DAYS))) {
    out.push({
      kind: 'trial_ending', title: fullName(m), href: `/app/clients/${m.athlete_id}`,
      detail: `Free trial ends ${fmtDay(m.next_charge)}.${owner ? ` First charge ${money(m.price_cents ?? m.plan_price)}.` : ''}`,
      action: { label: 'View client', href: `/app/clients/${m.athlete_id}` },
    });
  }
  // Members who haven't checked in or logged a workout in 14+ days.
  const cutoff = addDays(T, -QUIET_DAYS);
  const quiet = all(`SELECT a.id, a.first_name, a.last_name, a.created_at,
      (SELECT MAX(b.checked_in_at) FROM bookings b WHERE b.athlete_id=a.id) AS last_checkin,
      (SELECT MAX(COALESCE(w.finished_at, w.created_at)) FROM workout_logs w WHERE w.athlete_id=a.id) AS last_workout
    FROM athletes a WHERE a.archived=0 AND EXISTS (SELECT 1 FROM memberships m WHERE m.athlete_id=a.id AND m.status IN ('trial','active','past_due'))`)
    .map((a) => ({ ...a, last: [a.last_checkin, a.last_workout].filter(Boolean).map((x) => String(x).slice(0, 10)).sort().pop() || null }))
    .filter((a) => (a.last ? a.last < cutoff : String(a.created_at).slice(0, 10) < cutoff))
    .sort((x, y) => String(x.last || '').localeCompare(String(y.last || '')));
  for (const a of quiet.slice(0, 5)) {
    out.push({
      kind: 'quiet', title: fullName(a), href: `/app/clients/${a.id}`,
      detail: a.last ? `No check-in or workout since ${fmtDay(a.last)}. A quick text keeps them coming.` : `No check-in or workout in ${QUIET_DAYS}+ days.`,
      action: { label: 'View client', href: `/app/clients/${a.id}` },
    });
  }
  if (quiet.length > 5) out.push({ kind: 'quiet_more', title: `${quiet.length - 5} more clients have gone quiet`, detail: 'Sort Clients by last seen to find them.', action: { label: 'Clients', href: '/app/clients' } });
  return out;
}

function routes(api) {
  api.get('/today', requireStaff(), h(async (req, res) => {
    const role = req.staff.role, owner = role === 'owner';
    const T = booking.todayLocal();
    // Money never reaches coaches or front desk on Today.
    const sessions = eventsBetween(T, T, { includeCancelled: true }).map((e) => { if (!owner) delete e.price_cents; return e; });
    const clients = activeClients(T);
    const out = { date: T, role, sessions, attention: attention(role, T) };
    if (owner) {
      const mrr = recurring();
      const failed = get("SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM invoices WHERE status='failed' AND kind IN ('membership','charge')");
      const month = T.slice(0, 7) + '-01';
      const sales = salesSince(month);
      const byLoc = {};
      for (const s of sales) {
        const k = s.location_id || 0;
        (byLoc[k] ||= { location_id: s.location_id, location: s.location || 'No location', sales: 0, cents: 0 });
        byLoc[k].sales++; byLoc[k].cents += s.net;
      }
      const memPaid = all("SELECT amount_cents, paid_at FROM invoices WHERE kind='membership' AND status='paid' AND paid_at IS NOT NULL AND paid_at >= ?", addDays(month, -1))
        .filter((i) => localDateOf(i.paid_at) >= month);
      out.in_person_today_cents = sales.filter((s) => s.local_date === T).reduce((n, s) => n + s.net, 0);
      out.metrics = [
        { key: 'mrr', label: 'Monthly recurring revenue', value: money(mrr.total), note: `${money(mrr.memberships)} memberships · ${money(mrr.teams)} teams` },
        { key: 'clients', label: 'Active clients', value: String(clients.n), note: clients.trial ? `${clients.trial} on free trial` : 'None on free trial' },
        { key: 'failed', label: 'Payments failed', value: String(failed.n), tone: failed.n ? 'warn' : '', note: failed.n ? `${money(failed.c)} at risk this month` : 'Nothing at risk' },
        { key: 'workouts', label: 'Workouts logged', value: String(workoutsLogged()), tone: 'good', note: 'Last 7 days' },
      ];
      out.revenue = {
        locations: Object.values(byLoc).sort((a, b) => b.cents - a.cents),
        membership_payments: { count: memPaid.length, cents: memPaid.reduce((n, i) => n + i.amount_cents, 0) },
      };
    } else {
      const live = sessions.filter((e) => !e.cancelled);
      const booked = live.reduce((n, e) => n + (e.type === 'team' ? Math.max(e.booked, e.team_size) : e.booked), 0);
      const checked = live.reduce((n, e) => n + e.checked_in, 0);
      out.metrics = [
        { key: 'clients', label: 'Active clients', value: String(clients.n), note: clients.trial ? `${clients.trial} on free trial` : 'None on free trial' },
        { key: 'sessions', label: 'Sessions today', value: String(live.length), note: live.length ? `Next at ${nextTime(live)}` : 'Nothing scheduled' },
        { key: 'checked', label: 'Checked in today', value: String(checked), tone: checked ? 'good' : '', note: `${booked} expected` },
        { key: 'workouts', label: 'Workouts logged', value: String(workoutsLogged()), tone: 'good', note: 'Last 7 days' },
      ];
    }
    res.json(out);
  }));

  // Retry a declined membership or card charge now (owners).
  api.post('/today/retry/:id', requireStaff('owner'), h(async (req, res) => {
    const inv = get('SELECT * FROM invoices WHERE id=?', req.params.id);
    if (!inv) throw notFound('That invoice');
    if (inv.status !== 'failed') throw bad('That charge is no longer declined.');
    const r = billing.retryFailed({ invoiceId: inv.id });
    const who = inv.athlete_id ? fullName(get('SELECT first_name,last_name FROM athletes WHERE id=?', inv.athlete_id)) : inv.number;
    log(req, r.paid ? 'Retried payment: paid' : 'Retried payment: declined again', `${who} · ${money(inv.amount_cents)} · ${inv.number}`);
    res.json({ ok: !!r.paid, message: r.paid ? `Charged ${money(inv.amount_cents)}. The invoice is paid.` : 'Declined again. It will retry automatically, or ask the family to update their card.' });
  }));
}

function nextTime(events) {
  const now = booking.nowLocal();
  const e = events.find((x) => x.starts_at >= now) || events[events.length - 1];
  const [hh, mm] = e.starts_at.slice(11, 16).split(':').map(Number);
  return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

module.exports = { routes };
