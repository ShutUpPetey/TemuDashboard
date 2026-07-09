# Temu Order Manifest

A personal, single-user dashboard that syncs Temu order emails straight from
Gmail, reads item names/prices out of Temu's image-rendered receipts using
Claude vision, distributes order-level discounts across items proportionally,
and shows sortable order/item tables plus spend analytics.

This started as a Claude.ai artifact and was migrated to a static Vite/React
app deployable to GitHub Pages. See `MIGRATION.md` for the original brief this
migration followed, and what had to change to run outside Claude.ai.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in VITE_GOOGLE_CLIENT_ID, see setup below
npm run dev
```

Open the printed `localhost` URL, open Settings (gear icon) and:

1. Paste your Anthropic API key (from [console.anthropic.com](https://console.anthropic.com)). It's stored only in this browser's `localStorage` and sent directly from your browser to Anthropic — never committed, never sent anywhere else.
2. Click "Sign in with Google" to authorize read-only Gmail access.
3. Click "Check Gmail".

## One-time Google Cloud setup

Gmail access uses Google Identity Services (client-side OAuth) — no backend
server required, but you do need your own OAuth client. Google's console UI
was reorganized in 2025–2026 into the "Google Auth Platform" (Branding /
Audience / Data Access / Clients tabs) — these steps match that current UI:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a new project (billing not required) → enable the **Gmail API** (APIs & Services → Library → search "Gmail API" → Enable).
2. Open **APIs & Services → OAuth consent screen** (or search "OAuth" in the top search bar, or go directly to `console.cloud.google.com/auth/overview`). On a fresh project you'll see "Google Auth Platform not configured yet" — click **Get started**.
3. Walk through the 4-step wizard:
   - **App Information**: app name (e.g. "Temu Order Manifest") and your support email.
   - **Audience**: pick **External** (this is the one choice you can't change later without starting a new project — External lets any Google account sign in, starting in "Testing" mode).
   - **Contact Information**: your email for policy notices.
   - **Finish**: accept the policy → **Create**.
4. On the **Audience** tab, click **Add users** under Test users and add your own Google account. Only accounts on this list can sign in while the app is in Testing mode — that's what keeps this personal/single-user without needing Google's verification process.
5. On the **Data Access** tab, click **Add or remove scopes** and add `.../auth/gmail.readonly`. Gmail scopes are classified "restricted," which normally requires Google's verification before going to production — but apps in Testing mode with only test users (like this one) are exempt, so you can ignore that requirement here.
6. On the **Clients** tab, click **Create Client** → application type **Web application**. Add these as **Authorized JavaScript origins** (leave "Authorized redirect URIs" blank — this app uses the browser token flow, not a redirect callback):
   - `http://localhost:5173` (local dev)
   - `https://<your-github-username>.github.io` (deployed site)
7. Copy the generated **Client ID** (looks like `123-abc.apps.googleusercontent.com`) into `.env` as `VITE_GOOGLE_CLIENT_ID=...`. This value is safe to be public (it identifies the app, not a secret — ignore any Client Secret shown, this app never uses it). It also needs to be set as a **repository Variable** (not a Secret) for the GitHub Actions deploy below.

The first time you sign in, Google will likely show an "unverified app"
warning screen since the app hasn't gone through Google's review — click
**Advanced → Go to (app name) (unsafe)** to proceed. That's expected and safe
here since it's your own app talking to your own Google account.

## Anthropic API key

