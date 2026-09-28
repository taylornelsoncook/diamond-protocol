// Parent portal API. Every route is scoped to the signed-in parent's family.
import * as families from './services/families.js';
import * as schedule from './services/schedule.js';
import * as commerce from './services/commerce.js';
import * as billing from './services/billing.js';
import * as clients from './services/clients.js';
import { v, notFound, conflict, badRequest, HttpError, newId, ageOn, zonedToUtc, localDate, addDaysToDate } from './util.js';
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
import * as portal from './services/portal.js';
import * as profiles from './services/profiles.js';
import { rateLimit } from './services/security.js';
import { familyLock, lockMessage } from './services/lockout.js';

const list = (data) => ({ data });
// One of the signed-in parent's athletes (archived athletes are hidden from the family). Everything below goes through this.
const athleteOf = (ctx, r, id) => portal.athleteOfFamily(ctx, r.guardian.family_id, v.str(id, 'athlete_id'));
function requireWaiver(ctx, r) {
  legal.requireAgreements(ctx, r.guardian);
  if (!families.getFamily(ctx, r.guardian.family_id).waiver.signed) throw conflict('Sign the waiver on the Family tab before booking.');
}
const familyPayer = (ctx, r) => commerce.payerById(ctx, 'families', r.guardian.family_id);
function athleteSummary(ctx, id, guardianId) {
  const c = clients.getClient(ctx, id);
  const extras = portal.athleteExtras(ctx, id);
  return {
    id: c.id, athlete_id: c.athlete_id, name: c.name, first_name: c.name.split(' ')[0], birth_date: c.birth_date, age: ageOn(c.birth_date, ctx.now()),
    sport: c.sport, position: c.position, school: c.school, grad_year: c.grad_year, medical_notes: c.medical_notes,
    emergency_name: c.emergency_name, emergency_phone: c.emergency_phone,
    membership: extras.membership, membership_request: extras.request, membership_answer: extras.last_answer,
    attended_30: extras.attended_30, next_testing_day: extras.next_testing_day,
    credits: c.credits, program: c.program, app_link: c.app_link, engagement: { ...engage.badges(ctx, id, { guardianId }), overdue: extras.overdue_lessons },
    upcoming: portal.athleteBookings(ctx, id, { limit: 30 }),
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
  ['GET', '/portal/api/public/report', 'public', 'A progress report from a share link: send the link\'s secret in the X-Report-Link header. The family view without the date of birth. ?from= and ?to= limit the period; ?open=1 counts an open. Wrong, expired and turned-off links all get 410.', (ctx, r) => reports.openReportLink(ctx, r.reportLink, { count: r.query.open === '1', ...reports.reportPeriod(r.query) })],
  ['GET', '/portal/api/public/learn', 'public', 'Coach\'s education for the public page (/learn): published stand-alone lessons under Coach\'s education, newest first. No sign-in.', (ctx) => engage.publicLearn(ctx)],
  ['GET', '/portal/api/public/learn/:id', 'public', 'One published coach\'s education lesson: title, summary, text, video and minutes.', (ctx, r) => engage.publicLearnLesson(ctx, r.params.id)],
  ['GET', '/portal/api/public/legal', 'public', 'The current terms of service and privacy policy.', (ctx) => legal.legalDocs(ctx)],
  ['POST', '/portal/api/signup', 'public', 'New family: parent {name, email, phone}, athletes [{name, birth_date, sex, sport, school, medical_notes, emergency_name, emergency_phone}], accept_terms=true. Emails a code.', (ctx, r) => signup.startSignup(ctx, r.body, r.ip)],
  ['POST', '/portal/api/signup/verify', 'public', 'Finish sign-up with signup_id and the emailed code. Creates the family and signs the parent in.', (ctx, r) => signup.finishSignup(ctx, r.body, r.ip, { userAgent: r.userAgent })],
  ['POST', '/portal/api/agreements', 'guardian', 'Accept the current terms of service and privacy policy: accept=true.', (ctx, r) => { if (r.body.accept !== true) throw badRequest('Tick the box to accept.'); return legal.recordConsent(ctx, r.guardian, { ip: r.ip }); }],
  ['GET', '/portal/api/export', 'guardian', 'Download everything we hold about your family, as a file.', (ctx, r) => ({ __file: { filename: `family-data-${new Date().toISOString().slice(0, 10)}.json`, type: 'application/json', body: Buffer.from(JSON.stringify(legal.exportFamily(ctx, r.guardian.family_id), null, 2)) } })],
  ['POST', '/portal/api/deletion-request', 'guardian', 'Ask for your family\'s account and data to be deleted. Optional note.', (ctx, r) => legal.requestDeletion(ctx, r.guardian, r.body), 201],
  ['POST', '/portal/api/verify', 'public', 'Exchange the code for a session.', (ctx, r) => families.verifyCode(ctx, r.body, { userAgent: r.userAgent })],
  ['PATCH', '/portal/api/texts', 'guardian', 'Turn text messages on or off: texts (true or false), phone (your mobile number, needed to turn them on).', (ctx, r) => sms.setTextPrefs(ctx, r.guardian, r.body)],
  ['GET', '/portal/api/check-in', 'guardian', 'From the door QR code (?code=): your athletes booked at that location with check-in open now.', (ctx, r) => checkin.familyCheckIns(ctx, r.guardian.family_id, r.query.code)],
  ['POST', '/portal/api/check-in', 'guardian', 'Check in at the door: code, and booking_id (or none to check in everyone booked there now).', (ctx, r) => checkin.familyCheckIn(ctx, r.guardian.family_id, r.body)],
  ['POST', '/portal/api/logout', 'guardian', 'Sign out.', (ctx, r) => { families.portalLogout(ctx, r.familyToken); return { ok: true }; }],

  ['GET', '/portal/api/me', 'guardian', 'Family, athletes, card, waiver, and payment_lock when a declined membership payment has locked the family out (every route but the card, payments, your details, agreements, the waiver, devices, export and deletion then answers 402 payment_locked).', (ctx, r) => {
    const fam = families.getFamily(ctx, r.guardian.family_id);
    const settings = families.getSettings(ctx);
    const agreements = legal.consentStatus(ctx, r.guardian.id);
    const lock = familyLock(ctx, r.guardian.family_id);
    return {
      // Locked out over a declined membership payment: only the card and payments work until it's paid (lockout.js).
      payment_lock: lock ? { amount_cents: lock.amount_cents, athletes: lock.athletes, invoice_ids: lock.invoices.map((i) => i.id), message: lockMessage(lock) } : null,
      guardian: { id: r.guardian.id, name: r.guardian.name, email: r.guardian.email, phone: r.guardian.phone, texts: sms.textStatus(r.guardian) },
      agreements, open_deletion_request: !!ctx.db.get(`SELECT 1 FROM data_requests WHERE family_id = ? AND kind = 'delete' AND status = 'open'`, r.guardian.family_id),
      family: fam, athletes: portal.familyAthletes(ctx, r.guardian.family_id).map((c) => athleteSummary(ctx, c.id, r.guardian.id)),
      to_finish: portal.toFinish(ctx, r.guardian.family_id, { agreementsOk: agreements.ok }), calendar: portal.calendarStatus(r.guardian),
      waiver_text: settings.waiver_text, late_cancel_hours: Number(settings.late_cancel_hours), business_name: settings.business_name, timezone: settings.timezone,
      payments: { can_simulate: !!ctx.payments.simulate, provider: ctx.payments.name }
    };
  }],
  ['GET', '/portal/api/schedule', 'guardian', 'Upcoming classes, clinics and camp days for the next 3 weeks with each athlete\'s status.', (ctx, r) => {
    const zone = families.getSetting(ctx, 'timezone');
    const from = new Date().toISOString(), to = zonedToUtc(addDaysToDate(localDate(from, zone), 22), '00:00', zone);
    const kids = portal.familyAthletes(ctx, r.guardian.family_id);
    const mine = ctx.db.all(`SELECT b.id, b.session_id, b.client_id, b.status, b.created_at FROM bookings b JOIN clients c ON c.id = b.client_id WHERE c.family_id = ? AND b.status IN ('booked','waitlisted','attended')`, r.guardian.family_id);
    const places = new Map(ctx.db.all('SELECT id, name AS location_name, kind AS location_kind, address_line1, city, state, postal_code FROM locations').map((l) => [l.id, portal.placeOf(l)]));
    const series = new Map(ctx.db.all('SELECT id, description, active FROM class_series').map((x) => [x.id, x]));
    const member = new Set(ctx.db.all(`SELECT client_id FROM subscriptions WHERE status IN ('active','trialing','past_due')`).map((x) => x.client_id));
    const credits = new Map(kids.map((k) => [k.id, commerce.creditBalances(ctx, k.id)]));
    return list(schedule.listSessions(ctx, { from, to }).filter((s) => ['group', 'clinic', 'camp'].includes(s.kind)).map((s) => ({
      id: s.id, name: s.name, kind: s.kind, starts_at: s.starts_at, ends_at: s.ends_at, ...places.get(s.location_id), coach_name: s.coach_name ?? null,
      spots_left: s.spots_left, capacity: s.capacity, waiting: s.waitlist_count, description: series.get(s.series_id)?.description ?? null,
      age_min: s.age_min, age_max: s.age_max, drop_in_cents: s.drop_in_cents, registration_cents: s.registration_cents ?? null, series_id: s.series_id,
      registration_only: s.registration_cents != null && s.drop_in_cents == null, registration_open: !s.series_id || !!series.get(s.series_id)?.active,
      athletes: kids.map((k) => {
        const age = ageOn(k.birth_date, s.starts_at), b = mine.find((m) => m.session_id === s.id && m.client_id === k.id);
        const place = b?.status === 'waitlisted' ? ctx.db.get(`SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status = 'waitlisted' AND (created_at < ? OR (created_at = ? AND id <= ?))`, s.id, b.created_at, b.created_at, b.id).n : null;
        const cr = credits.get(k.id);
        return { id: k.id, eligible: age == null || ((s.age_min == null || age >= s.age_min) && (s.age_max == null || age <= s.age_max)), booking_id: b?.id ?? null, status: b?.status ?? null, waitlist_place: place,
          clash: b ? null : schedule.clashText(ctx, k.id, s.id, k.name),
          pays_with: s.kind === 'group' && member.has(k.id) ? 'membership' : s.kind === 'group' && cr.group > 0 ? 'credit' : s.drop_in_cents ? 'drop_in' : s.registration_cents != null ? 'registration' : 'none' };
      })
    })));
  }],
  ['POST', '/portal/api/bookings', 'guardian', 'Book a session: session_id, athlete_id, optional pay=card_on_file.', async (ctx, r) => {
    requireWaiver(ctx, r);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    return schedule.book(ctx, { sessionId: v.str(r.body.session_id, 'session_id'), clientId: c.id, pay: r.body.pay, actor: r.guardian.id });
  }],
  ['GET', '/portal/api/bookings/:id', 'guardian', 'One of your bookings: time range, place with directions, coach, how it is paid, place in line on a waitlist, the late-cancel time, and whether it can be cancelled here.', (ctx, r) => portal.familyBooking(ctx, r.guardian.family_id, r.params.id)],
  ['POST', '/portal/api/bookings/:id/cancel', 'guardian', 'Cancel a booking or leave a waitlist. Inside the late-cancel window the session still counts as used. A camp registration is cancelled by your coach.', async (ctx, r) => {
    const b = portal.familyBooking(ctx, r.guardian.family_id, r.params.id);
    if (b.camp_registration) throw conflict('To cancel a camp registration, message your coach.');
    if (b.kind === 'team') throw conflict('Team sessions are managed by your coach.');
    return schedule.cancelBooking(ctx, b.id);
  }],
  ['GET', '/portal/api/programs', 'guardian', 'Group classes (standing spots for members, with the next session) and camps/clinics open for registration (spots left, when registration closes, which of your athletes are registered). Camps your family registered for stay listed.', (ctx, r) => {
    const today = localDate(new Date().toISOString(), families.getSetting(ctx, 'timezone'));
    const kids = portal.familyAthletes(ctx, r.guardian.family_id);
    const mineIn = (id) => ctx.db.all(`SELECT e.client_id, e.kind FROM enrollments e JOIN clients c ON c.id = e.client_id WHERE e.series_id = ? AND e.status = 'active' AND c.family_id = ? AND c.archived_at IS NULL`, id, r.guardian.family_id);
    return list(schedule.listSeries(ctx, { includeInactive: true }).filter((s) => ['group', 'camp', 'clinic'].includes(s.kind)).map((s) => {
      const upcoming = ctx.db.all(`SELECT s.id, s.starts_at, s.capacity, (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','attended')) AS booked FROM class_sessions s WHERE s.series_id = ? AND s.status = 'scheduled' AND s.starts_at > ? ORDER BY s.starts_at`, s.id, ctx.now());
      const enrolled = mineIn(s.id);
      const held = Object.fromEntries(kids.filter((k) => enrolled.some((e) => e.client_id === k.id)).map((k) => {
        const next = ctx.db.get(`SELECT MIN(x.starts_at) AS at, COUNT(*) AS n FROM bookings b JOIN class_sessions x ON x.id = b.session_id WHERE b.client_id = ? AND x.series_id = ? AND x.status = 'scheduled' AND x.starts_at > ? AND b.status = 'booked'`, k.id, s.id, ctx.now());
        return [k.id, { next_at: next.at, booked: next.n }];
      }));
      return {
        id: s.id, name: s.name, kind: s.kind, description: s.description, location_name: s.location_name, coach_name: s.coach_name ?? null, weekdays: s.weekdays, start_time: s.start_time, duration_min: s.duration_min,
        age_min: s.age_min, age_max: s.age_max, start_date: s.start_date, end_date: s.end_date, registration_cents: s.registration_cents, drop_in_cents: s.drop_in_cents,
        capacity: s.capacity, enrolled_count: s.enrolled_count, active: s.active,
        next_session_at: upcoming[0]?.starts_at ?? null, days_left: upcoming.length,
        spots_left: upcoming.length ? Math.max(0, Math.min(...upcoming.map((x) => x.capacity - x.booked))) : 0,
        registration_open: s.active && upcoming.length > 0, closes_at: s.kind === 'group' ? null : upcoming[0]?.starts_at ?? null,
        registered: enrolled.map((e) => e.client_id), held
      };
    }).filter((s) => s.registered.length || (s.active && (s.kind === 'group' || (s.registration_cents != null && s.end_date >= today)))));
  }],
  ['POST', '/portal/api/programs/:id/enroll', 'guardian', 'Standing spot in a group class (members) or registration for a camp or clinic.', async (ctx, r) => {
    requireWaiver(ctx, r);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    const s = schedule.getSeries(ctx, r.params.id);
    if (!['group', 'camp', 'clinic'].includes(s.kind)) throw notFound('Class');
    return s.kind === 'group' ? schedule.enroll(ctx, s.id, c.id) : schedule.registerCamp(ctx, s.id, c.id, { pay: 'card_on_file', actor: r.guardian.id });
  }],
  ['DELETE', '/portal/api/programs/:id/enroll/:athlete', 'guardian', 'Give up a standing spot.', async (ctx, r) => {
    const c = athleteOf(ctx, r, r.params.athlete);
    if (schedule.getSeries(ctx, r.params.id).kind !== 'group') throw conflict('To cancel a camp registration, message your coach.');
    return schedule.endEnrollment(ctx, r.params.id, c.id);
  }],
  ['GET', '/portal/api/slots', 'guardian', 'Open private-training or evaluation times, each with its coach. ?kind=private|evaluation, ?days= (7 to 60, default 21) for later dates, ?coach_id= for one coach.', (ctx, r) => {
    const days = Math.min(60, Math.max(7, Number.parseInt(r.query.days, 10) || 21));
    const all = schedule.openSlots(ctx, { kind: r.query.kind === 'evaluation' ? 'evaluation' : 'private', days });
    const coaches = [...new Map(all.filter((x) => x.coach_id).map((x) => [x.coach_id, { id: x.coach_id, name: x.coach_name }])).values()];
    return { data: r.query.coach_id ? all.filter((x) => x.coach_id === r.query.coach_id) : all, coaches, days };
  }],
  ['POST', '/portal/api/slots/book', 'guardian', 'Book a private or evaluation: kind, starts_at, availability_id, athlete_id, optional pay.', async (ctx, r) => {
    requireWaiver(ctx, r);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    return schedule.bookSlot(ctx, { kind: r.body.kind === 'evaluation' ? 'evaluation' : 'private', startsAt: v.str(r.body.starts_at, 'starts_at'), availabilityId: v.str(r.body.availability_id, 'availability_id'), clientId: c.id, pay: r.body.pay, actor: r.guardian.id, note: r.body.note });
  }],
  ['GET', '/portal/api/athletes/:id/report', 'guardian', 'Progress report for one of your athletes (shared testing days only). ?from= and ?to= (YYYY-MM-DD) limit it to a period. Also the next testing day, the coach\'s targets and (when turned on) how results compare.', (ctx, r) => {
    const c = athleteOf(ctx, r, r.params.id);
    const p = engage.performance(ctx, c.id, { parentView: true });
    return { ...reports.athleteReport(ctx, c.id, { parentView: true, ...reports.reportPeriod(r.query) }), can_share: true, next_testing_day: portal.nextTestingDay(ctx, c.id), targets: p.targets, rankings: p.rankings };
  }],
  ['GET', '/portal/api/tests/:key', 'guardian', 'What a test measures and how it is run.', (ctx, r) => portal.testInfo(ctx, r.params.key)],
  ['POST', '/portal/api/athletes/:id/membership-request', 'guardian', 'Ask to change a membership: kind (switch, pause or cancel), plan_id for switch, optional note. The owner is emailed and makes the change; nothing about billing changes here. One open request per athlete.', (ctx, r) => portal.requestMembershipChange(ctx, r.guardian, athleteOf(ctx, r, r.params.id).id, r.body), 201],
  ['POST', '/portal/api/athletes/:id/membership-request/withdraw', 'guardian', 'Withdraw your open membership request.', (ctx, r) => portal.withdrawMembershipRequest(ctx, r.guardian, athleteOf(ctx, r, r.params.id).id)],
  ['GET', '/portal/api/athletes/:id/report-links', 'guardian', 'Working share links to your athlete\'s progress report: who made each, when it expires and how often it was opened.', (ctx, r) => ({ data: reports.listReportLinks(ctx, athleteOf(ctx, r, r.params.id).id) })],
  ['POST', '/portal/api/athletes/:id/report-links', 'guardian', 'Make a link to your athlete\'s progress report that works without signing in (for a grandparent or a recruiter): days (7, 30, 90 or 365), optional label. The response has the url once.', (ctx, r) => reports.createReportLink(ctx, athleteOf(ctx, r, r.params.id).id, r.body, { kind: 'parent', id: r.guardian.id, name: `${r.guardian.name} (parent)` }, r.baseUrl), 201],
  ['DELETE', '/portal/api/athletes/:id/report-links/:link', 'guardian', 'Turn off a share link. It stops working at once.', (ctx, r) => reports.revokeReportLink(ctx, athleteOf(ctx, r, r.params.id).id, r.params.link)],
  // Accountability, performance and education for one of your athletes. Parents can check in and finish lessons for them.
  ['GET', '/portal/api/athletes/:id/engage', 'guardian', 'Accountability, performance (shared testing days only) and education for one of your athletes.', (ctx, r) => engage.athleteView(ctx, athleteOf(ctx, r, r.params.id).id, { parentView: true, guardianId: r.guardian.id })],
  ['POST', '/portal/api/athletes/:id/daily-check-in', 'guardian', 'Today\'s check-in for your athlete: sleep_hours, hydration, soreness, energy, mood, note.', (ctx, r) => engage.saveCheckin(ctx, athleteOf(ctx, r, r.params.id).id, r.body)],
  ['POST', '/portal/api/athletes/:id/goals/:goal/check', 'guardian', 'Tick a custom goal for today, or for a day missed earlier this week with date (done=false to untick).', (ctx, r) => engage.checkGoal(ctx, athleteOf(ctx, r, r.params.id).id, r.params.goal, r.body.done !== false, r.body.date)],
  ['POST', '/portal/api/athletes/:id/messages', 'guardian', 'Write to your athlete\'s coach: body.', (ctx, r) => engage.replyMessage(ctx, athleteOf(ctx, r, r.params.id).id, r.body, { from: 'parent', name: r.guardian.name, guardianId: r.guardian.id }), 201],
  ['POST', '/portal/api/athletes/:id/messages/read', 'guardian', 'Mark coach messages read.', (ctx, r) => engage.markRead(ctx, athleteOf(ctx, r, r.params.id).id, { guardianId: r.guardian.id })],
  ['GET', '/portal/api/athletes/:id/lessons/:lesson', 'guardian', 'Read a lesson.', (ctx, r) => engage.lessonFor(ctx, athleteOf(ctx, r, r.params.id).id, r.params.lesson)],
  ['GET', '/portal/api/parent-courses', 'guardian', 'Courses for parents that fit your athletes\' ages, with what you have read.', (ctx, r) => list(engage.parentCourses(ctx, r.guardian))],
  ['GET', '/portal/api/parent-articles', 'guardian', 'Stand-alone reading for parents: parent education, blogs and research, newest first, with what you have read. Open one with /portal/api/parent-lessons/:id.', (ctx, r) => list(engage.parentArticles(ctx, r.guardian))],
  ['GET', '/portal/api/parent-lessons/:id', 'guardian', 'Read a lesson for parents.', (ctx, r) => engage.parentLesson(ctx, r.guardian, r.params.id)],
  ['POST', '/portal/api/parent-lessons/:id/complete', 'guardian', 'Mark a lesson for parents read (done=false to undo).', (ctx, r) => engage.completeParentLesson(ctx, r.guardian, r.params.id, r.body.done !== false)],
  ['POST', '/portal/api/athletes/:id/lessons/:lesson/quiz', 'guardian', 'Take the lesson quiz with your athlete: answers (choice numbers from 0). 80% or more finishes the lesson.', (ctx, r) => engage.takeQuiz(ctx, athleteOf(ctx, r, r.params.id).id, r.params.lesson, r.body)],
  ['POST', '/portal/api/athletes/:id/lessons/:lesson/complete', 'guardian', 'Mark a lesson done for your athlete (done=false to undo).', (ctx, r) => engage.completeLesson(ctx, athleteOf(ctx, r, r.params.id).id, r.params.lesson, r.body.done !== false)],
  ['GET', '/portal/api/store', 'guardian', 'Packs and memberships a parent can buy. Packs say their price a session and what they save against single sessions.', (ctx) => {
    const products = commerce.listProducts(ctx).filter((p) => ['session', 'pack'].includes(p.kind));
    const single = (type) => products.filter((p) => p.kind === 'session' && (p.credit_type ?? 'private') === (type ?? 'private')).map((p) => p.price_cents).sort((a, b) => a - b)[0] ?? null;
    return {
      products: products.map((p) => {
        if (p.kind !== 'pack' || !p.sessions) return p;
        const each = Math.round(p.price_cents / p.sessions), one = single(p.credit_type);
        return { ...p, per_session_cents: each, saves_cents: one && one * p.sessions > p.price_cents ? one * p.sessions - p.price_cents : null };
      }),
      plans: billing.listPlans(ctx).map(({ subscribers, ...p }) => p)
    };
  }],
  ['POST', '/portal/api/purchase', 'guardian', 'Buy a pack with the family card: product_id, athlete_id.', async (ctx, r) => {
    legal.requireAgreements(ctx, r.guardian);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    const p = commerce.getProduct(ctx, v.str(r.body.product_id, 'product_id'));
    if (!['session', 'pack'].includes(p.kind) || !p.active) throw badRequest('That item isn\'t sold online.');
    const sale = await commerce.createSale(ctx, { location_id: commerce.onlineLocation(ctx), method: 'card_on_file', client_id: c.id, items: [{ product_id: p.id, quantity: 1 }] }, r.guardian.id, { online: true });
    if (sale.status !== 'succeeded') throw new HttpError(402, 'payment_failed', `The card was declined: ${sale.failure_reason}. Nothing was charged.`);
    return { sale, athlete: athleteSummary(ctx, c.id, r.guardian.id) };
  }],
  ['GET', '/portal/api/shop', 'guardian', 'Programs and courses for sale, and what your athletes already have.', (ctx, r) => shop.familyShop(ctx, r.guardian.family_id)],
  ['POST', '/portal/api/shop/buy', 'guardian', 'Buy a program or course for an athlete with the family card: kind (program or course), item_id, athlete_id. A program replaces their current one.', async (ctx, r) => {
    legal.requireAgreements(ctx, r.guardian);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    return { ...(await shop.buyForAthlete(ctx, r.guardian, c, r.body)), athlete: athleteSummary(ctx, c.id, r.guardian.id) };
  }, 201],
  ['POST', '/portal/api/membership', 'guardian', 'Start a membership: plan_id, athlete_id. Needs a card on file.', async (ctx, r) => {
    requireWaiver(ctx, r);
    const c = athleteOf(ctx, r, r.body.athlete_id);
    if (!familyPayer(ctx, r)?.card_payment_method) throw conflict('Add a card to your family account first.');
    await billing.subscribe(ctx, c.id, v.str(r.body.plan_id, 'plan_id'));
    return athleteSummary(ctx, c.id, r.guardian.id);
  }],
  ['POST', '/portal/api/card/setup-link', 'guardian', 'Secure Stripe page to add or replace the family card.', (ctx, r) => commerce.setupLinkFor(ctx, familyPayer(ctx, r), r.baseUrl)],
  ['POST', '/portal/api/card/test', 'guardian', 'Test mode only: add a test card.', async (ctx, r) => {
    const kid = ctx.db.get('SELECT id FROM clients WHERE family_id = ? LIMIT 1', r.guardian.family_id);
    if (!kid) throw conflict('Add an athlete first.');
    const out = await commerce.addTestCard(ctx, kid.id);
    portal.tellOtherParents(ctx, r.guardian.family_id, r.guardian.id, 'A new card was saved to your family account', `${r.guardian.name} saved a card ending ${out.last4} to your family account. It pays for memberships, packs, camps and drop-ins.`);
    return out;
  }],
  ['DELETE', '/portal/api/card', 'guardian', 'Remove the family card. Refused while a membership uses it. The other parents are emailed.', (ctx, r) => portal.removeFamilyCard(ctx, r.guardian)],
  ['GET', '/portal/api/payments', 'guardian', 'Your payments and refunds, newest first, with receipt links (?all=1 for every one), what you paid this year and any declined membership payment.', (ctx, r) => portal.familyPayments(ctx, r.guardian.family_id, { all: r.query.all === '1' })],
  ['GET', '/portal/api/payments/membership/:id', 'guardian', 'A membership payment\'s receipt, to print.', (ctx, r) => portal.membershipReceipt(ctx, r.guardian.family_id, r.params.id)],
  ['POST', '/portal/api/payments/:id/retry', 'guardian', 'Try a declined membership payment again on the card on file.', (ctx, r) => portal.retryDeclined(ctx, r.guardian.family_id, r.params.id)],
  ['PATCH', '/portal/api/me', 'guardian', 'Change your own name or phone. Your sign-in email is changed by your coach.', (ctx, r) => portal.updateMe(ctx, r.guardian, r.body)],
  ['POST', '/portal/api/guardians', 'guardian', 'Add another parent: name, email, optional phone and relationship. They are emailed how to sign in; the other parents are told. Up to 6 parents.', (ctx, r) => portal.withFamilyLock(r.guardian.family_id, () => portal.addParent(ctx, r.guardian, r.body)), 201],
  ['GET', '/portal/api/devices', 'guardian', 'Devices signed in to your account.', (ctx, r) => ({ data: portal.listDevices(ctx, r.guardian, r.familyToken) })],
  ['POST', '/portal/api/devices/sign-out-others', 'guardian', 'Sign out every other device.', (ctx, r) => portal.signOutOthers(ctx, r.guardian, r.familyToken)],
  ['GET', '/portal/api/calendar', 'guardian', 'Whether your private calendar feed is on.', (ctx, r) => portal.calendarStatus(r.guardian)],
  ['POST', '/portal/api/calendar', 'guardian', 'Make (or reset) your private calendar feed address for Apple, Google or Outlook. The address is shown once; the old one stops working.', (ctx, r) => portal.resetCalendar(ctx, r.guardian, r.baseUrl)],
  ['DELETE', '/portal/api/calendar', 'guardian', 'Turn off your calendar feed.', (ctx, r) => portal.stopCalendar(ctx, r.guardian)],
  ['POST', '/portal/api/waiver/email', 'guardian', 'Email yourself a copy of the signed waiver.', (ctx, r) => portal.emailWaiverCopy(ctx, r.guardian)],
  ['POST', '/portal/api/waiver', 'guardian', 'Sign the current waiver: signed_name, agree=true.', (ctx, r) => families.signWaiver(ctx, r.guardian.family_id, r.guardian, r.body)],
  ['POST', '/portal/api/athletes', 'guardian', 'Add an athlete to the family: name, birth_date, sex, sport, school, medical notes, emergency contact. Already has a profile (a team athlete)? Add athlete_code, their Athlete ID: when the name and birthday match, that profile joins your family instead of a second one being made.', async (ctx, r) => {
    const allowed = ['name', 'birth_date', 'sex', 'sport', 'position', 'school', 'grad_year', 'medical_notes', 'emergency_name', 'emergency_phone'];
    const body = Object.fromEntries(Object.entries(r.body).filter(([k]) => allowed.includes(k)));
    const code = profiles.claimCode(r.body.athlete_code);
    return portal.withFamilyLock(r.guardian.family_id, async () => {
      portal.checkAthlete(ctx, r.guardian.family_id, body);
      let tried = null;
      if (code) {
        rateLimit(`claim:${r.guardian.id}`, 5, 60 * 60000);
        rateLimit(`claim-ip:${r.ip}`, 10, 60 * 60000);
        const fields = families.athleteFields(body);
        tried = profiles.tryClaim(ctx, { code, name: v.str(body.name, 'name', { max: 120 }), birthDate: fields.birth_date, familyId: r.guardian.family_id, guardian: r.guardian, fields });
        if (tried.attached) return { ...athleteSummary(ctx, tried.attached.id, r.guardian.id), claim: 'attached' };
      }
      const c = await clients.createClient(ctx, { ...body, family_id: r.guardian.family_id });
      if (code) profiles.fileClaim(ctx, { code, familyId: r.guardian.family_id, guardian: r.guardian, claim: tried, newClientId: c.id });
      return { ...athleteSummary(ctx, c.id, r.guardian.id), ...(code ? { claim: 'pending', message: profiles.claimPendingText(c.name) } : {}) };
    });
  }, 201],
  ['PATCH', '/portal/api/athletes/:id', 'guardian', 'Update an athlete\'s profile, medical notes and emergency contact.', (ctx, r) => {
    const c = athleteOf(ctx, r, r.params.id);
    const allowed = ['name', 'birth_date', 'sex', 'sport', 'position', 'school', 'grad_year', 'medical_notes', 'emergency_name', 'emergency_phone'];
    const body = Object.fromEntries(Object.entries(r.body).filter(([k]) => allowed.includes(k)));
    portal.checkAthlete(ctx, r.guardian.family_id, body, { exceptId: c.id });
    clients.updateClient(ctx, c.id, body);
    return athleteSummary(ctx, c.id, r.guardian.id);
  }]
];
