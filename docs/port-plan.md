# Porting the earlier version's work onto this version

**Status (updated 2026-09-28):**
- Done and merged: **B0** bug fixes (PR #5), **B1** coaches on sessions/hours, time off, client archive, staff notes, connection check (PR #6), Today business summary (PR #6), every open class on Today + owner trial offers + Coaches panel (PR #7).
- Also done and merged: **B7** Teams, **B10** Test library, presets, report share links (schema 34), **B4** Clients, **B9** Testing days, uploads (with undo) and devices (schema 35), **B5** Point of sale (schema 36).
- Main's PRs #1-#3 (background job history and alerts, schema 33; encrypted off-site backups; Stripe webhooks incl. dashboard refunds, now also logged in `sale_refunds`) are merged in; our schema blocks were renumbered to follow main's 33.
- Also done: **one profile per athlete** (schema 37): every team roster athlete is a client; results, device links, testing days and team attendance are on the client; old roster Athlete IDs still find the profile.
- Also done: **B8** Programs builder + athlete Workout tab (schema 40, branch `port/b8-programs`).
- Next: B6 Billing (thread `vrx31w`'s refund handling has merged; build on it) → B2 Schedule/roster/hours and B3 Today extras → B12/B13 parent portal → B8 Programs builder + athlete Workout tab → B14 API & integrations + Staff & security → B11 Education + engage tabs → B15 CRM on top of `leads.js`/`sms.js`/`campaigns.js`.
- The old version's code is readable with `git show d6b36a2:<path>` (commits `2342d22..d6b36a2`; each old tab has an "<Tab>: ..." commit whose body lists its improvements). Re-implement against the current code; never copy old files.
- Owner decisions still open: whether coach-only staff notes stay out of the parent's self-service data export; whether coaches should work leads in the CRM (old version: no CRM access for coaches).

Below is the original comparison, made against the competitor-roadmap tip (`100505c`). Rows marked ALREADY need no work; PARTIAL and MISSING are the work; N/A were old-code-only fixes.

# Porting plan: session work (2342d22..d6b36a2) onto the Cowork base (origin/claude/competitor-roadmap-qlft83)

Compared against competitor-roadmap tip `100505c` (main `ab5b77b` + 23 commits). Read-only study; nothing was changed in the repo.

## 1. New base architecture (what a port has to fit into)

| Thing | Where |
|---|---|
| Runtime | Node 22.13+, ESM, **zero npm deps** (node:sqlite, node:http, node:test). `npm start` / `npm run seed` / `npm test` |
| HTTP, auth, roles check, audit, rate limits, static pages, hourly jobs | `src/server.js` (jobs and rate limits inline; `rateLimit()` in `services/security.js`), startup checks `src/index.js` |
| Routes | One table per surface: `src/routes.js` (coach `/v1/*`, `/auth/*`, `/app/api/*` athlete app, `/pay-api`, `/kiosk-api`, `/here-api`, `/invoice-api`; also generates OpenAPI at `/v1/openapi.json`), `src/portal-routes.js` (`/portal/api/*` parents + public). Row = `[method, path, auth, tag, description, handler]` |
| Open API | The same `/v1/*` routes with an API key (no separate v1 module). No key scopes |
| Services | `src/services/*.js` (43 files): schedule, commerce (POS, cards, credits, check-in), billing, teams, clients, families (settings, waiver, parent sign-in), performance + test-library + uploads + queue + perf-import + reports, engage (accountability, messages + replies, badges, quizzes, education), programs, security, access (sessions, dashboard), events (webhooks + retries), mail, sms, leads, campaigns, reviews, insights, paylinks, moneychecks, checkin, screen, inventory, booknow, shop, spots, notes, legal, signup, client-import, backups, xlsx |
| Schema + migrations | `src/schema.sql` (all tables, CREATE IF NOT EXISTS) + `src/db.js` versioned migrations: `SCHEMA_VERSION = 29` (main is 12), `ADDED_TABLES{version:[...]}`, `ADDED_COLUMNS{table:[...]}`, `REBUILD{version:[tables]}` for constraint changes. New column = both CREATE TABLE and ADDED_COLUMNS + bump version |
| Screens | Coach dashboard is **one file** `public/js/app.js` (2,075 long lines, `view*` functions, hash router) + `public/js/engage-coach.js`; parent portal `public/js/parent.js`; athlete app `public/js/client.js` + shared `public/js/engage-view.js`; helpers `public/js/ui.js` (`h`, `fill`, `btn`, `panel`, `field`, `busy`, `toast`); one-page publics (`book.js`, `start.js`, `pay.js`, `kiosk.js`, `tv.js`, `spot.js`, `shop.js`, `report.js`, `invoice.js`, ...) |
| Roles | `owner` / `coach` / `front_desk` in `users.role`. Server-side in `services/security.js#can()`: `OWNER_ONLY` path regexes, `FRONT_DESK` explicit allow-list, `COACH_DENY` list. Rule: coaches and front desk never see money. **Every new endpoint must be added there** |
| Tests | `test/*.test.js` (35 files), node:test, in-memory DB. `node --no-warnings=ExperimentalWarning --test test/*.test.js` on the competitor-roadmap tip: **197 tests, 197 pass, 0 fail (~11 s)** |
| Not in the model at all | **No coach on sessions / classes / hours** (no `coach_id` anywhere), **no client archive** (clients only have subscription status), no per-client notes table, no staff session devices, no key scopes |

### Where leads and SMS live (extend these, don't duplicate)
- **Leads**: `src/services/leads.js` (STAGES `new, contacted, signed_up, evaluation, member, lost`; `submitInquiry` for public `/start` form with honeypot `website`; `captureUnfinishedSignups`; `advance()` automatic stage moves; `runFollowUps` 0/2/7-day email+text; `listLeads/getLead/addLead/updateLead/deleteLead`). Table `leads` in `schema.sql` (v14). Routes `/v1/leads*` in `src/routes.js`; public `POST /portal/api/public/inquiry` in `portal-routes.js`; rate limit `inquiry:<ip>` 10/h in `server.js`. UI `viewLeads` in `public/js/app.js` (~L217-297, also hosts Book-now embed and Google review settings), public form `public/start.html` + `public/js/start.js`. Webhooks `lead.created`, `lead.updated`. Today item `new_leads` in `services/access.js#dashboard`. Tests `test/leads.test.js`.
- **SMS**: `src/services/sms.js` (`sendText` logs to `texts` table, Twilio when `TWILIO_*` set, `SMS_ONLY_TO`; `normalizePhone` to E.164; `numberStopped`; `textFamily`; `sendReminders`; `setTextPrefs` parent opt-in; `verifyTwilio`; `handleInbound` STOP/START/HELP, other replies emailed to owners). `guardians.sms_opt_in_at/sms_opt_out_at` (v13). Inbound webhook `POST /sms/inbound` in `server.js`. Coach UI "Texts" panel in `viewIntegrations`; parent opt-in panel in `parent.js#viewFamily`; `texts_off` setting in Hours & settings. Tests `test/texts.test.js`.
- **Group email** (the CRM "segment emails"): `src/services/campaigns.js` (groups everyone/members/lapsed/no_membership/leads, age/sport filter, one row per address, `email_optouts` table, `/c/:token` links with button-press stop), UI `viewCampaigns`.

## 2. Classification of every user-visible improvement

Legend: **A** = ALREADY, **P** = PARTIAL, **M** = MISSING, **N** = N/A. "(bug present)" = the same defect exists in the new base. File refs are on the competitor-roadmap tip.

### Today (73a05f6, b8cab0f)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Check-in panel: everyone booked today, still-to-arrive first, search by name/ID, Enter checks in, Undo, row flags (allergy/injury, no waiver, unpaid, red-flag check-in, birthday), no-show ordering, queued refresh, focus kept | M | Today has agenda rows only (`viewToday`); check-in is per session page or kiosk |
| 2 | Session states On now/Next/Done, coach, check-in bar, tomorrow line | M | no coach model |
| 3 | Check-in flags in attention list, says whether athlete trains today | P | `flagsPanel()` (engage-coach) lists flags; no "trains today" |
| 4 | Unpaid bookings to collect at the door in attention; count in heading | P | unpaid badge per session row only |
| 5 | Follow-ups: Send a note / Call / Reached out / Followed up / Mark reviewed with snooze table, Undo, Bring back, who did it | P | "Athletes to check on" (`services/insights.js`, `/v1/at-risk`) lists at-risk athletes with reasons; no actions/snooze |
| 6 | Retry charge confirms amount+card; no card -> Add a card; last retry message | P | Retry button exists (no confirm); pay links cover no-card |
| 7 | Birthdays this week | M | |
| 8 | Recent activity by time, filters, Show more, exact time on hover | M | fixed 12 items |
| 9 | No dollar amounts in coach/front-desk activity (packs, camps, products, billing runs, price changes) | P | `access.js#dashboard` hides invoice/subscription/team_invoice/sale.refunded; other money events not filtered (verify sale/pack event text) |
| 10 | Metrics link to screens, one green button, date in header, 44px, auto-refresh 1 min | M | polish |
| 11 | Review fixes: flag-date/days validation, reviewed wording, double send | N | snooze-specific; port with #5 |

### Schedule / roster / hours (3c544f7, f280b06)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Week-at-a-time nav, search, filters (type, coach, My sessions, place) kept in URL, totals line, On now/Done, check-in bar, Full, coach per row | M | `viewSchedule` = fixed 14-day list; coach filters need coach model |
| 2 | Edit class/camp: upcoming sessions follow (time/place moves, one email per family, dropped days cancelled with credits, new days added, spots >= bookings, only changed fields, never into past, clash refused, `slot_date` so the job doesn't recreate moved sessions) | P | `schedule.updateSeries` updates name/capacity/ages/price/end/weekdays and regenerates; no time/location edit, no emails, no UI edit form, no spots check |
| 3 | Add one session (makeup/clinic) with staff note | P | `POST /v1/sessions` (`createSession`) exists; no UI, no note |
| 4 | Roster: edit one session (sub coach, time/place + optional email, spots that move waitlist, note), "Nothing to change" | M | |
| 5 | Roster: email families, print sign-in sheet | M | |
| 6 | Move someone up from waitlist over the spots | M | auto-promote only |
| 7 | Roster flags No waiver / Birthday / No-show | P | medical-notes flag and No-show button exist |
| 8 | Roster search, Enter adds only match (fresh results), says none/already booked | M | `<select>` of all clients |
| 9 | Guests on team sessions | M | |
| 10 | No jump to top after check-in; focus returns; Schedule button back to week/filters | M | `render()` redraws |
| 11 | Hours: several days at once, grouped by type, remove confirm, 7-day preview | M | `viewScheduleSetup` one row at a time |
| 12 | Time off for a coach or facility hiding private/eval times (`?from&to`) | M | |
| 13 | Cancelling a team session emails school contact | M | `cancelSession` emails bookings only |
| 14 | Prices hidden from coaches/front desk in schedule list and roster | M (bug present) | `/v1/schedule`, `/v1/sessions/:id` return `drop_in_cents`/coverage to every role |
| 15 | "No coach set" doesn't assign saver; hours need active coach | N | no coach model (port with coach prerequisite) |
| 16 | Last day to register inside the camp | M | verify `seriesInput` |
| 17 | One coach's private doesn't hide another coach's hours | M (bug present, worse) | `openSlots` blocks every hour against **any** scheduled session in the business |
| 18 | aria-pressed true/false | A | `String(...)` used |

### Point of sale (ac3bc75, b3aac07)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | "Sell to" on profile opens sale with client | A | `#/sell?client=` (`viewSell` preClient) |
| 2 | Coaches see only their own sales, no takings (server) | M (bug present) | `GET /v1/sales` open to coach with amounts |
| 3 | Readers charge only at own location | M | verify `createSale` |
| 4 | Discounts (percent/amount, reason, logged); receipt shows "-$2.50" | M | |
| 5 | Email receipt at the counter (default on), resend later, printable receipt page | P | automatic receipt emails (`emails_off: receipts`); no toggle/resend/print |
| 6 | Undo sale 10 min by the taker (refund + credits back), server-matched window | M | refund exists |
| 7 | Today takings panel (net, cash to count, cards, refunds; per location / all) | P | Today shows month revenue by location + today's in-person total (owner) |
| 8 | "Today" = business-day midnight | M (bug present) | `access.js#startOfDay` uses server-local `setHours(0)` |
| 9 | Recent sales Today/7/30, search, location filter, detail, refund reason | P | fixed 7 days, prompt() refund |
| 10 | Client card shows membership + credits; membership tiles grey when already a member | P | credits in the select label; membership panel warns |
| 11 | Cash received / change due, clear sale with Undo, count badges, product search, keyboard client search, 44px | M | |
| 12 | Phone bottom bar with total; sale survives leaving the screen; warning when Sell-to meets another client's sale | M | |
| 13 | Setup: dialogs, full product edit, bring back stopped/retired/archived, duplicate names refused, type required | P | `viewSetup` exists; verify edit/restore |
| 14 | Takings bad date/location 400 | N | with #7 |
| 15 | Save-card tick survives re-render | A | element reused across `draw()` |

### Clients (9987e86, 1765a0b)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | List views with counts (Active, Trial, Past due, Paused, No plan, Team only, No waiver, Archived) | P | status `<select>` without counts |
| 2 | Sort (name / longest since seen / newest), phone search incl. digits, Enter opens single match (fresh), Escape clears | M | search is name/email/family only |
| 3 | Row flags Medical/No waiver/No card/pinned note, grad year, Last seen = check-in or workout | M | last workout only |
| 4 | Archived clients: view, restore banner, archived search hint; archiving cancels bookings in one transaction | M | **no archive concept** |
| 5 | CSV export of the view (no money, formula-safe) | M | per-family JSON export only |
| 6 | Error state + Try again; 100 at a time | M | |
| 7 | New client duplicate warning (name + birthday incl. archived), existing parent login -> family with Add sibling | M | `createClient` checks client email only |
| 8 | New client optional position, grad year, athlete phone, allergies, injuries, emergency contact; impossible/future/pre-1900 birthdays refused; hidden fields don't leak | P | profile has the columns; new-client form has birthday/sport/school only |
| 9 | Profile: sticky section bar, Call/Text/Email primary parent, tap-to-call emergency, pinned notes under medical banner | P | medical banner exists |
| 10 | Tap to copy Athlete ID | A | `idChip()` |
| 11 | Staff notes table: dated, author, pin, coach-only (front desk never sees), author edit, author/owner delete | M | single `clients.notes` text |
| 12 | Attendance panel (visits, no-shows, late cancels 30d, 90d visits, recent outcomes; running session not a no-show) | M | |
| 13 | Book a session from profile (2 weeks, search, waitlist) and cancel upcoming (credits/refund/waitlist) | P | read-only "Upcoming sessions" |
| 14 | Family: edit parent name/email/phone (keep athlete email in step), resend sign-in email, remove second parent, record paper waiver | P | add parent + `DELETE /v1/families/:id/guardians/:gid` API; copy portal link |
| 15 | Profile athlete phone and grad year | A | fields present |
| 16 | Unsaved changes flagged and kept across redraws; forms clear after save | M | |
| 17 | Role fixes: coach doesn't get walk-in drop-in price; front desk can't assign program on create; team link plain text without Teams access | M | verify each; FRONT_DESK may `POST /v1/clients` with `program_id` |
| 18 | 44px small buttons | M | polish |

### Teams / school invoice (04f3f90, 622310d)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | List: Active/Ended/All with counts, search (school/team/PO), attendance per contract, "N days past due", invoice rows link, collected 30d | P | metrics tiles + overdue badge |
| 2 | Email overdue reminders now (all schools) | P | weekly automatic reminders exist (`runTeamBilling`) |
| 3 | Contract section bar, paid-to-date, older invoices fold, not-found page | M | |
| 4 | Record one payment for several invoices (one check) | M | per-invoice `payments` only |
| 5 | Email statement (all open invoices + total) | M | |
| 6 | Contract terms: team name, school/club type, billing phone (tap to call), staff notes; unsaved flag; field errors | P | fee/end/terms/PO/contact editable |
| 7 | Team sessions follow end date both ways (not reviving removed schedules), 3:30 PM, coach per session, "N sessions came off" | P | end cancels future sessions; no lengthening/coach |
| 8 | Restarting an ended contract bills from next billing day; unchanged save doesn't restart | M | verify `updateContract`/Reactivate back-billing |
| 9 | Roster: attendance counts from join date (`team_since`) | M (bug likely) | attendance vs all `sessions_held` |
| 10 | Roster: last-session check-ins, bars, find/sort/CSV, last time here, Add existing client (move asks), Remove with Undo | P | Class of + attended/held % shown |
| 11 | Roster paste pre-check (problem lines first, jersey/list numbers, "Class of", header row), link to existing clients | M | verify `addRoster` parsing |
| 12 | New contract: live invoice summary, past-start choice (all/current/none), field errors, duplicate active team refused | P | org type + phone already on the form |
| 13 | Record payment refuses garbled/future/non-existent dates | M | verify `recordPayment` |
| 14 | School invoice: team line, how to pay (online/check/memo), days past due, questions | P | `payment_instructions`, `business_address` settings exist |

### Billing (d5d9ed1, 8db8df8)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Four numbers (MRR, collected net of refunds, failed at risk, open/overdue) that jump to lists; sticky bar | P | MRR/at-risk only on Today |
| 2 | Needs attention list: every decline with card, tries, next retry/none, last reminder + overdue school invoices | P | Today attention has decline + overdue team items |
| 3 | Retry (confirm), card reminder email, record payment per decline | P | retry + pay links (auto-sent with failed-payment email) |
| 4 | Retry all declined; email every declined family (once/day/family) | M | |
| 5 | Invoice views with counts, kind + date filters, wider search, count/total, Show more | P | status filter only |
| 6 | CSV export of the filter (numbers stay numbers, formula-safe) | M | |
| 7 | Invoice details with state actions; void a decline writes it off and reactivates past-due membership | M | no membership-invoice void route |
| 8 | Refund all/part of a paid **membership/any** invoice with reason + receipt; refunds linked; never over-refund; counter refunds in step with POS | M | only sale refunds (`commerce.refundSale`) |
| 9 | Memberships list with views (renewing this week, trials, past due, paused, cancelled), search, plan filter, 7-day forecast, inline change/pause/resume/cancel | P | `GET /v1/subscriptions` API; actions only on client page |
| 10 | Plans: tap member count for list, add form tucked, phone table, unique live names, trials <= 90, allowances <= 100 | P | plans table + retire; trial 90 in the input |
| 11 | Retry refuses no-card family with guidance; correct membership-back wording; no next retry after last try | P | test provider refuses no-card |
| 12 | Card reminders once per family per day | M | with #4 |

### Programs (80f16a0, 302a838)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Builder one week at a time (tabs, URL), Add/Copy week to range/Delete week (incl. empty last week) | M | `viewProgram` stacks all weeks |
| 2 | Add exercise via library search, prefill from last use, add to library inline, Add and add another | M | select + free-text prescription |
| 3 | Swap exercise, copy workout to week/day, Undo remove | M | `PATCH /v1/workout-exercises/:id` exists |
| 4 | Assign: search clients, show current program, warn on move, same twice refused; Remove asks | P | assign/switch exists |
| 5 | Clients on program: done/next/last (amber after 7d)/progress bar; Send link email (front desk too) | P | names only; client page copies link |
| 6 | Programs page: workouts logged, clients on program, need a check-in, finished, recent workouts feed with notes/effort/sets; search; level filter | P | `/v1/completions` API; Today "Workouts logged" |
| 7 | New program as a copy; Duplicate program | M | |
| 8 | Exercise library: categories, search, filters (missing video, unused), usage counts, programs using it | M | |
| 9 | Fixes: delete exercise used only in deleted programs; weeks below used weeks refused; <= 7 days/week | M | verify each; day input max 7 |
| 10 | Escape closes only top modal; 44px; tablist semantics | M | polish |
| 11 | No-JSON-body 500s | N | verify new server's body parsing |

### API & integrations (ba48ec0, bf75525)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Status strip + tabs (keys, webhooks, email outbox, video) in URL | M | single page `viewIntegrations` |
| 2 | Key access levels (read only / read+send results, 403); rename/change level | M | `api_keys` has no scope |
| 3 | Per-key request log 30 days with requests/errors | P | audit log records `api_key` actor; `last_used_at` |
| 4 | Quick start copyable curl examples | P | one static example + OpenAPI link |
| 5 | `GET /v1/athletes/:code/results` (best, test, since in business tz), `GET /v1/tests` | P | `GET /v1/results`, `/v1/tests` exist; check athlete-code filter |
| 6 | Webhooks named/edited (URL, events), event meanings, Select all/Clear, duplicate URL refused (normalized) | P | PATCH (active), checkboxes |
| 7 | Send test event with realistic sample of any subscribed event | M | |
| 8 | Delivery detail (answer, time, reason, response, payload, tries) + Resend | P | deliveries list with code/error |
| 9 | All deliveries view with filters; Resend failed last 7 days | M | |
| 10 | Automatic retries with backoff | A | `events.js` `BACKOFF_MINUTES = [1,5,30,120,720]` |
| 11 | Failing mark after 3 failures | M | |
| 12 | Delivery-id header; rotate signing secret | P | `dp-event`, `dp-signature` headers; no delivery id, no rotate |
| 13 | Outbox status filters/counts, search, Copy text, Send again, send to another address | P | last 15 + test send |
| 14 | Exercise video coverage tab | M | |
| 15 | API reference with access levels, retries, rotation, copy buttons | P | generated OpenAPI 3.1 |
| 16 | Retry job single-flight, re-read before send, stuck "sending" | P | verify concurrency; no "sending" state |

### Staff & security (b909028, 939276c)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Security summary tiles (can sign in, locked, failed 24h, last backup) | M | |
| 2 | Add staff form with role explanations; turned-off email notice | P | `ROLES` text; 409 on duplicate |
| 3 | Manage panel: edit name/email, role change (confirm owner), devices, sign out everywhere, recent activity, reset/resend invite, unlock, turn off | P | unlock, reset password, turn off exist |
| 4 | Hand-over of a turned-off coach's sessions/classes/hours; flag accounts still leading; don't offer their hours | M | needs coach model |
| 5 | "What each role can do" table | P | `ROLES` strings |
| 6 | Backups: overdue warning, newest five, total size | P | list/download/back up now; thread `0x7emk` adds off-site |
| 7 | Activity log newest first | A | `listAudit ORDER BY at DESC` |
| 8 | Activity log filters (who, staff, dates), clear, CSV, typed email on failed sign-ins, phone cards | P | API `actor_id/target/failures` |
| 9 | Sign in: show password, Caps Lock warning, forgot-password emailed single-use 30-min link (same answer, 3/h, invalidated by other resets) | M | |
| 10 | First-run setup: password twice, inline checks, logged | M | verify setup flow |
| 11 | First password must differ from one-time; sign-out on forced change | A | `changePassword` refuses same; sign-out button on forced screen |
| 12 | Account page: change needs current password | A | `security.changePassword` |
| 13 | Password change signs out other devices + emails confirmation; device list; recent sign-ins | M | `sessions` has no device/IP |
| 14 | Sign-ins record time/IP/device; sessions last activity | P | audit has IP |

### Testing days and stopwatch (35461f6, 36ee5ac)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Stopwatch Cancel run/Esc, Undo last time, impossible/failed times stay with Discard/Save again, pinned on phone | P | basic Start/Stop stopwatch exists (`viewTestingDay`) |
| 2 | Typed entry: Enter/arrows down column, + attempt (cap 20), ft-in/min hints | M | |
| 3 | Previous best + PR badge per athlete | P | PR toast only |
| 4 | Rankings view per test with change from previous best | M | |
| 5 | Test tabs progress (3/4, check), arrow keys, add test mid-day | M | |
| 6 | Find an athlete; remove mistaken athlete (confirm if results) | M | walk-up add only |
| 7 | Edit day: rename/re-date, remove tests, retest these athletes, delete day | M | `PATCH /v1/testing-sessions/:id` partial API |
| 8 | Share preview (who has results / no parent email); later "email only new families" banner counting families | M | share with note exists |
| 9 | New day: retest a past day, search athletes/tests, tick all/clear, running order with remove, name from preset/team | P | hardcoded presets + checkbox lists |
| 10 | Testing list filter Open/Shared, search, progress; front desk sees who links | M | |
| 11 | One-sided range rule (screen + server 400) | M | verify `recordResults` range check |
| 12 | Archived athletes left out / refused | N | no archive |
| 13 | 44px targets | M | polish |

### Uploads, linking and devices (29e3322, 9e964db)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Recent uploads with Undo (restore replaced values, drop queued, leave changed/retimed alone) | M | `import_batches` table exists |
| 2 | Review shows new / "was ..." / Already saved / previous best / PR, summary, how file was read, filters/search | P | row cards in preview |
| 3 | Already-saved values untouched on re-upload | A | `recordResults` skips duplicates (verify timing label kept) |
| 4 | Fix and check again in place; problems as cards; download problems CSV | P | re-upload flow |
| 5 | Upload form drag-drop, size check, source choice, date locked to day | M | |
| 6 | Waiting to be linked: phone rows, Tick all, keyboard, source filter/search, clear in place, keep real source, archived refused | P | queue link/discard selected |
| 7 | Discard long list without SQLite variable limit | M | verify `discardQueue` IN-list |
| 8 | Link a device ahead (links waiting, keeps device name, says if already linked) | P | `POST /v1/athlete-links` |
| 9 | Change link athlete, Unlink with Undo, find devices, Copy API example | P | unlink exists |
| 10 | Needs-attention badge + paste new token on Hawkin failure | P | `last_error` shown |

### Test library and progress report (6ab415c, f97f4fb)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Library search, category + All/In menus/Hidden/Custom filters, sort, add search as new test | M | `viewLibrary` lists by category |
| 2 | Written protocol for every built-in test | P | `description` per test in `test-library.js` |
| 3 | Usage (results, athletes, last used) and presets containing it | M | |
| 4 | Test details + record board (best per athlete, top 10, sex/age group at time of result) | M | |
| 5 | Edit tests (attempts, range, category, protocol; custom fully until used); renames follow presets; no-op edits not logged | P | `PATCH /v1/tests/:key`; UI hide/show only |
| 6 | Delete unused custom tests | M | |
| 7 | Hide/show in place keeping focus | P | re-renders |
| 8 | Presets tab (create/edit/reorder/copy/delete, plan a day; reserved names refused) | M | `PRESETS` hardcoded in app.js |
| 9 | Report share links (7d-1y, open counts not inflated by period change, turn off, no DOB but age, expired message) | M | report needs sign-in |
| 10 | Email report to family (+ optional 90-day link) | P | share-day emails families |
| 11 | Family-view preview; "Not shared yet" markers | M | |
| 12 | Period (all / 12 months / since a day), change since first/last | M | |
| 13 | Grouped by category, accessible trend lines | P | sparkline has label |

### Education, coach side (adb7554, 65c131f)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Summary numbers (open, overdue, finished last 7 days, published) | M | |
| 2 | Assigned / Library / Recent tabs in URL, refresh in place | M | |
| 3 | Assigned search, Open/Overdue/Finished/All, overdue-first, assigned by/when | M | |
| 4 | Per-athlete status incl. Opened / Started 2 of 4 / Finished date | P | course "x of y" progress; no opened tracking |
| 5 | Assign to several athletes, quick due dates, skip existing | P | single athlete or team assign |
| 6 | Remind unfinished (12 h limit), Remind overdue (skip archived/empty rosters) | M | |
| 7 | Change assignment due date/note | M | |
| 8 | Library search, Published/Drafts filter, Publish button, Add lesson per course, opened counts | P | library + courses panels |
| 9 | Lesson detail (finished/opened/assigned), Duplicate | P | preview/edit/delete exist |
| 10 | Editor keeps unsaved text; Escape closes only preview | M | |
| 11 | Validation: drafts/empty courses/ended teams/archived not assignable, due dates, minutes, title length, foreign ids in reorder, move-to-end, 404 on missing, publish logging | M | verify each in `engage.js` |

### Athlete app: Workout tab (c23e790, 31743d4)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Exercise opens in place with demo, cues, last time's numbers, best weight | P | demo + cues for current exercise |
| 2 | Log every set (weight/reps, defaults, add/edit/clear), rep ranges/per-side parsing | M | one tick per exercise (`client.js`) |
| 3 | Last set marks done and opens next | M | |
| 4 | Rest timer (+/-15, skip, buzz, off switch) | M | |
| 5 | Offline queue, retries on 5xx/429, Finish waits for in-flight send | M | |
| 6 | Effort 1-10 before Finish; confirm finishing with exercises left | M | |
| 7 | Done screen: sets, time, effort, new bests | M | "Workout logged" + next |
| 8 | Reopen a finished workout (2 h, before next), survives reload | M | |
| 9 | Coming up: next three workouts | M | |
| 10 | Finished workouts expand with sets/effort/note | M | |
| 11 | Coach feed + `workout.completed` webhook include effort/sets/bests | M | |
| 12 | Screen-reader announcements batched, focus kept | P | `aria-live` count only |
| 13 | Next-workout day in business tz | N | verify `programs.clientHome` |
| 14 | Weights from tested max / lighter day | A (not ours) | new base feature; must merge with set logging |

### Athlete engage tabs: Accountability, Performance, Education (452fe44, 68962e7)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Reply to coach messages (app + portal), coach emailed, shown under message, 20/day, shown to coach on profile | A | 1a48ce1: `engage.js` replies, `/v1/replies`, Today `replies` item, "Seen" |
| 2 | Reply logged in activity with athlete/parent actor names; non-text refused | P | verify audit actor names |
| 3 | Parents have their own read state (parent reading doesn't clear athlete's) + upgrade copy | M (bug present) | `/portal/api/athletes/:id/messages/read` calls `engage.markRead(client)` -> `message_reads(client_id)` |
| 4 | New-messages banner jumping to them; five at a time with Show older | P | "New" badge + tab dot |
| 5 | Goal day strip to tick a missed day this week; last week's result; weeks in a row per goal | M | |
| 6 | Check-in streak shows best run | P | current streaks shown |
| 7 | Same as yesterday | M | |
| 8 | Recent check-ins (last 7 days) side by side, amber flags | M | |
| 9 | Tap a calendar day for workouts/sessions/check-in | M | 28-day calendar exists |
| 10 | Targets say "0.13 s to go" / "2 ft to go", amber past date | M | |
| 11 | Tap a test for every result with change/best; PR marked | P | |
| 12 | Education: open first, Show finished, Read/Start/Continue with next lesson name, search >= 6, Back after last lesson, course-finished message | P | Continue/Start/Read buttons; certificates exist |
| 13 | Parent wording ("From Ava's coach") | A | `engage-view.js` audience `parent` |
| 14 | `/app#education` style links switch tabs while open | M | |
| 15 | Workouts dated in business tz (calendar, streaks, weeks) | A | `engage.js` `localDate(r.at, tz)` |
| 16 | Bad due dates crash; target date validation; 404 on missing target | N | verify `isDate` use; likely fine |
| 17 | 44px day cells, "Done" wording | M | polish |

### Parent portal: sign-in and Home (962181f, f891f27)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Remember email on phone; "No email?" help | M | |
| 2 | Honest "if this email is on file" wording | A | `families.js` "If that email has an account..." |
| 3 | Resend unlocks after 30 s; paste whole line keeps code | M | |
| 4 | Codes limited per email and per network | A | 3 per 10 min per guardian; `portal:<ip>` 20/15 min |
| 5 | Unknown emails answer the same on verify | A | `verifyCode` throws the same 401 |
| 6 | 15 wrong codes an hour lock sign-in | P | per-code `MAX_ATTEMPTS` only |
| 7 | Parent sign-ins (and failures with IP) in activity log | A | audit logs parents |
| 8 | Session rows Today/Tomorrow, coach, waitlist place, late-cancel window, On now/Checked in | P | waitlist tag, late warning on cancel |
| 9 | Session details dialog (range, address + Directions, how paid, Add to calendar, Cancel) | M | |
| 10 | Private calendar subscription feed with reset | M | |
| 11 | Needs-a-look per athlete (messages, lessons, overdue amber, no check-in), one tap each | P | engagement line + dots |
| 12 | Renewal/trial end date, "left this month", attended last 30 days | P | plan + credits stats |
| 13 | Expired / expiring card banners (MM/YY variants) | M | no-card banner only |
| 14 | Fold bookings after four, stat sizing, 44px | M | polish |
| 15 | Started session can't be cancelled (server) | A | `schedule.cancelBooking` `!isCoach && starts_at <= now` |
| 16 | Add-to-home-screen card, manifest shortcuts, refresh after 5 min away, offline bar | P | `parent.webmanifest` exists |

### Parent portal: Book (622710a, 56d38a9)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Class details dialog | M | |
| 2 | Cancel booking / leave waitlist from Book; place in line; waiting count | P | cancel from Home |
| 3 | Filter to one class, keep scroll, no full reload on athlete/kind switch | M | |
| 4 | Camps once with days/price, register from Book in one step, closed says so | P | Register jumps to Programs tab |
| 5 | No overlapping bookings incl. waitlist (server), reason shown; staff warned not blocked | M | |
| 6 | Privates/evals: pick a coach, coach per time, later dates on demand | M | needs coach model |
| 7 | Note for the coach (emailed); see and cancel booked privates/evals | M | |
| 8 | Cancelling a private/eval reopens the time, refunds/returns credit, tells coach, in one transaction | M (bug present) | `bookSlot` makes a `class_sessions` row that stays `scheduled` after cancel -> time blocked |
| 9 | Pay for a single private when none left | P | 402 -> `offerCard` if price set |
| 10 | Missing/declined card dialog with return to Book | P | toast |
| 11 | Waiver banner on Book | A | `banners()` |
| 12 | Free evaluation wording, focus on Close, notes clamped | M | polish |

### Parent portal: Progress and Programs (77d302d, 3cce55f)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Next (or today's) testing day at the top | M | |
| 2 | Summary (tests, new PRs, last testing date) | P | new PRs line |
| 3 | Period + Change since (remembered) | M | |
| 4 | Biggest improvements with from/to; PR tiles with dates | P | percent tiles |
| 5 | Coach targets and rankings on Progress | P | in Home > Performance tab |
| 6 | Tap test: what it measures, every result, how it's tested | M | |
| 7 | Body measurements neutral (not better/worse) | P | verify `better:'none'` handling |
| 8 | Feet and inches display | A | `fmtResult` ft/in |
| 9 | Growth: change since first + trend line | P | height, growth/yr, PHV estimate |
| 10 | Share link to report from the tab; printable follows period | P | printable report link only |
| 11 | Empty state with next testing day / Book evaluation | P | |
| 12 | Programs: which card, expired-card banner, add/update card returns here | P | card panel on Family |
| 13 | Declined card opens Update card, "nothing was charged" | M | |
| 14 | Membership panel (status, trial end/next charge, classes left, privates) | P | Home stats |
| 15 | Ask to switch/pause/cancel (owner emailed, logged, shown; shown on client profile; paused can't pause again) | M | portal can only start a membership |
| 16 | Camps: spots left, deadline warnings, siblings registered, full refused before charge, registered stay listed | P | verify full-camp check |
| 17 | Weekly classes next session; held spots next booked + count | M | |
| 18 | Hold spot asks first; non-member explanation + link to plans | P | subtitle explanation |
| 19 | Packs show per-session price and savings | M | |
| 20 | After purchase return to same section | M | |

### Parent portal: Family and card (f502f1d, ae6cccc)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | To-finish list (waiver, card, expired card, declined payment, emergency contact, birthday) | P | banners for terms/waiver/card |
| 2 | Card expiry amber; declined membership payment with Try again (hidden after 8 tries) | P | pay links for failures |
| 3 | New card retries every past-due charge | A | `billing.retryWithNewCard` |
| 4 | Remove card (asked, refused while used) | M | parent side |
| 5 | Payments list with printable receipts, total paid this year (business tz), Show all | M | |
| 6 | Card page: past-due amount, expiry and Amex CVC checks | N | Stripe-hosted setup page; past-due line could go on Family |
| 7 | Other parents emailed on card/parent changes | M | |
| 8 | Waiver compact signed state, athletes covered, Email me a copy (tz date) | P | signed-by line |
| 9 | Athlete cards: age/sport/membership/Needs badge, ID copy, Manage membership, grouped fields, copy sibling's emergency contact, Save enabled on change, stays open | P | athlete edit form exists |
| 10 | Refuse duplicate athlete names (also rename), short phones, > 12 athletes / > 6 parents | M | verify |
| 11 | Parents: edit own name/phone; add parent with in-form errors | M | portal says to ask the coach to add a parent |
| 12 | Other signed-in devices, sign out everywhere else | M | |

### Cross-tab fixes (0aff45c, 92d6126, 8a91dbe)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | Cancelled drop-in refunds its own sale so POS/Today drop with Billing; never double refund | A | `schedule.js` release -> `commerce.refundSale` for succeeded sale |
| 2 | Upload review PR count = save count | M | verify preview PR logic |
| 3 | Today workouts tile = Programs count (archived excluded) | N | no archive |
| 4 | Failed-payment note wording ("this month") | P | Today says "at risk this month" for all months (verify) |
| 5 | Parent Home attended count = profile | N | neither shows it |
| 6 | Human dates in emails ("Tue, Sep 29 at 6:00 PM", "September 2026") | A | `schedule.js` `when(ctx, ...)`; verify membership-charge wording |
| 7 | School invoice/statement emails give mailing address | P | `business_address` setting |
| 8 | Dashboard signed-out check doesn't log a 401 | M | verify |
| 9 | Indexes for athlete/family/contract lookups | P | 32 indexes; verify `clients(family_id)`, `team_roster(contract_id)` |
| 10 | One business day everywhere | P | `localDate`/`today(ctx)` widely used; `access.js#startOfDay` is server-local |
| 11 | Membership requests on the client profile | M | depends on Progress/Programs #15 |
| 12 | Front desk not offered "Link them" (queue page they can't open) | M (bug present) | `viewToday` `results_waiting` links all roles; `/v1/queue` not in FRONT_DESK |
| 13 | Email app link from client profile (same email as Programs Send link) | P | copy/reset link only |
| 14 | Staff booking over another session: allowed with "also booked then" warning | M | |

### CRM (a4abb1c, b2cffe9, 50e9179, 69f59f5, 5ab6784, d6b36a2)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | New-client rules in one service shared with lead conversion | P | `services/clients.createClient` exists; no staff "convert" |
| 2 | Duplicate checks vs leads and families by email **and phone**; pre-check endpoint so form warns | P | open-lead email check; guardian email -> "you have an account" email |
| 3 | Stages New, Contacted, Evaluation booked, Trial, Member, Lost (required reason) | P | stages differ (`signed_up`, no `trial`); `lost_reason` optional |
| 4 | Stage history, days in stage, stale after 7 days (business tz) | M | |
| 5 | Automatic moves from real data | A | `leads.advance()` (evaluation, member; no trial stage) |
| 6 | Convert lead: create family, link, carry notes, book held evaluation; carry text OK only for the same number | M | |
| 7 | Re-engage families whose trial ended without joining; re-engaged lead doesn't revive old lost lead | P | campaigns `lapsed` group |
| 8 | Tasks (assignee, due, overdue/today on Today, My tasks) | M | |
| 9 | Timeline for leads and families (payments owner-only) | M | |
| 10 | One-to-one email and text from a lead/family with templates, length, signed unsubscribe, 10k limit | P | automatic follow-up templates (fixed text) |
| 11 | Group/segment emails honoring opt-outs, once per address | A | `campaigns.js` + `email_optouts` |
| 12 | Opt-outs follow the address across leads and parents | A | `email_optouts` keyed by email (NOCASE) |
| 13 | CSV import (row errors, preview) and export of leads | M | client import exists (`client-import.js`) |
| 14 | Reports by period | P | 30-day counts + Monday digest inquiries |
| 15 | Public enquiry form + JSON, honeypot, rate limit, owner email | A | `/start`, `leads.submitInquiry`, `inquiry:<ip>` 10/h |
| 16 | Global cap on enquiries (60/10 min) and trust-proxy 1 hop | M (bug present) | `server.js#clientIp` with `TRUST_PROXY=true` takes the **first** X-Forwarded-For entry (spoofable) |
| 17 | Web form can't switch on texts for an existing lead's phone | A | 100505c |
| 18 | Leads in the open API | A | `/v1/leads*` |
| 19 | `lead.created` / `lead.stage_changed` webhooks | A | `lead.created` / `lead.updated` (name differs) |
| 20 | Roles: front desk works leads + own tasks, no reports/group/import/money; coaches no CRM | P | front desk list/add/edit leads; **coaches have full lead access** except delete (policy decision) |
| 21 | Pipeline board with keyboard/phone Move menu | M | |
| 22 | Lead list search, filters, sort; stale amber; trials that ended | P | stage chips |
| 23 | Lead page: call, log call, note, email, text, book evaluation, move stage, tasks, contact preferences, convert, timeline | P | stage, notes, "I reached out", stop follow-up, delete |
| 24 | Group messages screen (preview who gets it/left out, send) | A | `viewCampaigns` preview/test/confirm-count |
| 25 | Settings: website form embed, enquiry emails, templates, texting | P | form link + Book-now embed + follow-up toggle; no templates |
| 26 | Client profile contact history with Email, Text, Add task, Put back in pipeline | M | |
| 27 | Text outbox with simulated reply in test mode | P | Texts panel; no simulated inbound |

### SMS groundwork (in b2cffe9 / d6b36a2)
| # | Item | Class | Notes |
|---|---|---|---|
| 1 | `sendSms` with SMS outbox, test mode until provider configured | A | `sms.sendText` + `texts` + `smsMode` |
| 2 | E.164 phones on leads; E.164 copy on parents (triggers), existing numbers migrated | P | `normalizePhone` on lead/opt-in writes; no parent copy/migration |
| 3 | Consent + STOP/START/HELP, Twilio signature | A | `handleInbound`, `verifyTwilio` |
| 4 | Staff texting from lead/family page (templates, length, test-mode note, held notice) | M | automatic texts only |
| 5 | API-created text consent labelled with source | M | |

## 3. Counts

| Area | A | P | M | N | Total |
|---|---|---|---|---|---|
| Today | 0 | 5 | 5 | 1 | 11 |
| Schedule/roster/hours | 1 | 3 | 13 | 1 | 18 |
| POS | 2 | 5 | 7 | 1 | 15 |
| Clients | 2 | 5 | 11 | 0 | 18 |
| Teams/invoice | 0 | 7 | 7 | 0 | 14 |
| Billing | 0 | 7 | 5 | 0 | 12 |
| Programs | 0 | 3 | 7 | 1 | 11 |
| API & integrations | 1 | 9 | 6 | 0 | 16 |
| Staff & security | 3 | 6 | 5 | 0 | 14 |
| Testing days | 0 | 3 | 9 | 1 | 13 |
| Uploads/linking/devices | 1 | 6 | 3 | 0 | 10 |
| Test library/report | 0 | 5 | 8 | 0 | 13 |
| Education (coach) | 0 | 4 | 7 | 0 | 11 |
| Athlete app workout* | 1 | 2 | 10 | 1 | 14 |
| Athlete engage tabs | 3 | 5 | 8 | 1 | 17 |
| Parent Home/sign-in | 5 | 5 | 6 | 0 | 16 |
| Book | 1 | 4 | 7 | 0 | 12 |
| Progress/Programs | 1 | 11 | 8 | 0 | 20 |
| Family/card | 1 | 4 | 6 | 1 | 12 |
| Cross-tab | 2 | 5 | 5 | 2 | 14 |
| CRM | 8 | 11 | 8 | 0 | 27 |
| SMS groundwork | 2 | 1 | 2 | 0 | 5 |
| **Total** | **34** | **116** | **153** | **10** | **313** |

(*) athlete-app "A" is the new base's own weights-from-max feature, listed so the set-logging port merges with it. Rows marked "(bug present)" are real defects in the new base the old work already fixed (coach money leaks in sales and schedule, server-local "today" in dashboard takings, private cancel keeps time blocked, any session blocks all private hours, shared parent/athlete message reads, front desk "Link them", team attendance before join date, spoofable X-Forwarded-For). Many rows say "verify": cheap spot checks were done where noted; the rest need a 1-minute check during the batch.

## 4. Port plan (ordered batches)

Conventions for every batch: add endpoints to `routes.js`/`portal-routes.js` **and** `security.js` role lists; schema changes via `schema.sql` + `db.js` (bump `SCHEMA_VERSION`, `ADDED_COLUMNS`/`ADDED_TABLES`); tests in `test/<area>.test.js`; keep zero deps; UI in the existing `view*` functions.

| # | Batch | Items | Main files | Size | Conflict with competitor-roadmap / threads |
|---|---|---|---|---|---|
| B0 | **Bug fixes already found** (small, high value, ship first) | Coach/front-desk money leaks (sales list, schedule/session prices, activity feed), business-day `startOfDay`, private cancel frees the slot + per-slot blocking only by the same coach/location, parent message reads separate from athlete, front desk "Link them", `TRUST_PROXY` hop count + global inquiry cap, team attendance from join date | `routes.js`, `access.js`, `commerce.js`, `schedule.js`, `engage.js` (+`message_reads` guardian table), `server.js`, `teams.js`, `app.js` (Today) | M | `engage.js`, `schedule.js`, `access.js`, `app.js` are hot on competitor-roadmap (engage +375 lines, app.js +516) -> land after it merges, or rebase daily |
| B1 | **Prerequisite data model**: coaches on class series/sessions/availability (`coach_id` -> users), client archive (`clients.archived_at` + filters in every list/job), `client_notes` table | enables Schedule #1/2/4/12/15/17, Book #6, Staff #4, Clients #4/#11, Today #2, Testing #12 | `schema.sql`, `db.js`, `schedule.js`, `clients.js`, `security.js`, `seed.js` | M | schema version collides: competitor-roadmap at v29, thread `ai1wy7` uses v13 (collides with texts v13). Coordinate a single version sequence |
| B2 | **Schedule + roster + hours** | Schedule #1-13, #16; Cross-tab #14 | `schedule.js`, `app.js#viewSchedule/viewSession/viewScheduleSetup`, `notify.js` | L | competitor-roadmap touched `viewSession` (TV screen panel), `viewScheduleSetup` (check-in, digest, texts panels), `schedule.js` (`withLock` booking) -> high conflict |
| B3 | **Today** (check-in panel, follow-ups with snooze, birthdays, activity filters) | Today #1-10 | `access.js#dashboard`, new `today_snoozes`, `app.js#viewToday` | M | competitor-roadmap adds at-risk, spots, low stock, replies, leads to Today -> extend `insights.js` at-risk instead of a separate follow-up list |
| B4 | **Clients** (views/counts, flags, CSV, duplicate checks, notes, attendance, book/cancel from profile, family edits, unsaved guard) | Clients #1-17; Cross-tab #11, #13 | `clients.js`, `families.js`, `app.js#viewClients/viewClient/viewNewClient` | L | `viewClient` got pay links, badges, replies on competitor-roadmap -> medium conflict |
| B5 | **POS** (discounts, receipts, undo, takings, recent filters, phone flow, setup) | POS #2-13 | `commerce.js`, `app.js#viewSell/viewSetup`, `notify.js` | M | `commerce.js` changed for `withLock`, inventory variants, online sales; `viewSell` got sizes -> medium |
| B6 | **Billing** (summary, needs-attention, invoice views/CSV/detail/void, invoice refunds, memberships list, plans) | Billing #1-12 | `billing.js`, `app.js#viewBilling` | L | competitor-roadmap added pay links + money checks panels in `viewBilling`; thread `vrx31w` edits `billing.js`/`commerce.js` (Stripe webhooks, dashboard refunds) -> **invoice refunds must reuse vrx31w's refund handling** |
| B7 | **Teams** (statements, multi-invoice payment, roster pre-check/link/undo, contract length follows sessions, restart billing, date checks) | Teams #1-14 | `teams.js`, `app.js#viewTeams/viewNewTeam/viewTeam`, `invoice.js` | M | low (competitor-roadmap barely touched teams) |
| B8 | **Programs builder + athlete Workout tab** (week tabs, library search, swap/copy/undo, duplicate, library filters; set logging, rest timer, offline, effort, reopen, coming up) | Programs #1-10; Workout #1-12 | `programs.js`, `app.js#viewPrograms/viewProgram`, `client.js`, `workout_logs` + new `workout_sets` | L | competitor-roadmap added `load_test/load_pct`, readiness drop, TV logging (`screen.js`, `workout_logs.assignment_id` nullable) -> set logging must feed TV logs and loads; high conflict in `programs.js`/`client.js` |
| B9 | **Testing day + uploads + devices** | Testing #1-11, #13; Uploads #1-10; Cross-tab #2 | `performance.js`, `uploads.js`, `queue.js`, `app.js#viewTestingDay/viewNewTesting/viewTesting/viewQueue/viewUpload/viewConnections` | L | competitor-roadmap added progress-notes panel to `viewTestingDay` -> low-medium |
| B10 | **Test library, presets, report share links** | Library #1-13 | `test-library.js`, `reports.js`, new `test_presets`, `report_links`, `app.js#viewLibrary`, `report.js` | M | low |
| B11 | **Education coach + engage tabs** (tabs, multi-assign, reminders, opened tracking; missed days, goal history, same as yesterday, day details, target gaps, Show older, hash links) | Education #1-11; Engage #2-12, #14, #17 | `engage.js`, `engage-coach.js`, `engage-view.js` | L | **highest conflict**: competitor-roadmap rewrote much of `engage.js` (replies, readiness, badges, milestones, quizzes, certificates, parent education). Port only after it merges |
| B12 | **Parent portal Home/sign-in/Book** (session details, calendar feed, card banners, sign-in UX + hourly lock, class details, cancel in Book, overlap checks, coach choice + notes, camps in Book) | Home #1, #3, #6, #8-14, #16; Book #1-10, #12 | `parent.js`, `portal-routes.js`, `families.js`, `schedule.js` | L | competitor-roadmap added texts, parent education, shop, check-in to portal -> medium in `parent.js`/`portal-routes.js` |
| B13 | **Parent Progress/Programs/Family** (periods, test details, share links, membership panel + requests, camp info, packs value, payments/receipts, remove card, parent edits, devices, other parents emailed) | Progress #1-20; Family #1-12 | `parent.js`, `portal-routes.js`, `reports.js`, `families.js`, new `membership_requests` | L | medium (shop/online programs panel added in Programs tab) |
| B14 | **API & integrations + Staff & security** (tabs/status strip, key scopes, request log, test events, delivery detail/resend, rotate secret, outbox tools, video coverage; security summary, manage panel, hand-over, forgot password, devices, log filters/CSV) | API #1-16; Staff #1-14 | `events.js`, `security.js`, `access.js`, `app.js#viewIntegrations/viewStaff`, `server.js` | L | threads `ai1wy7` (job runs in `server.js`, `security.js`) and `0x7emk` (backups panel) touch the same screens -> land after them |
| B15 | **CRM on top of leads.js** (stage history + days in stage + stale, trial stage + required lost reason, phone duplicate checks + pre-check, convert via `createClient`, tasks, timeline, one-to-one email/text with templates, lead CSV import/export, reports, pipeline board, lead page, client contact history, simulated inbound text, role split) | CRM #1-4, #6-10, #13-14, #16, #20-23, #25-27; SMS #2, #4, #5 | extend `leads.js` (+`lead_stage_history`, `crm_tasks`, `timeline` or `contact_log`, `message_templates`), `sms.js`, `campaigns.js` (reuse for segment sends), `app.js#viewLeads`, `security.js` | L | **direct overlap** with competitor-roadmap's leads/SMS/campaigns: rename our stages to theirs (`signed_up`) or migrate; keep `lead.updated` event name (add `stage_changed` as alias); don't port our `messaging.js`/`crm.js` wholesale |

Suggested order: B0 -> B1 -> B7 (low conflict, warms up) -> B10 -> B9 -> B4 -> B5 -> B6 (after vrx31w) -> B2/B3 -> B12/B13 -> B8 -> B14 (after ai1wy7/0x7emk) -> B11 -> B15 (after competitor-roadmap merges). Rough total: 3 S/M-sized + 12 L/M-sized batches.

## 5. Key risks
1. **Structural gaps, not just UI**: the new base has no coach assignment and no client archive. Roughly 30 items depend on them (B1). Adding `coach_id` also changes `openSlots` semantics and the public Book-now page (`booknow.js`).
2. **Schema version collisions**: competitor-roadmap is at v29; thread `ai1wy7` independently takes v13 (already used by texts). Every batch must take the next number at merge time; agree on one owner of `SCHEMA_VERSION`.
3. **One big `app.js`**: every coach batch edits the same 240 KB file the other session is editing (+516 lines). Expect textual conflicts on nearly every batch; small, frequent rebases.
4. **engage.js / programs.js / client.js** were reworked on competitor-roadmap (replies, readiness loads, badges, quizzes, TV logging). B8 and B11 must be re-designed against that code, not replayed.
5. **CRM duplication risk**: competitor-roadmap already has leads, follow-up, texts, campaigns and opt-outs with different stage names and event names. B15 must extend those tables/services; the old `crm.js` (75 KB) and `crm.js` screen (88 KB) cannot be copied.
6. **Payments overlap**: invoice refunds, voids and card retries (B6) overlap thread `vrx31w` (Stripe webhooks: renewals, dashboard refunds, disputes) and competitor-roadmap's `withLock` double-charge protection and pay links; reuse their locking and refund paths.
7. **Policy differences to confirm with the owner**: coaches currently have CRM access in the new base (old work: none); new base "Active clients" is by subscription status (old: archive flag); old work's front-desk permissions were stricter in places.
8. Old-code-only review fixes (no-body 500s, listener stacking, phone layout) are N/A but their tests are a useful checklist; do not port tests blindly (CommonJS vs ESM, different fixtures).
