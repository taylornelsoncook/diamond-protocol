# Diamond Protocol

The Diamond Protocol coaching platform: client accounts, monthly subscriptions and billing, in-person payments at your facility, in parks and at clients' homes (Tap to Pay on iPhone, front-desk reader, card on file, cash), session packs and check-ins, workout programming with demo videos, a client phone app, and an open API with webhooks.

**Start with `CHECKLIST.md`** for the steps only you can do (Stripe, Apple, hosting).

This is the working model. It runs on your computer with no installs beyond Node.js, and every screen is wired to a real database.

## Run it

You need **Node.js 22.13 or newer** (check with `node -v`; download from nodejs.org).

```bash
cp .env.example .env      # then change ADMIN_PASSWORD
npm run seed              # creates your login plus sample plans, programs and clients
npm start                 # open http://localhost:3000
npm test                  # runs the full test suite (137 tests)
```

The seed prints your login and a sample client app link. To start over, delete the `data` folder and seed again.

## What's in it

**Coach dashboard** (`/`)
- **Today:** monthly recurring revenue, active clients, failed payments, workouts logged this week, a list of what needs you (failed charges, trials ending, clients who've gone quiet) and a live activity feed.
- **Clients:** search and filter; create an account, start a plan and assign a program in one step; pause, resume, cancel, change plan; payment history with retry; private app link; coach notes.
- **Billing:** plans with live revenue per plan, invoice history, retry failed charges. In test mode, run the billing clock for a future date to watch trials convert, renewals charge and retries happen.
- **Point of sale:** pick where you are and who you're with, tap products into the sale, and charge by Tap to Pay on iPhone, front-desk reader, card on file or cash. Optionally save the tapped card for future payments. Refunds (full or partial) and a live list of recent sales. Setup covers locations, products (sessions, packs, gear) and readers.
- **Inventory:** gear can count its stock, per size (Youth M, S, M, L...). The counter asks which size and shows how many are left. Sales take stock out, full refunds put it back, and the Inventory screen records deliveries, shelf counts and adjustments with who did it. Anything at or below its low-stock number shows on Today and in the Monday summary. Front desk can record deliveries and counts.
- **Book now page** (`/book`): upcoming classes, clinics and camp days with open spots, an age filter and the next evaluation times, for the website, Instagram bio and Google profile. Families sign in or sign up to book. Put it on any website with one line (`<script src=".../embed.js" async></script>`, or `data-button="Book now"` for a button). No names are shown. Link and code are on the Leads tab; owners can turn it off.
- **Google review requests:** after an athlete's 10th session, or a personal best on a testing day the family can see, the parent gets one friendly email asking for a Google review. At most once every 6 months per family, never to a family behind on a payment or asking to be deleted, only between 10 am and 7 pm, with a "don't ask again" link. Off until the owner pastes their Google review link on the Leads tab, which also shows how many were sent and opened.
- **Email a group** (Leads → Email a group, owners only): announcements to all families, members, lapsed members, families without a membership or families who asked about training, narrowed by athlete age and sport. Shows who it reaches as you type, sends a test to you, and sends only after confirming the number. `{first_name}` fills in the parent's name, links are counted when clicked, and each email ends with the business address and a "stop these emails" link (a button press, so email scanners can't unsubscribe anyone). Stopped addresses also get no review requests.
- **Two-way messages:** athletes (in their app) and parents (in the portal) can write back under "Messages with your coach". Only coaches see replies. The coach who last wrote to that athlete gets an email (the owners, if no coach has written yet), replies show on Today until a coach opens the athlete's page, and families see "Seen" once they have. Up to 20 replies a day per athlete.
- **Weights from test results:** in a program, set an exercise to a percent of the athlete's back squat, bench press or power clean max. The athlete app shows the weight worked out from their latest shared max, rounded to 5 lb (for example "155 lb (75% of your 205 lb back squat max)"), and it updates on its own after the next testing day is shared.
- **Schedule:** weekly group classes, camps, clinics, team sessions and one-offs, with age ranges, capacity and prices. Weekly classes are scheduled 8 weeks ahead automatically. Each session has a roster with one-tap check-in, how every athlete is covered (member, credit, paid, registered or unpaid), a medical flag, a waitlist, and Collect (card on file, cash or Tap to Pay) for anyone unpaid. Canceling a session returns credits, refunds drop-ins and emails families.
- **Teams:** school and club contracts billed a flat monthly fee. Each month is invoiced on the contract's start day and emailed to the billing contact with a link to a branded invoice they can print or pay online (card or US bank transfer through Stripe). Record checks and ACH payments by hand, bill one-off extras, void mistakes. Overdue invoices get a reminder the day after they're due, then weekly, and show up on Today. Each team has a roster (paste the team list), its own sessions on the schedule, and attendance per athlete, with one tap to check in the whole team.
- **Testing:** a preloaded library of 70+ tests from pro combines (NFL, NBA, NHL, MLB), soccer, youth and high school testing, plus the common force plate tests (countermovement jump, squat jump, drop jump, rebound jump, single-leg CMJ, isometric mid-thigh pull, isometric squat). Every metric has its unit and whether lower or higher is better; hide what you don't use or add your own. Plan testing days for individuals or a whole team roster, enter results by hand or with the built-in stopwatch (hand times stay labeled), and see personal records and progress on each athlete's page.
- **Athlete IDs:** every client and team roster player gets a permanent ID when their profile is created: first 3 letters of the first name, first 3 of the last name, and the year they joined (Ava Lopez → AVALOP2026; a second one that year → AVALOP2026-2). It never changes when a name does, is searchable, and is how uploads, devices and the API find the right athlete. Athletes created before IDs existed got theirs automatically.
- **Upload results (all or nothing):** download an Excel or CSV sheet with every athlete's ID already filled in and a column per test and attempt; fill it in; upload it (or paste rows, or a device export with Athlete IDs as the names). The whole sheet is checked before anything is saved: every row with results needs a real Athlete ID, a name on the row must match that ID's profile, every column must be a known test, every value must be a number inside the possible range for that test (catching numbers in the wrong column), no result may be entered twice, and dates can't be in the future. One problem anywhere and nothing is saved; you get a list by row and column of what to fix. Unusual-but-possible values (far off an athlete's record, or attempts that disagree) must each be confirmed. The sheet is checked again at save time and saved in a single transaction, so an upload is either fully in every profile or not in at all. Uploading the same sheet twice never double-counts.
- **Devices & imports:** Hawkin Dynamics force plates sync every 15 minutes. OVR, VALD, Swift, Freelap, Brower, Dashr, Rapsodo, radar guns or any spreadsheet import from a CSV, with columns matched automatically and remembered. Any other system can post to `POST /v1/results` with an API key. Results only land in a profile automatically when they carry an Athlete ID (in any field, including the name) or come from a device ID you've linked. Names are never matched on their own.
- **Waiting to be linked:** everything else goes to a queue (Testing → Waiting to be linked, also flagged on Today). Each sender's results are grouped with suggested athletes; you pick the athlete from a list that only accepts real Athlete IDs, link all of them or just the ones you tick, and optionally remember that device ID or name so its future results go straight in. Linking is all or nothing, and you can discard results instead. Linked device IDs are listed under Devices, where you can unlink them.
- **Hours & settings:** your hours for privates and evaluations (parents book open times; anything on your schedule blocks them), your time zone, the late-cancel window and the waiver text.
- **Families:** athletes belong to a family with one or more parents. The family has one card that pays for every athlete, and one waiver signature. Athlete profiles hold birthday, sport, position, school, grad year, medical notes and an emergency contact.
- **Session packs and credits:** packs add either **group** or **private** credits. Members' group classes are covered by the membership; privates always use private credits or a paid drop-in. A full refund removes the pack's unused sessions.
- **Revenue by location:** see what the facility, each park and your mobile work bring in this month.
- **Programs:** exercise library with demo video links (YouTube, Vimeo or a direct video file), program builder by week and day, assign to clients.
- **API & integrations:** create and revoke API keys, add webhooks and see every delivery, link to the full API spec.

