# Phone app (PWA) + push notifications — setup guide

The dashboard is now an installable Progressive Web App: it can live on your
phone's home screen like a native app (fullscreen, own icon, loads instantly)
and receive push notifications (e.g. "package delivered") even when it isn't
open. This document covers the one-time setup and how to install it on each
device.

## 1. Install the app on your phone

Nothing to configure first — installability ships with the normal deploy.
Open `https://shutuppetey.github.io/TemuDashboard/` on the phone, then:

**Android (Chrome)**

1. Tap the **⋮** menu (top right).
2. Tap **Add to Home screen** (Chrome may also show an **Install app** banner
   or menu entry — same thing).
3. Confirm. The 📦 "Temu Orders" icon appears on the home screen and opens
   fullscreen, without browser chrome.

**iPhone / iPad (Safari — must be Safari, not Chrome-on-iOS)**

1. Tap the **Share** button (square with an up arrow).
2. Scroll down, tap **Add to Home Screen**.
3. Confirm. Same result: 📦 "Temu Orders" on the home screen.

> iOS note: push notifications on iPhone ONLY work from the installed
> home-screen app (iOS 16.4 or newer) — never from a regular Safari tab.
> Install first, then open the app from the home screen and turn
> notifications on there. The Settings panel reminds you about this when it
> detects the situation.

Desktop Chrome/Edge can install it too (install icon at the right end of the
address bar) — useful for notifications on the desktop.

## 2. One-time console setup for push notifications

Push uses Firebase Cloud Messaging (FCM), riding on the same
`temu-dashboard-962d6` Firebase project the cloud sync already uses. Two
values need to be fetched from the Firebase console once, then added to the
repo. Both are public-safe identifiers (like the rest of the `VITE_FIREBASE_*`
config), so they go in repo **Variables**, not Secrets.

### 2a. Get the Sender ID

1. [Firebase console](https://console.firebase.google.com/) → project
   **temu-dashboard-962d6**.
2. Gear icon → **Project settings** → **Cloud Messaging** tab.
3. Copy the **Sender ID** (a ~12-digit number). If the tab says the
   "Cloud Messaging API (Legacy)" is disabled, that's fine — only the
   **Firebase Cloud Messaging API (V1)** needs to be enabled, which it is by
   default on current projects.

### 2b. Generate the Web Push (VAPID) key

1. Same **Cloud Messaging** tab, scroll to **Web configuration** →
   **Web Push certificates**.
2. Click **Generate key pair** (if one already exists, just copy it).
3. Copy the **Key pair** value — a long string starting with `B…`. This is
   the VAPID public key; the private half stays inside Firebase.

### 2c. Add both as repo Variables

GitHub → `ShutUpPetey/TemuDashboard` → **Settings** → **Secrets and
variables** → **Actions** → **Variables** tab → **New repository variable**:

| Name                                | Value                          |
| ----------------------------------- | ------------------------------ |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | the Sender ID from step 2a     |
| `VITE_FIREBASE_VAPID_KEY`           | the key pair value from step 2b |

### 2d. Pass them through the deploy workflow ⚠

`.github/workflows/deploy.yml` whitelists each `VITE_*` variable explicitly
in the build step's `env:` block — a new Variable does nothing until it's
listed there. Add these two lines alongside the existing `VITE_FIREBASE_*`
entries:

```yaml
          VITE_FIREBASE_MESSAGING_SENDER_ID: ${{ vars.VITE_FIREBASE_MESSAGING_SENDER_ID }}
          VITE_FIREBASE_VAPID_KEY: ${{ vars.VITE_FIREBASE_VAPID_KEY }}
```

Then push (or re-run the deploy workflow) so a fresh build picks them up.

If the variables are missing the app still builds and runs exactly as before —
the Notifications toggle in Settings just reports "Not set up".

### Local dev

For `npm run dev` on the PC, add the same two values to `.env` (gitignored):

```
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_VAPID_KEY=...
```

Note the service worker only exists in the **built** app, so actually
receiving pushes needs the deployed site (or `npm run build` then
`npm run preview`) — the dev server will refuse the toggle with a clear error.

### Firebase security rules

No change needed. Device tokens are stored at `manifest/{uid}/push/{key}`,
which is inside the `manifest/$uid` subtree the existing rules already scope
to each signed-in user.

## 3. Turn notifications on (per device)

On each device that should get notifications:

1. Open the app (on iPhone: the home-screen app, not a Safari tab).
2. Make sure you're signed in with Google (Settings → Google) — device
   registrations are stored under your account.
3. **Settings → Notifications → "Push notifications on this device"** →
   toggle on → accept the browser's permission prompt.

The device registers itself at `manifest/{uid}/push/` in Firebase; the
scheduled GitHub Action reads that list and sends pushes (delivery updates
etc.). Toggling off deletes the device's token and its registration. The
registration self-heals on each app open (tokens rotate; revoking the
browser permission flips the toggle back off honestly).

## Troubleshooting

- **Toggle says "Not set up"** — the two Variables are missing from the repo
  or from `deploy.yml`'s `env:` block (step 2d), or the deploy hasn't re-run
  since adding them.
- **Toggle says sign in first** — cloud sync isn't connected; Settings →
  Google → Sign in with Google.
- **iPhone shows the install hint** — that's expected in a Safari tab; add
  the app to the home screen and enable from there.
- **No notification arrived** — check the device row exists under
  `manifest/{uid}/push/` in the Firebase console (Realtime Database), and
  that the phone allows notifications for the installed app (iOS Settings →
  Notifications → Temu Orders). Foreground pushes (app open on screen) are
  logged to the sync log instead of/in addition to popping a banner.
- **Old icon or stale app after a deploy** — the service worker updates on
  the next open; close the app fully and reopen once.
