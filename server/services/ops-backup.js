// Daily database backups: a full SQLite copy via VACUUM INTO, the last 30 kept in DATA_DIR/backups.
'use strict';
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('../db');

const KEEP = 30;
const NAME_RE = /^dp-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d{1,3})?\.db$/;
const dir = () => path.join(process.env.DP_DATA_DIR || DATA_DIR, 'backups');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function list() {
  const d = dir();
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => NAME_RE.test(f)).sort().reverse().map((name) => {
    const st = fs.statSync(path.join(d, name));
    return { name, size: st.size, created_at: st.mtime.toISOString() };
  });
}

function prune() {
  const d = dir();
  for (const b of list().slice(KEEP)) { try { fs.unlinkSync(path.join(d, b.name)); } catch { /* already gone */ } }
}

function backupNow() {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  let name = `dp-${stamp()}.db`, n = 2;
  while (fs.existsSync(path.join(d, name))) name = `dp-${stamp()}-${n++}.db`;
  const file = path.join(d, name);
  // The file name is generated above (digits and dashes only), so it is safe inside the SQL string.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  prune();
  const st = fs.statSync(file);
  return { name, size: st.size, created_at: st.mtime.toISOString() };
}

// Job: one backup per calendar day.
function daily() {
  const today = stamp().slice(0, 10);
  if (list().some((b) => b.name.startsWith(`dp-${today}-`))) return null;
  return backupNow();
}

// Resolve a requested file name strictly; returns the absolute path or null.
function resolve(name) {
  if (!NAME_RE.test(String(name || ''))) return null;
  const file = path.join(dir(), name);
  if (path.dirname(file) !== dir() || !fs.existsSync(file)) return null;
  return file;
}

module.exports = { backupNow, daily, list, resolve, prune, KEEP, NAME_RE };
