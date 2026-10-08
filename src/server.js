import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { routes, openApiSpec } from './routes.js';
import { HttpError } from './util.js';
import { userForSession, keyForSecret, logApiRequest } from './services/access.js';
import { clientByToken } from './services/clients.js';
import { deliverPending } from './services/events.js';
import { whoForToken } from './services/families.js';
import { familyLock, clientLock, lockMessage, athleteLockMessage, OPEN_WHILE_LOCKED } from './services/lockout.js';
import { extendSchedule } from './services/schedule.js';
import { runTeamBilling } from './services/teams.js';
import { syncLibrary } from './services/performance.js';
import { seedPresets } from './services/library.js';
import { assignMissingIds } from './services/athlete-ids.js';
import { can, keyAllows, audit, rateLimit, roleName, hideMoney } from './services/security.js';
import { dailyBackup } from './services/backups.js';
import { sendNewest as sendBackupOffsite } from './services/offsite.js';
import { syncHawkin, migratePending } from './services/perf-import.js';
import { runBilling } from './services/billing.js';
import { createTestProvider } from './payments/test-provider.js';
import { handleStripeEvent } from './services/commerce.js';
import { createJobRunner } from './services/jobs.js';
import { sendReminders, smsMode, verifyTwilio, handleInbound } from './services/sms.js';
import { weeklyDigest } from './services/insights.js';
import { runMonthly } from './services/monthly.js';
import { runFollowUps } from './services/leads.js';
import { runReviewRequests, followReviewLink } from './services/reviews.js';
import { runSlotFilling } from './services/spots.js';
import { runMoneyChecks } from './services/moneychecks.js';
import { syncAll as syncWearables } from './services/wearables.js';
import { cleanup as cleanupFormChecks, storageOrigin as formCheckStorage } from './services/formchecks.js';
import { cleanup as cleanupCues } from './services/cues.js';
import { runAdapt } from './services/adapt.js';
import { runReminders as runPushReminders, cleanup as cleanupPush } from './services/push.js';
import { workoutToday } from './services/programs.js';
import { runWeekly } from './services/weekly.js';
import { cleanup as cleanupSprintClips } from './services/sprint.js';
import { followCampaignLink } from './services/campaigns.js';
import { followContactLink } from './services/contact.js';
import { calendarFeed } from './services/portal.js';

// What was typed as the email on the sign-in and forgot-password forms, for the activity log: only if it looks like an
// email, so a password typed into the wrong box is never stored.
const typedEmail = (body) => { const t = String(body?.email ?? '').trim().slice(0, 120); return /^[^\s@]+@[^\s@]+$/.test(t) ? t : t ? '(not an email address)' : null; };
const AUDITED_READS = /^\/v1\/(backups\/:name|audit\/export|webhooks\/:id\/secret|form-checks\/:id\/video|sprint-clips\/:id\/video)$/;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const PAGES = { '/': 'index.html', '/app': 'client.html', '/parent': 'parent.html', '/portal': 'parent.html', '/join': 'join.html', '/start': 'start.html', '/kiosk': 'kiosk.html', '/tv': 'tv.html', '/certificate': 'certificate.html', '/book': 'book.html', '/shop': 'shop.html', '/learn': 'learn.html', '/terms': 'legal.html', '/privacy': 'legal.html' };
const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "img-src 'self' data: https:", "media-src 'self' https: blob:",
  "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"
].join('; ');
// The athlete app and the client page upload form-check clips straight to the owner's private bucket, so that one
// address is allowed for connections when it's set up.
const csp = () => { const o = formCheckStorage(); return o ? CSP.replace("connect-src 'self'", `connect-src 'self' ${o}`) : CSP; };

