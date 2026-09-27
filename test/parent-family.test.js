// Parent portal Family tab: payments and receipts, retrying a declined charge, removing the card,
// account-change emails, parent details, duplicate athletes, waiver copies and signing out other devices.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `dp-parent-family-test-${process.pid}.db`);
process.env.DP_DB = DB_FILE;
delete process.env.DP_EMAIL_WEBHOOK;
delete process.env.STRIPE_SECRET_KEY;

const { get, all, run, insert, setting } = require('../server/db');
const seed = require('../server/seed');
const booking = require('../server/services/booking');
const { app } = require('../server/index');

let server, base;
test.before(async () => {
  seed.resetDatabase();
  seed.base();
  seed.demo();
  booking.generateEvents();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server?.close();
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch { /* gone */ } }
});

async function call(method, url, body, cookie) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, res };
}
// A fresh session each time (a parent can be signed in on several devices).
async function signIn(email) {
  const c = await call('POST', '/auth/parent/code', { email });
  const v = await call('POST', '/auth/parent/verify', { email, code: c.data.test_code });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return v.res.headers.get('set-cookie').split(';')[0];
}
const famOf = (email) => get('SELECT f.* FROM families f JOIN parents p ON p.family_id=f.id WHERE p.email=?', email);
const lastOutbox = () => get('SELECT COALESCE(MAX(id),0) n FROM outbox').n;
const outboxSince = (id) => all('SELECT * FROM outbox WHERE id>? ORDER BY id', id);
// A family of our own with a card and no membership, so tests don't step on each other.
let famSeq = 0;
function makeFamily({ card = true, waiver = false, parents = 1 } = {}) {
  famSeq++;
  const fid = insert('families', { name: `Test${famSeq} family`, ...(card ? { card_brand: 'Visa', card_last4: '4242', card_exp: '08/30' } : {}),
    ...(waiver ? { waiver_version: 1, waiver_signed_at: '2026-06-01', waiver_signed_by: 'Pat Test' } : {}) });
  const emails = [];
  for (let i = 0; i < parents; i++) {
    const email = `fam${famSeq}.p${i}@example.com`;
    insert('parents', { family_id: fid, name: `Parent${i} Test${famSeq}`, email, phone: '801-555-0100' });
    emails.push(email);
  }
  insert('athletes', { family_id: fid, first_name: 'Kid', last_name: `Test${famSeq}`, code: `KIDTST${famSeq}X`, workout_token: `tok-fam-${famSeq}-xxxxxx`, birthday: '2012-01-01' });
  return { fid, emails };
}
const KURT = 'kurt.jensen@example.com', LINH = 'linh.nguyen@example.com', GRACE = 'grace.park@example.com', MARIA = 'maria.lopez@example.com';

test('new family endpoints need a parent session', async () => {
  for (const [m, u] of [['GET', '/parent/account'], ['POST', '/parent/payments/1/retry'], ['DELETE', '/parent/card'], ['PUT', '/parent/parents/me'],
    ['POST', '/parent/waiver/copy'], ['POST', '/parent/sessions/others/end']]) {
    assert.equal((await call(m, u, m === 'GET' || m === 'DELETE' ? null : {})).status, 401, `${m} ${u}`);
  }
});

test('account lists only this family\'s payments, with receipts for paid ones and the year total', async () => {
  const kurt = await signIn(KURT);
  const r = await call('GET', '/parent/account', null, kurt);
  assert.equal(r.status, 200);
  const fam = famOf(KURT);
  const own = all("SELECT id FROM invoices WHERE family_id=? AND kind IN ('membership','charge') AND status IN ('paid','failed','open')", fam.id).map((x) => x.id);
  assert.equal(r.data.payments.length, own.length);
  assert.ok(r.data.payments.every((p) => own.includes(p.id)), 'no other family');
  const paid = r.data.payments.find((p) => p.status === 'paid');
  assert.equal(paid.receipt, get('SELECT view_token FROM invoices WHERE id=?', paid.id).view_token, 'receipt link for paid rows');
  const dates = r.data.payments.map((p) => p.date);
  assert.deepEqual([...dates].sort().reverse(), dates, 'newest first');
  const year = new Date().getFullYear();
  const expect = get(`SELECT COALESCE(SUM(amount_cents),0) n FROM invoices WHERE family_id=? AND status='paid' AND kind IN ('membership','charge') AND COALESCE(paid_at, issued_at)>=?`, fam.id, `${year}-01-01`).n;
  assert.equal(r.data.paid_this_year_cents, expect);
  assert.deepEqual(r.data.past_due, []);
  assert.match(r.data.card_remove_block, /membership is paid with this card/, 'a member family cannot remove the card');
});

