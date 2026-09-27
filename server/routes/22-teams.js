// Teams: school and club contracts, their invoices, roster and team sessions. Owner only.
'use strict';
const { get, all, run, insert, update, tx } = require('../db');
const { h, bad, notFound, log, makeAthleteCode, randomToken, money, today, addDays, addMonths } = require('../lib');
const { requireStaff } = require('../auth');
const booking = require('../services/booking');
const schools = require('../services/money-schools');
const { gradYear } = require('../services/clients');

const owner = requireStaff('owner');
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const KINDS = ['school', 'club'];
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
function phoneFrom(v) {
  const p = clean(v);
  if (p && (p.length > 30 || !/^[\d\s().+\-x]+$/i.test(p) || (p.match(/\d/g) || []).length < 7)) throw bad('That phone number doesn\'t look right.', { field: 'billing_phone' });
  return p;
}
const kindFrom = (v) => (KINDS.includes(v) ? v : 'school');
const toCents = (v) => Math.round(Number(String(v ?? '').replace(/[$,\s]/g, '')) * 100);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
function feeFrom(b) {
  const c = b.monthly_cents != null && b.monthly_cents !== '' ? Math.round(Number(b.monthly_cents)) : toCents(b.monthly_fee);
  if (!(c > 0)) throw bad('Enter the monthly fee.', { field: 'monthly_fee' });
  if (c > 10000000) throw bad('That monthly fee looks too high. Check the amount.', { field: 'monthly_fee' });
  return c;
}
function terms(v) {
  const n = Number(v ?? 30);
  if (!Number.isInteger(n) || n < 0 || n > 120) throw bad('Payment terms must be 0–120 days.', { field: 'terms_days' });
  return n;
}

function contractOr404(id) {
  const c = schools.contractWithSchool(Number(id));
  if (!c) throw notFound('That contract');
  return c;
}

function invoiceView(inv) {
  return { ...inv, emailed_at: schools.emailedAt(inv), overdue: inv.status === 'open' && inv.due_date && inv.due_date < today(),
    period_end: inv.period ? schools.periodEnd(inv.period) : null };
}

function rosterWithAttendance(teamId) {
  const now = booking.nowLocal();
  return all(`SELECT a.id, a.code, a.first_name, a.last_name, a.position, a.grad_year, a.sport, a.family_id, a.created_at,
      (a.email IS NOT NULL AND a.email<>'') OR EXISTS (SELECT 1 FROM parents p WHERE p.family_id=a.family_id) AS reachable,
      (SELECT MAX(e.starts_at) FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=a.id AND e.team_id=? AND b.checked_in_at IS NOT NULL) AS last_seen,
      (SELECT COUNT(*) FROM events e WHERE e.team_id=? AND e.type='team' AND e.cancelled=0 AND e.starts_at < ? AND e.starts_at >= MIN(substr(a.created_at,1,10),
        COALESCE((SELECT MIN(substr(e2.starts_at,1,10)) FROM bookings b2 JOIN events e2 ON e2.id=b2.event_id WHERE b2.athlete_id=a.id AND e2.team_id=e.team_id), '9999'))) AS sessions,
      (SELECT COUNT(*) FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=a.id AND e.team_id=? AND e.type='team' AND b.checked_in_at IS NOT NULL) AS attended
    FROM athletes a WHERE a.team_id=? AND a.archived=0 ORDER BY a.last_name COLLATE NOCASE, a.first_name COLLATE NOCASE`, teamId, teamId, now, teamId, teamId)
    .map((r) => ({ ...r, reachable: !!r.reachable, attendance_rate: r.sessions ? Math.min(1, r.attended / r.sessions) : null }));
}
// Team attendance: the roster's average rate (athletes with at least one session).
function teamRate(roster) {
  const rated = roster.filter((a) => a.attendance_rate != null);
  return rated.length ? rated.reduce((s, a) => s + a.attendance_rate, 0) / rated.length : null;
}
// The last few team sessions that have happened, with how many were checked in.
function recentSessions(teamId, n = 8) {
  // roster: who was on the team that day (on the roster now and added by then, or booked into it), so athletes added
  // later don't make old sessions look empty.
  return all(`SELECT e.id, e.starts_at, (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.checked_in_at IS NOT NULL) AS here,
      (SELECT COUNT(*) FROM athletes a WHERE a.archived=0 AND (a.team_id=e.team_id AND substr(a.created_at,1,10) <= substr(e.starts_at,1,10)
        OR EXISTS (SELECT 1 FROM bookings b WHERE b.event_id=e.id AND b.athlete_id=a.id))) AS roster
    FROM events e WHERE e.team_id=? AND e.type='team' AND e.cancelled=0 AND e.starts_at < ? ORDER BY e.starts_at DESC LIMIT ?`, teamId, booking.nowLocal(), n);
}

