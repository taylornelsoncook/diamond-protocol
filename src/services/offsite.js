import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { backupDir, listBackups } from './backups.js';

// Off-site copies of the daily backup: each one is checked, encrypted and sent to S3-compatible storage
// (Cloudflare R2, Backblaze B2, AWS S3 …), then downloaded again and compared, so a copy only counts once
// we know it restores. No SDK: requests are signed (AWS Signature V4) with node:crypto.
const STATE_KEY = 'backup_offsite';
const MAGIC = Buffer.from('DPB1'); // file format: MAGIC | salt(16) | iv(12) | ciphertext | tag(16)

export function config(env = process.env) {
  const c = {
    endpoint: (env.BACKUP_S3_ENDPOINT ?? '').replace(/\/+$/, ''),
    bucket: env.BACKUP_S3_BUCKET ?? '',
    region: env.BACKUP_S3_REGION || 'auto',
    keyId: env.BACKUP_S3_KEY_ID ?? '',
    secret: env.BACKUP_S3_SECRET ?? '',
    prefix: env.BACKUP_S3_PREFIX ?? 'diamond-protocol/',
    passphrase: env.BACKUP_PASSPHRASE ?? ''
  };
  return c.endpoint && c.bucket && c.keyId && c.secret && c.passphrase ? c : null;
}

// ---- encryption: AES-256-GCM, key from the passphrase via scrypt ----
export function encrypt(buf, passphrase) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, c.getAuthTag()]);
}
export function decrypt(buf, passphrase) {
  if (buf.length < 48 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not a Diamond Protocol backup file.');
  const d = createDecipheriv('aes-256-gcm', scryptSync(passphrase, buf.subarray(4, 20), 32), buf.subarray(20, 32));
  d.setAuthTag(buf.subarray(buf.length - 16));
  try { return Buffer.concat([d.update(buf.subarray(32, buf.length - 16)), d.final()]); }
  catch { throw new Error('Could not decrypt the backup: wrong passphrase, or the file is damaged.'); }
}

// ---- S3 requests: path-style URLs, Signature V4 ----
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

export function sign({ method, url, body, region, keyId, secret, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? '');
  const headers = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = [
    method,
    u.pathname.split('/').map((p) => enc(decodeURIComponent(p))).join('/'),
    [...u.searchParams].map(([k, val]) => `${enc(k)}=${enc(val)}`).sort().join('&'),
    signed.map((k) => `${k}:${headers[k]}\n`).join(''),
    signed.join(';'),
    payloadHash
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${hmac(key, toSign).toString('hex')}`;
  delete headers.host; // fetch sets it
  return headers;
}

async function s3(c, method, key, body) {
  const url = `${c.endpoint}/${enc(c.bucket)}/${key.split('/').map(enc).join('/')}`;
  const headers = sign({ method, url, body, region: c.region, keyId: c.keyId, secret: c.secret });
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(120_000) });
  const data = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    const code = /<Code>([^<]+)<\/Code>/.exec(data.toString())?.[1];
    throw new Error(`Storage answered ${res.status}${code ? ` ${code}` : ''} to ${method}.`);
  }
  return data;
}

// A backup is only worth sending if SQLite can open it and finds nothing broken.
export function checkDatabase(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const r = d.prepare('PRAGMA integrity_check').all();
    if (r.length !== 1 || Object.values(r[0])[0] !== 'ok') throw new Error('The backup failed its integrity check.');
    d.prepare('SELECT COUNT(*) FROM clients').get();
  } catch (e) {
    throw new Error(e.message.startsWith('The backup') ? e.message : `The backup does not open as a database: ${e.message}`);
  } finally { d.close(); }
}

const state = (ctx) => JSON.parse(ctx.db.get('SELECT value FROM settings WHERE key = ?', STATE_KEY)?.value ?? '{}');
const saveState = (ctx, patch) => ctx.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  STATE_KEY, JSON.stringify({ ...state(ctx), ...patch }));

export function status(ctx) {
  const s = state(ctx);
  return { configured: !!config(), last_ok_name: s.last_ok_name ?? null, last_ok_at: s.last_ok_at ?? null, last_error: s.last_error ?? null, last_error_at: s.last_error_at ?? null };
}

// Check, encrypt, upload, download again, decrypt and compare one backup. Records the outcome either way.
export async function send(ctx, name) {
  const c = config();
  if (!c) return null;
  const at = new Date().toISOString();
  try {
    const file = join(backupDir(ctx), name);
    checkDatabase(file);
    const plain = readFileSync(file);
    const key = `${c.prefix}${name}.enc`;
    await s3(c, 'PUT', key, encrypt(plain, c.passphrase));
    const back = decrypt(await s3(c, 'GET', key), c.passphrase);
    if (sha256(back) !== sha256(plain)) throw new Error('The copy read back from storage does not match.');
    saveState(ctx, { last_ok_name: name, last_ok_at: at, last_error: null, last_error_at: null });
    return { ok: true, key };
  } catch (e) {
    saveState(ctx, { last_error: e.message, last_error_at: at });
    return { ok: false, error: e.message };
  }
}

// Send the newest backup unless it's already there. Runs hourly, so a failed send retries.
export async function sendNewest(ctx) {
  const newest = listBackups(ctx)[0];
  if (!newest || !config() || state(ctx).last_ok_name === newest.name) return null;
  return send(ctx, newest.name);
}

// Fetch one off-site copy by backup name (e.g. diamond-20260927-030000.db) and return the plain database.
export async function fetchCopy(name) {
  const c = config();
  if (!c) throw new Error('Off-site storage is not set up (BACKUP_S3_* and BACKUP_PASSPHRASE).');
  return decrypt(await s3(c, 'GET', `${c.prefix}${name}.enc`), c.passphrase);
}
