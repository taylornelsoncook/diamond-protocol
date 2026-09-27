# Putting Diamond Protocol online

The app is one small program with its database in a single file. It needs:
- a host that runs a Docker container **with a persistent disk** (Render or Fly.io both work),
- your domain (for example `app.diamondprotocol.com`),
- your Stripe and Resend accounts (see CHECKLIST.md).

Run exactly **one** copy of the app. The database is a single file, so two copies would each have their own data.

## 1. Put the code in a private GitHub repository
Unzip the project, create a **private** repository on GitHub, and upload the folder. Claude Code can do this with you.

## 2a. Render (simplest)
1. In Render: **New → Blueprint**, choose the repository. It reads `render.yaml`: one web service with a 5 GB disk at `/data`.
2. Fill in the settings it asks for:
   - `PUBLIC_URL`: `https://app.yourdomain.com`
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`: your sign-in for the first start (10+ characters)
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`
3. Deploy. The log should say `Created the owner account …`.
4. **Custom domain:** in the service settings add `app.yourdomain.com`, then add the DNS record Render shows at your domain registrar. HTTPS is set up automatically.

## 2b. Fly.io (alternative)
```
fly launch --copy-config --no-deploy
fly volumes create data --size 5
fly secrets set PUBLIC_URL=https://app.yourdomain.com ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='a-long-first-password' STRIPE_SECRET_KEY=sk_... STRIPE_WEBHOOK_SECRET=whsec_... RESEND_API_KEY=re_... EMAIL_FROM='Diamond Protocol <coach@yourdomain.com>'
fly deploy
fly certs add app.yourdomain.com
```

## 3. First sign-in
1. Open `https://app.yourdomain.com`, sign in with ADMIN_EMAIL and ADMIN_PASSWORD, and choose your own password.
2. **Remove `ADMIN_PASSWORD`** from the host's settings.
3. Staff & security: add your coaches and front desk. Each gets a one-time password by email.

## 4. Connect the outside services
- **Stripe webhook:** Stripe Dashboard → Developers → Webhooks → add `https://app.yourdomain.com/stripe/webhook` with the events listed in CHECKLIST.md. Put its signing secret in `STRIPE_WEBHOOK_SECRET` and redeploy.
- **Email:** in Resend, verify your domain (add the DNS records it gives you). Test by signing in to `/parent` as a parent.
- **iPhone app:** set the server address in the app to `https://app.yourdomain.com`.

## 5. Check it's healthy
- `https://app.yourdomain.com/healthz` shows `{"ok":true}`.
- The app refuses to start with unsafe settings (no https address, sample password, test mode with a live Stripe key) and prints what to fix in the log.

## Backups
- A full copy of the database is saved every day to `/data/backups` and the last 30 are kept.
- **Keep copies off the server too:** download one from Staff & security → Backups every week or two, and turn on your host's disk snapshots if offered.
- **To restore:** stop the app, replace `/data/diamond.db` with the backup file (renamed to `diamond.db`), start the app.

## Updating
Push changes to the repository. GitHub runs the full test suite and checks the Docker image builds (the **Tests** check, `.github/workflows/tests.yml`). Staging deploys only after that check passes; production still waits for Manual Deploy. If staging was set up by hand rather than from the Blueprint, set it yourself: staging service → Settings → Auto-Deploy → **After CI Checks Pass**. The database upgrades itself on start, and a backup is made on start before anything else runs each day.

## Settings reference
| Setting | What it's for |
| --- | --- |
| `PUBLIC_URL` | Your https address. Required. |
| `DP_TEST_MODE` | `false` in production. |
| `TRUST_PROXY` | `true` (set in the Dockerfile) so HTTPS behind the host's proxy is recognized. |
| `DB_FILE`, `BACKUP_DIR` | `/data/diamond.db`, `/data/backups` (set in the Dockerfile). |
| `BACKUP_KEEP` | How many daily backups to keep (default 30). |
| `BUSINESS_TZ` | Your time zone, e.g. `America/Chicago`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First start only. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CURRENCY` | Payments. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email. |
