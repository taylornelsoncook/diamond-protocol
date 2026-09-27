// Open API bookkeeping for API & integrations: key access levels and a 30-day request log per key.
'use strict';
const { db, all, get, insert, run } = require('../db');

// Older databases: access level on each key ('full' = read and send results, 'read' = read only).
if (!all('PRAGMA table_info(api_keys)').some((c) => c.name === 'scope')) db.exec("ALTER TABLE api_keys ADD COLUMN scope TEXT DEFAULT 'full'");
db.exec(`CREATE TABLE IF NOT EXISTS api_requests (
  id INTEGER PRIMARY KEY, key_id INTEGER REFERENCES api_keys(id) ON DELETE CASCADE, method TEXT, path TEXT, status INTEGER,
  duration_ms INTEGER, ip TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS api_requests_key ON api_requests(key_id, id);`);

const SCOPES = { full: 'Read and send results', read: 'Read only' };
const KEEP_DAYS = 30;

// Record each request made with a key once the answer has gone out.
function track(req, res, key) {
  const started = Date.now();
  let error = null;
  const json = res.json.bind(res);
  res.json = (body) => { if (body && typeof body.error === 'string') error = body.error.slice(0, 300); return json(body); };
  res.on('finish', () => {
    try {
      insert('api_requests', {
        key_id: key.id, method: req.method, path: String(req.originalUrl || req.url).slice(0, 300), status: res.statusCode,
        duration_ms: Date.now() - started, ip: req.ip || null, error: res.statusCode >= 400 ? error : null,
      });
    } catch { /* never let bookkeeping break a request */ }
  });
}

// 30-day counts for every key: { key_id: { requests, errors } }.
function usage() {
  const rows = all(`SELECT key_id, COUNT(*) AS requests, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) AS errors
    FROM api_requests WHERE created_at >= datetime('now', ?) GROUP BY key_id`, `-${KEEP_DAYS} days`);
  return Object.fromEntries(rows.map((r) => [r.key_id, { requests: r.requests, errors: r.errors || 0 }]));
}

function recent(keyId, limit = 50) {
  return all('SELECT id, method, path, status, duration_ms, ip, error, created_at FROM api_requests WHERE key_id=? ORDER BY id DESC LIMIT ?', keyId, limit);
}

// Job: drop request rows older than 30 days.
function prune() { return run('DELETE FROM api_requests WHERE created_at < datetime(\'now\', ?)', `-${KEEP_DAYS} days`).changes; }

const scopeOf = (k) => (k.scope === 'read' ? 'read' : 'full');
const lastRequest = (keyId) => get('SELECT method, path, status, created_at FROM api_requests WHERE key_id=? ORDER BY id DESC LIMIT 1', keyId) || null;

module.exports = { SCOPES, KEEP_DAYS, track, usage, recent, prune, scopeOf, lastRequest };