// allowPrivateWebhooks: webhooks may go to addresses inside a private network (this computer, the office network). Only
// for local development and the tests: on by default in test mode without a PUBLIC_URL, off everywhere else.
export function createApp({ dbFile = ':memory:', testMode = false, payments = createTestProvider(), publicUrl, mail = {}, sms = {}, jobs = true, hawkinBaseUrl, allowPrivateWebhooks = testMode && !publicUrl } = {}) {
  const ctx = { db: openDb(dbFile), dbFile, testMode, payments, publicUrl, mail, sms, hawkinBaseUrl, allowPrivateWebhooks, now: () => new Date().toISOString() };
  syncLibrary(ctx);
  seedPresets(ctx);
  assignMissingIds(ctx);
  migratePending(ctx);
  ctx.onEvent = () => setImmediate(() => deliverPending(ctx).catch(() => {}));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Hosting platforms end HTTPS at their proxy and forward plain HTTP; trust their header only when told to.
    const fwdProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    if (proxyHops() && (fwdProto === 'https' || fwdProto === 'http')) url.protocol = `${fwdProto}:`;
    if (url.protocol === 'https:') res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (ctx.publicUrl?.startsWith('https://') && url.protocol === 'http:' && proxyHops() && url.pathname !== '/healthz') {
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
      // The review link in the email: count the click and go on to Google (or stop asking, with ?stop=1).
      // Links in announcement emails work the same way: /c/<token>/<n> counts the click, /c/<token>?stop=1 stops them.
      // A one-to-one CRM email's stop link is /u/<token> (it only stops emails).
      const review = url.pathname.match(/^\/r\/([\w-]{8,40})$/), camp = url.pathname.match(/^\/c\/([\w-]{8,40})(?:\/(\d{1,3}))?$/), unsub = url.pathname.match(/^\/u\/([\w-]{8,40})$/);
      if ((review || camp || unsub) && (req.method === 'GET' || req.method === 'POST')) {
        rateLimit(`link:${clientIp(req)}`, 60, 15 * 60000);
        const stop = url.searchParams.has('stop') || (camp && camp[2] === undefined) || !!unsub;
        const page = (text, form = '') => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp(), 'cache-control': 'no-store' });
          return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your emails</title><link rel="stylesheet" href="/styles.css"><body style="padding:48px 16px;text-align:center"><p style="font-size:18px">${text.replace(/[<>&]/g, '')}</p>${form}</body>`);
        };
        // Stopping takes a button press, so email scanners that open every link can't unsubscribe anyone.
        if (stop && req.method === 'GET') return page('Stop these emails?', `<form method="post" action="${url.pathname}?stop=1"><button class="dp-btn dp-btn--primary" type="submit">Yes, stop them</button></form>`);
        if (req.method === 'POST' && !stop) throw new HttpError(405, 'method_not_allowed', 'That method is not allowed here.');
        const out = review ? followReviewLink(ctx, review[1], { stop }) : unsub ? followContactLink(ctx, unsub[1], { stop }) : followCampaignLink(ctx, camp[1], camp[2], { stop });
        if (out.redirect) { res.writeHead(302, { location: out.redirect, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); return res.end(); }
        return page(out.page);
      }
      if (url.pathname === '/sms/inbound' && req.method === 'POST') return smsInbound(ctx, req, res, `${baseUrl}/sms/inbound`);
      // A parent's private calendar feed (the secret is the key; only its hash is stored). Calendar apps poll it.
      const cal = url.pathname.match(/^\/cal\/([\w-]{20,64})\.ics$/);
      if (cal && (req.method === 'GET' || req.method === 'HEAD')) {
        rateLimit(`cal:${clientIp(req)}`, 120, 15 * 60000);
        const body = calendarFeed(ctx, cal[1], url.host);
        res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      const route = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
      if (!route) {
        if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, url.pathname);
        const known = routes.some((r) => r.regex.test(url.pathname));
        throw new HttpError(known ? 405 : 404, known ? 'method_not_allowed' : 'not_found', known ? 'That method is not allowed here.' : 'No such endpoint.');
      }
      const r = { params: url.pathname.match(route.regex).groups ?? {}, query: Object.fromEntries(url.searchParams), body: {}, baseUrl };
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) r.body = await readJson(req, ['/v1/imports', '/v1/results', '/v1/uploads/preview', '/v1/uploads/commit', '/v1/client-import/preview', '/v1/leads/import', '/v1/data-imports/preview', '/v1/data-imports', '/v1/programs/import/draft', '/v1/exercises/import/preview', '/v1/exercises/import'].includes(url.pathname)
        || /^\/portal\/api\/athletes\/[^/]+\/data-imports(\/preview)?$/.test(url.pathname) ? (/data-imports/.test(url.pathname) ? 90_000_000 : 30_000_000) : /^\/v1\/exercises\/[^/]+\/cue\/audio$/.test(url.pathname) ? 4_000_000 : 1_000_000);   // a coach's recorded cue, base64   // files come base64-encoded; Apple Health and Fitbit zips are big
      const ip = clientIp(req);
      r.ip = ip;
      r.connection = { forwardedFor: req.headers['x-forwarded-for'] ?? null, socketAddress: req.socket.remoteAddress, clientIp: ip, trustProxy: process.env.TRUST_PROXY ?? null, hops: proxyHops() };
      r.userAgent = req.headers['user-agent'] ?? null;
      r.kioskKey = req.headers['x-kiosk-key'];
      r.reportLink = req.headers['x-report-link'];         // a report share link's secret: in a header, so it stays out of addresses and logs
      // Rate limits: sign-in attempts per address, and an overall ceiling per address.
      if (route.path === '/auth/login' || route.path === '/auth/token') rateLimit(`login:${ip}`, 20, 15 * 60000);
      // Forgot password: a few asks per address an hour (and a ceiling for everyone), and a limit on trying reset links.
      if (route.path === '/auth/forgot') { rateLimit(`forgot:${ip}`, 5, 60 * 60000); rateLimit('forgot:all', 100, 60 * 60000); }
      if (route.path === '/auth/reset' || route.path === '/auth/reset/check') rateLimit(`reset:${ip}`, 20, 15 * 60000);
      if (route.path === '/portal/api/login' || route.path === '/portal/api/verify') rateLimit(`portal:${ip}`, 20, 15 * 60000);
      if (route.path.startsWith('/portal/api/signup')) rateLimit(`signup:${ip}`, 15, 60 * 60000);
      if (route.path === '/portal/api/public/inquiry') { rateLimit(`inquiry:${ip}`, 10, 60 * 60000); rateLimit('inquiry:all', 60, 10 * 60000); }   // per address, and overall
      if (route.path.startsWith('/pay-api/')) rateLimit(`pay:${ip}`, 60, 15 * 60000);
      if (route.path.startsWith('/receipt-api/')) rateLimit(`receipt:${ip}`, 60, 15 * 60000);
      if (route.path.startsWith('/here-api/')) rateLimit(`here:${ip}`, 60, 15 * 60000);
      if (route.path === '/portal/api/public/schedule') rateLimit(`schedule:${ip}`, 120, 15 * 60000);
      if (route.path === '/portal/api/public/certificates/:token') rateLimit(`certificate:${ip}`, 60, 15 * 60000);
      if (route.path === '/portal/api/public/shop') rateLimit(`shop:${ip}`, 120, 15 * 60000);
      if (route.path.startsWith('/portal/api/public/learn')) rateLimit(`learn:${ip}`, 120, 15 * 60000);
      if (/data-imports(\/preview)?$/.test(route.path) && req.method === 'POST') rateLimit(`dataimport:${ip}`, 60, 15 * 60000);   // big files, and Google Sheets links we fetch
      if (route.path.startsWith('/portal/api/public/spot/')) rateLimit(`spot:${ip}`, 60, 15 * 60000);
      if (route.path === '/portal/api/public/report') rateLimit(`report:${ip}`, 60, 15 * 60000);
      rateLimit(`all:${ip}`, 1200, 60000);
      try { authenticate(ctx, req, route, r, url); }
      catch (e) { if (route.path === '/auth/login') audit(ctx, { actor_type: 'public', actor_name: typedEmail(r.body), action: 'sign-in', status: e.status, ip }); throw e; }
      // Reads are logged only when they hand out something private: a backup file, the activity log itself as a CSV, or a
      // webhook signing secret.
      const auditable = (req.method !== 'GET' && route.path !== '/stripe/webhook') || (req.method === 'GET' && AUDITED_READS.test(route.path));
      // Every request made with an API key goes in that key's request log (never the body or the query string).
      if (r.apiKey) {
        const started = Date.now(), key = r.apiKey;
        res.on('finish', () => logApiRequest(ctx, { key_id: key.id, method: req.method, path: url.pathname, status: res.statusCode, duration_ms: Date.now() - started, ip, error: res.dpError }));
      }
      res.on('finish', () => {
        if (!auditable && res.statusCode !== 403) return;
        const typed = ['/auth/login', '/auth/token', '/auth/forgot'].includes(route.path) ? typedEmail(r.body) : route.path === '/auth/reset' ? r.auditName ?? null : null;
        const actor = r.user ? { actor_type: 'staff', actor_id: r.user.id, actor_name: r.user.name, role: r.user.role }
          : r.apiKey ? { actor_type: 'api_key', actor_id: r.apiKey.id, actor_name: r.apiKey.label } : r.guardian ? { actor_type: 'parent', actor_id: r.guardian.id, actor_name: r.guardian.name }
          : r.client ? { actor_type: 'athlete', actor_id: r.client.id, actor_name: r.client.name }
          : { actor_type: 'public', actor_name: typed };
        audit(ctx, { ...actor, action: route.path === '/auth/login' || route.path === '/auth/token' ? 'sign-in' : `${req.method} ${route.path}`, target: Object.values(r.params)[0] ?? null, status: res.statusCode, ip });
      });
      if (r.user) {
        const passwordFree = ['/auth/me', '/auth/password', '/auth/logout'].includes(route.path);
        if (r.user.must_change_password && !passwordFree) throw new HttpError(403, 'password_change_required', 'Choose a new password before continuing.');
        if (!can(r.user.role, req.method, route.path)) throw new HttpError(403, 'forbidden', `Your role (${roleName(r.user.role)}) can't do this. Ask the owner.`);
      }
      if (r.apiKey && !keyAllows(r.apiKey.scope, req.method, route.path)) {
        throw new HttpError(403, 'key_scope', r.apiKey.scope === 'results' ? 'This API key can read and send test results only. Ask the owner for a key with full access.' : 'This API key is read only. Ask the owner for a key that can send data.');
      }
      if (route.path === '/auth/login') {
        const out = route.handler(ctx, r);
        res.setHeader('set-cookie', cookie('dp_session', out.token, out.maxAge, url.protocol === 'https:'));
        return json(res, 200, { user: out.user });
      }
      if (route.path === '/auth/logout') res.setHeader('set-cookie', cookie('dp_session', '', 0, url.protocol === 'https:'));
      if (route.path === '/portal/api/verify' || route.path === '/portal/api/login/password' || route.path === '/portal/api/signup/verify') {
        const out = await route.handler(ctx, r);
        res.setHeader('set-cookie', cookie('dp_family', out.token, out.maxAge, url.protocol === 'https:'));
        return json(res, 200, { guardian: out.guardian, athlete: out.athlete ?? null, kind: out.kind ?? 'parent', name: out.name ?? out.guardian?.name ?? null,
          ...(out.athletes ? { athletes: out.athletes.map(({ id, name, claim, message }) => ({ id, name, claim: claim ?? null, message: message ?? null })) } : {}) });
      }
      if (route.path === '/portal/api/logout') res.setHeader('set-cookie', cookie('dp_family', '', 0, url.protocol === 'https:'));
      const out = await route.handler(ctx, r);
      if (route.path === '/auth/reset') r.auditName = out?.email ?? null;
      // A public route that hands the person on (a wearable's sign-in coming back): a redirect instead of JSON.
      if (out?.__redirect && route.auth === 'public') { res.writeHead(302, { location: out.__redirect, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); return res.end(); }
      if (out?.__file) {
        res.writeHead(200, { 'content-type': out.__file.type, 'content-disposition': out.__file.inline ? 'inline' : `attachment; filename="${out.__file.filename}"`, 'cache-control': out.__file.cache ?? 'no-store', ...(out.__file.inline && out.__file.body ? { 'content-length': String(out.__file.body.length) } : {}) });
        if (out.__file.stream) return out.__file.stream.pipe(res);
        return res.end(out.__file.body);
      }
      return json(res, route.status, r.user ? hideMoney(r.user.role, req.method, route.path, out) : out);
    } catch (e) {
      if (e instanceof HttpError) { res.dpError = e.message; return json(res, e.status, { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }); }
      console.error(e);
      return json(res, 500, { error: { code: 'server_error', message: 'Something went wrong on our side. Try again.' } });
    }
  });

  // Background jobs: see services/jobs.js for run history, owner alerts and the one-copy-at-a-time lease.
  const runner = ctx.jobs = createJobRunner(ctx);
  const HOUR = 3600e3;
  runner.define('webhooks', 15e3, () => deliverPending(ctx), { quiet: true });
  runner.define('team-billing', HOUR, () => runTeamBilling(ctx, { baseUrl: ctx.publicUrl }), { atStart: true });
  runner.define('hawkin-sync', 15 * 60e3, () => syncHawkin(ctx));
  if (dbFile !== ':memory:') {
    runner.define('daily-backup', HOUR, () => { const b = dailyBackup(ctx); if (!b) return { skipped: true }; console.log(`Backup saved: ${b.name}`); return { name: b.name, bytes: b.bytes }; }, { atStart: true });
    // Sends the newest backup off-site (when storage is set up) and reads it back; a failed send is a failed run.
    runner.define('offsite-backup', HOUR, async () => {
      const r = await sendBackupOffsite(ctx);
      if (!r) return { skipped: true };
      if (!r.ok) throw new Error(`Off-site backup failed: ${r.error}`);
      return r;
    }, { atStart: true });
  }
  runner.define('billing', HOUR, () => runBilling(ctx), { atStart: true });
  runner.define('extend-schedule', 6 * HOUR, () => extendSchedule(ctx), { atStart: true });
  runner.define('text-reminders', HOUR, () => sendReminders(ctx));
  runner.define('weekly-digest', HOUR, () => weeklyDigest(ctx));
  runner.define('lead-follow-ups', HOUR, () => runFollowUps(ctx));
  runner.define('review-requests', HOUR, () => runReviewRequests(ctx));
  runner.define('open-spots', HOUR, () => runSlotFilling(ctx));
  runner.define('money-checks', HOUR, () => runMoneyChecks(ctx));
  runner.define('wearable-sync', 6 * HOUR, () => syncWearables(ctx));
  runner.define('form-check-cleanup', 24 * HOUR, async () => ({ ...(await cleanupFormChecks(ctx)), sprint: await cleanupSprintClips(ctx), cues: await cleanupCues(ctx), push: cleanupPush(ctx) }));
  runner.define('monthly-reports', HOUR, () => runMonthly(ctx));
  runner.define('plan-adapt', HOUR, () => runAdapt(ctx));   // the adaptive plan: a missed week, misses in a row, two clean weeks (adapt.js)
  ctx.workoutToday = (clientId) => workoutToday(ctx, clientId);
  runner.define('push-reminders', HOUR, () => runPushReminders(ctx));   // the morning nudge on a day with a workout (push.js)
  runner.define('weekly-notes', HOUR, () => runWeekly(ctx));   // Monday: last week's coach's notes drafted (weekly.js)
  if (jobs) runner.start();
  server.on('close', () => { runner.stop(); ctx.db.close(); });
  return { server, ctx };
}

