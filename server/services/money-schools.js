// School and club contracts: monthly invoices, emails, payments and overdue reminders.
'use strict';
const { db, get, all, run, insert, update, tx, setting } = require('../db');
const { nextInvoiceNumber, sendEmail, emit, today, addDays, addMonths, money, businessName, appUrl, randomToken, bad } = require('../lib');

const REMIND_EVERY_DAYS = 7;

// Added after launch: school or club type and phone, the contract's billing phone and internal notes, and
// bill_from (no invoices for months before it: set when a contract restarts or when months were billed elsewhere).
// Idempotent, so an existing database upgrades in place on start.
const schoolCols = all('PRAGMA table_info(schools)').map((c) => c.name);
if (!schoolCols.includes('kind')) db.exec("ALTER TABLE schools ADD COLUMN kind TEXT DEFAULT 'school'");
if (!schoolCols.includes('contact_phone')) db.exec('ALTER TABLE schools ADD COLUMN contact_phone TEXT');
const contractCols = all('PRAGMA table_info(team_contracts)').map((c) => c.name);
if (!contractCols.includes('billing_phone')) db.exec('ALTER TABLE team_contracts ADD COLUMN billing_phone TEXT');
if (!contractCols.includes('notes')) db.exec('ALTER TABLE team_contracts ADD COLUMN notes TEXT');
if (!contractCols.includes('bill_from')) db.exec('ALTER TABLE team_contracts ADD COLUMN bill_from TEXT');

