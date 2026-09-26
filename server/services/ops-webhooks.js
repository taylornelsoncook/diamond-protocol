// Webhook helpers for API & integrations: secrets, single-hook test deliveries.
'use strict';
const crypto = require('crypto');
const { insert, run } = require('../db');

const newSecret = () => 'whsec_' + crypto.randomBytes(24).toString('hex');
const sign = (secret, body) => crypto.createHmac('sha256', secret || '').update(body).digest('hex');

// Send one event to one webhook (used by "Send test event"), recording the delivery like lib.emit does.
function deliver(hook, event, data) {
  const body = JSON.stringify({ event, created_at: new Date().toISOString(), data });
  const did = insert('webhook_deliveries', { webhook_id: hook.id, event, payload: body, status: null });
  const done = fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dp-signature': sign(hook.secret, body) }, body, signal: AbortSignal.timeout(8000) })
    .then((r) => { run('UPDATE webhook_deliveries SET status=? WHERE id=?', r.status, did); return r.status; })
    .catch((e) => { run('UPDATE webhook_deliveries SET status=0, error=? WHERE id=?', String(e.cause?.code || e.message || e), did); return 0; });
  return { id: did, done };
}

module.exports = { newSecret, sign, deliver };
