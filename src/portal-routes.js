// Parent portal API. Every route is scoped to the signed-in parent's family.
import * as families from './services/families.js';
import * as schedule from './services/schedule.js';
import * as commerce from './services/commerce.js';
import * as billing from './services/billing.js';
import * as clients from './services/clients.js';
import { v, notFound, conflict, badRequest, newId, ageOn, zonedToUtc, localDate, addDaysToDate } from './util.js';
import * as reports from './services/reports.js';
import * as legal from './services/legal.js';
import * as checkin from './services/checkin.js';
import * as booknow from './services/booknow.js';
import * as signup from './services/signup.js';
import * as engage from './services/engage.js';
import * as sms from './services/sms.js';
import * as leads from './services/leads.js';
import * as shop from './services/shop.js';
import * as spots from './services/spots.js';

const list = (data) => ({ data });
function athleteOf(ctx, r, id) {
  const c = ctx.db.get('SELECT * FROM clients WHERE id = ? AND family_id = ?', v.str(id, 'athlete_id'), r.guardian.family_id);
  if (!c) throw notFound('Athlete');
  return c;
}
function requireWaiver(ctx, r) {
  legal.requireAgreements(ctx, r.guardian);
  if (!families.getFamily(ctx, r.guardian.family_id).waiver.signed) throw conflict('Sign the waiver on the Family tab before booking.');
}
const familyPayer = (ctx, r) => commerce.payerById(ctx, 'families', r.guardian.family_id);
function athleteSummary(ctx, id) {
  const c = clients.getClient(ctx, id);
  return {
    id: c.id, athlete_id: c.athlete_id, name: c.name, first_name: c.name.split(' ')[0], birth_date: c.birth_date, age: ageOn(c.birth_date, ctx.now()),
    sport: c.sport, position: c.position, school: c.school, grad_year: c.grad_year, medical_notes: c.medical_notes,
    emergency_name: c.emergency_name, emergency_phone: c.emergency_phone,
    membership: c.subscription && c.subscription.status !== 'canceled' ? { status: c.subscription.status, plan_name: c.subscription.plan_name, price_cents: c.subscription.price_cents, renews: c.subscription.current_period_end } : null,
    credits: c.credits, program: c.program, app_link: c.app_link, engagement: engage.badges(ctx, id),
    upcoming: schedule.clientBookings(ctx, id, { upcoming: true, limit: 20 }),
    enrollments: ctx.db.all(`SELECT e.series_id, e.kind, s.name FROM enrollments e JOIN class_series s ON s.id = e.series_id WHERE e.client_id = ? AND e.status = 'active'`, id)
  };
}

