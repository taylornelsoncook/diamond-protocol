// The game-week helper (owner's asks: "an athlete calendar helper ... day of game, day before, 2 days before, day
// after and 3 days after ... the athlete uploads their games"; "it doesn't take into account their actual schedule:
// I want them to input the games, races, and competitions and make it fluid enough that if it changes they can input
// the new date and their suggested schedule resets"; "we already have a calendar on their account: if it is yellow cut
// sets down by 1, if it is red cut sets in half, and keep the workout the same").
// Athletes (parents through the family account, coaches on the client page) keep their games, races, meets and
// competitions: typed one at a time, or brought in from the team's calendar (.ics from TeamSnap, SportsEngine,
// GameChanger and the like, a CSV, or pasted lines). Every day of the athlete's training calendar then takes a colour
// from where it sits against them: green (full workout), yellow (one set fewer on every exercise) or red (half the
// sets). The workout itself never changes, only the sets, worked out on read (programs.appExercise), so changing a
// game's date moves the colours and the sets at once. The rules and the words are the research brief's starting
// values (docs/game-week.md), and the owner can change them (settings key game_rules).
import { newId, v, badRequest, notFound, conflict, addDaysToDate, isDate, localDate } from '../util.js';
import { getSetting } from './families.js';
import { clientCalendar, today } from './training-calendar.js';

export const KINDS = { game: 'Game', tournament: 'Tournament day', scrimmage: 'Scrimmage', race: 'Race', meet: 'Meet', competition: 'Competition' };
// The one word for an event of each kind ("Race tomorrow").
export const KIND_WORDS = { game: 'game', tournament: 'tournament', scrimmage: 'scrimmage', race: 'race', meet: 'meet', competition: 'competition' };
export const LOADS = ['light', 'moderate', 'heavy'];   // in order: what a day allows
// What each colour does to the workout (the owner's rule): green = as written, yellow = one set fewer on every
// exercise, red = half the sets (rounded up, never below one). The exercises, reps and weights stay the same.
export const TONES = { heavy: 'green', moderate: 'yellow', light: 'red' };
export const CUTS = { heavy: null, moderate: 'minus_one', light: 'half' };
export const CUT_TEXT = { minus_one: 'one set fewer on every exercise', half: 'half the sets on every exercise' };
export const TONE_TEXT = { green: 'Green: the full workout', yellow: 'Yellow: one set fewer on every exercise', red: 'Red: half the sets on every exercise' };
export const MAX_GAMES = 400, MAX_TITLE = 80, HORIZON_DAYS = 21, LIST_DAYS = 120;
export const NEAR_DAYS = 3;   // a day within this many days of a game takes a colour from the rules; further is green

// The rules by day, keyed by the days to the game (negative) or since it (positive). allow is the colour (heavy =
// green, moderate = yellow, light = red); advice is what the athlete reads. Starting values from docs/game-week.md.
export const DEFAULT_RULES = {
  '-3': { label: 'Three days out', allow: 'heavy', advice: 'Green day: the full workout. This is the day for your hardest work of the week. Heavy legs, jumps and sprints all fit: by game day you\'ll have recovered and feel sharper for it.' },
  '-2': { label: 'Two days out', allow: 'moderate', advice: 'Yellow day: one set fewer on every exercise. Soreness from heavy or new work peaks a day or two later, right on game day, so nothing new today and nothing to failure.' },
  '-1': { label: 'Day before', allow: 'light', advice: 'Red day: half the sets. Short and sharp, then stop while you feel fresh. No long conditioning, no new exercises. Sleep 9 hours or more; this night matters more than tomorrow\'s.' },
  '0': { label: 'Game day', allow: 'light', advice: 'Red day: half the sets, and only if your coach set up a short activation (fast and light, six hours or more before you play). Eat a meal you know 3 to 4 hours before, drink through the day, and do a full warm-up.' },
  '1': { label: 'Day after', allow: 'light', advice: 'Red day: half the sets. Your jump and sprint ability is still down and soreness is near its peak. Move for 20 to 30 minutes (an easy bike, a walk, a swim, mobility), stretch, eat and drink well, and sleep.' },
  '2': { label: 'Two days after', allow: 'moderate', advice: 'Yellow day: one set fewer on every exercise. Your legs produce less force for 48 to 72 hours after a game, even when they feel fine. Nothing to failure.' },
  '3': { label: 'Three days after', allow: 'heavy', advice: 'Green day: the full workout. Back to full training; heavy legs are fine from here on.' }
};
const ADVICE_MAX = 600;

