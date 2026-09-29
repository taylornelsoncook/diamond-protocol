// Databases from earlier versions (schema 30 to 44) open with this version: new columns and tables are
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

const LATEST = 53;   // the schema version every upgrade ends on

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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST);
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
        assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
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
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
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

// ---- Version 40 (batch B8): programs builder and set-by-set workout logging ----
// Version 37 to 40: exercises gain a category, workout logs gain effort, start time, a request id and an edit time, and
// sets get their own table. Workouts logged before keep counting (streaks, programs, the coach's feed) with no sets.
test('a version 37 database upgrades to set-by-set logging, keeps its workouts, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v37.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 37');
    const now = new Date().toISOString();
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_1', 'Ava Lopez', 'AVALOP2026', 'tok1', '${now}')`);
    old.exec(`INSERT INTO exercises (id, name, created_at) VALUES ('ex_1', 'Back squat', '${now}')`);
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_1', 'Strength', 4, '${now}')`);
    old.exec(`INSERT INTO workouts (id, program_id, week, day, title) VALUES ('wo_1', 'prog_1', 1, 1, 'Lower body')`);
    old.exec(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position, prescription) VALUES ('wex_1', 'wo_1', 'ex_1', 1, '5 × 5')`);
    old.exec(`INSERT INTO assignments (id, client_id, program_id, start_date, active, created_at) VALUES ('asg_1', 'cli_1', 'prog_1', '${now}', 1, '${now}')`);
    old.exec(`INSERT INTO workout_logs (id, client_id, assignment_id, workout_id, notes, completed_at) VALUES ('log_1', 'cli_1', 'asg_1', 'wo_1', 'Felt good', '${now}')`);
    old.exec(`INSERT INTO exercise_logs (workout_log_id, workout_exercise_id) VALUES ('log_1', 'wex_1')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.ok(cols('exercises').includes('category'));
      for (const c of ['rpe', 'started_at', 'request_id', 'edited_at', 'session_id']) assert.ok(cols('workout_logs').includes(c), `workout_logs.${c}, round ${round}`);
      for (const c of ['workout_log_id', 'workout_exercise_id', 'exercise_id', 'exercise_name', 'set_no', 'weight', 'reps']) assert.ok(cols('workout_sets').includes(c), `workout_sets.${c}`);
      assert.deepEqual({ ...db.get(`SELECT notes, rpe, request_id FROM workout_logs WHERE id = 'log_1'`) }, { notes: 'Felt good', rpe: null, request_id: null }, 'the old log is kept as it was');
      assert.equal(db.get(`SELECT COUNT(*) AS n FROM exercise_logs WHERE workout_log_id = 'log_1'`).n, 1);
      // A second Finish with the same request id can't be saved twice.
      if (round === 1) {
        db.run(`INSERT INTO workout_logs (id, client_id, workout_id, completed_at, request_id) VALUES ('log_2', 'cli_1', 'wo_1', ?, 'req-1')`, now);
        assert.throws(() => db.run(`INSERT INTO workout_logs (id, client_id, workout_id, completed_at, request_id) VALUES ('log_3', 'cli_1', 'wo_1', ?, 'req-1')`, now), /UNIQUE/);
        db.run(`INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES ('set_1', 'log_2', 'wex_1', 'ex_1', 'Back squat', 1, 135, 5, ?)`, now);
      }
      assert.equal(db.get('SELECT COUNT(*) AS n FROM workout_sets').n, 1, `round ${round}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 39 (3daa6b4: Billing and Schedule and Today) to 40 (programs builder): what Billing and Schedule wrote is kept
// (refunds, payments by hand, a sale's booking, a moved session's class day and staff note, a Today follow-up); exercises
// gain a category, workout logs gain effort, start time, a request id and an edit time, and sets get their own table.
test('a version 39 database keeps its billing, schedule and Today data and gains set-by-set logging, opened twice', async () => {
  const { activeSnoozes } = await import('../src/services/insights.js');
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v39.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 39');
    const at = '2026-09-01T17:00:00.000Z', now = new Date().toISOString();
    const until = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO plans (id, name, price_cents, trial_days, active, created_at) VALUES ('plan_1', 'Monthly', 15000, 0, 1, '${at}')`);
    old.exec(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_1', 'cli_ava', 'plan_1', 'active', '${at}', '2026-10-01T17:00:00.000Z', '${at}', '${at}')`);
    old.exec(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, paid_at, created_at, refunded_cents, paid_method, paid_reference) VALUES ('inv_1', 'sub_1', 'cli_ava', 15000, 'paid', '${at}', '2026-10-01T17:00:00.000Z', 1, '${at}', '${at}', 5000, 'check', '#1042')`);
    old.exec(`INSERT INTO exercises (id, name, created_at) VALUES ('ex_1', 'Back squat', '${at}')`);
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_1', 'Strength', 4, '${at}')`);
    old.exec(`INSERT INTO workouts (id, program_id, week, day, title) VALUES ('wo_1', 'prog_1', 1, 1, 'Lower body')`);
    old.exec(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position, prescription) VALUES ('wex_1', 'wo_1', 'ex_1', 1, '5 × 5')`);
    old.exec(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, drop_in_cents, workout_id, slot_date, staff_note, created_at) VALUES ('ses_1', 'Speed', 'group', 'loc_1', '2026-12-02T17:00:00.000Z', '2026-12-02T18:00:00.000Z', 10, 3000, 'wo_1', '2026-12-01', 'Moved for the tournament', '${at}')`);
    old.exec(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES ('bkg_1', 'ses_1', 'cli_ava', 'booked', 'paid', '${at}', '${at}')`);
    old.exec(`INSERT INTO sales (id, client_id, location_id, method, status, amount_cents, booking_id, created_at) VALUES ('sale_1', 'cli_ava', 'loc_1', 'cash', 'succeeded', 3000, 'bkg_1', '${at}')`);
    old.exec(`INSERT INTO today_snoozes (id, key, kind, client_id, until, action, note, created_by, created_at) VALUES ('snz_1', 'risk:cli_ava', 'risk', 'cli_ava', '${until}', 'reached_out', 'Called', 'Owner', '${now}')`);
    old.exec(`INSERT INTO workout_logs (id, client_id, workout_id, session_id, notes, completed_at) VALUES ('log_1', 'cli_ava', 'wo_1', 'ses_1', 'On the screen', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const ctx = { db, now: () => new Date().toISOString() };
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.ok(cols('exercises').includes('category'), `round ${round}`);
      for (const c of ['rpe', 'started_at', 'request_id', 'edited_at', 'session_id']) assert.ok(cols('workout_logs').includes(c), `workout_logs.${c}, round ${round}`);
      assert.ok(cols('workout_sets').includes('set_no'));
      // Billing, Schedule and Today: kept.
      assert.deepEqual({ ...db.get(`SELECT refunded_cents, paid_method, paid_reference FROM invoices WHERE id = 'inv_1'`) }, { refunded_cents: 5000, paid_method: 'check', paid_reference: '#1042' }, `billing is kept, round ${round}`);
      assert.equal(db.get(`SELECT booking_id FROM sales WHERE id = 'sale_1'`).booking_id, 'bkg_1');
      assert.deepEqual({ ...db.get(`SELECT workout_id, slot_date, staff_note FROM class_sessions WHERE id = 'ses_1'`) }, { workout_id: 'wo_1', slot_date: '2026-12-01', staff_note: 'Moved for the tournament' });
      assert.equal(activeSnoozes(ctx).length, 1, `the follow-up is kept, round ${round}`);
      assert.deepEqual({ ...db.get(`SELECT session_id, notes, rpe FROM workout_logs WHERE id = 'log_1'`) }, { session_id: 'ses_1', notes: 'On the screen', rpe: null }, 'the screen log is kept as it was');
      if (round === 1) {
        db.run(`UPDATE exercises SET category = 'Lower body' WHERE id = 'ex_1'`);
        db.run(`INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES ('set_1', 'log_1', 'wex_1', 'ex_1', 'Back squat', 1, 135, 5, ?)`, now);
      }
      assert.equal(db.get(`SELECT category FROM exercises WHERE id = 'ex_1'`).category, 'Lower body', `round ${round}`);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM workout_sets').n, 1, `the second open keeps data written after the upgrade, round ${round}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 40 (9dc3cc8: Billing, Schedule and Today, Programs) to 41 (parent portal): what the earlier blocks wrote is kept
// (a sale's booking, workout effort, exercise categories), and the parent portal gains membership requests, profile
// claims, the card's expiry, the calendar feed, a booking's note for the coach and signed-in devices (ending at the latest version). A portal session
// from before the upgrade keeps working (its device details are simply empty).
test('a version 40 database keeps its data and gains the parent portal tables and columns, opened twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v40.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 40');
    const at = '2026-09-01T17:00:00.000Z', later = new Date(Date.now() + 30 * 86400000).toISOString();
    old.exec(`INSERT INTO locations (id, name, kind, active, created_at) VALUES ('loc_1', 'Facility', 'facility', 1, '${at}')`);
    old.exec(`INSERT INTO families (id, name, card_payment_method, card_brand, card_last4, created_at) VALUES ('fam_1', 'Lopez family', 'pm_1', 'visa', '4242', '${at}')`);
    old.exec(`INSERT INTO guardians (id, family_id, name, email, is_primary, created_at) VALUES ('gdn_1', 'fam_1', 'Maria Lopez', 'maria@example.com', 1, '${at}')`);
    old.exec(`INSERT INTO portal_sessions (token_hash, guardian_id, expires_at) VALUES ('hash_1', 'gdn_1', '${later}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, family_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'fam_1', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO plans (id, name, price_cents, trial_days, active, created_at) VALUES ('plan_1', 'Monthly', 15000, 0, 1, '${at}')`);
    old.exec(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_1', 'cli_ava', 'plan_1', 'active', '${at}', '2026-10-01T17:00:00.000Z', '${at}', '${at}')`);
    old.exec(`INSERT INTO class_sessions (id, name, kind, location_id, starts_at, ends_at, capacity, created_at) VALUES ('ses_1', 'Private: Ava Lopez', 'private', 'loc_1', '2026-12-02T17:00:00.000Z', '2026-12-02T18:00:00.000Z', 1, '${at}')`);
    old.exec(`INSERT INTO bookings (id, session_id, client_id, status, coverage, created_at, updated_at) VALUES ('bkg_1', 'ses_1', 'cli_ava', 'booked', 'paid', '${at}', '${at}')`);
    old.exec(`INSERT INTO sales (id, client_id, location_id, method, status, amount_cents, booking_id, created_at) VALUES ('sale_1', 'cli_ava', 'loc_1', 'card_on_file', 'succeeded', 8000, 'bkg_1', '${at}')`);
    old.exec(`INSERT INTO exercises (id, name, category, created_at) VALUES ('ex_1', 'Back squat', 'Lower body', '${at}')`);
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_1', 'Strength', 4, '${at}')`);
    old.exec(`INSERT INTO workouts (id, program_id, week, day, title) VALUES ('wo_1', 'prog_1', 1, 1, 'Lower body')`);
    old.exec(`INSERT INTO workout_logs (id, client_id, workout_id, rpe, request_id, completed_at) VALUES ('log_1', 'cli_ava', 'wo_1', 7, 'req-1', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      for (const [t, c] of [['families', 'card_exp'], ['clients', 'card_exp'], ['guardians', 'calendar_token_hash'], ['guardians', 'calendar_created_at'], ['bookings', 'note'], ['portal_sessions', 'created_at'], ['portal_sessions', 'user_agent'], ['portal_sessions', 'last_seen_at']]) assert.ok(cols(t).includes(c), `${t}.${c}, round ${round}`);
      for (const c of ['kind', 'plan_id', 'status', 'resolution_note']) assert.ok(cols('membership_requests').includes(c));
      for (const c of ['athlete_id', 'claimed_client_id', 'new_client_id', 'reason']) assert.ok(cols('profile_claims').includes(c));
      // Earlier blocks' data: kept.
      assert.equal(db.get(`SELECT booking_id FROM sales WHERE id = 'sale_1'`).booking_id, 'bkg_1');
      assert.deepEqual({ ...db.get(`SELECT rpe, request_id FROM workout_logs WHERE id = 'log_1'`) }, { rpe: 7, request_id: 'req-1' });
      assert.equal(db.get(`SELECT category FROM exercises WHERE id = 'ex_1'`).category, 'Lower body');
      assert.equal(db.get(`SELECT card_last4 FROM families WHERE id = 'fam_1'`).card_last4, '4242', 'the card stays; its expiry is unknown until the card is saved again');
      assert.equal(db.get(`SELECT card_exp FROM families WHERE id = 'fam_1'`).card_exp, null);
      assert.equal(db.get(`SELECT guardian_id FROM portal_sessions WHERE token_hash = 'hash_1'`).guardian_id, 'gdn_1', 'parents stay signed in');
      if (round === 1) {
        db.run(`INSERT INTO membership_requests (id, client_id, subscription_id, guardian_id, kind, status, created_at) VALUES ('mrq_1', 'cli_ava', 'sub_1', 'gdn_1', 'pause', 'open', ?)`, at);
        assert.throws(() => db.run(`INSERT INTO membership_requests (id, client_id, kind, status, created_at) VALUES ('mrq_2', 'cli_ava', 'cancel', 'open', ?)`, at), /UNIQUE/, 'one open request per athlete');
        assert.throws(() => db.run(`INSERT INTO membership_requests (id, client_id, kind, status, created_at) VALUES ('mrq_3', 'cli_ava', 'constructor', 'done', ?)`, at), /CHECK/);
        db.run(`UPDATE bookings SET note = 'Working on first step' WHERE id = 'bkg_1'`);
      }
      assert.equal(db.get('SELECT COUNT(*) AS n FROM membership_requests').n, 1, `the second open keeps data written after the upgrade, round ${round}`);
      assert.equal(db.get(`SELECT note FROM bookings WHERE id = 'bkg_1'`).note, 'Working on first step');
      assert.ok(!cols('invoices').includes('manual_attempts'), 'one retry counter: auto_attempts');
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// ---- Version 43: the owner's decisions ----
test('a version 40 database gains charge tries, leads for a coach and workout logs that outlive their program; staff discounts go to 0; opened twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v40.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 40');
    const at = '2026-09-01T17:00:00.000Z';
    old.exec(`INSERT INTO settings (key, value) VALUES ('staff_discount_max_pct', '20')`);
    old.exec(`INSERT INTO users (id, email, name, password_hash, role, active, created_at) VALUES ('usr_c', 'c@x.dev', 'Carl', 'x', 'coach', 1, '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO plans (id, name, price_cents, trial_days, active, created_at) VALUES ('plan_1', 'Monthly', 15000, 0, 1, '${at}')`);
    old.exec(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_1', 'cli_ava', 'plan_1', 'past_due', '${at}', '2026-10-01T17:00:00.000Z', '${at}', '${at}')`);
    old.exec(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, payment_ref, created_at) VALUES ('inv_1', 'sub_1', 'cli_ava', 15000, 'failed', '${at}', '2026-10-01T17:00:00.000Z', 3, 'pi_old', '${at}')`);
    old.exec(`INSERT INTO leads (id, parent_name, email, source, status, created_at, updated_at) VALUES ('lead_1', 'Gia', 'gia@example.com', 'inquiry', 'new', '${at}', '${at}')`);
    old.exec(`INSERT INTO exercises (id, name, created_at) VALUES ('ex_1', 'Back squat', '${at}')`);
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_1', 'Strength', 4, '${at}')`);
    old.exec(`INSERT INTO workouts (id, program_id, week, day, title) VALUES ('wo_1', 'prog_1', 1, 1, 'Lower body')`);
    old.exec(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position, prescription) VALUES ('wex_1', 'wo_1', 'ex_1', 1, '5 × 5')`);
    old.exec(`INSERT INTO assignments (id, client_id, program_id, start_date, active, created_at) VALUES ('asg_1', 'cli_ava', 'prog_1', '2026-09-01', 1, '${at}')`);
    old.exec(`INSERT INTO workout_logs (id, client_id, assignment_id, workout_id, notes, completed_at, rpe, request_id) VALUES ('log_1', 'cli_ava', 'asg_1', 'wo_1', 'Felt strong', '${at}', 7, 'req-1')`);
    old.exec(`INSERT INTO workout_sets (id, workout_log_id, workout_exercise_id, exercise_id, exercise_name, set_no, weight, reps, created_at) VALUES ('set_1', 'log_1', 'wex_1', 'ex_1', 'Back squat', 1, 135, 5, '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.equal(db.get(`SELECT auto_attempts FROM invoices WHERE id = 'inv_1'`).auto_attempts, 3, 'every earlier try counts as automatic, as before');
      if (round === 1) assert.equal(db.get(`SELECT value FROM settings WHERE key = 'staff_discount_max_pct'`).value, '0', 'only the owner gives discounts');
      assert.ok(cols('leads').includes('coach_id'));
      assert.ok(cols('invoice_charges').includes('late_outcome'));
      for (const c of ['program_id', 'program_name', 'workout_title', 'workout_week', 'workout_day', 'exercises_snapshot', 'rpe', 'request_id']) assert.ok(cols('workout_logs').includes(c), `workout_logs.${c}, round ${round}`);
      const wl = db.all('PRAGMA table_info(workout_logs)').find((c) => c.name === 'workout_id');
      assert.equal(wl.notnull, 0, 'a log can outlive its workout');
      assert.deepEqual(db.all('PRAGMA foreign_key_list(workout_logs)').filter((f) => ['workouts', 'assignments'].includes(f.table)).map((f) => f.on_delete).sort(), ['SET NULL', 'SET NULL']);
      assert.deepEqual({ ...db.get(`SELECT notes, rpe, request_id FROM workout_logs WHERE id = 'log_1'`) }, { notes: 'Felt strong', rpe: 7, request_id: 'req-1' }, `the log is kept, round ${round}`);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM workout_sets').n, 1, `its sets are kept, round ${round}`);
      if (round === 1) {
        db.run(`UPDATE leads SET coach_id = 'usr_c' WHERE id = 'lead_1'`);
        db.run(`UPDATE settings SET value = '10' WHERE key = 'staff_discount_max_pct'`);     // the owner raises it again after the upgrade
        db.run(`DELETE FROM programs WHERE id = 'prog_1'`);
        assert.deepEqual({ ...db.get(`SELECT workout_id, assignment_id FROM workout_logs WHERE id = 'log_1'`) }, { workout_id: null, assignment_id: null }, 'deleting the program keeps the log');
      }
      assert.equal(db.get(`SELECT coach_id FROM leads WHERE id = 'lead_1'`).coach_id, 'usr_c', `round ${round}`);
      assert.equal(db.get(`SELECT value FROM settings WHERE key = 'staff_discount_max_pct'`).value, '10', 'the second open leaves the owner\'s new setting alone');
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 41 (the parent portal, as its branch made it: parents' and the owner's retries counted apart in
// invoices.manual_attempts) to 43: one retry counter. Tries that were manual stay uncounted (auto_attempts = attempts -
// manual_attempts), the old column goes, the portal's data is kept and the version 43 block runs.
test('a version 41 database keeps its portal data, folds manual_attempts into auto_attempts and gains the later blocks, opened twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v41.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 41');
    const at = '2026-09-01T17:00:00.000Z';
    old.exec(`INSERT INTO settings (key, value) VALUES ('staff_discount_max_pct', '15')`);
    old.exec(`INSERT INTO families (id, name, card_payment_method, card_brand, card_last4, card_exp, created_at) VALUES ('fam_1', 'Lopez family', 'pm_1', 'visa', '4242', '2027-04', '${at}')`);
    old.exec(`INSERT INTO guardians (id, family_id, name, email, is_primary, calendar_token_hash, created_at) VALUES ('gdn_1', 'fam_1', 'Maria Lopez', 'maria@example.com', 1, 'calhash', '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, family_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'fam_1', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO plans (id, name, price_cents, trial_days, active, created_at) VALUES ('plan_1', 'Monthly', 15000, 0, 1, '${at}')`);
    old.exec(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_1', 'cli_ava', 'plan_1', 'past_due', '${at}', '2026-10-01T17:00:00.000Z', '${at}', '${at}')`);
    old.exec(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, manual_attempts, created_at) VALUES ('inv_1', 'sub_1', 'cli_ava', 15000, 'failed', '${at}', '2026-10-01T17:00:00.000Z', 5, 3, '${at}')`);
    old.exec(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, created_at) VALUES ('inv_0', 'sub_1', 'cli_ava', 15000, 'paid', '2026-08-01T17:00:00.000Z', '${at}', 1, '2026-08-01T17:00:00.000Z')`);
    old.exec(`INSERT INTO membership_requests (id, client_id, subscription_id, guardian_id, kind, status, created_at) VALUES ('mrq_1', 'cli_ava', 'sub_1', 'gdn_1', 'pause', 'open', '${at}')`);
    old.exec(`INSERT INTO profile_claims (id, family_id, guardian_id, athlete_id, claimed_client_id, status, created_at) VALUES ('pcl_1', 'fam_1', 'gdn_1', 'AVALOP2026', 'cli_ava', 'open', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.ok(!cols('invoices').includes('manual_attempts'), `one retry counter, round ${round}`);
      assert.deepEqual(db.all(`SELECT id, attempts, auto_attempts FROM invoices ORDER BY id`).map((r) => ({ ...r })),
        [{ id: 'inv_0', attempts: 1, auto_attempts: 1 }, { id: 'inv_1', attempts: 5, auto_attempts: round === 1 ? 2 : 3 }], `the 3 manual tries stay uncounted, round ${round}`);
      assert.ok(cols('invoice_charges').includes('source'));
      assert.ok(cols('leads').includes('coach_id'));
      assert.equal(db.get(`SELECT card_exp FROM families WHERE id = 'fam_1'`).card_exp, '2027-04');
      assert.equal(db.get(`SELECT calendar_token_hash FROM guardians WHERE id = 'gdn_1'`).calendar_token_hash, 'calhash');
      assert.equal(db.get('SELECT COUNT(*) AS n FROM membership_requests').n, 1);
      assert.equal(db.get(`SELECT status FROM profile_claims WHERE id = 'pcl_1'`).status, 'open');
      if (round === 1) {
        assert.equal(db.get(`SELECT value FROM settings WHERE key = 'staff_discount_max_pct'`).value, '0');
        db.run(`UPDATE invoices SET auto_attempts = 3 WHERE id = 'inv_1'`);
      }
      assert.equal(db.get(`SELECT auto_attempts FROM invoices WHERE id = 'inv_1'`).auto_attempts, 3, `the second open changes nothing, round ${round}`);
      assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a version 40 database gains key access levels, the request log, webhook test events and devices, keeping its keys, webhooks and sign-ins, opened twice', async () => {
  const { listDeliveries } = await import('../src/services/events.js');
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v40.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 40');
    const at = '2026-09-01T17:00:00.000Z', later = '2099-01-01T00:00:00.000Z';
    old.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('usr_1', 'owner@test.dev', 'Olivia Owner', 'x', 'owner', '${at}')`);
    old.exec(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('hash_1', 'usr_1', '${later}'), ('hash_2', 'usr_1', '${later}')`);
    old.exec(`INSERT INTO api_keys (id, label, prefix, key_hash, created_at) VALUES ('key_1', 'Gates', 'dp_live_abcd', 'keyhash', '${at}')`);
    old.exec(`INSERT INTO webhook_endpoints (id, url, secret, events, active, created_at) VALUES ('whe_1', 'https://hooks.example.com/x', 'whsec_old', '["*"]', 1, '${at}')`);
    old.exec(`INSERT INTO events (id, type, data, created_at) VALUES ('evt_1', 'client.created', '{"client_name":"Ava Lopez"}', '${at}')`);
    old.exec(`INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempts, response_code, last_error, next_attempt_at, created_at) VALUES ('whd_1', 'whe_1', 'evt_1', 'failed', 6, 500, 'Receiver responded 500', NULL, '${at}')`);
    old.exec(`INSERT INTO outbox (id, to_email, subject, body, status, created_at) VALUES ('msg_1', 'maria@example.com', 'Welcome', 'Hello', 'sent', '${at}')`);
    old.close();
    let deviceIds;
    for (const round of [1, 2]) {
      const db = openDb(file);
      const ctx = { db, now: () => new Date().toISOString() };
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.equal(db.get(`SELECT scope FROM api_keys WHERE id = 'key_1'`).scope, 'full', 'keys from before access levels keep full access');
      for (const c of ['label', 'previous_secret', 'previous_secret_until', 'secret_rotated_at', 'failures']) assert.ok(cols('webhook_endpoints').includes(c), `webhook_endpoints.${c}`);
      for (const c of ['id', 'kind', 'created_at', 'last_seen_at', 'ip', 'user_agent']) assert.ok(cols('sessions').includes(c), `sessions.${c}`);
      assert.ok(cols('outbox').includes('sensitive'));
      assert.ok(cols('api_requests').includes('key_id') && cols('password_resets').includes('token_hash'));
      // Deliveries are kept as they were; a delivery can now be 'sending' and a test event has no event row.
      const d = listDeliveries(ctx, 'whe_1').data;
      assert.deepEqual(d.filter((x) => x.id === 'whd_1').map((x) => [x.id, x.status, x.attempts, x.response_code, x.event_type]), [['whd_1', 'failed', 6, 500, 'client.created']], `round ${round}`);
      assert.equal(db.get(`SELECT secret FROM webhook_endpoints WHERE id = 'whe_1'`).secret, 'whsec_old');
      // Signed-in devices get an id once, and keep it.
      const ids = db.all('SELECT id FROM sessions ORDER BY token_hash').map((s) => s.id);
      assert.ok(ids.every((x) => /^ses_[0-9a-f]{16}$/.test(x)) && new Set(ids).size === 2);
      if (round === 1) {
        deviceIds = ids;
        db.run(`INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, payload, test, status, attempts, created_at) VALUES ('whd_2', 'whe_1', NULL, 'test.ping', '{}', 1, 'sending', 0, ?)`, at);
      } else assert.deepEqual(ids, deviceIds, 'the second open changes nothing');
      assert.equal(db.get('SELECT COUNT(*) AS n FROM webhook_deliveries').n, 2, `round ${round}`);
      assert.equal(db.get(`SELECT sensitive FROM outbox WHERE id = 'msg_1'`).sensitive, 0);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 42 (the parent portal and API & integrations / Staff & security together, before the owner's decisions) to 43:
// keys, devices, webhooks and portal data are kept; the one retry counter replaces manual_attempts; the version 43 block
// runs once.
test('a version 42 database keeps keys, devices, webhooks and portal data and gains the owner\'s decisions, opened twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v42.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 42');
    const at = '2026-09-01T17:00:00.000Z', later = '2099-01-01T00:00:00.000Z';
    old.exec(`INSERT INTO settings (key, value) VALUES ('staff_discount_max_pct', '25')`);
    old.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('usr_1', 'owner@test.dev', 'Olivia Owner', 'x', 'owner', '${at}'), ('usr_c', 'c@test.dev', 'Carl', 'x', 'coach', '${at}')`);
    old.exec(`INSERT INTO sessions (token_hash, user_id, expires_at, id, kind, created_at) VALUES ('hash_1', 'usr_1', '${later}', 'ses_00000000000000aa', 'web', '${at}')`);
    old.exec(`INSERT INTO api_keys (id, label, prefix, key_hash, created_at, scope) VALUES ('key_1', 'Widget', 'dp_live_abcd', 'keyhash', '${at}', 'read')`);
    old.exec(`INSERT INTO api_requests (id, key_id, at, method, path, status) VALUES ('req_1', 'key_1', '${at}', 'GET', '/v1/schedule', 200)`);
    old.exec(`INSERT INTO webhook_endpoints (id, url, secret, events, active, created_at, label) VALUES ('whe_1', 'https://hooks.example.com/x', 'whsec_1', '["*"]', 1, '${at}', 'Zapier')`);
    old.exec(`INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, payload, test, status, attempts, created_at) VALUES ('whd_1', 'whe_1', NULL, 'test.ping', '{}', 1, 'sending', 0, '${at}')`);
    old.exec(`INSERT INTO families (id, name, card_payment_method, card_last4, card_exp, created_at) VALUES ('fam_1', 'Lopez family', 'pm_1', '4242', '2027-04', '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, family_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'fam_1', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO plans (id, name, price_cents, trial_days, active, created_at) VALUES ('plan_1', 'Monthly', 15000, 0, 1, '${at}')`);
    old.exec(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_1', 'cli_ava', 'plan_1', 'past_due', '${at}', '2026-10-01T17:00:00.000Z', '${at}', '${at}')`);
    old.exec(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, manual_attempts, created_at) VALUES ('inv_1', 'sub_1', 'cli_ava', 15000, 'failed', '${at}', '2026-10-01T17:00:00.000Z', 4, 2, '${at}')`);
    old.exec(`INSERT INTO membership_requests (id, client_id, kind, status, created_at) VALUES ('mrq_1', 'cli_ava', 'cancel', 'open', '${at}')`);
    old.exec(`INSERT INTO leads (id, parent_name, email, source, status, created_at, updated_at) VALUES ('lead_1', 'Gia', 'gia@example.com', 'inquiry', 'new', '${at}', '${at}')`);
    old.exec(`INSERT INTO programs (id, name, weeks, created_at) VALUES ('prog_1', 'Strength', 4, '${at}')`);
    old.exec(`INSERT INTO workouts (id, program_id, week, day, title) VALUES ('wo_1', 'prog_1', 1, 1, 'Lower body')`);
    old.exec(`INSERT INTO workout_logs (id, client_id, workout_id, rpe, completed_at) VALUES ('log_1', 'cli_ava', 'wo_1', 8, '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
      assert.ok(!cols('invoices').includes('manual_attempts'));
      assert.equal(db.get(`SELECT auto_attempts FROM invoices WHERE id = 'inv_1'`).auto_attempts, 2, 'the 2 manual tries stay uncounted');
      assert.equal(db.get(`SELECT scope FROM api_keys WHERE id = 'key_1'`).scope, 'read');
      assert.equal(db.get('SELECT COUNT(*) AS n FROM api_requests').n, 1);
      assert.equal(db.get(`SELECT id FROM sessions WHERE token_hash = 'hash_1'`).id, 'ses_00000000000000aa', 'devices keep their id');
      assert.deepEqual({ ...db.get(`SELECT status, test, event_type FROM webhook_deliveries WHERE id = 'whd_1'`) }, { status: 'sending', test: 1, event_type: 'test.ping' });
      assert.equal(db.get('SELECT COUNT(*) AS n FROM membership_requests').n, 1);
      assert.equal(db.get(`SELECT card_exp FROM families WHERE id = 'fam_1'`).card_exp, '2027-04');
      assert.equal(db.get(`SELECT rpe FROM workout_logs WHERE id = 'log_1'`).rpe, 8);
      assert.equal(db.all('PRAGMA table_info(workout_logs)').find((c) => c.name === 'workout_id').notnull, 0, 'a log can outlive its workout');
      if (round === 1) {
        assert.equal(db.get(`SELECT value FROM settings WHERE key = 'staff_discount_max_pct'`).value, '0');
        db.run(`UPDATE leads SET coach_id = 'usr_c' WHERE id = 'lead_1'`);
        db.run(`UPDATE settings SET value = '5' WHERE key = 'staff_discount_max_pct'`);
      }
      assert.equal(db.get(`SELECT coach_id FROM leads WHERE id = 'lead_1'`).coach_id, 'usr_c');
      assert.equal(db.get(`SELECT value FROM settings WHERE key = 'staff_discount_max_pct'`).value, '5', `the second open changes nothing, round ${round}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Version 45 (batch B15, CRM): a version 43 database (the schema at d18cf97, the same as 0c15914) gains the trial stage, stage history,
// the contact log, tasks, templates and group texts; its leads, their lost reasons and campaign recipients are kept.
test('a version 43 database gains the CRM: leads keep their data, get a stage history, and take the trial stage; opened twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v43.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 43');
    const at = '2026-09-01T17:00:00.000Z', later = '2026-09-10T17:00:00.000Z';
    old.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('usr_c', 'c@test.dev', 'Carl', 'x', 'coach', '${at}')`);
    old.exec(`INSERT INTO families (id, name, created_at) VALUES ('fam_1', 'Lopez family', '${at}')`);
    old.exec(`INSERT INTO leads (id, parent_name, email, phone, source, status, texts_ok, lost_reason, coach_id, created_at, updated_at) VALUES
      ('lead_new', 'Gia', 'gia@example.com', '(512) 555-0101', 'inquiry', 'new', 1, NULL, 'usr_c', '${at}', '${at}'),
      ('lead_lost', 'Hal', 'hal@example.com', NULL, 'phone', 'lost', 0, 'Went with a travel team', NULL, '${at}', '${later}'),
      ('lead_mem', 'Ida', 'ida@example.com', '5125550102', 'manual', 'member', 0, NULL, NULL, '${at}', '${later}')`);
    old.exec(`UPDATE leads SET family_id = 'fam_1', converted_at = '${later}' WHERE id = 'lead_mem'`);
    old.exec(`INSERT INTO campaigns (id, subject, body, audience, status, created_at, sent_at) VALUES ('cmp_1', 'Camp', 'Hi', '{"group":"leads"}', 'sent', '${at}', '${at}')`);
    old.exec(`INSERT INTO campaign_recipients (id, campaign_id, email, name, lead_id, token, sent_at) VALUES ('cr_1', 'cmp_1', 'gia@example.com', 'Gia', 'lead_new', 'tok_cr_1', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
      assert.equal(db.get('PRAGMA foreign_key_check'), undefined, 'no broken links');
      for (const c of ['stage_changed_at', 'last_activity_at', 'client_id', 'lost_note', 'texts_ok_source', 'texts_ok_at', 'coach_id']) assert.ok(cols('leads').includes(c), `leads.${c}`);
      for (const t of ['lead_stage_history', 'lead_activity', 'crm_tasks', 'message_templates']) assert.ok(cols(t).length, t);
      const g = db.get(`SELECT * FROM leads WHERE id = 'lead_new'`);
      assert.deepEqual([g.phone, g.texts_ok, g.coach_id, g.stage_changed_at], ['+15125550101', 1, 'usr_c', at], 'the phone is cleaned up; the coach and text OK stay');
      const h = db.get(`SELECT * FROM leads WHERE id = 'lead_lost'`);
      assert.deepEqual([h.lost_reason, h.lost_note, h.stage_changed_at], ['other', 'Went with a travel team', later], 'a reason in words becomes the note');
      assert.equal(db.get(`SELECT family_id FROM leads WHERE id = 'lead_mem'`).family_id, 'fam_1');
      assert.deepEqual(db.all(`SELECT from_stage, to_stage, at FROM lead_stage_history WHERE lead_id = 'lead_mem' ORDER BY at`).map((r) => ({ ...r })),
        [{ from_stage: null, to_stage: 'new', at }, { from_stage: 'new', to_stage: 'member', at: later }], 'one history, not one per open');
      assert.equal(db.get('SELECT COUNT(*) AS n FROM lead_stage_history').n, 5);
      assert.equal(db.get(`SELECT channel FROM campaigns WHERE id = 'cmp_1'`).channel, 'email');
      assert.deepEqual({ ...db.get(`SELECT email, phone, lead_id FROM campaign_recipients WHERE id = 'cr_1'`) }, { email: 'gia@example.com', phone: null, lead_id: 'lead_new' });
      assert.equal(db.all('PRAGMA table_info(campaign_recipients)').find((c) => c.name === 'email').notnull, 0, 'a group text has no email');
      if (round === 1) {
        // The rebuilt table takes the new stage and sources.
        db.run(`UPDATE leads SET status = 'trial' WHERE id = 'lead_new'`);
        db.run(`INSERT INTO leads (id, parent_name, source, status, created_at, updated_at) VALUES ('lead_imp', 'Imp', 'import', 'new', '${at}', '${at}')`);
        assert.throws(() => db.run(`UPDATE leads SET status = 'maybe' WHERE id = 'lead_new'`), /CHECK/);
      }
      assert.equal(db.get(`SELECT status FROM leads WHERE id = 'lead_new'`).status, 'trial', `round ${round}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Upgraded from 40, 41, 42, 43 or 44, a database has the same tables and columns as a new one.
test('databases upgraded from versions 40, 41, 42, 43 and 44 have the same tables and columns as a new one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  try {
    const shape = (db) => Object.fromEntries(db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .map((t) => [t.name, db.all(`PRAGMA table_info(${t.name})`).map((c) => c.name).sort()]));
    const fresh = openDb(join(dir, 'new.db'));
    const want = shape(fresh);
    fresh.close();
    for (const v of [40, 41, 42, 43, 44]) {
      const file = join(dir, `v${v}.db`);
      const old = new DatabaseSync(file);
      old.exec(readFileSync(new URL(`./fixtures/schema-v${v}.sql`, import.meta.url), 'utf8'));
      old.exec(`PRAGMA user_version = ${v}`);
      old.close();
      const db = openDb(file);
      assert.deepEqual(shape(db), want, `upgraded from ${v}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Version 44 (batch B11): Education, coach side ----
test('a version 40 database gains lesson opens and reading reminders, keeps its reading, and opening it twice is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v40.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 40');
    const at = '2026-09-01T17:00:00.000Z';
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO lessons (id, title, published, position, created_at, updated_at) VALUES ('les_1', 'Sleep', 1, 0, '${at}', '${at}')`);
    old.exec(`INSERT INTO lesson_progress (lesson_id, client_id, completed_at) VALUES ('les_1', 'cli_ava', '${at}')`);
    old.exec(`INSERT INTO lesson_assignments (id, lesson_id, client_id, due_date, note, created_at) VALUES ('lasg_1', 'les_1', 'cli_ava', '2026-09-10', 'Read it', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.deepEqual(cols('lesson_views'), ['lesson_id', 'client_id', 'opened_at']);
      assert.deepEqual(cols('lesson_reminders'), ['id', 'assignment_id', 'client_id', 'sent_by', 'sent_at']);
      assert.deepEqual({ ...db.get(`SELECT due_date, note FROM lesson_assignments WHERE id = 'lasg_1'`) }, { due_date: '2026-09-10', note: 'Read it' }, `reading is kept, round ${round}`);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM lesson_progress').n, 1);
      if (round === 1) {
        db.run(`INSERT INTO lesson_views (lesson_id, client_id, opened_at) VALUES ('les_1', 'cli_ava', ?)`, at);
        db.run(`INSERT INTO lesson_reminders (id, assignment_id, client_id, sent_at) VALUES ('lrem_1', 'lasg_1', 'cli_ava', ?)`, at);
      }
      assert.equal(db.get('SELECT COUNT(*) AS n FROM lesson_views').n, 1, `round ${round}`);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM lesson_reminders').n, 1, `round ${round}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 43 (d18cf97: the parent portal, API & integrations, Staff & security and the owner's decisions together) to 44
// (Education): the reading, charge tries, leads for a coach and workout logs that outlive their program are kept; the
// version 43 block does not run again (a staff discount limit set after it stays); the Education tables are added.
test('a version 43 database keeps its reading, charge tries and orphaned logs and gains lesson opens and reading reminders, opened twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v43.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 43');
    const at = '2026-09-01T17:00:00.000Z';
    old.exec(`INSERT INTO settings (key, value) VALUES ('staff_discount_max_pct', '10')`);
    old.exec(`INSERT INTO users (id, email, name, password_hash, role, active, created_at) VALUES ('usr_c', 'c@x.dev', 'Carl', 'x', 'coach', 1, '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO plans (id, name, price_cents, trial_days, active, created_at) VALUES ('plan_1', 'Monthly', 15000, 0, 1, '${at}')`);
    old.exec(`INSERT INTO subscriptions (id, client_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_1', 'cli_ava', 'plan_1', 'past_due', '${at}', '2026-10-01T17:00:00.000Z', '${at}', '${at}')`);
    old.exec(`INSERT INTO invoices (id, subscription_id, client_id, amount_cents, status, period_start, period_end, attempts, auto_attempts, created_at) VALUES ('inv_1', 'sub_1', 'cli_ava', 15000, 'failed', '${at}', '2026-10-01T17:00:00.000Z', 3, 1, '${at}')`);
    old.exec(`INSERT INTO leads (id, parent_name, email, source, status, coach_id, created_at, updated_at) VALUES ('lead_1', 'Gia', 'gia@example.com', 'inquiry', 'new', 'usr_c', '${at}', '${at}')`);
    old.exec(`INSERT INTO workout_logs (id, client_id, workout_id, program_name, workout_title, rpe, completed_at) VALUES ('log_1', 'cli_ava', NULL, 'Strength', 'Lower body', 7, '${at}')`);
    old.exec(`INSERT INTO lessons (id, title, published, position, created_at, updated_at) VALUES ('les_1', 'Sleep', 1, 0, '${at}', '${at}')`);
    old.exec(`INSERT INTO lesson_progress (lesson_id, client_id, completed_at) VALUES ('les_1', 'cli_ava', '${at}')`);
    old.exec(`INSERT INTO lesson_assignments (id, lesson_id, client_id, due_date, note, created_at) VALUES ('lasg_1', 'les_1', 'cli_ava', '2026-09-10', 'Read it', '${at}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
      assert.deepEqual(cols('lesson_views'), ['lesson_id', 'client_id', 'opened_at']);
      assert.deepEqual(cols('lesson_reminders'), ['id', 'assignment_id', 'client_id', 'sent_by', 'sent_at']);
      assert.equal(db.get(`SELECT value FROM settings WHERE key = 'staff_discount_max_pct'`).value, '10', 'the version 43 block does not run again');
      assert.deepEqual({ ...db.get(`SELECT attempts, auto_attempts FROM invoices WHERE id = 'inv_1'`) }, { attempts: 3, auto_attempts: 1 });
      assert.equal(db.get(`SELECT coach_id FROM leads WHERE id = 'lead_1'`).coach_id, 'usr_c');
      assert.deepEqual({ ...db.get(`SELECT workout_id, workout_title, rpe FROM workout_logs WHERE id = 'log_1'`) }, { workout_id: null, workout_title: 'Lower body', rpe: 7 }, 'a log without its workout is kept');
      assert.deepEqual({ ...db.get(`SELECT due_date, note FROM lesson_assignments WHERE id = 'lasg_1'`) }, { due_date: '2026-09-10', note: 'Read it' }, `reading is kept, round ${round}`);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM lesson_progress').n, 1);
      if (round === 1) {
        db.run(`INSERT INTO lesson_views (lesson_id, client_id, opened_at) VALUES ('les_1', 'cli_ava', ?)`, at);
        db.run(`INSERT INTO lesson_reminders (id, assignment_id, client_id, sent_by, sent_at) VALUES ('lrem_1', 'lasg_1', 'cli_ava', 'usr_c', ?)`, at);
      }
      assert.equal(db.get('SELECT COUNT(*) AS n FROM lesson_views').n, 1, `the second open keeps data written after the upgrade, round ${round}`);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM lesson_reminders').n, 1, `round ${round}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 44 (b1160e5: everything before the CRM, Education included) to 45 (the CRM): leads, campaigns, opt-outs and
// the Education reading, lesson opens and reminders are all kept; leads are rebuilt with the trial stage and a stage
// history; the version 43 and 44 blocks don't run again.
test('a version 44 database keeps its leads, campaigns and Education data and gains the CRM, opened twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-migrate-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v44.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 44');
    const at = '2026-09-01T17:00:00.000Z', later = '2026-09-12T17:00:00.000Z';
    old.exec(`INSERT INTO settings (key, value) VALUES ('staff_discount_max_pct', '15')`);
    old.exec(`INSERT INTO users (id, email, name, password_hash, role, active, created_at) VALUES ('usr_c', 'c@x.dev', 'Carl', 'x', 'coach', 1, '${at}')`);
    old.exec(`INSERT INTO families (id, name, created_at) VALUES ('fam_1', 'Lopez family', '${at}')`);
    old.exec(`INSERT INTO clients (id, name, athlete_id, family_id, access_token, created_at) VALUES ('cli_ava', 'Ava Lopez', 'AVALOP2026', 'fam_1', 'tok-ava', '${at}')`);
    old.exec(`INSERT INTO leads (id, parent_name, email, phone, source, status, texts_ok, lost_reason, coach_id, created_at, updated_at) VALUES
      ('lead_new', 'Gia', 'gia@example.com', '512-555-0101', 'inquiry', 'new', 1, NULL, 'usr_c', '${at}', '${at}'),
      ('lead_lost', 'Hal', 'hal@example.com', NULL, 'referral', 'lost', 0, 'Too far to drive', NULL, '${at}', '${later}'),
      ('lead_mem', 'Maria', 'maria@example.com', NULL, 'manual', 'member', 0, NULL, NULL, '${at}', '${later}')`);
    old.exec(`UPDATE leads SET family_id = 'fam_1', converted_at = '${later}' WHERE id = 'lead_mem'`);
    old.exec(`INSERT INTO campaigns (id, subject, body, audience, status, created_at, sent_at) VALUES ('cmp_1', 'Camp', 'Hi', '{"group":"leads"}', 'sent', '${at}', '${at}')`);
    old.exec(`INSERT INTO campaign_recipients (id, campaign_id, email, name, lead_id, token, sent_at, unsubscribed_at) VALUES
      ('cr_1', 'cmp_1', 'gia@example.com', 'Gia', 'lead_new', 'tok_cr_1', '${at}', NULL),
      ('cr_2', 'cmp_1', 'hal@example.com', 'Hal', 'lead_lost', 'tok_cr_2', '${at}', '${later}')`);
    old.exec(`INSERT INTO email_optouts (email, source, created_at) VALUES ('hal@example.com', 'campaign', '${later}')`);
    old.exec(`INSERT INTO lessons (id, title, published, position, created_at, updated_at) VALUES ('les_1', 'Sleep', 1, 0, '${at}', '${at}')`);
    old.exec(`INSERT INTO lesson_assignments (id, lesson_id, client_id, due_date, note, created_at) VALUES ('lasg_1', 'les_1', 'cli_ava', '2026-09-10', 'Read it', '${at}')`);
    old.exec(`INSERT INTO lesson_views (lesson_id, client_id, opened_at) VALUES ('les_1', 'cli_ava', '${at}')`);
    old.exec(`INSERT INTO lesson_reminders (id, assignment_id, client_id, sent_by, sent_at) VALUES ('lrem_1', 'lasg_1', 'cli_ava', 'usr_c', '${later}')`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(file);
      const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
      assert.equal(db.get('PRAGMA user_version').user_version, LATEST, `round ${round}`);
      assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
      assert.equal(db.get('PRAGMA foreign_key_check'), undefined, 'no broken links');
      for (const t of ['lead_stage_history', 'lead_activity', 'crm_tasks', 'message_templates']) assert.ok(cols(t).length, t);
      assert.equal(db.get(`SELECT value FROM settings WHERE key = 'staff_discount_max_pct'`).value, '15', 'the version 43 block does not run again');
      // Leads
      assert.equal(db.get('SELECT COUNT(*) AS n FROM leads').n, round === 1 ? 3 : 4);
      const g = db.get(`SELECT * FROM leads WHERE id = 'lead_new'`);
      assert.deepEqual([g.phone, g.texts_ok, g.coach_id, g.stage_changed_at], ['+15125550101', 1, 'usr_c', at]);
      const h = db.get(`SELECT * FROM leads WHERE id = 'lead_lost'`);
      assert.deepEqual([h.lost_reason, h.lost_note, h.source], ['other', 'Too far to drive', 'referral']);
      assert.deepEqual({ ...db.get(`SELECT family_id, converted_at FROM leads WHERE id = 'lead_mem'`) }, { family_id: 'fam_1', converted_at: later });
      assert.equal(db.get(`SELECT COUNT(*) AS n FROM lead_stage_history WHERE lead_id IN ('lead_new', 'lead_lost', 'lead_mem')`).n, 5, 'one history, not one per open');
      // Campaigns and opt-outs
      assert.equal(db.get(`SELECT channel FROM campaigns WHERE id = 'cmp_1'`).channel, 'email');
      assert.deepEqual(db.all('SELECT id, email, lead_id, unsubscribed_at FROM campaign_recipients ORDER BY id').map((r) => ({ ...r })),
        [{ id: 'cr_1', email: 'gia@example.com', lead_id: 'lead_new', unsubscribed_at: null }, { id: 'cr_2', email: 'hal@example.com', lead_id: 'lead_lost', unsubscribed_at: later }]);
      assert.equal(db.get(`SELECT source FROM email_optouts WHERE email = 'hal@example.com'`).source, 'campaign');
      // Education
      assert.deepEqual({ ...db.get(`SELECT due_date, note FROM lesson_assignments WHERE id = 'lasg_1'`) }, { due_date: '2026-09-10', note: 'Read it' });
      assert.equal(db.get('SELECT COUNT(*) AS n FROM lesson_views').n, 1);
      assert.deepEqual({ ...db.get(`SELECT assignment_id, sent_by FROM lesson_reminders WHERE id = 'lrem_1'`) }, { assignment_id: 'lasg_1', sent_by: 'usr_c' });
      if (round === 1) {
        db.run(`UPDATE leads SET status = 'trial' WHERE id = 'lead_new'`);
        db.run(`INSERT INTO leads (id, parent_name, source, status, created_at, updated_at) VALUES ('lead_imp', 'Imp', 'import', 'new', ?, ?)`, at, at);
      }
      assert.equal(db.get(`SELECT status FROM leads WHERE id = 'lead_new'`).status, 'trial', `the second open changes nothing, round ${round}`);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
