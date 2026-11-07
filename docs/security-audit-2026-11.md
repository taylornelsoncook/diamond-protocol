# Security check, November 2026

The owner sent an 11-point pre-launch checklist ("vibe coders are getting sued") and asked for the platform to be checked against it. This is the result, item by item: what was already in place, what was added, and the few things only the owner can do. Plain language first, the technical note after.

**Short version:** the platform already had almost everything on the list. Two things were added in this pass: the "are you a person" check (Cloudflare Turnstile) on the three public forms, and a handful of extra browser hardening headers. Everything else was confirmed with the tests that already guard it.

## The checklist

### 1. Protect yourself: privacy policy, know where user data lives
**In place.** Terms, privacy policy and waiver drafts are written in `docs/legal/` with a README for the lawyer; the privacy draft names every service that holds data (Stripe for cards, Resend for email, Twilio for texts, Render for hosting, Cloudflare for backups and private clips, WHOOP and Oura when connected, Anthropic only for a program document or the facts for a note), the children's-privacy rules (COPPA, parent-held accounts), what is kept and for how long, and the rights (download everything, delete the account). The portal records consent to the current versions and asks again when they change. Families can download their whole export and delete their data from the Family tab; financial records stay without names, as tax law requires.
**Owner's to-do:** the lawyer reviews the drafts (CHECKLIST.md, Lawyer), then Settings → **Use the drafted wording** on each box. Nothing is published until then: the placeholders stay.

### 2. Row-level security: nobody reads another family's rows
**In place.** There is no browser-to-database path at all: the browser only talks to our server, and every route is checked on the server. Staff roles (owner, coach, front desk) are enforced in `services/security.js`, and coaches and front desk never see money (`hideMoney`). Every family route goes through the signed-in family (`portal.athleteOfFamily`); every athlete-app route through the signed-in athlete; a parent acting for an athlete must own that athlete (`not_your_athlete`). API keys have access levels and can never manage keys, staff or webhooks. The role tests (`test/security.test.js`, `test/roles*.test.js`) and the portal tests try the wrong role and the wrong family on the routes.

### 3. Test the failure path, not just the happy path
**In place, with tests.**
- Wrong password 5 times: a staff account locks until it times out or an owner unlocks it (`test/security.test.js`), and sign-in attempts from one address are slowed down. Parents and athletes: 15 wrong codes or passwords an hour lock that email for an hour (`test/portal-signin.test.js`).
- Reset for an email that doesn't exist: "forgot password" answers the same for any email (`test/staff-port.test.js`).
- A link clicked twice: reset links work once, for 30 minutes, 3 an hour per account; the sign-up and sales-page codes expire and allow 5 tries.
- Sign-up with an existing email: the family sign-up form answers the same either way and emails the real account holder instead ("you already have an account"), so the form can't be used to find out who trains here (`services/signup.js`); the online sales page does the same.

