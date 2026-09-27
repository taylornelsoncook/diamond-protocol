import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
const SCHEMA_VERSION = 26;
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
  26: ['purchases']                                                       // programs and courses sold online
};
const ADDED_COLUMNS = {
  clients: ['stripe_customer_id TEXT', 'card_payment_method TEXT', 'card_brand TEXT', 'card_last4 TEXT', 'athlete_id TEXT', "sex TEXT CHECK (sex IN ('M','F'))"],   // athlete_id: version 6, sex: version 10
  team_roster: ['athlete_id TEXT'],
  perf_sessions: ['shared_at TEXT', 'parent_note TEXT'],                 // version 10
  subscriptions: ['trial_reminded_at TEXT'],                              // version 11
  guardians: ['sms_opt_in_at TEXT', 'sms_opt_out_at TEXT'],               // version 13
  bookings: ['reminded_at TEXT'],                                         // version 13
  locations: ['checkin_code TEXT'],                                       // version 16
  products: ['track_stock INTEGER NOT NULL DEFAULT 0', 'low_stock_at INTEGER'],   // version 17
  sale_items: ['variant_id TEXT'],                                        // version 17
  workout_exercises: ['load_test TEXT', 'load_pct INTEGER'],             // version 21: weights from tested maxes
  coach_messages: ["from_kind TEXT NOT NULL DEFAULT 'coach'", 'author_name TEXT', 'guardian_id TEXT', 'staff_read_at TEXT'],   // version 20: replies
  class_series: ['contract_id TEXT REFERENCES team_contracts(id) ON DELETE SET NULL'],      // version 4
  class_sessions: ['workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL'],           // version 23: weight-room screen
  workout_logs: ['session_id TEXT REFERENCES class_sessions(id) ON DELETE SET NULL'],        // version 23 (then rebuilt so assignment_id can be empty)
  lessons: ['quiz TEXT'],                                                                     // version 24: lesson quizzes
  courses: ["audience TEXT NOT NULL DEFAULT 'athletes' CHECK (audience IN ('athletes','parents'))", 'age_min INTEGER', 'age_max INTEGER', 'for_sale INTEGER NOT NULL DEFAULT 0', 'price_cents INTEGER'],   // version 25: parent education; 26: sold online
  programs: ['for_sale INTEGER NOT NULL DEFAULT 0', 'price_cents INTEGER']                   // version 26: sold online
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
