// Point of sale: locations, products, front-desk readers, sales and refunds.
'use strict';
const { get, all, run, insert, update, tx } = require('../db');
const { h, bad, notFound, log, money, payments } = require('../lib');
const { requireStaff } = require('../auth');
const billing = require('../services/billing');
const { fullName } = require('../services/floor-util');

const LOCATION_KINDS = ['facility', 'mobile', 'park', 'school'];
const PRODUCT_KINDS = ['session', 'group_pack', 'private_pack', 'gear', 'other'];
const METHOD_LABEL = { tap: 'Tap to Pay', reader: 'Front-desk reader', card: 'Card on file', cash: 'Cash' };
const TEST_READER_CODE = 'simulated-wpe';

const cents = (v) => (v === '' || v == null ? null : Math.round(Number(v)));
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

function saleRow(s) {
  let items = [];
  try { items = JSON.parse(s.items || '[]'); } catch { /* keep empty */ }
  const card = s.method === 'card' || s.method === 'tap' || s.method === 'reader'
    ? (s.family_id ? get('SELECT card_brand, card_last4 FROM families WHERE id=?', s.family_id) : null) : null;
  return {
    id: s.id, created_at: s.created_at, location_id: s.location_id, location: s.location, athlete_id: s.athlete_id,
    who: s.first_name ? `${s.first_name} ${s.last_name}` : 'Walk-in', items, total_cents: s.total_cents, refunded_cents: s.refunded_cents || 0,
    method: s.method, method_label: METHOD_LABEL[s.method], card_last4: s.method === 'card' ? card?.card_last4 || null : null,
    status: s.status, staff: s.staff, booking_id: s.booking_id,
  };
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
    if (b.name !== undefined) { patch.name = String(b.name).trim(); if (!patch.name) throw bad('Give the location a name.'); }
    if (b.kind !== undefined) { if (!LOCATION_KINDS.includes(b.kind)) throw bad('Choose facility, mobile or park.'); patch.kind = b.kind; }
    if (b.address !== undefined || b.street !== undefined) patch.address = composeAddress(b) || null;
    if (b.archived !== undefined) patch.archived = b.archived ? 1 : 0;
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
    res.json({ id: a.id, code: a.code, first_name: a.first_name, last_name: a.last_name, family_id: f?.id || null, family: f?.name || null,
      card: f?.card_last4 ? { brand: f.card_brand, last4: f.card_last4 } : null, group_credits: a.group_credits, private_credits: a.private_credits });
  }));

  // ---- sales ----
  api.get('/sales',requireStaff(), h(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 366);
    const rows = all(`SELECT s.*, l.name AS location, a.first_name, a.last_name, st.name AS staff FROM sales s
      LEFT JOIN locations l ON l.id=s.location_id LEFT JOIN athletes a ON a.id=s.athlete_id LEFT JOIN staff st ON st.id=s.staff_id
      WHERE s.created_at >= datetime('now', ?) ${req.query.athlete_id ? 'AND s.athlete_id=' + Number(req.query.athlete_id) : ''}
      ORDER BY s.id DESC LIMIT 200`, `-${days} days`);
    res.json(rows.map(saleRow));
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
    const total = lines.reduce((n, l) => n + l.price_cents * l.qty, 0);

    if (method === 'card') {
      if (!a?.family_id) throw bad('Card on file needs a client. Choose who you\'re with.');
      const f = get('SELECT card_last4 FROM families WHERE id=?', a.family_id);
      if (!f?.card_last4) throw bad(`${a.first_name}'s family has no card on file. Use Tap to Pay, the reader or cash.`);
    }
    let reader = null;
    if (method === 'reader') {
      reader = get('SELECT * FROM readers WHERE location_id=? ORDER BY id LIMIT 1', loc.id) || get('SELECT * FROM readers ORDER BY id LIMIT 1');
      if (!reader) throw bad('No front-desk reader is registered. Add one in Point of sale setup.');
    }
    // Tapped or inserted card (simulated in test mode; Stripe Terminal when live).
    const tapped = method === 'tap' || method === 'reader'
      ? { brand: String(b.card?.brand || 'Visa').slice(0, 20), last4: String(b.card?.last4 || '4242').replace(/\D/g, '').slice(-4) || '4242', exp: b.card?.exp || '12/29' } : null;
    if (tapped && tapped.last4 === '0002') throw bad('Card declined. Ask for another card or take cash.');

    const description = lines.map((l) => (l.qty > 1 ? `${l.qty} × ${l.name}` : l.name)).join(', ');
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
      const id = insert('sales', { location_id: loc.id, athlete_id: a?.id || null, family_id: a?.family_id || null, items: JSON.stringify(lines), total_cents: total, method, status: 'paid', charge_id: r.charge_id, staff_id: req.staff.id });
      return { r, id, savedCard };
    });
    if (!result.r.ok) {
      log(req, 'Sale payment declined', `${a ? fullName(a) : 'Walk-in'} · ${money(total)} · ${METHOD_LABEL[method]}`);
      throw bad(`${result.r.error || 'Card declined.'} Try Tap to Pay, the reader or cash.`);
    }
    log(req, 'Took payment', `${a ? fullName(a) : 'Walk-in'} · ${money(total)} · ${description} · ${loc.name} · ${METHOD_LABEL[method]}${reader ? ` (${reader.label})` : ''}`);
    if (result.savedCard) log(req, 'Saved card', `${a.first_name}'s family · ${tapped.brand} ••${tapped.last4}`);
    const row = get(`SELECT s.*, l.name AS location, a.first_name, a.last_name, st.name AS staff FROM sales s LEFT JOIN locations l ON l.id=s.location_id
      LEFT JOIN athletes a ON a.id=s.athlete_id LEFT JOIN staff st ON st.id=s.staff_id WHERE s.id=?`, result.id);
    res.json({ ok: true, sale: saleRow(row), saved_card: result.savedCard, message: `${money(total)} paid${result.savedCard ? '. Card saved to the family' : ''}.` });
  }));

  // Refund all or part of a sale (owners).
  api.post('/sales/:id/refund', requireStaff('owner'), h(async (req, res) => {
    const s = get('SELECT * FROM sales WHERE id=?', req.params.id);
    if (!s) throw notFound('That sale');
    if (!['paid', 'partial_refund'].includes(s.status)) throw bad('That sale has nothing left to refund.');
    const left = s.total_cents - (s.refunded_cents || 0);
    const amount = req.body?.amount_cents == null || req.body.amount_cents === '' ? left : cents(req.body.amount_cents);
    if (!(amount > 0)) throw bad('Enter an amount to refund.');
    if (amount > left) throw bad(`You can refund up to ${money(left)}.`);
    tx(() => {
      const inv = s.charge_id ? get("SELECT * FROM invoices WHERE charge_id=? AND status='paid' AND amount_cents>0 ORDER BY id LIMIT 1", s.charge_id) : null;
      if (inv) billing.refundInvoice(inv.id, amount);
      const refunded = (s.refunded_cents || 0) + amount;
      const full = refunded >= s.total_cents;
      update('sales', s.id, { refunded_cents: refunded, status: full ? 'refunded' : 'partial_refund' });
      if (full) {
        // Take back unused pack credits and reopen a collected drop-in.
        let lines = [];
        try { lines = JSON.parse(s.items || '[]'); } catch { /* none */ }
        if (s.athlete_id) for (const l of lines) {
          if (l.kind === 'group_pack' || (l.kind === 'session' && l.product_id)) run('UPDATE athletes SET group_credits=MAX(0, group_credits-?) WHERE id=?', (l.credits || 1) * (l.qty || 1), s.athlete_id);
          if (l.kind === 'private_pack') run('UPDATE athletes SET private_credits=MAX(0, private_credits-?) WHERE id=?', (l.credits || 1) * (l.qty || 1), s.athlete_id);
        }
        if (s.booking_id) run("UPDATE bookings SET coverage='unpaid', paid_cents=0 WHERE id=? AND coverage='paid'", s.booking_id);
      }
    });
    const who = s.athlete_id ? fullName(get('SELECT first_name,last_name FROM athletes WHERE id=?', s.athlete_id)) : 'Walk-in';
    log(req, 'Refunded sale', `${who} · ${money(amount)} of ${money(s.total_cents)} · ${METHOD_LABEL[s.method]}`);
    res.json({ ok: true, message: `Refunded ${money(amount)}.${s.method === 'cash' ? ' Hand back the cash.' : ''}` });
  }));
}

module.exports = { routes };