Get one from [console.anthropic.com](https://console.anthropic.com) → Settings → API Keys. Requests
go directly from your browser to `api.anthropic.com` using the
`anthropic-dangerous-direct-browser-access` header — there's no backend
proxying calls, which also means the key is visible to anyone with access to
this browser/devtools. Fine for personal use on a device you control; don't
share the deployed URL with the key still in that browser's storage.

## Deploy to GitHub Pages

1. Push this repo to GitHub (default branch `main`).
2. In the repo, go to **Settings → Pages** and set Source to **GitHub Actions**.
3. Go to **Settings → Secrets and variables → Actions → Variables** and add `VITE_GOOGLE_CLIENT_ID` with your OAuth client ID.
4. Push to `main` (or run the workflow manually from the Actions tab) — `.github/workflows/deploy.yml` builds and publishes to `https://<username>.github.io/TemuDashboard/`.
5. Back in Google Cloud Console, make sure that exact `https://<username>.github.io` origin is in the OAuth client's authorized origins (step 3 above).

If you rename the repo, update `base` in `vite.config.js` to match.

## Adaptive layout

The app has two presentation shells over one shared data engine (`src/App.jsx`):

- **Desktop — "Command Center"** (`src/components/DesktopShell.jsx`, ≥768px): sidebar navigation, an Overview page with KPI cards/sparklines, recent orders, an arriving-soon panel, spend-by-category bars, and a **Needs review** queue collecting estimated prices, empty orders, and failed emails.
- **Mobile — "Visual Gallery"** (`src/components/MobileShell.jsx`, <768px): photo-first item card grid, category/status filter chips with live counts, a tap-for-detail bottom sheet with a shipping timeline and quick per-item editing, and a floating stats dock whose numbers follow the active filter.

The shell is picked automatically by viewport width; **Settings → Layout** can force either one (e.g. the card grid on a big monitor). Shared pieces (settings, analytics, thumbnails, status chips) live in `src/components/` and `src/lib/derive.js`.

## Cloud sync (optional, Firebase Realtime Database)

Without this, each browser keeps its own local data (IndexedDB) — your phone
and desktop won't share orders. With it, all devices read/write one shared
store and update live. It reuses the existing Google sign-in (no second
login) and the free Spark tier is far more than enough.

One-time setup:

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (Analytics not needed).
2. **Build → Realtime Database → Create database** (locked mode). Then on the **Rules** tab paste:

   ```json
   {
     "rules": {
       "manifest": {
         "$uid": { ".read": "$uid === auth.uid", ".write": "$uid === auth.uid" }
       }
     }
   }
   ```

3. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
4. Still under the Google provider settings, open **Safelist client IDs from external projects** (under "Web SDK configuration"/advanced) and add your existing `VITE_GOOGLE_CLIENT_ID`. This is what lets the app's Gmail sign-in token also sign into Firebase.
5. **Project settings (gear) → Your apps → Add app → Web (</>)** — register it (no hosting), then copy the config values into `.env`:
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. (For the GitHub Pages deploy, also add them as repository **Variables** and pass them in `deploy.yml` like `VITE_GOOGLE_CLIENT_ID`.)
6. Restart `npm run dev`, sign in to Google (you'll see a one-time consent prompt for the added identity scopes) — Settings → Cloud sync should show **Live**.

How it behaves: on connect, whichever side has newer data wins (whole-store,
`updatedAt` timestamp) and is mirrored both ways; after that, every save
writes through to Firebase and other devices update live. If Firebase is
unreachable, everything keeps working locally and the sync log says so. The
Firebase SDK is loaded from Google's CDN only when configured — no new npm
dependency.

## Live carrier ETAs (optional, needs Cloud sync)

Temu's shipping emails give a tracking number; this feature adds the
carrier's OWN live estimated-delivery window and status ("Out for
delivery"). Since browsers can't read carrier sites and API keys must stay
secret, a scheduled GitHub Action (`.github/workflows/carrier-eta.yml` →
`scripts/carrier-eta.mjs`) polls the [17TRACK API](https://api.17track.net/) every 6 hours and writes
results into Firebase at `manifest/{uid}/carrier/…` — a read-only path the
app subscribes to. Live ETAs take precedence over email ETAs everywhere,
labeled "live via UPS". If the carrier reports delivered before Temu's
email arrives, the app flags it ("✓ delivered per carrier").

One-time setup (requires Cloud sync to be configured first). Recommended
provider: **Shippo** — API access is included on the free Starter plan, and
tracking numbers not created through Shippo bill at **$0.01 per unique
number** (charged once; polling is free). One key covers UPS, USPS, and
FedEx. At personal Temu volume this is pennies per month.

1. Sign up at [goshippo.com](https://goshippo.com) (free Starter plan, add a card for usage billing) → Settings → **API** → copy the **Live token** (`shippo_live_…`) and set it as the `SHIPPO_KEY` secret.
2. Firebase console → Project settings → **Service accounts** → **Generate new private key** (downloads a JSON file).
3. In the GitHub repo → Settings → Secrets and variables → Actions → **Secrets** (Secrets, not Variables — these are real credentials):
   - `SHIPPO_KEY` — the live token
   - `FIREBASE_SERVICE_ACCOUNT` — the entire contents of the downloaded JSON file
4. The workflow also reads the existing `VITE_FIREBASE_DATABASE_URL` repo Variable. Test via Actions → "Carrier ETA refresh" → **Run workflow**, and check the run log.

Notes: only orders currently in "shipped" status are polled, newest first;
numbers the carrier reports delivered are dropped from polling; each unique
number is only ever billed once by the provider. The worker also has
adapters for EasyPost (`EASYPOST_KEY`, $0.02–0.03/tracker), direct UPS/USPS
developer APIs (`UPS_CLIENT_ID`/`UPS_CLIENT_SECRET`,
`USPS_CLIENT_ID`/`USPS_CLIENT_SECRET`, free but painful signups), and
Ship24/17TRACK (`SHIP24_KEY`/`SEVENTEEN_TRACK_KEY`, tight quotas). Adapters
fall through in that order — whichever produces a result first wins, so
partial credentials never break a run.

## Data & backups

All order data lives in this browser's **IndexedDB** — nothing is synced to a
server. IndexedDB has a much larger quota than the `localStorage` it replaced,
and the app requests persistent storage (`navigator.storage.persist()`) so the
browser won't evict it under storage pressure. Existing `localStorage` data is
migrated automatically on first load.

Backups & exports:

- **Settings → Export JSON** — full backup, re-importable via **Import JSON** (e.g. to move to another browser/device).
- **Export CSV** — on the Orders tab (order-level) and Items tab (item-level, exports exactly the current search/filter view); also in Settings. Opens directly in Excel/Sheets.

## Notes

- Item names/prices are read out of Temu's receipt images by Claude vision — spot-check new orders, especially unusual ones.
- `applyDiscounts()` (in `src/lib/discounts.js`) distributes order-level discounts across items proportionally so each item's "Paid" reflects its real cost.
- Sync is incremental: it tracks `processedIds` and `lastSync`, and only re-reads Gmail for messages since the last successful sync (or the last year, on first run / full re-sync).
