import { newId, v, notFound, conflict, badRequest, localDate, zonedToUtc } from '../util.js';
import { getSetting } from './families.js';
import { sendEmail } from './mail.js';
import { emailOptedOut } from './leads.js';
import { emit } from './events.js';

// Monthly progress reports for parents (version 59): once a month is over, a report is written for each athlete from
// what they logged (workouts done against the program's pace, sets, time, effort, sessions attended, check-ins, the
// estimated one-rep max trend per lift, steps approved, form checks answered). Coaches add a line and send it, or the
// owner lets them go on their own on the 1st. Parents read them in the portal's Progress tab and in their email.
// Nothing about money is in a report.

export const MODES = { review: 'Coaches review each report, then send it', auto: 'Send on its own in the first week of the month', off: 'Off' };
const tz = (ctx) => getSetting(ctx, 'timezone');
const first = (name) => String(name ?? '').split(' ')[0];
export const monthOf = (ctx, iso = ctx.now()) => localDate(iso, tz(ctx)).slice(0, 7);
export function prevMonth(m) { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; }
export function nextMonth(m) { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; }
export function monthRange(ctx, m) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m ?? ''))) throw badRequest('month must look like 2026-08.');
  return { from: zonedToUtc(`${m}-01`, '00:00', tz(ctx)), to: zonedToUtc(`${nextMonth(m)}-01`, '00:00', tz(ctx)) };
}
export const monthLabel = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const stepText = (s) => (s.kind === 'weight' ? `+${s.amount} lb` : s.kind === 'reps' ? `+${s.amount} rep${s.amount === 1 ? '' : 's'} a set` : `+${s.amount} set${s.amount === 1 ? '' : 's'}`);

// The month's facts for one athlete. Strength is the best estimated one-rep max per lift (Epley: weight × (1 + reps/30),
// sets of 1 to 12 reps with a weight) against the best before the month.
export function facts(ctx, clientId, month) {
  const { from, to } = monthRange(ctx, month);
  const prev = monthRange(ctx, prevMonth(month));
  const logs = ctx.db.all(`SELECT l.id, l.completed_at, l.started_at, l.rpe, l.session_id FROM workout_logs l WHERE l.client_id = ? AND l.completed_at >= ? AND l.completed_at < ? ORDER BY l.completed_at`, clientId, from, to);
  const sets = ctx.db.get(`SELECT COUNT(*) AS n FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id WHERE l.client_id = ? AND l.completed_at >= ? AND l.completed_at < ?`, clientId, from, to).n;
  const minutes = logs.reduce((t, l) => t + (l.started_at ? Math.min(240, Math.max(0, Math.round((Date.parse(l.completed_at) - Date.parse(l.started_at)) / 60000))) : 0), 0);
  const efforts = logs.map((l) => l.rpe).filter((x) => x != null);
  // The program's pace (its workouts over its weeks) across the weeks of the month, while on a program.
  const a = ctx.db.get(`SELECT p.name, p.weeks, (SELECT COUNT(*) FROM workouts w WHERE w.program_id = p.id) AS n FROM assignments a JOIN programs p ON p.id = a.program_id WHERE a.client_id = ? AND a.active = 1`, clientId);
  const weeksIn = (Date.parse(to) - Date.parse(from)) / (7 * 86400000);
  const expected = a && a.weeks && a.n ? Math.max(1, Math.round((a.n / a.weeks) * weeksIn)) : null;
  const workoutsPrev = ctx.db.get('SELECT COUNT(*) AS n FROM workout_logs WHERE client_id = ? AND completed_at >= ? AND completed_at < ?', clientId, prev.from, prev.to).n;
  const attended = ctx.db.get(`SELECT (SELECT COUNT(*) FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.status = 'attended' AND s.starts_at >= ? AND s.starts_at < ?)
    + (SELECT COUNT(*) FROM team_attendance t JOIN class_sessions s ON s.id = t.session_id WHERE t.client_id = ? AND s.starts_at >= ? AND s.starts_at < ?) AS n`, clientId, from, to, clientId, from, to).n;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const checkins = ctx.db.get('SELECT COUNT(*) AS n FROM daily_checkins WHERE client_id = ? AND date >= ? AND date < ?', clientId, `${month}-01`, `${nextMonth(month)}-01`).n;
  const best = (f, t) => ctx.db.all(`SELECT s.exercise_id, s.exercise_name AS name, MAX(s.weight * (1 + CASE WHEN s.reps <= 1 THEN 0 ELSE s.reps / 30.0 END)) AS e1rm, MAX(s.weight) AS top
    FROM workout_sets s JOIN workout_logs l ON l.id = s.workout_log_id WHERE l.client_id = ? AND l.completed_at >= ? AND l.completed_at < ? AND s.weight > 0 AND s.reps IS NOT NULL AND s.reps BETWEEN 1 AND 12 AND s.exercise_id IS NOT NULL GROUP BY s.exercise_id`, clientId, f, t);
  const before = new Map(best('0000', from).map((b) => [b.exercise_id, b]));
  const strength = best(from, to).map((b) => { const p = before.get(b.exercise_id); return { exercise_id: b.exercise_id, name: b.name, e1rm: Math.round(b.e1rm), top: b.top, before: p ? Math.round(p.e1rm) : null, change: p ? Math.round(b.e1rm - p.e1rm) : null }; })
    .sort((x, y) => (y.change ?? -1e9) - (x.change ?? -1e9)).slice(0, 6);
  const steps = ctx.db.all(`SELECT e.name, p.kind, p.amount FROM progressions p JOIN exercises e ON e.id = p.exercise_id WHERE p.client_id = ? AND p.status = 'approved' AND p.decided_at >= ? AND p.decided_at < ? ORDER BY p.decided_at`, clientId, from, to);
  const formChecks = ctx.db.get(`SELECT COUNT(*) AS n FROM form_checks WHERE client_id = ? AND status = 'answered' AND sent_at >= ? AND sent_at < ?`, clientId, from, to).n;
  return { month, label: monthLabel(month), days, workouts: logs.length, expected, workouts_prev: workoutsPrev, on_screen: logs.filter((l) => l.session_id).length, sets, minutes,
    effort_avg: efforts.length ? Math.round((efforts.reduce((t, x) => t + x, 0) / efforts.length) * 10) / 10 : null, program: a?.name ?? null, attended, checkins,
    strength, steps: steps.map((s) => ({ name: s.name, text: stepText(s) })), form_checks: formChecks, quiet: !logs.length && !attended && !checkins };
}

