import { randomBytes, createHash, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

export const newId = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hmac = (secret, s) => createHmac('sha256', secret).update(s).digest('hex');

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const badRequest = (message, code = 'invalid_request') => new HttpError(400, code, message);
export const notFound = (what) => new HttpError(404, 'not_found', `${what} not found.`);
export const conflict = (message) => new HttpError(409, 'conflict', message);

// One at a time per key, within this server: a second tap on "Buy" or "Book" waits for the first to finish
// (card charge included) and then sees its result, instead of charging again. The app runs as one process.
const locks = new Map();
export async function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === chain) locks.delete(key); }
}

export function addDays(iso, n) { return new Date(new Date(iso).getTime() + n * 86400000).toISOString(); }
export function addMonths(iso, n) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}

// Input validation. Each returns the cleaned value or throws a 400 that names the field.
export const v = {
  str(val, field, { max = 200, optional = false } = {}) {
    if (val === undefined || val === null || val === '') {
      if (optional) return null;
      throw badRequest(`${field} is required.`);
    }
    if (typeof val !== 'string') throw badRequest(`${field} must be text.`);
    const s = val.trim();
    if (!s) { if (optional) return null; throw badRequest(`${field} is required.`); }
    if (s.length > max) throw badRequest(`${field} must be ${max} characters or fewer.`);
    return s;
  },
  email(val, field = 'email') {
    const s = v.str(val, field, { max: 254 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw badRequest(`${field} must be a valid email address.`);
    return s.toLowerCase();
  },
  int(val, field, { min = -Infinity, max = Infinity, optional = false } = {}) {
    if (val === undefined || val === null || val === '') {
      if (optional) return null;
      throw badRequest(`${field} is required.`);
    }
    const n = Number(val);
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${field} must be a whole number between ${min} and ${max}.`);
    return n;
  },
  url(val, field, { optional = false, allowHttp = false } = {}) {
    const s = v.str(val, field, { max: 2000, optional });
    if (s === null) return null;
    let u;
    try { u = new URL(s); } catch { throw badRequest(`${field} must be a full URL starting with https://.`); }
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw badRequest(`${field} must start with https://.`);
    return u.toString();
  },
  date(val, field, { optional = false } = {}) {
    const s = v.str(val, field, { max: 40, optional });
    if (s === null) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw badRequest(`${field} must be a date like 2026-10-01.`);
    return d.toISOString();
  },
  oneOf(val, field, options, { optional = false } = {}) {
    if ((val === undefined || val === null) && optional) return null;
    if (!options.includes(val)) throw badRequest(`${field} must be one of: ${options.join(', ')}.`);
    return val;
  }
};

// ---- Time zones: classes are scheduled in the business's local time ----
function tzOffsetMs(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts;
}
// '2026-10-05' + '17:00' in America/Chicago -> UTC ISO string (handles daylight saving)
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number), [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(utc, tz);
  if (second !== utc) utc = second;
  return new Date(utc).toISOString();
}
export const localDate = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
// Midnight at the start of the business day that contains iso, as a UTC ISO string.
// Where the clocks jump forward at midnight (Chile, Cuba) the day starts at the jump, at the offset from before it.
export function startOfLocalDay(iso, tz) {
  const day = localDate(iso, tz), start = zonedToUtc(day, '00:00', tz);
  if (localDate(start, tz) === day) return start;
  const t = Date.parse(start);
  return new Date(Date.parse(`${day}T00:00:00Z`) - tzOffsetMs(t, tz)).toISOString();
}
export const weekdayOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();
export const addDaysToDate = (dateStr, n) => new Date(Date.parse(`${dateStr}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export function ageOn(birthDate, iso) {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T12:00:00Z`), d = new Date(iso);
  let a = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) a--;
  return a;
}
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
// A real calendar date (2026-02-30 is refused).
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
