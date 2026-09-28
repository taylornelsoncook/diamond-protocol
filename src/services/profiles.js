// One profile per athlete, from the family's side and the owner's side:
// - A parent who signs up (or adds a child in the portal) for a child who already has a profile with no family (a team
//   roster athlete) can give the child's Athlete ID. If the name and birthday (so the birth year too) match that profile, it joins their family
//   instead of a second profile being made. Otherwise a new profile is made as usual and, when the ID belongs to a
//   profile, the owner is asked to check and merge. The parent gets the same answer either way, so the form never tells a
//   stranger whether an ID exists (IDs are guessable from a name and a year).
// - Owners merge two profiles of the same athlete: everything moves onto one profile in one transaction, the other
//   profile's Athlete ID keeps finding the athlete, and it's written to the audit log.
import { newId, v, notFound, conflict, badRequest } from '../util.js';
import { getSetting } from './families.js';
import { findByAthleteId, ID_PATTERN } from './athlete-ids.js';
import { sendEmail } from './mail.js';
import { emit } from './events.js';
import { audit } from './security.js';

const first = (name) => String(name ?? '').split(' ')[0];
const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const ownerEmails = (ctx) => ctx.db.all(`SELECT name, email FROM users WHERE role = 'owner' AND active = 1`);
const tellOwners = (ctx, subject, text) => { for (const o of ownerEmails(ctx)) sendEmail(ctx, { to: o.email, subject, text: `Hi ${first(o.name)},\n\n${text}\n\n${getSetting(ctx, 'business_name')}` }).catch(() => {}); };

// The Athlete ID a parent typed: cleaned up, or null when the field was left empty. A badly shaped ID is refused (that
// says nothing about which IDs exist).
export function claimCode(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest('The Athlete ID has to be text, like AVALOP2026.');
  const id = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!id) return null;
  if (!ID_PATTERN.test(id)) throw badRequest('An Athlete ID looks like AVALOP2026 (3 + 3 letters and a year, sometimes with -2). Check it, or leave it empty.');
  return id;
}

