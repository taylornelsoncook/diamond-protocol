import * as billing from './services/billing.js';
import * as clients from './services/clients.js';
import * as programs from './services/programs.js';
import * as events from './services/events.js';
import * as access from './services/access.js';
import * as commerce from './services/commerce.js';
import * as families from './services/families.js';
import * as schedule from './services/schedule.js';
import * as teams from './services/teams.js';
import * as perf from './services/performance.js';
import * as perfImport from './services/perf-import.js';
import * as uploads from './services/uploads.js';
import * as queue from './services/queue.js';
import * as security from './services/security.js';
import * as staff from './services/staff.js';
import * as integrations from './services/integrations.js';
import * as backups from './services/backups.js';
import * as offsite from './services/offsite.js';
import * as reports from './services/reports.js';
import * as library from './services/library.js';
import * as legal from './services/legal.js';
import * as clientImport from './services/client-import.js';
import * as engage from './services/engage.js';
import { listOutbox, outboxCounts, resendEmail, sendEmail, mailMode } from './services/mail.js';
import * as sms from './services/sms.js';
import * as insights from './services/insights.js';
import * as leads from './services/leads.js';
import * as paylinks from './services/paylinks.js';
import * as checkin from './services/checkin.js';
import * as screen from './services/screen.js';
import * as inventory from './services/inventory.js';
import * as reviews from './services/reviews.js';
import * as campaigns from './services/campaigns.js';
import * as shop from './services/shop.js';
import * as spots from './services/spots.js';
import * as notes from './services/notes.js';
import * as moneychecks from './services/moneychecks.js';
import * as today from './services/today.js';
import { portalRoutes } from './portal-routes.js';
import { portalInvite } from './services/notify.js';
import { HttpError, v, badRequest, notFound, zonedToUtc, localDate, startOfLocalDay } from './util.js';

// Coaches work only with the sales they rang up; anyone else's reads as not found.
function ownSale(ctx, r) {
  if (r.user?.role !== 'coach') return;
  if (ctx.db.get('SELECT created_by FROM sales WHERE id = ?', r.params.id)?.created_by !== r.user.id) throw notFound('Sale');
}

// auth: 'public' | 'any' (coach session or API key) | 'session' (coach login only; for managing keys and webhooks)
// Each entry: [method, path, auth, tag, summary, handler(ctx, req)] where req = { params, query, body, user, apiKey }
const list = (data) => ({ data });
// Coaches never see money, so they can't change a price they can't see: prices are the owner's.
const noPricesFromCoach = (r) => {
  if (r.user?.role === 'coach' && ['drop_in_cents', 'registration_cents'].some((k) => r.body[k] !== undefined)) throw new HttpError(403, 'forbidden', 'Only the owner changes prices. Leave the price out and save again.');
};
// Team sessions follow their contract (teams.js can't import schedule.js, which imports it).
const teamSchedule = (ctx) => ({ updateSeries: (id, b) => schedule.updateSeries(ctx, id, b), cancelSession: (id, o) => schedule.cancelSession(ctx, id, o), generateSessions: (id) => schedule.generateSessions(ctx, id) });
// Who is writing a staff note: the signed-in staff member, or an API key (treated like the owner).
// Who made a report share link: the signed-in staff member or an API key.
const staffBy = (r) => (r.user ? { kind: 'staff', id: r.user.id, name: r.user.name } : { kind: 'staff', id: r.apiKey?.id ?? null, name: r.apiKey?.label ?? 'API' });
const noteActor = (r) => (r.user ? { id: r.user.id, name: r.user.name, role: r.user.role } : { id: null, name: r.apiKey?.label ?? 'API', role: 'owner' });
const subOf = (ctx, clientId) => {
  const s = billing.currentSubscription(ctx, clientId);
  if (!s) throw new HttpError(409, 'conflict', 'This client has no active subscription.');
  return s.id;
};

