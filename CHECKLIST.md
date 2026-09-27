# Your checklist

Everything that needs your identity, your money, your hardware or your decisions. Work top to bottom: the first section has the longest waits, so start it today.

## 1. Start today (these involve waiting on others)

- [ ] **Business entity and EIN.** Apple requires a legal business (LLC or corporation) for an organization developer account. If you're a sole proprietor, talk to your accountant about forming an LLC first.
- [ ] **D-U-N-S number** for your business. It's free and Apple needs it to verify you. Request it through Apple's lookup tool at developer.apple.com/enroll/duns-lookup; issuing it can take several business days.
- [ ] **Apple Developer Program, enrolled as an organization** ($99/year) at developer.apple.com/programs/enroll. Use the business, not your personal name.
- [ ] **Request the Tap to Pay on iPhone entitlement.** Signed in as the account holder, request it at developer.apple.com (search "Tap to Pay on iPhone entitlement"). Use bundle ID `com.diamondprotocol.coach`, or tell me the one you want. Apple reviews these requests.
- [ ] **Stripe account** at stripe.com. Finish business verification and add your bank account for payouts.
- [ ] **Turn on Stripe Terminal** (in-person payments) in the Stripe Dashboard.

## 2. Decisions only you can make

- [ ] **Prices:** single session, packs (sizes and prices), gear, and monthly plans with trial length. The app ships with sample prices. Replace them in Point of sale setup and Billing.
- [ ] **Addresses** for every place you take payments: the facility, your business address (used for the "Mobile" location that covers clients' homes), and each park you train in.
- [ ] **Policies:** refunds, pack expiration (packs don't expire in the app today), cancellations, and failed payments (today: retry every 3 days, cancel after 4 failures).
- [ ] **Sales tax.** The app doesn't add tax. Ask your accountant whether you owe tax on sessions or gear in your state, and tell me what to build.
- [ ] **Waiver.** Have a lawyer write your release of liability, medical consent and photo policy. Paste it in Schedule → Hours & settings.
- [ ] **Class schedule:** each weekly class (days, time, location, ages, spots, drop-in price), your camps and clinics (dates, registration price), and your hours for privates and evaluations.
- [ ] **Group vs private pricing:** which packs count as group classes and which as privates, and whether memberships cover group classes only (today: yes).
- [ ] **Cancellation window** for parents (default 12 hours).
- [ ] **Team contracts:** for each school or club, the monthly fee, billing day, payment terms (Net 30 is the default), PO number if they use one, and the billing contact's email. Add your business address and "make checks payable to" line in Schedule → Hours & settings; both print on invoices.
- [ ] **Testing equipment:** tell me what you use (timing gates, jump mat, force plates, radar) so I can check each export imports cleanly. Send one real export file from OVR Connect (and any other system) so I can confirm the column matching.
- [ ] **Use Athlete IDs on your devices:** in OVR Connect (and any other testing app), enter each athlete's ID (for example AVALOP2026) as their name or ID. Exports then match automatically with no name-matching step.
- [ ] **Hawkin Dynamics (if you use it):** as the organization admin in Hawkin, go to Settings → Integrations, create an integration token, and paste it in Testing → Devices & imports.
- [ ] **VALD (if you use it):** email support@vald.com with your organization ID from VALD Hub to request external API access. Until then, export files from VALD Hub and import them.
- [ ] **Card-saving consent.** The app asks you to get the client's OK before saving a tapped card. Decide what you'll say, or add a line to your client agreement.

## 3. Equipment

- [ ] **A Mac** with Xcode 16 or newer to build the iPhone app. Any recent Mac works; a Mac mini is the cheapest option.
- [ ] **An iPhone that supports Tap to Pay** (check Stripe's supported-device list), on the latest iOS.
- [ ] **Optional: a front-desk smart reader** (Stripe Reader S710 or WisePOS E), ordered from the Stripe Dashboard under Terminal. The facility can also use your iPhone.

## 4. Test with fake money (do these with Claude Code on your Mac)

- [ ] Unzip the project and run `npm run seed` then `npm start`. Click through Point of sale with the built-in test mode.
- [ ] Put your Stripe **test** keys (`sk_test_...`) in `.env`, restart, and run a sale from the dashboard.
- [ ] Install the Stripe CLI and run `stripe listen --forward-to localhost:3000/stripe/webhook`. Put the `whsec_...` it prints in `STRIPE_WEBHOOK_SECRET`.
- [ ] Build the iPhone app (see `ios/README.md`). Test with "Use simulated reader" on.
- [ ] Once Apple approves the entitlement: test a real tap on your iPhone with simulated reader off, still on test keys.

## 5. Legal and policies (before anyone signs up)

You'll be storing children's names, birthdays, medical notes and parents' payment details. Have a lawyer look at these; I'll build the pages and consent tracking once you have the wording.

- [ ] **Terms of service** for families and schools: what you provide, payment terms, cancellations, refunds, and account closing.
- [ ] **Privacy policy:** what you collect (athlete profiles, medical notes, test results, contact details), why, who can see it (your staff by role, Stripe for payments, Resend for email, your host), how long you keep it, and how a parent can ask for a copy or have it deleted. Ask your lawyer which children's privacy rules apply to you, since parents enter their kids' information.
- [ ] **Waiver** (from section 2), finalized by your lawyer.
- [ ] **Card-saving consent wording** (from section 2).
- [ ] **Insurance:** confirm your liability coverage includes training minors at your facility, parks and clients' homes.
- [ ] **Paste the terms and privacy policy** into Schedule → Hours & settings. They appear at `/terms` and `/privacy`, new families agree to them at sign-up, and changing them later asks every parent to accept again.
- [ ] **Ask your accountant** how long you must keep payment records. When a family asks to be deleted, the app keeps payments and invoices with no names attached.

## 6. Accounts and domain

- [ ] **Domain name** for the app, for example `app.diamondprotocol.com` (a subdomain of your main site works well).
- [ ] **Email sending:** create a Resend account (resend.com), verify your domain by adding the DNS records it gives you, then keep the API key handy. Parents can't sign in until email works.
- [ ] **Stripe live mode:** business verification complete, bank account added, live keys available (`sk_live_...`).
- [ ] **A private GitHub repository** with the project in it (Claude Code can set this up with you).
- [ ] **Hosting account** (Render is simplest). It needs a paid plan with a persistent disk.

## 7. Put it online (follow DEPLOY.md, ideally with Claude Code)

- [ ] Deploy with `render.yaml` (or `fly.toml`), one instance with a disk at `/data`.
- [ ] Set the settings DEPLOY.md lists: `PUBLIC_URL`, `BUSINESS_TZ`, Stripe live keys, Resend key and `EMAIL_FROM`, and `ADMIN_EMAIL` + `ADMIN_PASSWORD` for the first start only.
- [ ] Point your domain at the host and confirm the padlock (HTTPS) shows.
- [ ] Check `https://your-domain/healthz` shows `{"ok":true}`.
- [ ] **First sign-in:** choose your own password, then remove `ADMIN_PASSWORD` from the host's settings.
- [ ] **Stripe webhook:** add `https://your-domain/stripe/webhook` for `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.amount_capturable_updated`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET` and redeploy.
- [ ] **Uptime alert:** sign up for a free uptime monitor (UptimeRobot, Better Stack or similar) pointed at `/healthz`, so you get a text or email if the site goes down.

## 8. Set it up with your real business

- [ ] Hours & settings: business name and address, time zone, cancellation window, "how to pay" line for schools, when parents see results, and your waiver.
- [ ] Point of sale setup: your real locations (with addresses) and products.
- [ ] Billing: your real membership plans.
- [ ] Schedule: your weekly classes, camps, clinics, and private and evaluation hours.
- [ ] Staff & security: add your coaches and front desk.
- [ ] Clients: bring in your current families and athletes with Clients → Import from a spreadsheet (download the template, fill it in, upload). Decide whether to send welcome emails with it; the import can send them.
- [ ] Teams: your school and club contracts, with billing emails.
- [ ] Programs: your exercise library with demo videos, and your programs.
- [ ] Enter Athlete IDs as names in OVR Connect and any other testing app.
- [ ] Hours & settings → Automatic emails: choose which to send (welcome, receipts, trial reminders, failed payments). All are on by default.
- [ ] Sign yourself up at `/join` as a pretend family to see what parents see, then delete that family (client profile → Delete family data).

## 9. Soft launch (one or two weeks, a few families you trust)

- [ ] **Real-money check:** charge yourself $1 by card on file and by Tap to Pay, confirm both in Stripe, refund both from the dashboard.
- [ ] Invite 3 to 5 families. Watch them sign in, sign the waiver, add a card, book, cancel and get emails.
- [ ] Run one real session: roster check-in and collecting from someone unpaid.
- [ ] Run one small testing day, share it, and check the parent report.
- [ ] Send one school invoice to yourself and pay it online.
- [ ] Set up off-site backups (DEPLOY.md → Backups) and confirm Staff & security shows **Off-site: OK**.
- [ ] Restore one off-site copy with `src/restore-backup.js` and confirm it opens (Claude Code can check it with you).
- [ ] Write down anything confusing and send it to me.

## 10. Public launch

- [ ] Put the sign-up link (`https://your-domain/join`, copy it from Hours & settings) on your website, Instagram bio and a QR code at the facility. Any free QR code generator works.
- [ ] Email your current families their portal link with a short "how to book" note.
- [ ] Announce your class schedule and camps.
- [ ] **TestFlight:** install the iPhone app on your staff's phones (it doesn't need to be on the public App Store).

## 11. After launch: your routine

- **Daily:** Today screen (failed payments, overdue invoices, results waiting to be linked, new sign-ups, deletion requests).
- **Weekly:** check Staff & security shows **Off-site: OK** for backups; glance at the activity log for refused or failed sign-ins.
- **Monthly:** review staff accounts (turn off anyone who left), check Stripe payouts against Billing, and ask me for updates.

## Still on my side (next builds)

Done: family self sign-up, client import from a spreadsheet, terms and privacy with recorded acceptance, data download and deletion requests, and automatic emails (welcome, receipts, trial reminders, failed payments).

Next:
- Online programs for sale in the parent portal.
- Pay links and text-message reminders.
- Sales tax, once you know your rules.
- Private video uploads for exercise demos.
- Confirm the OVR import against a real export file.
