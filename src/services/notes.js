import { newId, v, notFound, conflict, badRequest } from '../util.js';
import { getSetting } from './families.js';
import { athleteProfile, getSession } from './performance.js';
import { athleteReport } from './reports.js';
import { emit } from './events.js';

// Progress notes for parents: after a testing day, a short plain-English paragraph per athlete on what improved and
// what's next. The app drafts it from the results (and, with ANTHROPIC_API_KEY set, has Claude smooth the wording
// without adding facts). A coach reads, edits and approves each one. Parents see an approved note on the report and
// in the portal once the testing day is shared, and it goes in the "results are ready" email.

const LABEL = { s: 's', ms: 'ms', in: 'in', ft: 'ft', cm: 'cm', m: 'm', lb: 'lb', kg: 'kg', mph: 'mph', 'km/h': 'km/h', 'm/s': 'm/s', 'ft/s': 'ft/s', N: 'N', W: 'W', 'W/kg': 'W/kg', 'N/kg': 'N/kg', '%': '%', reps: 'reps', ratio: '', level: '', rpm: 'rpm', points: 'pts', 'ml/kg/min': 'ml/kg/min' };
const FOCUS = { speed: 'acceleration and sprint mechanics', agility: 'change of direction', power: 'jumping and explosive power', force_plate: 'explosive power',
  strength: 'strength in the weight room', conditioning: 'conditioning', sport: 'sport skills', movement: 'movement quality and balance' };
const fmt = (value, unit, decimals = 2) => {
  if (unit === 'in' && value >= 48) { const ft = Math.floor(value / 12), inch = value - ft * 12; return `${ft} ft ${inch.toFixed(inch % 1 ? 1 : 0)} in`; }
  const label = LABEL[unit] ?? unit;
  return `${Number(value).toFixed(decimals ?? 2)}${label ? ` ${label}` : ''}`;
};
const first = (name) => String(name ?? '').split(' ')[0];
// "Vertical jump" reads "the vertical jump" mid-sentence; names that start with an acronym ("CMJ height") keep their capitals.
const lowerFirst = (x) => (/^[A-Z][a-z]/.test(x) ? x[0].toLowerCase() + x.slice(1) : x);
const testLabel = (t) => `${lowerFirst(t.test_name.replace(/\s*\(.*\)$/, ''))}${t.side ? ` (${t.side === 'L' ? 'left' : 'right'})` : ''}`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// The facts for one athlete on one testing day: each headline result with the time before, and whether it's a best.
export function noteFacts(ctx, clientId, sessionId) {
  const s = getSession(ctx, sessionId);
  const c = ctx.db.get('SELECT id, name FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Athlete');
  const days = new Set(ctx.db.all('SELECT DISTINCT substr(recorded_at, 1, 10) AS d FROM perf_results WHERE session_id = ? AND client_id = ? AND voided = 0', sessionId, clientId).map((r) => r.d));
  const tested = new Set(ctx.db.all('SELECT DISTINCT test_id || \'|\' || metric || \'|\' || COALESCE(side, \'\') AS k FROM perf_results WHERE session_id = ? AND client_id = ? AND voided = 0', sessionId, clientId).map((r) => r.k));
  const testIds = new Map(ctx.db.all('SELECT id, key FROM perf_tests').map((t) => [t.key, t.id]));
  const results = athleteProfile(ctx, { client_id: clientId }).filter((p) => p.headline && p.better !== 'none' && p.category !== 'body' && tested.has(`${testIds.get(p.test)}|${p.metric}|${p.side ?? ''}`)).map((p) => {
    const i = p.history.findIndex((h) => days.has(h.date));
    if (i < 0) return null;
    const now = p.history[i].value, prev = i > 0 ? p.history[i - 1].value : null;
    const better = prev == null ? null : p.better === 'lower' ? prev - now : now - prev;
    const earlierBest = i > 0 ? (p.better === 'lower' ? Math.min(...p.history.slice(0, i).map((h) => h.value)) : Math.max(...p.history.slice(0, i).map((h) => h.value))) : null;
    return { test: p.test, name: testLabel(p), base: lowerFirst(p.test_name.replace(/\s*\(.*\)$/, '')), category: p.category, unit: p.unit, decimals: p.decimals, better: p.better, now, prev,
      pct: prev ? +((better / Math.abs(prev)) * 100).toFixed(1) : null, pr: earlierBest != null && (p.better === 'lower' ? now < earlierBest : now > earlierBest) };
  }).filter(Boolean);
  const growth = athleteReport(ctx, clientId).growth;
  return { athlete: first(c.name), session: s.name, date: s.date, results, growth_phase: growth?.estimate?.phase ?? null };
}

