// SQLite database: schema, connection and small query helpers.
'use strict';
process.removeAllListeners('warning'); // silence node:sqlite experimental notice
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// DP_DB alone (tests) keeps everything next to that file, so nothing is written to ./data.
const DATA_DIR = process.env.DP_DATA_DIR || (process.env.DP_DB ? path.dirname(path.resolve(process.env.DP_DB)) : path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DP_DB || path.join(DATA_DIR, 'diamond.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner','coach','frontdesk')),
  pw_hash TEXT, must_change INTEGER DEFAULT 1, active INTEGER DEFAULT 1,
  failed_count INTEGER DEFAULT 0, locked_until TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('staff','parent')),
  user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS parent_codes (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, used INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'facility' CHECK (kind IN ('facility','mobile','park','school')),
  address TEXT, archived INTEGER DEFAULT 0);

-- A family is the paying account: one card, one waiver, one or more parents and athletes.
CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  card_brand TEXT, card_last4 TEXT, card_exp TEXT,
  waiver_version INTEGER, waiver_signed_at TEXT, waiver_signed_by TEXT,
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS parents (
  id INTEGER PRIMARY KEY, family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, phone TEXT, is_self INTEGER DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS parents_email ON parents(email);

CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact_name TEXT, contact_email TEXT, address TEXT);

CREATE TABLE IF NOT EXISTS team_contracts (
  id INTEGER PRIMARY KEY, school_id INTEGER NOT NULL REFERENCES schools(id),
  team_name TEXT NOT NULL, monthly_cents INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
  terms_days INTEGER DEFAULT 30, po_number TEXT, billing_name TEXT, billing_email TEXT,
  billing_day INTEGER, status TEXT DEFAULT 'active' CHECK (status IN ('active','ended')),
  created_at TEXT DEFAULT (datetime('now')));

-- athlete_code is the Athlete ID (like AVALOP2026) that ties every result, booking and sale together.
CREATE TABLE IF NOT EXISTS athletes (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, family_id INTEGER REFERENCES families(id),
  team_id INTEGER REFERENCES team_contracts(id),
  first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT,
  birthday TEXT, sex TEXT CHECK (sex IN ('M','F') OR sex IS NULL), sport TEXT, position TEXT, school TEXT,
  allergies TEXT, injuries TEXT, medical_notes TEXT, emergency_name TEXT, emergency_phone TEXT, coach_notes TEXT,
  group_credits INTEGER DEFAULT 0, private_credits INTEGER DEFAULT 0,
  program_id INTEGER REFERENCES programs(id), program_started TEXT, workout_token TEXT UNIQUE,
  archived INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL, trial_days INTEGER DEFAULT 0,
  group_per_month INTEGER, -- NULL = unlimited group classes
  private_per_month INTEGER DEFAULT 0, active INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES athletes(id), plan_id INTEGER NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK (status IN ('trial','active','past_due','paused','cancelled')),
  started_at TEXT NOT NULL, next_charge TEXT, price_cents INTEGER, cancelled_at TEXT);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('class','camp','clinic','team')),
  weekdays TEXT NOT NULL, -- comma list 0=Sun..6=Sat
  start_time TEXT NOT NULL, duration_min INTEGER NOT NULL, capacity INTEGER DEFAULT 12,
  min_age INTEGER, max_age INTEGER, price_cents INTEGER DEFAULT 0,
  reg_price_cents INTEGER, reg_deadline TEXT, start_date TEXT, end_date TEXT,
  location_id INTEGER REFERENCES locations(id), team_id INTEGER REFERENCES team_contracts(id),
  coach_id INTEGER REFERENCES staff(id), archived INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, class_id INTEGER REFERENCES classes(id),
  type TEXT NOT NULL CHECK (type IN ('class','camp','clinic','team','private','evaluation')),
  name TEXT NOT NULL, starts_at TEXT NOT NULL, duration_min INTEGER NOT NULL, capacity INTEGER,
  price_cents INTEGER DEFAULT 0, location_id INTEGER REFERENCES locations(id), team_id INTEGER REFERENCES team_contracts(id),
  coach_id INTEGER REFERENCES staff(id), cancelled INTEGER DEFAULT 0, cancel_reason TEXT);
