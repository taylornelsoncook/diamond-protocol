// Testing & results: testing days, stopwatch/typed entry, uploads, device and API ingest,
// results waiting to be linked, the test library and athlete progress (staff and parent).
'use strict';
const { all, get, run, insert, update, tx, setting, setSetting } = require('../db');
const { h, bad, notFound, HttpError, log, sendEmail, businessName, appUrl, today } = require('../lib');
const { requireStaff, requireParent, requireApiKey } = require('../auth');
const core = require('../services/testing-core');
const sheet = require('../services/testing-sheet');
const upload = require('../services/testing-upload');
const hawkin = require('../services/testing-hawkin');

const STAFF = requireStaff();
const OC = requireStaff('owner', 'coach');
const OWNER = requireStaff('owner');
const ids = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const TEST_COLS = 'id, name, category, unit, lower_better, attempts, min_value, max_value, timed, hidden, custom';

// Schema upgrade: the highest result id at the moment a day was shared, so "added since sharing" is exact.
if (!all('PRAGMA table_info(testing_days)').some((c) => c.name === 'shared_result_id')) run('ALTER TABLE testing_days ADD COLUMN shared_result_id INTEGER');

const validDate = (s) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const t = new Date(s + 'T12:00:00Z'); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s; };
const dayName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
// Results on this day added after it was shared (by id; older databases fall back to the recorded time).
const NEW_SINCE_SHARE = "(r.id > d.shared_result_id OR (d.shared_result_id IS NULL AND r.recorded_at > replace(substr(d.shared_at,1,19),'T',' ')))";

function dayOr404(id) {
  const d = get('SELECT * FROM testing_days WHERE id=?', Number(id));
  if (!d) throw notFound('That testing day');
  return d;
}
function dayTests(dayId) {
  return all(`SELECT ${TEST_COLS.split(', ').map((c) => 't.' + c).join(', ')} FROM testing_day_tests x JOIN tests t ON t.id=x.test_id WHERE x.day_id=? ORDER BY x.ord, t.id`, dayId);
}
// Each athlete's best on each of the day's tests from before this day (for PR context on the day).
function prevBests(d, athleteId = null) {
  return all(`SELECT r.athlete_id, r.test_id, CASE WHEN t.lower_better THEN MIN(r.value) ELSE MAX(r.value) END AS best
    FROM results r JOIN tests t ON t.id=r.test_id JOIN testing_day_tests xt ON xt.day_id=? AND xt.test_id=r.test_id
    LEFT JOIN testing_days od ON od.id=r.day_id
    WHERE (r.day_id IS NULL OR r.day_id != ?) AND COALESCE(od.date, substr(r.recorded_at,1,10)) <= ?
      AND ${athleteId ? 'r.athlete_id=?' : 'r.athlete_id IN (SELECT athlete_id FROM testing_day_athletes WHERE day_id=?)'}
    GROUP BY r.athlete_id, r.test_id`, d.id, d.id, d.date, athleteId || d.id);
}
function pendingSummary() {
  const r = get('SELECT COUNT(*) AS n, COUNT(DISTINCT source || char(0) || sender_key) AS senders FROM pending_results');
  return { count: r.n, senders: r.senders };
}

// Rows for a results sheet: Athlete ID, Name, then one column per test per attempt.
function sheetRows(athletes, tests, results = []) {
  const header = ['Athlete ID', 'Name'];
  const cols = [];
  for (const t of tests) for (let i = 1; i <= Math.max(1, t.attempts || 1); i++) { header.push(`${t.name} (${t.unit}) #${i}`); cols.push([t.id, i]); }
  const val = new Map(results.map((r) => [`${r.athlete_id}|${r.test_id}|${r.attempt}`, r.value]));
  return [header, ...athletes.map((a) => [a.code, `${a.first_name} ${a.last_name}`, ...cols.map(([tid, n]) => val.get(`${a.id}|${tid}|${n}`) ?? '')])];
}

async function readUploadBody(b) {
  if (b.file_base64) {
    const buf = Buffer.from(String(b.file_base64), 'base64');
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      try { return sheet.fromXLSX(buf); } catch { throw bad("That Excel file couldn't be read. Save it as .xlsx or CSV and try again."); }
    }
    return sheet.parseCSV(buf.toString('utf8'));
  }
  if (typeof b.text === 'string' && b.text.trim()) return sheet.parseCSV(b.text);
  throw bad('Choose a file or paste rows from your spreadsheet.');
}