**Accountability, Performance and Education**: athletes (in their app) and parents (Home tabs) get a daily check-in (sleep, hydration, soreness, energy, mood) with red flags for coaches, streaks, weekly goals, coach messages, test targets with progress, opt-in rankings by best result (no other names shown), and lessons, courses and assigned reading. Coaches run it from the Education screen and each client profile.

**Parent portal** (`/parent`): parents sign in with a 6-digit code emailed to them (no password). They see each athlete's upcoming sessions, membership and credits; book classes, clinics, privates and evaluations; join waitlists; cancel; hold a standing weekly spot (members); register for camps; buy packs and memberships with the family card; sign the waiver; and update athlete profiles and medical notes. It can be added to a phone's home screen like an app.

**Booking rules**
- A booking is covered by, in order: the membership (group classes only), a credit of the right type, or paying the drop-in price with the card on file. Coaches can also book now and collect at the session.
- Full sessions take a waitlist. When a spot opens, the next athlete moves up automatically and the family gets an email.
- Parents canceling inside the late-cancel window (default 12 hours) still use the session. Coaches can waive it.
- The waiver must be signed before a family books. Changing the waiver text asks every family to sign again.
- Age limits are enforced for parents; coaches can override.

**Email:** sign-in codes, booking confirmations, waitlist moves and cancellations. With `RESEND_API_KEY` set they're sent through Resend; without it they're logged to API & integrations → Email outbox, and in test mode the sign-in code is shown on screen.