test('a refund shows as money back, and a failed payment has no receipt', async () => {
  const { fid, emails } = makeFamily();
  insert('invoices', { number: 'DP-T-1', kind: 'charge', family_id: fid, description: 'Speed pack', amount_cents: 12000, status: 'paid', paid_at: new Date().toISOString(), view_token: 'tok-paid-1' });
  insert('invoices', { number: 'RF-T-1', kind: 'charge', family_id: fid, description: 'Refund: Speed pack', amount_cents: -12000, status: 'paid', paid_at: new Date().toISOString(), view_token: 'tok-ref-1' });
  insert('invoices', { number: 'DP-T-2', kind: 'charge', family_id: fid, description: 'Drop-in', amount_cents: 3000, status: 'failed', view_token: 'tok-fail-1' });
  insert('invoices', { number: 'DP-T-3', kind: 'charge', family_id: fid, description: 'Voided', amount_cents: 3000, status: 'void', view_token: 'tok-void-1' });
  const c = await signIn(emails[0]);
  const r = (await call('GET', '/parent/account', null, c)).data;
  assert.equal(r.payments.length, 3, 'void charges are left out');
  const refund = r.payments.find((p) => p.number === 'RF-T-1');
  assert.equal(refund.refund, true);
  const failed = r.payments.find((p) => p.number === 'DP-T-2');
  assert.equal(failed.receipt, null);
  assert.equal(failed.can_retry, false, 'only declined membership charges can be tried again');
  assert.equal(r.paid_this_year_cents, 0, 'net of refunds');
});

test('trying a declined membership charge again: paid on a good card, declined on a bad one, refused otherwise', async () => {
  // Grace's card works; her membership charge was declined earlier.
  const grace = await signIn(GRACE);
  const acct = (await call('GET', '/parent/account', null, grace)).data;
  assert.equal(acct.past_due.length, 1);
  const inv = acct.past_due[0];
  assert.ok(acct.payments.find((p) => p.id === inv.id).can_retry);
  assert.ok((await call('GET', '/parent/me', null, grace)).data.family.past_due_cents > 0);
  const ok = await call('POST', `/parent/payments/${inv.id}/retry`, {}, grace);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.paid, true);
  const row = get('SELECT * FROM invoices WHERE id=?', inv.id);
  assert.equal(row.status, 'paid');
  if (row.membership_id) assert.notEqual(get('SELECT status FROM memberships WHERE id=?', row.membership_id).status, 'past_due');
  assert.ok(get("SELECT 1 FROM activity WHERE action='Paid past-due charge' AND actor LIKE 'Grace%'"));
  assert.equal((await call('POST', `/parent/payments/${inv.id}/retry`, {}, grace)).status, 400, 'already paid');
  assert.equal((await call('GET', '/parent/me', null, grace)).data.family.past_due_cents, 0);

  // Linh's card declines: the charge stays failed and the attempt is counted.
  const linh = await signIn(LINH);
  const lf = (await call('GET', '/parent/account', null, linh)).data.past_due[0];
  const before = get('SELECT attempts FROM invoices WHERE id=?', lf.id).attempts;
  const no = await call('POST', `/parent/payments/${lf.id}/retry`, {}, linh);
  assert.equal(no.status, 200);
  assert.equal(no.data.paid, false);
  assert.equal(get('SELECT attempts FROM invoices WHERE id=?', lf.id).attempts, before + 1);
  assert.equal(get('SELECT status FROM invoices WHERE id=?', lf.id).status, 'failed');

  // Another family's charge answers 404.
  assert.equal((await call('POST', `/parent/payments/${lf.id}/retry`, {}, grace)).status, 404);
  // Too many attempts: the front desk takes it from there.
  run('UPDATE invoices SET attempts=8 WHERE id=?', lf.id);
  assert.equal((await call('POST', `/parent/payments/${lf.id}/retry`, {}, linh)).status, 400);
  run('UPDATE invoices SET attempts=? WHERE id=?', before + 1, lf.id);
  // An expired card is refused before charging.
  const lfam = famOf(LINH);
  run("UPDATE families SET card_exp='01/20' WHERE id=?", lfam.id);
  const exp = await call('POST', `/parent/payments/${lf.id}/retry`, {}, linh);
  assert.equal(exp.status, 400);
  assert.match(exp.data.error, /expired/);
  run("UPDATE families SET card_exp='08/29' WHERE id=?", lfam.id);
  // A declined drop-in (not a membership) is for the front desk.
  const { fid, emails } = makeFamily();
  const drop = insert('invoices', { number: 'DP-T-9', kind: 'charge', family_id: fid, description: 'Drop-in', amount_cents: 3000, status: 'failed', attempts: 1, view_token: 'tok-drop-9' });
  assert.equal((await call('POST', `/parent/payments/${drop}/retry`, {}, await signIn(emails[0]))).status, 400);
});

