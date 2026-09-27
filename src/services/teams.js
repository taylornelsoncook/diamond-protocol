import { newId, token, v, notFound, badRequest, conflict, isDate, addDaysToDate, localDate, startOfLocalDay } from '../util.js';
import { emit } from './events.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';
import { newAthleteId } from './athlete-ids.js';

// Schools and clubs pay a flat monthly fee per team. Each month is invoiced in advance on the
// anniversary of the start date and is due on the contract's terms (Net 30 by default).
const ORG_KINDS = ['school', 'club', 'other'];
const PAY_METHODS = ['check', 'ach', 'card', 'cash', 'online', 'other'];
const today = (ctx) => localDate(ctx.now(), getSetting(ctx, 'timezone'));
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// Month k of a contract starting 2026-01-31: Jan 31, Feb 28, Mar 31 … (anchored to the start day, no drift)
export function periodStart(startDate, k) {
  const [y, m, d] = startDate.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

// ---------- Organizations ----------
function orgInput(body, cur = {}) {
  const pick = (k, fn) => (body[k] !== undefined ? fn(body[k]) : cur[k] ?? null);
  return {
    name: pick('name', (x) => v.str(x, 'organization name', { max: 120 })),
    kind: pick('kind', (x) => v.oneOf(x, 'kind', ORG_KINDS)) ?? 'school',
    contact_name: pick('contact_name', (x) => v.str(x, 'contact_name', { max: 120, optional: true })),
    contact_email: pick('contact_email', (x) => (x ? v.email(x, 'contact_email') : null)),
    contact_phone: pick('contact_phone', (x) => v.str(x, 'contact_phone', { max: 40, optional: true })),
    billing_address: pick('billing_address', (x) => v.str(x, 'billing_address', { max: 400, optional: true })),
    notes: pick('notes', (x) => v.str(x, 'notes', { max: 2000, optional: true }))
  };
}
export function createOrg(ctx, body) {
  const o = orgInput(body);
  const id = newId('org');
  ctx.db.run('INSERT INTO organizations (id, name, kind, contact_name, contact_email, contact_phone, billing_address, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, o.name, o.kind, o.contact_name, o.contact_email, o.contact_phone, o.billing_address, o.notes, ctx.now());
  return getOrg(ctx, id);
}
export function getOrg(ctx, id) {
  const o = ctx.db.get('SELECT * FROM organizations WHERE id = ?', id);
  if (!o) throw notFound('Organization');
  return o;
}
export function listOrgs(ctx) { return ctx.db.all('SELECT * FROM organizations ORDER BY name'); }
export function updateOrg(ctx, id, body) {
  const o = orgInput(body, getOrg(ctx, id));
  ctx.db.run('UPDATE organizations SET name = ?, kind = ?, contact_name = ?, contact_email = ?, contact_phone = ?, billing_address = ?, notes = ? WHERE id = ?',
    o.name, o.kind, o.contact_name, o.contact_email, o.contact_phone, o.billing_address, o.notes, id);
  return getOrg(ctx, id);
}

// ---------- Contracts ----------
export async function createContract(ctx, body, baseUrl) {
  const orgId = body.org_id ? getOrg(ctx, body.org_id).id : createOrg(ctx, body.organization ?? {}).id;
  const start = body.start_date ?? today(ctx);
  if (!isDate(start)) throw badRequest('start_date must look like 2026-10-01.');
  const end = body.end_date || null;
  if (end && (!isDate(end) || end < start)) throw badRequest('end_date must be a date after start_date.');
  const id = newId('tc');
  ctx.db.run(`INSERT INTO team_contracts (id, org_id, name, monthly_cents, start_date, end_date, terms_days, po_number, status, next_period_start, notes, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    id, orgId, v.str(body.name, 'team name', { max: 120 }), v.int(body.monthly_cents, 'monthly_cents', { min: 0, max: 100000000 }), start, end,
    v.int(body.terms_days ?? 30, 'terms_days', { min: 0, max: 120 }), v.str(body.po_number, 'po_number', { max: 60, optional: true }), start,
    v.str(body.notes, 'notes', { max: 2000, optional: true }), ctx.now());
  const c = getContract(ctx, id);
  emit(ctx, 'team_contract.created', { contract_id: id, org_id: orgId, org_name: c.org.name, team_name: c.name, monthly_cents: c.monthly_cents });
  await runTeamBilling(ctx, { baseUrl, contractId: id });   // bills the first month now if it has started
  return getContract(ctx, id);
}

const invoiceStatus = (ctx, i) => (i.status === 'open' && i.due_on < today(ctx) ? 'overdue' : i.status);
function shapeInvoice(ctx, i, baseUrl) {
  return { ...i, lines: JSON.parse(i.lines), status: invoiceStatus(ctx, i), link: `${baseUrl ?? ctx.publicUrl ?? ''}/invoice/${i.public_token}` };
}

export function getContract(ctx, id, baseUrl) {
  const c = ctx.db.get('SELECT * FROM team_contracts WHERE id = ?', id);
  if (!c) throw notFound('Team contract');
  const sessions = ctx.db.all(`SELECT s.id, s.starts_at FROM class_sessions s JOIN class_series cs ON cs.id = s.series_id WHERE cs.contract_id = ? AND s.status = 'scheduled'`, id);
  const heldRows = sessions.filter((s) => s.starts_at <= ctx.now()), held = heldRows.map((s) => s.id);
  // Each athlete's attendance counts from the day they joined the roster (and any earlier session they were marked at).
  const zone = getSetting(ctx, 'timezone');
  const roster = ctx.db.all('SELECT * FROM team_roster WHERE contract_id = ? AND active = 1 ORDER BY name', id).map((r) => {
    const here = new Set(ctx.db.all('SELECT session_id FROM team_attendance WHERE roster_id = ?', r.id).map((x) => x.session_id));
    const since = startOfLocalDay(r.created_at, zone);
    const theirs = heldRows.filter((s) => s.starts_at >= since || here.has(s.id));
    return { ...r, sessions_held: theirs.length, sessions_attended: theirs.filter((s) => here.has(s.id)).length };
  });
  const invoices = ctx.db.all('SELECT * FROM team_invoices WHERE contract_id = ? ORDER BY issued_on DESC, number DESC', id).map((i) => shapeInvoice(ctx, i, baseUrl));
  return {
    ...c, org: getOrg(ctx, c.org_id), roster,
    sessions_held: held.length, sessions_upcoming: sessions.length - held.length,
    series: ctx.db.all(`SELECT id, name, weekdays, start_time, duration_min, location_id, active FROM class_series WHERE contract_id = ?`, id).map((s) => ({ ...s, weekdays: JSON.parse(s.weekdays), active: !!s.active })),
    invoices,
    balance_cents: invoices.filter((i) => i.status === 'open' || i.status === 'overdue').reduce((t, i) => t + i.amount_cents, 0),
    next_invoice_on: c.status === 'active' && (!c.end_date || c.next_period_start <= c.end_date) ? c.next_period_start : null
  };
}

export function listContracts(ctx) {
  return ctx.db.all(`SELECT c.*, o.name AS org_name, o.kind AS org_kind, o.contact_email,
      (SELECT COUNT(*) FROM team_roster r WHERE r.contract_id = c.id AND r.active = 1) AS roster_count
    FROM team_contracts c JOIN organizations o ON o.id = c.org_id ORDER BY c.status, o.name, c.name`).map((c) => {
    const open = ctx.db.all(`SELECT amount_cents, due_on FROM team_invoices WHERE contract_id = ? AND status = 'open'`, c.id);
    return { ...c, balance_cents: open.reduce((t, i) => t + i.amount_cents, 0), overdue_cents: open.filter((i) => i.due_on < today(ctx)).reduce((t, i) => t + i.amount_cents, 0),
      next_invoice_on: c.status === 'active' && (!c.end_date || c.next_period_start <= c.end_date) ? c.next_period_start : null };
  });
}

// New fee applies from the next invoice. Ending a contract stops invoicing and archives its team sessions.
export async function updateContract(ctx, id, body, { archiveSeries } = {}) {
  const c = getContract(ctx, id);
  const end = body.end_date !== undefined ? (body.end_date || null) : c.end_date;
  if (end && (!isDate(end) || end < c.start_date)) throw badRequest('end_date must be a date after the start date.');
  ctx.db.run('UPDATE team_contracts SET name = ?, monthly_cents = ?, end_date = ?, terms_days = ?, po_number = ?, notes = ? WHERE id = ?',
    body.name !== undefined ? v.str(body.name, 'name', { max: 120 }) : c.name,
    body.monthly_cents !== undefined ? v.int(body.monthly_cents, 'monthly_cents', { min: 0, max: 100000000 }) : c.monthly_cents,
    end, body.terms_days !== undefined ? v.int(body.terms_days, 'terms_days', { min: 0, max: 120 }) : c.terms_days,
    body.po_number !== undefined ? v.str(body.po_number, 'po_number', { max: 60, optional: true }) : c.po_number,
    body.notes !== undefined ? v.str(body.notes, 'notes', { max: 2000, optional: true }) : c.notes, id);
  if (body.status === 'ended' && c.status !== 'ended') {
    ctx.db.run(`UPDATE team_contracts SET status = 'ended', end_date = COALESCE(end_date, ?) WHERE id = ?`, today(ctx), id);
    for (const s of c.series.filter((x) => x.active)) await archiveSeries?.(s.id);
  }
  if (body.status === 'active' && c.status === 'ended') ctx.db.run(`UPDATE team_contracts SET status = 'active' WHERE id = ?`, id);
  return getContract(ctx, id);
}

// ---------- Roster and attendance ----------
export function addRoster(ctx, contractId, body) {
  getContract(ctx, contractId);
  // Accepts one athlete, or a pasted list with one name per line ("Name, position, grad year").
  const rows = body.names !== undefined
    ? String(body.names).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [name, position, grad] = l.split(/\s*[,\t]\s*/); return { name, position, grad_year: grad && /^\d{4}$/.test(grad) ? Number(grad) : undefined }; })
    : [body];
  if (!rows.length) throw badRequest('Add at least one name.');
  if (rows.length > 200) throw badRequest('Add up to 200 athletes at a time.');
  ctx.db.tx(() => {
    for (const r of rows) {
      const nm = v.str(r.name, 'name', { max: 120 });
      ctx.db.run('INSERT INTO team_roster (id, contract_id, name, athlete_id, position, grad_year, client_id, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)', newId('tr'), contractId,
        nm, newAthleteId(ctx, nm), v.str(r.position, 'position', { max: 60, optional: true }), v.int(r.grad_year, 'grad_year', { min: 2000, max: 2060, optional: true }),
        r.client_id ? (ctx.db.get('SELECT id FROM clients WHERE id = ?', r.client_id)?.id ?? null) : null, ctx.now());
    }
  });
  return getContract(ctx, contractId).roster;
}
export function removeRoster(ctx, contractId, rosterId) {
  const r = ctx.db.run('UPDATE team_roster SET active = 0 WHERE id = ? AND contract_id = ?', rosterId, contractId);
  if (!r.changes) throw notFound('Roster athlete');
  return getContract(ctx, contractId).roster;
}
// For a team session: the contract's roster with who was there.
export function teamRosterFor(ctx, session) {
  const cs = session.series_id && ctx.db.get('SELECT contract_id FROM class_series WHERE id = ?', session.series_id);
  if (!cs?.contract_id) return null;
  const c = ctx.db.get('SELECT t.id, t.name, o.name AS org_name FROM team_contracts t JOIN organizations o ON o.id = t.org_id WHERE t.id = ?', cs.contract_id);
  const present = new Set(ctx.db.all('SELECT roster_id FROM team_attendance WHERE session_id = ?', session.id).map((r) => r.roster_id));
  return { contract_id: c.id, team_name: c.name, org_name: c.org_name,
    athletes: ctx.db.all('SELECT id, name, athlete_id, position, grad_year FROM team_roster WHERE contract_id = ? AND active = 1 ORDER BY name', c.id).map((r) => ({ ...r, present: present.has(r.id) })) };
}
export function setTeamAttendance(ctx, session, rosterId, present) {
  const team = teamRosterFor(ctx, session);
  if (!team) throw conflict('This session isn\'t linked to a team contract.');
  if (!team.athletes.some((a) => a.id === rosterId)) throw notFound('Roster athlete');
  if (present) ctx.db.run('INSERT OR IGNORE INTO team_attendance (session_id, roster_id, created_at) VALUES (?, ?, ?)', session.id, rosterId, ctx.now());
  else ctx.db.run('DELETE FROM team_attendance WHERE session_id = ? AND roster_id = ?', session.id, rosterId);
  return teamRosterFor(ctx, session);
}

// ---------- Invoices ----------
function nextNumber(ctx, issuedOn) {
  const year = issuedOn.slice(0, 4);
  const last = ctx.db.get(`SELECT number FROM team_invoices WHERE number LIKE ? ORDER BY number DESC LIMIT 1`, `DP-${year}-%`);
  return `DP-${year}-${String((last ? Number(last.number.split('-')[2]) : 0) + 1).padStart(4, '0')}`;
}
function insertInvoice(ctx, c, { lines, periodStart = null, periodEnd = null }) {
  const issued = today(ctx);
  const amount = lines.reduce((t, l) => t + l.amount_cents, 0);
  const id = newId('tin');
  ctx.db.run(`INSERT INTO team_invoices (id, number, contract_id, org_id, lines, amount_cents, period_start, period_end, issued_on, due_on, status, public_token, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    id, nextNumber(ctx, issued), c.id, c.org_id, JSON.stringify(lines), amount, periodStart, periodEnd, issued, addDaysToDate(issued, c.terms_days), token(24), ctx.now());
  const inv = ctx.db.get('SELECT * FROM team_invoices WHERE id = ?', id);
  emit(ctx, 'team_invoice.created', { invoice_id: id, number: inv.number, contract_id: c.id, org_name: c.org_name ?? getOrg(ctx, c.org_id).name, team_name: c.name, amount_cents: amount, due_on: inv.due_on });
  return inv;
}

// One-off invoice: extra sessions, equipment, a tournament day.
export async function createOneOffInvoice(ctx, contractId, body, baseUrl) {
  const c = getContract(ctx, contractId);
  const lines = (Array.isArray(body.lines) ? body.lines : [body]).map((l) => ({ description: v.str(l.description, 'description', { max: 200 }), amount_cents: v.int(l.amount_cents, 'amount_cents', { min: 1, max: 100000000 }) }));
  const inv = insertInvoice(ctx, c, { lines });
  if (body.send !== false) await sendInvoice(ctx, inv.id, baseUrl);
  return getInvoice(ctx, inv.id, baseUrl);
}

export function getInvoice(ctx, id, baseUrl) {
  const i = ctx.db.get(`SELECT i.*, t.name AS team_name, t.po_number, o.name AS org_name, o.contact_name, o.contact_email, o.billing_address
    FROM team_invoices i JOIN team_contracts t ON t.id = i.contract_id JOIN organizations o ON o.id = i.org_id WHERE i.id = ?`, id);
  if (!i) throw notFound('Invoice');
  return shapeInvoice(ctx, i, baseUrl);
}
export function listInvoices(ctx, { status } = {}, baseUrl) {
  return ctx.db.all(`SELECT i.*, t.name AS team_name, o.name AS org_name FROM team_invoices i JOIN team_contracts t ON t.id = i.contract_id JOIN organizations o ON o.id = i.org_id ORDER BY i.issued_on DESC, i.number DESC LIMIT 200`)
    .map((i) => shapeInvoice(ctx, i, baseUrl)).filter((i) => !status || i.status === status || (status === 'unpaid' && ['open', 'overdue'].includes(i.status)));
}

export async function sendInvoice(ctx, id, baseUrl, { reminder = false } = {}) {
  const i = getInvoice(ctx, id, baseUrl);
  if (!['open', 'overdue'].includes(i.status)) throw conflict(`Invoice ${i.number} is ${i.status}.`);
  if (!i.contact_email) throw conflict(`Add a billing email for ${i.org_name} to send invoices.`);
  const biz = getSetting(ctx, 'business_name');
  const subject = reminder ? `Reminder: invoice ${i.number} from ${biz} was due ${longDate(i.due_on)}` : `Invoice ${i.number} from ${biz}: ${money(i.amount_cents)} due ${longDate(i.due_on)}`;
  const text = `Hi${i.contact_name ? ` ${i.contact_name.split(' ')[0]}` : ''},\n\n${reminder ? `This is a reminder that invoice ${i.number} for ${i.team_name} is past due.` : `Here is invoice ${i.number} for ${i.team_name} training${i.period_start ? `, ${longDate(i.period_start)} to ${longDate(i.period_end)}` : ''}.`}\n\nAmount: ${money(i.amount_cents)}\nDue: ${longDate(i.due_on)}${i.po_number ? `\nPO: ${i.po_number}` : ''}\n\nView, print or pay online: ${i.link}\n\n${getSetting(ctx, 'payment_instructions')}\n\nThank you,\n${biz}`;
  await sendEmail(ctx, { to: i.contact_email, subject, text });
  ctx.db.run(`UPDATE team_invoices SET ${reminder ? 'reminded_at' : 'sent_at'} = ? WHERE id = ?`, ctx.now(), id);
  return getInvoice(ctx, id, baseUrl);
}

export async function recordPayment(ctx, id, body, baseUrl) {
  const i = getInvoice(ctx, id, baseUrl);
  if (i.status === 'paid') throw conflict(`Invoice ${i.number} is already paid.`);
  if (i.status === 'void') throw conflict(`Invoice ${i.number} was voided.`);
  const paidOn = body.paid_on ?? today(ctx);
  if (!isDate(paidOn)) throw badRequest('paid_on must look like 2026-10-15.');
  ctx.db.run(`UPDATE team_invoices SET status = 'paid', paid_on = ?, paid_method = ?, paid_reference = ? WHERE id = ?`,
    paidOn, v.oneOf(body.method ?? 'check', 'method', PAY_METHODS), v.str(body.reference, 'reference', { max: 120, optional: true }), id);
  emit(ctx, 'team_invoice.paid', { invoice_id: id, number: i.number, org_name: i.org_name, team_name: i.team_name, amount_cents: i.amount_cents, method: body.method ?? 'check' });
  if (i.contact_email) sendEmail(ctx, { to: i.contact_email, subject: `Payment received: invoice ${i.number}`, text: `Thank you. We received ${money(i.amount_cents)} for invoice ${i.number} (${i.team_name}).\n\nReceipt: ${i.link}\n\n${getSetting(ctx, 'business_name')}` }).catch(() => {});
  return getInvoice(ctx, id, baseUrl);
}

export function voidInvoice(ctx, id, baseUrl) {
  const i = getInvoice(ctx, id, baseUrl);
  if (i.status === 'paid') throw conflict('Paid invoices can\'t be voided. Refund the payment outside the app, then void.');
  ctx.db.run(`UPDATE team_invoices SET status = 'void' WHERE id = ?`, id);
  emit(ctx, 'team_invoice.voided', { invoice_id: id, number: i.number, org_name: i.org_name, amount_cents: i.amount_cents });
  return getInvoice(ctx, id, baseUrl);
}

// ---------- The billing clock (runs hourly with memberships) ----------
export async function runTeamBilling(ctx, { baseUrl, contractId } = {}) {
  const day = today(ctx);
  const out = { invoiced: 0, reminded: 0, ended: 0 };
  const contracts = ctx.db.all(`SELECT t.*, o.name AS org_name FROM team_contracts t JOIN organizations o ON o.id = t.org_id WHERE t.status = 'active'${contractId ? ' AND t.id = ?' : ''}`, ...(contractId ? [contractId] : []));
  for (const c of contracts) {
    let k = ctx.db.get('SELECT COUNT(*) AS n FROM team_invoices WHERE contract_id = ? AND period_start IS NOT NULL', c.id).n;
    let start = periodStart(c.start_date, k);
    while (start <= day && (!c.end_date || start <= c.end_date)) {
      const end = addDaysToDate(periodStart(c.start_date, k + 1), -1);
      const periodEnd = c.end_date && c.end_date < end ? c.end_date : end;
      const inv = insertInvoice(ctx, c, { lines: [{ description: `${c.name} training, ${longDate(start)} – ${longDate(periodEnd)}`, amount_cents: c.monthly_cents }], periodStart: start, periodEnd });
      out.invoiced++;
      if (ctx.db.get('SELECT contact_email FROM organizations WHERE id = ?', c.org_id).contact_email) await sendInvoice(ctx, inv.id, baseUrl);
      k++; start = periodStart(c.start_date, k);
    }
    ctx.db.run('UPDATE team_contracts SET next_period_start = ? WHERE id = ?', start, c.id);
    if (c.end_date && c.end_date < day) { ctx.db.run(`UPDATE team_contracts SET status = 'ended' WHERE id = ?`, c.id); out.ended++; }
  }
  // Past-due reminders: the day after the due date, then weekly.
  if (!contractId) {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    for (const i of ctx.db.all(`SELECT i.id, i.number, i.amount_cents, i.reminded_at, o.name AS org_name, o.contact_email FROM team_invoices i JOIN organizations o ON o.id = i.org_id
                                WHERE i.status = 'open' AND i.due_on < ? AND (i.reminded_at IS NULL OR i.reminded_at < ?)`, day, weekAgo)) {
      if (!i.reminded_at) emit(ctx, 'team_invoice.overdue', { invoice_id: i.id, number: i.number, org_name: i.org_name, amount_cents: i.amount_cents });
      if (i.contact_email) { await sendInvoice(ctx, i.id, baseUrl, { reminder: true }); out.reminded++; }
      else ctx.db.run('UPDATE team_invoices SET reminded_at = ? WHERE id = ?', ctx.now(), i.id);
    }
  }
  return out;
}

// ---------- Public invoice page and online payment ----------
export function publicInvoice(ctx, tok) {
  const row = ctx.db.get('SELECT id FROM team_invoices WHERE public_token = ?', String(tok ?? ''));
  if (!row) throw notFound('Invoice');
  const i = getInvoice(ctx, row.id);
  return {
    number: i.number, status: i.status, lines: i.lines, amount_cents: i.amount_cents, issued_on: i.issued_on, due_on: i.due_on, period_start: i.period_start, period_end: i.period_end,
    paid_on: i.paid_on, paid_method: i.paid_method, team_name: i.team_name, po_number: i.po_number,
    bill_to: { name: i.org_name, contact: i.contact_name, address: i.billing_address },
    from: { name: getSetting(ctx, 'business_name'), address: getSetting(ctx, 'business_address'), payment_instructions: getSetting(ctx, 'payment_instructions') },
    can_pay_online: ['open', 'overdue'].includes(i.status) && typeof ctx.payments.checkoutPayment === 'function' && ctx.payments.name === 'stripe',
    can_simulate: ['open', 'overdue'].includes(i.status) && !!ctx.payments.simulate
  };
}
export async function checkoutForInvoice(ctx, tok, baseUrl) {
  const row = ctx.db.get('SELECT id FROM team_invoices WHERE public_token = ?', String(tok ?? ''));
  if (!row) throw notFound('Invoice');
  const i = getInvoice(ctx, row.id, baseUrl);
  if (!['open', 'overdue'].includes(i.status)) throw conflict(`This invoice is ${i.status}.`);
  if (ctx.payments.name !== 'stripe') throw conflict('Online payment needs Stripe. In test mode, use "Simulate payment".');
  const s = await ctx.payments.checkoutPayment({ amountCents: i.amount_cents, description: `Invoice ${i.number}: ${i.team_name}`, email: i.contact_email,
    metadata: { team_invoice_id: i.id }, successUrl: `${i.link}?paid=1`, cancelUrl: i.link, idempotencyKey: `team-invoice-${i.id}-${i.amount_cents}` });
  ctx.db.run('UPDATE team_invoices SET checkout_ref = ? WHERE id = ?', s.id, i.id);
  return { url: s.url };
}
export async function simulateInvoicePaid(ctx, tok) {
  if (!ctx.payments.simulate) throw conflict('Only available in test mode.');
  const row = ctx.db.get('SELECT id FROM team_invoices WHERE public_token = ?', String(tok ?? ''));
  if (!row) throw notFound('Invoice');
  await recordPayment(ctx, row.id, { method: 'online', reference: 'test payment' });
  return publicInvoice(ctx, tok);
}
// Stripe webhook: Checkout finished (cards are paid now; bank payments settle a few days later).
export async function handleInvoiceCheckout(ctx, type, obj) {
  const id = obj.metadata?.team_invoice_id;
  if (!id || !ctx.db.get('SELECT id FROM team_invoices WHERE id = ?', id)) return false;
  const inv = ctx.db.get('SELECT status FROM team_invoices WHERE id = ?', id);
  if (inv.status !== 'open') return true;
  if ((type === 'checkout.session.completed' && obj.payment_status === 'paid') || type === 'checkout.session.async_payment_succeeded') {
    await recordPayment(ctx, id, { method: 'online', reference: obj.payment_intent ?? obj.id });
  } else if (type === 'checkout.session.async_payment_failed') {
    emit(ctx, 'team_invoice.payment_failed', { invoice_id: id });
  }
  return true;
}

export function teamSummary(ctx) {
  const d = today(ctx);
  const monthly = ctx.db.get(`SELECT COALESCE(SUM(monthly_cents), 0) AS c, COUNT(*) AS n FROM team_contracts WHERE status = 'active'`);
  const overdue = ctx.db.all(`SELECT i.id AS invoice_id, i.number, i.amount_cents, i.due_on, t.id AS contract_id, t.name AS team_name, o.name AS name FROM team_invoices i JOIN team_contracts t ON t.id = i.contract_id JOIN organizations o ON o.id = i.org_id WHERE i.status = 'open' AND i.due_on < ? ORDER BY i.due_on`, d);
  const open = ctx.db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM team_invoices WHERE status = 'open'`).c;
  return { monthly_cents: monthly.c, active_contracts: monthly.n, open_cents: open, overdue };
}
