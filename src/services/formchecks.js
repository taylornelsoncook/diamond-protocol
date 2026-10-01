// Form checks: an athlete films a set on their phone and sends it to the coach, who answers with a note (and a clip of
// their own if they like). The clips are videos of minors, so they never touch this server's disk or the public video
// library bucket: they go to a private bucket of the owner's (Cloudflare R2 or any S3 store). The phone uploads straight
// to it with a one-time signed address, and everyone who may watch gets a short-lived signed address to play it. Clips
// are removed after form_check_keep_days (owner setting, 90 by default). Parents see their own athlete's checks and
// the coach's answers in the portal and can remove a clip; owners and coaches see them on the client page and on Today.
import { createHash, createHmac } from 'node:crypto';
import { newId, token, v, notFound, conflict, badRequest, HttpError } from '../util.js';
import { getSetting } from './families.js';
import { rateLimit } from './security.js';
import { emit } from './events.js';
import { sendMessage } from './engage.js';
import { endpointProblem } from './offsite.js';

export const MAX_BYTES = 150 * 1024 * 1024, MAX_SECONDS = 60, UPLOAD_MINUTES = 15, PLAY_MINUTES = 10, PER_DAY = 10;
export const TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v' };

// ---------- The bucket ----------
// FORMCHECK_S3_* in Render; the endpoint, key and secret fall back to the backups' (one R2 token can cover both buckets)
// but the bucket itself must be its own: never the backups bucket, never the public video bucket.
export function config(env = process.env) {
  const c = { endpoint: (env.FORMCHECK_S3_ENDPOINT ?? env.BACKUP_S3_ENDPOINT ?? '').replace(/\/+$/, ''), bucket: env.FORMCHECK_S3_BUCKET ?? '',
    region: env.FORMCHECK_S3_REGION || env.BACKUP_S3_REGION || 'auto', keyId: env.FORMCHECK_S3_KEY_ID ?? env.BACKUP_S3_KEY_ID ?? '', secret: env.FORMCHECK_S3_SECRET ?? env.BACKUP_S3_SECRET ?? '' };
  const problems = [];
  if (!c.bucket) problems.push('FORMCHECK_S3_BUCKET is not set (the private bucket for athletes\' clips, like dp-athlete-videos).');
  else if (c.bucket === (env.BACKUP_S3_BUCKET ?? '')) problems.push('FORMCHECK_S3_BUCKET is the backups bucket. Clips need their own private bucket.');
  if (!c.endpoint) problems.push('No storage address: set FORMCHECK_S3_ENDPOINT (or the backups\' BACKUP_S3_ENDPOINT).');
  else { const bad = endpointProblem(c.endpoint, env.FORMCHECK_S3_ENDPOINT ? 'FORMCHECK_S3_ENDPOINT' : 'BACKUP_S3_ENDPOINT'); if (bad) problems.push(bad); }
  if (!c.keyId || !c.secret) problems.push('No storage key: set FORMCHECK_S3_KEY_ID and FORMCHECK_S3_SECRET (or the backups\' BACKUP_S3_KEY_ID and BACKUP_S3_SECRET, if that token covers the clips bucket too).');
  return { ...c, problems, ready: !problems.length };
}
// The address the browser talks to, for the page's connect-src (server.js) and the bucket's CORS rule.
export const storageOrigin = (env = process.env) => { const c = config(env); if (!c.ready) return null; try { return new URL(c.endpoint).origin; } catch { return null; } };
const keepDays = (ctx) => Math.min(365, Math.max(30, Number(getSetting(ctx, 'form_check_keep_days')) || 90));
export function status(ctx) {
  const c = config();
  return { ready: c.ready, problems: c.problems, bucket: c.bucket || null, storage_origin: storageOrigin(), keep_days: keepDays(ctx), max_mb: MAX_BYTES / 1024 / 1024, max_seconds: MAX_SECONDS,
    cors_origins: [ctx.publicUrl].filter(Boolean), waiting: ctx.db.get(`SELECT COUNT(*) AS n FROM form_checks f JOIN clients c ON c.id = f.client_id WHERE f.status = 'sent' AND c.archived_at IS NULL`).n,
    stored: ctx.db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) + COALESCE(SUM(CASE WHEN reply_status = 'sent' THEN reply_bytes END), 0) AS bytes FROM form_checks WHERE status != 'uploading'`),
    orphans: ctx.db.get('SELECT COUNT(*) AS n FROM form_check_orphans').n };
}

// ---------- Signing (AWS Signature Version 4) ----------
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
const objectUrl = (c, key) => `${c.endpoint}/${enc(c.bucket)}/${key.split('/').map(enc).join('/')}`;
const stamp = (now) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// A signed address that works on its own for a while: the phone PUTs the clip to it, a player GETs from it. The
// content type is part of the signature for uploads, so the phone can only send what it said it would.
export function presign({ method, url, region, keyId, secret, expires, now = new Date(), contentType = null }) {
  const u = new URL(url), amzDate = stamp(now), day = amzDate.slice(0, 8), scope = `${day}/${region}/s3/aws4_request`;
  const headers = { host: u.host, ...(contentType ? { 'content-type': contentType } : {}) };
  const signed = Object.keys(headers).sort();
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${keyId}/${scope}`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': signed.join(';') };
  const query = Object.entries(q).map(([k, val]) => `${enc(k)}=${enc(val)}`).sort().join('&');
  const canonical = [method, u.pathname.split('/').map((p) => enc(decodeURIComponent(p))).join('/'), query, signed.map((k) => `${k}:${headers[k]}\n`).join(''), signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
  const signature = hmac(key, ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).toString('hex');
  return { url: `${u.origin}${u.pathname}?${query}&X-Amz-Signature=${signature}`, headers: contentType ? { 'content-type': contentType } : {}, expires_in: expires };
}
// Header-signed calls from the server itself (HEAD to check a clip arrived, DELETE to remove one). Tests hand in a stand-in.
async function s3(ctx, method, key) {
  const c = config();
  const url = objectUrl(c, key), now = new Date(), amzDate = stamp(now), day = amzDate.slice(0, 8), scope = `${day}/${c.region}/s3/aws4_request`;
  const u = new URL(url), payload = sha256('');
  const headers = { host: u.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = [method, u.pathname.split('/').map((p) => enc(decodeURIComponent(p))).join('/'), '', signed.map((k) => `${k}:${headers[k]}\n`).join(''), signed.join(';'), payload].join('\n');
  const k = hmac(hmac(hmac(hmac(`AWS4${c.secret}`, day), c.region), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.keyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${hmac(k, ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).toString('hex')}`;
  delete headers.host;
  return (ctx.s3Fetch ?? fetch)(url, { method, headers, signal: AbortSignal.timeout(20000) });
}
const removeObject = async (ctx, key) => { try { const r = await s3(ctx, 'DELETE', key); return r.ok || r.status === 404 ? { ok: true } : { ok: false, error: `storage answered ${r.status}` }; } catch (e) { return { ok: false, error: e.message }; } };
// Delete an object, and when the store won't, remember the key so the daily job tries again: a clip whose row is
// gone must never be left sitting in the bucket.
export async function forget(ctx, key) {
  if (!key) return true;
  const r = await removeObject(ctx, key);
  if (!r.ok) { console.error('form check delete:', key, r.error); ctx.db.run('INSERT INTO form_check_orphans (object_key, created_at, last_error) VALUES (?, ?, ?) ON CONFLICT (object_key) DO UPDATE SET last_error = excluded.last_error', key, ctx.now(), String(r.error).slice(0, 200)); }
  return r.ok;
}

// ---------- Sending (the athlete) ----------
export const needReady = () => { const c = config(); if (!c.ready) throw new HttpError(503, 'form_checks_not_set_up', 'Form checks aren\'t set up yet. Ask your coach.'); return c; };
export const typeOf = (t) => { const ct = String(t ?? '').toLowerCase().split(';')[0].trim(); if (!Object.hasOwn(TYPES, ct)) throw badRequest('Send a video from your phone (MP4, MOV or WebM).'); return ct; };
export const uploadFor = (ctx, key, contentType) => { const c = config(); return { method: 'PUT', ...presign({ method: 'PUT', url: objectUrl(c, key), region: c.region, keyId: c.keyId, secret: c.secret, expires: UPLOAD_MINUTES * 60, now: new Date(ctx.now()), contentType }) }; };
// Step 1: the app says what it's about to send; it gets a one-time address to PUT the clip to.
export function startUpload(ctx, client, body = {}) {
  needReady();
  if (client.archived_at) throw conflict('This profile is archived, so clips can\'t be sent from it. Ask your coach.');
  const contentType = typeOf(body.content_type);
  const bytes = v.int(body.bytes, 'bytes', { min: 1, max: MAX_BYTES * 4 });
  if (bytes > MAX_BYTES) throw badRequest(`That clip is ${(bytes / 1024 / 1024).toFixed(0)} MB. Keep clips under ${MAX_BYTES / 1024 / 1024} MB: a shorter clip, or a lower quality setting.`);
  const duration = body.duration_s === undefined || body.duration_s === null || body.duration_s === '' ? null : Number(body.duration_s);
  if (duration !== null && !(duration >= 0 && duration <= 3600)) throw badRequest('duration_s must be seconds.');
  if (duration !== null && duration > MAX_SECONDS + 1) throw badRequest(`Keep clips to ${MAX_SECONDS} seconds: one set is plenty.`);
  const note = v.str(body.note, 'note', { max: 300, optional: true });
  let exerciseId = null, exerciseName = null, slotId = null, workoutTitle = null;
  if (body.workout_exercise_id) {
    const s = ctx.db.get('SELECT we.id, we.exercise_id, e.name, w.title FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id JOIN workouts w ON w.id = we.workout_id WHERE we.id = ?', v.str(body.workout_exercise_id, 'workout_exercise_id'));
    if (s) { exerciseId = s.exercise_id; exerciseName = s.name; slotId = s.id; workoutTitle = s.title; }
  }
  if (!exerciseId && body.exercise_id) { const e = ctx.db.get('SELECT id, name FROM exercises WHERE id = ?', v.str(body.exercise_id, 'exercise_id')); if (e) { exerciseId = e.id; exerciseName = e.name; } }
  if (!exerciseName) exerciseName = v.str(body.exercise_name, 'exercise_name', { max: 120, optional: true }) ?? 'Form check';
  rateLimit(`formcheck:${client.id}`, PER_DAY, 24 * 60 * 60000);   // ten clips a day per athlete (a mistake the app refused above doesn't count)
  const id = newId('fc'), key = `form-checks/${client.id}/${id}.${TYPES[contentType]}`;
  const now = ctx.now(), expires = new Date(Date.parse(now) + keepDays(ctx) * 86400000).toISOString();
  ctx.db.run(`INSERT INTO form_checks (id, client_id, exercise_id, exercise_name, workout_exercise_id, workout_title, note, object_key, content_type, bytes, duration_s, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`, id, client.id, exerciseId, exerciseName, slotId, workoutTitle, note, key, contentType, bytes, duration, now, expires);
  return { id, exercise_name: exerciseName, upload: uploadFor(ctx, key, contentType), max_bytes: MAX_BYTES, max_seconds: MAX_SECONDS };
}
// Step 2: the clip is up. The server looks at what arrived (size and type) before anyone can see it.
// The row goes only when we know the object isn't there (or was just removed); when the store can't be reached the
// row stays 'uploading' and the app asks again, and the daily job removes what's left after a day.
export async function finishUpload(ctx, client, id) {
  const fc = ctx.db.get('SELECT * FROM form_checks WHERE id = ? AND client_id = ?', id, client.id);
  if (!fc) throw notFound('Form check');
  if (fc.status !== 'uploading') return shape(ctx, fc);
  const head = await checkObject(ctx, fc.object_key, fc.content_type);
  if (!head.ok) {
    if (head.kind === 'store') throw new HttpError(503, 'storage_unavailable', head.why);
    if (head.kind === 'missing' || head.removed) ctx.db.run('DELETE FROM form_checks WHERE id = ?', id);
    throw badRequest(head.why);
  }
  const done = ctx.db.run(`UPDATE form_checks SET status = 'sent', sent_at = ?, bytes = ?, etag = ? WHERE id = ? AND status = 'uploading'`, ctx.now(), head.bytes, head.etag, id);
  const out = shape(ctx, ctx.db.get('SELECT * FROM form_checks WHERE id = ?', id));
  if (done.changes === 1) emit(ctx, 'form_check.sent', { form_check_id: id, client_id: client.id, client_name: client.name, exercise_name: fc.exercise_name, bytes: head.bytes });
  return out;
}
// What's in the bucket under key: { ok, bytes, etag }, or why not (kind: 'store' = couldn't ask, 'missing', 'bad' =
// there but not what was declared, removed when we managed to delete it).
export async function checkObject(ctx, key, contentType) {
  let res;
  try { res = await s3(ctx, 'HEAD', key); } catch (e) { return { ok: false, kind: 'store', why: `We couldn't check the clip (${e.message}). Try again in a minute.` }; }
  if (res.status === 404) return { ok: false, kind: 'missing', why: 'The clip didn\'t arrive. Check your signal and send it again.' };
  if (!res.ok) return { ok: false, kind: 'store', why: `The clip couldn't be checked (storage answered ${res.status}). Try again in a minute.` };
  const bytes = Number(res.headers.get('content-length')) || 0, type = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const etag = String(res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, '') || null;
  if (!bytes || bytes > MAX_BYTES) return { ok: false, kind: 'bad', removed: (await removeObject(ctx, key)).ok, why: bytes ? `That clip is ${(bytes / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.` : 'The clip came through empty. Send it again.' };
  if (type && type !== contentType) return { ok: false, kind: 'bad', removed: (await removeObject(ctx, key)).ok, why: 'That file isn\'t the video you chose. Send it again.' };
  return { ok: true, bytes, etag };
}

// ---------- Watching ----------
// A clip that answers a form check the coach asked for in the plan (workout_exercises.form_check, version 61).
const ASKED = `(SELECT we.form_check FROM workout_exercises we WHERE we.id = f.workout_exercise_id) AS asked`;
const shape = (ctx, fc) => ({ id: fc.id, client_id: fc.client_id, exercise_id: fc.exercise_id, exercise_name: fc.exercise_name, workout_title: fc.workout_title, note: fc.note,
  status: fc.status, bytes: fc.bytes, duration_s: fc.duration_s, created_at: fc.created_at, sent_at: fc.sent_at, answered_at: fc.answered_at, coach_name: fc.coach_name, reply: fc.reply,
  has_reply_video: fc.reply_status === 'sent', seen_by_athlete_at: fc.seen_by_athlete_at, asked: !!fc.asked, expires_at: fc.expires_at, days_left: Math.max(0, Math.ceil((Date.parse(fc.expires_at) - Date.parse(ctx.now())) / 86400000)) });
export function listForClient(ctx, clientId, { limit = 30 } = {}) {
  return ctx.db.all(`SELECT f.*, ${ASKED} FROM form_checks f WHERE f.client_id = ? AND f.status != 'uploading' ORDER BY f.sent_at DESC LIMIT ?`, clientId, Math.min(Math.max(Number(limit) || 30, 1), 200)).map((fc) => shape(ctx, fc));
}
export function listWaiting(ctx, { limit = 100 } = {}) {
  return ctx.db.all(`SELECT f.*, c.name AS client_name, ${ASKED} FROM form_checks f JOIN clients c ON c.id = f.client_id WHERE f.status = 'sent' AND c.archived_at IS NULL ORDER BY f.sent_at LIMIT ?`, limit)
    .map((fc) => ({ ...shape(ctx, fc), client_name: fc.client_name }));
}
export function listAll(ctx, { status: st, clientId, limit = 50 } = {}) {
  const where = [`f.status != 'uploading'`], p = [];
  if (st === 'waiting') where.push(`f.status = 'sent'`); else if (st === 'answered') where.push(`f.status = 'answered'`);
  if (clientId) { where.push('f.client_id = ?'); p.push(clientId); }
  return ctx.db.all(`SELECT f.*, c.name AS client_name, ${ASKED} FROM form_checks f JOIN clients c ON c.id = f.client_id WHERE ${where.join(' AND ')} ORDER BY f.sent_at DESC LIMIT ?`, ...p, Math.min(Math.max(Number(limit) || 50, 1), 200))
    .map((fc) => ({ ...shape(ctx, fc), client_name: fc.client_name }));
}
function rowFor(ctx, id, { clientId = null, familyId = null } = {}) {
  const fc = ctx.db.get('SELECT f.*, c.family_id, c.name AS client_name FROM form_checks f JOIN clients c ON c.id = f.client_id WHERE f.id = ?', id);
  if (!fc || (clientId && fc.client_id !== clientId) || (familyId && fc.family_id !== familyId)) throw notFound('Form check');
  return fc;
}
// A short-lived address to play the clip (which: 'clip' or 'reply'). Who may ask is decided by the route that calls this.
// The upload address works for 15 minutes, so before anyone watches, the object is checked against what was
// verified at /done (its ETag): a clip swapped after the check is refused and removed.
export async function playUrl(ctx, id, which = 'clip', scope = {}) {
  const fc = rowFor(ctx, id, scope), c = needReady();
  const key = which === 'reply' ? fc.reply_object_key : fc.object_key, type = which === 'reply' ? fc.reply_content_type : fc.content_type, etag = which === 'reply' ? fc.reply_etag : fc.etag;
  if (!key || (which === 'reply' ? fc.reply_status !== 'sent' : fc.status === 'uploading')) throw notFound('Video');
  if (etag) {
    const head = await checkObject(ctx, key, type);
    if (!head.ok && head.kind === 'store') throw new HttpError(503, 'storage_unavailable', 'The video can\'t be reached right now. Try again in a minute.');
    if (!head.ok || head.etag !== etag) {
      await forget(ctx, key);
      if (which === 'reply') ctx.db.run('UPDATE form_checks SET reply_object_key = NULL, reply_content_type = NULL, reply_bytes = NULL, reply_status = NULL, reply_etag = NULL WHERE id = ?', id);
      else ctx.db.run('DELETE FROM form_checks WHERE id = ?', id);
      throw conflict('This clip isn\'t the one that was checked when it was sent, so it was removed. Ask for it to be sent again.');
    }
  }
  return { ...presign({ method: 'GET', url: objectUrl(c, key), region: c.region, keyId: c.keyId, secret: c.secret, expires: PLAY_MINUTES * 60, now: new Date(ctx.now()) }), content_type: type };
}
// The same play address for another kind of clip kept in this bucket (sprint analysis, services/sprint.js): checked
// against the ETag pinned when it arrived; a swapped object is removed and refused (onSwapped drops the row).
export async function playObject(ctx, { key, contentType, etag, onSwapped }) {
  const c = needReady();
  if (etag) {
    const head = await checkObject(ctx, key, contentType);
    if (!head.ok && head.kind === 'store') throw new HttpError(503, 'storage_unavailable', 'The video can\'t be reached right now. Try again in a minute.');
    if (!head.ok || head.etag !== etag) { await forget(ctx, key); onSwapped?.(); throw conflict('This clip isn\'t the one that was checked when it was sent, so it was removed. Send it again.'); }
  }
  return { ...presign({ method: 'GET', url: objectUrl(c, key), region: c.region, keyId: c.keyId, secret: c.secret, expires: PLAY_MINUTES * 60, now: new Date(ctx.now()) }), content_type: contentType };
}
export function markSeen(ctx, client, id) {
  const fc = rowFor(ctx, id, { clientId: client.id });
  if (fc.status === 'answered' && !fc.seen_by_athlete_at) ctx.db.run('UPDATE form_checks SET seen_by_athlete_at = ? WHERE id = ?', ctx.now(), id);
  return shape(ctx, ctx.db.get('SELECT * FROM form_checks WHERE id = ?', id));
}

// ---------- Answering (owners and coaches) ----------
// A note, sent to the athlete as a coach message too (so it shows in Messages with the usual email), and optionally a clip.
export function reply(ctx, id, body = {}, user) {
  const fc = rowFor(ctx, id);
  if (fc.status === 'uploading') throw conflict('That clip hasn\'t finished uploading.');
  const text = v.str(body.text, 'text', { max: 1000, optional: fc.reply_status === 'sent' }) ?? fc.reply;
  if (!text && fc.reply_status !== 'sent') throw badRequest('Write what you saw and what to change, or add a clip.');
  ctx.db.run(`UPDATE form_checks SET status = 'answered', answered_at = ?, coach_id = ?, coach_name = ?, reply = ?, seen_by_athlete_at = NULL WHERE id = ?`, ctx.now(), user?.id ?? null, user?.name ?? null, text, id);
  if (text) sendMessage(ctx, { clientId: fc.client_id }, { body: `Form check, ${fc.exercise_name}: ${text}` }, user);
  emit(ctx, 'form_check.answered', { form_check_id: id, client_id: fc.client_id, client_name: fc.client_name, exercise_name: fc.exercise_name, coach_name: user?.name ?? null });
  return shape(ctx, ctx.db.get('SELECT * FROM form_checks WHERE id = ?', id));
}
// A coach's clip uploads under its own key (reply_pending_*) while any earlier clip stays watchable; it takes over
// only once it's checked, and the earlier object is then removed. An upload that never finishes is cleared by the job.
export function startReplyUpload(ctx, id, body = {}) {
  needReady();
  const fc = rowFor(ctx, id);
  if (fc.status === 'uploading') throw conflict('That clip hasn\'t finished uploading.');
  const contentType = typeOf(body.content_type);
  const bytes = v.int(body.bytes, 'bytes', { min: 1, max: MAX_BYTES * 4 });
  if (bytes > MAX_BYTES) throw badRequest(`Keep the clip under ${MAX_BYTES / 1024 / 1024} MB.`);
  if (fc.reply_pending_key) forget(ctx, fc.reply_pending_key).catch(() => {});   // a coach who started over: the earlier try is dropped
  const key = `form-checks/${fc.client_id}/${fc.id}-reply-${token(6)}.${TYPES[contentType]}`;
  ctx.db.run(`UPDATE form_checks SET reply_pending_key = ?, reply_pending_type = ?, reply_pending_bytes = ?, reply_pending_at = ? WHERE id = ?`, key, contentType, bytes, ctx.now(), id);
  return { id, upload: uploadFor(ctx, key, contentType) };
}
export async function finishReplyUpload(ctx, id, user) {
  const fc = rowFor(ctx, id);
  if (!fc.reply_pending_key) return shape(ctx, fc);
  const head = await checkObject(ctx, fc.reply_pending_key, fc.reply_pending_type);
  if (!head.ok) {
    if (head.kind === 'store') throw new HttpError(503, 'storage_unavailable', head.why);
    if (head.kind === 'missing' || head.removed) ctx.db.run('UPDATE form_checks SET reply_pending_key = NULL, reply_pending_type = NULL, reply_pending_bytes = NULL, reply_pending_at = NULL WHERE id = ?', id);
    throw badRequest(head.why);
  }
  const old = fc.reply_status === 'sent' ? fc.reply_object_key : null;
  ctx.db.run(`UPDATE form_checks SET reply_object_key = reply_pending_key, reply_content_type = reply_pending_type, reply_bytes = ?, reply_etag = ?, reply_status = 'sent',
    reply_pending_key = NULL, reply_pending_type = NULL, reply_pending_bytes = NULL, reply_pending_at = NULL,
    status = 'answered', answered_at = COALESCE(answered_at, ?), coach_id = COALESCE(coach_id, ?), coach_name = COALESCE(coach_name, ?), seen_by_athlete_at = NULL WHERE id = ?`,
    head.bytes, head.etag, ctx.now(), user?.id ?? null, user?.name ?? null, id);
  if (old && old !== fc.reply_pending_key) await forget(ctx, old);
  return shape(ctx, ctx.db.get('SELECT * FROM form_checks WHERE id = ?', id));
}
// Remove a clip and its answer: a coach, or the athlete's parent.
// The objects go (or are parked for the job when the store won't), then the row: a removal always finishes.
const keysOf = (fc) => [fc.object_key, fc.reply_object_key, fc.reply_pending_key].filter(Boolean);
export async function remove(ctx, id, scope = {}) {
  const fc = rowFor(ctx, id, scope);
  for (const key of keysOf(fc)) await forget(ctx, key);
  ctx.db.run('DELETE FROM form_checks WHERE id = ?', id);
  return { id, deleted: true };
}
// Every clip of an athlete (deleting a family): objects first, then the rows go with the client.
export async function removeAllFor(ctx, clientId) {
  for (const fc of ctx.db.all('SELECT object_key, reply_object_key, reply_pending_key FROM form_checks WHERE client_id = ?', clientId)) for (const key of keysOf(fc)) await forget(ctx, key);
  ctx.db.run('DELETE FROM form_checks WHERE client_id = ?', clientId);
}
// The daily job: clips past their keep date go, uploads that never finished (a phone that gave up, a coach's reply
// clip) after a day, and objects the store refused to delete earlier are tried again. A clip the store still won't
// delete stays listed and is tried again tomorrow.
export async function cleanup(ctx) {
  if (!config().ready) return { skipped: true };
  const now = ctx.now(), dayAgo = new Date(Date.parse(now) - 86400000).toISOString();
  const rows = ctx.db.all(`SELECT * FROM form_checks WHERE expires_at < ? OR (status = 'uploading' AND created_at < ?)`, now, dayAgo);
  let removed = 0, kept = 0, orphans = 0;
  for (const fc of rows) {
    const gone = (await Promise.all(keysOf(fc).map((k) => removeObject(ctx, k)))).every((r) => r.ok);
    if (gone) { ctx.db.run('DELETE FROM form_checks WHERE id = ?', fc.id); removed++; } else kept++;
  }
  for (const fc of ctx.db.all(`SELECT id, reply_pending_key FROM form_checks WHERE reply_pending_key IS NOT NULL AND reply_pending_at < ?`, dayAgo)) {
    if ((await removeObject(ctx, fc.reply_pending_key)).ok) { ctx.db.run('UPDATE form_checks SET reply_pending_key = NULL, reply_pending_type = NULL, reply_pending_bytes = NULL, reply_pending_at = NULL WHERE id = ?', fc.id); removed++; } else kept++;
  }
  for (const o of ctx.db.all('SELECT object_key FROM form_check_orphans')) {
    const r = await removeObject(ctx, o.object_key);
    if (r.ok) { ctx.db.run('DELETE FROM form_check_orphans WHERE object_key = ?', o.object_key); orphans++; } else { ctx.db.run('UPDATE form_check_orphans SET last_error = ? WHERE object_key = ?', String(r.error).slice(0, 200), o.object_key); kept++; }
  }
  return { removed, kept, orphans };
}
export function forExport(ctx, clientId) {
  return ctx.db.all(`SELECT exercise_name, workout_title, note, sent_at, status, coach_name, reply, answered_at, expires_at FROM form_checks WHERE client_id = ? AND status != 'uploading' ORDER BY sent_at`, clientId);
}
