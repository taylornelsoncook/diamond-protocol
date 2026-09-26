# Deploying on Render

`render.yaml` sets up two copies of the app, each with its own disk:

| Service | What it's for | Data | Deploys |
| --- | --- | --- | --- |
| `diamond-protocol-staging` | Trying changes before families see them | Demo data, test-mode payments | Automatically on every merge to `main` |
| `diamond-protocol` | The real thing | Starts empty; you create the owner account | Only when you press **Manual Deploy** |

Cost: two Starter services with 1 GB disks, about $15–20 a month in total. Disks need a paid plan; the free plan would erase the database on every restart.

## First time (about 10 minutes)

1. Sign up at https://render.com with **Sign in with GitHub**, and allow Render to see `diamond-protocol`.
2. **New → Blueprint**, pick `taylornelsoncook/diamond-protocol`, branch `main`. Render reads `render.yaml` and lists both services. Press **Apply**.
3. Wait for both to show **Live** (the first build takes a few minutes).
4. **Staging:** open its `.onrender.com` address and sign in with `owner@demo.test` / `demo-owner-2026`. The parent portal is at `/parent` (try `maria.lopez@example.com`; the code shows on screen).
5. **Production:** open its address. It asks you to create the owner account. Use your real email and a strong password. Then add your staff in Staff & security.

## Everyday flow

1. A change is made on a branch and opened as a pull request.
2. Merge it on GitHub: staging updates itself within a few minutes.
3. Click through the change on staging.
4. When it's right, open the production service in Render and press **Manual Deploy → Deploy latest commit**.

If a deploy goes wrong: in Render, open the service → **Events** → pick the previous deploy → **Rollback**. The database is on the disk and isn't touched by deploys.

## Your own address (optional)

In the production service: **Settings → Custom Domains → Add**, e.g. `app.diamondprotocol.com`. Render shows one DNS record to add at your domain registrar; HTTPS is automatic. Then add an environment variable `DP_APP_URL` = `https://app.diamondprotocol.com` so email links use it.

## Before real families use production

- **Email:** until email is connected, sign-in codes show on screen and every email only lands in the outbox. See "Connect email" below.
- **Payments:** production still runs test-mode payments until the Stripe wiring is added and `STRIPE_SECRET_KEY` is set. Don't take real payments before then.
- **Backups:** the app copies the database daily onto the same disk. Also download a copy weekly from Staff & security, and turn on Render's disk snapshots.

## Connect email (Resend)

1. Sign up at https://resend.com (free for 3,000 emails a month).
2. **Domains → Add domain** (e.g. `diamondprotocol.com`) and add the DNS records it shows at your domain registrar. Wait until it says **Verified**.
   No domain yet? Skip this: Resend's test sender (`onboarding@resend.dev`) works, but only delivers to the email you signed up with.
3. **API Keys → Create API key** (permission: Sending access). Copy it; it starts with `re_`.
4. In Render, open **diamond-protocol-staging → Environment** and add:
   - `RESEND_API_KEY` = the key
   - `DP_EMAIL_ONLY_TO` = your own email address (so demo families never get real email)
   - `DP_EMAIL_FROM` = `Diamond Protocol <hello@yourdomain.com>` (leave out if you skipped step 2)
   Save; Render restarts the service.
5. Sign in to staging as the owner → **API & integrations → Email outbox → Send test email**. It should arrive within a minute.
6. When it works, add `RESEND_API_KEY` and `DP_EMAIL_FROM` to **diamond-protocol** (production) too, without `DP_EMAIL_ONLY_TO`, and send a test email there.

Every email is still kept in the outbox with its status (Sent, Failed, Held, Not sent). Failed sends are retried automatically up to three times.
