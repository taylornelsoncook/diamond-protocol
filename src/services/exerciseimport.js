// The exercise library from a list: a CSV (the video upload tool writes one) with each exercise's name and, optionally,
// its category, video link, still picture and coaching cues. Like every import, the whole file is checked first and
// every problem listed by row and column; nothing is saved until it's clean, and the save is one transaction.
// Names already in the library are never duplicated: the owner chooses to leave them, add the video where they have
// none, or replace their video.
import { newId, badRequest } from '../util.js';
import { parseCsv } from './perf-import.js';
import { CATEGORIES, MOVEMENTS, MUSCLES, EQUIPMENT } from './programs.js';
import { videoKind } from './integrations.js';

const MAX_ROWS = 10000;
const EXISTING = ['skip', 'add_video', 'replace_video'];
// Header names people use for each column (lower case, spaces and punctuation ignored).
const COLUMNS = {
  name: ['name', 'exercise', 'exercisename', 'title'],
  category: ['category', 'type', 'group', 'folder'],
  video_url: ['videourl', 'video', 'videolink', 'url', 'link'],
  poster_url: ['posterurl', 'poster', 'thumbnail', 'thumbnailurl', 'image', 'still'],
  instructions: ['instructions', 'cues', 'coachingcues', 'notes', 'description'],
  movement: ['movement', 'pattern', 'movementpattern'],
  muscles: ['muscles', 'muscle', 'musclegroup', 'musclegroups', 'bodypart'],
  equipment: ['equipment', 'gear', 'implement']
};
const key = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();   // Macs and drives often write accents apart (NFD)
const catOf = (s) => CATEGORIES.find((c) => c.toLowerCase() === clean(s).toLowerCase()) ?? null;
function httpsUrl(s) {
  let u; try { u = new URL(s); } catch { return null; }
  return u.protocol === 'https:' ? u.href : null;
}

function check(ctx, body) {
  const text = body?.csv;
  if (typeof text !== 'string' || !text.trim()) throw badRequest('Choose the CSV file with the exercises (the upload tool writes video-library.csv).');
  const t = parseCsv(text);
  const col = {};
  // The best-named header for each column wins (Video URL before a plain Link), each header used once.
  const used = new Set();
  for (const [field, names] of Object.entries(COLUMNS)) {
    col[field] = names.map((n) => t.headers.find((h) => !used.has(h) && key(h) === n)).find(Boolean) ?? null;
    if (col[field]) used.add(col[field]);
  }
  if (!col.name) throw badRequest(`The file needs a column with the exercise names, called Name or Exercise. Its columns are: ${t.headers.join(', ')}.`);
  if (t.rows.length > MAX_ROWS) throw badRequest(`That's ${t.rows.length.toLocaleString()} rows. Bring in up to ${MAX_ROWS.toLocaleString()} at a time.`);
  const existing = EXISTING.includes(body.existing) ? body.existing : 'skip';
  const library = new Map(ctx.db.all('SELECT id, name, video_url, poster_url FROM exercises').map((e) => [e.name.normalize('NFC').toLowerCase(), e]));
  const problems = [], seen = new Map(), add = [], update = [], skipped = [];
  let unknownCats = 0, unknownTags = 0;
  t.rows.forEach((r, i) => {
    const row = i + 2;                     // the header is row 1
    const problem = (column, message) => problems.push({ row, column, message });
    const name = clean(r[col.name]);
    if (!name) return problem(col.name, 'Add the exercise name.');
    if (name.length > 120) return problem(col.name, `"${name.slice(0, 40)}…" is ${name.length} characters; keep names to 120.`);
    const lower = name.toLowerCase();
    if (seen.has(lower)) return problem(col.name, `${name} is also on row ${seen.get(lower)}. Keep one of them.`);
    seen.set(lower, row);
    const rawCat = col.category ? clean(r[col.category]) : '';
    const category = rawCat ? catOf(rawCat) : null;
    if (rawCat && !category) unknownCats++;
    const rawVideo = col.video_url ? clean(r[col.video_url]) : '';
    const video = rawVideo ? httpsUrl(rawVideo) : null;
    if (rawVideo && (!video || videoKind(video) === 'unplayable')) problem(col.video_url, `"${rawVideo.slice(0, 80)}" isn't a video link that plays (a secure https link to an .mp4, .mov, .m4v or .webm file, or YouTube or Vimeo).`);
    const rawPoster = col.poster_url ? clean(r[col.poster_url]) : '';
    const poster = rawPoster ? httpsUrl(rawPoster) : null;
    if (rawPoster && (!poster || !/\.(jpe?g|png|webp)$/i.test(new URL(poster).pathname))) problem(col.poster_url, `"${rawPoster.slice(0, 80)}" isn't a picture link (a secure https link to a .jpg, .png or .webp file).`);
    const instructions = col.instructions ? String(r[col.instructions] ?? '').trim() : '';
    if (instructions.length > 4000) problem(col.instructions, `The cues are ${instructions.length} characters; keep them to 4,000.`);
    // Tags: a value that isn't on our list comes in without that tag (noted, never a problem), like an unknown category.
    const tagList = (c, list) => { if (!c) return null; const raw = clean(r[c]); if (!raw) return null; const known = raw.split(/[,;|/]/).map((x) => x.trim().toLowerCase()).filter((x) => list.includes(x)); if (known.length < raw.split(/[,;|/]/).filter((x) => x.trim()).length) unknownTags++; return known.length ? list.filter((x) => known.includes(x)).join(',') : null; };
    const movement = col.movement ? (() => { const raw = clean(r[col.movement]).toLowerCase(); if (!raw) return null; if (!MOVEMENTS.includes(raw)) { unknownTags++; return null; } return raw; })() : null;
    const item = { row, name, category, video_url: video, poster_url: poster, instructions: instructions || null, movement, muscles: tagList(col.muscles, MUSCLES), equipment: tagList(col.equipment, EQUIPMENT) };
    const have = library.get(lower);
    if (!have) return add.push(item);
    // A still only changes when the file gives one; the same video with no still in the file keeps the one it has.
    const changes = existing === 'replace_video' ? !!video && (video !== have.video_url || (!!poster && poster !== have.poster_url))
      : existing === 'add_video' ? !!video && !have.video_url : false;
    if (changes) update.push({ ...item, poster_url: poster ?? (video === have.video_url ? have.poster_url : null), id: have.id, library_name: have.name });
    else skipped.push({ row, name: have.name, reason: existing === 'skip' ? 'already in the library' : !video ? 'no video in the file' : existing === 'add_video' ? 'already has a video' : 'already has this video' });
  });
  const notes = [];
  if (unknownTags) notes.push(`${unknownTags.toLocaleString()} ${unknownTags === 1 ? 'tag isn\'t' : 'tags aren\'t'} on our lists (movement: ${MOVEMENTS.join(', ')}; muscles: ${MUSCLES.join(', ')}; equipment: ${EQUIPMENT.join(', ')}); ${unknownTags === 1 ? 'it is' : 'they are'} left off (you can set them later).`);
  if (unknownCats) notes.push(`${unknownCats.toLocaleString()} ${unknownCats === 1 ? 'category isn\'t' : 'categories aren\'t'} one of ${CATEGORIES.join(', ')}; ${unknownCats === 1 ? 'that exercise comes' : 'those exercises come'} in with no category (you can set it later).`);
  return { t, col, existing, problems, add, update, skipped, notes };
}

