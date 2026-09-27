// A database from the previous version (schema 30, commit 7349d1e) opens with this version: new columns and tables are
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
      assert.ok(cols('job_runs').includes('error') && cols('job_state').includes('lease_until'));   // background jobs, version 33
      assert.equal(db.get('PRAGMA user_version').user_version, 33);
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
      assert.equal(db.get('PRAGMA user_version').user_version, 33);
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