// Try to claim a profile for a family. Returns { attached: client } when it joined the family, else { open: reason | null }.
// Nothing is created here for an open claim: the caller makes the new athlete, then calls fileClaim.
export function tryClaim(ctx, { code, name, birthDate, familyId, guardian, fields = {} }) {
  const found = findByAthleteId(ctx, code);
  const c = found ? ctx.db.get('SELECT * FROM clients WHERE id = ?', found.client_id) : null;
  if (!c || String(c.access_token ?? '').startsWith('gone_')) return { open: null };            // no such ID (or a deleted family's): nothing to tell the owner
  if (c.family_id === familyId) return { open: null, already: c };
  if (c.family_id) return { open: 'in_family', client: c };
  if (c.archived_at) return { open: 'archived', client: c };
  if (norm(c.name) !== norm(name)) return { open: 'name', client: c };
  if (!c.birth_date) return { open: 'no_birthday', client: c };
  if (!birthDate || String(birthDate).slice(0, 4) !== c.birth_date.slice(0, 4)) return { open: 'birth_year', client: c };
  // The year matches but not the day: the owner checks. (An ID can be worked out from a name and the year they joined,
  // and a birth year is easy to guess from a school year, so only the full birthday attaches a profile on its own.)
  if (String(birthDate).slice(0, 10) !== c.birth_date) return { open: 'birthday', client: c };
  // A match: the profile joins the family. The coach's details stay; empty ones are filled from the parent's form.
  const keep = ['sex', 'sport', 'school', 'medical_notes', 'emergency_name', 'emergency_phone'];
  const changed = ctx.db.tx(() => {
    const r = ctx.db.run(`UPDATE clients SET family_id = ?, ${keep.map((k) => `${k} = COALESCE(${k}, ?)`).join(', ')} WHERE id = ? AND family_id IS NULL AND archived_at IS NULL`,
      familyId, ...keep.map((k) => fields[k] ?? null), c.id);
    if (!r.changes) return 0;
    ctx.db.run(`INSERT INTO profile_claims (id, family_id, guardian_id, guardian_name, athlete_id, claimed_client_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'attached', ?)`,
      newId('clm'), familyId, guardian?.id ?? null, guardian?.name ?? null, code, c.id, ctx.now());
    return 1;
  });
  if (!changed) return { open: 'in_family', client: c };                                          // someone else claimed it a moment ago
  audit(ctx, { actor_type: 'parent', actor_id: guardian?.id ?? null, actor_name: guardian?.name ?? null, action: 'claim profile by Athlete ID', target: c.id, status: 200 });
  emit(ctx, 'client.claimed', { client_id: c.id, client_name: c.name, athlete_id: c.athlete_id, family_id: familyId, guardian_name: guardian?.name ?? null });
  tellOwners(ctx, `${c.name} joined a family with their Athlete ID`, `${guardian?.name ?? 'A parent'} added ${c.name} (${c.athlete_id}) to their family using the Athlete ID, with a matching name and birthday. ${first(c.name)}'s team profile, results and attendance stay on the one profile, and the parents can see them in the portal now.\n\nNot right? Open ${first(c.name)}'s client page: ${ctx.publicUrl ?? ''}/#/clients/${c.id}`);
  return { attached: ctx.db.get('SELECT * FROM clients WHERE id = ?', c.id) };
}
// No match: the new athlete was made. The owner is asked to check (only when the ID belongs to a real profile).
const REASONS = { birthday: 'the birthday is different (the year matches)', name: 'the name is different', no_birthday: 'the profile has no birthday to check', birth_year: 'the birth year is different', in_family: 'the profile is already in another family', archived: 'the profile is archived' };
export function fileClaim(ctx, { code, familyId, guardian, claim, newClientId }) {
  if (!claim?.open || !claim.client) return null;
  const id = newId('clm');
  ctx.db.run(`INSERT INTO profile_claims (id, family_id, guardian_id, guardian_name, athlete_id, claimed_client_id, new_client_id, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    id, familyId, guardian?.id ?? null, guardian?.name ?? null, code, claim.client.id, newClientId, claim.open, ctx.now());
  const kid = ctx.db.get('SELECT name FROM clients WHERE id = ?', newClientId);
  tellOwners(ctx, `Check: is ${kid?.name ?? 'a new athlete'} the same athlete as ${claim.client.name}?`,
    `${guardian?.name ?? 'A parent'} added ${kid?.name ?? 'an athlete'} and gave the Athlete ID ${code}, which belongs to ${claim.client.name}, but ${REASONS[claim.open] ?? 'it didn\'t match'}, so a new profile was made.\n\nIf they're the same athlete, merge the new profile into ${first(claim.client.name)}'s from Today or the client page (owners only): ${ctx.publicUrl ?? ''}/#/clients/${claim.client.id}`);
  return id;
}
// The parent's answer after an open claim: the same words whether or not the ID exists.
export const claimPendingText = (name) => `We made a profile for ${first(name)}. We'll check the Athlete ID with your coach and link ${first(name)}'s team results if it matches.`;

export function listClaims(ctx, { status = 'open' } = {}) {
  return ctx.db.all(`SELECT k.id, k.status, k.reason, k.athlete_id, k.created_at, k.resolved_at, k.resolved_by, k.guardian_name, f.name AS family_name,
      k.claimed_client_id, c.name AS claimed_name, c.athlete_id AS claimed_athlete_id, k.new_client_id, n.name AS new_name, n.athlete_id AS new_athlete_id
    FROM profile_claims k LEFT JOIN families f ON f.id = k.family_id LEFT JOIN clients c ON c.id = k.claimed_client_id LEFT JOIN clients n ON n.id = k.new_client_id
    WHERE ${status === 'all' ? '1' : 'k.status = ?'} ORDER BY k.created_at DESC LIMIT 100`, ...(status === 'all' ? [] : [v.oneOf(status, 'status', ['open', 'attached', 'merged', 'dismissed'])]));
}
export function dismissClaim(ctx, id, actor) {
  const r = ctx.db.run(`UPDATE profile_claims SET status = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'open'`, ctx.now(), actor?.name ?? 'Staff', id);
  if (!r.changes) throw conflict('This check was already handled.');
  return { id, status: 'dismissed' };
}

// ---------- Merge two profiles (owner) ----------
// Every table with a column pointing at clients, found from the database itself, so a table added later is moved too.
function clientRefs(ctx) {
  const tables = ctx.db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((t) => t.name);
  const out = [];
  for (const t of tables) for (const fk of ctx.db.all(`PRAGMA foreign_key_list(${t})`)) if (fk.table === 'clients' && t !== 'clients') out.push({ table: t, col: fk.from });
  return out;
}
const PROFILE_FIELDS = ['email', 'phone', 'birth_date', 'sex', 'sport', 'position', 'school', 'grad_year', 'medical_notes', 'emergency_name', 'emergency_phone', 'family_id', 'notes'];
const liveSub = (ctx, id) => ctx.db.get(`SELECT s.id, s.status, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.client_id = ? AND s.status != 'canceled' LIMIT 1`, id);
function mergeProblems(ctx, keep, from) {
  const problems = [];
  if (keep.archived_at || from.archived_at) problems.push(`${keep.archived_at ? keep.name : from.name} is archived. Bring them back first.`);
  if (liveSub(ctx, keep.id) && liveSub(ctx, from.id)) problems.push('Both profiles have a membership. Cancel one of them first.');
  if (keep.family_id && from.family_id && keep.family_id !== from.family_id) problems.push('The profiles are in different families. Move the parents into one family first, or leave them apart.');
  const both = ctx.db.all(`SELECT s.name, s.starts_at FROM bookings a JOIN bookings b ON b.session_id = a.session_id JOIN class_sessions s ON s.id = a.session_id
    WHERE a.client_id = ? AND b.client_id = ? AND a.status IN ('booked','waitlisted','attended') AND b.status IN ('booked','waitlisted','attended') LIMIT 3`, keep.id, from.id);
  if (both.length) problems.push(`Both profiles are booked for ${both.map((x) => x.name).join(', ')}. Cancel one of the bookings first.`);
  const spots = ctx.db.all(`SELECT DISTINCT cs.name FROM enrollments a JOIN enrollments b ON b.series_id = a.series_id JOIN class_series cs ON cs.id = a.series_id
    WHERE a.client_id = ? AND b.client_id = ? AND a.status = 'active' AND b.status = 'active'`, keep.id, from.id);
  if (spots.length) problems.push(`Both profiles hold a spot in ${spots.map((x) => x.name).join(', ')}. Release one first.`);
  if (keep.card_payment_method && from.card_payment_method) problems.push('Both profiles have their own saved card. Remove one of them first.');
  return problems;
}
function profileSummary(ctx, c) {
  const fam = c.family_id ? ctx.db.get('SELECT name FROM families WHERE id = ?', c.family_id) : null;
  const count = (sql) => ctx.db.get(sql, c.id).n;
  return { id: c.id, name: c.name, athlete_id: c.athlete_id, birth_date: c.birth_date, family_name: fam?.name ?? null, archived: !!c.archived_at, membership: liveSub(ctx, c.id)?.plan_name ?? null,
    results: count('SELECT COUNT(*) AS n FROM perf_results WHERE client_id = ? AND voided = 0'), bookings: count('SELECT COUNT(*) AS n FROM bookings WHERE client_id = ?'),
    teams: count('SELECT COUNT(*) AS n FROM team_roster WHERE client_id = ?'), notes: count('SELECT COUNT(*) AS n FROM client_notes WHERE client_id = ?'), created_at: c.created_at };
}
function pair(ctx, keepId, fromId) {
  const keep = ctx.db.get('SELECT * FROM clients WHERE id = ?', String(keepId ?? '')), from = ctx.db.get('SELECT * FROM clients WHERE id = ?', String(fromId ?? ''));
  if (!keep || !from) throw notFound('Client');
  if (keep.id === from.id) throw badRequest('Choose two different profiles.');
  if ([keep, from].some((c) => String(c.access_token ?? '').startsWith('gone_'))) throw conflict('One of these profiles belongs to a deleted family and can\'t be merged.');
  return { keep, from };
}
export function mergePreview(ctx, keepId, fromId) {
  const { keep, from } = pair(ctx, keepId, fromId);
  return { keep: profileSummary(ctx, keep), from: profileSummary(ctx, from), problems: mergeProblems(ctx, keep, from),
    result: { name: keep.name, athlete_id: keep.athlete_id, old_athlete_id_still_works: from.athlete_id } };
}
// Moves everything from `from` onto `keep` and removes `from`, in one transaction. Where a record can exist only once per
// athlete (a daily check-in on the same day, a badge, a lesson read), keep's stays and from's copy is dropped; those are
// counted in `dropped`. Any row still pointing at `from` afterwards stops the merge (nothing is saved).
export function mergeProfiles(ctx, keepId, fromId, body = {}, actor) {
  if (body.confirm !== true) throw badRequest('Send confirm: true to merge. Check the preview first: it can\'t be undone.');
  let { keep, from } = pair(ctx, keepId, fromId);
  const dropped = {}, moved = {};
  ctx.db.tx(() => {
    // Checked again inside the transaction (it holds the database), so nothing can change between the check and the move.
    ({ keep, from } = pair(ctx, keepId, fromId));
    const problems = mergeProblems(ctx, keep, from);
    if (problems.length) throw conflict(problems.join(' '));
    // Things only one profile should have at a time.
    if (ctx.db.get('SELECT 1 FROM assignments WHERE client_id = ? AND active = 1', keep.id)) ctx.db.run('UPDATE assignments SET active = 0 WHERE client_id = ? AND active = 1', from.id);
    if (ctx.db.get(`SELECT 1 FROM membership_requests WHERE client_id = ? AND status = 'open'`, keep.id)) {
      ctx.db.run(`UPDATE membership_requests SET status = 'withdrawn', resolved_at = ?, resolved_by = ?, resolution_note = 'Profiles merged' WHERE client_id = ? AND status = 'open'`, ctx.now(), actor?.name ?? 'Owner', from.id);
    }
    ctx.db.run('UPDATE workout_logs SET request_id = NULL WHERE client_id = ? AND request_id IN (SELECT request_id FROM workout_logs WHERE client_id = ? AND request_id IS NOT NULL)', from.id, keep.id);
    // One booking per athlete per session (both live was refused above): a live booking wins over a canceled one, else keep's stays.
    const LIVE = `('booked','waitlisted','attended')`;
    ctx.db.run(`DELETE FROM bookings WHERE client_id = ? AND status NOT IN ${LIVE} AND session_id IN (SELECT session_id FROM bookings WHERE client_id = ? AND status IN ${LIVE})`, keep.id, from.id);
    ctx.db.run('DELETE FROM bookings WHERE client_id = ? AND session_id IN (SELECT session_id FROM bookings WHERE client_id = ?)', from.id, keep.id);
    // Team rosters: one line per team (results and attendance are on the client, not the line); still on the team if either was.
    ctx.db.run(`UPDATE team_roster SET active = 1 WHERE client_id = ? AND active = 0 AND contract_id IN (SELECT contract_id FROM team_roster WHERE client_id = ? AND active = 1)`, keep.id, from.id);
    ctx.db.run('DELETE FROM team_roster WHERE client_id = ? AND contract_id IN (SELECT contract_id FROM team_roster WHERE client_id = ?)', from.id, keep.id);
    for (const { table, col } of clientRefs(ctx)) {
      const n = ctx.db.run(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${col} = ?`, keep.id, from.id).changes;
      if (n) moved[table] = (moved[table] ?? 0) + n;
      const left = ctx.db.run(`DELETE FROM ${table} WHERE ${col} = ?`, from.id).changes;      // only rows that would repeat one keep already has
      if (left) dropped[table] = (dropped[table] ?? 0) + left;
    }
    // Lists that name athletes inside a text column.
    for (const s of ctx.db.all(`SELECT id, athletes FROM perf_sessions WHERE athletes LIKE ?`, `%${from.id}%`)) {
      let list; try { list = JSON.parse(s.athletes); } catch { continue; }
      const out = [];
      for (const a of Array.isArray(list) ? list : []) { const id = a?.client_id === from.id ? keep.id : a?.client_id; if (id && !out.some((x) => x.client_id === id)) out.push({ ...a, client_id: id }); }
      ctx.db.run('UPDATE perf_sessions SET athletes = ? WHERE id = ?', JSON.stringify(out), s.id);
    }
    for (const o of ctx.db.all(`SELECT id, client_ids FROM spot_offers WHERE client_ids LIKE ?`, `%${from.id}%`)) {
      ctx.db.run('UPDATE spot_offers SET client_ids = ? WHERE id = ?', [...new Set(o.client_ids.split(',').map((x) => (x === from.id ? keep.id : x)))].join(','), o.id);
    }
    // Empty details on keep are filled from the other profile; keep's own details stay. A card moves with its Stripe customer.
    const fill = PROFILE_FIELDS.filter((k) => (keep[k] == null || keep[k] === '') && from[k] != null && from[k] !== '');
    const card = !keep.card_payment_method && from.card_payment_method ? ['stripe_customer_id', 'card_payment_method', 'card_brand', 'card_last4', 'card_exp', 'card_status'] : [];
    const athleteId = from.athlete_id;
    ctx.db.run(`UPDATE profile_claims SET status = 'merged', resolved_at = ?, resolved_by = ? WHERE status = 'open' AND claimed_client_id = ? AND new_client_id = ?`, ctx.now(), actor?.name ?? 'Owner', keep.id, keep.id);
    // Nothing may still point at the other profile: deleting it would take those rows with it.
    for (const { table, col } of clientRefs(ctx)) if (ctx.db.get(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`, from.id)) throw conflict(`Couldn't move ${table}. Nothing was changed.`);
    ctx.db.run('DELETE FROM clients WHERE id = ?', from.id);
    if (fill.length || card.length) ctx.db.run(`UPDATE clients SET ${[...fill, ...card].map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...[...fill, ...card].map((k) => from[k]), keep.id);
    // The other profile's Athlete ID keeps finding the athlete (sheets, devices, printed cards).
    if (athleteId && athleteId !== keep.athlete_id) ctx.db.run(`INSERT OR IGNORE INTO athlete_id_aliases (athlete_id, client_id, source, created_at) VALUES (?, ?, 'merge', ?)`, athleteId, keep.id, ctx.now());
    ctx.db.run('UPDATE team_roster SET name = ?, athlete_id = ? WHERE client_id = ?', keep.name, keep.athlete_id, keep.id);
  });
  audit(ctx, { actor_type: 'staff', actor_id: actor?.id ?? null, actor_name: actor?.name ?? null, role: actor?.role ?? null, action: `merge profile ${from.name} (${from.athlete_id}) into ${keep.name} (${keep.athlete_id})`, target: keep.id, status: 200 });
  emit(ctx, 'client.merged', { client_id: keep.id, client_name: keep.name, athlete_id: keep.athlete_id, merged_client_id: from.id, merged_athlete_id: from.athlete_id });
  return { client_id: keep.id, merged: from.id, alias: from.athlete_id, moved, dropped };
}