test('removing the card: refused while a membership uses it, works otherwise and tells the other parent', async () => {
  const kurt = await signIn(KURT);
  const refused = await call('DELETE', '/parent/card', null, kurt);
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /membership/);
  assert.ok(famOf(KURT).card_last4, 'card kept');

  const { fid, emails } = makeFamily({ parents: 2 });
  const c = await signIn(emails[0]);
  const mark = lastOutbox();
  const r = await call('DELETE', '/parent/card', null, c);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = get('SELECT * FROM families WHERE id=?', fid);
  assert.equal(f.card_last4, null);
  assert.equal(f.card_brand, null);
  assert.ok(get("SELECT 1 FROM activity WHERE action='Removed card' AND detail='Visa ending 4242'"));
  const mail = outboxSince(mark);
  assert.ok(mail.some((m) => m.to_email === emails[1] && /Card removed/.test(m.subject)), 'the other parent hears about it');
  assert.ok(!mail.some((m) => m.to_email === emails[0]), 'not the parent who did it');
  assert.equal((await call('DELETE', '/parent/card', null, c)).status, 400, 'no card left');

  // A past-due charge also keeps the card on file.
  const two = makeFamily();
  insert('invoices', { number: 'DP-T-20', kind: 'membership', family_id: two.fid, description: 'Membership', amount_cents: 18900, status: 'failed', attempts: 1, view_token: 'tok-due-20' });
  const r2 = await call('DELETE', '/parent/card', null, await signIn(two.emails[0]));
  assert.equal(r2.status, 400);
  assert.match(r2.data.error, /past-due/);
});

test('changing the card emails the other parents, not the one who changed it', async () => {
  const { emails } = makeFamily({ parents: 2 });
  const c = await signIn(emails[0]);
  const mark = lastOutbox();
  const r = await call('PUT', '/parent/card', { number: '4242 4242 4242 4242', exp: '10/31', cvc: '123', zip: '84604' }, c);
  assert.equal(r.status, 200);
  const mail = outboxSince(mark);
  const m = mail.find((x) => x.to_email === emails[1]);
  assert.ok(m && /Card on file changed/.test(m.subject) && /Visa ending 4242/.test(m.body), 'the other parent is told');
  assert.ok(!/4242 4242 4242 4242|4242424242424242/.test(m.body), 'never the full number');
  assert.ok(!mail.some((x) => x.to_email === emails[0]));
});

test('adding a parent: checks, a limit of six, and the other parents are told', async () => {
  const { fid, emails } = makeFamily({ parents: 2 });
  const c = await signIn(emails[0]);
  assert.equal((await call('POST', '/parent/parents', { name: 'New Person', email: 'new.person.fam@example.com', phone: '12' }, c)).status, 400, 'bad phone');
  const same = await call('POST', '/parent/parents', { name: 'Dup', email: emails[1] }, c);
  assert.equal(same.status, 400);
  assert.match(same.data.error, /already on your account/);
  const other = await call('POST', '/parent/parents', { name: 'Dup', email: MARIA }, c);
  assert.equal(other.status, 400);
  assert.match(other.data.error, /Ask your coach/);
  assert.equal((await call('POST', '/parent/parents', { name: 'x'.repeat(81), email: 'long.name.fam@example.com' }, c)).status, 400, 'long name');
  const mark = lastOutbox();
  const ok = await call('POST', '/parent/parents', { name: 'Sam Test', email: 'sam.test.fam@example.com', phone: '(801) 555-0199' }, c);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const mail = outboxSince(mark);
  assert.ok(mail.some((m) => m.to_email === 'sam.test.fam@example.com'), 'the new parent gets sign-in help');
  assert.ok(mail.some((m) => m.to_email === emails[1] && /Sam Test was added/.test(m.subject)), 'the other parent is told');
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/parent/parents', { name: `Extra ${i}`, email: `extra${i}.fam@example.com` }, c)).status, 200);
  assert.equal(get('SELECT COUNT(*) n FROM parents WHERE family_id=?', fid).n, 6);
  const full = await call('POST', '/parent/parents', { name: 'Seventh', email: 'seventh.fam@example.com' }, c);
  assert.equal(full.status, 400);
  assert.match(full.data.error, /most parents/);
});

