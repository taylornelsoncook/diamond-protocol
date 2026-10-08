// The start-up questions and the athlete's gear (version 67; owner decision after looking at Farren: a remote athlete
// who signs up on a Tuesday night trains on Wednesday morning, on the right gear, and the coach wakes up to a note).
//
// An athlete (or a parent through the family's Workout tab, or a coach on the client page) answers a few questions:
// goal, sport, experience, days a week and which days, where they train, and the gear they have at home. The answers
// are the athlete's training profile (training_profiles, one row per athlete). With no program yet, the answers are
// matched against the start-up rules owners and coaches wrote (program_rules: a program plus the goals, experience,
// days and gear it fits; the highest priority match wins), and, by the auto_program setting, the athlete is put on
// that program at once (auto, the default: assigned the usual way with their training days, so the calendar, the app
// and the roster view all follow), or the match waits for a coach on Today (review), or nothing happens (off). No
// match, or a goal nothing covers, lands on Today as "needs a program". A coach can always move them.
//
// The gear: an exercise in the plan that needs equipment the athlete lacks where they train on their own is swapped
// for one of the coach's listed alternatives that fits what they have (exercise_swaps with by_kind 'equipment', so the
// log, the screen and the coach's Live panel follow it like any swap). The athlete can put the plan's exercise back
// (swap_optouts remembers the slot) and a coach's own swap is never touched.
import { newId, v, notFound, badRequest, conflict } from '../util.js';
import { getSetting } from './families.js';
import { emit } from './events.js';
import { sendEmail } from './mail.js';
import { parseDays, daysNeeded, defaultDays, today as localToday } from './training-calendar.js';
import * as programs from './programs.js';
import { insertSwaps } from './live.js';

export const GOALS = { speed: 'Get faster', strength: 'Get stronger', power: 'Jump higher and hit harder', conditioning: 'Build my engine', general: 'Stay in shape', return: 'Come back from an injury' };
export const EXPERIENCE = { new: 'New to training', some: 'A year or two', experienced: 'Three years or more' };
export const TRAINS_AT = { home: 'At home or on my own', facility: 'At the facility', both: 'Both' };
export const MODES = ['auto', 'review', 'off'];
// Gear the questions offer; the labels are the library's equipment tags in plain words.
export const GEAR = { barbell: 'Barbell and plates', dumbbell: 'Dumbbells', kettlebell: 'Kettlebells', band: 'Bands', 'medicine ball': 'Medicine ball', box: 'A box or bench to jump on', bench: 'A bench', 'trap bar': 'Trap bar', sled: 'A sled', machine: 'Machines', cable: 'Cables' };
// The same gear as plain nouns, for the swap's reason ("No barbell or bench at home").
const GEAR_WORDS = { barbell: 'barbell', dumbbell: 'dumbbells', kettlebell: 'kettlebells', band: 'bands', 'medicine ball': 'medicine ball', box: 'box', bench: 'bench', 'trap bar': 'trap bar', sled: 'sled', machine: 'machine', cable: 'cables' };
// Tags that never mean "a piece of gear": anyone has their body, and "other" says nothing.
const NO_GEAR = new Set(['bodyweight', 'other']);
const mode = (ctx) => { const m = getSetting(ctx, 'auto_program'); return MODES.includes(m) ? m : 'auto'; };
const splitList = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
const joinList = (xs) => (xs?.length ? xs.join(',') : null);
const first = (name) => String(name ?? '').split(' ')[0];

