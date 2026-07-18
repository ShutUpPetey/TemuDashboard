/* ============================================================
   Optional Firebase Realtime Database sync layer.

   Purpose: one shared data store across devices (desktop + phone
   shells currently have separate IndexedDB stores). RTDB is a JSON
   tree and this app's state is one JSON blob — natural fit, free
   tier, and onValue gives live cross-device updates.

   Design notes:
   - OPTIONAL: activates only when VITE_FIREBASE_API_KEY and
     VITE_FIREBASE_DATABASE_URL are set. Without them the app runs
     exactly as before (IndexedDB only).
   - NO new login: Firebase Auth accepts the Google OAuth access
     token the app already gets for Gmail (signInWithCredential),
     so the existing "Sign in with Google" covers both. Requires
     the OAuth client ID to be safelisted in Firebase Auth (README).
   - SDK is loaded on demand from Google's CDN (dynamic import), so
     there's no npm dependency and zero cost when unconfigured.
   - Data lives at manifest/{uid}/state as { json, updatedAt }. The blob
     is stored whole, but conflict resolution is NOT newest-blob-wins:
     App.jsx merges local and remote PER ORDER via lib/syncMerge.js
     (each order carries its own updatedAt). IndexedDB remains the
     local cache/offline fallback.

   Suggested security rules (Firebase console → Realtime Database → Rules) —
   see README → "Admin access (optional, multi-user)" for the version that
   also lets one admin email read every user's data:
     {
       "rules": {
         "manifest": {
           "$uid": { ".read": "$uid === auth.uid", ".write": "$uid === auth.uid" }
         }
       }
     }
   ============================================================ */

const CDN = "https://www.gstatic.com/firebasejs/10.12.2";

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  // Push notifications only (FCM). Optional on top of optional — without it
  // (and the VAPID key below) cloud sync still works, the notifications
  // toggle just shows as unavailable. See docs/phone-app-setup.md.
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

// FCM Web Push certificate public key (Firebase console → Cloud Messaging →
// Web Push certificates). Public-safe, like the rest of the config.
const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

export const cloudConfigured = () => !!(cfg.apiKey && cfg.databaseURL);

let loadedPromise = null;
async function fb() {
  if (!loadedPromise) {
    loadedPromise = Promise.all([
      import(/* @vite-ignore */ `${CDN}/firebase-app.js`),
      import(/* @vite-ignore */ `${CDN}/firebase-auth.js`),
      import(/* @vite-ignore */ `${CDN}/firebase-database.js`),
    ]).then(([appMod, authMod, dbMod]) => {
      const app = appMod.initializeApp(cfg);
      return { app, authMod, dbMod };
    });
  }
  return loadedPromise;
}

let uid = null;
let email = null;

/* Sign into Firebase with the Google OAuth access token the app already
   holds for Gmail. Idempotent — safe to call on every token refresh.
   Returns { uid, email } (email powers the admin check in App.jsx and is
   also stamped into the directory record below). */
export async function cloudSignIn(googleAccessToken) {
  if (!cloudConfigured()) throw new Error("Firebase is not configured");
  const { app, authMod } = await fb();
  const auth = authMod.getAuth(app);
  if (auth.currentUser) {
    uid = auth.currentUser.uid;
    email = auth.currentUser.email || null;
  } else {
    const cred = authMod.GoogleAuthProvider.credential(null, googleAccessToken);
    const res = await authMod.signInWithCredential(auth, cred);
    uid = res.user.uid;
    email = res.user.email || null;
  }
  writeDirectoryEntry().catch(() => { /* best-effort; admin directory just won't list this user yet */ });
  return { uid, email };
}

export function currentUser() {
  return { uid, email };
}

/* Fresh Firebase ID token for the signed-in user, or null when signed
   out / unconfigured. Used by lib/anthropic.js to authenticate against
   the optional /claude relay proxy (the relay verifies it server-side
   and checks the uid against its allowlist). The SDK caches and
   auto-refreshes the token internally, so calling this per request is
   cheap. Never throws — proxy availability is always best-effort and
   callers fall back to the local key. */
