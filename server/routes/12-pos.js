// Point of sale: locations, products, front-desk readers, sales and refunds.
'use strict';
const { get, all, run, insert, update, tx, setting } = require('../db');
const { h, bad, notFound, log, money, payments, sendEmail, appUrl, businessName, addDays } = require('../lib');
const { requireStaff } = require('../auth');
const billing = require('../services/billing');
const booking = require('../services/booking');
const { fullName, localDateOf } = require('../services/floor-util');


const LOCATION_KINDS = ['facility', 'mobile', 'park', 'school'];
const PRODUCT_KINDS = ['session', 'group_pack', 'private_pack', 'gear', 'other'];
const METHOD_LABEL = { tap: 'Tap to Pay', reader: 'Front-desk reader', card: 'Card on file', cash: 'Cash' };
const TEST_READER_CODE = 'simulated-wpe';
const UNDO_MINUTES = 10; // the person who rang up a sale can undo it this long afterwards
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SALE_SELECT = `SELECT s.*, l.name AS location, a.first_name, a.last_name, st.name AS staff,
    (julianday('now') - julianday(s.created_at)) * 1440 AS age_min
  FROM sales s LEFT JOIN locations l ON l.id=s.location_id LEFT JOIN athletes a ON a.id=s.athlete_id LEFT JOIN staff st ON st.id=s.staff_id`;

const cents = (v) => (v === '' || v == null ? null : Math.round(Number(v)));
// Signed money for receipt lines: a discount reads "-$25", not "$-25".
const signedMoney = (c) => (c < 0 ? `-${money(-c)}` : money(c));
// An optional location filter: blank means all locations; anything else must be a real location id.
function locationFilter(v) {
  if (v === undefined || v === '') return null;
  const loc = /^\d+$/.test(String(v)) ? get('SELECT id, name FROM locations WHERE id=?', Number(v)) : null;
  if (!loc) throw notFound('That location');
  return loc;
}
const locRow = (l) => ({ ...l, cards_ready: !!(l.address && l.address.trim()) });

function composeAddress(b) {
  if (b.address != null && !b.street) return String(b.address).trim();
  const street = String(b.street || '').trim(), city = String(b.city || '').trim(), state = String(b.state || '').trim().toUpperCase(), zip = String(b.zip || '').trim();
  if (!street && !city && !state && !zip) return '';
  if (!street || !city) throw bad('Enter the street and city, or leave the address blank.');
  return `${street}, ${city}${state || zip ? ', ' : ''}${[state, zip].filter(Boolean).join(' ')}`;
}

function productBody(b, existing = {}) {
  const row = {};
  if (b.name !== undefined || !existing.id) {
    row.name = String(b.name ?? '').trim();
    if (!row.name) throw bad('Give the product a name.');
  }
  const kind = b.kind ?? existing.kind;
  if (!PRODUCT_KINDS.includes(kind)) throw bad('Choose what kind of product it is.');
  row.kind = kind;
  if (b.price_cents !== undefined || !existing.id) {
    const p = cents(b.price_cents);
    if (!(p > 0) || p > 1000000) throw bad('Enter a price above $0.');
    row.price_cents = p;
  }
  let credits = b.credits !== undefined ? Number(b.credits) : existing.credits;
  if (kind === 'group_pack' || kind === 'private_pack') {
    if (!(Number.isInteger(credits) && credits >= 1 && credits <= 200)) throw bad('Enter how many sessions the pack holds.');
  } else if (kind === 'session') credits = 1;
  else credits = 0;
  row.credits = credits;
  return row;
}

function saleRow(s, me = null) {
  let items = [];
  try { items = JSON.parse(s.items || '[]'); } catch { /* keep empty */ }
  const card = s.method === 'card' || s.method === 'tap' || s.method === 'reader'
    ? (s.family_id ? get('SELECT card_brand, card_last4 FROM families WHERE id=?', s.family_id) : null) : null;
  return {
    id: s.id, created_at: s.created_at, location_id: s.location_id, location: s.location, athlete_id: s.athlete_id,
    who: s.first_name ? `${s.first_name} ${s.last_name}` : 'Walk-in', items, total_cents: s.total_cents, refunded_cents: s.refunded_cents || 0,
    method: s.method, method_label: METHOD_LABEL[s.method], card_last4: s.method === 'card' ? card?.card_last4 || null : null,
    status: s.status, staff: s.staff, staff_id: s.staff_id, booking_id: s.booking_id, family_id: s.family_id,
    discount_cents: s.discount_cents || 0, receipt_sent_at: s.receipt_sent_at || null,
    receipt_email: s.family_id ? billing.billingEmail(s.family_id) : null,
    can_undo: !!me && s.staff_id === me.id && s.status === 'paid' && !(s.refunded_cents > 0) && s.age_min != null && s.age_min <= UNDO_MINUTES,
  };
}

