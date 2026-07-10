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
};

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
