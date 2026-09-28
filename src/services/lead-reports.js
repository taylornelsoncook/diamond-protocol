import { newId, badRequest, HttpError, isDate, zonedToUtc, addDaysToDate } from '../util.js';
import { getSetting } from './families.js';
import { normalizePhone } from './sms.js';
import { emit } from './events.js';
import { csvCell } from './security.js';
import { readUpload } from './uploads.js';
import { STAGE_LABELS, SOURCE_LABELS, LOST_REASONS, OPEN_STAGES, STAGES, findDuplicates, shapeLead, todayDate, daysBetween, dayOf } from './leads.js';

// The owner's CRM tools (version 45): lead reports by period, a formula-safe CSV export, and a CSV (or Excel) import that
// works like every other upload here: the whole file is checked, every problem is listed by row and column, nothing is
// saved until it's clean, and it's checked again and saved in one transaction. Leads that might be someone we already
// have (same phone as a lead, a family or a client, or an email a family already signs in with) need confirm: true.
// Imported leads get no automatic emails and no texts: nobody on a list said yes to them.

// ---------- Reports ----------
const zone = (ctx) => getSetting(ctx, 'timezone');
function period(ctx, q) {
  const today = todayDate(ctx);
  const to = q.to ? String(q.to) : today;
  if (!isDate(to)) throw badRequest('from and to must be dates like 2026-09-01.');
  const from = q.from ? String(q.from) : addDaysToDate(to, -89);
  if (!isDate(from)) throw badRequest('from and to must be dates like 2026-09-01.');
  if (from > to) throw badRequest('The start date is after the end date. Swap them.');
  if (daysBetween(from, to) > 3660) throw badRequest('Pick a period of ten years or less.');
  return { from, to, start: zonedToUtc(from, '00:00', zone(ctx)), end: zonedToUtc(addDaysToDate(to, 1), '00:00', zone(ctx)) };
}
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function leadReport(ctx, q = {}) {
  const p = period(ctx, q);
  const leads = ctx.db.all('SELECT * FROM leads WHERE created_at >= ? AND created_at < ?', p.start, p.end);
  const reached = new Map(ctx.db.all(`SELECT h.lead_id, h.to_stage, MIN(h.at) AS at FROM lead_stage_history h JOIN leads l ON l.id = h.lead_id WHERE l.created_at >= ? AND l.created_at < ?
      GROUP BY h.lead_id, h.to_stage`, p.start, p.end).map((r) => [`${r.lead_id}|${r.to_stage}`, r.at]));
  const became = (l, stage) => l.status === stage || reached.has(`${l.id}|${stage}`);
  const signedUp = (l) => ['signed_up', 'evaluation', 'trial', 'member'].some((s) => became(l, s)) || !!l.converted_at;
  const bySource = new Map();
  for (const l of leads) {
    const s = bySource.get(l.source) ?? { source: l.source, label: SOURCE_LABELS[l.source] ?? l.source, leads: 0, signed_up: 0, members: 0, lost: 0 };
    s.leads++; if (signedUp(l)) s.signed_up++; if (became(l, 'member')) s.members++; if (l.status === 'lost') s.lost++;
    bySource.set(l.source, s);
  }
  const days = leads.filter((l) => became(l, 'member')).map((l) => {
    const at = reached.get(`${l.id}|member`) ?? l.stage_changed_at ?? l.updated_at;
    return Math.max(0, daysBetween(dayOf(ctx, l.created_at), dayOf(ctx, at)));
  });
  const lost = {};
  for (const l of leads.filter((x) => x.status === 'lost')) lost[l.lost_reason ?? 'other'] = (lost[l.lost_reason ?? 'other'] ?? 0) + 1;
  const stageCounts = Object.fromEntries(STAGES.map((s) => [s, leads.filter((l) => l.status === s).length]));
  const members = days.length, total = leads.length;
  const today = todayDate(ctx);
  const open = ctx.db.all(`SELECT * FROM leads WHERE status IN (${OPEN_STAGES.map(() => '?').join(',')})`, ...OPEN_STAGES).map((l) => shapeLead(ctx, l, today));
  return {
    from: p.from, to: p.to, leads: total,
    signed_up: leads.filter(signedUp).length, members, lost: stageCounts.lost,
    conversion_pct: pct(members, total), signed_up_pct: pct(leads.filter(signedUp).length, total),
    days_to_member: { median: median(days), average: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null, count: days.length },
    by_source: [...bySource.values()].map((s) => ({ ...s, conversion_pct: pct(s.members, s.leads), signed_up_pct: pct(s.signed_up, s.leads) })).sort((a, b) => b.leads - a.leads),
    lost_reasons: Object.entries(lost).map(([reason, count]) => ({ reason, label: LOST_REASONS[reason] ?? reason, count })).sort((a, b) => b.count - a.count),
    stage_counts: STAGES.map((s) => ({ stage: s, label: STAGE_LABELS[s], count: stageCounts[s] })),
    open_now: { total: open.length, stale: open.filter((l) => l.stale).length, by_stage: OPEN_STAGES.map((s) => ({ stage: s, label: STAGE_LABELS[s], count: open.filter((l) => l.status === s).length })) }
  };
}