CREATE INDEX IF NOT EXISTS events_start ON events(starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS events_class_slot ON events(class_id, starts_at) WHERE class_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), athlete_id INTEGER NOT NULL REFERENCES athletes(id),
  status TEXT NOT NULL CHECK (status IN ('booked','waitlist','cancelled','late_cancel')),
  coverage TEXT CHECK (coverage IN ('member','credit','paid','registered','unpaid','team')),
  paid_cents INTEGER DEFAULT 0, checked_in_at TEXT, source TEXT DEFAULT 'staff',
  created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS bookings_event ON bookings(event_id);

CREATE TABLE IF NOT EXISTS standing_spots (
  id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES athletes(id), class_id INTEGER NOT NULL REFERENCES classes(id),
  UNIQUE (athlete_id, class_id));

CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('private','evaluation')),
  weekday INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, slot_min INTEGER NOT NULL,
  location_id INTEGER REFERENCES locations(id), price_cents INTEGER DEFAULT 0, coach_id INTEGER REFERENCES staff(id));

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session','group_pack','private_pack','gear','other')),
  price_cents INTEGER NOT NULL, credits INTEGER DEFAULT 0, archived INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS readers (id INTEGER PRIMARY KEY, label TEXT NOT NULL, location_id INTEGER REFERENCES locations(id), serial TEXT);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY, location_id INTEGER REFERENCES locations(id), athlete_id INTEGER REFERENCES athletes(id),
  family_id INTEGER REFERENCES families(id), items TEXT NOT NULL, total_cents INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('tap','reader','card','cash')),
  status TEXT DEFAULT 'paid' CHECK (status IN ('paid','refunded','partial_refund','failed')),
  refunded_cents INTEGER DEFAULT 0, charge_id TEXT, staff_id INTEGER REFERENCES staff(id), booking_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')));

-- Membership charges and school invoices share one table.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('membership','school','charge')),
  family_id INTEGER REFERENCES families(id), athlete_id INTEGER REFERENCES athletes(id),
  membership_id INTEGER REFERENCES memberships(id), contract_id INTEGER REFERENCES team_contracts(id),
  description TEXT, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','paid','failed','void')),
  issued_at TEXT DEFAULT (date('now')), due_date TEXT, period TEXT,
  paid_at TEXT, pay_method TEXT, check_number TEXT, charge_id TEXT,
  attempts INTEGER DEFAULT 0, next_retry TEXT, last_reminder TEXT, view_token TEXT UNIQUE,
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL, unit TEXT NOT NULL,
  lower_better INTEGER DEFAULT 0, attempts INTEGER DEFAULT 2, min_value REAL, max_value REAL,
  timed INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, custom INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS testing_days (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, date TEXT NOT NULL, team_id INTEGER REFERENCES team_contracts(id),
  preset TEXT, status TEXT DEFAULT 'open' CHECK (status IN ('open','shared')), shared_at TEXT, note TEXT,
  created_by INTEGER REFERENCES staff(id), created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS testing_day_tests (day_id INTEGER REFERENCES testing_days(id) ON DELETE CASCADE, test_id INTEGER REFERENCES tests(id), ord INTEGER, PRIMARY KEY (day_id, test_id));
CREATE TABLE IF NOT EXISTS testing_day_athletes (day_id INTEGER REFERENCES testing_days(id) ON DELETE CASCADE, athlete_id INTEGER REFERENCES athletes(id), PRIMARY KEY (day_id, athlete_id));

-- value is stored in the test's own unit; unit_entered records what was typed.
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES athletes(id), test_id INTEGER NOT NULL REFERENCES tests(id),
  day_id INTEGER REFERENCES testing_days(id), attempt INTEGER DEFAULT 1, value REAL NOT NULL,
  unit_entered TEXT, hand_timed INTEGER DEFAULT 0,
  source TEXT DEFAULT 'manual' CHECK (source IN ('manual','stopwatch','upload','device','api')),
  source_ref TEXT, recorded_at TEXT DEFAULT (datetime('now')), created_by INTEGER);