const summary = (c) => ({
  rows: c.t.rows.length, columns: Object.fromEntries(Object.entries(c.col).filter(([, v]) => v)), existing: c.existing,
  new: c.add.length, new_with_video: c.add.filter((x) => x.video_url).length, updated: c.update.length, skipped: c.skipped.length,
  sample: c.add.slice(0, 8).map(({ row, ...x }) => x), updates_sample: c.update.slice(0, 8).map((x) => ({ name: x.library_name, video_url: x.video_url })),
  skipped_sample: c.skipped.slice(0, 20),
  problems: c.problems.slice(0, 100), problem_count: c.problems.length, notes: c.notes,
  ready: !c.problems.length && (c.add.length + c.update.length) > 0
});

export function previewExerciseImport(ctx, body = {}) { return summary(check(ctx, body)); }

export function saveExerciseImport(ctx, body = {}) {
  const c = check(ctx, body);                       // checked again at save time
  const s = summary(c);
  if (s.problem_count) { const e = badRequest(`Nothing was saved: ${s.problem_count} ${s.problem_count === 1 ? 'problem' : 'problems'} to fix first.`); e.details = { problems: s.problems, problem_count: s.problem_count }; throw e; }
  if (!s.ready) throw badRequest('There\'s nothing new to bring in from that file.');
  const now = ctx.now();
  ctx.db.tx(() => {
    for (const x of c.add) ctx.db.run('INSERT INTO exercises (id, name, video_url, poster_url, instructions, category, movement, muscles, equipment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('ex'), x.name, x.video_url, x.poster_url, x.instructions, x.category, x.movement ?? null, x.muscles ?? null, x.equipment ?? null, now);
    for (const x of c.update) ctx.db.run('UPDATE exercises SET video_url = ?, poster_url = ? WHERE id = ?', x.video_url, x.poster_url, x.id);
  });
  return { ...s, saved: true };
}
