// Clients: list, new client (athlete + parent login + plan + program), profile, family, membership, program,
// staff notes, visit history, parent contacts and paper waivers.
'use strict';
const { get, all, run, insert, update, tx, setting } = require('../db');
const { h, bad, notFound, HttpError, log, emit, sendEmail, makeAthleteCode, randomToken, today, appUrl, businessName, payments } = require('../lib');
const { requireStaff } = require('../auth');
const billing = require('../services/billing');
const booking = require('../services/booking');
const clients = require('../services/clients');
require('../services/parent-programs'); // membership requests from the parent portal

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
const validDate = (d) => (d == null || d === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d ? d : (() => { throw bad('Use a real date.'); })());
const birthDate = (d) => {
  const v = validDate(d);
  if (v && v > today()) throw bad('The birthday is in the future. Check the year.');
  if (v && v < '1900-01-01') throw bad('That birthday is too long ago. Check the year.');
  return v;
};
const sex = (s) => (s === 'M' || s === 'F' ? s : null);
const LIST_SORTS = ['name', 'last_seen', 'newest'];
const noProgramsForDesk = (req, programId) => {
  if (programId && req.staff.role === 'frontdesk') throw new HttpError(403, 'Only coaches and owners assign programs. Leave it for a coach.');
};
const waiverVersion = () => Number(setting('waiver_version', 1));
// SQLite datetime('now') and JS ISO strings, both UTC, as comparable ISO strings (null when missing or unreadable).
const utcIso = (t) => { if (!t) return null; const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : String(t).replace(' ', 'T') + 'Z'); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

