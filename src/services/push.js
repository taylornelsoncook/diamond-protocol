// Push notifications for the athlete app (version 70; owner decision, the fifth Farren improvement: the web app installs
// to the home screen and taps the athlete on the shoulder like a native app would). Web Push with VAPID, no
// dependencies: the keys are made once here and kept in settings (nothing for the owner to set up), each push is an
// empty message signed with the server's key (so nothing personal travels through Apple's or Google's push service),
// and the phone's service worker (public/sw.js) then asks us what's new (POST /push/pending with its own endpoint) and
// shows it. What gets a push: a coach's message (form-check answers and sprint reviews arrive as messages), the first
// program being ready, and a morning reminder on a day with a workout (push_reminder_hour, business time). A push
// service that answers 404 or 410 ends that subscription.
import { createPublicKey, createPrivateKey, generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';
import { newId, v, badRequest, notFound } from '../util.js';
import { getSetting } from './families.js';
import { rateLimit } from './security.js';

const TTL = 24 * 60 * 60, JWT_HOURS = 12, KEEP_DAYS = 7, MAX_PER_CLIENT = 8;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hashOf = (s) => createHash('sha256').update(String(s)).digest('hex');
const setting = (ctx, key) => ctx.db.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;

// ---------- VAPID keys: made once, kept in settings ----------
export function keys(ctx) {
  let pub = process.env.VAPID_PUBLIC_KEY || setting(ctx, 'vapid_public'), priv = process.env.VAPID_PRIVATE_KEY || setting(ctx, 'vapid_private');
  if (!pub || !priv) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    pub = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
    priv = jwk.d;
    ctx.db.run(`INSERT INTO settings (key, value) VALUES ('vapid_public', ?), ('vapid_private', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, pub, priv);
  }
  return { publicKey: pub, privateKey: priv };
}
const privateKeyObject = ({ publicKey, privateKey }) => {
  const raw = Buffer.from(publicKey, 'base64url');
  return { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)), d: privateKey };
};
// The Authorization header for one push service (RFC 8292): a JWT for its origin, signed ES256 with our key.
export function vapidHeader(ctx, endpoint, { now = Date.now() } = {}) {
  const k = keys(ctx);
  const aud = new URL(endpoint).origin;
  const sub = `mailto:${String(process.env.EMAIL_FROM || process.env.DP_EMAIL_FROM || 'hello@diamondprotocol.org').replace(/^.*<|>.*$/g, '')}`;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + JWT_HOURS * 3600, sub }));
  const data = `${head}.${claims}`;
  const sig = sign('sha256', Buffer.from(data), { key: createPrivateKey({ key: privateKeyObject(k), format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${k.publicKey}`;
}
// For checking a header (tests): the public key as a KeyObject.
export const publicKeyObject = (publicKey) => { const raw = Buffer.from(publicKey, 'base64url'); return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' }); };

// ---------- Subscriptions ----------
export function status(ctx, clientId) {
  const subs = ctx.db.all('SELECT id, endpoint, user_agent, created_at, last_used_at FROM push_subscriptions WHERE client_id = ? ORDER BY created_at', clientId);
  return { public_key: keys(ctx).publicKey, subscriptions: subs.map((s) => ({ id: s.id, endpoint_host: new URL(s.endpoint).host, device: s.user_agent, created_at: s.created_at, last_used_at: s.last_used_at })), reminder_hour: reminderHour(ctx) };
}
// body.subscription is what the browser's pushManager.subscribe answered: { endpoint, keys: { p256dh, auth } }.
export function subscribe(ctx, client, body = {}, { userAgent = null } = {}) {
  const s = body.subscription ?? body;
  const endpoint = v.url(s?.endpoint, 'subscription.endpoint');
  if (!/^https:/.test(endpoint)) throw badRequest('The subscription endpoint must be https.');
  const p256dh = v.str(s?.keys?.p256dh, 'subscription.keys.p256dh', { max: 200 }), auth = v.str(s?.keys?.auth, 'subscription.keys.auth', { max: 100 });
  const h = hashOf(endpoint), now = ctx.now();
  const cur = ctx.db.get('SELECT id, client_id FROM push_subscriptions WHERE endpoint_hash = ?', h);
  if (cur) ctx.db.run('UPDATE push_subscriptions SET client_id = ?, p256dh = ?, auth = ?, user_agent = ?, last_used_at = ?, failed_at = NULL WHERE id = ?', client.id, p256dh, auth, userAgent, now, cur.id);   // the same phone, signed in as someone else: it follows them
  else {
    const n = ctx.db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE client_id = ?', client.id).n;
    if (n >= MAX_PER_CLIENT) ctx.db.run('DELETE FROM push_subscriptions WHERE id = (SELECT id FROM push_subscriptions WHERE client_id = ? ORDER BY COALESCE(last_used_at, created_at) LIMIT 1)', client.id);
    ctx.db.run('INSERT INTO push_subscriptions (id, client_id, endpoint_hash, endpoint, p256dh, auth, user_agent, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('psub'), client.id, h, endpoint, p256dh, auth, userAgent, now, now);
  }
  return { ...status(ctx, client.id), subscribed: true };
}
export function unsubscribe(ctx, client, body = {}) {
  const endpoint = v.url(body.endpoint, 'endpoint');
  const r = ctx.db.run('DELETE FROM push_subscriptions WHERE client_id = ? AND endpoint_hash = ?', client.id, hashOf(endpoint));
  return { ...status(ctx, client.id), removed: r.changes };
}

// ---------- Sending ----------
// Write the notice and nudge every phone. Nothing is awaited by callers; a push service that is down is tried again
// by the next notice (the notice itself waits in push_notices until a phone asks).
export function notify(ctx, clientId, { title, body, url = '/app', kind = 'message' }) {
  const subs = ctx.db.all('SELECT * FROM push_subscriptions WHERE client_id = ?', clientId);
  if (!subs.length) return { notice: null, sent: 0 };
  const id = newId('pn');
  ctx.db.run('INSERT INTO push_notices (id, client_id, kind, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, clientId, kind, String(title).slice(0, 120), String(body ?? '').slice(0, 300), url, ctx.now());
  const p = Promise.allSettled(subs.map((s) => wake(ctx, s)));
  if (ctx.pushPending) ctx.pushPending.push(p);   // tests await the sends
  return { notice: id, sent: subs.length };
}
async function wake(ctx, s) {
  const doFetch = ctx.pushFetch ?? fetch;
  let res;
  try {
    res = await doFetch(s.endpoint, { method: 'POST', headers: { TTL: String(TTL), Urgency: 'normal', Authorization: vapidHeader(ctx, s.endpoint), 'Content-Length': '0' }, signal: AbortSignal.timeout(10000) });
  } catch (e) { ctx.db.run('UPDATE push_subscriptions SET failed_at = ? WHERE id = ?', ctx.now(), s.id); return { ok: false, error: e.message }; }
  if (res.status === 404 || res.status === 410) { ctx.db.run('DELETE FROM push_subscriptions WHERE id = ?', s.id); return { ok: false, gone: true }; }
  if (!res.ok) { ctx.db.run('UPDATE push_subscriptions SET failed_at = ? WHERE id = ?', ctx.now(), s.id); return { ok: false, status: res.status }; }
  ctx.db.run('UPDATE push_subscriptions SET last_used_at = ?, failed_at = NULL WHERE id = ?', ctx.now(), s.id);
  return { ok: true };
}
// The service worker asks what to show: everything not yet shown for the phone's athlete (the endpoint is the key;
// it's unguessable, and this is rate-limited by address). Marked shown.
export function pending(ctx, body = {}, { ip = null } = {}) {
  const endpoint = v.url(body.endpoint, 'endpoint');
  if (ip) rateLimit(`push-pending:${ip}`, 120, 15 * 60000);
  const s = ctx.db.get('SELECT id, client_id FROM push_subscriptions WHERE endpoint_hash = ?', hashOf(endpoint));
  if (!s) throw notFound('Subscription');
  const since = new Date(Date.parse(ctx.now()) - KEEP_DAYS * 86400000).toISOString();
  const rows = ctx.db.all('SELECT id, kind, title, body, url, created_at FROM push_notices WHERE client_id = ? AND shown_at IS NULL AND created_at >= ? ORDER BY created_at', s.client_id, since);
  if (rows.length) ctx.db.run(`UPDATE push_notices SET shown_at = ? WHERE id IN (${rows.map(() => '?').join(', ')})`, ctx.now(), ...rows.map((r) => r.id));
  ctx.db.run('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?', ctx.now(), s.id);
  return { data: rows };
}
// A test tap from the app's own button.
export function sendTest(ctx, client) {
  if (!ctx.db.get('SELECT id FROM push_subscriptions WHERE client_id = ?', client.id)) throw badRequest('Turn notifications on first.');
  return notify(ctx, client.id, { title: `${getSetting(ctx, 'business_name')}: notifications are on`, body: 'You\'ll hear from your coach here.', url: '/app', kind: 'test' });
}

// ---------- The morning reminder ----------
const reminderHour = (ctx) => Math.min(20, Math.max(5, Number(getSetting(ctx, 'push_reminder_hour')) || 7));
// Hourly: from the reminder hour on, every athlete with a phone subscribed and a workout dated today not yet logged gets
// one nudge a day (the notice's kind and day say so).
export function runReminders(ctx) {
  const zone = getSetting(ctx, 'timezone');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ctx.now())).map((p) => [p.type, p.value]));
  if (Number(parts.hour) < reminderHour(ctx)) return { skipped: 'early' };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ctx.now()));
  const athletes = ctx.db.all(`SELECT DISTINCT c.id, c.name FROM push_subscriptions s JOIN clients c ON c.id = s.client_id JOIN assignments a ON a.client_id = c.id AND a.active = 1 WHERE c.archived_at IS NULL`);
  let sent = 0;
  for (const c of athletes) {
    if (ctx.db.get(`SELECT id FROM push_notices WHERE client_id = ? AND kind = ? `, c.id, `workout:${day}`)) continue;
    const home = ctx.workoutToday?.(c.id);   // set in server.js: today's unlogged workout, if any (programs.js knows the calendar)
    if (!home) continue;
    notify(ctx, c.id, { title: `Today: ${home.title}`, body: `${home.exercises} ${home.exercises === 1 ? 'exercise' : 'exercises'} in ${home.program}. Tap to open your workout.`, url: '/app', kind: `workout:${day}` });
    sent++;
  }
  return { athletes: athletes.length, sent };
}
// Housekeeping with the daily clean-up: notices older than a week.
export function cleanup(ctx) {
  const since = new Date(Date.parse(ctx.now()) - KEEP_DAYS * 86400000).toISOString();
  return { notices_removed: ctx.db.run('DELETE FROM push_notices WHERE created_at < ?', since).changes };
}
export function forgetClient(ctx, clientId) {
  ctx.db.run('DELETE FROM push_subscriptions WHERE client_id = ?', clientId);
  ctx.db.run('DELETE FROM push_notices WHERE client_id = ?', clientId);
}
export const randomKey = () => b64u(randomBytes(16));
