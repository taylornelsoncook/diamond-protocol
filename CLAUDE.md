# Diamond Protocol: project guide for Claude Code

## The business
Diamond Protocol ("Built Under Pressure") is a mobile sports-performance coaching business. It trains at its own facility, at clients' homes and in parks. Most clients are **parents paying for youth athletes**. Revenue mix: about 30% private training, 50% group classes, 20% other (camps and clinics, team contracts with schools and clubs billed a flat monthly fee, online programs, evaluations). The owner is not a developer: explain things in plain language and keep them informed of anything they need to do themselves.

## What this is
One web platform plus an iPhone app:
- **Coach dashboard** (`/`): Today, Schedule and rosters, Point of sale, Clients, Teams (school contracts and invoices), Testing, Billing, Programs, API & integrations, Staff & security.
- **Parent portal** (`/parent`), **family sign-up** (`/join`), **terms and privacy** (`/terms`, `/privacy`), **athlete workout app** (`/app?token=`), **printable progress report** (`/report.html`), **school invoice page** (`/invoice/:token`).
- **Open API** (`/v1/...`, reference at `/v1/openapi.json`) and a parent API (`/portal/api/...`).
- **iPhone app** `ios/` (SwiftUI "DP Coach": Today/rosters, Charge with Tap to Pay, Testing stopwatch, Clients). **Written but never compiled**: the first build on a Mac may need Swift fixes. `test/ios-contract.test.js` pins every field it reads.

Read `README.md` for features, `CHECKLIST.md` for the owner's to-do list, `DEPLOY.md` for going live, `ios/README.md` for the app.

## Commands
- `npm run seed`: sample data (sign in `coach@diamondprotocol.local` / `change-me-now`; parent `maria.lopez@example.com`, code shown on screen in test mode). Delete `data/` first to reseed.
- `npm start`: http://localhost:3000
- `npm test`: the full suite (115 tests). Run it before calling anything done.
- Node 22.13+ only. **Zero npm dependencies** (node:sqlite, node:http, node:test, built-in fetch/zlib/crypto). Keep it that way unless the owner agrees.

## Code map
- `src/server.js` HTTP, auth, roles check, audit log, rate limits, static pages, the list of background jobs. `src/services/jobs.js` runs them: run history (`job_runs`), owner email on failure and recovery, and a lease (`job_state`) so server copies sharing a database never run the same job at once. `src/index.js` startup and production safety checks.
- `src/routes.js` coach and public API (+ OpenAPI). `src/portal-routes.js` parent API.
- `src/schema.sql` all tables. `src/db.js` versioned migrations (`SCHEMA_VERSION`, `ADDED_COLUMNS`, table rebuilds). New columns go in **both** the CREATE TABLE and `ADDED_COLUMNS`, and bump the version.
- `src/services/`: billing, clients, families (settings, waiver, parent sign-in), commerce (point of sale, cards, credits), schedule, teams, performance + test-library + units + perf-import + uploads + queue + reports, athlete-ids, security (roles, staff, audit, rate limits), backups, legal (terms/privacy, data export/deletion), signup, client-import, notify (automatic emails), mail (Resend + outbox), xlsx (Excel read/write), events (webhooks).
- `src/payments/` test provider and Stripe (REST via fetch). Test provider refuses charges with no saved card, like Stripe.
- `public/` plain JS modules (`js/ui.js` helpers `h`, `fill`, `btn`, `panel`...). Brand: black, steel `#E4E7E5`, forest green `#2F6B34`/`#7DBA70`, Chakra Petch + IBM Plex Sans.

## Rules we decided (don't undo these without asking the owner)
- **Athlete ID** (`AVALOP2026`: first 3 of first name + first 3 of last name + year joined, `-2` for duplicates) is permanent and ties all data together.
- **Results only land in a profile by Athlete ID, our internal IDs, or a device ID the coach linked by hand. Never guess by name.** Everything else waits in the queue (`results_queue`) for manual linking.
- **Uploads and imports are all or nothing:** check the whole file, list every problem by row and column, save nothing until clean, re-check at save time, save in one transaction. Unusual-but-possible values need explicit confirmation.
- **Roles** (Owner, Coach, Front desk) are enforced server-side in `services/security.js`; coaches and front desk never see money. Update the rules there for new endpoints.
- **Parents see test results only after a testing day is shared** (unless the setting says otherwise).
- **Terms/privacy placeholders start with `[`** and are never shown to parents or required.
- Deleting a family removes personal data but keeps payment records without names.
- Every change and sign-in is audit-logged without storing request bodies.
- Plain-English UI copy, sentence case, active voice. Errors say what to fix.

## Status
Done: everything above, with tests, plus Accountability / Performance / Education (daily check-ins, streaks, weekly goals, coach messages, test targets, opt-in rankings, lessons, courses and assigned reading; `services/engage.js`, `public/js/engage-view.js`, `public/js/engage-coach.js`) and monthly memberships at the counter.

**Deployed on Render** from `main` (see `render.yaml`): `diamond-protocol-staging` (demo data, test mode, auto-deploys; email limited by `EMAIL_ONLY_TO`) and `diamond-protocol` (production at https://app.diamondprotocol.org, deploys only on Manual Deploy). Email via Resend from `hello@diamondprotocol.org`; DNS on Cloudflare. The database is `/data/dp.db` (the first version of the app left an unused `/data/diamond.db`; never point `DB_FILE` at it). Older setting names `DP_APP_URL`, `DP_EMAIL_FROM`, `DP_EMAIL_REPLY_TO`, `DP_EMAIL_ONLY_TO` still work. `DP_DEMO=1` seeds an empty database and implies test mode.

**How changes ship:** build and test here, push to `main` → staging updates → the owner checks staging → the owner presses Manual Deploy on production.
Owner's side (see CHECKLIST.md): lawyer-written waiver/terms/privacy, Stripe live + Terminal + Tap to Pay entitlement (Apple), Resend email with domain DNS, domain, hosting (Render via `render.yaml`), GitHub repo, a Mac for the iPhone app, real prices/schedule, one real OVR export to confirm the import.
Next builds: online programs for sale, pay links + text reminders, sales tax (after the owner's accountant weighs in), private video uploads, confirm OVR import against a real file.
