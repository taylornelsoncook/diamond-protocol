import { v, badRequest } from '../util.js';
import { parentFilter } from './performance.js';
import { LOAD_TESTS } from './programs.js';
import { KINDS as SPRINT_KINDS, list as sprintList } from './sprint.js';

// One athlete's timeline (the builder redesign, step 5; owner's ask: "everything they complete blends into their
// profile"): everything the athlete did, newest first, one line each, read from the tables that already hold it.
// Nothing is stored. Views: 'staff' (the client page; purchases carry the amount only for the owner, `money`),
// 'family' (the parent portal: test results only once the testing day is shared, like every parent screen) and
// 'athlete' (the app's Profile tab, the same as the family's).
export const KINDS = {
  workout: 'Workouts', result: 'Test results', max: 'Maxes', sprint: 'Sprint reps', form_check: 'Form checks', checkin: 'Check-ins',
  attendance: 'Sessions', badge: 'Badges', reading: 'Reading', step: 'Steps up', purchase: 'Purchases'
};
const MAX_EACH = 400;         // rows read per source; the merge keeps the newest
const num = (x, d = 2) => (x == null ? '' : Number(x).toFixed(d).replace(/\.?0+$/, ''));
const outOf = (x) => (x == null ? null : `${x}/5`);

export function timelineFor(ctx, clientId, { kind = null, before = null, limit = 40, view = 'staff', money = false } = {}) {
  const id = v.str(clientId, 'client_id');
  if (kind && !KINDS[kind]) throw badRequest(`kind must be one of: ${Object.keys(KINDS).join(', ')}.`);
  const n = Math.min(200, Math.max(1, Number(limit) || 40));
  const items = [];
  const push = (it) => { if (it.at) items.push(it); };
  const want = (k) => !kind || kind === k;

  if (want('workout')) {
    for (const l of ctx.db.all(`SELECT l.id, l.completed_at, l.rpe, l.started_at, COALESCE(w.title, l.workout_title) AS title, COALESCE(p.name, l.program_name) AS program,
        COALESCE(w.week, l.workout_week) AS week, COALESCE(w.day, l.workout_day) AS day, l.session_id,
        (SELECT COUNT(*) FROM workout_sets s WHERE s.workout_log_id = l.id) AS sets
      FROM workout_logs l LEFT JOIN workouts w ON w.id = l.workout_id LEFT JOIN programs p ON p.id = COALESCE(w.program_id, l.program_id)
      WHERE l.client_id = ? ORDER BY l.completed_at DESC LIMIT ?`, id, MAX_EACH)) {
      const mins = l.started_at ? Math.round((Date.parse(l.completed_at) - Date.parse(l.started_at)) / 60000) : null;
      push({ at: l.completed_at, kind: 'workout', text: `Logged ${l.title ?? 'a workout'}`,
        detail: [l.program ? `${l.program}${l.week ? ` · week ${l.week}, day ${l.day}` : ''}` : null, l.sets ? `${l.sets} ${l.sets === 1 ? 'set' : 'sets'}` : null, mins && mins > 0 && mins <= 240 ? `${mins} min` : null, l.rpe ? `effort ${l.rpe}/10` : null, l.session_id ? 'on the weight-room screen' : null].filter(Boolean).join(' · '),
        ref: { log_id: l.id } });
    }
  }
  if (want('result') || want('max')) {
    const scope = view === 'staff' ? '' : parentFilter(ctx);
    const rows = ctx.db.all(`SELECT r.id, r.test_id, r.metric, r.value, r.recorded_at, r.session_id, r.source, r.device, r.side, t.key AS test_key, t.name AS test_name, m.name AS metric_name, m.unit, m.better, m.decimals, s.name AS day_name,
        (SELECT mm.key FROM perf_metrics mm WHERE mm.test_id = r.test_id ORDER BY mm.sort, mm.key LIMIT 1) AS primary_key
      FROM perf_results r JOIN perf_tests t ON t.id = r.test_id JOIN perf_metrics m ON m.test_id = r.test_id AND m.key = r.metric LEFT JOIN perf_sessions s ON s.id = r.session_id
      WHERE r.client_id = ? AND r.voided = 0 ${scope} ORDER BY r.recorded_at DESC LIMIT ?`, id, MAX_EACH);
    // One line per test, metric and day: the best attempt of the day.
    const seen = new Map();
    for (const r of rows) {
      const typed = !r.session_id && ['athlete', 'parent', 'coach'].includes(r.source) && LOAD_TESTS[r.test_key];
      const key = `${r.test_id}|${r.metric}|${r.side ?? ''}|${r.recorded_at.slice(0, 10)}|${typed ? 'max' : 'result'}`;
      const cur = seen.get(key);
      if (cur && (r.better === 'lower' ? r.value >= cur.value : r.value <= cur.value)) { cur.attempts += 1; continue; }
      seen.set(key, { ...r, attempts: (cur?.attempts ?? 0) + 1, typed });
    }
    for (const r of seen.values()) {
      const value = `${num(r.value, r.decimals ?? 2)} ${r.unit}`;
      if (r.typed) { if (want('max')) push({ at: r.recorded_at, kind: 'max', text: `New max: ${LOAD_TESTS[r.test_key]} ${value}`, detail: r.source === 'coach' ? `Entered by ${(r.device ?? '').replace(/^coach:\s*/, '') || 'a coach'}` : r.source === 'parent' ? 'Entered by a parent' : 'Entered in the app', ref: { result_id: r.id, test: r.test_key } }); }
      else if (want('result')) push({ at: r.recorded_at, kind: 'result', text: `${r.test_name}${r.metric !== r.primary_key ? `, ${r.metric_name.toLowerCase()}` : ''}${r.side ? ` (${r.side})` : ''}: ${value}`,
        detail: [r.day_name ? `Testing day: ${r.day_name}` : null, r.attempts > 1 ? `best of ${r.attempts}` : null].filter(Boolean).join(' · '), ref: { result_id: r.id, test: r.test_key, session_id: r.session_id } });
    }
  }
  if (want('sprint')) {
    for (const c of sprintList(ctx, { clientId: id, limit: MAX_EACH, athleteView: view !== 'staff' })) {
      const what = `${SPRINT_KINDS[c.kind]?.label ?? c.kind}${c.segment ? ` · ${c.segment} yd` : ''}`;
      if (c.reviewed_at) push({ at: c.reviewed_at, kind: 'sprint', text: `Sprint rep graded${c.grade ? ` ${c.grade}` : ''}: ${what}`, detail: [c.reviewed_by_name ? `By ${c.reviewed_by_name}` : null, c.timing?.contact_s ? `contact ${num(c.timing.contact_s, 3)} s` : null].filter(Boolean).join(' · '), ref: { clip_id: c.id } });
      if (c.sent_at) push({ at: c.sent_at, kind: 'sprint', text: `Sprint rep sent: ${what}`, detail: c.uploaded_by_name && c.uploaded_by_kind === 'staff' ? `Filmed by ${c.uploaded_by_name}` : '', ref: { clip_id: c.id } });
    }
  }
  if (want('form_check')) {
    for (const f of ctx.db.all(`SELECT id, exercise_name, workout_title, sent_at, answered_at, coach_name, reply FROM form_checks WHERE client_id = ? AND status IN ('sent', 'answered') ORDER BY sent_at DESC LIMIT ?`, id, MAX_EACH)) {
      if (f.answered_at) push({ at: f.answered_at, kind: 'form_check', text: `Form check answered: ${f.exercise_name}`, detail: [f.coach_name ? `By ${f.coach_name}` : null, f.reply ? f.reply.slice(0, 120) : null].filter(Boolean).join(' · '), ref: { form_check_id: f.id } });
      push({ at: f.sent_at, kind: 'form_check', text: `Form check sent: ${f.exercise_name}`, detail: f.workout_title ?? '', ref: { form_check_id: f.id } });
    }
  }
  if (want('checkin')) {
    for (const c of ctx.db.all(`SELECT date, sleep_hours, hydration, soreness, energy, mood, created_at FROM daily_checkins WHERE client_id = ? ORDER BY date DESC LIMIT ?`, id, MAX_EACH)) {
      push({ at: c.created_at, day: c.date, kind: 'checkin', text: 'Checked in', detail: [c.sleep_hours != null ? `${num(c.sleep_hours, 1)} h sleep` : null, c.energy ? `energy ${outOf(c.energy)}` : null, c.soreness ? `soreness ${outOf(c.soreness)}` : null, c.mood ? `mood ${outOf(c.mood)}` : null].filter(Boolean).join(' · '), ref: { date: c.date } });
    }
  }
  if (want('attendance')) {
    for (const b of ctx.db.all(`SELECT b.id, s.name, s.starts_at, s.kind FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.client_id = ? AND b.status = 'attended' ORDER BY s.starts_at DESC LIMIT ?`, id, MAX_EACH)) push({ at: b.starts_at, kind: 'attendance', text: `Attended ${b.name}`, detail: '', ref: { session_id: b.id } });
    for (const t of ctx.db.all(`SELECT s.id, s.name, s.starts_at FROM team_attendance a JOIN class_sessions s ON s.id = a.session_id WHERE a.client_id = ? ORDER BY s.starts_at DESC LIMIT ?`, id, MAX_EACH)) push({ at: t.starts_at, kind: 'attendance', text: `Attended ${t.name}`, detail: 'Team session', ref: { session_id: t.id } });
    for (const c of ctx.db.all(`SELECT c.created_at, l.name AS place FROM check_ins c JOIN locations l ON l.id = c.location_id WHERE c.client_id = ? ORDER BY c.created_at DESC LIMIT ?`, id, MAX_EACH)) push({ at: c.created_at, kind: 'attendance', text: `Checked in at ${c.place}`, detail: '', ref: {} });
  }
  if (want('badge')) {
    for (const b of ctx.db.all(`SELECT a.awarded_at, a.note, a.awarded_by, s.name FROM badge_awards a JOIN skill_badges s ON s.id = a.badge_id WHERE a.client_id = ? ORDER BY a.awarded_at DESC LIMIT ?`, id, MAX_EACH)) push({ at: b.awarded_at, kind: 'badge', text: `Badge earned: ${b.name}`, detail: [b.awarded_by ? `From ${b.awarded_by}` : null, b.note].filter(Boolean).join(' · '), ref: {} });
  }
  if (want('reading')) {
    for (const l of ctx.db.all(`SELECT p.completed_at, l.id, l.title, c.title AS course FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id LEFT JOIN courses c ON c.id = l.course_id WHERE p.client_id = ? ORDER BY p.completed_at DESC LIMIT ?`, id, MAX_EACH)) push({ at: l.completed_at, kind: 'reading', text: `Finished reading: ${l.title}`, detail: l.course ? `In ${l.course}` : '', ref: { lesson_id: l.id } });
    for (const c of ctx.db.all(`SELECT cc.issued_at, c.title FROM course_certificates cc JOIN courses c ON c.id = cc.course_id WHERE cc.client_id = ? ORDER BY cc.issued_at DESC LIMIT ?`, id, MAX_EACH)) push({ at: c.issued_at, kind: 'reading', text: `Course finished: ${c.title}`, detail: 'Certificate issued', ref: {} });
  }
  if (want('step')) {
    for (const s of ctx.db.all(`SELECT p.decided_at, p.kind, p.amount, p.decided_by, e.name FROM progressions p JOIN exercises e ON e.id = p.exercise_id WHERE p.client_id = ? AND p.status = 'approved' ORDER BY p.decided_at DESC LIMIT ?`, id, MAX_EACH)) {
      const amt = `${s.amount > 0 ? '+' : ''}${num(s.amount)} ${s.kind === 'weight' ? 'lb' : s.kind}`;
      push({ at: s.decided_at, kind: 'step', text: `Step up on ${s.name}: ${amt}`, detail: s.decided_by === 'automatic' ? 'Approved automatically' : s.decided_by ? `Approved by ${s.decided_by}` : '', ref: {} });
    }
  }
  if (want('purchase')) {
    for (const p of ctx.db.all(`SELECT id, item_kind, title, amount_cents, status, created_at, trial_ends_at FROM purchases WHERE client_id = ? AND status != 'canceled' ORDER BY created_at DESC LIMIT ?`, id, MAX_EACH)) {
      push({ at: p.created_at, kind: 'purchase', text: `${p.status === 'trial' ? 'Started a trial of' : 'Bought'} ${p.title}`, detail: [p.item_kind === 'course' ? 'Course' : 'Program', money ? `$${(p.amount_cents / 100).toFixed(2).replace(/\.00$/, '')}` : null, p.status === 'refunded' ? 'refunded' : null].filter(Boolean).join(' · '), ref: { purchase_id: p.id } });
    }
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const from = before ? items.filter((i) => i.at < String(before)) : items;
  const page = from.slice(0, n + 1);
  const more = page.length > n;
  return { data: page.slice(0, n), next: more ? page[n - 1].at : null, kinds: Object.entries(KINDS).map(([key, label]) => ({ key, label })) };
}
