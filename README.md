# Diamond Protocol

The platform for Diamond Protocol: the coach dashboard, parent portal, athlete workout app, printable progress reports and school invoices. *Built under pressure.*

## Run it

Needs Node 22.5 or newer.

```bash
npm install
npm run demo     # resets the database, loads demo data, starts on http://localhost:3000
npm start        # starts with your real data (first visit asks you to create the owner account)
npm test         # 356 automated tests
```

Demo sign-ins:

| Who | Where | Sign in |
| --- | --- | --- |
| Owner | `/` | owner@demo.test / demo-owner-2026 |
| Coach | `/` | coach@demo.test / demo-coach-2026 |
| Front desk | `/` | desk@demo.test / demo-desk-2026 |
| Parent | `/parent` | maria.lopez@example.com (the code shows on screen in test mode) |

Other demo parents: kurt.jensen@example.com (two kids), linh.nguyen@example.com (card declines), paulo.silva@example.com (no card or waiver yet).

## What's inside

- **Coach dashboard** (`/app`): Today, Schedule, session rosters, Hours & settings, Point of sale, Clients, CRM (leads and the pipeline board, automatic stage moves from bookings and memberships, converting a lead into a client, tasks on Today, timelines, email and text templates, group messages with opt-outs, CSV import and export, reports), Teams, Testing (stopwatch, uploads with undo, device linking, Hawkin, test library, record boards and presets), Billing, Programs, Education (lessons, courses, assigning, reminders and read tracking), API & integrations, Staff & security. Menus and data follow the role: owners see everything, coaches never see money, front desk runs the floor.
- **Parent portal** (`/parent`): emailed sign-in code, Home (with a calendar feed), Book (classes, camps, privates and evaluations with a note for the coach), Progress, Programs (membership changes by request), Family (card, payments and receipts). Installable to a phone's home screen.
- **Athlete app** (`/w/<private link>`): Workout (set logging, rest timer, offline saving, effort), Accountability, Performance and Education tabs. **Progress report** (`/report/<Athlete ID>`, with share links), **school invoice** (`/invoice/<link>`), **API reference** (`/docs/api`), **website enquiry form** (`/enquire`, embeddable on your own site) and **unsubscribe** links in CRM emails.
- **Background jobs**: sessions created 8 weeks ahead, membership renewals, declined-charge retries every 3 days, monthly school invoices, overdue reminders, Hawkin sync every 15 minutes, daily backups.

The product spec is `docs/screen-guide.md`, the reference designs are in `docs/screenshots/`, the brand rules in `docs/brand.md`, and how the code is organized in `docs/ARCHITECTURE.md`.

## Test mode and going live

Out of the box, payments, email and texts run in **test mode**: cards are simulated (a card ending 0002 declines), every email is saved to the outbox (API & integrations → Email outbox) and every text to the Text outbox.

| Setting | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DP_DATA_DIR` | Where the database and backups live (default `./data`). Use a persistent disk in production. |
| `DP_APP_URL` | Public address used in email links, e.g. `https://app.yourdomain.com` |
| `RESEND_API_KEY` | Sends email through [Resend](https://resend.com). When set, parents' sign-in codes stop showing on screen. |
| `DP_EMAIL_FROM` | Sender, e.g. `Diamond Protocol <hello@yourdomain.com>` (the domain must be verified in Resend) |
| `DP_EMAIL_REPLY_TO` | Where replies go, e.g. your own inbox |
| `DP_EMAIL_ONLY_TO` | Only deliver to these addresses or `@domains` (for staging); everything else is held in the outbox |
| `DP_EMAIL_WEBHOOK` | Alternative to Resend: URL that receives `{to, subject, body, html}` for each email |
| `DP_SMS_PROVIDER` | `twilio` sends CRM texts through Twilio (needs the three settings below). Without it, texts are saved to the Text outbox only. |
| `TWILIO_ACCOUNT_SID` | Your Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Your Twilio auth token (also checks the signature on incoming texts) |
| `TWILIO_FROM` | The Twilio number texts come from, e.g. `+18015550000`. Point its incoming messages at `https://your-site/api/sms/inbound` so STOP, START and HELP work. |
| `DP_SMS_ONLY_TO` | Only text these numbers (comma list, for staging); everything else is held in the Text outbox |
| `STRIPE_SECRET_KEY` | Switches payments to live mode. The Stripe calls go in `lib.payments` in `server/lib.js` (charge and refund) and the parent card page; this is the one piece of wiring left before taking real cards. |
| `NODE_ENV=production` | Secure cookies, caching, strict startup |

## Deploy

Step-by-step for Render (staging + production): `docs/DEPLOY.md`. The included `Dockerfile` runs anywhere that supports containers with a persistent volume (Render, Railway, Fly.io). Mount a disk at `/data`. Download a backup from Staff & security regularly and keep it off the server.
