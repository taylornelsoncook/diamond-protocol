import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId, token } from './util.js';
import { newAthleteId } from './services/athlete-ids.js';

// Thin wrapper over node:sqlite. Every query in the app goes through all/get/run/tx,
// so moving to Postgres later means reimplementing this file and adjusting SQL dialect.
export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  migrate(raw, schema);
  raw.exec(schema);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  const plain = (row) => (row ? { ...row } : undefined);
  let depth = 0;
  return {
    all: (sql, ...p) => stmt(sql).all(...clean(p)).map(plain),
    get: (sql, ...p) => plain(stmt(sql).get(...clean(p))),
    run: (sql, ...p) => stmt(sql).run(...clean(p)),
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN IMMEDIATE');
      try { const out = fn(); raw.exec('COMMIT'); return out; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
      finally { depth--; }
    },
    close: () => raw.close()
  };
}

// Brings databases created by earlier versions up to the current schema.
// Tables whose constraints changed are rebuilt from their definition in schema.sql (SQLite's documented method).
const SCHEMA_VERSION = 38;
const REBUILD = { 2: ['clients', 'products', 'session_credits'] };
// Whole tables added in a version, created from their definition in schema.sql.
const ADDED_TABLES = {
  12: ['daily_checkins', 'goals', 'goal_checks', 'coach_messages', 'message_reads', 'test_targets', 'courses', 'lessons', 'lesson_progress', 'lesson_assignments'],   // accountability, targets, education
  13: ['texts'],                                                          // text messages
  14: ['leads'],                                                          // leads and follow-up
  15: ['pay_links'],                                                      // pay links
  16: ['kiosks'],                                                         // self check-in tablets
  17: ['product_variants', 'stock_moves'],                                // retail inventory
  18: ['review_requests'],                                                // Google review requests
  19: ['campaigns', 'campaign_recipients', 'email_optouts'],              // announcement emails
  22: ['skill_badges', 'badge_awards'],                                   // skill badges
  24: ['quiz_attempts', 'course_certificates'],                           // lesson quizzes and course certificates
  25: ['guardian_lesson_progress'],                                       // parent education
  26: ['purchases'],                                                      // programs and courses sold online
  27: ['spot_offers'],                                                    // open-spot offers for light classes
  28: ['progress_notes'],                                                 // progress notes for parents
  29: ['money_checks'],                                                   // daily money checks
  30: ['guardian_message_reads'],                                         // parents' own read state for coach messages
  31: ['time_off', 'client_notes'],                                       // coach time off, staff notes on clients
  33: ['job_runs', 'job_state'],                                          // background job history and leases
  // ---- version 34 (batch B10): test presets and report share links
  34: ['test_presets', 'report_links'],
  // ---- Version 35: testing days, undo an upload (B9) ----
  35: ['import_batch_items'],
  // ---- version 36 (batch B5, point of sale): refunds with their own date, for the day's takings
  36: ['sale_refunds'],
  // ---- Version 37: one profile per athlete (team roster athletes are clients) ----
  37: ['athlete_id_aliases'],
  // ---- Version 38: billing (batch B6): membership refunds with their own rows ----
  38: ['invoice_refunds']
};
const ADDED_COLUMNS = {
  clients: ['stripe_customer_id TEXT', 'card_payment_method TEXT', 'card_brand TEXT', 'card_last4 TEXT', 'athlete_id TEXT', "sex TEXT CHECK (sex IN ('M','F'))", 'archived_at TEXT', 'archived_by TEXT'],   // athlete_id: version 6, sex: version 10, archive: version 31
  team_roster: ['athlete_id TEXT'],
  subscriptions: ['trial_reminded_at TEXT'],                              // version 11
  guardians: ['sms_opt_in_at TEXT', 'sms_opt_out_at TEXT'],               // version 13
  bookings: ['reminded_at TEXT'],                                         // version 13
  locations: ['checkin_code TEXT'],                                       // version 16
  products: ['track_stock INTEGER NOT NULL DEFAULT 0', 'low_stock_at INTEGER'],   // version 17
  sale_items: ['variant_id TEXT'],                                        // version 17
  workout_exercises: ['load_test TEXT', 'load_pct INTEGER'],             // version 21: weights from tested maxes
  coach_messages: ["from_kind TEXT NOT NULL DEFAULT 'coach'", 'author_name TEXT', 'guardian_id TEXT', 'staff_read_at TEXT'],   // version 20: replies
  class_series: ['contract_id TEXT REFERENCES team_contracts(id) ON DELETE SET NULL', 'coach_id TEXT REFERENCES users(id) ON DELETE SET NULL'],      // version 4; coach: version 31
  class_sessions: ['workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL', 'coach_id TEXT REFERENCES users(id) ON DELETE SET NULL'],           // version 23: weight-room screen; coach: version 31
  availability: ['coach_id TEXT REFERENCES users(id) ON DELETE SET NULL'],                  // version 31
  workout_logs: ['session_id TEXT REFERENCES class_sessions(id) ON DELETE SET NULL'],        // version 23 (then rebuilt so assignment_id can be empty)
  lessons: ['quiz TEXT'],                                                                     // version 24: lesson quizzes
  courses: ["audience TEXT NOT NULL DEFAULT 'athletes' CHECK (audience IN ('athletes','parents'))", 'age_min INTEGER', 'age_max INTEGER', 'for_sale INTEGER NOT NULL DEFAULT 0', 'price_cents INTEGER'],   // version 25: parent education; 26: sold online
  programs: ['for_sale INTEGER NOT NULL DEFAULT 0', 'price_cents INTEGER'],                  // version 26: sold online
  spot_offers: ['price_cents INTEGER'],                                                       // version 32: trial offers at a special price
  // ---- version 34 (batch B10): coach-written protocols, edits to built-in tests that survive the library refresh, possible ranges
  perf_tests: ['protocol TEXT', "edited TEXT NOT NULL DEFAULT '[]'"],
  perf_metrics: ['min_value REAL', 'max_value REAL'],
  // ---- Version 35: testing days (families emailed), undo an upload (B9) ----
  perf_sessions: ['shared_at TEXT', 'parent_note TEXT', 'notified_at TEXT'],                  // shared: version 10; notified_at: version 35
  import_batches: ['kind TEXT', 'source_label TEXT', 'result_source TEXT', 'session_id TEXT', 'replaced INTEGER NOT NULL DEFAULT 0', 'unchanged INTEGER NOT NULL DEFAULT 0',
    'prs INTEGER NOT NULL DEFAULT 0', "added_tests TEXT NOT NULL DEFAULT '[]'", 'created_by TEXT', 'undone_at TEXT', 'undone_by TEXT', 'undo_summary TEXT'],
  // ---- version 36 (batch B5, point of sale): discounts, a second press of Charge, emailed and printable receipts
  sales: ['discount_cents INTEGER NOT NULL DEFAULT 0', 'discount_reason TEXT', 'request_id TEXT', 'receipt_opt INTEGER', 'receipt_email TEXT', 'receipt_sent_at TEXT', 'receipt_token TEXT',
    'booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL'],        // booking_id: version 38
  // ---- Version 38: billing (batch B6): refunds, card reminders, voids and payments recorded by hand ----
  invoices: ['refunded_cents INTEGER NOT NULL DEFAULT 0', 'reminded_at TEXT', 'voided_at TEXT', 'void_reason TEXT', 'paid_method TEXT', 'paid_reference TEXT']
};

