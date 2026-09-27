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
import * as backups from './services/backups.js';
import * as reports from './services/reports.js';
import * as legal from './services/legal.js';
import * as clientImport from './services/client-import.js';
import * as engage from './services/engage.js';
import { listOutbox, sendEmail, mailMode } from './services/mail.js';
import * as sms from './services/sms.js';
import * as insights from './services/insights.js';
import { portalRoutes } from './portal-routes.js';
import { HttpError, v, badRequest } from './util.js';

// auth: 'public' | 'any' (coach session or API key) | 'session' (coach login only; for managing keys and webhooks)
// Each entry: [method, path, auth, tag, summary, handler(ctx, req)] where req = { params, query, body, user, apiKey }
const list = (data) => ({ data });
const subOf = (ctx, clientId) => {
  const s = billing.currentSubscription(ctx, clientId);
  if (!s) throw new HttpError(409, 'conflict', 'This client has no active subscription.');
  return s.id;
};

export const routes = [
  // Coach login
  ['POST', '/auth/login', 'public', 'Auth', 'Sign in as a coach. Sets a session cookie.', (ctx, r) => access.login(ctx, r.body)],
  ['POST', '/auth/logout', 'session', 'Auth', 'Sign out.', (ctx, r) => { access.logout(ctx, r.sessionToken); return { ok: true }; }],
  ['POST', '/auth/token', 'public', 'Auth', 'Sign in from the iPhone coach app. Returns a 90-day bearer token (dp_app_...).', (ctx, r) => access.appLogin(ctx, r.body)],
  ['POST', '/auth/password', 'session', 'Auth', 'Change your password: current_password, new_password (10+ characters).', (ctx, r) => security.changePassword(ctx, r.user, r.body)],
  ['GET', '/auth/me', 'session', 'Auth', 'The signed-in coach.', (ctx, r) => ({ user: { ...r.user, must_change_password: !!r.user.must_change_password }, roles: security.ROLES, test_mode: ctx.testMode, payments: { provider: ctx.payments.name, live: ctx.payments.live, can_simulate: !!ctx.payments.simulate } })],

  // Dashboard
  ['GET', '/v1/dashboard', 'any', 'Dashboard', 'Revenue, client counts, items that need attention and recent activity.', (ctx, r) => access.dashboard(ctx, { role: r.user?.role ?? 'owner' })],
  ['GET', '/v1/at-risk', 'any', 'Dashboard', 'Athletes who may be drifting away: a score (40 to 100) and the reasons, from attendance, bookings, check-ins and (owners only) payments.', (ctx, r) => list(insights.atRisk(ctx, { role: r.user?.role ?? 'owner' }))],
  ['GET', '/v1/digest', 'any', 'Dashboard', 'This week\'s owner summary: money in, members, athletes to check on, open spots and suggested actions. Includes the email text.', (ctx) => { const d = insights.buildDigest(ctx); return { ...d, text: insights.digestText(ctx, d) }; }],
  ['POST', '/v1/digest/send', 'session', 'Dashboard', 'Email this week\'s summary to the owners now.', (ctx) => insights.sendDigest(ctx)],
  ['GET', '/v1/events', 'any', 'Dashboard', 'Recent events, newest first. Filter with ?type=.', (ctx, r) => list(events.listEvents(ctx, { type: r.query.type, limit: v.int(r.query.limit ?? 50, 'limit', { min: 1, max: 200 }) }))],

  // Clients
  ['GET', '/v1/clients', 'any', 'Clients', 'List clients. Filter with ?q= (name or email) and ?status=.', (ctx, r) => list(clients.listClients(ctx, r.query))],
  ['POST', '/v1/clients', 'any', 'Clients', 'Create a client. Optional plan_id starts a subscription (with trial); optional program_id assigns a program.', (ctx, r) => clients.createClient(ctx, r.body), 201],
  ['GET', '/v1/clients/:id', 'any', 'Clients', 'Get a client with subscription, program and app link.', (ctx, r) => clients.getClient(ctx, r.params.id, { withSecrets: true })],
  ['PATCH', '/v1/clients/:id', 'any', 'Clients', 'Update name, email, phone or notes.', (ctx, r) => clients.updateClient(ctx, r.params.id, r.body)],
  ['POST', '/v1/clients/:id/app-link', 'any', 'Clients', 'Issue a new private app link. The old link stops working.', (ctx, r) => clients.resetAppLink(ctx, r.params.id)],
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
  ['POST', '/v1/billing/run', 'any', 'Billing', 'Run renewals and scheduled retries now. In test mode, pass as_of to run for a future date.', (ctx, r) => {
    let asOf = ctx.now();
    if (r.body.as_of !== undefined) {
      if (!ctx.testMode) throw badRequest('as_of is only available in test mode.');
      asOf = v.date(r.body.as_of, 'as_of');
    }
    return billing.runBilling(ctx, asOf);
  }],

  // Training
  ['GET', '/v1/exercises', 'any', 'Training', 'The exercise library.', (ctx) => list(programs.listExercises(ctx))],
  ['POST', '/v1/exercises', 'any', 'Training', 'Add an exercise: name, video_url (YouTube, Vimeo or a direct video file), instructions.', (ctx, r) => programs.createExercise(ctx, r.body), 201],
  ['PATCH', '/v1/exercises/:id', 'any', 'Training', 'Update an exercise.', (ctx, r) => programs.updateExercise(ctx, r.params.id, r.body)],
  ['GET', '/v1/programs', 'any', 'Training', 'List programs with workout and client counts.', (ctx) => list(programs.listPrograms(ctx))],
  ['POST', '/v1/programs', 'any', 'Training', 'Create a program: name, weeks, level, description.', (ctx, r) => programs.createProgram(ctx, r.body), 201],
  ['GET', '/v1/programs/:id', 'any', 'Training', 'A program with every workout and exercise.', (ctx, r) => programs.getProgram(ctx, r.params.id)],
  ['PATCH', '/v1/programs/:id', 'any', 'Training', 'Update a program.', (ctx, r) => programs.updateProgram(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/programs/:id', 'any', 'Training', 'Delete a program nobody is on.', (ctx, r) => programs.deleteProgram(ctx, r.params.id)],
  ['POST', '/v1/programs/:id/workouts', 'any', 'Training', 'Add a workout: week, day, title.', (ctx, r) => programs.addWorkout(ctx, r.params.id, r.body), 201],
  ['POST', '/v1/programs/:id/assign', 'any', 'Training', 'Put client_id on this program. Replaces their current program.', (ctx, r) => programs.assign(ctx, r.params.id, v.str(r.body.client_id, 'client_id'), r.body.start_date), 201],
  ['DELETE', '/v1/workouts/:id', 'any', 'Training', 'Delete a workout.', (ctx, r) => programs.deleteWorkout(ctx, r.params.id)],
  ['POST', '/v1/workouts/:id/exercises', 'any', 'Training', 'Add exercise_id to a workout with a prescription like "3 × 10".', (ctx, r) => programs.addWorkoutExercise(ctx, r.params.id, r.body), 201],
  ['DELETE', '/v1/workout-exercises/:id', 'any', 'Training', 'Remove an exercise from a workout.', (ctx, r) => programs.removeWorkoutExercise(ctx, r.params.id)],
  ['GET', '/v1/completions', 'any', 'Training', 'Completed workouts across all clients. ?since= to filter.', (ctx, r) => list(programs.listCompletions(ctx, { since: r.query.since ? v.date(r.query.since, 'since') : undefined }))],

  // Point of sale: in-person payments at the facility, in parks and at clients' homes
  ['GET', '/v1/locations', 'any', 'Point of sale', 'Places you train. card_ready shows whether card payments are set up there.', (ctx, r) => list(commerce.listLocations(ctx, { includeInactive: r.query.include_inactive === 'true' }))],
  ['POST', '/v1/locations', 'any', 'Point of sale', 'Add a location: name, kind (facility, mobile, park, client_home, other) and street address for card payments.', (ctx, r) => commerce.createLocation(ctx, r.body), 201],
  ['PATCH', '/v1/locations/:id', 'any', 'Point of sale', 'Update a location. Set active=false to archive it.', (ctx, r) => commerce.updateLocation(ctx, r.params.id, r.body)],
  ['GET', '/v1/readers', 'any', 'Point of sale', 'Front-desk card readers.', (ctx) => list(commerce.listReaders(ctx))],
  ['POST', '/v1/readers', 'any', 'Point of sale', 'Register a smart reader with the code on its screen: registration_code, label, location_id.', (ctx, r) => commerce.registerReader(ctx, r.body), 201],
  ['DELETE', '/v1/readers/:id', 'any', 'Point of sale', 'Remove a reader.', (ctx, r) => commerce.removeReader(ctx, r.params.id)],
  ['GET', '/v1/products', 'any', 'Point of sale', 'What you sell in person: sessions, packs, gear.', (ctx, r) => list(commerce.listProducts(ctx, { includeInactive: r.query.include_inactive === 'true' }))],
  ['POST', '/v1/products', 'any', 'Point of sale', 'Add a product: name, kind (session, pack, gear, other), price_cents, sessions (for packs).', (ctx, r) => commerce.createProduct(ctx, r.body), 201],
  ['PATCH', '/v1/products/:id', 'any', 'Point of sale', 'Update a product. Set active=false to stop selling it.', (ctx, r) => commerce.updateProduct(ctx, r.params.id, r.body)],
  ['GET', '/v1/sales', 'any', 'Point of sale', 'In-person sales, newest first. Filter with ?location_id=, ?client_id=, ?status=, ?since=.', (ctx, r) => list(commerce.listSales(ctx, { since: r.query.since ? v.date(r.query.since, 'since') : undefined, locationId: r.query.location_id, clientId: r.query.client_id, status: r.query.status }))],
  ['POST', '/v1/sales', 'any', 'Point of sale', 'Start a sale: location_id, method (tap_to_pay, reader, card_on_file, cash), items [{product_id, quantity}] and/or custom {description, amount_cents}, optional client_id, save_card, reader_id. For tap_to_pay the response includes tap_to_pay.client_secret and tap_to_pay.location_ref for the iPhone app.', (ctx, r) => commerce.createSale(ctx, r.body, r.user?.id ?? r.apiKey?.id), 201],
  ['GET', '/v1/sales/:id', 'any', 'Point of sale', 'A sale with its items.', (ctx, r) => commerce.getSale(ctx, r.params.id, { withSecret: true })],
  ['POST', '/v1/sales/:id/sync', 'any', 'Point of sale', 'Check with the payment service and record the result. The iPhone app calls this after a tap.', (ctx, r) => commerce.syncSale(ctx, r.params.id)],
  ['POST', '/v1/sales/:id/cancel', 'any', 'Point of sale', 'Cancel a payment that is still waiting for a card.', (ctx, r) => commerce.cancelSale(ctx, r.params.id)],
  ['POST', '/v1/sales/:id/refund', 'any', 'Point of sale', 'Refund a sale. Optional amount_cents for a partial refund. A full refund removes unused sessions from the pack.', (ctx, r) => commerce.refundSale(ctx, r.params.id, r.body)],
  ['POST', '/v1/sales/:id/simulate', 'any', 'Point of sale', 'Test mode only: act as the client tapping their card. outcome is approved or declined.', (ctx, r) => commerce.simulateTap(ctx, r.params.id, r.body.outcome)],
  ['POST', '/v1/terminal/connection-token', 'any', 'Point of sale', 'Connection token for the Stripe Terminal SDK in the iPhone app. Optional location_id.', (ctx, r) => commerce.connectionToken(ctx, r.body.location_id)],
  ['GET', '/v1/reports/revenue', 'any', 'Point of sale', 'Revenue by location plus membership payments since ?since= (default: start of this month).', (ctx, r) => {
    const d = new Date(); const start = new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
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
  ['GET', '/v1/families/:id', 'any', 'Families', 'A family with parents, athletes, card and waiver.', (ctx, r) => { const f = families.getFamily(ctx, r.params.id); return { ...f, athletes: f.athlete_ids.map((id) => clients.getClient(ctx, id)) }; }],
  ['PATCH', '/v1/families/:id', 'any', 'Families', 'Rename a family.', (ctx, r) => families.updateFamily(ctx, r.params.id, r.body)],
  ['POST', '/v1/families/:id/guardians', 'any', 'Families', 'Add a parent or guardian who can sign in to the portal.', (ctx, r) => families.addGuardian(ctx, r.params.id, r.body), 201],
  ['DELETE', '/v1/families/:id/guardians/:gid', 'any', 'Families', 'Remove a parent (a family keeps at least one).', (ctx, r) => families.removeGuardian(ctx, r.params.id, r.params.gid)],
  ['POST', '/v1/families/:id/athletes', 'any', 'Families', 'Add an athlete to a family: name, birth_date, sport and profile fields, optional plan_id and program_id.', (ctx, r) => clients.createClient(ctx, { ...r.body, family_id: r.params.id }), 201],
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
  ['GET', '/v1/outbox', 'session', 'Families', 'Emails the platform sent or logged, and how email is set up (mode: test, restricted or live).', (ctx) => ({ ...list(listOutbox(ctx)), mode: mailMode(ctx), from: ctx.mail?.from || null, only_to: ctx.mail?.onlyTo || null })],
  ['GET', '/v1/texts', 'session', 'Families', 'Text messages sent to parents and their replies, and how texting is set up (mode: test, restricted or live).', (ctx) => ({ ...list(sms.listTexts(ctx)), mode: sms.smsMode(ctx), only_to: ctx.sms?.onlyTo || null, kinds: sms.TEXT_KINDS })],
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

  // Schedule: classes, camps, clinics, team sessions, privates and evaluations
  ['GET', '/v1/schedule', 'any', 'Schedule', 'Sessions between ?from= and ?to= (default: next 14 days). Filter with ?kind= and ?location_id=.', (ctx, r) => {
    const from = r.query.from ? v.date(r.query.from, 'from') : new Date(Date.now() - 3600000).toISOString();
    const to = r.query.to ? v.date(r.query.to, 'to') : new Date(Date.now() + 14 * 86400000).toISOString();
    return list(schedule.listSessions(ctx, { from, to, kind: r.query.kind, locationId: r.query.location_id, includeCanceled: r.query.include_canceled === 'true' }));
  }],
  ['GET', '/v1/agenda', 'any', 'Schedule', 'One day (?date=YYYY-MM-DD, default today) with every roster.', (ctx, r) => schedule.agenda(ctx, r.query.date)],
  ['GET', '/v1/class-series', 'any', 'Schedule', 'Recurring classes, camps, clinics and team series.', (ctx, r) => list(schedule.listSeries(ctx, { kind: r.query.kind, includeInactive: r.query.include_inactive === 'true' }))],
  ['POST', '/v1/class-series', 'any', 'Schedule', 'Create a class or camp: name, kind (group, camp, clinic, team, evaluation), location_id, weekdays [0-6], start_time, duration_min, capacity, age_min, age_max, drop_in_cents, registration_cents, start_date, end_date.', (ctx, r) => schedule.createSeries(ctx, r.body), 201],
  ['GET', '/v1/class-series/:id', 'any', 'Schedule', 'A class or camp with who is enrolled.', (ctx, r) => schedule.getSeries(ctx, r.params.id)],
  ['PATCH', '/v1/class-series/:id', 'any', 'Schedule', 'Change future sessions. active=false cancels the rest (credits returned, families emailed).', (ctx, r) => schedule.updateSeries(ctx, r.params.id, r.body)],
  ['POST', '/v1/class-series/:id/enroll', 'any', 'Schedule', 'Give a member a standing spot: client_id.', (ctx, r) => schedule.enroll(ctx, r.params.id, v.str(r.body.client_id, 'client_id'), { isCoach: true })],
  ['DELETE', '/v1/class-series/:id/enroll/:client', 'any', 'Schedule', 'End a standing spot and release future bookings.', (ctx, r) => schedule.endEnrollment(ctx, r.params.id, r.params.client)],
  ['POST', '/v1/class-series/:id/register', 'any', 'Schedule', 'Register for a camp or clinic: client_id, pay (card_on_file, or omit to collect later).', (ctx, r) => schedule.registerCamp(ctx, r.params.id, v.str(r.body.client_id, 'client_id'), { pay: r.body.pay, actor: r.user?.id, isCoach: true })],
  ['POST', '/v1/sessions', 'any', 'Schedule', 'One-off session: name, kind, location_id, date, start_time, duration_min, capacity.', (ctx, r) => schedule.createSession(ctx, r.body), 201],
  ['GET', '/v1/sessions/:id', 'any', 'Schedule', 'A session with its roster and waitlist.', (ctx, r) => schedule.getSession(ctx, r.params.id)],
  ['POST', '/v1/sessions/:id/cancel', 'any', 'Schedule', 'Cancel a session: credits back, paid drop-ins refunded, families emailed. Optional reason.', (ctx, r) => schedule.cancelSession(ctx, r.params.id, { reason: v.str(r.body.reason, 'reason', { max: 200, optional: true }) })],
  ['POST', '/v1/sessions/:id/bookings', 'any', 'Schedule', 'Add an athlete: client_id, optional pay=card_on_file, override_age. Coaches can book now and collect later.', (ctx, r) => schedule.book(ctx, { sessionId: r.params.id, clientId: v.str(r.body.client_id, 'client_id'), pay: r.body.pay, actor: r.user?.id, isCoach: true, overrideAge: !!r.body.override_age }), 201],
  ['POST', '/v1/bookings/:id/cancel', 'any', 'Schedule', 'Cancel a booking. waive=true skips the late-cancel rule.', (ctx, r) => schedule.cancelBooking(ctx, r.params.id, { isCoach: true, waive: !!r.body.waive })],
  ['POST', '/v1/bookings/:id/attendance', 'any', 'Schedule', 'Roster check-in: status attended, no_show or booked.', (ctx, r) => schedule.setAttendance(ctx, r.params.id, r.body.status)],
  ['POST', '/v1/bookings/:id/pay', 'any', 'Schedule', 'Collect for an unpaid booking: method (card_on_file, cash, tap_to_pay, reader), reader_id.', (ctx, r) => schedule.payBooking(ctx, r.params.id, r.body, r.user?.id)],
  ['GET', '/v1/clients/:id/bookings', 'any', 'Schedule', 'A client\'s upcoming bookings (?past=true for history).', (ctx, r) => list(schedule.clientBookings(ctx, r.params.id, { upcoming: r.query.past !== 'true' }))],
  ['GET', '/v1/availability', 'any', 'Schedule', 'Your hours for privates and evaluations.', (ctx) => list(schedule.listAvailability(ctx))],
  ['POST', '/v1/availability', 'any', 'Schedule', 'Add hours: kind (private or evaluation), location_id, weekday, start_time, end_time, slot_minutes, price_cents.', (ctx, r) => schedule.addAvailability(ctx, r.body), 201],
  ['DELETE', '/v1/availability/:id', 'any', 'Schedule', 'Remove hours.', (ctx, r) => schedule.removeAvailability(ctx, r.params.id)],
  ['GET', '/v1/slots', 'any', 'Schedule', 'Open private or evaluation times (?kind=, ?days=).', (ctx, r) => list(schedule.openSlots(ctx, { kind: r.query.kind === 'evaluation' ? 'evaluation' : 'private', days: v.int(r.query.days ?? 14, 'days', { min: 1, max: 60 }) }))],
  ['POST', '/v1/slots/book', 'any', 'Schedule', 'Book an open slot: kind, starts_at, availability_id, client_id, optional pay.', (ctx, r) => schedule.bookSlot(ctx, { kind: r.body.kind, startsAt: v.str(r.body.starts_at, 'starts_at'), availabilityId: v.str(r.body.availability_id, 'availability_id'), clientId: v.str(r.body.client_id, 'client_id'), pay: r.body.pay, actor: r.user?.id, isCoach: true }), 201],

  // Team contracts: schools and clubs billed a monthly fee
  ['GET', '/v1/organizations', 'any', 'Teams', 'Schools and clubs.', (ctx) => list(teams.listOrgs(ctx))],
  ['POST', '/v1/organizations', 'any', 'Teams', 'Add a school or club: name, kind (school, club, other), contact_name, contact_email (receives invoices), contact_phone, billing_address.', (ctx, r) => teams.createOrg(ctx, r.body), 201],
  ['PATCH', '/v1/organizations/:id', 'any', 'Teams', 'Update a school or club, including the billing contact.', (ctx, r) => teams.updateOrg(ctx, r.params.id, r.body)],
  ['GET', '/v1/team-contracts', 'any', 'Teams', 'Every team contract with its balance and next invoice date.', (ctx) => list(teams.listContracts(ctx))],
  ['POST', '/v1/team-contracts', 'any', 'Teams', 'New contract: org_id (or organization {...}), name, monthly_cents, start_date, end_date, terms_days (default 30), po_number. The first month is invoiced right away if it has started.', (ctx, r) => teams.createContract(ctx, r.body, r.baseUrl), 201],
  ['GET', '/v1/team-contracts/:id', 'any', 'Teams', 'A contract with its roster, attendance, sessions and invoices.', (ctx, r) => teams.getContract(ctx, r.params.id, r.baseUrl)],
  ['PATCH', '/v1/team-contracts/:id', 'any', 'Teams', 'Change the fee (applies from the next invoice), dates, terms or PO. status=ended stops invoicing and cancels future team sessions.', (ctx, r) => teams.updateContract(ctx, r.params.id, r.body, { archiveSeries: (id) => schedule.updateSeries(ctx, id, { active: false }) })],
  ['POST', '/v1/team-contracts/:id/roster', 'any', 'Teams', 'Add athletes: name, position, grad_year, or names (one per line: "Name, position, grad year").', (ctx, r) => list(teams.addRoster(ctx, r.params.id, r.body)), 201],
  ['DELETE', '/v1/team-contracts/:id/roster/:rid', 'any', 'Teams', 'Remove an athlete from the roster.', (ctx, r) => list(teams.removeRoster(ctx, r.params.id, r.params.rid))],
  ['POST', '/v1/team-contracts/:id/sessions', 'any', 'Teams', 'Put this team on the schedule: location_id, weekdays, start_time, duration_min, start_date, end_date.', async (ctx, r) => {
    const c = teams.getContract(ctx, r.params.id);
    return schedule.createSeries(ctx, { ...r.body, kind: 'team', contract_id: c.id, name: r.body.name ?? `${c.org.name} ${c.name}`, capacity: Math.max(c.roster.length, 1, v.int(r.body.capacity ?? 1, 'capacity', { min: 1, max: 500 })), end_date: r.body.end_date ?? c.end_date ?? undefined });
  }, 201],
  ['POST', '/v1/team-contracts/:id/invoices', 'any', 'Teams', 'One-off invoice: description and amount_cents (or lines [...]). Emailed unless send=false.', (ctx, r) => teams.createOneOffInvoice(ctx, r.params.id, r.body, r.baseUrl), 201],
  ['POST', '/v1/sessions/:id/team-attendance', 'any', 'Teams', 'Team session check-in: roster_id, present (true/false).', (ctx, r) => teams.setTeamAttendance(ctx, schedule.getSession(ctx, r.params.id), v.str(r.body.roster_id, 'roster_id'), r.body.present !== false)],
  ['GET', '/v1/team-invoices', 'any', 'Teams', 'Team invoices. ?status=open, overdue, unpaid, paid or void.', (ctx, r) => list(teams.listInvoices(ctx, { status: r.query.status }, r.baseUrl))],
  ['GET', '/v1/team-invoices/:id', 'any', 'Teams', 'One invoice with its public link.', (ctx, r) => teams.getInvoice(ctx, r.params.id, r.baseUrl)],
  ['POST', '/v1/team-invoices/:id/send', 'any', 'Teams', 'Email (or re-email) the invoice to the billing contact.', (ctx, r) => teams.sendInvoice(ctx, r.params.id, r.baseUrl)],
  ['POST', '/v1/team-invoices/:id/payments', 'any', 'Teams', 'Record a payment: method (check, ach, card, cash, online, other), reference (check number), paid_on.', (ctx, r) => teams.recordPayment(ctx, r.params.id, r.body, r.baseUrl)],
  ['POST', '/v1/team-invoices/:id/void', 'any', 'Teams', 'Void an unpaid invoice.', (ctx, r) => teams.voidInvoice(ctx, r.params.id, r.baseUrl)],
  ['POST', '/v1/team-billing/run', 'session', 'Teams', 'Run team invoicing and reminders now (also runs every hour).', (ctx, r) => teams.runTeamBilling(ctx, { baseUrl: r.baseUrl })],
  ['GET', '/invoice-api/:token', 'public', 'Teams', 'Public invoice for the school or club (the link in the email).', (ctx, r) => teams.publicInvoice(ctx, r.params.token)],
  ['POST', '/invoice-api/:token/checkout', 'public', 'Teams', 'Start online payment by card or bank account.', (ctx, r) => teams.checkoutForInvoice(ctx, r.params.token, r.baseUrl)],
  ['POST', '/invoice-api/:token/simulate', 'public', 'Teams', 'Test mode only: mark the invoice paid online.', (ctx, r) => teams.simulateInvoicePaid(ctx, r.params.token)],

  // Performance testing
  ['GET', '/v1/tests', 'any', 'Performance', 'The test library: every test with its metrics, units and whether lower or higher is better. ?include_inactive=true shows hidden tests.', (ctx, r) => ({ data: perf.listTests(ctx, { includeInactive: r.query.include_inactive === 'true' }), categories: perf.CATEGORIES.map(([key, name]) => ({ key, name })) })],
  ['POST', '/v1/tests', 'any', 'Performance', 'Add your own test: name, category, unit and better (lower or higher), or metrics [{key, name, unit, better}]; sides (none or lr); attempts.', (ctx, r) => perf.createTest(ctx, r.body), 201],
  ['GET', '/v1/tests/:key', 'any', 'Performance', 'One test by key (e.g. dash_40yd, cmj, imtp).', (ctx, r) => perf.getTest(ctx, r.params.key)],
  ['PATCH', '/v1/tests/:key', 'any', 'Performance', 'Rename, change attempts, or hide a test (active=false).', (ctx, r) => perf.updateTest(ctx, r.params.key, r.body)],
  ['POST', '/v1/results', 'any', 'Performance', 'Record results from any device or app. Body: {results: [{athlete: {client_id | roster_id | email | external_id + name}, test, metric, value, unit, side, attempt, recorded_at, timing, device, external_id}], provider, session_id}. Values in other units are converted. Sending the same external_id again is ignored, so retries are safe. Up to 1,000 per request.', (ctx, r) => {
    const items = Array.isArray(r.body.results) ? r.body.results : [r.body];
    const provider = r.body.provider ? v.str(r.body.provider, 'provider', { max: 40 }).toLowerCase() : null;
    return perf.recordResults(ctx, items, { source: r.body.source ?? (provider ? `api:${provider}` : r.apiKey ? 'api' : 'manual'), provider, sessionId: r.body.session_id ?? null });
  }, 201],
  ['GET', '/v1/results', 'any', 'Performance', 'Results, newest first. Filter with ?client_id, roster_id, session_id, test, source, from, to, limit.', (ctx, r) => list(perf.listResults(ctx, r.query))],
  ['DELETE', '/v1/results/:id', 'any', 'Performance', 'Remove a mistaken result.', (ctx, r) => perf.voidResult(ctx, r.params.id)],
  ['GET', '/v1/clients/:id/performance', 'any', 'Performance', 'A client\'s results per test: best, first, latest, change and history.', (ctx, r) => list(perf.athleteProfile(ctx, { client_id: r.params.id }))],
  ['GET', '/v1/roster/:id/performance', 'any', 'Performance', 'A team roster athlete\'s results per test.', (ctx, r) => list(perf.athleteProfile(ctx, { roster_id: r.params.id }))],
  ['GET', '/v1/testing-sessions', 'any', 'Performance', 'Testing days, newest first.', (ctx) => list(perf.listSessions(ctx))],
  ['POST', '/v1/testing-sessions', 'any', 'Performance', 'Plan a testing day: name, date, tests [keys], athletes [{client_id} | {roster_id}], or contract_id to bring in a team roster.', (ctx, r) => perf.createSession(ctx, r.body), 201],
  ['GET', '/v1/testing-sessions/:id', 'any', 'Performance', 'A testing day with every athlete\'s results.', (ctx, r) => perf.getSession(ctx, r.params.id)],
  ['PATCH', '/v1/testing-sessions/:id', 'any', 'Performance', 'Change the name, date, tests or athletes.', (ctx, r) => perf.updateSession(ctx, r.params.id, r.body)],
  ['POST', '/v1/testing-sessions/:id/share', 'any', 'Performance', 'Share a testing day with families: results appear in the parent portal and parents are emailed. Optional parent_note; notify=false to skip emails.', (ctx, r) => reports.shareSession(ctx, r.params.id, r.body, r.baseUrl)],
  ['DELETE', '/v1/testing-sessions/:id/share', 'any', 'Performance', 'Hide a testing day from families again.', (ctx, r) => reports.unshareSession(ctx, r.params.id)],
  ['GET', '/v1/clients/:id/report', 'any', 'Performance', 'Progress report: best, first and latest for every test, top improvements, growth and growth-spurt estimate. ?parent_view=true shows exactly what the family sees.', (ctx, r) => reports.athleteReport(ctx, r.params.id, { parentView: r.query.parent_view === 'true' })],
  ['GET', '/v1/athlete-links', 'any', 'Performance', 'Device IDs and names you\'ve linked to athletes (?provider=, ?client_id=, ?roster_id=).', (ctx, r) => list(perf.listLinks(ctx, r.query))],
  ['GET', '/v1/queue', 'any', 'Performance', 'Results waiting to be linked to a profile, grouped by who sent them. Results only land automatically by Athlete ID or a link you confirmed.', (ctx) => ({ data: queue.listQueue(ctx), ...queue.queueCount(ctx) })],
  ['POST', '/v1/queue/link', 'any', 'Performance', 'Link waiting results to an athlete: athlete_id (or client_id / roster_id), and either provider + identity (everything from that sender) or ids [specific results]. remember=true sends that sender\'s future results straight to the athlete. All or nothing.', (ctx, r) => queue.linkQueue(ctx, r.body)],
  ['POST', '/v1/queue/discard', 'any', 'Performance', 'Throw away waiting results: provider + identity, or ids.', (ctx, r) => queue.discardQueue(ctx, r.body)],
  ['POST', '/v1/athlete-links', 'any', 'Performance', 'Link a device athlete ID to one of ours ahead of time: provider, external_id, external_name, client_id or roster_id.', (ctx, r) => perf.linkAthlete(ctx, r.body), 201],
  ['DELETE', '/v1/athlete-links/:provider/:external', 'any', 'Performance', 'Remove a link.', (ctx, r) => perf.unlinkAthlete(ctx, r.params.provider, decodeURIComponent(r.params.external))],
  ['GET', '/v1/uploads/template', 'any', 'Performance', 'Download a results template (Excel by default, ?format=csv) with every athlete\'s ID filled in. Choose ?tests=dash_40yd,broad_jump and athletes with ?session_id, ?contract_id or ?client_ids.', (ctx, r) => ({ __file: uploads.buildTemplate(ctx, r.query) })],
  ['POST', '/v1/uploads/preview', 'any', 'Performance', 'Check a filled-in sheet (csv, or xlsx_base64 for Excel; optional session_id, date, test). Every row needs a real Athlete ID, every column a known test, every value a possible number. Returns ok=false with every problem (row, column, message) if anything is wrong, and the unusual values to confirm. Nothing is saved.', (ctx, r) => uploads.previewUpload(ctx, r.body)],
  ['POST', '/v1/uploads/commit', 'any', 'Performance', 'Save a checked upload: preview_id, confirm [warning keys]. All or nothing: the sheet is checked again, and if any problem remains or a warning isn\'t confirmed, nothing is saved.', (ctx, r) => uploads.commitUpload(ctx, r.body), 201],
  ['GET', '/v1/integrations', 'any', 'Performance', 'Timing and measurement systems: which are connected, last sync, saved file layouts.', (ctx) => list(perfImport.listIntegrations(ctx))],
  ['POST', '/v1/imports', 'any', 'Performance', 'Import a CSV export: provider (ovr, vald, swift, freelap, generic …), csv (the file\'s text), optional test (if the file holds one test), mapping, session_id. dry_run=true returns the column matches and preview without saving.', (ctx, r) => perfImport.importFile(ctx, r.body), 201],
  ['GET', '/v1/imports', 'any', 'Performance', 'Recent imports, with athletes still waiting to be matched.', (ctx) => list(perfImport.listBatches(ctx))],
  ['GET', '/v1/imports/:id', 'any', 'Performance', 'One import.', (ctx, r) => perfImport.getBatch(ctx, r.params.id)],
  ['PUT', '/v1/integrations/hawkin', 'session', 'Performance', 'Connect Hawkin Dynamics: refresh_token (integration token), region (americas, europe, apac), backfill_days (default 90).', (ctx, r) => perfImport.connectHawkin(ctx, r.body)],
  ['POST', '/v1/integrations/hawkin/sync', 'any', 'Performance', 'Pull new Hawkin tests now (also runs every 15 minutes).', (ctx) => perfImport.syncHawkin(ctx)],
  ['DELETE', '/v1/integrations/:provider', 'session', 'Performance', 'Disconnect a system.', (ctx, r) => perfImport.disconnect(ctx, r.params.provider)],

  // Staff, security and backups (owner only)
  ['GET', '/v1/staff', 'session', 'Admin', 'Staff accounts and their roles.', (ctx) => ({ data: security.listStaff(ctx), roles: security.ROLES })],
  ['POST', '/v1/staff', 'session', 'Admin', 'Add a staff member: name, email, role (owner, coach, front_desk). Returns a one-time password, also emailed.', (ctx, r) => security.addStaff(ctx, r.body, r.baseUrl), 201],
  ['PATCH', '/v1/staff/:id', 'session', 'Admin', 'Change role, rename, turn an account off (active=false) or unlock it (unlock=true).', (ctx, r) => security.updateStaff(ctx, r.params.id, r.body, r.user)],
  ['POST', '/v1/staff/:id/reset-password', 'session', 'Admin', 'Give a staff member a new one-time password.', (ctx, r) => security.resetStaffPassword(ctx, r.params.id, r.baseUrl)],
  ['GET', '/v1/audit', 'session', 'Admin', 'Every change and sign-in: who, what, when, from where. ?actor_id, ?target, ?failures=true, ?limit.', (ctx, r) => list(security.listAudit(ctx, r.query).map((a) => ({ ...a, description: describeAction(a.action) })))],
  ['GET', '/v1/backups', 'session', 'Admin', 'Database backups (one a day, the last 30 kept).', (ctx) => ({ data: backups.listBackups(ctx), dir: backups.backupDir(ctx) })],
  ['POST', '/v1/backups', 'session', 'Admin', 'Make a backup now.', (ctx) => backups.createBackup(ctx), 201],
  ['GET', '/v1/backups/:name', 'session', 'Admin', 'Download a backup file.', (ctx, r) => ({ __file: backups.backupFile(ctx, r.params.name) })],

  // Integrations (coach login only)
  ['GET', '/v1/api-keys', 'session', 'Integrations', 'List API keys.', (ctx) => list(access.listApiKeys(ctx))],
  ['POST', '/v1/api-keys', 'session', 'Integrations', 'Create an API key. The full key is shown once.', (ctx, r) => access.createApiKey(ctx, r.body), 201],
  ['POST', '/v1/api-keys/:id/revoke', 'session', 'Integrations', 'Revoke a key immediately.', (ctx, r) => access.revokeApiKey(ctx, r.params.id)],
  ['GET', '/v1/webhooks', 'session', 'Integrations', 'List webhook endpoints.', (ctx) => list(events.listEndpoints(ctx))],
  ['POST', '/v1/webhooks', 'session', 'Integrations', 'Add an endpoint: url and events (or ["*"]).', (ctx, r) => events.createEndpoint(ctx, r.body), 201],
  ['PATCH', '/v1/webhooks/:id', 'session', 'Integrations', 'Change url, events or active.', (ctx, r) => events.updateEndpoint(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/webhooks/:id', 'session', 'Integrations', 'Delete an endpoint.', (ctx, r) => events.deleteEndpoint(ctx, r.params.id)],
  ['GET', '/v1/webhooks/:id/deliveries', 'session', 'Integrations', 'Recent delivery attempts for an endpoint.', (ctx, r) => list(events.listDeliveries(ctx, r.params.id))],
  ['GET', '/v1/event-types', 'any', 'Integrations', 'Every event type a webhook can subscribe to.', () => list(events.EVENT_TYPES)],

  // Accountability, performance targets and education. Owners and coaches manage; front desk views.
  ['GET', '/v1/clients/:id/engagement', 'any', 'Engagement', 'Accountability for one athlete: streaks, this week, 30-day check-in averages and flags, goals, messages, test targets, rankings and assigned reading.', (ctx, r) => engage.staffOverview(ctx, clients.getClient(ctx, r.params.id).id)],
  ['POST', '/v1/clients/:id/goals', 'any', 'Engagement', 'Set a weekly goal: kind (workouts, sessions, checkins, custom), target (1-14 a week), optional title.', (ctx, r) => engage.createGoal(ctx, { clientId: clients.getClient(ctx, r.params.id).id }, r.body, r.user ?? r.apiKey), 201],
  ['POST', '/v1/clients/:id/messages', 'any', 'Engagement', 'Send the athlete a message: body. The athlete and their parents are emailed a copy.', (ctx, r) => engage.sendMessage(ctx, { clientId: clients.getClient(ctx, r.params.id).id }, r.body, r.user ?? r.apiKey), 201],
  ['POST', '/v1/clients/:id/targets', 'any', 'Engagement', 'Set a test target: test (key), target (like 84, 6\'5" or 1:05), optional due_date. Replaces an existing target for that test.', (ctx, r) => engage.setTarget(ctx, clients.getClient(ctx, r.params.id).id, r.body, r.user ?? r.apiKey), 201],
  ['DELETE', '/v1/targets/:id', 'any', 'Engagement', 'Remove a test target. Results stay.', (ctx, r) => engage.removeTarget(ctx, r.params.id)],
  ['PATCH', '/v1/goals/:id', 'any', 'Engagement', 'Change a goal\'s title or target, or end it with active=false.', (ctx, r) => engage.updateGoal(ctx, r.params.id, r.body)],
  ['GET', '/v1/teams', 'any', 'Engagement', 'Active teams for goals, messages and assigned reading (names and roster counts only).', (ctx) => list(engage.listTeams(ctx))],
  ['GET', '/v1/teams/:id/engagement', 'any', 'Engagement', 'A team\'s goals, messages and assigned reading, and which roster athletes have the app.', (ctx, r) => engage.teamEngagement(ctx, r.params.id)],
  ['POST', '/v1/teams/:id/goals', 'any', 'Engagement', 'Set a weekly goal for everyone on the roster: kind, target, optional title.', (ctx, r) => engage.createGoal(ctx, { contractId: r.params.id }, r.body, r.user ?? r.apiKey), 201],
  ['POST', '/v1/teams/:id/messages', 'any', 'Engagement', 'Message the whole roster: body. Athletes and parents are emailed.', (ctx, r) => engage.sendMessage(ctx, { contractId: r.params.id }, r.body, r.user ?? r.apiKey), 201],
  ['GET', '/v1/daily-check-ins/flags', 'any', 'Engagement', 'Athletes whose latest daily check-in (today or yesterday) needs a look: short sleep, high soreness, low energy, mood or hydration.', (ctx) => list(engage.recentFlags(ctx))],
  ['GET', '/v1/engagement/settings', 'any', 'Engagement', 'Whether rankings are on.', (ctx) => ({ rankings: engage.rankingsOn(ctx) ? 'on' : 'off' })],
  ['PATCH', '/v1/engagement/settings', 'any', 'Engagement', 'Turn rankings on or off: rankings ("on" or "off"). Athletes and parents see where a best result ranks, never anyone else\'s name.', (ctx, r) => engage.setRankings(ctx, r.body)],
  ['GET', '/v1/education', 'any', 'Education', 'Every course and lesson with completions, and each assignment with who has finished.', (ctx) => engage.educationReport(ctx)],
  ['GET', '/v1/lessons/:id', 'any', 'Education', 'One lesson with its full text.', (ctx, r) => engage.getLesson(ctx, r.params.id)],
  ['POST', '/v1/lessons', 'any', 'Education', 'Post a lesson: title, summary, body (plain text; blank lines start paragraphs), video_url (https), minutes, course_id, published.', (ctx, r) => engage.createLesson(ctx, r.body), 201],
  ['PATCH', '/v1/lessons/:id', 'any', 'Education', 'Edit a lesson. published=false hides it from athletes.', (ctx, r) => engage.updateLesson(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/lessons/:id', 'any', 'Education', 'Delete a lesson and its completions.', (ctx, r) => engage.deleteLesson(ctx, r.params.id)],
  ['POST', '/v1/courses', 'any', 'Education', 'Create a course: title, description, published.', (ctx, r) => engage.createCourse(ctx, r.body), 201],
  ['PATCH', '/v1/courses/:id', 'any', 'Education', 'Edit a course. published=false hides it from athletes.', (ctx, r) => engage.updateCourse(ctx, r.params.id, r.body)],
  ['DELETE', '/v1/courses/:id', 'any', 'Education', 'Delete a course. Its lessons stay in the library.', (ctx, r) => engage.deleteCourse(ctx, r.params.id)],
  ['PUT', '/v1/courses/:id/order', 'any', 'Education', 'Reorder a course\'s lessons: lesson_ids in the new order.', (ctx, r) => engage.reorderCourse(ctx, r.params.id, r.body)],
  ['POST', '/v1/lesson-assignments', 'any', 'Education', 'Assign reading: lesson_id or course_id, to client_id or a team (contract_id), optional due_date and note. The athletes and their parents are emailed.', (ctx, r) => engage.assign(ctx, r.body, r.user ?? r.apiKey), 201],
  ['DELETE', '/v1/lesson-assignments/:id', 'any', 'Education', 'Remove an assignment. Completed lessons stay completed.', (ctx, r) => engage.unassign(ctx, r.params.id)],

  // Client app (authenticated by the client's private link token)
  ['GET', '/app/api/home', 'client', 'Client app', 'The client\'s next workout and progress.', (ctx, r) => programs.clientHome(ctx, r.client)],
  ['POST', '/app/api/workouts/:id/complete', 'client', 'Client app', 'Log a finished workout with exercise_ids done and optional notes.', (ctx, r) => programs.completeWorkout(ctx, r.client, r.params.id, r.body), 201],
  ['GET', '/app/api/engage', 'client', 'Client app', 'Accountability, performance and education for the athlete.', (ctx, r) => engage.athleteView(ctx, r.client.id, { parentView: true })],
  ['POST', '/app/api/daily-check-in', 'client', 'Client app', 'Today\'s check-in: sleep_hours (0-16), hydration, soreness, energy, mood (1-5), note. Saving again today updates it.', (ctx, r) => engage.saveCheckin(ctx, r.client.id, r.body)],
  ['POST', '/app/api/goals/:id/check', 'client', 'Client app', 'Tick a custom goal for today (done=false to untick).', (ctx, r) => engage.checkGoal(ctx, r.client.id, r.params.id, r.body.done !== false)],
  ['POST', '/app/api/messages/read', 'client', 'Client app', 'Mark coach messages read.', (ctx, r) => engage.markRead(ctx, r.client.id)],
  ['GET', '/app/api/lessons/:id', 'client', 'Client app', 'Read a lesson.', (ctx, r) => engage.lessonFor(ctx, r.client.id, r.params.id)],
  ['POST', '/app/api/lessons/:id/complete', 'client', 'Client app', 'Mark a lesson done (done=false to undo).', (ctx, r) => engage.completeLesson(ctx, r.client.id, r.params.id, r.body.done !== false)],
  ...portalRoutes.map(([method, path, auth, summary, handler, status]) => [method, path, auth, 'Parent portal', summary, handler, status])
].map(([method, path, auth, tag, summary, handler, status = 200]) => ({
  method, path, auth, tag, summary, handler, status,
  regex: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$')
}));

export function openApiSpec(baseUrl) {
  const paths = {};
  for (const r of routes) {
    if (r.path.startsWith('/app/') || r.path.startsWith('/auth/') || r.path.startsWith('/portal/') || r.path.startsWith('/invoice-api/')) continue;
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
const SPECIAL = { 'sign-in': 'Signed in', 'POST /portal/api/login': 'Parent asked for a sign-in code', 'POST /portal/api/verify': 'Parent signed in', 'POST /auth/logout': 'Signed out', 'POST /portal/api/logout': 'Parent signed out' };
function describeAction(action) {
  if (SPECIAL[action]) return SPECIAL[action];
  const [method, path] = action.split(' ');
  const r = routes.find((x) => x.method === method && x.path === path);
  return r ? r.summary.split(/[:.(]/)[0].trim() : action;
}
