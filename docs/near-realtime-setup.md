# Near-realtime sync (Tier 2) — one-time setup

Tier 1 (already live) polls: the Gmail sync Action every ~5 minutes, the
carrier Action every 6 hours. Tier 2 makes both **event-driven**:

- **Email arrives** → Gmail `users.watch` publishes to a Pub/Sub topic →
  a push subscription POSTs to a tiny Cloud Function relay (`cloud/relay/`)
  → the relay fires a GitHub `repository_dispatch` (`gmail-sync`) → the
  sync workflow runs within seconds → push notification on your phone
  **~1–2 minutes after the email**, instead of 5–20.
- **Package scans** → Shippo's *Track Updated* webhook POSTs to the same
  relay → `repository_dispatch` (`carrier-eta`) → ETA/status refresh runs
  immediately instead of up to 6 hours later.

The crons stay on as the safety net — if any piece of this chain breaks,
you silently fall back to exactly the Tier-1 behavior you have today.

**Cost: $0.** Pub/Sub's free tier is 10 GB/month (your inbox events are a
few KB each); Cloud Functions' free tier is 2M invocations/month (you'll
use a few hundred). No new paid services.

Everything below is one-time. Commands are for **Windows PowerShell 5** —
every command goes on its own line (PowerShell 5 does not support `&&`).
Each `gcloud` command is ONE line, even when it wraps in your editor.

## Step 1 — Create a fine-grained GitHub PAT

The relay needs a token that can fire `repository_dispatch` at this repo.

1. GitHub → your avatar → **Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token**.
2. Name: `temu-relay-dispatch`. **Repository access: Only select
   repositories → ShutUpPetey/TemuDashboard** (nothing else).
3. Permissions → Repository permissions → **Contents: Read and write**
   (that's the permission `repository_dispatch` requires; leave everything
   else at No access).