export async function cloudIdToken() {
  if (!cloudConfigured() || !uid) return null;
  try {
    const { app, authMod } = await fb();
    const user = authMod.getAuth(app).currentUser;
    return user ? await user.getIdToken() : null;
  } catch {
    return null;
  }
}

/* Try restoring the persisted Firebase session — the Firebase SDK keeps
   its own long-lived refresh token in browser storage, entirely separate
   from the ~1h Google access token used for Gmail. Resolves { uid, email }
   or null if nothing is persisted. This is what lets cloud sync reconnect
   on page load long after the Gmail token expired, instead of silently
   degrading to local-only saves. */
export async function cloudRestore() {
  if (!cloudConfigured()) return null;
  const { app, authMod } = await fb();
  const auth = authMod.getAuth(app);
  // onAuthStateChanged fires once the SDK finishes loading the persisted
  // session (or immediately with null if there isn't one).
  const user = await new Promise((resolve) => {
    const unsub = authMod.onAuthStateChanged(auth, (u) => { unsub(); resolve(u); });
  });
  if (!user) return null;
  uid = user.uid;
  email = user.email || null;
  writeDirectoryEntry().catch(() => { /* best-effort; see cloudSignIn */ });
  return { uid, email };
}

export async function cloudSignOut() {
  uid = null;
  email = null;
  if (!loadedPromise) return;
  try {
    const { app, authMod } = await fb();
    await authMod.signOut(authMod.getAuth(app));
  } catch { /* best-effort */ }
}

/* Every signed-in user (not just the admin) stamps their own directory
   entry — this is the ONLY thing anyone writes outside their own
   manifest/{uid} subtree, and the rules below only let a user write their
   OWN entry. It's what lets the admin view (see App.jsx / AdminPanel.jsx)
   list "who's registered" without needing a separate backend. */
async function writeDirectoryEntry() {
  const { app, dbMod } = await fb();
  const ref = dbMod.ref(dbMod.getDatabase(app), `manifest/_directory/${uid}`);
  await dbMod.set(ref, { email, lastSeen: Date.now() });
}

/* Admin-only: list every registered user's directory entry. Firebase rules
   restrict reading manifest/_directory to the configured admin email, so
   this simply throws (permission denied) for anyone else — no client-side
   role check needed to keep it honest. */
export async function cloudListDirectory() {
  const { app, dbMod } = await fb();
  const ref = dbMod.ref(dbMod.getDatabase(app), "manifest/_directory");
  const snap = await dbMod.get(ref);
  return snap.exists() ? snap.val() : {};
}

/* Admin-only, read-only, one-time fetch of another user's state (never a
   live subscription, never a write) — used by the "View data" admin
   switcher. Firebase rules gate this the same way as cloudGet(); a
   non-admin caller simply gets a permission-denied error. */
export async function cloudGetUserState(otherUid) {
  const { app, dbMod } = await fb();
  const ref = dbMod.ref(dbMod.getDatabase(app), `manifest/${otherUid}/state`);
  const snap = await dbMod.get(ref);
  return snap.exists() ? snap.val() : null;
}

async function stateRef() {
  const { app, dbMod } = await fb();
  if (!uid) throw new Error("Cloud sync isn't signed in yet");
  return { dbMod, ref: dbMod.ref(dbMod.getDatabase(app), `manifest/${uid}/state`) };
}

/* How far this device's clock is from Firebase's server clock, in ms
   (positive = local clock runs ahead). The per-order sync merge trusts
   each device's own Date.now() stamps, so a badly skewed clock lets a
   device's edits permanently out-rank genuinely newer ones from a
   correctly-clocked device — this can't be fixed silently, but it CAN
   be detected and warned about (see connectCloud in App.jsx). */
export async function cloudClockSkew() {
  const { app, dbMod } = await fb();
  const snap = await dbMod.get(dbMod.ref(dbMod.getDatabase(app), ".info/serverTimeOffset"));
  return -(snap.val() || 0); // serverTime ≈ Date.now() + offset
}

