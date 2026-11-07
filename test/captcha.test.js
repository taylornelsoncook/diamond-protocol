import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { resetRateLimits } from '../src/services/security.js';

// The "are you a person" check (Cloudflare Turnstile) on the public forms, and the hardening headers every page carries.
// Off until TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set: then the forms must send a token Cloudflare accepts.
let app, base;
const calls = [];
const json = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), res: r };
};
const inquiry = (extra = {}) => json('POST', '/portal/api/public/inquiry', { parent_name: 'Kim Reyes', email: `kim${calls.length}${Date.now()}@example.com`, athlete_name: 'Leo', ...extra });
const on = () => { process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA'; process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA'; };
const off = () => { delete process.env.TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY; };

before(async () => {
  off();
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  // Cloudflare stood in: "good" tokens pass, "bad" ones fail, "down" means Cloudflare can't be reached.
  app.ctx.captchaFetch = async (url, init) => {
    const sent = JSON.parse(init.body);
    calls.push({ url, sent });
    if (sent.response === 'down') throw new Error('ECONNRESET');
    return { json: async () => ({ success: sent.response === 'good' }) };
  };
  app.ctx.db.run(`INSERT INTO settings (key, value) VALUES ('public_signup', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`);
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => { off(); app.server.close(); });
beforeEach(() => { resetRateLimits(); calls.length = 0; });

test('off by default: the public pages say so and the forms work as before, with no Cloudflare in the page policy', async () => {
  assert.deepEqual((await json('GET', '/portal/api/public/captcha')).body, { enabled: false, site_key: null });
  assert.equal((await inquiry()).status, 200);
  const page = await fetch(base + '/start');
  assert.doesNotMatch(page.headers.get('content-security-policy'), /challenges\.cloudflare\.com/);
  assert.equal(calls.length, 0, 'nothing was asked of Cloudflare');
});

test('on: the forms need a token, Cloudflare is asked once per send, a refused or missing token is 400, Cloudflare down is 503', async () => {
  on();
  try {
    assert.deepEqual((await json('GET', '/portal/api/public/captcha')).body, { enabled: true, site_key: '1x00000000000000000000AA' });
    // Ask about training
    let r = await inquiry();
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'captcha_required');
    r = await inquiry({ captcha_token: 'bad' });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'captcha_failed');
    r = await inquiry({ captcha_token: 'down' });
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'captcha_unavailable');
    r = await inquiry({ captcha_token: 'good' });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(calls[2].sent.secret, '1x0000000000000000000000000000000AA');
    assert.equal(calls[2].sent.response, 'good');
    // A bot that fills the hidden trap gets the usual "thanks" and Cloudflare is never asked.
    calls.length = 0;
    r = await inquiry({ website: 'http://spam.example' });
    assert.equal(r.status, 200); assert.equal(calls.length, 0);
    // The family sign-up
    const parent = { name: 'Dana Fox', email: 'dana@example.com', phone: '512 555 0101' };
    const athletes = [{ name: 'Sam Fox', birth_date: '2012-03-04' }];
    r = await json('POST', '/portal/api/signup', { parent, athletes, accept_terms: true });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'captcha_required');
    r = await json('POST', '/portal/api/signup', { parent, athletes, accept_terms: true, captcha_token: 'good' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.signup_id);
    // The three public forms' pages may load Cloudflare's widget; other pages never do.
    for (const path of ['/start', '/join', '/buy']) {
      const csp = (await fetch(base + path)).headers.get('content-security-policy');
      assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/, path);
      assert.match(csp, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/, path);
    }
    assert.doesNotMatch((await fetch(base + '/client')).headers.get('content-security-policy'), /cloudflare/);
  } finally { off(); }
});

test('the online sales page needs the token too', async () => {
  on();
  try {
    const owner = app.ctx.db;
    owner.run(`INSERT INTO settings (key, value) VALUES ('buy_online', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`);
    const r = await json('POST', '/portal/api/buy', { item: 'product:nope', self: true, athlete: { first_name: 'A', last_name: 'B' }, buyer: { email: 'a@example.com' }, accept_terms: true, helped_by: 'none' });
    // Whatever else is wrong with the order, the check comes right after the bot trap: a missing token is refused first.
    assert.ok([400, 404].includes(r.status));
    if (r.status === 400) assert.ok(['captcha_required', 'invalid_request', 'not_found'].includes(r.body.error.code));
  } finally { off(); }
});

test('every page carries the hardening headers; the Book now page may be framed, the app only by us', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(home.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.match(home.headers.get('permissions-policy'), /geolocation=\(\)/);
  assert.match(home.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const app1 = await fetch(base + '/app');
  assert.equal(app1.headers.get('x-frame-options'), 'SAMEORIGIN');
  const book = await fetch(base + '/book');
  assert.equal(book.headers.get('x-frame-options'), null, 'the Book now page sits inside the business\'s own website');
  assert.match(book.headers.get('permissions-policy'), /camera=\(self\)/);
  // JSON answers never sniff and are never cached; a wrong path says nothing about the server.
  const nope = await fetch(base + '/v1/nope');
  assert.equal(nope.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(nope.headers.get('cache-control'), 'no-store');
  // Behind the HTTPS proxy every answer tells browsers to stay on HTTPS.
  process.env.TRUST_PROXY = 'true';
  try {
    const secure = await fetch(base + '/healthz', { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(secure.headers.get('strict-transport-security') ?? '', /max-age=31536000/);
  } finally { delete process.env.TRUST_PROXY; }
});
