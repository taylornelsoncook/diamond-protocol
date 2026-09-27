// Today: the home screen. Metrics by role, today's sessions and arrivals, what needs a decision (with follow-ups
// that hide an item for a while), birthdays, revenue by location (owners).
'use strict';
const { db, get, all, run, insert, setting } = require('../db');
const { h, bad, notFound, log, money, addDays, ageOn } = require('../lib');
const { requireStaff } = require('../auth');
const booking = require('../services/booking');
const billing = require('../services/billing');
const engage = require('../services/engage');
const { localDateOf, eventsBetween, fullName } = require('../services/floor-util');

const QUIET_DAYS = 14, TRIAL_WARN_DAYS = 3, BIRTHDAY_DAYS = 7, MAX_ATTEMPTS = 4;

// Follow-ups: "Reached out", "Followed up", "Mark seen" hide an attention item from everyone's Today until a date.
db.exec(`CREATE TABLE IF NOT EXISTS today_snoozes (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, athlete_id INTEGER REFERENCES athletes(id), until TEXT NOT NULL,
  note TEXT, staff_name TEXT, created_at TEXT DEFAULT (datetime('now')))`);
const SNOOZE_KINDS = {
  quiet: { days: 7, action: 'Reached out to client', label: 'Reached out' },
  trial: { days: null, action: 'Followed up on trial', label: 'Followed up' },
  flag: { days: 2, action: 'Reviewed check-in', label: 'Reviewed' },
};
const activeSnoozes = (T) => all('SELECT * FROM today_snoozes WHERE until >= ? ORDER BY id DESC', T);
const fmtDay = (d) => (d ? new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const clock = (localTs) => { const [hh, mm] = localTs.slice(11, 16).split(':').map(Number); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
// Local wall-clock "YYYY-MM-DDTHH:MM" plus minutes (time-zone free arithmetic).
const plusMin = (localTs, min) => new Date(new Date(localTs + ':00Z').getTime() + min * 6e4).toISOString().slice(0, 16);
// Best phone for a quick call: the family's first parent, else the athlete's emergency contact.
function phoneFor(athleteId) {
  const a = get('SELECT family_id, emergency_phone FROM athletes WHERE id=?', athleteId);
  const p = a?.family_id ? get("SELECT phone FROM parents WHERE family_id=? AND phone IS NOT NULL AND phone!='' ORDER BY is_self DESC, id LIMIT 1", a.family_id) : null;
  return p?.phone || a?.emergency_phone || null;
}

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

// Session state against the local clock: done, live (running now), next (the first still to start), later, cancelled.
function withState(sessions, now) {
  let nextSet = false;
  return sessions.map((e) => {
    const ends_at = plusMin(e.starts_at, e.duration_min);
    let state = 'later';
    if (e.cancelled) state = 'cancelled';
    else if (ends_at <= now) state = 'done';
    else if (e.starts_at <= now) state = 'live';
    else if (!nextSet) { state = 'next'; nextSet = true; }
    return { ...e, ends_at, state };
  });
}

// Everyone booked into today's sessions, for one-tap check-in. No prices: "unpaid" is a flag, not an amount.
function arrivals(T, sessions, flagsBy) {
  const live = sessions.filter((e) => !e.cancelled);
  if (!live.length) return [];
  const byEvent = Object.fromEntries(live.map((e) => [e.id, e]));
  const waiverVersion = Number(setting('waiver_version', 1));
  const rows = all(`SELECT b.id AS booking_id, b.event_id, b.checked_in_at, b.coverage, a.id AS athlete_id, a.first_name, a.last_name, a.code, a.birthday,
      a.allergies, a.injuries, a.medical_notes, a.family_id, f.waiver_version, f.waiver_signed_at
    FROM bookings b JOIN athletes a ON a.id=b.athlete_id LEFT JOIN families f ON f.id=a.family_id
    WHERE b.status='booked' AND b.event_id IN (${live.map(() => '?').join(',')})`, ...live.map((e) => e.id));
  return rows.map((r) => {
    const e = byEvent[r.event_id];
    const alerts = [r.allergies && `Allergy: ${r.allergies}`, r.injuries && `Injury: ${r.injuries}`, r.medical_notes && `Medical: ${r.medical_notes}`].filter(Boolean);
    return {
      booking_id: r.booking_id, event_id: r.event_id, event_name: e.name, starts_at: e.starts_at, state: e.state,
      athlete_id: r.athlete_id, name: fullName(r), code: r.code, checked_in_at: r.checked_in_at || null,
      unpaid: r.coverage === 'unpaid', alerts,
      waiver_missing: !!r.family_id && (!r.waiver_signed_at || Number(r.waiver_version || 0) < waiverVersion),
      birthday: !!r.birthday && r.birthday.slice(5) === T.slice(5),
      flags: flagsBy[r.athlete_id] || [],
    };
  }).sort((x, y) => (!!x.checked_in_at - !!y.checked_in_at) || x.starts_at.localeCompare(y.starts_at) || x.name.localeCompare(y.name));
}

// Birthdays in the next week among current clients (family athletes and team rosters).
function birthdays(T) {
  const days = Array.from({ length: BIRTHDAY_DAYS }, (_, i) => addDays(T, i));
  const md = days.map((d) => d.slice(5));
  return all(`SELECT id, first_name, last_name, birthday FROM athletes WHERE archived=0 AND birthday IS NOT NULL AND (family_id IS NOT NULL OR team_id IS NOT NULL)
      AND substr(birthday,6,5) IN (${md.map(() => '?').join(',')})`, ...md)
    .map((a) => { const date = days[md.indexOf(a.birthday.slice(5))]; return { athlete_id: a.id, name: fullName(a), date, today: date === T, turning: ageOn(a.birthday, date) }; })
    .sort((x, y) => x.date.localeCompare(y.date) || x.name.localeCompare(y.name));
}

function attention(role, T, sessions, snoozed) {
  const owner = role === 'owner';
  const out = [];
  const hidden = (key) => snoozed.has(key);
  if (owner) {
    for (const inv of all(`SELECT i.*, a.first_name, a.last_name, a.id AS aid, f.name AS family, f.card_brand, f.card_last4 FROM invoices i
        LEFT JOIN athletes a ON a.id=i.athlete_id LEFT JOIN families f ON f.id=i.family_id
        WHERE i.status='failed' AND i.kind IN ('membership','charge') ORDER BY i.id DESC LIMIT 10`)) {
      const retry = inv.attempts >= MAX_ATTEMPTS ? 'No more automatic retries.' : inv.next_retry ? `Auto-retry ${fmtDay(inv.next_retry)}.` : '';
      const who = inv.first_name ? fullName(inv) : inv.family || 'Unknown client';
      out.push({
        kind: 'failed_payment', title: who, href: inv.aid ? `/app/clients/${inv.aid}` : '/app/billing',
        detail: `${money(inv.amount_cents)} for ${inv.description || 'a charge'} declined ${inv.attempts}×. ${inv.card_last4 ? '' : 'No card on file. '}${retry}`.trim(),
        action: inv.card_last4
          ? { label: 'Retry charge', post: `/today/retry/${inv.id}`, confirm: { title: 'Retry this charge?', text: `Charge ${money(inv.amount_cents)} to ${inv.card_brand || 'the card'} ending ${inv.card_last4} for ${who} now.`, label: `Charge ${money(inv.amount_cents)}` } }
          : { label: 'Add a card', href: inv.aid ? `/app/clients/${inv.aid}` : '/app/billing' },
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
  // Unpaid bookings in sessions still to come or running now: collect at the door.
  for (const e of sessions.filter((x) => x.unpaid && (x.state === 'live' || x.state === 'next' || x.state === 'later'))) {
    out.push({
      kind: 'unpaid_today', title: `${e.unpaid} unpaid booking${e.unpaid === 1 ? '' : 's'} in ${e.name}`, href: `/app/schedule/session/${e.id}`,
      detail: `${clock(e.starts_at)} today. Collect at check-in: card on file, cash or Tap to Pay.`,
      action: { label: 'Open roster', href: `/app/schedule/session/${e.id}` },
    });
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
    const key = `trial:${m.athlete_id}`;
    if (hidden(key)) continue;
    out.push({
      kind: 'trial_ending', key, title: fullName(m), href: `/app/clients/${m.athlete_id}`, athlete_id: m.athlete_id, phone: phoneFor(m.athlete_id),
      detail: `Free trial ends ${fmtDay(m.next_charge)}.${owner ? ` First charge ${money(m.price_cents ?? m.plan_price)}.` : ''}`,
      snooze: { label: SNOOZE_KINDS.trial.label, until: m.next_charge },
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
    .filter((a) => !hidden(`quiet:${a.id}`))
    .sort((x, y) => String(x.last || '').localeCompare(String(y.last || '')));
  for (const a of quiet.slice(0, 5)) {
    out.push({
      kind: 'quiet', key: `quiet:${a.id}`, title: fullName(a), href: `/app/clients/${a.id}`, athlete_id: a.id, phone: phoneFor(a.id),
      detail: a.last ? `No check-in or workout since ${fmtDay(a.last)}. A quick text keeps them coming.` : `No check-in or workout in ${QUIET_DAYS}+ days.`,
      snooze: { label: SNOOZE_KINDS.quiet.label, days: SNOOZE_KINDS.quiet.days },
      action: { label: 'View client', href: `/app/clients/${a.id}` },
    });
  }
  if (quiet.length > 5) out.push({ kind: 'quiet_more', title: `${quiet.length - 5} more clients have gone quiet`, detail: 'Sort Clients by last seen to find them.', action: { label: 'Clients', href: '/app/clients' } });
  return out;
}

// Daily check-ins with red flags (today or yesterday), with the athlete's session today if they have one.
function checkinFlags(T, sessions, snoozed) {
  const live = sessions.filter((e) => !e.cancelled);
  return engage.recentFlags().map((f) => {
    const key = `flag:${f.athlete_id}:${f.date}`;
    const b = live.length ? get(`SELECT e.starts_at, e.name FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.status='booked'
      AND e.id IN (${live.map(() => '?').join(',')}) ORDER BY e.starts_at LIMIT 1`, f.athlete_id, ...live.map((e) => e.id)) : null;
    return { ...f, key, today: f.date === T, session: b ? `${b.name} at ${clock(b.starts_at)}` : null, snooze: { label: SNOOZE_KINDS.flag.label, days: SNOOZE_KINDS.flag.days } };
  }).filter((f) => !snoozed.has(f.key));
}

// What a follow-up is about, in words, for the hidden list.
function describeSnooze(s) {
  const a = s.athlete_id ? get('SELECT first_name, last_name FROM athletes WHERE id=?', s.athlete_id) : null;
  const kind = s.key.split(':')[0];
  return { id: s.id, key: s.key, kind, name: a ? fullName(a) : 'Unknown client', athlete_id: s.athlete_id, until: s.until, note: s.note, by: s.staff_name, label: SNOOZE_KINDS[kind]?.label || 'Hidden', created_at: s.created_at };
}

function routes(api) {
  api.get('/today', requireStaff(), h(async (req, res) => {
    const role = req.staff.role, owner = role === 'owner';
    const T = booking.todayLocal(), now = booking.nowLocal();
    // Money never reaches coaches or front desk on Today.
    const sessions = withState(eventsBetween(T, T, { includeCancelled: true }).map((e) => { if (!owner) delete e.price_cents; return e; }), now);
    const snoozes = activeSnoozes(T);
    const snoozed = new Set(snoozes.map((s) => s.key));
    const flags = checkinFlags(T, sessions, snoozed);
    const flagsBy = Object.fromEntries(flags.filter((f) => f.today).map((f) => [f.athlete_id, f.flags]));
    const clients = activeClients(T);
    const tomorrowList = eventsBetween(addDays(T, 1), addDays(T, 1), { includeCancelled: false });
    const out = {
      date: T, now, role, sessions, flags, attention: attention(role, T, sessions, snoozed),
      arrivals: arrivals(T, sessions, flagsBy), birthdays: birthdays(T), snoozed: snoozes.map(describeSnooze),
      tomorrow: { date: addDays(T, 1), count: tomorrowList.length, first_at: tomorrowList[0]?.starts_at || null, booked: tomorrowList.reduce((n, e) => n + e.booked, 0) },
    };
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
      const todaySales = sales.filter((s) => s.local_date === T);
      out.in_person_today_cents = todaySales.reduce((n, s) => n + s.net, 0);
      out.in_person_today_count = todaySales.length;
      out.metrics = [
        { key: 'mrr', label: 'Monthly recurring revenue', value: money(mrr.total), note: `${money(mrr.memberships)} memberships · ${money(mrr.teams)} teams`, href: '/app/billing' },
        { key: 'clients', label: 'Active clients', value: String(clients.n), note: clients.trial ? `${clients.trial} on free trial` : 'None on free trial', href: '/app/clients' },
        { key: 'failed', label: 'Payments failed', value: String(failed.n), tone: failed.n ? 'warn' : '', note: failed.n ? `${money(failed.c)} at risk this month` : 'Nothing at risk', href: '/app/billing' },
        { key: 'workouts', label: 'Workouts logged', value: String(workoutsLogged()), tone: 'good', note: 'Last 7 days', href: '/app/programs' },
      ];
      out.revenue = {
        locations: Object.values(byLoc).sort((a, b) => b.cents - a.cents),
        total_cents: Object.values(byLoc).reduce((n, l) => n + l.cents, 0),
        membership_payments: { count: memPaid.length, cents: memPaid.reduce((n, i) => n + i.amount_cents, 0) },
      };
    } else {
      const live = sessions.filter((e) => !e.cancelled);
      const booked = live.reduce((n, e) => n + (e.type === 'team' ? Math.max(e.booked, e.team_size) : e.booked), 0);
      const checked = live.reduce((n, e) => n + e.checked_in, 0);
      const focus = live.find((e) => e.state === 'live') || live.find((e) => e.state === 'next');
      out.metrics = [
        { key: 'clients', label: 'Active clients', value: String(clients.n), note: clients.trial ? `${clients.trial} on free trial` : 'None on free trial', href: '/app/clients' },
        { key: 'sessions', label: 'Sessions today', value: String(live.length), note: sessionsNote(live), href: '/app/schedule' },
        { key: 'checked', label: 'Checked in today', value: String(checked), tone: checked ? 'good' : '', note: `${booked} expected`, href: focus ? `/app/schedule/session/${focus.id}` : '/app/schedule' },
        { key: 'workouts', label: 'Workouts logged', value: String(workoutsLogged()), tone: 'good', note: 'Last 7 days', href: '/app/programs' },
      ];
    }
    res.json(out);
  }));

  // Retry a declined membership or card charge now (owners).
  api.post('/today/retry/:id', requireStaff('owner'), h(async (req, res) => {
    const inv = get('SELECT * FROM invoices WHERE id=?', req.params.id);
    if (!inv) throw notFound('That invoice');
    if (inv.status !== 'failed') throw bad('That charge is no longer declined.');
    const fam = inv.family_id ? get('SELECT card_last4 FROM families WHERE id=?', inv.family_id) : null;
    if (!fam?.card_last4) throw bad('There is no card on file for this family. Add one on their client profile, then retry.');
    const r = billing.retryFailed({ invoiceId: inv.id });
    const who = inv.athlete_id ? fullName(get('SELECT first_name,last_name FROM athletes WHERE id=?', inv.athlete_id)) : inv.number;
    log(req, r.paid ? 'Retried payment: paid' : 'Retried payment: declined again', `${who} · ${money(inv.amount_cents)} · ${inv.number}`);
    const last = inv.attempts + 1 >= MAX_ATTEMPTS;
    res.json({ ok: !!r.paid, message: r.paid ? `Charged ${money(inv.amount_cents)}. The invoice is paid.`
      : last ? 'Declined again. There are no more automatic retries, so ask the family to update their card.'
        : 'Declined again. It will retry automatically, or ask the family to update their card.' });
  }));

  // Follow up on an attention item: hides it from everyone's Today until a date, and says who did it.
  api.post('/today/snooze', requireStaff(), h(async (req, res) => {
    const b = req.body || {};
    const m = /^(quiet|trial|flag):(\d+)(?::(\d{4}-\d{2}-\d{2}))?$/.exec(String(b.key || ''));
    if (!m || (m[1] === 'flag') !== !!m[3]) throw bad('That item can’t be followed up from Today.');
    const kind = m[1], athleteId = Number(m[2]);
    const a = get('SELECT id, first_name, last_name FROM athletes WHERE id=? AND archived=0', athleteId);
    if (!a) throw notFound('That client');
    const T = booking.todayLocal();
    let until;
    if (b.days !== undefined && b.days !== null && b.days !== '') {
      const days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 60) throw bad('Hide it for 1 to 60 days.');
      until = addDays(T, days - 1);
    } else if (kind === 'trial') {
      const t = get("SELECT next_charge FROM memberships WHERE athlete_id=? AND status='trial' ORDER BY id DESC LIMIT 1", athleteId);
      until = t?.next_charge && t.next_charge >= T ? t.next_charge : T;
    } else if (kind === 'flag') {
      until = addDays(m[3], 1); // check-in flags show for today and yesterday only
    } else until = addDays(T, SNOOZE_KINDS[kind].days - 1);
    const note = b.note == null ? null : String(b.note).trim().slice(0, 300) || null;
    run('DELETE FROM today_snoozes WHERE key=?', b.key);
    const id = insert('today_snoozes', { key: b.key, athlete_id: athleteId, until, note, staff_name: req.staff.name });
    log(req, SNOOZE_KINDS[kind].action, `${fullName(a)}${note ? `: ${note}` : ''}`);
    const back = kind === 'flag' ? 'Marked as reviewed.' : `Hidden until ${fmtDay(addDays(until, 1))}.`;
    res.json({ ok: true, id, until, message: `${SNOOZE_KINDS[kind].label}: ${fullName(a)}. ${back}` });
  }));

  // Undo a follow-up: the item comes back on Today.
  api.delete('/today/snooze/:id', requireStaff(), h(async (req, res) => {
    const s = get('SELECT * FROM today_snoozes WHERE id=?', req.params.id);
    if (!s) throw notFound('That follow-up');
    run('DELETE FROM today_snoozes WHERE id=?', s.id);
    log(req, 'Brought back to Today', describeSnooze(s).name);
    res.json({ ok: true });
  }));
}

function sessionsNote(live) {
  if (!live.length) return 'Nothing scheduled';
  const now = live.find((e) => e.state === 'live'), next = live.find((e) => e.state === 'next');
  if (now) return next ? `On now · next at ${clock(next.starts_at)}` : 'On now · last of the day';
  if (next) return `Next at ${clock(next.starts_at)}`;
  return 'All done for today';
}

module.exports = { routes };
