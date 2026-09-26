// Hawkin Dynamics force plate sync. Runs every 15 minutes when an integration token is saved.
// Token → access token (GET /api/token), then new tests (GET /api/dev/?from=epoch). Everything is defensive:
// failures are recorded in settings 'hawkin_status' and never throw.
'use strict';
const { get, setting, setSetting } = require('../db');
const core = require('./testing-core');

const BASE = 'https://cloud.hawkindynamics.com';
// Hawkin metric name → our test (value multiplier into the test's unit).
const METRICS = [
  [/^jump height\s*\(m\)$/i, 'CMJ jump height', 100],
  [/^jump height\s*\(cm\)$/i, 'CMJ jump height', 1],
  [/^peak propulsive power\s*\(w\)$/i, 'CMJ peak power', 1],
  [/^(relative peak propulsive power|peak relative propulsive power)\s*\(w\/kg\)$/i, 'CMJ relative power', 1],
  [/^mrsi$|^rsi[- ]?modified/i, 'RSI-modified', 1],
  [/^peak force\s*\(n\)$/i, 'IMTP peak force', 1],
  [/^landing asymmetry/i, 'Landing asymmetry', 1],
];
function mapTest(testType, metric) {
  const type = String(testType || '').toLowerCase();
  for (const [re, name, mult] of METRICS) {
    if (!re.test(metric)) continue;
    if (name === 'IMTP peak force' && !/isometric|imtp/.test(type)) continue;
    if (name === 'CMJ jump height' && /squat jump|\bsj\b/.test(type)) return ['Squat jump height', mult];
    if (/drop jump/.test(type) && /rsi/i.test(metric)) return ['Drop jump RSI', 1];
    return [name, mult];
  }
  return null;
}

async function sync({ fetchImpl = fetch } = {}) {
  const token = setting('hawkin_token');
  if (!token) return { skipped: true };
  const started = new Date().toISOString();
  try {
    const tr = await fetchImpl(`${BASE}/api/token`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!tr.ok) throw new Error(tr.status === 401 ? 'Hawkin rejected the integration token. Paste a new one.' : `Hawkin sign-in failed (${tr.status}).`);
    const tj = await tr.json();
    const access = tj.access_token || tj.accessToken;
    if (!access) throw new Error('Hawkin did not return an access token.');
    const since = Number(setting('hawkin_since', 0)) || Math.floor(Date.now() / 1000) - 30 * 86400;
    const r = await fetchImpl(`${BASE}/api/dev/?from=${since}`, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Hawkin test download failed (${r.status}).`);
    const body = await r.json();
    const tests = Array.isArray(body) ? body : body.data || [];
    const items = [];
    let latest = since;
    for (const t of tests) {
      const ts = Number(t.timestamp || t.time || 0);
      if (ts > latest) latest = ts;
      const ath = t.athlete || {};
      const external = ath.external && typeof ath.external === 'object' ? Object.values(ath.external)[0] : ath.external;
      const type = t.testType?.name || t.testType || t.test_type || '';
      for (const [metric, value] of Object.entries(t)) {
        if (typeof value !== 'number') continue;
        const m = mapTest(type, metric);
        if (!m) continue;
        const test = core.findTest(m[0]);
        const v = core.round(value * m[1], 3);
        if (!test || !core.inRange(test, v)) continue;
        const code = typeof external === 'string' && get('SELECT 1 FROM athletes WHERE code=? COLLATE NOCASE', external) ? external : null;
        items.push({ source: 'Hawkin', athlete_code: code, device_id: ath.id || ath.name, device_name: ath.name, test: test.name, value: v,
          recorded_at: ts ? new Date(ts * 1000).toISOString() : undefined, ref: `${t.id}:${test.id}` });
      }
    }
    const out = items.length ? core.ingest(items, { resultSource: 'device', refPrefix: 'hawkin' }) : { saved: 0, pending: 0 };
    if (out.errors) throw new Error(`Hawkin sent ${out.errors.length} results we couldn't read.`);
    setSetting('hawkin_since', latest);
    setSetting('hawkin_status', { ok: true, at: started, message: `${out.saved} saved, ${out.pending} waiting to be linked.` });
    return out;
  } catch (e) {
    setSetting('hawkin_status', { ok: false, at: started, message: String(e.message || e) });
    return { error: String(e.message || e) };
  }
}

module.exports = { sync, mapTest };
