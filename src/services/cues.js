// The coach's cue for an exercise (version 68; owner decision, the third Farren improvement: the session should feel
// coached). A coach records a short cue once, in the library (the phone's microphone; up to a minute, 2 MB), and the
// athlete app plays it the moment the exercise opens. Its words (the transcript, or the exercise's written cue) are
// read aloud by the phone where there's no recording. A coach can also add a short "why this matters" clip, which goes
// into the private clips bucket the same two-step way as a form check (never on this server's disk) and plays from a
// short-lived link. Library content from coaches, nothing personal: the recording lives in the database (small, and
// backed up with everything else); the clip in the bucket.
import { v, notFound, badRequest, HttpError } from '../util.js';
import * as store from './formchecks.js';

export const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a' };
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024, MAX_AUDIO_SECONDS = 60;
export const MAX_CLIP_BYTES = 60 * 1024 * 1024, MAX_CLIP_SECONDS = 20;

const exerciseOf = (ctx, id) => {
  const e = ctx.db.get('SELECT id, name, instructions FROM exercises WHERE id = ?', String(id));
  if (!e) throw notFound('Exercise');
  return e;
};
const rowOf = (ctx, id) => ctx.db.get('SELECT * FROM exercise_cues WHERE exercise_id = ?', String(id));
const audioType = (t) => { const ct = String(t ?? '').toLowerCase().split(';')[0].trim(); if (!Object.hasOwn(AUDIO_TYPES, ct)) throw badRequest('Record the cue in the browser, or send an audio file (M4A, MP3, WebM, OGG or WAV).'); return ct; };
const seconds = (val, max, what) => {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  if (!(n >= 0 && n <= 3600)) throw badRequest('duration_s must be seconds.');
  if (n > max + 1) throw badRequest(`Keep ${what} to ${max} seconds.`);
  return n;
};
// What a screen needs to know about an exercise's cue, never the bytes.
export const shape = (r, e = null) => ({
  exercise_id: r?.exercise_id ?? e?.id ?? null,
  audio: !!r?.audio_bytes, audio_seconds: r?.audio_seconds ?? null, audio_type: r?.audio_type ?? null, audio_by: r?.audio_by ?? null, audio_at: r?.audio_at ?? null,
  transcript: r?.transcript ?? null, words: r?.transcript ?? e?.instructions ?? null,   // what the phone reads aloud with no recording
  clip: !!r?.clip_key, clip_seconds: r?.clip_seconds ?? null, clip_by: r?.clip_by ?? null, clip_at: r?.clip_at ?? null, clip_pending: !!r?.pending_key,
  updated_at: r?.updated_at ?? null
});
export function getCue(ctx, exerciseId) {
  const e = exerciseOf(ctx, exerciseId);
  return { ...shape(rowOf(ctx, e.id), e), exercise_name: e.name, max_audio_seconds: MAX_AUDIO_SECONDS, max_audio_bytes: MAX_AUDIO_BYTES, max_clip_seconds: MAX_CLIP_SECONDS, max_clip_bytes: MAX_CLIP_BYTES, clips_ready: store.config().ready };
}
// For a list of exercises at once (the app's workout, the library): id → { audio, clip, words, audio_seconds }.
export function cuesFor(ctx, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = ctx.db.all(`SELECT exercise_id, audio_bytes, audio_seconds, transcript, clip_key, clip_seconds FROM exercise_cues WHERE exercise_id IN (${list.map(() => '?').join(', ')})`, ...list);
  return new Map(rows.map((r) => [r.exercise_id, { audio: !!r.audio_bytes, audio_seconds: r.audio_seconds, transcript: r.transcript, clip: !!r.clip_key, clip_seconds: r.clip_seconds }]));
}
const touch = (ctx, id) => { if (!rowOf(ctx, id)) ctx.db.run('INSERT INTO exercise_cues (exercise_id, updated_at) VALUES (?, ?)', id, ctx.now()); };

