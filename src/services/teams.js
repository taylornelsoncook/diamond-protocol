import { newId, token, v, notFound, badRequest, conflict, HttpError, isDate, addDaysToDate, localDate, startOfLocalDay, zonedToUtc } from '../util.js';
import { emit } from './events.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';
import { newAthleteId, findByAthleteId, clientOfRoster, ID_PATTERN } from './athlete-ids.js';

// Schools and clubs pay a flat monthly fee per team. Each month is invoiced in advance on the
// anniversary of the start date and is due on the contract's terms (Net 30 by default).
const ORG_KINDS = ['school', 'club', 'other'];
const PAY_METHODS = ['check', 'ach', 'card', 'cash', 'online', 'other'];
const MANUAL_METHODS = PAY_METHODS.filter((m) => m !== 'online');   // online payments are recorded by Stripe, never by hand
const METHOD_WORD = { check: 'check', ach: 'bank transfer', card: 'card', cash: 'cash', online: 'online payment', other: 'payment' };
const MAX_FEE = 100000000;
const today = (ctx) => localDate(ctx.now(), getSetting(ctx, 'timezone'));
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

// A 400 (or 409) that names the form field to fix, so the dashboard can point at it.
function fieldError(message, field, status = 400) {
  const e = new HttpError(status, status === 409 ? 'conflict' : 'invalid_request', message);
  e.details = { field };
  return e;
}
// A real calendar day in YYYY-MM-DD. Date.parse quietly turns Feb 30 into Mar 2.
export function realDate(s) {
  if (!isDate(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// Month k of a contract starting 2026-01-31: Jan 31, Feb 28, Mar 31 … (anchored to the start day, no drift)
export function periodStart(startDate, k) {
  const [y, m, d] = startDate.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
// The first billing day on or after `day`.
function firstPeriodFrom(startDate, day) {
  for (let k = 0; k < 2400; k++) { const p = periodStart(startDate, k); if (p >= day) return p; }
  return day;
}
// The billing day of the month that `day` falls in (the latest one on or before it).
function periodContaining(startDate, day) {
  let prev = startDate;
  for (let k = 0; k < 2400; k++) { const p = periodStart(startDate, k); if (p > day) return prev; prev = p; }
  return prev;
}

// ---------- Organizations ----------
function orgInput(body, cur = {}) {
  const pick = (k, fn) => (body[k] !== undefined ? fn(body[k]) : cur[k] ?? null);
  return {
    name: pick('name', (x) => { if (!String(x ?? '').trim()) throw fieldError('Enter the school or club name.', 'org_name'); return v.str(x, 'organization name', { max: 120 }); }),
    kind: pick('kind', (x) => v.oneOf(x, 'kind', ORG_KINDS)) ?? 'school',
    contact_name: pick('contact_name', (x) => v.str(x, 'contact_name', { max: 120, optional: true })),
    contact_email: pick('contact_email', (x) => { if (!x) return null; try { return v.email(x, 'contact_email'); } catch { throw fieldError('That billing email doesn\'t look right. Check it and try again.', 'contact_email'); } }),
    contact_phone: pick('contact_phone', (x) => {
      const p = v.str(x, 'contact_phone', { max: 40, optional: true });
      if (p && (!/^[\d\s().+\-x]+$/i.test(p) || (p.match(/\d/g) ?? []).length < 7)) throw fieldError('That phone number doesn\'t look right. Use digits, like (512) 555-0142.', 'contact_phone');
      return p;
    }),
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
const teamName = (x) => {
  const s = typeof x === 'string' ? x.trim() : '';
  if (!s) throw fieldError('Enter the team name, like Varsity Football.', 'name');
  if (s.length > 120) throw fieldError('Keep the team name under 120 characters.', 'name');
  return s;
};
const feeCents = (x) => {
  const n = Number(x);
  if (x === '' || x == null || !Number.isInteger(n) || n < 1) throw fieldError('Enter the monthly fee.', 'monthly_cents');
  if (n > MAX_FEE) throw fieldError('That monthly fee looks too high. Check the amount.', 'monthly_cents');
  return n;
};
const termsDays = (x) => {
  const n = Number(x);
  if (!Number.isInteger(n) || n < 0 || n > 120) throw fieldError('Payment terms must be 0 to 120 days.', 'terms_days');
  return n;
};
// Another active contract for the same team at the same school or club (matched by the school's name too).
function duplicateActive(ctx, orgName, name, exceptId = '') {
  return ctx.db.get(`SELECT t.id FROM team_contracts t JOIN organizations o ON o.id = t.org_id
    WHERE t.status = 'active' AND t.id != ? AND lower(o.name) = lower(?) AND lower(t.name) = lower(?)`, exceptId, orgName, name);
}

// past (for a start date before today): 'all' invoices every month that has started (default), 'current' only the
// month running now, 'none' none of them (they were billed another way); later months follow on their billing day.
export async function createContract(ctx, body, baseUrl) {
  if (!body.org_id) orgInput(body.organization ?? {});   // the school's fields first: they're at the top of the form
  const name = teamName(body.name);
  const monthly = feeCents(body.monthly_cents);
  const start = body.start_date || today(ctx);
  if (!realDate(start)) throw fieldError('Choose a start date, like 2026-10-01.', 'start_date');
  const end = body.end_date || null;
  if (end && !realDate(end)) throw fieldError('Choose an end date, like 2027-05-31.', 'end_date');
  if (end && end < start) throw fieldError('The end date must be on or after the start date.', 'end_date');
  const terms = termsDays(body.terms_days ?? 30);
  const po = v.str(body.po_number, 'po_number', { max: 60, optional: true });
  const notes = v.str(body.notes, 'notes', { max: 2000, optional: true });
  const past = body.past ?? 'all';
  if (!['all', 'current', 'none'].includes(past)) throw fieldError('past must be all, current or none.', 'past');
  const day = today(ctx);
  let next = start;
  if (start < day && past === 'current') next = periodContaining(start, end && end < day ? end : day);   // a contract that already ended: its last month
  if (start < day && past === 'none') next = firstPeriodFrom(start, addDaysToDate(day, 1));
  const id = newId('tc');
  const orgId = ctx.db.tx(() => {
    const org = body.org_id ? getOrg(ctx, body.org_id) : orgInput(body.organization ?? {});
    if (duplicateActive(ctx, org.name, name)) throw fieldError(`${org.name} already has an active ${name} contract. Open it from Teams, or use a different team name.`, 'name', 409);
    const oid = org.id ?? createOrg(ctx, body.organization ?? {}).id;
    ctx.db.run(`INSERT INTO team_contracts (id, org_id, name, monthly_cents, start_date, end_date, terms_days, po_number, status, next_period_start, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`, id, oid, name, monthly, start, end, terms, po, next, notes, ctx.now());
    return oid;
  });
  const c = getContract(ctx, id);
  emit(ctx, 'team_contract.created', { contract_id: id, org_id: orgId, org_name: c.org.name, team_name: c.name, monthly_cents: c.monthly_cents });
  await runTeamBilling(ctx, { baseUrl, contractId: id });   // bills the months that have started now (see past)
  return getContract(ctx, id, baseUrl);
}

const invoiceStatus = (ctx, i) => (i.status === 'open' && i.due_on < today(ctx) ? 'overdue' : i.status);
function shapeInvoice(ctx, i, baseUrl) {
  const status = invoiceStatus(ctx, i);
  return { ...i, lines: JSON.parse(i.lines), status, days_past_due: status === 'overdue' ? daysBetween(i.due_on, today(ctx)) : 0, link: `${baseUrl ?? ctx.publicUrl ?? ''}/invoice/${i.public_token}` };
}

// A team's current roster: active lines whose athlete isn't archived, with the name and Athlete ID from the athlete's
// profile (one profile per athlete). Archived athletes stay on the roster's history and come back when restored.
export const activeRoster = (ctx, contractId) => ctx.db.all(`SELECT r.id, r.contract_id, r.client_id, COALESCE(c.name, r.name) AS name, COALESCE(c.athlete_id, r.athlete_id) AS athlete_id,
    r.position, r.grad_year, r.active, r.created_at
  FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.contract_id = ? AND r.active = 1 AND c.archived_at IS NULL ORDER BY COALESCE(c.name, r.name)`, contractId);

// Team sessions held so far, and each roster athlete's attendance from the day they joined (plus any earlier
// session they were marked at), the last time they were here, and the last few sessions' check-ins.
function attendance(ctx, contractId, { recent = 8 } = {}) {
  const sessions = ctx.db.all(`SELECT s.id, s.starts_at FROM class_sessions s JOIN class_series cs ON cs.id = s.series_id WHERE cs.contract_id = ? AND s.status = 'scheduled' ORDER BY s.starts_at`, contractId);
  const heldRows = sessions.filter((s) => s.starts_at <= ctx.now());
  const zone = getSetting(ctx, 'timezone');
  // Attendance is kept on each athlete's profile (by client), for this team's sessions.
  const marks = new Map();
  for (const a of ctx.db.all(`SELECT a.client_id, a.session_id FROM team_attendance a JOIN class_sessions s ON s.id = a.session_id JOIN class_series cs ON cs.id = s.series_id WHERE cs.contract_id = ?`, contractId)) {
    if (!marks.has(a.client_id)) marks.set(a.client_id, new Set());
    marks.get(a.client_id).add(a.session_id);
  }
  const roster = activeRoster(ctx, contractId).map((r) => {
    const here = marks.get(r.client_id) ?? new Set();
    const since = startOfLocalDay(r.created_at, zone);
    const theirs = heldRows.filter((s) => s.starts_at >= since || here.has(s.id));
    const came = theirs.filter((s) => here.has(s.id));
    return { ...r, since, sessions_held: theirs.length, sessions_attended: came.length, attendance_rate: theirs.length ? came.length / theirs.length : null, last_seen: came.length ? came[came.length - 1].starts_at : null };
  });
  const rated = roster.filter((r) => r.attendance_rate != null);
  const recentSessions = heldRows.slice(-recent).reverse().map((s) => {
    const expected = roster.filter((r) => s.starts_at >= r.since || (marks.get(r.client_id)?.has(s.id)));
    return { id: s.id, starts_at: s.starts_at, here: expected.filter((r) => marks.get(r.client_id)?.has(s.id)).length, roster: expected.length };
  });
  return {
    roster: roster.map(({ since, ...r }) => r), recent_sessions: recentSessions,
    team_rate: rated.length ? rated.reduce((t, r) => t + r.attendance_rate, 0) / rated.length : null,
    sessions_held: heldRows.length, sessions_upcoming: sessions.length - heldRows.length
  };
}
const nextInvoiceOn = (c) => (c.status === 'active' && (!c.end_date || c.next_period_start <= c.end_date) ? c.next_period_start : null);

export function getContract(ctx, id, baseUrl) {
  const c = ctx.db.get('SELECT * FROM team_contracts WHERE id = ?', id);
  if (!c) throw notFound('Team contract');
  const att = attendance(ctx, id);
  const invoices = ctx.db.all('SELECT * FROM team_invoices WHERE contract_id = ? ORDER BY issued_on DESC, number DESC', id).map((i) => shapeInvoice(ctx, i, baseUrl));
  const unpaid = invoices.filter((i) => i.status === 'open' || i.status === 'overdue');
  return {
    ...c, org: getOrg(ctx, c.org_id), ...att,
    series: ctx.db.all(`SELECT s.id, s.name, s.weekdays, s.start_time, s.duration_min, s.location_id, l.name AS location_name, s.coach_id, u.name AS coach_name, s.start_date, s.end_date, s.active,
        (SELECT MIN(x.starts_at) FROM class_sessions x WHERE x.series_id = s.id AND x.status = 'scheduled' AND x.starts_at > ?) AS next_starts_at
      FROM class_series s LEFT JOIN locations l ON l.id = s.location_id LEFT JOIN users u ON u.id = s.coach_id WHERE s.contract_id = ? ORDER BY s.active DESC, s.created_at`, ctx.now(), id)
      .map((s) => ({ ...s, weekdays: JSON.parse(s.weekdays), active: !!s.active })),
    invoices,
    balance_cents: unpaid.reduce((t, i) => t + i.amount_cents, 0),
    open_count: unpaid.length,
    paid_cents: invoices.filter((i) => i.status === 'paid').reduce((t, i) => t + i.amount_cents, 0),
    next_invoice_on: nextInvoiceOn(c)
  };
}

export function listContracts(ctx) {
  const day = today(ctx);
  return ctx.db.all(`SELECT c.*, o.name AS org_name, o.kind AS org_kind, o.contact_email,
      (SELECT COUNT(*) FROM team_roster r JOIN clients x ON x.id = r.client_id WHERE r.contract_id = c.id AND r.active = 1 AND x.archived_at IS NULL) AS roster_count
    FROM team_contracts c JOIN organizations o ON o.id = c.org_id ORDER BY c.status, o.name, c.name`).map((c) => {
    const open = ctx.db.all(`SELECT amount_cents, due_on FROM team_invoices WHERE contract_id = ? AND status = 'open'`, c.id);
    const overdue = open.filter((i) => i.due_on < day);
    return { ...c, balance_cents: open.reduce((t, i) => t + i.amount_cents, 0), open_count: open.length,
      overdue_cents: overdue.reduce((t, i) => t + i.amount_cents, 0), overdue_count: overdue.length,
      attendance_rate: c.roster_count ? attendance(ctx, c.id, { recent: 0 }).team_rate : null,
      next_invoice_on: nextInvoiceOn(c) };
  });
}

// Team sessions follow the contract's end date, both ways. A shorter contract takes the sessions after it off
// (ones nobody was booked or checked in at are deleted, so a longer end date later can put them back); a longer
// one schedules up to the new date. Only the contract's current (active) team schedules follow: a schedule that was
// removed, or archived when the contract ended, stays off. Sessions canceled one at a time (weather) stay canceled.
async function followEndDate(ctx, contractId, end, sched) {
  let removed = 0, added = 0;
  const cutoff = end ? zonedToUtc(addDaysToDate(end, 1), '00:00', getSetting(ctx, 'timezone')) : null;
  for (const s of ctx.db.all('SELECT id FROM class_series WHERE contract_id = ? AND active = 1', contractId)) {
    ctx.db.run('UPDATE class_series SET end_date = ? WHERE id = ?', end, s.id);
    if (cutoff) {
      for (const x of ctx.db.all(`SELECT id FROM class_sessions WHERE series_id = ? AND status = 'scheduled' AND starts_at >= ? AND starts_at > ?`, s.id, cutoff, ctx.now())) {
        const used = ctx.db.get(`SELECT (SELECT COUNT(*) FROM bookings WHERE session_id = ?) + (SELECT COUNT(*) FROM team_attendance WHERE session_id = ?) + (SELECT COUNT(*) FROM spot_offers WHERE session_id = ?) AS n`, x.id, x.id, x.id).n;
        if (used) await sched.cancelSession(x.id, { reason: 'The team contract ends before this date.' });
        else ctx.db.run('DELETE FROM class_sessions WHERE id = ?', x.id);
        removed++;
      }
    }
    added += await sched.generateSessions(s.id);
  }
  return { removed, added };
}

const futureTeamSessions = (ctx, contractId) => ctx.db.get(`SELECT COUNT(*) AS n FROM class_sessions s JOIN class_series cs ON cs.id = s.series_id
  WHERE cs.contract_id = ? AND cs.active = 1 AND s.status = 'scheduled' AND s.starts_at > ?`, contractId, ctx.now()).n;

// New fee applies from the next invoice. Ending a contract stops invoicing and archives its team sessions.
// Restarting an ended contract (status active, or clearing or moving its end date to today or later) bills from the
// next billing day: the months it was ended aren't invoiced. Saving an ended contract unchanged doesn't restart it.
// sched: { updateSeries, cancelSession, generateSessions } bound to ctx (schedule.js depends on this file).
export async function updateContract(ctx, id, body, sched = {}, baseUrl) {
  const c = getContract(ctx, id);
  const day = today(ctx);
  const org = getOrg(ctx, c.org_id);
  let end = c.end_date;
  if (body.end_date !== undefined) {
    end = body.end_date || null;
    if (end && !realDate(end)) throw fieldError('Choose an end date, like 2027-05-31.', 'end_date');
    if (end && end < c.start_date) throw fieldError(`The end date must be on or after the start date (${longDate(c.start_date)}).`, 'end_date');
  }
  const endChanged = (end ?? null) !== (c.end_date ?? null);
  const name = body.name !== undefined ? teamName(body.name) : c.name;
  const monthly = body.monthly_cents !== undefined && Number(body.monthly_cents) !== c.monthly_cents ? feeCents(body.monthly_cents) : c.monthly_cents;   // an unchanged fee always saves
  const terms = body.terms_days !== undefined ? termsDays(body.terms_days) : c.terms_days;
  const po = body.po_number !== undefined ? v.str(body.po_number, 'po_number', { max: 60, optional: true }) : c.po_number;
  const notes = body.notes !== undefined ? v.str(body.notes, 'notes', { max: 2000, optional: true }) : c.notes;
  if (body.status !== undefined) v.oneOf(body.status, 'status', ['active', 'ended']);
  const ending = body.status === 'ended' && c.status !== 'ended';
  let restart = c.status === 'ended' && !ending && (body.status === 'active' || (endChanged && (!end || end >= day)));
  if (restart && end && end < day && body.end_date !== undefined) throw fieldError('To restart this contract, clear the end date or move it to today or later.', 'end_date');
  if (restart && end && end <= day && body.end_date === undefined) end = null;   // status=active alone: it runs open-ended again
  const endMoved = (end ?? null) !== (c.end_date ?? null);   // includes that open-ended restart, so the team sessions follow it too
  if (((c.status === 'active' && name !== c.name) || restart) && !ending && duplicateActive(ctx, org.name, name, id)) throw fieldError(`${org.name} already has an active ${name} contract. Use a different team name.`, 'name', 409);
  const restartFrom = restart ? firstPeriodFrom(c.start_date, day) : null;
  const endedOn = ending ? (c.end_date && c.end_date < day ? c.end_date : day) : null;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE team_contracts SET name = ?, monthly_cents = ?, end_date = ?, terms_days = ?, po_number = ?, notes = ? WHERE id = ?', name, monthly, ending ? endedOn : end, terms, po, notes, id);
    if (ending) ctx.db.run(`UPDATE team_contracts SET status = 'ended' WHERE id = ?`, id);
    if (restart) ctx.db.run(`UPDATE team_contracts SET status = 'active', next_period_start = MAX(next_period_start, ?) WHERE id = ?`, restartFrom, id);
    // Renaming the team renames its team sessions that still carry the default name.
    if (name !== c.name) {
      const was = `${org.name} ${c.name}`, now = `${org.name} ${name}`;
      for (const s of ctx.db.all('SELECT id FROM class_series WHERE contract_id = ? AND name = ?', id, was)) {
        ctx.db.run('UPDATE class_series SET name = ? WHERE id = ?', now, s.id);
        ctx.db.run(`UPDATE class_sessions SET name = ? WHERE series_id = ? AND name = ? AND starts_at > ?`, now, s.id, was, ctx.now());
      }
    }
  });
  const out = { restarted: restart, restart_billing_on: restartFrom, sessions_removed: 0, sessions_added: 0 };
  if (ending) {
    out.sessions_removed = futureTeamSessions(ctx, id);
    for (const s of c.series.filter((x) => x.active)) await sched.updateSeries?.(s.id, { active: false });
  } else if (endMoved && (c.status === 'active' || restart) && sched.generateSessions) {
    const r = await followEndDate(ctx, id, end, sched);
    out.sessions_removed = r.removed; out.sessions_added = r.added;
  }
  if (restart) await runTeamBilling(ctx, { baseUrl, contractId: id });   // today may be a billing day
  return { ...getContract(ctx, id, baseUrl), ...out };
}

// ---------- Roster and attendance ----------
// One profile per athlete: every roster line links a client. Adding someone to a roster puts a client you already have
// on it (chosen by the coach, or by an exact Athlete ID), or creates a client for them: name, position and grad year
// (the school for a school team), no family and no membership, so they're a "Team only" client, not an active one.
// A name that matches a client you already have is never linked on its own: the coach chooses.
// Pasted team lists: one athlete per line, "Name, position, grad year" (tabs from a spreadsheet work too). List and
// jersey numbers ("1.", "#12", "Deon Parkes #22", "Deon Parkes 22", or a number column of its own) are dropped, "Class of
// 2028" is a grad year, an Athlete ID (AVALOP2026) puts that client on the team, and a spreadsheet header row
// ("Name, Position, Grad year") is skipped.
const HEADER_CELL = /^(#|no\.?|num(ber)?|jersey|name|player|athlete|full name|player name|athlete name|first name|last name|position|pos|grad( year)?|class( of)?|year|athlete id|id)$/i;
const JERSEY = /^#?\s*\d{1,3}$/;
export function parseRoster(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l, i) => ({ line: l.trim(), n: i })).filter((x) => x.line);
  const cells = (l) => l.split(/\t|,/).map((x) => x.trim());
  if (lines.length && !/\d{4}/.test(lines[0].line) && cells(lines[0].line).filter(Boolean).some((x) => HEADER_CELL.test(x)) && cells(lines[0].line).filter(Boolean).every((x) => HEADER_CELL.test(x))) lines.shift();
  return lines.map(({ line, n }) => {
    const parts = cells(line);
    if (parts.length > 1 && JERSEY.test(parts[0])) parts.shift();
    const name = parts[0].replace(/^(#\s*\d{1,3}|\d{1,3}[.)]?)\s+/, '').replace(/\s+#?\s*\d{1,3}$/, '').replace(/\s+/g, ' ').trim();
    const row = { line: n + 1, text: line, name, position: null, grad_year: null, athlete_id: null, error: null };
    if (name.split(' ').length < 2 || /\d/.test(name)) { row.error = `Line ${n + 1} needs a first and last name: "${line.slice(0, 80)}"`; return row; }
    if (name.length > 120) { row.error = `Line ${n + 1}: the name is longer than 120 characters.`; return row; }
    for (const x of parts.slice(1).filter((p) => p && !JERSEY.test(p))) {
      const y = x.match(/^(?:class of\s+)?(\d{4}|'\d{2})$/i);
      if (ID_PATTERN.test(x.toUpperCase())) row.athlete_id = x.toUpperCase();
      else if (y) {
        const yr = y[1].startsWith("'") ? 2000 + Number(y[1].slice(1)) : Number(y[1]);
        if (yr < 2000 || yr > 2060) row.error = `Line ${n + 1}: ${y[1]} doesn't look like a grad year. Use a year like 2028.`;
        else row.grad_year = yr;
      } else if (/^(?:class of\s+)?'?\d+$/i.test(x)) row.error = `Line ${n + 1}: "${x}" doesn't look like a grad year. Use a year like 2028.`;
      else if (!row.position) row.position = x.slice(0, 60);
    }
    return row;
  });
}
const otherTeamsSql = `(SELECT group_concat(o.name || ' ' || t.name, '; ') FROM team_roster x JOIN team_contracts t ON t.id = x.contract_id JOIN organizations o ON o.id = t.org_id
  WHERE x.client_id = c.id AND x.active = 1 AND t.status = 'active' AND t.id != ?)`;
const onRosterLine = (ctx, contractId, clientId) => ctx.db.get('SELECT id FROM team_roster WHERE contract_id = ? AND client_id = ? AND active = 1', contractId, clientId);
// What each pasted line will do, without saving: new (a new client), link (an Athlete ID that belongs to a client you
// have), skip (already on this roster, or twice in the list), match (a client you already have with that name: link
// them or add a new athlete) or error.
export function checkRoster(ctx, contractId, body) {
  getContract(ctx, contractId);
  const text = String(body.names ?? body.text ?? '');
  if (text.length > 50000) throw badRequest('That list is too long. Paste up to 200 names at a time.');
  const rows = parseRoster(text);
  if (!rows.length) throw fieldError('Paste at least one name, one per line.', 'names');
  if (rows.length > 200) throw fieldError('Add up to 200 athletes at a time.', 'names');
  const seen = new Set();
  for (const r of rows) {
    if (r.error) { r.status = 'error'; continue; }
    if (r.athlete_id) {
      const who = findByAthleteId(ctx, r.athlete_id);
      const c = who && ctx.db.get('SELECT id, name, athlete_id, archived_at FROM clients WHERE id = ?', who.client_id);
      if (!c) { r.status = 'error'; r.error = `Line ${r.line}: no athlete has the ID ${r.athlete_id}. Check it, or leave it out to add ${r.name} as a new athlete.`; continue; }
      if (c.archived_at) { r.status = 'error'; r.error = `Line ${r.line}: ${c.name} (${c.athlete_id}) is archived. Bring them back from their profile first.`; continue; }
      if (onRosterLine(ctx, contractId, c.id) || seen.has(`id:${c.id}`)) { r.status = 'skip'; r.reason = seen.has(`id:${c.id}`) ? 'Listed twice' : 'Already on this roster'; continue; }
      seen.add(`id:${c.id}`); seen.add(c.name.toLowerCase());
      r.status = 'link'; r.client = { id: c.id, name: c.name, athlete_id: c.athlete_id };
      continue;
    }
    const key = r.name.toLowerCase();
    const on = ctx.db.get('SELECT c.archived_at FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.contract_id = ? AND r.active = 1 AND lower(c.name) = ?', contractId, key);
    if (on || seen.has(key)) { r.status = 'skip'; r.reason = !on ? 'Listed twice' : on.archived_at ? 'On this roster, but archived: bring them back from their profile' : 'Already on this roster'; continue; }
    seen.add(key);
    r.matches = ctx.db.all(`SELECT c.id, c.name, c.athlete_id, c.birth_date, ${otherTeamsSql} AS teams
      FROM clients c WHERE c.archived_at IS NULL AND lower(c.name) = ? AND c.id NOT IN (SELECT client_id FROM team_roster WHERE contract_id = ? AND active = 1 AND client_id IS NOT NULL)
      ORDER BY c.created_at LIMIT 5`, contractId, key, contractId);
    r.status = r.matches.length ? 'match' : 'new';
  }
  const count = (st) => rows.filter((r) => r.status === st).length;
  return { rows, counts: { new: count('new'), link: count('link'), match: count('match'), skip: count('skip'), error: count('error') } };
}

// A new client for a roster athlete: no family, no membership, a private app link and an Athlete ID of their own.
function createRosterClient(ctx, contractId, { name, position, grad_year }) {
  const org = ctx.db.get('SELECT o.name, o.kind FROM team_contracts t JOIN organizations o ON o.id = t.org_id WHERE t.id = ?', contractId);
  const id = newId('cli'), athleteId = newAthleteId(ctx, name);
  ctx.db.run('INSERT INTO clients (id, athlete_id, name, access_token, position, school, grad_year, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, athleteId, name, token(24), position ?? null, org?.kind === 'school' ? org.name : null, grad_year ?? null, ctx.now());
  emit(ctx, 'client.created', { client_id: id, athlete_id: athleteId, client_name: name, email: null, family_id: null, team_contract_id: contractId });
  return id;
}
// Puts a client on the roster (a new line, attendance counting from today). The line keeps a copy of the client's
// name and Athlete ID; a position or grad year from the team list fills the profile's only when it has none.
function insertRoster(ctx, contractId, clientId, { position = null, grad_year = null } = {}) {
  const c = ctx.db.get('SELECT id, name, athlete_id, position, grad_year FROM clients WHERE id = ?', clientId);
  if (!c) throw notFound('Client');
  if (position && !c.position) ctx.db.run('UPDATE clients SET position = ? WHERE id = ?', position, c.id);
  if (grad_year && !c.grad_year) ctx.db.run('UPDATE clients SET grad_year = ? WHERE id = ?', grad_year, c.id);
  const id = newId('tr');
  ctx.db.run('INSERT INTO team_roster (id, contract_id, name, athlete_id, position, grad_year, client_id, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)', id, contractId,
    c.name, c.athlete_id, position ?? c.position ?? null, grad_year ?? c.grad_year ?? null, c.id, ctx.now());
  return id;
}
// A client you already have, for a roster: by client_id or exact Athlete ID. Archived clients are refused.
function existingClient(ctx, body) {
  let id = null;
  if (body.client_id) id = String(body.client_id);
  else if (body.athlete_id) {
    const who = findByAthleteId(ctx, body.athlete_id);
    if (!who) throw fieldError(`No athlete has the ID ${String(body.athlete_id).trim().toUpperCase()}. Check it, or leave it out to add a new athlete.`, 'athlete_id');
    id = who.client_id;
  }
  if (!id) return null;
  const c = ctx.db.get('SELECT id, name, archived_at FROM clients WHERE id = ?', id);
  if (!c) throw notFound('Client');
  if (c.archived_at) throw conflict(`${c.name} is archived. Bring them back from their profile first.`);
  return c;
}
// One athlete ({ name, position, grad_year } for a new client, or client_id / athlete_id for one you already have), or
// a pasted list ({ names }). A list is all or nothing: every line is checked first and nothing is saved while any line
// has a problem (the problems come back in details).
// links: { lineNumber: clientId } puts a matching client you already have on the team instead of a new athlete;
// matching lines without a link are added as new athletes. Everything is checked again when it's saved.
export function addRoster(ctx, contractId, body) {
  getContract(ctx, contractId);
  if (body.names === undefined) {
    const existing = existingClient(ctx, body);
    const nm = existing ? existing.name : v.str(body.name, 'name', { max: 120 });
    const position = v.str(body.position, 'position', { max: 60, optional: true }), grad = v.int(body.grad_year, 'grad_year', { min: 2000, max: 2060, optional: true });
    ctx.db.tx(() => {
      if (existing && onRosterLine(ctx, contractId, existing.id)) throw conflict(`${nm} is already on this roster.`);
      insertRoster(ctx, contractId, existing ? existing.id : createRosterClient(ctx, contractId, { name: nm, position, grad_year: grad }), { position, grad_year: grad });
    });
    return { roster: getContract(ctx, contractId).roster, added: existing ? 0 : 1, linked: existing ? 1 : 0, skipped: 0 };
  }
  const links = Object.fromEntries(Object.entries(body.links && typeof body.links === 'object' ? body.links : {}).filter(([, x]) => x && x !== 'new'));   // 'new' = add as a new athlete
  return ctx.db.tx(() => {
    const plan = checkRoster(ctx, contractId, body);
    if (plan.counts.error) {
      const e = new HttpError(409, 'roster_rejected', `Nothing was added. ${plural(plan.counts.error, 'line needs', 'lines need')} fixing first.`);
      e.details = plan.rows.filter((r) => r.error).map((r) => ({ line: r.line, message: r.error }));
      throw e;
    }
    for (const n of Object.keys(links)) if (!plan.rows.some((r) => String(r.line) === String(n) && r.status === 'match')) throw conflict(`Line ${n} no longer matches a client. Check the list again.`);
    let added = 0, linked = 0;
    for (const r of plan.rows) {
      if (r.status === 'skip') continue;
      if (r.status === 'link') { insertRoster(ctx, contractId, r.client.id, r); linked++; continue; }
      const want = links[r.line];
      if (want) {
        const m = r.matches.find((x) => x.id === want);
        if (!m) throw conflict(`Line ${r.line}: choose one of the matching clients, or add ${r.name} as a new athlete.`);
        insertRoster(ctx, contractId, m.id, r);
        linked++;
      } else { insertRoster(ctx, contractId, createRosterClient(ctx, contractId, r), r); added++; }
    }
    return { roster: getContract(ctx, contractId).roster, added, linked, skipped: plan.counts.skip };
  });
}

// Clients you already have, by name or Athlete ID, with the team each is on now (for Add existing client).
export function searchClientsForTeam(ctx, contractId, q) {
  getContract(ctx, contractId);
  const s = String(q ?? '').trim().toLowerCase();
  if (s.length < 2) return [];
  const like = `%${s.replace(/[%_\\]/g, '')}%`;
  return ctx.db.all(`SELECT c.id, c.name, c.athlete_id, ${otherTeamsSql} AS teams,
      EXISTS (SELECT 1 FROM team_roster x WHERE x.client_id = c.id AND x.contract_id = ? AND x.active = 1) AS on_roster
    FROM clients c WHERE c.archived_at IS NULL AND (lower(c.name) LIKE ? OR lower(COALESCE(c.athlete_id, '')) LIKE ?) ORDER BY c.name LIMIT 12`, contractId, contractId, like, like)
    .map((c) => ({ ...c, on_roster: !!c.on_roster }));
}
// Put a client you already have on this roster. If they're on another active team, move: true takes them off it and
// keep: true leaves them on both (a school team and a club team); with neither the answer is 409 confirm_required, so
// the dashboard can ask first. Their attendance here counts from today.
export function addExistingClient(ctx, contractId, body) {
  const c = getContract(ctx, contractId);
  const client = ctx.db.get('SELECT id, name, archived_at FROM clients WHERE id = ?', v.str(body.client_id, 'client_id', { max: 64 }));
  if (!client) throw notFound('Client');
  if (client.archived_at) throw conflict(`${client.name} is archived. Bring them back from their profile first.`);
  if (onRosterLine(ctx, contractId, client.id)) throw conflict(`${client.name} is already on this roster.`);
  const others = ctx.db.all(`SELECT x.id, o.name || ' ' || t.name AS team FROM team_roster x JOIN team_contracts t ON t.id = x.contract_id JOIN organizations o ON o.id = t.org_id
    WHERE x.client_id = ? AND x.active = 1 AND t.status = 'active' AND t.id != ?`, client.id, contractId);
  if (others.length && body.move !== true && body.keep !== true) {
    const e = new HttpError(409, 'confirm_required', `${client.name} is on ${others.map((o) => o.team).join(' and ')}. Move them here (they come off that roster), or keep them on both. Their profile and results are kept either way.`);
    e.details = { teams: others.map((o) => o.team) };
    throw e;
  }
  const move = body.move === true;
  ctx.db.tx(() => {
    if (move) for (const o of others) ctx.db.run('UPDATE team_roster SET active = 0 WHERE id = ?', o.id);
    insertRoster(ctx, contractId, client.id);   // attendance counts from today
  });
  return { roster: getContract(ctx, contractId).roster, moved_from: move ? others.map((o) => o.team) : [], also_on: move ? [] : others.map((o) => o.team), team: `${c.org.name} ${c.name}` };
}
// Taking someone off a roster keeps their profile, results and attendance.
export function removeRoster(ctx, contractId, rosterId) {
  const r = ctx.db.run('UPDATE team_roster SET active = 0 WHERE id = ? AND contract_id = ? AND active = 1', rosterId, contractId);
  if (!r.changes) throw notFound('Roster athlete');
  return getContract(ctx, contractId).roster;
}
// Undo a removal: the same line comes back, with its join date and attendance.
export function restoreRoster(ctx, contractId, rosterId) {
  const r = ctx.db.get('SELECT r.*, c.name AS client_name, c.archived_at FROM team_roster r LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = ? AND r.contract_id = ?', rosterId, contractId);
  if (!r) throw notFound('Roster athlete');
  if (r.active) return getContract(ctx, contractId).roster;
  const name = r.client_name ?? r.name;
  if (!r.client_id) throw conflict(`${name}'s profile was deleted, so they can't come back on the roster.`);
  if (r.archived_at) throw conflict(`${name} is archived. Bring them back from their profile first.`);
  if (onRosterLine(ctx, contractId, r.client_id)) throw conflict(`${name} is already back on this roster.`);
  ctx.db.run('UPDATE team_roster SET active = 1 WHERE id = ?', rosterId);
  return getContract(ctx, contractId).roster;
}
// For a team session: the contract's current roster with who was there. Each athlete's id is their roster line (as
// before); client_id is their profile, where the check-in is kept.
export function teamRosterFor(ctx, session) {
  const cs = session.series_id && ctx.db.get('SELECT contract_id FROM class_series WHERE id = ?', session.series_id);
  if (!cs?.contract_id) return null;
  const c = ctx.db.get('SELECT t.id, t.name, o.name AS org_name FROM team_contracts t JOIN organizations o ON o.id = t.org_id WHERE t.id = ?', cs.contract_id);
  const present = new Set(ctx.db.all('SELECT client_id FROM team_attendance WHERE session_id = ?', session.id).map((r) => r.client_id));
  return { contract_id: c.id, team_name: c.name, org_name: c.org_name,
    athletes: activeRoster(ctx, c.id).map((r) => ({ id: r.id, client_id: r.client_id, name: r.name, athlete_id: r.athlete_id, position: r.position, grad_year: r.grad_year, present: present.has(r.client_id) })) };
}
// Check an athlete in (or out) at a team session: by roster line (roster_id) or profile (client_id) of someone on the roster.
export function setTeamAttendance(ctx, session, ref, present) {
  const team = teamRosterFor(ctx, session);
  if (!team) throw conflict('This session isn\'t linked to a team contract.');
  const clientId = typeof ref === 'object' ? (ref.client_id ?? clientOfRoster(ctx, ref.roster_id)) : clientOfRoster(ctx, ref);
  if (!clientId || !team.athletes.some((a) => a.client_id === clientId)) throw notFound('Roster athlete');
  if (present) ctx.db.run('INSERT OR IGNORE INTO team_attendance (session_id, client_id, created_at) VALUES (?, ?, ?)', session.id, clientId, ctx.now());
  else ctx.db.run('DELETE FROM team_attendance WHERE session_id = ? AND client_id = ?', session.id, clientId);
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
  const lines = (Array.isArray(body.lines) ? body.lines : [body]).map((l) => ({ description: v.str(l.description, 'description', { max: 200 }), amount_cents: v.int(l.amount_cents, 'amount_cents', { min: 1, max: MAX_FEE }) }));
  const inv = insertInvoice(ctx, c, { lines });
  if (body.send !== false && c.org.contact_email) await sendInvoice(ctx, inv.id, baseUrl);
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

// How to pay, for emails: the pay instructions plus the mailing address, since an email has no letterhead.
function payText(ctx) {
  const how = String(getSetting(ctx, 'payment_instructions') ?? '').trim(), where = String(getSetting(ctx, 'business_address') ?? '').trim();
  return `${how ? `\n\n${how}` : ''}${where ? `\n\nOur mailing address: ${where}` : ''}`;
}
const hello = (name) => `Hi${name ? ` ${name.split(' ')[0]}` : ''},`;

export async function sendInvoice(ctx, id, baseUrl, { reminder = false } = {}) {
  const i = getInvoice(ctx, id, baseUrl);
  if (!['open', 'overdue'].includes(i.status)) throw conflict(`Invoice ${i.number} is ${i.status}.`);
  if (!i.contact_email) throw conflict(`Add a billing email for ${i.org_name} to send invoices.`);
  const biz = getSetting(ctx, 'business_name');
  const late = i.days_past_due ? ` It is ${plural(i.days_past_due, 'day')} past due.` : '';
  const subject = reminder ? `Reminder: invoice ${i.number} from ${biz} was due ${longDate(i.due_on)}` : `Invoice ${i.number} from ${biz}: ${money(i.amount_cents)} due ${longDate(i.due_on)}`;
  const text = `${hello(i.contact_name)}\n\n${reminder ? `This is a reminder that invoice ${i.number} for ${i.team_name} is still open.${late}` : `Here is invoice ${i.number} for ${i.team_name} training${i.period_start ? `, ${longDate(i.period_start)} to ${longDate(i.period_end)}` : ''}.`}\n\nAmount: ${money(i.amount_cents)}\nDue: ${longDate(i.due_on)}${i.po_number ? `\nPO: ${i.po_number}` : ''}\n\nView, print or pay online: ${i.link}${payText(ctx)}\n\nPlease write ${i.number} on the check memo so we can match your payment. Questions? Reply to this email.\n\nThank you,\n${biz}`;
  await sendEmail(ctx, { to: i.contact_email, subject, text });
  ctx.db.run(`UPDATE team_invoices SET ${reminder ? 'reminded_at' : 'sent_at'} = ? WHERE id = ?`, ctx.now(), id);
  return getInvoice(ctx, id, baseUrl);
}

// How and when a payment arrived. Dates must be real calendar days, not in the future (business time zone).
function paymentInput(ctx, body, { online = false } = {}) {
  const method = online ? 'online' : (body.method ?? 'check');
  if (!online) {
    if (method === 'online') throw fieldError('Online payments are recorded automatically when the school pays from the invoice link. Choose check, bank transfer, card, cash or other.', 'method');
    if (!MANUAL_METHODS.includes(method)) throw fieldError('Choose how it was paid: check, ach (bank transfer), card, cash or other.', 'method');
  }
  const paidOn = body.paid_on || today(ctx);
  if (!realDate(paidOn)) throw fieldError('Choose the date the payment arrived, like 2026-10-15.', 'paid_on');
  if (paidOn > today(ctx)) throw fieldError('The payment date can\'t be in the future.', 'paid_on');
  if (paidOn < '2000-01-01') throw fieldError('Choose the date the payment arrived, like 2026-10-15.', 'paid_on');
  return { method, paidOn, reference: v.str(body.reference, 'reference', { max: 120, optional: true }) };
}
// Marks one open invoice paid. The status check and the update are one statement, so two payments for the same
// invoice (a check recorded while the school pays online) can never both land.
function markPaid(ctx, i, { method, paidOn, reference }) {
  const r = ctx.db.run(`UPDATE team_invoices SET status = 'paid', paid_on = ?, paid_method = ?, paid_reference = ? WHERE id = ? AND status = 'open'`, paidOn, method, reference, i.id);
  if (!r.changes) throw conflict(`Invoice ${i.number} is already paid or voided.`);
  emit(ctx, 'team_invoice.paid', { invoice_id: i.id, number: i.number, org_name: i.org_name, team_name: i.team_name, amount_cents: i.amount_cents, method });
}

export async function recordPayment(ctx, id, body, baseUrl, { online = false } = {}) {
  const i = getInvoice(ctx, id, baseUrl);
  if (i.status === 'paid') throw conflict(`Invoice ${i.number} is already paid.`);
  if (i.status === 'void') throw conflict(`Invoice ${i.number} was voided.`);
  const pay = paymentInput(ctx, body, { online });
  markPaid(ctx, i, pay);
  if (i.contact_email) sendEmail(ctx, { to: i.contact_email, subject: `Payment received: invoice ${i.number}`, text: `Thank you. We received ${money(i.amount_cents)} for invoice ${i.number} (${i.team_name}).\n\nReceipt: ${i.link}\n\n${getSetting(ctx, 'business_name')}` }).catch(() => {});
  return getInvoice(ctx, id, baseUrl);
}

// One payment (a single check) that covers several open invoices on one contract. All or nothing: if any invoice
// isn't open any more, none is marked paid. The school gets one receipt listing each invoice.
export async function recordContractPayment(ctx, contractId, body, baseUrl) {
  const c = getContract(ctx, contractId, baseUrl);
  const raw = Array.isArray(body.invoice_ids) ? body.invoice_ids : [];
  const ids = [...new Set(raw.filter((x) => typeof x === 'string' && x))];
  if (!ids.length) throw fieldError('Choose the invoices this payment covers.', 'invoice_ids');
  if (ids.length > 100) throw fieldError('Choose up to 100 invoices at a time.', 'invoice_ids');
  const pay = paymentInput(ctx, body);
  if (body.total_cents !== undefined) v.int(body.total_cents, 'total_cents', { min: 1, max: MAX_FEE * 100 });
  const paid = ctx.db.tx(() => {
    const invs = ids.map((id) => {
      const row = ctx.db.get('SELECT id FROM team_invoices WHERE id = ? AND contract_id = ?', id, contractId);
      if (!row) throw conflict('Those invoices aren\'t all on this contract. Refresh the page and try again.');
      const i = getInvoice(ctx, id, baseUrl);
      if (!['open', 'overdue'].includes(i.status)) throw conflict(`${i.number} is ${i.status === 'paid' ? 'already paid' : 'void'}. Leave it out and try again.`);
      return i;
    });
    const total = invs.reduce((t, i) => t + i.amount_cents, 0);
    // The dashboard sends the total it showed; if an amount changed in between, nothing is recorded.
    if (body.total_cents !== undefined && Number(body.total_cents) !== total) throw conflict(`Those invoices now add up to ${money(total)}, not ${money(Number(body.total_cents))}. Check the amounts and try again.`);
    for (const i of invs) markPaid(ctx, i, pay);
    return { invs, total };
  });
  if (c.org.contact_email) {
    const list = paid.invs.map((i) => `${i.number}  ${money(i.amount_cents)}\n${i.link}`).join('\n\n');
    sendEmail(ctx, { to: c.org.contact_email, subject: `Payment received: ${money(paid.total)} for ${plural(paid.invs.length, 'invoice')}`,
      text: `${hello(c.org.contact_name)}\n\nThank you. We received ${money(paid.total)} by ${METHOD_WORD[pay.method]}${pay.reference ? ` (${pay.reference})` : ''} for ${c.name}. It paid these invoices:\n\n${list}\n\n${getSetting(ctx, 'business_name')}` }).catch(() => {});
  }
  return { count: paid.invs.length, total_cents: paid.total, method: pay.method, paid_on: pay.paidOn, reference: pay.reference, invoices: paid.invs.map((i) => getInvoice(ctx, i.id, baseUrl)) };
}

// A statement of everything the school owes on one contract: each open invoice with its link, and the total.
export async function emailStatement(ctx, contractId, baseUrl) {
  const c = getContract(ctx, contractId, baseUrl);
  if (!c.org.contact_email) throw conflict(`Add a billing email for ${c.org.name} to send a statement.`);
  const open = c.invoices.filter((i) => ['open', 'overdue'].includes(i.status)).sort((a, b) => a.due_on.localeCompare(b.due_on) || a.number.localeCompare(b.number));
  if (!open.length) throw conflict('Nothing is unpaid on this contract, so there is no statement to send.');
  const total = open.reduce((t, i) => t + i.amount_cents, 0);
  const biz = getSetting(ctx, 'business_name');
  const lines = open.map((i) => `${i.number}  ${money(i.amount_cents)}  ${i.days_past_due ? `was due ${longDate(i.due_on)} (${plural(i.days_past_due, 'day')} past due)` : `due ${longDate(i.due_on)}`}\n${i.lines[0]?.description ?? ''}\n${i.link}`).join('\n\n');
  await sendEmail(ctx, { to: c.org.contact_email, subject: `Statement from ${biz}: ${money(total)} open for ${c.name}`,
    text: `${hello(c.org.contact_name)}\n\nHere is where the ${c.name} account stands. ${open.length === 1 ? 'One invoice is' : `${open.length} invoices are`} open, ${money(total)} in all.${c.po_number ? ` PO: ${c.po_number}.` : ''}\n\n${lines}\n\nEach link lets you view, print or pay that invoice online. One check for the total is fine: list the invoice numbers on the memo.${payText(ctx)}\n\nQuestions? Reply to this email.\n\nThank you,\n${biz}` });
  return { to: c.org.contact_email, count: open.length, total_cents: total };
}

// "Email overdue reminders now": every overdue invoice with a billing email, without waiting for the weekly one.
// The weekly reminder then waits another week.
export async function remindOverdueNow(ctx, baseUrl) {
  const list = ctx.db.all(`SELECT i.id, i.number, i.amount_cents, i.reminded_at, o.name AS org_name, o.contact_email FROM team_invoices i JOIN organizations o ON o.id = i.org_id
    WHERE i.status = 'open' AND i.due_on < ? ORDER BY i.due_on, i.number`, today(ctx));
  if (!list.length) throw conflict('Nothing is overdue, so there is nobody to remind.');
  let sent = 0, skipped = 0;
  for (const i of list) {
    if (!i.reminded_at) emit(ctx, 'team_invoice.overdue', { invoice_id: i.id, number: i.number, org_name: i.org_name, amount_cents: i.amount_cents });
    if (i.contact_email) { await sendInvoice(ctx, i.id, baseUrl, { reminder: true }); sent++; } else skipped++;
  }
  return { sent, skipped, schools_without_email: [...new Set(list.filter((i) => !i.contact_email).map((i) => i.org_name))] };
}

export function voidInvoice(ctx, id, baseUrl) {
  const i = getInvoice(ctx, id, baseUrl);
  if (i.status === 'paid') throw conflict('Paid invoices can\'t be voided. Refund the payment outside the app, then void.');
  if (i.status === 'void') throw conflict(`Invoice ${i.number} is already void.`);
  const r = ctx.db.run(`UPDATE team_invoices SET status = 'void' WHERE id = ? AND status = 'open'`, id);
  if (!r.changes) throw conflict(`Invoice ${i.number} was just paid, so it can't be voided.`);
  emit(ctx, 'team_invoice.voided', { invoice_id: id, number: i.number, org_name: i.org_name, amount_cents: i.amount_cents });
  return getInvoice(ctx, id, baseUrl);
}

// ---------- The billing clock (runs hourly with memberships) ----------
// next_period_start is the next month to invoice. It only moves forward: a restart or a "don't invoice past months"
// choice moves it past months that shouldn't be billed. A month already invoiced is never invoiced again.
export async function runTeamBilling(ctx, { baseUrl, contractId } = {}) {
  const day = today(ctx);
  const out = { invoiced: 0, reminded: 0, ended: 0 };
  const contracts = ctx.db.all(`SELECT t.*, o.name AS org_name FROM team_contracts t JOIN organizations o ON o.id = t.org_id WHERE t.status = 'active'${contractId ? ' AND t.id = ?' : ''}`, ...(contractId ? [contractId] : []));
  for (const c of contracts) {
    let k = 0;
    while (periodStart(c.start_date, k) < c.next_period_start && k < 2400) k++;
    let start = periodStart(c.start_date, k);
    while (start <= day && (!c.end_date || start <= c.end_date)) {
      if (!ctx.db.get('SELECT 1 FROM team_invoices WHERE contract_id = ? AND period_start = ?', c.id, start)) {
        const end = addDaysToDate(periodStart(c.start_date, k + 1), -1);
        const periodEnd = c.end_date && c.end_date < end ? c.end_date : end;
        const inv = insertInvoice(ctx, c, { lines: [{ description: `${c.name} training, ${longDate(start)} – ${longDate(periodEnd)}`, amount_cents: c.monthly_cents }], periodStart: start, periodEnd });
        out.invoiced++;
        if (ctx.db.get('SELECT contact_email FROM organizations WHERE id = ?', c.org_id).contact_email) await sendInvoice(ctx, inv.id, baseUrl);
      }
      k++; start = periodStart(c.start_date, k);
    }
    ctx.db.run('UPDATE team_contracts SET next_period_start = ? WHERE id = ? AND next_period_start < ?', start, c.id, start);
    if (c.end_date && c.end_date < day) { ctx.db.run(`UPDATE team_contracts SET status = 'ended' WHERE id = ?`, c.id); out.ended++; }
  }
  // Past-due reminders: the day after the due date, then weekly.
  if (!contractId) {
    const weekAgo = new Date(Date.parse(ctx.now()) - 7 * 86400000).toISOString();
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
// Only what the school needs: never staff notes, roster or other invoices.
export function publicInvoice(ctx, tok) {
  const row = ctx.db.get('SELECT id FROM team_invoices WHERE public_token = ?', String(tok ?? ''));
  if (!row) throw notFound('Invoice');
  const i = getInvoice(ctx, row.id);
  return {
    number: i.number, status: i.status, lines: i.lines, amount_cents: i.amount_cents, issued_on: i.issued_on, due_on: i.due_on, days_past_due: i.days_past_due, period_start: i.period_start, period_end: i.period_end,
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
  await recordPayment(ctx, row.id, { reference: 'test payment' }, undefined, { online: true });
  return publicInvoice(ctx, tok);
}
// Stripe can deliver the same webhook more than once: flag each extra online payment only once, so it isn't refunded twice.
const toldTwice = (ctx, invoiceId, ref) => !!ctx.db.get(`SELECT 1 FROM events WHERE type = 'team_invoice.paid_twice' AND json_extract(data, '$.invoice_id') = ? AND json_extract(data, '$.online_reference') = ?`, invoiceId, ref);
// Stripe webhook: Checkout finished (cards are paid now; bank payments settle a few days later).
export async function handleInvoiceCheckout(ctx, type, obj) {
  const id = obj.metadata?.team_invoice_id;
  if (!id || !ctx.db.get('SELECT id FROM team_invoices WHERE id = ?', id)) return false;
  const inv = ctx.db.get('SELECT number, status, paid_method, paid_reference, amount_cents FROM team_invoices WHERE id = ?', id);
  const succeeded = (type === 'checkout.session.completed' && obj.payment_status === 'paid') || type === 'checkout.session.async_payment_succeeded';
  if (inv.status !== 'open') {
    // Paid by check (or voided) before the online payment went through: the school paid twice. Tell the owner.
    const ref = obj.payment_intent ?? obj.id;
    if (succeeded && ref !== inv.paid_reference && !toldTwice(ctx, id, ref)) emit(ctx, 'team_invoice.paid_twice', { invoice_id: id, number: inv.number, amount_cents: inv.amount_cents, status: inv.status, paid_method: inv.paid_method, online_reference: ref });
    return true;
  }
  if (succeeded) {
    try { await recordPayment(ctx, id, { reference: obj.payment_intent ?? obj.id }, undefined, { online: true }); }
    catch (e) {
      if (e.status !== 409) throw e;   // recorded by hand a moment ago: still two payments
      if (!toldTwice(ctx, id, obj.payment_intent ?? obj.id)) emit(ctx, 'team_invoice.paid_twice', { invoice_id: id, number: inv.number, amount_cents: inv.amount_cents, online_reference: obj.payment_intent ?? obj.id });
    }
  } else if (type === 'checkout.session.async_payment_failed') {
    emit(ctx, 'team_invoice.payment_failed', { invoice_id: id });
  }
  return true;
}

export function teamSummary(ctx) {
  const d = today(ctx);
  const monthly = ctx.db.get(`SELECT COALESCE(SUM(monthly_cents), 0) AS c, COUNT(*) AS n FROM team_contracts WHERE status = 'active'`);
  const overdue = ctx.db.all(`SELECT i.id AS invoice_id, i.number, i.amount_cents, i.due_on, t.id AS contract_id, t.name AS team_name, o.name AS name FROM team_invoices i JOIN team_contracts t ON t.id = i.contract_id JOIN organizations o ON o.id = i.org_id WHERE i.status = 'open' AND i.due_on < ? ORDER BY i.due_on`, d);
  const open = ctx.db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c, COUNT(*) AS n FROM team_invoices WHERE status = 'open'`);
  const collected = ctx.db.get(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM team_invoices WHERE status = 'paid' AND paid_on > ?`, addDaysToDate(d, -30)).c;
  const athletes = ctx.db.get(`SELECT COUNT(DISTINCT r.client_id) AS n FROM team_roster r JOIN team_contracts t ON t.id = r.contract_id JOIN clients c ON c.id = r.client_id WHERE r.active = 1 AND t.status = 'active' AND c.archived_at IS NULL`).n;
  return { monthly_cents: monthly.c, active_contracts: monthly.n, open_cents: open.c, open_count: open.n, collected_30_cents: collected, athletes, overdue: overdue.map((i) => ({ ...i, days_past_due: daysBetween(i.due_on, d) })) };
}
