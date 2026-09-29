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
3. Deploy. The log should say `Created the owner account …`. (`render.yaml` sets `TRUST_PROXY=2`: Render's Cloudflare edge and its load balancer. If you created the service by hand, set it yourself.)
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
- **Text messages (optional):** until these are set, texts are only logged under API & integrations → Texts.
  1. Create a Twilio account at twilio.com and buy a local number with SMS.
  2. Register for US texting in Twilio: **Messaging → Regulatory Compliance → A2P 10DLC**. Register your business (brand) and one campaign of type "Customer care / account notifications". Use your EIN, and describe the opt-in: "Parents turn texts on in our parent portal at https://app.yourdomain.com/parent". US carriers block texts from unregistered numbers, and approval can take a week or two.
  3. In Render → **diamond-protocol → Environment** set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (Twilio Console home page) and `TWILIO_FROM` (your number, or the `MG…` Messaging Service ID if you made one).
  4. In Twilio → your number → **Messaging configuration**, set "A message comes in" to Webhook `https://app.yourdomain.com/sms/inbound` (HTTP POST). This records STOP, START and HELP and emails you any other reply.
  5. After Render redeploys, open **API & integrations → Texts** and send yourself a test text.
  On staging, also set `SMS_ONLY_TO` to your own mobile number so demo families are never texted.
- **iPhone app:** set the server address in the app to `https://app.yourdomain.com`.

## 5. Check it's healthy
- `https://app.yourdomain.com/healthz` shows `{"ok":true}`.
- The app refuses to start with unsafe settings (no https address, sample password, test mode with a live Stripe key) and prints what to fix in the log.

## Backups
- A full copy of the database is saved every day to `/data/dp-backups` and the last 30 are kept.
- **Keep copies off the server too.** A copy on the same disk is lost with the disk, so set up off-site backups (below). Staff & security → Backups shows **Off-site: OK** once it works.

### Off-site backups
Each daily backup is checked by SQLite, encrypted with your passphrase, uploaded, then downloaded again and compared, so a copy only counts once it's known to restore. Failed uploads retry every hour. It works with any S3-compatible storage; these steps use Cloudflare R2 (your DNS is already on Cloudflare).

1. In the Cloudflare dashboard open **R2 Object Storage** (the free tier covers 10 GB; R2 asks for a card to turn it on).
2. **Create bucket**, e.g. `diamond-protocol-backups`. Location: automatic.
3. In the bucket, **Settings → Object lifecycle rules → Add rule**: delete objects 90 days after upload, so old copies don't pile up.
4. Back in R2, **Manage API tokens → Create API token**: permission **Object Read & Write**, limited to that bucket. Copy the **Access Key ID**, **Secret Access Key** and the **S3 endpoint** (`https://<account id>.r2.cloudflarestorage.com`).
5. Make a passphrase: `openssl rand -base64 32`, or a long password from your password manager. **Save it in your password manager.** Backups can't be restored without it and nobody can recover it for you.
6. In Render, open **diamond-protocol → Environment** and set `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET` and `BACKUP_PASSPHRASE`. Do the same on staging if you want it backed up too; `render.yaml` already keeps the two apart in the bucket (`production/` and `staging/`).
7. After Render redeploys, press **Staff & security → Back up now**. It should say the backup was sent off-site.

Backblaze B2 and AWS S3 work the same way: use their S3 endpoint (e.g. `https://s3.us-west-004.backblazeb2.com`) and set `BACKUP_S3_REGION` to the bucket's region (e.g. `us-west-004`).

### Restoring
- **From an off-site copy:** on any computer with Node 22.13+ and this repository, download the `.enc` file from the bucket and run
  `BACKUP_PASSPHRASE='...' node src/restore-backup.js ~/Downloads/diamond-20260927-030000.db.enc restored.db`
  (with the `BACKUP_S3_*` settings also set, pass just the backup name, e.g. `diamond-20260927-030000.db`, and it fetches it). The script checks the database before it writes `restored.db`.
- **Putting it back in service:** stop the app, replace `/data/dp.db` with the restored file (renamed to `dp.db`), start the app. A file downloaded from Staff & security → Backups is already a plain database and goes in the same way.

## Video library
Your exercise videos live in your own Cloudflare R2 bucket, played from your own address (for example `https://videos.diamondprotocol.org`). Cloudflare keeps copies near each viewer, so clips start quickly on phones, and the app's server never carries the video. R2 charges about $0.015 per GB a month to store and nothing when people watch.

**1. A bucket for the videos** (a new one: never the backups bucket, which must stay private)
1. Cloudflare dashboard → **R2 Object Storage → Create bucket**, e.g. `dp-videos`.
2. In the bucket: **Settings → Custom domains → Connect domain** → `videos.diamondprotocol.org`. Cloudflare adds the DNS record. This makes the files viewable by anyone with the link, which is what the app needs (the links are long and unguessable, but not secret).
3. R2 → **Manage API tokens → Create API token**: **Object Read & Write**, limited to `dp-videos`. Copy the **Access Key ID**, **Secret Access Key** and the **S3 endpoint**.

**2. On the computer with the videos** (a Mac here; a hard drive plugged in counts)
1. Install Node.js 22 from nodejs.org, and Homebrew from brew.sh. Then in Terminal: `brew install ffmpeg`.
2. Get this project: on GitHub, **Code → Download ZIP**, and unzip it (or `git clone` it). In Terminal, `cd` into the folder.
3. Make a file called `video-upload.env` in that folder:
   ```
   VIDEO_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
   VIDEO_S3_BUCKET=dp-videos
   VIDEO_S3_KEY_ID=<Access Key ID>
   VIDEO_S3_SECRET=<Secret Access Key>
   VIDEO_PUBLIC_URL=https://videos.diamondprotocol.org
   ```
4. First a practice run that uploads nothing (drag each folder into Terminal to paste its path):
   `node tools/upload-videos.mjs "/Users/you/Movies/Exercises" "/Volumes/Your Drive/Exercises" --dry-run`
   It lists what it found and writes `video-upload-report.txt` with any name that appears twice (the first folder wins) and any file it can't use.
5. The real run, kept awake overnight: `caffeinate -i node tools/upload-videos.mjs "/Users/you/Movies/Exercises" "/Volumes/Your Drive/Exercises"`
   It checks the bucket and the address first, then converts and uploads two videos at a time (5,000 clips take several hours). Stop it with Ctrl+C whenever you like; the same command carries on where it stopped and retries anything that failed.
6. When it says Done, it has written `video-library.csv`.

**3. In the app:** Settings → Exercise library → **Import a list** (owner), choose `video-library.csv`, press **Check the list**, then **Bring them in**. Exercises already in the library are left as they are unless you choose to add or replace their video.

**Videos kept in iCloud** (a Desktop or Documents folder with "Optimize Mac Storage" on) are only placeholders on the Mac until opened. For a folder that fits on the disk, download it first (right-click it in Finder → **Download Now**) and run as usual. For a folder bigger than the free space, add `--free-space`: the tool fetches each video from iCloud just before its turn, converts and uploads it, then hands the original back to iCloud (`brctl evict`), so only a few videos are on the Mac at once. That run is limited by your internet speed, since every video comes down once; Ctrl+C and rerun as needed. The tool also takes every video inside subfolders, so move out any folder you don't want in the library before running it (a `--dry-run` shows the count).

Names come from the file names ("Back_squat.mp4" is Back squat; "(1)" and "copy" are dropped). A video in a folder called Lower body, Core, Speed… gets that category; other folder names are ignored. Rename files before the upload if a name should change; a renamed file uploads again on the next run.

## Form-check videos
Athletes film a set in the app and send it to their coach. These are videos of minors, so they never sit on the app's server or in the public exercise-video bucket: the phone uploads each clip straight into a **private** R2 bucket of yours with a one-time signed address, everyone who may watch gets a 10-minute link, and clips are removed after the keep time (Settings → Backups & jobs, 90 days by default). Until the bucket is set up the app simply doesn't show the Send a form check button.

1. Cloudflare dashboard → **R2 Object Storage → Create bucket**, e.g. `dp-athlete-videos`. Location: automatic. **No custom domain, no public access**: this bucket stays private. It must be its own bucket, not the backups bucket and not `dp-videos`.
2. In the bucket: **Settings → CORS policy → Add CORS policy** and paste, with your app's address (the staging one too if you set it up there):
   ```json
   [{ "AllowedOrigins": ["https://app.diamondprotocol.org"], "AllowedMethods": ["PUT", "GET", "HEAD"], "AllowedHeaders": ["content-type"], "ExposeHeaders": ["etag"], "MaxAgeSeconds": 3600 }]
   ```
3. An API token with **Object Read & Write** on this bucket. The simplest is to edit the backups token so it covers both buckets; then only `FORMCHECK_S3_BUCKET` is needed in Render. Otherwise make a new token and set `FORMCHECK_S3_ENDPOINT` (the same `https://<account id>.r2.cloudflarestorage.com` as the backups), `FORMCHECK_S3_KEY_ID` and `FORMCHECK_S3_SECRET` too.
4. In Render → **diamond-protocol → Environment**, add `FORMCHECK_S3_BUCKET=dp-athlete-videos` (and the three others if you made a new token). Save; Render restarts. Settings → Backups & jobs → **Form-check videos** should say **Set up** and list the exact addresses the CORS rule needs.
5. Optional: **Settings → Object lifecycle rules** on the bucket, delete objects 400 days after upload, as a backstop behind the app's own daily clean-up.

Storage costs about $0.015 per GB a month; a 60-second phone clip is 20 to 60 MB, so a hundred clips on file is under a dollar.

## Updating
Push changes to the repository. GitHub runs the full test suite and checks the Docker image builds (the **Tests** check, `.github/workflows/tests.yml`). Staging deploys only after that check passes; production still waits for Manual Deploy. If staging was set up by hand rather than from the Blueprint, set it yourself: staging service → Settings → Auto-Deploy → **After CI Checks Pass**. The database upgrades itself on start, and a backup is made on start before anything else runs each day.

## Settings reference
| Setting | What it's for |
| --- | --- |
| `PUBLIC_URL` | Your https address. Required. |
| `DP_TEST_MODE` | `false` in production. |
| `TRUST_PROXY` | How many proxies sit in front of the app, so HTTPS and visitors' addresses are recognized. The Dockerfile sets `true` (one proxy). **On Render set `TRUST_PROXY=2`**: Render puts its own Cloudflare edge in front of its load balancer, so two addresses arrive. Add one more (`3`) if you also turn on your own Cloudflare proxy (orange cloud) for the domain. To confirm it, sign in as the owner and open Staff & security → Connection check: the address the app decided on should be your own internet address, and the check lists what each value would pick. |
| `DB_FILE`, `BACKUP_DIR` | `/data/dp.db`, `/data/dp-backups` (set in the Dockerfile). |
| `BACKUP_KEEP` | How many daily backups to keep (default 30). |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET` | Off-site backups to S3-compatible storage (see Backups). Optional: `BACKUP_S3_REGION` (default `auto`), `BACKUP_S3_PREFIX` (default `diamond-protocol/`). |
| `BACKUP_PASSPHRASE` | Encrypts off-site backups. Required for them; keep it in your password manager. |
| `BUSINESS_TZ` | Your time zone, e.g. `America/Chicago`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First start only. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CURRENCY` | Payments. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Text messages (see section 4). Without them texts are only logged. |
| `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` | Optional. Lets parents (and coaches) link an athlete's WHOOP account so recovery, sleep, strain and workouts arrive on their own (Settings → Data import shows the setup and the redirect address to register at developer.whoop.com). Without them the Connect WHOOP button doesn't show and files can still be imported. |
| `FORMCHECK_S3_BUCKET` (and `FORMCHECK_S3_ENDPOINT`, `FORMCHECK_S3_KEY_ID`, `FORMCHECK_S3_SECRET` when they differ from the backups') | Optional. A private bucket for athletes' form-check clips (see Form-check videos below). Until it's set, the app doesn't offer Send a form check. Never the backups bucket. |
| `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` | Optional. The same for Oura rings (an application at cloud.ouraring.com/oauth/applications). |
| `ANTHROPIC_API_KEY` | Optional. Claude reads program PDFs and photos into a draft (Programs → Build from a PDF; without the key that page says it needs one) and rewords the drafted progress notes for parents; coaches check and approve both. Without it the plain note drafts are used. `DP_AI_MODEL` picks the notes model, `DP_WORKOUT_MODEL` the PDF reader's (default `claude-opus-5`). |
| `SMS_ONLY_TO` | Staging: only these phone numbers (comma list) are really texted; the rest are held in the log. |