// How many proxies sit in front of the app: TRUST_PROXY=true means one (Render's), or give the number (2 with another in front).
const proxyHops = () => { const t = process.env.TRUST_PROXY ?? ''; return t === 'true' ? 1 : /^[1-9]$/.test(t) ? Number(t) : 0; };
// Behind a hosting proxy the real address is in X-Forwarded-For; only trust it when TRUST_PROXY is set. Each proxy adds the
// address it heard from at the end, so the client is that many entries from the end. Earlier entries are whatever the
// sender wrote and would let anyone dodge the rate limits.
function clientIp(req) {
  const hops = proxyHops();
  if (!hops) return req.socket.remoteAddress;
  const list = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return list[Math.max(0, list.length - hops)] || req.socket.remoteAddress;
}

function authenticate(ctx, req, route, r, url) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...rest]) => [k, decodeURIComponent(rest.join('='))]));
  r.sessionToken = cookies.dp_session;
  if (route.auth === 'public') return;
  // The portal cookie (or "Authorization: Bearer dp_fam_..."): a parent's session, an athlete's, or both when one
  // person is both. 'guardian' routes are the family's; 'portal' routes are for anyone signed in (session, password,
  // devices, sign out); 'client' routes (the athlete app) take the private link's token or an athlete's session.
  const sameSite = () => !req.headers.origin || req.headers.origin === `${url.protocol}//${url.host}`;
  if (route.auth === 'guardian' || route.auth === 'portal') {
    const bearerFam = (req.headers.authorization || '').match(/^Bearer\s+(dp_fam_.+)$/i)?.[1];
    r.familyToken = bearerFam || cookies.dp_family;
    r.who = whoForToken(ctx, r.familyToken);
    r.guardian = r.who?.guardian ?? null;
    if (!r.who) throw new HttpError(401, 'unauthenticated', 'Sign in with your email to continue.');
    if (route.auth === 'guardian' && !r.guardian) throw new HttpError(401, 'parents_only', 'This part of the portal is for parents. Your workouts are in the app.');
    if (!bearerFam && req.method !== 'GET' && !sameSite()) throw new HttpError(403, 'bad_origin', 'Requests from other sites are not allowed.');
    // A family whose membership payment keeps declining can only fix it (lockout.js).
    const lock = !r.guardian || OPEN_WHILE_LOCKED.has(`${route.method} ${route.path}`) ? null : familyLock(ctx, r.guardian.family_id);
    if (lock) { const e = new HttpError(402, 'payment_locked', lockMessage(lock)); e.details = { amount_cents: lock.amount_cents, invoice_ids: lock.invoices.map((i) => i.id) }; throw e; }
    return;
  }
  if (route.auth === 'client') {
    const linkToken = req.headers['x-client-token'] || url.searchParams.get('token');
    r.client = linkToken ? clientByToken(ctx, linkToken) : null;
    if (!r.client && cookies.dp_family) {                                  // signed in at /portal: as the athlete, or a parent opening one of the family's athletes
      const who = whoForToken(ctx, cookies.dp_family);
      const wanted = req.headers['x-athlete-id'] || url.searchParams.get('athlete');
      if (wanted && who?.guardian) {                                          // the family portal's Workout tab: the parent acts for their own athlete
        const a = ctx.db.get('SELECT * FROM clients WHERE id = ? AND family_id = ? AND archived_at IS NULL', String(wanted), who.guardian.family_id);
        if (!a) throw new HttpError(401, 'not_your_athlete', 'That athlete isn\'t in your family.');
        r.client = a; r.actingParent = who.guardian;
      } else r.client = who?.client ?? null;
      if (r.client && req.method !== 'GET' && !sameSite()) throw new HttpError(403, 'bad_origin', 'Requests from other sites are not allowed.');
      if (r.client) r.familyToken = cookies.dp_family;
    }
    if (!r.client) throw new HttpError(401, 'invalid_link', linkToken ? 'This app link is not valid. Ask your coach for a new one.' : 'Sign in with your email at /portal, or open the link your coach sent you.');
    // Locked out over a declined payment: only the app's home answers (and says why) until it's paid (lockout.js).
    if (route.path !== '/app/api/home' && clientLock(ctx, r.client.id)) throw new HttpError(402, 'payment_locked', athleteLockMessage);
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
  pathname = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;   // /parent/ is /parent: a slash typed on the end shouldn't 404
  const file = PAGES[pathname] ?? (/^\/invoice\/[\w-]+$/.test(pathname) ? 'invoice.html' : /^\/pay\/[\w-]+$/.test(pathname) ? 'pay.html' : /^\/here\/[\w-]+$/.test(pathname) ? 'here.html' : /^\/spot\/[\w-]+$/.test(pathname) ? 'spot.html' : /^\/receipt\/[\w-]+$/.test(pathname) ? 'receipt.html' : pathname.slice(1));
  const full = normalize(join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  try {
    if (!(await stat(full)).isFile()) throw new Error();
    const body = await readFile(full);
    const type = MIME[extname(full)] || 'application/octet-stream';
    // The Book now page is made to sit inside the business's own website, so any site may frame it. It only shows
    // public information and every button opens the parent portal in a new tab.
    // The athlete app (client.html) sits inside the family portal's Workout tab, so our own pages may frame it.
    const policy = file === 'book.html' ? csp().replace("frame-ancestors 'none'", 'frame-ancestors *') : file === 'client.html' ? csp().replace("frame-ancestors 'none'", "frame-ancestors 'self'") : csp();
    res.writeHead(200, { 'content-type': type, 'content-security-policy': policy, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': type.startsWith('text/html') ? 'no-store' : file.startsWith('vendor/') ? 'public, max-age=604800' : 'public, max-age=300' });   // vendor/: the pose model, large and versioned
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