// ---------- The recording ----------
// body: audio_base64, content_type, duration_s, transcript (what was said; the app reads it where the phone can't play
// the recording, and it's what a screen reader gets).
export function saveAudio(ctx, exerciseId, body = {}, user) {
  const e = exerciseOf(ctx, exerciseId);
  const type = audioType(body.content_type);
  const b64 = String(body.audio_base64 ?? '').replace(/^data:[^,]*,/, '').trim();
  if (!b64) throw badRequest('Record the cue first: audio_base64 is empty.');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw badRequest('audio_base64 must be base64.');
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) throw badRequest('The recording is empty. Try again.');
  if (bytes.length > MAX_AUDIO_BYTES) throw badRequest(`That recording is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_AUDIO_BYTES / 1024 / 1024} MB. Keep a cue to a few sentences.`);
  const secs = seconds(body.duration_s, MAX_AUDIO_SECONDS, 'a cue');
  const transcript = v.str(body.transcript, 'transcript', { max: 1000, optional: true }) || null;
  touch(ctx, e.id);
  ctx.db.run('UPDATE exercise_cues SET audio = ?, audio_type = ?, audio_bytes = ?, audio_seconds = ?, audio_by = ?, audio_at = ?, transcript = COALESCE(?, transcript), updated_at = ? WHERE exercise_id = ?',
    bytes, type, bytes.length, secs, user?.name ?? null, ctx.now(), transcript, ctx.now(), e.id);
  return getCue(ctx, e.id);
}
// The words alone (a coach fixing the transcript, or writing one to be read aloud without a recording).
export function saveTranscript(ctx, exerciseId, body = {}) {
  const e = exerciseOf(ctx, exerciseId);
  const transcript = v.str(body.transcript, 'transcript', { max: 1000, optional: true }) || null;
  touch(ctx, e.id);
  ctx.db.run('UPDATE exercise_cues SET transcript = ?, updated_at = ? WHERE exercise_id = ?', transcript, ctx.now(), e.id);
  return getCue(ctx, e.id);
}
export function removeAudio(ctx, exerciseId) {
  const e = exerciseOf(ctx, exerciseId);
  ctx.db.run('UPDATE exercise_cues SET audio = NULL, audio_type = NULL, audio_bytes = NULL, audio_seconds = NULL, audio_by = NULL, audio_at = NULL, updated_at = ? WHERE exercise_id = ?', ctx.now(), e.id);
  return getCue(ctx, e.id);
}
// The bytes, as a file the browser plays inline (cached an hour: a changed cue has a new updated_at the app sends as ?v=).
export function audioFile(ctx, exerciseId) {
  const e = exerciseOf(ctx, exerciseId);
  const r = ctx.db.get('SELECT audio, audio_type FROM exercise_cues WHERE exercise_id = ? AND audio IS NOT NULL', e.id);
  if (!r) throw notFound('A recorded cue for this exercise');
  return { __file: { body: Buffer.from(r.audio), type: r.audio_type, inline: true, cache: 'private, max-age=3600', filename: `cue.${AUDIO_TYPES[r.audio_type] ?? 'bin'}` } };
}