function migrate(raw, schema) {
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  const hasTables = raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'clients'`).get().n > 0;
  if (!hasTables) return;                                  // brand-new database: schema.sql creates everything
  if (version >= SCHEMA_VERSION) return;
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const existing = raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!existing.length) continue;                        // table is created later by schema.sql
    for (const col of cols) if (!existing.includes(col.split(' ')[0])) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
  }
  if (version < 3) rebuild(raw, schema, ['clients', 'products', 'session_credits'], ['families', 'guardians']);
  if (version < 9) rebuild(raw, schema, ['users']);                                   // staff roles and sign-in protection
  if (version < 15) rebuild(raw, schema, ['sales']);                                  // 'online' payment method for pay links
  if (version < 23) rebuild(raw, schema, ['workout_logs']);                           // screen logs without a program assignment
  for (const [v, tables] of Object.entries(ADDED_TABLES)) if (version < Number(v)) for (const t of tables) raw.exec(createStatement(schema, t));
  // Version 35: device names are matched in lower case, so results that waited under "Swift" join "swift".
  if (version < 35 && raw.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'results_queue'`).get()) {
    raw.exec('UPDATE results_queue SET provider = lower(trim(provider)) WHERE provider != lower(trim(provider))');
  }
  // Version 36: refunds made before refunds had their own rows get one (dated when the sale was paid, the best we know),
  // so a sale's details and the day's takings add up; paid sales get a receipt link.
  if (version < 36 && raw.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sales'`).get()) {
    raw.exec(`INSERT INTO sale_refunds (id, sale_id, amount_cents, kind, reason, created_at)
      SELECT 'ref_' || lower(hex(randomblob(8))), id, refunded_cents, 'refund', 'Refunded before refunds were logged', COALESCE(completed_at, created_at) FROM sales
      WHERE refunded_cents > 0 AND id NOT IN (SELECT sale_id FROM sale_refunds)`);
    raw.exec(`UPDATE sales SET receipt_token = lower(hex(randomblob(18))) WHERE receipt_token IS NULL AND (client_id IS NULL OR client_id NOT IN (SELECT id FROM clients WHERE name = 'Deleted athlete'))`);
  }
  // ---- Version 37: one profile per athlete ----
  if (version < 37) oneProfilePerAthlete(raw, schema);
  // ---- Version 38: billing (batch B6) ----
  // A sale taken for a booking said so in its note ('booking:<id>'); now it's the sale's booking_id. Copied for every such
  // sale whose booking still exists, so a Tap to Pay sale still waiting for the card when the upgrade runs settles its
  // booking when it's paid. The note is left as it was (it is only a note now).
  if (version < 38 && raw.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sales'`).get()) {
    raw.exec(`UPDATE sales SET booking_id = substr(note, 9) WHERE booking_id IS NULL AND note LIKE 'booking:%' AND substr(note, 9) IN (SELECT id FROM bookings)`);
  }
}

