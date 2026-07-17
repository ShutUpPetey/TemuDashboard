/* ============================================================
   Shared FCM push helper for the GitHub Action workers
   (gmail-sync.mjs and carrier-eta.mjs).

   Device tokens live at manifest/{uid}/push/{key} as
   { token, ua, updatedAt } — written by the app (Workstream A's
   service-worker registration flow), only READ + pruned here.

   Messages are DATA-ONLY on purpose (no `notification` key): a
   notification-payload FCM message gets auto-displayed by the
   browser with no app control, and — worse — a page in the
   foreground never sees it. A data message always reaches the
   service worker, which decides how to render it (and can skip
   showing one for a change the open tab already displays).
   Payload contract: data = { title, body, tag, url }, all strings
   (FCM rejects non-string data values).
   ============================================================ */

/* Send every message to every registered device token for `uid`.
   Tokens that FCM reports as dead (uninstalled PWA, expired
   registration) are pruned from the push node so we stop paying
   the round-trip for them. Individual send failures never throw —
   a push is best-effort decoration on top of the sync. Returns
   { sent, failed, pruned } counts for the caller's summary log. */
export async function sendPushes(admin, db, uid, messages) {
  const out = { sent: 0, failed: 0, pruned: 0 };
  if (!messages.length) return out;
  let snap;
  try {
    snap = await db.ref(`manifest/${uid}/push`).get();
  } catch (e) {
    console.warn(`${uid}: could not read push tokens — ${e.message}`);
    return out;
  }
  if (!snap.exists()) return out; // no devices registered — skip silently
  const entries = Object.entries(snap.val() || {}).filter(([, v]) => v && v.token);
  if (!entries.length) return out;

  const dead = new Set();
  for (const msg of messages) {
    // FCM data values must all be strings — coerce defensively so a
    // numeric total or null tag can't reject the whole message.
    const data = {
      title: String(msg.title || ""),
      body: String(msg.body || ""),
      tag: String(msg.tag || "temu-manifest"),
      url: String(msg.url || "https://shutuppetey.github.io/TemuDashboard/"),
    };
    for (const [key, entry] of entries) {
      if (dead.has(key)) continue;
      try {
        await admin.messaging().send({ token: entry.token, data });
        out.sent++;
      } catch (e) {
        const code = e?.errorInfo?.code || e?.code || "";
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
          // Token is permanently dead — prune it so future runs skip it.
          dead.add(key);
          try {
            await db.ref(`manifest/${uid}/push/${key}`).remove();
            out.pruned++;
            console.log(`  push: pruned dead token (${key})`);
          } catch { /* pruning is best-effort */ }
        } else {
          out.failed++;
          console.warn(`  push: send failed (${key}): ${e.message}`);
        }
      }
    }
  }
  return out;
}
