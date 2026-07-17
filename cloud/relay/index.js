/* ============================================================
   Event relay — a tiny 2nd-gen Google Cloud Function (Node 20)
   that turns external "something happened" webhooks into GitHub
   `repository_dispatch` events, so the repo's Actions run within
   seconds instead of waiting for their cron tick.

   Two POST paths, same handler:
     /gmail?token=…   Pub/Sub push endpoint. Gmail users.watch
                      (registered by scripts/gmail-sync.mjs each
                      run) publishes to a topic on every inbox
                      change; a push subscription POSTs the
                      message here → dispatch "gmail-sync".
     /shippo?token=…  Shippo "Track Updated" webhook → dispatch
                      "carrier-eta".

   Deployed with gcloud per docs/near-realtime-setup.md. Zero npm
   dependencies beyond the functions-framework (Node 20 has fetch).

   Auth: a shared secret in the `token` query param, compared in
   constant time. Both producers only support static URLs cleanly
   (Shippo can ONLY do a static URL; Pub/Sub push URLs carry query
   params fine), so one mechanism covers both. Pub/Sub OIDC auth
   would be stronger for the /gmail path, but the token keeps this
   function dependency-free and both producers are low-risk — the
   worst a forged request can do is trigger a sync run that finds
   nothing new.

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

http("relay", async (req, res) => {
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
