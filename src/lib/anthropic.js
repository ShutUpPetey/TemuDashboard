/* ============================================================
   Anthropic API client — two modes, decided per call:

   1. PROXY (preferred when available): if VITE_CLAUDE_PROXY_URL is set
      (the cloud/relay function's /claude endpoint) AND the user has a
      live Firebase session, calls go to the relay with the Firebase ID
      token as `Authorization: Bearer`. The Anthropic key lives ONLY in
      the relay's server-side env — it never reaches this bundle, the
      network tab, or localStorage. The relay verifies the token and
      enforces its own uid allowlist, model, and max_tokens caps.

   2. LOCAL KEY (original mode, and the fallback): a user-supplied API
      key from this browser's localStorage, sent directly to
      api.anthropic.com with the `anthropic-dangerous-direct-browser-access`
      header (required for CORS when calling the API from a page).

   SECURITY NOTE: in local-key mode the key lives only in this browser's
   localStorage and is sent only to Anthropic — never anywhere else,
   never committed to the repo. Anyone with this browser profile (or
   devtools) could read it, which is why proxy mode exists for the
   multi-user case: the browser then holds no Anthropic secret at all,
   only its own Firebase session. The relay's RELAY_TOKEN is a separate
   secret for the Pub/Sub/Shippo endpoints and is never used here.
   ============================================================ */

import { cloudIdToken } from "./firebase";

const MODEL = "claude-sonnet-5";
const API_KEY_STORAGE_KEY = "temu-anthropic-key";
const PROXY_URL = import.meta.env.VITE_CLAUDE_PROXY_URL || "";

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE_KEY) || "";
}

export function setApiKey(key) {
  if (key) localStorage.setItem(API_KEY_STORAGE_KEY, key);
  else localStorage.removeItem(API_KEY_STORAGE_KEY);
}

/* Which call path callClaude would take right now:
   "proxy" (relay configured + signed in to cloud), "local-key"
   (pasted key in localStorage), or "none". Async because the proxy
   check needs a live Firebase ID token. Used by Settings + log lines
   only — callClaude re-decides per call. */
export async function claudeVia() {
  if (PROXY_URL && (await cloudIdToken())) return "proxy";
  return getApiKey() ? "local-key" : "none";
}

let currentAbort = null;

export async function callClaude(userContent, { timeoutMs = 150000, maxTokens = 2000 } = {}) {
  // Proxy first: relay configured AND signed in → server-held key. The
  // Anthropic key + version headers stay off this path entirely; the
  // relay adds them server-side (and enforces model/max_tokens itself).
  const idToken = PROXY_URL ? await cloudIdToken() : null;
  const apiKey = idToken ? null : getApiKey();
  if (!idToken && !apiKey) {
    throw new Error("No way to call Claude — add an API key in Settings, or sign in to cloud sync to use the shared key.");
  }
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: userContent }],
  };
  currentAbort = new AbortController();
  const timer = setTimeout(() => currentAbort.abort(), timeoutMs);
  try {
    // Promise.race guarantees the timeout fires even if the runtime's fetch
    // implementation ignores AbortController signals.
    const res = await Promise.race([
      fetch(idToken ? PROXY_URL : "https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: idToken
          ? {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`,
            }
          : {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "anthropic-dangerous-direct-browser-access": "true",
            },
        body: JSON.stringify(body),
        signal: currentAbort.signal,
      }),
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error(`No response after ${timeoutMs / 1000}s — the API call is hanging`)),
          timeoutMs + 2000
        )
      ),
    ]);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${text}`.slice(0, 200));
    }
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Call timed out after ${timeoutMs / 1000}s (or was cancelled)`);
    throw e;
  } finally {
    clearTimeout(timer);
    currentAbort = null;
  }
}

export function cancelCurrentCall() {
  try {
    currentAbort?.abort();
  } catch {
    /* noop */
  }
}

export function textOf(resp) {
  return (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/* ============================================================
   Cost estimation for bulk vision-call actions (e.g. "Fix all
   estimated prices" in the Review queue).

   List pricing for claude-sonnet-5 as of this writing — deliberately
   NOT the temporary intro pricing (~33% cheaper through 2026-08-31),
   so this constant stays correct indefinitely instead of quietly
   under-estimating once the intro period ends. Real charges may be
   somewhat lower than this estimate until then.
   ============================================================ */
const PRICE_PER_MTOK_INPUT = 3.0;
const PRICE_PER_MTOK_OUTPUT = 15.0;
const USAGE_LOG_KEY = "temu-anthropic-usage-log";
const USAGE_LOG_MAX = 30;

function costUSD(inputTokens, outputTokens) {
  return (inputTokens / 1e6) * PRICE_PER_MTOK_INPUT + (outputTokens / 1e6) * PRICE_PER_MTOK_OUTPUT;
}

/* Call after every real API call whose cost is worth estimating later.
   `tag` scopes the rolling log to one call "shape" (prompt + image count
   pattern) so averaging stays meaningful — e.g. fixEstimatedPrices calls
   shouldn't be averaged together with the very different order-parsing
   calls. Keeps only the last USAGE_LOG_MAX entries per tag combined. */
export function recordUsage(tag, usage) {
  if (!usage) return;
  try {
    const log = JSON.parse(localStorage.getItem(USAGE_LOG_KEY) || "[]");
    log.push({ tag, input: usage.input_tokens || 0, output: usage.output_tokens || 0, at: Date.now() });
    localStorage.setItem(USAGE_LOG_KEY, JSON.stringify(log.slice(-USAGE_LOG_MAX)));
  } catch { /* best-effort — losing the log just means falling back to the default estimate */ }
}

/* Average $/call for `tag`, computed from this browser's own real past
   calls once there are any (self-correcting — adapts to how big/complex
   this user's actual orders are), else `fallbackUSD` (the user's own
   observed real-world cost, per order, is a reasonable starting point
   before any history exists). Returns sampleSize so callers can show
   "estimated from N past calls" vs. "rough estimate". */
export function estimateCostPerCall(tag, fallbackUSD = 0.01) {
  try {
    const log = JSON.parse(localStorage.getItem(USAGE_LOG_KEY) || "[]");
    const matches = log.filter((e) => e.tag === tag);
    if (!matches.length) return { perCall: fallbackUSD, sampleSize: 0 };
    const avgInput = matches.reduce((s, e) => s + e.input, 0) / matches.length;
    const avgOutput = matches.reduce((s, e) => s + e.output, 0) / matches.length;
    return { perCall: costUSD(avgInput, avgOutput), sampleSize: matches.length };
  } catch {
    return { perCall: fallbackUSD, sampleSize: 0 };
  }
}

export function extractJSON(resp) {
  const raw = textOf(resp).replace(/```json|```/g, "").trim();
  const start = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  const s = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (s === -1) throw new Error("No JSON in reply. Claude said: “" + raw.slice(0, 160) + "…”");
  // walk for balanced close
  const open = raw[s], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === open) depth++;
    if (c === close) { depth--; if (depth === 0) return JSON.parse(raw.slice(s, i + 1)); }
  }
  throw new Error("Truncated JSON (response hit token limit)");
}