// ---------- Version 37: one profile per athlete ----------
// Before version 37 a team athlete could be only a roster line with its own Athlete ID, results, device links and
// attendance. Now every roster line links a client and everything is kept on that client:
// - A line without a client gets one (name, position, grad year; the school for a school team; no family, no membership),
//   with the line's own Athlete ID, so printed IDs keep working. If a client already has that ID (only possible in
//   hand-edited data), the new client gets the next free ID; the old ID keeps finding the client that had it, as before.
// - A line already linked to a client keeps that client; the line's own ID becomes an alias of the client, so sheets and
//   devices that use it still land on the right profile.
// - Results, device links, testing day athlete lists and team attendance move from the line to its client. A result that
//   is now on the profile twice (same test, metric, side, attempt, value, time and testing day, from the client and the
//   line) is kept once: the extra copy is set aside (voided), never deleted, and nothing that points at it breaks.
// Everything happens in one transaction; each collision and merged duplicate is written to the audit log, and the
// counts to the upgrade_v37 setting.
function oneProfilePerAthlete(raw, schema) {
  const has = (t) => !!raw.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  if (!has('team_roster')) return;
  const cols = (t) => (has(t) ? raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) : []);
  const get = (sql, ...p) => { const r = raw.prepare(sql).get(...p); return r ? { ...r } : undefined; };
  const all = (sql, ...p) => raw.prepare(sql).all(...p).map((r) => ({ ...r }));
  const run = (sql, ...p) => raw.prepare(sql).run(...p);
  const now = new Date().toISOString();
  const ctx = { db: { get, all, run }, now: () => now };
  const stats = { roster_lines: 0, clients_created: 0, already_linked: 0, deleted_profiles: 0, deleted_results_set_aside: 0, slot_conflicts: 0, aliases: 0, collisions: [], results_moved: 0, duplicates_set_aside: 0, device_links_moved: 0, testing_days_updated: 0, attendance_moved: 0, attendance_merged: 0 };
  const log = (message, target = null) => {
    if (has('audit_log')) run('INSERT INTO audit_log (id, at, actor_type, actor_name, action, target) VALUES (?, ?, ?, ?, ?, ?)', newId('aud'), now, 'system', 'Upgrade to version 37', message, target);
  };
  const addAlias = (id, clientId, line) => {
    const owner = get('SELECT id FROM clients WHERE athlete_id = ?', id), alias = get('SELECT client_id FROM athlete_id_aliases WHERE athlete_id = ?', id);
    if (owner && owner.id !== clientId) {
      stats.collisions.push({ athlete_id: id, roster_id: line.id, kept_on: owner.id });
      log(`Roster line ${line.name} (${id}) is linked to another profile, but ${id} already belongs to a different client, so ${id} keeps finding that client.`, clientId);
      return;
    }
    if (owner || (alias && alias.client_id === clientId)) return;
    if (alias) { stats.collisions.push({ athlete_id: id, roster_id: line.id, kept_on: alias.client_id }); log(`${id} (roster line ${line.name}) already finds another profile; left as it is.`, clientId); return; }
    run('INSERT INTO athlete_id_aliases (athlete_id, client_id, source, created_at) VALUES (?, ?, ?, ?)', id, clientId, 'roster', now);
    stats.aliases++;
  };
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('BEGIN');
  try {
    raw.exec('DROP INDEX IF EXISTS roster_athlete_id');   // several roster lines (teams) now share their client's ID
    const clientCols = cols('clients');
    const lines = all(`SELECT r.*, o.name AS org_name, o.kind AS org_kind FROM team_roster r LEFT JOIN team_contracts t ON t.id = r.contract_id LEFT JOIN organizations o ON o.id = t.org_id ORDER BY r.created_at, r.id`);
    stats.roster_lines = lines.length;
    for (const line of lines) {
      const aid = line.athlete_id ? String(line.athlete_id).trim().toUpperCase() : null;
      const client = line.client_id ? get('SELECT id, athlete_id, access_token FROM clients WHERE id = ?', line.client_id) : null;
      if (client && String(client.access_token ?? '').startsWith('gone_')) {
        // Linked to a profile whose family was deleted (before version 37 that left the roster line alone). Do what a
        // deletion does now: the line comes off the roster with no name or ID, its device links go, and its results are
        // set aside (voided, not deleted) on the nameless profile. Its old ID finds nobody, so nothing new lands there.
        run(`UPDATE team_roster SET name = 'Deleted athlete', athlete_id = NULL, position = NULL, grad_year = NULL, active = 0 WHERE id = ?`, line.id);
        if (cols('perf_results').includes('roster_id')) stats.deleted_results_set_aside += run('UPDATE perf_results SET client_id = ?, roster_id = NULL, voided = 1 WHERE roster_id = ?', client.id, line.id).changes;
        if (cols('athlete_links').includes('roster_id')) run('DELETE FROM athlete_links WHERE roster_id = ?', line.id);
        stats.deleted_profiles++;
        log('A team roster athlete whose family was deleted came off the roster; their roster results were set aside.', client.id);
        continue;
      }
      if (client) {
        stats.already_linked++;
        if (aid && aid !== client.athlete_id) {
          if (!client.athlete_id && !get('SELECT 1 FROM clients WHERE athlete_id = ?', aid)) run('UPDATE clients SET athlete_id = ? WHERE id = ?', aid, client.id);
          else addAlias(aid, client.id, line);
        }
        continue;
      }
      // A roster-only athlete: a new client with the line's ID.
      let id = aid;
      if (!id || get('SELECT 1 FROM clients WHERE athlete_id = ?', id) || get('SELECT 1 FROM athlete_id_aliases WHERE athlete_id = ?', id)) {
        run('UPDATE team_roster SET athlete_id = NULL WHERE id = ?', line.id);   // so the line's own ID doesn't block the new one
        id = newAthleteId(ctx, line.name, line.created_at);
        if (aid) {
          const had = get('SELECT id FROM clients WHERE athlete_id = ?', aid) ?? get('SELECT client_id AS id FROM athlete_id_aliases WHERE athlete_id = ?', aid);
          stats.collisions.push({ athlete_id: aid, roster_id: line.id, kept_on: had?.id ?? null, new_athlete_id: id });
          log(`Roster athlete ${line.name} had the ID ${aid}, which already belongs to another client. Their new profile's Athlete ID is ${id}; ${aid} keeps finding the client that had it.`, null);
        }
      }
      const cid = newId('cli');
      const row = { id: cid, name: line.name, athlete_id: id, position: line.position ?? null, grad_year: line.grad_year ?? null, school: line.org_kind === 'school' ? line.org_name : null, access_token: token(24), created_at: line.created_at };
      const keys = Object.keys(row).filter((k) => clientCols.includes(k));
      run(`INSERT INTO clients (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
      run('UPDATE team_roster SET client_id = ? WHERE id = ?', cid, line.id);
      stats.clients_created++;
    }
    // Two roster-only lines with the same name became two profiles (never merged by name). Say so, so the owner can check.
    for (const d of all(`SELECT lower(r.name) AS n, COUNT(DISTINCT r.client_id) AS k FROM team_roster r GROUP BY lower(r.name) HAVING k > 1`)) log(`${d.k} athletes named "${d.n}" are on team rosters as separate profiles. If they're the same person, move one onto the other's profile.`, null);
    // Roster lines carry a copy of their client's ID.
    run('UPDATE team_roster SET athlete_id = (SELECT c.athlete_id FROM clients c WHERE c.id = team_roster.client_id) WHERE client_id IS NOT NULL');

    // Results: from the line to its client. Remember where each came from, to spot copies from two profiles.
    if (cols('perf_results').includes('roster_id')) {
      const origin = new Map(all('SELECT id, roster_id, client_id FROM perf_results').map((r) => [r.id, r.roster_id ? `r:${r.roster_id}` : `c:${r.client_id}`]));
      stats.results_moved = run(`UPDATE perf_results SET client_id = (SELECT t.client_id FROM team_roster t WHERE t.id = perf_results.roster_id), roster_id = NULL
        WHERE roster_id IS NOT NULL AND (SELECT t.client_id FROM team_roster t WHERE t.id = perf_results.roster_id) IS NOT NULL`).changes;
      if (stats.results_moved) {
        const groups = all(`SELECT GROUP_CONCAT(id, ',') AS ids FROM perf_results WHERE voided = 0 AND client_id IS NOT NULL
          GROUP BY client_id, test_id, metric, COALESCE(side, ''), COALESCE(attempt, -1), value, recorded_at, COALESCE(session_id, '') HAVING COUNT(*) > 1`);
        for (const g of groups) {
          const rows = g.ids.split(',').map((id) => get('SELECT id, created_at FROM perf_results WHERE id = ?', id)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
          const byOrigin = new Map();
          for (const r of rows) { const o = origin.get(r.id); if (!byOrigin.has(o)) byOrigin.set(o, []); byOrigin.get(o).push(r); }
          if (byOrigin.size < 2) continue;                   // copies from one profile were there before: left alone
          // Keep the client's own copies (or the earliest origin's), and as many copies as the fullest origin had.
          const origins = [...byOrigin.keys()].sort((a, b) => (a.startsWith('c:') ? -1 : 0) - (b.startsWith('c:') ? -1 : 0) || byOrigin.get(a)[0].created_at.localeCompare(byOrigin.get(b)[0].created_at));
          const keep = byOrigin.get(origins[0]);
          for (const o of origins.slice(1)) {
            for (const [i, r] of byOrigin.get(o).entries()) {
              if (i >= keep.length) { keep.push(r); continue; }
              run(`UPDATE perf_results SET voided = 1, notes = trim(COALESCE(notes, '') || ' ' || ?) WHERE id = ?`, `(Same result as ${keep[i].id}, merged onto one profile in the version 37 upgrade.)`, r.id);
              stats.duplicates_set_aside++;
              log(`Result ${r.id} was on the athlete's profile twice (from the team roster and the client); the copy was set aside.`, r.id);
            }
          }
        }
        // One attempt on a testing day with two different values, one from the roster and one from the client: both are
        // kept (neither is known to be wrong), and the coach is told so they can delete the wrong one.
        const slots = all(`SELECT client_id, session_id, GROUP_CONCAT(id, ',') AS ids FROM perf_results WHERE voided = 0 AND client_id IS NOT NULL AND session_id IS NOT NULL AND attempt IS NOT NULL
          GROUP BY client_id, session_id, test_id, metric, COALESCE(side, ''), attempt HAVING COUNT(DISTINCT value) > 1`);
        for (const s of slots) {
          if (new Set(s.ids.split(',').map((id) => origin.get(id)?.[0])).size < 2) continue;   // not caused by the merge
          stats.slot_conflicts++;
          log(`Results ${s.ids.split(',').join(' and ')} are the same attempt on one testing day with different values (one from the team roster, one from the client). Both were kept: delete the wrong one on the testing day.`, s.client_id);
        }
      }
    }
    // Device links.
    if (cols('athlete_links').includes('roster_id')) {
      stats.device_links_moved = run(`UPDATE athlete_links SET client_id = (SELECT t.client_id FROM team_roster t WHERE t.id = athlete_links.roster_id), roster_id = NULL
        WHERE roster_id IS NOT NULL AND (SELECT t.client_id FROM team_roster t WHERE t.id = athlete_links.roster_id) IS NOT NULL`).changes;
    }
    // Testing days: [{roster_id}] becomes [{client_id}], each athlete once.
    if (has('perf_sessions')) {
      for (const s of all('SELECT id, athletes FROM perf_sessions')) {
        let list;
        try { list = JSON.parse(s.athletes); } catch { continue; }
        if (!Array.isArray(list) || !list.some((a) => a?.roster_id)) continue;
        const out = [];
        for (const a of list) {
          const cid = a?.client_id ?? (a?.roster_id ? get('SELECT client_id FROM team_roster WHERE id = ?', a.roster_id)?.client_id : null);
          if (cid && !out.some((x) => x.client_id === cid)) out.push({ client_id: cid });
        }
        run('UPDATE perf_sessions SET athletes = ? WHERE id = ?', JSON.stringify(out), s.id);
        stats.testing_days_updated++;
      }
    }
    // Team attendance: by client instead of by roster line (a client on the roster twice counts once per session).
    if (cols('team_attendance').includes('roster_id')) {
      const before = get('SELECT COUNT(*) AS n FROM team_attendance').n;
      raw.exec(createStatement(schema, 'team_attendance').replace('CREATE TABLE IF NOT EXISTS team_attendance (', 'CREATE TABLE team_attendance_v37 ('));
      run(`INSERT OR IGNORE INTO team_attendance_v37 (session_id, client_id, created_at) SELECT a.session_id, t.client_id, MIN(a.created_at)
        FROM team_attendance a JOIN team_roster t ON t.id = a.roster_id WHERE t.client_id IS NOT NULL GROUP BY a.session_id, t.client_id`);
      stats.attendance_moved = get('SELECT COUNT(*) AS n FROM team_attendance_v37').n;
      stats.attendance_merged = before - stats.attendance_moved;
      raw.exec('DROP TABLE team_attendance');
      raw.exec('ALTER TABLE team_attendance_v37 RENAME TO team_attendance');
    }
    if (has('settings')) run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'upgrade_v37', JSON.stringify({ at: now, ...stats }));
    raw.exec('COMMIT');
  } catch (e) { raw.exec('ROLLBACK'); throw e; }
  finally { raw.exec('PRAGMA foreign_keys = ON'); }
  if (stats.collisions.length) console.warn(`Upgrade to version 37: ${stats.collisions.length} Athlete ID ${stats.collisions.length === 1 ? 'collision' : 'collisions'} resolved (see the audit log).`);
}
// SQLite can't change constraints in place: create the new table, copy shared columns, swap.
function rebuild(raw, schema, tables, prerequisites = []) {
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('BEGIN');
  try {
    for (const t of prerequisites) raw.exec(createStatement(schema, t));
    for (const table of tables) {
      const newCols = columnsOf(createStatement(schema, table));
      const oldCols = raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!oldCols.length) continue;
      const shared = newCols.filter((c) => oldCols.includes(c));
      raw.exec(createStatement(schema, table).replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}_new (`));
      raw.exec(`INSERT INTO ${table}_new (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM ${table}`);
      raw.exec(`DROP TABLE ${table}`);
      raw.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    }
    raw.exec('COMMIT');
  } catch (e) { raw.exec('ROLLBACK'); throw e; }
  finally { raw.exec('PRAGMA foreign_keys = ON'); }
}
function createStatement(schema, table) {
  const m = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
  if (!m) throw new Error(`No definition for ${table} in schema.sql`);
  return m[0];
}
function columnsOf(stmt) {
  return stmt.split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]).filter((w) => /^[a-z_0-9]+$/.test(w) && !['UNIQUE', 'PRIMARY', 'CHECK', 'FOREIGN'].includes(w.toUpperCase()) && w === w.toLowerCase());
}
