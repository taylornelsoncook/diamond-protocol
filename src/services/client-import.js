import { newId, token, v, badRequest, notFound, HttpError } from '../util.js';
import { createFamilyWithGuardian, addGuardian } from './families.js';
import { newAthleteId } from './athlete-ids.js';
import { readUpload, excelDate } from './uploads.js';
import { writeXlsx } from './xlsx.js';
import { welcomeFamily, welcomeClient } from './notify.js';
import { emit } from './events.js';

// Bring existing clients in from a spreadsheet. All or nothing, like results uploads: the whole file is
// checked, a preview shows exactly which families and Athlete IDs will be created, and one problem blocks it.
const COLUMNS = [
  ['first_name', 'Athlete first name', /^(athlete )?first( name)?$/], ['last_name', 'Athlete last name', /^(athlete )?(last|sur)( name)?$/],
  ['name', 'Athlete name', /^(athlete|athlete name|name|full name|client|client name)$/],
  ['birth_date', 'Birthday (YYYY-MM-DD)', /^(birthday|birth ?date|dob|date of birth)/], ['sex', 'Sex (M/F)', /^(sex|gender)/],
  ['sport', 'Sport', /^sport/], ['position', 'Position', /^position/], ['school', 'School', /^school/], ['grad_year', 'Grad year', /^(grad|graduation)( year)?/],
  ['email', 'Athlete email (adults paying for themselves)', /^(athlete |client )?e-?mail/], ['phone', 'Athlete phone', /^(athlete |client )?(phone|mobile|cell)/],
  ['parent_name', 'Parent name', /^(parent|guardian)( 1)?( name)?$/], ['parent_email', 'Parent email', /^(parent|guardian)( 1)? e-?mail/], ['parent_phone', 'Parent phone', /^(parent|guardian)( 1)? (phone|mobile|cell)/],
  ['parent2_name', 'Second parent name', /^(second parent|parent 2|guardian 2)( name)?$/], ['parent2_email', 'Second parent email', /^(second parent|parent 2|guardian 2) e-?mail/],
  ['medical_notes', 'Medical notes', /^(medical|allerg|health)/], ['emergency_name', 'Emergency contact', /^emergency( contact)?( name)?$/], ['emergency_phone', 'Emergency phone', /^emergency (contact )?phone/],
  ['notes', 'Coach notes', /^(coach )?notes?$/]
];
const norm = (h) => String(h).trim().toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ');

