import { v, notFound, conflict, badRequest, HttpError, ageOn, isDate, sha256, token, newId } from '../util.js';
import { athleteProfile, getSession, parentFilter, CATEGORIES } from './performance.js';
import { getSetting } from './families.js';
import { notifyFamily } from './mail.js';
import { emit } from './events.js';

// ---------- Growth: estimated timing of the adolescent growth spurt ----------
// Mirwald et al. (2002) maturity offset: years from peak height velocity, from age, sex, standing
// height, seated height and weight. Reliable to about ±1 year; meant for roughly ages 8–17.
export function maturityOffset({ sex, age, heightCm, seatedCm, weightKg }) {
  const leg = heightCm - seatedCm;
  if (sex === 'M') return -9.236 + 0.0002708 * leg * seatedCm - 0.001663 * age * leg + 0.007216 * age * seatedCm + 0.02292 * (weightKg / heightCm) * 100;
  if (sex === 'F') return -9.376 + 0.0001882 * leg * seatedCm + 0.0022 * age * leg + 0.005841 * age * seatedCm - 0.002658 * age * weightKg + 0.07693 * (weightKg / heightCm) * 100;
  return null;
}
function growth(ctx, profile, client) {
  const series = (key) => profile.find((p) => p.test === key)?.history ?? [];
  const heights = series('height'), seated = series('seated_height'), weights = series('weight');
  const out = { heights: heights.map((h) => ({ date: h.date, value: h.value })), latest_height: heights.at(-1) ?? null, latest_weight: weights.at(-1) ?? null, estimate: null, missing: [] };
  if (heights.length > 1) {
    const a = heights[0], b = heights.at(-1), years = (Date.parse(b.date) - Date.parse(a.date)) / (365.25 * 864e5);
    if (years >= 0.25) out.growth_per_year = (b.value - a.value) / years;
  }
  // The most recent day with height and seated height; weight from that day or the closest one.
  const day = [...heights].reverse().find((h) => seated.some((s) => s.date === h.date));
  if (!client?.birth_date) out.missing.push('birthday');
  if (!client?.sex) out.missing.push('sex');
  if (!seated.length) out.missing.push('seated height');
  if (!weights.length) out.missing.push('weight');
  if (!day || out.missing.length) return out;
  const w = [...weights].sort((x, y) => Math.abs(Date.parse(x.date) - Date.parse(day.date)) - Math.abs(Date.parse(y.date) - Date.parse(day.date)))[0];
  const age = (Date.parse(day.date) - Date.parse(client.birth_date)) / (365.25 * 864e5);
  if (age < 8 || age > 18) { out.note = 'Growth-spurt estimates are for ages 8 to 17.'; return out; }
  const offset = maturityOffset({ sex: client.sex, age, heightCm: day.value * 2.54, seatedCm: seated.find((s) => s.date === day.date).value * 2.54, weightKg: w.value * 0.45359237 });
  const phase = offset < -1 ? 'before' : offset <= 1 ? 'during' : 'after';
  out.estimate = { measured_on: day.date, age: +age.toFixed(1), offset: +offset.toFixed(1), peak_age: +(age - offset).toFixed(1), phase,
    text: phase === 'before' ? `About ${Math.abs(offset).toFixed(1)} years before the fastest growth. Speed and power often jump once the growth spurt comes.`
      : phase === 'during' ? 'Around the growth spurt now. Coordination can dip for a while as limbs grow; progress usually returns quickly after.'
      : `About ${offset.toFixed(1)} years past the fastest growth. Strength gains usually come more easily from here.` };
  return out;
}