CREATE INDEX IF NOT EXISTS results_athlete ON results(athlete_id, test_id);
CREATE UNIQUE INDEX IF NOT EXISTS results_slot ON results(athlete_id, test_id, day_id, attempt) WHERE day_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS results_ref ON results(source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS pending_results (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, sender_key TEXT NOT NULL, sender_label TEXT,
  test_id INTEGER REFERENCES tests(id), test_name TEXT, value REAL, unit TEXT, recorded_at TEXT,
  source_ref TEXT UNIQUE, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS device_links (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, sender_key TEXT NOT NULL, sender_label TEXT,
  athlete_id INTEGER NOT NULL REFERENCES athletes(id), created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (source, sender_key));

CREATE TABLE IF NOT EXISTS exercises (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, cues TEXT, video_url TEXT);
CREATE TABLE IF NOT EXISTS programs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, weeks INTEGER DEFAULT 4, level TEXT, description TEXT, archived INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS program_days (id INTEGER PRIMARY KEY, program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE, week INTEGER NOT NULL, day INTEGER NOT NULL, title TEXT);
CREATE TABLE IF NOT EXISTS program_items (id INTEGER PRIMARY KEY, day_id INTEGER NOT NULL REFERENCES program_days(id) ON DELETE CASCADE, exercise_id INTEGER NOT NULL REFERENCES exercises(id), sets TEXT, reps TEXT, cue TEXT, ord INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS workout_logs (
  id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES athletes(id), day_id INTEGER NOT NULL REFERENCES program_days(id),
  done TEXT DEFAULT '[]', note TEXT, finished_at TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY, label TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, last4 TEXT, created_at TEXT DEFAULT (datetime('now')), last_used TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS webhooks (id INTEGER PRIMARY KEY, url TEXT NOT NULL, events TEXT NOT NULL, secret TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS webhook_deliveries (id INTEGER PRIMARY KEY, webhook_id INTEGER REFERENCES webhooks(id) ON DELETE CASCADE, event TEXT, payload TEXT, status INTEGER, error TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT DEFAULT 'logged', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, actor TEXT, action TEXT NOT NULL, detail TEXT, ip TEXT, kind TEXT DEFAULT 'change', created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS activity_time ON activity(created_at);

-- Lookups by athlete and family that every list screen makes (client list, Today, Billing, programs).
CREATE INDEX IF NOT EXISTS bookings_athlete ON bookings(athlete_id, status);
CREATE INDEX IF NOT EXISTS memberships_athlete ON memberships(athlete_id);
CREATE INDEX IF NOT EXISTS workout_logs_athlete ON workout_logs(athlete_id);
CREATE INDEX IF NOT EXISTS athletes_family ON athletes(family_id);
CREATE INDEX IF NOT EXISTS athletes_team ON athletes(team_id);
CREATE INDEX IF NOT EXISTS athletes_program ON athletes(program_id);
CREATE INDEX IF NOT EXISTS parents_family ON parents(family_id);
CREATE INDEX IF NOT EXISTS invoices_family ON invoices(family_id);
CREATE INDEX IF NOT EXISTS invoices_membership ON invoices(membership_id);
CREATE INDEX IF NOT EXISTS invoices_contract ON invoices(contract_id);
CREATE INDEX IF NOT EXISTS invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS sales_time ON sales(created_at);
`;
db.exec(SCHEMA);

// ---- helpers --------------------------------------------------------------
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
// Re-entrant transaction: nested calls join the outer one (via savepoints).
let depth = 0;
function tx(fn) {
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const r = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}
function insert(table, obj) {
  const keys = Object.keys(obj);
  const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => norm(obj[k])));
  return Number(r.lastInsertRowid);
}
function update(table, id, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`, ...keys.map((k) => norm(obj[k])), id);
}
function norm(v) { return v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v; }

function setting(key, fallback = null) { const r = get('SELECT value FROM settings WHERE key=?', key); return r ? JSON.parse(r.value) : fallback; }
function setSetting(key, value) { run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }

module.exports = { db, all, get, run, tx, insert, update, setting, setSetting, DB_PATH, DATA_DIR };
