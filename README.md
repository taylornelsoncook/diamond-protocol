# Diamond Protocol

The platform for Diamond Protocol: the coach dashboard, parent portal, athlete workout app, printable progress reports and school invoices. *Built under pressure.*

## Run it

Needs Node 22.5 or newer.

```bash
npm install
npm run demo     # resets the database, loads demo data, starts on http://localhost:3000
npm start        # starts with your real data (first visit asks you to create the owner account)
npm test         # 74 automated tests
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

- **Coach dashboard** (`/app`): Today, Schedule, session rosters, Hours & settings, Point of sale, Clients, Teams, Testing (stopwatch, uploads, device linking, Hawkin), Billing, Programs, API & integrations, Staff & security. Menus and data follow the role: owners see everything, coaches never see money, front desk runs the floor.
- **Parent portal** (`/parent`): emailed sign-in code, Home, Book, Progress, Programs, Family. Installable to a phone's home screen.
- **Athlete workout app** (`/w/<private link>`), **progress report** (`/report/<Athlete ID>`), **school invoice** (`/invoice/<link>`), **API reference** (`/docs/api`).
- **Background jobs**: sessions created 8 weeks ahead, membership renewals, declined-charge retries every 3 days, monthly school invoices, overdue reminders, Hawkin sync every 15 minutes, daily backups.

The product spec is `docs/screen-guide.md`, the reference designs are in `docs/screenshots/`, the brand rules in `docs/brand.md`, and how the code is organized in `docs/ARCHITECTURE.md`.

## Test mode and going live

Out of the box, payments and email run in **test mode**: cards are simulated (a card ending 0002 declines) and every email is saved to the outbox (API & integrations → Email outbox).

| Setting | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DP_DATA_DIR` | Where the database and backups live (default `./data`). Use a persistent disk in production. |
| `DP_APP_URL` | Public address used in email links, e.g. `https://app.yourdomain.com` |
| `DP_EMAIL_WEBHOOK` | URL that receives `{to, subject, body}` for each email (e.g. a Postmark/Resend relay). When set, sign-in codes stop showing on screen. |
| `STRIPE_SECRET_KEY` | Switches payments to live mode. The Stripe calls go in `lib.payments` in `server/lib.js` (charge and refund) and the parent card page; this is the one piece of wiring left before taking real cards. |
| `NODE_ENV=production` | Secure cookies, caching, strict startup |

## Deploy

Step-by-step for Render (staging + production): `docs/DEPLOY.md`. The included `Dockerfile` runs anywhere that supports containers with a persistent volume (Render, Railway, Fly.io). Mount a disk at `/data`. Download a backup from Staff & security regularly and keep it off the server.