// opts.athleteIds limits the emails to those athletes (emailing again after late results); opts.emit=false skips webhooks.
function shareDay(day, note, req, opts = {}) {
  const only = opts.athleteIds ? new Set(opts.athleteIds) : null;
  const results = all(`SELECT r.*, t.name AS test, t.unit, t.lower_better, a.first_name, a.last_name, a.code, a.family_id
    FROM results r JOIN tests t ON t.id=r.test_id JOIN athletes a ON a.id=r.athlete_id WHERE r.day_id=? ORDER BY a.last_name, a.first_name, t.id, r.attempt`, day.id)
    .filter((r) => !only || only.has(r.athlete_id));
  const byAthlete = new Map();
  for (const r of results) {
    if (!byAthlete.has(r.athlete_id)) byAthlete.set(r.athlete_id, { a: r, tests: new Map() });
    const g = byAthlete.get(r.athlete_id);
    const cur = g.tests.get(r.test_id);
    if (!cur || core.better({ lower_better: r.lower_better }, r.value, cur.value)) g.tests.set(r.test_id, r);
  }
  let emails = 0;
  tx(() => {
    const maxId = get('SELECT MAX(id) AS m FROM results WHERE day_id=?', day.id)?.m ?? null;
    update('testing_days', day.id, { status: 'shared', shared_at: new Date().toISOString(), note: note || null, shared_result_id: maxId });
    for (const { a, tests } of byAthlete.values()) {
      const lines = [];
      for (const r of tests.values()) {
        const prior = get(`SELECT ${r.lower_better ? 'MIN' : 'MAX'}(r.value) AS v FROM results r LEFT JOIN testing_days d ON d.id=r.day_id
          WHERE r.athlete_id=? AND r.test_id=? AND (r.day_id IS NULL OR r.day_id != ?) AND COALESCE(d.date, substr(r.recorded_at,1,10)) < ?`, a.athlete_id, r.test_id, day.id, day.date)?.v;
        const pr = prior != null && core.better(r, r.value, prior);
        lines.push(`${r.test}: ${core.fmtValue(r.value, r.unit)}${r.hand_timed && r.unit === 's' ? ' (hand-timed)' : ''}${pr ? ', new PR' : ''}`);
        if (opts.emit !== false) core.emitResult({ id: a.athlete_id, code: a.code, first_name: a.first_name, last_name: a.last_name }, { id: r.test_id, name: r.test, unit: r.unit }, r, pr);
      }
      if (!a.family_id) continue;
      for (const p of all('SELECT name, email FROM parents WHERE family_id=?', a.family_id)) {
        const body = `Hi ${p.name.split(' ')[0]},\n\n${a.first_name}'s results from ${day.name} (${fmtDay(day.date)}) are ready.\n\n`
          + (note ? `From your coach:\n${note}\n\n` : '')
          + lines.join('\n')
          + `\n\nSee ${a.first_name}'s progress, PRs and the printable report in the parent portal:\n${appUrl()}/parent\n\n${businessName()}`;
        sendEmail(p.email, `${a.first_name}'s results from ${day.name}`, body);
        emails++;
      }
    }
  });
  log(req, only ? 'Emailed families again' : 'Shared testing day', `${day.name}: ${byAthlete.size} athletes, ${emails} emails`);
  return { athletes: byAthlete.size, emails };
}