test('a parent can change their own name and phone, not their email', async () => {
  const { emails } = makeFamily();
  const c = await signIn(emails[0]);
  assert.equal((await call('PUT', '/parent/parents/me', { name: '' }, c)).status, 400);
  assert.equal((await call('PUT', '/parent/parents/me', { name: 'Pat', phone: 'call me' }, c)).status, 400);
  const r = await call('PUT', '/parent/parents/me', { name: '  Pat   Newname ', phone: '801-555-0123', email: 'hijack@example.com' }, c);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = get('SELECT * FROM parents WHERE email=?', emails[0]);
  assert.equal(p.name, 'Pat Newname');
  assert.equal(p.phone, '801-555-0123');
  assert.ok(!get("SELECT 1 FROM parents WHERE email='hijack@example.com'"));
  assert.ok(get("SELECT 1 FROM activity WHERE action='Updated parent details' AND detail LIKE 'Pat Newname%'"));
  const cleared = await call('PUT', '/parent/parents/me', { name: 'Pat Newname', phone: '' }, c);
  assert.equal(cleared.data.phone, null);
});

test('athletes: no duplicate names in one family, and a real emergency phone', async () => {
  const kurt = await signIn(KURT);
  const dup = await call('POST', '/parent/athletes', { first_name: 'emma', last_name: 'JENSEN' }, kurt);
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /already on your account/);
  const nate = get("SELECT id FROM athletes WHERE first_name='Nate' AND last_name='Jensen'");
  assert.equal((await call('PUT', `/parent/athletes/${nate.id}`, { emergency_phone: '555' }, kurt)).status, 400);
  assert.equal((await call('PUT', `/parent/athletes/${nate.id}`, { emergency_phone: '+1 (385) 555-0110' }, kurt)).status, 200);
  assert.equal((await call('PUT', `/parent/athletes/${nate.id}`, { emergency_phone: '' }, kurt)).status, 200, 'clearing is allowed');
  // The same name in another family is fine.
  const { emails } = makeFamily();
  assert.equal((await call('POST', '/parent/athletes', { first_name: 'Emma', last_name: 'Jensen' }, await signIn(emails[0]))).status, 200);
});

test('waiver copy: only once signed, emailed to the parent asking, a few an hour', async () => {
  const unsigned = makeFamily();
  const u = await signIn(unsigned.emails[0]);
  assert.equal((await call('POST', '/parent/waiver/copy', {}, u)).status, 400);

  const signed = makeFamily({ waiver: true, parents: 2 });
  const c = await signIn(signed.emails[0]);
  const mark = lastOutbox();
  const r = await call('POST', '/parent/waiver/copy', {}, c);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.email, signed.emails[0]);
  const mail = outboxSince(mark);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to_email, signed.emails[0]);
  assert.match(mail[0].body, /signed by Pat Test on June 1, 2026/);
  const text = setting('waiver_text', '');
  assert.ok(text.length > 40 && mail[0].body.includes(text.slice(0, 40)), 'the waiver text');
  assert.equal((await call('POST', '/parent/waiver/copy', {}, c)).status, 200);
  assert.equal((await call('POST', '/parent/waiver/copy', {}, c)).status, 200);
  assert.equal((await call('POST', '/parent/waiver/copy', {}, c)).status, 400, 'three an hour');
});

test('sign out everywhere else keeps this session and ends the others', async () => {
  const { emails } = makeFamily();
  const phone = await signIn(emails[0]);
  const laptop = await signIn(emails[0]);
  const here = await signIn(emails[0]);
  assert.equal((await call('GET', '/parent/account', null, here)).data.other_sessions, 2);
  const r = await call('POST', '/parent/sessions/others/end', {}, here);
  assert.equal(r.status, 200);
  assert.equal(r.data.ended, 2);
  assert.equal((await call('GET', '/parent/me', null, phone)).status, 401);
  assert.equal((await call('GET', '/parent/me', null, laptop)).status, 401);
  assert.equal((await call('GET', '/parent/me', null, here)).status, 200);
  assert.equal((await call('GET', '/parent/account', null, here)).data.other_sessions, 0);
  assert.ok(get("SELECT 1 FROM activity WHERE action='Signed out other devices'"));
});