function welcomeParent(p, athleteFirst) {
  const self = p.is_self;
  sendEmail(p.email, `Your ${businessName()} account`,
    `Hi ${p.name.split(' ')[0]},\n\n${self ? 'Your account is ready.' : `${athleteFirst}'s account is ready.`} Sign in to the parent portal to sign the waiver, add a card and book sessions:\n\n${appUrl()}/parent\n\nUse this email address (${p.email}). We'll email you a one-time code; there's no password to remember.\n\n${businessName()}`);
}

function createAthlete(familyId, b, extra = {}) {
  const [first, last] = athleteNames(b);
  const id = insert('athletes', {
    code: makeAthleteCode(first, last), family_id: familyId, first_name: first, last_name: last,
    email: clean(b.email)?.toLowerCase() || null, birthday: birthDate(b.birthday), sex: sex(b.sex), sport: clean(b.sport), position: clean(b.position), school: clean(b.school),
    phone: clean(b.phone), grad_year: clients.gradYear(b.grad_year),
    allergies: clean(b.allergies), injuries: clean(b.injuries), emergency_name: clean(b.emergency_name), emergency_phone: clean(b.emergency_phone),
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

// A family's request from the portal (switch plans, pause, cancel) in the last 14 days that the membership doesn't
// already reflect, so whoever opens the profile from the owner's email sees what was asked.
function openRequest(athleteId, m) {
  const r = get(`SELECT r.kind, r.plan_id, r.note, r.created_at, p.name AS plan_name, pa.name AS parent_name, pa.email AS parent_email
    FROM membership_requests r LEFT JOIN plans p ON p.id=r.plan_id LEFT JOIN parents pa ON pa.id=r.parent_id
    WHERE r.athlete_id=? AND r.created_at >= datetime('now','-14 days') ORDER BY r.id DESC LIMIT 1`, athleteId);
  if (!r) return null;
  const done = !m ? true : r.kind === 'cancel' ? m.status === 'cancelled' : r.kind === 'pause' ? m.status === 'paused' : m.plan_id === r.plan_id;
  return done ? null : r;
}

function assertMembership(id) {
  const m = get('SELECT * FROM memberships WHERE id=?', id);
  if (!m) throw notFound('That membership');
  return m;
}

function routes(api) {
  // ---- list ----
  // status: a membership status, 'none', 'team', or the views 'no_waiver' and 'archived'. sort: name | last_seen | newest.
  api.get('/clients', requireStaff(), (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const sort = LIST_SORTS.includes(req.query.sort) ? req.query.sort : 'name';
    // Archived and current clients come back together: the views always count current clients, and the
    // Archived view (or a search that only finds archived clients) uses the rest.
    const where = ['1=1'];
    const p = [];
    if (q) {
      const like = `%${q}%`;
      // Phone numbers match on digits too, so 8015550142 finds 801-555-0142.
      const digits = /^[\d\s().+-]+$/.test(q) ? q.replace(/\D/g, '') : '';
      const phoneDigits = (col) => `replace(replace(replace(replace(replace(replace(${col},'-',''),' ',''),'(',''),')',''),'.',''),'+','')`;
      const byDigits = digits.length >= 4 ? ` OR ${phoneDigits('a.phone')} LIKE ? OR EXISTS (SELECT 1 FROM parents py WHERE py.family_id=a.family_id AND ${phoneDigits('py.phone')} LIKE ?)` : '';
      where.push(`(a.first_name || ' ' || a.last_name LIKE ? OR a.code LIKE ? OR a.email LIKE ? OR f.name LIKE ? OR a.phone LIKE ?
        OR EXISTS (SELECT 1 FROM parents px WHERE px.family_id=a.family_id AND (px.email LIKE ? OR px.name LIKE ? OR px.phone LIKE ?))${byDigits})`);
      p.push(like, like, like, like, like, like, like, like);
      if (byDigits) p.push(`%${digits}%`, `%${digits}%`);
    }
    const rows = all(`SELECT a.id, a.code, a.first_name, a.last_name, a.email, a.phone, a.sport, a.school, a.grad_year, a.team_id, a.family_id, a.created_at, a.archived,
        f.name AS family, f.card_last4, f.waiver_version,
        (a.allergies IS NOT NULL AND a.allergies<>'') OR (a.injuries IS NOT NULL AND a.injuries<>'') OR (a.medical_notes IS NOT NULL AND a.medical_notes<>'') AS medical,
        (SELECT email FROM parents px WHERE px.family_id=a.family_id ORDER BY is_self DESC, id LIMIT 1) AS parent_email,
        (SELECT name FROM parents px WHERE px.family_id=a.family_id ORDER BY is_self DESC, id LIMIT 1) AS parent_name,
        (SELECT phone FROM parents px WHERE px.family_id=a.family_id AND phone IS NOT NULL AND phone<>'' ORDER BY is_self DESC, id LIMIT 1) AS parent_phone,
        m.status AS membership_status, pl.name AS plan_name, pr.name AS program_name, t.team_name,
        (SELECT MAX(COALESCE(finished_at, created_at)) FROM workout_logs w WHERE w.athlete_id=a.id) AS last_workout,
        (SELECT MAX(b.checked_in_at) FROM bookings b WHERE b.athlete_id=a.id AND b.status='booked') AS last_visit,
        (SELECT COUNT(*) FROM client_notes n WHERE n.athlete_id=a.id AND n.pinned=1 ${req.staff.role === 'frontdesk' ? 'AND n.coach_only=0' : ''}) AS pinned_notes
      FROM athletes a LEFT JOIN families f ON f.id=a.family_id
      LEFT JOIN memberships m ON m.id=(SELECT id FROM memberships WHERE athlete_id=a.id AND status IN ${LIVE} ORDER BY id DESC LIMIT 1)
      LEFT JOIN plans pl ON pl.id=m.plan_id LEFT JOIN programs pr ON pr.id=a.program_id LEFT JOIN team_contracts t ON t.id=a.team_id
      WHERE ${where.join(' AND ')} ORDER BY a.first_name COLLATE NOCASE, a.last_name COLLATE NOCASE`, ...p);
    const wv = waiverVersion();
    const all_ = rows.map(({ card_last4, waiver_version, archived, ...r }) => ({
      ...r, medical: !!r.medical, archived: !!archived,
      status: r.membership_status || (r.team_id && !r.family_id ? 'team' : 'none'),
      waiver_missing: !!r.family_id && Number(waiver_version || 0) < wv,
      no_card: !!r.family_id && !card_last4,
    })).map((r) => {
      const visit = utcIso(r.last_visit), workout = utcIso(r.last_workout);
      return { ...r, last_seen: [visit, workout].filter(Boolean).sort().pop() || null, last_seen_kind: visit || workout ? ((visit || '') >= (workout || '') ? 'visit' : 'workout') : null };
    });
    const list = all_.filter((r) => !r.archived), archivedList = all_.filter((r) => r.archived);
    const counts = list.reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; if (r.waiver_missing) o.no_waiver = (o.no_waiver || 0) + 1; return o; }, {});
    counts.archived = archivedList.length;
    let out = status === 'archived' ? archivedList : status === 'no_waiver' ? list.filter((r) => r.waiver_missing) : status ? list.filter((r) => r.status === status) : list;
    if (sort === 'last_seen') out = [...out].sort((x, y) => (x.last_seen || '').localeCompare(y.last_seen || ''));
    else if (sort === 'newest') out = [...out].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || y.id - x.id);
    res.json({ total: list.length, counts, clients: out });
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
    const existing = get(`SELECT p.family_id, f.name AS family, a.id AS athlete_id, a.first_name, a.last_name FROM parents p JOIN families f ON f.id=p.family_id
      LEFT JOIN athletes a ON a.id=(SELECT id FROM athletes WHERE family_id=p.family_id ORDER BY archived, id LIMIT 1) WHERE p.email=?`, parent.email);
    if (existing) {
      throw bad(`That email already has a portal login (${existing.family}). Open ${existing.first_name ? `${existing.first_name} ${existing.last_name}` : 'that family'} and use Add sibling.`,
        existing.athlete_id ? { existing: { athlete_id: existing.athlete_id, name: `${existing.first_name} ${existing.last_name}`, family: existing.family } } : undefined);
    }
    if (planId && !get('SELECT 1 FROM plans WHERE id=? AND active=1', planId)) throw bad('Choose a plan.');
    noProgramsForDesk(req, programId);
    if (programId && !get('SELECT 1 FROM programs WHERE id=? AND archived=0', programId)) throw bad('Choose a program.');
    clients.gradYear(b.grad_year);
    // Same name (and the same birthday, when both are known) is probably someone already on file.
    if (b.allow_duplicate !== true) {
      const bd = birthDate(b.birthday);
      const dup = all(`SELECT id, code, first_name, last_name, birthday, archived FROM athletes WHERE first_name=? COLLATE NOCASE AND last_name=? COLLATE NOCASE
        ${bd ? 'AND (birthday IS NULL OR birthday=?)' : ''} ORDER BY archived, id LIMIT 3`, first, last, ...(bd ? [bd] : []));
      if (dup.length) {
        throw new HttpError(409, `${first} ${last} may already be a client (${dup.map((d) => d.code + (d.archived ? ', archived' : '')).join('; ')}). Open them, or create the account anyway.`,
          { duplicates: dup.map((d) => ({ id: d.id, code: d.code, name: `${d.first_name} ${d.last_name}`, birthday: d.birthday, archived: !!d.archived })) });
      }
    }

    const out = tx(() => {
      const familyId = insert('families', { name: `${withParent ? parent.name.split(' ').slice(-1)[0] : last} family` });
      insert('parents', { family_id: familyId, ...parent });
      const a = createAthlete(familyId, { ...b, first_name: first, last_name: last, email: withParent ? b.athlete_email : parent.email, phone: withParent ? b.athlete_phone : parent.phone },
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
    const wv = waiverVersion();
    const m = billing.activeMembership(a.id);
    const now = booking.nowLocal();
    const program = a.program_id ? get('SELECT id, name, weeks, level FROM programs WHERE id=?', a.program_id) : null;
    const athlete = { ...a };
    if (req.staff.role === 'frontdesk') delete athlete.coach_notes;
    const out = {
      athlete,
      family: fam ? {
        id: fam.id, name: fam.name, card_brand: fam.card_brand, card_last4: fam.card_last4, card_exp: fam.card_exp,
        waiver: { signed: !!fam.waiver_version && fam.waiver_version >= wv, signed_version: fam.waiver_version, current_version: wv, signed_at: fam.waiver_signed_at, signed_by: fam.waiver_signed_by },
        parents: all('SELECT id, name, email, phone, is_self FROM parents WHERE family_id=? ORDER BY is_self DESC, id', fam.id),
        siblings: all('SELECT id, code, first_name, last_name FROM athletes WHERE family_id=? AND id<>? AND archived=0 ORDER BY first_name', fam.id, a.id),
      } : null,
      team: a.team_id ? get('SELECT t.id, t.team_name, s.name AS school FROM team_contracts t JOIN schools s ON s.id=t.school_id WHERE t.id=?', a.team_id) : null,
      membership: membershipView(req, m),
      membership_request: openRequest(a.id, m),
      sessions_left: (() => { const n = billing.memberSessionsLeft(a.id); return { member_group: n === Infinity ? 'unlimited' : n, group_credits: a.group_credits, private_credits: a.private_credits }; })(),
      upcoming: all(`SELECT b.id, b.status, b.coverage, b.checked_in_at, e.id AS event_id, e.name, e.starts_at, e.type, l.name AS location FROM bookings b JOIN events e ON e.id=b.event_id
        LEFT JOIN locations l ON l.id=e.location_id WHERE b.athlete_id=? AND b.status IN ('booked','waitlist') AND e.cancelled=0 AND e.starts_at>=? ORDER BY e.starts_at LIMIT 10`, a.id, now.slice(0, 10)),
      upcoming_total: get(`SELECT COUNT(*) n FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.status IN ('booked','waitlist') AND e.cancelled=0 AND e.starts_at>=?`, a.id, now.slice(0, 10)).n,
      visits: clients.visits(a.id, now),
      notes: clients.notesFor(a.id, req.staff),
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
    for (const k of ['sport', 'position', 'school', 'phone', 'allergies', 'injuries', 'medical_notes', 'emergency_name', 'emergency_phone']) if (k in b) patch[k] = clean(b[k]);
    if ('grad_year' in b) patch.grad_year = clients.gradYear(b.grad_year);
    if ('email' in b) { const e = clean(b.email)?.toLowerCase() || null; if (e && !EMAIL_RE.test(e)) throw bad('That email doesn\'t look right.'); patch.email = e; }
    if ('birthday' in b) patch.birthday = birthDate(b.birthday);
    if ('sex' in b) patch.sex = sex(b.sex);
    if ('coach_notes' in b) {
      if (req.staff.role === 'frontdesk') throw new HttpError(403, 'Only coaches can edit coach notes.');
      patch.coach_notes = clean(b.coach_notes);
    }
    if (!Object.keys(patch).length) throw bad('Nothing to save.');
    update('athletes', a.id, patch);
    log(req, 'Updated client profile', `${patch.first_name || a.first_name} ${patch.last_name || a.last_name} (${a.code})`);
    res.json({ ok: true });
  }));

  api.post('/athletes/:id/archive', requireStaff('owner', 'coach'), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    const m = billing.activeMembership(a.id);
    if (m) throw bad('Cancel the membership before archiving this client.');
    const restore = req.body?.restore === true;
    if (!restore && a.archived) throw bad(`${a.first_name} is already archived.`);
    if (restore && !a.archived) throw bad(`${a.first_name} isn't archived.`);
    // One transaction: the bookings, the credits and the archive flag all change together, or none do.
    const cancelled = tx(() => {
      let n = 0;
      if (!restore) {
        // Upcoming bookings go too, so archived clients don't sit on rosters and waitlists; credits come back.
        const upcoming = all(`SELECT b.id FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.athlete_id=? AND b.status IN ('booked','waitlist')
          AND e.cancelled=0 AND e.starts_at>=?`, a.id, booking.nowLocal());
        for (const b of upcoming) {
          booking.cancelBooking(b.id, { byParent: false });
          run("UPDATE sales SET status='refunded', refunded_cents=total_cents WHERE booking_id=? AND status IN ('paid','partial_refund')", b.id);
          n++;
        }
      }
      update('athletes', a.id, { archived: restore ? 0 : 1 });
      if (!restore) run("DELETE FROM standing_spots WHERE athlete_id=?", a.id);
      return n;
    });
    log(req, restore ? 'Restored client' : 'Archived client', `${a.first_name} ${a.last_name} (${a.code})${cancelled ? `, ${cancelled} upcoming booking${cancelled === 1 ? '' : 's'} cancelled` : ''}`);
    res.json({ ok: true, cancelled });
  }));

  // ---- family ----
  api.post('/families/:id/athletes', requireStaff(), h(async (req, res) => {
    const fam = get('SELECT * FROM families WHERE id=?', Number(req.params.id));
    if (!fam) throw notFound('That family');
    const b = req.body || {};
    const programId = b.program_id ? Number(b.program_id) : null;
    noProgramsForDesk(req, programId);
    if (programId && !get('SELECT 1 FROM programs WHERE id=? AND archived=0', programId)) throw bad('Choose a program.');
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

  // Fix a parent's name, email or phone (typos at sign-up are the usual reason they can't sign in).
  api.put('/parents/:id', requireStaff(), h(async (req, res) => {
    const p = get('SELECT * FROM parents WHERE id=?', Number(req.params.id));
    if (!p) throw notFound('That parent');
    const b = req.body || {};
    const patch = {};
    if ('name' in b) { patch.name = clean(b.name); if (!patch.name) throw bad('Enter their name.'); }
    if ('email' in b) {
      patch.email = clean(b.email)?.toLowerCase();
      if (!EMAIL_RE.test(patch.email || '')) throw bad('Enter their email. It\'s how they sign in.');
      if (get('SELECT 1 FROM parents WHERE email=? AND id<>?', patch.email, p.id)) throw bad('That email already has a portal login.');
    }
    if ('phone' in b) patch.phone = clean(b.phone);
    if (!Object.keys(patch).length) throw bad('Nothing to save.');
    tx(() => {
      update('parents', p.id, patch);
      // An adult who pays for themselves signs in with their own email: keep their athlete email in step.
      if (p.is_self && patch.email && patch.email !== p.email) run('UPDATE athletes SET email=? WHERE family_id=? AND email=?', patch.email, p.family_id, p.email);
    });
    const fam = get('SELECT name FROM families WHERE id=?', p.family_id);
    const changed = Object.keys(patch).map((k) => (k === 'email' && patch.email !== p.email ? `email ${p.email} to ${patch.email}` : k === 'email' ? null : k)).filter(Boolean);
    log(req, 'Updated parent', `${patch.name || p.name}, ${fam?.name || 'family'}${changed.length ? ` (${changed.join(', ')})` : ''}`);
    res.json({ ok: true });
  }));

  // Remove a second parent or guardian. The family keeps at least one sign-in, and an adult's own login stays.
  api.delete('/parents/:id', requireStaff(), h(async (req, res) => {
    const p = get('SELECT * FROM parents WHERE id=?', Number(req.params.id));
    if (!p) throw notFound('That parent');
    if (p.is_self) throw bad('This is the client\'s own sign-in. Edit the email instead.');
    if (get('SELECT COUNT(*) n FROM parents WHERE family_id=?', p.family_id).n < 2) throw bad('A family needs at least one parent to sign in and pay. Edit this one instead.');
    tx(() => {
      run('DELETE FROM parents WHERE id=?', p.id);
      run("DELETE FROM auth_sessions WHERE kind='parent' AND user_id=?", p.id);
    });
    const fam = get('SELECT name FROM families WHERE id=?', p.family_id);
    log(req, 'Removed parent', `${p.name} (${p.email}) from ${fam?.name || 'family'}`);
    res.json({ ok: true });
  }));

  // Re-send the welcome email with the portal link (lost it, or the email was just corrected).
  api.post('/parents/:id/welcome', requireStaff(), h(async (req, res) => {
    const p = get('SELECT * FROM parents WHERE id=?', Number(req.params.id));
    if (!p) throw notFound('That parent');
    const kid = get('SELECT first_name FROM athletes WHERE family_id=? AND archived=0 ORDER BY id LIMIT 1', p.family_id);
    welcomeParent(p, kid?.first_name || 'Your athlete');
    log(req, 'Re-sent portal email', `${p.name} (${p.email})`);
    res.json({ ok: true, email: p.email });
  }));

  // A family signed the waiver on paper at the desk: record who signed, against the current version.
  api.post('/families/:id/waiver', requireStaff(), h(async (req, res) => {
    const fam = get('SELECT * FROM families WHERE id=?', Number(req.params.id));
    if (!fam) throw notFound('That family');
    const signer = clean(req.body?.signed_by);
    if (!signer) throw bad('Enter the name of the parent who signed.');
    if (signer.length > 120) throw bad('Keep the name under 120 characters.');
    const wv = waiverVersion();
    if (Number(fam.waiver_version || 0) >= wv) throw bad('The current waiver is already signed.');
    update('families', fam.id, { waiver_version: wv, waiver_signed_at: new Date().toISOString(), waiver_signed_by: `${signer} (on paper)` });
    log(req, 'Recorded paper waiver', `${fam.name}: signed by ${signer}`);
    res.json({ ok: true });
  }));

  // ---- staff notes on a client ----
  api.post('/athletes/:id/notes', requireStaff(), h(async (req, res) => {
    const a = athleteRow(Number(req.params.id));
    const body = String(req.body?.body ?? '').trim();
    if (!body) throw bad('Write the note first.');
    if (body.length > 2000) throw bad('Keep notes under 2,000 characters.');
    const coachOnly = req.body?.coach_only === true;
    if (coachOnly && req.staff.role === 'frontdesk') throw new HttpError(403, 'Only coaches and owners can write coach-only notes.');
    const id = insert('client_notes', { athlete_id: a.id, staff_id: req.staff.id, staff_name: req.staff.name, body, pinned: req.body?.pinned === true ? 1 : 0, coach_only: coachOnly ? 1 : 0 });
    log(req, 'Added a client note', `${a.first_name} ${a.last_name}${coachOnly ? ' (coaches only)' : ''}`);
    res.status(201).json({ id });
  }));

  const noteFor = (req) => {
    const n = get('SELECT * FROM client_notes WHERE id=?', Number(req.params.id));
    if (!n || (n.coach_only && req.staff.role === 'frontdesk')) throw notFound('That note');
    return n;
  };
  api.put('/notes/:id', requireStaff(), h(async (req, res) => {
    const n = noteFor(req);
    const patch = {};
    if ('pinned' in (req.body || {})) patch.pinned = req.body.pinned ? 1 : 0;
    if ('body' in (req.body || {})) {
      if (n.staff_id !== req.staff.id) throw new HttpError(403, 'Only the person who wrote a note can change its words.');
      patch.body = String(req.body.body ?? '').trim();
      if (!patch.body) throw bad('Write the note first.');
      if (patch.body.length > 2000) throw bad('Keep notes under 2,000 characters.');
    }
    if (!Object.keys(patch).length) throw bad('Nothing to save.');
    update('client_notes', n.id, patch);
    const a = get('SELECT first_name, last_name FROM athletes WHERE id=?', n.athlete_id);
    log(req, 'pinned' in patch && !('body' in patch) ? (patch.pinned ? 'Pinned a client note' : 'Unpinned a client note') : 'Edited a client note', `${a.first_name} ${a.last_name}`);
    res.json({ ok: true });
  }));
  api.delete('/notes/:id', requireStaff(), h(async (req, res) => {
    const n = noteFor(req);
    if (n.staff_id !== req.staff.id && req.staff.role !== 'owner') throw new HttpError(403, 'Only the person who wrote a note, or an owner, can delete it.');
    run('DELETE FROM client_notes WHERE id=?', n.id);
    const a = get('SELECT first_name, last_name FROM athletes WHERE id=?', n.athlete_id);
    log(req, 'Deleted a client note', `${a.first_name} ${a.last_name}`);
    res.json({ ok: true, note: { body: n.body, pinned: !!n.pinned, coach_only: !!n.coach_only } });
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
    // Coaches never see money: the drop-in price is for the owner and the front desk, who take the payment.
    res.json({ ok: true, booking_id: b.id, coverage: b.coverage, price_cents: b.coverage === 'unpaid' && req.staff.role !== 'coach' ? e.price_cents : undefined });
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