const shape = (r) => ({ ...r, data: JSON.parse(r.data), sent_to: r.sent_to ? JSON.parse(r.sent_to) : [], label: monthLabel(r.month) });
const row = (ctx, id) => ctx.db.get(`SELECT r.*, c.name AS client_name, c.family_id FROM monthly_reports r JOIN clients c ON c.id = r.client_id WHERE r.id = ?`, String(id));
export function get(ctx, id) {
  const r = row(ctx, id);
  if (!r) throw notFound('Report');
  return shape(r);
}
export function list(ctx, { month, status } = {}) {
  const where = ['c.archived_at IS NULL'], p = [];
  if (month) { monthRange(ctx, month); where.push('r.month = ?'); p.push(month); }
  if (status) { where.push('r.status = ?'); p.push(v.oneOf(status, 'status', ['draft', 'sent', 'skipped'])); }
  return ctx.db.all(`SELECT r.*, c.name AS client_name, c.family_id FROM monthly_reports r JOIN clients c ON c.id = r.client_id WHERE ${where.join(' AND ')} ORDER BY r.month DESC, c.name COLLATE NOCASE`, ...p).map(shape);
}
// The months that have reports, newest first, for the picker.
export const months = (ctx) => ctx.db.all('SELECT month, COUNT(*) AS n, SUM(status = \'draft\') AS drafts, SUM(status = \'sent\') AS sent FROM monthly_reports GROUP BY month ORDER BY month DESC').map((m) => ({ ...m, label: monthLabel(m.month) }));

