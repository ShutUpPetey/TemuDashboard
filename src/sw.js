/* ============================================================
   Service worker — deliberately THIN.

   Jobs (the complete list):
   1. App-shell precache so the installed PWA opens instantly/offline.
   2. Web push: show FCM data messages as notifications and focus/open
      the app when one is tapped.

   NOT a job: runtime caching. The app dynamic-imports the Firebase SDK
   from the gstatic CDN and talks to the Gmail + Anthropic APIs browser-
   direct; intercepting or caching ANY of that here would risk serving
   stale SDK code or stale API responses. Offline persistence for the
   actual DATA already exists in IndexedDB (lib/storage.js) — the shell
   is all the SW needs to cover.

   Built by vite-plugin-pwa (injectManifest strategy, see vite.config.js):
   self.__WB_MANIFEST is replaced at build time with the precache list.
   ============================================================ */

import { precacheAndRoute } from "workbox-precaching";
import { clientsClaim } from "workbox-core";

// Update-on-reload: a freshly deployed worker takes over immediately
// (registerType "autoUpdate" in vite.config.js re-registers it), so users
// never sit on a stale shell waiting for an "update available" prompt.
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);

/* ----- push (FCM) -----
   Contract with the sending side (scripts/* GitHub Actions, which send via
   firebase-admin messaging): messages are DATA-ONLY —
     { token, data: { title, body, tag, url } }
   — no `notification` key, so FCM never auto-displays anything and this
   handler is the single place notifications get shaped. `tag` collapses
   repeat notifications about the same thing (e.g. one per tracking number);
   `url` is where a tap should land. */
self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data?.json() || null;
  } catch {
    /* not JSON — ignore rather than show garbage */
  }
  const d = payload?.data || {};
  const title = d.title || "Temu Order Manifest";
  // registration.scope IS the deployed base URL (…/TemuDashboard/), so the
  // icon path never needs the base hardcoded — works on Pages and localhost.
  const icon = new URL("pwa-192x192.png", self.registration.scope).href;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || "",
      tag: d.tag || undefined,
      icon,
      badge: icon,
      data: { url: d.url || null },
    })
  );
});

/* Tap → focus an already-open app window if there is one, else open the
   target URL (defaults to the app root — registration.scope IS the deployed
   base URL, so no hardcoded hostname needed). */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Prefer any window already inside the app's scope — bring it forward
      // (and navigate it to the target if the push named a specific page).
      for (const client of clientList) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) {
          await client.focus();
          if (url !== self.registration.scope && "navigate" in client) {
            try { await client.navigate(url); } catch { /* cross-origin url — leave the app focused */ }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