// ---------- The profile ----------
function clientOf(ctx, id) {
  const c = ctx.db.get('SELECT id, name, sport, archived_at, family_id FROM clients WHERE id = ?', String(id));
  if (!c) throw notFound('Athlete');
  return c;
}
function manyOf(val, field, allowed) {
  if (val === undefined || val === null || val === '') return null;
  const list = Array.isArray(val) ? val : String(val).split(',');
  const out = [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const bad = out.filter((x) => !allowed.includes(x));
  if (bad.length) throw badRequest(`${field}: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not on the list (${allowed.join(', ')}).`);
  return out;
}
// The questions as the app asks them, so every screen reads one list.
export function questions() {
  return {
    goals: Object.entries(GOALS).map(([key, label]) => ({ key, label })),
    experience: Object.entries(EXPERIENCE).map(([key, label]) => ({ key, label })),
    trains_at: Object.entries(TRAINS_AT).map(([key, label]) => ({ key, label })),
    gear: Object.entries(GEAR).map(([key, label]) => ({ key, label }))
  };
}
const shape = (ctx, r) => (r ? {
  client_id: r.client_id, goal: r.goal, goal_label: GOALS[r.goal] ?? r.goal, sport: r.sport, experience: r.experience, experience_label: EXPERIENCE[r.experience] ?? r.experience,
  days_per_week: r.days_per_week, training_days: r.training_days ? parseDays(r.training_days) : null, trains_at: r.trains_at, trains_at_label: TRAINS_AT[r.trains_at] ?? r.trains_at,
  equipment: splitList(r.equipment).filter((k) => k !== 'bodyweight'), equipment_labels: splitList(r.equipment).filter((k) => k !== 'bodyweight').map((k) => GEAR[k] ?? k), equipment_answered: r.equipment != null, note: r.note, answered_by: r.answered_by, answered_at: r.answered_at, updated_at: r.updated_at,
  outcome: r.outcome, outcome_at: r.outcome_at, seen_at: r.seen_at,
  outcome_program: r.outcome_program_id ? ctx.db.get('SELECT id, name FROM programs WHERE id = ?', r.outcome_program_id) ?? null : null
} : null);
export function getProfile(ctx, clientId) {
  clientOf(ctx, clientId);
  return shape(ctx, ctx.db.get('SELECT * FROM training_profiles WHERE client_id = ?', String(clientId)));
}
// What the body says, checked. Fields left out keep what's on file (a coach fixing one answer), so cur is the row so far.
function fields(body, cur = {}) {
  const goal = body.goal !== undefined ? (body.goal === null || body.goal === '' ? null : v.oneOf(String(body.goal), 'goal', Object.keys(GOALS))) : cur.goal ?? null;
  const experience = body.experience !== undefined ? (body.experience === null || body.experience === '' ? null : v.oneOf(String(body.experience), 'experience', Object.keys(EXPERIENCE))) : cur.experience ?? null;
  const trainsAt = body.trains_at !== undefined ? (body.trains_at === null || body.trains_at === '' ? null : v.oneOf(String(body.trains_at), 'trains_at', Object.keys(TRAINS_AT))) : cur.trains_at ?? null;
  const days = body.days_per_week !== undefined ? (body.days_per_week === null || body.days_per_week === '' ? null : v.int(body.days_per_week, 'days_per_week', { min: 1, max: 7 })) : cur.days_per_week ?? null;
  let trainingDays = body.training_days !== undefined ? parseDays(body.training_days, { optional: true }) : (cur.training_days ? parseDays(cur.training_days) : null);
  if (trainingDays && days && trainingDays.length !== days) {
    if (body.training_days !== undefined && body.days_per_week !== undefined) throw badRequest(`You picked ${trainingDays.length} training days but said ${days} a week. Make them match.`);
    trainingDays = body.training_days !== undefined ? trainingDays : null;   // the days a week changed: the old days no longer fit
  }
  // Gear: a list (an empty one = bodyweight only, kept apart from "not answered"), null clears the answer.
  let equipment = cur.equipment ?? null;
  if (body.equipment !== undefined) { const list = manyOf(body.equipment, 'equipment', [...Object.keys(GEAR), 'bodyweight']); equipment = list === null ? null : (joinList(list.filter((x) => x !== 'bodyweight')) ?? 'bodyweight'); }
  return { goal, experience, trains_at: trainsAt, days_per_week: days, training_days: trainingDays ? trainingDays.join(',') : null, equipment,
    sport: body.sport !== undefined ? (v.str(body.sport, 'sport', { max: 60, optional: true }) || null) : cur.sport ?? null,
    note: body.note !== undefined ? (v.str(body.note, 'note', { max: 500, optional: true }) || null) : cur.note ?? null };
}
// Save the answers. who: { by: 'athlete' | 'parent' | 'coach', name }. With no program yet (and unless place is false),
// the answers are matched and the athlete placed by the auto_program setting; answers from a coach only match when asked.
export function answer(ctx, clientId, body = {}, who = { by: 'athlete' }, { place = who.by !== 'coach' } = {}) {
  const c = clientOf(ctx, clientId);
  if (c.archived_at) throw conflict(`${first(c.name)} is archived. Bring them back first.`);
  const cur = ctx.db.get('SELECT * FROM training_profiles WHERE client_id = ?', c.id) ?? {};
  const f = fields(body, cur);
  if (!cur.client_id && !f.goal && !f.experience && !f.days_per_week && !f.equipment && !f.trains_at) throw badRequest('Answer at least one question.');
  const now = ctx.now();
  ctx.db.run(`INSERT INTO training_profiles (client_id, goal, sport, experience, days_per_week, training_days, trains_at, equipment, note, answered_by, answered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (client_id) DO UPDATE SET goal = excluded.goal, sport = excluded.sport, experience = excluded.experience, days_per_week = excluded.days_per_week, training_days = excluded.training_days,
      trains_at = excluded.trains_at, equipment = excluded.equipment, note = excluded.note, answered_by = excluded.answered_by, updated_at = excluded.answered_at`,
    c.id, f.goal, f.sport ?? c.sport ?? null, f.experience, f.days_per_week, f.training_days, f.trains_at, f.equipment, f.note, who.by, now);
  if (f.sport && f.sport !== c.sport) ctx.db.run('UPDATE clients SET sport = ? WHERE id = ?', f.sport, c.id);
  emit(ctx, 'startup.answered', { client_id: c.id, client_name: c.name, by: who.by, goal: f.goal, experience: f.experience, days_per_week: f.days_per_week, trains_at: f.trains_at, equipment: splitList(f.equipment) });
  const placed = place ? placeAthlete(ctx, c, who) : null;
  return { profile: getProfile(ctx, c.id), placed };
}

// ---------- Rules ----------
function ruleFields(ctx, body, cur = {}) {
  const programId = body.program_id !== undefined ? v.str(body.program_id, 'program_id') : cur.program_id;
  if (!programId) throw badRequest('Pick the program this rule puts athletes on.');
  programs.assertAssignable(ctx, programId);
  const need = daysNeeded(ctx, programId);
  const daysMin = body.days_min !== undefined ? v.int(body.days_min, 'days_min', { min: 1, max: 7 }) : cur.days_min ?? Math.max(1, need);
  const daysMax = body.days_max !== undefined ? v.int(body.days_max, 'days_max', { min: 1, max: 7 }) : cur.days_max ?? 7;
  if (daysMax < daysMin) throw badRequest('days_max must be at least days_min.');
  if (daysMin < need) throw badRequest(`This program has ${need} training days a week, so days_min must be at least ${need}.`);
  return {
    program_id: programId,
    name: body.name !== undefined ? (v.str(body.name, 'name', { max: 80, optional: true }) || null) : cur.name ?? null,
    goals: body.goals !== undefined ? joinList(manyOf(body.goals, 'goals', Object.keys(GOALS))) : cur.goals ?? null,
    experience: body.experience !== undefined ? joinList(manyOf(body.experience, 'experience', Object.keys(EXPERIENCE))) : cur.experience ?? null,
    days_min: daysMin, days_max: daysMax,
    equipment: body.equipment !== undefined ? joinList(manyOf(body.equipment, 'equipment', Object.keys(GEAR))) : cur.equipment ?? null,
    priority: body.priority !== undefined ? v.int(body.priority, 'priority', { min: -100, max: 100 }) : cur.priority ?? 0,
    active: body.active !== undefined ? (body.active ? 1 : 0) : cur.active ?? 1
  };
}
const shapeRule = (r) => ({ ...r, goals: splitList(r.goals), goal_labels: splitList(r.goals).map((g) => GOALS[g] ?? g), experience: splitList(r.experience), experience_labels: splitList(r.experience).map((e) => EXPERIENCE[e] ?? e),
  equipment: splitList(r.equipment), equipment_labels: splitList(r.equipment).map((k) => GEAR[k] ?? k), active: !!r.active });
const RULE_SQL = `SELECT r.*, p.name AS program_name, p.weeks AS program_weeks, (SELECT COUNT(*) FROM training_profiles t WHERE t.outcome_rule_id = r.id) AS placed
  FROM program_rules r JOIN programs p ON p.id = r.program_id`;
export function listRules(ctx) {
  return ctx.db.all(`${RULE_SQL} ORDER BY r.priority DESC, r.created_at`).map(shapeRule);
}
export function createRule(ctx, body = {}) {
  const f = ruleFields(ctx, body);
  const id = newId('rule');
  ctx.db.run('INSERT INTO program_rules (id, program_id, name, goals, experience, days_min, days_max, equipment, priority, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, f.program_id, f.name, f.goals, f.experience, f.days_min, f.days_max, f.equipment, f.priority, f.active, ctx.now());
  return shapeRule(ctx.db.get(`${RULE_SQL} WHERE r.id = ?`, id));
}
export function updateRule(ctx, id, body = {}) {
  const cur = ctx.db.get('SELECT * FROM program_rules WHERE id = ?', String(id));
  if (!cur) throw notFound('Rule');
  const f = ruleFields(ctx, body, cur);
  ctx.db.run('UPDATE program_rules SET program_id = ?, name = ?, goals = ?, experience = ?, days_min = ?, days_max = ?, equipment = ?, priority = ?, active = ? WHERE id = ?',
    f.program_id, f.name, f.goals, f.experience, f.days_min, f.days_max, f.equipment, f.priority, f.active, cur.id);
  return shapeRule(ctx.db.get(`${RULE_SQL} WHERE r.id = ?`, cur.id));
}
export function deleteRule(ctx, id) {
  if (!ctx.db.get('SELECT id FROM program_rules WHERE id = ?', String(id))) throw notFound('Rule');
  ctx.db.run('DELETE FROM program_rules WHERE id = ?', String(id));
  return { id: String(id), deleted: true };
}
// Does the athlete have what the rule needs? At the facility they have everything; at home, what they listed.
function hasGear(profile, needed) {
  if (!needed.length || profile.trains_at === 'facility' || !profile.trains_at) return true;
  const have = new Set(splitList(profile.equipment));
  return needed.every((g) => have.has(g));
}
// The rule the answers fit: every condition the rule names must hold, the highest priority wins, then the one that
// names the most conditions (a rule for "speed, new, 3 days" beats one for "any goal"). Answers must say the goal,
// experience and days; the program's own days a week must fit the athlete's.
export function matchRule(ctx, profile) {
  if (!profile || !profile.goal || !profile.experience || !profile.days_per_week) return { rule: null, reason: 'unanswered' };
  const rules = ctx.db.all(`${RULE_SQL} WHERE r.active = 1 AND p.kind = 'program' ORDER BY r.priority DESC, r.created_at`);
  let best = null, bestScore = -Infinity;
  for (const r of rules) {
    const goals = splitList(r.goals), exp = splitList(r.experience), gear = splitList(r.equipment);
    if (goals.length && !goals.includes(profile.goal)) continue;
    if (exp.length && !exp.includes(profile.experience)) continue;
    if (profile.days_per_week < r.days_min || profile.days_per_week > r.days_max) continue;
    if (!hasGear(profile, gear)) continue;
    if (daysNeeded(ctx, r.program_id) > profile.days_per_week) continue;
    const score = r.priority * 10 + (goals.length ? 1 : 0) + (exp.length ? 1 : 0) + (gear.length ? 1 : 0) + (r.days_min > 1 || r.days_max < 7 ? 1 : 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return { rule: best ? shapeRule(best) : null, reason: best ? null : rules.length ? 'no_match' : 'no_rules' };
}
// "Try it" on the rules panel: which program these answers would lead to, without saving anything.
export function tryAnswers(ctx, body = {}) {
  const f = fields(body);
  const m = matchRule(ctx, f);
  return { ...m, mode: mode(ctx), program: m.rule ? { id: m.rule.program_id, name: m.rule.program_name } : null };
}

// ---------- Placing the athlete ----------
function ownerEmails(ctx) { return ctx.db.all(`SELECT email FROM users WHERE role IN ('owner') AND active = 1`).map((u) => u.email); }
function tell(ctx, subject, text) {
  for (const to of ownerEmails(ctx)) sendEmail(ctx, { to, subject, text }).catch(() => {});
}
function setOutcome(ctx, clientId, outcome, { programId = null, ruleId = null } = {}) {
  ctx.db.run('UPDATE training_profiles SET outcome = ?, outcome_program_id = ?, outcome_rule_id = ?, outcome_at = ?, seen_at = NULL WHERE client_id = ?', outcome, programId, ruleId, ctx.now(), clientId);
}
// After the answers: an athlete already on a program stays (a coach placed them); otherwise the match decides by the
// setting. Answers the outcome and, when assigned, the assignment.
export function placeAthlete(ctx, client, who = { by: 'athlete' }) {
  const c = typeof client === 'string' ? clientOf(ctx, client) : client;
  const profile = ctx.db.get('SELECT * FROM training_profiles WHERE client_id = ?', c.id);
  if (!profile) throw conflict('Answer the start-up questions first.');
  const biz = getSetting(ctx, 'business_name');
  const answers = [GOALS[profile.goal], EXPERIENCE[profile.experience], profile.days_per_week ? `${profile.days_per_week} days a week` : null, TRAINS_AT[profile.trains_at], splitList(profile.equipment).map((k) => GEAR[k] ?? k).join(', ') || null].filter(Boolean).join(' · ');
  const current = ctx.db.get('SELECT a.program_id, p.name FROM assignments a JOIN programs p ON p.id = a.program_id WHERE a.client_id = ? AND a.active = 1', c.id);
  if (current) { setOutcome(ctx, c.id, 'coach', { programId: current.program_id }); return { outcome: 'coach', program: { id: current.program_id, name: current.name } }; }
  const m = mode(ctx);
  if (m === 'off') { setOutcome(ctx, c.id, 'coach'); return { outcome: 'coach', program: null }; }
  const { rule, reason } = matchRule(ctx, profile);
  if (!rule) {
    setOutcome(ctx, c.id, 'no_match');
    tell(ctx, `${first(c.name)} needs a program`, `${c.name} answered the start-up questions${who.by === 'parent' ? ' (a parent answered)' : ''} and no start-up rule fits:\n${answers}\n\nPick a program for them on their client page (Training tab), or add a rule on the Programs page.\n\n${biz}`);
    return { outcome: 'no_match', reason, program: null };
  }
  const program = { id: rule.program_id, name: rule.program_name };
  if (m === 'review') {
    setOutcome(ctx, c.id, 'suggested', { programId: rule.program_id, ruleId: rule.id });
    tell(ctx, `${first(c.name)} is ready for ${rule.program_name}`, `${c.name} answered the start-up questions:\n${answers}\n\nThe rule "${rule.name ?? rule.program_name}" suggests ${rule.program_name}. Approve it on Today or the client page.\n\n${biz}`);
    return { outcome: 'suggested', program, rule: { id: rule.id, name: rule.name } };
  }
  const days = profile.training_days ? parseDays(profile.training_days) : defaultDays(profile.days_per_week);
  const need = daysNeeded(ctx, rule.program_id);
  const trainingDays = days.length >= need ? days : defaultDays(Math.max(need, profile.days_per_week));
  const a = programs.assign(ctx, rule.program_id, c.id, localToday(ctx), { training_days: trainingDays });
  setOutcome(ctx, c.id, 'assigned', { programId: rule.program_id, ruleId: rule.id });
  emit(ctx, 'program.auto_assigned', { assignment_id: a.id, client_id: c.id, client_name: c.name, program_id: rule.program_id, program_name: rule.program_name, rule_id: rule.id, rule_name: rule.name, by: who.by, start_date: a.start_date, training_days: a.training_days });
  tell(ctx, `${first(c.name)} started ${rule.program_name} on their own`, `${c.name} answered the start-up questions${who.by === 'parent' ? ' (a parent answered)' : ''}:\n${answers}\n\nThe rule "${rule.name ?? rule.program_name}" put them on ${rule.program_name}, starting ${a.start_date}. Their first workout is in the app now. You can switch them from their client page (Training tab).\n\n${biz}`);
  return { outcome: 'assigned', program, rule: { id: rule.id, name: rule.name }, assignment: a };
}
// A coach approves a suggested program from Today or the client page (review mode), or asks for the match again.
export function approve(ctx, clientId, user) {
  const c = clientOf(ctx, clientId);
  const p = ctx.db.get('SELECT * FROM training_profiles WHERE client_id = ?', c.id);
  if (!p) throw conflict(`${first(c.name)} hasn't answered the start-up questions.`);
  if (ctx.db.get('SELECT id FROM assignments WHERE client_id = ? AND active = 1', c.id)) throw conflict(`${first(c.name)} is already on a program.`);
  const programId = p.outcome_program_id ?? matchRule(ctx, p).rule?.program_id;
  if (!programId) throw conflict('No start-up rule fits their answers. Assign a program by hand.');
  const days = p.training_days ? parseDays(p.training_days) : defaultDays(p.days_per_week ?? 3);
  const need = daysNeeded(ctx, programId);
  const a = programs.assign(ctx, programId, c.id, localToday(ctx), { training_days: days.length >= need ? days : defaultDays(Math.max(need, p.days_per_week ?? need)) });
  setOutcome(ctx, c.id, 'assigned', { programId, ruleId: p.outcome_rule_id });
  ctx.db.run('UPDATE training_profiles SET seen_at = ? WHERE client_id = ?', ctx.now(), c.id);
  emit(ctx, 'program.auto_assigned', { assignment_id: a.id, client_id: c.id, client_name: c.name, program_id: programId, program_name: ctx.db.get('SELECT name FROM programs WHERE id = ?', programId)?.name, rule_id: p.outcome_rule_id, by: 'coach', approved_by: user?.name ?? null, start_date: a.start_date, training_days: a.training_days });
  return { outcome: 'assigned', assignment: a };
}
// Got it: the Today item goes away.
export function markSeen(ctx, clientId) {
  clientOf(ctx, clientId);
  ctx.db.run('UPDATE training_profiles SET seen_at = ? WHERE client_id = ?', ctx.now(), String(clientId));
  return { client_id: String(clientId), seen: true };
}
// Today (owners and coaches): athletes who started on their own in the last week (until Got it), and athletes whose
// answers wait on a coach (a suggestion to approve, or nothing fits), without a program yet.
export function waiting(ctx) {
  const since = new Date(Date.parse(ctx.now()) - 7 * 86400000).toISOString();
  const rows = ctx.db.all(`SELECT t.client_id, c.name, t.outcome, t.outcome_at, t.goal, t.experience, t.days_per_week, t.trains_at, t.answered_by, p.name AS program_name, p.id AS program_id,
      EXISTS (SELECT 1 FROM assignments a WHERE a.client_id = t.client_id AND a.active = 1) AS on_program
    FROM training_profiles t JOIN clients c ON c.id = t.client_id LEFT JOIN programs p ON p.id = t.outcome_program_id
    WHERE c.archived_at IS NULL AND t.seen_at IS NULL AND t.outcome IS NOT NULL AND t.outcome != 'coach' ORDER BY t.outcome_at DESC`);
  return rows.filter((r) => (r.outcome === 'assigned' ? r.outcome_at >= since : !r.on_program))
    .map((r) => ({ client_id: r.client_id, name: r.name, outcome: r.outcome, at: r.outcome_at, program_id: r.program_id, program_name: r.program_name, by: r.answered_by,
      answers: [GOALS[r.goal], EXPERIENCE[r.experience], r.days_per_week ? `${r.days_per_week} days a week` : null, TRAINS_AT[r.trains_at]].filter(Boolean).join(' · ') }));
}

// ---------- The gear: swaps for what the athlete has ----------
// Does the equipment profile apply right now? At home always; both: when the app says they're at home today.
function gearApplies(profile, at) {
  if (!profile || profile.equipment == null) return false;
  if (profile.trains_at === 'home') return true;
  return profile.trains_at === 'both' && at === 'home';
}
const needs = (exercise) => splitList(exercise.equipment).filter((g) => !NO_GEAR.has(g));
// For one unlogged workout: every slot whose exercise needs gear the athlete lacks gets the first listed alternative
// that fits what they have (preferring swaps tagged no_equipment, at_home or no_barbell), unless a swap is already
// there or the athlete put this slot back. Answers the swaps map again with the new rows in it.
export function equipmentSwaps(ctx, clientId, workout, swaps, { at = null } = {}) {
  const profile = ctx.db.get('SELECT trains_at, equipment FROM training_profiles WHERE client_id = ?', clientId);
  if (!gearApplies(profile, at)) return swaps;
  const have = new Set(splitList(profile.equipment));
  const optouts = new Set(ctx.db.all('SELECT workout_exercise_id FROM swap_optouts WHERE client_id = ?', clientId).map((r) => r.workout_exercise_id));
  const client = ctx.db.get('SELECT id, name FROM clients WHERE id = ?', clientId);
  let changed = false;
  for (const x of workout.exercises) {
    if (swaps?.get(x.id) || optouts.has(x.id)) continue;
    const ex = ctx.db.get('SELECT id, name, equipment FROM exercises WHERE id = ?', x.exercise_id);
    const missing = needs(ex ?? {}).filter((g) => !have.has(g));
    if (!missing.length) continue;
    const alts = ctx.db.all(`SELECT a.tag, e.id, e.name, e.equipment FROM exercise_alternatives a JOIN exercises e ON e.id = a.alt_exercise_id WHERE a.exercise_id = ? ORDER BY CASE a.tag WHEN 'no_equipment' THEN 0 WHEN 'at_home' THEN 1 WHEN 'no_barbell' THEN 2 ELSE 3 END, e.name COLLATE NOCASE`, x.exercise_id)
      .filter((a) => needs(a).every((g) => have.has(g)));
    if (!alts.length) continue;
    const gearText = missing.map((g) => GEAR_WORDS[g] ?? g).join(' or ');
    insertSwaps(ctx, { client, slotIds: [x.id], to: { id: alts[0].id, name: alts[0].name }, insteadOf: ex.name, reason: `No ${gearText} at home`, by: null, byKind: 'equipment', scope: 'workout' });
    changed = true;
  }
  return changed ? programs.swapsFor(ctx, clientId, workout.id) : swaps;
}
// The athlete puts the plan's exercise back: the swap goes and the slot is remembered, so it isn't swapped again.
export function optOut(ctx, clientId, swapId) {
  const sw = ctx.db.get('SELECT id, workout_exercise_id FROM exercise_swaps WHERE id = ? AND client_id = ? AND by_kind = ?', String(swapId), clientId, 'equipment');
  if (!sw) return false;
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM exercise_swaps WHERE id = ?', sw.id);
    ctx.db.run('INSERT OR IGNORE INTO swap_optouts (client_id, workout_exercise_id, created_at) VALUES (?, ?, ?)', clientId, sw.workout_exercise_id, ctx.now());
  });
  return true;
}
// The family export and deletion.
export const forExport = (ctx, clientId) => {
  const r = ctx.db.get('SELECT goal, sport, experience, days_per_week, training_days, trains_at, equipment, note, answered_by, answered_at, updated_at, outcome, outcome_at FROM training_profiles WHERE client_id = ?', clientId);
  return r ? { ...r, equipment: r.equipment == null ? null : splitList(r.equipment).filter((k) => k !== 'bodyweight') } : null;
};
export function forgetClient(ctx, clientId) {
  ctx.db.run('DELETE FROM training_profiles WHERE client_id = ?', clientId);
  ctx.db.run('DELETE FROM swap_optouts WHERE client_id = ?', clientId);
}