/* Returns { json, updatedAt } or null. */
export async function cloudGet() {
  const { dbMod, ref } = await stateRef();
  const snap = await dbMod.get(ref);
  return snap.exists() ? snap.val() : null;
}

export async function cloudSet(json, updatedAt) {
  const { dbMod, ref } = await stateRef();
  await dbMod.set(ref, { json, updatedAt });
}

/* Live updates — cb receives { json, updatedAt } (or null) on every remote
   write, including our own (caller de-dupes by updatedAt). Returns an
   unsubscribe function. */
export async function cloudSubscribe(cb) {
  const { dbMod, ref } = await stateRef();
  return dbMod.onValue(ref, (snap) => cb(snap.exists() ? snap.val() : null));
}

/* Live carrier-tracking info written by the scheduled GitHub Action
   (scripts/carrier-eta.mjs) — a map of trackingNumber → { status, etaFrom,
   etaTo, eventDesc, ... }. The app only reads this path. */
export async function cloudSubscribeCarrier(cb) {
  const { app, dbMod } = await fb();
  if (!uid) throw new Error("Cloud sync isn't signed in yet");
  const ref = dbMod.ref(dbMod.getDatabase(app), `manifest/${uid}/carrier`);
  return dbMod.onValue(ref, (snap) => cb(snap.exists() ? snap.val() : {}));
}

/* ============================================================
   Push notifications (FCM web push).

   Device tokens are registered at manifest/{uid}/push/{key} =
   { token, ua, updatedAt } — the GitHub Action reads that map and sends
   DATA-ONLY messages ({ data: { title, body, tag, url } }, no
   `notification` key); src/sw.js displays them. `key` is a short hex hash
   of the token because raw FCM tokens contain ':' — illegal in RTDB keys.

   Enabling is per-DEVICE (an FCM token identifies one browser install),
   so the "is push on here?" marker lives in localStorage, deliberately
   NOT in the synced state blob — mirroring how the Anthropic key and
   thumb size are per-device too.
   ============================================================ */

const PUSH_MARKER_KEY = "temu-push-v1"; // { token, key } once enabled on this device

export const pushConfigured = () =>
  cloudConfigured() && !!(cfg.messagingSenderId && VAPID_KEY);

let messagingModPromise = null;
async function messagingMod() {
  if (!messagingModPromise) {
    messagingModPromise = import(/* @vite-ignore */ `${CDN}/firebase-messaging.js`);
  }
  return messagingModPromise;
}

/* Can THIS browser do web push at all? False on iOS Safari in a normal tab
   (Notification is undefined there until the PWA is installed to the home
   screen, iOS 16.4+), false when unconfigured, and defers the final word to
   firebase-messaging's own isSupported() probe. */
export async function pushSupported() {
  if (!pushConfigured()) return false;
  if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    const m = await messagingMod();
    return await m.isSupported();
  } catch {
    return false;
  }
}

/* djb2 over the token → short hex id. Not cryptographic and doesn't need to
   be — it only has to be a stable, RTDB-legal key that two tokens on the
   same account won't realistically collide on. */
function pushKey(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h * 33) ^ token.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function readPushMarker() {
  try {
    return JSON.parse(localStorage.getItem(PUSH_MARKER_KEY) || "null");
  } catch {
    return null;
  }
}

/* Did the user turn push on for this device? (The toggle's persisted state —
   whether it still WORKS is re-verified by pushRefresh on each open.) */
export const pushLocallyEnabled = () => !!readPushMarker();

/* The PWA's own service worker registration (src/sw.js, registered by
   vite-plugin-pwa under the app's base path). FCM must be pointed at it
   explicitly or it tries to register its own firebase-messaging-sw.js,
   which doesn't exist here. Null when no SW is registered (dev server). */
async function swRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)) || null;
}