// ---------- The report ----------
// Optional period: from / to as YYYY-MM-DD (all time when both are empty).
export function reportPeriod(q = {}) {
  const from = q.from ? String(q.from) : null, to = q.to ? String(q.to) : null;
  if ((from && !isDate(from)) || (to && !isDate(to))) throw badRequest('Dates need to look like 2026-09-01.');
  if (from && to && from > to) throw badRequest('The start of the period has to be before the end.');
  return { from, to };
}
const groupKey = (p) => `${p.test}|${p.metric}|${p.side ?? ''}`;
export function athleteReport(ctx, clientId, { parentView = false, from = null, to = null } = {}) {
  const c = ctx.db.get('SELECT id, athlete_id, name, birth_date, sex, sport, position, school, grad_year FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  const profile = athleteProfile(ctx, { client_id: c.id }, { parentView, from, to });
  // In the coach view, mark results the family can't see yet (from testing days that haven't been shared).
  const familyDates = parentView ? null : new Map(athleteProfile(ctx, { client_id: c.id }, { parentView: true, from, to }).map((p) => [groupKey(p), new Set(p.history.map((x) => x.date))]));
  const tests = profile.filter((p) => p.headline && p.category !== 'body' && p.better !== 'none');
  const pct = (p, base) => (base == null || !base.value ? null : +(((p.better === 'lower' ? base.value - p.latest.value : p.latest.value - base.value) / base.value) * 100).toFixed(1));
  const withPct = tests.map((p) => {
    const previous = p.history.length > 1 ? p.history.at(-2) : null;
    const unshared = familyDates ? p.history.filter((x) => !familyDates.get(groupKey(p))?.has(x.date)).length : 0;
    return { test: p.test, test_name: p.test_name, category: p.category, metric_name: p.metric_name, unit: p.unit, decimals: p.decimals, better: p.better, side: p.side,
      first: p.first, latest: p.latest, previous, best: p.best, best_date: p.best_date, tests_count: p.tests_count, change: p.change, improved: p.improved,
      improvement_pct: p.history.length > 1 ? pct(p, p.first) : null,
      change_last: previous ? p.latest.value - previous.value : null, improved_last: previous ? (p.better === 'lower' ? p.latest.value < previous.value : p.latest.value > previous.value) : null,
      improvement_pct_last: previous ? pct(p, previous) : null, history: p.history, ...(familyDates ? { unshared_days: unshared } : {}) };
  });
  const highlights = withPct.filter((t) => t.improvement_pct > 0).sort((a, b) => b.improvement_pct - a.improvement_pct).slice(0, 3);
  const daysSql = (withPeriod) => `SELECT DISTINCT s.id, s.name, s.date, s.parent_note, s.shared_at FROM perf_sessions s JOIN perf_results r ON r.session_id = s.id
    WHERE r.client_id = ? AND r.voided = 0 ${parentView ? 'AND s.shared_at IS NOT NULL' : ''} ${withPeriod && from ? 'AND s.date >= ?' : ''} ${withPeriod && to ? 'AND s.date <= ?' : ''} ORDER BY s.date DESC`;
  const sessions = ctx.db.all(daysSql(true), c.id, ...(from ? [from] : []), ...(to ? [to] : []));
  const allSessions = ctx.db.all(daysSql(false), c.id).map((s) => ({ id: s.id, name: s.name, date: s.date, shared: !!s.shared_at }));
  // The coach's approved note for this athlete on the latest testing day.
  const last = sessions[0] ? { ...sessions[0], athlete_note: ctx.db.get('SELECT body FROM progress_notes WHERE client_id = ? AND perf_session_id = ? AND approved_at IS NOT NULL', c.id, sessions[0].id)?.body ?? null } : undefined;
  const short = (n) => n.replace(/\s*\(.*\)$/, '');
  const prTests = last ? withPct.filter((t) => t.best_date === last.date && t.tests_count > 1) : [];
  const newPrs = [...new Set(prTests.map((t) => short(t.test_name)))].map((name) => {
    const sides = prTests.filter((t) => short(t.test_name) === name).map((t) => t.side).filter(Boolean);
    return sides.length === 2 ? `${name} (both sides)` : sides.length === 1 ? `${name} (${sides[0] === 'L' ? 'left' : 'right'})` : name;
  });
  const all = [...profile].flatMap((p) => p.history.map((h) => h.date)).sort();
  return {
    athlete: { ...c, age: ageOn(c.birth_date, new Date().toISOString()) },
    business: { name: getSetting(ctx, 'business_name') }, categories: CATEGORIES.map(([key, name]) => ({ key, name })),
    period: all.length ? { from: all[0], to: all.at(-1) } : null, filter: { from, to },
    tests: withPct, highlights, latest_session: last ?? null, new_prs: newPrs, sessions, all_sessions: allSessions,
    unshared_tests: withPct.filter((t) => t.unshared_days > 0).length,
    growth: growth(ctx, profile, c), generated_at: new Date().toISOString(),
    visibility: parentView ? (getSetting(ctx, 'share_results') === 'all' ? 'all' : 'shared') : 'coach'
  };
}

// ---------- Share links ----------
// A private link to the family view of one athlete's report that works without signing in, for 7 days to a year,
// until someone turns it off. The link's secret is 24 random bytes; only its hash is stored, and every wrong,
// expired or turned-off link gets the same answer.
export const LINK_DAYS = [7, 30, 90, 365];
const MAX_LINKS = 10;
const hashLink = (t) => sha256(`report-link:${t}`);
const LINK_COLS = 'id, label, created_by_kind, created_by_name, created_at, expires_at, views, last_viewed_at';
const linkGone = () => new HttpError(410, 'link_expired', 'This link has expired or been turned off. Ask the family or the coach for a new one.');
export function listReportLinks(ctx, clientId) {
  return ctx.db.all(`SELECT ${LINK_COLS} FROM report_links WHERE client_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`, clientId, ctx.now());
}
// by: { kind: 'staff' | 'parent', id, name }. The link's address comes back once, here, and is never shown again.
export function createReportLink(ctx, clientId, body = {}, by = {}, baseUrl) {
  const c = ctx.db.get('SELECT id, name, archived_at FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  if (c.archived_at) throw badRequest(`${c.name} is archived. Restore the profile to share the report.`);
  const days = Number(body.days ?? 30);
  if (!LINK_DAYS.includes(days)) throw badRequest('Pick how long the link works: 7, 30, 90 or 365 days.');
  const label = v.str(body.label, 'label', { max: 60, optional: true });
  if (listReportLinks(ctx, c.id).length >= MAX_LINKS) throw badRequest(`${c.name.split(' ')[0]} already has ${MAX_LINKS} working links. Turn one off first.`);
  const secret = token(24), id = newId('rl');
  ctx.db.run(`INSERT INTO report_links (id, client_id, token_hash, label, created_by_kind, created_by_id, created_by_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, c.id, hashLink(secret), label, by.kind === 'parent' ? 'parent' : 'staff', by.id ?? null, by.name ? String(by.name).slice(0, 120) : null, ctx.now(), new Date(Date.parse(ctx.now()) + days * 864e5).toISOString());
  return { ...ctx.db.get(`SELECT ${LINK_COLS} FROM report_links WHERE id = ?`, id), url: `${baseUrl ?? ctx.publicUrl ?? ''}/report.html#share=${secret}` };
}
export function revokeReportLink(ctx, clientId, linkId) {
  const l = ctx.db.get('SELECT id, revoked_at FROM report_links WHERE id = ? AND client_id = ?', String(linkId ?? ''), clientId);
  if (!l) throw notFound('Link');
  if (!l.revoked_at) ctx.db.run('UPDATE report_links SET revoked_at = ? WHERE id = ?', ctx.now(), l.id);
  return { id: l.id, revoked: true };
}
// Opens a working link: the family view (shared testing days only, unless the business shows everything), with the
// age but never the date of birth or IDs. count=false for the same visitor changing the period, so opens aren't inflated.
export function openReportLink(ctx, secret, { count = true, from = null, to = null } = {}) {
  if (typeof secret !== 'string' || !/^[\w-]{20,64}$/.test(secret)) throw linkGone();
  const l = ctx.db.get('SELECT l.id, l.client_id, l.expires_at, c.archived_at FROM report_links l JOIN clients c ON c.id = l.client_id WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > ?', hashLink(secret), ctx.now());
  if (!l || l.archived_at) throw linkGone();
  const r = athleteReport(ctx, l.client_id, { parentView: true, from, to });
  if (count) ctx.db.run('UPDATE report_links SET views = views + 1, last_viewed_at = ? WHERE id = ?', ctx.now(), l.id);
  const { birth_date, athlete_id, id, ...athlete } = r.athlete;
  return { ...r, athlete, sessions: r.sessions.map(({ id: _s, ...s }) => s), all_sessions: r.all_sessions.map(({ id: _s, ...s }) => s), latest_session: r.latest_session ? (({ id: _s, ...s }) => s)(r.latest_session) : null,
    view: 'link', link: { expires_at: l.expires_at } };
}

// ---------- Email the report to the family ----------
const fmtValue = (val, unit, decimals = 2) => (unit === 'in' && Math.abs(val) >= 48 ? `${Math.floor(val / 12)}' ${+(val % 12).toFixed(1)}"` : `${Number(val).toFixed(decimals)}${unit && !['ratio', 'level'].includes(unit) ? ` ${unit}` : ''}`);
export function emailReport(ctx, clientId, body = {}, by = {}, baseUrl) {
  const c = ctx.db.get('SELECT id, name, family_id, archived_at FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  const first = c.name.split(' ')[0];
  if (c.archived_at) throw badRequest(`${c.name} is archived. Restore the profile to email the report.`);
  const parents = c.family_id ? ctx.db.all(`SELECT email FROM guardians WHERE family_id = ? AND email IS NOT NULL AND email != ''`, c.family_id) : [];
  if (!parents.length) throw badRequest(`${first} has no parent email on file. Add a parent on the client profile first.`);
  const note = v.str(body.note, 'note', { max: 2000, optional: true });
  const r = athleteReport(ctx, c.id, { parentView: true });
  if (!r.tests.length) throw badRequest(`${first} has no results the family can see yet. Share a testing day first.`);
  const link = body.include_link ? createReportLink(ctx, c.id, { days: 90, label: 'Emailed to family' }, by, baseUrl) : null;
  const lines = [`Here is ${first}'s progress report from ${r.business.name}.`, ''];
  if (note) lines.push('From your coach:', note, '');
  if (r.highlights.length) lines.push('Biggest improvements:', ...r.highlights.map((t) => `  ${t.test_name}: ${fmtValue(t.first.value, t.unit, t.decimals)} to ${fmtValue(t.latest.value, t.unit, t.decimals)} (+${t.improvement_pct}%)`), '');
  if (r.new_prs.length) lines.push(`New personal records: ${r.new_prs.join(', ')}.`, '');
  lines.push('Open, print or save the full report:', link ? link.url : `${baseUrl ?? ctx.publicUrl ?? ''}/parent`,
    link ? 'This link works for 90 days without signing in. Please share it only with people you trust.' : 'Sign in to the parent portal with this email address to see it.');
  notifyFamily(ctx, c.family_id, `${first}'s progress report`, lines.join('\n'));
  return { emailed: parents.length, link: link ? { id: link.id, expires_at: link.expires_at } : null };
}

// ---------- Sharing a testing day with families ----------
export function shareSession(ctx, id, body = {}, baseUrl) {
  const s = getSession(ctx, id);
  const note = body.parent_note !== undefined ? v.str(body.parent_note, 'parent_note', { max: 2000, optional: true }) : s.parent_note;
  ctx.db.run('UPDATE perf_sessions SET shared_at = COALESCE(shared_at, ?), parent_note = ? WHERE id = ?', ctx.now(), note, id);
  let notified = 0;
  if (body.notify !== false) {
    const kids = ctx.db.all(`SELECT DISTINCT c.id, c.name, c.family_id FROM perf_results r JOIN clients c ON c.id = r.client_id WHERE r.session_id = ? AND r.voided = 0 AND c.family_id IS NOT NULL`, id);
    for (const k of kids) {
      const own = ctx.db.get('SELECT body FROM progress_notes WHERE client_id = ? AND perf_session_id = ? AND approved_at IS NOT NULL', k.id, id)?.body;
      notifyFamily(ctx, k.family_id, `${k.name.split(' ')[0]}'s results from ${s.name} are ready`,
        `${k.name.split(' ')[0]}'s results from ${s.name} are in the parent portal, with progress since earlier tests.${own ? `\n\n${own}` : ''}${note ? `\n\nFrom your coach: ${note}` : ''}\n\nSee them: ${baseUrl ?? ctx.publicUrl ?? ''}/parent`);
      notified++;
    }
  }
  emit(ctx, 'testing.shared', { session_id: id, name: s.name, families_notified: notified });
  return { ...getSession(ctx, id), families_notified: notified };
}
export function unshareSession(ctx, id) {
  getSession(ctx, id);
  ctx.db.run('UPDATE perf_sessions SET shared_at = NULL WHERE id = ?', id);
  return getSession(ctx, id);
}