// A plain draft from the facts. Uses the athlete's first name, never a pronoun.
export function draftFromFacts(f) {
  const a = f.athlete, r = f.results;
  if (!r.length) return `${a} didn't have results we could compare at ${f.session}. We'll have a fuller picture after the next testing day.`;
  const out = [];
  const up = r.filter((x) => x.pct > 0.5).sort((x, y) => y.pct - x.pct);
  const down = r.filter((x) => x.pct != null && x.pct < -2).sort((x, y) => x.pct - y.pct);
  const firsts = r.filter((x) => x.prev == null);
  out.push(`${a} tested ${r.length === 1 ? `the ${r[0].name}` : `${r.length} events`} at ${f.session}.`);
  if (up.length) {
    const [top, second] = up;
    out.push(`The biggest step forward was the ${top.name}: ${fmt(top.prev, top.unit, top.decimals)} to ${fmt(top.now, top.unit, top.decimals)}, ${top.pct}% better than last time${top.pr ? ` and a new personal best` : ''}.`);
    if (second) out.push(`The ${second.name} improved too (${fmt(second.prev, second.unit, second.decimals)} to ${fmt(second.now, second.unit, second.decimals)}${second.pr ? ', another best' : ''}).`);
    // Both sides of a test read as one: "5-10-5 pro agility (both sides)".
    const rest = up.slice(2).filter((x) => x.pr), bases = [...new Set(rest.map((x) => x.base))];
    const morePrs = bases.map((b) => { const xs = rest.filter((x) => x.base === b); return xs.length > 1 ? `${b} (both sides)` : xs[0].name; });
    if (morePrs.length) out.push(`New bests as well in ${list(morePrs.map((x) => `the ${x}`))}.`);
  } else if (r.some((x) => x.prev != null)) out.push(`Results held steady against last time, which is a solid base to build on.`);
  if (firsts.length) out.push(`This was ${a}'s first ${list(firsts.map((x) => `${x.name} (${fmt(x.now, x.unit, x.decimals)})`))}, the starting point we'll measure progress from.`);
  if (down.length) {
    const d = down[0];
    out.push(`The ${d.name} came in a little under last time (${fmt(d.prev, d.unit, d.decimals)} to ${fmt(d.now, d.unit, d.decimals)}). One testing day is a snapshot, so we'll keep an eye on it.${f.growth_phase === 'during' ? ' Small dips like this are common during a growth spurt.' : ''}`);
  }
  const focusCat = down[0]?.category ?? [...r].filter((x) => x.pct != null).sort((x, y) => x.pct - y.pct)[0]?.category ?? r[0].category;
  out.push(`Next, the focus is ${FOCUS[focusCat] ?? 'building on these results'}.`);
  return out.join(' ');
}

// Optional: with ANTHROPIC_API_KEY, Claude rewrites the draft to read naturally. It gets the facts and the draft,
// never contact details, and is told not to add anything. Any failure falls back to the plain draft.
async function polish(ctx, facts, draft) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.DP_AI_MODEL || 'claude-sonnet-5', max_tokens: 400,
        system: `You write short progress notes from a youth sports-performance coach at ${getSetting(ctx, 'business_name')} to a parent. Warm, plain English, 60 to 110 words, one paragraph. Use only the facts given; never invent numbers, injuries or plans. Refer to the athlete by first name and never use he, she, him or her. No greeting or sign-off.`,
        messages: [{ role: 'user', content: `Facts (JSON): ${JSON.stringify(facts)}\n\nDraft to improve:\n${draft}` }] }) });
    if (!res.ok) return null;
    const d = await res.json();
    const text = d.content?.find((x) => x.type === 'text')?.text?.trim();
    return text && text.length <= 2000 ? text : null;
  } catch { return null; }
}

