// Databases from earlier versions (schema 30 to 34) open with this version: new columns and tables are
// added, nothing is lost, and opening it again changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.js';
import { openSlots, listSessions } from '../src/services/schedule.js';
import { listClients } from '../src/services/clients.js';
import { openSpots, publicOffer } from '../src/services/spots.js';
import { syncLibrary, getTest, updateTest, getSession } from '../src/services/performance.js';
import { seedPresets } from '../src/services/library.js';
import { recentUploads, undoUpload } from '../src/services/uploads.js';

test('a version 30 database upgrades to coaches, archive, time off and staff notes, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v30.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 30');
    const now = new Date().toISOString(), soon = new Date(Date.now() + 3 * 86400000).toISOString(), later = new Date(Date.now() + 3 * 86400000 + 3600000).toISOString();
    old.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('usr_1', 'o@x.dev', 'Olivia', 'x', 'owner', '${now}')`);
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '${now}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_1', 'Ava Lopez', 'AVALOP2026', 'tok1', '${now}')`);
    old.exec(`INSERT INTO class_series (id, name, kind, location_id, weekdays, start_time, duration_min, capacity, start_date, active, created_at) VALUES ('ser_1', 'Speed', 'group', 'loc_1', '[1]', '17:00', 60, 10, '2026-01-05', 1, '${now}')`);
    old.exec(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES ('cls_1', 'ser_1', 'Speed', 'group', 'loc_1', '${soon}', '${later}', 10, 'scheduled', '${now}')`);
    old.exec(`INSERT INTO availability (id, kind, location_id, weekday, start_time, end_time, slot_minutes, created_at) VALUES ('av_1', 'private', 'loc_1', 1, '15:00', '17:00', 60, '${now}')`);
    old.close();

    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.ok(cols('class_series').includes('coach_id'), `round ${round}`);
      assert.ok(cols('class_sessions').includes('coach_id'));
      assert.ok(cols('availability').includes('coach_id'));
      assert.ok(cols('clients').includes('archived_at') && cols('clients').includes('archived_by'));
      assert.deepEqual(cols('time_off'), ['id', 'user_id', 'start_date', 'end_date', 'note', 'created_by', 'created_at']);
      assert.ok(cols('client_notes').includes('coach_only'));
      assert.equal(db.get('PRAGMA user_version').user_version, 36);
      // What was there is still there, with no coach and not archived.
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(listClients(ctx)[0].name, 'Ava Lopez');
      assert.equal(listClients(ctx)[0].archived_at, null);
      const s = listSessions(ctx, { from: now, to: new Date(Date.now() + 7 * 86400000).toISOString() })[0];
      assert.equal(s.id, 'cls_1');
      assert.equal(s.coach_id, null);
      assert.equal(s.coach_name, null);
      assert.ok(Array.isArray(openSlots(ctx, { kind: 'private', days: 7 })));
      if (round === 1) {
        db.run(`INSERT INTO client_notes (id, client_id, author_name, body, created_at) VALUES ('note_1', 'cli_1', 'Olivia', 'Kept', ?)`, now);
      } else {
        assert.equal(db.get(`SELECT body FROM client_notes WHERE id = 'note_1'`).body, 'Kept', 'the second open keeps data written after the upgrade');
      }
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 31 (commit c20ea7f) to 32: trial offers keep their special price on the offer. Existing offers stay standard.
test('a version 31 database upgrades to trial-offer prices, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v31.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 31');
    const now = new Date().toISOString(), soon = new Date(Date.now() + 3 * 86400000).toISOString(), later = new Date(Date.now() + 3 * 86400000 + 3600000).toISOString();
    old.exec(`INSERT INTO settings (key, value) VALUES ('timezone', 'America/Chicago')`);
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '${now}')`);
    old.exec(`INSERT INTO families (id, name, created_at) VALUES ('fam_1', 'Lopez family', '${now}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, family_id, created_at) VALUES ('cli_1', 'Ava Lopez', 'AVALOP2026', 'tok1', 'fam_1', '${now}')`);
    old.exec(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, status, created_at) VALUES ('cls_1', 'Speed', 'group', 'loc_1', '${soon}', '${later}', 10, 2500, 'scheduled', '${now}')`);
    old.exec(`INSERT INTO spot_offers (id, token, session_id, family_id, client_ids, sent_at) VALUES ('spot_1', 'tok_offer_1', 'cls_1', 'fam_1', 'cli_1', '${now}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      assert.ok(db.all('PRAGMA table_info(spot_offers)').some((c) => c.name === 'price_cents'), `round ${round}`);
      assert.equal(db.get('PRAGMA user_version').user_version, 36);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(db.get(`SELECT price_cents FROM spot_offers WHERE id = 'spot_1'`).price_cents, round === 1 ? null : 900);
      const row = openSpots(ctx).data.find((x) => x.id === 'cls_1');
      assert.deepEqual([row.spots_left, row.offers.sent, row.offers.trial_sent], [10, 1, round === 1 ? 0 : 1]);
      assert.deepEqual(publicOffer(ctx, 'tok_offer_1').trial, round === 1 ? null : { price_cents: 900, used: false });
      if (round === 1) db.run(`UPDATE spot_offers SET price_cents = 900 WHERE id = 'spot_1'`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 32 (commit 7079ba9) to 34 (B10's version 33 part): coach-written protocols, edits to built-in tests that survive the library refresh,
// possible ranges, presets (the standard ones added once) and report share links.
test('a version 32 database upgrades to the test library changes, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v32.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 32');
    const now = new Date().toISOString();
    old.exec(`INSERT INTO perf_tests (id, key, name, category, attempts, builtin, active, created_at) VALUES ('pt_1', 'broad_jump', 'Broad jump', 'power', 2, 1, 0, '${now}')`);
    old.exec(`INSERT INTO perf_metrics (test_id, key, name, unit, better) VALUES ('pt_1', 'distance', 'Distance', 'in', 'higher')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_1', 'Ava Lopez', 'AVALOP2026', 'tok1', '${now}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.ok(cols('perf_tests').includes('protocol') && cols('perf_tests').includes('edited'), `round ${round}`);
      assert.ok(cols('perf_metrics').includes('min_value') && cols('perf_metrics').includes('max_value'));
      assert.ok(cols('test_presets').includes('test_keys'));
      assert.ok(cols('report_links').includes('token_hash'));
      assert.equal(db.get('PRAGMA user_version').user_version, 36);
      const ctx = { db, now: () => new Date().toISOString() };
      syncLibrary(ctx);
      seedPresets(ctx);
      const t = getTest(ctx, 'broad_jump');
      assert.deepEqual([t.active, t.metrics[0].range], [false, [30, 150]], 'hidden stays hidden; the built-in range applies');
      const presets = db.all('SELECT name FROM test_presets').map((p) => p.name);
      if (round === 1) {
        assert.equal(t.edited.length, 0);
        assert.equal(presets.length, 7, 'the standard presets are added once');
        db.run(`DELETE FROM test_presets WHERE name = 'Soccer'`);
        updateTest(ctx, 'broad_jump', { attempts: 3 });
      } else {
        assert.equal(presets.length, 6, 'a deleted preset stays deleted');
        assert.equal(t.attempts, 3, 'an edit to a built-in test survives the refresh');
      }
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 32 (commit 09e32ca) to 34 (B9's version 34 part): testing days remember when families were emailed, and uploads can be undone.
// Uploads saved before the upgrade can't be undone (nothing recorded what they wrote), so they aren't offered.
test('a version 32 database upgrades to undoable uploads and emailed-families tracking, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v32.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 32');
    const now = new Date().toISOString();
    old.exec(`INSERT INTO perf_sessions (id, name, date, test_keys, athletes, shared_at, created_at) VALUES ('tsn_1', 'Combine', '2026-09-01', '[]', '[]', '${now}', '${now}')`);
    old.exec(`INSERT INTO import_batches (id, provider, filename, total_rows, imported, created_at) VALUES ('imp_1', 'upload', 'old.xlsx', 4, 4, '${now}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.ok(cols('perf_sessions').includes('notified_at'), `round ${round}`);
      for (const c of ['kind', 'source_label', 'result_source', 'session_id', 'replaced', 'unchanged', 'prs', 'added_tests', 'created_by', 'undone_at', 'undone_by', 'undo_summary']) assert.ok(cols('import_batches').includes(c), c);
      assert.deepEqual(cols('import_batch_items'), ['batch_id', 'result_id', 'value', 'replaced', 'queue_id']);
      assert.equal(db.get('PRAGMA user_version').user_version, 36);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(getSession(ctx, 'tsn_1').notified_at, null);
      assert.equal(recentUploads(ctx).length, 0, 'an upload from before can\'t be undone, so it isn\'t listed');
      assert.throws(() => undoUpload(ctx, 'imp_1'), /not found/);
      assert.equal(db.get(`SELECT added_tests FROM import_batches WHERE id = 'imp_1'`).added_tests, '[]');
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 33 (the test library, B10) to 34: the same testing-day and undo changes on a database that already has version 33.
test('a version 33 database upgrades to undoable uploads and emailed-families tracking, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v33.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 33');
    const now = new Date().toISOString();
    old.exec(`INSERT INTO perf_sessions (id, name, date, test_keys, athletes, shared_at, created_at) VALUES ('tsn_1', 'Combine', '2026-09-01', '[]', '[]', '${now}', '${now}')`);
    old.exec(`INSERT INTO import_batches (id, provider, filename, total_rows, imported, created_at) VALUES ('imp_1', 'upload', 'old.xlsx', 4, 4, '${now}')`);
    old.exec(`INSERT INTO test_presets (id, name, test_keys, created_at) VALUES ('tpr_1', 'Spring combine', '["broad_jump"]', '${now}')`);
    old.exec(`INSERT INTO perf_tests (id, key, name, category, attempts, builtin, active, protocol, created_at) VALUES ('pt_1', 'wall_sit', 'Wall sit', 'custom', 1, 0, 1, 'Back flat on the wall', '${now}')`);
    old.exec(`INSERT INTO perf_metrics (test_id, key, name, unit, better, min_value, max_value) VALUES ('pt_1', 'time', 'Time', 's', 'higher', 5, 600)`);
    old.exec(`INSERT INTO results_queue (id, provider, source, identity, athlete_ref, item, status, received_at) VALUES ('q_1', 'Swift', 'api', 'id:D1', '{}', '{}', 'pending', '${now}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.ok(cols('perf_sessions').includes('notified_at'), `round ${round}`);
      assert.equal(db.get(`SELECT provider FROM results_queue WHERE id = 'q_1'`).provider, 'swift', 'results that waited under "Swift" join the lower-case device links');
      for (const c of ['kind', 'source_label', 'result_source', 'session_id', 'replaced', 'unchanged', 'prs', 'added_tests', 'created_by', 'undone_at', 'undone_by', 'undo_summary']) assert.ok(cols('import_batches').includes(c), c);
      assert.deepEqual(cols('import_batch_items'), ['batch_id', 'result_id', 'value', 'replaced', 'queue_id']);
      assert.equal(db.get('PRAGMA user_version').user_version, 36);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(getSession(ctx, 'tsn_1').notified_at, null);
      assert.equal(recentUploads(ctx).length, 0, 'an upload from before can\'t be undone, so it isn\'t listed');
      assert.throws(() => undoUpload(ctx, 'imp_1'), /not found/);
      assert.equal(db.get(`SELECT added_tests FROM import_batches WHERE id = 'imp_1'`).added_tests, '[]');
      // What version 33 added is still there.
      assert.equal(db.get(`SELECT test_keys FROM test_presets WHERE id = 'tpr_1'`).test_keys, '["broad_jump"]');
      assert.deepEqual(db.get(`SELECT min_value, max_value FROM perf_metrics WHERE test_id = 'pt_1'`), { min_value: 5, max_value: 600 });
      assert.equal(db.get(`SELECT protocol FROM perf_tests WHERE id = 'pt_1'`).protocol, 'Back flat on the wall');
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Version 36: one profile per athlete ----
// A version 33 or 34 database with team roster athletes: roster-only athletes become clients with their printed IDs,
// a linked line's own ID keeps finding its client, results, device links, testing days and team attendance move to the
// profile, a result that was on both is kept once, and an ID that collides with another client is resolved and logged.
const T0 = '2026-03-01T15:00:00.000Z', T1 = '2026-03-02T15:00:00.000Z', T2 = '2026-03-10T15:00:00.000Z';
function seedTeams(old) {
  const ins = (sql) => old.exec(sql);
  ins(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('usr_1', 'o@x.dev', 'Olivia', 'x', 'owner', '${T0}')`);
  ins(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '${T0}')`);
  ins(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'tok-ava', '${T0}'), ('cli_maya', 'Maya Chen', 'MAYCHE2026', 'tok-maya', '${T0}')`);
  ins(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_1', 'Westlake HS', 'school', '${T0}'), ('org_2', 'Hill Country FC', 'club', '${T0}')`);
  ins(`INSERT INTO team_contracts (id, org_id, name, monthly_cents, start_date, next_period_start, created_at) VALUES ('tc_1', 'org_1', 'Varsity', 100000, '2026-03-01', '2026-04-01', '${T0}'), ('tc_2', 'org_2', '14U', 50000, '2026-03-01', '2026-04-01', '${T0}')`);
  ins(`INSERT INTO team_roster (id, contract_id, name, athlete_id, position, grad_year, client_id, active, created_at) VALUES
    ('tr_ava', 'tc_1', 'Ava Lopez', 'AVALOP2026-2', 'WR', 2031, 'cli_ava', 1, '${T1}'),
    ('tr_jalen', 'tc_1', 'Jalen Brooks', 'JALBRO2026', 'QB', 2027, NULL, 1, '${T1}'),
    ('tr_maya2', 'tc_1', 'Maya Chen', 'MAYCHE2026', 'DB', 2028, NULL, 1, '${T1}'),
    ('tr_jalen2', 'tc_2', 'Jalen Brooks', 'JALBRO2026-2', NULL, NULL, NULL, 0, '${T2}')`);
  ins(`INSERT INTO perf_tests (id, key, name, category, attempts, builtin, active, created_at) VALUES ('pt_sprint', 'sprint_x', 'Sprint X', 'custom', 3, 0, 1, '${T0}')`);
  ins(`INSERT INTO perf_metrics (test_id, key, name, unit, better) VALUES ('pt_sprint', 'time', 'Time', 's', 'lower')`);
  ins(`INSERT INTO perf_sessions (id, name, date, contract_id, test_keys, athletes, created_at) VALUES ('tsn_1', 'Preseason', '2026-03-05', 'tc_1', '["sprint_x"]',
    '[{"roster_id":"tr_jalen"},{"client_id":"cli_ava"},{"roster_id":"tr_ava"},{"roster_id":"tr_maya2"}]', '${T2}')`);
  const res = (id, who, value, attempt, at = '2026-03-05T15:00:00.000Z') => ins(`INSERT INTO perf_results (id, session_id, client_id, roster_id, test_id, metric, attempt, value, source, recorded_at, created_at)
    VALUES ('${id}', 'tsn_1', ${who.startsWith('cli') ? `'${who}'` : 'NULL'}, ${who.startsWith('tr') ? `'${who}'` : 'NULL'}, 'pt_sprint', 'time', ${attempt}, ${value}, 'manual', '${at}', '${T2}')`);
  res('res_1', 'tr_jalen', 4.9, 1); res('res_2', 'tr_jalen', 4.8, 2);
  res('res_3', 'cli_ava', 5.1, 1); res('res_4', 'tr_ava', 5.1, 1);   // the same result on Ava's profile and her roster line
  res('res_5', 'tr_ava', 5.0, 2);
  res('res_6', 'tr_maya2', 5.5, 1); res('res_7', 'cli_maya', 6.0, 1);
  ins(`INSERT INTO athlete_links (provider, external_id, external_name, roster_id, created_at) VALUES ('swift', 'SW-1', 'Jalen B', 'tr_jalen', '${T2}')`);
  ins(`INSERT INTO class_series (id, name, kind, location_id, weekdays, start_time, duration_min, capacity, start_date, active, contract_id, created_at) VALUES ('ser_t', 'Varsity lift', 'team', 'loc_1', '[1]', '06:00', 60, 30, '2026-03-01', 1, 'tc_1', '${T0}')`);
  ins(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES ('cls_t', 'ser_t', 'Varsity lift', 'team', 'loc_1', '2026-03-09T11:00:00.000Z', '2026-03-09T12:00:00.000Z', 30, 'scheduled', '${T0}')`);
  ins(`INSERT INTO team_attendance (session_id, roster_id, created_at) VALUES ('cls_t', 'tr_jalen', '${T2}'), ('cls_t', 'tr_ava', '${T2}')`);
}

for (const v of [33, 34]) {
  test(`a version ${v} database moves team roster athletes onto one profile each, and opening it twice is safe`, async () => {
    const { findByAthleteId } = await import('../src/services/athlete-ids.js');
    const { recordResults } = await import('../src/services/performance.js');
    const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
    const file = join(dir, 'old.db');
    try {
      const old = new DatabaseSync(file);
      old.exec(readFileSync(new URL(`./fixtures/schema-v${v}.sql`, import.meta.url), 'utf8'));
      old.exec(`PRAGMA user_version = ${v}`);
      seedTeams(old);
      const liveBefore = old.prepare('SELECT COUNT(*) AS n FROM perf_results WHERE voided = 0').get().n;
      old.close();
      assert.equal(liveBefore, 7);
      for (const round of [1, 2]) {
        const db = openDb(file);
        const ctx = { db, now: () => new Date().toISOString() };
        assert.equal(db.get('PRAGMA user_version').user_version, 36, `round ${round}`);
        assert.equal(db.get('SELECT COUNT(*) AS n FROM team_roster WHERE client_id IS NULL').n, 0, 'every roster line has a profile');
        assert.equal(db.get('SELECT COUNT(*) AS n FROM clients').n, 5, 'Ava and Maya, plus Jalen, the second Jalen and the roster Maya');
        const lineClient = (id) => db.get('SELECT c.* FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.id = ?', id);
        const jalen = lineClient('tr_jalen'), jalen2 = lineClient('tr_jalen2'), maya2 = lineClient('tr_maya2');
        assert.deepEqual([jalen.athlete_id, jalen.position, jalen.grad_year, jalen.school, jalen.family_id, jalen.created_at], ['JALBRO2026', 'QB', 2027, 'Westlake HS', null, T1], 'the printed ID stays');
        assert.equal(jalen2.athlete_id, 'JALBRO2026-2');
        assert.notEqual(jalen2.id, jalen.id, 'the same name on two teams is never merged');
        assert.equal(jalen2.school, null, 'a club is not a school');
        assert.equal(lineClient('tr_ava').id, 'cli_ava');
        // Collision: the roster Maya's ID already belonged to client Maya, who keeps it.
        assert.match(maya2.athlete_id, /^MAYCHE2026-\d+$/);
        assert.equal(findByAthleteId(ctx, 'MAYCHE2026').client_id, 'cli_maya');
        assert.equal(findByAthleteId(ctx, maya2.athlete_id).client_id, maya2.id);
        // Old IDs keep landing on the right profile.
        assert.equal(findByAthleteId(ctx, 'avalop2026-2').client_id, 'cli_ava', 'a linked line\'s own ID is an alias of the client');
        assert.equal(findByAthleteId(ctx, 'JALBRO2026').client_id, jalen.id);
        assert.deepEqual(db.all('SELECT athlete_id, client_id FROM athlete_id_aliases'), [{ athlete_id: 'AVALOP2026-2', client_id: 'cli_ava' }]);
        assert.equal(db.get(`SELECT athlete_id FROM team_roster WHERE id = 'tr_ava'`).athlete_id, 'AVALOP2026', 'roster lines copy their client\'s ID');
        // Results: none lost, none doubled.
        assert.equal(db.get('SELECT COUNT(*) AS n FROM perf_results WHERE roster_id IS NOT NULL').n, 0);
        assert.equal(db.get('SELECT COUNT(*) AS n FROM perf_results').n, 7 + (round === 2 ? 1 : 0), 'nothing deleted');
        const live = (cid) => db.all('SELECT id FROM perf_results WHERE client_id = ? AND voided = 0 ORDER BY id', cid).map((r) => r.id);
        assert.deepEqual(live(jalen.id), ['res_1', 'res_2']);
        assert.deepEqual(live('cli_ava').filter((x) => /^res_\d$/.test(x)), ['res_3', 'res_5'], 'the copy from her roster line is set aside, her other attempt moves over');
        assert.equal(db.get(`SELECT voided FROM perf_results WHERE id = 'res_4'`).voided, 1);
        assert.match(db.get(`SELECT notes FROM perf_results WHERE id = 'res_4'`).notes, /res_3/);
        assert.deepEqual(live(maya2.id), ['res_6']);
        assert.deepEqual(live('cli_maya'), ['res_7'], 'the other Maya keeps only her own result');
        // Device links, testing day, team attendance.
        assert.deepEqual(db.get(`SELECT client_id, roster_id FROM athlete_links WHERE external_id = 'SW-1'`), { client_id: jalen.id, roster_id: null });
        assert.deepEqual(JSON.parse(db.get(`SELECT athletes FROM perf_sessions WHERE id = 'tsn_1'`).athletes), [{ client_id: jalen.id }, { client_id: 'cli_ava' }, { client_id: maya2.id }]);
        assert.deepEqual(db.all('SELECT client_id FROM team_attendance ORDER BY client_id').map((r) => r.client_id), ['cli_ava', jalen.id].sort());
        assert.ok(db.all('PRAGMA table_info(team_attendance)').some((c) => c.name === 'client_id'));
        assert.ok(!db.get(`SELECT 1 FROM sqlite_master WHERE name = 'roster_athlete_id'`), 'roster lines no longer need their own unique ID');
        const day = getSession(ctx, 'tsn_1');
        assert.deepEqual(day.athletes.map((a) => [a.name, a.results.length]), [['Ava Lopez', 2], ['Jalen Brooks', 2], ['Maya Chen', 1], ['Maya Chen', 1]], 'both Maya Chens: the roster one and the client tested that day');
        // Logged for the owner, counted once.
        const log = db.all(`SELECT action FROM audit_log WHERE actor_name = 'Upgrade to version 36'`).map((r) => r.action);
        assert.ok(log.some((a) => /MAYCHE2026, which already belongs to another client/.test(a)), log.join('\n'));
        assert.ok(log.some((a) => /res_4/.test(a)));
        assert.ok(log.some((a) => /athletes named "jalen brooks"/.test(a)));
        const stats = JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'upgrade_v36'`).value);
        assert.deepEqual([stats.roster_lines, stats.clients_created, stats.already_linked, stats.aliases, stats.results_moved, stats.duplicates_set_aside, stats.device_links_moved, stats.testing_days_updated, stats.attendance_moved, stats.collisions.length],
          [4, 3, 1, 1, 5, 1, 1, 1, 2, 1]);
        if (round === 1) {
          // A sheet or device using an old ID after the upgrade lands on the profile.
          const r = recordResults(ctx, [{ athlete_id: 'AVALOP2026-2', test: 'sprint_x', value: 4.95, recorded_at: '2026-03-20' }], { source: 'manual' });
          assert.deepEqual([r.created, r.results[0].client_id], [1, 'cli_ava']);
          syncLibrary(ctx);
          const { previewUpload } = await import('../src/services/uploads.js');
          const up = previewUpload(ctx, { csv: 'Athlete ID,Name,Broad jump (in)\nAVALOP2026-2,Ava Lopez,90\nJALBRO2026,Jalen Brooks,101', date: '2026-03-20' });
          assert.equal(up.ok, true, JSON.stringify(up.errors));
          assert.deepEqual(up.athletes.map((a) => [a.client_id, a.athlete_id]), [['cli_ava', 'AVALOP2026'], [jalen.id, 'JALBRO2026']], 'an upload using an old roster ID lands on the profile');
        } else {
          assert.equal(db.get(`SELECT COUNT(*) AS n FROM perf_results WHERE client_id = 'cli_ava' AND value = 4.95`).n, 1, 'the second open keeps data written after the upgrade');
          assert.equal(db.get('SELECT COUNT(*) AS n FROM audit_log WHERE actor_name = ?', 'Upgrade to version 36').n, log.length, 'the upgrade ran once');
        }
        db.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
