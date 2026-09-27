import { localDate } from '../util.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';
import { teamSummary } from './teams.js';
import { queueCount } from './queue.js';

// The app reading its own data: which athletes look like they're drifting away, and a Monday summary for the owner.

const DAY = 86400000;
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const first = (name) => String(name ?? '').split(' ')[0];

// ---------- At-risk athletes ----------
// A score from signals the app already has. Each signal adds points and a plain-English reason; 40 or more is "at risk".
// Payment signals are left out for coaches and front desk, who never see money.
export function atRisk(ctx, { role = 'owner', asOf = ctx.now(), limit = 20 } = {}) {
  const now = Date.parse(asOf);
  const iso = (days) => new Date(now + days * DAY).toISOString();
  const people = ctx.db.all(`SELECT c.id, c.name, c.family_id, f.name AS family_name, f.card_status AS family_card, c.card_status,
      (SELECT status FROM subscriptions s WHERE s.client_id = c.id AND s.status IN ('active','trialing','past_due') ORDER BY s.created_at DESC LIMIT 1) AS membership
    FROM clients c LEFT JOIN families f ON f.id = c.family_id WHERE c.athlete_id IS NOT NULL`);   // deleted athletes have no ID
  const out = [];
  for (const p of people) {
    const attended = (from, to) => ctx.db.get(`SELECT COUNT(*) AS n FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.status = 'attended' AND s.starts_at >= ? AND s.starts_at < ?`, p.id, from, to).n;
    const recent = attended(iso(-14), asOf), before = attended(iso(-56), iso(-14));   // last 2 weeks vs the 6 weeks before
    if (!p.membership && !recent && !before) continue;                                  // not an active athlete: nothing to lose
    let score = 0; const reasons = [];
    const weeklyBefore = before / 6;
    if (weeklyBefore >= 1 && recent === 0) { score += 40; reasons.push(`No sessions in 2 weeks (was coming about ${Math.round(weeklyBefore)} a week)`); }
    else if (weeklyBefore >= 1 && recent / 2 < weeklyBefore / 2) { score += 20; reasons.push(`Coming less than half as often (${recent} in the last 2 weeks)`); }
    const upcoming = ctx.db.get(`SELECT COUNT(*) AS n FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.status IN ('booked','waitlisted') AND s.starts_at >= ? AND s.starts_at < ?`, p.id, asOf, iso(14)).n;
    const standing = ctx.db.get(`SELECT COUNT(*) AS n FROM enrollments WHERE client_id = ? AND status = 'active'`, p.id).n;
    if (!upcoming && !standing) { score += 15; reasons.push('Nothing booked for the next 2 weeks'); }
    const misses = ctx.db.get(`SELECT COUNT(*) AS n FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.status IN ('no_show','late_canceled') AND s.starts_at >= ? AND s.starts_at < ?`, p.id, iso(-30), asOf).n;
    if (misses >= 2) { score += 10; reasons.push(`${misses} no-shows or late cancels this month`); }
    const checkRecent = ctx.db.get('SELECT COUNT(*) AS n FROM daily_checkins WHERE client_id = ? AND date >= ?', p.id, iso(-14).slice(0, 10)).n;
    const checkBefore = ctx.db.get('SELECT COUNT(*) AS n FROM daily_checkins WHERE client_id = ? AND date >= ? AND date < ?', p.id, iso(-42).slice(0, 10), iso(-14).slice(0, 10)).n;
    if (checkBefore >= 3 && !checkRecent) { score += 10; reasons.push('Stopped doing daily check-ins'); }
    if (role === 'owner') {
      if (p.membership === 'past_due') { score += 25; reasons.push('Membership payment failed'); }
      if (p.membership === 'trialing' && !recent) { score += 15; reasons.push('On a free trial but hasn\'t come in 2 weeks'); }
    }
    if (score >= 40) out.push({ client_id: p.id, name: p.name, family_id: p.family_id, family_name: p.family_name, score: Math.min(score, 100), reasons, membership: role === 'owner' ? p.membership : undefined });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

// ---------- Weekly owner digest ----------
export function buildDigest(ctx, asOf = ctx.now()) {
  const now = Date.parse(asOf);
  const iso = (days) => new Date(now + days * DAY).toISOString();
  const takings = (from, to) => {
    const sales = ctx.db.get(`SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS c FROM sales WHERE status IN ('succeeded','partially_refunded') AND completed_at >= ? AND completed_at < ?`, from, to).c;
    const memberships = ctx.db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?`, from, to).c;
    const schools = ctx.db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM team_invoices WHERE status = 'paid' AND paid_on >= ? AND paid_on < ?`, from.slice(0, 10), to.slice(0, 10)).c;
    return { total: sales + memberships + schools, sales, memberships, schools };
  };
  const week = takings(iso(-7), asOf), prior = takings(iso(-14), iso(-7));
  const members = ctx.db.get(`SELECT COUNT(*) AS n FROM subscriptions WHERE status IN ('active','trialing','past_due')`).n;
  const joined = ctx.db.get(`SELECT COUNT(*) AS n FROM subscriptions WHERE created_at >= ?`, iso(-7)).n;
  const left = ctx.db.get(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'canceled' AND canceled_at >= ?`, iso(-7)).n;
  const failed = ctx.db.all(`SELECT c.name, i.amount_cents FROM invoices i JOIN clients c ON c.id = i.client_id JOIN subscriptions s ON s.id = i.subscription_id WHERE i.status = 'failed' AND s.status = 'past_due'`);
  const overdue = teamSummary(ctx).overdue;
  const risk = atRisk(ctx, { asOf, limit: 5 });
  const light = ctx.db.all(`SELECT s.id, s.name, s.starts_at, s.capacity,
      (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
    FROM class_sessions s WHERE s.status = 'scheduled' AND s.kind IN ('group','clinic') AND s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at`, asOf, iso(7))
    .map((s) => ({ ...s, open: s.capacity - s.booked })).filter((s) => s.open > 0);
  const openSpots = light.reduce((t, s) => t + s.open, 0);
  const emptiest = [...light].sort((a, b) => b.open / b.capacity - a.open / a.capacity).slice(0, 3);
  const waiting = queueCount(ctx).n;
  const deletions = ctx.db.get(`SELECT COUNT(*) AS n FROM data_requests WHERE status = 'open' AND kind = 'delete'`).n;
  const workouts = ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE completed_at >= ?', iso(-7)).n;

  // Three things worth doing this week, most urgent first.
  const zone = getSetting(ctx, 'timezone');
  const when = (x) => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(x));
  const actions = [];
  if (deletions) actions.push(`Handle ${deletions === 1 ? 'a family\'s deletion request' : `${deletions} deletion requests`} (Staff & security).`);
  if (failed.length) actions.push(`Ask ${failed.length === 1 ? `${failed[0].name}'s family` : `${failed.length} families`} to update their card (${money(failed.reduce((t, f) => t + f.amount_cents, 0))} waiting).`);
  if (overdue.length) actions.push(`Follow up on ${overdue.length} overdue school ${overdue.length === 1 ? 'invoice' : 'invoices'} (${money(overdue.reduce((t, i) => t + i.amount_cents, 0))}).`);
  if (risk.length) {
    const names = risk.slice(0, 3).map((r) => first(r.name));
    const why = risk[0].reasons.find((x) => !/payment/i.test(x)) ?? risk[0].reasons[0];   // payments already have their own line
    actions.push(`Check in with ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} (${first(risk[0].name)}: ${why.charAt(0).toLowerCase()}${why.slice(1)}).`);
  }
  if (emptiest.length && emptiest[0].open / emptiest[0].capacity >= 0.5) actions.push(`Fill ${emptiest[0].name} on ${when(emptiest[0].starts_at)}: ${emptiest[0].open} of ${emptiest[0].capacity} spots open.`);
  if (waiting) actions.push(`Link ${waiting} test ${waiting === 1 ? 'result' : 'results'} waiting in Testing.`);

  return {
    week_ending: localDate(asOf, zone), takings: week, prior_takings: prior,
    change_pct: prior.total ? Math.round(((week.total - prior.total) / prior.total) * 100) : null,
    members, joined, left, failed_payments: failed.length, overdue_school_invoices: overdue.length,
    at_risk: risk, open_spots: openSpots, emptiest: emptiest.map((s) => ({ id: s.id, name: s.name, starts_at: s.starts_at, open: s.open, capacity: s.capacity })),
    results_waiting: waiting, deletion_requests: deletions, workouts_logged: workouts, actions: actions.slice(0, 3)
  };
}

export function digestText(ctx, d) {
  const zone = getSetting(ctx, 'timezone');
  const when = (x) => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(x));
  const change = d.change_pct == null ? '' : d.change_pct >= 0 ? ` (up ${d.change_pct}% on the week before)` : ` (down ${-d.change_pct}% on the week before)`;
  const lines = [
    `Your week at ${getSetting(ctx, 'business_name')}, to ${d.week_ending}.`,
    '',
    `Money in: ${money(d.takings.total)}${change}. In person ${money(d.takings.sales)}, memberships ${money(d.takings.memberships)}, schools ${money(d.takings.schools)}.`,
    `Members: ${d.members} (${d.joined} joined, ${d.left} left this week).`,
    `Athletes logged ${d.workouts_logged} workouts.`,
    '',
    d.actions.length ? 'This week:' : 'Nothing needs you this week.',
    ...d.actions.map((a, i) => `${i + 1}. ${a}`),
    ''
  ];
  if (d.at_risk.length) lines.push('Athletes who may be drifting away:', ...d.at_risk.map((r) => `- ${r.name}: ${r.reasons.join('; ')}`), '');
  if (d.open_spots) lines.push(`Open spots in group classes and clinics over the next 7 days: ${d.open_spots}.`, ...d.emptiest.map((s) => `- ${s.name}, ${when(s.starts_at)}: ${s.open} of ${s.capacity} open`), '');
  const other = [d.failed_payments && `${d.failed_payments} failed membership ${d.failed_payments === 1 ? 'payment' : 'payments'}`, d.overdue_school_invoices && `${d.overdue_school_invoices} overdue school ${d.overdue_school_invoices === 1 ? 'invoice' : 'invoices'}`, d.results_waiting && `${d.results_waiting} test results waiting to be linked`].filter(Boolean);
  if (other.length) lines.push(`Also on the Today screen: ${other.join(', ')}.`, '');
  lines.push(`Open the dashboard: ${ctx.publicUrl ?? ''}/`, '', 'Turn this email off in Schedule → Hours & settings.');
  return lines.join('\n');
}

export async function sendDigest(ctx, asOf = ctx.now()) {
  const d = buildDigest(ctx, asOf);
  const text = digestText(ctx, d);
  const owners = ctx.db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1`);
  for (const o of owners) await sendEmail(ctx, { to: o.email, subject: `Your week at ${getSetting(ctx, 'business_name')}: ${money(d.takings.total)} in${d.at_risk.length ? `, ${d.at_risk.length} athletes to check on` : ''}`, text });
  return { ...d, sent_to: owners.length };
}

// Runs hourly: sends once a week, the first run after 7 am Monday business time.
export async function weeklyDigest(ctx, asOf = ctx.now()) {
  if (getSetting(ctx, 'weekly_digest') !== 'on') return null;
  const zone = getSetting(ctx, 'timezone');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(asOf)).map((p) => [p.type, p.value]));
  if (parts.weekday !== 'Mon' || Number(parts.hour) < 7) return null;
  const today = localDate(asOf, zone);
  if (getSetting(ctx, 'digest_sent_on') === today) return null;
  ctx.db.run(`INSERT INTO settings (key, value) VALUES ('digest_sent_on', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, today);
  return sendDigest(ctx, asOf);
}