const fmtLong = (d) => (d ? new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

function contractWithSchool(id) {
  return get(`SELECT t.*, s.name AS school_name, s.kind AS school_kind, s.contact_name, s.contact_email, s.contact_phone, s.address AS school_address
    FROM team_contracts t JOIN schools s ON s.id=t.school_id WHERE t.id=?`, id);
}
const billTo = (c) => c.billing_email || c.contact_email || null;
const invoiceUrl = (inv) => `${appUrl()}/invoice/${inv.view_token}`;

// The billing period that starts on `start` runs for one month, ending the day before the next one.
const periodEnd = (start) => addDays(addMonths(start, 1), -1);
// Period starts for a contract: its start date plus whole months (billing day = start day, clamped to month end).
function periodStarts(c, asOf) {
  const out = [];
  for (let k = 0; k < 240; k++) {
    const p = addMonths(c.start_date, k);
    if (p > asOf) break;
    if (c.end_date && p > c.end_date) break;
    if (c.bill_from && p < c.bill_from) continue;
    out.push(p);
  }
  return out;
}
function nextInvoiceDate(c, asOf = today()) {
  if (c.status !== 'active') return null;
  for (let k = 0; k < 240; k++) {
    const p = addMonths(c.start_date, k);
    if (c.end_date && p > c.end_date) return null;
    if (p > asOf && !(c.bill_from && p < c.bill_from)) return p;
  }
  return null;
}

function emailInvoice(invoiceId, { reminder = false } = {}) {
  const inv = get('SELECT * FROM invoices WHERE id=?', invoiceId);
  if (!inv) throw bad("That invoice wasn't found.");
  const c = inv.contract_id ? contractWithSchool(inv.contract_id) : null;
  const to = c ? billTo(c) : inv.family_id ? get('SELECT email FROM parents WHERE family_id=? ORDER BY is_self DESC, id LIMIT 1', inv.family_id)?.email : null;
  if (!to) throw bad('Add a billing email to the contract first.');
  const who = c ? (c.billing_name || c.contact_name || c.school_name) : 'there';
  const subject = reminder
    ? `Reminder: invoice ${inv.number} was due ${fmtLong(inv.due_date)}`
    : `Invoice ${inv.number} from ${businessName()}: ${money(inv.amount_cents)}`;
  const body = `Hi ${String(who).split(' ')[0]},\n\n` +
    (reminder ? `Invoice ${inv.number} for ${money(inv.amount_cents)} was due on ${fmtLong(inv.due_date)} and is still open.` : `Here is invoice ${inv.number} for ${money(inv.amount_cents)}${inv.due_date ? `, due ${fmtLong(inv.due_date)}` : ''}.`) +
    `\n\n${inv.description || ''}\n\nView, print or pay online:\n${invoiceUrl(inv)}\n\n${setting('pay_instructions', '') || ''}\n\nThank you,\n${businessName()}`;
  sendEmail(to, subject, body);
  return to;
}

// When the invoice email last went out (from the outbox).
function emailedAt(inv) {
  if (!inv.view_token) return null;
  return get("SELECT created_at FROM outbox WHERE body LIKE ? ORDER BY id DESC LIMIT 1", `%/invoice/${inv.view_token}%`)?.created_at || null;
}

function createSchoolInvoice(c, { periodStart = null, description, amount_cents, issued = today(), email = true }) {
  if (!(amount_cents > 0)) throw bad('Enter an amount above zero.');
  const id = insert('invoices', {
    number: nextInvoiceNumber('DP'), kind: 'school', contract_id: c.id, description, amount_cents, status: 'open',
    issued_at: issued, due_date: addDays(issued, Number(c.terms_days ?? 30)), period: periodStart, view_token: randomToken(16),
  });
  if (email && billTo(c)) emailInvoice(id);
  return id;
}

// Invoice every month that has started and isn't invoiced yet (catches up if the job missed a day).
function invoiceContract(contractId, asOf = today()) {
  const c = contractWithSchool(contractId);
  if (!c || c.status !== 'active') return [];
  const made = [];
  for (const p of periodStarts(c, asOf)) {
    if (get("SELECT 1 FROM invoices WHERE contract_id=? AND kind='school' AND period=?", c.id, p)) continue;
    made.push(tx(() => createSchoolInvoice(c, { periodStart: p, amount_cents: c.monthly_cents, description: `${c.team_name} training, ${fmtLong(p)} – ${fmtLong(periodEnd(p))}` })));
  }
  return made;
}

// Job: monthly school invoicing. Contracts past their end date are closed.
function runSchoolInvoicing(asOf = today()) {
  let n = 0;
  for (const c of all("SELECT id, end_date FROM team_contracts WHERE status='active'")) {
    n += invoiceContract(c.id, asOf).length;
    if (c.end_date && c.end_date < asOf) update('team_contracts', c.id, { status: 'ended' });
  }
  return n;
}

// Job: weekly reminder for open school invoices past their due date.
function sendOverdueReminders(asOf = today()) {
  const list = all(`SELECT * FROM invoices WHERE kind='school' AND status='open' AND due_date < ? AND (last_reminder IS NULL OR last_reminder <= ?)`, asOf, addDays(asOf, -REMIND_EVERY_DAYS));
  let sent = 0;
  for (const inv of list) {
    try { emailInvoice(inv.id, { reminder: true }); sent++; } catch { /* no billing email */ }
    update('invoices', inv.id, { last_reminder: asOf });
  }
  return sent;
}

function markPaid(invoiceId, { method, check_number = null, paid_on = null, charge_id = null }) {
  const inv = get('SELECT * FROM invoices WHERE id=?', invoiceId);
  if (!inv) throw bad("That invoice wasn't found.");
  if (inv.status === 'paid') throw bad('That invoice is already paid.');
  if (inv.status === 'void') throw bad('That invoice was voided.');
  if (!['check', 'cash', 'ach', 'card', 'other'].includes(method)) throw bad('Choose how it was paid.');
  if (method === 'check' && !String(check_number || '').trim()) throw bad('Enter the check number.');
  if (paid_on && (!/^\d{4}-\d{2}-\d{2}$/.test(String(paid_on)) || Number.isNaN(Date.parse(paid_on + 'T12:00:00')))) throw bad('Choose the date the payment arrived.');
  if (paid_on && paid_on > addDays(today(), 1)) throw bad('The payment date can\'t be in the future.');
  update('invoices', inv.id, {
    status: 'paid', pay_method: method, check_number: method === 'check' ? String(check_number).trim() : null,
    paid_at: paid_on ? new Date(paid_on + 'T12:00:00').toISOString() : new Date().toISOString(), charge_id, next_retry: null,
  });
  if (inv.membership_id) run("UPDATE memberships SET status='active' WHERE id=? AND status='past_due'", inv.membership_id);
  emit('invoice.paid', { invoice_id: inv.id, number: inv.number, amount_cents: inv.amount_cents, method, contract_id: inv.contract_id });
  return get('SELECT * FROM invoices WHERE id=?', inv.id);
}

// A statement of everything the school owes on one contract: each open invoice with its link, and the total.
function emailStatement(contractId) {
  const c = contractWithSchool(contractId);
  if (!c) throw bad("That contract wasn't found.");
  const to = billTo(c);
  if (!to) throw bad('Add a billing email to the contract first.');
  const open = all("SELECT * FROM invoices WHERE contract_id=? AND status='open' ORDER BY due_date, id", c.id);
  if (!open.length) throw bad('Nothing is unpaid on this contract, so there is no statement to send.');
  const total = open.reduce((s, i) => s + i.amount_cents, 0);
  const T = today();
  const lines = open.map((i) => `${i.number}  ${money(i.amount_cents)}  ${i.due_date ? `${i.due_date < T ? 'was due' : 'due'} ${fmtLong(i.due_date)}` : ''}\n${i.description || ''}\n${invoiceUrl(i)}`).join('\n\n');
  const who = String(c.billing_name || c.contact_name || c.school_name).split(' ')[0];
  sendEmail(to, `Statement from ${businessName()}: ${money(total)} open for ${c.team_name}`,
    `Hi ${who},\n\nHere is where the ${c.team_name} account stands. ${open.length === 1 ? 'One invoice is' : `${open.length} invoices are`} open, ${money(total)} in all.\n\n${lines}\n\nEach link lets you view, print or pay that invoice online.\n\n${setting('pay_instructions', '') || ''}\n\nThank you,\n${businessName()}`);
  return { to, count: open.length, total_cents: total };
}

// Owner's "Email reminders now": every overdue school invoice with a billing email, whatever the weekly timer says.
function remindOverdueNow(asOf = today()) {
  const list = all("SELECT * FROM invoices WHERE kind='school' AND status='open' AND due_date < ? ORDER BY due_date, id", asOf);
  let sent = 0, skipped = 0;
  for (const inv of list) {
    try { emailInvoice(inv.id, { reminder: true }); sent++; update('invoices', inv.id, { last_reminder: asOf }); } catch { skipped++; }
  }
  return { sent, skipped };
}

function voidInvoice(invoiceId) {
  const inv = get('SELECT * FROM invoices WHERE id=?', invoiceId);
  if (!inv) throw bad("That invoice wasn't found.");
  if (inv.status === 'paid') throw bad('Paid invoices can\'t be voided. Refund it instead.');
  if (inv.status === 'void') throw bad('That invoice is already void.');
  update('invoices', inv.id, { status: 'void', next_retry: null });
  return inv;
}

module.exports = { contractWithSchool, periodStarts, periodEnd, nextInvoiceDate, emailInvoice, emailedAt, createSchoolInvoice, invoiceContract, runSchoolInvoicing, sendOverdueReminders, markPaid, voidInvoice, fmtLong, billTo, emailStatement, remindOverdueNow };
