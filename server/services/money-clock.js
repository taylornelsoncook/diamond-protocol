// Test-mode billing clock: run renewals, retries and school invoicing as if it were a later date.
// Mirrors services/billing renewDue()/retryFailed(), which always use today's date.
'use strict';
const { get, all, run, update, tx } = require('../db');
const { payments, sendEmail, emit, addDays, addMonths, money } = require('../lib');
const billing = require('./billing');
const schools = require('./money-schools');

const RETRY_DAYS = 3, MAX_ATTEMPTS = 4;

function renewAsOf(asOf) {
  let charged = 0, declined = 0;
  for (let guard = 0; guard < 24; guard++) {
    const due = all("SELECT * FROM memberships WHERE status IN ('active','trial') AND next_charge<=?", asOf);
    if (!due.length) break;
    for (const m of due) tx(() => {
      const fam = billing.familyOf(m.athlete_id);
      const plan = get('SELECT * FROM plans WHERE id=?', m.plan_id);
      const amount = m.price_cents ?? plan.price_cents;
      const r = billing.charge({ family_id: fam?.id, athlete_id: m.athlete_id, amount_cents: amount, description: `${plan.name}: ${require('../lib').monthLabel(m.next_charge)}`, kind: 'membership', membership_id: m.id, period: m.next_charge.slice(0, 7) });
      if (r.ok) {
        charged++;
        update('memberships', m.id, { status: 'active', next_charge: addMonths(m.next_charge, 1) });
        if (plan.private_per_month) run('UPDATE athletes SET private_credits=private_credits+? WHERE id=?', plan.private_per_month, m.athlete_id);
      } else {
        declined++;
        update('memberships', m.id, { status: 'past_due', next_charge: addMonths(m.next_charge, 1) });
        run('UPDATE invoices SET next_retry=? WHERE id=?', addDays(asOf, RETRY_DAYS), r.invoice_id);
        const a = get('SELECT first_name FROM athletes WHERE id=?', m.athlete_id);
        sendEmail(billing.billingEmail(fam?.id), `Payment declined for ${a.first_name}'s membership`, `We couldn't charge your card for ${plan.name} (${money(amount)}). We'll try again in ${RETRY_DAYS} days. To update your card, sign in to the parent portal and open the Family tab.`);
      }
    });
  }
  return { charged, declined };
}

function retryAsOf(asOf) {
  const list = all("SELECT * FROM invoices WHERE status='failed' AND kind IN ('membership','charge') AND next_retry<=? AND attempts<?", asOf, MAX_ATTEMPTS);
  let paid = 0;
  for (const inv of list) {
    const family = get('SELECT * FROM families WHERE id=?', inv.family_id);
    const r = payments.charge({ amount_cents: inv.amount_cents, method: 'card', family });
    if (r.ok) {
      update('invoices', inv.id, { status: 'paid', paid_at: new Date().toISOString(), charge_id: r.charge_id, attempts: inv.attempts + 1, next_retry: null });
      if (inv.membership_id) run("UPDATE memberships SET status='active' WHERE id=? AND status='past_due'", inv.membership_id);
      emit('payment.succeeded', { invoice_id: inv.id, amount_cents: inv.amount_cents, retry: true });
      paid++;
    } else update('invoices', inv.id, { attempts: inv.attempts + 1, next_retry: addDays(asOf, RETRY_DAYS) });
  }
  return { tried: list.length, paid };
}

function runBillingAsOf(asOf) {
  const renew = renewAsOf(asOf);
  const retry = retryAsOf(asOf);
  const school_invoices = schools.runSchoolInvoicing(asOf);
  const reminders = schools.sendOverdueReminders(asOf);
  return { ...renew, retried: retry.tried, recovered: retry.paid, school_invoices, reminders };
}

module.exports = { runBillingAsOf };
