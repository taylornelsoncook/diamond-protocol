// Teams: school and club contracts, their invoices, roster and team sessions. Owner only.
'use strict';
const { get, all, run, insert, update, tx } = require('../db');
const { h, bad, notFound, log, makeAthleteCode, randomToken, money, today } = require('../lib');
const { requireStaff } = require('../auth');
const booking = require('../services/booking');
const schools = require('../services/money-schools');

const owner = requireStaff('owner');
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const toCents = (v) => Math.round(Number(String(v ?? '').replace(/[$,\s]/g, '')) * 100);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
function feeFrom(b) {
  const c = b.monthly_cents != null && b.monthly_cents !== '' ? Math.round(Number(b.monthly_cents)) : toCents(b.monthly_fee);
  if (!(c > 0)) throw bad('Enter the monthly fee.');
  return c;
}
function terms(v) {
  const n = Number(v ?? 30);
  if (!Number.isInteger(n) || n < 0 || n > 120) throw bad('Payment terms must be 0–120 days.');
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
  return all(`SELECT a.id, a.code, a.first_name, a.last_name, a.position, a.sport, a.family_id, a.created_at,
      (SELECT COUNT(*) FROM events e WHERE e.team_id=? AND e.type='team' AND e.cancelled=0 AND e.starts_at < ? AND e.starts_at >= MIN(substr(a.created_at,1,10),
        COALESCE((SELECT MIN(substr(e2.starts_at,1,10)) FROM bookings b2 JOIN events e2 ON e2.id=b2.event_id WHERE b2.athlete_id=a.id AND e2.team_id=e.team_id), '9999'))) AS sessions,
      (SELECT COUNT(*) FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=a.id AND e.team_id=? AND e.type='team' AND b.checked_in_at IS NOT NULL) AS attended
    FROM athletes a WHERE a.team_id=? AND a.archived=0 ORDER BY a.last_name COLLATE NOCASE, a.first_name COLLATE NOCASE`, teamId, now, teamId, teamId)
    .map((r) => ({ ...r, attendance_rate: r.sessions ? Math.min(1, r.attended / r.sessions) : null }));
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function routes(api) {
  api.get('/schools', owner, (_req, res) => res.json(all('SELECT * FROM schools ORDER BY name COLLATE NOCASE')));

  api.post('/schools', owner, h(async (req, res) => {
    const b = req.body || {};
    const name = clean(b.name);
    if (!name) throw bad('Enter the school or club name.');
    if (b.contact_email && !EMAIL_RE.test(b.contact_email)) throw bad('That billing email doesn\'t look right.');
    const id = insert('schools', { name, contact_name: clean(b.contact_name), contact_email: clean(b.contact_email)?.toLowerCase() || null, address: clean(b.address) });
    log(req, 'Added school or club', name);
    res.status(201).json({ id });
  }));

  api.get('/teams', owner, (_req, res) => {
    const T = today();
    const contracts = all(`SELECT t.*, s.name AS school_name, s.contact_email,
        (SELECT COUNT(*) FROM athletes a WHERE a.team_id=t.id AND a.archived=0) AS athletes,
        (SELECT COALESCE(SUM(amount_cents),0) FROM invoices i WHERE i.contract_id=t.id AND i.status='open') AS open_cents,
        (SELECT COALESCE(SUM(amount_cents),0) FROM invoices i WHERE i.contract_id=t.id AND i.status='open' AND i.due_date < ?) AS overdue_cents
      FROM team_contracts t JOIN schools s ON s.id=t.school_id ORDER BY t.status, s.name COLLATE NOCASE, t.team_name`, T)
      .map((c) => ({ ...c, next_invoice: schools.nextInvoiceDate(c), has_billing_email: !!(c.billing_email || c.contact_email) }));
    const unpaid = all(`SELECT i.*, t.team_name, s.name AS school_name FROM invoices i JOIN team_contracts t ON t.id=i.contract_id JOIN schools s ON s.id=t.school_id
      WHERE i.kind='school' AND i.status='open' ORDER BY i.due_date, i.id`).map(invoiceView);
    const active = contracts.filter((c) => c.status === 'active');
    res.json({
      metrics: {
        monthly_cents: active.reduce((s, c) => s + c.monthly_cents, 0), active_teams: active.length,
        waiting_cents: unpaid.reduce((s, i) => s + i.amount_cents, 0), waiting_count: unpaid.length,
        overdue_cents: unpaid.filter((i) => i.overdue).reduce((s, i) => s + i.amount_cents, 0), overdue_count: unpaid.filter((i) => i.overdue).length,
        athletes: active.reduce((s, c) => s + c.athletes, 0),
      },
      contracts, unpaid,
    });
  });

  api.post('/teams', owner, h(async (req, res) => {
    const b = req.body || {};
    const team_name = clean(b.team_name);
    if (!team_name) throw bad('Enter the team name.');
    const monthly_cents = feeFrom(b);
    const start_date = b.start_date || today();
    if (!isDate(start_date)) throw bad('Choose a start date.');
    const end_date = clean(b.end_date);
    if (end_date && (!isDate(end_date) || end_date < start_date)) throw bad('The end date must be after the start date.');
    const billing_email = clean(b.billing_email)?.toLowerCase() || null;
    if (billing_email && !EMAIL_RE.test(billing_email)) throw bad('That billing email doesn\'t look right.');
    const id = tx(() => {
      let schoolId = b.school_id && b.school_id !== 'new' ? Number(b.school_id) : null;
      if (schoolId) { if (!get('SELECT 1 FROM schools WHERE id=?', schoolId)) throw bad('Choose a school or club.'); }
      else {
        const name = clean(b.school_name);
        if (!name) throw bad('Enter the school or club name.');
        schoolId = insert('schools', { name, contact_name: clean(b.billing_name), contact_email: billing_email, address: clean(b.address) });
      }
      const school = get('SELECT * FROM schools WHERE id=?', schoolId);
      if (clean(b.address) && b.school_id && b.school_id !== 'new') update('schools', schoolId, { address: clean(b.address) });
      return insert('team_contracts', {
        school_id: schoolId, team_name, monthly_cents, start_date, end_date, terms_days: terms(b.terms_days), po_number: clean(b.po_number),
        billing_name: clean(b.billing_name) || school.contact_name, billing_email: billing_email || school.contact_email, billing_day: Number(start_date.slice(8, 10)),
      });
    });
    const invoiced = schools.invoiceContract(id);
    const c = schools.contractWithSchool(id);
    log(req, 'Created team contract', `${c.school_name} ${team_name}${invoiced.length ? `; ${invoiced.length} invoice${invoiced.length > 1 ? 's' : ''} sent` : ''}`);
    res.status(201).json({ id, invoices: invoiced.length });
  }));

  api.get('/teams/:id', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const invoices = all("SELECT * FROM invoices WHERE contract_id=? ORDER BY issued_at DESC, id DESC", c.id).map(invoiceView);
    const sessions = all(`SELECT c.*, l.name AS location FROM classes c LEFT JOIN locations l ON l.id=c.location_id WHERE c.team_id=? AND c.archived=0 ORDER BY c.id`, c.id)
      .map((s) => ({ ...s, days: String(s.weekdays).split(',').map((d) => WD[+d]).join(', '),
        next: get('SELECT starts_at FROM events WHERE class_id=? AND cancelled=0 AND starts_at>=? ORDER BY starts_at LIMIT 1', s.id, booking.nowLocal())?.starts_at || null }));
    res.json({
      contract: { ...c, next_invoice: schools.nextInvoiceDate(c) },
      invoices, unpaid_cents: invoices.filter((i) => i.status === 'open').reduce((s, i) => s + i.amount_cents, 0),
      roster: rosterWithAttendance(c.id), sessions,
      locations: all('SELECT id, name FROM locations WHERE archived=0 ORDER BY id'),
    });
  }));

  api.put('/teams/:id', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const b = req.body || {};
    const patch = {}, changed = [];
    if ('monthly_fee' in b || 'monthly_cents' in b) { patch.monthly_cents = feeFrom(b); if (patch.monthly_cents !== c.monthly_cents) changed.push('new monthly fee from the next invoice'); }
    if ('end_date' in b) {
      patch.end_date = clean(b.end_date);
      if (patch.end_date && (!isDate(patch.end_date) || patch.end_date < c.start_date)) throw bad('The end date must be after the start date.');
      if ((patch.end_date || null) !== (c.end_date || null)) changed.push(patch.end_date ? `ends ${patch.end_date}` : 'no end date');
    }
    if ('terms_days' in b) patch.terms_days = terms(b.terms_days);
    if ('po_number' in b) patch.po_number = clean(b.po_number);
    if ('team_name' in b) { patch.team_name = clean(b.team_name); if (!patch.team_name) throw bad('Enter the team name.'); }
    if ('billing_name' in b) patch.billing_name = clean(b.billing_name);
    if ('billing_email' in b) {
      patch.billing_email = clean(b.billing_email)?.toLowerCase() || null;
      if (patch.billing_email && !EMAIL_RE.test(patch.billing_email)) throw bad('That billing email doesn\'t look right.');
    }
    if (c.status === 'ended' && patch.end_date !== undefined && (!patch.end_date || patch.end_date >= today())) patch.status = 'active';
    tx(() => {
      update('team_contracts', c.id, patch);
      if ('address' in b) update('schools', c.school_id, { address: clean(b.address) });
    });
    log(req, 'Updated team contract', `${c.school_name} ${c.team_name}${changed.length ? `: ${changed.join(', ')}` : ''}`);
    res.json({ ok: true });
  }));

  api.post('/teams/:id/end', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    if (c.status === 'ended') throw bad('That contract has already ended.');
    const end = c.end_date && c.end_date < today() ? c.end_date : today();
    tx(() => {
      update('team_contracts', c.id, { status: 'ended', end_date: end });
      run('UPDATE classes SET archived=1 WHERE team_id=?', c.id);
      run("UPDATE events SET cancelled=1, cancel_reason='Team contract ended' WHERE team_id=? AND type='team' AND cancelled=0 AND starts_at>?", c.id, booking.nowLocal());
    });
    log(req, 'Ended team contract', `${c.school_name} ${c.team_name}`);
    res.json({ ok: true });
  }));

  // Paste one athlete per line: "Name, position, grad year" (position and year optional).
  api.post('/teams/:id/roster', owner, h(async (req, res) => {
    const c = contractOr404(req.params.id);
    const text = typeof req.body === 'string' ? req.body : String(req.body?.text || '');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw bad('Paste at least one name, one per line.');
    const parsed = lines.map((line, i) => {
      const parts = line.split(/\t|,/).map((s) => s.trim());
      const names = parts[0].replace(/\s+/g, ' ').split(' ');
      if (names.length < 2) throw bad(`Line ${i + 1} needs a first and last name: "${line}"`);
      const extra = parts.slice(1).filter(Boolean);
      const position = extra.find((x) => !/^\d{4}$/.test(x)) || null;
      return { first: names[0], last: names.slice(1).join(' '), position };
    });
    const added = tx(() => parsed.map((p) => {
      const existing = get('SELECT id, code FROM athletes WHERE team_id=? AND archived=0 AND first_name=? COLLATE NOCASE AND last_name=? COLLATE NOCASE', c.id, p.first, p.last);
      if (existing) return { ...existing, existing: true };
      const code = makeAthleteCode(p.first, p.last);
      const id = insert('athletes', { code, first_name: p.first, last_name: p.last, position: p.position, team_id: c.id, school: c.school_name, workout_token: randomToken(12) });
      return { id, code };
    }));
    const n = added.filter((a) => !a.existing).length;
    log(req, 'Added to team roster', `${n} athlete${n === 1 ? '' : 's'} to ${c.school_name} ${c.team_name}`);
    res.status(201).json({ added: n, skipped: added.length - n, athletes: added });
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
    if (!days.length) throw bad('Choose at least one day.');
    const start_time = String(b.start_time || '');
    if (!/^\d{2}:\d{2}$/.test(start_time)) throw bad('Choose a start time.');
    const duration = Number(b.duration_min || 60);
    if (!(duration >= 15 && duration <= 300)) throw bad('Sessions run 15–300 minutes.');
    const start_date = b.start_date || today();
    if (!isDate(start_date)) throw bad('Choose the first day.');
    const location_id = b.location_id ? Number(b.location_id) : null;
    if (location_id && !get('SELECT 1 FROM locations WHERE id=?', location_id)) throw bad('Choose a location.');
    const id = insert('classes', {
      name: `${c.team_name} team session`, type: 'team', weekdays: [...new Set(days)].sort().join(','), start_time, duration_min: duration,
      capacity: Math.max(60, rosterWithAttendance(c.id).length), price_cents: 0, start_date, end_date: c.end_date, location_id, team_id: c.id,
      coach_id: b.coach_id ? Number(b.coach_id) : null,
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
    if (!description) throw bad('Say what the invoice is for.');
    const amount = b.amount_cents != null && b.amount_cents !== '' ? Math.round(Number(b.amount_cents)) : toCents(b.amount);
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
