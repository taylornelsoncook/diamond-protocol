# Architecture

Node 22 + Express 5 + built-in SQLite (`node:sqlite`). No build step: the browser loads ES modules straight from `public/`.

```
server/
  index.js          app, static pages, route autoload, background jobs
  db.js             schema (all tables), all/get/run/insert/update/tx helpers, setting()/setSetting()
  lib.js            HttpError/bad/notFound, h() async wrapper, sendEmail (outbox), log (activity), emit (webhooks),
                    payments (test-mode processor), money/date helpers, makeAthleteCode, nextInvoiceNumber
  messaging.js      texts (SMS): sendSms() saves to the SMS outbox, then the provider adapter sends (Twilio behind DP_SMS_PROVIDER;
                    test mode otherwise); E.164 phones (parents.phone_e164 kept by triggers), message length, inbound records
  auth.js           staff password sign-in + lockout, parent emailed-code sign-in, sessions, requireStaff(...roles),
                    requireParent, requireApiKey, hashPassword/tempPassword/welcomeStaffEmail
  services/billing.js  charge(), refundInvoice(), applyProduct(), memberships (start/status/changePlan), renewDue(), retryFailed()
  services/clients.js  createClient() (New client and converting a lead), client notes, visits
  services/crm.js      leads, stages and automatic moves (syncStages), conversion, re-engage, tasks, timelines, templates,
                       signed unsubscribe links, consent and STOP/START/HELP, segments and group messages, enquiry form,
                       CSV import/export, reports
  services/booking.js  nowLocal(), generateEvents(), book(), cancelBooking(), cancelEvent(), checkIn(), promoteWaitlist(),
                       openSlots(), bookSlot(), registerCamp()
  routes/NN-area.js each exports { routes(api), jobs?: [{ name, everyMin, run }] }; `api` is mounted at /api
  seed.js           base data (settings, 78-test library, presets) + demo data; seeds/NN-area.js add area demo data via seed()
public/
  css/dp.css        design tokens + components (.btn .panel .metric .badge .table .field .input .tabs .banner .modal …)
  js/ui.js          html`` (auto-escaping), mount, api.get/post/put/patch/del, money, fmtDate/fmtTime/fmtDateTime, relTime,
                    badge(status), icon(name), toast, modal, confirmDialog, formData, options, sparkline, age, fullName
  coach/            staff dashboard; app.js = shell, nav by role, router; screens/*.js export routes
  parent/           parent portal (/parent)
  workout/          athlete workout app (/w/:token)
  shared/           report.html (/report/:code), invoice.html (/invoice/:token), api-docs.html (/docs/api)
```

## Conventions

- **Roles.** `owner` sees everything. `coach` runs clients, schedule, testing and programs but never sees money
  (no revenue, prices of memberships, invoices, refunds). `frontdesk` handles check-ins, sales, bookings and entering
  results; can view schedule, programs and test library but not change classes, programs or tests.
  Enforce on the server with `requireStaff('owner','coach')`; hide on the client with `ctx.me.role`.
- **Screens.** `export const routes = [{ path: '/clients/:id', nav: 'clients', title: 'Client', roles?: [...], render: async (ctx) => {...} }]`.
  `ctx = { el, params, query, me, settings, go(path), reload(), isCurrent() }`. Render into `ctx.el` with `mount(ctx.el, html\`...\`)`,
  then bind events on elements inside `ctx.el`. Links inside the app are plain `<a href="/app/...">` (the router intercepts).
  Every screen starts with `.page-header` (`.page-title` uppercase display + `.page-sub`) and optional one primary action.
- **Money** is integer cents everywhere. Format with `money()`.
- **Times.** Events store local wall-clock `YYYY-MM-DDTHH:MM` in the business time zone (`booking.nowLocal()`).
  Other timestamps are UTC ISO / SQLite `datetime('now')` (UTC).
- **Errors.** Throw `bad('Plain sentence the user can act on.')`; the UI shows `err.message` in a toast or inline.
- **Every change** that matters calls `log(req, 'Verb phrase', 'detail')` so it shows in Recent activity and the activity log.
- **Email** goes through `sendEmail(to, subject, body)`: logged in the outbox; relayed when `DP_EMAIL_WEBHOOK` is set.
- **Texts** go through `messaging.sendSms(to, body, { leadId, familyId, parentId, sentBy })`. Check consent first (`crm.textBlock`): an OK to text on file and no STOP. A number that replied STOP is refused by `sendSms` itself.
- **Email consent** follows the address: `crm.emailOptedOut(email)` is true when any lead or parent with it unsubscribed; check it (or `crm.sendLeadEmail`/`sendFamilyEmail`, which do) before any CRM email.
- **Client IPs.** `trust proxy` is 1 hop (Render); set `DP_TRUST_PROXY` for another setup. Never trust a raw X-Forwarded-For.
- **CRM roles.** Owners and front desk only (`requireStaff('owner','frontdesk')`); reports, group messages, import/export, settings and prices are owner-only; the front desk sees only their own tasks.
- **Payments** go through `services/billing.charge()` (test mode: cards ending 0002 decline). Live Stripe replaces `lib.payments`.
- **Voice** (docs/brand.md): direct, calm, specific. Sentence case. Buttons say what happens. No exclamation marks, no emoji.
- **Look**: dark ground, `surface` panels outlined in `line`, one green primary button per view, amber for problems.
  Reference screenshots of every screen are in `docs/screenshots/`.

## Demo sign-ins (npm run demo)

owner@demo.test / demo-owner-2026 · coach@demo.test / demo-coach-2026 · desk@demo.test / demo-desk-2026 ·
parents sign in at /parent with e.g. maria.lopez@example.com (the code shows on screen in test mode).
