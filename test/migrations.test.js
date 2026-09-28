// Databases from earlier versions (schema 30, 31, 32, 33, 34, 35, 36 and 37) open with this version: new columns and tables are
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

// Every database from before version 36 gains the point-of-sale pieces (version 36), and every one from before version 37
// puts roster-only athletes on a profile of their own (version 37). These two helpers add a partly refunded cash sale and
// a roster-only athlete to an old database, and check both after the upgrade.
const POS_AT = '2026-02-01T16:00:00.000Z';
function seedSaleAndRoster(old, { sale = true, roster = true } = {}) {
  if (sale) {
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_pos', 'Counter', 'facility', 1, '${POS_AT}')`);
    old.exec(`INSERT INTO sales (id, location_id, method, status, amount_cents, refunded_cents, created_at, completed_at) VALUES ('sale_old', 'loc_pos', 'cash', 'partially_refunded', 3000, 500, '${POS_AT}', '${POS_AT}')`);
  }
  if (!roster) return;
  old.exec(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_old', 'Lakeway HS', 'school', '${POS_AT}')`);
  old.exec(`INSERT INTO team_contracts (id, org_id, name, monthly_cents, start_date, next_period_start, created_at) VALUES ('tc_old', 'org_old', 'JV', 40000, '2026-02-01', '2026-03-01', '${POS_AT}')`);
  old.exec(`INSERT INTO team_roster (id, contract_id, name, athlete_id, position, grad_year, active, created_at) VALUES ('tr_old', 'tc_old', 'Rory Stone', 'RORSTO2026', 'LB', 2029, 1, '${POS_AT}')`);
}
function checkSaleAndRoster(db, round, { sale = true, roster = true } = {}) {
  const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
  assert.ok(cols('athlete_id_aliases').includes('athlete_id'), `round ${round}`);
  if (sale) {
    for (const c of ['discount_cents', 'discount_reason', 'request_id', 'receipt_opt', 'receipt_email', 'receipt_sent_at', 'receipt_token']) assert.ok(cols('sales').includes(c), `sales.${c}, round ${round}`);
    const s = db.get(`SELECT amount_cents, refunded_cents, discount_cents, receipt_token FROM sales WHERE id = 'sale_old'`);
    assert.deepEqual([s.amount_cents, s.refunded_cents, s.discount_cents], [3000, 500, 0], 'the old sale keeps its amounts');
    assert.match(s.receipt_token, /^[0-9a-f]{36}$/, 'a sale from before version 36 gets a receipt link');
    assert.deepEqual(db.all(`SELECT sale_id, amount_cents, kind, created_at FROM sale_refunds`), [{ sale_id: 'sale_old', amount_cents: 500, kind: 'refund', created_at: POS_AT }],
      'the old refund gets one row, dated when the sale was paid, and only once');
  }
  if (!roster) return;
  assert.equal(db.get('SELECT COUNT(*) AS n FROM team_roster WHERE client_id IS NULL').n, 0, 'every roster line has a profile');
  const c = db.get(`SELECT c.name, c.athlete_id, c.position, c.grad_year, c.school, c.family_id FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.id = 'tr_old'`);
  assert.deepEqual({ ...c }, { name: 'Rory Stone', athlete_id: 'RORSTO2026', position: 'LB', grad_year: 2029, school: 'Lakeway HS', family_id: null }, 'the roster-only athlete is a profile with the printed ID');
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM clients WHERE athlete_id = 'RORSTO2026'`).n, 1, 'one profile, not one per open');
}

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
    seedSaleAndRoster(old);
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
      assert.ok(cols('job_runs').includes('error') && cols('job_state').includes('lease_until'));   // background jobs, version 33
      assert.equal(db.get('PRAGMA user_version').user_version, 39);
      checkSaleAndRoster(db, round);
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

// Version 31 (commit c20ea7f) to 37: trial offers keep their special price on the offer. Existing offers stay standard.
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
    seedSaleAndRoster(old);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      assert.ok(db.all('PRAGMA table_info(spot_offers)').some((c) => c.name === 'price_cents'), `round ${round}`);
      assert.equal(db.get('PRAGMA user_version').user_version, 39);
      checkSaleAndRoster(db, round);
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

// Version 32 (commit 7079ba9) to 37 (the test library, version 34; also background jobs, point of sale and one profile per athlete): coach-written protocols, edits to built-in tests that survive the library refresh,
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
    seedSaleAndRoster(old);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.ok(cols('perf_tests').includes('protocol') && cols('perf_tests').includes('edited'), `round ${round}`);
      assert.ok(cols('perf_metrics').includes('min_value') && cols('perf_metrics').includes('max_value'));
      assert.ok(cols('test_presets').includes('test_keys'));
      assert.ok(cols('report_links').includes('token_hash'));
      assert.equal(db.get('PRAGMA user_version').user_version, 39);
      checkSaleAndRoster(db, round);
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

// Version 32 (commit 09e32ca) to 37 (the Testing batch, version 35): testing days remember when families were emailed, and uploads can be undone.
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
      assert.equal(db.get('PRAGMA user_version').user_version, 39);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(getSession(ctx, 'tsn_1').notified_at, null);
      assert.equal(recentUploads(ctx).length, 0, 'an upload from before can\'t be undone, so it isn\'t listed');
      assert.throws(() => undoUpload(ctx, 'imp_1'), /not found/);
      assert.equal(db.get(`SELECT added_tests FROM import_batches WHERE id = 'imp_1'`).added_tests, '[]');
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 34 (the test library, B10) to 37: the same testing-day and undo changes on a database that already has version 34,
// plus point of sale and one profile per athlete.
test('a version 34 database upgrades to undoable uploads and emailed-families tracking, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v34.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 34');
    const now = new Date().toISOString();
    old.exec(`INSERT INTO perf_sessions (id, name, date, test_keys, athletes, shared_at, created_at) VALUES ('tsn_1', 'Combine', '2026-09-01', '[]', '[]', '${now}', '${now}')`);
    old.exec(`INSERT INTO import_batches (id, provider, filename, total_rows, imported, created_at) VALUES ('imp_1', 'upload', 'old.xlsx', 4, 4, '${now}')`);
    old.exec(`INSERT INTO test_presets (id, name, test_keys, created_at) VALUES ('tpr_1', 'Spring combine', '["broad_jump"]', '${now}')`);
    old.exec(`INSERT INTO perf_tests (id, key, name, category, attempts, builtin, active, protocol, created_at) VALUES ('pt_1', 'wall_sit', 'Wall sit', 'custom', 1, 0, 1, 'Back flat on the wall', '${now}')`);
    old.exec(`INSERT INTO perf_metrics (test_id, key, name, unit, better, min_value, max_value) VALUES ('pt_1', 'time', 'Time', 's', 'higher', 5, 600)`);
    old.exec(`INSERT INTO results_queue (id, provider, source, identity, athlete_ref, item, status, received_at) VALUES ('q_1', 'Swift', 'api', 'id:D1', '{}', '{}', 'pending', '${now}')`);
    seedSaleAndRoster(old);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.ok(cols('perf_sessions').includes('notified_at'), `round ${round}`);
      assert.equal(db.get(`SELECT provider FROM results_queue WHERE id = 'q_1'`).provider, 'swift', 'results that waited under "Swift" join the lower-case device links');
      for (const c of ['kind', 'source_label', 'result_source', 'session_id', 'replaced', 'unchanged', 'prs', 'added_tests', 'created_by', 'undone_at', 'undone_by', 'undo_summary']) assert.ok(cols('import_batches').includes(c), c);
      assert.deepEqual(cols('import_batch_items'), ['batch_id', 'result_id', 'value', 'replaced', 'queue_id']);
      assert.equal(db.get('PRAGMA user_version').user_version, 39);
      checkSaleAndRoster(db, round);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(getSession(ctx, 'tsn_1').notified_at, null);
      assert.equal(recentUploads(ctx).length, 0, 'an upload from before can\'t be undone, so it isn\'t listed');
      assert.throws(() => undoUpload(ctx, 'imp_1'), /not found/);
      assert.equal(db.get(`SELECT added_tests FROM import_batches WHERE id = 'imp_1'`).added_tests, '[]');
      // What version 34 added is still there.
      assert.equal(db.get(`SELECT test_keys FROM test_presets WHERE id = 'tpr_1'`).test_keys, '["broad_jump"]');
      assert.deepEqual(db.get(`SELECT min_value, max_value FROM perf_metrics WHERE test_id = 'pt_1'`), { min_value: 5, max_value: 600 });
      assert.equal(db.get(`SELECT protocol FROM perf_tests WHERE id = 'pt_1'`).protocol, 'Back flat on the wall');
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Version 37: one profile per athlete ----
// A version 33 (origin/main: background jobs), 34 or 35 database with team roster athletes: roster-only athletes become clients with their printed IDs,
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

for (const v of [33, 34, 35]) {
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
      seedSaleAndRoster(old, { roster: false });   // the roster athletes come from seedTeams
      const liveBefore = old.prepare('SELECT COUNT(*) AS n FROM perf_results WHERE voided = 0').get().n;
      old.close();
      assert.equal(liveBefore, 7);
      for (const round of [1, 2]) {
        const db = openDb(file);
        const ctx = { db, now: () => new Date().toISOString() };
        assert.equal(db.get('PRAGMA user_version').user_version, 39, `round ${round}`);
        checkSaleAndRoster(db, round, { roster: false });
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
        const log = db.all(`SELECT action FROM audit_log WHERE actor_name = 'Upgrade to version 37'`).map((r) => r.action);
        assert.ok(log.some((a) => /MAYCHE2026, which already belongs to another client/.test(a)), log.join('\n'));
        assert.ok(log.some((a) => /res_4/.test(a)));
        assert.ok(log.some((a) => /athletes named "jalen brooks"/.test(a)));
        const stats = JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'upgrade_v37'`).value);
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
          assert.equal(db.get('SELECT COUNT(*) AS n FROM audit_log WHERE actor_name = ?', 'Upgrade to version 37').n, log.length, 'the upgrade ran once');
        }
        db.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// Version 33 as origin/main shipped it (background jobs; staging already runs it) to 37: every one of our blocks still runs
