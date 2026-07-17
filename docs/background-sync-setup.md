# Background sync + push notifications — one-time setup

The `Gmail background sync` GitHub Action (`.github/workflows/gmail-sync.yml`
→ `scripts/gmail-sync.mjs`) reads new Temu emails from Gmail on a schedule,
parses them with Claude vision, updates the cloud state in Firebase, and
sends push notifications to your registered devices — all without the app
being open anywhere. The `Carrier ETA refresh` Action additionally pushes
"out for delivery" / "delivered" notifications when a carrier status flips.

Everything below is one-time. Commands are for **Windows PowerShell 5** —
each command goes on its own line (PowerShell 5 does not support `&&`).

## Step 1 — Create a Desktop-app OAuth client

The existing OAuth client is a **Web** type and doesn't allow localhost
redirects, so make a second client (same Google Cloud project, ~1 minute):

1. Open <https://console.cloud.google.com/apis/credentials> (the same
   project that has the dashboard's existing OAuth client).
2. **Create credentials → OAuth client ID**.
3. Application type: **Desktop app**. Name it e.g. `TemuDashboard background sync`.
4. Click **Create** and copy the **Client ID** and **Client secret** shown.

No origin/redirect configuration is needed — Desktop clients allow
`http://localhost` loopback redirects out of the box. Your Google account
must (still) be on the app's Test users list (Console → Audience), which it
already is if the dashboard works for you.

## Step 2 — Mint the Gmail refresh token

In PowerShell, from the repo folder (each line separately):

```powershell
$env:GMAIL_CLIENT_ID = "PASTE-CLIENT-ID.apps.googleusercontent.com"
$env:GMAIL_CLIENT_SECRET = "GOCSPX-PASTE-SECRET"
node scripts/gmail-auth.mjs
```

The script prints a Google URL — open it in your browser, sign in with the
**same Google account whose Temu emails the dashboard reads**, and approve
the read-only Gmail access. You'll see Google's "unverified app" warning
(the app is in Testing mode — click *Continue*). When the browser redirects
back to `localhost:8765`, the terminal prints your **refresh token**.

Keep it private: it grants read access to your Gmail until you revoke it at
<https://myaccount.google.com/permissions>. Note: refresh tokens for apps in
Google's **Testing** publishing status expire after ~7 days ONLY when the
consent screen's user type is External + Testing *and* the scope is
sensitive — Gmail scopes are sensitive, so if syncs start failing with
`invalid_grant` after a week, either re-run this script to mint a new token,
or move the OAuth consent screen to **In production** (you can keep using it
unverified with the warning; only you use this client).

## Step 3 — Find your Firebase uid

1. Open the [Firebase console](https://console.firebase.google.com/) →
   project `temu-dashboard-962d6` → **Authentication → Users**.
2. Copy the **User UID** for your Google account.

Sanity check: it's the same uid you see in **Realtime Database** under
`manifest/{uid}` — the tree that holds your `state`, `carrier`, and
`backups` nodes.

## Step 4 — Add the repo secrets

GitHub repo → **Settings → Secrets and variables → Actions → Secrets** →
*New repository secret*, five of them:

| Secret | Value |
|---|---|
| `GMAIL_CLIENT_ID` | Desktop-app client ID (step 1) |
| `GMAIL_CLIENT_SECRET` | Desktop-app client secret (step 1) |
| `GMAIL_REFRESH_TOKEN` | token printed by `gmail-auth.mjs` (step 2) |
| `SYNC_UID` | your Firebase uid (step 3) |
| `ANTHROPIC_API_KEY` | an Anthropic API key (`sk-ant-…`) |

Already present from earlier setup (no action needed):
`FIREBASE_SERVICE_ACCOUNT` (secret) and `VITE_FIREBASE_DATABASE_URL`
(variable).

**Spend note:** until now, Claude vision calls only happened in your browser
with the key from the app's Settings. With `ANTHROPIC_API_KEY` set, vision
parsing also runs in CI with this key — every new order email costs roughly
$0.01 in vision tokens (same as in-app). Runs are capped at
**20 vision calls per run** (`MAX_VISION_PER_RUN`, overridable via a repo
Variable of that name); leftover emails simply wait for the next run and are
never lost. Runs with no new emails make zero Anthropic calls.

## What the workflow does, and when

- **Schedule:** every 5 minutes (`3-59/5 * * * *`). GitHub cron is
  best-effort — expect **5–20 minutes of real latency**, occasionally more
  during GitHub's busy periods. Runs never overlap (a `concurrency` group
  queues them).
- **Each run:** refreshes a Gmail access token, searches for Temu emails
  since the last sync (the same incremental search the app's *Check Gmail*
  does), vision-parses new order confirmations (split-order emails
  included), applies status emails oldest-first with the app's exact
  matching rules, then merges the result into `manifest/{uid}/state` using
  the same per-order merge the app uses — a phone saving mid-run can't be
  clobbered, and hand-edited orders are never overwritten.
- **Pushes:** one grouped "N new orders parsed (total $X)" message plus one
  per status change, sent to every device registered under
  `manifest/{uid}/push` (devices register from the app — see the app's
  notification settings). No registered devices = no pushes, silently.
- **If nothing changed:** the run writes nothing and sends nothing.
- **Unmatched status emails** (order not in the store yet) are left
  unprocessed and recorded, exactly like the app does — they surface in the
  app's *Needs review* queue via Reconcile, which stays the recovery path.
- **Before the secrets exist** the workflow logs "not set yet — skipping"
  and exits green, so it's safe to merge first and configure later.

### Run it manually

GitHub repo → **Actions → Gmail background sync → Run workflow**. The log
shows one line per email/order and a summary (same style as the carrier
Action).

### Turning it off

Actions tab → *Gmail background sync* → "…" menu → **Disable workflow**
(or delete the `GMAIL_REFRESH_TOKEN` secret — runs then skip green).

## Tier 2 — near-realtime later (not set up yet)

The workflow already listens for `repository_dispatch` events of type
`gmail-sync`, so anything with a GitHub token can trigger an immediate run:

```bash
curl -X POST \
  -H "Authorization: Bearer <a-fine-grained-PAT-with-Actions-write>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/ShutUpPetey/TemuDashboard/dispatches \
  -d '{"event_type":"gmail-sync"}'
```

The intended future wiring: **Gmail watch → Pub/Sub → Cloud Function
relay**. Gmail's `users.watch` API publishes a Pub/Sub message the moment a
matching email arrives; a ~20-line Cloud Function subscribed to that topic
POSTs the `repository_dispatch` above, and the sync runs within seconds
instead of minutes. Requirements when we get there: enable Pub/Sub in the
Google Cloud project, re-call `users.watch` weekly (it expires — a tiny
scheduled job), and store a GitHub PAT in the Function's secret config. The
5-minute cron stays as the safety net either way.
