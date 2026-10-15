// The game-week helper (owner's ask: "an athlete calendar helper ... day of game, day before, 2 days before, day after
// and 3 days after ... the athlete uploads their games and gets suggestions on what the best thing to do is").
// Athletes (parents through the family account, coaches on the client page) keep their games: typed one at a time, or
// brought in from the team's calendar (.ics from TeamSnap, SportsEngine, GameChanger and the like, a CSV, or pasted
// lines). Every day then knows where it sits against the games (three days out, the day before, game day, the day
// after...), carries the advice for that day, and the workouts on the training calendar are checked against it: a
// workout heavier than the day allows gets a suggestion to move to the nearest day that fits (one tap in the app),
// or, with no good day, to keep it light. The rules and the words are the research brief's starting values
// (docs/game-week.md), and the owner can change them (settings key game_rules). The plan itself never changes: a move
// is one athlete's workout on another date (assignment_moves), the same as a coach's move.
import { newId, v, badRequest, notFound, conflict, addDaysToDate, isDate, localDate } from '../util.js';
import { getSetting } from './families.js';
import { clientCalendar, moveWorkout, today } from './training-calendar.js';
import { repCount } from './rx.js';

export const KINDS = { game: 'Game', tournament: 'Tournament day', scrimmage: 'Scrimmage' };
export const LOADS = ['rest', 'light', 'moderate', 'heavy'];   // in order: what a day allows, and what a workout is
export const MAX_GAMES = 400, MAX_TITLE = 80, HORIZON_DAYS = 21, LIST_DAYS = 120;

// The rules by day, keyed by the days to the game (negative) or since it (positive). allow is the heaviest workout
// that fits the day; advice is what the athlete reads. Starting values from docs/game-week.md.
export const DEFAULT_RULES = {
  '-3': { label: 'Three days out', allow: 'heavy', advice: 'This is the day for your hardest session of the week. Heavy legs, jumps and sprints all fit: by game day you\'ll have recovered and feel sharper for it. Eat well and get to bed on time.' },
  '-2': { label: 'Two days out', allow: 'moderate', advice: 'A normal session is fine, but keep the big leg work for three days out: soreness from heavy or new exercises peaks a day or two later, right on game day. Nothing new today, nothing to failure. Upper body, a moderate lift or speed work are good here.' },
  '-1': { label: 'Day before', allow: 'light', advice: 'Short and sharp: a warm-up, a few fast moves (jumps, short sprints, a light power exercise), then stop while you feel fresh. No heavy lifting, no long conditioning, no new exercises. Sleep 9 hours or more; this night matters more than tomorrow\'s.' },
  '0': { label: 'Game day', allow: 'light', advice: 'Play. Nothing in the weight room unless your coach set up a short activation (10 to 15 minutes in the morning, fast and light, six hours or more before the game). Eat a meal you know 3 to 4 hours before, drink through the day, and do a full warm-up.' },
  '1': { label: 'Day after', allow: 'light', advice: 'Recovery day: your jump and sprint ability is still down and soreness is near its peak. Move for 20 to 30 minutes (an easy bike, a walk, a swim, mobility), stretch, eat and drink well, and sleep. No heavy lifting.' },
  '2': { label: 'Two days after', allow: 'moderate', advice: 'Still recovering: your legs produce less force for 48 to 72 hours after a game, even when you feel fine. A moderate session is right: upper body, core, technique work, or a lighter full-body lift. Heavy legs wait one more day.' },
  '3': { label: 'Three days after', allow: 'heavy', advice: 'Back to full training. Heavy legs are fine from here on.' }
};
const ADVICE_MAX = 600;