export const portalRoutes = [
  ['POST', '/portal/api/login', 'public', 'Email a 6-digit sign-in code.', (ctx, r) => families.requestCode(ctx, r.body)],
  ['GET', '/portal/api/public/info', 'public', 'Business name, whether sign-up is open, and whether terms and privacy are published.', (ctx) => signup.signupInfo(ctx)],
  ['POST', '/portal/api/public/inquiry', 'public', 'Ask about training: parent_name, email, phone, athlete_name, athlete_age, sport, message, texts_ok. We reply by email with next steps.', (ctx, r) => leads.submitInquiry(ctx, r.body)],
  ['GET', '/portal/api/public/certificates/:token', 'public', 'A course certificate for its shareable page: athlete name, course, lessons and date. Nothing else.', (ctx, r) => engage.publicCertificate(ctx, r.params.token)],
  ['GET', '/portal/api/public/spot/:token', 'public', 'An open-spot offer: the session, how many spots are left, and the family\'s athletes who fit. No sign-in.', (ctx, r) => spots.publicOffer(ctx, r.params.token)],
  ['POST', '/portal/api/public/spot/:token/book', 'public', 'Book from an open-spot offer: athlete_id, optional pay=card_on_file. First to book gets the spot.', (ctx, r) => spots.bookOffer(ctx, r.params.token, r.body)],
  ['GET', '/portal/api/public/shop', 'public', 'The online store page: programs and courses for sale with prices and what\'s inside. No names.', (ctx) => shop.publicShop(ctx)],
  ['GET', '/portal/api/public/schedule', 'public', 'The Book now page: classes, clinics and camp days in the next 2 weeks with open spots, and the next evaluation times. No names.', (ctx) => booknow.publicSchedule(ctx)],
  ['GET', '/portal/api/public/legal', 'public', 'The current terms of service and privacy policy.', (ctx) => legal.legalDocs(ctx)],
  ['POST', '/portal/api/signup', 'public', 'New family: parent {name, email, phone}, athletes [{name, birth_date, sex, sport, school, medical_notes, emergency_name, emergency_phone}], accept_terms=true. Emails a code.', (ctx, r) => signup.startSignup(ctx, r.body, r.ip)],
  ['POST', '/portal/api/signup/verify', 'public', 'Finish sign-up with signup_id and the emailed code. Creates the family and signs the parent in.', (ctx, r) => signup.finishSignup(ctx, r.body, r.ip)],
  ['POST', '/portal/api/agreements', 'guardian', 'Accept the current terms of service and privacy policy: accept=true.', (ctx, r) => { if (r.body.accept !== true) throw badRequest('Tick the box to accept.'); return legal.recordConsent(ctx, r.guardian, { ip: r.ip }); }],
  ['GET', '/portal/api/export', 'guardian', 'Download everything we hold about your family, as a file.', (ctx, r) => ({ __file: { filename: `family-data-${new Date().toISOString().slice(0, 10)}.json`, type: 'application/json', body: Buffer.from(JSON.stringify(legal.exportFamily(ctx, r.guardian.family_id), null, 2)) } })],
  ['POST', '/portal/api/deletion-request', 'guardian', 'Ask for your family\'s account and data to be deleted. Optional note.', (ctx, r) => legal.requestDeletion(ctx, r.guardian, r.body), 201],
  ['POST', '/portal/api/verify', 'public', 'Exchange the code for a session.', (ctx, r) => families.verifyCode(ctx, r.body)],
  ['PATCH', '/portal/api/texts', 'guardian', 'Turn text messages on or off: texts (true or false), phone (your mobile number, needed to turn them on).', (ctx, r) => sms.setTextPrefs(ctx, r.guardian, r.body)],
  ['GET', '/portal/api/check-in', 'guardian', 'From the door QR code (?code=): your athletes booked at that location with check-in open now.', (ctx, r) => checkin.familyCheckIns(ctx, r.guardian.family_id, r.query.code)],
  ['POST', '/portal/api/check-in', 'guardian', 'Check in at the door: code, and booking_id (or none to check in everyone booked there now).', (ctx, r) => checkin.familyCheckIn(ctx, r.guardian.family_id, r.body)],
  ['POST', '/portal/api/logout', 'guardian', 'Sign out.', (ctx, r) => { families.portalLogout(ctx, r.familyToken); return { ok: true }; }],

  ['GET', '/portal/api/me', 'guardian', 'Family, athletes, card, waiver.', (ctx, r) => {
    const fam = families.getFamily(ctx, r.guardian.family_id);
    const settings = families.getSettings(ctx);
    const agreements = legal.consentStatus(ctx, r.guardian.id);
    return {
      guardian: { id: r.guardian.id, name: r.guardian.name, email: r.guardian.email, phone: r.guardian.phone, texts: sms.textStatus(r.guardian) },
      agreements, open_deletion_request: !!ctx.db.get(`SELECT 1 FROM data_requests WHERE family_id = ? AND kind = 'delete' AND status = 'open'`, r.guardian.family_id),
      family: fam, athletes: fam.athlete_ids.map((id) => athleteSummary(ctx, id)),
      waiver_text: settings.waiver_text, late_cancel_hours: Number(settings.late_cancel_hours), business_name: settings.business_name, timezone: settings.timezone,
      payments: { can_simulate: !!ctx.payments.simulate, provider: ctx.payments.name }
    };
  }],
  ['GET', '/portal/api/schedule', 'guardian', 'Upcoming classes, clinics and camp days for the next 3 weeks with each athlete\'s status.', (ctx, r) => {
    const zone = families.getSetting(ctx, 'timezone');
    const from = new Date().toISOString(), to = zonedToUtc(addDaysToDate(localDate(from, zone), 22), '00:00', zone);
    const kids = ctx.db.all('SELECT id, name, birth_date FROM clients WHERE family_id = ?', r.guardian.family_id);
    const mine = ctx.db.all(`SELECT b.id, b.session_id, b.client_id, b.status FROM bookings b JOIN clients c ON c.id = b.client_id WHERE c.family_id = ? AND b.status IN ('booked','waitlisted','attended')`, r.guardian.family_id);
    return list(schedule.listSessions(ctx, { from, to }).filter((s) => ['group', 'clinic', 'camp'].includes(s.kind)).map((s) => ({
      id: s.id, name: s.name, kind: s.kind, starts_at: s.starts_at, ends_at: s.ends_at, location_name: s.location_name, spots_left: s.spots_left, capacity: s.capacity,
      age_min: s.age_min, age_max: s.age_max, drop_in_cents: s.drop_in_cents, series_id: s.series_id, registration_only: s.registration_cents != null && s.drop_in_cents == null,
      athletes: kids.map((k) => {
        const age = ageOn(k.birth_date, s.starts_at), b = mine.find((m) => m.session_id === s.id && m.client_id === k.id);
        return { id: k.id, eligible: age == null || ((s.age_min == null || age >= s.age_min) && (s.age_max == null || age <= s.age_max)), booking_id: b?.id ?? null, status: b?.status ?? null };
      })
    })));
  }],
  ['POST', '/portal/api/bookings', 'guardian', 'Book a session: session_id, athlete_id, optional pay=card_on_file.', async (ctx, r) => {
    requireWaiver(ctx, r);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    return schedule.book(ctx, { sessionId: v.str(r.body.session_id, 'session_id'), clientId: c.id, pay: r.body.pay, actor: r.guardian.id });
  }],
  ['POST', '/portal/api/bookings/:id/cancel', 'guardian', 'Cancel a booking.', async (ctx, r) => {
    const b = schedule.bookingDetail(ctx, r.params.id);
    athleteOf(ctx, r, b.client_id);
    return schedule.cancelBooking(ctx, b.id);
  }],
  ['GET', '/portal/api/programs', 'guardian', 'Group classes (standing spots for members) and camps/clinics open for registration.', (ctx) => list(
    schedule.listSeries(ctx).filter((s) => ['group', 'camp', 'clinic'].includes(s.kind)).map((s) => ({
      id: s.id, name: s.name, kind: s.kind, description: s.description, location_name: s.location_name, weekdays: s.weekdays, start_time: s.start_time, duration_min: s.duration_min,
      age_min: s.age_min, age_max: s.age_max, start_date: s.start_date, end_date: s.end_date, registration_cents: s.registration_cents, drop_in_cents: s.drop_in_cents,
      capacity: s.capacity, enrolled_count: s.enrolled_count
    })).filter((s) => s.kind === 'group' || (s.registration_cents != null && s.end_date >= localDate(new Date().toISOString(), families.getSetting(ctx, 'timezone')))))],
  ['POST', '/portal/api/programs/:id/enroll', 'guardian', 'Standing spot in a group class (members) or registration for a camp or clinic.', async (ctx, r) => {
    requireWaiver(ctx, r);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    const s = schedule.getSeries(ctx, r.params.id);
    return s.kind === 'group' ? schedule.enroll(ctx, s.id, c.id) : schedule.registerCamp(ctx, s.id, c.id, { pay: 'card_on_file', actor: r.guardian.id });
  }],
  ['DELETE', '/portal/api/programs/:id/enroll/:athlete', 'guardian', 'Give up a standing spot.', async (ctx, r) => {
    const c = athleteOf(ctx, r, r.params.athlete);
    if (schedule.getSeries(ctx, r.params.id).kind !== 'group') throw conflict('To cancel a camp registration, message your coach.');
    return schedule.endEnrollment(ctx, r.params.id, c.id);
  }],
  ['GET', '/portal/api/slots', 'guardian', 'Open private-training or evaluation times. ?kind=private|evaluation', (ctx, r) => list(schedule.openSlots(ctx, { kind: r.query.kind === 'evaluation' ? 'evaluation' : 'private', days: 21 }))],
  ['POST', '/portal/api/slots/book', 'guardian', 'Book a private or evaluation: kind, starts_at, availability_id, athlete_id, optional pay.', async (ctx, r) => {
    requireWaiver(ctx, r);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    return schedule.bookSlot(ctx, { kind: r.body.kind === 'evaluation' ? 'evaluation' : 'private', startsAt: v.str(r.body.starts_at, 'starts_at'), availabilityId: v.str(r.body.availability_id, 'availability_id'), clientId: c.id, pay: r.body.pay, actor: r.guardian.id });
  }],
  ['GET', '/portal/api/athletes/:id/report', 'guardian', 'Progress report for one of your athletes (shared testing days only).', (ctx, r) => reports.athleteReport(ctx, athleteOf(ctx, r, r.params.id).id, { parentView: true })],
  // Accountability, performance and education for one of your athletes. Parents can check in and finish lessons for them.
  ['GET', '/portal/api/athletes/:id/engage', 'guardian', 'Accountability, performance (shared testing days only) and education for one of your athletes.', (ctx, r) => engage.athleteView(ctx, athleteOf(ctx, r, r.params.id).id, { parentView: true })],
  ['POST', '/portal/api/athletes/:id/daily-check-in', 'guardian', 'Today\'s check-in for your athlete: sleep_hours, hydration, soreness, energy, mood, note.', (ctx, r) => engage.saveCheckin(ctx, athleteOf(ctx, r, r.params.id).id, r.body)],
  ['POST', '/portal/api/athletes/:id/goals/:goal/check', 'guardian', 'Tick a custom goal for today (done=false to untick).', (ctx, r) => engage.checkGoal(ctx, athleteOf(ctx, r, r.params.id).id, r.params.goal, r.body.done !== false)],
  ['POST', '/portal/api/athletes/:id/messages', 'guardian', 'Write to your athlete\'s coach: body.', (ctx, r) => engage.replyMessage(ctx, athleteOf(ctx, r, r.params.id).id, r.body, { from: 'parent', name: r.guardian.name, guardianId: r.guardian.id }), 201],
  ['POST', '/portal/api/athletes/:id/messages/read', 'guardian', 'Mark coach messages read.', (ctx, r) => engage.markRead(ctx, athleteOf(ctx, r, r.params.id).id)],
  ['GET', '/portal/api/athletes/:id/lessons/:lesson', 'guardian', 'Read a lesson.', (ctx, r) => engage.lessonFor(ctx, athleteOf(ctx, r, r.params.id).id, r.params.lesson)],
  ['GET', '/portal/api/parent-courses', 'guardian', 'Courses for parents that fit your athletes\' ages, with what you have read.', (ctx, r) => list(engage.parentCourses(ctx, r.guardian))],
  ['GET', '/portal/api/parent-lessons/:id', 'guardian', 'Read a lesson for parents.', (ctx, r) => engage.parentLesson(ctx, r.guardian, r.params.id)],
  ['POST', '/portal/api/parent-lessons/:id/complete', 'guardian', 'Mark a lesson for parents read (done=false to undo).', (ctx, r) => engage.completeParentLesson(ctx, r.guardian, r.params.id, r.body.done !== false)],
  ['POST', '/portal/api/athletes/:id/lessons/:lesson/quiz', 'guardian', 'Take the lesson quiz with your athlete: answers (choice numbers from 0). 80% or more finishes the lesson.', (ctx, r) => engage.takeQuiz(ctx, athleteOf(ctx, r, r.params.id).id, r.params.lesson, r.body)],
  ['POST', '/portal/api/athletes/:id/lessons/:lesson/complete', 'guardian', 'Mark a lesson done for your athlete (done=false to undo).', (ctx, r) => engage.completeLesson(ctx, athleteOf(ctx, r, r.params.id).id, r.params.lesson, r.body.done !== false)],
  ['GET', '/portal/api/store', 'guardian', 'Packs and memberships a parent can buy.', (ctx) => ({
    products: commerce.listProducts(ctx).filter((p) => ['session', 'pack'].includes(p.kind)),
    plans: billing.listPlans(ctx).map(({ subscribers, ...p }) => p)
  })],
  ['POST', '/portal/api/purchase', 'guardian', 'Buy a pack with the family card: product_id, athlete_id.', async (ctx, r) => {
    legal.requireAgreements(ctx, r.guardian);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    const p = commerce.getProduct(ctx, v.str(r.body.product_id, 'product_id'));
    if (!['session', 'pack'].includes(p.kind) || !p.active) throw badRequest('That item isn\'t sold online.');
    const sale = await commerce.createSale(ctx, { location_id: commerce.onlineLocation(ctx), method: 'card_on_file', client_id: c.id, items: [{ product_id: p.id, quantity: 1 }] }, r.guardian.id, { online: true });
    if (sale.status !== 'succeeded') throw conflict(`The card was declined: ${sale.failure_reason}`);
    return { sale, athlete: athleteSummary(ctx, c.id) };
  }],
  ['GET', '/portal/api/shop', 'guardian', 'Programs and courses for sale, and what your athletes already have.', (ctx, r) => shop.familyShop(ctx, r.guardian.family_id)],
  ['POST', '/portal/api/shop/buy', 'guardian', 'Buy a program or course for an athlete with the family card: kind (program or course), item_id, athlete_id. A program replaces their current one.', async (ctx, r) => {
    legal.requireAgreements(ctx, r.guardian);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    return { ...(await shop.buyForAthlete(ctx, r.guardian, c, r.body)), athlete: athleteSummary(ctx, c.id) };
  }, 201],
  ['POST', '/portal/api/membership', 'guardian', 'Start a membership: plan_id, athlete_id. Needs a card on file.', async (ctx, r) => {
    requireWaiver(ctx, r);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    if (!familyPayer(ctx, r)?.card_payment_method) throw conflict('Add a card to your family account first.');
    await billing.subscribe(ctx, c.id, v.str(r.body.plan_id, 'plan_id'));
    return athleteSummary(ctx, c.id);
  }],
  ['POST', '/portal/api/card/setup-link', 'guardian', 'Secure Stripe page to add or replace the family card.', (ctx, r) => commerce.setupLinkFor(ctx, familyPayer(ctx, r), r.baseUrl)],
  ['POST', '/portal/api/card/test', 'guardian', 'Test mode only: add a test card.', async (ctx, r) => {
    const kid = ctx.db.get('SELECT id FROM clients WHERE family_id = ? LIMIT 1', r.guardian.family_id);
    if (!kid) throw conflict('Add an athlete first.');
    return commerce.addTestCard(ctx, kid.id);
  }],
  ['POST', '/portal/api/waiver', 'guardian', 'Sign the current waiver: signed_name, agree=true.', (ctx, r) => families.signWaiver(ctx, r.guardian.family_id, r.guardian, r.body)],
  ['POST', '/portal/api/athletes', 'guardian', 'Add an athlete to the family.', async (ctx, r) => athleteSummary(ctx, (await clients.createClient(ctx, { ...r.body, family_id: r.guardian.family_id, plan_id: undefined, program_id: undefined, email: undefined })).id), 201],
  ['PATCH', '/portal/api/athletes/:id', 'guardian', 'Update an athlete\'s profile, medical notes and emergency contact.', (ctx, r) => {
    const c = athleteOf(ctx, r, r.params.id);
    const allowed = ['name', 'birth_date', 'sex', 'sport', 'position', 'school', 'grad_year', 'medical_notes', 'emergency_name', 'emergency_phone'];
    clients.updateClient(ctx, c.id, Object.fromEntries(Object.entries(r.body).filter(([k]) => allowed.includes(k))));
    return athleteSummary(ctx, c.id);
  }]
];
