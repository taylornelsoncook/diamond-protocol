import { createHmac, timingSafeEqual } from 'node:crypto';

// Talks to Stripe's REST API with fetch (no SDK needed). Used when STRIPE_SECRET_KEY is set.
// Covers: customers, off-session charges for memberships, Terminal (Tap to Pay on iPhone and
// smart readers), refunds, hosted card setup (Stripe Checkout), and webhook verification.
export function createStripeProvider({ secretKey, webhookSecret, currency = 'usd', baseUrl = 'https://api.stripe.com', apiVersion } = {}) {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required for the Stripe provider.');

  async function call(method, path, params, { idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${secretKey}` };
    if (apiVersion) headers['stripe-version'] = apiVersion;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let url = baseUrl + path, body;
    const form = params ? encode(params) : '';
    if (method === 'GET') { if (form) url += `?${form}`; }
    else { headers['content-type'] = 'application/x-www-form-urlencoded'; body = form; }
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error?.message || `Stripe request failed (${res.status}).`);
      err.stripe = data.error || {}; err.status = res.status;
      throw err;
    }
    return data;
  }

  const cardFromCharge = (charge) => {
    const d = charge?.payment_method_details;
    const c = d?.card_present || d?.card || d?.interac_present;
    return c ? { brand: c.brand, last4: c.last4, generated: c.generated_card || null } : null;
  };

  return {
    name: 'stripe',
    live: secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_'),

    async ensureCustomer(client) {
      if (client.stripe_customer_id) return client.stripe_customer_id;
      const c = await call('POST', '/v1/customers', { name: client.name, email: client.email ?? undefined, metadata: { [client.metadataKey ?? 'client_id']: client.id } }, { idempotencyKey: `customer-${client.id}` });
      return c.id;
    },

    // Membership renewals: charge the saved card without the client present.
    async chargeSaved({ client, amountCents, description, idempotencyKey, metadata = {} }) {
      if (!client.stripe_customer_id || !client.card_payment_method) return { ok: false, error: 'No card on file. Send the client a link to add one.' };
      try {
        const pi = await call('POST', '/v1/payment_intents', {
          amount: amountCents, currency, customer: client.stripe_customer_id, payment_method: client.card_payment_method,
          off_session: true, confirm: true, description, metadata: { [client.metadataKey ?? 'client_id']: client.id, ...metadata }
        }, { idempotencyKey });
        // 'processing' counts as paid; if it fails later the payment_intent.payment_failed webhook reopens the invoice.
        // The PaymentIntent id comes back either way so webhooks can find the invoice.
        return ['succeeded', 'processing'].includes(pi.status) ? { ok: true, ref: pi.id } : { ok: false, ref: pi.id, error: `Payment ${pi.status.replace(/_/g, ' ')}.` };
      } catch (e) {
        if (e.status === 402 || e.stripe?.type === 'card_error') return { ok: false, ref: e.stripe?.payment_intent?.id ?? null, error: e.message };
        throw e;
      }
    },

    // In-person payment for Tap to Pay on iPhone or a smart reader.
    async createInPersonIntent({ amountCents, customerId, saveCard, description, metadata, idempotencyKey }) {
      const pi = await call('POST', '/v1/payment_intents', {
        amount: amountCents, currency, payment_method_types: ['card_present'], capture_method: 'automatic',
        description, metadata,
        ...(customerId ? { customer: customerId } : {}),
        ...(saveCard && customerId ? { setup_future_usage: 'off_session' } : {})
      }, { idempotencyKey });
      return { id: pi.id, clientSecret: pi.client_secret };
    },
    async getIntent(id) {
      const pi = await call('GET', `/v1/payment_intents/${encodeURIComponent(id)}`, { expand: ['latest_charge'] });
      const card = cardFromCharge(pi.latest_charge);
      return {
        status: pi.status,
        error: pi.last_payment_error?.message || null,
        card: card ? { brand: card.brand, last4: card.last4 } : null,
        savedCard: card?.generated || null
      };
    },
    async captureIntent(id) { await call('POST', `/v1/payment_intents/${encodeURIComponent(id)}/capture`, {}); },
    async cancelIntent(id) {
      try { await call('POST', `/v1/payment_intents/${encodeURIComponent(id)}/cancel`, {}); }
      catch (e) { if (e.stripe?.code !== 'payment_intent_unexpected_state') throw e; }
    },
    async processOnReader(readerId, intentId) {
      try { await call('POST', `/v1/terminal/readers/${encodeURIComponent(readerId)}/process_payment_intent`, { payment_intent: intentId }); return { ok: true }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    async cancelReaderAction(readerId) {
      try { await call('POST', `/v1/terminal/readers/${encodeURIComponent(readerId)}/cancel_action`, {}); } catch { /* reader may already be idle */ }
      return { ok: true };
    },

    async refund({ paymentRef, amountCents, idempotencyKey }) {
      try {
        const r = await call('POST', '/v1/refunds', { payment_intent: paymentRef, amount: amountCents }, { idempotencyKey });
        return { ok: true, ref: r.id };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // Every payment created in [from, to), for the daily money check (services/moneychecks.js).
    async listPayments({ from, to }) {
      const out = [];
      let after;
      for (let page = 0; page < 50; page++) {
        const r = await call('GET', '/v1/payment_intents', { created: { gte: Math.floor(Date.parse(from) / 1000), lt: Math.floor(Date.parse(to) / 1000) }, limit: 100, starting_after: after });
        for (const pi of r.data ?? []) out.push({ ref: pi.id, status: pi.status, amount_cents: pi.amount_received || pi.amount, created_at: new Date(pi.created * 1000).toISOString(), description: pi.description ?? null });
        if (!r.has_more || !r.data?.length) break;
        after = r.data[r.data.length - 1].id;
      }
      return out;
    },

    async connectionToken(locationId) {
      const t = await call('POST', '/v1/terminal/connection_tokens', locationId ? { location: locationId } : {});
      return t.secret;
    },
    async createLocation(loc) {
      const l = await call('POST', '/v1/terminal/locations', {
        display_name: loc.name,
        address: { line1: loc.address_line1, city: loc.city, state: loc.state, postal_code: loc.postal_code, country: loc.country || 'US' },
        metadata: { location_id: loc.id }
      });
      return l.id;
    },
    async registerReader({ code, label, locationRef }) {
      try {
        const r = await call('POST', '/v1/terminal/readers', { registration_code: code, label, location: locationRef });
        return { ok: true, id: r.id, deviceType: r.device_type, label: r.label };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // Hosted Stripe page where a client adds a card; card details never touch this server.
    async cardSetupSession({ customerId, ownerKey = 'client_id', ownerId, successUrl, cancelUrl }) {
      const s = await call('POST', '/v1/checkout/sessions', {
        mode: 'setup', currency, customer: customerId, payment_method_types: ['card'],
        success_url: successUrl, cancel_url: cancelUrl, metadata: { [ownerKey]: ownerId }
      });
      return { id: s.id, url: s.url };
    },
    // Close an unpaid hosted payment page so it can't be paid later. Already paid or expired: nothing to do.
    async expireCheckoutSession(id) {
      try { await call('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {}); return true; } catch { return false; }
    },
    // Hosted payment page for a team invoice: card, or US bank account (ACH) when billing in USD. Pay links pass cardOnly.
    async checkoutPayment({ amountCents, description, email, metadata, successUrl, cancelUrl, idempotencyKey, cardOnly = false }) {
      const s = await call('POST', '/v1/checkout/sessions', {
        mode: 'payment', payment_method_types: currency === 'usd' && !cardOnly ? ['card', 'us_bank_account'] : ['card'], customer_email: email ?? undefined,
        line_items: [{ price_data: { currency, unit_amount: amountCents, product_data: { name: description } }, quantity: 1 }],
        metadata, payment_intent_data: { metadata }, success_url: successUrl, cancel_url: cancelUrl
      }, { idempotencyKey });
      return { id: s.id, url: s.url };
    },
    async getCheckoutSession(id) {
      const s = await call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);
      return { paid: s.payment_status === 'paid', ref: s.payment_intent ?? s.id, metadata: s.metadata ?? {} };
    },
    async getSetupSession(id) {
      const s = await call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`, { expand: ['setup_intent.payment_method'] });
      const pm = s.setup_intent?.payment_method;
      return { clientId: s.metadata?.client_id, familyId: s.metadata?.family_id, paymentMethod: pm?.id, brand: pm?.card?.brand, last4: pm?.card?.last4, expMonth: pm?.card?.exp_month, expYear: pm?.card?.exp_year };
    },
    async getPaymentMethod(id) {
      const pm = await call('GET', `/v1/payment_methods/${encodeURIComponent(id)}`);
      return { brand: pm.card?.brand, last4: pm.card?.last4, expMonth: pm.card?.exp_month, expYear: pm.card?.exp_year };
    },

    // Stripe-Signature: t=<time>,v1=<hmac>[,v1=...]
    verifyWebhook(rawBody, header, toleranceSec = 300) {
      if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
      const parts = String(header || '').split(',').map((p) => p.split('='));
      const t = parts.find(([k]) => k === 't')?.[1];
      const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
      if (!t || !sigs.length) throw new Error('Missing Stripe signature.');
      if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) throw new Error('Stripe signature is too old.');
      const expected = Buffer.from(createHmac('sha256', webhookSecret).update(`${t}.${rawBody}`).digest('hex'));
      if (!sigs.some((s) => { const b = Buffer.from(s); return b.length === expected.length && timingSafeEqual(b, expected); })) throw new Error('Stripe signature does not match.');
      return JSON.parse(rawBody);
    }
  };
}

// Stripe's form encoding: nested objects become a[b]=c, arrays become a[0]=x.
export function encode(obj, prefix) {
  const out = [];
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(val)) val.forEach((item, i) => (typeof item === 'object' ? out.push(encode(item, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`)));
    else if (typeof val === 'object') { const inner = encode(val, key); if (inner) out.push(inner); }
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
  }
  return out.filter(Boolean).join('&');
}
