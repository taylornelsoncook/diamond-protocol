import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { routes, openApiSpec } from './routes.js';
import { HttpError } from './util.js';
import { userForSession, keyForSecret } from './services/access.js';
import { clientByToken } from './services/clients.js';
import { deliverPending } from './services/events.js';
import { guardianForToken } from './services/families.js';
import { extendSchedule } from './services/schedule.js';
import { runTeamBilling } from './services/teams.js';
import { syncLibrary } from './services/performance.js';
import { assignMissingIds } from './services/athlete-ids.js';
import { can, audit, rateLimit, roleName } from './services/security.js';
import { dailyBackup } from './services/backups.js';
import { syncAll as syncDevices, migratePending } from './services/perf-import.js';
import { runBilling } from './services/billing.js';
import { createTestProvider } from './payments/test-provider.js';
import { handleStripeEvent } from './services/commerce.js';
import { sendReminders, smsMode, verifyTwilio, handleInbound } from './services/sms.js';
import { weeklyDigest } from './services/insights.js';
import { runFollowUps } from './services/leads.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
const PAGES = { '/': 'index.html', '/app': 'client.html', '/parent': 'parent.html', '/join': 'join.html', '/start': 'start.html', '/kiosk': 'kiosk.html', '/book': 'book.html', '/terms': 'legal.html', '/privacy': 'legal.html' };
const CSP = [
  "default-src 'self'", "img-src 'self' data: https:", "media-src 'self' https:",
  "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "frame-src https://www.youtube-nocookie.com https://player.vimeo.com", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"
].join('; ');

