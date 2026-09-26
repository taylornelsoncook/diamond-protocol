// Clients: list, new client (athlete + parent login + plan + program), profile, family, membership, program.
'use strict';
const { get, all, run, insert, update, tx, setting } = require('../db');
const { h, bad, notFound, HttpError, log, emit, sendEmail, makeAthleteCode, randomToken, today, appUrl, businessName, payments } = require('../lib');
const { requireStaff } = require('../auth');
const billing = require('../services/billing');
const booking = require('../services/booking');

const isOwner = (req) => req.staff?.role === 'owner';
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const LIVE = "('trial','active','past_due','paused')";

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) throw bad('Enter the athlete\'s first and last name.');
  return [parts[0], parts.slice(1).join(' ')];
}
function athleteNames(b) {
  if (b.first_name || b.last_name) {
    const f = clean(b.first_name), l = clean(b.last_name);
    if (!f || !l) throw bad('Enter the athlete\'s first and last name.');
    return [f, l];
  }
  return splitName(b.name);
}
const validDate = (d) => (d == null || d === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : (() => { throw bad('Use a real date.'); })());
const sex = (s) => (s === 'M' || s === 'F' ? s : null);

function welcomeParent(p, athleteFirst) {
  const self = p.is_self;
  sendEmail(p.email, `Your ${businessName()} account`,
    `Hi ${p.name.split(' ')[0]},\n\n${self ? 'Your account is ready.' : `${athleteFirst}'s account is ready.`} Sign in to the parent portal to sign the waiver, add a card and book sessions:\n\n${appUrl()}/parent\n\nUse this email address (${p.email}). We'll email you a one-time code; there's no password to remember.\n\n${businessName()}`);
}

function createAthlete(familyId, b, extra = {}) {
  const [first, last] = athleteNames(b);
  const id = insert('athletes', {
    code: makeAthleteCode(first, last), family_id: familyId, first_name: first, last_name: last,
    email: clean(b.email)?.toLowerCase() || null, birthday: validDate(b.birthday), sex: sex(b.sex), sport: clean(b.sport), position: clean(b.position), school: clean(b.school),
    workout_token: randomToken(12), ...extra,
  });
  return get('SELECT * FROM athletes WHERE id=?', id);
}

function athleteRow(id) {
  const a = get('SELECT * FROM athletes WHERE id=?', id);
  if (!a) throw notFound('That client');
  return a;
}

function membershipView(req, m) {
  if (!m) return null;
  const out = { id: m.id, plan_id: m.plan_id, plan_name: m.plan_name, status: m.status, started_at: m.started_at, next_charge: m.next_charge, cancelled_at: m.cancelled_at, group_per_month: m.group_per_month, private_per_month: m.private_per_month };
  if (isOwner(req)) out.price_cents = m.price_cents;
  return out;
}

function assertMembership(id) {
  const m = get('SELECT * FROM memberships WHERE id=?', id);
  if (!m) throw notFound('That membership');
  return m;
}

function routes(api) {
  // ---- list ----
  api.get('/clients', requireStaff(), (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const where = ['a.archived=0'];
    const p = [];
    if (q) {
      const like = `%${q}%`;
      where.push(`(a.first_name || ' ' || a.last_name LIKE ? OR a.code LIKE ? OR a.email LIKE ? OR f.name LIKE ?
        OR EXISTS (SELECT 1 FROM parents px WHERE px.family_id=a.family_id AND (px.email LIKE ? OR px.name LIKE ?)))`);
      p.push(like, like, like, like, like, like);
    }
    const rows = all(`SELECT a.id, a.code, a.first_name, a.last_name, a.email, a.sport, a.team_id, a.family_id, f.name AS family,
        (SELECT email FROM parents px WHERE px.family_id=a.family_id ORDER BY is_self DESC, id LIMIT 1) AS parent_email,
        m.status AS membership_status, pl.name AS plan_name, pr.name AS program_name, t.team_name,
        (SELECT MAX(COALESCE(finished_at, created_at)) FROM workout_logs w WHERE w.athlete_id=a.id) AS last_workout
      FROM athletes a LEFT JOIN families f ON f.id=a.family_id
      LEFT JOIN memberships m ON m.id=(SELECT id FROM memberships WHERE athlete_id=a.id AND status IN ${LIVE} ORDER BY id DESC LIMIT 1)
      LEFT JOIN plans pl ON pl.id=m.plan_id LEFT JOIN programs pr ON pr.id=a.program_id LEFT JOIN team_contracts t ON t.id=a.team_id
      WHERE ${where.join(' AND ')} ORDER BY a.first_name COLLATE NOCASE, a.last_name COLLATE NOCASE`, ...p);
    const list = rows.map((r) => ({ ...r, status: r.membership_status || (r.team_id && !r.family_id ? 'team' : 'none') }));
    const counts = list.reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; return o; }, {});
    res.json({ total: list.length, counts, clients: status ? list.filter((r) => r.status === status) : list });
  });

  // ---- new client ----
  api.post('/clients', requireStaff(), h(async (req, res) => {
    const b = req.body || {};
    const withParent = b.with_parent !== false && b.with_parent !== 'false';
    const [first, last] = athleteNames(b);
    const planId = b.plan_id ? Number(b.plan_id) : null;
    const programId = b.program_id ? Number(b.program_id) : null;
    let parent;
    if (withParent) {
      parent = { name: clean(b.parent_name), email: clean(b.parent_email)?.toLowerCase(), phone: clean(b.parent_phone), is_self: 0 };
      if (!parent.name) throw bad('Enter the parent or guardian\'s name.');
      if (!EMAIL_RE.test(parent.email || '')) throw bad('Enter the parent\'s email. It\'s how they sign in.');
    } else {
      parent = { name: `${first} ${last}`, email: clean(b.email)?.toLowerCase(), phone: clean(b.phone), is_self: 1 };
      if (!EMAIL_RE.test(parent.email || '')) throw bad('Enter their email. It\'s how they sign in.');
    }
    if (get('SELECT 1 FROM parents WHERE email=?', parent.email)) throw bad('That email already has a portal login. Open that family and use Add sibling.');
    if (planId && !get('SELECT 1 FROM plans WHERE id=? AND active=1', planId)) throw bad('Choose a plan.');
    if (programId && !get('SELECT 1 FROM programs WHERE id=? AND archived=0', programId)) throw bad('Choose a program.');

    const out = tx(() => {
      const familyId = insert('families', { name: `${withParent ? parent.name.split(' ').slice(-1)[0] : last} family` });
      insert('parents', { family_id: familyId, ...parent });
      const a = createAthlete(familyId, { ...b, first_name: first, last_name: last, email: withParent ? b.athlete_email : parent.email },
        programId ? { program_id: programId, program_started: today() } : {});
      let membership = null;
      if (planId) membership = billing.startMembership(a.id, planId);
      return { a, familyId, membership };
    });
    const { a, familyId, membership } = out;
    welcomeParent(parent, first);
    emit('client.created', { athlete_id: a.id, athlete_code: a.code, first_name: a.first_name, last_name: a.last_name, family_id: familyId, parent_email: parent.email });
    if (programId) emit('program.assigned', { athlete_id: a.id, athlete_code: a.code, program_id: programId });
    log(req, 'Added client', `${first} ${last} (${a.code})`);
    const reply = { id: a.id, code: a.code, family_id: familyId };
    if (membership) reply.membership = { ok: membership.ok, trial: !!membership.trial, error: membership.error || null };
    res.status(201).json(reply);
  }));

  // ---- profile ----
  api.get('/athletes/:id', requireStaff(), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    const owner = isOwner(req);
    const fam = a.family_id ? get('SELECT * FROM families WHERE id=?', a.family_id) : null;
    const waiverVersion = Number(setting('waiver_version', 1));
    const m = billing.activeMembership(a.id);
    const now = booking.nowLocal();
    const program = a.program_id ? get('SELECT id, name, weeks, level FROM programs WHERE id=?', a.program_id) : null;
    const athlete = { ...a };
    if (req.staff.role === 'frontdesk') delete athlete.coach_notes;
    const out = {
      athlete,
      family: fam ? {
        id: fam.id, name: fam.name, card_brand: fam.card_brand, card_last4: fam.card_last4, card_exp: fam.card_exp,
        waiver: { signed: !!fam.waiver_version && fam.waiver_version >= waiverVersion, signed_version: fam.waiver_version, current_version: waiverVersion, signed_at: fam.waiver_signed_at, signed_by: fam.waiver_signed_by },
        parents: all('SELECT id, name, email, phone, is_self FROM parents WHERE family_id=? ORDER BY is_self DESC, id', fam.id),
        siblings: all('SELECT id, code, first_name, last_name FROM athletes WHERE family_id=? AND id<>? AND archived=0 ORDER BY first_name', fam.id, a.id),
      } : null,
      team: a.team_id ? get('SELECT t.id, t.team_name, s.name AS school FROM team_contracts t JOIN schools s ON s.id=t.school_id WHERE t.id=?', a.team_id) : null,
      membership: membershipView(req, m),
      sessions_left: (() => { const n = billing.memberSessionsLeft(a.id); return { member_group: n === Infinity ? 'unlimited' : n, group_credits: a.group_credits, private_credits: a.private_credits }; })(),
      upcoming: all(`SELECT b.id, b.status, b.coverage, b.checked_in_at, e.id AS event_id, e.name, e.starts_at, e.type, l.name AS location FROM bookings b JOIN events e ON e.id=b.event_id
        LEFT JOIN locations l ON l.id=e.location_id WHERE b.athlete_id=? AND b.status IN ('booked','waitlist') AND e.cancelled=0 AND e.starts_at>=? ORDER BY e.starts_at LIMIT 10`, a.id, now.slice(0, 10)),
      today_sessions: all(`SELECT e.id, e.name, e.starts_at, e.duration_min, e.type, l.name AS location,
        (SELECT b.checked_in_at FROM bookings b WHERE b.event_id=e.id AND b.athlete_id=? AND b.status='booked') AS checked_in_at
        FROM events e LEFT JOIN locations l ON l.id=e.location_id WHERE e.cancelled=0 AND substr(e.starts_at,1,10)=? AND e.type IN ('class','camp','clinic','team','private','evaluation')
        ORDER BY e.starts_at`, a.id, now.slice(0, 10)),
      program,
      workout_url: a.workout_token ? `${appUrl()}/w/${a.workout_token}` : null,
      last_workout: get('SELECT MAX(COALESCE(finished_at, created_at)) AS t FROM workout_logs WHERE athlete_id=?', a.id)?.t || null,
      portal_url: `${appUrl()}/parent`,
      report_url: `/report/${encodeURIComponent(a.code)}`,
      payments_mode: payments.mode(),
    };
    if (owner) {
      out.payments = all(`SELECT id, number, kind, description, amount_cents, status, issued_at, paid_at, pay_method, attempts FROM invoices
        WHERE (athlete_id=? OR (family_id=? AND athlete_id IS NULL)) ORDER BY id DESC LIMIT 12`, a.id, a.family_id ?? -1);
    }
    res.json(out);
  }));

  api.put('/athletes/:id', requireStaff(), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    const b = req.body || {};
    const patch = {};
    if ('name' in b || 'first_name' in b) { const [f, l] = athleteNames(b); patch.first_name = f; patch.last_name = l; }
    for (const k of ['sport', 'position', 'school', 'allergies', 'injuries', 'medical_notes', 'emergency_name', 'emergency_phone']) if (k in b) patch[k] = clean(b[k]);
    if ('email' in b) { const e = clean(b.email)?.toLowerCase() || null; if (e && !EMAIL_RE.test(e)) throw bad('That email doesn\'t look right.'); patch.email = e; }
    if ('birthday' in b) patch.birthday = validDate(b.birthday);
    if ('sex' in b) patch.sex = sex(b.sex);
    if ('coach_notes' in b) {
      if (req.staff.role === 'frontdesk') throw new HttpError(403, 'Only coaches can edit coach notes.');
      patch.coach_notes = clean(b.coach_notes);
    }
    update('athletes', a.id, patch);
    log(req, 'Updated client profile', `${patch.first_name || a.first_name} ${patch.last_name || a.last_name} (${a.code})`);
    res.json({ ok: true });
  }));

  api.post('/athletes/:id/archive', requireStaff('owner', 'coach'), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    const m = billing.activeMembership(a.id);
    if (m) throw bad('Cancel the membership before archiving this client.');
    const restore = req.body?.restore === true;
    update('athletes', a.id, { archived: restore ? 0 : 1 });
    if (!restore) run("DELETE FROM standing_spots WHERE athlete_id=?", a.id);
    log(req, restore ? 'Restored client' : 'Archived client', `${a.first_name} ${a.last_name} (${a.code})`);
    res.json({ ok: true });
  }));

  // ---- family ----
  api.post('/families/:id/athletes', requireStaff(), h(async (req, res) => {
    const fam = get('SELECT * FROM families WHERE id=?', Number(req.params.id));
    if (!fam) throw notFound('That family');
    const b = req.body || {};
    const programId = b.program_id ? Number(b.program_id) : null;
    const a = createAthlete(fam.id, b, programId ? { program_id: programId, program_started: today() } : {});
    emit('client.created', { athlete_id: a.id, athlete_code: a.code, first_name: a.first_name, last_name: a.last_name, family_id: fam.id, sibling: true });
    log(req, 'Added sibling', `${a.first_name} ${a.last_name} (${a.code}) to ${fam.name}`);
    res.status(201).json({ id: a.id, code: a.code });
  }));

  api.post('/families/:id/parents', requireStaff(), h(async (req, res) => {
    const fam = get('SELECT * FROM families WHERE id=?', Number(req.params.id));
    if (!fam) throw notFound('That family');
    const p = { name: clean(req.body?.name), email: clean(req.body?.email)?.toLowerCase(), phone: clean(req.body?.phone) };
    if (!p.name) throw bad('Enter their name.');
    if (!EMAIL_RE.test(p.email || '')) throw bad('Enter their email. It\'s how they sign in.');
    if (get('SELECT 1 FROM parents WHERE email=?', p.email)) throw bad('That email already has a portal login.');
    const id = insert('parents', { family_id: fam.id, ...p, is_self: 0 });
    const kid = get('SELECT first_name FROM athletes WHERE family_id=? ORDER BY id LIMIT 1', fam.id);
    welcomeParent({ ...p, is_self: 0 }, kid?.first_name || 'Your athlete');
    log(req, 'Added parent', `${p.name} to ${fam.name}`);
    res.status(201).json({ id });
  }));

  // Owner: remove the card on file, or (test mode) switch it to a declining test card.
  api.post('/families/:id/card', requireStaff('owner'), h(async (req, res) => {
    const fam = get('SELECT * FROM families WHERE id=?', Number(req.params.id));
    if (!fam) throw notFound('That family');
    const action = req.body?.action;
    if (action === 'remove') {
      update('families', fam.id, { card_brand: null, card_last4: null, card_exp: null });
      log(req, 'Removed card on file', fam.name);
    } else if (action === 'test_decline' || action === 'test_approve') {
      if (payments.mode() !== 'test') throw bad('Test cards only work in test mode.');
      const decline = action === 'test_decline';
      update('families', fam.id, { card_brand: 'Visa', card_last4: decline ? '0002' : '4242', card_exp: '12/30' });
      log(req, decline ? 'Set a declining test card' : 'Set a working test card', fam.name);
    } else throw bad('Choose what to do with the card.');
    res.json({ ok: true });
  }));

  // ---- sessions ----
  api.post('/athletes/:id/credits', requireStaff('owner'), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    const g = Number(req.body?.group_credits), p = Number(req.body?.private_credits);
    if (!Number.isInteger(g) || !Number.isInteger(p) || g < 0 || p < 0 || g > 500 || p > 500) throw bad('Enter whole numbers of sessions, 0 or more.');
    update('athletes', a.id, { group_credits: g, private_credits: p });
    log(req, 'Adjusted sessions', `${a.first_name} ${a.last_name}: ${g} group, ${p} private (was ${a.group_credits}, ${a.private_credits})`);
    res.json({ ok: true });
  }));

  // Walk-in: book into one of today's sessions (if not already) and check in.
  api.post('/athletes/:id/walk-in', requireStaff(), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    const e = get('SELECT * FROM events WHERE id=? AND cancelled=0', Number(req.body?.event_id));
    if (!e) throw bad('Choose one of today\'s sessions.');
    if (e.starts_at.slice(0, 10) !== booking.todayLocal()) throw bad('Walk-ins check in to today\'s sessions only.');
    let b = get("SELECT * FROM bookings WHERE event_id=? AND athlete_id=? AND status IN ('booked','waitlist')", e.id, a.id);
    if (b?.status === 'waitlist') { update('bookings', b.id, { status: 'booked', coverage: booking.cover(e, a).coverage }); b = get('SELECT * FROM bookings WHERE id=?', b.id); }
    if (!b) {
      const bid = insert('bookings', { event_id: e.id, athlete_id: a.id, status: 'booked', coverage: booking.cover(e, a).coverage, source: 'walk-in' });
      b = get('SELECT * FROM bookings WHERE id=?', bid);
      emit('booking.created', { booking_id: b.id, event_id: e.id, athlete_code: a.code, starts_at: e.starts_at, name: e.name, walk_in: true });
    }
    if (b.checked_in_at) throw bad(`${a.first_name} is already checked in.`);
    booking.checkIn(b.id, true);
    log(req, 'Checked in walk-in', `${a.first_name} ${a.last_name}, ${e.name}`);
    res.json({ ok: true, booking_id: b.id, coverage: b.coverage, price_cents: b.coverage === 'unpaid' ? e.price_cents : undefined });
  }));

  // ---- membership (owner only) ----
  api.post('/athletes/:id/membership', requireStaff('owner'), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    if (!a.family_id) throw bad('Team-only athletes have no family account to bill. Add them as a client first.');
    const r = billing.startMembership(a.id, Number(req.body?.plan_id), { skipTrial: !!req.body?.skip_trial });
    const plan = get('SELECT name FROM plans WHERE id=?', Number(req.body?.plan_id));
    log(req, r.ok ? 'Started membership' : 'Started membership, first payment failed', `${a.first_name} ${a.last_name}: ${plan.name}${r.error ? ` (${r.error})` : ''}`);
    res.status(201).json(r);
  }));

  api.post('/memberships/:id/:action', requireStaff('owner'), h(async (req, res) => {
    const m = assertMembership(Number(req.params.id));
    const a = get('SELECT first_name, last_name FROM athletes WHERE id=?', m.athlete_id);
    const who = `${a.first_name} ${a.last_name}`;
    switch (req.params.action) {
      case 'pause':
        if (!['active', 'trial'].includes(m.status)) throw bad('Only active memberships can be paused.');
        billing.setMembershipStatus(m.id, 'paused'); log(req, 'Paused membership', who); break;
      case 'resume':
        if (m.status !== 'paused') throw bad('That membership isn\'t paused.');
        billing.setMembershipStatus(m.id, 'active'); log(req, 'Resumed membership', who); break;
      case 'cancel':
        if (m.status === 'cancelled') throw bad('That membership is already cancelled.');
        billing.setMembershipStatus(m.id, 'cancelled');
        run("UPDATE invoices SET next_retry=NULL WHERE membership_id=? AND status='failed'", m.id);
        log(req, 'Cancelled membership', who); break;
      case 'change': {
        if (m.status === 'cancelled') throw bad('Start a new membership instead.');
        const plan = get('SELECT * FROM plans WHERE id=? AND active=1', Number(req.body?.plan_id));
        if (!plan) throw bad('Choose a plan.');
        if (plan.id === m.plan_id) throw bad('They\'re already on that plan.');
        billing.changePlan(m.id, plan.id); log(req, 'Changed plan', `${who}: ${plan.name}, from the next charge`); break;
      }
      default: throw new HttpError(404, 'No such API endpoint.');
    }
    res.json({ ok: true, membership: membershipView(req, billing.activeMembership(m.athlete_id)) });
  }));

  // ---- program ----
  api.put('/athletes/:id/program', requireStaff('owner', 'coach'), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    const pid = req.body?.program_id ? Number(req.body.program_id) : null;
    const p = pid ? get('SELECT * FROM programs WHERE id=? AND archived=0', pid) : null;
    if (pid && !p) throw bad('Choose a program.');
    update('athletes', a.id, { program_id: pid, program_started: pid ? today() : null, workout_token: a.workout_token || randomToken(12) });
    if (p) emit('program.assigned', { athlete_id: a.id, athlete_code: a.code, program_id: p.id, program_name: p.name });
    log(req, p ? 'Assigned program' : 'Removed program', `${a.first_name} ${a.last_name}${p ? `: ${p.name}` : ''}`);
    res.json({ ok: true });
  }));

  api.post('/athletes/:id/workout-link', requireStaff('owner', 'coach'), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    const token = randomToken(12);
    update('athletes', a.id, { workout_token: token });
    log(req, 'Reset workout app link', `${a.first_name} ${a.last_name}`);
    res.json({ ok: true, workout_url: `${appUrl()}/w/${token}` });
  }));
}

module.exports = { routes };
