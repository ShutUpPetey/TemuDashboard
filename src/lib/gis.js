/* ============================================================
   Google Identity Services (GIS) — client-side OAuth for Gmail.
   Replaces the artifact's Gmail MCP connector. Requests a readonly
   Gmail scope token via the browser OAuth implicit flow and caches
   it in localStorage until it expires.
   ============================================================ */

const TOKEN_KEY = "temu-gmail-token";
const TOKEN_EXP_KEY = "temu-gmail-token-exp";
// Set after the FIRST successful token grant. Google only needs the full
// consent screen once per account+client; every later refresh can use
// prompt:"" (no UI at all while the browser's Google session is alive).
const CONSENT_KEY = "temu-gmail-consented";
// gmail.readonly = the app's core function; openid/email/profile let the
// same access token also sign into Firebase (cloud sync) — no second login.
// Adding scopes re-prompts Google consent once for existing sign-ins.
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly openid email profile";

let gisLoadPromise = null;

export function loadGis() {
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve(window.google);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error("Failed to load Google Identity Services script"));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

export function getStoredToken() {
  const tok = localStorage.getItem(TOKEN_KEY);
  const exp = Number(localStorage.getItem(TOKEN_EXP_KEY) || 0);
  if (tok && Date.now() < exp) return tok;
  return null;
}

function storeToken(token, expiresInSec) {
  localStorage.setItem(TOKEN_KEY, token);
  // subtract a small safety margin so we refresh slightly before actual expiry
  localStorage.setItem(TOKEN_EXP_KEY, String(Date.now() + Math.max(60, expiresInSec - 60) * 1000));
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
}

export function isSignedIn() {
  return !!getStoredToken();
}

export function hasConsented() {
  return !!localStorage.getItem(CONSENT_KEY);
}

let tokenClient = null;

// Must be called from a user gesture (button click) the FIRST time — the
// initial grant opens Google's consent popup. After that, prompt:"" lets
// Google refresh with no visible UI while the browser's Google session is
// alive. `silent: true` is the no-gesture variant (page load, timers): if
// Google can't refresh invisibly it tries to open a popup, which the
// browser blocks without a gesture → error_callback fires → we reject
// quietly instead of half-opening UI at a random moment.
export async function signIn({ interactive = true, silent = false } = {}) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      "VITE_GOOGLE_CLIENT_ID is not set. Add it to .env (see README's Google Cloud setup section)."
    );
  }
  const google = await loadGis();
  return new Promise((resolve, reject) => {
    // Belt and braces for silent mode: if neither callback ever fires
    // (seen with some third-party-cookie configurations), don't leave the
    // caller hanging forever.
    let timer = silent ? setTimeout(() => reject(new Error("Silent sign-in timed out")), 15000) : null;
    const settle = (fn) => (arg) => { if (timer) { clearTimeout(timer); timer = null; } fn(arg); };
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: settle((resp) => {
        if (resp.error) {
          reject(new Error(`Google sign-in failed: ${resp.error}`));
          return;
        }
        localStorage.setItem(CONSENT_KEY, "1");
        storeToken(resp.access_token, resp.expires_in || 3600);
        resolve(resp.access_token);
      }),
      error_callback: settle((err) => {
        reject(new Error(`Google sign-in failed: ${err?.type || "unknown error"}`));
      }),
    });
    // prompt "" = let Google decide (usually NO UI at all once consent
    // exists). The old hardcoded "consent" forced the full consent screen
    // on every hourly token expiry — the "I have to re-login constantly"
    // complaint. Only force it before the very first grant.
    tokenClient.requestAccessToken({ prompt: silent || hasConsented() ? "" : "consent" });
  });
}

export function signOut() {
  clearToken();
}

// Returns a valid token, prompting an interactive sign-in only if necessary
// and allowed (see `interactive`). Non-interactive callers (auto-sync on
// open, timers) get one silent-refresh attempt before giving up — with a
// live Google session that succeeds invisibly, so an expired token no
// longer kills background syncs. Interactive callers go straight to
// signIn: post-consent it uses prompt:"" anyway (Google shows UI only if
// it actually needs to), and attempting a silent pass first would burn the
// click's user-gesture, getting the fallback popup blocked.
export async function getToken({ interactive = true } = {}) {
  const existing = getStoredToken();
  if (existing) return existing;
  if (!interactive) {
    if (hasConsented()) {
      try { return await signIn({ silent: true }); } catch { /* needs real UI */ }
    }
    throw new Error("Not signed in to Google — click “Check Gmail” to sign in.");
  }
  return signIn({ interactive: true });
}
