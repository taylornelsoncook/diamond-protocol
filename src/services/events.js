import { newId, token, hmac, v, notFound, badRequest } from '../util.js';

export const EVENT_TYPES = [
  'client.created', 'client.updated',
  'subscription.created', 'subscription.updated',
  'invoice.paid', 'invoice.payment_failed',
  'program.assigned', 'workout.completed',
  'sale.completed', 'sale.failed', 'sale.refunded',
  'session.checked_in', 'client.card_updated',
  'booking.created', 'booking.waitlisted', 'booking.canceled', 'session.canceled',
  'enrollment.created', 'family.waiver_signed',
  'team_contract.created', 'team_invoice.created', 'team_invoice.paid', 'team_invoice.overdue', 'team_invoice.voided', 'team_invoice.payment_failed',
  'results.recorded', 'performance.pr', 'integration.synced', 'queue.linked', 'testing.shared',
  'family.signed_up', 'family.deletion_requested', 'family.deleted', 'clients.imported',
  'lead.created', 'lead.updated', 'pay_link.created', 'pay_link.paid', 'stock.changed', 'badge.awarded', 'course.completed', 'purchase.completed', 'spots.offered'
];

// Record an event and queue a delivery for every active endpoint subscribed to it.
export function emit(ctx, type, data) {
  const ev = { id: newId('evt'), type, data, created_at: ctx.now() };
  ctx.db.run('INSERT INTO events (id, type, data, created_at) VALUES (?, ?, ?, ?)', ev.id, type, JSON.stringify(data), ev.created_at);
  for (const ep of ctx.db.all('SELECT id, events FROM webhook_endpoints WHERE active = 1')) {
    const wanted = JSON.parse(ep.events);
    if (wanted.includes('*') || wanted.includes(type)) {
      ctx.db.run(
        `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
        newId('whd'), ep.id, ev.id, ev.created_at, ev.created_at
      );
    }
  }
  ctx.onEvent?.();
  return ev;
}

export function listEvents(ctx, { limit = 20, type } = {}) {
  const rows = type
    ? ctx.db.all('SELECT * FROM events WHERE type = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', type, limit)
    : ctx.db.all('SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?', limit);
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

// ---- Webhook endpoints ----
const publicEndpoint = (r) => ({ id: r.id, url: r.url, secret: r.secret, events: JSON.parse(r.events), active: !!r.active, created_at: r.created_at });

function cleanEvents(events) {
  if (!Array.isArray(events) || events.length === 0) throw badRequest('events must list at least one event type, or "*" for all.');
  for (const e of events) if (e !== '*' && !EVENT_TYPES.includes(e)) throw badRequest(`Unknown event type: ${e}.`);
  return [...new Set(events)];
}

export function createEndpoint(ctx, body) {
  const url = v.url(body.url, 'url', { allowHttp: ctx.testMode });
  const events = cleanEvents(body.events ?? ['*']);
  const row = { id: newId('whe'), url, secret: `whsec_${token(24)}`, events: JSON.stringify(events), created_at: ctx.now() };
  ctx.db.run('INSERT INTO webhook_endpoints (id, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, 1, ?)', row.id, row.url, row.secret, row.events, row.created_at);
  return getEndpoint(ctx, row.id);
}
export function listEndpoints(ctx) {
  return ctx.db.all('SELECT * FROM webhook_endpoints ORDER BY created_at').map(publicEndpoint);
}
export function getEndpoint(ctx, id) {
  const r = ctx.db.get('SELECT * FROM webhook_endpoints WHERE id = ?', id);
  if (!r) throw notFound('Webhook endpoint');
  return publicEndpoint(r);
}
export function updateEndpoint(ctx, id, body) {
  const ep = getEndpoint(ctx, id);
  const url = body.url !== undefined ? v.url(body.url, 'url', { allowHttp: ctx.testMode }) : ep.url;
  const events = body.events !== undefined ? cleanEvents(body.events) : ep.events;
  const active = body.active !== undefined ? !!body.active : ep.active;
  ctx.db.run('UPDATE webhook_endpoints SET url = ?, events = ?, active = ? WHERE id = ?', url, JSON.stringify(events), active, id);
  return getEndpoint(ctx, id);
}
export function deleteEndpoint(ctx, id) {
  getEndpoint(ctx, id);
  ctx.db.run('DELETE FROM webhook_endpoints WHERE id = ?', id);
  return { id, deleted: true };
}
export function listDeliveries(ctx, endpointId, limit = 25) {
  getEndpoint(ctx, endpointId);
  return ctx.db.all(
    `SELECT d.id, d.status, d.attempts, d.response_code, d.last_error, d.next_attempt_at, d.created_at, e.type AS event_type, e.id AS event_id
     FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
     WHERE d.endpoint_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`, endpointId, limit);
}

// Signature format (verify on the receiving side):
//   DP-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" using the endpoint secret>
export function signPayload(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;
}

const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
let running = false;

// Send due deliveries. Called on a timer and right after events fire.
export async function deliverPending(ctx, { limit = 20 } = {}) {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    const due = ctx.db.all(
      `SELECT d.id, d.attempts, w.url, w.secret, e.id AS event_id, e.type, e.data, e.created_at
       FROM webhook_deliveries d
       JOIN webhook_endpoints w ON w.id = d.endpoint_id
       JOIN events e ON e.id = d.event_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND w.active = 1
       ORDER BY d.created_at LIMIT ?`, new Date().toISOString(), limit);
    for (const d of due) {
      const body = JSON.stringify({ id: d.event_id, type: d.type, created_at: d.created_at, data: JSON.parse(d.data) });
      const attempts = d.attempts + 1;
      let code = null, error = null;
      try {
        const res = await fetch(d.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'DiamondProtocol-Webhooks/1', 'dp-signature': signPayload(d.secret, body), 'dp-event': d.type },
          body,
          signal: AbortSignal.timeout(10000)
        });
        code = res.status;
        if (!res.ok) error = `Receiver responded ${res.status}`;
      } catch (e) {
        error = e.name === 'TimeoutError' ? 'Receiver did not respond within 10 seconds' : `Could not connect: ${e.cause?.code || e.message}`;
      }
      if (!error) {
        ctx.db.run(`UPDATE webhook_deliveries SET status = 'succeeded', attempts = ?, response_code = ?, last_error = NULL, next_attempt_at = NULL WHERE id = ?`, attempts, code, d.id);
      } else if (attempts > BACKOFF_MINUTES.length) {
        ctx.db.run(`UPDATE webhook_deliveries SET status = 'failed', attempts = ?, response_code = ?, last_error = ?, next_attempt_at = NULL WHERE id = ?`, attempts, code, error, d.id);
      } else {
        const next = new Date(Date.now() + BACKOFF_MINUTES[attempts - 1] * 60000).toISOString();
        ctx.db.run(`UPDATE webhook_deliveries SET attempts = ?, response_code = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`, attempts, code, error, next, d.id);
      }
      sent++;
    }
  } finally {
    running = false;
  }
  return sent;
}