function routes(api) {
  // ---- overview ----
  api.get('/testing', STAFF, (_req, res) => {
    const days = all(`SELECT d.*, (SELECT COUNT(*) FROM testing_day_athletes x WHERE x.day_id=d.id) AS athletes,
        (SELECT COUNT(*) FROM testing_day_tests x WHERE x.day_id=d.id) AS tests, (SELECT COUNT(*) FROM results r WHERE r.day_id=d.id) AS results,
        (SELECT COUNT(DISTINCT r.athlete_id || '|' || r.test_id) FROM results r JOIN testing_day_tests xt ON xt.day_id=r.day_id AND xt.test_id=r.test_id WHERE r.day_id=d.id) AS done,
        tc.team_name FROM testing_days d LEFT JOIN team_contracts tc ON tc.id=d.team_id ORDER BY d.date DESC, d.id DESC`);
    res.json({ days, pending: pendingSummary() });
  });

  api.get('/testing/options', STAFF, (_req, res) => {
    res.json({
      athletes: all('SELECT id, code, first_name, last_name, team_id, sport FROM athletes WHERE archived=0 ORDER BY first_name, last_name'),
      teams: all("SELECT t.id, t.team_name, s.name AS school, (SELECT COUNT(*) FROM athletes a WHERE a.team_id=t.id AND a.archived=0) AS athletes FROM team_contracts t JOIN schools s ON s.id=t.school_id WHERE t.status='active' ORDER BY t.team_name"),
      tests: all(`SELECT ${TEST_COLS} FROM tests WHERE hidden=0 ORDER BY id`),
      presets: setting('presets', {}),
      days: all("SELECT id, name, date, status FROM testing_days ORDER BY date DESC, id DESC LIMIT 100"),
    });
  });

  // ---- test library ----
  api.get('/tests', STAFF, (req, res) => {
    res.json(all(`SELECT ${TEST_COLS} FROM tests ${req.query.all ? '' : 'WHERE hidden=0'} ORDER BY id`));
  });
  api.post('/tests', OC, h(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw bad('Name the test.');
    if (get('SELECT 1 FROM tests WHERE name=? COLLATE NOCASE', name)) throw bad('A test with that name already exists.');
    const unit = String(b.unit || '').trim();
    if (!unit || unit.length > 12) throw bad('Give the unit, like s, in, lb or reps.');
    const min = b.min_value === '' || b.min_value == null ? null : Number(b.min_value);
    const max = b.max_value === '' || b.max_value == null ? null : Number(b.max_value);
    if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max)) || (min != null && max != null && min >= max)) throw bad('The lowest possible value has to be below the highest.');
    const attempts = Math.min(10, Math.max(1, Number(b.attempts) || 1));
    const id = insert('tests', { name, category: String(b.category || 'Custom').trim() || 'Custom', unit, lower_better: b.lower_better === true || b.lower_better === '1' || b.lower_better === 1 ? 1 : 0,
      attempts, min_value: min, max_value: max, timed: unit === 's' && (b.timed === true || b.timed === '1' || b.timed === 1) ? 1 : 0, custom: 1 });
    log(req, 'Added test', name);
    res.json(get(`SELECT ${TEST_COLS} FROM tests WHERE id=?`, id));
  }));
  api.patch('/tests/:id', OC, h(async (req, res) => {
    const t = get('SELECT * FROM tests WHERE id=?', Number(req.params.id));
    if (!t) throw notFound('That test');
    if ('hidden' in req.body) {
      update('tests', t.id, { hidden: req.body.hidden ? 1 : 0 });
      log(req, req.body.hidden ? 'Hid test' : 'Showed test', t.name);
    }
    res.json(get(`SELECT ${TEST_COLS} FROM tests WHERE id=?`, t.id));
  }));

  // ---- testing days ----
  api.post('/testing/days', OC, h(async (req, res) => {
    const b = req.body || {};
    const name = dayName(b.name) || 'Testing day';
    const date = String(b.date || today());
    if (!validDate(date)) throw bad('Pick the date.');
    const teamId = Number(b.team_id) || null;
    if (teamId && !get('SELECT 1 FROM team_contracts WHERE id=?', teamId)) throw bad('That team no longer exists.');
    const testIds = ids(b.test_ids).filter((id) => get('SELECT 1 FROM tests WHERE id=?', id));
    if (!testIds.length) throw bad('Pick at least one test.');
    const athleteIds = new Set(ids(b.athlete_ids).filter((id) => get('SELECT 1 FROM athletes WHERE id=? AND archived=0', id)));
    if (teamId) for (const a of all('SELECT id FROM athletes WHERE team_id=? AND archived=0', teamId)) athleteIds.add(a.id);
    const id = tx(() => {
      const id = insert('testing_days', { name, date, team_id: teamId, preset: b.preset || null, status: 'open', created_by: req.staff.id });
      testIds.forEach((tid, i) => insert('testing_day_tests', { day_id: id, test_id: tid, ord: i + 1 }));
      for (const aid of athleteIds) insert('testing_day_athletes', { day_id: id, athlete_id: aid });
      return id;
    });
    log(req, 'Started testing day', `${name} (${athleteIds.size} athletes, ${testIds.length} tests)`);
    res.json({ id });
  }));

  api.get('/testing/days/:id', STAFF, (req, res) => {
    const d = dayOr404(req.params.id);
    const athletes = all(`SELECT a.id, a.code, a.first_name, a.last_name FROM testing_day_athletes x JOIN athletes a ON a.id=x.athlete_id
      WHERE x.day_id=? ORDER BY a.first_name, a.last_name`, d.id);
    const results = all('SELECT id, athlete_id, test_id, attempt, value, unit_entered, hand_timed, source FROM results WHERE day_id=? ORDER BY attempt', d.id);
    const team = d.team_id ? get('SELECT team_name FROM team_contracts WHERE id=?', d.team_id) : null;
    const newSince = d.status === 'shared' ? get(`SELECT COUNT(DISTINCT r.athlete_id) AS n FROM results r JOIN testing_days d ON d.id=r.day_id WHERE r.day_id=? AND ${NEW_SINCE_SHARE}`, d.id).n : 0;
    res.json({ day: { ...d, team_name: team?.team_name || null, new_since_share: newSince }, tests: dayTests(d.id), athletes, results, prev: prevBests(d), pending: pendingSummary() });
  });

  // Rename or re-date a day.
  api.patch('/testing/days/:id', OC, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const b = req.body || {};
    const patch = {};
    if ('name' in b) { patch.name = dayName(b.name); if (!patch.name) throw bad('Name the testing day.'); }
    if ('date' in b) { patch.date = String(b.date || ''); if (!validDate(patch.date)) throw bad('Pick the date.'); }
    if (!Object.keys(patch).length) throw bad('Nothing to change.');
    update('testing_days', d.id, patch);
    log(req, 'Updated testing day', `${patch.name || d.name}${patch.date && patch.date !== d.date ? `, moved to ${patch.date}` : ''}`);
    res.json({ ok: true, day: get('SELECT * FROM testing_days WHERE id=?', d.id) });
  }));

  // Delete a day made by mistake. Its results go with it, so that needs ?confirm=1; a shared day needs the owner.
  api.delete('/testing/days/:id', OC, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    if (d.status === 'shared' && req.staff.role !== 'owner') throw new HttpError(403, 'Families already have these results. Only the owner can delete a shared testing day.');
    const n = get('SELECT COUNT(*) AS n FROM results WHERE day_id=?', d.id).n;
    if (n && req.query.confirm !== '1') throw bad(`${d.name} has ${n} result${n === 1 ? '' : 's'}. Deleting the day deletes them from every profile.`, { results: n });
    tx(() => {
      run('DELETE FROM results WHERE day_id=?', d.id);
      run('DELETE FROM testing_day_tests WHERE day_id=?', d.id);
      run('DELETE FROM testing_day_athletes WHERE day_id=?', d.id);
      run('DELETE FROM testing_days WHERE id=?', d.id);
    });
    log(req, 'Deleted testing day', `${d.name} (${d.date}), ${n} result${n === 1 ? '' : 's'}`);
    res.json({ ok: true, deleted_results: n });
  }));

  api.post('/testing/days/:id/athletes', STAFF, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const a = get('SELECT id, code, first_name, last_name, archived FROM athletes WHERE id=?', Number(req.body?.athlete_id));
    if (!a) throw bad('Pick an athlete to add.');
    if (a.archived) throw bad(`${a.first_name} ${a.last_name} is archived. Restore their profile first.`);
    delete a.archived;
    run('INSERT OR IGNORE INTO testing_day_athletes (day_id, athlete_id) VALUES (?,?)', d.id, a.id);
    log(req, 'Added walk-up', `${a.first_name} ${a.last_name} to ${d.name}`);
    res.json({ ...a, prev: prevBests(d, a.id) });
  }));

  // Take an athlete off the day (added by mistake, or absent). Their results on this day need ?confirm=1.
  api.delete('/testing/days/:id/athletes/:athleteId', OC, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const a = get('SELECT id, first_name, last_name FROM athletes WHERE id=?', Number(req.params.athleteId));
    if (!a || !get('SELECT 1 FROM testing_day_athletes WHERE day_id=? AND athlete_id=?', d.id, a.id)) throw notFound('That athlete on this day');
    const n = get('SELECT COUNT(*) AS n FROM results WHERE day_id=? AND athlete_id=?', d.id, a.id).n;
    if (n && req.query.confirm !== '1') throw bad(`${a.first_name} has ${n} result${n === 1 ? '' : 's'} on this day. Removing ${a.first_name} deletes them.`, { results: n });
    tx(() => {
      run('DELETE FROM results WHERE day_id=? AND athlete_id=?', d.id, a.id);
      run('DELETE FROM testing_day_athletes WHERE day_id=? AND athlete_id=?', d.id, a.id);
    });
    log(req, 'Removed athlete from testing day', `${a.first_name} ${a.last_name} from ${d.name}${n ? `, ${n} result${n === 1 ? '' : 's'} deleted` : ''}`);
    res.json({ ok: true, deleted_results: n });
  }));

  api.post('/testing/days/:id/tests', OC, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const t = get('SELECT id, name FROM tests WHERE id=?', Number(req.body.test_id));
    if (!t) throw bad('Pick a test to add.');
    run('INSERT OR IGNORE INTO testing_day_tests (day_id, test_id, ord) VALUES (?,?,(SELECT COALESCE(MAX(ord),0)+1 FROM testing_day_tests WHERE day_id=?))', d.id, t.id, d.id);
    log(req, 'Added test to testing day', `${t.name} to ${d.name}`);
    res.json({ ok: true, test: get(`SELECT ${TEST_COLS} FROM tests WHERE id=?`, t.id), prev: prevBests(d).filter((p) => p.test_id === t.id) });
  }));

  api.delete('/testing/days/:id/tests/:testId', OC, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const t = get('SELECT id, name FROM tests WHERE id=?', Number(req.params.testId));
    if (!t || !get('SELECT 1 FROM testing_day_tests WHERE day_id=? AND test_id=?', d.id, t.id)) throw notFound('That test on this day');
    if (get('SELECT COUNT(*) AS n FROM testing_day_tests WHERE day_id=?', d.id).n <= 1) throw bad('A testing day needs at least one test. Add another before removing this one.');
    const n = get('SELECT COUNT(*) AS n FROM results WHERE day_id=? AND test_id=?', d.id, t.id).n;
    if (n && req.query.confirm !== '1') throw bad(`${t.name} has ${n} result${n === 1 ? '' : 's'} on this day. Removing the test deletes them.`, { results: n });
    tx(() => {
      run('DELETE FROM results WHERE day_id=? AND test_id=?', d.id, t.id);
      run('DELETE FROM testing_day_tests WHERE day_id=? AND test_id=?', d.id, t.id);
    });
    log(req, 'Removed test from testing day', `${t.name} from ${d.name}${n ? `, ${n} result${n === 1 ? '' : 's'} deleted` : ''}`);
    res.json({ ok: true, deleted_results: n });
  }));

  // Save (or clear) one attempt. Stopwatch times come in with source 'stopwatch' and are always hand-timed.
  api.put('/testing/days/:id/results', STAFF, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const b = req.body || {};
    const t = get('SELECT * FROM tests WHERE id=?', Number(b.test_id));
    if (!t) throw bad('That test is no longer in the library.');
    const a = get('SELECT id, first_name, last_name FROM athletes WHERE id=?', Number(b.athlete_id));
    if (!a) throw bad('That athlete no longer exists.');
    const attempt = Number(b.attempt);
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 20) throw bad('Pick an attempt.');
    const stopwatch = b.source === 'stopwatch';
    const chk = core.checkValue(t, b.value, b.unit || t.unit);
    if (chk.empty) {
      run('DELETE FROM results WHERE athlete_id=? AND test_id=? AND day_id=? AND attempt=?', a.id, t.id, d.id, attempt);
      return res.json({ cleared: true });
    }
    if (chk.error) throw bad(chk.error.replace(' Is it in the wrong column?', ''), { out_of_range: chk.value != null });
    run('INSERT OR IGNORE INTO testing_day_athletes (day_id, athlete_id) VALUES (?,?)', d.id, a.id);
    const r = core.saveResult({ athlete_id: a.id, test: t, day_id: d.id, attempt, value: chk.value, unit_entered: chk.unit || t.unit,
      hand_timed: stopwatch || (t.unit === 's' && !!b.hand_timed), source: stopwatch ? 'stopwatch' : 'manual', created_by: req.staff.id }, { req });
    const row = get('SELECT id, athlete_id, test_id, attempt, value, unit_entered, hand_timed, source FROM results WHERE id=?', r.id);
    res.json({ result: row, pr: r.pr, prev_best: r.prev_best, display: core.fmtValue(row.value, t.unit) });
  }));

  // Who sharing reaches: athletes with and without results, families and emails, and anyone with no parent email.
  api.get('/testing/days/:id/share-preview', OC, (req, res) => {
    const d = dayOr404(req.params.id);
    const rows = all(`SELECT a.id, a.first_name, a.last_name, a.family_id,
        (SELECT COUNT(*) FROM results r WHERE r.day_id=x.day_id AND r.athlete_id=a.id) AS results,
        (SELECT COUNT(*) FROM results r JOIN testing_days d ON d.id=r.day_id WHERE r.day_id=x.day_id AND r.athlete_id=a.id AND d.status='shared' AND ${NEW_SINCE_SHARE}) AS new_results,
        (SELECT COUNT(*) FROM parents p WHERE p.family_id=a.family_id AND p.email IS NOT NULL AND p.email != '') AS emails
      FROM testing_day_athletes x JOIN athletes a ON a.id=x.athlete_id WHERE x.day_id=? ORDER BY a.first_name, a.last_name`, d.id);
    const nm = (a) => `${a.first_name} ${a.last_name}`;
    const withResults = rows.filter((a) => a.results);
    const fresh = withResults.filter((a) => a.new_results);
    res.json({
      status: d.status, shared_at: d.shared_at,
      athletes: rows.length, with_results: withResults.length,
      without_results: rows.filter((a) => !a.results).map(nm),
      families: new Set(withResults.filter((a) => a.emails).map((a) => a.family_id)).size,
      emails: withResults.reduce((n, a) => n + a.emails, 0),
      no_email: withResults.filter((a) => !a.emails).map(nm),
      new_since_share: fresh.map(nm),
      new_emails: fresh.reduce((n, a) => n + a.emails, 0),
      new_families: new Set(fresh.filter((a) => a.emails).map((a) => a.family_id)).size,
    });
  });

  api.post('/testing/days/:id/share', OC, h(async (req, res) => {
    const d = dayOr404(req.params.id);
    const note = String(req.body.note ?? '').trim().slice(0, 2000);
    if (d.status === 'shared' && req.body.only_new) {
      const fresh = all(`SELECT DISTINCT r.athlete_id FROM results r JOIN testing_days d ON d.id=r.day_id WHERE r.day_id=? AND ${NEW_SINCE_SHARE}`, d.id).map((r) => r.athlete_id);
      if (!fresh.length) throw bad('No results have been added since you shared this day.');
      return res.json({ ok: true, again: true, ...shareDay(d, note, req, { athleteIds: fresh, emit: false }) });
    }
    if (d.status === 'shared' && !req.body.resend) {
      update('testing_days', d.id, { note: note || null });
      log(req, 'Updated coach note', d.name);
      return res.json({ ok: true, updated: true });
    }
    if (!get('SELECT 1 FROM results WHERE day_id=?', d.id)) throw bad('Enter some results before sharing this day.');
    res.json({ ok: true, ...shareDay(d, note, req) });
  }));

  // ---- sheets ----
  api.get('/testing/sheet', STAFF, h(async (req, res) => {
    let athletes, tests, results = [], name;
    if (req.query.day_id) {
      const d = dayOr404(req.query.day_id);
      athletes = all('SELECT a.id, a.code, a.first_name, a.last_name FROM testing_day_athletes x JOIN athletes a ON a.id=x.athlete_id WHERE x.day_id=? ORDER BY a.last_name, a.first_name', d.id);
      tests = dayTests(d.id);
      results = all('SELECT athlete_id, test_id, attempt, value FROM results WHERE day_id=?', d.id);
      name = `${d.name} ${d.date}`;
    } else {
      const presets = setting('presets', {});
      const preset = presets[req.query.preset] ? req.query.preset : Object.keys(presets)[0];
      tests = presets[preset].map((n) => get(`SELECT ${TEST_COLS} FROM tests WHERE name=?`, n)).filter(Boolean);
      const teamId = Number(req.query.team_id) || null;
      athletes = teamId ? all('SELECT id, code, first_name, last_name FROM athletes WHERE team_id=? AND archived=0 ORDER BY last_name, first_name', teamId) : [];
      const team = teamId ? get('SELECT team_name FROM team_contracts WHERE id=?', teamId) : null;
      name = `${team ? team.team_name + ' ' : ''}${preset} sheet`;
    }
    const rows = sheetRows(athletes, tests, results);
    for (let i = 0; i < 10; i++) rows.push(rows[0].map(() => '')); // blank rows for walk-ups
    const file = name.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase();
    if (req.query.format === 'xlsx') {
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${file}.xlsx"` });
      return res.send(sheet.toXLSX(rows, 'Results'));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}.csv"` });
    res.send(sheet.toCSV(rows));
  }));

  const uploadSource = (v) => { const t = String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 40); return t || null; };
  const uploadOpts = (b) => ({ day_id: b.day_id || null, date: b.date || null, test_id: b.test_id || null, filename: b.filename || '', source: uploadSource(b.source) });
  const publicCheck = (c) => { const { _items, _pending, ...rest } = c; return rest; };
  api.post('/testing/upload/check', OC, h(async (req, res) => {
    const rows = await readUploadBody(req.body || {});
    const c = upload.checkSheet(rows, uploadOpts(req.body));
    res.json(publicCheck(c));
  }));
  api.post('/testing/upload/save', OC, h(async (req, res) => {
    const rows = await readUploadBody(req.body || {});
    const c = upload.checkSheet(rows, uploadOpts(req.body));
    if (!c.ok) return res.status(400).json({ error: "This sheet can't be saved. Nothing was saved.", ...publicCheck(c) });
    const out = upload.saveSheet(c, (Array.isArray(req.body.confirmed) ? req.body.confirmed : []).map(String), req, { filename: req.body.filename });
    if (out.error) throw bad(out.error, { need: out.need });
    res.json({ ok: true, ...out });
  }));
  api.get('/testing/uploads', OC, (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    res.json(upload.recentBatches(limit));
  });
  api.post('/testing/uploads/:id/undo', OC, h(async (req, res) => {
    const out = upload.undoBatch(Number(req.params.id), req);
    if (out.notFound) throw notFound('That upload');
    if (out.error) throw bad(out.error);
    res.json({ ok: true, ...out });
  }));

  // ---- waiting to be linked ----
  api.get('/testing/pending', OC, (_req, res) => res.json(core.pendingGroups()));
  api.post('/testing/pending/link', OC, h(async (req, res) => {
    const list = ids(req.body.ids);
    if (!list.length) throw bad('Tick at least one result to link.');
    const out = core.linkPending(list, Number(req.body.athlete_id), req.body.remember !== false, req);
    if (out.error) throw bad(out.error);
    res.json({ ok: true, ...out });
  }));
  api.post('/testing/pending/discard', OC, h(async (req, res) => {
    const list = ids(req.body.ids);
    if (!list.length) throw bad('Tick the results to discard.');
    let n = 0;
    const first = get(`SELECT source, sender_label, sender_key FROM pending_results WHERE id IN (${list.map(() => '?').join(',')}) LIMIT 1`, ...list);
    tx(() => { for (const id of list) n += Number(run('DELETE FROM pending_results WHERE id=?', id).changes); });
    if (!n) throw bad('Those results were already linked or discarded.');
    log(req, 'Discarded waiting results', `${n} result${n === 1 ? '' : 's'}${first ? ` from ${first.sender_label || first.sender_key} (${first.source})` : ''}`);
    res.json({ ok: true, discarded: n });
  }));

  // ---- devices & imports ----
  api.get('/testing/devices', OC, (req, res) => {
    const token = setting('hawkin_token');
    res.json({
      pending: pendingSummary(),
      hawkin: { connected: !!token, region: setting('hawkin_region', 'Americas'), token_hint: token && req.staff.role === 'owner' ? '••••' + String(token).slice(-4) : null, status: setting('hawkin_status') },
      links: all(`SELECT l.id, l.source, l.sender_key, l.sender_label, l.created_at, a.id AS athlete_id, a.code, a.first_name, a.last_name, a.archived
        FROM device_links l JOIN athletes a ON a.id=l.athlete_id ORDER BY l.source, l.sender_key`),
      sources: [...new Set([...all('SELECT DISTINCT source FROM device_links UNION SELECT DISTINCT source FROM pending_results').map((r) => r.source), ...upload.SOURCES.filter((x) => x !== 'Import')])].filter(Boolean).sort((a, b) => a.localeCompare(b)),
      app_url: appUrl(),
    });
  });
  api.put('/testing/hawkin', OWNER, h(async (req, res) => {
    const token = String(req.body.token || '').trim();
    if (token.length < 10) throw bad('Paste the integration token from Hawkin (Settings, then Integrations).');
    setSetting('hawkin_token', token);
    setSetting('hawkin_region', ['Americas', 'Europe', 'Asia Pacific'].includes(req.body.region) ? req.body.region : 'Americas');
    setSetting('hawkin_status', { ok: true, at: new Date().toISOString(), message: 'Connected. The first sync runs within 15 minutes.' });
    log(req, 'Connected Hawkin Dynamics');
    res.json({ ok: true });
  }));
  api.delete('/testing/hawkin', OWNER, h(async (req, res) => {
    setSetting('hawkin_token', null); setSetting('hawkin_status', null);
    log(req, 'Disconnected Hawkin Dynamics');
    res.json({ ok: true });
  }));
  api.post('/testing/hawkin/sync', OWNER, h(async (_req, res) => res.json(await hawkin.sync())));
  // Link a device ID or name to an athlete ahead of time (or move a link). Anything already waiting from that
  // sender is linked to the athlete too.
  const linkAthlete = (id) => {
    const a = get('SELECT id, code, first_name, last_name, archived FROM athletes WHERE id=?', Number(id));
    if (!a) throw bad('Pick the athlete this device belongs to.');
    if (a.archived) throw bad(`${a.first_name} ${a.last_name} is archived. Pick someone else.`);
    return a;
  };
  api.post('/testing/links', OC, h(async (req, res) => {
    const source = String(req.body.source ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const key = String(req.body.sender_key ?? '').trim().slice(0, 120);
    if (!source) throw bad('Say which system the results come from, like Hawkin or Freelap.');
    if (!key) throw bad('Enter the device ID or the name the device uses for this athlete.');
    const a = linkAthlete(req.body.athlete_id);
    const label = String(req.body.sender_label ?? '').trim().slice(0, 120) || key;
    const existing = get('SELECT * FROM device_links WHERE source=? COLLATE NOCASE AND sender_key=?', source, key);
    let id;
    if (existing) { run('UPDATE device_links SET athlete_id=?, sender_label=? WHERE id=?', a.id, existing.sender_label || label, existing.id); id = existing.id; }
    else id = insert('device_links', { source, sender_key: key, sender_label: label, athlete_id: a.id });
    const waiting = all('SELECT id FROM pending_results WHERE source=? COLLATE NOCASE AND sender_key=?', source, key).map((r) => r.id);
    const linked = waiting.length ? core.linkPending(waiting, a.id, false, req) : { linked: 0, prs: 0 };
    log(req, existing ? 'Moved device link' : 'Linked device', `${label} (${source}) to ${a.first_name} ${a.last_name}`);
    res.json({ ok: true, id, moved: !!existing && existing.athlete_id !== a.id, linked: linked.linked || 0, prs: linked.prs || 0 });
  }));
  api.patch('/testing/links/:id', OC, h(async (req, res) => {
    const l = get('SELECT * FROM device_links WHERE id=?', Number(req.params.id));
    if (!l) throw notFound('That device link');
    const a = linkAthlete(req.body.athlete_id);
    run('UPDATE device_links SET athlete_id=? WHERE id=?', a.id, l.id);
    log(req, 'Moved device link', `${l.sender_label || l.sender_key} (${l.source}) to ${a.first_name} ${a.last_name}`);
    res.json({ ok: true });
  }));
  api.delete('/testing/links/:id', OC, h(async (req, res) => {
    const l = get('SELECT l.*, a.first_name, a.last_name FROM device_links l LEFT JOIN athletes a ON a.id=l.athlete_id WHERE l.id=?', Number(req.params.id));
    if (!l) throw notFound('That device link');
    run('DELETE FROM device_links WHERE id=?', l.id);
    log(req, 'Unlinked device', `${l.sender_label || l.sender_key} (${l.source})${l.first_name ? ` from ${l.first_name} ${l.last_name}` : ''}`);
    res.json({ ok: true, link: { source: l.source, sender_key: l.sender_key, sender_label: l.sender_label, athlete_id: l.athlete_id } });
  }));

  // ---- open API ----
  api.post('/v1/results', requireApiKey, h(async (req, res) => {
    const body = req.body;
    const list = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results.map((r) => ({ source: body.source, ...r })) : body && typeof body === 'object' ? [body] : [];
    if (!list.length) throw bad('Send a result object or an array of them.');
    if (list.length > 1000) throw bad('Send at most 1,000 results per request.');
    const out = core.ingest(list, { req, resultSource: 'api', refPrefix: 'api' });
    if (out.errors) return res.status(400).json({ error: 'Nothing was saved. Fix these results and send them again.', errors: out.errors });
    if (out.saved || out.pending) log(req, 'Results received by API', `${out.saved} saved, ${out.pending} waiting to be linked`);
    res.json({ ok: true, ...out });
  }));

  // ---- progress ----
  api.get('/athletes/:id/progress', STAFF, (req, res) => {
    const p = core.progress(Number(req.params.id), { view: 'staff' });
    if (!p) throw notFound('That athlete');
    res.json(p);
  });
  api.get('/parent/athletes/:id/progress', requireParent, (req, res) => {
    const a = get('SELECT id, family_id FROM athletes WHERE id=?', Number(req.params.id));
    if (!a || a.family_id !== req.parent.family_id) throw notFound('That athlete');
    res.json(core.progress(a.id, { view: 'parent', visibility: setting('results_visibility', 'shared') }));
  });
  // Printable report: staff get the coach view; the athlete's own family get the parent view.
  api.get('/report/:code', (req, res) => {
    const a = get('SELECT id, family_id FROM athletes WHERE code=? COLLATE NOCASE', String(req.params.code));
    if (req.staff && !req.staff.must_change) {
      if (!a) throw notFound('That athlete');
      return res.json({ view: 'coach', business: businessName(), ...core.progress(a.id, { view: 'staff' }) });
    }
    if (req.parent) {
      if (!a || a.family_id !== req.parent.family_id) throw notFound('That athlete');
      return res.json({ view: 'parent', business: businessName(), ...core.progress(a.id, { view: 'parent', visibility: setting('results_visibility', 'shared') }) });
    }
    throw new HttpError(401, 'Sign in to see this report.');
  });
}

module.exports = {
  routes,
  jobs: [{ name: 'hawkin-sync', everyMin: 15, run: () => { hawkin.sync().catch(() => {}); } }],
  _internal: { sheetRows, shareDay },
};