function saleById(id, me) {
  const row = get(`${SALE_SELECT} WHERE s.id=?`, id);
  return row ? saleRow(row, me) : null;
}

// Coaches take payments but never see the facility's takings: they see only the sales they rang up.
const coachOnly = (req) => req.staff.role === 'coach';
function saleFor(req, id) {
  const s = get('SELECT * FROM sales WHERE id=?', id);
  if (!s || (coachOnly(req) && s.staff_id !== req.staff.id)) throw notFound('That sale');
  return s;
}

// Refund all or part of a sale. A full refund takes back unused pack credits and reopens a collected drop-in.
function refundSale(s, amount) {
  tx(() => {
    const inv = s.charge_id ? get("SELECT * FROM invoices WHERE charge_id=? AND status='paid' AND amount_cents>0 ORDER BY id LIMIT 1", s.charge_id) : null;
    if (inv) billing.refundInvoice(inv.id, amount);
    const refunded = (s.refunded_cents || 0) + amount;
    const full = refunded >= s.total_cents;
    update('sales', s.id, { refunded_cents: refunded, status: full ? 'refunded' : 'partial_refund' });
    if (full) {
      let lines = [];
      try { lines = JSON.parse(s.items || '[]'); } catch { /* none */ }
      if (s.athlete_id) for (const l of lines) {
        if (l.kind === 'group_pack' || (l.kind === 'session' && l.product_id)) run('UPDATE athletes SET group_credits=MAX(0, group_credits-?) WHERE id=?', (l.credits || 1) * (l.qty || 1), s.athlete_id);
        if (l.kind === 'private_pack') run('UPDATE athletes SET private_credits=MAX(0, private_credits-?) WHERE id=?', (l.credits || 1) * (l.qty || 1), s.athlete_id);
      }
      if (s.booking_id) run("UPDATE bookings SET coverage='unpaid', paid_cents=0 WHERE id=? AND coverage='paid'", s.booking_id);
    }
  });
}