4. **Expiration**: your call — the max (1 year) means one calendar
   reminder a year. When it expires the relay's dispatches start failing
   *silently* (visible only in the function's Cloud logs) and the crons
   quietly take over — nothing breaks, latency just regresses to Tier 1.
   To rotate: generate a new PAT and re-run the deploy command from
   Step 4 with the new value.
5. Copy the token (`github_pat_…`).

## Step 2 — Google Cloud one-time: APIs + topic + Gmail publish rights

**Which project?** The Pub/Sub topic MUST live in the **same Google Cloud
project as the Desktop-app OAuth client** you made for background sync
(`GMAIL_CLIENT_ID`) — Gmail only accepts a watch topic from the calling
client's own project. That's the same project as the dashboard's web
OAuth client. Check the project ID in the top bar of
<https://console.cloud.google.com/apis/credentials> — the commands below
assume it's `temu-dashboard-962d6`; substitute yours if different.

If you've never used the gcloud CLI: install it from
<https://cloud.google.com/sdk/docs/install>, then in PowerShell:

```powershell
gcloud auth login
gcloud config set project temu-dashboard-962d6
```

Enable the APIs (each line separately; safe to re-run):

```powershell
gcloud services enable pubsub.googleapis.com
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable artifactregistry.googleapis.com
```

(2nd-gen Cloud Functions build with Cloud Build and run on Cloud Run,
hence the last three.)

Create the topic and let Gmail publish to it —
`gmail-api-push@system.gserviceaccount.com` is Google's own service
account that Gmail publishes watch events from:

```powershell
gcloud pubsub topics create gmail-push
gcloud pubsub topics add-iam-policy-binding gmail-push --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" --role="roles/pubsub.publisher"
```

## Step 3 — Generate the relay token

The relay authenticates callers with a shared secret in the URL
(`?token=…`). Generate a random one and keep it in the PowerShell session
for the next two steps (also paste it somewhere safe — you'll need it for
the Shippo URL in Step 6):

```powershell
$RELAY_TOKEN = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
$RELAY_TOKEN
```

(Why a URL token and not Pub/Sub OIDC auth? OIDC would be stronger for
the Pub/Sub path, but Shippo can only call a static URL anyway, the token
keeps the function zero-dependency, and both producers are low-risk — the
worst a forged call can do is trigger a sync run that finds nothing.)

## Step 4 — Deploy the relay function

From the repo folder. Set your PAT into the session first, then deploy —
the `gcloud functions deploy` command is ONE line:

```powershell
$GH_PAT = "github_pat_PASTE-FROM-STEP-1"
gcloud functions deploy temu-relay --gen2 --runtime=nodejs20 --region=us-central1 --source=cloud/relay --entry-point=relay --trigger-http --allow-unauthenticated --set-env-vars "GITHUB_TOKEN=$GH_PAT,RELAY_TOKEN=$RELAY_TOKEN,GITHUB_REPO=ShutUpPetey/TemuDashboard"
```

(`--allow-unauthenticated` is correct: callers authenticate with the
`token` query param, which the function checks itself — Shippo and a
token-based Pub/Sub push can't do Google IAM auth.)

First deploy takes a few minutes. When it finishes, grab the URL:

```powershell
gcloud functions describe temu-relay --gen2 --region=us-central1 --format="value(serviceConfig.uri)"
```

It looks like `https://temu-relay-xxxxxxxxxx-uc.a.run.app`. That's
**FUNCTION_URL** below.

Quick smoke test (should print nothing = HTTP 204, and within ~30s a
"Gmail background sync" run appears in the repo's Actions tab):

```powershell
Invoke-WebRequest -Method POST -Uri "FUNCTION_URL/gmail?token=$RELAY_TOKEN" | Select-Object -ExpandProperty StatusCode
```

(Expect `204`. A `403` means the token doesn't match what you deployed.)

## Step 5 — Create the Pub/Sub push subscription

One line. Substitute FUNCTION_URL; `$RELAY_TOKEN` expands from Step 3:

```powershell
gcloud pubsub subscriptions create gmail-push-relay --topic=gmail-push --push-endpoint="FUNCTION_URL/gmail?token=$RELAY_TOKEN" --ack-deadline=30 --expiration-period=never
```

`--expiration-period=never` matters: by default Pub/Sub deletes a
subscription after 31 days of inactivity, and a quiet month of no Temu
orders would silently kill the pipeline.

## Step 6 — Add the `GMAIL_PUBSUB_TOPIC` repo Variable

GitHub repo → **Settings → Secrets and variables → Actions → Variables**
→ *New repository variable*:

| Variable | Value |
|---|---|
| `GMAIL_PUBSUB_TOPIC` | `projects/temu-dashboard-962d6/topics/gmail-push` |

(Use your actual project ID from Step 2 if it differs.)

That's the whole Gmail side: the **next sync run registers the watch
automatically** (`scripts/gmail-sync.mjs` calls `users.watch` at the end
of every run, no-op runs included). A watch lasts 7 days, but since every
run re-registers it, it renews itself hundreds of times over before it
could lapse — ALL runs would have to fail for 7 straight days for the
watch to expire, and even then the cron keeps syncing; only the
near-realtime latency lapses. To confirm, run the workflow manually
(Actions → Gmail background sync → Run workflow) and look for
`Gmail watch renewed on … (expires …)` in the log.

## Step 7 — Register the Shippo webhook

1. <https://apps.goshippo.com> → **Settings → API** → **Webhooks** →
   *Add webhook*.
2. URL: `FUNCTION_URL/shippo?token=YOUR-RELAY-TOKEN` (paste the actual
   token string from Step 3 — this URL is stored at Shippo, so it can't
   use the PowerShell variable).
3. Event type: **Track Updated**. Mode: **Live** (matches the live
   `SHIPPO_KEY` the carrier Action uses).

Shippo now POSTs on every tracking event for every number the carrier
Action has registered; the relay turns each burst into (at most) one
`carrier-eta` dispatch, and the workflow's `concurrency` group queues
anything that lands mid-run.

## Step 8 — Verify end-to-end

1. Send yourself any email (it doesn't have to be from Temu — the watch
   fires on any INBOX change; a non-Temu email just produces a quick
   "Nothing new" run).
2. Watch the repo's **Actions** tab: a **Gmail background sync** run
   should appear within ~1 minute, triggered by `repository_dispatch`.
3. Steady-state expectations once verified:
   - real Temu email → parsed + push notification on your phone in
     **~1–2 minutes** (Pub/Sub delivery is seconds; the workflow run
     itself — checkout, npm install, vision parse — is the long pole);
   - Shippo tracking scan → carrier ETA refresh within a couple minutes
     of the carrier reporting it;
   - cost: **$0** — this volume is orders of magnitude under the
     Pub/Sub and Cloud Functions free tiers, and GitHub Actions minutes
     are free on public repos.

If no run appears: check the function's logs
(`gcloud functions logs read temu-relay --gen2 --region=us-central1`) —
a `403` line means a token mismatch, a `GitHub dispatch failed` line
means the PAT (wrong permission, expired, or wrong repo).

## Turning it off

Any one of these alone stops the events; all three is a full teardown:

```powershell
gcloud pubsub subscriptions delete gmail-push-relay
```

- Delete the `GMAIL_PUBSUB_TOPIC` repo Variable — runs stop renewing the
  watch and the existing one lapses on its own within ≤7 days.
- Shippo → Settings → API → Webhooks → delete the webhook.
- Optional full cleanup: `gcloud functions delete temu-relay --gen2 --region=us-central1`
  and delete the PAT on GitHub.

Cron polling continues exactly as before in every case.

## Recommended follow-up: relax the gmail-sync cron

Once dispatch is verified working for a few days, the 5-minute cron stops
being the delivery mechanism and becomes a pure safety net — but it still
burns a full checkout + npm install every 5 minutes (~288 runs/day,
nearly all "Nothing new"). Consider stretching it: in
`.github/workflows/gmail-sync.yml`, change

```yaml
    - cron: "3-59/5 * * * *"   # every 5 minutes, offset from :00/:05
```

to

```yaml
    - cron: "17,47 * * * *"    # twice an hour, at :17 and :47
```

(5-field cron: minute, hour, day-of-month, month, day-of-week —
`17,47 * * * *` = fire at minute 17 and minute 47 of every hour.) That
cuts ~260 no-op runs/day while keeping worst-case fallback latency at
~30 minutes *only in the rare case the whole event chain is down*.
Not changed here on purpose — verify the event path first, then edit the
one line whenever you're comfortable. The carrier cron is already only
4×/day and worth keeping as-is.
