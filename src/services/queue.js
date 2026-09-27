import { v, badRequest, notFound, conflict, HttpError } from '../util.js';
import { recordResults, linkAthlete, resolveAthlete, getTest, identityOf } from './performance.js';
import { findByAthleteId } from './athlete-ids.js';
import { emit } from './events.js';

const SOURCE_NAMES = { api: 'Open API', hawkin: 'Hawkin Dynamics', ovr: 'OVR Performance', vald: 'VALD', swift: 'Swift', freelap: 'Freelap', brower: 'Brower', dashr: 'Dashr', just_jump: 'Jump mat', rapsodo: 'Rapsodo', pocket_radar: 'Radar', generic: 'File import' };

// Waiting results grouped by sender and athlete identity ("OVR · Tyler G", "Hawkin · device athlete ath-3").
export function listQueue(ctx, { status = 'pending' } = {}) {
  const rows = ctx.db.all('SELECT * FROM results_queue WHERE status = ? ORDER BY received_at', status);
  const groups = new Map();
  const tests = new Map();
  for (const r of rows) {
    const k = `${r.provider}|${r.identity}`;
    const ref = JSON.parse(r.athlete_ref), item = JSON.parse(r.item);
    if (!groups.has(k)) groups.set(k, { provider: r.provider, source_name: SOURCE_NAMES[r.provider] ?? r.provider, identity: r.identity, athlete: ref,
      label: ref.name ?? ref.athlete_id ?? ref.external_id ?? ref.email ?? 'Unknown athlete', device_id: ref.external_id ?? null, first_received: r.received_at, items: [] });
    const g = groups.get(k);
    if (!tests.has(item.test)) tests.set(item.test, getTest(ctx, item.test));
    const t = tests.get(item.test), m = t.metrics.find((x) => x.key === item.metric);
    g.items.push({ id: r.id, source: r.source, test: item.test, test_name: t.name, metric: item.metric, metric_name: m.name, value: item.value, unit: item.unit, decimals: m.decimals, side: item.side, attempt: item.attempt, recorded_at: item.recorded_at, device: item.device, received_at: r.received_at });
    g.last_received = r.received_at;
  }
  return [...groups.values()].map((g) => ({ ...g, count: g.items.length, suggestions: suggestionsFor(ctx, g.athlete) }))
    .sort((a, b) => b.last_received.localeCompare(a.last_received));
}
export const queueCount = (ctx) => ctx.db.get(`SELECT COUNT(*) AS n, COUNT(DISTINCT provider || '|' || identity) AS groups FROM results_queue WHERE status = 'pending'`);