// on it: the test library (34), the Testing batch (35), point of sale (36) and one profile per athlete (37), and the job
// history written on 33 is kept.
test('a version 33 database from main (job tables) gains the test library, testing, point of sale and one profile per athlete, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v33.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 33');
    const now = new Date().toISOString();
    old.exec(`INSERT INTO job_runs (id, job, trigger, status, started_at, finished_at, duration_ms, result) VALUES ('run_1', 'billing', 'schedule', 'ok', '${now}', '${now}', 12, '{"charged":0}')`);
    old.exec(`INSERT INTO job_state (job, lease_until, holder, fail_streak, last_ok_at) VALUES ('billing', '${now}', 'staging:1', 0, '${now}')`);
    old.exec(`INSERT INTO perf_tests (id, key, name, category, attempts, builtin, active, created_at) VALUES ('pt_1', 'broad_jump', 'Broad jump', 'power', 2, 1, 0, '${now}')`);
    old.exec(`INSERT INTO perf_metrics (test_id, key, name, unit, better) VALUES ('pt_1', 'distance', 'Distance', 'in', 'higher')`);
    old.exec(`INSERT INTO perf_sessions (id, name, date, test_keys, athletes, shared_at, created_at) VALUES ('tsn_1', 'Combine', '2026-09-01', '[]', '[]', '${now}', '${now}')`);
    old.exec(`INSERT INTO import_batches (id, provider, filename, total_rows, imported, created_at) VALUES ('imp_1', 'upload', 'old.xlsx', 4, 4, '${now}')`);
    old.exec(`INSERT INTO results_queue (id, provider, source, identity, athlete_ref, item, status, received_at) VALUES ('q_1', 'Swift', 'api', 'id:D1', '{}', '{}', 'pending', '${now}')`);
    seedSaleAndRoster(old);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, 39, `round ${round}`);
      // Main's version 33: kept as it was.
      assert.deepEqual({ ...db.get(`SELECT job, status, result FROM job_runs WHERE id = 'run_1'`) }, { job: 'billing', status: 'ok', result: '{"charged":0}' });
      assert.equal(db.get(`SELECT holder FROM job_state WHERE job = 'billing'`).holder, 'staging:1');
      // Version 34: the test library.
      assert.ok(cols('perf_tests').includes('protocol') && cols('perf_tests').includes('edited'));
      assert.ok(cols('perf_metrics').includes('min_value') && cols('perf_metrics').includes('max_value'));
      assert.ok(cols('test_presets').includes('test_keys') && cols('report_links').includes('token_hash'));
      const ctx = { db, now: () => new Date().toISOString() };
      syncLibrary(ctx);
      seedPresets(ctx);
      assert.deepEqual(getTest(ctx, 'broad_jump').metrics[0].range, [30, 150]);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM test_presets').n, 7, 'the standard presets are added once');
      // Version 35: the Testing batch.
      assert.ok(cols('perf_sessions').includes('notified_at'));
      assert.deepEqual(cols('import_batch_items'), ['batch_id', 'result_id', 'value', 'replaced', 'queue_id']);
      for (const c of ['kind', 'session_id', 'added_tests', 'undone_at']) assert.ok(cols('import_batches').includes(c), c);
      assert.equal(db.get(`SELECT provider FROM results_queue WHERE id = 'q_1'`).provider, 'swift');
      assert.equal(recentUploads(ctx).length, 0, 'an upload from before can\'t be undone');
      assert.equal(getSession(ctx, 'tsn_1').notified_at, null);
      // Versions 36 and 37: point of sale (columns, refund backfill, receipt link) and the roster athlete's own profile.
      checkSaleAndRoster(db, round);
      const stats = JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'upgrade_v37'`).value);
      assert.deepEqual([stats.roster_lines, stats.clients_created], [1, 1]);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A roster line linked to a profile whose family was deleted before version 37, and one attempt with two different
// values (roster and client): the deleted athlete comes off the roster with no name, ID or device link, their roster
// results are set aside (not deleted) and nothing new can reach the nameless profile; the two values are both kept and logged.
test('a version 35 database: a deleted family\'s roster line stays deleted, and conflicting attempts are kept and logged', async () => {
  const { findByAthleteId } = await import('../src/services/athlete-ids.js');
  const { restoreRoster } = await import('../src/services/teams.js');
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v35.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 35');
    seedTeams(old);
    old.exec(`INSERT INTO families (id, name, created_at) VALUES ('fam_gone', 'Deleted family', '${T0}')`);
    old.exec(`INSERT INTO clients (id, family_id, name, athlete_id, access_token, created_at) VALUES ('cli_gone', 'fam_gone', 'Deleted athlete', NULL, 'gone_abc', '${T0}')`);
    old.exec(`INSERT INTO team_roster (id, contract_id, name, athlete_id, position, client_id, active, created_at) VALUES ('tr_kelly', 'tc_1', 'Kelly Gone', 'KELGON2026', 'LB', 'cli_gone', 1, '${T1}')`);
    old.exec(`INSERT INTO perf_results (id, session_id, roster_id, test_id, metric, attempt, value, source, recorded_at, created_at) VALUES
      ('res_k', 'tsn_1', 'tr_kelly', 'pt_sprint', 'time', 1, 5.2, 'manual', '2026-03-05T15:00:00.000Z', '${T2}'),
      ('res_a3', 'tsn_1', 'tr_ava', 'pt_sprint', 'time', 3, 5.3, 'manual', '2026-03-05T15:00:00.000Z', '${T2}')`);
    old.exec(`INSERT INTO perf_results (id, session_id, client_id, test_id, metric, attempt, value, source, recorded_at, created_at) VALUES ('res_c3', 'tsn_1', 'cli_ava', 'pt_sprint', 'time', 3, 5.4, 'manual', '2026-03-05T15:00:00.000Z', '${T2}')`);
    old.exec(`INSERT INTO athlete_links (provider, external_id, roster_id, created_at) VALUES ('swift', 'SW-K', 'tr_kelly', '${T2}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.deepEqual(db.get(`SELECT name, athlete_id, position, client_id, active FROM team_roster WHERE id = 'tr_kelly'`), { name: 'Deleted athlete', athlete_id: null, position: null, client_id: 'cli_gone', active: 0 }, `round ${round}`);
      assert.equal(db.get(`SELECT athlete_id FROM clients WHERE id = 'cli_gone'`).athlete_id, null, 'the deleted profile gets no ID back');
      assert.equal(findByAthleteId(ctx, 'KELGON2026'), null, 'the old ID finds nobody');
      assert.deepEqual(db.get(`SELECT client_id, roster_id, voided FROM perf_results WHERE id = 'res_k'`), { client_id: 'cli_gone', roster_id: null, voided: 1 }, 'set aside, not deleted');
      assert.equal(db.get(`SELECT 1 FROM athlete_links WHERE external_id = 'SW-K'`), undefined);
      assert.throws(() => restoreRoster(ctx, 'tc_1', 'tr_kelly'), /deleted/);
      assert.deepEqual(db.all(`SELECT id FROM perf_results WHERE id IN ('res_a3', 'res_c3') AND client_id = 'cli_ava' AND voided = 0 ORDER BY id`).map((r) => r.id), ['res_a3', 'res_c3'], 'two different values: both kept');
      const log = db.all(`SELECT action FROM audit_log WHERE actor_name = 'Upgrade to version 37'`).map((r) => r.action);
      assert.ok(log.some((a) => /res_a3/.test(a) && /res_c3/.test(a) && /different values/.test(a)), log.join('\n'));
      const stats = JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'upgrade_v37'`).value);
      assert.deepEqual([stats.deleted_profiles, stats.deleted_results_set_aside, stats.slot_conflicts], [1, 1, 1]);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 36 (batch B5, point of sale): discounts, request ids and receipts on sales, and refunds with their own date (from version 32 to 37).
test('an older database gains the point-of-sale columns and refund log, and old sales keep their amounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v32.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 32');
    const now = new Date().toISOString();
    old.exec(`INSERT INTO locations (id, name, kind, country, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 'US', 1, '${now}')`);
    old.exec(`INSERT INTO sales (id, location_id, method, status, amount_cents, refunded_cents, created_at, completed_at) VALUES ('sale_1', 'loc_1', 'cash', 'partially_refunded', 3000, 500, '${now}', '${now}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = db.all('PRAGMA table_info(sales)').map((c) => c.name);
      for (const c of ['discount_cents', 'discount_reason', 'request_id', 'receipt_opt', 'receipt_email', 'receipt_sent_at', 'receipt_token']) assert.ok(cols.includes(c), `${c}, round ${round}`);
      assert.ok(db.all('PRAGMA table_info(sale_refunds)').map((c) => c.name).includes('kind'));
      const s = db.get(`SELECT amount_cents, refunded_cents, discount_cents FROM sales WHERE id = 'sale_1'`);
      assert.deepEqual([s.amount_cents, s.refunded_cents, s.discount_cents], [3000, 500, 0]);
      assert.equal(db.get('PRAGMA user_version').user_version, 39);
      assert.deepEqual(db.all('SELECT sale_id, amount_cents, kind, created_at FROM sale_refunds'), [{ sale_id: 'sale_1', amount_cents: 500, kind: 'refund', created_at: now }], 'the old refund is logged once');
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 35 (commit e32924d, the Testing batch) to 37: sales gain discounts, request ids and receipts (version 36),
// refunds get their own log, a roster-only athlete gets a profile (version 37), and what version 35 wrote
// (undoable uploads, families emailed) is kept.
test('a version 35 database upgrades to the point-of-sale changes, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v35.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 35');
    const now = new Date().toISOString();
    old.exec(`INSERT INTO locations (id, name, kind, country, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 'US', 1, '${now}')`);
    old.exec(`INSERT INTO sales (id, location_id, method, status, amount_cents, refunded_cents, created_at, completed_at) VALUES ('sale_1', 'loc_1', 'cash', 'succeeded', 4500, 0, '${now}', '${now}')`);
    old.exec(`INSERT INTO sales (id, location_id, method, status, amount_cents, refunded_cents, created_at, completed_at) VALUES ('sale_2', 'loc_1', 'cash', 'partially_refunded', 4500, 1000, '${now}', '${now}')`);
    old.exec(`INSERT INTO perf_sessions (id, name, date, test_keys, athletes, shared_at, notified_at, created_at) VALUES ('tsn_1', 'Combine', '2026-09-01', '[]', '[]', '${now}', '${now}', '${now}')`);
    old.exec(`INSERT INTO import_batches (id, provider, filename, total_rows, imported, kind, session_id, created_at) VALUES ('imp_1', 'upload', 'combine.xlsx', 1, 1, 'upload', 'tsn_1', '${now}')`);
    old.exec(`INSERT INTO import_batch_items (batch_id, result_id, value) VALUES ('imp_1', 'res_1', 98)`);
    seedSaleAndRoster(old, { sale: false });
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      for (const c of ['discount_cents', 'discount_reason', 'request_id', 'receipt_opt', 'receipt_email', 'receipt_sent_at', 'receipt_token']) assert.ok(cols('sales').includes(c), `${c}, round ${round}`);
      assert.ok(cols('sale_refunds').includes('kind'));
      assert.equal(db.get('PRAGMA user_version').user_version, 39);
      const s = db.get(`SELECT amount_cents, discount_cents, receipt_token FROM sales WHERE id = 'sale_1'`);
      assert.deepEqual([s.amount_cents, s.discount_cents], [4500, 0]);
      assert.match(s.receipt_token, /^[0-9a-f]{36}$/, 'sales paid before version 36 get a receipt link');
      // A refund made before refunds had their own rows gets one, once, so the sale's details and takings add up.
      assert.deepEqual(db.all(`SELECT sale_id, amount_cents, created_at FROM sale_refunds`), [{ sale_id: 'sale_2', amount_cents: 1000, created_at: now }]);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(getSession(ctx, 'tsn_1').notified_at, now, 'families already emailed stay marked');
      const ups = recentUploads(ctx);
      assert.deepEqual([ups.length, ups[0].id, ups[0].session_name], [1, 'imp_1', 'Combine'], 'an upload saved on version 35 can still be undone');
      assert.equal(db.get(`SELECT COUNT(*) AS n FROM import_batch_items WHERE batch_id = 'imp_1'`).n, 1);
      checkSaleAndRoster(db, round, { sale: false });
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 36 (commit 0fec356, point of sale) to 37 (one profile per athlete): the point-of-sale data written on version 36
// (discounts, receipt links, refunds and undos with their own rows) is kept as it was and not logged again, and a
// roster-only athlete gets a profile of their own with the printed ID.
test('a version 36 database with sales and refunds moves roster athletes onto one profile each, and opening it twice is safe', async () => {
  const { findByAthleteId } = await import('../src/services/athlete-ids.js');
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v36.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 36');
    const at = '2026-04-02T17:00:00.000Z', later = '2026-04-03T17:00:00.000Z';
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO sales (id, client_id, location_id, method, status, amount_cents, refunded_cents, discount_cents, discount_reason, request_id, receipt_token, created_at, completed_at)
      VALUES ('sale_1', 'cli_ava', 'loc_1', 'cash', 'partially_refunded', 4000, 1500, 500, 'Sibling discount', 'req-1', 'abc123receipt', '${at}', '${at}')`);
    old.exec(`INSERT INTO sale_refunds (id, sale_id, amount_cents, kind, reason, created_at) VALUES
      ('ref_1', 'sale_1', 1000, 'refund', 'Wrong size', '${at}'), ('ref_2', 'sale_1', 500, 'undo', 'Rang twice', '${later}')`);
    old.exec(`INSERT INTO organizations (id, name, kind, created_at) VALUES ('org_1', 'Westlake HS', 'school', '${at}')`);
    old.exec(`INSERT INTO team_contracts (id, org_id, name, monthly_cents, start_date, next_period_start, created_at) VALUES ('tc_1', 'org_1', 'Varsity', 100000, '2026-04-01', '2026-05-01', '${at}')`);
    old.exec(`INSERT INTO team_roster (id, contract_id, name, athlete_id, position, grad_year, client_id, active, created_at) VALUES
      ('tr_ava', 'tc_1', 'Ava Lopez', 'AVALOP2026', 'WR', 2031, 'cli_ava', 1, '${at}'),
      ('tr_jalen', 'tc_1', 'Jalen Brooks', 'JALBRO2026', 'QB', 2027, NULL, 1, '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(db.get('PRAGMA user_version').user_version, 39, `round ${round}`);
      // Point of sale: unchanged.
      assert.deepEqual({ ...db.get(`SELECT client_id, amount_cents, refunded_cents, discount_cents, discount_reason, request_id, receipt_token FROM sales WHERE id = 'sale_1'`) },
        { client_id: 'cli_ava', amount_cents: 4000, refunded_cents: 1500, discount_cents: 500, discount_reason: 'Sibling discount', request_id: 'req-1', receipt_token: 'abc123receipt' });
      assert.deepEqual(db.all(`SELECT id, amount_cents, kind, created_at FROM sale_refunds WHERE id != 'ref_3' ORDER BY id`).map((r) => ({ ...r })),
        [{ id: 'ref_1', amount_cents: 1000, kind: 'refund', created_at: at }, { id: 'ref_2', amount_cents: 500, kind: 'undo', created_at: later }], 'refunds logged on version 36 are not logged again');
      // One profile per athlete.
      assert.equal(db.get('SELECT COUNT(*) AS n FROM team_roster WHERE client_id IS NULL').n, 0, 'every roster line has a profile');
      assert.equal(db.get('SELECT COUNT(*) AS n FROM clients').n, 2, 'Ava keeps her profile; Jalen gets one');
      const jalen = db.get(`SELECT c.* FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.id = 'tr_jalen'`);
      assert.deepEqual([jalen.name, jalen.athlete_id, jalen.position, jalen.grad_year, jalen.school, jalen.family_id], ['Jalen Brooks', 'JALBRO2026', 'QB', 2027, 'Westlake HS', null]);
      assert.equal(findByAthleteId(ctx, 'JALBRO2026').client_id, jalen.id);
      assert.equal(db.get(`SELECT client_id FROM team_roster WHERE id = 'tr_ava'`).client_id, 'cli_ava');
      assert.ok(!db.get(`SELECT 1 FROM sqlite_master WHERE name = 'roster_athlete_id'`), 'roster lines no longer need their own unique ID');
      const stats = JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'upgrade_v37'`).value);
      assert.deepEqual([stats.roster_lines, stats.clients_created, stats.already_linked], [2, 1, 1]);
      if (round === 1) {
        db.run(`INSERT INTO sale_refunds (id, sale_id, amount_cents, kind, created_at) VALUES ('ref_3', 'sale_1', 100, 'refund', ?)`, later);
      } else {
        assert.equal(db.get(`SELECT COUNT(*) AS n FROM sale_refunds`).n, 3, 'the second open keeps data written after the upgrade');
      }
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 37 (78417ae, one profile per athlete) to 38 (billing): membership invoices gain refunds, card reminders, voids and
// payments recorded by hand; a sale's "booking:<id>" note becomes its booking_id (the note itself is left alone), so a Tap
// to Pay sale waiting for the card during the upgrade still marks its session paid; nothing else changes.
test('a version 37 database gains the billing columns and refund log, and a sale for a booking keeps its booking, opened twice', async () => {
  const { syncSale, simulateTap } = await import('../src/services/commerce.js');
  const { createTestProvider } = await import('../src/payments/test-provider.js');
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v37.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 37');
    const at = '2026-09-01T17:00:00.000Z';
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO plans (id, name, price_cents, trial_days, active, created_at) VALUES ('plan_1', 'Monthly', 15000, 0, 1, '${at}')`);
    old.exec(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_1', 'cli_ava', 'plan_1', 'active', '${at}', '2026-10-01T17:00:00.000Z', '${at}', '${at}')`);
    old.exec(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, payment_ref, paid_at, created_at) VALUES ('inv_1', 'sub_1', 'cli_ava', 15000, 'paid', '${at}', '2026-10-01T17:00:00.000Z', 1, 'pi_old', '${at}', '${at}')`);
    old.exec(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, created_at) VALUES ('ses_1', 'Speed', 'group', 'loc_1', '2026-12-01T17:00:00.000Z', '2026-12-01T18:00:00.000Z', 10, 3000, '${at}')`);
    old.exec(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES ('bkg_1', 'ses_1', 'cli_ava', 'booked', 'unpaid', '${at}', '${at}')`);
    old.exec(`INSERT INTO sales (id, client_id, location_id, method, status, amount_cents, payment_ref, note, created_at) VALUES
      ('sale_wait', 'cli_ava', 'loc_1', 'tap_to_pay', 'pending', 3000, 'pi_wait', 'booking:bkg_1', '${at}'),
      ('sale_gone', 'cli_ava', 'loc_1', 'cash', 'succeeded', 500, NULL, 'booking:bkg_deleted', '${at}'),
      ('sale_note', 'cli_ava', 'loc_1', 'cash', 'succeeded', 500, NULL, 'Paid for Ava', '${at}'),
      ('sale_other', NULL, 'loc_1', 'tap_to_pay', 'pending', 3000, 'pi_other', 'booking:bkg_1', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      assert.equal(db.get('PRAGMA user_version').user_version, 39, `round ${round}`);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      for (const c of ['refunded_cents', 'reminded_at', 'voided_at', 'void_reason', 'paid_method', 'paid_reference']) assert.ok(cols('invoices').includes(c), `invoices.${c}, round ${round}`);
      assert.ok(cols('invoice_refunds').includes('source'));
      assert.ok(cols('sales').includes('booking_id'));
      assert.deepEqual({ ...db.get(`SELECT status, amount_cents, refunded_cents, paid_method, payment_ref FROM invoices WHERE id = 'inv_1'`) }, { status: 'paid', amount_cents: 15000, refunded_cents: 0, paid_method: null, payment_ref: 'pi_old' }, 'a paid invoice is a card payment with nothing refunded');
      assert.deepEqual(db.all(`SELECT id, booking_id, note FROM sales ORDER BY id`).map((r) => ({ ...r })), [
        { id: 'sale_gone', booking_id: null, note: 'booking:bkg_deleted' },
        { id: 'sale_note', booking_id: null, note: 'Paid for Ava' },
        { id: 'sale_other', booking_id: null, note: 'booking:bkg_1' },
        { id: 'sale_wait', booking_id: 'bkg_1', note: 'booking:bkg_1' }
      ], 'only a booking that exists, of the sale\'s own client, is copied; notes stay as they were');
      if (round === 1) {
        // The waiting sale completes after the upgrade: its session is marked paid.
        const payments = createTestProvider();
        const ctx = { db, now: () => new Date().toISOString(), payments, testMode: true };
        const intent = await payments.createInPersonIntent({ amountCents: 3000 });
        db.run(`UPDATE sales SET payment_ref = ? WHERE id = 'sale_wait'`, intent.id);
        await simulateTap(ctx, 'sale_wait', 'approved');
        await syncSale(ctx, 'sale_wait');
        assert.equal(db.get(`SELECT coverage FROM bookings WHERE id = 'bkg_1'`).coverage, 'paid');
      } else {
        assert.equal(db.get(`SELECT coverage, sale_id FROM bookings WHERE id = 'bkg_1'`).sale_id, 'sale_wait', 'the second open keeps what happened after the upgrade');
      }
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Version 37 to 39 (batches B2 and B3, Schedule and Today) ----
// Sessions gain the class day they stand for (slot_date) and a staff note; follow-ups on Today get their table. A class
// session from before has no slot_date: the schedule job reads its day from its start and adds no second session that
// day, and moving it to another day (version 39) remembers the class day, so the job still leaves that day alone.
test('a version 37 database upgrades to class days, staff notes and Today follow-ups, and opening it twice is safe', async () => {
  const { extendSchedule, updateSession } = await import('../src/services/schedule.js');
  const { snoozeFollowUp, activeSnoozes } = await import('../src/services/insights.js');
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v37.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 37');
    const at = new Date().toISOString();
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    old.exec(`INSERT INTO settings (key, value) VALUES ('timezone', 'UTC')`);
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'tok-ava', '${at}')`);
    const wd = new Date(`${day(2)}T12:00:00Z`).getUTCDay();
    old.exec(`INSERT INTO class_series (id, name, kind, location_id, weekdays, start_time, duration_min, capacity, start_date, active, created_at) VALUES ('ser_1', 'Speed', 'group', 'loc_1', '[${wd}]', '17:00', 60, 10, '${day(1)}', 1, '${at}')`);
    old.exec(`INSERT INTO class_sessions (id, series_id, name, kind, location_id, starts_at, ends_at, capacity, status, created_at) VALUES ('cls_1', 'ser_1', 'Speed', 'group', 'loc_1', '${day(2)}T16:00:00.000Z', '${day(2)}T17:00:00.000Z', 10, 'scheduled', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(db.get('PRAGMA user_version').user_version, 39, `round ${round}`);
      const cols = db.all('PRAGMA table_info(class_sessions)').map((c) => c.name);
      assert.ok(cols.includes('slot_date') && cols.includes('staff_note'), `round ${round}`);
      assert.ok(db.all('PRAGMA table_info(today_snoozes)').length, `round ${round}`);
      if (round === 1) {
        assert.equal(db.get(`SELECT slot_date FROM class_sessions WHERE id = 'cls_1'`).slot_date, null);
        // The old session was moved by hand to 16:00; the job adds the rest of the class but not a second one that day.
        await extendSchedule(ctx);
        assert.equal(db.all(`SELECT id FROM class_sessions WHERE series_id = 'ser_1' AND starts_at LIKE ?`, `${day(2)}%`).length, 1);
        assert.ok(db.get(`SELECT COUNT(*) AS n FROM class_sessions WHERE series_id = 'ser_1'`).n > 1);
        // Moving it to the next day remembers its class day, so the job still leaves that day alone.
        await updateSession(ctx, 'cls_1', { date: day(3), staff_note: 'Moved for the tournament', notify: false });
        await extendSchedule(ctx);
        assert.equal(db.all(`SELECT id FROM class_sessions WHERE series_id = 'ser_1' AND starts_at LIKE ?`, `${day(2)}%`).length, 0);
        snoozeFollowUp(ctx, { key: 'risk:cli_ava', note: 'Called' }, { id: null, name: 'Owner' });
      }
      assert.deepEqual({ ...db.get(`SELECT slot_date, staff_note FROM class_sessions WHERE id = 'cls_1'`) }, { slot_date: day(2), staff_note: 'Moved for the tournament' }, `round ${round}`);
      assert.equal(activeSnoozes(ctx).length, 1, `the follow-up is kept, round ${round}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 38 (port/b6-billing tip, billing) to 39 (Schedule and Today): what billing wrote is kept; sessions gain their
// class day and staff note, and Today follow-ups get their table.
test('a version 38 database keeps its billing data and gains class days, staff notes and Today follow-ups, opened twice', async () => {
  const { snoozeFollowUp, activeSnoozes } = await import('../src/services/insights.js');
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v38.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 38');
    const at = '2026-09-01T17:00:00.000Z';
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO plans (id, name, price_cents, trial_days, active, created_at) VALUES ('plan_1', 'Monthly', 15000, 0, 1, '${at}')`);
    old.exec(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_1', 'cli_ava', 'plan_1', 'active', '${at}', '2026-10-01T17:00:00.000Z', '${at}', '${at}')`);
    old.exec(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, payment_ref, paid_at, created_at, refunded_cents, paid_method, paid_reference) VALUES ('inv_1', 'sub_1', 'cli_ava', 15000, 'paid', '${at}', '2026-10-01T17:00:00.000Z', 1, NULL, '${at}', '${at}', 5000, 'check', '#1042')`);
    old.exec(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, created_at) VALUES ('ses_1', 'Speed', 'group', 'loc_1', '2026-12-01T17:00:00.000Z', '2026-12-01T18:00:00.000Z', 10, 3000, '${at}')`);
    old.exec(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES ('bkg_1', 'ses_1', 'cli_ava', 'booked', 'paid', '${at}', '${at}')`);
    old.exec(`INSERT INTO sales (id, client_id, location_id, method, status, amount_cents, note, booking_id, created_at) VALUES ('sale_1', 'cli_ava', 'loc_1', 'cash', 'succeeded', 3000, 'booking:bkg_1', 'bkg_1', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const ctx = { db, now: () => new Date().toISOString() };
      assert.equal(db.get('PRAGMA user_version').user_version, 39, `round ${round}`);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.ok(cols('class_sessions').includes('slot_date') && cols('class_sessions').includes('staff_note'), `round ${round}`);
      assert.ok(cols('today_snoozes').includes('until'), `round ${round}`);
      assert.deepEqual({ ...db.get(`SELECT refunded_cents, paid_method, paid_reference FROM invoices WHERE id = 'inv_1'`) }, { refunded_cents: 5000, paid_method: 'check', paid_reference: '#1042' }, `billing is kept, round ${round}`);
      assert.equal(db.get(`SELECT booking_id FROM sales WHERE id = 'sale_1'`).booking_id, 'bkg_1');
      assert.deepEqual({ ...db.get(`SELECT slot_date, staff_note FROM class_sessions WHERE id = 'ses_1'`) }, { slot_date: null, staff_note: null });
      if (round === 1) snoozeFollowUp(ctx, { key: 'risk:cli_ava', note: 'Called' }, { id: null, name: 'Owner' });
      assert.equal(activeSnoozes(ctx).length, 1, `the follow-up is kept, round ${round}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