// A plain-text receipt for the family (or the address the desk typed in).
function receiptText(s) {
  let lines = [];
  try { lines = JSON.parse(s.items || '[]'); } catch { /* none */ }
  const loc = s.location_id ? get('SELECT name, address FROM locations WHERE id=?', s.location_id) : null;
  const inv = s.charge_id ? get("SELECT view_token FROM invoices WHERE charge_id=? AND amount_cents>0 ORDER BY id LIMIT 1", s.charge_id) : null;
  const when = new Date(String(s.created_at).replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: setting('timezone', 'America/Denver'), month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const card = s.method !== 'cash' && s.family_id ? get('SELECT card_brand, card_last4 FROM families WHERE id=?', s.family_id) : null;
  const body = [
    `Thank you. Here is your receipt from ${businessName()}.`, '',
    `${when}${loc ? ` · ${loc.name}` : ''}`, '',
    ...lines.map((l) => `${l.qty > 1 ? `${l.qty} × ` : ''}${l.name}  ${signedMoney(l.price_cents * (l.qty || 1))}`), '',
    `Total paid: ${money(s.total_cents)} by ${METHOD_LABEL[s.method]}${s.method === 'card' && card?.card_last4 ? ` (${card.card_brand} ••${card.card_last4})` : ''}`,
    s.refunded_cents ? `Refunded: ${money(s.refunded_cents)}` : '',
    inv?.view_token ? `\nView or print it online:\n${appUrl()}/invoice/${inv.view_token}` : '',
    loc?.address ? `\n${businessName()} · ${loc.address}` : '',
  ].filter((x) => x !== '');
  return body.join('\n').replace(/\n{3,}/g, '\n\n');
}

function sendReceipt(req, s, to) {
  const email = String(to || '').trim();
  if (!EMAIL_RE.test(email)) throw bad('Enter an email address for the receipt.');
  sendEmail(email, `Your receipt from ${businessName()}`, receiptText(s));
  update('sales', s.id, { receipt_sent_at: new Date().toISOString() });
  log(req, 'Emailed receipt', `${email} · sale ${s.id}`);
  return email;
}

function routes(api) {
  // ---- locations ----
  api.get('/locations', requireStaff(), h(async (req, res) => {
    res.json(all(`SELECT * FROM locations ${req.query.all === '1' ? '' : 'WHERE archived=0'} ORDER BY archived, id`).map(locRow));
  }));
  api.post('/locations', requireStaff('owner', 'coach'), h(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw bad('Give the location a name.');
    const kind = b.kind || 'facility';
    if (!LOCATION_KINDS.includes(kind)) throw bad('Choose facility, mobile or park.');
    if (get('SELECT 1 FROM locations WHERE name=? COLLATE NOCASE AND archived=0', name)) throw bad('A location with that name already exists.');
    const address = composeAddress(b);
    const id = insert('locations', { name, kind, address: address || null });
    log(req, 'Added location', `${name}${address ? '' : ' (no address yet: cards not ready)'}`);
    res.json({ ok: true, id, location: locRow(get('SELECT * FROM locations WHERE id=?', id)) });
  }));
  api.put('/locations/:id', requireStaff('owner', 'coach'), h(async (req, res) => {
    const l = get('SELECT * FROM locations WHERE id=?', req.params.id);
    if (!l) throw notFound('That location');
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      patch.name = String(b.name).trim();
      if (!patch.name) throw bad('Give the location a name.');
      if (get('SELECT 1 FROM locations WHERE name=? COLLATE NOCASE AND archived=0 AND id<>?', patch.name, l.id)) throw bad('A location with that name already exists.');
    }
    if (b.kind !== undefined) { if (!LOCATION_KINDS.includes(b.kind)) throw bad('Choose facility, mobile or park.'); patch.kind = b.kind; }
    if (b.address !== undefined || b.street !== undefined) patch.address = composeAddress(b) || null;
    if (b.archived !== undefined) {
      patch.archived = b.archived ? 1 : 0;
      if (!patch.archived && l.archived && get('SELECT 1 FROM locations WHERE name=? COLLATE NOCASE AND archived=0 AND id<>?', patch.name || l.name, l.id)) throw bad('A location with that name is already in use. Rename one of them first.');
    }
    update('locations', l.id, patch);
    log(req, b.archived ? 'Archived location' : b.archived === false || b.archived === 0 ? 'Restored location' : 'Updated location', patch.name || l.name);
    res.json({ ok: true, location: locRow(get('SELECT * FROM locations WHERE id=?', l.id)) });
  }));

  // ---- products ----
  api.get('/products', requireStaff(), h(async (req, res) => {
    res.json(all(`SELECT * FROM products ${req.query.all === '1' ? '' : 'WHERE archived=0'} ORDER BY archived, CASE kind WHEN 'session' THEN 0 WHEN 'group_pack' THEN 1 WHEN 'private_pack' THEN 2 WHEN 'gear' THEN 3 ELSE 4 END, price_cents`));
  }));
  api.post('/products', requireStaff('owner', 'coach'), h(async (req, res) => {
    const row = productBody(req.body || {});
    if (get('SELECT 1 FROM products WHERE name=? COLLATE NOCASE AND archived=0', row.name)) throw bad('A product with that name is already for sale.');
    const id = insert('products', row);
    log(req, 'Added product', `${row.name} · ${money(row.price_cents)}`);
    res.json({ ok: true, id, product: get('SELECT * FROM products WHERE id=?', id) });
  }));
  api.put('/products/:id', requireStaff('owner', 'coach'), h(async (req, res) => {
    const p = get('SELECT * FROM products WHERE id=?', req.params.id);
    if (!p) throw notFound('That product');
    const b = req.body || {};
    const patch = (b.name !== undefined || b.kind !== undefined || b.price_cents !== undefined || b.credits !== undefined) ? productBody(b, p) : {};
    if (b.archived !== undefined) patch.archived = b.archived ? 1 : 0;
    const live = (patch.archived ?? p.archived) === 0;
    if (live && get('SELECT 1 FROM products WHERE name=? COLLATE NOCASE AND archived=0 AND id<>?', patch.name ?? p.name, p.id)) {
      throw bad(p.archived && patch.archived === 0 && !patch.name ? 'Another product for sale has that name. Rename one of them first.' : 'A product with that name is already for sale.');
    }
    update('products', p.id, patch);
    const what = b.archived ? 'Stopped selling' : b.archived === false || b.archived === 0 ? 'Started selling' : patch.price_cents && patch.price_cents !== p.price_cents ? 'Changed price' : 'Updated product';
    log(req, what, `${p.name}${patch.price_cents && patch.price_cents !== p.price_cents ? ` · ${money(p.price_cents)} to ${money(patch.price_cents)}` : ''}`);
    res.json({ ok: true, product: get('SELECT * FROM products WHERE id=?', p.id) });
  }));

  // ---- front-desk readers ----
  api.get('/readers', requireStaff(), h(async (_req, res) => {
    res.json(all('SELECT r.*, l.name AS location FROM readers r LEFT JOIN locations l ON l.id=r.location_id ORDER BY r.id'));
  }));
  api.post('/readers', requireStaff('owner', 'coach'), h(async (req, res) => {
    const b = req.body || {};
    const code = String(b.code || '').trim().toLowerCase();
    const label = String(b.label || '').trim() || 'Front desk';
    if (!code) throw bad('Enter the registration code the reader shows.');
    let serial;
    if (payments.mode() === 'test') {
      if (code !== TEST_READER_CODE) throw bad(`Test mode: use the code ${TEST_READER_CODE}.`);
      serial = 'simulated_wisepos_e';
    } else {
      if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(code)) throw bad('The code is three words joined by dashes, as shown on the reader.');
      serial = code; // Live: register with Stripe Terminal using this code.
    }
    const loc = b.location_id ? get('SELECT id, name FROM locations WHERE id=? AND archived=0', b.location_id) : null;
    if (!loc) throw bad('Choose where the reader lives.');
    const id = insert('readers', { label, location_id: loc.id, serial });
    log(req, 'Registered reader', `${label} · ${loc.name}`);
    res.json({ ok: true, id });
  }));
  api.delete('/readers/:id', requireStaff('owner', 'coach'), h(async (req, res) => {
    const r = get('SELECT * FROM readers WHERE id=?', req.params.id);
    if (!r) throw notFound('That reader');
    run('DELETE FROM readers WHERE id=?', r.id);
    log(req, 'Removed reader', r.label);
    res.json({ ok: true });
  }));

  // Who you're with at the counter: card on file and session credits.
  api.get('/pos/client/:id', requireStaff(), h(async (req, res) => {
    const a = get('SELECT * FROM athletes WHERE id=? AND archived=0', req.params.id);
    if (!a) throw notFound('That client');
    const f = a.family_id ? get('SELECT id, name, card_brand, card_last4 FROM families WHERE id=?', a.family_id) : null;
    const m = billing.activeMembership(a.id);
    res.json({ id: a.id, code: a.code, first_name: a.first_name, last_name: a.last_name, family_id: f?.id || null, family: f?.name || null,
      card: f?.card_last4 ? { brand: f.card_brand, last4: f.card_last4 } : null, group_credits: a.group_credits, private_credits: a.private_credits,
      membership: m ? { plan_name: m.plan_name, status: m.status } : null,
      email: f ? billing.billingEmail(f.id) : (a.email || null) });
  }));

  // ---- sales ----
  // Recent sales, newest first. Filters: days (1-366), location_id, method, q (client name or item), athlete_id.
  // Days are calendar days in the business time zone: days=1 is today since local midnight, days=7 is today and the six before.
  // Coaches see only the sales they rang up themselves.
  api.get('/sales', requireStaff(), h(async (req, res) => {
    const days = Math.min(Math.max(Math.floor(Number(req.query.days)) || 7, 1), 366);
    const from = addDays(booking.todayLocal(), -(days - 1));
    // A day of slack in SQL (time zones), then the exact local-date cut below.
    const where = ["s.created_at >= datetime('now', ?)"], params = [`-${days + 1} days`];
    if (req.query.athlete_id) { where.push('s.athlete_id=?'); params.push(Number(req.query.athlete_id) || 0); }
    if (req.query.location_id) { where.push('s.location_id=?'); params.push(Number(req.query.location_id) || 0); }
    if (req.query.method) {
      if (!METHOD_LABEL[req.query.method]) throw bad('Choose tap, reader, card or cash.');
      where.push('s.method=?'); params.push(req.query.method);
    }
    const q = String(req.query.q || '').trim();
    if (q) { where.push("((a.first_name || ' ' || a.last_name) LIKE ? OR s.items LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
    if (coachOnly(req)) { where.push('s.staff_id=?'); params.push(req.staff.id); }
    const rows = all(`${SALE_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id DESC LIMIT 200`, ...params)
      .filter((r) => (localDateOf(r.created_at) || '') >= from);
    res.json(rows.map((r) => saleRow(r, req.staff)));
  }));

  // The day's takings for closing out: count, discounts, refunds and net by payment method (owners and front desk).
  api.get('/sales/summary', requireStaff('owner', 'frontdesk'), h(async (req, res) => {
    let date = booking.todayLocal();
    if (req.query.date) {
      date = String(req.query.date);
      const t = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T12:00:00Z') : null;
      if (!t || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== date) throw bad('Choose a real date, like 2026-09-27.');
    }
    const loc = locationFilter(req.query.location_id);
    const next = new Date(date + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 2);
    const prev = new Date(date + 'T12:00:00Z'); prev.setUTCDate(prev.getUTCDate() - 1);
    const rows = all(`SELECT * FROM sales WHERE status!='failed' AND created_at >= ? AND created_at < ? ${loc ? 'AND location_id=?' : ''}`,
      prev.toISOString().slice(0, 10), next.toISOString().slice(0, 10), ...(loc ? [loc.id] : []))
      .filter((s) => localDateOf(s.created_at) === date);
    const by = Object.fromEntries(Object.keys(METHOD_LABEL).map((m) => [m, { method: m, label: METHOD_LABEL[m], count: 0, taken_cents: 0, refunded_cents: 0, net_cents: 0 }]));
    const out = { date, location_id: loc?.id || null, location: loc?.name || null, count: 0, taken_cents: 0, discount_cents: 0, refunded_cents: 0, net_cents: 0 };
    for (const s of rows) {
      const m = by[s.method];
      m.count++; m.taken_cents += s.total_cents; m.refunded_cents += s.refunded_cents || 0; m.net_cents += s.total_cents - (s.refunded_cents || 0);
      out.count++; out.taken_cents += s.total_cents; out.discount_cents += s.discount_cents || 0; out.refunded_cents += s.refunded_cents || 0;
    }
    out.net_cents = out.taken_cents - out.refunded_cents;
    out.by_method = Object.values(by);
    out.cash_cents = by.cash.net_cents;
    res.json(out);
  }));

  api.get('/sales/:id', requireStaff(), h(async (req, res) => {
    const s = saleFor(req, req.params.id);
    res.json(saleById(s.id, req.staff));
  }));

  api.post('/sales', requireStaff(), h(async (req, res) => {
    const b = req.body || {};
    const method = b.method;
    if (!METHOD_LABEL[method]) throw bad('Choose how they\'re paying.');
    const loc = get('SELECT * FROM locations WHERE id=? AND archived=0', b.location_id);
    if (!loc) throw bad('Choose where you are.');
    if (method !== 'cash' && !(loc.address && loc.address.trim())) throw bad(`Card payments need an address for ${loc.name}. Add one in Point of sale setup, or take cash.`);
    const a = b.athlete_id ? get('SELECT * FROM athletes WHERE id=? AND archived=0', b.athlete_id) : null;
    if (b.athlete_id && !a) throw bad('That client wasn\'t found.');
    if (!Array.isArray(b.items) || !b.items.length) throw bad('Add a product or a custom amount first.');
    if (b.items.length > 50) throw bad('That\'s too many lines for one sale.');

    const lines = [];
    for (const it of b.items) {
      const qty = Number(it.qty || 1);
      if (!(Number.isInteger(qty) && qty >= 1 && qty <= 99)) throw bad('Quantities must be whole numbers from 1 to 99.');
      if (it.product_id) {
        const p = get('SELECT * FROM products WHERE id=? AND archived=0', it.product_id);
        if (!p) throw bad('One of those products is no longer for sale. Refresh and try again.');
        if ((p.kind === 'group_pack' || p.kind === 'private_pack') && !a) throw bad(`Choose who you're with to sell ${p.name}. Packs add sessions to a client.`);
        lines.push({ product_id: p.id, name: p.name, kind: p.kind, credits: p.credits, qty, price_cents: p.price_cents });
      } else {
        const name = String(it.name || '').trim() || 'Custom amount';
        const pc = cents(it.price_cents);
        if (!(pc > 0) || pc > 1000000) throw bad('Enter a custom amount above $0.');
        lines.push({ name: name.slice(0, 80), kind: 'other', qty, price_cents: pc });
      }
    }
    const subtotal = lines.reduce((n, l) => n + l.price_cents * l.qty, 0);
    // Optional discount on the whole sale: a percent (1-99) or an amount off, with an optional reason.
    let discount = 0, discountLine = null;
    const d = b.discount;
    if (d && d.value !== undefined && d.value !== null && d.value !== '') {
      const reason = String(d.reason || '').trim().slice(0, 60);
      if (d.type === 'pct') {
        const pct = Number(d.value);
        if (!(Number.isInteger(pct) && pct >= 1 && pct <= 99)) throw bad('A percent discount is a whole number from 1 to 99.');
        discount = Math.round(subtotal * pct / 100);
        discountLine = `Discount ${pct}%`;
      } else if (d.type === 'amount') {
        discount = cents(d.value);
        if (!(discount > 0)) throw bad('Enter a discount above $0.');
        discountLine = 'Discount';
      } else throw bad('Choose a percent or an amount off.');
      if (discount >= subtotal) throw bad(`A discount has to leave something to pay. The sale is ${money(subtotal)}.`);
      if (discount > 0) lines.push({ name: reason ? `${discountLine} (${reason})` : discountLine, kind: 'discount', qty: 1, price_cents: -discount });
    }
    const total = subtotal - discount;
    let receiptTo = null;
    if (b.email_receipt) {
      receiptTo = String(b.receipt_email || '').trim() || (a?.family_id ? billing.billingEmail(a.family_id) : '') || '';
      if (!EMAIL_RE.test(receiptTo)) throw bad(a ? `There's no email on file for ${a.first_name}'s family. Type one in for the receipt, or untick Email a receipt.` : 'Enter an email address for the receipt, or untick Email a receipt.');
    }

    if (method === 'card') {
      if (!a?.family_id) throw bad('Card on file needs a client. Choose who you\'re with.');
      const f = get('SELECT card_last4 FROM families WHERE id=?', a.family_id);
      if (!f?.card_last4) throw bad(`${a.first_name}'s family has no card on file. Use Tap to Pay, the reader or cash.`);
    }
    let reader = null;
    if (method === 'reader') {
      reader = get('SELECT * FROM readers WHERE location_id=? ORDER BY id LIMIT 1', loc.id);
      if (!reader) throw bad(`No front-desk reader is registered at ${loc.name}. Use Tap to Pay, or add a reader in Point of sale setup.`);
    }
    // Tapped or inserted card (simulated in test mode; Stripe Terminal when live).
    const tapped = method === 'tap' || method === 'reader'
      ? { brand: String(b.card?.brand || 'Visa').slice(0, 20), last4: String(b.card?.last4 || '4242').replace(/\D/g, '').slice(-4) || '4242', exp: b.card?.exp || '12/29' } : null;
    if (tapped && tapped.last4 === '0002') throw bad('Card declined. Ask for another card or take cash.');

    const description = lines.filter((l) => l.kind !== 'discount').map((l) => (l.qty > 1 ? `${l.qty} × ${l.name}` : l.name)).join(', ') + (discount ? ` less ${money(discount)} discount` : '');
    const result = tx(() => {
      const r = billing.charge({ family_id: a?.family_id || null, athlete_id: a?.id || null, amount_cents: total, description: `${description} (${loc.name})`, method });
      if (!r.ok) {
        // A declined sale at the counter isn't a debt to retry later.
        if (r.invoice_id) update('invoices', r.invoice_id, { status: 'void', next_retry: null });
        return { r };
      }
      for (const l of lines) if (l.product_id && a) billing.applyProduct(a.id, { kind: l.kind, credits: l.credits }, l.qty);
      let savedCard = false;
      if (tapped && b.save_card && a?.family_id) {
        update('families', a.family_id, { card_brand: tapped.brand, card_last4: tapped.last4, card_exp: tapped.exp });
        savedCard = true;
      }
      const id = insert('sales', { location_id: loc.id, athlete_id: a?.id || null, family_id: a?.family_id || null, items: JSON.stringify(lines), total_cents: total, discount_cents: discount, method, status: 'paid', charge_id: r.charge_id, staff_id: req.staff.id });
      return { r, id, savedCard };
    });
    if (!result.r.ok) {
      log(req, 'Sale payment declined', `${a ? fullName(a) : 'Walk-in'} · ${money(total)} · ${METHOD_LABEL[method]}`);
      throw bad(`${result.r.error || 'Card declined.'} Try Tap to Pay, the reader or cash.`);
    }
    log(req, 'Took payment', `${a ? fullName(a) : 'Walk-in'} · ${money(total)} · ${description} · ${loc.name} · ${METHOD_LABEL[method]}${reader ? ` (${reader.label})` : ''}`);
    if (result.savedCard) log(req, 'Saved card', `${a.first_name}'s family · ${tapped.brand} ••${tapped.last4}`);
    if (discount) log(req, 'Gave discount', `${a ? fullName(a) : 'Walk-in'} · ${money(discount)} off ${money(subtotal)}${d.reason ? ` · ${String(d.reason).trim().slice(0, 60)}` : ''}`);
    let emailed = null;
    if (receiptTo) emailed = sendReceipt(req, get('SELECT * FROM sales WHERE id=?', result.id), receiptTo);
    res.json({ ok: true, sale: saleById(result.id, req.staff), saved_card: result.savedCard, receipt_to: emailed,
      message: `${money(total)} paid${result.savedCard ? '. Card saved to the family' : ''}${emailed ? `. Receipt sent to ${emailed}` : ''}.` });
  }));

  // ---- monthly memberships at the counter ----
  // Plans with prices for the sale screen (all staff see prices here, as with products).
  api.get('/pos/memberships', requireStaff(), (_req, res) => {
    res.json(all('SELECT id, name, price_cents, trial_days, group_per_month, private_per_month FROM plans WHERE active=1 ORDER BY price_cents'));
  });

  // Start a monthly membership. It renews on the family's card, so the card used here is saved to the family.
  api.post('/sales/membership', requireStaff(), h(async (req, res) => {
    const b = req.body || {};
    const method = b.method;
    if (method === 'cash') throw bad('Monthly memberships renew on a card. Use Tap to Pay, the reader or the card on file.');
    if (!['tap', 'reader', 'card'].includes(method)) throw bad('Choose how they\'re paying.');
    const loc = get('SELECT * FROM locations WHERE id=? AND archived=0', b.location_id);
    if (!loc) throw bad('Choose where you are.');
    if (!(loc.address && loc.address.trim())) throw bad(`Card payments need an address for ${loc.name}. Add one in Point of sale setup.`);
    const a = get('SELECT * FROM athletes WHERE id=? AND archived=0', b.athlete_id);
    if (!a) throw bad('Choose who the membership is for.');
    if (!a.family_id) throw bad(`${a.first_name} has no family account to bill. Add them as a client with a parent first.`);
    const plan = get('SELECT * FROM plans WHERE id=? AND active=1', b.plan_id);
    if (!plan) throw bad('That membership is no longer offered. Refresh and try again.');
    if (billing.activeMembership(a.id)) throw bad(`${a.first_name} already has a membership. Change it on their client profile.`);

    let tapped = null;
    if (method === 'card') {
      const f = get('SELECT card_last4 FROM families WHERE id=?', a.family_id);
      if (!f?.card_last4) throw bad(`${a.first_name}'s family has no card on file. Use Tap to Pay or the reader.`);
    } else {
      if (method === 'reader' && !get('SELECT 1 FROM readers WHERE location_id=?', loc.id)) throw bad(`No front-desk reader is registered at ${loc.name}. Use Tap to Pay, or add a reader in Point of sale setup.`);
      // Tapped or inserted card (simulated in test mode; Stripe Terminal when live).
      tapped = { brand: String(b.card?.brand || 'Visa').slice(0, 20), last4: String(b.card?.last4 || '4242').replace(/\D/g, '').slice(-4) || '4242', exp: b.card?.exp || '12/29' };
      if (tapped.last4 === '0002') throw bad('Card declined. Ask for another card.');
    }

    // All or nothing: a declined first charge leaves no membership, no saved card and nothing to retry.
    const result = tx(() => {
      if (tapped) update('families', a.family_id, { card_brand: tapped.brand, card_last4: tapped.last4, card_exp: tapped.exp });
      const r = billing.startMembership(a.id, plan.id);
      if (!r.ok) throw bad(`${r.error || 'Card declined.'} Ask for another card.`);
      return r;
    });
    const m = get('SELECT * FROM memberships WHERE id=?', result.id);
    const card = get('SELECT card_brand, card_last4 FROM families WHERE id=?', a.family_id);
    const cardText = `${card.card_brand} ••${card.card_last4}`;
    log(req, 'Started membership', `${fullName(a)} · ${plan.name} · ${loc.name} · ${METHOD_LABEL[method]}`);
    if (tapped) log(req, 'Saved card', `${a.first_name}'s family · ${cardText}`);
    const when = new Date(m.next_charge + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    res.json({
      ok: true, membership_id: m.id, status: m.status, next_charge: m.next_charge,
      message: result.trial
        ? `${a.first_name} is on ${plan.name}. Free trial until ${when}, then ${money(plan.price_cents)} a month on ${cardText}.`
        : `${money(plan.price_cents)} paid. ${a.first_name}'s ${plan.name} renews on ${when} on ${cardText}.`,
    });
  }));

  // Refund all or part of a sale (owners), with an optional reason for the activity log.
  api.post('/sales/:id/refund', requireStaff('owner'), h(async (req, res) => {
    const s = get('SELECT * FROM sales WHERE id=?', req.params.id);
    if (!s) throw notFound('That sale');
    if (!['paid', 'partial_refund'].includes(s.status)) throw bad('That sale has nothing left to refund.');
    const left = s.total_cents - (s.refunded_cents || 0);
    const amount = req.body?.amount_cents == null || req.body.amount_cents === '' ? left : cents(req.body.amount_cents);
    if (!(amount > 0)) throw bad('Enter an amount to refund.');
    if (amount > left) throw bad(`You can refund up to ${money(left)}.`);
    const reason = String(req.body?.reason || '').trim().slice(0, 120);
    refundSale(s, amount);
    const who = s.athlete_id ? fullName(get('SELECT first_name,last_name FROM athletes WHERE id=?', s.athlete_id)) : 'Walk-in';
    log(req, 'Refunded sale', `${who} · ${money(amount)} of ${money(s.total_cents)} · ${METHOD_LABEL[s.method]}${reason ? ` · ${reason}` : ''}`);
    res.json({ ok: true, message: `Refunded ${money(amount)}.${s.method === 'cash' ? ' Hand back the cash.' : ''}` });
  }));

  // Undo a sale you just rang up by mistake: a full refund, allowed for the person who took it for ${UNDO_MINUTES} minutes.
  api.post('/sales/:id/undo', requireStaff(), h(async (req, res) => {
    const s = saleFor(req, req.params.id);
    if (s.staff_id !== req.staff.id) throw bad(req.staff.role === 'owner' ? 'Only the person who took this sale can undo it. Refund it instead.' : 'Only the person who took this sale can undo it. Ask the owner for a refund.');
    if (s.status !== 'paid' || s.refunded_cents > 0) throw bad('That sale has already been refunded.');
    const age = get("SELECT (julianday('now') - julianday(?)) * 1440 AS m", s.created_at).m;
    if (age > UNDO_MINUTES) throw bad(`Sales can be undone for ${UNDO_MINUTES} minutes. Ask the owner for a refund.`);
    refundSale(s, s.total_cents);
    const who = s.athlete_id ? fullName(get('SELECT first_name,last_name FROM athletes WHERE id=?', s.athlete_id)) : 'Walk-in';
    log(req, 'Undid sale', `${who} · ${money(s.total_cents)} · ${METHOD_LABEL[s.method]}`);
    res.json({ ok: true, message: `Sale undone. ${money(s.total_cents)} ${s.method === 'cash' ? 'to hand back in cash' : 'goes back to the card'}.` });
  }));

  // Email (or re-send) a receipt. Defaults to the family's billing email.
  api.post('/sales/:id/receipt', requireStaff(), h(async (req, res) => {
    const s = saleFor(req, req.params.id);
    if (s.status === 'failed') throw bad('That payment didn\'t go through, so there is no receipt.');
    const to = String(req.body?.email || '').trim() || (s.family_id ? billing.billingEmail(s.family_id) : '');
    const sent = sendReceipt(req, s, to);
    res.json({ ok: true, email: sent, message: `Receipt sent to ${sent}.` });
  }));
}

module.exports = { routes };