// ---------- Rules ----------
const savedRules = (ctx) => { try { return JSON.parse(ctx.db.get(`SELECT value FROM settings WHERE key = 'game_rules'`)?.value ?? '{}') ?? {}; } catch { return {}; } };
export function rules(ctx) {
  const saved = savedRules(ctx);
  return Object.fromEntries(Object.entries(DEFAULT_RULES).map(([k, r]) => [k, { ...r, ...(saved[k] ?? {}) }]));
}
export function rulesView(ctx) {
  return { rules: Object.entries(rules(ctx)).map(([key, r]) => ({ key, offset: Number(key), ...r })).sort((a, b) => a.offset - b.offset), loads: LOADS.slice(1), customized: !!ctx.db.get(`SELECT 1 FROM settings WHERE key = 'game_rules'`), defaults: DEFAULT_RULES };
}
// The owner changes a day's allowed load or its words (rules: { '-1': { allow, advice } }), or resets the lot.
export function saveRules(ctx, body = {}) {
  if (body.reset) { ctx.db.run(`DELETE FROM settings WHERE key = 'game_rules'`); return rulesView(ctx); }
  if (!body.rules || typeof body.rules !== 'object') throw badRequest('Send rules: { "-1": { allow, advice }, ... } or reset: true.');
  const next = savedRules(ctx);
  for (const [k, r] of Object.entries(body.rules)) {
    if (!DEFAULT_RULES[k]) throw badRequest(`${k} isn't a day of the game week (-3 to 3).`);
    if (!r || typeof r !== 'object') throw badRequest(`Day ${k}: send allow and/or advice.`);
    const cur = { ...(next[k] ?? {}) };
    if (r.allow !== undefined) cur.allow = v.oneOf(r.allow, 'allow', LOADS.slice(1));
    if (r.advice !== undefined) { const a = v.str(r.advice, 'advice', { max: ADVICE_MAX }).trim(); if (!a) throw badRequest(`Day ${k}: write the advice, or reset to the starting words.`); cur.advice = a; }
    next[k] = cur;
  }
  ctx.db.run(`INSERT INTO settings (key, value) VALUES ('game_rules', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(next));
  return rulesView(ctx);
}

// ---------- Games ----------
const clientOf = (ctx, id) => { const c = ctx.db.get('SELECT id, name, archived_at FROM clients WHERE id = ?', id); if (!c) throw notFound('Athlete'); return c; };
const shape = (g) => ({ id: g.id, date: g.date, time: g.time, title: g.title, kind: g.kind, kind_label: KINDS[g.kind], source: g.source, created_by: g.created_by, created_at: g.created_at });
export function listGames(ctx, clientId, { from = null, to = null } = {}) {
  clientOf(ctx, clientId);
  const day = today(ctx);
  const lo = from ?? addDaysToDate(day, -7), hi = to ?? addDaysToDate(day, LIST_DAYS);
  return ctx.db.all('SELECT * FROM games WHERE client_id = ? AND date >= ? AND date <= ? ORDER BY date, time', clientId, lo, hi).map(shape);
}
function gameFields(ctx, body = {}) {
  const date = v.str(body.date, 'date', { max: 10 });
  if (!isDate(date)) throw badRequest('Give the game\'s date as YYYY-MM-DD.');
  const day = today(ctx);
  if (date < addDaysToDate(day, -365) || date > addDaysToDate(day, 400)) throw badRequest('That date is more than a year away. Check it.');
  let time = v.str(body.time, 'time', { max: 5, optional: true }) || null;
  if (time) { const m = time.match(/^(\d{1,2}):(\d{2})$/); if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw badRequest('Give the time as HH:MM (24-hour), or leave it out.'); time = `${m[1].padStart(2, '0')}:${m[2]}`; }
  const title = v.str(body.title, 'title', { max: MAX_TITLE, optional: true }).replace(/\s+/g, ' ').trim() || null;
  const kind = body.kind === undefined || body.kind === null || body.kind === '' ? 'game' : v.oneOf(body.kind, 'kind', Object.keys(KINDS));
  return { date, time, title, kind };
}
const countOf = (ctx, clientId) => ctx.db.get('SELECT COUNT(*) AS n FROM games WHERE client_id = ?', clientId).n;
export function addGame(ctx, clientId, body = {}, who = {}) {
  const c = clientOf(ctx, clientId);
  if (c.archived_at) throw conflict(`${c.name} is archived.`);
  const f = gameFields(ctx, body);
  const dup = ctx.db.get('SELECT id FROM games WHERE client_id = ? AND date = ? AND lower(COALESCE(title, \'\')) = lower(?)', clientId, f.date, f.title ?? '');
  if (dup) throw conflict(`That game is already on ${f.date}.`);
  if (countOf(ctx, clientId) >= MAX_GAMES) throw badRequest(`Up to ${MAX_GAMES} games can be kept. Remove old ones first.`);
  const id = newId('gm');
  ctx.db.run('INSERT INTO games (id, client_id, date, time, title, kind, source, import_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)', id, clientId, f.date, f.time, f.title, f.kind, who.kind ?? 'athlete', who.name ?? null, ctx.now());
  return shape(ctx.db.get('SELECT * FROM games WHERE id = ?', id));
}
export function removeGame(ctx, clientId, id) {
  const g = ctx.db.get('SELECT * FROM games WHERE id = ? AND client_id = ?', id, clientId);
  if (!g) throw notFound('Game');
  ctx.db.run('DELETE FROM games WHERE id = ?', id);
  return { id, deleted: true, date: g.date, title: g.title };
}

// ---------- Bringing a schedule in ----------
// An .ics file (TeamSnap, SportsEngine, GameChanger, Google Calendar...), a CSV (date, time, opponent columns in any
// order), or pasted lines ("Oct 18 10:00 vs Westlake"). Nothing is saved: the preview lists every event with what it
// looks like (a game, a tournament day, a scrimmage, or a practice, which starts unticked), and import saves the ones
// chosen, skipping any already on file (by the event's id or the same date and title).
const MAX_TEXT = 2_000_000, MAX_EVENTS = 600;
function unfold(text) { return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, ''); }
function icsDate(raw, params, zone) {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { date, time: null };
  if (m[7] === 'Z') {   // UTC: the business's local day and time
    const iso = `${date}T${m[4]}:${m[5]}:${m[6] ?? '00'}Z`;
    const local = localDate(iso, zone);
    const t = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)).replace(/^24/, '00');
    return { date: local, time: t };
  }
  return { date, time: `${m[4]}:${m[5]}` };   // floating or TZID: the team's own local time, which is the athlete's
}
export function parseIcs(text, zone) {
  const out = [];
  const blocks = unfold(text).split(/^BEGIN:VEVENT$/m).slice(1);
  for (const b of blocks.slice(0, MAX_EVENTS)) {
    const body = b.split(/^END:VEVENT$/m)[0];
    const prop = (name) => { const m = body.match(new RegExp(`^${name}(;[^:\\n]*)?:(.*)$`, 'mi')); return m ? { params: m[1] ?? '', value: m[2].trim() } : null; };
    const start = prop('DTSTART');
    if (!start) continue;
    const when = icsDate(start.value, start.params, zone);
    if (!when) continue;
    const summary = (prop('SUMMARY')?.value ?? '').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, ' ').replace(/\\\\/g, '\\').trim();
    const uid = prop('UID')?.value ?? null;
    const location = (prop('LOCATION')?.value ?? '').replace(/\\,/g, ',').trim() || null;
    out.push({ date: when.date, time: when.time, title: summary, import_key: uid ? uid.slice(0, 200) : null, location });
  }
  return out;
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
// A date written any usual way: 2026-10-18, 10/18/2026, 10/18, Oct 18, October 18 2026, 18 Oct. A year left out is
// the next time that day comes round (from a month back).
export function readDate(s, day) {
  const t = String(s ?? '').trim();
  let y, m, d;
  let x;
  if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [x[1], x[2], x[3]];
  else if ((x = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) [m, d, y] = [x[1], x[2], x[3]];
  else if ((x = t.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?/i)) && MONTHS[x[1].slice(0, 4).toLowerCase()] !== undefined) [m, d, y] = [MONTHS[x[1].slice(0, 4).toLowerCase()] ?? MONTHS[x[1].slice(0, 3).toLowerCase()], x[2], x[3]];
  else if ((x = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?/i)) && MONTHS[x[2].slice(0, 3).toLowerCase()] !== undefined) [d, m, y] = [x[1], MONTHS[x[2].slice(0, 3).toLowerCase()], x[3]];
  else return null;
  m = Number(m); d = Number(d);
  if (y && String(y).length === 2) y = `20${y}`;
  const mk = (yy) => { const s2 = `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return isDate(s2) ? s2 : null; };
  if (y) return mk(y);
  const thisYear = Number(day.slice(0, 4));
  const a = mk(thisYear);
  if (a && a >= addDaysToDate(day, -31)) return a;
  return mk(thisYear + 1);
}
const readTime = (s) => { const m = String(s ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/i); if (!m) return null; let hh = Number(m[1]); const mm = m[2] ?? '00'; const ap = m[3]?.toLowerCase(); if (ap?.startsWith('p') && hh < 12) hh += 12; if (ap?.startsWith('a') && hh === 12) hh = 0; return hh > 23 || Number(mm) > 59 ? null : `${String(hh).padStart(2, '0')}:${mm}`; };
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur);
  return out.map((s) => s.trim());
}
export function parseCsv(text, day) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (...names) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const di = col('date', 'day'), ti = col('time', 'start'), oi = col('opponent', 'vs', 'title', 'event', 'summary', 'game', 'description'), ki = col('type', 'kind');
  const hasHeader = di >= 0;
  const rows = hasHeader ? lines.slice(1) : lines;
  const out = [];
  for (const line of rows.slice(0, MAX_EVENTS)) {
    const cells = splitCsvLine(line);
    let date, time = null, title = '', kindText = '';
    if (hasHeader) {
      date = readDate(cells[di], day); time = ti >= 0 ? readTime(cells[ti]) : null; title = oi >= 0 ? cells[oi] ?? '' : ''; kindText = ki >= 0 ? cells[ki] ?? '' : '';
      if (title && oi >= 0 && /opponent|vs/.test(head[oi]) && !/^(vs|@|at)\b/i.test(title) && guessKind(title, kindText) === 'game') title = `vs ${title}`;
    } else {
      // Pasted lines: a date, maybe a time, then the rest ("Oct 18 10:00 vs Westlake", "2026-10-18, 4pm, @ Hill Country").
      const m = line.match(/^((?:\d{4}-\d{1,2}-\d{1,2})|(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)|(?:[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?(?:\s+\d{4})?)|(?:\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\.?(?:,?\s+\d{4})?))[\s,:–-]*(.*)$/i);
      if (!m) continue;
      date = readDate(m[1], day);
      let rest = m[2].trim();
      const tm = rest.match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)(?![\w:])[\s,–-]*(.*)$/i);
      if (tm && readTime(tm[1])) { time = readTime(tm[1]); rest = tm[2]; }
      title = rest.replace(/^[,–-]\s*/, '').trim();
    }
    if (!date) continue;
    out.push({ date, time, title: title.replace(/^"|"$/g, '').trim(), import_key: null, kind_text: kindText });
  }
  return out;
}
const guessKind = (title, kindText = '') => {
  const t = `${kindText} ${title}`.toLowerCase();
  if (/practice|training|workout|lift|session|meeting|team dinner|pictures|banquet|fundrais/.test(t)) return 'practice';
  if (/tournament|tourney|showcase|bracket|pool play|invitational/.test(t)) return 'tournament';
  if (/scrimmage|friendly|exhibition|preseason game/.test(t)) return 'scrimmage';
  return 'game';
};
export function previewSchedule(ctx, clientId, body = {}) {
  clientOf(ctx, clientId);
  const day = today(ctx);
  const zone = getSetting(ctx, 'business_tz') || 'America/Denver';
  const text = String(body.text ?? body.ics ?? body.csv ?? '');
  if (!text.trim()) throw badRequest('Choose the calendar file (.ics or .csv) or paste the dates.');
  if (text.length > MAX_TEXT) throw badRequest('That file is too big. Export just this season.');
  const looksIcs = /BEGIN:VCALENDAR|BEGIN:VEVENT/i.test(text);
  const events = looksIcs ? parseIcs(text, zone) : parseCsv(text, day);
  if (!events.length) throw badRequest(looksIcs ? 'No events were found in that calendar file.' : 'No dates were found. Write one game per line, like "Oct 18 10:00 vs Westlake", or choose the team\'s .ics file.');
  const have = ctx.db.all('SELECT date, title, import_key FROM games WHERE client_id = ?', clientId);
  const keys = new Set(have.map((g) => g.import_key).filter(Boolean)), dayTitles = new Set(have.map((g) => `${g.date}|${(g.title ?? '').toLowerCase()}`));
  const seen = new Set();
  const items = events.map((e) => {
    const title = String(e.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || null;
    const kind = guessKind(title ?? '', e.kind_text);
    const past = e.date < addDaysToDate(day, -7);
    const far = e.date > addDaysToDate(day, 400);
    const dupKey = `${e.date}|${(title ?? '').toLowerCase()}`;
    const exists = (e.import_key && keys.has(e.import_key)) || dayTitles.has(dupKey);
    const twice = seen.has(dupKey); seen.add(dupKey);
    const skip = exists ? 'Already on file' : twice ? 'Listed twice in the file' : past ? 'Already happened' : far ? 'More than a year away' : null;
    return { date: e.date, time: e.time ?? null, title, kind: kind === 'practice' ? 'game' : kind, practice: kind === 'practice', import_key: e.import_key ?? null, location: e.location ?? null, skip, checked: !skip && kind !== 'practice' };
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { format: looksIcs ? 'ics' : 'csv', items, counts: { found: items.length, games: items.filter((i) => i.checked).length, practices: items.filter((i) => i.practice).length, skipped: items.filter((i) => i.skip).length } };
}
// Save the chosen items (all or nothing, every problem listed). Games already on file are skipped and counted.
export function importSchedule(ctx, clientId, body = {}, who = {}) {
  const c = clientOf(ctx, clientId);
  if (c.archived_at) throw conflict(`${c.name} is archived.`);
  const list = Array.isArray(body.items) ? body.items : [];
  if (!list.length) throw badRequest('Tick at least one game to add.');
  if (list.length > MAX_EVENTS) throw badRequest(`Add up to ${MAX_EVENTS} games at a time.`);
  const problems = [];
  const rows = list.map((x, i) => { try { return { ...gameFields(ctx, x ?? {}), import_key: x?.import_key ? String(x.import_key).slice(0, 200) : null }; } catch (e) { problems.push(`Line ${i + 1}: ${e.message}`); return null; } });
  if (problems.length) { const e = badRequest(`Nothing was added: ${problems.length} ${problems.length === 1 ? 'thing' : 'things'} to fix first.`); e.details = { problems: problems.slice(0, 50) }; throw e; }
  const have = ctx.db.all('SELECT date, title, import_key FROM games WHERE client_id = ?', clientId);
  const keys = new Set(have.map((g) => g.import_key).filter(Boolean)), dayTitles = new Set(have.map((g) => `${g.date}|${(g.title ?? '').toLowerCase()}`));
  let added = 0, skipped = 0;
  const room = MAX_GAMES - countOf(ctx, clientId);
  ctx.db.tx(() => {
    for (const r of rows) {
      const k = `${r.date}|${(r.title ?? '').toLowerCase()}`;
      if ((r.import_key && keys.has(r.import_key)) || dayTitles.has(k)) { skipped++; continue; }
      if (added >= room) throw badRequest(`Up to ${MAX_GAMES} games can be kept. Remove old ones first.`);
      ctx.db.run('INSERT INTO games (id, client_id, date, time, title, kind, source, import_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId('gm'), clientId, r.date, r.time, r.title, r.kind, who.source ?? 'import', r.import_key, who.name ?? null, ctx.now());
      if (r.import_key) keys.add(r.import_key);
      dayTitles.add(k);
      added++;
    }
  });
  return { added, skipped, games: listGames(ctx, clientId) };
}

// ---------- Where a day sits against the games ----------
// For a date: the days to the next game (before), the days since the last (after), the rule that applies (the stricter
// of the two when a day is both, like the Thursday between a Tuesday and a Saturday game), and the advice.
export function dayInfo(date, gameDates, rulesByKey) {
  const dates = [...new Set(gameDates)].sort();
  const next = dates.find((g) => g >= date) ?? null, last = [...dates].reverse().find((g) => g <= date) ?? null;
  const daysApart = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
  const before = next ? daysApart(date, next) : null, after = last ? daysApart(last, date) : null;
  if (before === 0) return { offset: 0, key: '0', before: 0, after: 0, next_game: next, last_game: last, ...pick('0') };
  const keys = [];
  if (before !== null && before <= 3) keys.push(String(-before));
  if (after !== null && after <= 3) keys.push(String(after));
  if (!keys.length) return { offset: null, key: null, before, after, next_game: next, last_game: last, allow: 'heavy', label: 'Clear', advice: null };
  const strictest = keys.map((k) => ({ k, r: rulesByKey[k] })).sort((a, b) => LOADS.indexOf(a.r.allow) - LOADS.indexOf(b.r.allow) || Math.abs(Number(a.k)) - Math.abs(Number(b.k)))[0];
  const other = keys.find((k) => k !== strictest.k) ?? null;
  const extra = other ? (Number(other) < 0 ? ` You also play again in ${-Number(other)} ${-Number(other) === 1 ? 'day' : 'days'}.` : ` You also played ${Number(other)} ${Number(other) === 1 ? 'day' : 'days'} ago.`) : '';
  return { offset: Number(strictest.k), key: strictest.k, before, after, next_game: next, last_game: last, ...pick(strictest.k), advice: strictest.r.advice + extra };
  function pick(k) { return { allow: rulesByKey[k].allow, label: rulesByKey[k].label, advice: rulesByKey[k].advice }; }
}

// ---------- How heavy a workout is ----------
// Read from its exercises: a lower-body or power lift at 80% of a max or more, a target RPE of 8 or more, or a
// heavy-sounding load is heavy; a leg lift at 65 to 79%, a lift at RPE 6 to 7.5, or a lot of sets is moderate; the
// rest (mobility, arm care, activation, a short conditioning piece) is light. The title helps ("Recovery", "Max day").
const LOWER = /^(lower body|power|speed)$/i;
const LOWER_MOVES = new Set(['squat', 'hinge', 'lunge', 'jump', 'sprint', 'throw']);
export function loadOf(workout, movementOf = () => null) {
  const title = String(workout.title ?? '').toLowerCase();
  if (/recovery|mobility|activation|primer|prehab|stretch|flush|regen/.test(title)) return { load: 'light', legs: false, why: 'a recovery day by its name' };
  let score = 0, legs = false, why = null;
  const exs = workout.exercises ?? [];
  let sets = 0;
  for (const x of exs) {
    const lower = LOWER.test(x.category ?? '') || LOWER_MOVES.has(movementOf(x.exercise_id) ?? x.movement ?? '');
    const pct = x.load_pct ?? null, rpe = x.target_rpe ?? null;
    const heavyText = /heavy|max|1rm|3rm|5rm|amrap|failure/i.test(`${x.load_text ?? ''} ${x.reps ?? ''}`);
    const reps = repCount(x.reps);
    let s = 0;
    if ((pct !== null && pct >= 80) || (rpe !== null && rpe >= 8) || heavyText) s = 3;
    else if ((pct !== null && pct >= 65) || (rpe !== null && rpe >= 6) || (lower && reps !== null && reps <= 6 && (x.sets ?? 1) >= 3)) s = 2;
    else if (pct !== null || rpe !== null || (x.sets ?? 0) >= 3) s = 1;
    sets += x.sets ?? 1;
    if (lower && s >= 2) { legs = true; if (s === 3 && !why) why = `${x.name} at ${pct !== null ? `${pct}% of max` : rpe !== null ? `RPE ${rpe}` : 'a heavy load'}`; }
    score = Math.max(score, lower ? s : Math.min(s, 2));
    if (!why && s === 3) why = `${x.name} ${pct !== null ? `at ${pct}% of max` : rpe !== null ? `at RPE ${rpe}` : 'to a heavy load'}`;
  }
  if (/heavy|max|test|1rm/.test(title)) { score = 3; legs = legs || /squat|clean|deadlift|leg|lower/.test(title); why ??= 'a heavy day by its name'; }
  if (score < 3 && sets >= 18) { score = Math.max(score, 2); why ??= `${sets} sets`; }
  if (score === 2 && !why) why = legs ? 'a leg session at a working load' : 'a working session';
  return { load: score >= 3 ? 'heavy' : score === 2 ? 'moderate' : 'light', legs, why: why ?? (score === 0 ? 'nothing heavy in it' : 'a light session') };
}

// ---------- The plan: every day of the next three weeks, and what to change ----------
export function planFor(ctx, clientId, { days = HORIZON_DAYS } = {}) {
  const c = clientOf(ctx, clientId);
  const day = today(ctx);
  const r = rules(ctx);
  const games = listGames(ctx, clientId, { from: addDaysToDate(day, -4), to: addDaysToDate(day, LIST_DAYS) });
  const gameDates = games.map((g) => g.date);
  const cal = clientCalendar(ctx, clientId);
  const movement = new Map(ctx.db.all('SELECT id, movement FROM exercises WHERE movement IS NOT NULL').map((e) => [e.id, e.movement]));
  const program = cal.program ? ctx.db.all(`SELECT we.workout_id, we.sets, we.reps, we.load_pct, we.target_rpe, we.load_text, e.name, e.category, e.id AS exercise_id
    FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id JOIN workouts w ON w.id = we.workout_id WHERE w.program_id = ? ORDER BY we.position`, cal.program.id) : [];
  const byWorkout = new Map();
  for (const x of program) byWorkout.set(x.workout_id, [...(byWorkout.get(x.workout_id) ?? []), x]);
  const loads = new Map(cal.workouts.map((w) => [w.id, loadOf({ title: w.title, exercises: byWorkout.get(w.id) ?? [] }, (id) => movement.get(id) ?? null)]));
  const onDate = new Map();
  for (const w of cal.workouts) if (w.status !== 'skipped' && w.status !== 'unpublished') onDate.set(w.date, [...(onDate.get(w.date) ?? []), w]);
  const horizon = Array.from({ length: days + 1 }, (_, i) => addDaysToDate(day, i));
  const info = (d) => dayInfo(d, gameDates, r);
  const daysOut = horizon.map((d) => {
    const i = info(d);
    const ws = (onDate.get(d) ?? []).map((w) => ({ id: w.id, title: w.title, status: w.status, ...loads.get(w.id), fits: LOADS.indexOf(loads.get(w.id).load) <= LOADS.indexOf(i.allow) }));
    return { date: d, games: games.filter((g) => g.date === d), ...i, workouts: ws, conflict: ws.some((w) => !w.fits && w.status !== 'done') };
  });
  // Suggestions: a workout heavier than its day allows moves to the nearest day that fits (earlier before a game,
  // later after one) with nothing else planned and no game; with no such day within three, keep it but lighten it.
  const suggestions = [];
  for (const d of daysOut) {
    for (const w of d.workouts) {
      if (w.fits || w.status === 'done') continue;
      const order = d.before !== null && d.before <= 3 && (d.after === null || d.after > 3 || d.before <= d.after) ? [-1, -2, -3, 1, 2, 3] : [1, 2, 3, -1, -2, -3];
      let to = null;
      for (const o of order) {
        const cand = addDaysToDate(d.date, o);
        if (cand < day) continue;
        const ci = info(cand);
        if (ci.offset === 0 || LOADS.indexOf(w.load) > LOADS.indexOf(ci.allow)) continue;
        if ((onDate.get(cand) ?? []).length) continue;
        to = cand; break;
      }
      const what = w.legs ? 'heavy legs' : `a ${w.load} session`;
      const where = d.offset === 0 ? 'on game day' : d.offset < 0 ? `${-d.offset} ${-d.offset === 1 ? 'day' : 'days'} before your game` : `${d.offset} ${d.offset === 1 ? 'day' : 'days'} after your game`;
      suggestions.push({ workout_id: w.id, title: w.title, date: d.date, load: w.load, legs: w.legs, why: w.why, day_label: d.label, allow: d.allow,
        kind: to ? 'move' : 'lighten', to_date: to,
        text: to ? `${w.title} is ${what} (${w.why}) and it lands ${where}. Move it to ${to}: that day allows it and nothing else is planned.`
          : `${w.title} is ${what} (${w.why}) and it lands ${where}, with no free day nearby to move it to. Do it, but keep it ${d.allow === 'light' ? 'light: the warm-up, the fast moves, and skip the heavy sets' : 'moderate: the working sets at 60 to 70%, nothing to failure'}.` });
    }
  }
  const todayInfo = daysOut[0];
  const nextGame = games.find((g) => g.date >= day) ?? null;
  return { client_id: c.id, today: day, games, next_game: nextGame, upcoming_games: games.filter((g) => g.date >= day).slice(0, 10),
    now: { offset: todayInfo.offset, label: todayInfo.label, allow: todayInfo.allow, advice: todayInfo.advice, before: todayInfo.before, after: todayInfo.after },
    days: daysOut, suggestions, has_program: !!cal.program };
}
// The short form on the app's home screen.
export function homeSummary(ctx, clientId) {
  const p = planFor(ctx, clientId);
  const daysTo = p.next_game ? Math.round((Date.parse(`${p.next_game.date}T12:00:00Z`) - Date.parse(`${p.today}T12:00:00Z`)) / 86400000) : null;
  return { next_game: p.next_game, days_to_next: daysTo, now: p.now, suggestions: p.suggestions.slice(0, 3), games_on_file: p.games.length,
    game_dates: [...new Set(p.games.map((g) => g.date))],
    by_date: Object.fromEntries(p.days.map((d) => [d.date, { offset: d.offset, allow: d.allow, label: d.label, advice: d.advice, game: d.games[0] ?? null, conflict: d.conflict }])) };
}
// The athlete (or a parent) takes a suggestion: the workout moves to the date the plan suggested, nothing else.
export function takeSuggestion(ctx, clientId, body = {}, actor = null) {
  const p = planFor(ctx, clientId);
  const s = p.suggestions.find((x) => x.workout_id === String(body.workout_id ?? '') && x.kind === 'move' && x.to_date === String(body.date ?? ''));
  if (!s) throw badRequest('That suggestion isn\'t on your plan any more. Open the calendar and look again.');
  moveWorkout(ctx, clientId, { workout_id: s.workout_id, date: s.to_date }, actor);
  return { moved: { workout_id: s.workout_id, title: s.title, from: s.date, to: s.to_date }, plan: homeSummary(ctx, clientId) };
}
// Today's heads-up for the coach (every athlete with a conflict in the next week), and the family export.
export function conflictsFor(ctx, clientIds) {
  return clientIds.map((id) => { try { return { client_id: id, suggestions: planFor(ctx, id, { days: 7 }).suggestions }; } catch { return { client_id: id, suggestions: [] }; } }).filter((x) => x.suggestions.length);
}
export const gamesOf = (ctx, clientId) => ctx.db.all('SELECT date, time, title, kind, source, created_by, created_at FROM games WHERE client_id = ? ORDER BY date', clientId);