// ---------- Export ----------
const pretty = (p) => (/^\+1\d{10}$/.test(p ?? '') ? `(${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}` : p);
export function exportLeads(ctx, q = {}) {
  const where = [], args = [];
  if (q.status) { if (!STAGES.includes(q.status)) throw badRequest(`status must be one of: ${STAGES.join(', ')}.`); where.push('l.status = ?'); args.push(q.status); }
  const rows = ctx.db.all(`SELECT l.*, u.name AS coach_name FROM leads l LEFT JOIN users u ON u.id = l.coach_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.created_at DESC LIMIT 20000`, ...args);
  const today = todayDate(ctx);
  const head = ['Parent name', 'Email', 'Phone', 'Athlete name', 'Athlete age', 'Sport', 'How they found you', 'Stage', 'Days in stage', 'Stale', 'Why lost', 'Coach', 'OK to text', 'Asked on', 'Last contacted', 'Notes', 'Message'];
  const lines = [head.map(csvCell).join(',')].concat(rows.map((r) => {
    const l = shapeLead(ctx, r, today);
    return [l.parent_name, l.email, pretty(l.phone), l.athlete_name, l.athlete_age, l.sport, l.source_label, l.stage_label, l.days_in_stage, l.stale ? 'Yes' : '', l.lost_reason_label ? `${l.lost_reason_label}${l.lost_note ? `: ${l.lost_note}` : ''}` : '',
      l.coach_name, l.texts_ok ? 'Yes' : '', dayOf(ctx, l.created_at), l.last_contacted_at ? dayOf(ctx, l.last_contacted_at) : '', l.notes, l.message].map(csvCell).join(',');
  }));
  return { filename: `leads-${today}.csv`, type: 'text/csv; charset=utf-8', body: `﻿${lines.join('\r\n')}\r\n`, count: rows.length };
}

