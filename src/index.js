import { createApp } from './server.js';
import { createStripeProvider } from './payments/stripe-provider.js';
import { createTestProvider } from './payments/test-provider.js';
import { createUser } from './services/access.js';

// Accept the setting names used by the first deployment, so existing hosts keep working.
const env = process.env;
env.PUBLIC_URL ||= env.DP_APP_URL || env.RENDER_EXTERNAL_URL || '';
env.EMAIL_FROM ||= env.DP_EMAIL_FROM || '';
env.EMAIL_REPLY_TO ||= env.DP_EMAIL_REPLY_TO || '';
env.EMAIL_ONLY_TO ||= env.DP_EMAIL_ONLY_TO || '';

const port = Number(process.env.PORT || 3000);
// A demo copy (DP_DEMO=1, i.e. staging) runs in test mode unless DP_TEST_MODE says otherwise.
const testMode = process.env.DP_TEST_MODE ? process.env.DP_TEST_MODE === 'true' : process.env.DP_DEMO === '1';
const payments = process.env.STRIPE_SECRET_KEY
  ? createStripeProvider({ secretKey: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET, currency: process.env.CURRENCY || 'usd' })
  : createTestProvider();
if (payments.live && testMode) { console.error('Refusing to start: DP_TEST_MODE=true with a live Stripe key. Set DP_TEST_MODE=false.'); process.exit(1); }

// Production checks: refuse settings that would be unsafe with real families' data and money.
const problems = [], warnings = [];
if (!testMode) {
  if (!process.env.PUBLIC_URL?.startsWith('https://')) problems.push('PUBLIC_URL must be your https:// address (for example https://app.diamondprotocol.com).');
  if (process.env.ADMIN_PASSWORD === 'change-me-now') problems.push('ADMIN_PASSWORD is still the sample password. Change or remove it.');
  if (!process.env.STRIPE_SECRET_KEY) warnings.push('No STRIPE_SECRET_KEY: payments use the built-in test provider and nothing is charged.');
  if (!process.env.RESEND_API_KEY) warnings.push('No RESEND_API_KEY: emails (parent sign-in codes!) are only logged, not sent.');
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) warnings.push('No STRIPE_WEBHOOK_SECRET: Stripe events will be rejected.');
  if (!process.env.TWILIO_ACCOUNT_SID) warnings.push('No TWILIO_ACCOUNT_SID: text messages are only logged, not sent.');
}
if (problems.length) { console.error(`Refusing to start:\n- ${problems.join('\n- ')}`); process.exit(1); }
for (const w of warnings) console.warn(`Warning: ${w}`);
const { server, ctx } = createApp({ dbFile: process.env.DB_FILE || 'data/diamond.db', testMode, payments, publicUrl: process.env.PUBLIC_URL,
  mail: { resendKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM || 'Diamond Protocol <onboarding@resend.dev>', replyTo: process.env.EMAIL_REPLY_TO, onlyTo: process.env.EMAIL_ONLY_TO },
  sms: { accountSid: process.env.TWILIO_ACCOUNT_SID, authToken: process.env.TWILIO_AUTH_TOKEN, from: process.env.TWILIO_FROM, onlyTo: process.env.SMS_ONLY_TO } });

// First start on a new server: create the owner from ADMIN_EMAIL / ADMIN_PASSWORD, who must change it on first sign-in.
if (!ctx.db.get('SELECT COUNT(*) AS n FROM users').n && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== 'change-me-now') {
  const u = createUser(ctx, { email: process.env.ADMIN_EMAIL, name: process.env.ADMIN_NAME || 'Owner', password: process.env.ADMIN_PASSWORD });
  ctx.db.run('UPDATE users SET must_change_password = 1 WHERE id = ?', u.id);
  console.log(`Created the owner account ${u.email}. Sign in and choose a new password, then remove ADMIN_PASSWORD from the settings.`);
}

server.listen(port, () => {
  const users = ctx.db.get('SELECT COUNT(*) AS n FROM users').n;
  console.log(`Diamond Protocol running at http://localhost:${port}`);
  console.log(`Payments: ${payments.name === 'stripe' ? (payments.live ? 'Stripe LIVE (real charges)' : 'Stripe test mode') : 'built-in test mode (no Stripe key, nothing is charged)'}`);
  if (!users) console.log('No coach account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD and restart, or run `npm run seed` for sample data.');
});
// Hosts stop the app with SIGTERM during deploys: finish in-flight requests, close the database cleanly.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  console.log(`${sig} received, shutting down.`);
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 10000).unref();
});
