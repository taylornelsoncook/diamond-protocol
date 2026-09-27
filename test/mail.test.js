import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { createFamilyWithGuardian } from '../src/services/families.js';
import { sendEmail, mailMode } from '../src/services/mail.js';

// Email on a staging copy: only allowed addresses are really sent; demo parents still see their code.
let app, base, fake;
const received = [];
before(async () => {
  fake = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"em_1"}'); }); });
  await new Promise((r) => fake.listen(0, r));
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://staging.example.org',
    mail: { resendKey: '“re_test_123​”', from: 'Diamond Protocol <hello@example.org>', onlyTo: 'coach@example.org, @mygym.test', resendUrl: `http://127.0.0.1:${fake.address().port}/emails` } });
  createFamilyWithGuardian(app.ctx, { name: 'Maria Lopez', email: 'maria@example.com' }, 'Lopez');
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => { app.server.close(); fake.close(); });

test('a demo parent outside the allowed list gets the code on screen, and nothing is sent', async () => {
  const res = await fetch(base + '/portal/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maria@example.com' }) });
  assert.equal(res.status, 200);
  assert.match((await res.json()).dev_code, /^\d{6}$/);
  assert.equal(received.length, 0);
  const row = app.ctx.db.get("SELECT * FROM outbox WHERE to_email = 'maria@example.com'");
  assert.equal(row.status, 'logged');
  assert.match(row.error, /^Held:/);
  assert.equal(mailMode(app.ctx), 'restricted');
});

test('allowed addresses are sent as branded HTML with a cleaned-up key', async () => {
  const out = await sendEmail(app.ctx, { to: 'desk@mygym.test', subject: 'Hello', text: 'Your code is 123456.\n\nSee https://staging.example.org' });
  assert.equal(out.status, 'sent');
  const m = received.at(-1);
  assert.equal(m.auth, 'Bearer re_test_123');
  assert.match(m.body.html, /brand\/logo\.png/);
  assert.match(m.body.html, /123456/);
  assert.equal(m.body.text.includes('Your code is 123456.'), true);
});
