// The API & integrations screen at a glance: API keys, webhooks, email, texts and exercise demo videos.
import { listApiKeys } from './access.js';
import { listEndpoints } from './events.js';
import { mailMode, outboxCounts } from './mail.js';
import { smsMode, textCounts } from './sms.js';
import { listExercises } from './programs.js';
import { notFound, badRequest, zonedToUtc } from '../util.js';
import { getSetting } from './families.js';
import { findByAthleteId } from './athlete-ids.js';

// How an exercise's demo video plays in the workout app (ui.js#videoEmbed): YouTube and Vimeo in their players, a
// direct video file in the browser's player. Anything else (a Google Drive or Instagram page, say) won't play.
export function videoKind(url) {
  if (!url) return null;
  let u; try { u = new URL(url); } catch { return 'unplayable'; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') return u.pathname.length > 1 ? 'youtube' : 'unplayable';
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) return u.searchParams.get('v') || /^\/(embed|shorts|live)\/[\w-]+/.test(u.pathname) ? 'youtube' : 'unplayable';
  if (host.endsWith('vimeo.com')) return /\/\d+/.test(u.pathname) ? 'vimeo' : 'unplayable';
  return /\.(mp4|m4v|webm|mov|ogv)$/i.test(u.pathname) ? 'file' : 'unplayable';
}
// Coverage of the exercise library: how many have a video that plays, and a list of what needs one: exercises used in
// programs first (most used first), unplayable links flagged.
export function videoCoverage(ctx) {
  const all = listExercises(ctx);
  const by_kind = { youtube: 0, vimeo: 0, file: 0 };
  const attention = [];
  for (const e of all) {
    const kind = videoKind(e.video_url);
    if (by_kind[kind] !== undefined) by_kind[kind]++;
    else attention.push({ id: e.id, name: e.name, category: e.category ?? null, uses: e.uses, programs: e.programs.map((p) => p.name), video_url: e.video_url ?? null, problem: e.video_url ? 'unplayable' : 'missing' });
  }
  attention.sort((a, b) => (b.uses > 0) - (a.uses > 0) || b.uses - a.uses || a.name.localeCompare(b.name));
  const withVideo = by_kind.youtube + by_kind.vimeo + by_kind.file;
  return { total: all.length, with_video: withVideo, pct: all.length ? Math.round((withVideo / all.length) * 100) : null, by_kind,
    in_use_missing: attention.filter((a) => a.uses > 0).length, unplayable: attention.filter((a) => a.problem === 'unplayable').length, attention };
}

// The status strip: each tile says whether something needs a look.
export function apiStatus(ctx) {
  const keys = listApiKeys(ctx), live = keys.filter((k) => !k.revoked_at);
  const hooks = listEndpoints(ctx);
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const mailFailed7 = ctx.db.get(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed' AND created_at >= ?`, week).n;
  const textFailed7 = ctx.db.get(`SELECT COUNT(*) AS n FROM texts WHERE status = 'failed' AND created_at >= ?`, week).n;
  const video = videoCoverage(ctx);
  return {
    keys: { active: live.length, revoked: keys.length - live.length, requests_30d: live.reduce((t, k) => t + k.requests_30d, 0), errors_30d: live.reduce((t, k) => t + k.errors_30d, 0),
      full_access: live.filter((k) => k.scope === 'full').length },
    webhooks: { total: hooks.length, active: hooks.filter((w) => w.active).length, failing: hooks.filter((w) => w.active && w.failing).length, failed_7d: hooks.reduce((t, w) => t + w.failed_7d, 0), waiting: hooks.reduce((t, w) => t + w.waiting, 0) },
    email: { mode: mailMode(ctx), failed_7d: mailFailed7, counts: outboxCounts(ctx) },
    texts: { mode: smsMode(ctx), failed_7d: textFailed7, counts: textCounts(ctx) },
    video: { total: video.total, with_video: video.with_video, pct: video.pct, in_use_missing: video.in_use_missing, unplayable: video.unplayable }
  };
}

// One athlete's results by Athlete ID (old team roster IDs too), newest first. best marks each test's best result among
// those returned (per metric and side, lower or higher as the test says). since is a date: from midnight in the business
// time zone (results are stored in UTC).
export function athleteResults(ctx, athleteId, q = {}) {
  const who = findByAthleteId(ctx, athleteId);
  if (!who) throw notFound('Athlete');
  const c = ctx.db.get('SELECT id, name, athlete_id FROM clients WHERE id = ?', who.client_id);
  const where = ['r.client_id = ?', 'r.voided = 0'], p = [c.id];
  if (q.test) {
    const t = ctx.db.get('SELECT id FROM perf_tests WHERE key = ? OR id = ?', String(q.test), String(q.test));
    if (!t) throw badRequest(`"${String(q.test).slice(0, 60)}" isn't a test in the library. GET /v1/tests lists them.`);
    where.push('r.test_id = ?'); p.push(t.id);
  }
  if (q.since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.since)) || Number.isNaN(Date.parse(q.since))) throw badRequest('since must be a date like 2026-09-01.');
    where.push('r.recorded_at >= ?'); p.push(zonedToUtc(q.since, '00:00', getSetting(ctx, 'timezone')));
  }
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000);
  const rows = ctx.db.all(`SELECT r.id, t.key AS test, t.name AS test_name, r.metric, m.name AS metric_name, m.unit, m.better, r.side, r.attempt, r.value, r.source, r.device, r.session_id, s.name AS testing_day, r.recorded_at
    FROM perf_results r JOIN perf_tests t ON t.id = r.test_id JOIN perf_metrics m ON m.test_id = r.test_id AND m.key = r.metric LEFT JOIN perf_sessions s ON s.id = r.session_id
    WHERE ${where.join(' AND ')} ORDER BY r.recorded_at DESC, r.created_at DESC LIMIT ?`, ...p, limit);
  const best = new Map();
  for (const r of rows) {
    if (r.better === 'none') continue;
    const k = `${r.test}|${r.metric}|${r.side ?? ''}`, b = best.get(k);
    if (!b || (r.better === 'lower' ? r.value < b.value : r.value > b.value)) best.set(k, r);
  }
  const bestIds = new Set([...best.values()].map((r) => r.id));
  return { athlete: { client_id: c.id, athlete_id: c.athlete_id, name: c.name },
    data: rows.map(({ better, ...r }) => ({ ...r, better, best: bestIds.has(r.id) })) };
}
