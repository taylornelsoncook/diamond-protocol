import { v, notFound, conflict, ageOn } from '../util.js';
import { athleteProfile, getSession, parentFilter } from './performance.js';
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
export function athleteReport(ctx, clientId, { parentView = false } = {}) {
  const c = ctx.db.get('SELECT id, athlete_id, name, birth_date, sex, sport, position, school, grad_year FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  const profile = athleteProfile(ctx, { client_id: c.id }, { parentView });
  const tests = profile.filter((p) => p.headline && p.category !== 'body' && p.better !== 'none');
  const pct = (p) => (p.change == null || !p.first.value ? null : ((p.better === 'lower' ? -p.change : p.change) / p.first.value) * 100);
  const withPct = tests.map((p) => ({ test: p.test, test_name: p.test_name, category: p.category, metric_name: p.metric_name, unit: p.unit, decimals: p.decimals, better: p.better, side: p.side,
    first: p.first, latest: p.latest, best: p.best, best_date: p.best_date, tests_count: p.tests_count, change: p.change, improved: p.improved, improvement_pct: pct(p) == null ? null : +pct(p).toFixed(1), history: p.history }));
  const highlights = withPct.filter((t) => t.improvement_pct > 0).sort((a, b) => b.improvement_pct - a.improvement_pct).slice(0, 3);
  const sessions = ctx.db.all(`SELECT DISTINCT s.id, s.name, s.date, s.parent_note, s.shared_at FROM perf_sessions s JOIN perf_results r ON r.session_id = s.id
    WHERE r.client_id = ? AND r.voided = 0 ${parentView ? 'AND s.shared_at IS NOT NULL' : ''} ORDER BY s.date DESC`, c.id);
  const last = sessions[0];
  const short = (n) => n.replace(/\s*\(.*\)$/, '');
  const prTests = last ? withPct.filter((t) => t.best_date === last.date && t.tests_count > 1) : [];
  const newPrs = [...new Set(prTests.map((t) => short(t.test_name)))].map((name) => {
    const sides = prTests.filter((t) => short(t.test_name) === name).map((t) => t.side).filter(Boolean);
    return sides.length === 2 ? `${name} (both sides)` : sides.length === 1 ? `${name} (${sides[0] === 'L' ? 'left' : 'right'})` : name;
  });
  const all = [...profile].flatMap((p) => p.history.map((h) => h.date)).sort();
  return {
    athlete: { ...c, age: ageOn(c.birth_date, new Date().toISOString()) },
    business: { name: getSetting(ctx, 'business_name') },
    period: all.length ? { from: all[0], to: all.at(-1) } : null,
    tests: withPct, highlights, latest_session: last ?? null, new_prs: newPrs, sessions,
    growth: growth(ctx, profile, c), generated_at: new Date().toISOString(),
    visibility: parentView ? (getSetting(ctx, 'share_results') === 'all' ? 'all' : 'shared') : 'coach'
  };
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
      notifyFamily(ctx, k.family_id, `${k.name.split(' ')[0]}'s results from ${s.name} are ready`,
        `${k.name.split(' ')[0]}'s results from ${s.name} are in the parent portal, with progress since earlier tests.${note ? `\n\nFrom your coach: ${note}` : ''}\n\nSee them: ${baseUrl ?? ctx.publicUrl ?? ''}/parent`);
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
