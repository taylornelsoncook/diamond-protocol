import { newId, token } from '../util.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';

// Google review requests. When an athlete hits a good moment (their 10th session, or a personal best on a testing
// day the family can see), the family gets one friendly email asking for a review, with a link to the business's
// Google review page. At most one ask per family every 6 months, never to families with a failed payment or an open
// deletion request, only between 10 am and 7 pm, and "Don't ask again" works for good.
// Nothing is sent until the owner pastes their Google review link (setting review_url).

const MILESTONE = 10;                     // sessions attended
const QUIET_DAYS = 180;                   // between asks to one family
const DAY = 86400000;
const first = (name) => String(name ?? '').trim().split(/\s+/)[0];

// Athletes with a good moment in the last few days, best reason first.
function moments(ctx, asOf) {
  const since = new Date(Date.parse(asOf) - 7 * DAY).toISOString();
  const out = [];
  // Their 10th attended session happened this week.
  for (const c of ctx.db.all(`SELECT b.client_id FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.status = 'attended' AND s.starts_at <= ? GROUP BY b.client_id HAVING COUNT(*) >= ?`, asOf, MILESTONE)) {
    const tenth = ctx.db.get(`SELECT s.starts_at FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.status = 'attended' ORDER BY s.starts_at LIMIT 1 OFFSET ?`, c.client_id, MILESTONE - 1);
    if (tenth && tenth.starts_at >= since) out.push({ client_id: c.client_id, reason: 'milestone', detail: `${MILESTONE} sessions` });
  }
  // A personal best the family can already see: the testing day was shared in the last 3 days (or results are
  // shared automatically and the best was set in the last 3 days).
  const recent = new Date(Date.parse(asOf) - 3 * DAY).toISOString();
  const auto = getSetting(ctx, 'share_results') === 'all';
  for (const e of ctx.db.all(`SELECT data, created_at FROM events WHERE type = 'performance.pr' AND created_at >= ? ORDER BY created_at DESC`, new Date(Date.parse(asOf) - 14 * DAY).toISOString())) {
    const d = JSON.parse(e.data);
    if (!d.client_id) continue;
    const visible = auto ? e.created_at >= recent
      : !!ctx.db.get(`SELECT 1 FROM perf_results r JOIN perf_sessions p ON p.id = r.session_id WHERE r.client_id = ? AND p.shared_at >= ? AND p.shared_at <= ? LIMIT 1`, d.client_id, recent, asOf);
    if (visible) out.push({ client_id: d.client_id, reason: 'pr', detail: d.test_name });
  }
  return out;
}

function eligibleFamily(ctx, familyId, asOf) {
  if (ctx.db.get(`SELECT 1 FROM review_requests WHERE family_id = ? AND (opted_out_at IS NOT NULL OR sent_at >= ?)`, familyId, new Date(Date.parse(asOf) - QUIET_DAYS * DAY).toISOString())) return false;
  if (ctx.db.get(`SELECT 1 FROM subscriptions s JOIN clients c ON c.id = s.client_id WHERE c.family_id = ? AND s.status = 'past_due'`, familyId)) return false;
  if (ctx.db.get(`SELECT 1 FROM data_requests WHERE family_id = ? AND status = 'open'`, familyId)) return false;
  return true;
}

export function reviewMessage(ctx, { parent, athlete, reason, detail }, link) {
  const biz = getSetting(ctx, 'business_name');
  const moment = reason === 'milestone' ? `just finished ${detail} with us` : `just set a new personal best${detail ? ` in the ${detail}` : ''}`;
  return {
    subject: `${first(athlete)} ${moment}`,
    text: `Hi ${first(parent)},\n\n${first(athlete)} ${moment}. Thank you for trusting us with their training.\n\n`
      + `If ${biz} has been good for your family, would you leave us a quick Google review? It takes a minute and helps other parents find us:\n${link}\n\n`
      + `Thank you,\n${biz}\n\nWe'll only ask once. Rather not be asked? ${link}?stop=1`
  };
}

export async function runReviewRequests(ctx, { asOf = ctx.now() } = {}) {
  const url = getSetting(ctx, 'review_url');
  if (!url || getSetting(ctx, 'review_requests') !== 'on') return 0;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: getSetting(ctx, 'timezone'), hour: 'numeric', hourCycle: 'h23' }).format(new Date(asOf)));
  if (hour < 10 || hour >= 19) return 0;
  let sent = 0;
  const done = new Set();
  for (const m of moments(ctx, asOf)) {
    const c = ctx.db.get('SELECT id, name, family_id FROM clients WHERE id = ?', m.client_id);
    if (!c?.family_id || done.has(c.family_id) || !eligibleFamily(ctx, c.family_id, asOf)) continue;
    const g = ctx.db.get('SELECT name, email FROM guardians WHERE family_id = ? AND email NOT IN (SELECT email FROM email_optouts) ORDER BY is_primary DESC LIMIT 1', c.family_id);
    if (!g) continue;
    done.add(c.family_id);
    const tok = token(12), link = `${ctx.publicUrl ?? ''}/r/${tok}`;
    ctx.db.run('INSERT INTO review_requests (id, family_id, client_id, reason, detail, token, sent_to, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('rev'), c.family_id, c.id, m.reason, m.detail ?? null, tok, g.email, ctx.now());
    const msg = reviewMessage(ctx, { parent: g.name, athlete: c.name, reason: m.reason, detail: m.detail }, link);
    await sendEmail(ctx, { to: g.email, subject: msg.subject, text: msg.text });
    sent++;
  }
  return sent;
}

// The link in the email: count the click and go to Google, or stop asking.
export function followReviewLink(ctx, tok, { stop = false } = {}) {
  const r = ctx.db.get('SELECT * FROM review_requests WHERE token = ?', String(tok));
  const url = getSetting(ctx, 'review_url');
  if (!r) return { page: 'This link isn\'t in use any more.' };
  if (stop) {
    ctx.db.run('UPDATE review_requests SET opted_out_at = COALESCE(opted_out_at, ?) WHERE id = ?', ctx.now(), r.id);
    return { page: `Got it. ${getSetting(ctx, 'business_name')} won't ask your family for a review again.` };
  }
  ctx.db.run('UPDATE review_requests SET clicked_at = COALESCE(clicked_at, ?) WHERE id = ?', ctx.now(), r.id);
  return url ? { redirect: url } : { page: 'Thanks for thinking of us!' };
}

// For the Leads tab: what was sent and how many families clicked through.
export function reviewSummary(ctx) {
  const since = new Date(Date.now() - 90 * DAY).toISOString();
  const s = ctx.db.get(`SELECT COUNT(*) AS sent, COUNT(clicked_at) AS clicked, COUNT(opted_out_at) AS stopped FROM review_requests WHERE sent_at >= ?`, since);
  const recent = ctx.db.all(`SELECT r.id, r.reason, r.detail, r.sent_at, r.clicked_at, r.opted_out_at, c.name AS athlete_name, f.name AS family_name
    FROM review_requests r LEFT JOIN clients c ON c.id = r.client_id LEFT JOIN families f ON f.id = r.family_id ORDER BY r.sent_at DESC LIMIT 10`);
  const sample = reviewMessage(ctx, { parent: 'Maria Lopez', athlete: 'Ava Lopez', reason: 'milestone', detail: `${MILESTONE} sessions` }, `${ctx.publicUrl ?? ''}/r/example`);
  return { review_url: getSetting(ctx, 'review_url'), on: getSetting(ctx, 'review_requests') === 'on', last_90_days: s, recent, sample };
}