// ---------- The clip ----------
// Step 1 (owner and coach): content type, size and length; answers the one-time address to PUT the file to. A clip
// already on file stays until the new one is checked.
export function startClip(ctx, exerciseId, body = {}, user) {
  const e = exerciseOf(ctx, exerciseId);
  store.needReady();
  const contentType = store.typeOf(body.content_type);
  const bytes = v.int(body.bytes, 'bytes', { min: 1, max: MAX_CLIP_BYTES * 4 });
  if (bytes > MAX_CLIP_BYTES) throw badRequest(`That clip is ${(bytes / 1024 / 1024).toFixed(0)} MB. Keep a cue clip under ${MAX_CLIP_BYTES / 1024 / 1024} MB: a few seconds is the point.`);
  const secs = seconds(body.duration_s, MAX_CLIP_SECONDS, 'a cue clip');
  const key = `cues/${e.id}/${Date.now().toString(36)}.${store.TYPES[contentType]}`;
  touch(ctx, e.id);
  ctx.db.run('UPDATE exercise_cues SET pending_key = ?, pending_type = ?, pending_bytes = ?, pending_seconds = ?, pending_at = ?, updated_at = ? WHERE exercise_id = ?', key, contentType, bytes, secs, ctx.now(), ctx.now(), e.id);
  return { exercise_id: e.id, upload: store.uploadFor(ctx, key, contentType), max_bytes: MAX_CLIP_BYTES, max_seconds: MAX_CLIP_SECONDS, by: user?.name ?? null };
}
// Step 2: the file is up. It's checked (there, the size and type declared); then it replaces the clip on file, whose
// object is removed. A store that can't be reached answers 503 and the upload stays pending for the retry.
export async function finishClip(ctx, exerciseId, user) {
  const e = exerciseOf(ctx, exerciseId);
  const r = rowOf(ctx, e.id);
  if (!r?.pending_key) throw badRequest('Start the upload first.');
  const head = await store.checkObject(ctx, r.pending_key, r.pending_type);
  if (!head.ok) {
    if (head.kind === 'store') throw new HttpError(503, 'storage_unavailable', head.why);
    ctx.db.run('UPDATE exercise_cues SET pending_key = NULL, pending_type = NULL, pending_bytes = NULL, pending_seconds = NULL, pending_at = NULL WHERE exercise_id = ?', e.id);
    throw badRequest(head.why);
  }
  if (head.bytes > MAX_CLIP_BYTES) { await store.forget(ctx, r.pending_key); ctx.db.run('UPDATE exercise_cues SET pending_key = NULL WHERE exercise_id = ?', e.id); throw badRequest(`That clip is ${(head.bytes / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_CLIP_BYTES / 1024 / 1024} MB.`); }
  const old = r.clip_key;
  ctx.db.run(`UPDATE exercise_cues SET clip_key = pending_key, clip_type = pending_type, clip_bytes = ?, clip_seconds = pending_seconds, clip_etag = ?, clip_by = ?, clip_at = ?,
    pending_key = NULL, pending_type = NULL, pending_bytes = NULL, pending_seconds = NULL, pending_at = NULL, updated_at = ? WHERE exercise_id = ?`, head.bytes, head.etag, user?.name ?? null, ctx.now(), ctx.now(), e.id);
  if (old && old !== r.pending_key) await store.forget(ctx, old);
  return getCue(ctx, e.id);
}
export async function removeClip(ctx, exerciseId) {
  const e = exerciseOf(ctx, exerciseId);
  const r = rowOf(ctx, e.id);
  if (r?.clip_key) await store.forget(ctx, r.clip_key);
  if (r?.pending_key) await store.forget(ctx, r.pending_key);
  ctx.db.run('UPDATE exercise_cues SET clip_key = NULL, clip_type = NULL, clip_bytes = NULL, clip_seconds = NULL, clip_etag = NULL, clip_by = NULL, clip_at = NULL, pending_key = NULL, pending_type = NULL, pending_bytes = NULL, pending_seconds = NULL, pending_at = NULL, updated_at = ? WHERE exercise_id = ?', ctx.now(), e.id);
  return getCue(ctx, e.id);
}
// A short-lived address to play the clip (the object's ETag is checked against what was pinned at /done).
export async function clipUrl(ctx, exerciseId) {
  const e = exerciseOf(ctx, exerciseId);
  const r = rowOf(ctx, e.id);
  if (!r?.clip_key) throw notFound('A cue clip for this exercise');
  return store.playObject(ctx, { key: r.clip_key, contentType: r.clip_type, etag: r.clip_etag, onSwapped: () => ctx.db.run('UPDATE exercise_cues SET clip_key = NULL, clip_type = NULL, clip_bytes = NULL, clip_seconds = NULL, clip_etag = NULL WHERE exercise_id = ?', e.id) });
}
// Deleting an exercise: its clip goes from the bucket too (the row goes with the exercise).
export async function forgetExercise(ctx, exerciseId) {
  const r = rowOf(ctx, exerciseId);
  if (r?.clip_key) await store.forget(ctx, r.clip_key);
  if (r?.pending_key) await store.forget(ctx, r.pending_key);
}
// The daily clean-up: uploads that never finished.
export async function cleanup(ctx) {
  const dayAgo = new Date(Date.parse(ctx.now()) - 86400000).toISOString();
  let removed = 0;
  for (const r of ctx.db.all('SELECT exercise_id, pending_key FROM exercise_cues WHERE pending_key IS NOT NULL AND pending_at < ?', dayAgo)) {
    await store.forget(ctx, r.pending_key);
    ctx.db.run('UPDATE exercise_cues SET pending_key = NULL, pending_type = NULL, pending_bytes = NULL, pending_seconds = NULL, pending_at = NULL WHERE exercise_id = ?', r.exercise_id);
    removed++;
  }
  return { removed };
}
// How many exercises have a recorded cue or a clip, for the library's count line.
export const counts = (ctx) => ctx.db.get('SELECT COUNT(audio_bytes) AS recorded, COUNT(clip_key) AS clips FROM exercise_cues');
