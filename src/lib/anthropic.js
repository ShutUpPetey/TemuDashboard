/* ============================================================
   Browser-direct Anthropic API client.
   Replaces the keyless artifact-only `fetch("https://api.anthropic.com/v1/messages")`
   call with a user-supplied API key, sent from the browser with the
   `anthropic-dangerous-direct-browser-access` header (required for
   CORS when calling api.anthropic.com directly from a page, since the
   API doesn't allow browser origins by default).

   SECURITY NOTE: the API key lives only in this browser's localStorage
   and is sent directly from the browser to Anthropic on every call. It
   is never sent anywhere else and is never committed to the repo. Since
   it's client-side, anyone with access to this browser profile (or to
   devtools while the page is open) could read it — acceptable for a
   personal single-user tool, not for anything shared/multi-user.
   ============================================================ */

const MODEL = "claude-sonnet-5";
const API_KEY_STORAGE_KEY = "temu-anthropic-key";

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE_KEY) || "";
}

export function setApiKey(key) {
  if (key) localStorage.setItem(API_KEY_STORAGE_KEY, key);
  else localStorage.removeItem(API_KEY_STORAGE_KEY);
}

let currentAbort = null;

export async function callClaude(userContent, { timeoutMs = 150000, maxTokens = 2000 } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No Anthropic API key set — add one in Settings.");
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
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
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