**Athletes to check on and the weekly summary:** the app scores every active athlete for signs they're drifting away (no sessions in two weeks after coming regularly, coming less than half as often, nothing booked, repeated no-shows, stopped daily check-ins, and for owners only a failed payment or a trial with no visits) and lists the ones at risk on Today with the reasons. Every Monday at 7 am the owners get a summary email: money in against the week before, members joined and left, athletes to check on, open spots in the coming week, and up to three suggested actions. Preview it, send it now or turn it off in Hours & settings.

**Leads and follow-up:** put the "Ask about training" link (`/start`) on your website and social pages. Every inquiry lands on the Leads tab, the owners get an email, and the family gets a thank-you right away with the sign-up link and the next step (a free evaluation). If they don't sign up, a short nudge goes out after 2 days and a last note after 7, then it stops. Parents who tick "text me" also get the first two as texts, and replying STOP ends them. Sign-ups that were started but never finished show up as leads after an hour and get the same follow-up. A lead moves to Signed up, Evaluation and Member on its own as the family creates an account, books an evaluation and buys a membership or pack, and follow-up stops the moment they sign up. Front desk can add walk-ins and phone calls, and anyone can mark a lead lost or turn off its follow-up. The Monday summary counts new inquiries and flags any nobody has reached out to.

**Pay links and failed-payment recovery:** send a family a link to pay one thing by card without signing in: a membership payment that didn't go through, an unpaid session, a pack, or a set amount (Billing, or the Pay links panel on a client's page). Emails go to every parent and texts to parents who turned texts on; you can also copy the link and send it yourself. When a membership payment fails, the email and text now include a pay link automatically, and as soon as the family saves a new card the failed payment is charged right away instead of waiting for the next retry. Payments by link show in sales as "Pay link". If a family pays by link for something that was already paid another way, the money is refunded automatically and you get an email. Links stop working once paid, when you cancel them, or after 30 days. In test mode the pay page has a "Simulate payment" button; with Stripe it opens Stripe's secure card page.

**Self check-in:** athletes check themselves in for sessions they're booked on, from 30 minutes before the start until it ends, and the roster updates as they do. In Schedule → Hours & settings → Self check-in: **Door poster** prints a QR code for that location; parents scan it with their phone camera, sign in to the parent portal and tap their athlete. **Set up a tablet** gives a one-time link to open on a front-desk tablet; athletes tap their session and their name (shown as first name and last initial). An athlete whose session isn't paid is still checked in and asked to see the front desk. Remove a tablet or make a new door code there if a link or poster gets out. The QR codes are drawn by the app itself, no outside service.

**Text messages:** parents turn texts on in the parent portal (Family tab) with their mobile number and get a confirmation text. Then they get a reminder the day before each booked session (one per family, skipped for bookings made less than a day ahead), a text when an athlete moves off the waitlist, when you cancel a session, and when a membership payment doesn't go through. Replying STOP turns texts off, START turns them back on, HELP gets a short answer, and any other reply is emailed to the owners. Each kind can be turned off in Hours & settings. With `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` set they're sent through Twilio; without them they're only logged under API & integrations → Texts. `SMS_ONLY_TO` limits real texts on a staging copy.

**DP Coach iPhone app** (`ios/`): your pocket point of sale with Tap to Pay on iPhone. See `ios/README.md` to build it.