// Similar names and near-miss IDs, to make picking the right profile quick. Never applied automatically.
function suggestionsFor(ctx, ref) {
  const all = [...ctx.db.all('SELECT id AS client_id, NULL AS roster_id, name, athlete_id FROM clients'), ...ctx.db.all('SELECT NULL AS client_id, id AS roster_id, name, athlete_id FROM team_roster WHERE active = 1')];
  const words = String(ref.name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
  const idGuess = String(ref.athlete_id ?? ref.external_id ?? ref.name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const score = (a) => {
    let s = 0;
    const w = a.name.toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').split(/\s+/);
    if (words.length && w[w.length - 1] === words[words.length - 1]) s += 2;
    if (words.length && w[0].slice(0, 3) === words[0].slice(0, 3)) s += 1;
    if (idGuess.length >= 6 && a.athlete_id?.startsWith(idGuess.slice(0, 6))) s += 3;
    return s;
  };
  return all.map((a) => ({ ...a, s: score(a) })).filter((a) => a.s > 0).sort((a, b) => b.s - a.s).slice(0, 3).map(({ s, ...a }) => a);
}

function targetFrom(ctx, body) {
  const t = body.athlete_id ? findByAthleteId(ctx, body.athlete_id) : body.client_id ? { client_id: body.client_id } : body.roster_id ? { roster_id: body.roster_id } : null;
  if (!t || !resolveAthlete(ctx, t)) throw badRequest(body.athlete_id ? `No athlete has the ID ${String(body.athlete_id).toUpperCase()}.` : 'Choose the athlete these results belong to.');
  const p = t.client_id ? ctx.db.get('SELECT name, athlete_id, archived_at FROM clients WHERE id = ?', t.client_id) : ctx.db.get('SELECT name, athlete_id FROM team_roster WHERE id = ?', t.roster_id);
  if (p.archived_at) throw badRequest(`${p.name} is archived. Restore their profile first, or pick someone else.`);
  return { client_id: t.client_id, roster_id: t.roster_id, name: p.name, athlete_id: p.athlete_id };
}

// Link waiting results to a profile. Either everything from one sender identity (provider + identity),
// or specific queue items (ids). All of them are saved, or none: if anything fails, nothing moves.
// remember=true also saves the device ID or name so future results go straight to this athlete.
export function linkQueue(ctx, body) {
  const target = targetFrom(ctx, body);
  let rows;
  if (Array.isArray(body.ids) && body.ids.length) {
    rows = body.ids.map((id) => ctx.db.get('SELECT * FROM results_queue WHERE id = ?', String(id)));
    if (rows.some((r) => !r)) throw notFound('Waiting result');
  } else {
    const provider = v.str(body.provider, 'provider', { max: 40 }), identity = v.str(body.identity, 'identity', { max: 300 });
    rows = ctx.db.all(`SELECT * FROM results_queue WHERE provider = ? AND identity = ? AND status = 'pending' ORDER BY received_at`, provider, identity);
  }
  if (rows.some((r) => r.status !== 'pending')) throw conflict('Some of these results were already linked or discarded. Refresh and try again.');
  if (!rows.length) throw notFound('Waiting results');
  if (body.remember && new Set(rows.map((r) => `${r.provider}|${r.identity}`)).size > 1) throw badRequest('Remember a link one sender at a time.');
  if (body.expect_count != null && Number(body.expect_count) !== rows.length) throw conflict(`${rows.length} results are waiting now, not ${body.expect_count}. Refresh and check again.`);
  return ctx.db.tx(() => {
    const items = rows.map((r) => ({ ...JSON.parse(r.item), client_id: target.client_id, roster_id: target.roster_id, session_id: r.session_id ?? undefined, source: r.source }));
    const out = recordResults(ctx, items, { source: rows[0].source, queue: false });
    if (out.errors.length || out.unmatched.length) {
      const e = new HttpError(409, 'link_failed', 'Nothing was linked. Some results could not be saved.');
      e.details = out.errors;
      throw e;
    }
    const byIndex = new Map(out.results.map((x) => [x.index, x.id]));
    rows.forEach((r, i) => ctx.db.run(`UPDATE results_queue SET status = 'linked', result_id = ?, resolved_at = ? WHERE id = ?`, byIndex.get(i) ?? null, ctx.now(), r.id));
    let remembered = null;
    if (body.remember) {
      const r = rows[0];
      remembered = linkAthlete(ctx, { provider: r.provider, external_id: r.identity.replace(/^id:/, ''), external_name: JSON.parse(r.athlete_ref).name ?? null, client_id: target.client_id, roster_id: target.roster_id });
    }
    emit(ctx, 'queue.linked', { count: rows.length, athlete_id: target.athlete_id, athlete_name: target.name, remembered: !!remembered });
    return { linked: rows.length, saved: out.created, already_saved: out.duplicates, prs: out.prs.length, athlete: { client_id: target.client_id ?? null, roster_id: target.roster_id ?? null, name: target.name, athlete_id: target.athlete_id }, remembered };
  });
}

export function discardQueue(ctx, body) {
  const ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(String)
    : ctx.db.all(`SELECT id FROM results_queue WHERE provider = ? AND identity = ? AND status = 'pending'`, v.str(body.provider, 'provider'), v.str(body.identity, 'identity')).map((r) => r.id);
  if (!ids.length) throw notFound('Waiting results');
  let n = 0;
  ctx.db.tx(() => { for (const id of ids) n += ctx.db.run(`UPDATE results_queue SET status = 'discarded', resolved_at = ? WHERE id = ? AND status = 'pending'`, ctx.now(), id).changes; });
  return { discarded: n };
}

// Link a device ahead of time: results from this device ID (or the name the device uses) go straight to the athlete.
// Anything already waiting from it is linked now, all or nothing. Linking a device that's already linked moves it;
// moved_from says who had it.
export function linkDevice(ctx, body) {
  const provider = v.str(String(body.provider ?? '').trim().toLowerCase(), 'provider', { max: 40 });
  const raw = v.str(String(body.external_id ?? '').trim(), 'external_id', { max: 200 });
  const byName = body.kind === 'name' || raw.startsWith('name:');
  const externalId = byName ? identityOf({ name: raw.replace(/^name:/, '') }) : raw;
  if (byName && externalId === 'name:') throw badRequest('Enter the name the device uses for this athlete.');
  const identity = byName ? externalId : `id:${externalId}`;
  const target = targetFrom(ctx, body);
  const before = ctx.db.get(`SELECT l.client_id, l.roster_id, l.external_name, COALESCE(c.name, r.name) AS name, COALESCE(c.athlete_id, r.athlete_id) AS athlete_id FROM athlete_links l
    LEFT JOIN clients c ON c.id = l.client_id LEFT JOIN team_roster r ON r.id = l.roster_id WHERE l.provider = ? AND l.external_id = ?`, provider, externalId);
  const waiting = ctx.db.all(`SELECT id, athlete_ref FROM results_queue WHERE provider = ? AND identity = ? AND status = 'pending' ORDER BY received_at`, provider, identity);
  // Keep the name the device uses (from what's waiting, or the existing link) rather than labelling it with the bare ID.
  const deviceName = String(body.external_name ?? '').trim().slice(0, 120) || before?.external_name || waiting.map((w) => JSON.parse(w.athlete_ref).name).find(Boolean) || (byName ? raw.replace(/^name:/, '') : null);
  return ctx.db.tx(() => {
    const link = linkAthlete(ctx, { provider, external_id: externalId, external_name: deviceName, client_id: target.client_id, roster_id: target.roster_id });
    const moved = !!before && (before.client_id !== (target.client_id ?? null) || before.roster_id !== (target.roster_id ?? null));
    const linked = waiting.length ? linkQueue(ctx, { client_id: target.client_id, roster_id: target.roster_id, ids: waiting.map((w) => w.id) }) : { linked: 0, prs: 0 };
    return { ...link, external_name: deviceName, athlete_id: target.athlete_id, moved_from: moved ? { name: before.name, athlete_id: before.athlete_id } : null, already_linked: !!before && !moved, linked: linked.linked, prs: linked.prs };
  });
}
