import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages serves project sites from /<repo-name>/ — keep this in sync
// with the actual repo name if you ever rename it. The PWA manifest's
// start_url/scope and the service worker's scope all derive from it too.
const BASE = "/TemuDashboard/";

export default defineConfig({
  plugins: [
    react(),
    /* PWA: makes the app installable to a phone home screen and gives it a
       service worker for push notifications. Deliberately configured THIN:
       - injectManifest strategy with our own src/sw.js, so the worker does
         ONLY app-shell precache + push handling. No runtime caching rules:
         the app dynamic-imports Firebase from the gstatic CDN and calls the
         Gmail/Anthropic APIs browser-direct — none of that may be
         intercepted or cached by a SW (stale SDK code or cached API replies
         would be far worse than a network round-trip). Offline DATA already
         lives in IndexedDB via lib/storage.js; the SW only makes the shell
         itself load offline.
       - registerType autoUpdate + skipWaiting/clientsClaim in sw.js means a
         new deploy takes effect on the next page load, no "update?" prompt. */
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      registerType: "autoUpdate",
      injectManifest: {
        // App shell only (js/css/html + the manifest icons). Receipt images,
        // Gmail, Firebase, Anthropic all stay strictly network-only.
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
      },
      manifest: {
        name: "Temu Order Manifest",
        short_name: "Temu Orders",
        description:
          "Personal Temu order dashboard — syncs order emails from Gmail, tracks items, prices, and spend analytics.",
        start_url: BASE,
        scope: BASE,
        display: "standalone",
        background_color: "#1c1917",
        theme_color: "#1c1917",
        // Relative srcs resolve against the manifest's own URL, which lives
        // under BASE — so these work on GitHub Pages without hardcoding it.
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  base: BASE,
});