async function writeTokenRecord(dbMod, app, token) {
  const key = pushKey(token);
  await dbMod.set(dbMod.ref(dbMod.getDatabase(app), `manifest/${uid}/push/${key}`), {
    token,
    ua: (navigator.userAgent || "").slice(0, 160), // enough to tell devices apart in the console
    updatedAt: Date.now(),
  });
  localStorage.setItem(PUSH_MARKER_KEY, JSON.stringify({ token, key }));
  return key;
}

/* Turn push on for this device: permission prompt → FCM token bound to our
   service worker → token record into RTDB. Must be called from a user
   gesture (the Settings toggle) so the permission prompt isn't suppressed.
   Requires cloud sign-in — tokens live under manifest/{uid}. */
export async function pushEnable() {
  if (!pushConfigured()) throw new Error("Push isn't configured (missing sender ID / VAPID key)");
  if (!uid) throw new Error("Sign in with Google first — push tokens are stored per account");
  const reg = await swRegistration();
  if (!reg) throw new Error("No service worker registered — push only works in the deployed/built app");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission was " + perm);
  const { app, dbMod } = await fb();
  const m = await messagingMod();
  const token = await m.getToken(m.getMessaging(app), {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration: reg,
  });
  if (!token) throw new Error("FCM returned no token");
  await writeTokenRecord(dbMod, app, token);
  return token;
}

/* Re-validate this device's token on app open (tokens rotate — Chrome
   refreshes them periodically and getToken returns the current one). Also
   bumps updatedAt so the sender can skip long-dead devices. Silently
   disables (clears the marker) if permission was revoked in the browser
   since — the Settings toggle then honestly shows "off". Returns the fresh
   token, or null when push is off/unavailable. */
export async function pushRefresh() {
  const marker = readPushMarker();
  if (!marker || !pushConfigured() || !uid) return null;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    localStorage.removeItem(PUSH_MARKER_KEY);
    return null;
  }
  const reg = await swRegistration();
  if (!reg) return null; // dev server — leave the marker for the real app
  const { app, dbMod } = await fb();
  const m = await messagingMod();
  const token = await m.getToken(m.getMessaging(app), {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration: reg,
  });
  if (!token) return null;
  if (marker.token && marker.token !== token) {
    // Rotated — drop the stale record so the sender doesn't keep hitting a
    // dead token (FCM errors on it, but why leave garbage).
    await dbMod
      .remove(dbMod.ref(dbMod.getDatabase(app), `manifest/${uid}/push/${marker.key}`))
      .catch(() => { /* best-effort */ });
  }
  await writeTokenRecord(dbMod, app, token);
  return token;
}

/* Turn push off for this device: delete the FCM token (stops delivery at
   the source) and remove the RTDB record + local marker. Best-effort all
   the way down — a half-failed disable still leaves the marker cleared so
   the UI is off, and a stale RTDB record just gets an FCM error when the
   sender tries it. */
export async function pushDisable() {
  const marker = readPushMarker();
  localStorage.removeItem(PUSH_MARKER_KEY);
  if (!marker) return;
  try {
    const { app, dbMod } = await fb();
    if (uid) {
      await dbMod
        .remove(dbMod.ref(dbMod.getDatabase(app), `manifest/${uid}/push/${marker.key}`))
        .catch(() => { /* best-effort */ });
    }
    const m = await messagingMod();
    if (await m.isSupported()) await m.deleteToken(m.getMessaging(app)).catch(() => { /* best-effort */ });
  } catch { /* offline etc. — marker is already cleared, which is the part the UI needs */ }
}

/* Foreground pushes (app open in the tab that would get the notification):
   the SW's push handler doesn't fire for these — FCM routes them to
   onMessage instead. cb receives the raw payload ({ data: {...} }); App.jsx
   just logs it to the sync log. Returns an unsubscribe function. */
export async function pushOnForeground(cb) {
  const { app } = await fb();
  const m = await messagingMod();
  if (!(await m.isSupported())) return () => {};
  return m.onMessage(m.getMessaging(app), cb);
}