// Roster paste: one athlete per line, "Name, position, grad year" (tabs from a spreadsheet work too). Leading list
// numbers or jersey numbers ("1.", "#12") are dropped. Each line says what will happen to it.
function parseRoster(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line, n) => {
    const parts = line.split(/\t|,/).map((x) => x.trim());
    const names = parts[0].replace(/^(#\s*\d{1,3}|\d{1,3}[.)])\s+/, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (names.length < 2) return { n, line, error: `Line ${n + 1} needs a first and last name: "${line}"` };
    const extra = parts.slice(1).filter(Boolean);
    let grad_year = null, position = null, error = null;
    for (const x of extra) {
      const y = x.match(/^(?:class of\s+)?'?(\d{4})$/i);
      if (y) { try { grad_year = gradYear(y[1]); } catch { error = `Line ${n + 1}: ${y[1]} doesn't look like a grad year.`; } }
      else if (!position) position = x.slice(0, 40);
    }
    return { n, line, first: names[0].slice(0, 60), last: names.slice(1).join(' ').slice(0, 60), position, grad_year, error };
  });
}
function planRoster(c, text) {
  const rows = parseRoster(text);
  const seen = new Set();
  for (const r of rows) {
    if (r.error) { r.status = 'error'; continue; }
    const key = `${r.first} ${r.last}`.toLowerCase();
    const onRoster = get('SELECT id, code FROM athletes WHERE team_id=? AND archived=0 AND first_name=? COLLATE NOCASE AND last_name=? COLLATE NOCASE', c.id, r.first, r.last);
    if (onRoster || seen.has(key)) { r.status = 'skip'; r.existing = onRoster || null; continue; }
    seen.add(key);
    r.matches = all(`SELECT a.id, a.code, a.first_name, a.last_name, a.school, a.grad_year, t.team_name
      FROM athletes a LEFT JOIN team_contracts t ON t.id=a.team_id
      WHERE a.archived=0 AND (a.team_id IS NULL OR a.team_id<>?) AND a.first_name=? COLLATE NOCASE AND a.last_name=? COLLATE NOCASE ORDER BY a.id LIMIT 5`, c.id, r.first, r.last);
    r.status = r.matches.length ? 'match' : 'new';
  }
  return rows;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function routes(api) {
  api.get('/schools', owner, (_req, res) => res.json(all('SELECT * FROM schools ORDER BY name COLLATE NOCASE')));

  api.post('/schools', owner, h(async (req, res) => {
    const b = req.body || {};
    const name = clean(b.name);
    if (!name) throw bad('Enter the school or club name.');
    if (b.contact_email && !EMAIL_RE.test(b.contact_email)) throw bad('That billing email doesn\'t look right.');
    const id = insert('schools', { name, kind: kindFrom(b.kind), contact_name: clean(b.contact_name), contact_email: clean(b.contact_email)?.toLowerCase() || null,
      contact_phone: phoneFrom(b.contact_phone), address: clean(b.address) });
    log(req, 'Added school or club', name);
    res.status(201).json({ id });
  }));

  api.get('/teams', owner, (_req, res) => {
    const T = today();
    const contracts = all(`SELECT t.*, s.name AS school_name, s.kind AS school_kind, s.contact_email,
        (SELECT COUNT(*) FROM athletes a WHERE a.team_id=t.id AND a.archived=0) AS athletes,
        (SELECT COALESCE(SUM(amount_cents),0) FROM invoices i WHERE i.contract_id=t.id AND i.status='open') AS open_cents,
        (SELECT COALESCE(SUM(amount_cents),0) FROM invoices i WHERE i.contract_id=t.id AND i.status='open' AND i.due_date < ?) AS overdue_cents,
        (SELECT COALESCE(SUM(amount_cents),0) FROM invoices i WHERE i.contract_id=t.id AND i.status='paid') AS paid_cents,
        (SELECT MAX(paid_at) FROM invoices i WHERE i.contract_id=t.id AND i.status='paid') AS last_paid_at
      FROM team_contracts t JOIN schools s ON s.id=t.school_id ORDER BY t.status, s.name COLLATE NOCASE, t.team_name`, T)
      .map((c) => {
        const roster = c.athletes ? rosterWithAttendance(c.id) : [];
        const rate = teamRate(roster);
        return { ...c, next_invoice: schools.nextInvoiceDate(c), has_billing_email: !!(c.billing_email || c.contact_email), attendance_rate: rate };
      });
    const unpaid = all(`SELECT i.*, t.team_name, s.name AS school_name FROM invoices i JOIN team_contracts t ON t.id=i.contract_id JOIN schools s ON s.id=t.school_id
      WHERE i.kind='school' AND i.status='open' ORDER BY i.due_date, i.id`).map(invoiceView);
    const active = contracts.filter((c) => c.status === 'active');
    const since = addDays(T, -30);
    res.json({
      metrics: {
        monthly_cents: active.reduce((s, c) => s + c.monthly_cents, 0), active_teams: active.length,
        waiting_cents: unpaid.reduce((s, i) => s + i.amount_cents, 0), waiting_count: unpaid.length,
        overdue_cents: unpaid.filter((i) => i.overdue).reduce((s, i) => s + i.amount_cents, 0), overdue_count: unpaid.filter((i) => i.overdue).length,
        athletes: active.reduce((s, c) => s + c.athletes, 0),
        collected_30_cents: get("SELECT COALESCE(SUM(amount_cents),0) AS n FROM invoices WHERE kind='school' AND status='paid' AND substr(paid_at,1,10) >= ?", since).n,
      },
      contracts, unpaid,
    });
  });

  // "Email reminders now": every overdue school invoice, without waiting for the weekly reminder.
  api.post('/teams/remind-overdue', owner, h(async (req, res) => {
    const r = schools.remindOverdueNow();
    if (!r.sent && !r.skipped) throw bad('Nothing is overdue, so there is nobody to remind.');
    log(req, 'Emailed overdue reminders', `${r.sent} sent${r.skipped ? `, ${r.skipped} with no billing email` : ''}`);
    res.json(r);
  }));

  api.post('/teams', owner, h(async (req, res) => {
    const b = req.body || {};
    const existingSchool = b.school_id && b.school_id !== 'new' ? Number(b.school_id) : null;
    if (!existingSchool && !clean(b.school_name)) throw bad('Enter the school or club name.', { field: 'school_name' });
    const billing_email = clean(b.billing_email)?.toLowerCase() || null;
    if (billing_email && !EMAIL_RE.test(billing_email)) throw bad('That billing email doesn\'t look right.', { field: 'billing_email' });
    const billing_phone = phoneFrom(b.billing_phone);
    const team_name = clean(b.team_name);
    if (!team_name) throw bad('Enter the team name.', { field: 'team_name' });
    const monthly_cents = feeFrom(b);
    const start_date = b.start_date || today();
    if (!isDate(start_date)) throw bad('Choose a start date.', { field: 'start_date' });
    const end_date = clean(b.end_date);
    if (end_date && (!isDate(end_date) || end_date < start_date)) throw bad('The end date must be after the start date.', { field: 'end_date' });
    const terms_days = terms(b.terms_days);
    // Months that started before today: invoice them all (default), only the current one, or none (billed elsewhere).
    const past = ['all', 'current', 'none'].includes(b.past) ? b.past : 'all';
    let bill_from = null;
    if (start_date < today() && past !== 'all') {
      const starts = schools.periodStarts({ start_date, end_date }, today());
      bill_from = past === 'current' ? starts[starts.length - 1] : (schools.nextInvoiceDate({ status: 'active', start_date, end_date }) || addDays(today(), 1));
    }
    const id = tx(() => {
      let schoolId = existingSchool;
      if (schoolId) { if (!get('SELECT 1 FROM schools WHERE id=?', schoolId)) throw bad('Choose a school or club.', { field: 'school_id' }); }
      else schoolId = insert('schools', { name: clean(b.school_name), kind: kindFrom(b.kind), contact_name: clean(b.billing_name), contact_email: billing_email, contact_phone: billing_phone, address: clean(b.address) });
      const school = get('SELECT * FROM schools WHERE id=?', schoolId);
      const dup = get("SELECT 1 FROM team_contracts WHERE school_id=? AND status='active' AND team_name=? COLLATE NOCASE", schoolId, team_name);
      if (dup) throw bad(`${school.name} already has an active ${team_name} contract. Open it from Teams, or use a different team name.`, { field: 'team_name' });
      if (existingSchool) {
        const patch = {};
        if (clean(b.address)) patch.address = clean(b.address);
        if (b.kind && KINDS.includes(b.kind)) patch.kind = b.kind;
        if (Object.keys(patch).length) update('schools', schoolId, patch);
      }
      return insert('team_contracts', {
        school_id: schoolId, team_name, monthly_cents, start_date, end_date, terms_days, po_number: clean(b.po_number),
        billing_name: clean(b.billing_name) || school.contact_name, billing_email: billing_email || school.contact_email,
        billing_phone: billing_phone || school.contact_phone || null, billing_day: Number(start_date.slice(8, 10)), bill_from, notes: clean(b.notes),
      });
    });
    const invoiced = schools.invoiceContract(id);
    const c = schools.contractWithSchool(id);
    log(req, 'Created team contract', `${c.school_name} ${team_name}${invoiced.length ? `; ${invoiced.length} invoice${invoiced.length > 1 ? 's' : ''} sent` : ''}`);
    res.status(201).json({ id, invoices: invoiced.length, emailed: invoiced.length > 0 && !!schools.billTo(c) });
  }));

  api.get('/teams/:id', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const invoices = all("SELECT * FROM invoices WHERE contract_id=? ORDER BY issued_at DESC, id DESC", c.id).map(invoiceView);
    const sessions = all(`SELECT c.*, l.name AS location, st.name AS coach FROM classes c LEFT JOIN locations l ON l.id=c.location_id LEFT JOIN staff st ON st.id=c.coach_id
        WHERE c.team_id=? AND c.archived=0 ORDER BY c.id`, c.id)
      .map((s) => ({ ...s, days: String(s.weekdays).split(',').map((d) => WD[+d]).join(', '),
        next: get('SELECT starts_at FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=? ORDER BY starts_at LIMIT 1', s.id, booking.nowLocal())?.starts_at || null }));
    const roster = rosterWithAttendance(c.id);
    res.json({
      contract: { ...c, next_invoice: schools.nextInvoiceDate(c) },
      invoices, unpaid_cents: invoices.filter((i) => i.status === 'open').reduce((s, i) => s + i.amount_cents, 0),
      paid_cents: invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + i.amount_cents, 0),
      roster, sessions, team_rate: teamRate(roster), recent_sessions: recentSessions(c.id),
      locations: all('SELECT id, name FROM locations WHERE archived=0 ORDER BY id'),
      coaches: all("SELECT id, name FROM staff WHERE active=1 AND role IN ('owner','coach') ORDER BY name COLLATE NOCASE"),
    });
  }));

  api.put('/teams/:id', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const b = req.body || {};
    const patch = {}, school = {}, changed = [];
    if ('monthly_fee' in b || 'monthly_cents' in b) { patch.monthly_cents = feeFrom(b); if (patch.monthly_cents !== c.monthly_cents) changed.push('new monthly fee from the next invoice'); }
    if ('end_date' in b) {
      patch.end_date = clean(b.end_date);
      if (patch.end_date && (!isDate(patch.end_date) || patch.end_date < c.start_date)) throw bad('The end date must be after the start date.', { field: 'end_date' });
      if ((patch.end_date || null) !== (c.end_date || null)) changed.push(patch.end_date ? `ends ${patch.end_date}` : 'no end date');
      else delete patch.end_date;
    }
    if ('terms_days' in b) patch.terms_days = terms(b.terms_days);
    if ('po_number' in b) patch.po_number = clean(b.po_number);
    if ('team_name' in b) {
      patch.team_name = clean(b.team_name);
      if (!patch.team_name) throw bad('Enter the team name.', { field: 'team_name' });
      if (patch.team_name.length > 80) throw bad('Keep the team name under 80 characters.', { field: 'team_name' });
      if (patch.team_name !== c.team_name) changed.push(`renamed ${patch.team_name}`);
    }
    if ('billing_name' in b) patch.billing_name = clean(b.billing_name);
    if ('billing_email' in b) {
      patch.billing_email = clean(b.billing_email)?.toLowerCase() || null;
      if (patch.billing_email && !EMAIL_RE.test(patch.billing_email)) throw bad('That billing email doesn\'t look right.', { field: 'billing_email' });
    }
    if ('billing_phone' in b) patch.billing_phone = phoneFrom(b.billing_phone);
    if ('notes' in b) { patch.notes = clean(b.notes); if (patch.notes && patch.notes.length > 2000) throw bad('Keep notes under 2,000 characters.', { field: 'notes' }); }
    if ('address' in b) school.address = clean(b.address);
    if ('kind' in b && KINDS.includes(b.kind)) school.kind = b.kind;
    if ('school_name' in b) { school.name = clean(b.school_name); if (!school.name) throw bad('Enter the school or club name.', { field: 'school_name' }); }
    // An ended contract whose end date is cleared or moved to today or later starts again. Months it was ended for
    // are not back-billed: invoicing picks up on the next billing day.
    let restarted = null;
    if (c.status === 'ended' && patch.end_date !== undefined && (!patch.end_date || patch.end_date >= today())) {
      patch.status = 'active';
      const T = today();
      for (let k = 0; k < 240; k++) { const p = addMonths(c.start_date, k); if (p >= T) { restarted = p; break; } }
      patch.bill_from = restarted;
      changed.push('restarted');
    }
    const newEnd = patch.end_date !== undefined ? patch.end_date : undefined;
    tx(() => {
      update('team_contracts', c.id, patch);
      if (Object.keys(school).length) update('schools', c.school_id, school);
      if ('team_name' in patch && patch.team_name !== c.team_name) run("UPDATE classes SET name=? WHERE team_id=? AND type='team'", `${patch.team_name} team session`, c.id);
      // Team sessions follow the contract's end date: a shorter contract takes later sessions off the schedule.
      if (newEnd !== undefined && (c.status === 'active' || patch.status === 'active')) {
        run('UPDATE classes SET end_date=? WHERE team_id=? AND archived=0', newEnd, c.id);
        if (newEnd) run("UPDATE events SET cancelled=1, cancel_reason='After the team contract ends' WHERE team_id=? AND type='team' AND cancelled=0 AND starts_at>? AND starts_at>?", c.id, `${newEnd}T23:59`, booking.nowLocal());
        // A longer contract brings back sessions an earlier, shorter end date took off.
        run("UPDATE events SET cancelled=0, cancel_reason=NULL WHERE team_id=? AND type='team' AND cancelled=1 AND cancel_reason='After the team contract ends' AND starts_at>? AND (? IS NULL OR starts_at<=?)",
          c.id, booking.nowLocal(), newEnd, `${newEnd}T23:59`);
      }
    });
    if (newEnd !== undefined) booking.generateEvents();
    log(req, 'Updated team contract', `${c.school_name} ${patch.team_name || c.team_name}${changed.length ? `: ${changed.join(', ')}` : ''}`);
    res.json({ ok: true, restarted: !!restarted, bill_from: restarted });
  }));

  api.post('/teams/:id/end', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    if (c.status === 'ended') throw bad('That contract has already ended.');
    const end = c.end_date && c.end_date < today() ? c.end_date : today();
    const cancelled = tx(() => {
      update('team_contracts', c.id, { status: 'ended', end_date: end });
      run('UPDATE classes SET archived=1 WHERE team_id=?', c.id);
      return Number(run("UPDATE events SET cancelled=1, cancel_reason='Team contract ended' WHERE team_id=? AND type='team' AND cancelled=0 AND starts_at>?", c.id, booking.nowLocal()).changes || 0);
    });
    log(req, 'Ended team contract', `${c.school_name} ${c.team_name}`);
    res.json({ ok: true, sessions_cancelled: cancelled });
  }));

  // Email the billing contact a statement: every open invoice on the contract with its link, and the total.
  api.post('/teams/:id/statement', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const r = schools.emailStatement(c.id);
    log(req, 'Emailed statement', `${c.school_name} ${c.team_name}: ${r.count} open, ${money(r.total_cents)} to ${r.to}`);
    res.json(r);
  }));

  // One check that covers several invoices on this contract.
  api.post('/teams/:id/record-payment', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const b = req.body || {};
    const ids = [...new Set([].concat(b.invoice_ids || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) throw bad('Choose the invoices this payment covers.');
    const invs = ids.map((id) => get('SELECT * FROM invoices WHERE id=? AND contract_id=?', id, c.id));
    if (invs.some((i) => !i)) throw bad('Those invoices aren\'t all on this contract.');
    const notOpen = invs.find((i) => i.status !== 'open');
    if (notOpen) throw bad(`${notOpen.number} is ${notOpen.status === 'paid' ? 'already paid' : 'void'}. Leave it out.`);
    const method = b.method || 'check';
    const paid = tx(() => invs.map((i) => schools.markPaid(i.id, { method, check_number: b.check_number, paid_on: b.paid_on || null })));
    const total = invs.reduce((s, i) => s + i.amount_cents, 0);
    log(req, 'Recorded invoice payment', `${invs.map((i) => i.number).join(', ')}: ${money(total)} by ${paid[0].pay_method}${paid[0].check_number ? ` #${paid[0].check_number}` : ''}`);
    res.json({ ok: true, count: paid.length, total_cents: total });
  }));

  // Paste one athlete per line: "Name, position, grad year" (position and year optional).
  // preview: true returns what each line will do (new, already on the roster, matches an existing client, or a
  // problem) without saving. links: { lineIndex: athleteId } puts an existing client on the team instead of a new one.
  api.post('/teams/:id/roster', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const text = typeof req.body === 'string' ? req.body : String(req.body?.text || '');
    if (text.length > 50000) throw bad('That list is too long. Paste up to a few hundred names at a time.');
    const rows = planRoster(c, text);
    if (!rows.length) throw bad('Paste at least one name, one per line.');
    if (req.body?.preview) {
      const count = (st) => rows.filter((r) => r.status === st).length;
      return res.json({ rows, counts: { new: count('new'), match: count('match'), skip: count('skip'), error: count('error') } });
    }
    const err = rows.find((r) => r.error);
    if (err) throw bad(err.error);
    const links = req.body?.links && typeof req.body.links === 'object' ? req.body.links : {};
    const result = tx(() => rows.map((p) => {
      if (p.status === 'skip') return { ...(p.existing || {}), existing: true };
      const linkId = Number(links[p.n]);
      if (linkId) {
        const m = (p.matches || []).find((x) => x.id === linkId);
        if (!m) throw bad(`Line ${p.n + 1}: choose one of the matching clients or add a new athlete.`);
        const cur = get('SELECT * FROM athletes WHERE id=?', m.id);
        update('athletes', m.id, { team_id: c.id, position: cur.position || p.position, grad_year: cur.grad_year || p.grad_year, school: cur.school || c.school_name });
        return { id: m.id, code: m.code, linked: true };
      }
      const code = makeAthleteCode(p.first, p.last);
      const id = insert('athletes', { code, first_name: p.first, last_name: p.last, position: p.position, grad_year: p.grad_year, team_id: c.id, school: c.school_name, workout_token: randomToken(12) });
      return { id, code };
    }));
    const n = result.filter((a) => !a.existing && !a.linked).length, linked = result.filter((a) => a.linked).length;
    log(req, 'Added to team roster', `${n} new${linked ? ` and ${linked} existing` : ''} athlete${n + linked === 1 ? '' : 's'} to ${c.school_name} ${c.team_name}`);
    res.status(201).json({ added: n, linked, skipped: result.filter((a) => a.existing).length, athletes: result });
  }));

  // Find an existing client to put on this team (name or Athlete ID).
  api.get('/teams/:id/athlete-search', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q.replace(/[%_]/g, '')}%`;
    res.json(all(`SELECT a.id, a.code, a.first_name, a.last_name, a.school, a.grad_year, a.position, t.team_name
      FROM athletes a LEFT JOIN team_contracts t ON t.id=a.team_id
      WHERE a.archived=0 AND (a.team_id IS NULL OR a.team_id<>?) AND (a.first_name || ' ' || a.last_name LIKE ? OR a.code LIKE ?)
      ORDER BY a.last_name COLLATE NOCASE, a.first_name COLLATE NOCASE LIMIT 12`, c.id, like, like));
  }));

  // Put one existing athlete on the roster (Add existing client, and Undo after a removal).
  api.post('/teams/:id/roster/add', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const a = get('SELECT * FROM athletes WHERE id=? AND archived=0', Number(req.body?.athlete_id));
    if (!a) throw notFound('That athlete');
    if (a.team_id === c.id) throw bad(`${a.first_name} ${a.last_name} is already on this roster.`);
    const from = a.team_id ? get('SELECT team_name FROM team_contracts WHERE id=?', a.team_id)?.team_name : null;
    update('athletes', a.id, { team_id: c.id, school: a.school || c.school_name });
    log(req, 'Added to team roster', `${a.first_name} ${a.last_name} to ${c.school_name} ${c.team_name}${from ? ` (moved from ${from})` : ''}`);
    res.json({ ok: true, moved_from: from });
  }));

  api.post('/teams/:id/roster/:athleteId/remove', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const a = get('SELECT * FROM athletes WHERE id=? AND team_id=?', Number(req.params.athleteId), c.id);
    if (!a) throw notFound('That athlete');
    update('athletes', a.id, { team_id: null });
    log(req, 'Removed from team roster', `${a.first_name} ${a.last_name}, ${c.team_name}`);
    res.json({ ok: true });
  }));

  // Put the team on the schedule: a weekly 'team' class, then sessions are generated.
  api.post('/teams/:id/sessions', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    if (c.status !== 'active') throw bad('This contract has ended.');
    const b = req.body || {};
    const days = [].concat(b.weekdays || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!days.length) throw bad('Choose at least one day.', { field: 'weekdays' });
    const start_time = String(b.start_time || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start_time)) throw bad('Choose a start time.', { field: 'start_time' });
    const duration = Number(b.duration_min || 60);
    if (!(duration >= 15 && duration <= 300)) throw bad('Sessions run 15–300 minutes.', { field: 'duration_min' });
    const start_date = b.start_date || today();
    if (!isDate(start_date)) throw bad('Choose the first day.', { field: 'start_date' });
    if (c.end_date && start_date > c.end_date) throw bad('The first day is after the contract ends.', { field: 'start_date' });
    const location_id = b.location_id ? Number(b.location_id) : null;
    if (location_id && !get('SELECT 1 FROM locations WHERE id=? AND archived=0', location_id)) throw bad('Choose a location.', { field: 'location_id' });
    const coach_id = b.coach_id ? Number(b.coach_id) : null;
    if (coach_id && !get("SELECT 1 FROM staff WHERE id=? AND active=1 AND role IN ('owner','coach')", coach_id)) throw bad('Choose a coach.', { field: 'coach_id' });
    const id = insert('classes', {
      name: `${c.team_name} team session`, type: 'team', weekdays: [...new Set(days)].sort().join(','), start_time, duration_min: duration,
      capacity: Math.max(60, rosterWithAttendance(c.id).length), price_cents: 0, start_date, end_date: c.end_date, location_id, team_id: c.id, coach_id,
    });
    const made = booking.generateEvents();
    log(req, 'Scheduled team sessions', `${c.team_name}: ${[...new Set(days)].sort().map((d) => WD[d]).join(', ')} at ${start_time}`);
    res.status(201).json({ id, sessions_created: made });
  }));

  api.post('/teams/:id/sessions/:classId/remove', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const cls = get('SELECT * FROM classes WHERE id=? AND team_id=?', Number(req.params.classId), c.id);
    if (!cls) throw notFound('That team session');
    tx(() => {
      update('classes', cls.id, { archived: 1 });
      run("UPDATE events SET cancelled=1, cancel_reason='Removed from the team schedule' WHERE class_id=? AND cancelled=0 AND starts_at>?", cls.id, booking.nowLocal());
    });
    log(req, 'Removed team sessions', `${c.team_name}: ${cls.name}`);
    res.json({ ok: true });
  }));

  // Bill something extra (a testing day, equipment) on its own invoice.
  api.post('/teams/:id/invoices', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const b = req.body || {};
    const description = clean(b.description);
    if (!description) throw bad('Say what the invoice is for.', { field: 'description' });
    if (description.length > 200) throw bad('Keep the description under 200 characters.', { field: 'description' });
    const amount = b.amount_cents != null && b.amount_cents !== '' ? Math.round(Number(b.amount_cents)) : toCents(b.amount);
    if (!(amount > 0)) throw bad('Enter an amount above zero.', { field: 'amount' });
    const id = schools.createSchoolInvoice(c, { description, amount_cents: amount });
    const inv = get('SELECT number FROM invoices WHERE id=?', id);
    log(req, 'Sent extra invoice', `${inv.number} to ${c.school_name}: ${description}, ${money(amount)}`);
    res.status(201).json({ id, number: inv.number, emailed: !!schools.billTo(c) });
  }));
}

module.exports = {
  routes,
  jobs: [
    { name: 'school-invoices', everyMin: 60, run: () => schools.runSchoolInvoicing() },
    { name: 'overdue-reminders', everyMin: 360, run: () => schools.sendOverdueReminders() },
  ],
};