const noteOut = (n) => (n ? { id: n.id, body: n.body, source: n.source, approved: !!n.approved_at, approved_by: n.approved_by, approved_at: n.approved_at, updated_at: n.updated_at } : null);

// The testing day's athletes and their notes.
export function sessionNotes(ctx, sessionId) {
  const s = getSession(ctx, sessionId);
  const kids = ctx.db.all(`SELECT DISTINCT c.id, c.name FROM perf_results r JOIN clients c ON c.id = r.client_id WHERE r.session_id = ? AND r.voided = 0 ORDER BY c.name`, sessionId);
  return { session_id: s.id, shared: !!s.shared_at, ai: !!process.env.ANTHROPIC_API_KEY,
    data: kids.map((k) => ({ client_id: k.id, name: k.name, note: noteOut(ctx.db.get('SELECT * FROM progress_notes WHERE client_id = ? AND perf_session_id = ?', k.id, sessionId)) })) };
}

// Draft notes for athletes who don't have one yet (or redo the ones named). Approved notes are never replaced.
export async function draftNotes(ctx, sessionId, body = {}) {
  const current = sessionNotes(ctx, sessionId);
  const redo = new Set(Array.isArray(body.client_ids) ? body.client_ids.map(String) : []);
  let drafted = 0;
  for (const k of current.data) {
    if (k.note?.approved || (k.note && !redo.has(k.client_id))) continue;
    const facts = noteFacts(ctx, k.client_id, sessionId);
    const plain = draftFromFacts(facts);
    const smooth = await polish(ctx, facts, plain);
    ctx.db.run(`INSERT INTO progress_notes (id, client_id, perf_session_id, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (client_id, perf_session_id) DO UPDATE SET body = excluded.body, source = excluded.source, updated_at = excluded.updated_at`,
      newId('pn'), k.client_id, sessionId, smooth ?? plain, smooth ? 'ai' : 'draft', ctx.now(), ctx.now());
    drafted++;
  }
  return { ...sessionNotes(ctx, sessionId), drafted };
}

// Edit, approve (approved: true) or take back approval (approved: false).
export function updateNote(ctx, id, body = {}, actor) {
  const n = ctx.db.get('SELECT * FROM progress_notes WHERE id = ?', id);
  if (!n) throw notFound('Note');
  const text = body.body !== undefined ? v.str(body.body, 'body', { max: 2000 }) : n.body;
  if (!text.trim()) throw badRequest('Write the note, or leave it as drafted.');
  const approve = body.approved === undefined ? !!n.approved_at : body.approved === true;
  ctx.db.run(`UPDATE progress_notes SET body = ?, source = CASE WHEN ? != body THEN 'edited' ELSE source END, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?`,
    text, text, approve ? n.approved_at ?? ctx.now() : null, approve ? n.approved_by ?? actor?.name ?? 'Coach' : null, ctx.now(), id);
  if (approve && !n.approved_at) emit(ctx, 'progress_note.approved', { note_id: id, client_id: n.client_id, testing_session_id: n.perf_session_id });
  return noteOut(ctx.db.get('SELECT * FROM progress_notes WHERE id = ?', id));
}
// Approve every draft on a testing day at once, after the coach has read them.
export function approveAll(ctx, sessionId, actor) {
  getSession(ctx, sessionId);
  const r = ctx.db.run('UPDATE progress_notes SET approved_at = ?, approved_by = ?, updated_at = ? WHERE perf_session_id = ? AND approved_at IS NULL', ctx.now(), actor?.name ?? 'Coach', ctx.now(), sessionId);
  if (!r.changes) throw conflict('There are no drafts waiting on this testing day.');
  return { ...sessionNotes(ctx, sessionId), approved: r.changes };
}