// ---------- Import ----------
const COLUMNS = [
  ['parent_name', 'Parent name', /^(parent|guardian|parent name|guardian name|name|full name|contact|contact name)$/],
  ['email', 'Email', /^(parent |guardian )?e-?mail( address)?$/], ['phone', 'Phone', /^(parent |guardian )?(phone|mobile|cell)( number)?$/],
  ['athlete_name', 'Athlete name', /^(athlete|athlete name|child|child name|player|player name)$/], ['athlete_age', 'Athlete age', /^(athlete )?age$/],
  ['sport', 'Sport', /^sport$/], ['source', 'How they found you', /^(how they found you|source|lead source|found us|how did you hear about us)$/],
  ['stage', 'Stage', /^(stage|status)$/], ['notes', 'Notes', /^(notes?|comments?)$/]
];
const norm = (h) => String(h).trim().toLowerCase().replace(/[()?]/g, '').replace(/\s+/g, ' ');
const MAX_ROWS = 2000;
// A cell that a spreadsheet would run as a formula is refused (and the export escapes any that got in some other way).
const formula = (x) => /^[=@\t\r]/.test(x) || /^[+-](?![\d\s().-]*$)/.test(x);
const sourceOf = (x) => {
  const t = String(x ?? '').trim().toLowerCase();
  if (!t) return 'import';
  const hit = Object.entries(SOURCE_LABELS).find(([k, label]) => k === t.replace(/[\s-]+/g, '_') || label.toLowerCase() === t);
  return hit && !['inquiry', 'signup_unfinished', 'client'].includes(hit[0]) ? hit[0] : undefined;
};
const IMPORT_STAGES = ['new', 'contacted'];
function checkFile(ctx, body) {
  const { headers, rows } = readUpload(body);
  const errors = [], warnings = [];
  const err = (row, column, message) => errors.push({ row, column, message });
  if (rows.length > MAX_ROWS) err(null, null, `The file has ${rows.length} rows. Import up to ${MAX_ROWS} at a time.`);
  const map = {};
  for (const h of headers) {
    const c = COLUMNS.find(([, , re]) => re.test(norm(h)));
    if (c && !map[c[0]]) map[c[0]] = h;
    else if (!c && rows.some((r) => String(r[h] ?? '').trim())) err(1, h, `"${h}" isn't a column the import knows. Use: ${COLUMNS.map(([, l]) => l).join(', ')}.`);
  }
  if (!map.parent_name) err(1, null, 'The file needs a "Parent name" column.');
  if (!map.email && !map.phone) err(1, null, 'The file needs an "Email" or a "Phone" column so you can follow up.');
  if (errors.some((e) => e.column === null)) return { errors, warnings, leads: [] };
  const val = (r, k) => (map[k] ? String(r[map[k]] ?? '').trim() : '');
  const leads = [], seenEmail = new Map(), seenPhone = new Map();
  rows.forEach((r, i) => {
    const row = i + 2;
    if (!Object.keys(map).some((k) => val(r, k))) return;
    for (const [k, label] of COLUMNS) if (map[k] && formula(val(r, k)) && !(k === 'phone' && normalizePhone(val(r, k)))) err(row, label, `"${val(r, k).slice(0, 30)}" starts like a spreadsheet formula. Type it as plain text.`);
    const parent = val(r, 'parent_name').replace(/\s+/g, ' ');
    if (!parent) err(row, 'Parent name', 'Add the parent\'s name.');
    else if (parent.length > 120) err(row, 'Parent name', 'Use 120 characters or fewer.');
    const email = val(r, 'email').toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err(row, 'Email', `"${email}" isn't an email address.`);
    const rawPhone = val(r, 'phone'), phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) err(row, 'Phone', `"${rawPhone}" needs its area code, like (512) 555-0100.`);
    if (!email && !rawPhone) err(row, map.email ? 'Email' : 'Phone', 'Add an email or a phone number so you can follow up.');
    const ageRaw = val(r, 'athlete_age'), age = ageRaw ? Number(ageRaw) : null;
    if (ageRaw && (!Number.isInteger(age) || age < 3 || age > 99)) err(row, 'Athlete age', `"${ageRaw}" isn't an age from 3 to 99.`);
    const source = sourceOf(val(r, 'source'));
    if (source === undefined) err(row, 'How they found you', `"${val(r, 'source')}" isn't one we know. Use one of: ${['manual', 'phone', 'walk_in', 'event', 'referral', 'social', 'camp', 'team'].map((k) => SOURCE_LABELS[k]).join(', ')}, or leave it empty.`);
    const stageText = val(r, 'stage').toLowerCase();
    const stage = !stageText ? 'new' : Object.keys(STAGE_LABELS).find((k) => k === stageText || STAGE_LABELS[k].toLowerCase() === stageText);
    if (stageText && !IMPORT_STAGES.includes(stage)) err(row, 'Stage', `Imported leads start as New or Contacted. Leave "${val(r, 'stage')}" out: stages after that come from what the family does.`);
    for (const [k, label, max] of [['athlete_name', 'Athlete name', 120], ['sport', 'Sport', 60], ['notes', 'Notes', 4000]]) if (val(r, k).length > max) err(row, label, `Use ${max} characters or fewer.`);
    if (email) { if (seenEmail.has(email)) err(row, 'Email', `${email} is also on row ${seenEmail.get(email)}. Keep one row per family.`); else seenEmail.set(email, row); }
    if (phone) { if (seenPhone.has(phone)) warnings.push({ row, column: 'Phone', message: `Same phone as row ${seenPhone.get(phone)}.` }); else seenPhone.set(phone, row); }
    if (email || phone) {
      const d = findDuplicates(ctx, { email, phone });
      const openSame = d.leads.find((l) => l.open && l.match === 'email');
      if (openSame) err(row, 'Email', `${email} is already an open lead (${openSame.parent_name}).`);
      else if (d.count) {
        const l = d.leads[0], f = d.families[0], c = d.clients[0];
        warnings.push({ row, column: (l ?? f ?? c).match === 'email' ? 'Email' : 'Phone',
          message: l ? `Same ${l.match} as the lead ${l.parent_name} (${l.stage}).` : f ? `Same ${f.match} as the ${f.name}, who already have an account.` : `Same ${c.match} as the client ${c.name}.` });
      }
    }
    leads.push({ row, parent_name: parent, email: email || null, phone, athlete_name: val(r, 'athlete_name') || null, athlete_age: age, sport: val(r, 'sport') || null, source, status: stage ?? 'new', notes: val(r, 'notes') || null });
  });
  if (!leads.length && !errors.length) err(null, null, 'The file has no leads in it.');
  return { errors, warnings, leads };
}
export function importLeads(ctx, body, { user } = {}) {
  const first = checkFile(ctx, body);
  const preview = {
    rows: first.leads.length, errors: first.errors, warnings: first.warnings,
    sample: first.leads.slice(0, 10).map((l) => ({ row: l.row, parent_name: l.parent_name, email: l.email, phone: l.phone, athlete_name: l.athlete_name, source: SOURCE_LABELS[l.source], stage: STAGE_LABELS[l.status] })),
    by_stage: Object.fromEntries(IMPORT_STAGES.map((s) => [s, first.leads.filter((l) => l.status === s).length]))
  };
  if (first.errors.length) throw Object.assign(new HttpError(400, 'import_problems', `${first.errors.length} ${first.errors.length === 1 ? 'problem' : 'problems'} to fix. Nothing was saved.`), { details: preview });
  if (body.dry_run) return { ...preview, saved: 0 };
  if (first.warnings.length && body.confirm !== true) throw Object.assign(new HttpError(409, 'import_confirm', `${first.warnings.length} ${first.warnings.length === 1 ? 'row looks' : 'rows look'} like someone you may already have. Check them, then import with confirm.`), { details: preview });
  const now = ctx.now();
  let saved = 0;
  ctx.db.tx(() => {
    // Checked again inside the transaction: a lead added since the preview makes the whole file wait.
    const again = checkFile(ctx, body);
    if (again.errors.length) throw Object.assign(new HttpError(409, 'import_problems', 'Something changed since the preview. Check the file again.'), { details: { ...preview, errors: again.errors } });
    if (again.warnings.length > first.warnings.length && body.confirm !== true) throw Object.assign(new HttpError(409, 'import_confirm', 'Something changed since the preview. Check the file again.'), { details: preview });
    for (const l of again.leads) {
      const id = newId('lead');
      ctx.db.run(`INSERT INTO leads (id, parent_name, email, phone, athlete_name, athlete_age, sport, message, source, status, texts_ok, follow_up_step, next_follow_up_at, notes, created_by, stage_changed_at, last_activity_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 3, NULL, ?, ?, ?, ?, ?, ?)`, id, l.parent_name, l.email, l.phone, l.athlete_name, l.athlete_age, l.sport, l.source, l.status, l.notes, user?.name ?? 'Import', now, now, now, now);
      ctx.db.run('INSERT INTO lead_stage_history (id, lead_id, from_stage, to_stage, auto, reason, by_id, by_name, at) VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?)', newId('lsh'), id, l.status, 'Imported', user?.id ?? null, user?.name ?? 'Import', now);
      saved++;
    }
  });
  emit(ctx, 'leads.imported', { count: saved, by: user?.name ?? 'API' });
  return { ...preview, saved };
}
export function importTemplate() {
  const rows = [COLUMNS.map(([, l]) => l), ['Sarah Miller', 'sarah@example.com', '(512) 555-0142', 'Jake Miller', '12', 'Baseball', 'Event', 'New', 'Met at the spring showcase']];
  return { filename: 'lead-import-template.csv', type: 'text/csv; charset=utf-8', body: `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n` };
}
