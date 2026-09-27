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
const SCHEMA_VERSION = 11;
const REBUILD = { 2: ['clients', 'products', 'session_credits'] };
const ADDED_COLUMNS = {
  clients: ['stripe_customer_id TEXT', 'card_payment_method TEXT', 'card_brand TEXT', 'card_last4 TEXT', 'athlete_id TEXT', "sex TEXT CHECK (sex IN ('M','F'))"],   // athlete_id: version 6, sex: version 10
  team_roster: ['athlete_id TEXT'],
  perf_sessions: ['shared_at TEXT', 'parent_note TEXT'],                 // version 10
  subscriptions: ['trial_reminded_at TEXT'],                              // version 11
  class_series: ['contract_id TEXT REFERENCES team_contracts(id) ON DELETE SET NULL']       // version 4
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