### 4. Security headers baseline
**In place; three headers added.** Every page already sent a strict Content Security Policy (scripts only from our own site, no inline scripts, frames only where we allow them), `X-Content-Type-Options: nosniff`, a tight `Referrer-Policy`, and `Strict-Transport-Security` behind the HTTPS proxy. Cookies are `HttpOnly`, `SameSite=Lax` and `Secure`.
**Added:** `Permissions-Policy` (the camera and microphone only for our own pages, which need them for form checks and the coach's cues; location, USB and the like off), `X-Frame-Options` (DENY, or SAMEORIGIN for the athlete app the portal frames; the Book now page stays frameable on purpose), `Cross-Origin-Opener-Policy`, and `object-src 'none'` in the policy. `test/captcha.test.js` pins them.

### 5. OWASP: SQL injection, XSS, auth bugs
**In place.** Every query is parameterized (`?` placeholders); the few places that build SQL from text use fixed column lists from the code, never from a request. The screens build the page with DOM calls (`h()`), never by pasting text as HTML; the three `innerHTML` uses draw our own QR and stick-figure SVGs, with the one user-supplied value escaped. Auth is scrypt-hashed passwords, hashed session tokens, hashed API keys, single-use hashed reset links, Stripe webhooks checked by signature, Twilio's inbound texts checked by signature.

### 6. Client-side validation is UX, not security
**In place.** Every write is validated again on the server (`v.str`, `v.int`, `v.oneOf` and the services' own checks) and answers 400 naming the field. The dashboard's duplicate checks, limits and confirmations are repeated server-side (`check_duplicates`, `confirm: true`).

### 7. Data leaks: secrets in the frontend, over-sharing API answers, secrets in logs
**In place.** No key or secret is in `public/`; the pages read everything from the API. The settings the API answers are a fixed list of business settings (`DEFAULTS` in `services/families.js`); the push keys, webhook secrets and API keys never come back (keys show only a prefix hint). Money is stripped for coaches and front desk; athletes and families see only their own rows. The audit log and the API request log store who did what and when, never request bodies or query strings; sensitive emails (codes, passwords, private links) are marked and never resent to another address.

### 8. API keys in the frontend means game over
**In place.** The only keys that reach a browser are public by design: Stripe's hosted pages (we never load Stripe.js with a key), the Web Push public key, and now Turnstile's site key. The Anthropic, Stripe, Twilio, Resend, WHOOP, Oura and storage keys live in Render's environment on the server.

### 9. Rate limits before someone burns your API bill
**In place.** Every public endpoint has a per-address limit and the costly ones an overall one (inquiries, sign-ups, sales-page codes, sign-in codes, pay links, the check-in door, the blog, calendar feeds, file imports). Paid services have their own caps: Claude reads are 20 an hour per person and 150 a day for the business; form-check and sprint uploads 10 a day per athlete; archive imports 6 an hour per athlete; texts go only to US mobiles that opted in; emails respect opt-outs and the follow-up schedule. The global limit is 1,200 requests a minute per address.

### 10. CAPTCHA on public forms, CORS locked to your domain
**CORS was in place; the CAPTCHA was added.** The server sends no cross-origin headers at all, so no other website can call the API from a browser, and every write checks the request's Origin. The three public forms (Ask about training `/start`, the family sign-up `/join`, the online sales page `/buy`) already had a hidden bot-trap field and rate limits. **Added:** Cloudflare Turnstile, free, on the three forms once the owner sets its two keys (below); the server asks Cloudflare whether each token is real before anything is saved or emailed. Off until the keys are set, so nothing changes until then.
**Owner's to-do (10 minutes):** in Cloudflare → Turnstile → Add site: name it, hostname `app.diamondprotocol.org`, widget mode Managed. Copy the **Site Key** into Render as `TURNSTILE_SITE_KEY` and the **Secret Key** as `TURNSTILE_SECRET_KEY` (on staging too, with a second site for its hostname). The forms show the check from the next restart.

### 11. Error messages that don't leak
**In place.** Our own errors say what to fix in plain words; anything unexpected answers "Something went wrong on our side. Try again." and the detail goes to the server log only. An unknown address answers "No such endpoint." A wrong sign-in answers the same whether the email exists or not.

## The screenshot about SEO
The first screenshot (a topical-authority plan to 100K visits a month) is marketing, not security. The platform already has the pieces it would use: the public blog at `/blog` with feeds and sitemaps, the sales pages, and the sign-up link with its channels. If you want to pursue that plan, say so and it becomes its own piece of work (an editorial calendar, more public pages); nothing in it needs code to start.

## Not on the list but worth knowing
- Backups: daily, plus encrypted off-site copies to the owner's private bucket; restore is a one-line command (DEPLOY.md).
- Every sign-in and change is in the activity report (Settings, owner).
- Dependencies: none. The server uses only what comes with Node, so there is no supply chain to be attacked through a package update.
