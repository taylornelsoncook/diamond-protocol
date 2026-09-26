// Core background jobs: session generation, membership renewals and declined-charge retries.
'use strict';
const booking = require('../services/booking');
const billing = require('../services/billing');

module.exports = {
  routes() {},
  jobs: [
    { name: 'generate-sessions', everyMin: 60, run: () => booking.generateEvents() },
    { name: 'renew-memberships', everyMin: 60, run: () => billing.renewDue() },
    { name: 'retry-declined', everyMin: 60, run: () => billing.retryFailed() },
  ],
};