// ---- review fixes ----
test('review: a new card retries every past-due membership charge, even one tried four or more times', async () => {
  const { fid, emails } = makeFamily({ card: false });
  const inv = insert('invoices', { number: 'DP-RV-1', kind: 'membership', family_id: fid, description: 'Membership', amount_cents: 18900, status: 'failed', attempts: 5, view_token: 'tok-rv-1' });
  const c = await signIn(emails[0]);
  assert.equal((await call('GET', '/parent/me', null, c)).data.family.past_due_cents, 18900);
  const r = await call('PUT', '/parent/card', { number: '4242424242424242', exp: '10/31', cvc: '123', zip: '84604' }, c);
  assert.equal(r.status, 200);
  assert.equal(r.data.paid, 1);
  assert.equal(get('SELECT status FROM invoices WHERE id=?', inv).status, 'paid');
  assert.equal((await call('GET', '/parent/me', null, c)).data.family.past_due_cents, 0);
});

test('review: a past-due charge tried too often says so, so the portal hides Try again', async () => {
  const { fid, emails } = makeFamily();
  insert('invoices', { number: 'DP-RV-2', kind: 'membership', family_id: fid, description: 'Membership', amount_cents: 18900, status: 'failed', attempts: 8, view_token: 'tok-rv-2' });
  insert('invoices', { number: 'DP-RV-3', kind: 'membership', family_id: fid, description: 'Membership', amount_cents: 18900, status: 'failed', attempts: 2, view_token: 'tok-rv-3' });
  const acct = (await call('GET', '/parent/account', null, await signIn(emails[0]))).data;
  assert.deepEqual(acct.past_due.map((p) => p.can_retry), [false, true]);
});

test('review: payment dates and the year total follow the business time zone, not UTC', async () => {
  const { localDay, paidThisYear, familyPayments } = require('../server/services/parent-card');
  assert.equal(localDay('2026-09-27T03:30:00.000Z'), '2026-09-26', 'an evening payment in Provo');
  assert.equal(localDay('2026-09-27 03:30:00'), '2026-09-26', 'SQLite UTC timestamps too');
  assert.equal(localDay('2026-09-27'), '2026-09-27', 'plain dates stay as they are');
  assert.equal(localDay(null), null);
  const { fid } = makeFamily();
  insert('invoices', { number: 'DP-RV-4', kind: 'charge', family_id: fid, description: 'Pack', amount_cents: 5000, status: 'paid', paid_at: '2026-01-01T04:00:00.000Z', view_token: 'tok-rv-4' });
  insert('invoices', { number: 'DP-RV-5', kind: 'charge', family_id: fid, description: 'Pack', amount_cents: 7000, status: 'paid', paid_at: '2026-01-01T09:00:00.000Z', view_token: 'tok-rv-5' });
  assert.equal(paidThisYear(fid, 2026), 7000, 'New Year\'s Eve in Provo belongs to last year');
  assert.equal(paidThisYear(fid, 2025), 5000);
  const rows = familyPayments(fid).items;
  assert.equal(rows.find((p) => p.number === 'DP-RV-4').date, '2025-12-31');
});

test('review: the waiver copy dates the signature in the business time zone', async () => {
  const { fid, emails } = makeFamily({ waiver: true });
  run("UPDATE families SET waiver_signed_at='2026-06-02T03:15:00.000Z' WHERE id=?", fid);
  const c = await signIn(emails[0]);
  const mark = lastOutbox();
  assert.equal((await call('POST', '/parent/waiver/copy', {}, c)).status, 200);
  assert.match(outboxSince(mark)[0].body, /signed by Pat Test on June 1, 2026/);
});

test('review: renaming an athlete to a brother or sister\'s name is refused, in their saved spelling', async () => {
  const { fid, emails } = makeFamily();
  const c = await signIn(emails[0]);
  const kid = get('SELECT * FROM athletes WHERE family_id=?', fid);
  const sib = await call('POST', '/parent/athletes', { first_name: 'Jo', last_name: 'Smith' }, c);
  assert.equal(sib.status, 200);
  const dup = await call('POST', '/parent/athletes', { first_name: 'jo', last_name: 'SMITH' }, c);
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /^Jo Smith is already/);
  const ren = await call('PUT', `/parent/athletes/${kid.id}`, { first_name: 'JO', last_name: 'smith' }, c);
  assert.equal(ren.status, 400);
  assert.match(ren.data.error, /^Jo Smith is already/);
  assert.equal((await call('PUT', `/parent/athletes/${sib.data.id}`, { first_name: 'Jo', last_name: 'Smith', school: 'Provo High' }, c)).status, 200, 'saving yourself is fine');
});
