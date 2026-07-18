/* ============================================================
   Event relay — a tiny 2nd-gen Google Cloud Function (Node 20)
   that turns external "something happened" webhooks into GitHub
   `repository_dispatch` events, so the repo's Actions run within
   seconds instead of waiting for their cron tick.

   Three POST paths, same handler:
     /gmail?token=…   Pub/Sub push endpoint. Gmail users.watch
                      (registered by scripts/gmail-sync.mjs each
                      run) publishes to a topic on every inbox
                      change; a push subscription POSTs the
                      message here → dispatch "gmail-sync".
     /shippo?token=…  Shippo "Track Updated" webhook → dispatch
                      "carrier-eta".
     /claude          Anthropic vision proxy for the browser app —
                      forwards the JSON body to api.anthropic.com
                      with a server-held ANTHROPIC_API_KEY, so the
                      dashboard works without a pasted key. See
                      docs/near-realtime-setup.md → "/claude proxy".

   Deployed with gcloud per docs/near-realtime-setup.md. Zero npm
   dependencies beyond the functions-framework (Node 20 has fetch).

   Auth (two mechanisms, deliberately NOT interchangeable):
   - /gmail + /shippo: a shared secret in the `token` query param,
     compared in constant time. Both producers only support static
     URLs cleanly (Shippo can ONLY do a static URL; Pub/Sub push
     URLs carry query params fine), so one mechanism covers both.
     Pub/Sub OIDC auth would be stronger for the /gmail path, but
     the token keeps this function dependency-free and both
     producers are low-risk — the worst a forged request can do is
     trigger a sync run that finds nothing new.
   - /claude: a Firebase ID token in `Authorization: Bearer …`,
     verified against Google's Identity Toolkit REST API and then
     checked against the ALLOWED_UIDS env allowlist. RELAY_TOKEN is
     NEVER accepted here — that secret lives in Pub/Sub/Shippo URLs
     and must never be shipped to (or used from) the browser; the
     browser only ever holds its own short-lived Firebase session.

   Responses: always answer fast, and always 2xx once the token
   checks out — Pub/Sub retries non-2xx responses aggressively
   (with backoff, for days), so even a failed GitHub call is
   logged and swallowed rather than surfaced as a 5xx. The cron
   schedules on both workflows are the delivery guarantee; this
   relay is purely a latency optimization.
   ============================================================ */

import { createHash, timingSafeEqual } from "node:crypto";
import { http } from "@google-cloud/functions-framework";

const REPO = process.env.GITHUB_REPO || "ShutUpPetey/TemuDashboard";

/* Best-effort in-memory debounce, one timer per event type. Cloud
   Functions keeps instances warm between bursts, so this usually
   collapses e.g. the 3–5 Pub/Sub messages one email generates into
   a single dispatch — but it is ONLY best-effort (a cold start or a
   second instance has fresh timers). The real collapse mechanism is
   each workflow's `concurrency` group: dispatches that land while a
   run is active queue into at most one follow-up run. */
const DEBOUNCE_MS = 90_000;
const lastDispatch = { "gmail-sync": 0, "carrier-eta": 0 };

/* Constant-time token check. Hashing both sides first gives
   timingSafeEqual equal-length inputs (it throws on length
   mismatch, which would itself leak the length). */
function tokenOk(req) {
  const want = process.env.RELAY_TOKEN || "";
  if (!want) return false; // unset secret = closed, never open
  const h = (s) => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(h(req.query.token || ""), h(want));
}

/* ------------------------------------------------------------
   /claude — server-held-key Anthropic proxy for the browser app.

   The static site can't hold an Anthropic key (anything in the
   bundle or localStorage is readable by whoever loads the page),
   so vision calls come here instead: the browser authenticates
   with its Firebase ID token, this function checks the uid is
   allowlisted, then forwards the request to api.anthropic.com
   with the key from its own env. Model and max_tokens are forced
   server-side so a stolen ID token can at worst spend vision-call
   money at the app's own rate, never run arbitrary big jobs.
   ------------------------------------------------------------ */

const CLAUDE_MODEL = "claude-sonnet-5"; // must match src/lib/anthropic.js
const CLAUDE_MAX_TOKENS = 4000; // ceiling; client asks for ≤2000 today
const CLAUDE_MAX_BODY = 25 * 1024 * 1024; // receipt images are big; gen2 caps requests at 32 MB
const CLAUDE_TIMEOUT_MS = 120_000; // vision calls are slow — deploy the function with --timeout to match