export function createApp({ dbFile = ':memory:', testMode = false, payments = createTestProvider(), publicUrl, mail = {}, sms = {}, jobs = true, hawkinBaseUrl } = {}) {
  const ctx = { db: openDb(dbFile), dbFile, testMode, payments, publicUrl, mail, sms, hawkinBaseUrl, now: () => new Date().toISOString() };
  syncLibrary(ctx);
  assignMissingIds(ctx);
  migratePending(ctx);
  ctx.onEvent = () => setImmediate(() => deliverPending(ctx).catch(() => {}));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Hosting platforms end HTTPS at their proxy and forward plain HTTP; trust their header only when told to.
    const fwdProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    if (process.env.TRUST_PROXY === 'true' && (fwdProto === 'https' || fwdProto === 'http')) url.protocol = `${fwdProto}:`;
    if (url.protocol === 'https:') res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (ctx.publicUrl?.startsWith('https://') && url.protocol === 'http:' && process.env.TRUST_PROXY === 'true' && url.pathname !== '/healthz') {
      res.writeHead(301, { location: `${ctx.publicUrl}${url.pathname}${url.search}` });
      return res.end();
    }
    if (url.pathname === '/healthz') {
      try { ctx.db.get('SELECT 1 AS ok'); return json(res, 200, { ok: true, time: new Date().toISOString() }); }
      catch { return json(res, 503, { ok: false }); }
    }
    try {
      const baseUrl = ctx.publicUrl || `${url.protocol.replace(':', '')}://${url.host}`;
      if (url.pathname === '/v1/openapi.json') return json(res, 200, openApiSpec(baseUrl));
      if (url.pathname === '/stripe/webhook' && req.method === 'POST') return stripeWebhook(ctx, req, res);
      if (url.pathname === '/sms/inbound' && req.method === 'POST') return smsInbound(ctx, req, res, `${baseUrl}/sms/inbound`);
      const route = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
      if (!route) {
        if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, url.pathname);
        const known = routes.some((r) => r.regex.test(url.pathname));
        throw new HttpError(known ? 405 : 404, known ? 'method_not_allowed' : 'not_found', known ? 'That method is not allowed here.' : 'No such endpoint.');
      }
      const r = { params: url.pathname.match(route.regex).groups ?? {}, query: Object.fromEntries(url.searchParams), body: {}, baseUrl };
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) r.body = await readJson(req, ['/v1/imports', '/v1/results', '/v1/uploads/preview', '/v1/uploads/commit', '/v1/client-import/preview'].includes(url.pathname) ? 30_000_000 : 1_000_000);
      const ip = clientIp(req);
      r.ip = ip;
      r.kioskKey = req.headers['x-kiosk-key'];
      // Rate limits: sign-in attempts per address, and an overall ceiling per address.
      if (route.path === '/auth/login' || route.path === '/auth/token') rateLimit(`login:${ip}`, 20, 15 * 60000);
      if (route.path === '/portal/api/login' || route.path === '/portal/api/verify') rateLimit(`portal:${ip}`, 20, 15 * 60000);
      if (route.path.startsWith('/portal/api/signup')) rateLimit(`signup:${ip}`, 15, 60 * 60000);
      if (route.path === '/portal/api/public/inquiry') rateLimit(`inquiry:${ip}`, 10, 60 * 60000);
      if (route.path.startsWith('/pay-api/')) rateLimit(`pay:${ip}`, 60, 15 * 60000);
      if (route.path.startsWith('/here-api/')) rateLimit(`here:${ip}`, 60, 15 * 60000);
      if (route.path === '/portal/api/public/schedule') rateLimit(`schedule:${ip}`, 120, 15 * 60000);
      rateLimit(`all:${ip}`, 1200, 60000);
      try { authenticate(ctx, req, route, r, url); }
      catch (e) { if (route.path === '/auth/login') audit(ctx, { actor_type: 'public', actor_name: String(r.body?.email ?? '').slice(0, 120), action: 'sign-in', status: e.status, ip }); throw e; }
      const auditable = req.method !== 'GET' && route.path !== '/stripe/webhook';
      res.on('finish', () => {
        if (!auditable && res.statusCode !== 403 && !(route.path.startsWith('/v1/backups/') && req.method === 'GET')) return;
        const actor = r.user ? { actor_type: 'staff', actor_id: r.user.id, actor_name: r.user.name, role: r.user.role }
          : r.apiKey ? { actor_type: 'api_key', actor_id: r.apiKey.id, actor_name: r.apiKey.label } : r.guardian ? { actor_type: 'parent', actor_id: r.guardian.id, actor_name: r.guardian.name }
          : { actor_type: 'public', actor_name: route.path === '/auth/login' || route.path === '/auth/token' ? String(r.body?.email ?? '').slice(0, 120) : null };
        audit(ctx, { ...actor, action: route.path === '/auth/login' || route.path === '/auth/token' ? 'sign-in' : `${req.method} ${route.path}`, target: Object.values(r.params)[0] ?? null, status: res.statusCode, ip });
      });
      if (r.user) {
        const passwordFree = ['/auth/me', '/auth/password', '/auth/logout'].includes(route.path);
        if (r.user.must_change_password && !passwordFree) throw new HttpError(403, 'password_change_required', 'Choose a new password before continuing.');
        if (!can(r.user.role, req.method, route.path)) throw new HttpError(403, 'forbidden', `Your role (${roleName(r.user.role)}) can't do this. Ask the owner.`);
      }
      if (route.path === '/auth/login') {
        const out = route.handler(ctx, r);
        res.setHeader('set-cookie', cookie('dp_session', out.token, out.maxAge, url.protocol === 'https:'));
        return json(res, 200, { user: out.user });
      }
      if (route.path === '/auth/logout') res.setHeader('set-cookie', cookie('dp_session', '', 0, url.protocol === 'https:'));
      if (route.path === '/portal/api/verify' || route.path === '/portal/api/signup/verify') {
        const out = await route.handler(ctx, r);
        res.setHeader('set-cookie', cookie('dp_family', out.token, out.maxAge, url.protocol === 'https:'));
        return json(res, 200, { guardian: out.guardian });
      }
      if (route.path === '/portal/api/logout') res.setHeader('set-cookie', cookie('dp_family', '', 0, url.protocol === 'https:'));
      const out = await route.handler(ctx, r);
      if (out?.__file) {
        res.writeHead(200, { 'content-type': out.__file.type, 'content-disposition': `attachment; filename="${out.__file.filename}"`, 'cache-control': 'no-store' });
        if (out.__file.stream) return out.__file.stream.pipe(res);
        return res.end(out.__file.body);
      }
      return json(res, route.status, out);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
      console.error(e);
      return json(res, 500, { error: { code: 'server_error', message: 'Something went wrong on our side. Try again.' } });
    }
  });

  let timers = [];
  if (jobs) {
    timers.push(setInterval(() => deliverPending(ctx).catch((e) => console.error('webhooks', e)), 15000));
    timers.push(setInterval(() => runBilling(ctx).catch((e) => console.error('billing', e)), 60 * 60 * 1000));
    timers.push(setInterval(() => runTeamBilling(ctx, { baseUrl: ctx.publicUrl }).catch((e) => console.error('team billing', e)), 60 * 60 * 1000));
    runTeamBilling(ctx, { baseUrl: ctx.publicUrl }).catch((e) => console.error('team billing', e));
    timers.push(setInterval(() => syncDevices(ctx), 15 * 60 * 1000));
    if (dbFile !== ':memory:') {
      const backup = () => { try { const b = dailyBackup(ctx); if (b) console.log(`Backup saved: ${b.name}`); } catch (e) { console.error('backup', e.message); } };
      timers.push(setInterval(backup, 60 * 60 * 1000));
      backup();
    }
    timers.push(setInterval(() => extendSchedule(ctx).catch((e) => console.error('schedule', e)), 6 * 60 * 60 * 1000));
    timers.push(setInterval(() => sendReminders(ctx).catch((e) => console.error('reminders', e)), 60 * 60 * 1000));
    timers.push(setInterval(() => weeklyDigest(ctx).catch((e) => console.error('weekly digest', e)), 60 * 60 * 1000));
    timers.push(setInterval(() => runFollowUps(ctx).catch((e) => console.error('lead follow-up', e)), 60 * 60 * 1000));
    runBilling(ctx).catch((e) => console.error('billing', e));
    extendSchedule(ctx).catch((e) => console.error('schedule', e));
  }
  server.on('close', () => { timers.forEach(clearInterval); ctx.db.close(); });
  return { server, ctx };
}

