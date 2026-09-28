import { newId, token } from '../util.js';

// Payment provider used in test mode. It charges nothing.
// - A client whose card_status is 'declining' gets declined charges.
// - In-person payments stay pending until simulated (POST /v1/sales/:id/simulate), standing in for a tap or a reader.
// The Stripe provider (stripe-provider.js) implements the same functions against Stripe's API.
export function createTestProvider() {
  const intents = new Map();
  const brands = ['visa', 'mastercard', 'amex', 'discover'];

  return {
    name: 'test',
    live: false,

    async ensureCustomer(client) { return client.stripe_customer_id || `cus_test_${token(8)}`; },

    async chargeSaved({ client }) {
      // Like Stripe: no saved card means nothing to charge.
      if (!client.card_payment_method) return { ok: false, error: 'No card on file.' };
      if (client.card_status === 'declining') return { ok: false, error: 'Card declined by the bank.' };
      return { ok: true, ref: newId('pi_test') };
    },

    async createInPersonIntent({ amountCents, saveCard }) {
      const id = newId('pi_test');
      const intent = { id, clientSecret: `${id}_secret_${token(12)}`, amountCents, saveCard, status: 'requires_payment_method', error: null, card: null, savedCard: null };
      intents.set(id, intent);
      return { id, clientSecret: intent.clientSecret };
    },
    async getIntent(id) {
      const i = intents.get(id);
      if (!i) return { status: 'canceled', error: 'Payment not found.' };
      return { status: i.status, error: i.error, card: i.card, savedCard: i.savedCard };
    },
    async captureIntent(id) { const i = intents.get(id); if (i?.status === 'requires_capture') i.status = 'succeeded'; },
    async cancelIntent(id) { const i = intents.get(id); if (i && i.status !== 'succeeded') i.status = 'canceled'; },
    async processOnReader() { return { ok: true }; },
    async cancelReaderAction() { return { ok: true }; },

    // Test-mode stand-in for the customer tapping their card.
    simulate(id, outcome) {
      const i = intents.get(id);
      if (!i) return;
      const n = Math.floor(Math.random() * 4);
      i.card = { brand: brands[n], last4: String(4242 + n) };
      if (outcome === 'declined') { i.status = 'requires_payment_method'; i.error = 'Card declined by the bank.'; }
      else { i.status = 'succeeded'; i.error = null; i.savedCard = i.saveCard ? `pm_test_${token(8)}` : null; }
    },

    async refund() { return { ok: true, ref: newId('re_test') }; },
    async connectionToken() { return `pst_test_${token(16)}`; },
    async createLocation() { return `tml_test_${token(8)}`; },
    async registerReader({ code, label }) {
      if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(code) && code !== 'simulated-wpe') return { ok: false, error: 'That registration code is not valid. Check the three words on the reader screen.' };
      return { ok: true, id: `tmr_test_${token(8)}`, deviceType: 'simulated_wisepos_e', label };
    },

    // No hosted card page in test mode; the dashboard offers "Add test card" instead.
    async cardSetupSession() { return { id: null, url: null }; },
    testCard() { return { paymentMethod: `pm_test_${token(8)}`, brand: 'visa', last4: '4242', expMonth: 12, expYear: new Date().getUTCFullYear() + 3 }; },

    verifyWebhook() { throw new Error('Webhooks are only used with Stripe.'); }
  };
}