function claudeCors(res) {
  res.set("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "https://shutuppetey.github.io");
  res.set("Access-Control-Allow-Headers", "authorization, content-type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Max-Age", "3600");
  return res;
}

/* Verify a Firebase ID token dependency-free via the Identity Toolkit
   REST API — a 200 with a users[0].localId means the token is valid,
   unexpired, and minted by THIS Firebase project (the lookup is scoped
   by the project's own public web API key). Returns the uid or null. */
async function verifyIdToken(idToken) {
  const key = process.env.FIREBASE_API_KEY || "";
  if (!key || !idToken) return null;
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!r.ok) return null; // 400 = invalid/expired token
    const data = await r.json().catch(() => null);
    return data?.users?.[0]?.localId || null;
  } catch (e) {
    console.error(`claude: token verification failed (${e.message}).`);
    return null;
  }
}

async function handleClaude(req, res) {
  claudeCors(res);
  if (req.method === "OPTIONS") return res.status(204).end(); // CORS preflight
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Fail closed with a clear message when the proxy isn't configured —
  // an unset allowlist must never mean "everyone may spend the key".
  const allowedUids = (process.env.ALLOWED_UIDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowedUids.length || !process.env.ANTHROPIC_API_KEY || !process.env.FIREBASE_API_KEY) {
    return res.status(503).json({ error: "proxy not configured (ANTHROPIC_API_KEY / FIREBASE_API_KEY / ALLOWED_UIDS env vars required)" });
  }

  // Auth: Firebase ID token only. The RELAY_TOKEN query param is
  // deliberately not consulted on this path.
  const m = /^Bearer\s+(.+)$/i.exec(req.get?.("authorization") || req.headers?.authorization || "");
  const uid = await verifyIdToken(m ? m[1] : "");
  if (!uid) return res.status(401).json({ error: "missing or invalid Firebase ID token" });
  if (!allowedUids.includes(uid)) return res.status(403).json({ error: "this account is not allowed to use the shared key" });

  if (Number(req.get?.("content-length") || req.headers?.["content-length"] || 0) > CLAUDE_MAX_BODY) {
    return res.status(413).json({ error: "request body too large" });
  }
  const body = req.body && typeof req.body === "object" ? req.body : null;
  if (!body) return res.status(400).json({ error: "JSON body required" });

  // Server-side guardrails: the client's model choice is ignored and
  // max_tokens is clamped, whatever the request said.
  const maxTokens = Math.floor(Number(body.max_tokens)) || CLAUDE_MAX_TOKENS;
  const forwarded = { ...body, model: CLAUDE_MODEL, max_tokens: Math.min(Math.max(maxTokens, 1), CLAUDE_MAX_TOKENS) };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(forwarded),
      signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    });
    // Status + JSON body verbatim — the client reads `usage` for its
    // cost estimates and expects Anthropic's own error shapes.
    const text = await r.text();
    res.status(r.status).set("content-type", "application/json");
    return res.send(text);
  } catch (e) {
    console.error(`claude: upstream call failed (${e.message}).`);
    return res.status(502).json({ error: `upstream call failed: ${e.message}` });
  }
}

http("relay", async (req, res) => {
  // /claude has its own auth + CORS story — branch before the shared
  // POST/token checks so the /gmail + /shippo behavior stays untouched.
  if ((req.path || "/").replace(/\/+$/, "").endsWith("/claude")) return handleClaude(req, res);

  if (req.method !== "POST") return res.status(405).send("POST only");
  if (!tokenOk(req)) return res.status(403).send("forbidden");

  const path = (req.path || "/").replace(/\/+$/, "");
  const eventType =
    path.endsWith("/gmail") ? "gmail-sync"
    : path.endsWith("/shippo") ? "carrier-eta"
    : null;
  if (!eventType) return res.status(404).send("unknown path");

  const now = Date.now();
  if (now - lastDispatch[eventType] < DEBOUNCE_MS) {
    // Recently dispatched — the queued/running workflow will pick this
    // event's underlying changes up anyway. 204 so Pub/Sub is satisfied.
    console.log(`${eventType}: debounced (last dispatch ${Math.round((now - lastDispatch[eventType]) / 1000)}s ago).`);
    return res.status(204).end();
  }
  lastDispatch[eventType] = now;

  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "temu-dashboard-relay",
      },
      body: JSON.stringify({ event_type: eventType }),
    });
    if (r.status === 204) {
      console.log(`${eventType}: repository_dispatch sent.`);
    } else {
      // Bad PAT / repo rename / rate limit. Do NOT reset the debounce or
      // return 5xx — a Pub/Sub retry storm against a broken PAT helps
      // nothing, and the workflow cron still runs regardless.
      console.error(`${eventType}: GitHub dispatch failed (HTTP ${r.status}): ${(await r.text().catch(() => "")).slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`${eventType}: GitHub dispatch failed (${e.message}).`);
  }
  res.status(204).end();
});