// Write the month's reports: every athlete with a family who isn't archived and either holds a membership or did
// something that month. A member with nothing that month gets a 'skipped' row (the coach sees the quiet month); an
// athlete who already has a row for the month is left alone, so running it twice changes nothing.
export function generateMonth(ctx, month, { asOf = ctx.now() } = {}) {
  monthRange(ctx, month);
  if (month >= monthOf(ctx, asOf)) throw badRequest(`${monthLabel(month)} isn't over yet. Reports are written once the month ends.`);
  const people = ctx.db.all(`SELECT c.id, c.name, EXISTS (SELECT 1 FROM subscriptions s WHERE s.client_id = c.id AND s.status IN ('active','trialing','past_due')) AS member
    FROM clients c WHERE c.archived_at IS NULL AND c.family_id IS NOT NULL ORDER BY c.name`);
  let drafts = 0, skipped = 0, kept = 0;
  const now = ctx.now();
  ctx.db.tx(() => {
    for (const c of people) {
      if (ctx.db.get('SELECT id FROM monthly_reports WHERE client_id = ? AND month = ?', c.id, month)) { kept++; continue; }
      const f = facts(ctx, c.id, month);
      if (f.quiet && !c.member) continue;
      ctx.db.run('INSERT INTO monthly_reports (id, client_id, month, data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('mrep'), c.id, month, JSON.stringify(f), f.quiet ? 'skipped' : 'draft', now, now);
      if (f.quiet) skipped++; else drafts++;
    }
  });
  return { month, label: monthLabel(month), drafts, skipped, already: kept };
}
export function updateNote(ctx, id, body = {}, user) {
  const r = get(ctx, id);
  if (r.status === 'sent') throw conflict('This report was already sent.');
  const note = v.str(body.coach_note, 'coach_note', { max: 1500, optional: true }) || null;
  ctx.db.run('UPDATE monthly_reports SET coach_note = ?, note_by = ?, updated_at = ? WHERE id = ?', note, note ? user?.name ?? null : null, ctx.now(), r.id);
  return get(ctx, id);
}
export function skip(ctx, id) {
  const r = get(ctx, id);
  if (r.status === 'sent') throw conflict('This report was already sent.');
  ctx.db.run(`UPDATE monthly_reports SET status = 'skipped', updated_at = ? WHERE id = ?`, ctx.now(), r.id);
  return get(ctx, id);
}
export function unskip(ctx, id) {
  const r = get(ctx, id);
  if (r.status !== 'skipped') throw conflict('Only a skipped report can be brought back.');
  ctx.db.run(`UPDATE monthly_reports SET status = 'draft', updated_at = ? WHERE id = ?`, ctx.now(), r.id);
  return get(ctx, id);
}

// The email's body (also what the portal shows): plain lines, no money.
export function reportLines(ctx, r) {
  const d = r.data, name = first(r.client_name);
  const lines = [];
  const vs = d.workouts_prev != null && d.workouts !== d.workouts_prev ? ` (${d.workouts > d.workouts_prev ? `${d.workouts - d.workouts_prev} more` : `${d.workouts_prev - d.workouts} fewer`} than the month before)` : '';
  lines.push(`Workouts logged: ${d.workouts}${d.expected ? ` of about ${d.expected} on the program's pace` : ''}${vs}.${d.program ? ` Program: ${d.program}.` : ''}`);
  if (d.workouts) lines.push(`Sets: ${d.sets}${d.minutes ? ` · time training: ${Math.floor(d.minutes / 60) ? `${Math.floor(d.minutes / 60)} h ` : ''}${d.minutes % 60} min` : ''}${d.effort_avg ? ` · effort ${d.effort_avg} of 10 on average` : ''}.`);
  lines.push(`Sessions attended: ${d.attended}. Daily check-ins: ${d.checkins} of ${d.days} days.`);
  if (d.strength.length) lines.push('Strength (estimated one-rep max from logged sets):', ...d.strength.map((s) => `- ${s.name}: ${s.e1rm} lb${s.change != null ? ` (${s.change > 0 ? `up ${s.change}` : s.change < 0 ? `down ${-s.change}` : 'no change'}${s.change ? ' lb' : ''})` : ' (first month on record)'}`));
  if (d.steps.length) lines.push(`Steps up approved by the coach: ${d.steps.map((s) => `${s.text} on ${s.name}`).join(', ')}.`);
  if (d.form_checks) lines.push(`Form checks answered by the coach: ${d.form_checks}.`);
  if (r.coach_note) lines.push('', `From ${r.note_by ? `Coach ${first(r.note_by)}` : 'the coach'}: ${r.coach_note}`);
  return lines.map((l) => l.replace(/\bthe athlete\b/g, name));
}
export function reportText(ctx, r) {
  const biz = getSetting(ctx, 'business_name');
  return [`${first(r.client_name)}'s ${r.label} at ${biz}`, '', ...reportLines(ctx, r), '', `See the full picture in the parent portal: ${ctx.publicUrl ?? ''}/parent?tab=progress`, '', biz].join('\n');
}
// Email the report to the athlete's parents (every parent with an email who hasn't opted out), then mark it sent.
export async function send(ctx, id, user) {
  const r = get(ctx, id);
  if (r.status === 'sent') throw conflict('This report was already sent.');
  const parents = ctx.db.all('SELECT name, email FROM guardians WHERE family_id = ? AND email IS NOT NULL AND email != \'\' ORDER BY is_primary DESC', r.family_id).filter((g) => !emailOptedOut(ctx, g.email));
  if (!parents.length) throw conflict(`${first(r.client_name)}'s family has no parent email to send to (or they unsubscribed).`);
  const text = reportText(ctx, r);
  for (const g of parents) await sendEmail(ctx, { to: g.email, subject: `${first(r.client_name)}'s ${r.label} at ${getSetting(ctx, 'business_name')}`, text: `Hi ${first(g.name)},\n\n${text}` });
  ctx.db.run(`UPDATE monthly_reports SET status = 'sent', sent_at = ?, sent_to = ?, sent_by = ?, updated_at = ? WHERE id = ?`, ctx.now(), JSON.stringify(parents.map((g) => g.email)), user?.name ?? 'automatic', ctx.now(), r.id);
  emit(ctx, 'monthly_report.sent', { report_id: r.id, client_id: r.client_id, client_name: r.client_name, month: r.month, parents: parents.length, by: user?.name ?? 'automatic' });
  return get(ctx, id);
}
// Send every draft of a month. A report with no parent email stays a draft and is named in the answer.
export async function sendAll(ctx, month, user) {
  const drafts = list(ctx, { month, status: 'draft' });
  const out = { month, sent: 0, no_email: [] };
  for (const r of drafts) {
    try { await send(ctx, r.id, user); out.sent++; } catch (e) { if (e.status === 409) out.no_email.push(r.client_name); else throw e; }
  }
  return out;
}
// What a family sees in the portal: the athlete's sent reports, newest first, as lines.
export function forFamily(ctx, clientId) {
  return ctx.db.all(`SELECT r.*, c.name AS client_name, c.family_id FROM monthly_reports r JOIN clients c ON c.id = r.client_id WHERE r.client_id = ? AND r.status = 'sent' ORDER BY r.month DESC`, clientId)
    .map(shape).map((r) => ({ id: r.id, month: r.month, label: r.label, sent_at: r.sent_at, coach_note: r.coach_note, note_by: r.note_by, lines: reportLines(ctx, r), data: r.data }));
}
export const forExport = (ctx, clientId) => ctx.db.all('SELECT month, status, coach_note, note_by, sent_at, sent_to, data FROM monthly_reports WHERE client_id = ? ORDER BY month', clientId).map((r) => ({ ...r, data: JSON.parse(r.data), sent_to: r.sent_to ? JSON.parse(r.sent_to) : [] }));

// Runs hourly: in the first week of a month, from 7 am business time, writes last month's reports once; in auto mode
// it sends them too. Off does nothing.
export async function runMonthly(ctx, asOf = ctx.now()) {
  const mode = getSetting(ctx, 'monthly_reports');
  if (mode === 'off') return null;
  const zone = tz(ctx);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(asOf)).map((p) => [p.type, p.value]));
  if (Number(parts.day) > 7 || Number(parts.hour) < 7) return null;
  const target = prevMonth(monthOf(ctx, asOf));
  if (getSetting(ctx, 'monthly_generated') === target) return null;
  ctx.db.run(`INSERT INTO settings (key, value) VALUES ('monthly_generated', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, target);
  const r = generateMonth(ctx, target, { asOf });
  if (mode === 'auto') r.sent = (await sendAll(ctx, target)).sent;
  return r;
}