**Client app** (`/app?token=…`): each client gets a private link. It shows their next workout, the demo video for each exercise, logging, notes for the coach, and progress through the program. Paused or canceled members see a message instead of workouts.

**Billing rules**
- New subscriptions start with the plan's free trial; the first charge happens when it ends.
- Renewals charge monthly on the same day of the month.
- A failed charge makes the membership past due (the client keeps app access) and retries every 3 days. After 4 failed attempts the subscription is canceled.
- Pause stops charges and app access. Resume starts a new month and charges that day.
- Plan price changes apply from each client's next charge.

## The API

Everything the dashboard does goes through the same API your other systems use. Full spec: `GET /v1/openapi.json` (OpenAPI 3.1, importable into Postman, Zapier, Make and most tools).

```bash
curl http://localhost:3000/v1/clients -H "Authorization: Bearer dp_live_…"

curl -X POST http://localhost:3000/v1/clients \
  -H "Authorization: Bearer dp_live_…" -H "Content-Type: application/json" \
  -d '{"name":"Jordan Lee","email":"jordan@example.com","plan_id":"plan_…","program_id":"prog_…"}'
```

Lists return `{ "data": [...] }`. Errors return `{ "error": { "code": "...", "message": "..." } }` with a plain-English message. Money is in cents.

**Webhooks** fire on `client.created`, `client.updated`, `client.card_updated`, `subscription.created`, `subscription.updated`, `invoice.paid`, `invoice.payment_failed`, `program.assigned`, `workout.completed`, `sale.completed`, `sale.failed`, `sale.refunded` and `session.checked_in`. Each request carries a `DP-Signature: t=<unix time>,v1=<signature>` header. Verify it on your side:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  return fresh && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

Failed deliveries retry after 1 min, 5 min, 30 min, 2 hr and 12 hr.

## How it's built

```
src/
  schema.sql            every table
  db.js                 the only file that talks to the database
  services/
    billing.js          plans, subscriptions, invoices, the billing clock
    clients.js          accounts
    programs.js         exercises, programs, workouts, assignments, client app
    events.js           event log and signed webhook delivery
    access.js           coach login, API keys, dashboard numbers
    commerce.js         locations, readers, products, sales, refunds, saved cards, session credits, check-ins
  payments/
    test-provider.js    built-in test payments (no Stripe key)
    stripe-provider.js  Stripe: customers, Tap to Pay, readers, saved cards, refunds, webhooks
  routes.js             every endpoint, its access rule and its docs
  server.js             HTTP, auth, security headers, background jobs
public/                 dashboard and client app (plain JavaScript, no build step)
test/                   end-to-end tests (API, point of sale, Stripe against a stand-in Stripe server)
ios/                    DP Coach iPhone app (SwiftUI + Stripe Terminal)
```

Security in place: passwords hashed with scrypt; sessions in HttpOnly cookies; API keys and sessions stored only as hashes; cross-site request protection; strict content security policy; parameterized SQL everywhere; input validation with clear messages; API keys can't manage other keys or webhooks.

## Payments: test mode and Stripe

With no `STRIPE_SECRET_KEY`, the server uses built-in test payments: nothing is charged, taps are simulated from the dashboard, and each client has a "make card decline" switch.

With a Stripe key, everything runs through Stripe:
- **In person:** Tap to Pay on iPhone (in the DP Coach app) and Stripe smart readers at the front desk (sent from the dashboard, no app needed).
- **Saved cards:** from a tap (when the client agrees), or from a secure Stripe link you send them. Card details never touch this server.
- **Memberships:** this app runs the monthly billing clock and charges the saved card through Stripe.
- **Stripe webhooks** go to `https://your-domain/stripe/webhook`. Subscribe to `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.amount_capturable_updated` and `checkout.session.completed`.

Use `sk_test_...` keys until you've run real test payments end to end. The server refuses to start with a live key while `DP_TEST_MODE=true`.

## Sign-up, import, agreements and emails