// ---------- Rules ----------
const savedRules = (ctx) => { try { return JSON.parse(ctx.db.get(`SELECT value FROM settings WHERE key = 'game_rules'`)?.value ?? '{}') ?? {}; } catch { return {}; } };
export function rules(ctx) {
  const saved = savedRules(ctx);
  return Object.fromEntries(Object.entries(DEFAULT_RULES).map(([k, r]) => [k, { ...r, ...(saved[k] ?? {}) }]));
}
export function rulesView(ctx) {
  return { rules: Object.entries(rules(ctx)).map(([key, r]) => ({ key, offset: Number(key), ...r, tone: TONES[r.allow], cut: CUTS[r.allow] })).sort((a, b) => a.offset - b.offset),
    loads: LOADS.map((l) => ({ key: l, tone: TONES[l], label: TONE_TEXT[TONES[l]] })), customized: !!ctx.db.get(`SELECT 1 FROM settings WHERE key = 'game_rules'`), defaults: DEFAULT_RULES };
}
// The owner changes a day's colour or its words (rules: { '-1': { allow, advice } }), or resets the lot.
export function saveRules(ctx, body = {}) {
  if (body.reset) { ctx.db.run(`DELETE FROM settings WHERE key = 'game_rules'`); return rulesView(ctx); }
  if (!body.rules || typeof body.rules !== 'object') throw badRequest('Send rules: { "-1": { allow, advice }, ... } or reset: true.');
  const next = savedRules(ctx);
  for (const [k, r] of Object.entries(body.rules)) {
    if (!DEFAULT_RULES[k]) throw badRequest(`${k} isn't a day of the game week (-3 to 3).`);
    if (!r || typeof r !== 'object') throw badRequest(`Day ${k}: send allow and/or advice.`);
    const cur = { ...(next[k] ?? {}) };
    if (r.allow !== undefined) cur.allow = v.oneOf(r.allow, 'allow', LOADS);
    if (r.advice !== undefined) { const a = v.str(r.advice, 'advice', { max: ADVICE_MAX }).trim(); if (!a) throw badRequest(`Day ${k}: write the advice, or reset to the starting words.`); cur.advice = a; }
    next[k] = cur;
  }
  ctx.db.run(`INSERT INTO settings (key, value) VALUES ('game_rules', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(next));
  return rulesView(ctx);
}

// ---------- Games ----------
const clientOf = (ctx, id) => { const c = ctx.db.get('SELECT id, name, archived_at FROM clients WHERE id = ?', id); if (!c) throw notFound('Athlete'); return c; };
const shape = (g) => ({ id: g.id, date: g.date, time: g.time, title: g.title, kind: g.kind, kind_label: KINDS[g.kind], kind_word: KIND_WORDS[g.kind], source: g.source, created_by: g.created_by, created_at: g.created_at });
export function listGames(ctx, clientId, { from = null, to = null } = {}) {
  clientOf(ctx, clientId);
  const day = today(ctx);
  const lo = from ?? addDaysToDate(day, -7), hi = to ?? addDaysToDate(day, LIST_DAYS);
  return ctx.db.all('SELECT * FROM games WHERE client_id = ? AND date >= ? AND date <= ? ORDER BY date, time', clientId, lo, hi).map(shape);
}
function gameFields(ctx, body = {}, current = null) {
  const has = (k) => body[k] !== undefined;
  const date = current && !has('date') ? current.date : v.str(body.date, 'date', { max: 10 });
  if (!isDate(date)) throw badRequest('Give the date as YYYY-MM-DD.');
  const day = today(ctx);
  if (date < addDaysToDate(day, -365) || date > addDaysToDate(day, 400)) throw badRequest('That date is more than a year away. Check it.');
  let time = current && !has('time') ? current.time : v.str(body.time, 'time', { max: 5, optional: true }) || null;
  if (time) { const m = String(time).match(/^(\d{1,2}):(\d{2})$/); if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw badRequest('Give the time as HH:MM (24-hour), or leave it out.'); time = `${m[1].padStart(2, '0')}:${m[2]}`; }
  const title = current && !has('title') ? current.title : (v.str(body.title, 'title', { max: MAX_TITLE, optional: true }) ?? '').replace(/\s+/g, ' ').trim() || null;
  const kind = current && !has('kind') ? current.kind : body.kind === undefined || body.kind === null || body.kind === '' ? 'game' : v.oneOf(body.kind, 'kind', Object.keys(KINDS));
  return { date, time, title, kind };
}
const countOf = (ctx, clientId) => ctx.db.get('SELECT COUNT(*) AS n FROM games WHERE client_id = ?', clientId).n;
const sameDay = (ctx, clientId, f, notId = null) => ctx.db.get('SELECT id FROM games WHERE client_id = ? AND date = ? AND lower(COALESCE(title, \'\')) = lower(?) AND id != ?', clientId, f.date, f.title ?? '', notId ?? '');
export function addGame(ctx, clientId, body = {}, who = {}) {
  const c = clientOf(ctx, clientId);
  if (c.archived_at) throw conflict(`${c.name} is archived.`);
  const f = gameFields(ctx, body);
  if (sameDay(ctx, clientId, f)) throw conflict(`That ${KIND_WORDS[f.kind]} is already on ${f.date}.`);
  if (countOf(ctx, clientId) >= MAX_GAMES) throw badRequest(`Up to ${MAX_GAMES} games can be kept. Remove old ones first.`);
  const id = newId('gm');
  ctx.db.run('INSERT INTO games (id, client_id, date, time, title, kind, source, import_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)', id, clientId, f.date, f.time, f.title, f.kind, who.kind ?? 'athlete', who.name ?? null, ctx.now());
  return shape(ctx.db.get('SELECT * FROM games WHERE id = ?', id));
}
// A game that moved (the owner's ask: "if it changes they can input the new date and their suggested schedule
// resets"): the new date, time, title or kind, any of them. Nothing else is stored, so every colour and every set
// count follows from the next read.
export function updateGame(ctx, clientId, id, body = {}) {
  const c = clientOf(ctx, clientId);
  if (c.archived_at) throw conflict(`${c.name} is archived.`);
  const g = ctx.db.get('SELECT * FROM games WHERE id = ? AND client_id = ?', id, clientId);
  if (!g) throw notFound('Game');
  if (!['date', 'time', 'title', 'kind'].some((k) => body[k] !== undefined)) throw badRequest('Send the new date, time, title or kind.');
  const f = gameFields(ctx, body, g);
  if (sameDay(ctx, clientId, f, g.id)) throw conflict(`That ${KIND_WORDS[f.kind]} is already on ${f.date}.`);
  ctx.db.run('UPDATE games SET date = ?, time = ?, title = ?, kind = ? WHERE id = ?', f.date, f.time, f.title, f.kind, g.id);
  return { ...shape(ctx.db.get('SELECT * FROM games WHERE id = ?', g.id)), was: { date: g.date, time: g.time, title: g.title, kind: g.kind } };
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
  if (/\brace\b|\b5k\b|\b10k\b|marathon|cross country|\bxc\b|time trial|triathlon|\bcrit\b|\brun\b/.test(t)) return 'race';
  if (/\bmeet\b|relays|championship|sectional|regional|\bstate\b|district/.test(t)) return 'meet';
  if (/competition|\bcomp\b|qualifier|\bopen\b|\bfinals?\b|grand prix/.test(t)) return 'competition';
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
// of the two when a day is both, like the Thursday between a Tuesday and a Saturday game), its colour and what it
// does to the sets, and the advice. A day further than three from any game is green with no advice.
export function dayInfo(date, gameDates, rulesByKey) {
  const dates = [...new Set(gameDates)].sort();
  const next = dates.find((g) => g >= date) ?? null, last = [...dates].reverse().find((g) => g <= date) ?? null;
  const daysApart = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
  const before = next ? daysApart(date, next) : null, after = last ? daysApart(last, date) : null;
  const withTone = (r) => ({ ...r, tone: TONES[r.allow], cut: CUTS[r.allow], cut_text: CUT_TEXT[CUTS[r.allow]] ?? null });
  if (before === 0) return withTone({ offset: 0, key: '0', before: 0, after: 0, next_game: next, last_game: last, ...pick('0') });
  const keys = [];
  if (before !== null && before <= NEAR_DAYS) keys.push(String(-before));
  if (after !== null && after <= NEAR_DAYS) keys.push(String(after));
  if (!keys.length) return withTone({ offset: null, key: null, before, after, next_game: next, last_game: last, allow: 'heavy', label: 'Clear', advice: null });
  const strictest = keys.map((k) => ({ k, r: rulesByKey[k] })).sort((a, b) => LOADS.indexOf(a.r.allow) - LOADS.indexOf(b.r.allow) || Math.abs(Number(a.k)) - Math.abs(Number(b.k)))[0];
  const other = keys.find((k) => k !== strictest.k) ?? null;
  const extra = other ? (Number(other) < 0 ? ` You also play again in ${-Number(other)} ${-Number(other) === 1 ? 'day' : 'days'}.` : ` You also played ${Number(other)} ${Number(other) === 1 ? 'day' : 'days'} ago.`) : '';
  return withTone({ offset: Number(strictest.k), key: strictest.k, before, after, next_game: next, last_game: last, ...pick(strictest.k), advice: strictest.r.advice + extra });
  function pick(k) { return { allow: rulesByKey[k].allow, label: rulesByKey[k].label, advice: rulesByKey[k].advice }; }
}
// The cut that applies to a workout the athlete does on a date (programs.appExercise reads it): null when the day is
// green or the athlete has no games near it. One query; nothing stored.
export function cutFor(ctx, clientId, date) {
  const games = ctx.db.all('SELECT date, time, title, kind FROM games WHERE client_id = ? AND date >= ? AND date <= ?', clientId, addDaysToDate(date, -NEAR_DAYS), addDaysToDate(date, NEAR_DAYS));
  if (!games.length) return null;
  const i = dayInfo(date, games.map((g) => g.date), rules(ctx));
  const g = games.find((x) => x.date === (i.offset !== null && i.offset <= 0 ? i.next_game : i.last_game)) ?? games[0];
  return { tone: i.tone, cut: i.cut, cut_text: i.cut_text, label: i.label, offset: i.offset, advice: i.advice, game: { date: g.date, time: g.time, title: g.title, kind: g.kind, kind_word: KIND_WORDS[g.kind] } };
}
// The sets an exercise gets on a day of that colour (full = the planned count, with the athlete's steps): yellow one
// fewer, red half (rounded up), never below one.
export function cutSets(full, cut) {
  if (cut === 'half') return Math.max(1, Math.ceil(full / 2));
  if (cut === 'minus_one') return Math.max(1, full - 1);
  return full;
}

// ---------- The plan: every day of the next three weeks in its colour ----------
export function planFor(ctx, clientId, { days = HORIZON_DAYS } = {}) {
  const c = clientOf(ctx, clientId);
  const day = today(ctx);
  const r = rules(ctx);
  const games = listGames(ctx, clientId, { from: addDaysToDate(day, -4), to: addDaysToDate(day, LIST_DAYS) });
  const gameDates = games.map((g) => g.date);
  const cal = clientCalendar(ctx, clientId);
  const setsOf = new Map(cal.program ? ctx.db.all('SELECT we.workout_id, SUM(COALESCE(we.sets, 1)) AS sets FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id WHERE w.program_id = ? GROUP BY we.workout_id', cal.program.id).map((x) => [x.workout_id, x.sets]) : []);
  const onDate = new Map();
  for (const w of cal.workouts) if (w.status !== 'skipped' && w.status !== 'unpublished') onDate.set(w.date, [...(onDate.get(w.date) ?? []), w]);
  const horizon = Array.from({ length: days + 1 }, (_, i) => addDaysToDate(day, i));
  const daysOut = horizon.map((d) => {
    const i = dayInfo(d, gameDates, r);
    const ws = (onDate.get(d) ?? []).map((w) => { const sets = setsOf.get(w.id) ?? 0; return { id: w.id, title: w.title, status: w.status, sets, sets_today: cutSets(sets, i.cut) }; });
    return { date: d, games: games.filter((g) => g.date === d), ...i, workouts: ws };
  });
  const todayInfo = daysOut[0];
  const nextGame = games.find((g) => g.date >= day) ?? null;
  return { client_id: c.id, today: day, games, next_game: nextGame, upcoming_games: games.filter((g) => g.date >= day).slice(0, 10),
    now: { offset: todayInfo.offset, label: todayInfo.label, allow: todayInfo.allow, tone: todayInfo.tone, cut: todayInfo.cut, cut_text: todayInfo.cut_text, advice: todayInfo.advice, before: todayInfo.before, after: todayInfo.after },
    days: daysOut, has_program: !!cal.program, colors: TONE_TEXT };
}
// The short form on the app's home screen: the next game, today's colour, and every coloured day of the next four
// months (by_date; a day left out is green) for the calendar strip.
export function homeSummary(ctx, clientId) {
  const day = today(ctx);
  const r = rules(ctx);
  const games = listGames(ctx, clientId, { from: addDaysToDate(day, -NEAR_DAYS - 7), to: addDaysToDate(day, LIST_DAYS) });
  const gameDates = [...new Set(games.map((g) => g.date))];
  const next = games.find((g) => g.date >= day) ?? null;
  const daysTo = next ? Math.round((Date.parse(`${next.date}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000) : null;
  const now = dayInfo(day, gameDates, r);
  const byDate = {};
  for (const g of gameDates) for (let o = -NEAR_DAYS; o <= NEAR_DAYS; o++) {
    const d = addDaysToDate(g, o);
    if (d < addDaysToDate(day, -7) || byDate[d]) continue;
    const i = dayInfo(d, gameDates, r);
    byDate[d] = { offset: i.offset, allow: i.allow, tone: i.tone, cut: i.cut, cut_text: i.cut_text, label: i.label, advice: i.advice, game: games.find((x) => x.date === d) ?? null };
  }
  return { next_game: next, days_to_next: daysTo, now: { offset: now.offset, label: now.label, allow: now.allow, tone: now.tone, cut: now.cut, cut_text: now.cut_text, advice: now.advice },
    games_on_file: games.length, game_dates: gameDates, by_date: byDate, colors: TONE_TEXT };
}
export const gamesOf = (ctx, clientId) => ctx.db.all('SELECT date, time, title, kind, source, created_by, created_at FROM games WHERE client_id = ? ORDER BY date', clientId);