// Behind a hosting proxy the real address is in X-Forwarded-For; only trust it when TRUST_PROXY is set.
function clientIp(req) {
  if (process.env.TRUST_PROXY === 'true') return String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;
  return req.socket.remoteAddress;
}

function authenticate(ctx, req, route, r, url) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...rest]) => [k, decodeURIComponent(rest.join('='))]));
  r.sessionToken = cookies.dp_session;
  if (route.auth === 'public') return;
  if (route.auth === 'guardian') {
    const bearerFam = (req.headers.authorization || '').match(/^Bearer\s+(dp_fam_.+)$/i)?.[1];
    r.familyToken = bearerFam || cookies.dp_family;
    r.guardian = guardianForToken(ctx, r.familyToken);
    if (!r.guardian) throw new HttpError(401, 'unauthenticated', 'Sign in with your email to continue.');
    if (!bearerFam && req.method !== 'GET' && req.headers.origin && req.headers.origin !== `${url.protocol}//${url.host}`) throw new HttpError(403, 'bad_origin', 'Requests from other sites are not allowed.');
    return;
  }
  if (route.auth === 'client') {
    r.client = clientByToken(ctx, req.headers['x-client-token'] || url.searchParams.get('token'));
    if (!r.client) throw new HttpError(401, 'invalid_link', 'This app link is not valid. Ask your coach for a new one.');
    return;
  }
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer?.startsWith('dp_app_')) {
    r.user = userForSession(ctx, bearer);
    if (!r.user) throw new HttpError(401, 'session_expired', 'Your sign-in has expired. Sign in again.');
    return;
  }
  if (bearer && route.auth === 'any') {
    r.apiKey = keyForSecret(ctx, bearer);
    if (!r.apiKey) throw new HttpError(401, 'invalid_api_key', 'That API key is not valid or has been revoked.');
    return;
  }
  r.user = userForSession(ctx, r.sessionToken);
  if (!r.user) throw new HttpError(401, 'unauthenticated', route.auth === 'session' ? 'Sign in to the dashboard to do this.' : 'Sign in, or send an API key as "Authorization: Bearer dp_live_...".');
  // Cookie-authenticated writes must come from this site (blocks cross-site request forgery).
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && origin !== `${url.protocol}//${url.host}`) throw new HttpError(403, 'bad_origin', 'Requests from other sites are not allowed.');
  }
}

async function readRaw(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request body must be under 1 MB.');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Stripe calls this when a payment finishes, fails, or a client saves a card on Stripe's page.
async function stripeWebhook(ctx, req, res) {
  const raw = await readRaw(req);
  let event;
  try { event = ctx.payments.verifyWebhook(raw, req.headers['stripe-signature']); }
  catch (e) { return json(res, 400, { error: { code: 'bad_signature', message: e.message } }); }
  try { return json(res, 200, await handleStripeEvent(ctx, event)); }
  catch (e) { console.error('stripe webhook', e); return json(res, 500, { error: { code: 'server_error', message: 'Could not process the event.' } }); }
}

// Twilio calls this when a parent replies to a text. Signed with the Twilio auth token; answered with TwiML.
async function smsInbound(ctx, req, res, url) {
  const raw = await readRaw(req, 100_000);
  if (smsMode(ctx) === 'test') return json(res, 404, { error: { code: 'not_found', message: 'Texting is not set up on this server.' } });
  const params = Object.fromEntries(new URLSearchParams(raw));
  if (!verifyTwilio(ctx, url, params, req.headers['x-twilio-signature'])) return json(res, 403, { error: { code: 'bad_signature', message: 'This request was not signed by Twilio.' } });
  let reply = null;
  try { reply = await handleInbound(ctx, params); } catch (e) { console.error('sms inbound', e); }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${reply ? `<Message>${esc(reply)}</Message>` : ''}</Response>`);
}

async function readJson(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', `Request body must be under ${Math.round(limit / 1_000_000)} MB.`);
    chunks.push(c);
  }
  if (!size) return {};
  if (!(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send JSON with "Content-Type: application/json".');
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'invalid_json', 'The request body is not a valid JSON object.'); }
}

async function serveStatic(res, pathname) {
  const file = PAGES[pathname] ?? (/^\/invoice\/[\w-]+$/.test(pathname) ? 'invoice.html' : /^\/pay\/[\w-]+$/.test(pathname) ? 'pay.html' : /^\/here\/[\w-]+$/.test(pathname) ? 'here.html' : pathname.slice(1));
  const full = normalize(join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  try {
    if (!(await stat(full)).isFile()) throw new Error();
    const body = await readFile(full);
    const type = MIME[extname(full)] || 'application/octet-stream';
    // The Book now page is made to sit inside the business's own website, so any site may frame it. It only shows
    // public information and every button opens the parent portal in a new tab.
    const csp = file === 'book.html' ? CSP.replace("frame-ancestors 'none'", 'frame-ancestors *') : CSP;
    res.writeHead(200, { 'content-type': type, 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=300' });
    res.end(body);
  } catch {
    json(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
const cookie = (name, value, maxAge, secure) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
