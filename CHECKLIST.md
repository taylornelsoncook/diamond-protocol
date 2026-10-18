# Your checklist

Everything that needs your identity, your money, your hardware or your decisions. Work top to bottom: the first section has the longest waits, so start it today.

## Next up (updated September 29, 2026)

Done on September 28: production runs the newest version (schema 48), off-site backups show **Off-site: OK**, the Anthropic key is in Render on both services, the `dp-videos` bucket serves `videos.diamondprotocol.org`, and the first 196 exercise videos are uploaded. The sections below this one are the long list; this section is the next two weeks.

### This week: finish what's in motion
- [ ] **Let the video run finish.** It's `caffeinate -dis node tools/upload-videos.mjs … --free-space --jobs 3` in Terminal on your Mac (a day or two; Ctrl+C and rerun the same line any time). Any evening: Settings → Exercise library → **Import a list** → `Desktop/DiamondProtocol/video-library.csv`. Do a final import when it says Done.
- [ ] **Play a couple of videos** on the site after the first import: they should start within a second or two and show a still picture first.
- [ ] **Fix the typo names** in the library (Settings → Exercise library → search → Edit): "Sandbah Side Bends", "SL Snap to Down to Rapid Fire Vertical Jump", "8 Point Jop for Height". Skim the rest once.
- [ ] **Try the game week on staging**: open a sample athlete's app (Clients → Ava Lopez → App link), add a game two days out and one next week, and watch the calendar strip colour itself (green, yellow, red) and the sets on a yellow or red day's workout come down; then press Change on a game, move its date, and see everything follow. Then Programs → Game week and change any colour or wording you'd do differently; the starting rules are from docs/game-week.md.
- [ ] **Try Build from a picture on staging** (Programs → Build from a picture): take a photo of a whiteboard workout (solid lines between blocks, dashed lines between the complexes inside a block), read it, check the blocks and lines against the photo, tick "Save it to the complex library" on a warm-up you write every time, Save, and tell me what it misread.
- [ ] **Try Build from a PDF on staging** (Programs → Build from a PDF): press **Check the connection** first; it says in plain words whether the Anthropic account can read files (the usual blockers: a key not tied to a workspace, fixed by making a new key inside a workspace at console.anthropic.com → API keys or by adding ANTHROPIC_WORKSPACE_ID in Render; no credits bought at Plans & Billing; or a model the account doesn't have). Then read one of your programs. Press **Use it** on the close matches that are right, fix anything off, Save, compare with the PDF, and tell me what it misread.
- [ ] **Form-check clips (once the wearable and form-check versions are on staging):** make the private `dp-athlete-videos` bucket with its CORS rule and add `FORMCHECK_S3_BUCKET` in Render, following DEPLOY.md → Form-check videos (about 10 minutes). Then send a clip from a sample athlete's app on staging and answer it from Today.
- [ ] **Wearables (WHOOP):** a sign-in page saying "invalid_client" means the Client ID in Render isn't a WHOOP app's. To fix it:
  1. At developer.whoop.com, create (or open) the app. Give it both redirect addresses Settings → Wearables shows (staging's and production's) and the scopes `offline`, `read:profile`, `read:recovery`, `read:sleep`, `read:cycles`, `read:workout`.
  2. Copy its Client ID into `WHOOP_CLIENT_ID` and its Client Secret into `WHOOP_CLIENT_SECRET` on both Render services (no spaces or quotes around them), then let each service restart.
  3. Open Settings → Wearables: the WHOOP line shows the first and last characters of the Client ID Render has. Check they match the developer page.
  4. Press Connect WHOOP on a sample athlete and sign in. Oura the same only if an athlete wears one.
- [ ] **Look over the earlier improvements on staging:** Settings tabs, client training tags, Billing → Change plan and Refunds, Education's five tabs and `/learn`, the lockout as `linh.nguyen@example.com` in the portal.
- [ ] **Tidy the Mac:** trash the leftover zips and folders in Downloads (the diamond-protocol ones, the ffmpeg zip, the Node installer). Keep `Desktop/DiamondProtocol`; the upload tool lives there.

### Start this week: the two that unblock the most
- [ ] **Stripe:** finish business verification, add your bank account, turn on Stripe Terminal (section 1). Nothing real can be charged until this is done.
- [ ] **Lawyer:** waiver, terms of service, privacy policy and card-saving consent wording (sections 2 and 5). Nobody can sign up until these are real. **Drafts are written** in `docs/legal/` (waiver, terms, privacy, card consent, with a README of the decisions and the Colorado points to confirm): send that folder to the lawyer, then on Settings press **Use the drafted wording** on each box, make the lawyer's changes and Save.

### Kept from before
- [ ] **Staff:** add your real coaches and front desk under Settings → Staff. You chose to do this last, before the soft launch.
- [ ] **Stripe webhook:** when Stripe is live, add the events listed in section 7, including `charge.refunded`, `charge.dispute.created` and `payment_method.automatically_updated`.
- [ ] **Staging backups (optional):** the same five `BACKUP_*` settings on `diamond-protocol-staging`; `render.yaml` already keeps its copies apart in the bucket.

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
- [ ] **Policies:** refunds, pack expiration (packs expire 12 months after purchase; change the months on Billing → Needs attention, 0 = never), cancellations, and failed payments (today: retry every 3 days, lock the family out after 4 declines, cancel after 5).
- [ ] **Sales tax.** The app doesn't add tax. Ask your accountant whether you owe tax on sessions or gear in your state, and tell me what to build.
- [ ] **Waiver.** Have a lawyer review the draft in `docs/legal/waiver.txt` (release of liability, assumption of risk, medical consent, concussions, photo and video policy, Colorado parental release). Settings → Policies → **Use the drafted wording**, make the lawyer's changes, Save. Families sign it once in the portal; the one signature also accepts the terms and privacy policy.
- [ ] **Class schedule:** each weekly class (days, time, location, ages, spots, drop-in price), your camps and clinics (dates, registration price), and your hours for privates and evaluations.
- [ ] **Group vs private pricing:** which packs count as group classes and which as privates, and whether memberships cover group classes only (today: yes).
- [ ] **Cancellation window** for parents (default 12 hours).
- [ ] **Team contracts:** for each school or club, the monthly fee, billing day, payment terms (Net 30 is the default), PO number if they use one, and the billing contact's email. Add your business address and "make checks payable to" line in Schedule → Hours & settings; both print on invoices.
- [ ] **Testing equipment:** tell me what you use (timing gates, jump mat, force plates, radar) so I can check each export imports cleanly. Parked for now (October 18): when you have a real export file from OVR Connect or another system, send it and I'll confirm the column matching.
- [ ] **Use Athlete IDs on your devices:** in OVR Connect (and any other testing app), enter each athlete's ID (for example AVALOP2026) as their name or ID. Exports then match automatically with no name-matching step.
- [ ] **Hawkin Dynamics (if you use it):** as the organization admin in Hawkin, go to Settings → Integrations, create an integration token, and paste it in Testing → Devices & imports.
- [ ] **VALD (if you use it):** email support@vald.com with your organization ID from VALD Hub to request external API access. Until then, export files from VALD Hub and import them.
- [ ] **Card-saving consent.** The app asks you to get the client's OK before saving a tapped card. Decide what you'll say, or add a line to your client agreement.

- [ ] **Text messages (optional):** a Twilio account, a local number, and US texting registration (A2P 10DLC) for your business. Carriers block unregistered texts and approval can take a week or two. Steps in DEPLOY.md → Connect the outside services. Until then, texts are only logged.

## 3. Equipment

- [ ] **Xcode 16 or newer on your Mac** to build the iPhone app (you have the Mac; Xcode needs about 15 GB free, so clear space first).
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
- [ ] **Waiver** (from section 2), finalized by your lawyer. The terms and privacy drafts are in `docs/legal/terms.txt` and `docs/legal/privacy.txt`; the Settings boxes fill from them with Use the drafted wording.
- [ ] **Card-saving consent wording** (from section 2).
- [ ] **Insurance:** confirm your liability coverage includes training minors at your facility, parks and clients' homes.
- [ ] **Paste the terms and privacy policy** into Schedule → Hours & settings. They appear at `/terms` and `/privacy`, new families agree to them at sign-up, and changing them later asks every parent to accept again.
- [ ] **Ask your accountant** how long you must keep payment records. When a family asks to be deleted, the app keeps payments and invoices with no names attached.

## 6. Accounts and domain

- [x] **Domain name** for the app, for example `app.diamondprotocol.com` (a subdomain of your main site works well).
- [x] **Email sending:** create a Resend account (resend.com), verify your domain by adding the DNS records it gives you, then keep the API key handy. Parents can't sign in until email works.
- [ ] **Stripe live mode:** business verification complete, bank account added, live keys available (`sk_live_...`).
- [x] **A private GitHub repository** with the project in it (Claude Code can set this up with you).
- [x] **Hosting account** (Render is simplest). It needs a paid plan with a persistent disk.
- [ ] **The blog on your own domain (optional):** the blog is at https://app.diamondprotocol.org/blog as soon as the build is live. If you want it at diamondprotocol.org/blog instead, add a redirect rule in Cloudflare (Rules → Redirect Rules): when the path starts with `/blog`, redirect to `https://app.diamondprotocol.org` plus the same path, status 301. Google then treats the app address as the blog's home. Posts are written under Education → Blogs; each one has its own link to share.

## 7. Put it online (follow DEPLOY.md, ideally with Claude Code)

- [x] Deploy with `render.yaml` (or `fly.toml`), one instance with a disk at `/data`.
- [ ] Set the settings DEPLOY.md lists: `PUBLIC_URL`, `BUSINESS_TZ`, Stripe live keys, Resend key and `EMAIL_FROM`, and `ADMIN_EMAIL` + `ADMIN_PASSWORD` for the first start only.
- [x] Point your domain at the host and confirm the padlock (HTTPS) shows.
- [ ] Check `https://your-domain/healthz` shows `{"ok":true}`.
- [x] **First sign-in:** choose your own password, then remove `ADMIN_PASSWORD` from the host's settings.
- [ ] **Stripe webhook:** add `https://your-domain/stripe/webhook` for `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.amount_capturable_updated`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`, `charge.dispute.created`, `payment_method.automatically_updated`. Put its signing secret in `STRIPE_WEBHOOK_SECRET` and redeploy.
- [ ] **Uptime alert:** sign up for a free uptime monitor (UptimeRobot, Better Stack or similar) pointed at `/healthz`, so you get a text or email if the site goes down.

## 8. Set it up with your real business

- [ ] Hours & settings: business name and address, time zone, cancellation window, "how to pay" line for schools, when parents see results, and your waiver.
- [ ] Point of sale setup: your real locations (with addresses) and products.
- [ ] Billing: your real membership plans.
- [ ] Schedule: your weekly classes, camps, clinics, and private and evaluation hours.
- [ ] Staff & security: add your coaches and front desk.
- [ ] Clients: bring in your current families and athletes with Clients → Import from a spreadsheet (download the template, fill it in, upload). Decide whether to send welcome emails with it; the import can send them.
- [ ] Teams: your school and club contracts, with billing emails.
- [ ] Programs: your programs (the exercise library and videos come from the upload above; Build from a PDF turns an existing program PDF into one athletes can follow).
- [ ] Enter Athlete IDs as names in OVR Connect and any other testing app.
- [ ] Hours & settings → Automatic emails: choose which to send (welcome, receipts, trial reminders, failed payments). All are on by default.
- [ ] Sign yourself up at `/join` as a pretend family to see what parents see, then delete that family (client profile → Delete family data).

## 9. Soft launch (one or two weeks, a few families you trust)

- [ ] **Real-money check:** charge yourself $1 by card on file and by Tap to Pay, confirm both in Stripe, refund both from the dashboard.
- [ ] Invite 3 to 5 families. Watch them sign in, sign the waiver, add a card, book, cancel and get emails.
- [ ] Run one real session: roster check-in and collecting from someone unpaid.
- [ ] Run one small testing day, share it, and check the parent report.
- [ ] Send one school invoice to yourself and pay it online.
- [x] Set up off-site backups (DEPLOY.md → Backups) and confirm Settings → Backups shows **Off-site: OK**.
- [ ] Restore one off-site copy with `src/restore-backup.js` and confirm it opens (Claude Code can check it with you).
- [ ] Write down anything confusing and send it to me.

## 10. Public launch

- [ ] Put the sign-up link (`https://your-domain/join`, copy it from Hours & settings) on your website, Instagram bio and a QR code at the facility. Any free QR code generator works.
- [ ] Print the check-in QR poster for the facility door and set up a check-in tablet if you have one (Schedule → Hours & settings → Self check-in).
- [ ] Put the "Ask about training" link (`https://your-domain/start`) next to it for families who aren't ready to sign up. Send yourself a test inquiry and check the thank-you email and the Leads tab.
- [ ] Email your current families their portal link with a short "how to book" note.
- [ ] Announce your class schedule and camps.
- [ ] **TestFlight:** install the iPhone app on your staff's phones (it doesn't need to be on the public App Store).

## 11. After launch: your routine

- **Daily:** Today screen (failed payments, overdue invoices, results waiting to be linked, new sign-ups, deletion requests).
- **Weekly:** check Staff & security shows **Off-site: OK** for backups; glance at the activity log for refused or failed sign-ins.
- **Monthly:** review staff accounts (turn off anyone who left), check Stripe payouts against Billing, and ask me for updates.

## Still on my side (next builds)

Done: family self sign-up, client import from a spreadsheet, terms and privacy with recorded acceptance, data download and deletion requests, automatic emails, online programs for sale, pay links, every tab from the earlier version, the CRM (pipeline, tasks, timelines, texts and emails to leads), encrypted off-site backups, Stripe webhooks (dashboard refunds, disputes, reissued cards) and alerts when a background job fails.

Next:
- Fix anything you find on staging.
- Sales tax, once you know your rules.