export const routes = [
  // Coach login
  ['POST', '/auth/login', 'public', 'Auth', 'Sign in as a coach. Sets a session cookie.', (ctx, r) => access.login(ctx, r.body, { ip: r.ip, userAgent: r.userAgent })],
  ['POST', '/auth/logout', 'session', 'Auth', 'Sign out.', (ctx, r) => { access.logout(ctx, r.sessionToken); return { ok: true }; }],
  ['POST', '/auth/token', 'public', 'Auth', 'Sign in from the iPhone coach app. Returns a 90-day bearer token (dp_app_...).', (ctx, r) => access.appLogin(ctx, r.body, { ip: r.ip, userAgent: r.userAgent })],
  ['POST', '/auth/password', 'session', 'Auth', 'Change your password: current_password, new_password (10+ characters). Signs out your other devices and emails you.', (ctx, r) => security.changePassword(ctx, r.user, r.body)],
  ['POST', '/auth/forgot', 'public', 'Auth', 'Forgot password: email. Emails a staff account a link that works once, for 30 minutes. The answer is the same for any email.', (ctx, r) => staff.requestPasswordReset(ctx, r.body, { ip: r.ip, baseUrl: r.baseUrl })],
  ['POST', '/auth/reset/check', 'public', 'Auth', 'Check a reset link before choosing a password: token.', (ctx, r) => staff.checkReset(ctx, r.body)],
  ['POST', '/auth/reset', 'public', 'Auth', 'Choose a new password with an emailed reset link: token, password (10+ characters). Signs out every device.', (ctx, r) => staff.resetPassword(ctx, r.body)],
  ['GET', '/auth/account', 'session', 'Auth', 'Your account: the devices you are signed in on and your recent sign-ins.', (ctx, r) => ({
    user: { id: r.user.id, name: r.user.name, email: r.user.email, role: r.user.role }, devices: access.listDevices(ctx, r.user.id, r.user.session_id),
    sign_ins: security.listAudit(ctx, { staff_id: r.user.id, kind: 'sign_ins', limit: 10 }).map((a) => ({ at: a.at, action: a.action, status: a.status, ip: a.ip })) })],
  ['POST', '/auth/devices/:id/sign-out', 'session', 'Auth', 'Sign out one of your other devices.', (ctx, r) => access.endSession(ctx, r.user.id, r.params.id, r.user.session_id)],
  ['POST', '/auth/sign-out-others', 'session', 'Auth', 'Sign out every device but this one.', (ctx, r) => ({ ok: true, signed_out: access.endSessions(ctx, r.user.id, { exceptId: r.user.session_id }) })],
  ['GET', '/auth/me', 'session', 'Auth', 'The signed-in coach.', (ctx, r) => ({ user: { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role, must_change_password: !!r.user.must_change_password }, roles: security.ROLES, test_mode: ctx.testMode, payments: { provider: ctx.payments.name, live: ctx.payments.live, can_simulate: !!ctx.payments.simulate } })],
  ['GET', '/v1/dashboard', 'any', 'Dashboard', 'Revenue, client counts, items that need attention and recent activity.', (ctx, r) => access.dashboard(ctx, { role: r.user?.role ?? 'owner' })],
  ['GET', '/v1/today', 'any', 'Dashboard', 'Today\'s floor: sessions with their state (live, next, done, later), everyone booked today for one-tap check-in (still to arrive first) with door alerts (medical notes, no waiver, unpaid, a rough daily check-in, birthday), birthdays in the next 7 days, daily check-ins that need a look, tomorrow in one line, and (owners and coaches) athletes to check on with what was followed up lately.', (ctx, r) => today.todayBoard(ctx, { role: r.user?.role ?? 'owner' })],
  ['POST', '/v1/today/follow-ups', 'any', 'Dashboard', 'Follow up on a Today item (owners and coaches): key (risk:<client id> or flag:<client id>:<date>), action (reached_out, noted or reviewed), optional days (1 to 60; default 7 for athletes, through the next day for check-ins) and note. Hides it from everyone\'s Today until then and says who did it.', (ctx, r) => insights.snoozeFollowUp(ctx, r.body, r.user ?? { name: r.apiKey?.label ?? 'API' }), 201],
  ['DELETE', '/v1/today/follow-ups/:id', 'any', 'Dashboard', 'Undo a follow-up: the item comes back on Today.', (ctx, r) => insights.unsnooze(ctx, r.params.id)],
  ['GET', '/v1/activity', 'any', 'Dashboard', 'Recent activity, newest first, 20 at a time (?limit= up to 100): ?filter= checkins, bookings, training, testing, clients or (owner) money; ?before= the next value from the last page. Coaches and front desk never get payments, refunds or amounts.', (ctx, r) => today.activity(ctx, { role: r.user?.role ?? 'owner', filter: r.query.filter, before: r.query.before, limit: r.query.limit ?? 20 })],
  ['GET', '/v1/at-risk', 'any', 'Dashboard', 'Athletes who may be drifting away: a score (40 to 100) and the reasons, from attendance, bookings, check-ins and (owners only) payments.', (ctx, r) => list(insights.atRisk(ctx, { role: r.user?.role ?? 'owner' }))],
  ['GET', '/v1/digest', 'any', 'Dashboard', 'This week\'s owner summary: money in, members, athletes to check on, open spots and suggested actions. Includes the email text.', (ctx) => { const d = insights.buildDigest(ctx); return { ...d, text: insights.digestText(ctx, d) }; }],
  ['POST', '/v1/digest/send', 'session', 'Dashboard', 'Email this week\'s summary to the owners now.', (ctx) => insights.sendDigest(ctx)],
  ['GET', '/v1/events', 'any', 'Dashboard', 'Recent events, newest first. Filter with ?type=.', (ctx, r) => list(events.listEvents(ctx, { type: r.query.type, limit: v.int(r.query.limit ?? 50, 'limit', { min: 1, max: 200 }) })
    .filter((e) => !r.user || r.user.role === 'owner' || !security.OWNER_EVENTS.test(e.type)))],

  // Clients
  ['GET', '/v1/clients', 'any', 'Clients', 'List clients. Filter with ?q= (name, athlete ID, email, family, school, or a parent\'s name, email or phone; phone numbers also match on digits) and ?status= (a membership status, none, current for active clients: paid up or on a free trial, team for athletes on a school or club team with no membership, or no_waiver for families who haven\'t signed the current waiver). ?sort= name (default), last_seen (longest since last seen first) or newest. Each client has flags (medical, no_waiver, no_card), pinned_notes, teams and last_seen_at (latest check-in or workout). Archived clients are left out: ?archived=true lists only them, ?archived=all everyone. archived_matches says how many archived clients the search would have found.', (ctx, r) => {
    const out = list(clients.listClients(ctx, { ...r.query, role: r.user?.role }));
    return r.query.archived === 'true' || r.query.archived === 'all' ? out : { ...out, archived_matches: clients.archivedMatches(ctx, r.query.q) };
  }],
  ['GET', '/v1/client-counts', 'any', 'Clients', 'How many clients have each membership status, how many are active (current: paid up or on a free trial), on a team with no membership (team), missing the current waiver (no_waiver) and archived.', (ctx) => clients.clientCounts(ctx)],
  ['GET', '/v1/client-export', 'any', 'Clients', 'Owner only. The client list as a CSV file (contact details, membership, waiver, last seen; never amounts), with the same ?q=, ?status=, ?sort= and ?archived= as GET /v1/clients.', (ctx, r) => {
    const file = clients.exportClients(ctx, r.query);
    security.audit(ctx, { ...(r.user ? { actor_type: 'staff', actor_id: r.user.id, actor_name: r.user.name, role: r.user.role } : { actor_type: 'api_key', actor_id: r.apiKey?.id, actor_name: r.apiKey?.label }), action: `exported ${file.count} ${file.count === 1 ? 'client' : 'clients'} as CSV`, target: null, status: 200, ip: r.ip });
    return { __file: file };
  }],
  ['POST', '/v1/clients', 'any', 'Clients', 'Create a client. Optional plan_id starts a subscription (with trial); optional program_id assigns a program (not front desk). Refused with 409 duplicate_email when the email belongs to a client, parent_exists when the parent\'s email already signs in for a family (add the athlete to that family instead), and possible_duplicate when a client has the same name and birthday (archived clients too) or the same phone number; details.duplicates lists them (possible_duplicate only with check_duplicates: true, which the dashboard sends; resend without it to create the account anyway).', (ctx, r) => clients.createClient(ctx, r.body, { staff: { role: r.user?.role ?? 'owner' } }), 201],
  ['GET', '/v1/clients/:id', 'any', 'Clients', 'Get a client with subscription, program, family, teams, flags and app link.', (ctx, r) => clients.getClient(ctx, r.params.id, { withSecrets: !r.apiKey || r.apiKey.scope === 'full', role: r.user?.role })],   // the app link lets anyone who has it log workouts: not for read-only keys
  ['PATCH', '/v1/clients/:id', 'any', 'Clients', 'Update name, email, phone, notes and profile fields (birth_date, sex, sport, position, school, grad_year, medical_notes, emergency_name, emergency_phone, athlete_id).', (ctx, r) => { clients.updateClient(ctx, r.params.id, r.body); return clients.getClient(ctx, r.params.id, { withSecrets: true, role: r.user?.role }); }],
  ['GET', '/v1/clients/:id/attendance', 'any', 'Clients', 'Attendance: visits (roster and walk-in check-ins), no-shows and late cancels in the last 30 days, visits in 90 days, the last visit, and the 12 most recent outcomes (attended, walk_in, no_show, late_cancel, in_progress). A booking in a session that is still running isn\'t a no-show yet.', (ctx, r) => clients.attendance(ctx, r.params.id)],
  ['POST', '/v1/clients/:id/family', 'any', 'Clients', 'Put a client who has no family (a team roster athlete, say) in one (owner and coach): family_id of a family you already have, or parent {name, email, phone} for a new family (the parent is emailed how to sign in; send_welcome=false to skip). Someone already in a family is not moved.', (ctx, r) => clients.joinFamily(ctx, r.params.id, r.body)],
  ['POST', '/v1/clients/:id/archive', 'any', 'Clients', 'Archive a client who stopped training (owner and coach): hidden from lists, search, pickers and automatic messages; nothing is deleted. Refused while they have a membership. Upcoming bookings and standing spots are canceled, which needs confirm: true.', (ctx, r) => clients.archiveClient(ctx, r.params.id, r.body, r.user)],
  ['POST', '/v1/clients/:id/restore', 'any', 'Clients', 'Bring an archived client back.', (ctx, r) => clients.restoreClient(ctx, r.params.id, r.user)],
  ['GET', '/v1/clients/:id/notes', 'any', 'Clients', 'Staff notes on a client, pinned first, then newest. Front desk doesn\'t get coach-only notes.', (ctx, r) => list(clients.listNotes(ctx, r.params.id, noteActor(r)))],
  ['POST', '/v1/clients/:id/notes', 'any', 'Clients', 'Add a staff note: body, pinned (true shows it at the top of the client page), coach_only (true hides it from front desk).', (ctx, r) => clients.addNote(ctx, r.params.id, r.body, noteActor(r)), 201],
  ['PATCH', '/v1/client-notes/:id', 'any', 'Clients', 'Change a staff note: body, pinned, coach_only. Only its author can change it; owners can pin or unpin any note.', (ctx, r) => clients.updateNote(ctx, r.params.id, r.body, noteActor(r))],
  ['DELETE', '/v1/client-notes/:id', 'any', 'Clients', 'Delete a staff note: owners any, everyone else their own.', (ctx, r) => clients.deleteNote(ctx, r.params.id, noteActor(r))],
  ['POST', '/v1/clients/:id/app-link', 'any', 'Clients', 'Issue a new private app link. The old link stops working.', (ctx, r) => clients.resetAppLink(ctx, r.params.id)],
  ['POST', '/v1/clients/:id/app-link/email', 'any', 'Clients', 'Email the private workout-app link to the athlete\'s own email and their parents. sent_to lists the addresses. Refused for archived clients.', (ctx, r) => clients.emailAppLink(ctx, r.params.id)],
  ['POST', '/v1/clients/:id/subscription', 'any', 'Clients', 'Start a subscription on plan_id.', async (ctx, r) => billing.subscribe(ctx, r.params.id, v.str(r.body.plan_id, 'plan_id')), 201],
  ['POST', '/v1/clients/:id/subscription/pause', 'any', 'Clients', 'Pause billing and app access.', (ctx, r) => billing.pause(ctx, subOf(ctx, r.params.id))],
  ['POST', '/v1/clients/:id/subscription/resume', 'any', 'Clients', 'Resume a paused subscription. Starts a new period and charges today.', (ctx, r) => billing.resume(ctx, subOf(ctx, r.params.id))],
  ['POST', '/v1/clients/:id/subscription/cancel', 'any', 'Clients', 'Cancel now. Open invoices are voided.', (ctx, r) => billing.cancel(ctx, subOf(ctx, r.params.id))],
  ['POST', '/v1/clients/:id/subscription/plan', 'any', 'Clients', 'Move to plan_id. The new price applies from the next renewal.', (ctx, r) => billing.changePlan(ctx, subOf(ctx, r.params.id), v.str(r.body.plan_id, 'plan_id'))],
  ['GET', '/v1/clients/:id/invoices', 'any', 'Clients', 'A client\'s invoices.', (ctx, r) => { clients.getClient(ctx, r.params.id); return list(billing.listInvoices(ctx, { clientId: r.params.id })); }],
  ['GET', '/v1/clients/:id/workouts', 'any', 'Clients', 'A client\'s completed workouts.', (ctx, r) => { clients.getClient(ctx, r.params.id); return list(programs.listCompletions(ctx, { clientId: r.params.id })); }],

  // Billing
  ['GET', '/v1/plans', 'any', 'Billing', 'List plans. ?include_inactive=true to include retired plans.', (ctx, r) => list(billing.listPlans(ctx, { includeInactive: r.query.include_inactive === 'true' }))],
  ['POST', '/v1/plans', 'any', 'Billing', 'Create a monthly plan: name, price_cents, trial_days.', (ctx, r) => billing.createPlan(ctx, r.body), 201],
  ['PATCH', '/v1/plans/:id', 'any', 'Billing', 'Update a plan. Set active=false to stop offering it.', (ctx, r) => billing.updatePlan(ctx, r.params.id, r.body)],
  ['GET', '/v1/subscriptions', 'any', 'Billing', 'List subscriptions. Filter with ?status=.', (ctx, r) => list(billing.listSubscriptions(ctx, r.query))],
  ['GET', '/v1/invoices', 'any', 'Billing', 'List invoices. Filter with ?status= (open, paid, failed, void).', (ctx, r) => list(billing.listInvoices(ctx, { status: r.query.status }))],
  ['POST', '/v1/invoices/:id/retry', 'any', 'Billing', 'Charge a failed invoice again now.', (ctx, r) => billing.retryInvoice(ctx, r.params.id)],
  ['GET', '/v1/money-checks', 'any', 'Billing', 'Daily money checks, newest first (?limit=, default 14): possible double charges, refund spikes, stuck payments and, with Stripe connected, card payments matched one by one.', (ctx, r) => moneychecks.listChecks(ctx, { limit: r.query.limit })],
  ['POST', '/v1/money-checks/run', 'any', 'Billing', 'Check a day now: date (YYYY-MM-DD, default yesterday). Replaces that day\'s check.', (ctx, r) => moneychecks.runCheck(ctx, r.body, r.user)],
  ['PATCH', '/v1/money-checks/:id', 'any', 'Billing', 'Mark a day\'s findings as looked at (reviewed: true; false undoes it).', (ctx, r) => moneychecks.markReviewed(ctx, r.params.id, r.body, r.user)],
  ['GET', '/v1/pay-links', 'any', 'Billing', 'Pay links, newest first. Filter with ?status= (open, paid, settled, canceled) or ?client_id=.', (ctx, r) => paylinks.listPayLinks(ctx, { status: r.query.status, clientId: r.query.client_id })],
  ['POST', '/v1/pay-links', 'any', 'Billing', 'Make a pay link: kind (invoice with invoice_id, booking with booking_id, product with client_id and product_id, custom with client_id, description and amount_cents); send=true emails parents and texts those who turned texts on.', (ctx, r) => paylinks.createPayLink(ctx, r.body, r.user?.name ?? 'API'), 201],
  ['GET', '/v1/pay-links/:id', 'any', 'Billing', 'A pay link and its public URL.', (ctx, r) => paylinks.getPayLink(ctx, r.params.id)],
  ['POST', '/v1/pay-links/:id/send', 'any', 'Billing', 'Email and text the link to the family again.', (ctx, r) => paylinks.sendPayLink(ctx, r.params.id)],
  ['POST', '/v1/pay-links/:id/cancel', 'any', 'Billing', 'Stop a link from being paid.', (ctx, r) => paylinks.cancelPayLink(ctx, r.params.id)],
  ['GET', '/v1/clients/:id/owed', 'any', 'Billing', 'What a client owes now (failed membership payments, unpaid sessions) and their open pay links.', (ctx, r) => { clients.getClient(ctx, r.params.id); return paylinks.owedBy(ctx, r.params.id); }],
  ['GET', '/receipt-api/:token', 'public', 'Point of sale', 'The printable receipt page for a sale (the link in the receipt email).', (ctx, r) => commerce.publicReceipt(ctx, r.params.token)],
  ['GET', '/pay-api/:token', 'public', 'Billing', 'The parent\'s pay page (the link in the email or text).', (ctx, r) => paylinks.publicPayLink(ctx, r.params.token)],
  ['POST', '/pay-api/:token/checkout', 'public', 'Billing', 'Start paying by card on Stripe\'s secure page.', (ctx, r) => paylinks.checkoutPayLink(ctx, r.params.token)],
  ['POST', '/pay-api/:token/confirm', 'public', 'Billing', 'Back from Stripe: record the payment if it went through.', (ctx, r) => paylinks.confirmPayLink(ctx, r.params.token)],
  ['POST', '/pay-api/:token/simulate', 'public', 'Billing', 'Test mode only: mark the link paid.', (ctx, r) => paylinks.simulatePayLink(ctx, r.params.token)],
  ['POST', '/v1/billing/run', 'any', 'Billing', 'Run renewals and scheduled retries now. In test mode, pass as_of to run for a future date.', (ctx, r) => {
    let asOf = ctx.now();
    if (r.body.as_of !== undefined) {
      if (!ctx.testMode) throw badRequest('as_of is only available in test mode.');
      asOf = v.date(r.body.as_of, 'as_of');
    }
    return billing.runBilling(ctx, asOf);
  }],
  // The Billing screen (owner only, like everything under /v1/billing and /v1/invoices).
  ['GET', '/v1/billing/summary', 'any', 'Billing', 'The numbers at the top of Billing: monthly recurring (members and teams), collected this month net of refunds (the same as Today; a refund counts on the day it was made), today\'s counter money (the day\'s takings), failed payments at risk, open and overdue school invoices, renewals in the next 7 days and the count in each invoice view.', (ctx) => billing.billingSummary(ctx)],
  ['GET', '/v1/billing/attention', 'any', 'Billing', 'What needs following up: every declined membership charge (card, tries, next automatic retry, last card reminder) and every school invoice past due.', (ctx) => billing.needsAttention(ctx)],
  ['GET', '/v1/billing/invoices', 'any', 'Billing', 'Membership payments and school invoices together, newest first. ?view= all, failed, unpaid, overdue, paid, refunds or void; ?kind= membership or school; ?from= and ?to= (dates); ?q= name, plan, school, team or invoice number; ?limit= (default 50, up to 500). Returns the page, total and total_cents for the whole filter, and counts for each view.', (ctx, r) => billing.listBillingInvoices(ctx, r.query)],
  ['GET', '/v1/billing/invoices/export', 'any', 'Billing', 'The same filter as GET /v1/billing/invoices as a CSV file for the bookkeeper (amounts in dollars as plain numbers; each membership refund is its own negative row).', (ctx, r) => {
    const file = billing.exportBillingInvoices(ctx, r.query);
    security.audit(ctx, { ...(r.user ? { actor_type: 'staff', actor_id: r.user.id, actor_name: r.user.name, role: r.user.role } : { actor_type: 'api_key', actor_id: r.apiKey?.id, actor_name: r.apiKey?.label }), action: `exported ${file.count} ${file.count === 1 ? 'invoice' : 'invoices'} as CSV`, target: null, status: 200, ip: r.ip });
    return { __file: file };
  }],
  ['GET', '/v1/billing/memberships', 'any', 'Billing', 'Everyone on a plan: price, status, next charge or trial end, card, failed amount. ?view= live (default), renewing (next 7 days), trialing, past_due, paused or canceled (last 90 days); ?plan_id=; ?q= athlete, family or Athlete ID. Includes counts for each view and the 7-day renewal forecast.', (ctx, r) => billing.listMemberships(ctx, r.query)],
  ['POST', '/v1/billing/retry-declined', 'any', 'Billing', 'Charge every declined membership payment that has a card on file again, now. A decline here never cancels a membership. Returns tried, paid, paid_cents, declined and no_card.', (ctx) => billing.retryDeclined(ctx)],
  ['POST', '/v1/billing/remind-declined', 'any', 'Billing', 'Email every family with a declined charge a card reminder (one email per family listing each charge with its pay link; never twice in a day).', (ctx) => billing.remindDeclined(ctx)],
  ['GET', '/v1/invoices/:id', 'any', 'Billing', 'One membership invoice with its refunds, pay links, card and what can be done now (can.retry, record_payment, remind, pay_link, refund, void).', (ctx, r) => billing.invoiceDetail(ctx, r.params.id)],
  ['POST', '/v1/invoices/:id/refund', 'any', 'Billing', 'Refund all or part of a paid membership payment: reason (required, goes on the receipt), amount_cents (default: everything not yet refunded; never more), email (false skips the receipt). Card payments go back to the card; cash and check payments are logged for you to hand back. The membership carries on.', (ctx, r) => billing.refundInvoice(ctx, r.params.id, r.body, { actor: r.user?.id })],
  ['POST', '/v1/invoices/:id/void', 'any', 'Billing', 'Void (write off) an unpaid or declined membership payment: optional reason. No more retries; open pay links stop working; a membership past due only because of it is active again.', (ctx, r) => billing.voidInvoice(ctx, r.params.id, r.body, { actor: r.user?.name ?? r.apiKey?.label })],
  ['POST', '/v1/invoices/:id/remind', 'any', 'Billing', 'Email the family a card reminder listing every declined charge with its pay link. Once a day per family.', (ctx, r) => billing.remindInvoice(ctx, r.params.id)],
  ['POST', '/v1/invoices/:id/payments', 'any', 'Billing', 'Record a payment that came in another way: method (cash, check, other), reference (check number). A past-due membership is active again.', (ctx, r) => billing.recordInvoicePaymentByHand(ctx, r.params.id, r.body)],

  // Training
  ['GET', '/v1/exercises', 'any', 'Training', 'The exercise library, each with uses (workouts it\'s in) and programs. Filter with ?q= (name or cues), ?category= and ?filter=no_video or unused. categories lists the categories.', (ctx, r) => ({ ...list(programs.listExercises(ctx, { q: r.query.q, category: r.query.category, filter: r.query.filter })), categories: programs.CATEGORIES })],
  ['POST', '/v1/exercises', 'any', 'Training', 'Add an exercise: name (not already in the library), video_url (YouTube, Vimeo or a direct video file), instructions, category.', (ctx, r) => programs.createExercise(ctx, r.body), 201],
  ['PATCH', '/v1/exercises/:id', 'any', 'Training', 'Update an exercise.', (ctx, r) => programs.updateExercise(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/exercises/:id', 'any', 'Training', 'Delete an exercise no workout uses. Sets athletes logged keep its name.', (ctx, r) => programs.deleteExercise(ctx, r.params.id)],
  ['GET', '/v1/programs', 'any', 'Training', 'List programs with workout and client counts, days per week and workouts logged in the last 7 days.', (ctx) => list(programs.listPrograms(ctx))],
  ['POST', '/v1/programs', 'any', 'Training', 'Create a program: name, weeks, level, description. copy_from (a program id) starts it as a copy of that program\'s workouts.', (ctx, r) => programs.createProgram(ctx, r.body), 201],
  ['GET', '/v1/programs/activity', 'any', 'Training', 'The Programs page: workouts logged in the last 7 days, clients on a program, who needs a check-in (no workout for 7 days), who finished, and recent workouts with effort, sets and new bests. ?program_id= for one program, ?days= (1-60, default 14) for the feed. Archived clients are left out.', (ctx, r) => programs.programsActivity(ctx, { programId: r.query.program_id || undefined, days: v.int(r.query.days ?? 14, 'days', { min: 1, max: 60 }) })],
  ['GET', '/v1/programs/:id', 'any', 'Training', 'A program with every workout and exercise, how often each workout was logged, and each client\'s progress (done, next, last workout, needs a check-in).', (ctx, r) => programs.programDetail(ctx, r.params.id)],
  ['PATCH', '/v1/programs/:id', 'any', 'Training', 'Update a program. Weeks can\'t go below the last week that has workouts.', (ctx, r) => programs.updateProgram(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/programs/:id', 'any', 'Training', 'Delete a program nobody is on.', (ctx, r) => programs.deleteProgram(ctx, r.params.id)],
  ['POST', '/v1/programs/:id/duplicate', 'any', 'Training', 'Copy a program with all its weeks and workouts. Optional name (default "<name> (copy)").', (ctx, r) => programs.duplicateProgram(ctx, r.params.id, r.body), 201],
  ['POST', '/v1/programs/:id/workouts', 'any', 'Training', 'Add a workout: week, day (default: the next free day, up to 7), title (default "Day N").', (ctx, r) => programs.addWorkout(ctx, r.params.id, r.body), 201],
  ['POST', '/v1/programs/:id/weeks/:week/copy', 'any', 'Training', 'Copy every workout in a week to week to (default the next week), or to each week from to through through. Weeks that have workouts need replace: true; replacing logged workouts needs confirm: true. The program grows to the last week copied to.', (ctx, r) => programs.copyWeek(ctx, r.params.id, r.params.week, r.body)],
  ['DELETE', '/v1/programs/:id/weeks/:week', 'any', 'Training', 'Clear a week\'s workouts (confirm: true when athletes logged any of them). The last week also comes off the program.', (ctx, r) => programs.deleteWeek(ctx, r.params.id, r.params.week, r.body)],
  ['POST', '/v1/programs/:id/assign', 'any', 'Training', 'Put client_id on this program. Replaces their current program (previous_program says which). Refused for archived clients and for a client already on it.', (ctx, r) => programs.assign(ctx, r.params.id, v.str(r.body.client_id, 'client_id'), r.body.start_date), 201],
  ['DELETE', '/v1/programs/:id/clients/:clientId', 'any', 'Training', 'Take a client off this program. Their logged workouts stay.', (ctx, r) => programs.unassign(ctx, r.params.id, r.params.clientId)],
  ['PATCH', '/v1/workouts/:id', 'any', 'Training', 'Rename a workout: title.', (ctx, r) => programs.updateWorkout(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/workouts/:id', 'any', 'Training', 'Delete a workout. When athletes logged it, send confirm: true (their logs of it go too).', (ctx, r) => programs.deleteWorkout(ctx, r.params.id, r.body)],
  ['POST', '/v1/workouts/:id/copy', 'any', 'Training', 'Copy a workout to week (default its own) and day (default the next free day of that week), with an optional new title.', (ctx, r) => programs.copyWorkout(ctx, r.params.id, r.body), 201],
  ['POST', '/v1/workouts/:id/exercises', 'any', 'Training', 'Add exercise_id to a workout with a prescription like "3 × 10". Optional load_test and load_pct set the weight from the athlete\'s latest tested max; position puts it at that place (Undo after removing).', (ctx, r) => programs.addWorkoutExercise(ctx, r.params.id, r.body), 201],
  ['PATCH', '/v1/workout-exercises/:id', 'any', 'Training', 'Change an exercise\'s prescription, swap it for another exercise_id in the same slot, or change its weight: load_test (squat_1rm, bench_1rm, power_clean_1rm, or null) and load_pct (30 to 110).', (ctx, r) => programs.updateWorkoutExercise(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/workout-exercises/:id', 'any', 'Training', 'Remove an exercise from a workout. restore holds what to send back to put it where it was.', (ctx, r) => programs.removeWorkoutExercise(ctx, r.params.id)],
  ['GET', '/v1/open-spots', 'any', 'Schedule', 'Every upcoming group class, clinic and camp day sold by the day with a spot left in the next 7 days (?days= 1 to 14), soonest first, whoever leads it (?coach_id=, me for your own). Each with the coach, booked/capacity, how many families fit, the offers sent so far (trial offers too), and whether offers can go out now (offer_note says why not).', (ctx, r) => {
    if (r.query.coach_id === 'me' && !r.user) throw badRequest('coach_id=me needs a staff sign-in. Pass a staff id instead.');
    return spots.openSpots(ctx, { days: v.int(r.query.days ?? 7, 'days', { min: 1, max: 14 }), coachId: r.query.coach_id === 'me' ? r.user.id : r.query.coach_id || undefined });
  }],
  ['GET', '/v1/sessions/:id/trial-offer', 'any', 'Schedule', 'Owner only. Before sending a "try this session for $X" offer: the price range (0 up to the drop-in), how many families it would reach, open leads left out, and the starting message.', (ctx, r) => spots.trialOfferPreview(ctx, r.params.id)],
  ['POST', '/v1/sessions/:id/trial-offer', 'any', 'Schedule', 'Owner only. Send a trial offer: price_cents (whole cents, 0 for free, at most the drop-in, or $200 with no drop-in), max_families (1 to 30), message ({athlete} and {price} are filled in). Families who fit (and families who had a standard offer and haven\'t booked) get an email, and a text if they turned texts on, with a link that books at that price until the session starts.', async (ctx, r) => {
    const out = await spots.sendTrialOffer(ctx, r.params.id, r.body, { actor: r.user?.name ?? r.apiKey?.label ?? 'API' });
    security.audit(ctx, { ...(r.user ? { actor_type: 'staff', actor_id: r.user.id, actor_name: r.user.name, role: r.user.role } : { actor_type: 'api_key', actor_id: r.apiKey?.id, actor_name: r.apiKey?.label }), action: `trial offer at ${out.price_cents === 0 ? 'no charge' : `$${(out.price_cents / 100).toFixed(2)}`} sent to ${out.sent} ${out.sent === 1 ? 'family' : 'families'}`, target: r.params.id, status: 200, ip: r.ip });
    return out;
  }],
  ['GET', '/v1/coach-summary', 'any', 'Schedule', 'Owner only. Each active coach: today\'s sessions and the next one, the next 7 days (sessions, class fill rate, privates booked), attendance at what they led in the last 7 days, and upcoming days off. Plus sessions with no coach.', (ctx) => schedule.coachSummary(ctx)],
  ['POST', '/v1/sessions/:id/offer-spots', 'any', 'Schedule', 'Email (and text, if they turned texts on) families who fit this session that a spot is open. First to tap the link gets it. Up to 4 families per open spot.', (ctx, r) => spots.sendOffers(ctx, r.params.id, { actor: r.user?.name ?? 'API' })],
  ['GET', '/v1/shop', 'any', 'Training', 'Owners: every program and athlete course with its online price, whether it shows in the store, and what sold.', (ctx) => shop.shopAdmin(ctx)],
  ['PUT', '/v1/shop/programs/:id', 'any', 'Training', 'Owners: sell a program online: for_sale (true or false) and price_cents ($1 to $1,000).', (ctx, r) => shop.setForSale(ctx, 'program', r.params.id, r.body)],
  ['PUT', '/v1/shop/courses/:id', 'any', 'Training', 'Owners: sell an athlete course online: for_sale and price_cents. Athletes need to buy it (or be assigned it) to open its lessons.', (ctx, r) => shop.setForSale(ctx, 'course', r.params.id, r.body)],
  ['GET', '/v1/completions', 'any', 'Training', 'Completed workouts across current clients, newest first, with effort (rpe 1-10), sets logged, minutes, new bests and notes. ?since= and ?program_id= to filter.', (ctx, r) => list(programs.listCompletions(ctx, { since: r.query.since ? v.date(r.query.since, 'since') : undefined, programId: r.query.program_id || undefined }))],

  // Point of sale: in-person payments at the facility, in parks and at clients' homes
  ['GET', '/v1/locations', 'any', 'Point of sale', 'Places you train. card_ready shows whether card payments are set up there.', (ctx, r) => list(commerce.listLocations(ctx, { includeInactive: r.query.include_inactive === 'true' }))],
  ['POST', '/v1/locations', 'any', 'Point of sale', 'Add a location: name, kind (facility, mobile, park, client_home, other) and street address for card payments.', (ctx, r) => commerce.createLocation(ctx, r.body), 201],
  ['GET', '/v1/locations/:id/check-in-code', 'any', 'Schedule', 'The door poster for self check-in at this location: code, url (what the QR code opens) and poster_url (printable).', (ctx, r) => checkin.checkinCode(ctx, r.params.id)],
  ['POST', '/v1/locations/:id/check-in-code/reset', 'any', 'Schedule', 'Make a new door code; old posters stop working.', (ctx, r) => checkin.checkinCode(ctx, r.params.id, { reset: true })],
  ['GET', '/v1/kiosks', 'any', 'Schedule', 'Check-in tablets in use.', (ctx) => list(checkin.listKiosks(ctx))],
  ['POST', '/v1/kiosks', 'any', 'Schedule', 'Set up a check-in tablet: location_id, optional name. Returns the link to open on the tablet (shown once).', (ctx, r) => checkin.createKiosk(ctx, r.body, r.user?.name), 201],
  ['DELETE', '/v1/kiosks/:id', 'any', 'Schedule', 'Stop a tablet from checking athletes in.', (ctx, r) => checkin.revokeKiosk(ctx, r.params.id)],
  ['GET', '/kiosk-api/board', 'public', 'Schedule', 'Check-in tablet (x-kiosk-key header): sessions open for check-in at its location and who is booked.', (ctx, r) => checkin.kioskBoard(ctx, r.kioskKey)],
  ['GET', '/kiosk-api/screen', 'public', 'Schedule', 'Weight-room screen (x-kiosk-key header, the same key as a check-in tablet): sessions running now at its location, each with its workout and who can log it.', (ctx, r) => screen.screenBoard(ctx, r.kioskKey)],
  ['POST', '/kiosk-api/screen/athlete', 'public', 'Schedule', 'Weight-room screen: one athlete\'s own weights for the session workout. session_id, ref (from the board).', (ctx, r) => screen.screenAthlete(ctx, r.kioskKey, r.body)],
  ['POST', '/kiosk-api/screen/log', 'public', 'Schedule', 'Weight-room screen: log the session workout for one athlete and check them in. session_id, ref, optional exercise_ids.', (ctx, r) => screen.screenLog(ctx, r.kioskKey, r.body), 201],
  ['POST', '/kiosk-api/check-in', 'public', 'Schedule', 'Check-in tablet (x-kiosk-key header): check in booking_id.', (ctx, r) => checkin.kioskCheckIn(ctx, r.kioskKey, r.body)],
  ['GET', '/here-api/:code', 'public', 'Schedule', 'The door poster\'s page: business and location name.', (ctx, r) => checkin.publicPlace(ctx, r.params.code)],
  ['PATCH', '/v1/locations/:id', 'any', 'Point of sale', 'Update a location. Set active=false to archive it.', (ctx, r) => commerce.updateLocation(ctx, r.params.id, r.body)],
  ['GET', '/v1/readers', 'any', 'Point of sale', 'Front-desk card readers.', (ctx) => list(commerce.listReaders(ctx))],
  ['POST', '/v1/readers', 'any', 'Point of sale', 'Register a smart reader with the code on its screen: registration_code, label, location_id.', (ctx, r) => commerce.registerReader(ctx, r.body), 201],
  ['DELETE', '/v1/readers/:id', 'any', 'Point of sale', 'Remove a reader.', (ctx, r) => commerce.removeReader(ctx, r.params.id)],
  ['GET', '/v1/products', 'any', 'Point of sale', 'What you sell in person: sessions, packs, gear.', (ctx, r) => list(commerce.listProducts(ctx, { includeInactive: r.query.include_inactive === 'true' }))],
  ['POST', '/v1/products', 'any', 'Point of sale', 'Add a product: name, kind (session, pack, gear, other), price_cents, sessions (for packs).', (ctx, r) => commerce.createProduct(ctx, r.body), 201],
  ['PATCH', '/v1/products/:id', 'any', 'Point of sale', 'Update a product. Set active=false to stop selling it.', (ctx, r) => commerce.updateProduct(ctx, r.params.id, r.body)],
  ['GET', '/v1/campaigns', 'any', 'Leads', 'Announcement emails: drafts and sent, with how many got each and clicked a link.', (ctx) => list(campaigns.listCampaigns(ctx))],
  ['POST', '/v1/campaigns/preview', 'any', 'Leads', 'How many people an audience reaches: {audience: {group (everyone, members, lapsed, no_membership, leads), age_min, age_max, sport}}.', (ctx, r) => campaigns.previewAudience(ctx, r.body.audience)],
  ['POST', '/v1/campaigns', 'any', 'Leads', 'Draft an announcement email: subject, body ({first_name} is the parent\'s first name), audience.', (ctx, r) => campaigns.createCampaign(ctx, r.body, r.user?.name ?? 'API'), 201],
  ['GET', '/v1/campaigns/:id', 'any', 'Leads', 'One announcement email and its numbers.', (ctx, r) => campaigns.getCampaign(ctx, r.params.id)],
  ['PATCH', '/v1/campaigns/:id', 'any', 'Leads', 'Change a draft.', (ctx, r) => campaigns.updateCampaign(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/campaigns/:id', 'any', 'Leads', 'Delete a draft.', (ctx, r) => campaigns.deleteCampaign(ctx, r.params.id)],
  ['POST', '/v1/campaigns/:id/copy', 'any', 'Leads', 'Start a new draft from an email.', (ctx, r) => campaigns.copyCampaign(ctx, r.params.id, r.user?.name ?? 'API'), 201],
  ['POST', '/v1/campaigns/:id/test', 'session', 'Leads', 'Send the draft to yourself.', (ctx, r) => campaigns.sendTest(ctx, r.params.id, r.user)],
  ['POST', '/v1/campaigns/:id/send', 'any', 'Leads', 'Send now: confirm_count must equal the number of people it goes to.', (ctx, r) => campaigns.sendCampaign(ctx, r.params.id, r.body)],
  ['GET', '/v1/review-requests', 'any', 'Leads', 'Google review requests: the review link, whether they\'re on, the last 90 days (sent, clicked, stopped), the 10 most recent and a sample email.', (ctx) => reviews.reviewSummary(ctx)],
  ['GET', '/v1/inventory', 'any', 'Point of sale', 'Gear that counts its stock: what\'s on hand per size, and what\'s running low.', (ctx) => inventory.inventory(ctx)],
  ['POST', '/v1/products/:id/variants', 'any', 'Point of sale', 'Add a size or color to a product: name (like M or Youth L), sku.', (ctx, r) => inventory.addVariant(ctx, r.params.id, r.body), 201],
  ['PATCH', '/v1/products/:id/variants/:vid', 'any', 'Point of sale', 'Rename a size or stop selling it (active=false).', (ctx, r) => inventory.updateVariant(ctx, r.params.id, r.params.vid, r.body)],
  ['POST', '/v1/products/:id/stock', 'any', 'Point of sale', 'Change stock: reason received (quantity arrived), count (quantity on the shelf) or adjust (+/-), with variant_id for a size and an optional note.', (ctx, r) => inventory.recordStock(ctx, r.params.id, r.body, r.user?.name ?? 'API'), 201],
  ['GET', '/v1/products/:id/stock', 'any', 'Point of sale', 'Stock history for a product, newest first.', (ctx, r) => list(inventory.stockHistory(ctx, r.params.id))],
  // Coaches see only the sales they rang up themselves, never the business's takings.
  ['GET', '/v1/sales', 'any', 'Point of sale', 'In-person sales, newest first. Filter with ?days= (1 = today since midnight in the business\'s time zone, 7 = today and the 6 days before), ?since=, ?q= (client or item name), ?location_id=, ?client_id=, ?status=, ?limit= (up to 200). can_undo and undo_seconds_left say whether you can still undo a sale you took. Coaches see only their own sales.', (ctx, r) => list(commerce.listSales(ctx, { since: r.query.since ? v.date(r.query.since, 'since') : undefined, days: r.query.days, q: r.query.q, locationId: r.query.location_id, clientId: r.query.client_id, status: r.query.status, limit: r.query.limit, createdBy: r.user?.role === 'coach' ? r.user.id : undefined, userId: r.user?.id }))],
  ['GET', '/v1/sales/takings', 'any', 'Point of sale', 'The day\'s takings for closing out (owners and front desk): sales paid and refunds made between midnight and midnight in the business\'s time zone, discounts, net, cash to count (cash_cents), cards and a line per payment method. ?date=YYYY-MM-DD (default today), ?location_id= (default all locations).', (ctx, r) => commerce.takings(ctx, { date: r.query.date, locationId: r.query.location_id })],
  ['POST', '/v1/sales', 'any', 'Point of sale', 'Start a sale: location_id, method (tap_to_pay, reader, card_on_file, cash), items [{product_id, quantity}] and/or custom {description, amount_cents}, optional client_id, save_card, reader_id (a reader at that location), booking_id (an unpaid booking of that client: the sale must cover its price, and marks it paid once paid; the note is only a note). Optional discount {type: percent or amount, value (a percent from 1 to 100, or cents), reason}: owners give any discount that leaves something to pay, coaches and front desk up to the owner\'s limit (setting staff_discount_max_pct). Optional email_receipt (true sends a receipt to receipt_email or the family\'s billing email; false sends none; left out follows the automatic-receipt setting) and request_id (the same request_id again returns the first sale instead of charging twice). For tap_to_pay the response includes tap_to_pay.client_secret and tap_to_pay.location_ref for the iPhone app.', async (ctx, r) => {
    const sale = await commerce.createSale(ctx, r.body, r.user?.id ?? r.apiKey?.id, { counter: true, role: r.user?.role, userId: r.user?.id });
    if (sale.discount_cents && !sale.repeated) security.audit(ctx, { actor_type: r.user ? 'staff' : 'api_key', actor_id: r.user?.id ?? r.apiKey?.id, actor_name: r.user?.name ?? r.apiKey?.label, role: r.user?.role, action: 'discount', target: sale.id, status: 201, ip: r.ip });
    return sale;
  }, 201],
  ['GET', '/v1/sales/:id', 'any', 'Point of sale', 'A sale with its items, discount, refunds, receipt (receipt_url is the printable page) and whether you can still undo it.', (ctx, r) => { ownSale(ctx, r); return commerce.getSale(ctx, r.params.id, { withSecret: true, userId: r.user?.id }); }],
  ['POST', '/v1/sales/:id/sync', 'any', 'Point of sale', 'Check with the payment service and record the result. The iPhone app calls this after a tap.', (ctx, r) => { ownSale(ctx, r); return commerce.syncSale(ctx, r.params.id); }],
  ['POST', '/v1/sales/:id/cancel', 'any', 'Point of sale', 'Cancel a payment that is still waiting for a card.', (ctx, r) => { ownSale(ctx, r); return commerce.cancelSale(ctx, r.params.id); }],
  ['POST', '/v1/sales/:id/refund', 'any', 'Point of sale', 'Refund a sale. Optional amount_cents for a partial refund and a reason. A full refund removes unused sessions from the pack.', (ctx, r) => commerce.refundSale(ctx, r.params.id, r.body, { actor: r.user?.id ?? r.apiKey?.id })],
  ['POST', '/v1/sales/:id/undo', 'session', 'Point of sale', 'Undo a sale you just took by mistake: a full refund (back to the card, or cash to hand back), sessions and stock back. Only the person who took it, within 10 minutes of it being paid, and only while nothing has been refunded.', (ctx, r) => { ownSale(ctx, r); return commerce.undoSale(ctx, r.params.id, r.user); }],
  ['POST', '/v1/sales/:id/receipt', 'any', 'Point of sale', 'Email (or re-send) the receipt: optional email, otherwise the family\'s billing email or the address typed at the counter. Sent even when automatic receipts are off. Up to 5 times an hour per sale.', (ctx, r) => { ownSale(ctx, r); security.rateLimit(`receipt-send:${r.params.id}`, 5, 60 * 60000); return commerce.emailReceipt(ctx, r.params.id, r.body); }],
  ['POST', '/v1/sales/:id/simulate', 'any', 'Point of sale', 'Test mode only: act as the client tapping their card. outcome is approved or declined.', (ctx, r) => { ownSale(ctx, r); return commerce.simulateTap(ctx, r.params.id, r.body.outcome); }],
  ['POST', '/v1/terminal/connection-token', 'any', 'Point of sale', 'Connection token for the Stripe Terminal SDK in the iPhone app. Optional location_id.', (ctx, r) => commerce.connectionToken(ctx, r.body.location_id)],
  ['GET', '/v1/reports/revenue', 'any', 'Point of sale', 'Revenue by location plus membership payments since ?since= (default: start of this month).', (ctx, r) => {
    const zone = families.getSetting(ctx, 'timezone'), start = startOfLocalDay(zonedToUtc(`${localDate(ctx.now(), zone).slice(0, 8)}01`, '12:00', zone), zone);
    return commerce.revenueByLocation(ctx, r.query.since ? v.date(r.query.since, 'since') : start);
  }],
  ['GET', '/v1/clients/:id/card', 'any', 'Clients', 'Whether the client has a saved card, and its brand and last 4 digits.', (ctx, r) => commerce.cardSummary(ctx, r.params.id)],
  ['POST', '/v1/clients/:id/card/setup-link', 'any', 'Clients', 'A secure Stripe link the client opens to add or replace their card.', (ctx, r) => commerce.cardSetupLink(ctx, r.params.id, r.baseUrl)],
  ['POST', '/v1/clients/:id/card/test', 'any', 'Clients', 'Test mode only: attach a test Visa ending 4242.', (ctx, r) => commerce.addTestCard(ctx, r.params.id)],
  ['DELETE', '/v1/clients/:id/card', 'any', 'Clients', 'Remove the saved card.', (ctx, r) => commerce.removeCard(ctx, r.params.id)],
  ['GET', '/v1/clients/:id/credits', 'any', 'Clients', 'Session credit balance.', (ctx, r) => ({ balance: commerce.creditBalance(ctx, r.params.id) })],
  ['POST', '/v1/clients/:id/credits', 'any', 'Clients', 'Adjust session credits by delta (positive or negative) with an optional note.', (ctx, r) => commerce.adjustCredits(ctx, r.params.id, r.body)],
  ['POST', '/v1/clients/:id/check-ins', 'any', 'Clients', 'Check a client in at location_id. Members train on their membership; others use one session credit.', (ctx, r) => commerce.checkIn(ctx, r.params.id, r.body), 201],
  ['GET', '/v1/check-ins', 'any', 'Clients', 'Recent check-ins. ?client_id= to filter.', (ctx, r) => list(commerce.listCheckIns(ctx, { clientId: r.query.client_id }))],

  // Families and parents
  ['GET', '/v1/families', 'any', 'Families', 'Every family with parents, athletes, card and waiver status.', (ctx) => list(families.listFamilies(ctx))],
  ['POST', '/v1/families', 'any', 'Families', 'Create a family with its first parent: parent {name, email, phone, relationship}, optional name.', (ctx, r) => families.getFamily(ctx, families.createFamilyWithGuardian(ctx, r.body.parent, r.body.name)), 201],
  ['GET', '/v1/families/:id', 'any', 'Families', 'A family with parents, athletes, card and waiver.', (ctx, r) => { const f = families.getFamily(ctx, r.params.id); return { ...f, athletes: f.athlete_ids.map((id) => clients.getClient(ctx, id, { role: r.user?.role })) }; }],
  ['PATCH', '/v1/families/:id', 'any', 'Families', 'Rename a family.', (ctx, r) => families.updateFamily(ctx, r.params.id, r.body)],
  ['POST', '/v1/families/:id/guardians', 'any', 'Families', 'Add a parent or guardian who can sign in to the portal.', (ctx, r) => families.addGuardian(ctx, r.params.id, r.body), 201],
  ['PATCH', '/v1/families/:id/guardians/:gid', 'any', 'Families', 'Fix a parent\'s name, email, phone or relationship. An athlete in the family with the same email keeps it in step. A new phone number turns texts off until the parent turns them on again.', (ctx, r) => families.updateGuardian(ctx, r.params.id, r.params.gid, r.body)],
  ['POST', '/v1/families/:id/guardians/:gid/welcome', 'any', 'Families', 'Email the parent how to sign in to the parent portal again.', async (ctx, r) => { families.getFamily(ctx, r.params.id); if (!ctx.db.get('SELECT 1 FROM guardians WHERE id = ? AND family_id = ?', r.params.gid, r.params.id)) throw notFound('Parent'); return { sent_to: await portalInvite(ctx, r.params.gid) }; }],
  ['DELETE', '/v1/families/:id/guardians/:gid', 'any', 'Families', 'Remove a parent (a family keeps at least one). Their portal sign-in ends at once.', (ctx, r) => families.removeGuardian(ctx, r.params.id, r.params.gid)],
  ['POST', '/v1/families/:id/waiver', 'any', 'Families', 'Record a waiver signed on paper at the desk: signed_by (the parent\'s name). Refused when the current waiver is already signed.', (ctx, r) => families.recordPaperWaiver(ctx, r.params.id, r.body, r.user ?? { name: r.apiKey?.label ?? 'API' })],
  ['POST', '/v1/families/:id/athletes', 'any', 'Families', 'Add an athlete to a family: name, birth_date, sport and profile fields, optional plan_id and program_id (not front desk). With check_duplicates: true, refused with 409 possible_duplicate when a client has the same name and birthday.', (ctx, r) => clients.createClient(ctx, { ...r.body, family_id: r.params.id }, { staff: { role: r.user?.role ?? 'owner' } }), 201],
  ['GET', '/v1/client-import/template', 'any', 'Clients', 'Spreadsheet template for importing clients (Excel, or ?format=csv).', (ctx, r) => ({ __file: clientImport.importTemplate(r.query.format) })],
  ['POST', '/v1/client-import/preview', 'any', 'Clients', 'Check a client spreadsheet (csv, or xlsx_base64). Returns every problem by row, or exactly the families and Athlete IDs that will be created. Nothing is saved.', (ctx, r) => clientImport.previewImport(ctx, r.body)],
  ['POST', '/v1/client-import/commit', 'any', 'Clients', 'Import a checked spreadsheet: preview_id, send_welcome (email new families and adults their sign-in details). All or nothing.', (ctx, r) => clientImport.commitImport(ctx, r.body), 201],
  ['GET', '/v1/families/:id/export', 'session', 'Families', 'Everything held about a family, as a file (for a parent\'s data request).', (ctx, r) => ({ __file: { filename: `family-${r.params.id}.json`, type: 'application/json', body: Buffer.from(JSON.stringify(legal.exportFamily(ctx, r.params.id), null, 2)) } })],
  ['DELETE', '/v1/families/:id', 'session', 'Families', 'Delete a family\'s personal information (owner only): confirm with the family name; optional request_id. Payment records stay, with no names.', (ctx, r) => legal.deleteFamilyData(ctx, r.params.id, { confirm: r.body.confirm, requestId: r.body.request_id, actor: r.user })],
  ['GET', '/v1/data-requests', 'session', 'Families', 'Parents\' requests to delete their data (?status=open).', (ctx, r) => list(legal.listDataRequests(ctx, { status: r.query.status }))],
  ['POST', '/v1/data-requests/:id/decline', 'session', 'Families', 'Close a request without deleting: reason.', (ctx, r) => legal.declineRequest(ctx, r.params.id, r.body)],
  ['GET', '/v1/families/:id/agreements', 'any', 'Families', 'Terms and privacy acceptances for a family.', (ctx, r) => list(legal.familyConsents(ctx, r.params.id))],
  ['GET', '/v1/settings', 'any', 'Families', 'Business settings: time zone, late-cancel window, waiver text.', (ctx) => families.getSettings(ctx)],
  ['PATCH', '/v1/settings', 'session', 'Families', 'Update settings. Changing the waiver text asks every family to sign again.', (ctx, r) => families.updateSettings(ctx, r.body)],
  ['GET', '/v1/outbox', 'session', 'Families', 'Emails the platform sent or logged, newest first, and how email is set up (mode: test, restricted or live). Filter with ?status= (sent, failed, held, not_sent) and ?q= (address, subject or text); ?limit, ?offset. counts has the number in each status.', (ctx, r) => ({ ...list(listOutbox(ctx, r.query)), counts: outboxCounts(ctx), mode: mailMode(ctx), from: ctx.mail?.from || null, only_to: ctx.mail?.onlyTo || null })],
  ['POST', '/v1/outbox/:id/resend', 'session', 'Families', 'Send an email again as a new message: to the same address, or to (another address) for emails that hold no sign-in code, password or private link.', (ctx, r) => resendEmail(ctx, r.params.id, r.body)],
  ['GET', '/v1/texts', 'session', 'Families', 'Text messages sent to parents and their replies, newest first, and how texting is set up (mode: test, restricted or live). Filter with ?status= (sent, failed, held, logged, received) and ?q= (number or text).', (ctx, r) => ({ ...list(sms.listTexts(ctx, r.query)), counts: sms.textCounts(ctx), mode: sms.smsMode(ctx), only_to: ctx.sms?.onlyTo || null, kinds: sms.TEXT_KINDS })],
  ['POST', '/v1/texts/test', 'session', 'Families', 'Send a test text to a phone number (to) and wait for the text service to answer.', async (ctx, r) => {
    if (sms.smsMode(ctx) === 'test') throw badRequest('No text service is connected. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM on the server.');
    const out = await sms.sendText(ctx, { to: v.str(r.body?.to, 'to', { max: 40 }), kind: 'test', body: `Test text from ${families.getSetting(ctx, 'business_name')}. Texting is working.` });
    if (out.status !== 'sent') throw badRequest(out.error || 'The text service refused the message.');
    return out;
  }],
  ['POST', '/v1/outbox/test', 'session', 'Families', 'Send a test email (to) and wait for the email service to answer.', async (ctx, r) => {
    const to = v.email(r.body?.to ?? r.user.email);
    if (mailMode(ctx) === 'test') throw badRequest('No email service is connected. Set RESEND_API_KEY on the server.');
    const out = await sendEmail(ctx, { to, subject: 'Test email from Diamond Protocol', text: `This is a test from your Diamond Protocol server${ctx.publicUrl ? ` at ${ctx.publicUrl}` : ''}.\n\nIf you're reading this, email is working: sign-in codes, invoices and receipts will arrive like this one.` });
    if (out.status === 'held') throw badRequest(`This server only delivers to ${ctx.mail.onlyTo}.`);
    if (out.status !== 'sent') throw badRequest(out.error || 'The email service refused the message.');
    return { ok: true };
  }],

  // Leads
  ['GET', '/v1/leads', 'any', 'Leads', 'Families who asked about training, newest first, with counts by stage. Filter with ?status= (new, contacted, signed_up, evaluation, member, lost).', (ctx, r) => leads.listLeads(ctx, { status: r.query.status ? v.oneOf(r.query.status, 'status', leads.STAGES) : undefined })],
  ['POST', '/v1/leads', 'any', 'Leads', 'Add a lead: parent_name, email and/or phone, athlete_name, athlete_age, sport, message, source (manual, phone, walk_in, event, referral), texts_ok, follow_up=false to skip the automatic emails.', (ctx, r) => leads.addLead(ctx, r.body, r.user ?? r.apiKey), 201],
  ['GET', '/v1/leads/:id', 'any', 'Leads', 'A lead.', (ctx, r) => leads.getLead(ctx, r.params.id)],
  ['PATCH', '/v1/leads/:id', 'any', 'Leads', 'Update a lead: status, notes, lost_reason, contacted=true (you reached out), follow_up=false (stop automatic follow-up).', (ctx, r) => leads.updateLead(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/leads/:id', 'session', 'Leads', 'Delete a lead and its details (owner only).', (ctx, r) => leads.deleteLead(ctx, r.params.id)],

  // Schedule: classes, camps, clinics, team sessions, privates and evaluations
  ['GET', '/v1/coaches', 'any', 'Schedule', 'Staff who can lead sessions (active owners and coaches), for coach pickers.', (ctx) => list(schedule.listCoaches(ctx))],
  ['GET', '/v1/schedule', 'any', 'Schedule', 'Sessions between ?from= and ?to= (default: next 14 days). Filter with ?kind=, ?location_id= and ?coach_id= (me for your own).', (ctx, r) => {
    const from = r.query.from ? v.date(r.query.from, 'from') : new Date(Date.now() - 3600000).toISOString();
    const to = r.query.to ? v.date(r.query.to, 'to') : new Date(Date.now() + 14 * 86400000).toISOString();
    if (r.query.coach_id === 'me' && !r.user) throw badRequest('coach_id=me needs a staff sign-in. Pass a staff id instead.');
    const coachId = r.query.coach_id === 'me' ? r.user.id : r.query.coach_id || undefined;
    return list(schedule.listSessions(ctx, { from, to, kind: r.query.kind, locationId: r.query.location_id, coachId, includeCanceled: r.query.include_canceled === 'true' }));
  }],
  ['GET', '/v1/agenda', 'any', 'Schedule', 'One day (?date=YYYY-MM-DD, default today) with every roster.', (ctx, r) => schedule.agenda(ctx, r.query.date)],
  ['GET', '/v1/class-series', 'any', 'Schedule', 'Recurring classes, camps, clinics and team series.', (ctx, r) => list(schedule.listSeries(ctx, { kind: r.query.kind, includeInactive: r.query.include_inactive === 'true' }))],
  ['POST', '/v1/class-series', 'any', 'Schedule', 'Create a class or camp: name, kind (group, camp, clinic, team, evaluation), location_id, weekdays [0-6], start_time, duration_min, capacity, age_min, age_max, drop_in_cents, registration_cents, start_date, end_date, coach_id (who leads it).', (ctx, r) => schedule.createSeries(ctx, r.body), 201],
  ['GET', '/v1/class-series/:id', 'any', 'Schedule', 'A class or camp with who is enrolled.', (ctx, r) => schedule.getSeries(ctx, r.params.id)],
  ['PATCH', '/v1/class-series/:id', 'any', 'Schedule', 'Edit a class, camp or clinic (owner and coach; prices owner only): name, description, location_id, weekdays, start_time, duration_min, capacity, age_min, age_max, drop_in_cents, registration_cents, start_date, end_date, coach_id. Every upcoming session follows what changed, unless that one session was changed on its own (a sub, a moved time, more spots). A new time or place emails each booked family once, listing their sessions that moved; days the class no longer runs are canceled (credits back, paid drop-ins refunded, one email per family); new days are added. Sessions never move into the past, spots never go below what a session has booked, and a time another session of the class has is refused. changes says what happened. active=false archives the class and cancels the rest.', (ctx, r) => { noPricesFromCoach(r); return schedule.updateSeries(ctx, r.params.id, r.body); }],
  ['POST', '/v1/class-series/:id/enroll', 'any', 'Schedule', 'Give a member a standing spot: client_id.', (ctx, r) => schedule.enroll(ctx, r.params.id, v.str(r.body.client_id, 'client_id'), { isCoach: true })],
  ['DELETE', '/v1/class-series/:id/enroll/:client', 'any', 'Schedule', 'End a standing spot and release future bookings.', (ctx, r) => schedule.endEnrollment(ctx, r.params.id, r.params.client)],
  ['POST', '/v1/class-series/:id/register', 'any', 'Schedule', 'Register for a camp or clinic: client_id, pay (card_on_file, or omit to collect later).', (ctx, r) => schedule.registerCamp(ctx, r.params.id, v.str(r.body.client_id, 'client_id'), { pay: r.body.pay, actor: r.user?.id, isCoach: true })],
  ['POST', '/v1/sessions', 'any', 'Schedule', 'One-off session (a makeup, a one-time clinic): name, kind, location_id, date, start_time, duration_min, capacity, coach_id, staff_note (for staff only).', (ctx, r) => schedule.createSession(ctx, r.body), 201],
  ['GET', '/v1/sessions/:id', 'any', 'Schedule', 'A session with its roster and waitlist, and the workout on the weight-room screen.', (ctx, r) => { const s = schedule.getSession(ctx, r.params.id); return { ...s, workout: s.workout_id ? screen.workoutView(ctx, s.workout_id) : null }; }],
  ['PATCH', '/v1/sessions/:id', 'any', 'Schedule', 'Change this one session (owner and coach): coach_id (a sub; null for nobody), name, date, start_time, duration_min, capacity (never below who is booked; more spots move the waitlist up), location_id, staff_note. A new time or place emails booked families unless notify=false. Only real changes count (400 "Nothing to change" otherwise); changed, families_emailed and promoted say what happened.', (ctx, r) => schedule.updateSession(ctx, r.params.id, r.body)],
  ['POST', '/v1/sessions/:id/message', 'any', 'Schedule', 'Email the families of everyone booked: message (up to 1,000 characters), include_waitlist. A team session reaches every family on the team roster. One email per family, signed with your name; the same message twice within 10 minutes is refused.', (ctx, r) => schedule.messageSession(ctx, r.params.id, r.body, r.user ?? { name: r.apiKey?.label })],
  ['PUT', '/v1/sessions/:id/workout', 'any', 'Schedule', 'Pick the workout the weight-room screen shows during this session: workout_id (null clears it).', (ctx, r) => screen.setSessionWorkout(ctx, r.params.id, r.body)],
  ['POST', '/v1/sessions/:id/cancel', 'any', 'Schedule', 'Cancel a session: credits back, paid drop-ins refunded, families emailed; for a team session the school or club contact too. Optional reason.', (ctx, r) => schedule.cancelSession(ctx, r.params.id, { reason: v.str(r.body.reason, 'reason', { max: 200, optional: true }), notifyTeam: true })],
  ['POST', '/v1/sessions/:id/bookings', 'any', 'Schedule', 'Add an athlete: client_id, optional pay=card_on_file, override_age. Coaches can book now and collect later. Staff can book someone who is already booked at an overlapping time: clash names that other session.', async (ctx, r) => {
    const b = await schedule.book(ctx, { sessionId: r.params.id, clientId: v.str(r.body.client_id, 'client_id'), pay: r.body.pay, actor: r.user?.id, isCoach: true, overrideAge: !!r.body.override_age });
    return { ...b, clash: schedule.clashFor(ctx, b.client_id, b.session_id) };
  }, 201],
  ['POST', '/v1/bookings/:id/promote', 'any', 'Schedule', 'Move someone off the waitlist now, even over the session\'s spots (over_spots says so). Covered by a membership or credit when they have one; otherwise payment is due at the session. The family is emailed.', (ctx, r) => schedule.promoteBooking(ctx, r.params.id)],
  ['POST', '/v1/bookings/:id/cancel', 'any', 'Schedule', 'Cancel a booking. waive=true skips the late-cancel rule.', (ctx, r) => schedule.cancelBooking(ctx, r.params.id, { isCoach: true, waive: !!r.body.waive })],
  ['POST', '/v1/bookings/:id/attendance', 'any', 'Schedule', 'Roster check-in: status attended, no_show or booked.', (ctx, r) => schedule.setAttendance(ctx, r.params.id, r.body.status)],
  ['POST', '/v1/bookings/:id/pay', 'any', 'Schedule', 'Collect for an unpaid booking: method (card_on_file, cash, tap_to_pay, reader), reader_id.', (ctx, r) => schedule.payBooking(ctx, r.params.id, r.body, r.user?.id)],
  ['GET', '/v1/clients/:id/bookings', 'any', 'Schedule', 'A client\'s upcoming bookings (?past=true for history).', (ctx, r) => list(schedule.clientBookings(ctx, r.params.id, { upcoming: r.query.past !== 'true' }))],
  ['GET', '/v1/availability', 'any', 'Schedule', 'Your hours for privates and evaluations.', (ctx) => list(schedule.listAvailability(ctx))],
  ['POST', '/v1/availability', 'any', 'Schedule', 'Add hours: kind (private or evaluation), location_id, weekday (or weekdays [1,2,3] for several days at once; added lists each), start_time, end_time, slot_minutes, price_cents, coach_id (whose hours; anything that coach leads anywhere then blocks them).', (ctx, r) => schedule.addAvailability(ctx, r.body), 201],
  ['PATCH', '/v1/availability/:id', 'any', 'Schedule', 'Hand hours to another coach: coach_id (null: nobody, so anything at that place blocks them).', (ctx, r) => schedule.updateAvailability(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/availability/:id', 'any', 'Schedule', 'Remove hours.', (ctx, r) => schedule.removeAvailability(ctx, r.params.id)],
  ['GET', '/v1/time-off', 'any', 'Schedule', 'Coach and facility days off, from today on (or ?from= and ?to=, YYYY-MM-DD).', (ctx, r) => list(schedule.listTimeOff(ctx, { from: r.query.from, to: r.query.to }))],
  ['POST', '/v1/time-off', 'any', 'Schedule', 'Add days off: start_date, end_date (YYYY-MM-DD, inclusive), note, user_id (a coach; empty for the whole facility, owners only). Coaches add their own. Private and evaluation times those days aren\'t offered; sessions_to_cover lists what that coach still leads then.', (ctx, r) => schedule.addTimeOff(ctx, r.body, r.user), 201],
  ['DELETE', '/v1/time-off/:id', 'any', 'Schedule', 'Remove days off (coaches their own, owners any).', (ctx, r) => schedule.removeTimeOff(ctx, r.params.id, r.user)],
  ['GET', '/v1/slots', 'any', 'Schedule', 'Open private or evaluation times (?kind=, ?days=), each with the coach whose hours they are.', (ctx, r) => list(schedule.openSlots(ctx, { kind: r.query.kind === 'evaluation' ? 'evaluation' : 'private', days: v.int(r.query.days ?? 14, 'days', { min: 1, max: 60 }) }))],
  ['POST', '/v1/slots/book', 'any', 'Schedule', 'Book an open slot: kind, starts_at, availability_id, client_id, optional pay.', (ctx, r) => schedule.bookSlot(ctx, { kind: r.body.kind, startsAt: v.str(r.body.starts_at, 'starts_at'), availabilityId: v.str(r.body.availability_id, 'availability_id'), clientId: v.str(r.body.client_id, 'client_id'), pay: r.body.pay, actor: r.user?.id, isCoach: true }), 201],

  // Team contracts: schools and clubs billed a monthly fee
  ['GET', '/v1/organizations', 'any', 'Teams', 'Schools and clubs.', (ctx) => list(teams.listOrgs(ctx))],
  ['POST', '/v1/organizations', 'any', 'Teams', 'Add a school or club: name, kind (school, club, other), contact_name, contact_email (receives invoices), contact_phone, billing_address.', (ctx, r) => teams.createOrg(ctx, r.body), 201],
  ['PATCH', '/v1/organizations/:id', 'any', 'Teams', 'Update a school or club, including the billing contact.', (ctx, r) => teams.updateOrg(ctx, r.params.id, r.body)],
  ['GET', '/v1/team-contracts', 'any', 'Teams', 'Every team contract with its balance, overdue amount, team attendance and next invoice date.', (ctx) => list(teams.listContracts(ctx))],
  ['POST', '/v1/team-contracts', 'any', 'Teams', 'New contract: org_id (or organization {...}), name, monthly_cents, start_date, end_date, terms_days (default 30), po_number, notes (staff only). Months that have started are invoiced right away; for a start date in the past, past=all (default), current (only the month running now) or none. A second active contract with the same team name at the same school is refused.', (ctx, r) => teams.createContract(ctx, r.body, r.baseUrl), 201],
  ['GET', '/v1/team-contracts/:id', 'any', 'Teams', 'A contract with its roster (attendance from each athlete\'s join date, last time here), recent sessions, team schedules and invoices.', (ctx, r) => teams.getContract(ctx, r.params.id, r.baseUrl)],
  ['PATCH', '/v1/team-contracts/:id', 'any', 'Teams', 'Change the team name, fee (applies from the next invoice), end date, terms, PO or notes. Team sessions follow the end date both ways. status=ended stops invoicing and takes future team sessions off. Restarting an ended contract (status=active, or clearing or moving the end date to today or later) bills from the next billing day, not the months it was ended.', (ctx, r) => teams.updateContract(ctx, r.params.id, r.body, teamSchedule(ctx), r.baseUrl)],
  ['POST', '/v1/team-contracts/:id/roster', 'any', 'Teams', 'Add athletes. Every roster athlete has a client profile: client_id or athlete_id puts a client you already have on the roster; otherwise name, position, grad_year creates one (no family, no membership). Or names (a pasted list, one per line: "Name, position, grad year", optionally an Athlete ID). A list is all or nothing: problem lines come back in details and nothing is saved. links {line: client_id} puts a client you already have on the team instead of a new athlete; names are never linked on their own.', (ctx, r) => { const out = teams.addRoster(ctx, r.params.id, r.body); return { ...list(out.roster), added: out.added, linked: out.linked, skipped: out.skipped }; }, 201],
  ['POST', '/v1/team-contracts/:id/roster/check', 'any', 'Teams', 'Check a pasted list without saving: each line is new (a new client), link (its Athlete ID belongs to a client you have), skip (already on the roster or listed twice), match (clients you already have with that name) or error.', (ctx, r) => teams.checkRoster(ctx, r.params.id, r.body)],
  ['POST', '/v1/team-contracts/:id/roster/existing', 'any', 'Teams', 'Put a client you already have on the roster: client_id. If they are on another active team, send move=true (take them off it) or keep=true (stay on both); otherwise 409 confirm_required.', (ctx, r) => { const out = teams.addExistingClient(ctx, r.params.id, r.body); return { ...list(out.roster), moved_from: out.moved_from, also_on: out.also_on }; }, 201],
  ['GET', '/v1/team-contracts/:id/client-search', 'any', 'Teams', 'Find clients to add to this roster by name or Athlete ID: ?q= (at least 2 characters). Shows the teams each is on now.', (ctx, r) => list(teams.searchClientsForTeam(ctx, r.params.id, r.query.q))],
  ['DELETE', '/v1/team-contracts/:id/roster/:rid', 'any', 'Teams', 'Remove an athlete from the roster (undo with restore). Their client profile, results and attendance are kept.', (ctx, r) => list(teams.removeRoster(ctx, r.params.id, r.params.rid))],
  ['POST', '/v1/team-contracts/:id/roster/:rid/restore', 'any', 'Teams', 'Undo a removal: the athlete comes back with their join date and attendance.', (ctx, r) => list(teams.restoreRoster(ctx, r.params.id, r.params.rid))],
  ['POST', '/v1/team-contracts/:id/sessions', 'any', 'Teams', 'Put this team on the schedule: location_id, weekdays, start_time, duration_min, start_date, coach_id (who leads it). Sessions run until the contract ends.', async (ctx, r) => {
    const c = teams.getContract(ctx, r.params.id);
    if (c.status !== 'active') throw badRequest('This contract has ended. Restart it before adding team sessions.');
    if (c.end_date && r.body.start_date && r.body.start_date > c.end_date) throw badRequest(`The first day is after the contract ends (${c.end_date}).`);
    return schedule.createSeries(ctx, { ...r.body, kind: 'team', contract_id: c.id, name: r.body.name ?? `${c.org.name} ${c.name}`, capacity: Math.max(c.roster.length, 1, v.int(r.body.capacity ?? 1, 'capacity', { min: 1, max: 500 })), end_date: c.end_date ?? undefined });
  }, 201],
  ['DELETE', '/v1/team-contracts/:id/sessions/:sid', 'any', 'Teams', 'Take a team schedule off: its future sessions are canceled. Past attendance is kept.', async (ctx, r) => {
    const c = teams.getContract(ctx, r.params.id);
    const s = c.series.find((x) => x.id === r.params.sid);
    if (!s) throw notFound('Team schedule');
    const removed = ctx.db.get(`SELECT COUNT(*) AS n FROM class_sessions WHERE series_id = ? AND status = 'scheduled' AND starts_at > ?`, s.id, ctx.now()).n;
    await schedule.updateSeries(ctx, s.id, { active: false });
    return { sessions_removed: removed, contract: teams.getContract(ctx, c.id, r.baseUrl) };
  }],
  ['POST', '/v1/team-contracts/:id/invoices', 'any', 'Teams', 'One-off invoice: description and amount_cents (or lines [...]). Emailed unless send=false (or there is no billing email yet).', (ctx, r) => teams.createOneOffInvoice(ctx, r.params.id, r.body, r.baseUrl), 201],
  ['POST', '/v1/team-contracts/:id/payments', 'any', 'Teams', 'One payment (a single check) for several open invoices on this contract: invoice_ids [...], method (check, ach, card, cash, other), reference (check number), paid_on, total_cents (optional: refused if the invoices no longer add up to it). All or nothing.', (ctx, r) => teams.recordContractPayment(ctx, r.params.id, r.body, r.baseUrl)],
  ['POST', '/v1/team-contracts/:id/statement', 'any', 'Teams', 'Email the billing contact a statement: every open invoice with its link, and the total.', (ctx, r) => teams.emailStatement(ctx, r.params.id, r.baseUrl)],
  ['POST', '/v1/sessions/:id/team-attendance', 'any', 'Teams', 'Team session check-in: roster_id (the roster line) or client_id (the athlete\'s profile, where the check-in is kept), present (true/false).', (ctx, r) => teams.setTeamAttendance(ctx, schedule.getSession(ctx, r.params.id), r.body.client_id ? { client_id: v.str(r.body.client_id, 'client_id', { max: 64 }) } : { roster_id: v.str(r.body.roster_id, 'roster_id', { max: 64 }) }, r.body.present !== false)],
  ['GET', '/v1/team-invoices', 'any', 'Teams', 'Team invoices. ?status=open, overdue, unpaid, paid or void.', (ctx, r) => list(teams.listInvoices(ctx, { status: r.query.status }, r.baseUrl))],
  ['GET', '/v1/team-invoices/:id', 'any', 'Teams', 'One invoice with its public link.', (ctx, r) => teams.getInvoice(ctx, r.params.id, r.baseUrl)],
  ['POST', '/v1/team-invoices/:id/send', 'any', 'Teams', 'Email (or re-email) the invoice to the billing contact.', (ctx, r) => teams.sendInvoice(ctx, r.params.id, r.baseUrl)],
  ['POST', '/v1/team-invoices/:id/payments', 'any', 'Teams', 'Record a payment: method (check, ach, card, cash, other), reference (check number), paid_on (a real date, not in the future). Online payments are recorded automatically.', (ctx, r) => teams.recordPayment(ctx, r.params.id, r.body, r.baseUrl)],
  ['POST', '/v1/team-invoices/:id/void', 'any', 'Teams', 'Void an unpaid invoice.', (ctx, r) => teams.voidInvoice(ctx, r.params.id, r.baseUrl)],
  ['GET', '/v1/team-billing/summary', 'any', 'Teams', 'Monthly contract revenue, open and overdue invoices, collected in the last 30 days and athletes on active rosters.', (ctx) => teams.teamSummary(ctx)],
  ['POST', '/v1/team-billing/remind-overdue', 'any', 'Teams', 'Email every overdue invoice\'s billing contact a reminder now (the weekly reminder then waits a week).', (ctx, r) => teams.remindOverdueNow(ctx, r.baseUrl)],
  ['POST', '/v1/team-billing/run', 'session', 'Teams', 'Run team invoicing and reminders now (also runs every hour).', (ctx, r) => teams.runTeamBilling(ctx, { baseUrl: r.baseUrl })],
  ['GET', '/invoice-api/:token', 'public', 'Teams', 'Public invoice for the school or club (the link in the email).', (ctx, r) => teams.publicInvoice(ctx, r.params.token)],
  ['POST', '/invoice-api/:token/checkout', 'public', 'Teams', 'Start online payment by card or bank account.', (ctx, r) => teams.checkoutForInvoice(ctx, r.params.token, r.baseUrl)],
  ['POST', '/invoice-api/:token/simulate', 'public', 'Teams', 'Test mode only: mark the invoice paid online.', (ctx, r) => teams.simulateInvoicePaid(ctx, r.params.token)],

  // Performance testing
  ['GET', '/v1/tests', 'any', 'Performance', 'The test library: every test with its metrics, units, whether lower or higher is better, protocol ("how to run it") and possible range. ?include_inactive=true shows hidden tests; ?usage=true adds hidden tests, how much each is used (results, athletes, testing days, last used) and the presets it is in.', (ctx, r) => ({ data: r.query.usage === 'true' ? library.libraryList(ctx) : perf.listTests(ctx, { includeInactive: r.query.include_inactive === 'true' }), categories: perf.CATEGORIES.map(([key, name]) => ({ key, name })) })],
  ['POST', '/v1/tests', 'any', 'Performance', 'Add your own test: name, category, unit and better (lower or higher), or metrics [{key, name, unit, better, min_value, max_value}]; sides (none or lr); attempts; timed (seconds only); description; protocol.', (ctx, r) => perf.createTest(ctx, r.body), 201],
  ['GET', '/v1/tests/:key', 'any', 'Performance', 'One test by key (e.g. dash_40yd, cmj, imtp).', (ctx, r) => perf.getTest(ctx, r.params.key)],
  ['GET', '/v1/tests/:key/details', 'any', 'Performance', 'One test in full: protocol, usage, presets it is in, whether it can be deleted, and the record board (each athlete\'s best, top 10). Filter the board with ?metric=, ?side=L|R, ?sex=M|F and ?age=u12|13-14|15-16|17-18|adult (age when the result was set).', (ctx, r) => library.testDetails(ctx, r.params.key, r.query)],
  ['PATCH', '/v1/tests/:key', 'any', 'Performance', 'Edit a test: name, category, attempts, timed, description, protocol (empty = the built-in text), active (false hides it), metrics [{key, min_value, max_value}] for the possible range. Your own tests can also change metric name, unit, better and sides until they have results. Returns the test with changes (the fields that really changed).', (ctx, r) => perf.updateTest(ctx, r.params.key, r.body)],
  ['DELETE', '/v1/tests/:key', 'any', 'Performance', 'Delete one of your own tests that was never used (no results, testing days, targets or program weights). Presets lose it. Built-in tests can only be hidden.', (ctx, r) => library.deleteTest(ctx, r.params.key)],
  ['GET', '/v1/test-presets', 'any', 'Performance', 'Presets: named sets of tests to start a testing day from, in order.', (ctx) => list(library.listPresets(ctx))],
  ['POST', '/v1/test-presets', 'any', 'Performance', 'Add a preset: name, tests [keys in running order] (1 to 40).', (ctx, r) => library.createPreset(ctx, r.body), 201],
  ['GET', '/v1/test-presets/:id', 'any', 'Performance', 'One preset.', (ctx, r) => library.getPreset(ctx, r.params.id)],
  ['PATCH', '/v1/test-presets/:id', 'any', 'Performance', 'Rename a preset or change its tests (the whole list, in running order).', (ctx, r) => library.updatePreset(ctx, r.params.id, r.body)],
  ['POST', '/v1/test-presets/:id/copy', 'any', 'Performance', 'Copy a preset as "<name> (copy)".', (ctx, r) => library.copyPreset(ctx, r.params.id), 201],
  ['DELETE', '/v1/test-presets/:id', 'any', 'Performance', 'Delete a preset. Testing days made from it keep their tests.', (ctx, r) => library.deletePreset(ctx, r.params.id)],
  ['POST', '/v1/results', 'any', 'Performance', 'Record results from any device or app. Body: {results: [{athlete: {athlete_id | client_id | roster_id (saved on that athlete\'s profile) | email | external_id + name}, test, metric, value, unit, side, attempt, recorded_at, timing, device, external_id}], provider, session_id}. Values in other units are converted. Sending the same external_id again is ignored, so retries are safe. Up to 1,000 per request.', (ctx, r) => {
    const items = Array.isArray(r.body.results) ? r.body.results : [r.body];
    const provider = r.body.provider ? v.str(r.body.provider, 'provider', { max: 40 }).toLowerCase() : null;
    return perf.recordResults(ctx, items, { source: r.body.source ?? (provider ? `api:${provider}` : r.apiKey ? 'api' : 'manual'), provider, sessionId: r.body.session_id ?? null });
  }, 201],
  ['GET', '/v1/results', 'any', 'Performance', 'Results, newest first. Filter with ?client_id, roster_id (that roster athlete\'s profile), session_id, test, source, from, to, limit.', (ctx, r) => list(perf.listResults(ctx, r.query))],
  ['DELETE', '/v1/results/:id', 'any', 'Performance', 'Remove a mistaken result.', (ctx, r) => perf.voidResult(ctx, r.params.id)],
  ['GET', '/v1/clients/:id/performance', 'any', 'Performance', 'A client\'s results per test: best, first, latest, change and history.', (ctx, r) => list(perf.athleteProfile(ctx, { client_id: r.params.id }))],
  ['GET', '/v1/roster/:id/performance', 'any', 'Performance', 'A team roster athlete\'s results per test (from their client profile, the same as /v1/clients/:id/performance).', (ctx, r) => list(perf.athleteProfile(ctx, { roster_id: r.params.id }))],
  ['GET', '/v1/testing-sessions', 'any', 'Performance', 'Testing days, newest first, each with its status (open or shared) and progress (athlete-and-test pairs done out of planned). waiting = results waiting to be linked.', (ctx) => ({ data: perf.listSessions(ctx), waiting: queue.queueCount(ctx).n })],
  ['POST', '/v1/testing-sessions', 'any', 'Performance', 'Plan a testing day: name, date, tests [keys], athletes [{client_id} | {athlete_id} | {roster_id} (their profile)], or contract_id to bring in a team roster. retest_of (a testing day id) copies that day\'s athletes and tests. Archived clients are left out (left_out counts them).', (ctx, r) => perf.createSession(ctx, r.body), 201],
  ['GET', '/v1/testing-sessions/:id', 'any', 'Performance', 'A testing day with every athlete\'s results and previous best (from before this day) per test, metric and side.', (ctx, r) => perf.getSession(ctx, r.params.id)],
  ['PATCH', '/v1/testing-sessions/:id', 'any', 'Performance', 'Change the name, date, tests or athletes. Taking off a test or athlete with results on this day deletes those results: send confirm: true (409 confirmation_required with the count otherwise).', (ctx, r) => perf.updateSession(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/testing-sessions/:id', 'any', 'Performance', 'Delete a testing day and its results (?confirm=true when it has results). Only the owner can delete a shared day.', (ctx, r) => perf.deleteSession(ctx, r.params.id, { confirm: r.query.confirm === 'true', role: r.user?.role ?? 'owner' })],
  ['POST', '/v1/testing-sessions/:id/athletes', 'any', 'Performance', 'Add a walk-up to a testing day: athlete_id, client_id or roster_id (their profile). Archived clients are refused.', (ctx, r) => perf.addSessionAthlete(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/testing-sessions/:id/athletes/:athlete', 'any', 'Performance', 'Take an athlete (client or roster id) off a testing day. Their results on the day are deleted, so that needs ?confirm=true.', (ctx, r) => perf.removeSessionAthlete(ctx, r.params.id, r.params.athlete, { confirm: r.query.confirm === 'true' })],
  ['GET', '/v1/testing-sessions/:id/share-preview', 'any', 'Performance', 'Who sharing reaches: athletes with and without results, families that will be emailed, athletes with no parent email, and (after sharing) who has results added since families were last emailed.', (ctx, r) => perf.sharePreview(ctx, r.params.id)],
  ['POST', '/v1/testing-sessions/:id/share', 'any', 'Performance', 'Share a testing day with families: results appear in the parent portal and parents are emailed. Optional parent_note; notify=false to skip emails; only_new=true (after sharing) emails only the families with results added since they were last emailed.', (ctx, r) => reports.shareSession(ctx, r.params.id, r.body, r.baseUrl)],
  ['GET', '/v1/testing-sessions/:id/notes', 'any', 'Performance', 'Progress notes for parents on this testing day: one per athlete with results, drafted or approved.', (ctx, r) => notes.sessionNotes(ctx, r.params.id)],
  ['POST', '/v1/testing-sessions/:id/notes/draft', 'any', 'Performance', 'Draft a plain-English note for each athlete without one, from their results. client_ids redoes those drafts. Approved notes are never replaced.', (ctx, r) => notes.draftNotes(ctx, r.params.id, r.body)],
  ['POST', '/v1/testing-sessions/:id/notes/approve', 'any', 'Performance', 'Approve every draft on this testing day. Parents see approved notes once the day is shared.', (ctx, r) => notes.approveAll(ctx, r.params.id, r.user)],
  ['PATCH', '/v1/progress-notes/:id', 'any', 'Performance', 'Edit a progress note (body) or approve it (approved: true; false takes it back).', (ctx, r) => notes.updateNote(ctx, r.params.id, r.body, r.user)],
  ['DELETE', '/v1/testing-sessions/:id/share', 'any', 'Performance', 'Hide a testing day from families again.', (ctx, r) => reports.unshareSession(ctx, r.params.id)],
  ['GET', '/v1/clients/:id/report', 'any', 'Performance', 'Progress report: best, first, previous and latest for every test, change since the first and the last test, top improvements, growth and growth-spurt estimate. ?parent_view=true shows exactly what the family sees; the coach view marks results the family can\'t see yet (unshared_days). ?from= and ?to= (YYYY-MM-DD) limit it to a period.', (ctx, r) => ({ ...reports.athleteReport(ctx, clients.getClient(ctx, r.params.id).id, { parentView: r.query.parent_view === 'true', ...reports.reportPeriod(r.query) }), can_share: r.user ? r.user.role !== 'front_desk' : true })],
  ['GET', '/v1/clients/:id/report-links', 'any', 'Performance', 'Working share links to this athlete\'s progress report (the family view): who made each, when it expires and how often it was opened. The link addresses are only shown when made.', (ctx, r) => list(reports.listReportLinks(ctx, clients.getClient(ctx, r.params.id).id))],
  ['POST', '/v1/clients/:id/report-links', 'any', 'Performance', 'Make a share link to the family view of the progress report that works without signing in: days (7, 30, 90 or 365), optional label. The response has the url once. Up to 10 working links per athlete.', (ctx, r) => reports.createReportLink(ctx, clients.getClient(ctx, r.params.id).id, r.body, staffBy(r), r.baseUrl), 201],
  ['DELETE', '/v1/clients/:id/report-links/:link', 'any', 'Performance', 'Turn off a share link. It stops working at once.', (ctx, r) => reports.revokeReportLink(ctx, clients.getClient(ctx, r.params.id).id, r.params.link)],
  ['POST', '/v1/clients/:id/report/email', 'any', 'Performance', 'Email the family a summary of the progress report (what they can see) with the report link: optional note, include_link=true adds a 90-day share link so they don\'t need to sign in.', (ctx, r) => reports.emailReport(ctx, clients.getClient(ctx, r.params.id).id, r.body, staffBy(r), r.baseUrl)],
  ['GET', '/v1/athletes', 'any', 'Performance', 'Everyone results can be linked to: clients who aren\'t archived (team roster athletes are clients too), each with client_id, name, Athlete ID and team (their active teams).', (ctx) => list(perf.listAthletes(ctx))],
  ['GET', '/v1/athlete-links', 'any', 'Performance', 'Device IDs and names you\'ve linked to athletes (?provider=, ?client_id=, ?roster_id=).', (ctx, r) => list(perf.listLinks(ctx, r.query))],
  ['GET', '/v1/queue', 'any', 'Performance', 'Results waiting to be linked to a profile, grouped by who sent them. Results only land automatically by Athlete ID or a link you confirmed.', (ctx) => ({ data: queue.listQueue(ctx), ...queue.queueCount(ctx) })],
  ['POST', '/v1/queue/link', 'any', 'Performance', 'Link waiting results to an athlete: athlete_id (or client_id / roster_id), and either provider + identity (everything from that sender) or ids [specific results]. remember=true sends that sender\'s future results straight to the athlete. All or nothing.', (ctx, r) => queue.linkQueue(ctx, r.body)],
  ['POST', '/v1/queue/discard', 'any', 'Performance', 'Throw away waiting results: provider + identity, or ids.', (ctx, r) => queue.discardQueue(ctx, r.body)],
  ['POST', '/v1/athlete-links', 'any', 'Performance', 'Link a device ahead of time (or move a link): provider, external_id (the device\'s athlete ID, or the name the device uses with kind=name), optional external_name, and athlete_id, client_id or roster_id. Results already waiting from that device are linked too. moved_from says who had it before.', (ctx, r) => queue.linkDevice(ctx, r.body), 201],
  ['DELETE', '/v1/athlete-links/:provider/:external', 'any', 'Performance', 'Remove a link. Returns the link, so it can be put back.', (ctx, r) => perf.unlinkAthlete(ctx, r.params.provider, decodeURIComponent(r.params.external))],
  ['GET', '/v1/uploads/template', 'any', 'Performance', 'Download a results template (Excel by default, ?format=csv) with every athlete\'s ID filled in. Choose ?tests=dash_40yd,broad_jump and athletes with ?session_id, ?contract_id or ?client_ids.', (ctx, r) => ({ __file: uploads.buildTemplate(ctx, r.query) })],
  ['POST', '/v1/uploads/preview', 'any', 'Performance', 'Check a filled-in sheet (csv, or xlsx_base64 for Excel; optional session_id, date, test). Every row needs a real Athlete ID, every column a known test, every value a possible number. Returns ok=false with every problem (row, column, message) if anything is wrong, and the unusual values to confirm. Nothing is saved.', (ctx, r) => uploads.previewUpload(ctx, r.body)],
  ['POST', '/v1/uploads/commit', 'any', 'Performance', 'Save a checked upload: preview_id, confirm [warning keys]. All or nothing: the sheet is checked again, and if any problem remains or a warning isn\'t confirmed, nothing is saved.', (ctx, r) => uploads.commitUpload(ctx, r.body, r.user), 201],
  ['GET', '/v1/uploads', 'any', 'Performance', 'Recent uploads and file imports, newest first (?limit, up to 50): what each saved, replaced and sent to waiting, and whether it was undone.', (ctx, r) => list(uploads.recentUploads(ctx, r.query))],
  ['POST', '/v1/uploads/:id/undo', 'any', 'Performance', 'Undo an upload or file import: results it added come out, values it replaced go back, and results it sent to waiting are dropped. Anything changed or linked since is left alone.', (ctx, r) => uploads.undoUpload(ctx, r.params.id, r.user)],
  ['GET', '/v1/integrations', 'any', 'Performance', 'Timing and measurement systems: which are connected, last sync, saved file layouts.', (ctx) => list(perfImport.listIntegrations(ctx))],
  ['POST', '/v1/imports', 'any', 'Performance', 'Import a CSV export: provider (ovr, vald, swift, freelap, generic …), csv (the file\'s text), optional test (if the file holds one test), mapping, session_id. dry_run=true returns the column matches and preview without saving.', (ctx, r) => perfImport.importFile(ctx, r.body, r.user), 201],
  ['GET', '/v1/imports', 'any', 'Performance', 'Recent imports, with athletes still waiting to be matched.', (ctx) => list(perfImport.listBatches(ctx))],
  ['GET', '/v1/imports/:id', 'any', 'Performance', 'One import.', (ctx, r) => perfImport.getBatch(ctx, r.params.id)],
  ['PUT', '/v1/integrations/hawkin', 'session', 'Performance', 'Connect Hawkin Dynamics: refresh_token (integration token), region (americas, europe, apac), backfill_days (default 90).', (ctx, r) => perfImport.connectHawkin(ctx, r.body)],
  ['POST', '/v1/integrations/hawkin/sync', 'any', 'Performance', 'Pull new Hawkin tests now (also runs every 15 minutes).', (ctx) => perfImport.syncHawkin(ctx)],
  ['DELETE', '/v1/integrations/:provider', 'session', 'Performance', 'Disconnect a system.', (ctx, r) => perfImport.disconnect(ctx, r.params.provider)],

  // Staff, security and backups (owner only)
  ['GET', '/v1/staff', 'session', 'Admin', 'Staff accounts and their roles, each with devices signed in, what they still lead (work: upcoming sessions, classes, hours) and still_leading (turned off or front desk but still leading).', (ctx) => ({ data: security.listStaff(ctx), roles: security.ROLES })],
  ['GET', '/v1/staff/summary', 'session', 'Admin', 'Security summary: staff who can sign in, turned off, locked, not signed in yet, accounts still leading sessions, failed sign-ins in 24 hours, refused requests in 7 days, and backups (last, overdue, total size, off-site).', (ctx) => staff.securitySummary(ctx)],
  ['GET', '/v1/staff/connection', 'session', 'Admin', 'Connection check: the X-Forwarded-For header this request arrived with, the connection address, the address the app decided on and TRUST_PROXY, with what to change.', (ctx, r) => security.connectionCheck(r.connection)],
  ['POST', '/v1/staff', 'session', 'Admin', 'Add a staff member: name, email, role (owner, coach, front_desk). Returns a one-time password, also emailed. An email of a turned-off account says so (details.user_id).', (ctx, r) => security.addStaff(ctx, r.body, r.baseUrl), 201],
  ['GET', '/v1/staff/:id', 'session', 'Admin', 'One staff member: devices they are signed in on, recent activity and what they still lead.', (ctx, r) => staff.staffDetail(ctx, r.params.id, r.user.session_id)],
  ['PATCH', '/v1/staff/:id', 'session', 'Admin', 'Change name, email or role, turn an account off (active=false) or on, or unlock it (unlock=true). A new role or turning off signs them out; a new email or turning off cancels emailed reset links.', (ctx, r) => security.updateStaff(ctx, r.params.id, r.body, r.user)],
  ['POST', '/v1/staff/:id/reset-password', 'session', 'Admin', 'Give a staff member a new one-time password (for someone who never signed in: resend the invite). Signs them out and cancels emailed reset links.', (ctx, r) => security.resetStaffPassword(ctx, r.params.id, r.baseUrl)],
  ['POST', '/v1/staff/:id/sign-out', 'session', 'Admin', 'Sign a staff member out of every device (your own: every device but this one) without changing their password.', (ctx, r) => ({ ok: true, signed_out: access.endSessions(ctx, staff.staffDetail(ctx, r.params.id).id, { exceptId: r.params.id === r.user.id ? r.user.session_id : null }) })],
  ['POST', '/v1/staff/:id/devices/:device/sign-out', 'session', 'Admin', 'Sign a staff member out of one device.', (ctx, r) => access.endSession(ctx, staff.staffDetail(ctx, r.params.id).id, r.params.device, r.user.session_id)],
  ['GET', '/v1/staff/:id/hand-over', 'session', 'Admin', 'Before handing over: what they lead (upcoming sessions, classes, hours, booked clients), the next sessions, and with ?to= (a coach or owner) any sessions that clash with what that person already leads.', (ctx, r) => staff.handOverPreview(ctx, r.params.id, r.query.to === undefined ? undefined : r.query.to === 'none' ? null : r.query.to)],
  ['POST', '/v1/staff/:id/hand-over', 'session', 'Admin', 'Hand everything they lead from now on to another active coach or owner: to (their id, or null for nobody: sessions and classes left without a coach, hours removed). Clashing sessions are refused (details.conflicts) unless leave_conflicts=true leaves them with this person.', (ctx, r) => staff.handOver(ctx, r.params.id, r.body, r.user)],
  ['GET', '/v1/audit', 'session', 'Admin', 'Every change and sign-in, newest first: who, what, when, from where. Filter with ?who= (staff, api_key, parent, public, system), ?staff_id, ?actor_id, ?target, ?kind= (sign_ins, refused, failures), ?failures=true, ?since and ?until (dates, business time zone), ?q (name, record, address or what happened); ?limit, ?offset. total is the number matching.', (ctx, r) => {
    const q = auditQuery(r.query);
    return { ...list(security.listAudit(ctx, q).map((a) => ({ ...a, description: describeAction(a.action) }))), total: security.countAudit(ctx, q) };
  }],
  ['GET', '/v1/audit/export', 'session', 'Admin', 'The activity log as a CSV file, with the same filters as GET /v1/audit (up to 20,000 rows). Cells that could run as spreadsheet formulas are made safe.', (ctx, r) => {
    const { csv } = security.auditCsv(ctx, auditQuery(r.query), (a) => describeAction(a.action));
    return { __file: { filename: `activity-${new Date().toISOString().slice(0, 10)}.csv`, type: 'text/csv; charset=utf-8', body: csv } };
  }],
  ['GET', '/v1/backups', 'session', 'Admin', 'Database backups (one a day, the last 30 kept) and the off-site copy status.', (ctx) => ({ data: backups.listBackups(ctx), dir: backups.backupDir(ctx), offsite: offsite.status(ctx) })],
  ['POST', '/v1/backups', 'session', 'Admin', 'Make a backup now, and send it off-site when that is set up.', async (ctx) => {
    const b = backups.createBackup(ctx);
    return { ...b, offsite: await offsite.sendNewest(ctx) };
  }, 201],
  ['GET', '/v1/backups/:name', 'session', 'Admin', 'Download a backup file.', (ctx, r) => ({ __file: backups.backupFile(ctx, r.params.name) })],
  ['GET', '/v1/jobs', 'session', 'Admin', 'Background jobs: health, last runs and errors (runs are kept 30 days).', (ctx) => ({ data: ctx.jobs.status() })],
  ['POST', '/v1/jobs/:name/run', 'session', 'Admin', 'Run a background job now.', (ctx, r) => ctx.jobs.runNow(r.params.name)],

  // Integrations (owner, signed in to the dashboard: API keys can't manage keys or webhooks)
  ['GET', '/v1/api-status', 'session', 'Integrations', 'API & integrations at a glance: API keys (requests and errors in 30 days), webhooks (failing, failed in 7 days, waiting), email and texts (mode, failures in 7 days, counts) and exercise video coverage.', (ctx) => integrations.apiStatus(ctx)],
  ['GET', '/v1/api-keys', 'session', 'Integrations', 'List API keys, each with its access level (scope: read, results or full) and requests and errors in the last 30 days.', (ctx) => ({ ...list(access.listApiKeys(ctx)), scopes: access.KEY_SCOPES })],
  ['POST', '/v1/api-keys', 'session', 'Integrations', 'Create an API key: label and scope (read = read only, the default; results = read and send test results and device files; full = everything an API key can do). The full key is shown once.', (ctx, r) => access.createApiKey(ctx, r.body), 201],
  ['PATCH', '/v1/api-keys/:id', 'session', 'Integrations', 'Rename a key (label) or change its access level (scope) without replacing it.', (ctx, r) => access.updateApiKey(ctx, r.params.id, r.body)],
  ['POST', '/v1/api-keys/:id/revoke', 'session', 'Integrations', 'Revoke a key immediately.', (ctx, r) => access.revokeApiKey(ctx, r.params.id)],
  ['GET', '/v1/api-keys/:id/requests', 'session', 'Integrations', 'Requests made with a key in the last 30 days, newest first: method, address, answer, time taken, from where and the error sent back (never what was sent). ?status=errors, ?limit.', (ctx, r) => access.apiRequests(ctx, r.params.id, r.query)],
  ['GET', '/v1/webhooks', 'session', 'Integrations', 'List webhook endpoints, each with how it is doing: delivered and failed in 7 days, waiting, failures in a row (failing after 3). The signing secret is shown only as a hint.', (ctx) => list(events.listEndpoints(ctx))],
  ['POST', '/v1/webhooks', 'session', 'Integrations', 'Add an endpoint: url (a public https address), events (or ["*"]), optional label. Returns the signing secret. A URL already used by another webhook is refused.', (ctx, r) => events.createEndpoint(ctx, r.body), 201],
  ['PATCH', '/v1/webhooks/:id', 'session', 'Integrations', 'Change label, url, events or active.', (ctx, r) => events.updateEndpoint(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/webhooks/:id', 'session', 'Integrations', 'Delete an endpoint.', (ctx, r) => events.deleteEndpoint(ctx, r.params.id)],
  ['GET', '/v1/webhooks/:id/secret', 'session', 'Integrations', 'Show an endpoint\'s signing secret.', (ctx, r) => events.endpointSecret(ctx, r.params.id)],
  ['POST', '/v1/webhooks/:id/rotate-secret', 'session', 'Integrations', 'Make a new signing secret, shown once. The old one also signs (a second v1= in DP-Signature) for keep_old_hours (0 to 72, default 24) so your receiver can switch over.', (ctx, r) => events.rotateSecret(ctx, r.params.id, r.body)],
  ['POST', '/v1/webhooks/:id/test', 'session', 'Integrations', 'Send a test event now and wait for the answer: event (test.ping, the default, or a sample of any event type, marked "test": true). Tried once; never in the activity feed.', (ctx, r) => events.sendTest(ctx, r.params.id, r.body)],
  ['POST', '/v1/webhooks/:id/resend-failed', 'session', 'Integrations', 'Send every delivery that failed in the last 7 days again (up to 50).', (ctx, r) => events.resendFailed(ctx, r.params.id)],
  ['GET', '/v1/webhooks/:id/deliveries', 'session', 'Integrations', 'Delivery attempts for an endpoint, newest first. ?status= (failed, delivered, waiting), ?event=, ?limit, ?offset.', (ctx, r) => events.listDeliveries(ctx, r.params.id, r.query)],
  ['GET', '/v1/webhook-deliveries', 'session', 'Integrations', 'Deliveries to every endpoint, newest first, with the same filters.', (ctx, r) => events.listDeliveries(ctx, null, r.query)],
  ['GET', '/v1/webhook-deliveries/:id', 'session', 'Integrations', 'One delivery: what was sent, the answer (code, the start of the response, time taken), a plain reason for a failure and tries so far.', (ctx, r) => events.getDelivery(ctx, r.params.id)],
  ['POST', '/v1/webhook-deliveries/:id/resend', 'session', 'Integrations', 'Send a delivery again now: the same body and DP-Delivery id, signed with the current secret.', (ctx, r) => events.resendDelivery(ctx, r.params.id)],
  ['GET', '/v1/event-types', 'any', 'Integrations', 'Every event type a webhook can subscribe to. info has what each means and a sample of its data.', () => ({ ...list(events.EVENT_TYPES), info: events.EVENT_INFO })],
  ['GET', '/v1/video-coverage', 'session', 'Integrations', 'Exercise demo videos: how many exercises have one that plays in the workout app, and those that need one (used in programs first; unplayable links flagged).', (ctx) => integrations.videoCoverage(ctx)],
  ['GET', '/v1/athletes/:athlete_id/results', 'any', 'Performance', 'One athlete\'s test results by Athlete ID, newest first; best marks each test\'s best among those returned. ?test= (key), ?since= (a date, from midnight in the business time zone), ?limit.', (ctx, r) => integrations.athleteResults(ctx, r.params.athlete_id, r.query)],

  // Accountability, performance targets and education. Owners and coaches manage; front desk views.
  ['GET', '/v1/clients/:id/engagement', 'any', 'Engagement', 'Accountability for one athlete: streaks, this week, 30-day check-in averages and flags, goals, messages, test targets, rankings and assigned reading.', (ctx, r) => engage.staffOverview(ctx, clients.getClient(ctx, r.params.id).id)],
  ['POST', '/v1/clients/:id/goals', 'any', 'Engagement', 'Set a weekly goal: kind (workouts, sessions, checkins, custom), target (1-14 a week), optional title.', (ctx, r) => engage.createGoal(ctx, { clientId: clients.getClient(ctx, r.params.id).id }, r.body, r.user ?? r.apiKey), 201],
  ['GET', '/v1/replies', 'any', 'Engagement', 'Replies from athletes and parents that no coach has seen yet, one row per athlete.', (ctx) => list(engage.unreadReplies(ctx))],
  ['POST', '/v1/clients/:id/messages/seen', 'any', 'Engagement', 'Mark an athlete\'s replies as seen by the coaches.', (ctx, r) => engage.markRepliesSeen(ctx, r.params.id)],
  ['POST', '/v1/clients/:id/messages', 'any', 'Engagement', 'Send the athlete a message: body. The athlete and their parents are emailed a copy.', (ctx, r) => engage.sendMessage(ctx, { clientId: clients.getClient(ctx, r.params.id).id }, r.body, r.user ?? r.apiKey), 201],
  ['POST', '/v1/clients/:id/targets', 'any', 'Engagement', 'Set a test target: test (key), target (like 84, 6\'5" or 1:05), optional due_date. Replaces an existing target for that test.', (ctx, r) => engage.setTarget(ctx, clients.getClient(ctx, r.params.id).id, r.body, r.user ?? r.apiKey), 201],
  ['DELETE', '/v1/targets/:id', 'any', 'Engagement', 'Remove a test target. Results stay.', (ctx, r) => engage.removeTarget(ctx, r.params.id)],
  ['PATCH', '/v1/goals/:id', 'any', 'Engagement', 'Change a goal\'s title or target, or end it with active=false.', (ctx, r) => engage.updateGoal(ctx, r.params.id, r.body)],
  ['GET', '/v1/teams', 'any', 'Engagement', 'Active teams for goals, messages and assigned reading (names and roster counts only).', (ctx) => list(engage.listTeams(ctx))],
  ['GET', '/v1/teams/:id/engagement', 'any', 'Engagement', 'A team\'s goals, messages and assigned reading, and which roster athletes have the app.', (ctx, r) => engage.teamEngagement(ctx, r.params.id)],
  ['POST', '/v1/teams/:id/goals', 'any', 'Engagement', 'Set a weekly goal for everyone on the roster: kind, target, optional title.', (ctx, r) => engage.createGoal(ctx, { contractId: r.params.id }, r.body, r.user ?? r.apiKey), 201],
  ['POST', '/v1/teams/:id/messages', 'any', 'Engagement', 'Message the whole roster: body. Athletes and parents are emailed.', (ctx, r) => engage.sendMessage(ctx, { contractId: r.params.id }, r.body, r.user ?? r.apiKey), 201],
  ['GET', '/v1/daily-check-ins/flags', 'any', 'Engagement', 'Athletes whose latest daily check-in (today or yesterday) needs a look: short sleep, high soreness, low energy, mood or hydration.', (ctx) => list(engage.recentFlags(ctx))],
  ['GET', '/v1/skill-badges', 'any', 'Engagement', 'Skill badges coaches can award, with how many athletes have each. all=1 includes removed ones.', (ctx, r) => list(engage.listBadges(ctx, { all: r.query.all === '1' }))],
  ['POST', '/v1/skill-badges', 'any', 'Engagement', 'Add a skill badge: name, description, category (Speed, Strength, Power, Mobility, Skill or Mindset).', (ctx, r) => engage.createBadge(ctx, r.body), 201],
  ['PATCH', '/v1/skill-badges/:id', 'any', 'Engagement', 'Change a skill badge: name, description, category, archived (true takes it off the list; badges already earned stay).', (ctx, r) => engage.updateBadge(ctx, r.params.id, r.body)],
  ['POST', '/v1/skill-badges/:id/awards', 'any', 'Engagement', 'Award a badge: client_ids (or client_id), note. Athletes who already have it are skipped. Each family gets an email.', (ctx, r) => engage.awardBadge(ctx, r.params.id, r.body, r.user ?? r.apiKey)],
  ['DELETE', '/v1/badge-awards/:id', 'any', 'Engagement', 'Take back a badge awarded by mistake.', (ctx, r) => engage.removeAward(ctx, r.params.id)],
  ['GET', '/v1/engagement/settings', 'any', 'Engagement', 'Whether rankings and readiness-adjusted weights are on.', (ctx) => engage.engagementSettings(ctx)],
  ['PATCH', '/v1/engagement/settings', 'any', 'Engagement', 'Turn rankings ("on" or "off": athletes and parents see where a best result ranks, never anyone else\'s name) or readiness_adjust ("on" or "off": after a rough daily check-in, weights set from a tested max come down 10 or 20 points of the max in the athlete app) on or off.', (ctx, r) => engage.setRankings(ctx, r.body)],
  ['GET', '/v1/education', 'any', 'Education', 'Every course and lesson with completions, and each assignment with who has finished.', (ctx) => engage.educationReport(ctx)],
  ['GET', '/v1/lessons/:id', 'any', 'Education', 'One lesson with its full text.', (ctx, r) => engage.getLesson(ctx, r.params.id)],
  ['POST', '/v1/lessons', 'any', 'Education', 'Post a lesson: title, summary, body (plain text; blank lines start paragraphs), video_url (https), minutes, course_id, published.', (ctx, r) => engage.createLesson(ctx, r.body), 201],
  ['PATCH', '/v1/lessons/:id', 'any', 'Education', 'Edit a lesson. published=false hides it from athletes. quiz_text adds a quiz: a question per line followed by choices starting with - (the right one with *), a blank line between questions; empty removes it.', (ctx, r) => engage.updateLesson(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/lessons/:id', 'any', 'Education', 'Delete a lesson and its completions.', (ctx, r) => engage.deleteLesson(ctx, r.params.id)],
  ['POST', '/v1/courses', 'any', 'Education', 'Create a course: title, description, published, audience (athletes or parents), and for parent courses age_min and age_max (parents of athletes that age see it).', (ctx, r) => engage.createCourse(ctx, r.body), 201],
  ['POST', '/v1/courses/starter-parent', 'any', 'Education', 'Add three starter parent courses as drafts (growth spurts, fueling, recruiting basics) to read, edit and publish.', (ctx) => engage.addStarterParentCourses(ctx), 201],
  ['PATCH', '/v1/courses/:id', 'any', 'Education', 'Edit a course. published=false hides it from athletes.', (ctx, r) => engage.updateCourse(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/courses/:id', 'any', 'Education', 'Delete a course. Its lessons stay in the library.', (ctx, r) => engage.deleteCourse(ctx, r.params.id)],
  ['PUT', '/v1/courses/:id/order', 'any', 'Education', 'Reorder a course\'s lessons: lesson_ids in the new order.', (ctx, r) => engage.reorderCourse(ctx, r.params.id, r.body)],
  ['POST', '/v1/lesson-assignments', 'any', 'Education', 'Assign reading: lesson_id or course_id, to client_id or a team (contract_id), optional due_date and note. The athletes and their parents are emailed.', (ctx, r) => engage.assign(ctx, r.body, r.user ?? r.apiKey), 201],
  ['DELETE', '/v1/lesson-assignments/:id', 'any', 'Education', 'Remove an assignment. Completed lessons stay completed.', (ctx, r) => engage.unassign(ctx, r.params.id)],

  // Client app (authenticated by the client's private link token)
  ['GET', '/app/api/home', 'client', 'Client app', 'The client\'s next workout and progress.', (ctx, r) => programs.clientHome(ctx, r.client)],
  ['POST', '/app/api/workouts/:id/complete', 'client', 'Client app', 'Log a finished workout: exercise_ids done, sets (workout_exercise_id, set_no 1-12, weight lb, reps), rpe (effort 1-10), notes, started_at and finished_at (from the phone; kept when within the last 72 hours). request_id (the phone\'s id for this Finish) returns the first save for a resend. If the workout was logged on the weight-room screen, the sets join that log.', (ctx, r) => programs.completeWorkout(ctx, r.client, r.params.id, r.body), 201],
  ['GET', '/app/api/logs/:id', 'client', 'Client app', 'One of your finished workouts: each exercise, done or not, its sets, effort and note, and whether it can still be reopened.', (ctx, r) => programs.logDetail(ctx, r.client, r.params.id)],
  ['PUT', '/app/api/logs/:id', 'client', 'Client app', 'Save a reopened workout again (your latest one, within 2 hours of finishing): the same fields as finishing. Replaces what was logged.', (ctx, r) => programs.editLog(ctx, r.client, r.params.id, r.body)],
  ['GET', '/app/api/engage', 'client', 'Client app', 'Accountability, performance and education for the athlete.', (ctx, r) => engage.athleteView(ctx, r.client.id, { parentView: true })],
  ['POST', '/app/api/daily-check-in', 'client', 'Client app', 'Today\'s check-in: sleep_hours (0-16), hydration, soreness, energy, mood (1-5), note. Saving again today updates it.', (ctx, r) => engage.saveCheckin(ctx, r.client.id, r.body)],
  ['POST', '/app/api/goals/:id/check', 'client', 'Client app', 'Tick a custom goal for today (done=false to untick).', (ctx, r) => engage.checkGoal(ctx, r.client.id, r.params.id, r.body.done !== false)],
  ['POST', '/app/api/messages/read', 'client', 'Client app', 'Mark coach messages read.', (ctx, r) => engage.markRead(ctx, r.client.id)],
  ['POST', '/app/api/messages', 'client', 'Client app', 'Write back to your coach: body.', (ctx, r) => engage.replyMessage(ctx, r.client.id, r.body, { from: 'athlete', name: r.client.name }), 201],
  ['GET', '/app/api/lessons/:id', 'client', 'Client app', 'Read a lesson.', (ctx, r) => engage.lessonFor(ctx, r.client.id, r.params.id)],
  ['POST', '/app/api/lessons/:id/quiz', 'client', 'Client app', 'Take the lesson quiz: answers (the choice number for each question, from 0). 80% or more finishes the lesson. Only says which questions were wrong.', (ctx, r) => engage.takeQuiz(ctx, r.client.id, r.params.id, r.body)],
  ['POST', '/app/api/lessons/:id/complete', 'client', 'Client app', 'Mark a lesson done (done=false to undo).', (ctx, r) => engage.completeLesson(ctx, r.client.id, r.params.id, r.body.done !== false)],
  ...portalRoutes.map(([method, path, auth, summary, handler, status]) => [method, path, auth, 'Parent portal', summary, handler, status])
].map(([method, path, auth, tag, summary, handler, status = 200]) => ({
  method, path, auth, tag, summary, handler, status,
  regex: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$')
}));

export function openApiSpec(baseUrl) {
  const paths = {};
  for (const r of routes) {
    if (r.path.startsWith('/app/') || r.path.startsWith('/auth/') || r.path.startsWith('/portal/') || r.path.startsWith('/invoice-api/') || r.path.startsWith('/receipt-api/')) continue;
    const p = r.path.replace(/:(\w+)/g, '{$1}');
    paths[p] ??= {};
    paths[p][r.method.toLowerCase()] = {
      tags: [r.tag], summary: r.summary,
      security: r.auth === 'session' ? [{ session: [] }] : [{ apiKey: [] }, { session: [] }],
      parameters: [...r.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      ...(['POST', 'PATCH'].includes(r.method) ? { requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      responses: { [r.status]: { description: 'Success' }, 400: { description: 'Invalid input' }, 401: { description: 'Not signed in or bad API key' }, 404: { description: 'Not found' }, 409: { description: 'Not allowed in the current state' } }
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Diamond Protocol API', version: '1.0.0', description: 'Manage clients, subscriptions, billing and training programs. Authenticate with `Authorization: Bearer dp_live_...`. Errors return `{ "error": { "code", "message" } }`. Lists return `{ "data": [...] }`. Money is in cents.' },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' }, session: { type: 'apiKey', in: 'cookie', name: 'dp_session' } } },
    paths
  };
}

// Plain-English labels for the activity log, from each endpoint's own description.
const SPECIAL = { 'sign-in': 'Signed in', discount: 'Gave a discount on a sale', 'POST /portal/api/login': 'Parent asked for a sign-in code', 'POST /portal/api/verify': 'Parent signed in', 'POST /auth/logout': 'Signed out', 'POST /portal/api/logout': 'Parent signed out', 'job failed': 'Background job failed (owners emailed)', 'job recovered': 'Background job running again' };
function describeAction(action) {
  if (SPECIAL[action]) return SPECIAL[action];
  const [method, path] = action.split(' ');
  const r = routes.find((x) => x.method === method && x.path === path);
  return r ? r.summary.split(/[:.(]/)[0].trim() : action;
}
// The activity log's text search also matches what happened in plain English: the log actions whose description has
// the words, passed on to security.listAudit.
function auditQuery(q) {
  const text = String(q.q ?? '').trim().toLowerCase();
  if (!text) return q;
  const actions = [...new Set([...routes.map((r) => `${r.method} ${r.path}`), ...Object.keys(SPECIAL)])].filter((a) => describeAction(a).toLowerCase().includes(text));
  return { ...q, actions };
}
