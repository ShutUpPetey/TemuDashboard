/* ============================================================
   Google Identity Services (GIS) — client-side OAuth for Gmail.
   Replaces the artifact's Gmail MCP connector. Requests a readonly
   Gmail scope token via the browser OAuth implicit flow and caches
   it in localStorage until it expires.
   ============================================================ */

const TOKEN_KEY = "temu-gmail-token";
const TOKEN_EXP_KEY = "temu-gmail-token-exp";
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

let tokenClient = null;

// Must be called from a user gesture (button click) the first time, since it
// opens a Google consent popup. Once a token is cached, subsequent calls can
// silently refresh without a visible popup as long as the browser allows it.
export async function signIn({ interactive = true } = {}) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      "VITE_GOOGLE_CLIENT_ID is not set. Add it to .env (see README's Google Cloud setup section)."
    );
  }
  const google = await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(`Google sign-in failed: ${resp.error}`));
          return;
        }
        storeToken(resp.access_token, resp.expires_in || 3600);
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        reject(new Error(`Google sign-in failed: ${err?.type || "unknown error"}`));
      },
    });
    tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
  });
}

export function signOut() {
  clearToken();
}

// Returns a valid token, prompting an interactive sign-in only if necessary
// and allowed (see `interactive`). Throws if a token is needed but the caller
// disallowed the interactive popup (e.g. an automatic background sync).
export async function getToken({ interactive = true } = {}) {
  const existing = getStoredToken();
  if (existing) return existing;
  if (!interactive) {
    throw new Error("Not signed in to Google — click “Check Gmail” to sign in.");
  }
  return signIn({ interactive: true });
}