- **Family sign-up** (`/join`): a parent enters their details and their athletes (birthday required for age groups), agrees to the terms and privacy policy, and confirms their email with a 6-digit code. The family and athletes (with Athlete IDs) are created and the parent lands in the portal to sign the waiver and add a card. Protected by email confirmation, a hidden bot field and rate limits; it never reveals whether an email already has an account. Turn it on or off and copy the link in Hours & settings.
- **Client import** (Clients → Import from a spreadsheet): Excel or CSV template, one row per athlete. Siblings sharing a parent email become one family; a parent who already has an account gets the athlete added; adults use their own email. All or nothing: every problem is listed by row in one pass, and the preview shows the exact families and Athlete IDs before anything is saved. Optionally emails new families and adults their sign-in details.
- **Terms and privacy** (`/terms`, `/privacy`): your wording, set in Hours & settings. Placeholders are never shown to parents. Parents accept at sign-up; changing either asks every parent to accept again before their next booking or purchase. Every acceptance is recorded with name, version and time.
- **Data requests:** parents download everything held about their family (Family tab → Your data) or ask for deletion. Owners see requests on Today and in Staff & security, can download a family's data, and delete it by typing the family name. Deletion removes parents, athlete profiles, medical notes, test results, device links and saved cards; payment records stay without names.
- **Automatic emails:** welcome (sign-up, new client or import), receipts for sales and membership payments, a reminder 3 days before a free trial ends, and failed-payment notices to every parent with the next retry date. Each can be turned off in Hours & settings. Everything also appears in the Email outbox.

## Staff, security and backups

- **Roles:** Owner (everything), Coach (clients, schedule, testing, programs, point of sale; no billing, school contracts, refunds, API keys or staff) and Front desk (check-ins, sales, bookings, rosters, adding clients and families, entering test results). The server checks the role on every request; menus follow the role, and coaches and front desk never see revenue.
- **Staff accounts:** owners add staff under Staff & security. Each gets a one-time password by email and must choose their own at first sign-in. Owners can change roles, turn accounts off (signed out everywhere at once), reset passwords and unlock accounts. There is always at least one owner.
- **Sign-in protection:** five wrong passwords lock an account for 15 minutes; sign-in attempts and overall requests are rate-limited per address; parent sign-in codes are limited too.
- **Activity log:** every change, refused attempt and sign-in by staff, API keys and parents: who, what, which record, when, from where. Request contents are never stored.
- **Backups:** a full copy of the database every day (last 30 kept), plus "Back up now" and downloads for the owner. Keep downloaded copies off the server.

## Parent progress reports

Parents see test results after you share a testing day ("Share with parents", with an optional note; families are emailed), or as soon as results are saved if you choose that in Hours & settings. The parent portal's Progress tab shows biggest improvements, new PRs, a trend line for every test, and growth. A printable, branded report (`/report.html`) is available to parents and coaches. For youth athletes with a birthday, sex, height, seated height and weight, the report estimates where they are relative to their growth spurt (Mirwald maturity offset, about ±1 year).

## Going to production

See **DEPLOY.md** for step-by-step instructions (Render or Fly.io, Docker, a persistent disk, your domain). In short: one instance with a persistent disk at `/data`, `DP_TEST_MODE=false`, `PUBLIC_URL=https://…`, `TRUST_PROXY=true` (set in the Dockerfile), your Stripe and Resend keys, and `ADMIN_EMAIL`/`ADMIN_PASSWORD` for the first start only. The app refuses to start with unsafe settings and says what to fix; `/healthz` reports health.

Later, as you grow: Postgres instead of SQLite (only `db.js` and a few date functions change), private video uploads (Mux or Cloudflare Stream), and emailed receipts and trial reminders.

## Roadmap

| Week | Focus |
| --- | --- |
| Done | Working model, point of sale, Stripe connection, iPhone app code |
| Next | Your Stripe and Apple accounts, first build of the iPhone app, deploy to a real URL |
| Done | Families, parent portal, scheduling, camps, waitlists, privates and evaluations |
| Done | Team contracts with monthly invoicing, rosters and attendance |
| Done | Performance testing library, stopwatch entry, device imports and Hawkin sync |
| Done | Staff roles, sign-in protection, activity log, daily backups; parent progress reports; hosting setup; iPhone rosters and testing |
| Done | Family self sign-up, client import, terms and privacy with data requests, automatic emails |
| Next | Your accounts and first deploy; build the iPhone app on a Mac |
| Then | Online programs for sale, pay links and text reminders, video uploads |
| Then | Messaging, check-ins and progress photos, adherence analytics |