export function importTemplate(format) {
  const header = COLUMNS.filter(([k]) => k !== 'name').map(([, label]) => label);
  const ex = ['Ava', 'Lopez', '2013-03-10', 'F', 'Soccer', 'Winger', 'Lincoln Middle', '', '', '', 'Maria Lopez', 'maria@example.com', '555-0101', '', '', 'Mild asthma', 'Grandma Lopez', '555-0199', ''];
  const ex2 = ['Ben', 'Lopez', '2016-06-01', 'M', 'Baseball', '', '', '', '', '', 'Maria Lopez', 'maria@example.com', '555-0101', '', '', '', '', '', 'Sibling: same parent email makes one family'];
  const ex3 = ['Jordan', 'Ellis', '1994-02-11', 'M', '', '', '', '', 'jordan@example.com', '555-0133', '', '', '', '', '', '', '', '', 'Adult client: own email, no parent'];
  if (format === 'csv') {
    const csv = [header, ex, ex2, ex3].map((r) => r.map((x) => (/[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(',')).join('\r\n');
    return { filename: 'client-import-template.csv', type: 'text/csv; charset=utf-8', body: Buffer.from('\uFEFF' + csv, 'utf8') };
  }
  return { filename: 'client-import-template.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsx([
    { name: 'Clients', rows: [header, ex, ex2, ex3], widths: header.map((h) => Math.max(12, Math.min(40, h.length + 2))) },
    { name: 'How to fill in', rows: [['One row per athlete. Delete the three example rows first.'], [''],
      ['Kids: fill in Parent name and Parent email. Brothers and sisters with the same parent email become one family with one login and one card.'],
      ['Adults paying for themselves: fill in Athlete email and leave the parent columns empty.'],
      ['If a parent already has an account, the athlete is added to that family.'],
      ['Birthday as 2013-03-10 (needed for age groups). Sex as M or F (only used for growth estimates).'],
      ['Every athlete gets an Athlete ID when the import is saved, for example AVALOP2026.'],
      ['Memberships and cards aren\'t imported: families add their own card in the parent portal.']], widths: [110] }]) };
}

function parseRows(ctx, headers, rows) {
  const errors = [];
  const err = (row, column, message) => errors.push({ row, column, message });
  const map = {};
  for (const h of headers) { const c = COLUMNS.find(([, , re]) => re.test(norm(h))); if (c && !map[c[0]]) map[c[0]] = h; else if (!c && rows.some((r) => String(r[h] ?? '').trim())) err(1, h, `"${h}" isn't a column the import knows. Use the template's columns, or delete this one.`); }
  if (!map.name && !(map.first_name && map.last_name)) err(1, null, 'The sheet needs the athlete\'s name: either "Athlete name", or "Athlete first name" and "Athlete last name".');
  if (!map.parent_email && !map.email) err(1, null, 'The sheet needs "Parent email" (for kids) or "Athlete email" (for adults).');
  // Unknown columns are listed along with row problems, so one pass shows everything; missing required columns stop here.
  if (errors.some((e) => e.column === null)) return { errors, people: [] };
  const people = [];
  const seenEmails = new Map(), seenAthletes = new Map();
  const val = (r, k) => (map[k] ? String(r[map[k]] ?? '').trim() : '');
  rows.forEach((r, i) => {
    const row = i + 2;
    const name = (val(r, 'name') || `${val(r, 'first_name')} ${val(r, 'last_name')}`).trim().replace(/\s+/g, ' ');
    const anything = Object.keys(map).some((k) => val(r, k));
    if (!anything) return;
    if (!name) return err(row, map.name ?? map.first_name, 'Missing the athlete\'s name.');
    const p = { row, name };
    const email = val(r, 'email').toLowerCase(), pEmail = val(r, 'parent_email').toLowerCase(), p2Email = val(r, 'parent2_email').toLowerCase();
    const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
    for (const [e, col] of [[email, map.email], [pEmail, map.parent_email], [p2Email, map.parent2_email]]) if (e && !isEmail(e)) err(row, col, `"${e}" isn't an email address.`);
    if (!email && !pEmail) return err(row, map.parent_email ?? map.email, `${name} needs a parent email, or their own email if they're an adult.`);
    let b = val(r, 'birth_date');
    if (b) {
      b = String(excelDate(b));
      const us = b.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (us) b = `${us[3].length === 2 ? (Number(us[3]) > 30 ? '19' : '20') + us[3] : us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b) || Number.isNaN(Date.parse(b)) || b > new Date().toISOString().slice(0, 10) || b < '1920-01-01') err(row, map.birth_date, `"${val(r, 'birth_date')}" isn't a birthday. Use 2013-03-10.`);
    }
    let sex = val(r, 'sex').toLowerCase();
    if (sex) { sex = { m: 'M', male: 'M', boy: 'M', f: 'F', female: 'F', girl: 'F' }[sex]; if (!sex) err(row, map.sex, 'Sex should be M or F (or leave it empty).'); }
    const grad = val(r, 'grad_year');
    if (grad && !/^(19|20)\d\d$/.test(grad)) err(row, map.grad_year, 'Grad year should look like 2029.');
    Object.assign(p, { email: pEmail ? (email || null) : email, birth_date: b || null, sex: sex || null, sport: val(r, 'sport') || null, position: val(r, 'position') || null, school: val(r, 'school') || null,
      grad_year: grad ? Number(grad) : null, phone: val(r, 'phone') || null, medical_notes: val(r, 'medical_notes') || null, emergency_name: val(r, 'emergency_name') || null, emergency_phone: val(r, 'emergency_phone') || null, notes: val(r, 'notes') || null,
      parent: pEmail ? { name: val(r, 'parent_name'), email: pEmail, phone: val(r, 'parent_phone') || null } : null,
      parent2: p2Email ? { name: val(r, 'parent2_name'), email: p2Email } : null });
    if (p.email) {
      if (seenEmails.has(p.email)) err(row, map.email, `${p.email} is also used on row ${seenEmails.get(p.email)}. Each athlete needs their own email (or leave it empty for kids).`);
      seenEmails.set(p.email, row);
      if (ctx.db.get('SELECT 1 FROM clients WHERE email = ?', p.email)) err(row, map.email, `${p.email} already belongs to a client.`);
      if (!pEmail && ctx.db.get('SELECT 1 FROM guardians WHERE email = ?', p.email)) err(row, map.email, `${p.email} belongs to a parent account. For their child, put it in Parent email instead.`);
    }
    if (p.parent && !p.parent.name && !ctx.db.get('SELECT 1 FROM guardians WHERE email = ?', pEmail)) err(row, map.parent_name ?? map.parent_email, `Add the parent's name for ${pEmail}.`);
    if (p.parent2 && !p.parent2.name && !ctx.db.get('SELECT 1 FROM guardians WHERE email = ?', p2Email)) err(row, map.parent2_name ?? map.parent2_email, `Add the second parent's name for ${p2Email}.`);
    const key = `${name.toLowerCase()}|${b || ''}`;
    if (seenAthletes.has(key)) err(row, map.name ?? map.first_name, `${name} is also on row ${seenAthletes.get(key)}.`);
    seenAthletes.set(key, row);
    const dupe = ctx.db.get(`SELECT athlete_id FROM clients WHERE lower(name) = lower(?) AND COALESCE(birth_date, '') = ?`, name, b || '');
    if (dupe) err(row, map.name ?? map.first_name, `${name}${b ? ` (born ${b})` : ''} is already a client (${dupe.athlete_id}).`);
    people.push(p);
  });
  // A second parent can't already belong to a different family.
  for (const p of people.filter((x) => x.parent2)) {
    const g2 = ctx.db.get('SELECT family_id FROM guardians WHERE email = ?', p.parent2.email), g1 = ctx.db.get('SELECT family_id FROM guardians WHERE email = ?', p.parent.email);
    if (g2 && g2.family_id !== g1?.family_id) err(p.row, map.parent2_email, `${p.parent2.email} already belongs to a different family.`);
  }
  if (!errors.length && !people.length) err(null, null, 'There are no clients in this sheet.');
  return { errors, people };
}

// Creates everything inside one transaction. For a preview the transaction is rolled back, so the
// preview shows the exact Athlete IDs and families the real import will create.
function apply(ctx, people, { dryRun }) {
  const created = [], families = new Map(), sentinel = new Error('preview');
  try {
    ctx.db.tx(() => {
      for (const p of people) {
        let familyId = null, familyStatus = null;
        if (p.parent) {
          const existing = ctx.db.get('SELECT family_id FROM guardians WHERE email = ?', p.parent.email);
          if (existing) { familyId = existing.family_id; familyStatus = families.get(familyId)?.status ?? 'existing'; }
          else { familyId = createFamilyWithGuardian(ctx, p.parent); familyStatus = 'new'; }
          if (p.parent2 && !ctx.db.get('SELECT 1 FROM guardians WHERE email = ?', p.parent2.email)) addGuardian(ctx, familyId, p.parent2);
          if (!families.has(familyId)) families.set(familyId, { family_id: familyId, status: familyStatus, name: ctx.db.get('SELECT name FROM families WHERE id = ?', familyId).name, parents: [], athletes: [] });
        }
        const id = newId('cli');
        const athleteId = newAthleteId(ctx, p.name);
        ctx.db.run(`INSERT INTO clients (id, athlete_id, name, email, phone, notes, access_token, family_id, birth_date, sex, sport, position, school, grad_year, medical_notes, emergency_name, emergency_phone, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, athleteId, p.name, p.email, p.phone, p.notes, token(24), familyId, p.birth_date, p.sex, p.sport, p.position, p.school, p.grad_year, p.medical_notes, p.emergency_name, p.emergency_phone, ctx.now());
        emit(ctx, 'client.created', { client_id: id, athlete_id: athleteId, client_name: p.name, email: p.email, family_id: familyId, imported: true });
        const a = { row: p.row, client_id: id, athlete_id: athleteId, name: p.name, birth_date: p.birth_date, family_id: familyId, adult: !familyId };
        created.push(a);
        if (familyId) families.get(familyId).athletes.push(a);
      }
      for (const f of families.values()) f.parents = ctx.db.all('SELECT name, email FROM guardians WHERE family_id = ? ORDER BY is_primary DESC', f.family_id);
      if (dryRun) throw sentinel;
    });
  } catch (e) { if (e !== sentinel) throw e; }
  return { athletes: created, families: [...families.values()] };
}

export function previewImport(ctx, body) {
  const { headers, rows } = readUpload(body);
  if (rows.length > 5000) throw badRequest('Import up to 5,000 clients at a time.');
  const { errors, people } = parseRows(ctx, headers, rows);
  const id = newId('upl');
  ctx.db.run(`DELETE FROM upload_previews WHERE expires_at < ?`, ctx.now());
  ctx.db.run('INSERT INTO upload_previews (id, filename, options, headers, rows, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, body.filename ? String(body.filename).slice(0, 200) : null, JSON.stringify({ kind: 'clients' }), JSON.stringify(headers), JSON.stringify(rows), new Date(Date.now() + 24 * 3600000).toISOString(), ctx.now());
  if (errors.length) return { preview_id: id, ok: false, errors: errors.slice(0, 200), error_count: errors.length };
  const plan = apply(ctx, people, { dryRun: true });
  return { preview_id: id, ok: true, errors: [], summary: { athletes: plan.athletes.length, new_families: plan.families.filter((f) => f.status === 'new').length, existing_families: plan.families.filter((f) => f.status === 'existing').length, adults: plan.athletes.filter((a) => a.adult).length }, ...plan };
}

export async function commitImport(ctx, body) {
  const p = ctx.db.get('SELECT * FROM upload_previews WHERE id = ?', v.str(body.preview_id, 'preview_id'));
  if (!p || p.expires_at < ctx.now() || JSON.parse(p.options).kind !== 'clients') throw notFound('Import (it may have expired; upload the file again)');
  const { errors, people } = parseRows(ctx, JSON.parse(p.headers), JSON.parse(p.rows));        // checked again against today's data
  if (errors.length) { const e = new HttpError(409, 'import_rejected', `Nothing was imported. ${errors.length} ${errors.length === 1 ? 'problem needs' : 'problems need'} fixing.`); e.details = errors.slice(0, 200); throw e; }
  const result = apply(ctx, people, { dryRun: false });
  ctx.db.run('DELETE FROM upload_previews WHERE id = ?', p.id);
  let invited = 0;
  if (body.send_welcome) {
    for (const f of result.families.filter((x) => x.status === 'new')) { await welcomeFamily(ctx, f.family_id); invited++; }
    for (const a of result.athletes.filter((x) => x.adult)) { await welcomeClient(ctx, a.client_id); invited++; }
  }
  emit(ctx, 'clients.imported', { athletes: result.athletes.length, families: result.families.length, filename: p.filename });
  return { imported: result.athletes.length, invited, ...result };
}
